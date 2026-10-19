const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function loader(mocks = {}) {
  const cache = new Map();
  function load(name) {
    let file = path.resolve(root, name);
    if (!fs.existsSync(file)) file += '.ts';
    else if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.ts');
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
const load = loader();
const { ApiError } = load('api/transport.ts');
const { createStandardVoiceConsumer } = load('voice-coaching/standard/controller.ts');
const { createCommandOwnerRegistry } = load('integration/commandOwnerSession.ts');
const { FormResources } = loader({ 'api/client.ts': { ApiError, formApi: null } })('api/resources.ts');
const jsx = (type, props, key) => ({ type, props, key });
const noop = () => {};
const released = () => ({ status: 'released', failedSteps: [] });
const tick = () => new Promise(setImmediate);
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
function wave() {
  const bytes = new Uint8Array(46), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) [...text].forEach((char, i) => { bytes[offset + i] = char.charCodeAt(0); });
  for (const [offset, value] of [[4, 38], [16, 16], [24, 16000], [28, 32000], [40, 2]]) view.setUint32(offset, value, true);
  for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(offset, value, true);
  return bytes;
}
const result = () => ({ outcome: { kind: 'succeeded', value: { audio: wave(), mediaType: 'audio/wav' } }, accounting: 'settled',
  review: { transcript: 'synthetic original review', reply: 'synthetic original reply' } });
function fixture({ missingTurn = false, consumerFactory = createStandardVoiceConsumer, activityBoundary = true } = {}) {
  const runtimeHooks = hooks(), activityHooks = hooks(), listeners = new Set(), authListeners = new Set();
  const f = { constructions: 0, produced: [], hosts: 0, keys: 0, handles: [], turns: [], events: [], captures: [], options: [], current: true,
    cleanupReceipt: released(), activityFailure: false, hostObserver: null, turnWork: null, beforeHostReturn: null,
    scopedStops: [], dictationAdapters: [], scopeStopObserver: null };
  let authGeneration = 1, activity;
  const api = { captureAuthContext() { const original = authGeneration; return { isCurrent: () => authGeneration === original }; },
    subscribeAuthChanges(listener) { authListeners.add(listener); return { remove: () => authListeners.delete(listener) }; },
    request: async () => { assert.fail('No API request is authorized by this synthetic fixture.'); } };
  const resources = new FormResources(api);
  const speech = { cancel: async () => {}, dispose: async () => { f.events.push('activity-dispose'); if (f.activityFailure) throw new Error('activity cleanup failed'); } };
  const voice = { speech(scope) {
      const bound = { scope, cancels: 0, adapter: { ...speech, async cancel() { bound.cancels++; } } };
      f.dictationAdapters.push(bound); return bound.adapter;
    },
    async startStandard(scope, sessionId, signal) {
      f.events.push('host-acquire');
      const handle = { scope, sessionId, signal, stopCalls: 0,
        fence: { ...scope.account, generation: f.handles.length + 1 }, assertCurrent() { assert.equal(signal.aborted, false); },
        startCapture: async () => { f.events.push('capture-start'); }, finishCapture: async () => new Blob([wave()], { type: 'audio/wav' }), play: async () => {},
        async stop(reason) { handle.stopCalls++; f.events.push(['handle-stop', sessionId, reason]); return f.cleanupReceipt; } };
      f.handles.push(handle); f.beforeHostReturn?.(handle); return handle;
    },
    async stop(reason) { f.events.push(['host-stop', reason]); f.hostObserver?.(reason); return released(); },
    async stopScope(scope, reason) {
      f.scopedStops.push({ scope, reason }); f.scopeStopObserver?.(scope, reason);
      const matching = f.dictationAdapters.filter(bound => bound.scope?.account.accountId === scope.account.accountId &&
        bound.scope.account.authSessionId === scope.account.authSessionId && bound.scope.account.accountEpoch === scope.account.accountEpoch);
      await Promise.all(matching.map(bound => bound.adapter.cancel())); return released();
    }, dispose: async () => {},
  };
  const turn = { async run(input) { f.turns.push(input); return f.turnWork ? f.turnWork(input) : result(); } };
  const native = { AccessibilityInfo: {}, AppState: { addEventListener(_name, listener) { listeners.add(listener); return { remove: () => listeners.delete(listener) }; } } };
  const mocks = { react: runtimeHooks.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native, 'expo-crypto': {},
    'api/client.ts': { ApiError, commandKey: () => 'synthetic-turn-' + (++f.keys) }, 'api/resources.ts': { formResources: null },
    'api/phoneSignIn.ts': {}, 'api/featureBoard.ts': {}, 'api/community.ts': {}, 'api/appleSignIn.ts': {}, 'body/index.ts': {},
    'native/runtime.ts': { bindFormNativeModule: () => ({ module: null, reason: 'platform_unsupported' }) },
    'integration/sharedVoice.ts': { createSharedVoice(options) { f.hosts++; f.options.push(options); return voice; } },
    'account-lifecycle/native.ts': {}, 'integration/lifecycleSession.ts': { createLifecycleSession: options => options },
    'integration/commandOwnerSession.ts': { createCommandOwnerRegistry() {
      const registry = createCommandOwnerRegistry();
      return { ...registry, captureCleanup(selection, disposals) { f.captures.push({ selection, disposals }); return registry.captureCleanup(selection, disposals); } };
    } },
    'integration/presentationPolicy.ts': { resolvePresentationPolicy: () => ({}) },
    'integration/systemMotion.ts': { observeSystemMotion: () => noop }, 'settings/appMode.ts': { appModeFrom: () => 'basic' },
    'features/index.ts': { FormAccountApp: 'Shell' },
    'voice-coaching/standard/controller.ts': { createStandardVoiceConsumer(options) {
      f.constructions++; const consumer = consumerFactory(options); f.produced.push(consumer); return consumer;
    } },
  };
  const runtime = loader(mocks)('FormRuntime.tsx').FormRuntime;
  const props = { resources, renderSettings: () => null,
    ...(activityBoundary ? { renderActivity: ctx => { activity = ctx; return 'activity'; } } : {}),
    ...(missingTurn ? {} : { standardTurn: turn }) };
  let shell = runtimeHooks.render(runtime, props);
  function context(generation = 'original:1', selectedResources = resources) {
    const auth = api.captureAuthContext();
    const voiceScope = { account: { accountId: 'original', authSessionId: generation, accountEpoch: 1 }, isCurrent: () => f.current && auth.isCurrent() };
    return { account: { accountId: 'original', preferences: {} }, appMode: 'basic', resources: selectedResources,
      sessionGeneration: generation, voiceScope, isCurrentSession: () => f.current && auth.isCurrent(), close: noop };
  }
  let ctx = context();
  const renderActivity = () => {
    const node = shell.props.renderActivity(ctx);
    // The actual private Activity boundary uses the same React surface, with independent hook storage.
    mocks.react.useState = activityHooks.react.useState;
    mocks.react.useRef = activityHooks.react.useRef;
    mocks.react.useMemo = activityHooks.react.useMemo;
    mocks.react.useCallback = activityHooks.react.useCallback;
    mocks.react.useEffect = activityHooks.react.useEffect;
    return activityHooks.render(node.type, node.props);
  };
  // Preserve the Runtime hook surface before routing the private boundary's React calls.
  const runtimeReact = { ...runtimeHooks.react };
  Object.assign(f, { props, api, resources, voice, turn, context, ctx: () => ctx, activity: () => activity, renderActivity,
    replaceContext(next) { ctx = next; renderActivity(); renderActivity(); },
    renderRuntime() { Object.assign(mocks.react, runtimeReact); shell = runtimeHooks.render(runtime, props); },
    auth() { authGeneration++; for (const observer of [...authListeners]) observer(); },
    background() { for (const observer of [...listeners]) observer('background'); },
    voiceExit(input) { shell.props.onBeforeVoiceExit?.(input); },
    interrupted(input) { f.options[0].onStandardInvalidated?.(input); },
    capture(generation = ctx.sessionGeneration) {
      const lifecycle = shell.props.lifecycleSession({ accountId: 'original', sessionKey: generation, voiceScope: ctx.voiceScope });
      return lifecycle.captureResources();
    },
    async dispose() { activityHooks.dispose(); runtimeHooks.dispose(); await tick(); },
  });
  if (activityBoundary) { renderActivity(); renderActivity(); }
  return f;
}

test('actual Runtime Activity alone exposes the lazy factory and retains the first callback and session', async () => {
  const f = fixture();
  try {
    assert.equal(f.hosts, 1); assert.equal(f.constructions, 0); assert.equal(f.handles.length, 0);
    assert.equal(f.props.createStandardCoaching, undefined);
    const first = () => {}, second = () => {};
    const create = f.activity().createStandardCoaching, session = create(first);
    assert.equal(session.props.consumer, f.produced[0]);
    assert.equal(f.constructions, 1); assert.equal(create(first), session); assert.equal(create(second), null);
    f.renderActivity(); assert.equal(f.activity().createStandardCoaching(first), session);
    await session.props.consumer.start(); await session.props.consumer.finishAndSend();
    assert.equal(f.handles.length, 1); assert.equal(f.turns.length, 1); assert.equal(f.keys, 1);
    assert.deepEqual(f.handles[0].scope.account, f.ctx().voiceScope.account);
    assert.deepEqual(f.turns[0].scope.account, f.ctx().voiceScope.account);
    const cleanup = session.props.consumer.dispose(); assert.equal(create(first), null);
    await cleanup; assert.equal(create(first), null); assert.equal(create(second), null);
    const ownedCleanup = session.dispose(); assert.equal(session.dispose(), ownedCleanup); await ownedCleanup;
    await assert.rejects(session.props.consumer.start(), /disposed/);
  } finally { await f.dispose(); }
});

test('missing turn stays unavailable before private-host acquisition or key issuance', async () => {
  const f = fixture({ missingTurn: true });
  try {
    const session = f.activity().createStandardCoaching(noop); await session.props.consumer.start();
    assert.equal(session.props.consumer.snapshot().failure, 'turn_unavailable');
    assert.equal(f.handles.length, 0); assert.equal(f.keys, 0); assert.equal(f.turns.length, 0);
  } finally { await f.dispose(); }
});

test('disposal before any explicit factory call closes admission without constructing a consumer', async () => {
  const f = fixture();
  try {
    const ctx = f.activity(); await f.capture()();
    assert.equal(f.constructions, 0); assert.equal(ctx.createStandardCoaching(noop), null);
    assert.equal(f.handles.length, 0);
  } finally { await f.dispose(); }
});

test('captured ports and scope resist retargeting; manual callback receives no review and expires with the original owner', async () => {
  const f = fixture();
  try {
    const manual = [], callback = (...args) => manual.push(args), session = f.activity().createStandardCoaching(callback);
    f.turn.run = () => { throw new Error('replacement turn used'); };
    f.voice.startStandard = () => { throw new Error('replacement host used'); };
    f.ctx().voiceScope.account.accountId = 'replacement'; f.ctx().voiceScope.isCurrent = () => false;
    await session.props.consumer.start(); await session.props.consumer.finishAndSend();
    assert.equal(f.turns[0].scope.account.accountId, 'original'); assert.ok(session.props.consumer.review());
    await session.props.consumer.useManual(); assert.deepEqual(manual, [[]]); assert.equal(session.props.consumer.review(), null);
    f.current = false; await session.props.consumer.useManual(); assert.equal(manual.length, 1);
    assert.equal(f.activity().createStandardCoaching(callback), null);
  } finally { await f.dispose(); }
});

test('auth and background clear review and abort synchronously before private shared-host cleanup', async () => {
  for (const event of ['background', 'auth']) {
    const f = fixture();
    try {
      const session = f.activity().createStandardCoaching(noop);
      await session.props.consumer.start(); await session.props.consumer.finishAndSend();
      assert.ok(session.props.consumer.review());
      let observed = 0;
      f.hostObserver = reason => {
        observed++; assert.equal(reason, event === 'auth' ? 'account_changed' : 'background');
        assert.equal(f.handles[0].signal.aborted, true); assert.equal(session.props.consumer.review(), null);
      };
      f[event](); assert.equal(observed, 1); assert.equal(f.handles[0].signal.aborted, true);
      f.hostObserver = null;
      if (event === 'auth') assert.equal(f.activity().createStandardCoaching(noop), null);
      await tick(); assert.equal(f.handles[0].stopCalls, 1);
    } finally { await f.dispose(); }
  }
});

test('registry captures exact generation cleanup and stale disposal cannot stop a replacement consumer', async () => {
  const f = fixture();
  try {
    const old = f.activity().createStandardCoaching(noop); await old.props.consumer.start();
    const captured = f.capture('original:1'), originalSelection = f.captures.at(-1);
    assert.equal(originalSelection.selection.resources, f.resources); assert.equal(originalSelection.disposals.length, 1);
    f.replaceContext(f.context('original:2', new FormResources(f.api))); await tick();
    const next = f.activity().createStandardCoaching(noop); await next.props.consumer.start();
    assert.notEqual(old, next); assert.equal(f.capture('missing') instanceof Function, true);
    assert.equal(f.captures.at(-1).disposals.length, 0);
    await captured(); assert.equal(f.handles[1].signal.aborted, false); assert.equal(f.handles[1].stopCalls, 0);
    assert.equal(old.props.consumer.snapshot().phase, 'disposed');
  } finally { await f.dispose(); }
});

test('registry adapter rejects the exact incomplete receipt, memoizes cleanup and still attempts Activity disposal', async () => {
  for (const receipt of [{ status: 'incomplete', failedSteps: ['synthetic'] }, { status: 'released', failedSteps: ['synthetic'] }]) {
    let disposed = 0;
    const f = fixture({ consumerFactory: options => ({ ...createStandardVoiceConsumer(options),
      dispose() { disposed++; return Promise.resolve(receipt); } }) });
    try {
      const session = f.activity().createStandardCoaching(noop), cleanup = f.capture();
      f.activityFailure = true;
      const exactDispose = f.captures.at(-1).disposals[0];
      const first = exactDispose(); assert.equal(exactDispose(), first);
      await assert.rejects(first, error => error === receipt);
      await assert.rejects(cleanup, /cleanup is incomplete/);
      assert.equal(await session.dispose(), receipt); assert.equal(disposed, 1);
      assert.ok(f.events.includes('activity-dispose')); assert.equal(f.activity().createStandardCoaching(noop), null);
    } finally { await f.dispose(); }
  }
});

test('an Activity disposal failure still disposes Standard and closes its retained factory', async () => {
  const f = fixture();
  try {
    const ctx = f.activity(), session = ctx.createStandardCoaching(noop); await session.props.consumer.start();
    f.activityFailure = true; const cleanup = f.capture();
    await assert.rejects(cleanup, /cleanup is incomplete/);
    assert.equal((await session.dispose()).status, 'released'); assert.equal(f.handles[0].stopCalls, 1);
    assert.equal(ctx.createStandardCoaching(noop), null);
  } finally { await f.dispose(); }
});

test('resource and view expiry permanently reject retained factories even if the caller later restores its predicate', async () => {
  for (const effect of ['resources', 'view']) {
    const f = fixture();
    try {
      const ctx = f.activity(), callback = () => {}, session = ctx.createStandardCoaching(callback);
      if (effect === 'resources') f.replaceContext(f.context('original:1', new FormResources(f.api)));
      else f.current = false;
      assert.equal(ctx.createStandardCoaching(callback), null); f.current = true;
      assert.equal(ctx.createStandardCoaching(callback), null);
      await session.props.consumer.start().catch(error => assert.match(error.message, /disposed/)); assert.equal(f.handles.length, 0);
    } finally { await f.dispose(); }
  }
});


const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
test('voice exit Runtime selects the original generation account and epoch instead of broadcasting a stop', async () => {
  const f = fixture(), late = deferred(); let sending;
  try {
    const session = f.activity().createStandardCoaching(noop); f.turnWork = () => late.promise;
    await session.props.consumer.start(); sending = session.props.consumer.finishAndSend(); await tick();
    assert.equal(f.turns.length, 1); const handle = f.handles[0], original = f.ctx().voiceScope;
    for (const patch of [{ accountId: 'other' }, { authSessionId: 'other-generation' }, { accountEpoch: original.account.accountEpoch + 1 }]) {
      f.voiceExit({ scope: { account: { ...original.account, ...patch }, isCurrent: () => true }, reason: 'navigation' });
      assert.equal(handle.signal.aborted, false);
    }
    // An epoch-first caller may already be stale: exact captured identity still selects its owner for stopping.
    f.voiceExit({ scope: { account: { ...original.account }, isCurrent: () => false }, reason: 'navigation' });
    assert.equal(handle.signal.aborted, true); assert.equal(session.props.consumer.review(), null);
    assert.equal(f.events.filter(event => Array.isArray(event) && event[0] === 'host-stop').length, 0);
    late.resolve(result()); await sending; assert.equal(session.props.consumer.review(), null);
  } finally { late.resolve(result()); await sending; await f.dispose(); }
});

test('voice interruption Runtime selects exact session signal scope triple and acquired full fence', async () => {
  const f = fixture();
  try {
    const session = f.activity().createStandardCoaching(noop); await session.props.consumer.start();
    await session.props.consumer.finishAndSend(); assert.ok(session.props.consumer.review());
    const handle = f.handles[0], event = { scope: handle.scope, fence: handle.fence, sessionId: handle.sessionId, signal: handle.signal, reason: 'interruption' };
    for (const patch of [
      { sessionId: 'wrong-session' }, { signal: new AbortController().signal },
      { scope: { ...handle.scope, account: { ...handle.scope.account, accountId: 'other' } } },
      { scope: { ...handle.scope, account: { ...handle.scope.account, authSessionId: 'other-generation' } } },
      { scope: { ...handle.scope, account: { ...handle.scope.account, accountEpoch: handle.scope.account.accountEpoch + 1 } } },
      { fence: { ...handle.fence, generation: handle.fence.generation + 1 } },
      { fence: { ...handle.fence, accountEpoch: handle.fence.accountEpoch + 1 } },
    ]) {
      f.interrupted({ ...event, ...patch }); assert.equal(handle.signal.aborted, false); assert.ok(session.props.consumer.review());
    }
    f.interrupted(event); assert.equal(handle.signal.aborted, true); assert.equal(session.props.consumer.review(), null);
    await tick(); assert.equal(handle.stopCalls, 1);
    await session.props.consumer.start(); const replacement = f.handles[1];
    f.interrupted(event); assert.equal(replacement.signal.aborted, false); assert.equal(replacement.stopCalls, 0);
    f.interrupted({ scope: replacement.scope, fence: replacement.fence, sessionId: replacement.sessionId,
      signal: replacement.signal, reason: 'interruption' });
    assert.equal(replacement.signal.aborted, true);
  } finally { await f.dispose(); }
});

test('voice interruption Runtime records original id and signal before awaiting the private host continuation', async () => {
  const f = fixture(); let abortedBeforeReturn = false;
  try {
    f.beforeHostReturn = handle => {
      f.interrupted({ scope: handle.scope, fence: handle.fence, sessionId: handle.sessionId, signal: handle.signal, reason: 'interruption' });
      abortedBeforeReturn = handle.signal.aborted;
    };
    const session = f.activity().createStandardCoaching(noop); await session.props.consumer.start();
    assert.equal(abortedBeforeReturn, true); assert.equal(f.events.includes('capture-start'), false);
    assert.equal(f.turns.length, 0); assert.equal(f.handles[0].stopCalls, 1);
  } finally { await f.dispose(); }
});


for (const reason of ['navigation', 'logout']) test(`voice exit Runtime scoped host ${reason} follows synchronous consumer stop and cleans only original dictation scope`, async () => {
  const f = fixture();
  try {
    const session = f.activity().createStandardCoaching(noop);
    await session.props.consumer.start(); await session.props.consumer.finishAndSend(); assert.ok(session.props.consumer.review());
    const scope = f.ctx().voiceScope, originalDictation = f.dictationAdapters[0];
    const otherScope = { account: { ...scope.account, authSessionId: 'replacement:2', accountEpoch: scope.account.accountEpoch + 1 }, isCurrent: () => true };
    f.voice.speech(otherScope); const replacementDictation = f.dictationAdapters.at(-1);
    const order = [];
    f.scopeStopObserver = (captured, capturedReason) => {
      order.push({ captured, capturedReason, aborted: f.handles[0].signal.aborted, review: session.props.consumer.review() });
    };
    f.voiceExit({ scope, reason });
    assert.equal(f.handles[0].signal.aborted, true); assert.equal(session.props.consumer.review(), null);
    await tick();
    assert.equal(f.scopedStops.length, 1, 'The admitted exit must stop the private host as well as its Standard consumer.');
    assert.equal(f.scopedStops[0].scope, scope); assert.equal(f.scopedStops[0].reason, reason);
    assert.deepEqual(order, [{ captured: scope, capturedReason: reason, aborted: true, review: null }]);
    assert.equal(originalDictation.cancels, 1); assert.equal(replacementDictation.cancels, 0);
    assert.equal(f.events.filter(event => Array.isArray(event) && event[0] === 'host-stop').length, 0);
  } finally { await f.dispose(); }
});


test('voice exit Runtime scoped host handles dictation-only scope with no Standard registry owner or construction', async () => {
  const f = fixture({ activityBoundary: false });
  try {
    const scope = f.ctx().voiceScope; f.voice.speech(scope);
    assert.equal(f.constructions, 0); assert.equal(f.handles.length, 0);
    f.voiceExit({ scope, reason: 'navigation' }); await tick();
    assert.equal(f.scopedStops.length, 1); assert.equal(f.scopedStops[0].scope, scope); assert.equal(f.scopedStops[0].reason, 'navigation');
    assert.equal(f.dictationAdapters[0].cancels, 1); assert.equal(f.constructions, 0);
    assert.equal(f.events.filter(event => Array.isArray(event) && event[0] === 'host-stop').length, 0);
  } finally { await f.dispose(); }
});

test('voice exit Runtime scoped host follows synchronous abort of a pending Standard turn', async () => {
  const f = fixture(), late = deferred(); let sending;
  try {
    const session = f.activity().createStandardCoaching(noop); f.turnWork = () => late.promise;
    await session.props.consumer.start(); sending = session.props.consumer.finishAndSend(); await tick(); assert.equal(f.turns.length, 1);
    const observed = [];
    f.scopeStopObserver = () => observed.push(f.turns[0].signal.aborted);
    f.voiceExit({ scope: f.ctx().voiceScope, reason: 'logout' }); assert.equal(f.turns[0].signal.aborted, true);
    await tick(); assert.deepEqual(observed, [true]); assert.equal(f.scopedStops.length, 1);
    late.resolve(result()); await sending; assert.equal(session.props.consumer.review(), null);
  } finally { late.resolve(result()); await sending; await f.dispose(); }
});
