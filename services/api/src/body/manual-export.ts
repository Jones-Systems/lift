import { DomainError } from '../errors.js';
import type { Sqlite } from '../storage.js';
import type { AccountContext, LifecycleBindings } from '../lifecycle/types.js';
import type { ManualMeasurement } from './measurements.js';
import { manualRetentionOwnedTables } from './manual-retention-migration.js';
import {
  MANUAL_RETENTION_STATEMENT, MANUAL_RETENTION_STATEMENT_BINDING, MANUAL_RETENTION_STATEMENT_SHA256,
  captureManualRetentionCurrent, captureManualRetentionReceipt, isManualRetentionDecisionId,
  type ManualRetentionCurrent, type ManualRetentionReceipt, type ManualRetentionStatementBinding,
} from './manual-retention-contract.js';

export const MANUAL_RETENTION_EXPORT_SCHEMA = 'form.body-manual-retention-export/v1' as const;
// Each relation is read with LIMIT cap+1 so an oversized account is refused before any row is projected.
// The enclosing account export still enforces its own aggregate 16 MiB bound on the serialized result.
export const MANUAL_RETENTION_EXPORT_ROW_CAP = 50_000;
// Matches the create-time per-account cap. Export counts first and refuses above it instead of truncating.
export const BODY_EXPORT_MEASUREMENT_CAP = 10_000;
const RECEIPT_JSON_MAX_CHARS = 512;

export type ManualRetentionExportDecision = Readonly<ManualRetentionCurrent & { createdAt: string; updatedAt: string }>;
export type ManualRetentionExportReceipt = Readonly<ManualRetentionReceipt & { createdAt: string }>;
export type ManualRetentionExportAttribution = Readonly<{ measurementId: string; decisionId: string; decisionRevision: 1; createdAt: string }>;
export type ManualRetentionExportOperation = Readonly<{ measurementId: string; operation: 'create' | 'delete' }>;
// Stored per-measurement metadata that the unchanged first `{ measurements }` envelope does not carry.
export type ManualMeasurementExportMetadata = Readonly<{ measurementId: string; createdAt: string }>;
type ManualExportHistory = { measurementMetadata: readonly ManualMeasurementExportMetadata[];
  operations: readonly ManualRetentionExportOperation[] };
export type ManualRetentionExportSection = Readonly<
  | ({ schema: typeof MANUAL_RETENTION_EXPORT_SCHEMA; retention: 'not_installed' } & ManualExportHistory)
  | ({ schema: typeof MANUAL_RETENTION_EXPORT_SCHEMA; retention: 'installed'; statement: ManualRetentionStatementBinding;
      decisions: readonly ManualRetentionExportDecision[]; receipts: readonly ManualRetentionExportReceipt[];
      attributions: readonly ManualRetentionExportAttribution[] } & ManualExportHistory)>;
export type ManualBodyExport = Readonly<{ measurements: readonly ManualMeasurement[]; retained: ManualRetentionExportSection }>;

type DecisionRow = { account_id: string; decision_id: string; auth_user_id: string; state: string; revision: number;
  statement_sha256: string | null; grant_key: string | null; created_at: string; updated_at: string };
type ReceiptRow = { account_id: string; key: string; intent_hash: string; decision_id: string; receipt: string; created_at: string };
type AttributionRow = { account_id: string; measurement_key: string; measurement_id: string; decision_id: string;
  decision_revision: number; statement_sha256: string; created_at: string; owner_account_id: string | null };
type OperationRow = { account_id: string; key: string; intent_hash: string; measurement_id: string; operation: string;
  owner_account_id: string | null };
type MeasurementRow = ManualMeasurement & { createdAt: unknown };

const invalid = (): never => { throw new DomainError(503, 'body_manual_export_invalid_data'); };
const mismatch = (): never => { throw new DomainError(503, 'body_manual_export_scope_mismatch'); };
const oversized = (): never => { throw new DomainError(413, 'account_export_packaging_required'); };
const incomplete = (): never => { throw new DomainError(503, 'body_manual_export_schema_incomplete'); };
const BASE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  body_manual_measurements: ['id', 'account_id', 'kind', 'value', 'unit', 'original_unit', 'measured_on', 'note', 'created_at'],
  body_manual_receipts: ['account_id', 'key', 'intent_hash', 'measurement_id', 'operation'],
});
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const isKey = (value: unknown): value is string => typeof value === 'string' && KEY.test(value);
const isInstant = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 40) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};
const present = (db: Sqlite, table: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
// Owner and retention relations are selected by account_id only; key, hash, session and epoch columns are never projected out of this module.
function rows<T>(db: Sqlite, sql: string, accountId: string): T[] {
  const result = db.prepare(`${sql} LIMIT ?`).all(accountId, MANUAL_RETENTION_EXPORT_ROW_CAP + 1) as T[];
  if (result.length > MANUAL_RETENTION_EXPORT_ROW_CAP) oversized();
  return result;
}

/**
 * Reads the unchanged `{ measurements }` payload and builds the owner-only retained Body metadata section: stored
 * measurement created_at, timestamp-free create/delete history and, when installed, retention decisions, receipts and
 * attributions. Everything is read and validated before the caller appends a single byte, so a malformed, partial,
 * over-capacity or cross-account row fails the whole export.
 */
export function createManualRetentionExport(db: Sqlite, lifecycle: LifecycleBindings) {
  const read = (actor: AccountContext): ManualBodyExport => lifecycle.withActiveWrite(actor, () => {
    for (const [table, required] of Object.entries(BASE_COLUMNS)) {
      if (!present(db, table)) incomplete();
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name));
      if (!required.every(column => columns.has(column))) incomplete();
    }
    const installed = manualRetentionOwnedTables.map(table => present(db, table));
    if (!installed.every(Boolean) && installed.some(Boolean)) throw new DomainError(503, 'body_manual_retention_migration_required');
    const accountId = actor.accountId;

    // Count before reading so an over-cap account is refused rather than silently truncated.
    const total = (db.prepare('SELECT count(*) n FROM body_manual_measurements WHERE account_id=?').get(accountId) as { n: number }).n;
    if (!Number.isSafeInteger(total) || total > BODY_EXPORT_MEASUREMENT_CAP) throw new DomainError(413, 'body_export_capacity_exceeded');
    // Same projection and order as the public list route, plus the stored created_at for the retained section.
    const measurementRows = db.prepare(`SELECT id,kind,value,unit,original_unit AS originalUnit,measured_on AS measuredOn,note,
      'manual_reported' AS provenance,created_at AS createdAt FROM body_manual_measurements WHERE account_id=?
      ORDER BY measured_on,id LIMIT ?`).all(accountId, BODY_EXPORT_MEASUREMENT_CAP + 1) as MeasurementRow[];
    if (measurementRows.length !== total) throw new DomainError(413, 'body_export_capacity_exceeded');
    const measurements: ManualMeasurement[] = [], measurementMetadata: ManualMeasurementExportMetadata[] = [];
    for (const row of measurementRows) {
      if (!isManualRetentionDecisionId(row.id) || typeof row.measuredOn !== 'string' || !CIVIL_DATE.test(row.measuredOn)
        || !isInstant(row.createdAt)) invalid();
      const { createdAt, ...measurement } = row;
      measurements.push(measurement);
      measurementMetadata.push(Object.freeze({ measurementId: row.id, createdAt: createdAt as string }));
    }

    const operationRows = rows<OperationRow>(db, `SELECT r.account_id AS account_id,r.key AS key,r.intent_hash AS intent_hash,
      r.measurement_id AS measurement_id,r.operation AS operation,
      (SELECT m.account_id FROM body_manual_measurements m WHERE m.id=r.measurement_id) AS owner_account_id
      FROM body_manual_receipts r WHERE r.account_id=? ORDER BY r.rowid`, accountId);
    const operations: ManualRetentionExportOperation[] = [], operationByKey = new Map<string, OperationRow>(), deleted = new Set<string>();
    for (const row of operationRows) {
      if (row.account_id !== accountId || (row.owner_account_id !== null && row.owner_account_id !== accountId)) mismatch();
      if (!isKey(row.key) || operationByKey.has(row.key) || typeof row.intent_hash !== 'string' || !SHA256.test(row.intent_hash)
        || !isManualRetentionDecisionId(row.measurement_id) || (row.operation !== 'create' && row.operation !== 'delete')) invalid();
      operationByKey.set(row.key, row);
      if (row.operation === 'delete') deleted.add(row.measurement_id);
      operations.push(Object.freeze({ measurementId: row.measurement_id, operation: row.operation as 'create' | 'delete' }));
    }
    const history = { measurementMetadata: Object.freeze(measurementMetadata), operations: Object.freeze(operations) };
    const result = (retained: ManualRetentionExportSection): ManualBodyExport =>
      Object.freeze({ measurements: Object.freeze(measurements), retained });
    if (!installed.some(Boolean))
      return result(Object.freeze({ schema: MANUAL_RETENTION_EXPORT_SCHEMA, retention: 'not_installed' as const, ...history }));

    const decisionRows = rows<DecisionRow>(db, `SELECT account_id,decision_id,auth_user_id,state,revision,statement_sha256,grant_key,created_at,updated_at
      FROM body_manual_retention_decisions WHERE account_id=? ORDER BY created_at,decision_id`, accountId);
    const receiptRows = rows<ReceiptRow>(db, `SELECT account_id,key,intent_hash,decision_id,receipt,created_at
      FROM body_manual_retention_receipts WHERE account_id=? ORDER BY created_at,rowid`, accountId);
    const attributionRows = rows<AttributionRow>(db, `SELECT a.account_id AS account_id,a.measurement_key AS measurement_key,
      a.measurement_id AS measurement_id,a.decision_id AS decision_id,a.decision_revision AS decision_revision,
      a.statement_sha256 AS statement_sha256,a.created_at AS created_at,
      (SELECT m.account_id FROM body_manual_measurements m WHERE m.id=a.measurement_id) AS owner_account_id
      FROM body_manual_retention_attributions a WHERE a.account_id=? ORDER BY a.created_at,a.rowid`, accountId);

    const decisions = new Map<string, ManualRetentionExportDecision>();
    for (const row of decisionRows) {
      if (row.account_id !== accountId || row.auth_user_id !== actor.authUserId) mismatch();
      if (!isManualRetentionDecisionId(row.decision_id) || decisions.has(row.decision_id) || !isInstant(row.created_at)
        || !isInstant(row.updated_at) || row.updated_at < row.created_at) invalid();
      const current = captureManualRetentionCurrent({ decisionId: row.decision_id, state: row.state, revision: row.revision,
        statement: row.statement_sha256 === null ? null : { id: MANUAL_RETENTION_STATEMENT.id, version: 1, sha256: row.statement_sha256 } });
      if (!current || (current.statement === null) !== (row.grant_key === null) || (row.grant_key !== null && !isKey(row.grant_key))) invalid();
      decisions.set(row.decision_id, Object.freeze({ ...current!, createdAt: row.created_at, updatedAt: row.updated_at }));
    }

    const receipts: ManualRetentionExportReceipt[] = [], receiptKeys = new Set<string>();
    for (const row of receiptRows) {
      if (row.account_id !== accountId) mismatch();
      const decision = decisions.get(row.decision_id);
      if (!decision || !isKey(row.key) || receiptKeys.has(row.key) || !SHA256.test(row.intent_hash) || !isInstant(row.created_at)
        || typeof row.receipt !== 'string' || row.receipt.length > RECEIPT_JSON_MAX_CHARS) invalid();
      let parsed: unknown;
      try { parsed = JSON.parse(row.receipt); } catch { invalid(); }
      const receipt = captureManualRetentionReceipt(parsed);
      if (!receipt || receipt.decisionId !== row.decision_id || receipt.decisionRevision > decision!.revision) invalid();
      receiptKeys.add(row.key);
      receipts.push(Object.freeze({ ...receipt!, createdAt: row.created_at }));
    }

    const attributions: ManualRetentionExportAttribution[] = [], attributedKeys = new Set<string>();
    for (const row of attributionRows) {
      if (row.account_id !== accountId || (row.owner_account_id !== null && row.owner_account_id !== accountId)) mismatch();
      const decision = decisions.get(row.decision_id), created = operationByKey.get(row.measurement_key);
      if (!decision || decision.statement === null || !isKey(row.measurement_key) || attributedKeys.has(row.measurement_key)
        || !isManualRetentionDecisionId(row.measurement_id) || row.decision_revision !== 1
        || row.statement_sha256 !== MANUAL_RETENTION_STATEMENT_SHA256 || !isInstant(row.created_at)
        || !created || created.operation !== 'create' || created.measurement_id !== row.measurement_id
        || (row.owner_account_id === null && !deleted.has(row.measurement_id))) invalid();
      attributedKeys.add(row.measurement_key);
      attributions.push(Object.freeze({ measurementId: row.measurement_id, decisionId: row.decision_id, decisionRevision: 1 as const, createdAt: row.created_at }));
    }

    return result(Object.freeze({ schema: MANUAL_RETENTION_EXPORT_SCHEMA, retention: 'installed' as const,
      statement: MANUAL_RETENTION_STATEMENT_BINDING, decisions: Object.freeze([...decisions.values()]),
      receipts: Object.freeze(receipts), attributions: Object.freeze(attributions), ...history }));
  });
  return { read };
}
export type ManualRetentionExport = ReturnType<typeof createManualRetentionExport>;
