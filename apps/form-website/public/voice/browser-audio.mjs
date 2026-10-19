import { BrowserVoiceError, sameFence, validAccount } from './mic-owner.mjs';

const HARD_BYTES = 25_000_000;
const MAX_TIMER_MS = 2_147_483_647;
const fail = code => new BrowserVoiceError(code);
const positiveBytes = value => Number.isSafeInteger(value) && value > 0 && value <= HARD_BYTES;
const positiveTime = value => Number.isFinite(value) && value > 0 && value <= MAX_TIMER_MS;
const webm = value => typeof value === 'string' && !/[\r\n\0]/.test(value) && value.split(';')[0].trim().toLowerCase() === 'audio/webm';
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  // A terminal event may precede finish/cancel; callers still receive the original rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function context({ fence, signal, assertCurrent } = {}) {
  if (!validAccount(fence) || !Number.isSafeInteger(fence.generation) || fence.generation < 1 ||
      typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function' ||
      typeof assertCurrent !== 'function') throw fail('voice_audio_context_invalid');
  const bound = Object.freeze({ accountId: fence.accountId, authSessionId: fence.authSessionId,
    accountEpoch: fence.accountEpoch, generation: fence.generation });
  return { fence: bound, signal, check() {
    if (signal.aborted) throw fail('voice_audio_aborted');
    try { assertCurrent(bound); } catch { throw fail('voice_audio_stale'); }
    if (signal.aborted) throw fail('voice_audio_aborted');
  } };
}
function addListener(record, target, name, listener) {
  record.listeners.push(() => target.removeEventListener(name, listener));
  target.addEventListener(name, listener);
}
function removeListeners(record) {
  let complete = true;
  for (const remove of record.listeners) { try { remove(); } catch { complete = false; } }
  record.listeners = [];
  return complete;
}

export function createBrowserRecorder({ mimeType, format, maxAudioBytes = 10 * 1024 * 1024,
  maxDurationMs, stopTimeoutMs, timesliceMs = 250, MediaRecorderImpl = globalThis.MediaRecorder,
  BlobImpl = globalThis.Blob, now = Date.now, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  if (!webm(mimeType) || format !== 'webm' || !positiveBytes(maxAudioBytes) ||
      ![maxDurationMs, stopTimeoutMs, timesliceMs].every(positiveTime) ||
      [BlobImpl, now, setTimer, clearTimer].some(value => typeof value !== 'function')) throw fail('voice_recording_config_invalid');
  let active = null, last = null, disposed = false;
  const snapshot = () => Object.freeze({ status: disposed ? 'disposed' : last?.phase ?? 'idle',
    error: last?.error ?? null, cleanup: last?.cleanup ?? 'none' });

  function start(input) {
    if (disposed) throw fail('voice_recording_disposed');
    if (active) throw fail('voice_recording_busy');
    const scope = context(input);
    scope.check();
    let supported = false;
    try { supported = typeof MediaRecorderImpl === 'function' && MediaRecorderImpl.isTypeSupported(mimeType) === true; } catch {}
    if (!supported) throw fail('voice_recording_unavailable');
    const tracks = input.stream?.getTracks?.();
    if (!Array.isArray(tracks) || !tracks.length || tracks.some(track => track.kind !== 'audio' || track.readyState !== 'live')) {
      throw fail('voice_recording_stream_invalid');
    }
    const record = { scope, phase: 'recording', error: null, cleanup: 'pending', listeners: [], recorder: null,
      durationTimer: null, stopTimer: null, startedAt: now(), started: false, stopping: false, terminal: false,
      discarded: false, cleanupFailed: false, chunks: [], bytes: 0, result: deferred(), closed: deferred() };
    active = last = record;

    function checkRecording() {
      scope.check();
      if (!record.stopping && now() - record.startedAt >= maxDurationMs) throw fail('voice_recording_duration_limit');
    }

    function clear(name) {
      if (record[name] === null) return true;
      const timer = record[name]; record[name] = null;
      try { clearTimer(timer); return true; } catch { return false; }
    }
    function terminal(complete, output) {
      if (record.terminal) return;
      record.terminal = true;
      complete = !record.cleanupFailed && complete;
      complete = clear('durationTimer') && complete;
      complete = clear('stopTimer') && complete;
      complete = removeListeners(record) && complete;
      record.chunks = [];
      record.cleanup = complete ? 'released' : 'incomplete';
      record.phase = complete && !record.error ? 'finished' : 'failed';
      if (!complete) record.error = 'voice_recording_cleanup_incomplete';
      if (complete && active === record) active = null;
      if (complete) record.closed.resolve(); else record.closed.reject(fail('voice_recording_cleanup_incomplete'));
      if (record.error) record.result.reject(fail(record.error));
      else {
        try { scope.check(); record.result.resolve(output); }
        catch (error) { record.error = error.code; record.phase = 'failed'; record.result.reject(error); }
      }
    }
    function discard(code) {
      if (record.terminal) return;
      record.discarded = true; record.error ??= code; record.chunks = [];
      record.result.reject(fail(record.error));
      requestStop();
    }
    function requestStop() {
      if (record.terminal || record.stopping) return;
      record.stopping = true;
      record.phase = record.discarded ? 'cancelling' : 'finishing';
      if (!clear('durationTimer')) record.cleanupFailed = true;
      if (!record.started) { terminal(true); return; }
      // stop() changes state before its final data and stop events; inactive alone is not completion.
      try { record.stopTimer = setTimer(() => { record.stopTimer = null; terminal(false); }, stopTimeoutMs); }
      catch { record.cleanupFailed = true; }
      try { if (record.recorder.state !== 'inactive') record.recorder.stop(); }
      catch { terminal(false); return; }
      if (record.stopTimer === null && !record.terminal) terminal(false);
    }
    function onData(event) {
      if (record.terminal || record.discarded) return;
      try {
        checkRecording();
        const data = event.data;
        if (!(data instanceof BlobImpl)) throw fail('voice_recording_data_invalid');
        if (!data.size) return;
        if (!webm(record.recorder.mimeType) || !webm(data.type)) throw fail('voice_recording_mime_mismatch');
        if (data.size > maxAudioBytes - record.bytes) throw fail('voice_recording_byte_limit');
        record.bytes += data.size; record.chunks.push(data);
      } catch (error) { discard(error instanceof BrowserVoiceError ? error.code : 'voice_recording_failed'); }
    }
    function onStop() {
      if (record.terminal) return;
      if (record.recorder.state !== 'inactive') { terminal(false); return; }
      if (record.discarded) { terminal(true); return; }
      try {
        checkRecording();
        if (!webm(record.recorder.mimeType)) throw fail('voice_recording_mime_mismatch');
        if (!record.bytes) throw fail('voice_recording_empty');
        const output = new BlobImpl(record.chunks, { type: record.recorder.mimeType });
        if (output.size !== record.bytes || output.size > maxAudioBytes) throw fail('voice_recording_byte_limit');
        scope.check();
        terminal(true, Object.freeze({ audio: output, format: 'webm' }));
      } catch (error) {
        record.error = error instanceof BrowserVoiceError ? error.code : 'voice_recording_failed'; terminal(true);
      }
    }
    const cancel = () => { discard('voice_audio_aborted'); return record.closed.promise; };
    const handle = Object.freeze({ result: record.result.promise,
      async finish() {
        if (!record.terminal) {
          try { checkRecording(); requestStop(); } catch (error) { discard(error.code ?? 'voice_audio_stale'); }
        }
        const result = await record.result.promise;
        scope.check();
        return result;
      }, cancel, dispose: cancel,
      snapshot: () => Object.freeze({ status: record.phase, error: record.error, cleanup: record.cleanup }) });
    record.cancel = cancel;
    try {
      scope.check();
      record.recorder = new MediaRecorderImpl(input.stream, { mimeType });
      if (!webm(record.recorder.mimeType)) throw fail('voice_recording_mime_mismatch');
      addListener(record, record.recorder, 'dataavailable', onData);
      addListener(record, record.recorder, 'stop', onStop);
      addListener(record, record.recorder, 'error', () => discard('voice_recording_failed'));
      addListener(record, scope.signal, 'abort', () => { void cancel().catch(() => {}); });
      scope.check();
      record.durationTimer = setTimer(() => { record.durationTimer = null; discard('voice_recording_duration_limit'); }, maxDurationMs);
      scope.check();
      if (record.terminal || record.discarded) throw fail('voice_audio_aborted');
      record.started = true;
      record.recorder.start(timesliceMs);
      scope.check();
    } catch (error) { discard(error instanceof BrowserVoiceError ? error.code : 'voice_recording_failed'); }
    return handle;
  }
  function dispose() {
    disposed = true;
    return active ? active.cancel() : Promise.resolve();
  }
  return Object.freeze({ start, dispose, snapshot });
}

function validateWav(speech, maximum) {
  if (speech?.mediaType !== 'audio/wav' || !(speech.audio instanceof Uint8Array) ||
      !speech.audio.byteLength || speech.audio.byteLength > maximum) throw fail('voice_playback_input_invalid');
  const bytes = new Uint8Array(speech.audio);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw fail('voice_playback_wav_invalid');
  }
  let offset = 12, format = false, data = false;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) throw fail('voice_playback_wav_invalid');
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size, paddedEnd = end + size % 2;
    if (paddedEnd > bytes.byteLength) throw fail('voice_playback_wav_invalid');
    if (tag(offset) === 'fmt ') {
      if (size < 16 || view.getUint16(offset + 10, true) === 0 || view.getUint32(offset + 12, true) === 0) {
        throw fail('voice_playback_wav_invalid');
      }
      format = true;
    }
    if (tag(offset) === 'data' && size > 0) data = true;
    offset = paddedEnd;
  }
  if (!format || !data) throw fail('voice_playback_wav_invalid');
  return bytes;
}

export function createBrowserSpeechPlayback({ maxSpeechBytes = 5 * 1024 * 1024, maxDurationMs,
  createAudio = () => new globalThis.Audio(), url = globalThis.URL, BlobImpl = globalThis.Blob,
  now = Date.now, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  if (!positiveBytes(maxSpeechBytes) || !positiveTime(maxDurationMs) ||
      [createAudio, BlobImpl, now, setTimer, clearTimer].some(value => typeof value !== 'function') ||
      typeof url?.createObjectURL !== 'function' || typeof url?.revokeObjectURL !== 'function') throw fail('voice_playback_config_invalid');
  let active = null, last = null, disposed = false;
  const snapshot = () => Object.freeze({ status: disposed ? 'disposed' : last?.phase ?? 'idle',
    error: last?.error ?? null, cleanup: last?.cleanup ?? 'none', manualFallback: Boolean(last?.error) });

  function play(input) {
    if (disposed) return Promise.reject(fail('voice_playback_disposed'));
    if (active) return Promise.reject(fail('voice_playback_busy'));
    let scope, bytes;
    try { scope = context(input); scope.check(); bytes = validateWav(input.speech, maxSpeechBytes); scope.check(); }
    catch (error) { return Promise.reject(error); }
    const record = { scope, phase: 'playing', error: null, cleanup: 'pending', listeners: [], audio: null,
      objectURL: null, timer: null, startedAt: now(), terminal: false, result: deferred(), closed: deferred() };
    active = last = record;

    function silence() {
      let complete = true;
      if (record.audio) {
        for (const effect of [() => record.audio.pause(), () => record.audio.removeAttribute('src'), () => record.audio.load()]) {
          try { effect(); } catch { complete = false; }
        }
      }
      return complete;
    }
    function finish(code = null) {
      if (record.terminal) return record.closed.promise;
      record.terminal = true;
      record.error = code;
      let complete = silence();
      complete = removeListeners(record) && complete;
      if (record.timer !== null) {
        try { clearTimer(record.timer); } catch { complete = false; }
        record.timer = null;
      }
      if (record.objectURL !== null) {
        try { url.revokeObjectURL(record.objectURL); } catch { complete = false; }
        record.objectURL = null;
      }
      record.cleanup = complete ? 'released' : 'incomplete';
      if (!complete) record.error = 'voice_playback_cleanup_incomplete';
      if (complete && !record.error) {
        try { scope.check(); } catch (error) { record.error = error.code; }
      }
      record.phase = record.error ? 'failed' : 'finished';
      if (complete && active === record) active = null;
      if (complete) record.closed.resolve(); else record.closed.reject(fail('voice_playback_cleanup_incomplete'));
      if (record.error) record.result.reject(fail(record.error)); else record.result.resolve();
      return record.closed.promise;
    }
    record.finish = finish;
    const onEnded = () => {
      if (record.terminal) return;
      try { scope.check(); if (now() - record.startedAt >= maxDurationMs) throw fail('voice_playback_duration_limit'); }
      catch (error) { void finish(error.code ?? 'voice_audio_stale'); return; }
      void finish();
    };
    try {
      scope.check(); record.audio = createAudio(); scope.check();
      addListener(record, record.audio, 'ended', onEnded);
      addListener(record, record.audio, 'error', () => { void finish('voice_playback_failed'); });
      addListener(record, scope.signal, 'abort', () => { void finish('voice_audio_aborted'); });
      scope.check();
      record.objectURL = url.createObjectURL(new BlobImpl([bytes], { type: 'audio/wav' }));
      scope.check(); record.audio.src = record.objectURL;
      scope.check();
      record.timer = setTimer(() => { record.timer = null; void finish('voice_playback_duration_limit'); }, maxDurationMs);
      scope.check();
      Promise.resolve(record.audio.play()).then(() => {
        // Settlement is notification only; it never replays or restores a disposed element.
        if (record.terminal) return;
        try { scope.check(); if (now() - record.startedAt >= maxDurationMs) throw fail('voice_playback_duration_limit'); }
        catch (error) { void finish(error.code ?? 'voice_audio_stale'); }
      }, error => { if (!record.terminal) void finish(error?.name === 'NotAllowedError' ? 'voice_playback_blocked' : 'voice_playback_failed'); });
    } catch (error) { void finish(error instanceof BrowserVoiceError ? error.code : 'voice_playback_failed'); }
    return record.result.promise;
  }
  function stop(fence) {
    const record = active ?? last;
    if (!record) return Promise.resolve();
    if (!sameFence(record.scope.fence, fence)) return Promise.reject(fail('voice_audio_fence_mismatch'));
    return record.finish('voice_audio_aborted');
  }
  function dispose() {
    disposed = true;
    return active ? active.finish('voice_audio_aborted') : Promise.resolve();
  }
  return Object.freeze({ play, stop, dispose, snapshot });
}
