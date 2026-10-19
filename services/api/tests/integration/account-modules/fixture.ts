import Database from 'better-sqlite3';
import { Domain } from '../../../src/domain.js';
import { activityMigration } from '../../../src/activity/index.js';
import { communityMigration, communityExtensionMigration, featureBoardMigrationVersion, featureBoardMigrationSql } from '../../../src/community/index.js';
import { composeAccountMigrations } from '../../../src/lifecycle/composition.js';
import { assertActive, adultEligibility, bindSuppressionAuthority, subjectEligibility, withActiveWrite } from '../../../src/lifecycle/guards.js';
import { createSourceRequestFactories } from '../../../src/lifecycle/request-factories.js';
import type { AccountContext, DisableRecord, LifecycleBindings, SuppressionLedger } from '../../../src/lifecycle/types.js';
import { createSourceAccountModules, selectAccountModuleMigrations } from '../../../src/integration/account-modules/index.js';
import { hash, type Migration, type Sqlite } from '../../../src/storage.js';

export const selector = { mode: 'source-only', modules: 'usage-and-bug-intake' } as const;
export const moduleMigrations = { activity: activityMigration, community: communityMigration,
  additions: { extension: communityExtensionMigration, board: { version: featureBoardMigrationVersion, sql: featureBoardMigrationSql } } };
export const baseMigrations = composeAccountMigrations(moduleMigrations.activity, moduleMigrations.community, moduleMigrations.additions);
export const selectedMigrations = selectAccountModuleMigrations(selector, baseMigrations);
export const requestConfiguration = { mode: 'source-only', communityModules: 'b2-b4-b5' } as const;
export const reportInput = { title: 'Synthetic bug', description: 'Synthetic report text without external authority.' };

export function suppressionLedger() {
  const records = new Map<string, DisableRecord>();
  let sequence = 0;
  const ledger: SuppressionLedger = {
    currentSequence: () => sequence, lookup: id => records.get(id) ?? null,
    reconcileRestore: apply => { for (const record of records.values()) apply(record); return sequence; },
    recordDisable: input => { const record = { ...input, sequence: ++sequence }; records.set(input.accountId, record); return record; },
  };
  return { ledger, records };
}
export function install(db: Sqlite, migrations: readonly Migration[] = selectedMigrations) {
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of migrations) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
  }
}
export function fixture(): {
  db: Sqlite;
  bindings: LifecycleBindings;
  modules: ReturnType<typeof createSourceAccountModules>;
  existing: ReturnType<typeof createSourceRequestFactories>;
  ledger: SuppressionLedger;
  records: Map<string, DisableRecord>;
  one: AccountContext;
  two: AccountContext;
  close: () => void;
} {
  const db: Sqlite = new Database(':memory:');
  try {
    install(db);
    const authority = suppressionLedger(); bindSuppressionAuthority(db, authority.ledger);
    const bindings: LifecycleBindings = { assertActive: actor => assertActive(db, actor),
      withActiveWrite: (actor, effect) => withActiveWrite(db, actor, effect), adultEligibility: actor => adultEligibility(db, actor) };
    const domain = new Domain(db);
    const actors = ['one', 'two'].map(id => {
      db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id, id, `${id}@synthetic.invalid`, Date.now(), Date.now());
      const accountId = domain.account(id, id);
      db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(id, id, `synthetic-${id}`, Date.now() + 600000, Date.now(), Date.now());
      return { accountId, authUserId: id, sessionId: id, epoch: 0 } satisfies AccountContext;
    });
    const modules = createSourceAccountModules(db, bindings);
    const existing = createSourceRequestFactories({ db, lifecycle: bindings, configuration: requestConfiguration,
      subjectEligibilityFor: actor => accountId => subjectEligibility(db, actor, accountId) });
    return { db, bindings, modules, existing, ...authority, one: actors[0]!, two: actors[1]!, close: () => db.close() };
  } catch (error) { db.close(); throw error; }
}
