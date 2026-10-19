export const communityExtensionMigrationSql = `
CREATE TABLE community_group_policy (
 group_id TEXT PRIMARY KEY REFERENCES community_groups(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind='matched'), intent TEXT NOT NULL CHECK(intent IN('accountability','supportive_community')),
 capacity INTEGER NOT NULL CHECK(capacity BETWEEN 4 AND 20), revision INTEGER NOT NULL CHECK(revision>=1),
 terms_version TEXT NOT NULL CHECK(terms_version='community-v1'), last_growth_at TEXT
);
CREATE TABLE community_match_enrollments (
 id TEXT NOT NULL UNIQUE, account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1), generation INTEGER NOT NULL CHECK(generation>=1),
 state TEXT NOT NULL CHECK(state IN('queued','cancelled','assigned')), preferences TEXT CHECK(preferences IS NULL OR length(CAST(preferences AS BLOB))<=8192),
 queued_at TEXT, consent_at TEXT, cooldown_until TEXT, missed_batches INTEGER NOT NULL DEFAULT 0 CHECK(missed_batches>=0),
 CHECK(state<>'queued' OR (preferences IS NOT NULL AND queued_at IS NOT NULL AND consent_at IS NOT NULL))
);
CREATE INDEX community_enrollment_queue ON community_match_enrollments(state,queued_at,id);
CREATE TABLE community_match_runs (
 id TEXT PRIMARY KEY, policy_version TEXT NOT NULL, zone TEXT NOT NULL, cutoff_local_date TEXT NOT NULL,
 intent TEXT NOT NULL, language TEXT NOT NULL, policy TEXT NOT NULL CHECK(length(CAST(policy AS BLOB))<=8192),
 input_digest TEXT NOT NULL CHECK(length(input_digest)=64), snapshot TEXT NOT NULL CHECK(length(CAST(snapshot AS BLOB))<=524288),
 state TEXT NOT NULL CHECK(state IN('frozen','applied','missed','pending')), attempt_id TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(policy_version,zone,cutoff_local_date,intent,language)
);
CREATE TABLE community_match_assignments (
 id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES community_match_enrollments(id), enrollment_generation INTEGER NOT NULL CHECK(enrollment_generation>=1),
 consent_revision INTEGER NOT NULL CHECK(consent_revision>=1), run_id TEXT NOT NULL REFERENCES community_match_runs(id),
 group_id TEXT NOT NULL REFERENCES community_groups(id), account_id TEXT NOT NULL, member_generation INTEGER NOT NULL CHECK(member_generation>=1),
 relaxation TEXT NOT NULL CHECK(length(CAST(relaxation AS BLOB))<=512), created_at TEXT NOT NULL, UNIQUE(enrollment_id,enrollment_generation),
 FOREIGN KEY(group_id,account_id) REFERENCES community_members(group_id,account_id)
);
CREATE INDEX community_assignment_account ON community_match_assignments(account_id,group_id);
CREATE TABLE community_profile_shares (
 group_id TEXT NOT NULL, account_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1), revision INTEGER NOT NULL CHECK(revision>=1),
 profile TEXT NOT NULL CHECK(length(CAST(profile AS BLOB))<=8192), updated_at TEXT NOT NULL,
 PRIMARY KEY(group_id,account_id), FOREIGN KEY(group_id,account_id) REFERENCES community_members(group_id,account_id) ON DELETE CASCADE
);
CREATE TABLE community_blocks (
 id TEXT NOT NULL UNIQUE, owner_account_id TEXT NOT NULL, subject_account_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
 active INTEGER NOT NULL CHECK(active IN(0,1)), created_at TEXT NOT NULL, CHECK(owner_account_id<>subject_account_id), PRIMARY KEY(owner_account_id,subject_account_id)
);
CREATE INDEX community_blocks_subject ON community_blocks(subject_account_id,active);
CREATE TABLE community_motions (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE, group_generation INTEGER NOT NULL,
 sponsor_account_id TEXT NOT NULL, sponsor_generation INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN('growth','friend','removal')),
 subject_account_id TEXT, subject_generation INTEGER, places INTEGER NOT NULL CHECK(places BETWEEN 1 AND 4),
 revision INTEGER NOT NULL CHECK(revision>=1), electorate_size INTEGER NOT NULL CHECK(electorate_size>=3), required_yes INTEGER NOT NULL CHECK(required_yes>=3),
 state TEXT NOT NULL CHECK(state IN('open','passed','expired','review_pending','cancelled')), created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at), finalized_at TEXT,
 CHECK((kind='removal' AND subject_account_id IS NOT NULL AND subject_generation IS NOT NULL) OR (kind<>'removal' AND subject_account_id IS NULL AND subject_generation IS NULL))
);
CREATE INDEX community_motion_group_expiry ON community_motions(group_id,state,expires_at);
CREATE INDEX community_motion_sponsor ON community_motions(sponsor_account_id,created_at);
CREATE TABLE community_motion_electorate (
 motion_id TEXT NOT NULL REFERENCES community_motions(id) ON DELETE CASCADE, account_id TEXT NOT NULL, membership_generation INTEGER NOT NULL,
 active INTEGER NOT NULL CHECK(active IN(0,1)), PRIMARY KEY(motion_id,account_id)
);
CREATE TABLE community_ballots (
 motion_id TEXT NOT NULL, account_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), choice TEXT NOT NULL CHECK(choice IN('yes','no','abstain')),
 updated_at TEXT NOT NULL, PRIMARY KEY(motion_id,account_id), FOREIGN KEY(motion_id,account_id) REFERENCES community_motion_electorate(motion_id,account_id) ON DELETE CASCADE
);
CREATE TABLE community_seat_reservations (
 id TEXT PRIMARY KEY, motion_id TEXT NOT NULL UNIQUE REFERENCES community_motions(id) ON DELETE CASCADE,
 group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE, group_generation INTEGER NOT NULL,
 sponsor_account_id TEXT NOT NULL, sponsor_generation INTEGER NOT NULL, seats INTEGER NOT NULL CHECK(seats BETWEEN 1 AND 4),
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed>=0 AND consumed<=seats), state TEXT NOT NULL CHECK(state IN('available','cancelled','consumed')),
 expires_at TEXT NOT NULL, invitation_id TEXT UNIQUE REFERENCES community_invitations(id), run_id TEXT REFERENCES community_match_runs(id)
);
CREATE INDEX community_reservation_capacity ON community_seat_reservations(group_id,state,expires_at);
CREATE TABLE community_posts (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE, group_generation INTEGER NOT NULL,
 author_account_id TEXT NOT NULL, membership_generation INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
 kind TEXT NOT NULL CHECK(kind IN('check_in','win')), template TEXT CHECK(template IN('checking_in','at_my_pace')),
 text TEXT CHECK(text IS NULL OR length(CAST(text AS BLOB))<=2048), state TEXT NOT NULL CHECK(state IN('pending','published','hidden','rejected')),
 policy_version TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at),
 FOREIGN KEY(group_id,author_account_id) REFERENCES community_members(group_id,account_id),
 CHECK((kind='check_in' AND template IS NOT NULL AND text IS NULL) OR (kind='win' AND template IS NULL))
);
CREATE INDEX community_post_audience ON community_posts(group_id,state,expires_at,created_at);
CREATE INDEX community_post_author ON community_posts(author_account_id,group_id,created_at);
CREATE TABLE community_reactions (
 post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE, account_id TEXT NOT NULL, membership_generation INTEGER NOT NULL,
 reaction TEXT NOT NULL CHECK(reaction IN('cheer','thanks','with_you')), active INTEGER NOT NULL CHECK(active IN(0,1)), revision INTEGER NOT NULL CHECK(revision>=1),
 updated_at TEXT NOT NULL, PRIMARY KEY(post_id,account_id,reaction)
);
CREATE INDEX community_reaction_account ON community_reactions(account_id,updated_at);
CREATE TABLE community_safety_references (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
 resource_kind TEXT NOT NULL CHECK(resource_kind IN('member','post')), resource_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX community_safety_reference_owner ON community_safety_references(account_id,expires_at);
CREATE TABLE community_reports (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, safety_reference TEXT REFERENCES community_safety_references(id),
 category TEXT NOT NULL CHECK(category IN('harassment','privacy','danger','other')), text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=2048),
 state TEXT NOT NULL CHECK(state IN('pending','closed')), revision INTEGER NOT NULL CHECK(revision>=1), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX community_report_owner ON community_reports(account_id,created_at);
CREATE UNIQUE INDEX community_report_duplicate ON community_reports(account_id,safety_reference,category) WHERE state='pending' AND safety_reference IS NOT NULL;
CREATE TABLE community_safety_notices (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
 reason TEXT NOT NULL CHECK(length(CAST(reason AS BLOB))<=2048), rule TEXT NOT NULL CHECK(length(rule)<=100), revision INTEGER NOT NULL CHECK(revision>=1),
 state TEXT NOT NULL CHECK(state IN('active','expired')), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, appeal_until TEXT NOT NULL,
 review_binding TEXT NOT NULL CHECK(length(review_binding)<=128)
);
CREATE INDEX community_notice_owner ON community_safety_notices(account_id,expires_at);
CREATE TABLE community_appeals (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, notice_id TEXT NOT NULL REFERENCES community_safety_notices(id) ON DELETE CASCADE,
 text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=2048), revision INTEGER NOT NULL CHECK(revision>=1), state TEXT NOT NULL CHECK(state IN('pending','upheld','overturned')),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, UNIQUE(account_id,notice_id)
);
CREATE TABLE community_post_cursors (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
 group_generation INTEGER NOT NULL, membership_generation INTEGER NOT NULL, before_created_at TEXT NOT NULL, before_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX community_cursor_owner ON community_post_cursors(account_id,expires_at);
CREATE TABLE community_extension_receipts (
 account_id TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 128), intent_hash TEXT NOT NULL CHECK(length(intent_hash)=64),
 effect_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(account_id,operation,key)
);
CREATE INDEX community_extension_receipt_expiry ON community_extension_receipts(account_id,expires_at);
`;
export const communityExtensionMigration = Object.freeze({ version: 12, sql: communityExtensionMigrationSql });
