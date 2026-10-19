export const featureBoardMigrationVersion = 13;
export const featureBoardMigrationSql = `
CREATE TABLE community_board_features (
 id TEXT PRIMARY KEY, category TEXT NOT NULL CHECK(category IN ('general','workouts','plans','coaching','accessibility','community','settings')),
 status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','under_consideration','planned','in_progress','released','not_planned')),
 status_reason TEXT, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), created_at TEXT NOT NULL
);
CREATE TABLE community_board_submissions (
 id TEXT PRIMARY KEY, feature_id TEXT NOT NULL UNIQUE REFERENCES community_board_features(id), author_account_id TEXT,
 title TEXT NOT NULL CHECK(length(title)<=100), description TEXT NOT NULL CHECK(length(description)<=2000),
 category TEXT NOT NULL, policy_version TEXT NOT NULL, audience_accepted INTEGER NOT NULL CHECK(audience_accepted=1),
 visibility TEXT NOT NULL CHECK(visibility IN ('pending','published','hidden','withdrawn')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), created_at TEXT NOT NULL, suppressed_epoch INTEGER,
 moderation_version INTEGER NOT NULL DEFAULT 0, restore_barrier INTEGER NOT NULL DEFAULT 0 CHECK(restore_barrier IN(0,1)), redacted INTEGER NOT NULL DEFAULT 0 CHECK(redacted IN(0,1))
);
CREATE TABLE community_board_aliases (
 source_id TEXT PRIMARY KEY REFERENCES community_board_features(id), target_id TEXT NOT NULL REFERENCES community_board_features(id),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), CHECK(source_id<>target_id)
);
CREATE TABLE community_board_votes (
 feature_id TEXT NOT NULL REFERENCES community_board_features(id), account_id TEXT NOT NULL,
 active INTEGER NOT NULL CHECK(active IN(0,1)), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), updated_at TEXT NOT NULL,
 PRIMARY KEY(feature_id,account_id)
);
CREATE TABLE community_board_vote_events (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, origin_feature_id TEXT NOT NULL REFERENCES community_board_features(id),
 canonical_feature_id TEXT NOT NULL REFERENCES community_board_features(id), active INTEGER NOT NULL CHECK(active IN(0,1)), created_at TEXT NOT NULL
);
CREATE TABLE community_board_merge_events (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES community_board_features(id), target_id TEXT NOT NULL REFERENCES community_board_features(id),
 actor_account_id TEXT, source_revision INTEGER NOT NULL, target_revision INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE community_board_status_events (
 id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES community_board_features(id), actor_account_id TEXT,
 old_status TEXT NOT NULL, new_status TEXT NOT NULL, expected_revision INTEGER NOT NULL, reason TEXT NOT NULL, evidence TEXT, created_at TEXT NOT NULL
);
CREATE TABLE community_board_command_receipts (
 account_id TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL, intent_hash TEXT NOT NULL,
 effect_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(account_id,operation,key)
);
CREATE TABLE community_board_quota_events (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN('submit','vote','search')), created_at TEXT NOT NULL
);
CREATE INDEX community_board_features_category_status ON community_board_features(category,status,created_at,id);
CREATE INDEX community_board_submissions_author ON community_board_submissions(author_account_id,created_at,id);
CREATE INDEX community_board_submissions_visibility ON community_board_submissions(visibility,feature_id);
CREATE INDEX community_board_aliases_target ON community_board_aliases(target_id);
CREATE INDEX community_board_votes_account ON community_board_votes(account_id,active,feature_id);
CREATE INDEX community_board_votes_active ON community_board_votes(feature_id,active,account_id);
CREATE INDEX community_board_vote_events_account ON community_board_vote_events(account_id,created_at,id);
CREATE INDEX community_board_merge_events_actor ON community_board_merge_events(actor_account_id);
CREATE INDEX community_board_status_events_actor ON community_board_status_events(actor_account_id);
CREATE INDEX community_board_quota_events_account ON community_board_quota_events(account_id,action,created_at);
`;
