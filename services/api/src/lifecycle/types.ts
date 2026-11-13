export type AccountContext = Readonly<{ accountId: string; authUserId: string; sessionId: string; epoch: number }>;
export type SourceActionPurpose = 'account_delete' | 'account_export';
export type SourceActionMethod = 'email_action_code' | 'phone_action_code';
export type SourceActionState = 'dispatching' | 'ready' | 'failed' | 'unknown' | 'invalidated' | 'expired' | 'consumed';
export type SourceActionConfiguration = Readonly<{ mode: 'source-only'; cohort: 'action-reauthentication-v1' }>;
export type SourceActionIssue = Readonly<{ purpose: SourceActionPurpose; method: SourceActionMethod; requestKey: string }>;
export type SourceActionVerify = Readonly<{ challengeId: string; purpose: SourceActionPurpose; code: string }>;
export type SourceActionChallenge = Readonly<{ challengeId: string; purpose: SourceActionPurpose; method: SourceActionMethod; expiresAt: string; state: SourceActionState }>;
export type SourceActionDeliveryRequest = Readonly<{ challengeId: string; purpose: SourceActionPurpose; method: SourceActionMethod;
  authUserId: string; destination: string; subjectDigest: string; code: string; deadlineAtMs: number }>;
// Fulfillment attests producer/resource completion; an acknowledgment alone is insufficient.
export type SourceActionDeliveryResult = Readonly<{ challengeId: string; method: SourceActionMethod; subjectDigest: string;
  disposition: 'accepted' | 'rejected' | 'unknown' }>;
export type SourceActionDelivery = Readonly<{ start: (request: SourceActionDeliveryRequest) => Readonly<{
  settled: Promise<SourceActionDeliveryResult>; cancel: () => Promise<void> }> }>;
export type SourceActionKeys = Readonly<{ currentKeyId: () => string; lookup: (keyId: string) => Uint8Array | null }>;
export type LifecycleResult = Readonly<{ status: 'complete' | 'pending' | 'unavailable' | 'unknown' | 'retained'; reason?: string; count?: number }>;
export type ScopedInventory = LifecycleResult & Readonly<{ category: string }>;
export type ExportSnapshot = Readonly<{ snapshotAtMs: number; append: (category: string, value: unknown) => void }>;
export type SafeExportSection = LifecycleResult & Readonly<{ category: string }>;
export type LifecycleAdapter = Readonly<{
  category: string;
  inventory: (context: AccountContext) => ScopedInventory;
  export: (context: AccountContext, snapshot: ExportSnapshot) => SafeExportSection;
  suppress: (accountId: string, epoch: number) => LifecycleResult;
  purge: (requestId: string, accountId: string) => LifecycleResult;
  verifySuppressed: (accountId: string, epoch: number) => LifecycleResult;
}>;
export type DisableRecord = Readonly<{ accountId: string; authUserId: string; epoch: number; requestId: string; disabledAtMs: number; sequence: number }>;
export type SuppressionLedger = Readonly<{
  recordDisable: (record: Omit<DisableRecord, 'sequence'>) => DisableRecord;
  lookup: (accountId: string) => DisableRecord | null;
  currentSequence: () => number;
  reconcileRestore: (apply: (record: DisableRecord) => void) => number;
}>;
export type AdultEligibility = Readonly<{ policy: 'self_reported_adult_v1'; status: 'eligible' | 'not_adult' | 'unknown'; profileRevision: number | null }>;
export type LifecycleBindings = Readonly<{
  assertActive: (context: AccountContext) => void;
  withActiveWrite: <T>(context: AccountContext, effect: () => T) => T;
  adultEligibility: (context: AccountContext) => AdultEligibility;
}>;
