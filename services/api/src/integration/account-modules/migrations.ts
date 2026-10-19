import { activityMigration } from '../../activity/migration.js';
import { communityMigration } from '../../community/migration.js';
import { communityExtensionMigration } from '../../community/extension-migration.js';
import { featureBoardMigrationVersion, featureBoardMigrationSql } from '../../community/board/migration.js';
import { featureBoardCorrectionMigrationVersion, featureBoardCorrectionMigrationSql } from '../../community/board/correction-migration.js';
import { composeAccountMigrations } from '../../lifecycle/composition.js';
export { accountBugIntakeMigration as sourceBugIntakeMigration } from '../../lifecycle/composition.js';
import { DomainError } from '../../errors.js';
import { hash, type Migration } from '../../storage.js';
import { progressComparisonMigrationSql } from '../../progress-comparison/migration.js';
import { feedbackMigrationSql } from '../../training-feedback/migration.js';
import { sourceReportedLoadMigration } from '../../source-reported-load-migration.js';
import { sourcePrescriptionMigration } from '../../source-prescription-migration.js';
import { sourceManualRetentionMigration } from '../../body/manual-retention-migration.js';
export { sourceManualRetentionMigration } from '../../body/manual-retention-migration.js';
import { manualMeasurementMigrationSql } from '../../body/manual-measurement-migration.js';

export type SourceAccountModuleConfiguration = Readonly<{ mode: 'source-only'; modules:
  'usage-and-bug-intake' | 'usage-bug-and-training-feedback' | 'usage-bug-training-feedback-and-source-prescription' |
  'usage-bug-training-feedback-source-prescription-and-board-correction' }>;
export const sourceProgressComparisonMigration: Migration = Object.freeze({ version: 17, sql: progressComparisonMigrationSql });
export const sourceFeedbackMigration: Migration = Object.freeze({ version: 18, sql: feedbackMigrationSql });
export const sourceBodyMeasurementMigration: Migration = Object.freeze({ version: 21, sql: manualMeasurementMigrationSql });
const genuineBase = composeAccountMigrations(activityMigration, communityMigration, {
  extension: communityExtensionMigration, board: { version: featureBoardMigrationVersion, sql: featureBoardMigrationSql },
});

export function selectAccountModuleMigrations(configuration: SourceAccountModuleConfiguration, base: readonly Migration[] | undefined): readonly Migration[] {
  if (configuration.mode !== 'source-only' || !['usage-and-bug-intake', 'usage-bug-and-training-feedback',
    'usage-bug-training-feedback-and-source-prescription', 'usage-bug-training-feedback-source-prescription-and-board-correction'].includes(configuration.modules) ||
      Object.keys(configuration).some(key => key !== 'mode' && key !== 'modules'))
    throw new DomainError(503, 'account_modules_configuration_invalid');
  if (!base || base.length !== 16 || genuineBase.length !== 16 ||
      base.some((entry, index) => entry.version !== index + 1 || hash(entry.sql) !== hash(genuineBase[index]!.sql)))
    throw new DomainError(503, 'account_modules_migration_prerequisites_required');
  return Object.freeze([...genuineBase, ...(configuration.modules !== 'usage-and-bug-intake'
    ? [sourceProgressComparisonMigration, sourceFeedbackMigration] : []),
  ...(['usage-bug-training-feedback-and-source-prescription', 'usage-bug-training-feedback-source-prescription-and-board-correction'].includes(configuration.modules)
    ? [sourcePrescriptionMigration] : []),
  ...(configuration.modules === 'usage-bug-training-feedback-source-prescription-and-board-correction'
    ? [{ version: featureBoardCorrectionMigrationVersion, sql: featureBoardCorrectionMigrationSql }] : [])]
    .map(entry => Object.freeze({ ...entry })));
}

export function appendSourceBodyMeasurementMigration(base: readonly Migration[] | undefined): readonly Migration[] {
  const genuineFull = selectAccountModuleMigrations({ mode: 'source-only',
    modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, genuineBase);
  if (!base || base.length !== 20 || genuineFull.length !== 20 ||
      base.some((entry, index) => entry.version !== index + 1 || hash(entry.sql) !== hash(genuineFull[index]!.sql)))
    throw new DomainError(503, 'body_measurement_migration_prerequisites_required');
  return Object.freeze([...genuineFull, sourceBodyMeasurementMigration].map(entry => Object.freeze({ ...entry })));
}

export type SourceMigrationReceipt = Readonly<{ version: number; checksum: string }>;
function genuineReportedLoadMigrations(body: boolean, retention = false): readonly Migration[] {
  const base = selectAccountModuleMigrations({ mode: 'source-only',
    modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, genuineBase);
  return [...base, ...(body ? [sourceBodyMeasurementMigration] : []), sourceReportedLoadMigration, ...(retention ? [sourceManualRetentionMigration] : [])];
}
export function assertSourceReportedLoadSelection(selected: readonly Migration[]): void {
  if (selected.some(entry => entry.version === 23) && !selected.some(entry => entry.version === 21))
    throw new DomainError(503, 'source_reported_load_migration_prerequisites_required');
  const genuine = genuineReportedLoadMigrations(selected.some(entry => entry.version === 21), selected.some(entry => entry.version === 23));
  if (selected.length !== genuine.length || selected.some((entry, index) =>
    entry.version !== genuine[index]!.version || hash(entry.sql) !== hash(genuine[index]!.sql)))
    throw new DomainError(503, 'source_reported_load_migration_prerequisites_required');
}
export function appendSourceReportedLoadMigration(base: readonly Migration[] | undefined): readonly Migration[] {
  const selected = base?.at(-1)?.version === 23
    ? [...base.slice(0, -1), sourceReportedLoadMigration, base.at(-1)!]
    : [...(base ?? []), sourceReportedLoadMigration];
  assertSourceReportedLoadSelection(selected);
  return Object.freeze(selected.map(entry => Object.freeze({ ...entry })));
}
export function assertSourceReportedLoadHistory(applied: readonly SourceMigrationReceipt[], complete = false): void {
  const genuine = genuineReportedLoadMigrations(applied.some(entry => entry.version === 21), applied.some(entry => entry.version === 23));
  const byVersion = new Map(genuine.map(entry => [entry.version, hash(entry.sql)]));
  const versions = new Set(applied.map(entry => entry.version));
  if (versions.size !== applied.length || applied.some(entry => byVersion.get(entry.version) !== entry.checksum))
    throw new DomainError(503, 'source_reported_load_migration_history_invalid');
  // Only a genuine prefix or the exact optional-Body extension is admissible. Missing prerequisites fail closed.
  const prefix = applied.filter(entry => entry.version <= 21).sort((a, b) => a.version - b.version);
  if (prefix.some((entry, index) => entry.version !== index + 1) ||
      (versions.has(22) && prefix.length < 20) || (versions.has(23) && prefix.length !== 21) || (complete && (!versions.has(22) || prefix.length < 20)))
    throw new DomainError(503, 'source_reported_load_migration_history_invalid');
}

function genuineManualRetentionMigrations(load: boolean): readonly Migration[] {
  const full = selectAccountModuleMigrations({ mode: 'source-only',
    modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, genuineBase);
  return [...full, sourceBodyMeasurementMigration, ...(load ? [sourceReportedLoadMigration] : []), sourceManualRetentionMigration];
}
export function assertSourceManualRetentionSelection(selected: readonly Migration[]): void {
  const genuine = genuineManualRetentionMigrations(selected.some(entry => entry.version === 22));
  if (selected.length !== genuine.length || selected.some((entry, index) =>
    entry.version !== genuine[index]!.version || hash(entry.sql) !== hash(genuine[index]!.sql)))
    throw new DomainError(503, 'body_manual_retention_migration_prerequisites_required');
}
export function appendSourceManualRetentionMigration(base: readonly Migration[] | undefined): readonly Migration[] {
  const selected = [...(base ?? []), sourceManualRetentionMigration];
  assertSourceManualRetentionSelection(selected);
  return Object.freeze(selected.map(entry => Object.freeze({ ...entry })));
}
export function assertSourceManualRetentionHistory(applied: readonly SourceMigrationReceipt[], complete = false): void {
  const genuine = genuineManualRetentionMigrations(applied.some(entry => entry.version === 22));
  const byVersion = new Map(genuine.map(entry => [entry.version, hash(entry.sql)]));
  const versions = new Set(applied.map(entry => entry.version));
  const prefix = applied.filter(entry => entry.version <= 21).sort((a, b) => a.version - b.version);
  if (versions.size !== applied.length || applied.some(entry => byVersion.get(entry.version) !== entry.checksum) ||
    prefix.some((entry, index) => entry.version !== index + 1) ||
    (versions.has(22) && prefix.length < 20) || (versions.has(23) && prefix.length !== 21) ||
    (complete && (!versions.has(23) || prefix.length !== 21)))
    throw new DomainError(503, 'body_manual_retention_migration_history_invalid');
}
