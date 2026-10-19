import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthImport } from '../../../../apps/form/src/wearables/importer.ts';
import { normalizeNative, asleepSeconds } from '../../../../apps/form/src/wearables/normalize.ts';
import { journalFake } from './upload-intents/journal.mjs';
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
