import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stripeWebMigration, stripeWebTables, stripeApiVersion, stripeConfiguration, stripeCatalog, verifyStripeSignature,
  buildCheckoutRequest, buildPortalRequest, buildCancellationRequest, StripeWebPurchases, createStripeWebPurchases, proposePurchaseAccessMerge,
  createStripeEntitlementSource, stripeLifecycleContributor, stripeLifecycleTableCoverage,
  type StripeConfiguration, type StripeRequest, type OtherChannel } from '../../src/purchases/stripe/index.js';
import { bindSuppressionAuthority } from '../../src/lifecycle/guards.js';
import type { DisableRecord, AccountContext } from '../../src/lifecycle/types.js';
import type { AppleEntitlementGrant } from '../../src/purchases/types.js';
type J = Record<string, unknown>;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const actor: AccountContext = {accountId:A,authUserId:'userA',sessionId:'sessionA',epoch:0};
const other: AccountContext = {accountId:B,authUserId:'userB',sessionId:'sessionB',epoch:0};
const config: StripeConfiguration = {enabled:true,livemode:false,stripeAccount:'acct_test',prices:{weekly:'price_week',monthly:'price_month',yearly:'price_year'},
  apiKeyEnv:'STRIPE_API_KEY',webhookSecretEnvs:['STRIPE_WEBHOOK_SECRET'],successUrl:'https://example.test/success',
  cancelUrl:'https://example.test/cancel',returnUrl:'https://example.test/account',portalConfiguration:'bpc_test'};
const clone = <T>(x: T): T => structuredClone(x);
function sign(raw: Uint8Array, secret: string, at: number) { return `t=${at},v1=${createHmac('sha256',secret).update(at+'.').update(raw).digest('hex')}`; }
function fixture(t: TestContext, options: { refs?: string[]; secrets?: (secret: string) => Record<string, string | undefined> } = {}) {
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
  db.exec(stripeWebMigration.sql); const disabled=new Map<string,DisableRecord>();
  bindSuppressionAuthority(db,{currentSequence:()=>disabled.size,lookup:id=>disabled.get(id)??null,
    recordDisable:record=>{const r={...record,sequence:disabled.size+1};disabled.set(r.accountId,r);return r;},reconcileRestore:apply=>{disabled.forEach(apply);return disabled.size;}});
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const secret=randomBytes(32).toString('hex'), at=Math.floor(Date.now()/1000); let now=at*1000;
  const cfg: StripeConfiguration = {...config,webhookSecretEnvs:options.refs??config.webhookSecretEnvs};
  const secrets=options.secrets?.(secret)??{STRIPE_WEBHOOK_SECRET:secret};
  const price=(id='price_month',changes:J={}):J=>({id,currency:'usd',unit_amount:2000,recurring:{interval:'month',interval_count:1},...changes});
  const subscription=(id='sub_one',customer='cus_one',changes:J={}):J=>({id,object:'subscription',customer,livemode:false,status:'active',
    created:at-86400,current_period_start:at-60,current_period_end:at+3600,cancel_at_period_end:false,latest_invoice:'in_one',metadata:{form_account_id:A},
    items:{object:'list',has_more:false,data:[{quantity:1,price:price()}]},...changes});
  const session=(changes:J={}):J=>({id:'cs_one',object:'checkout.session',livemode:false,mode:'subscription',status:'complete',payment_link:null,
    subscription:'sub_one',customer:'cus_one',client_reference_id:A,...changes});
  const dispute=(changes:J={}):J=>({id:'dp_one',object:'dispute',livemode:false,charge:'ch_one',status:'needs_response',amount:2000,currency:'usd',...changes});
  const stripe={subscriptions:new Map<string,J>([['sub_one',subscription()]]),
    invoices:new Map<string,J>([['in_one',{id:'in_one',object:'invoice',livemode:false,currency:'usd',customer:'cus_one',subscription:'sub_one',charge:'ch_one'}]]),
    charges:new Map<string,J>([['ch_one',{id:'ch_one',object:'charge',livemode:false,currency:'usd',amount:2000,amount_refunded:0,refunded:false,customer:'cus_one',invoice:'in_one'}]]),
    sessions:new Map<string,J[]>([['sub_one',[session()]]]),disputes:new Map<string,J[]>(),hasMore:false};
  const calls:StripeRequest[]=[], guardCalls:unknown[]=[], published:unknown[]=[];
  let failPath:string|null=null, lost=false, hook:((request:StripeRequest)=>Promise<void>)|null=null, channel:OtherChannel|'throw'|'invalid'='none';
  const client={async request(request:StripeRequest) {
    calls.push(request);if(failPath!==null&&request.path.startsWith(failPath)) throw new Error('synthetic transport failure');
    if(hook) await hook(request);
    const url=new URL('https://api.stripe.test'+request.path), [, , kind, id]=url.pathname.split('/'), missing=():never=>{throw new Error('synthetic not found');};
    const list=(data:J[]|undefined)=>({object:'list',has_more:stripe.hasMore,data:clone(data??[])});
    if(kind==='subscriptions') { const s=stripe.subscriptions.get(id!)??missing(); return request.method==='DELETE'?{...clone(s),status:'canceled'}:clone(s); }
    if(kind==='invoices') return clone(stripe.invoices.get(id!)??missing());
    if(kind==='charges') return clone(stripe.charges.get(id!)??missing());
    if(kind==='checkout') return list(stripe.sessions.get(url.searchParams.get('subscription')!));
    if(kind==='disputes') return list(stripe.disputes.get(url.searchParams.get('charge')!));
    return missing();
  }};
  const service=(c:StripeConfiguration=cfg)=>new StripeWebPurchases(db,c,{client,secret:ref=>secrets[ref],
    activeOtherChannel:ctx=>{guardCalls.push(ctx);if(channel==='throw')throw new Error('synthetic guard failure');return channel as OtherChannel;},
    clock:()=>now,publish:notice=>{if(lost)throw new Error('synthetic lost response');published.push(notice);}});
  const payload=(type:string):J=>type==='checkout.session.completed'?session():type.startsWith('customer.subscription.')?clone(stripe.subscriptions.get('sub_one')!)
    :type.startsWith('invoice.')?clone(stripe.invoices.get('in_one')!):type==='charge.refunded'?{...clone(stripe.charges.get('ch_one')!),refunded:true,amount_refunded:2000}
    :type==='charge.dispute.closed'?dispute({status:'won'}):dispute();
  const event=(type:string,n=1,o:{payload?:J;created?:number;envelope?:J}={})=>Buffer.from(JSON.stringify({id:`evt_${n}`,object:'event',type,
    created:o.created??at,livemode:false,api_version:stripeApiVersion,pending_webhooks:1,request:{id:null,idempotency_key:null},data:{object:o.payload??payload(type)},...o.envelope}));
  const send=(raw:Uint8Array,svc=service())=>svc.ingest(raw,sign(raw,secret,Math.floor(now/1000)));
  return {db,at,secret,cfg,stripe,calls,guardCalls,published,disabled,service,event,send,session,dispute,subscription,price,
    observe:(ctx:AccountContext=actor,svc=service())=>createStripeEntitlementSource(svc).observe(ctx),
    count:(table:string)=>(db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,
    sub:(id='sub_one')=>stripe.subscriptions.get(id)!,
    bind:async(n=0)=>{assert.equal((await send(event('checkout.session.completed',n))).status,'processed');},
    advance:(s:number)=>{now+=s*1000;},fail:(path:string|null)=>{failPath=path;},lost:(v:boolean)=>{lost=v;},
    hook:(v:((request:StripeRequest)=>Promise<void>)|null)=>{hook=v;},channel:(v:OtherChannel|'throw'|'invalid')=>{channel=v;},
    disable:(id=A)=>{disabled.set(id,{accountId:id,authUserId:id===A?'userA':'userB',epoch:1,requestId:'delete',disabledAtMs:now,sequence:disabled.size+1});}};
}
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};};

test('disabled configuration has no client, migration or runtime activation; schema is named, not numbered',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());assert.equal(stripeConfiguration(),null);assert.equal(createStripeWebPurchases(db),null);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'stripe_%'").all(),[]);
  assert.equal(stripeWebMigration.name,'stripe-web-subscriptions-v1');assert.ok(!('version' in stripeWebMigration));
});
test('catalog and pure builders bind account, price, mode, references and stable idempotency',()=>{
  assert.deepEqual(Object.values(stripeCatalog).map(x=>x.amount),[700,2000,15000]);
  for(const plan of ['weekly','monthly','yearly'] as const) {
    const request=buildCheckoutRequest(config,A,plan,'checkout');
    assert.equal(request.form?.mode,'subscription');assert.equal(request.form?.client_reference_id,A);assert.equal(request.form?.currency,'usd');
    assert.equal(request.form?.['subscription_data[metadata][form_account_id]'],A);assert.equal(request.form?.['line_items[0][price]'],config.prices[plan]);
    assert.equal(request.idempotencyKey,buildCheckoutRequest(config,A,plan,'checkout').idempotencyKey);
    assert.notEqual(request.idempotencyKey,buildCheckoutRequest(config,B,plan,'checkout').idempotencyKey);
    assert.equal(request.apiKeyEnv,'STRIPE_API_KEY');assert.ok(!JSON.stringify(request).includes('trial_period'));
  }
  assert.equal(buildPortalRequest(config,A,'cus_one','portal').form?.configuration,'bpc_test');
  const cancel=buildCancellationRequest(config,A,'sub_one');assert.equal(cancel.method,'DELETE');assert.equal(cancel.path,'/v1/subscriptions/sub_one');
  assert.equal(cancel.idempotencyKey,buildCancellationRequest(config,A,'sub_one').idempotencyKey);assert.equal(cancel.form,undefined);
});
for(const change of [{enabled:false},{prices:{...config.prices,monthly:'price_week'}},{apiKeyEnv:'sk_not_an_env'},{stripeAccount:'acct-bad'},
  {webhookSecretEnvs:[]},{successUrl:'http://example.test'},{secret:'never-allowed'}]) test('configuration rejects '+JSON.stringify(change),()=>{
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
test('signature accepts at most ten v1 entries',()=>{
  const secret=randomBytes(32).toString('hex'),raw=Buffer.from('{}'),at=1000,junk=',v1='+'0'.repeat(64),valid=sign(raw,secret,at);
  assert.equal(verifyStripeSignature(raw,valid+junk.repeat(9),[secret],at),true);
  assert.equal(verifyStripeSignature(raw,valid+junk.repeat(10),[secret],at),false);
});
const expected: Record<string,[string,boolean|null]> = {'checkout.session.completed':['observed',true],'customer.subscription.created':['observed',true],
  'customer.subscription.updated':['observed',true],'customer.subscription.deleted':['observed',false],'invoice.paid':['observed',true],
  'invoice.payment_failed':['observed',false],'charge.refunded':['observed',false],'charge.dispute.created':['pending',null],'charge.dispute.closed':['observed',true]};
for(const kind of Object.keys(expected)) test('durable ingestion '+kind,async t=>{
  const f=fixture(t);if(kind!=='checkout.session.completed')await f.bind();
  if(kind==='customer.subscription.deleted')f.sub().status='canceled';
  if(kind==='invoice.payment_failed')f.sub().status='past_due';
  const raw=f.event(kind);assert.equal((await f.send(raw)).status,'processed');
  const observed=f.observe();assert.equal(observed.status,expected[kind]![0]);assert.equal(observed.entitlement?.active??null,expected[kind]![1]);
  const count=f.calls.length;assert.equal((await f.send(raw)).code,'stripe_event_replay');assert.equal(f.calls.length,count);
  assert.equal((f.db.prepare("SELECT count(*) n FROM stripe_web_events WHERE event_id='evt_1'").get() as {n:number}).n,1);
});
test('signature fails before JSON parsing or database writes',async t=>{
  const f=fixture(t);assert.equal((await f.service().ingest(Buffer.from('not-json'),'invalid')).code,'stripe_signature_invalid');
  assert.equal(f.count('stripe_web_events'),0);assert.equal(f.calls.length,0);
});
test('ingest skips unresolved secret references and fails closed only when none resolve',async t=>{
  const refs=['STRIPE_WEBHOOK_OLD','STRIPE_WEBHOOK_SECRET','STRIPE_WEBHOOK_NEXT'];
  const f=fixture(t,{refs,secrets:s=>({STRIPE_WEBHOOK_OLD:undefined,STRIPE_WEBHOOK_SECRET:randomBytes(32).toString('hex'),STRIPE_WEBHOOK_NEXT:s})});
  assert.deepEqual(await f.send(f.event('checkout.session.completed')),{status:'processed',code:'stripe_event_applied'});
  const none=fixture(t,{refs,secrets:()=>({STRIPE_WEBHOOK_NEXT:''})});
  assert.deepEqual(await none.send(none.event('checkout.session.completed')),{status:'unavailable',code:'stripe_signing_secret_unavailable'});
  assert.equal(none.calls.length,0);assert.equal(none.count('stripe_web_events'),0);
});
test('reordering and same-second contradictions use current subscription, not event ordering',async t=>{
  const f=fixture(t);await f.bind();const old=f.event('customer.subscription.created',1,{created:f.at-50});
  f.sub().status='canceled';assert.equal((await f.send(f.event('customer.subscription.updated',2))).status,'processed');
  assert.equal((await f.send(old)).status,'processed');assert.equal(f.observe().entitlement?.active,false);
  f.sub().status='active';assert.equal((await f.send(f.event('customer.subscription.updated',3))).status,'processed');
  assert.equal(f.observe().entitlement?.active,true);assert.equal(f.observe().evidence.eventHighWater,f.at);
});
test('full refund revokes permanently and records a built, unsent cancellation',async t=>{
  const f=fixture(t);await f.bind();assert.deepEqual(await f.send(f.event('charge.refunded')),{status:'processed',code:'stripe_revoked'});
  Object.assign(f.stripe.charges.get('ch_one')!,{refunded:true,amount_refunded:2000});
  assert.equal((await f.send(f.event('invoice.paid',2))).status,'processed');assert.equal((await f.service().reconcile(actor,'sub_one')).status,'processed');
  assert.equal(f.observe().entitlement?.active,false);
  const [cancel,...rest]=f.service().cancellations();assert.equal(rest.length,0);
  assert.equal(cancel?.state,'pending_external');assert.equal(cancel?.reason,'revoked');assert.deepEqual(cancel?.request,buildCancellationRequest(f.cfg,A,'sub_one'));
  assert.equal(f.calls.filter(c=>c.method==='DELETE').length,0);
  assert.throws(()=>f.db.prepare('UPDATE stripe_web_subscriptions SET revoked=0,revision=revision+1').run(),/stripe_sticky_denial/);
});
test('partial refund does not revoke or cancel',async t=>{
  const f=fixture(t);await f.bind();
  const raw=f.event('charge.refunded',1,{payload:{...f.stripe.charges.get('ch_one'),refunded:false,amount_refunded:500}});
  assert.deepEqual(await f.send(raw),{status:'processed',code:'stripe_partial_refund_not_revoked'});
  assert.equal(f.observe().entitlement?.active,true);assert.deepEqual(f.service().cancellations(),[]);
});
test('dispute created suspends without cancelling; dispute won restores',async t=>{
  const f=fixture(t);await f.bind();assert.deepEqual(await f.send(f.event('charge.dispute.created')),{status:'processed',code:'stripe_suspended'});
  assert.equal(f.observe().status,'pending');assert.equal(f.observe().entitlement,null);assert.deepEqual(f.service().cancellations(),[]);
  assert.deepEqual(await f.send(f.event('charge.dispute.closed',2,{payload:f.dispute({status:'won'})})),{status:'processed',code:'stripe_restored'});
  assert.equal(f.observe().status,'observed');assert.equal(f.observe().entitlement?.active,true);
  assert.equal(f.calls.filter(c=>c.method==='DELETE').length,0);assert.deepEqual(f.service().cancellations(),[]);
});
test('dispute lost revokes permanently and records cancellation',async t=>{
  const f=fixture(t);await f.bind();await f.send(f.event('charge.dispute.created'));
  assert.deepEqual(await f.send(f.event('charge.dispute.closed',2,{payload:f.dispute({status:'lost'})})),{status:'processed',code:'stripe_revoked'});
  assert.equal(f.observe().status,'observed');assert.equal(f.observe().entitlement?.active,false);
  assert.equal(f.service().cancellations()[0]?.reason,'revoked');assert.equal(f.calls.filter(c=>c.method==='DELETE').length,0);
});
test('conflicting dispute outcomes stay held and replaying the earlier variant cannot unhold them',async t=>{
  const f=fixture(t);await f.bind();const won=f.event('charge.dispute.closed',1,{payload:f.dispute({status:'won'})});
  assert.equal((await f.send(won)).status,'processed');
  assert.deepEqual(await f.send(f.event('charge.dispute.closed',2,{payload:f.dispute({status:'lost'})})),{status:'rejected',code:'stripe_dispute_variant_held'});
  assert.equal(f.observe().status,'rejected');assert.equal(f.observe().entitlement,null);
  assert.equal((await f.send(won)).code,'stripe_event_replay');assert.equal((await f.send(f.event('charge.dispute.closed',3,{payload:f.dispute({status:'won'})}))).status,'processed');
  assert.equal(f.observe().status,'rejected');assert.deepEqual(f.service().heldConflicts(actor).map(c=>c.kind),['dispute_variant']);
  assert.throws(()=>f.db.prepare('DELETE FROM stripe_web_conflicts').run(),/stripe_conflict_held/);
});
test('period-end cancellation retains paid access until expiry; past_due grants no unproved grace',async t=>{
  const f=fixture(t);f.sub().cancel_at_period_end=true;await f.bind();
  assert.equal(f.observe().entitlement?.active,true);assert.equal(f.observe().entitlement?.effectiveExpiresAtMs,(f.at+3600)*1000);
  f.advance(3600);assert.equal(f.observe().entitlement?.active,false);
});
test('account binding comes only from Checkout and reuse for another account is held, never rebound',async t=>{
  const f=fixture(t);await f.bind();
  assert.equal(f.observe(other).entitlement,null);assert.throws(()=>f.service().portal(other,'cus_one','portal'));
  f.sub().metadata={form_account_id:B};
  assert.equal((await f.send(f.event('customer.subscription.updated',1))).status,'processed');assert.equal(f.observe().entitlement?.active,true);
  const reuse=f.event('checkout.session.completed',2,{payload:f.session({id:'cs_two',client_reference_id:B})});
  assert.deepEqual(await f.send(reuse),{status:'rejected',code:'stripe_binding_conflict'});
  f.stripe.subscriptions.set('sub_two',f.subscription('sub_two','cus_one'));
  const customer=f.event('checkout.session.completed',3,{payload:f.session({id:'cs_three',subscription:'sub_two',client_reference_id:B})});
  assert.deepEqual(await f.send(customer),{status:'rejected',code:'stripe_binding_conflict'});
  assert.equal(f.observe().status,'rejected');assert.equal(f.observe().entitlement,null);assert.equal(f.observe(other).entitlement,null);
  assert.equal((await f.send(f.event('checkout.session.completed',0))).code,'stripe_event_replay');assert.equal(f.observe().status,'rejected');
  assert.deepEqual(f.service().heldConflicts(actor).map(c=>c.kind),['binding','binding']);assert.deepEqual(f.service().heldConflicts(other),[]);
  assert.deepEqual(f.db.prepare('SELECT DISTINCT account_id FROM stripe_web_customers UNION SELECT DISTINCT account_id FROM stripe_web_subscriptions').all(),[{account_id:A}]);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM stripe_web_conflicts').all()).includes(B),false);
  assert.equal((await f.service().reconcile(other,'sub_one')).code,'stripe_subscription_not_owned');
});
test('client_reference_id must name an existing account and match the reconciling account',async t=>{
  const f=fixture(t);
  for(const [n,ref] of [[1,null],[2,'not-a-uuid']] as const)
    assert.deepEqual(await f.send(f.event('checkout.session.completed',n,{payload:f.session({client_reference_id:ref})})),{status:'rejected',code:'stripe_client_reference_invalid'});
  assert.deepEqual(await f.send(f.event('checkout.session.completed',3,{payload:f.session({client_reference_id:'33333333-3333-4333-8333-333333333333'})})),
    {status:'rejected',code:'stripe_account_unknown'});
  assert.deepEqual(await f.service().reconcile(other,'sub_one'),{status:'rejected',code:'stripe_client_reference_mismatch'});
  for(const table of ['stripe_web_customers','stripe_web_subscriptions','stripe_web_events'])assert.equal(f.count(table),0);
});
test('checkout.session.completed with a null subscription or a Payment Link is rejected before any read',async t=>{
  const f=fixture(t);
  assert.deepEqual(await f.send(f.event('checkout.session.completed',1,{payload:f.session({subscription:null})})),{status:'rejected',code:'stripe_checkout_subscription_missing'});
  assert.deepEqual(await f.send(f.event('checkout.session.completed',2,{payload:f.session({payment_link:'plink_one'})})),{status:'rejected',code:'stripe_checkout_not_server_created'});
  assert.equal(f.calls.length,0);assert.equal(f.count('stripe_web_subscriptions'),0);
});
test('events for an unbound subscription wait for Checkout binding and then apply',async t=>{
  const f=fixture(t);
  for(const [n,kind] of [[1,'customer.subscription.updated'],[2,'invoice.paid'],[3,'charge.refunded']] as const)
    assert.deepEqual(await f.send(f.event(kind,n)),{status:'pending',code:'stripe_binding_pending'});
  assert.equal(f.count('stripe_web_subscriptions'),0);assert.equal(f.count('stripe_web_events'),0);
  await f.bind();assert.equal(f.observe().entitlement?.active,true);
  assert.deepEqual(await f.send(f.event('customer.subscription.updated',1)),{status:'processed',code:'stripe_event_applied'});
});
test('lost commit response reconciles from durable event receipt without repeating transport',async t=>{
  const f=fixture(t),raw=f.event('checkout.session.completed');f.lost(true);assert.deepEqual(await f.send(raw),{status:'unknown',code:'stripe_response_unknown'});
  f.lost(false);const calls=f.calls.length;assert.equal((await f.send(raw)).code,'stripe_event_replay');assert.equal(f.calls.length,calls);
  assert.equal((await f.service().reconcile(actor,'sub_one')).status,'processed');
});
test('missing Checkout event is recovered by account-bound reconcile from the same Session evidence',async t=>{
  const f=fixture(t);assert.equal((await f.service().reconcile(other,'sub_one')).status,'rejected');
  assert.deepEqual(await f.service().reconcile(actor,'sub_one'),{status:'processed',code:'stripe_reconciled'});
  const observed=f.observe();assert.equal(observed.entitlement?.active,true);assert.equal(observed.evidence.eventHighWater,null);
  assert.equal(f.service().grants(actor)[0]?.grantedAt,new Date((f.at-86400)*1000).toISOString());
});
test('reconcile after a missed refund reads the latest invoice charge and revokes',async t=>{
  const f=fixture(t);await f.bind();Object.assign(f.stripe.charges.get('ch_one')!,{refunded:true,amount_refunded:2000});
  assert.deepEqual(await f.service().reconcile(actor,'sub_one'),{status:'processed',code:'stripe_revoked'});
  assert.equal(f.observe().entitlement?.active,false);assert.equal(f.service().cancellations()[0]?.state,'pending_external');
  assert.ok(['/v1/invoices/in_one','/v1/charges/ch_one','/v1/disputes?charge=ch_one'].every(p=>f.calls.some(c=>c.path===p)));
});
test('reconcile reads disputes and is unknown, never processed, when a fact cannot be read',async t=>{
  const f=fixture(t);await f.bind();
  for(const path of ['/v1/invoices/','/v1/charges/','/v1/disputes']) {
    f.fail(path);assert.deepEqual(await f.service().reconcile(actor,'sub_one'),{status:'unknown',code:'stripe_reconciliation_unknown'});
  }
  f.fail(null);f.stripe.hasMore=true;assert.equal((await f.service().reconcile(actor,'sub_one')).status,'unknown');f.stripe.hasMore=false;
  assert.equal(f.observe().entitlement?.active,true);
  f.stripe.disputes.set('ch_one',[f.dispute()]);assert.equal((await f.service().reconcile(actor,'sub_one')).code,'stripe_suspended');
  assert.equal(f.observe().status,'pending');
  f.stripe.disputes.set('ch_one',[f.dispute({status:'lost'})]);assert.equal((await f.service().reconcile(actor,'sub_one')).code,'stripe_revoked');
  assert.equal(f.observe().entitlement?.active,false);
});
test('transport uncertainty stores nothing, invents no grant and allows retry',async t=>{
  const f=fixture(t);f.fail('/v1/');const raw=f.event('checkout.session.completed');assert.equal((await f.send(raw)).status,'unknown');
  assert.equal(f.observe().entitlement,null);assert.equal(f.count('stripe_web_events'),0);
  f.fail(null);assert.deepEqual(await f.send(raw),{status:'processed',code:'stripe_event_applied'});
});
test('redelivery with a different envelope is acknowledged as processed',async t=>{
  const f=fixture(t);await f.bind();assert.equal((await f.send(f.event('invoice.paid'))).code,'stripe_event_applied');const calls=f.calls.length;
  const redelivered=f.event('invoice.paid',1,{envelope:{pending_webhooks:3,request:{id:'req_retry',idempotency_key:null}}});
  assert.deepEqual(await f.send(redelivered),{status:'processed',code:'stripe_event_replay'});assert.equal(f.calls.length,calls);
});
test('same event ID with different object facts is held and the earlier variant cannot unhold it',async t=>{
  const f=fixture(t);await f.bind();const raw=f.event('invoice.paid');await f.send(raw);
  assert.deepEqual(await f.send(f.event('invoice.payment_failed')),{status:'rejected',code:'stripe_event_variant_held'});
  assert.equal(f.observe().status,'rejected');assert.deepEqual(await f.send(raw),{status:'rejected',code:'stripe_conflict_held'});
  assert.equal(f.observe().status,'rejected');assert.deepEqual(f.service().heldConflicts(actor).map(c=>[c.kind,c.eventRef]),[['event_variant','evt_1']]);
});
test('environment, API-version and Connect mismatches never alter entitlement',async t=>{
  const f=fixture(t);await f.bind();
  for(const envelope of [{livemode:true},{api_version:'unqualified'},{account:'acct_foreign'}])
    assert.equal((await f.send(f.event('customer.subscription.updated',2,{envelope}))).status,'rejected');
  assert.equal(f.count('stripe_web_events'),1);
});
test('concurrent duplicate delivery applies once',async t=>{
  const f=fixture(t);await f.bind();const raw=f.event('invoice.paid');const results=await Promise.all([f.send(raw),f.send(raw)]);
  assert.deepEqual(results.map(r=>r.code).sort(),['stripe_event_applied','stripe_event_replay']);
  assert.equal((f.db.prepare("SELECT count(*) n FROM stripe_web_events WHERE event_id='evt_1'").get() as {n:number}).n,1);
});
test('concurrent refresh of one subscription cannot overwrite a newer committed fetch',async t=>{
  const f=fixture(t);await f.bind();const g=gate();f.hook(()=>g.promise);
  const pending=f.send(f.event('customer.subscription.updated',1));f.hook(null);f.sub().status='canceled';
  assert.equal((await f.send(f.event('customer.subscription.updated',2))).status,'processed');g.release();
  assert.deepEqual(await pending,{status:'pending',code:'stripe_concurrent_refresh'});assert.equal(f.observe().entitlement?.active,false);
});
test('the refresh fence is per subscription, not store-wide',async t=>{
  const f=fixture(t);await f.bind();f.stripe.subscriptions.set('sub_two',f.subscription('sub_two','cus_two'));
  await f.send(f.event('checkout.session.completed',9,{payload:f.session({id:'cs_two',subscription:'sub_two',customer:'cus_two',client_reference_id:B})}));
  const g=gate();f.hook(()=>g.promise);const pending=f.send(f.event('customer.subscription.updated',1));f.hook(null);
  assert.equal((await f.send(f.event('customer.subscription.updated',2,{payload:f.sub('sub_two')}))).status,'processed');g.release();
  assert.deepEqual(await pending,{status:'processed',code:'stripe_event_applied'});
  assert.equal(f.observe().entitlement?.active,true);assert.equal(f.observe(other).entitlement?.active,true);
});
test('portal switch to an unconfigured or mismatched price ends the grant',async t=>{
  for(const item of [{quantity:1,price:{id:'price_other',currency:'usd',unit_amount:2500,recurring:{interval:'month',interval_count:1}}},
    {quantity:1,price:{id:'price_month',currency:'usd',unit_amount:2100,recurring:{interval:'month',interval_count:1}}},{quantity:2,price:{id:'price_month',currency:'usd',unit_amount:2000,recurring:{interval:'month',interval_count:1}}}]) {
    const f=fixture(t);await f.bind();assert.equal(f.observe().entitlement?.active,true);
    f.sub().items={object:'list',has_more:false,data:[item]};
    assert.deepEqual(await f.send(f.event('customer.subscription.updated')),{status:'processed',code:'stripe_event_applied'});
    assert.equal(f.observe().status,'observed');assert.equal(f.observe().entitlement,null);assert.equal(f.service().grants(actor)[0]?.active,false);
  }
});
test('merge proposal grants access when either channel is active and is independent of input order',async t=>{
  const f=fixture(t);await f.bind();const stripe=f.service().grants(actor);
  const apple=(id:string,active:boolean):AppleEntitlementGrant=>({id,entitlement:'form_plus',source:'apple',sourceId:'1001',grantedAt:new Date(0).toISOString(),expiresAt:null,environment:'Sandbox',active});
  const inactive=stripe.map(g=>({...g,active:false}));
  assert.deepEqual(proposePurchaseAccessMerge({grants:[apple('a',false)]},{grants:stripe}).active,['form_plus']);
  assert.deepEqual(proposePurchaseAccessMerge({grants:[apple('a',true)]},{grants:inactive}).active,['form_plus']);
  assert.deepEqual(proposePurchaseAccessMerge({grants:[apple('a',false)]},{grants:inactive}).active,[]);
  const both=proposePurchaseAccessMerge({grants:[apple('a',true)]},{grants:stripe});
  assert.deepEqual([both.kind,both.rule,both.selecting,both.dualChannel,both.channels],['proposal','either_channel_active',false,true,{apple:true,stripe:true}]);
  const appleGrants=[apple('a',false),apple('Z',true)],stripeGrants=[...stripe,{...stripe[0]!,id:'stripe:sub_zz',sourceId:'sub_zz',active:false}];
  const reference=proposePurchaseAccessMerge({grants:appleGrants},{grants:stripeGrants});
  assert.deepEqual(reference.grants.map(g=>g.id),['Z','a','stripe:sub_one','stripe:sub_zz']);
  assert.deepEqual(proposePurchaseAccessMerge({grants:[...appleGrants].reverse()},{grants:[...stripeGrants].reverse()}),reference);
});
test('checkout blocks a second purchase on either channel and fails closed when the other channel is unknown',async t=>{
  const f=fixture(t);
  assert.deepEqual(f.service().checkout(actor,'monthly','checkout'),{status:'built',request:buildCheckoutRequest(f.cfg,A,'monthly','checkout')});
  assert.deepEqual(f.guardCalls.at(-1),actor);
  f.channel('apple');assert.deepEqual(f.service().checkout(actor,'monthly','checkout'),{status:'refused',code:'already_subscribed_other_channel',hint:'manage_in_app_store'});
  for(const value of ['unknown','throw','invalid'] as const) {
    f.channel(value);assert.deepEqual(f.service().checkout(actor,'monthly','checkout'),{status:'unknown',code:'stripe_other_channel_unknown'});
  }
  f.channel('none');await f.bind();const calls=f.guardCalls.length;
  assert.deepEqual(f.service().checkout(actor,'yearly','again'),{status:'refused',code:'already_subscribed_stripe',hint:'manage_in_billing_portal'});
  assert.equal(f.guardCalls.length,calls);assert.throws(()=>f.service().checkout({...actor,sessionId:'missing'},'monthly','x'));
});
test('a Stripe subscription activated while Apple is active is held as dual_channel_conflict and never auto-cancelled',async t=>{
  const f=fixture(t);f.channel('apple');
  assert.deepEqual(await f.send(f.event('checkout.session.completed')),{status:'processed',code:'stripe_dual_channel_conflict_held'});
  assert.deepEqual(f.guardCalls.at(-1),{accountId:A});assert.equal(f.calls.filter(c=>c.method==='DELETE').length,0);
  assert.equal(f.count('stripe_web_cancellations'),0);
  assert.deepEqual(f.service().heldConflicts(actor).map(c=>[c.kind,c.subscriptionRef,c.state]),[['dual_channel_conflict','sub_one','held']]);
  assert.equal(f.observe().status,'observed');assert.equal(f.observe().entitlement?.active,true);
  f.channel('unknown');assert.deepEqual(await f.send(f.event('invoice.paid',2)),{status:'unknown',code:'stripe_other_channel_unknown'});
  assert.equal(f.db.prepare("SELECT 1 FROM stripe_web_events WHERE event_id='evt_2'").get(),undefined);
});
test('cancellation send records unknown before confirmation and retries with the same idempotency key',async t=>{
  const f=fixture(t);await f.bind();await f.send(f.event('charge.refunded'));f.fail('/v1/subscriptions/');
  assert.deepEqual(await f.service().sendCancellation('sub_one'),{status:'unknown',code:'stripe_cancellation_unknown'});
  assert.equal(f.service().cancellations()[0]?.state,'unknown');
  f.fail(null);assert.deepEqual(await f.service().sendCancellation('sub_one'),{status:'processed',code:'stripe_cancellation_confirmed'});
  const deletes=f.calls.filter(c=>c.method==='DELETE');assert.equal(deletes.length,2);assert.equal(deletes[0]!.idempotencyKey,deletes[1]!.idempotencyKey);
  assert.deepEqual(f.service().cancellations(),[]);assert.equal((await f.service().sendCancellation('sub_one')).code,'stripe_cancellation_confirmed');
  assert.equal(f.calls.filter(c=>c.method==='DELETE').length,2);
  assert.throws(()=>f.db.prepare("UPDATE stripe_web_cancellations SET state='pending_external'").run(),/stripe_cancellation_progress/);
  assert.deepEqual(await f.service().sendCancellation('sub_none'),{status:'rejected',code:'stripe_cancellation_absent'});
});
test('a refund whose customer does not match the subscription is held and never cancels',async t=>{
  const f=fixture(t);await f.bind();
  const raw=f.event('charge.refunded',1,{payload:{...f.stripe.charges.get('ch_one'),refunded:true,amount_refunded:2000,customer:'cus_other'}});
  assert.deepEqual(await f.send(raw),{status:'rejected',code:'stripe_linkage_conflict'});
  assert.equal(f.observe().status,'rejected');assert.equal(f.count('stripe_web_cancellations'),0);
  assert.equal((f.db.prepare('SELECT revoked FROM stripe_web_subscriptions').get() as {revoked:number}).revoked,0);
});
test('lifecycle exports references only and suppression records pending_external without HTTP',async t=>{
  const f=fixture(t);await f.bind();const lifecycle=stripeLifecycleContributor(f.service()),exported:unknown[]=[];
  assert.equal(lifecycle.category,'stripe-billing');
  assert.deepEqual(lifecycle.inventory(actor),{category:'stripe-billing',status:'retained',reason:'stripe_billing_records_retained',count:2});
  assert.deepEqual(lifecycle.inventory(other),{category:'stripe-billing',status:'complete',count:0});
  assert.equal(lifecycle.export(actor,{snapshotAtMs:Date.now(),append:(_category,v)=>exported.push(v)}).status,'complete');
  const text=JSON.stringify(exported);assert.match(text,/"subscriptionRef":"sub_one"/);assert.match(text,/"amountMinor":2000/);assert.match(text,/"currency":"usd"/);
  for(const forbidden of [f.secret,'client_reference_id','payment_method','card','metadata','STRIPE_API_KEY','idempotency'])assert.equal(text.includes(forbidden),false);
  const calls=f.calls.length;f.disable();assert.equal(lifecycle.verifySuppressed(A,1).status,'pending');
  assert.deepEqual(lifecycle.suppress(A,1),{status:'complete',count:1});assert.equal(lifecycle.verifySuppressed(A,1).status,'complete');
  assert.deepEqual(lifecycle.purge('delete',A),{status:'pending',reason:'pending_external',count:1});assert.equal(f.calls.length,calls);
  assert.deepEqual(f.service().cancellations().map(c=>[c.reason,c.state]),[['suppressed','pending_external']]);
  assert.equal(f.observe().status,'unavailable');assert.equal(f.observe().entitlement,null);
  const published=f.published.length;
  assert.deepEqual(await f.send(f.event('invoice.paid')),{status:'processed',code:'stripe_recorded_suppressed'});assert.equal(f.published.length,published);
  assert.deepEqual(lifecycle.purge('delete',B),{status:'pending',reason:'suppression_required_before_purge'});
  assert.deepEqual(lifecycle.suppress(B,1),{status:'pending',reason:'suppression_required'});
  f.disable(B);assert.deepEqual(lifecycle.purge('delete',B),{status:'complete',count:0});
});
test('lifecycle coverage declares every new account-partitioned table without a cohort',t=>{
  assert.deepEqual(stripeLifecycleTableCoverage.map(r=>r.table),[...stripeWebTables]);
  for(const row of stripeLifecycleTableCoverage) {
    assert.equal('cohort' in row,false);assert.equal(row.disposition,'retained');
    for(const value of [row.owner,row.attribution,row.mechanism,row.limits,row.residual,row.evidence])assert.ok(value.length>0);
  }
  const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');db.exec(stripeWebMigration.sql);
  const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'stripe_%' ORDER BY name").all() as {name:string}[]).map(r=>r.name);
  assert.deepEqual(tables,[...stripeWebTables].sort());
  for(const table of tables)assert.ok((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string;notnull:number}[]).some(c=>c.name==='account_id'&&c.notnull===1));
});
test('test, live and other Stripe accounts never mix in one store',async t=>{
  const f=fixture(t);await f.bind();const live=f.service({...f.cfg,livemode:true});
  for(const svc of [live,f.service({...f.cfg,stripeAccount:'acct_other'})])assert.equal(f.observe(actor,svc).entitlement,null);
  assert.equal((await live.reconcile(actor,'sub_one')).status,'unknown');assert.equal(f.observe(actor,live).evidence.environment,'live');
  assert.equal(f.observe().evidence.environment,'test');assert.equal(f.observe().entitlement?.active,true);
  assert.deepEqual(f.db.prepare('SELECT DISTINCT namespace FROM stripe_web_subscriptions').all(),[{namespace:'stripe:test:acct_test'}]);
});
test('known refund revokes without fetching subscription state',async t=>{
  const f=fixture(t);await f.bind();const before=f.calls.filter(c=>c.path.startsWith('/v1/subscriptions/')).length;
  assert.equal((await f.send(f.event('charge.refunded',2))).status,'processed');
  assert.equal(f.calls.filter(c=>c.path.startsWith('/v1/subscriptions/')).length,before);assert.equal(f.observe().entitlement?.active,false);
});
test('receipt failure rolls back binding, subscription and grant together and keeps retry explicit',async t=>{
  const f=fixture(t);f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON stripe_web_events BEGIN SELECT RAISE(ABORT,'synthetic');END");
  const raw=f.event('checkout.session.completed');assert.equal((await f.send(raw)).status,'unknown');
  for(const table of ['stripe_web_customers','stripe_web_subscriptions','stripe_web_events'])assert.equal(f.count(table),0);
  f.db.exec('DROP TRIGGER fail_receipt');assert.equal((await f.send(raw)).status,'processed');
});
test('disable during provider read records state with a pending cancellation but never publishes',async t=>{
  const f=fixture(t);await f.bind();const published=f.published.length,g=gate();f.hook(()=>g.promise);
  const pending=f.send(f.event('invoice.paid'));f.hook(null);f.disable();g.release();
  assert.deepEqual(await pending,{status:'processed',code:'stripe_recorded_suppressed'});assert.equal(f.published.length,published);
  assert.equal(f.observe().status,'unavailable');assert.deepEqual(f.service().cancellations().map(c=>c.reason),['suppressed']);
});
test('checkout completing after suppression records the binding and a pending cancellation without publishing',async t=>{
  const f=fixture(t);f.disable();assert.deepEqual(await f.send(f.event('checkout.session.completed')),{status:'processed',code:'stripe_recorded_suppressed'});
  assert.deepEqual(f.published,[]);assert.equal(f.guardCalls.length,0);assert.deepEqual(f.service().cancellations().map(c=>[c.reason,c.state]),[['suppressed','pending_external']]);
});
for(const [name,change,status] of [['negative period',{current_period_end:-1},'unknown'],['incomplete item page',{items:{object:'list',has_more:true,data:[]}},'unknown'],
  ['non-USD price',{items:{object:'list',has_more:false,data:[{quantity:1,price:{id:'price_month',currency:'eur',unit_amount:2000,recurring:{interval:'month',interval_count:1}}}]}},'processed'],
  ['other customer',{customer:'cus_other'},'rejected'],['other subscription ID',{id:'sub_other'},'unknown']] as const) test('invalid provider state cannot grant: '+name,async t=>{
  const f=fixture(t);Object.assign(f.sub(),change);assert.equal((await f.send(f.event('checkout.session.completed'))).status,status);
  assert.notEqual(f.observe().entitlement?.active,true);
});
