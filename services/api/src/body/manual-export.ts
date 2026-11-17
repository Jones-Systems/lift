import { DomainError } from '../errors.js';
import type { Sqlite } from '../storage.js';
import type { AccountContext, LifecycleBindings } from '../lifecycle/types.js';
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
const RECEIPT_JSON_MAX_CHARS = 512;

export type ManualRetentionExportDecision = Readonly<ManualRetentionCurrent & { createdAt: string; updatedAt: string }>;
export type ManualRetentionExportReceipt = Readonly<ManualRetentionReceipt & { createdAt: string }>;
export type ManualRetentionExportAttribution = Readonly<{ measurementId: string; decisionId: string; decisionRevision: 1; createdAt: string }>;
export type ManualRetentionExportOperation = Readonly<{ measurementId: string; operation: 'create' | 'delete' }>;
export type ManualRetentionExportSection = Readonly<
  | { schema: typeof MANUAL_RETENTION_EXPORT_SCHEMA; retention: 'not_installed' }
  | { schema: typeof MANUAL_RETENTION_EXPORT_SCHEMA; retention: 'installed'; statement: ManualRetentionStatementBinding;
      decisions: readonly ManualRetentionExportDecision[]; receipts: readonly ManualRetentionExportReceipt[];
      attributions: readonly ManualRetentionExportAttribution[]; operations: readonly ManualRetentionExportOperation[] }>;

type DecisionRow = { account_id: string; decision_id: string; auth_user_id: string; state: string; revision: number;
  statement_sha256: string | null; grant_key: string | null; created_at: string; updated_at: string };
type ReceiptRow = { account_id: string; key: string; intent_hash: string; decision_id: string; receipt: string; created_at: string };
type AttributionRow = { account_id: string; measurement_key: string; measurement_id: string; decision_id: string;
  decision_revision: number; statement_sha256: string; created_at: string; owner_account_id: string | null };
type OperationRow = { account_id: string; key: string; intent_hash: string; measurement_id: string; operation: string;
  owner_account_id: string | null };

const invalid = (): never => { throw new DomainError(503, 'body_manual_export_invalid_data'); };
const mismatch = (): never => { throw new DomainError(503, 'body_manual_export_scope_mismatch'); };
const oversized = (): never => { throw new DomainError(413, 'account_export_packaging_required'); };
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
 * Builds the owner-only retained Body retention metadata section. Everything is read and validated before the
 * caller appends a single byte, so a malformed, partial, oversized or cross-account row fails the whole export.
 */
export function createManualRetentionExport(db: Sqlite, lifecycle: LifecycleBindings) {
  const read = (actor: AccountContext): ManualRetentionExportSection => lifecycle.withActiveWrite(actor, () => {
    const installed = manualRetentionOwnedTables.map(table => present(db, table));
    if (installed.every(value => !value)) return Object.freeze({ schema: MANUAL_RETENTION_EXPORT_SCHEMA, retention: 'not_installed' as const });
    if (!installed.every(Boolean) || !present(db, 'body_manual_receipts') || !present(db, 'body_manual_measurements'))
      throw new DomainError(503, 'body_manual_retention_migration_required');
    const accountId = actor.accountId;
    const decisionRows = rows<DecisionRow>(db, `SELECT account_id,decision_id,auth_user_id,state,revision,statement_sha256,grant_key,created_at,updated_at
      FROM body_manual_retention_decisions WHERE account_id=? ORDER BY created_at,decision_id`, accountId);
    const receiptRows = rows<ReceiptRow>(db, `SELECT account_id,key,intent_hash,decision_id,receipt,created_at
      FROM body_manual_retention_receipts WHERE account_id=? ORDER BY created_at,rowid`, accountId);
    const operationRows = rows<OperationRow>(db, `SELECT r.account_id AS account_id,r.key AS key,r.intent_hash AS intent_hash,
      r.measurement_id AS measurement_id,r.operation AS operation,
      (SELECT m.account_id FROM body_manual_measurements m WHERE m.id=r.measurement_id) AS owner_account_id
      FROM body_manual_receipts r WHERE r.account_id=? ORDER BY r.rowid`, accountId);
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

    const operations: ManualRetentionExportOperation[] = [], operationByKey = new Map<string, OperationRow>(), deleted = new Set<string>();
    for (const row of operationRows) {
      if (row.account_id !== accountId || (row.owner_account_id !== null && row.owner_account_id !== accountId)) mismatch();
      if (!isKey(row.key) || operationByKey.has(row.key) || !SHA256.test(row.intent_hash) || !isManualRetentionDecisionId(row.measurement_id)
        || (row.operation !== 'create' && row.operation !== 'delete')) invalid();
      operationByKey.set(row.key, row);
      if (row.operation === 'delete') deleted.add(row.measurement_id);
      operations.push(Object.freeze({ measurementId: row.measurement_id, operation: row.operation as 'create' | 'delete' }));
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

    return Object.freeze({ schema: MANUAL_RETENTION_EXPORT_SCHEMA, retention: 'installed' as const,
      statement: MANUAL_RETENTION_STATEMENT_BINDING, decisions: Object.freeze([...decisions.values()]),
      receipts: Object.freeze(receipts), attributions: Object.freeze(attributions), operations: Object.freeze(operations) });
  });
  return { read };
}
export type ManualRetentionExport = ReturnType<typeof createManualRetentionExport>;
