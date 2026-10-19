/** Additive dormant schema; WS01 assigns a migration version and owns activation/backup. */
export const familyMembershipMigrationSql = `
CREATE TABLE family_memberships (
 id TEXT PRIMARY KEY,
 owner_account_id TEXT NOT NULL UNIQUE REFERENCES form_accounts(id),
 total_seats INTEGER NOT NULL CHECK(total_seats >= 1),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
 suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN(0,1))
);
CREATE TABLE family_members (
 account_id TEXT PRIMARY KEY REFERENCES form_accounts(id),
 family_id TEXT NOT NULL REFERENCES family_memberships(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN('owner','member'))
);
CREATE INDEX family_members_family ON family_members(family_id);
CREATE UNIQUE INDEX family_one_owner ON family_members(family_id) WHERE role='owner';
CREATE TABLE family_invitations (
 id TEXT PRIMARY KEY,
 family_id TEXT NOT NULL REFERENCES family_memberships(id) ON DELETE CASCADE,
 invitee_account_id TEXT NOT NULL REFERENCES form_accounts(id),
 status TEXT NOT NULL CHECK(status IN('pending','accepted','revoked'))
);
CREATE UNIQUE INDEX family_pending_invitee ON family_invitations(family_id,invitee_account_id) WHERE status='pending';
CREATE INDEX family_invitations_invitee ON family_invitations(invitee_account_id,status);
CREATE TABLE family_command_receipts (
 account_id TEXT NOT NULL REFERENCES form_accounts(id),
 idempotency_key TEXT NOT NULL,
 intent_hash TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(json_valid(outcome)),
 PRIMARY KEY(account_id,idempotency_key)
);
CREATE TABLE family_account_suppression (
 account_id TEXT PRIMARY KEY REFERENCES form_accounts(id),
 epoch INTEGER NOT NULL CHECK(epoch >= 0)
);
CREATE TRIGGER family_member_capacity BEFORE INSERT ON family_members
 WHEN (SELECT count(*) FROM family_members WHERE family_id=NEW.family_id)
 >= (SELECT total_seats FROM family_memberships WHERE id=NEW.family_id)
 BEGIN SELECT RAISE(ABORT,'family_capacity_exceeded'); END;
CREATE TRIGGER family_owner_identity BEFORE INSERT ON family_members
 WHEN (NEW.role='owner') <> (NEW.account_id=(SELECT owner_account_id FROM family_memberships WHERE id=NEW.family_id))
 BEGIN SELECT RAISE(ABORT,'family_owner_mismatch'); END;
CREATE TRIGGER family_immutable_member BEFORE UPDATE ON family_members
 BEGIN SELECT RAISE(ABORT,'family_member_identity_immutable'); END;
CREATE TRIGGER family_immutable_owner BEFORE UPDATE OF id,owner_account_id,total_seats ON family_memberships
 BEGIN SELECT RAISE(ABORT,'family_configuration_immutable'); END;
CREATE TRIGGER family_immutable_invitation BEFORE UPDATE OF id,family_id,invitee_account_id ON family_invitations
 BEGIN SELECT RAISE(ABORT,'family_invitation_identity_immutable'); END;
CREATE TRIGGER family_immutable_receipt BEFORE UPDATE ON family_command_receipts
 BEGIN SELECT RAISE(ABORT,'family_receipt_immutable'); END;
`;
