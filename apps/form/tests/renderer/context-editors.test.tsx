import React from 'react';
import { afterEach, expect, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { Preferences, Profile } from '../../src/api/domain';
import type { SaveResult } from '../../src/features/contract';
import { ContextEditorScreen } from '../../src/settings/context-editors/ContextEditorScreen';
import type { ContextEditorEntry, ContextEditorTarget, PreferencesEdit, ProfileEdit } from '../../src/settings/context-editors/contracts';

afterEach(async () => { await cleanup(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function host(target: ContextEditorTarget = 'name', response?: () => Promise<SaveResult<Profile>>) {
  let current = true; let closes = 0;
  const profile: Profile = { revision: 4, name: 'Synthetic', age: null, heightCm: null, weightKg: null,
    trainingBackground: null, goals: ['custom goal', 'strength'], injuryHistory: '' };
  const preferences: Preferences = { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short',
    loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise',
    trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['custom equipment'], remindersEnabled: false };
  let latest = { profile, preferences };
  const calls: { changes: ProfileEdit | PreferencesEdit; expectedRevision: number }[] = [];
  const entry: ContextEditorEntry = Object.freeze({ target, accountId: 'synthetic', profile, preferences, attachment: {},
    isCurrentEditor: () => current,
    saveProfileFromEntry: async (changes: Readonly<ProfileEdit>): Promise<SaveResult<Profile>> => {
      expect(current).toBe(true); calls.push({ changes, expectedRevision: profile.revision });
      return response ? response() : { status: 'saved', value: { ...latest.profile, ...changes, revision: 5 } };
    },
    savePreferencesFromEntry: async (changes: Readonly<PreferencesEdit>): Promise<SaveResult<Preferences>> => {
      expect(current).toBe(true); calls.push({ changes, expectedRevision: preferences.revision });
      return { status: 'saved', value: { ...latest.preferences, ...changes, revision: 8 } };
    }, closeFromEntry: () => { expect(current).toBe(true); closes++; } });
  return { entry, calls, profile, closes: () => closes, retire: () => { current = false; }, refresh: () => {
    latest = { profile: { ...profile, name: 'Refreshed', revision: 40 }, preferences: { ...preferences, revision: 70 } };
  } };
}

test('each of six standard editors dispatches only its intended field against the displayed revision', async () => {
  const cases: { target: ContextEditorTarget; label: string; value: string; expected: ProfileEdit | PreferencesEdit; revision: number }[] = [
    { target: 'name', label: 'Name', value: ' Edited ', expected: { name: 'Edited' }, revision: 4 },
    { target: 'age', label: 'Age, years', value: '13', expected: { age: 13 }, revision: 4 },
    { target: 'goals', label: 'Goal 2', value: 'edited goal', expected: { goals: ['custom goal', 'edited goal'] }, revision: 4 },
    { target: 'equipment', label: 'Equipment 1', value: 'edited equipment', expected: { equipment: ['edited equipment'] }, revision: 7 },
    { target: 'schedule', label: 'Session minutes', value: '45', expected: { sessionMinutes: 45 }, revision: 7 },
  ];
  for (const c of cases) {
    const h = host(c.target); const view = await render(<ContextEditorScreen entry={h.entry} attachment={h.entry.attachment} />);
    await fireEvent.changeText(screen.getByLabelText(c.label), c.value); h.refresh();
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(h.calls).toEqual([{ changes: c.expected, expectedRevision: c.revision }]);
    expect(screen.getByText('Saved.')).toBeTruthy(); await view.unmount();
  }
  const h = host('experience'); await render(<ContextEditorScreen entry={h.entry} attachment={h.entry.attachment} />);
  await fireEvent.press(screen.getByRole('radio', { name: 'Regular, most weeks' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  expect(h.calls).toEqual([{ changes: { trainingBackground: 'regular' }, expectedRevision: 4 }]);
});

test('pending blocks save/back; unknown exposes only the original retry and stale requires close/re-entry', async () => {
  const first = deferred<SaveResult<Profile>>(); let retries = 0;
  const h = host('name', () => first.promise);
  await render(<ContextEditorScreen entry={h.entry} attachment={h.entry.attachment} />);
  await fireEvent.changeText(screen.getByLabelText('Name'), 'Original');
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState.disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Back to Settings' }).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Settings' })); expect(h.closes()).toBe(0);
  await act(async () => { first.resolve({ status: 'unknown', retry: async () => {
    retries++; return { status: 'stale', latest: { ...h.profile, name: 'Latest', revision: 9 } };
  } }); });
  h.refresh(); await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(retries).toBe(1); expect(h.calls).toEqual([{ changes: { name: 'Original' }, expectedRevision: 4 }]);
  expect(screen.getByText('Latest')).toBeTruthy();
  expect(screen.getByText(/Close and re-open/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Settings' })); expect(h.closes()).toBe(1);
  expect(screen.queryByTestId('screen-context-editor')).toBeNull();
});

test('same-account new session and attachment replacement spend retained handlers and ignore late results', async () => {
  const d = deferred<SaveResult<Profile>>(); let retries = 0;
  const old = host('name', () => d.promise);
  const view = await render(<ContextEditorScreen entry={old.entry} attachment={old.entry.attachment} />);
  await fireEvent.changeText(screen.getByLabelText('Name'), 'Old');
  const retainedSave = screen.getByRole('button', { name: 'Save' }).props.onPress;
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  old.retire(); const next = host();
  await view.rerender(<ContextEditorScreen entry={next.entry} attachment={next.entry.attachment} />);
  await act(async () => {
    retainedSave(); d.resolve({ status: 'unknown', retry: async () => { retries++; return { status: 'saved', value: old.profile }; } });
  });
  expect(screen.getByLabelText('Name').props.value).toBe('Synthetic'); expect(retries).toBe(0); expect(old.calls).toHaveLength(1);
  await view.rerender(<ContextEditorScreen entry={next.entry} attachment={{}} />);
  expect(screen.queryByTestId('screen-context-editor')).toBeNull(); expect(next.calls).toHaveLength(0);
});
