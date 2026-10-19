import { ApiError, formApi, type FormApi } from './client';
import type { AccountSettings } from './settings';
import { captureFirstPlanConfirmation, decodeFirstPlanReceipt, decodeStoredFirstPlanReceipt, type FirstPlanConfirmation, type FirstPlanReceipt, type StoredFirstPlanReceipt } from './firstPlan';
import type {
  Account, Capabilities, CuePreferences, Entitlements, Exercise, History, List,
  Onboarding, PerformedSet, Plan, Preferences, Profile, Stats, WorkoutSession,
} from './domain';

type Fields<T> = Omit<T, 'revision'>;
type PlanFields = Pick<Plan, 'name' | 'minutes' | 'items'>;
type CueFields = Pick<CuePreferences, 'kept' | 'rejected' | 'order' | 'replacementRequested'>;
const resource = (id: string) => encodeURIComponent(id);

/** Commands take caller-owned keys: keep the same key and payload after an unknown result. */
export class FormResources {
  constructor(public readonly api: FormApi = formApi, private readonly sessionCurrent?: () => boolean) {}

  /** Bind chained requests and retained retries to this auth intent and mounted screen lifetime. */
  boundTo(isCurrent: () => boolean): FormResources {
    const auth = this.api.captureAuthContext();
    return new FormResources(this.api, () => auth.isCurrent() && isCurrent() && (this.sessionCurrent?.() ?? true));
  }

  /** Source training stays attached to the existing bound account lifetime, including lazy module loading. */
  async sourceTraining() {
    const current = this.sessionCurrent;
    const assertCurrent = (write = false) => {
      if (!current || !current()) throw new ApiError(409, 'session_changed',
        'Source training requires the original bound account session.', write, write);
    };
    assertCurrent();
    const { createSourceTrainingResources } = await import('./sourceTrainingResources');
    assertCurrent();
    return createSourceTrainingResources((path, method, body, key) => this.request(path, method, body, key), assertCurrent);
  }

  private async request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
    const current = () => this.sessionCurrent?.() ?? true;
    const changed = (originalEffectUnknown = false) => new ApiError(409, 'session_changed',
      'The account session changed. Check the original account before repeating a change.', false, originalEffectUnknown);
    if (!current()) throw changed();
    try {
      const result = await this.api.request<T>(path, method, body, key);
      if (!current()) throw changed(method !== 'GET');
      return result;
    } catch (error) {
      if (!current()) throw changed(method !== 'GET' ||
        (error instanceof ApiError && (error.effectUnknown || error.originalEffectUnknown)));
      throw error;
    }
  }
  capabilities = () => this.request<Capabilities>('/v1/capabilities');
  account = () => this.request<Account>('/v1/me');
  settings = () => this.request<AccountSettings>('/v1/me/settings');
  profile = (current: Profile, changes: Partial<Fields<Profile>>) =>
    this.request<Profile>('/v1/me/profile', 'PATCH', { ...changes, expectedRevision: current.revision });
  preferences = (current: Preferences, changes: Partial<Fields<Preferences>>) =>
    this.request<Preferences>('/v1/me/preferences', 'PATCH', { ...changes, expectedRevision: current.revision });
  onboarding = (current: Onboarding, changes: Pick<Onboarding, 'step'> & Partial<Pick<Onboarding, 'answers' | 'preferences'>>) =>
    this.request<Onboarding>('/v1/me/onboarding', 'PATCH', { ...changes, expectedRevision: current.revision });
  completeOnboarding = (current: Onboarding, key: string) =>
    this.request<Onboarding>('/v1/me/onboarding/complete', 'POST', { expectedRevision: current.revision }, key);
  exercises = () => this.request<List<Exercise>>('/v1/exercises');
  plans = () => this.request<List<Plan>>('/v1/plans');
  createFirstPlan = async (confirmation: FirstPlanConfirmation, key: string): Promise<FirstPlanReceipt> => {
    const auth = this.api.captureAuthContext();
    const captured = captureFirstPlanConfirmation(confirmation);
    const result = await this.request<unknown>('/v1/plans/first', 'POST', captured, key);
    if (!auth.isCurrent() || !(this.sessionCurrent?.() ?? true)) throw new ApiError(409, 'session_changed',
      'The account session changed. Check the original account before repeating a change.', false, true);
    return decodeFirstPlanReceipt(result, captured);
  };
  createStoredFirstPlan = async (confirmation: FirstPlanConfirmation, key: string): Promise<StoredFirstPlanReceipt> => {
    const auth = this.api.captureAuthContext();
    const captured = captureFirstPlanConfirmation(confirmation);
    const result = await this.request<unknown>('/v1/plans/first', 'POST', captured, key);
    if (!auth.isCurrent() || !(this.sessionCurrent?.() ?? true)) throw new ApiError(409, 'session_changed',
      'The account session changed. Check the original account before repeating a change.', false, true);
    return decodeStoredFirstPlanReceipt(result, captured);
  };
  createPlan = (fields: PlanFields, key: string) => this.request<Plan>('/v1/plans', 'POST', fields, key);
  editPlan = (current: Plan, changes: Partial<PlanFields>) =>
    this.request<Plan>(`/v1/plans/${resource(current.id)}`, 'PATCH', { ...changes, expectedRevision: current.revision });
  archivePlan = (current: Plan, key: string) =>
    this.request<Plan>(`/v1/plans/${resource(current.id)}/archive`, 'POST', { expectedRevision: current.revision }, key);
  startWorkout = (plan: Plan, key: string) => this.request<WorkoutSession>('/v1/workout-sessions', 'POST',
    { planId: plan.id, expectedPlanRevision: plan.revision }, key);
  workout = (id: string) => this.request<WorkoutSession>(`/v1/workout-sessions/${resource(id)}`);
  addSet = (session: WorkoutSession, set: Pick<PerformedSet, 'occurrenceId' | 'setNumber' | 'reps' | 'weightKg'> & { status: 'draft' | 'confirmed' }, key: string) =>
    this.request<{ set: PerformedSet; sessionRevision: number }>(`/v1/workout-sessions/${resource(session.id)}/sets`, 'POST',
      { ...set, expectedRevision: session.revision }, key);
  editSet = (sessionId: string, current: PerformedSet, changes: { reps: number; weightKg: number; status: 'draft' | 'confirmed' }, key: string) =>
    this.request<{ set: PerformedSet; sessionRevision: number }>(`/v1/workout-sessions/${resource(sessionId)}/sets/${resource(current.id)}`, 'PATCH',
      { ...changes, expectedRevision: current.revision }, key);
  voidSet = (sessionId: string, current: PerformedSet, key: string) =>
    this.request<{ set: PerformedSet; sessionRevision: number }>(`/v1/workout-sessions/${resource(sessionId)}/sets/${resource(current.id)}/void`, 'POST',
      { expectedRevision: current.revision }, key);
  completeWorkout = (session: WorkoutSession, key: string) =>
    this.request<WorkoutSession>(`/v1/workout-sessions/${resource(session.id)}/complete`, 'POST', { expectedRevision: session.revision }, key);
  history = (before?: string) => this.request<History>(`/v1/history${before ? `?before=${encodeURIComponent(before)}` : ''}`);
  stats = () => this.request<Stats>('/v1/stats');
  cues = (exerciseId: string) => this.request<CuePreferences>(`/v1/exercises/${resource(exerciseId)}/cue-preferences`);
  saveCues = (current: CuePreferences, changes: CueFields) => this.request<CuePreferences>(
    `/v1/exercises/${resource(current.exerciseId)}/cue-preferences`, 'PATCH', { ...changes, expectedRevision: current.revision });
  entitlements = () => this.request<Entitlements>('/v1/entitlements');
  redeem = (code: string, key: string) => this.request<{ grant: Omit<Entitlements['grants'][number], 'active'>; charged: false }>(
    '/v1/promo-redemptions', 'POST', { code }, key);
}

export const formResources = new FormResources();
