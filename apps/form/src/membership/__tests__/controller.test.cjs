const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MembershipController } = require('../controller.ts');

const ACCOUNT = { accountId: 'synthetic-account', appAccountToken: '11111111-1111-4111-8111-111111111111' };
const PRODUCT = { id: 'synthetic.membership', displayName: 'Synthetic membership', description: 'Synthetic fixture',
  displayPrice: 'CHF 12.30', price: '12.30', currencyCode: 'CHF', type: 'autoRenewable' };
const PROOF = { transactionId: '100', originalTransactionId: '99', productId: PRODUCT.id, productType: 'autoRenewable',
  appAccountToken: ACCOUNT.appAccountToken, purchaseDateMs: 1, expirationDateMs: null, revocationDateMs: null,
  localVerification: 'verified', productAllowed: true, jwsRepresentation: 'synthetic.jws.receipt', source: 'purchase' };
const entitlement = (active = []) => ({ ...ACCOUNT, grants: [], active,
  purchases: { status: 'configured_unverified', environment: 'Sandbox', chargesEnabled: false,
    verification: 'apple_jws_offline', onlineCertificateRevocation: false } });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture() {
  let current = true;
  const calls = [];
  const session = { account: { ...ACCOUNT }, generation: 'synthetic-generation', isCurrent: () => current,
    readEntitlements: async () => { calls.push(['read']); return entitlement(); },
    redeem: async (code, key) => { calls.push(['redeem', code, key]); return { charged: false }; },
    deliver: async (request, proof) => {
      calls.push(['deliver', request, proof]);
      return { status: 'finished', transactionId: proof.transactionId, serverDeliveryId: 'synthetic-delivery' };
    } };
  const ports = {
    captureSession: () => session,
    configuration: () => ({ purchases: 'configured', promos: true }),
    native: {
      products: async () => { calls.push(['products']); return { products: [{ ...PRODUCT }], missingProductIds: [] }; },
      purchase: async (product, token) => { calls.push(['purchase', product, token]); return { status: 'transaction', transaction: { ...PROOF } }; },
      restore: async () => { calls.push(['restore']); return { transactions: [{ ...PROOF }], truncated: false }; },
      currentEntitlements: async () => { calls.push(['currentEntitlements']); return { transactions: [], truncated: false }; },
    },
    newIdempotencyKey: () => 'synthetic-promo-key',
    openManageSubscriptions: async () => { calls.push(['manage']); },
  };
  const controller = new MembershipController(ports);
  return { controller, ports, session, calls, switchAccount: () => { current = false; } };
}

test('signed-out controller does not call authenticated or native effects', async () => {
  const f = fixture();
  f.ports.captureSession = () => null;
  const controller = new MembershipController(f.ports);
  await controller.load();
  await controller.purchase(PRODUCT.id);
  await controller.restore();
  await controller.redeem('CODE');
  await controller.checkAgain();
  await controller.manageSubscriptions();
  assert.equal(controller.getState().status, 'unavailable');
  assert.equal(controller.getState().reason, 'authentication_required');
  assert.deepEqual(f.calls, []);
});

test('unconfigured purchases still read server entitlements and allow configured promo redemption', async () => {
  const f = fixture();
  f.ports.configuration = () => ({ purchases: 'unavailable', promos: true });
  await f.controller.load();
  assert.equal(f.controller.getState().status, 'unavailable');
  assert.equal(f.controller.getState().canRedeem, true);
  await f.controller.purchase(PRODUCT.id);
  await f.controller.restore();
  await f.controller.redeem('CODE');
  assert.deepEqual(f.calls.map(call => call[0]), ['read', 'redeem', 'read']);
  assert.equal(f.controller.getState().status, 'unavailable');
});

test('product display values come from native StoreKit and state snapshots cannot mutate them', async () => {
  const f = fixture();
  await f.controller.load();
  assert.equal(f.controller.getState().status, 'products');
  assert.deepEqual(f.controller.getState().products, [PRODUCT]);
  f.controller.getState().products[0].displayPrice = 'wrong';
  assert.equal(f.controller.getState().products[0].displayPrice, PRODUCT.displayPrice);
  await f.controller.purchase('not-returned-by-storekit');
  assert.equal(f.calls.filter(call => call[0] === 'purchase').length, 0);
});

test('local receipt and successful delivery alone never activate membership', async () => {
  const f = fixture();
  await f.controller.load();
  await f.controller.purchase(PRODUCT.id);
  assert.equal(f.controller.getState().status, 'products');
  assert.deepEqual(f.controller.getState().entitlements.active, []);
  assert.deepEqual(f.calls.map(call => call[0]), ['read', 'products', 'purchase', 'deliver', 'read']);
  assert.equal(f.calls[2][2], ACCOUNT.appAccountToken);
});

test('only authoritative server active list enables membership, including website grants', async () => {
  const f = fixture();
  f.session.readEntitlements = async () => ({ ...entitlement(), grants: [{ id: 'grant', entitlement: 'membership',
    source: 'website', grantedAt: 'synthetic', expiresAt: null, environment: 'synthetic', active: true }] });
  await f.controller.load();
  assert.equal(f.controller.getState().status, 'products');
  f.session.readEntitlements = async () => entitlement(['membership']);
  await f.controller.checkAgain();
  assert.equal(f.controller.getState().status, 'active');
  assert.equal(f.controller.getState().canPurchase, false);
  await f.controller.purchase(PRODUCT.id);
  assert.equal(f.calls.filter(call => call[0] === 'purchase').length, 0);
});

test('tap captures token synchronously, serializes purchase, and sends late receipt only to captured delivery', async () => {
  const f = fixture();
  const pending = deferred();
  f.ports.native.purchase = (product, token) => { f.calls.push(['purchase', product, token]); return pending.promise; };
  await f.controller.load();
  const operation = f.controller.purchase(PRODUCT.id);
  assert.deepEqual(f.calls.at(-1), ['purchase', PRODUCT.id, ACCOUNT.appAccountToken]);
  assert.equal(f.controller.getState().status, 'purchasing');
  await f.controller.purchase(PRODUCT.id);
  f.switchAccount();
  f.ports.captureSession = () => { throw new Error('new account must not be consulted'); };
  pending.resolve({ status: 'transaction', transaction: { ...PROOF } });
  await operation;
  assert.deepEqual(f.calls.map(call => call[0]), ['read', 'products', 'purchase', 'deliver']);
  assert.equal(f.calls.at(-1)[2].appAccountToken, ACCOUNT.appAccountToken);
  assert.equal(f.controller.getState().status, 'unavailable');
  assert.equal(f.controller.getState().entitlements, null);
  assert.deepEqual(f.controller.getState().products, []);
});

test('new account or auth generation cannot submit through an old controller', async () => {
  const f = fixture();
  await f.controller.load();
  f.ports.captureSession = () => ({ ...f.session, generation: 'replacement' });
  await f.controller.purchase(PRODUCT.id);
  await f.controller.redeem('CODE');
  assert.deepEqual(f.calls.map(call => call[0]), ['read', 'products']);
});

test('pending approval stays pending after an empty reconciliation and never replays purchase', async () => {
  const f = fixture();
  f.ports.native.purchase = async () => { f.calls.push(['purchase']); return { status: 'pending', productId: PRODUCT.id }; };
  await f.controller.load();
  await f.controller.purchase(PRODUCT.id);
  assert.equal(f.controller.getState().status, 'pending');
  await f.controller.purchase(PRODUCT.id);
  await f.controller.checkAgain();
  assert.equal(f.controller.getState().status, 'pending');
  assert.equal(f.calls.filter(call => call[0] === 'purchase').length, 1);
});

test('ambiguous purchase exception blocks new purchases and explicit reconciliation never buys again', async () => {
  const f = fixture();
  f.ports.native.purchase = async () => { f.calls.push(['purchase']); throw new Error('synthetic timeout'); };
  await f.controller.load();
  await f.controller.purchase(PRODUCT.id);
  await f.controller.load();
  await f.controller.purchase(PRODUCT.id);
  await f.controller.checkAgain();
  assert.equal(f.controller.getState().status, 'unknown');
  assert.equal(f.controller.getState().canPurchase, false);
  assert.equal(f.calls.filter(call => call[0] === 'purchase').length, 1);
});

test('unknown delivery retains receipt and exact idempotency key for explicit reconciliation', async () => {
  const f = fixture();
  let attempts = 0;
  f.session.deliver = async (request, proof) => {
    f.calls.push(['deliver', request, proof]);
    return ++attempts === 1 ? { status: 'unknown', code: 'synthetic_timeout' }
      : { status: 'finished', transactionId: proof.transactionId, serverDeliveryId: 'synthetic-delivery' };
  };
  await f.controller.load();
  await f.controller.purchase(PRODUCT.id);
  assert.equal(f.controller.getState().status, 'unknown');
  const retained = f.controller.getRecovery();
  assert.equal(retained.deliveries[0].request.idempotencyKey, 'storekit-delivery:100');
  retained.deliveries[0].proof.jwsRepresentation = 'mutated';
  await f.controller.checkAgain();
  const deliveries = f.calls.filter(call => call[0] === 'deliver');
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[0], deliveries[1]);
  assert.equal(f.controller.getRecovery().deliveries.length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'purchase').length, 1);
});

test('restore explicitly syncs, delivers every receipt, then reads authoritative entitlements', async () => {
  const f = fixture();
  f.ports.native.restore = async () => {
    f.calls.push(['restore']);
    return { transactions: [{ ...PROOF }, { ...PROOF, transactionId: '101' }], truncated: false };
  };
  await f.controller.restore();
  assert.deepEqual(f.calls.map(call => call[0]), ['restore', 'deliver', 'deliver', 'read']);
  assert.equal(f.controller.getState().status, 'restore-none');
  f.session.readEntitlements = async () => entitlement(['membership']);
  await f.controller.restore();
  assert.equal(f.controller.getState().status, 'active');
});

test('truncated restore and unfinished delivery preserve uncertainty', async () => {
  const f = fixture();
  f.ports.native.restore = async () => ({ transactions: [{ ...PROOF }], truncated: true });
  f.session.deliver = async () => ({ status: 'delivered_unfinished', transactionId: PROOF.transactionId,
    serverDeliveryId: 'synthetic-delivery', code: 'finish_unknown' });
  await f.controller.restore();
  assert.equal(f.controller.getState().status, 'unknown');
  assert.equal(f.controller.getRecovery().deliveries.length, 1);
});

test('restore retains a thrown delivery receipt and still delivers remaining transactions', async () => {
  const f = fixture();
  f.ports.native.restore = async () => ({ transactions: [{ ...PROOF }, { ...PROOF, transactionId: '101' }], truncated: false });
  f.session.deliver = async (request, proof) => {
    f.calls.push(['deliver', request, proof]);
    if (proof.transactionId === '100') throw new Error('synthetic delivery timeout');
    return { status: 'finished', transactionId: proof.transactionId, serverDeliveryId: 'synthetic-delivery' };
  };
  await f.controller.restore();
  assert.deepEqual(f.calls.map(call => call[0]), ['deliver', 'deliver', 'read']);
  assert.equal(f.controller.getState().status, 'unknown');
  assert.deepEqual(f.controller.getRecovery().deliveries.map(item => item.proof.transactionId), ['100']);
});

test('known purchase cancellation has no delivery effect and product-read failure is explicit', async () => {
  const f = fixture();
  f.ports.native.purchase = async () => ({ status: 'cancelled', productId: PRODUCT.id });
  await f.controller.load();
  await f.controller.purchase(PRODUCT.id);
  assert.equal(f.controller.getState().status, 'products');
  assert.equal(f.controller.getRecovery().purchase, null);
  assert.equal(f.calls.filter(call => call[0] === 'deliver').length, 0);
  f.ports.native.products = async () => { throw new Error('synthetic products failure'); };
  await f.controller.load();
  assert.equal(f.controller.getState().status, 'failed');
});

test('foreign account receipt is retained and never submitted under this account', async () => {
  const f = fixture();
  f.ports.native.restore = async () => ({ transactions: [{ ...PROOF,
    appAccountToken: '22222222-2222-4222-8222-222222222222' }], truncated: false });
  await f.controller.restore();
  assert.equal(f.controller.getState().status, 'unknown');
  assert.equal(f.calls.filter(call => call[0] === 'deliver').length, 0);
  assert.equal(f.controller.getRecovery().deliveries.length, 1);
});

test('known delivery rejection surfaces failure instead of granting access', async () => {
  const f = fixture();
  f.session.deliver = async () => ({ status: 'rejected', code: 'synthetic_rejection' });
  await f.controller.load();
  await f.controller.purchase(PRODUCT.id);
  assert.equal(f.controller.getState().status, 'failed');
  assert.equal(f.controller.getState().reason, 'synthetic_rejection');
});

test('promo ambiguity retains the exact payload and key; only explicit check retries it', async () => {
  const f = fixture();
  let attempts = 0;
  f.session.redeem = async (code, key) => {
    f.calls.push(['redeem', code, key]);
    if (++attempts === 1) throw new Error('synthetic timeout');
    return { charged: false };
  };
  await f.controller.load();
  await f.controller.redeem(' CODE ');
  assert.equal(f.controller.getState().status, 'unknown');
  await f.controller.redeem('DIFFERENT');
  await f.controller.checkAgain();
  assert.deepEqual(f.calls.filter(call => call[0] === 'redeem'), [
    ['redeem', 'CODE', 'synthetic-promo-key'], ['redeem', 'CODE', 'synthetic-promo-key'],
  ]);
  assert.equal(f.controller.getState().status, 'products');
});

test('mismatched and late server entitlement responses cannot activate another account', async () => {
  const f = fixture();
  f.session.readEntitlements = async () => ({ ...entitlement(['membership']), accountId: 'other' });
  await f.controller.load();
  assert.equal(f.controller.getState().status, 'failed');
  assert.equal(f.controller.getState().entitlements, null);
  const pending = deferred();
  f.session.readEntitlements = () => pending.promise;
  const operation = f.controller.load();
  f.switchAccount();
  pending.resolve(entitlement(['membership']));
  await operation;
  assert.equal(f.controller.getState().status, 'unavailable');
  assert.equal(f.controller.getState().entitlements, null);
});

test('manage subscriptions uses only the system-management port and does not cancel or grant', async () => {
  const f = fixture();
  await f.controller.manageSubscriptions();
  assert.deepEqual(f.calls, [['manage']]);
  assert.equal(f.controller.getState().entitlements, null);
});

test('dispose suppresses updates while preserving unknown late receipts for the original owner', async () => {
  const f = fixture();
  const pending = deferred();
  f.ports.native.purchase = () => pending.promise;
  f.session.deliver = async () => ({ status: 'unknown', code: 'auth_no_longer_available' });
  await f.controller.load();
  const operation = f.controller.purchase(PRODUCT.id);
  let notifications = 0;
  f.controller.subscribe(() => { notifications++; });
  f.controller.dispose();
  pending.resolve({ status: 'transaction', transaction: { ...PROOF } });
  await operation;
  assert.equal(notifications, 0);
  assert.equal(f.controller.getState().reason, 'disposed');
  assert.equal(f.controller.getRecovery().deliveries[0].proof.jwsRepresentation, PROOF.jwsRepresentation);
});
