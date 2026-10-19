import type { AccountContext, LifecycleBindings, LifecycleAdapter } from '../lifecycle/types.js';
import type { Sqlite } from '../storage.js';

export const usageMetrics = ['live_voice_ms', 'coach_messages', 'workout_generations'] as const;
export type UsageMetric = typeof usageMetrics[number];
export type UsageCharge = Readonly<{ metric: UsageMetric; amount: number }>;
export type UsagePeriod = Readonly<{ id: string; startMs: number; endMs: number }>;
export type ReservationState = 'reserved' | 'dispatching' | 'unknown' | 'settled' | 'released';
export type UsageIntent = Readonly<{
  operation: string;
  idempotencyKey: string;
  intentHash: string;
  subjectId: string;
  charges: readonly UsageCharge[];
  dispatchStages: readonly string[];
}>;

declare const handleBrand: unique symbol;
/** Internal server capability. Do not serialize this handle into a public response. */
export type UsageReservationHandle = Readonly<{
  reservationId: string;
  actor: AccountContext;
  operation: string;
  intentHash: string;
  subjectId: string;
  [handleBrand]: true;
}>;
export type UsageMetricSnapshot = Readonly<{
  limit: number; settled: number; reserved: number; unknown: number; remaining: number;
}>;
export type UsageSnapshot = Readonly<{
  schemaVersion: 1;
  configured: boolean;
  policyId: string | null;
  serverTimeMs: number;
  period: UsagePeriod | null;
  metrics: Readonly<Record<UsageMetric, UsageMetricSnapshot>> | null;
  ordinaryWorkoutExecution: 'unrestricted_by_usage_limits';
  ordinaryWorkoutLogging: 'unrestricted_by_usage_limits';
}>;
export type UsageReservationResult = Readonly<{
  kind: 'new' | 'replay';
  handle: UsageReservationHandle;
  state: ReservationState;
  snapshot: UsageSnapshot;
}>;
export type UsageDispatchPermit = Readonly<{ reservationId: string; stage: string; dispatchedAtMs: number }>;
export type UsageLimitsPort = Readonly<{
  reserve: (actor: AccountContext, intent: UsageIntent) => UsageReservationResult;
  markDispatching: (handle: UsageReservationHandle, stage: string) => UsageDispatchPermit;
  status: (actor: AccountContext) => UsageSnapshot;
}>;

export type UsageEconomics = Readonly<{
  providerId: string;
  modelId: string;
  sourceId: string;
  telemetry: 'missing' | 'partial' | 'complete';
  quantities: readonly Readonly<{ unitId: string; quantity: number }>[];
}>;
export type UsageSettlement = Readonly<{
  charges: readonly UsageCharge[];
  economics?: readonly UsageEconomics[];
}>;
export type UsageReconciliation =
  | Readonly<{ outcome: 'settled'; evidenceId: string; settlement: UsageSettlement }>
  | Readonly<{ outcome: 'not_consumed'; evidenceId: string }>;
/** Recovery is trusted server-only authority; original fences are checked without new admission. */
export type TrustedUsageControls = Readonly<{
  recover: (actor: AccountContext, reservationId: string) => UsageReservationHandle;
  settle: (handle: UsageReservationHandle, settlement: UsageSettlement) => UsageSnapshot;
  release: (handle: UsageReservationHandle) => UsageSnapshot;
  markUnknown: (handle: UsageReservationHandle) => UsageSnapshot;
  reconcile: (handle: UsageReservationHandle, evidence: UsageReconciliation) => UsageSnapshot;
}>;

export type UsageOperationPolicy = Readonly<{ capability: string; metrics: readonly UsageMetric[] }>;
export type UsagePolicy = Readonly<{
  id: string;
  periodPolicyId: string;
  periodResolver: (atMs: number) => UsagePeriod;
  periodAllocation: 'reservation_period';
  liveRounding: 'exact_milliseconds';
  liveMessageCounting: 'included' | 'excluded';
  limits: Readonly<Record<UsageMetric, number>>;
  operations: Readonly<Record<string, UsageOperationPolicy>>;
}>;
export type UsageRights = Readonly<{
  policyId: string;
  capabilities: readonly string[];
  configuredOperations: readonly string[];
}>;
export type UsageLedgerOptions = Readonly<{
  db: Sqlite;
  lifecycle: LifecycleBindings;
  policy?: UsagePolicy;
  resolveRights?: (actor: AccountContext) => UsageRights;
  lifecycleControl?: Readonly<{
    assertSuppression: (accountId: string, epoch: number) => void;
    assertPurge: (requestId: string, accountId: string) => void;
  }>;
  now: () => number;
}>;
export type UsageLedger = Readonly<{
  usage: UsageLimitsPort;
  trusted: TrustedUsageControls;
  lifecycle: LifecycleAdapter;
}>;
