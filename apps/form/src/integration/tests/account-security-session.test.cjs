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
function account() {
  return { accountId: 'original', onboarding: { status: 'completed' },
    profile: { revision: 4, name: 'Original', age: null, heightCm: null, weightKg: null, trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'direct',
      communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['dumbbell'], remindersEnabled: false } };
}
function hooks() {
  const slots = [], dataUpdates = [], routeWrites = [], routeUpdates = [];
  let cursor = 0, effects = [], holdData = false, holdRoutes = false;
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
        if (holdRoutes && Array.isArray(slots[i]) && typeof slots[i].at(-1)?.name === 'string') routeUpdates.push(apply);
        else if (holdData && slots[i] && Object.hasOwn(slots[i], 'plans') && Object.hasOwn(slots[i], 'account')) dataUpdates.push(apply);
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
    holdRoutes() { holdRoutes = true; },
    flushRoutes() { holdRoutes = false; for (const apply of routeUpdates.splice(0)) apply(); },
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


const { captureAccountSecuritySession } = load('integration/accountSecuritySession.ts');
const { createChangePasswordController } = load('features/credentials/model.ts');
const password = 'synthetic-new-password';
async function fixture({ slots = true, contextRenderer = false } = {}) {
  const h = hooks(), calls = [], saves = [];
  let home, settings, security, membership, health, keys = 0;
  const f = { currentAccount: account(), passwordResponse: null, accountRead: null, saveStorage: null };
  const api = new FormTransport('https://form.example.invalid', {
    async load() { return JSON.stringify({ version: 1, baseURL: 'https://form.example.invalid', token: 'synthetic-original' }); },
    async save(value) { saves.push(JSON.parse(value).token); if (f.saveStorage) await f.saveStorage(); }, async clear() {},
  }, async (url, init) => {
    const call = { path: new URL(url).pathname, method: init.method, authorization: init.headers.Authorization };
    calls.push(call);
    if (call.path === '/api/auth/sign-in/email') return new Response('{}', { headers: { 'set-auth-token': 'synthetic-foreign' } });
    if (call.path === '/api/auth/change-password') return f.passwordResponse ? f.passwordResponse() :
      new Response('{}', { headers: { 'set-auth-token': 'synthetic-password-replacement' } });
    if (call.path === '/api/auth/sign-out') return json({ success: true });
    if (call.path === '/v1/capabilities') return json({});
    if (call.path === '/v1/me') return f.accountRead ? f.accountRead() : json(f.currentAccount);
    if (call.path === '/v1/me/settings' || call.path === '/v1/entitlements') return json({ accountId: f.currentAccount.accountId });
    if (call.path === '/v1/exercises' || call.path === '/v1/plans') return json({ items: [] });
    assert.fail('Unexpected actual transport request: ' + call.method + ' ' + call.path);
  });
  const resources = new FormResources(api);
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
    '../../api/client': { ...transport, commandKey: () => 'synthetic-key-' + (++keys) }, '../api/transport': transport,
    './transport': transport,
    '../../integration/sharedVoice': { captureSharedVoiceScope: (_api, account, isCurrent) => ({ account, isCurrent }) },
    '../../native/speech': { FormSpeechAdapter: function () { return speech; } },
    '../account/AccountScreens': names, '../auth/AuthFlow': names, '../cues/CuesScreen': names,
    '../onboarding/OnboardingFlow': names, '../plans/PlansScreens': names,
    '../shared/copy': { COPY: {}, errorCopy: error => error.message }, '../shared/tokens': { t: tokens, L: tokens }, '../shared/ui': names };
  const { FormAccountApp } = loader(mocks)('features/shell/FormAccountApp.tsx');
  const props = { resources, appMode: 'basic', renderHome: ctx => { home = ctx; return 'home'; },
    ...(contextRenderer ? { renderContextConfirmation: () => jsx('ContextConfirmation', {}) } : {}),
    renderSettings: ctx => { settings = ctx; return 'settings'; }, ...(slots ? {
      renderAccountSecurity: ctx => { security = ctx; return jsx('Security', { ctx }); },
      renderMembership: ctx => { membership = ctx; return jsx('Membership', { ctx }); },
      renderHealth: ctx => { health = ctx; return jsx('Health', { ctx }); },
    } : {}) };
  Object.assign(f, { api, resources, props, calls, saves, render: () => h.render(FormAccountApp, props), dispose: h.dispose,
    home: () => home, settings: () => settings, security: () => security, membership: () => membership, health: () => health,
    data: h.data, replaceAuth: () => api.signIn('synthetic@example.invalid', 'synthetic'),
    holdRoutes: h.holdRoutes, flushRoutes: h.flushRoutes,
    mutations: () => calls.filter(call => call.path === '/api/auth/change-password'),
    async enter() { home.openSettings(); f.render(); settings.openAccountSecurity(); f.render(); return security; },
  });
  f.render(); await settle(); f.render(); await settle(); f.render();
  home.openSettings(); f.render(); calls.length = 0;
  return f;
}

test('optional account routes are absent-safe, admit exact supplied renderers and permanently fence removal', async () => {
  const absent = await fixture({ slots: false });
  try {
    for (const key of ['openAccountSecurity', 'openMembership', 'openHealth']) assert.equal(absent.settings()[key], undefined);
  } finally { absent.dispose(); }
  for (const name of ['Membership', 'Health', 'AccountSecurity']) {
    const f = await fixture();
    try {
      f.settings()['open' + name](); assert.ok(find(f.render(), name === 'AccountSecurity' ? 'Security' : name));
      const ctx = name === 'AccountSecurity' ? f.security() : name === 'Membership' ? f.membership() : f.health();
      assert.equal(ctx.isCurrentSession(), true);
      const render = f.props['render' + name]; delete f.props['render' + name]; f.render();
      assert.equal(ctx.isCurrentSession(), false);
      f.props['render' + name] = render; f.render(); assert.equal(ctx.isCurrentSession(), false);
      const count = f.calls.length; ctx.close(); if (ctx.onSignedOut) ctx.onSignedOut();
      assert.equal(f.calls.length, count); assert.equal(f.data().account.accountId, 'original');
    } finally { f.dispose(); }
  }
});

test('own beginAuth and signed-header storage preserve controller publication; explicit reads create fresh Settings', async () => {
  const f = await fixture();
  try {
    const oldHome = f.home(), oldSettings = f.settings(), ctx = await f.enter();
    const controller = createChangePasswordController(ctx.credentials), saved = deferred();
    f.saveStorage = () => saved.promise;
    const command = controller.submit('synthetic-current', password, password); await settle();
    assert.equal(oldHome.isCurrentSession(), false); assert.equal(ctx.isCurrentSession(), true);
    assert.equal(controller.snapshot().status, 'pending'); assert.equal(controller.transition(), null);
    ctx.close(); await settle(); assert.ok(find(f.render(), 'Security'));
    saved.resolve(); await command;
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(controller.transition().reason, 'password-changed');
    assert.ok(f.saves.includes('synthetic-password-replacement')); assert.equal(f.mutations().length, 1);
    const read = deferred(); f.accountRead = () => read.promise;
    const returning = ctx.reload(); await settle(); assert.ok(find(f.render(), 'Security'));
    assert.equal(f.home().sessionGeneration, oldHome.sessionGeneration);
    read.resolve(json(account())); await returning; f.render();
    assert.notEqual(f.home().sessionGeneration, oldHome.sessionGeneration);
    assert.equal(f.settings().account.accountId, 'original'); assert.equal(ctx.isCurrentSession(), false);
    await settle(); f.render();
    const count = f.calls.length;
    oldHome.openSettings(); oldSettings.openAccountSecurity(); ctx.onSignedOut(); await ctx.reload();
    assert.equal((await oldSettings.signOut()).status, 'failed'); assert.equal(f.calls.length, count);
    assert.equal(f.data().account.accountId, 'original'); controller.dispose();
  } finally { f.dispose(); }
});

test('wrong passwords remain correctable without ordinary callback revival; unknown reconciliation never replays mutation', async () => {
  for (const unknown of [false, true]) {
    const f = await fixture();
    try {
      const oldHome = f.home(), ctx = await f.enter(), controller = createChangePasswordController(ctx.credentials);
      f.passwordResponse = () => unknown ? Promise.reject(new Error('synthetic unavailable')) : json({ code: 'INVALID_PASSWORD' }, 400);
      await controller.submit('synthetic-current', password, password);
      assert.equal(controller.snapshot().status, unknown ? 'unknown' : 'failed');
      assert.equal(ctx.isCurrentSession(), true); assert.equal(oldHome.isCurrentSession(), false); assert.equal(controller.transition(), null);
      if (unknown) {
        await controller.submit('synthetic-current', password, password); assert.equal(f.mutations().length, 1);
        await ctx.reload(); f.render(); assert.equal(f.mutations().length, 1);
      } else {
        f.passwordResponse = null; await controller.submit('synthetic-current', password, password);
        assert.equal(controller.snapshot().status, 'saved'); assert.equal(f.mutations().length, 2);
      }
      controller.dispose();
    } finally { f.dispose(); }
  }
});

test('foreign auth before mutation or during storage expires private view and never adopts replacement bearer', async () => {
  for (const duringStorage of [false, true]) {
    const f = await fixture();
    try {
      const ctx = await f.enter(), controller = createChangePasswordController(ctx.credentials);
      let command, gate;
      if (duringStorage) {
        gate = deferred(); f.saveStorage = () => gate.promise;
        command = controller.submit('synthetic-current', password, password); await settle();
      }
      const foreign = f.replaceAuth();
      assert.equal(ctx.isCurrentSession(), false); assert.equal(f.data().account, null);
      ctx.onSignedOut(); ctx.close(); await ctx.reload();
      if (gate) { f.saveStorage = null; gate.resolve(); await command; }
      await foreign;
      await controller.submit('synthetic-current', password, password);
      assert.equal(controller.snapshot().status, 'disposed'); assert.equal(controller.transition(), null);
      assert.equal(f.mutations().length, duringStorage ? 1 : 0);
      const before = f.calls.length; await ctx.resources.account().catch(() => {}); assert.equal(f.calls.length, before);
      assert.ok(find(f.render(), 'AuthFlow')); controller.dispose();
    } finally { f.dispose(); }
  }
});

test('foreign auth during settled account reads discards late data without clearing the new session', async () => {
  const f = await fixture();
  try {
    const ctx = await f.enter(); await ctx.credentials.changePassword({ currentPassword: 'synthetic-current', newPassword: password });
    const read = deferred(); f.accountRead = () => read.promise;
    const returning = ctx.reload(); await settle();
    await f.replaceAuth(); f.currentAccount = { ...account(), accountId: 'replacement' };
    read.resolve(json(account())); await returning;
    assert.equal(f.data().account, null); assert.equal(ctx.isCurrentSession(), false);
    ctx.onSignedOut(); await ctx.reload();
    assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out' && call.authorization === 'Bearer synthetic-foreign').length, 0);
  } finally { f.dispose(); }
});

test('same-account fresh sign-in, resource replacement, departure and unmount permanently invalidate admitted callbacks', async () => {
  for (const change of ['same-account', 'resources', 'departure', 'unmount', 'renderer']) {
    const f = await fixture();
    try {
      const ctx = await f.enter(), before = f.calls.length;
      if (change === 'same-account') await f.replaceAuth();
      if (change === 'resources') { f.props.resources = new FormResources(f.api); f.render(); }
      if (change === 'departure') f.home().openPlans();
      if (change === 'unmount') f.dispose();
      if (change === 'renderer') { f.props.renderAccountSecurity = () => 'replacement'; f.render(); }
      assert.equal(ctx.isCurrentSession(), false);
      await settle();
      const count = f.calls.length;
      ctx.close(); ctx.openAccess(); ctx.onSignedOut(); await ctx.reload();
      assert.equal((await ctx.credentials.changePassword({ currentPassword: 'synthetic-current', newPassword: password })).status, 'failed');
      assert.equal(f.calls.length, count); assert.equal(f.mutations().length, 0); assert.ok(count >= before);
    } finally { f.dispose(); }
  }
});

test('matching UUID is required before reacquisition and foreign replacementGuard is never exempt', async () => {
  const f = await fixture();
  try {
    const ctx = await f.enter(); await ctx.credentials.changePassword({ currentPassword: 'synthetic-current', newPassword: password });
    f.currentAccount = { ...account(), accountId: 'different' };
    await ctx.reload(); assert.ok(find(f.render(), 'Security')); assert.equal(f.data().account.accountId, 'original');
    const other = captureAccountSecuritySession(f.resources, { accountId: 'original', sessionGeneration: 'other',
      isOwnerCurrent: () => true, onForeignAuth() {} }, f.api.captureAuthContext());
    try {
      await other.credentials.changePassword({ currentPassword: 'synthetic-current', newPassword: password });
      assert.equal(ctx.isCurrentSession(), false); assert.equal(f.data().account, null);
    } finally { other.dispose(); }
  } finally { f.dispose(); }
});

for (const name of ['Security', 'Membership', 'Health']) test(`retained Home context entry fences ${name} callbacks before held route state or rendering advances`, async () => {
  const f = await fixture({ contextRenderer: true });
  try {
    let ctx;
    if (name === 'Security') ctx = await f.enter();
    else { f.settings()['open' + name](); f.render(); ctx = name === 'Membership' ? f.membership() : f.health(); }
    const home = f.home(), before = f.calls.length;
    assert.equal(ctx.isCurrentSession(), true); assert.equal(typeof home.openContextConfirmation, 'function');
    f.holdRoutes(); home.openContextConfirmation();
    if (name === 'Security') {
      const result = await ctx.credentials.changePassword({ currentPassword: 'synthetic-current', newPassword: password });
      assert.equal(f.mutations().length, 0); assert.equal(result.status, 'failed');
    } else await ctx.resources.account().catch(() => {});
    assert.equal(ctx.isCurrentSession(), false); assert.equal(f.calls.length, before);
    f.flushRoutes(); assert.ok(find(f.render(), 'ContextConfirmation'));
  } finally { f.dispose(); }
});

test('FormRuntime forwards optional account slot identities without activating a renderer', () => {
  const h = hooks(), voice = { stop: async () => {}, dispose: async () => {}, speech: () => speech };
  const api = { subscribeAuthChanges: () => ({ remove: noop }) };
  const supplied = { renderAccountSecurity() {}, renderMembership() {}, renderHealth() {} };
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native, 'expo-crypto': {},
    './api/phoneSignIn': {}, './api/featureBoard': {}, './api/community': {}, './api/client': { ...transport, commandKey: () => 'key' },
    './api/resources': { formResources: null }, './api/appleSignIn': {}, './body': {},
    './native/runtime': { bindFormNativeModule: () => ({}) }, './integration/sharedVoice': { createSharedVoice: () => voice },
    './account-lifecycle/native': {}, './integration/lifecycleSession': {},
    './integration/commandOwnerSession': { createCommandOwnerRegistry: () => ({ forSession: () => null }) },
    './integration/activitySession': {}, './integration/presentationPolicy': {},
    './integration/systemMotion': { observeSystemMotion: () => noop }, './settings/appMode': {}, './features': { FormAccountApp: 'Shell' } };
  const { FormRuntime } = loader(mocks)('FormRuntime.tsx');
  try {
    const props = { resources: { api }, renderSettings: () => null, ...supplied };
    const result = h.render(FormRuntime, props); assert.equal(result.type, 'Shell');
    for (const key of Object.keys(supplied)) assert.equal(result.props[key], supplied[key]);
    const absent = h.render(FormRuntime, { resources: props.resources, renderSettings: props.renderSettings });
    for (const key of Object.keys(supplied)) assert.equal(absent.props[key], undefined);
  } finally { h.dispose(); }
});
