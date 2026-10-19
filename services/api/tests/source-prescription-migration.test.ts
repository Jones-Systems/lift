import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, integrity, migrate, openStorage, type Sqlite } from '../src/storage.js';
import { runtimeMigrations, migrationDigests } from '../src/runtime-modules/migrations.js';
import { selectAccountModuleMigrations, sourceProgressComparisonMigration, sourceFeedbackMigration,
  type SourceAccountModuleConfiguration } from '../src/integration/account-modules/migrations.js';
import { sourcePrescriptionMigration } from '../src/source-prescription-migration.js';

const legacy = selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-and-training-feedback' }, runtimeMigrations);
const selection = { mode: 'source-only', modules: 'usage-bug-training-feedback-and-source-prescription' } as const;
const selected = selectAccountModuleMigrations(selection, runtimeMigrations);
const load = { kind: 'unspecified', basis: 'unknown' } as const;
const repetitions = (reps = 8) => ({ schema: 'form.source-performance/v1', kind: 'repetitions', reps, load });
const practice = () => ({ schema: 'form.source-performance/v1', kind: 'controlled-practice', load });

function installLegacy(db: Sqlite): void {
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    db.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const entry of legacy) {
      db.exec(entry.sql);
      db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(entry.version, hash(entry.sql), `legacy-${entry.version}`);
    }
  }).immediate();
}
function seed(db: Sqlite): void {
  db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run('exercise', '{ "id": "exercise" }');
  for (const account of ['a', 'b']) {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,1,2)')
      .run(account, account, `${account}@synthetic.invalid`);
    db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(account, account, 'account-created');
    db.prepare('INSERT INTO plans VALUES(?,?,1,0,?,?,?)').run(account, 'plan', '{ "items": [] }', 'plan-created', 'plan-updated');
    db.prepare('INSERT INTO plan_revisions VALUES(?,?,1,?,?)').run(account, 'plan', '{ "items": [] }', 'plan-history');
    db.prepare("INSERT INTO workout_sessions VALUES(?,?,?,1,3,?,'active',?,NULL)")
      .run(account, 'session', 'plan', '{ "unchanged": true }', 'session-started');
    for (let i = 0; i < 4; i++) db.prepare('INSERT INTO session_occurrences VALUES(?,?,?,?,?,?,?)')
      .run(account, 'session', `occurrence-${i}`, `item-${i}`, 'exercise', i, '{ "targetKg": 0 }');
    for (const [index, status] of ['draft', 'confirmed', 'voided'].entries()) {
      db.prepare('INSERT INTO performed_sets VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(account, 'session', `set-${index}`, 'occurrence-0', index + 1, index + 2,
          index === 0 ? 0 : 100, index === 2 ? 500 : 0, status, 'set-created', 'set-updated');
      for (let revision = 1; revision <= index + 2; revision++) db.prepare('INSERT INTO set_revisions VALUES(?,?,?,?,?,?)')
        .run(account, 'session', `set-${index}`, revision, ` { "reps": ${revision}, "unchanged" : [ null, true ] } `, 'audit-created');
    }
  }
}
function memory(t: TestContext, upgraded = true): Sqlite {
  const db = new Database(':memory:'); t.after(() => db.close());
  installLegacy(db); seed(db);
  if (upgraded) db.transaction(() => db.exec(sourcePrescriptionMigration.sql)).immediate();
  return db;
}
const tables = ['performed_sets', 'set_revisions', 'plans', 'plan_revisions', 'workout_sessions', 'session_occurrences', 'form_migrations'] as const;
function snapshot(db: Sqlite) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function withoutPerformance(db: Sqlite) {
  const current = snapshot(db);
  current.performed_sets = (current.performed_sets as Record<string, unknown>[]).map(({ performance, ...row }) => {
    assert.equal(performance, null); return row;
  });
  return current;
}
function insert(db: Sqlite, performance: string | null, overrides: Record<string, unknown> = {}) {
  return db.prepare(`INSERT INTO performed_sets
    (account_id,session_id,id,occurrence_id,set_number,revision,reps,weight_kg,status,created_at,updated_at,performance)
    VALUES(@account,@session,@id,@occurrence,@number,@revision,@reps,@weight,@status,@created,@updated,@performance)`)
    .run({ account: 'a', session: 'session', id: 'new', occurrence: 'occurrence-0', number: 99, revision: 1,
      reps: null, weight: null, status: 'confirmed', created: 'new-created', updated: 'new-updated', performance, ...overrides });
}
function assertSchema(db: Sqlite): void {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []); integrity(db);
  assert.deepEqual((db.pragma('foreign_key_list(set_revisions)') as { table: string }[]).map(row => row.table),
    ['performed_sets', 'performed_sets', 'performed_sets']);
  assert.deepEqual((db.pragma('index_info(confirmed_sets)') as { name: string }[]).map(row => row.name), ['account_id', 'status', 'session_id']);
  assert.throws(() => db.exec("UPDATE set_revisions SET data='{}' WHERE account_id='a'"), /immutable_set_history/);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('performed_sets_source_v19','set_revisions_source_v19')").all(), []);
}

test('explicit source prescription selector preserves authentic frozen 1–18 and leaves existing selectors/runtime unchanged', () => {
  assert.equal(runtimeMigrations.length, 16); assert.equal(legacy.length, 18); assert.equal(selected.length, 19);
  assert.deepEqual(selected.slice(0, 18), legacy);
  assert.deepEqual(selected.slice(0, 16).map(entry => hash(entry.sql)), migrationDigests);
  assert.deepEqual(selected.slice(16), [sourceProgressComparisonMigration, sourceFeedbackMigration, sourcePrescriptionMigration]);
  assert.deepEqual(selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-and-bug-intake' }, runtimeMigrations), runtimeMigrations);
  assert.ok(Object.isFrozen(selected)); assert.ok(selected.every(Object.isFrozen));
  for (const base of [undefined, runtimeMigrations.slice(0, 15), legacy,
    runtimeMigrations.map(entry => entry.version === 16 ? { ...entry, sql: 'SELECT 1;' } : entry)]) {
    assert.throws(() => selectAccountModuleMigrations(selection, base), { code: 'account_modules_migration_prerequisites_required' });
  }
  for (const invalid of [{ ...selection, mode: 'runtime' }, { ...selection, modules: 'source-prescription' }, { ...selection, enabled: true }]) {
    assert.throws(() => selectAccountModuleMigrations(invalid as unknown as SourceAccountModuleConfiguration, runtimeMigrations),
      { code: 'account_modules_configuration_invalid' });
  }
});

test('transactional parent/child rebuild preserves both accounts and every legacy value and audit JSON byte', t => {
  const db = memory(t, false), before = snapshot(db);
  db.transaction(() => db.exec(sourcePrescriptionMigration.sql)).immediate();
  assert.deepEqual(withoutPerformance(db), before); assertSchema(db);
  assert.throws(() => db.prepare('INSERT INTO set_revisions VALUES(?,?,?,?,?,?)').run('a', 'session', 'absent', 1, '{}', 'now'), /FOREIGN KEY/);
  assert.throws(() => db.prepare('INSERT INTO set_revisions VALUES(?,?,?,?,?,?)').run('a', 'session', 'set-0', 1, '{}', 'now'), /UNIQUE constraint/);
  assert.throws(() => db.prepare('INSERT INTO set_revisions VALUES(?,?,?,?,?,?)').run('a', 'session', 'set-0', 9, '{', 'now'), /CHECK constraint/);
  assert.throws(() => db.exec("DELETE FROM performed_sets WHERE account_id='a' AND id='set-0'"), /FOREIGN KEY/);
});

test('legacy performance NULL retains ranges, required values, status, keys and occurrence foreign keys', t => {
  const db = memory(t);
  insert(db, null, { id: 'legacy-new', reps: 1, weight: 0 });
  for (const invalid of [{ reps: null }, { weight: null }, { reps: -1 }, { reps: 101 }, { weight: -1 }, { weight: 501 },
    { reps: 0 }, { revision: 0 }, { number: 0 }, { number: 101 }, { status: 'complete' }, { created: null }, { updated: null },
    { occurrence: 'missing' }, { number: 1 }, { id: 'set-0', number: 98 }]) {
    assert.throws(() => insert(db, null, { reps: 8, weight: 20, number: 98, ...invalid }), /constraint failed/);
  }
  insert(db, null, { id: 'draft-zero', number: 97, reps: 0, weight: 500, status: 'draft' });
  insert(db, null, { id: 'voided-zero', number: 96, reps: 0, weight: 0, status: 'voided' });
  assertSchema(db);
});

test('six repetition and two controlled-practice records persist across four occurrences without invented weights or practice reps', t => {
  const db = memory(t);
  for (let i = 0; i < 8; i++) insert(db, JSON.stringify(i < 6 ? repetitions(i + 1) : practice()),
    { id: `source-${i}`, occurrence: `occurrence-${i % 4}`, number: i + 10 });
  const rows = db.prepare('SELECT occurrence_id,reps,weight_kg,performance,status FROM performed_sets WHERE performance IS NOT NULL ORDER BY id')
    .all() as { occurrence_id: string; reps: null; weight_kg: null; performance: string; status: string }[];
  assert.equal(rows.length, 8); assert.equal(new Set(rows.map(row => row.occurrence_id)).size, 4);
  for (const [i, row] of rows.entries()) {
    assert.equal(row.reps, null); assert.equal(row.weight_kg, null); assert.equal(row.status, 'confirmed');
    assert.deepEqual(JSON.parse(row.performance), i < 6 ? repetitions(i + 1) : practice());
  }
  assertSchema(db);
});

test('source payloads reject missing, unknown, mixed, duplicate and malformed JSON fields without SQLite NULL-check escapes', t => {
  const db = memory(t);
  const invalid: unknown[] = [null, [], 0, true, 'text', {}, { ...practice(), schema: undefined }, { ...practice(), schema: null },
    { ...practice(), schema: 'form.source-performance/v2' }, { ...practice(), kind: undefined }, { ...practice(), kind: 'timed' },
    { ...practice(), load: undefined }, { ...practice(), load: null }, { ...practice(), load: {} },
    { ...practice(), load: { kind: 'unspecified' } }, { ...practice(), load: { basis: 'unknown' } },
    { ...practice(), load: { kind: 'known', basis: 'unknown' } }, { ...practice(), load: { kind: 'unspecified', basis: 'total' } },
    { ...practice(), load: { ...load, kg: 0 } }, { ...practice(), load: [] }, { ...practice(), load: 'not JSON' },
    { ...repetitions(), reps: undefined }, { ...repetitions(), reps: null }, { ...repetitions(), reps: '8' },
    repetitions(-1), repetitions(101), repetitions(1.5), repetitions(0),
    ...['reps', 'duration', 'seconds', 'time', 'rir', 'target_rir', 'kg', 'weightKg'].map(field => ({ ...practice(), [field]: 0 })),
    { ...repetitions(), duration: 30 }, { ...repetitions(), target_rir: 2 }];
  for (const value of invalid) assert.throws(() => insert(db, JSON.stringify(value)), /constraint failed|malformed JSON/);
  for (const value of ['{', '{"schema":"form.source-performance/v1",}',
    '{"schema":"form.source-performance/v1","schema":"form.source-performance/v1","kind":"controlled-practice","load":{"kind":"unspecified","basis":"unknown"}}',
    '{"schema":"form.source-performance/v1","kind":"controlled-practice","load":{"kind":"unspecified","basis":"unknown","basis":"unknown"}}']) {
    assert.throws(() => insert(db, value), /constraint failed|malformed JSON/);
  }
  assert.equal((db.prepare('SELECT count(*) n FROM performed_sets WHERE performance IS NOT NULL').get() as { n: number }).n, 0);
});

test('source and legacy branches stay exclusive on updates and confirmed repetitions cannot be zero', t => {
  const db = memory(t);
  for (const mixed of [{ reps: 0 }, { weight: 0 }, { reps: 8, weight: 20 }]) assert.throws(() => insert(db, JSON.stringify(practice()), mixed), /constraint failed/);
  insert(db, JSON.stringify(repetitions(0)), { id: 'draft', status: 'draft' });
  assert.throws(() => db.exec("UPDATE performed_sets SET status='confirmed' WHERE id='draft'"), /constraint failed/);
  db.prepare("UPDATE performed_sets SET performance=?,status='confirmed' WHERE id='draft'").run(JSON.stringify(repetitions(100)));
  assert.throws(() => db.exec("UPDATE performed_sets SET performance=NULL WHERE id='draft'"), /constraint failed/);
  assert.throws(() => db.exec("UPDATE performed_sets SET weight_kg=0 WHERE id='draft'"), /constraint failed/);
  db.prepare("UPDATE performed_sets SET performance=? WHERE id='draft'").run(JSON.stringify(practice()));
  assert.deepEqual(JSON.parse((db.prepare("SELECT performance FROM performed_sets WHERE id='draft'").get() as { performance: string }).performance), practice());
  for (const [index, status] of ['draft', 'voided'].entries()) insert(db, JSON.stringify(practice()),
    { id: `practice-${status}`, number: 90 + index, status });
  assertSchema(db);
});

function disk(t: TestContext) {
  const directory = dirname(fileURLToPath(import.meta.url));
  const api = resolve(directory, basename(dirname(directory)) === 'dist' ? '../..' : '..');
  assert.equal(basename(api), 'api'); assert.equal(basename(dirname(api)), 'services');
  const parent = resolve(api, '../../.scratch');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assert.ok(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink());
  const root = mkdtempSync(join(parent, 'source-prescription-migration-'));
  const handles: Sqlite[] = [];
  t.after(() => {
    const errors: unknown[] = [];
    for (const db of handles) try { if (db.open) db.close(); } catch (error) { errors.push(error); }
    try { rmSync(root, { recursive: true, force: false }); assert.equal(existsSync(root), false); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Owned migration fixture cleanup failed');
  });
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
  const path = join(root, 'synthetic.sqlite');
  const db = new Database(path); handles.push(db); installLegacy(db); seed(db);
  return { root, path, db, retain(database: Sqlite) { handles.push(database); return database; } };
}

test('actual runner backs up legacy18, records only19, reopens exactly and rejects missing or modified migration history', async t => {
  const f = disk(t), before = snapshot(f.db), receipts = before.form_migrations;
  const backups = await migrate(f.db, f.path, selected);
  assert.equal(backups.length, 1); assert.ok(backups[0]!.startsWith(join(f.root, 'backups') + '/before-19-'));
  const backup = f.retain(new Database(backups[0]!, { readonly: true })); backup.pragma('foreign_keys = ON');
  assert.deepEqual(snapshot(backup), before); integrity(backup); backup.close();
  const migrated = withoutPerformance(f.db);
  assert.deepEqual({ ...migrated, form_migrations: receipts }, before);
  assert.deepEqual(f.db.prepare('SELECT * FROM form_migrations WHERE version<=18 ORDER BY version').all(), receipts);
  assert.deepEqual((f.db.prepare('SELECT checksum FROM form_migrations ORDER BY version').all() as { checksum: string }[]).map(row => row.checksum),
    selected.map(entry => hash(entry.sql)));
  insert(f.db, JSON.stringify(practice())); assertSchema(f.db); f.db.close();
  const reopened = await openStorage(f.path, selected); f.retain(reopened.db);
  assert.deepEqual(reopened.migrationBackups, []); assertSchema(reopened.db);
  assert.deepEqual(JSON.parse((reopened.db.prepare("SELECT performance FROM performed_sets WHERE id='new'").get() as { performance: string }).performance), practice());
  reopened.db.close();
  await assert.rejects(() => openStorage(f.path, legacy), /Unknown or modified migration history/);
  for (const version of [1, 18, 19]) await assert.rejects(() => openStorage(f.path,
    selected.map(entry => entry.version === version ? { ...entry, sql: entry.sql + '\nSELECT 1;' } : entry)), /Unknown or modified migration history/);
  const check = f.retain(new Database(f.path)); check.pragma('foreign_keys = ON'); assertSchema(check);
});

test('actual runner rolls back the complete staged swap and checksum receipt after a late migration19 failure', async t => {
  const f = disk(t), before = snapshot(f.db);
  const failing = selected.map(entry => entry.version === 19 ? { ...entry, sql: entry.sql + '\nSELECT source_prescription_deliberate_failure();' } : entry);
  await assert.rejects(() => migrate(f.db, f.path, failing), /source_prescription_deliberate_failure/);
  assert.deepEqual(snapshot(f.db), before); assertSchema(f.db);
  assert.ok(!(f.db.pragma('table_info(performed_sets)') as { name: string }[]).some(row => row.name === 'performance'));
  assert.equal((f.db.prepare('SELECT max(version) n FROM form_migrations').get() as { n: number }).n, 18);
  assert.equal(readdirSync(join(f.root, 'backups')).filter(name => name.startsWith('before-19-')).length, 1);
  const backups = await migrate(f.db, f.path, selected);
  assert.equal(backups.length, 1); assertSchema(f.db);
  assert.deepEqual((f.db.prepare('SELECT version FROM form_migrations ORDER BY version').all() as { version: number }[]).map(row => row.version),
    Array.from({ length: 19 }, (_, index) => index + 1));
});
