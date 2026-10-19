import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getEventListeners } from 'node:events';
import { createBrowserMicOwner } from '../../public/voice/mic-owner.mjs';
import { createBrowserVoiceController, createBrowserStandardVoiceProvider } from '../../public/voice/browser-voice-controller.mjs';
import { createBrowserRecorder, createBrowserSpeechPlayback } from '../../public/voice/browser-audio.mjs';
import { account, deferred, track, stream, timers, flush, Target, wav } from './fixtures.mjs';

// Test-only native type stripping consumes the real WS08 source; browser production imports stay .mjs.
const supplied = process.env.FORM_BROWSER_VOICE_SESSION_MODULE;
const moduleURL = supplied ? pathToFileURL(supplied) : new URL('../../../form/src/voice-coaching/session-controller.ts', import.meta.url);
const available = existsSync(moduleURL);
if (supplied && !available) throw new Error('explicit_portable_session_source_missing');
const portable = available ? await import(moduleURL.href) : null;
if (available) console.log(`portable-session-source ${moduleURL.href} sha256=${createHash('sha256').update(readFileSync(moduleURL)).digest('hex')}`);
const integration = (name, run) => test(name, { skip: available ? false : 'WS08 source not composed; set FORM_BROWSER_VOICE_SESSION_MODULE to its verified session-controller.ts (Node 24)' }, run);

function fixture({ stopPlayback = () => {}, createProvider } = {}) {
  const captures = [], tracks = [], connections = [], events = [], calls = [], clock = timers(), server = deferred();
  let binding = { account, expiresAtMs: 2000 }, foreground = true, session;
  const mic = createBrowserMicOwner({ secureContext: true, mediaDevices: { getUserMedia() { const capture = deferred(); captures.push(capture); return capture.promise; } },
    stopPlayback: (fence, reason) => { calls.push('playback'); return stopPlayback(fence, reason); }, deactivateAudio: () => calls.push('audio') });
  const voice = createBrowserVoiceController({ mic,
    createSession: ({ mic: driver, assertAccountCurrent }) => {
      session = new portable.VoiceSessionController(new portable.ExclusiveMicOwner(driver), assertAccountCurrent);
      return session;
    },
    readAccount: () => binding, assertAccountCurrent: fence => {
      assert.ok(Number.isSafeInteger(fence.generation));
      if (fence.authSessionId !== binding.account.authSessionId || fence.accountEpoch !== binding.account.accountEpoch) throw new Error('stale_account');
    }, isForeground: () => foreground, onEvent: event => events.push(event), ...clock,
    createProvider: createProvider ?? (() => ({
      connect(input) { const connection = deferred(); connections.push({ ...input, ...connection }); return connection.promise; },
      abortPending: () => calls.push('abortPending'), closeTransport: () => calls.push('closeTransport'),
      requestServerStop() { calls.push('serverStop'); return server.promise; },
    })) });
  return { voice, mic, session, captures, tracks, connections, events, calls, clock, server,
    grant() { const audio = track(); tracks.push(audio); captures.at(-1).resolve(stream(audio)); return audio; },
    changeAccount() { binding = { account: { ...account, authSessionId: 'replacement-session', accountEpoch: 4 }, expiresAtMs: 2000 }; },
    hide: () => { foreground = false; } };
}

integration('actual WS08 cancel waits for the same late lease, releases tracks, and never connects', async () => {
  const f = fixture(), start = f.voice.start(), rejected = assert.rejects(start);
  await flush(); assert.equal(f.captures.length, 1);
  const stop = f.voice.stop(); let released = false; void stop.local.then(() => { released = true; });
  await flush(); assert.equal(released, false); assert.equal(f.mic.snapshot().pendingPermission, true);
  assert.ok(f.calls.includes('closeTransport')); assert.ok(f.calls.includes('serverStop'));
  const audio = f.grant(); await rejected;
  assert.deepEqual(await stop.local, { status: 'released', failedSteps: [] });
  assert.equal(audio.readyState, 'ended'); assert.equal(audio.stops, 1); assert.equal(f.connections.length, 0);
  assert.equal(f.voice.snapshot().serverStop, 'pending');
  const restart = f.voice.start(); await flush(); f.grant(); await flush();
  f.connections.at(-1).resolve(); await restart;
  const next = f.voice.stop(); await next.local;
  assert.ok(f.tracks.every(item => item.readyState === 'ended'));
});

for (const boundary of ['navigation', 'background', 'accountChanged', 'logout', 'expiry']) {
  integration(`actual WS08 ${boundary} stops capture and rejects delayed speech/results`, async () => {
    const f = fixture(), start = f.voice.start(), rejected = assert.rejects(start);
    await flush(); const audio = f.grant(); await flush(); const connection = f.connections[0];
    assert.ok(connection); assert.equal(audio.readyState, 'live');
    if (boundary === 'background') f.hide();
    if (boundary === 'accountChanged') f.changeAccount();
    if (boundary === 'expiry') { f.clock.set(2000); f.clock.fire(); }
    else f.voice[boundary]();
    assert.equal(audio.readyState, 'ended'); assert.equal(connection.signal.aborted, true);
    assert.throws(() => connection.emit('stale speech')); connection.resolve(); await rejected;
    const teardown = f.voice.stop(); assert.equal((await teardown.local).status, 'released');
    assert.deepEqual(f.events, []); assert.equal(f.voice.snapshot().serverStop, 'pending');
    assert.equal(f.calls.filter(value => value === 'playback').length, 1);
    assert.equal(f.calls.filter(value => value === 'audio').length, 1);
  });
}

integration('actual WS08 permission rejection retains incomplete acquisition hold without automatic retry', async () => {
  const f = fixture(), start = f.voice.start(), rejected = assert.rejects(start, /voice_permission_denied/);
  await flush(); f.captures[0].reject(Object.assign(new Error('private permission message'), { name: 'NotAllowedError' }));
  await rejected; const teardown = f.voice.stop();
  assert.deepEqual(await teardown.local, { status: 'incomplete', failedSteps: ['acquire'] });
  await assert.rejects(f.voice.start(), /voice_session_busy/); assert.equal(f.captures.length, 1);
  assert.equal(f.connections.length, 0); assert.equal(f.voice.snapshot().error, 'voice_permission_denied');
});


function joinedFixture({ providerOptions = {}, closeGate, stopThrows = false, pauseThrows = false } = {}) {
  const players = new Map(), providers = [], recorders = [], handles = [], elements = [], objects = new Map(), revoked = [], turns = [], states = [];
  const remote = { serverSettled: false };
  let sequence = 0, disclosed = true, bound = true;
  class Recorder extends Target {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(source, { mimeType }) {
      super(); this.stream = source; this.mimeType = mimeType; this.state = 'inactive'; this.stops = 0; recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() { this.stops++; if (stopThrows) throw new Error('synthetic recorder stop failed'); this.state = 'inactive'; }
    end() { this.emit('dataavailable', { data: new Blob(['final'], { type: this.mimeType }) }); this.emit('stop'); }
  }
  class Audio extends Target {
    constructor() { super(); this.gate = deferred(); this.src = null; this.playing = false; this.plays = 0; elements.push(this); }
    play() { this.plays++; this.playing = true; return this.gate.promise; }
    pause() { if (pauseThrows) throw new Error('synthetic pause failed'); this.playing = false; }
    removeAttribute(name) { assert.equal(name, 'src'); this.src = null; }
    load() {}
  }
  const url = { createObjectURL(blob) { const key = `blob:joined-${++sequence}`; objects.set(key, blob); return key; },
    revokeObjectURL(key) { revoked.push(key); objects.delete(key); } };
  const f = fixture({ stopPlayback: fence => players.get(fence.generation)?.stop(fence),
    createProvider(input) {
      const provider = createBrowserStandardVoiceProvider({ ...input,
        createRecorder() {
          const recorder = createBrowserRecorder({ mimeType: 'audio/webm;codecs=opus', format: 'webm',
            maxAudioBytes: 1024, maxDurationMs: 500, stopTimeoutMs: 50, MediaRecorderImpl: Recorder, ...f.clock });
          return { ...recorder, start(connection) { const handle = recorder.start(connection); handles.push(handle); return handle; } };
        },
        createPlayback() {
          const player = createBrowserSpeechPlayback({ maxSpeechBytes: 1024, maxDurationMs: 500,
            createAudio: () => new Audio(), url, ...f.clock });
          players.set(f.connections.at(-1).fence.generation, player); return player;
        },
        bindTurn({ account: original }) {
          assert.equal(original, input.account); assert.ok(Object.isFrozen(original));
          return {
            assertAvailable() { if (!bound) throw new Error('independent session binding missing'); },
            run(value) {
              const response = deferred(); turns.push({ input: value, ...response }); return response.promise;
            },
            abortPending(reason) { f.calls.push(['turnAbort', provider, reason]); },
            closeTransport(reason) { f.calls.push(['turnClose', provider, reason]); return closeGate?.promise; },
            requestServerStop(reason) { f.calls.push(['turnServer', provider, reason]); return f.server.promise; },
          };
        },
        assertDisclosureCurrent(original) { assert.equal(original, input.account); if (!disclosed) throw new Error('disclosure missing'); },
        requestSessionStop: reason => f.voice.stop(reason), onState: value => states.push(value), ...providerOptions });
      providers.push(provider);
      return { ...provider, connect(connection) { f.connections.push(connection); return provider.connect(connection); } };
    } });
  void f.server.promise.then(() => { remote.serverSettled = true; });
  return { ...f, providers, recorders, handles, elements, objects, revoked, turns, states, remote,
    revokeDisclosure: () => { disclosed = false; }, revokeBinding: () => { bound = false; },
    async open() {
      const started = f.voice.start('standard'); await flush(); const source = f.grant(); await started;
      const connection = f.connections.at(-1), capture = handles.at(-1), recorder = recorders.at(-1), provider = providers.at(-1);
      assert.equal(recorder.stream, f.mic.streamFor(connection.fence)); assert.equal(connection.stream.getTracks()[0], source);
      return { ...connection, source, capture, recorder, provider, player: players.get(connection.fence.generation) };
    },
    finishCapture(connection) {
      connection.recorder.emit('dataavailable', { data: new Blob(['first'], { type: 'audio/webm' }) });
      const finished = connection.provider.finishRecording(); connection.recorder.end(); return finished;
    },
    boundary(name) {
      if (name === 'accountChanged') f.changeAccount();
      if (name === 'background') f.hide();
      if (name === 'expiry') { f.clock.set(2000); f.clock.fire(); return f.voice.stop(); }
      return name === 'cancel' ? f.voice.stop() : f.voice[name]();
    },
    assertReleased() {
      assert.equal(f.clock.scheduled.size, 0); assert.equal(objects.size, 0);
      assert.ok(recorders.every(value => value.count() === 0));
      assert.ok(elements.every(value => value.count() === 0 && value.src === null && !value.playing));
      assert.ok(f.tracks.every(value => value.readyState === 'ended' && value.stops === 1));
      assert.ok(f.connections.every(value => getEventListeners(value.signal, 'abort').length === 0));
      assert.equal(f.voice.snapshot().serverStop, 'pending'); assert.equal(remote.serverSettled, false);
      assert.ok(providers.every(value => value.snapshot().localCleanup === 'released' && value.snapshot().review === null));
    } };
}

const settledSpeech = (review = { transcript: 'synthetic transcript', reply: 'synthetic reply' }) =>
  ({ outcome: { kind: 'succeeded', value: wav() }, accounting: 'settled', review });

integration('production standard provider preserves the actual leased fence through one capture, settled turn and WAV playback', async () => {
  const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection);
  assert.equal(connection.provider.finishRecording(), completed); await flush(); const turn = f.turns[0];
  assert.equal(f.captures.length, 1); assert.equal(f.turns.length, 1); assert.ok(turn.input.audio instanceof Blob);
  assert.equal(await turn.input.audio.text(), 'firstfinal'); assert.equal(turn.input.format, 'webm');
  assert.equal(turn.input.signal, connection.signal); assert.equal(turn.input.assertCurrent, connection.assertCurrent);
  assert.equal(turn.input.fence, connection.fence); assert.equal(connection.source.stops, 0);
  connection.assertCurrent(); f.session.assertCurrent(connection.fence);
  assert.equal(connection.capture.snapshot().cleanup, 'released'); assert.equal(connection.recorder.count(), 0);
  const result = settledSpeech(); turn.resolve(result); await flush(); const audio = f.elements[0];
  assert.equal(audio.playing, true); assert.equal(audio.plays, 1); assert.equal(f.objects.size, 1);
  assert.equal([...f.objects.values()][0].type, 'audio/wav');
  result.review.transcript = 'mutated transport object';
  assert.deepEqual(connection.provider.snapshot().review, { transcript: 'synthetic transcript', reply: 'synthetic reply' });
  assert.ok(Object.isFrozen(connection.provider.snapshot().review));
  audio.gate.resolve(); await flush(); assert.equal(connection.provider.snapshot().phase, 'playing');
  assert.equal(connection.source.readyState, 'live'); connection.assertCurrent(); f.session.assertCurrent(connection.fence);
  audio.emit('ended'); assert.equal(await completed, undefined); assert.equal(connection.provider.snapshot().phase, 'complete');
  assert.equal(connection.provider.finishRecording(), completed); assert.equal(f.turns.length, 1);
  const stop = f.voice.stop(); assert.equal(connection.provider.snapshot().review, null); assert.equal(connection.source.readyState, 'ended');
  assert.deepEqual(await stop.local, { status: 'released', failedSteps: [] }); f.assertReleased(); assert.equal(f.revoked.length, 1);
});

for (const phase of ['response', 'play-promise']) {
  for (const boundary of ['cancel', 'accountChanged', 'navigation', 'background', 'expiry']) {
    integration(`production standard provider ${boundary} during ${phase} clears review and stops locally before remote completion`, async () => {
      const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection);
      const rejected = assert.rejects(completed, phase === 'response' ? /voice_session_stale/ : /voice_audio_aborted/);
      await flush(); const turn = f.turns[0];
      if (phase === 'play-promise') { turn.resolve(settledSpeech()); await flush(); }
      const audio = f.elements[0], queuedEnded = audio ? [...audio.listeners.get('ended')][0] : null;
      if (audio) { assert.equal(audio.playing, true); assert.ok(connection.provider.snapshot().review); }
      const stop = f.boundary(boundary);
      assert.equal(connection.source.readyState, 'ended'); assert.equal(connection.signal.aborted, true);
      assert.equal(connection.provider.snapshot().review, null);
      assert.throws(() => connection.assertCurrent()); assert.throws(() => f.session.assertCurrent(connection.fence), /voice_session_stale/);
      assert.equal(f.objects.size, 0); assert.equal(f.clock.scheduled.size, 0);
      if (audio) { assert.equal(audio.playing, false); assert.equal(audio.src, null); assert.equal(audio.count(), 0); }
      assert.deepEqual(await stop.local, { status: 'released', failedSteps: [] }); f.assertReleased();
      assert.equal(connection.provider.snapshot().turnPending, phase === 'response');
      assert.equal(f.calls.filter(value => value[0] === 'turnAbort' && value[1] === connection.provider).length, 1);
      assert.equal(f.calls.filter(value => value[0] === 'turnClose' && value[1] === connection.provider).length, 1);
      assert.equal(f.calls.filter(value => value[0] === 'turnServer' && value[1] === connection.provider).length, 1);
      turn.resolve(settledSpeech()); if (audio) { audio.gate.resolve(); queuedEnded(); }
      await rejected; await flush(); f.assertReleased();
      assert.equal(connection.provider.snapshot().turnPending, false); assert.equal(f.turns.length, 1);
      assert.equal(f.elements.length, phase === 'response' ? 0 : 1); assert.deepEqual(f.events, []);
      if (audio) assert.equal(audio.plays, 1);
    });
  }
}

for (const phase of ['response', 'play-promise']) {
  integration(`production standard provider rejects old ${phase} after same-account actual portable generation restart`, async () => {
    const f = joinedFixture(), old = await f.open(), oldRun = f.finishCapture(old);
    const oldRejected = assert.rejects(oldRun, phase === 'response' ? /voice_session_stale/ : /voice_audio_aborted/); await flush(); const oldTurn = f.turns[0];
    if (phase === 'play-promise') { oldTurn.resolve(settledSpeech()); await flush(); }
    const oldAudio = f.elements[0], oldEnded = oldAudio ? [...oldAudio.listeners.get('ended')][0] : null;
    assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] }); f.assertReleased();
    const current = await f.open();
    assert.deepEqual({ ...old.fence, generation: current.fence.generation }, current.fence); assert.ok(current.fence.generation > old.fence.generation);
    assert.throws(() => f.session.assertCurrent(old.fence), /voice_session_stale/); assert.throws(() => old.assertCurrent());
    assert.throws(() => old.emit('stale speech')); assert.throws(() => f.mic.streamFor(old.fence));
    const currentRun = f.finishCapture(current); await flush(); f.turns[1].resolve(settledSpeech()); await flush();
    const currentAudio = f.elements.at(-1), currentURL = currentAudio.src;
    oldTurn.resolve(settledSpeech()); if (oldAudio) { oldAudio.gate.resolve(); oldEnded(); }
    await oldRejected; await flush();
    assert.equal(old.provider.snapshot().review, null); assert.ok(current.provider.snapshot().review);
    assert.equal(currentAudio.playing, true); assert.equal(currentAudio.src, currentURL); assert.equal(f.objects.size, 1);
    assert.equal(current.source.readyState, 'live'); assert.equal(current.source.stops, 0);
    assert.equal(f.elements.length, phase === 'response' ? 1 : 2); current.assertCurrent(); f.session.assertCurrent(current.fence);
    currentAudio.gate.resolve(); await flush(); currentAudio.emit('ended'); await currentRun;
    assert.equal(current.provider.snapshot().phase, 'complete');
    assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] }); f.assertReleased();
    assert.equal(f.turns.length, 2); assert.equal(f.captures.length, 2);
  });
}

for (const [name, providerOptions] of [
  ['binder absent', { bindTurn: undefined }], ['unbound session', { bindTurn: () => null }],
  ['disclosure absent', { assertDisclosureCurrent: undefined }], ['disclosure denied', { assertDisclosureCurrent() { throw new Error('private disclosure detail'); } }],
  ['asynchronous binding', { bindTurn: () => Promise.reject(new Error('unproved asynchronous binding')) }],
  ['asynchronous disclosure', { assertDisclosureCurrent: () => Promise.reject(new Error('unproved asynchronous disclosure')) }],
  ['stop delegation absent', { requestSessionStop: undefined }], ['recorder absent', { createRecorder: undefined }],
]) {
  integration(`production standard provider ${name} stays unavailable before actual microphone acquisition`, async () => {
    const f = joinedFixture({ providerOptions }); await assert.rejects(f.voice.start(), /voice_provider_unavailable/);
    assert.equal(f.captures.length, 0); assert.equal(f.recorders.length, 0); assert.equal(f.turns.length, 0);
    assert.equal(f.elements.length, 0); assert.equal(f.voice.snapshot().error, 'voice_provider_unavailable');
  });
}

const reviewResults = [
  ...['not_reserved', 'replay', 'released', 'not_consumed', 'unknown', 'unresolved'].map(accounting => ({ ...settledSpeech(), accounting })),
  ...['not_dispatched', 'rejected', 'unknown'].map(kind => ({ outcome: { kind, reason: 'synthetic reason' }, accounting: 'settled', review: settledSpeech().review })),
  { outcome: { kind: 'rejected', reason: 'synthetic synthesis failure' }, accounting: 'unknown', review: settledSpeech().review },
  { outcome: { kind: 'unknown', reason: 'synthetic unresolved turn' }, accounting: 'unresolved', review: settledSpeech().review },
];
for (const result of reviewResults) {
  integration(`production standard provider retains known review without playback for ${result.outcome.kind}+${result.accounting}`, async () => {
    const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection);
    await flush(); f.turns[0].resolve(result); assert.equal(await completed, undefined);
    const state = connection.provider.snapshot();
    assert.equal(state.outcome, result.outcome.kind); assert.equal(state.accounting, result.accounting);
    assert.equal(state.phase, 'review'); assert.equal(state.turnPending, false); assert.equal(state.localCleanup, 'none');
    assert.equal(state.error, result.outcome.kind === 'succeeded' ? 'voice_turn_unsettled' : `voice_turn_${result.outcome.kind}`);
    assert.deepEqual(state.review, settledSpeech().review); assert.equal(state.manualFallback, true); assert.equal(f.elements.length, 0);
    result.review.transcript = 'mutated after terminal delivery';
    assert.deepEqual(connection.provider.snapshot().review, settledSpeech().review); assert.ok(Object.isFrozen(state.review));
    assert.equal(connection.capture.snapshot().cleanup, 'released'); assert.equal(connection.recorder.count(), 0);
    assert.equal(connection.source.readyState, 'live'); assert.equal(connection.source.stops, 0);
    connection.assertCurrent(); f.session.assertCurrent(connection.fence); assert.equal(f.voice.snapshot().status, 'active');
    await assert.rejects(f.voice.start(), /voice_session_busy/); assert.equal(f.captures.length, 1); assert.equal(f.recorders.length, 1);
    assert.equal(connection.provider.finishRecording(), completed); assert.equal(f.turns.length, 1);
    const stop = f.voice.stop(); assert.equal(connection.provider.snapshot().review, null); assert.equal(connection.provider.snapshot().phase, 'stopped');
    assert.deepEqual(await stop.local, { status: 'released', failedSteps: [] }); f.assertReleased();
  });
}

const failedReview = () => ({ outcome: { kind: 'rejected', reason: 'synthetic synthesis failure' },
  accounting: 'unknown', review: { transcript: 'known transcript', reply: 'known reply' } });

for (const boundary of ['cancel', 'accountChanged', 'navigation', 'background', 'expiry', 'dispose']) {
  integration(`production terminal review clears synchronously on ${boundary} before server acknowledgement`, async () => {
    const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection);
    await flush(); f.turns[0].resolve(failedReview()); await completed;
    assert.deepEqual(connection.provider.snapshot().review, failedReview().review);
    const stop = f.boundary(boundary); assert.equal(connection.provider.snapshot().review, null);
    assert.equal(connection.source.readyState, 'ended'); assert.equal(connection.signal.aborted, true);
    assert.throws(() => connection.assertCurrent()); assert.throws(() => f.session.assertCurrent(connection.fence), /voice_session_stale/);
    assert.deepEqual(await stop.local, { status: 'released', failedSteps: [] }); f.assertReleased();
    assert.equal(connection.provider.finishRecording(), completed); await completed;
    assert.equal(connection.provider.snapshot().review, null); assert.equal(f.elements.length, 0); assert.equal(f.turns.length, 1);
  });
}

for (const guard of ['revokeDisclosure', 'revokeBinding', 'changeAccount']) {
  integration(`production terminal review observation enforces the original ${guard} guard`, async () => {
    const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection);
    await flush(); f.turns[0].resolve(failedReview()); await completed;
    f[guard](); assert.equal(connection.provider.snapshot().review, null); assert.equal(connection.source.readyState, 'ended');
    assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] }); f.assertReleased();
    assert.equal(f.elements.length, 0); assert.equal(f.turns.length, 1);
  });
}

integration('production terminal review remains cleared across a same-account portable generation restart', async () => {
  const f = joinedFixture(), old = await f.open(), oldRun = f.finishCapture(old);
  await flush(); f.turns[0].resolve(failedReview()); await oldRun;
  assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] }); f.assertReleased();
  const current = await f.open(), currentRun = f.finishCapture(current); await flush();
  assert.deepEqual({ ...old.fence, generation: current.fence.generation }, current.fence);
  assert.ok(current.fence.generation > old.fence.generation);
  const result = failedReview(); result.review.transcript = 'new generation transcript'; f.turns[1].resolve(result); await currentRun;
  assert.equal(old.provider.finishRecording(), oldRun); await oldRun;
  assert.throws(() => f.session.assertCurrent(old.fence), /voice_session_stale/); assert.throws(() => old.assertCurrent());
  assert.equal(old.provider.snapshot().review, null); assert.equal(current.provider.snapshot().review.transcript, 'new generation transcript');
  current.assertCurrent(); f.session.assertCurrent(current.fence); assert.equal(current.source.readyState, 'live');
  assert.equal(f.captures.length, 2); assert.equal(f.turns.length, 2); assert.equal(f.elements.length, 0);
  assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] }); f.assertReleased();
});

integration('production terminal failure without review releases the actual session', async () => {
  const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection), rejected = assert.rejects(completed, /voice_turn_rejected/);
  const result = failedReview(); delete result.review;
  await flush(); f.turns[0].resolve(result); await rejected;
  assert.equal(connection.provider.snapshot().review, null); assert.equal(connection.source.readyState, 'ended');
  assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] }); f.assertReleased();
  assert.equal(f.elements.length, 0); assert.equal(f.turns.length, 1);
});

integration('production standard provider keeps pending transport cleanup and unknown accounting after run rejection', async () => {
  const closeGate = deferred(), f = joinedFixture({ closeGate }), connection = await f.open(), completed = f.finishCapture(connection);
  const rejected = assert.rejects(completed, /voice_session_failed/); await flush(); f.turns[0].reject(new Error('private remote failure'));
  await rejected; const stop = f.voice.stop(); let localReleased = false; void stop.local.then(() => { localReleased = true; }); await flush();
  assert.equal(connection.source.readyState, 'ended'); assert.equal(localReleased, false);
  const state = connection.provider.snapshot(); assert.equal(state.outcome, 'unknown'); assert.equal(state.accounting, 'unresolved');
  assert.equal(state.localCleanup, 'pending'); assert.equal(state.manualFallback, true); assert.equal(state.review, null);
  assert.equal(f.voice.snapshot().serverStop, 'pending'); assert.equal(f.turns.length, 1);
  closeGate.resolve(); assert.deepEqual(await stop.local, { status: 'released', failedSteps: [] }); f.assertReleased();
});

for (const missingTerminal of [false, true]) {
  integration(`production standard provider ${missingTerminal ? 'missing recorder terminal' : 'recorder stop failure'} holds actual session cleanup incomplete`, async () => {
    const f = joinedFixture({ stopThrows: !missingTerminal }), connection = await f.open(), stop = f.voice.stop();
    assert.equal(connection.source.readyState, 'ended'); assert.equal(connection.provider.snapshot().review, null);
    if (missingTerminal) { f.clock.set(1050); f.clock.fire(); }
    const result = await stop.local; assert.equal(result.status, 'incomplete'); assert.ok(result.failedSteps.includes('abortPending'));
    assert.ok(result.failedSteps.includes('closeTransport')); assert.equal(connection.provider.snapshot().localCleanup, 'incomplete');
    assert.equal(f.turns.length, 0); assert.equal(connection.recorder.count(), 0); assert.equal(f.clock.scheduled.size, 0);
    await assert.rejects(f.voice.start(), /voice_session_busy/);
  });
}

integration('production standard provider playback cleanup failure remains incomplete and clears text immediately', async () => {
  const f = joinedFixture({ pauseThrows: true }), connection = await f.open(), completed = f.finishCapture(connection);
  const rejected = assert.rejects(completed, /voice_playback_cleanup_incomplete/); await flush(); f.turns[0].resolve(settledSpeech()); await flush();
  assert.ok(connection.provider.snapshot().review);
  f.elements[0].gate.reject(Object.assign(new Error('synthetic autoplay denial'), { name: 'NotAllowedError' })); await rejected;
  assert.equal(connection.provider.snapshot().review, null); assert.equal(connection.source.readyState, 'ended');
  assert.equal((await f.voice.stop().local).status, 'incomplete');
  assert.equal(connection.provider.snapshot().localCleanup, 'incomplete'); assert.equal(f.objects.size, 0); assert.equal(f.elements[0].count(), 0);
  await assert.rejects(f.voice.start(), /voice_session_busy/);
});

for (const gate of ['revokeDisclosure', 'revokeBinding']) {
  integration(`production standard provider ${gate} prevents turn dispatch after capture`, async () => {
    const f = joinedFixture(), connection = await f.open();
    f[gate](); const completed = connection.provider.finishRecording(), rejected = assert.rejects(completed);
    connection.recorder.end(); await rejected; assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] });
    assert.equal(f.turns.length, 0); assert.equal(f.elements.length, 0); f.assertReleased();
  });
  integration(`production standard provider ${gate} fences a pending response before review or playback`, async () => {
    const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection), rejected = assert.rejects(completed);
    await flush(); f[gate](); f.turns[0].resolve(settledSpeech()); await rejected;
    assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] });
    assert.equal(connection.provider.snapshot().review, null); assert.equal(f.elements.length, 0); f.assertReleased();
  });
}

for (const failure of ['blocked', 'failed', 'duration_limit']) {
  integration(`production playback ${failure} retains known review only after output cleanup`, async () => {
    const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection);
    await flush(); f.turns[0].resolve(settledSpeech()); await flush();
    const audio = f.elements[0], queuedEnded = [...audio.listeners.get('ended')][0];
    if (failure === 'blocked') audio.gate.reject(Object.assign(new Error('private autoplay detail'), { name: 'NotAllowedError' }));
    if (failure === 'failed') audio.emit('error');
    if (failure === 'duration_limit') { f.clock.set(1500); f.clock.fire(); }
    assert.equal(await completed, undefined); const state = connection.provider.snapshot();
    assert.equal(state.phase, 'review'); assert.deepEqual(state.review, settledSpeech().review);
    assert.equal(state.manualFallback, true); assert.equal(state.error, `voice_playback_${failure}`);
    assert.equal(state.outcome, 'succeeded'); assert.equal(state.accounting, 'settled'); assert.equal(state.localCleanup, 'none');
    assert.equal(connection.source.readyState, 'live'); connection.assertCurrent(); f.session.assertCurrent(connection.fence);
    assert.equal(f.objects.size, 0); assert.equal(f.clock.scheduled.size, 1); assert.equal(connection.recorder.count(), 0);
    assert.equal(connection.player.snapshot().cleanup, 'released');
    assert.equal(audio.count(), 0); assert.equal(audio.src, null); assert.equal(audio.playing, false);
    audio.gate.resolve(); queuedEnded(); await flush(); assert.equal(audio.plays, 1); assert.equal(audio.playing, false);
    assert.equal(connection.provider.finishRecording(), completed); assert.equal(f.turns.length, 1);
    await assert.rejects(f.voice.start(), /voice_session_busy/);
    const stop = f.voice.stop(); assert.equal(connection.provider.snapshot().review, null);
    assert.deepEqual(await stop.local, { status: 'released', failedSteps: [] }); f.assertReleased();
  });
}

for (const failure of ['input_invalid', 'wav_invalid']) {
  integration(`production malformed speech ${failure} clears known review and stops the actual session`, async () => {
    const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection);
    const rejected = assert.rejects(completed, new RegExp(`voice_playback_${failure}`));
    const result = settledSpeech();
    if (failure === 'input_invalid') result.outcome.value.audio = new Uint8Array();
    else result.outcome.value.audio[0] = 0;
    await flush(); f.turns[0].resolve(result); await rejected;
    const state = connection.provider.snapshot();
    assert.equal(state.review, null); assert.equal(state.phase, 'error'); assert.equal(state.error, `voice_playback_${failure}`);
    assert.equal(state.outcome, 'succeeded'); assert.equal(state.accounting, 'settled');
    assert.equal(connection.source.readyState, 'ended'); assert.throws(() => connection.assertCurrent());
    assert.equal(connection.player.snapshot().cleanup, 'none'); assert.equal(f.elements.length, 0); assert.equal(f.objects.size, 0);
    assert.equal(connection.provider.finishRecording(), completed); assert.equal(f.turns.length, 1);
    assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] }); f.assertReleased();
  });
}

integration('production standard provider snapshot clears review when the original account guard changes without a notification', async () => {
  const f = joinedFixture(), connection = await f.open(), completed = f.finishCapture(connection), rejected = assert.rejects(completed);
  await flush(); f.turns[0].resolve(settledSpeech()); await flush(); assert.ok(connection.provider.snapshot().review);
  f.changeAccount(); assert.equal(connection.provider.snapshot().review, null); assert.equal(connection.source.readyState, 'ended');
  await rejected; assert.deepEqual(await f.voice.stop().local, { status: 'released', failedSteps: [] }); f.assertReleased();
  assert.equal(f.voice.snapshot().reason, 'account_changed');
});
