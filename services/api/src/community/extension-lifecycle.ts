import { DomainError } from '../errors.js';
import type { LifecycleAdapter, LifecycleResult } from '../lifecycle/types.js';
import type { CommunityExtensionService } from './extension-service.js';
export function createCommunityExtensionLifecycleAdapter(service: CommunityExtensionService, options: { purgeQualified?: boolean } = {}): LifecycleAdapter {
 const result = (effect: () => number): LifecycleResult => { try { return { status: 'complete', count: effect() }; } catch (error) {
  if (error instanceof DomainError && error.status === 413) throw error;
  if (error instanceof DomainError && error.code === 'community_lifecycle_serialization_required') return { status: 'unavailable', reason: 'writer_serialization_required' };
  return { status: 'unknown', reason: 'community_b4_effect_or_readback_unproved' };
 } };
 return { category: 'community',
  inventory: actor => ({ category: 'community', ...result(() => Object.values(service.inventoryAccount(actor)).reduce((a, b) => a + b, 0)) }),
  export: (actor, snapshot) => ({ category: 'community', ...result(() => service.exportAccount(actor, snapshot.append)) }),
  suppress: (accountId, epoch) => result(() => { service.suppressAccount(accountId, epoch); if (!service.verifySuppressed(accountId, epoch)) throw new DomainError(503, 'community_suppression_readback_failed'); return 1; }),
  verifySuppressed: (accountId, epoch) => { try { return service.verifySuppressed(accountId, epoch) ? { status: 'complete' } : { status: 'pending', reason: 'community_b4_access_rows_remain' }; } catch { return { status: 'unknown', reason: 'community_b4_suppression_unproved' }; } },
  purge: (_requestId, accountId) => options.purgeQualified ? result(() => service.purgeAccount(accountId)) : { status: 'pending', reason: 'community_b4_retention_order_and_purge_qualification_required' },
 };
}
