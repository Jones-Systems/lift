// Frozen structural contract: Form c6118bcf, src/wearables/native.ts and model.ts.
// The base lacks those files; keep these shapes compatible until WS01 integrates them.
export type HealthType = 'workouts' | 'steps' | 'activeEnergy' | 'restingHeartRate' | 'hrvSdnn' | 'sleep' | 'bodyMass';
export type NativeHealthRecord = {
  id: string; kind: 'daily' | 'workout'; type: HealthType; day: string; zone: string | null;
  start: string; end: string; sourceBundleId: string; sourceName: string; deviceModel: string | null;
  algorithm: string | null; originalId: string | null; revision: { token: string; order: number | null };
  quality: 'complete' | 'partial' | 'unknown';
  values: { metric: string; value: number; unit: string; aggregation: string }[];
};
export type NativePage = {
  records: NativeHealthRecord[];
  tombstones: { id: string; revision: { token: string; order: number | null } }[];
  anchor: string | null; more: boolean;
  // Pages must contain complete source-separated daily buckets/workouts, never half a bucket.
  logicalBucketsComplete: true;
};
export interface FormHealthNative {
  availability(): Promise<'available' | 'unavailable_device' | 'restricted'>;
  requestRead(types: HealthType[]): Promise<'prompted' | 'unnecessary'>;
  query(input: { type: HealthType; from: string; to: string; anchor: string | null; limit: number }): Promise<NativePage>;
  cancelAll(): Promise<void>;
}

export type HealthKitQueryContext = {
  accountId: string;
  sessionGeneration: string;
  connectionId: string;
  generation: number;
  deviceGeneration: string;
  type: HealthType;
  from: string;
  to: string;
  timeZone: string;
  normalizationVersion: 1;
};
export type HealthKitCheckpoint = { stream: string; cursor: string | null };
export type HealthKitJournalReceipt = {
  version: 1;
  context: HealthKitQueryContext;
  contextId: string;
  journalId: string;
  journalSerial: number;
  revisionOrder: number;
  stream: string;
  cursor: string | null;
};
export type HealthKitBindMode = 'create_connection' | 'create_stream' | 'resume';
export interface FormHealthQueryNative extends FormHealthNative {
  bindQueryContext(context: HealthKitQueryContext, checkpoint: HealthKitCheckpoint, mode: HealthKitBindMode): Promise<HealthKitJournalReceipt>;
  reconcileQueryCheckpoint(contextId: string, checkpoint: HealthKitCheckpoint): Promise<HealthKitJournalReceipt>;
  forgetQueryContext(context: HealthKitQueryContext, journalId: string, serial: number, receiptId: string): Promise<void>;
}
export type HealthKitSourceBinding = {
  context: HealthKitQueryContext;
  checkpoint: { read(): Promise<HealthKitCheckpoint> };
  isCurrentSession(): boolean;
};
export type HealthKitPurgeReceipt = {
  accountId: string;
  connectionId: string;
  generation: number;
  deviceGeneration: string;
  receiptId: string;
};
