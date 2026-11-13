import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { ActivityRuntimeContext } from '../../src/FormRuntime';
import type { Account } from '../../src/api/domain';
import { FormResources } from '../../src/api/resources';
import type { ActivityCalendar, ActivityEntry, ActivityWrite, ExerciseSnapshot } from '../../src/activity/contracts';
import { createActivitySession } from '../../src/integration/activitySession';
import { createActivityRenderer } from '../../src/activity/presentation';

const exercise: ExerciseSnapshot = { ref: { source: 'global', id: 'press' }, name: 'Press', description: 'Synthetic exercise', movement: null,
  measurementType: 'repetitions', kind: 'resistance', loadApplicability: 'applicable', loadLabel: 'Weight',
  guidance: 'globalReference', cueStatus: 'globalReference', safetyAssessment: 'notEstablished' };
const calendar: ActivityCalendar = { timeZone: 'America/New_York', activationDate: '2026-11-01', revision: 1,
  calendarPolicy: 'activity-calendar-intl-v1', createdAt: '2026-11-01T05:30:00Z' };
const pendingCleanup: (() => Promise<void>)[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function account(): Account {
  return { accountId: 'synthetic-activity', appAccountToken: 'synthetic-token',
    onboarding: { revision: 1, step: 'review', answers: {}, preferences: {}, status: 'completed', completedAt: null },
    profile: { revision: 1, name: 'Synthetic', age: null, heightCm: null, weightKg: null,
      trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 1, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30,
      equipment: ['dumbbell'], remindersEnabled: false } };
}
type Call = { path: string; method: string; body?: unknown; key?: string };
function fixture(options: { calendar?: ActivityCalendar | null; calendarFailure?: boolean; pending?: ReturnType<typeof deferred<ActivityEntry>>;
  failedDetail?: boolean; mismatch?: boolean } = {}) {
  const calls: Call[] = [];
  let saved: ActivityEntry | null = null, current = true, keys = 0;
  const serverEntry = (write: ActivityWrite, revision = 1): ActivityEntry => ({ ...write, id: 'entry-one', revision, status: 'recorded',
    items: write.items.map(item => ({ ...item, snapshot: exercise })), createdAt: '2026-11-13T10:00:00Z', updatedAt: '2026-11-13T10:00:00Z' });
  const activity = createActivitySession({ sessionGeneration: 'renderer-activity-one', isCurrentSession: () => current,
    api: { async request<T>(url: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
      const path = url.split('?')[0]; calls.push({ path, method, body, key });
      let value: unknown;
      if (method === 'GET') {
        if (path.endsWith('/calendar')) {
          if (options.calendarFailure) throw { status: 503, code: 'unavailable' };
          value = options.calendar === undefined ? calendar : options.calendar;
        } else if (path.endsWith('/catalog')) value = { items: [exercise], selectionUses: ['manual', 'nativeSpeech'] };
        else if (path.endsWith('/entries')) value = { items: saved ? [saved] : [], nextCursor: null };
        else if (path.endsWith('/adherence')) value = { policyVersion: 'activity-adherence-v1', asOf: '2026-11-13T10:00:00Z', timeZone: calendar.timeZone,
          coverageStart: null, throughDate: '2026-11-12', currentPlanDays: 0, longestPlanDays: 0, satisfiedDaysInCurrentStreak: 0,
          protectedDaysInCurrentStreak: 0, monthlyAllowance: { month: '2026-11', protectedDate: null, remaining: 1 }, days: [],
          sourceGeneration: { activity: 1, projectionRevision: 1, legacyAvailable: false, legacy: [] } };
        else if (path.endsWith('/entry-one')) {
          if (options.failedDetail) throw { status: 503, code: 'unavailable' };
          value = saved;
        } else throw new Error(`Unexpected read ${url}`);
      } else if (path.endsWith('/calendar')) value = calendar;
      else if (path.endsWith('/void')) {
        if (!saved) throw new Error('No synthetic saved entry');
        value = saved = { ...saved, status: 'voided', revision: saved.revision + 1 };
      } else {
        const { expectedRevision: _expected, ...write } = body as ActivityWrite & { expectedRevision?: number };
        saved = serverEntry(write, method === 'PATCH' ? (saved?.revision ?? 0) + 1 : 1);
        value = options.pending ? await options.pending.promise : options.mismatch ? { ...saved, draftId: 'unrelated-draft' } : saved;
      }
      return value as T;
    } } }, () => `renderer-secure-key-${String(++keys).padStart(12, '0')}`);
  const close = jest.fn();
  const context: ActivityRuntimeContext = { activity, sessionGeneration: activity.sessionGeneration, isCurrentSession: () => current,
    account: account(), appMode: 'basic', resources: new FormResources(), close };
  pendingCleanup.push(() => activity.dispose());
  return { context, calls, close, expire: () => { current = false; }, receipt: () => saved!,
    writes: () => calls.filter(call => call.method !== 'GET') };
}
const renderer = createActivityRenderer();
async function mount(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  const mounted = await render(renderer(f.context));
  await act(async () => {});
  return { ...f, ...mounted };
}
async function tap(label: string) { await act(async () => { await fireEvent.press(screen.getByText(label)); }); }
async function type(label: string, value: string) { await act(async () => { await fireEvent.changeText(screen.getByLabelText(label), value); }); }
async function draft() {
  await type('Civil date (YYYY-MM-DD)', '2026-11-10'); await tap('Load date'); await tap('Log activity');
  await tap('Press'); await tap('I confirm the load is unknown');
}
afterEach(async () => {
  await cleanup();
  for (const dispose of pendingCleanup.splice(0)) await dispose();
});

test('actual controls complete Basic manual backdate/review/save/server detail/fresh correction/reviewed void', async () => {
  const f = await mount(); await draft();
  expect(f.writes()).toHaveLength(0);
  expect(screen.queryByLabelText('Exercise 1 reported set count')).toBeNull();
  await tap('Show optional details for exercise 1');
  await type('Exercise 1 reported set count', '3');
  expect(screen.queryByLabelText('Set 1 repetitions')).toBeNull();
  await tap('Review activity');
  expect(screen.getByText('Reported set count: 3')).toBeTruthy();
  expect(screen.getByText('America/New_York')).toBeTruthy(); expect(f.writes()).toHaveLength(0);
  await tap('Save activity');
  expect(screen.getByText('Entry entry-one; revision 1; status recorded')).toBeTruthy();
  expect(f.writes()[0].body).toMatchObject({ performedConfirmed: true, date: { localDate: '2026-11-10', confirmed: true } });
  const reads = f.calls.filter(call => call.path.endsWith('/entry-one') && call.method === 'GET').length;
  await tap('Correct activity');
  expect(f.calls.filter(call => call.path.endsWith('/entry-one') && call.method === 'GET')).toHaveLength(reads + 1);
  expect(screen.getByLabelText('Exercise 1 reported set count')).toBeTruthy();
  await type('Exercise 1 reported set count', '4'); await tap('Review activity'); await tap('Save activity');
  expect(screen.getByText('Entry entry-one; revision 2; status recorded')).toBeTruthy();
  await tap('Review void'); expect(f.writes()).toHaveLength(2);
  expect(screen.getByText(/does not erase data, retire an exercise/)).toBeTruthy();
  await tap('Confirm void activity');
  expect(screen.getByText('Entry entry-one; revision 3; status voided')).toBeTruthy();
  expect(screen.queryByText('Correct activity')).toBeNull();
  expect(f.calls.some(call => call.path.endsWith('/retire'))).toBe(false);
});
test('Basic disclosure exposes zero/unit/basis and observed sets; populated values survive Review Back', async () => {
  await mount(); await draft();
  await tap('Enter a known load, including zero');
  await type('Exercise 1 load value', '0'); await tap('lb'); await tap('assistance');
  await tap('Show optional details for exercise 1'); await tap('Add observed set to exercise 1');
  await type('Set 1 repetitions', '8');
  const unknowns = screen.getAllByText('I confirm the load is unknown');
  await act(async () => { await fireEvent.press(unknowns[1]); });
  await tap('Review activity');
  expect(screen.getByText(/reported value 0 lb; basis: assistance/)).toBeTruthy();
  expect(screen.getByText('Repetitions: 8')).toBeTruthy();
  await act(async () => { await fireEvent.press(screen.getByLabelText('Back to Edit draft')); });
  expect(screen.getByLabelText('Set 1 repetitions').props.value).toBe('8');
});
test('pending removes navigation/new intent controls; unknown offers only original retry and no certainty guarantee', async () => {
  const pending = deferred<ActivityEntry>(); const f = await mount({ pending });
  await draft(); await tap('Review activity');
  await act(async () => { await fireEvent.press(screen.getByText('Save activity')); });
  expect(f.writes()).toHaveLength(1);
  expect(screen.queryByTestId('a-back')).toBeNull(); expect(screen.queryByText('Log activity')).toBeNull();
  expect(screen.queryByText('Save activity')).toBeNull();
  await act(async () => { pending.reject({ status: 503, code: 'unavailable' }); });
  expect(screen.getByText('Retry original entry request')).toBeTruthy();
  expect(screen.queryByTestId('a-back')).toBeNull();
  expect(screen.queryByText(/won.t be saved twice/)).toBeNull();
});
test('failed calendar read never exposes setup; log action stays visibly disabled with a reason', async () => {
  const f = await mount({ calendarFailure: true });
  expect(screen.queryByText('Set up Activity calendar')).toBeNull();
  expect(screen.getByText('Log activity')).toBeTruthy();
  expect(screen.getByTestId('activity-log').props.accessibilityState.disabled).toBe(true);
  await act(async () => { await fireEvent.press(screen.getByTestId('activity-log')); });
  expect(f.writes()).toHaveLength(0); expect(screen.queryByText('Edit activity draft')).toBeNull();
});
test('authoritative null calendar requires zone review and explicit confirmation before logging', async () => {
  const f = await mount({ calendar: null });
  await tap('Set up Activity calendar'); await type('IANA time zone', 'America/New_York');
  expect(f.writes()).toHaveLength(0); expect(screen.queryByText('Confirm Activity calendar')).toBeNull();
  await tap('Review calendar zone'); expect(f.writes()).toHaveLength(0);
  await tap('Confirm Activity calendar'); expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]).toMatchObject({ path: '/v1/activity/calendar', body: { timeZone: 'America/New_York', confirmed: true } });
});
test('saved then failed detail read retains actual receipt and reports latest detail unavailable', async () => {
  const f = await mount({ failedDetail: true }); await draft(); await tap('Review activity'); await tap('Save activity');
  expect(screen.getByText('Saved: entry entry-one, revision 1.')).toBeTruthy();
  expect(screen.getByText('Saved; latest detail unavailable. The save receipt below is retained.')).toBeTruthy();
  expect(f.writes()).toHaveLength(1); expect(screen.queryByText('Retry original entry request')).toBeNull();
});
test('receipt mismatch is integrity-unavailable with no fabricated retry, cancel or new intent', async () => {
  const f = await mount({ mismatch: true }); await draft(); await tap('Review activity'); await tap('Save activity');
  expect(screen.getByText(/Integrity unavailable:/)).toBeTruthy(); expect(f.writes()).toHaveLength(1);
  expect(screen.queryByText(/Saved: entry/)).toBeNull(); expect(screen.queryByText('Retry original entry request')).toBeNull();
  expect(screen.queryByTestId('a-back')).toBeNull(); expect(screen.queryByText('Log activity')).toBeNull();
});
test('same-binding remount retains original unknown controller; same-account replacement cannot expose it', async () => {
  const pending = deferred<ActivityEntry>(), f = await mount({ pending });
  await draft(); await tap('Review activity');
  await act(async () => { await fireEvent.press(screen.getByText('Save activity')); });
  await f.unmount();
  const remount = await render(renderer(f.context)); await act(async () => {});
  await act(async () => { pending.reject({ status: 503 }); });
  expect(screen.getByText('Retry original entry request')).toBeTruthy(); expect(f.writes()).toHaveLength(1);
  f.expire(); const next = fixture();
  await remount.rerender(renderer(next.context)); await act(async () => {});
  expect(screen.queryByText('Retry original entry request')).toBeNull();
  expect(next.writes()).toHaveLength(0); expect(f.writes()).toHaveLength(1);
});
