import type { HistoryResponse, JWSRenewalInfoDecodedPayload, ResponseBodyV2DecodedPayload } from '@apple/app-store-server-library';
import type { AccountContext, LifecycleBindings } from '../lifecycle/types.js';
import type { Sqlite } from '../storage.js';
import type { AppleTransactionVerifier } from './types.js';

export type PurchaseOwner = Readonly<{
  accountId: string; appAccountToken: string; originalTransactionId: string; bundleId: string; environment: 'Sandbox';
}>;
export type ReconciliationCheckpoint = Readonly<{ handle: string; expectedPage: number }>;
export type ReconciliationOutcome = Readonly<{
  status: 'complete' | 'pending' | 'rejected' | 'unavailable' | 'unknown';
  handle: string; committedPage: number | null; transactions: number; reason: string | null;
}>;
export type NotificationOutcome = Readonly<{
  status: 'observed' | 'rejected' | 'unavailable' | 'unknown';
  notificationId: string | null; reason: string | null;
}>;
export interface AppleReconciliationVerifier extends AppleTransactionVerifier {
  notification(jws: string): Promise<ResponseBodyV2DecodedPayload>;
  renewal(jws: string): Promise<JWSRenewalInfoDecodedPayload>;
}
export interface AppleHistoryReader {
  page(originalTransactionId: string, revision: string | null): Promise<HistoryResponse>;
}
/** Untrusted provider JSON; validation belongs to the status reader, not SDK optional fields. */
export interface AppleStatusTransport {
  statuses(originalTransactionId: string): Promise<unknown>;
}
/** Trusted composition reads existing immutable bindings; this port cannot establish ownership. */
export interface AppleStatusOwners {
  read(originalTransactionId: string): PurchaseOwner | null;
}
export type AppleSubscriptionStatus = 'active' | 'expired' | 'billing_retry' | 'billing_grace_period' | 'revoked';
/** Verified evidence only. No access decision, grace grant, raw JWS or foreign-owner records. */
export type AppleSubscriptionStatusObservation = Readonly<{
  owner: PurchaseOwner;
  subscriptionGroupIdentifier: string;
  status: AppleSubscriptionStatus;
  transaction: Readonly<{
    transactionId: string; productId: string; purchaseDate: number; signedDate: number; expiresDate: number;
    revocationDate: number | null; isUpgraded: boolean;
  }>;
  renewal: Readonly<{
    productId: string; autoRenewProductId: string | null; signedDate: number; autoRenewStatus: 0 | 1;
    gracePeriodExpiresDate: number | null; isInBillingRetryPeriod: boolean | null;
  }>;
}>;
export type AppleSubscriptionStatusOutcome = Readonly<{
  status: 'observed' | 'pending' | 'rejected' | 'unavailable' | 'unknown';
  observations: readonly AppleSubscriptionStatusObservation[];
  reason: string | null;
}>;
export type AppleSubscriptionStatusPorts = Readonly<{
  appAppleId: number;
  owners: AppleStatusOwners;
  verifier: Pick<AppleReconciliationVerifier, 'verify' | 'renewal'>;
  transport?: AppleStatusTransport;
}>;
export type PurchaseOwnerWriter = Readonly<{
  lifecycle: Pick<LifecycleBindings, 'assertActive' | 'withActiveWrite'>;
  assertWithinWrite(actor: AccountContext): void;
  lifecycleStoreOptions: Readonly<{ assertRootWriter(candidate: Sqlite): void }>;
}>;
/** Composition owns provider authority and lifecycle admission; a session cannot be invented for a notification. */
export type PurchaseBackgroundWriter = Readonly<{
  capture(owner: PurchaseOwner): Readonly<{
    assertCurrent(): void;
    withWrite<T>(effect: () => T): T;
    assertWithinWrite(candidate: Sqlite): void;
  }>;
}>;
export type OwnerReconciliation = Readonly<{
  reconcileOwner(owner: PurchaseOwner, checkpoint: ReconciliationCheckpoint): Promise<ReconciliationOutcome>;
  readReconciliation(handle: string): ReconciliationOutcome | null;
}>;

export type { SourceStatusReconciliationHooks, SourceStatusLedgerHooks } from './status-projection.js';
