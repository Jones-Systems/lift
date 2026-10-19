import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOura,createOuraReadPort } from '../../src/wearables/providers/oura.ts';
import { createGarminPort } from '../../src/wearables/providers/garmin.ts';
import { createProviderOAuth,authorizationUrl } from '../../src/wearables/providers/oauth.ts';
import { perform,ProviderFailure } from '../../src/wearables/providers/http.ts';
const allowed={assertAllowed(){},assertCurrent(){}};
const daily={id:'invented-oura',day:'2026-10-09',timestamp:'2026-10-09T04:00:00+02:00',steps:10,active_calories:20};
test('Oura selected public fields normalize with original lineage, unknown day window and opaque revisions',()=>{
 const result=decodeOura('daily_activity',{data:[daily],next_token:'opaque-next'});assert.equal(result.records.length,2);assert.equal(result.records[0].source.originalId,daily.id);assert.equal(result.records[0].start,null);assert.equal(result.records[0].revision.order,null);assert.equal(result.nextToken,'opaque-next');
 assert.throws(()=>decodeOura('daily_activity',{data:[{...daily,steps:'10'}],next_token:null}));
 assert.throws(()=>decodeOura('workout',{data:[{id:'w'}],next_token:null}));
});
test('Oura read is disabled by default; enabled injected HTTP gets bounded official URL and opaque pagination',async()=>{
 const calls=[];const http={request:async r=>{calls.push(r);return {status:200,headers:{},body:{data:[daily],next_token:null}};}};
 await assert.rejects(createOuraReadPort({http,accessSecretRef:'ref-only',now:()=>0}).read('daily_activity',{from:'2026-10-09',to:'2026-10-10',nextToken:null}),/not_configured/);assert.equal(calls.length,0);
 await createOuraReadPort({http,accessSecretRef:'ref-only',now:()=>0,admission:allowed}).read('daily_activity',{from:'2026-10-09',to:'2026-10-10',nextToken:'opaque&x'});
 assert.equal(new URL(calls[0].url).searchParams.get('next_token'),'opaque&x');assert.equal(calls[0].bearerSecretRef,'ref-only');assert.equal(calls[0].redirect,'error');
});
test('rate limit respects retry-after, transport errors distinguish read failure from uncertain mutation',async()=>{
 await assert.rejects(perform({request:async()=>({status:429,headers:{'retry-after':'12'},body:{}})},allowed,'oura','read',{method:'GET',url:'https://api.ouraring.com',headers:{}},0),e=>e instanceof ProviderFailure&&e.retryAfterMs===12000&&e.effect==='none');
 for(const method of ['GET','POST'])await assert.rejects(perform({request:async()=>{throw Error('socket');}},allowed,'oura','read',{method,url:'https://api.ouraring.com',headers:{}},0),e=>e.effect===(method==='GET'?'none':'unknown'));
});
test('Garmin ID and deregistration use public routes; unknown DELETE acknowledgement remains unknown',async()=>{
 const calls=[];const http={request:async r=>{calls.push(r);if(r.method==='DELETE')throw Error('lost');return {status:200,headers:{},body:{userId:'invented-id'}};}};
 const port=createGarminPort({http,accessSecretRef:'ref',admission:allowed,now:()=>0});assert.equal((await port.userId()).userId,'invented-id');
 await assert.rejects(port.deregister(),e=>e.effect==='unknown');assert.equal(calls[1].method,'DELETE');
 await assert.rejects(port.readHealth(null),/approved_payload_contract_required/);await assert.rejects(port.permissions(),/permissions_decoder_required/);assert.equal(calls.length,2);
});
test('PKCE uses S256, minimum scopes and state; Garmin fixed scopes cannot be modified',()=>{
 const input={clientId:'id',redirectUri:'https://form.invalid/callback',state:'s'.repeat(32),verifier:'v'.repeat(43),scopes:['daily']};
 const url=new URL(authorizationUrl('oura',input));assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),'daily');assert.notEqual(url.searchParams.get('code_challenge'),input.verifier);
 assert.throws(()=>authorizationUrl('garmin',input),/scopes_fixed/);assert.throws(()=>authorizationUrl('oura',{...input,scopes:[]}),/scope_invalid/);
});
test('rotation exclusively leases old reference, atomically replaces tokens, and never blindly retries unknown',async()=>{
 let busy=false,unknown=0,commits=0;const vault={begin(){if(busy)throw Error('refresh_locked');busy=true;return {id:'lease',secretRef:'old-refresh-ref',redirectUri:null};},commit(id,t){commits++;busy=false;assert.equal(t.expires_in,17);return {accessSecretRef:'new-ref',version:2};},unknown(){unknown++;},rejected(){busy=false;}};
 let mode='ok',calls=0;const http={request:async r=>{calls++;assert.equal(r.secretFormFields.refresh_token,'old-refresh-ref');if(mode==='lost')throw Error('lost');return {status:200,headers:{},body:{access_token:'invented-access',refresh_token:'invented-refresh',token_type:'bearer',expires_in:17}};}};
 const p=createProviderOAuth({provider:'oura',clientId:'id',clientSecretRef:'client-ref',http,vault,admission:allowed,now:()=>0,consumeCallback(){throw Error('not used');}});
 assert.equal((await p.refresh('op1')).version,2);assert.equal(commits,1);mode='lost';await assert.rejects(p.refresh('op2'));assert.equal(unknown,1);await assert.rejects(p.refresh('op2'),/refresh_locked/);assert.equal(calls,2);
});

test('provider page intent fences consent, binds original session and survives acknowledgement loss',async()=>{
 const {harness,ctxA}=await import('./support.mjs');
 const {importProviderPage}=await import('../../src/wearables/providers/importer.ts');
 const h=harness();h.store.putConnection(ctxA,{...h.store.connection(ctxA,'hk'),id:'oura',provider:'oura',types:['steps','active_energy']});
 let pending=null,reads=0,failAck=true;
 const input={ctx:ctxA,provider:'oura',connectionId:'oura',generation:1,stream:'daily_activity:2026-10-09',cursor:null,service:h.service,
  source:{read:async()=>{reads++;return decodeOura('daily_activity',{data:[daily],next_token:'n'});}},newKey:()=> 'provider-intent',assertCurrent(){},
  intent:{load:()=>pending,save:p=>pending=structuredClone(p),acknowledged(){if(failAck)throw Error('ack lost');pending=null;}}};
 h.setPermitted(false);await assert.rejects(importProviderPage(input));assert.equal(reads,0);
 h.setPermitted(true);await assert.rejects(importProviderPage(input),/ack lost/);assert.equal(reads,1);
 await assert.rejects(importProviderPage({...input,stream:'other'}),/intent_changed/);
 failAck=false;const r=await importProviderPage(input);assert.equal(reads,1);assert.equal(r.accepted,2);assert.equal(pending,null);
});
