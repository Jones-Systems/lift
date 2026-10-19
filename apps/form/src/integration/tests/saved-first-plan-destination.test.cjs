const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function loader(mocks = {}) {
  const cache = new Map();
  function load(name) {
    const file = path.resolve(root, name); assert.ok(file.startsWith(root + path.sep));
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
      if (name === './client') return { ...load('api/transport.ts'), formApi: null };
      return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
    }, module, module.exports);
    return module.exports;
  }
  return load;
}
const load = loader(), { ApiError } = load('api/transport.ts');
const { FormResources } = load('api/resources.ts');
const { createContextConfirmation } = load('integration/contextConfirmation.ts');
const { createSavedFirstPlanDestination } = load('integration/savedFirstPlanDestination.ts');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function receipt() {
  return { plan: { id: 'saved_plan', name: 'Saved plan', minutes: 30, revision: 1, archived: false,
    createdAt: '2026-10-11T12:00:00.000Z', updatedAt: '2026-10-11T12:00:00.000Z',
    items: [{ id: 'item_1', exerciseId: 'exercise_1', setTarget: 3, repMin: 6, repMax: 10, targetKg: 0 }] },
    provenance: { schema: 'form.first-plan-provenance/v1', contextKey: 'context:v1', selectedCandidateId: 'candidate_1', profileRevision: 4, preferencesRevision: 7,
      sources: [{ id: 'source_1', revision: 'revision_1' }], candidates: [{ id: 'candidate_1', status: 'eligible', gapCodes: [] }] } };
}
function account() {
  return { accountId: 'original', onboarding: { status: 'completed' },
    profile: { revision: 4, name: 'Original', age: null, heightCm: null, weightKg: null, trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'direct',
      communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['dumbbell'], remindersEnabled: false } };
}
async function fixture(source = false) {
  let active = true, authCurrent = true; const calls = [], opened = [], cache = [];
  const savedReceipt = source ? sourceReceipt : receipt;
  const f = { read: () => ({ items: [savedReceipt().plan] }), create: savedReceipt, acquisitions: 0, legacyAdoptions: 0, sourceAdoptions: 0, acquire: null };
  const api = { captureAuthContext: () => ({ isCurrent: () => authCurrent }), async request(path, method = 'GET', body, key) {
    calls.push({ path, method, body, key });
    if (path === '/v1/me') return account();
    if (path === '/v1/plans/first') return f.create();
    assert.equal(path, '/v1/plans'); assert.equal(method, 'GET'); return f.read();
  } };
  const resources = new FormResources(api).boundTo(() => active);
  const acquire = resources.sourceTraining.bind(resources);
  resources.sourceTraining = () => { f.acquisitions++; return f.acquire ? f.acquire(acquire) : acquire(); };
  const scope = { accountId: 'original', sessionGeneration: 'original-session', originalAuth: api.captureAuthContext(),
    isCurrentSession: binding => active && binding.accountId === 'original' && binding.sessionGeneration === 'original-session' && binding.resources === resources };
  const confirmation = createContextConfirmation({ resources, scope, newIdempotencyKey: () => 'original-key' });
  const review = await confirmation.capture(); const saved = await review.review.confirm(); assert.equal(saved.snapshot.status, 'saved');
  const options = { saved, resources, scope,
    adoptAndOpen(plan) { f.legacyAdoptions++; cache.push(plan); assert.equal(cache.at(-1), plan); opened.push(plan.id); return true; },
    adoptSourceAndOpen(plan) { f.sourceAdoptions++; cache.push(plan); assert.equal(cache.at(-1), plan); opened.push(plan.id); return true; } };
  const destination = createSavedFirstPlanDestination(options); assert.ok(destination);
  return Object.assign(f, { calls, opened, cache, resources, scope, options, destination, confirmation, saved,
    expire: () => { active = false; }, expireAuth: () => { authCurrent = false; }, revive: () => { active = authCurrent = true; } });
}
const creates = f => f.calls.filter(call => call.path === '/v1/plans/first');
const reads = f => f.calls.filter(call => call.path === '/v1/plans');

test('actual confirmed Context receipt opens only its freshly verified saved plan and never creates again', async () => {
  const f = await fixture();
  assert.ok(Object.isFrozen(f.saved.receipt.plan.items)); assert.ok(Object.isFrozen(f.destination));
  assert.equal(f.destination.openSavedPlan.length, 0);
  assert.deepEqual(await f.destination.openSavedPlan(), { status: 'opened' });
  assert.deepEqual(f.cache[0], f.saved.receipt.plan); assert.ok(Object.isFrozen(f.cache[0])); assert.ok(Object.isFrozen(f.cache[0].items[0]));
  assert.deepEqual(f.opened, ['saved_plan']); assert.equal(reads(f).length, 1); assert.equal(creates(f).length, 1);
  assert.deepEqual(f.confirmation.snapshot(), f.saved.snapshot);
});

test('pending unknown and every nonconfirmed Context result expose no saved destination', async () => {
  const f = await fixture();
  for (const status of ['idle', 'loading', 'ready', 'pending', 'stale', 'unknown', 'unavailable', 'cancelled']) {
    assert.equal(createSavedFirstPlanDestination({ ...f.options, saved: { ...f.saved, snapshot: { ...f.saved.snapshot, status } } }), null);
  }
  for (const effect of ['none', 'pending', 'unknown']) {
    assert.equal(createSavedFirstPlanDestination({ ...f.options, saved: { ...f.saved, snapshot: { ...f.saved.snapshot, effect } } }), null);
  }
  assert.equal(createSavedFirstPlanDestination({ ...f.options, saved: { snapshot: f.saved.snapshot } }), null);
  assert.equal(reads(f).length, 0); assert.equal(creates(f).length, 1);
});

test('read failure and subsequent read-only retry preserve confirmed save and original receipt', async () => {
  const f = await fixture(), saved = clone(f.saved);
  f.read = () => { throw new ApiError(0, 'network_unavailable', 'Synthetic'); };
  assert.deepEqual(await f.destination.openSavedPlan(), { status: 'unavailable', reason: 'read_failed' });
  assert.deepEqual(f.saved, saved); assert.deepEqual(f.confirmation.snapshot(), saved.snapshot); assert.deepEqual(f.opened, []);
  f.read = () => ({ items: [receipt().plan] });
  assert.deepEqual(await f.destination.openSavedPlan(), { status: 'opened' });
  assert.equal(reads(f).length, 2); assert.equal(creates(f).length, 1);
});

test('missing changed archived and duplicate plans never adopt navigate or fall through to create mode', async () => {
  const cases = [
    ['plan_missing', () => ({ items: [] })],
    ['plan_changed', () => ({ items: [{ ...receipt().plan, revision: 2 }] })],
    ['plan_changed', () => ({ items: [{ ...receipt().plan, name: 'Changed' }] })],
    ['plan_changed', () => { const plan = receipt().plan; plan.items[0].targetKg = 5; return { items: [plan] }; }],
    ['plan_archived', () => ({ items: [{ ...receipt().plan, archived: true }] })],
    ['invalid_readback', () => ({ items: [receipt().plan, receipt().plan] })],
  ];
  for (const [reason, read] of cases) {
    const f = await fixture(); f.read = read;
    assert.deepEqual(await f.destination.openSavedPlan(), { status: 'unavailable', reason });
    assert.deepEqual(f.opened, []); assert.deepEqual(f.cache, []); assert.equal(creates(f).length, 1);
    assert.equal(f.confirmation.snapshot().effect, 'confirmed');
  }
});

test('invalid list or plan data is rejected without getters or normalization masking a changed plan', async () => {
  let getters = 0;
  const cases = [null, {}, { items: [] , extra: true }, { items: [null] }, { items: Array(1) },
    { items: [{ ...receipt().plan, revision: NaN }] }, { items: [{ ...receipt().plan, name: ' Saved plan ' }] },
    { items: [{ ...receipt().plan, items: [] }] }, { items: [{ ...receipt().plan, foreign: true }] }];
  const getter = {}; Object.defineProperty(getter, 'items', { enumerable: true, get() { getters++; return [receipt().plan]; } }); cases.push(getter);
  const cyclic = { items: [] }; cyclic.items.push(cyclic); cases.push(cyclic);
  const symbol = { items: [receipt().plan] }; symbol[Symbol('hidden')] = true; cases.push(symbol);
  for (const value of cases) {
    const f = await fixture(); f.read = () => value;
    assert.deepEqual(await f.destination.openSavedPlan(), { status: 'unavailable', reason: 'invalid_readback' });
    assert.deepEqual(f.opened, []); assert.equal(creates(f).length, 1);
  }
  assert.equal(getters, 0);
});

test('concurrent open attempts share one read and one navigation', async () => {
  const f = await fixture(), gate = deferred(); f.read = () => gate.promise;
  const first = f.destination.openSavedPlan(), second = f.destination.openSavedPlan(); assert.equal(first, second);
  gate.resolve({ items: [receipt().plan] });
  assert.deepEqual(await first, { status: 'opened' }); assert.deepEqual(await second, { status: 'opened' });
  assert.equal(reads(f).length, 1); assert.equal(f.opened.length, 1); assert.equal(creates(f).length, 1);
});

test('original auth account generation and unmounted scope deny before reads and latch stale', async () => {
  for (const change of [f => f.expire(), f => f.expireAuth(), f => { f.scope.accountId = 'foreign'; }, f => { f.scope.sessionGeneration = 'replacement'; }]) {
    const f = await fixture(); change(f);
    assert.deepEqual(await f.destination.openSavedPlan(), { status: 'stale' });
    f.revive(); f.scope.accountId = 'original'; f.scope.sessionGeneration = 'original-session';
    assert.deepEqual(await f.destination.openSavedPlan(), { status: 'stale' });
    assert.equal(reads(f).length, 0); assert.deepEqual(f.opened, []);
  }
});

test('late read success or failure after session replacement cannot publish or navigate', async () => {
  for (const reject of [false, true]) {
    const f = await fixture(), gate = deferred(); f.read = () => gate.promise;
    const pending = f.destination.openSavedPlan(); await Promise.resolve(); f.expireAuth();
    if (reject) gate.reject(new Error('Late error')); else gate.resolve({ items: [receipt().plan] });
    assert.deepEqual(await pending, { status: 'stale' }); assert.deepEqual(f.opened, []); assert.deepEqual(f.cache, []);
    assert.equal(creates(f).length, 1);
  }
});

test('receipt and readback ownership are detached and host refusal remains stale', async () => {
  const f = await fixture(), mutable = clone(f.saved), options = { ...f.options, saved: mutable };
  const destination = createSavedFirstPlanDestination(options); mutable.receipt.plan.id = 'replacement';
  const page = { items: [receipt().plan] }; f.read = () => page;
  assert.deepEqual(await destination.openSavedPlan(), { status: 'opened' });
  page.items[0].name = 'Later'; assert.equal(f.cache[0].name, 'Saved plan');
  const refused = createSavedFirstPlanDestination({ ...f.options, adoptAndOpen: () => false });
  f.read = () => ({ items: [receipt().plan] }); assert.deepEqual(await refused.openSavedPlan(), { status: 'stale' });
  assert.equal(creates(f).length, 1);
});

function shellHarness() {
  const slots = [], dataUpdates = []; let cursor = 0, effects = [], holdData = false, authCurrent = true, home;
  const changed = (old, deps) => !old || deps.length !== old.deps.length || deps.some((value, i) => !Object.is(value, old.deps[i]));
  const react = {
    useState(initial) {
      const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => {
        const apply = () => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; };
        if (holdData && slots[i] && Object.hasOwn(slots[i], 'plans') && Object.hasOwn(slots[i], 'account')) dataUpdates.push(apply); else apply();
      }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (changed(slots[i], deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (changed(old, deps)) effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const jsx = (type, props, key) => ({ type, props, key }), names = new Proxy({}, { get: (_, name) => name });
  const tokens = new Proxy({}, { get: () => tokens });
  const f = { read: () => ({ items: [] }), reads: 0, creates: 0 };
  const api = { restore: async () => true, captureAuthContext: () => ({ isCurrent: () => authCurrent }),
    // Non-emitting unit observer; actual auth events are covered by runtime-auth renderer tests.
    subscribeAuthChanges: () => ({ remove() {} }),
    observeSessionLifetime: () => ({ remove() {}, refresh: async () => {} }) };
  const resources = { api, account: async () => account(), entitlements: async () => ({ accountId: 'original' }),
    settings: async () => null, capabilities: async () => ({}), plans: async () => { f.reads++; return f.read(); }, exercises: async () => ({ items: [] }),
    createPlan: async () => { f.creates++; assert.fail('Destination must not create'); },
    createFirstPlan: async () => { f.creates++; assert.fail('Saved destination must not repeat creation'); },
    sourceTraining: async () => load('api/sourceTrainingResources.ts').createSourceTrainingResources(
      () => resources.plans(), () => { if (!authCurrent) throw new ApiError(409, 'session_changed', 'Synthetic'); }),
    boundTo() { return { ...resources }; } };
  const mocks = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { StyleSheet: { create: value => value }, View: 'View', Pressable: 'Pressable',
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    '../../api/client': { ApiError, commandKey: () => 'synthetic-shell' },
    '../../integration/sharedVoice': { captureSharedVoiceScope: (_api, account, isCurrent) => ({ account, isCurrent }) },
    '../../native/speech': { FormSpeechAdapter: function () { return { dispose: async () => {} }; } },
    '../account/AccountScreens': names, '../auth/AuthFlow': names, '../cues/CuesScreen': names, '../onboarding/OnboardingFlow': names,
    '../plans/PlansScreens': names, '../shared/commands': {}, '../shared/copy': { COPY: {}, errorCopy: error => error.message },
    '../shared/tokens': { t: tokens, L: tokens }, '../shared/ui': names };
  const { FormAccountApp } = loader(mocks)('features/shell/FormAccountApp.tsx');
  const props = { resources, appMode: 'basic', renderHome: ctx => { home = ctx; return 'home'; }, renderSettings: () => 'settings' };
  return Object.assign(f, { render() { cursor = 0; effects = []; const tree = FormAccountApp(props); for (const effect of effects) effect(); return tree; },
    getHome: () => home, holdData: () => { holdData = true; }, flushData() { holdData = false; for (const apply of dataUpdates.splice(0)) apply(); },
    expireAuth: () => { authCurrent = false; }, dispose() { for (const slot of slots) slot?.cleanup?.(); } });
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === type) return tree;
  for (const child of [tree.props?.children].flat()) { const found = find(child, type); if (found) return found; }
  return null;
}

test('actual Home port opens the verified existing editor even when React cache state has not committed', async () => {
  const saved = (await fixture()).saved, h = shellHarness();
  try {
    h.render(); await settle(); h.render(); const home = h.getHome(); assert.deepEqual(home.plans, []);
    const destination = home.savedFirstPlanDestination(saved); assert.ok(destination);
    h.read = () => ({ items: [receipt().plan] }); h.holdData();
    assert.deepEqual(await destination.openSavedPlan(), { status: 'opened' });
    const editor = find(h.render(), 'PlanEditScreen'); assert.ok(editor); assert.deepEqual(editor.props.plan, receipt().plan);
    assert.notEqual(editor.key, 'new'); assert.deepEqual(h.getHome().plans, []);
    h.flushData(); h.render(); assert.deepEqual(h.getHome().plans, [receipt().plan]); assert.equal(h.creates, 0);
  } finally { h.dispose(); }
});

test('actual Home port has no pending or unknown exit and never navigates when saved plan is absent', async () => {
  const saved = (await fixture()).saved, h = shellHarness();
  try {
    h.render(); await settle(); h.render(); const home = h.getHome(), before = h.reads;
    for (const status of ['pending', 'unknown']) assert.equal(home.savedFirstPlanDestination({ snapshot: { ...saved.snapshot, status } }), null);
    assert.equal(h.reads, before);
    const destination = home.savedFirstPlanDestination(saved);
    assert.deepEqual(await destination.openSavedPlan(), { status: 'unavailable', reason: 'plan_missing' });
    assert.equal(find(h.render(), 'PlanEditScreen'), null); assert.equal(h.creates, 0);
    h.expireAuth(); h.read = () => ({ items: [receipt().plan] });
    assert.deepEqual(await destination.openSavedPlan(), { status: 'stale' }); assert.equal(h.reads, before + 1);
  } finally { h.dispose(); }
});


function sourceReceipt() {
  const result = receipt();
  const item = (id, nativeId, repetitions) => ({ id,
    native: { exercise_id: nativeId, movement_pattern: 'synthetic movement', role: 'practice', sets: repetitions ? 3 : 1,
      rest_seconds: 45, ...(repetitions ? { rep_range: [6, 10], target_rir: 2, substituted_for: 'prior_native', notes: ['Retained source note', ''] } : {}) },
    registeredDomain: { exerciseId: 'domain_' + id, variantId: 'variant:' + id,
      identity: { repository: 'Synthetic/Source', revision: 'rev:source', path: 'retained/native.json', sha256: 'a'.repeat(64), nativeId },
      registration: { id: 'synthetic-registration', revision: 'r1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
    load: { kind: 'unspecified', basis: 'unknown' } });
  const { minutes, ...metadata } = result.plan;
  result.plan = { ...metadata, schema: 'form.source-prescription-plan/v1', origin: { kind: 'form-adaptation', id: 'synthetic-plan', revision: 'r1' },
    duration: { kind: 'estimated-range', minMinutes: 20, maxMinutes: 35 },
    items: [item('source_rep', 'native_rep', true), item('source_practice', 'native_practice', false)] };
  return result;
}

test('source saved destination acquires original bound resource and adopts complete frozen plan without legacy editor', async () => {
  const f = await fixture(true), value = sourceReceipt().plan;
  f.read = () => ({ items: [{ ...receipt().plan, id: 'legacy_other' }, { ...value, id: 'unrelated' }, value] });
  const first = f.destination.openSavedPlan(), second = f.destination.openSavedPlan(); assert.equal(first, second);
  assert.deepEqual(await first, { status: 'opened' });
  assert.equal(f.acquisitions, 1); assert.equal(reads(f).length, 1); assert.equal(creates(f).length, 1);
  assert.equal(f.legacyAdoptions, 0); assert.equal(f.sourceAdoptions, 1);
  assert.deepEqual(f.cache[0], sourceReceipt().plan); assert.notEqual(f.cache[0], value);
  for (const v of [f.cache[0], f.cache[0].origin, f.cache[0].duration, f.cache[0].items,
    f.cache[0].items[0].native.notes, f.cache[0].items[0].registeredDomain.registration]) assert.ok(Object.isFrozen(v));
  value.items[0].native.notes.push('late'); assert.deepEqual(f.cache[0].items[0].native.notes, ['Retained source note', '']);
  assert.equal('rep_range' in f.cache[0].items[1].native, false); assert.equal('minutes' in f.cache[0], false);
});

test('source saved receipt without distinct source action has no destination or legacy fallback', async () => {
  const f = await fixture(true), { adoptSourceAndOpen, ...legacyOnly } = f.options;
  assert.equal(createSavedFirstPlanDestination(legacyOnly), null);
  assert.equal(createSavedFirstPlanDestination({ ...legacyOnly, adoptSourceAndOpen: null }), null);
  assert.equal(f.acquisitions, 0); assert.equal(reads(f).length, 0); assert.equal(f.legacyAdoptions, 0); assert.equal(creates(f).length, 1);
});

test('source whole-plan readback checks every field optional presence order and all unavailable reasons', async () => {
  const changed = mutate => () => { const p = sourceReceipt().plan; mutate(p); return { items: [p] }; };
  const cases = [
    ['read_failed', () => { throw new Error('synthetic read failure'); }],
    ['plan_missing', () => ({ items: [] })], ['plan_archived', changed(p => { p.archived = true; })],
    ['plan_changed', changed(p => { p.revision++; })], ['plan_changed', changed(p => { p.updatedAt = '2026-10-12T12:00:00.000Z'; })],
    ['plan_changed', changed(p => { p.createdAt = '2026-10-10T12:00:00.000Z'; })],
    ['plan_changed', changed(p => { p.origin.revision = 'r2'; })], ['plan_changed', changed(p => { p.duration.maxMinutes++; })],
    ['plan_changed', changed(p => { delete p.items[0].native.target_rir; })],
    ['plan_changed', changed(p => { delete p.items[0].native.substituted_for; })],
    ['plan_changed', changed(p => { delete p.items[0].native.notes; })],
    ['plan_changed', changed(p => { p.items[0].native.notes.reverse(); })],
    ['plan_changed', changed(p => { p.items[1].native.rep_range = [1, 2]; })],
    ['plan_changed', changed(p => { p.items.reverse(); })],
    ['plan_changed', changed(p => { p.items[0].registeredDomain.exerciseId = 'other_domain'; })],
    ['plan_changed', changed(p => { p.items[0].registeredDomain.registration.bytes++; })],
    ['invalid_readback', changed(p => { p.items[0].native.exercise_id = 'wrong_association'; })],
    ['invalid_readback', changed(p => { p.items[1].native.notes = undefined; })],
    ['invalid_readback', changed(p => { p.duration.minMinutes = 40; })],
    ['invalid_readback', () => ({ items: [sourceReceipt().plan, sourceReceipt().plan] })],
    ['invalid_readback', () => ({ items: [sourceReceipt().plan], unknown: true })],
  ];
  for (const [reason, read] of cases) {
    const f = await fixture(true); f.read = read;
    assert.deepEqual(await f.destination.openSavedPlan(), { status: 'unavailable', reason }, reason);
    assert.equal(f.legacyAdoptions + f.sourceAdoptions, 0); assert.equal(creates(f).length, 1);
    assert.equal(f.confirmation.snapshot().effect, 'confirmed'); assert.deepEqual(f.saved.receipt, sourceReceipt());
  }
});

test('source read-only retry preserves receipt and never repeats first-plan creation', async () => {
  const f = await fixture(true), original = f.saved.receipt;
  f.read = () => { throw new ApiError(0, 'network_unavailable', 'Synthetic'); };
  assert.deepEqual(await f.destination.openSavedPlan(), { status: 'unavailable', reason: 'read_failed' });
  assert.equal(f.saved.receipt, original); assert.equal(f.confirmation.snapshot().status, 'saved');
  f.read = () => ({ items: [sourceReceipt().plan] });
  assert.deepEqual(await f.destination.openSavedPlan(), { status: 'opened' });
  assert.equal(f.acquisitions, 2); assert.equal(reads(f).length, 2); assert.equal(creates(f).length, 1);
});

test('source acquisition and plan read each fence original session before and after await', async () => {
  for (const boundary of ['before', 'acquisition', 'read']) for (const invalidate of ['expire', 'expireAuth']) for (const fails of [false, true]) {
    const f = await fixture(true), gate = deferred(), started = deferred(); let acquiredReads = 0;
    if (boundary === 'acquisition') f.acquire = () => { started.resolve(); return gate.promise; };
    if (boundary === 'read') f.read = () => { started.resolve(); return gate.promise; };
    if (boundary === 'before') f[invalidate]();
    const pending = f.destination.openSavedPlan();
    if (boundary !== 'before') {
      await started.promise; f[invalidate]();
      if (fails) gate.reject(new Error('Late original-resource error'));
      else gate.resolve(boundary === 'acquisition' ? { plans() { acquiredReads++; return { items: [sourceReceipt().plan] }; } } : { items: [sourceReceipt().plan] });
    }
    assert.deepEqual(await pending, { status: 'stale' }); assert.equal(acquiredReads, 0); assert.equal(f.sourceAdoptions + f.legacyAdoptions, 0);
    assert.equal(creates(f).length, 1); if (boundary === 'before') assert.equal(f.acquisitions, 0);
  }
});

test('source acquisition method is captured and requires the original FormResources bound lifetime', async () => {
  const f = await fixture(true); f.resources.sourceTraining = () => { assert.fail('Replacement acquisition must not run'); };
  assert.deepEqual(await f.destination.openSavedPlan(), { status: 'opened' });
  const unbound = new FormResources(f.resources.api), options = { ...f.options, resources: unbound,
    scope: { ...f.scope, isCurrentSession: binding => binding.resources === unbound } };
  const destination = createSavedFirstPlanDestination(options), before = reads(f).length;
  assert.deepEqual(await destination.openSavedPlan(), { status: 'unavailable', reason: 'read_failed' });
  assert.equal(reads(f).length, before); assert.equal(creates(f).length, 1);
});

test('source callback is captured adopts before navigation and post-adoption guard suppresses stale success', async () => {
  const f = await fixture(true), events = [];
  const options = { ...f.options, adoptSourceAndOpen(plan) { events.push(['adopt', plan]); f.expireAuth(); events.push(['navigate', plan.id]); return true; } };
  const destination = createSavedFirstPlanDestination(options);
  options.adoptSourceAndOpen = () => { assert.fail('Replacement callback must not run'); };
  assert.deepEqual(await destination.openSavedPlan(), { status: 'stale' });
  assert.deepEqual(events.map(([kind]) => kind), ['adopt', 'navigate']); assert.deepEqual(events[0][1], sourceReceipt().plan);
  assert.ok(Object.isFrozen(events[0][1])); assert.equal(f.legacyAdoptions, 0); assert.equal(creates(f).length, 1);
});

test('source destinations latch account generation resource replacement and host refusal without creating', async () => {
  for (const change of [f => { f.scope.accountId = 'replacement'; }, f => { f.scope.sessionGeneration = 'replacement'; },
    f => { f.options.resources = new FormResources(f.resources.api); }, f => { f.resources.api = {}; }]) {
    const f = await fixture(true); change(f);
    assert.deepEqual(await f.destination.openSavedPlan(), { status: 'stale' });
    assert.equal(f.acquisitions, 0); assert.equal(reads(f).length, 0); assert.equal(creates(f).length, 1);
  }
  const f = await fixture(true), refused = createSavedFirstPlanDestination({ ...f.options, adoptSourceAndOpen: () => false });
  assert.deepEqual(await refused.openSavedPlan(), { status: 'stale' });
  assert.equal(f.legacyAdoptions, 0); assert.equal(creates(f).length, 1);
});
