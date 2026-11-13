import React, { StrictMode } from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { Account } from '../../src/api/domain';
import { FormResources } from '../../src/api/resources';
import { FormTransport } from '../../src/api/transport';
import type { ContextConfirmationSlotContext } from '../../src/features/contract';
import { AccountRow, PrimaryAction } from '../../src/features/shared/ui';
import { createContextReviewRenderer } from '../../src/features/training/context-review';
import { createContextConfirmation } from '../../src/integration/contextConfirmation';
import { createSavedFirstPlanDestination } from '../../src/integration/savedFirstPlanDestination';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const pendingCleanup: (() => void)[] = [];
function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  pendingCleanup.push(() => resolve(json({ error: { code: 'unavailable', message: 'Synthetic cleanup' } }, 503)));
  return { promise, resolve };
}
function receipt() {
  return { plan: { id: 'saved-plan', name: 'Saved plan', minutes: 30, revision: 1, archived: false,
    createdAt: '2026-10-11T12:00:00.000Z', updatedAt: '2026-10-11T12:00:00.000Z',
    items: [{ id: 'item', exerciseId: 'exercise', setTarget: 3, repMin: 6, repMax: 10, targetKg: 0 }] },
    provenance: { schema: 'form.first-plan-provenance/v1', contextKey: 'context:v1', selectedCandidateId: 'candidate', profileRevision: 4, preferencesRevision: 7,
      sources: [{ id: 'source', revision: 'revision' }], candidates: [{ id: 'candidate', status: 'eligible', gapCodes: [] }] } };
}
function fixture(editable = true) {
  const value: Account = { accountId: 'synthetic', appAccountToken: 'synthetic-token',
    onboarding: { revision: 1, step: 'review', status: 'completed', answers: {}, preferences: {}, completedAt: '2026-10-11T12:00:00.000Z' },
    profile: { revision: 4, name: 'Captured name', age: null, heightCm: null, weightKg: null, trainingBackground: null,
      injuryHistory: 'A recorded limitation. '.repeat(100), goals: ['stronger', 'custom goal', 'third', 'fourth'], trainingContext: 'A long context. '.repeat(100) },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30,
      equipment: ['dumbbells', 'custom equipment'], remindersEnabled: false } };
  const f = { current: true, value, reads: 0, writes: [] as { body: unknown; key: unknown }[], planReads: 0,
    get: null as null | (() => Promise<Response>), post: null as null | (() => Promise<Response>),
    plans: null as null | (() => Promise<Response>), noDestination: false };
  const api = new FormTransport('https://form.renderer.invalid', {
    async load() { return null; }, async save() {}, async clear() {},
  }, async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/me') { f.reads++; return f.get ? f.get() : json(f.value); }
    if (path === '/v1/plans/first') {
      f.writes.push({ body: JSON.parse(String(init?.body)), key: (init?.headers as Record<string, string>)['Idempotency-Key'] });
      return f.post ? f.post() : json(receipt());
    }
    expect(path).toBe('/v1/plans'); f.planReads++; return f.plans ? f.plans() : json({ items: [receipt().plan] });
  });
  const resources = new FormResources(api), edits = jest.fn(), close = jest.fn(), opened = jest.fn();
  const scope = { accountId: 'synthetic', sessionGeneration: 'original', originalAuth: api.captureAuthContext(),
    isCurrentSession: () => f.current };
  const confirmation = createContextConfirmation({ resources, scope, newIdempotencyKey: () => 'original-key',
    ...(editable ? { openEdit: edits } : {}) });
  const destination = jest.fn((saved: Parameters<ContextConfirmationSlotContext['savedFirstPlanDestination']>[0]) => f.noDestination ? null :
    createSavedFirstPlanDestination({ saved, resources, scope, adoptAndOpen: plan => { opened(plan); return f.current; } }));
  const ctx: ContextConfirmationSlotContext = { sessionGeneration: 'original', isCurrentSession: () => f.current,
    confirmation, savedFirstPlanDestination: destination, close };
  return Object.assign(f, { ctx, confirmation, edits, close, opened, destination });
}
afterEach(async () => {
  await cleanup();
  await act(async () => { pendingCleanup.splice(0).forEach(finish => finish()); });
});
const row = (id: string) => screen.UNSAFE_getAllByType(AccountRow).find(item => item.props.testID === `context-row-${id}`)!;
async function mountReady(ctx: ContextConfirmationSlotContext, renderer = createContextReviewRenderer()) {
  await render(renderer(ctx));
  await screen.findByTestId('context-row-name');
}

test('captured values wrap in row details; unknown and fourth goals survive; only supported rows have edit actions', async () => {
  const f = fixture(), renderer = createContextReviewRenderer();
  await mountReady(f.ctx, renderer);
  expect(screen.getByText('Review your training context')).toBeTruthy();
  expect(row('name').props.detail).toBe('Captured name');
  expect(row('goals').props.detail).toBe('Get stronger\ncustom goal\nthird\nfourth');
  expect(row('equipment').props.detail).toBe('Dumbbells\ncustom equipment');
  expect(row('context').props.detail).toBe(f.value.profile.trainingContext);
  expect(row('limitations').props.detail).toBe(f.value.profile.injuryHistory);
  expect(row('context').props.onPress).toBeUndefined(); expect(row('mode').props.onPress).toBeUndefined();
  expect(row('goals').props.onPress).toEqual(expect.any(Function));
  f.value.profile.name = 'Later account value';
  await screen.rerender(renderer({ ...f.ctx }));
  expect(row('name').props.detail).toBe('Captured name'); expect(f.reads).toBe(1);
  await fireEvent.press(screen.getByTestId('context-row-goals'));
  expect(f.edits).toHaveBeenCalledWith('goals'); expect(screen.queryByTestId('context-confirm')).toBeNull();
  expect(screen.getByTestId('context-recapture')).toBeTruthy(); expect(f.reads).toBe(1);
});
test('missing, empty and unrecorded context stay distinct and an absent editor makes every row read-only', async () => {
  const f = fixture(false), renderer = createContextReviewRenderer();
  delete f.value.profile.trainingContext; f.value.profile.name = ''; f.value.profile.goals = []; f.value.preferences.equipment = [];
  await mountReady(f.ctx, renderer);
  expect(row('age').props.detail).toBe('Not shared'); expect(row('name').props.detail).toBe('Empty response');
  expect(row('context').props.detail).toBe('Not recorded'); expect(row('goals').props.detail).toBe('None recorded');
  expect(row('equipment').props.detail).toBe('None recorded');
  expect(screen.UNSAFE_getAllByType(AccountRow).every(item => item.props.onPress === undefined)).toBe(true);
});
test('loading has no confirm or edits; closing invalidates the pending capture and old Back callback', async () => {
  const f = fixture(), read = deferredResponse(); f.get = () => read.promise;
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const renderer = createContextReviewRenderer(); await render(renderer(f.ctx));
  expect(screen.getByText('Loading your training context…')).toBeTruthy();
  expect(screen.queryByTestId('context-confirm')).toBeNull(); expect(screen.queryByTestId('context-row-name')).toBeNull();
  await fireEvent.press(screen.getByTestId('a-back')); expect(f.close).toHaveBeenCalledTimes(1);
  await act(async () => { read.resolve(json(f.value)); });
  expect(f.confirmation.snapshot().status).toBe('cancelled'); expect(f.writes).toHaveLength(0);
  expect(announce).toHaveBeenCalledWith('Loading your training context…');
});
test('pending disables confirmation synchronously and removes Back/Cancel; unknown offers only original-key retry', async () => {
  const f = fixture(), write = deferredResponse(); f.post = () => write.promise;
  await mountReady(f.ctx);
  const confirm = screen.UNSAFE_getByType(PrimaryAction).props.onPress;
  await act(async () => { confirm(); confirm(); });
  expect(f.writes).toEqual([{ body: { profileRevision: 4, preferencesRevision: 7 }, key: 'original-key' }]);
  expect(screen.getByTestId('context-confirm').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  expect(screen.queryByTestId('a-back')).toBeNull(); expect(screen.queryByTestId('context-cancel')).toBeNull();
  expect(screen.queryByTestId('context-row-name')).toBeNull();
  await act(async () => { write.resolve(json({ error: { code: 'server_error', message: 'Synthetic' } }, 503)); });
  expect(screen.getByText('The save may have completed. Retry the same confirmation to check its outcome.')).toBeTruthy();
  expect(screen.queryByTestId('a-back')).toBeNull(); expect(screen.queryByTestId('context-recapture')).toBeNull();
  f.post = null; await fireEvent.press(screen.getByTestId('context-retry'));
  expect(f.writes).toHaveLength(2); expect(f.writes[1]).toEqual(f.writes[0]); expect(f.reads).toBe(1);
  expect(screen.getByText('Your plan is saved.')).toBeTruthy(); expect(screen.getByTestId('a-back')).toBeTruthy();
});
test('effect replay and actual unmount/remount retain the issued review but permanently revoke old callbacks', async () => {
  const f = fixture(), renderer = createContextReviewRenderer();
  await render(<StrictMode>{renderer(f.ctx)}</StrictMode>);
  await screen.findByTestId('context-row-name');
  const oldConfirm = screen.UNSAFE_getByType(PrimaryAction).props.onPress;
  expect(f.reads).toBe(1); await screen.unmount();
  await render(renderer(f.ctx)); expect(f.reads).toBe(1);
  await act(async () => { oldConfirm(); }); expect(f.writes).toHaveLength(0);
  await fireEvent.press(screen.getByTestId('context-confirm')); expect(f.writes).toHaveLength(1);
  await screen.unmount(); await render(renderer(f.ctx));
  expect(screen.getByText('Your plan is saved.')).toBeTruthy(); expect(f.destination).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('context-confirm')).toBeNull(); expect(f.reads).toBe(1);
});
test('an old Confirm callback cannot confirm a fresh review after editing', async () => {
  const f = fixture(), renderer = createContextReviewRenderer(); await mountReady(f.ctx, renderer);
  const oldConfirm = screen.UNSAFE_getByType(PrimaryAction).props.onPress;
  await fireEvent.press(screen.getByTestId('context-row-schedule'));
  await fireEvent.press(screen.getByTestId('context-recapture')); expect(f.reads).toBe(2);
  await screen.findByTestId('context-row-name');
  await act(async () => { oldConfirm(); }); expect(f.writes).toHaveLength(0);
  await fireEvent.press(screen.getByTestId('context-confirm')); expect(f.writes).toHaveLength(1);
});
test('late completion from a replaced session cannot display its context or replay its action in the new session', async () => {
  const old = fixture(), fresh = fixture(), renderer = createContextReviewRenderer(), read = deferredResponse();
  old.get = () => read.promise; await render(renderer(old.ctx)); old.current = false;
  fresh.value.profile.name = 'Fresh session'; await screen.rerender(renderer({ ...fresh.ctx, sessionGeneration: 'replacement' }));
  await screen.findByText('Fresh session');
  await act(async () => { read.resolve(json(old.value)); });
  expect(screen.queryByText('Captured name')).toBeNull(); expect(screen.getByText('Fresh session')).toBeTruthy();
  expect(old.writes).toHaveLength(0); expect(fresh.writes).toHaveLength(0);
});
test('session loss during a write keeps the unresolved fence and hides context when the completion arrives', async () => {
  const f = fixture(), write = deferredResponse(), renderer = createContextReviewRenderer(); f.post = () => write.promise;
  await mountReady(f.ctx, renderer); const oldConfirm = screen.UNSAFE_getByType(PrimaryAction).props.onPress;
  await fireEvent.press(screen.getByTestId('context-confirm')); f.current = false;
  await act(async () => { write.resolve(json(receipt())); });
  expect(screen.getByText('This session is no longer current. The save is unresolved; navigation remains blocked.')).toBeTruthy();
  expect(screen.queryByTestId('context-row-name')).toBeNull(); expect(screen.queryByTestId('a-back')).toBeNull();
  expect(screen.queryByTestId('context-retry')).toBeNull(); expect(screen.queryByTestId('context-open')).toBeNull();
  await act(async () => { oldConfirm(); }); expect(f.writes).toHaveLength(1); expect(f.destination).not.toHaveBeenCalled();
});
test.each([
  ['read_failed', 'Reading it failed'], ['invalid_readback', 'could not be verified'], ['plan_missing', 'missing from the current plan list'],
  ['plan_changed', 'changed since this confirmation'], ['plan_archived', 'now archived'],
] as const)('saved %s explains the readback outcome and retries reading without generating again', async (reason, message) => {
  const f = fixture(); await mountReady(f.ctx);
  await fireEvent.press(screen.getByTestId('context-confirm'));
  f.plans = async () => {
    if (reason === 'read_failed') throw Error('Synthetic read failure');
    if (reason === 'invalid_readback') return json({ items: [{}] });
    if (reason === 'plan_missing') return json({ items: [] });
    return json({ items: [{ ...receipt().plan, ...(reason === 'plan_changed' ? { revision: 2 } : { archived: true }) }] });
  };
  await fireEvent.press(screen.getByTestId('context-open'));
  expect(screen.getByText(new RegExp(message))).toBeTruthy(); expect(screen.getByText('Retry opening saved plan')).toBeTruthy();
  expect(screen.queryByTestId('context-confirm')).toBeNull(); expect(screen.queryByTestId('context-retry')).toBeNull();
  f.plans = null; await fireEvent.press(screen.getByTestId('context-open'));
  expect(f.opened).toHaveBeenCalledTimes(1); expect(f.writes).toHaveLength(1); expect(f.planReads).toBe(2);
});
test('saved null destination is open-unavailable, while unavailable creation permits Back and explicit recapture', async () => {
  const f = fixture(); f.noDestination = true; await mountReady(f.ctx);
  await fireEvent.press(screen.getByTestId('context-confirm'));
  expect(screen.getByText('Your plan is saved. Opening it is unavailable here.')).toBeTruthy();
  expect(screen.getByTestId('context-open').props.accessibilityState).toMatchObject({ disabled: true });
  expect(screen.getByTestId('a-back')).toBeTruthy(); await screen.unmount();
  const unavailable = fixture(); unavailable.post = async () => json({ error: { code: 'first_plan_unavailable', message: 'Unavailable' } }, 501);
  await mountReady(unavailable.ctx); await fireEvent.press(screen.getByTestId('context-confirm'));
  expect(screen.getByText('Training context or plan creation is unavailable. You can go back or explicitly review again.')).toBeTruthy();
  expect(screen.getByTestId('a-back')).toBeTruthy(); expect(screen.getByTestId('context-recapture')).toBeTruthy();
  expect(unavailable.reads).toBe(1); expect(unavailable.writes).toHaveLength(1);
});
