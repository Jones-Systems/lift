const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StoreKitDeliveryCoordinator } = require('../storeKitDelivery.ts');

const account = { accountId: 'synthetic-form-account', appAccountToken: '11111111-1111-4111-8111-111111111111' };
const proof = {
  transactionId: '18446744073709551615', originalTransactionId: '18446744073709551614', productId: 'synthetic.product',
  productType: 'auto-renewable', appAccountToken: account.appAccountToken, purchaseDateMs: 1,
  expirationDateMs: null, revocationDateMs: null, localVerification: 'verified', productAllowed: true,
  jwsRepresentation: 'synthetic-proof-not-an-apple-signature', source: 'purchase',
};
const ack = { status: 'delivered', accountId: account.accountId, transactionId: proof.transactionId, productId: proof.productId, serverDeliveryId: 'synthetic-receipt' };

function seam(overrides = {}) {
  const calls = [];
  let active = account;
  const delivery = {
    currentAccount: async () => active,
    verifyAndDeliver: async (request, binding) => { calls.push(['server', request, binding]); return { ...ack }; },
    ...overrides,
  };
  const native = {
    acknowledgeServerDelivery: async (id, jws, receipt) => {
      calls.push(['finish', id, jws, receipt]);
      return { finished: true, transactionId: id, serverDeliveryId: receipt };
    },
  };
  return { calls, delivery, native, setAccount: value => { active = value; },
    coordinator: new StoreKitDeliveryCoordinator(native, delivery, [proof.productId]) };
}

test('forwards the exact signed proof; finishes only after a matching delivery acknowledgment', async () => {
  const s = seam();
  const result = await s.coordinator.deliver(proof);
  assert.equal(result.status, 'finished');
  assert.deepEqual(s.calls.map(call => call[0]), ['server', 'finish']);
  assert.equal(s.calls[0][1].transactionId, '18446744073709551615');
  assert.equal(s.calls[0][1].jwsRepresentation, proof.jwsRepresentation);
  assert.deepEqual(s.calls[1].slice(1), [proof.transactionId, proof.jwsRepresentation, ack.serverDeliveryId]);
});

test('unverified proof reaches server as evidence and remains unfinished even after delivery', async () => {
  const s = seam();
  const result = await s.coordinator.deliver({ ...proof, localVerification: 'unverified' });
  assert.equal(result.status, 'delivered_unfinished');
  assert.equal(result.code, 'local_unverified');
  assert.deepEqual(s.calls.map(call => call[0]), ['server']);
});

test('wrong server account, product or transaction acknowledgment never finishes', async () => {
  for (const change of [{ accountId: 'other' }, { productId: 'other' }, { transactionId: '1' }, { serverDeliveryId: '' }]) {
    const s = seam({ verifyAndDeliver: async () => ({ ...ack, ...change }) });
    assert.deepEqual(await s.coordinator.deliver(proof), { status: 'unknown', code: 'server_ack_mismatch' });
    assert.equal(s.calls.length, 0);
  }
});

test('cross-account token and disallowed product are rejected before a server call', async () => {
  const s = seam();
  assert.equal((await s.coordinator.deliver({ ...proof, appAccountToken: '22222222-2222-4222-8222-222222222222' })).code, 'account_token_mismatch');
  assert.equal((await s.coordinator.deliver({ ...proof, productId: 'other' })).code, 'product_not_allowed');
  assert.equal(s.calls.length, 0);
});

test('logout during delivery keeps a delivered transaction unfinished', async () => {
  const s = seam();
  s.delivery.verifyAndDeliver = async () => { s.setAccount(null); return ack; };
  const result = await s.coordinator.deliver(proof);
  assert.equal(result.code, 'account_changed');
  assert.equal(s.calls.length, 0);
});

test('server timeout is unknown and never triggers a retry or finish', async () => {
  let sends = 0;
  const s = seam({ verifyAndDeliver: async () => { sends++; throw new Error('synthetic timeout'); } });
  assert.deepEqual(await s.coordinator.deliver(proof), { status: 'unknown', code: 'server_effect_unknown' });
  assert.equal(sends, 1);
  assert.equal(s.calls.length, 0);
});

test('concurrent duplicate proofs share one delivery; changing proof is unresolved', async () => {
  let release;
  let sends = 0;
  const ready = new Promise(resolve => { release = resolve; });
  const s = seam({ verifyAndDeliver: async () => { sends++; await ready; return ack; } });
  const first = s.coordinator.deliver(proof);
  const second = s.coordinator.deliver({ ...proof });
  assert.equal(first, second);
  assert.equal((await s.coordinator.deliver({ ...proof, jwsRepresentation: 'different' })).code, 'transaction_changed_during_delivery');
  release();
  await first;
  assert.equal(sends, 1);
  assert.equal(s.calls.filter(call => call[0] === 'finish').length, 1);
});

test('native finish rejection preserves known delivery and unknown finishing', async () => {
  const s = seam();
  s.native.acknowledgeServerDelivery = async () => { throw new Error('synthetic bridge loss'); };
  const result = await s.coordinator.deliver(proof);
  assert.equal(result.status, 'delivered_unfinished');
  assert.equal(result.serverDeliveryId, ack.serverDeliveryId);
  assert.equal(result.code, 'finish_unknown');
});
