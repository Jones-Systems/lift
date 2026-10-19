import type { Migration } from '../storage.js';

export const manualRetentionOwnedTables = Object.freeze([
  'body_manual_retention_decisions', 'body_manual_retention_receipts', 'body_manual_retention_attributions',
] as const);

export const manualRetentionMigrationSql = `
CREATE TABLE body_manual_retention_decisions (
 account_id TEXT NOT NULL REFERENCES form_accounts(id), decision_id TEXT NOT NULL,
 auth_user_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=0),
 state TEXT NOT NULL CHECK(state IN('granted','revoked')), revision INTEGER NOT NULL CHECK(revision IN(1,2)),
 statement_sha256 TEXT, grant_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(account_id,decision_id),
 CHECK((state='granted' AND revision=1 AND statement_sha256 IS NOT NULL AND grant_key IS NOT NULL)
   OR (state='revoked' AND revision=1 AND statement_sha256 IS NULL AND grant_key IS NULL)
   OR (state='revoked' AND revision=2 AND statement_sha256 IS NOT NULL AND grant_key IS NOT NULL)));
CREATE TABLE body_manual_retention_receipts (
 account_id TEXT NOT NULL, key TEXT NOT NULL, intent_hash TEXT NOT NULL,
 decision_id TEXT NOT NULL, receipt TEXT NOT NULL CHECK(json_valid(receipt)), created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,key),
 FOREIGN KEY(account_id,decision_id) REFERENCES body_manual_retention_decisions(account_id,decision_id));
CREATE TABLE body_manual_retention_attributions (
 account_id TEXT NOT NULL, measurement_key TEXT NOT NULL, measurement_id TEXT NOT NULL,
 decision_id TEXT NOT NULL, decision_revision INTEGER NOT NULL CHECK(decision_revision=1),
 statement_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,measurement_key),
 FOREIGN KEY(account_id,measurement_key) REFERENCES body_manual_receipts(account_id,key),
 FOREIGN KEY(account_id,decision_id) REFERENCES body_manual_retention_decisions(account_id,decision_id));
CREATE INDEX body_manual_retention_attribution_decision ON body_manual_retention_attributions(account_id,decision_id);
CREATE TRIGGER immutable_body_manual_retention_receipt BEFORE UPDATE ON body_manual_retention_receipts
 BEGIN SELECT RAISE(ABORT,'immutable_body_manual_retention_receipt'); END;
CREATE TRIGGER immutable_body_manual_retention_attribution BEFORE UPDATE ON body_manual_retention_attributions
 BEGIN SELECT RAISE(ABORT,'immutable_body_manual_retention_attribution'); END;
CREATE TRIGGER terminal_body_manual_retention_decision BEFORE UPDATE ON body_manual_retention_decisions
 WHEN OLD.state <> 'granted' OR NEW.state <> 'revoked' OR NEW.revision <> 2
 OR NEW.account_id <> OLD.account_id OR NEW.decision_id <> OLD.decision_id
 OR NEW.auth_user_id <> OLD.auth_user_id OR NEW.session_id <> OLD.session_id OR NEW.epoch <> OLD.epoch
 OR NEW.statement_sha256 IS NOT OLD.statement_sha256 OR NEW.grant_key IS NOT OLD.grant_key OR NEW.created_at <> OLD.created_at
 BEGIN SELECT RAISE(ABORT,'terminal_body_manual_retention_decision'); END;`;
export const sourceManualRetentionMigration: Migration = Object.freeze({ version: 23, sql: manualRetentionMigrationSql });
