import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../../src/errors.js';
import {
  allocateLiveUsageInterval, type LiveUsageAllocationContext, type TrustedLiveUsageInterval, type UsagePeriod,
} from '../../src/usage-limits/index.js';

const binding = { sourceId: 'fixture-meter', evidenceId: 'interval-1', clockId: 'fixture-clock', meteringPolicyId: 'fixture-counted-time' };
const interval = (override: Partial<TrustedLiveUsageInterval> = {}): TrustedLiveUsageInterval => ({
  ...binding, startMs: 20, endMs: 80, observedAtMs: 90, ...override,
});
const context = (override: Partial<LiveUsageAllocationContext> = {}): LiveUsageAllocationContext => ({
  expected: { ...binding }, periodPolicyId: 'fixture-explicit-periods',
  periodResolver: () => ({ id: 'period-1', startMs: 0, endMs: 100 }), maxPeriods: 3,
  freshness: { asOfMs: 100, maxEvidenceAgeMs: 10 }, ...override,
});
const evaluate = (value: unknown, policy: unknown) =>
  allocateLiveUsageInterval(value as TrustedLiveUsageInterval, policy as LiveUsageAllocationContext);
const expectError = (value: unknown, policy: unknown, code: string): void => {
  assert.throws(() => evaluate(value, policy), (error: unknown) => error instanceof DomainError && error.code === code);
};
const periods = [
  { id: 'custom-a', startMs: 17, endMs: 37 },
  { id: 'custom-b', startMs: 37, endMs: 62 },
  { id: 'custom-c', startMs: 62, endMs: 103 },
];
const resolve = (atMs: number): UsagePeriod => {
  const found = periods.find(period => period.startMs <= atMs && atMs < period.endMs);
  assert.ok(found); return found;
};

test('one period allocates only the explicit half-open interval and retains its provenance', () => {
  const result = allocateLiveUsageInterval(interval(), context());
  assert.equal(result.qualification, 'allocation_only');
  assert.equal(result.totalMilliseconds, 60);
  assert.deepEqual(result.interval, interval());
  assert.equal(result.periodPolicyId, 'fixture-explicit-periods');
  assert.deepEqual(result.freshness, { asOfMs: 100, maxEvidenceAgeMs: 10 });
  assert.deepEqual(result.segments, [{ period: { id: 'period-1', startMs: 0, endMs: 100 }, startMs: 20, endMs: 80, milliseconds: 60 }]);
});

test('unequal supplied periods partition exactly without calendar or UTC assumptions', () => {
  const calls: number[] = [];
  const result = allocateLiveUsageInterval(interval(), context({ periodResolver: atMs => { calls.push(atMs); return resolve(atMs); } }));
  assert.deepEqual(calls, [20, 37, 62]);
  assert.deepEqual(result.segments.map(segment => [segment.period.id, segment.startMs, segment.endMs, segment.milliseconds]),
    [['custom-a', 20, 37, 17], ['custom-b', 37, 62, 25], ['custom-c', 62, 80, 18]]);
  assert.equal(result.segments.reduce((sum, segment) => sum + segment.milliseconds, 0), result.totalMilliseconds);
});

test('an exact end boundary produces no zero segment or resolver call into the next period', () => {
  const calls: number[] = [];
  const result = allocateLiveUsageInterval(interval({ endMs: 62 }), context({ periodResolver: atMs => { calls.push(atMs); return resolve(atMs); } }));
  assert.deepEqual(calls, [20, 37]); assert.equal(result.totalMilliseconds, 42);
  assert.deepEqual(result.segments.map(segment => segment.milliseconds), [17, 25]);
});

test('explicit zero is empty without resolving a period, while missing input or configuration fails closed', () => {
  let calls = 0;
  const policy = context({ periodResolver: () => { calls++; throw new Error('must not resolve empty interval'); } });
  const empty = interval({ startMs: 62, endMs: 62 });
  const result = allocateLiveUsageInterval(empty, policy);
  assert.equal(result.totalMilliseconds, 0); assert.deepEqual(result.segments, []); assert.equal(calls, 0);
  for (const absent of [undefined, null, [], {}]) expectError(absent, policy, 'usage_live_interval_invalid');
  for (const absent of [undefined, null, [], {}, { ...policy, freshness: undefined }, { ...policy, periodResolver: undefined },
    { ...policy, expected: undefined }, { ...policy, maxPeriods: undefined }])
    expectError(empty, absent, 'usage_live_allocation_context_invalid');
  assert.equal(calls, 0);
});

test('millisecond fragments conserve a whole interval and never accumulate per-lease rounding', () => {
  const policy = context({ periodResolver: atMs => atMs < 1000 ? { id: 'a', startMs: 0, endMs: 1000 } : { id: 'b', startMs: 1000, endMs: 2000 },
    freshness: { asOfMs: 2000, maxEvidenceAgeMs: 0 } });
  const whole = allocateLiveUsageInterval(interval({ startMs: 999, endMs: 1999, observedAtMs: 2000 }), policy);
  const first = allocateLiveUsageInterval(interval({ startMs: 999, endMs: 1000, observedAtMs: 2000 }), policy);
  const second = allocateLiveUsageInterval(interval({ startMs: 1000, endMs: 1999, observedAtMs: 2000 }), policy);
  assert.deepEqual(whole.segments.map(segment => segment.milliseconds), [1, 999]);
  assert.equal(first.totalMilliseconds + second.totalMilliseconds, whole.totalMilliseconds);
  assert.equal(whole.totalMilliseconds, 1000);
});

test('safe integer endpoints retain precision and negative, fractional, overflowing or inverted inputs are rejected', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const policy = context({ periodResolver: () => ({ id: 'safe-edge', startMs: maximum - 100, endMs: maximum }),
    freshness: { asOfMs: maximum, maxEvidenceAgeMs: 0 } });
  const result = allocateLiveUsageInterval(interval({ startMs: maximum - 3, endMs: maximum, observedAtMs: maximum }), policy);
  assert.equal(result.totalMilliseconds, 3); assert.equal(result.segments[0]?.milliseconds, 3);
  for (const field of ['startMs', 'endMs', 'observedAtMs'] as const)
    for (const invalid of [-1, 0.5, NaN, Infinity, maximum + 1, '20'])
      expectError({ ...interval(), [field]: invalid }, context(), 'usage_live_interval_invalid');
  expectError(interval({ startMs: 81 }), context(), 'usage_live_interval_invalid');
  for (const field of ['asOfMs', 'maxEvidenceAgeMs'] as const)
    for (const invalid of [-1, 0.5, Infinity, maximum + 1])
      expectError(interval(), context({ freshness: { ...context().freshness, [field]: invalid } }), 'usage_live_allocation_context_invalid');
});

test('exact provenance and caller-selected freshness are required even for an empty interval', () => {
  for (const field of ['sourceId', 'evidenceId', 'clockId', 'meteringPolicyId'] as const) {
    expectError(interval({ [field]: 'different' }), context(), 'usage_live_allocation_binding_mismatch');
    expectError(interval(), context({ expected: { ...binding, [field]: 'different' } }), 'usage_live_allocation_binding_mismatch');
    for (const malformed of [undefined, '', 'id\n', 'id\r\n', 'i'.repeat(161)]) {
      expectError({ ...interval(), [field]: malformed }, context(), 'usage_live_interval_invalid');
      expectError(interval(), { ...context(), expected: { ...binding, [field]: malformed } }, 'usage_live_allocation_context_invalid');
    }
  }
  const longId = `id:${'x'.repeat(157)}`;
  assert.equal(allocateLiveUsageInterval(interval({ evidenceId: longId }), context({ expected: { ...binding, evidenceId: longId } })).interval.evidenceId, longId);
  expectError(interval(), context({ periodPolicyId: 'policy\n' }), 'usage_live_allocation_context_invalid');
  assert.equal(allocateLiveUsageInterval(interval(), context()).totalMilliseconds, 60);
  expectError(interval(), context({ freshness: { asOfMs: 101, maxEvidenceAgeMs: 10 } }), 'usage_live_evidence_stale');
  expectError(interval({ observedAtMs: 79 }), context(), 'usage_live_evidence_time_invalid');
  expectError(interval({ observedAtMs: 101 }), context(), 'usage_live_evidence_time_invalid');
  expectError(interval({ startMs: 80, endMs: 80 }), context({ freshness: { asOfMs: 101, maxEvidenceAgeMs: 10 } }), 'usage_live_evidence_stale');
});

test('resolver gaps, overlaps, nonprogress, invalid bounds, identity conflicts and failures return no allocation', () => {
  const invalidPeriods: unknown[] = [null, {}, { id: 'x', startMs: 21, endMs: 100 }, { id: 'x', startMs: 0, endMs: 20 },
    { id: 'x', startMs: -1, endMs: 100 }, { id: 'x', startMs: 0, endMs: Number.MAX_SAFE_INTEGER + 1 },
    { id: 'x', startMs: 0, endMs: 20.5 }, { id: 'x\n', startMs: 0, endMs: 100 },
    { id: 'x'.repeat(161), startMs: 0, endMs: 100 }];
  for (const value of invalidPeriods)
    expectError(interval(), context({ periodResolver: () => value as UsagePeriod }), 'usage_live_period_invalid');
  for (const startMs of [36, 38])
    expectError(interval(), context({ periodResolver: atMs => atMs < 37 ? periods[0]! : { id: 'next', startMs, endMs: 100 } }), 'usage_live_period_invalid');
  expectError(interval(), context({ periodResolver: atMs => atMs < 37 ? periods[0]! : { id: 'custom-a', startMs: 37, endMs: 100 } }), 'usage_live_period_conflict');
  assert.throws(() => allocateLiveUsageInterval(interval(), context({ periodResolver: () => { throw new Error('private-provider-payload'); } })),
    (error: unknown) => error instanceof DomainError && error.code === 'usage_live_period_invalid' && !error.message.includes('private-provider-payload'));
});

test('the required period work bound succeeds exactly or fails without invoking another resolver or returning a prefix', () => {
  assert.equal(allocateLiveUsageInterval(interval(), context({ periodResolver: resolve, maxPeriods: 3 })).segments.length, 3);
  let calls = 0;
  expectError(interval(), context({ maxPeriods: 2, periodResolver: atMs => { calls++; return resolve(atMs); } }), 'usage_live_period_limit');
  assert.equal(calls, 2);
  for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expectError(interval(), context({ maxPeriods: invalid }), 'usage_live_allocation_context_invalid');
});

test('over-cap observations remain lossless and output is detached immutable metadata with no resolution authority', () => {
  const reported = { ...interval({ startMs: 0, endMs: 9_000_001, observedAtMs: 9_000_001 }), transcript: 'excluded-content' };
  const period = { id: 'large-period', startMs: 0, endMs: 10_000_000 };
  const policy = context({ periodResolver: () => period, freshness: { asOfMs: 9_000_001, maxEvidenceAgeMs: 0 } });
  const result = allocateLiveUsageInterval(reported, policy);
  assert.equal(result.totalMilliseconds, 9_000_001);
  assert.equal(result.qualification, 'allocation_only');
  for (const key of ['cost', 'charges', 'handle', 'settlement', 'providerTerminated']) assert.equal(Object.hasOwn(result, key), false);
  assert.equal(JSON.stringify(result).includes('excluded-content'), false);
  const frozen = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(frozen);
  };
  frozen(result);
  assert.equal(Object.isFrozen(reported), false); assert.equal(Object.isFrozen(policy), false); assert.equal(Object.isFrozen(period), false);
  assert.notEqual(result.interval, reported); assert.notEqual(result.freshness, policy.freshness); assert.notEqual(result.segments[0]?.period, period);
  reported.endMs = 1; period.endMs = 2;
  (policy.freshness as { asOfMs: number }).asOfMs = 3;
  assert.equal(result.interval.endMs, 9_000_001); assert.equal(result.segments[0]?.period.endMs, 10_000_000);
  assert.equal(result.freshness.asOfMs, 9_000_001);
});
