import type { Migration, Sqlite } from '../../storage.js';
import { DomainError } from '../../errors.js';

export const providerRevocationMigrationSql = `CREATE TABLE account_provider_revocation_intents (
  intent_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL REFERENCES account_deletion_requests(id),
  account_id TEXT NOT NULL REFERENCES form_accounts(id),
  auth_user_id TEXT NOT NULL REFERENCES user(id),
  source_account_row_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject_digest TEXT NOT NULL CHECK(length(subject_digest)=64),
  client_binding_id TEXT,
  client_digest TEXT CHECK(client_digest IS NULL OR length(client_digest)=64),
  token_kind TEXT CHECK(token_kind IN ('refresh_token','access_token')),
  reference_version TEXT,
  material_state TEXT NOT NULL CHECK(material_state IN ('captured','unavailable')),
  residual_code TEXT CHECK(residual_code IN ('unsupported_provider','material_missing','client_binding_unavailable','token_provenance_unavailable','material_invalid')),
  lifecycle_epoch INTEGER NOT NULL CHECK(lifecycle_epoch>=1),
  suppression_sequence INTEGER NOT NULL CHECK(suppression_sequence>=1),
  database_generation TEXT NOT NULL CHECK(length(database_generation)=64),
  schema_digest TEXT NOT NULL CHECK(length(schema_digest)=64),
  authority_id TEXT NOT NULL,
  ledger_schema_digest TEXT NOT NULL CHECK(length(ledger_schema_digest)=64),
  checkpoint_revision INTEGER NOT NULL CHECK(checkpoint_revision>=0),
  checkpoint_sequence INTEGER NOT NULL CHECK(checkpoint_sequence>=suppression_sequence),
  checkpoint_head_digest TEXT NOT NULL CHECK(length(checkpoint_head_digest)=64),
  policy_version TEXT NOT NULL,
  proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
  UNIQUE(request_id,source_account_row_id),
  CHECK(length(intent_id) BETWEEN 1 AND 128),
  CHECK(length(provider) BETWEEN 1 AND 64),
  CHECK((material_state='captured' AND provider='apple' AND client_binding_id IS NOT NULL AND client_digest IS NOT NULL AND token_kind IS NOT NULL AND reference_version IS NOT NULL AND residual_code IS NULL)
     OR (material_state='unavailable' AND token_kind IS NULL AND reference_version IS NULL AND residual_code IS NOT NULL))
);
CREATE INDEX account_provider_revocation_intents_account
  ON account_provider_revocation_intents(account_id,request_id);
CREATE TABLE account_provider_revocation_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  intent_id TEXT NOT NULL REFERENCES account_provider_revocation_intents(intent_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
  binding_json TEXT NOT NULL CHECK(length(binding_json) BETWEEN 2 AND 16384),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64),
  state TEXT NOT NULL CHECK(state IN ('preparing','in_flight','acknowledged','unknown','no_effect')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 2),
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms>=0),
  deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>started_at_ms AND deadline_at_ms<=started_at_ms+10000),
  dispatch_at_ms INTEGER,
  finished_at_ms INTEGER,
  outcome_code TEXT CHECK(outcome_code IN ('apple_ack','material_unavailable','reference_changed','currentness_changed','cancelled_before_dispatch','preparation_expired','transport_unknown','provider_error','response_invalid','ack_commit_unknown')),
  protocol_status INTEGER CHECK(protocol_status BETWEEN 100 AND 599),
  result_fact_json TEXT CHECK(result_fact_json IS NULL OR length(result_fact_json) BETWEEN 2 AND 16384),
  CHECK(length(attempt_id) BETWEEN 1 AND 128),
  CHECK(dispatch_at_ms IS NULL OR (dispatch_at_ms>=started_at_ms AND dispatch_at_ms<deadline_at_ms)),
  CHECK(finished_at_ms IS NULL OR finished_at_ms>=started_at_ms),
  CHECK(finished_at_ms IS NULL OR dispatch_at_ms IS NULL OR finished_at_ms>=dispatch_at_ms),
  CHECK((state='preparing' AND revision=0 AND dispatch_at_ms IS NULL AND finished_at_ms IS NULL AND outcome_code IS NULL AND protocol_status IS NULL AND result_fact_json IS NULL)
     OR (state='in_flight' AND revision=1 AND dispatch_at_ms IS NOT NULL AND finished_at_ms IS NULL AND outcome_code IS NULL AND protocol_status IS NULL AND result_fact_json IS NULL)
     OR (state='no_effect' AND revision=1 AND dispatch_at_ms IS NULL AND finished_at_ms IS NOT NULL AND outcome_code IS NOT NULL AND outcome_code IN ('material_unavailable','reference_changed','currentness_changed','cancelled_before_dispatch','preparation_expired') AND protocol_status IS NULL AND result_fact_json IS NOT NULL)
     OR (state='unknown' AND revision=2 AND dispatch_at_ms IS NOT NULL AND finished_at_ms IS NOT NULL AND outcome_code IS NOT NULL AND outcome_code IN ('transport_unknown','provider_error','response_invalid','ack_commit_unknown','currentness_changed') AND result_fact_json IS NOT NULL)
     OR (state='acknowledged' AND revision=2 AND dispatch_at_ms IS NOT NULL AND finished_at_ms IS NOT NULL AND finished_at_ms<=deadline_at_ms AND outcome_code IS NOT NULL AND outcome_code='apple_ack' AND protocol_status IS NOT NULL AND protocol_status=200 AND result_fact_json IS NOT NULL))
);
CREATE UNIQUE INDEX account_provider_revocation_attempts_ordinal
  ON account_provider_revocation_attempts(intent_id,ordinal);
CREATE UNIQUE INDEX account_provider_revocation_attempts_active
  ON account_provider_revocation_attempts(intent_id) WHERE state IN ('preparing','in_flight');
CREATE UNIQUE INDEX account_provider_revocation_attempts_ack
  ON account_provider_revocation_attempts(intent_id) WHERE state='acknowledged';
CREATE INDEX account_provider_revocation_attempts_deadline
  ON account_provider_revocation_attempts(state,deadline_at_ms,intent_id);
CREATE TRIGGER account_provider_revocation_intents_no_update
BEFORE UPDATE ON account_provider_revocation_intents BEGIN
  SELECT RAISE(ABORT,'provider_revocation_intent_immutable');
END;
CREATE TRIGGER account_provider_revocation_intents_no_delete
BEFORE DELETE ON account_provider_revocation_intents BEGIN
  SELECT RAISE(ABORT,'provider_revocation_intent_retained');
END;
CREATE TRIGGER account_provider_revocation_attempts_insert_guard
BEFORE INSERT ON account_provider_revocation_attempts BEGIN
  SELECT CASE WHEN NEW.state<>'preparing' OR NEW.revision<>0
    OR NOT EXISTS(SELECT 1 FROM account_provider_revocation_intents i WHERE i.intent_id=NEW.intent_id AND i.material_state='captured' AND i.provider='apple')
    OR NEW.ordinal<>(SELECT COALESCE(MAX(a.ordinal),0)+1 FROM account_provider_revocation_attempts a WHERE a.intent_id=NEW.intent_id)
    OR EXISTS(SELECT 1 FROM account_provider_revocation_attempts a WHERE a.intent_id=NEW.intent_id AND a.state='acknowledged')
    THEN RAISE(ABORT,'provider_revocation_attempt_invalid') END;
END;
CREATE TRIGGER account_provider_revocation_attempts_update_guard
BEFORE UPDATE ON account_provider_revocation_attempts BEGIN
  SELECT CASE WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.intent_id IS NOT OLD.intent_id
    OR NEW.ordinal IS NOT OLD.ordinal OR NEW.binding_json IS NOT OLD.binding_json
    OR NEW.binding_digest IS NOT OLD.binding_digest OR NEW.started_at_ms IS NOT OLD.started_at_ms
    OR NEW.deadline_at_ms IS NOT OLD.deadline_at_ms OR NEW.revision<>OLD.revision+1
    OR NOT ((OLD.state='preparing' AND NEW.state IN ('in_flight','no_effect'))
         OR (OLD.state='in_flight' AND NEW.state IN ('acknowledged','unknown') AND NEW.dispatch_at_ms IS OLD.dispatch_at_ms))
    THEN RAISE(ABORT,'provider_revocation_attempt_transition_invalid') END;
END;
CREATE TRIGGER account_provider_revocation_attempts_no_delete
BEFORE DELETE ON account_provider_revocation_attempts BEGIN
  SELECT RAISE(ABORT,'provider_revocation_attempt_retained');
END;
`;
export const sourceProviderRevocationMigration: Readonly<Migration> = Object.freeze({ version: 25, sql: providerRevocationMigrationSql });
export const providerRevocationSchemaObjects = Object.freeze([
  Object.freeze({ type: 'table', name: 'account_provider_revocation_intents', sql: providerRevocationMigrationSql.slice(0, 2156).trim() }),
  Object.freeze({ type: 'index', name: 'account_provider_revocation_intents_account', sql: providerRevocationMigrationSql.slice(2156, 2278).trim() }),
  Object.freeze({ type: 'table', name: 'account_provider_revocation_attempts', sql: providerRevocationMigrationSql.slice(2278, 5044).trim() }),
  Object.freeze({ type: 'index', name: 'account_provider_revocation_attempts_ordinal', sql: providerRevocationMigrationSql.slice(5044, 5171).trim() }),
  Object.freeze({ type: 'index', name: 'account_provider_revocation_attempts_active', sql: providerRevocationMigrationSql.slice(5171, 5330).trim() }),
  Object.freeze({ type: 'index', name: 'account_provider_revocation_attempts_ack', sql: providerRevocationMigrationSql.slice(5330, 5472).trim() }),
  Object.freeze({ type: 'index', name: 'account_provider_revocation_attempts_deadline', sql: providerRevocationMigrationSql.slice(5472, 5606).trim() }),
  Object.freeze({ type: 'trigger', name: 'account_provider_revocation_intents_no_update', sql: providerRevocationMigrationSql.slice(5606, 5793).trim() }),
  Object.freeze({ type: 'trigger', name: 'account_provider_revocation_intents_no_delete', sql: providerRevocationMigrationSql.slice(5793, 5979).trim() }),
  Object.freeze({ type: 'trigger', name: 'account_provider_revocation_attempts_insert_guard', sql: providerRevocationMigrationSql.slice(5979, 6654).trim() }),
  Object.freeze({ type: 'trigger', name: 'account_provider_revocation_attempts_update_guard', sql: providerRevocationMigrationSql.slice(6654, 7423).trim() }),
  Object.freeze({ type: 'trigger', name: 'account_provider_revocation_attempts_no_delete', sql: providerRevocationMigrationSql.slice(7423, 7612).trim() }),
]);
const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
export function assertProviderRevocationSchema(db: Sqlite, installed: boolean): void {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all() as
    { type: string; name: string; tbl_name: string; sql: string | null }[];
  const related = rows.filter(row => providerRevocationSchemaObjects.some(object => object.name === row.name) ||
    ['account_provider_revocation_intents', 'account_provider_revocation_attempts'].includes(row.tbl_name));
  if (!installed) { if (related.length) throw new DomainError(503, 'provider_revocation_schema_held'); return; }
  if (related.length !== providerRevocationSchemaObjects.length || providerRevocationSchemaObjects.some(object =>
    !related.some(row => row.name === object.name && row.type === object.type && row.sql !== null && normalize(row.sql) === normalize(object.sql))))
    throw new DomainError(503, 'provider_revocation_schema_held');
}
