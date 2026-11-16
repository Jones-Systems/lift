import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,a,b,binding,proof,prepareInput,page } from './fixture.mjs';
import { stable } from '../../../src/wearables/validation.ts';

const commandKey=key=>stable(['wearables-command',key]);
test('prepare allocates a nonimportable pending generation with private original-session metadata',t=>{
  const h=fixture(t);assert.deepEqual(h.prepare(),binding);
  const stored=h.store.connection(a,'direct');assert.equal(stored.connected,false);assert.equal(stored.retentionConsent,true);
  assert.deepEqual(stored.pendingAuthorization,{sessionId:a.sessionId,epoch:a.epoch});
  const receipt=h.store.receipt(a,commandKey('prepare'));assert.equal(receipt.purged,undefined);assert.deepEqual(receipt.scope,{connectionId:'direct',generation:1});
  assert.throws(()=>h.service.authorizeImport(a,'oura','direct',1),/health_consent_required/);
  assert.throws(()=>h.service.ingest(a,'import',page({connectionId:'direct'}),{provider:'oura'}),/health_consent_required/);
  assert.throws(()=>h.providerIntent({ctx:a,provider:'oura',connectionId:'direct',generation:1,stream:'steps',cursor:null}).load(),/health_consent_required/);
  assert.equal(h.store.receipt(a,commandKey('import')),null);assert.deepEqual(h.service.coachInputs(a),[]);
});
test('public connection responses and lifecycle export exclude pending operational metadata',t=>{
  const h=fixture(t);h.prepare();
  const publicValue=h.service.connections(a).find(c=>c.id==='direct');assert.equal('pendingAuthorization' in publicValue,false);
  assert.equal(JSON.stringify(publicValue).includes(a.sessionId),false);
  h.deps.qualifyExport=()=>true;const exported=[];
  h.adapter.export(a,{snapshotAtMs:1,append:(category,value)=>exported.push({category,value})});
  assert.equal(JSON.stringify(exported).includes('pendingAuthorization'),false);assert.equal(JSON.stringify(exported).includes(a.sessionId),false);
});
test('prepare receipt replays its exact binding and changed consent or key scope cannot replace it',t=>{
  const h=fixture(t);h.prepare();const before=h.store.connection(a,'direct');
  assert.deepEqual(h.prepare(),binding);assert.deepEqual(h.store.connection(a,'direct'),before);
  assert.throws(()=>h.prepare({...prepareInput(),types:['sleep_asleep']}),/health_key_reuse/);
  assert.throws(()=>h.prepare({...prepareInput(),expectedGeneration:1},'different'),/health_authorization_pending/);
  assert.equal(h.store.connection(a,'direct').generation,1);
});
test('prepare requires explicit retention metrics consent and expected generation before persistence',t=>{
  for(const patch of [{retentionConsent:false},{types:[]},{types:['invented']},{consentVersion:''},{expectedGeneration:undefined},{provider:'healthkit'},{provider:'google'},{expectedGeneration:0}]){
    const h=fixture(t);assert.throws(()=>h.prepare({...prepareInput(),...patch}));
    assert.equal(h.store.connection(a,'direct'),null);assert.equal(h.store.receipt(a,commandKey('prepare')),null);
  }
});
test('no-save currentness and account isolation gate preparation',t=>{
  const h=fixture(t);h.setPermitted(false);assert.throws(()=>h.prepare(),/no_save_or_consent/);assert.equal(h.store.connection(a,'direct'),null);
  h.setPermitted(true);h.prepare();assert.equal(h.store.connection(b,'direct'),null);
  assert.throws(()=>h.prepare(prepareInput(),'prepare',{...a,sessionId:b.sessionId}));
  assert.throws(()=>h.prepare(prepareInput(),'prepare',{...a,epoch:1}));
  assert.deepEqual(h.prepare(prepareInput(),'prepare',b),binding);
});
test('pending prepare receipt is retained only for its generation and original session epoch',t=>{
  const h=fixture(t);h.prepare();const second={...a,sessionId:'second-session'};
  h.db.prepare('INSERT INTO session VALUES(?,?,?)').run(second.sessionId,second.authUserId,Date.now()+3600000);
  const value={fingerprint:'synthetic',scope:{connectionId:'direct',generation:1},result:{minimal:true}};
  h.write(second,()=>h.store.putReceipt(second,'other-session',value));assert.equal(h.store.receipt(second,'other-session').purged,true);
  h.write(a,()=>h.store.putReceipt(a,'other-generation',{...value,scope:{connectionId:'direct',generation:0}}));assert.equal(h.store.receipt(a,'other-generation').purged,true);
  h.db.prepare('UPDATE account_lifecycle SET epoch=1 WHERE account_id=?').run(a.accountId);
  const newer={...a,epoch:1};h.write(newer,()=>h.store.putReceipt(newer,'other-epoch',value));assert.equal(h.store.receipt(newer,'other-epoch').purged,true);
});
test('initial activation requires original pending session even if the supplied proof guard is too permissive',t=>{
  const h=fixture(t);h.prepare();const second={...a,sessionId:'second-session'};
  h.db.prepare('INSERT INTO session VALUES(?,?,?)').run(second.sessionId,second.authUserId,Date.now()+3600000);
  h.root.assertProviderCommittedWithinWrite=()=>{};
  assert.throws(()=>h.write(second,()=>h.activate('activate',binding,proof,second)),/health_authorization_changed/);
  assert.equal(h.store.connection(a,'direct').connected,false);
});
test('activation requires a configured guard and a real committed proof behind its metadata',t=>{
  const h=fixture(t);h.prepare();
  assert.throws(()=>h.write(a,()=>h.activate()),/committed_code_proof_required/);
  delete h.root.assertProviderCommittedWithinWrite;
  assert.throws(()=>h.write(a,()=>h.activate()),/health_provider_activation_unavailable/);
  assert.equal(h.store.connection(a,'direct').connected,false);assert.equal(h.store.receipt(a,commandKey('activate')),null);
});
test('activation uses the existing canonical writer and never opens its own transaction',t=>{
  const h=fixture(t);h.prepare();h.write(a,()=>h.commit());
  assert.throws(()=>h.activate(),/writer_required/);
  assert.throws(()=>h.db.transaction(()=>h.activate()).immediate(),/writer_witness_required/);
  h.root.withActiveWrite=()=>{throw Error('nested_writer_forbidden');};
  assert.deepEqual(h.write(a,()=>h.activate()),binding);
  const stored=h.store.connection(a,'direct');assert.equal(stored.connected,true);assert.equal('pendingAuthorization' in stored,false);
  assert.doesNotThrow(()=>h.service.authorizeImport(a,'oura','direct',1));
});
test('vault metadata activation and receipt share one successful rollback boundary',t=>{
  const h=fixture(t);h.prepare();
  assert.deepEqual(h.write(a,()=>{h.commit();return h.activate();}),binding);
  assert.equal(h.authCount(),1);assert.equal(h.store.connection(a,'direct').connected,true);
  assert.deepEqual(h.store.receipt(a,commandKey('activate')).result,binding);
  assert.deepEqual(h.prepare(),binding);
});
test('receipt write failure rolls back vault commit and activation together',t=>{
  const h=fixture(t);h.prepare();const put=h.store.putReceipt;
  h.store.putReceipt=(ctx,key,value)=>{put(ctx,key,value);if(key===commandKey('activate'))throw Error('synthetic_receipt_failure');};
  assert.throws(()=>h.write(a,()=>{h.commit();h.activate();}),/synthetic_receipt_failure/);
  assert.equal(h.authCount(),0);assert.equal(h.store.connection(a,'direct').connected,false);assert.equal(h.store.receipt(a,commandKey('activate')),null);
});
test('post-write proof guard failure rolls back every effect',t=>{
  const h=fixture(t);h.prepare();const guard=h.root.assertProviderCommittedWithinWrite;let checks=0;
  h.root.assertProviderCommittedWithinWrite=(...args)=>{guard(...args);if(++checks===3)throw Error('late_scope_loss');};
  assert.throws(()=>h.write(a,()=>{h.commit();h.activate();}),/late_scope_loss/);
  assert.equal(h.authCount(),0);assert.equal(h.store.connection(a,'direct').connected,false);assert.equal(h.store.receipt(a,commandKey('activate')),null);
});
test('scope and committed-code qualification reject forged mismatched suppressed and uncommitted evidence',t=>{
  for(const [column,value] of [['session_id','other'],['epoch',1],['provider','garmin'],['connection_id','other'],['generation',2],['kind','refresh'],['committed',0],['suppressed',1],['receipt_version',2],['live_version',0]]){
    const h=fixture(t);h.prepare();h.write(a,()=>{h.commit();h.db.prepare(`UPDATE synthetic_committed_auth SET ${column}=?`).run(value);});
    assert.throws(()=>h.write(a,()=>h.activate()),/committed_code_proof_required/);assert.equal(h.store.connection(a,'direct').connected,false);
  }
});
test('connection provider generation and original currentness remain independently checked',t=>{
  const h=fixture(t);h.prepare();h.root.assertProviderCommittedWithinWrite=()=>{};
  assert.throws(()=>h.write(a,()=>h.activate('activate',{...binding,provider:'garmin'})),/health_route_mismatch/);
  assert.throws(()=>h.write(a,()=>h.activate('activate',{...binding,generation:2})),/health_connection_changed/);
  assert.throws(()=>h.write(b,()=>h.activate('activate',binding,proof,b)),/health_not_found/);
  assert.throws(()=>h.write({...a,epoch:1},()=>h.activate('activate',binding,proof,{...a,epoch:1})));
  h.setPermitted(false);assert.throws(()=>h.write(a,()=>h.activate()),/no_save_or_consent/);
});
test('same activation receipt replays after rotation only while original committed proof stays qualified',t=>{
  const h=fixture(t);h.prepare();h.write(a,()=>{h.commit();h.activate();});
  const before=h.store.receipt(a,commandKey('activate'));
  h.db.prepare('UPDATE synthetic_committed_auth SET live_version=3').run();
  assert.deepEqual(h.write(a,()=>h.activate()),binding);assert.deepEqual(h.store.receipt(a,commandKey('activate')),before);
  assert.throws(()=>h.write(a,()=>h.activate('different-key')),/health_already_connected/);
  assert.throws(()=>h.write(a,()=>h.activate('activate',binding,{...proof,version:3})),/committed_code_proof_required/);
  h.db.prepare('UPDATE synthetic_committed_auth SET suppressed=1').run();assert.throws(()=>h.write(a,()=>h.activate()),/committed_code_proof_required/);
});
test('activation receipt keys cannot be reused for another original operation',t=>{
  const h=fixture(t);h.prepare();h.write(a,()=>{h.commit();h.activate();h.commit(a,binding,{operationId:'other-code',version:1});});
  assert.throws(()=>h.write(a,()=>h.activate('activate',binding,{operationId:'other-code',version:1})),/health_key_reuse/);
});
test('pending cancellation clears metadata and tombstones receipts through the disconnect fence',t=>{
  const h=fixture(t),fences=[];h.deps.externalConnectionPurge=(ctx,scope)=>{fences.push({ctx,scope});return {status:'complete'};};
  h.prepare();assert.equal(h.service.disconnect(a,'disconnect',{connectionId:'direct',generation:1}).purged,true);
  const stored=h.store.connection(a,'direct');assert.equal(stored.generation,2);assert.equal(stored.connected,false);assert.equal(stored.retentionConsent,false);
  assert.equal('pendingAuthorization' in stored,false);assert.equal(h.store.receipt(a,commandKey('prepare')).purged,true);
  assert.equal(h.store.receipt(a,commandKey('disconnect')).purged,true);assert.deepEqual(fences[0].scope,{connectionId:'direct',generation:2});
  assert.throws(()=>h.prepare(),/health_receipt_purged/);
  assert.deepEqual(h.prepare({...prepareInput(),expectedGeneration:2},'reconnect'),{...binding,generation:3});
});
test('disconnect prevents old activation replay from resurrecting a retired or replacement generation',t=>{
  const h=fixture(t);h.prepare();h.write(a,()=>{h.commit();h.activate();});
  h.service.disconnect(a,'disconnect',{connectionId:'direct',generation:1});
  assert.equal(h.store.receipt(a,commandKey('activate')).purged,true);
  assert.throws(()=>h.write(a,()=>h.activate()),/health_connection_changed/);
  h.prepare({...prepareInput(),expectedGeneration:2},'reconnect');assert.throws(()=>h.write(a,()=>h.activate()),/health_connection_changed/);
  assert.equal(h.store.connection(a,'direct').connected,false);
});
test('unknown external purge rolls back pending cancellation and preserves its generation',t=>{
  const h=fixture(t);h.prepare();h.deps.externalConnectionPurge=()=>({status:'unknown'});
  assert.throws(()=>h.service.disconnect(a,'disconnect',{connectionId:'direct',generation:1}),/health_external_connection_purge_unknown/);
  assert.equal(h.store.connection(a,'direct').generation,1);assert.deepEqual(h.store.connection(a,'direct').pendingAuthorization,{sessionId:a.sessionId,epoch:a.epoch});
  assert.equal(h.store.receipt(a,commandKey('prepare')).purged,undefined);
});
test('Garmin preparation is structurally supported without claiming private payload or import qualification',t=>{
  const h=fixture(t);assert.deepEqual(h.prepare({...prepareInput(),provider:'garmin'}),{...binding,provider:'garmin'});
  assert.throws(()=>h.service.authorizeImport(a,'garmin','direct',1),/health_consent_required/);
});
test('existing HealthKit connect and disconnect behavior is preserved',t=>{
  const h=fixture(t),value={connectionId:'new-hk',types:['steps'],consentVersion:'synthetic',retentionConsent:true};
  const connected=h.service.connectHealthKit(a,'hk-connect',value);assert.equal(connected.connected,true);assert.equal('pendingAuthorization' in connected,false);
  assert.deepEqual(h.service.connectHealthKit(a,'hk-connect',value),connected);
  assert.equal(h.service.disconnect(a,'hk-disconnect',{connectionId:'new-hk',generation:1}).purged,true);
  assert.equal(h.store.receipt(a,commandKey('hk-connect')).purged,true);
});
