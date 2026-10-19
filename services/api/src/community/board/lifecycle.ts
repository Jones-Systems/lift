import { DomainError } from '../../errors.js';
import type { LifecycleAdapter, LifecycleResult } from '../../lifecycle/types.js';
import type { FeatureBoardService } from './service.js';
export type FeatureBoardLifecycleOptions = Readonly<{ retentionAndAuditRedactionQualified?: boolean }>;
export function createFeatureBoardLifecycleAdapter(service: FeatureBoardService, options: FeatureBoardLifecycleOptions = {}): LifecycleAdapter {
  const result = (effect: () => number): LifecycleResult => {
    try { return { status: 'complete', count: effect() }; }
    catch (error) {
      if (error instanceof DomainError && error.status === 413) throw error;
      if (error instanceof DomainError && error.code === 'board_lifecycle_serialization_required') return { status: 'unavailable', reason: 'writer_serialization_required' };
      return { status: 'unknown', reason: 'board_effect_or_readback_unproved' };
    }
  };
  return {
    category: 'community',
    inventory: context => ({ category: 'community', ...result(() => Object.values(service.inventoryAccount(context)).reduce((a, b) => a + b, 0)) }),
    export: (context, snapshot) => ({ category: 'community', ...result(() => service.exportAccount(context, snapshot.append)) }),
    suppress: (accountId, epoch) => result(() => {
      service.suppressAccount(accountId, epoch);
      if (!service.verifySuppressed(accountId, epoch)) throw new DomainError(503, 'board_suppression_readback_failed'); return 1;
    }),
    purge: (requestId, accountId) => options.retentionAndAuditRedactionQualified === true
      ? result(() => Object.values(service.purgeAccount(requestId, accountId, { retentionAndAuditRedactionQualified: true })).reduce((a, b) => a + b, 0))
      : { status: 'pending', reason: 'board_retention_audit_redaction_order_unqualified' },
    verifySuppressed: (accountId, epoch) => {
      try { return service.verifySuppressed(accountId, epoch) ? { status: 'complete' } : { status: 'pending', reason: 'board_access_rows_remain' }; }
      catch { return { status: 'unknown', reason: 'board_suppression_readback_unproved' }; }
    },
  };
}
