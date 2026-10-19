const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
const source = import(pathToFileURL(resolve(__dirname, '../../../../apps/form/src/voice-coaching/session-controller.ts')).href);
const account = () => ({ accountId: 'a', authSessionId: 's', accountEpoch: 1 });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function lease(fence, events, overrides = {}) {
  return {
    fence,
    stopCapture() { events.push('capture'); },
    stopPlayback() { events.push('playback'); },
    async deactivateAudio() { events.push('deactivate'); },
    async release() { events.push('release'); },
    ...overrides,
  };
}
function transport(events, overrides = {}) {
  return {
    abortPending() { events.push('abort'); },
    closeTransport() { events.push('close'); },
    async requestServerStop() { events.push('server'); },
    ...overrides,
  };
}
async function setup(overrides = {}) {
  const { VoiceSessionController, ExclusiveMicOwner } = await source;
  const events = [];
  const owner = new ExclusiveMicOwner({ async acquire({ fence }) { return lease(fence, events, overrides); } });
  const controller = new VoiceSessionController(owner, fence => {
    assert.equal(fence.accountId, 'a'); assert.equal(fence.authSessionId, 's'); assert.equal(fence.accountEpoch, 1);
  });
  return { events, owner, controller };
}
async function start(controller, ports, extra = {}) {
  return controller.start({ mode: 'standard', account: account(), signal: new AbortController().signal, transport: ports, ...extra });
}

test('local release does not wait for server acknowledgement; generation expires first', async () => {
  const { controller, events } = await setup();
  const server = deferred();
  const fence = await start(controller, transport(events, { requestServerStop: () => server.promise }));
  const teardown = controller.stop('user_stop');
  assert.throws(() => controller.assertCurrent(fence), /stale/);
  const local = await teardown.local;
  assert.deepEqual(local, { status: 'released', failedSteps: [] });
  assert.deepEqual(events, ['abort', 'close', 'capture', 'playback', 'deactivate', 'release']);
  let serverDone = false; teardown.server.then(() => { serverDone = true; });
  await Promise.resolve(); assert.equal(serverDone, false);
  server.reject(new Error('unavailable'));
  assert.deepEqual(await teardown.server, { status: 'unknown' });
});

test('capture failure still attempts every local step and blocks reacquisition', async () => {
  const { controller, events, owner } = await setup({ stopCapture() { events.push('capture'); throw new Error('failed'); } });
  await start(controller, transport(events));
  const teardown = controller.stop('interruption');
  assert.deepEqual(await teardown.local, { status: 'incomplete', failedSteps: ['stopCapture'] });
  for (const step of ['playback', 'deactivate', 'release', 'abort', 'close']) assert.ok(events.includes(step));
  await assert.rejects(start(controller, transport(events)), /busy/);
  await assert.rejects(owner.acquire({ mode: 'dictation', fence: { ...account(), generation: 2 }, signal: new AbortController().signal }), /busy/);
});

test('late acquisition after stop is disposed exactly once; repeated stop shares results', async () => {
  const { VoiceSessionController, ExclusiveMicOwner } = await source;
  const acquired = deferred(), entered = deferred(), events = [];
  let supplied;
  const owner = new ExclusiveMicOwner({ acquire(input) { supplied = input; entered.resolve(); return acquired.promise; } });
  const controller = new VoiceSessionController(owner, () => {});
  const started = start(controller, transport(events));
  await entered.promise;
  const first = controller.stop('navigation');
  assert.equal(controller.stop('background'), first);
  assert.equal(supplied.signal.aborted, true);
  acquired.resolve(lease(supplied.fence, events));
  await assert.rejects(started, /stale/);
  assert.equal((await first.local).status, 'released');
  assert.equal(controller.stop('user_stop'), first);
  assert.equal(events.filter(value => value === 'release').length, 1);
});

test('actual async deactivation and release remain awaited and block all modes', async () => {
  const deactivate = deferred(), releasing = deferred(), reachedDeactivate = deferred(), reachedRelease = deferred();
  const { controller, events, owner } = await setup({
    deactivateAudio() { reachedDeactivate.resolve(); return deactivate.promise; },
    release() { reachedRelease.resolve(); return releasing.promise; },
  });
  await start(controller, transport(events));
  const teardown = controller.stop('user_stop');
  let completed = false; teardown.local.then(() => { completed = true; });
  await reachedDeactivate.promise;
  assert.equal(completed, false);
  for (const mode of ['dictation', 'standard', 'realtime']) {
    await assert.rejects(owner.acquire({ mode, fence: { ...account(), generation: 2 }, signal: new AbortController().signal }), /busy/);
  }
  deactivate.resolve(); await reachedRelease.promise;
  assert.equal(completed, false);
  await assert.rejects(start(controller, transport(events)), /busy/);
  releasing.resolve(); assert.equal((await teardown.local).status, 'released');
  const next = await start(controller, transport(events));
  assert.ok(next.generation > 1);
  await controller.stop('user_stop').local;
});

test('failed deactivation still releases, stays incomplete, and cannot reacquire', async () => {
  const { controller, events, owner } = await setup({ async deactivateAudio() { throw new Error('unproved'); } });
  await start(controller, transport(events));
  const teardown = controller.stop('background');
  assert.deepEqual(await teardown.local, { status: 'incomplete', failedSteps: ['deactivateAudio'] });
  assert.ok(events.includes('release'));
  await assert.rejects(owner.acquire({ mode: 'realtime', fence: { ...account(), generation: 2 }, signal: new AbortController().signal }), /busy/);
});

test('failed release is not reported as released', async () => {
  const { controller, events } = await setup({ async release() { throw new Error('unproved'); } });
  await start(controller, transport(events));
  assert.deepEqual(await controller.stop('logout').local, { status: 'incomplete', failedSteps: ['release'] });
  await assert.rejects(start(controller, transport(events)), /busy/);
});

test('concurrent acquisition is denied while the driver is pending', async () => {
  const { ExclusiveMicOwner } = await source;
  const pending = deferred(); let calls = 0;
  const owner = new ExclusiveMicOwner({ acquire() { ++calls; return pending.promise; } });
  const input = { mode: 'dictation', fence: { ...account(), generation: 1 }, signal: new AbortController().signal };
  const first = owner.acquire(input);
  await assert.rejects(owner.acquire({ ...input, mode: 'realtime' }), /busy/);
  assert.equal(calls, 1);
  pending.resolve(lease(input.fence, []));
  const acquired = await first;
  await acquired.stopCapture('user_stop'); await acquired.stopPlayback('user_stop');
  await acquired.deactivateAudio('user_stop'); await acquired.release('user_stop');
});

test('abort before admission never acquires; account changes reject old pending work', async () => {
  const { VoiceSessionController, ExclusiveMicOwner } = await source;
  const pending = deferred(), entered = deferred(), events = [];
  let calls = 0, supplied, current = account();
  const owner = new ExclusiveMicOwner({ acquire(input) { ++calls; supplied = input; entered.resolve(); return pending.promise; } });
  const checked = [];
  const controller = new VoiceSessionController(owner, fence => {
    checked.push(fence.accountId);
    if (fence.accountId !== current.accountId || fence.authSessionId !== current.authSessionId || fence.accountEpoch !== current.accountEpoch) throw new Error('account_stale');
  });
  const aborted = new AbortController(); aborted.abort(new Error('aborted'));
  await assert.rejects(start(controller, transport(events), { signal: aborted.signal }), /aborted/);
  assert.equal(calls, 0);
  const input = account();
  const started = start(controller, transport(events), { account: input });
  await entered.promise;
  input.accountId = 'b'; current = { ...input, authSessionId: 'new', accountEpoch: 2 };
  pending.resolve(lease(supplied.fence, events));
  await assert.rejects(started, /account_stale/);
  assert.equal((await controller.stop('account_changed').local).status, 'released');
  assert.deepEqual(checked, ['a', 'a']);
  assert.equal(supplied.fence.accountId, 'a');
  assert.equal(calls, 1);
});

test('transport cleanup failures do not skip audio cleanup or delay server observation', async () => {
  const { controller, events } = await setup();
  await start(controller, transport(events, {
    abortPending() { throw new Error('abort failed'); },
    closeTransport() { throw new Error('close failed'); },
  }));
  const teardown = controller.stop('logout');
  assert.deepEqual(await teardown.server, { status: 'acknowledged' });
  assert.deepEqual(await teardown.local, { status: 'incomplete', failedSteps: ['abortPending', 'closeTransport'] });
  for (const step of ['capture', 'playback', 'deactivate', 'release']) assert.ok(events.includes(step));
});

test('fences require literal account, session, epoch and generation equality', async () => {
  const { sameVoiceFence } = await source;
  const fence = { ...account(), generation: 3 };
  assert.equal(sameVoiceFence(fence, { ...fence }), true);
  for (const change of [{ accountId: 'b' }, { authSessionId: 's2' }, { accountEpoch: 2 }, { generation: 4 }, { generation: '3' }]) {
    assert.equal(sameVoiceFence(fence, { ...fence, ...change }), false);
  }
});

test('abort during acquisition disposes the late lease without automatic reacquisition', async () => {
  const { VoiceSessionController, ExclusiveMicOwner } = await source;
  const pending = deferred(), entered = deferred(), events = [];
  let supplied, calls = 0;
  const owner = new ExclusiveMicOwner({ acquire(input) { ++calls; supplied = input; entered.resolve(); return pending.promise; } });
  const controller = new VoiceSessionController(owner, () => {});
  const abort = new AbortController();
  const started = start(controller, transport(events), { signal: abort.signal });
  await entered.promise; abort.abort();
  pending.resolve(lease(supplied.fence, events));
  await assert.rejects(started, /stale/);
  assert.equal((await controller.stop('aborted').local).status, 'released');
  assert.equal(calls, 1);
  assert.ok(events.includes('deactivate'));
  assert.ok(events.includes('release'));
});

test('reentrant cleanup sees the already published idempotent stop handle', async () => {
  const { controller, events } = await setup();
  let reentrant;
  await start(controller, transport(events, { abortPending() { reentrant = controller.stop('logout'); } }));
  const stopped = controller.stop('user_stop');
  assert.equal(reentrant, stopped);
  assert.equal((await stopped.local).status, 'released');
  assert.equal(events.filter(value => value === 'release').length, 1);
});

test('a rejected driver acquisition remains unproved and blocks shared ownership', async () => {
  const { VoiceSessionController, ExclusiveMicOwner } = await source;
  let calls = 0;
  const owner = new ExclusiveMicOwner({ async acquire() { ++calls; throw new Error('driver_unknown'); } });
  const controller = new VoiceSessionController(owner, () => {});
  await assert.rejects(start(controller, transport([])), /driver_unknown/);
  assert.deepEqual(await controller.stop('failed').local, { status: 'incomplete', failedSteps: ['acquire'] });
  await assert.rejects(owner.acquire({ mode: 'realtime', fence: { ...account(), generation: 2 }, signal: new AbortController().signal }), /busy/);
  assert.equal(calls, 1);
});

test('a mismatched lease is cleaned but does not establish released ownership', async () => {
  const { VoiceSessionController, ExclusiveMicOwner } = await source;
  const events = [];
  const owner = new ExclusiveMicOwner({ async acquire({ fence }) { return lease({ ...fence, accountId: 'wrong' }, events); } });
  const controller = new VoiceSessionController(owner, () => {});
  await assert.rejects(start(controller, transport(events)), /fence_mismatch/);
  assert.deepEqual(await controller.stop('failed').local, { status: 'incomplete', failedSteps: ['leaseFence'] });
  assert.ok(events.includes('release'));
  await assert.rejects(owner.acquire({ mode: 'dictation', fence: { ...account(), generation: 2 }, signal: new AbortController().signal }), /busy/);
});

test('stop before dispatch does not acquire and permits a later explicit start', async () => {
  const { VoiceSessionController, ExclusiveMicOwner } = await source;
  const events = []; let calls = 0;
  const owner = new ExclusiveMicOwner({ async acquire({ fence }) { ++calls; return lease(fence, events); } });
  const controller = new VoiceSessionController(owner, () => {});
  const started = start(controller, transport(events));
  const teardown = controller.stop('navigation');
  await assert.rejects(started);
  assert.equal((await teardown.local).status, 'released');
  assert.equal(calls, 0);
  await start(controller, transport(events));
  assert.equal(calls, 1);
  await controller.stop('user_stop').local;
});
