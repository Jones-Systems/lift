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
import type { SourceStatusFacade } from '../status-source.js';
import { stripeConfiguration, type StripeConfiguration } from './configuration.js';
import type { StripeHttpClient } from './requests.js';
import { StripeWebPurchases, mergePurchaseEntitlements } from './service.js';
export function createStripeWebPurchases(db: Sqlite, configuration?: StripeConfiguration,
  ports?: { client: StripeHttpClient; secret: (reference: string) => string | undefined }) {
  const config = stripeConfiguration(configuration);
  if (!config) return null;
  if (!ports || db.memory || !db.name) throw new Error('stripe_durable_composition_required');
  return new StripeWebPurchases(db, config, ports.client, ports.secret);
}
// Optional account-facing composition preserves Apple's own evidence and lifecycle checks.
export function composeWebSubscriptionStatus(apple: SourceStatusFacade, stripe: StripeWebPurchases) {
  return Object.freeze({ forOwner(actor: AccountContext) {
    const captured = Object.freeze({...actor}), owner = apple.forOwner(captured);
    return Object.freeze({...owner, entitlements: () => mergePurchaseEntitlements(owner.entitlements(),stripe.entitlements(captured))});
  }, ingestNotification: apple.ingestNotification, stripeLifecycle: stripe.lifecycle() });
}
