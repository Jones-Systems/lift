import type { Sqlite } from '../storage.js';
import type { InboxPolicy } from './notification-inbox.types.js';

const definitions = [
  `CREATE TABLE notification_inbox_store (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL, generation TEXT NOT NULL,
    policy_json TEXT NOT NULL, ingress TEXT NOT NULL, history_floor INTEGER NOT NULL CHECK(history_floor>=0),
    fixture_kind TEXT NOT NULL CHECK(fixture_kind='isolated-synthetic'))`,
  `CREATE TABLE notification_inbox_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id TEXT NOT NULL UNIQUE, received_at INTEGER NOT NULL,
    byte_length INTEGER NOT NULL, digest TEXT NOT NULL, provenance TEXT NOT NULL, envelope_bytes INTEGER NOT NULL,
    payload_until INTEGER NOT NULL, tombstone_until INTEGER NOT NULL, audit_until INTEGER NOT NULL)`,
  `CREATE TABLE notification_inbox_payloads (
    receipt_id TEXT PRIMARY KEY REFERENCES notification_inbox_receipts(receipt_id), bytes BLOB NOT NULL)`,
  `CREATE TABLE notification_inbox_state (
    receipt_id TEXT PRIMARY KEY REFERENCES notification_inbox_receipts(receipt_id), version INTEGER NOT NULL,
    authentication TEXT NOT NULL, disposition TEXT NOT NULL, reason TEXT NOT NULL,
    aggregate_id TEXT, work_id TEXT, attempts INTEGER NOT NULL, transition_count INTEGER NOT NULL)`,
  `CREATE TABLE notification_inbox_aggregates (
    aggregate_id TEXT PRIMARY KEY, namespace_key TEXT NOT NULL, namespace_json TEXT NOT NULL, notification_uuid TEXT NOT NULL,
    version INTEGER NOT NULL, conflicted INTEGER NOT NULL CHECK(conflicted IN(0,1)), overflow INTEGER NOT NULL,
    invalidation_required INTEGER NOT NULL CHECK(invalidation_required IN(0,1)),
    UNIQUE(namespace_key,notification_uuid))`,
  `CREATE TABLE notification_inbox_variants (
    receipt_id TEXT PRIMARY KEY REFERENCES notification_inbox_receipts(receipt_id),
    aggregate_id TEXT NOT NULL REFERENCES notification_inbox_aggregates(aggregate_id), canonical_receipt_id TEXT NOT NULL)`,
  `CREATE TABLE notification_inbox_work (
    work_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE REFERENCES notification_inbox_receipts(receipt_id),
    version INTEGER NOT NULL, disposition TEXT NOT NULL, claim_generation INTEGER NOT NULL)`,
  `CREATE TABLE notification_inbox_claims (
    attempt_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER NOT NULL,
    custody_id TEXT NOT NULL, store_generation TEXT NOT NULL, settled INTEGER NOT NULL CHECK(settled IN(0,1)),
    cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN(0,1)))`,
  `CREATE UNIQUE INDEX notification_inbox_unresolved ON notification_inbox_claims(receipt_id) WHERE settled=0`,
  `CREATE TABLE notification_inbox_transitions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, receipt_id TEXT NOT NULL, snapshot_json TEXT NOT NULL)`,
  `CREATE TABLE notification_inbox_operations (
    operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL)`,
  `CREATE TABLE notification_inbox_reservations (
    reservation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, pool TEXT NOT NULL CHECK(pool IN('ingress','variant','completion')),
    bytes INTEGER NOT NULL CHECK(bytes>0))`,
  `CREATE TABLE notification_inbox_disposals (
    operation_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, disposed_at INTEGER NOT NULL, policy_revision TEXT NOT NULL)`,
  ...['receipts', 'transitions', 'operations', 'disposals', 'variants'].map(table =>
    `CREATE TRIGGER notification_inbox_immutable_${table} BEFORE UPDATE ON notification_inbox_${table}
      BEGIN SELECT RAISE(ABORT,'immutable_inbox_evidence'); END`),
];

// Deliberately unregistered: no migration history, runtime adoption or populated conversion.
export const notificationInboxSql = definitions.join(';\n') + ';';
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
export function assertNotificationInboxSchema(db: Sqlite): void {
  const actual = db.prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'notification_inbox_%' AND sql IS NOT NULL ORDER BY name")
    .all() as { sql: string }[];
  const expected = definitions.map(normalized).sort();
  if (JSON.stringify(actual.map(row => normalized(row.sql)).sort()) !== JSON.stringify(expected)) {
    throw new Error('notification_inbox_schema_unavailable');
  }
}
export function validateInboxPolicy(policy: InboxPolicy): void {
  const fields = ['maxEnvelopeBytes','maxPayloadBytes','maxNestedBytes','maxReceipts','maxVariants',
    'maxVerificationClaims','maxAttempts','maxTransitions','maxOperationBytes','maxPageSize',
    'ingressBytes','variantBytes','completionBytes','recordOverheadBytes'] as const;
  if (!policy || typeof policy.revision !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(policy.revision) ||
      fields.some(key => !Number.isSafeInteger(policy[key]) || policy[key] <= 0) ||
      !policy.retention || Object.values(policy.retention).length !== 3 ||
      ['payloadMs','tombstoneMs','auditMs'].some(key => !Number.isSafeInteger(policy.retention[key as keyof typeof policy.retention]) ||
        policy.retention[key as keyof typeof policy.retention] <= 0) ||
      policy.maxPayloadBytes > 240000 || policy.maxNestedBytes > 60000 ||
      policy.maxPayloadBytes > policy.maxEnvelopeBytes || policy.maxOperationBytes < policy.maxPayloadBytes * 2 + 2048 ||
      policy.maxTransitions < 8 || policy.recordOverheadBytes < 4096 ||
      policy.retention.tombstoneMs < policy.retention.payloadMs || policy.retention.auditMs < policy.retention.tombstoneMs ||
      !Number.isSafeInteger(2 * policy.maxTransitions * (policy.maxOperationBytes + policy.recordOverheadBytes * 16))) {
    throw new Error('notification_inbox_policy_required');
  }
}
export function initializeSyntheticNotificationInbox(db: Sqlite, input: Readonly<{
  use: 'isolated-synthetic'; storeId: string; generation: string; ingress: string; policy: InboxPolicy;
}>): void {
  validateInboxPolicy(input.policy);
  if (input.use !== 'isolated-synthetic' || db.inTransaction ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.ingress) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.storeId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.generation) ||
      (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()).length !== 0) {
    throw new Error('isolated_fresh_inbox_required');
  }
  db.transaction(() => {
    db.exec(notificationInboxSql);
    db.prepare('INSERT INTO notification_inbox_store VALUES(1,?,?,?,?,0,?)')
      .run(input.storeId, input.generation, JSON.stringify(input.policy), input.ingress, input.use);
    assertNotificationInboxSchema(db);
  }).immediate();
}
