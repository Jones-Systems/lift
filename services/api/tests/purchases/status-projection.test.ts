import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { A, B, owner, apple, source27Fixture } from './status-source-fixture.js';
import { ApplePurchaseService } from '../../src/purchases/service.js';
import { createCanonicalAccountWriter } from '../../src/integration/account-modules/canonical-writer.js';
import { consumeSourceStatusGracePermit } from '../../src/purchases/status-projection.js';

const active=(f:Awaited<ReturnType<typeof source27Fixture>>)=>f.compose().source.forOwner(A);
const rows=(f:Awaited<ReturnType<typeof source27Fixture>>,table:string)=>f.base.db.prepare(`SELECT * FROM ${table}`).all();

test('real newest expired head suppresses older existing grant; source hook changes old per-grant behavior',async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','first');assert.deepEqual(facade.entitlements().active,['form_plus']);
  const ordinary=new ApplePurchaseService(f.base.db,apple,f.verifier,f.base.now),writer=createCanonicalAccountWriter(f.base.db);
  const tx=f.tx({transactionId:'10002',purchaseDate:f.base.now()-1000,expiresDate:f.base.now()-1,signedDate:f.base.now()});
  const jws=f.signedTransaction(tx);
  const decision=writer.lifecycle.withActiveWrite(A,()=>ordinary.observeVerified(A.accountId,jws,tx,()=>writer.assertWithinWrite(A)));
  assert.deepEqual(decision,{status:'rejected',code:'apple_expired'});
  assert.deepEqual(ordinary.entitlements(A.accountId).active,['form_plus'],'before-hook behavior: older grant survives separately inserted expired successor');
  assert.deepEqual(facade.entitlements().active,[],'source read rederives actual newest head, even outside hooks');
});

test('source normal delivery invalidates status atomically including inactive head; exact unchanged replay appends nothing',async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','first');f.base.advance(5000);
  const tx=f.tx({transactionId:'10002',purchaseDate:f.base.now()-1000,expiresDate:f.base.now()+600000});
  const request={transactionId:tx.transactionId,productId:tx.productId,jwsRepresentation:f.signedTransaction(tx),idempotencyKey:'normal'};
  const result=await facade.deliver(request);assert.equal(result.status,'delivered');assert.deepEqual(facade.entitlements().active,[]);
  const observations=rows(f,'apple_purchase_status_observations');assert.equal(observations.length,4);
  assert.deepEqual(await facade.deliver(request),result);assert.deepEqual(rows(f,'apple_purchase_status_observations'),observations);
  const outcome=f.base.db.prepare("SELECT evidence_json FROM apple_purchase_status_observations WHERE event_kind='outcome' AND event_key<>(SELECT event_key FROM apple_purchase_status_observations WHERE event_kind='outcome' LIMIT 1)").get();void outcome;
});

test('real reconciliation-created ledger shares hooks; accepted History page invalidates within savepoint and exact replay appends nothing',async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','first');
  const tx=f.tx({transactionId:'10002',purchaseDate:f.base.now()-1000});
  f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'r2',hasMore:false,signedTransactions:[f.signedTransaction(tx)]});
  const checkpoint={handle:randomUUID(),expectedPage:0};const result=await facade.reconcileOwner(owner,checkpoint);assert.equal(result.status,'complete');
  assert.ok(f.base.db.prepare('SELECT 1 FROM apple_purchase_grants WHERE transaction_id=?').get(tx.transactionId));
  assert.deepEqual(facade.entitlements().active,[]);const before=rows(f,'apple_purchase_status_observations'),calls=f.calls();
  assert.deepEqual(await facade.reconcileOwner(owner,checkpoint),result);assert.equal(f.calls(),calls);assert.deepEqual(rows(f,'apple_purchase_status_observations'),before);
});

test('History late invalid item rolls back EVERY item/event/projection while preserving rejected-page outcome',async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','first');
  const before=rows(f,'apple_purchase_status_observations'),projection=rows(f,'apple_purchase_status_projection'),grants=rows(f,'apple_purchase_grants');
  const good=f.tx({transactionId:'10002',purchaseDate:f.base.now()-1000}),bad=f.tx({transactionId:'10003',purchaseDate:f.base.now()-1000,quantity:2});
  f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'bad-page',hasMore:false,signedTransactions:[f.signedTransaction(good),f.signedTransaction(bad)]});
  const result=await facade.reconcileOwner(owner,{handle:randomUUID(),expectedPage:0});assert.equal(result.status,'rejected');assert.equal(result.transactions,0);
  assert.deepEqual(rows(f,'apple_purchase_status_observations'),before);assert.deepEqual(rows(f,'apple_purchase_status_projection'),projection);assert.deepEqual(rows(f,'apple_purchase_grants'),grants);
  assert.equal(f.base.db.prepare('SELECT 1 FROM apple_purchase_transactions WHERE transaction_id=?').get(good.transactionId),undefined);
  assert.equal(rows(f,'apple_purchase_reconciliation_pages').length,1);
});

test('notification proof is real, sessionless background checks map owner; exact UUID replay no append and reversal/renewal-only cannot grant',async t=>{
  const f=await source27Fixture(t),c=f.compose(),facade=c.source.forOwner(A);await facade.refreshStatus('10000','first');
  const signed=f.signedNotification({notificationUUID:randomUUID(),version:'2.0',notificationType:'DID_CHANGE_RENEWAL_STATUS',signedDate:f.base.now(),
    data:{bundleId:apple.bundleId,environment:'Sandbox',signedRenewalInfo:f.signedRenewal(f.rn({gracePeriodExpiresDate:f.base.now()+60000}))}});
  const result=await c.source.ingestNotification(signed);assert.equal(result.status,'observed');assert.equal(result.reason,'renewal_evidence_only');
  assert.deepEqual(facade.entitlements().active,[]);const observations=rows(f,'apple_purchase_status_observations');
  assert.deepEqual(await c.source.ingestNotification(signed),result);assert.deepEqual(rows(f,'apple_purchase_status_observations'),observations);
  const reversed=f.signedNotification({notificationUUID:randomUUID(),version:'2.0',notificationType:'REFUND_REVERSED',signedDate:f.base.now(),
    data:{bundleId:apple.bundleId,environment:'Sandbox',signedTransactionInfo:f.signedTransaction(f.tx({transactionId:'10003'}))}});
  assert.equal((await c.source.ingestNotification(reversed)).status,'unavailable');assert.equal(f.base.db.prepare('SELECT 1 FROM apple_purchase_transactions WHERE transaction_id=?').get('10003'),undefined);
  assert.deepEqual(facade.entitlements().active,[]);
});

test('concurrent real History invalidation advances revision while retaining active claim; stale status CAS rolls back and original handles reconcile only',async t=>{
  const f=await source27Fixture(t),one=f.compose(),other=f.base.openOther(),two=f.compose(other),resume=f.pause('status-transport');
  const pending=one.source.forOwner(A).refreshStatus('10000','cas');await new Promise<void>(resolve=>setImmediate(resolve));
  f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'r2',hasMore:false,signedTransactions:[f.signedTransaction(f.tx({transactionId:'10002'}))]});
  const history=await two.source.forOwner(A).reconcileOwner(owner,{handle:randomUUID(),expectedPage:0});assert.equal(history.status,'complete');
  const before=rows(f,'apple_purchase_grants');resume();await assert.rejects(()=>pending);assert.deepEqual(rows(f,'apple_purchase_grants'),before);
  assert.equal(rows(f,'apple_purchase_status_observations').length,2,'only original dispatch + actual History event');
  const result=one.source.forOwner(A).reconcileStatusRequest('cas');assert.equal(result.revision,3);assert.equal(result.status,'unknown');
});

for(const variant of ['retry','expiry','missing-grace','equal-cutoff','future-purchase','family','wrong-product','wrong-group','wrong-owner','revoked','upgraded'] as const){
  test(`negative ${variant} evidence never derives subscription access`,async t=>{
    const f=await source27Fixture(t),facade=active(f),now=f.base.now();
    const tx=f.tx({expiresDate:now-1,...(variant==='future-purchase'?{purchaseDate:now+1,expiresDate:now+10000}:{}),
      ...(variant==='family'?{inAppOwnershipType:'FAMILY_SHARED'}:{}),...(variant==='wrong-product'?{productId:'other.product'}:{}),
      ...(variant==='wrong-group'?{subscriptionGroupIdentifier:'200'}:{}),...(variant==='wrong-owner'?{appAccountToken:B.accountId}:{}),
      ...(variant==='revoked'?{revocationDate:now-2}:{}),...(variant==='upgraded'?{isUpgraded:true}:{})});
    const rn=f.rn(variant==='missing-grace'?{}:{gracePeriodExpiresDate:variant==='equal-cutoff'?now:now+10000});
    f.response(f.envelope([f.item(variant==='retry'?3:variant==='expiry'?2:4,tx,rn)]));
    try{await facade.refreshStatus('10000',variant);}catch{}
    assert.deepEqual(facade.entitlements().active,[]);assert.equal(rows(f,'apple_purchase_grants').length,0);
  });
}

test('incomparable/equal-version contradictory signed pairs remain held even after a third dominates; cross-session comparison validates original records',async t=>{
  const f=await source27Fixture(t),facade=active(f),now=f.base.now();
  const p=f.tx(),first=f.item(1,p,f.rn());f.response(f.envelope([first]));await facade.refreshStatus('10000','first');
  // Same transaction proof plus a different authenticated status at the same signed coordinates is retained conflict.
  f.base.advance(5000);f.response(f.envelope([{...first,status:4}]));await facade.refreshStatus('10000','contradiction');assert.deepEqual(facade.entitlements().active,[]);
  f.base.advance(5000);f.response(f.envelope([f.item(1,{...p,signedDate:now+10000},f.rn({signedDate:now+10000}))]));
  await facade.refreshStatus('10000','dominates');assert.deepEqual(facade.entitlements().active,[]);
});

test('forged grace permits cannot bypass default observation expiry or a live canonical write',async t=>{
  const f=await source27Fixture(t),tx=f.tx({expiresDate:f.base.now()-1}),jws=f.signedTransaction(tx),writer=createCanonicalAccountWriter(f.base.db);
  const service=new ApplePurchaseService(f.base.db,apple,f.verifier,f.base.now);
  assert.throws(()=>consumeSourceStatusGracePermit({} as never,{db:f.base.db,accountId:A.accountId,exactJws:jws,proof:tx,nowMs:f.base.now()}));
  assert.throws(()=>writer.lifecycle.withActiveWrite(A,()=>service.observeVerified(A.accountId,jws,tx,()=>writer.assertWithinWrite(A),{} as never)));
  assert.equal(rows(f,'apple_purchase_grants').length,0);assert.equal(f.base.db.prepare('SELECT 1 FROM apple_purchase_transactions WHERE transaction_id=?').get(tx.transactionId),undefined);
});

test('equal purchase dates hold distinct heads; a genuinely later purchased successor can recover from old sticky denial',async t=>{
  const f=await source27Fixture(t),facade=active(f),p=f.tx();f.response(f.envelope([f.item(5,{...p,revocationDate:f.base.now()-1})]));
  await facade.refreshStatus('10000','revoked');assert.deepEqual(facade.entitlements().active,[]);
  f.base.advance(5000);const later=f.tx({transactionId:'10002',purchaseDate:f.base.now()-1000});f.response(f.envelope([f.item(1,later)]));
  await facade.refreshStatus('10000','successor');assert.deepEqual(facade.entitlements().active,['form_plus']);
  f.base.advance(5000);const equal=f.tx({transactionId:'10003',purchaseDate:later.purchaseDate});f.response(f.envelope([f.item(1,equal)]));
  await facade.refreshStatus('10000','equal-date');assert.deepEqual(facade.entitlements().active,[]);
});

test('revoked original leaves another genuine lineage independent',async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','first');f.base.advance(5000);
  const otherOwner={...owner,originalTransactionId:'20000'},other=f.tx({transactionId:'20002',originalTransactionId:'20000'});
  f.seed(f.base.db,otherOwner,{...other,transactionId:'20001',purchaseDate:other.purchaseDate-1000});f.response(f.envelope([f.item(1,other,{...f.rn(),originalTransactionId:'20000'})]));
  await facade.refreshStatus('20000','other');f.base.advance(5000);
  const p=f.tx({purchaseDate:other.purchaseDate-5000,signedDate:f.base.now(),revocationDate:f.base.now()-1});
  f.response(f.envelope([f.item(5,p)]));await facade.refreshStatus('10000','revoke');
  const grants=facade.entitlements().grants;assert.equal(grants.find(g=>g.sourceId==='10001')!.active,false);assert.equal(grants.find(g=>g.sourceId==='20002')!.active,true);
});

test('one-use grace authority is burned before a later SQL failure; copied/JSON/wrong-proof permits fail inside the real frame',async t=>{
  const f=await source27Fixture(t),facade=active(f),tx=f.tx({expiresDate:f.base.now()-1});f.response(f.envelope([f.item(4,tx,f.rn({gracePeriodExpiresDate:f.base.now()+60000}))]));
  const original=ApplePurchaseService.prototype.observeVerified,db=f.base.db,prepare=db.prepare.bind(db);let observed=false,burned=false;
  ApplePurchaseService.prototype.observeVerified=function(account,jws,proof,writer,permit){
    assert.ok(permit);for(const fake of [{...permit},JSON.parse(JSON.stringify(permit))])assert.throws(()=>consumeSourceStatusGracePermit(fake,{db,accountId:account,exactJws:jws,proof,nowMs:f.base.now()}));
    assert.throws(()=>consumeSourceStatusGracePermit(permit,{db,accountId:account,exactJws:jws,proof:{...proof},nowMs:f.base.now()}));
    const result=original.call(this,account,jws,proof,writer,permit);observed=true;
    assert.equal(rows(f,'apple_purchase_grants').length,1,'real grant exists inside final SQL frame');
    assert.throws(()=>consumeSourceStatusGracePermit(permit,{db,accountId:account,exactJws:jws,proof,nowMs:f.base.now()}));burned=true;return result;
  };
  db.prepare=((sql:string)=>{
    const statement=prepare(sql);if(!sql.startsWith('INSERT INTO apple_purchase_status_observations('))return statement;
    return new Proxy(statement,{get(target,key){if(key==='run')return (...args:unknown[])=>{if(args[4]==='outcome')throw new Error('synthetic terminal persistence failure');return Reflect.apply(target.run,target,args);};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
  }) as typeof db.prepare;
  t.after(()=>{ApplePurchaseService.prototype.observeVerified=original;db.prepare=prepare as typeof db.prepare;});
  await assert.rejects(()=>facade.refreshStatus('10000','rollback'));assert.equal(observed,true);assert.equal(burned,true);assert.equal(rows(f,'apple_purchase_grants').length,0);
  assert.equal(rows(f,'apple_purchase_status_observations').length,1);db.prepare=prepare as typeof db.prepare;ApplePurchaseService.prototype.observeVerified=original;
  assert.equal(facade.reconcileStatusRequest('rollback').status,'unknown');assert.equal(rows(f,'apple_purchase_grants').length,0);
});

test('immutable record, JSON/SQL cutoff and content/pointer joins deny actual persisted tampering after exact schema restoration',async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','first');
  const db=f.base.db;
  for(const mutation of ['event-key','cutoff','json-revision'] as const){
    const trigger=mutation==='event-key'?'immutable_apple_status_observation':'advancing_apple_status_projection';
    const sql=(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(trigger) as {sql:string}).sql;
    assert.throws(()=>db.transaction(()=>{
      db.exec(`DROP TRIGGER ${trigger}`);
      if(mutation==='event-key')db.prepare("UPDATE apple_purchase_status_observations SET event_key=? WHERE event_kind='status'").run('1'.repeat(64));
      else if(mutation==='cutoff')db.prepare('UPDATE apple_purchase_status_projection SET valid_until_ms=valid_until_ms+1').run();
      else db.prepare("UPDATE apple_purchase_status_projection SET projection_json=json_set(projection_json,'$.revision',99)").run();
      db.exec(sql);assert.deepEqual(facade.entitlements().active,[]);throw new Error('owned synthetic rollback');
    })(),/owned synthetic rollback/);
    assert.deepEqual(facade.entitlements().active,['form_plus']);
  }
});
