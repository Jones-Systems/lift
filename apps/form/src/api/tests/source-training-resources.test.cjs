const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../' + name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(specifier => {
    if (specifier === './client') return { ...load('transport'), formApi: null };
    assert.ok(specifier.startsWith('./')); return load(specifier.slice(2));
  }, module, module.exports);
  cache.set(name, module.exports); return module.exports;
}
const { FormTransport, ApiError } = load('transport');
const { FormResources } = load('resources');
const { captureSourceSetDraft } = load('sourceTrainingResources');
const clone = value => JSON.parse(JSON.stringify(value));
const date = '2026-10-11T12:00:00.000Z';
const item = { id: 'item_1', native: { exercise_id: 'native_1', movement_pattern: ' hinge ', role: 'source-role',
  sets: 2, rest_seconds: 45, rep_range: [6, 10], target_rir: 2, notes: [' first ', '', 'second'] },
  registeredDomain: { exerciseId: 'domain_1', variantId: 'variant:1',
    identity: { repository: 'synthetic/catalog', revision: 'source-v1', path: 'catalog.json', sha256: 'a'.repeat(64), nativeId: 'native_1' },
    registration: { id: 'registration', revision: 'v1', digest: 'b'.repeat(64), bytes: 512 }, recordDigest: 'c'.repeat(64) },
  load: { kind: 'unspecified', basis: 'unknown' } };
const plan = () => ({ schema: 'form.source-prescription-plan/v1', id: 'plan_1', revision: 2, name: 'Source plan', archived: false,
  createdAt: date, updatedAt: date, origin: { kind: 'form-adaptation', id: 'recipe', revision: 'v1' },
  duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 }, items: [clone(item)] });
const draft = (reps, status = 'confirmed') => ({ schema: 'form.source-performed-set/v1', occurrenceId: 'occ_1', setNumber: 1, status,
  performance: { schema: 'form.source-performance/v1', kind: reps === undefined ? 'controlled-practice' : 'repetitions',
    ...(reps === undefined ? {} : { reps }), load: { kind: 'unspecified', basis: 'unknown' } } });
const saved = (input = draft(), overrides = {}) => ({ ...clone(input), id: 'set_1', revision: 1, createdAt: date, updatedAt: date, ...overrides });
const session = (overrides = {}) => ({ id: 'session_1', revision: 4, planId: 'plan_1', planRevision: 2, status: 'active',
  planSnapshot: plan(), startedAt: date, completedAt: null, occurrences: [{ id: 'occ_1', itemId: item.id,
    exerciseId: 'domain_1', position: 0, target: clone(item) }], sets: [], ...overrides });
const stats = () => ({ confirmedSets: 1, repetitions: null, volumeKg: null, maxWeightKg: null,
  coverage: { repetitionSets: 0, loadSets: 0, practiceSets: 1 }, completedSessions: 0,
  byExercise: [{ exerciseId: 'domain_1', confirmedSets: 1, repetitions: null, volumeKg: null, maxWeightKg: null,
    coverage: { repetitionSets: 0, loadSets: 0, practiceSets: 1 } }],
  units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function fixture(respond = () => ({})) {
  const calls = []; let mounted = true, captures = 0;
  let stored = JSON.stringify({ version: 1, baseURL: 'https://form.invalid', token: 'synthetic-token' });
  const api = new FormTransport('https://form.invalid', { load: async () => stored, save: async value => { stored = value; }, clear: async () => { stored = null; } },
    async (url, options) => {
      if (url.endsWith('/v1/me')) return new Response('{}', { status: 200 });
      const call = { url, method: options.method, headers: options.headers, body: options.body };
      calls.push(call);
      const result = await respond(call);
      return new Response(JSON.stringify(result), { status: 200 });
    });
  await api.restore();
  const capture = api.captureAuthContext.bind(api);
  api.captureAuthContext = () => { captures++; return capture(); };
  const resources = new FormResources(api).boundTo(() => mounted);
  const source = await resources.sourceTraining();
  return { source, resources, calls, captures: () => captures, dispose: () => { mounted = false; },
    expireAuth: async () => { stored = null; await api.restore(); } };
}
const invalidWrite = error => error instanceof ApiError && error.code === 'training_response_invalid' && error.effectUnknown;

test('additive facade preserves full source plans, start, session, history and nullable stats using one bound auth capture', async () => {
  const f = await fixture(call => call.url.endsWith('/plans') ? { items: [plan()] }
    : call.url.includes('/history') ? { items: [session()], nextBefore: null }
    : call.url.endsWith('/stats') ? stats() : session());
  assert.deepEqual(await f.source.plans(), { items: [plan()] });
  const started = await f.source.startWorkout(plan(), 'original-key');
  assert.deepEqual(started, session()); assert.equal(Object.hasOwn(started.planSnapshot, 'minutes'), false);
  assert.deepEqual(await f.source.workout('session_1'), session());
  assert.deepEqual(await f.source.history(), { items: [session()], nextBefore: null });
  assert.deepEqual(await f.source.stats(), stats()); assert.equal(f.captures(), 1);
  assert.deepEqual(JSON.parse(f.calls[1].body), { planId: 'plan_1', expectedPlanRevision: 2 });
  assert.equal(f.calls[1].headers['Idempotency-Key'], 'original-key');
});

test('actual source add sends practice without numeric fillers and draft zero as an explicit repetition', async () => {
  for (const value of [draft(), draft(0, 'draft'), draft(8)]) {
    const f = await fixture(() => ({ set: saved(value), sessionRevision: 5 }));
    assert.deepEqual(await f.source.addSet(session(), value, 'key-1'), { set: saved(value), sessionRevision: 5 });
    const body = JSON.parse(f.calls[0].body);
    assert.deepEqual(body, { ...value, expectedRevision: 4 });
    assert.equal(Object.hasOwn(body, 'reps'), false); assert.equal(Object.hasOwn(body, 'weightKg'), false);
    assert.equal(Object.hasOwn(body.performance, 'target_rir'), false);
  }
});

test('captured nested source intent retains exact wire body and key after a lost acknowledgement', async () => {
  let sends = 0; const f = await fixture(() => { if (++sends === 1) throw new Error('lost response'); return { set: saved(draft(8)), sessionRevision: 5 }; });
  const original = draft(8), captured = captureSourceSetDraft(original);
  await assert.rejects(f.source.addSet(session(), captured, 'retained-key'), error => error.effectUnknown);
  original.performance.reps = 99; original.performance.load.basis = 'changed'; original.status = 'draft';
  const result = await f.source.addSet(session(), captured, 'retained-key');
  assert.equal(result.set.performance.reps, 8); assert.equal(f.calls[0].body, f.calls[1].body);
  assert.equal(f.calls[0].headers['Idempotency-Key'], f.calls[1].headers['Idempotency-Key']);
  assert.ok(Object.isFrozen(captured.performance) && Object.isFrozen(captured.performance.load));
});

test('malformed or mismatched write receipts stay unknown instead of acknowledging absent legacy numbers', async () => {
  for (const alter of [r => { delete r.set.performance; }, r => { r.set.performance = draft(8).performance; },
    r => { r.set.occurrenceId = 'foreign'; }, r => { r.set.setNumber = 2; }, r => { r.set.status = 'draft'; },
    r => { r.set.revision = 0; }, r => { r.sessionRevision = 4; }, r => { r.set.weightKg = 0; }]) {
    const f = await fixture(() => { const r = { set: saved(), sessionRevision: 5 }; alter(r); return r; });
    await assert.rejects(f.source.addSet(session(), draft(), 'same-key'), invalidWrite);
    assert.equal(f.calls.length, 1);
  }
});

test('source edit and void preserve exact set identity, performance and original expected revision', async () => {
  const before = saved(draft(8));
  const f = await fixture(call => ({ set: saved(call.url.endsWith('/void') ? draft(8) : draft(9),
    { revision: 2, status: call.url.endsWith('/void') ? 'voided' : 'confirmed' }), sessionRevision: 6 }));
  const { occurrenceId, setNumber, ...changes } = draft(9);
  await f.source.editSet('session_1', before, changes, 'edit-key');
  await f.source.voidSet('session_1', before, 'void-key');
  assert.deepEqual(JSON.parse(f.calls[0].body), { ...changes, expectedRevision: 1 });
  assert.deepEqual(JSON.parse(f.calls[1].body), { expectedRevision: 1 });
  const wrong = await fixture(() => ({ set: saved(draft(9), { id: 'other', revision: 2 }), sessionRevision: 6 }));
  await assert.rejects(wrong.source.editSet('session_1', before, changes, 'key'), invalidWrite);
});

test('source command getters, unknown fields, mixed branches and invalid bounds reject before dispatch', async () => {
  let getters = 0; const f = await fixture();
  for (const alter of [x => Object.defineProperty(x.performance, 'reps', { get() { getters++; return 8; }, enumerable: true }),
    x => { x.weightKg = 0; }, x => { x.performance.kind = 'controlled-practice'; }, x => { x.setNumber = 101; },
    x => { x.performance.reps = 0; }, x => { x.performance.load.basis = 'total'; }]) {
    const value = draft(8); alter(value);
    await assert.rejects(f.source.addSet(session(), value, 'key'), error => error.code === 'invalid_source_training_command' && !error.effectUnknown);
  }
  assert.equal(getters, 0); assert.equal(f.calls.length, 0);
});

test('late write success after bound lifetime or actual auth replacement never publishes or borrows a new session', async () => {
  for (const reason of ['dispose', 'expireAuth']) {
    const pending = deferred(), f = await fixture(() => pending.promise);
    const flight = f.source.addSet(session(), draft(), 'original-key');
    await f[reason](); pending.resolve({ set: saved(), sessionRevision: 5 });
    await assert.rejects(flight, error => error.code === 'session_changed' && (error.effectUnknown || error.originalEffectUnknown));
    await assert.rejects(f.source.addSet(session(), draft(), 'original-key'), error => error.code === 'session_changed');
    assert.equal(f.calls.length, 1); assert.equal(f.captures(), 1);
  }
});

test('lazy facade acquisition checks the original lifetime before and after module loading without recapture', async () => {
  const f = await fixture();
  const acquiring = f.resources.sourceTraining(); f.dispose();
  await assert.rejects(acquiring, error => error.code === 'session_changed');
  await assert.rejects(f.resources.sourceTraining(), error => error.code === 'session_changed');
  await assert.rejects(new FormResources().sourceTraining(), error => error.code === 'session_changed');
  assert.equal(f.captures(), 1); assert.equal(f.calls.length, 0);
});

test('read corruption is unavailable readback and completion verifies original identity, status and advancement', async () => {
  const f = await fixture(() => session({ id: 'other' }));
  await assert.rejects(f.source.workout('session_1'), error => error.code === 'training_response_invalid' && !error.effectUnknown);
  for (const value of [session(), session({ status: 'completed', completedAt: date }),
    session({ id: 'other', revision: 5, status: 'completed', completedAt: date })]) {
    const wrong = await fixture(() => value);
    await assert.rejects(wrong.source.completeWorkout(session(), 'key'), invalidWrite);
  }
  const done = session({ revision: 5, status: 'completed', completedAt: date });
  const good = await fixture(() => done);
  assert.deepEqual(await good.source.completeWorkout(session(), 'key'), done);
});
