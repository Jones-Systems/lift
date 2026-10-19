import type { Account, AnimationStyle, AppMode, MascotVariant, Preferences, Profile } from '../api/domain';
import type { AccountSettings } from '../api/settings';
import type { SaveResult, SettingsEditTarget, SettingsSlotContext } from '../features/contract';
import { appModeFrom } from './appMode';

export type ServerError = { status: number; code: string; message: string; effectUnknown: boolean };
export type Remote<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T; refreshing: boolean; refreshError: ServerError | null }
  | { status: 'error'; error: ServerError };
export type CommandState =
  | { status: 'idle' } | { status: 'pending' }
  | { status: 'failed'; error: ServerError }
  | { status: 'conflict'; error: ServerError }
  | { status: 'unknown'; error: ServerError };
export type AppModeControl = { value: AppMode; requested: AppMode | null; state: CommandState };
export type NotificationPermission = 'granted' | 'provisional' | 'denied' | 'undetermined' | 'unsupported';
export type SessionCommand = 'signOut' | 'revokeOtherSessions' | 'revokeAllSessions';
export type SettingsRow =
  | 'profile.name' | 'profile.age' | 'profile.body' | 'profile.background' | 'profile.goals' | 'profile.injuries'
  | 'training.plans' | 'training.schedule' | 'training.equipment' | 'training.coach' | 'training.cues'
  | 'privacy' | 'access' | 'about.sources' | 'community.privacy' | 'community.featureRequests';
/** The delivered shell context remains the public prop shape; no notification or generation port is invented. */
export type SettingsScreenProps = SettingsSlotContext;
type PreferenceChanges = Partial<Omit<Preferences, 'revision'>>;
type ProfileChanges = Partial<Omit<Profile, 'revision'>>;
type PreferenceField = keyof Omit<Preferences, 'revision' | 'appMode'>;
export type SettingsScreenEvents = {
  onSelectAppMode(mode: AppMode): void;
  onRetryAppMode(): void;
  onSetPreference<K extends PreferenceField>(field: K, value: Preferences[K]): void;
  onSetReminders(enabled: boolean): void;
  onOpenSystemSettings(): void;
  onRow(row: SettingsRow): void;
  onBodyChoice(row: 'photos' | 'derived' | 'improvement'): void;
  onSessionCommand(command: SessionCommand): void;
  onRetrySession(): void;
  onRefresh(): void;
  onBack(): void;
};

function error(code: string, message: string, effectUnknown = false): ServerError {
  return { status: 0, code, message, effectUnknown };
}
function asError(value: unknown): ServerError {
  const e = value as Partial<ServerError> | null;
  return { status: typeof e?.status === 'number' ? e.status : 0,
    code: typeof e?.code === 'string' ? e.code : 'client_error',
    message: typeof e?.message === 'string' ? e.message : 'Could not confirm this change.',
    effectUnknown: e?.effectUnknown === true };
}
/** Copy caller-owned JSON domain data recursively; the shell closure receives this one immutable intent. */
function immutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(item => immutable(item))) as T;
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = immutable(item);
    return Object.freeze(copy) as T;
  }
  return value;
}
const preferenceKeys = ['appMode', 'mascot', 'animationStyle', 'loadUnit', 'heightUnit', 'coachVoice',
  'communication', 'trainingDaysPerWeek', 'sessionMinutes', 'equipment', 'remindersEnabled'];
function validPreferences(changes: PreferenceChanges): boolean {
  const enums: Record<string, readonly unknown[]> = {
    appMode: ['basic', 'advanced'], mascot: ['scholarly', 'baby', 'buff', 'none'], animationStyle: ['short', 'long'],
    loadUnit: ['kg', 'lb'], heightUnit: ['cm', 'ft-in'], coachVoice: ['calm', 'direct', 'encouraging'],
    communication: ['concise', 'detailed'],
  };
  return Object.entries(changes).length > 0 && Object.entries(changes).every(([key, value]) => {
    if (!preferenceKeys.includes(key) || key === 'remindersEnabled') return false;
    if (enums[key]) return enums[key].includes(value);
    if (key === 'equipment') return Array.isArray(value) && value.every(item => typeof item === 'string');
    return typeof value === 'number' && Number.isFinite(value);
  });
}

export type SettingsFacts = {
  displayName: string; email: string | null; phoneSuffix: string | null;
  signInMethods: AccountSettings['identity']['signInMethods'];
  appMode: AppMode; appModeKnown: boolean;
  mascot: MascotVariant | null; animationStyle: AnimationStyle; animationStyleKnown: boolean;
  effectiveAnimationStyle: 'static' | AnimationStyle;
  notificationPermission: NotificationPermission;
  reminders: { value: boolean | null; interactive: false; description: string };
  sessionCommands: SessionCommand[];
  accountDeletion: { available: false; description: string };
  privacy: { description: string; devicePersistenceVerified: false };
  sessionLimits: string;
};

/** Pure facts: future values never become saved defaults, and absent capabilities never become actions. */
export function settingsFacts(ctx: SettingsScreenProps): SettingsFacts {
  const prefs = ctx.account.preferences;
  const settings = ctx.settings?.accountId === ctx.account.accountId ? ctx.settings : null;
  const mascot = ['scholarly', 'baby', 'buff', 'none'].includes(prefs.mascot) ? prefs.mascot : null;
  const animationStyleKnown = ['short', 'long'].includes(prefs.animationStyle);
  const commands: SessionCommand[] = ['signOut'];
  if (settings && ctx.sessionAction) {
    if (settings.capabilities?.revokeOtherSessions?.supported === true) commands.push('revokeOtherSessions');
    if (settings.capabilities?.revokeAllSessions?.supported === true) commands.push('revokeAllSessions');
  }
  return {
    displayName: settings?.identity.displayName ?? ctx.account.profile.name,
    email: settings?.identity.email ?? null,
    phoneSuffix: settings?.identity.phoneNumber?.slice(-4) ?? null,
    signInMethods: settings ? [...settings.identity.signInMethods] : [],
    appMode: appModeFrom(ctx.account), appModeKnown: ['basic', 'advanced'].includes(prefs.appMode),
    mascot, animationStyle: animationStyleKnown ? prefs.animationStyle : 'short', animationStyleKnown,
    effectiveAnimationStyle: mascot !== null && animationStyleKnown && ctx.presentation &&
      ctx.presentation.mascot === mascot && ctx.presentation.savedAnimationStyle === prefs.animationStyle &&
      ['static', 'short', 'long'].includes(ctx.presentation.effectiveAnimationStyle)
      ? ctx.presentation.effectiveAnimationStyle : 'static',
    notificationPermission: 'unsupported',
    reminders: { value: typeof prefs.remindersEnabled === 'boolean' ? prefs.remindersEnabled : null,
      interactive: false, description: settings?.policies?.reminders?.effect === 'preferenceOnly'
        ? 'Saved to your account only. Notification permission, scheduling and delivery are not verified.'
        : 'Reminder details are not available yet.' },
    sessionCommands: commands,
    accountDeletion: { available: false, description: 'Account deletion is not available yet.' },
    privacy: { description: 'Body privacy choices do not verify device persistence or data retention.',
      devicePersistenceVerified: false },
    sessionLimits: settings
      ? 'Form session actions do not claim provider logout, billing cancellation or device data erasure.'
      : 'Sign-in details are not available yet.',
  };
}

export type SettingsModelSnapshot = {
  active: boolean; account: SettingsSlotContext['account'] | null; facts: SettingsFacts | null;
  settings: Remote<AccountSettings>; busy: boolean; command: CommandState;
  appModeControl: AppModeControl;
  preferenceWrite: { field: keyof Omit<Preferences, 'revision'>; state: CommandState } | null;
  profileWrite: CommandState;
  session: { command: SessionCommand; state: CommandState } | null;
  intent: Readonly<PreferenceChanges | ProfileChanges> | null;
  canRetry: boolean; retried: boolean;
};
type Pending = {
  kind: 'preferences' | 'profile' | 'session'; generation: number;
  field?: keyof Omit<Preferences, 'revision'>; requested?: AppMode; session?: SessionCommand;
  payload: PreferenceChanges | ProfileChanges | null;
  run: () => Promise<SaveResult<Preferences | Profile | null>>;
};

/**
 * Memory-only controller. Bind reset/dispose to the shell session-key lifetime, including same-account re-sign-in.
 * update is for snapshots within ONE session; callback identity is not a generation (shell recreates scoped closures).
 * Each events() object is generation-bound. Retried writes use ONLY the shell's retained retry, never a new save.
 */
export function createSettingsController(initial: SettingsScreenProps) {
  let ctx: SettingsScreenProps | null = initial;
  let account: Account | null = immutable(initial.account);
  let generation = 0;
  let pending: Pending | null = null;
  let retry: Pending['run'] | null = null;
  let busy = false;
  let refreshing = false;
  let refreshError: ServerError | null = null;
  let command: CommandState = { status: 'idle' };
  let retried = false;
  const observers = new Set<() => void>();
  const current = (g: number) => ctx !== null && generation === g;
  const emit = () => { for (const observer of [...observers]) observer(); };
  const clear = () => {
    pending = null; retry = null; busy = false; refreshing = false; refreshError = null;
    command = { status: 'idle' }; retried = false;
  };
  function dispose() { generation++; ctx = null; account = null; clear(); emit(); observers.clear(); }
  function reset(next: SettingsScreenProps) {
    generation++; clear(); ctx = next; account = immutable(next.account); emit();
  }
  function update(next: SettingsScreenProps) {
    if (!ctx || !account) return;
    if (next.account.accountId !== ctx.account.accountId) { reset(next); return; }
    ctx = next;
    // Preserve a returned confirmed snapshot until the shell publishes that revision or a newer one.
    account = immutable({ ...next.account,
      preferences: next.account.preferences.revision >= account.preferences.revision ? next.account.preferences : account.preferences,
      profile: next.account.profile.revision >= account.profile.revision ? next.account.profile : account.profile });
    emit();
  }
  function snapshot(): SettingsModelSnapshot {
    const safeSettings = ctx && account && ctx.settings?.accountId === account.accountId ? ctx.settings : null;
    const remote: Remote<AccountSettings> = safeSettings
      ? { status: 'ready', value: immutable(safeSettings), refreshing, refreshError }
      : refreshError ? { status: 'error', error: refreshError } : { status: 'loading' };
    const result: SettingsModelSnapshot = { active: ctx !== null, account: ctx ? account : null,
      facts: ctx && account ? settingsFacts({ ...ctx, account }) : null, settings: remote, busy, command,
      appModeControl: { value: ctx ? appModeFrom(account) : 'basic', requested: command.status === 'pending' || command.status === 'unknown' ? pending?.requested ?? null : null,
        state: pending?.field === 'appMode' ? command : { status: 'idle' } },
      preferenceWrite: pending?.kind === 'preferences' && pending.field ? { field: pending.field, state: command } : null,
      profileWrite: pending?.kind === 'profile' ? command : { status: 'idle' },
      session: pending?.session ? { command: pending.session, state: command } : null,
      intent: command.status === 'pending' || command.status === 'unknown' ? pending?.payload ?? null : null, canRetry: retry !== null && !busy, retried };
    return immutable(result);
  }
  async function perform(intent: Pending, run: Pending['run'], isRetry: boolean) {
    if (!current(intent.generation) || busy) return;
    busy = true; retry = null; pending = intent; retried = isRetry; command = { status: 'pending' }; emit();
    // A subscriber can unmount/reset synchronously; do not dispatch after that invalidates this intent.
    if (!current(intent.generation)) return;
    let result: SaveResult<Preferences | Profile | null>;
    try { result = await run(); }
    catch (caught) {
      // A thrown callback gives no SaveResult retry closure. Keep uncertainty blocked until lifecycle reset.
      if (!current(intent.generation)) return;
      const failure = asError(caught);
      busy = false; command = failure.effectUnknown || failure.status === 0 || failure.status >= 500
        ? { status: 'unknown', error: { ...failure, effectUnknown: true } } : { status: 'failed', error: failure };
      emit(); return;
    }
    if (!current(intent.generation)) return;
    busy = false;
    if (result.status === 'unknown') {
      retry = result.retry; command = { status: 'unknown', error: error('effect_unknown', 'Change not confirmed. Try again sends the same intent.', true) };
    } else if (result.status === 'failed') {
      const failure = asError(result.error);
      if (failure.code === 'sessionChanged' || failure.code === 'session_changed') { dispose(); return; }
      command = failure.effectUnknown ? { status: 'unknown', error: failure } : { status: 'failed', error: failure };
    } else {
      const value = result.status === 'saved' ? result.value : result.latest;
      if (intent.kind === 'preferences' && value && account) account = immutable({ ...account, preferences: value as Preferences });
      if (intent.kind === 'profile' && value && account) account = immutable({ ...account, profile: value as Profile });
      if (result.status === 'saved' && (intent.session === 'signOut' || intent.session === 'revokeAllSessions')) {
        // Shell owns transport/sign-out/cache clearing. Only this controller's private state is discarded here.
        dispose(); return;
      }
      pending = result.status === 'saved' ? null : { ...intent, payload: null, requested: undefined };
      command = result.status === 'saved' ? { status: 'idle' }
        : { status: 'conflict', error: error('stale_revision', isRetry
          ? 'We have loaded your latest settings.' : 'Your settings changed. We have loaded the latest.') };
    }
    emit();
  }
  function available(g: number) { return current(g) && !busy && !refreshing && command.status !== 'unknown'; }
  async function savePreferences(changes: PreferenceChanges, g = generation) {
    if (!available(g) || !ctx || !validPreferences(changes)) return;
    const payload = immutable(changes);
    const save = ctx.savePreferences;
    const field = Object.keys(payload)[0] as keyof Omit<Preferences, 'revision'>;
    await perform({ kind: 'preferences', generation: g, field, payload,
      requested: payload.appMode, run: () => save(payload) }, () => save(payload), false);
  }
  async function saveProfile(changes: ProfileChanges, g = generation) {
    if (!available(g) || !ctx || Object.keys(changes).length === 0 ||
      Object.keys(changes).some(key => !['name', 'age', 'heightCm', 'weightKg', 'trainingBackground', 'trainingContext', 'injuryHistory', 'goals'].includes(key))) return;
    const payload = immutable(changes); const save = ctx.saveProfile;
    await perform({ kind: 'profile', generation: g, payload, run: () => save(payload) }, () => save(payload), false);
  }
  async function runSession(action: SessionCommand, g = generation) {
    if (!available(g) || !ctx || !settingsFacts(ctx).sessionCommands.includes(action)) return;
    const signOut = ctx.signOut; const sessionAction = ctx.sessionAction;
    const run = () => action === 'signOut' ? signOut() : sessionAction!(action);
    await perform({ kind: 'session', generation: g, session: action, payload: null, run }, run, false);
  }
  async function retryCommand(g = generation) {
    if (!current(g) || busy || !pending || !retry || command.status !== 'unknown') return;
    await perform(pending, retry, true);
  }
  async function refresh(g = generation) {
    if (!available(g) || !ctx) return;
    const reload = ctx.reload; refreshing = true; refreshError = null; emit();
    if (!current(g)) return;
    try {
      await reload();
      if (!current(g)) return;
      if (!ctx?.settings || ctx.settings.accountId !== account?.accountId)
        refreshError = error('settings_unavailable', 'Settings details are not available yet.');
    } catch (caught) { if (current(g)) refreshError = asError(caught); }
    if (current(g)) { refreshing = false; emit(); }
  }
  function events(): SettingsScreenEvents {
    const g = generation;
    const act = (work: (c: SettingsScreenProps) => void) => { if (current(g) && ctx) work(ctx); };
    const edit: Partial<Record<SettingsRow, SettingsEditTarget>> = {
      'profile.name': 'name', 'profile.age': 'age', 'profile.body': 'body', 'profile.background': 'experience',
      'profile.goals': 'goals', 'profile.injuries': 'workAround', 'training.schedule': 'schedule',
      'training.equipment': 'equipment', 'training.coach': 'coach',
    };
    return {
      onSelectAppMode: mode => { void savePreferences({ appMode: mode }, g); },
      onRetryAppMode: () => { if (pending?.field === 'appMode') void retryCommand(g); },
      onSetPreference: (field, value) => { void savePreferences({ [field]: value } as PreferenceChanges, g); },
      // The delivered slot has no notification port; the v4 reminder row is a static preference fact.
      onSetReminders: () => {},
      onOpenSystemSettings: () => act(c => c.openSystemSettings?.()),
      onRow: row => act(c => {
        const target = edit[row];
        if (target) { if (c.openEdit) c.openEdit(target); else c.openAccount(); }
        else if (row === 'training.plans') c.openPlans();
        else if (row === 'training.cues') c.openCuesIndex?.();
        else if (row === 'access') c.openAccess();
        else if (row === 'privacy') c.openBody?.();
        else if (row === 'community.privacy') c.openCommunitySettings?.();
        else if (row === 'community.featureRequests') c.openFeatureRequests?.();
      }),
      onBodyChoice: row => act(c => {
        if (!['photos', 'derived', 'improvement'].includes(row) || c.bodyPrivacy?.status !== 'ready') return;
        const value = c.bodyPrivacy[row].value.toLowerCase();
        if (value.includes('not available') || value.includes('not offered') || value.includes('unavailable')) return;
        c.openBodyChoice?.(row);
      }),
      onSessionCommand: action => { void runSession(action, g); },
      onRetrySession: () => { if (pending?.kind === 'session') void retryCommand(g); },
      onRefresh: () => { void refresh(g); },
      onBack: () => act(c => c.close()),
    };
  }
  return { snapshot, events, update, reset, dispose,
    get savePreferences() { const g = generation; return (changes: PreferenceChanges) => savePreferences(changes, g); },
    get saveProfile() { const g = generation; return (changes: ProfileChanges) => saveProfile(changes, g); },
    get runSession() { const g = generation; return (action: SessionCommand) => runSession(action, g); },
    get retry() { const g = generation; return () => retryCommand(g); },
    get refresh() { const g = generation; return () => refresh(g); },
    subscribe(observer: () => void) { observers.add(observer); return () => { observers.delete(observer); }; } };
}
