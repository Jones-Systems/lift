export { createProgressComparisonService, ProgressComparisonService } from './service.js';
export { createProgressComparisonLifecycleAdapter } from './lifecycle.js';
export { progressComparisonMigrationSql, progressComparisonOwnedTables, progressComparisonPurgeOrder } from './migration.js';
export type { ProgressComparisonDependencies, StoredIdentity, PerformedIdentity, IdentityProvenance,
  SourceSelection, ComparisonSelection, FreshComparisonWitness, ComparisonSourceScope, ComparisonInputWitness,
  ComparisonContextInput, AssertComparisonContextWithinWrite, ComparisonRead } from './persistence-types.js';
