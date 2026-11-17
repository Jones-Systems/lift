import type { Preferences, Profile } from '../../api/domain';
import type { SaveResult, SettingsEditTarget } from '../../features/contract';

export type ContextEditorTarget = Extract<SettingsEditTarget,
  'name' | 'age' | 'experience' | 'goals' | 'schedule' | 'equipment'>;
export type ProfileEdit = Partial<Pick<Profile, 'name' | 'age' | 'trainingBackground' | 'goals'>>;
export type PreferencesEdit = Partial<Pick<Preferences, 'trainingDaysPerWeek' | 'sessionMinutes' | 'equipment'>>;
export type DisplayedProfile = Readonly<Omit<Profile, 'goals'>> & { readonly goals: readonly string[] };
export type DisplayedPreferences = Readonly<Omit<Preferences, 'equipment'>> & { readonly equipment: readonly string[] };
export type ContextEditorEntry = Readonly<{
  target: ContextEditorTarget;
  accountId: string;
  profile: DisplayedProfile;
  preferences: DisplayedPreferences;
  attachment: object;
  /** Captured for this entry's account, session, resources, route and renderer generation. */
  isCurrentEditor(): boolean;
  /** Initial expectedRevision MUST be profile.revision displayed above; refuse if that baseline is unavailable.
   * Never substitute a refreshed account revision. Deny after retirement, including every returned retry.
   * Unknown retries retain the original command key, body and revision in the host. */
  saveProfileFromEntry(changes: Readonly<ProfileEdit>): Promise<SaveResult<Profile>>;
  /** Same baseline and retirement guarantees, using the displayed preferences.revision. */
  savePreferencesFromEntry(changes: Readonly<PreferencesEdit>): Promise<SaveResult<Preferences>>;
  closeFromEntry(): void;
}>;
