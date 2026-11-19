import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AccountContext } from '../../src/lifecycle/types.js';
import type { Sqlite } from '../../src/storage.js';
import { QualifiedRefusal, createSyntheticPurchaseAccessAuthority } from '../../src/purchases/qualified-purchase-context.js';
import { createQualifiedPurchaseReader } from '../../src/purchases/qualified-purchase-store.js';
import type { PurchaseAccessContext, PurchaseNamespace, QualifiedObservationCursor, QualifiedProjectionRead } from '../../src/purchases/qualified-purchase.types.js';
import { ACCOUNT_A, ACCOUNT_B, PRD_A, SBX_A, STORE_GENERATION, STORE_ID, advanceProjection, aggregateFor, count, nsKey, projectionReference, qualified, schemaObjects, seedAccount,
  seedDependency, seedDelivery, seedOwner, seedProjection, seedProofObservation, seedReconciliation, seedStatusObservation, seedTransaction, sha, tableCounts,
  migrationRows } from './qualified-purchase-fixture.js';
import type { QualifiedFixture } from './qualified-purchase-fixture.js';

const A_UUID = '6b340806-51e1-411c-a356-2433e0781fb6';
const ACCOUNT_A2: AccountContext = { ...ACCOUNT_A, sessionId: 'qualified-session-a2' };
const refusal = (statement: () => unknown): string => {
  try { statement(); } catch (error) { return error instanceof QualifiedRefusal ? error.code : `unexpected:${String(error)}`; }
  return 'none';
};
const snapshot = (db: Sqlite): string => JSON.stringify({ objects: schemaObjects(db), counts: tableCounts(db), receipts: migrationRows(db) });

async function world(t: Parameters<typeof qualified>[0]): Promise<QualifiedFixture> {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A); seedAccount(f.db, ACCOUNT_B);
  return f;
}
const isHeld = (read: QualifiedProjectionRead): string => read.status === 'held' ? read.reason : read.status;

// ---------------------------------------------------------------------------------------------------------------------
// Namespace-bound, synchronous, privately authorised readers
// ---------------------------------------------------------------------------------------------------------------------

test('replacing the same account\'s selection invalidates every old context and cursor; the new selection reads only its own namespace', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, PRD_A, '1000', ACCOUNT_A);
  for (let index = 0; index < 4; index++) seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A });
  seedStatusObservation(f.db, PRD_A, { original: '1000', account: ACCOUNT_A });
  const first = f.context(ACCOUNT_A, SBX_A, 'selection-one');
  assert.equal(f.reader.owner(first, '1000')?.namespace.environment, 'Sandbox');
  const page = f.reader.listObservationMetadata(first, { limit: 2 });
  assert.equal(page.records.length, 2);
  assert.ok(page.cursor);
  assert.ok(page.records.every(record => nsKey(record.namespace) === nsKey(SBX_A)));

  // Another environment for the same account: the old context and its cursor die; nothing falls back or unions.
  const second = f.context(ACCOUNT_A, PRD_A, 'selection-two');
  assert.equal(refusal(() => f.reader.owner(first, '1000')), 'selection_changed');
  assert.equal(refusal(() => f.reader.listObservationMetadata(first, { limit: 2, cursor: page.cursor! })), 'selection_changed');
  assert.equal(refusal(() => f.reader.listObservationMetadata(second, { limit: 2, cursor: page.cursor! })), 'stale_cursor');
  const production = f.reader.listObservationMetadata(second, { limit: 5 });
  assert.equal(production.records.length, 1);
  assert.equal(production.records[0]!.namespace.environment, 'Production');
  assert.equal(f.reader.owner(second, '1000')?.namespace.environment, 'Production');

  // The same namespace under a new selection generation is also a new authority: old context and cursor are not reusable.
  const sandboxAgain = f.context(ACCOUNT_A, SBX_A, 'selection-three');
  assert.equal(refusal(() => f.reader.owner(first, '1000')), 'selection_changed');
  assert.equal(refusal(() => f.reader.owner(second, '1000')), 'selection_changed');
  assert.equal(refusal(() => f.reader.listObservationMetadata(sandboxAgain, { limit: 2, cursor: page.cursor! })), 'stale_cursor');
  assert.equal(f.reader.listObservationMetadata(sandboxAgain, { limit: 5 }).records.length, 4);
});

test('forged, copied, foreign, revoked and closed contexts are refused; suppression, currentness and callback shape fail closed', async t => {
  const f = await world(t), other = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(other.db, SBX_A, '1000', ACCOUNT_A);
  const context = f.context(ACCOUNT_A, SBX_A);
  assert.ok(f.reader.owner(context, '1000'));
  const forged: unknown[] = [{}, Object.create(null), Object.freeze({}), { ...context }, Object.assign(Object.create(null), context), null, undefined, 'context', 5, () => context];
  for (const value of forged) assert.equal(refusal(() => f.reader.owner(value as PurchaseAccessContext, '1000')), 'context_unavailable');
  // A context privately issued for another database is not valid here, even with identical identities.
  const foreign = other.context(ACCOUNT_A, SBX_A);
  assert.equal(refusal(() => f.reader.owner(foreign, '1000')), 'context_unavailable');

  const revoked = f.context(ACCOUNT_A, SBX_A);
  f.issuer.revoke(revoked);
  assert.equal(refusal(() => f.reader.owner(revoked, '1000')), 'context_unavailable');
  assert.ok(f.reader.owner(context, '1000'), 'revoking one context does not revoke another');

  f.accounts.set(ACCOUNT_A.accountId, { suppressed: true, epoch: 0, current: true });
  assert.equal(refusal(() => f.reader.owner(context, '1000')), 'account_unavailable');
  assert.equal(refusal(() => f.issuer.forOwner(ACCOUNT_A)), 'account_unavailable');
  f.accounts.set(ACCOUNT_A.accountId, { suppressed: false, epoch: 1, current: true });
  assert.equal(refusal(() => f.reader.owner(context, '1000')), 'account_unavailable');
  f.accounts.set(ACCOUNT_A.accountId, { suppressed: false, epoch: 0, current: false });
  assert.equal(refusal(() => f.reader.owner(context, '1000')), 'account_unavailable');
  f.accounts.set(ACCOUNT_A.accountId, { suppressed: false, epoch: 0, current: true });
  assert.ok(f.reader.owner(context, '1000'));

  f.control.currentness = false;
  assert.equal(refusal(() => f.reader.owner(context, '1000')), 'context_unavailable');
  assert.equal(refusal(() => f.issuer.forOwner(ACCOUNT_A)), 'context_unavailable');
  f.control.currentness = true;
  assert.ok(f.reader.owner(context, '1000'));
  assert.equal(refusal(() => f.issuer.forOwner({ ...ACCOUNT_A, authUserId: 'someone-else' })), 'account_unavailable');
  assert.equal(refusal(() => f.issuer.forOwner({ ...ACCOUNT_A, accountId: 'not-a-uuid' })), 'context_unavailable');
  assert.equal(refusal(() => f.issuer.forOwner({ ...ACCOUNT_A, extra: 1 } as AccountContext)), 'context_unavailable');

  // Selections outside the configured set never produce a context: unknown bundle, or a different appAppleId for Production.
  f.selections.set(ACCOUNT_B.accountId, { namespace: { ...SBX_A, bundleId: 'com.example.unknown' }, generation: 'selection-one' });
  assert.equal(refusal(() => f.issuer.forOwner(ACCOUNT_B)), 'selection_changed');
  f.selections.set(ACCOUNT_B.accountId, { namespace: { ...PRD_A, appAppleId: 5 }, generation: 'selection-one' });
  assert.equal(refusal(() => f.issuer.forOwner(ACCOUNT_B)), 'selection_changed');
  f.selections.set(ACCOUNT_B.accountId, { namespace: { ...SBX_A, environment: 'Xcode' } as unknown as PurchaseNamespace, generation: 'selection-one' });
  assert.equal(refusal(() => f.issuer.forOwner(ACCOUNT_B)), 'selection_changed');
  f.selections.delete(ACCOUNT_B.accountId);
  assert.equal(refusal(() => f.issuer.forOwner(ACCOUNT_B)), 'selection_changed');

  // A thenable from any callback is a refusal, never awaited or coerced.
  const base = { use: 'isolated-synthetic' as const, storeId: STORE_ID, generation: STORE_GENERATION, configurationRevision: 'config1', policyRevision: 'policy1', authorityGeneration: 'authority-two' };
  const sync = { currentSelection: () => ({ namespace: SBX_A, generation: 'selection-one' }), accountState: () => ({ suppressed: false, epoch: 0, current: true }), currentness: () => true };
  const asyncSelection = createSyntheticPurchaseAccessAuthority(f.db, { ...base, ...sync, currentSelection: () => Promise.resolve({ namespace: SBX_A, generation: 'selection-one' }) as never });
  assert.equal(refusal(() => asyncSelection.forOwner(ACCOUNT_A)), 'selection_changed');
  const asyncState = createSyntheticPurchaseAccessAuthority(f.db, { ...base, ...sync, accountState: () => Promise.resolve({ suppressed: false, epoch: 0, current: true }) as never });
  assert.equal(refusal(() => asyncState.forOwner(ACCOUNT_A)), 'account_unavailable');
  const asyncCurrent = createSyntheticPurchaseAccessAuthority(f.db, { ...base, ...sync, currentness: () => Promise.resolve(true) });
  assert.equal(refusal(() => asyncCurrent.forOwner(ACCOUNT_A)), 'context_unavailable');
  const truthy = createSyntheticPurchaseAccessAuthority(f.db, { ...base, ...sync, currentness: () => 1 });
  assert.equal(refusal(() => truthy.forOwner(ACCOUNT_A)), 'context_unavailable');
  const throwing = createSyntheticPurchaseAccessAuthority(f.db, { ...base, ...sync, accountState: () => { throw new Error('private detail'); } });
  assert.equal(refusal(() => throwing.forOwner(ACCOUNT_A)), 'account_unavailable');

  // Issuer inputs are bound to the exact stored identity, configuration and policy.
  for (const wrong of [{ storeId: 'other' }, { generation: 'other' }, { configurationRevision: 'config2' }, { policyRevision: 'policy2' }, { use: 'live' as never }]) {
    assert.equal(refusal(() => createSyntheticPurchaseAccessAuthority(f.db, { ...base, ...sync, ...wrong })), 'context_unavailable');
  }
  assert.equal(refusal(() => f.db.transaction(() => createSyntheticPurchaseAccessAuthority(f.db, { ...base, ...sync }))()), 'context_unavailable');
  assert.equal(refusal(() => createQualifiedPurchaseReader(f.db, { use: 'live' as never, clock: () => 1 })), 'invalid_request');
  assert.equal(refusal(() => f.db.transaction(() => createQualifiedPurchaseReader(f.db, { use: 'isolated-synthetic', clock: () => 1 }))()), 'transaction_not_allowed');

  const closing = createSyntheticPurchaseAccessAuthority(f.db, { ...base, ...sync });
  const issued = closing.forOwner(ACCOUNT_A);
  closing.close();
  assert.equal(refusal(() => f.reader.owner(issued, '1000')), 'context_unavailable');
  assert.equal(refusal(() => closing.forOwner(ACCOUNT_A)), 'context_unavailable');
});

test('owner reads are scoped to the selected namespace and the calling account; another account\'s owner is indistinguishable from absent', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, SBX_A, '1001', ACCOUNT_B); seedOwner(f.db, PRD_A, '1002', ACCOUNT_A); seedOwner(f.db, PRD_A, '1000', ACCOUNT_B);
  const a = f.context(ACCOUNT_A, SBX_A), b = f.context(ACCOUNT_B, PRD_A);
  const owner = f.reader.owner(a, '1000');
  assert.deepEqual(owner, { namespace: { provider: 'Apple', bundleId: SBX_A.bundleId, environment: 'Sandbox', appAppleId: null }, originalTransactionId: '1000',
    accountId: ACCOUNT_A.accountId, appAccountToken: ACCOUNT_A.accountId });
  assert.equal(f.reader.owner(a, '1001'), null, 'another account\'s lineage in the same namespace');
  assert.equal(f.reader.owner(a, '1002'), null, 'the same account\'s lineage in another namespace');
  assert.equal(f.reader.owner(a, '9999'), null);
  assert.equal(f.reader.owner(b, '1000')?.accountId, ACCOUNT_B.accountId, 'an identical id in another environment belongs to its own owner');
  assert.equal(f.reader.owner(b, '1001'), null);
  for (const invalid of ['', 'abc', '1 2', '1'.repeat(65), '١٢٣', 123 as unknown as string, undefined as unknown as string, null as unknown as string, '1000\n'])
    assert.equal(refusal(() => f.reader.owner(a, invalid)), 'invalid_request', String(invalid));
  assert.ok(Object.isFrozen(owner), 'returned records are immutable');
  assert.equal(typeof (owner as unknown as { then?: unknown }).then, 'undefined', 'readers are synchronous');
});

test('delivery receipts are released only to the original session and never expose proof, token or raw evidence', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, SBX_A, '1001', ACCOUNT_B);
  const tx = seedTransaction(f.db, SBX_A, { transactionId: '2000', original: '1000', account: ACCOUNT_A, jws: 'synthetic.private.jws.material' });
  seedProofObservation(f.db, SBX_A, tx);
  seedDelivery(f.db, SBX_A, tx, { serverDeliveryId: 'delivery-one', actor: ACCOUNT_A });
  const original = f.context(ACCOUNT_A, SBX_A);
  const receipt = f.reader.delivery(original, '2000', tx.proofHash);
  assert.deepEqual(receipt, { namespace: { provider: 'Apple', bundleId: SBX_A.bundleId, environment: 'Sandbox', appAppleId: null }, transactionId: '2000', proofHash: tx.proofHash,
    productId: 'form.plus.month', serverDeliveryId: 'delivery-one', deliveryPolicyRevision: 'delivery1', deliveredAtMs: 1000 });
  const text = JSON.stringify(receipt);
  for (const secret of ['synthetic.private.jws.material', 'exact_jws', 'claims', ACCOUNT_A.sessionId, ACCOUNT_A.authUserId, 'appAccountToken']) assert.equal(text.includes(secret), false, secret);

  // A different session of the same account, or a different epoch of it, cannot read the native delivery id.
  const laterSession = f.context(ACCOUNT_A2, SBX_A);
  assert.equal(f.reader.delivery(laterSession, '2000', tx.proofHash), null);
  f.accounts.set(ACCOUNT_A.accountId, { suppressed: false, epoch: 1, current: true });
  const laterEpoch = f.context({ ...ACCOUNT_A, epoch: 1 }, SBX_A);
  assert.equal(f.reader.delivery(laterEpoch, '2000', tx.proofHash), null);
  f.accounts.set(ACCOUNT_A.accountId, { suppressed: false, epoch: 0, current: true });
  assert.equal(f.reader.delivery(f.context(ACCOUNT_B, SBX_A), '2000', tx.proofHash), null);
  const again = f.context(ACCOUNT_A, SBX_A);
  assert.equal(f.reader.delivery(again, '2000', sha('another proof')), null);
  assert.equal(f.reader.delivery(again, '2999', tx.proofHash), null);
  assert.equal(f.reader.delivery(again, '2000', tx.proofHash)?.serverDeliveryId, 'delivery-one');
  assert.equal(refusal(() => f.reader.delivery(again, '2000', 'not-hex')), 'invalid_request');
  assert.equal(refusal(() => f.reader.delivery(again, '2000', tx.proofHash.toUpperCase())), 'invalid_request');
  assert.equal(refusal(() => f.reader.delivery(again, 'x', tx.proofHash)), 'invalid_request');
  assert.equal(refusal(() => f.reader.delivery(again, '2000', undefined as unknown as string)), 'invalid_request');
});

test('reconciliation handles alone are neither a lookup key nor permission; metadata carries no query, binding or provider text', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  seedReconciliation(f.db, SBX_A, { handle: 'handle-one', original: '1000', actor: ACCOUNT_A, providerRevision: 'private_apple_continuation' });
  f.db.prepare('UPDATE qualified_apple_reconciliations SET outcome_json=? WHERE handle=?').run('{"status":"page_ready","private":"provider-detail"}', 'handle-one');
  seedReconciliation(f.db, SBX_A, { handle: 'handle-two', original: '1000', actor: ACCOUNT_A });
  f.db.prepare('UPDATE qualified_apple_reconciliations SET outcome_json=? WHERE handle=?').run('{"status":"private_provider_text"}', 'handle-two');
  seedReconciliation(f.db, SBX_A, { handle: 'handle-three', original: '1000', actor: ACCOUNT_A });
  f.db.prepare('UPDATE qualified_apple_reconciliations SET outcome_json=? WHERE handle=?').run('[]', 'handle-three');
  const original = f.context(ACCOUNT_A, SBX_A);
  const metadata = f.reader.reconciliation(original, 'handle-one');
  assert.deepEqual(metadata, { namespace: { provider: 'Apple', bundleId: SBX_A.bundleId, environment: 'Sandbox', appAppleId: null }, handle: 'handle-one',
    originalTransactionId: '1000', expectedPage: 0, outcomeKind: 'page_ready' });
  const text = JSON.stringify(metadata);
  for (const secret of ['private_apple_continuation', 'providerRevision', 'provider-detail', 'query', 'actor', ACCOUNT_A.sessionId, ACCOUNT_A.authUserId]) assert.equal(text.includes(secret), false, secret);
  assert.equal(f.reader.reconciliation(original, 'handle-two')?.outcomeKind, 'unknown');
  assert.equal(f.reader.reconciliation(original, 'handle-three')?.outcomeKind, 'unknown');
  assert.equal(f.reader.reconciliation(original, 'missing'), null);
  assert.equal(f.reader.reconciliation(f.context(ACCOUNT_A2, SBX_A), 'handle-one'), null, 'a different session does not hold the original actor binding');
  assert.equal(f.reader.reconciliation(f.context(ACCOUNT_B, SBX_A), 'handle-one'), null);
  const prod = f.context(ACCOUNT_A, PRD_A);
  assert.equal(f.reader.reconciliation(prod, 'handle-one'), null, 'the handle exists only in its own namespace');
  for (const invalid of ['', 'has space', 'x'.repeat(129), 5 as unknown as string, 'a/b']) assert.equal(refusal(() => f.reader.reconciliation(prod, invalid)), 'invalid_request', String(invalid));
});

test('observation metadata pages hold a stable high-water, a private cursor and strict scope, retention and size bounds', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, SBX_A, '1002', ACCOUNT_B); seedOwner(f.db, PRD_A, '1000', ACCOUNT_A);
  const mine: number[] = [];
  for (let index = 0; index < 7; index++) {
    mine.push(seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, kind: index % 2 ? 'history' : 'status' }).sequence);
    seedStatusObservation(f.db, SBX_A, { original: '1002', account: ACCOUNT_B });
  }
  seedStatusObservation(f.db, PRD_A, { original: '1000', account: ACCOUNT_A });
  const context = f.context(ACCOUNT_A, SBX_A);
  const first = f.reader.listObservationMetadata(context, { limit: 3 });
  assert.deepEqual(first.records.map(record => record.sequence), mine.slice(0, 3));
  assert.ok(first.cursor);
  for (const record of first.records) assert.deepEqual(Object.keys(record).sort(), ['eventKind', 'namespace', 'observedAtMs', 'sequence']);
  assert.ok(first.records.every(record => nsKey(record.namespace) === nsKey(SBX_A)));
  assert.deepEqual(Object.keys(first.cursor as object), [], 'the cursor is an opaque token; its state lives only in private storage');

  // New observations after the first page never shift, reorder or duplicate the pages already begun.
  const added = [seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A }).sequence, seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A }).sequence];
  const second = f.reader.listObservationMetadata(context, { limit: 3, cursor: first.cursor! });
  assert.deepEqual(second.records.map(record => record.sequence), mine.slice(3, 6));
  const third = f.reader.listObservationMetadata(context, { limit: 3, cursor: second.cursor! });
  assert.deepEqual(third.records.map(record => record.sequence), mine.slice(6));
  assert.equal(third.cursor, null);
  const fresh = f.reader.listObservationMetadata(context, { limit: 5 });
  assert.deepEqual(fresh.records.map(record => record.sequence), mine.slice(0, 5));
  const everything = [...mine, ...added];
  const chainOne = f.reader.listObservationMetadata(context, { limit: 5 }), chainTwo = f.reader.listObservationMetadata(context, { limit: 5, cursor: chainOne.cursor! });
  assert.deepEqual([...chainOne.records, ...chainTwo.records].map(record => record.sequence), everything, 'a fresh chain sees the new observations exactly once and in order');
  assert.equal(chainTwo.cursor, null);

  // A cursor belongs to one reader, account, namespace, selection generation and context scope.
  const otherReader = createQualifiedPurchaseReader(f.db, { use: 'isolated-synthetic', clock: () => f.clock.now });
  assert.equal(refusal(() => otherReader.listObservationMetadata(context, { limit: 3, cursor: first.cursor! })), 'stale_cursor');
  assert.equal(refusal(() => f.reader.listObservationMetadata(f.context(ACCOUNT_B, SBX_A), { limit: 3, cursor: first.cursor! })), 'stale_cursor');
  const reselected = f.context(ACCOUNT_A, SBX_A, 'selection-two');
  assert.equal(refusal(() => f.reader.listObservationMetadata(reselected, { limit: 3, cursor: first.cursor! })), 'stale_cursor');
  const current = f.context(ACCOUNT_A, SBX_A, 'selection-two');
  for (const forged of [{}, 'cursor', 5, Object.freeze({}), { ...first.cursor } as object, null]) {
    assert.equal(refusal(() => f.reader.listObservationMetadata(current, { limit: 3, cursor: forged as QualifiedObservationCursor })), 'stale_cursor');
  }
  // Limits: policy page size 5 and a total of 12 rows per cursor chain.
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number, undefined as unknown as number])
    assert.equal(refusal(() => f.reader.listObservationMetadata(current, { limit })), 'invalid_request', String(limit));
  assert.equal(refusal(() => f.reader.listObservationMetadata(current, { limit: 6 })), 'limit_exceeded');
  assert.equal(refusal(() => f.reader.listObservationMetadata(current, undefined as never)), 'invalid_request');
  for (let index = 0; index < 8; index++) seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A });
  const one = f.reader.listObservationMetadata(current, { limit: 5 }), two = f.reader.listObservationMetadata(current, { limit: 5, cursor: one.cursor! });
  assert.equal(one.records.length + two.records.length, 10);
  assert.equal(refusal(() => f.reader.listObservationMetadata(current, { limit: 5, cursor: two.cursor! })), 'limit_exceeded');

  // A cursor expires with the evidence retention window; history beyond audit retention is unavailable, never skipped.
  const early = f.reader.listObservationMetadata(current, { limit: 3 });
  f.clock.now += 60_000;
  assert.equal(refusal(() => f.reader.listObservationMetadata(current, { limit: 3, cursor: early.cursor! })), 'history_unavailable');
  f.clock.now += 300_000;
  assert.equal(refusal(() => f.reader.listObservationMetadata(current, { limit: 3 })), 'history_unavailable');
  f.clock.now = 1;
  assert.equal(refusal(() => f.reader.listObservationMetadata(current, { limit: 3 })), 'clock_unavailable', 'the reader clock never goes backwards');
});

test('every read is one immediate transaction that discards its result if authority changes before, during or after the SELECTs', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  const base = { use: 'isolated-synthetic' as const, storeId: STORE_ID, generation: STORE_GENERATION, configurationRevision: 'config1', policyRevision: 'policy1' };
  // Callback calls per read: 1 at issuance, then the check before the SELECTs, the check after them, and the final check before return.
  const flipped = (kind: 'selection' | 'state' | 'currentness', callNumber: number) => {
    const calls = { selection: 0, state: 0, currentness: 0 };
    const issuer = createSyntheticPurchaseAccessAuthority(f.db, { ...base, authorityGeneration: `authority-${kind}-${callNumber}`,
      currentSelection: () => { const number = ++calls.selection; return { namespace: SBX_A, generation: kind === 'selection' && number === callNumber ? 'flipped' : 'selection-one' }; },
      accountState: () => { const number = ++calls.state; return { suppressed: kind === 'state' && number === callNumber, epoch: 0, current: true }; },
      currentness: () => { const number = ++calls.currentness; return !(kind === 'currentness' && number === callNumber); } });
    return issuer.forOwner(ACCOUNT_A);
  };
  const expected = { selection: 'selection_changed', state: 'account_unavailable', currentness: 'context_unavailable' } as const;
  for (const kind of ['selection', 'state', 'currentness'] as const) {
    for (const callNumber of [2, 3, 4]) {
      const context = flipped(kind, callNumber);
      const before = snapshot(f.db);
      assert.equal(refusal(() => f.reader.owner(context, '1000')), expected[kind], `${kind} change at check ${callNumber}`);
      assert.equal(snapshot(f.db), before);
      assert.equal(f.db.inTransaction, false, 'a refused read leaves no open transaction');
    }
  }
  // A caller transaction is refused: the reader owns exactly one immediate transaction.
  const context = flipped('selection', 99);
  assert.equal(refusal(() => f.db.transaction(() => f.reader.owner(context, '1000'))()), 'transaction_not_allowed');
  assert.equal(f.db.inTransaction, false);
  // A clock failure is a closed refusal; the reader never invents time.
  for (const bad of [Number.NaN, -1, 1.5, '5', Number.MAX_SAFE_INTEGER * 2, 8640000000000001]) {
    const clock = { now: 1_000_000 as unknown };
    const reader = createQualifiedPurchaseReader(f.db, { use: 'isolated-synthetic', clock: () => clock.now as number });
    assert.ok(reader.owner(context, '1000'));
    clock.now = bad;
    assert.equal(refusal(() => reader.owner(context, '1000')), 'clock_unavailable', String(bad));
  }
  const throwingClock = createQualifiedPurchaseReader(f.db, { use: 'isolated-synthetic', clock: () => { throw new Error('private clock detail'); } });
  assert.equal(refusal(() => throwingClock.owner(context, '1000')), 'clock_unavailable');

  // Schema drift or a stale store makes every previously issued context and every new reader unavailable.
  f.db.exec('CREATE INDEX drift_index ON form_accounts(created_at)');
  assert.equal(refusal(() => f.reader.owner(context, '1000')), 'store_unavailable');
  assert.equal(refusal(() => createQualifiedPurchaseReader(f.db, { use: 'isolated-synthetic', clock: () => f.clock.now })), 'store_unavailable');
  assert.equal(refusal(() => f.reader.owner(context, '1000')), 'store_unavailable');
});

test('readers write nothing: no grant, acknowledgement, claim, work, transition or entitlement ever results from a read', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  const tx = seedTransaction(f.db, SBX_A, { transactionId: '2000', original: '1000', account: ACCOUNT_A });
  seedProofObservation(f.db, SBX_A, tx);
  seedDelivery(f.db, SBX_A, tx, { serverDeliveryId: 'delivery-one', actor: ACCOUNT_A });
  seedReconciliation(f.db, SBX_A, { handle: 'handle-one', original: '1000', actor: ACCOUNT_A });
  seedProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A });
  const context = f.context(ACCOUNT_A, SBX_A);
  const before = snapshot(f.db), bytes = f.db.serialize().toString('base64');
  f.reader.owner(context, '1000'); f.reader.delivery(context, '2000', tx.proofHash); f.reader.reconciliation(context, 'handle-one');
  assert.equal(f.reader.projection(context, '1000').status, 'synthetic_current');
  f.reader.listObservationMetadata(context, { limit: 5 });
  assert.equal(snapshot(f.db), before);
  assert.equal(f.db.serialize().toString('base64'), bytes, 'the database file image is byte-identical after every reader');
  for (const table of ['qualified_apple_grants', 'notification_inbox_claims', 'notification_inbox_work', 'notification_inbox_transitions', 'notification_inbox_operations'])
    assert.equal(count(f.db, table), 0, table);
});

test('issuer replacement and revocation during any reader check invalidate the complete snapshot and cursor', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A });
  seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A });
  const baseline = { use: 'isolated-synthetic' as const, storeId: STORE_ID, generation: STORE_GENERATION,
    configurationRevision: 'config1', policyRevision: 'policy1',
    currentSelection: () => ({ namespace: SBX_A, generation: 'selection-one' }),
    accountState: () => ({ suppressed: false, epoch: 0, current: true }), currentness: () => true };
  const original = f.context(ACCOUNT_A, SBX_A);
  const initial = f.reader.listObservationMetadata(original, { limit: 1 });
  assert.ok(initial.cursor);
  assert.equal(f.reader.listObservationMetadata(original, { limit: 1, cursor: initial.cursor }).records[0]?.sequence, 2);
  const replacement = createSyntheticPurchaseAccessAuthority(f.db, { ...baseline, authorityGeneration: 'authority-two' });
  const fresh = replacement.forOwner(ACCOUNT_A);
  assert.equal(refusal(() => f.reader.owner(original, '1000')), 'context_unavailable');
  assert.equal(refusal(() => f.issuer.forOwner(ACCOUNT_A)), 'context_unavailable');
  assert.equal(refusal(() => f.reader.listObservationMetadata(fresh, { limit: 1, cursor: initial.cursor! })), 'stale_cursor');
  f.issuer.close();
  assert.ok(f.reader.owner(fresh, '1000'));
  const secondPage = f.reader.listObservationMetadata(fresh, { limit: 1 });
  assert.ok(secondPage.cursor);
  const reusedGeneration = createSyntheticPurchaseAccessAuthority(f.db, { ...baseline, authorityGeneration: 'authority-two' });
  assert.equal(refusal(() => f.reader.listObservationMetadata(reusedGeneration.forOwner(ACCOUNT_A),
    { limit: 1, cursor: secondPage.cursor! })), 'stale_cursor');
  for (const phase of [2, 3, 4]) {
    let calls = 0;
    const issuer = createSyntheticPurchaseAccessAuthority(f.db, { ...baseline, authorityGeneration: `guard-${phase}`,
      currentness: () => {
        if (++calls !== phase) return true;
        // The inner checks run under the read lock. The final check also has to catch an actual replacement.
        if (f.db.inTransaction) issuer.close();
        else createSyntheticPurchaseAccessAuthority(f.db, { ...baseline, authorityGeneration: 'final-replacement' });
        return true;
      } });
    const context = issuer.forOwner(ACCOUNT_A);
    assert.equal(refusal(() => f.reader.owner(context, '1000')), 'context_unavailable', `check ${phase}`);
    assert.equal(f.db.inTransaction, false);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Synchronous projection conflict gate over the inbox's exact aggregates
// ---------------------------------------------------------------------------------------------------------------------

const variants = ['synthetic.variant.one', 'synthetic.variant.two'] as const;

for (const order of [[0, 1], [1, 0]] as const) test(`a notification-backed projection is current before and held after a second authenticated variant arrives (${order.join(',')}); the old projection is preserved`, async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  const inbox = f.inbox(), first = await inbox.accept(variants[order[0]], SBX_A, A_UUID);
  const aggregate = aggregateFor(f.db, SBX_A, A_UUID)!;
  assert.equal(aggregate.aggregate_id, first.aggregateId);
  const projected = seedProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'notification_evidence', accepted: first });
  seedDependency(f.db, SBX_A, { original: '1000', revision: projected.revision, aggregateId: aggregate.aggregate_id, version: aggregate.version });
  const context = f.context(ACCOUNT_A, SBX_A);
  assert.deepEqual(f.reader.projection(context, '1000'), { status: 'synthetic_current', namespace: { provider: 'Apple', bundleId: SBX_A.bundleId, environment: 'Sandbox', appAppleId: null },
    selectionGeneration: 'selection-one', revision: 1 });

  const oldRows = JSON.stringify([f.db.prepare('SELECT * FROM qualified_apple_status_projection').all(), f.db.prepare('SELECT * FROM qualified_apple_projection_dependencies').all()]);
  const second = await inbox.accept(variants[order[1]], SBX_A, A_UUID);
  assert.equal(second.result.disposition, 'held_conflict');
  const conflicted = aggregateFor(f.db, SBX_A, A_UUID)!;
  assert.equal(conflicted.conflicted, 1);
  assert.equal(conflicted.invalidation_required, 1);
  const held = f.reader.projection(context, '1000');
  assert.equal(held.status, 'held');
  assert.equal(isHeld(held), 'dependency_conflicted');
  assert.equal(held.status === 'held' && held.revision, 1);
  // The gate is a pure read: the earlier projection and its dependency rows are untouched.
  assert.equal(JSON.stringify([f.db.prepare('SELECT * FROM qualified_apple_status_projection').all(), f.db.prepare('SELECT * FROM qualified_apple_projection_dependencies').all()]), oldRows);

  // Replaying either variant cannot unhold: the inbox keeps the aggregate conflicted and invalidation required.
  for (const payload of variants) {
    const replay = await inbox.accept(payload, SBX_A, A_UUID);
    assert.equal(replay.result.disposition, 'held_conflict');
    assert.equal(isHeld(f.reader.projection(context, '1000')), 'dependency_conflicted');
  }
  assert.equal(aggregateFor(f.db, SBX_A, A_UUID)!.conflicted, 1);
});

test('identical UUIDs in another namespace or environment never affect the selected projection', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, PRD_A, '1000', ACCOUNT_B);
  const inbox = f.inbox();
  const sandbox = await inbox.accept(variants[0], SBX_A, A_UUID), production = await inbox.accept(variants[0], PRD_A, A_UUID);
  assert.notEqual(sandbox.aggregateId, production.aggregateId);
  for (const [namespace, account, original, accepted] of [[SBX_A, ACCOUNT_A, '1000', sandbox], [PRD_A, ACCOUNT_B, '1000', production]] as const) {
    const projected = seedProjection(f.db, namespace, { original, account, provenance: 'notification_evidence', accepted });
    const aggregate = aggregateFor(f.db, namespace, A_UUID)!;
    assert.equal(aggregate.aggregate_id, accepted.aggregateId);
    seedDependency(f.db, namespace, { original, revision: projected.revision, aggregateId: aggregate.aggregate_id, version: aggregate.version });
  }
  const sandboxContext = f.context(ACCOUNT_A, SBX_A), productionContext = f.context(ACCOUNT_B, PRD_A);
  assert.equal(f.reader.projection(sandboxContext, '1000').status, 'synthetic_current');
  assert.equal(f.reader.projection(productionContext, '1000').status, 'synthetic_current');
  // A conflict in production leaves the identical sandbox UUID and lineage id untouched.
  assert.equal((await inbox.accept(variants[1], PRD_A, A_UUID)).result.disposition, 'held_conflict');
  assert.equal(f.reader.projection(sandboxContext, '1000').status, 'synthetic_current');
  assert.equal(isHeld(f.reader.projection(productionContext, '1000')), 'dependency_conflicted');
  assert.equal(aggregateFor(f.db, SBX_A, A_UUID)!.conflicted, 0);
  // The projection of one lineage is invisible to another account's lineage with the same id.
  assert.equal(f.reader.projection(productionContext, '9999').status, 'absent');
  assert.equal(f.reader.projection(f.context(ACCOUNT_B, SBX_A), '1000').status, 'absent');
});

test('a missing, relocated, changed or invalidated aggregate, absent provenance and every stale binding hold the projection with a closed reason', async t => {
  const f = await world(t);
  const inbox = f.inbox();
  const accepted = await inbox.accept(variants[0], SBX_A, A_UUID);
  const aggregate = aggregateFor(f.db, SBX_A, A_UUID)!;
  const lineages: [string, string][] = [];
  const lineage = (original: string, build: (original: string) => void, expected: string) => {
    seedOwner(f.db, SBX_A, original, ACCOUNT_A);
    build(original);
    lineages.push([original, expected]);
  };
  const depends = (original: string, version = aggregate.version) => seedDependency(f.db, SBX_A, { original, revision: 1, aggregateId: aggregate.aggregate_id, version });
  const evidence = (original: string, extra: Partial<Parameters<typeof seedProjection>[2]> = {}) =>
    seedProjection(f.db, SBX_A, { original, account: ACCOUNT_A, provenance: 'notification_evidence', accepted, ...extra });

  lineage('2000', original => { evidence(original); depends(original); }, 'synthetic_current');
  lineage('2001', original => seedProjection(f.db, SBX_A, { original, account: ACCOUNT_A }), 'synthetic_current');
  lineage('2002', original => { evidence(original); }, 'provenance_required');
  lineage('2003', original => {
    seedProjection(f.db, SBX_A, { original, account: ACCOUNT_A });
    assert.throws(() => depends(original), /qualified_apple_projection_dependencies_bound/);
  }, 'synthetic_current');
  lineage('2004', original => { evidence(original, { state: 'pending' }); depends(original); }, 'not_current');
  lineage('2005', original => { evidence(original, { state: 'held' }); depends(original); }, 'not_current');
  lineage('2006', original => { evidence(original, { validUntilMs: null }); depends(original); }, 'expired');
  lineage('2007', original => { evidence(original, { validUntilMs: 1_000_000 }); depends(original); }, 'expired');
  lineage('2008', original => { evidence(original, { lastSeenMs: 1_000_001 }); depends(original); }, 'clock');
  lineage('2009', original => { evidence(original, { epoch: 5 }); depends(original); }, 'binding');
  lineage('2010', original => { evidence(original, { ownerDigest: sha('forged-owner') }); depends(original); }, 'binding');
  lineage('2011', original => { evidence(original, { generation: 'another-generation' }); depends(original); }, 'source_generation');
  lineage('2012', original => { evidence(original, { schemaDigest: sha('stale-schema') }); depends(original); }, 'source_generation');
  lineage('2013', original => { evidence(original, { observedAtMs: 1_500_000 }); depends(original); }, 'observation');
  lineage('2014', original => { evidence(original, { continuityDigest: sha('different-continuity') }); depends(original); }, 'binding');
  lineage('2015', original => { evidence(original, { contentDigest: sha('bad-canonical-content') }); depends(original); }, 'observation');
  const context = f.context(ACCOUNT_A, SBX_A);
  const read = (original: string) => isHeld(f.reader.projection(context, original));
  for (const [original, expected] of lineages) assert.equal(read(original), expected, original);

  // Defects of the referenced inbox aggregate itself. Each is applied, observed and restored independently.
  const mutate = (sql: string, ...params: unknown[]) => f.db.prepare(sql).run(...params);
  const restore = () => { mutate('UPDATE notification_inbox_aggregates SET version=?,namespace_key=?,conflicted=0,invalidation_required=0 WHERE aggregate_id=?', aggregate.version, nsKey(SBX_A), aggregate.aggregate_id); };
  mutate('UPDATE notification_inbox_aggregates SET version=version+1 WHERE aggregate_id=?', aggregate.aggregate_id);
  assert.equal(read('2000'), 'dependency_changed'); restore();
  mutate('UPDATE notification_inbox_aggregates SET namespace_key=? WHERE aggregate_id=?', nsKey(PRD_A), aggregate.aggregate_id);
  assert.equal(read('2000'), 'dependency_namespace'); restore();
  mutate('UPDATE notification_inbox_aggregates SET invalidation_required=1 WHERE aggregate_id=?', aggregate.aggregate_id);
  assert.equal(read('2000'), 'dependency_invalidated'); restore();
  mutate('UPDATE notification_inbox_aggregates SET conflicted=1 WHERE aggregate_id=?', aggregate.aggregate_id);
  assert.equal(read('2000'), 'dependency_conflicted'); restore();
  assert.equal(read('2000'), 'synthetic_current');
  f.db.pragma('foreign_keys = OFF');
  const saved = f.db.prepare('SELECT * FROM notification_inbox_aggregates WHERE aggregate_id=?').get(aggregate.aggregate_id) as Record<string, unknown>;
  mutate('DELETE FROM notification_inbox_aggregates WHERE aggregate_id=?', aggregate.aggregate_id);
  assert.equal(read('2000'), 'dependency_missing');
  f.db.prepare(`INSERT INTO notification_inbox_aggregates(${Object.keys(saved).join(',')}) VALUES(${Object.keys(saved).map(() => '?').join(',')})`).run(...Object.values(saved));
  f.db.pragma('foreign_keys = ON');
  assert.equal(read('2000'), 'synthetic_current');
  assert.equal(f.reader.projection(context, '9999').status, 'absent');
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('an independent reconciled revision excludes conflicted variants, a later notification revision is gated again, and suppression always wins', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  const inbox = f.inbox(), first = await inbox.accept(variants[0], SBX_A, A_UUID);
  const aggregate = aggregateFor(f.db, SBX_A, A_UUID)!;
  const revision1 = seedProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'notification_evidence', accepted: first });
  seedDependency(f.db, SBX_A, { original: '1000', revision: revision1.revision, aggregateId: first.aggregateId, version: aggregate.version });
  const context = f.context(ACCOUNT_A, SBX_A);
  assert.equal(f.reader.projection(context, '1000').status, 'synthetic_current');
  await inbox.accept(variants[1], SBX_A, A_UUID);
  assert.equal(isHeld(f.reader.projection(context, '1000')), 'dependency_conflicted');

  // New independent status evidence supersedes it as revision 2 with no dependency on the conflicted aggregate.
  const relabel = f.db.prepare("UPDATE qualified_apple_status_projection SET revision=2,provenance_kind='independent_status'");
  assert.throws(() => relabel.run(), /qualified_apple_status_projection_bound_update/);
  assert.equal(isHeld(f.reader.projection(context, '1000')), 'dependency_conflicted');
  const independent = advanceProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'independent_status', revision: 2 });
  const reconciled = f.reader.projection(context, '1000');
  assert.equal(reconciled.status, 'synthetic_current');
  assert.equal(reconciled.status === 'synthetic_current' && reconciled.revision, 2);
  assert.equal(count(f.db, 'qualified_apple_projection_dependencies'), 1, 'revision 1 dependency rows are retained as history');

  // Suppression is independent of the gate and of conflicts: a current revision is still unreadable.
  f.accounts.set(ACCOUNT_A.accountId, { suppressed: true, epoch: 0, current: true });
  assert.equal(refusal(() => f.reader.projection(context, '1000')), 'account_unavailable');
  f.accounts.set(ACCOUNT_A.accountId, { suppressed: false, epoch: 0, current: true });
  assert.equal(f.reader.projection(context, '1000').status, 'synthetic_current');

  // A later notification-backed revision that depends on the still-conflicted aggregate is held again.
  const conflicted = aggregateFor(f.db, SBX_A, A_UUID)!;
  advanceProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'notification_evidence', revision: 3, accepted: first });
  seedDependency(f.db, SBX_A, { original: '1000', revision: 3, aggregateId: conflicted.aggregate_id, version: conflicted.version });
  const held = f.reader.projection(context, '1000');
  assert.equal(isHeld(held), 'dependency_conflicted');
  assert.equal(held.status === 'held' && held.revision, 3);
  assert.throws(() => advanceProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'independent_status',
    revision: 4, observation: independent }), /qualified_apple_status_projection_bound_update/);
  // A fourth, independent revision is current again; no cache, sticky flag or replay carried the hold forward.
  advanceProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'independent_status', revision: 4 });
  assert.equal(f.reader.projection(context, '1000').status, 'synthetic_current');
});

test('the exact authenticated notification and its retained bytes must remain available at read time', async t => {
  const f = await world(t);
  seedOwner(f.db, PRD_A, '1000', ACCOUNT_A);
  const inbox = f.inbox(), accepted = await inbox.accept(variants[0], PRD_A, A_UUID);
  const aggregate = aggregateFor(f.db, PRD_A, A_UUID)!;
  const { revision } = seedProjection(f.db, PRD_A, { original: '1000', account: ACCOUNT_A, provenance: 'notification_evidence', accepted });
  seedDependency(f.db, PRD_A, { original: '1000', revision, aggregateId: accepted.aggregateId, version: aggregate.version });
  const context = f.context(ACCOUNT_A, PRD_A);
  const read = () => isHeld(f.reader.projection(context, '1000'));
  assert.equal(read(), 'synthetic_current');
  const uuid = f.db.prepare('UPDATE notification_inbox_aggregates SET notification_uuid=? WHERE aggregate_id=?');
  uuid.run(randomUUID(), accepted.aggregateId);
  assert.equal(read(), 'dependency_evidence');
  uuid.run(A_UUID, accepted.aggregateId);
  const app = f.db.prepare('UPDATE notification_inbox_aggregates SET namespace_json=? WHERE aggregate_id=?');
  app.run(JSON.stringify({ ...PRD_A, appAppleId: 7 }), accepted.aggregateId);
  assert.equal(read(), 'dependency_evidence');
  app.run(JSON.stringify(PRD_A), accepted.aggregateId);
  const auth = f.db.prepare('UPDATE notification_inbox_state SET authentication=? WHERE receipt_id=?');
  auth.run('rejected', accepted.receiptId);
  assert.equal(read(), 'dependency_evidence');
  auth.run('verified', accepted.receiptId);
  const variant = f.db.prepare('SELECT * FROM notification_inbox_variants WHERE receipt_id=?').get(accepted.receiptId) as
    { receipt_id: string; aggregate_id: string; canonical_receipt_id: string };
  f.db.prepare('DELETE FROM notification_inbox_variants WHERE receipt_id=?').run(accepted.receiptId);
  assert.equal(read(), 'dependency_evidence');
  f.db.prepare('INSERT INTO notification_inbox_variants VALUES(?,?,?)').run(variant.receipt_id, variant.aggregate_id, variant.canonical_receipt_id);
  const changeBytes = f.db.prepare('UPDATE notification_inbox_payloads SET bytes=? WHERE receipt_id=?');
  changeBytes.run(Buffer.alloc(accepted.capture.signedPayload.length, 65), accepted.receiptId);
  assert.equal(read(), 'dependency_evidence');
  changeBytes.run(accepted.capture.signedPayload, accepted.receiptId);
  assert.equal(read(), 'synthetic_current');
  inbox.control.now = 15_000;
  assert.equal(inbox.inbox.disposePayload(inbox.caps.dispose, { operationId: randomUUID(), receiptId: accepted.receiptId,
    expectedVersion: accepted.result.version }).status, 'ok');
  assert.equal(aggregateFor(f.db, PRD_A, A_UUID)?.version, aggregate.version);
  assert.equal(read(), 'dependency_evidence');
});

test('latest status, canonical content and distinct restoration cannot bypass an unresolved dispatch', async t => {
  const f = await world(t);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, PRD_A, '2000', ACCOUNT_A);
  const first = seedProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A });
  const context = f.context(ACCOUNT_A, SBX_A);
  const read = () => isHeld(f.reader.projection(context, '1000'));
  assert.equal(read(), 'synthetic_current');
  f.db.prepare("UPDATE qualified_apple_status_projection SET revision=2,projection_state='held'").run();
  assert.throws(() => f.db.prepare("UPDATE qualified_apple_status_projection SET revision=3,projection_state='current'").run(),
    /qualified_apple_status_projection_advancing/);
  const current = advanceProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'independent_status', revision: 3 });
  assert.equal(read(), 'synthetic_current');
  assert.throws(() => f.db.prepare('UPDATE qualified_apple_status_projection SET revision=4,current_observation_id=?,projection_json=?')
    .run(first.observation.id, projectionReference(f.db, SBX_A, first.observation)), /qualified_apple_status_projection_bound_update/);
  assert.throws(() => f.db.prepare("UPDATE qualified_apple_status_projection SET revision=4,projection_json='[]'").run(),
    /qualified_apple_status_projection_bound_update/);
  const latest = seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A });
  assert.equal(read(), 'observation');
  assert.throws(() => advanceProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'independent_status',
    revision: 4, observation: current }), /qualified_apple_status_projection_bound_update/);
  advanceProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'independent_status', revision: 4, observation: latest });
  assert.equal(read(), 'synthetic_current');
  seedProjection(f.db, PRD_A, { original: '2000', account: ACCOUNT_A });
  const dispatch = seedStatusObservation(f.db, PRD_A, { original: '2000', account: ACCOUNT_A, kind: 'dispatch' });
  f.db.prepare("UPDATE qualified_apple_status_projection SET revision=2,active_request_id=?,dispatch_state='unsettled',request_deadline_ms=100 WHERE namespace_key=?")
    .run(dispatch.id, nsKey(PRD_A));
  assert.equal(read(), 'dispatch_unresolved');
  advanceProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'independent_status', revision: 5 });
  assert.equal(read(), 'dispatch_unresolved');
});
