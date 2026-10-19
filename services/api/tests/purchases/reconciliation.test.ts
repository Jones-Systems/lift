import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { GetTransactionHistoryVersion, type HistoryResponse, type JWSRenewalInfoDecodedPayload,
  type ResponseBodyV2DecodedPayload } from '@apple/app-store-server-library';
import { DomainError } from '../../src/errors.js';
import type { AccountContext } from '../../src/lifecycle/types.js';
import { ApplePurchaseService } from '../../src/purchases/service.js';
import { ApplePurchaseReconciliation } from '../../src/purchases/reconciliation.js';
import { createAppleSandboxReconciliationVerifier } from '../../src/purchases/apple-verifier.js';
import { createAppleHistoryReader } from '../../src/purchases/history-adapter.js';
import { applePurchaseMigrationSql, applePurchaseReconciliationMigrationSql,
  createAppleSandboxReconciliation } from '../../src/purchases/index.js';
import { AppleProofError, type AppleSandboxConfiguration, type VerifiedAppleTransaction } from '../../src/purchases/types.js';
import type { AppleReconciliationVerifier, PurchaseOwner, PurchaseOwnerWriter, PurchaseBackgroundWriter } from '../../src/purchases/reconciliation.types.js';

const accountA = '11111111-1111-4111-8111-111111111111';
const accountB = '22222222-2222-4222-8222-222222222222';
const now = 1_790_000_000_000;
const config: AppleSandboxConfiguration = { bundleId: 'com.form.test', products: [
  { productId: 'form.plus.month', type: 'Auto-Renewable Subscription', entitlement: 'form_plus' },
] };
const owner: PurchaseOwner = { accountId: accountA, appAccountToken: accountA, originalTransactionId: '10000',
  bundleId: config.bundleId, environment: 'Sandbox' };
const actor: AccountContext = { accountId: accountA, authUserId: 'auth-a', sessionId: 'session-a', epoch: 1 };
function proof(overrides: Partial<VerifiedAppleTransaction> = {}): VerifiedAppleTransaction {
  return { transactionId: '10001', originalTransactionId: '10000', bundleId: config.bundleId, environment: 'Sandbox',
    productId: 'form.plus.month', type: 'Auto-Renewable Subscription', appAccountToken: accountA,
    inAppOwnershipType: 'PURCHASED', purchaseDate: now - 1000, signedDate: now, quantity: 1, expiresDate: now + 60_000, ...overrides };
}
function page(signedTransactions: string[], revision = 'revision-1', hasMore = false): HistoryResponse {
  return { bundleId: config.bundleId, environment: 'Sandbox', signedTransactions, revision, hasMore };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function fixture(t: TestContext) {
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  db.pragma('foreign_keys=ON'); db.pragma('synchronous=FULL');
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO form_accounts VALUES (?)').run(accountA);
  db.prepare('INSERT INTO form_accounts VALUES (?)').run(accountB);
  db.exec(applePurchaseMigrationSql);
  db.exec(applePurchaseReconciliationMigrationSql);
  // Synthetic claims are deliberately not Apple-valid signed fixtures. No network or disk scratch is used.
  const transactions = new Map<string, VerifiedAppleTransaction | Error>();
  const notifications = new Map<string, ResponseBodyV2DecodedPayload>();
  const renewals = new Map<string, JWSRenewalInfoDecodedPayload>();
  const counters = { notification: 0, renewal: 0, transaction: 0, history: 0 };
  let beforeTransaction: (() => Promise<void>) | undefined;
  const verifier: AppleReconciliationVerifier = {
    async verify(jws) {
      counters.transaction++;
      if (beforeTransaction) await beforeTransaction();
      const value = transactions.get(jws);
      if (!value) throw new AppleProofError('apple_signature_invalid');
      if (value instanceof Error) throw value;
      return { ...value };
    },
    async notification(jws) {
      counters.notification++;
      const value = notifications.get(jws);
      if (!value) throw new AppleProofError('apple_signature_invalid');
      return structuredClone(value);
    },
    async renewal(jws) {
      counters.renewal++;
      const value = renewals.get(jws);
      if (!value) throw new AppleProofError('apple_signature_invalid');
      return { ...value };
    },
  };
  const opaque = () => `synthetic.${Buffer.from(randomUUID()).toString('base64url')}.signature`;
  const transaction = (value: VerifiedAppleTransaction | Error = proof()) => {
    const jws = opaque(); transactions.set(jws, value); return jws;
  };
  const renewal = (overrides: Partial<JWSRenewalInfoDecodedPayload> = {}) => {
    const jws = opaque(); renewals.set(jws, { originalTransactionId: '10000', appAccountToken: accountA,
      productId: 'form.plus.month', environment: 'Sandbox', signedDate: now, ...overrides }); return jws;
  };
  const notification = (transactionJws?: string, renewalJws?: string, overrides: Partial<ResponseBodyV2DecodedPayload> = {}) => {
    const jws = opaque();
    notifications.set(jws, { notificationUUID: randomUUID(), version: '2.0', notificationType: 'DID_RENEW', signedDate: now,
      data: { bundleId: config.bundleId, environment: 'Sandbox',
        ...(transactionJws === undefined ? {} : { signedTransactionInfo: transactionJws }),
        ...(renewalJws === undefined ? {} : { signedRenewalInfo: renewalJws }) }, ...overrides });
    return jws;
  };
  let current: AccountContext = { ...actor };
  let disabled = false;
  let inFrame = false;
  const assertActive = (candidate: AccountContext) => {
    if (disabled || JSON.stringify(candidate) !== JSON.stringify(current)) throw new DomainError(401, 'account_session_invalid');
  };
  const writer: PurchaseOwnerWriter = {
    lifecycle: { assertActive, withActiveWrite: (candidate, effect) => db.transaction(() => {
      assertActive(candidate); inFrame = true;
      try { const value = effect(); assertActive(candidate); return value; }
      finally { inFrame = false; }
    }).immediate() },
    assertWithinWrite: candidate => { assertActive(candidate); assert.ok(inFrame && db.inTransaction); },
    lifecycleStoreOptions: { assertRootWriter: candidate => { assert.equal(candidate, db); assert.ok(inFrame && db.inTransaction); } },
  };
  const background: PurchaseBackgroundWriter = { capture: bound => {
    const admittedEpoch = current.epoch;
    const assertCurrent = () => {
      if (disabled || bound.accountId !== current.accountId || admittedEpoch !== current.epoch)
        throw new DomainError(403, 'account_disabled');
    };
    return { assertCurrent, withWrite: effect => db.transaction(() => {
      assertCurrent(); inFrame = true;
      try { const value = effect(); assertCurrent(); return value; } finally { inFrame = false; }
    }).immediate(), assertWithinWrite: candidate => { assert.equal(candidate, db); assert.ok(inFrame && db.inTransaction); assertCurrent(); } };
  } };
  let fetch: (id: string, revision: string | null) => Promise<HistoryResponse> = async () => page([]);
  const history = { page: (id: string, revision: string | null) => { counters.history++; return fetch(id, revision); } };
  const ledger = new ApplePurchaseService(db, config, verifier, () => now);
  const initial = transaction();
  assert.equal((await ledger.deliver(accountA, { transactionId: '10001', productId: 'form.plus.month',
    jwsRepresentation: initial, idempotencyKey: 'initial' })).status, 'delivered');
  const build = (withBackground = true) => new ApplePurchaseReconciliation(db, config, verifier,
    { ownerWriter: writer, history, ...(withBackground ? { backgroundWriter: background } : {}) }, () => now);
  return { db, verifier, writer, background, ledger, transaction, renewal, notification, notifications, counters, build,
    service: build(), setFetch: (value: typeof fetch) => { fetch = value; },
    replaceActor: (value: AccountContext) => { current = { ...value }; }, disable: () => { disabled = true; },
    beforeTransaction: (value: () => Promise<void>) => { beforeTransaction = value; } };
}

test('unconfigured factory stays unavailable; configured runtime requires durable SQLite', async t => {
  const f = await fixture(t);
  const absent = createAppleSandboxReconciliation(f.db, undefined, { ownerWriter: f.writer });
  assert.equal((await absent.forOwner(actor).reconcileOwner(owner, { handle: randomUUID(), expectedPage: 0 })).status, 'unavailable');
  assert.equal((await absent.ingestNotification('unverified')).status, 'unavailable');
  assert.equal(count(f.db, 'apple_purchase_reconciliations'), 0);
  assert.throws(() => createAppleSandboxReconciliation(f.db, config, { ownerWriter: f.writer }), /durable SQLite/);
});

test('SDK adapter explicitly uses V2 with fixed parameters and the supplied original lineage', async () => {
  const calls: unknown[][] = [];
  const reader = createAppleHistoryReader({ getTransactionHistory: async (...args) => { calls.push(args); return page([]); } });
  await reader.page('10000', null); await reader.page('10000', 'cursor');
  assert.deepEqual(calls, [['10000', null, {}, GetTransactionHistoryVersion.V2], ['10000', 'cursor', {}, GetTransactionHistoryVersion.V2]]);
});

test('official adapter rejects malformed notification, renewal and transaction proofs', async () => {
  const verifier = createAppleSandboxReconciliationVerifier(config);
  for (const verify of [verifier.notification, verifier.renewal, verifier.verify])
    await assert.rejects(verify('unsigned.payload.signature'), AppleProofError);
});

test('missing background authority performs no verification or durable notification writes', async t => {
  const f = await fixture(t);
  assert.equal((await f.build(false).ingestNotification(f.notification(f.transaction()))).reason, 'purchase_background_writer_required');
  assert.equal(f.counters.notification, 0);
  assert.equal(count(f.db, 'apple_purchase_notifications'), 0);
});

test('renewal-only notification is verified evidence and cannot extend expiry or create a grant', async t => {
  const f = await fixture(t);
  const expired = f.transaction(proof({ signedDate: now + 1, expiresDate: now - 1 }));
  assert.equal((await f.service.ingestNotification(f.notification(expired))).status, 'observed');
  assert.deepEqual(f.ledger.entitlements(accountA).active, []);
  const result = await f.service.ingestNotification(f.notification(undefined, f.renewal({ gracePeriodExpiresDate: now + 500_000 })));
  assert.equal(result.reason, 'renewal_evidence_only');
  assert.equal(f.counters.renewal, 1);
  assert.deepEqual(f.ledger.entitlements(accountA).active, []);
  assert.equal(count(f.db, 'apple_purchase_grants'), 1);
  assert.equal(count(f.db, 'apple_purchase_deliveries'), 1);
});

test('nested notification and renewal proofs must match installed token, lineage, bundle and environment', async t => {
  const f = await fixture(t);
  for (const changed of [{ appAccountToken: accountB }, { originalTransactionId: '99999' }, { environment: 'Production' }]) {
    const result = await f.service.ingestNotification(f.notification(f.transaction(), f.renewal(changed)));
    assert.equal(result.status, 'rejected');
  }
  const foreign = await f.service.ingestNotification(f.notification(f.transaction(proof({ bundleId: 'com.foreign.app' }))));
  assert.equal(foreign.status, 'rejected');
  assert.equal(count(f.db, 'apple_purchase_notifications'), 0);
});

test('notification UUID and exact payload deduplicate, while changed bytes collide', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const signed = f.notification(f.transaction(proof({ transactionId: '10002' })), f.renewal(), { notificationUUID: id });
  const first = await f.service.ingestNotification(signed);
  assert.equal(first.status, 'observed');
  assert.deepEqual(await f.build().ingestNotification(signed), first);
  const collision = f.notification(f.transaction(), undefined, { notificationUUID: id });
  assert.equal((await f.service.ingestNotification(collision)).reason, 'apple_notification_collision');
  assert.equal(count(f.db, 'apple_purchase_notifications'), 1);
  assert.equal(count(f.db, 'apple_purchase_commands'), 1);
  assert.equal(count(f.db, 'apple_purchase_deliveries'), 1);
});

test('a verified notification cannot establish a previously unknown original owner', async t => {
  const f = await fixture(t);
  const result = await f.service.ingestNotification(f.notification(f.transaction(proof({ originalTransactionId: '90000', transactionId: '90001' }))));
  assert.equal(result.reason, 'apple_owner_mismatch');
  assert.equal(count(f.db, 'apple_purchase_owners'), 1);
  assert.equal(count(f.db, 'apple_purchase_notifications'), 0);
});

test('observed revocation and upgrade remain sticky; refund reversal is held without restoration', async t => {
  const f = await fixture(t);
  const revoked = f.transaction(proof({ revocationDate: now - 10 }));
  assert.equal((await f.service.ingestNotification(f.notification(revoked))).status, 'observed');
  const reversal = f.notification(f.transaction(proof({ signedDate: now + 1 })), undefined, { notificationType: 'REFUND_REVERSED' });
  assert.equal((await f.service.ingestNotification(reversal)).reason, 'apple_refund_reversal_policy_unavailable');
  f.setFetch(async () => page([f.transaction(proof({ signedDate: now + 2 }))]));
  assert.equal((await f.service.forOwner(actor).reconcileOwner(owner, { handle: randomUUID(), expectedPage: 0 })).status, 'complete');
  assert.deepEqual(f.ledger.entitlements(accountA).active, []);
  const upgraded = f.transaction(proof({ transactionId: '10002', isUpgraded: true }));
  await f.service.ingestNotification(f.notification(upgraded));
  await f.service.ingestNotification(f.notification(f.transaction(proof({ transactionId: '10002', signedDate: now + 3 }))));
  assert.deepEqual(f.ledger.entitlements(accountA).active, []);
  assert.throws(() => f.db.prepare('UPDATE apple_purchase_transactions SET revocation_date_ms=NULL WHERE transaction_id=?').run('10001'), /permanent_apple_purchase_revocation/);
});

test('bounded pages persist cursor and exact outcomes across service reconstruction without replay or native receipts', async t => {
  const f = await fixture(t);
  const next = f.transaction(proof({ transactionId: '10002' }));
  const observed: (string | null)[] = [];
  f.setFetch(async (id, revision) => { assert.equal(id, '10000'); observed.push(revision); return page([next], revision ? 'revision-2' : 'revision-1', !revision); });
  const handle = randomUUID();
  const first = await f.service.forOwner(actor).reconcileOwner(owner, { handle, expectedPage: 0 });
  assert.equal(first.status, 'pending');
  const resumed = f.build().forOwner(actor);
  assert.deepEqual(resumed.readReconciliation(handle), first);
  assert.deepEqual(await resumed.reconcileOwner(owner, { handle, expectedPage: 0 }), first);
  assert.equal(f.counters.history, 1);
  const last = await resumed.reconcileOwner(owner, { handle, expectedPage: 1 });
  assert.equal(last.status, 'complete');
  assert.deepEqual(observed, [null, 'revision-1']);
  assert.equal(count(f.db, 'apple_purchase_deliveries'), 1);
  assert.equal(count(f.db, 'apple_purchase_commands'), 1);
  assert.equal(count(f.db, 'apple_purchase_grants'), 2);
});

test('every customer-history item must match original token and lineage; mixed pages have no partial effects', async t => {
  const f = await fixture(t);
  for (const changed of [{ appAccountToken: accountB }, { originalTransactionId: '90000' }]) {
    f.setFetch(async () => page([f.transaction(proof({ transactionId: '10002' })), f.transaction(proof({ transactionId: '10003', ...changed }))]));
    const handle = randomUUID();
    const result = await f.service.forOwner(actor).reconcileOwner(owner, { handle, expectedPage: 0 });
    assert.equal(result.reason, 'apple_history_owner_mismatch');
    assert.deepEqual(f.service.forOwner(actor).readReconciliation(handle), result);
    assert.equal(count(f.db, 'apple_purchase_transactions'), 1);
  }
});

test('a later invalid product rolls back the whole verified page and commits a rejected outcome only', async t => {
  const f = await fixture(t);
  f.setFetch(async () => page([f.transaction(proof({ transactionId: '10002' })),
    f.transaction(proof({ transactionId: '10003', productId: 'not.configured' }))]));
  const handle = randomUUID();
  const result = await f.service.forOwner(actor).reconcileOwner(owner, { handle, expectedPage: 0 });
  assert.equal(result.reason, 'apple_product_not_allowed');
  assert.equal(result.transactions, 0);
  assert.equal(count(f.db, 'apple_purchase_transactions'), 1);
  assert.deepEqual(f.service.forOwner(actor).readReconciliation(handle), result);
});

test('verifier uncertainty retains no partial page and does not automatically retry', async t => {
  const f = await fixture(t);
  f.setFetch(async () => page([f.transaction(new AppleProofError('apple_verification_unavailable', true))]));
  const handle = randomUUID();
  assert.equal((await f.service.forOwner(actor).reconcileOwner(owner, { handle, expectedPage: 0 })).status, 'unknown');
  assert.equal(f.service.forOwner(actor).readReconciliation(handle), null);
  assert.equal(f.counters.history, 1);
  assert.equal(count(f.db, 'apple_purchase_transactions'), 1);
});

test('owner assertions and checkpoint/readback are isolated to the original account and four-coordinate actor', async t => {
  const f = await fixture(t);
  const bound = f.service.forOwner(actor);
  const handle = randomUUID();
  assert.equal((await bound.reconcileOwner({ ...owner, appAccountToken: accountB }, { handle, expectedPage: 0 })).status, 'rejected');
  assert.equal((await bound.reconcileOwner(owner, { handle, expectedPage: 1 })).reason, 'reconciliation_checkpoint_stale');
  await bound.reconcileOwner(owner, { handle, expectedPage: 0 });
  assert.equal((await bound.reconcileOwner({ ...owner, bundleId: 'com.foreign.app' }, { handle, expectedPage: 0 })).status, 'rejected');
  const other = { accountId: accountB, authUserId: 'auth-b', sessionId: 'session-b', epoch: 1 };
  f.replaceActor(other);
  assert.throws(() => bound.readReconciliation(handle), /account_session_invalid/);
  assert.equal(f.service.forOwner(other).readReconciliation(handle), null);
  const replaced = { ...actor, sessionId: 'replacement' };
  f.replaceActor(replaced);
  assert.throws(() => f.service.forOwner(replaced).readReconciliation(handle), /reconciliation_binding_mismatch/);
});

test('session replacement during fetch fences late state; mutating caller context cannot retarget a captured actor', async t => {
  const f = await fixture(t);
  const response = deferred<HistoryResponse>();
  f.setFetch(() => response.promise);
  const mutable = { ...actor };
  const bound = f.service.forOwner(mutable);
  const handle = randomUUID();
  const pending = bound.reconcileOwner(owner, { handle, expectedPage: 0 });
  mutable.sessionId = 'new-session'; f.replaceActor(mutable);
  response.resolve(page([f.transaction(proof({ transactionId: '10002' }))]));
  assert.equal((await pending).reason, 'account_session_invalid');
  assert.equal(count(f.db, 'apple_purchase_reconciliations'), 0);
  assert.equal(count(f.db, 'apple_purchase_transactions'), 1);
});

test('account disable during nested verification prevents all ledger and checkpoint writes', async t => {
  const f = await fixture(t);
  f.setFetch(async () => page([f.transaction(proof({ transactionId: '10002' }))]));
  f.beforeTransaction(async () => { f.disable(); });
  assert.equal((await f.service.forOwner(actor).reconcileOwner(owner, { handle: randomUUID(), expectedPage: 0 })).status, 'rejected');
  assert.equal(count(f.db, 'apple_purchase_transactions'), 1);
  assert.equal(count(f.db, 'apple_purchase_reconciliations'), 0);
});

test('page outcome storage failure atomically rolls back ledger and run and returns unknown', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER fail_page BEFORE INSERT ON apple_purchase_reconciliation_pages BEGIN SELECT RAISE(ABORT, 'injected_page_failure'); END");
  f.setFetch(async () => page([f.transaction(proof({ transactionId: '10002' }))]));
  const handle = randomUUID();
  assert.equal((await f.service.forOwner(actor).reconcileOwner(owner, { handle, expectedPage: 0 })).status, 'unknown');
  assert.equal(count(f.db, 'apple_purchase_transactions'), 1);
  assert.equal(count(f.db, 'apple_purchase_reconciliations'), 0);
  assert.equal(f.service.forOwner(actor).readReconciliation(handle), null);
});

test('overlapping checkpoint requests cannot replace a committed page with different signed payloads', async t => {
  const f = await fixture(t);
  const firstResponse = deferred<HistoryResponse>();
  const secondResponse = deferred<HistoryResponse>();
  let calls = 0;
  f.setFetch(() => ++calls === 1 ? firstResponse.promise : secondResponse.promise);
  const bound = f.service.forOwner(actor);
  const checkpoint = { handle: randomUUID(), expectedPage: 0 };
  const first = bound.reconcileOwner(owner, checkpoint);
  const second = bound.reconcileOwner(owner, checkpoint);
  firstResponse.resolve(page([f.transaction(proof({ transactionId: '10002' }))]));
  assert.equal((await first).status, 'complete');
  secondResponse.resolve(page([f.transaction(proof({ transactionId: '10003' }))]));
  assert.equal((await second).reason, 'reconciliation_page_conflict');
  assert.equal(count(f.db, 'apple_purchase_transactions'), 2);
});

test('oversized pages, malformed envelope and stalled cursors are durably rejected without grants', async t => {
  const f = await fixture(t);
  for (const response of [page(Array.from({ length: 21 }, () => f.transaction())), { ...page([]), bundleId: 'com.foreign.app' },
    page([], 'cursor', true)]) {
    f.setFetch(async () => response);
    assert.equal((await f.service.forOwner(actor).reconcileOwner(owner, { handle: randomUUID(), expectedPage: 0 })).reason, 'apple_history_page_invalid');
  }
  f.setFetch(async () => page([f.transaction()], 'unchanged', true));
  const handle = randomUUID();
  await f.service.forOwner(actor).reconcileOwner(owner, { handle, expectedPage: 0 });
  assert.equal((await f.service.forOwner(actor).reconcileOwner(owner, { handle, expectedPage: 1 })).reason, 'apple_history_cursor_stalled');
  assert.equal(count(f.db, 'apple_purchase_grants'), 1);
});

test('background disable and notification outcome failure cannot leave partial observations', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER fail_notification BEFORE INSERT ON apple_purchase_notifications BEGIN SELECT RAISE(ABORT, 'injected_notification_failure'); END");
  const signed = f.notification(f.transaction(proof({ transactionId: '10002' })));
  assert.equal((await f.service.ingestNotification(signed)).status, 'unknown');
  assert.equal(count(f.db, 'apple_purchase_transactions'), 1);
  f.disable();
  assert.equal((await f.service.ingestNotification(signed)).reason, 'account_disabled');
  assert.equal(count(f.db, 'apple_purchase_notifications'), 0);
});

test('a writer bound to another database cannot admit owner reconciliation effects', async t => {
  const f = await fixture(t);
  const foreign = new Database(':memory:'); t.after(() => foreign.close());
  const wrong: PurchaseOwnerWriter = { ...f.writer, lifecycleStoreOptions: {
    assertRootWriter: candidate => { if (candidate !== foreign) throw new DomainError(503, 'canonical_writer_unproved'); },
  } };
  const service = new ApplePurchaseReconciliation(f.db, config, f.verifier, {
    ownerWriter: wrong, history: { page: async () => page([f.transaction(proof({ transactionId: '10002' }))]) },
  }, () => now);
  assert.equal((await service.forOwner(actor).reconcileOwner(owner, { handle: randomUUID(), expectedPage: 0 })).reason, 'canonical_writer_unproved');
  assert.equal(count(f.db, 'apple_purchase_transactions'), 1);
});
