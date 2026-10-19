import { DomainError } from '../errors.js';
import type { LifecycleAdapter, LifecycleResult } from '../lifecycle/types.js';
import { progressComparisonOwnedTables, progressComparisonPurgeOrder } from './migration.js';
import { createProgressComparisonService } from './service.js';
import type { ProgressComparisonDependencies, SourceSelection } from './persistence-types.js';

const category = 'progressComparison';
const unavailable = (reason: string): LifecycleResult => ({ status: 'unavailable', reason });
export function createProgressComparisonLifecycleAdapter(deps: ProgressComparisonDependencies): LifecycleAdapter {
  const { db, lifecycleControl } = deps, service = createProgressComparisonService(deps);
  const count = (accountId: string) => progressComparisonOwnedTables.reduce((total, table) => total +
    (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId) as { n: number }).n, 0);
  const receipts = (accountId: string) => (db.prepare("SELECT count(*) AS n FROM command_receipts WHERE account_id=? AND operation IN ('progressComparison.confirm','progressComparison.withdraw')")
    .get(accountId) as { n: number }).n;
  const verify = (accountId: string, epoch: number): LifecycleResult => {
    if (!Number.isSafeInteger(epoch) || epoch < 0) return unavailable('invalid_suppression_epoch');
    try { lifecycleControl.assertSuppression(accountId, epoch); }
    catch { return { status: 'unknown', reason: 'canonical_suppression_unproved' }; }
    return { status: 'complete', reason: 'canonical_guarded_synchronous_module_no_background_workers' };
  };
  return {
    category,
    inventory(context) { return service.read(context, () => ({ status: 'complete', category, count: count(context.accountId),
      reason: 'owned_identity_and_metadata_revisions_only_shared_receipts_backend_owned' })); },
    export(context, snapshot) {
      return service.read(context, () => {
        if (!snapshot?.append || !Number.isFinite(snapshot.snapshotAtMs)) return { ...unavailable('bounded_export_snapshot_required'), category };
        const bounds = db.prepare('SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes,coalesce(max(length(CAST(data AS BLOB))),0) AS largest FROM progress_comparison_identities WHERE account_id=?')
          .get(context.accountId) as { bytes: number; largest: number };
        if (bounds.largest > 32768 || bounds.bytes + count(context.accountId) * 1024 > 4 * 1024 * 1024)
          throw new DomainError(413, 'account_export_packaging_required');
        let exported = 0;
        const append = (kind: string, value: unknown) => {
          service.assertActive(context); snapshot.append(category, { kind, value }); service.assertActive(context); exported++;
        };
        for (const selection of db.prepare('SELECT source_kind AS kind,source_id AS id,item_id AS itemId FROM progress_comparison_identities WHERE account_id=? ORDER BY id')
          .iterate(context.accountId) as Iterable<SourceSelection>) append('identity', service.identity(context, selection));
        for (const row of db.prepare('SELECT identity_id AS identityId,revision,source_revision AS sourceRevision,action,recorded_at AS recordedAt FROM progress_comparison_identity_revisions WHERE account_id=? ORDER BY identity_id,revision')
          .iterate(context.accountId)) append('revisionMetadata', row);
        append('manifest', { sharedReceiptCount: receipts(context.accountId), omissions: ['shared_command_receipts', 'canonical_work_history', 'auth_sessions'],
          historyPolicy: 'metadata_only_no_previous_identity_payload', exportLimitBytes: 4 * 1024 * 1024 });
        return { status: 'complete', category, count: exported, reason: 'owned_structured_identity_only' };
      });
    },
    suppress(accountId, epoch) {
      if (!db.inTransaction) return unavailable('root_ledger_first_writer_transaction_required');
      return verify(accountId, epoch);
    },
    verifySuppressed: verify,
    purge(requestId, accountId) {
      if (!db.inTransaction) return unavailable('trusted_lifecycle_writer_transaction_required');
      const readiness = lifecycleControl.purgeReadiness(requestId, accountId);
      if (readiness.status !== 'ready') return readiness;
      if (verify(accountId, readiness.epoch).status !== 'complete') return { status: 'pending', reason: 'suppression_required_before_purge' };
      let deleted = 0;
      for (const table of progressComparisonPurgeOrder) deleted += db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
      deleted += db.prepare("DELETE FROM command_receipts WHERE account_id=? AND operation IN ('progressComparison.confirm','progressComparison.withdraw')").run(accountId).changes;
      if (count(accountId) !== 0 || receipts(accountId) !== 0 || verify(accountId, readiness.epoch).status !== 'complete') throw new Error('progress_purge_readback_failed');
      return { status: 'complete', count: deleted, reason: 'owned_rows_and_exact_receipt_namespaces_absent_no_whole_account_claim' };
    },
  };
}
