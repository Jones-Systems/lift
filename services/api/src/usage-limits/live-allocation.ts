import { DomainError } from '../errors.js';
import type { UsagePeriod } from './types.js';

export type LiveUsageProvenance = Readonly<{
  sourceId: string;
  evidenceId: string;
  clockId: string;
  meteringPolicyId: string;
}>;
export type TrustedLiveUsageInterval = Readonly<LiveUsageProvenance & {
  startMs: number;
  endMs: number;
  observedAtMs: number;
}>;
export type LiveUsageAllocationContext = Readonly<{
  expected: LiveUsageProvenance;
  periodPolicyId: string;
  periodResolver: (atMs: number) => UsagePeriod;
  maxPeriods: number;
  freshness: Readonly<{ asOfMs: number; maxEvidenceAgeMs: number }>;
}>;
export type LiveUsageAllocationSegment = Readonly<{
  period: UsagePeriod;
  startMs: number;
  endMs: number;
  milliseconds: number;
}>;
export type LiveUsageAllocation = Readonly<{
  qualification: 'allocation_only';
  interval: TrustedLiveUsageInterval;
  periodPolicyId: string;
  freshness: LiveUsageAllocationContext['freshness'];
  totalMilliseconds: number;
  segments: readonly LiveUsageAllocationSegment[];
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const milliseconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 160 && !/[^A-Za-z0-9_.:/@+-]/.test(value);

function provenance(value: unknown, code: string, status: 400 | 503): LiveUsageProvenance {
  if (!record(value) || !identifier(value.sourceId) || !identifier(value.evidenceId)
    || !identifier(value.clockId) || !identifier(value.meteringPolicyId)) throw new DomainError(status, code);
  return Object.freeze({ sourceId: value.sourceId, evidenceId: value.evidenceId,
    clockId: value.clockId, meteringPolicyId: value.meteringPolicyId });
}

/** The caller qualifies the source, counted-time policy and shared clock; matching declarations proves none of them. */
export function allocateLiveUsageInterval(
  input: TrustedLiveUsageInterval,
  context: LiveUsageAllocationContext,
): LiveUsageAllocation {
  if (!record(input) || !milliseconds(input.startMs) || !milliseconds(input.endMs)
    || !milliseconds(input.observedAtMs) || input.startMs > input.endMs)
    throw new DomainError(400, 'usage_live_interval_invalid');
  const interval = Object.freeze({ ...provenance(input, 'usage_live_interval_invalid', 400),
    startMs: input.startMs, endMs: input.endMs, observedAtMs: input.observedAtMs });
  if (!record(context) || !identifier(context.periodPolicyId) || typeof context.periodResolver !== 'function'
    || !milliseconds(context.maxPeriods) || context.maxPeriods < 1 || !record(context.freshness)
    || !milliseconds(context.freshness.asOfMs) || !milliseconds(context.freshness.maxEvidenceAgeMs))
    throw new DomainError(503, 'usage_live_allocation_context_invalid');
  const expected = provenance(context.expected, 'usage_live_allocation_context_invalid', 503);
  const { periodPolicyId, periodResolver, maxPeriods } = context;
  const freshness = Object.freeze({ asOfMs: context.freshness.asOfMs, maxEvidenceAgeMs: context.freshness.maxEvidenceAgeMs });
  if (interval.sourceId !== expected.sourceId || interval.evidenceId !== expected.evidenceId
    || interval.clockId !== expected.clockId || interval.meteringPolicyId !== expected.meteringPolicyId)
    throw new DomainError(409, 'usage_live_allocation_binding_mismatch');
  if (interval.endMs > interval.observedAtMs || interval.observedAtMs > freshness.asOfMs)
    throw new DomainError(400, 'usage_live_evidence_time_invalid');
  if (freshness.asOfMs - interval.observedAtMs > freshness.maxEvidenceAgeMs)
    throw new DomainError(409, 'usage_live_evidence_stale');

  const segments: LiveUsageAllocationSegment[] = [];
  const seenPeriods = new Set<string>();
  let cursor = interval.startMs;
  let previous: UsagePeriod | undefined;
  let allocated = 0n;
  while (cursor < interval.endMs) {
    if (segments.length >= maxPeriods) throw new DomainError(503, 'usage_live_period_limit');
    let period: UsagePeriod;
    try {
      const resolved = periodResolver(cursor);
      if (!record(resolved) || !identifier(resolved.id) || !milliseconds(resolved.startMs)
        || !milliseconds(resolved.endMs) || resolved.startMs > cursor || resolved.endMs <= cursor)
        throw new DomainError(503, 'usage_live_period_invalid');
      period = Object.freeze({ id: resolved.id, startMs: resolved.startMs, endMs: resolved.endMs });
    } catch {
      throw new DomainError(503, 'usage_live_period_invalid');
    }
    if (previous && period.startMs !== previous.endMs)
      throw new DomainError(503, 'usage_live_period_invalid');
    if (seenPeriods.has(period.id)) throw new DomainError(503, 'usage_live_period_conflict');
    seenPeriods.add(period.id);
    const endMs = Math.min(interval.endMs, period.endMs);
    const amount = endMs - cursor;
    segments.push(Object.freeze({ period, startMs: cursor, endMs, milliseconds: amount }));
    allocated += BigInt(amount);
    cursor = endMs;
    previous = period;
  }
  const total = BigInt(interval.endMs) - BigInt(interval.startMs);
  if (allocated !== total) throw new DomainError(503, 'usage_live_period_invalid');
  return Object.freeze({ qualification: 'allocation_only', interval, periodPolicyId, freshness,
    totalMilliseconds: Number(total), segments: Object.freeze(segments) });
}
