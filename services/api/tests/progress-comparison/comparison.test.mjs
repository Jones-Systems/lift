import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionObservation, activityObservation, compareWork, revalidateComparison, createProgressComparisonReader } from '../../src/progress-comparison/index.ts';

const identity = { variantId: 'synthetic-variant', equipmentId: 'synthetic-dumbbell', laterality: 'left', loadBasis: 'perSide' };
function session(id = 'session-a') {
  return { id, revision: 2, status: 'active', planId: 'plan', planRevision: 1, startedAt: '2026-10-01T12:00:00Z', completedAt: null,
    planSnapshot: {}, occurrences: [{ id: 'occurrence', exerciseId: 'supported-row', itemId: 'plan-item', position: 0,
      target: { targetKg: 100, setTarget: 20, repMin: 20, repMax: 25 } }],
    sets: [{ id: 'set', occurrenceId: 'occurrence', setNumber: 1, revision: 1, reps: 8, weightKg: 10, status: 'confirmed' }] };
}
function observe(s, overrides = {}) {
  const raw = sessionObservation('account-a', s, 'occurrence');
  return sessionObservation('account-a', s, 'occurrence', { source: raw.source, revision: 1, confirmed: true,
    identity: { ...identity, ...overrides } });
}
function activity(id = 'activity') {
  return { id, revision: 1, status: 'recorded', performedConfirmed: true,
    items: [{ id: 'item', exercise: { source: 'global', id: 'supported-row' }, load: { state: 'unknown', confirmed: true },
      sets: [{ id: 'set', repetitions: 8, load: { state: 'knownValue', value: 10, unit: 'kg', basis: 'perSide' } }] }] };
}
function observeActivity(entry, overrides = {}) {
  const raw = activityObservation('account-a', entry, 'item');
  return activityObservation('account-a', entry, 'item', { source: raw.source, revision: 1, confirmed: true,
    identity: { ...identity, ...overrides } });
}
const pair = () => [observe(session()), observe(session('session-b'))];

test('confirmed performed work, not prescribed targets or session completion, determines quantities', () => {
  const a = session(), b = session('session-b');
  b.sets[0].reps = 10;
  b.sets.push({ ...b.sets[0], id: 'draft', reps: 90, status: 'draft' }, { ...b.sets[0], id: 'void', status: 'voided' },
    { ...b.sets[0], id: 'other', occurrenceId: 'other' });
  const result = compareWork(observe(a), observe(b));
  assert.equal(result.status, 'comparable');
  assert.deepEqual(result.delta, { confirmedSets: 0, repetitions: 2, volumeKgRepetitions: 20 });
  assert.equal(result.current.confirmedSets, 1);
  assert.equal(result.interpretation, 'observed_work_only');
});

test('missing identity and each missing identity component stay unknown', () => {
  const [a, b] = pair();
  assert.equal(compareWork(sessionObservation('account-a', session(), 'occurrence'), b).status, 'unknown');
  for (const field of ['variantId', 'equipmentId', 'laterality', 'loadBasis']) {
    const candidate = structuredClone(a); delete candidate.binding.identity[field];
    assert.deepEqual(compareWork(candidate, b).reasons, ['identity_unknown']);
  }
});

test('all identity boundaries are incomparable, including personal exercise revisions', () => {
  for (const [field, value, reason] of [['variantId', 'other', 'variant_mismatch'], ['equipmentId', 'machine', 'equipment_mismatch'],
    ['laterality', 'right', 'laterality_mismatch'], ['loadBasis', 'total', 'load_basis_mismatch']]) {
    assert.deepEqual(compareWork(observe(session()), observe(session('b'), { [field]: value })).reasons, [reason]);
  }
  const [a, b] = pair(); b.exercise.id = 'floor-press';
  assert.deepEqual(compareWork(a, b).reasons, ['exercise_mismatch']);
  a.exercise = { source: 'personal', id: 'custom', revision: 1 }; b.exercise = { ...a.exercise, revision: 2 };
  assert.deepEqual(compareWork(a, b).reasons, ['exercise_mismatch']);
  b.source.accountId = 'account-b';
  assert.deepEqual(compareWork(a, b).reasons, ['account_mismatch']);
});

test('Activity load units convert from the canonical kg/lb contract without doubling per-side work', () => {
  const a = activity(), b = activity('b'); b.items[0].sets[0].load = { state: 'knownValue', value: 10 / 0.45359237, unit: 'lb', basis: 'perSide' };
  const result = compareWork(observeActivity(a), observeActivity(b));
  assert.equal(result.status, 'comparable'); assert.ok(Math.abs(result.delta.volumeKgRepetitions) < 1e-10);
  assert.equal(result.current.repetitions, 8); assert.equal(result.units.load, 'kg');
});

test('unknown load, omitted repetitions, unspecified basis and missing unit are never zero', () => {
  const base = observeActivity(activity());
  for (const [edit, reason] of [
    [entry => { entry.items[0].sets[0].load = { state: 'unknown', confirmed: true }; }, 'load_unknown'],
    [entry => { delete entry.items[0].sets[0].repetitions; }, 'repetitions_unknown'],
    [entry => { entry.items[0].sets[0].load.basis = 'unspecified'; }, 'load_basis_unknown'],
    [entry => { delete entry.items[0].sets[0].load.unit; }, 'invalid_work'],
  ]) {
    const entry = activity('b'); edit(entry);
    assert.deepEqual(compareWork(base, observeActivity(entry)).reasons, [reason]);
  }
});

test('bodyweight, unloaded and explicit zero remain distinct; bodyweight volume is null', () => {
  const a = activity(), b = activity('b');
  for (const entry of [a, b]) entry.items[0].sets[0].load = { state: 'notApplicable', reason: 'bodyweight' };
  const result = compareWork(observeActivity(a), observeActivity(b));
  assert.equal(result.status, 'comparable'); assert.equal(result.current.volumeKgRepetitions, null);
  assert.equal(result.delta.volumeKgRepetitions, null);
  b.items[0].sets[0].load = { state: 'knownValue', value: 0, unit: 'kg', basis: 'perSide' };
  assert.deepEqual(compareWork(observeActivity(a), observeActivity(b)).reasons, ['load_meaning_mismatch']);
  a.items[0].sets[0].load = { ...b.items[0].sets[0].load };
  assert.equal(compareWork(observeActivity(a), observeActivity(b)).current.volumeKgRepetitions, 0);
  b.items[0].sets[0].load = { state: 'notApplicable', reason: 'unloaded' };
  assert.deepEqual(compareWork(observeActivity(a), observeActivity(b)).reasons, ['load_meaning_mismatch']);
});

test('unconfirmed, voided, missing, count-only and timed-only work cannot become comparable sets', () => {
  const base = observeActivity(activity());
  for (const [edit, reason] of [
    [entry => { entry.performedConfirmed = false; }, 'work_unconfirmed'],
    [entry => { entry.status = 'voided'; }, 'work_unconfirmed'],
    [entry => { entry.items = []; }, 'source_missing'],
    [entry => { delete entry.items[0].sets; entry.items[0].reportedSetCount = 3; }, 'no_confirmed_sets'],
    [entry => { delete entry.items[0].sets[0].repetitions; entry.items[0].sets[0].durationSeconds = 60; }, 'repetitions_unknown'],
  ]) {
    const entry = activity('b'); edit(entry);
    assert.deepEqual(compareWork(base, observeActivity(entry)).reasons, [reason]);
  }
});

test('duplicate sets, negative/nonfinite loads and mixed load meanings fail closed', () => {
  const [a, b] = pair();
  for (const value of [-1, Infinity, NaN]) {
    const changed = structuredClone(b); changed.sets[0].load.value = value;
    assert.deepEqual(compareWork(a, changed).reasons, ['invalid_work']);
  }
  const duplicate = structuredClone(b); duplicate.sets.push({ ...duplicate.sets[0] });
  assert.deepEqual(compareWork(a, duplicate).reasons, ['invalid_work']);
  const mixed = structuredClone(b); mixed.sets.push({ id: 'second', repetitions: 8, load: { state: 'notApplicable', reason: 'bodyweight' } });
  assert.deepEqual(compareWork(a, mixed).reasons, ['mixed_load_meaning']);
});

test('correction, void and identity withdrawal invalidate saved evidence and stale bindings block reuse', () => {
  const original = session('b'), a = observe(session()), b = observe(original), result = compareWork(a, b);
  assert.equal(revalidateComparison(result.evidenceToken, a, b).status, 'current');
  const corrected = structuredClone(original); corrected.revision++; corrected.sets[0].reps = 5;
  const stale = sessionObservation('account-a', corrected, 'occurrence', b.binding);
  assert.deepEqual(revalidateComparison(result.evidenceToken, a, stale).result.reasons, ['identity_stale']);
  const updated = revalidateComparison(result.evidenceToken, a, observe(corrected));
  assert.equal(updated.status, 'invalidated'); assert.equal(updated.result.delta.repetitions, -3);
  corrected.revision++; corrected.sets[0].status = 'voided';
  assert.equal(revalidateComparison(result.evidenceToken, a, observe(corrected)).status, 'invalidated');
  assert.equal(revalidateComparison(result.evidenceToken, a, sessionObservation('account-a', original, 'occurrence')).result.status, 'unknown');
});

test('same observation is never counted as an independent comparison', () => {
  const [a] = pair(); assert.deepEqual(compareWork(a, a).reasons, ['same_observation']);
});

test('reader uses actual session port in one caller-owned snapshot, fresh on every call, and propagates denied/deleted reads', () => {
  let active = false, allowed = true, reads = 0;
  const sessions = { a: session('a'), b: session('b') };
  const reader = createProgressComparisonReader({
    withReadSnapshot(context, run) { assert.equal(context.accountId, 'account-a'); if (!allowed) throw Error('denied'); active = true; try { return run(); } finally { active = false; } },
    domain: { session(accountId, id) { assert.equal(accountId, 'account-a'); assert.equal(active, true); reads++; if (!sessions[id]) throw Error('not_found'); return sessions[id]; } },
    identityFor(source) { assert.equal(active, true); return { source, revision: 1, confirmed: true, identity }; },
  });
  const context = { accountId: 'account-a', authUserId: 'auth', sessionId: 'login', epoch: 0 };
  const select = sessionId => ({ sessionId, occurrenceId: 'occurrence' });
  const first = reader.compare(context, select('a'), select('b'));
  assert.equal(first.result.status, 'comparable'); assert.equal(first.freshness, 'unchecked');
  sessions.b.revision++; sessions.b.sets[0].reps = 10;
  assert.equal(reader.compare(context, select('a'), select('b'), first.result.evidenceToken).freshness, 'invalidated');
  assert.equal(reads, 4); allowed = false;
  assert.throws(() => reader.compare(context, select('a'), select('b')), /denied/);
  allowed = true; delete sessions.b;
  assert.throws(() => reader.compare(context, select('a'), select('b')), /not_found/);
});

test('source repetition and practice observations retain reported work and unknown load without target promotion', () => {
  const a = session(), b = session('source-b');
  const source = { id: 'reported', occurrenceId: 'occurrence', setNumber: 1, revision: 1, status: 'confirmed',
    schema: 'form.source-performed-set/v1', performance: { schema: 'form.source-performance/v1', kind: 'repetitions', reps: 3,
      load: { kind: 'unspecified', basis: 'unknown' } } };
  b.sets = [source, { ...source, id: 'draft', status: 'draft' }, { ...source, id: 'voided', status: 'voided' },
    { ...source, id: 'foreign-occurrence', occurrenceId: 'foreign' }];
  const raw = sessionObservation('account-a', b, 'occurrence');
  assert.deepEqual(raw.sets, [{ id: 'reported', repetitions: 3, load: { state: 'unknown', confirmed: true } }]);
  assert.deepEqual(compareWork(observe(a), raw).reasons, ['identity_unknown']);
  const bound = observe(b);
  assert.deepEqual(bound.sets, raw.sets);
  const repetitionResult = compareWork(observe(a), bound);
  assert.deepEqual(repetitionResult.reasons, ['load_unknown']);
  assert.equal('current' in repetitionResult, false);
  b.sets = [{ ...source, performance: { schema: 'form.source-performance/v1', kind: 'controlled-practice', load: source.performance.load } }];
  const practiced = observe(b);
  assert.deepEqual(practiced.sets, [{ id: 'reported', repetitions: undefined, load: { state: 'unknown', confirmed: true } }]);
  assert.deepEqual(compareWork(observe(a), practiced).reasons, ['repetitions_unknown']);
});

test('source reported repetitions and source revision change evidence while legacy observation shape stays exact', () => {
  const a = observe(session()), b = session('source-b');
  assert.deepEqual(a.sets, [{ id: 'set', repetitions: 8, load: { state: 'knownValue', value: 10, unit: 'kg', basis: 'perSide' } }]);
  b.sets = [{ id: 'source', occurrenceId: 'occurrence', setNumber: 1, revision: 1, status: 'confirmed', schema: 'form.source-performed-set/v1',
    performance: { schema: 'form.source-performance/v1', kind: 'repetitions', reps: 4, load: { kind: 'unspecified', basis: 'unknown' } } }];
  const first = compareWork(a, observe(b));
  b.sets[0].performance.reps = 5;
  const changedReps = compareWork(a, observe(b));
  b.revision++;
  const changedRevision = compareWork(a, observe(b));
  assert.notEqual(first.evidenceToken, changedReps.evidenceToken);
  assert.notEqual(changedReps.evidenceToken, changedRevision.evidenceToken);
  assert.equal(compareWork(a, observe(session('session-b'))).policy, 'confirmed-work-comparison-v1');
  assert.deepEqual(compareWork(a, observe(session('session-b'))), compareWork(observe(session()), observe(session('session-b'))));
});

function reportedSession(id, load, kind = 'repetitions') {
  const value = session(id);
  value.sets = [{ id: 'reported', occurrenceId: 'occurrence', setNumber: 1, revision: 1, status: 'confirmed',
    schema: 'form.source-performed-set/v2', performance: { schema: 'form.source-performance/v2', kind,
      ...(kind === 'repetitions' ? { reps: 8 } : {}), load } }];
  return value;
}

test('source v2 preserves explicit loads, units and bases without identity or target promotion', () => {
  for (const basis of ['total', 'perImplement', 'perSide', 'assistance']) {
    const load = { state: 'knownValue', value: 10, unit: 'kg', basis };
    const a = reportedSession('a', load), b = reportedSession('b', { ...load, value: 10 / 0.45359237, unit: 'lb' });
    b.sets.push({ ...b.sets[0], id: 'draft', status: 'draft' }, { ...b.sets[0], id: 'void', status: 'voided' });
    const raw = sessionObservation('account-a', a, 'occurrence');
    assert.deepEqual(raw.sets, [{ id: 'reported', repetitions: 8, load }]);
    assert.deepEqual(compareWork(raw, observe(b, { loadBasis: basis })).reasons, ['identity_unknown']);
    const result = compareWork(observe(a, { loadBasis: basis }), observe(b, { loadBasis: basis }));
    assert.equal(result.status, 'comparable');
    assert.equal(result.current.confirmedSets, 1);
    assert.ok(Math.abs(result.delta.volumeKgRepetitions) < 1e-10);
    assert.deepEqual(compareWork(observe(a, { loadBasis: basis }), observe(b, { loadBasis: basis === 'total' ? 'perSide' : 'total' })).reasons,
      ['load_basis_mismatch']);
  }
});

test('source v2 zero, unknown, non-applicable reasons and practice repetitions retain their meaning', () => {
  const zero = { state: 'knownValue', value: 0, unit: 'kg', basis: 'perSide' };
  const a = observe(reportedSession('a', zero));
  assert.equal(compareWork(a, observe(reportedSession('b', zero))).current.volumeKgRepetitions, 0);
  assert.deepEqual(compareWork(a, observe(reportedSession('b', { state: 'unknown', confirmed: true }))).reasons, ['load_unknown']);
  for (const reason of ['bodyweight', 'unloaded', 'timedActivity']) {
    const load = { state: 'notApplicable', reason };
    const result = compareWork(observe(reportedSession('a', load)), observe(reportedSession('b', load)));
    assert.equal(result.status, 'comparable'); assert.equal(result.current.volumeKgRepetitions, null);
    assert.deepEqual(compareWork(a, observe(reportedSession('b', load))).reasons, ['load_meaning_mismatch']);
    assert.deepEqual(compareWork(a, observe(reportedSession('b', load, 'controlled-practice'))).reasons, ['repetitions_unknown']);
  }
  assert.deepEqual(compareWork(observe(reportedSession('a', { state: 'notApplicable', reason: 'bodyweight' })),
    observe(reportedSession('b', { state: 'notApplicable', reason: 'unloaded' }))).reasons, ['load_meaning_mismatch']);
});
