const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ExclusiveMicOwner, VoiceSessionController } = require('../../session-controller.ts');
const { createRealtimeController } = require('../peer-slot.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const account = { accountId: 'fixture', authSessionId: 'original', accountEpoch: 1 };

function fixture({ availability = { available: true }, acquisition, deactivation, release, connection } = {}) {
  const calls = [], reasons = [], server = deferred(), abort = new AbortController();
  const acquired = deferred(), connected = deferred(), deactivating = deferred(), releasing = deferred();
  let current = true;
  let lease;
  const peer = {
    close(reason) { calls.push('peer_close'); reasons.push(['peer_close', reason]); },
    stopPlayback(reason) { calls.push('peer_silence'); reasons.push(['peer_silence', reason]); },
    cancelResponse() { calls.push('cancel'); },
    clearPlayback() { calls.push('clear'); },
  };
  const controller = createRealtimeController({
    account,
    availability,
    createSession() {
      calls.push('session');
      return new VoiceSessionController({
        acquire({ fence, signal, mode }) {
          calls.push('acquire');
          assert.equal(mode, 'realtime');
          lease = {
            fence,
            stopCapture(reason) { calls.push('capture_stop'); reasons.push(['capture_stop', reason]); },
            stopPlayback(reason) { calls.push('playback_stop'); reasons.push(['playback_stop', reason]); },
            deactivateAudio(reason) { calls.push('deactivate'); reasons.push(['deactivate', reason]); deactivating.resolve(); return deactivation?.promise ?? Promise.resolve(); },
            release(reason) { calls.push('release'); reasons.push(['release', reason]); releasing.resolve(); return release?.promise ?? Promise.resolve(); },
          };
          assert.equal(signal.aborted, false);
          acquired.resolve();
          return acquisition?.promise ?? Promise.resolve(lease);
        },
      }, fence => {
        assert.equal(fence.accountId, account.accountId);
        if (!current) throw new Error('stale_account');
      });
    },
    connector: {
      connect() { calls.push('connect'); connected.resolve(); return connection?.promise ?? Promise.resolve(peer); },
      abortPending() { calls.push('abort_pending'); },
      requestServerStop() { calls.push('server_stop'); return server.promise; },
    },
  });
  return { controller, abort, calls, reasons, server, peer, acquired, connected, deactivating, releasing,
    lease: () => lease, stale: () => { current = false; } };
}

test('unavailable capability prevents session creation, microphone acquisition and connection', async () => {
  for (const reason of ['native_unavailable', 'microphone_denied', 'provider_unconfigured', 'transport_policy_pending']) {
    const f = fixture({ availability: { available: false, reason } });
    assert.deepEqual(await f.controller.start(f.abort.signal), { status: 'disabled', reason });
    assert.deepEqual(f.calls, []);
  }
  let created = false;
  const controller = createRealtimeController({ account, createSession() { created = true; throw new Error(); } });
  assert.equal((await controller.start(new AbortController().signal)).status, 'disabled');
  assert.equal(created, false);
});

test('cancellation inside the session factory prevents later microphone acquisition', async () => {
  for (const action of ['stop', 'abort']) {
    const abort = new AbortController();
    let acquisitions = 0, connections = 0;
    let stopped;
    const controller = createRealtimeController({
      account,
      availability: { available: true },
      createSession() {
        if (action === 'stop') stopped = controller.stop('user_stop');
        else abort.abort();
        return new VoiceSessionController({
          async acquire() { acquisitions++; throw new Error('unexpected_acquisition'); },
        }, () => {});
      },
      connector: {
        async connect() { connections++; throw new Error('unexpected_connection'); },
        abortPending() {},
        async requestServerStop() { return 'unknown'; },
      },
    });
    assert.deepEqual(await controller.start(abort.signal), { status: 'cancelled' });
    const teardown = stopped ?? controller.stop('aborted');
    assert.equal((await teardown.local).status, 'released');
    assert.equal(acquisitions, 0, action);
    assert.equal(connections, 0, action);
    assert.equal((await controller.start(new AbortController().signal)).status, 'cancelled');
  }
});

test('stop during acquisition disposes the late shared lease without starting a peer', async () => {
  const acquisition = deferred(), f = fixture({ acquisition });
  const starting = f.controller.start(f.abort.signal);
  await f.acquired.promise;
  const stop = f.controller.stop('background');
  acquisition.resolve(f.lease());
  assert.equal((await starting).status, 'cancelled');
  assert.equal((await stop.local).status, 'released');
  assert.deepEqual(f.calls, ['session', 'acquire', 'capture_stop', 'playback_stop', 'deactivate', 'release']);
  assert.equal((await f.controller.start(new AbortController().signal)).status, 'cancelled');
});

test('shared native deactivation/release complete before local released; server stop is independent', async () => {
  const deactivation = deferred(), release = deferred(), f = fixture({ deactivation, release });
  assert.equal((await f.controller.start(f.abort.signal)).status, 'connected');
  const stop = f.controller.stop('navigation');
  let released = false; const local = stop.local.then(result => { released = true; return result; });
  await f.deactivating.promise;
  assert.equal(released, false);
  assert.equal(f.calls.includes('release'), false);
  deactivation.resolve();
  await f.releasing.promise;
  assert.equal(released, false);
  release.resolve();
  assert.equal((await local).status, 'released');
  assert.equal(f.calls.filter(c => c === 'release').length, 1);
  assert.equal(f.controller.stop('navigation'), stop);
  f.server.resolve('unknown'); assert.equal((await stop.server).status, 'unknown');
});

test('late peer disposal participates in local completion while native cleanup proceeds first', async () => {
  const connection = deferred(), f = fixture({ connection });
  const starting = f.controller.start(f.abort.signal);
  await f.connected.promise;
  assert.equal(f.calls.includes('connect'), true);
  const stop = f.controller.stop('logout');
  let released = false; void stop.local.then(() => { released = true; });
  await f.releasing.promise;
  assert.equal(f.calls.includes('release'), true);
  assert.equal(released, false);
  connection.resolve(f.peer);
  assert.equal((await starting).status, 'cancelled');
  assert.equal((await stop.local).status, 'released');
  assert.equal(f.calls.filter(c => c === 'peer_close').length, 1);
});

test('account invalidation disposes late resources without borrowing replacement credentials', async () => {
  const connection = deferred(), f = fixture({ connection });
  const starting = f.controller.start(f.abort.signal);
  await f.connected.promise;
  f.stale(); connection.resolve(f.peer);
  assert.equal((await starting).status, 'cancelled');
  assert.equal((await f.controller.stop('account_changed').local).status, 'released');
  assert.equal(f.calls.filter(c => c === 'acquire').length, 1);
  assert.equal(f.calls.filter(c => c === 'peer_close').length, 1);
});

test('external abort fences callbacks and runs shared teardown', async () => {
  const f = fixture();
  await f.controller.start(f.abort.signal);
  f.abort.abort();
  assert.equal(f.controller.observe({ type: 'response.started', responseId: 'late' }), false);
  assert.equal((await f.controller.stop('aborted').local).status, 'released');
  assert.equal(f.calls.filter(c => c === 'capture_stop').length, 1);
});

test('failed peer silence keeps shared local teardown incomplete despite successful native release', async () => {
  const f = fixture();
  f.peer.stopPlayback = () => { throw new Error('synthetic'); };
  await f.controller.start(f.abort.signal);
  const result = await f.controller.stop('user_stop').local;
  assert.equal(result.status, 'incomplete');
  assert.equal(result.failedSteps.includes('closeTransport'), true);
  assert.equal(f.calls.includes('release'), true);
});

// ---- Teardown ordering, account fencing, concurrency and reconnect (source-level fakes only) ----
const REASONS = ['user_stop', 'navigation', 'background', 'logout', 'account_changed', 'interruption', 'aborted', 'failed'];
const flush = () => new Promise(resolve => setImmediate(resolve));
const pending = promise => Promise.race([promise.then(() => 'settled'), flush().then(() => 'pending')]);

for (const reason of REASONS) {
  test(`${reason}: local microphone and playback release is requested before and independent of late provider callbacks`, async () => {
    const release = deferred(), f = fixture({ release });
    assert.equal((await f.controller.start(f.abort.signal)).status, 'connected');
    assert.equal(f.controller.observe({ type: 'response.started', responseId: 'r1' }), true);
    assert.equal(f.controller.observe({ type: 'playback.started', responseId: 'r1' }), true);
    assert.equal(f.controller.snapshot().peer.playing, true);
    const stop = f.controller.stop(reason);
    // Provider events that arrive after teardown starts are fenced synchronously, before any native await settles.
    assert.equal(f.controller.observe({ type: 'response.done', responseId: 'r1' }), false);
    assert.equal(f.controller.observe({ type: 'response.started', responseId: 'late' }), false);
    assert.equal(f.controller.snapshot().peer.generating, false);
    assert.equal(f.controller.snapshot().peer.playing, false);
    assert.deepEqual(await f.controller.interrupt(), { attempted: false, failures: [] });
    await f.releasing.promise;
    assert.equal(await pending(stop.local), 'pending');
    assert.equal(f.controller.observe({ type: 'playback.stopped', responseId: 'r1' }), false);
    assert.equal(f.calls.includes('cancel'), false);
    assert.equal(f.calls.includes('clear'), false);
    release.resolve();
    assert.deepEqual(await stop.local, { status: 'released', failedSteps: [] });
    const order = name => f.calls.indexOf(name);
    assert.ok(order('capture_stop') < order('deactivate') && order('playback_stop') < order('deactivate') && order('deactivate') < order('release'));
    for (const name of ['capture_stop', 'playback_stop', 'deactivate', 'release', 'peer_silence', 'peer_close']) {
      assert.deepEqual(f.reasons.filter(entry => entry[0] === name), [[name, reason]], name);
    }
    assert.equal(f.controller.observe({ type: 'response.started', responseId: 'after-release' }), false);
    assert.equal((await f.controller.start(new AbortController().signal)).status, 'cancelled');
    assert.equal(f.calls.filter(c => c === 'release').length, 1);
    assert.equal(f.calls.filter(c => c === 'connect').length, 1);
  });
}

test('server stop is acknowledged only on provider-terminal evidence and never gates local release', async () => {
  for (const [outcome, expected] of [['confirmed', 'acknowledged'], ['unknown', 'unknown'], ['reject', 'unknown']]) {
    const f = fixture();
    await f.controller.start(f.abort.signal);
    const stop = f.controller.stop('user_stop');
    assert.equal((await stop.local).status, 'released');
    assert.equal(await pending(stop.server), 'pending', 'local release must not imply a server acknowledgement');
    if (outcome === 'reject') f.server.reject(new Error('synthetic transport failure')); else f.server.resolve(outcome);
    assert.equal((await stop.server).status, expected);
    assert.equal(f.calls.filter(c => c === 'server_stop').length, 1);
  }
  // A hangup before any peer exists has nothing the provider could have acknowledged.
  const acquisition = deferred(), early = fixture({ acquisition });
  const starting = early.controller.start(early.abort.signal);
  await early.acquired.promise;
  const stop = early.controller.stop('background');
  early.server.resolve('confirmed');
  assert.equal((await stop.server).status, 'unknown');
  assert.equal(early.calls.includes('server_stop'), false);
  acquisition.resolve(early.lease());
  assert.equal((await starting).status, 'cancelled');
  assert.equal((await stop.local).status, 'released');
});

function sharedOwnerFixture() {
  const calls = [], owners = [];
  const owner = new ExclusiveMicOwner({ async acquire({ fence }) {
    calls.push(['acquire', fence.accountId, fence.generation]);
    return { fence,
      stopCapture() { calls.push(['capture_stop', fence.accountId]); },
      stopPlayback() { calls.push(['playback_stop', fence.accountId]); },
      async deactivateAudio() { calls.push(['deactivate', fence.accountId]); },
      async release() { calls.push(['release', fence.accountId]); } };
  } });
  const make = (id, { epoch = 1, isCurrent = () => true, connect } = {}) => {
    const accountValue = { accountId: id, authSessionId: `${id}-session`, accountEpoch: epoch };
    const peer = {
      close() { calls.push(['peer_close', id]); },
      stopPlayback() { calls.push(['peer_silence', id]); },
      cancelResponse() { calls.push(['cancel', id]); },
      clearPlayback() { calls.push(['clear', id]); },
    };
    const controller = createRealtimeController({
      account: accountValue, availability: { available: true },
      createSession: () => new VoiceSessionController(owner, fence => {
        assert.equal(fence.accountId, id);
        if (!isCurrent()) throw new Error('stale_account');
      }),
      connector: {
        connect() { calls.push(['connect', id]); return connect ? connect(peer) : Promise.resolve(peer); },
        abortPending() {},
        async requestServerStop() { return 'unknown'; },
      },
    });
    owners.push(controller);
    return { controller, peer };
  };
  return { calls, make, count: (name, id) => calls.filter(c => c[0] === name && (id === undefined || c[1] === id)).length };
}

test('a second concurrent Realtime start cannot take the microphone, connect, or disturb the live session', async () => {
  const s = sharedOwnerFixture(), first = s.make('account-a'), second = s.make('account-a');
  const open = new AbortController();
  assert.equal((await first.controller.start(open.signal)).status, 'connected');
  assert.deepEqual(await first.controller.start(new AbortController().signal), { status: 'already_started' });
  assert.deepEqual(await second.controller.start(new AbortController().signal), { status: 'failed' });
  assert.equal(s.count('connect'), 1);
  assert.equal(s.count('acquire'), 1);
  assert.equal(s.count('release'), 0);
  assert.equal(first.controller.observe({ type: 'response.started', responseId: 'live' }), true);
  assert.equal(second.controller.observe({ type: 'response.started', responseId: 'live' }), false);
  assert.equal(first.controller.snapshot().state, 'connected');
  assert.equal((await first.controller.stop('user_stop').local).status, 'released');
  // The busy refusal never poisoned the exclusive owner: a fresh attempt may now proceed.
  const third = s.make('account-a');
  assert.equal((await third.controller.start(new AbortController().signal)).status, 'connected');
  assert.equal((await third.controller.stop('user_stop').local).status, 'released');
});

test('a failed connection is never retried or revived; a reconnect is a fresh attempt after the old release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let attempts = 0;
  const s = sharedOwnerFixture();
  const flaky = s.make('account-a', { connect: peer => (++attempts === 1 ? Promise.reject(new Error('synthetic transient')) : Promise.resolve(peer)) });
  assert.equal((await flaky.controller.start(new AbortController().signal)).status, 'failed');
  t.mock.timers.tick(3_600_000);
  await flush();
  assert.equal(s.count('connect'), 1, 'no timer-driven retry');
  assert.equal((await flaky.controller.stop('failed').local).status, 'released');
  assert.equal(s.count('release'), 1, 'failure released the microphone exactly once');
  assert.equal((await flaky.controller.start(new AbortController().signal)).status, 'cancelled');
  assert.equal(s.count('connect'), 1);
  const fresh = s.make('account-a');
  assert.equal((await fresh.controller.start(new AbortController().signal)).status, 'connected');
  const acquires = s.calls.filter(c => c[0] === 'acquire');
  assert.equal(acquires.length, 2);
  assert.ok(s.calls.findIndex(c => c[0] === 'release') < s.calls.findLastIndex(c => c[0] === 'acquire'),
    'the failed attempt released the microphone before the reconnect acquired it');
  assert.equal(s.count('connect'), 2);
  assert.equal(flaky.controller.observe({ type: 'response.started', responseId: 'late-old' }), false);
  assert.equal(fresh.controller.observe({ type: 'response.started', responseId: 'fresh' }), true);
  assert.equal((await fresh.controller.stop('user_stop').local).status, 'released');
});

test('late callbacks from the old account never attribute to a replacement account session', async () => {
  const s = sharedOwnerFixture();
  let oldCurrent = true;
  const old = s.make('account-a', { isCurrent: () => oldCurrent });
  assert.equal((await old.controller.start(new AbortController().signal)).status, 'connected');
  assert.equal(old.controller.observe({ type: 'response.started', responseId: 'old-response' }), true);
  oldCurrent = false;
  // Account switch alone (before any stop) already fences provider callbacks and interruption commands.
  assert.equal(old.controller.observe({ type: 'playback.started', responseId: 'old-response' }), false);
  assert.deepEqual(await old.controller.interrupt(), { attempted: false, failures: [] });
  assert.equal(s.count('cancel'), 0);
  assert.equal((await old.controller.stop('account_changed').local).status, 'released');
  const replacement = s.make('account-b', { epoch: 2 });
  assert.equal((await replacement.controller.start(new AbortController().signal)).status, 'connected');
  assert.ok(s.calls.findIndex(c => c[0] === 'release' && c[1] === 'account-a') < s.calls.findIndex(c => c[0] === 'acquire' && c[1] === 'account-b'),
    'the old account microphone is released before the replacement acquires');
  assert.equal(replacement.controller.observe({ type: 'response.started', responseId: 'new-response' }), true);
  assert.equal(old.controller.observe({ type: 'response.done', responseId: 'new-response' }), false);
  assert.equal(old.controller.observe({ type: 'response.started', responseId: 'old-response-2' }), false);
  assert.deepEqual(await old.controller.interrupt(), { attempted: false, failures: [] });
  assert.equal(replacement.controller.snapshot().peer.generating, true);
  assert.equal(s.count('release', 'account-b'), 0);
  assert.equal((await replacement.controller.stop('logout').local).status, 'released');
});

test('credential expiry on a fake clock fences a connected session and its late peer without any lifecycle callback', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const expiresAt = 5_000, s = sharedOwnerFixture();
  const session = s.make('account-a', { isCurrent: () => Date.now() < expiresAt });
  assert.equal((await session.controller.start(new AbortController().signal)).status, 'connected');
  assert.equal(session.controller.observe({ type: 'response.started', responseId: 'r1' }), true);
  t.mock.timers.tick(4_000);
  assert.equal(session.controller.observe({ type: 'playback.started', responseId: 'r1' }), false);
  assert.deepEqual(await session.controller.interrupt(), { attempted: false, failures: [] });
  assert.equal(s.count('cancel'), 0);
  assert.equal(s.count('release'), 0, 'expiry alone does not pretend the hardware was released');
  assert.equal((await session.controller.stop('account_changed').local).status, 'released');
  assert.equal(s.count('release'), 1);
  assert.equal(s.count('peer_close'), 1);
  // A connection that resolves after expiry is disposed rather than activated.
  t.mock.timers.setTime(1_000);
  const late = deferred();
  const second = s.make('account-a', { isCurrent: () => Date.now() < expiresAt, connect: () => late.promise });
  const starting = second.controller.start(new AbortController().signal);
  await flush();
  t.mock.timers.tick(4_000);
  late.resolve(second.peer);
  assert.equal((await starting).status, 'cancelled');
  assert.equal((await second.controller.stop('account_changed').local).status, 'released');
  assert.equal(s.count('peer_close'), 2);
  assert.equal(second.controller.observe({ type: 'response.started', responseId: 'x' }), false);
});
