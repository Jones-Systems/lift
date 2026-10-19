import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { allocateLiveUsageInterval } from './live-allocation.js';
import type { LiveUsageAllocationContext, TrustedLiveUsageInterval } from './live-allocation.js';
import type { TrustedUsageControls, UsageCharge, UsageDispatchPermit, UsageIntent, UsagePeriod,
  UsageReconciliation, UsageReservationHandle, UsageReservationResult } from './types.js';
import { actorCopy, charges, identifier, integer, intentCopy } from './validation.js';

export type SyntheticLiveBinding = Readonly<{
  actor: AccountContext; reservationId: string; operation: string; intentHash: string; subjectId: string;
  period: UsagePeriod; permit: UsageDispatchPermit;
}>;
export type SyntheticLiveAdmission = Readonly<{
  binding: SyntheticLiveBinding; admittedAtMs: number; charges: readonly UsageCharge[];
}>;
export type SyntheticLiveSegment = Readonly<{
  binding: SyntheticLiveBinding; startMs: number; endMs: number;
}>;
export type PreparedSyntheticLiveSegment = Readonly<SyntheticLiveSegment & {
  evidenceId: string; observedAtMs: number;
}>;
export type SyntheticLiveObservation = Readonly<{
  expectedEvidenceId: string;
  interval: TrustedLiveUsageInterval;
  segments: readonly SyntheticLiveSegment[];
}>;
export type SyntheticLiveTerminal = Readonly<{
  binding: SyntheticLiveBinding; evidenceId: string; sourceId: string; clockId: string;
  meteringPolicyId: string; observedAtMs: number;
  outcome: 'settled' | 'not_consumed' | 'unknown';
  charges?: readonly UsageCharge[];
}>;
export type SyntheticLiveContext = Readonly<Omit<LiveUsageAllocationContext, 'expected'> & {
  qualification: 'synthetic_only'; sourceId: string; clockId: string; meteringPolicyId: string;
  maxReservations: number; maxIntervals: number; maxSegments: number;
}>;
export type SyntheticLiveResolution = Readonly<{
  reservationId: string; milliseconds: number | null; evidenceId: string | null;
  resolution: 'settled' | 'not_consumed' | 'unknown';
  reason: 'terminal_evidence' | 'missing_terminal' | 'uncertain_terminal' | 'missing_quantity';
  segments: readonly PreparedSyntheticLiveSegment[];
}>;
export type SyntheticLivePlan = Readonly<{
  qualification: 'synthetic_only'; periodPolicyId: string;
  sourceId: string; clockId: string; meteringPolicyId: string;
  freshness: LiveUsageAllocationContext['freshness'];
  totalMilliseconds: number;
  reservations: readonly SyntheticLiveResolution[];
}>;
export type SyntheticLiveApplication = Readonly<{
  qualification: 'synthetic_only'; atomic: false;
  reservations: readonly Readonly<{ reservationId: string;
    status: 'confirmed' | 'unresolved' | 'not_attempted' | 'unknown_effect';
    resolution: SyntheticLiveResolution['resolution'];
  }>[];
  unresolvedSegments: readonly PreparedSyntheticLiveSegment[];
}>;

type Action = Readonly<{ handle: UsageReservationHandle; evidence: UsageReconciliation | undefined }>;
const admissions = new WeakMap<SyntheticLiveAdmission, UsageReservationHandle>();
const plans = new WeakMap<SyntheticLivePlan, readonly Action[]>();
const attempted = new WeakSet<SyntheticLivePlan>();
function invalid(code: string): never { throw new DomainError(409, `usage_synthetic_live_${code}`); }
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function periodCopy(period: UsagePeriod): UsagePeriod {
  if (!record(period)) invalid('binding_invalid');
  identifier(period.id); integer(period.startMs); integer(period.endMs, 1);
  if (period.startMs >= period.endMs) invalid('binding_invalid');
  return Object.freeze({ id: period.id, startMs: period.startMs, endMs: period.endMs });
}
function bindingCopy(binding: SyntheticLiveBinding): SyntheticLiveBinding {
  if (!record(binding) || !record(binding.actor) || !record(binding.permit)) invalid('binding_invalid');
  const actor = actorCopy(binding.actor);
  for (const value of [binding.reservationId, binding.operation, binding.subjectId, binding.permit.stage]) identifier(value);
  if (typeof binding.intentHash !== 'string' || !/^[a-f0-9]{64}$/.test(binding.intentHash)) invalid('binding_invalid');
  integer(binding.permit.dispatchedAtMs);
  if (binding.permit.reservationId !== binding.reservationId) invalid('binding_mismatch');
  return Object.freeze({ actor, reservationId: binding.reservationId, operation: binding.operation,
    intentHash: binding.intentHash, subjectId: binding.subjectId, period: periodCopy(binding.period),
    permit: Object.freeze({ reservationId: binding.permit.reservationId, stage: binding.permit.stage,
      dispatchedAtMs: binding.permit.dispatchedAtMs }) });
}
function sameBinding(a: SyntheticLiveBinding, b: SyntheticLiveBinding): boolean {
  return a.reservationId === b.reservationId && a.operation === b.operation && a.intentHash === b.intentHash
    && a.subjectId === b.subjectId && a.actor.accountId === b.actor.accountId
    && a.actor.authUserId === b.actor.authUserId && a.actor.sessionId === b.actor.sessionId
    && a.actor.epoch === b.actor.epoch && a.period.id === b.period.id
    && a.period.startMs === b.period.startMs && a.period.endMs === b.period.endMs
    && a.permit.stage === b.permit.stage && a.permit.dispatchedAtMs === b.permit.dispatchedAtMs;
}

/** Capture the actual new receipt and committed permit before synthetic activity. Declarations prove no provider authority. */
export function captureSyntheticLiveAdmission(input: Readonly<{
  reservation: UsageReservationResult; intent: UsageIntent; permit: UsageDispatchPermit;
}>): SyntheticLiveAdmission {
  const { reservation, permit } = input;
  const intent = intentCopy(input.intent);
  if (reservation.kind !== 'new' || reservation.state !== 'reserved') invalid('original_admission_required');
  if (!reservation.snapshot.configured || !reservation.snapshot.period) invalid('original_admission_required');
  const handle = reservation.handle;
  const binding = bindingCopy({ ...handle, period: reservation.snapshot.period, permit });
  const admittedAtMs = reservation.snapshot.serverTimeMs;
  integer(admittedAtMs);
  if (intent.operation !== binding.operation || intent.intentHash !== binding.intentHash
    || intent.subjectId !== binding.subjectId || !intent.dispatchStages.includes(permit.stage)
    || !intent.charges.some(charge => charge.metric === 'live_voice_ms')
    || admittedAtMs < binding.period.startMs || admittedAtMs > permit.dispatchedAtMs
    || permit.dispatchedAtMs >= binding.period.endMs) invalid('admission_mismatch');
  const captured = Object.freeze({ binding, admittedAtMs, charges: intent.charges });
  admissions.set(captured, handle);
  return captured;
}

/** Pure complete-batch preparation. Original capabilities stay private; this seam never admits or dispatches work. */
export function prepareSyntheticLiveUsage(input: Readonly<{
  context: SyntheticLiveContext; admissions: readonly SyntheticLiveAdmission[];
  observations: readonly SyntheticLiveObservation[]; terminals: readonly SyntheticLiveTerminal[];
}>): SyntheticLivePlan {
  const context = input.context;
  if (!record(context) || context.qualification !== 'synthetic_only' || !record(context.freshness)
    || typeof context.periodResolver !== 'function') invalid('context_invalid');
  for (const value of [context.sourceId, context.clockId, context.meteringPolicyId, context.periodPolicyId]) identifier(value);
  for (const value of [context.maxPeriods, context.maxReservations, context.maxIntervals, context.maxSegments]) integer(value, 1);
  integer(context.freshness.asOfMs); integer(context.freshness.maxEvidenceAgeMs);
  if (!Array.isArray(input.admissions) || !input.admissions.length || input.admissions.length > context.maxReservations
    || !Array.isArray(input.observations) || input.observations.length > context.maxIntervals
    || !Array.isArray(input.terminals) || input.terminals.length > input.admissions.length) invalid('batch_bound');
  const byId = new Map<string, SyntheticLiveAdmission>();
  const segments = new Map<string, PreparedSyntheticLiveSegment[]>();
  const totals = new Map<string, number>();
  for (const admission of input.admissions) {
    if (!admissions.has(admission)) invalid('original_admission_required');
    const id = admission.binding.reservationId;
    if (byId.has(id)) invalid('duplicate_reservation');
    byId.set(id, admission); segments.set(id, []);
  }
  const expectedBinding = (value: SyntheticLiveBinding): SyntheticLiveAdmission => {
    const binding = bindingCopy(value), admission = byId.get(binding.reservationId);
    if (!admission || !sameBinding(admission.binding, binding)) invalid('binding_mismatch');
    return admission;
  };
  const evidenceIds = new Set<string>();
  const addEvidence = (id: string) => {
    identifier(id);
    if (evidenceIds.has(id)) invalid('duplicate_evidence');
    evidenceIds.add(id);
  };
  let total = 0n, segmentCount = 0;
  const ranges: { startMs: number; endMs: number }[] = [];
  for (const observation of input.observations) {
    addEvidence(observation.expectedEvidenceId);
    const allocation = allocateLiveUsageInterval(observation.interval, {
      expected: { sourceId: context.sourceId, evidenceId: observation.expectedEvidenceId,
        clockId: context.clockId, meteringPolicyId: context.meteringPolicyId },
      periodPolicyId: context.periodPolicyId, periodResolver: context.periodResolver,
      maxPeriods: context.maxPeriods, freshness: context.freshness,
    });
    const interval = allocation.interval;
    if (ranges.some(range => interval.startMs < range.endMs && range.startMs < interval.endMs
      || interval.startMs === range.startMs && interval.endMs === range.endMs)) invalid('overlapping_evidence');
    ranges.push(interval);
    if (!Array.isArray(observation.segments)
      || observation.segments.length !== Math.max(1, allocation.segments.length)) invalid('segment_coverage');
    segmentCount += observation.segments.length;
    if (segmentCount > context.maxSegments) invalid('batch_bound');
    for (const [index, supplied] of observation.segments.entries()) {
      const admission = expectedBinding(supplied.binding);
      const expected = allocation.segments[index];
      const startMs = expected?.startMs ?? interval.startMs, endMs = expected?.endMs ?? interval.endMs;
      const period = admission.binding.period;
      // Empty intervals bypass allocator lookup, but still need the original reservation's exact period.
      let resolvedPeriod = expected?.period;
      if (!resolvedPeriod) {
        try { resolvedPeriod = periodCopy(context.periodResolver(startMs)); }
        catch { invalid('segment_coverage'); }
      }
      if (supplied.startMs !== startMs || supplied.endMs !== endMs
        || startMs < admission.binding.permit.dispatchedAtMs || startMs < period.startMs
        || endMs > period.endMs || startMs >= period.endMs
        || period.id !== resolvedPeriod.id || period.startMs !== resolvedPeriod.startMs
        || period.endMs !== resolvedPeriod.endMs) invalid('segment_coverage');
      const id = admission.binding.reservationId;
      const next = (totals.get(id) ?? 0) + (endMs - startMs);
      integer(next);
      totals.set(id, next);
      segments.get(id)!.push(Object.freeze({ binding: admission.binding, startMs, endMs,
        evidenceId: interval.evidenceId, observedAtMs: interval.observedAtMs }));
    }
    total += BigInt(allocation.totalMilliseconds);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) invalid('quantity_overflow');
  }
  if ([...totals.values()].reduce((sum, value) => sum + BigInt(value), 0n) !== total) invalid('conservation');
  const terminals = new Map<string, SyntheticLiveTerminal>();
  for (const terminal of input.terminals) {
    const admission = expectedBinding(terminal.binding), id = admission.binding.reservationId;
    addEvidence(terminal.evidenceId); integer(terminal.observedAtMs);
    if (terminals.has(id)) invalid('duplicate_terminal');
    if (terminal.sourceId !== context.sourceId || terminal.clockId !== context.clockId
      || terminal.meteringPolicyId !== context.meteringPolicyId) invalid('terminal_binding_mismatch');
    if (!['settled', 'not_consumed', 'unknown'].includes(terminal.outcome)
      || terminal.observedAtMs < admission.binding.permit.dispatchedAtMs
      || terminal.observedAtMs > context.freshness.asOfMs
      || context.freshness.asOfMs - terminal.observedAtMs > context.freshness.maxEvidenceAgeMs
      || segments.get(id)!.some(segment => segment.endMs > terminal.observedAtMs)) invalid('terminal_invalid');
    terminals.set(id, terminal);
  }
  const actions: Action[] = [];
  const reservations = input.admissions.map((admission): SyntheticLiveResolution => {
    const id = admission.binding.reservationId, terminal = terminals.get(id), milliseconds = totals.get(id);
    let evidence: UsageReconciliation | undefined;
    let reason: SyntheticLiveResolution['reason'] = 'missing_terminal';
    if (terminal) {
      reason = terminal.outcome === 'unknown' ? 'uncertain_terminal' : 'missing_quantity';
      if (terminal.outcome === 'not_consumed') {
        if (milliseconds !== undefined && milliseconds !== 0 || terminal.charges !== undefined) invalid('terminal_conflict');
        evidence = Object.freeze({ outcome: 'not_consumed', evidenceId: terminal.evidenceId });
      } else if (terminal.outcome === 'settled' && terminal.charges !== undefined && milliseconds !== undefined) {
        const actual = charges(terminal.charges, true);
        if (actual.length !== admission.charges.length
          || actual.some(charge => !admission.charges.some((held: UsageCharge) => held.metric === charge.metric))
          || actual.find(charge => charge.metric === 'live_voice_ms')?.amount !== milliseconds) invalid('terminal_conflict');
        evidence = Object.freeze({ outcome: 'settled', evidenceId: terminal.evidenceId,
          settlement: Object.freeze({ charges: Object.freeze(actual.map(charge => Object.freeze(charge))) }) });
      }
    }
    if (evidence) reason = 'terminal_evidence';
    actions.push(Object.freeze({ handle: admissions.get(admission)!, evidence }));
    return Object.freeze({ reservationId: id, milliseconds: milliseconds ?? null, evidenceId: terminal?.evidenceId ?? null,
      resolution: evidence?.outcome ?? 'unknown', reason, segments: Object.freeze(segments.get(id)!) });
  });
  const plan: SyntheticLivePlan = Object.freeze({ qualification: 'synthetic_only', periodPolicyId: context.periodPolicyId,
    sourceId: context.sourceId, clockId: context.clockId, meteringPolicyId: context.meteringPolicyId,
    freshness: Object.freeze({ asOfMs: context.freshness.asOfMs, maxEvidenceAgeMs: context.freshness.maxEvidenceAgeMs }),
    totalMilliseconds: Number(total), reservations: Object.freeze(reservations) });
  plans.set(plan, Object.freeze(actions));
  return plan;
}

/** Sequential, single-attempt writes: any thrown write has unknown effect, including markUnknown; never compensate or retry. */
export function applySyntheticLiveUsage(plan: SyntheticLivePlan,
  controls: Pick<TrustedUsageControls, 'reconcile' | 'markUnknown'>): SyntheticLiveApplication {
  const actions = plans.get(plan);
  if (!actions || attempted.has(plan)) invalid('plan_unavailable');
  attempted.add(plan);
  let stopped = false;
  const unresolvedSegments: PreparedSyntheticLiveSegment[] = [];
  const reservations = actions.map((action, index): SyntheticLiveApplication['reservations'][number] => {
    const resolution = plan.reservations[index]!;
    let status: SyntheticLiveApplication['reservations'][number]['status'] = 'not_attempted';
    if (!stopped) {
      try {
        if (action.evidence) controls.reconcile(action.handle, action.evidence);
        else controls.markUnknown(action.handle);
        status = action.evidence ? 'confirmed' : 'unresolved';
      } catch { status = 'unknown_effect'; stopped = true; }
    }
    if (status !== 'confirmed') unresolvedSegments.push(...resolution.segments);
    return Object.freeze({ reservationId: resolution.reservationId, status, resolution: resolution.resolution });
  });
  return Object.freeze({ qualification: 'synthetic_only', atomic: false, reservations: Object.freeze(reservations),
    unresolvedSegments: Object.freeze(unresolvedSegments) });
}
