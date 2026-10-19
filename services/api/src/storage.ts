import Database from 'better-sqlite3';
import { assertAccountActive } from './lifecycle/guards.js';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { catalogSeed } from './catalog.js';
import { DomainError } from './errors.js';
import { phoneMigrationSql } from './phone/migration.js';
import { applePurchaseMigrationSql } from './purchases/migration.js';

export type Sqlite = Database.Database;
export type Migration = { version: number; sql: string };
export const migrations: readonly Migration[] = [
  { version: 1, sql: `
    CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT,
      userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE);
    CREATE INDEX session_user ON session(userId);
    CREATE TABLE account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
      userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT,
      idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE INDEX auth_account_user ON account(userId);
    CREATE UNIQUE INDEX auth_provider_subject ON account(providerId, accountId);
    CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
      expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE INDEX verification_identifier ON verification(identifier);
    CREATE TABLE rateLimit (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, lastRequest INTEGER NOT NULL);
    CREATE TABLE form_accounts (id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id), created_at TEXT NOT NULL);
    CREATE TRIGGER immutable_account_mapping BEFORE UPDATE OF id,auth_user_id ON form_accounts
      BEGIN SELECT RAISE(ABORT, 'immutable_account_mapping'); END;
    CREATE TABLE documents (account_id TEXT NOT NULL REFERENCES form_accounts(id), kind TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0), data TEXT NOT NULL CHECK(json_valid(data)),
      PRIMARY KEY(account_id,kind));
    CREATE TABLE document_revisions (account_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL,
      PRIMARY KEY(account_id,kind,revision), FOREIGN KEY(account_id,kind) REFERENCES documents(account_id,kind));
    CREATE TABLE exercises (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TRIGGER immutable_catalog BEFORE UPDATE ON exercises BEGIN SELECT RAISE(ABORT, 'immutable_catalog'); END;
    CREATE TRIGGER retained_catalog BEFORE DELETE ON exercises BEGIN SELECT RAISE(ABORT, 'retained_catalog'); END;
    CREATE TABLE plans (account_id TEXT NOT NULL REFERENCES form_accounts(id), id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
      data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(account_id,id));
    CREATE TABLE plan_revisions (account_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL, PRIMARY KEY(account_id,plan_id,revision),
      FOREIGN KEY(account_id,plan_id) REFERENCES plans(account_id,id));
    CREATE TABLE plan_item_ids (account_id TEXT NOT NULL, plan_id TEXT NOT NULL, id TEXT NOT NULL,
      exercise_id TEXT NOT NULL REFERENCES exercises(id), PRIMARY KEY(account_id,plan_id,id),
      FOREIGN KEY(account_id,plan_id) REFERENCES plans(account_id,id));
    CREATE TABLE workout_sessions (account_id TEXT NOT NULL REFERENCES form_accounts(id), id TEXT NOT NULL,
      plan_id TEXT NOT NULL, plan_revision INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1),
      snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), status TEXT NOT NULL CHECK(status IN('active','completed')),
      started_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(account_id,id),
      FOREIGN KEY(account_id,plan_id,plan_revision) REFERENCES plan_revisions(account_id,plan_id,revision));
    CREATE TABLE session_occurrences (account_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL,
      item_id TEXT NOT NULL, exercise_id TEXT NOT NULL REFERENCES exercises(id), position INTEGER NOT NULL,
      target TEXT NOT NULL CHECK(json_valid(target)), PRIMARY KEY(account_id,session_id,id),
      UNIQUE(account_id,session_id,position), FOREIGN KEY(account_id,session_id) REFERENCES workout_sessions(account_id,id));
    CREATE TABLE performed_sets (account_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL, set_number INTEGER NOT NULL CHECK(set_number BETWEEN 1 AND 100),
      revision INTEGER NOT NULL CHECK(revision >= 1), reps INTEGER NOT NULL CHECK(reps BETWEEN 0 AND 100),
      weight_kg REAL NOT NULL CHECK(weight_kg BETWEEN 0 AND 500),
      status TEXT NOT NULL CHECK(status IN('draft','confirmed','voided')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(account_id,session_id,id),
      UNIQUE(account_id,session_id,occurrence_id,set_number),
      CHECK(status <> 'confirmed' OR reps > 0),
      FOREIGN KEY(account_id,session_id,occurrence_id) REFERENCES session_occurrences(account_id,session_id,id));
    CREATE TABLE set_revisions (account_id TEXT NOT NULL, session_id TEXT NOT NULL, set_id TEXT NOT NULL,
      revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL,
      PRIMARY KEY(account_id,session_id,set_id,revision),
      FOREIGN KEY(account_id,session_id,set_id) REFERENCES performed_sets(account_id,session_id,id));
    CREATE TABLE command_receipts (account_id TEXT NOT NULL REFERENCES form_accounts(id), operation TEXT NOT NULL,
      key TEXT NOT NULL, intent_hash TEXT NOT NULL, status INTEGER NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)),
      created_at TEXT NOT NULL, PRIMARY KEY(account_id,operation,key));
    CREATE TABLE promos (code_hash TEXT PRIMARY KEY, definition TEXT NOT NULL CHECK(json_valid(definition)),
      redeemed INTEGER NOT NULL DEFAULT 0 CHECK(redeemed >= 0));
    CREATE TABLE entitlement_grants (account_id TEXT NOT NULL REFERENCES form_accounts(id), id TEXT NOT NULL,
      entitlement TEXT NOT NULL, source TEXT NOT NULL CHECK(source='promo'), source_id TEXT NOT NULL REFERENCES promos(code_hash),
      granted_at TEXT NOT NULL, expires_at TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment='zero_charge'),
      PRIMARY KEY(account_id,id), UNIQUE(account_id,source,source_id));
  ` },
  { version: 2, sql: `
    CREATE INDEX workout_history ON workout_sessions(account_id,started_at DESC,id);
    CREATE INDEX confirmed_sets ON performed_sets(account_id,status,session_id);
    CREATE INDEX active_grants ON entitlement_grants(account_id,expires_at);
    CREATE TRIGGER immutable_plan_history BEFORE UPDATE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'immutable_plan_history'); END;
    CREATE TRIGGER immutable_occurrence BEFORE UPDATE ON session_occurrences BEGIN SELECT RAISE(ABORT, 'immutable_occurrence'); END;
  ` },
  { version: 3, sql: `
    CREATE TABLE transcription_attempts (account_id TEXT NOT NULL REFERENCES form_accounts(id), id TEXT NOT NULL,
      key TEXT NOT NULL, intent_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('pending','succeeded','failed','unknown')),
      text TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(account_id,id), UNIQUE(account_id,key));
    CREATE TRIGGER immutable_document_history BEFORE UPDATE ON document_revisions BEGIN SELECT RAISE(ABORT, 'immutable_document_history'); END;
    CREATE TRIGGER immutable_set_history BEFORE UPDATE ON set_revisions BEGIN SELECT RAISE(ABORT, 'immutable_set_history'); END;
    CREATE TRIGGER immutable_session_snapshot BEFORE UPDATE OF snapshot,plan_id,plan_revision,account_id,id ON workout_sessions
      BEGIN SELECT RAISE(ABORT, 'immutable_session_snapshot'); END;
  ` },
  { version: 4, sql: `
    ALTER TABLE exercises ADD COLUMN retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN(0,1));
    DROP TRIGGER immutable_catalog;
    CREATE TRIGGER immutable_catalog BEFORE UPDATE OF id,data ON exercises BEGIN SELECT RAISE(ABORT, 'immutable_catalog'); END;
    CREATE TRIGGER permanent_catalog_retirement BEFORE UPDATE OF retired ON exercises WHEN NEW.retired < OLD.retired
      BEGIN SELECT RAISE(ABORT, 'permanent_catalog_retirement'); END;
  ` },
  { version: 5, sql: phoneMigrationSql },
  { version: 6, sql: applePurchaseMigrationSql },
  { version: 7, sql: `
    UPDATE documents SET data=json_set(data,'$.appMode','basic'),revision=revision+1
      WHERE kind='preferences' AND json_type(data,'$.appMode') IS NULL;
    INSERT INTO document_revisions(account_id,kind,revision,data,created_at)
      SELECT account_id,kind,revision,data,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM documents
      WHERE kind='preferences' AND revision NOT IN
        (SELECT revision FROM document_revisions WHERE account_id=documents.account_id AND kind='preferences');
  ` },
];

function configure(db: Sqlite): void {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
}
export function integrity(db: Sqlite): void {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length !== 0)
    throw new Error('Database integrity verification failed');
}

export async function backupAndVerify(db: Sqlite, destination: string): Promise<void> {
  if (!isAbsolute(destination) || existsSync(destination)) throw new Error('Backup needs a new absolute destination');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  await db.backup(destination);
  chmodSync(destination, 0o600);
  const restoreRoot = mkdtempSync(join(dirname(destination), '.restore-'));
  try {
    const restoredPath = join(restoreRoot, 'isolated.sqlite');
    copyFileSync(destination, restoredPath);
    const restored = new Database(restoredPath, { readonly: true });
    try { restored.pragma('foreign_keys = ON'); integrity(restored); }
    finally { restored.close(); }
  } finally { rmSync(restoreRoot, { recursive: true, force: true }); }
}

export type SourceReportedLoadSelection = 'selected-migration-22';
export type SourceManualRetentionSelection = 'selected-migration-23';
export async function migrate(db: Sqlite, dbPath: string, selected: readonly Migration[] = migrations,
  sourceReportedLoad?: SourceReportedLoadSelection, sourceManualRetention?: SourceManualRetentionSelection): Promise<string[]> {
  // Only the two explicit source selections may use their finite coordinated migration histories.
  if ((sourceReportedLoad !== undefined && sourceReportedLoad !== 'selected-migration-22') ||
    (sourceManualRetention !== undefined && sourceManualRetention !== 'selected-migration-23'))
    throw new Error('Invalid source migration selection');
  const sourceValidation = sourceReportedLoad || sourceManualRetention
    ? await import('./integration/account-modules/migrations.js') : undefined;
  if (sourceManualRetention) {
    sourceValidation!.assertSourceManualRetentionSelection(selected);
    if (selected.some(entry => entry.version === 22) !== !!sourceReportedLoad) throw new Error('Explicit reported-load selection required');
  } else if (selected.some(entry => entry.version === 23)) throw new Error('Explicit manual-retention selection required');
  if (sourceReportedLoad) sourceValidation!.assertSourceReportedLoadSelection(selected);
  else if (!sourceManualRetention && selected.some((entry, index) => entry.version !== index + 1))
    throw new Error('Migration sequence must be contiguous');
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='form_migrations'").get();
  const applied = existing ? db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as { version: number; checksum: string }[] : [];
  for (const record of applied) {
    const source = selected.find(x => x.version === record.version);
    if (!source || record.checksum !== hash(source.sql)) throw new Error('Unknown or modified migration history');
  }
  if (sourceManualRetention) sourceValidation!.assertSourceManualRetentionHistory(applied);
  else if (sourceReportedLoad) sourceValidation!.assertSourceReportedLoadHistory(applied);
  const pending = selected.filter(x => !applied.some(y => y.version === x.version));
  if (pending.some(entry => entry.version === 23)) {
    const { manualRetentionOwnedTables } = await import('./body/manual-retention-migration.js');
    if (manualRetentionOwnedTables.some(table => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)))
      throw new Error('Unnumbered manual-retention tables cannot be adopted');
  }
  const backups: string[] = [];
  for (const migration of pending) {
    const hasTables = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
    if (hasTables) {
      const path = join(dirname(dbPath), 'backups', `before-${migration.version}-${randomUUID()}.sqlite`);
      await backupAndVerify(db, path); backups.push(path);
    }
    db.transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS form_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
      db.exec(migration.sql);
      db.prepare('INSERT INTO form_migrations VALUES (?,?,?)').run(migration.version, hash(migration.sql), new Date().toISOString());
      integrity(db);
    }).immediate();
  }
  const finalHistory = db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as { version: number; checksum: string }[];
  if (sourceManualRetention) sourceValidation!.assertSourceManualRetentionHistory(finalHistory, true);
  if (sourceReportedLoad) sourceValidation!.assertSourceReportedLoadHistory(finalHistory, true);
  integrity(db);
  return backups;
}

export async function openStorage(dbPath: string, selected: readonly Migration[] = migrations,
  sourceReportedLoad?: SourceReportedLoadSelection, sourceManualRetention?: SourceManualRetentionSelection): Promise<{ db: Sqlite; migrationBackups: string[] }> {
  if (!isAbsolute(dbPath) || dbPath === ':memory:') throw new Error('A durable absolute database path is required');
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  if (existsSync(dbPath) && (!statSync(dbPath).isFile() || realpathSync(dbPath) !== resolve(dbPath)))
    throw new Error('Database must be a regular non-symlink file');
  const db = new Database(dbPath);
  try {
    chmodSync(dbPath, 0o600); configure(db);
    const migrationBackups = await migrate(db, dbPath, selected, sourceReportedLoad, sourceManualRetention);
    db.transaction(() => {
      for (const entry of catalogSeed)
        db.prepare('INSERT INTO exercises(id,data) VALUES (?,?) ON CONFLICT(id) DO NOTHING').run(entry.id, JSON.stringify(entry));
    }).immediate();
    return { db, migrationBackups };
  } catch (error) { db.close(); throw error; }
}

export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export type CommandResult = { status: 200 | 201; body: unknown };
export function command(db: Sqlite, accountId: string, operation: string, key: string | undefined, intent: unknown,
  authorize: () => void, effect: () => CommandResult): CommandResult {
  if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new DomainError(400, 'idempotency_key_required');
  return db.transaction(() => {
    assertAccountActive(db, accountId);
    authorize();
    const fingerprint = hash(canonical(intent));
    const receipt = db.prepare('SELECT intent_hash,status,result FROM command_receipts WHERE account_id=? AND operation=? AND key=?')
      .get(accountId, operation, key) as { intent_hash: string; status: 200 | 201; result: string } | undefined;
    if (receipt) {
      if (receipt.intent_hash !== fingerprint) throw new DomainError(409, 'idempotency_mismatch');
      return { status: receipt.status, body: JSON.parse(receipt.result) as unknown };
    }
    const result = effect();
    db.prepare('INSERT INTO command_receipts VALUES (?,?,?,?,?,?,?)')
      .run(accountId, operation, key, fingerprint, result.status, JSON.stringify(result.body), new Date().toISOString());
    return result;
  }).immediate();
}
