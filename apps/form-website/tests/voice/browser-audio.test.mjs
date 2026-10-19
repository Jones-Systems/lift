import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRecorder, createBrowserSpeechPlayback } from '../../public/voice/browser-audio.mjs';
import { sameFence } from '../../public/voice/mic-owner.mjs';
import { fence, deferred, track, stream, timers, flush, Target, wav } from './fixtures.mjs';
const chunk = (text = 'sound', type = 'audio/webm;codecs=opus') => new Blob([text], { type });

function recording({ recorder = {}, config = {} } = {}) {
  const clock = timers(), instances = [], abort = new AbortController(), source = track(), media = stream(source), assertions = [];
  let valid = true;
  class Recorder extends Target {
    static isTypeSupported(type) { return recorder.supported !== false && type.startsWith('audio/webm'); }
    constructor(input, options) {
      super(); this.stream = input; this.mimeType = recorder.actualMime ?? options.mimeType;
      this.state = 'inactive'; this.stops = 0; this.starts = []; instances.push(this);
      if (recorder.constructorThrows) throw new Error('private constructor error');
    }
    start(timeslice) {
      this.starts.push(timeslice);
      if (recorder.startThrows) throw new Error('private start error');
      this.state = 'recording';
    }
    stop() {
      this.stops++;
      if (recorder.stopThrows) throw new Error('private stop error');
      this.state = 'inactive';
    }
    end(...chunks) { this.state = 'inactive'; for (const data of chunks) this.emit('dataavailable', { data }); this.emit('stop'); }
  }
  const inputs = { mimeType: 'audio/webm;codecs=opus', format: 'webm', maxAudioBytes: 1024,
    maxDurationMs: 1000, stopTimeoutMs: 50, timesliceMs: 25, MediaRecorderImpl: Recorder, ...clock, ...config };
  const owner = createBrowserRecorder(inputs);
  const input = { stream: media, fence, signal: abort.signal, assertCurrent(value) {
    assertions.push(value); if (!valid || !sameFence(value, fence)) throw new Error('account or expiry changed');
  } };
  return { owner, inputs, input, instances, source, media, abort, clock, assertions, invalidate: () => { valid = false; } };
}

function playback({ config = {}, audio = {} } = {}) {
  const clock = timers(), instances = [], objects = new Map(), revoked = [], abort = new AbortController(), assertions = [];
  let valid = true, sequence = 0;
  class Audio extends Target {
    constructor() { super(); this.gate = deferred(); this.src = null; this.playing = false; this.plays = 0; this.pauses = 0; this.loads = 0; }
    play() {
      this.plays++; if (audio.playThrows) throw new Error('private play error');
      this.playing = true; return this.gate.promise;
    }
    pause() { this.pauses++; if (audio.pauseThrows) throw new Error('private pause error'); this.playing = false; }
    removeAttribute(name) { assert.equal(name, 'src'); this.src = null; }
    load() { this.loads++; }
  }
  const inputs = { maxSpeechBytes: 1024, maxDurationMs: 1000, ...clock,
    createAudio() { const element = new Audio(); instances.push(element); return element; },
    url: { createObjectURL(blob) { const name = `blob:synthetic-${++sequence}`; objects.set(name, blob); return name; },
      revokeObjectURL(name) { revoked.push(name); objects.delete(name); } }, ...config };
  const owner = createBrowserSpeechPlayback(inputs);
  const input = { speech: wav(), fence, signal: abort.signal, assertCurrent(value) {
    assertions.push(value); if (!valid || !sameFence(value, fence)) throw new Error('account or expiry changed');
  } };
  return { owner, inputs, input, instances, objects, revoked, abort, clock, assertions, invalidate: () => { valid = false; } };
}

test('recording finalizes the complete WebM Blob after final data+stop and leaves shared tracks live', async () => {
  const f = recording({ recorder: { actualMime: 'audio/webm;codecs=opus;profiles=test' } }), capture = f.owner.start(f.input), recorder = f.instances[0];
  assert.equal(recorder.stream, f.media); assert.deepEqual(recorder.starts, [25]);
  recorder.emit('dataavailable', { data: chunk('first') });
  const result = capture.finish(); let settled = false; void result.then(() => { settled = true; });
  await flush(); assert.equal(settled, false); assert.equal(recorder.state, 'inactive');
  recorder.emit('dataavailable', { data: chunk('last') }); await flush(); assert.equal(settled, false);
  recorder.emit('stop'); const output = await result;
  assert.equal(output.format, 'webm'); assert.equal(output.audio.type, recorder.mimeType);
  assert.equal(await output.audio.text(), 'firstlast'); assert.equal(output.audio.size, 9);
  assert.equal(capture.snapshot().cleanup, 'released'); assert.equal(recorder.count(), 0); assert.equal(f.clock.scheduled.size, 0);
  assert.equal(f.source.stops, 0); assert.equal(f.source.readyState, 'live'); assert.ok(f.assertions.every(value => sameFence(value, fence)));
});

test('explicit MIME/format and finite positive bounds are mandatory before recording allocation', () => {
  const f = recording();
  for (const change of [{ mimeType: '' }, { mimeType: 'audio/ogg' }, { format: 'ogg' }, { maxAudioBytes: 0 },
    { maxAudioBytes: 25_000_001 }, { maxAudioBytes: 1.5 }, { maxDurationMs: 0 }, { maxDurationMs: Infinity },
    { stopTimeoutMs: undefined }, { stopTimeoutMs: NaN }, { timesliceMs: 0 }]) {
    assert.throws(() => createBrowserRecorder({ ...f.inputs, ...change }), /voice_recording_config_invalid/);
  }
  assert.equal(f.instances.length, 0);
});

test('unsupported codec returns unavailable without recorder or microphone fallback', () => {
  const f = recording({ recorder: { supported: false } });
  assert.throws(() => f.owner.start(f.input), /voice_recording_unavailable/);
  assert.equal(f.instances.length, 0); assert.equal(f.source.stops, 0);
});

test('only the supplied live audio stream is admitted; no tracks are cloned or reacquired', () => {
  const f = recording();
  for (const media of [stream(), stream(track('video')), stream({ ...track(), readyState: 'ended' })]) {
    assert.throws(() => f.owner.start({ ...f.input, stream: media }), /voice_recording_stream_invalid/);
  }
  assert.equal(f.instances.length, 0);
});

test('initial wrong fence, expired guard, or aborted signal allocates no recorder', () => {
  const f = recording();
  assert.throws(() => f.owner.start({ ...f.input, fence: { ...fence, accountEpoch: 99 } }), /voice_audio_stale/);
  f.invalidate(); assert.throws(() => f.owner.start(f.input), /voice_audio_stale/);
  f.abort.abort(); assert.throws(() => f.owner.start(f.input), /voice_audio_aborted/);
  assert.equal(f.instances.length, 0);
});

test('final chunk is included in the cap and oversized recordings never produce provider input', async () => {
  for (const final of ['56', '567']) {
    const f = recording({ config: { maxAudioBytes: 6 } }), capture = f.owner.start(f.input), recorder = f.instances[0];
    recorder.emit('dataavailable', { data: chunk('1234') }); const finished = capture.finish();
    const rejected = final.length === 3 ? assert.rejects(finished, /voice_recording_byte_limit/) : null;
    recorder.end(chunk(final));
    if (rejected) await rejected; else assert.equal((await finished).audio.size, 6);
    assert.equal(capture.snapshot().cleanup, 'released'); assert.equal(recorder.count(), 0); assert.equal(f.clock.scheduled.size, 0);
  }
});

test('oversized intermediate chunk stops locally, discards later data, and releases at terminal stop', async () => {
  const f = recording({ config: { maxAudioBytes: 3 } }), capture = f.owner.start(f.input), recorder = f.instances[0];
  const rejected = assert.rejects(capture.result, /voice_recording_byte_limit/);
  recorder.emit('dataavailable', { data: chunk('too large') }); await rejected;
  assert.equal(recorder.stops, 1); assert.equal(capture.snapshot().cleanup, 'pending');
  recorder.end(chunk('late')); await capture.cancel(); assert.equal(capture.snapshot().cleanup, 'released');
});

test('empty chunks are ignored but empty or incorrectly typed final audio is rejected', async () => {
  for (const data of [new Blob(), chunk('x', 'audio/ogg'), chunk('x', '')]) {
    const f = recording(), capture = f.owner.start(f.input), recorder = f.instances[0];
    const rejected = assert.rejects(capture.result, data.size ? /voice_recording_mime_mismatch/ : /voice_recording_empty/);
    recorder.end(data); await rejected; assert.equal(capture.snapshot().cleanup, 'released');
  }
});

test('actual recorder MIME mismatch cannot be relabelled as configured WebM', async () => {
  const f = recording({ recorder: { actualMime: 'audio/ogg' } }), capture = f.owner.start(f.input);
  await assert.rejects(capture.result, /voice_recording_mime_mismatch/);
  assert.equal(f.instances[0].starts.length, 0); assert.equal(capture.snapshot().cleanup, 'released');
});

test('technical duration guard discards capture and never fabricates subscription allowance', async () => {
  const f = recording(), capture = f.owner.start(f.input), recorder = f.instances[0];
  recorder.emit('dataavailable', { data: chunk() }); const rejected = assert.rejects(capture.result, /voice_recording_duration_limit/);
  f.clock.set(2000); f.clock.fire(); await rejected;
  assert.equal(recorder.stops, 1); recorder.end(chunk('late')); await capture.cancel();
  assert.equal(f.clock.scheduled.size, 0); assert.equal(f.source.stops, 0);
});

test('finish cannot evade the technical duration bound before a delayed timer callback runs', async () => {
  const f = recording(), capture = f.owner.start(f.input), recorder = f.instances[0];
  recorder.emit('dataavailable', { data: chunk() }); f.clock.set(2000);
  const finished = capture.finish(), rejected = assert.rejects(finished, /voice_recording_duration_limit/);
  recorder.end(chunk()); await rejected; assert.equal(f.clock.scheduled.size, 0);
});

test('recording terminal cleanup removes the abort listener and permits another turn on the same leased stream', async () => {
  const f = recording(), signal = new Target(); signal.aborted = false;
  for (let turn = 0; turn < 2; turn++) {
    const capture = f.owner.start({ ...f.input, signal }); assert.equal(signal.count(), 1);
    const finished = capture.finish(); f.instances[turn].end(chunk()); await finished;
    assert.equal(signal.count(), 0); assert.equal(f.source.stops, 0);
  }
});

test('cancel or signal abort stops once, fences queued chunks and waits for known recorder termination', async () => {
  for (const signalAbort of [false, true]) {
    const f = recording(), capture = f.owner.start(f.input), recorder = f.instances[0];
    const oldListener = [...recorder.listeners.get('dataavailable')][0];
    const rejected = assert.rejects(capture.result, /voice_audio_aborted/);
    if (signalAbort) f.abort.abort(); else void capture.cancel();
    const cleanup = capture.cancel(); assert.equal(recorder.stops, 1); assert.equal(capture.snapshot().cleanup, 'pending');
    oldListener({ data: chunk('stale') }); recorder.end(chunk('stale final')); await rejected; await cleanup;
    oldListener({ data: chunk('already queued') }); assert.equal(recorder.count(), 0); assert.equal(f.clock.scheduled.size, 0);
    assert.equal(capture.snapshot().cleanup, 'released'); assert.equal(f.source.stops, 0);
  }
});

test('account/expiry changes fence data and finish delivery without stopping shared tracks', async () => {
  for (const at of ['data', 'finish', 'after-stop']) {
    const f = recording(), capture = f.owner.start(f.input), recorder = f.instances[0];
    recorder.emit('dataavailable', { data: chunk() });
    if (at === 'after-stop') {
      recorder.end(); f.invalidate(); await assert.rejects(capture.finish(), /voice_audio_stale/);
    } else {
      f.invalidate();
      if (at === 'data') recorder.emit('dataavailable', { data: chunk() });
      const finished = capture.finish(), rejected = assert.rejects(finished, /voice_audio_stale/);
      recorder.end(); await rejected;
    }
    assert.equal(f.source.stops, 0); assert.equal(recorder.count(), 0);
  }
});

test('missing stop event becomes incomplete after the watchdog and retains the recording hold', async () => {
  const f = recording(), capture = f.owner.start(f.input); const result = capture.finish();
  const rejected = assert.rejects(result, /voice_recording_cleanup_incomplete/);
  f.clock.set(1050); f.clock.fire(); await rejected;
  await assert.rejects(capture.cancel(), /voice_recording_cleanup_incomplete/);
  assert.equal(capture.snapshot().cleanup, 'incomplete'); assert.equal(f.instances[0].count(), 0); assert.equal(f.clock.scheduled.size, 0);
  assert.throws(() => f.owner.start(f.input), /voice_recording_busy/);
});

test('throwing stop is incomplete, is not retried, and removes all owned handlers/timers', async () => {
  const f = recording({ recorder: { stopThrows: true } }), capture = f.owner.start(f.input);
  await assert.rejects(capture.finish(), /voice_recording_cleanup_incomplete/);
  await assert.rejects(capture.cancel(), /voice_recording_cleanup_incomplete/);
  assert.equal(f.instances[0].stops, 1); assert.equal(f.instances[0].count(), 0); assert.equal(f.clock.scheduled.size, 0);
  assert.throws(() => f.owner.start(f.input), /voice_recording_busy/);
});

test('recorder errors suppress payload, stop locally and clean up without raw error leakage', async () => {
  const f = recording(), capture = f.owner.start(f.input), recorder = f.instances[0];
  const rejected = assert.rejects(capture.result, error => error.code === 'voice_recording_failed' && !error.message.includes('private'));
  recorder.emit('error', { error: new Error('private') }); assert.equal(recorder.stops, 1);
  recorder.end(chunk()); await rejected; await capture.dispose();
  assert.equal(capture.snapshot().cleanup, 'released');
});

test('concurrent recording rejects; disposal aborts its resource and permanently closes its factory', async () => {
  const f = recording(), capture = f.owner.start(f.input), rejected = assert.rejects(capture.result, /voice_audio_aborted/);
  assert.throws(() => f.owner.start(f.input), /voice_recording_busy/);
  const disposed = f.owner.dispose(); f.instances[0].end(); await rejected; await disposed;
  assert.throws(() => f.owner.start(f.input), /voice_recording_disposed/); assert.equal(f.clock.scheduled.size, 0);
});

test('playback validates and snapshots RIFF/WAVE bytes before URL creation, then resolves only on ended', async () => {
  const f = playback(), expected = new Uint8Array(f.input.speech.audio), pending = f.owner.play(f.input), element = f.instances[0];
  const blob = [...f.objects.values()][0]; assert.equal(blob.type, 'audio/wav');
  f.input.speech.audio.fill(0); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), expected);
  let ended = false; void pending.then(() => { ended = true; }); element.gate.resolve(); await flush(); assert.equal(ended, false);
  element.emit('ended'); await pending;
  assert.equal(element.playing, false); assert.equal(element.src, null); assert.equal(element.count(), 0);
  assert.equal(f.objects.size, 0); assert.equal(f.revoked.length, 1); assert.equal(f.clock.scheduled.size, 0);
  assert.equal(f.owner.snapshot().cleanup, 'released'); assert.ok(f.assertions.every(value => sameFence(value, fence)));
});

test('bounded WAV chunk traversal accepts metadata padding and imposes no PCM/sample-rate policy', async () => {
  const f = playback();
  const speech = wav({ formatTag: 3, channels: 2, sampleRate: 48000, extra: [['JUNK', new Uint8Array([7])]] });
  const pending = f.owner.play({ ...f.input, speech }); f.instances[0].emit('ended'); await pending;
  assert.equal(f.objects.size, 0);
});

test('WAV view offsets are respected rather than reading unrelated backing-buffer bytes', async () => {
  const f = playback(), speech = wav(), backing = new Uint8Array(speech.audio.length + 9);
  backing.set(speech.audio, 4); const view = backing.subarray(4, 4 + speech.audio.length);
  const pending = f.owner.play({ ...f.input, speech: { audio: view, mediaType: 'audio/wav' } });
  assert.equal([...f.objects.values()][0].size, speech.audio.length); f.instances[0].emit('ended'); await pending;
});

test('invalid WAV envelope, signatures, declared ranges, missing format/data and truncation cause zero playback effects', async () => {
  const mutations = [
    speech => ({ ...speech, mediaType: 'audio/mpeg' }),
    speech => ({ ...speech, audio: new Uint8Array() }),
    speech => ({ ...speech, audio: new Blob([speech.audio]) }),
    speech => { speech.audio[0] = 0; return speech; },
    speech => { speech.audio[8] = 0; return speech; },
    speech => { new DataView(speech.audio.buffer).setUint32(4, 999, true); return speech; },
    speech => { new DataView(speech.audio.buffer).setUint32(16, 1000, true); return speech; },
    speech => { new DataView(speech.audio.buffer).setUint32(16, 15, true); return speech; },
    speech => { new DataView(speech.audio.buffer).setUint16(22, 0, true); return speech; },
    speech => { new DataView(speech.audio.buffer).setUint32(24, 0, true); return speech; },
    speech => { speech.audio[12] = 0; return speech; },
    speech => { speech.audio[36] = 0; return speech; },
    speech => { new DataView(speech.audio.buffer).setUint32(40, 3, true); return speech; },
    () => wav({ data: new Uint8Array() }),
    speech => { const bytes = speech.audio.slice(0, -1); new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true); return { ...speech, audio: bytes }; },
  ];
  for (const mutate of mutations) {
    const f = playback(); await assert.rejects(f.owner.play({ ...f.input, speech: mutate(wav()) }), /voice_playback_(input|wav)_invalid/);
    assert.equal(f.instances.length, 0); assert.equal(f.objects.size, 0); assert.equal(f.clock.scheduled.size, 0);
  }
});

test('speech caps and technical playback duration require bounded positive configuration', async () => {
  const f = playback();
  for (const change of [{ maxSpeechBytes: 0 }, { maxSpeechBytes: 25_000_001 }, { maxSpeechBytes: 3.5 },
    { maxDurationMs: 0 }, { maxDurationMs: Infinity }, { maxDurationMs: undefined }]) {
    assert.throws(() => createBrowserSpeechPlayback({ ...f.inputs, ...change }), /voice_playback_config_invalid/);
  }
  const limited = playback({ config: { maxSpeechBytes: 45 } });
  await assert.rejects(limited.owner.play(limited.input), /voice_playback_input_invalid/); assert.equal(limited.instances.length, 0);
});

test('stale or aborted context is rejected before audio construction or URL allocation', async () => {
  const f = playback();
  await assert.rejects(f.owner.play({ ...f.input, fence: { ...fence, authSessionId: 'old' } }), /voice_audio_stale/);
  f.invalidate(); await assert.rejects(f.owner.play(f.input), /voice_audio_stale/);
  f.abort.abort(); await assert.rejects(f.owner.play(f.input), /voice_audio_aborted/);
  assert.equal(f.instances.length, 0); assert.equal(f.objects.size, 0);
});

test('abort before play settlement pauses/detaches/revokes immediately and late settlement has no effects', async () => {
  const f = playback(), pending = f.owner.play(f.input), rejected = assert.rejects(pending, /voice_audio_aborted/), element = f.instances[0];
  f.abort.abort();
  assert.equal(element.playing, false); assert.equal(element.src, null); assert.equal(element.count(), 0);
  assert.equal(f.objects.size, 0); assert.equal(f.revoked.length, 1); assert.equal(f.clock.scheduled.size, 0);
  const before = { plays: element.plays, pauses: element.pauses, loads: element.loads };
  element.gate.resolve(); element.emit('ended'); await rejected; await flush();
  assert.deepEqual({ plays: element.plays, pauses: element.pauses, loads: element.loads }, before);
});

test('autoplay and decode failures yield bounded manual fallback and never retry', async () => {
  for (const event of ['autoplay', 'decode', 'promise']) {
    const f = playback(), pending = f.owner.play(f.input), element = f.instances[0];
    const rejected = assert.rejects(pending, event === 'autoplay' ? /voice_playback_blocked/ : /voice_playback_failed/);
    if (event === 'decode') element.emit('error', { message: 'private decoder detail' });
    else element.gate.reject(Object.assign(new Error('private rejection'), { name: event === 'autoplay' ? 'NotAllowedError' : 'AbortError' }));
    await rejected; assert.equal(f.owner.snapshot().manualFallback, true); assert.equal(element.plays, 1);
    assert.equal(f.objects.size, 0); assert.equal(element.count(), 0); assert.equal(f.clock.scheduled.size, 0);
  }
});

test('synchronous play failure still releases URL, listeners and timer', async () => {
  const f = playback({ audio: { playThrows: true } }); await assert.rejects(f.owner.play(f.input), /voice_playback_failed/);
  assert.equal(f.objects.size, 0); assert.equal(f.instances[0].count(), 0); assert.equal(f.clock.scheduled.size, 0);
});

test('current fence is checked after play await and at completion for account/expiry changes', async () => {
  for (const boundary of ['settlement', 'ended']) {
    const f = playback(), pending = f.owner.play(f.input), element = f.instances[0], rejected = assert.rejects(pending, /voice_audio_stale/);
    f.invalidate(); if (boundary === 'settlement') element.gate.resolve(); else element.emit('ended');
    await rejected; assert.equal(element.playing, false); assert.equal(f.objects.size, 0); assert.equal(element.count(), 0);
  }
});

test('technical playback duration stops unresolved play promises with bounded cleanup', async () => {
  const f = playback(), pending = f.owner.play(f.input), rejected = assert.rejects(pending, /voice_playback_duration_limit/);
  f.clock.set(2000); f.clock.fire(); await rejected;
  assert.equal(f.instances[0].playing, false); assert.equal(f.objects.size, 0); assert.equal(f.clock.scheduled.size, 0);
  f.instances[0].gate.resolve(); await flush(); assert.equal(f.instances[0].plays, 1);
});

test('wrong-fence stop cannot silence current playback; concurrent operation rejects', async () => {
  const f = playback(), first = f.owner.play(f.input), rejected = assert.rejects(first, /voice_audio_aborted/);
  await assert.rejects(f.owner.play(f.input), /voice_playback_busy/);
  await assert.rejects(f.owner.stop({ ...fence, generation: 99 }), /voice_audio_fence_mismatch/);
  assert.equal(f.instances[0].playing, true); assert.equal(f.objects.size, 1);
  await f.owner.stop(fence); await rejected; assert.equal(f.objects.size, 0);
});

test('late old play promise cannot mutate a subsequent explicitly started element', async () => {
  const f = playback(), first = f.owner.play(f.input), rejected = assert.rejects(first, /voice_audio_aborted/), old = f.instances[0];
  await f.owner.stop(fence); await rejected;
  const second = f.owner.play(f.input), current = f.instances[1]; old.gate.resolve(); await flush();
  assert.equal(current.playing, true); assert.equal(current.pauses, 0); assert.equal(current.plays, 1); assert.equal(f.objects.size, 1);
  current.emit('ended'); await second; assert.equal(f.objects.size, 0);
});

test('failed local playback cleanup attempts all other releases, retains hold and never auto-retries', async () => {
  const f = playback({ audio: { pauseThrows: true } }), pending = f.owner.play(f.input);
  const rejected = assert.rejects(pending, /voice_playback_cleanup_incomplete/);
  await assert.rejects(f.owner.stop(fence), /voice_playback_cleanup_incomplete/); await rejected;
  assert.equal(f.instances[0].src, null); assert.equal(f.instances[0].count(), 0); assert.equal(f.objects.size, 0);
  assert.equal(f.owner.snapshot().cleanup, 'incomplete');
  await assert.rejects(f.owner.play(f.input), /voice_playback_busy/); assert.equal(f.instances[0].pauses, 1);
});

test('playback disposal aborts once, releases resources and permanently rejects new work', async () => {
  const f = playback(), pending = f.owner.play(f.input), rejected = assert.rejects(pending, /voice_audio_aborted/);
  await f.owner.dispose(); await rejected; await f.owner.dispose();
  assert.equal(f.instances[0].pauses, 1); assert.equal(f.objects.size, 0); assert.equal(f.clock.scheduled.size, 0);
  await assert.rejects(f.owner.play(f.input), /voice_playback_disposed/);
});

test('playback terminal cleanup removes the exact owned abort listener', async () => {
  const f = playback(), signal = new Target(); signal.aborted = false;
  const pending = f.owner.play({ ...f.input, signal }); assert.equal(signal.count(), 1);
  f.instances[0].emit('ended'); await pending; assert.equal(signal.count(), 0);
});
