const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..'), modules = new Map();
function load(name) {
  const file = path.resolve(root, name); assert.ok(file.startsWith(root + path.sep));
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(specifier => {
    assert.ok(specifier.startsWith('.'));
    return load(path.relative(root, path.resolve(path.dirname(file), specifier + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { FormTransport, ApiError, captureFormRequestAttemptContext } = load('api/transport.ts');
const contract = load('body/manualRetentionContract.ts');
const decisionId = '11111111-1111-4111-8111-111111111111';
const authority = () => ({ protocol: contract.MANUAL_RETENTION_PROTOCOL, decisionId, revision: 1,
  statementSha256: contract.MANUAL_RETENTION_STATEMENT_SHA256 });
const body = { kind: 'waist', value: 80, unit: 'cm', measuredOn: '2026-10-13' };
async function fixture() {
  const calls = [], storage = { async load() { return null; }, async save() {}, async clear() {} };
  const transport = new FormTransport('https://form.example.invalid', storage, async (url, init) => {
    calls.push({ url, ...init });
    return new Response('{}', { headers: url.endsWith('/sign-in/email') ? { 'set-auth-token': 'synthetic-original' } : {} });
  });
  await transport.signIn('synthetic@example.invalid', 'synthetic-password'); calls.length = 0;
  return { transport, calls };
}

test('exact manual create carries internally serialized authority and preserves bearer, key and payload', async () => {
  const { transport, calls } = await fixture(), context = { manualRetention: authority(), assertCurrent() {} };
  const result = transport.request('/v1/body/measurements', 'POST', body, 'unchanged-key', context);
  context.manualRetention.decisionId = '22222222-2222-4222-8222-222222222222';
  await result;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].headers, { Accept: 'application/json', 'Content-Type': 'application/json',
    Authorization: 'Bearer synthetic-original', 'Idempotency-Key': 'unchanged-key',
    [contract.MANUAL_RETENTION_HEADER]: contract.formatManualRetentionHeader(authority()) });
  assert.equal(calls[0].body, JSON.stringify(body)); assert.equal(calls[0].redirect, 'error');
});

test('authority is forbidden on reads, controls, path aliases and other writes before fetch', async () => {
  const { transport, calls } = await fixture();
  for (const [route, method] of [['/v1/body/measurements', 'GET'], ['/v1/body/measurements?x=1', 'POST'],
    ['/v1/body/measurements/', 'POST'], ['/v1/body/manual-measurements', 'POST'], ['/v1/body/manual-retention', 'POST'],
    [`/v1/body/manual-retention/${decisionId}/revoke`, 'POST'], ['/v1/body/measurements/one/delete', 'POST'],
    ['/v1/body/measurements', 'post']]) {
    for (const context of [{ manualRetention: authority(), assertCurrent() {} }, { manualRetention: null, assertCurrent() {} }])
      await assert.rejects(transport.request(route, method, body, 'key', context), { code: 'invalid_attempt_context' });
  }
  assert.equal(calls.length, 0);
});

test('malformed authority, accessors and generic header bags reject before dispatch', async () => {
  const { transport, calls } = await fixture();
  for (const context of [{}, { manualRetention: { ...authority(), revision: 2 } },
    { manualRetention: { ...authority(), decisionId: 'invalid' } },
    { manualRetention: { ...authority(), statementSha256: '0'.repeat(64) } },
    { manualRetention: authority(), headers: { Authorization: 'replacement' } },
    { headers: { [contract.MANUAL_RETENTION_HEADER]: 'arbitrary' } },
    { get manualRetention() { assert.fail('Accessor must not be called'); } }]) {
    Object.defineProperty(context, 'assertCurrent', { value() {}, enumerable: true });
    await assert.rejects(transport.request('/v1/body/measurements', 'POST', body, 'key', context), { code: 'invalid_attempt_context' });
  }
  assert.equal(calls.length, 0);
});

test('explicit receipt-only attempt omits authority and never mutates measurement intent', async () => {
  const { transport, calls } = await fixture();
  await transport.request('/v1/body/measurements', 'POST', body, 'key', { manualRetention: null, assertCurrent() {} });
  assert.equal(calls[0].headers[contract.MANUAL_RETENTION_HEADER], undefined);
  assert.equal(calls[0].headers['Idempotency-Key'], 'key'); assert.equal(calls[0].body, JSON.stringify(body));
  await transport.request('/v1/body/manual-retention', 'POST', {}, 'control-key');
  assert.equal(calls[1].headers[contract.MANUAL_RETENTION_HEADER], undefined);
});

test('context capture detaches and freezes exact source authority synchronously', () => {
  const assertCurrent = () => {};
  const input = { manualRetention: authority(), assertCurrent }, result = captureFormRequestAttemptContext(input);
  input.manualRetention.revision = 2;
  assert.deepEqual(result, { manualRetention: authority(), assertCurrent });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.manualRetention));
  assert.equal(captureFormRequestAttemptContext(undefined), undefined);
  assert.deepEqual(captureFormRequestAttemptContext({ manualRetention: null, assertCurrent }), { manualRetention: null, assertCurrent });
});

test('auth replacement during lazy protocol loading cannot dispatch under a replacement bearer', async () => {
  const { transport, calls } = await fixture();
  const pending = transport.request('/v1/body/measurements', 'POST', body, 'original-key', { manualRetention: authority(), assertCurrent() {} });
  const replacement = transport.signIn('replacement@example.invalid', 'synthetic-replacement-password');
  await assert.rejects(pending, { code: 'session_changed', effectUnknown: false, originalEffectUnknown: false });
  await replacement;
  assert.equal(calls.filter(call => call.url.endsWith('/v1/body/measurements')).length, 0);
});

test('legacy no-context transport loads and dispatches without executing a protocol import', async () => {
  const module = { exports: {} }, calls = [];
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'api/transport.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(() => assert.fail('No-context transport must not load the protocol module'), module, module.exports);
  const api = new module.exports.FormTransport('https://form.example.invalid', {
    async load() { return null; }, async save() {}, async clear() {},
  }, async (_url, init) => { calls.push(init); return new Response('{}'); });
  await api.request('/v1/body/measurements', 'POST', body, 'legacy-key');
  assert.equal(calls.length, 1); assert.equal(calls[0].headers[contract.MANUAL_RETENTION_HEADER], undefined);
});

test('local revoke or disposal during protocol await blocks fetch with original auth still current', async () => {
  for (const manualRetention of [authority(), null]) {
    const { transport, calls } = await fixture(), auth = transport.captureAuthContext();
    let current = true, checked = 0;
    const context = { manualRetention, assertCurrent() {
      checked++; if (!current) throw new ApiError(409, 'local_fence_changed', 'Synthetic local presentation ended.');
    } };
    const pending = transport.request('/v1/body/measurements', 'POST', body, 'fenced-key', context);
    assert.equal(checked, 1);
    current = false;
    context.assertCurrent = () => assert.fail('A replacement guard must not be adopted');
    await assert.rejects(pending, { code: 'local_fence_changed', effectUnknown: false, originalEffectUnknown: false });
    assert.equal(auth.isCurrent(), true); assert.equal(calls.length, 0); assert.equal(checked, 2);
  }
});

test('supplied context requires an own synchronous guard and fails closed for false, promise or throw', async () => {
  const { transport, calls } = await fixture();
  for (const context of [{ manualRetention: authority() }, { manualRetention: authority(), assertCurrent: null },
    { manualRetention: authority(), get assertCurrent() { assert.fail('Guard getter must not execute'); } }]) {
    await assert.rejects(transport.request('/v1/body/measurements', 'POST', body, 'key', context), { code: 'invalid_attempt_context' });
  }
  for (const assertCurrent of [() => false, () => Promise.resolve(true), () => Promise.reject(new Error('Async guard denied'))]) {
    await assert.rejects(transport.request('/v1/body/measurements', 'POST', body, 'key',
      { manualRetention: authority(), assertCurrent }), { code: 'attempt_not_current', effectUnknown: false });
  }
  const error = new ApiError(409, 'original_guard_denied', 'Synthetic fence denial.');
  await assert.rejects(transport.request('/v1/body/measurements', 'POST', body, 'key',
    { manualRetention: authority(), assertCurrent() { throw error; } }), value => value === error);
  assert.equal(calls.length, 0);
});

test('final guard runs after body initialization and before fetch without claiming an unknown effect', async () => {
  const { transport, calls } = await fixture(); let current = true;
  const payload = { toJSON() { current = false; return body; } };
  await assert.rejects(transport.request('/v1/body/measurements', 'POST', payload, 'key', {
    manualRetention: authority(), assertCurrent() {
      if (!current) throw new ApiError(409, 'local_fence_changed', 'Synthetic local fence changed during serialization.');
    },
  }), { code: 'local_fence_changed', effectUnknown: false, originalEffectUnknown: false });
  assert.equal(calls.length, 0);
});
