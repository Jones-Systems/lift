import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthImport } from '../../../../../apps/form/src/wearables/importer.ts';
import { journalFake } from './journal.mjs';

const input=()=>({connectionId:'hk',generation:1,type:'steps',from:'2026-10-09T00:00:00Z',to:'2026-10-10T00:00:00Z',cursor:null});
const nativeRecord=()=>({id:'bucket',kind:'daily',type:'steps',day:'2026-10-09',zone:'UTC',start:'2026-10-09T00:00:00Z',end:'2026-10-10T00:00:00Z',
  sourceBundleId:'synthetic',sourceName:'Synthetic',deviceModel:null,algorithm:null,originalId:null,revision:{token:'v1',order:1},quality:'complete',
  values:[{metric:'steps',value:123,unit:'count',aggregation:'sum'}]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
  const storage=journalFake(),events=[],uploads=[],reconciliations=[],unresolved=[];
  let current=true,consent=true,keyCount=0,queryCount=0,serverCursor=null;
  const options={configured:true,journal:storage.journal,session:{accountId:'account-a',sessionGeneration:'session-a',isCurrentSession:()=>current},
    consentCurrent:()=>consent,newKey:()=>{keyCount++;return `key-${keyCount}`;},isUnknown:()=>true,onUnresolved:value=>unresolved.push(value),
    native:{availability:async()=>{events.push('availability');return 'available';},requestRead:async()=>{events.push('permission');return 'prompted';},
      query:async()=>{queryCount++;events.push('query');return {records:[nativeRecord()],tombstones:[],anchor:'anchor-1',more:false,logicalBucketsComplete:true};},
      cancelAll:async()=>{events.push('cancel');}},
    api:{importPage:async(page,key)=>{
      events.push('http');uploads.push(structuredClone({page,key}));serverCursor=page.nextCursor;
      return {accepted:page.batch.length,duplicates:0,cursor:page.nextCursor,pageId:page.pageId};
    },disconnect:async()=>{events.push('disconnect');return {disconnected:true};}},
    reconcileCheckpoint:async(binding,ack)=>{
      events.push('reconcile');reconciliations.push(structuredClone({binding,ack}));
      if(serverCursor!==ack.cursor)throw Error('server_checkpoint_mismatch');
      return {cursor:serverCursor};
    },
  };
  return {storage,options,events,uploads,reconciliations,unresolved,create:()=>createHealthImport(options),
    queries:()=>queryCount,keys:()=>keyCount,setCurrent:v=>current=v,setConsent:v=>consent=v};
}

test('both durable journal and authoritative reconciliation are required before native access',async()=>{
  for(const missing of ['journal','reconcileCheckpoint']){
    const h=fixture();delete h.options[missing];
    assert.deepEqual(await h.create().refresh(input()),{status:'unavailable',pages:0});
    assert.deepEqual(h.events,[]);assert.equal(h.keys(),0);
  }
});
test('prepare precedes HTTP, acknowledged payload is removed, and reconciliation precedes next query',async()=>{
  const h=fixture();let n=0;
  h.options.native.query=async()=>{
    if(n)assert.equal(h.storage.snapshot().record,null);
    h.events.push('query');n++;return {records:[nativeRecord()],tombstones:[],anchor:`anchor-${n}`,more:n===1,logicalBucketsComplete:true};
  };
  const send=h.options.api.importPage;
  h.options.api.importPage=async(page,key)=>{
    const stored=h.storage.snapshot().record;assert.equal(stored.phase,'prepared');assert.deepEqual(stored.page,page);assert.equal(stored.key,key);
    return send(page,key);
  };
  const reconcile=h.options.reconcileCheckpoint;
  h.options.reconcileCheckpoint=async(binding,ack)=>{
    const stored=h.storage.snapshot().record;assert.equal(stored.phase,'acknowledged');assert.equal('page' in stored,false);
    assert.equal(JSON.stringify(stored).includes('123'),false);return reconcile(binding,ack);
  };
  assert.deepEqual(await h.create().refresh(input()),{status:'complete',pages:2});
  assert.deepEqual(h.events,['availability','permission','query','http','reconcile','query','http','reconcile']);
  assert.equal(h.storage.snapshot().record,null);
});
test('unknown HTTP restores the exact immutable page/key without another native query',async()=>{
  const h=fixture(),send=h.options.api.importPage;let lost=true;
  h.options.api.importPage=async(page,key)=>{const ack=await send(page,key);page.batch[0].value=999;if(lost)throw Error('lost');return ack;};
  assert.equal((await h.create().refresh(input())).status,'unknown');
  const original=structuredClone(h.storage.snapshot().record);
  const restored=h.create();assert.equal((await restored.refresh(input())).status,'unknown');assert.equal(h.queries(),1);
  lost=false;assert.equal((await restored.retryUnknown(input())).status,'complete');
  assert.deepEqual(h.uploads[0],h.uploads[1]);assert.deepEqual(h.uploads[1],{page:original.page,key:original.key});
  assert.equal(h.keys(),1);assert.equal(h.queries(),1);
});
test('restore rejects changed original session, account, connection generation, type or window',async()=>{
  for(const change of ['account','session','connection','generation','type','window']){
    const h=fixture(),send=h.options.api.importPage;
    h.options.api.importPage=async(page,key)=>{await send(page,key);throw Error('lost');};
    await h.create().refresh(input());const before=h.storage.snapshot();const next=input();
    if(change==='account')h.options.session.accountId='other';
    if(change==='session')h.options.session.sessionGeneration='other';
    if(change==='connection')next.connectionId='other';
    if(change==='generation')next.generation=2;
    if(change==='type')next.type='sleep';
    if(change==='window')next.to='2026-10-11T00:00:00Z';
    await assert.rejects(h.create().retryUnknown(next),/binding_changed/);
    assert.deepEqual(h.storage.snapshot(),before);assert.equal(h.uploads.length,1);assert.equal(h.queries(),1);
  }
});
test('unknown prepare reconciles authoritative committed or unchanged CAS state before HTTP',async()=>{
  for(const applied of [false,true]){
    const h=fixture(),cas=h.options.journal.compareAndSwap;let first=true;
    h.options.journal.compareAndSwap=async(...args)=>{
      if(first){first=false;if(applied)await cas(...args);return {status:'unknown'};}return cas(...args);
    };
    const importer=h.create();assert.equal((await importer.refresh(input())).status,'unknown');assert.equal(h.uploads.length,0);
    await assert.rejects(importer.refresh(input()),/reconciliation_required/);
    assert.equal((await importer.retryUnknown()).status,'complete');assert.equal(h.uploads.length,1);
    assert.equal(h.uploads[0].key,'key-1');assert.equal(h.queries(),1);assert.equal(h.keys(),1);
  }
});
test('unknown acknowledged CAS retains authoritative ACK and does not resend HTTP on same-instance retry',async()=>{
  for(const applied of [false,true]){
    const h=fixture(),cas=h.options.journal.compareAndSwap;let first=true;
    h.options.journal.compareAndSwap=async(...args)=>{
      if(first&&args[1]?.phase==='acknowledged'){first=false;if(applied)await cas(...args);return {status:'unknown'};}return cas(...args);
    };
    const importer=h.create();assert.equal((await importer.refresh(input())).status,'unknown');assert.equal(h.uploads.length,1);
    assert.equal((await importer.retryUnknown()).status,'complete');assert.equal(h.uploads.length,1);assert.equal(h.queries(),1);
  }
});
test('acknowledged restart retries only idempotent native reconciliation',async()=>{
  const h=fixture(),reconcile=h.options.reconcileCheckpoint;let unavailable=true;
  h.options.reconcileCheckpoint=async(...args)=>{if(unavailable)throw Error('native_unavailable');return reconcile(...args);};
  assert.equal((await h.create().refresh(input())).status,'unknown');
  const stored=h.storage.snapshot().record;assert.equal(stored.phase,'acknowledged');assert.equal('page' in stored,false);
  unavailable=false;assert.equal((await h.create().retryUnknown(input())).status,'complete');
  assert.equal(h.uploads.length,1);assert.equal(h.queries(),1);assert.equal(h.storage.snapshot().record,null);
});
test('unknown clear reconciles before allowing further work without HTTP or native query',async()=>{
  for(const applied of [false,true]){
    const h=fixture(),cas=h.options.journal.compareAndSwap;let first=true;
    h.options.journal.compareAndSwap=async(...args)=>{
      if(first&&args[1]===null){first=false;if(applied)await cas(...args);return {status:'unknown'};}return cas(...args);
    };
    const importer=h.create();assert.equal((await importer.refresh(input())).status,'unknown');
    assert.equal((await importer.retryUnknown()).status,'complete');
    assert.equal(h.uploads.length,1);assert.equal(h.queries(),1);assert.equal(h.reconciliations.length,1);
  }
});
test('mismatched ACK and mismatched authoritative checkpoint retain the correct unresolved phase',async()=>{
  const h=fixture(),send=h.options.api.importPage;let mismatch=true;
  h.options.api.importPage=async(...args)=>{const ack=await send(...args);return mismatch?{...ack,cursor:'wrong'}:ack;};
  const importer=h.create();assert.equal((await importer.refresh(input())).status,'unknown');assert.equal(h.storage.snapshot().record.phase,'prepared');
  mismatch=false;h.options.reconcileCheckpoint=async()=>({cursor:'wrong'});
  assert.equal((await importer.retryUnknown()).status,'unknown');assert.equal(h.storage.snapshot().record.phase,'acknowledged');
  assert.equal(h.queries(),1);assert.equal(h.uploads.length,2);assert.deepEqual(h.uploads[0],h.uploads[1]);
});
test('CAS conflict holds the importer and never falls back to an alternate key or dispatch',async()=>{
  const h=fixture();h.options.journal.compareAndSwap=async()=>({status:'conflict',snapshot:h.storage.snapshot()});
  const importer=h.create();await assert.rejects(importer.refresh(input()),/journal_conflict/);
  await assert.rejects(importer.retryUnknown(),/reconciliation_required/);await assert.rejects(importer.refresh(input()),/reconciliation_required/);
  assert.equal(h.uploads.length,0);assert.equal(h.keys(),1);
});
test('gate loss scrubs durable payload and tombstone blocks a new importer after regrant',async()=>{
  for(const gate of ['consent','session']){
    const h=fixture(),send=h.options.api.importPage;
    h.options.api.importPage=async(...args)=>{await send(...args);throw Error('lost');};
    const importer=h.create();await importer.refresh(input());
    if(gate==='consent')h.setConsent(false);else h.setCurrent(false);
    assert.equal((await importer.retryUnknown()).status,'cancelled');
    const stored=h.storage.snapshot();assert.equal(stored.fenced,true);assert.equal(stored.record.phase,'scrubbed');
    assert.equal('page' in stored.record,false);assert.equal('ack' in stored.record,false);assert.equal(JSON.stringify(stored).includes('anchor-1'),false);
    assert.deepEqual(h.unresolved,[{key:'key-1',accountId:'account-a',sessionGeneration:'session-a',connectionId:'hk'}]);
    h.setConsent(true);h.setCurrent(true);
    await assert.rejects(h.create().refresh(input()),/reconciliation_required/);assert.equal(h.queries(),1);assert.equal(h.uploads.length,1);
  }
});
test('dispose fences synchronously and rejects a late prepared CAS before HTTP',async()=>{
  const h=fixture(),cas=h.options.journal.compareAndSwap,entered=deferred(),release=deferred();
  h.options.journal.compareAndSwap=async(...args)=>{entered.resolve();await release.promise;return cas(...args);};
  const importer=h.create(),refresh=importer.refresh(input());await entered.promise;
  const disposal=importer.dispose();assert.equal(h.storage.snapshot().fenced,true);release.resolve();
  assert.equal((await disposal).status,'cancelled');assert.equal((await refresh).status,'cancelled');
  assert.equal(h.storage.snapshot().record.phase,'scrubbed');assert.equal(h.uploads.length,0);
});
test('unknown scrub remains unknown and blocks disconnect dispatch and regrant',async()=>{
  const h=fixture(),send=h.options.api.importPage,scrub=h.options.journal.fenceAndScrub;
  h.options.api.importPage=async(...args)=>{await send(...args);throw Error('lost');};
  const importer=h.create();await importer.refresh(input());
  h.options.journal.fenceAndScrub=metadata=>{void scrub(metadata);return Promise.resolve({status:'unknown'});};
  await assert.rejects(importer.disconnect({connectionId:'hk',generation:1},'disconnect-key'),/journal_scrub_unknown/);
  assert.equal(h.events.includes('disconnect'),false);assert.equal((await importer.dispose()).status,'unknown');
  await assert.rejects(h.create().refresh(input()),/reconciliation_required/);
});
test('refresh captures immutable window and connection before its first await',async()=>{
  const h=fixture(),load=h.options.journal.load,entered=deferred(),release=deferred(),requested=input();
  h.options.journal.load=async()=>{entered.resolve();await release.promise;return load();};
  const refresh=h.create().refresh(requested);await entered.promise;requested.connectionId='changed';requested.generation=99;requested.to='changed';release.resolve();
  assert.equal((await refresh).status,'complete');assert.equal(h.uploads[0].page.connectionId,'hk');assert.equal(h.uploads[0].page.generation,1);
  assert.equal(h.uploads[0].page.stream,JSON.stringify(['healthkit-v1','steps',input().from,input().to]));
});

const cas=h=>h.storage.history.filter(item=>item.operation==='cas').length;
test('restricted, unavailable or malformed availability stops before permission, query, key or journal write',async()=>{
  for(const status of ['restricted','unavailable_device','granted']){
    const h=fixture();h.options.native.availability=async()=>{h.events.push('availability');return status;};
    assert.deepEqual(await h.create().refresh(input()),{status:'unavailable',pages:0});
    assert.deepEqual(h.events,['availability']);assert.equal(h.keys(),0);assert.equal(h.queries(),0);
    assert.equal(cas(h),0);assert.equal(h.uploads.length,0);assert.equal(h.storage.snapshot().record,null);
  }
});
test('a failed permission request asks only for the selected type, leaves no state and allows a later refresh',async()=>{
  const h=fixture(),requested=[];let deny=true;
  h.options.native.requestRead=async types=>{requested.push(types);if(deny)throw Error('synthetic_authorization_failure');return 'prompted';};
  const importer=h.create();
  await assert.rejects(importer.refresh(input()),/synthetic_authorization_failure/);
  assert.equal(h.queries(),0);assert.equal(h.keys(),0);assert.equal(cas(h),0);assert.equal(h.uploads.length,0);
  assert.equal(h.storage.snapshot().record,null);assert.equal(h.storage.snapshot().fenced,false);
  deny=false;assert.equal((await importer.refresh(input())).status,'complete');
  assert.deepEqual(requested,[['steps'],['steps']]);
});
test('consent withdrawn while availability is pending cancels before permission or query and fences regrant',async()=>{
  const h=fixture();
  h.options.native.availability=async()=>{h.events.push('availability');h.setConsent(false);return 'available';};
  assert.equal((await h.create().refresh(input())).status,'cancelled');
  assert.deepEqual(h.events,['availability']);assert.equal(h.queries(),0);assert.equal(h.keys(),0);assert.equal(h.uploads.length,0);
  assert.equal(h.storage.snapshot().fenced,true);
  h.setConsent(true);await assert.rejects(h.create().refresh(input()),/reconciliation_required/);
});
test('an ACK must echo the page and cursor with nonnegative integer counts or the prepared page stays retained',async()=>{
  for(const forge of [ack=>({...ack,pageId:'other-page'}),ack=>({...ack,accepted:-1}),ack=>({...ack,accepted:1.5}),
    ack=>({...ack,duplicates:Number.NaN}),ack=>({...ack,duplicates:'1'}),()=>null,()=>undefined]){
    const h=fixture(),send=h.options.api.importPage;
    h.options.api.importPage=async(page,key)=>forge(await send(page,key));
    const importer=h.create();assert.equal((await importer.refresh(input())).status,'unknown');
    const stored=h.storage.snapshot().record;assert.equal(stored.phase,'prepared');assert.equal(stored.key,'key-1');
    assert.equal(h.reconciliations.length,0);assert.equal(h.queries(),1);assert.equal(h.uploads.length,1);
    await assert.rejects(importer.refresh(input()),/reconciliation_required/);assert.equal(h.queries(),1);
  }
});
test('a duplicate-only ACK is a valid completion and the next refresh uses a fresh opaque key',async()=>{
  const h=fixture(),send=h.options.api.importPage;
  h.options.api.importPage=async(page,key)=>{const ack=await send(page,key);return {...ack,accepted:0,duplicates:page.batch.length};};
  const importer=h.create();
  assert.deepEqual(await importer.refresh(input()),{status:'complete',pages:1});
  assert.deepEqual(await importer.refresh({...input(),cursor:'anchor-1'}),{status:'complete',pages:1});
  assert.deepEqual(h.uploads.map(upload=>upload.key),['key-1','key-2']);assert.equal(h.uploads[1].page.fromCursor,'anchor-1');
  assert.equal(h.storage.snapshot().record,null);assert.equal(h.reconciliations.length,2);
});
test('a restored journal record that is malformed, foreign or fenced fails closed before any upload or query',async()=>{
  const lost=async()=>{
    const h=fixture(),send=h.options.api.importPage;
    h.options.api.importPage=async(page,key)=>{await send(page,key);throw Error('lost');};
    assert.equal((await h.create().refresh(input())).status,'unknown');return h;
  };
  const forgeries=[
    ['health_journal_invalid',snapshot=>{snapshot.record.page.connectionId='other';}],
    ['health_journal_invalid',snapshot=>{snapshot.record.page.generation=2;}],
    ['health_journal_invalid',snapshot=>{snapshot.record.page.stream='other-stream';}],
    ['health_journal_invalid',snapshot=>{snapshot.record.page.version=2;}],
    ['health_journal_invalid',snapshot=>{snapshot.record.page.pageId='other-page';}],
    ['health_journal_invalid',snapshot=>{snapshot.record.pageId='other-page';}],
    ['health_journal_invalid',snapshot=>{snapshot.record.key='';snapshot.record.pageId='';}],
    ['health_journal_invalid',snapshot=>{snapshot.record.phase='unrecognized';}],
    ['health_journal_invalid',snapshot=>{snapshot.record={...snapshot.record,phase:'acknowledged',ack:{accepted:1,duplicates:0,cursor:'anchor-1',pageId:'other-page'}};delete snapshot.record.page;}],
    ['health_journal_invalid',snapshot=>{snapshot.revision='';}],
    ['health_import_reconciliation_required',snapshot=>{snapshot.fenced=true;}],
    ['health_import_reconciliation_required',snapshot=>{snapshot.record.phase='scrubbed';}],
  ];
  for(const [code,forge] of forgeries){
    const h=await lost(),load=h.options.journal.load;
    h.options.journal.load=async()=>{const snapshot=await load();forge(snapshot);return snapshot;};
    await assert.rejects(h.create().retryUnknown(input()),new RegExp(code),code);
    assert.equal(h.uploads.length,1);assert.equal(h.queries(),1);assert.equal(h.reconciliations.length,0);
  }
});
test('native pages that violate the bucket contract fail before a key, journal write or upload',async()=>{
  const many=(records,tombstones)=>({records:Array.from({length:records},(_,index)=>({...nativeRecord(),id:`bucket-${index}`,type:'workouts',kind:'workout',
    values:['workout_duration','workout_energy','workout_distance'].map((metric,position)=>({metric,value:1,unit:['s','kcal','m'][position],aggregation:'workout'}))})),
    tombstones:Array.from({length:tombstones},(_,index)=>({id:`gone-${index}:steps`,revision:{token:'v',order:1}})),anchor:'anchor-1',more:false,logicalBucketsComplete:true});
  const bad=[
    {...many(1,0),logicalBucketsComplete:false},many(101,0),many(0,501),many(100,201),
    {...many(1,0),records:[{...nativeRecord(),values:[{metric:'steps',value:1,unit:'kg',aggregation:'sum'}]}]},
    {...many(1,0),records:[{...nativeRecord(),values:[{metric:'steps',value:-1,unit:'count',aggregation:'sum'}]}]},
    {...many(1,0),more:true,anchor:null},
  ];
  for(const page of bad){
    const h=fixture();h.options.native.query=async()=>{h.events.push('query');return structuredClone(page);};
    await assert.rejects(h.create().refresh(input()),/health_native_contract|health_native_cursor_cycle/);
    assert.equal(h.keys(),0);assert.equal(cas(h),0);assert.equal(h.uploads.length,0);assert.equal(h.storage.snapshot().record,null);
  }
});
test('a contract violation on a later page keeps earlier acknowledged pages committed and clean',async()=>{
  const h=fixture();let n=0;
  h.options.native.query=async()=>{n++;return {records:[nativeRecord()],tombstones:[],anchor:`anchor-${n}`,more:n===1,logicalBucketsComplete:n===1};};
  await assert.rejects(h.create().refresh(input()),/health_native_contract/);
  assert.equal(n,2);assert.equal(h.uploads.length,1);assert.equal(h.reconciliations.length,1);
  assert.equal(h.storage.snapshot().record,null);assert.equal(h.keys(),1);
});
test('a forged acknowledged cursor is held by authoritative checkpoint reconciliation, never cleared locally',async()=>{
  const h=fixture(),send=h.options.api.importPage;
  h.options.api.importPage=async(page,key)=>{await send(page,key);throw Error('lost');};
  assert.equal((await h.create().refresh(input())).status,'unknown');
  const load=h.options.journal.load;
  h.options.journal.load=async()=>{const snapshot=await load();snapshot.record={...snapshot.record,phase:'acknowledged',ack:{accepted:1,duplicates:0,cursor:'forged-cursor',pageId:'key-1'}};delete snapshot.record.page;return snapshot;};
  assert.equal((await h.create().retryUnknown(input())).status,'unknown');
  assert.equal(h.reconciliations.length,1);assert.equal(h.reconciliations[0].ack.cursor,'forged-cursor');
  assert.equal(h.uploads.length,1);assert.equal(h.queries(),1);assert.equal(h.storage.snapshot().record.phase,'prepared');
});
const httpClassifier=error=>!(Number.isInteger(error?.status)&&error.status>=400&&error.status<500);
test('a definitive upload rejection clears the prepared page, rejects with the server error and allows a fresh key',async()=>{
  for(const rejection of [{status:409,code:'health_connection_changed'},{status:422,code:'health_invalid_input'}]){
    const h=fixture(),send=h.options.api.importPage;let reject=true;h.options.isUnknown=httpClassifier;
    h.options.api.importPage=async(page,key)=>{if(reject){h.uploads.push(structuredClone({page,key}));throw rejection;}return send(page,key);};
    const importer=h.create();
    await assert.rejects(importer.refresh(input()),error=>error===rejection);
    assert.equal(h.storage.snapshot().record,null);assert.equal(h.storage.snapshot().fenced,false);
    assert.deepEqual(h.unresolved,[]);assert.equal(h.events.includes('reconcile'),false);
    await assert.rejects(importer.retryUnknown(),/health_import_no_pending/);assert.equal(h.uploads.length,1);
    reject=false;assert.deepEqual(await importer.refresh(input()),{status:'complete',pages:1});
    assert.deepEqual(h.uploads.map(u=>u.key),['key-1','key-2']);assert.equal(h.storage.snapshot().record,null);
  }
});
test('a definitive rejection on retry of an unknown upload also settles the retained page',async()=>{
  const h=fixture();let outcome='lost';h.options.isUnknown=httpClassifier;
  h.options.api.importPage=async(page,key)=>{h.uploads.push(structuredClone({page,key}));if(outcome==='lost')throw new TypeError('fetch failed');throw {status:409};};
  const importer=h.create();assert.equal((await importer.refresh(input())).status,'unknown');
  assert.equal(h.storage.snapshot().record.phase,'prepared');
  outcome='conflict';await assert.rejects(importer.retryUnknown(),error=>error?.status===409);
  assert.deepEqual(h.uploads[0],h.uploads[1]);assert.equal(h.storage.snapshot().record,null);assert.equal(h.queries(),1);
});
test('possibly dispatched upload errors and a throwing classifier stay unknown and retain the exact prepared page',async()=>{
  const timeout=Object.assign(new Error('timed out'),{name:'TimeoutError'});
  const cases=[[new TypeError('fetch failed'),httpClassifier],[timeout,httpClassifier],[{status:503},httpClassifier],[{status:502},httpClassifier],
    [{status:409},()=>{throw new Error('classifier_failed');}],[{status:409},()=>undefined],[{status:409},()=>'false']];
  for(const [failure,isUnknown] of cases){
    const h=fixture(),send=h.options.api.importPage;let fail=true;h.options.isUnknown=isUnknown;
    h.options.api.importPage=async(page,key)=>{if(fail){h.uploads.push(structuredClone({page,key}));throw failure;}return send(page,key);};
    const importer=h.create();assert.deepEqual(await importer.refresh(input()),{status:'unknown',pages:0});
    const stored=h.storage.snapshot().record;assert.equal(stored.phase,'prepared');assert.equal(stored.key,'key-1');assert.deepEqual(stored.page,h.uploads[0].page);
    await assert.rejects(importer.refresh(input()),/reconciliation_required/);
    fail=false;assert.equal((await importer.retryUnknown()).status,'complete');
    assert.equal(h.uploads[1].key,'key-1');assert.deepEqual(h.uploads[1].page,h.uploads[0].page);assert.equal(h.keys(),1);assert.equal(h.queries(),1);
  }
});
test('a definitive rejection whose clear is unknown stays unknown rather than discarding the page',async()=>{
  const h=fixture(),cas=h.options.journal.compareAndSwap;h.options.isUnknown=httpClassifier;
  h.options.api.importPage=async(page,key)=>{h.uploads.push(structuredClone({page,key}));throw {status:409};};
  h.options.journal.compareAndSwap=async(...args)=>args[1]===null?{status:'unknown'}:cas(...args);
  assert.deepEqual(await h.create().refresh(input()),{status:'unknown',pages:0});
  assert.equal(h.storage.snapshot().record.phase,'prepared');assert.equal(h.uploads.length,1);
});
