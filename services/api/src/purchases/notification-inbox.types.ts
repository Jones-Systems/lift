export type InboxNamespace = Readonly<{
  provider: 'Apple'; bundleId: string; environment: 'Sandbox' | 'Production'; appAppleId: number | null;
}>;
export type InboxNamespaceIdentity = Pick<InboxNamespace,'provider' | 'bundleId' | 'environment'>;
export type InboxOperation = 'capture' | 'verify' | 'promote' | 'claim' | 'complete' |
  'metadata' | 'proof' | 'replay' | 'dispose';
export type InboxCapability = Readonly<{ readonly inboxCapability: unique symbol }>;
export type VerifiedInboxNotification = Readonly<{ readonly verifiedInboxNotification: unique symbol }>;
export type PurchaseCommitFrame = Readonly<{ readonly purchaseCommitFrame: unique symbol }>;
export type InboxCursor = Readonly<{ readonly inboxCursor: unique symbol }>;
export type InboxReason = 'none' | 'invalid_outer' | 'invalid_nested' | 'verification_unknown' |
  'unknown_owner' | 'unsupported' | 'conflict' | 'overflow' | 'cancel_requested' | 'producer_unknown' |
  'reconsider_owner' | 'retry_verification' | 'applied' | 'disposed';
export type InboxAuthentication = 'captured' | 'verifying' | 'verified' | 'rejected' | 'verification_unknown';
export type InboxDisposition = 'unaccepted' | 'pending' | 'claimed' | 'held' | 'held_conflict' |
  'rejected' | 'completed' | 'applied';
export type InboxFailure = Readonly<{
  status: 'rejected' | 'unavailable' | 'capacity_exhausted' | 'version_conflict' | 'held_conflict' |
    'payload_unavailable' | 'unknown_commit' | 'identity_collision' | 'stale_cursor' | 'history_unavailable';
  acknowledge: false;
}>;
export type InboxPolicy = Readonly<{
  revision: string;
  maxEnvelopeBytes: number; maxPayloadBytes: number; maxNestedBytes: number;
  maxReceipts: number; maxVariants: number; maxVerificationClaims: number;
  maxAttempts: number; maxTransitions: number; maxOperationBytes: number; maxPageSize: number;
  ingressBytes: number; variantBytes: number; completionBytes: number;
  recordOverheadBytes: number;
  retention: Readonly<{ payloadMs: number; tombstoneMs: number; auditMs: number }>;
}>;
export type InboxCapture = Readonly<{
  operationId: string; receiptId: string; signedPayload: Uint8Array; envelopeBytes: number;
  provenance: 'synthetic_ingress' | 'synthetic_history';
}>;
export type InboxVersions = Readonly<{ receipt: number; work: number; aggregate: number }>;
export type InboxClaim = Readonly<{
  receiptId: string; workId: string; processingAttemptId: string; generation: number;
  custodyId: string; storeGeneration: string; versions: InboxVersions;
}>;
export type InboxMetadata = Readonly<{
  receiptId: string; aggregateReference: string | null; namespace: InboxNamespaceIdentity | null;
  receiptSequence: number; receivedAt: number; byteLength: number;
  authentication: InboxAuthentication; processingDisposition: InboxDisposition;
  stateVersion: number; reason: InboxReason; payloadAvailable: boolean; retryEligible: boolean;
}>;
export type InboxSuccess = Readonly<{
  status: 'ok'; receiptId: string; version: number; acknowledge: boolean;
  workId?: string; aggregateVersion?: number; disposition?: InboxDisposition; claim?: InboxClaim;
}>;
export type InboxResult = InboxSuccess | InboxFailure;
export type InboxOuter = Readonly<{
  namespace: InboxNamespace; notificationUUID: string;
  signedTransaction: string | null; signedRenewal: string | null;
}>;
export type InboxNested = Readonly<{
  namespace: InboxNamespace; originalTransactionId: string; appAccountToken: string | null;
}>;
export type SyntheticInboxVerifier = Readonly<{
  outer(payload: string): Promise<InboxOuter>;
  transaction(payload: string): Promise<InboxNested>;
  renewal(payload: string): Promise<InboxNested>;
}>;
export type InboxSettlement = Readonly<{
  custodyId: string; generation: number; settled: boolean;
}>;
