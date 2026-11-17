import { createHash } from 'node:crypto';
import type { Sqlite } from '../../storage.js';
import type { AccountContext, LifecycleAdapter, LifecycleResult } from '../../lifecycle/types.js';
import { DomainError } from '../../errors.js';
import { assertActive, assertAccountActive, suppressionAuthority } from '../../lifecycle/guards.js';
import { stripeApiVersion, stripeCatalog, stripeConfiguration, stripeCurrency, stripeNamespace, type StripeConfiguration, type Plan } from './configuration.js';
import { buildCancellationRequest, buildCheckoutRequest, buildPortalRequest, type StripeHttpClient, type StripeRequest } from './requests.js';
import { verifyStripeSignature } from './signature.js';
import { StripeRejection, canonical, chargeFacts, disputeFacts, invalid, invoiceFacts, object, ref, reject, seconds, sessionFacts,
  subscriptionState, type ChargeFacts, type DisputeFacts, type Json, type SessionFacts, type SubscriptionState } from './evidence.js';
import type { StripeGrant } from './merge.js';

export type StripeOutcome = Readonly<{ status: 'processed' | 'pending' | 'rejected' | 'unknown' | 'unavailable'; code: string }>;
/** Platform-implemented guard. Webhooks have no session, so it is called with account identity alone. */
export type OtherChannel = 'none' | 'apple' | 'unknown';
export type OtherChannelGuard = (ctx: Readonly<Pick<AccountContext, 'accountId'>>) => OtherChannel;
export type StripePorts = Readonly<{
  client: StripeHttpClient;
  secret: (environmentReference: string) => string | undefined;
  activeOtherChannel: OtherChannelGuard;
  clock?: () => number;
  /** Post-commit publication notice. Never invoked for suppressed accounts; a throw reports an unknown (lost) response. */
  publish?: (notice: Readonly<{ accountId: string; subscriptionRef: string }>) => void;
}>;
export type StripeCheckoutResult =
  | Readonly<{ status: 'built'; request: StripeRequest }>
  | Readonly<{ status: 'refused'; code: 'already_subscribed_other_channel'; hint: 'manage_in_app_store' }>
  | Readonly<{ status: 'refused'; code: 'already_subscribed_stripe'; hint: 'manage_in_billing_portal' }>
  | Readonly<{ status: 'unknown'; code: 'stripe_other_channel_unknown' }>;
export type StripeObservation = Readonly<{
  status: 'observed' | 'pending' | 'rejected' | 'unavailable' | 'unknown';
  entitlement: Readonly<{ productId: string; active: boolean; effectiveExpiresAtMs: number | null }> | null;
  /** eventHighWater is the highest applied Stripe event `created` (Unix seconds); null when only reconciliation wrote state. */
  evidence: Readonly<{ provider: 'Stripe'; environment: 'test' | 'live'; subscriptionRef: string | null; eventHighWater: number | null; observedAtMs: number }>;
}>;
export type StripeConflictKind = 'binding' | 'linkage' | 'event_variant' | 'dispute_variant' | 'dual_channel_conflict';
export type StripeHeldConflict = Readonly<{ kind: StripeConflictKind; subscriptionRef: string | null; customerRef: string | null;
  eventRef: string | null; detectedAtMs: number; state: 'held' }>;
export type StripeCancellation = Readonly<{ subscriptionRef: string; accountId: string; reason: 'revoked' | 'suppressed';
  state: 'pending_external' | 'unknown' | 'canceled'; request: StripeRequest }>;

type Row = { namespace: string; subscription_id: string; account_id: string; customer_id: string; price_id: string; product_id: string | null;
  status: string; cancel_at_period_end: number; period_start: number; period_end: number; created_at: number; event_high_water: number | null;
  revision: number; revoked: number; suspended: number; suppressed: number };
type Receipt = Readonly<{ eventId: string; type: string; created: number; digest: string }>;
type Facts = {
  subscriptionId: string; customerId: string; expectedRevision: number | null; linkageMismatch: boolean;
  bind?: SessionFacts; state?: SubscriptionState; refund?: ChargeFacts; disputes?: readonly DisputeFacts[]; otherChannel?: 'none' | 'apple';
};
type Applied = { outcome: StripeOutcome; notice: Readonly<{ accountId: string; subscriptionRef: string }> | null };
const types = new Set(['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed']);
const outcome = (status: StripeOutcome['status'], code: string): StripeOutcome => Object.freeze({ status, code });
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const failClosedKinds = "kind<>'dual_channel_conflict'";

// Trusted registration seam: clients resolve environment references internally and never return/log credentials.
export class StripeWebPurchases {
  readonly #config: StripeConfiguration;
  readonly #ns: string;
  readonly #ports: StripePorts;
  readonly #clock: () => number;
  constructor(private readonly db: Sqlite, config: StripeConfiguration, ports: StripePorts) {
    this.#config = stripeConfiguration(config)!;
    this.#ns = stripeNamespace(this.#config);
    if (!ports || typeof ports.client?.request !== 'function' || typeof ports.secret !== 'function'
      || typeof ports.activeOtherChannel !== 'function') throw new Error('stripe_ports_required');
    this.#ports = ports; this.#clock = ports.clock ?? Date.now;
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || db.pragma('synchronous', { simple: true }) !== 2) throw new Error('stripe_storage_unqualified');
  }
  get environment(): 'test' | 'live' { return this.#config.livemode ? 'live' : 'test'; }

  // ---- storage reads (namespace-scoped) ----
  #row(subscriptionId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM stripe_web_subscriptions WHERE namespace=? AND subscription_id=?').get(this.#ns, subscriptionId) as Row | undefined;
  }
  #rows(accountId: string): Row[] {
    return this.db.prepare('SELECT * FROM stripe_web_subscriptions WHERE namespace=? AND account_id=? ORDER BY subscription_id').all(this.#ns, accountId) as Row[];
  }
  #customer(customerId: string) {
    return this.db.prepare('SELECT account_id FROM stripe_web_customers WHERE namespace=? AND customer_id=?').get(this.#ns, customerId) as { account_id: string } | undefined;
  }
  #heldFailClosed(accountId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM stripe_web_conflicts WHERE namespace=? AND account_id=? AND ${failClosedKinds}`).get(this.#ns, accountId);
  }
  #suppressed(accountId: string): boolean {
    try { assertAccountActive(this.db, accountId); return false; }
    catch (error) { if (error instanceof DomainError && error.code === 'account_disabled') return true; throw error; }
  }
  #live(row: Row, now: number): boolean {
    return !row.revoked && row.period_end * 1000 > now && !['canceled', 'incomplete_expired'].includes(row.status);
  }
  #active(row: Row, now: number): boolean {
    return row.product_id !== null && row.status === 'active' && !row.revoked && !row.suspended && !row.suppressed && row.period_end * 1000 > now;
  }

  // ---- provider reads through the injected client ----
  async #get(path: string): Promise<Json> {
    const response = object(await this.#ports.client.request({ method: 'GET', path, apiVersion: stripeApiVersion, apiKeyEnv: this.#config.apiKeyEnv }));
    if (response.id !== path.split('/').at(-1) || response.livemode !== this.#config.livemode) invalid();
    return response;
  }
  async #list(path: string): Promise<Json[]> {
    const response = object(await this.#ports.client.request({ method: 'GET', path, apiVersion: stripeApiVersion, apiKeyEnv: this.#config.apiKeyEnv }));
    if (response.object !== 'list' || response.has_more !== false || !Array.isArray(response.data) || response.data.length > 100) invalid();
    return (response.data as unknown[]).map(object);
  }
  async #subscription(subscriptionId: string): Promise<SubscriptionState> {
    const state = subscriptionState(await this.#get('/v1/subscriptions/' + subscriptionId), this.#config);
    if (state.subscriptionId !== subscriptionId) invalid();
    return state;
  }
  async #chargeSubscription(charge: ChargeFacts): Promise<{ subscriptionId: string; mismatch: boolean }> {
    if (!charge.invoiceId) return reject('stripe_charge_not_subscription');
    const invoice = invoiceFacts(await this.#get('/v1/invoices/' + charge.invoiceId), this.#config);
    if (!invoice.subscriptionId) return reject('stripe_charge_not_subscription');
    return { subscriptionId: invoice.subscriptionId, mismatch: invoice.customerId !== charge.customerId };
  }

  // ---- account-facing builders ----
  checkout(actor: AccountContext, plan: Plan, requestKey: string): StripeCheckoutResult {
    actor = Object.freeze({ ...actor });
    assertActive(this.db, actor);
    const now = this.#clock();
    if (this.#rows(actor.accountId).some(row => this.#live(row, now)))
      return Object.freeze({ status: 'refused', code: 'already_subscribed_stripe', hint: 'manage_in_billing_portal' });
    let channel: unknown;
    try { channel = this.#ports.activeOtherChannel(actor); } catch { channel = 'unknown'; }
    if (channel === 'apple') return Object.freeze({ status: 'refused', code: 'already_subscribed_other_channel', hint: 'manage_in_app_store' });
    if (channel !== 'none') return Object.freeze({ status: 'unknown', code: 'stripe_other_channel_unknown' });
    return Object.freeze({ status: 'built', request: buildCheckoutRequest(this.#config, actor.accountId, plan, requestKey) });
  }
  portal(actor: AccountContext, customerId: string, requestKey: string): StripeRequest {
    assertActive(this.db, actor);
    if (this.#customer(customerId)?.account_id !== actor.accountId) throw new Error('stripe_customer_unbound');
    return buildPortalRequest(this.#config, actor.accountId, customerId, requestKey);
  }

  // ---- webhook ingestion ----
  async ingest(raw: Uint8Array, signature: string): Promise<StripeOutcome> {
    try {
      const secrets = this.#config.webhookSecretEnvs.map(k => this.#ports.secret(k)).filter((s): s is string => typeof s === 'string' && s.length > 0);
      if (!secrets.length) return outcome('unavailable', 'stripe_signing_secret_unavailable');
      if (!verifyStripeSignature(raw, signature, secrets, Math.floor(this.#clock() / 1000))) return outcome('rejected', 'stripe_signature_invalid');
    } catch { return outcome('unknown', 'stripe_ingress_unknown'); }
    let receipt: Receipt, payload: Json;
    try {
      const event = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
      const eventId = ref(event.id, 'evt'), created = seconds(event.created), type = String(event.type);
      if (event.object !== 'event' || event.livemode !== this.#config.livemode || event.api_version !== stripeApiVersion || event.account !== undefined
        || !types.has(type)) return outcome('rejected', 'stripe_event_unsupported');
      payload = object(object(event.data).object);
      // Dedupe is by event ID; envelope fields (pending_webhooks, request) may differ on redelivery. The fact digest
      // covers only the event's immutable facts so a conflicting variant of the same event can be held.
      const digest = createHash('sha256').update(canonical([type, created, event.livemode, event.api_version, event.data])).digest('hex');
      receipt = Object.freeze({ eventId, type, created, digest });
    } catch { return outcome('rejected', 'stripe_event_invalid'); }
    try {
      const replay = this.db.transaction(() => this.#receipt(receipt, this.#clock())).immediate();
      if (replay) return replay;
    } catch { return outcome('unknown', 'stripe_ingress_unknown'); }
    let facts: Facts;
    try {
      const result = await this.#eventFacts(receipt.type, payload);
      if ('status' in result) return result;
      facts = result;
      const gate = this.#otherChannel(facts);
      if (gate) return gate;
    } catch (error) { return error instanceof StripeRejection ? outcome('rejected', error.code) : outcome('unknown', 'stripe_processing_unknown'); }
    return this.#commit(facts, receipt, 'stripe_event_applied', null);
  }
  async #eventFacts(kind: string, p: Json): Promise<Facts | StripeOutcome> {
    if (kind === 'checkout.session.completed') {
      const bind = sessionFacts(p, this.#config);
      const expectedRevision = this.#row(bind.subscriptionId)?.revision ?? null;
      const state = await this.#subscription(bind.subscriptionId);
      return { subscriptionId: bind.subscriptionId, customerId: bind.customerId, expectedRevision, bind, state, linkageMismatch: state.customerId !== bind.customerId };
    }
    let subscriptionId: string, customerId: string, mismatch = false, refund: ChargeFacts | undefined, disputes: DisputeFacts[] | undefined;
    if (kind.startsWith('customer.subscription.')) { subscriptionId = ref(p.id, 'sub'); customerId = ref(p.customer, 'cus'); }
    else if (kind.startsWith('invoice.')) {
      const invoice = invoiceFacts(p, this.#config);
      if (!invoice.subscriptionId) return reject('stripe_invoice_not_subscription');
      subscriptionId = invoice.subscriptionId; customerId = invoice.customerId;
    } else {
      let charge: ChargeFacts;
      if (kind === 'charge.refunded') charge = refund = chargeFacts(p, this.#config);
      else {
        const dispute = disputeFacts(p, this.#config);
        if (kind === 'charge.dispute.closed' && dispute.status === 'open') return reject('stripe_dispute_status_unsupported');
        disputes = [kind === 'charge.dispute.created' ? Object.freeze({ ...dispute, status: 'open' as const }) : dispute];
        charge = chargeFacts(await this.#get('/v1/charges/' + dispute.chargeId), this.#config);
      }
      const link = await this.#chargeSubscription(charge);
      subscriptionId = link.subscriptionId; customerId = charge.customerId; mismatch = link.mismatch;
    }
    // Binding comes only from Checkout; events for an unbound subscription wait for it (or account-bound reconcile).
    const current = this.#row(subscriptionId);
    if (!current) return outcome('pending', 'stripe_binding_pending');
    const facts: Facts = { subscriptionId, customerId, expectedRevision: current.revision, linkageMismatch: mismatch };
    if (refund) facts.refund = refund;
    if (disputes) facts.disputes = disputes;
    // Known charge linkage revokes/suspends without a subscription re-fetch; other events re-fetch current state.
    if (!refund && !disputes) { facts.state = await this.#subscription(subscriptionId); facts.linkageMismatch ||= facts.state.customerId !== customerId; }
    return facts;
  }
  #otherChannel(facts: Facts): StripeOutcome | null {
    const state = facts.state, current = this.#row(facts.subscriptionId), accountId = current?.account_id ?? facts.bind?.accountId;
    if (!state || !accountId || current?.revoked || state.productId === null || state.status !== 'active' || state.periodEnd * 1000 <= this.#clock()) return null;
    if (this.#suppressed(accountId)) return null;
    let channel: unknown;
    try { channel = this.#ports.activeOtherChannel(Object.freeze({ accountId })); } catch { channel = 'unknown'; }
    if (channel === 'none' || channel === 'apple') { facts.otherChannel = channel; return null; }
    return outcome('unknown', 'stripe_other_channel_unknown');
  }
  #commit(facts: Facts, receipt: Receipt | null, appliedCode: string, context: AccountContext | null): StripeOutcome {
    let applied: Applied;
    try {
      applied = this.db.transaction((): Applied => {
        if (context) assertActive(this.db, context);
        return this.#apply(facts, receipt, appliedCode);
      }).immediate();
    } catch (error) {
      if (error instanceof StripeRejection) return outcome('rejected', error.code);
      if (context && error instanceof DomainError && error.status === 403) return outcome('unavailable', 'stripe_account_unavailable');
      return outcome('unknown', receipt ? 'stripe_processing_unknown' : 'stripe_reconciliation_unknown');
    }
    if (applied.notice) {
      try { this.#ports.publish?.(applied.notice); } catch { return outcome('unknown', 'stripe_response_unknown'); }
    }
    return applied.outcome;
  }
  /** Must run inside a write transaction. Returns the replay outcome for a known event ID, holding conflicting variants. */
  #receipt(receipt: Receipt, now: number): StripeOutcome | null {
    const prior = this.db.prepare('SELECT * FROM stripe_web_events WHERE namespace=? AND event_id=?').get(this.#ns, receipt.eventId) as
      { account_id: string; subscription_id: string | null; digest: string; state: string; code: string } | undefined;
    if (!prior) return null;
    if (prior.digest === receipt.digest)
      return prior.state === 'processed' ? outcome('processed', 'stripe_event_replay') : outcome('rejected', prior.state === 'held' ? 'stripe_conflict_held' : prior.code);
    this.#hold(prior.account_id, 'event_variant', 'event:' + receipt.eventId, prior.subscription_id, null, receipt.eventId, now);
    if (prior.state !== 'held') this.db.prepare("UPDATE stripe_web_events SET state='held',code='stripe_event_variant_held' WHERE namespace=? AND event_id=?")
      .run(this.#ns, receipt.eventId);
    return outcome('rejected', 'stripe_event_variant_held');
  }
  #hold(accountId: string, kind: StripeConflictKind, key: string, subscriptionId: string | null, customerId: string | null, eventId: string | null, now: number) {
    this.db.prepare('INSERT INTO stripe_web_conflicts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(this.#ns, key, accountId, kind, subscriptionId, customerId, eventId, now, 'held');
    // Fence in-flight refreshes of the held subscription.
    if (subscriptionId) this.db.prepare('UPDATE stripe_web_subscriptions SET revision=revision+1 WHERE namespace=? AND subscription_id=? AND account_id=?')
      .run(this.#ns, subscriptionId, accountId);
  }
  #record(receipt: Receipt, accountId: string, subscriptionId: string | null, state: 'processed' | 'rejected' | 'held', code: string) {
    this.db.prepare('INSERT INTO stripe_web_events VALUES(?,?,?,?,?,?,?,?,?)')
      .run(this.#ns, receipt.eventId, accountId, subscriptionId, receipt.type, receipt.created, receipt.digest, state, code);
  }
  #cancel(row: Row, reason: 'revoked' | 'suppressed') {
    const request = buildCancellationRequest(this.#config, row.account_id, row.subscription_id);
    this.db.prepare("INSERT INTO stripe_web_cancellations VALUES(?,?,?,?,?,'pending_external',?) ON CONFLICT DO NOTHING")
      .run(this.#ns, row.subscription_id, row.account_id, row.customer_id, reason, JSON.stringify(request));
  }
  /** Must run inside a write transaction. Conflicts are checked before any state write so a hold commits alone. */
  #apply(facts: Facts, receipt: Receipt | null, appliedCode: string): Applied {
    const now = this.#clock(), sub = facts.subscriptionId, none = { notice: null };
    if (receipt) { const replay = this.#receipt(receipt, now); if (replay) return { outcome: replay, ...none }; }
    const current = this.#row(sub);
    if ((current?.revision ?? null) !== facts.expectedRevision) return { outcome: outcome('pending', 'stripe_concurrent_refresh'), ...none };
    const held = (accountId: string, kind: StripeConflictKind, key: string, subscriptionId: string | null, customerId: string | null, code: string): Applied => {
      this.#hold(accountId, kind, key, subscriptionId, customerId, receipt?.eventId ?? null, now);
      if (receipt) this.#record(receipt, accountId, subscriptionId, 'held', code);
      return { outcome: outcome('rejected', code), ...none };
    };
    let accountId: string;
    if (current) {
      accountId = current.account_id;
      if (facts.bind && facts.bind.accountId !== accountId) return held(accountId, 'binding', 'binding:subscription:' + sub, sub, null, 'stripe_binding_conflict');
      if (facts.linkageMismatch || facts.customerId !== current.customer_id || facts.state && facts.state.customerId !== current.customer_id)
        return held(accountId, 'linkage', 'linkage:' + sub, sub, current.customer_id, 'stripe_linkage_conflict');
    } else {
      if (!facts.bind || !facts.state) return { outcome: outcome('pending', 'stripe_binding_pending'), ...none };
      const owner = this.#customer(facts.bind.customerId);
      // Reuse for another account is held, never rebound; the attempted account's identity is not stored in the owner's partition.
      if (owner && owner.account_id !== facts.bind.accountId)
        return held(owner.account_id, 'binding', 'binding:customer:' + facts.bind.customerId, null, facts.bind.customerId, 'stripe_binding_conflict');
      if (facts.linkageMismatch) return { outcome: outcome('rejected', 'stripe_checkout_linkage_mismatch'), ...none };
      if (!this.db.prepare('SELECT 1 FROM form_accounts WHERE id=?').get(facts.bind.accountId)) return { outcome: outcome('rejected', 'stripe_account_unknown'), ...none };
      accountId = facts.bind.accountId;
      if (!owner) this.db.prepare('INSERT INTO stripe_web_customers VALUES(?,?,?,?)').run(this.#ns, facts.bind.customerId, accountId, facts.bind.sessionId);
    }
    const disputes = facts.disputes ?? [];
    const priorDispute = (id: string) => this.db.prepare('SELECT * FROM stripe_web_disputes WHERE namespace=? AND dispute_id=?').get(this.#ns, id) as
      { account_id: string; subscription_id: string; status: 'open' | 'won' | 'lost' } | undefined;
    for (const dispute of disputes) {
      const prior = priorDispute(dispute.disputeId);
      if (prior && (prior.account_id !== accountId || prior.subscription_id !== sub))
        return held(accountId, 'linkage', 'linkage:' + sub, sub, null, 'stripe_linkage_conflict');
      if (prior && prior.status !== 'open' && dispute.status !== 'open' && dispute.status !== 'unsupported' && dispute.status !== prior.status)
        return held(accountId, 'dispute_variant', 'dispute:' + dispute.disputeId, sub, null, 'stripe_dispute_variant_held');
    }
    const state = facts.state;
    if (!current) {
      const s = state!;
      this.db.prepare('INSERT INTO stripe_web_subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,0,0,0)').run(this.#ns, sub, accountId, s.customerId, s.priceId,
        s.productId, s.status, Number(s.cancelAtPeriodEnd), s.periodStart, s.periodEnd, s.created, receipt?.created ?? null);
    } else if (state) {
      this.db.prepare(`UPDATE stripe_web_subscriptions SET price_id=?,product_id=?,status=?,cancel_at_period_end=?,period_start=?,period_end=?,
        revision=revision+1 WHERE namespace=? AND subscription_id=?`).run(state.priceId, state.productId, state.status, Number(state.cancelAtPeriodEnd),
        state.periodStart, state.periodEnd, this.#ns, sub);
    }
    let revoke = facts.refund?.fullyRefunded === true, restored = false, opened = false, unsupported = false;
    for (const dispute of disputes) {
      const prior = priorDispute(dispute.disputeId);
      if (dispute.status === 'unsupported') { unsupported = true; continue; }
      if (!prior) this.db.prepare('INSERT INTO stripe_web_disputes VALUES(?,?,?,?,?,?)').run(this.#ns, dispute.disputeId, accountId, sub, dispute.chargeId, dispute.status);
      else if (prior.status === 'open' && dispute.status !== 'open')
        this.db.prepare('UPDATE stripe_web_disputes SET status=? WHERE namespace=? AND dispute_id=?').run(dispute.status, this.#ns, dispute.disputeId);
      if (dispute.status === 'lost' || prior?.status === 'lost') revoke = true;
      if (dispute.status === 'won' && prior?.status === 'open') restored = true;
      if (dispute.status === 'open' && !prior) opened = true;
    }
    const suppressed = this.#suppressed(accountId);
    const before = this.#row(sub)!;
    const open = !!this.db.prepare("SELECT 1 FROM stripe_web_disputes WHERE namespace=? AND subscription_id=? AND status='open'").get(this.#ns, sub);
    const highWater = receipt ? Math.max(before.event_high_water ?? receipt.created, receipt.created) : before.event_high_water;
    this.db.prepare(`UPDATE stripe_web_subscriptions SET suspended=?,revoked=max(revoked,?),suppressed=max(suppressed,?),event_high_water=?,
      revision=revision+1 WHERE namespace=? AND subscription_id=?`).run(Number(open), Number(revoke), Number(suppressed), highWater, this.#ns, sub);
    const row = this.#row(sub)!;
    if (revoke) this.#cancel(row, 'revoked');
    if (suppressed) this.#cancel(row, 'suppressed');
    // A race past the checkout guard is held for Platform/owner resolution and never auto-cancelled.
    if (facts.otherChannel === 'apple' && this.#active(row, now)) this.#hold(accountId, 'dual_channel_conflict', 'dual:' + sub, sub, null, receipt?.eventId ?? null, now);
    let result = outcome('processed', facts.otherChannel === 'apple' && this.#active(row, now) ? 'stripe_dual_channel_conflict_held'
      : suppressed ? 'stripe_recorded_suppressed' : revoke ? 'stripe_revoked' : restored ? 'stripe_restored' : opened ? 'stripe_suspended'
      : facts.refund ? 'stripe_partial_refund_not_revoked' : appliedCode);
    if (unsupported && receipt && !state && !facts.refund) result = outcome('rejected', 'stripe_dispute_status_unsupported');
    if (receipt) this.#record(receipt, accountId, sub, result.status === 'processed' ? 'processed' : 'rejected', result.code);
    return { outcome: result, notice: suppressed ? null : Object.freeze({ accountId, subscriptionRef: sub }) };
  }

  // ---- account-bound reconciliation ----
  async reconcile(actor: AccountContext, subscriptionId: string): Promise<StripeOutcome> {
    actor = Object.freeze({ ...actor });
    try {
      if (typeof subscriptionId !== 'string' || !/^sub_[A-Za-z0-9]{1,200}$/.test(subscriptionId)) return outcome('rejected', 'stripe_subscription_invalid');
      try { assertActive(this.db, actor); }
      catch (error) {
        if (error instanceof DomainError) return error.status === 401 ? outcome('rejected', 'stripe_context_invalid') : outcome('unavailable', 'stripe_account_unavailable');
        throw error;
      }
      const current = this.#row(subscriptionId);
      if (current && current.account_id !== actor.accountId) return outcome('rejected', 'stripe_subscription_not_owned');
      const expectedRevision = current?.revision ?? null;
      let bind: SessionFacts | undefined;
      if (!current) {
        // A missed checkout event is recovered from the same server-created Session evidence, never from metadata.
        const sessions = await this.#list('/v1/checkout/sessions?subscription=' + subscriptionId + '&limit=1');
        if (sessions.length !== 1) return outcome('rejected', 'stripe_checkout_session_missing');
        bind = sessionFacts(sessions[0]!, this.#config);
        if (bind.subscriptionId !== subscriptionId) invalid();
        if (bind.accountId !== actor.accountId) return outcome('rejected', 'stripe_client_reference_mismatch');
      }
      const state = await this.#subscription(subscriptionId);
      let refund: ChargeFacts | undefined, disputes: DisputeFacts[] = [], mismatch = false;
      // Refunds and disputes on the latest invoice's charge; any unreadable fact leaves the result unknown.
      if (state.latestInvoice) {
        const invoice = invoiceFacts(await this.#get('/v1/invoices/' + state.latestInvoice), this.#config);
        if (invoice.subscriptionId !== subscriptionId) invalid();
        mismatch = invoice.customerId !== state.customerId;
        if (invoice.chargeId) {
          refund = chargeFacts(await this.#get('/v1/charges/' + invoice.chargeId), this.#config);
          mismatch ||= refund.customerId !== state.customerId;
          disputes = (await this.#list('/v1/disputes?charge=' + invoice.chargeId)).map(d => disputeFacts(d, this.#config));
          if (disputes.some(d => d.chargeId !== invoice.chargeId)) invalid();
        }
      }
      const customerId = current?.customer_id ?? bind!.customerId;
      const facts: Facts = { subscriptionId, customerId, expectedRevision, state, disputes,
        linkageMismatch: mismatch || state.customerId !== customerId };
      if (bind) facts.bind = bind;
      // Partial refunds do not revoke; only a full refund is carried as a fact.
      if (refund?.fullyRefunded) facts.refund = refund;
      const gate = this.#otherChannel(facts);
      if (gate) return gate;
      return this.#commit(facts, null, 'stripe_reconciled', actor);
    } catch (error) { return error instanceof StripeRejection ? outcome('rejected', error.code) : outcome('unknown', 'stripe_reconciliation_unknown'); }
  }

  // ---- external cancellation: recorded with a built request, sent only on an explicit call ----
  cancellations(): readonly StripeCancellation[] {
    return (this.db.prepare("SELECT * FROM stripe_web_cancellations WHERE namespace=? AND state<>'canceled' ORDER BY subscription_id").all(this.#ns) as
      { subscription_id: string; account_id: string; reason: 'revoked' | 'suppressed'; state: 'pending_external' | 'unknown'; request: string }[])
      .map(row => Object.freeze({ subscriptionRef: row.subscription_id, accountId: row.account_id, reason: row.reason, state: row.state,
        request: Object.freeze(JSON.parse(row.request) as StripeRequest) }));
  }
  async sendCancellation(subscriptionId: string): Promise<StripeOutcome> {
    let request: StripeRequest | null;
    try {
      request = this.db.transaction((): StripeRequest | null => {
        const row = this.db.prepare('SELECT * FROM stripe_web_cancellations WHERE namespace=? AND subscription_id=?').get(this.#ns, subscriptionId) as
          { account_id: string; state: string } | undefined;
        if (!row) return reject('stripe_cancellation_absent');
        if (row.state === 'canceled') return null;
        // The attempt is recorded as unknown before sending; only a confirmed canceled response settles it.
        this.db.prepare("UPDATE stripe_web_cancellations SET state='unknown' WHERE namespace=? AND subscription_id=?").run(this.#ns, subscriptionId);
        return buildCancellationRequest(this.#config, row.account_id, subscriptionId);
      }).immediate();
    } catch (error) { return error instanceof StripeRejection ? outcome('rejected', error.code) : outcome('unknown', 'stripe_cancellation_unknown'); }
    if (!request) return outcome('processed', 'stripe_cancellation_confirmed');
    try {
      const response = object(await this.#ports.client.request(request));
      if (response.id !== subscriptionId || response.object !== 'subscription' || response.livemode !== this.#config.livemode || response.status !== 'canceled') invalid();
      this.db.prepare("UPDATE stripe_web_cancellations SET state='canceled' WHERE namespace=? AND subscription_id=? AND state<>'canceled'").run(this.#ns, subscriptionId);
      return outcome('processed', 'stripe_cancellation_confirmed');
    } catch { return outcome('unknown', 'stripe_cancellation_unknown'); }
  }

  // ---- Platform seam: pure, non-granting observation ----
  observe(ctx: AccountContext): StripeObservation {
    const observedAtMs = this.#clock();
    const evidence = (row?: Row) => Object.freeze({ provider: 'Stripe' as const, environment: this.environment,
      subscriptionRef: row?.subscription_id ?? null, eventHighWater: row?.event_high_water ?? null, observedAtMs });
    const result = (status: StripeObservation['status'], row?: Row, entitlement: StripeObservation['entitlement'] = null): StripeObservation =>
      Object.freeze({ status, entitlement, evidence: evidence(row) });
    try {
      try { assertActive(this.db, ctx); }
      catch (error) { if (error instanceof DomainError) return result(error.status === 401 ? 'rejected' : 'unavailable'); throw error; }
      const rank = (row: Row) => this.#active(row, observedAtMs) ? 0 : row.suspended && !row.revoked ? 1 : 2;
      const rows = this.#rows(ctx.accountId).sort((a, b) => rank(a) - rank(b) || b.period_end - a.period_end || order(a.subscription_id, b.subscription_id));
      const primary = rows[0];
      if (this.#heldFailClosed(ctx.accountId)) return result('rejected', primary);
      if (!primary) return result('observed');
      if (rank(primary) === 1) return result('pending', primary);
      const active = this.#active(primary, observedAtMs);
      return result('observed', primary, primary.product_id === null ? null
        : Object.freeze({ productId: primary.product_id, active, effectiveExpiresAtMs: active ? primary.period_end * 1000 : null }));
    } catch { return result('unknown'); }
  }
  heldConflicts(ctx: AccountContext): readonly StripeHeldConflict[] {
    assertActive(this.db, ctx);
    return (this.db.prepare('SELECT * FROM stripe_web_conflicts WHERE namespace=? AND account_id=? ORDER BY conflict_key').all(this.#ns, ctx.accountId) as
      { kind: StripeConflictKind; subscription_id: string | null; customer_id: string | null; event_id: string | null; detected_at_ms: number }[])
      .map(row => Object.freeze({ kind: row.kind, subscriptionRef: row.subscription_id, customerRef: row.customer_id, eventRef: row.event_id,
        detectedAtMs: row.detected_at_ms, state: 'held' as const }));
  }
  /** Grants for the unregistered merge proposal; observe() is the Platform seam. */
  grants(actor: AccountContext): readonly StripeGrant[] {
    assertActive(this.db, actor);
    const now = this.#clock(), held = this.#heldFailClosed(actor.accountId);
    return this.#rows(actor.accountId).map(row => Object.freeze({ id: 'stripe:' + row.subscription_id, entitlement: 'form_plus', source: 'stripe' as const,
      sourceId: row.subscription_id, grantedAt: new Date(row.created_at * 1000).toISOString(), expiresAt: new Date(row.period_end * 1000).toISOString(),
      environment: this.environment, active: !held && this.#active(row, now) }));
  }

  // ---- lifecycle: Stripe billing references; Platform owns whole-account closure ----
  lifecycle(): LifecycleAdapter {
    const category = 'stripe-billing', ns = this.#ns, db = this.db;
    const count = (accountId: string) => (db.prepare(`SELECT (SELECT count(*) FROM stripe_web_customers WHERE namespace=? AND account_id=?)
      + (SELECT count(*) FROM stripe_web_subscriptions WHERE namespace=? AND account_id=?) AS n`).get(ns, accountId, ns, accountId) as { n: number }).n;
    const suppression = (accountId: string, epoch: number | null): LifecycleResult | null => {
      const record = suppressionAuthority(db).lookup(accountId);
      return !record || epoch !== null && record.epoch !== epoch ? { status: 'pending', reason: 'suppression_required' } : null;
    };
    const verify = (accountId: string): LifecycleResult => {
      const open = db.prepare(`SELECT count(*) n FROM stripe_web_subscriptions s WHERE namespace=? AND account_id=? AND (suppressed=0
        OR NOT EXISTS(SELECT 1 FROM stripe_web_cancellations c WHERE c.namespace=s.namespace AND c.subscription_id=s.subscription_id))`).get(ns, accountId) as { n: number };
      return open.n ? { status: 'pending', reason: 'stripe_suppression_incomplete', count: open.n } : { status: 'complete' };
    };
    const adapter: LifecycleAdapter = {
      category,
      inventory: (actor: AccountContext) => {
        assertActive(db, actor);
        const n = count(actor.accountId);
        return n ? { category, status: 'retained', reason: 'stripe_billing_records_retained', count: n } : { category, status: 'complete', count: 0 };
      },
      export: (actor: AccountContext, snapshot) => {
        assertActive(db, actor);
        const now = this.#clock();
        const amount = (productId: string | null) => Object.values(stripeCatalog).find(p => p.productId === productId)?.amount ?? null;
        snapshot.append(category, Object.freeze({
          subscriptions: this.#rows(actor.accountId).map(row => ({ subscriptionRef: row.subscription_id, customerRef: row.customer_id, priceRef: row.price_id,
            productId: row.product_id, status: row.status, access: row.revoked ? 'revoked' : row.suspended ? 'suspended' : this.#active(row, now) ? 'active' : 'inactive',
            cancelAtPeriodEnd: row.cancel_at_period_end === 1, periodStartMs: row.period_start * 1000, periodEndMs: row.period_end * 1000,
            createdAtMs: row.created_at * 1000, amountMinor: amount(row.product_id), currency: stripeCurrency })),
          cancellations: (db.prepare('SELECT subscription_id AS subscriptionRef,reason,state FROM stripe_web_cancellations WHERE namespace=? AND account_id=? ORDER BY subscription_id')
            .all(ns, actor.accountId)),
          disputes: (db.prepare('SELECT dispute_id AS disputeRef,subscription_id AS subscriptionRef,charge_id AS chargeRef,status FROM stripe_web_disputes WHERE namespace=? AND account_id=? ORDER BY dispute_id')
            .all(ns, actor.accountId)),
        }));
        return { category, status: 'complete' };
      },
      suppress: (accountId: string, epoch: number) => db.transaction((): LifecycleResult => {
        const missing = suppression(accountId, epoch);
        if (missing) return missing;
        const rows = this.#rows(accountId);
        for (const row of rows) {
          if (!row.suppressed) db.prepare('UPDATE stripe_web_subscriptions SET suppressed=1,revision=revision+1 WHERE namespace=? AND subscription_id=?').run(ns, row.subscription_id);
          this.#cancel(row, 'suppressed');
        }
        return { status: 'complete', count: rows.length };
      }).immediate(),
      verifySuppressed: (accountId: string, epoch: number) => suppression(accountId, epoch) ?? verify(accountId),
      purge: (_requestId: string, accountId: string): LifecycleResult => {
        const missing = suppression(accountId, null);
        if (missing) return { status: 'pending', reason: 'suppression_required_before_purge' };
        if (verify(accountId).status !== 'complete') return { status: 'pending', reason: 'stripe_suppression_incomplete' };
        // Local billing records are retained; deleting the Stripe Customer is external work this module never performs.
        const customers = (db.prepare('SELECT count(*) n FROM stripe_web_customers WHERE namespace=? AND account_id=?').get(ns, accountId) as { n: number }).n;
        return customers ? { status: 'pending', reason: 'pending_external', count: customers } : { status: 'complete', count: 0 };
      },
    };
    return Object.freeze(adapter);
  }
}
