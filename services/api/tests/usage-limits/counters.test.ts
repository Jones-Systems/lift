import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DomainError } from '../../src/errors.js';
import type { Sqlite } from '../../src/storage.js';
import {
  createUsageCounters, createUsageLedger, createUsageLimitsConfiguration, usageCounterKinds, usageOwnedTables,
} from '../../src/usage-limits/index.js';
import type {
  UsageCounterAdmission, UsageCounterKind, UsageCounterRequest, UsageMetric, UsagePolicyConfig, UsageSnapshot,
} from '../../src/usage-limits/index.js';
import { actor, otherActor, END } from './fixture.js';
import { configuredLedger, exampleGrantState, exampleUsagePolicyConfig } from './policy-fixture.js';

function assertRefusal(action: () => unknown, code: string, status: number, label: string = code): void {
  try { action(); } catch (error) {
    assert.ok(error instanceof DomainError, `${label}: expected DomainError, got ${String(error)}`);
    assert.deepEqual([error.status, error.code], [status, code], label);
    return;
  }
  assert.fail(`${label}: expected ${status} ${code}`);
}
const request = (key: string, overrides: Partial<UsageCounterRequest> = {}): UsageCounterRequest =>
  ({ idempotencyKey: key, subjectId: 'subject-a', requestSha256: 'a'.repeat(64), ...overrides });
const tables = (db: Sqlite) => usageOwnedTables.map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
const reservationCount = (db: Sqlite) => (db.prepare('SELECT count(*) AS n FROM usage_reservations').get() as { n: number }).n;
const metric = (snapshot: UsageSnapshot, name: UsageMetric) => snapshot.metrics?.[name] ?? assert.fail(`snapshot has no ${name}`);
const capped = (messages: number, generations: number) =>
  exampleUsagePolicyConfig({ limits: { live_voice_ms: 9_000_000, coach_messages: messages, workout_generations: generations } });
function setup(t: TestContext, config?: UsagePolicyConfig) {
  const built = configuredLedger(t, config);
  return { ...built, counters: createUsageCounters(built.ledger) };
}
function newAdmission(admission: UsageCounterAdmission) {
  if (admission.kind !== 'new') throw new Error(`expected a new admission, got a ${admission.kind} in state ${admission.state}`);
  return admission;
}

test('a coach message reserves one unit, dispatches, settles and leaves other counters untouched', t => {
  const { counters, ledger, f } = setup(t, capped(5, 5));
  const admission = newAdmission(counters.admit('coach_message', actor, request('message-1')));
  assert.equal(metric(admission.snapshot, 'coach_messages').reserved, 1);
  assert.equal(metric(admission.snapshot, 'coach_messages').remaining, 4);
  admission.begin();
  assert.equal(metric(ledger.usage.status(actor), 'coach_messages').reserved, 1);
  const settled = admission.settle();
  assert.deepEqual(metric(settled, 'coach_messages'), { limit: 5, settled: 1, reserved: 0, unknown: 0, remaining: 4 });
  assert.deepEqual(metric(settled, 'workout_generations'), { limit: 5, settled: 0, reserved: 0, unknown: 0, remaining: 5 });
  assert.deepEqual(metric(settled, 'live_voice_ms'), { limit: 9_000_000, settled: 0, reserved: 0, unknown: 0, remaining: 9_000_000 });
  const row = f.db.prepare('SELECT operation,state,idempotency_key,account_epoch FROM usage_reservations').get();
  assert.deepEqual(row, { operation: 'coach_message', state: 'settled', idempotency_key: 'message-1', account_epoch: 1 });
  assert.deepEqual(f.db.prepare('SELECT metric,amount,settled_amount FROM usage_charges').all(),
    [{ metric: 'coach_messages', amount: 1, settled_amount: 1 }]);
});

test('a workout generation charges only workout generations', t => {
  const { counters, f } = setup(t, capped(5, 5));
  const admission = newAdmission(counters.admit('workout_generation', actor, request('generation-1')));
  admission.begin();
  const settled = admission.settle();
  assert.deepEqual(metric(settled, 'workout_generations'), { limit: 5, settled: 1, reserved: 0, unknown: 0, remaining: 4 });
  assert.equal(metric(settled, 'coach_messages').settled, 0); assert.equal(metric(settled, 'coach_messages').remaining, 5);
  assert.equal(metric(settled, 'live_voice_ms').settled, 0);
  assert.deepEqual(f.db.prepare('SELECT metric,amount FROM usage_charges').all(), [{ metric: 'workout_generations', amount: 1 }]);
});

test('a replay reports the stored state without effect methods or any ledger write', t => {
  const { counters, f } = setup(t, capped(5, 5));
  const first = newAdmission(counters.admit('coach_message', actor, request('replay-key')));
  const states: string[] = [];
  const replay = () => {
    const before = tables(f.db), admission = counters.admit('coach_message', actor, request('replay-key'));
    assert.equal(admission.kind, 'replay'); assert.equal(admission.reservationId, first.reservationId);
    assert.deepEqual(tables(f.db), before);
    assert.equal(Object.hasOwn(admission, 'begin'), false); assert.equal(Object.hasOwn(admission, 'settle'), false);
    assert.equal(Object.hasOwn(admission, 'release'), false); assert.ok(Object.isFrozen(admission));
    if (admission.kind === 'replay') states.push(admission.state);
    return admission;
  };
  replay(); first.begin(); replay(); first.settle();
  const settled = replay();
  assert.deepEqual(states, ['reserved', 'dispatching', 'settled']);
  assert.equal(metric(settled.snapshot, 'coach_messages').settled, 1);
  assert.equal(metric(settled.snapshot, 'coach_messages').remaining, 4);
});

test('the same key with a different request digest or subject is an idempotency mismatch', t => {
  const { counters } = setup(t, capped(5, 5));
  newAdmission(counters.admit('coach_message', actor, request('mismatch')));
  assertRefusal(() => counters.admit('coach_message', actor, request('mismatch', { requestSha256: 'b'.repeat(64) })),
    'usage_idempotency_mismatch', 409, 'digest');
  assertRefusal(() => counters.admit('coach_message', actor, request('mismatch', { subjectId: 'subject-b' })),
    'usage_idempotency_mismatch', 409, 'subject');
  assert.equal(counters.admit('coach_message', actor, request('mismatch')).kind, 'replay');
});

test('a reached cap refuses with 429 without consuming the key, and a released unit can be reused', t => {
  const { counters, f } = setup(t, capped(2, 2));
  const first = newAdmission(counters.admit('coach_message', actor, request('cap-1')));
  newAdmission(counters.admit('coach_message', actor, request('cap-2')));
  const before = tables(f.db);
  assertRefusal(() => counters.admit('coach_message', actor, request('cap-3')), 'usage_limit_exceeded', 429);
  assert.deepEqual(tables(f.db), before); assert.equal(reservationCount(f.db), 2);
  assert.equal(metric(first.release(), 'coach_messages').remaining, 1);
  const third = newAdmission(counters.admit('coach_message', actor, request('cap-3')));
  assert.equal(metric(third.snapshot, 'coach_messages').remaining, 0);
  assertRefusal(() => counters.admit('coach_message', actor, request('cap-4')), 'usage_limit_exceeded', 429);
  assert.equal(counters.admit('workout_generation', actor, request('cap-4')).kind, 'new');
});

test('the example configuration reports its explicit limits without looping to them', t => {
  const { counters } = setup(t);
  const message = newAdmission(counters.admit('coach_message', actor, request('limits-message')));
  const generation = newAdmission(counters.admit('workout_generation', actor, request('limits-generation')));
  for (const snapshot of [message.snapshot, generation.snapshot]) {
    assert.equal(metric(snapshot, 'coach_messages').limit, 1000); assert.equal(metric(snapshot, 'workout_generations').limit, 100);
    assert.equal(metric(snapshot, 'live_voice_ms').limit, 9_000_000);
  }
  assert.equal(metric(message.snapshot, 'coach_messages').remaining, 999);
  assert.equal(metric(generation.snapshot, 'workout_generations').remaining, 99);
});

test('release, settle and reconciliation follow the ledger lifecycle exactly', t => {
  const { counters } = setup(t, capped(10, 10));
  const released = newAdmission(counters.admit('coach_message', actor, request('life-release')));
  assert.deepEqual(metric(released.release(), 'coach_messages'), { limit: 10, settled: 0, reserved: 0, unknown: 0, remaining: 10 });

  const early = newAdmission(counters.admit('coach_message', actor, request('life-early-settle')));
  assertRefusal(() => early.settle(), 'usage_settlement_state_invalid', 409, 'settle before begin');
  early.begin();
  assertRefusal(() => early.release(), 'usage_release_requires_reconciliation', 409, 'release after begin');
  early.settle();

  const unknown = newAdmission(counters.admit('coach_message', actor, request('life-unknown')));
  unknown.begin();
  assert.equal(metric(unknown.markUnknown(), 'coach_messages').unknown, 1);
  assert.equal(metric(unknown.markUnknown(), 'coach_messages').unknown, 1);
  assertRefusal(() => unknown.release(), 'usage_release_requires_reconciliation', 409, 'release when unknown');

  const free = newAdmission(counters.admit('coach_message', actor, request('life-not-consumed')));
  free.begin();
  const freed = free.notConsumed('evidence-1');
  assert.equal(metric(freed, 'coach_messages').reserved, 0);
  assert.equal(metric(freed, 'coach_messages').settled, 1);
  assert.equal(metric(freed, 'coach_messages').unknown, 1);
  assert.equal(metric(freed, 'coach_messages').remaining, 8);
  assert.equal(counters.admit('coach_message', actor, request('life-not-consumed')).kind, 'replay');
});

test('an admission exposes no reservation handle and is frozen', t => {
  const { counters } = setup(t);
  const admission = newAdmission(counters.admit('coach_message', actor, request('no-handle')));
  assert.deepEqual(Object.keys(admission).sort(), ['begin', 'kind', 'markUnknown', 'notConsumed', 'release', 'reservationId', 'settle', 'snapshot']);
  assert.ok(Object.isFrozen(admission)); assert.ok(Object.isFrozen(counters));
  assert.equal(JSON.stringify(admission).includes('handle'), false);
});

test('caps, accounts and kinds are isolated from each other', t => {
  const { counters } = setup(t, capped(1, 1));
  newAdmission(counters.admit('coach_message', actor, request('shared-key')));
  assertRefusal(() => counters.admit('coach_message', actor, request('another-key')), 'usage_limit_exceeded', 429, 'actor A at the cap');
  assert.equal(counters.admit('coach_message', otherActor, request('shared-key')).kind, 'new');
  assert.equal(counters.admit('workout_generation', actor, request('shared-key')).kind, 'new');
  assertRefusal(() => counters.admit('workout_generation', actor, request('second-generation')), 'usage_limit_exceeded', 429, 'generation cap');
  assertRefusal(() => counters.admit('coach_message', otherActor, request('other-second')), 'usage_limit_exceeded', 429, 'actor B at the cap');
});

test('a different session or epoch cannot reuse a key, and a revoked epoch can still release but not begin', t => {
  const { counters, f } = setup(t, capped(5, 5));
  const first = newAdmission(counters.admit('coach_message', actor, request('fenced')));
  assertRefusal(() => counters.admit('coach_message', { ...actor, sessionId: 'other-session' }, request('fenced')), 'usage_actor_mismatch', 403, 'other session');
  f.state.epoch = 2;
  assertRefusal(() => first.begin(), 'test_actor_revoked', 403, 'begin after epoch bump');
  assert.equal(metric(first.release(), 'coach_messages').reserved, 0);
  assertRefusal(() => counters.admit('coach_message', actor, request('fenced')), 'test_actor_revoked', 403, 'old actor');
  const next = newAdmission(counters.admit('coach_message', { ...actor, epoch: 2 }, request('after-bump')));
  assert.equal(next.snapshot.metrics?.coach_messages.reserved, 1);
  assert.deepEqual(f.db.prepare('SELECT idempotency_key,account_epoch,state FROM usage_reservations ORDER BY created_at_ms,rowid').all(),
    [{ idempotency_key: 'fenced', account_epoch: 1, state: 'released' }, { idempotency_key: 'after-bump', account_epoch: 2, state: 'reserved' }]);
});

test('settlement and unknown marking keep working for an original actor after revocation', t => {
  const { counters, f } = setup(t, capped(5, 5));
  const settled = newAdmission(counters.admit('coach_message', actor, request('revoked-settle')));
  settled.begin();
  const unknown = newAdmission(counters.admit('workout_generation', actor, request('revoked-unknown')));
  unknown.begin();
  f.state.active = false;
  assert.equal(metric(settled.settle(), 'coach_messages').settled, 1);
  assert.equal(metric(unknown.markUnknown(), 'workout_generations').unknown, 1);
});

test('an unconfigured ledger, a missing capability or an unconfigured provider refuses before any row', t => {
  const { f } = setup(t);
  const unconfigured = createUsageCounters(createUsageLedger({
    db: f.db, lifecycle: f.lifecycle, now: () => f.state.now, ...(createUsageLimitsConfiguration() ?? {}),
  }));
  assertRefusal(() => unconfigured.admit('coach_message', actor, request('unconfigured')), 'usage_unconfigured', 503);
  assert.equal(reservationCount(f.db), 0);

  const state = exampleGrantState();
  const denied = configuredLedger(t, undefined, state), deniedCounters = createUsageCounters(denied.ledger);
  state.capabilities = state.capabilities.filter(capability => capability !== 'cap.message');
  assertRefusal(() => deniedCounters.admit('coach_message', actor, request('denied')), 'usage_capability_denied', 403);
  assert.equal(deniedCounters.admit('workout_generation', actor, request('still-granted')).kind, 'new');
  assert.equal(reservationCount(denied.f.db), 1);

  const partial = configuredLedger(t, undefined, undefined, ['workout_generation']), partialCounters = createUsageCounters(partial.ledger);
  assertRefusal(() => partialCounters.admit('coach_message', actor, request('no-provider')), 'usage_provider_unconfigured', 503);
  assert.equal(reservationCount(partial.f.db), 0);

  const missing = configuredLedger(t, exampleUsagePolicyConfig({ operations: { workout_generation: { capability: 'cap.generate' } } }),
    undefined, ['workout_generation']);
  assertRefusal(() => createUsageCounters(missing.ledger).admit('coach_message', actor, request('no-operation')),
    'usage_operation_unconfigured', 503);
  assert.equal(reservationCount(missing.f.db), 0);
});

test('begin refuses to authorize an effect from inside a caller transaction', t => {
  const { counters, f } = setup(t);
  const admission = newAdmission(counters.admit('coach_message', actor, request('in-transaction')));
  assertRefusal(() => f.db.transaction(() => admission.begin())(), 'usage_dispatch_requires_outermost_transaction', 503);
  assert.deepEqual(f.db.prepare('SELECT state FROM usage_reservations').get(), { state: 'reserved' });
  admission.begin();
  assert.deepEqual(f.db.prepare('SELECT state FROM usage_reservations').get(), { state: 'dispatching' });
});

test('an operation begun in one month and settled in the next counts in the month it was admitted', t => {
  const { counters, f, ledger } = setup(t, capped(3, 3));
  const admission = newAdmission(counters.admit('coach_message', actor, request('rollover')));
  assert.equal(admission.snapshot.period?.id, 'cal-month:UTC:2026-10');
  admission.begin();
  f.state.now = END + 1;
  const settled = admission.settle();
  assert.equal(settled.period?.id, 'cal-month:UTC:2026-10'); assert.equal(metric(settled, 'coach_messages').settled, 1);
  const november = ledger.usage.status(actor);
  assert.equal(november.period?.id, 'cal-month:UTC:2026-11');
  assert.deepEqual(metric(november, 'coach_messages'), { limit: 3, settled: 0, reserved: 0, unknown: 0, remaining: 3 });
});

test('malformed kinds, keys, subjects and digests are refused before any ledger write', t => {
  const { counters, f } = setup(t);
  const bad = (kind: unknown, supplied: unknown, code: string, label: string) =>
    assertRefusal(() => counters.admit(kind as UsageCounterKind, actor, supplied as UsageCounterRequest), code, 400, label);
  bad('live', request('ok-key'), 'usage_counter_kind_invalid', 'kind live');
  bad('standard_voice_turn', request('ok-key'), 'usage_counter_kind_invalid', 'kind standard');
  bad('toString', request('ok-key'), 'usage_counter_kind_invalid', 'inherited property name');
  bad(undefined, request('ok-key'), 'usage_counter_kind_invalid', 'kind undefined');
  bad('coach_message', request('has space'), 'usage_invalid_identifier', 'key with a space');
  bad('coach_message', request('k'.repeat(161)), 'usage_invalid_identifier', 'key of 161 characters');
  bad('coach_message', request(''), 'usage_invalid_identifier', 'empty key');
  bad('coach_message', request('ok-key', { subjectId: 'has space' }), 'usage_invalid_identifier', 'subject with a space');
  bad('coach_message', request('ok-key', { requestSha256: 'A'.repeat(64) }), 'usage_invalid_intent_hash', 'uppercase digest');
  bad('coach_message', request('ok-key', { requestSha256: 'a'.repeat(63) }), 'usage_invalid_intent_hash', '63-character digest');
  bad('coach_message', request('ok-key', { requestSha256: 'a'.repeat(65) }), 'usage_invalid_intent_hash', '65-character digest');
  bad('coach_message', request('ok-key', { requestSha256: 5 as unknown as string }), 'usage_invalid_intent_hash', 'numeric digest');
  bad('coach_message', { idempotencyKey: 5, subjectId: 'subject-a', requestSha256: 'a'.repeat(64) }, 'usage_invalid_identifier', 'numeric key');
  bad('coach_message', { idempotencyKey: 'ok-key', subjectId: 7n, requestSha256: 'a'.repeat(64) }, 'usage_invalid_identifier', 'bigint subject');
  bad('coach_message', null, 'usage_invalid_identifier', 'null request');
  assert.equal(reservationCount(f.db), 0);
  assert.deepEqual([...usageCounterKinds], ['coach_message', 'workout_generation']);
});
