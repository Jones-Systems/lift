import { createLifecycleApi } from '../account-lifecycle/api';
import { LifecycleError, type RecoveryReceipt } from '../account-lifecycle/contracts';
import type { LifecycleContext, ReceiptStore } from '../account-lifecycle/controller';
import type { FormTransport } from '../api/transport';
import type { LocalTeardownResult } from '../voice-coaching/contracts';
import type { SharedVoiceScope } from './sharedVoice';

type LifecycleTransport = Pick<FormTransport, 'baseURL' | 'request' | 'captureAuthContext' | 'subscribeAuthChanges' | 'captureRevokedSessionClear'>;
export type LifecycleReceiptCustody = (accountId: string, baseURL: string) => Promise<{ receipts: ReceiptStore } | null>;
export type LifecycleShellBinding = Readonly<{
  accountId: string; sessionKey: string; voiceScope: SharedVoiceScope;
  isCurrent(): boolean;
  claimAccessDisabled(): { isCurrent(): boolean; disposeSpeech(): Promise<void> };
}>;
export type LifecycleRecoverySelection = Readonly<{
  accountId: string; baseURL: string; sessionKey: string;
  isCurrent(): boolean;
}>;
export type LifecycleCleanup = Readonly<{ status: 'not_started' | 'pending' | 'complete' | 'incomplete'; failedSteps: readonly string[] }>;
const changed = () => new LifecycleError('session_changed');
const denied = async (): Promise<never> => { throw new LifecycleError('lifecycle_action_unavailable'); };
const endpoint = (value: string) => value.replace(/\/$/, '');
function lazyReceipts(accountId: string, baseURL: string, custody: LifecycleReceiptCustody | undefined, current: () => boolean): ReceiptStore | undefined {
  if (!custody) return undefined;
  let retained: ReturnType<LifecycleReceiptCustody> | undefined;
  return {
    async load() {
      if (!current()) throw changed();
      retained ??= custody(accountId, baseURL);
      const result = await retained;
      if (!current()) throw changed();
      if (!result) return null;
      const receipt = await result.receipts.load();
      if (!current()) throw changed();
      return receipt;
    },
    save: denied,
  };
}

export function createLifecycleRecovery(options: {
  selection: LifecycleRecoverySelection | null;
  receiptCustody?: LifecycleReceiptCustody;
  fetcher?: typeof fetch;
}) {
  if (!options.selection?.accountId || !options.selection.baseURL || !options.selection.sessionKey) return null;
  const selection = Object.freeze({ ...options.selection, baseURL: endpoint(options.selection.baseURL) });
  let disposed = false, expired = false;
  const current = () => {
    if (!selection.isCurrent()) expired = true;
    return !disposed && !expired;
  };
  const api = createLifecycleApi({ baseURL: selection.baseURL, request: denied }, options.fetcher);
  const context: LifecycleContext = Object.freeze({
    accountId: selection.accountId, sessionKey: selection.sessionKey, isCurrent: current, actionsQualified: false,
    receipts: lazyReceipts(selection.accountId, selection.baseURL, options.receiptCustody, current),
    api: Object.freeze({ ...api, settings: denied, grant: denied, export: denied, initiate: denied, confirm: denied,
      async status(receipt: RecoveryReceipt) {
        if (!current()) throw changed();
        if (receipt.accountId !== selection.accountId || receipt.baseURL !== selection.baseURL) throw changed();
        const result = await api.status(receipt);
        if (!current()) throw changed();
        return result;
      } }),
  });
  return { context, dispose() { disposed = true; } };
}

export function createLifecycleSession(options: {
  api: LifecycleTransport;
  shell: LifecycleShellBinding;
  receiptCustody?: LifecycleReceiptCustody;
  captureResources(): () => Promise<void>;
  stopAudio(): Promise<LocalTeardownResult>;
  fetcher?: typeof fetch;
}) {
  const { api, receiptCustody, captureResources, stopAudio, fetcher } = options;
  const shell = Object.freeze({ ...options.shell });
  if (!shell.accountId || !shell.sessionKey || shell.voiceScope.account.accountId !== shell.accountId ||
    shell.voiceScope.account.authSessionId !== shell.sessionKey) throw new LifecycleError('lifecycle_scope_invalid');
  const accountId = shell.accountId, sessionKey = shell.sessionKey, baseURL = endpoint(api.baseURL);
  const auth = api.captureAuthContext();
  const clearRevokedSession = api.captureRevokedSessionClear(auth);
  let disposed = false, foreignAuth = false, expired = false;
  let cleanup: LifecycleCleanup = Object.freeze({ status: 'not_started', failedSteps: [] });
  let teardown: Promise<void> | undefined;
  const current = () => {
    if (!auth.isCurrent() || !shell.isCurrent()) expired = true;
    return !disposed && !expired;
  };
  const subscription = api.subscribeAuthChanges(source => { if (source !== auth) foreignAuth = true; });
  const onAccessDisabled = (): Promise<void> => {
    if (teardown) return teardown;
    if (!current() || foreignAuth) return Promise.reject(changed());
    cleanup = Object.freeze({ status: 'pending', failedSteps: [] });
    let resolve!: () => void, reject!: (error: unknown) => void;
    teardown = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Retain the result before the shell invalidates the authenticated controller's view.
    void (async () => {
      const failures: string[] = [];
      try {
        const disposeResources = captureResources();
        const claim = shell.claimAccessDisabled();
        const owned = () => !foreignAuth && claim.isCurrent();
        const attempt = async (name: string, action: () => Promise<unknown>) => {
          try { if (!owned()) throw changed(); await action(); if (!owned()) throw changed(); }
          catch { failures.push(name); }
        };
        await Promise.all([
          attempt('resources', disposeResources),
          attempt('speech', () => claim.disposeSpeech()),
          attempt('audio', async () => { if ((await stopAudio()).status !== 'released') throw new LifecycleError('audio_cleanup_incomplete'); }),
          attempt('local_session', clearRevokedSession),
        ]);
      } catch { failures.push('account_custody'); }
      cleanup = Object.freeze({ status: failures.length ? 'incomplete' : 'complete', failedSteps: Object.freeze(failures) });
      subscription.remove();
      if (failures.length) reject(new LifecycleError('device_cleanup_incomplete'));
      else resolve();
    })();
    return teardown;
  };
  const guardedApi = createLifecycleApi({ baseURL, async request<T>(path: string, method?: string, body?: unknown, key?: string): Promise<T> {
    if (!current()) throw changed();
    const result = await api.request<T>(path, method, body, key);
    if (!current()) throw changed();
    return result;
  } }, fetcher);
  const status = guardedApi.status;
  guardedApi.status = async receipt => {
    if (!current() || receipt.accountId !== accountId || receipt.baseURL !== baseURL) throw changed();
    const result = await status(receipt);
    if (!current()) throw changed();
    return result;
  };
  const context: LifecycleContext = Object.freeze({ accountId, sessionKey, isCurrent: current,
    api: Object.freeze(guardedApi), actionsQualified: false, onAccessDisabled,
    receipts: lazyReceipts(accountId, baseURL, receiptCustody, current) });
  return {
    context,
    cleanupSnapshot: (): LifecycleCleanup => cleanup,
    recovery(selection: LifecycleRecoverySelection | null) {
      if (!selection || selection.accountId !== accountId || endpoint(selection.baseURL) !== baseURL || selection.sessionKey === sessionKey) return null;
      const recovery = createLifecycleRecovery({ selection, receiptCustody, fetcher });
      if (!recovery) return null;
      const recoveryContext: LifecycleContext = Object.freeze({ ...recovery.context,
        async onAccessDisabled() {
          if (!recovery.context.isCurrent()) throw changed();
          if (!teardown) throw new LifecycleError('device_cleanup_unconfirmed');
          await teardown;
          if (!recovery.context.isCurrent()) throw changed();
        } });
      return { ...recovery, context: recoveryContext, cleanupSnapshot: () => cleanup };
    },
    dispose() { disposed = true; if (!teardown) subscription.remove(); },
  };
}
export type LifecycleHostSession = ReturnType<typeof createLifecycleSession>;
