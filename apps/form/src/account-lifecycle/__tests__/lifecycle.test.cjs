const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
function load(file, imports = {}) {
  const mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in imports)) throw new Error(`Unexpected import ${name}`);
    return imports[name];
  }, mod, mod.exports);
  return mod.exports;
}
const contract = load('contracts.ts');
const { createAccountLifecycleController } = load('controller.ts', { './contracts': contract });
const { createLifecycleApi } = load('api.ts', { './contracts': contract });
const recovery = () => ({ accountId: 'account-a', baseURL: 'https://synthetic.invalid',
  requestId: '11111111-1111-4111-8111-111111111111', commandKey: 'command-one', statusSecret: 's'.repeat(43) });
const categories = ['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community'];
const receipt = (disabled = false) => ({ requestId: recovery().requestId, phase: disabled ? 'disabled_pending_purge' : 'awaiting_reauthentication',
  initiated: true, disabled, localPurged: false, complete: false, requestedAt: '2026-10-11T12:00:00Z', backupExpiryAt: null,
  billingCancellation: 'not_performed', reauthentication: 'password_only_qualified_source',
  steps: categories.map(category => ({ category, status: 'pending', retain_until_ms: null })) });
const settings = () => ({ accountId: 'account-a', stagedAccountLifecycle: { status: 'configured_unverified', initiation: true,
  passwordActionReauthentication: true, phoneActionReauthentication: false, oauthActionReauthentication: false,
  wholeAccountDeletionComplete: false, exportMaxBytes: contract.EXPORT_MAX_BYTES, billingCancellation: 'not_performed' } });
const exported = () => ({ records: [{ category: 'identity', value: { accountId: 'account-a' } }], manifest: {
  schemaVersion: 'form.account-export.v1', snapshotAtMs: 123, complete: false, scope: { accountId: 'account-a', epoch: 0 },
  categories: [{ category: 'identity', status: 'complete', count: 1 }], omissions: [], residuals: [] } });
function fixture(overrides = {}) {
  const calls = []; let saved = null, active = true;
  const api = { baseURL: recovery().baseURL, settings: async () => settings(),
    grant: async purpose => { calls.push('grant'); return { grant: 'g'.repeat(43), purpose, method: 'password', expiresAt: '2099-01-01T00:00:00Z' }; },
    export: async () => { calls.push('export'); return exported(); },
    initiate: async () => { calls.push('initiate'); return receipt(); },
    confirm: async () => { calls.push('confirm'); return receipt(true); }, status: async () => { calls.push('status'); return receipt(); }, ...overrides.api };
  const context = { accountId: 'account-a', sessionKey: 'session-a', isCurrent: () => active, api,
    actionsQualified: true, onAccessDisabled: async () => {},
    receipts: { load: async () => saved, save: async r => { calls.push('save'); saved = r; } },
    createReceipt: async () => recovery(), deliverExport: async () => { calls.push('deliver'); return 'delivered'; },
    ...overrides.context };
  return { c: createAccountLifecycleController(context), calls, expire: () => { active = false; }, saved: () => saved };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('staged-off settings and absent custody/delivery cannot start actions', async () => {
  for (const value of [{ accountId: 'account-a' }, { ...settings(), stagedAccountLifecycle: { initiation: true } }]) {
    const { c, calls } = fixture({ api: { settings: async () => value } });
    await c.initialize(); await c.exportAccount('secret'); await c.requestDeletion();
    assert.equal(c.snapshot().phase, 'unavailable'); assert.deepEqual(calls, []);
  }
  const { c, calls } = fixture({ context: { receipts: undefined, deliverExport: undefined } });
  await c.initialize(); await c.requestDeletion(); await c.exportAccount('secret'); assert.deepEqual(calls, []);
});
test('receipt persisted before initiate; explicit confirmation and password gate disable only', async () => {
  const { c, calls, saved } = fixture(); await c.initialize(); await c.requestDeletion();
  assert.deepEqual(calls, ['save', 'initiate']); assert.deepEqual(saved(), recovery());
  await c.confirmDeletion('secret', 'yes'); assert.equal(calls.length, 2);
  await c.confirmDeletion('secret', 'DELETE'); assert.deepEqual(calls, ['save', 'initiate', 'grant', 'confirm']);
  assert.equal(c.snapshot().phase, 'disabled'); assert.equal(c.snapshot().receipt.complete, false);
  await c.requestDeletion(); await c.exportAccount('secret'); assert.equal(calls.length, 4);
});
test('storage failures and mismatched readback never submit deletion', async () => {
  for (const receipts of [{ load: async () => null, save: async () => { throw Error('disk'); } },
    { load: async () => null, save: async () => {} }]) {
    const { c, calls } = fixture({ context: { receipts } }); await c.initialize(); await c.requestDeletion(); await c.requestDeletion();
    assert.deepEqual(calls, []); assert.equal(c.snapshot().phase, 'error');
  }
});
test('unknown initiation is fenced until authoritative status, without duplicate request', async () => {
  const { c, calls } = fixture({ api: { initiate: async () => { calls.push('initiate'); throw Error('lost'); } } });
  await c.initialize(); await c.requestDeletion(); assert.equal(c.snapshot().phase, 'unknown');
  await c.requestDeletion(); await c.confirmDeletion('secret', 'DELETE'); assert.deepEqual(calls, ['save', 'initiate']);
  await c.checkStatus(); await c.confirmDeletion('secret', 'DELETE'); assert.equal(c.snapshot().phase, 'disabled');
});
test('unknown confirmation reconciles with receipt auth and never blindly repeats', async () => {
  const { c, calls } = fixture({ api: { confirm: async () => { calls.push('confirm'); throw { code: 'deletion_effect_unknown', effectUnknown: true }; },
    status: async () => receipt(true) } });
  await c.initialize(); await c.requestDeletion(); await c.confirmDeletion('secret', 'DELETE');
  await c.confirmDeletion('secret', 'DELETE'); assert.equal(calls.filter(x => x === 'confirm').length, 1);
  await c.checkStatus(); assert.equal(c.snapshot().phase, 'disabled');
});
test('restored receipt checks status without an authenticated settings call', async () => {
  const { c, calls } = fixture({ context: { receipts: { load: async () => recovery(), save: async () => assert.fail() } },
    api: { settings: async () => assert.fail('session revoked'), status: async () => receipt(true) } });
  await c.initialize(); assert.equal(c.snapshot().phase, 'unknown'); await c.checkStatus();
  assert.equal(c.snapshot().phase, 'disabled'); assert.deepEqual(calls, []);
});
test('cross-account and cross-endpoint stored receipts are rejected', async () => {
  for (const change of [{ accountId: 'account-b' }, { baseURL: 'https://other.invalid' }]) {
    const { c, calls } = fixture({ context: { receipts: { load: async () => ({ ...recovery(), ...change }), save: async () => {} } } });
    await c.initialize(); await c.checkStatus(); assert.equal(c.snapshot().phase, 'error'); assert.deepEqual(calls, []);
  }
});
test('late settings and export results never reach another account or delivery', async () => {
  const wait = deferred(); const f = fixture({ api: { settings: () => wait.promise } });
  const pending = f.c.initialize(); f.expire(); wait.resolve(settings()); await pending;
  assert.equal(f.c.snapshot().phase, 'disposed'); assert.equal(f.c.snapshot().available, false);
  const waitExport = deferred(); const g = fixture({ api: { export: () => waitExport.promise } });
  await g.c.initialize(); const exporting = g.c.exportAccount('secret'); await Promise.resolve(); await Promise.resolve();
  g.expire(); waitExport.resolve(exported()); await exporting; assert.ok(!g.calls.includes('deliver'));
});
test('dispose during reauthentication prevents deletion confirmation', async () => {
  const wait = deferred(); const f = fixture({ api: { grant: () => wait.promise } });
  await f.c.initialize(); await f.c.requestDeletion(); const pending = f.c.confirmDeletion('secret', 'DELETE');
  f.c.dispose(); wait.resolve({ grant: 'g'.repeat(43), purpose: 'account_delete', method: 'password', expiresAt: '2099-01-01T00:00:00Z' });
  await pending; assert.ok(!f.calls.includes('confirm')); assert.equal(f.c.snapshot().receipt, null);
});
test('concurrent clicks submit only one request', async () => {
  const wait = deferred(); const f = fixture({ api: { initiate: async () => { f.calls.push('initiate'); return wait.promise; } } });
  await f.c.initialize(); const first = f.c.requestDeletion(); await f.c.requestDeletion(); wait.resolve(receipt()); await first;
  assert.equal(f.calls.filter(x => x === 'save').length, 1); assert.equal(f.calls.filter(x => x === 'initiate').length, 1);
});
test('malformed receipts cannot claim erasure, wrong request, backup expiry or billing cancellation', () => {
  for (const change of [{ requestId: 'other' }, { complete: true }, { backupExpiryAt: '2099-01-01' },
    { billingCancellation: 'complete' }, { disabled: true }, { localPurged: true }, { steps: [] }])
    assert.throws(() => contract.deletionReceipt({ ...receipt(), ...change }, recovery().requestId));
});
test('export is delivered only after scope, manifest and category counts validate', async () => {
  const f = fixture(); await f.c.initialize(); await f.c.exportAccount('secret');
  assert.equal(f.c.snapshot().exportStatus, 'delivered'); assert.deepEqual(f.calls, ['grant', 'export', 'deliver']);
  for (const mutate of [r => { r.manifest.scope.accountId = 'account-b'; }, r => { r.manifest.complete = true; },
    r => { r.manifest.categories[0].count = 2; }, r => { r.records[0].value.accountId = 'account-b'; }]) {
    const value = exported(); mutate(value); const g = fixture({ api: { export: async () => value } });
    await g.c.initialize(); await g.c.exportAccount('secret'); assert.equal(g.c.snapshot().phase, 'unknown'); assert.ok(!g.calls.includes('deliver'));
  }
});
test('purpose and expiry of action grants are checked before export', async () => {
  for (const change of [{ purpose: 'account_delete' }, { expiresAt: '2000-01-01' }]) {
    const f = fixture({ api: { grant: async () => ({ grant: 'g'.repeat(43), purpose: 'account_export', method: 'password', expiresAt: '2099-01-01', ...change }) } });
    await f.c.initialize(); await f.c.exportAccount('secret'); assert.deepEqual(f.calls, []); assert.equal(f.c.snapshot().phase, 'unknown');
  }
});
test('receipt status transport sends no session/cookies, uses exact POST route, rejects another endpoint', async () => {
  const calls = [];
  const api = createLifecycleApi({ baseURL: recovery().baseURL, request: async () => assert.fail('must not borrow session') }, async (url, init) => {
    calls.push([url, init]); return { ok: true, json: async () => receipt(true) };
  });
  await api.status(recovery()); const [url, init] = calls[0];
  assert.equal(url, recovery().baseURL + '/v1/account-deletion/status');
  assert.equal(init.headers.Authorization, `DeletionReceipt ${recovery().statusSecret}`);
  assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { requestId: recovery().requestId });
  await assert.rejects(api.status({ ...recovery(), baseURL: 'https://other.invalid' })); assert.equal(calls.length, 1);
});
test('commands consume exact existing endpoints and policy with stable idempotency key', async () => {
  const calls = []; const api = createLifecycleApi({ baseURL: recovery().baseURL, request: async (...args) => { calls.push(args); } });
  await api.initiate(recovery()); await api.confirm(recovery().requestId, 'g'.repeat(43)); await api.export('e'.repeat(43));
  assert.equal(calls[0][0], '/v1/me/deletion-requests'); assert.equal(calls[0][3], recovery().commandKey);
  assert.equal(calls[0][2].policyVersion, 'form-account-lifecycle-v1'); assert.equal(calls[0][2].confirmation, 'delete_whole_account');
  assert.equal(calls[1][0], `/v1/me/deletion-requests/${recovery().requestId}/confirm`); assert.equal(calls[2][0], '/v1/me/account-export');
});

test('host qualification and teardown binding are required independently of configured source', async () => {
  for (const context of [{ actionsQualified: undefined }, { actionsQualified: false }, { onAccessDisabled: undefined }]) {
    const f = fixture({ context }); await f.c.initialize(); await f.c.requestDeletion(); assert.deepEqual(f.calls, []);
  }
});
test('confirmed disable invokes host cleanup; cleanup failure never claims erasure or retries', async () => {
  let cleanup = 0; const f = fixture({ context: { onAccessDisabled: async () => { cleanup++; throw Error('cleanup'); } } });
  await f.c.initialize(); await f.c.requestDeletion(); await f.c.confirmDeletion('secret', 'DELETE');
  assert.equal(cleanup, 1); assert.equal(f.c.snapshot().phase, 'disabled');
  assert.match(f.c.snapshot().message, /cleanup could not be confirmed/);
});
