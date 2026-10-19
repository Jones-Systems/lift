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
      return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
    }, module, module.exports);
    return module.exports;
  }
  return load;
}
const load = loader();
const { createCommandOwnerRegistry } = load('integration/commandOwnerSession.ts');
const { commandCustodyLimits } = load('integration/commandCustody.ts');
const intent = key => ({ operation: 'delete_assessment', command: { key, id: 'synthetic-measurement', payload: {} } });
const access = session => ({ accountId: session.accountId, sessionGeneration: session.sessionGeneration });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(validateConfirmation) {
  let authCurrent = true, shellCurrent = true, recaptures = 0;
  const originalAuth = { isCurrent: () => authCurrent };
  const resources = { api: { captureAuthContext() { recaptures++; throw new Error('Must use original guard'); } } };
  const session = Object.freeze({ accountId: 'original-account', sessionGeneration: 'shell:2', resources,
    originalAuth, isCurrentSession: () => shellCurrent });
  const registry = createCommandOwnerRegistry(validateConfirmation), owner = registry.forSession(session);
  return { registry, owner, session, hold: key => owner.hold({ ...access(session), ...intent(key) }),
    expireAuth: () => { authCurrent = false; }, expireShell: () => { shellCurrent = false; },
    revive: () => { authCurrent = shellCurrent = true; }, recaptures: () => recaptures };
}

test('same original binding retains one owner and intent across presentation close/reopen', () => {
  const f = fixture(), held = f.hold('original-key');
  held.report({ status: 'unknown', settled: true });
  const reopened = f.registry.forSession({ ...f.session });
  assert.equal(reopened, f.owner); assert.equal(f.recaptures(), 0);
  assert.deepEqual(reopened.reconcile(access(f.session), held.id).readIntent(), intent('original-key'));
});

test('same-key retry waits for local settlement and later rejection retains unknown effect', () => {
  const f = fixture(), held = f.hold('original-key'), recovery = f.owner.reconcile(access(f.session), held.id);
  held.report({ status: 'unknown', settled: false });
  assert.throws(() => recovery.retry(), { code: 'attempt_pending' });
  held.report({ status: 'unknown', settled: true });
  const retry = recovery.retry(); assert.equal(retry.readIntent(), held.readIntent());
  retry.report({ status: 'rejected', settled: true });
  assert.equal(recovery.snapshot().effect, 'unknown');
  assert.throws(() => recovery.acknowledge(), { code: 'unresolved_command' });
});

for (const mismatch of ['accountId', 'resources', 'originalAuth', 'isCurrentSession']) {
  test(`a mismatched ${mismatch} refuses owner replacement and expires reads without disabling late reports`, () => {
    let validations = 0;
    const f = fixture(() => { validations++; return true; }), held = f.hold('original-key');
    const changes = { accountId: 'foreign', resources: { api: {} }, originalAuth: { isCurrent: () => true }, isCurrentSession: () => true };
    assert.equal(f.registry.forSession({ ...f.session, [mismatch]: changes[mismatch] }), null);
    assert.equal(f.registry.forSession(f.session), null);
    assert.throws(() => held.readIntent(), { code: 'session_changed' });
    assert.throws(() => f.owner.snapshot(access(f.session)), { code: 'session_changed' });
    held.report({ status: 'confirmed', settled: true, response: { deleted: true } });
    assert.equal(validations, 1);
  });
}

test('auth expiry and shell disposal latch expiry even if guards later revive', () => {
  for (const change of ['expireAuth', 'expireShell']) {
    const f = fixture(), held = f.hold('original-key'); f[change]();
    assert.throws(() => held.assertCurrent(), { code: 'session_changed' }); f.revive();
    assert.equal(f.registry.forSession(f.session), null);
    assert.throws(() => f.owner.reconcile(access(f.session), held.id), { code: 'session_changed' });
    assert.doesNotThrow(() => held.report({ status: 'unknown', settled: true }));
  }
});

test('replacement generation has isolated custody and cannot claim original handles', () => {
  const f = fixture(), original = f.hold('old-key'); f.expireShell();
  const next = { ...f.session, sessionGeneration: 'shell:3', originalAuth: { isCurrent: () => true }, isCurrentSession: () => true };
  const replacement = f.registry.forSession(next);
  assert.notEqual(replacement, f.owner); assert.deepEqual(replacement.snapshot(access(next)), []);
  assert.throws(() => replacement.reconcile(access(next), original.id), { code: 'custody_missing' });
  assert.throws(() => original.readIntent(), { code: 'session_changed' });
});

test('capacity refuses new owners without evicting unknown commands or throwing', () => {
  const f = fixture(), held = f.hold('retained-key'); held.report({ status: 'unknown', settled: true });
  for (let i = 1; i < commandCustodyLimits.records; i++) {
    assert.ok(f.registry.forSession({ ...f.session, sessionGeneration: `another:${i}` }));
  }
  assert.equal(f.registry.forSession({ ...f.session, sessionGeneration: 'over-capacity' }), null);
  assert.equal(f.registry.forSession(f.session), f.owner);
  assert.equal(f.owner.snapshot(access(f.session))[0].effect, 'unknown');
});

test('missing validator still holds dispatch liability and leaves confirmations unknown', () => {
  const f = fixture(), held = f.hold('held-before-dispatch'); held.assertCurrent();
  held.report({ status: 'confirmed', settled: true, response: { deleted: true } });
  assert.equal(f.owner.snapshot(access(f.session))[0].effect, 'unknown');
});

test('cleanup captures metadata before disable and remains incomplete after a late qualified response', async () => {
  let validations = 0, disposals = 0;
  const wait = deferred(), f = fixture(() => { validations++; return true; }), held = f.hold('original-key');
  const reporting = wait.promise.then(response => held.report({ status: 'confirmed', settled: true, response }));
  const cleanup = f.registry.captureCleanup(f.session, [async () => { disposals++; }]);
  f.expireAuth(); f.expireShell();
  assert.throws(() => f.owner.snapshot(access(f.session)), { code: 'session_changed' });
  wait.resolve({ deleted: true }); await reporting;
  await assert.rejects(cleanup(), /cleanup is incomplete/);
  assert.equal(disposals, 1); assert.equal(validations, 1);
});

test('cleanup attempts independent disposals despite synchronous throws and retained unknown liability', async () => {
  const f = fixture(), held = f.hold('original-key'), seen = [];
  held.report({ status: 'unknown', settled: true });
  const cleanup = f.registry.captureCleanup(f.session, [() => { seen.push('one'); throw new Error('Synthetic'); },
    async () => { seen.push('two'); }]);
  await assert.rejects(cleanup(), /cleanup is incomplete/); assert.deepEqual(seen, ['one', 'two']);
  assert.equal(f.owner.snapshot(access(f.session))[0].effect, 'unknown');
});

test('cleanup of empty selected custody does not read after disable or consult a foreign owner', async () => {
  const f = fixture(), other = { ...f.session, sessionGeneration: 'other', isCurrentSession: () => true };
  const foreign = f.registry.forSession(other);
  foreign.hold({ ...access(other), ...intent('foreign-key') });
  const cleanup = f.registry.captureCleanup(f.session, []); f.expireAuth();
  await cleanup();
});

test('a stale or mismatched cleanup selection cannot falsely report complete', async () => {
  const f = fixture();
  const cleanup = f.registry.captureCleanup({ ...f.session, accountId: 'foreign' }, []);
  await assert.rejects(cleanup(), /cleanup is incomplete/);
});

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
function shellHarness(ownerFactory) {
  const h = hooks(), guards = [], account = { accountId: 'original-account', onboarding: { status: 'completed' }, preferences: {}, profile: {} };
  let authCurrent = true, home, body, settings, received;
  const api = { restore: async () => true, captureAuthContext() { const guard = { isCurrent: () => authCurrent }; guards.push(guard); return guard; },
    // Non-emitting unit observers supply no auth-event or session-lifetime evidence.
    subscribeAuthChanges(_observer) { return { remove: noop }; },
    observeSessionLifetime(_observer) { return { remove: noop, refresh: async () => {} }; } };
  const resources = { api, account: async () => account, entitlements: async () => ({ accountId: account.accountId }),
    settings: async () => null, capabilities: async () => ({}), plans: async () => ({ items: [] }), exercises: async () => ({ items: [] }),
    sourceTraining: async () => load('api/sourceTrainingResources.ts').createSourceTrainingResources(
      () => resources.plans(), () => { if (!authCurrent) throw new Error('Synthetic stale session'); }),
    boundTo() { return { ...resources }; } };
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
    '../../api/client': { ...load('api/transport.ts'), commandKey: () => 'synthetic-shell' },
    '../../integration/sharedVoice': { captureSharedVoiceScope: (_api, account, isCurrent) => ({ account, isCurrent }) },
    '../../native/speech': { FormSpeechAdapter: function () { return speech; } },
    '../account/AccountScreens': names, '../auth/AuthFlow': names, '../cues/CuesScreen': names,
    '../onboarding/OnboardingFlow': names, '../plans/PlansScreens': names, '../shared/commands': {},
    '../shared/copy': { COPY: {}, errorCopy: error => error.message }, '../shared/tokens': { t: tokens, L: tokens }, '../shared/ui': names };
  const { FormAccountApp } = loader(mocks)('features/shell/FormAccountApp.tsx');
  const props = { resources, appMode: 'basic', renderHome: ctx => { home = ctx; return 'home'; },
    renderBody: ctx => { body = ctx; return 'body'; }, renderSettings: ctx => { settings = ctx; return 'settings'; },
    commandOwnerForSession: session => { received = session; return ownerFactory(session); } };
  return { render: () => h.render(FormAccountApp, props), dispose: h.dispose, guards, resources,
    get home() { return home; }, get body() { return body; }, get settings() { return settings; }, get session() { return received; },
    expireAuth: () => { authCurrent = false; } };
}
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

test('actual shell binds acquisition auth and retains custody when Body closes and reopens', async () => {
  const registry = createCommandOwnerRegistry(), h = shellHarness(session => registry.forSession(session));
  try {
    h.render(); await settle(); h.render();
    assert.equal(h.session.originalAuth, h.guards[0]); assert.equal(h.session.resources, h.resources);
    assert.ok(Object.isFrozen(h.session)); assert.equal(h.home.isCurrentSession, h.session.isCurrentSession);
    h.home.openBody(); h.render(); const first = h.body.commandOwner;
    assert.ok(first); assert.equal(h.body.isCurrentSession, h.session.isCurrentSession);
    const held = first.hold({ ...access(h.session), ...intent('original-key') }); held.report({ status: 'unknown', settled: true });
    h.body.close(); h.render(); h.home.openBody(); h.render();
    assert.equal(h.body.commandOwner, first);
    assert.deepEqual(first.reconcile(access(h.session), held.id).readIntent(), intent('original-key'));
    h.expireAuth(); assert.throws(() => held.readIntent(), { code: 'session_changed' });
    assert.doesNotThrow(() => held.report({ status: 'rejected', settled: true }));
  } finally { h.dispose(); }
});

test('actual shell keeps Home and Settings usable when optional owner admission refuses or throws', async () => {
  for (const factory of [() => null, () => { throw new Error('Unavailable'); }]) {
    const h = shellHarness(factory);
    try {
      h.render(); await settle(); h.render(); assert.ok(h.home.isCurrentSession());
      h.home.openSettings(); h.render(); assert.equal(h.settings.account.accountId, 'original-account');
      h.settings.close(); h.render(); h.home.openBody(); h.render(); assert.equal(h.body.commandOwner, undefined);
    } finally { h.dispose(); }
  }
});

function runtimeHarness(extra = {}) {
  const h = hooks();
  const voice = { stop: async () => {}, dispose: async () => {}, speech: () => speech, stopScope: async () => ({ status: 'released' }) };
  const resources = { api: { subscribeAuthChanges: () => ({ remove: noop }) } };
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native, 'expo-crypto': {},
    './api/phoneSignIn': {}, './api/featureBoard': {}, './api/community': {}, './api/client': load('api/transport.ts'),
    './api/resources': { formResources: {} }, './api/appleSignIn': {}, './body': { BodyFlow: 'BodyFlow', bodyPrivacySummary: () => ({ status: 'unavailable' }) },
    './native/runtime': { bindFormNativeModule: () => null }, './integration/sharedVoice': { createSharedVoice: () => voice },
    './account-lifecycle/native': { nativeReceiptCustody: {} }, './integration/lifecycleSession': { createLifecycleSession: options => options },
    './integration/activitySession': {}, './integration/presentationPolicy': { resolvePresentationPolicy: () => ({}) },
    './integration/systemMotion': { observeSystemMotion: () => noop }, './settings/appMode': { appModeFrom: () => 'basic' },
    './features': { FormAccountApp: 'FormAccountApp' } };
  const { FormRuntime } = loader(mocks)('FormRuntime.tsx');
  return { render: () => h.render(FormRuntime, { resources, renderSettings: noop, ...extra }).props, dispose: h.dispose, resources };
}

test('actual runtime preserves default Body props and routes actual context through the optional producer', () => {
  const ctx = { account: { accountId: 'original-account' }, appMode: 'advanced', close: noop, sessionGeneration: 'shell:2' };
  const fallback = runtimeHarness();
  try {
    const node = fallback.render().renderBody(ctx);
    assert.equal(node.type, 'BodyFlow'); assert.equal(node.key, ctx.sessionGeneration);
    assert.deepEqual(node.props, { accountId: ctx.account.accountId, appMode: ctx.appMode, onClose: ctx.close });
  } finally { fallback.dispose(); }
  let received; const renderBody = value => { received = value; return 'custom-body'; };
  const custom = runtimeHarness({ renderBody });
  try {
    const node = custom.render().renderBody(ctx);
    assert.equal(typeof node.type, 'function');
    assert.equal(node.key, ctx.sessionGeneration);
    assert.equal(node.props.ctx, ctx); assert.equal(node.props.render, renderBody);
    assert.equal(received, undefined);
  } finally { custom.dispose(); }
});

test('actual runtime retains one registry and lifecycle capture preserves pre-disable liability', async () => {
  const h = runtimeHarness();
  try {
    let current = true; const session = { accountId: 'original-account', sessionGeneration: 'shell:2', resources: h.resources,
      originalAuth: { isCurrent: () => current }, isCurrentSession: () => current };
    const props = h.render(), owner = props.commandOwnerForSession(session);
    const held = owner.hold({ ...access(session), ...intent('original-key') });
    assert.equal(h.render().commandOwnerForSession(session), owner);
    const lifecycle = props.lifecycleSession({ accountId: session.accountId, sessionKey: session.sessionGeneration, voiceScope: {} });
    const cleanup = lifecycle.captureResources(); current = false;
    held.report({ status: 'confirmed', settled: true, response: { deleted: true } });
    await assert.rejects(cleanup(), /cleanup is incomplete/);
    assert.throws(() => owner.snapshot(access(session)), { code: 'session_changed' });
  } finally { h.dispose(); }
});

test('changing the API inside captured resources expires custody without replacing its owner', () => {
  const f = fixture(), held = f.hold('original-key'); f.session.resources.api = {};
  assert.equal(f.registry.forSession(f.session), null);
  assert.throws(() => held.assertCurrent(), { code: 'session_changed' });
  assert.doesNotThrow(() => held.report({ status: 'unknown', settled: true }));
});

test('actual runtime passes the trusted validator the captured command and keeps absent validation unknown', () => {
  for (const qualified of [false, true]) {
    const seen = [], h = runtimeHarness(qualified ? { validateConfirmation: (intent, response) => {
      seen.push({ intent, response }); return response.deleted === true;
    } } : {});
    try {
      const session = { accountId: 'original-account', sessionGeneration: 'shell:2', resources: h.resources,
        originalAuth: { isCurrent: () => true }, isCurrentSession: () => true };
      const owner = h.render().commandOwnerForSession(session), held = owner.hold({ ...access(session), ...intent('original-key') });
      held.report({ status: 'confirmed', settled: true, response: { deleted: true } });
      assert.equal(owner.snapshot(access(session))[0].effect, qualified ? 'confirmed' : 'unknown');
      if (qualified) assert.deepEqual(seen, [{ intent: intent('original-key'), response: { deleted: true } }]);
      else assert.deepEqual(seen, []);
    } finally { h.dispose(); }
  }
});
