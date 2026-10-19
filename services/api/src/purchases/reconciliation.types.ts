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
