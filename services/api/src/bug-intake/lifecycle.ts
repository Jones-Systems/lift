import { DomainError } from '../errors.js';
import type { LifecycleAdapter, LifecycleResult } from '../lifecycle/types.js';
import { bugIntakeOwnedTables, bugIntakePurgeOrder } from './migration.js';
import { bugIntakeLimits } from './schemas.js';
import { createBugIntakeService } from './service.js';
import type { BugIntakeDependencies } from './types.js';

const category = 'bugIntake';
const unavailable = (reason: string): LifecycleResult => ({ status: 'unavailable', reason });
export function createBugIntakeLifecycleAdapter(deps: BugIntakeDependencies): LifecycleAdapter {
  const { db, lifecycleControl } = deps;
  const count = (accountId: string) => bugIntakeOwnedTables.reduce((sum, table) => sum +
    (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId) as { n: number }).n, 0);
  const externalEffect = (accountId: string) => !!db.prepare("SELECT 1 FROM bug_intake_reports WHERE account_id=? AND state IN ('dispatch_unknown','dispatched') LIMIT 1").get(accountId);
  const verify = (accountId: string, epoch: number): LifecycleResult => {
    if (!Number.isSafeInteger(epoch) || epoch < 0) return unavailable('invalid_suppression_epoch');
    if (!lifecycleControl) return unavailable('canonical_suppression_binding_required');
    try { lifecycleControl.assertSuppression(accountId, epoch); }
    catch { return { status: 'unknown', reason: 'canonical_suppression_unproved' }; }
    // Purge removes the local marker; canonical suppression still guards an empty module.
    if (count(accountId) === 0) return { status: 'complete' };
    const row = db.prepare('SELECT epoch FROM bug_intake_suppression WHERE account_id=?').get(accountId) as { epoch: number } | undefined;
    if (!row || row.epoch < epoch) return { status: 'pending', reason: 'bug_intake_suppression_required' };
    if (externalEffect(accountId)) return { status: 'unknown', reason: 'bug_dispatch_external_effect_requires_reconciliation' };
    return { status: 'complete' };
  };
  return {
    category,
    inventory(context) {
      const service = createBugIntakeService(deps, context);
      service.assertActive();
      const result = { status: 'complete' as const, category, count: count(context.accountId) };
      service.assertActive(); return result;
    },
    export(context, snapshot) {
      const service = createBugIntakeService(deps, context);
      service.assertActive();
      if (!snapshot?.append || !Number.isFinite(snapshot.snapshotAtMs)) return { ...unavailable('bounded_export_snapshot_required'), category };
      const bounds = db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes,coalesce(max(length(CAST(data AS BLOB))),0) AS largest FROM bug_intake_reports WHERE account_id=?')
        .get(context.accountId) as { n: number; bytes: number; largest: number };
      if (bounds.n > bugIntakeLimits.reportsPerAccount || bounds.bytes > bugIntakeLimits.reportBytes * bugIntakeLimits.reportsPerAccount || bounds.largest > bugIntakeLimits.reportBytes)
        throw new DomainError(413, 'account_export_packaging_required');
      let after: string | undefined, exported = 0;
      for (;;) {
        const page = service.list({ limit: bugIntakeLimits.listPage, ...(after ? { after } : {}) });
        if (!page.length) break;
        for (const report of page) {
          service.assertActive(); snapshot.append(category, report); service.assertActive(); exported++;
        }
        if (exported > bugIntakeLimits.reportsPerAccount) throw new DomainError(413, 'account_export_packaging_required');
        after = page[page.length - 1]!.id;
      }
      return { status: 'complete', category, count: exported, reason: 'owned_reports_only_no_keys_authority_or_dispatch_credentials' };
    },
    suppress(accountId, epoch) {
      if (!db.inTransaction) return unavailable('root_ledger_first_writer_transaction_required');
      if (!Number.isSafeInteger(epoch) || epoch < 0) return unavailable('invalid_suppression_epoch');
      if (!lifecycleControl) return unavailable('canonical_suppression_binding_required');
      try { lifecycleControl.assertSuppression(accountId, epoch); }
      catch { return { status: 'unknown', reason: 'canonical_suppression_unproved' }; }
      db.prepare('INSERT INTO bug_intake_suppression(account_id,epoch) VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET epoch=max(epoch,excluded.epoch)').run(accountId, epoch);
      return verify(accountId, epoch);
    },
    verifySuppressed: verify,
    purge(requestId, accountId) {
      if (!db.inTransaction) return unavailable('trusted_lifecycle_writer_transaction_required');
      if (!lifecycleControl) return unavailable('source_purge_not_qualified');
      const readiness = lifecycleControl.purgeReadiness(requestId, accountId);
      if (readiness.status !== 'ready') return readiness;
      const suppression = verify(accountId, readiness.epoch);
      if (suppression.status !== 'complete') return suppression;
      let deleted = 0;
      for (const table of bugIntakePurgeOrder) deleted += db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
      lifecycleControl.assertSuppression(accountId, readiness.epoch);
      if (count(accountId)) throw new Error('bug_intake_purge_readback_failed');
      return { status: 'complete', count: deleted, reason: 'bug_intake_source_only_canonical_disable_remains_root_owned' };
    },
  };
}
