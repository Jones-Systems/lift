const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();
function load(name) {
  const file = path.resolve(root, name);
  assert.ok(file.startsWith(root + path.sep));
  if (modules.has(file)) return modules.get(file).exports;
  if (file === path.join(root, 'api/client.ts')) {
    return { ApiError: load('api/transport.ts').ApiError, formApi: {} };
  }
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { createMembershipSession } = load('integration/membershipSession.ts');
const { FormResources } = load('api/resources.ts');
const { ApiError } = load('api/transport.ts');
const account = { accountId: 'synthetic-account', appAccountToken: '11111111-1111-4111-8111-111111111111' };
const proof = { transactionId: '12345', originalTransactionId: '12344', productId: 'synthetic.product',
  productType: 'auto-renewable', appAccountToken: account.appAccountToken, purchaseDateMs: 1,
  expirationDateMs: null, revocationDateMs: null, localVerification: 'verified', productAllowed: true,
  jwsRepresentation: 'synthetic-proof-not-an-apple-signature', source: 'purchase' };
const delivery = { transactionId: proof.transactionId, productId: proof.productId,
  jwsRepresentation: proof.jwsRepresentation, idempotencyKey: `storekit-delivery:${proof.transactionId}` };
const decision = { status: 'delivered', accountId: account.accountId, transactionId: proof.transactionId,
  productId: proof.productId, serverDeliveryId: 'synthetic-delivery' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const changed = error => error instanceof ApiError && error.code === 'session_changed';
function fixture(options = {}, response = async () => ({ ...decision })) {
  const calls = [];
  let generation = 1, current = true, keys = 0;
  const api = {
    captureAuthContext() { const captured = generation; return { isCurrent: () => captured === generation }; },
    async request(...args) { calls.push(['http', ...args]); return response(...args); },
  };
  const ctx = { account: { ...account }, sessionGeneration: 'session-one', isCurrentSession: () => current,
    resources: new FormResources(api), appMode: 'basic', close() {} };
  const native = {
    async products(ids) { calls.push(['products', ids]); return { products: [], missingProductIds: ids }; },
    async purchase(id, token) { calls.push(['purchase', id, token]); return { status: 'transaction', transaction: { ...proof } }; },
    async restore() { calls.push(['restore']); return { transactions: [], truncated: false }; },
    async currentEntitlements() { calls.push(['currentEntitlements']); return { transactions: [], truncated: false }; },
    async acknowledgeServerDelivery(id, jws, serverDeliveryId) {
      calls.push(['ack', id, jws, serverDeliveryId]); return { finished: true, transactionId: id, serverDeliveryId };
    },
  };
  const bound = createMembershipSession(ctx, { native, configured: true, allowedProductIds: [proof.productId], promos: true,
    newIdempotencyKey: () => { keys++; return 'synthetic-command-key'; },
    openManageSubscriptions: async () => { calls.push(['manage']); }, ...options });
  return { ...bound, ctx, api, calls, keys: () => keys, replaceAuth: () => { generation++; }, expire: () => { current = false; } };
}

test('capture freezes identity and account-bound reads and promo dispatch use original resources', async () => {
  const f = fixture({}, async route => route === '/v1/entitlements' ? { ...account, active: [], grants: [] } : { charged: false });
  try {
    const session = f.ports.captureSession(); assert.ok(session);
    assert.equal(Object.isFrozen(session), true); assert.equal(Object.isFrozen(session.account), true);
    f.ctx.account.accountId = 'later-account'; f.ctx.sessionGeneration = 'later-generation';
    f.ctx.resources = { boundTo() { throw new Error('new resources used'); } };
    assert.deepEqual(session.account, account); assert.equal(session.generation, 'session-one');
    assert.equal((await session.readEntitlements()).accountId, account.accountId);
    await session.redeem('EXACT-code', 'original-key');
    assert.deepEqual(f.calls, [['http', '/v1/entitlements', 'GET', undefined, undefined],
      ['http', '/v1/promo-redemptions', 'POST', { code: 'EXACT-code' }, 'original-key']]);
  } finally { f.dispose(); }
});

test('same-account replacement invalidates old captures and secure key issuance before dispatch', async () => {
  const f = fixture();
  try {
    const captured = f.ports.captureSession();
    assert.equal(f.ports.newIdempotencyKey(), 'synthetic-command-key');
    f.replaceAuth();
    assert.equal(captured.isCurrent(), false); assert.equal(f.ports.captureSession(), null);
    assert.throws(() => f.ports.newIdempotencyKey(), changed); assert.equal(f.keys(), 1);
    await assert.rejects(captured.readEntitlements(), changed);
    assert.throws(() => captured.redeem('code', 'key'), changed);
    assert.deepEqual(await captured.deliver(delivery, proof), { status: 'rejected', code: 'session_changed' });
    await assert.rejects(f.ports.native.purchase(proof.productId, account.appAccountToken), changed);
    assert.deepEqual(f.calls, []);
  } finally { f.dispose(); }
});

test('purchase forwards exact captured token and product allowlist without rereading account', async () => {
  const f = fixture();
  try {
    f.ctx.account.appAccountToken = '22222222-2222-4222-8222-222222222222';
    await assert.rejects(f.ports.native.purchase('other.product', account.appAccountToken), { code: 'product_not_allowed' });
    await assert.rejects(f.ports.native.purchase(proof.productId, f.ctx.account.appAccountToken), { code: 'account_token_mismatch' });
    const result = await f.ports.native.purchase(proof.productId, account.appAccountToken);
    assert.equal(result.status, 'transaction');
    assert.deepEqual(f.calls, [['purchase', proof.productId, account.appAccountToken]]);
  } finally { f.dispose(); }
});

test('delivery sends exact proof/key then acknowledges only a matching server decision', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.ports.captureSession().deliver(delivery, proof), {
      status: 'finished', transactionId: proof.transactionId, serverDeliveryId: decision.serverDeliveryId,
    });
    assert.deepEqual(f.calls, [['http', '/v1/purchases/apple/verify', 'POST', delivery, delivery.idempotencyKey],
      ['ack', proof.transactionId, proof.jwsRepresentation, decision.serverDeliveryId]]);
  } finally { f.dispose(); }
});

test('mismatched request, key or proof account cannot dispatch delivery', async () => {
  const f = fixture();
  try {
    const session = f.ports.captureSession();
    for (const patch of [{ productId: 'other' }, { transactionId: '12' }, { jwsRepresentation: 'different' }, { idempotencyKey: 'different' }])
      assert.deepEqual(await session.deliver({ ...delivery, ...patch }, proof), { status: 'rejected', code: 'invalid_delivery_request' });
    assert.deepEqual(await session.deliver(delivery, { ...proof, appAccountToken: '22222222-2222-4222-8222-222222222222' }),
      { status: 'rejected', code: 'account_token_mismatch' });
    assert.deepEqual(f.calls, []);
  } finally { f.dispose(); }
});

test('late successful delivery after session replacement never acknowledges native completion', async () => {
  const pending = deferred(), entered = deferred();
  const f = fixture({}, () => { entered.resolve(); return pending.promise; });
  try {
    const result = f.ports.captureSession().deliver(delivery, proof);
    await entered.promise; f.replaceAuth(); pending.resolve({ ...decision });
    assert.deepEqual(await result, { status: 'delivered_unfinished', code: 'account_changed',
      transactionId: proof.transactionId, serverDeliveryId: decision.serverDeliveryId });
    assert.deepEqual(f.calls.map(call => call[0]), ['http']);
  } finally { f.dispose(); }
});

test('malformed or mismatched server decisions never acknowledge', async () => {
  for (const value of [null, {}, { status: 'rejected' }, { ...decision, accountId: 'other-account' },
    { ...decision, transactionId: '99' }, { ...decision, productId: 'other' }, { ...decision, serverDeliveryId: '' }]) {
    const f = fixture({}, async () => value);
    try {
      assert.deepEqual(await f.ports.captureSession().deliver(delivery, proof), { status: 'unknown', code: 'server_ack_mismatch' });
      assert.deepEqual(f.calls.map(call => call[0]), ['http']);
    } finally { f.dispose(); }
  }
});

test('late native purchase proof remains available for recovery but cannot be delivered by stale session', async () => {
  const pending = deferred();
  const f = fixture({ native: { purchase: () => pending.promise } });
  try {
    const session = f.ports.captureSession();
    const result = f.ports.native.purchase(proof.productId, account.appAccountToken);
    f.expire(); pending.resolve({ status: 'transaction', transaction: { ...proof } });
    assert.deepEqual(await result, { status: 'transaction', transaction: proof });
    assert.deepEqual(await session.deliver(delivery, proof), { status: 'rejected', code: 'session_changed' });
    assert.deepEqual(f.calls, []);
  } finally { f.dispose(); }
});

test('absent native or explicit configuration is unavailable and default construction invokes no native ports', async () => {
  for (const options of [{ native: undefined }, { configured: false }, { allowedProductIds: [] }]) {
    const f = fixture(options);
    try {
      assert.equal(f.ports.configuration().purchases, 'unavailable');
      assert.deepEqual(await f.ports.native.purchase(proof.productId, account.appAccountToken), { status: 'unavailable', productId: proof.productId });
      await assert.rejects(f.ports.native.products(), { code: 'purchases_unavailable' });
      assert.deepEqual(f.calls, []);
    } finally { f.dispose(); }
  }
  const f = fixture(), plain = createMembershipSession(f.ctx);
  try {
    assert.deepEqual(plain.ports.configuration(), { purchases: 'unavailable', promos: false });
    assert.throws(() => plain.ports.newIdempotencyKey(), { code: 'command_key_unavailable' });
    await assert.rejects(plain.ports.openManageSubscriptions(), { code: 'subscription_management_unavailable' });
    assert.deepEqual(f.calls, []);
  } finally { plain.dispose(); f.dispose(); }
});

test('explicit native enumeration and system management use only supplied ports; disposal revokes all dispatch', async () => {
  const f = fixture();
  const session = f.ports.captureSession();
  await f.ports.native.products(); await f.ports.native.restore(); await f.ports.native.currentEntitlements();
  await f.ports.openManageSubscriptions();
  assert.deepEqual(f.calls, [['products', [proof.productId]], ['restore'], ['currentEntitlements'], ['manage']]);
  f.dispose(); f.dispose();
  assert.equal(session.isCurrent(), false); assert.equal(f.ports.captureSession(), null);
  assert.deepEqual(f.ports.configuration(), { purchases: 'unavailable', promos: false });
  assert.throws(() => f.ports.newIdempotencyKey(), changed); assert.equal(f.keys(), 0);
  await assert.rejects(f.ports.native.restore(), changed);
  await assert.rejects(f.ports.native.currentEntitlements(), changed);
  await assert.rejects(f.ports.openManageSubscriptions(), changed);
  assert.deepEqual(await session.deliver(delivery, proof), { status: 'rejected', code: 'session_changed' });
  assert.equal(f.calls.length, 4);
});


test('session replacement between coordinator account capture and HTTP dispatch rejects without a request', async () => {
  const f = fixture();
  try {
    const result = f.ports.captureSession().deliver(delivery, proof);
    f.replaceAuth();
    assert.deepEqual(await result, { status: 'rejected', code: 'session_changed' });
    assert.deepEqual(f.calls, []);
  } finally { f.dispose(); }
});

test('late entitlement reads are suppressed by the original resource binding', async () => {
  const pending = deferred();
  const f = fixture({}, () => pending.promise);
  try {
    const result = f.ports.captureSession().readEntitlements();
    f.expire(); pending.resolve({ ...account, active: ['synthetic-membership'], grants: [] });
    await assert.rejects(result, changed);
    assert.equal(f.calls.length, 1);
  } finally { f.dispose(); }
});
