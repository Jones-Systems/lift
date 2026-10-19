import { DomainError } from '../errors.js';
import type { LifecycleAdapter, LifecycleResult } from '../lifecycle/types.js';
import type { FeedbackLedgerEntry, FeedbackLifecycleDependencies, FeedbackMinimalReceipt } from './ledger-types.js';
import { feedbackOwnedTables, feedbackPurgeOrder } from './migration.js';

const category = 'trainingFeedback';
const unavailable = (reason: string): LifecycleResult => ({ status: 'unavailable', reason });

export function createFeedbackLifecycleAdapter(deps: FeedbackLifecycleDependencies): LifecycleAdapter {
  const { db, lifecycle, control } = deps;
  const count = (accountId: string) => feedbackOwnedTables.reduce((total, table) => total +
    (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId) as { n: number }).n, 0);
  const verify = (accountId: string, epoch: number): LifecycleResult => {
    if (!control || !Number.isSafeInteger(epoch) || epoch < 0) return unavailable('canonical_suppression_binding_required');
    try { control.assertSuppression(accountId, epoch); }
    catch { return { status: 'unknown', reason: 'canonical_suppression_unproved' }; }
    return { status: 'complete', reason: 'canonical_suppression_confirmed_no_async_feedback_workers' };
  };
  return {
    category,
    inventory(context) {
      lifecycle.assertActive(context);
      const result = { status: 'complete' as const, category, count: count(context.accountId) };
      lifecycle.assertActive(context); return result;
    },
    export(context, snapshot) {
      lifecycle.assertActive(context);
      if (!db.inTransaction) return { ...unavailable('canonical_export_snapshot_required'), category };
      if (!snapshot || !Number.isFinite(snapshot.snapshotAtMs) || typeof snapshot.append !== 'function')
        return { ...unavailable('bounded_export_snapshot_required'), category };
      let exported = 0;
      const append = (value: unknown) => {
        lifecycle.assertActive(context); snapshot.append(category, value); lifecycle.assertActive(context); exported++;
      };
      // Export retained source history, never stale derived caches, idempotency keys or intent digests.
      for (const row of db.prepare('SELECT data FROM feedback_events WHERE account_id=? ORDER BY sequence').iterate(context.accountId) as Iterable<{ data: string }>) {
        const entry = JSON.parse(row.data) as FeedbackLedgerEntry;
        append({ kind: 'event', sequence: entry.sequence, event: entry.event,
          sourceBefore: entry.beforeBinding, sourceAfter: entry.afterBinding });
      }
      for (const row of db.prepare('SELECT data FROM feedback_receipts WHERE account_id=? ORDER BY event_id').iterate(context.accountId) as Iterable<{ data: string }>)
        append({ kind: 'receipt', receipt: JSON.parse(row.data) as FeedbackMinimalReceipt });
      lifecycle.assertActive(context);
      return { status: 'complete', category, count: exported, reason: 'retained_feedback_source_and_minimal_receipts_only' };
    },
    suppress(accountId, epoch) {
      if (!db.inTransaction) return unavailable('canonical_lifecycle_transaction_required');
      return verify(accountId, epoch);
    },
    verifySuppressed: verify,
    purge(requestId, accountId) {
      if (!db.inTransaction) return unavailable('canonical_lifecycle_transaction_required');
      if (!control) return unavailable('canonical_purge_binding_required');
      const readiness = control.purgeReadiness(requestId, accountId);
      if (readiness.status !== 'ready') return readiness;
      const suppression = verify(accountId, readiness.epoch);
      if (suppression.status !== 'complete') return suppression;
      let removed = 0;
      for (const table of feedbackPurgeOrder) removed += db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
      control.assertSuppression(accountId, readiness.epoch);
      if (count(accountId)) throw new DomainError(503, 'feedback_purge_readback_failed');
      return { status: 'complete', count: removed, reason: 'owned_feedback_only_canonical_disable_remains_root_owned' };
    },
  };
}
