const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
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
const contracts = load('contracts.ts');
const { createAccountLifecycleController } = load('controller.ts', { './contracts': contracts });
const accountId = 'synthetic-account-a', baseURL = 'https://synthetic.invalid';
const uuid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const receipt = (n = 1, account = accountId, endpoint = baseURL) => ({ accountId: account, baseURL: endpoint,
  requestId: uuid(n), commandKey: uuid(n + 100), statusSecret: 'ab'.repeat(32) });
const keyFor = (account, endpoint) => `form.lifecycle.receipt.${createHash('sha256').update(JSON.stringify([endpoint, account])).digest('hex')}`;
function nativeFixture({ platform = 'ios', available = true, stored = new Map(), faults = {} } = {}) {
  const calls = []; let nextUUID = 1;
  const store = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'synthetic-device-only',
    async isAvailableAsync() { calls.push(['available']); if (faults.available) throw faults.available; return available; },
    async getItemAsync(key, options) {
      calls.push(['get', key, options]); if (faults.get) throw faults.get;
      return stored.get(key) ?? null;
    },
    async setItemAsync(key, value, options) {
      calls.push(['set', key, value, options]);
      if (faults.set) throw faults.set;
      if (!faults.dropWrite) stored.set(key, value);
      if (faults.afterSet) throw faults.afterSet;
    },
  };
  const crypto = {
    CryptoDigestAlgorithm: { SHA256: 'synthetic-sha256' },
    async digestStringAsync(algorithm, text) {
      calls.push(['digest', algorithm, text]); if (faults.digest) throw faults.digest;
      return createHash('sha256').update(text).digest('hex');
    },
    async getRandomBytesAsync(size) {
      calls.push(['random', size]); if (faults.random) throw faults.random;
      return Uint8Array.from({ length: size }, (_, i) => i);
    },
    randomUUID() { calls.push(['uuid']); if (faults.uuid) throw faults.uuid; return uuid(nextUUID++); },
  };
  const native = load('native.ts', { 'react-native': { Platform: { OS: platform } }, 'expo-crypto': crypto,
    'expo-secure-store': store, './contracts': contracts });
  return { ...native, stored, calls, faults };
}
const requestCount = f => f.calls.filter(c => c[0] === 'set').length;
const settings = { accountId, stagedAccountLifecycle: { status: 'configured_unverified', initiation: true,
  passwordActionReauthentication: true, phoneActionReauthentication: false, oauthActionReauthentication: false,
  wholeAccountDeletionComplete: false, exportMaxBytes: contracts.EXPORT_MAX_BYTES, billingCancellation: 'not_performed' } };
const deletion = { requestId: receipt().requestId, phase: 'awaiting_reauthentication', initiated: true, disabled: false,
  localPurged: false, complete: false, requestedAt: '2026-10-11T12:00:00Z', backupExpiryAt: null,
  billingCancellation: 'not_performed', reauthentication: 'password_only_qualified_source',
  steps: ['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community']
    .map(category => ({ category, status: 'pending', retain_until_ms: null })) };
function controller(custody, overrides = {}) {
  const calls = [];
  const api = { baseURL, settings: async () => settings,
    initiate: async value => { calls.push(['initiate', value]); return deletion; },
    status: async value => { calls.push(['status', value]); return deletion; },
    grant: async () => assert.fail('unexpected grant'), export: async () => assert.fail('unexpected export'),
    confirm: async () => assert.fail('unexpected confirm'), ...overrides };
  return { calls, c: createAccountLifecycleController({ accountId, sessionKey: 'synthetic-session', isCurrent: () => true,
    actionsQualified: true, onAccessDisabled: async () => {}, api, ...custody }) };
}

test('web and unavailable secure storage return no custody and never touch keys or crypto', async () => {
  const web = nativeFixture({ platform: 'web' }); assert.equal(await web.nativeReceiptCustody(accountId, baseURL), null);
  assert.deepEqual(web.calls, []);
  const unavailable = nativeFixture({ available: false }); assert.equal(await unavailable.nativeReceiptCustody(accountId, baseURL), null);
  assert.deepEqual(unavailable.calls, [['available']]);
});

test('scope key hashes the exact normalized endpoint and account and every read/write uses device-only options', async () => {
  const f = nativeFixture(); const custody = await f.nativeReceiptCustody(accountId, baseURL + '/');
  assert.equal(await custody.receipts.load(), null); await custody.receipts.save(receipt());
  assert.deepEqual(await custody.receipts.load(), receipt());
  assert.deepEqual(f.calls[1], ['digest', 'synthetic-sha256', JSON.stringify([baseURL, accountId])]);
  for (const c of f.calls.filter(c => c[0] === 'get' || c[0] === 'set')) {
    assert.equal(c[1], keyFor(accountId, baseURL)); assert.deepEqual(c.at(-1), { keychainAccessible: 'synthetic-device-only' });
  }
  assert.equal(f.stored.get(keyFor(accountId, baseURL)), JSON.stringify(receipt()));
});

test('different accounts and endpoints never share a retained receipt', async () => {
  const f = nativeFixture(); const a = await f.nativeReceiptCustody(accountId, baseURL);
  const b = await f.nativeReceiptCustody('synthetic-account-b', baseURL);
  const otherEndpoint = await f.nativeReceiptCustody(accountId, 'https://other.invalid');
  await a.receipts.save(receipt()); assert.equal(await b.receipts.load(), null); assert.equal(await otherEndpoint.receipts.load(), null);
  await b.receipts.save(receipt(2, 'synthetic-account-b')); await otherEndpoint.receipts.save(receipt(3, accountId, 'https://other.invalid'));
  assert.equal(f.stored.size, 3); assert.deepEqual(await a.receipts.load(), receipt());
});

test('receipt creation requests 32 random bytes and independent request and command UUIDs', async () => {
  const f = nativeFixture(); const custody = await f.nativeReceiptCustody(accountId, baseURL + '/');
  const r = await custody.createReceipt();
  assert.equal(r.requestId, uuid(1)); assert.equal(r.commandKey, uuid(2)); assert.notEqual(r.requestId, r.commandKey);
  assert.equal(r.statusSecret, Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(''));
  assert.equal(r.statusSecret.length, 64); assert.deepEqual(contracts.recoveryReceipt(r, accountId, baseURL), r);
  assert.equal(f.calls.filter(c => c[0] === 'uuid').length, 2); assert.deepEqual(f.calls.find(c => c[0] === 'random'), ['random', 32]);
  assert.equal(f.stored.size, 0);
});

test('load rejects malformed, foreign and invalid-secret persisted receipts without replacement', async () => {
  const invalid = ['{', 'null', JSON.stringify(receipt(1, 'other-account')), JSON.stringify(receipt(1, accountId, 'https://other.invalid')),
    JSON.stringify({ ...receipt(), statusSecret: 'short' })];
  for (const value of invalid) {
    const f = nativeFixture({ stored: new Map([[keyFor(accountId, baseURL), value]]) });
    const custody = await f.nativeReceiptCustody(accountId, baseURL);
    await assert.rejects(custody.receipts.load()); assert.equal(requestCount(f), 0);
    assert.equal(f.stored.get(keyFor(accountId, baseURL)), value);
  }
});

test('save validates receipt ownership before storage and never overwrites a different retained receipt', async () => {
  const f = nativeFixture(); const custody = await f.nativeReceiptCustody(accountId, baseURL);
  await assert.rejects(custody.receipts.save(receipt(1, 'other-account'))); assert.equal(requestCount(f), 0);
  await custody.receipts.save(receipt()); await custody.receipts.save(receipt());
  const before = requestCount(f); await assert.rejects(custody.receipts.save(receipt(2)), /replacement/);
  assert.equal(requestCount(f), before); assert.deepEqual(await custody.receipts.load(), receipt());
});

test('concurrent same-scope custody instances retain the first receipt and reject its replacement', async () => {
  const f = nativeFixture();
  const a = await f.nativeReceiptCustody(accountId, baseURL);
  const b = await f.nativeReceiptCustody(accountId, baseURL + '/');
  const results = await Promise.allSettled([a.receipts.save(receipt()), b.receipts.save(receipt(2))]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.deepEqual(await a.receipts.load(), receipt()); assert.equal(requestCount(f), 1);
});

test('independent scope saves do not share a storage queue or receipt', async () => {
  const f = nativeFixture(); const a = await f.nativeReceiptCustody(accountId, baseURL);
  const b = await f.nativeReceiptCustody('synthetic-account-b', baseURL);
  await Promise.all([a.receipts.save(receipt()), b.receipts.save(receipt(2, 'synthetic-account-b'))]);
  assert.equal(requestCount(f), 2); assert.deepEqual(await a.receipts.load(), receipt());
  assert.deepEqual(await b.receipts.load(), receipt(2, 'synthetic-account-b'));
});

test('storage availability, hashing, random bytes and UUID errors propagate without persisting a receipt', async () => {
  for (const failure of ['available', 'digest', 'random', 'uuid']) {
    const error = Error(`synthetic-${failure}`); const f = nativeFixture({ faults: { [failure]: error } });
    await assert.rejects(async () => { const custody = await f.nativeReceiptCustody(accountId, baseURL); await custody.createReceipt(); },
      result => result === error);
    assert.equal(requestCount(f), 0); assert.equal(f.stored.size, 0);
  }
});

test('failed reads and writes do not fabricate saved receipts or prevent later exact recovery', async () => {
  const f = nativeFixture(); const custody = await f.nativeReceiptCustody(accountId, baseURL);
  f.faults.get = Error('read unavailable'); await assert.rejects(custody.receipts.load(), /read unavailable/);
  await assert.rejects(custody.receipts.save(receipt()), /read unavailable/); assert.equal(requestCount(f), 0);
  delete f.faults.get; f.faults.set = Error('write unavailable');
  await assert.rejects(custody.receipts.save(receipt()), /write unavailable/); assert.equal(f.stored.size, 0);
  delete f.faults.set; await custody.receipts.save(receipt()); assert.deepEqual(await custody.receipts.load(), receipt());
});

test('write-then-error leaves exact receipt recoverable and prohibits another receipt', async () => {
  const f = nativeFixture({ faults: { afterSet: Error('write outcome unknown') } });
  const custody = await f.nativeReceiptCustody(accountId, baseURL);
  await assert.rejects(custody.receipts.save(receipt()), /write outcome unknown/); delete f.faults.afterSet;
  await assert.rejects(custody.receipts.save(receipt(2)), /replacement/);
  const restarted = nativeFixture({ stored: f.stored }); const recovered = await restarted.nativeReceiptCustody(accountId, baseURL);
  assert.deepEqual(await recovered.receipts.load(), receipt());
});

test('controller reads back actual native receipt before initiation and recovers it after restart', async () => {
  const f = nativeFixture(); const custody = await f.nativeReceiptCustody(accountId, baseURL);
  const first = controller(custody, { initiate: async r => {
    assert.equal(f.stored.get(keyFor(accountId, baseURL)), JSON.stringify(r));
    assert.equal(f.calls.at(-1)[0], 'get'); return { ...deletion, requestId: r.requestId };
  } });
  await first.c.initialize(); await first.c.requestDeletion(); assert.equal(first.c.snapshot().phase, 'ready'); first.c.dispose();
  const restarted = nativeFixture({ stored: f.stored }); const recovered = await restarted.nativeReceiptCustody(accountId, baseURL);
  const second = controller(recovered, { settings: async () => assert.fail('must recover without session') });
  await second.c.initialize(); assert.equal(second.c.snapshot().phase, 'unknown'); await second.c.checkStatus();
  assert.equal(second.c.snapshot().phase, 'ready'); assert.equal(second.calls[0][0], 'status');
  assert.deepEqual(second.calls[0][1], await recovered.receipts.load()); assert.equal(requestCount(restarted), 0);
});

test('silent native write loss is caught by controller readback before any deletion request', async () => {
  const f = nativeFixture({ faults: { dropWrite: true } }); const custody = await f.nativeReceiptCustody(accountId, baseURL);
  const { c, calls } = controller(custody); await c.initialize(); await c.requestDeletion();
  assert.equal(c.snapshot().phase, 'error'); assert.deepEqual(calls, []);
  await c.requestDeletion(); assert.equal(requestCount(f), 1); assert.deepEqual(calls, []);
});
