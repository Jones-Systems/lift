import { DomainError } from '../errors.js';
import type { Sqlite } from '../storage.js';
import { suppressionAuthority } from './guards.js';
import type { AccountLifecycle } from './service.js';
import type { DisableRecord, SuppressionLedger } from './types.js';

declare const authorityBrand: unique symbol;
export type LocalPurgeAuthority = Readonly<{ [authorityBrand]: true }>;
const qualifiedCategories = Object.freeze(['usage_limits', 'bugIntake', 'activity', 'trainingFeedback', 'progressComparison', 'body']);
export type LocalPurgeFrame = Readonly<{
  db: Sqlite; requestId: string; accountId: string; authUserId: string; epoch: number; sequence: number;
  operationId: string; qualifiedCategories: readonly string[]; ledger: SuppressionLedger;
}>;
const owners = new WeakMap<AccountLifecycle, Sqlite>();
const issued = new WeakMap<LocalPurgeAuthority, LocalPurgeFrame>();
const live = new WeakMap<Sqlite, { frame: LocalPurgeFrame; category?: string }>();

// Internal composition binding; neither request input nor serialized data can create authority.
export function bindLocalPurgeExecutor(owner: AccountLifecycle, db: Sqlite): void {
  if (owners.has(owner)) throw new DomainError(503, 'purge_executor_already_bound');
  owners.set(owner, db);
}
function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function') throw new DomainError(503, 'purge_requires_synchronous_effect');
  return value;
}
function inspect(db: Sqlite, requestId: string, operationId: string): LocalPurgeFrame {
  if (!db.open || !db.inTransaction) throw new DomainError(503, 'purge_transaction_required');
  const ledger = suppressionAuthority(db);
  const row = db.prepare('SELECT id,account_id,phase FROM account_deletion_requests WHERE id=?').get(requestId) as
    { id: string; account_id: string; phase: string } | undefined;
  if (!row) {
    let restoredIntentMissing = false;
    try { ledger.reconcileRestore(record => { if (record.requestId === requestId) restoredIntentMissing = true; }); }
    catch { throw new DomainError(503, 'suppression_authority_unavailable'); }
    if (restoredIntentMissing) throw new DomainError(409, 'deletion_request_absent_restore_held');
    throw new DomainError(404, 'not_found');
  }
  let record: DisableRecord | null;
  try { record = ledger.lookup(row.account_id); } catch { throw new DomainError(503, 'suppression_authority_unavailable'); }
  if (!record || !['disabled_pending_purge', 'pending_external'].includes(row.phase)) throw new DomainError(409, 'suppression_required');
  if (record.requestId !== row.id || record.accountId !== row.account_id) throw new DomainError(409, 'deletion_request_mismatch');
  const account = db.prepare('SELECT auth_user_id FROM form_accounts WHERE id=?').get(row.account_id) as { auth_user_id: string } | undefined;
  const state = db.prepare('SELECT state,epoch,suppression_seq FROM account_lifecycle WHERE account_id=?').get(row.account_id) as
    { state: string; epoch: number; suppression_seq: number } | undefined;
  let currentSequence: number;
  try { currentSequence = ledger.currentSequence(); } catch { throw new DomainError(503, 'suppression_authority_unavailable'); }
  if (account?.auth_user_id !== record.authUserId || state?.state !== 'disabled' || state.epoch !== record.epoch ||
      state.suppression_seq !== record.sequence || !Number.isSafeInteger(record.epoch) || record.epoch < 1 ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 1 || !Number.isSafeInteger(currentSequence) || currentSequence < record.sequence)
    throw new DomainError(409, 'suppression_required');
  return Object.freeze({ db, requestId, accountId: row.account_id, authUserId: record.authUserId, epoch: record.epoch,
    sequence: record.sequence, operationId, qualifiedCategories, ledger });
}
function recheck(frame: LocalPurgeFrame): void {
  const current = inspect(frame.db, frame.requestId, frame.operationId);
  if (current.ledger !== frame.ledger || current.accountId !== frame.accountId || current.authUserId !== frame.authUserId ||
      current.epoch !== frame.epoch || current.sequence !== frame.sequence) throw new DomainError(409, 'purge_authority_stale');
}
export function issueLocalPurgeAuthority(owner: AccountLifecycle, input: Readonly<{ requestId: string; operationId: string }>): LocalPurgeAuthority {
  const db = owners.get(owner);
  if (!db) throw new DomainError(503, 'purge_executor_unbound');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.operationId)) throw new DomainError(400, 'purge_operation_id_invalid');
  // Own the immediate transaction; never mint from a caller's uncommitted state.
  if (db.inTransaction) throw new DomainError(503, 'purge_issuer_transaction_required');
  const frame = db.transaction(() => inspect(db, input.requestId, input.operationId)).immediate();
  const capability = Object.freeze(Object.defineProperty(Object.create(null), 'toJSON', {
    value: () => { throw new DomainError(409, 'purge_authority_not_serializable'); },
  })) as LocalPurgeAuthority;
  issued.set(capability, frame);
  return capability;
}
export function withLocalPurgeAuthority<T>(db: Sqlite, capability: LocalPurgeAuthority, effect: (frame: LocalPurgeFrame) => T): T {
  const frame = issued.get(capability);
  issued.delete(capability); // Every attempt consumes authority, including a foreign-db or failed attempt.
  if (!frame || frame.db !== db) throw new DomainError(409, 'purge_authority_invalid');
  if (db.inTransaction || live.has(db)) throw new DomainError(503, 'purge_executor_transaction_required');
  return db.transaction(() => {
    recheck(frame); live.set(db, { frame });
    try {
      const result = synchronous(effect(frame));
      recheck(frame);
      const foreignKeys = db.pragma('foreign_key_check');
      if (!Array.isArray(foreignKeys) || foreignKeys.length !== 0) throw new DomainError(503, 'local_purge_foreign_key_check_failed');
      return result;
    } finally { live.delete(db); }
  }).immediate();
}
export function currentLocalPurgeFrame(db: Sqlite): LocalPurgeFrame | undefined {
  const current = live.get(db);
  if (!current || !db.open || !db.inTransaction) return undefined;
  recheck(current.frame);
  return current.frame;
}
export function currentLocalPurgeCategory(db: Sqlite): string | undefined { return live.get(db)?.category; }
export function withLocalPurgeCategory<T>(db: Sqlite, category: string, effect: () => T): T {
  const frame = currentLocalPurgeFrame(db), current = live.get(db);
  if (!frame || !current || !frame.qualifiedCategories.includes(category) ||
      (current.category !== undefined && current.category !== category)) throw new DomainError(503, 'purge_category_unqualified');
  const previous = current.category;
  current.category = category;
  try { const result = synchronous(effect()); recheck(frame); return result; }
  finally { if (previous === undefined) delete current.category; else current.category = previous; }
}
