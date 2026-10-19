const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
const origin = 'https://form.example.invalid';
const noop = () => {};
const jsx = (type, props, key) => ({ type, props, key });
const names = new Proxy({}, { get: (_, name) => name });
const tokens = new Proxy({}, { get: () => tokens });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }

function loader(mocks = {}) {
  const cache = new Map();
  function load(name) {
    let file = path.resolve(root, name);
    if (!fs.existsSync(file)) file += '.ts';
    else if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.ts');
    assert.ok(file.startsWith(root + path.sep));
    const relative = path.relative(root, file);
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (relative === 'features/index.ts') return load('features/shell/FormAccountApp.tsx');
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

// Separate hook frames compose actual components; no auth callback is manufactured by the renderer.
function renderer() {
  let active;
  const frames = new Set();
  const changed = (old, deps) => !old || deps.length !== old.deps.length || deps.some((v, i) => !Object.is(v, old.deps[i]));
  const react = {
    useState(initial) {
      const frame = active, i = frame.cursor++;
      if (!(i in frame.slots)) frame.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [frame.slots[i], value => { frame.slots[i] = typeof value === 'function' ? value(frame.slots[i]) : value; }];
    },
    useRef(initial) { const frame = active, i = frame.cursor++; return frame.slots[i] ??= { current: initial }; },
    useMemo(fn, deps) {
      const frame = active, i = frame.cursor++;
      if (changed(frame.slots[i], deps)) frame.slots[i] = { deps, value: fn() };
      return frame.slots[i].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const frame = active, i = frame.cursor++, old = frame.slots[i];
      if (changed(old, deps)) frame.effects.push(() => { old?.cleanup?.(); frame.slots[i] = { deps, cleanup: fn() }; });
    },
  };
  return { react,
    frame() { const frame = { slots: [], cursor: 0, effects: [] }; frames.add(frame); return frame; },
    render(frame, Component, props) {
      active = frame; frame.cursor = 0; frame.effects = [];
      const node = Component(props);
      for (const effect of frame.effects) effect();
      return node;
    },
    disposeFrame(frame) { for (const slot of frame.slots) slot?.cleanup?.(); frames.delete(frame); },
    dispose() { for (const frame of [...frames]) this.disposeFrame(frame); },
  };
}
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === type) return tree;
  for (const child of [tree.props?.children].flat()) { const found = find(child, type); if (found) return found; }
  return null;
}
function account(accountId = 'original') {
  return { accountId, onboarding: { status: 'completed' },
    profile: { revision: 4, name: accountId, age: null, heightCm: null, weightKg: null, trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'direct',
      communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['dumbbell'], remindersEnabled: false } };
}
function wave() {
  const bytes = new Uint8Array(46), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) [...text].forEach((char, i) => { bytes[offset + i] = char.charCodeAt(0); });
  for (const [offset, value] of [[4, 38], [16, 16], [24, 16000], [28, 32000], [40, 2]]) view.setUint32(offset, value, true);
  for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(offset, value, true);
  return bytes;
}
const turnResult = () => ({ outcome: { kind: 'succeeded', value: { audio: wave(), mediaType: 'audio/wav' } }, accounting: 'settled',
  review: { transcript: 'synthetic private transcript', reply: 'synthetic private reply' } });

async function fixture(options = {}) {
  const r = renderer(), runtimeFrame = r.frame(), shellFrame = r.frame();
  const calls = [], storageEvents = [], hostStops = [], physicalCalls = [], turns = [], subscriptions = [], appListeners = new Set();
  let home, settings, security, lifecycleShell, shellNode, tree, voice, keys = 0;
  const f = { currentAccount: account(), accountRead: null, profileWrite: null, denied: null, turnWork: null, activity: null, sessionRead: options.holdSession ? deferred() : null, storageWait: null, nativeWait: null };
  const storage = { value: JSON.stringify({ version: 1, baseURL: origin, token: 'synthetic-original' }),
    async load() { return this.value; },
    async save(value) { storageEvents.push(['save', JSON.parse(value).token]); this.value = value; },
    async clear() { storageEvents.push(['clear', this.value && JSON.parse(this.value).token]); if (f.storageWait) await f.storageWait.promise; this.value = null; },
  };
  const transport = loader()('api/transport.ts');
  const api = new transport.FormTransport(origin, storage, async (url, init) => {
    const call = { path: new URL(url).pathname, method: init.method, authorization: init.headers.Authorization, body: init.body };
    calls.push(call);
    if (call.path === '/api/auth/get-session') return f.sessionRead ? f.sessionRead.promise : json({ session: { id: 'synthetic-session', token: init.headers.Authorization.slice(7), userId: 'synthetic', expiresAt: new Date(Date.now() + 60_000).toISOString() }, user: { id: 'synthetic' } });
    if (call.path === '/api/auth/sign-in/email') return json({}, 200, { 'set-auth-token': 'synthetic-replacement' });
    if (call.path === '/v1/stats') return f.denied ? f.denied.promise : json({ accountId: f.currentAccount.accountId });
    if (call.path === '/v1/me') return f.accountRead ? f.accountRead.promise : json(f.currentAccount);
    if (call.path === '/v1/me/profile') return f.profileWrite ? f.profileWrite() : json(f.currentAccount.profile);
    if (call.path === '/v1/capabilities') return json({});
    if (call.path === '/v1/me/settings' || call.path === '/v1/entitlements') return json({ accountId: f.currentAccount.accountId });
    if (call.path === '/v1/exercises' || call.path === '/v1/plans') return json({ items: [] });
    assert.fail('Unexpected actual transport request: ' + call.method + ' ' + call.path);
  });
  class FormNativeError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const speechNative = { addListener: () => ({ remove: noop }), cancel: async () => {}, stop: async () => {} };
  const platform = { StyleSheet: { create: value => value }, View: 'View', Pressable: 'Pressable', AccessibilityInfo: {},
    AppState: { currentState: 'active', addEventListener: (_, listener) => { appListeners.add(listener); return { remove: () => appListeners.delete(listener) }; } } };
  const mocks = { react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': platform, 'expo-crypto': {},
    'api/transport.ts': transport,
    'api/client.ts': { ...transport, formApi: null, commandKey: () => 'synthetic-command-' + (++keys) },
    'api/phoneSignIn.ts': {}, 'api/appleSignIn.ts': {},
    'body/index.ts': { bodyPrivacySummary: () => ({ status: 'unavailable', reason: 'synthetic' }) },
    'native/runtime.ts': { FormNativeError, bindFormNativeModule: () => ({ module: speechNative }) },
    'account-lifecycle/native.ts': {},
    'integration/systemMotion.ts': { observeSystemMotion: () => noop },
    'features/account/AccountScreens.ts': names, 'features/auth/AuthFlow.ts': names,
    'features/cues/CuesScreen.ts': names, 'features/onboarding/OnboardingFlow.ts': names,
    'features/plans/PlansScreens.ts': names,
    'features/shared/copy.ts': { COPY: {}, errorCopy: error => error.message },
    'features/shared/tokens.ts': { t: tokens, L: tokens }, 'features/shared/ui.ts': names,
    // The host/controller remain actual. Only the unavailable native driver is replaced with bounded in-memory ports.
    'voice-coaching/native/driver.ts': { createFormVoiceDriver(options) {
      assert.equal(options.sharedOwnershipReady, false); assert.equal(options.nativeQualified, false);
      return { availability: async () => ({ available: true }),
        micOwner: { async acquire(input) {
          options.assertCurrent(input.fence); physicalCalls.push(['acquire', input.fence]);
          const step = name => async () => { physicalCalls.push([name, input.fence]); if (f.nativeWait) await f.nativeWait.promise; };
          return { fence: input.fence, stopCapture: step('stopCapture'), stopPlayback: step('stopPlayback'),
            deactivateAudio: step('deactivateAudio'), release: step('release') };
        } },
        capture: { async start(fence) { physicalCalls.push(['startCapture', fence]); },
          async finish(fence) { physicalCalls.push(['finishCapture', fence]); return new Blob([wave()], { type: 'audio/wav' }); } },
        playback: { async play(fence) { physicalCalls.push(['play', fence]); } }, dispose: async () => {},
      };
    } },
  };
  const load = loader(mocks);
  const shared = load('integration/sharedVoice.ts'), lifecycle = load('integration/lifecycleSession.ts');
  mocks['integration/sharedVoice.ts'] = { ...shared, createSharedVoice(options) {
    voice = shared.createSharedVoice(options);
    const stop = voice.stop.bind(voice);
    return { ...voice, stop(reason) { hostStops.push(reason); return stop(reason); } };
  } };
  mocks['integration/lifecycleSession.ts'] = { ...lifecycle, createLifecycleSession(options) {
    lifecycleShell = options.shell; return lifecycle.createLifecycleSession(options);
  } };
  const { FormResources } = load('api/resources.ts'), resources = new FormResources(api);
  const { FormRuntime } = load('FormRuntime.tsx');
  const props = { resources, renderHome: ctx => { home = ctx; return 'home'; }, renderSettings: ctx => { settings = ctx; return 'settings'; },
    renderAccountSecurity: ctx => { security = ctx; return jsx('Security', {}); },
    renderActivity: ctx => { f.activity = ctx; return 'activity'; }, standardNative: {},
    standardTurn: { async run(input) { turns.push(input); return f.turnWork ? f.turnWork(input) : turnResult(); } } };
  const render = () => { shellNode = r.render(runtimeFrame, FormRuntime, props); tree = r.render(shellFrame, shellNode.type, shellNode.props); return tree; };
  render(); await settle(); render(); await settle(); render();
  home.openSettings(); render(); settings.openAccountSecurity(); render();
  assert.equal(security.isCurrentSession(), true);
  const activityFrames = [];
  function mountActivity(ctx = security, scope = lifecycleShell.voiceScope) {
    const frame = r.frame(); activityFrames.push(frame);
    // Simultaneous captured account owners exercise Runtime retention without claiming native navigation behavior.
    const node = shellNode.props.renderActivity({ account: ctx.account, appMode: 'basic', resources: ctx.resources,
      sessionGeneration: ctx.sessionGeneration, voiceScope: scope, isCurrentSession: ctx.isCurrentSession, close: noop });
    r.render(frame, node.type, node.props); r.render(frame, node.type, node.props);
    return f.activity;
  }
  const observe = api.subscribeAuthChanges(source => subscriptions.push({ source, stored: storage.value }));
  Object.assign(f, { api, resources, storage, calls, storageEvents, hostStops, physicalCalls, turns, subscriptions, render,
    security: () => security, settings: () => settings, tree: () => tree, voice: () => voice, mountActivity,
    voiceExit: input => shellNode.props.onBeforeVoiceExit(input),
    setAppState(state) { platform.AppState.currentState = state; for (const listener of appListeners) listener(state); },
    async replacement(accountId = 'replacement') {
      f.sessionRead = null; f.currentAccount = account(accountId); await api.signIn('synthetic@example.invalid', 'synthetic-password');
      render(); const auth = find(tree, 'AuthFlow'); assert.ok(auth);
      auth.props.onAuthenticated(); await settle(); render(); await settle(); render();
      home.openSettings(); render(); settings.openAccountSecurity(); render();
      assert.equal(security.account.accountId, accountId); assert.equal(security.isCurrentSession(), true);
    },
    async dispose() { observe.remove(); r.dispose(); await settle(); await voice.dispose(); },
  });
  calls.length = 0; storageEvents.length = 0; hostStops.length = 0; subscriptions.length = 0;
  return f;
}

function denied() { return json({ error: { code: 'unauthenticated', message: 'Synthetic authoritative 401' } }, 401); }
const cleanupCalls = f => f.physicalCalls.filter(call => ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release'].includes(call[0]));


module.exports = { fixture, deferred, settle, denied, cleanupCalls, find, account, json, turnResult, noop, loader };
