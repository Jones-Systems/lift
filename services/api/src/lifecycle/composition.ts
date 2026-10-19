import { migrations, type Migration } from '../storage.js';
import { lifecycleMigration } from './migration.js';
import { mascotPreferencesMigration } from './preferences-migration.js';
import { usageMigrationVersion, usageMigrationSql } from '../usage-limits/migration.js';
import { bugIntakeMigrationSql } from '../bug-intake/migration.js';
import { communityRemovalSnapshotsMigrationSql } from '../community/removal-snapshots.js';

export const accountUsageMigration = Object.freeze({ version: usageMigrationVersion, sql: usageMigrationSql });
export const accountBugIntakeMigration = Object.freeze({ version: 15, sql: bugIntakeMigrationSql });
export const communityRemovalSnapshotsMigration = Object.freeze({ version: 16, sql: communityRemovalSnapshotsMigrationSql });

// Call only with the root-accepted actual module migrations, never reservation placeholders.
export type CommunityAdditiveMigrations = Readonly<{ extension: Migration; board: Migration }>;

export function composeAccountMigrations(activity: Migration, community: Migration,
  additions?: CommunityAdditiveMigrations): readonly Migration[] {
  if (activity.version !== 8 || community.version !== 9 || !activity.sql.trim() || !community.sql.trim())
    throw new Error('Actual stable activity8/community9 migrations required');
  if (additions && (additions.extension?.version !== 12 || additions.board?.version !== 13 ||
    !additions.extension.sql.trim() || !additions.board.sql.trim()))
    throw new Error('Actual stable community extension12/board13 migrations required together');
  return [...migrations, activity, community, lifecycleMigration, mascotPreferencesMigration,
    ...(additions ? [additions.extension, additions.board, accountUsageMigration, accountBugIntakeMigration, communityRemovalSnapshotsMigration] : [])];
}
