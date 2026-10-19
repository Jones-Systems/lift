const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRealtimePeerSlot } = require('../peer-slot.ts');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fence = { accountId: 'fixture', authSessionId: 'original', accountEpoch: 1, generation: 3 };
function fixture() {
  const pending = deferred(), server = deferred(), calls = [];
  let active = true;
  const peer = {
    close(reason) { calls.push(['close', reason]); },
    stopPlayback(reason) { calls.push(['silence', reason]); },
    cancelResponse(id) { calls.push(['cancel', id]); },
    clearPlayback() { calls.push(['clear']); },
  };
  const slot = createRealtimePeerSlot({
    fence,
    isCurrent: captured => active && captured.authSessionId === 'original',
    connector: {
      connect(input) { calls.push(['connect', input]); return pending.promise; },
      abortPending(reason) { calls.push(['abort', reason]); },
      requestServerStop(reason) { calls.push(['server', reason]); return server.promise; },
    },
  });
  return { slot, pending, server, calls, peer, invalidate: () => { active = false; } };
}

test('a cancelled pending peer is disposed when it arrives; it never becomes active', async () => {
  const f = fixture();
  const connected = f.slot.connect();
  const input = f.calls[0][1];
  const cleanup = Promise.all([f.slot.abortPending('background'), f.slot.closeTransport('background')]);
  assert.equal(input.signal.aborted, true);
  assert.equal(input.isCurrent(), false);
  f.pending.resolve(f.peer);
  assert.equal(await connected, 'cancelled');
  await cleanup;
  await f.slot.settled();
  assert.deepEqual(f.calls.slice(1).map(c => c[0]), ['abort', 'silence', 'close']);
  assert.equal(f.slot.snapshot().connection, 'closed');
  assert.equal(await f.slot.connect(), 'cancelled');
});

test('changed account rejects and disposes a late connection using its original fence', async () => {
  const f = fixture();
  const connecting = f.slot.connect();
  assert.notEqual(f.calls[0][1].fence, fence);
  assert.equal(Object.isFrozen(f.calls[0][1].fence), true);
  f.invalidate();
  f.pending.resolve(f.peer);
  assert.equal(await connecting, 'cancelled');
  assert.equal(f.slot.snapshot().connection, 'closed');
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  assert.equal(f.slot.observe({ type: 'response.started', responseId: 'old' }), false);
});

test('buffered playback after response.done remains interruptible', async () => {
  const f = fixture();
  const connecting = f.slot.connect(); f.pending.resolve(f.peer); await connecting;
  f.slot.observe({ type: 'response.started', responseId: 'r1' });
  f.slot.observe({ type: 'playback.started', responseId: 'r1' });
  f.slot.observe({ type: 'response.done', responseId: 'r1' });
  assert.equal(f.slot.snapshot().generating, false);
  assert.equal(f.slot.snapshot().playing, true);
  assert.deepEqual(await f.slot.interrupt(), { attempted: true, failures: [] });
  assert.deepEqual(f.calls.slice(1).map(c => c[0]), ['silence', 'cancel', 'clear']);
  assert.equal((await f.slot.interrupt()).attempted, false);
  assert.equal(f.slot.observe({ type: 'playback.started', responseId: 'r1' }), false);
});

test('cancel failure cannot skip local silence or playback clear', async () => {
  const f = fixture();
  f.peer.cancelResponse = () => { throw new Error('synthetic'); };
  const connecting = f.slot.connect(); f.pending.resolve(f.peer); await connecting;
  f.slot.observe({ type: 'response.started', responseId: 'r1' });
  assert.deepEqual(await f.slot.interrupt(), { attempted: true, failures: ['cancelResponse'] });
  assert.deepEqual(f.calls.slice(1).map(c => c[0]), ['silence', 'clear']);
});

test('interruption retains its response target if local silence causes another response callback', async () => {
  const f = fixture();
  const connecting = f.slot.connect(); f.pending.resolve(f.peer); await connecting;
  f.slot.observe({ type: 'response.started', responseId: 'r1' });
  f.peer.stopPlayback = () => { f.slot.observe({ type: 'response.started', responseId: 'r2' }); };
  await f.slot.interrupt();
  assert.deepEqual(f.calls.find(c => c[0] === 'cancel'), ['cancel', 'r1']);
});

test('clear follows completed cancellation delivery while local silence starts immediately', async () => {
  const f = fixture(), cancellation = deferred();
  f.peer.cancelResponse = () => { f.calls.push(['cancel']); return cancellation.promise; };
  const connecting = f.slot.connect(); f.pending.resolve(f.peer); await connecting;
  f.slot.observe({ type: 'response.started', responseId: 'r1' });
  const interrupted = f.slot.interrupt();
  assert.deepEqual(f.calls.slice(1).map(c => c[0]), ['silence', 'cancel']);
  cancellation.resolve(); await interrupted;
  assert.deepEqual(f.calls.slice(1).map(c => c[0]), ['silence', 'cancel', 'clear']);
});

test('async peer cleanup is awaited and independent from a hanging server stop', async () => {
  const f = fixture(), closing = deferred();
  f.peer.close = () => { f.calls.push(['close']); return closing.promise; };
  const connecting = f.slot.connect(); f.pending.resolve(f.peer); await connecting;
  const server = f.slot.requestServerStop('stop');
  let closed = false;
  const cleanup = f.slot.closeTransport('stop').then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  closing.resolve(); await cleanup;
  assert.equal(closed, true);
  await assert.doesNotReject(f.slot.closeTransport('stop'));
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'server').length, 1);
  f.server.reject(new Error('synthetic')); assert.equal(await server, 'unknown');
});

test('cleanup attempts close despite failed silence and reports bounded diagnostics', async () => {
  const f = fixture();
  f.peer.stopPlayback = () => Promise.reject(new Error('private synthetic payload'));
  const connecting = f.slot.connect(); f.pending.resolve(f.peer); await connecting;
  await assert.rejects(f.slot.closeTransport('stop'), /realtime_peer_cleanup_incomplete/);
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  assert.deepEqual(f.slot.snapshot().cleanupFailures, ['stopPlayback']);
});

test('repeated connect never reconnects or replays a failed effect', async () => {
  const f = fixture();
  const first = f.slot.connect();
  assert.equal(await f.slot.connect(), 'already_started');
  f.pending.reject(new Error('synthetic'));
  assert.equal(await first, 'failed');
  assert.equal(await f.slot.connect(), 'already_started');
  assert.equal(f.calls.filter(c => c[0] === 'connect').length, 1);
});
