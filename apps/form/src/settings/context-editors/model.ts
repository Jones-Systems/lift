import type { Preferences, Profile } from '../../api/domain';
import type { SaveResult } from '../../features/contract';
import type { ContextEditorEntry, ContextEditorTarget, DisplayedPreferences, DisplayedProfile, PreferencesEdit, ProfileEdit } from './contracts';

export type EditorField = 'name' | 'age' | 'trainingBackground' | 'goals' |
  'trainingDaysPerWeek' | 'sessionMinutes' | 'equipment';
export type DraftValue = string | null | string[];
export type EditorDraft = Partial<Record<EditorField, DraftValue>>;
export type EditorStatus = 'idle' | 'pending' | 'unknown' | 'failed' | 'stale' | 'saved' | 'retired';
export type ContextEditorSnapshot = Readonly<{
  target: ContextEditorTarget; status: EditorStatus; draft: EditorDraft;
  intent: Readonly<ProfileEdit | PreferencesEdit> | null;
  message: string | null; canSave: boolean; canRetry: boolean; blocked: boolean;
}>;
const fields: Record<ContextEditorTarget, readonly EditorField[]> = {
  name: ['name'], age: ['age'], experience: ['trainingBackground'], goals: ['goals'],
  schedule: ['trainingDaysPerWeek', 'sessionMinutes'], equipment: ['equipment'],
};
function immutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable)) as T;
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, immutable(item)]))) as T;
  return value;
}
function draftFrom(profile: DisplayedProfile, preferences: DisplayedPreferences): EditorDraft {
  const draft: EditorDraft = {};
  for (const field of Object.values(fields).flat()) {
    const value = field in profile ? profile[field as keyof Profile] : preferences[field as keyof Preferences];
    if (value !== undefined) draft[field] = Array.isArray(value) ? [...value] : value === null ? null : String(value);
  }
  return draft;
}
function validated(field: EditorField, value: DraftValue): DraftValue | number | undefined {
  if (field === 'goals' || field === 'equipment') {
    return Array.isArray(value) && value.length <= 30 && value.every(item => typeof item === 'string' &&
      item.trim().length >= 1 && item.trim().length <= 200) ? value.map(item => item.trim()) : undefined;
  }
  if (field === 'trainingBackground') return value === null || value === 'new' || value === 'returning' || value === 'regular' ? value : undefined;
  if (field === 'name') return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 100 ? value.trim() : undefined;
  if (field === 'age' && (value === null || value === '')) return null;
  const limits = field === 'age' ? [13, 120] : field === 'trainingDaysPerWeek' ? [1, 7] : [5, 180];
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= limits[0] && number <= limits[1] ? number : undefined;
}

/** One entry/attachment lifetime. Replacement retires this instance; it never adopts another session. */
export function createContextEditorController(entry: ContextEditorEntry, attachment: object) {
  const originalEntry = entry;
  const originalAttachment = entry.attachment;
  const isCurrentEditor = entry.isCurrentEditor;
  const saveProfile = entry.saveProfileFromEntry;
  const savePreferences = entry.savePreferencesFromEntry;
  const close = entry.closeFromEntry;
  const baseline = immutable({ target: entry.target, accountId: entry.accountId,
    profile: entry.profile, preferences: entry.preferences });
  let draft = draftFrom(baseline.profile, baseline.preferences);
  const edited = new Set<EditorField>();
  let status: EditorStatus = 'idle';
  let message: string | null = null;
  let intent: Readonly<ProfileEdit | PreferencesEdit> | null = null;
  let retry: (() => Promise<SaveResult<Profile | Preferences>>) | null = null;
  const observers = new Set<() => void>();
  const emit = () => { for (const observer of [...observers]) observer(); };
  function retire() { status = 'retired'; draft = {}; intent = null; retry = null; edited.clear(); }
  function current() {
    if (status === 'retired') return false;
    if (attachment !== originalAttachment || originalEntry.attachment !== originalAttachment || !isCurrentEditor()) {
      retire(); return false;
    }
    return true;
  }
  function changes(): ProfileEdit | PreferencesEdit | null {
    const result: Record<string, unknown> = {};
    for (const field of edited) {
      const value = validated(field, draft[field] ?? null);
      if (value === undefined) return null;
      // Unchanged list members retain their exact bytes, including unfamiliar existing values.
      result[field] = Array.isArray(value) && Array.isArray(draft[field])
        ? (draft[field] as string[]).map((item, index) => {
          const original = field === 'goals' ? baseline.profile.goals : baseline.preferences.equipment;
          return original?.includes(item) ? item : (value as string[])[index];
        }) : value;
    }
    return edited.size ? result : null;
  }
  const editable = () => current() && (status === 'idle' || status === 'failed');
  function snapshot(): ContextEditorSnapshot {
    current();
    return immutable({ target: baseline.target, status, draft, intent, message,
      canSave: (status === 'idle' || status === 'failed') && changes() !== null,
      canRetry: status === 'unknown' && retry !== null,
      blocked: !['idle', 'failed'].includes(status) });
  }
  async function perform(run: () => Promise<SaveResult<Profile | Preferences>>) {
    status = 'pending'; retry = null; message = 'Saving…'; emit();
    if (!current()) { emit(); return; }
    let result: SaveResult<Profile | Preferences>;
    try { result = await run(); }
    catch { if (current()) { status = 'unknown'; message = "We couldn't confirm the change."; emit(); } return; }
    if (!current()) { emit(); return; }
    if (result.status === 'unknown') {
      status = 'unknown'; retry = result.retry; message = "We couldn't confirm the change. Try again sends the same change.";
    } else if (result.status === 'failed') {
      if (result.error.code === 'session_changed' || result.error.code === 'sessionChanged') retire();
      else { status = result.error.effectUnknown ? 'unknown' : 'failed'; message = result.error.message; }
    } else {
      status = result.status;
      const value = result.status === 'saved' ? result.value : result.latest;
      draft = baseline.target === 'schedule' || baseline.target === 'equipment'
        ? draftFrom(baseline.profile, value as Preferences) : draftFrom(value as Profile, baseline.preferences);
      edited.clear(); intent = null;
      message = result.status === 'saved' ? 'Saved.' : 'Your settings changed. We have loaded the latest. Close and re-open to edit.';
    }
    emit();
  }
  return {
    snapshot,
    subscribe(observer: () => void) { observers.add(observer); return () => { observers.delete(observer); }; },
    reconcile(next: ContextEditorEntry, nextAttachment: object) {
      if (next !== originalEntry || nextAttachment !== originalAttachment) retire();
      current(); emit();
    },
    edit(field: EditorField, value: DraftValue) {
      if (!editable() || !fields[baseline.target].includes(field)) return;
      draft = { ...draft, [field]: immutable(value) }; edited.add(field); message = null; emit();
    },
    async save() {
      if (!editable()) return;
      const payload = changes(); if (!payload) return;
      intent = immutable(payload);
      const captured = intent;
      await perform(() => baseline.target === 'schedule' || baseline.target === 'equipment'
        ? savePreferences(captured as PreferencesEdit) : saveProfile(captured as ProfileEdit));
    },
    async retry() {
      if (!current() || status !== 'unknown' || !retry) return;
      const originalRetry = retry;
      await perform(originalRetry);
    },
    close() {
      if (!current() || status === 'pending' || status === 'unknown') return;
      retire(); emit();
      if (originalEntry.attachment === originalAttachment && isCurrentEditor()) close();
    },
    dispose() { retire(); emit(); observers.clear(); },
  };
}
