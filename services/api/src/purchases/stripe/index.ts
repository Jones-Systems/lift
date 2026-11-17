export { stripePurchaseMigrationSql } from './migration.js';
export { stripeCatalog, stripeConfiguration, stripeApiVersion } from './configuration.js';
export type { StripeConfiguration, Plan } from './configuration.js';
export { buildCheckoutRequest, buildPortalRequest } from './requests.js';
export type { StripeHttpClient, StripeRequest } from './requests.js';
export { verifyStripeSignature } from './signature.js';
export { StripeWebPurchases, mergePurchaseEntitlements } from './service.js';
export type { StripeOutcome, StripeGrant } from './service.js';

import type { Sqlite } from '../../storage.js';
import type { AccountContext } from '../../lifecycle/types.js';
import { stripeConfiguration, type StripeConfiguration } from './configuration.js';
import type { StripeHttpClient } from './requests.js';
import { StripeWebPurchases, type StripeGrant } from './service.js';
export function createStripeWebPurchases(db: Sqlite, configuration?: StripeConfiguration,
  ports?: { client: StripeHttpClient; secret: (reference: string) => string | undefined }) {
  const config = stripeConfiguration(configuration);
  if (!config) return null;
  if (!ports || db.memory || !db.name) throw new Error('stripe_durable_composition_required');
  return new StripeWebPurchases(db, config, ports.client, ports.secret);
}
// Stripe-owned contract for future Platform registration; no existing projection seam is changed.
export interface StripeEntitlementSource {
  read(actor: AccountContext): Readonly<{ grants: readonly StripeGrant[]; active: readonly string[] }>;
}
export function createStripeEntitlementSource(service: StripeWebPurchases): StripeEntitlementSource {
  return Object.freeze({ read: (actor: AccountContext) => service.entitlements(Object.freeze({...actor})) });
}
export function stripeLifecycleContributor(service: StripeWebPurchases) {
  return service.lifecycle();
}
