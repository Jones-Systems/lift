import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Domain } from '../../../src/domain.js';
import { hash, migrations, type Sqlite } from '../../../src/storage.js';
import { lifecycleMigration } from '../../../src/lifecycle/migration.js';
import { bindSuppressionAuthority } from '../../../src/lifecycle/guards.js';
import { AccountLifecycle, lifecyclePolicy } from '../../../src/lifecycle/service.js';
import { buildAccountExport } from '../../../src/lifecycle/export.js';
import type { AccountContext, DisableRecord, LifecycleAdapter, SuppressionLedger } from '../../../src/lifecycle/types.js';
import { createCanonicalAccountWriter, type CanonicalAccountWriter } from '../../../src/integration/account-modules/canonical-writer.js';
import { createSqliteAuthStateStore } from '../../../src/wearables/direct-provider-transport/sqlite-auth-store.js';
import { createProviderAuthLifecycle } from '../../../src/wearables/direct-provider-transport/auth-lifecycle.js';
import { authStateKey } from '../../../src/wearables/direct-provider-transport/auth-state.js';
import { providerAuthStateSql } from '../../../src/wearables/direct-provider-transport/auth-store-schema.js';
import type { AuthStateRecord, AuthStateTransaction, DurableAuthStateStore } from '../../../src/wearables/direct-provider-transport/auth-state-types.js';
import { createWearablePersistence, wearablePersistenceSql } from '../../../src/wearables/persistence/index.js';

type Fixture = { db: Sqlite; writer: CanonicalAccountWriter; actor: AccountContext; other: AccountContext;
  ledger: SuppressionLedger; records: Map<string, DisableRecord>; store: DurableAuthStateStore;
  adapter: LifecycleAdapter; wearable: ReturnType<typeof createWearablePersistence>;
  disable: (epoch?: number, sequence?: number) => void };
function fixture(t: TestContext): Fixture {
  const db: Sqlite = new Database(':memory:'); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  for (const migration of migrations) db.exec(migration.sql);
  db.exec(lifecycleMigration.sql); db.exec(providerAuthStateSql); db.exec(wearablePersistenceSql);
  const records = new Map<string, DisableRecord>();
  let sequence = 0;
  const ledger: SuppressionLedger = { currentSequence: () => sequence, lookup: id => records.get(id) ?? null,
    reconcileRestore: apply => { for (const value of records.values()) apply(value); return sequence; },
    recordDisable: input => { const record = { ...input, sequence: ++sequence }; records.set(input.accountId, record); return record; } };
  bindSuppressionAuthority(db, ledger);
  const domain = new Domain(db);
  const actors = ['one', 'two'].map(id => {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id, id, id + '@synthetic.invalid', Date.now(), Date.now());
    const accountId = domain.account(id, id);
    db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(id, id, 'synthetic-' + id, Date.now() + 600000, Date.now(), Date.now());
    return { accountId, authUserId: id, sessionId: id, epoch: 0 } satisfies AccountContext;
  });
  const actor = actors[0]!, other = actors[1]!;
  const writer = createCanonicalAccountWriter(db), store = createSqliteAuthStateStore(writer.authStoreOptionsFor(actor));
  const lifecycleStore = createSqliteAuthStateStore(writer.lifecycleStoreOptions);
  const adapter = writer.guardLifecycleAdapter(createProviderAuthLifecycle({ store: lifecycleStore,
    assertAccountCurrent: writer.assertAccountCurrent, assertSuppression: writer.assertSuppression, purgeReadiness: writer.purgeReadiness }));
  const wearable = createWearablePersistence({ db, lifecycle: writer.lifecycle, control: writer,
    assertImportAllowed: () => { throw Error('No import consent supplied by this fixture'); } });
  return { db, writer, actor, other, ledger, records, store, adapter, wearable, disable(epoch = 1, seq = 1) {
    const record = ledger.recordDisable({ accountId: actor.accountId, authUserId: actor.authUserId, epoch, requestId: 'synthetic', disabledAtMs: 1 });
    if (record.sequence !== seq) records.set(actor.accountId, { ...record, sequence: seq });
    db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=?,disabled_at_ms=1,suppression_seq=? WHERE account_id=?").run(epoch, seq, actor.accountId);
    db.prepare('DELETE FROM session WHERE userId=?').run(actor.authUserId);
  } };
}
function record(actor: AccountContext, connectionId = 'a', epoch = actor.epoch): AuthStateRecord {
  const scope = { accountId: actor.accountId, sessionId: actor.sessionId, epoch, connectionId, generation: 1, provider: 'oura' as const };
  return { schema: 1, key: authStateKey(scope), revision: 0, scope, suppressedEpoch: null, flows: [], operations: [], tokens: null };
}
const authRows = (db: Sqlite) => db.prepare('SELECT record_key,data FROM wearable_provider_auth_state ORDER BY record_key').all();
function confirm(f: Fixture): void {
  const service = new AccountLifecycle(f.db, [f.adapter], f.ledger);
  const requestId = randomUUID(), grant = 'g'.repeat(43);
  service.initiate(f.actor, 'synthetic-delete', { requestId, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account', statusSecret: 's'.repeat(43) });
  f.db.prepare('INSERT INTO account_action_grants VALUES(?,?,?,?,?,?,?,?,NULL)').run(hash(grant), f.actor.accountId, f.actor.sessionId,
    f.actor.epoch, 'account_delete', 'password', Date.now(), Date.now() + 600000);
  service.confirm(f.actor, requestId, { grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' });
}

test('constructor installs no schema and ambient transactions never admit a writer', t => {
  const db: Sqlite = new Database(':memory:'); t.after(() => db.close());
  createCanonicalAccountWriter(db); assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(), []);
  const f = fixture(t), options = f.writer.authStoreOptionsFor(f.actor);
  assert.throws(() => f.writer.assertWithinWrite(f.actor), /canonical_writer_unproved/);
  f.db.transaction(() => {
    assert.throws(() => f.writer.assertWithinWrite(f.actor), /canonical_writer_unproved/);
    assert.throws(() => options.assertRootWriter(f.db), /canonical_writer_unproved/);
    assert.throws(() => f.writer.lifecycleStoreOptions.runRootWrite(() => 1), /canonical_writer_unproved/);
    assert.throws(() => f.store.currentTransaction(), /provider_auth_store_unavailable/);
  }).immediate();
});
test('private frames bind all actor fields and exact database and restore after nested failure', t => {
  const f = fixture(t), otherDb: Sqlite = new Database(':memory:'); t.after(() => otherDb.close());
  const independent = createCanonicalAccountWriter(f.db), options = f.writer.authStoreOptionsFor(f.actor);
  f.writer.lifecycle.withActiveWrite(f.actor, () => {
    options.assertRootWriter(f.db);
    assert.throws(() => options.assertRootWriter(otherDb), /canonical_writer_unproved/);
    assert.throws(() => independent.assertWithinWrite(f.actor), /canonical_writer_unproved/);
    for (const change of [{ accountId: f.other.accountId }, { authUserId: f.other.authUserId }, { sessionId: f.other.sessionId }, { epoch: 1 }])
      assert.throws(() => f.writer.assertWithinWrite({ ...f.actor, ...change }), /canonical_writer_unproved/);
    assert.throws(() => f.writer.lifecycle.withActiveWrite(f.other, () => 1), /canonical_writer_unproved/);
    assert.throws(() => f.writer.lifecycle.withActiveWrite(f.actor, () => { throw Error('nested'); }), /nested/);
    f.writer.assertWithinWrite(f.actor);
  });
  assert.throws(() => options.assertRootWriter(f.db), /canonical_writer_unproved/);
});
test('promise and custom thenable effects roll back auth and actual wearable writes together', t => {
  const f = fixture(t), value = record(f.actor);
  for (const result of [Promise.resolve(1), { then() {} }]) {
    assert.throws(() => f.writer.lifecycle.withActiveWrite(f.actor, () => {
      f.wearable.store.putConnection(f.actor, { id: 'synthetic', provider: 'oura', generation: 1, connected: false,
        types: [], consentVersion: 'synthetic-not-consent', retentionConsent: false, lastImportAt: null });
      f.store.transaction(tx => assert.equal(tx.compareAndSwap(value.key, null, value), true));
      return result;
    }), /canonical_writer_requires_synchronous_effect/);
    assert.deepEqual(authRows(f.db), []); assert.deepEqual(f.wearable.store.connections(f.actor), []);
    assert.throws(() => f.writer.assertWithinWrite(f.actor), /canonical_writer_unproved/);
  }
});
test('retained auth transactions expire after the frame and original session cannot switch implicitly', async t => {
  const f = fixture(t); let retained: AuthStateTransaction | undefined;
  const mutable = { ...f.actor }, options = f.writer.authStoreOptionsFor(mutable);
  mutable.sessionId = f.other.sessionId;
  options.runRootWrite(() => { retained = f.store.currentTransaction(); f.writer.assertWithinWrite(f.actor); });
  await Promise.resolve();
  assert.throws(() => retained!.listAccount(f.actor.accountId, 1), /provider_auth_store_unavailable/);
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.actor.sessionId);
  assert.throws(() => options.runRootWrite(() => 1), /account_session_invalid/);
});
test('active inventory and actual account export admit the same original actor and preserve the outer snapshot', t => {
  const f = fixture(t), value = record(f.actor);
  f.store.transaction(tx => tx.compareAndSwap(value.key, null, value));
  assert.equal(f.adapter.inventory(f.actor).count, 1);
  const exported = buildAccountExport(f.db, f.actor, f.writer.lifecycle.assertActive, [f.adapter]);
  assert.match(exported.json, /direct_provider_auth/); assert.match(exported.json, /recordCount/);
  assert.equal(f.db.inTransaction, false);
  assert.throws(() => f.writer.assertAccountCurrent(f.actor), /canonical_writer_unproved/);
  const wrong = f.writer.guardLifecycleAdapter({ ...f.adapter, inventory: context => {
    f.writer.assertAccountCurrent({ ...context, sessionId: f.other.sessionId }); return { status: 'complete', category: 'wrong' };
  } });
  assert.throws(() => wrong.inventory(f.actor), /canonical_writer_unproved/);
});
test('actual lifecycle confirmation suppresses auth records after deleting the original session', t => {
  const f = fixture(t), value = record(f.actor);
  f.store.transaction(tx => tx.compareAndSwap(value.key, null, value)); confirm(f);
  assert.equal(f.db.prepare('SELECT id FROM session WHERE id=?').get(f.actor.sessionId), undefined);
  const stored = JSON.parse((authRows(f.db)[0] as { data: string }).data) as AuthStateRecord;
  assert.equal(stored.suppressedEpoch, 1); assert.equal(stored.revision, 1);
  f.db.transaction(() => assert.equal(f.adapter.verifySuppressed(f.actor.accountId, 1).status, 'complete')).immediate();
  assert.throws(() => f.writer.assertSuppression(f.actor.accountId, 1), /canonical_writer_unproved/);
  assert.throws(() => f.store.transaction(() => 1), /provider_auth_store_unavailable/);
});
test('suppression requires existing root transaction and matching ledger epoch and sequence before and after hook', t => {
  const f = fixture(t); f.disable();
  assert.throws(() => f.adapter.suppress(f.actor.accountId, 1), /canonical_writer_unproved/);
  f.db.transaction(() => {
    assert.throws(() => f.writer.assertSuppression(f.actor.accountId, 1), /canonical_writer_unproved/);
    assert.throws(() => f.adapter.suppress(f.actor.accountId, 2), /canonical_writer_unproved/);
    const original = f.records.get(f.actor.accountId)!;
    f.records.set(f.actor.accountId, { ...original, sequence: original.sequence + 1 });
    assert.throws(() => f.adapter.suppress(f.actor.accountId, 1), /canonical_writer_unproved/);
    f.records.set(f.actor.accountId, original);
    const changed = f.writer.guardLifecycleAdapter({ ...f.adapter, suppress: () => {
      f.records.set(f.actor.accountId, { ...original, sequence: original.sequence + 1 }); return { status: 'complete' };
    } });
    assert.throws(() => changed.suppress(f.actor.accountId, 1), /canonical_writer_unproved/);
    f.records.set(f.actor.accountId, original);
    assert.equal(f.adapter.suppress(f.actor.accountId, 1).status, 'complete');
  }).immediate();
});
test('caught suppression hook failure rolls back partial auth changes through the existing store savepoint', t => {
  const f = fixture(t), one = record(f.actor, 'a'), two = record(f.actor, 'z', 1);
  f.store.transaction(tx => { tx.compareAndSwap(one.key, null, one); tx.compareAndSwap(two.key, null, two); });
  const before = authRows(f.db); confirm(f);
  assert.deepEqual(authRows(f.db), before);
  assert.equal((f.db.prepare('SELECT state FROM account_lifecycle WHERE account_id=?').get(f.actor.accountId) as { state: string }).state, 'disabled');
  assert.equal((f.db.prepare("SELECT status FROM account_deletion_steps WHERE category='direct_provider_auth'").get() as { status: string }).status, 'unknown');
});
test('purge remains unavailable without invoking any component destructive executor', t => {
  const f = fixture(t), value = record(f.actor);
  f.store.transaction(tx => tx.compareAndSwap(value.key, null, value));
  let called = 0;
  const adapter = f.writer.guardLifecycleAdapter({ ...f.adapter, purge: () => { called++; f.db.exec('DELETE FROM wearable_provider_auth_state'); return { status: 'complete' }; } });
  const before = authRows(f.db);
  assert.deepEqual(adapter.purge('synthetic-request', f.actor.accountId), { status: 'unavailable', reason: 'exact_purge_executor_binding_required' });
  assert.deepEqual(f.writer.purgeReadiness('synthetic-request', f.actor.accountId), adapter.purge('synthetic-request', f.actor.accountId));
  assert.equal(called, 0); assert.deepEqual(authRows(f.db), before);
});
