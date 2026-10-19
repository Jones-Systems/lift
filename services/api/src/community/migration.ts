import { shareFields } from './types.js';

export const communityMigrationSql = `
CREATE TABLE community_groups (
 id TEXT PRIMARY KEY, display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
 owner_account_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('active','closed')),
 revision INTEGER NOT NULL CHECK(revision>=1), generation INTEGER NOT NULL CHECK(generation>=1),
 created_at TEXT NOT NULL, closed_at TEXT,
 CHECK((state='active' AND closed_at IS NULL) OR (state='closed' AND closed_at IS NOT NULL))
);
CREATE TABLE community_members (
 group_id TEXT NOT NULL, account_id TEXT NOT NULL, member_id TEXT NOT NULL, alias TEXT NOT NULL CHECK(length(alias)<=60),
 role TEXT NOT NULL CHECK(role IN('owner','admin','member')), state TEXT NOT NULL CHECK(state IN('active','left','removed')),
 revision INTEGER NOT NULL CHECK(revision>=1), generation INTEGER NOT NULL CHECK(generation>=1), joined_at TEXT NOT NULL, ended_at TEXT,
 PRIMARY KEY(group_id,account_id), UNIQUE(group_id,member_id),
 CHECK((state='active' AND length(alias)>=1 AND ended_at IS NULL) OR (state<>'active' AND alias='' AND ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX community_one_owner ON community_members(group_id) WHERE state='active' AND role='owner';
CREATE INDEX community_member_accounts ON community_members(account_id,state,group_id);
CREATE INDEX community_roster ON community_members(group_id,state,member_id);
CREATE TABLE community_share_settings (
 group_id TEXT NOT NULL, account_id TEXT NOT NULL, membership_generation INTEGER NOT NULL CHECK(membership_generation>=1),
 revision INTEGER NOT NULL CHECK(revision>=1),
 ${shareFields.map(f => `${f} INTEGER NOT NULL CHECK(${f} IN(0,1)), ${f}_enabled_at TEXT CHECK((${f}=0 AND ${f}_enabled_at IS NULL) OR (${f}=1 AND ${f}_enabled_at IS NOT NULL))`).join(',\n ')},
 updated_at TEXT NOT NULL, PRIMARY KEY(group_id,account_id),
 CHECK(workoutMinutes<=workout AND exerciseCount<=workout AND streakDays<=planAdherence)
);
CREATE TABLE community_invitations (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL, group_generation INTEGER NOT NULL CHECK(group_generation>=1),
 issuer_account_id TEXT NOT NULL, issuer_membership_generation INTEGER NOT NULL CHECK(issuer_membership_generation>=1),
 token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'), scope TEXT NOT NULL CHECK(scope='join_member'),
 state TEXT NOT NULL CHECK(state IN('pending','redeemed','revoked')), revision INTEGER NOT NULL CHECK(revision>=1),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at),
 redeemed_account_id TEXT, member_generation INTEGER,
 CHECK((state='redeemed' AND redeemed_account_id IS NOT NULL AND member_generation IS NOT NULL AND member_generation>=1) OR
       (state<>'redeemed' AND redeemed_account_id IS NULL AND member_generation IS NULL))
);
CREATE INDEX community_live_invites ON community_invitations(group_id,state,expires_at);
CREATE INDEX community_issuer_invites ON community_invitations(issuer_account_id,state);
CREATE TABLE community_command_receipts (
 account_id TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 128),
 group_id TEXT, intent_hash TEXT NOT NULL CHECK(length(intent_hash)=64), status INTEGER NOT NULL CHECK(status IN(200,201)),
 effect_id TEXT NOT NULL, effect_generation INTEGER NOT NULL CHECK(effect_generation>=1), created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,operation,key)
);
`;
export const communityMigration = Object.freeze({ version: 9, sql: communityMigrationSql });
