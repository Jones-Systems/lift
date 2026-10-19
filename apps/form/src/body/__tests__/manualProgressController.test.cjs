const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// The actual controller/client/retention modules run in memory with synthetic transport; no network or scratch.
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const compiled = ts.transpileModule(readFileSync(join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  const permitted = {
    '../api/transport': '../api/transport.ts', './manualMeasurements': 'manualMeasurements.ts',
    './retention': 'retention.ts', './capabilities': 'capabilities.ts',
    './manualRetentionContract': 'manualRetentionContract.ts', '../body/manualRetentionContract': 'manualRetentionContract.ts',
    './manualRetentionConfirmation': 'manualRetentionConfirmation.ts',
  };
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(permitted[name], `unexpected import ${name}`); return load(permitted[name]);
  }, mod, mod.exports);
  modules.set(file, mod.exports); return mod.exports;
}
const { ApiError } = load('../api/transport.ts');
const { createManualProgressController } = load('manualProgressController.ts');
const contract = load('manualRetentionContract.ts');
const { validateManualRetentionCommandConfirmation } = load('manualRetentionConfirmation.ts');
const decisionId = '12345678-1234-4234-8234-123456789012';
const grantPayload = id => ({ decisionId: id, processing: 'manual_entry', purpose: 'personal_measurement_progress', choice: 'retain',
  statementId: contract.MANUAL_RETENTION_STATEMENT.id, statementVersion: 1, statementSha256: contract.MANUAL_RETENTION_STATEMENT_SHA256 });
const granted = id => ({ decisionId: id, state: 'granted', revision: 1, statement: contract.MANUAL_RETENTION_STATEMENT_BINDING });
const grantResponse = id => ({ schema: contract.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA,
  receipt: { operation: 'grant', decisionId: id, outcome: 'granted', decisionRevision: 1 }, current: granted(id) });
const available = () => ({ status: 'available', scope: 'manual_only', provenance: 'manual_reported' });
function caps({ create = true, list = true, remove = true } = {}) {
  return { schema: 'form.body-capabilities/v1', manualRetention: { schema: contract.MANUAL_RETENTION_CAPABILITY_SCHEMA,
    protocol: contract.MANUAL_RETENTION_PROTOCOL, statement: contract.MANUAL_RETENTION_STATEMENT_BINDING,
    status: 'available', grant: 'available', revoke: 'available', current: 'available' }, retainedMeasurements: create ? available() : {},
    progress: list ? available() : {}, bodyDeletion: remove ? available() : {},
    operations: { save_manual_measurement: create ? available() : {}, list_progress: list ? available() : {}, delete_assessment: remove ? available() : {} } };
}
const row = Object.freeze({ id: 'synthetic-entry', kind: 'waist', value: 80, unit: 'cm', originalUnit: 'in',
  measuredOn: '2026-10-11', note: 'Synthetic private note', provenance: 'manual_reported' });
const input = Object.freeze({ kind: 'waist', value: 80, unit: 'cm', measuredOn: '2026-10-11' });
function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ capabilities = () => caps(), list = async () => ({ items: [row] }) } = {}) {
  const calls = []; let currentAuth = true, currentSession = true;
  const controller = createManualProgressController({ accountId: 'synthetic-a', sessionGeneration: 'session-1',
    isCurrentSession: () => currentSession,
    transport: { captureAuthContext: () => ({ isCurrent: () => currentAuth }),
      request: async (path, method, payload, key) => {
        calls.push({ path, method, payload, key });
        assert.equal(method, 'GET');
        return path === '/v1/body/capabilities' ? capabilities() : list(path);
      } },
  });
  return { controller, calls, changeAuth: () => { currentAuth = false; }, changeSession: () => { currentSession = false; } };
}

test('baseline is unavailable, unset and non-dispatching; snapshots are stable and contain no retry keys', () => {
  const { controller: c, calls } = fixture();
  assert.equal(c.snapshot(), c.snapshot()); assert.deepEqual(calls, []);
  assert.equal(c.snapshot().capabilities.status, 'unavailable'); assert.equal(c.snapshot().progress.status, 'idle');
  assert.equal(c.snapshot().retention.processing, null); assert.equal(c.snapshot().retention.choices.derived.choice, 'unset');
  assert.deepEqual(c.snapshot().writes, { available: false, reason: 'command_owner_unbound' });
  assert.equal('create' in c, false); assert.equal('delete' in c, false);
});

test('mixed server capabilities remain independent and list does not depend on create or delete', async () => {
  const { controller: c, calls } = fixture({ capabilities: () => caps({ create: false, remove: false }) });
  await c.loadProgress();
  assert.deepEqual(c.snapshot().capabilities.value, { create: false, list: true, delete: false });
  assert.equal(c.snapshot().progress.status, 'data'); assert.deepEqual(c.snapshot().progress.items, [row]);
  assert.ok(calls.some(call => call.path === '/v1/body/measurements'));
  assert.equal(c.snapshot().writes.available, false);
});

test('absent list capability is unavailable, never confirmed empty or a dispatched list', async () => {
  for (const value of [null, {}, caps({ list: false })]) {
    const { controller: c, calls } = fixture({ capabilities: () => value });
    await c.loadProgress();
    assert.equal(c.snapshot().progress.status, 'unavailable'); assert.equal('items' in c.snapshot().progress, false);
    assert.ok(calls.every(call => call.path === '/v1/body/capabilities'));
  }
});

test('only a successful valid zero-item response is empty; data is copied and carries exact canonical provenance', async () => {
  let items = [{ ...row }]; const { controller: c } = fixture({ list: async () => ({ items }) });
  await c.loadProgress({ from: '2026-10-01' });
  assert.equal(c.snapshot().progress.status, 'data'); items[0].value = 999;
  assert.equal(c.snapshot().progress.items[0].value, 80);
  assert.ok(Object.isFrozen(c.snapshot().progress.items[0]));
  items = []; await c.loadProgress(); assert.deepEqual(c.snapshot().progress, { status: 'empty', items: [] });
});

test('loading and errors do not retain a stale list or fabricate zero; malformed data remains unconfirmed', async () => {
  const d = deferred(); let response = () => ({ items: [row] });
  const { controller: c } = fixture({ list: () => response() }); await c.loadProgress();
  response = () => d.promise; const flight = c.loadProgress();
  assert.deepEqual(c.snapshot().progress, { status: 'loading' });
  d.reject(new ApiError(503, 'synthetic_read_failed', 'Do not expose this raw text'));
  await flight; assert.equal(c.snapshot().progress.status, 'error'); assert.equal('items' in c.snapshot().progress, false);
  assert.doesNotMatch(JSON.stringify(c.snapshot()), /Do not expose/);
  for (const invalid of [null, {}, { items: null }, { items: [{ ...row, provenance: 'inferred' }] }, { items: [row, row] }]) {
    response = () => invalid; await c.loadProgress();
    assert.equal(c.snapshot().progress.error.code, 'body_invalid_progress_response');
  }
});

test('capability errors fail closed and capability changes are checked again by the actual client', async () => {
  let reads = 0;
  const { controller: c, calls } = fixture({ capabilities: () => ++reads === 1 ? caps() : caps({ list: false }) });
  await c.loadProgress(); assert.equal(c.snapshot().progress.status, 'unavailable');
  assert.ok(calls.every(call => call.path === '/v1/body/capabilities'));
  const failed = fixture({ capabilities: () => { throw new ApiError(0, 'network_unavailable', 'Synthetic'); } });
  await failed.controller.refreshCapabilities();
  assert.equal(failed.controller.snapshot().capabilities.status, 'error');
  assert.deepEqual(failed.controller.snapshot().capabilities.value, { create: false, list: false, delete: false });
});

test('manual processing and explicit versioned retention remain separate from command ownership', async () => {
  const { controller: c } = fixture(); await c.refreshCapabilities();
  c.stageMeasurement(input, c.captureFence()); assert.deepEqual(c.snapshot().retention.stagedMeasurements, []);
  c.chooseDerivedRetention('', c.captureFence()); assert.equal(c.snapshot().retention.choices.derived.choice, 'unset');
  c.chooseDerivedRetention('form-body-manual/v1', c.captureFence()); assert.equal(c.retentionPermission().allowed, false);
  c.chooseProcessing(c.captureFence()); c.stageMeasurement(input, c.captureFence());
  assert.equal(c.retentionPermission().allowed, false); assert.equal(c.snapshot().writes.available, false);
  assert.equal(c.snapshot().retention.choices.photos.choice, 'unset');
});

test('revoke clears staging, stops permission, and fences a late read without deleting existing records', async () => {
  const d = deferred(), started = deferred();
  const { controller: c } = fixture({ list: () => { started.resolve(); return d.promise; } });
  c.chooseProcessing(c.captureFence()); c.chooseDerivedRetention('form-body-manual/v1', c.captureFence()); c.stageMeasurement(input, c.captureFence());
  const flight = c.loadProgress(); await started.promise; c.revokeDerivedRetention(c.captureFence());
  d.resolve({ items: [row] }); await flight;
  assert.equal(c.snapshot().retention.choices.derived.choice, 'session_only');
  assert.deepEqual(c.snapshot().retention.stagedMeasurements, []); assert.equal(c.retentionPermission().allowed, false);
  assert.equal(c.snapshot().progress.status, 'idle'); assert.equal(c.snapshot().retention.deletion.derived.status, 'not_requested');
});

test('either session guard hides data and prevents every subsequent dispatch', async () => {
  for (const change of ['changeAuth', 'changeSession']) {
    const f = fixture(); await f.controller.loadProgress(); f[change]();
    assert.equal(f.controller.snapshot().active, false); assert.equal(f.controller.snapshot().retention, null);
    assert.equal(f.controller.snapshot().progress.status, 'idle');
    const count = f.calls.length; await f.controller.loadProgress(); await f.controller.refreshCapabilities();
    assert.equal(f.calls.length, count);
  }
});

test('held choice, staging and revocation callbacks cannot acquire a newer generation after revoke', () => {
  const { controller: c } = fixture();
  const captured = c.captureFence();
  assert.ok(Object.isFrozen(captured));
  c.chooseProcessing(captured); c.chooseDerivedRetention('form-body-manual/v1', captured); c.stageMeasurement(input, captured);
  const delayed = [() => c.chooseProcessing(captured),
    () => c.chooseDerivedRetention('form-body-manual/v1', captured),
    () => c.stageMeasurement(input, captured), () => c.revokeDerivedRetention(captured)];
  c.revokeDerivedRetention(captured);
  const after = c.snapshot();
  for (const callback of delayed) { callback(); assert.equal(c.snapshot(), after); }
  assert.equal(after.retention.choices.derived.choice, 'session_only');
  assert.deepEqual(after.retention.stagedMeasurements, []);
  const next = c.captureFence(); assert.equal(next.generation, captured.generation + 1);
  c.chooseDerivedRetention('form-body-manual/v1', next); c.stageMeasurement(input, next);
  assert.equal(c.snapshot().retention.choices.derived.choice, 'retain');
  assert.equal(c.snapshot().retention.stagedMeasurements.length, 1);
});

test('missing or wrong-account fences fail closed and closed controllers expose no current fence', () => {
  const { controller: c } = fixture(); const before = c.snapshot();
  for (const captured of [undefined, null, { accountId: 'synthetic-b', generation: 0 }]) {
    c.chooseProcessing(captured); c.chooseDerivedRetention('form-body-manual/v1', captured);
    c.stageMeasurement(input, captured); c.revokeDerivedRetention(captured);
    assert.equal(c.snapshot(), before);
  }
  c.close(); assert.equal(c.captureFence(), null);
});

test('account and same-account sign-in generation replacement terminate the old controller', () => {
  for (const identity of [['synthetic-b', 'session-1'], ['synthetic-a', 'session-2']]) {
    const { controller: c } = fixture(); c.chooseProcessing(c.captureFence()); c.stageMeasurement(input, c.captureFence());
    c.syncSession(...identity); assert.equal(c.snapshot().active, false); assert.equal(c.snapshot().retention, null);
  }
});

test('presentation dismissal preserves same-session state; background, close and dispose erase presentation data', async () => {
  const { controller: c } = fixture(); await c.loadProgress(); c.dismissPresentation();
  assert.equal(c.snapshot().presentationOpen, false); assert.equal(c.snapshot().active, true);
  assert.equal(c.snapshot().progress.status, 'data'); c.showPresentation(); assert.equal(c.snapshot().presentationOpen, true);
  for (const end of ['background', 'close', 'dispose']) {
    const d = deferred(), started = deferred();
    const f = fixture({ list: () => { started.resolve(); return d.promise; } });
    const flight = f.controller.loadProgress(); await started.promise; f.controller[end](); d.resolve({ items: [row] }); await flight;
    assert.equal(f.controller.snapshot().active, false); assert.equal(f.controller.snapshot().retention, null);
    assert.doesNotMatch(JSON.stringify(f.controller.snapshot()), /Synthetic private note|synthetic-entry/);
  }
});

test('newer list requests win, and lifecycle disposal by an observer prevents dispatch', async () => {
  const first = deferred(), started = deferred(); let requests = 0;
  const { controller: c } = fixture({ list: () => { if (++requests === 1) { started.resolve(); return first.promise; } return { items: [] }; } });
  const old = c.loadProgress(); await started.promise; await c.loadProgress(); first.resolve({ items: [row] }); await old;
  assert.equal(c.snapshot().progress.status, 'empty');
  const f = fixture(); const unsubscribe = f.controller.subscribe(() => {
    if (f.controller.snapshot().progress.status === 'loading') f.controller.close();
  });
  await f.controller.loadProgress(); unsubscribe(); assert.deepEqual(f.calls, []);
});

const { createCommandCustody } = load('../integration/commandCustody.ts');
const { validateManualCommandConfirmation } = load('manualCommandConfirmation.ts');
const producerId = 'a16b2c30-4d50-4670-890a-bcdef0123456';
function confirmation(payload) {
  return { id: producerId, kind: payload.kind, value: payload.value * (payload.unit === 'in' ? 2.54 : payload.unit === 'lb' ? 0.45359237 : 1),
    unit: payload.kind === 'weight' ? 'kg' : 'cm', originalUnit: payload.unit, measuredOn: payload.measuredOn,
    note: payload.note === undefined ? null : payload.note.trim(), provenance: 'manual_reported' };
}
function commands({ validator = validateManualCommandConfirmation, write = async (_path, payload) => confirmation(payload), capabilities = () => caps() } = {}) {
  let current = true, preparing = false, interval = 0; const calls = [], access = { accountId: 'synthetic-a', sessionGeneration: 'session-1' };
  const transport = { captureAuthContext: () => ({ isCurrent: () => current }), request: async (path, method = 'GET', payload, key, context) => {
    calls.push({ path, method, payload, key });
    if (path === '/v1/body/manual-retention') return grantResponse(payload.decisionId);
    if (method === 'GET') return preparing ? caps() : capabilities();
    context?.assertCurrent();
    assert.equal(owner.snapshot(access).length, 1, 'custody must precede dispatch');
    return write(path, payload, key);
  } };
  const owner = createCommandCustody({ ...access, transport, isCurrentSession: () => current, validateConfirmation: (intent, response) => intent.operation.endsWith('manual_retention')
    ? validateManualRetentionCommandConfirmation(intent, response) : validator?.(intent, response) });
  const open = (overrides = {}) => createManualProgressController({ ...access, transport, commandOwner: owner, isCurrentSession: () => current, ...overrides });
  const c = open();
  const consent = async controller => {
    const fence = controller.captureFence(); controller.chooseProcessing(fence); controller.chooseDerivedRetention(contract.MANUAL_RETENTION_PROTOCOL, fence);
    preparing = true;
    try {
      const result = await controller.grantRetention({ key: 'synthetic-grant', payload: grantPayload(`${++interval}2345678-1234-4234-8234-123456789012`) }, fence);
      assert.equal(result.effect, 'confirmed'); controller.acknowledgeCommand(result.id);
    } finally { preparing = false; }
    calls.length = 0; return fence;
  };
  return { c, owner, access, calls, open, consent, replace: () => { current = false; } };
}
const createCommand = key => ({ key, payload: { ...input } });

test('owner admission is synchronous, immutable and fails without mutation dispatch', async () => {
  const f = commands(); const fence = await f.consent(f.c), command = createCommand('first');
  const flight = f.c.create(command, fence);
  const [held] = f.owner.snapshot(f.access); assert.equal(held.locallyPending, 1);
  command.payload.value = 123; command.key = 'replacement';
  assert.throws(() => f.c.create(createCommand('first'), fence), /custody/);
  const result = await flight; assert.equal(result.effect, 'confirmed');
  const post = f.calls.find(call => call.method === 'POST'); assert.equal(post.key, 'first'); assert.equal(post.payload.value, 80);
  assert.ok(Object.isFrozen(post.payload)); f.c.acknowledgeCommand(held.id); assert.deepEqual(f.owner.snapshot(f.access), []);
  const unchosen = commands(); assert.throws(() => unchosen.c.create(createCommand('denied'), unchosen.c.captureFence()));
  assert.deepEqual(unchosen.calls, []); assert.deepEqual(unchosen.owner.snapshot(unchosen.access), []);
  f.c.dispose(); unchosen.c.dispose();
});

test('capacity rejection holds no new command and dispatches no request', async () => {
  const f = commands(); const fence = await f.consent(f.c);
  for (let i = 0; i < 16; i++) f.owner.hold({ ...f.access, operation: 'save_manual_measurement', command: createCommand(`held-${i}`) });
  assert.throws(() => f.c.create(createCommand('overflow'), fence)); assert.deepEqual(f.calls, []); f.c.dispose();
});

test('observer disposal before dispatch settles known not-started, without issuing a request', async () => {
  const f = commands(); const fence = await f.consent(f.c);
  const stop = f.c.subscribe(() => { if (f.c.snapshot().writes.commands?.length) f.c.dispose(); });
  await f.c.create(createCommand('observer'), fence); stop();
  assert.deepEqual(f.calls, []); assert.equal(f.owner.snapshot(f.access)[0].effect, 'not_applied');
});

test('consent revocation and version changes during capability await block dispatch', async () => {
  for (const change of ['revoke', 'version', 'dispose']) {
    const d = deferred(), started = deferred();
    const f = commands({ capabilities: () => { started.resolve(); return d.promise; } }); const fence = await f.consent(f.c);
    const flight = f.c.create(createCommand(change), fence);
    try {
      await started.promise;
      if (change === 'revoke') f.c.revokeDerivedRetention(fence);
      else if (change === 'version') f.c.chooseDerivedRetention('manual/v2', fence);
      else f.c.dispose();
    } finally { d.resolve(caps()); await flight; }
    assert.ok(f.calls.every(call => call.method === 'GET')); assert.equal(f.owner.snapshot(f.access)[0].effect, 'not_applied'); f.c.dispose();
  }
});

test('fresh operation capability denial is independent and never starts a write', async () => {
  const f = commands({ capabilities: () => caps({ create: false, remove: true }) }); const fence = await f.consent(f.c);
  await f.c.create(createCommand('create-unavailable'), fence);
  assert.equal(f.owner.snapshot(f.access)[0].effect, 'not_applied'); assert.ok(f.calls.every(call => call.method === 'GET')); f.c.dispose();
});

test('missing and malformed trusted confirmation remain unknown and cannot be acknowledged', async () => {
  for (const validator of [null, () => { throw new Error('malformed validator'); }]) {
    const f = commands({ validator }); const result = await f.c.create(createCommand('unconfirmed'), await f.consent(f.c));
    assert.equal(result.effect, 'unknown'); assert.throws(() => f.c.acknowledgeCommand(result.id)); f.c.dispose();
  }
  const f = commands({ write: async (_path, payload) => ({ ...confirmation(payload), accountId: 'invented' }) });
  const result = await f.c.create(createCommand('extra'), await f.consent(f.c)); assert.equal(result.effect, 'unknown'); f.c.dispose();
});

test('both uncertainty flags and generic failures retain liability; later rejection cannot erase it', async () => {
  for (const initial of [new ApiError(0, 'network', 'private error', true), new ApiError(409, 'changed', 'private error', false, true), new Error('private error')]) {
    let attempts = 0; const f = commands({ write: async () => { if (++attempts === 1) throw initial; throw new ApiError(422, 'invalid', 'private error'); } });
    const fence = await f.consent(f.c), first = await f.c.create(createCommand('same-key'), fence);
    assert.equal(first.effect, 'unknown'); assert.equal(first.retryAvailable, true);
    assert.equal(f.c.snapshot().writes.error.effectUnknown, initial instanceof ApiError ? initial.effectUnknown : true);
    assert.equal(f.c.snapshot().writes.error.originalEffectUnknown, true);
    const second = await f.c.retryCommand(first.id, fence); assert.equal(second.effect, 'unknown'); assert.equal(second.attempts, 2);
    assert.equal(f.c.snapshot().writes.error.originalEffectUnknown, true);
    const posts = f.calls.filter(call => call.method === 'POST'); assert.deepEqual(posts[0], posts[1]);
    assert.doesNotMatch(JSON.stringify(f.c.snapshot()), /private error|same-key|2026-10-11/); f.c.dispose();
  }
});

test('pending teardown does not settle or release; late proof reaches original custody after disposal', async () => {
  const d = deferred(), started = deferred(); const f = commands({ write: () => { started.resolve(); return d.promise; } });
  const flight = f.c.create(createCommand('late'), await f.consent(f.c));
  let id;
  try {
    await started.promise; id = f.owner.snapshot(f.access)[0].id; f.c.dispose();
    const pending = f.owner.snapshot(f.access)[0]; assert.equal(pending.locallyPending, 1);
    assert.throws(() => f.owner.reconcile(f.access, id).retry()); assert.throws(() => f.owner.acknowledge(f.access, id));
    assert.equal(f.c.snapshot().retention, null); assert.equal(f.c.snapshot().writes.available, false);
  } finally { d.resolve(confirmation(input)); await flight; }
  assert.equal(f.owner.snapshot(f.access)[0].effect, 'confirmed'); assert.equal(f.owner.snapshot(f.access)[0].locallyPending, 0);
  const reopened = f.open(); assert.equal(reopened.recoverCommand(id).metadata.effect, 'confirmed'); reopened.acknowledgeCommand(id); reopened.dispose();
});

test('same-session reopen recovers exact intent but cannot restore old consent; replacement denies access', async () => {
  const f = commands({ write: async () => { throw new ApiError(0, 'network', 'synthetic', true); } });
  const first = await f.c.create(createCommand('reopen'), await f.consent(f.c)); f.c.close();
  const next = f.open(); const recovery = next.recoverCommand(first.id);
  assert.equal(recovery.intent.command.key, 'reopen'); assert.equal(next.snapshot().retention.choices.derived.choice, 'unset');
  assert.throws(() => next.retryCommand(first.id, next.captureFence()));
  await next.retryCommand(first.id, await f.consent(next)); assert.equal(f.owner.snapshot(f.access)[0].attempts, 2);
  const foreign = f.open({ accountId: 'synthetic-b' }); assert.throws(() => foreign.recoverCommand(first.id));
  const replacement = f.open({ sessionGeneration: 'session-2' }); assert.throws(() => replacement.recoverCommand(first.id));
  f.replace(); assert.throws(() => next.recoverCommand(first.id)); next.dispose(); foreign.dispose(); replacement.dispose();
});

test('delete stays independent after future-retention revoke and requires exact trusted response', async () => {
  for (const response of [{ deleted: true }, { deleted: true, id: producerId }, { items: [] }]) {
    const f = commands({ capabilities: () => caps({ create: false, list: false }), write: async () => response });
    const old = await f.consent(f.c); f.c.revokeDerivedRetention(old); const fence = f.c.captureFence();
    const result = await f.c.delete({ id: producerId, key: 'delete-one', payload: {} }, fence);
    assert.equal(result.effect, Object.keys(response).join(',') === 'deleted' ? 'confirmed' : 'unknown');
    assert.equal(f.c.snapshot().retention.deletion.derived.status, result.effect);
    assert.equal(f.calls.filter(call => call.method === 'POST')[0].path, `/v1/body/measurements/${producerId}/delete`);
    assert.equal(f.c.snapshot().retention.choices.derived.choice, 'session_only'); f.c.dispose();
  }
});


test('original host replacement during an issued promise denies recovery and reports original uncertainty', async () => {
  const d = deferred(), started = deferred(), reports = [];
  const f = commands({ write: () => { started.resolve(); return d.promise; } });
  const observedOwner = { ...f.owner, hold: (input, context) => {
    const attempt = f.owner.hold(input, context);
    return { ...attempt, report: outcome => { reports.push(outcome); attempt.report(outcome); } };
  } };
  const c = f.open({ commandOwner: observedOwner }); const fence = await f.consent(c); reports.length = 0;
  const flight = c.create(createCommand('old-host'), fence);
  try {
    await started.promise; const id = f.owner.snapshot(f.access)[0].id; f.replace();
    assert.equal(c.snapshot().active, false); assert.throws(() => c.recoverCommand(id)); assert.deepEqual(reports, []);
  } finally { d.resolve(confirmation(input)); await flight; c.dispose(); f.c.dispose(); }
  assert.deepEqual(reports, [{ status: 'unknown', settled: true }]);
});

function n1Scenario(handler) {
  const access = { accountId: 'synthetic-a', sessionGeneration: 'n1-session' }, calls = [];
  let current = true, controller;
  const transport = { captureAuthContext: () => ({ isCurrent: () => current }),
    request: async (path, method = 'GET', payload, key, context) => {
      calls.push({ path, method, payload, key, context });
      if (path === '/v1/body/capabilities') return caps();
      return handler({ path, method, payload, key, context, controller });
    } };
  const owner = createCommandCustody({ ...access, transport, isCurrentSession: () => current,
    validateConfirmation: (intent, response) => intent.operation.endsWith('manual_retention')
      ? validateManualRetentionCommandConfirmation(intent, response) : validateManualCommandConfirmation(intent, response) });
  const open = () => createManualProgressController({ ...access, transport, commandOwner: owner, isCurrentSession: () => current });
  controller = open();
  const choose = () => { const fence = controller.captureFence(); controller.chooseProcessing(fence);
    controller.chooseDerivedRetention(contract.MANUAL_RETENTION_PROTOCOL, fence); return fence; };
  return { c: controller, owner, access, calls, choose, open, replace: () => { current = false; } };
}
const revokeResponse = (id, revision = 2) => ({ schema: contract.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA,
  receipt: { operation: 'revoke', decisionId: id, outcome: 'revoked', decisionRevision: revision },
  current: { decisionId: id, state: 'revoked', revision, statement: revision === 1 ? null : contract.MANUAL_RETENTION_STATEMENT_BINDING } });

test('N1 choices and current reads never authorize a create before matching grant confirmation', async () => {
  const f = n1Scenario(async ({ path, method, payload, context }) => {
    if (method === 'GET') return { schema: contract.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current: granted(decisionId) };
    if (path === '/v1/body/manual-retention') return grantResponse(payload.decisionId);
    context.assertCurrent(); return confirmation(payload);
  });
  const fence = f.choose();
  await f.c.refreshRetention(decisionId, fence);
  assert.throws(() => f.c.create(createCommand('before-grant'), fence));
  const grant = await f.c.grantRetention({ key: 'n1-grant', payload: grantPayload(decisionId) }, fence);
  assert.equal(grant.effect, 'confirmed');
  const create = await f.c.create(createCommand('with-grant'), fence); assert.equal(create.effect, 'confirmed');
  const post = f.calls.find(call => call.path === '/v1/body/measurements');
  assert.equal(post.context.manualRetention.decisionId, decisionId); assert.ok(Object.isFrozen(post.context.manualRetention));
  assert.deepEqual(f.c.recoverCommand(create.id).intent.command, createCommand('with-grant'));
  const fresh = f.open(); await fresh.refreshRetention(decisionId, fresh.captureFence());
  assert.equal(fresh.snapshot().retention.processing, null); assert.equal(fresh.snapshot().retention.choices.derived.choice, 'unset');
  assert.throws(() => fresh.create(createCommand('fresh-denied'), fresh.captureFence()));
});
test('revoke can precede uncertain grant settlement; late historical proof cannot restore permission', async () => {
  const pending = deferred(), started = deferred();
  const f = n1Scenario(async ({ path, payload }) => {
    if (path === '/v1/body/manual-retention') { started.resolve(); return pending.promise; }
    if (path.endsWith('/revoke')) return revokeResponse(decisionId, 1);
    throw new Error('unexpected write');
  });
  const old = f.choose(); const flight = f.c.grantRetention({ key: 'grant-in-flight', payload: grantPayload(decisionId) }, old);
  await started.promise;
  const revoked = await f.c.revokeRetention({ key: 'revoke-first', decisionId, payload: {} }, old);
  assert.equal(revoked.effect, 'confirmed');
  pending.resolve({ ...grantResponse(decisionId), receipt: { operation: 'grant', decisionId, outcome: 'blocked_by_revocation', decisionRevision: 1 },
    current: revokeResponse(decisionId, 1).current });
  await flight;
  const fence = f.c.captureFence(); f.c.chooseDerivedRetention(contract.MANUAL_RETENTION_PROTOCOL, fence);
  assert.throws(() => f.c.create(createCommand('after-revoke'), fence));
  assert.throws(() => f.c.grantRetention({ key: 'reused-id', payload: grantPayload(decisionId) }, fence));
  assert.equal(f.c.snapshot().retention.manualDecision.stopped, true);
  assert.equal(f.c.snapshot().retention.deletion.derived.status, 'not_requested');
});
test('unknown grant retry preserves exact command; stopped interval refuses grant retry and accepts new decision', async () => {
  let first = true;
  const f = n1Scenario(async ({ path, payload }) => {
    if (path.endsWith('/revoke')) return revokeResponse(decisionId);
    if (first) { first = false; throw new ApiError(0, 'network_unavailable', 'synthetic', true); }
    return grantResponse(payload.decisionId);
  });
  let fence = f.choose();
  const unknown = await f.c.grantRetention({ key: 'uncertain-grant', payload: grantPayload(decisionId) }, fence);
  assert.equal(unknown.effect, 'unknown');
  f.c.revokeDerivedRetention(fence); fence = f.c.captureFence(); f.c.chooseDerivedRetention(contract.MANUAL_RETENTION_PROTOCOL, fence);
  assert.throws(() => f.c.retryCommand(unknown.id, fence));
  assert.equal(f.c.snapshot().retention.manualDecision.revoke, 'not_requested', 'local stop is not a remote command');
  const nextId = '22345678-1234-4234-8234-123456789012';
  const next = await f.c.grantRetention({ key: 'fresh-grant', payload: grantPayload(nextId) }, fence);
  assert.equal(next.effect, 'confirmed'); assert.equal(f.c.snapshot().retention.manualDecision.current.decisionId, nextId);
  assert.equal(f.c.recoverCommand(unknown.id).intent.command.payload.decisionId, decisionId);
});
test('null-authority reconciliation survives local stop and retains original key/payload and unknown liability', async () => {
  let measurementWrites = 0;
  const f = n1Scenario(async ({ path, payload, context }) => {
    if (path === '/v1/body/manual-retention') return grantResponse(payload.decisionId);
    context.assertCurrent();
    if (++measurementWrites === 1) throw new ApiError(0, 'network_unavailable', 'synthetic', true);
    assert.equal(context.manualRetention, null);
    throw new ApiError(404, 'measurement_not_found', 'A committed row may have been deleted.');
  });
  const old = f.choose(); await f.c.grantRetention({ key: 'grant-reconcile', payload: grantPayload(decisionId) }, old);
  const unknown = await f.c.create(createCommand('original-intent'), old);
  f.c.revokeDerivedRetention(old);
  const result = await f.c.reconcileCommand(unknown.id, f.c.captureFence());
  assert.equal(result.effect, 'unknown'); assert.equal(result.attempts, 2);
  const posts = f.calls.filter(call => call.path === '/v1/body/measurements');
  assert.equal(posts[0].key, posts[1].key); assert.deepEqual(posts[0].payload, posts[1].payload);
  assert.equal(posts[0].context.manualRetention.decisionId, decisionId); assert.equal(posts[1].context.manualRetention, null);
  assert.equal(f.c.snapshot().retention.choices.derived.choice, 'session_only');
});
test('final dispatch callback rejects stopped creates but permits reconciliation without retention choice', async () => {
  let stopBeforeDispatch = false, failFirst = true;
  const f = n1Scenario(async ({ path, payload, context, controller }) => {
    if (path === '/v1/body/manual-retention') return grantResponse(payload.decisionId);
    if (stopBeforeDispatch) controller.revokeDerivedRetention(controller.captureFence());
    context.assertCurrent();
    if (failFirst) { failFirst = false; throw new ApiError(0, 'network_unavailable', 'synthetic', true); }
    return confirmation(payload);
  });
  const fence = f.choose(); await f.c.grantRetention({ key: 'guard-grant', payload: grantPayload(decisionId) }, fence);
  const unknown = await f.c.create(createCommand('guard-create'), fence);
  stopBeforeDispatch = true;
  const rejected = await f.c.retryCommand(unknown.id, fence); assert.equal(rejected.effect, 'unknown');
  stopBeforeDispatch = false;
  const confirmed = await f.c.reconcileCommand(unknown.id, f.c.captureFence()); assert.equal(confirmed.effect, 'confirmed');
  assert.equal(f.c.snapshot().retention.choices.derived.choice, 'session_only');
});

test('control retries retain exact grant/revoke keys and bodies without status reads confirming commands', async () => {
  const attempts = new Map();
  const f = n1Scenario(async ({ path, method, payload, key }) => {
    if (method === 'GET') return { schema: contract.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current: granted(decisionId) };
    const count = (attempts.get(key) ?? 0) + 1; attempts.set(key, count);
    if (count === 1) throw new ApiError(0, 'network_unavailable', 'synthetic', true);
    return path.endsWith('/revoke') ? revokeResponse(decisionId) : grantResponse(payload.decisionId);
  });
  let fence = f.choose();
  const grant = await f.c.grantRetention({ key: 'retry-grant', payload: grantPayload(decisionId) }, fence);
  await f.c.refreshRetention(decisionId, fence);
  assert.equal(f.c.recoverCommand(grant.id).metadata.effect, 'unknown');
  assert.throws(() => f.c.create(createCommand('unconfirmed-grant'), fence));
  assert.equal((await f.c.retryCommand(grant.id, fence)).effect, 'confirmed');
  const revoke = await f.c.revokeRetention({ key: 'retry-revoke', decisionId, payload: {} }, fence);
  fence = f.c.captureFence(); assert.equal(revoke.effect, 'unknown');
  assert.equal(f.c.snapshot().retention.manualDecision.revoke, 'unknown');
  assert.equal((await f.c.retryCommand(revoke.id, fence)).effect, 'confirmed');
  for (const key of ['retry-grant', 'retry-revoke']) {
    const posts = f.calls.filter(call => call.key === key);
    assert.equal(posts.length, 2); assert.deepEqual(posts[0].payload, posts[1].payload);
    assert.equal(posts[0].path, posts[1].path);
  }
});
test('fresh authority can retry unknown original measurement without changing its key or payload', async () => {
  let first = true;
  const f = n1Scenario(async ({ path, payload, context }) => {
    if (path === '/v1/body/manual-retention') return grantResponse(payload.decisionId);
    context.assertCurrent();
    if (first) { first = false; throw new ApiError(0, 'network_unavailable', 'synthetic', true); }
    return confirmation(payload);
  });
  let fence = f.choose(); await f.c.grantRetention({ key: 'original-grant', payload: grantPayload(decisionId) }, fence);
  const unknown = await f.c.create(createCommand('immutable-create'), fence);
  f.c.revokeDerivedRetention(fence); fence = f.choose();
  const nextId = '22345678-1234-4234-8234-123456789012';
  await f.c.grantRetention({ key: 'new-grant', payload: grantPayload(nextId) }, fence);
  const result = await f.c.retryCommand(unknown.id, fence); assert.equal(result.effect, 'confirmed');
  const posts = f.calls.filter(call => call.path === '/v1/body/measurements');
  assert.equal(posts[0].key, posts[1].key); assert.deepEqual(posts[0].payload, posts[1].payload);
  assert.equal(posts[0].context.manualRetention.decisionId, decisionId);
  assert.equal(posts[1].context.manualRetention.decisionId, nextId);
});

test('stopped unknown grant reconciles only after exact terminal current evidence and never becomes permission', async () => {
  let attempts = 0, terminal = false, absent = true;
  const f = n1Scenario(async ({ method, payload }) => {
    if (method === 'GET') return { schema: contract.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA,
      current: absent ? null : terminal ? revokeResponse(decisionId).current : granted(decisionId) };
    if (++attempts === 1) throw new ApiError(0, 'network_unavailable', 'synthetic', true);
    return { ...grantResponse(payload.decisionId), current: revokeResponse(decisionId).current };
  });
  let fence = f.choose();
  const unknown = await f.c.grantRetention({ key: 'terminal-grant', payload: grantPayload(decisionId) }, fence);
  f.c.revokeDerivedRetention(fence); fence = f.c.captureFence();
  await assert.rejects(f.c.reconcileGrant(unknown.id, fence), { code: 'body_command_not_started' });
  assert.equal(attempts, 1);
  absent = false;
  await assert.rejects(f.c.reconcileGrant(unknown.id, fence), { code: 'body_command_not_started' });
  assert.equal(attempts, 1);
  terminal = true;
  assert.equal((await f.c.reconcileGrant(unknown.id, fence)).effect, 'confirmed');
  assert.equal(f.c.snapshot().retention.manualDecision.current.state, 'revoked');
  assert.equal(f.c.snapshot().retention.choices.derived.choice, 'session_only');
  assert.throws(() => f.c.create(createCommand('still-stopped'), fence));
});


test('post-revoke settlement publishes current custody without restoring revoked presentation state', async () => {
  for (const outcome of ['confirmed', 'unknown']) {
    const pending = deferred(), started = deferred();
    const f = commands({ write: () => { started.resolve(); return pending.promise; } });
    const fence = await f.consent(f.c);
    const flight = f.c.create(createCommand(`late-revoke-${outcome}`), fence);
    await started.promise;
    f.c.revokeDerivedRetention(fence);
    const revoked = f.c.snapshot().retention;
    const id = f.owner.snapshot(f.access)[0].id;
    assert.equal(f.c.snapshot().writes.commands[0].locallyPending, 1);
    const observed = [];
    const unsubscribe = f.c.subscribe(() => observed.push(f.c.snapshot()));
    try {
      if (outcome === 'confirmed') pending.resolve(confirmation(input));
      else pending.reject(new ApiError(0, 'synthetic_lost_response', 'private transport text', true));
      await flight;
      const settled = f.owner.snapshot(f.access)[0];
      assert.equal(settled.effect, outcome);
      assert.equal(settled.locallyPending, 0);
      assert.deepEqual(f.c.snapshot().writes.commands, [settled]);
      assert.ok(observed.some(snapshot => snapshot.writes.commands[0]?.locallyPending === 0));
      assert.equal(f.c.snapshot().retention, revoked);
      assert.equal(f.c.snapshot().retention.choices.derived.choice, 'session_only');
      assert.equal(f.c.retentionPermission().allowed, false);
      assert.deepEqual(f.c.snapshot().progress, { status: 'idle' });
      assert.equal(f.c.snapshot().writes.error, undefined);
      assert.doesNotMatch(JSON.stringify(f.c.snapshot()), /private transport text|late-revoke-/);
      if (outcome === 'confirmed') f.c.acknowledgeCommand(id);
      else assert.equal(f.c.snapshot().writes.commands[0].retryAvailable, true);
    } finally { unsubscribe(); f.c.dispose(); }
  }
});
