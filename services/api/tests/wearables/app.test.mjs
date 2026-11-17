import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthImport } from '../../../../apps/form/src/wearables/importer.ts';
import { normalizeNative, asleepSeconds } from '../../../../apps/form/src/wearables/normalize.ts';
import { createHealthApi } from '../../../../apps/form/src/wearables/api.ts';
import { journalFake } from './upload-intents/journal.mjs';
import { harness,ctxA,ctxB } from './support.mjs';
const nativeRecord=()=>({id:'native-day',kind:'daily',type:'steps',day:'2026-10-09',zone:'UTC',start:'2026-10-09T00:00:00Z',end:'2026-10-10T00:00:00Z',sourceBundleId:'invented',sourceName:'Invented',deviceModel:null,algorithm:null,originalId:null,revision:{token:'v1',order:1},quality:'complete',values:[{metric:'steps',value:123,unit:'count',aggregation:'sum'}]});
function setup(query){let current=true,consent=true,calls=[],unresolved=[],keys=0,cancelled=0;
 const options={configured:true,journal:journalFake().journal,reconcileCheckpoint:async(_binding,ack)=>({cursor:ack.cursor}),session:{accountId:'a',sessionGeneration:'s1',isCurrentSession:()=>current},consentCurrent:()=>consent,newKey:()=>`key-${++keys}`,onUnresolved:v=>unresolved.push(v),isUnknown:e=>e?.message==='lost',
 native:{availability:async()=> 'available',requestRead:async()=> 'prompted',query,cancelAll:async()=>{cancelled++;}},api:{importPage:async(page,key)=>{calls.push({page,key});return {accepted:page.batch.length,duplicates:0,cursor:page.nextCursor,pageId:page.pageId};},disconnect:async()=>({disconnected:true})}};
 return {options,calls,unresolved,setCurrent:v=>current=v,setConsent:v=>consent=v,cancelled:()=>cancelled};}
const input={connectionId:'hk',generation:1,type:'steps',from:'2026-10-09T00:00:00Z',to:'2026-10-10T00:00:00Z',cursor:null};
test('native pagination commits returned cursors in order without raw sample upload',async()=>{
 let n=0;const h=setup(async()=>({records:[nativeRecord()],tombstones:[],anchor:++n===1?'a1':'a2',more:n===1,logicalBucketsComplete:true}));
 const result=await createHealthImport(h.options).refresh(input);assert.equal(result.pages,2);assert.equal(h.calls[1].page.fromCursor,'a1');assert.equal(h.calls[0].page.batch[0].value,123);
});
test('late page after session or consent loss never uploads',async()=>{
 for(const revoke of ['session','consent']){let resolve;const h=setup(()=>new Promise(r=>resolve=r));const importer=createHealthImport(h.options),promise=importer.refresh(input);
 await new Promise(r=>setImmediate(r));if(revoke==='session')h.setCurrent(false);else h.setConsent(false);
 resolve({records:[nativeRecord()],tombstones:[],anchor:'a1',more:false,logicalBucketsComplete:true});assert.equal((await promise).status,'cancelled');assert.equal(h.calls.length,0);}
});
test('unknown ACK retries exact page and key; dispose preserves original account reconciliation metadata',async()=>{
 const h=setup(async()=>({records:[nativeRecord()],tombstones:[],anchor:'a1',more:false,logicalBucketsComplete:true}));let first=true;
 h.options.api.importPage=async(page,key)=>{h.calls.push({page,key});if(first){first=false;throw Error('lost');}return {accepted:1,duplicates:0,cursor:page.nextCursor,pageId:page.pageId};};
 const importer=createHealthImport(h.options);assert.equal((await importer.refresh(input)).status,'unknown');await importer.retryUnknown();assert.deepEqual(h.calls[0],h.calls[1]);
 first=true;await importer.refresh(input);await importer.dispose();assert.equal(h.unresolved[0].accountId,'a');assert.equal(h.unresolved[0].sessionGeneration,'s1');assert.equal('page' in h.unresolved[0],false);
});
test('empty reads never imply denial and pagination cycle fails before repeated upload',async()=>{
 const h=setup(async()=>({records:[],tombstones:[],anchor:'a1',more:false,logicalBucketsComplete:true}));assert.equal((await createHealthImport(h.options).refresh(input)).status,'unknown_no_accessible_data');
 const cyclic=setup(async()=>({records:[],tombstones:[],anchor:null,more:true,logicalBucketsComplete:true}));await assert.rejects(createHealthImport(cyclic.options).refresh(input),/cursor_cycle/);assert.equal(cyclic.calls.length,0);
});
test('sleep interval union avoids adding in-bed/overlap and preserves elapsed DST duration',()=>{
 const base={start:'2026-11-01T01:00:00-04:00',end:'2026-11-01T02:00:00-05:00'};
 assert.equal(asleepSeconds([{...base,stage:'in_bed'},{...base,stage:'asleep'},{start:'2026-11-01T01:30:00-04:00',end:base.end,stage:'deep'}]),7200);
});
test('SDNN seconds normalize to ms, RMSSD cannot masquerade as SDNN; body/no-save extra fields reject',()=>{
 const r=nativeRecord();r.type='hrvSdnn';r.values=[{metric:'hrv_sdnn',value:.04,unit:'s',aggregation:'mean'}];assert.equal(normalizeNative(r)[0].value,40);
 r.values[0].metric='hrv_rmssd';assert.throws(()=>normalizeNative(r));assert.throws(()=>normalizeNative({...nativeRecord(),retention:'no_save'}));
});

test('unknown ACK followed by gate loss drops payload and preserves only original reconciliation metadata',async()=>{
 for(const gate of ['consent','session']){
  const h=setup(async()=>({records:[nativeRecord()],tombstones:[],anchor:'a1',more:false,logicalBucketsComplete:true}));
  h.options.api.importPage=async(page,key)=>{h.calls.push({page,key});throw Error('lost');};
  const importer=createHealthImport(h.options);assert.equal((await importer.refresh(input)).status,'unknown');
  if(gate==='consent')h.setConsent(false);else h.setCurrent(false);
  assert.deepEqual(await importer.retryUnknown(),{status:'cancelled',pages:0});
  assert.deepEqual(h.unresolved,[{key:'key-1',accountId:'a',sessionGeneration:'s1',connectionId:'hk'}]);
  assert.equal(h.calls.length,1);
  if(gate==='consent')h.setConsent(true);else h.setCurrent(true);
  await assert.rejects(importer.retryUnknown(),/health_import_reconciliation_required/);
  assert.equal(h.calls.length,1);
 }
});


const stepsRecord=(changes={})=>({...nativeRecord(),id:'hk1-day',...changes});
test('normalizeNative fails closed on malformed or non-allowlisted native records and keeps partial quality visible',()=>{
 const mutate=change=>{const r=nativeRecord();change(r);return r;};
 for(const bad of [null,undefined,{},mutate(r=>{r.values=Array.from({length:4},()=>({metric:'steps',value:1,unit:'count',aggregation:'sum'}));}),
  mutate(r=>{r.values[0].unit='kg';}),mutate(r=>{r.values[0].metric='active_energy';r.values[0].unit='kcal';}),mutate(r=>{r.values[0].value=-1;}),
  mutate(r=>{r.values[0].value=Number.NaN;}),mutate(r=>{r.values[0].value=Number.POSITIVE_INFINITY;}),mutate(r=>{r.values.push({...r.values[0]});}),
  mutate(r=>{r.values[0].aggregation='vendor_algorithm';}),mutate(r=>{r.values[0].extra=true;}),mutate(r=>{r.kind='workout';}),mutate(r=>{r.type='workouts';}),
  mutate(r=>{r.type='unknownType';}),mutate(r=>{r.start='2026-10-10T00:00:00Z';r.end='2026-10-09T00:00:00Z';}),mutate(r=>{r.start='yesterday';})])
  assert.throws(()=>normalizeNative(bad),/health_native_contract|TypeError/);
 const r=nativeRecord();r.quality='partial';assert.equal(normalizeNative(r)[0].quality,'partial');
 const energy=nativeRecord();energy.type='activeEnergy';energy.values=[{metric:'active_energy',value:418.4,unit:'kJ',aggregation:'sum'}];assert.equal(Math.round(normalizeNative(energy)[0].value*1e6),100e6);
 const mass=nativeRecord();mass.type='bodyMass';mass.values=[{metric:'body_mass',value:100,unit:'lb',aggregation:'latest'}];assert.equal(Math.round(normalizeNative(mass)[0].value*1000),45359);
 const workout=nativeRecord();Object.assign(workout,{type:'workouts',kind:'workout',originalId:'original-workout'});workout.values=[{metric:'workout_duration',value:60,unit:'s',aggregation:'sum'}];
 assert.equal(normalizeNative(workout)[0].aggregation,'workout');assert.equal(normalizeNative(workout)[0].source.originalId,'original-workout');
});
test('the session-bound API refuses stale sessions before sending and withholds results after a late session change',async()=>{
 let current=true,sent=[];const request={request:async(path,method,body,key)=>{sent.push({path,method,body,key});return {accepted:1};}};
 const api=createHealthApi(request,{accountId:'a',sessionGeneration:'s1',isCurrentSession:()=>current});
 assert.deepEqual(await api.importPage({version:1},'k1'),{accepted:1});assert.deepEqual(sent[0],{path:'/v1/health/imports',method:'POST',body:{version:1},key:'k1'});
 await api.disconnect({connectionId:'hk',generation:1},'k2');assert.equal(sent[1].path,'/v1/health/connections/healthkit/disconnect');
 current=false;await assert.rejects(api.importPage({version:1},'k3'),/^Error: health_session_changed$/);assert.equal(sent.length,2);
 current=true;const late=createHealthApi({request:async()=>{current=false;return {accepted:1};}},{accountId:'a',sessionGeneration:'s1',isCurrentSession:()=>current});
 await assert.rejects(late.disconnect({connectionId:'hk',generation:1},'k4'),/health_session_changed_unknown/);
});
test('importer pages reach the real service as idempotent duplicates, ignored older revisions and permanent tombstones',async()=>{
 const h=harness(),page=(ctx,key,value)=>h.service.ingest(ctx,key,value);
 let record=stepsRecord(),tombstones=[],anchor=0,keys=0;
 const options={configured:true,journal:journalFake().journal,reconcileCheckpoint:async(_binding,ack)=>({cursor:ack.cursor}),
  session:{accountId:ctxA.accountId,sessionGeneration:'s1',isCurrentSession:()=>true},consentCurrent:()=>true,newKey:()=>`import-key-${++keys}`,onUnresolved(){},isUnknown:()=>false,
  native:{availability:async()=> 'available',requestRead:async()=> 'prompted',cancelAll:async()=>{},
   query:async()=>({records:record?[structuredClone(record)]:[],tombstones:structuredClone(tombstones),anchor:`cursor-${++anchor}`,more:false,logicalBucketsComplete:true})},
  api:{importPage:async(value,key)=>page(ctxA,key,value),disconnect:async(value,key)=>h.service.disconnect(ctxA,key,value)}};
 const stream=JSON.stringify(['healthkit-v1',input.type,input.from,input.to]);
 const run=async()=>{const result=await createHealthImport(options).refresh({...input,connectionId:'hk',cursor:h.store.cursor(ctxA,'hk',1,stream)});assert.equal(result.pages,1);return result;};
 const stored=()=>h.store.measure(ctxA,'hk',1,'hk1-day:steps'),visible=()=>h.service.summary(ctxA,'2026-10-09','2026-10-10').items;
 await run();assert.equal(stored().value,123);assert.equal(h.store.cursor(ctxA,'hk',1,stream),'cursor-1');
 await run();assert.equal(h.store.cursor(ctxA,'hk',1,stream),'cursor-2');assert.equal(stored().value,123);
 record=stepsRecord({revision:{token:'older',order:0},values:[{metric:'steps',value:999,unit:'count',aggregation:'sum'}]});await run();assert.equal(stored().value,123);
 record=stepsRecord({revision:{token:'newer',order:2},values:[{metric:'steps',value:130,unit:'count',aggregation:'sum'}]});await run();assert.equal(stored().value,130);
 record=null;tombstones=[{id:'hk1-day:steps',revision:{token:'gone',order:3}}];await run();assert.equal(stored().deleted,true);assert.deepEqual(visible(),[]);
 tombstones=[];record=stepsRecord({revision:{token:'revived',order:4},values:[{metric:'steps',value:150,unit:'count',aggregation:'sum'}]});await run();
 assert.equal(stored().deleted,true);assert.deepEqual(visible(),[]);
 assert.equal(h.store.measures(ctxB,'2026-10-09','2026-10-10',100).length,0);
});
test('a tombstone-only page reports complete because deletions were read and uploaded',async()=>{
 const tombstones=[{id:'native-day:steps',revision:{token:'gone',order:2}}];
 const h=setup(async()=>({records:[],tombstones:structuredClone(tombstones),anchor:'a1',more:false,logicalBucketsComplete:true}));
 assert.deepEqual(await createHealthImport(h.options).refresh(input),{status:'complete',pages:1});
 assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].page.batch,[]);assert.deepEqual(h.calls[0].page.tombstones,tombstones);
});
