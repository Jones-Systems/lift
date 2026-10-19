const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Original guards and synthetic opaque handles only; transpilation stays in memory and creates no native or file-write effect.
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const compiled = ts.transpileModule(readFileSync(join(__dirname, '..', `${file}.ts`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    if (!/^\.\/(native|types|adapter|choices|lifecycle)$/.test(name)) throw new Error(`unexpected import: ${name}`);
    return load(name.slice(2));
  }, mod, mod.exports);
  modules.set(file, mod.exports);
  return mod.exports;
}
const { composeCaptureChoice } = load('choices');
const { createPhotoCaptureLifecycle } = load('lifecycle');
const { PHOTO_CAPTURE_QUALIFICATION } = load('types');
const sessionChoice = () => ({ choice: 'session_only', consentVersion: null });
const retained = version => ({ choice: 'retain', consentVersion: version });
const source = () => ({ accountId: 'synthetic-account', generation: 8,
  choices: { photos: sessionChoice(), derived: sessionChoice() } });
const fence = { accountId: 'synthetic-account', generation: 8 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const calls = [];
  const controller = new AbortController();
  const originalShell = 'opaque-shell/not-a-number';
  let shell = originalShell, authCurrent = true, bodyGeneration = 8;
  const context = {
    shellSessionGeneration: originalShell,
    isCurrentShellSession: () => shell === originalShell,
    isCurrentAuth: () => authCurrent,
    bodyFence: { ...fence },
    isCurrentBodySession: () => bodyGeneration === 8,
    signal: controller.signal,
  };
  const port = {
    synthetic: true,
    availability: async () => { calls.push(['availability']); return { ready: true, reason: 'ready' }; },
    acquire: async lease => { calls.push(['acquire', lease]); return { leaseId: lease.leaseId }; },
    capture: async (lease, view) => { calls.push(['capture', lease, view]);
      return { leaseId: lease.leaseId, frameId: `synthetic-${view}`, view }; },
    cancel: async lease => { calls.push(['cancel', lease]); return { leaseId: lease.leaseId, status: 'released' }; },
    ...overrides,
  };
  const lifecycle = createPhotoCaptureLifecycle(context, port);
  return { lifecycle, context, port, calls, controller,
    replaceShell: () => { shell = 'new-shell-same-account'; },
    revokeAuth: () => { authCurrent = false; }, revokeBody: () => { bodyGeneration++; } };
}

test('composition preserves distinct photo/derived consent versions and freezes original snapshots', () => {
  const input = source();
  input.choices = { photos: retained('photo-v2'), derived: retained('derived-v7') };
  const result = composeCaptureChoice(input, fence);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.choice, input.choices);
  input.choices.photos.consentVersion = 'replacement'; input.choices.derived.choice = 'session_only';
  assert.deepEqual(result.choice, { photos: retained('photo-v2'), derived: retained('derived-v7') });
  assert.equal(Object.isFrozen(result) && Object.isFrozen(result.choice) && Object.isFrozen(result.choice.photos), true);
});

test('mixed session-only/retain choices preserve exact versions without selecting processing or granting storage', () => {
  for (const processing of [null, 'manual_entry']) {
    for (const purpose of ['photos', 'derived']) {
      const input = { ...source(), processing };
      input.choices[purpose] = retained(' version-seen-by-user ');
      const result = composeCaptureChoice(input, fence);
      assert.equal(result.status, 'ready');
      assert.deepEqual(result.choice, input.choices);
      assert.deepEqual(Object.keys(result).sort(), ['choice', 'status']);
    }
  }
});

test('composition rejects unset, missing, malformed and legacy common-version choices', () => {
  for (const choices of [{ photos: { choice: 'unset', consentVersion: null }, derived: sessionChoice() },
    { photos: sessionChoice(), derived: { choice: 'unset', consentVersion: null } }, {}, null,
    { photos: retained(' '), derived: sessionChoice() },
    { photos: sessionChoice(), derived: { choice: 'session_only', consentVersion: 'wrong' } },
    { photos: 'retain', derived: 'session_only', consentVersion: 'legacy' }]) {
    assert.deepEqual(composeCaptureChoice({ ...source(), choices }, fence),
      { status: 'blocked', reason: 'explicit_choice_required' });
  }
});

test('composition refuses stale account/generation and invalid fences', () => {
  for (const input of [null, { ...source(), accountId: 'other-account' }, { ...source(), generation: 9 },
    { ...source(), generation: NaN }, { ...source(), generation: -1 }]) {
    assert.deepEqual(composeCaptureChoice(input, fence), { status: 'blocked', reason: 'stale_session' });
  }
  assert.equal(composeCaptureChoice(source(), { ...fence, generation: 8.5 }).reason, 'stale_session');
});

test('lifecycle preserves original opaque shell token, numeric fence and bound methods despite caller mutation', async () => {
  const f = fixture();
  f.context.shellSessionGeneration = 'replacement-token'; f.context.bodyFence.generation = 999;
  f.context.isCurrentShellSession = () => false; f.context.isCurrentAuth = () => false;
  f.context.isCurrentBodySession = () => false;
  f.port.cancel = async () => { throw new Error('replacement must not run'); };
  const lease = await f.lifecycle.acquire(source());
  assert.deepEqual(f.lifecycle.identity, { shellSessionGeneration: 'opaque-shell/not-a-number', bodyFence: fence });
  assert.equal(lease.generation, 8);
  assert.equal(Object.isFrozen(f.lifecycle) && Object.isFrozen(f.lifecycle.identity.bodyFence), true);
  assert.equal((await f.lifecycle.close('unmount')).status, 'released');
  assert.equal(f.calls.at(-1)[1], lease);
});

test('lifecycle acquisition snapshots both purpose records before pending native work', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ acquire: lease => { entered.resolve(lease); return gate.promise; } });
  const input = source(); input.choices = { photos: retained('photo-v4'), derived: retained('derived-v9') };
  const start = f.lifecycle.acquire(input); const lease = await entered.promise;
  input.choices.photos.consentVersion = 'replacement'; input.choices.derived = sessionChoice();
  gate.resolve({ leaseId: lease.leaseId }); await start;
  assert.deepEqual(f.lifecycle.getChoice(), { photos: retained('photo-v4'), derived: retained('derived-v9') });
  await f.lifecycle.close('cancel'); assert.equal(f.lifecycle.getChoice(), null);
});

test('same account with a new shell session blocks acquire after a pending probe', async () => {
  const gate = deferred();
  const f = fixture({ availability: () => gate.promise });
  const start = f.lifecycle.acquire(source());
  f.replaceShell(); gate.resolve({ ready: true, reason: 'ready' });
  await assert.rejects(start, { code: 'stale_session' });
  assert.deepEqual(f.calls, []); assert.equal(f.lifecycle.getState().lease, null);
});

test('original auth revocation rejects late acquire and preserves exact unknown cleanup without retry', async () => {
  const gate = deferred(), entered = deferred(); let cancellations = 0;
  const f = fixture({ acquire: lease => { entered.resolve(lease); return gate.promise; },
    cancel: async lease => { cancellations++; return { leaseId: lease.leaseId, status: 'unknown' }; } });
  const start = f.lifecycle.acquire(source()); const lease = await entered.promise;
  f.revokeAuth(); gate.resolve({ leaseId: lease.leaseId });
  await assert.rejects(start, { code: 'stale_session' });
  const cleanup = await f.lifecycle.close('unmount');
  assert.equal(cleanup.status, 'unknown'); assert.equal(cleanup.lease, lease); assert.equal(cleanup.erasureConfirmed, false);
  assert.equal(await f.lifecycle.close('account_change'), cleanup); assert.equal(cancellations, 1);
  assert.equal(f.lifecycle.getState().lease, lease); assert.equal(f.lifecycle.getChoice(), null);
});

test('body generation revocation rejects a late frame and clears previously staged handles', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ capture: (lease, view) => {
    if (view === 'front') return Promise.resolve({ leaseId: lease.leaseId, frameId: 'synthetic-front', view });
    entered.resolve(lease); return gate.promise;
  } });
  await f.lifecycle.acquire(source()); await f.lifecycle.capture('front');
  const capture = f.lifecycle.capture('side'); const lease = await entered.promise;
  f.revokeBody(); assert.deepEqual(f.lifecycle.getState().frames, []);
  gate.resolve({ leaseId: lease.leaseId, frameId: 'late-side', view: 'side' });
  await assert.rejects(capture, { code: 'stale_session' });
  assert.equal((await f.lifecycle.close('revoke')).lease, lease);
});

test('background and unmount invalidate immediately before awaiting original pending frame cleanup', async () => {
  for (const reason of ['background', 'unmount']) {
    const gate = deferred(), entered = deferred();
    const f = fixture({ capture: (lease, view) => { entered.resolve({ lease, view }); return gate.promise; },
      cancel: async lease => ({ leaseId: lease.leaseId, status: 'unknown' }) });
    await f.lifecycle.acquire(source());
    const capture = f.lifecycle.capture('front'); const { lease } = await entered.promise;
    const closing = f.lifecycle.close(reason);
    assert.equal(f.lifecycle.getChoice(), null); assert.deepEqual(f.lifecycle.getState().frames, []);
    assert.equal(f.lifecycle.getState().phase, 'closing');
    gate.resolve({ leaseId: lease.leaseId, frameId: 'late-front', view: 'front' });
    await assert.rejects(capture, { code: 'stale_session' });
    const cleanup = await closing;
    assert.equal(cleanup.lease, lease); assert.equal(cleanup.status, 'unknown'); assert.equal(cleanup.erasureConfirmed, false);
  }
});

test('original external AbortSignal remains bound after context mutation and clears staging', async () => {
  const f = fixture(); const lease = await f.lifecycle.acquire(source()); await f.lifecycle.capture('front');
  f.context.signal = new AbortController().signal;
  f.controller.abort();
  assert.deepEqual(f.lifecycle.getState().frames, []); assert.equal(f.lifecycle.getChoice(), null);
  await assert.rejects(f.lifecycle.capture('side'), { code: 'stale_session' });
  assert.equal((await f.lifecycle.close('cancel')).lease, lease);
});

test('each original guard blocks pre-dispatch work; unset or stale choices never dispatch', async () => {
  for (const invalidate of ['replaceShell', 'revokeAuth', 'revokeBody']) {
    const f = fixture(); f[invalidate]();
    await assert.rejects(f.lifecycle.acquire(source()), { code: 'stale_session' }); assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  await assert.rejects(f.lifecycle.acquire({ ...source(), generation: 9 }), { code: 'stale_session' });
  await assert.rejects(f.lifecycle.acquire({ ...source(), choices: { photos: { choice: 'unset', consentVersion: null },
    derived: sessionChoice() } }), { code: 'explicit_choice_required' });
  assert.deepEqual(f.calls, []);
});

test('default lifecycle stays unavailable and qualification flags never change', async () => {
  const f = fixture(); const lifecycle = createPhotoCaptureLifecycle(f.context);
  assert.deepEqual(await lifecycle.availability(), { ready: false, reason: 'native_module_missing' });
  await assert.rejects(lifecycle.acquire(source()), { code: 'native_module_missing' });
  assert.equal(Object.values(PHOTO_CAPTURE_QUALIFICATION).every(flag => flag === false), true);
});
