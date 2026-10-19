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


const { createChangeEmailController } = load('features/credentials/model.ts');
const nextEmail = 'next@synthetic.invalid', currentPassword = 'synthetic-current-password', otp = '12345678';
async function fixture() {
  const h = hooks(), calls = [], saves = [], clears = [];
  let home, settings, security, keys = 0;
  const f = { email: 'original@synthetic.invalid', currentAccount: account(), requestCodeResponse: null, confirmResponse: null,
    accountRead: null, settingsRead: null, entitlementsRead: null };
  const api = new FormTransport('https://form.example.invalid', {
    async load() { return JSON.stringify({ version: 1, baseURL: 'https://form.example.invalid', token: 'synthetic-original' }); },
    async save(value) { saves.push(JSON.parse(value).token); }, async clear() { clears.push(true); },
  }, async (url, init) => {
    const call = { path: new URL(url).pathname, method: init.method, authorization: init.headers.Authorization,
      body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (call.path === '/api/auth/sign-in/email') return new Response('{}', { headers: { 'set-auth-token': 'synthetic-foreign' } });
    if (call.path === '/api/auth/email-otp/request-email-change') return f.requestCodeResponse ? f.requestCodeResponse(call) : json({ success: true });
    if (call.path === '/api/auth/email-otp/change-email') {
      if (f.confirmResponse) return f.confirmResponse(call);
      f.email = call.body.newEmail; return json({ success: true, token: 'ignored-response-body-token' });
    }
    if (call.path === '/api/auth/sign-out') return json({ success: true });
    if (call.path === '/api/auth/revoke-other-sessions') return json({ status: true });
    if (call.path === '/v1/capabilities') return json({});
    if (call.path === '/v1/me') return f.accountRead ? f.accountRead() : json(f.currentAccount);
    if (call.path === '/v1/me/settings') return f.settingsRead ? f.settingsRead() : json({ accountId: f.currentAccount.accountId,
      identity: { email: f.email, emailVerified: true, signInMethods: ['emailPassword'] } });
    if (call.path === '/v1/entitlements') return f.entitlementsRead ? f.entitlementsRead() : json({ accountId: f.currentAccount.accountId });
    if (call.path === '/v1/exercises' || call.path === '/v1/plans') return json({ items: [] });
    assert.fail('Unexpected actual transport request: ' + call.method + ' ' + call.path);
  });
  const resources = new FormResources(api);
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
    '../../api/client': { ...transport, commandKey: () => 'synthetic-key-' + (++keys) }, './transport': transport,
    '../../integration/sharedVoice': { captureSharedVoiceScope: (_api, account, isCurrent) => ({ account, isCurrent }) },
    '../../native/speech': { FormSpeechAdapter: function () { return speech; } },
    '../account/AccountScreens': names, '../auth/AuthFlow': names, '../cues/CuesScreen': names,
    '../onboarding/OnboardingFlow': names, '../plans/PlansScreens': names,
    '../shared/copy': { COPY: {}, errorCopy: error => error.message }, '../shared/tokens': { t: tokens, L: tokens }, '../shared/ui': names };
  const { FormAccountApp } = loader(mocks)('features/shell/FormAccountApp.tsx');
  const props = { resources, appMode: 'basic', renderHome: ctx => { home = ctx; return 'home'; },
    renderSettings: ctx => { settings = ctx; return 'settings'; },
    renderAccountSecurity: ctx => { security = ctx; return jsx('Security', { ctx }); },
    onSessionAction: async action => {
      assert.equal(action, 'revokeOtherSessions'); await api.revokeOtherSessions(); return { status: 'saved', value: null };
    } };
  Object.assign(f, { api, resources, props, calls, saves, clears, render: () => h.render(FormAccountApp, props), dispose: h.dispose,
    home: () => home, settings: () => settings, security: () => security, data: h.data,
    requestCodes: () => calls.filter(call => call.path === '/api/auth/email-otp/request-email-change'),
    confirmations: () => calls.filter(call => call.path === '/api/auth/email-otp/change-email'),
    settingsReads: () => calls.filter(call => call.path === '/v1/me/settings'),
    revocations: () => calls.filter(call => call.path === '/api/auth/revoke-other-sessions'),
    replaceAuth: () => api.signIn('foreign@synthetic.invalid', 'synthetic-password'),
    async enter() { home.openSettings(); f.render(); settings.openAccountSecurity(); f.render(); return security; },
  });
  f.render(); await settle(); f.render(); await settle(); f.render(); calls.length = 0;
  return f;
}
function createController(ctx, refreshSettings) {
  return createChangeEmailController(ctx.credentials, { currentEmail: ctx.settings.identity.email,
    ...(refreshSettings ? { refreshSettings } : {}) });
}
async function requestCode(controller) {
  await controller.requestCode(' NEXT@synthetic.invalid ', currentPassword);
  assert.equal(controller.snapshot().step, 'code'); assert.equal(controller.transition(), null);
}
function safeSnapshot(controller) {
  const serialized = JSON.stringify(controller.snapshot());
  for (const secret of [currentPassword, otp, 'synthetic-original', 'ignored-response-body-token']) assert.equal(serialized.includes(secret), false);
}

test('AUTH03 actual credential context sends original bearer and UUID; saved only offers explicit existing revocation', async () => {
  const f = await fixture(); let controller;
  try {
    const ctx = await f.enter(); controller = createController(ctx);
    assert.equal(ctx.account.accountId, 'original'); assert.equal(ctx.settings.accountId, 'original');
    await requestCode(controller); await controller.confirm(otp);
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(controller.snapshot().step, 'done');
    const target = controller.transition(); assert.equal(target.reason, 'email-changed'); assert.equal(target.newEmail, nextEmail);
    assert.equal(target.refreshRequired, true); assert.equal(target.offerRevokeOtherSessions, true);
    assert.equal(f.requestCodes().length, 1); assert.equal(f.confirmations().length, 1);
    assert.deepEqual(f.requestCodes()[0].body, { newEmail: nextEmail, currentPassword });
    assert.deepEqual(f.confirmations()[0].body, { newEmail: nextEmail, otp });
    for (const command of [...f.requestCodes(), ...f.confirmations()]) assert.equal(command.authorization, 'Bearer synthetic-original');
    assert.equal(f.saves.length, 0); assert.equal(f.clears.length, 0); assert.equal(f.revocations().length, 0); safeSnapshot(controller);
    for (let i = 0; i < 3; i++) controller.transition();
    await controller.confirm(otp); await controller.requestCode('other@synthetic.invalid', currentPassword);
    assert.equal(f.confirmations().length, 1); assert.equal(f.requestCodes().length, 1); assert.equal(f.revocations().length, 0);
    assert.equal((await ctx.sessionAction('revokeOtherSessions')).status, 'saved');
    assert.equal(f.revocations().length, 1); assert.equal(f.revocations()[0].authorization, 'Bearer synthetic-original');
  } finally { controller?.dispose(); f.dispose(); }
});

test('AUTH03 confirmed save survives optional Settings read failure; explicit controller read retry never resubmits email', async () => {
  const f = await fixture(); let controller;
  try {
    const ctx = await f.enter(); controller = createController(ctx, async () => { await ctx.resources.settings(); });
    f.settingsRead = () => json({ error: { code: 'synthetic_read_failure' } }, 500);
    await requestCode(controller); await controller.confirm(otp);
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(controller.snapshot().refreshRequired, true);
    assert.equal(controller.transition().reason, 'email-changed'); assert.equal(f.confirmations().length, 1); assert.equal(f.settingsReads().length, 1);
    f.settingsRead = null; await controller.refreshSettings();
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(controller.snapshot().refreshRequired, false);
    assert.equal(f.settingsReads().length, 2); assert.equal(f.confirmations().length, 1); assert.equal(f.requestCodes().length, 1);
    assert.equal(f.revocations().length, 0); assert.equal(ctx.isCurrentSession(), true); safeSnapshot(controller);
  } finally { controller?.dispose(); f.dispose(); }
});

test('AUTH03 explicit shell Settings reacquisition keeps saved mutation across a failed read and returns only after matching reads', async () => {
  const f = await fixture(); let controller;
  try {
    const oldHome = f.home(), ctx = await f.enter(); controller = createController(ctx);
    await requestCode(controller); await controller.confirm(otp);
    f.settingsRead = () => json({ error: { code: 'synthetic_read_failure' } }, 500);
    await ctx.reload(); assert.ok(find(f.render(), 'Security'));
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(controller.transition().refreshRequired, true);
    assert.equal(f.home().sessionGeneration, oldHome.sessionGeneration); assert.equal(f.confirmations().length, 1);
    f.settingsRead = null; await ctx.reload(); f.render(); await settle(); f.render();
    assert.notEqual(f.home().sessionGeneration, oldHome.sessionGeneration);
    assert.equal(f.settings().settings.accountId, 'original'); assert.equal(f.settings().settings.identity.email, nextEmail);
    assert.equal(ctx.isCurrentSession(), false); assert.equal(controller.transition(), null);
    assert.equal(f.confirmations().length, 1); assert.equal(f.requestCodes().length, 1); assert.equal(f.revocations().length, 0);
  } finally { controller?.dispose(); f.dispose(); }
});

for (const resource of ['account', 'settings', 'entitlements']) test(`AUTH03 mismatched ${resource} UUID cannot enter fresh Settings or replace original private cache`, async () => {
  const f = await fixture(); let controller;
  try {
    const ctx = await f.enter(), generation = f.home().sessionGeneration; controller = createController(ctx);
    await requestCode(controller); await controller.confirm(otp);
    const key = resource + 'Read';
    f[key] = () => json(resource === 'account' ? { ...account(), accountId: 'foreign' } : { accountId: 'foreign' });
    await ctx.reload(); assert.ok(find(f.render(), 'Security'));
    assert.equal(f.data().account.accountId, 'original'); assert.equal(f.data().settings.identity.email, 'original@synthetic.invalid');
    assert.equal(f.home().sessionGeneration, generation); assert.equal(controller.snapshot().status, 'saved');
    assert.equal(ctx.isCurrentSession(), true); assert.equal(f.confirmations().length, 1);
    f[key] = null; await ctx.reload(); f.render(); assert.notEqual(f.home().sessionGeneration, generation);
    assert.equal(f.settings().settings.identity.email, nextEmail); assert.equal(f.confirmations().length, 1);
  } finally { controller?.dispose(); f.dispose(); }
});

for (const phase of ['confirm', 'read']) for (const effect of ['navigation', 'unmount', 'auth'])
  test(`AUTH03 ${effect} during ${phase} expires credential context and drops late private controller results`, async () => {
    const f = await fixture(), late = deferred(); let controller, pending;
    try {
      const ctx = await f.enter();
      controller = createController(ctx, phase === 'read' ? async () => { await ctx.resources.settings(); } : undefined);
      await requestCode(controller);
      if (phase === 'confirm') f.confirmResponse = () => late.promise;
      else f.settingsRead = () => late.promise;
      pending = controller.confirm(otp); await settle();
      assert.equal(controller.snapshot().status, phase === 'confirm' ? 'pending' : 'saved');
      if (effect === 'navigation') ctx.openPlans();
      if (effect === 'unmount') f.dispose();
      if (effect === 'auth') await f.replaceAuth();
      assert.equal(ctx.isCurrentSession(), false);
      late.resolve(json(phase === 'confirm' ? { success: true } : { accountId: 'original', identity: { email: 'late-private@synthetic.invalid' } }));
      await pending; assert.equal(controller.snapshot().status, 'disposed'); assert.equal(controller.transition(), null);
      const count = f.calls.length; await controller.confirm(otp); await controller.refreshSettings(); ctx.onSignedOut(); await ctx.reload();
      assert.equal(f.calls.length, count); assert.equal(f.confirmations().length, 1); assert.equal(f.revocations().length, 0);
      if (effect === 'auth') { assert.equal(f.data().account, null); assert.equal(f.clears.length, 0); assert.ok(f.saves.includes('synthetic-foreign')); }
    } finally { late.resolve(json({ success: true })); await pending; controller?.dispose(); f.dispose(); }
  });

test('AUTH03 late shell reacquisition after foreign auth cannot publish original data or clear replacement bearer', async () => {
  const f = await fixture(), late = deferred(); let controller, returning;
  try {
    const ctx = await f.enter(); controller = createController(ctx); await requestCode(controller); await controller.confirm(otp);
    f.accountRead = () => late.promise; returning = ctx.reload(); await settle();
    await f.replaceAuth(); assert.equal(ctx.isCurrentSession(), false); assert.equal(f.data().account, null);
    late.resolve(json(account())); await returning; f.render();
    assert.equal(f.data().account, null); assert.equal(controller.transition(), null); assert.equal(f.confirmations().length, 1);
    const count = f.calls.length; ctx.onSignedOut(); await ctx.reload(); assert.equal(f.calls.length, count); assert.equal(f.clears.length, 0);
  } finally { late.resolve(json(account())); await returning; controller?.dispose(); f.dispose(); }
});

test('AUTH03 unknown email mutation has no confirmed target or automatic replay; reconciliation performs reads only', async () => {
  const f = await fixture(); let controller;
  try {
    const ctx = await f.enter(); controller = createController(ctx);
    await requestCode(controller); f.confirmResponse = () => Promise.reject(new Error('synthetic lost response'));
    await controller.confirm(otp); assert.equal(controller.snapshot().status, 'unknown'); assert.equal(controller.transition(), null);
    assert.equal(controller.snapshot().offerRevokeOtherSessions, false); assert.equal(f.confirmations().length, 1);
    await controller.confirm(otp); await controller.refreshSettings(); assert.equal(f.confirmations().length, 1); assert.equal(f.settingsReads().length, 0);
    await ctx.reload(); f.render(); assert.equal(f.settings().settings.accountId, 'original');
    assert.equal(f.confirmations().length, 1); assert.equal(f.requestCodes().length, 1); assert.equal(f.revocations().length, 0);
    assert.equal(f.settings().settings.identity.email, 'original@synthetic.invalid'); assert.equal(f.saves.length, 0); assert.equal(f.clears.length, 0);
  } finally { controller?.dispose(); f.dispose(); }
});
