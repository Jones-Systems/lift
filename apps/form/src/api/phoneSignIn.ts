import { ApiError, FormTransport, type AuthAttemptGuard } from './transport';
import type { PhoneAuthPort, PhoneChallenge } from '../features/contract';

export type PhoneRandomBytes = () => Promise<Uint8Array>;
export type PhoneAttemptOptions = {
  randomBytes32: PhoneRandomBytes;
  /** Root shell lifecycle guard; must be false after account/session replacement or departure. */
  isCurrentSession?: () => boolean;
  now?: () => number;
};
export interface PhoneSignInAttempt extends PhoneAuthPort {
  reset(): void;
  dispose(): void;
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const phonePattern = /^\+[1-9][0-9]{7,14}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9_.:-]{16,128}$/;

/** Exactly 32 cryptographic bytes become 43 unpadded base64url characters. No runtime global codecs. */
export function encodePhoneBinding(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
    throw new ApiError(0, 'phone_random_unavailable', 'Secure phone login randomness is unavailable.');
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    result += alphabet[a >>> 2] + alphabet[((a & 3) << 4) | (b >>> 4)];
    if (i + 1 < bytes.length) result += alphabet[((b & 15) << 2) | (c >>> 6)];
    if (i + 2 < bytes.length) result += alphabet[c & 63];
  }
  return result;
}

const changed = (unknown = false) => new ApiError(409, 'session_changed',
  'The phone login attempt ended. Start a new login and reconcile any earlier result.', false, unknown);
const invalid = (unknown = false) => new ApiError(unknown ? 502 : 422, 'invalid_phone_challenge',
  'The phone challenge could not be confirmed.', unknown);

type Kind = 'challenge' | 'resend' | 'verify';
type Intent = { kind: Kind; identity: string; payload: { phoneNumber: string; binding: string; challengeId?: string; code?: string }; key?: string };

/** Root supplies the existing transport and a native cryptographic async 32-byte source. Construction is inert. */
export function createPhoneSignInAttempt(api: FormTransport, options: PhoneAttemptOptions): PhoneSignInAttempt {
  const now = options.now ?? Date.now;
  let epoch = 0, disposed = false;
  let binding: string | undefined;
  let phoneNumber: string | undefined;
  let challenge: PhoneChallenge | undefined;
  let intent: Intent | undefined;
  let flight: { identity: string; promise: Promise<unknown> } | undefined;
  let activeGuard: AuthAttemptGuard | undefined;
  let context = api.captureAuthContext();
  const erase = () => {
    epoch++;
    binding = undefined; phoneNumber = undefined; challenge = undefined; intent = undefined; flight = undefined;
    activeGuard = undefined;
    context = api.captureAuthContext();
  };
  const subscription = api.subscribeAuthChanges(source => {
    if (source !== undefined && source === activeGuard) return;
    erase();
  });
  const assertLive = () => {
    if (disposed || !(options.isCurrentSession?.() ?? true) || !context.isCurrent()) {
      erase(); throw changed();
    }
  };
  const timestamp = () => {
    const value = now();
    if (!Number.isFinite(value)) throw invalid();
    return value;
  };
  const exactChallenge = (value: unknown, phone: string, previous?: PhoneChallenge): PhoneChallenge => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(true);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'challengeId,expiresAt,phoneNumber,resendAfter,status'
      || typeof row.challengeId !== 'string' || !uuidPattern.test(row.challengeId)
      || row.phoneNumber !== phone || row.status !== 'pending'
      || typeof row.expiresAt !== 'string' || typeof row.resendAfter !== 'string') throw invalid(true);
    const expires = Date.parse(row.expiresAt), resend = Date.parse(row.resendAfter), clock = timestamp();
    if (!Number.isFinite(expires) || !Number.isFinite(resend) || expires <= clock || expires > clock + 600_000
      || new Date(expires).toISOString() !== row.expiresAt || new Date(resend).toISOString() !== row.resendAfter
      || resend > expires || (previous && (row.challengeId !== previous.challengeId || row.expiresAt !== previous.expiresAt
        || resend < Date.parse(previous.resendAfter)))) throw invalid(true);
    return { challengeId: row.challengeId, phoneNumber: phone, status: 'pending', expiresAt: row.expiresAt, resendAfter: row.resendAfter };
  };
  const ownedChallenge = (value: PhoneChallenge): PhoneChallenge => {
    assertLive();
    if (!challenge || Object.keys(value).sort().join(',') !== 'challengeId,expiresAt,phoneNumber,resendAfter,status'
      || value.challengeId !== challenge.challengeId || value.phoneNumber !== challenge.phoneNumber || value.status !== challenge.status
      || value.expiresAt !== challenge.expiresAt || value.resendAfter !== challenge.resendAfter) throw invalid();
    if (timestamp() >= Date.parse(challenge.expiresAt)) { erase(); throw new ApiError(409, 'phone_challenge_expired', 'Start a new phone login.'); }
    return challenge;
  };

  const run = (kind: Kind, identity: string, callerKey: string, prepare: () => Promise<Intent>, dispatch: (command: Intent, guard: AuthAttemptGuard) => Promise<unknown>): Promise<unknown> => {
    try {
      assertLive();
      if (!keyPattern.test(callerKey)) throw new ApiError(422, 'invalid_phone_key', 'A phone intent key is required.');
      if (flight) {
        if (flight.identity !== identity) throw new ApiError(409, 'phone_attempt_busy', 'Wait for this phone operation to finish.');
        return flight.promise;
      }
      if (intent && (intent.kind !== kind || intent.identity !== identity))
        throw new ApiError(409, 'phone_outcome_unknown', 'Reconcile the original phone operation before changing it.', true);
    } catch (error) { return Promise.reject(error); }
    const generation = epoch;
    const guard: AuthAttemptGuard = {
      isCurrent: () => !disposed && generation === epoch && (options.isCurrentSession?.() ?? true),
      validateResult: kind !== 'verify' ? undefined : (value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(',') !== 'status,token,user' || row.status !== true || typeof row.token !== 'string' || !row.token.length
          || !row.user || typeof row.user !== 'object' || Array.isArray(row.user)) return false;
        const user = row.user as Record<string, unknown>;
        return Object.keys(user).every(key => ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt', 'phoneNumber', 'phoneNumberVerified'].includes(key))
          && typeof user.id === 'string' && uuidPattern.test(user.id)
          && user.phoneNumber === phoneNumber && user.phoneNumberVerified === true
          && typeof user.email === 'string' && /^[a-f0-9]{64}@phone\.form\.invalid$/.test(user.email);
      },
    };
    activeGuard = guard;
    const promise = (async () => {
      let dispatched = false;
      try {
        const command = intent ?? await prepare();
        if (!guard.isCurrent()) throw changed();
        intent = command;
        if (!command.key) {
          const bytes = await options.randomBytes32();
          if (!guard.isCurrent()) throw changed();
          command.key = encodePhoneBinding(bytes);
        }
        if (!guard.isCurrent()) throw changed();
        dispatched = true;
        const result = await dispatch(command, guard);
        if (!guard.isCurrent()) throw changed(true);
        if (kind === 'verify') {
          erase();
          return { status: true };
        }
        const next = exactChallenge(result, command.payload.phoneNumber, kind === 'resend' ? challenge : undefined);
        challenge = next;
        intent = undefined;
        return { ...next };
      } catch (error) {
        if (!guard.isCurrent() || (error instanceof ApiError && error.code === 'session_changed')) {
          erase(); throw changed(dispatched);
        }
        // Lost signed-session responses or consumed proofs must never mint another session from the old proof.
        if (error instanceof ApiError && (error.originalEffectUnknown || ['phone_challenge_consumed', 'phone_challenge_expired', 'missing_session'].includes(error.code))) {
          erase(); throw error;
        }
        if (error instanceof ApiError && (error.effectUnknown || error.code === 'phone_outcome_unknown')) {
          context = api.captureAuthContext();
          throw error;
        }
        intent = undefined;
        context = api.captureAuthContext();
        throw error;
      } finally {
        if (generation === epoch) { flight = undefined; activeGuard = undefined; }
      }
    })();
    flight = { identity, promise };
    return promise;
  };

  return {
    challenge(phone: string, key: string): Promise<PhoneChallenge> {
      try {
        assertLive();
        if (!phonePattern.test(phone)) throw new ApiError(422, 'invalid_phone', 'Use a canonical international phone number.');
        if (phoneNumber && phoneNumber !== phone) throw new ApiError(409, 'phone_attempt_changed', 'Reset before starting a different phone login.');
        if (challenge) { ownedChallenge(challenge); return Promise.resolve({ ...challenge }); }
      } catch (error) { return Promise.reject(error); }
      return run('challenge', `challenge:${phone}`, key, async () => {
        phoneNumber = phone;
        if (!binding) {
          const generation = epoch;
          const bytes = await options.randomBytes32();
          if (generation !== epoch || disposed) throw changed();
          binding = encodePhoneBinding(bytes);
        }
        return { kind: 'challenge', identity: `challenge:${phone}`, payload: { phoneNumber: phone, binding } };
      }, (command, guard) => api.phoneChallenge(command.payload, command.key!, guard)) as Promise<PhoneChallenge>;
    },
    resend(value: PhoneChallenge, key: string): Promise<PhoneChallenge> {
      let row: PhoneChallenge;
      try {
        row = ownedChallenge(value);
        if (!intent && timestamp() < Date.parse(row.resendAfter)) throw new ApiError(429, 'phone_resend_cooldown', 'Wait before requesting another code.');
      } catch (error) { return Promise.reject(error); }
      const identity = `resend:${row.challengeId}:${row.resendAfter}`;
      return run('resend', identity, key, async () => ({ kind: 'resend', identity,
        payload: { phoneNumber: row.phoneNumber, binding: binding!, challengeId: row.challengeId } }),
      (command, guard) => api.resendPhoneChallenge(command.payload as { phoneNumber: string; binding: string; challengeId: string }, command.key!, guard)) as Promise<PhoneChallenge>;
    },
    verify(value: PhoneChallenge, code: string, key: string): Promise<unknown> {
      let row: PhoneChallenge;
      try {
        row = ownedChallenge(value);
        if (!/^[0-9]{4,10}$/.test(code)) throw new ApiError(422, 'invalid_phone_code', 'Use the numeric provider code.');
      } catch (error) { return Promise.reject(error); }
      const identity = `verify:${row.challengeId}:${code}`;
      return run('verify', identity, key, async () => ({ kind: 'verify', identity,
        payload: { phoneNumber: row.phoneNumber, binding: binding!, challengeId: row.challengeId, code } }),
      (command, guard) => api.signInPhone(command.payload as { phoneNumber: string; binding: string; challengeId: string; code: string }, command.key!, guard));
    },
    reset: erase,
    dispose() { if (disposed) return; disposed = true; erase(); subscription.remove(); },
  };
}
