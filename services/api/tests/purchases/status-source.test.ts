import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { A, B, apple, owner, source27Fixture,deferred, upgrade27, configuration } from './status-source-fixture.js';
import { ApplePurchaseService } from '../../src/purchases/service.js';
import { createSourceAppleSubscriptionStatus } from '../../src/purchases/status-source.js';
import { readSourceSubscriptionStatusContinuity,consumeSourceSubscriptionStatusContinuity,
  bindSourceSubscriptionStatusContinuityWitness,readSourceActionContinuity } from '../../src/lifecycle/reauthentication-proof.js';
import { bindSourceLifecycleCurrentness } from '../../src/lifecycle/evidence-store.js';
import { openSourceSubscriptionStatusStorage,selectSourceSubscriptionStatusMigrations } from '../../src/purchases/status-source-migrations.js';
import { openStorage, hash } from '../../src/storage.js';
import { source26Fixture } from '../lifecycle-reauthentication-fixture.js';
import { evidenceCanonical } from '../../src/lifecycle/evidence-codec.js';
const count=(db:ReturnType<typeof source26Fixture>['db'],table:string)=>(db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n;

// These checks use native files and independent suppression, never an always-true admission guard.
test('actual reader -> captured verifier -> real ledger/grant; durable dispatch precedes HTTP, exact replay preserves freshness',async t=>{
  const f=await source27Fixture(t),{source}=f.compose(),facade=source.forOwner(A);
  f.before('status-transport',()=>{assert.equal(f.base.db.inTransaction,false);assert.equal(count(f.base.db,'apple_purchase_status_observations'),1);
    const r=f.base.db.prepare('SELECT * FROM apple_purchase_status_projection').get() as {active_request_id:string;revision:number};assert.equal(r.revision,1);assert.match(r.active_request_id,/^[a-f0-9]{64}$/);});
  const result=await facade.refreshStatus('10000','first');assert.equal(result.status,'observed');assert.equal(result.revision,2);
  assert.equal(count(f.base.db,'apple_purchase_grants'),1);assert.deepEqual(facade.entitlements().active,['form_plus']);
  assert.equal(count(f.base.db,'apple_purchase_deliveries'),0);assert.equal(count(f.base.db,'apple_purchase_commands'),0);
  const bytes=f.base.db.prepare('SELECT * FROM apple_purchase_status_observations ORDER BY observation_id').all();
  const calls=f.calls();f.base.advance(5000);assert.deepEqual(await facade.refreshStatus('10000','first'),result);assert.equal(f.calls(),calls);
  assert.deepEqual(f.base.db.prepare('SELECT * FROM apple_purchase_status_observations ORDER BY observation_id').all(),bytes);
  f.base.advance(295000);assert.deepEqual(facade.entitlements().active,[],'cutoff equality denies');
  const serialized=JSON.stringify(bytes);assert.equal(serialized.includes('synthetic.'),false);assert.equal(serialized.includes('exactJws'),false);
});

test('expired signed subscription obtains real grace grant only through one-use observation permit; default service rejects expiry',async t=>{
  const f=await source27Fixture(t);const tx=f.tx({expiresDate:f.base.now()-1000});
  f.response(f.envelope([f.item(4,tx,f.rn({gracePeriodExpiresDate:f.base.now()+100000}))]));
  const {source}=f.compose(),facade=source.forOwner(A);const result=await facade.refreshStatus('10000','grace');assert.equal(result.status,'observed');
  assert.equal(count(f.base.db,'apple_purchase_grants'),1);const grants=facade.entitlements();assert.deepEqual(grants.active,['form_plus']);
  assert.equal(grants.grants[0]!.expiresAt,new Date(f.base.now()+100000).toISOString());
  assert.equal((f.base.db.prepare('SELECT expires_date_ms FROM apple_purchase_transactions WHERE transaction_id=?').get(tx.transactionId) as {expires_date_ms:number}).expires_date_ms,tx.expiresDate);
  const ordinary=new ApplePurchaseService(f.base.db,apple,f.verifier,f.base.now);
  const jws=f.signedTransaction(tx);const rejection=await ordinary.deliver(A.accountId,{transactionId:tx.transactionId,productId:tx.productId,jwsRepresentation:jws,idempotencyKey:'default-expired'},A);
  assert.deepEqual(rejection,{status:'rejected',code:'apple_expired'});assert.equal(count(f.base.db,'apple_purchase_deliveries'),0);
});

test('native selected27 snapshots require exact object, live transaction, same handle and one use; old26 cannot consume27',async t=>{
  const f=await source27Fixture(t),c=f.compose(),db=f.base.db;
  const seal=readSourceSubscriptionStatusContinuity(db,c.continuity,f.base.now());
  assert.throws(()=>consumeSourceSubscriptionStatusContinuity(db,c.continuity,seal,f.base.now()));
  for(const copy of [{...seal},JSON.parse(JSON.stringify(seal)),{}])assert.throws(()=>db.transaction(()=>consumeSourceSubscriptionStatusContinuity(db,c.continuity,copy,f.base.now()))());
  assert.throws(()=>bindSourceSubscriptionStatusContinuityWitness(db,c.witness,{recordPath:f.base.recordPath}));
  assert.throws(()=>bindSourceLifecycleCurrentness(db,c.witness,'selected-action-reauthentication-26'));
  assert.throws(()=>readSourceActionContinuity(db,c.continuity as never,f.base.now()));
  assert.throws(()=>db.transaction(()=>{consumeSourceSubscriptionStatusContinuity(db,c.continuity,seal,f.base.now());throw new Error('rollback');})());
  assert.throws(()=>db.transaction(()=>consumeSourceSubscriptionStatusContinuity(db,c.continuity,seal,f.base.now()))());
  const next=readSourceSubscriptionStatusContinuity(db,c.continuity,f.base.now(),seal);
  db.transaction(()=>consumeSourceSubscriptionStatusContinuity(db,c.continuity,next,f.base.now()))();
  const other=f.base.openOther(),otherSource=f.compose(other);
  const foreign=readSourceSubscriptionStatusContinuity(other,otherSource.continuity,f.base.now());
  assert.throws(()=>db.transaction(()=>consumeSourceSubscriptionStatusContinuity(db,c.continuity,foreign,f.base.now()))());
});

test('genuine26 to27 retains budget-only counters, exact receipts, SQL and complete27 data reopen; old selectors refuse',async t=>{
  const f=await source27Fixture(t,false),db=f.base.db;
  db.prepare('INSERT INTO account_action_challenge_budgets VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(A.accountId,A.authUserId,1,1,f.base.now(),2,f.base.now(),1,f.base.now(),1,f.base.now());
  const budget=db.prepare('SELECT * FROM account_action_challenge_budgets').all(),history=db.prepare('SELECT * FROM form_migrations').all();
  await upgrade27(db,f.base.path);assert.deepEqual(db.prepare('SELECT * FROM account_action_challenge_budgets').all(),budget);
  assert.deepEqual(db.prepare('SELECT * FROM form_migrations WHERE version<=26').all(),history);
  const {source}=f.compose();assert.equal((await source.forOwner(A).refreshStatus('10000','reopen')).status,'observed');
  f.barrier();f.base.closeMain();const opened=await openSourceSubscriptionStatusStorage(f.base.path,configuration);f.base.adopt(opened.db);
  assert.deepEqual(f.compose().source.forOwner(A).entitlements().active,['form_plus']);
  await assert.rejects(()=>openStorage(f.base.path));
  assert.equal(count(f.base.db,'form_migrations'),27);
  assert.deepEqual(f.base.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(),selectSourceSubscriptionStatusMigrations().map(m=>({version:m.version,checksum:hash(m.sql)})));
});

test('real fresh full1-27 admission validates selection before creating paths',async t=>{
  const f=await source27Fixture(t),path=f.base.root+'/fresh/main.sqlite';
  const opened=await openSourceSubscriptionStatusStorage(path,configuration);try {assert.equal(count(opened.db,'form_migrations'),27);} finally {opened.db.close();}
  await assert.rejects(()=>openSourceSubscriptionStatusStorage(f.base.root+'/invalid/main.sqlite',{...configuration,extra:true} as never));
});

test('pending27 refuses every old challenge/proof state and unreceipted reconciliation objects, before backup',async t=>{
  const f=await source27Fixture(t,false),db=f.base.db;
  // An actual Source26 ceremony creates durable challenge authority; even rejected/expired is an upgrade blocker.
  const issued=await f.base.source.issueChallenge(A,{purpose:'account_delete',method:'email_action_code',requestKey:'migration-blocker'});
  void issued;
  assert.ok(count(db,'account_action_challenges')>0);
  await assert.rejects(()=>upgrade27(db,f.base.path));assert.equal(count(db,'form_migrations'),26);
});

test('one unresolved claim/account spans two handles and sessions/lineages, changed logical intent conflicts without HTTP',async t=>{
  const f=await source27Fixture(t),one=f.compose(),other=f.base.openOther(),two=f.compose(other);
  const resume=f.pause('status-transport'),pending=one.source.forOwner(A).refreshStatus('10000','held');
  await new Promise<void>(resolve=>setImmediate(resolve));
  const calls=f.calls();await assert.rejects(()=>two.source.forOwner(A).refreshStatus('10000','other'));assert.equal(f.calls(),calls);
  const replay=await two.source.forOwner(A).refreshStatus('10000','held');assert.equal(replay.status,'unknown');assert.equal(f.calls(),calls);
  const original='20000';f.seed(other,{...owner,originalTransactionId:original},f.tx({transactionId:'20001',originalTransactionId:original}));
  await assert.rejects(()=>two.source.forOwner(A).refreshStatus(original,'held'));assert.equal(f.calls(),calls);
  resume();assert.equal((await pending).status,'observed');
});

test('original result completion without resource settlement retains claim; explicit no-provider reconciliation uses original handles only',async t=>{
  const f=await source27Fixture(t),c=f.compose(),facade=c.source.forOwner(A);f.holdResources('status-transport');
  await assert.rejects(()=>facade.refreshStatus('10000','resources'));const calls=f.calls();assert.throws(()=>facade.reconcileStatusRequest('resources'));
  const bOwner={...owner,accountId:B.accountId,appAccountToken:B.accountId,originalTransactionId:'20000'};
  f.seed(f.base.db,bOwner,f.tx({transactionId:'20001',originalTransactionId:'20000',appAccountToken:B.accountId}));
  await assert.rejects(()=>c.source.forOwner(B).refreshStatus('20000','other-account'));assert.equal(f.calls(),calls);
  const other=f.base.openOther();assert.throws(()=>f.compose(other).source.forOwner(A).reconcileStatusRequest('resources'));
  f.finishResources();const result=facade.reconcileStatusRequest('resources');assert.equal(result.status,'unknown');assert.equal(f.calls(),calls);
  assert.equal((f.base.db.prepare('SELECT active_request_id FROM apple_purchase_status_projection').get() as {active_request_id:null}).active_request_id,null);
  assert.equal(count(f.base.db,'apple_purchase_grants'),0);
});


for(const drift of ['principal','native-currentness'] as const)test(`fenced fully settled no-provider reconciliation retains ${drift} guard`,async t=>{
  const f=await source27Fixture(t),source=f.compose().source,facade=source.forOwner(A),db=f.base.db;
  f.holdResources('status-transport');await assert.rejects(()=>facade.refreshStatus('10000','guarded-settlement'));
  assert.throws(()=>facade.reconcileStatusRequest('guarded-settlement'),'closed admission still requires resources to settle');
  f.finishResources();f.barrier();
  const rows=db.prepare('SELECT * FROM apple_purchase_status_observations').all(),claim=db.prepare('SELECT * FROM apple_purchase_status_projection').get(),calls=f.calls();
  if(drift==='principal'){
    assert.throws(()=>source.forOwner(B).reconcileStatusRequest('guarded-settlement'));
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)').run('reconcile-session',f.base.now()+86400000,'reconcile-session-token',f.base.now(),f.base.now(),A.authUserId);
    assert.throws(()=>source.forOwner({...A,sessionId:'reconcile-session'}).reconcileStatusRequest('guarded-settlement'));
  } else {
    f.writeNative({...f.nativeRecord(),databaseGeneration:'different-generation',revision:2});
    assert.throws(()=>facade.reconcileStatusRequest('guarded-settlement'));
  }
  assert.deepEqual(db.prepare('SELECT * FROM apple_purchase_status_observations').all(),rows);
  assert.deepEqual(db.prepare('SELECT * FROM apple_purchase_status_projection').get(),claim);
  assert.equal(f.calls(),calls);assert.equal(count(db,'apple_purchase_grants'),0);
  if(drift==='principal'){
    assert.equal(facade.reconcileStatusRequest('guarded-settlement').status,'unknown');assert.equal(f.calls(),calls);
    assert.equal((db.prepare('SELECT active_request_id FROM apple_purchase_status_projection').get() as {active_request_id:null}).active_request_id,null);
  }
});

test('live unfenced transport completion cannot reconcile away account exclusion before original verifier admission',async t=>{
  const f=await source27Fixture(t),facade=f.compose().source.forOwner(A),other=f.compose(f.base.openOther()).source.forOwner(A);
  f.response(f.envelope([f.item(2,f.tx({expiresDate:f.base.now()-1}))]));
  const resumeTransport=f.pause('status-transport'),resumeVerifier=f.pause('transaction-verifier');
  const verifierStarted=deferred<void>();f.before('transaction-verifier',()=>verifierStarted.resolve());
  const db=f.base.db,rows=()=>db.prepare('SELECT * FROM apple_purchase_status_observations ORDER BY observation_id').all();
  const claim=()=>db.prepare('SELECT * FROM apple_purchase_status_projection').get();
  const original=facade.refreshStatus('10000','completion-gap');
  const originalResult=original.then(value=>({value,error:null}),error=>({value:null,error}));
  const dispatchedRows=rows(),dispatchedClaim=claim(),started=f.base.now();
  let reconciliationRejected=false,secondRejected=false;
  let secondResult:Promise<unknown>|undefined,resumeSecond=()=>{};
  let gapStates:ReturnType<typeof f.producerStates>=[],overlapStates:ReturnType<typeof f.producerStates>=[];
  let gapRows:unknown,gapClaim:unknown;
  f.afterCompletionOnce('status-transport',()=>{
    f.base.advance(5000);gapStates=f.producerStates();
    try {facade.reconcileStatusRequest('completion-gap');} catch {reconciliationRejected=true;}
    gapRows=rows();gapClaim=claim();
    // The second real transport, if incorrectly admitted, remains live while
    // the original verifier is held. Neither request can create a grant.
    f.response(f.envelope([]));resumeSecond=f.pause('status-transport');
    secondResult=other.refreshStatus('10000','completion-gap-second').then(()=>{},()=>{secondRejected=true;});
  });
  resumeTransport();
  let outcome:Awaited<typeof originalResult>;
  try {
    await verifierStarted.promise;
    await new Promise<void>(resolve=>setImmediate(resolve));
    overlapStates=f.producerStates();
  } finally {
    resumeVerifier();resumeSecond();
    outcome=await originalResult;await secondResult;
    f.barrier();
    t.diagnostic(JSON.stringify({gapStates,overlapStates,reconciliationRejected,secondRejected,
      originalObserved:outcome.value?.status==='observed',grants:count(db,'apple_purchase_grants'),
      finalRows:rows().length,finalClaim:claim(),settled:f.producerStates()}));
  }
  assert.ok(f.base.now()-started>=5000&&f.base.now()-started<9500,'independent owner clock is in the dispatch-to-fence gap');
  assert.deepEqual(gapStates.map(p=>[p.kind,p.completed,p.resourcesEnded]),[['status-transport',true,true]],'actual original transport and resources have settled before any verifier starts');
  assert.equal(reconciliationRejected,true,'unfenced original must retain its durable claim');
  assert.deepEqual(gapRows,dispatchedRows,'no terminal SQL during the live completion gap');
  assert.deepEqual(gapClaim,dispatchedClaim,'account exclusion and revision survive reconciliation');
  assert.equal(secondRejected,true,'second native handle cannot overlap original verifier work');
  assert.deepEqual(overlapStates.map(p=>p.kind),['status-transport','transaction-verifier']);
  assert.equal(overlapStates[1]?.resourcesEnded,false,'original verifier resources are actually held');
  assert.equal(outcome!.value?.status,'observed','original unfenced request may complete normally');
  assert.equal(count(db,'apple_purchase_grants'),0,'expired evidence creates no grant');
  const finalRows=rows(),finalClaim=claim();
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.deepEqual(rows(),finalRows,'settled original continuations perform no late SQL');assert.deepEqual(claim(),finalClaim);
});

test('global background native capture precedes first verifier; mapping loss during proof prevents notification writes',async t=>{
  const f=await source27Fixture(t),c=f.compose();
  const n=f.signedNotification({notificationUUID:randomUUID(),version:'2.0',notificationType:'DID_RENEW',signedDate:f.base.now(),
    data:{bundleId:apple.bundleId,environment:'Sandbox',signedTransactionInfo:f.signedTransaction(f.tx())}});
  f.before('notification-verifier',()=>{f.base.unavailable();});
  await assert.rejects(()=>c.source.ingestNotification(n));assert.equal(count(f.base.db,'apple_purchase_notifications'),0);assert.equal(count(f.base.db,'apple_purchase_grants'),0);
});

for(const kind of ['status-transport','transaction-verifier'] as const)for(const mutation of ['disable','session','expiry','user','epoch','generation','schema','clock'] as const){
  test(`live ${mutation} drift during original ${kind} cannot grant or finalize`,async t=>{
    const f=await source27Fixture(t),c=f.compose(),facade=c.source.forOwner(A),resume=f.pause(kind),pending=facade.refreshStatus('10000',mutation);
    await new Promise<void>(resolve=>setImmediate(resolve));
    const db=f.base.db;
    if(mutation==='disable')f.base.authority.recordDisable({accountId:A.accountId,authUserId:A.authUserId,requestId:randomUUID(),epoch:1,disabledAtMs:f.base.now()});
    if(mutation==='session')db.prepare('DELETE FROM session WHERE id=?').run(A.sessionId);
    if(mutation==='expiry')db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(f.base.now(),A.sessionId);
    if(mutation==='user'){db.pragma('foreign_keys=OFF');db.prepare('DELETE FROM "user" WHERE id=?').run(A.authUserId);db.pragma('foreign_keys=ON');}
    if(mutation==='epoch')db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(A.accountId);
    if(mutation==='generation')f.writeNative({...f.nativeRecord(),databaseGeneration:'different-generation',revision:2});
    if(mutation==='schema')db.exec('CREATE TABLE unexpected_source27(x INTEGER)');
    if(mutation==='clock')f.base.advance(10001);
    resume();await assert.rejects(()=>pending);assert.equal(count(db,'apple_purchase_grants'),0);assert.equal(count(db,'apple_purchase_status_observations'),1);
  });
}

for(const collision of ['view','foreign-index','foreign-trigger','old-reconciliation','extra-owned-object','missing-predecessor','bad-history'] as const){
  test(`pending27 rejects ${collision} without manufacturing receipt or adoption`,async t=>{
    const f=await source27Fixture(t,false),db=f.base.db;
    if(collision==='view')db.exec('CREATE VIEW apple_purchase_status_observations AS SELECT 1 value');
    if(collision==='foreign-index')db.exec('CREATE INDEX apple_status_one_dispatch_per_account ON documents(account_id)');
    if(collision==='foreign-trigger')db.exec("CREATE TRIGGER bound_apple_status_projection_update AFTER INSERT ON documents BEGIN SELECT 1; END;");
    if(collision==='old-reconciliation'){const {applePurchaseReconciliationMigrationSql}=await import('../../src/purchases/reconciliation-migration.js');db.exec(applePurchaseReconciliationMigrationSql);}
    if(collision==='extra-owned-object'){db.exec('CREATE TABLE apple_purchase_status_projection(x INTEGER)');db.exec('CREATE INDEX stray_owned ON apple_purchase_status_projection(x)');}
    if(collision==='missing-predecessor')db.exec('DROP TRIGGER action_proof_retained');
    if(collision==='bad-history')db.prepare('UPDATE form_migrations SET checksum=? WHERE version=25').run('0'.repeat(64));
    const before=db.prepare('SELECT * FROM form_migrations').all();await assert.rejects(()=>upgrade27(db,f.base.path));assert.deepEqual(db.prepare('SELECT * FROM form_migrations').all(),before);
    assert.equal(db.prepare('SELECT 1 FROM form_migrations WHERE version=27').get(),undefined);
  });
}

test('post-backup and final-lock pending guards reject a real asynchronous challenge race without receipt27',async t=>{
  const f=await source27Fixture(t,false),db=f.base.db;
  const backup=db.backup.bind(db);let writes=0;
  db.backup=(async(...args:Parameters<typeof db.backup>)=>{
    const result=await backup(...args);writes++;
    await f.base.source.issueChallenge(A,{purpose:'account_delete',method:'email_action_code',requestKey:'after-backup'});
    return result;
  }) as typeof db.backup;
  await assert.rejects(()=>upgrade27(db,f.base.path));assert.equal(writes,1);assert.equal(count(db,'form_migrations'),26);assert.equal(count(db,'account_action_challenges'),1);
});

test('genuine old proof consumption remains an initial-upgrade blocker, including an unused export grant',async t=>{
  const f=await source27Fixture(t,false);
  const c=await f.base.source.issueChallenge(A,{purpose:'account_export',method:'email_action_code',requestKey:'proof-blocker'});
  f.base.source.verifyChallenge(A,{challengeId:c.challengeId,purpose:'account_export',code:f.base.code()});
  assert.equal(count(f.base.db,'account_action_proof_consumptions'),1);
  await assert.rejects(()=>upgrade27(f.base.db,f.base.path));assert.equal(count(f.base.db,'form_migrations'),26);
});

test('same request principal conflicts across real sessions; account spacing and charge survive a new factory',async t=>{
  const f=await source27Fixture(t),c=f.compose(),facade=c.source.forOwner(A);await facade.refreshStatus('10000','one');
  f.base.db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)').run('second-session',f.base.now()+86400000,'second-session-token',f.base.now(),f.base.now(),A.authUserId);
  const second={...A,sessionId:'second-session'},two=f.compose().source.forOwner(second),calls=f.calls();
  await assert.rejects(()=>two.refreshStatus('10000','one'));await assert.rejects(()=>two.refreshStatus('10000','too-soon'));assert.equal(f.calls(),calls);
  f.base.advance(5000);assert.equal((await two.refreshStatus('10000','two')).status,'observed');assert.equal(count(f.base.db,'apple_purchase_grants'),1);
});

for(const fail of ['capture','throw','lost'] as const)test(`original ${fail} custody failure retains charge and cannot reconcile from main rows`,async t=>{
  const f=await source27Fixture(t),facade=f.compose().source.forOwner(A);
  if(fail==='capture')f.captureMissing();if(fail==='throw')f.throwStart('status-transport');if(fail==='lost')f.loseCustody();
  await assert.rejects(()=>facade.refreshStatus('10000',fail));assert.equal(count(f.base.db,'apple_purchase_status_observations'),1);
  f.finishResources();assert.throws(()=>facade.reconcileStatusRequest(fail));assert.equal(count(f.base.db,'apple_purchase_grants'),0);
});

test('actual timeout fences late transport, does not equate cancellation request with settlement, and requires original-handle reconciliation',async t=>{
  const f=await source27Fixture(t),facade=f.compose().source.forOwner(A),resume=f.pause('status-transport');f.cancellation(true);
  const started=performance.now();await assert.rejects(()=>facade.refreshStatus('10000','timeout'));
  assert.ok(performance.now()-started<10500,'10s facade bound plus scheduler observation tolerance');
  assert.equal(count(f.base.db,'apple_purchase_status_observations'),1);assert.throws(()=>facade.reconcileStatusRequest('timeout'));
  resume();await new Promise<void>(resolve=>setImmediate(resolve));f.finishResources();
  const calls=f.calls();assert.equal(facade.reconcileStatusRequest('timeout').status,'unknown');assert.equal(f.calls(),calls);assert.equal(count(f.base.db,'apple_purchase_grants'),0);
});

test('real all-producer quiescent main-copy restore excludes independent custody; new generation denies old authority after an hour',async t=>{
  const f=await source27Fixture(t),c=f.compose(),facade=c.source.forOwner(A);await facade.refreshStatus('10000','before-restore');
  const oldSeal=readSourceSubscriptionStatusContinuity(f.base.db,c.continuity,f.base.now()),snapshot=await f.base.snapshot();f.barrier();f.restore(snapshot);
  const restored=f.compose();assert.deepEqual(restored.source.forOwner(A).entitlements().active,[]);
  assert.throws(()=>f.base.db.transaction(()=>consumeSourceSubscriptionStatusContinuity(f.base.db,restored.continuity,oldSeal,f.base.now()))());
  f.base.advance(3600000);assert.deepEqual(restored.source.forOwner(A).entitlements().active,[]);assert.throws(()=>facade.entitlements());
});

test('unsettled original resource or interrupted copy leaves independent continuity unavailable',async t=>{
  const f=await source27Fixture(t),c=f.compose(),snapshot=await f.base.snapshot();f.holdResources('status-transport');
  await assert.rejects(()=>c.source.forOwner(A).refreshStatus('10000','restore-held'));
  assert.throws(()=>f.restore(snapshot));assert.throws(()=>c.source.forOwner(A).entitlements());
  f.finishResources();assert.throws(()=>f.restore(snapshot,true));assert.throws(()=>f.compose());
});

for(const variant of ['backward-clock','floor','record-revision','native-inode','authority'] as const)test(`native ${variant} currentness is independently enforced`,async t=>{
  const f=await source27Fixture(t),c=f.compose(),facade=c.source.forOwner(A);await facade.refreshStatus('10000','native');
  if(variant==='backward-clock')f.base.advance(-1);
  if(variant==='floor')f.writeNative({...f.nativeRecord(),revision:2,observedAtMs:f.base.now()+1});
  if(variant==='record-revision')f.writeNative({...f.nativeRecord(),revision:0});
  if(variant==='native-inode'){const bytes=readFileSync(f.base.recordPath);renameSync(f.base.recordPath,f.base.recordPath+'.old');writeFileSync(f.base.recordPath,bytes,{mode:0o600});}
  if(variant==='authority'){const w=f.base.witnessFile.read();f.base.witnessFile.replace({...w,authorityId:randomUUID()},'synthetic-foreign-authority');}
  assert.throws(()=>facade.entitlements());assert.equal(count(f.base.db,'apple_purchase_grants'),1,'historical grant remains retained, never authority');
});

test('durable hourly budget counts failures/replays across native handles without another provider dispatch',async t=>{
  const f=await source27Fixture(t),facade=f.compose().source.forOwner(A);await facade.refreshStatus('10000','budget-first');f.base.advance(5000);
  const {parseStatusEvidenceV1,serializeStatusEvidenceV1,statusEvidenceIdV1}=await import('../../src/purchases/status-codec.js');
  const {evidenceDigest}=await import('../../src/lifecycle/evidence-codec.js');
  const template=f.base.db.prepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='dispatch'").get() as Record<string,unknown>;
  const original=JSON.parse(template.evidence_json as string) as Record<string,unknown>;
  const columns=['observation_id','account_id','original_transaction_id','owner_binding_digest','event_kind','event_key','request_id','lifecycle_epoch',
    'database_generation','schema_digest','continuity_digest','binding_json','evidence_json','observed_at_ms'];
  f.base.db.transaction(()=>{
    for(let i=0;i<59;i++){
      const request=evidenceDigest(['synthetic-prior-status-request/v1',i]),e=parseStatusEvidenceV1({...original,requestId:request});
      const row={...template,request_id:request,event_key:evidenceDigest(['source-status-dispatch-event/v1',request]),observation_id:statusEvidenceIdV1(e),evidence_json:serializeStatusEvidenceV1(e)};
      const values:Record<string,unknown>=row;values.content_digest=evidenceDigest(['source-status-row/v1',columns.map(c=>values[c])]);
      const keys=Object.keys(values);f.base.db.prepare(`INSERT INTO apple_purchase_status_observations(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>values[k]));
    }
  })();
  const calls=f.calls(),other=f.base.openOther();await assert.rejects(()=>f.compose(other).source.forOwner(A).refreshStatus('10000','sixty-first'));
  assert.equal(f.calls(),calls);assert.equal(count(f.base.db,'apple_purchase_status_observations'),62);
});

test('completion headroom refuses outbound work BEFORE the account observation cap would strand a terminal frame',async t=>{
  const f=await source27Fixture(t),facade=f.compose().source.forOwner(A);await facade.refreshStatus('10000','capacity-first');f.base.advance(3600000);
  const {parseStatusEvidenceV1,serializeStatusEvidenceV1,statusEvidenceIdV1}=await import('../../src/purchases/status-codec.js');
  const {evidenceDigest}=await import('../../src/lifecycle/evidence-codec.js');
  const template=f.base.db.prepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='dispatch'").get() as Record<string,unknown>;
  const original=JSON.parse(template.evidence_json as string) as Record<string,unknown>;
  const columns=['observation_id','account_id','original_transaction_id','owner_binding_digest','event_kind','event_key','request_id','lifecycle_epoch',
    'database_generation','schema_digest','continuity_digest','binding_json','evidence_json','observed_at_ms'];
  f.base.db.transaction(()=>{
    for(let i=0;i<1019;i++){
      const request=evidenceDigest(['synthetic-historical-capacity/v1',i]),e=parseStatusEvidenceV1({...original,requestId:request});
      const values:Record<string,unknown>={...template,request_id:request,event_key:evidenceDigest(['source-status-dispatch-event/v1',request]),observation_id:statusEvidenceIdV1(e),evidence_json:serializeStatusEvidenceV1(e)};
      values.content_digest=evidenceDigest(['source-status-row/v1',columns.map(c=>values[c])]);
      const keys=Object.keys(values);f.base.db.prepare(`INSERT INTO apple_purchase_status_observations(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>values[k]));
    }
  })();
  assert.equal(count(f.base.db,'apple_purchase_status_observations'),1022);const calls=f.calls();await assert.rejects(()=>facade.refreshStatus('10000','no-headroom'));
  assert.equal(f.calls(),calls);assert.equal(count(f.base.db,'apple_purchase_status_observations'),1022,'no charge without reserved completion room');
});

test('source fixture budget inventory cannot evade the independent whole-store observation bound with other accounts',async t=>{
  const f=await source27Fixture(t),facade=f.compose().source.forOwner(A);await facade.refreshStatus('10000','store-cap');f.base.advance(3600000);
  const {parseStatusEvidenceV1,serializeStatusEvidenceV1,statusEvidenceIdV1,serializeStatusBindingV1,statusBindingIdV1}=await import('../../src/purchases/status-codec.js');
  const {evidenceDigest}=await import('../../src/lifecycle/evidence-codec.js');
  const template=f.base.db.prepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='dispatch'").get() as Record<string,unknown>;
  const original=JSON.parse(template.evidence_json as string) as Record<string,unknown>,originalBinding=JSON.parse(template.binding_json as string) as Record<string,unknown>;
  const columns=['observation_id','account_id','original_transaction_id','owner_binding_digest','event_kind','event_key','request_id','lifecycle_epoch',
    'database_generation','schema_digest','continuity_digest','binding_json','evidence_json','observed_at_ms'];
  let peakBytes=0;
  for(let a=0;a<10;a++){
    f.base.db.transaction(()=>{
      const accountId=randomUUID(),auth='quota-auth-'+a,originalId=String(30000+a),o={...owner,accountId,appAccountToken:accountId,originalTransactionId:originalId};
      f.base.db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,1,1)').run(auth,'Synthetic quota',auth+'@synthetic.invalid');
      f.base.db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(accountId,auth,'synthetic');
      f.seed(f.base.db,o,f.tx({transactionId:String(40000+a),originalTransactionId:originalId,appAccountToken:accountId}));
      const b={...originalBinding,owner:o};
      for(let i=0;i<1000;i++){
        const request=evidenceDigest(['synthetic-store-history/v1',a,i]),e=parseStatusEvidenceV1({...original,originalTransactionId:originalId,requestId:request,bindingId:statusBindingIdV1(b)});
        const values:Record<string,unknown>={...template,account_id:accountId,original_transaction_id:originalId,owner_binding_digest:evidenceDigest(['source-status-owner/v1',o]),
          binding_json:serializeStatusBindingV1(b),request_id:request,event_key:evidenceDigest(['source-status-dispatch-event/v1',request]),observation_id:statusEvidenceIdV1(e),evidence_json:serializeStatusEvidenceV1(e)};
        values.content_digest=evidenceDigest(['source-status-row/v1',columns.map(c=>values[c])]);
        const keys=Object.keys(values);f.base.db.prepare(`INSERT INTO apple_purchase_status_observations(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>values[k]));
      }
    })();
    peakBytes=Math.max(peakBytes,f.fixtureBytes());
    assert.ok(peakBytes<67108864,'each retained-row batch plus its live WAL fits the unchanged fixture limit');
    // Quiescent fixture construction checkpoints WAL between bounded batches;
    // all retained observations remain present and no production limit changes.
    f.base.db.pragma('wal_checkpoint(TRUNCATE)');
  }
  const calls=f.calls();await assert.rejects(()=>facade.refreshStatus('10000','store-exhausted'));assert.equal(f.calls(),calls);
  assert.equal(count(f.base.db,'apple_purchase_status_observations'),10003,'bounded fixture seeding represents an already exhausted store, never fresh proof authority');
  t.diagnostic(`synthetic27 store-capacity construction peak including WAL: ${peakBytes} bytes`);
});
