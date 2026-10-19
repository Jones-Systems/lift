import type { LifecycleAdapter, LifecycleResult } from '../lifecycle/types.js';
import type { FamilyMembershipService } from './service.js';

export function createFamilyMembershipLifecycleAdapter(service: FamilyMembershipService): LifecycleAdapter {
  const effect = (run: () => number): LifecycleResult => {
    try { return { status: 'complete', count: run() }; }
    catch { return { status: 'unknown', reason: 'family_lifecycle_unproved' }; }
  };
  return {
    category: 'family-membership',
    inventory: actor => ({ category: 'family-membership', ...effect(() => {
      const data = service.exportAccount(actor);
      return Number(!!data.membership) + data.invitations.length + data.receipts.length;
    }) }),
    export: (actor, snapshot) => ({ category: 'family-membership', ...effect(() => {
      snapshot.append('family-membership', service.exportAccount(actor)); return 1;
    }) }),
    suppress: (accountId, epoch) => effect(() => {
      service.suppressAccount(accountId, epoch);
      if (!service.verifySuppressed(accountId)) throw new Error('family_suppression_unproved');
      return 1;
    }),
    purge: (_requestId, accountId) => effect(() => service.purgeAccount(accountId)),
    verifySuppressed: accountId => {
      try { return service.verifySuppressed(accountId) ? { status: 'complete' } : { status: 'pending', reason: 'family_access_remains' }; }
      catch { return { status: 'unknown', reason: 'family_suppression_unproved' }; }
    },
  };
}
