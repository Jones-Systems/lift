import { decodeStoredFirstPlanReceipt, type StoredFirstPlanReceipt } from '../api/firstPlan';
import type { Plan, SourcePlan, StoredPlan } from '../api/domain';
import { ApiError } from '../api/transport';
import type { FormResources } from '../api/resources';
import type { ContextConfirmationResult, ContextConfirmationScope } from './contextConfirmation';

export type SavedFirstPlanOpenResult = Readonly<{ status: 'opened' | 'stale' }> | Readonly<{
  status: 'unavailable'; reason: 'read_failed' | 'invalid_readback' | 'plan_missing' | 'plan_changed' | 'plan_archived';
}>;
export type SavedFirstPlanDestination = Readonly<{ openSavedPlan(): Promise<SavedFirstPlanOpenResult> }>;
export type SavedFirstPlanDestinationOptions = Readonly<{
  saved: ContextConfirmationResult;
  resources: FormResources;
  scope: ContextConfirmationScope;
  /** Synchronously adopts the verified plan before navigation; false means the original session was lost. */
  adoptAndOpen(plan: Plan): boolean;
  /** Source plans require their own destination; the legacy editor cannot adopt this representation. */
  adoptSourceAndOpen?(plan: SourcePlan): boolean;
}>;
function copy(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw Error('invalid_readback');
  const list = Array.isArray(value), keys = Reflect.ownKeys(value);
  if (Object.getPrototypeOf(value) !== (list ? Array.prototype : Object.prototype) || keys.some(key => typeof key !== 'string')) throw Error('invalid_readback');
  if (list && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(String(key)) || Number(key) >= value.length)))) throw Error('invalid_readback');
  const result: unknown[] | Record<string, unknown> = list ? [] : {};
  ancestors.add(value);
  for (const key of keys) {
    if (list && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) throw Error('invalid_readback');
    Object.defineProperty(result, key, { value: copy(descriptor.value, ancestors), enumerable: true });
  }
  ancestors.delete(value);
  return Object.freeze(result);
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) &&
    equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
export function createSavedFirstPlanDestination(options: SavedFirstPlanDestinationOptions): SavedFirstPlanDestination | null {
  const { saved, resources, scope, adoptAndOpen, adoptSourceAndOpen } = options;
  if (saved.snapshot.status !== 'saved' || saved.snapshot.effect !== 'confirmed' || !saved.receipt) return null;
  let receipt: StoredFirstPlanReceipt;
  try {
    const original = copy(saved.receipt) as StoredFirstPlanReceipt;
    const validated = decodeStoredFirstPlanReceipt(original, { profileRevision: original.provenance.profileRevision, preferencesRevision: original.provenance.preferencesRevision });
    if (!equal(original, validated)) return null;
    receipt = original;
  } catch { return null; }
  const source = 'schema' in receipt.plan;
  if (source && typeof adoptSourceAndOpen !== 'function') return null;
  const api = resources.api, auth = scope.originalAuth, isCurrentSession = scope.isCurrentSession;
  const binding = Object.freeze({ resources, accountId: scope.accountId, sessionGeneration: scope.sessionGeneration });
  const plans = resources.plans.bind(resources);
  const sourceTraining = source ? resources.sourceTraining.bind(resources) : undefined;
  let expired = false, pending: Promise<SavedFirstPlanOpenResult> | undefined;
  function current(): boolean {
    try {
      if (!binding.accountId || !binding.sessionGeneration || options.resources !== resources || resources.api !== api || options.scope !== scope ||
        scope.accountId !== binding.accountId || scope.sessionGeneration !== binding.sessionGeneration ||
        auth.isCurrent() !== true || isCurrentSession(binding) !== true) expired = true;
    } catch { expired = true; }
    return !expired;
  }
  const stale = (): SavedFirstPlanOpenResult => Object.freeze({ status: 'stale' });
  const unavailable = (reason: Extract<SavedFirstPlanOpenResult, { status: 'unavailable' }>['reason']): SavedFirstPlanOpenResult =>
    current() ? Object.freeze({ status: 'unavailable', reason }) : stale();
  return Object.freeze({ openSavedPlan(): Promise<SavedFirstPlanOpenResult> {
    if (!current()) return Promise.resolve(stale());
    if (pending) return pending;
    const task = Promise.resolve().then(async (): Promise<SavedFirstPlanOpenResult> => {
      if (!current()) return stale();
      let raw: unknown;
      try {
        if (sourceTraining) {
          const training = await sourceTraining();
          if (!current()) return stale();
          raw = await training.plans();
        } else raw = await plans();
      } catch (error) {
        return current() ? unavailable(error instanceof ApiError && error.code === 'training_response_invalid'
          ? 'invalid_readback' : 'read_failed') : stale();
      }
      if (!current()) return stale();
      let verified: StoredPlan;
      try {
        const page = copy(raw) as { items?: unknown };
        if (!page || Object.keys(page).length !== 1 || !Object.hasOwn(page, 'items') || !Array.isArray(page.items)) return unavailable('invalid_readback');
        const entries = page.items.map(plan => {
          const validated = decodeStoredFirstPlanReceipt({ plan, provenance: receipt.provenance }, { profileRevision: receipt.provenance.profileRevision, preferencesRevision: receipt.provenance.preferencesRevision }).plan;
          if (!equal(plan, validated)) throw Error('invalid_readback');
          return plan as StoredPlan;
        });
        if (new Set(entries.map(plan => plan.id)).size !== entries.length) return unavailable('invalid_readback');
        const match = entries.find(plan => plan.id === receipt.plan.id);
        if (!match) return unavailable('plan_missing');
        if (match.archived) return unavailable('plan_archived');
        if (!equal(match, receipt.plan)) return unavailable('plan_changed');
        verified = match;
      } catch { return current() ? unavailable('invalid_readback') : stale(); }
      if (!current()) return stale();
      try {
        const adopted = 'schema' in verified ? adoptSourceAndOpen?.(verified) : adoptAndOpen(verified);
        if (adopted !== true || !current()) return stale();
      }
      catch { return current() ? unavailable('read_failed') : stale(); }
      return Object.freeze({ status: 'opened' });
    });
    pending = task.finally(() => { pending = undefined; });
    return pending;
  } });
}
