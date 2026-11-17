const assert = require('node:assert/strict');
const test = require('node:test');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');

const source = path => import(pathToFileURL(resolve(__dirname, path)).href);
const modules = Promise.all([
  source('../../../../../apps/form/src/voice-coaching/realtime/peer-slot.ts'),
  source('../../../../../apps/form/src/voice-coaching/session-controller.ts'),
  source('../../../src/voice-coaching/request-scope.ts'),
  source('../../../src/voice-coaching/realtime/provider.ts'),
  source('../../../src/usage-limits/ledger.ts'),
  source('../../../src/usage-limits/migration.ts'),
]);
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

// Offline composition only. The offer/answer are synthetic tokens, not SDP or a
// provider wire protocol. No production transport, clock or rights policy is selected.
async function fixture(t, { beforeDispatch, connection, hangup, cancel } = {}) {
  const [
    { createRealtimeController }, { VoiceSessionController, ExclusiveMicOwner },
    { createCoachingRequestScope }, { classifyRealtimeFailure },
    { createUsageLedger }, { usageMigrationSql },
  ] = await modules;
  const actor = Object.freeze({
    accountId: 'synthetic-account', authUserId: 'synthetic-user',
    sessionId: 'synthetic-session', epoch: 1,
  });
  const account = {
    accountId: actor.accountId, authSessionId: actor.sessionId, accountEpoch: actor.epoch,
  };
  let currentActor = { ...actor };
  const checkedActors = [], calls = [], createInputs = [], hangupInputs = [];
  const connecting = deferred(), dispatched = deferred(), stopping = deferred(), nativeReleased = deferred();
  const lifecycle = {
    assertActive(value) {
      checkedActors.push(value);
      assert.deepEqual(value, actor);
      if (Object.keys(actor).some(key => value[key] !== currentActor[key])) throw new Error('synthetic_stale_actor');
    },
    withActiveWrite(value, effect) {
      lifecycle.assertActive(value);
      return effect();
    },
    adultEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'unknown', profileRevision: null }),
  };
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO form_accounts VALUES(?)').run(actor.accountId);
  db.exec(usageMigrationSql);
  const ledger = createUsageLedger({
    db, lifecycle, now: () => 10,
    policy: {
      id: 'synthetic-policy', periodPolicyId: 'synthetic-period-policy',
      periodResolver: () => ({ id: 'synthetic-period', startMs: 0, endMs: 100 }),
      periodAllocation: 'reservation_period', liveRounding: 'exact_milliseconds', liveMessageCounting: 'excluded',
      limits: { live_voice_ms: 9_000_000, coach_messages: 100, workout_generations: 100 },
      operations: { live: { capability: 'synthetic-live', metrics: ['live_voice_ms'] } },
    },
    resolveRights: () => ({
      policyId: 'synthetic-rights', capabilities: ['synthetic-live'], configuredOperations: ['live'],
    }),
  });
  const reservation = ledger.usage.reserve(actor, {
    operation: 'live', idempotencyKey: 'synthetic-intent', intentHash: 'a'.repeat(64),
    subjectId: 'synthetic-subject', charges: [{ metric: 'live_voice_ms', amount: 20 }],
    dispatchStages: ['connect'],
  });
  const operationId = reservation.handle.reservationId;
  // The API request scope is independent of local peer cancellation, and always
  // retains the original actor. Cleanup never borrows replacement credentials.
  const scope = createCoachingRequestScope(actor, lifecycle, new AbortController().signal);
  let sent = false, providerCallId = null;
  const peer = {
    close() { calls.push('peer.close'); },
    stopPlayback() { calls.push('peer.silence'); },
    cancelResponse(responseId) { calls.push(['peer.cancel', responseId]); return cancel?.promise; },
    clearPlayback() { calls.push('peer.clear'); },
  };
  /** @type {import('../../../src/voice-coaching/realtime/provider.ts').RealtimeProvider<string, string>} */
  const provider = {
    capability: { available: true, provider: 'openai-realtime' },
    async createCall(originalScope, input) {
      originalScope.assertCurrent();
      assert.equal(originalScope, scope);
      assert.equal(input.operationId, operationId);
      assert.equal(input.offer, 'synthetic-offer');
      ledger.usage.markDispatching(reservation.handle, 'connect');
      sent = true;
      createInputs.push({ actor: originalScope.actor, ...input });
      dispatched.resolve();
      if (connection) await connection.promise;
      return { kind: 'succeeded', value: { providerCallId: 'synthetic-call', answer: 'synthetic-answer' } };
    },
    async hangup(originalScope, input) {
      originalScope.assertCurrent();
      assert.equal(originalScope, scope);
      hangupInputs.push({ actor: originalScope.actor, ...input });
      stopping.resolve();
      if (hangup) await hangup.promise;
      return { kind: 'succeeded', value: { acknowledged: true, termination: 'unconfirmed' } };
    },
  };
  /** @type {import('../../../../../apps/form/src/voice-coaching/realtime/peer-slot.ts').RealtimeConnector} */
  const connector = {
    async connect(input) {
      assert.deepEqual(input.fence, { ...account, generation: 1 });
      connecting.resolve();
      if (beforeDispatch) await beforeDispatch.promise;
      input.signal.throwIfAborted();
      assert.equal(input.isCurrent(), true);
      scope.assertCurrent();
      const result = await provider.createCall(scope, { operationId, offer: 'synthetic-offer' });
      assert.equal(result.kind, 'succeeded');
      assert.equal(result.value.answer, 'synthetic-answer');
      providerCallId = result.value.providerCallId;
      // A resource returned after cancellation still belongs to the peer slot;
      // let that real lifecycle owner dispose it rather than leak it here.
      return peer;
    },
    abortPending() { calls.push('connector.abort'); },
    async requestServerStop() {
      if (!sent) {
        ledger.trusted.release(reservation.handle);
        return 'unknown';
      }
      const failure = classifyRealtimeFailure({ dispatch: 'may_have_been_sent', rejection: 'unproved' });
      assert.equal(failure.kind, 'unknown');
      // Record liability before waiting for any remote result, including a hang.
      ledger.trusted.markUnknown(reservation.handle);
      if (providerCallId) {
        const receipt = await provider.hangup(scope, { operationId, providerCallId });
        assert.deepEqual(receipt, {
          kind: 'succeeded', value: { acknowledged: true, termination: 'unconfirmed' },
        });
      }
      // No synthetic terminal evidence exists: an ack cannot settle or release.
      return 'unknown';
    },
  };
  const owner = new ExclusiveMicOwner({
    async acquire({ fence }) {
      calls.push('native.acquire');
      return {
        fence,
        stopCapture() { calls.push('native.capture.stop'); },
        stopPlayback() { calls.push('native.silence'); },
        deactivateAudio() { calls.push('native.deactivate'); },
        release() { calls.push('native.release'); nativeReleased.resolve(); },
      };
    },
  });
  const controller = createRealtimeController({
    account, availability: { available: true }, connector,
    createSession: () => new VoiceSessionController(owner, fence => {
      assert.deepEqual(
        { accountId: fence.accountId, authSessionId: fence.authSessionId, accountEpoch: fence.accountEpoch }, account,
      );
      lifecycle.assertActive(actor);
    }),
  });
  const abort = new AbortController();
  return {
    controller, abort, calls, createInputs, hangupInputs, checkedActors, actor,
    connecting, dispatched, stopping, nativeReleased, ledger, reservation,
    start: () => controller.start(abort.signal),
    replaceAccount() {
      currentActor = {
        accountId: 'synthetic-replacement', authUserId: 'synthetic-other-user',
        sessionId: 'synthetic-other-session', epoch: 2,
      };
    },
    liability: () => db.prepare('SELECT state FROM usage_reservations WHERE id=?').get(operationId).state,
    counter: () => db.prepare("SELECT settled,reserved,unknown FROM usage_counters WHERE metric='live_voice_ms'").get(),
  };
}

test('synthetic connector cancellation before dispatch releases only the unstaged reservation', async t => {
  const gate = deferred(), f = await fixture(t, { beforeDispatch: gate });
  const starting = f.start();
  await f.connecting.promise;
  f.abort.abort();
  const stop = f.controller.stop('aborted');
  gate.resolve();
  assert.deepEqual(await starting, { status: 'cancelled' });
  assert.equal((await stop.local).status, 'released');
  assert.equal((await stop.server).status, 'unknown');
  assert.equal(f.createInputs.length, 0);
  assert.equal(f.hangupInputs.length, 0);
  assert.equal(f.liability(), 'released');
  assert.deepEqual(f.counter(), { settled: 0, reserved: 0, unknown: 0 });
  assert.equal(f.calls.includes('peer.close'), false);
  assert.deepEqual(await f.start(), { status: 'cancelled' });
});

test('a dispatched late answer is disposed once and cannot clear unknown liability', async t => {
  const connection = deferred(), f = await fixture(t, { connection });
  const starting = f.start();
  await f.dispatched.promise;
  const stop = f.controller.stop('navigation');
  let localDone = false;
  void stop.local.then(() => { localDone = true; });
  await f.nativeReleased.promise;
  assert.equal(localDone, false);
  assert.equal((await stop.server).status, 'unknown');
  assert.equal(f.liability(), 'unknown');
  connection.resolve();
  assert.deepEqual(await starting, { status: 'cancelled' });
  assert.equal((await stop.local).status, 'released');
  assert.equal(f.controller.stop('navigation'), stop);
  assert.equal(f.calls.filter(call => call === 'peer.close').length, 1);
  assert.equal(f.calls.filter(call => call === 'peer.silence').length, 1);
  assert.equal(f.calls.filter(call => call === 'native.release').length, 1);
  assert.equal(f.controller.observe({ type: 'playback.started', responseId: 'synthetic-late' }), false);
  assert.equal(f.createInputs.length, 1);
  assert.deepEqual(f.counter(), { settled: 0, reserved: 0, unknown: 20 });
});

test('replacement account cannot receive a late answer or lend its scope to hangup', async t => {
  const connection = deferred(), f = await fixture(t, { connection });
  const starting = f.start();
  await f.dispatched.promise;
  f.replaceAccount();
  connection.resolve();
  assert.deepEqual(await starting, { status: 'cancelled' });
  const stop = f.controller.stop('account_changed');
  assert.equal((await stop.local).status, 'released');
  assert.equal((await stop.server).status, 'unknown');
  assert.equal(f.createInputs.length, 1);
  assert.deepEqual(f.createInputs[0].actor, f.actor);
  assert.equal(f.hangupInputs.length, 0);
  assert.ok(f.checkedActors.every(actor => actor.accountId === f.actor.accountId));
  assert.equal(f.calls.filter(call => call === 'peer.close').length, 1);
  assert.equal(f.liability(), 'unknown');
  assert.deepEqual(f.counter(), { settled: 0, reserved: 0, unknown: 20 });
});

test('interruption silences immediately, fences playback, and clears after local cancel delivery', async t => {
  const cancel = deferred(), f = await fixture(t, { cancel });
  assert.deepEqual(await f.start(), { status: 'connected' });
  const responseId = 'synthetic-response';
  assert.equal(f.controller.observe({ type: 'response.started', responseId }), true);
  assert.equal(f.controller.observe({ type: 'playback.started', responseId }), true);
  const interrupted = f.controller.interrupt();
  // Assert synchronous local silence before the pending cancel command completes.
  assert.equal(f.calls.includes('peer.silence'), true);
  assert.equal(f.controller.snapshot().peer.playing, false);
  assert.equal(f.controller.snapshot().peer.generating, false);
  assert.equal(f.controller.observe({ type: 'playback.started', responseId }), false);
  cancel.resolve();
  assert.deepEqual(await interrupted, { attempted: true, failures: [] });
  assert.ok(f.calls.indexOf('peer.silence') < f.calls.findIndex(call => Array.isArray(call) && call[0] === 'peer.cancel'));
  assert.equal(f.calls.includes('peer.clear'), true);
  assert.deepEqual(await f.controller.interrupt(), { attempted: false, failures: [] });
  const stop = f.controller.stop('user_stop');
  assert.equal((await stop.local).status, 'released');
  assert.equal((await stop.server).status, 'unknown');
});

test('hanging hangup cannot delay local cleanup; its eventual ack cannot settle usage', async t => {
  const hangup = deferred(), f = await fixture(t, { hangup });
  assert.deepEqual(await f.start(), { status: 'connected' });
  const stop = f.controller.stop('user_stop');
  let serverDone = false;
  void stop.server.then(() => { serverDone = true; });
  await f.stopping.promise;
  assert.equal((await stop.local).status, 'released');
  assert.equal(serverDone, false);
  for (const step of ['peer.close', 'peer.silence', 'native.capture.stop', 'native.silence', 'native.deactivate', 'native.release']) {
    assert.equal(f.calls.filter(call => call === step).length, 1, step);
  }
  assert.equal(f.liability(), 'unknown');
  assert.deepEqual(f.counter(), { settled: 0, reserved: 0, unknown: 20 });
  hangup.resolve();
  assert.equal((await stop.server).status, 'unknown');
  assert.equal(f.liability(), 'unknown');
  assert.deepEqual(f.counter(), { settled: 0, reserved: 0, unknown: 20 });
  assert.deepEqual(f.hangupInputs, [{
    actor: f.actor, operationId: f.reservation.handle.reservationId, providerCallId: 'synthetic-call',
  }]);
  assert.throws(() => f.ledger.trusted.release(f.reservation.handle), /usage_release_requires_reconciliation/);
  assert.equal(f.createInputs.length, 1);
  assert.equal(f.controller.stop('user_stop'), stop);
});
