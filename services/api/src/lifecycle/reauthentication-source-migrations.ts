import { createHash } from 'node:crypto';
import type { Migration, Sqlite } from '../storage.js';
import { DomainError } from '../errors.js';
import { selectSourceProviderRevocationMigrations, assertSourceProviderRevocationSelection,
  assertSourceProviderRevocationHistory } from './providers/source-migrations.js';
import { sourceActionReauthenticationMigration, assertActionReauthenticationSchema } from './reauthentication-migration.js';

const digest = (sql: string) => createHash('sha256').update(sql).digest('hex');
export function selectSourceActionReauthenticationMigrations(): readonly Migration[] {
  return Object.freeze([...selectSourceProviderRevocationMigrations(), sourceActionReauthenticationMigration].map(entry => Object.freeze({ ...entry })));
}
export function assertSourceActionReauthenticationSelection(selected: readonly Migration[]): void {
  const genuine = selectSourceActionReauthenticationMigrations();
  if (selected.length !== 26 || selected.some((entry, index) => entry.version !== index + 1 || digest(entry.sql) !== digest(genuine[index]!.sql)))
    throw new Error('action_reauthentication_selection_invalid');
  assertSourceProviderRevocationSelection(selected.slice(0, 25));
}
export function assertSourceActionReauthenticationHistory(applied: readonly { version: number; checksum: string }[], complete = false): void {
  const genuine = selectSourceActionReauthenticationMigrations();
  if (applied.length > 26 || (complete && applied.length !== 26) || applied.some((entry, index) =>
    entry.version !== index + 1 || entry.checksum !== digest(genuine[index]!.sql))) throw new Error('action_reauthentication_history_invalid');
  assertSourceProviderRevocationHistory(applied.slice(0, 25), complete);
}
// Schema-bound Source25 intents cannot be adopted across the new all-schema digest.
export function assertActionReauthenticationPreflight(db: Sqlite, selected: boolean): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='form_migrations'").get();
  const history = exists ? db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as
    { version: number; checksum: string }[] : [];
  const installed = history.some(row => row.version === 26);
  assertActionReauthenticationSchema(db, installed && selected);
  if (!selected) {
    if (installed) throw new DomainError(503, 'action_reauthentication_selection_required');
    return;
  }
  assertSourceActionReauthenticationHistory(history);
  if (!installed && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_provider_revocation_intents'").get() &&
    db.prepare('SELECT 1 FROM account_provider_revocation_intents LIMIT 1').get())
    throw new DomainError(503, 'action_reauthentication_upgrade_held');
}
