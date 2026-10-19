export const POLICY = 'form-account-lifecycle-v1';
export const EXPORT_MAX_BYTES = 16 * 1024 * 1024;
export const SECRET = /^[A-Za-z0-9_-]{43,128}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type RecoveryReceipt = Readonly<{ accountId: string; baseURL: string; requestId: string; statusSecret: string; commandKey: string }>;
export type DeletionReceipt = Readonly<{
  requestId: string; phase: 'awaiting_reauthentication' | 'disabled_pending_purge' | 'disabled_pending_reconciliation' | 'purging' | 'pending_external';
  initiated: true; disabled: boolean; localPurged: boolean; complete: false; requestedAt: string;
  backupExpiryAt: null; billingCancellation: 'not_performed'; reauthentication: 'password_only_qualified_source';
  steps: readonly { category: string; status: string; retain_until_ms: number | null }[];
}>;
export type ExportReceipt = Readonly<{ records: readonly { category: string; value: unknown }[]; manifest: {
  schemaVersion: 'form.account-export.v1'; snapshotAtMs: number; complete: false;
  scope: { accountId: string; epoch: number }; categories: readonly { category: string; status: string; count: number }[];
  omissions: readonly unknown[]; residuals: readonly unknown[];
} }>;
export class LifecycleError extends Error {
  constructor(readonly code: string, readonly effectUnknown = false) { super(code); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LifecycleError('invalid_receipt', true);
  return value as Record<string, unknown>;
}
const statuses = ['complete', 'pending', 'unavailable', 'unknown', 'retained'];
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function availableSettings(value: unknown, accountId: string): boolean {
  const root = object(value);
  if (root.accountId !== accountId) throw new LifecycleError('account_mismatch');
  if (!root.stagedAccountLifecycle) return false;
  const c = object(root.stagedAccountLifecycle);
  return c.status === 'configured_unverified' && c.initiation === true && c.passwordActionReauthentication === true
    && c.phoneActionReauthentication === false && c.oauthActionReauthentication === false
    && c.wholeAccountDeletionComplete === false && c.exportMaxBytes === EXPORT_MAX_BYTES && c.billingCancellation === 'not_performed';
}
export function recoveryReceipt(value: unknown, accountId: string, baseURL: string): RecoveryReceipt {
  const r = object(value);
  if (r.accountId !== accountId || r.baseURL !== baseURL || typeof r.requestId !== 'string' || !UUID.test(r.requestId)
    || typeof r.statusSecret !== 'string' || !SECRET.test(r.statusSecret)
    || typeof r.commandKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(r.commandKey))
    throw new LifecycleError('invalid_recovery_receipt');
  return { accountId, baseURL, requestId: r.requestId, statusSecret: r.statusSecret, commandKey: r.commandKey };
}
export function deletionReceipt(value: unknown, requestId: string): DeletionReceipt {
  const r = object(value);
  const awaiting = r.phase === 'awaiting_reauthentication';
  if (r.requestId !== requestId || !['awaiting_reauthentication', 'disabled_pending_purge', 'disabled_pending_reconciliation', 'purging', 'pending_external'].includes(String(r.phase))
    || r.initiated !== true || typeof r.disabled !== 'boolean' || r.disabled === awaiting
    || typeof r.localPurged !== 'boolean' || (r.localPurged && (awaiting || !r.disabled))
    || r.complete !== false || !date(r.requestedAt) || r.backupExpiryAt !== null
    || r.billingCancellation !== 'not_performed' || r.reauthentication !== 'password_only_qualified_source' || !Array.isArray(r.steps))
    throw new LifecycleError('invalid_deletion_receipt', true);
  const categories = new Set<string>();
  for (const raw of r.steps) {
    const step = object(raw);
    if (typeof step.category !== 'string' || !step.category || categories.has(step.category) || !statuses.includes(String(step.status))
      || !(step.retain_until_ms === null || (Number.isSafeInteger(step.retain_until_ms) && (step.retain_until_ms as number) >= 0)))
      throw new LifecycleError('invalid_deletion_receipt', true);
    categories.add(step.category);
  }
  if (!['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community'].every(c => categories.has(c)))
    throw new LifecycleError('invalid_deletion_receipt', true);
  return r as unknown as DeletionReceipt;
}
export function grantReceipt(value: unknown, purpose: 'account_export' | 'account_delete', now: number): string {
  const r = object(value);
  if (typeof r.grant !== 'string' || !SECRET.test(r.grant) || r.purpose !== purpose || r.method !== 'password'
    || !date(r.expiresAt) || Date.parse(r.expiresAt as string) <= now) throw new LifecycleError('invalid_action_grant', true);
  return r.grant;
}
export function exportReceipt(value: unknown, accountId: string): ExportReceipt {
  const r = object(value), m = object(r.manifest), scope = object(m.scope);
  if (m.schemaVersion !== 'form.account-export.v1' || m.complete !== false || scope.accountId !== accountId
    || !Number.isSafeInteger(scope.epoch) || (scope.epoch as number) < 0 || !Number.isSafeInteger(m.snapshotAtMs)
    || !Array.isArray(r.records) || !Array.isArray(m.categories) || !Array.isArray(m.omissions) || !Array.isArray(m.residuals))
    throw new LifecycleError('invalid_export_receipt', true);
  const counts = new Map<string, number>();
  for (const raw of m.categories) {
    const c = object(raw);
    if (typeof c.category !== 'string' || !c.category || counts.has(c.category) || !statuses.includes(String(c.status))
      || !Number.isSafeInteger(c.count) || (c.count as number) < 0) throw new LifecycleError('invalid_export_receipt', true);
    counts.set(c.category, c.count as number);
  }
  for (const raw of r.records) {
    const record = object(raw);
    if (typeof record.category !== 'string' || !counts.has(record.category) || !('value' in record)) throw new LifecycleError('invalid_export_receipt', true);
    counts.set(record.category, counts.get(record.category)! - 1);
    if (record.category === 'identity' && object(record.value).accountId !== accountId) throw new LifecycleError('invalid_export_receipt', true);
  }
  if ([...counts.values()].some(count => count !== 0)) throw new LifecycleError('invalid_export_receipt', true);
  return r as unknown as ExportReceipt;
}
