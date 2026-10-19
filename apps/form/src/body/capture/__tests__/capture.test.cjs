const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Synthetic port only. Transpile in memory; no camera, permission, file write, timer, provider or SDK call.
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const compiled = ts.transpileModule(readFileSync(join(__dirname, '..', `${file}.ts`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (!/^\.\/(native|types|adapter|choices)$/.test(name)) throw new Error(`unexpected import: ${name}`);
    return load(name.slice(2));
  }, mod, mod.exports);
  modules.set(file, mod.exports);
  return mod.exports;
}
const { FormPhotoCaptureAdapter } = load('adapter');
const { PHOTO_CAPTURE_QUALIFICATION } = load('types');
const { createPhotoCapturePort } = load('native');
const choice = { photos: { choice: 'session_only', consentVersion: null },
  derived: { choice: 'session_only', consentVersion: null } };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const calls = [];
  const controller = new AbortController();
  let current = true;
  const port = {
    synthetic: true,
    availability: async () => ({ ready: true, reason: 'ready' }),
    acquire: async lease => { calls.push(['acquire', lease]); return { leaseId: lease.leaseId }; },
    capture: async (lease, view) => { calls.push(['capture', lease, view]);
      return { leaseId: lease.leaseId, frameId: `synthetic-${view}`, view }; },
    cancel: async lease => { calls.push(['cancel', lease]); return { leaseId: lease.leaseId, status: 'released' }; },
    ...overrides,
  };
  const context = { accountId: 'synthetic-account', generation: 7, signal: controller.signal,
    isCurrentSession: () => current };
  const adapter = new FormPhotoCaptureAdapter(context, port);
  return { adapter, calls, controller, context, port, stale: () => { current = false; } };
}

test('default binding refuses acquire and every immutable qualification flag stays false', async () => {
  const f = fixture();
  const adapter = new FormPhotoCaptureAdapter(f.context);
  assert.deepEqual(await adapter.availability(), { ready: false, reason: 'native_module_missing' });
  await assert.rejects(adapter.acquire(choice), { code: 'native_module_missing' });
  assert.equal(adapter.getState().lease, null);
  assert.equal(Object.isFrozen(PHOTO_CAPTURE_QUALIFICATION), true);
  assert.equal(Object.values(PHOTO_CAPTURE_QUALIFICATION).every(value => value === false), true);
  assert.equal(Object.isFrozen(createPhotoCapturePort(null)), true);
});

test('separate explicit choices and retained consent are required before native dispatch', async () => {
  for (const invalid of [null, {}, { ...choice, photos: null }, { ...choice, derived: null },
    { ...choice, photos: { choice: 'unset', consentVersion: null } },
    { ...choice, derived: { choice: 'retain', consentVersion: ' ' } },
    { ...choice, photos: { choice: 'retain', consentVersion: 7 } },
    { ...choice, photos: { choice: 'session_only', consentVersion: 'not-null' } },
    { photos: 'retain', derived: 'session_only', consentVersion: 'legacy-v1' }]) {
    const f = fixture();
    await assert.rejects(f.adapter.acquire(invalid), { code: 'explicit_choice_required' });
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  await f.adapter.acquire({ ...choice, photos: { choice: 'retain', consentVersion: 'synthetic-v1' } });
  assert.deepEqual(f.adapter.getState().frames, []);
  assert.equal(f.calls.length, 1, 'choice never creates a save operation');
});

test('malformed bridge readiness never dispatches acquire', async () => {
  for (const result of [null, {}, { ready: 'true', reason: 'ready' }, { ready: 1, reason: 'ready' },
    { ready: true, reason: 'native_capture_unqualified' }, { ready: false, reason: 'ready' },
    { ready: true, reason: 'ready', uri: 'synthetic://forbidden' }]) {
    const f = fixture({ availability: async () => result });
    await assert.rejects(f.adapter.acquire(choice), { code: 'native_probe_failed' });
    assert.deepEqual(f.calls, []);
    assert.equal(f.adapter.getState().lease, null);
  }
});

test('front and side stage opaque handles; duplicate views and other constructs are refused', async () => {
  const f = fixture();
  const lease = await f.adapter.acquire(choice);
  await f.adapter.capture('front');
  await f.adapter.capture('side');
  await assert.rejects(f.adapter.capture('front'), { code: 'invalid_view' });
  await assert.rejects(f.adapter.capture('posture'), { code: 'invalid_view' });
  const state = f.adapter.getState();
  assert.equal(state.assessment, 'unable_to_assess');
  assert.deepEqual(state.frames.map(frame => frame.view), ['front', 'side']);
  assert.equal(Object.isFrozen(lease) && Object.isFrozen(state.frames[0]), true);
  const cleanup = await f.adapter.close('cancel');
  assert.equal(cleanup.status, 'released');
  assert.equal(cleanup.erasureConfirmed, false);
  assert.deepEqual(f.adapter.getState().frames, []);
});

test('mutable context and binding cannot retarget the original lease or cancellation method', async () => {
  const f = fixture();
  f.context.accountId = 'other-account'; f.context.generation = 900;
  f.port.cancel = async () => { throw new Error('replacement must not run'); };
  const lease = await f.adapter.acquire(choice);
  assert.equal(lease.accountId, 'synthetic-account'); assert.equal(lease.generation, 7);
  assert.equal((await f.adapter.close('account_change')).status, 'released');
  assert.equal(f.calls.at(-1)[1], lease);
});

test('stale account or generation after availability blocks acquire dispatch', async () => {
  const gate = deferred();
  const f = fixture({ availability: () => gate.promise });
  const start = f.adapter.acquire(choice);
  f.stale(); gate.resolve({ ready: true, reason: 'ready' });
  await assert.rejects(start, { code: 'stale_session' });
  assert.deepEqual(f.calls, []);
});

test('cancellation overtaking acquire waits for original lease then cancels it; never activates', async () => {
  const gate = deferred(); const entered = deferred();
  const f = fixture({ acquire: lease => { entered.resolve(lease); return gate.promise; } });
  const start = f.adapter.acquire(choice);
  const lease = await entered.promise;
  const cleanup = f.adapter.close('background');
  assert.equal(f.adapter.getState().phase, 'closing');
  gate.resolve({ leaseId: lease.leaseId });
  await assert.rejects(start, { code: 'stale_session' });
  assert.equal((await cleanup).status, 'released');
  assert.deepEqual(f.calls, [['cancel', lease]]);
});

test('abort rejects a late capture frame and clears staging before cleanup', async () => {
  const gate = deferred(); const entered = deferred();
  const f = fixture({ capture: (lease, view) => { entered.resolve({ lease, view }); return gate.promise; } });
  await f.adapter.acquire(choice);
  const capture = f.adapter.capture('front');
  const { lease } = await entered.promise;
  f.controller.abort();
  assert.deepEqual(f.adapter.getState().frames, []);
  gate.resolve({ leaseId: lease.leaseId, frameId: 'late-synthetic', view: 'front' });
  await assert.rejects(capture, { code: 'stale_session' });
  assert.equal((await f.adapter.close('cancel')).status, 'released');
  assert.deepEqual(f.adapter.getState().frames, []);
});

test('every lifecycle close invalidates synchronously and preserves exact cleanup identity', async () => {
  for (const reason of ['cancel', 'background', 'revoke', 'account_change', 'unmount']) {
    const f = fixture(); const lease = await f.adapter.acquire(choice);
    await f.adapter.capture('front');
    const closing = f.adapter.close(reason);
    assert.deepEqual(f.adapter.getState().frames, []);
    await assert.rejects(f.adapter.capture('side'), { code: 'stale_session' });
    const cleanup = await closing;
    assert.equal(cleanup.lease, lease); assert.equal(cleanup.erasureConfirmed, false);
    assert.equal(f.calls.at(-1)[1], lease);
  }
});

test('failed acquire still cancels its original lease because rejection cannot prove no effect', async () => {
  const f = fixture({ acquire: async () => { throw new Error('uncertain acquire'); } });
  await assert.rejects(f.adapter.acquire(choice), /uncertain acquire/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'cancel');
  assert.equal(f.adapter.getState().phase, 'released');
});

test('malformed or mismatched acquire response closes its original lease', async () => {
  for (const result of [null, { leaseId: 'wrong' }, { leaseId: 'wrong', uri: 'synthetic://forbidden' }]) {
    const f = fixture({ acquire: async () => result });
    await assert.rejects(f.adapter.acquire(choice), { code: 'lease_mismatch' });
    assert.equal(f.calls[0][0], 'cancel');
    assert.equal(f.adapter.getState().phase, 'released');
  }
});

test('unknown, thrown or mismatched cleanup retains lease and never retries or claims erasure', async () => {
  for (const cancel of [async lease => ({ leaseId: lease.leaseId, status: 'unknown' }),
    async () => { throw new Error('uncertain cancel'); },
    async () => ({ leaseId: 'wrong-lease', status: 'released' })]) {
    let count = 0;
    const f = fixture({ cancel: lease => { count++; return cancel(lease); } });
    const lease = await f.adapter.acquire(choice);
    const cleanup = await f.adapter.close('revoke');
    assert.equal(cleanup.status, 'unknown'); assert.equal(cleanup.lease, lease);
    assert.equal(cleanup.erasureConfirmed, false);
    assert.equal(f.adapter.getState().lease, lease);
    assert.equal(await f.adapter.close('unmount'), cleanup); assert.equal(count, 1);
    await assert.rejects(f.adapter.acquire(choice), { code: 'stale_session' });
  }
});

test('bridge refuses URI, bytes, wrong-view and mismatched-lease results and closes original lease', async () => {
  for (const patch of [{ uri: 'synthetic://forbidden' }, { bytes: 'synthetic-bytes' },
    { view: 'side' }, { leaseId: 'wrong' }, { frameId: '' }]) {
    const f = fixture({ capture: async (lease, view) =>
      ({ leaseId: lease.leaseId, frameId: 'synthetic-frame', view, ...patch }) });
    const lease = await f.adapter.acquire(choice);
    await assert.rejects(f.adapter.capture('front'), { code: 'invalid_frame' });
    assert.deepEqual(f.adapter.getState().frames, []);
    assert.deepEqual(f.calls.at(-1), ['cancel', lease]);
  }
});

test('concurrent capture and acquire are refused without dispatch', async () => {
  const gate = deferred(); const entered = deferred();
  const f = fixture({ capture: (lease, view) => { entered.resolve(lease); return gate.promise; } });
  await f.adapter.acquire(choice);
  const capture = f.adapter.capture('front'); const lease = await entered.promise;
  await assert.rejects(f.adapter.capture('side'), { code: 'capture_unavailable' });
  await assert.rejects(f.adapter.acquire(choice), { code: 'busy' });
  gate.resolve({ leaseId: lease.leaseId, frameId: 'synthetic-front', view: 'front' });
  await capture; await f.adapter.close('cancel');
});
