import type { CoachingSessionController } from './session-controller.js';

export type CoachingInvalidationReason = 'logout' | 'account_changed' | 'account_disabled' | 'session_expired';

export function createCoachingLifecycleHooks(session: CoachingSessionController): Readonly<{
  invalidate(reason: CoachingInvalidationReason): void;
}> {
  return Object.freeze({
    invalidate(reason: CoachingInvalidationReason): void { session.stop(reason); },
  });
}
