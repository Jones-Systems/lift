import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserVoiceController, createBrowserStandardVoiceProvider } from '../../public/voice/browser-voice-controller.mjs';
import { BrowserVoiceError } from '../../public/voice/mic-owner.mjs';
import { account, fence, deferred, timers, flush } from './fixtures.mjs';

function fixture(options = {}) {
  const clock = timers(), calls = [], events = [], local = deferred(), server = deferred(), connection = deferred();
  let binding = { account, expiresAtMs: 2000 }, foreground = true, connected, generation = 0;
  const media = {}, mic = { acquire() {}, snapshot: () => ({ status: 'granted' }), streamFor: () => media };
  const session = {
    start(input) { calls.push(['start', input]); return Promise.resolve({ ...input.account, generation: ++generation }); },
    assertCurrent(value) { calls.push(['assert', value]); },
    stop(reason) { calls.push(['stop', reason]); return { local: local.promise, server: server.promise }; },
    ...options.session,
  };
  const provider = { connect(input) { connected = input; calls.push(['connect', input]); return connection.promise; },
    abortPending() {}, closeTransport() {}, requestServerStop: () => Promise.resolve() };
  const inputs = { mic, createSession(ports) { calls.push(['createSession', ports]); return session; },
    readAccount: () => binding, assertAccountCurrent(value) { assert.ok(Number.isSafeInteger(value.generation)); },
    createProvider(input) { calls.push(['createProvider', input]); return provider; },
    isForeground: () => foreground, onEvent: (event, bound) => events.push({ event, bound }),
    ...clock, ...options.inputs };
  const voice = createBrowserVoiceController(inputs);
  return { voice, inputs, mic, calls, events, local, server, connection, clock, provider, media,
    connected: () => connected, binding: value => { binding = value; }, foreground: value => { foreground = value; },
    release: async () => { local.resolve({ status: 'released', failedSteps: [] }); await flush(); } };
}

test('missing injection is unavailable and performs no microphone or provider effect', async () => {
  const voice = createBrowserVoiceController();
  assert.equal(voice.snapshot().status, 'unavailable');
  await assert.rejects(voice.start(), /voice_ports_unavailable/);
});

test('real account identity is required; website appAccountToken cannot substitute for authSessionId', async () => {
  const f = fixture(); f.binding({ account: { accountId: 'a', appAccountToken: 'token', accountEpoch: 1 }, expiresAtMs: 2000 });
  await assert.rejects(f.voice.start(), /voice_account_unavailable/);
  assert.equal(f.calls.filter(([name]) => name === 'createProvider').length, 0);
  assert.equal(f.voice.snapshot().status, 'unavailable');
});

test('portable session receives the sole mic and exact account; provider connects only after its fence', async () => {
  const f = fixture(); const started = f.voice.start('realtime'); await flush();
  assert.equal(f.calls[0][1].mic, f.mic);
  const input = f.calls.find(([name]) => name === 'start')[1];
  assert.deepEqual(input.account, account); assert.equal(input.mode, 'realtime'); assert.equal(input.transport, f.provider);
  assert.equal(f.connected().stream, f.media); assert.deepEqual(f.connected().fence, fence);
  assert.equal(f.voice.snapshot().status, 'connecting');
  f.connection.resolve(); await started; assert.equal(f.voice.snapshot().status, 'active');
  f.connected().emit({ transcript: 'synthetic utterance' }); assert.equal(f.events.length, 1);
  assert.throws(() => f.connected().emit({}, { ...fence, accountEpoch: 9 }), /voice_event_stale/);
  assert.equal(f.events.length, 1); assert.equal(f.voice.snapshot().runtimeQualified, false);
  f.voice.stop(); await f.release();
});

test('cancel while portable acquisition is pending fences late completion before provider connection', async () => {
  const acquisition = deferred(), f = fixture({ session: { start(input) { f.calls.push(['start', input]); return acquisition.promise; } } });
  const pending = f.voice.start(), rejected = assert.rejects(pending, /voice_session_stale/);
  const teardown = f.voice.stop();
  assert.equal(f.calls.find(([name]) => name === 'start')[1].signal.aborted, true);
  assert.equal(f.voice.snapshot().localTeardown, 'pending');
  acquisition.resolve(fence); await rejected;
  assert.equal(f.calls.filter(([name]) => name === 'connect').length, 0);
  assert.equal(f.voice.stop(), teardown); await f.release();
});

for (const [operation, reason] of [['navigation', 'navigation'], ['background', 'background'], ['logout', 'logout'],
  ['accountChanged', 'account_changed'], ['expire', 'aborted']]) {
  test(`${operation} invalidates provider results and delegates ${reason} teardown once`, async () => {
    const f = fixture(), pending = f.voice.start(), rejected = assert.rejects(pending, /voice_session_stale/); await flush();
    const teardown = f.voice[operation]();
    assert.equal(f.connected().signal.aborted, true);
    assert.throws(() => f.connected().emit('obsolete speech'), /voice_session_stale/);
    f.connection.resolve('late provider result'); await rejected; assert.equal(f.events.length, 0);
    assert.deepEqual(f.calls.filter(([name]) => name === 'stop'), [['stop', reason]]);
    await f.release(); assert.deepEqual(await teardown.local, { status: 'released', failedSteps: [] });
    assert.equal(f.voice.snapshot().serverStop, 'pending'); assert.equal(f.clock.scheduled.size, 0);
    f.server.resolve({ status: 'unknown' }); await teardown.server;
    assert.equal(f.voice.snapshot().serverStop, 'unknown');
  });
}

test('account changes without notification are rejected at provider delivery and trigger teardown', async () => {
  const f = fixture(), pending = f.voice.start(); await flush(); f.connection.resolve(); await pending;
  f.binding({ account: { ...account, accountEpoch: 4 }, expiresAtMs: 2000 });
  assert.throws(() => f.connected().emit('late old account speech'), /voice_account_changed/);
  assert.equal(f.events.length, 0); assert.equal(f.voice.snapshot().reason, 'account_changed'); await f.release();
});

test('background and expiry are checked again before applying a provider response', async () => {
  for (const cause of ['background', 'expiry']) {
    const f = fixture(), pending = f.voice.start(); await flush(); f.connection.resolve(); await pending;
    if (cause === 'background') f.foreground(false); else f.clock.set(2000);
    assert.throws(() => f.connected().emit('stale'), cause === 'background' ? /voice_background/ : /voice_session_expired/);
    assert.equal(f.voice.snapshot().reason, cause); assert.equal(f.events.length, 0); await f.release();
  }
});

test('expiry timer stops a pending acquisition without inventing a VoiceFence', async () => {
  const acquisition = deferred(), asserted = [], f = fixture({ session: { start: () => acquisition.promise },
    inputs: { assertAccountCurrent(value) { assert.ok(Number.isInteger(value.generation)); asserted.push(value); } } });
  const pending = f.voice.start(), rejected = assert.rejects(pending, /voice_session_stale/);
  const timer = [...f.clock.scheduled.values()][0];
  timer.callback(); assert.equal(f.voice.snapshot().status, 'requesting'); assert.deepEqual(asserted, []);
  f.clock.set(2000); f.clock.fire(); assert.equal(f.voice.snapshot().reason, 'expiry');
  acquisition.resolve(fence); await rejected; await f.release();
});

test('expired or hidden preflight starts no provider factory or session', async () => {
  for (const cause of ['expiry', 'background']) {
    const f = fixture(); if (cause === 'expiry') f.clock.set(2000); else f.foreground(false);
    await assert.rejects(f.voice.start(), cause === 'expiry' ? /voice_session_expired/ : /voice_background/);
    assert.equal(f.calls.filter(([name]) => ['createProvider', 'start'].includes(name)).length, 0);
  }
});

test('pre-start subscriber cancellation discards an inert provider allocation without connecting', async () => {
  const f = fixture();
  const remove = f.voice.subscribe(value => { if (value.status === 'requesting') f.voice.stop(); });
  await assert.rejects(f.voice.start(), /voice_aborted/); await flush();
  assert.equal(f.calls.filter(([name]) => name === 'createProvider').length, 1);
  assert.equal(f.calls.filter(([name]) => ['start', 'stop', 'connect'].includes(name)).length, 0);
  assert.equal(f.voice.snapshot().localTeardown, 'released'); remove();
});

test('observer failure cannot prevent cleanup; synchronous active cancellation returns the current snapshot', async () => {
  const f = fixture();
  f.voice.subscribe(value => { if (value.status === 'active') { f.voice.stop(); throw new Error('renderer failure'); } });
  const pending = f.voice.start(); await flush(); f.connection.resolve();
  assert.equal((await pending).status, 'stopping'); assert.equal(f.voice.snapshot().observerFailed, true);
  await f.release(); assert.equal(f.voice.snapshot().localTeardown, 'released');
});

test('incomplete local cleanup holds restart even after a server acknowledgement', async () => {
  const f = fixture(), pending = f.voice.start(); await flush(); f.connection.resolve(); await pending;
  const teardown = f.voice.stop(); f.local.resolve({ status: 'incomplete', failedSteps: ['release'] });
  f.server.resolve({ status: 'acknowledged' }); await teardown.local; await teardown.server;
  assert.equal(f.voice.snapshot().localTeardown, 'incomplete');
  await assert.rejects(f.voice.start(), /voice_session_busy/);
});

test('old provider and server completions cannot publish into a newer session', async () => {
  const f = fixture(), first = f.voice.start(); await flush(); f.connection.resolve(); await first;
  const old = f.connected(), stopped = f.voice.stop(); await f.release();
  await f.voice.start(); const current = f.voice.snapshot();
  assert.throws(() => old.emit('old speech'), /voice_session_stale/); assert.equal(f.events.length, 0);
  f.server.resolve({ status: 'acknowledged' }); await stopped.server;
  assert.equal(f.voice.snapshot().status, 'active'); assert.equal(f.voice.snapshot().serverStop, current.serverStop);
  f.voice.stop(); await f.release();
});

test('provider failure is bounded and retires the session without leaking transport messages', async () => {
  const f = fixture(), pending = f.voice.start(), rejected = assert.rejects(pending, error => error.code === 'voice_session_failed');
  await flush(); f.connection.reject(new Error('private provider response')); await rejected; await f.release();
  assert.equal(f.voice.snapshot().status, 'error'); assert.equal(f.voice.snapshot().error, 'voice_session_failed');
});

test('dispose aborts once, removes observers, and prevents further starts', async () => {
  const f = fixture(), pending = f.voice.start(); await flush(); f.connection.resolve(); await pending;
  let notices = 0; f.voice.subscribe(() => notices++);
  const first = f.voice.dispose(), count = notices;
  assert.equal(f.voice.dispose(), first); await f.release(); assert.equal(notices, count);
  assert.equal(f.voice.snapshot().status, 'disposed'); await assert.rejects(f.voice.start(), /voice_disposed/);
});

function standardFixture(options = {}) {
  const abort = new AbortController(), captureResult = deferred(), response = deferred(), speech = deferred(), calls = [];
  const capture = { result: captureResult.promise, finish: () => captureResult.promise, cancel() { calls.push('cancel'); return Promise.resolve(); } };
  const connection = { fence, stream: {}, signal: abort.signal, assertCurrent() { calls.push('assert'); if (abort.signal.aborted) throw new Error('stale'); } };
  const bound = { assertAvailable: () => calls.push('binding'),
    run(input) { calls.push(['run', input]); return response.promise; }, abortPending: () => calls.push('abortPending'),
    closeTransport: () => calls.push('closeTransport'), requestServerStop: () => new Promise(() => {}) };
  const input = { mode: 'standard', account, signal: abort.signal,
    createRecorder() { calls.push('recorder'); return { start() { calls.push('capture'); return capture; }, dispose() {} }; },
    createPlayback() { calls.push('player'); return { play() { calls.push('play'); return speech.promise; }, stop() { calls.push('silence'); return Promise.resolve(); } }; },
    bindTurn(value) { calls.push(['bind', value.account]); return bound; },
    assertDisclosureCurrent(value) { calls.push(['disclosure', value]); },
    requestSessionStop(reason) { calls.push(['sessionStop', reason]); abort.abort(reason); }, ...options };
  const provider = createBrowserStandardVoiceProvider(input);
  return { provider, input, bound, connection, calls, abort, captureResult, response, speech };
}

test('standard provider preflight uses the original account and allocates no capture, playback or transport effect', async () => {
  const f = standardFixture();
  assert.equal(f.calls.find(value => value[0] === 'bind')[1], account);
  assert.ok(f.calls.filter(value => value[0] === 'disclosure').every(value => value[1] === account));
  assert.equal(f.provider.snapshot().phase, 'idle');
  assert.ok(!f.calls.some(value => ['recorder', 'player', 'capture', 'play', 'abortPending', 'closeTransport'].includes(value)));
  await assert.rejects(f.provider.finishRecording(), /voice_recording_not_started/);
  assert.equal(f.provider.snapshot().turnPending, false);
});

test('standard provider rejects mismatched connection identity before any media allocation', async () => {
  const f = standardFixture();
  for (const changed of [{ signal: new AbortController().signal }, { fence: { ...fence, accountEpoch: 100 } },
    { fence: { ...fence, generation: 0 } }, { assertCurrent: undefined }]) {
    assert.throws(() => f.provider.connect({ ...f.connection, ...changed }), /voice_provider_unavailable/);
  }
  assert.ok(!f.calls.includes('recorder')); assert.ok(!f.calls.includes('player'));
  await Promise.all([f.provider.abortPending('aborted'), f.provider.closeTransport('aborted')]);
  assert.equal(f.provider.snapshot().localCleanup, 'released');
});

test('standard provider finish reentry shares one operation and forwards the original fence assertion', async () => {
  let reentered;
  const f = standardFixture({ onState(value) { if (value.phase === 'finishing') reentered = f.provider.finishRecording(); } });
  f.provider.connect(f.connection); const completed = f.provider.finishRecording(); assert.equal(reentered, completed);
  f.captureResult.resolve({ audio: new Blob(['synthetic'], { type: 'audio/webm' }), format: 'webm' }); await flush();
  const runs = f.calls.filter(value => value[0] === 'run'); assert.equal(runs.length, 1);
  assert.equal(runs[0][1].assertCurrent, f.connection.assertCurrent); assert.equal(runs[0][1].fence, f.connection.fence);
  assert.equal(runs[0][1].signal, f.connection.signal); assert.equal(f.provider.finishRecording(), completed);
  f.response.resolve({ outcome: { kind: 'succeeded', value: {} }, accounting: 'settled' }); await flush();
  f.speech.resolve(); assert.equal(await completed, undefined); assert.equal(f.provider.snapshot().phase, 'complete');
  f.abort.abort(); await Promise.all([f.provider.abortPending('aborted'), f.provider.closeTransport('aborted')]);
  assert.equal(f.provider.snapshot().localCleanup, 'released'); assert.equal(f.calls.filter(value => value[0] === 'run').length, 1);
});

test('standard provider malformed results are bounded, clear review and request the original session stop', async () => {
  for (const result of [null, { outcome: { kind: 'succeeded', value: {} }, accounting: 'invented' },
    { outcome: { kind: 'unknown' }, accounting: 'unknown' },
    { outcome: { kind: 'succeeded', value: {} }, accounting: 'settled', review: { transcript: {} } },
    { outcome: { kind: 'succeeded', value: {} }, accounting: 'unresolved', review: { transcript: 'known', reply: 7 } },
    ...[null, {}, { transcript: 7 }, { transcript: 'known', reply: null }].map(review =>
      ({ outcome: { kind: 'rejected', reason: 'synthetic failure' }, accounting: 'unknown', review }))]) {
    const f = standardFixture(); f.provider.connect(f.connection);
    const completed = f.provider.finishRecording(), rejected = assert.rejects(completed, /voice_turn_result_invalid/);
    f.captureResult.resolve({ audio: new Blob(['synthetic']), format: 'webm' }); await flush(); f.response.resolve(result); await rejected;
    assert.equal(f.calls.includes('play'), false); assert.equal(f.provider.snapshot().review, null);
    assert.equal(f.provider.snapshot().manualFallback, true); assert.equal(f.abort.signal.aborted, true);
    assert.equal(f.calls.filter(value => value[0] === 'sessionStop').length, 1);
    await Promise.all([f.provider.abortPending('failed'), f.provider.closeTransport('failed')]);
  }
});

test('standard provider terminal review reentry retains one operation and copies only supplied text', async () => {
  let reentered;
  const f = standardFixture({ onState(value) { if (value.phase === 'review') reentered = f.provider.finishRecording(); } });
  f.provider.connect(f.connection); const completed = f.provider.finishRecording();
  f.captureResult.resolve({ audio: new Blob(['synthetic']), format: 'webm' }); await flush();
  const review = { transcript: 'known transcript' };
  f.response.resolve({ outcome: { kind: 'unknown', reason: 'private reason' }, accounting: 'unknown', review });
  assert.equal(await completed, undefined); assert.equal(reentered, completed); review.transcript = 'changed';
  assert.deepEqual(f.provider.snapshot().review, { transcript: 'known transcript' });
  assert.equal(f.provider.snapshot().error, 'voice_turn_unknown'); assert.equal(f.provider.snapshot().phase, 'review');
  assert.equal(f.provider.snapshot().localCleanup, 'none'); assert.equal(f.abort.signal.aborted, false);
  assert.equal(f.calls.includes('play'), false); assert.equal(f.calls.filter(value => value[0] === 'run').length, 1);
  f.abort.abort(); assert.equal(f.provider.snapshot().review, null); assert.equal(f.provider.snapshot().phase, 'stopped');
  await Promise.all([f.provider.abortPending('aborted'), f.provider.closeTransport('aborted')]);
});

test('standard provider nonplayable terminal results without review still stop instead of manufacturing text', async () => {
  for (const result of [{ outcome: { kind: 'rejected', reason: 'synthetic failure' }, accounting: 'unknown' },
    { outcome: { kind: 'succeeded', value: {} }, accounting: 'unresolved' }]) {
    const f = standardFixture(); f.provider.connect(f.connection);
    const completed = f.provider.finishRecording(), rejected = assert.rejects(completed, /voice_turn_/);
    f.captureResult.resolve({ audio: new Blob(['synthetic']), format: 'webm' }); await flush();
    f.response.resolve(result); await rejected;
    assert.equal(f.provider.snapshot().review, null); assert.equal(f.abort.signal.aborted, true);
    assert.equal(f.calls.includes('play'), false);
    await Promise.all([f.provider.abortPending('failed'), f.provider.closeTransport('failed')]);
  }
});

for (const cleanupOutcome of ['released', 'incomplete', 'stale', 'disclosure']) {
  test(`standard provider waits for playback cleanup before review: ${cleanupOutcome}`, async () => {
    const cleanup = deferred(), speech = deferred(), notices = []; let current = true, disclosed = true, finished = false;
    const f = standardFixture({
      createPlayback: () => ({ play: () => speech.promise, stop(value) { assert.equal(value, fence); return cleanup.promise; } }),
      assertDisclosureCurrent() { if (!disclosed) throw new Error('synthetic disclosure revoked'); },
      onState: value => notices.push(value),
    });
    f.connection.assertCurrent = () => { if (!current) throw new BrowserVoiceError('voice_session_stale'); };
    f.provider.connect(f.connection); const completed = f.provider.finishRecording();
    void completed.then(() => { finished = true; }, () => { finished = true; });
    const rejected = cleanupOutcome === 'released' ? null : assert.rejects(completed);
    f.captureResult.resolve({ audio: new Blob(['synthetic']), format: 'webm' }); await flush();
    f.response.resolve({ outcome: { kind: 'succeeded', value: {} }, accounting: 'settled', review: { transcript: 'known' } }); await flush();
    speech.reject(new BrowserVoiceError('voice_playback_blocked')); await flush();
    assert.equal(finished, false); assert.equal(f.provider.snapshot().review, null); assert.equal(f.abort.signal.aborted, false);
    assert.equal(notices.at(-1).review, null);
    if (cleanupOutcome === 'stale') current = false;
    if (cleanupOutcome === 'disclosure') disclosed = false;
    if (cleanupOutcome === 'incomplete') cleanup.reject(new BrowserVoiceError('voice_playback_cleanup_incomplete'));
    else cleanup.resolve();
    if (rejected) {
      await rejected; assert.equal(f.provider.snapshot().review, null); assert.equal(f.abort.signal.aborted, true);
    } else {
      await completed; assert.equal(f.provider.snapshot().phase, 'review');
      assert.equal(f.provider.snapshot().error, 'voice_playback_blocked');
      assert.deepEqual(f.provider.snapshot().review, { transcript: 'known' });
      assert.equal(f.provider.snapshot().accounting, 'settled'); f.abort.abort();
    }
    const results = await Promise.allSettled([f.provider.abortPending('aborted'), f.provider.closeTransport('aborted')]);
    assert.ok(results.every(value => value.status === (cleanupOutcome === 'incomplete' ? 'rejected' : 'fulfilled')));
    assert.equal(f.provider.snapshot().localCleanup, cleanupOutcome === 'incomplete' ? 'incomplete' : 'released');
  });
}

test('standard provider unexpected player failures do not qualify retained review', async () => {
  const f = standardFixture(); f.provider.connect(f.connection);
  const completed = f.provider.finishRecording(), rejected = assert.rejects(completed, /voice_session_failed/);
  f.captureResult.resolve({ audio: new Blob(['synthetic']), format: 'webm' }); await flush();
  f.response.resolve({ outcome: { kind: 'succeeded', value: {} }, accounting: 'settled', review: { transcript: 'known' } }); await flush();
  f.speech.reject(new Error('unexpected player failure')); await rejected;
  assert.equal(f.provider.snapshot().review, null); assert.equal(f.abort.signal.aborted, true);
  await Promise.all([f.provider.abortPending('failed'), f.provider.closeTransport('failed')]);
});

test('standard provider observer failure cannot interrupt owned cleanup', async () => {
  const f = standardFixture({ onState() { throw new Error('synthetic renderer failure'); } });
  f.provider.connect(f.connection); assert.equal(f.provider.snapshot().observerFailed, true);
  f.abort.abort(); await Promise.all([f.provider.abortPending('aborted'), f.provider.closeTransport('aborted')]);
  assert.equal(f.provider.snapshot().localCleanup, 'released'); assert.equal(f.calls.filter(value => value === 'cancel').length, 1);
  assert.equal(f.calls.filter(value => value === 'silence').length, 1);
});
