import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,a,b,connection,page } from './fixture.mjs';
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
