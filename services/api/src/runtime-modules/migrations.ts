import { activityMigration } from '../activity/migration.js';
import { communityMigration } from '../community/migration.js';
import { communityExtensionMigration } from '../community/extension-migration.js';
import { featureBoardMigrationVersion, featureBoardMigrationSql } from '../community/board/migration.js';
import { composeAccountMigrations } from '../lifecycle/composition.js';
import { hash } from '../storage.js';
export const moduleMigrations = Object.freeze({ activity: activityMigration, community: communityMigration,
  additions: { extension: communityExtensionMigration, board: { version: featureBoardMigrationVersion, sql: featureBoardMigrationSql } } });
export const runtimeMigrations = Object.freeze(composeAccountMigrations(moduleMigrations.activity, moduleMigrations.community, moduleMigrations.additions));
export const migrationDigests = Object.freeze(runtimeMigrations.map(entry => hash(entry.sql)));
