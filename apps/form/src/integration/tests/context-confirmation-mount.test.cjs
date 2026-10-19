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
  const slots = []; let cursor = 0, effects = [];
  const changed = (old, deps) => !old || deps.length !== old.deps.length || deps.some((v, i) => !Object.is(v, old.deps[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (changed(slots[i], deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (changed(old, deps)) effects.push(() => {
      old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  return { react, render(Component, props) { cursor = 0; effects = []; const node = Component(props); for (const effect of effects) effect(); return node; },
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
const failure = (status, code) => json({ error: { code, message: 'Synthetic response' } }, status);
async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === type) return tree;
  for (const child of [tree.props?.children].flat()) { const found = find(child, type); if (found) return found; }
  return null;
}
async function fixture({ renderer = true, preparer = true, openEdit } = {}) {
  const h = hooks(), calls = []; let home, settings, context, keys = 0, consumer;
  const prior = { ...receipt().plan, id: 'previous_plan', name: 'Previous saved plan' };
  const f = { account: account(), plans: [prior], readAccount: null, post: null, readPlans: null };
  const api = new FormTransport('https://form.example.invalid', {
    async load() { return JSON.stringify({ version: 1, baseURL: 'https://form.example.invalid', token: 'synthetic-original' }); },
    async save() {}, async clear() {},
  }, async (url, init) => {
    if (url.endsWith('/sign-in/email')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic-replacement' } });
    const call = { path: new URL(url).pathname, method: init.method, body: init.body && JSON.parse(init.body), key: init.headers['Idempotency-Key'] };
    calls.push(call);
    if (call.path === '/v1/capabilities') return json({});
    if (call.path === '/v1/me') return f.readAccount ? f.readAccount() : json(f.account);
    if (call.path === '/v1/me/settings') return json({ accountId: f.account.accountId });
    if (call.path === '/v1/entitlements') return json({ accountId: f.account.accountId });
    if (call.path === '/v1/exercises') return json({ items: [] });
    if (call.path === '/v1/plans' && call.method === 'GET') return f.readPlans ? f.readPlans() : json({ items: f.plans });
    if (call.path === '/v1/plans/first' && call.method === 'POST') return f.post ? f.post(call) : json(receipt());
    assert.fail('Unexpected actual transport request: ' + call.method + ' ' + call.path);
  });
  const resources = new FormResources(api);
  if (!preparer) {
    const bound = resources.boundTo.bind(resources);
    resources.boundTo = current => { const scoped = bound(current); scoped.createFirstPlan = undefined; return scoped; };
  }
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
    '../../api/client': { ...transport, commandKey: () => 'synthetic-key-' + (++keys) }, '../api/transport': transport,
    '../../integration/sharedVoice': { captureSharedVoiceScope: (_api, account, isCurrent) => ({ account, isCurrent }) },
    '../../native/speech': { FormSpeechAdapter: function () { return speech; } },
    '../account/AccountScreens': names, '../auth/AuthFlow': names, '../cues/CuesScreen': names,
    '../onboarding/OnboardingFlow': names, '../plans/PlansScreens': names,
    '../shared/copy': { COPY: {}, errorCopy: error => error.message }, '../shared/tokens': { t: tokens, L: tokens }, '../shared/ui': names };
  const { FormAccountApp } = loader(mocks)('features/shell/FormAccountApp.tsx');
  const newConsumer = () => ({ initial: null, presented: null });
  consumer = newConsumer();
  const props = { resources, appMode: 'basic', renderHome: ctx => { home = ctx; return 'home'; },
    renderSettings: ctx => { settings = ctx; return 'settings'; },
    ...(openEdit ? { openEdit } : {}),
    ...(renderer ? { renderContextConfirmation: ctx => {
      context = ctx;
      // This synthetic mounted consumer retains its single initial promise across rerenders and effect reattachment.
      const admitted = consumer;
      admitted.initial ??= ctx.confirmation.capture().then(result => {
        if (ctx.isCurrentSession()) admitted.presented = result;
        return result;
      });
      return 'context';
    } } : {}) };
  Object.assign(f, { api, resources, calls, props, render: () => h.render(FormAccountApp, props), dispose: h.dispose,
    home: () => home, settings: () => settings, context: () => context, consumer: () => consumer,
    newConsumer() { consumer = newConsumer(); }, keys: () => keys,
    replaceAuth: () => api.signIn('synthetic@example.invalid', 'synthetic'),
    captures: () => calls.filter(c => c.path === '/v1/me'), posts: () => calls.filter(c => c.path === '/v1/plans/first'),
  });
  f.render(); await settle(); f.render(); await settle(); f.render(); assert.ok(home?.isCurrentSession());
  calls.length = 0;
  return f;
}
async function enter(f) {
  f.home().openContextConfirmation(); f.render();
  return f.consumer().initial;
}

test('missing Context renderer or actual preparer exposes no entry and preserves existing Home and plans', async () => {
  for (const options of [{ renderer: false }, { preparer: false }]) {
    const f = await fixture(options);
    try {
      assert.equal(f.home().openContextConfirmation, undefined);
      assert.equal(f.home().plans[0].id, 'previous_plan');
      f.home().openPlans(); assert.ok(find(f.render(), 'PlansScreen'));
      assert.equal(f.captures().length, 0); assert.equal(f.posts().length, 0);
    } finally { f.dispose(); }
  }
});

test('entry performs no read and actual mounted consumer retains one capture and original issued review across rerenders', async () => {
  const f = await fixture();
  try {
    const initialKeys = f.keys(); f.home().openContextConfirmation(); await settle();
    assert.equal(f.captures().length, 0); assert.equal(f.keys(), initialKeys);
    f.render(); const promise = f.consumer().initial; f.render(); f.render();
    const result = await promise; assert.equal(result.snapshot.status, 'ready');
    const renderConsumer = f.props.renderContextConfirmation;
    f.props.renderContextConfirmation = ctx => renderConsumer(ctx);
    f.render(); assert.equal(f.consumer().initial, promise); assert.equal(f.consumer().presented, result);
    assert.equal(f.captures().length, 1); assert.equal(f.posts().length, 0);
    assert.deepEqual(result.review.profile, f.account.profile); assert.ok(Object.isFrozen(result.review.profile));
    assert.equal(result.snapshot.canEdit, false); assert.equal(f.context().sessionGeneration, f.home().sessionGeneration);
    assert.equal(f.context().isCurrentSession, f.home().isCurrentSession);
  } finally { f.dispose(); }
});

test('close before dispatch cancels the issued review and reopening uses the retained controller with a fresh review', async () => {
  const f = await fixture();
  try {
    const first = await enter(f), controller = f.context().confirmation;
    f.context().close(); f.render(); assert.equal(controller.snapshot().status, 'cancelled');
    assert.equal((await first.review.confirm()).snapshot.status, 'stale');
    f.newConsumer(); const second = await enter(f);
    assert.equal(f.context().confirmation, controller); assert.notEqual(second.review, first.review);
    assert.equal(f.captures().length, 2); assert.equal(f.posts().length, 0);
  } finally { f.dispose(); }
});

test('explicit recapture reads actual changed context and invalidates the earlier issued review without persisting edits', async () => {
  const f = await fixture();
  try {
    const first = await enter(f);
    f.account.profile = { ...f.account.profile, revision: 5, goals: ['mobility'] };
    const next = await f.context().confirmation.capture();
    assert.equal(next.review.profile.revision, 5); assert.deepEqual(next.review.profile.goals, ['mobility']);
    assert.equal((await first.review.confirm()).snapshot.status, 'stale');
    assert.equal(f.captures().length, 2); assert.equal(f.calls.some(c => c.method !== 'GET'), false);
    assert.equal(next.review.edit('goals').status, 'unavailable');
    assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
    assert.equal(find(f.render(), 'AccountScreen'), null);
  } finally { f.dispose(); }
});

test('supplied Settings edit target reaches the original callback and requires fresh capture after editing', async () => {
  const edits = [], original = target => edits.push(target);
  const f = await fixture({ openEdit: original });
  try {
    f.home().openSettings(); f.render();
    assert.equal(typeof f.settings().openEdit, 'function');
    f.settings().openEdit('schedule'); assert.deepEqual(edits, ['schedule']);
    const first = await enter(f);
    assert.equal(first.snapshot.canEdit, true);
    assert.equal(first.review.edit('goals').status, 'stale');
    assert.deepEqual(edits, ['schedule', 'goals']);
    assert.equal((await first.review.confirm()).snapshot.status, 'stale');
    assert.equal(f.posts().length, 0); assert.equal(f.captures().length, 1);
    f.account.profile = { ...f.account.profile, revision: 5, goals: ['mobility'] };
    f.account.preferences = { ...f.account.preferences, revision: 8, trainingDaysPerWeek: 4 };
    const next = await f.context().confirmation.capture();
    assert.equal(next.review.profile.revision, 5); assert.equal(next.review.preferences.revision, 8);
    assert.deepEqual(next.review.profile.goals, ['mobility']);
    assert.equal(f.captures().length, 2); assert.equal(f.posts().length, 0);
    assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
  } finally { f.dispose(); }
});

test('removed, replaced and stale Settings callbacks never dispatch or retarget an issued review', async () => {
  for (const boundary of ['removed', 'replaced', 'auth', 'resources', 'unmount']) {
    const edits = [], replacement = [], f = await fixture({ openEdit: target => edits.push(target) });
    try {
      f.home().openSettings(); f.render(); const settings = f.settings();
      const first = await enter(f);
      if (boundary === 'removed') { delete f.props.openEdit; f.render(); }
      else if (boundary === 'replaced') { f.props.openEdit = target => replacement.push(target); f.render(); }
      else if (boundary === 'auth') await f.replaceAuth();
      else if (boundary === 'resources') { f.props.resources = new FormResources(f.api); f.render(); }
      else f.dispose();
      settings.openEdit?.('equipment'); first.review.edit('goals');
      assert.deepEqual(edits, []); assert.deepEqual(replacement, []);
      assert.equal(f.posts().length, 0);
    } finally { f.dispose(); }
  }
});

test('pending and unknown confirmation never dispatch the supplied edit callback', async () => {
  const edits = [], f = await fixture({ openEdit: target => edits.push(target) }), gate = deferred();
  try {
    f.home().openSettings(); f.render(); const settings = f.settings();
    const first = await enter(f); f.post = () => gate.promise;
    const pending = first.review.confirm(); await settle();
    assert.equal(first.review.edit('goals').status, 'pending'); settings.openEdit?.('equipment');
    assert.deepEqual(edits, []);
    gate.reject(new Error('Synthetic acknowledgement lost'));
    assert.equal((await pending).snapshot.status, 'unknown');
    assert.equal(first.review.edit('goals').status, 'unknown'); settings.openEdit?.('equipment');
    assert.deepEqual(edits, []); assert.equal(f.posts().length, 1);
  } finally { gate.resolve(json(receipt())); f.dispose(); }
});

test('pending and unknown save block close and retained Home navigation while retry keeps the exact original key and revisions', async () => {
  const f = await fixture(), gate = deferred();
  try {
    const oldHome = f.home(); oldHome.openPlan('previous_plan');
    const previousBack = find(f.render(), 'PlanEditScreen').props.onBack;
    const ready = await enter(f), controller = f.context().confirmation;
    f.post = () => gate.promise; const pending = ready.review.confirm(); await settle();
    assert.equal(controller.snapshot().status, 'pending');
    for (const leave of [f.context().close, previousBack, oldHome.openSettings, oldHome.openPlans, oldHome.openContextConfirmation]) leave();
    f.render(); assert.equal(f.context().confirmation, controller); assert.equal(find(f.render(), 'PlansScreen'), null);
    assert.equal(f.consumer().initial instanceof Promise, true);
    assert.equal((await controller.capture()).snapshot.status, 'pending');
    assert.equal(f.context().savedFirstPlanDestination({ snapshot: controller.snapshot() }), null);
    gate.reject(new Error('Synthetic acknowledgement lost'));
    assert.equal((await pending).snapshot.status, 'unknown');
    f.context().close(); oldHome.openSettings(); oldHome.openPlan('previous_plan'); f.render();
    assert.equal(find(f.render(), 'PlanEditScreen'), null); assert.equal(controller.snapshot().status, 'unknown');
    f.account.profile.revision = 90; f.account.preferences.revision = 91;
    f.post = () => failure(409, 'stale_revision'); assert.equal((await controller.retry()).snapshot.status, 'unknown');
    f.post = () => json(receipt()); const saved = await controller.retry();
    assert.equal(saved.snapshot.status, 'saved'); assert.ok(Object.isFrozen(saved.receipt));
    assert.equal(f.posts().length, 3); assert.ok(f.posts().every(c => c.key === f.posts()[0].key));
    assert.ok(f.posts().every(c => JSON.stringify(c.body) === JSON.stringify({ profileRevision: 4, preferencesRevision: 7 })));
    assert.equal(f.captures().length, 1);
  } finally { gate.resolve(json(receipt())); f.dispose(); }
});

test('known stale command requires explicit recapture and new explicit confirmation rather than an automatic write', async () => {
  const f = await fixture();
  try {
    const first = await enter(f); f.post = () => failure(409, 'stale_revision');
    assert.equal((await first.review.confirm()).snapshot.status, 'stale'); assert.equal(f.posts().length, 1);
    f.render(); assert.equal(f.captures().length, 1);
    f.account.profile.revision = 5; const next = await f.context().confirmation.capture();
    assert.equal(next.review.profile.revision, 5); assert.equal(f.posts().length, 1);
    f.post = () => { const result = receipt(); result.provenance.profileRevision = 5; return json(result); };
    assert.equal((await next.review.confirm()).snapshot.status, 'saved');
    assert.notEqual(f.posts()[0].key, f.posts()[1].key); assert.equal(f.posts()[1].body.profileRevision, 5);
  } finally { f.dispose(); }
});

test('unconfigured first-plan response remains unavailable without editing fallback or a second create', async () => {
  const f = await fixture();
  try {
    const ready = await enter(f); f.post = () => failure(501, 'first_plan_unavailable');
    const result = await ready.review.confirm(); assert.equal(result.snapshot.status, 'unavailable');
    assert.equal(result.receipt, undefined); assert.equal(f.context().savedFirstPlanDestination(result), null);
    f.render(); assert.equal(f.posts().length, 1); assert.equal(find(f.render(), 'PlanEditScreen'), null);
    assert.equal(find(f.render(), 'AccountScreen'), null);
  } finally { f.dispose(); }
});

test('saved result flows unchanged to the actual destination and failed readback preserves confirmed receipt and previous plan', async () => {
  const f = await fixture();
  try {
    const ready = await enter(f), saved = await ready.review.confirm(), original = JSON.stringify(saved);
    const destination = f.context().savedFirstPlanDestination(saved); assert.ok(destination);
    f.readPlans = () => { throw new Error('Synthetic read unavailable'); };
    assert.deepEqual(await destination.openSavedPlan(), { status: 'unavailable', reason: 'read_failed' });
    assert.equal(JSON.stringify(saved), original); assert.equal(f.context().confirmation.snapshot().effect, 'confirmed');
    assert.equal(f.home().plans[0].id, 'previous_plan'); assert.equal(find(f.render(), 'PlanEditScreen'), null);
    f.readPlans = () => json({ items: [...f.plans, saved.receipt.plan] });
    assert.deepEqual(await destination.openSavedPlan(), { status: 'opened' });
    const editor = find(f.render(), 'PlanEditScreen'); assert.deepEqual(editor.props.plan, saved.receipt.plan);
    assert.ok(f.home().plans.some(p => p.id === 'previous_plan')); assert.equal(f.posts().length, 1);
    assert.equal(f.calls.some(c => c.path.startsWith('/v1/workout') || c.path.startsWith('/v1/history') || c.path.startsWith('/v1/activity')), false);
    editor.props.onBack(); f.render(); assert.equal(f.context().confirmation.snapshot().status, 'saved');
    assert.deepEqual((await f.context().confirmation.capture()).receipt, saved.receipt); assert.equal(f.posts().length, 1);
  } finally { f.dispose(); }
});

test('same-account auth replacement hides Context presentation and old review actions cannot dispatch', async () => {
  const f = await fixture();
  try {
    const ready = await enter(f), ctx = f.context(), before = f.calls.length;
    await f.replaceAuth(); assert.equal(ctx.isCurrentSession(), false);
    let presented = false; f.props.renderContextConfirmation = () => { presented = true; return 'should-not-render'; };
    f.render(); assert.equal(presented, false);
    assert.equal((await ready.review.confirm()).snapshot.status, 'stale');
    assert.equal((await ctx.confirmation.capture()).review, undefined); ctx.close();
    assert.equal(f.calls.length, before); assert.equal(f.posts().length, 0);
  } finally { f.dispose(); }
});

test('late success and error after original session loss keep unknown effect but expose no receipt or retry', async () => {
  for (const boundary of ['auth', 'resources', 'unmount']) for (const outcome of ['success', 'error']) {
    const f = await fixture(), gate = deferred();
    try {
      const ready = await enter(f), ctx = f.context(); f.post = () => gate.promise;
      const pending = ready.review.confirm(); await settle();
      if (boundary === 'auth') await f.replaceAuth();
      else if (boundary === 'resources') { f.props.resources = new FormResources(f.api); f.render(); await settle(); f.render(); }
      else f.dispose();
      if (outcome === 'success') gate.resolve(json(receipt())); else gate.reject(new Error('Late synthetic error'));
      const result = await pending;
      assert.equal(result.snapshot.status, 'stale'); assert.equal(result.snapshot.effect, 'unknown');
      assert.equal(result.review, undefined); assert.equal(result.receipt, undefined); assert.equal(result.snapshot.canRetry, false);
      await ctx.confirmation.retry(); assert.equal(f.posts().length, 1); assert.equal(ctx.savedFirstPlanDestination(result), null);
    } finally { gate.resolve(json(receipt())); f.dispose(); }
  }
});

test('closing a loading consumer hides its late review without disposing the original session controller', async () => {
  const f = await fixture(), gate = deferred();
  try {
    f.readAccount = () => gate.promise; f.home().openContextConfirmation(); f.render();
    const pending = f.consumer().initial, ctx = f.context(); await settle();
    ctx.close(); f.render(); gate.resolve(json(f.account));
    const result = await pending; assert.equal(result.snapshot.status, 'cancelled'); assert.equal(result.review, undefined);
    f.readAccount = null; f.newConsumer(); const next = await enter(f);
    assert.equal(f.context().confirmation, ctx.confirmation); assert.equal(next.snapshot.status, 'ready'); assert.equal(f.posts().length, 0);
  } finally { gate.resolve(json(f.account)); f.dispose(); }
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


test('actual mounted source receipt stays saved while absent source destination never opens a legacy editor', async () => {
  const f = await fixture();
  try {
    f.post = () => json(sourceReceipt());
    const ready = await enter(f), saved = await ready.review.confirm();
    assert.equal(saved.snapshot.status, 'saved'); assert.deepEqual(saved.receipt, sourceReceipt());
    assert.ok(Object.isFrozen(saved.receipt.plan.items[0].registeredDomain.identity));
    const calls = f.calls.length;
    assert.equal(f.context().savedFirstPlanDestination(saved), null);
    f.render(); assert.equal(find(f.render(), 'PlanEditScreen'), null);
    assert.equal(f.home().plans[0].id, 'previous_plan'); assert.equal(f.calls.length, calls); assert.equal(f.posts().length, 1);
    assert.deepEqual((await f.context().confirmation.capture()).receipt, saved.receipt);
    assert.equal(f.posts().length, 1);
  } finally { f.dispose(); }
});


test('replacement or newly supplied edit port serves a fresh review without reviving the old review', async () => {
  for (const initiallyPresent of [true, false]) {
    const oldEdits = [], newEdits = [];
    const f = await fixture({ ...(initiallyPresent ? { openEdit: target => oldEdits.push(target) } : {}) });
    try {
      const original = await enter(f), retained = f.context().confirmation;
      f.props.openEdit = target => newEdits.push(target); f.render();
      original.review.edit('goals');
      assert.deepEqual(oldEdits, []); assert.deepEqual(newEdits, []);
      f.context().close(); f.render(); f.newConsumer();
      const next = await enter(f);
      assert.notEqual(f.context().confirmation, retained);
      assert.equal(next.snapshot.canEdit, true);
      next.review.edit('equipment');
      assert.deepEqual(newEdits, ['equipment']); assert.deepEqual(oldEdits, []);
      assert.equal(f.posts().length, 0);
    } finally { f.dispose(); }
  }
});

test('edit port replacement preserves pending, unknown and confirmed original command custody', async () => {
  const f = await fixture({ openEdit: () => {} }), gate = deferred();
  try {
    const original = await enter(f), retained = f.context().confirmation;
    f.post = () => gate.promise; const pending = original.review.confirm(); await settle();
    f.props.openEdit = () => {}; f.render(); f.home().openContextConfirmation(); f.render();
    assert.equal(f.context().confirmation, retained);
    gate.reject(new Error('Synthetic acknowledgement lost')); await pending;
    f.props.openEdit = () => {}; f.render(); f.home().openContextConfirmation(); f.render();
    assert.equal(f.context().confirmation, retained); assert.equal(retained.snapshot().effect, 'unknown');
    f.post = () => json(receipt()); await retained.retry();
    f.context().close(); f.render(); f.newConsumer(); await enter(f);
    assert.equal(f.context().confirmation, retained); assert.equal(retained.snapshot().effect, 'confirmed');
    assert.deepEqual(f.posts()[1].body, f.posts()[0].body); assert.equal(f.posts()[1].key, f.posts()[0].key);
  } finally { gate.resolve(json(receipt())); f.dispose(); }
});
