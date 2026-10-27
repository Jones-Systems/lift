import type { Sqlite, Migration } from '../storage.js';
import { DomainError } from '../errors.js';

export const subscriptionStatusMigrationSql = `
  CREATE TABLE apple_purchase_reconciliations (
    handle TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    original_transaction_id TEXT NOT NULL,
    owner_binding TEXT NOT NULL CHECK(json_valid(owner_binding)),
    actor_binding TEXT NOT NULL CHECK(json_valid(actor_binding)),
    next_page INTEGER NOT NULL CHECK(next_page>=0),
    revision TEXT,
    outcome TEXT NOT NULL CHECK(json_valid(outcome)),
    FOREIGN KEY(original_transaction_id,account_id) REFERENCES apple_purchase_owners(original_transaction_id,account_id)
  );
  CREATE TABLE apple_purchase_reconciliation_pages (
    handle TEXT NOT NULL REFERENCES apple_purchase_reconciliations(handle),
    request_page INTEGER NOT NULL CHECK(request_page>=0),
    response_hash TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(json_valid(outcome)),
    PRIMARY KEY(handle,request_page)
  );
  CREATE TABLE apple_purchase_notifications (
    notification_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    exact_payload TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    original_transaction_id TEXT NOT NULL,
    renewal_jws TEXT,
    outcome TEXT NOT NULL CHECK(json_valid(outcome)),
    FOREIGN KEY(original_transaction_id,account_id) REFERENCES apple_purchase_owners(original_transaction_id,account_id)
  );
  CREATE TRIGGER immutable_apple_reconciliation_binding BEFORE UPDATE OF handle,account_id,original_transaction_id,owner_binding,actor_binding ON apple_purchase_reconciliations
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_reconciliation_binding'); END;
  CREATE TRIGGER immutable_apple_reconciliation_page BEFORE UPDATE ON apple_purchase_reconciliation_pages
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_reconciliation_page'); END;
  CREATE TRIGGER immutable_apple_notification BEFORE UPDATE ON apple_purchase_notifications
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_notification'); END;

  CREATE TABLE apple_purchase_status_observations (
    observation_id TEXT PRIMARY KEY CHECK(length(observation_id)=64 AND observation_id NOT GLOB '*[^0-9a-f]*'),
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    original_transaction_id TEXT NOT NULL,
    owner_binding_digest TEXT NOT NULL CHECK(length(owner_binding_digest)=64 AND owner_binding_digest NOT GLOB '*[^0-9a-f]*'),
    event_kind TEXT NOT NULL CHECK(event_kind IN('dispatch','status','history','notification','outcome')),
    event_key TEXT NOT NULL CHECK(length(event_key)=64 AND event_key NOT GLOB '*[^0-9a-f]*'),
    request_id TEXT NOT NULL CHECK(length(request_id)=64 AND request_id NOT GLOB '*[^0-9a-f]*'),
    lifecycle_epoch INTEGER NOT NULL CHECK(typeof(lifecycle_epoch)='integer' AND lifecycle_epoch BETWEEN 0 AND 9007199254740991),
    database_generation TEXT NOT NULL CHECK(length(CAST(database_generation AS BLOB)) BETWEEN 1 AND 128),
    schema_digest TEXT NOT NULL CHECK(length(schema_digest)=64 AND schema_digest NOT GLOB '*[^0-9a-f]*'),
    continuity_digest TEXT NOT NULL CHECK(length(continuity_digest)=64 AND continuity_digest NOT GLOB '*[^0-9a-f]*'),
    binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB))<=8192),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB))<=16384),
    content_digest TEXT NOT NULL CHECK(length(content_digest)=64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
    observed_at_ms INTEGER NOT NULL CHECK(typeof(observed_at_ms)='integer' AND observed_at_ms BETWEEN 0 AND 8640000000000000),
    UNIQUE(account_id,event_kind,event_key),
    FOREIGN KEY(original_transaction_id,account_id) REFERENCES apple_purchase_owners(original_transaction_id,account_id)
  );
  CREATE INDEX apple_status_observation_account_time ON apple_purchase_status_observations(account_id,event_kind,observed_at_ms);
  CREATE INDEX apple_status_observation_lineage_time ON apple_purchase_status_observations(account_id,original_transaction_id,observed_at_ms,observation_id);
  CREATE TRIGGER immutable_apple_status_observation BEFORE UPDATE ON apple_purchase_status_observations
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_status_observation'); END;
  CREATE TRIGGER retained_apple_status_observation BEFORE DELETE ON apple_purchase_status_observations
    BEGIN SELECT RAISE(ABORT, 'retained_apple_status_observation'); END;

  CREATE TABLE apple_purchase_status_projection (
    original_transaction_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    owner_binding_digest TEXT NOT NULL CHECK(length(owner_binding_digest)=64 AND owner_binding_digest NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
    lifecycle_epoch INTEGER NOT NULL CHECK(typeof(lifecycle_epoch)='integer' AND lifecycle_epoch BETWEEN 0 AND 9007199254740991),
    database_generation TEXT NOT NULL CHECK(length(CAST(database_generation AS BLOB)) BETWEEN 1 AND 128),
    schema_digest TEXT NOT NULL CHECK(length(schema_digest)=64 AND schema_digest NOT GLOB '*[^0-9a-f]*'),
    continuity_digest TEXT NOT NULL CHECK(length(continuity_digest)=64 AND continuity_digest NOT GLOB '*[^0-9a-f]*'),
    current_observation_id TEXT REFERENCES apple_purchase_status_observations(observation_id),
    projection_state TEXT NOT NULL CHECK(projection_state IN('pending','current','held')),
    projection_json TEXT NOT NULL CHECK(json_valid(projection_json) AND length(CAST(projection_json AS BLOB))<=16384),
    valid_until_ms INTEGER CHECK(valid_until_ms IS NULL OR (typeof(valid_until_ms)='integer' AND valid_until_ms BETWEEN 0 AND 8640000000000000)),
    active_request_id TEXT REFERENCES apple_purchase_status_observations(observation_id),
    dispatch_state TEXT CHECK(dispatch_state IS NULL OR dispatch_state IN('dispatching','unsettled')),
    request_deadline_ms INTEGER CHECK(request_deadline_ms IS NULL OR (typeof(request_deadline_ms)='integer' AND request_deadline_ms BETWEEN 0 AND 8640000000000000)),
    last_seen_at_ms INTEGER NOT NULL CHECK(typeof(last_seen_at_ms)='integer' AND last_seen_at_ms BETWEEN 0 AND 8640000000000000),
    CHECK((active_request_id IS NULL AND dispatch_state IS NULL AND request_deadline_ms IS NULL)
       OR (active_request_id IS NOT NULL AND dispatch_state IS NOT NULL AND request_deadline_ms IS NOT NULL)),
    CHECK(projection_state<>'current' OR current_observation_id IS NOT NULL),
    FOREIGN KEY(original_transaction_id,account_id) REFERENCES apple_purchase_owners(original_transaction_id,account_id)
  );
  CREATE UNIQUE INDEX apple_status_one_dispatch_per_account ON apple_purchase_status_projection(account_id) WHERE active_request_id IS NOT NULL;
  CREATE TRIGGER immutable_apple_status_projection_binding BEFORE UPDATE OF original_transaction_id,account_id,owner_binding_digest ON apple_purchase_status_projection
    BEGIN SELECT RAISE(ABORT, 'immutable_apple_status_projection_binding'); END;
  CREATE TRIGGER retained_apple_status_projection BEFORE DELETE ON apple_purchase_status_projection
    BEGIN SELECT RAISE(ABORT, 'retained_apple_status_projection'); END;
  CREATE TRIGGER advancing_apple_status_projection BEFORE UPDATE ON apple_purchase_status_projection
    WHEN NEW.revision<>OLD.revision+1 OR NEW.last_seen_at_ms<OLD.last_seen_at_ms
    BEGIN SELECT RAISE(ABORT, 'advancing_apple_status_projection'); END;
  CREATE TRIGGER bound_apple_status_projection_insert BEFORE INSERT ON apple_purchase_status_projection
    WHEN (NEW.current_observation_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM apple_purchase_status_observations o WHERE o.observation_id=NEW.current_observation_id
        AND o.event_kind='status' AND o.account_id=NEW.account_id AND o.original_transaction_id=NEW.original_transaction_id
        AND o.owner_binding_digest=NEW.owner_binding_digest AND o.lifecycle_epoch=NEW.lifecycle_epoch
        AND o.database_generation=NEW.database_generation AND o.schema_digest=NEW.schema_digest))
      OR (NEW.active_request_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM apple_purchase_status_observations o WHERE o.observation_id=NEW.active_request_id
        AND o.event_kind='dispatch' AND o.account_id=NEW.account_id AND o.original_transaction_id=NEW.original_transaction_id
        AND o.owner_binding_digest=NEW.owner_binding_digest))
    BEGIN SELECT RAISE(ABORT, 'bound_apple_status_projection_insert'); END;
  CREATE TRIGGER bound_apple_status_projection_update BEFORE UPDATE ON apple_purchase_status_projection
    WHEN (NEW.current_observation_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM apple_purchase_status_observations o WHERE o.observation_id=NEW.current_observation_id
        AND o.event_kind='status' AND o.account_id=NEW.account_id AND o.original_transaction_id=NEW.original_transaction_id
        AND o.owner_binding_digest=NEW.owner_binding_digest AND o.lifecycle_epoch=NEW.lifecycle_epoch
        AND o.database_generation=NEW.database_generation AND o.schema_digest=NEW.schema_digest))
      OR (NEW.active_request_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM apple_purchase_status_observations o WHERE o.observation_id=NEW.active_request_id
        AND o.event_kind='dispatch' AND o.account_id=NEW.account_id AND o.original_transaction_id=NEW.original_transaction_id
        AND o.owner_binding_digest=NEW.owner_binding_digest))
    BEGIN SELECT RAISE(ABORT, 'bound_apple_status_projection_update'); END;
`;
export const sourceSubscriptionStatusMigration: Readonly<Migration> = Object.freeze({version: 27, sql: subscriptionStatusMigrationSql});
export const subscriptionStatusSchemaObjects = Object.freeze([
  Object.freeze({type: 'table', name: 'apple_purchase_reconciliations', table: 'apple_purchase_reconciliations', sql: subscriptionStatusMigrationSql.slice(3, 562)}),
  Object.freeze({type: 'table', name: 'apple_purchase_reconciliation_pages', table: 'apple_purchase_reconciliation_pages', sql: subscriptionStatusMigrationSql.slice(565, 878)}),
  Object.freeze({type: 'table', name: 'apple_purchase_notifications', table: 'apple_purchase_notifications', sql: subscriptionStatusMigrationSql.slice(881, 1331)}),
  Object.freeze({type: 'trigger', name: 'immutable_apple_reconciliation_binding', table: 'apple_purchase_reconciliations', sql: subscriptionStatusMigrationSql.slice(1334, 1586)}),
  Object.freeze({type: 'trigger', name: 'immutable_apple_reconciliation_page', table: 'apple_purchase_reconciliation_pages', sql: subscriptionStatusMigrationSql.slice(1589, 1767)}),
  Object.freeze({type: 'trigger', name: 'immutable_apple_notification', table: 'apple_purchase_notifications', sql: subscriptionStatusMigrationSql.slice(1770, 1927)}),
  Object.freeze({type: 'table', name: 'apple_purchase_status_observations', table: 'apple_purchase_status_observations', sql: subscriptionStatusMigrationSql.slice(1931, 3708)}),
  Object.freeze({type: 'index', name: 'apple_status_observation_account_time', table: 'apple_purchase_status_observations', sql: subscriptionStatusMigrationSql.slice(3711, 3838)}),
  Object.freeze({type: 'index', name: 'apple_status_observation_lineage_time', table: 'apple_purchase_status_observations', sql: subscriptionStatusMigrationSql.slice(3841, 3996)}),
  Object.freeze({type: 'trigger', name: 'immutable_apple_status_observation', table: 'apple_purchase_status_observations', sql: subscriptionStatusMigrationSql.slice(3999, 4174)}),
  Object.freeze({type: 'trigger', name: 'retained_apple_status_observation', table: 'apple_purchase_status_observations', sql: subscriptionStatusMigrationSql.slice(4177, 4350)}),
  Object.freeze({type: 'table', name: 'apple_purchase_status_projection', table: 'apple_purchase_status_projection', sql: subscriptionStatusMigrationSql.slice(4354, 6554)}),
  Object.freeze({type: 'index', name: 'apple_status_one_dispatch_per_account', table: 'apple_purchase_status_projection', sql: subscriptionStatusMigrationSql.slice(6557, 6699)}),
  Object.freeze({type: 'trigger', name: 'immutable_apple_status_projection_binding', table: 'apple_purchase_status_projection', sql: subscriptionStatusMigrationSql.slice(6702, 6948)}),
  Object.freeze({type: 'trigger', name: 'retained_apple_status_projection', table: 'apple_purchase_status_projection', sql: subscriptionStatusMigrationSql.slice(6951, 7120)}),
  Object.freeze({type: 'trigger', name: 'advancing_apple_status_projection', table: 'apple_purchase_status_projection', sql: subscriptionStatusMigrationSql.slice(7123, 7375)}),
  Object.freeze({type: 'trigger', name: 'bound_apple_status_projection_insert', table: 'apple_purchase_status_projection', sql: subscriptionStatusMigrationSql.slice(7378, 8401)}),
  Object.freeze({type: 'trigger', name: 'bound_apple_status_projection_update', table: 'apple_purchase_status_projection', sql: subscriptionStatusMigrationSql.slice(8404, 9427)}),
]);
const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
export function assertSubscriptionStatusSchema(db: Sqlite, installed: boolean): void {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all() as {type:string; name:string; tbl_name:string; sql:string|null}[];
  const tables: readonly string[] = subscriptionStatusSchemaObjects.filter(o => o.type === 'table').map(o => o.name);
  const related = rows.filter(r => tables.includes(r.tbl_name) || subscriptionStatusSchemaObjects.some(o => o.name === r.name));
  if (!installed ? related.length !== 0 : related.length !== subscriptionStatusSchemaObjects.length || subscriptionStatusSchemaObjects.some(o => !related.some(r => r.type === o.type && r.name === o.name && r.tbl_name === o.table && r.sql !== null && normalize(r.sql) === normalize(o.sql))))
    throw new DomainError(503, 'subscription_status_schema_held');
}
