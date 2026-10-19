const test = require('node:test');
const assert = require('node:assert/strict');
const { createStandardVoiceConsumer } = require('../controller.ts');
const { VoiceSessionController, ExclusiveMicOwner } = require('../../session-controller.ts');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function wave() {
  const bytes = new Uint8Array(46), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
    [...text].forEach((char, i) => { bytes[offset + i] = char.charCodeAt(0); });
  }
  for (const [offset, value] of [[4, 38], [16, 16], [24, 16000], [28, 32000], [40, 2]]) view.setUint32(offset, value, true);
  for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(offset, value, true);
  return bytes;
}
const audio = () => new Blob([wave()], { type: 'audio/wav' });
const success = () => ({ outcome: { kind: 'succeeded', value: { audio: wave(), mediaType: 'audio/wav' } }, accounting: 'settled' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const calls = [], states = [], inputs = [];
  const entered = Object.fromEntries(['acquire', 'capture', 'finish', 'turn', 'play', 'stop'].map(name => [name, deferred()]));
  let current = true, generation = 0, nextId = 0;
  const account = { accountId: 'original', authSessionId: 'original-session', accountEpoch: 3 };
  const scope = { account, isCurrent: () => current };
  let handle;
  const host = {
    async startStandard(captured, sessionId, signal) {
      calls.push('acquire'); inputs.push({ captured, sessionId, signal });
      handle = {
        fence: { ...captured.account, generation: ++generation },
        assertCurrent() {},
        async startCapture() { calls.push('capture'); entered.capture.resolve(); return overrides.capture?.(); },
        async finishCapture() { calls.push('finish'); entered.finish.resolve(); return overrides.finish ? overrides.finish() : audio(); },
        async play(blob) { calls.push('play'); assert.equal(blob.type, 'audio/wav'); entered.play.resolve(); return overrides.play?.(blob); },
        async stop(reason) { calls.push(['stop', reason]); entered.stop.resolve(); return overrides.stop ? overrides.stop(reason) : { status: 'released', failedSteps: [] }; },
      };
      if (overrides.fence) handle.fence = overrides.fence;
      entered.acquire.resolve();
      return overrides.acquire ? overrides.acquire(handle, signal) : handle;
    },
  };
  const turn = { async run(input) {
    calls.push('turn'); inputs.push(input); entered.turn.resolve(input);
    return overrides.turn ? overrides.turn(input) : success();
  } };
  const consumer = createStandardVoiceConsumer({ scope,
    ...(overrides.noHost ? {} : { host }), ...(overrides.noTurn ? {} : { turn }),
    newSessionId: () => { calls.push('id'); return overrides.sessionId ?? `turn-${++nextId}`; },
    onManual: (...args) => { calls.push('manual'); return overrides.manual?.(...args); },
  });
  consumer.subscribe(state => { states.push(state); });
  return { consumer, scope, host, turn, calls, states, inputs, entered, handle: () => handle, stale() { current = false; } };
}
const count = (f, name) => f.calls.filter(call => call === name || Array.isArray(call) && call[0] === name).length;

test('one settled turn keeps the shared fence through capture, submission and playback until explicit stop', async () => {
  const f = fixture();
  await f.consumer.start(); assert.equal(f.consumer.snapshot().phase, 'capturing');
  await f.consumer.finishAndSend();
  assert.equal(f.consumer.snapshot().phase, 'completed');
  assert.equal(f.consumer.snapshot().accounting, 'settled');
  assert.equal(count(f, 'stop'), 0);
  assert.deepEqual(f.calls, ['id', 'acquire', 'capture', 'finish', 'turn', 'play']);
  const input = f.inputs[1];
  assert.deepEqual(input.fence, f.handle().fence); assert.equal(input.audioBlob.type, 'audio/wav');
  input.assertCurrent();
  await assert.rejects(f.consumer.start(), /busy/);
  assert.equal((await f.consumer.stop('user_stop')).status, 'released');
  assert.throws(input.assertCurrent, /stale/);
  await f.consumer.start(); assert.equal(count(f, 'acquire'), 2);
  await f.consumer.stop('user_stop');
});

test('absent host or turn port is unavailable with zero acquisition and an explicit manual fallback', async () => {
  for (const options of [{ noHost: true }, { noTurn: true }]) {
    const f = fixture(options);
    await f.consumer.start(); assert.equal(f.consumer.snapshot().phase, 'unavailable');
    assert.deepEqual(f.calls, []);
    await f.consumer.useManual();
    assert.deepEqual(f.calls, ['manual']); assert.equal(f.consumer.snapshot().phase, 'manual');
  }
});

test('duplicate start and finish cannot acquire or dispatch twice', async () => {
  const pending = deferred(), f = fixture({ turn: () => pending.promise });
  await f.consumer.start();
  await assert.rejects(f.consumer.start(), /busy/);
  const sending = f.consumer.finishAndSend(); await f.entered.turn.promise;
  await assert.rejects(f.consumer.finishAndSend(), /not_ready/);
  pending.resolve(success()); await sending;
  assert.equal(count(f, 'acquire'), 1); assert.equal(count(f, 'finish'), 1); assert.equal(count(f, 'turn'), 1);
  await f.consumer.stop('user_stop');
});

test('non-settled successful server results never play or silently retry', async () => {
  for (const accounting of ['not_reserved', 'replay', 'released', 'not_consumed', 'unknown', 'unresolved']) {
    const f = fixture({ turn: () => ({ ...success(), accounting }) });
    await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(f.consumer.snapshot().phase, 'unknown');
    assert.equal(f.consumer.snapshot().accounting, accounting);
    assert.equal(count(f, 'turn'), 1); assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'stop'), 1);
  }
});

test('rejected, not-dispatched and unknown outcomes keep their meaning without content or retry', async () => {
  for (const kind of ['not_dispatched', 'rejected', 'unknown']) {
    const f = fixture({ turn: () => ({ outcome: { kind, reason: 'private provider content' }, accounting: 'unknown' }) });
    await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(f.consumer.snapshot().phase, kind === 'unknown' ? 'unknown' : 'failed');
    assert.equal(f.consumer.snapshot().outcome, kind);
    assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'turn'), 1);
    assert.equal(JSON.stringify(f.states).includes('private provider content'), false);
  }
});

test('stop aborts a pending acquisition immediately and awaits exact late-handle cleanup', async () => {
  const pending = deferred(), f = fixture({ acquire: () => pending.promise });
  const starting = f.consumer.start(); await f.entered.acquire.promise;
  const stopping = f.consumer.stop('background');
  assert.equal(f.inputs[0].signal.aborted, true);
  assert.strictEqual(f.consumer.stop('background'), stopping);
  let done = false; stopping.then(() => { done = true; });
  await tick(); assert.equal(done, false);
  await assert.rejects(f.consumer.start(), /busy/);
  pending.resolve(f.handle()); await starting;
  assert.equal((await stopping).status, 'released');
  assert.equal(count(f, 'capture'), 0); assert.equal(count(f, 'stop'), 1); assert.equal(count(f, 'turn'), 0);
});

test('stop reentrancy from acquiring notification prevents host acquisition entirely', async () => {
  const f = fixture(); let stopping;
  f.consumer.subscribe(state => { if (state.phase === 'acquiring') stopping = f.consumer.stop('navigation'); });
  await f.consumer.start();
  assert.equal((await stopping).status, 'released');
  assert.equal(count(f, 'acquire'), 0); assert.equal(count(f, 'capture'), 0);
});

test('late capture-start completion after stop cannot restore capturing state', async () => {
  const pending = deferred(), f = fixture({ capture: () => pending.promise });
  const starting = f.consumer.start(); await f.entered.capture.promise;
  await f.consumer.stop('interruption');
  pending.resolve(); await starting;
  assert.equal(f.consumer.snapshot().phase, 'idle'); assert.equal(count(f, 'turn'), 0);
});

test('late finished audio after stop is discarded before server dispatch', async () => {
  const pending = deferred(), f = fixture({ finish: () => pending.promise });
  await f.consumer.start(); const sending = f.consumer.finishAndSend(); await f.entered.finish.promise;
  await f.consumer.stop('background'); pending.resolve(audio()); await sending;
  assert.equal(count(f, 'turn'), 0); assert.equal(count(f, 'play'), 0); assert.equal(f.consumer.snapshot().phase, 'idle');
});

test('late server speech cannot play or overwrite a subsequent explicitly started operation', async () => {
  const pending = deferred(), f = fixture({ turn: () => pending.promise });
  await f.consumer.start(); const sending = f.consumer.finishAndSend(); const input = await f.entered.turn.promise;
  await f.consumer.stop('user_stop');
  assert.equal(input.signal.aborted, true); assert.throws(input.assertCurrent, /stale/);
  assert.equal(f.consumer.snapshot().outcome, 'unknown');
  await f.consumer.start();
  pending.resolve(success()); await sending;
  assert.equal(f.consumer.snapshot().phase, 'capturing'); assert.equal(count(f, 'play'), 0);
  await f.consumer.stop('user_stop');
});

test('stop during playback delegates cleanup and late playback completion cannot publish completed', async () => {
  const pending = deferred(), f = fixture({ play: () => pending.promise });
  await f.consumer.start(); const sending = f.consumer.finishAndSend(); await f.entered.play.promise;
  await f.consumer.stop('navigation'); pending.resolve(); await sending;
  assert.equal(f.consumer.snapshot().phase, 'idle'); assert.equal(count(f, 'stop'), 1);
  assert.equal(f.states.some(state => state.phase === 'completed'), false);
});

test('incomplete, contradictory or throwing cleanup blocks restart but permits local manual entry', async () => {
  for (const stop of [
    () => ({ status: 'incomplete', failedSteps: ['private failure'] }),
    () => ({ status: 'released', failedSteps: ['unproved'] }),
    () => { throw new Error('private cleanup'); },
  ]) {
    const f = fixture({ stop }); await f.consumer.start();
    assert.equal((await f.consumer.stop('user_stop')).status, 'incomplete');
    assert.equal(f.consumer.snapshot().phase, 'cleanup_incomplete');
    await assert.rejects(f.consumer.start(), /busy/);
    await f.consumer.useManual(); assert.equal(count(f, 'manual'), 1); assert.equal(count(f, 'stop'), 1);
    assert.equal(JSON.stringify(f.states).includes('private'), false);
  }
});

test('an arbitrary acquisition rejection does not claim cleanup or retry the host', async () => {
  const f = fixture({ acquire: () => { throw new Error('unproved acquisition'); } });
  await f.consumer.start();
  assert.equal(f.consumer.snapshot().phase, 'cleanup_incomplete');
  await assert.rejects(f.consumer.start(), /busy/);
  await f.consumer.useManual(); assert.equal(count(f, 'manual'), 1); assert.equal(count(f, 'acquire'), 1);
});

test('original account, scope function and injected turn implementation survive caller mutation', async () => {
  const pending = deferred(), f = fixture({ finish: () => pending.promise });
  await f.consumer.start(); const sending = f.consumer.finishAndSend(); await f.entered.finish.promise;
  f.scope.account.accountId = 'replacement'; f.scope.account.authSessionId = 'replacement-session';
  f.scope.isCurrent = () => false;
  f.turn.run = () => { throw new Error('replacement transport used'); };
  pending.resolve(audio()); await sending;
  assert.equal(f.consumer.snapshot().phase, 'completed');
  assert.equal(f.inputs[1].scope.account.accountId, 'original');
  assert.equal(f.inputs[1].scope.account.authSessionId, 'original-session');
  assert.ok(Object.isFrozen(f.inputs[1].scope)); assert.ok(Object.isFrozen(f.inputs[1].scope.account));
  await f.consumer.stop('user_stop');
});

test('scope invalidation during acquisition cleans the handle without starting capture', async () => {
  const pending = deferred(), f = fixture({ acquire: () => pending.promise });
  const starting = f.consumer.start(); await f.entered.acquire.promise;
  f.stale(); pending.resolve(f.handle()); await starting;
  assert.equal(count(f, 'capture'), 0); assert.equal(count(f, 'stop'), 1);
  assert.equal(f.consumer.snapshot().failure, 'session_changed');
  await f.consumer.useManual(); assert.equal(count(f, 'manual'), 0);
});

test('scope invalidation after server dispatch blocks old-account playback and reports unknown', async () => {
  const pending = deferred(), f = fixture({ turn: () => pending.promise });
  await f.consumer.start(); const sending = f.consumer.finishAndSend(); await f.entered.turn.promise;
  f.stale(); pending.resolve(success()); await sending;
  assert.equal(f.consumer.snapshot().phase, 'unknown'); assert.equal(f.consumer.snapshot().outcome, 'unknown');
  assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'stop'), 1);
});

test('a mismatched host fence is stopped without capture or submission', async () => {
  const f = fixture({ fence: { accountId: 'replacement', authSessionId: 'other', accountEpoch: 4, generation: 1 } });
  await f.consumer.start(); assert.equal(count(f, 'capture'), 0); assert.equal(count(f, 'turn'), 0);
  assert.equal(count(f, 'stop'), 1); assert.equal(f.consumer.snapshot().phase, 'failed');
});

test('synchronous and asynchronous server exceptions stay unknown with no retry or content leak', async () => {
  for (const turn of [() => { throw new Error('private detail'); }, () => Promise.reject(new Error('private detail'))]) {
    const f = fixture({ turn }); await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(f.consumer.snapshot().phase, 'unknown'); assert.equal(f.consumer.snapshot().accounting, 'unknown');
    assert.equal(count(f, 'turn'), 1); assert.equal(count(f, 'play'), 0);
    assert.equal(JSON.stringify(f.states).includes('private detail'), false);
  }
});

test('malformed result or non-WAV speech cannot become playback success', async () => {
  for (const result of [null, {}, { ...success(), accounting: 'invented' },
    { outcome: { kind: 'succeeded', value: { audio: wave(), mediaType: 'audio/mp3' } }, accounting: 'settled' },
    { outcome: { kind: 'succeeded', value: { audio: new Uint8Array(), mediaType: 'audio/wav' } }, accounting: 'settled' }]) {
    const f = fixture({ turn: () => result }); await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(f.consumer.snapshot().phase, 'unknown'); assert.equal(count(f, 'play'), 0);
  }
});

test('invalid captured audio is discarded without submitting a server turn', async () => {
  for (const blob of [null, new Blob([], { type: 'audio/wav' }), new Blob(['private'], { type: 'audio/mp3' })]) {
    const f = fixture({ finish: () => blob }); await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(count(f, 'turn'), 0); assert.equal(f.consumer.snapshot().failure, 'audio_invalid');
    assert.equal(f.consumer.snapshot().phase, 'failed');
  }
});

test('manual entry is explicit, aborts an in-flight turn, and never submits fallback content', async () => {
  const pending = deferred(), f = fixture({ turn: () => pending.promise });
  await f.consumer.start(); const sending = f.consumer.finishAndSend(); const input = await f.entered.turn.promise;
  await f.consumer.useManual(); await f.consumer.useManual();
  assert.equal(input.signal.aborted, true); assert.equal(count(f, 'manual'), 1);
  pending.resolve(success()); await sending;
  assert.equal(f.consumer.snapshot().phase, 'manual'); assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'turn'), 1);
});

test('throwing observers cannot skip cleanup and snapshots contain bounded state only', async () => {
  const f = fixture(); let observations = 0;
  const sub = f.consumer.subscribe(() => { observations++; throw new Error('observer'); });
  await f.consumer.start(); sub.remove(); const before = observations;
  await f.consumer.finishAndSend(); await f.consumer.stop('user_stop');
  assert.equal(observations, before);
  for (const state of f.states) {
    assert.ok(Object.isFrozen(state));
    assert.ok(Object.keys(state).every(key => ['phase', 'cleanup', 'failure', 'outcome', 'accounting', 'reviewAvailable'].includes(key)));
  }
  assert.equal(count(f, 'stop'), 1);
});

test('stop from a playing notification prevents the playback call itself', async () => {
  const f = fixture(); let stopping;
  f.consumer.subscribe(state => { if (state.phase === 'playing') stopping = f.consumer.stop('background'); });
  await f.consumer.start(); await f.consumer.finishAndSend(); await stopping;
  assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'stop'), 1);
});

test('dispose aborts pending work, removes observers and never resumes after a late result', async () => {
  const pending = deferred(), f = fixture({ turn: () => pending.promise });
  await f.consumer.start(); const sending = f.consumer.finishAndSend(); await f.entered.turn.promise;
  const before = f.states.length;
  await f.consumer.dispose(); pending.resolve(success()); await sending;
  assert.equal(f.states.length, before); assert.equal(f.consumer.snapshot().phase, 'disposed');
  assert.equal(count(f, 'play'), 0); await assert.rejects(f.consumer.start(), /disposed/);
});

test('invalid or reused session IDs do not acquire a new shared handle', async () => {
  for (const sessionId of ['', ' '.repeat(2), 'a'.repeat(129)]) {
    const f = fixture({ sessionId }); await f.consumer.start();
    assert.equal(f.consumer.snapshot().failure, 'session_id_invalid'); assert.equal(count(f, 'acquire'), 0);
  }
  const f = fixture({ sessionId: 'same-id' }); await f.consumer.start(); await f.consumer.stop('user_stop');
  await f.consumer.start(); assert.equal(f.consumer.snapshot().failure, 'session_id_invalid');
  assert.equal(count(f, 'acquire'), 1);
});

test('capture and playback failures stop only the captured handle and expose bounded reasons', async () => {
  const first = fixture({ capture: () => { throw new Error('private capture'); } });
  await first.consumer.start(); assert.equal(first.consumer.snapshot().failure, 'capture_failed'); assert.equal(count(first, 'stop'), 1);
  const second = fixture({ play: () => { throw new Error('private playback'); } });
  await second.consumer.start(); await second.consumer.finishAndSend();
  assert.equal(second.consumer.snapshot().failure, 'playback_failed'); assert.equal(count(second, 'stop'), 1);
  assert.equal(JSON.stringify([...first.states, ...second.states]).includes('private'), false);
});


test('missing shared assertion is unavailable and cleans the acquired handle without capture or dispatch', async () => {
  const f = fixture({ acquire(handle) { delete handle.assertCurrent; return handle; } });
  await f.consumer.start();
  assert.equal(f.consumer.snapshot().phase, 'unavailable');
  assert.equal(f.consumer.snapshot().failure, 'host_unavailable');
  assert.equal(f.consumer.snapshot().cleanup, 'released');
  assert.equal(count(f, 'capture'), 0); assert.equal(count(f, 'turn'), 0); assert.equal(count(f, 'play'), 0);
  assert.equal(count(f, 'stop'), 1);
  await f.consumer.useManual(); assert.equal(count(f, 'manual'), 1); assert.equal(count(f, 'stop'), 1);
});

function sharedControllerFixture(overrides = {}) {
  const cleanup = [], guard = { current: true };
  const owner = new ExclusiveMicOwner({ async acquire({ fence }) {
    return { fence,
      stopCapture() { cleanup.push('capture'); },
      stopPlayback() { cleanup.push('playback'); },
      async deactivateAudio() { cleanup.push('deactivate'); },
      async release() { cleanup.push('release'); },
    };
  } });
  const controller = new VoiceSessionController(owner, () => { assert.equal(guard.current, true); });
  let fence;
  const f = fixture({ ...overrides, async acquire(handle, signal) {
    fence = await controller.start({ mode: 'standard', account: handle.fence, signal,
      transport: { abortPending() {}, closeTransport() {}, async requestServerStop() {} } });
    handle.fence = fence;
    handle.assertCurrent = function () { assert.strictEqual(this, handle); controller.assertCurrent(fence); };
    const stop = handle.stop;
    handle.stop = async reason => { await stop(reason); return controller.stop(reason).local; };
    return handle;
  } });
  return { ...f, controller, cleanup, guard, fence: () => fence };
}

test('external shared teardown defeats a deferred turn while the original account remains current', async () => {
  const pending = deferred(), f = sharedControllerFixture({ turn: () => pending.promise });
  await f.consumer.start();
  const sending = f.consumer.finishAndSend(); const input = await f.entered.turn.promise;
  input.assertCurrent();
  assert.equal((await f.controller.stop('background').local).status, 'released');
  assert.equal(f.scope.isCurrent(), true); assert.equal(f.guard.current, true);
  assert.equal(input.signal.aborted, false);
  assert.throws(input.assertCurrent, /voice_session_stale/);
  f.handle().assertCurrent = () => {};
  pending.resolve(success()); await sending;
  assert.equal(f.consumer.snapshot().phase, 'unknown');
  assert.equal(f.consumer.snapshot().outcome, 'unknown');
  assert.equal(f.consumer.snapshot().accounting, 'unknown');
  assert.equal(f.consumer.snapshot().cleanup, 'released');
  assert.equal(f.states.some(state => state.outcome === 'succeeded' || state.accounting === 'settled'), false);
  assert.equal(f.states.some(state => state.phase === 'playing' || state.phase === 'completed'), false);
  assert.equal(count(f, 'turn'), 1); assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'stop'), 1);
  assert.deepEqual(f.cleanup, ['capture', 'playback', 'deactivate', 'release']);
  await f.consumer.stop('navigation'); assert.equal(count(f, 'stop'), 1);
});

test('actual shared generation rejects late capture, finished audio and playback completion', async () => {
  for (const stage of ['capture', 'finish', 'play']) {
    const pending = deferred(), f = sharedControllerFixture({ [stage]: () => pending.promise });
    const starting = f.consumer.start();
    let operation = starting;
    if (stage !== 'capture') { await starting; operation = f.consumer.finishAndSend(); }
    await f.entered[stage].promise;
    await f.controller.stop('interruption').local;
    const before = f.states.length;
    assert.equal(f.scope.isCurrent(), true);
    pending.resolve(stage === 'finish' ? audio() : undefined); await operation;
    const late = f.states.slice(before);
    assert.equal(late.some(state => ['capturing', 'playing', 'completed'].includes(state.phase)), false);
    assert.equal(count(f, 'turn'), stage === 'play' ? 1 : 0);
    assert.equal(f.consumer.snapshot().cleanup, 'released');
    assert.equal(count(f, 'stop'), 1);
    assert.deepEqual(f.cleanup, ['capture', 'playback', 'deactivate', 'release']);
  }
});

test('external shared stop before finish prevents processing state and capture finish dispatch', async () => {
  const f = sharedControllerFixture(); await f.consumer.start();
  await f.controller.stop('navigation').local;
  await f.consumer.finishAndSend();
  assert.equal(f.states.some(state => state.phase === 'processing'), false);
  assert.equal(count(f, 'finish'), 0); assert.equal(count(f, 'turn'), 0); assert.equal(count(f, 'stop'), 1);
});


const reviewedSuccess = () => ({ ...success(), review: { transcript: 'synthetic spoken input', reply: 'synthetic coaching reply' } });

test('successful review is a frozen known-field copy kept outside snapshots and listeners', async () => {
  const result = reviewedSuccess();
  result.review.preparedContext = 'private prepared context'; result.review.metadata = 'private metadata';
  const expected = { transcript: result.review.transcript, reply: result.review.reply };
  const f = fixture({ turn: () => result });
  assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().reviewAvailable, false);
  await f.consumer.start(); await f.consumer.finishAndSend();
  const review = f.consumer.review();
  assert.deepEqual(review, expected); assert.ok(Object.isFrozen(review));
  assert.notStrictEqual(review, result.review);
  result.review.transcript = 'replacement transcript'; result.review.reply = 'replacement reply';
  assert.deepEqual(f.consumer.review(), expected);
  assert.equal(f.consumer.snapshot().reviewAvailable, true);
  assert.equal(f.consumer.snapshot().phase, 'completed'); assert.equal(count(f, 'play'), 1);
  assert.equal(count(f, 'stop'), 0);
  for (const text of Object.values(expected).concat(['private prepared context', 'private metadata'])) {
    assert.equal(JSON.stringify(f.states).includes(text), false);
  }
  await f.consumer.stop('user_stop'); assert.equal(f.consumer.review(), null);
});

test('transcript-only review survives a later stage failure without inventing a reply or retry', async () => {
  const result = { outcome: { kind: 'not_dispatched', reason: 'completion_preparation_failed' },
    accounting: 'released', review: { transcript: 'known transcript' } };
  const f = fixture({ turn: () => result }); await f.consumer.start(); await f.consumer.finishAndSend();
  assert.deepEqual(f.consumer.review(), result.review);
  assert.equal(Object.hasOwn(f.consumer.review(), 'reply'), false);
  assert.equal(f.consumer.snapshot().phase, 'failed');
  assert.equal(f.consumer.snapshot().outcome, 'not_dispatched'); assert.equal(f.consumer.snapshot().accounting, 'released');
  assert.equal(count(f, 'stop'), 0); assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'turn'), 1);
  await assert.rejects(f.consumer.start(), /busy/); await assert.rejects(f.consumer.finishAndSend(), /not_ready/);
  await f.consumer.stop('user_stop');
});

test('synthesis rejection or unknown effect preserves known text and exact accounting on the live one-turn handle', async () => {
  for (const [kind, accounting] of [['rejected', 'settled'], ['unknown', 'unknown'], ['unknown', 'unresolved']]) {
    const result = { ...reviewedSuccess(), outcome: { kind, reason: 'private synthesis reason' }, accounting };
    const f = fixture({ turn: () => result }); await f.consumer.start(); await f.consumer.finishAndSend();
    assert.deepEqual(f.consumer.review(), result.review);
    assert.equal(f.consumer.snapshot().outcome, kind); assert.equal(f.consumer.snapshot().accounting, accounting);
    assert.equal(f.consumer.snapshot().phase, kind === 'unknown' ? 'unknown' : 'failed');
    assert.equal(f.consumer.snapshot().cleanup, 'not_started');
    assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'stop'), 0); assert.equal(count(f, 'turn'), 1);
    await assert.rejects(f.consumer.start(), /busy/); await assert.rejects(f.consumer.finishAndSend(), /not_ready/);
    assert.equal(JSON.stringify(f.states).includes('private synthesis reason'), false);
    await f.consumer.stop('user_stop'); assert.equal(f.consumer.review(), null);
  }
});

test('unsettled audio may retain review but cannot play or change accounting into settled', async () => {
  for (const accounting of ['not_reserved', 'replay', 'released', 'not_consumed', 'unknown', 'unresolved']) {
    const result = { ...reviewedSuccess(), accounting }, f = fixture({ turn: () => result });
    await f.consumer.start(); await f.consumer.finishAndSend();
    assert.deepEqual(f.consumer.review(), result.review);
    assert.equal(f.consumer.snapshot().phase, 'unknown'); assert.equal(f.consumer.snapshot().accounting, accounting);
    assert.equal(f.consumer.snapshot().outcome, 'succeeded');
    assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'stop'), 0);
    await f.consumer.stop('user_stop');
  }
});

test('absent or malformed optional review is unavailable without rewriting valid outcome or accounting', async () => {
  for (const review of [undefined, null, 'text', [], {}, { transcript: 7 }, { transcript: 'known', reply: 7 }]) {
    const f = fixture({ turn: () => ({ ...success(), review }) });
    await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().reviewAvailable, false);
    assert.equal(f.consumer.snapshot().phase, 'completed'); assert.equal(f.consumer.snapshot().outcome, 'succeeded');
    assert.equal(f.consumer.snapshot().accounting, 'settled'); assert.equal(count(f, 'play'), 1);
    await f.consumer.stop('user_stop');
  }
});

test('throwing optional review access is discarded without leaking text or changing the turn outcome', async () => {
  const result = success(); Object.defineProperty(result, 'review', { get() { throw new Error('private review getter'); } });
  const f = fixture({ turn: () => result }); await f.consumer.start(); await f.consumer.finishAndSend();
  assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().outcome, 'succeeded');
  assert.equal(count(f, 'play'), 1); assert.equal(JSON.stringify(f.states).includes('private'), false);
  await f.consumer.stop('user_stop');
});

test('review keeps original scope custody despite replacement caller fields', async () => {
  const f = fixture({ turn: reviewedSuccess }); await f.consumer.start(); await f.consumer.finishAndSend();
  f.scope.account.accountId = 'replacement-account'; f.scope.isCurrent = () => false;
  assert.deepEqual(f.consumer.review(), reviewedSuccess().review);
  f.stale();
  assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().reviewAvailable, false);
  f.scope.isCurrent = () => true;
  assert.equal(f.consumer.review(), null);
  await f.consumer.stop('account_changed');
});

test('real shared invalidation before deferred review arrives prevents all review publication', async () => {
  const pending = deferred(), f = sharedControllerFixture({ turn: () => pending.promise });
  await f.consumer.start(); const sending = f.consumer.finishAndSend(); await f.entered.turn.promise;
  await f.controller.stop('background').local;
  assert.equal(f.scope.isCurrent(), true);
  pending.resolve(reviewedSuccess()); await sending;
  assert.equal(f.consumer.review(), null); assert.equal(f.states.some(state => state.reviewAvailable), false);
  assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'stop'), 1);
});

test('review and snapshot reads synchronously clear text after actual shared-generation invalidation', async () => {
  for (const read of ['review', 'snapshot']) {
    const f = sharedControllerFixture({ turn: reviewedSuccess }); await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(f.consumer.snapshot().reviewAvailable, true);
    await f.controller.stop('interruption').local;
    assert.equal(f.scope.isCurrent(), true);
    f.handle().assertCurrent = () => {};
    const value = f.consumer[read]();
    assert.equal(read === 'review' ? value : value.reviewAvailable, read === 'review' ? null : false);
    assert.equal(f.consumer.review(), null); assert.equal(f.states.at(-1).reviewAvailable, false);
    await f.consumer.stop('interruption'); assert.equal(count(f, 'stop'), 1);
  }
});

test('every lifecycle stop clears review before abort listeners, observers and pending cleanup', async () => {
  for (const reason of ['user_stop', 'navigation', 'background', 'logout', 'account_changed', 'interruption', 'aborted', 'failed']) {
    const pending = deferred(), f = fixture({ turn: reviewedSuccess, stop: () => pending.promise });
    await f.consumer.start(); await f.consumer.finishAndSend();
    let abortObserved = false;
    f.inputs[0].signal.addEventListener('abort', () => {
      abortObserved = true; assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().reviewAvailable, false);
    });
    const before = f.states.length;
    const stopping = f.consumer.stop(reason);
    assert.equal(abortObserved, true); assert.equal(f.consumer.review(), null);
    assert.equal(f.consumer.snapshot().cleanup, 'pending');
    assert.equal(f.states.slice(before).every(state => state.reviewAvailable === false), true);
    pending.resolve({ status: 'released', failedSteps: [] }); await stopping;
    assert.equal(f.consumer.review(), null); assert.equal(count(f, 'stop'), 1);
  }
});

test('explicit manual callback receives no draft and reentrancy cannot transfer or submit review', async () => {
  let f, callbackArguments;
  f = fixture({ turn: reviewedSuccess, manual(...args) {
    callbackArguments = args;
    assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().reviewAvailable, false);
    void f.consumer.useManual();
  } });
  await f.consumer.start(); await f.consumer.finishAndSend(); await f.consumer.useManual();
  assert.deepEqual(callbackArguments, []); assert.equal(count(f, 'manual'), 1);
  assert.equal(count(f, 'turn'), 1); assert.equal(count(f, 'stop'), 1); assert.equal(f.consumer.review(), null);
  assert.equal(f.consumer.snapshot().phase, 'manual');
});

test('dispose removes review synchronously while shared cleanup remains pending', async () => {
  const pending = deferred(), f = fixture({ turn: reviewedSuccess, stop: () => pending.promise });
  await f.consumer.start(); await f.consumer.finishAndSend();
  const before = f.states.length, disposing = f.consumer.dispose();
  assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().reviewAvailable, false);
  assert.equal(f.states.length, before);
  pending.resolve({ status: 'released', failedSteps: [] }); await disposing;
  assert.equal(f.consumer.snapshot().phase, 'disposed'); assert.equal(count(f, 'stop'), 1);
});

test('late review from a stopped operation cannot enter a new operation', async () => {
  const pending = deferred(), f = fixture({ turn: () => pending.promise });
  await f.consumer.start(); const sending = f.consumer.finishAndSend(); await f.entered.turn.promise;
  await f.consumer.stop('user_stop'); await f.consumer.start();
  pending.resolve(reviewedSuccess()); await sending;
  assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().reviewAvailable, false);
  assert.equal(f.consumer.snapshot().phase, 'capturing'); assert.equal(count(f, 'play'), 0);
  await f.consumer.stop('user_stop');
});

test('observer stop at review availability clears custody before playback and cannot resurrect review', async () => {
  const f = fixture({ turn: reviewedSuccess }); let stopping;
  f.consumer.subscribe(state => { if (state.reviewAvailable) stopping = f.consumer.stop('background'); });
  await f.consumer.start(); await f.consumer.finishAndSend(); await stopping;
  assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().reviewAvailable, false);
  assert.equal(count(f, 'play'), 0); assert.equal(count(f, 'stop'), 1);
});

test('throwing empty-manual callback cannot retain review or skip cleanup', async () => {
  const f = fixture({ turn: reviewedSuccess, manual() { throw new Error('private manual error'); } });
  await f.consumer.start(); await f.consumer.finishAndSend(); await f.consumer.useManual();
  assert.equal(f.consumer.review(), null); assert.equal(f.consumer.snapshot().failure, 'manual_unavailable');
  assert.equal(count(f, 'stop'), 1); assert.equal(count(f, 'manual'), 1);
  assert.equal(JSON.stringify(f.states).includes('private'), false);
});
