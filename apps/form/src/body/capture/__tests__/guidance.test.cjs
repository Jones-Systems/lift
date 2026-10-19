const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Synthetic permission and preview tokens only; all TS compilation is in memory, with no native or file-write effect.
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const code = ts.transpileModule(readFileSync(join(__dirname, '..', `${file}.ts`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => {
    if (!/^\.\/(native|types|adapter|choices|lifecycle)$/.test(name)) throw new Error(`unexpected import: ${name}`);
    return load(name.slice(2));
  }, mod, mod.exports);
  modules.set(file, mod.exports); return mod.exports;
}
const { createPhotoCaptureLifecycle } = load('lifecycle');
const { PHOTO_CAPTURE_QUALIFICATION } = load('types');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject }; };
const source = () => ({ accountId: 'synthetic-owner', generation: 4,
  choices: { photos: { choice: 'retain', consentVersion: 'photos-v2' },
    derived: { choice: 'retain', consentVersion: 'derived-v9' } } });
function fixture(overrides = {}) {
  const calls = [], controller = new AbortController();
  const original = 'original-opaque-shell';
  let shell = original, auth = true, generation = 4, frames = 0;
  const context = { shellSessionGeneration: original, bodyFence: { accountId: 'synthetic-owner', generation: 4 },
    isCurrentShellSession: () => shell === original, isCurrentAuth: () => auth,
    isCurrentBodySession: () => generation === 4, signal: controller.signal };
  const port = {
    synthetic: true,
    availability: async () => ({ ready: true, reason: 'ready' }),
    acquire: async (lease, scope) => { calls.push(['acquire', lease, scope]); return { leaseId: lease.leaseId }; },
    capture: async (lease, view, scope) => { calls.push(['capture', lease, view, scope]);
      return { leaseId: lease.leaseId, view, frameId: `synthetic-frame-${++frames}` }; },
    cancel: async (lease, scope) => { calls.push(['cancel', lease, scope]); return { leaseId: lease.leaseId, status: 'released' }; },
    permissionStatus: async scope => { calls.push(['permissionStatus', scope]); return { status: 'not_determined' }; },
    requestPermission: async (scope, requestId) => { calls.push(['requestPermission', scope, requestId]); return { requestId, status: 'granted' }; },
    permissionRetirement: operation => ({ operation, status: 'retired' }),
    preview: async (lease, frame, scope) => { calls.push(['preview', lease, frame, scope]);
      return { ...frame, previewId: `synthetic-preview-${frame.frameId}` }; },
    retake: async (lease, frame, scope) => { calls.push(['retake', lease, frame, scope]);
      return { leaseId: lease.leaseId, view: frame.view, status: 'captured', frameId: `synthetic-replacement-${++frames}`,
        replacedFrameId: frame.frameId }; },
    invalidatePreviews: (lease, frame, scope) => { calls.push(['invalidate', lease, frame, scope]);
      return { leaseId: lease.leaseId, status: 'invalidated' }; },
    ...overrides,
  };
  const lifecycle = createPhotoCaptureLifecycle(context, port);
  return { lifecycle, calls, port, context, controller,
    relogin: () => { shell = 'replacement-shell-same-account'; },
    revokeAuth: () => { auth = false; }, revokeBody: () => { generation++; } };
}
async function staged(f) {
  const lease = await f.lifecycle.acquire(source());
  const front = await f.lifecycle.capture('front'), side = await f.lifecycle.capture('side');
  const frontPreview = await f.lifecycle.preview('front'), sidePreview = await f.lifecycle.preview('side');
  return { lease, front, side, frontPreview, sidePreview };
}

test('default guidance remains unavailable without changing qualification', async () => {
  const f = fixture(), lifecycle = createPhotoCaptureLifecycle(f.context);
  for (const operation of ['permissionStatus', 'requestPermission']) {
    assert.deepEqual(await lifecycle[operation](source()), { status: 'unavailable', reason: 'native_module_missing' });
  }
  assert.deepEqual(f.calls, []);
  assert.equal(Object.values(PHOTO_CAPTURE_QUALIFICATION).every(flag => flag === false), true);
  assert.equal(lifecycle.getScope(), null);
});

test('close during OS prompt preserves exact permission identity independently of released camera lease', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ requestPermission: (scope, requestId) => { entered.resolve({ scope, requestId }); return gate.promise; },
    permissionRetirement: operation => ({ operation, status: 'unknown' }) });
  const input = source(), pending = f.lifecycle.requestPermission(input), original = await entered.promise;
  input.choices.photos.consentVersion = 'replacement';
  const cleanup = await f.lifecycle.close('background');
  assert.equal(cleanup.status, 'unknown'); assert.equal(cleanup.leaseStatus, 'released'); assert.equal(cleanup.lease, null);
  assert.deepEqual(cleanup.permissionRetirement, { operation: { requestId: original.requestId, scope: original.scope }, status: 'unknown' });
  assert.equal(cleanup.permissionRetirement.operation.scope.choices.photos.consentVersion, 'photos-v2');
  assert.equal(f.lifecycle.getState().permission, null);
  gate.resolve({ requestId: original.requestId, status: 'granted' });
  await assert.rejects(pending, { code: 'stale_session' });
  assert.equal((await f.lifecycle.close('unmount')), cleanup);
  assert.equal(cleanup.permissionRetirement.status, 'unknown');
});

test('rejected permission promise is not an OS callback retirement witness and forbids another producer', async () => {
  const gate = deferred(), entered = deferred(); let retirement = 'unknown';
  const f = fixture({ requestPermission: (scope, requestId) => { entered.resolve({ scope, requestId }); return gate.promise; },
    permissionRetirement: operation => ({ operation, status: retirement }) });
  const pending = f.lifecycle.requestPermission(source()), original = await entered.promise;
  gate.reject(new Error('Form promise rejected while OS callback remains outstanding'));
  assert.deepEqual(await pending, { status: 'unknown' });
  assert.equal(f.lifecycle.getState().permissionRetirement.status, 'unknown');
  await assert.rejects(f.lifecycle.acquire(source()), { code: 'permission_cleanup_unknown' });
  await assert.rejects(f.lifecycle.requestPermission(source()), { code: 'permission_cleanup_unknown' });
  retirement = 'retired';
  const cleanup = await f.lifecycle.close('cancel');
  assert.equal(cleanup.status, 'released');
  assert.deepEqual(cleanup.permissionRetirement.operation, original);
  assert.equal(cleanup.permissionRetirement.status, 'retired');
});

test('missing or mismatched permission retirement remains original unknown custody after same-account relogin', async () => {
  for (const receipt of [undefined, operation => ({ operation: { ...operation, requestId: 'replacement' }, status: 'retired' }),
    operation => ({ operation: { ...operation, scope: { ...operation.scope, shellSessionGeneration: 'replacement' } }, status: 'not_requested' }),
    operation => ({ operation, status: 'retired', cancelledOSDialog: true })]) {
    const gate = deferred(), entered = deferred();
    const f = fixture({ requestPermission: (scope, requestId) => { entered.resolve({ scope, requestId }); return gate.promise; },
      permissionRetirement: receipt });
    const pending = f.lifecycle.requestPermission(source()), original = await entered.promise;
    f.relogin(); gate.resolve({ requestId: original.requestId, status: 'granted' });
    await assert.rejects(pending, { code: 'stale_session' });
    const cleanup = await f.lifecycle.close('account_change');
    assert.equal(cleanup.status, 'unknown'); assert.equal(cleanup.leaseStatus, 'released');
    assert.deepEqual(cleanup.permissionRetirement.operation, original);
    assert.equal(cleanup.permissionRetirement.status, 'unknown');
  }
});

test('exact creator scope reaches cancellation unchanged after disposal clears public scope', async () => {
  const f = fixture(), input = source(); const lease = await f.lifecycle.acquire(input);
  const original = f.calls.find(call => call[0] === 'acquire')[2]; input.choices.derived.consentVersion = 'replacement';
  await f.lifecycle.close('unmount');
  const cancel = f.calls.find(call => call[0] === 'cancel');
  assert.equal(cancel[1], lease); assert.equal(cancel[2], original); assert.equal(Object.isFrozen(cancel[2]), true);
  assert.equal(f.lifecycle.getScope(), null);
});

test('production ports require original trusted creator nonce and never use a counter fallback', async () => {
  const f = fixture({ synthetic: undefined });
  await assert.rejects(f.lifecycle.acquire(source()), { code: 'creator_identity_unavailable' });
  await assert.rejects(f.lifecycle.requestPermission(source()), { code: 'creator_identity_unavailable' });
  assert.deepEqual(f.calls, []); assert.equal(f.lifecycle.getState().phase, 'idle');
});

test('late native acknowledgement adds exact operation custody without granting stale session authority', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ synthetic: undefined,
    acquire: (lease, scope) => { entered.resolve({ lease, scope }); return gate.promise; } });
  const originalNonce = 'synthetic-cryptographic-creator-nonce'; let nonceCalls = 0;
  f.context.createRequestId = () => { nonceCalls++; return originalNonce; };
  const lifecycle = createPhotoCaptureLifecycle(f.context, f.port);
  const pending = lifecycle.acquire(source()), original = await entered.promise;
  f.context.createRequestId = () => { throw new Error('replacement generator'); };
  const cleanupPromise = lifecycle.close('background');
  gate.resolve({ leaseId: original.lease.leaseId, requestId: originalNonce, operationId: 'synthetic-native-operation-uuid' });
  await assert.rejects(pending, { code: 'stale_session' });
  const cleanup = await cleanupPromise, cancel = f.calls.find(call => call[0] === 'cancel');
  assert.equal(nonceCalls, 1); assert.equal(cleanup.lease.requestId, originalNonce);
  assert.equal(cleanup.lease.operationId, 'synthetic-native-operation-uuid');
  assert.equal(cancel[1], cleanup.lease); assert.equal(cancel[2], original.scope);
  assert.equal(lifecycle.getChoice(), null); assert.deepEqual(lifecycle.getState().frames, []);
});

test('rejected acquire preserves original creator descriptor for acknowledgement-free exact cleanup', async () => {
  const f = fixture({ synthetic: undefined, acquire: async () => { throw new Error('possibly effective acquire'); } });
  f.context.createRequestId = () => 'synthetic-original-creator-nonce';
  const lifecycle = createPhotoCaptureLifecycle(f.context, f.port);
  await assert.rejects(lifecycle.acquire(source()), /possibly effective acquire/);
  const cleanup = await lifecycle.close('cancel'), cancel = f.calls.find(call => call[0] === 'cancel');
  assert.equal(cleanup.lease.requestId, 'synthetic-original-creator-nonce');
  assert.equal(cleanup.lease.operationId, undefined); assert.equal(cancel[1], cleanup.lease);
  assert.equal(cancel[2].shellSessionGeneration, 'original-opaque-shell');
});

test('permission status and explicit request preserve denied/restricted/unavailable and never acquire', async () => {
  for (const result of [{ status: 'not_determined' }, { status: 'granted' }, { status: 'denied' },
    { status: 'restricted' }, { status: 'unknown' },
    ...['native_capture_unqualified', 'native_module_missing', 'configuration_missing', 'native_capture_unavailable']
      .map(reason => ({ status: 'unavailable', reason }))]) {
    let requests = 0;
    const f = fixture({ permissionStatus: async () => result,
      requestPermission: async (_scope, requestId) => { requests++; return { ...result, requestId }; } });
    assert.deepEqual(await f.lifecycle.permissionStatus(source()), result); assert.equal(requests, 0);
    assert.deepEqual(await f.lifecycle.requestPermission(source()), result); assert.equal(requests, 1);
    assert.deepEqual(f.calls, []); assert.equal(f.lifecycle.getState().lease, null);
  }
});

test('acquisition does not request permission implicitly, even after a granted result', async () => {
  const f = fixture(); await f.lifecycle.requestPermission(source());
  const lease = await f.lifecycle.acquire(source());
  assert.equal(f.calls.filter(call => call[0] === 'requestPermission').length, 1);
  assert.equal(f.calls.find(call => call[0] === 'acquire')[2].shellSessionGeneration, 'original-opaque-shell');
  assert.equal((await f.lifecycle.close('cancel')).lease, lease);
});

test('malformed permission shapes, request identity and payloads fail closed to unknown', async () => {
  for (const patch of [null, {}, { status: true }, { status: 'granted', reason: 'ready' },
    { status: 'unavailable', reason: 'ready' }, { status: 'granted', uri: 'synthetic://forbidden' },
    { status: 'granted', requestId: 'replacement-request' }]) {
    const f = fixture({ requestPermission: async (_scope, requestId) => patch && { requestId, ...patch } });
    assert.deepEqual(await f.lifecycle.requestPermission(source()), { status: 'unknown' });
    assert.deepEqual(f.calls, []);
  }
});

test('pending permission preserves original shell/body/consent snapshots and refuses concurrent work', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ requestPermission: (scope, id) => { entered.resolve({ scope, id }); return gate.promise; } });
  const input = source(), pending = f.lifecycle.requestPermission(input); const { scope, id } = await entered.promise;
  input.choices.photos.consentVersion = 'replacement'; input.choices.derived.consentVersion = 'also-replacement';
  f.context.shellSessionGeneration = 'replacement'; f.context.bodyFence.generation = 8;
  f.context.isCurrentAuth = () => false; f.context.signal = new AbortController().signal;
  await assert.rejects(f.lifecycle.acquire(source()), { code: 'busy' });
  await assert.rejects(f.lifecycle.requestPermission(source()), { code: 'busy' });
  assert.deepEqual(scope.choices, source().choices); assert.equal(scope.shellSessionGeneration, 'original-opaque-shell');
  assert.equal(scope.generation, 4); assert.equal(Object.isFrozen(scope.choices.photos), true);
  gate.resolve({ requestId: id, status: 'granted' }); assert.deepEqual(await pending, { status: 'granted' });
  await f.lifecycle.close('cancel');
});

test('same-account replacement shell discards an already requested OS permission callback', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ requestPermission: (_scope, id) => { entered.resolve(id); return gate.promise; } });
  const pending = f.lifecycle.requestPermission(source()), id = await entered.promise;
  f.relogin(); gate.resolve({ requestId: id, status: 'granted' });
  await assert.rejects(pending, { code: 'stale_session' });
  assert.equal(f.lifecycle.getState().permission, null); assert.equal(f.lifecycle.getScope(), null);
  assert.deepEqual(f.calls, []);
});

test('background/unmount/auth/body/abort invalidation discards pending permission without pretending OS cancellation', async () => {
  for (const effect of ['background', 'unmount', 'revokeAuth', 'revokeBody', 'abort']) {
    const gate = deferred(), entered = deferred();
    const f = fixture({ requestPermission: (_scope, id) => { entered.resolve(id); return gate.promise; } });
    const pending = f.lifecycle.requestPermission(source()), id = await entered.promise;
    if (effect === 'abort') f.controller.abort();
    else if (effect.startsWith('revoke')) f[effect]();
    const cleanup = await f.lifecycle.close(effect.startsWith('revoke') ? 'revoke' : effect === 'abort' ? 'cancel' : effect);
    assert.equal(cleanup.lease, null); assert.equal(cleanup.erasureConfirmed, false);
    assert.equal(f.lifecycle.getState().permission, null);
    gate.resolve({ requestId: id, status: 'denied' }); await assert.rejects(pending, { code: 'stale_session' });
    assert.deepEqual(f.calls, []);
  }
});

test('old base ports lack guidance and fail closed; captured original guidance methods cannot be replaced', async () => {
  const f = fixture(); delete f.port.permissionStatus; delete f.port.requestPermission;
  const old = createPhotoCaptureLifecycle(f.context, f.port);
  assert.deepEqual(await old.requestPermission(source()), { status: 'unavailable', reason: 'native_module_missing' });
  f.port.requestPermission = async () => { throw new Error('replacement must not run'); };
  assert.deepEqual(await f.lifecycle.requestPermission(source()), { status: 'granted' });
  await f.lifecycle.close('cancel'); await old.close('cancel');
});

test('preview is an immutable exact frame/lease/view token and missing views never dispatch', async () => {
  const f = fixture(); await f.lifecycle.acquire(source());
  await assert.rejects(f.lifecycle.preview('front'), { code: 'preview_unavailable' });
  const frame = await f.lifecycle.capture('front'), preview = await f.lifecycle.preview('front');
  assert.deepEqual(Object.keys(preview).sort(), ['frameId', 'leaseId', 'previewId', 'view']);
  assert.equal(preview.frameId, frame.frameId); assert.equal(Object.isFrozen(preview), true);
  assert.equal(await f.lifecycle.preview('front'), preview);
  assert.equal(f.calls.filter(call => call[0] === 'preview').length, 1);
  assert.deepEqual(f.lifecycle.getScope().choices, source().choices);
  await f.lifecycle.close('unmount'); assert.deepEqual(f.lifecycle.getState().previews, []);
});

test('preview rejects bytes/base64/URI and wrong token identities with exact cleanup', async () => {
  for (const patch of [{ bytes: 'forbidden' }, { base64: 'forbidden' }, { uri: 'synthetic://forbidden' },
    { frameId: 'wrong-frame' }, { leaseId: 'wrong-lease' }, { view: 'side' }, { previewId: '' }]) {
    const f = fixture({ preview: async (_lease, frame) => ({ ...frame, previewId: 'synthetic-preview', ...patch }) });
    const lease = await f.lifecycle.acquire(source()); await f.lifecycle.capture('front');
    const originalScope = f.lifecycle.getScope();
    await assert.rejects(f.lifecycle.preview('front'), { code: 'invalid_preview' });
    assert.deepEqual(f.calls.at(-1), ['cancel', lease, originalScope]); assert.equal(f.lifecycle.getScope(), null);
    assert.deepEqual(f.lifecycle.getState().previews, []);
  }
});

test('close invalidates native preview tokens synchronously before a pending preview settles and exact cleanup', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ preview: (_lease, frame) => { entered.resolve(frame); return gate.promise; },
    cancel: async lease => ({ leaseId: lease.leaseId, status: 'unknown' }) });
  const lease = await f.lifecycle.acquire(source()); await f.lifecycle.capture('front');
  const pending = f.lifecycle.preview('front'), frame = await entered.promise;
  const closing = f.lifecycle.close('background');
  assert.equal(f.calls.at(-1)[0], 'invalidate'); assert.equal(f.calls.at(-1)[1], lease);
  assert.equal(f.calls.at(-1)[2], null); assert.deepEqual(f.lifecycle.getState().previews, []);
  gate.resolve({ ...frame, previewId: 'late-preview' }); await assert.rejects(pending, { code: 'stale_session' });
  const cleanup = await closing; assert.equal(cleanup.status, 'unknown'); assert.equal(cleanup.lease, lease);
  assert.equal(await f.lifecycle.close('unmount'), cleanup);
  assert.equal(f.calls.filter(call => call[0] === 'invalidate').length, 1);
});

test('one-view retake drops obsolete staging/preview before await and preserves the other view', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ retake: (_lease, frame) => { entered.resolve(frame); return gate.promise; } });
  const original = await staged(f), pending = f.lifecycle.retake('front');
  assert.deepEqual(f.lifecycle.getState().frames, [original.side]);
  assert.deepEqual(f.lifecycle.getState().previews, [original.sidePreview]);
  assert.equal(f.calls.at(-1)[0], 'invalidate'); assert.equal(f.calls.at(-1)[2], original.front);
  const replaced = await entered.promise;
  gate.resolve({ leaseId: original.lease.leaseId, view: 'front', frameId: 'replacement-front',
    status: 'captured', replacedFrameId: replaced.frameId });
  const result = await pending; assert.equal(result.status, 'captured');
  assert.deepEqual(f.lifecycle.getState().frames.map(frame => frame.frameId), [original.side.frameId, 'replacement-front']);
  assert.equal(await f.lifecycle.preview('side'), original.sidePreview);
  assert.equal((await f.lifecycle.preview('front')).frameId, 'replacement-front');
  await f.lifecycle.close('cancel');
});

test('terminal failed replacement preserves other view but never restores obsolete selected image', async () => {
  const f = fixture({ retake: async (lease, frame) => ({ leaseId: lease.leaseId, view: frame.view,
    replacedFrameId: frame.frameId, status: 'failed', reason: 'capture_failed' }) });
  const original = await staged(f), result = await f.lifecycle.retake('front');
  assert.equal(result.status, 'failed'); assert.deepEqual(f.lifecycle.getState().frames, [original.side]);
  assert.deepEqual(f.lifecycle.getState().previews, [original.sidePreview]);
  await assert.rejects(f.lifecycle.preview('front'), { code: 'preview_unavailable' });
  assert.equal(f.lifecycle.getState().phase, 'active');
  const recaptured = await f.lifecycle.capture('front'); assert.notEqual(recaptured.frameId, original.front.frameId);
  await f.lifecycle.close('cancel');
});

test('malformed or thrown retake is uncertain and closes the original lease without restoring old image', async () => {
  for (const patch of [null, { replacedFrameId: 'wrong' }, { frameId: 'same-old' }, { view: 'side' },
    { uri: 'synthetic://forbidden' }, { status: 'failed', reason: 'unproved' }]) {
    const f = fixture({ retake: async (lease, frame) => {
      if (patch === null) throw new Error('uncertain replacement');
      return { leaseId: lease.leaseId, view: frame.view, status: 'captured', frameId: 'new-frame',
        replacedFrameId: frame.frameId, ...patch, ...(patch.frameId === 'same-old' ? { frameId: frame.frameId } : {}) };
    }, cancel: async lease => ({ leaseId: lease.leaseId, status: 'unknown' }) });
    const original = await staged(f); await assert.rejects(f.lifecycle.retake('front'));
    assert.deepEqual(f.lifecycle.getState().frames, []); assert.deepEqual(f.lifecycle.getState().previews, []);
    assert.equal((await f.lifecycle.close('unmount')).lease, original.lease);
    assert.equal(f.lifecycle.getState().phase, 'unknown');
  }
});

test('original shell/auth/body revocation discards late replacement and retains exact unknown lease', async () => {
  for (const effect of ['relogin', 'revokeAuth', 'revokeBody']) {
    const gate = deferred(), entered = deferred();
    const f = fixture({ retake: (_lease, frame) => { entered.resolve(frame); return gate.promise; },
      cancel: async lease => ({ leaseId: lease.leaseId, status: 'unknown' }) });
    const original = await staged(f), pending = f.lifecycle.retake('front'), frame = await entered.promise;
    f[effect](); assert.deepEqual(f.lifecycle.getState().frames, []);
    gate.resolve({ leaseId: original.lease.leaseId, view: 'front', frameId: 'late-front',
      status: 'captured', replacedFrameId: frame.frameId });
    await assert.rejects(pending, { code: 'stale_session' });
    const cleanup = await f.lifecycle.close('revoke'); assert.equal(cleanup.lease, original.lease);
    assert.equal(cleanup.status, 'unknown'); assert.equal(cleanup.erasureConfirmed, false);
  }
});

test('pending retake serializes capture/preview/retake and permission without dispatching replacement work', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ retake: (_lease, frame) => { entered.resolve(frame); return gate.promise; } });
  const original = await staged(f), pending = f.lifecycle.retake('front'), frame = await entered.promise;
  for (const [operation, arg, code] of [['capture', 'front', 'capture_unavailable'], ['preview', 'side', 'preview_unavailable'],
    ['retake', 'side', 'retake_unavailable'], ['requestPermission', source(), 'busy']]) {
    await assert.rejects(f.lifecycle[operation](arg), { code });
  }
  gate.resolve({ leaseId: original.lease.leaseId, view: 'front', replacedFrameId: frame.frameId,
    status: 'failed', reason: 'capture_failed' }); await pending; await f.lifecycle.close('cancel');
});

test('unknown or malformed synchronous invalidation never claims image retirement or blocks exact cleanup', async () => {
  for (const invalidatePreviews of [() => { throw new Error('unknown rendering'); },
    () => ({ leaseId: 'wrong', status: 'invalidated' }), lease => ({ leaseId: lease.leaseId, status: 'unknown' })]) {
    const f = fixture({ invalidatePreviews }); const original = await staged(f);
    const cleanup = await f.lifecycle.close('unmount');
    assert.equal(f.lifecycle.getState().previewInvalidation, 'unknown'); assert.equal(cleanup.lease, original.lease);
    assert.equal(cleanup.erasureConfirmed, false); assert.equal(cleanup.status, 'released');
  }
});

test('stale/unset guidance inputs and duplicate cross-view frame handles deny dispatch or exact-close', async () => {
  const f = fixture();
  await assert.rejects(f.lifecycle.requestPermission({ ...source(), generation: 5 }), { code: 'stale_session' });
  const unset = source(); unset.choices.photos = { choice: 'unset', consentVersion: null };
  await assert.rejects(f.lifecycle.permissionStatus(unset), { code: 'explicit_choice_required' }); assert.deepEqual(f.calls, []);
  const duplicate = fixture({ capture: async (lease, view) => ({ leaseId: lease.leaseId, view, frameId: 'duplicate' }) });
  const lease = await duplicate.lifecycle.acquire(source()); await duplicate.lifecycle.capture('front');
  await assert.rejects(duplicate.lifecycle.capture('side'), { code: 'invalid_frame' });
  assert.equal((await duplicate.lifecycle.close('cancel')).lease, lease);
});
