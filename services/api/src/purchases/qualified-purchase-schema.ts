import Database from 'better-sqlite3';
import type { Sqlite } from '../storage.js';
import { evidenceDigest } from '../lifecycle/evidence-codec.js';
import { notificationInboxSql, assertNotificationInboxSchema, validateInboxPolicy } from './notification-inbox-schema.js';
import { selectSourceSubscriptionStatusMigrations, assertSourceSubscriptionStatusHistory } from './status-source-migrations.js';
import type { InboxPolicy } from './notification-inbox.types.js';
import { readQualifiedStore, qualifiedNamespaceKey } from './qualified-purchase-context.js';

/**
 * Unregistered additive successor SQL. There is no migration row, selector or runtime registration, and importing this
 * module performs no DDL. Original purchase SQL stays byte-identical; the predecessor tables are only fenced.
 */
export type SchemaDescriptor = Readonly<{ type: 'table' | 'index' | 'trigger'; name: string; table: string; sql: string }>;

// The statement the genuine storage layer uses to create its receipt table. A drift guard test pins it to storage.ts.
export const formMigrationsDefinition =
  'CREATE TABLE IF NOT EXISTS form_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)';
export const predecessorPurchaseTables = Object.freeze([
  'apple_purchase_owners', 'apple_purchase_transactions', 'apple_purchase_grants', 'apple_purchase_observations',
  'apple_purchase_commands', 'apple_purchase_deliveries', 'apple_purchase_reconciliations', 'apple_purchase_reconciliation_pages',
  'apple_purchase_notifications', 'apple_purchase_status_observations', 'apple_purchase_status_projection',
] as const);

const hexRun = (count: number) => '[0-9a-f]'.repeat(count);
const uuidPattern = `${hexRun(8)}-${hexRun(4)}-${hexRun(4)}-${hexRun(4)}-${hexRun(12)}`;
const uuidV4Pattern = `${hexRun(8)}-${hexRun(4)}-4${hexRun(3)}-[89ab]${hexRun(3)}-${hexRun(12)}`;
const hex64 = (column: string) => `length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const digits = (column: string) => `length(${column}) BETWEEN 1 AND 64 AND ${column} NOT GLOB '*[^0-9]*'`;
const millis = (column: string) => `typeof(${column})='integer' AND ${column} BETWEEN 0 AND 8640000000000000`;
const optionalMillis = (column: string) => `${column} IS NULL OR (${millis(column)})`;
const bytes = (column: string, limit: number) => `length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${limit}`;
const NS = 'namespace_key TEXT NOT NULL REFERENCES qualified_apple_namespaces(namespace_key)';
const refusal = (name: string) => `BEGIN SELECT RAISE(ABORT,'${name}'); END`;

const table = (name: string, body: string): SchemaDescriptor =>
  ({ type: 'table', name, table: name, sql: `CREATE TABLE ${name} (${body})` });
const index = (name: string, on: string, sql: string): SchemaDescriptor => ({ type: 'index', name, table: on, sql });
const trigger = (name: string, on: string, sql: string): SchemaDescriptor => ({ type: 'trigger', name, table: on, sql });
const immutable = (on: string, name = `${on}_immutable`): SchemaDescriptor =>
  trigger(name, on, `CREATE TRIGGER ${name} BEFORE UPDATE ON ${on} ${refusal(name)}`);
const retained = (on: string, name = `${on}_retained`): SchemaDescriptor =>
  trigger(name, on, `CREATE TRIGGER ${name} BEFORE DELETE ON ${on} ${refusal(name)}`);
const policyJson = (key: string) => `(SELECT json_extract(policy_json,'$.${key}') FROM qualified_apple_store WHERE singleton=1)`;
const policyBound = (on: string, column: string, key: string, event: 'INSERT' | 'UPDATE' = 'INSERT'): SchemaDescriptor => {
  const name = `${on}_policy_${column}${event === 'UPDATE' ? '_update' : ''}`;
  return trigger(name, on, `CREATE TRIGGER ${name} BEFORE ${event} ON ${on} WHEN length(CAST(NEW.${column} AS BLOB))>${policyJson(key)} ${refusal(name)}`);
};
const countBound = (on: string, body: string, key: string, byteLimit: string): SchemaDescriptor => {
  const name = `${on}_policy_item_count`;
  return trigger(name, on, `CREATE TRIGGER ${name} BEFORE INSERT ON ${on} WHEN
    CASE WHEN length(CAST(NEW.${body} AS BLOB))<=${policyJson(byteLimit)}
      THEN NEW.item_count>${policyJson(key)} OR json_type(NEW.${body},'$.items') IS NOT 'array'
        OR (SELECT count(*) FROM json_each(NEW.${body}) WHERE key='items')<>1
        OR json_array_length(NEW.${body},'$.items') IS NOT NEW.item_count
    ELSE 0 END ${refusal(name)}`);
};

const statusEvidenceBound = (name: string, on: string, event: 'INSERT' | 'UPDATE') => {
  const where = (kind: 'status' | 'dispatch', id: string, extra: string) =>
    `(NEW.${id} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM qualified_apple_status_observations o WHERE o.namespace_key=NEW.namespace_key AND o.observation_id=NEW.${id} ` +
    `AND o.event_kind='${kind}' AND o.account_id=NEW.account_id AND o.original_transaction_id=NEW.original_transaction_id AND o.owner_binding_digest=NEW.owner_binding_digest${extra}))`;
  return trigger(name, on, `CREATE TRIGGER ${name} BEFORE ${event} ON ${on} WHEN ` +
    where('status', 'current_observation_id', ` AND o.lifecycle_epoch=NEW.lifecycle_epoch AND o.database_generation=NEW.database_generation
      AND o.schema_digest=NEW.schema_digest AND o.continuity_digest=NEW.continuity_digest
      AND json_extract(o.evidence_json,'$.provenance')=NEW.provenance_kind
      AND json_extract(o.evidence_json,'$.validUntilMs') IS NEW.valid_until_ms
      AND NEW.projection_json=json_array('qualified-projection/v1',o.observation_id,o.content_digest)
      AND (NEW.projection_state<>'current' OR NOT EXISTS(
        SELECT 1 FROM qualified_apple_status_observations newer WHERE newer.namespace_key=o.namespace_key AND newer.account_id=o.account_id
          AND newer.original_transaction_id=o.original_transaction_id AND newer.event_kind='status' AND newer.sequence>o.sequence))`) +
    ' OR ' + where('dispatch', 'active_request_id', '') + ` ${refusal(name)}`);
};

const prefix = 'qualified_apple_';
const store = `${prefix}store`, namespaces = `${prefix}namespaces`, owners = `${prefix}owners`, transactions = `${prefix}transactions`, grants = `${prefix}grants`,
  observations = `${prefix}observations`, commands = `${prefix}commands`, deliveries = `${prefix}deliveries`, reconciliations = `${prefix}reconciliations`,
  reconciliationPages = `${prefix}reconciliation_pages`, notifications = `${prefix}notifications`, statusObservations = `${prefix}status_observations`,
  statusProjection = `${prefix}status_projection`, dependencies = `${prefix}projection_dependencies`, history = `${prefix}notification_history`,
  historyPages = `${prefix}notification_history_pages`, notificationCommits = `${prefix}notification_commits`;
const ownerKey = (original: string, account: string) =>
  `FOREIGN KEY(namespace_key,${original},${account}) REFERENCES ${owners}(namespace_key,original_transaction_id,account_id)`;

const tables: readonly SchemaDescriptor[] = [
  table(store, `singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    schema_version TEXT NOT NULL CHECK(schema_version='qualified-purchases-v1'),
    fixture_kind TEXT NOT NULL CHECK(fixture_kind='isolated-synthetic'),
    store_id TEXT NOT NULL CHECK(${bytes('store_id', 128)}), generation TEXT NOT NULL CHECK(${bytes('generation', 128)}),
    predecessor_digest TEXT NOT NULL CHECK(${hex64('predecessor_digest')}), extension_digest TEXT NOT NULL CHECK(${hex64('extension_digest')}),
    configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json) AND ${bytes('configuration_json', 65536)}),
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND ${bytes('policy_json', 4096)})`),
  table(namespaces, `namespace_key TEXT PRIMARY KEY CHECK(namespace_key=json_object('provider',provider,'bundleId',bundle_id,'environment',environment)),
    provider TEXT NOT NULL CHECK(provider='Apple'), bundle_id TEXT NOT NULL CHECK(length(bundle_id) BETWEEN 3 AND 255),
    environment TEXT NOT NULL CHECK(environment IN('Sandbox','Production')),
    app_apple_id INTEGER CHECK(app_apple_id IS NULL OR (typeof(app_apple_id)='integer' AND app_apple_id>0)),
    CHECK((environment='Production' AND app_apple_id IS NOT NULL) OR (environment='Sandbox' AND app_apple_id IS NULL)),
    UNIQUE(provider,bundle_id,environment)`),
  table(owners, `${NS}, original_transaction_id TEXT NOT NULL CHECK(${digits('original_transaction_id')}),
    account_id TEXT NOT NULL REFERENCES form_accounts(id),
    app_account_token TEXT NOT NULL CHECK(app_account_token=account_id AND app_account_token GLOB '${uuidV4Pattern}'),
    created_at_ms INTEGER NOT NULL CHECK(${millis('created_at_ms')}),
    PRIMARY KEY(namespace_key,original_transaction_id), UNIQUE(namespace_key,original_transaction_id,account_id)`),
  table(transactions, `${NS}, transaction_id TEXT NOT NULL CHECK(${digits('transaction_id')}),
    original_transaction_id TEXT NOT NULL, account_id TEXT NOT NULL, product_id TEXT NOT NULL CHECK(length(product_id) BETWEEN 1 AND 200),
    product_type TEXT NOT NULL CHECK(product_type IN('Auto-Renewable Subscription','Non-Consumable','Non-Renewing Subscription')),
    app_account_token TEXT NOT NULL CHECK(app_account_token=account_id), purchase_date_ms INTEGER NOT NULL CHECK(${millis('purchase_date_ms')}),
    signed_date_ms INTEGER NOT NULL CHECK(${millis('signed_date_ms')}), expires_date_ms INTEGER CHECK(${optionalMillis('expires_date_ms')}),
    revocation_date_ms INTEGER CHECK(${optionalMillis('revocation_date_ms')}), is_upgraded INTEGER NOT NULL CHECK(is_upgraded IN(0,1)),
    proof_hash TEXT NOT NULL CHECK(${hex64('proof_hash')}), exact_jws TEXT NOT NULL CHECK(${bytes('exact_jws', 60000)}),
    updated_at_ms INTEGER NOT NULL CHECK(${millis('updated_at_ms')}),
    PRIMARY KEY(namespace_key,transaction_id), ${ownerKey('original_transaction_id', 'account_id')},
    UNIQUE(namespace_key,transaction_id,account_id,product_id), UNIQUE(namespace_key,transaction_id,account_id)`),
  table(grants, `${NS}, transaction_id TEXT NOT NULL, account_id TEXT NOT NULL, id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
    entitlement TEXT NOT NULL CHECK(entitlement='form_plus'), granted_at_ms INTEGER NOT NULL CHECK(${millis('granted_at_ms')}),
    PRIMARY KEY(namespace_key,transaction_id), UNIQUE(namespace_key,id),
    FOREIGN KEY(namespace_key,transaction_id,account_id) REFERENCES ${transactions}(namespace_key,transaction_id,account_id)`),
  table(observations, `${NS}, transaction_id TEXT NOT NULL, proof_hash TEXT NOT NULL CHECK(${hex64('proof_hash')}),
    claims TEXT NOT NULL CHECK(json_valid(claims) AND ${bytes('claims', 16384)}), exact_jws TEXT NOT NULL CHECK(${bytes('exact_jws', 60000)}),
    observed_at_ms INTEGER NOT NULL CHECK(${millis('observed_at_ms')}),
    PRIMARY KEY(namespace_key,transaction_id,proof_hash),
    FOREIGN KEY(namespace_key,transaction_id) REFERENCES ${transactions}(namespace_key,transaction_id)`),
  table(commands, `${NS}, account_id TEXT NOT NULL REFERENCES form_accounts(id),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128), transaction_id TEXT NOT NULL, product_id TEXT NOT NULL,
    proof_hash TEXT NOT NULL CHECK(${hex64('proof_hash')}), request_json TEXT NOT NULL CHECK(json_valid(request_json) AND ${bytes('request_json', 8192)}),
    request_digest TEXT NOT NULL CHECK(${hex64('request_digest')}), actor_binding_json TEXT NOT NULL CHECK(json_valid(actor_binding_json) AND ${bytes('actor_binding_json', 2048)}),
    selection_generation TEXT NOT NULL CHECK(${bytes('selection_generation', 128)}),
    PRIMARY KEY(namespace_key,account_id,idempotency_key),
    FOREIGN KEY(namespace_key,transaction_id,account_id,product_id) REFERENCES ${transactions}(namespace_key,transaction_id,account_id,product_id),
    FOREIGN KEY(namespace_key,transaction_id,proof_hash) REFERENCES ${observations}(namespace_key,transaction_id,proof_hash)`),
  table(deliveries, `${NS}, transaction_id TEXT NOT NULL, proof_hash TEXT NOT NULL CHECK(${hex64('proof_hash')}),
    server_delivery_id TEXT NOT NULL UNIQUE CHECK(${bytes('server_delivery_id', 128)}), account_id TEXT NOT NULL, product_id TEXT NOT NULL,
    exact_jws TEXT NOT NULL CHECK(${bytes('exact_jws', 60000)}), original_session_digest TEXT NOT NULL CHECK(${hex64('original_session_digest')}),
    delivery_policy_revision TEXT NOT NULL CHECK(${bytes('delivery_policy_revision', 80)}), delivered_at_ms INTEGER NOT NULL CHECK(${millis('delivered_at_ms')}),
    PRIMARY KEY(namespace_key,transaction_id,proof_hash),
    FOREIGN KEY(namespace_key,transaction_id,account_id,product_id) REFERENCES ${transactions}(namespace_key,transaction_id,account_id,product_id)`),
  table(reconciliations, `${NS}, handle TEXT NOT NULL CHECK(length(handle) BETWEEN 1 AND 128), account_id TEXT NOT NULL, original_transaction_id TEXT NOT NULL,
    owner_binding_json TEXT NOT NULL CHECK(json_valid(owner_binding_json) AND ${bytes('owner_binding_json', 2048)}),
    actor_binding_json TEXT NOT NULL CHECK(json_valid(actor_binding_json) AND ${bytes('actor_binding_json', 2048)}),
    query_json TEXT NOT NULL CHECK(json_valid(query_json) AND ${bytes('query_json', 4096)}),
    expected_page INTEGER NOT NULL CHECK(typeof(expected_page)='integer' AND expected_page>=0), provider_revision TEXT CHECK(provider_revision IS NULL OR ${bytes('provider_revision', 512)}),
    outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json) AND ${bytes('outcome_json', 4096)}),
    PRIMARY KEY(namespace_key,handle), ${ownerKey('original_transaction_id', 'account_id')}`),
  table(reconciliationPages, `${NS}, handle TEXT NOT NULL, request_page INTEGER NOT NULL CHECK(typeof(request_page)='integer' AND request_page>=0),
    request_json TEXT NOT NULL CHECK(json_valid(request_json) AND ${bytes('request_json', 4096)}), body_json TEXT NOT NULL CHECK(json_valid(body_json) AND ${bytes('body_json', 16384)}),
    item_count INTEGER NOT NULL CHECK(typeof(item_count)='integer' AND item_count BETWEEN 0 AND 100), response_hash TEXT NOT NULL CHECK(${hex64('response_hash')}),
    next_cursor TEXT CHECK(next_cursor IS NULL OR ${bytes('next_cursor', 512)}), outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json) AND ${bytes('outcome_json', 4096)}),
    PRIMARY KEY(namespace_key,handle,request_page),
    FOREIGN KEY(namespace_key,handle) REFERENCES ${reconciliations}(namespace_key,handle)`),
  table(notifications, `${NS}, notification_uuid TEXT NOT NULL CHECK(notification_uuid GLOB '${uuidPattern}'), aggregate_id TEXT NOT NULL CHECK(${bytes('aggregate_id', 128)}),
    receipt_id TEXT NOT NULL CHECK(${bytes('receipt_id', 128)}), payload_digest TEXT NOT NULL CHECK(${hex64('payload_digest')}),
    application_input TEXT NOT NULL CHECK(${bytes('application_input', 128)}), account_id TEXT NOT NULL, original_transaction_id TEXT NOT NULL,
    outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json) AND ${bytes('outcome_json', 4096)}), applied_at_ms INTEGER NOT NULL CHECK(${millis('applied_at_ms')}),
    operation_id TEXT NOT NULL UNIQUE CHECK(${bytes('operation_id', 128)}),
    PRIMARY KEY(namespace_key,notification_uuid), UNIQUE(namespace_key,notification_uuid,operation_id), ${ownerKey('original_transaction_id', 'account_id')},
    FOREIGN KEY(namespace_key,notification_uuid,operation_id)
      REFERENCES ${notificationCommits}(namespace_key,notification_uuid,operation_id) DEFERRABLE INITIALLY DEFERRED`),
  table(notificationCommits, `${NS}, notification_uuid TEXT NOT NULL, operation_id TEXT NOT NULL,
    PRIMARY KEY(namespace_key,notification_uuid,operation_id),
    FOREIGN KEY(namespace_key,notification_uuid,operation_id) REFERENCES ${notifications}(namespace_key,notification_uuid,operation_id)`),
  table(statusObservations, `${NS}, sequence INTEGER NOT NULL UNIQUE CHECK(typeof(sequence)='integer' AND sequence>=1),
    observation_id TEXT NOT NULL CHECK(${hex64('observation_id')}), encoding_version TEXT NOT NULL CHECK(encoding_version='qualified-status-v1'),
    account_id TEXT NOT NULL, original_transaction_id TEXT NOT NULL, owner_binding_digest TEXT NOT NULL CHECK(${hex64('owner_binding_digest')}),
    event_kind TEXT NOT NULL CHECK(event_kind IN('dispatch','status','history','notification','outcome')), event_key TEXT NOT NULL CHECK(${hex64('event_key')}),
    request_id TEXT NOT NULL CHECK(${hex64('request_id')}),
    lifecycle_epoch INTEGER NOT NULL CHECK(typeof(lifecycle_epoch)='integer' AND lifecycle_epoch BETWEEN 0 AND 9007199254740991),
    database_generation TEXT NOT NULL CHECK(length(CAST(database_generation AS BLOB)) BETWEEN 1 AND 128),
    schema_digest TEXT NOT NULL CHECK(${hex64('schema_digest')}), continuity_digest TEXT NOT NULL CHECK(${hex64('continuity_digest')}),
    proof_transaction_id TEXT, proof_hash TEXT CHECK((proof_transaction_id IS NULL AND proof_hash IS NULL) OR (proof_transaction_id IS NOT NULL AND proof_hash IS NOT NULL AND ${hex64('proof_hash')})),
    binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB))<=8192),
    evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB))<=16384),
    content_digest TEXT NOT NULL CHECK(${hex64('content_digest')}), observed_at_ms INTEGER NOT NULL CHECK(${millis('observed_at_ms')}),
    PRIMARY KEY(namespace_key,observation_id), UNIQUE(namespace_key,account_id,event_kind,event_key),
    ${ownerKey('original_transaction_id', 'account_id')},
    FOREIGN KEY(namespace_key,proof_transaction_id,proof_hash) REFERENCES ${observations}(namespace_key,transaction_id,proof_hash)`),
  table(statusProjection, `${NS}, original_transaction_id TEXT NOT NULL, account_id TEXT NOT NULL,
    owner_binding_digest TEXT NOT NULL CHECK(${hex64('owner_binding_digest')}), encoding_version TEXT NOT NULL CHECK(encoding_version='qualified-status-v1'),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
    lifecycle_epoch INTEGER NOT NULL CHECK(typeof(lifecycle_epoch)='integer' AND lifecycle_epoch BETWEEN 0 AND 9007199254740991),
    database_generation TEXT NOT NULL CHECK(length(CAST(database_generation AS BLOB)) BETWEEN 1 AND 128),
    schema_digest TEXT NOT NULL CHECK(${hex64('schema_digest')}), continuity_digest TEXT NOT NULL CHECK(${hex64('continuity_digest')}),
    current_observation_id TEXT, projection_state TEXT NOT NULL CHECK(projection_state IN('pending','current','held')),
    provenance_kind TEXT NOT NULL CHECK(provenance_kind IN('independent_status','notification_evidence')),
    projection_json TEXT NOT NULL CHECK(json_valid(projection_json) AND length(CAST(projection_json AS BLOB))<=16384),
    valid_until_ms INTEGER CHECK(${optionalMillis('valid_until_ms')}), active_request_id TEXT,
    dispatch_state TEXT CHECK(dispatch_state IS NULL OR dispatch_state IN('dispatching','unsettled')),
    request_deadline_ms INTEGER CHECK(${optionalMillis('request_deadline_ms')}), last_seen_at_ms INTEGER NOT NULL CHECK(${millis('last_seen_at_ms')}),
    CHECK((active_request_id IS NULL AND dispatch_state IS NULL AND request_deadline_ms IS NULL)
      OR (active_request_id IS NOT NULL AND dispatch_state IS NOT NULL AND request_deadline_ms IS NOT NULL)),
    CHECK(projection_state<>'current' OR current_observation_id IS NOT NULL),
    PRIMARY KEY(namespace_key,original_transaction_id), ${ownerKey('original_transaction_id', 'account_id')},
    FOREIGN KEY(namespace_key,current_observation_id) REFERENCES ${statusObservations}(namespace_key,observation_id),
    FOREIGN KEY(namespace_key,active_request_id) REFERENCES ${statusObservations}(namespace_key,observation_id)`),
  table(dependencies, `${NS}, original_transaction_id TEXT NOT NULL, projection_revision INTEGER NOT NULL CHECK(typeof(projection_revision)='integer' AND projection_revision>=1),
    aggregate_id TEXT NOT NULL CHECK(${bytes('aggregate_id', 128)}), aggregate_version INTEGER NOT NULL CHECK(typeof(aggregate_version)='integer' AND aggregate_version>=1),
    evidence_reference TEXT NOT NULL CHECK(${bytes('evidence_reference', 512)}),
    PRIMARY KEY(namespace_key,original_transaction_id,projection_revision,aggregate_id),
    FOREIGN KEY(namespace_key,original_transaction_id) REFERENCES ${statusProjection}(namespace_key,original_transaction_id)`),
  table(history, `${NS}, handle TEXT NOT NULL CHECK(length(handle) BETWEEN 1 AND 128),
    request_json TEXT NOT NULL CHECK(json_valid(request_json) AND ${bytes('request_json', 4096)}), interval_json TEXT NOT NULL CHECK(json_valid(interval_json) AND ${bytes('interval_json', 1024)}),
    policy_revision TEXT NOT NULL CHECK(${bytes('policy_revision', 80)}), store_generation TEXT NOT NULL CHECK(${bytes('store_generation', 128)}),
    expected_page INTEGER NOT NULL CHECK(typeof(expected_page)='integer' AND expected_page>=0), current_token TEXT CHECK(current_token IS NULL OR ${bytes('current_token', 512)}),
    outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json) AND ${bytes('outcome_json', 4096)}), PRIMARY KEY(namespace_key,handle)`),
  table(historyPages, `${NS}, handle TEXT NOT NULL, request_page INTEGER NOT NULL CHECK(typeof(request_page)='integer' AND request_page>=0),
    request_token TEXT CHECK(request_token IS NULL OR ${bytes('request_token', 512)}), request_json TEXT NOT NULL CHECK(json_valid(request_json) AND ${bytes('request_json', 4096)}),
    page_json TEXT NOT NULL CHECK(json_valid(page_json) AND ${bytes('page_json', 16384)}), item_count INTEGER NOT NULL CHECK(typeof(item_count)='integer' AND item_count BETWEEN 0 AND 20),
    response_hash TEXT NOT NULL CHECK(${hex64('response_hash')}), next_token TEXT CHECK(next_token IS NULL OR ${bytes('next_token', 512)}),
    outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json) AND ${bytes('outcome_json', 4096)}),
    PRIMARY KEY(namespace_key,handle,request_page), FOREIGN KEY(namespace_key,handle) REFERENCES ${history}(namespace_key,handle)`),
];

function pageProgression(parent: string, pages: string, token: string, requestToken: string, nextToken: string, requestShape = '1'): SchemaDescriptor[] {
  const initial = `${parent}_initial`, order = `${pages}_order`, advance = `${parent}_advance`, commit = `${pages}_advance_parent`;
  return [
    trigger(initial, parent, `CREATE TRIGGER ${initial} BEFORE INSERT ON ${parent} WHEN NEW.expected_page<>0 ${refusal(initial)}`),
    trigger(order, pages, `CREATE TRIGGER ${order} BEFORE INSERT ON ${pages} WHEN NOT EXISTS(
      SELECT 1 FROM ${parent} r WHERE r.namespace_key=NEW.namespace_key AND r.handle=NEW.handle AND r.expected_page=NEW.request_page
        AND r.${token} IS ${requestToken} AND (r.expected_page=0 OR r.${token} IS NOT NULL) AND (${requestShape})) ${refusal(order)}`),
    trigger(advance, parent, `CREATE TRIGGER ${advance} BEFORE UPDATE ON ${parent}
      WHEN (NEW.expected_page IS NOT OLD.expected_page OR NEW.${token} IS NOT OLD.${token}) AND NOT EXISTS(
        SELECT 1 FROM ${pages} p WHERE p.namespace_key=OLD.namespace_key AND p.handle=OLD.handle AND p.request_page=OLD.expected_page
          AND NEW.expected_page=OLD.expected_page+1 AND NEW.${token} IS p.${nextToken} AND NEW.outcome_json=p.outcome_json) ${refusal(advance)}`),
    // AFTER INSERT makes the accepted immutable page and its checkpoint one SQLite statement, including in autocommit.
    trigger(commit, pages, `CREATE TRIGGER ${commit} AFTER INSERT ON ${pages} BEGIN
      UPDATE ${parent} SET expected_page=NEW.request_page+1,${token}=NEW.${nextToken},outcome_json=NEW.outcome_json
      WHERE namespace_key=NEW.namespace_key AND handle=NEW.handle; END`),
  ];
}

// Guard every unique identity, including explicit rowids, before SQLite can delete a conflicting retained row.
function insertCollision(on: string, ...keys: readonly string[][]): SchemaDescriptor {
  const name = `${on}_replacement`;
  const collision = [['rowid'], ...keys].map(key => '(' + key.map(column => `old.${column}=NEW.${column}`).join(' AND ') + ')').join(' OR ');
  return trigger(name, on, `CREATE TRIGGER ${name} BEFORE INSERT ON ${on}
    WHEN EXISTS(SELECT 1 FROM ${on} old WHERE ${collision}) ${refusal(name)}`);
}

const dispatchCollision = (event: 'INSERT' | 'UPDATE'): SchemaDescriptor => {
  const name = `${statusProjection}_dispatch_collision_${event.toLowerCase()}`;
  return trigger(name, statusProjection, `CREATE TRIGGER ${name} BEFORE ${event} ON ${statusProjection}
    WHEN NEW.active_request_id IS NOT NULL AND EXISTS(SELECT 1 FROM ${statusProjection} p WHERE p.account_id=NEW.account_id
      AND p.active_request_id IS NOT NULL ${event === 'UPDATE' ? 'AND p.rowid<>OLD.rowid' : ''}) ${refusal(name)}`);
};

// Shared by the application insert guard and the reader. A's promotion record is evidence of acceptance, separate from a digest.
export const authenticatedNotificationVariant = `FROM main.notification_inbox_aggregates a
  JOIN main.qualified_apple_namespaces n ON n.namespace_key=a.namespace_key
  JOIN main.notification_inbox_variants v ON v.aggregate_id=a.aggregate_id
  JOIN main.notification_inbox_variants c ON c.receipt_id=v.canonical_receipt_id AND c.aggregate_id=a.aggregate_id AND c.canonical_receipt_id=c.receipt_id
  JOIN main.notification_inbox_receipts r ON r.receipt_id=v.receipt_id
  JOIN main.notification_inbox_receipts cr ON cr.receipt_id=c.receipt_id AND cr.digest=r.digest AND cr.byte_length=r.byte_length
  JOIN main.notification_inbox_state s ON s.receipt_id=r.receipt_id AND s.aggregate_id=a.aggregate_id AND s.authentication='verified'
  JOIN main.notification_inbox_state cs ON cs.receipt_id=cr.receipt_id AND cs.aggregate_id=a.aggregate_id AND cs.authentication='verified'
  JOIN main.notification_inbox_payloads b ON b.receipt_id=r.receipt_id AND typeof(b.bytes)='blob' AND length(b.bytes)=r.byte_length
  JOIN main.notification_inbox_payloads cb ON cb.receipt_id=cr.receipt_id AND cb.bytes=b.bytes
  JOIN main.notification_inbox_store i ON i.singleton=1
  JOIN main.qualified_apple_store q ON q.singleton=1 AND q.generation=i.generation AND q.store_id=i.store_id
  JOIN main.notification_inbox_operations op ON op.receipt_id=r.receipt_id
    AND json_extract(op.input_json,'$.kind')='promote'
    AND json_extract(op.input_json,'$.receiptId')=r.receipt_id
    AND json_extract(op.input_json,'$.payloadDigest')=r.digest
    AND json_extract(op.input_json,'$.byteLength')=r.byte_length
    AND json_extract(op.input_json,'$.storeGeneration')=i.generation
    AND json_extract(op.input_json,'$.outer.notificationUUID')=a.notification_uuid
    AND json_extract(op.input_json,'$.outer.namespace.provider')=n.provider
    AND json_extract(op.input_json,'$.outer.namespace.bundleId')=n.bundle_id
    AND json_extract(op.input_json,'$.outer.namespace.environment')=n.environment
    AND json_type(op.input_json,'$.outer.namespace.appAppleId') IN ('null','integer')
    AND json_extract(op.input_json,'$.outer.namespace.appAppleId') IS n.app_apple_id
    AND json_extract(op.result_json,'$.status')='ok' AND json_extract(op.result_json,'$.acknowledge')=1
    AND json_extract(op.result_json,'$.receiptId')=r.receipt_id`;

const supporting: readonly SchemaDescriptor[] = [
  // A appends its operation after the callback. Only the minimal qualified acceptance identity survives A's independent erasure.
  trigger(`${notificationCommits}_record`, 'notification_inbox_operations', `CREATE TRIGGER ${notificationCommits}_record
    AFTER INSERT ON notification_inbox_operations BEGIN
      INSERT INTO ${notificationCommits}(namespace_key,notification_uuid,operation_id)
      SELECT n.namespace_key,n.notification_uuid,n.operation_id FROM ${notifications} n
      WHERE n.operation_id=NEW.operation_id AND NOT EXISTS(SELECT 1 FROM ${notificationCommits} c
        WHERE c.namespace_key=n.namespace_key AND c.notification_uuid=n.notification_uuid AND c.operation_id=n.operation_id); END`),
  trigger(`${notificationCommits}_bound`, notificationCommits, `CREATE TRIGGER ${notificationCommits}_bound BEFORE INSERT ON ${notificationCommits}
    WHEN NOT EXISTS(SELECT 1 FROM ${notifications} n
      JOIN notification_inbox_operations op ON op.operation_id=n.operation_id AND op.receipt_id=n.receipt_id
      JOIN notification_inbox_state s ON s.receipt_id=n.receipt_id AND s.aggregate_id=n.aggregate_id
      JOIN notification_inbox_work w ON w.work_id=s.work_id AND w.receipt_id=s.receipt_id AND w.disposition='applied'
      JOIN notification_inbox_aggregates a ON a.aggregate_id=n.aggregate_id AND a.namespace_key=n.namespace_key AND a.notification_uuid=n.notification_uuid
      JOIN notification_inbox_claims c ON c.receipt_id=n.receipt_id AND c.attempt_id=json_extract(op.input_json,'$.claim.processingAttemptId')
        AND c.kind='processing' AND c.settled=1 AND c.generation=w.claim_generation
      JOIN notification_inbox_store i ON i.singleton=1 AND c.store_generation=i.generation
      WHERE n.namespace_key=NEW.namespace_key AND n.notification_uuid=NEW.notification_uuid AND n.operation_id=NEW.operation_id
        AND s.authentication='verified' AND s.disposition='applied' AND s.reason='applied' AND a.conflicted=0 AND a.invalidation_required=0
        AND (SELECT count(*) FROM json_each(op.input_json))=4
        AND json_extract(op.input_json,'$.kind')='purchase_commit'
        AND json_extract(op.input_json,'$.operationId')=n.operation_id
        AND json_extract(op.input_json,'$.applicationInput')=n.application_input
        AND (SELECT count(*) FROM json_each(op.input_json,'$.claim'))=7
        AND json_extract(op.input_json,'$.claim.receiptId')=n.receipt_id
        AND json_extract(op.input_json,'$.claim.workId')=w.work_id
        AND json_extract(op.input_json,'$.claim.generation')=c.generation
        AND json_extract(op.input_json,'$.claim.custodyId')=c.custody_id
        AND json_extract(op.input_json,'$.claim.storeGeneration')=i.generation
        AND (SELECT count(*) FROM json_each(op.input_json,'$.claim.versions'))=3
        AND json_extract(op.input_json,'$.claim.versions.receipt')=s.version-1
        AND json_extract(op.input_json,'$.claim.versions.work')=w.version-1
        AND json_extract(op.input_json,'$.claim.versions.aggregate')=a.version
        AND op.result_json=json_object('status','ok','receiptId',n.receipt_id,'version',s.version,'acknowledge',json('true'),
          'workId',w.work_id,'aggregateVersion',a.version,'disposition','applied')) ${refusal(`${notificationCommits}_bound`)}`),
  immutable(notificationCommits), retained(notificationCommits),
  index(`${prefix}status_one_dispatch_per_account`, statusProjection,
    `CREATE UNIQUE INDEX ${prefix}status_one_dispatch_per_account ON ${statusProjection}(account_id) WHERE active_request_id IS NOT NULL`),
  index(`${prefix}status_observation_account_sequence`, statusObservations,
    `CREATE INDEX ${prefix}status_observation_account_sequence ON ${statusObservations}(namespace_key,account_id,sequence)`),
  index(`${prefix}status_observation_lineage_sequence`, statusObservations,
    `CREATE INDEX ${prefix}status_observation_lineage_sequence ON ${statusObservations}(namespace_key,account_id,original_transaction_id,sequence DESC) WHERE event_kind='status'`),
  index(`${prefix}owner_account`, owners, `CREATE INDEX ${prefix}owner_account ON ${owners}(account_id)`),
  immutable(namespaces), retained(namespaces),
  immutable(store),
  retained(store),
  immutable(owners), retained(owners),
  trigger(`${transactions}_identity`, transactions, `CREATE TRIGGER ${transactions}_identity BEFORE UPDATE OF namespace_key,transaction_id,original_transaction_id,account_id,product_id,product_type,app_account_token,purchase_date_ms ON ${transactions} ${refusal(`${transactions}_identity`)}`),
  trigger(`${transactions}_rowid`, transactions, `CREATE TRIGGER ${transactions}_rowid BEFORE UPDATE ON ${transactions} WHEN NEW.rowid IS NOT OLD.rowid ${refusal(`${transactions}_rowid`)}`),
  trigger(`${transactions}_sticky`, transactions, `CREATE TRIGGER ${transactions}_sticky BEFORE UPDATE ON ${transactions} WHEN (OLD.revocation_date_ms IS NOT NULL AND NEW.revocation_date_ms IS NULL) OR NEW.is_upgraded<OLD.is_upgraded OR NEW.signed_date_ms<OLD.signed_date_ms ${refusal(`${transactions}_sticky`)}`),
  retained(transactions), policyBound(transactions, 'exact_jws', 'maxEvidenceBytes'), policyBound(transactions, 'exact_jws', 'maxEvidenceBytes', 'UPDATE'),
  immutable(grants), retained(grants),
  immutable(observations), retained(observations), policyBound(observations, 'exact_jws', 'maxEvidenceBytes'), policyBound(observations, 'claims', 'maxEvidenceBytes'),
  immutable(commands), retained(commands),
  immutable(deliveries), retained(deliveries), policyBound(deliveries, 'exact_jws', 'maxEvidenceBytes'),
  trigger(`${deliveries}_proof`, deliveries, `CREATE TRIGGER ${deliveries}_proof BEFORE INSERT ON ${deliveries}
    WHEN length(CAST(NEW.exact_jws AS BLOB))<=${policyJson('maxEvidenceBytes')} AND NOT EXISTS(
      SELECT 1 FROM ${observations} o WHERE o.namespace_key=NEW.namespace_key AND o.transaction_id=NEW.transaction_id
        AND o.proof_hash=NEW.proof_hash AND o.exact_jws=NEW.exact_jws) ${refusal(`${deliveries}_proof`)}`),
  trigger(`${deliveries}_identity_separate`, deliveries, `CREATE TRIGGER ${deliveries}_identity_separate BEFORE INSERT ON ${deliveries} WHEN ` +
    `EXISTS(SELECT 1 FROM notification_inbox_receipts WHERE receipt_id=NEW.server_delivery_id) OR EXISTS(SELECT 1 FROM notification_inbox_work WHERE work_id=NEW.server_delivery_id) ` +
    `OR EXISTS(SELECT 1 FROM notification_inbox_aggregates WHERE aggregate_id=NEW.server_delivery_id) OR EXISTS(SELECT 1 FROM notification_inbox_operations WHERE operation_id=NEW.server_delivery_id) ` +
    `OR EXISTS(SELECT 1 FROM notification_inbox_claims WHERE attempt_id=NEW.server_delivery_id) ${refusal(`${deliveries}_identity_separate`)}`),
  trigger(`${reconciliations}_binding`, reconciliations, `CREATE TRIGGER ${reconciliations}_binding BEFORE UPDATE OF namespace_key,handle,account_id,original_transaction_id,owner_binding_json,actor_binding_json,query_json ON ${reconciliations} ${refusal(`${reconciliations}_binding`)}`),
  ...pageProgression(reconciliations, reconciliationPages, 'provider_revision', "json_extract(NEW.request_json,'$.providerRevision')", 'next_cursor',
    "json_type(NEW.request_json,'$.providerRevision') IN ('null','text')"), retained(reconciliations),
  immutable(reconciliationPages), retained(reconciliationPages),
  policyBound(reconciliationPages, 'body_json', 'maxEvidenceBytes'), countBound(reconciliationPages, 'body_json', 'maxPageSize', 'maxEvidenceBytes'),
  immutable(notifications), retained(notifications),
  trigger(`${notifications}_bound`, notifications, `CREATE TRIGGER ${notifications}_bound BEFORE INSERT ON ${notifications} WHEN NOT EXISTS(
    SELECT 1 ${authenticatedNotificationVariant}
      WHERE a.aggregate_id=NEW.aggregate_id AND a.namespace_key=NEW.namespace_key AND a.notification_uuid=NEW.notification_uuid
        AND r.receipt_id=NEW.receipt_id AND cr.receipt_id=r.receipt_id AND r.digest=NEW.payload_digest
        AND s.disposition='claimed' AND a.conflicted=0 AND a.invalidation_required=0
        AND EXISTS(SELECT 1 FROM notification_inbox_claims c JOIN notification_inbox_work w ON w.work_id=s.work_id
          WHERE c.receipt_id=r.receipt_id AND c.kind='processing' AND c.settled=0 AND c.cancel_requested=0
            AND c.store_generation=i.generation AND w.receipt_id=r.receipt_id AND w.claim_generation=c.generation)) ${refusal(`${notifications}_bound`)}`),
  immutable(statusObservations), retained(statusObservations), policyBound(statusObservations, 'evidence_json', 'maxEvidenceBytes'),
  trigger(`${statusObservations}_sequence`, statusObservations, `CREATE TRIGGER ${statusObservations}_sequence BEFORE INSERT ON ${statusObservations} WHEN NEW.sequence IS NOT (SELECT coalesce(max(sequence),0)+1 FROM ${statusObservations}) ${refusal(`${statusObservations}_sequence`)}`),
  trigger(`${statusObservations}_proof`, statusObservations, `CREATE TRIGGER ${statusObservations}_proof BEFORE INSERT ON ${statusObservations}
    WHEN NEW.proof_transaction_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ${transactions} t WHERE t.namespace_key=NEW.namespace_key
      AND t.transaction_id=NEW.proof_transaction_id AND t.original_transaction_id=NEW.original_transaction_id AND t.account_id=NEW.account_id)
    ${refusal(`${statusObservations}_proof`)}`),
  trigger(`${statusProjection}_binding`, statusProjection, `CREATE TRIGGER ${statusProjection}_binding BEFORE UPDATE OF namespace_key,original_transaction_id,account_id,owner_binding_digest ON ${statusProjection} ${refusal(`${statusProjection}_binding`)}`),
  retained(statusProjection),
  trigger(`${statusProjection}_advancing`, statusProjection, `CREATE TRIGGER ${statusProjection}_advancing BEFORE UPDATE ON ${statusProjection}
    WHEN NEW.revision<>OLD.revision+1 OR NEW.last_seen_at_ms<OLD.last_seen_at_ms
      OR (OLD.current_observation_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM ${statusObservations} prior
        JOIN ${statusObservations} candidate ON candidate.namespace_key=prior.namespace_key AND candidate.observation_id=NEW.current_observation_id
        WHERE prior.namespace_key=OLD.namespace_key AND prior.observation_id=OLD.current_observation_id
          AND (candidate.sequence>prior.sequence OR (candidate.sequence=prior.sequence
            AND (OLD.projection_state='current' OR NEW.projection_state<>'current')))))
    ${refusal(`${statusProjection}_advancing`)}`),
  dispatchCollision('INSERT'), dispatchCollision('UPDATE'),
  statusEvidenceBound(`${statusProjection}_bound_insert`, statusProjection, 'INSERT'),
  statusEvidenceBound(`${statusProjection}_bound_update`, statusProjection, 'UPDATE'),
  immutable(dependencies), retained(dependencies),
  trigger(`${dependencies}_bound`, dependencies, `CREATE TRIGGER ${dependencies}_bound BEFORE INSERT ON ${dependencies} WHEN NOT EXISTS(
    SELECT 1 FROM ${statusProjection} p JOIN ${statusObservations} o ON o.namespace_key=p.namespace_key AND o.observation_id=p.current_observation_id
    JOIN json_each(o.evidence_json,'$.notifications') e JOIN notification_inbox_aggregates a ON a.aggregate_id=NEW.aggregate_id
    WHERE p.namespace_key=NEW.namespace_key AND p.original_transaction_id=NEW.original_transaction_id AND p.revision=NEW.projection_revision
      AND a.namespace_key=NEW.namespace_key AND a.version=NEW.aggregate_version AND e.value=NEW.evidence_reference
      AND json_extract(e.value,'$.aggregateId')=a.aggregate_id AND json_extract(e.value,'$.aggregateVersion')=a.version
      AND json_extract(e.value,'$.notificationUUID')=a.notification_uuid) ${refusal(`${dependencies}_bound`)}`),
  trigger(`${history}_binding`, history, `CREATE TRIGGER ${history}_binding BEFORE UPDATE OF namespace_key,handle,request_json,interval_json,policy_revision,store_generation ON ${history} ${refusal(`${history}_binding`)}`),
  ...pageProgression(history, historyPages, 'current_token', 'NEW.request_token', 'next_token'), retained(history),
  immutable(historyPages), retained(historyPages),
  policyBound(historyPages, 'page_json', 'maxHistoryPageBytes'), countBound(historyPages, 'page_json', 'maxHistoryItems', 'maxHistoryPageBytes'),
  ...[reconciliations, statusProjection, history].map(on => trigger(`${on}_rowid`, on,
    `CREATE TRIGGER ${on}_rowid BEFORE UPDATE ON ${on} WHEN NEW.rowid IS NOT OLD.rowid ${refusal(`${on}_rowid`)}`)),
  insertCollision(store, ['singleton']),
  insertCollision(namespaces, ['namespace_key'], ['provider', 'bundle_id', 'environment']),
  insertCollision(owners, ['namespace_key', 'original_transaction_id']),
  insertCollision(transactions, ['namespace_key', 'transaction_id']),
  insertCollision(grants, ['namespace_key', 'transaction_id'], ['namespace_key', 'id']),
  insertCollision(observations, ['namespace_key', 'transaction_id', 'proof_hash']),
  insertCollision(commands, ['namespace_key', 'account_id', 'idempotency_key']),
  insertCollision(deliveries, ['namespace_key', 'transaction_id', 'proof_hash'], ['server_delivery_id']),
  insertCollision(reconciliations, ['namespace_key', 'handle']),
  insertCollision(reconciliationPages, ['namespace_key', 'handle', 'request_page']),
  insertCollision(notifications, ['namespace_key', 'notification_uuid'], ['operation_id']),
  insertCollision(notificationCommits, ['namespace_key', 'notification_uuid', 'operation_id']),
  insertCollision(statusObservations, ['namespace_key', 'observation_id'], ['sequence'], ['namespace_key', 'account_id', 'event_kind', 'event_key']),
  insertCollision(statusProjection, ['namespace_key', 'original_transaction_id']),
  insertCollision(dependencies, ['namespace_key', 'original_transaction_id', 'projection_revision', 'aggregate_id']),
  insertCollision(history, ['namespace_key', 'handle']),
  insertCollision(historyPages, ['namespace_key', 'handle', 'request_page']),
];
/** Fences every predecessor table. They are additive refusal triggers; the original SQL objects are untouched. */
const fences: readonly SchemaDescriptor[] = predecessorPurchaseTables.flatMap(name => (['INSERT', 'UPDATE', 'DELETE'] as const).map(event => {
  const trigger_name = `${prefix}fence_${name}_${event.toLowerCase()}`;
  return trigger(trigger_name, name, `CREATE TRIGGER ${trigger_name} BEFORE ${event} ON ${name} BEGIN SELECT RAISE(ABORT,'qualified_apple_predecessor_fenced'); END`);
}));

export const qualifiedPurchaseDescriptors: readonly SchemaDescriptor[] = Object.freeze([...tables, ...supporting, ...fences].map(item => Object.freeze({ ...item })));
export const qualifiedPurchaseSql: string = qualifiedPurchaseDescriptors.map(item => item.sql).join(';\n') + ';';

type Row = { type: string; name: string; tbl_name: string; sql: string | null };
const schemaRows = (db: Sqlite): readonly Readonly<{ type: string; name: string; table: string; sql: string }>[] =>
  (db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all() as Row[])
    .map(row => Object.freeze({ type: row.type, name: row.name, table: row.tbl_name, sql: row.sql ?? '' }));

type Reference = Readonly<{ allJson: string; predecessorDigest: string; extensionDigest: string; tables: readonly string[]; predecessorJson: string }>;
let reference: Reference | undefined;
/**
 * Short-lived in-memory executor of the genuine selected SQL. It derives the expected descriptors only: no receipt or
 * data is ever written to a candidate, and the executor is always closed.
 */
export function genuineSchemaReference(): Reference {
  if (reference) return reference;
  const memory = new Database(':memory:');
  try {
    memory.pragma('foreign_keys = ON');
    memory.exec(formMigrationsDefinition);
    const selection = selectSourceSubscriptionStatusMigrations();
    if (selection.length !== 27) throw new Error('qualified_reference_unavailable');
    for (const migration of selection) memory.exec(migration.sql);
    const predecessor = schemaRows(memory);
    memory.exec(notificationInboxSql);
    memory.exec(qualifiedPurchaseSql);
    const all = schemaRows(memory);
    const known = new Set(predecessor.map(row => `${row.type}\0${row.name}`));
    const extension = all.filter(row => !known.has(`${row.type}\0${row.name}`));
    reference = Object.freeze({ allJson: JSON.stringify(all), predecessorDigest: evidenceDigest(predecessor), extensionDigest: evidenceDigest(extension),
      tables: Object.freeze(predecessor.filter(row => row.type === 'table').map(row => row.name)), predecessorJson: JSON.stringify(predecessor) });
    return reference;
  } finally { memory.close(); }
}
/** Genuine predecessor-only expectation, used by the empty-upgrade envelope before any extension exists. */
export const genuinePredecessorSchema = (): Readonly<{ json: string; digest: string; tables: readonly string[] }> => {
  const value = genuineSchemaReference();
  return Object.freeze({ json: value.predecessorJson, digest: value.predecessorDigest, tables: value.tables });
};
export const currentSchemaRows = schemaRows;

export function predecessorPurchaseTablesEmpty(db: Sqlite): boolean {
  return predecessorPurchaseTables.every(name => db.prepare(`SELECT 1 FROM main.${name} LIMIT 1`).get() === undefined);
}

function fail(): never { throw new Error('qualified_purchase_schema_unavailable'); }
/**
 * Reopen validator: exact genuine receipts 1..27 plus the exact inbox and qualified extension and fence objects, a matching store,
 * configuration and policy, empty fenced predecessor tables and database integrity. It permits qualified rows and does
 * not rerun the empty installation predicate. Any irregularity is unavailable; nothing is repaired.
 */
export function assertQualifiedPurchaseSchema(db: Sqlite): void {
  try {
    if (!db.open || db.pragma('foreign_keys', { simple: true }) !== 1) fail();
    assertSourceSubscriptionStatusHistory(db.prepare('SELECT version,checksum FROM main.form_migrations ORDER BY version').all() as { version: number; checksum: string }[], true);
    const expected = genuineSchemaReference();
    if (JSON.stringify(schemaRows(db)) !== expected.allJson) fail();
    assertNotificationInboxSchema(db);
    const record = readQualifiedStore(db);
    if (record.predecessorDigest !== expected.predecessorDigest || record.extensionDigest !== expected.extensionDigest) fail();
    const inbox = db.prepare('SELECT * FROM main.notification_inbox_store').all() as { singleton: number; store_id: string; generation: string; policy_json: string;
      ingress: string; history_floor: number; fixture_kind: string }[];
    const slot = inbox[0];
    if (inbox.length !== 1 || !slot || slot.singleton !== 1 || slot.store_id !== record.storeId || slot.generation !== record.generation ||
        slot.fixture_kind !== 'isolated-synthetic' || !/^[a-zA-Z0-9_-]{1,128}$/.test(slot.ingress) || !Number.isSafeInteger(slot.history_floor) || slot.history_floor < 0) fail();
    validateInboxPolicy(JSON.parse(slot.policy_json) as InboxPolicy);
    const rows = db.prepare(`SELECT namespace_key,provider,bundle_id,environment,app_apple_id FROM main.${namespaces} ORDER BY namespace_key`).all() as
      { namespace_key: string; provider: string; bundle_id: string; environment: string; app_apple_id: number | null }[];
    const configured = record.configuration.namespaces.map(item => ({ namespace_key: qualifiedNamespaceKey(item.namespace), provider: 'Apple',
      bundle_id: item.namespace.bundleId, environment: item.namespace.environment, app_apple_id: item.namespace.appAppleId }))
      .sort((one, two) => one.namespace_key < two.namespace_key ? -1 : 1);
    if (JSON.stringify(rows) !== JSON.stringify(configured)) fail();
    if (!predecessorPurchaseTablesEmpty(db)) fail();
    if (db.pragma('main.integrity_check', { simple: true }) !== 'ok' || (db.pragma('main.foreign_key_check') as unknown[]).length !== 0) fail();
  } catch { fail(); }
}
