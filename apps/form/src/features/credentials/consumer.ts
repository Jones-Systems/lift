import type { AccountSecuritySlotContext } from '../contract';
import {
  createChangeEmailController, createChangePasswordController, securityActions,
  type CredentialStatus,
} from './model';

type FlowKind = 'change-password' | 'change-email';
type PasswordController = ReturnType<typeof createChangePasswordController>;
type EmailController = ReturnType<typeof createChangeEmailController>;
type Binding = { kind: 'change-password'; controller: PasswordController; unsubscribe: () => void }
  | { kind: 'change-email'; controller: EmailController; unsubscribe: () => void };
export type SecurityHubSnapshot = Readonly<{
  status: 'ready' | 'disposed';
  identity: Readonly<{ email: string | null; emailVerified: boolean; phoneSuffix: string | null; providers: readonly string[] }>;
  available: Readonly<{ changePassword: boolean; changeEmail: boolean; passwordRecovery: boolean; revokeOtherSessions: boolean }>;
  active: FlowKind | null;
  flow: Readonly<{
    kind: FlowKind; step?: 'email' | 'code' | 'done'; status: CredentialStatus; message: string | null;
    newEmail?: string; canSubmit: boolean; refreshRequired?: boolean; refreshing?: boolean; offerRevokeOtherSessions?: boolean;
  }> | null;
  confirmedEmail: string | null;
}>;

export function createAccountSecurityConsumer(ctx: AccountSecuritySlotContext) {
  const accountId = ctx.account.accountId, sessionGeneration = ctx.sessionGeneration;
  const listeners = new Set<() => void>();
  let binding: Binding | null = null, disposed = false, invoking = false, revoking = false;
  let value: SecurityHubSnapshot = Object.freeze({
    status: 'ready', identity: Object.freeze({ email: null, emailVerified: false, phoneSuffix: null, providers: Object.freeze([]) }),
    available: Object.freeze({ changePassword: false, changeEmail: false, passwordRecovery: false, revokeOtherSessions: false }),
    active: null, flow: null, confirmedEmail: null,
  });
  function detach() {
    const old = binding; binding = null;
    old?.unsubscribe(); old?.controller.dispose();
  }
  function terminate() {
    if (disposed) return;
    disposed = true; detach(); listeners.clear();
    value = Object.freeze({ ...value, status: 'disposed', active: null, flow: null,
      available: Object.freeze({ changePassword: false, changeEmail: false, passwordRecovery: false, revokeOtherSessions: false }) });
  }
  function current(): boolean {
    if (disposed) return false;
    if (!ctx.isCurrentSession() || ctx.account.accountId !== accountId || ctx.sessionGeneration !== sessionGeneration) terminate();
    return !disposed;
  }
  function read(): SecurityHubSnapshot {
    if (!current()) return value;
    const actions = securityActions(ctx.settings, accountId);
    const selected = binding, state = selected?.controller.snapshot();
    if (!current()) return value;
    if (state?.status === 'disposed') { terminate(); return value; }
    let flow: SecurityHubSnapshot['flow'] = null;
    if (selected && state) {
      const canSubmit = !revoking && (state.status === 'idle' || state.status === 'failed');
      if (selected.kind === 'change-email' && 'step' in state) {
        flow = Object.freeze({ kind: selected.kind, step: state.step, status: state.status, message: state.notice,
          newEmail: state.newEmail, canSubmit: !state.refreshing && (canSubmit || (state.status === 'saved' && state.step === 'code')),
          refreshRequired: state.refreshRequired, refreshing: state.refreshing,
          offerRevokeOtherSessions: state.offerRevokeOtherSessions && !!ctx.sessionAction });
      } else {
        flow = Object.freeze({ kind: selected.kind, status: state.status, message: state.notice, canSubmit });
      }
    }
    value = Object.freeze({ status: 'ready',
      identity: Object.freeze({ email: actions.email, emailVerified: actions.emailVerified, phoneSuffix: actions.phoneSuffix, providers: actions.providers }),
      available: Object.freeze({ changePassword: actions.changePassword, changeEmail: actions.changeEmail,
        passwordRecovery: actions.passwordRecovery, revokeOtherSessions: !!ctx.sessionAction }),
      active: selected?.kind ?? null, flow,
      confirmedEmail: flow?.kind === 'change-email' && flow.status === 'saved' && flow.step === 'done'
        ? flow.newEmail! : value.confirmedEmail,
    });
    return value;
  }
  function publish() {
    if (!current() || invoking) return;
    read();
    for (const listener of [...listeners]) {
      if (!current()) break;
      if (listeners.has(listener)) listener();
    }
  }
  function pending() { const state = read().flow; return revoking || state?.status === 'pending' || state?.refreshing === true; }
  async function run(selected: Binding, action: () => Promise<void>) {
    if (!current() || binding !== selected) return;
    let work: Promise<void>;
    invoking = true;
    try { work = action(); } finally { invoking = false; }
    publish();
    await work;
    if (current() && binding === selected) read();
  }
  return {
    snapshot: read,
    subscribe(listener: () => void) {
      if (current()) listeners.add(listener);
      return () => { if (current()) listeners.delete(listener); };
    },
    open(kind: FlowKind): boolean {
      if (!current() || pending()) return false;
      const available = read().available;
      if (!current() || (kind !== 'change-password' && kind !== 'change-email') ||
        !(kind === 'change-password' ? available.changePassword : available.changeEmail)) return false;
      detach();
      const selected: Binding = kind === 'change-password'
        ? { kind, controller: createChangePasswordController(ctx.credentials), unsubscribe: () => {} }
        : { kind, controller: createChangeEmailController(ctx.credentials, {
          currentEmail: value.identity.email!,
          async refreshSettings() {
            if (current() && binding === selected) await ctx.resources.settings();
          },
        }), unsubscribe: () => {} };
      binding = selected;
      selected.unsubscribe = selected.controller.subscribe(() => { if (current() && binding === selected) publish(); });
      publish();
      return current() && binding === selected;
    },
    cancel() { if (current()) { detach(); publish(); } },
    async changePassword(currentPassword: string, next: string, confirmation: string): Promise<void> {
      if (!current() || pending() || binding?.kind !== 'change-password' || !read().flow?.canSubmit) return;
      const selected = binding;
      await run(selected, () => selected.controller.submit(currentPassword, next, confirmation));
    },
    async requestEmailCode(newEmail: string, currentPassword: string): Promise<void> {
      if (!current() || pending() || binding?.kind !== 'change-email' || !read().flow?.canSubmit) return;
      const selected = binding;
      await run(selected, () => selected.controller.requestCode(newEmail, currentPassword));
    },
    async confirmEmail(otp: string): Promise<void> {
      if (!current() || pending() || binding?.kind !== 'change-email' || !read().flow?.canSubmit) return;
      const selected = binding;
      await run(selected, () => selected.controller.confirm(otp));
    },
    async retryRefresh(): Promise<void> {
      if (!current() || pending() || binding?.kind !== 'change-email') return;
      const selected = binding;
      await run(selected, () => selected.controller.refreshSettings());
    },
    async revokeOtherSessions(): Promise<'saved' | 'failed' | 'unavailable'> {
      if (!current() || pending()) return 'unavailable';
      const selected = binding, flow = read().flow;
      if (!current() || selected?.kind !== 'change-email' || flow?.status !== 'saved' || flow.step !== 'done' || !ctx.sessionAction)
        return 'unavailable';
      revoking = true;
      try {
        const work = ctx.sessionAction('revokeOtherSessions'); publish();
        const result = await work;
        if (!current() || binding !== selected) return 'unavailable';
        return result.status === 'saved' ? 'saved' : 'failed';
      } catch {
        return current() && binding === selected ? 'failed' : 'unavailable';
      } finally { revoking = false; if (current() && binding === selected) publish(); }
    },
    finish() {
      if (!current() || pending() || !binding) return;
      const transition = binding.controller.transition();
      if (!current() || !transition) return;
      detach();
      if (!current()) return;
      if (transition.destination === 'settings') ctx.close();
      else if (transition.reason === 'session-ended') ctx.onSignedOut();
      publish();
    },
    dispose() { if (current()) terminate(); },
  };
}
