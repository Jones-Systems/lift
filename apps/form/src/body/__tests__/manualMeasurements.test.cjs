const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Compile exact source in memory; injected requests use synthetic data and never start native or network work.
function load(file, resolve) {
  const compiled = ts.transpileModule(readFileSync(join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(resolve, mod, mod.exports);
  return mod.exports;
}
const transportModule = load('../api/transport.ts', name => { throw new Error(`unexpected import ${name}`); });
const { ApiError } = transportModule;
const contract = load('manualRetentionContract.ts', name => { throw new Error(`unexpected import ${name}`); });
const confirmation = load('manualRetentionConfirmation.ts', name => {
  assert.equal(name, './manualRetentionContract'); return contract;
});
const { createManualMeasurementsClient } = load('manualMeasurements.ts', name => {
  const allowed = { '../api/transport': transportModule, './manualRetentionContract': contract, './manualRetentionConfirmation': confirmation };
  assert.ok(allowed[name], `unexpected import ${name}`); return allowed[name];
});
const context = Object.freeze({ manualRetention: Object.freeze({ protocol: contract.MANUAL_RETENTION_PROTOCOL,
  decisionId: '12345678-1234-4234-8234-123456789012', revision: 1, statementSha256: contract.MANUAL_RETENTION_STATEMENT_SHA256 }), assertCurrent() {} });
const retentionCapability = () => ({ schema: contract.MANUAL_RETENTION_CAPABILITY_SCHEMA, protocol: contract.MANUAL_RETENTION_PROTOCOL,
  statement: contract.MANUAL_RETENTION_STATEMENT_BINDING, status: 'available', grant: 'available', revoke: 'available', current: 'available' });
const available = () => ({ status: 'available', provenance: 'manual_reported', scope: 'manual_only' });
const capabilityResponse = () => ({
  schema: 'form.body-capabilities/v1', manualRetention: retentionCapability(), retainedMeasurements: available(), progress: available(), bodyDeletion: available(),
  operations: { save_manual_measurement: available(), list_progress: available(), delete_assessment: available() },
});
const id = 'a23f2494-4f78-4972-87ac-78f5e8fd7158';
const measurement = Object.freeze({ id, kind: 'waist', value: 76.2, unit: 'cm', originalUnit: 'in',
  measuredOn: '2026-10-10', note: 'Synthetic', provenance: 'manual_reported' });
const createCommand = Object.freeze({ key: 'synthetic-create',
  payload: Object.freeze({ kind: 'waist', value: 30, unit: 'in', measuredOn: '2026-10-10', note: 'Synthetic' }) });
const deleteCommand = Object.freeze({ id, key: 'synthetic-delete', payload: Object.freeze({}) });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(handler = async path => path.endsWith('/delete') ? { deleted: true } : { items: [measurement] }, caps = capabilityResponse()) {
  const calls = [];
  let auth = true, session = true, captures = 0;
  const client = createManualMeasurementsClient({
    transport: {
      captureAuthContext() { captures++; return { isCurrent: () => auth }; },
      async request(path, method, payload, key) {
        calls.push({ path, method, payload, key });
        return path === '/v1/body/capabilities' ? (typeof caps === 'function' ? caps() : caps) : handler(path, method, payload, key);
      },
    },
    isCurrentSession: () => session,
  });
  return { client, calls, changeAuth: () => { auth = false; }, changeSession: () => { session = false; }, captures: () => captures };
}
const stale = (unknown = false) => error => error.code === 'session_changed'
  && error.effectUnknown === false && error.originalEffectUnknown === unknown;

test('current-session CRUD uses exact routes, caller keys, original units and fresh capability checks', async () => {
  const f = fixture(async (path, method) => path.endsWith('/delete') ? { deleted: true }
    : method === 'POST' ? measurement : { items: [measurement] });
  assert.deepEqual(await f.client.capabilities(), { create: true, list: true, delete: true });
  assert.deepEqual(await f.client.create(createCommand, context), measurement);
  assert.deepEqual(await f.client.list({ from: '2026-10-01', to: '2026-10-11' }), { items: [measurement] });
  assert.deepEqual(await f.client.delete(deleteCommand), { deleted: true });
  assert.equal(f.captures(), 1);
  assert.equal(f.calls.filter(call => call.path === '/v1/body/capabilities').length, 4);
  assert.deepEqual(f.calls.filter(call => call.path !== '/v1/body/capabilities'), [
    { path: '/v1/body/measurements', method: 'POST', payload: createCommand.payload, key: createCommand.key },
    { path: '/v1/body/measurements?from=2026-10-01&to=2026-10-11', method: 'GET', payload: undefined, key: undefined },
    { path: `/v1/body/measurements/${id}/delete`, method: 'POST', payload: {}, key: deleteCommand.key },
  ]);
});

test('all accepted kinds and units are passed unchanged, including weight provenance', async () => {
  for (const kind of ['waist', 'hips', 'chest', 'thigh', 'upper_arm', 'weight']) {
    const payload = Object.freeze({ kind, value: 100, unit: kind === 'weight' ? 'lb' : 'cm', measuredOn: '2026-10-10' });
    const result = { ...measurement, kind, value: kind === 'weight' ? 45.359237 : 100,
      unit: kind === 'weight' ? 'kg' : 'cm', originalUnit: payload.unit };
    const f = fixture(async () => result);
    assert.deepEqual(await f.client.create(Object.freeze({ key: `synthetic-${kind}`, payload }), context), result);
    assert.deepEqual(f.calls[1].payload, payload);
  }
});

test('missing, unavailable, unknown or unqualified capabilities prevent every measurement dispatch', async () => {
  const malformed = [null, {}, { schema: 'unknown' },
    { ...capabilityResponse(), operations: {} },
    { ...capabilityResponse(), retainedMeasurements: { status: 'available' }, progress: {}, bodyDeletion: {} },
    { ...capabilityResponse(), retainedMeasurements: { status: 'unavailable' }, progress: { status: 'unknown' }, bodyDeletion: { status: 'available', scope: 'photo', provenance: 'manual_reported' } }];
  for (const caps of malformed) {
    const f = fixture(undefined, caps);
    for (const action of [() => f.client.create(createCommand, context), () => f.client.list(), () => f.client.delete(deleteCommand)])
      await assert.rejects(action, { code: 'body_retention_unavailable', effectUnknown: false });
    assert.ok(f.calls.every(call => call.path === '/v1/body/capabilities'));
  }
});

test('capabilities expose only manual operations and recheck subsequent server unavailability', async () => {
  let caps = { ...capabilityResponse(), photoUpload: { status: 'available' }, inference: { status: 'available' } };
  const f = fixture(undefined, () => caps);
  assert.deepEqual(await f.client.capabilities(), { create: true, list: true, delete: true });
  caps = { schema: 'form.body-capabilities/v1' };
  await assert.rejects(f.client.create(createCommand, context), { code: 'body_retention_unavailable' });
  assert.equal(f.calls.length, 2);
});

test('either captured guard changing prevents new dispatches for every method', async () => {
  for (const change of ['changeAuth', 'changeSession']) {
    const f = fixture(); f[change]();
    for (const action of [() => f.client.capabilities(), () => f.client.list(),
      () => f.client.create(createCommand, context), () => f.client.delete(deleteCommand)]) await assert.rejects(action, stale());
    assert.deepEqual(f.calls, []);
  }
});

test('late capabilities cannot authorize a write after an account switch', async () => {
  for (const outcome of ['success', 'error']) {
    const d = deferred(); const f = fixture(undefined, () => d.promise);
    const flight = f.client.create(createCommand, context); f.changeSession();
    if (outcome === 'success') d.resolve(capabilityResponse()); else d.reject(new Error('synthetic read failure'));
    await assert.rejects(flight, stale());
    assert.equal(f.calls.length, 1);
  }
});

test('late measurement reads and writes reject both success and error completions', async () => {
  for (const operation of ['list', 'create', 'delete']) {
    for (const outcome of ['success', 'error']) {
      const d = deferred(), dispatched = deferred();
      const f = fixture(() => { dispatched.resolve(); return d.promise; });
      const flight = operation === 'list' ? f.client.list() : f.client[operation](operation === 'create' ? createCommand : deleteCommand, context);
      await dispatched.promise; f.changeAuth();
      if (outcome === 'success') d.resolve(operation === 'list' ? { items: [measurement] } : measurement);
      else d.reject(new ApiError(503, 'synthetic_failure', 'Synthetic', operation !== 'list'));
      await assert.rejects(flight, stale(operation !== 'list'));
      const before = f.calls.length;
      await assert.rejects(f.client.create(createCommand, context), stale());
      assert.equal(f.calls.length, before, 'the old client cannot retry under another account');
    }
  }
});

test('unknown write errors retain their identity and caller retries reuse unchanged keys and payloads', async () => {
  for (const operation of ['create', 'delete']) {
    const unknown = new ApiError(0, 'network_unavailable', 'Synthetic', true, true);
    let attempt = 0;
    const f = fixture(async () => { if (++attempt === 1) throw unknown; return operation === 'create' ? measurement : { deleted: true }; });
    const command = operation === 'create' ? createCommand : deleteCommand;
    await assert.rejects(f.client[operation](command, context), error => error === unknown);
    assert.equal(attempt, 1, 'no automatic replay');
    await f.client[operation](command, context);
    const writes = f.calls.filter(call => call.method === 'POST');
    assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
    assert.ok(Object.isFrozen(writes[0].payload));
  }
});

test('untyped write failure is unknown and stale read errors preserve original uncertainty', async () => {
  const f = fixture(async () => { throw new Error('synthetic transport failure'); });
  await assert.rejects(f.client.create(createCommand, context), { code: 'body_request_unconfirmed', effectUnknown: true });
  const d = deferred(); const g = fixture(undefined, () => d.promise);
  const flight = g.client.capabilities(); g.changeSession();
  d.reject(new ApiError(409, 'session_changed', 'Synthetic', false, true));
  await assert.rejects(flight, stale(true));
});

test('clear and dispose invalidate pending results and permanently prevent new dispatch', async () => {
  for (const close of ['clear', 'dispose']) {
    const d = deferred(), dispatched = deferred();
    const f = fixture(() => { dispatched.resolve(); return d.promise; });
    const flight = f.client.create(createCommand, context); await dispatched.promise;
    f.client[close](); f.client[close](); d.resolve(measurement);
    await assert.rejects(flight, stale(true));
    const before = f.calls.length;
    await assert.rejects(f.client.list(), stale());
    await assert.rejects(f.client.capabilities(), stale());
    assert.equal(f.calls.length, before);
  }
});

test('N1 capability is exact and additive; unavailable control never disables list/delete', async () => {
  for (const manualRetention of [undefined, null, {}, { ...retentionCapability(), grant: true },
    { ...retentionCapability(), revoke: 'unavailable' }, { ...retentionCapability(), extra: true },
    { ...retentionCapability(), statement: { ...contract.MANUAL_RETENTION_STATEMENT_BINDING, sha256: '0'.repeat(64) } }]) {
    const f = fixture(undefined, { ...capabilityResponse(), manualRetention });
    assert.deepEqual(await f.client.capabilities(), { create: false, list: true, delete: true });
    await assert.rejects(f.client.create(createCommand, context), { code: 'body_retention_unavailable' });
    await f.client.list(); await f.client.delete(deleteCommand);
  }
});
test('create requires context and forwards frozen authority/null with the original synchronous guard', async () => {
  const contexts = [], guard = () => {};
  const client = createManualMeasurementsClient({ isCurrentSession: () => true, transport: {
    captureAuthContext: () => ({ isCurrent: () => true }),
    request: async (path, method, body, key, attempt) => {
      if (path.endsWith('/capabilities')) return capabilityResponse();
      contexts.push(attempt); attempt.assertCurrent(); return measurement;
    },
  } });
  await assert.rejects(client.create(createCommand), { code: 'body_retention_authority_required' });
  await client.create(createCommand, { ...context, assertCurrent: guard });
  await client.create(createCommand, { manualRetention: null, assertCurrent: guard });
  assert.equal(contexts[0].assertCurrent, guard); assert.equal(contexts[1].assertCurrent, guard);
  assert.deepEqual(contexts[0].manualRetention, context.manualRetention); assert.equal(contexts[1].manualRetention, null);
  assert.ok(Object.isFrozen(contexts[0].manualRetention));
});
test('grant/revoke/current use strict routes, bodies and distinct receipt/current validation', async () => {
  const decisionId = context.manualRetention.decisionId;
  const payload = { decisionId, processing: 'manual_entry', purpose: 'personal_measurement_progress', choice: 'retain',
    statementId: contract.MANUAL_RETENTION_STATEMENT.id, statementVersion: 1, statementSha256: contract.MANUAL_RETENTION_STATEMENT_SHA256 };
  const current = { decisionId, state: 'granted', revision: 1, statement: contract.MANUAL_RETENTION_STATEMENT_BINDING };
  const f = fixture(async (path, method) => method === 'GET'
    ? { schema: contract.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current }
    : { schema: contract.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA,
      receipt: { operation: path.endsWith('/revoke') ? 'revoke' : 'grant', decisionId,
        outcome: path.endsWith('/revoke') ? 'revoked' : 'granted', decisionRevision: path.endsWith('/revoke') ? 2 : 1 },
      current: path.endsWith('/revoke') ? { ...current, state: 'revoked', revision: 2 } : current });
  await f.client.grantRetention({ key: 'grant-original', payload });
  await f.client.currentRetention(decisionId);
  await f.client.revokeRetention({ key: 'revoke-original', decisionId, payload: {} });
  const writes = f.calls.filter(call => call.method === 'POST');
  assert.equal(writes[0].path, '/v1/body/manual-retention'); assert.deepEqual(writes[0].payload, payload);
  assert.equal(writes[1].path, `/v1/body/manual-retention/${decisionId}/revoke`); assert.deepEqual(writes[1].payload, {});
  const invalid = fixture(async () => ({ schema: contract.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current }));
  await assert.rejects(invalid.client.grantRetention({ key: 'grant', payload }), { code: 'body_retention_unconfirmed', effectUnknown: true });
});

test('receipt-only create establishes N1 protocol without requiring current create/control readiness', async () => {
  const f = fixture(async () => measurement, { ...capabilityResponse(), retainedMeasurements: {},
    manualRetention: { ...retentionCapability(), status: 'unavailable', grant: 'unavailable', revoke: 'unavailable', current: 'unavailable' } });
  assert.deepEqual(await f.client.create(createCommand, { manualRetention: null, assertCurrent() {} }), measurement);
  await assert.rejects(f.client.create(createCommand, context), { code: 'body_retention_unavailable' });
});
