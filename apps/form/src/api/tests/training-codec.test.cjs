const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
function load(file, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../' + file + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(imports, name), 'Unexpected runtime dependency: ' + name);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const transport = load('transport');
const codec = load('trainingCodec', { './transport': transport });
const { decodePlan, decodeWorkoutSession, decodePerformedSet, decodeSetReceipt, decodeHistory, decodeStats } = codec;
const clone = value => JSON.parse(JSON.stringify(value));
const date = '2026-10-11T12:00:00.000Z';
const unknown = error => error instanceof transport.ApiError && error.code === 'training_response_invalid' && error.effectUnknown;
function sourceItem(i, practice = false) {
  return {
    id: 'item_' + i,
    native: { exercise_id: 'native_' + i, movement_pattern: ' hinge ', role: 'primary', sets: 2, rest_seconds: 90,
      ...(!practice ? { rep_range: [6, 10], target_rir: 2 } : {}), notes: [' first ', '', 'first'], substituted_for: 'old_' + i },
    registeredDomain: { exerciseId: 'domain_' + i, variantId: 'variant:' + i,
      identity: { repository: 'owner/catalog', revision: 'native-revision', path: 'exercises/' + i + '.json', sha256: 'a'.repeat(64), nativeId: 'native_' + i },
      registration: { id: 'registration', revision: 'v1', digest: 'b'.repeat(64), bytes: 512 }, recordDigest: 'c'.repeat(64) },
    load: { kind: 'unspecified', basis: 'unknown' },
  };
}
function sourcePlan() {
  return { schema: 'form.source-prescription-plan/v1', id: 'plan_source', revision: 7, name: 'Source plan', archived: false,
    createdAt: date, updatedAt: date, origin: { kind: 'form-adaptation', id: 'operational-four', revision: 'adaptation-1' },
    duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 },
    items: Array.from({ length: 4 }, (_, i) => sourceItem(i, i === 3)) };
}
function legacyPlan() {
  return { id: 'plan_legacy', revision: 2, name: 'Legacy plan', archived: false, createdAt: date, updatedAt: date,
    minutes: 30, items: [{ id: 'legacy_item', exerciseId: 'legacy_exercise', setTarget: 2, repMin: 6, repMax: 10, targetKg: 12.5 }] };
}
function savedSet(i, occurrenceId, source, practice = false) {
  return { id: 'set_' + i, occurrenceId, setNumber: i % 2 + 1, revision: 1, status: 'confirmed', createdAt: date, updatedAt: date,
    ...(source ? { schema: 'form.source-performed-set/v1', performance: { schema: 'form.source-performance/v1',
      kind: practice ? 'controlled-practice' : 'repetitions', ...(!practice ? { reps: 8 } : {}), load: { kind: 'unspecified', basis: 'unknown' } } } : { reps: 8, weightKg: 12.5 }) };
}
function session(source = true) {
  const planSnapshot = source ? sourcePlan() : legacyPlan();
  const occurrences = planSnapshot.items.map((item, position) => ({ id: 'occ_' + position, itemId: item.id,
    exerciseId: source ? item.registeredDomain.exerciseId : item.exerciseId, position, target: clone(item) }));
  return { id: source ? 'session_source' : 'session_legacy', planId: planSnapshot.id, planRevision: planSnapshot.revision,
    revision: 10, status: 'completed', planSnapshot, startedAt: date, completedAt: '2026-10-11T12:30:00.000Z', occurrences,
    sets: occurrences.flatMap((occurrence, i) => [0, 1].map(j => savedSet(i * 2 + j, occurrence.id, source, i === 3))) };
}
function sourceStats(practice = true) {
  const byExercise = Array.from({ length: 4 }, (_, i) => ({ exerciseId: 'domain_' + i, confirmedSets: 2,
    repetitions: practice && i === 3 ? null : 16, volumeKg: null, maxWeightKg: null,
    coverage: { repetitionSets: practice && i === 3 ? 0 : 2, loadSets: 0, practiceSets: practice && i === 3 ? 2 : 0 } }));
  return { confirmedSets: 8, repetitions: practice ? null : 64, volumeKg: null, maxWeightKg: null,
    coverage: { repetitionSets: practice ? 6 : 8, loadSets: 0, practiceSets: practice ? 2 : 0 }, completedSessions: 1, byExercise,
    units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true };
}
function legacyStats() {
  return { confirmedSets: 2, repetitions: 16, volumeKg: 200, completedSessions: 1,
    byExercise: [{ exerciseId: 'legacy_exercise', confirmedSets: 2, repetitions: 16, volumeKg: 200, maxWeightKg: 12.5 }],
    units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true };
}
function rejectsMutations(make, decode, mutations) {
  for (const mutate of mutations) { const value = make(); mutate(value); assert.throws(() => decode(value), unknown, String(mutate)); }
}

test('source plan roundtrip retains every native optional, association pin, range and unknown load', () => {
  const value = sourcePlan(), result = decodePlan(value);
  assert.deepEqual(result, value);
  assert.notEqual(result, value); assert.notEqual(result.items[0].native.notes, value.items[0].native.notes);
  assert.notEqual(result.items[0].registeredDomain.identity, value.items[0].registeredDomain.identity);
  assert.notEqual(result.items[0].native.exercise_id, result.items[0].registeredDomain.exerciseId);
  assert.equal(Object.hasOwn(result, 'minutes'), false);
  value.items[0].native.notes[0] = 'changed'; value.items[0].registeredDomain.registration.bytes++;
  assert.equal(result.items[0].native.notes[0], ' first '); assert.equal(result.items[0].registeredDomain.registration.bytes, 512);
});
test('four source occurrences and eight source sets retain two quantity-free practice observations', () => {
  const value = session(), result = decodeWorkoutSession(value);
  assert.deepEqual(result, value); assert.equal(result.occurrences.length, 4); assert.equal(result.sets.length, 8);
  assert.equal(result.sets.filter(set => set.performance.kind === 'controlled-practice').length, 2);
  assert.equal(result.planSnapshot.revision, 7); assert.equal(result.planSnapshot.createdAt, date);
  for (const set of result.sets) { assert.equal(Object.hasOwn(set, 'reps'), false); assert.equal(Object.hasOwn(set, 'weightKg'), false); }
  for (const set of result.sets.slice(6)) assert.equal(Object.hasOwn(set.performance, 'reps'), false);
});
test('saved source receipt and individual readback are detached and preserve actual repetitions', () => {
  const set = session().sets[0]; set.performance.reps = 3;
  const receipt = { set, sessionRevision: 11 }, decoded = decodeSetReceipt(receipt);
  assert.deepEqual(decoded, receipt); assert.deepEqual(decodePerformedSet(set), set);
  receipt.set.performance.reps = 99;
  assert.equal(decoded.set.performance.reps, 3);
  assert.equal(decoded.sessionRevision, 11);
});
test('legacy plan, full session snapshot, set receipt, history and statistics retain their original wire shape', () => {
  const value = session(false), receipt = { set: value.sets[0], sessionRevision: 12 };
  assert.deepEqual(decodePlan(legacyPlan()), legacyPlan()); assert.deepEqual(decodeWorkoutSession(value), value);
  assert.deepEqual(decodePerformedSet(value.sets[0]), value.sets[0]); assert.deepEqual(decodeSetReceipt(receipt), receipt);
  assert.deepEqual(decodeHistory({ items: [value], nextBefore: null }), { items: [value], nextBefore: null });
  assert.deepEqual(decodeStats(legacyStats()), legacyStats());
  assert.equal(Object.hasOwn(decodeStats(legacyStats()), 'coverage'), false);
});
test('history preserves mixed source and legacy sessions and opaque pagination without projecting metadata', () => {
  const value = { items: [session(), session(false)], nextBefore: 'eyJpZCI6InBhZ2UifQ' };
  assert.deepEqual(decodeHistory(value), value);
  rejectsMutations(() => clone(value), decodeHistory, [v => { v.items.push(v.items[0]); }, v => { v.nextBefore = '../cursor'; },
    v => { v.items[0].planSnapshot.updatedAt = null; }, v => { v.extra = true; }]);
});
test('native optional omission remains omitted and explicit undefined or null is rejected', () => {
  const keys = ['rep_range', 'target_rir', 'substituted_for', 'notes'];
  const value = sourcePlan(); for (const key of keys) delete value.items[0].native[key];
  const parsed = decodePlan(value); for (const key of keys) assert.equal(Object.hasOwn(parsed.items[0].native, key), false);
  for (const key of keys) for (const invalid of [undefined, null]) {
    const bad = sourcePlan(); bad.items[0].native[key] = invalid; assert.throws(() => decodePlan(bad), unknown);
  }
  rejectsMutations(sourcePlan, decodePlan, [v => { v.items[0].native.notes = []; }, v => { v.items[0].native.notes = ['ok', 2]; }]);
});
test('native bounds admit wire endpoints without coercion or normalization', () => {
  for (const upper of [false, true]) {
    const value = sourcePlan(), native = value.items[0].native;
    Object.assign(native, { sets: upper ? 20 : 1, rest_seconds: upper ? 10800 : 0, target_rir: upper ? 100 : 0,
      rep_range: upper ? [100, 100] : [1, 1], movement_pattern: ' x ', role: ' custom role ', notes: ['', ' ', 'repeat', 'repeat'] });
    value.duration = { kind: 'estimated-range', minMinutes: upper ? 180 : 5, maxMinutes: upper ? 180 : 5 };
    assert.deepEqual(decodePlan(value), value);
  }
  for (const [key, invalids] of Object.entries({ sets: [0, 21, 1.5, NaN, Infinity, '2'], rest_seconds: [-1, 10801, 0.5],
    target_rir: [-1, 101, 0.5], rep_range: [[0, 1], [1, 101], [2, 1], [1], [1, 2, 3], [1.5, 2]],
    movement_pattern: ['', ' ', 'x'.repeat(201)], role: ['', ' ', 'x'.repeat(201)] })) {
    for (const invalid of invalids) { const value = sourcePlan(); value.items[0].native[key] = invalid; assert.throws(() => decodePlan(value), unknown); }
  }
});
test('exact source references and lower-case digests reject rewriting and unrelated native identities', () => {
  rejectsMutations(sourcePlan, decodePlan, [v => { v.origin.id = ' padded '; }, v => { v.origin.revision = 'bad\nrevision'; },
    v => { v.items[0].registeredDomain.variantId = ''; }, v => { v.items[0].registeredDomain.identity.path = 'bad\u007fpath'; },
    v => { v.items[0].registeredDomain.identity.sha256 = 'A'.repeat(64); }, v => { v.items[0].registeredDomain.recordDigest = 'short'; },
    v => { v.items[0].registeredDomain.registration.digest = 'z'.repeat(64); }, v => { v.items[0].registeredDomain.registration.bytes = 0; },
    v => { v.items[0].registeredDomain.registration.bytes = 1.5; }, v => { v.items[0].registeredDomain.registration.bytes = Number.MAX_SAFE_INTEGER + 1; },
    v => { v.items[0].registeredDomain.identity.nativeId = 'unrelated'; }, v => { v.items[0].registeredDomain.exerciseId = '../bad'; }]);
});
test('closed plan objects reject mixed formats and metadata or range corruption', () => {
  rejectsMutations(sourcePlan, decodePlan, [v => { v.minutes = 20; }, v => { v.schema = 'unknown'; }, v => { delete v.origin; },
    v => { v.duration.minMinutes = 26; }, v => { v.duration.maxMinutes = 181; }, v => { v.items[0].targetKg = 0; },
    v => { v.items[0].load = { kind: 'specified', kg: 0 }; }, v => { v.items[0].native.extra = true; },
    v => { v.items[0].registeredDomain.extra = true; }, v => { v.items[0].registeredDomain.identity.extra = true; },
    v => { v.items[0].registeredDomain.registration.extra = true; }, v => { v.items[0].load.kg = 0; },
    v => { v.items.push(clone(v.items[0])); }, v => { v.items = []; }, v => { v.archived = null; },
    v => { v.revision = -1; }, v => { v.createdAt = '2026-02-30T00:00:00Z'; }, v => { delete v.updatedAt; }]);
  rejectsMutations(legacyPlan, decodePlan, [v => { v.origin = sourcePlan().origin; }, v => { v.items[0] = sourceItem(0); },
    v => { v.items[0].repMax = 1; }, v => { v.items[0].targetKg = NaN; }]);
});
test('session snapshots must identify the exact saved plan revision and retain complete metadata', () => {
  rejectsMutations(session, decodeWorkoutSession, [v => { v.planId = 'another'; }, v => { v.planRevision++; },
    v => { delete v.planSnapshot.id; }, v => { delete v.planSnapshot.archived; }, v => { delete v.planSnapshot.createdAt; },
    v => { v.status = 'active'; }, v => { v.completedAt = null; }, v => { v.startedAt = 'yesterday'; }]);
  const active = session(); active.status = 'active'; active.completedAt = null;
  assert.deepEqual(decodeWorkoutSession(active), active);
});
test('occurrences require exact snapshot targets, ordered positions and registered Domain exercise identities', () => {
  rejectsMutations(session, decodeWorkoutSession, [v => { v.occurrences[0].exerciseId = 'native_0'; },
    v => { v.occurrences[0].target.native.notes.reverse(); }, v => { v.occurrences[0].target.native.rest_seconds++; },
    v => { v.occurrences[0].target.registeredDomain.registration.revision = 'other'; },
    v => { v.occurrences[0].target.registeredDomain.recordDigest = 'd'.repeat(64); },
    v => { v.occurrences[0].target.native.target_rir++; }, v => { v.occurrences[0].itemId = 'other'; },
    v => { v.occurrences[0].position = 1; }, v => { v.occurrences.reverse(); }, v => { v.occurrences.pop(); },
    v => { v.occurrences[1].id = v.occurrences[0].id; }, v => { v.occurrences[0].target = legacyPlan().items[0]; }]);
});
test('session sets must match occurrence format and repetition or practice target without invented quantities', () => {
  rejectsMutations(session, decodeWorkoutSession, [v => { v.sets[0].occurrenceId = 'missing'; },
    v => { v.sets[0].occurrenceId = 'occ_3'; }, v => { v.sets[6].occurrenceId = 'occ_0'; },
    v => { v.sets[0] = savedSet(0, 'occ_0', false); }, v => { v.sets[0].reps = 8; },
    v => { v.sets[0].weightKg = 0; }, v => { v.sets[6].performance.reps = 0; },
    v => { v.sets[0].performance.load.kg = 0; }, v => { v.sets[1].id = v.sets[0].id; },
    v => { v.sets[1].setNumber = v.sets[0].setNumber; }]);
  rejectsMutations(() => session(false), decodeWorkoutSession, [v => { v.sets[0] = savedSet(0, 'occ_0', true); },
    v => { v.occurrences[0].target.targetKg++; }]);
});
test('source performance accepts zero only outside confirmed repetition status and never numeric practice', () => {
  for (const status of ['draft', 'voided']) {
    const value = session().sets[0]; value.status = status; value.performance.reps = 0;
    assert.deepEqual(decodePerformedSet(value), value);
  }
  rejectsMutations(() => session().sets[0], decodePerformedSet, [v => { v.performance.reps = 0; },
    v => { v.performance.reps = -1; }, v => { v.performance.reps = 101; }, v => { v.performance.reps = 1.5; },
    v => { v.performance.schema = 'other'; }, v => { v.performance.kind = 'seconds'; }, v => { v.performance.load = null; },
    v => { v.status = 'saved'; }, v => { v.setNumber = 101; }]);
  rejectsMutations(() => session().sets[6], decodePerformedSet, [v => { v.performance.reps = null; }, v => { v.performance.seconds = 30; }]);
});
test('source statistics preserve unknown totals and exact coverage for mixed and all-repetition observations', () => {
  for (const practice of [true, false]) assert.deepEqual(decodeStats(sourceStats(practice)), sourceStats(practice));
  const mixed = sourceStats(); mixed.confirmedSets += 2; mixed.coverage.repetitionSets += 2; mixed.coverage.loadSets += 2;
  mixed.byExercise.push(legacyStats().byExercise[0]);
  assert.deepEqual(decodeStats(mixed), mixed);
  const sharedExercise = sourceStats(false); sharedExercise.confirmedSets++; sharedExercise.repetitions += 5;
  sharedExercise.coverage.repetitionSets++; sharedExercise.coverage.loadSets++;
  sharedExercise.byExercise[0].confirmedSets++; sharedExercise.byExercise[0].repetitions += 5;
  sharedExercise.byExercise[0].coverage.repetitionSets++; sharedExercise.byExercise[0].coverage.loadSets++;
  assert.deepEqual(decodeStats(sharedExercise), sharedExercise);
  const empty = { ...legacyStats(), confirmedSets: 0, repetitions: 0, volumeKg: 0, completedSessions: 0, byExercise: [] };
  assert.deepEqual(decodeStats(empty), empty);
});
test('statistics reject fabricated zero load or repetitions and inconsistent coverage at either level', () => {
  rejectsMutations(sourceStats, decodeStats, [v => { v.repetitions = 48; }, v => { v.volumeKg = 0; },
    v => { v.maxWeightKg = 0; }, v => { delete v.maxWeightKg; }, v => { delete v.coverage; },
    v => { v.coverage.practiceSets = 0; }, v => { v.coverage.loadSets = 8; }, v => { v.coverage.loadSets = 1; },
    v => { v.coverage.repetitionSets = 6.5; }, v => { v.coverage.extra = 0; }, v => { v.byExercise[3].repetitions = 0; },
    v => { v.byExercise[0].volumeKg = 0; }, v => { v.byExercise[0].coverage.loadSets = 2; },
    v => { delete v.byExercise[0].coverage; }, v => { v.byExercise[0].maxWeightKg = 0; },
    v => { v.byExercise[1].exerciseId = v.byExercise[0].exerciseId; }, v => { v.byExercise.pop(); },
    v => { v.units.volume = 'kg'; }, v => { v.includesActiveConfirmedSets = false; }]);
  rejectsMutations(() => sourceStats(false), decodeStats, [v => { v.repetitions = null; }, v => { v.repetitions = 63; }]);
  rejectsMutations(legacyStats, decodeStats, [v => { v.coverage = null; }, v => { v.repetitions = null; },
    v => { v.maxWeightKg = 12.5; }, v => { v.byExercise[0].volumeKg = Infinity; }]);
});
test('accessor input at root, optional, nested pin and array index is rejected with zero getter calls', () => {
  let calls = 0;
  const getter = () => { calls++; throw Error('getter must not execute'); };
  for (const [make, decode, locate, key] of [
    [sourcePlan, decodePlan, v => v, 'schema'], [sourcePlan, decodePlan, v => v.items[0].native, 'notes'],
    [sourcePlan, decodePlan, v => v.items[0].registeredDomain.registration, 'bytes'],
    [sourcePlan, decodePlan, v => v.items, '0'], [session, decodeWorkoutSession, v => v.sets[0].performance, 'reps'],
    [sourceStats, decodeStats, v => v.coverage, 'loadSets'],
  ]) {
    const value = make(); Object.defineProperty(locate(value), key, { get: getter, enumerable: true });
    assert.throws(() => decode(value), unknown);
  }
  assert.equal(calls, 0);
});
test('hostile prototypes, symbols, hidden fields, sparse arrays and cyclic data fail closed', () => {
  rejectsMutations(sourcePlan, decodePlan, [v => { Object.setPrototypeOf(v.items[0].native, { inherited: true }); },
    v => { v[Symbol('extra')] = true; }, v => { Object.defineProperty(v, 'hidden', { value: 1 }); },
    v => { delete v.items[1]; }, v => { v.items.extra = true; }, v => { v.items[0].native.notes = v.items; },
    v => { v.items[0].native.notes[0] = () => 'note'; }]);
  const value = sourcePlan(); Object.setPrototypeOf(value, null);
  assert.deepEqual(decodePlan(value), sourcePlan());
});
test('malformed write receipts stay effect-unknown and expose no retry or replacement command', () => {
  rejectsMutations(() => ({ set: session().sets[0], sessionRevision: 11 }), decodeSetReceipt, [v => { v.sessionRevision = -1; },
    v => { delete v.set; }, v => { v.set.performance.reps = null; }, v => { v.retry = true; }]);
  assert.deepEqual(Object.keys(codec).sort(), ['decodeHistory', 'decodePerformedSet', 'decodePlan', 'decodeSetReceipt', 'decodeSourcePerformance', 'decodeStats', 'decodeWorkoutSession'].sort());
  for (const decode of Object.values(codec)) for (const value of [null, [], undefined, 1, 'response']) assert.throws(() => decode(value), unknown);
});
