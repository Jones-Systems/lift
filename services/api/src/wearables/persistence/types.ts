import type { Sqlite } from '../../storage.js';
import type { AccountContext, LifecycleAdapter, LifecycleBindings, LifecycleResult } from '../../lifecycle/types.js';
import type { Provider, ReceiptScope, StoredMeasure } from '../types.js';

export type PersistenceControl = {
  assertWithinWrite(ctx: AccountContext): void;
  assertSuppression(accountId: string, epoch: number): void;
  purgeReadiness(requestId: string, accountId: string): { status: 'ready'; epoch: number } | LifecycleResult;
};
export type WearablePersistenceDependencies = {
  db: Sqlite;
  lifecycle: LifecycleBindings;
  control: PersistenceControl;
  assertImportAllowed(ctx: AccountContext, provider: Provider): void;
  externalLifecycle?: LifecycleAdapter;
  // Local synchronous fence/purge only, with root-owned rollback. Unknown requires reconciliation before retry.
  // Scope generation is the currently stored generation, including the disconnect increment when applicable.
  // It fences all retained connection material through that generation, including earlier generations.
  externalConnectionPurge?(ctx: AccountContext, scope: ReceiptScope): LifecycleResult;
  qualifyExport?(ctx: AccountContext, record: StoredMeasure): boolean;
};
export type ProviderIntentBinding = {
  ctx: AccountContext; provider: Exclude<Provider, 'healthkit'>; connectionId: string;
  generation: number; stream: string; cursor: string | null;
};
export type HealthKitType = 'workouts' | 'steps' | 'activeEnergy' | 'restingHeartRate' | 'hrvSdnn' | 'sleep' | 'bodyMass';
export type HealthKitCheckpointBinding = {
  ctx: AccountContext; connectionId: string; generation: number;
  type: HealthKitType; from: string; to: string;
};
export type HealthKitCheckpoint = { read(): { stream: string; cursor: string | null } };
