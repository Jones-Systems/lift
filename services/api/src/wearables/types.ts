import type { AccountContext } from '../lifecycle/types.js';
export type { AccountContext };
export type Provider = 'healthkit' | 'oura' | 'garmin';
export type Metric = 'steps' | 'active_energy' | 'resting_hr' | 'hrv_sdnn' | 'hrv_rmssd' |
  'sleep_asleep' | 'sleep_in_bed' | 'body_mass' | 'workout_duration' | 'workout_energy' | 'workout_distance' | 'vendor_score';
export type Measure = Readonly<{
  id: string; metric: Metric; value: number; unit: 'count' | 'kcal' | 'bpm' | 'ms' | 's' | 'kg' | 'm' | 'score';
  start: string | null; end: string | null; day: string; zone: string | null;
  aggregation: 'sum' | 'mean' | 'latest' | 'interval_union' | 'workout' | 'vendor_algorithm';
  source: { bundleId: string; name: string; device: string | null; algorithm: string | null; eventTimestamp?: string | null; originalId: string | null };
  revision: { token: string; order: number | null };
  quality: 'complete' | 'partial' | 'unknown';
}>;
export type StoredMeasure = Measure & Readonly<{
  connectionId: string; generation: number; provider: Provider; importedAt: string;
  digest: string; aiEligible: false; provenance: 'unqualified_import';
  deleted: boolean;
}>;
export type ImportPage = Readonly<{
  version: 1; connectionId: string; generation: number; stream: string;
  fromCursor: string | null; nextCursor: string | null; pageId: string;
  batch: Measure[]; tombstones: { id: string; revision: { token: string; order: number | null } }[];
}>;
export type Connection = Readonly<{
  id: string; provider: Provider; generation: number; connected: boolean;
  types: Metric[]; consentVersion: string; retentionConsent: boolean; lastImportAt: string | null;
}>;
export type ReceiptScope = Readonly<{ connectionId: string; generation: number }>;
export type Receipt = Readonly<
  { fingerprint: string; scope: ReceiptScope | null; purged?: false; result: unknown } |
  { fingerprint: string; scope: null; purged: true }
>;
export type ImportResult = Readonly<{ accepted: number; duplicates: number; cursor: string | null; pageId: string }>;
export type PlanItem = { id: string; exerciseId: string; setTarget: number; repMin: number; repMax: number; targetKg: number };
export type Suggestion = Readonly<{
  id: string; planId: string; baseRevision: number; appliedRevision: number | null;
  state: 'pending' | 'applied' | 'rejected' | 'undone' | 'invalidated';
  beforeItems: PlanItem[]; afterItems: PlanItem[]; reviewDigest: string;
  expiresAt: string; reason: string; limits: string[]; policyVersion: string;
  evidenceRefs: { connectionId: string; generation: number; id: string; digest: string }[];
}>;
export interface WearableStore {
  connection(ctx: AccountContext, id: string): Connection | null;
  connections(ctx: AccountContext): Connection[];
  putConnection(ctx: AccountContext, connection: Connection): void;
  cursor(ctx: AccountContext, connection: string, generation: number, stream: string): string | null;
  putCursor(ctx: AccountContext, connection: string, generation: number, stream: string, cursor: string | null): void;
  measure(ctx: AccountContext, connection: string, generation: number, id: string): StoredMeasure | null;
  putMeasure(ctx: AccountContext, value: StoredMeasure): void;
  measures(ctx: AccountContext, from: string, to: string, limit: number): StoredMeasure[];
  receipt(ctx: AccountContext, key: string): Receipt | null;
  putReceipt(ctx: AccountContext, key: string, receipt: Receipt): void;
  suggestions(ctx: AccountContext): Suggestion[];
  suggestion(ctx: AccountContext, id: string): Suggestion | null;
  putSuggestion(ctx: AccountContext, value: Suggestion): void;
  purgeConnection(ctx: AccountContext, id: string): void;
  purgeBefore(ctx: AccountContext, before: string): number;
}
export interface PlanRevisionPort {
  capability: 'atomic_suggestions_v1';
  readWithinWrite(ctx: AccountContext, planId: string): { revision: number; items: PlanItem[]; activeWorkout: boolean };
  applyWithinWrite(ctx: AccountContext, input: {
    planId: string; expectedRevision: number; items: PlanItem[];
    receipt: { operation: 'suggestion_accept' | 'suggestion_undo'; suggestionId: string };
  }): { revision: number };
}
export interface RootPorts {
  // Same immediate database transaction as every store/plan/receipt operation; no async callbacks.
  withActiveWrite<T>(ctx: AccountContext, effect: () => T): T;
  assertActive(ctx: AccountContext): void;
  assertImportAllowed(ctx: AccountContext, provider: Provider): void;
  store: WearableStore;
  enabled?(): boolean;
  now(): string;
  plans?: PlanRevisionPort;
  assertSuggestionAllowed?(ctx: AccountContext, suggestion: Suggestion): void;
  // Returns a shared identity ONLY after trusted alias evidence; client labels are insufficient.
  alias?(ctx: AccountContext, value: StoredMeasure): string | null;
}
export type ImportChannel = Readonly<{ provider: Provider }>;
