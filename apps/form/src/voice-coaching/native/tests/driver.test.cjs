const test = require('node:test');
const assert = require('node:assert/strict');
const { createFormVoiceDriver, validateVoiceLimits } = require('../driver.ts');

const limits = { maxCaptureBytes: 3244, maxCaptureDurationMs: 100, maxPlaybackBytes: 4096, sampleRate: 16000 };
const providerBounds = { maxAudioBytes: 10485760, maxSpeechBytes: 5242880 };
const originalFence = { accountId: 'account-a', authSessionId: 'auth-a', accountEpoch: 1, generation: 1 };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function wave(rate = 16000, frames = 8) {
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
    [...text].forEach((char, i) => { bytes[offset + i] = char.charCodeAt(0); });
  }
  for (const [offset, value] of [[4, bytes.length - 8], [16, 16], [24, rate], [28, rate * 2], [40, frames * 2]]) {
    view.setUint32(offset, value, true);
  }
  for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(offset, value, true);
  return bytes;
}
function fixture(overrides = {}, config = {}) {
  const calls = [], events = [];
  let listener, nextId = 0, current = true;
  const native = {
    availability: async () => { calls.push(['availability']); return { available: true, reason: 'available', permission: 'granted' }; },
    requestPermission: async () => { calls.push(['permission']); return 'granted'; },
    openLease: async (id, fence) => { calls.push(['open', id, fence]); },
    startCapture: async (id, value) => { calls.push(['start', id, value]); },
    finishCapture: async id => { calls.push(['finish', id]); return wave(); },
    playWav: async (id, bytes) => { calls.push(['play', id, bytes]); },
    ...Object.fromEntries(['stopCapture', 'stopPlayback', 'deactivateAudio', 'release'].map(name => [name, async id => { calls.push([name, id]); }])),
    addListener: (name, callback) => { assert.equal(name, 'onInvalidated'); listener = callback; return { remove: () => { listener = undefined; } }; },
    ...overrides,
  };
  const driver = createFormVoiceDriver({
    binding: { module: native }, limits, providerBounds, sharedOwnershipReady: true, nativeQualified: true,
    newLeaseId: () => `lease-${++nextId}`,
    assertCurrent: fence => { assert.deepEqual(fence, originalFence); if (!current) throw new Error('stale'); },
    onInvalidated: (fence, reason) => { events.push({ fence, reason }); },
    ...config,
  });
  const acquire = (abort = new AbortController(), fence = { ...originalFence }) => driver.micOwner.acquire({ mode: 'standard', fence, signal: abort.signal });
  return { driver, native, calls, events, acquire, emit: event => listener?.(event), stale: () => { current = false; } };
}
const cleanupNames = calls => calls.map(call => call[0]).filter(name => ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release'].includes(name));

test('limits count the full header and require explicit compatible provider bounds', () => {
  const result = validateVoiceLimits(limits, providerBounds);
  assert.deepEqual(result, limits);
  assert.ok(Object.isFrozen(result));
  assert.equal(validateVoiceLimits({ ...limits, maxCaptureBytes: 4844, sampleRate: 24000 }, providerBounds).sampleRate, 24000);
  for (const invalid of [
    { maxCaptureBytes: 3243 }, { maxCaptureBytes: 3242 }, { maxCaptureBytes: 44 },
    { maxCaptureDurationMs: 101 }, { maxCaptureDurationMs: 0 }, { maxCaptureDurationMs: Number.MAX_SAFE_INTEGER },
    { maxCaptureDurationMs: NaN }, { sampleRate: 48000 }, { maxPlaybackBytes: 5242881 },
    { maxPlaybackBytes: 0 }, { maxPlaybackBytes: 3.5 }, { maxCaptureBytes: 10485762 },
  ]) assert.throws(() => validateVoiceLimits({ ...limits, ...invalid }, providerBounds), /voice_limits/);
  assert.throws(() => validateVoiceLimits(limits, { ...providerBounds, maxAudioBytes: 25000001 }), /voice_limits/);
  assert.throws(() => validateVoiceLimits(limits, { ...providerBounds, maxSpeechBytes: undefined }), /voice_limits/);
});

test('shared ownership and native qualification default to unavailable before any native operation', async () => {
  for (const [config, reason] of [
    [{ sharedOwnershipReady: undefined }, 'shared_ownership_unready'],
    [{ nativeQualified: undefined }, 'native_unqualified'],
    [{ binding: { module: null, reason: 'native_module_missing' } }, 'native_module_missing'],
  ]) {
    const f = fixture({}, config);
    assert.equal((await f.driver.availability()).reason, reason);
    await assert.rejects(f.acquire(), new RegExp(reason));
    await assert.rejects(f.driver.requestPermission(), new RegExp(reason));
    assert.deepEqual(f.calls, []);
    await f.driver.dispose();
  }
});

test('denied permission and unsupported modes cannot open a native lease', async () => {
  const f = fixture({ availability: async () => ({ available: false, reason: 'permission_denied', permission: 'denied' }) });
  await assert.rejects(f.acquire(), /permission_denied/);
  await assert.rejects(f.driver.micOwner.acquire({ mode: 'realtime', fence: originalFence, signal: new AbortController().signal }), /mode_unsupported/);
  assert.deepEqual(f.calls, []);
  await f.driver.dispose();
});

test('abort during open awaits the late native lease and releases it exactly once', async () => {
  const opened = deferred(), entered = deferred();
  const f = fixture({ openLease: (id, fence) => { f.calls.push(['open', id, fence]); entered.resolve(); return opened.promise; } });
  const abort = new AbortController();
  const rejected = assert.rejects(f.acquire(abort), /acquisition_failed/);
  await entered.promise;
  abort.abort();
  assert.deepEqual(cleanupNames(f.calls), []);
  opened.resolve();
  await rejected;
  assert.deepEqual(cleanupNames(f.calls), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
  assert.equal(f.calls.filter(call => call[0] === 'open').length, 1);
  await f.driver.dispose();
});

test('the frozen original fence survives caller mutation and account invalidation after open', async () => {
  const opened = deferred(), entered = deferred();
  const f = fixture({ openLease: (id, fence) => { f.calls.push(['open', id, fence]); entered.resolve(); return opened.promise; } });
  const input = { ...originalFence };
  const rejected = assert.rejects(f.acquire(new AbortController(), input), /acquisition_failed/);
  await entered.promise;
  input.accountId = 'account-b';
  f.stale(); opened.resolve();
  await rejected;
  const received = f.calls.find(call => call[0] === 'open')[2];
  assert.ok(Object.isFrozen(received));
  assert.deepEqual(received, originalFence);
  assert.deepEqual(cleanupNames(f.calls), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
  await f.driver.dispose();
});

test('capture returns a validated PCM16 WAV Blob through the original active lease', async () => {
  const f = fixture();
  await f.acquire();
  await f.driver.capture.start(originalFence);
  const config = f.calls.find(call => call[0] === 'start')[2];
  assert.ok(Object.isFrozen(config));
  assert.deepEqual(config, limits);
  const blob = await f.driver.capture.finish(originalFence);
  assert.equal(blob.type, 'audio/wav');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), wave());
  await f.driver.dispose();
});

test('capture finishing after cancellation never returns its audio', async () => {
  const finished = deferred(), entered = deferred();
  const f = fixture({ finishCapture: () => { entered.resolve(); return finished.promise; } });
  const abort = new AbortController();
  await f.acquire(abort);
  await f.driver.capture.start(originalFence);
  const rejected = assert.rejects(f.driver.capture.finish(originalFence), /operation_failed/);
  await entered.promise;
  abort.abort();
  await f.driver.dispose();
  finished.resolve(wave());
  await rejected;
  assert.deepEqual(cleanupNames(f.calls), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
});

test('invalid capture bytes are discarded and cleanup runs', async () => {
  for (const bytes of [wave(24000), wave(16000, 1601), new Uint8Array(46)]) {
    const f = fixture({ finishCapture: async () => bytes });
    await f.acquire(); await f.driver.capture.start(originalFence);
    await assert.rejects(f.driver.capture.finish(originalFence), /operation_failed/);
    await f.driver.dispose();
    assert.deepEqual(cleanupNames(f.calls), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
  }
});

test('playback awaits actual completion and accepts a different provider WAV sample rate', async () => {
  const played = deferred(), entered = deferred();
  const f = fixture({ playWav: (id, bytes) => { f.calls.push(['play', id, bytes]); entered.resolve(); return played.promise; } });
  await f.acquire();
  let done = false;
  const task = f.driver.playback.play(originalFence, new Blob([wave(48000)], { type: 'audio/wav' })).then(() => { done = true; });
  await entered.promise;
  assert.equal(done, false);
  await assert.rejects(f.driver.capture.start(originalFence), /native_busy/);
  played.resolve(); await task;
  assert.equal(done, true);
  assert.deepEqual(f.calls.find(call => call[0] === 'play')[2], wave(48000));
  await f.driver.dispose();
});

test('cancel while reading playback bytes prevents native playback dispatch', async () => {
  const bytes = deferred(), entered = deferred();
  const f = fixture();
  const abort = new AbortController();
  await f.acquire(abort);
  const blob = { size: wave().length, arrayBuffer: () => { entered.resolve(); return bytes.promise; } };
  const rejected = assert.rejects(f.driver.playback.play(originalFence, blob), /operation_failed/);
  await entered.promise; abort.abort();
  await f.driver.dispose();
  bytes.resolve(wave().buffer); await rejected;
  assert.equal(f.calls.some(call => call[0] === 'play'), false);
});

test('playback rejects an oversized Blob before reading its bytes', async () => {
  const f = fixture(); await f.acquire();
  let read = false;
  await assert.rejects(f.driver.playback.play(originalFence, {
    size: limits.maxPlaybackBytes + 1,
    arrayBuffer: () => { read = true; throw new Error('must not read'); },
  }), /playback_too_large/);
  assert.equal(read, false);
  await f.driver.dispose();
});

test('native invalidation uses the exact lease and never resumes capture', async () => {
  const f = fixture(); await f.acquire();
  f.emit({ leaseId: 'old-lease', reason: 'background' });
  assert.deepEqual(f.events, []);
  await f.driver.capture.start(originalFence);
  f.emit({ leaseId: 'lease-1', reason: 'capture_limit' });
  await assert.rejects(f.driver.capture.finish(originalFence), /lease_stale/);
  await f.driver.dispose();
  assert.deepEqual(f.events, [{ fence: originalFence, reason: 'capture_limit' }]);
  assert.ok(Object.isFrozen(f.events[0].fence));
  assert.deepEqual(cleanupNames(f.calls), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
  assert.equal(f.calls.filter(call => call[0] === 'open').length, 1);
});

test('failed cleanup still attempts every step and keeps the lease unavailable', async () => {
  const f = fixture({ stopCapture: async id => { f.calls.push(['stopCapture', id]); throw new Error('native stop failed'); } });
  await f.acquire();
  f.emit({ leaseId: 'lease-1', reason: 'route_changed' });
  await assert.rejects(f.driver.dispose(), /cleanup_incomplete/);
  assert.deepEqual(cleanupNames(f.calls), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
  await assert.rejects(f.acquire(), /native_busy/);
  assert.equal(f.calls.filter(call => call[0] === 'open').length, 1);
});

test('failed native open has uncertain effect and receives all cleanup attempts', async () => {
  const f = fixture({ openLease: async () => { throw new Error('native open rejected after creating lease'); } });
  await assert.rejects(f.acquire(), /acquisition_failed/);
  assert.deepEqual(cleanupNames(f.calls), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
  await f.driver.dispose();
});

test('a lease is not reusable until asynchronous native deactivation and release finish', async () => {
  const deactivated = deferred(), deactivationEntered = deferred(), released = deferred(), releaseEntered = deferred();
  const f = fixture({
    deactivateAudio: id => { f.calls.push(['deactivateAudio', id]); deactivationEntered.resolve(); return deactivated.promise; },
    release: id => { f.calls.push(['release', id]); releaseEntered.resolve(); return released.promise; },
  });
  const lease = await f.acquire();
  await Promise.all([lease.stopCapture('user_stop'), lease.stopPlayback('user_stop')]);
  const deactivation = lease.deactivateAudio('user_stop');
  await deactivationEntered.promise;
  await assert.rejects(f.acquire(), /native_busy/);
  assert.equal(f.calls.some(call => call[0] === 'release'), false);
  deactivated.resolve(); await deactivation;
  const release = lease.release('user_stop');
  await releaseEntered.promise;
  await assert.rejects(f.acquire(), /native_busy/);
  released.resolve(); await release;
  await f.acquire();
  await f.driver.dispose();
  assert.equal(f.calls.filter(call => call[0] === 'open').length, 2);
});
