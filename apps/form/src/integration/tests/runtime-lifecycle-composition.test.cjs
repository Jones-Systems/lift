const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function loader(mocks = {}) {
  const cache = new Map();
  function load(name) {
    let file = path.resolve(root, name);
    if (!fs.existsSync(file)) {
      file = ['.ts', '.tsx'].map(extension => file + extension).find(candidate => fs.existsSync(candidate));
      assert.ok(file, `Missing source module: ${name}`);
    } else if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.ts');
    assert.ok(file.startsWith(root + path.sep));
    const relative = path.relative(root, file);
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
      return load(path.relative(root, path.resolve(path.dirname(file), name)));
    }, module, module.exports);
    return module.exports;
  }
  return load;
}
function hookDispatcher() {
  let active;
  const changed = (old, deps) => !old || deps.length !== old.deps.length || deps.some((value, i) => !Object.is(value, old.deps[i]));
  const react = {
    useState(initial) {
      const owner = active, i = owner.cursor++;
      if (!(i in owner.slots)) owner.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [owner.slots[i], value => { owner.slots[i] = typeof value === 'function' ? value(owner.slots[i]) : value; }];
    },
    useRef(initial) { const i = active.cursor++; return active.slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = active.cursor++; if (changed(active.slots[i], deps)) active.slots[i] = { deps, value: fn() }; return active.slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const owner = active, i = owner.cursor++, old = owner.slots[i];
      if (changed(old, deps)) owner.effects.push(() => { old?.cleanup?.(); owner.slots[i] = { deps, cleanup: fn() }; });
    },
  };
  function component() {
    const owner = { slots: [], cursor: 0, effects: [], disposed: false };
    return {
      render(Component, props) {
        assert.equal(owner.disposed, false);
        const previous = active; active = owner; owner.cursor = 0; owner.effects = [];
        try { const tree = Component(props); for (const effect of owner.effects) effect(); return tree; }
        finally { active = previous; }
      },
      data: () => owner.slots.find(value => value && Object.hasOwn(value, 'account') && Object.hasOwn(value, 'plans')),
      dispose() { if (owner.disposed) return; owner.disposed = true; for (const slot of owner.slots) slot?.cleanup?.(); },
    };
  }
  return { react, component };
}
const jsx = (type, props, key) => ({ type, props, key });
const names = new Proxy({}, { get: (_, name) => name });
const tokens = new Proxy({}, { get: () => tokens });
const noop = () => {};
const tick = () => new Promise(setImmediate);
async function settle() { for (let i = 0; i < 4; i++) await tick(); }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const origin = 'https://form.example.invalid';
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers });
const receipt = { accountId: 'original', baseURL: origin, requestId: 'dbd28a74-8d68-4f1e-8ac2-2c4cb1fc23bc',
  statusSecret: 's'.repeat(64), commandKey: 'synthetic-command' };
const disabled = { requestId: receipt.requestId, phase: 'disabled_pending_purge', initiated: true, disabled: true,
  localPurged: false, complete: false, requestedAt: '2026-10-11T00:00:00Z', backupExpiryAt: null,
  billingCancellation: 'not_performed', reauthentication: 'password_only_qualified_source',
  steps: ['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community']
    .map(category => ({ category, status: 'pending', retain_until_ms: null })) };
function account() {
  return { accountId: 'original', onboarding: { status: 'completed' },
    profile: { revision: 4, name: 'Synthetic', age: null, heightCm: null, weightKg: null, trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'direct',
      communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['dumbbell'], remindersEnabled: false } };
}
async function fixture() {
  const dispatcher = hookDispatcher(), runtimeHooks = dispatcher.component(), shellHooks = dispatcher.component();
  const boundaries = [], listeners = new Set();
  const f = { events: [], calls: [], statusCalls: [], captures: [], hosts: [], consumers: [], speeches: [], keys: 0,
    receipt: null, custodyCalls: [], failResource: false, failSpeech: false, failAudio: false, failClear: false,
    resourceGate: null, audioGate: null, clearGate: null };
  const nativeRuntime = { FormNativeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    bindFormNativeModule: () => ({ module: null, reason: 'platform_unsupported' }) };
  const transport = loader()('api/transport.ts');
  const client = { ...transport, formApi: null, commandKey: () => `synthetic-key-${++f.keys}` };
  const actual = loader({ 'native/runtime.ts': nativeRuntime, 'api/client.ts': client });
  const { FormResources } = actual('api/resources.ts');
  const { createLifecycleSession } = actual('integration/lifecycleSession.ts');
  const { createCommandOwnerRegistry } = actual('integration/commandOwnerSession.ts');
  const sharedVoice = actual('integration/sharedVoice.ts');
  const { createStandardVoiceConsumer } = actual('voice-coaching/standard/controller.ts');
  const { createActivitySession } = actual('integration/activitySession.ts');
  f.controller = actual('account-lifecycle/controller.ts').createAccountLifecycleController;
  const storage = { value: JSON.stringify({ version: 1, baseURL: origin, token: 'synthetic-original' }),
    async load() { return this.value; },
    async save(value) { f.events.push({ name: 'storage-save', token: JSON.parse(value).token }); this.value = value; },
    async clear() {
      f.events.push({ name: 'local-clear' });
      if (f.clearGate) await f.clearGate.promise;
      if (f.failClear) throw new Error('synthetic storage cleanup failure');
      this.value = null;
    } };
  const settings = { accountId: 'original', stagedAccountLifecycle: { status: 'configured_unverified', initiation: true,
    passwordActionReauthentication: true, phoneActionReauthentication: false, oauthActionReauthentication: false,
    wholeAccountDeletionComplete: false, exportMaxBytes: 16777216, billingCancellation: 'not_performed' } };
  const api = new transport.FormTransport(origin, storage, async (url, init) => {
    const pathname = new URL(url).pathname;
    f.calls.push({ path: pathname, method: init.method, authorization: init.headers.Authorization });
    if (pathname === '/api/auth/sign-in/email') return json({}, { 'set-auth-token': 'synthetic-foreign' });
    if (pathname === '/v1/capabilities') return json({});
    if (pathname === '/v1/me') return json(account());
    if (pathname === '/v1/me/settings') return json(settings);
    if (pathname === '/v1/entitlements') return json({ accountId: 'original' });
    if (pathname === '/v1/exercises' || pathname === '/v1/plans') return json({ items: [] });
    assert.fail(`Unexpected synthetic request: ${init.method} ${pathname}`);
  });
  const resources = new FormResources(api);
  const current = () => f.originalHome?.isCurrentSession() ?? false;
  const mocks = { react: dispatcher.react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { StyleSheet: { create: value => value }, View: 'View', Pressable: 'Pressable',
      AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove: noop }) },
      AppState: { addEventListener(_name, listener) { listeners.add(listener); return { remove: () => listeners.delete(listener) }; } } },
    'expo-crypto': {}, 'api/client.ts': client, 'native/runtime.ts': nativeRuntime,
    'api/phoneSignIn.ts': {}, 'api/appleSignIn.ts': {}, 'body/index.ts': { BodyFlow: 'UnusedBody', bodyPrivacySummary: () => ({}) },
    'features/account/AccountScreens.tsx': names, 'features/auth/AuthFlow.tsx': names,
    'features/cues/CuesScreen.tsx': names, 'features/onboarding/OnboardingFlow.tsx': names,
    'features/plans/PlansScreens.tsx': names, 'features/shared/ui.tsx': names,
    'features/shared/tokens.ts': { t: tokens, L: tokens },
    'features/shared/copy.ts': { COPY: {}, errorCopy: error => error.message },
    'account-lifecycle/native.ts': { async nativeReceiptCustody(id, baseURL) {
      f.custodyCalls.push([id, baseURL]);
      return { receipts: { load: async () => f.receipt, save: async () => assert.fail('Receipt saving is unavailable') } };
    } },
    'integration/lifecycleSession.ts': { createLifecycleSession(options) {
      const host = createLifecycleSession({ ...options, fetcher: async (url, init) => {
        f.statusCalls.push({ url, init }); return json(disabled);
      } });
      f.hosts.push({ host, shell: options.shell }); return host;
    } },
    'integration/commandOwnerSession.ts': { createCommandOwnerRegistry(...args) {
      const registry = createCommandOwnerRegistry(...args);
      return { ...registry, captureCleanup(selection, disposals) {
        f.captures.push({ selection, count: disposals.length, current: current() });
        return registry.captureCleanup(selection, disposals.map((dispose, index) => async () => {
          f.events.push({ name: 'resource-dispose', index });
          if (f.resourceGate) await f.resourceGate.promise;
          await dispose();
          if (f.failResource && index === 0) throw new Error('synthetic retained resource failure');
        }));
      } };
    } },
    'integration/sharedVoice.ts': { ...sharedVoice, createSharedVoice(options) {
      const voice = sharedVoice.createSharedVoice(options); f.voice = voice;
      const speech = voice.speech.bind(voice), stopScope = voice.stopScope.bind(voice), stop = voice.stop.bind(voice);
      voice.speech = scope => {
        const adapter = speech(scope), dispose = adapter.dispose.bind(adapter);
        adapter.dispose = async () => {
          f.events.push({ name: 'speech-dispose', adapter }); await dispose();
          if (f.failSpeech && adapter === f.shellSpeech) throw new Error('synthetic speech cleanup failure');
        };
        f.speeches.push({ scope, adapter }); return adapter;
      };
      voice.stopScope = async (scope, reason) => {
        f.events.push({ name: 'host-scope-stop', scope, reason, current: current() });
        const result = await stopScope(scope, reason);
        if (f.audioGate) await f.audioGate.promise;
        return f.failAudio ? { status: 'incomplete', failedSteps: ['synthetic_audio_release'] } : result;
      };
      voice.stop = reason => { f.events.push({ name: 'host-global-stop', reason }); return stop(reason); };
      return voice;
    } },
    'integration/activitySession.ts': { createActivitySession(...args) {
      const activity = createActivitySession(...args);
      return { ...activity, async dispose() { f.events.push({ name: 'activity-dispose' }); await activity.dispose(); } };
    } },
    'voice-coaching/standard/controller.ts': { createStandardVoiceConsumer(options) {
      const consumer = createStandardVoiceConsumer(options);
      const observed = { ...consumer, stop(reason) {
        f.events.push({ name: 'consumer-stop', consumer, reason, current: current() });
        return consumer.stop(reason);
      }, dispose() { f.events.push({ name: 'consumer-dispose', consumer }); return consumer.dispose(); } };
      f.consumers.push(observed); return observed;
    } },
  };
  const load = loader(mocks);
  const { FormAccountApp } = load('features/shell/FormAccountApp.tsx');
  mocks['features/index.ts'] = { FormAccountApp };
  const { FormRuntime } = load('FormRuntime.tsx');
  const props = { resources, identity: {}, renderHome: ctx => { f.home = ctx; return 'Home'; },
    renderSettings: ctx => { f.settings = ctx; return 'Settings'; },
    renderCommunity: ctx => ctx, renderFeatureRequests: ctx => ctx, renderActivity: ctx => ctx,
    onBeforeVoiceExit(input) { f.events.push({ name: 'shell-exit-observer', scope: input.scope, current: current() }); } };
  function render() {
    f.runtimeNode = runtimeHooks.render(FormRuntime, props);
    assert.equal(f.runtimeNode.type, FormAccountApp);
    return shellHooks.render(f.runtimeNode.type, f.runtimeNode.props);
  }
  function mount(renderSlot, ctx) {
    const node = renderSlot(ctx), hooks = dispatcher.component(); boundaries.push(hooks);
    assert.equal(typeof node.type, 'function');
    hooks.render(node.type, node.props);
    return hooks.render(node.type, node.props).props.children;
  }
  Object.assign(f, { api, resources, storage, props, render, data: shellHooks.data,
    replaceAuth: () => api.signIn('foreign@synthetic.invalid', 'synthetic-password'),
    async dispose() {
      f.resourceGate?.resolve(); f.audioGate?.resolve(); f.clearGate?.resolve();
      f.failResource = f.failSpeech = f.failAudio = f.failClear = false;
      for (const hooks of boundaries.reverse()) hooks.dispose();
      shellHooks.dispose(); runtimeHooks.dispose(); await settle();
    } });
  render(); await settle(); render(); await settle(); render();
  assert.equal(f.home.account.accountId, 'original'); f.originalHome = f.home;
  f.shellSpeech = f.speeches.find(entry => entry.scope?.account.authSessionId === f.home.sessionGeneration).adapter;
  f.home.openSettings(); render(); render();
  assert.ok(f.settings.lifecycle); f.host = f.settings.lifecycle;
  const shell = f.hosts.find(entry => entry.host === f.host).shell;
  f.originalScope = shell.voiceScope;
  const ctx = { account: f.home.account, appMode: 'basic', resources, sessionGeneration: shell.sessionKey,
    voiceScope: shell.voiceScope, isCurrentSession: shell.isCurrent, close: noop };
  f.community = mount(f.runtimeNode.props.renderCommunity, ctx);
  f.board = mount(f.runtimeNode.props.renderFeatureRequests, ctx);
  f.activity = mount(f.runtimeNode.props.renderActivity, ctx);
  f.coaching = f.activity.createStandardCoaching(noop);
  assert.ok(f.coaching); assert.equal(f.coaching.props.consumer, f.consumers[0]);
  f.events.length = 0; f.calls.length = 0;
  return f;
}
function attemptedResources(f) { return f.events.filter(event => event.name === 'resource-dispose').map(event => event.index).sort(); }
function recovery(f) {
  return f.host.recovery({ accountId: 'original', baseURL: origin, sessionKey: 'synthetic-recovery:1', isCurrent: () => true });
}

test('AUTH06 actual Runtime + shell claim stops the original consumer before host and epoch expiry, then awaits every captured cleanup', async () => {
  const f = await fixture();
  try {
    const original = f.api.captureAuthContext(), scope = f.originalScope;
    const cleanup = f.host.context.onAccessDisabled();
    assert.equal(f.host.context.onAccessDisabled(), cleanup);
    assert.equal(f.host.cleanupSnapshot().status, 'pending');
    assert.equal(f.captures.length, 1); assert.equal(f.captures[0].count, 3); assert.equal(f.captures[0].current, true);
    assert.equal(f.captures[0].selection.resources, f.resources);
    assert.equal(f.captures[0].selection.sessionGeneration, scope.account.authSessionId);
    const consumer = f.events.findIndex(event => event.name === 'consumer-stop');
    const host = f.events.findIndex(event => event.name === 'host-scope-stop');
    const observer = f.events.findIndex(event => event.name === 'shell-exit-observer');
    assert.ok(consumer >= 0 && consumer < host && host < observer);
    for (const index of [consumer, host, observer]) assert.equal(f.events[index].current, true);
    assert.equal(f.events[consumer].consumer.review(), null);
    assert.equal(f.events[consumer].consumer.snapshot().reviewAvailable, false);
    assert.deepEqual(f.events[host].scope.account, scope.account);
    assert.equal(f.originalHome.isCurrentSession(), false); assert.equal(f.data().account, null);
    assert.deepEqual(f.data().plans, []); assert.equal(f.data().settings, null);
    await cleanup;
    assert.deepEqual(attemptedResources(f), [0, 1, 2]);
    assert.ok(f.events.some(event => event.name === 'activity-dispose'));
    assert.ok(f.events.some(event => event.name === 'consumer-dispose'));
    assert.ok(f.events.some(event => event.name === 'speech-dispose' && event.adapter === f.shellSpeech));
    assert.equal(f.events.filter(event => event.name === 'local-clear').length, 1);
    assert.deepEqual(f.host.cleanupSnapshot(), { status: 'complete', failedSteps: [] });
    assert.equal(original.isCurrent(), false); assert.equal(f.storage.value, null); assert.deepEqual(f.calls, []);
    const count = f.events.length; await f.host.context.onAccessDisabled(); assert.equal(f.events.length, count);
    await f.replaceAuth(); await settle();
    const replacedEffects = f.events.length;
    assert.equal(f.host.context.onAccessDisabled(), cleanup); await cleanup;
    assert.equal(f.events.length, replacedEffects); assert.equal(f.captures.length, 1);
    assert.equal(JSON.parse(f.storage.value).token, 'synthetic-foreign');
    assert.equal(f.events.filter(event => event.name === 'local-clear').length, 1);
  } finally { await f.dispose(); }
});

test('AUTH06 synthetic failures still attempt all actual captured resources, speech, audio and local clear; incomplete receipt survives view disposal and readback', async () => {
  const f = await fixture(); let selected, controller;
  try {
    f.failResource = f.failSpeech = f.failAudio = f.failClear = true;
    const cleanup = f.host.context.onAccessDisabled();
    const rejected = assert.rejects(cleanup, { code: 'device_cleanup_incomplete' });
    f.host.dispose(); await rejected;
    assert.deepEqual(attemptedResources(f), [0, 1, 2]);
    assert.ok(f.events.some(event => event.name === 'activity-dispose'));
    assert.ok(f.events.some(event => event.name === 'consumer-dispose'));
    assert.ok(f.events.some(event => event.name === 'speech-dispose' && event.adapter === f.shellSpeech));
    assert.ok(f.events.some(event => event.name === 'host-scope-stop'));
    assert.equal(f.events.filter(event => event.name === 'local-clear').length, 1);
    const retained = f.host.cleanupSnapshot();
    assert.equal(retained.status, 'incomplete');
    assert.deepEqual([...retained.failedSteps].sort(), ['audio', 'local_session', 'resources', 'speech']);
    assert.ok(Object.isFrozen(retained)); assert.ok(Object.isFrozen(retained.failedSteps));
    assert.equal(f.host.context.isCurrent(), false);
    f.receipt = receipt; selected = recovery(f); assert.ok(selected);
    controller = f.controller(selected.context); await controller.initialize(); await controller.checkStatus();
    assert.equal(controller.snapshot().phase, 'disabled');
    assert.match(controller.snapshot().message, /Device cleanup could not be confirmed/);
    assert.equal(selected.cleanupSnapshot(), retained);
    const effects = f.events.length; await controller.checkStatus(); assert.equal(f.events.length, effects);
    assert.equal(f.statusCalls.length, 2);
    for (const call of f.statusCalls) {
      assert.equal(call.init.headers.Authorization, `DeletionReceipt ${receipt.statusSecret}`);
      assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.redirect, 'error');
    }
    assert.deepEqual(f.calls, []);
  } finally { controller?.dispose(); selected?.dispose(); await f.dispose(); }
});

for (const field of ['accountId', 'authSessionId', 'accountEpoch']) test(`AUTH06 Runtime consumer selection requires the original ${field} as well as the other scope identities`, async () => {
  const f = await fixture();
  try {
    const original = f.originalScope;
    const scope = { ...original, account: { ...original.account,
      [field]: field === 'accountEpoch' ? original.account.accountEpoch + 1 : 'synthetic-other' } };
    f.runtimeNode.props.onBeforeVoiceExit({ scope, reason: 'navigation' }); await settle();
    assert.equal(f.events.some(event => event.name === 'consumer-stop'), false);
    assert.equal(f.events.filter(event => event.name === 'host-scope-stop').length, 1);
    assert.equal(f.events.find(event => event.name === 'host-scope-stop').scope, scope);
    assert.equal(f.originalHome.isCurrentSession(), true); assert.equal(f.storage.value.includes('synthetic-original'), true);
    f.events.length = 0;
    f.runtimeNode.props.onBeforeVoiceExit({ scope: original, reason: 'navigation' });
    assert.equal(f.events[0].name, 'consumer-stop'); assert.equal(f.events[1].name, 'host-scope-stop');
    assert.equal(f.events[0].current, true); await settle();
    assert.deepEqual(attemptedResources(f), []); assert.equal(f.events.some(event => event.name === 'local-clear'), false);
  } finally { await f.dispose(); }
});

test('AUTH06 foreign auth before the actual shell disabled claim rejects without capturing or clearing replacement state', async () => {
  const f = await fixture();
  try {
    await f.replaceAuth(); await settle();
    assert.equal(JSON.parse(f.storage.value).token, 'synthetic-foreign');
    const effects = f.events.length, calls = f.calls.length;
    await assert.rejects(f.host.context.onAccessDisabled(), { code: 'session_changed' });
    assert.equal(f.events.length, effects); assert.equal(f.calls.length, calls); assert.deepEqual(f.captures, []);
    assert.deepEqual(f.host.cleanupSnapshot(), { status: 'not_started', failedSteps: [] });
    assert.equal(JSON.parse(f.storage.value).token, 'synthetic-foreign');
  } finally { await f.dispose(); }
});

test('AUTH06 foreign auth during pending captured cleanup survives serialized clear and late audio/resources; the retained failure never replays', async () => {
  const f = await fixture();
  try {
    f.resourceGate = deferred(); f.audioGate = deferred(); f.clearGate = deferred();
    const cleanup = f.host.context.onAccessDisabled();
    const rejected = assert.rejects(cleanup, { code: 'device_cleanup_incomplete' });
    await settle(); assert.equal(f.host.cleanupSnapshot().status, 'pending');
    assert.deepEqual(attemptedResources(f), [0, 1, 2]);
    assert.equal(f.events.filter(event => event.name === 'local-clear').length, 1);
    f.host.dispose();
    const replacing = f.replaceAuth(); await tick(); f.clearGate.resolve(); await replacing;
    f.resourceGate.resolve(); f.audioGate.resolve(); await rejected;
    assert.equal(JSON.parse(f.storage.value).token, 'synthetic-foreign');
    const retained = f.host.cleanupSnapshot(); assert.equal(retained.status, 'incomplete');
    assert.ok(retained.failedSteps.includes('local_session')); assert.ok(retained.failedSteps.includes('audio'));
    const effects = f.events.length, calls = f.calls.length;
    assert.equal(f.host.context.onAccessDisabled(), cleanup);
    await assert.rejects(cleanup, { code: 'device_cleanup_incomplete' });
    const selected = recovery(f); assert.ok(selected);
    try { await assert.rejects(selected.context.onAccessDisabled(), { code: 'device_cleanup_incomplete' }); }
    finally { selected.dispose(); }
    assert.equal(f.events.length, effects); assert.equal(f.calls.length, calls);
    assert.equal(f.host.cleanupSnapshot(), retained); assert.equal(JSON.parse(f.storage.value).token, 'synthetic-foreign');
  } finally { await f.dispose(); }
});

test('AUTH06 composed lifecycle initiation/export remain unavailable; speech is platform unsupported and real standard coaching lacks a turn port', async () => {
  const f = await fixture(); let controller;
  try {
    assert.equal(f.host.context.actionsQualified, false);
    assert.equal(f.host.context.createReceipt, undefined); assert.equal(f.host.context.deliverExport, undefined);
    assert.deepEqual(f.custodyCalls, []);
    controller = f.controller(f.host.context); await controller.initialize();
    assert.equal(controller.snapshot().available, false); assert.equal(controller.snapshot().deletionAvailable, false);
    assert.equal(controller.snapshot().exportAvailable, false);
    await controller.requestDeletion(); await controller.confirmDeletion('synthetic-password', 'DELETE'); await controller.exportAccount('synthetic-password');
    assert.deepEqual(f.calls.map(call => call.path), ['/v1/me/settings']);
    assert.equal(f.calls[0].authorization, 'Bearer synthetic-original');
    assert.deepEqual(f.custodyCalls, [['original', origin]]); assert.deepEqual(f.captures, []);
    assert.deepEqual(await f.shellSpeech.availability('en-US'), { available: false, reason: 'platform_unsupported',
      locale: 'en-US', permissions: null, onDeviceSupported: false });
    await f.coaching.props.consumer.start();
    assert.equal(f.coaching.props.consumer.snapshot().failure, 'turn_unavailable');
    assert.equal(f.events.some(event => event.name === 'local-clear'), false);
    assert.equal(JSON.parse(f.storage.value).token, 'synthetic-original');
  } finally { controller?.dispose(); await f.dispose(); }
});
