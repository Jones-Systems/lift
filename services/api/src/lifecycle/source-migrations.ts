import { createHash } from 'node:crypto';
import type { Migration } from '../storage.js';
import { runtimeMigrations } from '../runtime-modules/migrations.js';
import { selectAccountModuleMigrations, appendSourceBodyMeasurementMigration, appendSourceReportedLoadMigration,
  appendSourceManualRetentionMigration, assertSourceManualRetentionSelection, assertSourceReportedLoadSelection,
  assertSourceManualRetentionHistory, assertSourceReportedLoadHistory, type SourceMigrationReceipt } from '../integration/account-modules/migrations.js';
import { sourceLifecycleEvidenceMigration } from './evidence-migration.js';

const digest = (sql: string) => createHash('sha256').update(sql).digest('hex');
export function selectSourceLifecycleEvidenceMigrations(): readonly Migration[] {
  const source20 = selectAccountModuleMigrations({ mode: 'source-only',
    modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, runtimeMigrations);
  const source23 = appendSourceManualRetentionMigration(appendSourceReportedLoadMigration(appendSourceBodyMeasurementMigration(source20)));
  return Object.freeze([...source23, sourceLifecycleEvidenceMigration].map(entry => Object.freeze({ ...entry })));
}
export function assertSourceLifecycleEvidenceSelection(selected: readonly Migration[]): void {
  const genuine = selectSourceLifecycleEvidenceMigrations();
  if (selected.length !== 24 || selected.some((entry, index) => entry.version !== index + 1 || digest(entry.sql) !== digest(genuine[index]!.sql)))
    throw new Error('lifecycle_evidence_selection_invalid');
  assertSourceManualRetentionSelection(selected.slice(0, 23));
  assertSourceReportedLoadSelection(selected.slice(0, 23));
}
export function assertSourceLifecycleEvidenceHistory(applied: readonly SourceMigrationReceipt[], complete = false): void {
  const genuine = selectSourceLifecycleEvidenceMigrations();
  if (applied.length > 24 || (complete && applied.length !== 24) || applied.some((entry, index) =>
    entry.version !== index + 1 || entry.checksum !== digest(genuine[index]!.sql))) throw new Error('lifecycle_evidence_history_invalid');
  const prefix = applied.slice(0, 23);
  assertSourceManualRetentionHistory(prefix, complete);
  assertSourceReportedLoadHistory(prefix, complete);
}
