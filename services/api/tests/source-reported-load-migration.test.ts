import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash, integrity, migrate, migrations, openStorage, type Sqlite } from '../src/storage.js';
import { runtimeMigrations, migrationDigests } from '../src/runtime-modules/migrations.js';
import { appendSourceBodyMeasurementMigration, appendSourceReportedLoadMigration, assertSourceReportedLoadHistory,
  selectAccountModuleMigrations } from '../src/integration/account-modules/migrations.js';
import { sourceReportedLoadMigration } from '../src/source-reported-load-migration.js';
import { install } from './integration/account-modules/fixture.js';

const full20 = selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, runtimeMigrations);
const body21 = appendSourceBodyMeasurementMigration(full20);
const source22 = appendSourceReportedLoadMigration(full20), both = appendSourceReportedLoadMigration(body21);
const capability = 'selected-migration-22' as const;
const v1 = ' { "schema": "form.source-performance/v1", "kind":"repetitions", "reps":8, "load": {"kind":"unspecified","basis":"unknown"} } ';
const v2 = (load: unknown = { state: 'knownValue', value: 0, unit: 'lb', basis: 'assistance' }) => JSON.stringify({ schema: 'form.source-performance/v2', kind: 'repetitions', reps: 8, load });
function seed(db: Sqlite): void {
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,1,1)').run('a', 'a', 'a@synthetic.invalid');
  db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run('a', 'a', 'created');
  db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run('exercise', '{}');
  db.prepare('INSERT INTO plans VALUES(?,?,1,0,?,?,?)').run('a', 'plan', '{}', 'created', 'updated');
  db.prepare('INSERT INTO plan_revisions VALUES(?,?,1,?,?)').run('a', 'plan', '{}', 'created');
  db.prepare("INSERT INTO workout_sessions VALUES(?,?,?,1,1,?,'active',?,NULL)").run('a', 'session', 'plan', '{}', 'created');
  db.prepare('INSERT INTO session_occurrences VALUES(?,?,?,?,?,?,?)').run('a', 'session', 'occurrence', 'item', 'exercise', 0, '{}');
  insert(db, v1);
  db.prepare('INSERT INTO set_revisions VALUES(?,?,?,?,?,?)').run('a', 'session', 'set', 1, ' { "historical": [ true, null ] } ', 'created');
}
function insert(db: Sqlite, performance: string | null, id = 'set', number = 1, reps: number | null = null, weight: number | null = null) {
  return db.prepare('INSERT INTO performed_sets VALUES(?,?,?,?,?,1,?,?,\'confirmed\',?,?,?)')
    .run('a', 'session', id, 'occurrence', number, reps, weight, 'created', 'updated', performance);
}
function memory(t: TestContext, upgrade = true) {
  const db = new Database(':memory:'); t.after(() => db.close()); install(db, full20); seed(db);
  if (upgrade) db.transaction(() => db.exec(sourceReportedLoadMigration.sql)).immediate();
  return db;
}
function snapshot(db: Sqlite) {
  return ['performed_sets', 'set_revisions', 'session_occurrences', 'form_migrations'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
async function scratch(run: (root: string, path: string) => Promise<void>) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'source-reported-load-'));
  const cleanup = () => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); };
  const interrupt = () => { cleanup(); process.exit(130); }, terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try { await run(root, join(root, 'synthetic.sqlite')); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); cleanup(); }
}

test('source selector preserves defaults, genuine 1–21 bytes and the reserved Body identity', () => {
  assert.equal(migrations.length, 7); assert.equal(runtimeMigrations.length, 16);
  assert.deepEqual(source22.map(entry => entry.version), [...Array.from({ length: 20 }, (_, i) => i + 1), 22]);
  assert.deepEqual(source22.slice(0, 20), full20); assert.deepEqual(both.slice(0, 21), body21);
  assert.deepEqual(source22.slice(0, 16).map(entry => hash(entry.sql)), migrationDigests);
  assert.ok(Object.isFrozen(source22)); assert.ok(source22.every(Object.isFrozen));
  for (const base of [undefined, full20.slice(0, 19), source22, full20.map(entry => entry.version === 20 ? { ...entry, sql: 'SELECT 1' } : entry)])
    assert.throws(() => appendSourceReportedLoadMigration(base), { code: 'source_reported_load_migration_prerequisites_required' });
  assert.throws(() => appendSourceBodyMeasurementMigration(source22), { code: 'body_measurement_migration_prerequisites_required' });
});

test('migration22 copies v1 performance and every history byte literally, restoring FK/index/history invariants', t => {
  const db = memory(t, false), before = snapshot(db);
  db.transaction(() => db.exec(sourceReportedLoadMigration.sql)).immediate();
  assert.deepEqual(snapshot(db), before); integrity(db);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual((db.pragma('foreign_key_list(set_revisions)') as { table: string }[]).map(row => row.table), ['performed_sets', 'performed_sets', 'performed_sets']);
  assert.throws(() => db.exec("UPDATE set_revisions SET data='{}'"), /immutable_set_history/);
  assert.throws(() => insert(db, v2(), 'duplicate', 1));
  assert.throws(() => db.prepare('INSERT INTO set_revisions VALUES(?,?,?,?,?,?)').run('a', 'session', 'foreign', 1, '{}', 'created'));
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('performed_sets_source_v22','set_revisions_source_v22')").all(), []);
});

test('SQL independently accepts all v2 meanings and rejects malformed, duplicate, extra and NULL escape shapes', t => {
  const db = memory(t);
  for (const basis of ['total', 'perImplement', 'perSide', 'assistance']) for (const unit of ['kg', 'lb']) {
    insert(db, v2({ state: 'knownValue', value: 0, unit, basis }), 'valid', 2);
    db.prepare('DELETE FROM performed_sets WHERE id=?').run('valid');
  }
  for (const load of [{ state: 'unknown', confirmed: true }, ...['bodyweight', 'unloaded', 'timedActivity'].map(reason => ({ state: 'notApplicable', reason }))]) {
    insert(db, v2(load), 'valid', 2); db.prepare('DELETE FROM performed_sets WHERE id=?').run('valid');
  }
  const invalid = ['{', 'null', '[]', '{}', v2(null), v2({ state: 'unknown', confirmed: 1 }), v2({ state: 'unknown' }),
    v2({ state: 'notApplicable' }), v2({ state: 'notApplicable', reason: 'bodyweight', extra: true }),
    ...[null, -1, 501, '1'].map(value => v2({ state: 'knownValue', value, unit: 'kg', basis: 'total' })),
    v2({ state: 'knownValue', value: 1200, unit: 'lb', basis: 'total' }),
    v2({ state: 'knownValue', value: 1, unit: 'kg', basis: 'unspecified' }),
    v2().replace('"value":0', '"value":0,"value":0'), v2().replace('"reps":8', '"reps":8,"reps":8'),
    v2().replace('"state":"knownValue"', '"state":"knownValue","state":"knownValue"'),
    v2().replace('"reps":8', '"reps":null'), v2().replace('"reps":8', '"reps":0'),
    v2().replace('"value":0', '"value":1e999'), v2().replace('"kind":"repetitions"', '"kind":"controlled-practice"'),
    v1.replace('"reps":8', '"reps":8,"reps":8')];
  for (const raw of invalid) assert.throws(() => insert(db, raw, 'invalid', 2), /CHECK constraint/, raw);
  assert.throws(() => insert(db, null, 'null', 2));
  assert.throws(() => insert(db, v2(), 'mixed', 2, 8, 0));
  insert(db, null, 'legacy', 2, 8, 0); integrity(db);
});

test('both Body orders, exact reopen and actual verified backups preserve extension receipts and literal rows', async () => {
  for (const bodyFirst of [false, true]) await scratch(async (_root, path) => {
    const db = new Database(path);
    try {
      install(db, bodyFirst ? body21 : full20); seed(db);
      const before = snapshot(db);
      const backups = await migrate(db, path, bodyFirst ? both : source22, capability);
      assert.equal(backups.length, 1);
      const backup = new Database(backups[0]!, { readonly: true });
      try { integrity(backup); assert.deepEqual(snapshot(backup), before); } finally { backup.close(); }
      const receipt22 = db.prepare('SELECT * FROM form_migrations WHERE version=22').get();
      if (!bodyFirst) {
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='body_manual_measurements'").get(), undefined);
        assert.equal((await migrate(db, path, both, capability)).length, 1);
        assert.deepEqual(db.prepare('SELECT * FROM form_migrations WHERE version=22').get(), receipt22);
      }
      assert.deepEqual(await migrate(db, path, both, capability), []);
      assert.equal((db.prepare('SELECT performance FROM performed_sets WHERE id=?').get('set') as { performance: string }).performance, v1);
      await assert.rejects(migrate(db, path, body21), /Unknown or modified migration history/);
    } finally { db.close(); }
    const reopened = await openStorage(path, both, capability);
    try { assert.deepEqual(reopened.migrationBackups, []); integrity(reopened.db); } finally { reopened.db.close(); }
  });
});

test('missing/forged prerequisites and unselected sparse histories fail before mutation', async () => {
  await scratch(async (_root, path) => {
    const db = new Database(path);
    try {
      install(db, full20); seed(db);
      await assert.rejects(migrate(db, path, source22), /contiguous/);
      const before = snapshot(db);
      await assert.rejects(migrate(db, path, source22.map(entry => entry.version === 22 ? { ...entry, sql: 'SELECT 1' } : entry), capability));
      assert.deepEqual(snapshot(db), before);
      db.prepare('DELETE FROM form_migrations WHERE version=19').run();
      await assert.rejects(migrate(db, path, source22, capability), { code: 'source_reported_load_migration_history_invalid' });
      assert.equal(db.prepare('SELECT * FROM form_migrations WHERE version=22').get(), undefined);
      const receipts = source22.map(entry => ({ version: entry.version, checksum: hash(entry.sql) }));
      for (const wrong of [receipts.slice(1), receipts.map(entry => entry.version === 20 ? { ...entry, checksum: 'forged' } : entry),
        [...receipts, { version: 23, checksum: 'unknown' }], [...receipts, receipts[0]!]])
        assert.throws(() => assertSourceReportedLoadHistory(wrong, true));
    } finally { db.close(); }
  });
});

test('SQL and receipt failure roll back together; the verified preceding backup remains recoverable', async () => {
  await scratch(async (root, path) => {
    const db = new Database(path);
    try {
      install(db, full20); seed(db);
      db.exec("CREATE TRIGGER synthetic_fail_22 BEFORE INSERT ON form_migrations WHEN NEW.version=22 BEGIN SELECT RAISE(ABORT,'synthetic_receipt_failure'); END");
      const before = snapshot(db);
      await assert.rejects(migrate(db, path, source22, capability), /synthetic_receipt_failure/);
      assert.deepEqual(snapshot(db), before); integrity(db);
      assert.throws(() => insert(db, v2(), 'unavailable', 2));
      assert.equal(db.prepare('SELECT * FROM form_migrations WHERE version=22').get(), undefined);
      const backups = readdirSync(join(root, 'backups')); assert.equal(backups.length, 1);
      const restored = new Database(join(root, 'backups', backups[0]!), { readonly: true });
      try { integrity(restored); assert.deepEqual(snapshot(restored), before); } finally { restored.close(); }
    } finally { db.close(); }
  });
});
