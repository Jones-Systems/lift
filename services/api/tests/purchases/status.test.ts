import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { JWSRenewalInfoDecodedPayload, StatusResponse } from '@apple/app-store-server-library';
import { AppleSubscriptionStatusReader, createAppleStatusTransport, applePurchaseMigrationSql } from '../../src/purchases/index.js';
import { createAppleSandboxReconciliationVerifier, pinnedAppleRoots } from '../../src/purchases/apple-verifier.js';
import { ApplePurchaseService } from '../../src/purchases/service.js';
import { AppleProofError, type AppleSandboxConfiguration, type VerifiedAppleTransaction } from '../../src/purchases/types.js';
import type { AppleReconciliationVerifier, AppleSubscriptionStatusPorts, PurchaseOwner } from '../../src/purchases/reconciliation.types.js';

const accountA = '11111111-1111-4111-8111-111111111111';
const accountB = '22222222-2222-4222-8222-222222222222';
const now = 1_790_000_000_000;
const appAppleId = 123456789;
const config: AppleSandboxConfiguration = { bundleId: 'com.form.test', products: [
  { productId: 'form.plus.month', type: 'Auto-Renewable Subscription', entitlement: 'form_plus' },
] };
const owner: PurchaseOwner = Object.freeze({ accountId: accountA, appAccountToken: accountA, originalTransactionId: '10000',
  bundleId: config.bundleId, environment: 'Sandbox' });
type Transaction = VerifiedAppleTransaction & { subscriptionGroupIdentifier: string };
function proof(overrides: Partial<Transaction> = {}): Transaction {
  return { transactionId: '10001', originalTransactionId: '10000', bundleId: config.bundleId, environment: 'Sandbox',
    productId: 'form.plus.month', type: 'Auto-Renewable Subscription', appAccountToken: accountA, inAppOwnershipType: 'PURCHASED',
    purchaseDate: now - 1000, signedDate: now, quantity: 1, expiresDate: now + 60_000, subscriptionGroupIdentifier: '100', ...overrides };
}
function renewal(overrides: Record<string, unknown> = {}) {
  return { originalTransactionId: '10000', productId: 'form.plus.month', appAccountToken: accountA,
    environment: 'Sandbox', signedDate: now, autoRenewStatus: 1, ...overrides };
}
function group(items: unknown[], subscriptionGroupIdentifier = '100') { return { subscriptionGroupIdentifier, lastTransactions: items }; }
function envelope(data: unknown[] = []) { return { bundleId: config.bundleId, environment: 'Sandbox', appAppleId, data }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Registered synthetic claims follow the existing verifier seam; none is an Apple-positive signature fixture. */
function fixture() {
  const transactions = new Map<string, unknown>(); const renewals = new Map<string, unknown>();
  const owners = new Map<string, PurchaseOwner>([[owner.originalTransactionId, owner]]);
  const calls = { transport: [] as string[], transaction: [] as string[], renewal: [] as string[] };
  const register = (map: Map<string, unknown>, value: unknown) => {
    const jws = `synthetic.${Buffer.from(randomUUID()).toString('base64url')}.signature`;
    map.set(jws, value); return jws;
  };
  const lookup = (map: Map<string, unknown>, signed: string): unknown => {
    if (!map.has(signed)) throw new AppleProofError('apple_signature_invalid');
    const value = map.get(signed);
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  let beforeRenewal: () => void = () => {};
  const verifier: Pick<AppleReconciliationVerifier, 'verify' | 'renewal'> = {
    async verify(signed) { calls.transaction.push(signed); return lookup(transactions, signed) as VerifiedAppleTransaction; },
    async renewal(signed) { calls.renewal.push(signed); beforeRenewal(); return lookup(renewals, signed) as JWSRenewalInfoDecodedPayload; },
  };
  const transaction = (value: unknown = proof()) => register(transactions, value);
  const signedRenewal = (value: unknown = renewal()) => register(renewals, value);
  const item = (status: unknown = 1, tx: unknown = proof(), rn: unknown = renewal(), originalTransactionId = '10000') =>
    ({ status, originalTransactionId, signedTransactionInfo: transaction(tx), signedRenewalInfo: signedRenewal(rn) });
  let response: unknown = envelope([group([item()])]);
  let fetch: (id: string) => Promise<unknown> = async () => structuredClone(response);
  const ports: AppleSubscriptionStatusPorts = { appAppleId, verifier,
    owners: { read: id => { const value = owners.get(id); return value ? { ...value } : null; } },
    transport: { statuses: id => { calls.transport.push(id); return fetch(id); } } };
  return { owners, calls, ports, verifier, item, transaction, signedRenewal, reader: new AppleSubscriptionStatusReader(config, ports),
    setResponse: (value: unknown) => { response = value; }, setFetch: (value: typeof fetch) => { fetch = value; },
    beforeRenewal: (value: () => void) => { beforeRenewal = value; } };
}
function rejected(result: Awaited<ReturnType<AppleSubscriptionStatusReader['read']>>, reason: string) {
  assert.deepEqual(result, { status: 'rejected', observations: [], reason });
}

test('SDK transport passes only the original transaction ID and never filters out inactive statuses', async () => {
  const calls: unknown[][] = [];
  const transport = createAppleStatusTransport({ getAllSubscriptionStatuses: async (...args) => {
    calls.push(args); return envelope() as StatusResponse;
  } });
  await transport.statuses(owner.originalTransactionId);
  assert.deepEqual(calls, [[owner.originalTransactionId]]);
});

test('known statuses produce immutable evidence with verified renewal deadlines and no access decision', async () => {
  const f = fixture();
  for (const [code, expected] of [[1, 'active'], [2, 'expired'], [3, 'billing_retry'], [4, 'billing_grace_period'], [5, 'revoked']] as const) {
    f.setResponse(envelope([group([f.item(code, proof(), renewal({ gracePeriodExpiresDate: now + 5000, isInBillingRetryPeriod: true }))])]));
    const result = await f.reader.read(owner);
    assert.equal(result.status, 'observed'); assert.equal(result.reason, null); assert.equal(result.observations.length, 1);
    const observation = result.observations[0]!;
    assert.equal(observation.status, expected); assert.deepEqual(observation.owner, owner);
    assert.deepEqual(observation.transaction, { transactionId: '10001', productId: 'form.plus.month', purchaseDate: now - 1000,
      signedDate: now, expiresDate: now + 60_000, revocationDate: null, isUpgraded: false });
    assert.deepEqual(observation.renewal, { productId: 'form.plus.month', autoRenewProductId: null, signedDate: now,
      autoRenewStatus: 1, gracePeriodExpiresDate: now + 5000, isInBillingRetryPeriod: true });
    for (const object of [result, result.observations, observation, observation.owner, observation.transaction, observation.renewal])
      assert.ok(Object.isFrozen(object));
    assert.equal('active' in result, false); assert.equal('signedTransactionInfo' in observation, false);
  }
  assert.deepEqual(f.calls.transport, Array(5).fill(owner.originalTransactionId));
  assert.equal(f.calls.transaction.length, 5); assert.equal(f.calls.renewal.length, 5);
});

test('all groups are verified against their own immutable bindings; foreign and other own lineages never escape', async () => {
  const f = fixture();
  const foreign: PurchaseOwner = { ...owner, accountId: accountB, appAccountToken: accountB, originalTransactionId: '90000' };
  const otherOwn: PurchaseOwner = { ...owner, originalTransactionId: '30000' };
  f.owners.set('90000', foreign); f.owners.set('30000', otherOwn);
  const foreignItem = f.item(1, proof({ originalTransactionId: '90000', transactionId: '90001', appAccountToken: accountB,
    subscriptionGroupIdentifier: '200' }), renewal({ originalTransactionId: '90000', appAccountToken: accountB }), '90000');
  const otherOwnItem = f.item(1, proof({ originalTransactionId: '30000', transactionId: '30001', subscriptionGroupIdentifier: '300' }),
    renewal({ originalTransactionId: '30000' }), '30000');
  f.setResponse(envelope([group([f.item()]), group([foreignItem], '200'), group([otherOwnItem], '300')]));
  const result = await f.reader.read(owner);
  assert.equal(result.status, 'observed'); assert.equal(result.observations.length, 1);
  assert.deepEqual(result.observations[0]!.owner, owner);
  for (const foreignValue of [accountB, '90000', '90001', '30000', '30001', foreignItem.signedTransactionInfo])
    assert.equal(JSON.stringify(result).includes(JSON.stringify(foreignValue)), false);
  assert.equal(f.calls.transaction.length, 3); assert.equal(f.calls.renewal.length, 3);
  f.setResponse(envelope([group([foreignItem], '200')]));
  assert.deepEqual(await f.reader.read(owner), { status: 'pending', observations: [], reason: 'apple_status_owner_absent' });
  f.owners.delete('90000');
  rejected(await f.reader.read(owner), 'apple_status_owner_unresolved');
});

test('a foreign item cannot be reassigned to the caller or hide a failed nested signature behind filtering', async () => {
  const f = fixture();
  f.owners.set('90000', { ...owner, accountId: accountB, appAccountToken: accountB, originalTransactionId: '90000' });
  const foreignProof = proof({ originalTransactionId: '90000', transactionId: '90001', subscriptionGroupIdentifier: '200' });
  f.setResponse(envelope([group([f.item()]), group([f.item(1, foreignProof, renewal({ originalTransactionId: '90000' }), '90000')], '200')]));
  rejected(await f.reader.read(owner), 'apple_status_owner_mismatch');
  const boundProof = { ...foreignProof, appAccountToken: accountB };
  f.setResponse(envelope([group([f.item()]), group([f.item(1, boundProof, new AppleProofError('apple_signature_invalid'), '90000')], '200')]));
  rejected(await f.reader.read(owner), 'apple_signature_invalid');
});

test('outer application and environment must match explicit configuration exactly', async () => {
  const f = fixture();
  for (const change of [{ bundleId: 'com.other.app' }, { appAppleId: appAppleId + 1 }, { appAppleId: String(appAppleId) }]) {
    f.setResponse({ ...envelope([group([f.item()])]), ...change });
    rejected(await f.reader.read(owner), 'apple_status_application_mismatch');
  }
  for (const environment of ['Production', 'Xcode', 'sandbox', null]) {
    f.setResponse({ ...envelope([group([f.item()])]), environment });
    rejected(await f.reader.read(owner), 'apple_status_environment_mismatch');
  }
  assert.equal(f.calls.transaction.length, 0);
  assert.throws(() => new AppleSubscriptionStatusReader(config, { ...f.ports, appAppleId: 0 }), /app ID/);
  assert.throws(() => new AppleSubscriptionStatusReader({ ...config, environment: 'Production' as 'Sandbox' }, f.ports));
});

test('nested transaction application, environment, token, lineage, group and family ownership fail closed', async () => {
  const f = fixture();
  const cases: [Partial<Transaction>, string][] = [
    [{ bundleId: 'com.other.app' }, 'apple_status_application_mismatch'],
    [{ environment: 'Production' }, 'apple_status_environment_mismatch'],
    [{ appAccountToken: accountB }, 'apple_status_owner_mismatch'],
    [{ originalTransactionId: '90000' }, 'apple_status_owner_mismatch'],
    [{ subscriptionGroupIdentifier: '999' }, 'apple_status_owner_mismatch'],
    [{ inAppOwnershipType: 'FAMILY_SHARED' }, 'apple_status_family_policy_unavailable'],
    [{ inAppOwnershipType: 'UNKNOWN' }, 'apple_status_ownership_invalid'],
    [{ productId: 'unconfigured' }, 'apple_status_product_unavailable'],
  ];
  for (const [change, reason] of cases) {
    f.setResponse(envelope([group([f.item(1, proof(change))])])); rejected(await f.reader.read(owner), reason);
  }
  rejected(await f.reader.read({ ...owner, accountId: accountB, appAccountToken: accountB }), 'apple_status_owner_mismatch');
  rejected(await f.reader.read({ ...owner, appAccountToken: accountB }), 'apple_status_owner_invalid');
});

test('renewal evidence must correlate with the verified transaction and installed token, not the outer caller', async () => {
  const f = fixture();
  for (const change of [{ originalTransactionId: '90000' }, { appAccountToken: accountB }, { productId: 'other.product' }]) {
    f.setResponse(envelope([group([f.item(1, proof(), renewal(change))])]));
    rejected(await f.reader.read(owner), 'apple_status_renewal_binding_mismatch');
  }
  f.setResponse(envelope([group([f.item(1, proof(), renewal({ environment: 'Production' }))])]));
  rejected(await f.reader.read(owner), 'apple_status_environment_mismatch');
});

test('malformed decoded payloads and oversized signed or decoded payloads yield no partial observations', async () => {
  const f = fixture();
  for (const tx of [null, { ...proof(), expiresDate: 'tomorrow' }, { ...proof(), quantity: 2 }, { ...proof(), signedDate: -1 },
    { ...proof(), extra: 'x'.repeat(60_001) }]) {
    f.setResponse(envelope([group([f.item(1, tx)])])); rejected(await f.reader.read(owner), 'apple_status_transaction_invalid');
  }
  for (const rn of [null, renewal({ autoRenewStatus: 2 }), renewal({ signedDate: 'today' }), renewal({ gracePeriodExpiresDate: -1 }),
    renewal({ isInBillingRetryPeriod: 'yes' }), renewal({ extra: 'x'.repeat(60_001) })]) {
    f.setResponse(envelope([group([f.item(1, proof(), rn)])])); rejected(await f.reader.read(owner), 'apple_status_renewal_invalid');
  }
  for (const field of ['signedTransactionInfo', 'signedRenewalInfo']) {
    for (const signed of ['', 'unsigned', 'a.b.c.d', 'a.b.c=', `${'a'.repeat(60_000)}.b.c`]) {
      f.setResponse(envelope([group([{ ...f.item(), [field]: signed }])]));
      rejected(await f.reader.read(owner), 'apple_status_signed_payload_invalid');
    }
  }
});

test('unknown status enum, malformed response, duplicate lineage and bounded cardinality fail before verification', async () => {
  const f = fixture();
  for (const code of [0, 6, -1, 1.5, '1', null]) {
    f.setResponse(envelope([group([f.item(code)])])); rejected(await f.reader.read(owner), 'apple_status_unknown');
  }
  for (const response of [null, [], {}, { ...envelope(), unexpected: true }, { ...envelope(), data: {} },
    envelope([group([f.item(), f.item()])]), envelope([group([]), group([])]), envelope([group(Array(21).fill(f.item()))]),
    envelope(Array.from({ length: 21 }, (_, index) => group([], String(index + 1)))),
    envelope(Array.from({ length: 6 }, (_, g) => group(Array.from({ length: 20 }, (_, i) =>
      ({ ...f.item(), originalTransactionId: String(1 + g * 20 + i) })), String(g + 1))))]) {
    f.setResponse(response); rejected(await f.reader.read(owner), 'apple_status_response_invalid');
  }
  const largeSigned = `${'a'.repeat(59_996)}.b.c`;
  f.setResponse(envelope([group(Array.from({ length: 9 }, (_, index) => ({ ...f.item(), originalTransactionId: String(index + 1),
    signedTransactionInfo: largeSigned, signedRenewalInfo: largeSigned })))]));
  rejected(await f.reader.read(owner), 'apple_status_response_invalid');
  assert.equal(f.calls.transaction.length, 0); assert.equal(f.calls.renewal.length, 0);
});

test('empty data is pending evidence, never proof of expiry or an entitlement decision', async () => {
  const f = fixture();
  for (const response of [envelope(), envelope([group([])])]) {
    f.setResponse(response);
    assert.deepEqual(await f.reader.read(owner), { status: 'pending', observations: [], reason: 'apple_status_empty' });
  }
  const { transport: _transport, ...withoutTransport } = f.ports;
  assert.deepEqual(await new AppleSubscriptionStatusReader(config, withoutTransport).read(owner),
    { status: 'unavailable', observations: [], reason: 'apple_status_transport_unconfigured' });
});

test('response snapshots reject cycles, accessors and excessive depth without executing provider getters', async () => {
  const f = fixture();
  const cyclic: Record<string, unknown> = envelope(); cyclic.data = cyclic;
  f.setFetch(async () => cyclic);
  rejected(await f.reader.read(owner), 'apple_status_response_invalid');
  let getterCalls = 0;
  const accessor = Object.defineProperty(envelope(), 'data', { enumerable: true, get: () => { getterCalls++; return []; } });
  f.setFetch(async () => accessor);
  rejected(await f.reader.read(owner), 'apple_status_response_invalid');
  assert.equal(getterCalls, 0);
  let nested: unknown = 'leaf';
  for (let index = 0; index < 14; index++) nested = { child: nested };
  f.setFetch(async () => envelope([group([f.item(1, { ...proof(), extra: nested })])]));
  rejected(await f.reader.read(owner), 'apple_status_transaction_invalid');
});

test('the same transaction ID cannot be observed under two different installed lineages', async () => {
  const f = fixture();
  f.owners.set('30000', { ...owner, originalTransactionId: '30000' });
  f.setResponse(envelope([group([f.item()]), group([f.item(1,
    proof({ originalTransactionId: '30000', subscriptionGroupIdentifier: '300' }), renewal({ originalTransactionId: '30000' }), '30000')], '300')]));
  rejected(await f.reader.read(owner), 'apple_status_transaction_conflict');
});

test('transport failure, timeout and lost response remain unknown without retry or raw error disclosure', async () => {
  const f = fixture();
  for (const error of [new Error('sensitive-provider-detail'), Object.assign(new Error('sensitive-provider-detail'), { name: 'TimeoutError' })]) {
    f.setFetch(async () => { throw error; });
    const result = await f.reader.read(owner);
    assert.deepEqual(result, { status: 'unknown', observations: [], reason: error.name === 'TimeoutError'
      ? 'apple_status_transport_timeout' : 'apple_status_transport_unknown' });
  }
  assert.equal(f.calls.transport.length, 2); assert.equal(f.calls.transaction.length, 0);
});

test('a nonresponding transport has a fixed deadline; late success is discarded without verification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const response = deferred<unknown>();
  f.setFetch(() => response.promise);
  const pending = f.reader.read(owner);
  t.mock.timers.tick(10_000);
  assert.deepEqual(await pending, { status: 'unknown', observations: [], reason: 'apple_status_transport_timeout' });
  response.resolve(envelope([group([f.item()])]));
  await Promise.resolve();
  assert.equal(f.calls.transport.length, 1); assert.equal(f.calls.transaction.length, 0);
});

test('verifier invalid signatures and uncertain outcomes cannot return earlier partial evidence', async () => {
  const f = fixture();
  for (const field of ['transaction', 'renewal']) {
    for (const uncertain of [false, true]) {
      const error = new AppleProofError(uncertain ? 'apple_verification_unavailable' : 'apple_signature_invalid', uncertain);
      f.setResponse(envelope([group([f.item(1, field === 'transaction' ? error : proof(), field === 'renewal' ? error : renewal())])]));
      assert.deepEqual(await f.reader.read(owner), { status: uncertain ? 'unknown' : 'rejected', observations: [], reason: error.code });
    }
  }
  f.setResponse(envelope([group([f.item(1, new Error('untrusted-payload-detail'))])]));
  assert.deepEqual(await f.reader.read(owner), { status: 'unknown', observations: [], reason: 'apple_status_read_unknown' });
});

test('the real offline Apple verifier rejects unverified and certificate-bearing invalid signatures in both slots', async () => {
  const f = fixture(); const official = createAppleSandboxReconciliationVerifier(config);
  const reader = new AppleSubscriptionStatusReader(config, { ...f.ports, verifier: official });
  const invalid = (payload: unknown) => `${Buffer.from(JSON.stringify({ alg: 'ES256', x5c: pinnedAppleRoots().map(root => root.toString('base64')) }))
    .toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${Buffer.alloc(64).toString('base64url')}`;
  for (const signed of ['unsigned.payload.signature', invalid(proof())]) {
    f.setResponse(envelope([group([{ ...f.item(), signedTransactionInfo: signed }])]));
    assert.equal((await reader.read(owner)).status, 'rejected');
  }
  // Registered transaction claims isolate the real renewal verifier's negative path; this is no positive Apple witness.
  const renewalReader = new AppleSubscriptionStatusReader(config, { ...f.ports,
    verifier: { verify: signed => f.verifier.verify(signed), renewal: signed => official.renewal(signed) } });
  for (const signed of ['unsigned.payload.signature', invalid(renewal())]) {
    f.setResponse(envelope([group([{ ...f.item(), signedRenewalInfo: signed }])]));
    assert.equal((await renewalReader.read(owner)).status, 'rejected');
  }
});

test('owner capture survives caller mutation and rejects installed reassignment across fetch and verification awaits', async () => {
  const f = fixture(); const response = deferred<unknown>(); const mutable = { ...owner };
  f.setFetch(() => response.promise);
  const pending = f.reader.read(mutable);
  mutable.accountId = accountB; mutable.appAccountToken = accountB;
  response.resolve(envelope([group([f.item()])]));
  assert.deepEqual((await pending).observations[0]!.owner, owner);
  const changed = { ...owner, accountId: accountB, appAccountToken: accountB };
  f.setFetch(async () => { f.owners.set(owner.originalTransactionId, changed); return envelope([group([f.item()])]); });
  rejected(await f.reader.read(owner), 'apple_status_owner_changed');
  f.owners.set(owner.originalTransactionId, owner);
  f.setFetch(async () => envelope([group([f.item()])]));
  f.beforeRenewal(() => { f.owners.set(owner.originalTransactionId, changed); });
  rejected(await f.reader.read(owner), 'apple_status_owner_changed');
});

test('reading valid, grace, revoked and rejected evidence makes zero writes to a seeded real purchase ledger', async t => {
  const f = fixture(); const db = new Database(':memory:'); t.after(() => db.close());
  db.pragma('foreign_keys = ON'); db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO form_accounts VALUES (?)').run(accountA); db.exec(applePurchaseMigrationSql);
  const ledger = new ApplePurchaseService(db, config, f.verifier, () => now);
  const initial = f.transaction();
  assert.equal((await ledger.deliver(accountA, { transactionId: '10001', productId: 'form.plus.month',
    jwsRepresentation: initial, idempotencyKey: 'initial' })).status, 'delivered');
  const before = db.serialize(); const changes = db.prepare('SELECT total_changes() AS n').get();
  const reader = new AppleSubscriptionStatusReader(config, { ...f.ports, owners: { read: original => {
    const row = db.prepare(`SELECT o.account_id AS accountId, t.app_account_token AS appAccountToken,
      o.original_transaction_id AS originalTransactionId, o.bundle_id AS bundleId, o.environment AS environment
      FROM apple_purchase_owners o JOIN apple_purchase_transactions t ON t.original_transaction_id=o.original_transaction_id
      AND t.account_id=o.account_id WHERE o.original_transaction_id=? LIMIT 1`).get(original);
    return row ? row as PurchaseOwner : null;
  } } });
  for (const code of [1, 4, 5]) {
    f.setResponse(envelope([group([f.item(code, proof({ revocationDate: now }), renewal({ gracePeriodExpiresDate: now + 5000 }))])]));
    assert.equal((await reader.read(owner)).status, 'observed');
  }
  f.setResponse(envelope([group([f.item(1, proof({ appAccountToken: accountB }))])]));
  rejected(await reader.read(owner), 'apple_status_owner_mismatch');
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), changes);
  assert.deepEqual(db.serialize(), before);
  assert.deepEqual(ledger.entitlements(accountA).active, ['form_plus']);
});
