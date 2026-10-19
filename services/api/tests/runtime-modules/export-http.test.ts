import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildAccountExport, ACCOUNT_EXPORT_MAX_BYTES } from '../../src/lifecycle/export.js';
import { assertActive } from '../../src/lifecycle/guards.js';
import { DomainError } from '../../src/errors.js';
import { COMMUNITY_EXPORT_MAX_BYTES } from '../../src/community/index.js';
import { deployment, provision, start, users, request, password, type User } from './fixture.js';
import { usefulActivity } from './http-fixture.js';
import { populateCommunity } from './community-fixture.js';
async function exportRequest(server:Awaited<ReturnType<typeof start>>['server'],a:User) {
 const response=await request(server,'/v1/me/account-action-grants',a,'POST',{purpose:'account_export',password});assert.equal(response.status,201);
 const granted=await response.json() as {grant:string};return request(server,'/v1/me/account-export',a,'POST',{grant:granted.grant});
}
test('real Activity+B2+B4+B5 HTTP safe export is owner-bound, capped and incomplete; no purge is invoked',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d,{publicSynthetic:true,textSynthetic:true}),[a,b]=await users(server);
 await usefulActivity(server,a);const community=await populateCommunity(server,a,b);
 assert.equal((await request(server,'/v1/me/profile',b,'PATCH',{expectedRevision:(await (await request(server,'/v1/me/profile',b)).json() as {revision:number}).revision,name:'OTHER-PRIVATE-MARKER'})).status,200);
 const response=await exportRequest(server,a);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-disposition')!,/attachment/);
 const text=await response.text();assert.ok(Buffer.byteLength(text)<=ACCOUNT_EXPORT_MAX_BYTES);
 for(const forbidden of ['OTHER-PRIVATE-MARKER','Other private report','Other private appeal',b.token,password,'exact_jws','status_token_hash','bodyAssessment'])assert.equal(text.includes(forbidden),false,forbidden);
 assert.ok(text.includes('Owner private exercise'));assert.ok(text.includes('OWNER-PRIVATE-POST'));assert.ok(text.includes('featureBoard'));assert.ok(text.includes('community-b4'));
 const value=JSON.parse(text) as {manifest:{complete:boolean;categories:{category:string;status:string}[]}};assert.equal(value.manifest.complete,false);
 assert.ok(value.manifest.categories.some(c=>c.category==='activity'));assert.ok(value.manifest.categories.some(c=>c.category==='community'));
 assert.equal((server.db.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(community.board.id) as {visibility:string}).visibility,'pending');
});
test('HTTP total16MiB overflow returns packaging-required and never truncated complete JSON',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d,{publicSynthetic:true}),[a]=await users(server);
 server.db.prepare('UPDATE "user" SET name=? WHERE id=?').run('synthetic'.repeat(Math.ceil(ACCOUNT_EXPORT_MAX_BYTES/9)+1),a.actor.authUserId);
 const response=await exportRequest(server,a);assert.equal(response.status,413);assert.equal((await response.json() as {error:{code:string}}).error.code,'account_export_packaging_required');
});
test('real composed Community2MiB preflight is bounded before materialization; HTTP refuses bytes rather than claiming completion',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d,{publicSynthetic:true,textSynthetic:true}),[a,b]=await users(server);const populated=await populateCommunity(server,a,b);
 const now=new Date().toISOString(),expires=new Date(Date.now()+86400000).toISOString();
 server.db.transaction(()=>{for(let i=0;i<1200;i++)server.db.prepare("INSERT INTO community_posts VALUES(?,?,1,?,1,1,'win',NULL,?,'pending','community-v1',?,?)").run(randomUUID(),populated.group.id,a.actor.accountId,'x'.repeat(2000),now,expires);}).immediate();
 const adapter=server.lifecycle!.adapters.find(a=>a.category==='community')!;let appends=0;
 assert.throws(()=>server.db.transaction(()=>adapter.export(a.actor,{snapshotAtMs:Date.now(),append:()=>{appends++;}})).immediate(),error=>error instanceof DomainError && error.status===413);assert.equal(appends,0);assert.equal(COMMUNITY_EXPORT_MAX_BYTES,2097152);
 const response=await exportRequest(server,a);assert.equal(response.status,413);const denied=await response.text();assert.equal(denied.includes('records'),false);assert.equal(denied.includes('\"complete\":true'),false);
});
for(const mutation of ['session','suppression'])test(`post-COMMIT ${mutation} prevents actual HTTP export byte release`,async t=>{
 const d=await deployment(t);await provision(d);const {server,owner}=await start(d,{publicSynthetic:true}),[a]=await users(server);
 const original=server.db.transaction.bind(server.db);
 let armed=false, injections=0;
 // Wrap the real transaction's deferred return, after its COMMIT, never the export adapter/sink.
 const transaction=(fn:Parameters<typeof server.db.transaction>[0])=>{
  const wrapped=original(fn);const deferred=wrapped.deferred.bind(wrapped);
  // The library's transaction properties are immutable; own a separate callable facade.
  const facade=Object.assign((...args:unknown[])=>wrapped(...args),{
   deferred:(...args:unknown[])=>{const result=deferred(...args);if(armed && typeof result==='object' && result!==null && 'json' in result && 'bytes' in result){assert.equal(server.db.inTransaction,false);armed=false;injections++;if(mutation==='session')server.db.prepare('DELETE FROM session WHERE id=?').run(a.actor.sessionId);else owner.ledger.recordDisable({accountId:a.actor.accountId,authUserId:a.actor.authUserId,epoch:1,requestId:'synthetic-after-snapshot',disabledAtMs:Date.now()});}return result;},
   immediate:wrapped.immediate.bind(wrapped),exclusive:wrapped.exclusive.bind(wrapped),default:wrapped.default.bind(wrapped),database:server.db,
  });
  return facade as typeof wrapped;
 };
 const grantResponse=await request(server,'/v1/me/account-action-grants',a,'POST',{purpose:'account_export',password});const grant=await grantResponse.json() as {grant:string};assert.equal(grantResponse.status,201);
 server.db.transaction=transaction as typeof server.db.transaction;
 try {armed=true;const response=await request(server,'/v1/me/account-export',a,'POST',{grant:grant.grant});assert.ok([401,403].includes(response.status),`unexpected export status ${response.status}`);const text=await response.text();assert.equal(text.includes('records'),false);assert.equal(armed,false);assert.equal(injections,1);}
 finally{server.db.transaction=original;}
});
test('unknown adapter exception/missing submodule proof cannot promote export or purge completion',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d,{publicSynthetic:true}),[a]=await users(server);
 const base=server.lifecycle!.adapters.find(a=>a.category==='community')!,throwing={...base,export:()=>{throw new Error('synthetic missing submodule proof');}};
 assert.throws(()=>buildAccountExport(server.db,a.actor,actor=>assertActive(server.db,actor),[server.lifecycle!.adapters.find(a=>a.category==='activity')!,throwing]),/synthetic missing submodule proof/);
 const unknown={...base,export:()=>({category:'community',status:'unknown' as const,reason:'synthetic submodule uncertainty'})};
 const exported=buildAccountExport(server.db,a.actor,actor=>assertActive(server.db,actor),[server.lifecycle!.adapters.find(a=>a.category==='activity')!,unknown]);
 const value=JSON.parse(exported.json) as {manifest:{complete:boolean;categories:{category:string;status:string}[]}};assert.equal(value.manifest.complete,false);assert.equal(value.manifest.categories.find(c=>c.category==='community')?.status,'unknown');
 const settings=await (await request(server,'/v1/me/settings',a)).json() as {capabilities:{accountDeletion:{supported:boolean}}};assert.equal(settings.capabilities.accountDeletion.supported,false);
});
