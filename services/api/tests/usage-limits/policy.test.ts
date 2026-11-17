import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../../src/errors.js';
import type { AccountContext } from '../../src/lifecycle/types.js';
import {
  allocateLiveUsageInterval, calendarMonthPeriodResolver, createUsageLedger, createUsageLimitsConfiguration, createUsagePolicy,
  createUsageRightsResolver, usageOperationKinds, usageOwnedTables, usagePeriodPolicyId,
} from '../../src/usage-limits/index.js';
import type {
  UsageIntent, UsageLedger, UsageMetric, UsageOperationKind, UsagePeriod, UsagePeriodRule, UsagePolicyConfig,
} from '../../src/usage-limits/index.js';
import type { Sqlite } from '../../src/storage.js';
import { policyCopy } from '../../src/usage-limits/validation.js';
import { actor, otherActor } from './fixture.js';
import {
  configuredLedger, exampleGrantState, exampleGrants, exampleUsagePolicyConfig, generationIntent, ledgerOn, liveIntent,
  liveStage, standardIntent,
} from './policy-fixture.js';

const DAY = 86_400_000;
const newYork: UsagePeriodRule = { kind: 'calendar_month_zone', timeZone: 'America/New_York' };
const utc: UsagePeriodRule = { kind: 'calendar_month_utc' };
const zone = (timeZone: string): UsagePeriodRule => ({ kind: 'calendar_month_zone', timeZone });

function assertRefusal(action: () => unknown, code: string, status: number, label: string = code): void {
  try { action(); } catch (error) {
    assert.ok(error instanceof DomainError, `${label}: expected DomainError, got ${String(error)}`);
    assert.deepEqual([error.status, error.code], [status, code], label);
    return;
  }
  assert.fail(`${label}: expected ${status} ${code}`);
}
type Loose = { [key: string]: unknown; period: Record<string, unknown>; limits: Record<string, unknown>; operations: Record<string, unknown> };
function mutated(change: (config: Loose) => void): UsagePolicyConfig {
  const config = structuredClone(exampleUsagePolicyConfig()) as unknown as Loose;
  change(config);
  return config as unknown as UsagePolicyConfig;
}
const metricSet = (metrics: readonly UsageMetric[] | undefined) => [...(metrics ?? [])].sort();
function counters(db: Sqlite, metric: UsageMetric) {
  return db.prepare('SELECT period_id,settled,reserved,unknown FROM usage_counters WHERE metric=? ORDER BY period_id').all(metric);
}
function dispatchAndSettle(ledger: UsageLedger, who: AccountContext, intent: UsageIntent, stage: string, used: number, metric: UsageMetric) {
  const reservation = ledger.usage.reserve(who, intent);
  assert.equal(reservation.kind, 'new');
  ledger.usage.markDispatching(reservation.handle, stage);
  return ledger.trusted.settle(reservation.handle, { charges: [{ metric, amount: used }] });
}
const settleLive = (ledger: UsageLedger, key: string, hold: number, used: number) =>
  dispatchAndSettle(ledger, actor, liveIntent(key, hold), liveStage, used, 'live_voice_ms');
const settleStandard = (ledger: UsageLedger, key: string, who: AccountContext = actor) =>
  dispatchAndSettle(ledger, who, standardIntent(key), 'transcribe', 1, 'coach_messages');

// Builder -----------------------------------------------------------------------------------------------------------------

test('a valid explicit configuration builds a frozen policy the real ledger accepts as configured', t => {
  const policy = createUsagePolicy(exampleUsagePolicyConfig());
  assert.deepEqual(policy.limits, { live_voice_ms: 9_000_000, coach_messages: 1000, workout_generations: 100 });
  assert.equal(policy.id, 'synthetic-example-policy-v1');
  assert.equal(policy.periodPolicyId, 'calendar-month-v1:UTC');
  assert.equal(policy.periodAllocation, 'reservation_period');
  assert.equal(policy.liveRounding, 'exact_milliseconds');
  assert.equal(policy.liveMessageCounting, 'excluded');
  assert.equal(typeof policy.periodResolver, 'function');
  assert.ok(Object.isFrozen(policy)); assert.ok(Object.isFrozen(policy.limits)); assert.ok(Object.isFrozen(policy.operations));
  for (const rule of Object.values(policy.operations)) { assert.ok(Object.isFrozen(rule)); assert.ok(Object.isFrozen(rule.metrics)); }
  assert.deepEqual(policyCopy(policy), policy);
  assert.deepEqual(Object.keys(policy.operations).sort(), [...usageOperationKinds].sort());
  const { ledger } = configuredLedger(t);
  const snapshot = ledger.usage.status(actor);
  assert.equal(snapshot.configured, true); assert.equal(snapshot.policyId, 'synthetic-example-policy-v1');
  assert.deepEqual(snapshot.metrics?.live_voice_ms, { limit: 9_000_000, settled: 0, reserved: 0, unknown: 0, remaining: 9_000_000 });
  assert.equal(snapshot.metrics?.coach_messages.limit, 1000); assert.equal(snapshot.metrics?.workout_generations.limit, 100);
});

test('invalid, partial, defaulted or unknown configuration is refused with an exact 503 code', () => {
  const config = exampleUsagePolicyConfig();
  const config503 = 'usage_policy_config_invalid';
  const refuseConfig = (value: unknown, label: string) =>
    assertRefusal(() => createUsagePolicy(value as UsagePolicyConfig), config503, 503, label);
  refuseConfig(undefined, 'undefined'); refuseConfig(null, 'null'); refuseConfig('policy', 'string'); refuseConfig([], 'array');
  for (const key of Object.keys(config)) refuseConfig(mutated(c => { delete c[key]; }), `missing ${key}`);
  refuseConfig(mutated(c => { c.defaults = true; }), 'unknown key defaults');
  refuseConfig(mutated(c => { c.policyId = 'has space'; }), 'policy id with a space');
  refuseConfig(mutated(c => { c.policyId = ''; }), 'empty policy id');
  refuseConfig(mutated(c => { c.policyId = 'p'.repeat(161); }), 'overlong policy id');
  refuseConfig(mutated(c => { c.policyId = 7; }), 'numeric policy id');
  refuseConfig(mutated(c => { delete c.limits.workout_generations; }), 'limits missing a metric');
  refuseConfig(mutated(c => { c.limits.live_voice_minutes = 150; }), 'limits extra key');
  refuseConfig(mutated(c => { c.limits = [] as unknown as Record<string, unknown>; }), 'limits array');
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1000', 2 ** 53, null, undefined])
    refuseConfig(mutated(c => { c.limits.coach_messages = bad; }), `coach_messages ${String(bad)}`);
  refuseConfig(mutated(c => { c.limits.live_voice_ms = '9000000'; }), 'live cap as a string');
  refuseConfig(mutated(c => { c.limits.live_voice_ms = 9_000_000.5; }), 'live cap fractional');
  for (const bad of [8_999_999, 9_000_001, 0])
    assertRefusal(() => createUsagePolicy(mutated(c => { c.limits.live_voice_ms = bad; })), 'usage_live_cap_invalid', 503, `live cap ${bad}`);
  assertRefusal(() => createUsagePolicy(mutated(c => { c.operations = {}; })), 'usage_operations_required', 503, 'no operations');
  refuseConfig(mutated(c => { c.operations = null as unknown as Record<string, unknown>; }), 'null operations');
  refuseConfig(mutated(c => { c.operations = { workout_log: { capability: 'cap.log' } }; }), 'operation workout_log');
  refuseConfig(mutated(c => { c.operations = { standard_voice_turn: { capability: 'has space' } }; }), 'capability with a space');
  refuseConfig(mutated(c => { c.operations = { standard_voice_turn: { capability: 'cap.ok', metrics: ['live_voice_ms'] } }; }), 'configured metrics');
  refuseConfig(mutated(c => { c.operations = { standard_voice_turn: 'cap.ok' }; }), 'operation value not an object');
  refuseConfig(mutated(c => { c.operations = { standard_voice_turn: { capability: 'cap.ok' }, live: { capability: 'cap.live' } }; }), 'extra operation beside a valid one');
  refuseConfig(mutated(c => { c.liveMessageCounting = 'sometimes'; }), 'counting sometimes');
  assertRefusal(() => createUsagePolicy(mutated(c => { c.period = { kind: 'weekly' }; })), 'usage_policy_period_invalid', 503, 'weekly');
  for (const timeZone of ['', 'UTC', 'utc', '+05:00', 'Mars/Phobos', 'America/', 'a/b/c/d', 'Europe/London ', 'America/New_York'.repeat(5)])
    assertRefusal(() => createUsagePolicy(mutated(c => { c.period = { kind: 'calendar_month_zone', timeZone }; })),
      'usage_policy_period_invalid', 503, `zone ${JSON.stringify(timeZone)}`);
  for (const bad of [null, 'calendar_month_utc', { kind: 'calendar_month_utc', timeZone: 'UTC' }, { kind: 'calendar_month_zone' },
    { kind: 'calendar_month_zone', timeZone: 5 }, { kind: 'calendar_month_zone', timeZone: 'Europe/London', extra: 1 }])
    assertRefusal(() => createUsagePolicy(mutated(c => { c.period = bad as Record<string, unknown>; })),
      'usage_policy_period_invalid', 503, `period ${JSON.stringify(bad)}`);
});

test('live-voice metrics follow the explicit message-counting mode as a set', () => {
  const included = createUsagePolicy(exampleUsagePolicyConfig({ liveMessageCounting: 'included' }));
  const excluded = createUsagePolicy(exampleUsagePolicyConfig({ liveMessageCounting: 'excluded' }));
  assert.deepEqual(metricSet(included.operations.live_voice_session?.metrics), ['coach_messages', 'live_voice_ms']);
  assert.deepEqual(metricSet(excluded.operations.live_voice_session?.metrics), ['live_voice_ms']);
});

test('standard turns and coach messages can only ever be charged coach messages, never time', () => {
  for (const liveMessageCounting of ['included', 'excluded'] as const) {
    const policy = createUsagePolicy(exampleUsagePolicyConfig({ liveMessageCounting }));
    assert.deepEqual(policy.operations.standard_voice_turn?.metrics, ['coach_messages'], liveMessageCounting);
    assert.deepEqual(policy.operations.coach_message?.metrics, ['coach_messages'], liveMessageCounting);
    assert.deepEqual(policy.operations.workout_generation?.metrics, ['workout_generations'], liveMessageCounting);
  }
});

test('explicit zero message and generation limits are accepted and enforced', t => {
  const config = exampleUsagePolicyConfig({ limits: { live_voice_ms: 9_000_000, coach_messages: 0, workout_generations: 0 } });
  const { ledger, policy } = configuredLedger(t, config);
  assert.deepEqual([policy.limits.coach_messages, policy.limits.workout_generations], [0, 0]);
  assertRefusal(() => ledger.usage.reserve(actor, standardIntent('zero-standard')), 'usage_limit_exceeded', 429);
  assertRefusal(() => ledger.usage.reserve(actor, generationIntent('zero-generation')), 'usage_limit_exceeded', 429);
  assert.equal(ledger.usage.reserve(actor, liveIntent('zero-live', 1)).kind, 'new');
});

// Unconfigured and grants -------------------------------------------------------------------------------------------------

test('no configuration leaves the ledger unconfigured, never half-configured', t => {
  assert.equal(createUsageLimitsConfiguration(), undefined);
  assert.equal(createUsageLimitsConfiguration(undefined), undefined);
  const grants = exampleGrants(exampleGrantState()), policy = exampleUsagePolicyConfig();
  assertRefusal(() => createUsageLimitsConfiguration({ policy } as never), 'usage_policy_config_invalid', 503, 'policy alone');
  assertRefusal(() => createUsageLimitsConfiguration({ grants } as never), 'usage_policy_config_invalid', 503, 'grants alone');
  assertRefusal(() => createUsageLimitsConfiguration({} as never), 'usage_policy_config_invalid', 503, 'empty object');
  assertRefusal(() => createUsageLimitsConfiguration(null as never), 'usage_policy_config_invalid', 503, 'null');
  assertRefusal(() => createUsageLimitsConfiguration({ policy, grants, extra: true } as never), 'usage_policy_config_invalid', 503, 'extra key');
  const { f } = configuredLedger(t);
  const configuration = createUsageLimitsConfiguration();
  const ledger = createUsageLedger({ db: f.db, lifecycle: f.lifecycle, now: () => f.state.now, ...(configuration ?? {}) });
  const snapshot = ledger.usage.status(actor);
  assert.equal(snapshot.configured, false); assert.equal(snapshot.policyId, null);
  assert.equal(snapshot.metrics, null); assert.equal(snapshot.period, null);
  assertRefusal(() => ledger.usage.reserve(actor, standardIntent('unconfigured')), 'usage_unconfigured', 503);
  for (const table of usageOwnedTables) assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), [], table);
});

test('the rights resolver returns the existing UsageRights shape from frozen copies and fails closed', () => {
  const policy = createUsagePolicy(exampleUsagePolicyConfig());
  const state = exampleGrantState(['cap.standard', 'cap.standard', 'cap.live']);
  const calls: AccountContext[] = [];
  const resolve = createUsageRightsResolver(policy, { ...exampleGrants(state, ['standard_voice_turn', 'live_voice_session']),
    resolveCapabilities: received => { calls.push(received); return state.capabilities; } });
  const rights = resolve(actor);
  assert.deepEqual(rights, { policyId: 'synthetic-example-grants-v1', capabilities: ['cap.standard', 'cap.live'],
    configuredOperations: ['standard_voice_turn', 'live_voice_session'] });
  assert.ok(Object.isFrozen(rights)); assert.ok(Object.isFrozen(rights.capabilities)); assert.ok(Object.isFrozen(rights.configuredOperations));
  assert.equal(calls[0], actor);
  state.capabilities.push('cap.message'); state.capabilities.splice(0, 2);
  assert.deepEqual(resolve(otherActor).capabilities, ['cap.live', 'cap.message']);
  assert.deepEqual(rights.capabilities, ['cap.standard', 'cap.live']);

  const limited = createUsagePolicy(exampleUsagePolicyConfig({ operations: { standard_voice_turn: { capability: 'cap.standard' } } }));
  const good = exampleGrants(exampleGrantState());
  const rights503 = 'usage_rights_config_invalid';
  assertRefusal(() => createUsageRightsResolver(limited, { ...good, configuredOperations: ['live_voice_session'] }), rights503, 503, 'operation absent from the policy');
  assertRefusal(() => createUsageRightsResolver(policy, { ...good, configuredOperations: ['coach_message', 'coach_message'] }), rights503, 503, 'duplicate operation');
  assertRefusal(() => createUsageRightsResolver(policy, { ...good, configuredOperations: ['workout_log' as UsageOperationKind] }), rights503, 503, 'unknown operation');
  assertRefusal(() => createUsageRightsResolver(policy, { ...good, configuredOperations: 'coach_message' as never }), rights503, 503, 'operations not an array');
  assertRefusal(() => createUsageRightsResolver(policy, { ...good, grantPolicyId: 'has space' }), rights503, 503, 'bad grant policy id');
  assertRefusal(() => createUsageRightsResolver(policy, { ...good, resolveCapabilities: 'cap' as never }), rights503, 503, 'resolver not a function');
  assertRefusal(() => createUsageRightsResolver(policy, undefined as never), rights503, 503, 'missing grants');
  const unconfigured = (capabilities: unknown) => createUsageRightsResolver(policy, { ...good, resolveCapabilities: () => capabilities as readonly string[] });
  assertRefusal(() => unconfigured('x')(actor), 'usage_rights_unconfigured', 503, 'string');
  assertRefusal(() => unconfigured([1])(actor), 'usage_rights_unconfigured', 503, 'number entry');
  assertRefusal(() => unconfigured(['has space'])(actor), 'usage_rights_unconfigured', 503, 'invalid identifier');
  assertRefusal(() => unconfigured(new Array(33).fill('cap.standard'))(actor), 'usage_rights_unconfigured', 503, '33 entries');
  assertRefusal(() => unconfigured(undefined)(actor), 'usage_rights_unconfigured', 503, 'undefined');
  assertRefusal(() => unconfigured([, 'cap.standard'])(actor), 'usage_rights_unconfigured', 503, 'sparse array');
  assert.deepEqual(unconfigured(new Array(32).fill('cap.standard'))(actor).capabilities, ['cap.standard']);
  assert.deepEqual(unconfigured([])(actor).capabilities, []);
});

test('the ledger still enforces capabilities and configured providers from the built rights', t => {
  const state = exampleGrantState();
  const { ledger } = configuredLedger(t, undefined, state);
  state.capabilities = state.capabilities.filter(capability => capability !== 'cap.standard');
  assertRefusal(() => ledger.usage.reserve(actor, standardIntent('no-capability')), 'usage_capability_denied', 403);
  state.capabilities.push('cap.standard');
  assert.equal(ledger.usage.reserve(actor, standardIntent('with-capability')).kind, 'new');

  const partial = configuredLedger(t, undefined, undefined, ['standard_voice_turn']);
  assertRefusal(() => partial.ledger.usage.reserve(actor, liveIntent('no-provider', 1)), 'usage_provider_unconfigured', 503);
  assertRefusal(() => partial.ledger.usage.reserve(actor, generationIntent('no-provider')), 'usage_provider_unconfigured', 503);
  assert.equal(partial.ledger.usage.reserve(actor, standardIntent('provider-present')).kind, 'new');
});

// Period resolvers --------------------------------------------------------------------------------------------------------

test('UTC calendar months are contiguous half-open periods with exact lengths', () => {
  const resolve = calendarMonthPeriodResolver(utc);
  const november = resolve(Date.UTC(2026, 10, 17, 12));
  assert.deepEqual(november, { id: 'cal-month:UTC:2026-11', startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2026, 11, 1) });
  assert.equal(resolve(november.endMs - 1).id, november.id);
  assert.equal(resolve(november.endMs).id, 'cal-month:UTC:2026-12');
  assert.equal(resolve(november.startMs).id, november.id);
  assert.equal(resolve(november.startMs - 1).id, 'cal-month:UTC:2026-10');
  assert.equal(resolve(Date.UTC(2026, 11, 31, 23, 59, 59, 999)).endMs, Date.UTC(2027, 0, 1));
  assert.equal(resolve(Date.UTC(2027, 1, 10)).endMs - resolve(Date.UTC(2027, 1, 10)).startMs, 28 * DAY);
  assert.equal(resolve(Date.UTC(2028, 1, 10)).endMs - resolve(Date.UTC(2028, 1, 10)).startMs, 29 * DAY);
  assert.equal(resolve(0).id, 'cal-month:UTC:1970-01');
  assert.equal(usagePeriodPolicyId(utc), 'calendar-month-v1:UTC');
});

test('America/New_York months follow local midnight across daylight-saving changes', () => {
  const resolve = calendarMonthPeriodResolver(newYork);
  const november = resolve(Date.UTC(2026, 10, 17, 12));
  assert.deepEqual(november, { id: 'cal-month:America/New_York:2026-11', startMs: Date.UTC(2026, 10, 1, 4), endMs: Date.UTC(2026, 11, 1, 5) });
  assert.equal(november.endMs - november.startMs, 30 * DAY + 3_600_000);
  const march = resolve(Date.UTC(2026, 2, 15));
  assert.equal(march.id, 'cal-month:America/New_York:2026-03');
  assert.deepEqual([march.startMs, march.endMs], [Date.UTC(2026, 2, 1, 5), Date.UTC(2026, 3, 1, 4)]);
  assert.equal(march.endMs - march.startMs, 31 * DAY - 3_600_000);
  const october = resolve(Date.UTC(2026, 10, 1, 3, 59, 59, 999));
  assert.equal(october.id, 'cal-month:America/New_York:2026-10'); assert.equal(october.endMs, november.startMs);
  assert.equal(usagePeriodPolicyId(newYork), 'calendar-month-v1:America/New_York');
});

test('a zone ahead of UTC changes month before UTC does, and half-hour offsets are honoured', () => {
  const auckland = calendarMonthPeriodResolver(zone('Pacific/Auckland'));
  const instant = Date.UTC(2026, 11, 31, 11);
  const january = auckland(instant);
  assert.equal(january.id, 'cal-month:Pacific/Auckland:2027-01'); assert.equal(january.startMs, instant);
  assert.equal(calendarMonthPeriodResolver(utc)(instant).id, 'cal-month:UTC:2026-12');
  assert.equal(auckland(instant - 1).id, 'cal-month:Pacific/Auckland:2026-12');
  const kolkata = calendarMonthPeriodResolver(zone('Asia/Kolkata'))(Date.UTC(2026, 10, 17));
  assert.equal(kolkata.id, 'cal-month:Asia/Kolkata:2026-11'); assert.equal(kolkata.startMs, Date.UTC(2026, 9, 31, 18, 30));
  assert.equal(kolkata.endMs, Date.UTC(2026, 10, 30, 18, 30));
});

test('a skipped local midnight starts the month at the transition instant', () => {
  const resolve = calendarMonthPeriodResolver(zone('America/Asuncion'));
  const october = resolve(Date.UTC(2017, 9, 15));
  assert.equal(october.id, 'cal-month:America/Asuncion:2017-10'); assert.equal(october.startMs, Date.UTC(2017, 9, 1, 4));
  const september = resolve(october.startMs - 1);
  assert.equal(september.id, 'cal-month:America/Asuncion:2017-09'); assert.equal(september.endMs, october.startMs);
});

test('a repeated local midnight keeps the repeated hour in the new period', () => {
  const resolve = calendarMonthPeriodResolver(zone('America/Havana'));
  const november = resolve(Date.UTC(2020, 10, 15));
  assert.equal(november.id, 'cal-month:America/Havana:2020-11');
  assert.deepEqual([november.startMs, november.endMs], [Date.UTC(2020, 10, 1, 4), Date.UTC(2020, 11, 1, 5)]);
  assert.equal(november.endMs - november.startMs, 30 * DAY + 3_600_000);
  assert.deepEqual(resolve(Date.UTC(2020, 10, 1, 5, 30)), november);
  assert.equal(resolve(november.startMs - 1).id, 'cal-month:America/Havana:2020-10');
});

test('36 consecutive months are contiguous, unique and of plausible length in every sampled rule', () => {
  const rules: [string, UsagePeriodRule][] = [['UTC', utc], ['America/New_York', newYork], ['Europe/London', zone('Europe/London')],
    ['Australia/Lord_Howe', zone('Australia/Lord_Howe')], ['Pacific/Auckland', zone('Pacific/Auckland')], ['Asia/Kolkata', zone('Asia/Kolkata')]];
  for (const [label, rule] of rules) {
    const resolve = calendarMonthPeriodResolver(rule), ids = new Set<string>();
    let at = Date.UTC(2025, 0, 1, 12), previous: UsagePeriod | undefined;
    for (let month = 0; month < 36; month++) {
      const period = resolve(at), where = `${label} month ${month}`;
      assert.ok(period.startMs <= at && at < period.endMs, where);
      assert.equal(resolve(period.endMs).startMs, period.endMs, where);
      assert.equal(resolve(period.endMs - 1).id, period.id, where);
      assert.equal(resolve(period.startMs).id, period.id, where);
      assert.ok(!ids.has(period.id), `${where} duplicated ${period.id}`); ids.add(period.id);
      const length = period.endMs - period.startMs;
      assert.ok(length >= 27 * DAY && length <= 32 * DAY, `${where} length ${length}`);
      if (previous) assert.equal(period.startMs, previous.endMs, where);
      else assert.ok(period.id.endsWith(':2025-01'), where);
      previous = period; at = period.endMs;
    }
    assert.equal(ids.size, 36, label);
  }
});

test('non-integer, negative, non-finite and unrepresentable instants are refused', () => {
  for (const rule of [utc, newYork]) {
    const resolve = calendarMonthPeriodResolver(rule);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 8.64e15, '1' as unknown as number, undefined as unknown as number])
      assertRefusal(() => resolve(bad), 'usage_period_invalid', 503, `${rule.kind} ${String(bad)}`);
  }
  // A zone behind UTC would need a month that starts before the epoch for the first hours of 1970; that is refused, not clamped.
  assertRefusal(() => calendarMonthPeriodResolver(newYork)(0), 'usage_period_invalid', 503, 'before the first local boundary after the epoch');
  assert.equal(calendarMonthPeriodResolver(newYork)(Date.UTC(1970, 0, 1, 5)).id, 'cal-month:America/New_York:1970-01');
});

test('the resolver never reads the host time zone', () => {
  const instants = [Date.UTC(2026, 10, 1, 3, 59, 59), Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 11, 31, 23, 30), Date.UTC(2027, 0, 1)];
  const run = () => instants.map(at => [calendarMonthPeriodResolver(utc)(at), calendarMonthPeriodResolver(newYork)(at)]);
  const original = process.env.TZ, baseline = run();
  try {
    for (const hostZone of ['Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata']) {
      process.env.TZ = hostZone;
      assert.deepEqual(run(), baseline, hostZone);
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

test('live usage intervals split at the same New York boundary the ledger uses', () => {
  const policy = createUsagePolicy(exampleUsagePolicyConfig({ period: newYork }));
  const startMs = Date.UTC(2026, 10, 1, 3, 59, 59), endMs = Date.UTC(2026, 10, 1, 4, 0, 1);
  const expected = { sourceId: 'synthetic-source', evidenceId: 'synthetic-evidence', clockId: 'synthetic-clock', meteringPolicyId: 'synthetic-metering' };
  const allocation = allocateLiveUsageInterval({ ...expected, startMs, endMs, observedAtMs: endMs },
    { expected, periodPolicyId: policy.periodPolicyId, periodResolver: policy.periodResolver, maxPeriods: 2,
      freshness: { asOfMs: endMs, maxEvidenceAgeMs: 1000 } });
  assert.deepEqual(allocation.segments.map(segment => [segment.period.id, segment.milliseconds]),
    [['cal-month:America/New_York:2026-10', 1000], ['cal-month:America/New_York:2026-11', 1000]]);
  assert.equal(allocation.totalMilliseconds, 2000);
});

// Quota semantics on the real ledger --------------------------------------------------------------------------------------

test('the live cap admits exactly 9,000,000 milliseconds and no more', t => {
  const { ledger } = configuredLedger(t);
  assert.equal(ledger.usage.reserve(actor, liveIntent('part-a', 8_999_999)).snapshot.metrics?.live_voice_ms.remaining, 1);
  assert.equal(ledger.usage.reserve(actor, liveIntent('part-b', 1)).snapshot.metrics?.live_voice_ms.remaining, 0);
  assertRefusal(() => ledger.usage.reserve(actor, liveIntent('part-c', 1)), 'usage_limit_exceeded', 429);
  assert.equal(ledger.usage.status(actor).metrics?.live_voice_ms.remaining, 0);
  const single = configuredLedger(t);
  const settled = settleLive(single.ledger, 'whole-cap', 9_000_000, 9_000_000);
  assert.equal(settled.metrics?.live_voice_ms.settled, 9_000_000); assert.equal(settled.metrics?.live_voice_ms.remaining, 0);
});

test('an overrun within the cap is recorded exactly and leaves the exact remainder', t => {
  const { ledger } = configuredLedger(t);
  assert.equal(settleLive(ledger, 'overrun', 1000, 5000).metrics?.live_voice_ms.settled, 5000);
  assertRefusal(() => ledger.usage.reserve(actor, liveIntent('too-much', 8_995_001)), 'usage_limit_exceeded', 429);
  assert.equal(ledger.usage.reserve(actor, liveIntent('just-fits', 8_995_000)).kind, 'new');
});

test('an overrun past the cap is recorded, floors remaining at zero and clears in the next period', t => {
  const { ledger, f } = configuredLedger(t);
  const settled = settleLive(ledger, 'past-cap', 9_000_000, 9_000_500);
  assert.equal(settled.metrics?.live_voice_ms.settled, 9_000_500); assert.equal(settled.metrics?.live_voice_ms.remaining, 0);
  assertRefusal(() => ledger.usage.reserve(actor, liveIntent('next', 1)), 'usage_limit_exceeded', 429);
  f.state.now = settled.period?.endMs ?? assert.fail('settlement reports its period');
  const next = ledger.usage.status(actor);
  assert.equal(next.period?.id, 'cal-month:UTC:2026-11');
  assert.equal(next.metrics?.live_voice_ms.remaining, 9_000_000); assert.equal(next.metrics?.live_voice_ms.settled, 0);
});

test('a live hold that would cross the period boundary is refused, and settlement stays in the reservation period', t => {
  const { ledger, f, policy } = configuredLedger(t, exampleUsagePolicyConfig({ period: newYork }));
  const october = policy.periodResolver(Date.UTC(2026, 9, 15)), endMs = october.endMs;
  assert.equal(endMs, Date.UTC(2026, 10, 1, 4));
  f.state.now = endMs - 120_000;
  const reservation = ledger.usage.reserve(actor, liveIntent('crossing', 60_000));
  assert.equal(reservation.kind, 'new');
  ledger.usage.markDispatching(reservation.handle, liveStage);
  f.state.now = endMs + 1;
  const settled = ledger.trusted.settle(reservation.handle, { charges: [{ metric: 'live_voice_ms', amount: 60_000 }] });
  assert.equal(settled.period?.id, 'cal-month:America/New_York:2026-10');
  assert.equal(settled.metrics?.live_voice_ms.settled, 60_000);
  const status = ledger.usage.status(actor);
  assert.equal(status.period?.id, 'cal-month:America/New_York:2026-11'); assert.equal(status.metrics?.live_voice_ms.settled, 0);
  assert.equal(status.metrics?.live_voice_ms.remaining, 9_000_000);
});

test('a hold is admitted up to the last millisecond of the period and refused beyond it', t => {
  const { ledger, f, policy } = configuredLedger(t, exampleUsagePolicyConfig({ period: newYork }));
  f.state.now = policy.periodResolver(Date.UTC(2026, 9, 15)).endMs - 10;
  assertRefusal(() => ledger.usage.reserve(actor, liveIntent('eleven', 11)), 'usage_period_boundary', 409);
  assert.equal(ledger.usage.reserve(actor, liveIntent('ten', 10)).kind, 'new');
});

test('a Standard turn dispatched in one period and settled in the next counts in the first, and dispatch after the end is refused', t => {
  const { ledger, f, policy } = configuredLedger(t, exampleUsagePolicyConfig({ period: newYork }));
  const endMs = policy.periodResolver(Date.UTC(2026, 9, 15)).endMs;
  f.state.now = endMs - 1000;
  const dispatched = ledger.usage.reserve(actor, standardIntent('before-boundary'));
  ledger.usage.markDispatching(dispatched.handle, 'transcribe');
  const late = ledger.usage.reserve(actor, standardIntent('never-dispatched'));
  f.state.now = endMs + 1;
  const settled = ledger.trusted.settle(dispatched.handle, { charges: [{ metric: 'coach_messages', amount: 1 }] });
  assert.equal(settled.period?.id, 'cal-month:America/New_York:2026-10'); assert.equal(settled.metrics?.coach_messages.settled, 1);
  assert.equal(ledger.usage.status(actor).metrics?.coach_messages.settled, 0);
  assertRefusal(() => ledger.usage.markDispatching(late.handle, 'transcribe'), 'usage_dispatch_expired', 409);
});

test('Standard turns never charge time, whatever the live counter holds', t => {
  const { ledger, f } = configuredLedger(t);
  const timed: UsageIntent = { ...standardIntent('timed'), charges: [{ metric: 'live_voice_ms', amount: 1 }] };
  assertRefusal(() => ledger.usage.reserve(actor, timed), 'usage_charge_policy_mismatch', 400, 'time only');
  const both: UsageIntent = { ...standardIntent('both'), charges: [{ metric: 'coach_messages', amount: 1 }, { metric: 'live_voice_ms', amount: 1 }] };
  assertRefusal(() => ledger.usage.reserve(actor, both), 'usage_charge_policy_mismatch', 400, 'messages and time');
  for (const key of ['turn-1', 'turn-2', 'turn-3']) settleStandard(ledger, key);
  const rows = counters(f.db, 'live_voice_ms') as { settled: number; reserved: number; unknown: number }[];
  assert.ok(rows.length > 0); assert.ok(rows.every(row => row.settled === 0 && row.reserved === 0 && row.unknown === 0));
  assert.equal(ledger.usage.status(actor).metrics?.coach_messages.settled, 3);
  settleLive(ledger, 'fill-live', 9_000_000, 9_000_000);
  assert.equal(ledger.usage.status(actor).metrics?.live_voice_ms.remaining, 0);
  assert.equal(ledger.usage.reserve(actor, standardIntent('after-live-full')).kind, 'new');
});

test('message and generation caps are independent of each other and of live time', t => {
  const config = exampleUsagePolicyConfig({ limits: { live_voice_ms: 9_000_000, coach_messages: 2, workout_generations: 1 } });
  const messages = configuredLedger(t, config);
  settleStandard(messages.ledger, 'm1'); messages.ledger.usage.reserve(actor, standardIntent('m2'));
  assertRefusal(() => messages.ledger.usage.reserve(actor, standardIntent('m3')), 'usage_limit_exceeded', 429);
  assert.equal(messages.ledger.usage.reserve(actor, generationIntent('g1')).kind, 'new');
  assert.equal(messages.ledger.usage.reserve(actor, liveIntent('l1', 1000)).kind, 'new');
  const generations = configuredLedger(t, config);
  generations.ledger.usage.reserve(actor, generationIntent('g1'));
  assertRefusal(() => generations.ledger.usage.reserve(actor, generationIntent('g2')), 'usage_limit_exceeded', 429);
  assert.equal(generations.ledger.usage.reserve(actor, standardIntent('m1')).kind, 'new');
  assert.equal(generations.ledger.usage.status(actor).metrics?.coach_messages.remaining, 1);
});

test('ordinary workout execution and logging are never capped by any configuration the builder can express', t => {
  const flags = { ordinaryWorkoutExecution: 'unrestricted_by_usage_limits', ordinaryWorkoutLogging: 'unrestricted_by_usage_limits' } as const;
  const config = exampleUsagePolicyConfig({ limits: { live_voice_ms: 9_000_000, coach_messages: 0, workout_generations: 0 } });
  const { ledger, policy } = configuredLedger(t, config);
  settleLive(ledger, 'fill', 9_000_000, 9_000_000);
  const snapshot = ledger.usage.status(actor);
  assert.equal(snapshot.ordinaryWorkoutExecution, flags.ordinaryWorkoutExecution);
  assert.equal(snapshot.ordinaryWorkoutLogging, flags.ordinaryWorkoutLogging);
  assert.ok(Object.keys(policy.operations).every(name => (usageOperationKinds as readonly string[]).includes(name)));
  for (const name of ['workout_log', 'workout_execution', 'workout_logging', 'log_set', 'ordinary_logging'])
    assertRefusal(() => createUsagePolicy(mutated(c => { c.operations = { [name]: { capability: 'cap.log' } }; })), 'usage_policy_config_invalid', 503, name);
  const bare = configuredLedger(t), configuration = createUsageLimitsConfiguration();
  const unconfigured = createUsageLedger({ db: bare.f.db, lifecycle: bare.f.lifecycle, now: () => bare.f.state.now, ...(configuration ?? {}) });
  const bareSnapshot = unconfigured.usage.status(actor);
  assert.equal(bareSnapshot.ordinaryWorkoutExecution, flags.ordinaryWorkoutExecution);
  assert.equal(bareSnapshot.ordinaryWorkoutLogging, flags.ordinaryWorkoutLogging);
});

test('the explicit message-counting mode must match the live intent in both directions', t => {
  const excluded = configuredLedger(t, exampleUsagePolicyConfig({ liveMessageCounting: 'excluded' }));
  assertRefusal(() => excluded.ledger.usage.reserve(actor, liveIntent('with-message', 1000, true)), 'usage_charge_policy_mismatch', 400, 'excluded');
  assert.equal(excluded.ledger.usage.reserve(actor, liveIntent('without-message', 1000)).kind, 'new');
  const included = configuredLedger(t, exampleUsagePolicyConfig({ liveMessageCounting: 'included' }));
  assertRefusal(() => included.ledger.usage.reserve(actor, liveIntent('without-message', 1000)), 'usage_charge_policy_mismatch', 400, 'included');
  const reservation = included.ledger.usage.reserve(actor, liveIntent('with-message', 1000, true));
  assert.equal(reservation.snapshot.metrics?.coach_messages.reserved, 1);
  assert.equal(reservation.snapshot.metrics?.live_voice_ms.reserved, 1000);
});

test('changing the period rule after an account holds usage fails closed', t => {
  const first = configuredLedger(t, exampleUsagePolicyConfig({ period: utc }));
  assert.equal(first.ledger.usage.reserve(actor, standardIntent('under-utc')).kind, 'new');
  const second = ledgerOn(first.f, exampleUsagePolicyConfig({ period: newYork }));
  assertRefusal(() => second.ledger.usage.reserve(actor, standardIntent('under-new-york')), 'usage_period_policy_changed', 503, 'reserve');
  assertRefusal(() => second.ledger.usage.status(actor), 'usage_period_policy_changed', 503, 'status');
  assert.equal(first.ledger.usage.status(actor).metrics?.coach_messages.reserved, 1);
  const unusedAccount = second.ledger.usage.status(otherActor);
  assert.equal(unusedAccount.period?.id.startsWith('cal-month:America/New_York:'), true);
});
