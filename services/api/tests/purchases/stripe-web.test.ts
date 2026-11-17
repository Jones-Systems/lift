import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stripePurchaseMigrationSql, stripeApiVersion, stripeConfiguration, stripeCatalog, verifyStripeSignature,
  buildCheckoutRequest, buildPortalRequest, StripeWebPurchases, createStripeWebPurchases, mergePurchaseEntitlements,
  type StripeConfiguration, type StripeRequest } from '../../src/purchases/stripe/index.js';
import { bindSuppressionAuthority } from '../../src/lifecycle/guards.js';
import type { DisableRecord, AccountContext } from '../../src/lifecycle/types.js';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const actor: AccountContext = {accountId:A,authUserId:'userA',sessionId:'sessionA',epoch:0};
const other: AccountContext = {accountId:B,authUserId:'userB',sessionId:'sessionB',epoch:0};
const config: StripeConfiguration = {enabled:true,livemode:false,prices:{weekly:'price_week',monthly:'price_month',yearly:'price_year'},
  apiKeyEnv:'STRIPE_API_KEY',webhookSecretEnvs:['STRIPE_WEBHOOK_SECRET'],successUrl:'https://example.test/success',
  cancelUrl:'https://example.test/cancel',returnUrl:'https://example.test/account',portalConfiguration:'bpc_test'};
function sign(raw: Uint8Array, secret: string, at: number) { return `t=${at},v1=${createHmac('sha256',secret).update(at+'.').update(raw).digest('hex')}`; }
function fixture(t: TestContext) {
  mkdirSync('.scratch',{recursive:true}); const root=mkdtempSync(join('.scratch','stripe-test-'));
  const db=new Database(join(root,'test.sqlite')); db.pragma('foreign_keys=ON');db.pragma('synchronous=FULL');
  db.exec(`CREATE TABLE form_accounts(id TEXT PRIMARY KEY,auth_user_id TEXT);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,expiresAt INTEGER);
    CREATE TABLE account_lifecycle(account_id TEXT PRIMARY KEY,state TEXT,epoch INTEGER);`);
  for (const a of [actor,other]) {
    db.prepare('INSERT INTO form_accounts VALUES(?,?)').run(a.accountId,a.authUserId);
    db.prepare('INSERT INTO session VALUES(?,?,?)').run(a.sessionId,a.authUserId,Date.now()+86400000);
    db.prepare("INSERT INTO account_lifecycle VALUES(?,'active',0)").run(a.accountId);
  }
  db.exec(stripePurchaseMigrationSql); const disabled=new Map<string,DisableRecord>();
  bindSuppressionAuthority(db,{currentSequence:()=>disabled.size,lookup:id=>disabled.get(id)??null,
    recordDisable:record=>{const r={...record,sequence:disabled.size+1};disabled.set(r.accountId,r);return r;},reconcileRestore:apply=>{disabled.forEach(apply);return disabled.size;}});
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const secret=randomBytes(32).toString('hex'), at=Math.floor(Date.now()/1000); let now=at*1000;
  let subscription: Record<string,unknown> = {id:'sub_one',object:'subscription',customer:'cus_one',livemode:false,
    metadata:{form_account_id:A},status:'active',current_period_end:at+3600,cancel_at_period_end:false,
    items:{has_more:false,data:[{quantity:1,price:{id:'price_month',currency:'usd',unit_amount:2000,recurring:{interval:'month',interval_count:1}}}]}};
  const calls:StripeRequest[]=[]; let fail=false, lost=false, hook:(()=>Promise<void>)|null=null;
  const client={async request(request:StripeRequest) {
    calls.push(request);if(fail) throw new Error('synthetic transport failure');
    const value=request.path.startsWith('/v1/subscriptions/')?structuredClone(subscription):request.path.startsWith('/v1/charges/')?
      {id:'ch_one',invoice:'in_one',customer:'cus_one',livemode:false}:{id:'in_one',subscription:'sub_one',customer:'cus_one',livemode:false};
    if(hook) await hook();return value;
  }};
  const service=()=>new StripeWebPurchases(db,config,client,()=>secret,()=>now,()=>{if(lost)throw new Error('synthetic lost response');});
  const event=(type:string,n=1,created=at,changes:Record<string,unknown>={})=>{
    const payload=type.startsWith('customer.subscription.')?subscription:type==='checkout.session.completed'?
      {id:'cs_one',subscription:'sub_one',customer:'cus_one',client_reference_id:A,mode:'subscription',status:'complete'}:
      type.startsWith('invoice.')?{id:'in_one',subscription:'sub_one',customer:'cus_one'}:
      type==='charge.refunded'?{id:'ch_one',invoice:'in_one',customer:'cus_one',refunded:true}:{id:'dp_one',charge:'ch_one'};
    return Buffer.from(JSON.stringify({id:`evt_${n}`,object:'event',type,created,livemode:false,api_version:stripeApiVersion,data:{object:payload},...changes}));
  };
  return {db,at,secret,calls,disabled,service,event,send:(raw:Uint8Array)=>service().ingest(raw,sign(raw,secret,Math.floor(now/1000))),
    set:(patch:Record<string,unknown>)=>{subscription={...subscription,...patch};},advance:(s:number)=>{now+=s*1000;},
    fail:(v:boolean)=>{fail=v;},lost:(v:boolean)=>{lost=v;},hook:(v:(()=>Promise<void>)|null)=>{hook=v;}};
}
test('disabled configuration has no client, migration or runtime activation',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());assert.equal(stripeConfiguration(),null);assert.equal(createStripeWebPurchases(db),null);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'stripe_%'").all(),[]);
});
test('catalog and pure builders bind account, price, mode, references and stable idempotency',()=>{
  assert.deepEqual(Object.values(stripeCatalog).map(x=>x.amount),[700,2000,15000]);
  for(const plan of ['weekly','monthly','yearly'] as const) {
    const request=buildCheckoutRequest(config,A,plan,'checkout');
    assert.equal(request.form?.mode,'subscription');assert.equal(request.form?.client_reference_id,A);
    assert.equal(request.form?.['subscription_data[metadata][form_account_id]'],A);assert.equal(request.form?.['line_items[0][price]'],config.prices[plan]);
    assert.equal(request.idempotencyKey,buildCheckoutRequest(config,A,plan,'checkout').idempotencyKey);
    assert.notEqual(request.idempotencyKey,buildCheckoutRequest(config,B,plan,'checkout').idempotencyKey);
    assert.equal(request.apiKeyEnv,'STRIPE_API_KEY');assert.ok(!JSON.stringify(request).includes('trial_period'));
  }
  assert.equal(buildPortalRequest(config,A,'cus_one','portal').form?.configuration,'bpc_test');
});
for(const change of [{enabled:false},{prices:{...config.prices,monthly:'price_week'}},{apiKeyEnv:'sk_not_an_env'},
  {webhookSecretEnvs:[]},{successUrl:'http://example.test'},{secret:'never-allowed'}]) test('configuration rejects '+Object.keys(change)[0],()=>{
  assert.throws(()=>stripeConfiguration({...config,...change} as StripeConfiguration));
});
test('signature rotation, multiple v1 signatures, raw bytes and both tolerance boundaries',()=>{
  const secret=randomBytes(32).toString('hex'),old=randomBytes(32).toString('hex'),raw=Buffer.from('{"unicode":"é"}'),at=1000;
  const header=sign(raw,secret,at);
  assert.equal(verifyStripeSignature(raw,header,[old,secret],at),true);
  assert.equal(verifyStripeSignature(raw,header+',v1='+'0'.repeat(64),[secret],at),true);
  for(const delta of [-300,300])assert.equal(verifyStripeSignature(raw,header,[secret],at+delta),true);
  for(const delta of [-301,301])assert.equal(verifyStripeSignature(raw,header,[secret],at+delta),false);
  assert.equal(verifyStripeSignature(Buffer.concat([raw,Buffer.from(' ')]),header,[secret],at),false);
  assert.equal(verifyStripeSignature(raw,header,[old],at),false);
  for(const bad of ['',header+',t=1000','t=NaN,v1=x','t=1000,v0='+'0'.repeat(64),'t=1000,v1=xyz'])assert.equal(verifyStripeSignature(raw,bad,[secret],at),false);
  assert.equal(verifyStripeSignature(raw,header,[secret],at,0),false);
});
for(const kind of ['checkout.session.completed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted',
  'invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created']) test('durable ingestion '+kind,async t=>{
  const f=fixture(t);if(kind==='customer.subscription.deleted')f.set({status:'canceled'});
  if(kind==='invoice.payment_failed')f.set({status:'past_due'});
  const raw=f.event(kind);assert.equal((await f.send(raw)).status,'processed');
  const revoke=kind.startsWith('charge.')||kind==='invoice.payment_failed'||kind==='customer.subscription.deleted';
  assert.deepEqual(f.service().entitlements(actor).active,revoke?[]:['form_plus']);
  const count=f.calls.length;assert.equal((await f.send(raw)).code,'stripe_event_replay');assert.equal(f.calls.length,count);
  assert.equal((f.db.prepare('SELECT count(*) n FROM stripe_web_events').get() as {n:number}).n,1);
});
test('signature fails before JSON parsing or database writes',async t=>{
  const f=fixture(t);assert.equal((await f.service().ingest(Buffer.from('not-json'),'invalid')).code,'stripe_signature_invalid');
  assert.equal((f.db.prepare('SELECT count(*) n FROM stripe_web_events').get() as {n:number}).n,0);assert.equal(f.calls.length,0);
});
test('reordering and same-second contradictions use current subscription, not event ordering',async t=>{
  const f=fixture(t),old=f.event('customer.subscription.created',1,f.at-50);
  f.set({status:'canceled'});assert.equal((await f.send(f.event('customer.subscription.updated',2))).status,'processed');
  assert.equal((await f.send(old)).status,'processed');assert.deepEqual(f.service().entitlements(actor).active,[]);
  f.set({status:'active'});assert.equal((await f.send(f.event('customer.subscription.updated',3))).status,'processed');
  assert.deepEqual(f.service().entitlements(actor).active,['form_plus']);
});
test('refund and dispute revoke permanently across late events and reconciliation',async t=>{
  const f=fixture(t);await f.send(f.event('charge.refunded'));
  await f.send(f.event('invoice.paid',2));await f.service().reconcile(actor,'sub_one');
  assert.deepEqual(f.service().entitlements(actor).active,[]);
});
test('period-end cancellation retains paid access until expiry; past_due grants no unproved grace',async t=>{
  const f=fixture(t);f.set({cancel_at_period_end:true});await f.send(f.event('customer.subscription.updated'));
  assert.deepEqual(f.service().entitlements(actor).active,['form_plus']);f.advance(3600);
  assert.deepEqual(f.service().entitlements(actor).active,[]);
});
test('cross-account reads, customer binding and subscription ownership are isolated',async t=>{
  const f=fixture(t);await f.send(f.event('customer.subscription.created'));
  assert.deepEqual(f.service().entitlements(other).active,[]);assert.throws(()=>f.service().portal(other,'cus_one','portal'));
  f.set({metadata:{form_account_id:B}});assert.equal((await f.send(f.event('customer.subscription.updated',2))).status,'unknown');
  assert.deepEqual(f.service().entitlements(other).active,[]);assert.equal((await f.service().reconcile(actor,'sub_one')).status,'unknown');
});
test('lost commit response reconciles from durable event receipt without repeating transport',async t=>{
  const f=fixture(t),raw=f.event('checkout.session.completed');f.lost(true);assert.equal((await f.send(raw)).status,'unknown');
  f.lost(false);const calls=f.calls.length;assert.equal((await f.send(raw)).status,'processed');assert.equal(f.calls.length,calls);
  assert.equal((await f.service().reconcile(actor,'sub_one')).status,'processed');
});
test('missing event can be recovered by account-bound subscription re-fetch',async t=>{
  const f=fixture(t);assert.equal((await f.service().reconcile(other,'sub_one')).status,'unknown');
  assert.equal((await f.service().reconcile(actor,'sub_one')).status,'processed');assert.deepEqual(f.service().entitlements(actor).active,['form_plus']);
});
test('transport uncertainty leaves pending event and does not invent a grant',async t=>{
  const f=fixture(t);f.fail(true);const raw=f.event('invoice.paid');assert.equal((await f.send(raw)).status,'unknown');
  assert.deepEqual(f.service().entitlements(actor).active,[]);f.fail(false);assert.equal((await f.send(raw)).status,'processed');
});
test('event ID collision, environment and API-version mismatches never alter entitlement',async t=>{
  const f=fixture(t);await f.send(f.event('invoice.paid'));
  assert.equal((await f.send(f.event('invoice.payment_failed'))).code,'stripe_event_collision');
  for(const changes of [{livemode:true},{api_version:'unqualified'},{account:'acct_foreign'}])assert.equal((await f.send(f.event('invoice.paid',2,f.at,changes))).status,'rejected');
});
test('concurrent current-state refresh cannot overwrite a newer committed fetch',async t=>{
  const f=fixture(t);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});f.hook(()=>gate);
  const pending=f.send(f.event('customer.subscription.created'));await Promise.resolve();f.hook(null);f.set({status:'canceled'});
  assert.equal((await f.send(f.event('customer.subscription.updated',2))).status,'processed');release();
  assert.equal((await pending).status,'pending');assert.deepEqual(f.service().entitlements(actor).active,[]);
});
test('deterministic channel merge retains access from either active channel',async t=>{
  const f=fixture(t);await f.send(f.event('invoice.paid'));
  const apple={id:'apple-grant',entitlement:'form_plus',source:'apple' as const,sourceId:'1001',grantedAt:new Date().toISOString(),expiresAt:null,environment:'Sandbox' as const,active:true};
  assert.deepEqual(mergePurchaseEntitlements({grants:[{...apple,active:false}]},f.service().entitlements(actor)).active,['form_plus']);
  await f.send(f.event('charge.refunded',2));const result=mergePurchaseEntitlements({grants:[apple]},f.service().entitlements(actor));
  assert.deepEqual(result.active,['form_plus']);assert.deepEqual(result.grants.map(g=>g.source),['apple','stripe']);
  assert.deepEqual(mergePurchaseEntitlements({grants:[{...apple,active:false}]},f.service().entitlements(actor)).active,[]);
});
test('lifecycle exports linkage and records pending_external cancellation without HTTP',async t=>{
  const f=fixture(t);await f.send(f.event('invoice.paid'));const lifecycle=f.service().lifecycle(),exported:unknown[]=[];
  lifecycle.export(actor,{snapshotAtMs:Date.now(),append:(_category,v)=>exported.push(v)});
  assert.match(JSON.stringify(exported),/sub_one/);assert.match(JSON.stringify(exported),/cus_one/);assert.ok(!JSON.stringify(exported).includes(f.secret));
  const calls=f.calls.length;f.disabled.set(A,{accountId:A,authUserId:'userA',epoch:1,requestId:'delete',disabledAtMs:Date.now(),sequence:1});
  assert.equal(lifecycle.suppress(A,1).status,'complete');assert.equal(lifecycle.verifySuppressed(A,1).status,'complete');
  assert.equal(lifecycle.purge('delete',A).reason,'pending_external');assert.equal(f.calls.length,calls);
  assert.equal((f.db.prepare('SELECT state FROM stripe_web_cancellations').get() as {state:string}).state,'pending_external');
  assert.throws(()=>f.service().entitlements(actor));assert.equal((await f.send(f.event('invoice.paid',2))).status,'unknown');
});
test('test/live configuration cannot reinterpret a persisted store',async t=>{
  const f=fixture(t);f.service();assert.throws(()=>new StripeWebPurchases(f.db,{...config,livemode:true},{request:async()=>null},()=>f.secret));
});
test('known refund revokes without fetching subscription state',async t=>{
  const f=fixture(t);await f.send(f.event('invoice.paid'));const before=f.calls.filter(c=>c.path.startsWith('/v1/subscriptions/')).length;
  assert.equal((await f.send(f.event('charge.refunded',2))).status,'processed');
  assert.equal(f.calls.filter(c=>c.path.startsWith('/v1/subscriptions/')).length,before);assert.deepEqual(f.service().entitlements(actor).active,[]);
});
test('receipt failure rolls back subscription/grant together and keeps retry explicit',async t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON stripe_web_events BEGIN SELECT RAISE(ABORT,'synthetic');END");
  const raw=f.event('invoice.paid');assert.equal((await f.send(raw)).status,'unknown');assert.deepEqual(f.service().entitlements(actor).active,[]);
  assert.equal((f.db.prepare('SELECT state FROM stripe_web_events').get() as {state:string}).state,'pending');
  f.db.exec('DROP TRIGGER fail_receipt');assert.equal((await f.send(raw)).status,'processed');
});
test('disable during provider read prevents a late grant',async t=>{
  const f=fixture(t);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});f.hook(()=>gate);
  const pending=f.send(f.event('invoice.paid'));await Promise.resolve();
  f.disabled.set(A,{accountId:A,authUserId:'userA',epoch:1,requestId:'delete',disabledAtMs:Date.now(),sequence:1});release();
  assert.equal((await pending).status,'unknown');assert.equal((f.db.prepare('SELECT count(*) n FROM stripe_web_subscriptions').get() as {n:number}).n,0);
});
for(const change of [{current_period_end:-1},{items:{has_more:true,data:[]}},{items:{has_more:false,data:[{quantity:1,price:{id:'price_month',currency:'eur',unit_amount:2000,recurring:{interval:'month',interval_count:1}}}]}},
  {customer:'cus_other'},{id:'sub_other'}]) test('invalid provider state cannot grant: '+JSON.stringify(change),async t=>{
  const f=fixture(t);f.set(change);assert.equal((await f.send(f.event('invoice.paid'))).status,'unknown');assert.deepEqual(f.service().entitlements(actor).active,[]);
});
