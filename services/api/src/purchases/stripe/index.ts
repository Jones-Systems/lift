export { stripeWebMigration, stripeWebSchemaVersion, stripeWebTables } from './migration.js';
export { stripeCatalog, stripeConfiguration, stripeApiVersion, stripeCurrency, stripeNamespace } from './configuration.js';
export type { StripeConfiguration, Plan } from './configuration.js';
export { buildCheckoutRequest, buildPortalRequest, buildCancellationRequest } from './requests.js';
export type { StripeHttpClient, StripeRequest } from './requests.js';
export { verifyStripeSignature } from './signature.js';
export { StripeWebPurchases } from './service.js';
export type { StripeOutcome, StripePorts, OtherChannel, OtherChannelGuard, StripeCheckoutResult, StripeObservation,
  StripeHeldConflict, StripeConflictKind, StripeCancellation } from './service.js';
export { proposePurchaseAccessMerge } from './merge.js';
export type { StripeGrant, PurchaseAccessProposal } from './merge.js';
export { stripeLifecycleTableCoverage } from './lifecycle.js';

import type { Sqlite } from '../../storage.js';
import type { AccountContext, LifecycleAdapter } from '../../lifecycle/types.js';
import { stripeConfiguration, type StripeConfiguration } from './configuration.js';
import { StripeWebPurchases, type StripeHeldConflict, type StripeObservation, type StripePorts } from './service.js';
export function createStripeWebPurchases(db: Sqlite, configuration?: StripeConfiguration, ports?: StripePorts) {
  const config = stripeConfiguration(configuration);
  if (!config) return null;
  if (!ports || db.memory || !db.name) throw new Error('stripe_durable_composition_required');
  return new StripeWebPurchases(db, config, ports);
}
/**
 * Stripe-owned seam for Platform. observe() is a pure, non-granting read: it never writes, never decides access and
 * returns unavailable for a suppressed account. heldConflicts() is additive, for owner/Platform conflict resolution.
 */
export interface StripeEntitlementSource {
  observe(ctx: AccountContext): StripeObservation;
  heldConflicts(ctx: AccountContext): readonly StripeHeldConflict[];
}
export function createStripeEntitlementSource(service: StripeWebPurchases): StripeEntitlementSource {
  return Object.freeze({ observe: (ctx: AccountContext) => service.observe(Object.freeze({ ...ctx })),
    heldConflicts: (ctx: AccountContext) => service.heldConflicts(Object.freeze({ ...ctx })) });
}
export function stripeLifecycleContributor(service: StripeWebPurchases): LifecycleAdapter {
  return service.lifecycle();
}
