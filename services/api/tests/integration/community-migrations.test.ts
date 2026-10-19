import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { migrations, openStorage, hash, type Sqlite } from '../../src/storage.js';
import { composeAccountMigrations } from '../../src/lifecycle/composition.js';
import { activityMigration } from '../../src/activity/migration.js';
import { communityMigration } from '../../src/community/migration.js';
import { communityExtensionMigration } from '../../src/community/extension-migration.js';
import { featureBoardMigrationVersion, featureBoardMigrationSql } from '../../src/community/board/migration.js';
import { featureBoardCorrectionMigrationSql } from '../../src/community/board/correction-migration.js';
import { selectAccountModuleMigrations } from '../../src/integration/account-modules/migrations.js';

import { lifecycleMigration } from '../../src/lifecycle/migration.js';
import { mascotPreferencesMigration } from '../../src/lifecycle/preferences-migration.js';
import { usageMigrationVersion, usageMigrationSql } from '../../src/usage-limits/migration.js';
import { bugIntakeMigrationSql } from '../../src/bug-intake/migration.js';
import { communityRemovalSnapshotsMigrationSql } from '../../src/community/removal-snapshots.js';

const historical13 = [...migrations, activityMigration, communityMigration, lifecycleMigration,
  mascotPreferencesMigration, communityExtensionMigration, { version: featureBoardMigrationVersion, sql: featureBoardMigrationSql }];
const historical15 = [...historical13, { version: usageMigrationVersion, sql: usageMigrationSql },
  { version: 15, sql: bugIntakeMigrationSql }];

const additions = { extension: communityExtensionMigration,
  board: { version: featureBoardMigrationVersion, sql: featureBoardMigrationSql } };

test('additive composition retains the exact original migrations and preserves SQL1–15 and appends exact Community16', () => {
  const baseline = composeAccountMigrations(activityMigration, communityMigration);
  const composed = composeAccountMigrations(activityMigration, communityMigration, additions);
  assert.deepEqual(composed.map(m => m.version), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.deepEqual(composed.slice(0, 11), baseline);
  for (let i = 0; i < migrations.length; i++) assert.equal(composed[i], migrations[i]);
  assert.equal(composed[11], communityExtensionMigration);
  assert.equal(composed[12]?.sql, featureBoardMigrationSql);
  assert.deepEqual(composed.slice(0, 15), historical15);
  assert.deepEqual(composed.slice(0, 15).map(m => hash(m.sql)), historical15.map(m => hash(m.sql)));
  assert.equal(composed[15]?.sql, communityRemovalSnapshotsMigrationSql);
  assert.equal(Buffer.byteLength(composed[15]!.sql), 1072);
  assert.equal(hash(composed[15]!.sql), '5bdc7d61c9647576b1302ca5ff469d9702f065e35b32c6462d833e468e34c23d');
});

test('historical13/15 upgrade to current16 and every current16 storage reopens without migration replay', async () => {
  const parent = resolve('.scratch');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'community-migrations-'));
  let db: Sqlite | undefined;
  const cleanup = () => { if (db?.open) db.close(); rmSync(root, { recursive: true, force: true }); };
  const interrupted = () => { cleanup(); process.exit(130); };
  const terminated = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', terminated);
  try {
    const selected = composeAccountMigrations(activityMigration, communityMigration, additions);
    for (const initial of [historical13, historical15, selected]) {
      const path = join(root, `synthetic-${initial.length}.sqlite`);
      const first = await openStorage(path, initial); db = first.db;
      const before = db.prepare('SELECT version,checksum,applied_at FROM form_migrations ORDER BY version').all();
      assert.equal(before.length, initial.length);
      db.close(); db = undefined;
      const upgraded = await openStorage(path, selected); db = upgraded.db;
      assert.equal(upgraded.migrationBackups.length, 16 - initial.length);
      assert.deepEqual(db.prepare('SELECT version,checksum,applied_at FROM form_migrations WHERE version<=? ORDER BY version').all(initial.length), before);
      const current = db.prepare('SELECT version,checksum,applied_at FROM form_migrations ORDER BY version').all();
      assert.equal(current.length, 16);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_removal_snapshots'").get());
      db.close(); db = undefined;
      const reopened = await openStorage(path, selected); db = reopened.db;
      assert.deepEqual(reopened.migrationBackups, []);
      assert.deepEqual(db.prepare('SELECT version,checksum,applied_at FROM form_migrations ORDER BY version').all(), current);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      db.close(); db = undefined;
    }
  } finally {
    process.off('SIGINT', interrupted); process.off('SIGTERM', terminated); cleanup();
  }
});

test('additive composition rejects missing, empty or misordered module slots', () => {
  for (const input of [
    { ...additions, extension: { version: 13, sql: 'SELECT 1' } },
    { ...additions, board: { version: 12, sql: 'SELECT 1' } },
    { ...additions, board: { version: 13, sql: '  ' } },
  ]) assert.throws(() => composeAccountMigrations(activityMigration, communityMigration, input));
  assert.throws(() => composeAccountMigrations(activityMigration, communityMigration,
    { extension: communityExtensionMigration } as typeof additions));
});

test('actual16-schema SQL applies atomically and preserves Community foreign-key integrity', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    db.transaction(() => {
      for (const migration of composeAccountMigrations(activityMigration, communityMigration, additions))
        db.exec(migration.sql);
    })();
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'community_%'")
      .all() as { name: string }[];
    assert.ok(tables.some(row => row.name === 'community_board_features'));
    assert.ok(tables.some(row => row.name === 'community_match_enrollments'));
    assert.ok(tables.some(row => row.name === 'community_removal_snapshots'));
    assert.equal(tables.filter(row => row.name.startsWith('community_board_')).length, 9);
    for (const { name } of tables) {
      const links = db.pragma(`foreign_key_list('${name}')`) as { table: string }[];
      assert.ok(links.every(link => link.table.startsWith('community_')), name);
    }
  } finally { db.close(); }
});

test('selected storage upgrades19 to exact20 once and rejects reopening with an older prefix', async () => {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'community-correction-migrations-'));
  let db: Sqlite | undefined;
  const cleanup = () => { if (db?.open) db.close(); rmSync(root, { recursive: true, force: true }); };
  const interrupt = () => { cleanup(); process.exit(130); }, terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const base = composeAccountMigrations(activityMigration, communityMigration, additions);
    const previous = selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-training-feedback-and-source-prescription' }, base);
    const selected = selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, base);
    const path = join(root, 'synthetic.sqlite');
    const initial = await openStorage(path, previous); db = initial.db;
    const before = db.prepare('SELECT version,checksum,applied_at FROM form_migrations ORDER BY version').all();
    assert.equal(before.length, 19);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='community_board_correction_events'").get(), undefined);
    db.close(); db = undefined;
    const upgraded = await openStorage(path, selected); db = upgraded.db;
    assert.equal(upgraded.migrationBackups.length, 1);
    assert.deepEqual(db.prepare('SELECT version,checksum,applied_at FROM form_migrations WHERE version<=19 ORDER BY version').all(), before);
    assert.deepEqual(db.prepare('SELECT version,checksum FROM form_migrations WHERE version=20').get(), { version: 20, checksum: hash(featureBoardCorrectionMigrationSql) });
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_board_correction_events'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='community_board_correction_immutable'").get());
    const history = db.prepare('SELECT * FROM form_migrations ORDER BY version').all(); db.close(); db = undefined;
    await assert.rejects(openStorage(path, previous), /Unknown or modified migration history/);
    const reopened = await openStorage(path, selected); db = reopened.db;
    assert.deepEqual(reopened.migrationBackups, []); assert.deepEqual(db.prepare('SELECT * FROM form_migrations ORDER BY version').all(), history);
    assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); cleanup(); }
});
