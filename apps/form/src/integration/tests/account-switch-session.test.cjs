const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const jsx = (type, props, key) => ({ type, props, key });
const names = new Proxy({}, { get: (_, name) => name });
const tokens = new Proxy({}, { get: () => tokens });
const noop = () => {};
const json = value => new Response(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }

// Actual components and resources are transpiled in memory; only native/UI leaves are mocked.
// Each explicitly mounted component owns separate hook slots, including a new email screen after sign-out.
function harness() {
  let active;
  const instances = [];
  const changed = (old, deps) => !old || deps.length !== old.deps.length || deps.some((v, i) => !Object.is(v, old.deps[i]));
  const react = {
    useState(initial) { const h = active, i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [h.slots[i], value => {
        const apply = () => { h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value; };
        if (h.holdRoutes && Array.isArray(h.slots[i]) && typeof h.slots[i].at(-1)?.name === 'string') h.routeUpdates.push(apply);
        else apply();
      }]; },
    useRef(initial) { const h = active, i = h.cursor++; return h.slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const h = active, i = h.cursor++; if (changed(h.slots[i], deps)) h.slots[i] = { deps, value: fn() }; return h.slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const h = active, i = h.cursor++, old = h.slots[i]; if (changed(old, deps)) h.effects.push(() => {
      old?.cleanup?.(); h.slots[i] = { deps, cleanup: fn() }; }); },
  };
  react.useLayoutEffect = react.useEffect;
  return { react, mount() {
    const h = { slots: [], cursor: 0, effects: [], holdRoutes: false, routeUpdates: [] }; instances.push(h);
    return { render(Component, props) { active = h; h.cursor = 0; h.effects = []; const node = Component(props);
      for (const effect of h.effects) effect(); return node; },
    data: () => h.slots.find(slot => slot && Object.hasOwn(slot, 'plans') && Object.hasOwn(slot, 'account')),
    routes: () => h.slots.find(slot => Array.isArray(slot) && typeof slot.at(-1)?.name === 'string'),
    holdRoutes() { h.holdRoutes = true; },
    flushRoutes() { h.holdRoutes = false; for (const apply of h.routeUpdates.splice(0)) apply(); },
    dispose() { for (const slot of h.slots) slot?.cleanup?.(); h.slots = []; } };
  }, dispose() { for (const h of instances) for (const slot of h.slots) slot?.cleanup?.(); } };
}
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
      if (name.endsWith('/client') || name === './client') return { ...load('api/transport.ts'), formApi: null, commandKey: () => 'synthetic-command' };
      const target = path.resolve(path.dirname(file), name);
      const next = fs.existsSync(target + '.ts') ? target + '.ts' : target + '.tsx';
      return load(path.relative(root, next));
    }, module, module.exports);
    return module.exports;
  }
  return load;
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of [tree.props?.children, tree.props?.actions, tree.props?.nav].flat(Infinity)) {
    const found = find(child, predicate); if (found) return found;
  }
  return null;
}
const byId = (tree, id) => { const node = find(tree, n => n.props?.testID === id || n.props?.captureId === id);
  assert.ok(node, `Missing actual component element ${id}`); return node; };
function account(id) {
  return { accountId: id, onboarding: { status: 'completed' }, profile: { revision: 4, name: id, age: null,
    heightCm: null, weightKg: null, trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
  preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
    coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['dumbbell'], remindersEnabled: false } };
}
async function fixture({ voiceExit, activitySlot = false, lifecycle = false } = {}) {
  const h = harness(), shell = h.mount(), calls = [], saves = [], clears = [];
  let home, settings, activity;
  const native = { StyleSheet: { create: value => value }, View: 'View', Pressable: 'Pressable',
    AccessibilityInfo: {}, AppState: { addEventListener: () => ({ remove: noop }) } };
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
    '../../integration/sharedVoice': { captureSharedVoiceScope: (_api, account, isCurrent) => ({ account, isCurrent }) },
    '../../native/speech': { FormSpeechAdapter: function () { return { dispose: async () => {}, cancel: async () => {} }; } },
    '../account/AccountScreens': names, '../cues/CuesScreen': names, '../onboarding/OnboardingFlow': names,
    '../plans/PlansScreens': names, '../shared/tokens': { t: tokens, L: tokens }, '../shared/ui': names,
    '../features/shared/tokens': { t: tokens, L: tokens }, '../features/shared/ui': names,
    '../variants/a/components': names, '../variants/a/theme': { useTextScale: () => ({ large: false }) } };
  const load = loader(mocks), transport = load('api/transport.ts');
  // These exact exports are shared by every module; instanceof ApiError remains meaningful.
  const { FormTransport, ApiError } = transport, { FormResources } = load('api/resources.ts');
  const f = { id: 'A', signOutResponse: null, profileResponse: null, readResponse: null, voiceEvents: [], lifecycleBindings: [],
    onSignOutDispatch: null };
  const api = new FormTransport('https://form.example.invalid', {
    async load() { return JSON.stringify({ version: 1, baseURL: 'https://form.example.invalid', token: 'synthetic-A' }); },
    async save(value) { saves.push(JSON.parse(value).token); }, async clear() { clears.push(true); },
  }, async (url, init) => {
    const call = { path: new URL(url).pathname, method: init.method, authorization: init.headers.Authorization,
      body: init.body, key: init.headers['Idempotency-Key'] }; calls.push(call);
    if (call.path === '/api/auth/sign-in/email') return new Response('{}', { headers: { 'set-auth-token': `synthetic-${f.id}-fresh` } });
    if (call.path === '/api/auth/sign-out') { f.onSignOutDispatch?.(call); return f.signOutResponse ? f.signOutResponse() : json({ success: true }); }
    if (call.path === '/v1/capabilities') return json({ authentication: { emailPassword: { registration: 'closed' },
      apple: { status: 'unconfigured' }, google: { status: 'unconfigured' }, phone: { status: 'unconfigured' } } });
    if (call.path === '/v1/me') return f.readResponse ? f.readResponse() : json(account(f.id));
    if (call.path === '/v1/me/profile' && call.method === 'PATCH') return f.profileResponse ? f.profileResponse() : json(account(f.id).profile);
    if (call.path === '/v1/me/settings') return json({ accountId: f.id, identity: { displayName: f.id, email: `${f.id}@example.invalid`, phoneNumber: null, signInMethods: ['email'] } });
    if (call.path === '/v1/entitlements') return json({ accountId: f.id, grants: [] });
    if (call.path === '/v1/exercises') return json({ items: [{ id: `exercise-${f.id}` }] });
    if (call.path === '/v1/plans') return json({ items: [{ id: `plan-${f.id}`, revision: 1, name: `Private ${f.id}`, minutes: 30,
      items: [{ id: `item-${f.id}`, exerciseId: `exercise-${f.id}`, setTarget: 1, repMin: 5, repMax: 8, targetKg: 0 }],
      archived: false, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' }] });
    assert.fail(`Unexpected actual transport request: ${call.method} ${call.path}`);
  });
  const resources = new FormResources(api), { FormAccountApp } = load('features/shell/FormAccountApp.tsx');
  const { AuthFlow } = load('features/auth/AuthFlow.tsx'), { SettingsScreen } = load('settings/SettingsScreen.tsx');
  const props = { resources, appMode: 'basic', renderHome: ctx => { home = ctx; return 'home'; },
    ...(voiceExit ? { onBeforeVoiceExit(input) {
      f.voiceEvents.push({ ...input, currentBeforeExit: input.scope.isCurrent(), routesBeforeExit: shell.routes(),
        accountBeforeExit: shell.data()?.account?.accountId }); voiceExit(input);
    } } : {}),
    ...(activitySlot ? { renderActivity: ctx => { activity = ctx; return 'activity'; } } : {}),
    ...(lifecycle ? { lifecycleSession(binding) { f.lifecycleBindings.push(binding); return { dispose: noop }; } } : {}),
    renderSettings: ctx => { settings = ctx; return 'settings'; } };
  const render = () => shell.render(FormAccountApp, props);
  const renderSettings = () => {
    const mount = h.mount(); let component;
    return { render() { const entry = SettingsScreen(settings); component = entry.type; return mount.render(component, entry.props); }, dispose: mount.dispose };
  };
  function authView() {
    const entry = render(); assert.equal(entry.type, AuthFlow);
    const flow = h.mount(), email = h.mount();
    return { render() { return flow.render(AuthFlow, entry.props); },
      email() { const node = flow.render(AuthFlow, entry.props); return email.render(node.type, node.props); },
      dispose() { email.dispose(); flow.dispose(); } };
  }
  Object.assign(f, { api, ApiError, resources, calls, saves, clears, render, renderSettings, authView,
    createStandardVoiceConsumer: load('voice-coaching/standard/controller.ts').createStandardVoiceConsumer,
    home: () => home, settings: () => settings, activity: () => activity, data: shell.data, routes: shell.routes, dispose: h.dispose,
    holdRoutes: shell.holdRoutes, flushRoutes: shell.flushRoutes,
    async signIn(id) {
      f.id = id; const view = authView();
      try {
        const entry = view.render(); const signInMount = h.mount();
        const signIn = signInMount.render(entry.type, entry.props);
        byId(signIn, 'a-signin-email').props.onPress();
        let tree = view.email();
        assert.equal(byId(tree, 'a-email-field').props.value, '');
        assert.equal(byId(tree, 'a-password-field').props.value, '');
        byId(tree, 'a-email-field').props.onChangeText(`${id}@example.invalid`);
        byId(tree, 'a-password-field').props.onChangeText('synthetic-password');
        tree = view.email(); byId(tree, 'a-email-submit').props.onPress(); await settle(); render(); await settle(); render();
        signInMount.dispose();
      } finally { view.dispose(); }
    },
  });
  render(); await settle(); render(); await settle(); render();
  home.openSettings(); render(); calls.length = 0;
  return f;
}

test('actual Settings cancel preserves A; confirmed sign-out clears caches and routes and mounts empty actual email fields before B', async () => {
  const f = await fixture(); let view;
  try {
    const oldHome = f.home(), oldSettings = f.settings(), oldData = f.data(); view = f.renderSettings();
    let tree = view.render(); byId(tree, 'a-sign-out').props.onPress(); tree = view.render();
    assert.equal(byId(tree, 'a-signout-sheet').props.visible, true);
    byId(tree, 'a-signout-cancel').props.onPress(); tree = view.render();
    assert.equal(byId(tree, 'a-signout-sheet').props.visible, false);
    assert.equal(f.calls.length, 0); assert.equal(f.data(), oldData); assert.equal(oldHome.isCurrentSession(), true);
    byId(tree, 'a-sign-out').props.onPress(); tree = view.render();
    byId(tree, 'a-signout-confirm').props.onPress(); await settle(); f.render();
    assert.equal(f.calls.filter(c => c.path === '/api/auth/sign-out').length, 1); assert.equal(f.clears.length, 1);
    assert.deepEqual(f.data(), { account: null, entitlements: null, settings: null, plans: [], exercises: [], plansError: null });
    assert.deepEqual(f.routes(), [{ name: 'home' }]); assert.equal(oldHome.isCurrentSession(), false);
    view.dispose(); view = null;
    await f.signIn('B'); assert.equal(f.data().account.accountId, 'B'); assert.equal(f.home().account.accountId, 'B');
    assert.notEqual(f.home().sessionGeneration, oldHome.sessionGeneration);
    assert.deepEqual(f.data().plans.map(p => p.id), ['plan-B']); assert.deepEqual(f.data().exercises.map(e => e.id), ['exercise-B']);
    assert.ok(f.saves.includes('synthetic-B-fresh')); assert.deepEqual(f.routes(), [{ name: 'home' }]);
    const before = f.calls.length;
    oldHome.openSettings(); oldHome.openPlans(); oldSettings.openAccess(); oldSettings.close(); await oldSettings.reload();
    assert.equal((await oldSettings.saveProfile({ name: 'A retained' })).status, 'failed');
    assert.equal((await oldSettings.signOut()).status, 'failed');
    await assert.rejects(oldSettings.resources.account(), { code: 'session_changed' });
    assert.equal(f.calls.length, before); assert.equal(f.data().account.accountId, 'B'); assert.deepEqual(f.routes(), [{ name: 'home' }]);
  } finally { view?.dispose(); f.dispose(); }
});

test('unknown sign-out retains original token and account; only explicit retry sends the same original revocation', async () => {
  const f = await fixture();
  try {
    f.signOutResponse = () => Promise.reject(new Error('synthetic lost acknowledgement'));
    const result = await f.settings().signOut(); assert.equal(result.status, 'unknown');
    f.render(); await settle();
    assert.equal(f.data().account.accountId, 'A'); assert.equal(f.clears.length, 0); assert.equal(f.saves.length, 0);
    const commands = () => f.calls.filter(c => c.path === '/api/auth/sign-out');
    assert.equal(commands().length, 1); assert.equal(commands()[0].authorization, 'Bearer synthetic-A');
    f.signOutResponse = null;
    assert.equal((await result.retry()).status, 'saved'); f.render();
    assert.deepEqual(commands()[1], commands()[0]); assert.equal(f.data().account, null); assert.equal(f.clears.length, 1);
    await f.signIn('B'); const before = f.calls.length;
    assert.equal((await result.retry()).status, 'failed'); assert.equal(f.calls.length, before); assert.equal(f.data().account.accountId, 'B');
  } finally { f.dispose(); }
});

for (const nextId of ['B', 'A']) test(`late A reads, writes and unknown retries cannot publish or dispatch after fresh ${nextId} authentication`, async () => {
  const f = await fixture();
  try {
    const oldHome = f.home(), oldSettings = f.settings(), read = deferred(), write = deferred();
    f.readResponse = () => read.promise; f.profileResponse = () => write.promise;
    const pendingRead = oldSettings.resources.account().then(value => ({ value }), error => ({ error }));
    const pendingWrite = oldSettings.saveProfile({ name: 'Late private A' }); await settle();
    f.profileResponse = () => Promise.reject(new Error('synthetic uncertain profile'));
    const unknown = await oldSettings.saveProfile({ name: 'Unknown private A' }); assert.equal(unknown.status, 'unknown');
    assert.equal((await oldSettings.signOut()).status, 'saved'); f.render();
    f.readResponse = null; f.profileResponse = null; await f.signIn(nextId);
    read.resolve(json(account('A'))); write.resolve(json({ ...account('A').profile, name: 'Late private A' }));
    const readResult = await pendingRead, writeResult = await pendingWrite;
    assert.ok(readResult.error instanceof f.ApiError); assert.equal(readResult.error.code, 'session_changed');
    assert.equal(writeResult.status, 'failed'); assert.equal(writeResult.error.code, 'session_changed');
    assert.equal(writeResult.error.originalEffectUnknown, true);
    const before = f.calls.length;
    assert.equal((await unknown.retry()).status, 'failed'); oldHome.openPlans(); oldHome.openSettings(); await oldSettings.reload();
    await assert.rejects(oldSettings.resources.profile(account('A').profile, { name: 'Retained A' }), { code: 'session_changed' });
    assert.equal(f.calls.length, before); f.render(); assert.equal(oldHome.isCurrentSession(), false);
    assert.equal(f.data().account.accountId, nextId); assert.equal(f.data().account.profile.name, nextId);
    assert.deepEqual(f.data().plans.map(p => p.id), [`plan-${nextId}`]); assert.deepEqual(f.routes(), [{ name: 'home' }]);
  } finally { f.dispose(); }
});


function voiceConsumer(f, scope, pending = false) {
  const entered = deferred(), completion = deferred(); let signal;
  const consumer = f.createStandardVoiceConsumer({ scope, newSessionId: () => 'synthetic-voice-exit', onManual: noop,
    host: { async startStandard(captured, _id, abortSignal) {
      signal = abortSignal;
      return { fence: { ...captured.account, generation: 1 }, assertCurrent() {}, startCapture: async () => {},
        finishCapture: async () => new Blob([new Uint8Array([1])], { type: 'audio/wav' }), play: async () => {},
        stop: async () => ({ status: 'released', failedSteps: [] }) };
    } },
    turn: { async run() { entered.resolve(); return pending ? completion.promise : voiceResult(); } },
  });
  return { consumer, entered, completion, signal: () => signal };
}
function voiceResult() { return { outcome: { kind: 'succeeded', value: { audio: new Uint8Array([1]), mediaType: 'audio/wav' } },
  accounting: 'settled', review: { transcript: 'synthetic private review' } }; }

for (const pending of [true, false]) test(`voice exit admitted shell navigation ${pending ? 'aborts a pending turn' : 'clears review'} before held route state`, async () => {
  let voice;
  const f = await fixture({ activitySlot: true, voiceExit: input => { void voice?.consumer.stop(input.reason); } });
  let sending;
  try {
    f.home().openActivity(); f.render();
    const scope = f.activity().voiceScope; voice = voiceConsumer(f, scope, pending);
    await voice.consumer.start(); sending = voice.consumer.finishAndSend(); await voice.entered.promise;
    if (!pending) { await sending; assert.ok(voice.consumer.review()); }
    f.voiceEvents.length = 0; const routes = f.routes(); f.holdRoutes();
    f.home().openSettings();
    assert.equal(voice.signal().aborted, true); assert.equal(voice.consumer.review(), null);
    assert.equal(f.routes(), routes); assert.equal(f.voiceEvents.length, 1);
    assert.equal(f.voiceEvents[0].reason, 'navigation'); assert.equal(f.voiceEvents[0].scope, scope);
    assert.equal(f.voiceEvents[0].currentBeforeExit, true);
    voice.completion.resolve(voiceResult()); await sending;
    assert.equal(voice.consumer.review(), null); f.flushRoutes(); f.render();
    assert.equal(f.routes().at(-1).name, 'settings');
  } finally { voice?.completion.resolve(voiceResult()); await sending; await voice?.consumer.dispose(); f.dispose(); }
});

test('voice exit epoch-first shell reset selects the original scope before its account epoch expires', async () => {
  const f = await fixture({ voiceExit: noop, lifecycle: true });
  try {
    const original = f.lifecycleBindings.at(-1).voiceScope; assert.equal(original.isCurrent(), true);
    f.voiceEvents.length = 0; f.holdRoutes(); const routes = f.routes();
    const cleanup = f.lifecycleBindings.at(-1).claimAccessDisabled();
    const exit = f.voiceEvents.find(event => event.scope === original);
    assert.ok(exit, 'The original voice scope must be selected before epoch-first reset.');
    assert.equal(exit.currentBeforeExit, true); assert.equal(exit.accountBeforeExit, 'A'); assert.equal(exit.routesBeforeExit, routes);
    assert.equal(original.isCurrent(), false); assert.equal(cleanup.isCurrent(), true); assert.equal(f.data().account, null);
    f.flushRoutes();
  } finally { f.dispose(); }
});

test('voice exit actual Settings cancellation emits nothing; confirmation emits logout before actual transport dispatch', async () => {
  const f = await fixture({ activitySlot: true, voiceExit: noop }); let view;
  try {
    f.home().openActivity(); f.render(); const scope = f.activity().voiceScope;
    f.home().openSettings(); f.render(); f.voiceEvents.length = 0;
    const dispatchEvents = []; f.onSignOutDispatch = () => dispatchEvents.push([...f.voiceEvents]);
    view = f.renderSettings(); let tree = view.render();
    byId(tree, 'a-sign-out').props.onPress(); tree = view.render(); byId(tree, 'a-signout-cancel').props.onPress(); tree = view.render();
    assert.equal(f.voiceEvents.length, 0); assert.equal(dispatchEvents.length, 0);
    byId(tree, 'a-sign-out').props.onPress(); tree = view.render(); byId(tree, 'a-signout-confirm').props.onPress();
    await settle(); f.render();
    assert.equal(dispatchEvents.length, 1); const logout = dispatchEvents[0].find(event => event.reason === 'logout');
    assert.ok(logout, 'Confirmed logout must stop its captured voice scope before API dispatch.');
    assert.equal(logout.scope, scope); assert.equal(logout.currentBeforeExit, true); assert.equal(logout.accountBeforeExit, 'A');
    assert.equal(f.data().account, null); assert.equal(f.clears.length, 1);
  } finally { view?.dispose(); f.dispose(); }
});

test('voice exit unknown logout retains original shell and bearer; explicit retry remains exact and cannot target B', async () => {
  const f = await fixture({ activitySlot: true, voiceExit: noop });
  try {
    f.home().openActivity(); f.render(); const scope = f.activity().voiceScope;
    f.home().openSettings(); f.render(); f.voiceEvents.length = 0;
    const dispatchEvents = []; f.onSignOutDispatch = () => dispatchEvents.push([...f.voiceEvents]);
    f.signOutResponse = () => Promise.reject(new Error('synthetic uncertain logout'));
    const unknown = await f.settings().signOut(); assert.equal(unknown.status, 'unknown');
    assert.equal(f.data().account.accountId, 'A'); assert.equal(f.clears.length, 0); assert.equal(f.saves.length, 0);
    assert.ok(dispatchEvents[0].some(event => event.reason === 'logout' && event.scope === scope));
    const commands = () => f.calls.filter(call => call.path === '/api/auth/sign-out');
    const originalCommand = commands()[0]; assert.equal(originalCommand.authorization, 'Bearer synthetic-A');
    f.signOutResponse = null; assert.equal((await unknown.retry()).status, 'saved'); f.render();
    assert.deepEqual(commands()[1], originalCommand);
    assert.ok(dispatchEvents[1].some(event => event.reason === 'logout' && event.scope === scope));
    await f.signIn('B'); const before = f.calls.length, exits = f.voiceEvents.length;
    assert.equal((await unknown.retry()).status, 'failed'); assert.equal(f.calls.length, before); assert.equal(f.voiceEvents.length, exits);
    assert.equal(f.data().account.accountId, 'B');
  } finally { f.dispose(); }
});
