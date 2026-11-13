import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { ActivityRuntimeContext } from '../../src/FormRuntime';
import type { Account } from '../../src/api/domain';
import { FormResources } from '../../src/api/resources';
import type { ActivityCalendar, ActivityEntry, ActivityWrite, ExerciseSnapshot } from '../../src/activity/contracts';
import { createActivitySession } from '../../src/integration/activitySession';
import { createActivityRenderer } from '../../src/activity/presentation';
import { activityPresentation } from '../../src/activity/presentation/presentation';

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
  failedDetail?: boolean; mismatch?: 'POST' | 'PATCH' } = {}) {
  const calls: Call[] = [];
  let saved: ActivityEntry | null = null, current = true, keys = 0, mismatches = 0;
  const stored = new Map<string, ActivityEntry>();
  const receipts = new Map<string, ActivityEntry>();
  const serverEntry = (write: ActivityWrite, revision = 1, id = 'entry-one'): ActivityEntry => ({ ...write, id, revision, status: 'recorded',
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
        else if (path.endsWith('/entries')) value = { items: [...stored.values()], nextCursor: null };
        else if (path.endsWith('/adherence')) value = { policyVersion: 'activity-adherence-v1', asOf: '2026-11-13T10:00:00Z', timeZone: calendar.timeZone,
          coverageStart: null, throughDate: '2026-11-12', currentPlanDays: 0, longestPlanDays: 0, satisfiedDaysInCurrentStreak: 0,
          protectedDaysInCurrentStreak: 0, monthlyAllowance: { month: '2026-11', protectedDate: null, remaining: 1 }, days: [],
          sourceGeneration: { activity: 1, projectionRevision: 1, legacyAvailable: false, legacy: [] } };
        else if (path.startsWith('/v1/activity/entries/')) {
          if (options.failedDetail) throw { status: 503, code: 'unavailable' };
          value = stored.get(path.split('/').at(-1)!);
        } else throw new Error(`Unexpected read ${url}`);
      } else if (path.endsWith('/calendar')) value = calendar;
      else if (path.endsWith('/void')) {
        const id = path.split('/').at(-2)!, prior = stored.get(id);
        if (!prior) throw new Error('No synthetic saved entry');
        value = saved = { ...prior, status: 'voided', revision: prior.revision + 1 }; stored.set(id, saved);
      } else {
        const { expectedRevision: _expected, ...write } = body as ActivityWrite & { expectedRevision?: number };
        const id = method === 'PATCH' ? path.split('/').at(-1)! : 'entry-one';
        saved = (key && receipts.get(key)) || serverEntry(write, method === 'PATCH' ? (stored.get(id)?.revision ?? 0) + 1 : 1, id);
        if (key) receipts.set(key, saved);
        value = options.pending ? await options.pending.promise
          : options.mismatch === method && mismatches++ === 0 ? { ...saved, draftId: 'unrelated-draft' } : saved;
        stored.set(id, saved);
      }
      return value as T;
    } } }, () => `renderer-secure-key-${String(++keys).padStart(12, '0')}`);
  const close = jest.fn();
  const context: ActivityRuntimeContext = { activity, sessionGeneration: activity.sessionGeneration, isCurrentSession: () => current,
    account: account(), appMode: 'basic', resources: new FormResources(), close };
  pendingCleanup.push(() => activity.dispose());
  return { context, calls, close, seed: (entry: ActivityEntry) => stored.set(entry.id, entry), keyCount: () => keys, expire: () => { current = false; }, receipt: () => saved!,
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
test.each([false, true])('malformed receipt retains original controller unknown custody and exact retry confirms once (edit=%s)', async correction => {
  const f = await mount({ mismatch: correction ? 'PATCH' : 'POST' }); await draft(); await tap('Review activity');
  if (correction) { await tap('Save activity'); await tap('Correct activity'); await tap('Review activity'); }
  const controller = f.context.activity.controller;
  const issuedTarget = controller.getState().editTarget;
  expect(issuedTarget).toEqual(correction ? { id: 'entry-one', expectedRevision: 1 } : null);
  let confirmations = 0, previousPhase = controller.getState().phase;
  const subscription = controller.subscribe(state => {
    if (state.phase === 'saved' && previousPhase !== 'saved') confirmations += 1;
    previousPhase = state.phase;
  });
  await tap('Save activity');
  const original = f.writes().at(-1)!;
  const originalBody = JSON.stringify(original.body);
  const pending = controller.getState().pending!;
  expect(f.writes()).toHaveLength(correction ? 2 : 1);
  expect(controller.getState()).toMatchObject({ phase: 'unknown', saved: null,
    error: { code: 'activity_receipt_unconfirmed', originalEffectUnknown: true } });
  expect(pending.key).toBe(original.key); expect(pending.target).toEqual(issuedTarget);
  expect(original.body).toEqual(correction ? { ...pending.payload, expectedRevision: issuedTarget!.expectedRevision } : pending.payload);
  expect(screen.getByText('Retry original entry request')).toBeTruthy();
  expect(screen.queryByText(/Integrity unavailable:/)).toBeNull(); expect(screen.queryByText(/Saved: entry/)).toBeNull();
  expect(screen.queryByTestId('a-back')).toBeNull(); expect(screen.queryByText('Log activity')).toBeNull();
  expect(screen.queryByText('Save activity')).toBeNull(); expect(screen.queryByText('Correct activity')).toBeNull();
  expect(confirmations).toBe(0); expect(f.close).not.toHaveBeenCalled();
  const writes = f.writes().length, keys = f.keyCount();
  await f.unmount(); const remount = await render(renderer(f.context)); await act(async () => {});
  expect(controller.getState().pending).toEqual(pending); expect(screen.getByText('Retry original entry request')).toBeTruthy();
  await tap('Retry original entry request');
  expect(f.writes()).toHaveLength(writes + 1); expect(f.writes().at(-1)).toEqual(original); expect(f.keyCount()).toBe(keys);
  expect(JSON.stringify(f.writes().at(-1)!.body)).toBe(originalBody);
  expect(controller.getState()).toMatchObject({ phase: 'saved', pending: null });
  expect(controller.getState().saved).toEqual(f.receipt());
  expect(screen.getByText(`Entry entry-one; revision ${correction ? 2 : 1}; status recorded`)).toBeTruthy();
  expect(screen.queryByText('Retry original entry request')).toBeNull(); expect(confirmations).toBe(1);
  await expect(controller.retryUnknown()).rejects.toThrow('unknown_retry_unavailable');
  expect(f.writes()).toHaveLength(writes + 1); expect(confirmations).toBe(1);
  subscription.remove(); await remount.unmount();
});
test('real renderer reattachment keeps distinct B detail, confirmable B void review and a later A correction editor', async () => {
  const f = await mount(); await draft(); await tap('Review activity'); await tap('Save activity');
  const b = { ...f.receipt(), id: 'entry-two', draftId: 'distinct-draft-two', revision: 7 }; f.seed(b);
  await act(async () => { await fireEvent.press(screen.getByLabelText('Back to Activity date')); });
  await tap('Load date');
  await act(async () => { await fireEvent.press(screen.getByTestId('activity-entry-entry-two')); });
  expect(screen.getByText('Entry entry-two; revision 7; status recorded')).toBeTruthy();
  await f.unmount(); const detailView = await render(renderer(f.context)); await act(async () => {});
  expect(screen.getByText('Entry entry-two; revision 7; status recorded')).toBeTruthy();
  expect(screen.queryByText('Entry entry-one; revision 1; status recorded')).toBeNull();
  await tap('Review void');
  expect(screen.getByText('Freshly read entry entry-two, revision 7')).toBeTruthy();
  await detailView.unmount(); const voidView = await render(renderer(f.context)); await act(async () => {});
  expect(screen.getByText('Freshly read entry entry-two, revision 7')).toBeTruthy();
  expect(screen.getByText('Confirm void activity')).toBeTruthy(); expect(f.writes()).toHaveLength(1);
  await tap('Confirm void activity');
  expect(f.writes()[1]).toMatchObject({ path: '/v1/activity/entries/entry-two/void', body: { expectedRevision: 7 } });
  expect(screen.getByText('Entry entry-two; revision 8; status voided')).toBeTruthy();
  await act(async () => { await fireEvent.press(screen.getByLabelText('Back to Activity date')); });
  await act(async () => { await fireEvent.press(screen.getByTestId('activity-entry-entry-one')); });
  await tap('Correct activity');
  const originalDraft = f.context.activity.controller.getState();
  expect(originalDraft.editTarget).toEqual({ id: 'entry-one', expectedRevision: 1 });
  await voidView.unmount(); await render(renderer(f.context)); await act(async () => {});
  expect(screen.getByText('Edit activity draft')).toBeTruthy(); expect(screen.getByText('Review activity')).toBeTruthy();
  expect(screen.queryByText('Entry entry-two; revision 8; status voided')).toBeNull();
  expect(f.context.activity.controller.getState()).toEqual(originalDraft);
  expect(activityPresentation(f.context).getSnapshot().route).toBe('editor');
  await tap('Review activity'); await tap('Save activity');
  expect(f.writes()[2]).toMatchObject({ path: '/v1/activity/entries/entry-one', method: 'PATCH', body: { expectedRevision: 1 } });
  expect(screen.getByText('Entry entry-one; revision 2; status recorded')).toBeTruthy();
});
test('actual root Back calls close; the retained detached and expired callbacks remain inert', async () => {
  const f = await mount(); const oldBack = screen.getByTestId('a-back').props.onPress;
  await f.unmount(); await render(renderer(f.context)); await act(async () => {});
  await act(async () => { oldBack(); }); expect(f.close).not.toHaveBeenCalled();
  await act(async () => { await fireEvent.press(screen.getByLabelText('Back to Today')); });
  expect(f.close).toHaveBeenCalledTimes(1);
  const expiredBack = screen.getByTestId('a-back').props.onPress; f.expire();
  await act(async () => { expiredBack(); oldBack(); }); expect(f.close).toHaveBeenCalledTimes(1);
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
