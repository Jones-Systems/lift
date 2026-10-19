const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');
function portable(file, imports = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(resolve(__dirname, '../../../api/' + file + '.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', source)(name => {
    assert.ok(Object.hasOwn(imports, name), 'Unexpected portable dependency: ' + name);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const transport = portable('transport');
const codec = portable('trainingCodec', { './transport': transport });
const moduleValue = { exports: {} };
const code = ts.transpileModule(readFileSync(resolve(__dirname, '../model.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
new Function('require', 'module', 'exports', code)(name => {
  if (name === '../../api/client') return { ApiError: transport.ApiError };
  if (name === '../cues/CuesScreen') return { normalizeCues: () => { throw new Error('Not used by source model'); } };
  throw new Error(`Unexpected import: ${name}`);
}, moduleValue, moduleValue.exports);
const m = moduleValue.exports;
const load = () => ({ kind: 'unspecified', basis: 'unknown' });
const performance = (reps) => reps === undefined
  ? { schema: 'form.source-performance/v1', kind: 'controlled-practice', load: load() }
  : { schema: 'form.source-performance/v1', kind: 'repetitions', reps, load: load() };
const set = (id, reps, overrides = {}) => ({ schema: 'form.source-performed-set/v1', id,
  occurrenceId: 'occurrence-1', setNumber: Number(id.slice(-1)), revision: 1, status: 'confirmed',
  performance: performance(reps), createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', ...overrides });
const item = (id, sets = 2) => ({ id, native: { exercise_id: 'native-' + id, movement_pattern: 'source-pattern',
  role: 'source-role', sets, rest_seconds: 45, target_rir: 2, notes: ['keep source order', 'second'] },
  registeredDomain: { exerciseId: 'exercise-' + id, variantId: 'variant-' + id,
    identity: { repository: 'synthetic/source', revision: 'source-v1', path: 'catalog.json', sha256: 'a'.repeat(64), nativeId: 'native-' + id },
    registration: { id: 'registration', revision: 'v1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) }, load: load() });
const session = (sets = [], items = [item('one')]) => ({ id: 'session-1', revision: 4, status: 'active',
  planId: 'plan-1', planRevision: 2, planSnapshot: { schema: 'form.source-prescription-plan/v1', id: 'plan-1', revision: 2,
    name: 'Source plan', origin: { kind: 'form-adaptation', id: 'recipe', revision: 'v1' },
    duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 }, items,
    archived: false, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' },
  occurrences: items.map((target, i) => ({ id: `occurrence-${i + 1}`, itemId: target.id,
    exerciseId: target.registeredDomain.exerciseId, position: i, target })), sets,
  startedAt: '2026-10-11T00:00:00Z', completedAt: null });

test('six repetitions and two practice sets preserve coverage without fabricated total repetitions or volume', () => {
  const sets = Array.from({ length: 8 }, (_, i) => set(`set-${i + 1}`, i < 6 ? 8 : undefined,
    { occurrenceId: `occurrence-${Math.floor(i / 2) + 1}`, setNumber: i % 2 + 1 }));
  const value = session(sets, ['one', 'two', 'three', 'four'].map(id => item(id)));
  assert.deepEqual(m.sessionTotals(value), { confirmedSets: 8, repetitions: null, volumeKg: null,
    coverage: { repetitionSets: 6, loadSets: 0, practiceSets: 2 } });
  assert.equal(m.plannedSets(value), 8);
  assert.ok(sets.every(s => !Object.hasOwn(s, 'reps') && !Object.hasOwn(s, 'weightKg')));
});

test('known repetitions remain known while unknown load prevents a numeric volume claim', () => {
  assert.deepEqual(m.sessionTotals(session([set('set-1', 8), set('set-2', 12)])), {
    confirmedSets: 2, repetitions: 20, volumeKg: null, coverage: { repetitionSets: 2, loadSets: 0, practiceSets: 0 } });
});

test('draft and voided practice do not enter confirmed totals; an empty session does not invent performed work', () => {
  const value = session([set('set-1', undefined, { status: 'draft' }), set('set-2', undefined, { status: 'voided' })]);
  assert.deepEqual(m.sessionTotals(value), { confirmedSets: 0, repetitions: 0, volumeKg: 0,
    coverage: { repetitionSets: 0, loadSets: 0, practiceSets: 0 } });
  assert.deepEqual(m.sessionTotals(session([set('set-3')])), { confirmedSets: 1, repetitions: null, volumeKg: null,
    coverage: { repetitionSets: 0, loadSets: 0, practiceSets: 1 } });
});

test('source occurrence ordering preserves the full native target and its registered provenance', () => {
  const value = session([], [item('one', 3), item('two', 4)]);
  value.occurrences.reverse();
  const before = structuredClone(value);
  const sorted = m.orderedOccurrences(value);
  assert.equal(m.plannedSets(value), 7);
  assert.equal(sorted[0].target, value.planSnapshot.items[0]);
  assert.deepEqual(sorted[0].target.native.notes, ['keep source order', 'second']);
  assert.equal(sorted[0].target.native.target_rir, 2);
  assert.deepEqual(value, before);
});

test('source numbering skips voided and queued numbers without mutating the loaded order', () => {
  const value = session([set('set-3', undefined, { status: 'voided' }), set('set-1', 5)]);
  const queued = [{ ...set('set-4', 6), setNumber: 4 }, { ...set('set-9', 8), occurrenceId: 'another' }];
  assert.deepEqual(m.setsOf(value, 'occurrence-1').map(s => s.setNumber), [1, 3]);
  assert.equal(m.nextSetNumber(value, 'occurrence-1', queued), 5);
  assert.deepEqual(value.sets.map(s => s.setNumber), [3, 1]);
});

test('source draft and correction snapshots detach and freeze both nested performance branches', () => {
  for (const reps of [undefined, 8]) {
    const original = { schema: 'form.source-performed-set/v1', occurrenceId: 'occurrence-1', setNumber: 1,
      status: 'confirmed', performance: performance(reps) };
    const draft = m.freezeSetDraft(original), changes = m.freezeSetChanges({ schema: original.schema,
      status: original.status, performance: original.performance });
    original.status = 'draft'; original.performance.load.basis = 'changed';
    if (reps !== undefined) original.performance.reps = 99;
    for (const captured of [draft, changes]) {
      assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.performance) && Object.isFrozen(captured.performance.load));
      assert.equal(captured.status, 'confirmed'); assert.equal(captured.performance.load.basis, 'unknown');
      assert.deepEqual(captured.performance, performance(reps));
      assert.equal(Object.hasOwn(captured, 'weightKg'), false);
      assert.equal(Object.hasOwn(captured.performance, 'target_rir'), false);
    }
  }
});

test('source acknowledgement value matching checks format, performance kind, value, load and exact status', () => {
  const intended = { schema: 'form.source-performed-set/v1', status: 'confirmed', performance: performance() };
  assert.equal(m.setValuesMatch(set('set-1'), intended), true);
  const variants = [set('set-1', 8), set('set-1', undefined, { status: 'draft' }),
    set('set-1', undefined, { schema: 'other' }), { id: 'set-1', status: 'confirmed' },
    set('set-1', undefined, { performance: { ...performance(), schema: 'other' } }),
    set('set-1', undefined, { performance: { ...performance(), load: { kind: 'unspecified', basis: 'invented' } } })];
  for (const value of variants) assert.equal(m.setValuesMatch(value, intended), false);
  const repetitions = { ...intended, performance: performance(8) };
  assert.equal(m.setValuesMatch(set('set-1', 9), repetitions), false);
  assert.equal(m.setValuesMatch(set('set-1', 8), repetitions), true);
  assert.equal(m.setValuesMatch({ status: 'confirmed' }, { status: 'confirmed' }), false,
    'Two missing legacy numeric fields never acknowledge a write');
});

test('legacy numeric zero and legacy totals retain their original meaning and shape', () => {
  const confirmed = { id: 'legacy', occurrenceId: 'occurrence-1', setNumber: 1, revision: 1,
    status: 'confirmed', reps: 8, weightKg: 0 };
  const value = { ...session(), planSnapshot: { name: 'Legacy', minutes: 10, items: [] },
    occurrences: [{ id: 'occurrence-1', position: 0, target: { setTarget: 3 } }], sets: [confirmed] };
  assert.deepEqual(m.sessionTotals(value), { confirmedSets: 1, repetitions: 8, volumeKg: 0 });
  assert.equal(m.plannedSets(value), 3);
  assert.equal(m.setValuesMatch(confirmed, { status: 'confirmed', reps: 8, weightKg: 0 }), true);
  const input = { occurrenceId: 'occurrence-1', setNumber: 2, status: 'draft', reps: 0, weightKg: 0 };
  const frozen = m.freezeSetDraft(input); input.reps = 9;
  assert.equal(frozen.reps, 0); assert.ok(Object.isFrozen(frozen));
});

function sourceWire(id = 'source-active') {
  const items = ['one', 'two', 'three', 'four'].map(name => item(name));
  items.slice(0, 3).forEach(target => { target.native.rep_range = [6, 10]; });
  items[0].native.substituted_for = 'native-original';
  items[0].native.notes = ['', '  Original note  ', 'Last note'];
  delete items[1].native.target_rir;
  delete items[1].native.notes;
  const sets = Array.from({ length: 8 }, (_, i) => set(`set-${i + 1}`, i < 6 ? 8 : undefined,
    { occurrenceId: `occurrence-${Math.floor(i / 2) + 1}`, setNumber: i % 2 + 1 }));
  return { ...session(sets, items), id };
}
function legacyWire(id = 'legacy-active') {
  const target = { id: 'legacy-item', exerciseId: 'legacy-exercise', setTarget: 2, repMin: 6, repMax: 10, targetKg: 20 };
  return { id, planId: 'legacy-plan', planRevision: 2, revision: 4, status: 'active',
    planSnapshot: { id: 'legacy-plan', revision: 2, name: 'Legacy saved plan', minutes: 30, items: [target],
      archived: false, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' },
    occurrences: [{ id: 'legacy-occurrence', itemId: target.id, exerciseId: target.exerciseId, position: 0, target }],
    sets: [{ id: 'legacy-set', occurrenceId: 'legacy-occurrence', setNumber: 1, revision: 1, status: 'confirmed',
      reps: 8, weightKg: 20, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' }],
    startedAt: '2026-10-11T00:00:00Z', completedAt: null };
}
function completed(value, startedAt, completedAt) {
  return { ...value, status: 'completed', startedAt, completedAt };
}

test('closed decoded mixed history keeps the exact first active object and complete source target evidence', () => {
  const source = sourceWire(), legacy = legacyWire();
  const history = codec.decodeHistory({ items: [completed(legacy, legacy.startedAt, '2026-10-11T00:11:00Z'), source], nextBefore: 'page_two' });
  const before = structuredClone(history), active = m.activeFrom(history);
  assert.equal(active, history.items[1]);
  assert.notEqual(active, source);
  assert.deepEqual(active.planSnapshot, source.planSnapshot);
  assert.deepEqual(active.occurrences, source.occurrences);
  assert.equal(active.occurrences[0].exerciseId, 'exercise-one');
  assert.notEqual(active.occurrences[0].exerciseId, active.occurrences[0].target.native.exercise_id);
  assert.deepEqual(active.occurrences[0].target.native.notes, ['', '  Original note  ', 'Last note']);
  assert.equal(active.occurrences[0].target.native.substituted_for, 'native-original');
  assert.equal(Object.hasOwn(active.occurrences[1].target.native, 'notes'), false);
  assert.equal(Object.hasOwn(active.occurrences[1].target.native, 'target_rir'), false);
  assert.deepEqual(m.sessionTotals(active), { confirmedSets: 8, repetitions: null, volumeKg: null,
    coverage: { repetitionSets: 6, loadSets: 0, practiceSets: 2 } });
  assert.deepEqual(history, before);
});

test('mixed active selection preserves loaded order without preferring format or manufacturing a session', () => {
  const source = sourceWire(), legacy = legacyWire();
  for (const items of [[source, legacy], [legacy, source]]) {
    const history = codec.decodeHistory({ items, nextBefore: null });
    assert.equal(m.activeFrom(history), history.items[0]);
  }
  const done = codec.decodeHistory({ items: [completed(source, source.startedAt, '2026-10-11T00:01:00Z'),
    completed(legacy, legacy.startedAt, '2026-10-11T00:02:00Z')], nextBefore: null });
  assert.equal(m.activeFrom(done), null);
  assert.equal(m.activeFrom(codec.decodeHistory({ items: [], nextBefore: null })), null);
  assert.equal(m.activeFrom(null), null);
});

test('elapsed source and legacy duration uses only actual timestamps and never the prescription estimate', () => {
  for (const value of [sourceWire(), legacyWire()]) {
    assert.equal(m.sessionMinutes(codec.decodeWorkoutSession(value)), null);
    for (const [end, expected] of [['2026-10-11T00:11:00Z', 11], ['2026-10-11T00:00:00Z', 1],
      ['2026-10-11T00:01:31Z', 2], ['2026-10-10T23:59:59Z', null]]) {
      const decoded = codec.decodeWorkoutSession(completed(value, value.startedAt, end));
      assert.equal(m.sessionMinutes(decoded), expected);
    }
    assert.equal(m.sessionMinutes({ ...value, completedAt: 'not-an-instant' }), null);
  }
  const source = codec.decodeWorkoutSession(completed(sourceWire(), '2026-10-11T00:00:00Z', '2026-10-11T00:11:00Z'));
  source.planSnapshot.duration = { kind: 'estimated-range', minMinutes: 60, maxMinutes: 90 };
  assert.equal(m.sessionMinutes(source), 11);
});

test('mixed completed counts retain week boundaries, loaded-page scope and active exclusion', () => {
  const now = new Date(2026, 10, 11, 12), currentStart = m.weekStart(now).getTime(), previousStart = currentStart - m.WEEK_MS;
  const at = ms => new Date(ms).toISOString();
  const done = (value, finish) => completed(value, at(finish - 600000), at(finish));
  const history = codec.decodeHistory({ items: [
    done(sourceWire('source-current'), currentStart), done(legacyWire('legacy-current'), currentStart + 60000),
    done(sourceWire('source-previous'), currentStart - 1), done(legacyWire('legacy-previous'), previousStart),
    done(sourceWire('outside-window'), previousStart - 1),
    { ...sourceWire('still-active'), startedAt: at(currentStart + 120000) },
  ], nextBefore: 'older_page' });
  const before = structuredClone(history);
  assert.deepEqual(m.completedPerWeek(history.items, now, 2), [
    { start: new Date(previousStart), count: 2 }, { start: new Date(currentStart), count: 2 },
  ]);
  assert.deepEqual(m.completedPerWeek(history.items, now, 0), []);
  assert.deepEqual(history, before);
});

test('mixed history coverage preserves strict oldest-start boundary and complete-page semantics', () => {
  const since = new Date('2026-10-11T00:00:00Z');
  for (const tail of [sourceWire(), legacyWire()]) {
    const page = items => codec.decodeHistory({ items, nextBefore: 'older_page' });
    assert.equal(m.historyCovers(page([tail]), since), false);
    const older = { ...tail, startedAt: '2026-10-10T23:59:59Z' };
    assert.equal(m.historyCovers(page([older]), since), true);
    const first = tail.planId === 'plan-1' ? legacyWire('newer-first') : sourceWire('newer-first');
    assert.equal(m.historyCovers(page([older, first]), since), false);
    assert.equal(m.historyCovers(page([first, older]), since), true);
  }
  assert.equal(m.historyCovers(codec.decodeHistory({ items: [], nextBefore: 'older_page' }), since), false);
  assert.equal(m.historyCovers(codec.decodeHistory({ items: [], nextBefore: null }), since), true);
});

test('closed history decoding rejects mixed targets, missing provenance and invented practice quantities before derivation', () => {
  const mutations = [
    value => { value.occurrences[0].exerciseId = value.occurrences[0].target.native.exercise_id; },
    value => { value.planSnapshot.items[0].registeredDomain.recordDigest = 'invalid'; },
    value => { delete value.planSnapshot.items[0].registeredDomain.registration; },
    value => { value.occurrences[0].target = structuredClone(legacyWire().occurrences[0].target); },
    value => { value.sets[6].performance.reps = 8; },
    value => { value.sets[6].weightKg = 0; },
    value => { value.planSnapshot.items[1].native.notes = undefined; },
    value => { value.planRevision++; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(sourceWire()); mutate(value);
    assert.throws(() => codec.decodeHistory({ items: [legacyWire(), value], nextBefore: null }),
      error => error instanceof transport.ApiError && error.code === 'training_response_invalid');
  }
  const source = sourceWire(); let reads = 0;
  Object.defineProperty(source.occurrences[0].target.native, 'notes', { enumerable: true, get() { reads++; return []; } });
  assert.throws(() => codec.decodeHistory({ items: [source], nextBefore: null }));
  assert.equal(reads, 0);
});

test('execution retains every decoded occurrence in snapshot order and every full target and set identity', () => {
  const wire = session([set('set-3', 8, { status: 'voided' }), set('set-1', 8),
    set('set-2', 8, { status: 'draft' }), set('set-4', undefined, { occurrenceId: 'occurrence-2', setNumber: 1 })],
    [item('one', 3), item('two', 1), item('three', 2)]);
  wire.planSnapshot.items[0].native.rep_range = [6, 10];
  const decoded = codec.decodeWorkoutSession(wire); decoded.occurrences.reverse(); const before = structuredClone(decoded);
  const execution = m.sourceExecution(decoded);
  assert.deepEqual([execution.sessionId, execution.sessionRevision, execution.planId, execution.planRevision],
    ['session-1', 4, 'plan-1', 2]);
  assert.equal(execution.sessionStatus, 'active'); assert.equal(execution.completedAt, null);
  assert.deepEqual(execution.occurrences.map(row => row.occurrence.id), ['occurrence-1', 'occurrence-2', 'occurrence-3']);
  for (const row of execution.occurrences) {
    assert.deepEqual(row.occurrence, decoded.occurrences.find(value => value.id === row.occurrence.id));
    assert.deepEqual(row.occurrence.target, decoded.planSnapshot.items[row.occurrence.position]);
  }
  const first = execution.occurrences[0];
  assert.equal(first.prescribedSets, 3); assert.deepEqual(first.observedCounts, { confirmed: 1, draft: 1, voided: 1 });
  assert.equal(first.confirmedShortfall, 2); assert.equal(first.confirmedExcess, 0);
  assert.deepEqual(first.sets.map(value => value.id), ['set-1', 'set-2', 'set-3']);
  assert.deepEqual(first.sets, m.setsOf(decoded, 'occurrence-1'));
  const practice = execution.occurrences[1].sets[0];
  assert.equal(practice.performance.kind, 'controlled-practice'); assert.equal(Object.hasOwn(practice.performance, 'reps'), false);
  assert.deepEqual(practice.performance.load, load()); assert.equal(Object.hasOwn(practice, 'weightKg'), false);
  assert.deepEqual(decoded, before);
});

test('closed empty and partial sessions retain closure independently of confirmed count coverage', () => {
  for (const sets of [[], [set('set-1', undefined)], [set('set-1', 8, { status: 'draft' }), set('set-2', 8, { status: 'voided' })]]) {
    const wire = session(sets); wire.status = 'completed'; wire.completedAt = '2026-10-11T00:10:00Z';
    if (sets.some(value => value.performance.kind === 'repetitions')) wire.planSnapshot.items[0].native.rep_range = [6, 10];
    const execution = m.sourceExecution(codec.decodeWorkoutSession(wire)), row = execution.occurrences[0];
    assert.equal(execution.sessionStatus, 'completed'); assert.equal(execution.completedAt, wire.completedAt);
    assert.equal(row.observedCounts.confirmed, sets.filter(value => value.status === 'confirmed').length);
    assert.equal(row.confirmedShortfall, 2 - row.observedCounts.confirmed); assert.equal(row.confirmedExcess, 0);
    assert.equal(Object.hasOwn(row, 'completed'), false); assert.equal(Object.hasOwn(row, 'skipped'), false);
    assert.equal(Object.hasOwn(row, 'volumeKg'), false); assert.equal(Object.hasOwn(row, 'failure'), false);
  }
});

test('confirmed count excess remains distinct from draft and voided observation counts', () => {
  const wire = session([set('set-1', 5), set('set-2', 8), set('set-3', 8),
    set('set-4', 10, { status: 'draft' }), set('set-5', 5, { status: 'voided' })], [item('one', 2)]);
  wire.planSnapshot.items[0].native.rep_range = [6, 10];
  const row = m.sourceExecution(codec.decodeWorkoutSession(wire)).occurrences[0];
  assert.deepEqual(row.observedCounts, { confirmed: 3, draft: 1, voided: 1 });
  assert.equal(row.confirmedShortfall, 0); assert.equal(row.confirmedExcess, 1);
});

test('execution is deeply detached and frozen without freezing or mutating the authoritative readback', () => {
  const original = session([set('set-1', 8)]), before = structuredClone(original);
  const execution = m.sourceExecution(original);
  const assertFrozen = value => {
    if (!value || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value)); Object.values(value).forEach(assertFrozen);
  };
  assertFrozen(execution); assert.deepEqual(original, before); assert.equal(Object.isFrozen(original), false);
  original.occurrences[0].target.native.notes[0] = 'Changed'; original.sets[0].performance.reps = 99;
  original.sets[0].performance.load.basis = 'changed'; original.revision = 99;
  assert.equal(execution.occurrences[0].occurrence.target.native.notes[0], 'keep source order');
  assert.equal(execution.occurrences[0].sets[0].performance.reps, 8);
  assert.equal(execution.occurrences[0].sets[0].performance.load.basis, 'unknown'); assert.equal(execution.sessionRevision, 4);
});

test('actual model types preserve legacy precision while accepting decoded mixed history', () => {
  const modelPath = resolve(__dirname, '../model.ts'), domainPath = resolve(__dirname, '../../../api/domain.ts');
  const consumer = resolve(__dirname, 'mixed-history-consumer.ts');
  const clientPath = resolve(__dirname, '../../../api/client.ts'), cuesPath = resolve(__dirname, '../../cues/CuesScreen.ts');
  const files = new Map([
    [modelPath, readFileSync(modelPath, 'utf8')], [domainPath, readFileSync(domainPath, 'utf8')],
    [clientPath, 'export declare class ApiError extends Error { status: number; code: string; effectUnknown: boolean; }'],
    [cuesPath, 'export declare function normalizeCues(value: unknown): { order: string[] };'],
    [consumer, `import { activeFrom, sessionMinutes, completedPerWeek, historyCovers } from '../model';
      import type { History, WorkoutSession, StoredHistory, StoredWorkoutSession } from '../../../api/domain';
      type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
      type Expect<T extends true> = T;
      declare const legacy: History; declare const mixed: StoredHistory;
      declare const either: History | StoredHistory;
      declare const legacySessions: readonly WorkoutSession[];
      declare const storedSessions: readonly StoredWorkoutSession[];
      const oldActive = activeFrom(legacy), newActive = activeFrom(mixed);
      type LegacyPrecision = Expect<Equal<typeof oldActive, WorkoutSession | null>>;
      type StoredPrecision = Expect<Equal<typeof newActive, StoredWorkoutSession | null>>;
      const minutes: number | null = newActive && sessionMinutes(newActive);
      const legacyMinutes: number | null = oldActive && sessionMinutes(oldActive);
      const weeks: { start: Date; count: number }[] = completedPerWeek(storedSessions, new Date(), 4);
      const oldWeeks: { start: Date; count: number }[] = completedPerWeek(legacySessions, new Date(), 4);
      const covered: boolean = historyCovers(either, new Date());
      const eitherActive = activeFrom(either);
      if (eitherActive) sessionMinutes(eitherActive);`],
  ]);
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options), originalSource = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => files.has(name)
    ? ts.createSourceFile(name, files.get(name), languageVersion, true)
    : originalSource(name, languageVersion, onError, shouldCreateNewSourceFile);
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    const target = resolve(containingFile, '..', name + '.ts');
    assert.ok(files.has(target), 'Unexpected type dependency: ' + name);
    return { resolvedFileName: target, extension: ts.Extension.Ts };
  });
  host.writeFile = () => assert.fail('Type fixture must not emit files');
  const program = ts.createProgram([consumer], options, host);
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

test('v2 frozen retry snapshots preserve every reported load distinction and exact equality', () => {
  const loads = [
    ...['kg', 'lb'].flatMap(unit => ['total', 'perImplement', 'perSide', 'assistance'].flatMap(basis =>
      [0, 12.5].map(value => ({ state: 'knownValue', value, unit, basis })))),
    { state: 'unknown', confirmed: true },
    ...['bodyweight', 'unloaded', 'timedActivity'].map(reason => ({ state: 'notApplicable', reason })),
  ];
  for (const reps of [undefined, 8]) for (const load of loads) {
    const original = { ...set('set-1', reps), schema: 'form.source-performed-set/v2',
      performance: { ...performance(reps), schema: 'form.source-performance/v2', load: { ...load } } };
    const before = structuredClone(original);
    const snapshots = [m.freezeSetDraft(original), m.freezeSetChanges(original), m.freezeSavedSet(original)];
    original.performance.load.state = 'changed'; original.performance.kind = 'changed';
    for (const frozen of snapshots) {
      assert.deepEqual(frozen, before);
      assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.performance) && Object.isFrozen(frozen.performance.load));
      assert.equal(m.setValuesMatch(frozen, before), true);
      for (const other of loads) assert.equal(m.setValuesMatch(frozen,
        { ...before, performance: { ...before.performance, load: other } }), JSON.stringify(load) === JSON.stringify(other));
      assert.equal(m.setValuesMatch(frozen, set('set-1', reps)), false);
      assert.equal(m.setValuesMatch(frozen, { ...before, schema: 'form.source-performed-set/v1' }), false);
      assert.equal(m.setValuesMatch({ ...before, schema: 'form.source-performed-set/v1' },
        { ...before, schema: 'form.source-performed-set/v1' }), false);
      assert.equal(m.setValuesMatch(frozen, { ...before, status: 'draft' }), false);
      if (reps !== undefined) assert.equal(m.setValuesMatch(frozen,
        { ...before, performance: { ...before.performance, reps: 9 } }), false);
    }
  }
});
