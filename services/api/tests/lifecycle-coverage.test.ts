import { selectSourceActionReauthenticationMigrations } from '../src/lifecycle/reauthentication-source-migrations.js';
import { selectSourceProviderRevocationMigrations } from '../src/lifecycle/providers/source-migrations.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import Database from 'better-sqlite3';
import { hash, type Sqlite } from '../src/storage.js';
import { runtimeMigrations } from '../src/runtime-modules/migrations.js';
import { selectAccountModuleMigrations, appendSourceBodyMeasurementMigration, appendSourceReportedLoadMigration,
  appendSourceManualRetentionMigration } from '../src/integration/account-modules/migrations.js';
import { lifecycleTableCoverage, lifecycleSchemaEvolutions, type LifecycleCoverageCohort } from '../src/lifecycle/coverage.js';
import { familyMembershipMigrationSql } from '../src/family-membership/migration.js';
import { wearablePersistenceSql } from '../src/wearables/persistence/schema.js';
import { providerAuthStateSql } from '../src/wearables/direct-provider-transport/auth-store-schema.js';
import { applePurchaseReconciliationMigrationSql } from '../src/purchases/reconciliation-migration.js';
import { manualMeasurementMigrationSql } from '../src/body/manual-measurement-migration.js';
import { manualRetentionMigrationSql } from '../src/body/manual-retention-migration.js';
import { install } from './integration/account-modules/fixture.js';
import { suppressionLedgerSchema } from '../src/lifecycle/ledger.js';
import { selectSourceLifecycleEvidenceMigrations } from '../src/lifecycle/source-migrations.js';

const inventory = (db: Sqlite): string[] => (db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string }[]).map(row => row.name);

function qualify(db: Sqlite, cohorts: readonly LifecycleCoverageCohort[]): void {
  const declared = lifecycleTableCoverage.filter(row => cohorts.includes(row.cohort));
  const actual = inventory(db), names = declared.map(row => row.table);
  assert.equal(new Set(names).size, names.length, 'table classification must be unique');
  assert.deepEqual(actual.filter(name => !names.includes(name)), [], 'unclassified schema tables');
  assert.deepEqual(names.filter(name => !actual.includes(name)), [], 'declared cohort tables absent from actual schema');
  for (const row of declared) {
    for (const field of ['owner', 'attribution', 'limits', 'mechanism', 'residual', 'evidence'] as const)
      assert.ok(row[field].trim(), `${row.table} lacks ${field}`);
  }
  assert.deepEqual(db.pragma('foreign_key_check'), []);
}

function memory(t: import('node:test').TestContext): Sqlite {
  const db: Sqlite = new Database(':memory:');
  t.after(() => db.close());
  install(db, runtimeMigrations);
  return db;
}

const source20 = selectAccountModuleMigrations({ mode: 'source-only',
  modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, runtimeMigrations);
const source23 = appendSourceManualRetentionMigration(appendSourceReportedLoadMigration(appendSourceBodyMeasurementMigration(source20)));

test('actual runtime16 and each separately composed source17–23 schema qualify independently', t => {
  const db = memory(t);
  assert.deepEqual(runtimeMigrations.map(row => row.version), Array.from({ length: 16 }, (_, i) => i + 1));
  qualify(db, ['runtime16']);
  const cohorts: LifecycleCoverageCohort[] = ['runtime16'];
  const additions: Readonly<Record<number, LifecycleCoverageCohort>> = {
    17: 'source17', 18: 'source18', 20: 'source20', 21: 'source21', 23: 'source23',
  };
  for (const migration of source23.slice(runtimeMigrations.length)) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
    }).immediate();
    const cohort = additions[migration.version];
    if (cohort) cohorts.push(cohort);
    qualify(db, cohorts);
    if (migration.version === 19 || migration.version === 22) {
      const evolution = lifecycleSchemaEvolutions.find(row => row.version === migration.version)!;
      assert.deepEqual(evolution.tables, ['performed_sets', 'set_revisions']);
      const columns = db.prepare('PRAGMA table_info(performed_sets)').all() as { name: string }[];
      assert.ok(columns.some(row => row.name === 'performance'));
      const foreignKeys = db.prepare('PRAGMA foreign_key_list(set_revisions)').all() as { table: string; from: string; to: string }[];
      assert.deepEqual(foreignKeys.filter(row => row.table === 'performed_sets').map(row => [row.from, row.to]).sort(),
        [['account_id', 'account_id'], ['session_id', 'session_id'], ['set_id', 'id']].sort());
      assert.equal(inventory(db).some(name => name.includes('_source_v')), false);
    }
  }
  assert.deepEqual(source23.map(row => row.version), Array.from({ length: 23 }, (_, i) => i + 1));
  assert.equal(inventory(memory(t)).includes('body_manual_retention_decisions'), false, 'runtime16 did not acquire source23');
});

test('optional unnumbered schemas are inventoried from actual fragments, including Body without numbered registration', t => {
  const db = memory(t);
  const cohorts: LifecycleCoverageCohort[] = ['runtime16'];
  for (const [cohort, sql] of [
    ['optional-family', familyMembershipMigrationSql],
    ['optional-wearables', wearablePersistenceSql],
    ['optional-wearable-auth', providerAuthStateSql],
    ['optional-purchase-reconciliation', applePurchaseReconciliationMigrationSql],
    ['source21', manualMeasurementMigrationSql],
    ['source23', manualRetentionMigrationSql],
  ] as const) {
    db.transaction(() => db.exec(sql)).immediate();
    cohorts.push(cohort);
    qualify(db, cohorts);
  }
  assert.equal((db.prepare('SELECT max(version) AS version FROM form_migrations').get() as { version: number }).version, 16,
    'inventorying optional fragments must not fabricate numbered migration receipts or qualify runtime admission');
});

test('source24 evidence tables qualify only in the exact full source cohort and retain proof', t => {
  const db: Sqlite = new Database(':memory:'); t.after(() => db.close());
  install(db, selectSourceLifecycleEvidenceMigrations());
  qualify(db, ['runtime16', 'source17', 'source18', 'source20', 'source21', 'source23', 'source24']);
  assert.throws(() => qualify(db, ['runtime16', 'source17', 'source18', 'source20', 'source21', 'source23']), /unclassified schema tables/);
  for (const table of ['account_deletion_evidence_operations', 'account_deletion_evidence']) {
    assert.equal(lifecycleTableCoverage.find(row => row.table === table)?.disposition, 'retained');
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table);
    assert.deepEqual(triggers, [{ name: `${table}_no_delete` }, { name: `${table}_no_update` }]);
  }
});

test('unknown account-bearing and operational tables fail qualification without any runtime startup gate', t => {
  const db = memory(t);
  db.exec('CREATE TABLE synthetic_new_account_data(account_id TEXT REFERENCES form_accounts(id)); CREATE TABLE synthetic_new_operational_data(id TEXT)');
  assert.throws(() => qualify(db, ['runtime16']), error => {
    assert.ok(error instanceof AssertionError);
    assert.deepEqual(error.actual, ['synthetic_new_account_data', 'synthetic_new_operational_data']);
    return true;
  });
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM form_accounts').get(), { n: 0 });
});

test('independent suppression schema stays outside main inventory and rejects proof deletion', t => {
  const authority: Sqlite = new Database(':memory:');
  t.after(() => authority.close());
  authority.exec(suppressionLedgerSchema);
  assert.deepEqual(inventory(authority), ['suppression_authority', 'suppression_records']);
  assert.equal(inventory(authority).some(table => lifecycleTableCoverage.some(row => row.table === table)), false);
  authority.prepare('INSERT INTO suppression_authority VALUES(?,0)').run('synthetic-independent-authority');
  authority.prepare('INSERT INTO suppression_records VALUES(1,?,?,1,?,1)').run('form-one', 'auth-one', 'request-one');
  assert.throws(() => authority.prepare('DELETE FROM suppression_records WHERE account_id=?').run('form-one'), /suppression_retained/);
  assert.throws(() => authority.prepare('DELETE FROM suppression_authority').run(), /suppression_authority_retained/);
  assert.throws(() => qualify(authority, ['runtime16']), /unclassified schema tables/);
});

test('registry cascade and ownership boundaries match actual foreign keys and retained lifecycle guards', t => {
  const db = memory(t);
  type ForeignKey = { table: string; from: string; to: string; on_delete: string };
  const grants = db.prepare('PRAGMA foreign_key_list(account_action_grants)').all() as ForeignKey[];
  assert.ok(grants.some(row => row.table === 'session' && row.from === 'session_id' && row.to === 'id' && row.on_delete === 'CASCADE'));
  assert.equal(lifecycleTableCoverage.find(row => row.table === 'account_action_grants')?.disposition, 'session-cascade');
  const phone = db.prepare('PRAGMA foreign_key_list(phone_operations)').all() as ForeignKey[];
  assert.ok(phone.some(row => row.table === 'phone_challenges' && row.from === 'challenge_id' && row.on_delete === 'NO ACTION'));
  for (const table of ['verification', 'rateLimit']) {
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(${table})`).all(), []);
    assert.equal(lifecycleTableCoverage.find(row => row.table === table)?.disposition, 'operational');
  }
  for (const id of ['one', 'two']) {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,1,1)').run(id, id, `${id}@synthetic.invalid`);
    db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(`form-${id}`, id, 'synthetic');
    db.prepare("INSERT INTO community_members VALUES(?,?,?,?,'member','removed',1,1,?,?)")
      .run('shared-group', `form-${id}`, `member-${id}`, '', 'joined', 'ended');
    db.prepare('INSERT INTO community_removal_snapshots VALUES(?,?,?,1,?,?,1,?)')
      .run('shared-group', `form-${id}`, `member-${id}`, 'removed', 'ended', 'Synthetic group');
  }
  const other = db.prepare('SELECT * FROM community_removal_snapshots WHERE account_id=?').get('form-two');
  db.prepare('DELETE FROM community_members WHERE account_id=?').run('form-one');
  assert.equal(db.prepare('SELECT 1 FROM community_removal_snapshots WHERE account_id=?').get('form-one'), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM community_removal_snapshots WHERE account_id=?').get('form-two'), other);
  assert.throws(() => db.prepare('UPDATE form_accounts SET auth_user_id=? WHERE id=?').run('two', 'form-one'), /immutable_account_mapping/);
  assert.throws(() => db.prepare('DELETE FROM account_lifecycle WHERE account_id=?').run('form-one'), /lifecycle_retained/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});


test('source25 restricted provider authority/evidence has exact ownership without changing source24 or runtime16', t => {
  const db: Sqlite = new Database(':memory:'); t.after(() => db.close());
  install(db, selectSourceProviderRevocationMigrations());
  qualify(db, ['runtime16', 'source17', 'source18', 'source20', 'source21', 'source23', 'source24', 'source25']);
  assert.throws(() => qualify(db, ['runtime16', 'source17', 'source18', 'source20', 'source21', 'source23', 'source24']), /unclassified schema tables/);
  const declared = lifecycleTableCoverage.filter(row => row.cohort === 'source25');
  assert.deepEqual(declared.map(row => row.table).sort(), ['account_provider_revocation_attempts', 'account_provider_revocation_intents']);
  for (const row of declared) {
    assert.equal(row.disposition, 'retained');
    assert.match(row.limits, /excluded from exports and local purge/);
    assert.match(row.residual, /unavailable/);
  }
  assert.equal(inventory(memory(t)).includes('account_provider_revocation_intents'), false);
  const old: Sqlite = new Database(':memory:'); t.after(() => old.close()); install(old, selectSourceLifecycleEvidenceMigrations());
  assert.equal(inventory(old).includes('account_provider_revocation_attempts'), false);
});


test('exact source26 inventories three retained security tables without export or completion authority', t => {
  const db: Sqlite = new Database(':memory:'); t.after(() => db.close());
  install(db, selectSourceActionReauthenticationMigrations());
  const cohorts: LifecycleCoverageCohort[] = ['runtime16', 'source17', 'source18', 'source20', 'source21', 'source23', 'source24', 'source25', 'source26'];
  qualify(db, cohorts);
  assert.throws(() => qualify(db, cohorts.filter(c => c !== 'source26')), /unclassified schema tables/);
  const retained = lifecycleTableCoverage.filter(row => row.cohort === 'source26');
  assert.deepEqual(retained.map(row => row.table).sort(), ['account_action_challenge_budgets', 'account_action_challenges', 'account_action_proof_consumptions']);
  for (const row of retained) {
    assert.equal(row.disposition, 'retained');
    assert.match(row.limits, /security metadata/); assert.match(row.residual, /no production restore/);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE DELETE%'").get(row.table));
  }
});
