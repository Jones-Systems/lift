export { createFeatureBoard, FeatureBoardService } from './service.js';
export { createFeatureBoardRoutes, FEATURE_BOARD_BODY_MAX_BYTES } from './routes.js';
export type { FeatureBoardRouteDependencies, FeatureBoardRouteEnvironment } from './routes.js';
export { createFeatureBoardLifecycleAdapter } from './lifecycle.js';
export type { FeatureBoardLifecycleOptions } from './lifecycle.js';
export { featureBoardMigrationSql, featureBoardMigrationVersion } from './migration.js';
export * from './types.js';

export { featureBoardCorrectionMigrationSql, featureBoardCorrectionMigrationVersion } from './correction-migration.js';
