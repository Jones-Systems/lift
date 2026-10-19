import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserMicOwner } from '../../public/voice/mic-owner.mjs';
import { deferred, fence, track, stream, flush } from './fixtures.mjs';

function fixture(options = {}) {
  const capture = deferred(), abort = new AbortController(), calls = [];
  const mic = createBrowserMicOwner({ secureContext: true,
    mediaDevices: { getUserMedia: constraints => { calls.push(constraints); return capture.promise; } }, ...options });
  return { mic, capture, abort, calls, input: { mode: 'standard', fence, signal: abort.signal } };
}

test('capture is explicit, audio-only, fenced, and released exactly once', async () => {
  const f = fixture(), audio = track(), unexpectedVideo = track('video'), media = stream(audio, unexpectedVideo);
  assert.deepEqual(f.calls, []);
  const pending = f.mic.acquire(f.input);
  assert.deepEqual(f.calls, [{ audio: true, video: false }]); assert.equal(f.mic.snapshot().pendingPermission, true);
  f.capture.resolve(media); const lease = await pending;
  assert.deepEqual(lease.fence, fence); assert.equal(Object.isFrozen(lease.fence), true);
  assert.equal(f.mic.streamFor(fence), media);
  assert.throws(() => f.mic.streamFor({ ...fence, accountEpoch: 4 }), /voice_capture_stale/);
  await assert.rejects(f.mic.acquire(f.input), /voice_microphone_busy/);
  const stopping = lease.stopCapture('user_stop');
  assert.equal(audio.readyState, 'ended'); assert.equal(unexpectedVideo.readyState, 'ended');
  await stopping; await lease.release('user_stop'); await lease.release('user_stop');
  assert.equal(audio.stops, 1); assert.equal(unexpectedVideo.stops, 1);
  assert.equal(f.mic.snapshot().status, 'released'); assert.throws(() => f.mic.streamFor(fence), /voice_capture_stale/);
});

test('cancel during pending permission keeps one owner and disposes late tracks through the same lease', async () => {
  const f = fixture(), audio = track(); const pending = f.mic.acquire(f.input);
  f.abort.abort('navigation');
  assert.equal(f.mic.snapshot().status, 'cancelling'); assert.equal(f.mic.snapshot().pendingPermission, true);
  await assert.rejects(f.mic.acquire({ ...f.input, signal: new AbortController().signal }), /voice_microphone_busy/);
  f.capture.resolve(stream(audio)); const lease = await pending;
  assert.equal(audio.readyState, 'ended'); assert.equal(audio.stops, 1);
  assert.deepEqual(lease.fence, fence); assert.throws(() => f.mic.streamFor(fence), /voice_capture_stale/);
  await lease.release('aborted'); assert.equal(f.mic.snapshot().status, 'released');
});

test('cancel after grant stops tracks immediately and cleans injected playback/audio once', async () => {
  const calls = [], f = fixture({ stopPlayback: (bound, reason) => calls.push(['playback', bound, reason]),
    deactivateAudio: (bound, reason) => calls.push(['audio', bound, reason]) });
  const audio = track(), pending = f.mic.acquire(f.input); f.capture.resolve(stream(audio)); const lease = await pending;
  f.abort.abort(); assert.equal(audio.readyState, 'ended');
  await lease.release('aborted');
  assert.deepEqual(calls.map(call => call[0]), ['playback', 'audio']);
  assert.ok(calls.every(call => call[1] === lease.fence)); assert.equal(audio.stops, 1);
});

for (const [name, code] of [['NotAllowedError', 'voice_permission_denied'], ['SecurityError', 'voice_permission_denied'],
  ['NotFoundError', 'voice_microphone_unavailable'], ['OverconstrainedError', 'voice_microphone_unavailable'],
  ['NotReadableError', 'voice_capture_failed'], ['AbortError', 'voice_capture_interrupted']]) {
  test(`browser ${name} becomes bounded ${code} without native message leakage`, async () => {
    const f = fixture(), pending = f.mic.acquire(f.input);
    f.capture.reject(Object.assign(new Error('private device information'), { name }));
    await assert.rejects(pending, error => error.code === code && error.message === code);
    assert.deepEqual(f.mic.snapshot(), { status: 'error', pendingPermission: false, error: code });
  });
}

test('late rejection after cancel is handled and never claims an acquired stream', async () => {
  const f = fixture(), pending = f.mic.acquire(f.input), rejected = assert.rejects(pending, /voice_permission_denied/);
  f.abort.abort(); f.capture.reject(Object.assign(new Error(), { name: 'NotAllowedError' })); await rejected; await flush();
  assert.equal(f.mic.snapshot().pendingPermission, false); assert.equal(f.mic.snapshot().status, 'error');
});

test('unavailable/insecure/invalid/already-aborted requests do not call the browser', async () => {
  const insecure = fixture({ secureContext: false }); await assert.rejects(insecure.mic.acquire(insecure.input), /voice_secure_context_required/);
  assert.equal(insecure.calls.length, 0);
  const missing = fixture({ mediaDevices: {} }); await assert.rejects(missing.mic.acquire(missing.input), /voice_microphone_unavailable/);
  const invalid = fixture(); await assert.rejects(invalid.mic.acquire({ ...invalid.input, fence: { ...fence, authSessionId: '' } }), /voice_acquisition_invalid/);
  invalid.abort.abort(); await assert.rejects(invalid.mic.acquire(invalid.input), /voice_aborted/); assert.equal(invalid.calls.length, 0);
});

test('stop failures still attempt every track and playback/audio but preserve the ownership hold', async () => {
  const calls = [], f = fixture({ stopPlayback: () => { calls.push('playback'); throw new Error('output failure'); },
    deactivateAudio: () => calls.push('audio') });
  const failed = track('audio', { fail: true }), other = track(), pending = f.mic.acquire(f.input);
  f.capture.resolve(stream(failed, other)); const lease = await pending;
  await assert.rejects(lease.release('user_stop'), /voice_local_cleanup_incomplete/);
  assert.equal(other.readyState, 'ended'); assert.deepEqual(calls, ['playback', 'audio']);
  assert.equal(f.mic.snapshot().status, 'incomplete');
  await assert.rejects(f.mic.acquire({ ...f.input, signal: new AbortController().signal }), /voice_microphone_busy/);
});

test('empty/audio-ended streams cannot be consumed, and unexpected tracks are still stopped', async () => {
  const f = fixture(), video = track('video'), pending = f.mic.acquire(f.input);
  f.capture.resolve(stream(video)); const lease = await pending;
  assert.equal(video.readyState, 'ended'); assert.throws(() => f.mic.streamFor(fence), /voice_microphone_unavailable/);
  await lease.release('failed');
});

test('uninspectable stream preserves incomplete ownership instead of proving release', async () => {
  const f = fixture(), pending = f.mic.acquire(f.input);
  f.capture.resolve({ getTracks() { throw new Error('uninspectable'); } }); const lease = await pending;
  assert.throws(() => f.mic.streamFor(fence), /voice_capture_cleanup_failed/);
  await assert.rejects(lease.release('failed'), /voice_local_cleanup_incomplete/);
});

test('mutating the supplied fence cannot move ownership to another account', async () => {
  const f = fixture(), mutable = { ...fence }, pending = f.mic.acquire({ ...f.input, fence: mutable });
  mutable.accountId = 'other'; f.capture.resolve(stream(track())); const lease = await pending;
  assert.equal(lease.fence.accountId, fence.accountId); await lease.release('user_stop');
});
