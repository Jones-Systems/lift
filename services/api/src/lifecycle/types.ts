export type AccountContext = Readonly<{ accountId: string; authUserId: string; sessionId: string; epoch: number }>;
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
