import { ApiError, type AuthAttemptGuard, type FormTransport } from '../api/transport';
import type { IdentityPorts, PhoneAuthPort } from '../features/contract';

/** Root lifecycle fence; construction is inert and phone secrets exist only after an explicit action. */
export function createAuthSession(api: FormTransport, identity: IdentityPorts = {}) {
  let active = false, epoch = 0;
  let attempt: (PhoneAuthPort & { dispose?: () => void }) | null = null;
  const guard = (): AuthAttemptGuard => {
    const generation = epoch;
    return { isCurrent: () => active && generation === epoch };
  };
  const changed = (unknown = false) => new ApiError(409, 'session_changed',
    'This sign-in attempt ended. Reconcile any uncertain result before trying again.', false, unknown);
  const invalidate = () => {
    epoch++;
    const previous = attempt;
    attempt = null;
    previous?.dispose?.();
  };
  async function run<T>(operation: (fence: AuthAttemptGuard) => Promise<T>): Promise<T> {
    const fence = guard();
    if (!fence.isCurrent()) throw changed();
    try {
      const result = await operation(fence);
      if (!fence.isCurrent()) throw changed(true);
      return result;
    } catch (error) {
      if (!fence.isCurrent()) throw changed(error instanceof ApiError
        ? error.effectUnknown || error.originalEffectUnknown : true);
      throw error;
    }
  }
  const phoneAttempt = () => {
    if (!active) throw changed();
    if (!attempt) attempt = identity.phoneFactory?.(guard()) ?? identity.phone ?? null;
    if (!attempt) throw new ApiError(501, 'phone_unavailable', 'Phone sign-in is unavailable.');
    return attempt;
  };
  const phone: PhoneAuthPort = {
    challenge: (number, key) => run(() => phoneAttempt().challenge(number, key)),
    resend: (challenge, key) => run(() => phoneAttempt().resend(challenge, key)),
    verify: (challenge, code, key) => run(() => phoneAttempt().verify(challenge, code, key)),
  };
  return {
    activate() { invalidate(); active = true; },
    deactivate() { active = false; invalidate(); },
    invalidate,
    isActive: () => active,
    phone: identity.phoneFactory || identity.phone ? phone : undefined,
    signIn: (email: string, password: string) => run(fence => api.signIn(email, password, fence)),
    signUp: (name: string, email: string, password: string) => run(fence => api.signUp(name, email, password, fence)),
    identity: (provider: 'apple' | 'google') => run(fence => {
      const action = identity[provider];
      if (!action) throw new ApiError(501, 'identity_unavailable', 'This sign-in provider is unavailable.');
      return action(fence);
    }),
  };
}
export type AuthSession = ReturnType<typeof createAuthSession>;
