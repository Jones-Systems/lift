const test = require('node:test');
const assert = require('node:assert/strict');
const { createDictationDriver } = require('../dictation-driver.ts');
const { ExclusiveMicOwner, VoiceSessionController } = require('../../session-controller.ts');

const fence = { accountId: 'account-a', authSessionId: 'auth-a', accountEpoch: 1, generation: 1 };
const request = { sessionId: 'speech-1', locale: 'en-US' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}, assertCurrent = value => { assert.deepEqual(value, fence); }) {
  const calls = [];
  const port = {
    start: async input => { calls.push(['start', input]); },
    stop: async id => { calls.push(['stop', id]); },
    cancel: async id => { calls.push(['cancel', id]); },
    ...overrides,
  };
  const driver = createDictationDriver({ port, assertCurrent });
  const acquire = (abort = new AbortController(), value = { ...fence }) => driver.micOwner.acquire({ mode: 'dictation', fence: value, signal: abort.signal });
  return { driver, calls, acquire };
}
async function release(lease) {
  await Promise.all([lease.stopCapture('user_stop'), lease.stopPlayback('user_stop')]);
  await lease.deactivateAudio('user_stop');
  await lease.release('user_stop');
}

test('inert acquisition and pre-start cancellation have no native effects', async () => {
  const f = fixture(), abort = new AbortController();
  const lease = await f.acquire(abort);
  assert.deepEqual(f.calls, []);
  abort.abort();
  await assert.rejects(f.driver.start(fence, request), /start_failed/);
  await release(lease);
  assert.deepEqual(f.calls, []);
  const next = await f.acquire();
  await release(next);
});

test('an already aborted inert reservation still supplies cleanup proof to its shared caller', async () => {
  const f = fixture(), abort = new AbortController();
  abort.abort();
  const lease = await f.acquire(abort);
  await release(lease);
  assert.deepEqual(f.calls, []);
});

test('start captures the original frozen fence and session ID across awaits', async () => {
  const started = deferred();
  const f = fixture({ start: input => { f.calls.push(['start', input]); return started.promise; } });
  const inputFence = { ...fence }, input = { ...request };
  const lease = await f.acquire(new AbortController(), inputFence);
  inputFence.accountId = 'account-b';
  const task = f.driver.start(fence, input);
  input.sessionId = 'speech-other'; input.locale = 'fr-FR';
  const captured = f.calls[0][1];
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.fence));
  assert.deepEqual(captured.fence, fence);
  assert.equal(captured.sessionId, 'speech-1');
  assert.equal(captured.locale, 'en-US');
  started.resolve(); await task;
  await release(lease);
  assert.deepEqual(f.calls.slice(1), [['cancel', 'speech-1']]);
});

test('cancellation immediately cancels a pending start and awaits late cleanup before release', async () => {
  const started = deferred(), cancelledLate = deferred(), lateEntered = deferred();
  let cancellations = 0;
  const f = fixture({
    start: input => { f.calls.push(['start', input]); return started.promise; },
    cancel: id => {
      f.calls.push(['cancel', id]);
      if (++cancellations === 2) { lateEntered.resolve(); return cancelledLate.promise; }
      return Promise.resolve();
    },
  });
  const abort = new AbortController(), lease = await f.acquire(abort);
  const rejected = assert.rejects(f.driver.start(fence, request), /start_failed/);
  abort.abort();
  assert.deepEqual(f.calls.map(call => call[0]), ['start', 'cancel']);
  let released = false;
  const closing = release(lease).then(() => { released = true; });
  started.resolve(); await lateEntered.promise;
  assert.equal(released, false);
  await assert.rejects(f.acquire(), /busy/);
  cancelledLate.resolve(); await Promise.all([closing, rejected]);
  assert.deepEqual(f.calls.slice(1), [['cancel', 'speech-1'], ['cancel', 'speech-1']]);
  await release(await f.acquire());
});

test('port.start may synchronously cancel without releasing its late native creation early', async () => {
  const started = deferred(), abort = new AbortController();
  const f = fixture({ start: input => { f.calls.push(['start', input]); abort.abort(); return started.promise; } });
  const lease = await f.acquire(abort);
  const rejected = assert.rejects(f.driver.start(fence, request), /start_failed/);
  assert.deepEqual(f.calls.map(call => call[0]), ['start', 'cancel']);
  let released = false;
  const closing = release(lease).then(() => { released = true; });
  await Promise.resolve(); assert.equal(released, false);
  started.resolve(); await Promise.all([closing, rejected]);
  assert.deepEqual(f.calls.slice(1), [['cancel', 'speech-1'], ['cancel', 'speech-1']]);
});

test('reentrant cancellation from the fence assertion prevents native dispatch', async () => {
  const abort = new AbortController();
  const f = fixture({}, () => { abort.abort(); });
  const lease = await f.acquire(abort);
  await assert.rejects(f.driver.start(fence, request), /start_failed/);
  await release(lease);
  assert.deepEqual(f.calls, []);
});

test('native start failure is cleaned through the existing shared lease without poisoning acquisition', async () => {
  const f = fixture({ start: async () => { throw new Error('start failed after possible native effect'); } });
  const owner = new ExclusiveMicOwner(f.driver.micOwner);
  const controller = new VoiceSessionController(owner, () => {});
  const transport = { abortPending() {}, closeTransport() {}, requestServerStop: async () => {} };
  const start = () => controller.start({ mode: 'dictation', account: fence, signal: new AbortController().signal, transport });
  const first = await start();
  await assert.rejects(f.driver.start(first, request), /start_failed/);
  assert.equal((await controller.stop('failed').local).status, 'released');
  assert.deepEqual(f.calls, [['cancel', 'speech-1']]);
  const next = await start();
  assert.equal(next.generation, first.generation + 2);
  assert.equal((await controller.stop('user_stop').local).status, 'released');
});

test('failed cancellation is memoized and the shared owner retains its claim', async () => {
  const f = fixture({ cancel: async id => { f.calls.push(['cancel', id]); throw new Error('uncertain deactivation'); } });
  const owner = new ExclusiveMicOwner(f.driver.micOwner);
  const lease = await owner.acquire({ mode: 'dictation', fence, signal: new AbortController().signal });
  await f.driver.start(fence, request);
  const stopped = await Promise.allSettled([lease.stopCapture('user_stop'), lease.stopPlayback('user_stop')]);
  assert.deepEqual(stopped.map(item => item.status), ['rejected', 'rejected']);
  await assert.rejects(lease.deactivateAudio('user_stop'), /cleanup_incomplete/);
  await assert.rejects(lease.release('user_stop'), /cleanup_incomplete/);
  await assert.rejects(lease.release('user_stop'), /cleanup_incomplete/);
  await assert.rejects(owner.acquire({ mode: 'dictation', fence, signal: new AbortController().signal }), /microphone_busy/);
  assert.deepEqual(f.calls.slice(1), [['cancel', 'speech-1']]);
});

test('a synchronous cancel exception remains a failed cleanup promise', async () => {
  const f = fixture({ cancel: () => { throw new Error('cleanup failed'); } });
  const lease = await f.acquire(); await f.driver.start(fence, request);
  await assert.rejects(lease.stopCapture('user_stop'), /cleanup_incomplete/);
  await assert.rejects(lease.release('user_stop'), /cleanup_incomplete/);
  await assert.rejects(f.acquire(), /busy/);
});

test('stop for review awaits startup and native stop while retaining the lease', async () => {
  const started = deferred(), stopped = deferred(), stopEntered = deferred();
  const f = fixture({
    start: input => { f.calls.push(['start', input]); return started.promise; },
    stop: id => { f.calls.push(['stop', id]); stopEntered.resolve(); return stopped.promise; },
  });
  const lease = await f.acquire();
  const starting = f.driver.start(fence, request);
  let complete = false;
  const stopping = f.driver.stopForReview(fence).then(() => { complete = true; });
  assert.deepEqual(f.calls.map(call => call[0]), ['start']);
  started.resolve(); await stopEntered.promise; await starting;
  assert.equal(complete, false);
  await assert.rejects(f.acquire(), /busy/);
  stopped.resolve(); await stopping;
  await f.driver.stopForReview(fence);
  assert.deepEqual(f.calls.map(call => call[0]), ['start', 'stop']);
  await release(lease);
  assert.deepEqual(f.calls.slice(1), [['stop', 'speech-1'], ['cancel', 'speech-1']]);
});

test('reentrant cancellation inside port.stop awaits that operation before final disposal', async () => {
  const stopped = deferred(), stopEntered = deferred(), abort = new AbortController();
  const f = fixture({ stop: id => { f.calls.push(['stop', id]); abort.abort(); stopEntered.resolve(); return stopped.promise; } });
  const lease = await f.acquire(abort); await f.driver.start(fence, request);
  const rejected = assert.rejects(f.driver.stopForReview(fence), /finalization_failed/);
  await stopEntered.promise;
  assert.deepEqual(f.calls.map(call => call[0]), ['start', 'stop', 'cancel']);
  let released = false;
  const closing = release(lease).then(() => { released = true; });
  await Promise.resolve(); assert.equal(released, false);
  stopped.resolve(); await Promise.all([closing, rejected]);
  assert.deepEqual(f.calls.slice(1), [['stop', 'speech-1'], ['cancel', 'speech-1'], ['cancel', 'speech-1']]);
});

test('cancellation before a waiting review stop prevents that native stop from dispatching', async () => {
  const started = deferred(), abort = new AbortController();
  const f = fixture({ start: input => { f.calls.push(['start', input]); return started.promise; } });
  const lease = await f.acquire(abort);
  const starting = assert.rejects(f.driver.start(fence, request), /start_failed/);
  const stopping = assert.rejects(f.driver.stopForReview(fence), /finalization_failed/);
  abort.abort(); started.resolve();
  await Promise.all([release(lease), starting, stopping]);
  assert.deepEqual(f.calls.map(call => call[0]), ['start', 'cancel', 'cancel']);
});

test('account invalidation after native start cancels the original session', async () => {
  const started = deferred();
  let current = true;
  const f = fixture({ start: input => { f.calls.push(['start', input]); return started.promise; } }, () => {
    if (!current) throw new Error('account changed');
  });
  const lease = await f.acquire();
  const rejected = assert.rejects(f.driver.start(fence, request), /start_failed/);
  current = false; started.resolve(); await rejected;
  await release(lease);
  assert.deepEqual(f.calls.slice(1), [['cancel', 'speech-1']]);
});

test('old lease calls cannot cancel a newer session and repeated start never dispatches', async () => {
  const f = fixture();
  const old = await f.acquire(); await f.driver.start(fence, request);
  await assert.rejects(f.driver.start(fence, { ...request, sessionId: 'unexpected' }), /already_started/);
  await release(old);
  const next = await f.acquire();
  await f.driver.start(fence, { ...request, sessionId: 'speech-2' });
  const before = f.calls.length;
  await release(old);
  assert.equal(f.calls.length, before);
  await assert.rejects(f.driver.stopForReview({ ...fence, authSessionId: 'other' }), /lease_stale/);
  assert.equal(f.calls.length, before);
  await release(next);
  assert.deepEqual(f.calls.filter(call => call[0] === 'cancel'), [['cancel', 'speech-1'], ['cancel', 'speech-2']]);
});

test('a previously completed review stop does not succeed again after cancellation', async () => {
  const f = fixture(), abort = new AbortController();
  const lease = await f.acquire(abort);
  await f.driver.start(fence, request); await f.driver.stopForReview(fence);
  abort.abort();
  await assert.rejects(f.driver.stopForReview(fence), /finalization_failed/);
  await release(lease);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
});

test('invalid start input and a review stop without startup do not touch native state', async () => {
  const f = fixture(), lease = await f.acquire();
  await assert.rejects(f.driver.start(fence, { ...request, sessionId: '' }), /start_invalid/);
  await assert.rejects(f.driver.start(fence, { ...request, locale: 'x'.repeat(81) }), /start_invalid/);
  await assert.rejects(f.driver.stopForReview(fence), /not_started/);
  await release(lease);
  assert.deepEqual(f.calls, []);
});
