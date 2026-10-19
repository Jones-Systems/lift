const test = require('node:test');
const assert = require('node:assert/strict');
const { createRealtimeHostController } = require('../host-controller.ts');
const { createRealtimeController } = require('../peer-slot.ts');
const { ExclusiveMicOwner, VoiceSessionController } = require('../../session-controller.ts');

const account = { accountId: 'fixture', authSessionId: 'original', accountEpoch: 1 };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(options = {}) {
  const calls = [], preparations = [], leases = [], peers = [], prepared = [];
  const acquired = deferred(), connecting = deferred(), releasing = deferred();
  let listener, foreground = true, accountCurrent = true, sequence = 0;
  const owner = new ExclusiveMicOwner({ acquire(input) {
    calls.push(['acquire', input.fence]);
    const lease = {
      fence: input.fence,
      stopCapture() { calls.push(['capture_stop']); },
      stopPlayback() { calls.push(['playback_stop']); },
      async deactivateAudio() { calls.push(['deactivate']); await options.deactivate?.(); },
      async release() { calls.push(['release']); releasing.resolve(); await options.release?.(); },
    };
    leases.push(lease); acquired.resolve();
    return options.acquire ? options.acquire(input, lease) : Promise.resolve(lease);
  } });
  const makePrepared = (operationId = `operation-${++sequence}`) => {
    const peer = {
      close() { calls.push(['peer_close', operationId]); },
      stopPlayback() { calls.push(['peer_silence', operationId]); },
      cancelResponse() {}, clearPlayback() {},
    };
    peers.push(peer);
    const attempt = createRealtimeController({
      account, availability: options.availability ?? { available: true },
      createSession() {
        calls.push(['factory', operationId]); options.onFactory?.();
        return new VoiceSessionController(owner, fence => {
          assert.equal(fence.accountId, account.accountId);
          assert.equal(fence.authSessionId, account.authSessionId);
          if (!accountCurrent) throw new Error('account changed');
        });
      },
      connector: {
        connect(input) {
          calls.push(['connect', operationId]); connecting.resolve();
          return options.connect ? options.connect(input, peer) : Promise.resolve(peer);
        },
        abortPending() { calls.push(['abort_peer', operationId]); },
        requestServerStop() {
          calls.push(['server_stop', operationId]);
          return options.server ? options.server() : new Promise(() => {});
        },
      },
    });
    const value = { kind: 'new', operationId, attempt,
      abandonUnstarted() { calls.push(['abandon', operationId]); return options.abandon ? options.abandon(operationId) : Promise.resolve(); } };
    prepared.push(value);
    return value;
  };
  const host = createRealtimeHostController({ account: options.account ?? account,
    isCurrent: () => foreground && accountCurrent,
    subscribeInvalidation(callback) { listener = callback; return { remove() { calls.push(['unsubscribe']); listener = undefined; } }; },
    prepareNewAttempt(input) {
      preparations.push(input); calls.push(['prepare', input.intentKey]);
      return options.prepare ? options.prepare(input, makePrepared) : Promise.resolve(makePrepared());
    },
  });
  return { host, calls, preparations, leases, peers, prepared, acquired, connecting, releasing, makePrepared,
    start: key => host.startNewAttempt(key, new AbortController().signal),
    emit(reason) {
      if (reason === 'background') foreground = false;
      if (reason === 'account_changed' || reason === 'logout') accountCurrent = false;
      listener?.(reason);
    },
    foreground: () => { foreground = true; },
    backgroundSilently: () => { foreground = false; },
    stale: () => { accountCurrent = false; },
  };
}
const names = f => f.calls.map(call => call[0]);

test('missing admission or host binding is disabled before any attempt or microphone call', async () => {
  let calls = 0;
  const withoutAdmission = createRealtimeHostController({ account, isCurrent: () => true,
    subscribeInvalidation: () => ({ remove() {} }) });
  assert.equal((await withoutAdmission.startNewAttempt('intent', new AbortController().signal)).status, 'disabled');
  const withoutHost = createRealtimeHostController({ account, isCurrent: () => true,
    prepareNewAttempt: async () => { calls++; return { kind: 'denied' }; } });
  assert.equal((await withoutHost.startNewAttempt('intent', new AbortController().signal)).status, 'disabled');
  assert.equal(calls, 0);
});

test('background releases local resources despite hanging server stop; fresh manual admission may proceed', async () => {
  const f = fixture();
  assert.equal((await f.start('intent-one')).status, 'connected');
  f.emit('background');
  const teardown = f.host.stop('background');
  let serverSettled = false;
  void teardown.server.then(() => { serverSettled = true; });
  assert.equal((await teardown.local).status, 'released');
  assert.equal(serverSettled, false);
  assert.ok(names(f).includes('capture_stop'));
  assert.ok(names(f).includes('peer_close'));
  assert.equal((await f.start('still-background')).status, 'cancelled');
  assert.equal(f.preparations.length, 1);
  f.foreground();
  assert.equal(f.preparations.length, 1);
  assert.equal((await f.start('intent-two')).status, 'connected');
  assert.equal(f.preparations.length, 2);
  assert.equal((await f.host.dispose().local).status, 'released');
});

test('hanging inert preparation cannot hold local release or revive after a later explicit attempt', async () => {
  const first = deferred();
  let count = 0;
  const mutableAccount = { ...account };
  const f = fixture({ account: mutableAccount, prepare: (_, build) => ++count === 1 ? first.promise : Promise.resolve(build('new-operation')) });
  const old = f.start('old-intent');
  mutableAccount.accountId = 'replacement';
  assert.ok(Object.isFrozen(f.preparations[0].account));
  assert.deepEqual(f.preparations[0].account, account);
  f.emit('background');
  assert.equal(f.preparations[0].signal.aborted, true);
  assert.equal((await f.host.stop('background').local).status, 'released');
  assert.equal(f.host.snapshot().admissionCleanup.pending, 1);
  assert.equal(names(f).includes('acquire'), false);
  f.foreground();
  assert.equal((await f.start('new-intent')).status, 'connected');
  const late = f.makePrepared('old-operation');
  first.resolve(late);
  assert.equal((await old).status, 'cancelled');
  await f.host.settled();
  assert.equal(late.attempt.snapshot().state, 'stopped');
  assert.deepEqual(f.calls.filter(call => call[0] === 'abandon'), [['abandon', 'old-operation']]);
  assert.equal(names(f).filter(name => name === 'acquire').length, 1);
  assert.equal(f.host.snapshot().operationId, 'new-operation');
  await f.host.dispose().local;
});

test('background during shared acquisition waits for exact late lease cleanup', async () => {
  const acquisition = deferred(), f = fixture({ acquire: () => acquisition.promise });
  const starting = f.start('intent');
  await f.acquired.promise;
  f.emit('background');
  let localReleased = false;
  const local = f.host.stop('background').local.then(result => { localReleased = true; return result; });
  await Promise.resolve(); assert.equal(localReleased, false);
  acquisition.resolve(f.leases[0]);
  assert.equal((await starting).status, 'cancelled');
  assert.equal((await local).status, 'released');
  assert.equal(names(f).includes('connect'), false);
  assert.equal(names(f).filter(name => name === 'release').length, 1);
  await f.host.dispose().local;
});

test('navigation during connection releases native audio first and awaits late peer disposal', async () => {
  const connection = deferred(), f = fixture({ connect: () => connection.promise });
  const starting = f.start('intent'); await f.connecting.promise;
  f.emit('navigation');
  let completed = false;
  const local = f.host.stop('navigation').local.then(result => { completed = true; return result; });
  await f.releasing.promise;
  assert.equal(completed, false);
  connection.resolve(f.peers[0]);
  assert.equal((await starting).status, 'cancelled');
  assert.equal((await local).status, 'released');
  assert.equal(names(f).filter(name => name === 'peer_close').length, 1);
  f.foreground();
  assert.equal((await f.start('after-navigation')).status, 'cancelled');
  await f.host.dispose().local;
});

test('incomplete shared local cleanup blocks another admission and retains the canonical owner', async () => {
  const f = fixture({ deactivate: () => { throw new Error('private native failure'); } });
  await f.start('intent');
  const local = await f.host.stop('user_stop').local;
  assert.equal(local.status, 'incomplete');
  assert.ok(local.failedSteps.includes('deactivateAudio'));
  assert.equal((await f.start('another-intent')).status, 'blocked');
  assert.equal(f.preparations.length, 1);
  assert.equal(names(f).filter(name => name === 'release').length, 1);
  assert.equal((await f.host.dispose().local).status, 'incomplete');
});

test('replay and denied admission cannot invoke an attempt factory or microphone', async () => {
  const f = fixture({ prepare: (input, build) => Promise.resolve(input.intentKey === 'fresh'
    ? build() : { kind: input.intentKey === 'existing' ? 'replay' : 'denied' }) });
  assert.equal((await f.start('existing')).status, 'replay');
  assert.equal((await f.start('denied')).status, 'denied');
  assert.equal(names(f).includes('factory'), false);
  assert.equal(names(f).includes('acquire'), false);
  assert.equal((await f.start('fresh')).status, 'connected');
  assert.equal(names(f).filter(name => name === 'acquire').length, 1);
  await f.host.dispose().local;
});

test('stale captured currentness after admission prevents dispatch and abandons only that preparation', async () => {
  const preparation = deferred(), f = fixture({ prepare: () => preparation.promise });
  const starting = f.start('intent');
  f.stale();
  preparation.resolve(f.makePrepared('original-operation'));
  assert.equal((await starting).status, 'cancelled');
  await f.host.settled();
  assert.equal(names(f).includes('factory'), false);
  assert.deepEqual(f.calls.filter(call => call[0] === 'abandon'), [['abandon', 'original-operation']]);
  assert.equal((await f.start('replacement-account')).status, 'cancelled');
  assert.equal(f.preparations.length, 1);
  await f.host.dispose().local;
});

test('foreground currentness is rechecked after admission even before a lifecycle callback arrives', async () => {
  const preparation = deferred(), f = fixture({ prepare: () => preparation.promise });
  const starting = f.start('intent');
  f.backgroundSilently(); preparation.resolve(f.makePrepared());
  assert.equal((await starting).status, 'cancelled');
  await f.host.settled();
  assert.equal(names(f).includes('acquire'), false);
  assert.equal(f.calls.filter(call => call[0] === 'abandon').length, 1);
  await f.host.dispose().local;
});

test('background during peer connection invalidates it and disposes the late peer', async () => {
  const connection = deferred(), f = fixture({ connect: () => connection.promise });
  const starting = f.start('intent'); await f.connecting.promise;
  f.emit('background');
  const local = f.host.stop('background').local;
  await f.releasing.promise;
  connection.resolve(f.peers[0]);
  assert.equal((await starting).status, 'cancelled');
  assert.equal((await local).status, 'released');
  assert.equal(f.calls.filter(call => call[0] === 'peer_close').length, 1);
  await f.host.dispose().local;
});

test('foreground currentness is rechecked after actual peer connection resolves', async () => {
  const connection = deferred(), f = fixture({ connect: () => connection.promise });
  const starting = f.start('intent'); await f.connecting.promise;
  f.backgroundSilently(); connection.resolve(f.peers[0]);
  assert.equal((await starting).status, 'cancelled');
  assert.equal((await f.host.stop('background').local).status, 'released');
  assert.equal(f.calls.filter(call => call[0] === 'peer_close').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'release').length, 1);
  await f.host.dispose().local;
});

test('cancellation reentering the prepared factory cannot start its returned attempt', async () => {
  const f = fixture({ prepare: (_, build) => { f.emit('background'); return Promise.resolve(build()); } });
  assert.equal((await f.start('intent')).status, 'cancelled');
  await f.host.settled();
  assert.equal(names(f).includes('factory'), false);
  assert.equal(names(f).filter(name => name === 'abandon').length, 1);
  assert.equal((await f.host.stop('background').local).status, 'released');
  await f.host.dispose().local;
});

test('cancellation reentering actual attempt start cannot acquire after its shared session factory', async () => {
  const f = fixture({ onFactory: () => { f.emit('background'); } });
  assert.equal((await f.start('intent')).status, 'cancelled');
  assert.equal((await f.host.stop('background').local).status, 'released');
  assert.equal(names(f).includes('acquire'), false);
  assert.equal(names(f).includes('abandon'), false);
  await f.host.dispose().local;
});

test('disabled or failed actual starts leave reservation reconciliation with the trusted factory', async () => {
  for (const status of ['disabled', 'failed']) {
    const f = fixture(status === 'disabled'
      ? { availability: { available: false, reason: 'provider_unconfigured' } }
      : { connect: async () => { throw new Error('connection failed'); } });
    assert.equal((await f.start('intent')).status, status);
    assert.equal((await f.host.stop('failed').local).status, 'released');
    await f.host.settled();
    assert.equal(f.preparations.length, 1);
    assert.equal(names(f).includes('abandon'), false);
    assert.equal(names(f).includes('acquire'), status === 'failed');
    assert.equal((await f.host.dispose().local).status, 'released');
    assert.equal(names(f).includes('abandon'), false);
  }
});

test('failed late abandonment stays unknown without imposing a new blanket spending policy', async () => {
  const preparation = deferred();
  let count = 0;
  const f = fixture({ prepare: (_, build) => ++count === 1 ? preparation.promise : Promise.resolve(build('new-operation')),
    abandon: async () => { throw new Error('reservation staged or unknown; private payload'); } });
  const old = f.start('old-intent'); f.emit('background');
  assert.equal((await f.host.stop('background').local).status, 'released');
  preparation.resolve(f.makePrepared('old-operation'));
  await old; await f.host.settled();
  assert.equal(f.host.snapshot().admissionCleanup.unknown, true);
  assert.deepEqual(f.host.snapshot().cleanupFailures, ['abandonUnstarted']);
  f.foreground();
  assert.equal((await f.start('genuinely-new-intent')).status, 'connected');
  assert.equal(f.host.snapshot().admissionCleanup.unknown, true);
  assert.equal(f.calls.filter(call => call[0] === 'abandon').length, 1);
  await f.host.dispose().local;
});

test('hanging abandonment is separate from local release and fresh explicit admission', async () => {
  const preparation = deferred(), abandonment = deferred();
  let count = 0;
  const f = fixture({ prepare: (_, build) => ++count === 1 ? preparation.promise : Promise.resolve(build('new-operation')),
    abandon: () => abandonment.promise });
  const old = f.start('old-intent'); f.emit('background');
  assert.equal((await f.host.stop('background').local).status, 'released');
  preparation.resolve(f.makePrepared('old-operation')); await old;
  assert.equal(f.host.snapshot().admissionCleanup.pending, 1);
  f.foreground();
  assert.equal((await f.start('new-intent')).status, 'connected');
  assert.equal(f.host.snapshot().admissionCleanup.pending, 1);
  abandonment.resolve(); await f.host.settled();
  assert.deepEqual(f.host.snapshot().admissionCleanup, { pending: 0, unknown: false });
  await f.host.dispose().local;
});

test('dispose unsubscribes once and waits actual local cleanup without server acknowledgement', async () => {
  const cleanup = deferred(), f = fixture({ release: () => cleanup.promise });
  await f.start('intent');
  const first = f.host.dispose(), second = f.host.dispose();
  assert.equal(first, second);
  assert.equal(names(f).filter(name => name === 'unsubscribe').length, 1);
  assert.equal((await f.start('after-dispose')).status, 'cancelled');
  let finished = false; const local = first.local.then(result => { finished = true; return result; });
  await f.releasing.promise; assert.equal(finished, false);
  cleanup.resolve(); assert.equal((await local).status, 'released');
  assert.equal(f.host.snapshot().state, 'disposed');
});

test('external abort during admission cancels the captured signal and disposes late preparation', async () => {
  const preparation = deferred(), f = fixture({ prepare: () => preparation.promise });
  const abort = new AbortController();
  const starting = f.host.startNewAttempt('intent', abort.signal);
  abort.abort();
  assert.equal(f.preparations[0].signal.aborted, true);
  assert.equal((await f.host.stop('aborted').local).status, 'released');
  preparation.resolve(f.makePrepared());
  assert.equal((await starting).status, 'cancelled');
  await f.host.settled();
  assert.equal(names(f).includes('acquire'), false);
  await f.host.dispose().local;
});

test('release completion never automatically triggers another admission', async () => {
  const cleanup = deferred(), f = fixture({ release: () => cleanup.promise });
  await f.start('intent');
  const stopped = f.host.stop('user_stop');
  assert.equal((await f.start('too-early')).status, 'busy');
  assert.equal(f.preparations.length, 1);
  cleanup.resolve(); await stopped.local;
  assert.equal(f.preparations.length, 1);
  assert.equal((await f.start('explicit-next-intent')).status, 'connected');
  assert.equal(f.preparations.length, 2);
  await f.host.dispose().local;
});

test('an uncertain preparation failure is preserved without retaining its error payload', async () => {
  const f = fixture({ prepare: async () => { throw new Error('private network payload'); } });
  assert.equal((await f.start('intent')).status, 'failed');
  assert.equal((await f.host.stop('failed').local).status, 'released');
  assert.equal(f.host.snapshot().admissionCleanup.unknown, true);
  assert.deepEqual(f.host.snapshot().cleanupFailures, ['prepareNewAttempt']);
  assert.equal(names(f).includes('acquire'), false);
  await f.host.dispose().local;
});
