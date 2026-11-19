import type { LifecycleTableCoverage } from '../../lifecycle/coverage.js';
import { stripeWebTables } from './migration.js';

type Table = (typeof stripeWebTables)[number];
const shared = { owner: 'Purchases Stripe web subscriptions', disposition: 'retained',
  limits: 'Namespaced by provider, environment and Stripe account; references only, no card data, raw payloads or secrets.',
  residual: 'Stripe-side Customer deletion and any unconfirmed cancellation remain pending_external; no retention deadline is claimed.',
  evidence: 'purchases/stripe/migration.ts; purchases/stripe/service.ts#lifecycle' } as const;
const detail: Record<Table, Readonly<{ attribution: string; mechanism: string }>> = {
  stripe_web_customers: { attribution: 'account_id fixed at binding from an authenticated server-created Checkout client_reference_id',
    mechanism: 'Immutable binding (update trigger); export references it; purge retains it and reports pending_external Customer deletion.' },
  stripe_web_subscriptions: { attribution: 'account_id via composite FK to the immutable customer binding',
    mechanism: 'Suppress sets sticky suppressed and records cancellation; revocation is sticky; suspension is reversible; purge retains.' },
  stripe_web_events: { attribution: 'account_id of the attributed subscription/customer; unattributed events are not stored',
    mechanism: 'Dedupe receipts by event ID with a fact digest; only a transition to held is allowed; not exported; purge retains.' },
  stripe_web_disputes: { attribution: 'account_id via composite FK to the subscription',
    mechanism: 'Open disputes suspend access; won/lost are terminal; export references status; purge retains.' },
  stripe_web_cancellations: { attribution: 'account_id via composite FK to the subscription',
    mechanism: 'pending_external rows with a built request; explicit send records unknown before confirmed canceled; purge retains.' },
  stripe_web_conflicts: { attribution: 'account_id of the existing owner; another account is never stored in this partition',
    mechanism: 'Held conflict facts reject update/delete; observe fails closed except dual_channel_conflict; purge retains.' },
};
/** Inventory rows for Platform's coverage registry. cohort is deliberately unset; Platform assigns it on registration. */
export const stripeLifecycleTableCoverage: readonly Omit<LifecycleTableCoverage, 'cohort'>[] = Object.freeze(
  stripeWebTables.map(table => Object.freeze({ table, ...shared, ...detail[table] })));
