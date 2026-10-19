import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplePurchaseService } from '../../src/purchases/service.js';
import { applePurchaseMigrationSql, createAppleSandboxPurchases } from '../../src/purchases/index.js';
import { createAppleSandboxVerifier, pinnedAppleRoots } from '../../src/purchases/apple-verifier.js';
import { appleRoots } from '../../src/purchases/apple-roots.js';
import { validateAppleConfiguration } from '../../src/purchases/configuration.js';
import { AppleProofError, type AppleDeliveryRequest, type AppleSandboxConfiguration, type VerifiedAppleTransaction } from '../../src/purchases/types.js';

const accountA = '11111111-1111-4111-8111-111111111111';
const accountB = '22222222-2222-4222-8222-222222222222';
const now = 1_790_000_000_000;
const config: AppleSandboxConfiguration = { bundleId: 'com.form.test', products: [
  { productId: 'form.plus.month', type: 'Auto-Renewable Subscription', entitlement: 'form_plus' },
  { productId: 'form.plus.lifetime', type: 'Non-Consumable', entitlement: 'form_plus' },
] };
function proof(overrides: Partial<VerifiedAppleTransaction> = {}): VerifiedAppleTransaction {
  return { transactionId: '10001', originalTransactionId: '10000', bundleId: config.bundleId, environment: 'Sandbox',
    productId: 'form.plus.month', type: 'Auto-Renewable Subscription', appAccountToken: accountA,
    inAppOwnershipType: 'PURCHASED', purchaseDate: now - 1000, signedDate: now, quantity: 1, expiresDate: now + 60_000, ...overrides };
}
/** Synthetic verifier only: these registered opaque strings are never Apple-valid fixtures. */
function synthetic() {
  const claims = new Map<string, VerifiedAppleTransaction | Error>();
  let calls = 0;
  return {
    register(p: VerifiedAppleTransaction | Error, requestOverrides: Partial<AppleDeliveryRequest> = {}): AppleDeliveryRequest {
      const jws = `synthetic.${Buffer.from(randomUUID()).toString('base64url')}.signature`;
      claims.set(jws, p);
      return { transactionId: p instanceof Error ? '10001' : p.transactionId,
        productId: p instanceof Error ? 'form.plus.month' : p.productId, jwsRepresentation: jws,
        idempotencyKey: `storekit-delivery:${p instanceof Error ? '10001' : p.transactionId}`, ...requestOverrides };
    },
    verifier: { async verify(jws: string) {
      calls += 1;
      const p = claims.get(jws);
      if (!p) throw new AppleProofError('apple_signature_invalid');
      if (p instanceof Error) throw p;
      await Promise.resolve();
      return { ...p };
    } },
    calls: () => calls,
  };
}
function memory(t: TestContext) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO form_accounts VALUES (?)').run(accountA);
  db.prepare('INSERT INTO form_accounts VALUES (?)').run(accountB);
  db.exec(applePurchaseMigrationSql);
  t.after(() => { if (db.open) db.close(); });
  return db;
}
function disk(t: TestContext) {
  // These tests run from dist/tests/purchases; scratch remains in the declared source/test cone.
  const parent = fileURLToPath(new URL('../../../tests/purchases/.scratch/', import.meta.url));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'purchase-'));
  const handles = new Set<Database.Database>();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    for (const db of handles) if (db.open) db.close();
    rmSync(root, { recursive: true }); cleaned = true;
  };
  const sigint = () => { cleanup(); process.exit(130); };
  const sigterm = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
  t.after(() => {
    try { cleanup(); }
    finally { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); }
  });
  const path = join(root, 'sandbox.sqlite');
  return { root, path, open(initial = false) {
    const db = new Database(path); handles.add(db);
    db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('busy_timeout = 5000');
    if (initial) {
      db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
      db.prepare('INSERT INTO form_accounts VALUES (?)').run(accountA);
      db.prepare('INSERT INTO form_accounts VALUES (?)').run(accountB);
      db.exec(applePurchaseMigrationSql);
    }
    return db;
  } };
}
function count(db: Database.Database, table: 'apple_purchase_grants' | 'apple_purchase_deliveries' | 'apple_purchase_transactions' | 'apple_purchase_owners') {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test('only explicit Sandbox configuration is accepted; public trust anchors match retained SHA-256', t => {
  assert.equal(validateAppleConfiguration(config).environment, 'Sandbox');
  for (const environment of ['Production', 'Xcode', 'LocalTesting', 'XCODE', 'LOCAL_TESTING'])
    assert.throws(() => validateAppleConfiguration({ ...config, environment }));
  assert.throws(() => validateAppleConfiguration({ ...config, enableOnlineChecks: false }));
  assert.throws(() => validateAppleConfiguration({ ...config, products: [] }));
  const certs = pinnedAppleRoots();
  assert.equal(certs.length, 3);
  certs.forEach((bytes, i) => assert.equal(createHash('sha256').update(bytes).digest('hex'), appleRoots[i]!.sha256));
  const db = memory(t);
  assert.throws(() => createAppleSandboxPurchases(db, config), /durable SQLite/);
  assert.equal(createAppleSandboxPurchases(db).capabilities().status, 'unconfigured');
});

test('missing session mapping and client ownership inputs cannot authorize delivery', async t => {
  const db = memory(t); const seam = synthetic();
  const service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  const request = seam.register(proof());
  assert.deepEqual(service.accountBinding(accountA), { accountId: accountA, appAccountToken: accountA });
  assert.equal((await service.deliver(randomUUID(), request)).status, 'rejected');
  assert.equal((await service.deliver(accountA, { ...request, accountId: accountB })).status, 'rejected');
  assert.equal(seam.calls(), 0);
  assert.equal(count(db, 'apple_purchase_grants'), 0);
});

test('malformed, unsigned and failed signatures never create purchase state', async t => {
  const db = memory(t); const seam = synthetic();
  const service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  const request = seam.register(new AppleProofError('apple_signature_invalid'));
  for (const jwsRepresentation of ['', 'bad', 'e30.e30.', 'a.b.c.d', 'a.b.c=', 'a'.repeat(60_001)])
    assert.equal((await service.deliver(accountA, { ...request, jwsRepresentation })).status, 'rejected');
  assert.deepEqual(await service.deliver(accountA, request), { status: 'rejected', code: 'apple_signature_invalid' });
  assert.equal(count(db, 'apple_purchase_transactions'), 0);
  assert.equal(count(db, 'apple_purchase_grants'), 0);
});

test('bundle, environment, product, account, ownership and date policies independently fail closed', async t => {
  const db = memory(t); const seam = synthetic();
  const service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  const invalid: Partial<VerifiedAppleTransaction>[] = [
    { bundleId: 'com.other.app' }, { environment: 'Production' }, { environment: 'Xcode' }, { environment: 'LocalTesting' },
    { productId: 'not.allowed' }, { type: 'Consumable' }, { appAccountToken: accountB }, { appAccountToken: '' },
    { inAppOwnershipType: 'FAMILY_SHARED' }, { quantity: 2 }, { purchaseDate: now + 120_000 }, { signedDate: now + 120_000 },
    { expiresDate: now - 500 }, { revocationDate: now }, { isUpgraded: true }, { expiresDate: Number.NaN },
  ];
  for (const override of invalid) {
    const outcome = await service.deliver(accountA, seam.register(proof(override)));
    assert.equal(outcome.status, 'rejected', JSON.stringify(override));
  }
  assert.equal(count(db, 'apple_purchase_grants'), 0);
  assert.equal(count(db, 'apple_purchase_deliveries'), 0);
  assert.deepEqual(service.entitlements(accountA).active, []);
});

test('missing subscription expiry is rejected; non-consumable lifetime grant is supported explicitly', async t => {
  const db = memory(t); const seam = synthetic();
  const service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  const missingExpiry = proof(); delete missingExpiry.expiresDate;
  assert.deepEqual(await service.deliver(accountA, seam.register(missingExpiry)), { status: 'rejected', code: 'apple_expiry_required' });
  const lifetime = proof({ transactionId: '10002', productId: 'form.plus.lifetime', type: 'Non-Consumable' }); delete lifetime.expiresDate;
  assert.equal((await service.deliver(accountA, seam.register(lifetime))).status, 'delivered');
  assert.equal(service.entitlements(accountA).grants[0]!.expiresAt, null);
});

test('exact proof receipts scope the native acknowledgement and matching replays reuse the original delivery', async t => {
  const db = memory(t); const seam = synthetic();
  const service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  const request = seam.register(proof());
  const first = await service.deliver(accountA, request);
  assert.equal(first.status, 'delivered');
  assert.deepEqual(await service.deliver(accountA, request), first);
  assert.deepEqual(await service.deliver(accountA, { ...request, idempotencyKey: 'alternate-key' }), first);
  const receipt = db.prepare('SELECT * FROM apple_purchase_deliveries').get() as Record<string, unknown>;
  assert.equal(receipt.account_id, accountA); assert.equal(receipt.transaction_id, request.transactionId);
  assert.equal(receipt.product_id, request.productId); assert.equal(receipt.exact_jws, request.jwsRepresentation);
  assert.equal(receipt.proof_hash, createHash('sha256').update(request.jwsRepresentation).digest('hex'));
  if (first.status === 'delivered') assert.equal(receipt.server_delivery_id, first.serverDeliveryId);
  assert.equal(count(db, 'apple_purchase_grants'), 1); assert.equal(count(db, 'apple_purchase_deliveries'), 1);
  assert.deepEqual(service.entitlements(accountB), { grants: [], active: [] });
});

test('transaction identity and original subscription ownership remain immutable across accounts', async t => {
  const db = memory(t); const seam = synthetic();
  const service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  const request = seam.register(proof());
  assert.equal((await service.deliver(accountA, request)).status, 'delivered');
  assert.equal((await service.deliver(accountB, request)).status, 'rejected');
  const anotherAccount = seam.register(proof({ appAccountToken: accountB, transactionId: '10003', signedDate: now + 1 }));
  assert.deepEqual(await service.deliver(accountB, anotherAccount), { status: 'rejected', code: 'apple_transaction_owned' });
  assert.equal((await service.deliver(accountA, seam.register(proof({ originalTransactionId: '10009' })))).status, 'rejected');
  assert.equal(count(db, 'apple_purchase_owners'), 1); assert.equal(count(db, 'apple_purchase_grants'), 1);
});

test('idempotency key cannot be reassigned; newer exact signed proof gets its own scoped receipt', async t => {
  const db = memory(t); const seam = synthetic();
  const service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  const request = seam.register(proof());
  const first = await service.deliver(accountA, request);
  const changedIntent = seam.register(proof({ transactionId: '10002' }), { idempotencyKey: request.idempotencyKey });
  assert.deepEqual(await service.deliver(accountA, changedIntent), { status: 'rejected', code: 'idempotency_mismatch' });
  const update = seam.register(proof({ signedDate: now + 1, expiresDate: now + 120_000 }));
  const next = await service.deliver(accountA, update);
  assert.equal(next.status, 'delivered'); assert.notDeepEqual(next, first);
  assert.deepEqual(await service.deliver(accountA, request), first);
  assert.equal(count(db, 'apple_purchase_grants'), 1); assert.equal(count(db, 'apple_purchase_deliveries'), 2);
});

test('revocation is durable and sticky, including older valid proofs and response-loss replay', async t => {
  const fixture = disk(t); let db = fixture.open(true); const seam = synthetic();
  let service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  const active = seam.register(proof());
  assert.equal((await service.deliver(accountA, active)).status, 'delivered');
  const revoked = seam.register(proof({ signedDate: now + 1, revocationDate: now }));
  assert.deepEqual(await service.deliver(accountA, revoked), { status: 'rejected', code: 'apple_revoked' });
  db.close(); db = fixture.open(); service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  assert.deepEqual(await service.deliver(accountA, active), { status: 'rejected', code: 'apple_revoked' });
  assert.deepEqual(service.entitlements(accountA).active, []);
  assert.equal(service.entitlements(accountA).grants[0]!.active, false);
  assert.equal(count(db, 'apple_purchase_deliveries'), 1);
});

test('upgrade evidence and expiry prevent old entitlement resurrection; unacknowledged stale proof is rejected', async t => {
  const db = memory(t); const seam = synthetic(); let clock = now;
  const service = new ApplePurchaseService(db, config, seam.verifier, () => clock);
  const active = seam.register(proof());
  await service.deliver(accountA, active);
  const newer = seam.register(proof({ signedDate: now + 10 }));
  await service.deliver(accountA, newer);
  const unseenOld = seam.register(proof({ signedDate: now - 1 }));
  assert.deepEqual(await service.deliver(accountA, unseenOld), { status: 'rejected', code: 'apple_stale_proof' });
  clock = now + 60_000;
  assert.deepEqual(service.entitlements(accountA).active, []);
  assert.deepEqual(await service.deliver(accountA, active), { status: 'rejected', code: 'apple_expired' });
  clock = now;
  assert.deepEqual(await service.deliver(accountA, seam.register(proof({ signedDate: now + 20, isUpgraded: true }))), { status: 'rejected', code: 'apple_upgraded' });
  assert.deepEqual(await service.deliver(accountA, active), { status: 'rejected', code: 'apple_upgraded' });
});

test('overlapping requests on independent SQLite connections deduplicate grants and survive restart', async t => {
  const fixture = disk(t); const dbA = fixture.open(true); const dbB = fixture.open(); const seam = synthetic();
  const serviceA = new ApplePurchaseService(dbA, config, seam.verifier, () => now);
  const serviceB = new ApplePurchaseService(dbB, config, seam.verifier, () => now);
  const request = seam.register(proof());
  const results = await Promise.all([serviceA.deliver(accountA, request), serviceB.deliver(accountA, request)]);
  assert.equal(results[0]!.status, 'delivered'); assert.deepEqual(results[1], results[0]);
  assert.equal(count(dbA, 'apple_purchase_grants'), 1); assert.equal(count(dbB, 'apple_purchase_deliveries'), 1);
  dbA.close(); dbB.close();
  const reopened = fixture.open(); const restarted = new ApplePurchaseService(reopened, config, seam.verifier, () => now);
  // Simulates losing the first HTTP acknowledgement after the durable commit.
  assert.deepEqual(await restarted.deliver(accountA, request), results[0]);
  assert.deepEqual(restarted.entitlements(accountA).active, ['form_plus']);
  assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(reopened.pragma('foreign_key_check'), []);
});

test('receipt failure rolls back every grant/ownership effect and returns unknown, never delivered', async t => {
  const db = memory(t); const seam = synthetic();
  const service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON apple_purchase_deliveries BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  const request = seam.register(proof());
  assert.deepEqual(await service.deliver(accountA, request), { status: 'unknown', code: 'purchase_storage_effect_unknown' });
  for (const table of ['apple_purchase_grants', 'apple_purchase_deliveries', 'apple_purchase_transactions', 'apple_purchase_owners'] as const)
    assert.equal(count(db, table), 0);
  db.exec('DROP TRIGGER synthetic_receipt_failure');
  assert.equal((await service.deliver(accountA, request)).status, 'delivered');
});

test('verifier uncertainty and missing immutable account mapping never grant', async t => {
  const db = memory(t); const seam = synthetic();
  const service = new ApplePurchaseService(db, config, seam.verifier, () => now);
  assert.deepEqual(await service.deliver(accountA, seam.register(new AppleProofError('apple_verification_unavailable', true))),
    { status: 'unknown', code: 'apple_verification_unavailable' });
  const request = seam.register(proof());
  const removed = new ApplePurchaseService(db, config, { async verify(jws) {
    const claims = await seam.verifier.verify(jws);
    db.prepare('DELETE FROM form_accounts WHERE id=?').run(accountA);
    return claims;
  } }, () => now);
  assert.deepEqual(await removed.deliver(accountA, request), { status: 'rejected', code: 'authentication_required' });
  assert.equal(count(db, 'apple_purchase_grants'), 0);
});

test('actual Apple verifier rejects malformed, unsigned and forged certificate-bearing JWS without synthetic claims', async t => {
  const db = memory(t); const verifier = createAppleSandboxVerifier(config);
  const service = new ApplePurchaseService(db, config, verifier, () => now);
  const payload = Buffer.from(JSON.stringify(proof())).toString('base64url');
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: [appleRoots[2].derBase64, appleRoots[2].derBase64, appleRoots[2].derBase64] })).toString('base64url');
  const forged = `${header}.${payload}.${Buffer.alloc(64, 1).toString('base64url')}`;
  const request: AppleDeliveryRequest = { transactionId: '10001', productId: 'form.plus.month', jwsRepresentation: forged, idempotencyKey: 'real-crypto-negative' };
  const result = await service.deliver(accountA, request);
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.equal(result.code, 'apple_signature_invalid');
  await assert.rejects(verifier.verify('e30.e30.'), AppleProofError);
  assert.equal(count(db, 'apple_purchase_transactions'), 0); assert.equal(count(db, 'apple_purchase_grants'), 0);
});

test('real Apple-signed Sandbox positive-proof gate', { skip: 'No licensed, provisioned Form Sandbox signed JWS is supplied. Synthetic claims do not prove successful cryptographic verification or native activation.' }, () => {});
