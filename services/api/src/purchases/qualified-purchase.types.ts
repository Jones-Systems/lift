import type { Sqlite } from '../storage.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { InboxNamespace, InboxPolicy } from './notification-inbox.types.js';
import type { AppleProduct } from './types.js';

/** The durable namespace is exactly Apple, bundle and verified environment. appAppleId never forks it. */
export type PurchaseNamespace = InboxNamespace;

export type QualifiedNamespaceConfiguration = Readonly<{
  namespace: PurchaseNamespace;
  products: readonly AppleProduct[];
  statusAppAppleId: number | null;
}>;

export type QualifiedPurchaseConfiguration = Readonly<{
  mode: 'source-only';
  cohort: 'qualified-purchases-v1';
  use: 'isolated-synthetic';
  revision: string;
  namespaces: readonly QualifiedNamespaceConfiguration[];
}>;

/** Engineering fixture ceilings only. They are neither commercial nor live retention policy. */
export type QualifiedPurchasePolicy = Readonly<{
  revision: string;
  maxNamespaces: number;
  maxPageSize: number;
  maxMetadataRows: number;
  maxEvidenceBytes: number;
  maxHistoryPageBytes: number;
  maxHistoryItems: number;
  retention: Readonly<{ evidenceMs: number; identityMs: number; auditMs: number }>;
}>;

/** A qualified owner is immutable: no account is inferred from a similar token. */
export type QualifiedPurchaseOwner = Readonly<{
  namespace: PurchaseNamespace;
  originalTransactionId: string;
  accountId: string;
  appAccountToken: string;
}>;

/** Opaque, privately registered. Public wire fields, brand casts and copies cannot construct one. */
export type PurchaseAccessContext = Readonly<{ readonly purchaseAccessContext: unique symbol }>;
/** Opaque, privately registered reader cursor. Client supplied strings are never accepted. */
export type QualifiedObservationCursor = Readonly<{ readonly qualifiedObservationCursor: unique symbol }>;

export type QualifiedProjectionHoldReason =
  | 'not_current' | 'expired' | 'binding' | 'source_generation' | 'observation' | 'clock'
  | 'provenance_required' | 'provenance_inconsistent'
  | 'dependency_missing' | 'dependency_namespace' | 'dependency_changed'
  | 'dependency_conflicted' | 'dependency_invalidated' | 'dependency_evidence' | 'dispatch_unresolved';

export type QualifiedNotificationEvidence = Readonly<{
  aggregateId: string; aggregateVersion: number; notificationUUID: string;
  receiptId: string; canonicalReceiptId: string; payloadDigest: string; storeId: string; storeGeneration: string;
}>;

export type QualifiedStatusEvidence = Readonly<{
  version: 'qualified-status-evidence/v1';
  provenance: 'independent_status' | 'notification_evidence';
  validUntilMs: number | null;
  notifications: readonly QualifiedNotificationEvidence[];
}>;

export type QualifiedProjectionRead =
  | Readonly<{ status: 'synthetic_current'; namespace: PurchaseNamespace; selectionGeneration: string; revision: number }>
  | Readonly<{ status: 'held'; namespace: PurchaseNamespace; selectionGeneration: string; revision: number; reason: QualifiedProjectionHoldReason }>
  | Readonly<{ status: 'absent'; namespace: PurchaseNamespace; selectionGeneration: string }>;

export type QualifiedDeliveryMetadata = Readonly<{
  namespace: PurchaseNamespace;
  transactionId: string;
  proofHash: string;
  productId: string;
  serverDeliveryId: string;
  deliveryPolicyRevision: string;
  deliveredAtMs: number;
}>;

export type QualifiedReconciliationMetadata = Readonly<{
  namespace: PurchaseNamespace;
  handle: string;
  originalTransactionId: string;
  expectedPage: number;
  outcomeKind: string;
}>;

export type QualifiedObservationMetadata = Readonly<{
  sequence: number;
  namespace: PurchaseNamespace;
  eventKind: 'dispatch' | 'status' | 'history' | 'notification' | 'outcome';
  observedAtMs: number;
}>;

export type QualifiedObservationPage = Readonly<{
  records: readonly QualifiedObservationMetadata[];
  cursor: QualifiedObservationCursor | null;
}>;

/** Source-visible, closed reader refusal codes. They carry no payload, token or free-form provider text. */
export type QualifiedRefusalCode =
  | 'context_unavailable' | 'selection_changed' | 'account_unavailable' | 'store_unavailable'
  | 'invalid_request' | 'stale_cursor' | 'history_unavailable' | 'clock_unavailable'
  | 'transaction_not_allowed' | 'limit_exceeded';

export type QualifiedPurchaseReader = Readonly<{
  owner(context: PurchaseAccessContext, originalTransactionId: string): QualifiedPurchaseOwner | null;
  delivery(context: PurchaseAccessContext, transactionId: string, proofHash: string): QualifiedDeliveryMetadata | null;
  reconciliation(context: PurchaseAccessContext, handle: string): QualifiedReconciliationMetadata | null;
  projection(context: PurchaseAccessContext, originalTransactionId: string): QualifiedProjectionRead;
  listObservationMetadata(context: PurchaseAccessContext,
    request: Readonly<{ limit: number; cursor?: QualifiedObservationCursor }>): QualifiedObservationPage;
}>;

/** Synthetic fixture quiescence attestation. It is neither operational authority nor producer settlement. */
export type SyntheticCurrentness = Readonly<{
  generation: string;
  check: (state: Readonly<{ storeId: string; generation: string; currentnessGeneration: string;
    phase: 'before-backup' | 'after-backup' | 'under-lock' | 'reopen' }>) => unknown;
}>;

export type SyntheticStoreInput = Readonly<{
  use: 'isolated-synthetic';
  configuration: unknown;
  storeId: string;
  generation: string;
  inbox: Readonly<{ ingress: string; policy: InboxPolicy }>;
  policy: unknown;
  currentness: SyntheticCurrentness;
}>;

export type QualifiedStorageIdentity = Readonly<{
  db: Sqlite;
  storeId: string;
  generation: string;
  schemaDigest: string;
}>;
/** Owned handles close; borrowed handles never expose a close method for another owner's database. */
export type QualifiedStorage =
  | (QualifiedStorageIdentity & Readonly<{ ownership: 'owned'; migrationBackups: readonly string[]; close(): void }>)
  | (QualifiedStorageIdentity & Readonly<{ ownership: 'borrowed'; backups: readonly string[] }>);

export type SyntheticAccountState = Readonly<{ suppressed: boolean; epoch: number; current: boolean }>;
export type SyntheticSelection = Readonly<{ namespace: PurchaseNamespace; generation: string }>;
export type SyntheticAccessInput = Readonly<{
  use: 'isolated-synthetic';
  storeId: string;
  generation: string;
  configurationRevision: string;
  policyRevision: string;
  authorityGeneration: string;
  currentSelection: (accountId: string) => SyntheticSelection | null;
  accountState: (accountId: string) => SyntheticAccountState;
  currentness: () => unknown;
}>;
export type SyntheticAccessIssuer = Readonly<{
  forOwner(actor: AccountContext): PurchaseAccessContext;
  revoke(context: PurchaseAccessContext): void;
  close(): void;
}>;
