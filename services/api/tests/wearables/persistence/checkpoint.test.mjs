import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,a,b,connection,page } from './fixture.mjs';

const binding=()=>({ctx:{...a},connectionId:'hk',generation:1,type:'steps',from:'2026-10-09T00:00:00Z',to:'2026-10-10T00:00:00Z'});
const stream=input=>JSON.stringify(['healthkit-v1',input.type,input.from,input.to]);
const changes=db=>db.prepare('SELECT total_changes() AS n').get().n;
function committed(h,input=binding()) {
  h.service.ingest(input.ctx,'committed-page',page({stream:stream(input)}));
}

test('checkpoint reads only the canonical committed cursor and never writes',t=>{
  const h=fixture(t),input=binding(),reader=h.healthKitCheckpoint(input);
  let before=changes(h.db);
  assert.deepEqual(reader.read(),{stream:stream(input),cursor:null});assert.equal(changes(h.db),before);
  assert.throws(()=>h.write(a,()=>{committed(h);throw Error('rollback');}),/rollback/);
  assert.equal(reader.read().cursor,null);
  committed(h);before=changes(h.db);
  assert.deepEqual(reader.read(),{stream:stream(input),cursor:'private-cursor'});assert.equal(changes(h.db),before);
});
test('checkpoint preserves exact type, window spelling, account and captured binding',t=>{
  const h=fixture(t),input=binding(),reader=h.healthKitCheckpoint(input);committed(h);
  input.ctx.accountId='b';input.ctx.sessionId='session-b';input.type='bodyMass';input.from='2026-10-08T00:00:00Z';
  assert.equal(reader.read().cursor,'private-cursor');
  assert.equal(h.healthKitCheckpoint({...binding(),ctx:b}).read().cursor,null);
  assert.equal(h.healthKitCheckpoint({...binding(),from:'2026-10-09T00:00:00+00:00'}).read().cursor,null);
  assert.equal(h.healthKitCheckpoint({...binding(),to:'2026-10-11T00:00:00Z'}).read().cursor,null);
  h.write(a,()=>h.store.putConnection(a,{...connection,types:['steps','body_mass']}));
  assert.equal(h.healthKitCheckpoint({...binding(),type:'bodyMass'}).read().cursor,null);
});
test('policy denial, disconnected state and revoked retention never become empty checkpoints',t=>{
  const h=fixture(t),reader=h.healthKitCheckpoint(binding());committed(h);
  h.setPermitted(false);assert.throws(()=>reader.read(),/no_save_or_consent/);h.setPermitted(true);
  h.write(a,()=>h.store.putConnection(a,{...connection,retentionConsent:false}));assert.throws(()=>reader.read(),/health_consent_required/);
  h.write(a,()=>h.store.putConnection(a,{...connection,connected:false}));assert.throws(()=>reader.read(),/health_consent_required/);
});
test('wrong provider, changed generation and missing connection reject checkpoint access',t=>{
  const h=fixture(t);
  h.write(a,()=>h.store.putConnection(a,{...connection,id:'oura',provider:'oura'}));
  assert.throws(()=>h.healthKitCheckpoint({...binding(),connectionId:'oura'}).read(),/health_route_mismatch/);
  assert.throws(()=>h.healthKitCheckpoint({...binding(),generation:2}).read(),/health_connection_changed/);
  assert.throws(()=>h.healthKitCheckpoint({...binding(),connectionId:'missing'}).read(),/health_not_found/);
  const reader=h.healthKitCheckpoint(binding());
  h.service.disconnect(a,'disconnect',{connectionId:'hk',generation:1});
  h.service.connectHealthKit(a,'reconnect',{connectionId:'hk',types:['steps'],consentVersion:'synthetic',retentionConsent:true});
  assert.throws(()=>reader.read(),/health_connection_changed/);
});
test('all emitted metrics require consent for every native type',t=>{
  const h=fixture(t);
  const required={steps:['steps'],activeEnergy:['active_energy'],restingHeartRate:['resting_hr'],hrvSdnn:['hrv_sdnn'],
    sleep:['sleep_asleep','sleep_in_bed'],bodyMass:['body_mass'],workouts:['workout_duration','workout_energy','workout_distance']};
  for(const [type,metrics] of Object.entries(required)){
    const reader=h.healthKitCheckpoint({...binding(),type});
    for(const omitted of metrics){
      h.write(a,()=>h.store.putConnection(a,{...connection,types:metrics.filter(metric=>metric!==omitted)}));
      assert.throws(()=>reader.read(),/health_type_not_consented/);
    }
    h.write(a,()=>h.store.putConnection(a,{...connection,types:metrics}));assert.equal(reader.read().cursor,null);
  }
});
test('checkpoint remains bound to its original live session and lifecycle epoch',t=>{
  const h=fixture(t),reader=h.healthKitCheckpoint(binding());committed(h);
  assert.throws(()=>h.healthKitCheckpoint({...binding(),ctx:{...a,epoch:1}}).read(),/account_epoch_changed/);
  assert.throws(()=>h.healthKitCheckpoint({...binding(),ctx:{...a,accountId:'b'}}).read(),/account_session_invalid/);
  h.db.prepare('DELETE FROM session WHERE id=?').run(a.sessionId);
  h.db.prepare('INSERT INTO session VALUES(?,?,?)').run('new-session',a.authUserId,Date.now()+3600000);
  assert.throws(()=>reader.read(),/account_session_invalid/);
  const current=h.healthKitCheckpoint({...binding(),ctx:{...a,sessionId:'new-session'}});
  assert.equal(current.read().cursor,'private-cursor');
  h.disable(a);assert.throws(()=>current.read(),/account_disabled/);
});
test('post-read policy, metric consent, generation and session changes prevent cursor return',t=>{
  for(const revoke of ['policy','metrics','generation','session']){
    const h=fixture(t),reader=h.healthKitCheckpoint(binding());committed(h);
    const cursor=h.store.cursor;
    h.store.cursor=(...args)=>{
      const result=cursor(...args);
      if(revoke==='policy')h.setPermitted(false);
      if(revoke==='metrics')h.write(a,()=>h.store.putConnection(a,{...connection,types:[]}));
      if(revoke==='generation')h.write(a,()=>h.store.putConnection(a,{...connection,generation:2}));
      if(revoke==='session')h.db.prepare('DELETE FROM session WHERE id=?').run(a.sessionId);
      return result;
    };
    assert.throws(()=>reader.read(),/no_save_or_consent|health_type_not_consented|health_connection_changed|account_session_invalid/);
  }
});
test('invalid binding and unreadable storage reject rather than returning a null cursor',t=>{
  const h=fixture(t);
  for(const invalid of [{type:'hrvRmssd'},{generation:-1},{from:'yesterday'},{from:'2026-10-11T00:00:00Z'}])
    assert.throws(()=>h.healthKitCheckpoint({...binding(),...invalid}).read());
  h.store.cursor=()=>{throw Error('cursor_unreadable');};
  assert.throws(()=>h.healthKitCheckpoint(binding()).read(),/cursor_unreadable/);
});
