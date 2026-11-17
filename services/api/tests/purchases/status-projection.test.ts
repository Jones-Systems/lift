import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { A, B, owner, apple, source27Fixture, configuration } from './status-source-fixture.js';
import { ApplePurchaseService } from '../../src/purchases/service.js';
import { createCanonicalAccountWriter } from '../../src/integration/account-modules/canonical-writer.js';
import { openSourceSubscriptionStatusStorage } from '../../src/purchases/status-source-migrations.js';
import { consumeSourceStatusGracePermit } from '../../src/purchases/status-projection.js';
import { evidenceDigest } from '../../src/lifecycle/evidence-codec.js';
import { parseStatusEvidenceV1,parseStatusBindingV1,serializeStatusEvidenceV1,serializeStatusBindingV1,serializeStatusProjectionV1,
  statusEvidenceIdV1,statusBindingIdV1,type StatusEvidenceV1 } from '../../src/purchases/status-codec.js';

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

const observationColumns27=['observation_id','account_id','original_transaction_id','owner_binding_digest','event_kind','event_key','request_id',
  'lifecycle_epoch','database_generation','schema_digest','continuity_digest','binding_json','evidence_json','observed_at_ms'];
function record27(template:Record<string,unknown>,e:StatusEvidenceV1,b=parseStatusBindingV1(template.binding_json)):Record<string,unknown> {
  const domain=e.kind==='dispatch'?'source-status-dispatch-event/v1':e.kind==='status'?'source-status-observation-event/v1':
    e.kind==='history'?'source-status-history-event/v1':e.kind==='notification'?'source-status-notification-event/v1':
    e.reason==='ledger_changed'?'source-status-delivery-event/v1':'source-status-outcome-event/v1';
  const row:Record<string,unknown>={...template,observation_id:statusEvidenceIdV1(e),event_kind:e.kind,request_id:e.requestId,
    event_key:evidenceDigest([domain,e.requestId]),binding_json:serializeStatusBindingV1(b),evidence_json:serializeStatusEvidenceV1(e),
    lifecycle_epoch:b.epoch,database_generation:b.generation,schema_digest:b.schemaDigest,continuity_digest:b.continuity.digest,observed_at_ms:e.recordedAtMs};
  row.content_digest=evidenceDigest(['source-status-row/v1',observationColumns27.map(k=>row[k])]);return row;
}
function insertRecord27(f:Fixture27,row:Record<string,unknown>):void {
  const keys=Object.keys(row);f.base.db.prepare(`INSERT INTO apple_purchase_status_observations(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
}
function replaceRecord27(f:Fixture27,old:Record<string,unknown>,row:Record<string,unknown>):void {
  const keys=Object.keys(row);f.base.db.prepare(`UPDATE apple_purchase_status_observations SET ${keys.map(k=>k+'=?').join(',')} WHERE observation_id=?`)
    .run(...keys.map(k=>row[k]),old.observation_id);
}
function alterRows27(f:Fixture27,effect:()=>void):void {
  const db=f.base.db,names=['immutable_apple_status_observation','retained_apple_status_observation','advancing_apple_status_projection'];
  const sql=names.map(name=>(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as {sql:string}).sql);
  for(const name of names)db.exec(`DROP TRIGGER ${name}`);
  effect();for(const statement of sql)db.exec(statement);
}
function changeProjection27(f:Fixture27,changes:Record<string,unknown>,sql:Record<string,unknown>={}):void {
  const old=projection27(f),p={...JSON.parse(old.projection_json),...changes};
  const values={projection_json:serializeStatusProjectionV1(p),...sql},keys=Object.keys(values);
  f.base.db.prepare(`UPDATE apple_purchase_status_projection SET ${keys.map(k=>k+'=?').join(',')} WHERE original_transaction_id='10000'`)
    .run(...keys.map(k=>(values as Record<string,unknown>)[k]));
}
function injectProjectionRead27(f:Fixture27,effect:()=>void):()=>boolean {
  const db=f.base.db,prepare=db.prepare.bind(db);let injected=false;
  db.prepare=((sql:string)=>{
    const statement=prepare(sql);
    if(sql!=='SELECT * FROM apple_purchase_status_projection WHERE original_transaction_id=? AND account_id=?')return statement;
    return new Proxy(statement,{get(target,key){if(key==='get')return (...args:unknown[])=>{
      if(!injected){injected=true;assert.equal(db.inTransaction,true);alterRows27(f,effect);}
      return Reflect.apply(target.get,target,args);
    };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
  }) as typeof db.prepare;
  return ()=>{db.prepare=prepare as typeof db.prepare;return injected;};
}

for(const advance of [false,true])test(`COR01-J exact History author required with ${advance?'advanced':'equal current'} binding; canonical tampering rolls back`,async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','join-first');f.base.advance(5000);
  f.seed(f.base.db,{...owner,originalTransactionId:'20000'},f.tx({transactionId:'20001',originalTransactionId:'20000'}));
  f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'join',hasMore:false,signedTransactions:[]});
  assert.equal((await facade.reconcileOwner(owner,{handle:randomUUID(),expectedPage:0})).status,'complete');
  if(advance)f.base.advance(5000);
  const before=rows(f,'apple_purchase_status_observations'),savedProjection=projection27(f),calls=f.calls(),grants=rows(f,'apple_purchase_grants');
  const author=f.base.db.prepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='history'").get() as Record<string,unknown>;
  const e=parseStatusEvidenceV1(author.evidence_json);assert.equal(e.kind,'history');if(e.kind!=='history')assert.fail();
  const request=(page:typeof e.page,revision:number)=>evidenceDigest(['source-status-history/v2',[A.accountId,page.handle,page.pageIndex,page.pageDigest,revision]]);
  for(const variant of ['missing','binding','owner','lineage','epoch','generation','schema','prefix','event-key','kind','reason','page','request','other-revision','sentinel0','two-authors','eligible-invalid','status-pointer','cutoff','legacy-v1'] as const){
    const restore=injectProjectionRead27(f,()=>{
      let changed:Record<string,unknown>=record27(author,e),b=parseStatusBindingV1(author.binding_json);
      if(variant==='missing'){f.base.db.prepare('DELETE FROM apple_purchase_status_observations WHERE observation_id=?').run(author.observation_id);return;}
      if(variant==='binding')changeProjection27(f,{bindingId:'1'.repeat(64)});
      if(variant==='owner')changed.owner_binding_digest='1'.repeat(64);
      if(variant==='lineage')changed.original_transaction_id='20000';
      if(variant==='epoch')changed.lifecycle_epoch=1;
      if(variant==='generation')changed.database_generation='foreign-generation';
      if(variant==='schema')changed.schema_digest='1'.repeat(64);
      if(variant==='prefix'){
        b=parseStatusBindingV1({...b,suppression:{...b.suppression,headDigest:'1'.repeat(64)}});
        changed=record27(author,parseStatusEvidenceV1({...e,bindingId:statusBindingIdV1(b)}),b);changeProjection27(f,{bindingId:statusBindingIdV1(b)});
      }
      if(variant==='event-key')changed.event_key='1'.repeat(64);
      if(variant==='kind')changed.event_kind='notification';
      if(variant==='reason')changed=record27(author,parseStatusEvidenceV1({...e,reason:'notification_changed'}));
      if(variant==='page')changed=record27(author,parseStatusEvidenceV1({...e,page:{...e.page,pageDigest:'1'.repeat(64)}}));
      if(variant==='request')changed=record27(author,parseStatusEvidenceV1({...e,requestId:'1'.repeat(64)}));
      if(variant==='other-revision'||variant==='sentinel0')changed=record27(author,parseStatusEvidenceV1({...e,requestId:request(e.page,variant==='sentinel0'?0:savedProjection.revision-1)}));
      if(variant==='legacy-v1')changed=record27(author,parseStatusEvidenceV1({...e,requestId:evidenceDigest(['source-status-history/v1',[A.accountId,e.page.handle,e.page.pageIndex]])}));
      if(variant==='two-authors'||variant==='eligible-invalid'){
        const page={...e.page,pageDigest:'2'.repeat(64)},extra=record27(author,parseStatusEvidenceV1({...e,page,requestId:request(page,savedProjection.revision)}));
        if(variant==='eligible-invalid')extra.content_digest='1'.repeat(64);insertRecord27(f,extra);
      }
      if(variant==='status-pointer'){
        const status=before.find(row=>(row as {event_kind:string}).event_kind==='status') as {observation_id:string};
        changeProjection27(f,{observationId:status.observation_id},{current_observation_id:status.observation_id});
      }
      if(variant==='cutoff')changeProjection27(f,{validUntilMs:f.base.now()+1000},{valid_until_ms:f.base.now()+1000});
      if(!['binding','two-authors','eligible-invalid','status-pointer','cutoff'].includes(variant)){
        changed.content_digest=evidenceDigest(['source-status-row/v1',observationColumns27.map(k=>changed[k])]);replaceRecord27(f,author,changed);
      }
    });
    try{await assert.rejects(()=>facade.refreshStatus('10000','join-'+variant),variant);}finally{assert.equal(restore(),true,variant+' reached actual projection admission');}
    assert.equal(f.calls(),calls,variant+' no HTTP');assert.deepEqual(rows(f,'apple_purchase_status_observations'),before,variant+' rollback restores every event');
    assert.deepEqual(projection27(f),savedProjection);assert.deepEqual(rows(f,'apple_purchase_grants'),grants);
  }
  assert.equal((await facade.refreshStatus('10000','join-valid')).status,'observed','control admits the untampered author');
});

test('COR01-J notification UUID, payload, reason and revision must name the actual background author',async t=>{
  const f=await source27Fixture(t),c=f.compose(),facade=c.source.forOwner(A);await facade.refreshStatus('10000','notification-join');f.base.advance(5000);
  const signed=f.signedNotification({notificationUUID:randomUUID(),version:'2.0',notificationType:'DID_CHANGE_RENEWAL_STATUS',signedDate:f.base.now(),
    data:{bundleId:apple.bundleId,environment:'Sandbox',signedRenewalInfo:f.signedRenewal(f.rn())}});
  assert.equal((await c.source.ingestNotification(signed)).status,'observed');f.base.advance(5000);
  const author=f.base.db.prepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='notification'").get() as Record<string,unknown>;
  const e=parseStatusEvidenceV1(author.evidence_json);if(e.kind!=='notification')assert.fail();
  for(const change of [{notificationId:randomUUID()},{payloadDigest:'1'.repeat(64)},{reason:'refund_reversed'},
    {requestId:evidenceDigest(['source-status-notification/v2',[A.accountId,e.notificationId,e.payloadDigest,0]])}]){
    const before=rows(f,'apple_purchase_status_observations'),p=projection27(f),calls=f.calls();
    const restore=injectProjectionRead27(f,()=>replaceRecord27(f,author,record27(author,parseStatusEvidenceV1({...e,...change}))));
    try{await assert.rejects(()=>facade.refreshStatus('10000','notification-bad'));}finally{assert.equal(restore(),true);}
    assert.equal(f.calls(),calls);assert.deepEqual(rows(f,'apple_purchase_status_observations'),before);assert.deepEqual(projection27(f),p);
  }
  assert.equal((await facade.refreshStatus('10000','notification-good')).status,'observed');
});

test('COR01-A background invalidation retains the saved dispatch/deadline; stale CAS cannot grant, fenced reconciliation then explicit refresh can recover',async t=>{
  const f=await source27Fixture(t),one=f.compose(),two=f.compose(f.base.openOther()),facade=one.source.forOwner(A),resume=f.pause('status-transport');
  const pending=facade.refreshStatus('10000','notification-cas');const result=pending.then(v=>({v,error:null}),error=>({v:null,error}));
  await new Promise<void>(resolve=>setImmediate(resolve));const old=projection27(f);
  const signed=f.signedNotification({notificationUUID:randomUUID(),version:'2.0',notificationType:'DID_CHANGE_RENEWAL_STATUS',signedDate:f.base.now(),
    data:{bundleId:apple.bundleId,environment:'Sandbox',signedRenewalInfo:f.signedRenewal(f.rn())}});
  try{
    assert.equal((await two.source.ingestNotification(signed)).status,'observed');const held=projection27(f);
    assert.equal(held.revision,old.revision+1);assert.equal(held.active_request_id,old.active_request_id);assert.equal(held.request_deadline_ms,old.request_deadline_ms);
    await assert.rejects(()=>two.source.forOwner(newSession27(f)).refreshStatus('10000','excluded'));assert.deepEqual(facade.entitlements().active,[]);
  }finally{resume();await result;f.barrier();}
  assert.ok((await result).error);assert.equal(rows(f,'apple_purchase_grants').length,0);assert.equal(rows(f,'apple_purchase_status_observations').length,2);
  assert.equal(facade.reconcileStatusRequest('notification-cas').status,'unknown');f.base.advance(5000);
  assert.equal((await facade.refreshStatus('10000','notification-after-cas')).status,'observed');assert.deepEqual(facade.entitlements().active,['form_plus']);
});

test('COR01-B over100 legitimate same-clock History authors remain recoverable; durable page replay appends nothing',async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','many-first');f.base.advance(5000);
  for(let i=0;i<101;i++){
    f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'many-'+i,hasMore:false,signedTransactions:[]});
    const checkpoint={handle:randomUUID(),expectedPage:0},outcome=await facade.reconcileOwner(owner,checkpoint);assert.equal(outcome.status,'complete');
    const saved=projection27(f),events=rows(f,'apple_purchase_status_observations');assert.equal(events.length,4+i);
    assert.deepEqual(await facade.reconcileOwner(owner,checkpoint),outcome);assert.deepEqual(rows(f,'apple_purchase_status_observations'),events);assert.deepEqual(projection27(f),saved);
    if(i%10===0){f.barrier();f.base.db.pragma('wal_checkpoint(TRUNCATE)');assert.ok(f.fixtureBytes()<67108864);}
  }
  f.base.advance(5000);assert.equal((await facade.refreshStatus('10000','many-after')).status,'observed');assert.deepEqual(facade.entitlements().active,['form_plus']);
});

test('COR01-B/J delivery ledger_changed author has exact settled outcome and revision; later-clock explicit refresh recovers',async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','delivery-first');f.base.advance(5000);
  const target=f.item(1,f.tx({transactionId:'10002',purchaseDate:f.base.now()-1000}));
  const request={transactionId:'10002',productId:'form.plus.month',jwsRepresentation:target.signedTransactionInfo,idempotencyKey:'delivery-cause'};
  assert.equal((await facade.deliver(request)).status,'delivered');const before=rows(f,'apple_purchase_status_observations'),p=projection27(f);
  assert.deepEqual(facade.entitlements().active,[]);assert.equal(before.length,4);await facade.deliver(request);assert.deepEqual(rows(f,'apple_purchase_status_observations'),before);
  const author=f.base.db.prepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='outcome' AND json_extract(evidence_json,'$.reason')='ledger_changed'").get() as Record<string,unknown>;
  const e=parseStatusEvidenceV1(author.evidence_json);if(e.kind!=='outcome')assert.fail();f.base.advance(5000);
  for(const change of [{outcome:'observed'},{producerSettlement:'unproven'},{resultingRevision:p.revision-1},{reason:'unknown'},
    {observationIds:[(statusRows27(f)[0] as {observation_id:string}).observation_id]}]){
    const calls=f.calls(),restore=injectProjectionRead27(f,()=>replaceRecord27(f,author,record27(author,parseStatusEvidenceV1({...e,...change}))));
    try{await assert.rejects(()=>facade.refreshStatus('10000','bad-delivery'));}finally{assert.equal(restore(),true);}
    assert.equal(f.calls(),calls);assert.deepEqual(rows(f,'apple_purchase_status_observations'),before);assert.deepEqual(projection27(f),p);
  }
  f.response(f.envelope([target]));assert.equal((await facade.refreshStatus('10000','after-delivery')).status,'observed');assert.deepEqual(facade.entitlements().active,['form_plus']);
});

for(const kind of ['history','notification','delivery'] as const)test(`COR01-X ${kind} failure after invalidation CAS rolls back event, ledger, projection and grant`,async t=>{
  const f=await source27Fixture(t),c=f.compose(),facade=c.source.forOwner(A);await facade.refreshStatus('10000','rollback-first');f.base.advance(5000);
  const tables=['apple_purchase_transactions','apple_purchase_grants','apple_purchase_status_observations','apple_purchase_status_projection','apple_purchase_notifications','apple_purchase_commands','apple_purchase_deliveries'];
  const before=tables.map(table=>rows(f,table)),db=f.base.db,prepare=db.prepare.bind(db);let failed=false;
  db.prepare=((sql:string)=>{
    const statement=prepare(sql);if(!sql.startsWith('UPDATE apple_purchase_status_projection SET'))return statement;
    return new Proxy(statement,{get(target,key){if(key==='run')return (...args:unknown[])=>{
      const result=Reflect.apply(target.run,target,args);failed=true;throw new Error('synthetic post-invalidation CAS failure');
    };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
  }) as typeof db.prepare;
  const tx=f.tx({transactionId:'10002',purchaseDate:f.base.now()-1000}),jws=f.signedTransaction(tx);
  try{
    if(kind==='history'){
      f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'rollback-page',hasMore:false,signedTransactions:[jws]});
      assert.notEqual((await facade.reconcileOwner(owner,{handle:randomUUID(),expectedPage:0})).status,'complete');
    }else if(kind==='notification'){
      const n=f.signedNotification({notificationUUID:randomUUID(),version:'2.0',notificationType:'DID_RENEW',signedDate:f.base.now(),data:{bundleId:apple.bundleId,environment:'Sandbox',signedTransactionInfo:jws}});
      assert.notEqual((await c.source.ingestNotification(n)).status,'observed');
    }else assert.equal((await facade.deliver({transactionId:tx.transactionId,productId:tx.productId,jwsRepresentation:jws,idempotencyKey:'rollback-delivery'})).status,'unknown');
  }finally{db.prepare=prepare as typeof db.prepare;}
  assert.equal(failed,true,'actual writer appended its event and reached projection CAS');assert.deepEqual(tables.map(table=>rows(f,table)),before);
  assert.equal(rows(f,'apple_purchase_reconciliation_pages').length,0,'storage failure is not a saved rejected page');assert.deepEqual(facade.entitlements().active,['form_plus']);
});

for(const proof of ['transaction','renewal'] as const)test(`COR02-C a changed exact target ${proof} proof at equal coordinates remains a retained contradiction`,async t=>{
  const f=await source27Fixture(t),facade=active(f),tx=f.tx(),rn=f.rn(),target=f.item(1,tx,rn);f.response(f.envelope([target]));await facade.refreshStatus('10000','target-first');
  f.base.advance(5000);const changed={...target,...(proof==='transaction'?{signedTransactionInfo:f.signedTransaction(tx)}:{signedRenewalInfo:f.signedRenewal(rn)})};
  f.response(f.envelope([changed]));await facade.refreshStatus('10000','target-conflict');assert.equal(statusRows27(f).length,2);assert.deepEqual(facade.entitlements().active,[]);
  f.base.advance(5000);f.response(f.envelope([f.item(1,{...tx,signedDate:f.base.now()},f.rn({signedDate:f.base.now()}))]));
  await facade.refreshStatus('10000','target-dominating');assert.equal(statusRows27(f).length,3);assert.deepEqual(facade.entitlements().active,[],'real conflict survives a dominating vector');
});

for(const variant of ['transaction','renewal','mismatched-renewal','missing'] as const)test(`COR02-I valid target first with ${variant} foreign proof last cannot mint target evidence or grant`,async t=>{
  const f=await source27Fixture(t),facade=active(f),target=f.item(),foreignTx=f.tx({transactionId:'20001',originalTransactionId:'20000'});
  f.seed(f.base.db,{...owner,originalTransactionId:'20000'},foreignTx);const foreign:Record<string,unknown>={...f.item(1,foreignTx,f.rn({originalTransactionId:variant==='mismatched-renewal'?'10000':'20000'}))};
  if(variant==='transaction')foreign.signedTransactionInfo='synthetic.invalid.signature';if(variant==='renewal')foreign.signedRenewalInfo='synthetic.invalid.signature';if(variant==='missing')delete foreign.signedRenewalInfo;
  const seen:string[]=[],verify=f.verifier.verify,renewal=f.verifier.renewal;
  f.verifier.verify=jws=>{seen.push(jws);return verify(jws);};f.verifier.renewal=jws=>{seen.push(jws);return renewal(jws);};
  const ledger=rows(f,'apple_purchase_transactions');f.response(f.envelope([target,foreign]));const result=await facade.refreshStatus('10000','invalid-foreign');
  assert.equal(result.status,'rejected');assert.equal(statusRows27(f).length,0);assert.equal(rows(f,'apple_purchase_grants').length,0);assert.deepEqual(rows(f,'apple_purchase_transactions'),ledger);
  if(variant==='missing')assert.deepEqual(seen,[],'envelope shape rejection precedes proof work');
  else{
    assert.deepEqual(seen.slice(0,2),[target.signedTransactionInfo,target.signedRenewalInfo]);assert.ok(seen.includes(foreign.signedTransactionInfo as string));
    if(variant!=='transaction')assert.ok(seen.includes(foreign.signedRenewalInfo as string));
  }
  f.barrier();
});

for(const grace of [false,true])test(`COR02-F signed ${grace?'grace':'expiry'} cutoff equality denies before original freshness; replay does not extend it`,async t=>{
  const f=await source27Fixture(t),facade=active(f),start=f.base.now(),target=f.item(grace?4:1,f.tx({expiresDate:grace?start-1:start+10000}),f.rn(grace?{gracePeriodExpiresDate:start+10000}:{}));
  f.response(f.envelope([target]));await facade.refreshStatus('10000','short-cutoff');const original=statusRows27(f);assert.equal(projection27(f).valid_until_ms,start+10000);
  f.base.advance(10000);assert.deepEqual(facade.entitlements().active,[]);await facade.refreshStatus('10000','short-cutoff-replay');
  assert.deepEqual(statusRows27(f),original);assert.deepEqual(facade.entitlements().active,[]);
});

test('COR-COMPAT explicitly legacy whole-envelope digest is retained across reopen; mixed new target semantics conservatively conflict without rehashing history',async t=>{
  const f=await source27Fixture(t),facade=active(f),target=f.item(),envelope=f.envelope([target]);f.response(envelope);await facade.refreshStatus('10000','legacy-fixture');
  const old=statusRows27(f)[0] as Record<string,unknown>,e=parseStatusEvidenceV1(old.evidence_json);if(e.kind!=='status')assert.fail();
  const legacy=record27(old,parseStatusEvidenceV1({...e,providerResponseDigest:evidenceDigest(['source-status-provider-response/v1',envelope])}));
  f.base.db.transaction(()=>{
    f.base.db.pragma('defer_foreign_keys=ON');alterRows27(f,()=>{replaceRecord27(f,old,legacy);
      changeProjection27(f,{observationId:legacy.observation_id},{current_observation_id:legacy.observation_id});});
  })();
  await reopen27(f);const next=f.compose().source.forOwner(newSession27(f));assert.deepEqual(statusRows27(f),[legacy]);f.base.advance(5000);
  await next.refreshStatus('10000','new-semantics');assert.equal(statusRows27(f).length,2);assert.ok(statusRows27(f).some(row=>JSON.stringify(row)===JSON.stringify(legacy)));
  assert.deepEqual(next.entitlements().active,[],'unmounted legacy/new pair is conservatively held; no deployed migration claim');
});

test('COR01-J/B a real pre-projection sentinel0 event at the same clock and binding cannot authorize a later held revision',async t=>{
  const f=await source27Fixture(t),facade=active(f);
  f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'sentinel',hasMore:false,signedTransactions:[]});
  assert.equal((await facade.reconcileOwner(owner,{handle:randomUUID(),expectedPage:0})).status,'complete');
  assert.equal(projection27(f),undefined);const sentinel=rows(f,'apple_purchase_status_observations')[0] as Record<string,unknown>;
  await facade.refreshStatus('10000','after-sentinel');
  assert.equal((await facade.reconcileOwner(owner,{handle:randomUUID(),expectedPage:0})).status,'complete');
  const authors=f.base.db.prepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='history'").all() as Record<string,unknown>[];
  const latest=authors.find(row=>row.observation_id!==sentinel.observation_id)!;
  assert.equal(parseStatusEvidenceV1(latest.evidence_json).bindingId,parseStatusEvidenceV1(sentinel.evidence_json).bindingId);
  const before=rows(f,'apple_purchase_status_observations'),p=projection27(f);f.base.advance(5000);const calls=f.calls();
  const restore=injectProjectionRead27(f,()=>f.base.db.prepare('DELETE FROM apple_purchase_status_observations WHERE observation_id=?').run(latest.observation_id));
  try{await assert.rejects(()=>facade.refreshStatus('10000','sentinel-refusal'));}finally{assert.equal(restore(),true);}
  assert.equal(f.calls(),calls);assert.deepEqual(rows(f,'apple_purchase_status_observations'),before);assert.deepEqual(projection27(f),p);
  assert.equal((await facade.refreshStatus('10000','sentinel-control')).status,'observed');
});

test('COR01-X near account capacity reserves both completion slots during actual History invalidation and rolls back one extra event',async t=>{
  const f=await source27Fixture(t),one=f.compose(),two=f.compose(f.base.openOther()),facade=one.source.forOwner(A);
  await facade.refreshStatus('10000','capacity-initial');f.base.advance(5000);const resume=f.pause('status-transport');
  const pending=facade.refreshStatus('10000','capacity-live'),result=pending.then(v=>({v,error:null}),error=>({v:null,error}));
  try{
    await new Promise<void>(resolve=>setImmediate(resolve));const claim=projection27(f);
    const template=f.base.db.prepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='dispatch' LIMIT 1").get() as Record<string,unknown>;
    const original=parseStatusEvidenceV1(template.evidence_json);
    f.base.db.transaction(()=>{for(let i=0;i<1017;i++)insertRecord27(f,record27(template,parseStatusEvidenceV1({...original,requestId:evidenceDigest(['synthetic-completion-capacity/v1',i])})));})();
    assert.equal(rows(f,'apple_purchase_status_observations').length,1021);
    f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'capacity-history',hasMore:false,signedTransactions:[]});
    assert.equal((await two.source.forOwner(A).reconcileOwner(owner,{handle:randomUUID(),expectedPage:0})).status,'complete');
    const before=rows(f,'apple_purchase_status_observations'),held=projection27(f),pages=rows(f,'apple_purchase_reconciliation_pages');
    assert.equal(before.length,1022);assert.equal(held.revision,claim.revision+1);assert.equal(held.active_request_id,claim.active_request_id);assert.equal(held.request_deadline_ms,claim.request_deadline_ms);
    assert.notEqual((await two.source.forOwner(A).reconcileOwner(owner,{handle:randomUUID(),expectedPage:0})).status,'complete');
    assert.deepEqual(rows(f,'apple_purchase_status_observations'),before);assert.deepEqual(projection27(f),held);assert.deepEqual(rows(f,'apple_purchase_reconciliation_pages'),pages);
  }finally{resume();await result;f.barrier();}
  assert.ok((await result).error);assert.equal(facade.reconcileStatusRequest('capacity-live').status,'unknown');
  assert.equal(rows(f,'apple_purchase_status_observations').length,1023);assert.deepEqual(facade.entitlements().active,[]);
});

for(const variant of ['wrong-revision','over1024-candidates'] as const)test(`COR01-J matching live dispatch binding cannot bypass ${variant} invalidation author refusal`,async t=>{
  const f=await source27Fixture(t),one=f.compose(),db=f.base.openOther(),two=f.compose(db),facade=one.source.forOwner(A),resume=f.pause('status-transport');
  const secondFixture={...f,base:{...f.base,db}};
  const pending=facade.refreshStatus('10000','author-live-claim'),result=pending.then(v=>({v,error:null}),error=>({v:null,error}));
  await new Promise<void>(resolve=>setImmediate(resolve));const old=projection27(f),events=rows(f,'apple_purchase_status_observations');
  // Inject only after the real second handle has persisted its projection CAS,
  // so readback must validate the author despite the matching dispatch binding.
  let injected=false;
  const originalPrepare=db.prepare.bind(db);
  const resumePrepare=()=>{db.prepare=originalPrepare as typeof db.prepare;};
  db.prepare=((sql:string)=>{
    const statement=originalPrepare(sql);if(!sql.startsWith('UPDATE apple_purchase_status_projection SET'))return statement;
    return new Proxy(statement,{get(target,key){if(key==='run')return (...args:unknown[])=>{
      const r=Reflect.apply(target.run,target,args);injected=true;
      const author=originalPrepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='history'").get() as Record<string,unknown>;
      const e=parseStatusEvidenceV1(author.evidence_json);if(e.kind!=='history')assert.fail();
      assert.equal(e.bindingId,parseStatusEvidenceV1((events[0] as Record<string,unknown>).evidence_json).bindingId);
      alterRows27(secondFixture,()=>{
        if(variant==='wrong-revision')replaceRecord27(secondFixture,author,record27(author,parseStatusEvidenceV1({...e,
          requestId:evidenceDigest(['source-status-history/v2',[A.accountId,e.page.handle,e.page.pageIndex,e.page.pageDigest,0]])})));
        else for(let i=0;i<1024;i++){
          const page={...e.page,pageDigest:evidenceDigest(['synthetic-author-overflow/v1',i])};
          insertRecord27(secondFixture,record27(author,parseStatusEvidenceV1({...e,page,requestId:evidenceDigest(['source-status-history/v2',[A.accountId,page.handle,page.pageIndex,page.pageDigest,old.revision+1]])})));
        }
      });return r;
    };const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
  }) as typeof db.prepare;
  try{
    f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'live-author',hasMore:false,signedTransactions:[]});
    assert.notEqual((await two.source.forOwner(A).reconcileOwner(owner,{handle:randomUUID(),expectedPage:0})).status,'complete');
    assert.equal(injected,true);assert.deepEqual(rows(f,'apple_purchase_status_observations'),events);assert.deepEqual(projection27(f),old);
    assert.equal(rows(f,'apple_purchase_grants').length,0);
  }finally{resumePrepare();resume();await result;f.barrier();}
  assert.equal((await result).v?.status,'observed','rolled-back invalidation leaves the original legitimate refresh able to complete');
});

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


type Fixture27=Awaited<ReturnType<typeof source27Fixture>>;
async function reopen27(f:Fixture27):Promise<void> {
  f.barrier();f.base.closeMain();const opened=await openSourceSubscriptionStatusStorage(f.base.path,configuration);f.base.adopt(opened.db);
}
function newSession27(f:Fixture27) {
  const sessionId=randomUUID();
  f.base.db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)')
    .run(sessionId,f.base.now()+86400000,randomUUID(),f.base.now(),f.base.now(),A.authUserId);
  return {...A,sessionId};
}
const statusRows27=(f:Fixture27)=>f.base.db.prepare("SELECT * FROM apple_purchase_status_observations WHERE event_kind='status' ORDER BY observation_id").all();
const projection27=(f:Fixture27)=>f.base.db.prepare('SELECT * FROM apple_purchase_status_projection WHERE original_transaction_id=?').get('10000') as
  {revision:number;active_request_id:string|null;request_deadline_ms:number|null;current_observation_id:string|null;valid_until_ms:number|null;projection_json:string};

for(const reopen of [false,true])test(`COR01-H/R History later-clock explicit refresh recovers${reopen?' after same-generation reopen':''}`,async t=>{
  const f=await source27Fixture(t),facade=active(f);await facade.refreshStatus('10000','before-history');f.base.advance(5000);
  const successor=f.item(1,f.tx({transactionId:'10002',purchaseDate:f.base.now()-1000}));
  f.historyResponse({bundleId:apple.bundleId,environment:'Sandbox' as never,revision:'successor',hasMore:false,signedTransactions:[successor.signedTransactionInfo]});
  const checkpoint={handle:randomUUID(),expectedPage:0},outcome=await facade.reconcileOwner(owner,checkpoint);assert.equal(outcome.status,'complete');
  assert.deepEqual(facade.entitlements().active,[]);const before=rows(f,'apple_purchase_status_observations');
  assert.equal(before.length,4,'History adds exactly one event');assert.deepEqual(await facade.reconcileOwner(owner,checkpoint),outcome);
  assert.deepEqual(rows(f,'apple_purchase_status_observations'),before);f.base.advance(5000);
  if(reopen)await reopen27(f);
  const next=f.compose().source.forOwner(newSession27(f)),calls=f.calls();assert.equal(f.calls(),calls,'reopen/session creates no provider work');
  assert.deepEqual(next.entitlements().active,[]);f.response(f.envelope([successor]));
  assert.equal((await next.refreshStatus('10000','after-history')).status,'observed','valid held History must admit explicit HTTP refresh');
  assert.ok(f.calls()>calls);assert.deepEqual(next.entitlements().active,['form_plus']);
  for(const row of before)assert.ok(rows(f,'apple_purchase_status_observations').some(saved=>JSON.stringify(saved)===JSON.stringify(row)),'old event bytes preserved');
});

for(const variant of ['renewal-only','transaction','refund-reversed'] as const)for(const reopen of [false,true])
  test(`COR01-N/R ${variant} notification different-session later-clock refresh${reopen?' after reopen':''}`,async t=>{
    const f=await source27Fixture(t),c=f.compose(),facade=c.source.forOwner(A),first=f.item();f.response(f.envelope([first]));
    await facade.refreshStatus('10000','before-notification');f.base.advance(5000);
    const successor=f.item(1,f.tx({transactionId:'10002',purchaseDate:f.base.now()-1000}));
    const signed=f.signedNotification({notificationUUID:randomUUID(),version:'2.0',signedDate:f.base.now(),
      notificationType:variant==='refund-reversed'?'REFUND_REVERSED':variant==='transaction'?'DID_RENEW':'DID_CHANGE_RENEWAL_STATUS',
      data:{bundleId:apple.bundleId,environment:'Sandbox',...(variant==='renewal-only'?{signedRenewalInfo:f.signedRenewal(f.rn({gracePeriodExpiresDate:f.base.now()+600000}))}:{signedTransactionInfo:successor.signedTransactionInfo})}});
    const result=await c.source.ingestNotification(signed);assert.equal(result.status,variant==='refund-reversed'?'unavailable':'observed');
    assert.deepEqual(facade.entitlements().active,[],'notification alone cannot restore access');
    if(variant==='refund-reversed')assert.equal(f.base.db.prepare('SELECT 1 FROM apple_purchase_transactions WHERE transaction_id=?').get('10002'),undefined);
    const before=rows(f,'apple_purchase_status_observations');assert.equal(before.length,4);
    assert.deepEqual(await c.source.ingestNotification(signed),result);assert.deepEqual(rows(f,'apple_purchase_status_observations'),before);
    f.base.advance(5000);if(reopen)await reopen27(f);
    const next=f.compose().source.forOwner(newSession27(f)),calls=f.calls();assert.deepEqual(next.entitlements().active,[]);
    f.response(f.envelope([variant==='renewal-only'?first:successor]));
    assert.equal((await next.refreshStatus('10000','after-notification')).status,'observed','authentic background invalidation remains recoverable');
    assert.ok(f.calls()>calls);assert.deepEqual(next.entitlements().active,['form_plus']);
    for(const row of before)assert.ok(rows(f,'apple_purchase_status_observations').some(saved=>JSON.stringify(saved)===JSON.stringify(row)));
  });

for(const grace of [false,true])for(const reopen of [false,true])
  test(`COR02-P/F ${grace?'grace':'active'} exact target survives foreign permutations and changes${reopen?' across reopen':''}`,async t=>{
    const f=await source27Fixture(t),facade=active(f),started=f.base.now(),target=f.item(grace?4:1,f.tx(grace?{expiresDate:started-1}:{}),f.rn(grace?{gracePeriodExpiresDate:started+600000}:{}));
    const foreignOwner={...owner,originalTransactionId:'20000'},foreignTx=f.tx({transactionId:'20001',originalTransactionId:'20000'});
    f.seed(f.base.db,foreignOwner,foreignTx);
    const foreign=f.item(1,foreignTx,f.rn({originalTransactionId:'20000'}));
    const thirdOwner={...owner,originalTransactionId:'30000'},thirdTx=f.tx({transactionId:'30001',originalTransactionId:'30000',subscriptionGroupIdentifier:'200'});
    f.seed(f.base.db,thirdOwner,thirdTx);const third=f.item(1,thirdTx,f.rn({originalTransactionId:'30000'}));
    const envelope=(items:unknown[],reverse=false)=>({...f.envelope(items),data:reverse?
      [{subscriptionGroupIdentifier:'200',lastTransactions:[third]},{subscriptionGroupIdentifier:'100',lastTransactions:items}]:
      [{subscriptionGroupIdentifier:'100',lastTransactions:items},{subscriptionGroupIdentifier:'200',lastTransactions:[third]}]});
    const verifiedTransactions:string[]=[],verifiedRenewals:string[]=[],verify=f.verifier.verify,renewal=f.verifier.renewal;
    f.verifier.verify=jws=>{verifiedTransactions.push(jws);return verify(jws);};f.verifier.renewal=jws=>{verifiedRenewals.push(jws);return renewal(jws);};
    f.response(envelope([target,foreign]));const initial=await facade.refreshStatus('10000','multi-first');assert.equal(initial.status,'observed');
    assert.deepEqual(facade.entitlements().active,['form_plus']);const original=statusRows27(f),cutoff=projection27(f).valid_until_ms;
    assert.equal(original.length,1);assert.equal(cutoff,started+300000);
    f.base.advance(5000);if(reopen)await reopen27(f);const next=f.compose().source.forOwner(newSession27(f));
    f.response(envelope([foreign,target],true));const replay=await next.refreshStatus('10000','multi-permuted');assert.equal(replay.status,'observed');
    assert.deepEqual(replay.observationIds,initial.observationIds,'replay maps to original fact');assert.deepEqual(statusRows27(f),original,'foreign order cannot author a contradictory target fact');
    assert.deepEqual(next.entitlements().active,['form_plus']);assert.equal(projection27(f).valid_until_ms,cutoff);
    f.base.advance(5000);const changed=f.item(2,{...foreignTx,signedDate:started+10000,expiresDate:started-1},f.rn({originalTransactionId:'20000',signedDate:started+10000}));
    f.response(envelope([target,changed]));await next.refreshStatus('10000','multi-foreign-changed');
    assert.deepEqual(statusRows27(f),original);assert.equal(projection27(f).valid_until_ms,cutoff);assert.deepEqual(next.entitlements().active,['form_plus']);
    assert.deepEqual(verifiedTransactions,[target.signedTransactionInfo,foreign.signedTransactionInfo,third.signedTransactionInfo,
      third.signedTransactionInfo,foreign.signedTransactionInfo,target.signedTransactionInfo,target.signedTransactionInfo,changed.signedTransactionInfo,third.signedTransactionInfo]);
    assert.equal(verifiedRenewals.length,9);assert.ok(verifiedRenewals.includes(changed.signedRenewalInfo));
    const foreignCount=f.base.db.prepare('SELECT count(*) n FROM apple_purchase_transactions WHERE original_transaction_id<>?').get('10000');
    assert.ok(foreignCount && typeof foreignCount==='object' && 'n' in foreignCount && typeof foreignCount.n==='number');
    assert.equal(foreignCount.n,2,'foreign proofs never persist');
    f.base.advance(290000);assert.deepEqual(next.entitlements().active,[],'original five-minute equality denies');
    f.response(envelope([target,changed]));await next.refreshStatus('10000','multi-expired-replay');
    assert.deepEqual(statusRows27(f),original);assert.deepEqual(next.entitlements().active,[],'same proof cannot reset freshness');
  });
