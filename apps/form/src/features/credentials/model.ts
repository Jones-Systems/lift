import {
  normalizeCredentialEmail, validCredentialEmail, validNewPassword,
  type CredentialIssue, type CredentialOutcome, type CredentialsPort,
} from '../../api/credentials';

export type CredentialStatus = 'idle' | 'pending' | 'saved' | 'failed' | 'unknown' | 'disposed';
export type CredentialTransition =
  | Readonly<{ destination: 'sign-in'; reason: 'password-reset'; emailPrefill: string }>
  | Readonly<{ destination: 'sign-in'; reason: 'session-ended'; notice: string }>
  | Readonly<{ destination: 'settings'; reason: 'password-changed'; notice: string }>
  | Readonly<{ destination: 'settings'; reason: 'email-changed'; newEmail: string; notice: string;
      refreshRequired: boolean; offerRevokeOtherSessions: true }>;
type State = Readonly<{ status: CredentialStatus; issue: CredentialIssue | null; notice: string | null }>;
export type ForgotPasswordState = State & Readonly<{
  step: 'email' | 'code' | 'done'; email: string; resendAt: number;
}>;
export type ChangePasswordState = State & Readonly<{ sessionReplaced: boolean }>;
export type ChangeEmailState = State & Readonly<{
  step: 'email' | 'code' | 'done'; newEmail: string; refreshRequired: boolean; refreshing: boolean; offerRevokeOtherSessions: boolean;
}>;

const idle: State = { status: 'idle', issue: null, notice: null };
function issue(code: CredentialIssue['code']): CredentialIssue { return Object.freeze({ code, status: 422, effectUnknown: false }); }
function message(problem: CredentialIssue): string {
  switch (problem.code) {
    case 'invalid_email': return 'Enter a valid email address.';
    case 'invalid_code': return 'Enter the 8-digit code.';
    case 'invalid_password': case 'PASSWORD_TOO_SHORT': case 'PASSWORD_TOO_LONG': return 'Use a password between 12 and 128 characters.';
    case 'password_mismatch': return 'Your new passwords do not match.';
    case 'INVALID_PASSWORD': return "That isn't your current password.";
    case 'INVALID_OTP': return "That code didn't work. Check it and try again.";
    case 'OTP_EXPIRED': return 'That code has expired. Request a new one.';
    case 'TOO_MANY_ATTEMPTS': return 'Too many tries. Request a new code.';
    case 'rate_limited': return 'Too many requests. Try again in a few minutes.';
    case 'password_recovery_unavailable': return "Password reset isn't available on this Form service yet.";
    case 'unauthenticated': case 'session_changed': return 'Your session ended. Sign in again — if you just changed your password, use the new one.';
    case 'CREDENTIAL_ACCOUNT_NOT_FOUND': return 'This sign-in method does not support password changes.';
    default: return 'We could not complete this change. Check your details and try again.';
  }
}
function resultState(result: CredentialOutcome, success: string, unknown: string): State {
  if (result.status === 'saved') return { status: 'saved', issue: null, notice: success };
  return { status: result.status, issue: result.issue, notice: result.status === 'unknown' ? unknown : message(result.issue) };
}

/** Secrets are command arguments only. There is no saved intent, retry closure or external storage in this store. */
function store<S extends State>(initial: S, port: CredentialsPort) {
  let value = Object.freeze(initial), generation = 0, live = true;
  const observers = new Set<() => void>();
  const emit = () => { for (const listener of [...observers]) listener(); };
  function dispose() {
    if (!live) return;
    live = false; generation++;
    value = Object.freeze({ ...initial, status: 'disposed' }); emit(); observers.clear();
  }
  function current(g = generation) {
    if (!port.isCurrent()) dispose();
    return live && generation === g;
  }
  function update(patch: Partial<S>) { value = Object.freeze({ ...value, ...patch }); emit(); }
  return {
    snapshot() { current(); return value; },
    subscribe(listener: () => void) { if (current()) observers.add(listener); return () => { observers.delete(listener); }; },
    dispose, current, update,
    begin() {
      if (!current() || value.status === 'pending') return null;
      const g = ++generation; update({ status: 'pending', issue: null, notice: null } as Partial<S>); return g;
    },
    reset() { if (current()) { generation++; value = Object.freeze(initial); emit(); } },
    reject(problem: CredentialIssue) { if (current() && value.status !== 'pending') update({ status: 'failed', issue: problem, notice: message(problem) } as Partial<S>); },
  };
}

export function createForgotPasswordController(port: CredentialsPort, now: () => number = Date.now) {
  const state = store<ForgotPasswordState>({ ...idle, step: 'email', email: '', resendAt: 0 }, port);
  return {
    snapshot: state.snapshot, subscribe: state.subscribe, dispose: state.dispose, startOver: state.reset,
    transition(): CredentialTransition | null {
      const current = state.snapshot();
      return current.status === 'saved' && current.step === 'done'
        ? Object.freeze({ destination: 'sign-in', reason: 'password-reset', emailPrefill: current.email }) : null;
    },
    async requestCode(email: string): Promise<void> {
      const before = state.snapshot();
      if (before.status === 'pending' || before.status === 'disposed' || before.step === 'done') return;
      if (!validCredentialEmail(email)) { state.reject(issue('invalid_email')); return; }
      if (now() < before.resendAt) return;
      const g = state.begin(); if (g === null) return;
      const target = normalizeCredentialEmail(email);
      const result = await port.requestPasswordReset({ email: target });
      if (!state.current(g)) return;
      state.update({ ...resultState(result, 'Check your email for an 8-digit code, if it belongs to a Form password account.',
        "We couldn't confirm the code was sent. Try again."), email: target,
        step: result.status === 'saved' ? 'code' : before.step,
        resendAt: result.status === 'failed' ? before.resendAt : now() + 60000 });
    },
    async submit(otp: string, password: string): Promise<void> {
      const before = state.snapshot();
      if (before.step !== 'code' || before.status === 'pending' || before.status === 'disposed' || before.status === 'unknown') return;
      const g = state.begin(); if (g === null) return;
      const result = await port.resetPassword({ email: before.email, otp, password });
      if (!state.current(g)) return;
      state.update({ ...resultState(result, "You've been signed out everywhere. Sign in with your new password.",
        "We couldn't confirm the reset. Try signing in with your new password; if that fails, request a new code."),
        step: result.status === 'saved' ? 'done' : 'code' });
    },
  };
}

export function createChangePasswordController(port: CredentialsPort) {
  const state = store<ChangePasswordState>({ ...idle, sessionReplaced: false }, port);
  return {
    snapshot: state.snapshot, subscribe: state.subscribe, dispose: state.dispose,
    transition(): CredentialTransition | null {
      const current = state.snapshot();
      if (current.status === 'saved' && current.sessionReplaced)
        return Object.freeze({ destination: 'settings', reason: 'password-changed',
          notice: 'Password changed. Your other devices were signed out.' });
      if (current.status === 'failed' && current.issue && !current.issue.effectUnknown
        && ((current.issue.code === 'unauthenticated' && current.issue.status === 401)
          || current.issue.code === 'session_changed'))
        return Object.freeze({ destination: 'sign-in', reason: 'session-ended', notice: message(current.issue) });
      return null;
    },
    async submit(currentPassword: string, newPassword: string, confirmation: string): Promise<void> {
      const before = state.snapshot();
      if (['pending', 'disposed', 'saved', 'unknown'].includes(before.status)) return;
      if (!validNewPassword(newPassword)) { state.reject(issue('invalid_password')); return; }
      if (newPassword !== confirmation) { state.reject(issue('password_mismatch')); return; }
      const g = state.begin(); if (g === null) return;
      const result = await port.changePassword({ currentPassword, newPassword });
      if (!state.current(g)) return;
      state.update({ ...resultState(result, 'Password changed. Your other devices were signed out.',
        "We couldn't confirm the change. If signing in later fails, use your new password."), sessionReplaced: result.status === 'saved' });
    },
  };
}

export function createChangeEmailController(port: CredentialsPort, options: { currentEmail: string; refreshSettings?: () => Promise<void> }) {
  const state = store<ChangeEmailState>({ ...idle, step: 'email', newEmail: '', refreshRequired: false, refreshing: false, offerRevokeOtherSessions: false }, port);
  let refreshFlight = false;
  async function refreshSettings() {
    const before = state.snapshot();
    if (before.status !== 'saved' || !before.refreshRequired || !options.refreshSettings || refreshFlight) return;
    refreshFlight = true; state.update({ refreshing: true });
    try {
      await options.refreshSettings();
      if (state.current()) state.update({ refreshRequired: false });
    } catch { /* A failed read cannot turn an authoritative email mutation into an unknown mutation. */ }
    finally { refreshFlight = false; if (state.current()) state.update({ refreshing: false }); }
  }
  return {
    snapshot: state.snapshot, subscribe: state.subscribe, dispose: state.dispose, refreshSettings,
    transition(): CredentialTransition | null {
      const current = state.snapshot();
      return current.status === 'saved' && current.step === 'done'
        ? Object.freeze({ destination: 'settings', reason: 'email-changed', newEmail: current.newEmail,
          notice: `Your sign-in email is now ${current.newEmail}.`, refreshRequired: current.refreshRequired,
          offerRevokeOtherSessions: true }) : null;
    },
    async requestCode(newEmail: string, currentPassword: string): Promise<void> {
      const before = state.snapshot();
      if (before.status === 'pending' || before.status === 'disposed' || before.step === 'done') return;
      if (!validCredentialEmail(newEmail) || normalizeCredentialEmail(newEmail) === normalizeCredentialEmail(options.currentEmail)) {
        state.reject(issue('invalid_email')); return;
      }
      const g = state.begin(); if (g === null) return;
      const target = normalizeCredentialEmail(newEmail);
      const result = await port.requestEmailChange({ newEmail: target, currentPassword });
      if (!state.current(g)) return;
      state.update({ ...resultState(result, 'If that email can be used, we sent it an 8-digit code.',
        "We couldn't confirm the code was sent. Try again."), newEmail: target, step: result.status === 'saved' ? 'code' : 'email' });
    },
    async confirm(otp: string): Promise<void> {
      const before = state.snapshot();
      if (before.step !== 'code' || ['pending', 'disposed', 'unknown'].includes(before.status)) return;
      const g = state.begin(); if (g === null) return;
      const result = await port.changeEmail({ newEmail: before.newEmail, otp });
      if (!state.current(g)) return;
      state.update({ ...resultState(result, 'Your sign-in email has changed.',
        "We couldn't confirm the email change. Refresh your account details before trying again."),
        ...(result.status === 'failed' && result.issue.code === 'EMAIL_ALREADY_IN_USE' ? { notice: 'Email already in use.' } : {}),
        step: result.status === 'saved' ? 'done' : 'code', refreshRequired: result.status === 'saved', offerRevokeOtherSessions: result.status === 'saved' });
      if (result.status === 'saved') await refreshSettings();
    },
  };
}

type SecuritySettings = {
  accountId: string;
  identity: { email: string | null; emailVerified: boolean; signInMethods: readonly string[]; phoneNumber: string | null };
  capabilities: object;
};
export function securityActions(settings: SecuritySettings | null, accountId: string) {
  const own = settings?.accountId === accountId ? settings : null;
  const credential = own?.identity.signInMethods.includes('emailPassword') === true;
  const capability = (key: string): { supported: boolean; status: string } | null => {
    const value = (own?.capabilities as Record<string, unknown> | undefined)?.[key];
    if (!value || typeof value !== 'object') return null;
    const fields = value as { supported?: unknown; status?: unknown };
    return typeof fields.supported === 'boolean' && typeof fields.status === 'string'
      ? { supported: fields.supported, status: fields.status } : null;
  };
  const configured = (key: string) => capability(key)?.supported === true
    && ['configured_unverified', 'verified'].includes(capability(key)!.status);
  return Object.freeze({
    email: own?.identity.email ?? null, emailVerified: own?.identity.email !== null && own?.identity.emailVerified === true,
    phoneSuffix: own?.identity.phoneNumber?.slice(-4) ?? null,
    providers: Object.freeze(own?.identity.signInMethods.filter(method => method === 'apple' || method === 'google' || method === 'phone') ?? []),
    changePassword: credential && capability('changePassword')?.supported === true && capability('changePassword')?.status === 'available',
    changeEmail: credential && own?.identity.email !== null && configured('changeEmail'),
    passwordRecovery: credential && configured('passwordRecovery'),
  });
}
