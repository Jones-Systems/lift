import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { chmodSync, copyFileSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sqlite } from '../../src/storage.js';
import { assertEmptySource27ForQualifiedPurchases, openSyntheticQualifiedPurchaseStorage, reopenSyntheticQualifiedPurchaseStorage,
  upgradeEmptySyntheticQualifiedPurchaseStorage } from '../../src/purchases/qualified-purchase-preflight.js';
import { configurationFor, emptySource27, inboxPolicy, policy, scratch, storeInput } from './qualified-purchase-fixture.js';

const currentnessRequired = /qualified_purchase_currentness_required/;
const upgradeRejected = /qualified_purchase_upgrade_rejected/;
const freshPathRequired = /qualified_purchase_fresh_path_required/;
const extensionObjects = (db: Sqlite) => db.prepare("SELECT name FROM main.sqlite_schema WHERE name GLOB 'qualified_apple_*' OR name GLOB 'notification_inbox_*'").all();
const fileState = (path: string) => ({ bytes: readFileSync(path), mode: lstatSync(path).mode & 0o777 });

test('attestation in every install phase receives no SQL handle and rejects attempts to use one', async t => {
  for (const phase of ['before-backup', 'after-backup', 'under-lock'] as const) {
    for (const sql of phase === 'under-lock' ? ['COMMIT', 'CREATE TABLE synthetic_escape (id)'] : ['BEGIN', 'SAVEPOINT synthetic_escape']) {
      await t.test(`${phase}: ${sql}`, async subtest => {
        const { db, path } = await emptySource27(subtest);
        const before = db.serialize();
        const currentness = { generation: 'currentness1', check: (state: { phase: string }) => {
          if (state.phase === phase) (Reflect.get(state, 'db') as Sqlite).exec(sql);
          return true;
        } };
        await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(db, path, storeInput({ currentness })), currentnessRequired);
        assert.equal(db.inTransaction, false);
        assert.deepEqual(db.serialize(), before);
      });
    }
  }

  for (const phase of ['before-backup', 'under-lock'] as const) {
    await t.test(`fresh: ${phase}`, async subtest => {
      const s = scratch(subtest);
      const currentness = { generation: 'currentness1', check: (state: { phase: string }) => {
        if (state.phase === phase) (Reflect.get(state, 'db') as Sqlite).exec(phase === 'under-lock' ? 'COMMIT' : 'BEGIN');
        return true;
      } };
      const pending = openSyntheticQualifiedPurchaseStorage(s.path(), storeInput({ currentness })).then(storage => s.track(storage.db));
      await assert.rejects(pending, currentnessRequired);
      const db = s.track(new Database(s.path(), { fileMustExist: true }));
      assert.deepEqual(extensionObjects(db), []);
      assertEmptySource27ForQualifiedPurchases(db);
    });
  }
});

test('upgrade refuses a transaction started by the borrower and leaves it in the borrower’s custody', async t => {
  for (const phase of ['before-backup', 'after-backup'] as const) {
    const { db, path } = await emptySource27(t);
    const before = db.serialize();
    const currentness = { generation: 'currentness1', check: (state: { phase: string }) => {
      if (state.phase === phase) db.exec('BEGIN');
      return true;
    } };
    await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(db, path, storeInput({ currentness })), upgradeRejected);
    assert.equal(db.inTransaction, true);
    assert.deepEqual(db.serialize(), before);
    db.exec('ROLLBACK');
  }
});

test('lost immediate transaction ownership cannot install or roll back the replacement transaction', async t => {
  for (const replacement of [false, true]) {
    const { db, path } = await emptySource27(t);
    const before = db.serialize();
    const currentness = { generation: 'currentness1', check: (state: { phase: string }) => {
      if (state.phase === 'under-lock') db.exec(replacement ? 'COMMIT; BEGIN' : 'COMMIT');
      return true;
    } };
    await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(db, path, storeInput({ currentness })), upgradeRejected);
    assert.equal(db.inTransaction, replacement);
    assert.deepEqual(db.serialize(), before);
    if (replacement) db.exec('ROLLBACK');
  }
});

test('upgrade binds frozen attestation metadata and installs the input snapshot taken before backup', async t => {
  const { db, path } = await emptySource27(t);
  const before = db.serialize();
  const configuration = configurationFor();
  const configured = structuredClone(configuration);
  const qualifiedPolicy = structuredClone(policy);
  const inbox = { ingress: 'fixture', policy: structuredClone(inboxPolicy) };
  const inboxSnapshot = structuredClone(inbox.policy);
  const attested: object[] = [];
  const currentness = { generation: 'original-check', check: (state: { phase: string }) => { attested.push(state); return true; } };

  const pending = upgradeEmptySyntheticQualifiedPurchaseStorage(db, path, storeInput({ configuration, currentness, inbox, policy: qualifiedPolicy }));
  configuration.namespaces[0]!.namespace.bundleId = 'com.synthetic.swapped';
  qualifiedPolicy.retention.evidenceMs = 1;
  inbox.ingress = 'swapped';
  Reflect.set(inbox.policy, 'maxPageSize', 123);
  Reflect.set(inbox.policy.retention, 'payloadMs', 1);
  currentness.generation = 'swapped-check';
  currentness.check = () => false;

  const storage = await pending;
  assert.equal(storage.ownership, 'borrowed');
  if (storage.ownership !== 'borrowed') throw new Error('Expected borrowed storage');
  const backup = new Database(storage.backups[0]!, { readonly: true, fileMustExist: true });
  try {
    // SQLite backup updates the 100-byte database header. Compare all page content and full receipt rows.
    assert.deepEqual(backup.serialize().subarray(100), before.subarray(100));
    const receipts = (handle: Sqlite) => handle.prepare('SELECT * FROM main.form_migrations ORDER BY version').all();
    assert.deepEqual(receipts(backup), receipts(db));
  } finally { backup.close(); }
  const store = db.prepare('SELECT configuration_json,policy_json FROM main.qualified_apple_store').get() as { configuration_json: string; policy_json: string };
  assert.deepEqual(JSON.parse(store.configuration_json), configured);
  assert.deepEqual(JSON.parse(store.policy_json), policy);
  assert.deepEqual(db.prepare('SELECT ingress,policy_json FROM main.notification_inbox_store').get(), {
    ingress: 'fixture', policy_json: JSON.stringify(inboxSnapshot),
  });
  assert.deepEqual(attested, ['before-backup', 'after-backup', 'under-lock'].map(phase => ({
    storeId: storage.storeId, generation: storage.generation, currentnessGeneration: 'original-check', phase,
  })));
  assert.ok(attested.every(Object.isFrozen));
});

test('temp tables and views cannot hide populated main tables or substitute for main receipts', async t => {
  const { db } = await emptySource27(t);
  db.exec("INSERT INTO main.verification VALUES ('fixture', 'owner', 'synthetic', 1, 1, 1)");
  for (const kind of ['TABLE', 'VIEW']) {
    db.exec(`CREATE TEMP ${kind} verification ${kind === 'TABLE' ? '(id)' : 'AS SELECT 1 WHERE 0'}`);
    assert.throws(() => assertEmptySource27ForQualifiedPurchases(db), { cause: 'populated:verification' });
    db.exec(`DROP ${kind} temp.verification`);
  }
  db.exec('CREATE TEMP TABLE form_migrations AS SELECT * FROM main.form_migrations; DELETE FROM main.form_migrations WHERE version=27');
  assert.throws(() => assertEmptySource27ForQualifiedPurchases(db), { cause: 'history' });
  assert.equal(db.prepare('SELECT count(*) FROM temp.form_migrations').pluck().get(), 27);
});

test('fresh path publication refuses a concurrently created valid Source27 file byte for byte', async t => {
  const original = await emptySource27(t);
  original.db.close();
  const s = scratch(t);
  const pending = openSyntheticQualifiedPurchaseStorage(s.path(), storeInput()).then(storage => s.track(storage.db));
  copyFileSync(original.path, s.path());
  chmodSync(s.path(), 0o640);
  const before = fileState(s.path());
  await assert.rejects(pending, freshPathRequired);
  assert.deepEqual(fileState(s.path()), before);
  assert.ok(!readdirSync(s.root).some(name => /-(?:wal|shm|journal)$/.test(name)));
});

test('upgrade refuses a pathname replaced during backup and preserves the original and replacement', async t => {
  const { db, path, root } = await emptySource27(t);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const before = db.serialize();
  const moved = join(root, 'moved.sqlite');
  const pending = upgradeEmptySyntheticQualifiedPurchaseStorage(db, path, storeInput());
  renameSync(path, moved);
  copyFileSync(moved, path);
  const movedBefore = fileState(moved), replacement = fileState(path);
  await assert.rejects(pending, upgradeRejected);
  assert.deepEqual(db.serialize(), before);
  assert.deepEqual(fileState(moved), movedBefore);
  assert.deepEqual(fileState(path), replacement);
});

test('reopen leaves mode, bytes and sidecars intact on refusal and preserves a valid store', async t => {
  const s = scratch(t);
  const unrelated = s.track(new Database(s.path('unrelated.sqlite')));
  unrelated.exec('CREATE TABLE unrelated (value); INSERT INTO unrelated VALUES (1)');
  unrelated.close();
  const unrelatedPath = s.path('unrelated.sqlite');
  chmodSync(unrelatedPath, 0o640);
  const unrelatedBefore = fileState(unrelatedPath);
  assert.throws(() => reopenSyntheticQualifiedPurchaseStorage(unrelatedPath, storeInput()));
  assert.deepEqual(fileState(unrelatedPath), unrelatedBefore);

  const path = s.path();
  const storage = await openSyntheticQualifiedPurchaseStorage(path, storeInput());
  s.track(storage.db);
  assert.equal(storage.ownership, 'owned');
  if (storage.ownership !== 'owned') throw new Error('Expected owned storage');
  storage.close();
  chmodSync(path, 0o640);
  const before = fileState(path);
  const names = readdirSync(s.root).sort();
  const currentness = { generation: 'currentness1', check: () => false };
  assert.throws(() => reopenSyntheticQualifiedPurchaseStorage(path, storeInput({ currentness })), currentnessRequired);
  assert.throws(() => reopenSyntheticQualifiedPurchaseStorage(path, storeInput({ storeId: 'foreign-store' })), /qualified_purchase_held/);
  assert.deepEqual(fileState(path), before);
  assert.deepEqual(readdirSync(s.root).sort(), names);

  const reopened = reopenSyntheticQualifiedPurchaseStorage(path, storeInput());
  try {
    assert.equal(reopened.db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(reopened.db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(reopened.db.pragma('synchronous', { simple: true }), 2);
  } finally { if (reopened.ownership === 'owned') reopened.close(); }
  assert.deepEqual(fileState(path), before);

  writeFileSync(`${path}-journal`, 'synthetic sidecar');
  const sidecar = fileState(`${path}-journal`);
  assert.throws(() => reopenSyntheticQualifiedPurchaseStorage(path, storeInput()));
  assert.deepEqual(fileState(`${path}-journal`), sidecar);
  assert.deepEqual(fileState(path), before);
});
