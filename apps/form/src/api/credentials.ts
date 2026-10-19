import { ApiError, type AuthAttemptGuard, type FormTransport } from './transport';

export type CredentialIssueCode =
  | 'invalid_email' | 'invalid_password' | 'invalid_code' | 'password_mismatch' | 'invalid_request'
  | 'INVALID_PASSWORD' | 'INVALID_OTP' | 'OTP_EXPIRED' | 'TOO_MANY_ATTEMPTS'
  | 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'EMAIL_ALREADY_IN_USE' | 'CREDENTIAL_ACCOUNT_NOT_FOUND'
  | 'password_recovery_unavailable' | 'rate_limited' | 'unauthenticated' | 'session_changed'
  | 'request_failed' | 'invalid_response' | 'network_unavailable' | 'operation_pending';
export type CredentialIssue = Readonly<{ code: CredentialIssueCode; status: number; effectUnknown: boolean }>;
export type CredentialOutcome = Readonly<{ status: 'saved' }>
  | Readonly<{ status: 'failed' | 'unknown'; issue: CredentialIssue }>;
export type CredentialTransport = Pick<FormTransport,
  'anonymousAuthCommand' | 'replaceSession' | 'request' | 'captureAuthContext' | 'subscribeAuthChanges'>;
export type CredentialsPort = {
  /** Shell observers must distinguish this originating replacement from a different account's auth intent. */
  readonly replacementGuard: AuthAttemptGuard;
  isCurrent(): boolean;
  dispose(): void;
  requestPasswordReset(input: { email: string }): Promise<CredentialOutcome>;
  resetPassword(input: { email: string; otp: string; password: string }): Promise<CredentialOutcome>;
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<CredentialOutcome>;
  requestEmailChange(input: { newEmail: string; currentPassword: string }): Promise<CredentialOutcome>;
  changeEmail(input: { newEmail: string; otp: string }): Promise<CredentialOutcome>;
};

export const normalizeCredentialEmail = (value: string): string => value.trim().toLowerCase();
export const validCredentialEmail = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
export const validNewPassword = (value: unknown): value is string => typeof value === 'string' && value.length >= 12 && value.length <= 128;
const validCurrentPassword = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 128;
const validCode = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{8}$/.test(value);
const saved: CredentialOutcome = Object.freeze({ status: 'saved' });
const failed = (code: CredentialIssueCode, status = 422, effectUnknown = false): CredentialOutcome =>
  Object.freeze({ status: effectUnknown ? 'unknown' : 'failed', issue: Object.freeze({ code, status, effectUnknown }) });
const knownCodes = new Set<CredentialIssueCode>(['INVALID_PASSWORD', 'INVALID_OTP', 'OTP_EXPIRED', 'TOO_MANY_ATTEMPTS',
  'PASSWORD_TOO_SHORT', 'PASSWORD_TOO_LONG', 'EMAIL_ALREADY_IN_USE', 'CREDENTIAL_ACCOUNT_NOT_FOUND',
  'password_recovery_unavailable', 'invalid_request', 'invalid_response', 'network_unavailable']);

function outcome(error: unknown, allowEmailConflict: boolean): CredentialOutcome {
  if (!(error instanceof ApiError)) return failed('request_failed', 0, true);
  const status = Number.isInteger(error.status) && error.status >= 0 && error.status <= 599 ? error.status : 0;
  if (error.code === 'session_changed') return failed('session_changed', 409, error.originalEffectUnknown || error.effectUnknown);
  if (status === 401) return failed('unauthenticated', 401);
  // The proxy rejects before dispatch when mail is absent; transport's generic 5xx rule is broader.
  if (status === 501 && error.code === 'password_recovery_unavailable') return failed('password_recovery_unavailable', 501);
  if (status === 429) return failed('rate_limited', 429);
  if (error.code === 'EMAIL_ALREADY_IN_USE' && !allowEmailConflict) return failed('request_failed', status);
  const code = knownCodes.has(error.code as CredentialIssueCode) ? error.code as CredentialIssueCode : 'request_failed';
  return failed(code, status, error.effectUnknown || error.originalEffectUnknown || status === 0 || status >= 500);
}

function fields(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
}

export function createCredentialsPort(transport: CredentialTransport, owner: AuthAttemptGuard): CredentialsPort {
  let live = true, pending = false, replacing = false;
  let context = transport.captureAuthContext();
  const replacementGuard: AuthAttemptGuard = Object.freeze({ isCurrent: () => live && owner.isCurrent() });
  const subscription = transport.subscribeAuthChanges(source => {
    if (!replacing || source !== replacementGuard) live = false;
  });
  const isCurrent = () => live && owner.isCurrent() && (replacing || context.isCurrent());
  async function run(work: () => Promise<unknown>, replace = false, allowEmailConflict = false): Promise<CredentialOutcome> {
    if (!isCurrent()) return failed('session_changed', 409);
    if (pending) return failed('operation_pending', 409);
    pending = true; replacing = replace;
    let result: CredentialOutcome;
    try {
      const value = await work();
      if (!live || !owner.isCurrent() || (!replace && !context.isCurrent())) return failed('session_changed', 409, true);
      // replaceSession alone verifies/stores the signed header. Never expose its token/user response here.
      result = replace || (value !== null && typeof value === 'object' && (value as { success?: unknown }).success === true)
        ? saved : failed('invalid_response', 502, true);
    } catch (error) {
      result = !live || !owner.isCurrent() || (!replace && !context.isCurrent())
        ? failed('session_changed', 409, true) : outcome(error, allowEmailConflict);
    } finally {
      // A failed password attempt also advances transport's auth intent. Rebind only our own attempt.
      if (replace && live && owner.isCurrent()) context = transport.captureAuthContext();
      replacing = false; pending = false;
    }
    return result;
  }
  return {
    replacementGuard, isCurrent,
    dispose() { live = false; subscription.remove(); },
    async requestPasswordReset(input) {
      if (!fields(input, ['email'])) return failed('invalid_request');
      if (!validCredentialEmail(input.email)) return failed('invalid_email');
      return run(() => transport.anonymousAuthCommand('/api/auth/email-otp/request-password-reset', { email: normalizeCredentialEmail(input.email as string) }));
    },
    async resetPassword(input) {
      if (!fields(input, ['email', 'otp', 'password'])) return failed('invalid_request');
      if (!validCredentialEmail(input.email)) return failed('invalid_email');
      if (!validCode(input.otp)) return failed('invalid_code');
      if (!validNewPassword(input.password)) return failed('invalid_password');
      return run(() => transport.anonymousAuthCommand('/api/auth/email-otp/reset-password',
        { email: normalizeCredentialEmail(input.email as string), otp: input.otp, password: input.password }));
    },
    async changePassword(input) {
      if (!fields(input, ['currentPassword', 'newPassword'])) return failed('invalid_request');
      if (!validCurrentPassword(input.currentPassword) || !validNewPassword(input.newPassword)) return failed('invalid_password');
      return run(() => transport.replaceSession('/api/auth/change-password',
        { currentPassword: input.currentPassword, newPassword: input.newPassword }, replacementGuard), true);
    },
    async requestEmailChange(input) {
      if (!fields(input, ['newEmail', 'currentPassword'])) return failed('invalid_request');
      if (!validCredentialEmail(input.newEmail)) return failed('invalid_email');
      if (!validCurrentPassword(input.currentPassword)) return failed('invalid_password');
      return run(() => transport.request('/api/auth/email-otp/request-email-change', 'POST',
        { newEmail: normalizeCredentialEmail(input.newEmail as string), currentPassword: input.currentPassword }));
    },
    async changeEmail(input) {
      if (!fields(input, ['newEmail', 'otp'])) return failed('invalid_request');
      if (!validCredentialEmail(input.newEmail)) return failed('invalid_email');
      if (!validCode(input.otp)) return failed('invalid_code');
      return run(() => transport.request('/api/auth/email-otp/change-email', 'POST',
        { newEmail: normalizeCredentialEmail(input.newEmail as string), otp: input.otp }), false, true);
    },
  };
}
