import { createHash } from 'node:crypto';
import type { Migration } from '../../storage.js';
import { selectSourceLifecycleEvidenceMigrations, assertSourceLifecycleEvidenceHistory,
  assertSourceLifecycleEvidenceSelection } from '../source-migrations.js';
import { sourceProviderRevocationMigration } from './outbox-migration.js';
const digest = (sql: string) => createHash('sha256').update(sql).digest('hex');
export function selectSourceProviderRevocationMigrations(): readonly Migration[] {
  return Object.freeze([...selectSourceLifecycleEvidenceMigrations(), sourceProviderRevocationMigration].map(entry => Object.freeze({ ...entry })));
}
export function assertSourceProviderRevocationSelection(selected: readonly Migration[]): void {
  const genuine = selectSourceProviderRevocationMigrations();
  if (selected.length !== 25 || selected.some((entry, index) => entry.version !== index + 1 || digest(entry.sql) !== digest(genuine[index]!.sql)))
    throw new Error('provider_revocation_selection_invalid');
  assertSourceLifecycleEvidenceSelection(selected.slice(0, 24));
}
export function assertSourceProviderRevocationHistory(applied: readonly { version: number; checksum: string }[], complete = false): void {
  const genuine = selectSourceProviderRevocationMigrations();
  if (applied.length > 25 || (complete && applied.length !== 25) || applied.some((entry, index) =>
    entry.version !== index + 1 || entry.checksum !== digest(genuine[index]!.sql))) throw new Error('provider_revocation_history_invalid');
  assertSourceLifecycleEvidenceHistory(applied.slice(0, 24), complete);
}
