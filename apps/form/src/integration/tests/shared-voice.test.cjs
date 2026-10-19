const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();
class FormNativeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function load(file, driverOverride, cache = modules) {
  file = path.resolve(root, file);
  assert.ok(file.startsWith(root + path.sep));
  if (file === path.join(root, 'native/runtime.ts')) return { FormNativeError,
    bindFormNativeModule: () => ({ module: null, reason: 'platform_unsupported' }) };
  if (driverOverride && file === path.join(root, 'voice-coaching/native/driver.ts')) return { createFormVoiceDriver: driverOverride };
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
    return load(path.resolve(path.dirname(file), name + '.ts'), driverOverride, cache);
  }, module, module.exports);
  return module.exports;
}
const { createSharedVoice, captureSharedVoiceScope } = load('integration/sharedVoice.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function scope() {
  let epoch = 1, auth = 1;
  const api = { captureAuthContext() { const original = auth; return { isCurrent: () => auth === original }; } };
  const capture = () => { const original = epoch; return captureSharedVoiceScope(api,
    { accountId: 'synthetic-account', accountEpoch: original, authSessionId: `synthetic-shell:${original}` }, () => epoch === original); };
  return { capture, replace: () => { epoch++; }, replaceAuth: () => { auth++; } };
}
function fixture(t, standard, create = createSharedVoice, voiceOptions = {}) {
  const listeners = new Map(), calls = [];
  const emit = (name, event) => { for (const listener of listeners.get(name) ?? []) listener(event); };
  const native = {
    async availability(locale) { calls.push(['availability', locale]); return { available: true, reason: 'available', locale,
      permissions: { speech: 'granted', microphone: 'granted' }, onDeviceSupported: true }; },
    async requestPermissions() { return { speech: 'granted', microphone: 'granted' }; },
    async start(locale, sessionId) { calls.push(['start', locale, sessionId]); emit('onState', { sessionId, state: 'recording' }); return { sessionId }; },
    async stop(sessionId) { calls.push(['stop', sessionId]); },
    async cancel(sessionId) { calls.push(['cancel', sessionId]); },
    addListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener);
      return { remove: () => listeners.get(name).delete(listener) }; },
  };
  const voice = create({ speech: { module: native }, standard, ...voiceOptions });
  t.after(async () => { await voice.dispose().catch(() => {}); });
  return { native, voice, calls, emit, account: scope() };
}

test('shell and Activity adapters exclude each other until authoritative cleanup', async t => {
  const s = fixture(t), captured = s.account.capture();
  const shell = s.voice.speech(captured), activity = s.voice.speech(captured);
  const first = await shell.start('en-US');
  await assert.rejects(activity.start('en-US'), { code: 'voice_microphone_busy' });
  assert.equal(s.calls.filter(call => call[0] === 'start').length, 1);
  await shell.cancel();
  const second = await activity.start('en-US');
  assert.notEqual(first, second);
  assert.deepEqual(s.calls.filter(call => call[0] === 'cancel'), [['cancel', first]]);
});

test('raw late start and disposal wait for exact-session second cancellation without self-await', async t => {
  const s = fixture(t), late = deferred(), entered = deferred();
  s.native.start = async (locale, id) => { s.calls.push(['start', locale, id]); entered.resolve(id); await late.promise; return { sessionId: id }; };
  const adapter = s.voice.speech(s.account.capture());
  const starting = adapter.start('en-US');
  const rejected = assert.rejects(starting);
  const id = await entered.promise;
  let finished = false;
  const disposal = adapter.dispose().then(() => { finished = true; });
  await turn();
  assert.equal(finished, false);
  assert.deepEqual(s.calls.filter(call => call[0] === 'cancel'), [['cancel', id]]);
  await assert.rejects(s.voice.speech(s.account.capture()).start('en-US'), { code: 'voice_microphone_busy' });
  late.resolve();
  await Promise.all([disposal, rejected]);
  assert.deepEqual(s.calls.filter(call => call[0] === 'cancel'), [['cancel', id], ['cancel', id]]);
  await s.voice.speech(s.account.capture()).start('en-US');
});

test('cleanup failure retains ownership across same-account new generation', async t => {
  const s = fixture(t), old = s.voice.speech(s.account.capture());
  await old.start('en-US');
  s.native.cancel = async () => { throw new Error('synthetic deactivation failure'); };
  await assert.rejects(old.cancel(), { code: 'audio_cleanup_failed' });
  s.account.replace();
  const next = s.voice.speech(s.account.capture());
  await assert.rejects(next.start('en-US'), { code: 'voice_microphone_busy' });
  assert.equal((await s.voice.stop('account_changed')).status, 'incomplete');
  assert.equal(s.calls.filter(call => call[0] === 'start').length, 1);
  await assert.rejects(s.voice.dispose(), { code: 'audio_cleanup_failed' });
});

test('captured auth and local epoch independently reject old adapters before raw dispatch', async t => {
  const s = fixture(t);
  const old = s.voice.speech(s.account.capture());
  s.account.replaceAuth();
  await assert.rejects(old.start('en-US'), { code: 'shared_scope_unavailable' });
  const next = s.voice.speech(s.account.capture());
  s.account.replace();
  await assert.rejects(next.start('en-US'), { code: 'shared_scope_unavailable' });
  assert.deepEqual(s.calls, []);
  await s.voice.speech(s.account.capture()).start('en-US');
});

test('account invalidation while raw start is pending cleans up and hides late results', async t => {
  const s = fixture(t), late = deferred(), entered = deferred();
  s.native.start = async (locale, id) => { entered.resolve(id); await late.promise; return { sessionId: id }; };
  const adapter = s.voice.speech(s.account.capture());
  const starting = adapter.start('en-US');
  const rejected = assert.rejects(starting);
  const id = await entered.promise;
  s.account.replaceAuth();
  const stopping = s.voice.stop('account_changed');
  s.emit('onResult', { sessionId: id, text: 'old private draft', isFinal: true, locale: 'en-US' });
  assert.equal(adapter.getDraft(), null);
  late.resolve();
  assert.equal((await stopping).status, 'released');
  await rejected;
  assert.throws(() => adapter.acceptReview({ sessionId: id, reviewed: true, text: 'old private draft' }), { code: 'review_unavailable' });
});

test('ended final event cannot expose review or admit another adapter before local release', async t => {
  const s = fixture(t), cleanup = deferred();
  const first = s.voice.speech(s.account.capture()), next = s.voice.speech(s.account.capture());
  const id = await first.start('en-US');
  s.native.cancel = () => cleanup.promise;
  s.emit('onResult', { sessionId: id, text: 'final draft', isFinal: true, locale: 'en-US' });
  s.emit('onState', { sessionId: id, state: 'ended', reason: 'final' });
  assert.throws(() => first.acceptReview({ sessionId: id, reviewed: true, text: 'reviewed' }), { code: 'review_unavailable' });
  await assert.rejects(next.start('en-US'), { code: 'voice_microphone_busy' });
  cleanup.resolve(); await turn();
  assert.equal(first.acceptReview({ sessionId: id, reviewed: true, text: 'reviewed' }).text, 'reviewed');
  await next.start('en-US');
});

test('background stop invalidates preflight before any shared reservation or native start', async t => {
  const s = fixture(t), probe = deferred();
  const available = s.native.availability;
  s.native.availability = () => probe.promise;
  const adapter = s.voice.speech(s.account.capture());
  const starting = adapter.start('en-US');
  const rejected = assert.rejects(starting, { code: 'cancelled' });
  assert.equal((await s.voice.stop('background')).status, 'released');
  probe.resolve({ available: true, locale: 'en-US' }); await rejected;
  assert.equal(s.calls.filter(call => call[0] === 'start').length, 0);
  s.native.availability = available;
  await adapter.start('en-US');
});

test('untrusted missing scope and missing native remain unavailable without poisoning the owner', async t => {
  const s = fixture(t);
  assert.equal((await s.voice.speech(null).availability('en-US')).reason, 'shared_scope_unavailable');
  await assert.rejects(s.voice.speech(null).start('en-US'), { code: 'shared_scope_unavailable' });
  assert.deepEqual(s.calls, []);
  const absent = createSharedVoice({ speech: { module: null, reason: 'expo_go' } });
  assert.equal((await absent.speech(s.account.capture()).availability('en-US')).reason, 'expo_go');
  await absent.dispose();
  await s.voice.speech(s.account.capture()).start('en-US');
});

test('standard stays unavailable across dictation ownership with no probes, capture, or permission calls', async t => {
  let nativeCalls = 0;
  const standard = { binding: { module: { addListener: () => ({ remove() {} }),
    availability: async () => { nativeCalls++; return { available: true }; },
    requestPermission: async () => { nativeCalls++; }, openLease: async () => { nativeCalls++; } } },
    limits: { maxCaptureBytes: 32044, maxPlaybackBytes: 32044, maxCaptureDurationMs: 1000, sampleRate: 16000 },
    providerBounds: { maxAudioBytes: 64000, maxSpeechBytes: 64000 }, newLeaseId: () => 'synthetic-lease' };
  const s = fixture(t, standard), captured = s.account.capture();
  await assert.rejects(s.voice.startStandard(captured, 'standard-one'), { code: 'shared_ownership_unready' });
  const adapter = s.voice.speech(captured);
  await adapter.start('en-US');
  await assert.rejects(s.voice.startStandard(captured, 'standard-two'), { code: 'shared_ownership_unready' });
  assert.equal(nativeCalls, 0);
  assert.equal(s.calls.filter(call => call[0] === 'start').length, 1);
  await adapter.cancel();
  await adapter.start('en-US');
});

test('root disposal during second preflight prevents late acquisition and raw start', async t => {
  const s = fixture(t), probe = deferred(), entered = deferred();
  let count = 0;
  const available = s.native.availability;
  s.native.availability = locale => ++count === 1 ? available(locale) : (entered.resolve(), probe.promise);
  const adapter = s.voice.speech(s.account.capture());
  const starting = adapter.start('en-US');
  const rejected = assert.rejects(starting);
  await entered.promise;
  let finished = false;
  const disposal = s.voice.dispose().then(() => { finished = true; });
  await turn(); assert.equal(finished, false);
  probe.resolve({ available: true, locale: 'en-US' });
  await Promise.all([disposal, rejected]);
  assert.equal(s.calls.filter(call => call[0] === 'start').length, 0);
});

test('adapter cancellation during shared preflight releases its inert reservation without raw start', async t => {
  const s = fixture(t), probe = deferred(), entered = deferred();
  let count = 0;
  const available = s.native.availability;
  s.native.availability = locale => ++count === 1 ? available(locale) : (entered.resolve(), probe.promise);
  const adapter = s.voice.speech(s.account.capture());
  const starting = adapter.start('en-US');
  const rejected = assert.rejects(starting, { code: 'cancelled' });
  await entered.promise;
  const cancellation = adapter.cancel();
  probe.resolve({ available: true, locale: 'en-US' });
  await Promise.all([cancellation, rejected]);
  assert.equal(s.calls.filter(call => call[0] === 'start').length, 0);
  s.native.availability = available;
  await adapter.start('en-US');
});

test('synchronous final event during raw stop waits cleanup and preserves explicit review', async t => {
  const s = fixture(t), adapter = s.voice.speech(s.account.capture());
  const id = await adapter.start('en-US');
  s.native.stop = async sessionId => {
    s.emit('onResult', { sessionId, text: 'raw final', isFinal: true, locale: 'en-US' });
    s.emit('onState', { sessionId, state: 'ended', reason: 'final' });
  };
  await adapter.stop(); await turn();
  assert.equal(adapter.acceptReview({ sessionId: id, reviewed: true, text: 'edited final' }).text, 'edited final');
});

function standardFixture(t, voiceOptions = {}) {
  const calls = [], controls = {
    availability: async () => ({ available: true, reason: 'available', permission: 'granted' }),
    acquire: async lease => lease,
    cleanup: async () => {},
    finish: async () => new Blob(['synthetic-capture']),
    play: async () => {},
  };
  let options;
  const create = load('integration/sharedVoice.ts', supplied => {
    options = supplied;
    assert.equal(supplied.sharedOwnershipReady, false); assert.equal(supplied.nativeQualified, false);
    return {
      availability: () => { calls.push(['availability']); return controls.availability(); },
      micOwner: { async acquire(input) {
        supplied.assertCurrent(input.fence); calls.push(['acquire', input.fence]);
        const step = name => async () => { calls.push([name, input.fence]); await controls.cleanup(name, input.fence); };
        return controls.acquire({ fence: input.fence, stopCapture: step('stopCapture'), stopPlayback: step('stopPlayback'),
          deactivateAudio: step('deactivateAudio'), release: step('release') }, input);
      } },
      capture: {
        async start(fence) { calls.push(['startCapture', fence]); },
        async finish(fence) { calls.push(['finishCapture', fence]); return controls.finish(fence); },
      },
      playback: { async play(fence, blob) { calls.push(['play', fence]); await controls.play(fence, blob); } },
      async dispose() { calls.push(['dispose']); },
    };
  }, new Map()).createSharedVoice;
  const s = fixture(t, {}, create, voiceOptions);
  return { ...s, standardCalls: calls, controls, invalidated: fence => options.onInvalidated(fence, 'audio_error') };
}

function trackedAbort() {
  const abort = new AbortController(), callbacks = [], attached = new Set();
  const add = abort.signal.addEventListener.bind(abort.signal), remove = abort.signal.removeEventListener.bind(abort.signal);
  abort.signal.addEventListener = (type, callback, options) => {
    if (type === 'abort') { callbacks.push(callback); attached.add(callback); }
    return add(type, callback, options);
  };
  abort.signal.removeEventListener = (type, callback, options) => {
    if (type === 'abort') attached.delete(callback);
    return remove(type, callback, options);
  };
  return { abort, callbacks, attached };
}

test('already-aborted standard request makes no preflight or acquisition and does not poison the owner', async t => {
  const s = standardFixture(t), cancellation = trackedAbort(); cancellation.abort.abort();
  await assert.rejects(s.voice.startStandard(s.account.capture(), 'cancelled', cancellation.abort.signal), { name: 'AbortError' });
  assert.deepEqual(s.standardCalls, []); assert.equal(cancellation.attached.size, 0);
  const next = await s.voice.startStandard(s.account.capture(), 'fresh'); next.assertCurrent();
  assert.equal((await next.stop('user_stop')).status, 'released');
});

test('abort during standard preflight prevents shared acquisition', async t => {
  const s = standardFixture(t), probe = deferred(), cancellation = trackedAbort();
  s.controls.availability = () => probe.promise;
  const starting = s.voice.startStandard(s.account.capture(), 'preflight', cancellation.abort.signal);
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  try {
    cancellation.abort.abort(); probe.resolve({ available: true }); await rejected;
    assert.equal(s.standardCalls.filter(call => call[0] === 'acquire').length, 0);
    assert.equal(cancellation.attached.size, 0);
  } finally { probe.resolve({ available: true }); await starting.catch(() => {}); }
});

test('abort during acquisition awaits the exact late lease and its cleanup before rejecting start', async t => {
  const s = standardFixture(t), acquired = deferred(), late = deferred(), cleanup = deferred(), cancellation = trackedAbort();
  s.controls.acquire = async lease => { acquired.resolve(); await late.promise; return lease; };
  s.controls.cleanup = async name => { if (name === 'release') await cleanup.promise; };
  const starting = s.voice.startStandard(s.account.capture(), 'late', cancellation.abort.signal);
  let settled = false; const rejected = assert.rejects(starting).then(() => { settled = true; });
  try {
    await acquired.promise; cancellation.abort.abort(); await turn(); assert.equal(settled, false);
    await assert.rejects(s.voice.startStandard(s.account.capture(), 'blocked'), { code: 'voice_microphone_busy' });
    late.resolve(); await turn(); assert.equal(settled, false);
    cleanup.resolve(); await rejected;
    assert.deepEqual(s.standardCalls.filter(call => ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release'].includes(call[0])).map(call => call[0]),
      ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
    assert.equal(cancellation.attached.size, 0);
    const next = await s.voice.startStandard(s.account.capture(), 'after-cleanup'); next.assertCurrent(); await next.stop('user_stop');
  } finally { late.resolve(); cleanup.resolve(); await starting.catch(() => {}); }
});

test('old abort, native invalidation and stop callbacks cannot stop a replacement shared generation', async t => {
  const s = standardFixture(t), cancellation = trackedAbort(), captured = s.account.capture();
  const old = await s.voice.startStandard(captured, 'old', cancellation.abort.signal);
  const oldAbort = cancellation.callbacks[0]; old.assertCurrent(); await old.stop('user_stop');
  assert.equal(cancellation.attached.size, 0);
  const next = await s.voice.startStandard(captured, 'replacement');
  assert.notEqual(old.fence.generation, next.fence.generation);
  const releases = () => s.standardCalls.filter(call => call[0] === 'release').length;
  const before = releases(); oldAbort(); cancellation.abort.abort(); s.invalidated(old.fence); await old.stop('aborted');
  assert.equal(releases(), before); next.assertCurrent(); assert.throws(() => old.assertCurrent());
  await assert.rejects(old.startCapture()); await assert.rejects(old.finishCapture()); await assert.rejects(old.play(new Blob(['old'])));
  assert.equal(s.standardCalls.filter(call => ['startCapture', 'finishCapture', 'play'].includes(call[0])).length, 0);
  await next.stop('user_stop');
});

test('assertCurrent checks original auth and cannot manufacture a new shared generation', async t => {
  const s = standardFixture(t), handle = await s.voice.startStandard(s.account.capture(), 'original');
  handle.assertCurrent(); const generation = handle.fence.generation; s.account.replaceAuth();
  assert.throws(() => handle.assertCurrent(), { code: 'session_changed' });
  await assert.rejects(handle.startCapture(), { code: 'session_changed' });
  assert.equal(handle.fence.generation, generation); assert.equal(Object.isFrozen(handle.fence), true);
  assert.equal((await handle.stop('account_changed')).status, 'released');
});

test('late capture and playback completions cannot release results after their shared generation ends', async t => {
  for (const operation of ['finishCapture', 'play']) {
    const s = standardFixture(t), wait = deferred(), entered = deferred();
    if (operation === 'finishCapture') s.controls.finish = () => { entered.resolve(); return wait.promise; };
    else s.controls.play = () => { entered.resolve(); return wait.promise; };
    const old = await s.voice.startStandard(s.account.capture(), 'old');
    const pending = operation === 'play' ? old.play(new Blob(['old'])) : old.finishCapture();
    const rejected = assert.rejects(pending);
    try {
      await entered.promise; await old.stop('user_stop');
      const next = await s.voice.startStandard(s.account.capture(), 'next');
      wait.resolve(new Blob(['late private capture'])); await rejected; next.assertCurrent(); await next.stop('user_stop');
    } finally { wait.resolve(new Blob(['cleanup'])); await pending.catch(() => {}); }
  }
});

test('aborted incomplete cleanup retains ownership and detaches its listener', async t => {
  const s = standardFixture(t), cancellation = trackedAbort();
  const handle = await s.voice.startStandard(s.account.capture(), 'incomplete', cancellation.abort.signal);
  s.controls.cleanup = async name => { if (name === 'deactivateAudio') throw new Error('synthetic incomplete restoration'); };
  cancellation.abort.abort(); const result = await handle.stop('aborted');
  assert.equal(result.status, 'incomplete'); assert.ok(result.failedSteps.includes('deactivateAudio'));
  assert.equal(cancellation.attached.size, 0); assert.throws(() => handle.assertCurrent());
  s.account.replace();
  await assert.rejects(s.voice.startStandard(s.account.capture(), 'replacement'), { code: 'voice_microphone_busy' });
  await assert.rejects(s.voice.speech(s.account.capture()).start('en-US'), { code: 'voice_microphone_busy' });
});

test('unproved rejected acquisition retains the shared owner and cannot be reset by a fresh request', async t => {
  const s = standardFixture(t), cancellation = trackedAbort();
  s.controls.acquire = async () => { throw new Error('synthetic unknown acquisition'); };
  await assert.rejects(s.voice.startStandard(s.account.capture(), 'unknown', cancellation.abort.signal));
  assert.equal(cancellation.attached.size, 0);
  assert.equal((await s.voice.stop('failed')).status, 'incomplete');
  await assert.rejects(s.voice.startStandard(s.account.capture(), 'replacement'), { code: 'voice_microphone_busy' });
  assert.equal(s.standardCalls.filter(call => call[0] === 'acquire').length, 1);
});

test('root disposal during standard acquisition waits late lease cleanup and removes external cancellation listener', async t => {
  const s = standardFixture(t), acquired = deferred(), late = deferred(), cancellation = trackedAbort();
  s.controls.acquire = async lease => { acquired.resolve(); await late.promise; return lease; };
  const starting = s.voice.startStandard(s.account.capture(), 'disposing', cancellation.abort.signal);
  const rejected = assert.rejects(starting); let finished = false, disposal;
  try {
    await acquired.promise; disposal = s.voice.dispose().then(() => { finished = true; });
    await turn(); assert.equal(finished, false); late.resolve(); await Promise.all([disposal, rejected]);
    assert.equal(cancellation.attached.size, 0); assert.equal(s.standardCalls.filter(call => call[0] === 'release').length, 1);
    await assert.rejects(s.voice.startStandard(s.account.capture(), 'after-dispose'), { code: 'module_destroyed' });
  } finally { late.resolve(); await starting.catch(() => {}); await disposal; }
});

test('enabled synthetic standard and dictation still share one exclusive owner', async t => {
  const s = standardFixture(t), captured = s.account.capture(), adapter = s.voice.speech(captured);
  const standard = await s.voice.startStandard(captured, 'standard');
  await assert.rejects(adapter.start('en-US'), { code: 'voice_microphone_busy' });
  await standard.stop('user_stop'); await adapter.start('en-US');
  await assert.rejects(s.voice.startStandard(captured, 'blocked-standard'), { code: 'voice_microphone_busy' });
  await adapter.cancel();
});


const teardownCalls = s => s.standardCalls.filter(call => ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release'].includes(call[0]));
test('voice interruption emits original signal session scope and full fence before exact physical teardown', async t => {
  const events = [], cancellation = trackedAbort(); let s;
  s = standardFixture(t, { onStandardInvalidated(event) {
    events.push(event); assert.equal(teardownCalls(s).length, 0);
  } });
  const scope = s.account.capture(), handle = await s.voice.startStandard(scope, 'original-interruption', cancellation.abort.signal);
  s.invalidated(handle.fence);
  assert.equal(events.length, 1); assert.equal(events[0].reason, 'interruption');
  assert.equal(events[0].sessionId, 'original-interruption'); assert.equal(events[0].signal, cancellation.abort.signal);
  assert.deepEqual(events[0].scope.account, scope.account); assert.equal(events[0].scope.isCurrent, scope.isCurrent);
  assert.deepEqual(events[0].fence, handle.fence);
  assert.equal((await handle.stop('interruption')).status, 'released');
  assert.deepEqual(teardownCalls(s).map(call => call[0]), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
  for (const call of teardownCalls(s)) assert.deepEqual(call[1], handle.fence);
});

test('voice interruption observer failure cannot skip cleanup or turn an incomplete exact receipt into released', async t => {
  const events = [], s = standardFixture(t, { onStandardInvalidated(event) {
    events.push(event); throw new Error('synthetic observer failure');
  } });
  const handle = await s.voice.startStandard(s.account.capture(), 'incomplete-interruption', new AbortController().signal);
  s.controls.cleanup = async name => { if (name === 'deactivateAudio') throw new Error('synthetic incomplete restoration'); };
  assert.doesNotThrow(() => s.invalidated(handle.fence));
  const receipt = await handle.stop('interruption');
  assert.equal(events.length, 1); assert.equal(receipt.status, 'incomplete'); assert.ok(receipt.failedSteps.includes('deactivateAudio'));
  assert.equal(teardownCalls(s).filter(call => call[0] === 'release').length, 1);
  await assert.rejects(s.voice.startStandard(s.account.capture(), 'replacement'), { code: 'voice_microphone_busy' });
});

test('voice interruption delayed old full fence leaves a replacement record and observer untouched', async t => {
  const events = [], s = standardFixture(t, { onStandardInvalidated: event => events.push(event) });
  const scope = s.account.capture(), old = await s.voice.startStandard(scope, 'old-interruption', new AbortController().signal);
  await old.stop('user_stop');
  const signal = new AbortController().signal, next = await s.voice.startStandard(scope, 'replacement-interruption', signal);
  const before = teardownCalls(s).length;
  s.invalidated(old.fence); await turn();
  assert.equal(events.length, 0); assert.equal(teardownCalls(s).length, before); next.assertCurrent();
  s.invalidated(next.fence); assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, 'replacement-interruption'); assert.equal(events[0].signal, signal);
  assert.deepEqual(events[0].fence, next.fence); await next.stop('interruption');
});

test('pending acquisition interruption synchronously delivers original scope signal and fence before late lease cleanup', async t => {
  const events = [], observed = [], acquired = deferred(), late = deferred(), cleanup = deferred(), cancellation = trackedAbort();
  let s;
  s = standardFixture(t, { onStandardInvalidated(event) {
    events.push(event); observed.push({ attached: cancellation.attached.size, teardown: teardownCalls(s).length });
  } });
  s.controls.acquire = async lease => { acquired.resolve(lease.fence); await late.promise; return lease; };
  s.controls.cleanup = async name => { if (name === 'release') await cleanup.promise; };
  const captured = s.account.capture();
  let settled = false;
  const starting = s.voice.startStandard(captured, 'pending-interruption', cancellation.abort.signal);
  const outcome = starting.then(handle => ({ handle }), error => ({ error })).then(value => { settled = true; return value; });
  try {
    const fence = await acquired.promise;
    assert.equal(cancellation.attached.size, 1);
    s.invalidated(fence);
    assert.equal(events.length, 1);
    assert.deepEqual(observed, [{ attached: 0, teardown: 0 }]);
    assert.equal(events[0].reason, 'interruption'); assert.equal(events[0].sessionId, 'pending-interruption');
    assert.equal(events[0].signal, cancellation.abort.signal);
    assert.deepEqual(events[0].scope.account, captured.account); assert.equal(events[0].scope.isCurrent, captured.isCurrent);
    assert.deepEqual(events[0].fence, fence);
    assert.equal(Object.isFrozen(events[0]), true); assert.equal(Object.isFrozen(events[0].fence), true);
    s.invalidated(fence); assert.equal(events.length, 1);
    await turn(); assert.equal(settled, false); assert.equal(teardownCalls(s).length, 0);
    await assert.rejects(s.voice.startStandard(captured, 'blocked-pending'), { code: 'voice_microphone_busy' });
    late.resolve(); await turn(); assert.equal(settled, false);
    assert.deepEqual(teardownCalls(s).map(call => call[0]), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
    for (const call of teardownCalls(s)) assert.deepEqual(call[1], fence);
    await assert.rejects(s.voice.speech(captured).start('en-US'), { code: 'voice_microphone_busy' });
    cleanup.resolve(); const result = await outcome; assert.ok(result.error); assert.equal(result.handle, undefined);
    assert.equal((await s.voice.stop('interruption')).status, 'released');
    const next = await s.voice.startStandard(captured, 'after-pending-interruption'); next.assertCurrent(); await next.stop('user_stop');
  } finally {
    late.resolve(); cleanup.resolve(); await outcome; await s.voice.stop('user_stop');
  }
});

test('pending replacement acquisition rejects every mismatched full fence and the ended original fence', async t => {
  const events = [], s = standardFixture(t, { onStandardInvalidated: event => events.push(event) });
  const captured = s.account.capture(), old = await s.voice.startStandard(captured, 'ended-original');
  await old.stop('user_stop');
  const acquired = deferred(), late = deferred(), cancellation = trackedAbort();
  s.controls.acquire = async lease => { acquired.resolve(lease.fence); await late.promise; return lease; };
  const starting = s.voice.startStandard(captured, 'pending-replacement', cancellation.abort.signal);
  const outcome = starting.then(handle => ({ handle }), error => ({ error }));
  try {
    const fence = await acquired.promise, before = teardownCalls(s).length;
    for (const stale of [old.fence, ...[
      { accountId: 'different-account' }, { authSessionId: 'different-auth' },
      { accountEpoch: fence.accountEpoch + 1 }, { generation: fence.generation + 1 },
    ].map(patch => ({ ...fence, ...patch }))]) {
      s.invalidated(stale); await turn();
      assert.equal(events.length, 0); assert.equal(teardownCalls(s).length, before);
      assert.equal(cancellation.attached.size, 1); assert.equal(cancellation.abort.signal.aborted, false);
    }
    late.resolve(); const result = await outcome; assert.equal(result.error, undefined); result.handle.assertCurrent();
    await result.handle.stop('user_stop');
  } finally { late.resolve(); await outcome; await s.voice.stop('user_stop'); }
});

test('pending acquisition interruption observer throw preserves incomplete cleanup receipt and exclusive ownership', async t => {
  const events = [], acquired = deferred(), late = deferred(), cancellation = trackedAbort();
  const s = standardFixture(t, { onStandardInvalidated(event) {
    events.push(event); throw new Error('synthetic pending observer failure');
  } });
  s.controls.acquire = async lease => { acquired.resolve(lease.fence); await late.promise; return lease; };
  s.controls.cleanup = async name => { if (name === 'deactivateAudio') throw new Error('synthetic pending restoration failure'); };
  const starting = s.voice.startStandard(s.account.capture(), 'pending-incomplete', cancellation.abort.signal);
  const outcome = starting.then(handle => ({ handle }), error => ({ error }));
  try {
    const fence = await acquired.promise;
    assert.doesNotThrow(() => s.invalidated(fence)); assert.equal(events.length, 1);
    assert.equal(cancellation.attached.size, 0); late.resolve(); assert.ok((await outcome).error);
    const receipt = await s.voice.stop('interruption');
    assert.equal(receipt.status, 'incomplete'); assert.ok(receipt.failedSteps.includes('deactivateAudio'));
    assert.equal(teardownCalls(s).filter(call => call[0] === 'release').length, 1);
    s.account.replace();
    await assert.rejects(s.voice.startStandard(s.account.capture(), 'blocked-incomplete'), { code: 'voice_microphone_busy' });
  } finally { late.resolve(); await outcome; await s.voice.stop('user_stop'); }
});

test('pending acquisition interruption reaches the original Standard consumer synchronously through its captured producer', async t => {
  const { createStandardCoachingProducer } = load('integration/standardCoachingSession.ts');
  const acquired = deferred(), late = deferred(), observations = [], events = [];
  let producer, session, s;
  s = standardFixture(t, { onStandardInvalidated(event) {
    events.push(event); const stopping = producer.stopInvalidated(event);
    observations.push({ admitted: stopping !== null, aborted: event.signal.aborted,
      phase: session.props.consumer.snapshot().phase, teardown: teardownCalls(s).length });
  } });
  s.controls.acquire = async (lease, input) => { acquired.resolve({ fence: lease.fence, signal: input.signal }); await late.promise; return lease; };
  const captured = s.account.capture();
  producer = createStandardCoachingProducer({ resources: { api: {} }, accountId: captured.account.accountId,
    sessionGeneration: captured.account.authSessionId, scope: captured, isCurrentSession: () => true,
    host: s.voice, turn: { run: async () => assert.fail('No turn is admitted during interrupted acquisition.') },
    newSessionId: () => 'original-pending-consumer' });
  session = producer.create(() => {});
  const starting = session.props.consumer.start();
  try {
    const pending = await acquired.promise; assert.equal(session.props.consumer.snapshot().phase, 'acquiring');
    s.invalidated(pending.fence); assert.equal(events.length, 1);
    assert.deepEqual(observations, [{ admitted: true, aborted: true, phase: 'stopping', teardown: 0 }]);
    assert.equal(pending.signal.aborted, true); assert.equal(session.props.consumer.review(), null);
    late.resolve(); await starting;
    assert.equal(s.standardCalls.filter(call => call[0] === 'startCapture').length, 0);
    assert.equal((await s.voice.stop('interruption')).status, 'released');
    assert.equal(teardownCalls(s).filter(call => call[0] === 'release').length, 1);
  } finally { late.resolve(); await starting; await producer.dispose(); await s.voice.stop('user_stop'); }
});
