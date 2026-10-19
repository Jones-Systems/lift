export { CommunityService, createCommunity } from './service.js';
export { communityMigration, communityMigrationSql } from './migration.js';
export { createCommunityRoutes, COMMUNITY_BODY_MAX_BYTES, type CommunityRouteDependencies, type CommunityRequestService, type CommunityRouteEnvironment } from './routes.js';
export { createCommunityLifecycleAdapter, type CommunityLifecycleOptions } from './lifecycle.js';
export * from './types.js';
export { flagsSchema, createGroupSchema, sharingSchema, activityDaySchema, activityResultSchema, allFalse } from './schemas.js';

export { CommunityExtensionService, createCommunityExtension } from './extension-service.js';
export { createCommunityExtensionRoutes } from './extension-routes.js';
export { communityExtensionMigration, communityExtensionMigrationSql } from './extension-migration.js';
export { createCommunityExtensionLifecycleAdapter } from './extension-lifecycle.js';
export * from './extension-types.js';
export * from './board/index.js';
export { createCommunityIntegration, reconcileCommunityIntegrationRestore, type CommunityIntegrationDependencies, type CommunityIntegrationServices } from './integration.js';
export { createComposedCommunityLifecycleAdapter, type CommunityAdapterSet, type CommunityModuleResults, type ComposedCommunityResult, type ComposedCommunityLifecycleAdapter, type CommunityCompositionOptions } from './composed-lifecycle.js';
export { COMMUNITY_EXPORT_MAX_BYTES, COMMUNITY_EXPORT_MAX_ROWS, type CommunityExportBounds } from './export-bounds.js';
export { communityRemovalSnapshotsMigrationSql } from './removal-snapshots.js';
