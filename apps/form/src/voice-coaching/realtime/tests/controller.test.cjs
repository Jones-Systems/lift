const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VoiceSessionController } = require('../../session-controller.ts');
const { createRealtimeController } = require('../peer-slot.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const account = { accountId: 'fixture', authSessionId: 'original', accountEpoch: 1 };

function fixture({ availability = { available: true }, acquisition, deactivation, release, connection } = {}) {
  const calls = [], server = deferred(), abort = new AbortController();
  const acquired = deferred(), connected = deferred(), deactivating = deferred(), releasing = deferred();
  let current = true;
  let lease;
  const peer = {
    close() { calls.push('peer_close'); },
    stopPlayback() { calls.push('peer_silence'); },
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
            stopCapture() { calls.push('capture_stop'); },
            stopPlayback() { calls.push('playback_stop'); },
            deactivateAudio() { calls.push('deactivate'); deactivating.resolve(); return deactivation?.promise ?? Promise.resolve(); },
            release() { calls.push('release'); releasing.resolve(); return release?.promise ?? Promise.resolve(); },
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
  return { controller, abort, calls, server, peer, acquired, connected, deactivating, releasing,
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
