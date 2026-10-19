import { DomainError } from '../errors.js';
import type { LifecycleAdapter, LifecycleResult } from '../lifecycle/types.js';
import type { CommunityService } from './service.js';

export type CommunityLifecycleOptions = Readonly<{ purgeQualified?: boolean }>;
export function createCommunityLifecycleAdapter(service: CommunityService, options: CommunityLifecycleOptions = {}): LifecycleAdapter {
  const result = (effect: () => number): LifecycleResult => {
    try { return { status: 'complete', count: effect() }; }
    catch (error) {
      if (error instanceof DomainError && error.code === 'community_lifecycle_serialization_required')
        return { status: 'unavailable', reason: 'writer_serialization_required' };
      if (error instanceof DomainError && error.status === 413) throw error;
      return { status: 'unknown', reason: 'community_readback_or_effect_unproved' };
    }
  };
  return {
    category: 'community',
    inventory: context => ({ category: 'community', ...result(() => Object.values(service.inventoryAccount(context)).reduce((a, b) => a + b, 0)) }),
    export: (context, snapshot) => ({ category: 'community', ...result(() => service.exportAccount(context, snapshot.append)) }),
    suppress: (accountId, epoch) => result(() => {
      service.suppressAccountCommunity(accountId, epoch);
      if (!service.verifySuppressed(accountId, epoch)) throw new DomainError(503, 'community_suppression_readback_failed');
      return 1;
    }),
    purge: (requestId, accountId) => options.purgeQualified === true
      ? result(() => Object.values(service.purgeAccountCommunity(requestId, accountId)).reduce((a, b) => a + b, 0))
      : { status: 'pending', reason: 'community_retention_order_and_purge_qualification_required' },
    verifySuppressed: (accountId, epoch) => {
      try { return service.verifySuppressed(accountId, epoch) ? { status: 'complete' } : { status: 'pending', reason: 'community_access_rows_remain' }; }
      catch { return { status: 'unknown', reason: 'community_suppression_readback_unproved' }; }
    },
  };
}
