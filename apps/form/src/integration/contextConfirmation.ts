import type { Preferences, Profile } from '../api/domain';
import type { FirstPlanConfirmation, StoredFirstPlanReceipt } from '../api/firstPlan';
import type { FormResources } from '../api/resources';
import { ApiError, type AuthAttemptGuard } from '../api/transport';
import type { SettingsEditTarget } from '../features/contract';

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type ContextConfirmationStatus = 'idle' | 'loading' | 'ready' | 'pending' | 'stale' | 'unknown' | 'unavailable' | 'cancelled' | 'saved';
export type ContextConfirmationSnapshot = Readonly<{
  status: ContextConfirmationStatus;
  effect: 'none' | 'pending' | 'unknown' | 'confirmed';
  canRetry: boolean;
  canEdit: boolean;
}>;
export type ContextConfirmationBinding = Readonly<{
  resources: FormResources;
  accountId: string;
  sessionGeneration: string;
}>;
export type ContextConfirmationScope = Readonly<{
  accountId: string;
  sessionGeneration: string;
  originalAuth: AuthAttemptGuard;
  isCurrentSession(binding: ContextConfirmationBinding): boolean;
}>;
export type ContextReview = Readonly<{
  profile: DeepReadonly<Profile>;
  preferences: DeepReadonly<Preferences>;
  confirm(): Promise<ContextConfirmationResult>;
  edit(target: SettingsEditTarget): ContextConfirmationSnapshot;
  cancel(): ContextConfirmationSnapshot;
}>;
export type ContextConfirmationResult = Readonly<{
  snapshot: ContextConfirmationSnapshot;
  review?: ContextReview;
  receipt?: DeepReadonly<StoredFirstPlanReceipt>;
}>;
export type ContextConfirmationOptions = Readonly<{
  resources: FormResources;
  scope: ContextConfirmationScope | null;
  newIdempotencyKey?: () => string;
  openEdit?: (target: SettingsEditTarget) => void;
}>;

function freeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const nullableNumber = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value);
const editTargets: readonly SettingsEditTarget[] = ['name', 'age', 'body', 'experience', 'goals', 'workAround', 'schedule', 'equipment', 'coach', 'cues'];

function reviewContext(value: unknown, accountId: string): { profile: Profile; preferences: Preferences } | null {
  if (!object(value) || value.accountId !== accountId || !object(value.profile) || !object(value.preferences)) return null;
  const p = value.profile, q = value.preferences;
  if (!revision(p.revision) || typeof p.name !== 'string' || !nullableNumber(p.age) || !nullableNumber(p.heightCm) ||
    !nullableNumber(p.weightKg) || ![null, 'new', 'returning', 'regular'].includes(p.trainingBackground as null | string) ||
    typeof p.injuryHistory !== 'string' || !strings(p.goals) ||
    p.trainingContext !== undefined && typeof p.trainingContext !== 'string' ||
    !revision(q.revision) || !['basic', 'advanced'].includes(q.appMode as string) ||
    !['scholarly', 'baby', 'buff', 'none'].includes(q.mascot as string) || !['short', 'long'].includes(q.animationStyle as string) ||
    !['kg', 'lb'].includes(q.loadUnit as string) || !['cm', 'ft-in'].includes(q.heightUnit as string) ||
    !['calm', 'direct', 'encouraging'].includes(q.coachVoice as string) || !['concise', 'detailed'].includes(q.communication as string) ||
    typeof q.trainingDaysPerWeek !== 'number' || !Number.isFinite(q.trainingDaysPerWeek) ||
    typeof q.sessionMinutes !== 'number' || !Number.isFinite(q.sessionMinutes) || !strings(q.equipment) || typeof q.remindersEnabled !== 'boolean') return null;
  return {
    profile: { revision: p.revision, name: p.name, age: p.age, heightCm: p.heightCm, weightKg: p.weightKg,
      trainingBackground: p.trainingBackground, injuryHistory: p.injuryHistory, goals: [...p.goals],
      ...(p.trainingContext === undefined ? {} : { trainingContext: p.trainingContext }) } as Profile,
    preferences: { revision: q.revision, appMode: q.appMode, mascot: q.mascot, animationStyle: q.animationStyle,
      loadUnit: q.loadUnit, heightUnit: q.heightUnit, coachVoice: q.coachVoice, communication: q.communication,
      trainingDaysPerWeek: q.trainingDaysPerWeek, sessionMinutes: q.sessionMinutes, equipment: [...q.equipment],
      remindersEnabled: q.remindersEnabled } as Preferences,
  };
}

export function createContextConfirmation(options: ContextConfirmationOptions) {
  const { resources, scope, newIdempotencyKey, openEdit } = options;
  const api = resources.api;
  const binding = Object.freeze({ resources, accountId: scope?.accountId ?? '', sessionGeneration: scope?.sessionGeneration ?? '' });
  const auth = scope?.originalAuth;
  const isCurrentSession = scope?.isCurrentSession;
  const account = resources.account.bind(resources), createStoredFirstPlan = resources.createStoredFirstPlan.bind(resources);
  const configured = !!scope && !!binding.accountId && !!binding.sessionGeneration && !!auth && !!isCurrentSession && !!newIdempotencyKey;
  let disposed = false, expired = false, version = 0;
  let status: ContextConfirmationStatus = configured ? 'idle' : 'unavailable';
  let effect: ContextConfirmationSnapshot['effect'] = 'none';
  let review: ContextReview | undefined, receipt: DeepReadonly<StoredFirstPlanReceipt> | undefined;
  let command: Readonly<{ confirmation: FirstPlanConfirmation; key: string }> | undefined;
  let stickyUnknown = false;
  let pending: Promise<ContextConfirmationResult> | undefined;

  function current(): boolean {
    if (!configured || disposed || expired) return false;
    try {
      if (options.resources !== resources || resources.api !== api || options.scope !== scope ||
        scope?.accountId !== binding.accountId || scope?.sessionGeneration !== binding.sessionGeneration ||
        !auth!.isCurrent() || !isCurrentSession!(binding)) expired = true;
    } catch { expired = true; }
    return !expired;
  }
  function snapshot(): ContextConfirmationSnapshot {
    const active = current();
    return Object.freeze({ status: configured && !active ? 'stale' : status, effect,
      canRetry: active && status === 'unknown' && !pending, canEdit: active && status === 'ready' && !!openEdit && !pending });
  }
  function result(): ContextConfirmationResult {
    const state = snapshot();
    return Object.freeze({ snapshot: state, ...(state.status === 'ready' && review ? { review } : {}),
      ...(state.status === 'saved' && receipt ? { receipt } : {}) });
  }
  function obsolete(): ContextConfirmationResult {
    return Object.freeze({ snapshot: Object.freeze({ status: 'stale', effect, canRetry: false, canEdit: false }) });
  }
  function blocked(): boolean { return !!pending || effect === 'unknown' || effect === 'confirmed'; }

  function dispatch(expectedVersion: number): Promise<ContextConfirmationResult> {
    if (!current() || expectedVersion !== version) return Promise.resolve(obsolete());
    if (pending) return pending;
    if (status !== 'ready' && status !== 'unknown') return Promise.resolve(result());
    status = 'pending';
    const task = Promise.resolve().then(async () => {
      if (!current()) return result();
      if (!command) {
        let key: string;
        try { key = newIdempotencyKey!(); }
        catch { status = 'unavailable'; return result(); }
        if (!current()) return result();
        if (typeof key !== 'string' || !key.trim()) { status = 'unavailable'; return result(); }
        command = Object.freeze({ confirmation: Object.freeze({ profileRevision: review!.profile.revision,
          preferencesRevision: review!.preferences.revision }), key });
      }
      effect = 'pending';
      try {
        const delivered = await createStoredFirstPlan(command.confirmation, command.key);
        if (!current()) { stickyUnknown = true; effect = 'unknown'; return result(); }
        receipt = freeze(delivered);
        effect = 'confirmed'; status = 'saved'; review = undefined;
      } catch (error) {
        const unavailable = error instanceof ApiError && error.status === 501 && error.code === 'first_plan_unavailable';
        if (!current() || !(error instanceof ApiError) || error.originalEffectUnknown ||
          !unavailable && (error.effectUnknown || error.status >= 500)) stickyUnknown = true;
        effect = stickyUnknown ? 'unknown' : 'none';
        status = stickyUnknown ? 'unknown' : error instanceof ApiError && error.status === 501 && error.code === 'first_plan_unavailable'
          ? 'unavailable' : 'stale';
      }
      return result();
    });
    pending = task.then(() => { pending = undefined; return result(); }, () => {
      pending = undefined; stickyUnknown = true; effect = 'unknown'; status = 'unknown'; return result();
    });
    return pending;
  }

  function cancelReview(expectedVersion: number): ContextConfirmationSnapshot {
    if (!current() || expectedVersion !== version) return obsolete().snapshot;
    if (blocked() && status !== 'loading') return snapshot();
    version++; review = undefined; command = undefined; status = 'cancelled'; return snapshot();
  }
  function editReview(expectedVersion: number, target: SettingsEditTarget): ContextConfirmationSnapshot {
    if (!current() || expectedVersion !== version) return obsolete().snapshot;
    if (blocked()) return snapshot();
    if (!editTargets.includes(target) || !openEdit) { status = 'unavailable'; return snapshot(); }
    version++; review = undefined; command = undefined; status = 'stale';
    try { openEdit(target); } catch { status = 'unavailable'; }
    return snapshot();
  }
  function capture(): Promise<ContextConfirmationResult> {
    if (!current() || blocked()) return Promise.resolve(result());
    const capturedVersion = ++version;
    review = undefined; receipt = undefined; command = undefined; status = 'loading';
    const task = Promise.resolve().then(async () => {
      if (!current() || version !== capturedVersion) return;
      try {
        const loaded = await account();
        if (!current() || version !== capturedVersion) return;
        const context = reviewContext(loaded, binding.accountId);
        if (!context) { status = 'unavailable'; return; }
        review = Object.freeze({ ...freeze(context), confirm: () => dispatch(capturedVersion),
          edit: (target: SettingsEditTarget) => editReview(capturedVersion, target), cancel: () => cancelReview(capturedVersion) });
        status = 'ready';
      } catch { if (current() && version === capturedVersion) status = 'unavailable'; }
    });
    pending = task.then(() => { pending = undefined; return result(); }, () => { pending = undefined; status = 'unavailable'; return result(); });
    return pending;
  }
  return Object.freeze({ snapshot, capture, retry: () => status === 'unknown' ? dispatch(version) : Promise.resolve(result()),
    cancel: () => cancelReview(version), dispose: () => { disposed = true; review = undefined; receipt = undefined; } });
}
