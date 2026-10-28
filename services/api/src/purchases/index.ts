import type { AccountContext } from '../lifecycle/types.js';
import type { Sqlite } from '../storage.js';
import { createAppleSandboxVerifier, createAppleSandboxReconciliationVerifier } from './apple-verifier.js';
import { ApplePurchaseReconciliation, type AppleReconciliationPorts } from './reconciliation.js';
import type { OwnerReconciliation, NotificationOutcome } from './reconciliation.types.js';
import { validateAppleConfiguration } from './configuration.js';
import { ApplePurchaseService } from './service.js';
import type { AppleSandboxConfiguration, AppleDeliveryDecision, AppleEntitlementGrant } from './types.js';
export { applePurchaseMigrationSql } from './migration.js';
export { applePurchaseReconciliationMigrationSql } from './reconciliation-migration.js';
export { createAppleHistoryReader } from './history-adapter.js';
export { createAppleStatusTransport } from './status-adapter.js';
export { AppleSubscriptionStatusReader } from './status.js';
export type { AppleStatusTransport, AppleStatusOwners, AppleSubscriptionStatus, AppleSubscriptionStatusObservation,
  AppleSubscriptionStatusOutcome, AppleSubscriptionStatusPorts } from './reconciliation.types.js';
export type { AppleReconciliationPorts } from './reconciliation.js';
export type { PurchaseOwner, ReconciliationCheckpoint, ReconciliationOutcome, NotificationOutcome,
  PurchaseOwnerWriter, PurchaseBackgroundWriter, OwnerReconciliation, AppleHistoryReader } from './reconciliation.types.js';
export { validateAppleConfiguration, parseAppleDeliveryRequest } from './configuration.js';
export type { AppleSandboxConfiguration, AppleDeliveryRequest, AppleDeliveryDecision, AppleEntitlementGrant } from './types.js';

export function createAppleSandboxPurchases(db: Sqlite, configuration?: AppleSandboxConfiguration) {
  const config = configuration === undefined ? undefined : validateAppleConfiguration(configuration);
  if (config && (!db.name || db.name === ':memory:')) throw new Error('Runtime Apple purchases require durable SQLite');
  const service = config ? new ApplePurchaseService(db, config, createAppleSandboxVerifier(config)) : undefined;
  return {
    async deliver(authenticatedAccountId: string, request: unknown, context?: AccountContext): Promise<AppleDeliveryDecision> {
      return service ? service.deliver(authenticatedAccountId, request, context) : { status: 'unknown', code: 'purchase_verification_unconfigured' };
    },
    entitlements(authenticatedAccountId: string): { grants: AppleEntitlementGrant[]; active: string[] } {
      return service?.entitlements(authenticatedAccountId) ?? { grants: [], active: [] };
    },
    accountBinding(authenticatedAccountId: string) { return service?.accountBinding(authenticatedAccountId) ?? null; },
    capabilities() {
      // Configured source and received proofs do not prove product lookup, signed native build or sandbox activation.
      return { status: config ? 'configured_unverified' as const : 'unconfigured' as const,
        environment: 'Sandbox' as const, chargesEnabled: false as const, verification: 'apple_jws_offline' as const,
        onlineCertificateRevocation: false as const };
    },
  };
}

export function createAppleSandboxReconciliation(db: Sqlite, configuration: AppleSandboxConfiguration | undefined,
  ports: AppleReconciliationPorts): {
    forOwner(actor: AccountContext): OwnerReconciliation;
    ingestNotification(signedPayload: string): Promise<NotificationOutcome>;
  } {
  if (configuration === undefined) return {
    forOwner: originalActor => {
      const actor = Object.freeze({ accountId: originalActor.accountId, authUserId: originalActor.authUserId,
        sessionId: originalActor.sessionId, epoch: originalActor.epoch });
      return {
        reconcileOwner: async (_owner, checkpoint) => {
          ports.ownerWriter.lifecycle.assertActive(actor);
          return { status: 'unavailable', handle: checkpoint.handle, committedPage: null, transactions: 0,
            reason: 'purchase_verification_unconfigured' };
        },
        readReconciliation: () => { ports.ownerWriter.lifecycle.assertActive(actor); return null; },
      };
    },
    ingestNotification: async () => ({ status: 'unavailable', notificationId: null, reason: 'purchase_verification_unconfigured' }),
  };
  if (!db.name || db.name === ':memory:') throw new Error('Runtime Apple reconciliation requires durable SQLite');
  const service = new ApplePurchaseReconciliation(db, configuration, createAppleSandboxReconciliationVerifier(configuration), ports);
  return { forOwner: actor => service.forOwner(actor), ingestNotification: payload => service.ingestNotification(payload) };
}

export { createSourceAppleSubscriptionStatus } from './status-source.js';
export type { SourceStatusFacade, SourceStatusOwnerFacade, SourceStatusResult, SourceStatusProducerCustody, SourceStatusOriginalProducer, SourceStatusProducerSettlement, SourceStatusProducerKind } from './status-source.js';
