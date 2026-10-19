import type Database from 'better-sqlite3';
import { DomainError } from '../errors.js';

export const communityRemovalSnapshotsMigrationSql = `
CREATE TABLE community_removal_snapshots (
 group_id TEXT NOT NULL, account_id TEXT NOT NULL, member_id TEXT NOT NULL,
 membership_generation INTEGER NOT NULL CHECK(membership_generation>=1), removed_at TEXT NOT NULL, membership_ended_at TEXT NOT NULL,
 group_generation_at_removal INTEGER NOT NULL CHECK(group_generation_at_removal>=1),
 group_label_at_removal TEXT CHECK(group_label_at_removal IS NULL OR length(group_label_at_removal) BETWEEN 1 AND 80),
 PRIMARY KEY(group_id,account_id),
 FOREIGN KEY(group_id,account_id) REFERENCES community_members(group_id,account_id) ON DELETE CASCADE
);
CREATE INDEX community_removal_snapshot_account ON community_removal_snapshots(account_id,group_id);
CREATE TRIGGER community_removal_snapshot_membership_changed
AFTER UPDATE OF state,member_id,generation,ended_at ON community_members
WHEN NEW.state<>'removed' OR NEW.member_id<>OLD.member_id OR NEW.generation<>OLD.generation OR NEW.ended_at IS NOT OLD.ended_at
BEGIN
 DELETE FROM community_removal_snapshots WHERE group_id=NEW.group_id AND account_id=NEW.account_id;
END;
`;

export function captureRemovalSnapshot(db: Database.Database, groupId: string, accountId: string, groupLabel: string | null, removedAt: string): void {
  if (!db.inTransaction) throw new DomainError(503, 'community_lifecycle_serialization_required');
  const row = db.prepare(`SELECT m.member_id,m.generation,m.ended_at,g.generation AS group_generation
    FROM community_members m JOIN community_groups g ON g.id=m.group_id
    WHERE m.group_id=? AND m.account_id=? AND m.state='removed'`).get(groupId, accountId) as
    { member_id: string; generation: number; ended_at: string; group_generation: number } | undefined;
  if (!row) throw new DomainError(503, 'community_removal_snapshot_integrity');
  db.prepare(`INSERT INTO community_removal_snapshots(group_id,account_id,member_id,membership_generation,removed_at,membership_ended_at,group_generation_at_removal,group_label_at_removal)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(group_id,account_id) DO NOTHING`).run(groupId, accountId, row.member_id, row.generation, removedAt, row.ended_at, row.group_generation, groupLabel);
  const bound = db.prepare(`SELECT 1 FROM community_removal_snapshots WHERE group_id=? AND account_id=?
    AND member_id=? AND membership_generation=? AND membership_ended_at=? AND removed_at=?`).get(groupId, accountId, row.member_id, row.generation, row.ended_at, removedAt);
  if (!bound) throw new DomainError(503, 'community_removal_snapshot_integrity');
}

export const removalSnapshotExportSql = 'SELECT group_id,member_id,membership_generation,removed_at,membership_ended_at,group_generation_at_removal,group_label_at_removal FROM community_removal_snapshots WHERE account_id=? ORDER BY group_id';
