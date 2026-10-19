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
const load = loader(), transport = load('api/transport.ts'), { FormTransport, ApiError } = transport;
const { FormResources } = load('api/resources.ts');
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
function hooks() {
  const slots = [], dataUpdates = [], routeWrites = []; let cursor = 0, effects = [], holdData = false;
  const changed = (old, deps) => !old || deps.length !== old.deps.length || deps.some((v, i) => !Object.is(v, old.deps[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => {
        const apply = () => {
          const next = typeof value === 'function' ? value(slots[i]) : value;
          if (Array.isArray(next) && next.at(-1)?.name === 'source-plan-detail') {
            const latest = slots.find(slot => slot?.current && Object.hasOwn(slot.current, 'plans'));
            routeWrites.push({ route: next.at(-1), cache: latest?.current.plans });
          }
          slots[i] = next;
        };
        if (holdData && slots[i] && Object.hasOwn(slots[i], 'plans') && Object.hasOwn(slots[i], 'account')) dataUpdates.push(apply);
        else apply();
      }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (changed(slots[i], deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (changed(old, deps)) effects.push(() => {
      old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  return { react, render(Component, props) { cursor = 0; effects = []; const node = Component(props); for (const effect of effects) effect(); return node; },
    data: () => slots.find(slot => slot && Object.hasOwn(slot, 'plans') && Object.hasOwn(slot, 'account')),
    routeWrites,
    holdData() { holdData = true; },
    flushData() { holdData = false; for (const apply of dataUpdates.splice(0)) apply(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); } };
}
const jsx = (type, props, key) => ({ type, props, key });
const names = new Proxy({}, { get: (_, name) => name });
const tokens = new Proxy({}, { get: () => tokens });
const noop = () => {};
const speech = { dispose: async () => {}, cancel: async () => {} };
const native = { StyleSheet: { create: value => value }, View: 'View', Pressable: 'Pressable',
  AccessibilityInfo: {}, AppState: { addEventListener: () => ({ remove: noop }) } };

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === type) return tree;
  for (const child of [tree.props?.children].flat()) { const found = find(child, type); if (found) return found; }
  return null;
}

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

async function fixture({ renderer = true, trainingRenderer = false, source = true, initialPlans = [receipt().plan] } = {}) {
  const h = hooks(), calls = []; let home, context, detail, keys = 0;
  const f = { plans: initialPlans, readPlans: null, post: null, acquire: null, acquisitions: 0, legacyReads: 0, detailCalls: 0 };
  const api = new FormTransport('https://form.example.invalid', {
    async load() { return JSON.stringify({ version: 1, baseURL: 'https://form.example.invalid', token: 'synthetic-original' }); },
    async save() {}, async clear() {},
  }, async (url, init) => {
    if (url.endsWith('/sign-in/email')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic-replacement' } });
    const call = { path: new URL(url).pathname, method: init.method, body: init.body && JSON.parse(init.body), key: init.headers['Idempotency-Key'] };
    calls.push(call);
    if (call.path === '/v1/capabilities') return json({});
    if (call.path === '/v1/me') return json(account());
    if (call.path === '/v1/me/settings' || call.path === '/v1/entitlements') return json({ accountId: 'original' });
    if (call.path === '/v1/exercises') return json({ items: [] });
    if (call.path === '/v1/plans' && call.method === 'GET') return f.readPlans ? f.readPlans() : json({ items: f.plans });
    if (call.path === '/v1/plans/first' && call.method === 'POST') return f.post ? f.post(call) : json(source ? sourceReceipt() : receipt());
    assert.fail('Unexpected actual transport request: ' + call.method + ' ' + call.path);
  });
  const resources = new FormResources(api), bound = resources.boundTo.bind(resources);
  resources.boundTo = current => {
    const scoped = bound(current), acquire = scoped.sourceTraining.bind(scoped), legacyPlans = scoped.plans;
    scoped.sourceTraining = () => { f.acquisitions++; return f.acquire ? f.acquire(acquire) : acquire(); };
    scoped.plans = () => { f.legacyReads++; return legacyPlans(); };
    return scoped;
  };
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
    '../../api/client': { ...transport, commandKey: () => 'synthetic-key-' + (++keys) }, '../api/transport': transport,
    '../../integration/sharedVoice': { captureSharedVoiceScope: (_api, account, isCurrent) => ({ account, isCurrent }) },
    '../../native/speech': { FormSpeechAdapter: function () { return speech; } },
    '../account/AccountScreens': names, '../auth/AuthFlow': names, '../cues/CuesScreen': names,
    '../onboarding/OnboardingFlow': names, '../plans/PlansScreens': names,
    '../shared/copy': { COPY: {}, errorCopy: error => error.message }, '../shared/tokens': { t: tokens, L: tokens }, '../shared/ui': names };
  const { FormAccountApp } = loader(mocks)('features/shell/FormAccountApp.tsx');
  const props = { resources, appMode: 'basic', renderHome: ctx => { home = ctx; return 'home'; }, renderSettings: () => 'settings',
    renderContextConfirmation: ctx => { context = ctx; return 'context'; },
    ...(trainingRenderer ? { renderSourceTraining: ctx => jsx('SourceTraining', { ctx }) } : {}),
    ...(renderer ? { renderSourcePlanDetail: ctx => { detail = ctx; f.detailCalls++; return jsx('SourcePlanDetail', { ctx }); } } : {}) };
  Object.assign(f, { api, resources, props, calls, render: () => h.render(FormAccountApp, props), dispose: h.dispose,
    cache: () => h.data().plans, data: h.data, routeWrites: h.routeWrites,
    holdData: h.holdData, flushData: h.flushData, home: () => home, context: () => context, detail: () => detail,
    replaceAuth: () => api.signIn('synthetic@example.invalid', 'synthetic'),
    posts: () => calls.filter(c => c.path === '/v1/plans/first'), reads: () => calls.filter(c => c.path === '/v1/plans'),
    async save() {
      home.openContextConfirmation(); f.render();
      const ready = await context.confirmation.capture(); assert.equal(ready.snapshot.status, 'ready');
      const saved = await ready.review.confirm(); assert.equal(saved.snapshot.status, 'saved');
      return saved;
    },
  });
  f.render(); await settle(); f.render(); await settle(); f.render(); assert.ok(home?.isCurrentSession());
  calls.length = 0; f.acquisitions = 0; f.legacyReads = 0;
  return f;
}

test('source receipt has no host destination without a supplied source renderer and never falls back to the legacy editor', async () => {
  const f = await fixture({ renderer: false });
  try {
    const saved = await f.save();
    assert.equal(f.context().savedFirstPlanDestination(saved), null);
    assert.equal(f.home().savedFirstPlanDestination(saved), null);
    assert.equal(f.reads().length, 0); assert.equal(f.acquisitions, 0); assert.equal(f.detailCalls, 0);
    assert.equal(find(f.render(), 'PlanEditScreen'), null); assert.equal(f.posts().length, 1);
  } finally { f.dispose(); }
});

test('legacy receipt retains its guarded existing editor destination', async () => {
  const f = await fixture({ source: false });
  try {
    const saved = await f.save(), destination = f.context().savedFirstPlanDestination(saved);
    assert.ok(destination); assert.deepEqual(await destination.openSavedPlan(), { status: 'opened' });
    const editor = find(f.render(), 'PlanEditScreen'); assert.ok(editor);
    assert.deepEqual(editor.props.plan, receipt().plan); assert.notEqual(editor.key, 'new');
    assert.equal(f.detailCalls, 0); assert.equal(f.posts().length, 1);
  } finally { f.dispose(); }
});

test('actual source save reads and adopts the complete frozen snapshot before its distinct route and React cache commit', async () => {
  const f = await fixture();
  try {
    const saved = await f.save(), homeKey = f.home().sessionGeneration, resources = f.home().resources;
    const destination = f.context().savedFirstPlanDestination(saved); assert.ok(destination);
    f.plans = [sourceReceipt().plan]; f.holdData();
    const first = destination.openSavedPlan(), second = destination.openSavedPlan(); assert.equal(first, second);
    assert.deepEqual(await first, { status: 'opened' });
    assert.equal(f.routeWrites.length, 1);
    assert.deepEqual(f.routeWrites[0].cache, [sourceReceipt().plan]);
    const tree = f.render(), rendered = find(tree, 'SourcePlanDetail'); assert.ok(rendered);
    assert.equal(find(tree, 'PlanEditScreen'), null); assert.equal(f.posts().length, 1);
    const ctx = rendered.props.ctx;
    assert.equal(ctx.account.accountId, 'original'); assert.equal(ctx.resources, resources);
    assert.equal(ctx.sessionGeneration, homeKey); assert.equal(ctx.isCurrentSession(), true);
    assert.deepEqual(ctx.plan, sourceReceipt().plan); assert.ok(Object.isFrozen(ctx));
    for (const object of [ctx.plan, ctx.plan.duration, ctx.plan.items[0].native.notes,
      ctx.plan.items[0].registeredDomain.registration]) assert.ok(Object.isFrozen(object));
    assert.throws(() => ctx.plan.items[0].native.notes.push('mutated'), TypeError);
    assert.equal('rep_range' in ctx.plan.items[1].native, false); assert.equal('minutes' in ctx.plan, false);
    assert.deepEqual(f.cache(), [receipt().plan]);
    f.flushData(); f.render(); assert.deepEqual(f.cache(), [sourceReceipt().plan]);
    assert.deepEqual(f.home().plans, []); assert.equal(f.home().activePlan, null);
    assert.equal(f.acquisitions, 1); assert.equal(f.reads().length, 1); assert.equal(f.legacyReads, 0);
    ctx.close(); const closed = f.render(); assert.equal(find(closed, 'SourcePlanDetail'), null);
    assert.equal(f.home().sessionGeneration, homeKey); assert.equal(f.posts().length, 1);
  } finally { f.dispose(); }
});

test('mixed restore and reload retain one full decoded cache while legacy screens receive only genuine legacy plans', async () => {
  const source = sourceReceipt().plan, legacy = { ...receipt().plan, id: 'legacy_plan' }, archived = { ...source, id: 'archived_source', archived: true };
  const f = await fixture({ renderer: false, initialPlans: [source, legacy, archived] });
  try {
    assert.deepEqual(f.cache(), [source, legacy, archived]);
    assert.equal(f.home().storedPlans, f.cache());
    assert.deepEqual(f.home().storedPlans, [source, legacy, archived]);
    assert.deepEqual(f.home().plans, [legacy]); assert.deepEqual(f.home().activePlan, legacy);
    f.home().openPlans(); const screen = find(f.render(), 'PlansScreen'); assert.ok(screen);
    assert.deepEqual(screen.props.plans, [legacy]);
    for (const id of [source.id, archived.id, 'missing_plan']) {
      screen.props.onOpen(id); assert.equal(find(f.render(), 'PlanEditScreen'), null);
    }
    const next = sourceReceipt().plan; next.items[0].native.notes = ['Latest retained note']; next.revision = 2;
    f.plans = [next, legacy, archived]; await f.home().reload(); f.render();
    assert.deepEqual(f.cache(), [next, legacy, archived]); assert.equal(f.legacyReads, 0);
    screen.props.onOpen(legacy.id); const editor = find(f.render(), 'PlanEditScreen'); assert.ok(editor);
    assert.deepEqual(editor.props.plan, legacy); assert.equal(f.posts().length, 0);
  } finally { f.dispose(); }
});

test('source unknown archived and removed IDs cannot turn a retained open callback into legacy create mode', async () => {
  const source = sourceReceipt().plan, legacy = { ...receipt().plan, id: 'legacy_plan' };
  const f = await fixture({ initialPlans: [source, legacy] });
  try {
    const open = f.home().openPlan;
    for (const id of [source.id, 'missing_plan']) { open(id); assert.equal(find(f.render(), 'PlanEditScreen'), null); }
    open(legacy.id); assert.ok(find(f.render(), 'PlanEditScreen'));
    f.plans = [source]; await f.home().reload(); assert.equal(find(f.render(), 'PlanEditScreen'), null);
    open(legacy.id); assert.equal(find(f.render(), 'PlanEditScreen'), null); assert.equal(f.posts().length, 0);
  } finally { f.dispose(); }
});

test('legacy onSaved accepts only decoded matching legacy data and cannot overwrite the source cache', async () => {
  const source = sourceReceipt().plan, legacy = { ...receipt().plan, id: 'legacy_plan' };
  const f = await fixture({ initialPlans: [source, legacy] });
  try {
    f.home().openPlan(legacy.id); const editor = find(f.render(), 'PlanEditScreen'); assert.ok(editor);
    for (const invalid of [source, { ...source, id: legacy.id }, { ...legacy, extra: true }, { ...legacy, id: 'other_plan' }, { ...legacy, archived: true }]) {
      editor.props.onSaved(invalid); f.render(); assert.deepEqual(f.cache(), [source, legacy]);
    }
    const saved = { ...legacy, revision: 2 }; editor.props.onSaved(saved); f.render();
    assert.deepEqual(f.cache(), [saved, source].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    assert.equal(find(f.render(), 'PlanEditScreen'), null); assert.equal(f.posts().length, 0);
  } finally { f.dispose(); }
});

test('duplicate or malformed closed plan reads preserve the prior full cache without unchecked legacy fallback', async () => {
  const f = await fixture();
  try {
    for (const page of [{ items: [sourceReceipt().plan, sourceReceipt().plan] },
      { items: [{ ...sourceReceipt().plan, minutes: 30 }] }, { items: [{ ...receipt().plan, revision: -1 }] }]) {
      f.readPlans = () => json(page); await f.home().reload(); f.render();
      assert.deepEqual(f.cache(), [receipt().plan]); assert.ok(f.data().plansError); assert.equal(f.legacyReads, 0);
    }
    assert.equal(f.posts().length, 0);
  } finally { f.dispose(); }
});

test('read-only saved-source retries preserve the receipt and all unavailable reasons without second creation', async () => {
  const cases = [
    ['plan_missing', { items: [] }], ['plan_changed', { items: [{ ...sourceReceipt().plan, revision: 2 }] }],
    ['plan_archived', { items: [{ ...sourceReceipt().plan, archived: true }] }],
    ['invalid_readback', { items: [sourceReceipt().plan, sourceReceipt().plan] }], ['read_failed', null],
  ];
  for (const [reason, page] of cases) {
    const f = await fixture();
    try {
      const saved = await f.save(), destination = f.context().savedFirstPlanDestination(saved), captured = JSON.stringify(saved);
      f.readPlans = () => page ? json(page) : Promise.reject(new Error('Synthetic offline'));
      assert.deepEqual(await destination.openSavedPlan(), { status: 'unavailable', reason });
      assert.equal(f.detailCalls, 0); assert.deepEqual(f.cache(), [receipt().plan]);
      assert.equal(JSON.stringify(saved), captured); assert.equal(f.context().confirmation.snapshot().effect, 'confirmed');
      f.readPlans = null; f.plans = [sourceReceipt().plan];
      assert.deepEqual(await destination.openSavedPlan(), { status: 'opened' });
      assert.ok(find(f.render(), 'SourcePlanDetail')); assert.equal(f.posts().length, 1);
    } finally { f.dispose(); }
  }
});

test('same-account auth replacement or unmount during saved-source acquisition prevents read adoption and route', async () => {
  for (const expire of [f => f.replaceAuth(), f => f.dispose()]) {
    const f = await fixture(), gate = deferred();
    try {
      const saved = await f.save(), destination = f.context().savedFirstPlanDestination(saved);
      f.acquire = async acquire => { await gate.promise; return acquire(); };
      const pending = destination.openSavedPlan(); await settle(); assert.equal(f.acquisitions, 1);
      await expire(f); gate.resolve(); assert.deepEqual(await pending, { status: 'stale' });
      assert.equal(f.reads().length, 0); assert.equal(f.routeWrites.length, 0); assert.equal(f.detailCalls, 0);
      assert.equal(f.posts().length, 1);
    } finally { gate.resolve(); f.dispose(); }
  }
});

test('late saved-source read after original auth loss or unmount cannot present or replace the cache', async () => {
  for (const [expire, expectedCache] of [[f => f.replaceAuth(), []], [f => f.dispose(), [receipt().plan]]]) {
    const f = await fixture(), gate = deferred();
    try {
      const saved = await f.save(), destination = f.context().savedFirstPlanDestination(saved);
      f.readPlans = () => gate.promise;
      const pending = destination.openSavedPlan(); await settle(); assert.equal(f.reads().length, 1);
      await expire(f); assert.deepEqual(f.cache(), expectedCache); gate.resolve(json({ items: [sourceReceipt().plan] }));
      assert.deepEqual(await pending, { status: 'stale' });
      assert.deepEqual(f.cache(), expectedCache); assert.equal(f.routeWrites.length, 0); assert.equal(f.detailCalls, 0);
      assert.equal(f.posts().length, 1);
    } finally { gate.resolve(json({ items: [] })); f.dispose(); }
  }
});

test('renderer removal or replacement refuses an already captured source adoption action', async () => {
  for (const replace of [false, true]) {
    const f = await fixture();
    try {
      const saved = await f.save(), destination = f.context().savedFirstPlanDestination(saved);
      f.props.renderSourcePlanDetail = replace ? () => assert.fail('Replacement renderer cannot receive old adoption') : undefined;
      f.render(); f.plans = [sourceReceipt().plan];
      assert.deepEqual(await destination.openSavedPlan(), { status: 'stale' });
      assert.deepEqual(f.cache(), [receipt().plan]); assert.equal(f.routeWrites.length, 0); assert.equal(f.posts().length, 1);
    } finally { f.dispose(); }
  }
});

test('source route retains Home lifetime and suppresses renderer and close after original session loss', async () => {
  const f = await fixture();
  try {
    const saved = await f.save(), key = f.home().sessionGeneration;
    f.plans = [sourceReceipt().plan]; await f.context().savedFirstPlanDestination(saved).openSavedPlan();
    const shown = f.render(), ctx = f.detail(); assert.ok(find(shown, 'SourcePlanDetail'));
    const calls = f.detailCalls; assert.equal(f.home().sessionGeneration, key);
    await f.replaceAuth(); assert.equal(ctx.isCurrentSession(), false); ctx.close();
    assert.equal(find(f.render(), 'SourcePlanDetail'), null); assert.equal(f.detailCalls, calls);
    assert.equal(f.posts().length, 1);
  } finally { f.dispose(); }
});

test('original resources replacement denies a retained saved-source destination before acquisition', async () => {
  const f = await fixture();
  try {
    const saved = await f.save(), destination = f.context().savedFirstPlanDestination(saved);
    f.props.resources = new FormResources(f.api); f.render();
    assert.deepEqual(await destination.openSavedPlan(), { status: 'stale' });
    assert.equal(f.acquisitions, 0); assert.equal(f.reads().length, 0); assert.equal(f.routeWrites.length, 0);
    assert.equal(f.posts().length, 1);
  } finally { f.dispose(); }
});

test('late full-cache reload after auth loss or unmount cannot overwrite plans or dispatch the next read', async () => {
  for (const duringRead of [false, true]) {
    for (const [expire, expectedCache] of [[f => f.replaceAuth(), []], [f => f.dispose(), [receipt().plan]]]) {
      const f = await fixture(), gate = deferred();
      try {
        if (duringRead) f.readPlans = () => gate.promise;
        else f.acquire = async acquire => { await gate.promise; return acquire(); };
        const pending = f.home().reload(); await settle();
        assert.equal(f.acquisitions, 1); assert.equal(f.reads().length, duringRead ? 1 : 0);
        await expire(f); assert.deepEqual(f.cache(), expectedCache); gate.resolve(duringRead ? json({ items: [sourceReceipt().plan] }) : undefined);
        await pending; assert.deepEqual(f.cache(), expectedCache);
        assert.equal(f.calls.filter(call => call.path === '/v1/exercises').length, 0);
        assert.equal(f.posts().length, 0);
      } finally { gate.resolve(json({ items: [] })); f.dispose(); }
    }
  }
});

test('legacy create acknowledgement cannot replace an existing source plan with the same ID', async () => {
  const source = sourceReceipt().plan, f = await fixture({ initialPlans: [source] });
  try {
    f.home().openPlans(); find(f.render(), 'PlansScreen').props.onCreate();
    const editor = find(f.render(), 'PlanEditScreen'); assert.ok(editor); assert.equal(editor.props.plan, null);
    editor.props.onSaved(receipt().plan); f.render(); assert.deepEqual(f.cache(), [source]);
    assert.equal(f.posts().length, 0);
  } finally { f.dispose(); }
});


async function openSourceDetail(f, saved) {
  f.plans = [sourceReceipt().plan];
  const destination = f.home().savedFirstPlanDestination(saved ?? await f.save());
  assert.ok(destination);
  assert.deepEqual(await destination.openSavedPlan(), { status: 'opened' });
  assert.ok(find(f.render(), 'SourcePlanDetail'));
  return f.detail();
}

test('source detail has no training action without both a supplied presenter and a registered persistent owner', async () => {
  for (const trainingRenderer of [false, true]) {
    const f = await fixture({ trainingRenderer });
    try {
      const ctx = await openSourceDetail(f);
      assert.equal(ctx.start, undefined);
      assert.equal(typeof f.home().registerSourceTraining, trainingRenderer ? 'function' : 'undefined');
      assert.equal(f.home().renderSourceTraining, f.props.renderSourceTraining);
      assert.equal(f.posts().length, 1);
      assert.equal(f.calls.some(call => call.path.startsWith('/v1/sessions')), false);
    } finally { f.dispose(); }
  }
});

test('detail hands the exact complete source plan to retained Home once without dispatching a workout', async () => {
  const f = await fixture({ trainingRenderer: true }), selected = [];
  try {
    const homeKey = f.home().sessionGeneration, resource = f.home().resources;
    const unregister = f.home().registerSourceTraining(plan => { selected.push(plan); return true; });
    const detail = await openSourceDetail(f), before = f.calls.length;
    assert.equal(typeof detail.start, 'function');
    assert.equal(detail.start(), true); assert.equal(detail.start(), false);
    assert.equal(selected.length, 1); assert.equal(selected[0], detail.plan);
    assert.equal(selected[0], f.cache()[0]); assert.deepEqual(selected[0], sourceReceipt().plan);
    assert.equal(Object.hasOwn(selected[0].items[1].native, 'rep_range'), false);
    assert.deepEqual(selected[0].items[0].native.notes, ['Retained source note', '']);
    assert.deepEqual(selected[0].items[1].load, { kind: 'unspecified', basis: 'unknown' });
    const tree = f.render(); assert.equal(find(tree, 'SourcePlanDetail'), null);
    assert.equal(f.home().sessionGeneration, homeKey); assert.equal(f.home().resources, resource);
    assert.equal(f.home().storedPlans, f.cache()); assert.equal(f.calls.length, before);
    unregister();
  } finally { f.dispose(); }
});

test('persistent owner refusal keeps the detail route and retained intent through other shell routes', async () => {
  const f = await fixture({ trainingRenderer: true }); let state = 'pending', attempts = 0;
  try {
    const register = f.home().registerSourceTraining, homeKey = f.home().sessionGeneration;
    const unregister = register(() => { attempts++; return state === 'idle'; });
    const detail = await openSourceDetail(f), before = f.calls.length;
    assert.equal(detail.start(), false); assert.ok(find(f.render(), 'SourcePlanDetail'));
    state = 'unknown'; assert.equal(detail.start(), false);
    f.home().openSettings(); assert.equal(find(f.render(), 'SourcePlanDetail'), null);
    assert.equal(f.home().registerSourceTraining, register); assert.equal(f.home().sessionGeneration, homeKey);
    assert.equal(attempts, 2); assert.equal(state, 'unknown'); assert.equal(f.calls.length, before);
    state = 'idle'; assert.equal(detail.start(), true); f.render();
    assert.equal(attempts, 3); assert.equal(f.calls.length, before); unregister();
  } finally { f.dispose(); }
});

test('detail handoff rejects original auth resource and mounted lifetime loss before calling the owner', async () => {
  for (const expire of [f => f.replaceAuth(), f => { f.props.resources = new FormResources(f.api); f.render(); }, f => f.dispose()]) {
    const f = await fixture({ trainingRenderer: true }); let selections = 0;
    try {
      f.home().registerSourceTraining(() => { selections++; return true; });
      const detail = await openSourceDetail(f);
      await expire(f); const before = f.calls.length;
      assert.equal(detail.start(), false); assert.equal(selections, 0);
      assert.equal(f.calls.length, before);
    } finally { f.dispose(); }
  }
});

test('old source handoffs cannot revive after detail training or Home renderer removal and restoration', async () => {
  for (const field of ['renderSourcePlanDetail', 'renderSourceTraining', 'renderHome']) {
    const f = await fixture({ trainingRenderer: true }); let selections = 0;
    try {
      f.home().registerSourceTraining(() => { selections++; return true; });
      const detail = await openSourceDetail(f), original = f.props[field], before = f.calls.length;
      f.props[field] = undefined; f.render();
      assert.equal(detail.start(), false);
      f.props[field] = original; f.render();
      assert.equal(detail.start(), false); assert.equal(detail.isCurrentSession(), false);
      assert.equal(selections, 0); assert.equal(f.calls.length, before);
    } finally { f.dispose(); }
  }
});

test('unregistered or replaced owners cannot receive old detail callbacks and stale cleanup cannot remove the replacement', async () => {
  const f = await fixture({ trainingRenderer: true }); let first = 0, second = 0;
  try {
    const unregister = f.home().registerSourceTraining(() => { first++; return true; });
    const saved = await f.save(), detail = await openSourceDetail(f, saved);
    unregister(); assert.equal(detail.start(), false);
    const nextUnregister = f.home().registerSourceTraining(() => { second++; return true; });
    unregister(); assert.equal(detail.start(), false);
    const next = await openSourceDetail(f, saved), before = f.calls.length;
    assert.equal(next.start(), true); assert.equal(first, 0); assert.equal(second, 1);
    assert.equal(f.calls.length, before); nextUnregister();
  } finally { f.dispose(); }
});

test('a stale presentation registration cannot displace the new original-session Home owner', async () => {
  const f = await fixture({ trainingRenderer: true }); let stale = 0, current = 0;
  try {
    const oldRegister = f.home().registerSourceTraining;
    const saved = await f.save();
    f.props.renderSourceTraining = ctx => jsx('ReplacementSourceTraining', { ctx }); f.render();
    const unregister = f.home().registerSourceTraining(() => { current++; return true; });
    const staleCleanup = oldRegister(() => { stale++; return true; }); staleCleanup();
    const detail = await openSourceDetail(f, saved), before = f.calls.length;
    assert.equal(detail.start(), true); assert.equal(current, 1); assert.equal(stale, 0);
    assert.equal(f.calls.length, before); unregister();
  } finally { f.dispose(); }
});
