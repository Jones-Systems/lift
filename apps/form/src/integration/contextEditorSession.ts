import { ApiError } from '../api/client';
import type { Account, Preferences, Profile } from '../api/domain';
import type { FormResources } from '../api/resources';
import type { SaveResult } from '../features/contract';
import { guardedSave } from '../features/shared/commands';
import type { ContextEditorEntry, ContextEditorTarget, PreferencesEdit, ProfileEdit } from '../settings/context-editors';

export function isContextEditorTarget(target: string): target is ContextEditorTarget {
  return ['name', 'age', 'experience', 'goals', 'schedule', 'equipment'].includes(target);
}

export function captureContextEditorSession(resources: FormResources, account: Account, target: ContextEditorTarget,
  scope: Readonly<{
    isCurrentEditor(): boolean;
    isCurrentSession(): boolean;
    close(): void;
    profile(value: Profile): void;
    preferences(value: Preferences): void;
  }>) {
  const profile = { ...account.profile, goals: [...account.profile.goals] };
  const preferences = { ...account.preferences, equipment: [...account.preferences.equipment] };
  const originalAuth = resources.api.captureAuthContext();
  let retired = false, busy = false, unknown = false, spent = false;
  const current = () => {
    if (!originalAuth.isCurrent() || !scope.isCurrentEditor()) retired = true;
    return !retired;
  };
  const original = resources.boundTo(current);
  const denied = <T>(): SaveResult<T> => ({ status: 'failed', error: new ApiError(409, 'session_changed',
    'This editor is no longer available. Close it and open a fresh editor.') });
  async function attempt<T>(run: () => Promise<SaveResult<T>>, adopt: (value: T) => void): Promise<SaveResult<T>> {
    if (!current() || busy) return denied();
    busy = true;
    try {
      const result = await run();
      unknown = result.status === 'unknown' || (result.status === 'failed' && result.error.originalEffectUnknown);
      if (!current()) return denied();
      if (result.status === 'saved' || result.status === 'stale') {
        spent = true;
        adopt(result.status === 'saved' ? result.value : result.latest);
      }
      if (result.status !== 'unknown') return result;
      let used = false;
      return { status: 'unknown', retry: () => {
        if (!current() || busy || used || !unknown) return Promise.resolve(denied<T>());
        used = true;
        return attempt(result.retry, adopt);
      } };
    } finally { busy = false; }
  }
  const entry: ContextEditorEntry = Object.freeze({ target, accountId: account.accountId,
    profile: Object.freeze({ ...profile, goals: Object.freeze([...profile.goals]) }),
    preferences: Object.freeze({ ...preferences, equipment: Object.freeze([...preferences.equipment]) }),
    attachment: Object.freeze({}), isCurrentEditor: current,
    saveProfileFromEntry(changes: Readonly<ProfileEdit>) {
      if (!current() || busy || unknown || spent || !Number.isInteger(profile.revision)) return Promise.resolve(denied<Profile>());
      const intent = { ...changes, ...(changes.goals ? { goals: [...changes.goals] } : {}) };
      return attempt(() => guardedSave(() => original.profile(profile, intent),
        async () => (await original.account()).profile), scope.profile);
    },
    savePreferencesFromEntry(changes: Readonly<PreferencesEdit>) {
      if (!current() || busy || unknown || spent || !Number.isInteger(preferences.revision)) return Promise.resolve(denied<Preferences>());
      const intent = { ...changes, ...(changes.equipment ? { equipment: [...changes.equipment] } : {}) };
      return attempt(() => guardedSave(() => original.preferences(preferences, intent),
        async () => (await original.account()).preferences), scope.preferences);
    },
    closeFromEntry() {
      if (!current() || busy || unknown) return;
      scope.close(); retired = true;
    },
  });
  return Object.freeze({ entry, isCurrent: current,
    navigationBlocked: () => originalAuth.isCurrent() && scope.isCurrentSession() && (busy || unknown), dispose() { retired = true; } });
}
