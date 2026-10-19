import { availableSettings, deletionReceipt, exportReceipt, grantReceipt, LifecycleError, recoveryReceipt,
  type DeletionReceipt, type ExportReceipt, type RecoveryReceipt } from './contracts';
import type { LifecycleApi } from './api';

export type ReceiptStore = { load(): Promise<unknown | null>; save(receipt: RecoveryReceipt): Promise<void> };
export type LifecycleContext = {
  accountId: string; sessionKey: string; isCurrent(): boolean; api: LifecycleApi;
  actionsQualified?: boolean; onAccessDisabled?: () => Promise<void>;
  receipts?: ReceiptStore; createReceipt?: () => Promise<RecoveryReceipt>;
  deliverExport?: (receipt: ExportReceipt, isCurrent: () => boolean) => Promise<'delivered' | 'cancelled'>;
};
export type LifecycleState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'unavailable' | 'pending' | 'unknown' | 'error' | 'disabled' | 'disposed';
  available: boolean; exportAvailable: boolean; deletionAvailable: boolean;
  receipt: DeletionReceipt | null; canCheckStatus: boolean; exportStatus: 'none' | 'delivered' | 'cancelled'; message: string;
}>;
export function createAccountLifecycleController(context: LifecycleContext) {
  let disposed = false, busy = false, initialized = false, recovery: RecoveryReceipt | null = null, held = false;
  let state: LifecycleState = { phase: 'idle', available: false, exportAvailable: false, deletionAvailable: false,
    receipt: null, canCheckStatus: false, exportStatus: 'none', message: '' };
  const listeners = new Set<() => void>();
  const current = () => !disposed && context.isCurrent();
  const publish = (patch: Partial<LifecycleState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown, sent: boolean) => {
    const e = error as { code?: string; effectUnknown?: boolean; originalEffectUnknown?: boolean } | null;
    const unknown = sent && (e?.effectUnknown === true || e?.originalEffectUnknown === true || !e?.code);
    held ||= unknown;
    publish({ phase: unknown ? 'unknown' : 'error', message: unknown
      ? 'The result is unknown. Do not repeat this action. Check the retained deletion receipt or contact support.'
      : e?.code === 'action_reauthentication_failed' ? 'The password could not be verified.'
      : e?.code === 'action_reauthentication_unqualified' ? 'Password verification is unavailable for this sign-in method.'
      : e?.code === 'status_receipt_invalid' ? 'The status receipt is invalid or expired. Contact support; do not submit a new deletion.'
      : 'This action is unavailable or could not be confirmed.' });
  };
  async function run(action: () => Promise<void>, sent: () => boolean = () => false) {
    if (!current() || busy) return;
    busy = true;
    try { await action(); } catch (error) { fail(error, sent()); }
    finally { busy = false; }
  }
  async function accept(value: unknown, expected: 'initiate' | 'confirm' | 'status') {
    if (!current() || !recovery) return;
    const receipt = deletionReceipt(value, recovery.requestId);
    if (expected === 'confirm' && !receipt.disabled) throw new LifecycleError('invalid_deletion_receipt', true);
    if (state.receipt?.disabled && !receipt.disabled) throw new LifecycleError('regressed_deletion_receipt', true);
    held = false;
    publish({ receipt, phase: receipt.disabled ? 'disabled' : 'ready', canCheckStatus: true,
      message: receipt.disabled ? 'Account access is disabled. Erasure is still incomplete. Billing cancellation has not been performed.'
        : 'Deletion requested. Review the consequences and verify your password to disable account access.' });
    if (receipt.disabled && current() && context.onAccessDisabled) {
      try { await context.onAccessDisabled(); }
      catch { publish({ message: 'Account access is disabled. Device cleanup could not be confirmed; erasure remains incomplete.' }); }
    }
  }
  return {
    snapshot: (): LifecycleState => current() ? state : { ...state, phase: 'disposed', receipt: null, available: false,
      exportAvailable: false, deletionAvailable: false, canCheckStatus: false, exportStatus: 'none', message: '' },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initialize: () => run(async () => {
      if (initialized) return;
      publish({ phase: 'loading' });
      if (context.receipts) {
        const saved = await context.receipts.load();
        if (!current()) return;
        if (saved !== null) {
          recovery = recoveryReceipt(saved, context.accountId, context.api.baseURL);
          held = true; initialized = true;
          publish({ canCheckStatus: true, phase: 'unknown', message: 'A retained deletion request needs a status check before any further action.' });
          return;
        }
      }
      const settings = await context.api.settings();
      if (!current()) return;
      const available = availableSettings(settings, context.accountId) && context.actionsQualified === true;
      initialized = true;
      publish({ available, phase: available ? 'ready' : 'unavailable', exportAvailable: available && !!context.deliverExport,
        deletionAvailable: available && !!context.receipts && !!context.createReceipt && !!context.onAccessDisabled,
        message: available ? 'Exports and deletion are staged. Complete erasure and backup expiry are not confirmed.' : 'Account export and deletion are currently unavailable.' });
    }),
    exportAccount: (password: string) => {
      let sent = false;
      return run(async () => {
        if (!state.exportAvailable || held || recovery || !password || password.length > 128) return;
        publish({ phase: 'pending', message: 'Preparing account export…', exportStatus: 'none' });
        sent = true;
        const grant = grantReceipt(await context.api.grant('account_export', password), 'account_export', Date.now());
        if (!current()) return;
        const result = exportReceipt(await context.api.export(grant), context.accountId);
        if (!current()) return;
        const delivered = await context.deliverExport!(result, current);
        if (!current()) return;
        if (delivered !== 'delivered' && delivered !== 'cancelled') throw new LifecycleError('export_delivery_unknown', true);
        publish({ phase: 'ready', exportStatus: delivered, message: delivered === 'delivered'
          ? 'Partial export delivered. Check its manifest for omissions and retained data.' : 'Export delivery cancelled. No saved file is confirmed.' });
      }, () => sent);
    },
    requestDeletion: () => {
      let sent = false;
      return run(async () => {
        if (!state.deletionAvailable || held || recovery) return;
        publish({ phase: 'pending', message: 'Retaining a deletion recovery receipt…' });
        const candidate = recoveryReceipt(await context.createReceipt!(), context.accountId, context.api.baseURL);
        if (!current()) return;
        // Persist and read back before the first server effect; never regenerate an uncertain request.
        recovery = candidate; held = true;
        await context.receipts!.save(candidate);
        const readback = recoveryReceipt(await context.receipts!.load(), context.accountId, context.api.baseURL);
        if (JSON.stringify(candidate) !== JSON.stringify(readback)) throw new LifecycleError('receipt_storage_unconfirmed');
        if (!current()) return;
        publish({ canCheckStatus: true });
        sent = true;
        await accept(await context.api.initiate(candidate), 'initiate');
      }, () => sent);
    },
    confirmDeletion: (password: string, confirmation: string) => {
      let sent = false;
      return run(async () => {
        if (context.actionsQualified !== true || !context.onAccessDisabled || held || !recovery || state.receipt?.phase !== 'awaiting_reauthentication' || confirmation !== 'DELETE' || !password || password.length > 128) return;
        publish({ phase: 'pending', message: 'Verifying account deletion…' });
        sent = true;
        const grant = grantReceipt(await context.api.grant('account_delete', password), 'account_delete', Date.now());
        if (!current()) return;
        await accept(await context.api.confirm(recovery.requestId, grant), 'confirm');
      }, () => sent);
    },
    checkStatus: () => run(async () => {
      if (!recovery || !state.canCheckStatus) return;
      publish({ phase: 'pending', message: 'Checking deletion status…' });
      await accept(await context.api.status(recovery), 'status');
    }),
    dispose() { disposed = true; recovery = null; state = { ...state, receipt: null }; listeners.clear(); },
  };
}
export type AccountLifecycleController = ReturnType<typeof createAccountLifecycleController>;
