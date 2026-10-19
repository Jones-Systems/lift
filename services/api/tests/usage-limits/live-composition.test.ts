import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { DomainError } from '../../src/errors.js';
import type { AccountContext, LifecycleBindings } from '../../src/lifecycle/types.js';
import { createUsageLedger } from '../../src/usage-limits/ledger.js';
import { usageMigrationSql } from '../../src/usage-limits/migration.js';
import { applySyntheticLiveUsage, captureSyntheticLiveAdmission, prepareSyntheticLiveUsage } from '../../src/usage-limits/dev-live-composition.js';
import type { SyntheticLiveAdmission, SyntheticLiveBinding, SyntheticLiveContext, SyntheticLiveObservation,
  SyntheticLiveTerminal } from '../../src/usage-limits/dev-live-composition.js';
import type { UsageIntent, UsagePolicy } from '../../src/usage-limits/types.js';

const actor: AccountContext = Object.freeze({ accountId: 'synthetic-account', authUserId: 'synthetic-auth',
  sessionId: 'synthetic-session', epoch: 1 });
const periodResolver: UsagePolicy['periodResolver'] = atMs => {
  const startMs = Math.floor(atMs / 100) * 100;
  return { id: `period-${startMs}`, startMs, endMs: startMs + 100 };
};
const context: SyntheticLiveContext = {
  qualification: 'synthetic_only', sourceId: 'scripted-source', clockId: 'scripted-clock',
  meteringPolicyId: 'scripted-counting', periodPolicyId: 'scripted-periods', periodResolver,
  maxPeriods: 4, maxReservations: 4, maxIntervals: 8, maxSegments: 16,
  freshness: { asOfMs: 400, maxEvidenceAgeMs: 400 },
};
function fixture(t: TestContext) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO form_accounts VALUES(?)').run(actor.accountId);
  db.exec(usageMigrationSql);
  const state = { now: 10, active: true };
  const lifecycle: LifecycleBindings = {
    assertActive(value) {
      if (!state.active || value.accountId !== actor.accountId || value.epoch !== actor.epoch)
        throw new DomainError(403, 'synthetic_revoked');
    },
    withActiveWrite(value, effect) { lifecycle.assertActive(value); return effect(); },
    adultEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'eligible', profileRevision: 1 }),
  };
  const policy: UsagePolicy = { id: 'synthetic-policy', periodPolicyId: context.periodPolicyId,
    periodResolver, periodAllocation: 'reservation_period', liveRounding: 'exact_milliseconds',
    liveMessageCounting: 'included', limits: { live_voice_ms: 9_000_000, coach_messages: 100, workout_generations: 100 },
    operations: { live: { capability: 'synthetic-live', metrics: ['live_voice_ms', 'coach_messages'] } } };
  const ledger = createUsageLedger({ db, lifecycle, policy, now: () => state.now,
    resolveRights: () => ({ policyId: 'synthetic-rights', capabilities: ['synthetic-live'], configuredOperations: ['live'] }) });
  const admit = (key: string, now: number, amount = 20) => {
    state.now = now;
    const intent: UsageIntent = { operation: 'live', idempotencyKey: key, intentHash: 'a'.repeat(64), subjectId: 'synthetic-subject',
      charges: [{ metric: 'live_voice_ms', amount }, { metric: 'coach_messages', amount: 2 }], dispatchStages: ['connect'] };
    const reservation = ledger.usage.reserve(actor, intent);
    const permit = ledger.usage.markDispatching(reservation.handle, 'connect');
    const admission = captureSyntheticLiveAdmission({ reservation, intent, permit });
    return { admission, reservation, permit, intent };
  };
  const counters = () => db.prepare('SELECT period_id,metric,settled,reserved,unknown FROM usage_counters ORDER BY period_id,metric').all();
  const resolutions = () => db.prepare('SELECT state,evidence_id FROM usage_reservations ORDER BY created_at_ms').all();
  return { db, state, ledger, admit, counters, resolutions };
}
function observation(id: string, startMs: number, endMs: number,
  assignments: readonly { admission: SyntheticLiveAdmission; startMs: number; endMs: number }[]): SyntheticLiveObservation {
  return { expectedEvidenceId: id, interval: { sourceId: context.sourceId, evidenceId: id,
    clockId: context.clockId, meteringPolicyId: context.meteringPolicyId, startMs, endMs, observedAtMs: endMs },
  segments: assignments.map(entry => ({ binding: entry.admission.binding, startMs: entry.startMs, endMs: entry.endMs })) };
}
function single(id: string, admission: SyntheticLiveAdmission, startMs: number, endMs: number) {
  return observation(id, startMs, endMs, [{ admission, startMs, endMs }]);
}
function terminal(admission: SyntheticLiveAdmission, amount: number, messages = 1): SyntheticLiveTerminal {
  return { binding: admission.binding, evidenceId: `terminal-${admission.binding.period.id}`,
    sourceId: context.sourceId, clockId: context.clockId, meteringPolicyId: context.meteringPolicyId,
    observedAtMs: 350, outcome: 'settled', charges: [{ metric: 'live_voice_ms', amount }, { metric: 'coach_messages', amount: messages }] };
}
const fails = (fn: () => unknown) => assert.throws(fn, DomainError);

test('live composition preserves exact multi-interval period totals and uncapped overruns in real ledger rows', t => {
  const f = fixture(t), a = f.admit('a', 80, 10).admission;
  const first = single('interval-a', a, 80, 90);
  const b = f.admit('b', 100, 10).admission;
  const crossing = observation('interval-b', 90, 115, [
    { admission: a, startMs: 90, endMs: 100 }, { admission: b, startMs: 100, endMs: 115 },
  ]);
  const last = single('interval-c', b, 120, 127);
  const plan = prepareSyntheticLiveUsage({ context, admissions: [a, b], observations: [first, crossing, last],
    terminals: [terminal(a, 20), terminal(b, 22)] });
  assert.equal(plan.totalMilliseconds, 42);
  assert.deepEqual(plan.reservations.map(row => row.milliseconds), [20, 22]);
  assert.deepEqual(f.resolutions().map(row => (row as { state: string }).state), ['dispatching', 'dispatching']);
  assert.ok(Object.isFrozen(plan.reservations[0]!.segments[0]!.binding.actor));
  assert.equal(JSON.stringify(plan).includes('handle'), false);
  const applied = applySyntheticLiveUsage(plan, f.ledger.trusted);
  assert.deepEqual(applied.reservations.map(row => row.status), ['confirmed', 'confirmed']);
  assert.equal(applied.atomic, false);
  assert.deepEqual(f.counters(), [
    { period_id: 'period-0', metric: 'coach_messages', settled: 1, reserved: 0, unknown: 0 },
    { period_id: 'period-0', metric: 'live_voice_ms', settled: 20, reserved: 0, unknown: 0 },
    { period_id: 'period-0', metric: 'workout_generations', settled: 0, reserved: 0, unknown: 0 },
    { period_id: 'period-100', metric: 'coach_messages', settled: 1, reserved: 0, unknown: 0 },
    { period_id: 'period-100', metric: 'live_voice_ms', settled: 22, reserved: 0, unknown: 0 },
    { period_id: 'period-100', metric: 'workout_generations', settled: 0, reserved: 0, unknown: 0 },
  ]);
  assert.deepEqual(f.resolutions(), [{ state: 'settled', evidence_id: 'terminal-period-0' },
    { state: 'settled', evidence_id: 'terminal-period-100' }]);
  fails(() => applySyntheticLiveUsage(plan, f.ledger.trusted));
});

test('whole batch rejects duplicate, overlapping, conflicting and missing segment coverage before any resolution', t => {
  const f = fixture(t), a = f.admit('a', 10).admission;
  const base = single('interval-a', a, 10, 20), end = terminal(a, 10);
  const prepare = (observations: readonly SyntheticLiveObservation[], terminals = [end]) =>
    prepareSyntheticLiveUsage({ context, admissions: [a], observations, terminals });
  fails(() => prepare([base, base]));
  fails(() => prepare([base, single('other-id', a, 15, 25)]));
  fails(() => prepare([{ ...base, segments: [] }]));
  fails(() => prepare([{ ...base, segments: [{ binding: a.binding, startMs: 10, endMs: 19 }] }]));
  fails(() => prepare([base], [end, { ...end, evidenceId: 'conflicting-terminal' }]));
  fails(() => prepare([base], [terminal(a, 9)]));
  assert.deepEqual(f.resolutions(), [{ state: 'dispatching', evidence_id: null }]);
});

test('every original actor, admission, permit and period coordinate must match independently captured evidence', t => {
  const f = fixture(t), a = f.admit('a', 10).admission;
  const changed: SyntheticLiveBinding[] = [
    ...(['accountId', 'authUserId', 'sessionId'] as const).map(field => ({ ...a.binding, actor: { ...actor, [field]: 'wrong' } })),
    { ...a.binding, actor: { ...actor, epoch: 2 } }, { ...a.binding, reservationId: 'wrong' },
    { ...a.binding, operation: 'wrong' }, { ...a.binding, intentHash: 'b'.repeat(64) }, { ...a.binding, subjectId: 'wrong' },
    { ...a.binding, period: { ...a.binding.period, endMs: 99 } },
    { ...a.binding, permit: { ...a.binding.permit, stage: 'wrong' } },
    { ...a.binding, permit: { ...a.binding.permit, dispatchedAtMs: 11 } },
  ];
  for (const binding of changed) {
    const observed = { ...single('interval-a', a, 10, 20), segments: [{ binding, startMs: 10, endMs: 20 }] };
    fails(() => prepareSyntheticLiveUsage({ context, admissions: [a], observations: [observed], terminals: [] }));
    fails(() => prepareSyntheticLiveUsage({ context, admissions: [a], observations: [], terminals: [{ ...terminal(a, 0), binding }] }));
  }
  fails(() => prepareSyntheticLiveUsage({ context, admissions: [{ ...a }], observations: [], terminals: [] }));
  fails(() => prepareSyntheticLiveUsage({ context, admissions: [a], observations: [single('retroactive', a, 9, 20)], terminals: [] }));
  assert.deepEqual(f.resolutions(), [{ state: 'dispatching', evidence_id: null }]);
});

test('missing terminal or quantities retain liability while explicit zero and not-consumed evidence can resolve', t => {
  const f = fixture(t), a = f.admit('a', 10).admission, b = f.admit('b', 100).admission,
    c = f.admit('c', 200).admission, d = f.admit('d', 300).admission;
  const noQuantity = terminal(b, 0);
  const { charges: _charges, ...missing } = noQuantity;
  const { charges: _otherCharges, ...notConsumed } = terminal(d, 0);
  const plan = prepareSyntheticLiveUsage({ context, admissions: [a, b, c, d],
    observations: [single('a-interval', a, 10, 20), single('c-zero', c, 200, 200)],
    terminals: [missing, terminal(c, 0, 0), { ...notConsumed, outcome: 'not_consumed' }] });
  assert.deepEqual(plan.reservations.map(row => row.milliseconds), [10, null, 0, null]);
  const result = applySyntheticLiveUsage(plan, f.ledger.trusted);
  assert.deepEqual(result.reservations.map(row => row.status), ['unresolved', 'unresolved', 'confirmed', 'confirmed']);
  assert.equal(result.unresolvedSegments.length, 1);
  assert.deepEqual(f.resolutions().map(row => (row as { state: string }).state), ['unknown', 'unknown', 'settled', 'released']);
  assert.deepEqual(f.db.prepare("SELECT settled,reserved,unknown FROM usage_counters WHERE metric='live_voice_ms' ORDER BY period_id").all(), [
    { settled: 0, reserved: 0, unknown: 20 }, { settled: 0, reserved: 0, unknown: 20 },
    { settled: 0, reserved: 0, unknown: 0 }, { settled: 0, reserved: 0, unknown: 0 },
  ]);
});

test('replayed and recovered handles cannot dispatch or replace the captured original admission', t => {
  const f = fixture(t), original = f.admit('a', 10);
  const replay = f.ledger.usage.reserve(actor, original.intent);
  assert.equal(replay.kind, 'replay');
  fails(() => f.ledger.usage.markDispatching(replay.handle, 'connect'));
  fails(() => captureSyntheticLiveAdmission({ reservation: replay, intent: original.intent, permit: original.permit }));
  const recovered = f.ledger.trusted.recover(actor, original.reservation.handle.reservationId);
  fails(() => f.ledger.usage.markDispatching(recovered, 'connect'));
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM usage_dispatches WHERE dispatched_at_ms IS NOT NULL').get() as { count: number }).count, 1);
});

test('original evidence reconciles after revocation without new admission or dispatch', t => {
  const f = fixture(t), a = f.admit('a', 10).admission;
  const plan = prepareSyntheticLiveUsage({ context, admissions: [a], observations: [single('interval', a, 10, 25)], terminals: [terminal(a, 15)] });
  f.state.active = false;
  fails(() => f.ledger.usage.status(actor));
  assert.equal(applySyntheticLiveUsage(plan, f.ledger.trusted).reservations[0]!.status, 'confirmed');
  assert.deepEqual(f.resolutions(), [{ state: 'settled', evidence_id: 'terminal-period-0' }]);
});

for (const uncertainOperation of ['reconcile', 'markUnknown'] as const) {
  test(`a thrown ${uncertainOperation} after one applied reservation stops all later writes without compensation`, t => {
    const f = fixture(t), a = f.admit('a', 10).admission, b = f.admit('b', 100).admission, c = f.admit('c', 200).admission;
    const plan = prepareSyntheticLiveUsage({ context, admissions: [a, b, c],
      observations: [single('a', a, 10, 20), single('b', b, 100, 110), single('c', c, 200, 210)],
      terminals: [terminal(a, 10), ...(uncertainOperation === 'reconcile' ? [terminal(b, 10)] : []), terminal(c, 10)] });
    const calls: string[] = [];
    const result = applySyntheticLiveUsage(plan, {
      reconcile(handle, evidence) {
        calls.push(handle.reservationId); const snapshot = f.ledger.trusted.reconcile(handle, evidence);
        if (handle.reservationId === b.binding.reservationId) throw new Error('synthetic lost acknowledgement');
        return snapshot;
      },
      markUnknown(handle) {
        calls.push(handle.reservationId); f.ledger.trusted.markUnknown(handle);
        throw new Error('synthetic lost acknowledgement');
      },
    });
    assert.deepEqual(calls, [a.binding.reservationId, b.binding.reservationId]);
    assert.deepEqual(result.reservations.map(row => row.status), ['confirmed', 'unknown_effect', 'not_attempted']);
    assert.equal(result.unresolvedSegments.length, 2);
    assert.deepEqual(f.resolutions().map(row => (row as { state: string }).state),
      ['settled', uncertainOperation === 'reconcile' ? 'settled' : 'unknown', 'dispatching']);
    assert.deepEqual(f.db.prepare("SELECT settled,reserved,unknown FROM usage_counters WHERE period_id='period-200' AND metric='live_voice_ms'").get(),
      { settled: 0, reserved: 20, unknown: 0 });
    fails(() => applySyntheticLiveUsage(plan, f.ledger.trusted));
  });
}

test('explicit source, clock, freshness, count and resolver bounds are validated without ledger effects', t => {
  const f = fixture(t), a = f.admit('a', 10).admission;
  const base = single('interval', a, 10, 20);
  const prepare = (selected = context, observed = base) => prepareSyntheticLiveUsage({ context: selected, admissions: [a], observations: [observed], terminals: [] });
  for (const key of ['sourceId', 'clockId', 'meteringPolicyId'] as const)
    fails(() => prepare(context, { ...base, interval: { ...base.interval, [key]: 'wrong' } }));
  fails(() => prepare({ ...context, freshness: { asOfMs: 400, maxEvidenceAgeMs: 10 } }));
  fails(() => prepare({ ...context, maxSegments: 0 }));
  fails(() => prepare({ ...context, maxIntervals: Number.POSITIVE_INFINITY }));
  fails(() => prepare({ ...context, periodResolver: () => ({ id: 'wrong', startMs: 0, endMs: 100 }) }));
  fails(() => prepare({ ...context, periodResolver: () => ({ id: 'wrong', startMs: 0, endMs: 100 }) }, single('zero', a, 10, 10)));
  fails(() => prepare(context, { ...base, interval: { ...base.interval, endMs: Number.NaN } }));
  assert.deepEqual(f.resolutions(), [{ state: 'dispatching', evidence_id: null }]);
});

test('prepared resolutions detach quantities and strip payloads; uncertain terminal evidence retains liability', t => {
  const f = fixture(t), a = f.admit('a', 10).admission, b = f.admit('b', 100).admission;
  const mutableCharges = [{ metric: 'live_voice_ms' as const, amount: 10 }, { metric: 'coach_messages' as const, amount: 1 }];
  const observed = { ...single('interval-a', a, 10, 20), rawAudio: 'never retain audio', text: 'never retain text' };
  const plan = prepareSyntheticLiveUsage({ context, admissions: [a, b],
    observations: [observed, single('interval-b', b, 100, 110)],
    terminals: [{ ...terminal(a, 10), charges: mutableCharges }, { ...terminal(b, 10), outcome: 'unknown' }] });
  mutableCharges[0]!.amount = 90;
  assert.equal(JSON.stringify(plan).includes('never retain'), false);
  assert.equal(plan.reservations[1]!.reason, 'uncertain_terminal');
  assert.ok(Object.isFrozen(plan.reservations[0]!.segments));
  assert.deepEqual(applySyntheticLiveUsage(plan, f.ledger.trusted).reservations.map(row => row.status), ['confirmed', 'unresolved']);
  assert.deepEqual(f.db.prepare("SELECT settled,reserved,unknown FROM usage_counters WHERE period_id='period-0' AND metric='live_voice_ms'").get(),
    { settled: 10, reserved: 0, unknown: 0 });
  assert.deepEqual(f.db.prepare("SELECT settled,reserved,unknown FROM usage_counters WHERE period_id='period-100' AND metric='live_voice_ms'").get(),
    { settled: 0, reserved: 0, unknown: 20 });
});
