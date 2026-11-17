import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,a,b,connection,page,record,complete } from './fixture.mjs';
import { stable,digest } from '../../../src/wearables/validation.ts';
import { wearableTables } from '../../../src/wearables/persistence/index.ts';

test('canonical database requires active session, epoch and root writer witness',t=>{
  const h=fixture(t);
  assert.throws(()=>h.store.putCursor(a,'hk',1,'steps','x'),/writer_transaction/);
  assert.throws(()=>h.db.transaction(()=>h.store.putCursor(a,'hk',1,'steps','x')).immediate(),/writer_witness/);
  assert.throws(()=>h.store.connections({...a,epoch:9}),/epoch_changed/);
  assert.throws(()=>h.store.connections({...a,accountId:'b'}),/session_invalid/);
  assert.equal(h.store.cursor(a,'hk',1,'steps'),null);
});
test('records, cursor and immutable receipts roll back together and stay account scoped',t=>{
  const h=fixture(t);
  assert.throws(()=>h.write(a,()=>{h.service.ingest(a,'command',page());throw Error('rollback');}),/rollback/);
  assert.equal(h.store.measure(a,'hk',1,'day'),null);assert.equal(h.store.cursor(a,'hk',1,'steps'),null);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM wearable_receipts').get().n,0);
  h.service.ingest(a,'command',page());h.service.ingest(b,'command',page());
  const key=stable(['wearables-command','command']),prior=h.store.receipt(a,key);
  h.write(a,()=>h.store.putReceipt(a,key,prior));
  assert.throws(()=>h.write(a,()=>h.store.putReceipt(a,key,{...prior,result:{changed:true}})),/receipt_immutable/);
  assert.throws(()=>h.db.prepare('UPDATE wearable_receipts SET fingerprint=? WHERE account_id=?').run('changed','a'),/receipt_immutable/);
  assert.equal(h.store.measure(b,'hk',1,'day').value,123);
});
test('SQL rejects missing, null and forged AI/provenance fields',t=>{
  const h=fixture(t);h.service.ingest(a,'command',page());
  const original=h.store.measure(a,'hk',1,'day');
  for(const field of ['aiEligible','provenance'])for(const value of [undefined,null,true]){
    const malformed={...original,[field]:value};
    assert.throws(()=>h.db.prepare('UPDATE wearable_measures SET data=? WHERE account_id=?').run(JSON.stringify(malformed),'a'),/CHECK constraint/);
  }
  assert.equal(h.store.measure(a,'hk',1,'day').aiEligible,false);
});
test('disconnect removes scoped values and cursors, tombstones receipts and leaves other connections alone',t=>{
  const fences=[];const h=fixture(t,{externalConnectionPurge:(ctx,scope)=>{fences.push({ctx,scope});return {status:'complete'};}});h.service.ingest(a,'command',page());
  h.write(a,()=>h.store.putConnection(a,{...connection,id:'other'}));
  h.service.ingest(a,'other-command',page({connectionId:'other'}));
  const before={id:'suggestion',planId:'plan',baseRevision:1,appliedRevision:null,state:'pending',beforeItems:[],afterItems:[],reviewDigest:'digest',expiresAt:'2026-12-01T00:00:00Z',reason:'synthetic',limits:[],policyVersion:'synthetic',evidenceRefs:[{connectionId:'hk',generation:1,id:'day',digest:h.store.measure(a,'hk',1,'day').digest}]};
  h.write(a,()=>h.store.putSuggestion(a,before));
  assert.equal(h.service.disconnect(a,'disconnect',{connectionId:'hk',generation:1}).purged,true);
  assert.deepEqual(fences,[{ctx:a,scope:{connectionId:'hk',generation:2}}]);
  assert.equal(h.store.measure(a,'hk',1,'day'),null);
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM wearable_cursors WHERE account_id='a' AND connection_id='hk'").get().n,0);
  assert.deepEqual(h.store.receipt(a,stable(['wearables-command','command'])),{fingerprint:digest({op:'import',page:page(),provider:'healthkit'}),scope:null,purged:true});
  assert.throws(()=>h.service.disconnect(a,'disconnect',{connectionId:'hk',generation:1}),/receipt_purged/);
  assert.equal(h.store.suggestion(a,'suggestion').state,'invalidated');
  assert.equal(h.store.measure(a,'other',1,'day').value,123);
  assert.equal(h.store.receipt(a,stable(['wearables-command','other-command'])).purged,undefined);
});
test('disconnect requires bounded external local purge and distinguishes unknown effects',t=>{
  const h=fixture(t,{externalConnectionPurge:undefined});h.service.ingest(a,'command',page());
  assert.throws(()=>h.service.disconnect(a,'disconnect',{connectionId:'hk',generation:1}),/external_connection_purge_unavailable/);
  assert.equal(h.store.connection(a,'hk').connected,true);assert.equal(h.store.measure(a,'hk',1,'day').value,123);
  let calls=0;h.deps.externalConnectionPurge=()=>{calls++;return {status:'unknown'};};
  assert.throws(()=>h.service.disconnect(a,'disconnect',{connectionId:'hk',generation:1}),/external_connection_purge_unknown/);
  assert.equal(calls,1);
});
test('suggestion review body and terminal history are immutable; retention stays unavailable',t=>{
  const h=fixture(t);
  const suggestion={id:'s',planId:'plan',baseRevision:1,appliedRevision:null,state:'pending',beforeItems:[],afterItems:[],reviewDigest:'d',expiresAt:'2026-12-01T00:00:00Z',reason:'synthetic',limits:[],policyVersion:'synthetic',evidenceRefs:[]};
  h.write(a,()=>h.store.putSuggestion(a,suggestion));
  assert.throws(()=>h.write(a,()=>h.store.putSuggestion(a,{...suggestion,reason:'changed'})),/suggestion_immutable/);
  h.write(a,()=>h.store.putSuggestion(a,{...suggestion,state:'applied',appliedRevision:2}));
  assert.throws(()=>h.write(a,()=>h.store.putSuggestion(a,suggestion)),/suggestion_changed/);
  assert.throws(()=>h.service.expireProposalRetention(a,120),/retention_policy_unqualified/);
});
test('provider intents bind original session, policy, page and root acknowledgment',t=>{
  const h=fixture(t);h.write(a,()=>h.store.putConnection(a,{...connection,id:'oura',provider:'oura'}));
  const input={ctx:a,provider:'oura',connectionId:'oura',generation:1,stream:'steps',cursor:null};
  const port=h.providerIntent(input),p=page({connectionId:'oura',pageId:'intent'});
  const intent={key:'intent',binding:stable(['a','session-a',0,'oura','oura',1,'steps',null]),page:p};
  h.setPermitted(false);assert.throws(()=>port.load(),/no_save_or_consent/);
  assert.throws(()=>h.write(a,()=>port.save(intent)),/no_save_or_consent/);
  h.setPermitted(true);
  assert.throws(()=>h.db.transaction(()=>port.save(intent)).immediate(),/writer_witness/);
  port.save(intent);
  assert.deepEqual(port.load(),intent);
  assert.throws(()=>h.write(a,()=>port.save({...intent,page:{...p,nextCursor:'changed'}})),/intent_changed/);
  assert.throws(()=>h.write(a,()=>port.acknowledged('intent')),/provider_ack_required/);
  h.db.prepare('INSERT INTO session VALUES(?,?,?)').run('session-other',a.authUserId,Date.now()+3600000);
  assert.throws(()=>h.providerIntent({...input,ctx:{...a,sessionId:'session-other'}}).load(),/intent_changed/);
  h.service.ingest(a,'intent',p,{provider:'oura'});
  h.setPermitted(false);assert.throws(()=>h.write(a,()=>port.acknowledged('intent')),/no_save_or_consent/);
  h.setPermitted(true);port.acknowledged('intent');assert.equal(port.load(),null);
});
test('independent ledger fences restored active rows even after main transaction rollback',t=>{
  const h=fixture(t);h.service.ingest(a,'command',page());
  assert.throws(()=>h.db.transaction(()=>{h.disable(a);throw Error('main rollback');}).immediate(),/rollback/);
  assert.equal(h.db.prepare("SELECT state FROM account_lifecycle WHERE account_id='a'").get().state,'active');
  assert.throws(()=>h.store.connections(a),/account_disabled/);
  assert.equal(h.db.transaction(()=>h.adapter.suppress('a',1)).immediate().status,'complete');
  assert.equal(h.adapter.verifySuppressed('a',1).status,'complete');
});
test('lifecycle requires external coverage and request readiness; complete purge erases every local account row',t=>{
  const h=fixture(t);h.service.ingest(a,'command',page());h.service.ingest(b,'command',page());
  h.write(a,()=>{
    h.store.putConnection(a,{...connection,id:'oura',provider:'oura'});
    h.store.putSuggestion(a,{id:'s',planId:'plan',baseRevision:1,appliedRevision:null,state:'pending',beforeItems:[],afterItems:[],reviewDigest:'d',expiresAt:'2026-12-01T00:00:00Z',reason:'synthetic',limits:[],policyVersion:'synthetic',evidenceRefs:[]});
  });
  h.providerIntent({ctx:a,provider:'oura',connectionId:'oura',generation:1,stream:'steps',cursor:null}).save({key:'intent',
    binding:stable(['a','session-a',0,'oura','oura',1,'steps',null]),page:page({connectionId:'oura',pageId:'intent'})});
  for(const table of wearableTables)assert.ok(h.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get('a').n>0);
  h.disable(a);
  assert.equal(h.adapter.purge('delete-a','a').status,'unavailable');
  assert.equal(h.db.transaction(()=>h.adapter.purge('wrong','a')).immediate().status,'unavailable');
  assert.equal(h.db.transaction(()=>h.adapter.purge('delete-a','a')).immediate().status,'complete');
  for(const table of wearableTables)assert.equal(h.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get('a').n,0);
  assert.equal(h.store.measure(b,'hk',1,'day').value,123);
  const missing=fixture(t,{externalLifecycle:undefined});missing.disable(a);
  assert.equal(missing.db.transaction(()=>missing.adapter.suppress('a',1)).immediate().status,'unavailable');
  assert.equal(missing.db.transaction(()=>missing.adapter.purge('delete-a','a')).immediate().status,'unavailable');
});
test('export omits health without explicit qualification and excludes raw operational state',t=>{
  const h=fixture(t);h.service.ingest(a,'command',page());const output=[];
  const snapshot={snapshotAtMs:1,append:(category,value)=>output.push({category,value})};
  assert.equal(h.adapter.export(a,snapshot).status,'unavailable');assert.equal(output.some(x=>x.value.kind==='measure'),false);
  h.deps.qualifyExport=()=>false;output.length=0;assert.equal(h.adapter.export(a,snapshot).status,'unavailable');assert.equal(output.some(x=>x.value.kind==='measure'),false);
  h.deps.qualifyExport=()=>true;output.length=0;assert.equal(h.adapter.export(a,snapshot).status,'complete');
  assert.equal(output.find(x=>x.value.kind==='measure').value.data.aiEligible,false);
  assert.equal(JSON.stringify(output).includes('private-cursor'),false);
});
test('export fences session loss during qualification before appending a health record',t=>{
  const h=fixture(t);h.service.ingest(a,'command',page());const output=[];
  h.deps.qualifyExport=()=>{h.disable(a);return true;};
  assert.throws(()=>h.adapter.export(a,{snapshotAtMs:1,append:(_category,value)=>output.push(value)}),/account_disabled/);
  assert.equal(output.length,0);
});

const sorted=value=>value.map(row=>JSON.stringify(row)).sort();
const accountRows=(h,accountId)=>Object.fromEntries(wearableTables.map(table=>[table,sorted(h.db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(accountId))]));
const rowCount=(h,accountId)=>wearableTables.reduce((total,table)=>total+h.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId).n,0);
const recordNamed=(id,changes={})=>({...record(),id,...changes});
const collect=()=>{const output=[];return {output,snapshot:{snapshotAtMs:1,append:(category,value)=>output.push({category,value})}};};
const exportedIds=output=>output.filter(item=>item.value.kind==='measure').map(item=>item.value.data.id);
test('export contains only live owned measures from every connection, never tombstoned, disconnected or foreign rows',t=>{
  const qualified=[],h=fixture(t,{qualifyExport:(ctx,value)=>{qualified.push({account:ctx.accountId,id:value.id});return true;}});
  h.write(a,()=>{h.store.putConnection(a,{...connection,id:'oura',provider:'oura'});h.store.putConnection(a,{...connection,id:'gone'});});
  h.service.ingest(a,'live',page({batch:[recordNamed('live'),recordNamed('dead')]}));
  h.service.ingest(a,'tombstone',page({pageId:'tombstone',fromCursor:'private-cursor',nextCursor:'private-cursor-2',batch:[],tombstones:[{id:'dead',revision:{token:'r2',order:2}}]}));
  h.service.ingest(a,'oura',page({connectionId:'oura',pageId:'oura-page',batch:[recordNamed('oura-live')]}),{provider:'oura'});
  h.service.ingest(a,'gone',page({connectionId:'gone',pageId:'gone-page',batch:[recordNamed('gone-live')]}));
  h.service.disconnect(a,'disconnect-gone',{connectionId:'gone',generation:1});
  h.service.ingest(b,'other',page({batch:[recordNamed('foreign-live')]}));
  const mine=collect(),theirs=collect();
  assert.equal(h.adapter.export(a,mine.snapshot).status,'complete');assert.equal(h.adapter.export(b,theirs.snapshot).status,'complete');
  assert.deepEqual(exportedIds(mine.output),['live','oura-live']);assert.deepEqual(exportedIds(theirs.output),['foreign-live']);
  assert.deepEqual(qualified.filter(item=>item.account==='a').map(item=>item.id),['live','oura-live']);
  assert.deepEqual(qualified.filter(item=>item.account==='b').map(item=>item.id),['foreign-live']);
  for(const item of [...mine.output,...theirs.output].filter(item=>item.value.kind==='measure')){
    assert.equal(item.value.data.aiEligible,false);assert.equal(item.value.data.provenance,'unqualified_import');assert.equal(item.value.data.deleted,false);
  }
  assert.deepEqual(mine.output.filter(item=>item.value.kind==='manifest').map(item=>({exported:item.value.exported,unqualified:item.value.unqualified,status:item.value.status,ai:item.value.aiEligible})),
    [{exported:2,unqualified:0,status:'complete',ai:false}]);
  const text=JSON.stringify(mine.output);
  for(const hidden of ['private-cursor','foreign-live','gone-live','"dead"'])assert.equal(text.includes(hidden),false,hidden);
});
const exporting=(t,overrides={})=>{const h=fixture(t,{qualifyExport:()=>true,...overrides});h.service.ingest(a,'command',page());return h;};
test('export rejects an unusable snapshot before qualification and names the omitted private classes',t=>{
  for(const bad of [null,{},{snapshotAtMs:Number.NaN,append(){}},{snapshotAtMs:1}]){
    const h=exporting(t);h.deps.qualifyExport=()=>{throw Error('must_not_qualify');};
    assert.throws(()=>h.adapter.export(a,bad),/health_export_snapshot_required/);
  }
  const h=exporting(t),sink=collect();h.adapter.export(a,sink.snapshot);
  assert.deepEqual(sink.output.find(item=>item.value.kind==='manifest').value.omissions,['credentials','cursors','raw_provider_intents','receipt_results','suggestion_plan_snapshots',
    'connection_consent_metadata','suggestion_records','measure_tombstones']);
  assert.deepEqual([...new Set(sink.output.map(item=>item.value.kind))].sort(),['manifest','measure']);
});
test('export refuses oversized or malformed stored measures without appending or qualifying anything',t=>{
  const original=h=>JSON.parse(h.db.prepare('SELECT data FROM wearable_measures WHERE account_id=?').get('a').data);
  const attempts={
    count:h=>h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
      INSERT INTO wearable_measures SELECT 'a','hk',1,'bulk-'||i,'2026-10-09',(SELECT data FROM wearable_measures WHERE account_id='a' LIMIT 1) FROM n`).run(),
    largest:h=>h.db.prepare('UPDATE wearable_measures SET data=? WHERE account_id=?').run(JSON.stringify({...original(h),extra:'x'.repeat(1100000)}),'a'),
    total:h=>{const data=JSON.stringify({...original(h),extra:'x'.repeat(1000000)});
      for(let i=0;i<17;i++)h.db.prepare("INSERT INTO wearable_measures VALUES('a','hk',1,?,'2026-10-09',?)").run('big-'+i,data);},
  };
  for(const [name,mutate] of Object.entries(attempts)){
    const h=exporting(t),sink=collect();let qualified=0;mutate(h);h.deps.qualifyExport=()=>{qualified++;return true;};
    assert.throws(()=>h.adapter.export(a,sink.snapshot),/health_export_packaging_required/,name);
    assert.equal(sink.output.length,0,name);assert.equal(qualified,0,name);
  }
  const h=exporting(t),sink=collect();let qualified=0;h.deps.qualifyExport=()=>{qualified++;return true;};
  h.db.prepare('UPDATE wearable_measures SET data=? WHERE account_id=?').run(JSON.stringify({...original(h),unit:'kg'}),'a');
  assert.throws(()=>h.adapter.export(a,sink.snapshot),/health_invalid_value/);assert.equal(sink.output.length,0);assert.equal(qualified,0);
});
test('export keeps a measure-only result honest when external coverage is unknown, unavailable or thrown',t=>{
  const cases=[['unknown',()=>({status:'unknown',reason:'synthetic_external_unknown'}),'unknown'],['unavailable',()=>({status:'unavailable',reason:'synthetic_external_unavailable'}),'unavailable'],
    ['thrown',()=>{throw Error('synthetic_external_failure');},'unknown'],['complete',()=>({status:'complete',count:0}),'complete']];
  for(const [name,external,status] of cases){
    const h=exporting(t,{externalLifecycle:{...complete,export:external}}),sink=collect();
    const result=h.adapter.export(a,sink.snapshot),manifest=sink.output.find(item=>item.value.kind==='manifest').value;
    assert.equal(result.status,status,name);assert.equal(result.count,1,name);assert.deepEqual(exportedIds(sink.output),['day'],name);
    assert.equal(manifest.status,status,name);assert.equal(manifest.externalStatus,status,name);assert.equal(manifest.aiEligible,false);
  }
  const h=exporting(t);h.deps.qualifyExport=()=>false;const sink=collect();
  assert.deepEqual({status:h.adapter.export(a,sink.snapshot).status,exported:sink.output[0].value.exported,unqualified:sink.output[0].value.unqualified,external:sink.output[0].value.externalStatus},
    {status:'unavailable',exported:0,unqualified:1,external:'complete'});
});
test('disconnecting one connection removes its intents and cursors only, and never another account or connection',t=>{
  const h=fixture(t);
  h.write(a,()=>{h.store.putConnection(a,{...connection,id:'oura',provider:'oura'});h.store.putConnection(a,{...connection,id:'oura-two',provider:'oura'});});
  const port=id=>h.providerIntent({ctx:a,provider:'oura',connectionId:id,generation:1,stream:'steps',cursor:null});
  for(const id of ['oura','oura-two']){
    const pending=page({connectionId:id,pageId:'intent-'+id});
    port(id).save({key:'intent-'+id,binding:stable(['a','session-a',0,'oura',id,1,'steps',null]),page:pending});
    h.service.ingest(a,'intent-'+id,pending,{provider:'oura'});
  }
  h.service.ingest(a,'hk-page',page());h.service.ingest(b,'hk-page',page());
  const foreign=accountRows(h,'b'),keep=h.db.prepare("SELECT count(*) AS n FROM wearable_provider_intents WHERE account_id='a' AND connection_id='oura-two'").get().n;
  assert.deepEqual(h.service.disconnect(a,'drop-oura',{connectionId:'oura',generation:1}),{disconnected:true,purged:true,remoteRevocation:'pending'});
  for(const table of ['wearable_provider_intents','wearable_cursors','wearable_measures'])
    assert.equal(h.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id='a' AND connection_id='oura'`).get().n,0,table);
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM wearable_provider_intents WHERE account_id='a' AND connection_id='oura-two'").get().n,keep);
  assert.equal(h.store.receipt(a,stable(['wearables-command','intent-oura'])).purged,true);
  assert.equal(h.store.receipt(a,stable(['wearables-command','intent-oura-two'])).purged,undefined);
  assert.equal(h.store.measure(a,'hk',1,'day').value,123);assert.equal(h.store.connection(a,'oura').connected,false);
  assert.deepEqual(accountRows(h,'b'),foreign);
});
test('a rejected or failed disconnect changes nothing and the same key can complete once purge is available',t=>{
  const h=fixture(t);h.service.ingest(a,'command',page());
  const before=accountRows(h,'a');
  for(const [input,pattern] of [[{connectionId:'hk',generation:2},/health_connection_changed/],[{connectionId:'missing',generation:1},/health_not_found/],
    [{connectionId:'hk',generation:1,extra:true},/health_invalid_input/],[{connectionId:'hk',generation:-1},/health_invalid_input/]]){
    assert.throws(()=>h.service.disconnect(a,'disconnect',input),pattern);assert.deepEqual(accountRows(h,'a'),before);
  }
  let outcome='unknown';h.deps.externalConnectionPurge=()=>{if(outcome==='throw')throw Error('synthetic_native_failure');return {status:outcome};};
  for(outcome of ['unknown','unavailable','throw']){
    assert.throws(()=>h.service.disconnect(a,'disconnect',{connectionId:'hk',generation:1}),/health_external_connection_purge_(unknown|unavailable)/,outcome);
    assert.deepEqual(accountRows(h,'a'),before,outcome);
  }
  outcome='complete';assert.equal(h.service.disconnect(a,'disconnect',{connectionId:'hk',generation:1}).purged,true);
  assert.equal(h.store.measure(a,'hk',1,'day'),null);assert.equal(h.store.connection(a,'hk').generation,2);
  assert.throws(()=>h.service.disconnect(a,'disconnect',{connectionId:'hk',generation:1}),/health_receipt_purged/);
  assert.throws(()=>h.service.disconnect(a,'disconnect',{connectionId:'other',generation:1}),/health_key_reuse/);
});
test('a stale disconnect generation cannot erase data imported after a reconnect',t=>{
  const h=fixture(t);h.service.ingest(a,'first',page());
  h.service.disconnect(a,'disconnect',{connectionId:'hk',generation:1});
  assert.equal(h.service.connectHealthKit(a,'reconnect',{connectionId:'hk',types:['steps'],consentVersion:'synthetic',retentionConsent:true}).generation,3);
  h.service.ingest(a,'second',page({generation:3,pageId:'second-page',batch:[recordNamed('fresh')]}));
  const before=accountRows(h,'a');
  for(const generation of [1,2])assert.throws(()=>h.service.disconnect(a,'stale-'+generation,{connectionId:'hk',generation}),/health_connection_changed/);
  assert.deepEqual(accountRows(h,'a'),before);assert.equal(h.store.measure(a,'hk',3,'fresh').value,123);
});
test('a non-complete external account purge leaves every local row, then completion erases only the owning account',t=>{
  let mode='unknown';
  const external={...complete,purge:()=>{if(mode==='throw')throw Error('synthetic_external_failure');return {status:mode};}};
  const h=fixture(t,{externalLifecycle:external});
  h.service.ingest(a,'live',page({batch:[recordNamed('live'),recordNamed('dead')]}));
  h.service.ingest(a,'tombstone',page({pageId:'tombstone',fromCursor:'private-cursor',nextCursor:'private-cursor-2',batch:[],tombstones:[{id:'dead',revision:{token:'r2',order:2}}]}));
  h.write(a,()=>h.store.putConnection(a,{...connection,id:'oura',provider:'oura'}));
  h.providerIntent({ctx:a,provider:'oura',connectionId:'oura',generation:1,stream:'steps',cursor:null}).save({key:'intent',
    binding:stable(['a','session-a',0,'oura','oura',1,'steps',null]),page:page({connectionId:'oura',pageId:'intent'})});
  h.service.ingest(b,'live',page());
  const mine=accountRows(h,'a'),theirs=accountRows(h,'b');
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM wearable_measures WHERE account_id='a' AND json_extract(data,'$.deleted')=1").get().n,1);
  h.disable(a);
  for(mode of ['unknown','unavailable','throw']){
    assert.notEqual(h.db.transaction(()=>h.adapter.purge('delete-a','a')).immediate().status,'complete',mode);
    assert.deepEqual(accountRows(h,'a'),mine,mode);assert.deepEqual(accountRows(h,'b'),theirs,mode);
  }
  mode='complete';assert.equal(h.db.transaction(()=>h.adapter.purge('delete-a','a')).immediate().status,'complete');
  assert.equal(rowCount(h,'a'),0);assert.deepEqual(accountRows(h,'b'),theirs);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM form_accounts WHERE id=?').get('b').n,1);
});
test('the store refuses to resurrect a deleted record and keeps no health payload on a tombstone',t=>{
  const h=fixture(t);h.service.ingest(a,'live',page());
  const live=h.store.measure(a,'hk',1,'day');
  h.service.ingest(a,'tombstone',page({pageId:'tombstone',fromCursor:'private-cursor',nextCursor:'private-cursor-2',batch:[],tombstones:[{id:'day',revision:{token:'r2',order:2}}]}));
  assert.throws(()=>h.write(a,()=>h.store.putMeasure(a,{...live,revision:{token:'r3',order:3}})),/health_record_deleted/);
  h.write(a,()=>h.store.putMeasure(a,{...live,deleted:true,value:9,start:'2026-10-09T00:00:00Z',end:'2026-10-10T00:00:00Z',zone:'UTC',quality:'complete',
    source:{bundleId:'secret.app',name:'Secret',device:'Secret device',algorithm:null,originalId:'secret-id'},revision:{token:'r4',order:4}}));
  const stored=h.store.measure(a,'hk',1,'day');
  assert.deepEqual({deleted:stored.deleted,value:stored.value,start:stored.start,end:stored.end,zone:stored.zone,quality:stored.quality,source:stored.source,ai:stored.aiEligible},
    {deleted:true,value:0,start:null,end:null,zone:null,quality:'unknown',source:{bundleId:'deleted',name:'deleted',device:null,algorithm:null,originalId:null},ai:false});
  assert.equal(JSON.stringify(h.db.prepare('SELECT data FROM wearable_measures WHERE account_id=?').all('a')).includes('secret'),false);
});

const exportedOmissions=['credentials','cursors','raw_provider_intents','receipt_results','suggestion_plan_snapshots','connection_consent_metadata','suggestion_records','measure_tombstones'];
test('export manifests name every unexported wearable relation with a stable reason and never emit connection, consent or suggestion state',t=>{
  const suggestion={id:'suggestion-marker',planId:'plan-marker',baseRevision:1,appliedRevision:null,state:'pending',beforeItems:[],afterItems:[],reviewDigest:'review-marker',
    expiresAt:'2026-12-01T00:00:00Z',reason:'reason-marker',limits:[],policyVersion:'policy-marker',evidenceRefs:[{connectionId:'hk',generation:1,id:'day',digest:'digest-marker'}]};
  for(const qualify of [undefined,()=>true]){
    const h=fixture(t,qualify?{qualifyExport:qualify}:{});
    h.write(a,()=>h.store.putConnection(a,{...connection,id:'oura',provider:'oura',consentVersion:'consent-marker',types:['steps','resting_hr']}));
    h.service.ingest(a,'command',page({batch:[record(),recordNamed('gone')]}));
    h.service.ingest(a,'tombstone',page({pageId:'tombstone',fromCursor:'private-cursor',nextCursor:'private-cursor-2',batch:[],tombstones:[{id:'gone',revision:{token:'r2',order:2}}]}));
    h.write(a,()=>h.store.putSuggestion(a,suggestion));
    const sink=collect(),result=h.adapter.export(a,sink.snapshot),manifests=sink.output.filter(item=>item.value.kind==='manifest');
    assert.equal(manifests.length,1);const manifest=manifests[0].value;
    assert.deepEqual(manifest.omissions,exportedOmissions);assert.deepEqual(Object.keys(manifest.omissionReasons),exportedOmissions);
    for(const reason of Object.values(manifest.omissionReasons))assert.match(reason,/^[a-z][a-z_]*$/);
    assert.equal(manifest.omissionReasons.connection_consent_metadata,'export_qualification_covers_measures_only');
    assert.equal(manifest.omissionReasons.suggestion_records,'export_qualification_covers_measures_only');
    assert.equal(manifest.omissionReasons.measure_tombstones,'deleted_records_not_exported');
    assert.deepEqual([...new Set(sink.output.map(item=>item.value.kind))].sort(),qualify?['manifest','measure']:['manifest']);
    assert.equal(result.status,qualify?'complete':'unavailable');
    if(qualify)assert.deepEqual(exportedIds(sink.output),['day']);
    const text=JSON.stringify(sink.output);
    for(const hidden of ['consent-marker','consentVersion','retentionConsent','lastImportAt','"types"','"connected"','suggestion-marker','plan-marker','review-marker','reason-marker',
      'policy-marker','digest-marker','evidenceRefs','private-cursor','"gone"'])assert.equal(text.includes(hidden),false,hidden);
    const keys=[];const walk=value=>{if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){if(!Array.isArray(value))keys.push(key);if(key!=='omissionReasons')walk(child);}};
    walk(sink.output.map(item=>item.value));
    assert.deepEqual(keys.filter(key=>/secret|cipher|access_?token|refresh|password|credential|auth|pkce|callback/i.test(key)),[]);
    for(const item of sink.output.filter(item=>item.value.kind==='measure')){
      assert.equal(item.value.data.aiEligible,false);assert.equal(item.value.data.provenance,'unqualified_import');
    }
    assert.equal(manifest.aiEligible??false,false);
  }
});
