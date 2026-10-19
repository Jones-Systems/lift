import { DomainError } from '../../errors.js';
import type { AccountContext, LifecycleBindings } from '../../lifecycle/types.js';
import type { ActivityOperation } from '../types.js';

export type OwnerActivityRequest = Readonly<{ context: AccountContext; release(): void }>;
export type OwnerActivityRequestChannel = Readonly<{
  openOwnerRequest(context: AccountContext): OwnerActivityRequest;
  assertPersistable(context: AccountContext, operation: ActivityOperation, validatedIntent: unknown): void;
}>;
const operations: ReadonlySet<string> = new Set([
  'calendar.create', 'exercise.create', 'exercise.patch', 'exercise.retire', 'plan.create', 'plan.patch',
  'plan.archive', 'plan.importLegacy', 'schedule.write', 'day.correct', 'entry.create', 'entry.patch', 'entry.void',
]);

// Root owns the issuer. Identity establishes this in-process channel, never semantic lineage of HTTP values.
export function createOwnerActivityRequestChannel(input: Readonly<{
  lifecycle: LifecycleBindings;
  assertAuthority(): void;
}>): OwnerActivityRequestChannel {
  const leases = new WeakMap<AccountContext, { channel: 'owner-activity-input-v1'; active: boolean }>();
  const assertCanonical = (context: AccountContext): void => {
    input.assertAuthority();
    input.lifecycle.assertActive(context);
  };
  return Object.freeze({
    openOwnerRequest(context: AccountContext): OwnerActivityRequest {
      assertCanonical(context);
      const canonical: AccountContext = Object.freeze({ accountId: context.accountId, authUserId: context.authUserId,
        sessionId: context.sessionId, epoch: context.epoch });
      assertCanonical(canonical);
      leases.set(canonical, { channel: 'owner-activity-input-v1', active: true });
      return Object.freeze({ context: canonical, release(): void {
        const lease = leases.get(canonical);
        if (lease) lease.active = false;
        leases.delete(canonical);
      } });
    },
    assertPersistable(context: AccountContext, operation: ActivityOperation, _validatedIntent: unknown): void {
      const lease = leases.get(context);
      if (!lease?.active || lease.channel !== 'owner-activity-input-v1' || !operations.has(operation))
        throw new DomainError(403, 'activity_owner_channel_required');
      assertCanonical(context);
    },
  });
}
