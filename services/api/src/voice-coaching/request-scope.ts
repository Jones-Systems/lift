import type { AccountContext, LifecycleBindings } from '../lifecycle/types.js';
import type { CoachingRequestScope } from './contracts.js';

export function createCoachingRequestScope(
  actor: AccountContext,
  lifecycle: Pick<LifecycleBindings, 'assertActive'>,
  signal: AbortSignal,
): CoachingRequestScope {
  const original = Object.freeze({
    accountId: actor.accountId,
    authUserId: actor.authUserId,
    sessionId: actor.sessionId,
    epoch: actor.epoch,
  });
  const scope: CoachingRequestScope = Object.freeze({
    actor: original,
    signal,
    assertCurrent(): void {
      signal.throwIfAborted();
      lifecycle.assertActive(original);
      signal.throwIfAborted();
    },
  });
  scope.assertCurrent();
  return scope;
}
