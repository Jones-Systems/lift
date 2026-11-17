import { createHash } from 'node:crypto';
import type { Sqlite } from '../../storage.js';
import type { AccountContext, LifecycleAdapter } from '../../lifecycle/types.js';
import { assertActive, assertAccountActive, suppressionAuthority } from '../../lifecycle/guards.js';
import { accountUuid } from '../configuration.js';
import type { AppleEntitlementGrant } from '../types.js';
import { stripeApiVersion, stripeCatalog, stripeConfiguration, type StripeConfiguration, type Plan } from './configuration.js';
import { buildCheckoutRequest, buildPortalRequest, type StripeHttpClient } from './requests.js';
import { verifyStripeSignature } from './signature.js';

type Json = Record<string, unknown>;
type Row = { subscription_id: string; customer_id: string; account_id: string; product_id: string; status: string;
  period_end: number; event_created: number; revoked: number; suppressed: number };
export type StripeOutcome = Readonly<{ status: 'processed' | 'pending' | 'rejected' | 'unknown' | 'unavailable'; code: string }>;
export type StripeGrant = Omit<AppleEntitlementGrant, 'source' | 'environment'> & { source: 'stripe'; environment: 'test' | 'live' };
const fail = (): never => { throw new Error('stripe_evidence_invalid'); };
function object(x: unknown): Json { if (!x || typeof x !== 'object' || Array.isArray(x)) return fail(); return x as Json; }
function id(x: unknown, prefix: string): string {
  if (typeof x !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,200}$`).test(x)) return fail(); return x;
}
function seconds(x: unknown): number { if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0 || x > 8_640_000_000_000) return fail(); return x; }
const types = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'charge.refunded', 'charge.dispute.created']);

// Trusted registration seam: clients resolve environment references internally and never return/log credentials.
export class StripeWebPurchases {
  readonly #config: StripeConfiguration;
  constructor(private readonly db: Sqlite, config: StripeConfiguration, private readonly client: StripeHttpClient,
    private readonly secret: (environmentReference: string) => string | undefined, private readonly clock = Date.now,
    private readonly afterCommit: () => void = () => {}) {
    this.#config = stripeConfiguration(config)!;
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || db.pragma('synchronous', { simple: true }) !== 2) throw new Error('stripe_storage_unqualified');
    const fingerprint = createHash('sha256').update(JSON.stringify([this.#config.livemode,
      ...(['weekly','monthly','yearly'] as const).map(p=>this.#config.prices[p]),stripeApiVersion])).digest('hex');
    db.transaction(()=>{
      db.prepare('INSERT INTO stripe_web_configuration VALUES(1,?) ON CONFLICT DO NOTHING').run(fingerprint);
      if ((db.prepare('SELECT fingerprint FROM stripe_web_configuration WHERE id=1').get() as {fingerprint:string}).fingerprint !== fingerprint)
        throw new Error('stripe_configuration_binding_mismatch');
    }).immediate();
    this.revision();
  }
  private revision(): number { return (this.db.prepare('SELECT revision FROM stripe_web_state WHERE id=1').get() as { revision: number }).revision; }
  private advance(): void { this.db.prepare('UPDATE stripe_web_state SET revision=revision+1 WHERE id=1').run(); }
  private async get(path: string): Promise<Json> {
    const response = object(await this.client.request({ method: 'GET', path, apiVersion: stripeApiVersion, apiKeyEnv: this.#config.apiKeyEnv }));
    if (response.id !== path.split('/').at(-1) || response.livemode !== this.#config.livemode) fail();
    return response;
  }
  checkout(actor: AccountContext, plan: Plan, requestKey: string) {
    assertActive(this.db, actor); return buildCheckoutRequest(this.#config, actor.accountId, plan, requestKey);
  }
  portal(actor: AccountContext, customerId: string, requestKey: string) {
    assertActive(this.db, actor);
    if (!this.db.prepare('SELECT 1 FROM stripe_web_customers WHERE customer_id=? AND account_id=?').get(customerId, actor.accountId)) throw new Error('stripe_customer_unbound');
    return buildPortalRequest(this.#config, actor.accountId, customerId, requestKey);
  }
  private subscription(raw: Json): Row {
    const subscriptionId = id(raw.id, 'sub'), customerId = id(raw.customer, 'cus');
    if (raw.object !== 'subscription' || raw.livemode !== this.#config.livemode) return fail();
    const accountId = object(raw.metadata).form_account_id;
    if (typeof accountId !== 'string' || !accountUuid.test(accountId)) return fail();
    const items = object(raw.items);
    if (items.has_more !== false || !Array.isArray(items.data) || items.data.length !== 1) return fail();
    const item = object(items.data[0]), price = object(item.price);
    const plan = (Object.keys(stripeCatalog) as Plan[]).find(p => this.#config.prices[p] === price.id);
    if (!plan || item.quantity !== 1 || price.currency !== 'usd' || price.unit_amount !== stripeCatalog[plan].amount
      || object(price.recurring).interval !== stripeCatalog[plan].interval || object(price.recurring).interval_count !== 1
      || typeof raw.cancel_at_period_end !== 'boolean' || !['active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused','trialing'].includes(String(raw.status))) return fail();
    return { subscription_id: subscriptionId, customer_id: customerId, account_id: accountId,
      product_id: stripeCatalog[plan].productId, status: String(raw.status), period_end: seconds(raw.current_period_end), event_created: 0, revoked: 0, suppressed: 0 };
  }
  private save(row: Row, created: number, revoke: boolean): void {
    assertAccountActive(this.db, row.account_id);
    if (!this.db.prepare('SELECT 1 FROM form_accounts WHERE id=?').get(row.account_id)) fail();
    const customer = this.db.prepare('SELECT account_id FROM stripe_web_customers WHERE customer_id=?').get(row.customer_id) as { account_id: string } | undefined;
    const previous = this.db.prepare('SELECT * FROM stripe_web_subscriptions WHERE subscription_id=?').get(row.subscription_id) as Row | undefined;
    if (customer && customer.account_id !== row.account_id || previous && (previous.account_id !== row.account_id || previous.customer_id !== row.customer_id)) fail();
    this.db.prepare('INSERT INTO stripe_web_customers VALUES(?,?) ON CONFLICT DO NOTHING').run(row.customer_id, row.account_id);
    this.db.prepare(`INSERT INTO stripe_web_subscriptions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET
      product_id=excluded.product_id,status=excluded.status,period_end=excluded.period_end,event_created=max(event_created,excluded.event_created),
      revoked=max(revoked,excluded.revoked)`).run(row.subscription_id,row.customer_id,row.account_id,row.product_id,row.status,row.period_end,created,Number(revoke),0);
    this.advance();
  }
  async ingest(raw: Uint8Array, signature: string): Promise<StripeOutcome> {
    let event: Json, digest: string;
    try {
      const keys = this.#config.webhookSecretEnvs.map(k => this.secret(k));
      if (keys.some(k => k === undefined) || !verifyStripeSignature(raw, signature, keys as string[], Math.floor(this.clock()/1000)))
        return { status: 'rejected', code: 'stripe_signature_invalid' };
      event = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
      id(event.id, 'evt'); seconds(event.created);
      if (event.object !== 'event' || event.livemode !== this.#config.livemode || event.api_version !== stripeApiVersion || event.account !== undefined
        || !types.has(String(event.type))) return { status: 'rejected', code: 'stripe_event_unsupported' };
      digest = createHash('sha256').update(raw).digest('hex');
      const prior = this.db.prepare('SELECT digest,state FROM stripe_web_events WHERE event_id=?').get(event.id) as { digest: string; state: string } | undefined;
      if (prior && prior.digest !== digest) return { status: 'rejected', code: 'stripe_event_collision' };
      if (prior?.state === 'processed') return { status: 'processed', code: 'stripe_event_replay' };
      this.db.prepare("INSERT INTO stripe_web_events VALUES(?,?,?,?,NULL,'pending') ON CONFLICT DO NOTHING").run(event.id,digest,event.type,event.created);
    } catch { return { status: 'unknown', code: 'stripe_ingress_unknown' }; }
    try {
      let version = this.revision();
      const payload = object(object(event.data).object), kind = String(event.type);
      let subscription: string, relatedCustomer: unknown = payload.customer;
      if (kind.startsWith('customer.subscription.')) subscription = id(payload.id, 'sub');
      else if (kind === 'checkout.session.completed') {
        if (payload.mode !== 'subscription' || payload.status !== 'complete') fail();
        subscription = id(payload.subscription, 'sub');
      } else {
        let invoice: Json;
        if (kind.startsWith('invoice.')) invoice = payload;
        else {
          const charge = kind === 'charge.dispute.created' ? await this.get('/v1/charges/' + id(payload.charge, 'ch')) : payload;
          invoice = await this.get('/v1/invoices/' + id(charge.invoice, 'in'));
          if (invoice.customer !== charge.customer) fail();
        }
        subscription = id(invoice.subscription, 'sub'); relatedCustomer = id(invoice.customer, 'cus');
      }
      const revoke = kind === 'charge.refunded' || kind === 'charge.dispute.created';
      if (revoke) {
        const revoked = this.db.transaction(()=>{
          const previous = this.db.prepare('SELECT * FROM stripe_web_subscriptions WHERE subscription_id=?').get(subscription) as Row | undefined;
          if (!previous) return false;
          if (previous.customer_id !== relatedCustomer) fail();
          this.db.prepare('UPDATE stripe_web_subscriptions SET revoked=1,event_created=max(event_created,?) WHERE subscription_id=?').run(event.created,subscription);
          this.db.prepare("UPDATE stripe_web_events SET state='processed',subscription_id=? WHERE event_id=?").run(subscription,event.id);
          this.advance(); return true;
        }).immediate();
        if (revoked) { this.afterCommit();return {status:'processed',code:'stripe_revoked'}; }
        version = this.revision();
      }
      // Event time is diagnostic/high-water only: Stripe events do not define a total order.
      // Re-fetch current state for every event and fence concurrent fetches with the store revision.
      const row = this.subscription(await this.get('/v1/subscriptions/' + subscription));
      if (row.subscription_id !== subscription || relatedCustomer !== undefined && relatedCustomer !== row.customer_id
        || kind === 'checkout.session.completed' && payload.client_reference_id !== row.account_id) fail();
      const result = this.db.transaction((): StripeOutcome => {
        const receipt = this.db.prepare('SELECT digest,state FROM stripe_web_events WHERE event_id=?').get(event.id) as {digest:string;state:string};
        if (receipt.digest !== digest) fail();
        if (receipt.state === 'processed') return {status:'processed',code:'stripe_event_replay'};
        if (version !== this.revision()) return {status:'pending',code:'stripe_concurrent_refresh'};
        this.save(row, seconds(event.created), revoke);
        this.db.prepare("UPDATE stripe_web_events SET state='processed',subscription_id=? WHERE event_id=?").run(subscription,event.id);
        return {status:'processed',code:'stripe_event_applied'};
      }).immediate();
      this.afterCommit(); return result;
    } catch { return { status: 'unknown', code: 'stripe_processing_unknown' }; }
  }
  async reconcile(actor: AccountContext, subscriptionId: string): Promise<StripeOutcome> {
    actor = Object.freeze({...actor});
    try {
      assertActive(this.db, actor);
      const old = this.db.prepare('SELECT * FROM stripe_web_subscriptions WHERE subscription_id=? AND account_id=?').get(id(subscriptionId,'sub'),actor.accountId) as Row | undefined;
      const version = this.revision(), row = this.subscription(await this.get('/v1/subscriptions/' + subscriptionId));
      if (row.subscription_id !== subscriptionId || row.account_id !== actor.accountId || old && row.customer_id !== old.customer_id) fail();
      return this.db.transaction((): StripeOutcome => {
        assertActive(this.db,actor);
        if (this.revision() !== version) return {status:'pending',code:'stripe_concurrent_refresh'};
        this.save(row,old?.event_created ?? 0,false); return {status:'processed',code:'stripe_reconciled'};
      }).immediate();
    } catch { return {status:'unknown',code:'stripe_reconciliation_unknown'}; }
  }
  entitlements(actor: AccountContext): {grants:StripeGrant[];active:string[]} {
    assertActive(this.db,actor);
    const rows = this.db.prepare('SELECT * FROM stripe_web_subscriptions WHERE account_id=? ORDER BY subscription_id').all(actor.accountId) as Row[];
    const grants: StripeGrant[] = rows.map(row => ({id:'stripe:' + row.subscription_id,entitlement:'form_plus',source:'stripe',sourceId:row.subscription_id,
      grantedAt:new Date(row.event_created*1000).toISOString(),expiresAt:new Date(row.period_end*1000).toISOString(),environment:this.#config.livemode?'live':'test',
      active:row.status === 'active' && !row.revoked && !row.suppressed && row.period_end*1000 > this.clock()}));
    return {grants,active:grants.some(g=>g.active)?['form_plus']:[]};
  }
  lifecycle(): LifecycleAdapter {
    const references = (accountId:string) => this.db.prepare(`SELECT subscription_id AS subscriptionId,customer_id AS customerId,product_id AS productId,status
      FROM stripe_web_subscriptions WHERE account_id=? ORDER BY subscription_id`).all(accountId);
    const suppressed = (accountId:string) => {
      if (!suppressionAuthority(this.db).lookup(accountId)) throw new Error('stripe_suppression_required');
      return !this.db.prepare('SELECT 1 FROM stripe_web_subscriptions WHERE account_id=? AND suppressed=0').get(accountId);
    };
    return {
      category:'stripe-web',
      inventory:actor=>{assertActive(this.db,actor);return {category:'stripe-web',status:'complete',count:references(actor.accountId).length};},
      export:(actor,snapshot)=>{assertActive(this.db,actor);snapshot.append('stripe-web',{subscriptions:references(actor.accountId)});return {category:'stripe-web',status:'complete'};},
      suppress:(accountId,epoch)=>this.db.transaction(()=>{
        const record=suppressionAuthority(this.db).lookup(accountId);
        if (!record || record.epoch !== epoch) throw new Error('stripe_suppression_required');
        this.db.prepare('UPDATE stripe_web_subscriptions SET suppressed=1 WHERE account_id=?').run(accountId);
        this.db.prepare(`INSERT INTO stripe_web_cancellations SELECT subscription_id,account_id,customer_id,'pending_external'
          FROM stripe_web_subscriptions WHERE account_id=? ON CONFLICT DO NOTHING`).run(accountId);
        this.advance(); return {status:'complete' as const};
      }).immediate(),
      verifySuppressed:accountId=>({status:suppressed(accountId)?'complete':'pending'}),
      purge:(_requestId,accountId)=>{suppressed(accountId);return {status:'pending',reason:'pending_external'};},
    };
  }
}
export function mergePurchaseEntitlements(apple: Readonly<{grants:readonly AppleEntitlementGrant[]}>, stripe: Readonly<{grants:readonly StripeGrant[]}>) {
  const grants = [...apple.grants,...stripe.grants].sort((a,b)=>a.source.localeCompare(b.source)||a.id.localeCompare(b.id));
  return {grants,active:[...new Set(grants.filter(g=>g.active).map(g=>g.entitlement))].sort()};
}
