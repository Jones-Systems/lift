import { accountUuid } from '../configuration.js';
import { stripeCatalog, stripeCurrency, type Plan, type StripeConfiguration } from './configuration.js';

// Malformed provider evidence is an unknown outcome; a StripeRejection is a permanent, explainable refusal.
export type Json = Record<string, unknown>;
export class StripeRejection extends Error { constructor(readonly code: string) { super(code); } }
export const invalid = (): never => { throw new Error('stripe_evidence_invalid'); };
export const reject = (code: string): never => { throw new StripeRejection(code); };
export function object(x: unknown): Json { if (!x || typeof x !== 'object' || Array.isArray(x)) return invalid(); return x as Json; }
export function ref(x: unknown, prefix: string): string {
  if (typeof x !== 'string' || !new RegExp(`^(?:${prefix})_[A-Za-z0-9]{1,200}$`).test(x)) return invalid(); return x;
}
export function seconds(x: unknown): number { if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0 || x > 8_640_000_000_000) return invalid(); return x; }
function minor(x: unknown): number { if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) return invalid(); return x; }
function usd(x: unknown): void { if (typeof x !== 'string') invalid(); if (x !== stripeCurrency) reject('stripe_currency_unsupported'); }
const chargePrefix = 'ch|py';
const statuses = new Set(['active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'trialing']);

export type SubscriptionState = Readonly<{ subscriptionId: string; customerId: string; priceId: string; productId: string | null;
  status: string; cancelAtPeriodEnd: boolean; periodStart: number; periodEnd: number; created: number; latestInvoice: string | null }>;
/** A structurally valid subscription whose single item is not an exact configured catalog Price records productId null: no grant. */
export function subscriptionState(raw: Json, config: StripeConfiguration): SubscriptionState {
  const subscriptionId = ref(raw.id, 'sub'), customerId = ref(raw.customer, 'cus');
  if (raw.object !== 'subscription' || raw.livemode !== config.livemode || !statuses.has(String(raw.status))
    || typeof raw.cancel_at_period_end !== 'boolean') return invalid();
  const items = object(raw.items);
  if (items.has_more !== false || !Array.isArray(items.data) || items.data.length < 1) return invalid();
  const item = object(items.data[0]), price = object(item.price), recurring = price.recurring === null ? null : object(price.recurring);
  const priceId = ref(price.id, 'price');
  const plan = (Object.keys(stripeCatalog) as Plan[]).find(p => config.prices[p] === priceId);
  const exact = plan !== undefined && items.data.length === 1 && item.quantity === 1 && price.currency === stripeCurrency
    && price.unit_amount === stripeCatalog[plan].amount && recurring !== null && recurring.interval === stripeCatalog[plan].interval
    && recurring.interval_count === 1;
  const latest = raw.latest_invoice === null || raw.latest_invoice === undefined ? null : ref(raw.latest_invoice, 'in');
  return Object.freeze({ subscriptionId, customerId, priceId, productId: exact ? stripeCatalog[plan].productId : null,
    status: String(raw.status), cancelAtPeriodEnd: raw.cancel_at_period_end, periodStart: seconds(raw.current_period_start),
    periodEnd: seconds(raw.current_period_end), created: seconds(raw.created), latestInvoice: latest });
}

export type SessionFacts = Readonly<{ sessionId: string; customerId: string; subscriptionId: string; accountId: string }>;
/** Binding evidence: a completed, server-created (not Payment Link) subscription Checkout Session. */
export function sessionFacts(raw: Json, config: StripeConfiguration): SessionFacts {
  const sessionId = ref(raw.id, 'cs');
  if (raw.object !== 'checkout.session' || raw.livemode !== config.livemode) return invalid();
  if (raw.mode !== 'subscription' || raw.status !== 'complete') return reject('stripe_checkout_unsupported');
  if (raw.payment_link !== null) return reject('stripe_checkout_not_server_created');
  if (raw.subscription === null || raw.subscription === undefined) return reject('stripe_checkout_subscription_missing');
  const accountId = raw.client_reference_id;
  if (typeof accountId !== 'string' || !accountUuid.test(accountId)) return reject('stripe_client_reference_invalid');
  return Object.freeze({ sessionId, customerId: ref(raw.customer, 'cus'), subscriptionId: ref(raw.subscription, 'sub'), accountId });
}

export type InvoiceFacts = Readonly<{ invoiceId: string; customerId: string; subscriptionId: string | null; chargeId: string | null }>;
export function invoiceFacts(raw: Json, config: StripeConfiguration): InvoiceFacts {
  if (raw.object !== 'invoice' || raw.livemode !== config.livemode) return invalid();
  usd(raw.currency);
  return Object.freeze({ invoiceId: ref(raw.id, 'in'), customerId: ref(raw.customer, 'cus'),
    subscriptionId: raw.subscription === null ? null : ref(raw.subscription, 'sub'),
    chargeId: raw.charge === null || raw.charge === undefined ? null : ref(raw.charge, chargePrefix) });
}

export type ChargeFacts = Readonly<{ chargeId: string; customerId: string; invoiceId: string | null; amount: number; amountRefunded: number;
  fullyRefunded: boolean }>;
export function chargeFacts(raw: Json, config: StripeConfiguration): ChargeFacts {
  if (raw.object !== 'charge' || raw.livemode !== config.livemode || typeof raw.refunded !== 'boolean') return invalid();
  usd(raw.currency);
  const amount = minor(raw.amount), amountRefunded = minor(raw.amount_refunded);
  if (amountRefunded > amount) return invalid();
  return Object.freeze({ chargeId: ref(raw.id, chargePrefix), customerId: ref(raw.customer, 'cus'),
    invoiceId: raw.invoice === null ? null : ref(raw.invoice, 'in'), amount, amountRefunded,
    fullyRefunded: raw.refunded === true && amount > 0 && amountRefunded === amount });
}

export type DisputeStatus = 'open' | 'won' | 'lost' | 'unsupported';
export type DisputeFacts = Readonly<{ disputeId: string; chargeId: string; status: DisputeStatus }>;
const openDispute = new Set(['warning_needs_response', 'warning_under_review', 'needs_response', 'under_review']);
export function disputeFacts(raw: Json, config: StripeConfiguration): DisputeFacts {
  if (raw.object !== 'dispute' || raw.livemode !== config.livemode || typeof raw.status !== 'string') return invalid();
  usd(raw.currency); minor(raw.amount);
  const status: DisputeStatus = openDispute.has(raw.status) ? 'open' : raw.status === 'won' || raw.status === 'lost' ? raw.status : 'unsupported';
  return Object.freeze({ disputeId: ref(raw.id, 'dp|du'), chargeId: ref(raw.charge, chargePrefix), status });
}

/** Canonical JSON with sorted keys: equal object facts digest equally regardless of key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Json).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}
