export const lifecycleMigration = { version: 10, sql: `
CREATE TABLE account_lifecycle (
 account_id TEXT PRIMARY KEY REFERENCES form_accounts(id),
 state TEXT NOT NULL CHECK(state IN ('active','disabled')),
 epoch INTEGER NOT NULL CHECK(epoch>=0), disabled_at_ms INTEGER, suppression_seq INTEGER,
 CHECK((state='active' AND disabled_at_ms IS NULL AND suppression_seq IS NULL) OR
       (state='disabled' AND disabled_at_ms IS NOT NULL AND suppression_seq IS NOT NULL))
);
INSERT INTO account_lifecycle(account_id,state,epoch) SELECT id,'active',0 FROM form_accounts;
CREATE TRIGGER lifecycle_new_account AFTER INSERT ON form_accounts BEGIN
 INSERT INTO account_lifecycle(account_id,state,epoch) VALUES(NEW.id,'active',0);
END;
CREATE TRIGGER lifecycle_identity BEFORE UPDATE OF account_id ON account_lifecycle BEGIN SELECT RAISE(ABORT,'lifecycle_identity'); END;
CREATE TRIGGER lifecycle_retained BEFORE DELETE ON account_lifecycle BEGIN SELECT RAISE(ABORT,'lifecycle_retained'); END;
CREATE TRIGGER lifecycle_monotonic BEFORE UPDATE ON account_lifecycle
 WHEN NEW.epoch<OLD.epoch OR (OLD.state='disabled' AND (NEW.state<>'disabled' OR NEW.epoch<>OLD.epoch OR NEW.disabled_at_ms<>OLD.disabled_at_ms OR NEW.suppression_seq<>OLD.suppression_seq))
 OR (OLD.state='active' AND NEW.state='disabled' AND NEW.epoch<>OLD.epoch+1)
 BEGIN SELECT RAISE(ABORT,'lifecycle_monotonic'); END;
CREATE TABLE account_deletion_requests (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE REFERENCES form_accounts(id), command_key TEXT NOT NULL,
 intent_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('awaiting_reauthentication','disabled_pending_purge','purging','pending_external','complete')),
 requested_at_ms INTEGER NOT NULL, verified_at_ms INTEGER, verification_method TEXT, disabled_at_ms INTEGER,
 local_purged_at_ms INTEGER, completed_at_ms INTEGER, status_token_hash TEXT NOT NULL UNIQUE,
 status_token_expires_at_ms INTEGER NOT NULL, UNIQUE(account_id,command_key)
);
CREATE TABLE account_deletion_steps (
 request_id TEXT NOT NULL REFERENCES account_deletion_requests(id), category TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','complete','retained','unknown','failed','not_applicable')),
 policy_ref TEXT, retain_until_ms INTEGER, evidence_ref TEXT, updated_at_ms INTEGER NOT NULL,
 PRIMARY KEY(request_id,category)
);
CREATE TABLE account_action_grants (
 token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES form_accounts(id),
 session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, epoch INTEGER NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('account_delete','account_export')), method TEXT NOT NULL,
 verified_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, consumed_at_ms INTEGER
);
CREATE TRIGGER lifecycle_session_insert BEFORE INSERT ON session
 WHEN EXISTS(SELECT 1 FROM form_accounts f LEFT JOIN account_lifecycle l ON l.account_id=f.id
 WHERE f.auth_user_id=NEW.userId AND (l.state IS NULL OR l.state<>'active'))
 BEGIN SELECT RAISE(ABORT,'account_disabled'); END;
CREATE TRIGGER lifecycle_session_update BEFORE UPDATE ON session
 WHEN EXISTS(SELECT 1 FROM form_accounts f LEFT JOIN account_lifecycle l ON l.account_id=f.id
 WHERE f.auth_user_id=NEW.userId AND (l.state IS NULL OR l.state<>'active'))
 BEGIN SELECT RAISE(ABORT,'account_disabled'); END;
CREATE TRIGGER lifecycle_user_update BEFORE UPDATE ON "user"
 WHEN EXISTS(SELECT 1 FROM form_accounts f LEFT JOIN account_lifecycle l ON l.account_id=f.id WHERE f.auth_user_id=OLD.id AND (l.state IS NULL OR l.state<>'active'))
 BEGIN SELECT RAISE(ABORT,'account_disabled'); END;
CREATE TRIGGER lifecycle_auth_account_insert BEFORE INSERT ON account
 WHEN EXISTS(SELECT 1 FROM form_accounts f LEFT JOIN account_lifecycle l ON l.account_id=f.id WHERE f.auth_user_id=NEW.userId AND (l.state IS NULL OR l.state<>'active'))
 BEGIN SELECT RAISE(ABORT,'account_disabled'); END;
CREATE TRIGGER lifecycle_auth_account_update BEFORE UPDATE ON account
 WHEN EXISTS(SELECT 1 FROM form_accounts f LEFT JOIN account_lifecycle l ON l.account_id=f.id WHERE (f.auth_user_id=OLD.userId OR f.auth_user_id=NEW.userId) AND (l.state IS NULL OR l.state<>'active'))
 BEGIN SELECT RAISE(ABORT,'account_disabled'); END;
` } as const;
