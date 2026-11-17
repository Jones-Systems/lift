import type { Migration, Sqlite } from '../storage.js';
import { DomainError } from '../errors.js';

export const actionReauthenticationMigrationSql = `CREATE TABLE account_action_challenge_budgets (
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 256 AND account_id NOT GLOB '*[^A-Za-z0-9_.:-]*') PRIMARY KEY REFERENCES form_accounts(id),
 auth_user_id TEXT NOT NULL CHECK(length(auth_user_id) BETWEEN 1 AND 256 AND auth_user_id NOT GLOB '*[^A-Za-z0-9_.:-]*') UNIQUE,
 binding_revision INTEGER NOT NULL CHECK(typeof(binding_revision)='integer' AND binding_revision BETWEEN 1 AND 9007199254740991), revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 request_window_ms INTEGER NOT NULL CHECK(typeof(request_window_ms)='integer' AND request_window_ms BETWEEN 0 AND 9007199254740991), request_count INTEGER NOT NULL CHECK(typeof(request_count)='integer' AND request_count BETWEEN 0 AND 20),
 send_window_ms INTEGER NOT NULL CHECK(typeof(send_window_ms)='integer' AND send_window_ms BETWEEN 0 AND 9007199254740991), send_count INTEGER NOT NULL CHECK(typeof(send_count)='integer' AND send_count BETWEEN 0 AND 3),
 verify_window_ms INTEGER NOT NULL CHECK(typeof(verify_window_ms)='integer' AND verify_window_ms BETWEEN 0 AND 9007199254740991), verify_count INTEGER NOT NULL CHECK(typeof(verify_count)='integer' AND verify_count BETWEEN 0 AND 5),
 last_seen_ms INTEGER NOT NULL CHECK(typeof(last_seen_ms)='integer' AND last_seen_ms BETWEEN 0 AND 9007199254740991),
 UNIQUE(account_id,auth_user_id),
 CHECK(last_seen_ms>=request_window_ms AND last_seen_ms>=send_window_ms AND last_seen_ms>=verify_window_ms)
);

CREATE TABLE account_action_challenges (
 id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 256 AND id NOT GLOB '*[^A-Za-z0-9_.:-]*') PRIMARY KEY,
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 256 AND account_id NOT GLOB '*[^A-Za-z0-9_.:-]*'), auth_user_id TEXT NOT NULL CHECK(length(auth_user_id) BETWEEN 1 AND 256 AND auth_user_id NOT GLOB '*[^A-Za-z0-9_.:-]*'), session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256 AND session_id NOT GLOB '*[^A-Za-z0-9_.:-]*'),
 lifecycle_epoch INTEGER NOT NULL CHECK(typeof(lifecycle_epoch)='integer' AND lifecycle_epoch BETWEEN 0 AND 9007199254740991),
 purpose TEXT NOT NULL CHECK(purpose IN('account_delete','account_export')),
 method TEXT NOT NULL CHECK(method IN('email_action_code','phone_action_code')),
 issue_key_digest TEXT NOT NULL CHECK(length(issue_key_digest)=64 AND issue_key_digest NOT GLOB '*[^a-f0-9]*'), nonce TEXT NOT NULL CHECK(length(nonce)=64 AND nonce NOT GLOB '*[^a-f0-9]*'), key_id TEXT NOT NULL CHECK(length(key_id) BETWEEN 1 AND 256 AND key_id NOT GLOB '*[^A-Za-z0-9_.:-]*'), code_mac TEXT NOT NULL CHECK(length(code_mac)=64 AND code_mac NOT GLOB '*[^a-f0-9]*'),
 subject_kind TEXT NOT NULL CHECK(subject_kind IN('verified_primary_email','verified_bound_phone')),
 provenance_id TEXT NOT NULL CHECK(length(provenance_id) BETWEEN 1 AND 256 AND provenance_id NOT GLOB '*[^A-Za-z0-9_.:-]*'), subject_digest TEXT NOT NULL CHECK(length(subject_digest)=64 AND subject_digest NOT GLOB '*[^a-f0-9]*'), provenance_digest TEXT NOT NULL CHECK(length(provenance_digest)=64 AND provenance_digest NOT GLOB '*[^a-f0-9]*'),
 binding_revision INTEGER NOT NULL CHECK(typeof(binding_revision)='integer' AND binding_revision BETWEEN 1 AND 9007199254740991), generation_digest TEXT NOT NULL CHECK(length(generation_digest)=64 AND generation_digest NOT GLOB '*[^a-f0-9]*'), continuity_digest TEXT NOT NULL CHECK(length(continuity_digest)=64 AND continuity_digest NOT GLOB '*[^a-f0-9]*'), schema_digest TEXT NOT NULL CHECK(length(schema_digest)=64 AND schema_digest NOT GLOB '*[^a-f0-9]*'),
 authority_id TEXT NOT NULL CHECK(length(authority_id) BETWEEN 1 AND 256 AND authority_id NOT GLOB '*[^A-Za-z0-9_.:-]*'), authority_schema_digest TEXT NOT NULL CHECK(length(authority_schema_digest)=64 AND authority_schema_digest NOT GLOB '*[^a-f0-9]*'),
 checkpoint_revision INTEGER NOT NULL CHECK(typeof(checkpoint_revision)='integer' AND checkpoint_revision BETWEEN 0 AND 9007199254740991), checkpoint_sequence INTEGER NOT NULL CHECK(typeof(checkpoint_sequence)='integer' AND checkpoint_sequence BETWEEN 0 AND 9007199254740991), checkpoint_head TEXT NOT NULL CHECK(length(checkpoint_head)=64 AND checkpoint_head NOT GLOB '*[^a-f0-9]*'),
 issued_at_ms INTEGER NOT NULL CHECK(typeof(issued_at_ms)='integer' AND issued_at_ms BETWEEN 0 AND 9007199254740991), expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms)='integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991), delivery_deadline_ms INTEGER NOT NULL CHECK(typeof(delivery_deadline_ms)='integer' AND delivery_deadline_ms BETWEEN 0 AND 9007199254740991),
 state TEXT NOT NULL CHECK(state IN('dispatching','ready','failed','unknown','invalidated','expired','consumed')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991), attempt_count INTEGER NOT NULL CHECK(typeof(attempt_count)='integer' AND attempt_count BETWEEN 0 AND 3),
 delivery_settled_at_ms INTEGER CHECK(delivery_settled_at_ms IS NULL OR (typeof(delivery_settled_at_ms)='integer' AND delivery_settled_at_ms BETWEEN issued_at_ms AND 9007199254740991)),
 consumed_at_ms INTEGER CHECK(consumed_at_ms IS NULL OR (typeof(consumed_at_ms)='integer' AND consumed_at_ms BETWEEN issued_at_ms AND expires_at_ms)),
 FOREIGN KEY(account_id,auth_user_id) REFERENCES account_action_challenge_budgets(account_id,auth_user_id),
 CHECK(expires_at_ms>issued_at_ms AND expires_at_ms-issued_at_ms<=300000),
 CHECK(delivery_deadline_ms>=issued_at_ms AND delivery_deadline_ms-issued_at_ms<=10000 AND delivery_deadline_ms<=expires_at_ms),
 CHECK((state='dispatching' AND delivery_settled_at_ms IS NULL) OR (state<>'dispatching' AND delivery_settled_at_ms IS NOT NULL)),
 CHECK((state='consumed' AND consumed_at_ms IS NOT NULL) OR (state<>'consumed' AND consumed_at_ms IS NULL)),
 CHECK((method='email_action_code' AND subject_kind='verified_primary_email') OR (method='phone_action_code' AND subject_kind='verified_bound_phone'))
);

CREATE TABLE account_action_proof_consumptions (
 challenge_id TEXT NOT NULL CHECK(length(challenge_id) BETWEEN 1 AND 256 AND challenge_id NOT GLOB '*[^A-Za-z0-9_.:-]*') PRIMARY KEY REFERENCES account_action_challenges(id),
 grant_hash TEXT NOT NULL CHECK(length(grant_hash)=64 AND grant_hash NOT GLOB '*[^a-f0-9]*'), proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64 AND proof_digest NOT GLOB '*[^a-f0-9]*'),
 verified_at_ms INTEGER NOT NULL CHECK(typeof(verified_at_ms)='integer' AND verified_at_ms BETWEEN 0 AND 9007199254740991), grant_expires_at_ms INTEGER NOT NULL CHECK(typeof(grant_expires_at_ms)='integer' AND grant_expires_at_ms BETWEEN 0 AND 9007199254740991),
 used_at_ms INTEGER CHECK(used_at_ms IS NULL OR (typeof(used_at_ms)='integer' AND used_at_ms BETWEEN verified_at_ms AND grant_expires_at_ms)),
 deletion_request_id TEXT REFERENCES account_deletion_requests(id),
 CHECK(grant_expires_at_ms>verified_at_ms AND grant_expires_at_ms-verified_at_ms<=300000),
 CHECK(deletion_request_id IS NULL OR used_at_ms IS NOT NULL)
);

CREATE UNIQUE INDEX action_challenge_issue ON account_action_challenges(account_id,issue_key_digest);

CREATE UNIQUE INDEX action_challenge_active ON account_action_challenges(account_id) WHERE state IN('dispatching','ready');

CREATE INDEX action_challenge_expiry ON account_action_challenges(state,expires_at_ms);

CREATE INDEX action_challenge_session ON account_action_challenges(session_id,state);

CREATE UNIQUE INDEX action_proof_grant ON account_action_proof_consumptions(grant_hash);

CREATE UNIQUE INDEX action_proof_request ON account_action_proof_consumptions(deletion_request_id) WHERE deletion_request_id IS NOT NULL;

CREATE INDEX action_phone_provenance ON phone_challenges(auth_user_id,phone,approved_at DESC,id) WHERE auth_user_id IS NOT NULL AND status='consumed';

CREATE TRIGGER action_budget_insert BEFORE INSERT ON account_action_challenge_budgets
 WHEN NEW.binding_revision<>1 OR NEW.revision<>1 OR NOT EXISTS(
 SELECT 1 FROM form_accounts f JOIN account_lifecycle l ON l.account_id=f.id
 WHERE f.id=NEW.account_id AND f.auth_user_id=NEW.auth_user_id AND l.state='active')
 BEGIN SELECT RAISE(ABORT,'action_budget_binding'); END;

CREATE TRIGGER action_budget_update BEFORE UPDATE ON account_action_challenge_budgets
 WHEN NEW.account_id IS NOT OLD.account_id OR NEW.auth_user_id IS NOT OLD.auth_user_id
 OR NEW.revision<>OLD.revision+1 OR NEW.binding_revision NOT IN(OLD.binding_revision,OLD.binding_revision+1)
 OR NEW.last_seen_ms<OLD.last_seen_ms OR NOT ((NEW.request_window_ms=OLD.request_window_ms AND NEW.request_count>=OLD.request_count) OR (NEW.request_window_ms>=OLD.request_window_ms+900000 AND NEW.request_window_ms<=NEW.last_seen_ms)) OR NOT ((NEW.send_window_ms=OLD.send_window_ms AND NEW.send_count>=OLD.send_count) OR (NEW.send_window_ms>=OLD.send_window_ms+3600000 AND NEW.send_window_ms<=NEW.last_seen_ms)) OR NOT ((NEW.verify_window_ms=OLD.verify_window_ms AND NEW.verify_count>=OLD.verify_count) OR (NEW.verify_window_ms>=OLD.verify_window_ms+900000 AND NEW.verify_window_ms<=NEW.last_seen_ms))
 BEGIN SELECT RAISE(ABORT,'action_budget_monotonic'); END;

CREATE TRIGGER action_budget_retained BEFORE DELETE ON account_action_challenge_budgets BEGIN SELECT RAISE(ABORT,'action_budget_retained'); END;

CREATE TRIGGER action_subject_contact_changed AFTER UPDATE OF email,emailVerified,phoneNumber,phoneNumberVerified ON "user"
 WHEN NEW.email IS NOT OLD.email OR NEW.emailVerified IS NOT OLD.emailVerified OR NEW.phoneNumber IS NOT OLD.phoneNumber OR NEW.phoneNumberVerified IS NOT OLD.phoneNumberVerified
 BEGIN UPDATE account_action_challenge_budgets SET binding_revision=binding_revision+1,revision=revision+1 WHERE auth_user_id=OLD.id; END;

CREATE TRIGGER action_subject_credential_insert AFTER INSERT ON account WHEN NEW.providerId='credential'
 BEGIN UPDATE account_action_challenge_budgets SET binding_revision=binding_revision+1,revision=revision+1 WHERE auth_user_id IN(NEW.userId); END;

CREATE TRIGGER action_subject_credential_update AFTER UPDATE ON account WHEN (NEW.providerId='credential' OR OLD.providerId='credential') AND (NEW.userId IS NOT OLD.userId OR NEW.providerId IS NOT OLD.providerId OR NEW.password IS NOT OLD.password)
 BEGIN UPDATE account_action_challenge_budgets SET binding_revision=binding_revision+1,revision=revision+1 WHERE auth_user_id IN(OLD.userId,NEW.userId); END;

CREATE TRIGGER action_subject_credential_delete AFTER DELETE ON account WHEN OLD.providerId='credential'
 BEGIN UPDATE account_action_challenge_budgets SET binding_revision=binding_revision+1,revision=revision+1 WHERE auth_user_id IN(OLD.userId); END;

CREATE TRIGGER action_subject_phone_provenance_changed AFTER UPDATE OF id,auth_user_id,phone,status,approved_at,provider_sid ON phone_challenges
 WHEN NEW.id IS NOT OLD.id OR NEW.auth_user_id IS NOT OLD.auth_user_id OR NEW.phone IS NOT OLD.phone OR NEW.status IS NOT OLD.status OR NEW.approved_at IS NOT OLD.approved_at OR NEW.provider_sid IS NOT OLD.provider_sid
 BEGIN UPDATE account_action_challenge_budgets SET binding_revision=binding_revision+1,revision=revision+1 WHERE auth_user_id IN(OLD.auth_user_id,NEW.auth_user_id); END;

CREATE TRIGGER action_subject_phone_provenance_removed AFTER DELETE ON phone_challenges
 BEGIN UPDATE account_action_challenge_budgets SET binding_revision=binding_revision+1,revision=revision+1 WHERE auth_user_id=OLD.auth_user_id; END;

CREATE TRIGGER action_session_deleted AFTER DELETE ON session
 BEGIN UPDATE account_action_challenges SET state='invalidated',revision=revision+1 WHERE session_id=OLD.id AND state='ready'; END;

CREATE TRIGGER action_challenge_insert BEFORE INSERT ON account_action_challenges
 WHEN NEW.state<>'dispatching' OR NEW.revision<>1 OR NEW.attempt_count<>0 OR NOT EXISTS(
 SELECT 1 FROM account_action_challenge_budgets b JOIN form_accounts f ON f.id=b.account_id
 JOIN account_lifecycle l ON l.account_id=f.id JOIN session s ON s.id=NEW.session_id AND s.userId=f.auth_user_id
 WHERE b.account_id=NEW.account_id AND b.auth_user_id=NEW.auth_user_id AND f.auth_user_id=NEW.auth_user_id
 AND b.binding_revision=NEW.binding_revision AND b.send_count>=1 AND l.state='active' AND l.epoch=NEW.lifecycle_epoch
 AND s.expiresAt>=NEW.expires_at_ms)
 BEGIN SELECT RAISE(ABORT,'action_challenge_binding'); END;

CREATE TRIGGER action_challenge_update BEFORE UPDATE ON account_action_challenges
 WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.auth_user_id IS NOT OLD.auth_user_id OR NEW.session_id IS NOT OLD.session_id OR NEW.lifecycle_epoch IS NOT OLD.lifecycle_epoch OR NEW.purpose IS NOT OLD.purpose OR NEW.method IS NOT OLD.method OR NEW.issue_key_digest IS NOT OLD.issue_key_digest OR NEW.nonce IS NOT OLD.nonce OR NEW.key_id IS NOT OLD.key_id OR NEW.code_mac IS NOT OLD.code_mac OR NEW.subject_kind IS NOT OLD.subject_kind OR NEW.provenance_id IS NOT OLD.provenance_id OR NEW.subject_digest IS NOT OLD.subject_digest OR NEW.provenance_digest IS NOT OLD.provenance_digest OR NEW.binding_revision IS NOT OLD.binding_revision OR NEW.generation_digest IS NOT OLD.generation_digest OR NEW.continuity_digest IS NOT OLD.continuity_digest OR NEW.schema_digest IS NOT OLD.schema_digest OR NEW.authority_id IS NOT OLD.authority_id OR NEW.authority_schema_digest IS NOT OLD.authority_schema_digest OR NEW.checkpoint_revision IS NOT OLD.checkpoint_revision OR NEW.checkpoint_sequence IS NOT OLD.checkpoint_sequence OR NEW.checkpoint_head IS NOT OLD.checkpoint_head OR NEW.issued_at_ms IS NOT OLD.issued_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms OR NEW.delivery_deadline_ms IS NOT OLD.delivery_deadline_ms
 OR NEW.revision<>OLD.revision+1 OR NEW.attempt_count<OLD.attempt_count OR NEW.attempt_count>OLD.attempt_count+1
 OR (OLD.delivery_settled_at_ms IS NOT NULL AND NEW.delivery_settled_at_ms IS NOT OLD.delivery_settled_at_ms)
 OR NOT ((OLD.state='dispatching' AND NEW.state IN('ready','failed','unknown','invalidated','expired') AND NEW.attempt_count=OLD.attempt_count)
 OR (OLD.state='ready' AND NEW.state IN('ready','failed','unknown','invalidated','expired','consumed')))
 BEGIN SELECT RAISE(ABORT,'action_challenge_transition'); END;

CREATE TRIGGER action_challenge_retained BEFORE DELETE ON account_action_challenges BEGIN SELECT RAISE(ABORT,'action_challenge_retained'); END;

CREATE TRIGGER action_proof_insert BEFORE INSERT ON account_action_proof_consumptions
 WHEN NEW.used_at_ms IS NOT NULL OR NEW.deletion_request_id IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM account_action_challenges c JOIN account_action_grants g ON g.token_hash=NEW.grant_hash
 WHERE c.id=NEW.challenge_id AND c.state='ready' AND c.attempt_count BETWEEN 1 AND 3
 AND c.issued_at_ms<=NEW.verified_at_ms AND NEW.verified_at_ms<c.expires_at_ms AND NEW.grant_expires_at_ms<=c.expires_at_ms
 AND g.account_id=c.account_id AND g.session_id=c.session_id AND g.epoch=c.lifecycle_epoch AND g.purpose=c.purpose AND g.method=c.method
 AND g.verified_at_ms=NEW.verified_at_ms AND g.expires_at_ms=NEW.grant_expires_at_ms AND g.consumed_at_ms IS NULL)
 BEGIN SELECT RAISE(ABORT,'action_proof_binding'); END;

CREATE TRIGGER action_proof_consume_challenge AFTER INSERT ON account_action_proof_consumptions
 BEGIN UPDATE account_action_challenges SET state='consumed',consumed_at_ms=NEW.verified_at_ms,revision=revision+1 WHERE id=NEW.challenge_id AND state='ready'; END;

CREATE TRIGGER action_proof_use BEFORE UPDATE ON account_action_proof_consumptions
 WHEN NEW.challenge_id IS NOT OLD.challenge_id OR NEW.grant_hash IS NOT OLD.grant_hash OR NEW.proof_digest IS NOT OLD.proof_digest
 OR NEW.verified_at_ms IS NOT OLD.verified_at_ms OR NEW.grant_expires_at_ms IS NOT OLD.grant_expires_at_ms
 OR OLD.used_at_ms IS NOT NULL OR NEW.used_at_ms IS NULL OR NEW.used_at_ms>=NEW.grant_expires_at_ms
 OR NOT EXISTS(SELECT 1 FROM account_action_challenges c JOIN account_action_grants g ON g.token_hash=NEW.grant_hash
 WHERE c.id=NEW.challenge_id AND c.state='consumed' AND g.consumed_at_ms IS NULL
 AND ((c.purpose='account_export' AND NEW.deletion_request_id IS NULL)
 OR (c.purpose='account_delete' AND EXISTS(SELECT 1 FROM account_deletion_requests r
 WHERE r.id=NEW.deletion_request_id AND r.account_id=c.account_id AND r.phase='awaiting_reauthentication'))))
 BEGIN SELECT RAISE(ABORT,'action_proof_single_use'); END;

CREATE TRIGGER action_proof_retained BEFORE DELETE ON account_action_proof_consumptions BEGIN SELECT RAISE(ABORT,'action_proof_retained'); END;
`;
export const sourceActionReauthenticationMigration: Readonly<Migration> = Object.freeze({ version: 26, sql: actionReauthenticationMigrationSql });
export const actionReauthenticationTables = Object.freeze(['account_action_challenge_budgets', 'account_action_challenges', 'account_action_proof_consumptions']);
export const actionReauthenticationSchemaObjects = Object.freeze([
  Object.freeze({ type: 'table', name: 'account_action_challenge_budgets', sql: actionReauthenticationMigrationSql.slice(0, 1521) }),
  Object.freeze({ type: 'table', name: 'account_action_challenges', sql: actionReauthenticationMigrationSql.slice(1524, 5976) }),
  Object.freeze({ type: 'table', name: 'account_action_proof_consumptions', sql: actionReauthenticationMigrationSql.slice(5979, 7023) }),
  Object.freeze({ type: 'index', name: 'action_challenge_issue', sql: actionReauthenticationMigrationSql.slice(7026, 7126) }),
  Object.freeze({ type: 'index', name: 'action_challenge_active', sql: actionReauthenticationMigrationSql.slice(7129, 7251) }),
  Object.freeze({ type: 'index', name: 'action_challenge_expiry', sql: actionReauthenticationMigrationSql.slice(7254, 7340) }),
  Object.freeze({ type: 'index', name: 'action_challenge_session', sql: actionReauthenticationMigrationSql.slice(7343, 7427) }),
  Object.freeze({ type: 'index', name: 'action_proof_grant', sql: actionReauthenticationMigrationSql.slice(7430, 7517) }),
  Object.freeze({ type: 'index', name: 'action_proof_request', sql: actionReauthenticationMigrationSql.slice(7520, 7656) }),
  Object.freeze({ type: 'index', name: 'action_phone_provenance', sql: actionReauthenticationMigrationSql.slice(7659, 7808) }),
  Object.freeze({ type: 'trigger', name: 'action_budget_insert', sql: actionReauthenticationMigrationSql.slice(7811, 8178) }),
  Object.freeze({ type: 'trigger', name: 'action_budget_update', sql: actionReauthenticationMigrationSql.slice(8181, 9122) }),
  Object.freeze({ type: 'trigger', name: 'action_budget_retained', sql: actionReauthenticationMigrationSql.slice(9125, 9268) }),
  Object.freeze({ type: 'trigger', name: 'action_subject_contact_changed', sql: actionReauthenticationMigrationSql.slice(9271, 9711) }),
  Object.freeze({ type: 'trigger', name: 'action_subject_credential_insert', sql: actionReauthenticationMigrationSql.slice(9714, 9964) }),
  Object.freeze({ type: 'trigger', name: 'action_subject_credential_update', sql: actionReauthenticationMigrationSql.slice(9967, 10372) }),
  Object.freeze({ type: 'trigger', name: 'action_subject_credential_delete', sql: actionReauthenticationMigrationSql.slice(10375, 10625) }),
  Object.freeze({ type: 'trigger', name: 'action_subject_phone_provenance_changed', sql: actionReauthenticationMigrationSql.slice(10628, 11160) }),
  Object.freeze({ type: 'trigger', name: 'action_subject_phone_provenance_removed', sql: actionReauthenticationMigrationSql.slice(11163, 11398) }),
  Object.freeze({ type: 'trigger', name: 'action_session_deleted', sql: actionReauthenticationMigrationSql.slice(11401, 11593) }),
  Object.freeze({ type: 'trigger', name: 'action_challenge_insert', sql: actionReauthenticationMigrationSql.slice(11596, 12292) }),
  Object.freeze({ type: 'trigger', name: 'action_challenge_update', sql: actionReauthenticationMigrationSql.slice(12295, 14151) }),
  Object.freeze({ type: 'trigger', name: 'action_challenge_retained', sql: actionReauthenticationMigrationSql.slice(14154, 14296) }),
  Object.freeze({ type: 'trigger', name: 'action_proof_insert', sql: actionReauthenticationMigrationSql.slice(14299, 15090) }),
  Object.freeze({ type: 'trigger', name: 'action_proof_consume_challenge', sql: actionReauthenticationMigrationSql.slice(15093, 15352) }),
  Object.freeze({ type: 'trigger', name: 'action_proof_use', sql: actionReauthenticationMigrationSql.slice(15355, 16297) }),
  Object.freeze({ type: 'trigger', name: 'action_proof_retained', sql: actionReauthenticationMigrationSql.slice(16300, 16442) }),
]);
const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
export function assertActionReauthenticationSchema(db: Sqlite, installed: boolean): void {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all() as
    { type: string; name: string; tbl_name: string; sql: string | null }[];
  const related = rows.filter(row => actionReauthenticationSchemaObjects.some(object => object.name === row.name) ||
    actionReauthenticationTables.includes(row.tbl_name));
  if (!installed) {
    if (related.length) throw new DomainError(503, 'action_reauthentication_schema_held');
    return;
  }
  if (related.length !== actionReauthenticationSchemaObjects.length || actionReauthenticationSchemaObjects.some(object =>
    !related.some(row => row.name === object.name && row.type === object.type && row.sql !== null && normalize(row.sql) === normalize(object.sql))))
    throw new DomainError(503, 'action_reauthentication_schema_held');
}
