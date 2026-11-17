import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { canonical, hash } from '../storage.js';
import type { ReservationState, UsageIntent, UsageLedger, UsageMetric, UsageSnapshot } from './types.js';

/**
 * Unmounted admission counters for one-unit operations (a coach message or a workout generation).
 *
 * This wraps the real ledger only: there is no route, no provider and no default policy here. A caller admits an
 * operation, runs its own external effect between `begin()` and `settle()`, and the ledger owns idempotency, caps,
 * actor fencing and period allocation. The reservation handle stays inside the admission closure and is never exposed.
 */
export const usageCounterKinds = ['coach_message', 'workout_generation'] as const;
export type UsageCounterKind = typeof usageCounterKinds[number];
export type UsageCounterRequest = Readonly<{ idempotencyKey: string; subjectId: string; requestSha256: string }>;
/**
 * Replay contract for callers: `settled` means return the caller's own stored result for that key (the ledger stores
 * none); `reserved`, `dispatching` and `unknown` mean the original attempt owns the outcome, so never run the effect
 * again; `released` means the key is spent and the client must send a new key.
 */
export type UsageCounterAdmission =
  | Readonly<{
    kind: 'new'; reservationId: string; snapshot: UsageSnapshot;
    /** Call outside any SQLite transaction, immediately before the external effect. */
    begin(): void;
    settle(): UsageSnapshot;
    /** Only before `begin()`. */
    release(): UsageSnapshot;
    notConsumed(evidenceId: string): UsageSnapshot;
    markUnknown(): UsageSnapshot;
  }>
  | Readonly<{ kind: 'replay'; reservationId: string; state: ReservationState; snapshot: UsageSnapshot }>;
export type UsageCounters = Readonly<{
  admit(kind: UsageCounterKind, actor: AccountContext, request: UsageCounterRequest): UsageCounterAdmission;
}>;

const effectStage = 'effect';
const metricByKind: Readonly<Record<UsageCounterKind, UsageMetric>> = Object.freeze({
  coach_message: 'coach_messages', workout_generation: 'workout_generations',
});

export function createUsageCounters(ledger: Pick<UsageLedger, 'usage' | 'trusted'>): UsageCounters {
  const { usage, trusted } = ledger;
  return Object.freeze({
    admit(kind: UsageCounterKind, actor: AccountContext, request: UsageCounterRequest): UsageCounterAdmission {
      if (typeof kind !== 'string' || !Object.hasOwn(metricByKind, kind)) throw new DomainError(400, 'usage_counter_kind_invalid');
      if (request === null || typeof request !== 'object') throw new DomainError(400, 'usage_invalid_identifier');
      const { idempotencyKey, subjectId, requestSha256 } = request;
      if (typeof requestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(requestSha256)) throw new DomainError(400, 'usage_invalid_intent_hash');
      // Non-strings cannot be canonicalised safely; the ledger applies the exact identifier rules to the rest.
      if (typeof idempotencyKey !== 'string' || typeof subjectId !== 'string') throw new DomainError(400, 'usage_invalid_identifier');
      const metric = metricByKind[kind];
      const result = usage.reserve(actor, {
        operation: kind, idempotencyKey, subjectId,
        intentHash: hash(canonical({ v: 1, operation: kind, subjectId, requestSha256 })),
        charges: [{ metric, amount: 1 }], dispatchStages: [effectStage],
      } satisfies UsageIntent);
      if (result.kind === 'replay') {
        return Object.freeze({ kind: 'replay', reservationId: result.handle.reservationId, state: result.state, snapshot: result.snapshot });
      }
      const handle = result.handle;
      return Object.freeze({
        kind: 'new', reservationId: handle.reservationId, snapshot: result.snapshot,
        begin(): void { usage.markDispatching(handle, effectStage); },
        settle: () => trusted.settle(handle, { charges: [{ metric, amount: 1 }] }),
        release: () => trusted.release(handle),
        notConsumed: (evidenceId: string) => trusted.reconcile(handle, { outcome: 'not_consumed', evidenceId }),
        markUnknown: () => trusted.markUnknown(handle),
      });
    },
  });
}
