import React, { StrictMode } from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { Account } from '../../src/api/domain';
import { FormResources } from '../../src/api/resources';
import { FormTransport } from '../../src/api/transport';
import type { ContextConfirmationSlotContext, HomeSlotContext, SourcePlanDetailSlotContext } from '../../src/features/contract';
import { AccountRow, PrimaryAction } from '../../src/features/shared/ui';
import { FormAccountApp } from '../../src/features/shell/FormAccountApp';
import { TrainingSlot } from '../../src/features/training/TrainingSlot';
import { TodayScreen } from '../../src/features/training/screens';
import { createSourcePlanDetailRenderer } from '../../src/features/training/source-plan-detail';
import { decodePlan } from '../../src/api/trainingCodec';
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
    if (path === '/v1/history') return json({ items: [], nextBefore: null });
    if (path === '/v1/stats') return json(emptyStats());
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
  return Object.assign(f, { ctx, confirmation, edits, close, opened, destination, resources, api });
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

function emptyStats() {
  return { confirmedSets: 0, repetitions: 0, volumeKg: 0, completedSessions: 0, byExercise: [],
    units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true };
}
function trainingEntryFixture() {
  const f = fixture(), plan = receipt().plan;
  const noop = () => {};
  const open = jest.fn<() => void>();
  const ctx: HomeSlotContext = { account: f.value, appMode: 'basic', resources: f.resources.boundTo(() => f.current),
    sessionGeneration: 'original', isCurrentSession: () => f.current, plans: [plan], activePlan: plan, storedPlans: [plan],
    exercises: [], entitlements: null, openAccount: noop, openPlans: noop, openPlan: noop, openCues: noop,
    openSettings: noop, reload: async () => {}, savedFirstPlanDestination: f.destination, openContextConfirmation: open };
  return { f, ctx, open };
}
const retainedEntry = (): (() => void) => screen.UNSAFE_getByType(TodayScreen).props.entries
  .find((entry: { testID: string }) => entry.testID === 'a-entry-context-review').onPress;

test('actual legacy Today calls its captured context opener with no source-training renderer', async () => {
  const { ctx, open } = trainingEntryFixture();
  await render(<TrainingSlot {...ctx} />);
  expect(ctx.renderSourceTraining).toBeUndefined();
  expect(screen.getByTestId('screen-today')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('a-entry-context-review'));
  expect(open).toHaveBeenCalledTimes(1);
});
test.each(['removed', 'replaced', 'session', 'owner'] as const)('actual Today retained context entry rejects %s and never replays through a replacement', async change => {
  const { ctx, open } = trainingEntryFixture(), replacement = jest.fn<() => void>();
  const view = await render(<TrainingSlot {...ctx} />);
  const old = retainedEntry();
  const next: HomeSlotContext = { ...ctx,
    ...(change === 'removed' ? { openContextConfirmation: undefined } : {}),
    ...(change === 'replaced' ? { openContextConfirmation: replacement } : {}),
    ...(change === 'session' ? { sessionGeneration: 'replacement' } : {}),
    ...(change === 'owner' ? { isCurrentSession: () => true } : {}) };
  await view.rerender(<TrainingSlot {...next} />);
  await act(async () => { old(); });
  expect(open).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled();
  await view.rerender(<TrainingSlot {...ctx} />);
  await act(async () => { old(); }); expect(open).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('a-entry-context-review'));
  expect(open).toHaveBeenCalledTimes(1);
});
test('actual Today detached entry stays invalid after remount and current-session loss blocks a live entry', async () => {
  const { f, ctx, open } = trainingEntryFixture();
  const view = await render(<TrainingSlot {...ctx} />); const old = retainedEntry();
  await view.unmount(); await render(<TrainingSlot {...ctx} />);
  await act(async () => { old(); }); expect(open).not.toHaveBeenCalled();
  f.current = false; await act(async () => { retainedEntry()(); }); expect(open).not.toHaveBeenCalled();
});

function sourceReceipt() {
  const item = (id: string, nativeId: string, repetitions: boolean) => ({ id,
    native: { exercise_id: nativeId, movement_pattern: 'synthetic movement', role: 'practice', sets: repetitions ? 3 : 1,
      rest_seconds: 45, ...(repetitions ? { rep_range: [6, 10], target_rir: 2, substituted_for: 'prior_native', notes: ['Retained source note', ''] } : {}) },
    registeredDomain: { exerciseId: 'domain_' + id, variantId: 'variant:' + id,
      identity: { repository: 'Synthetic/Source', revision: 'rev:source', path: 'retained/native.json', sha256: 'a'.repeat(64), nativeId },
      registration: { id: 'synthetic-registration', revision: 'r1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
    load: { kind: 'unspecified', basis: 'unknown' } });
  const { minutes, ...metadata } = receipt().plan;
  const plan = decodePlan({ ...metadata, schema: 'form.source-prescription-plan/v1',
    origin: { kind: 'form-adaptation', id: 'synthetic-plan', revision: 'r1' },
    duration: { kind: 'estimated-range', minMinutes: 20, maxMinutes: 35 },
    items: [item('source_rep', 'native_rep', true), item('source_practice', 'native_practice', false)] });
  if (!('schema' in plan)) throw Error('Expected a source receipt');
  return { plan, provenance: receipt().provenance };
}
async function mountSourceJourney() {
  const value = fixture().value, saved = sourceReceipt(), calls: { path: string; method: string; body: unknown; key: string | null }[] = [];
  const f = { read: null as null | (() => Promise<Response>), contexts: [] as ContextConfirmationSlotContext[],
    details: [] as SourcePlanDetailSlotContext[], receipts: [] as unknown[],
    destinations: [] as ReturnType<ContextConfirmationSlotContext['savedFirstPlanDestination']>[] };
  const origin = 'https://form.renderer.invalid';
  const api = new FormTransport(origin, {
    async load() { return JSON.stringify({ version: 1, baseURL: origin, token: 'synthetic-original' }); },
    async save() {}, async clear() {},
  }, async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get('Idempotency-Key') });
    switch (path) {
      case '/api/auth/get-session': return json({ session: { id: 'synthetic-session', token: 'synthetic-original',
        userId: value.accountId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, user: { id: value.accountId } });
      case '/api/auth/sign-in/email': return new Response('{}', { headers: { 'set-auth-token': 'synthetic-replacement' } });
      case '/v1/capabilities': return json({});
      case '/v1/me': return json(value);
      case '/v1/me/settings': return json({ accountId: value.accountId });
      case '/v1/entitlements': return json({ accountId: value.accountId, grants: [], active: [] });
      case '/v1/exercises': return json({ items: [] });
      case '/v1/history': return json({ items: [], nextBefore: null });
      case '/v1/stats': return json(emptyStats());
      case '/v1/plans': return f.read ? f.read() : json({ items: [] });
      case '/v1/plans/first': return json(saved);
      default: throw Error('Unexpected source journey request: ' + method + ' ' + path);
    }
  });
  const resources = new FormResources(api), contextRenderer = createContextReviewRenderer(), detailRenderer = createSourcePlanDetailRenderer();
  const legacyReads = jest.spyOn(FormResources.prototype, 'plans');
  const renderContext = (ctx: ContextConfirmationSlotContext) => {
    f.contexts.push(ctx);
    return contextRenderer({ ...ctx, savedFirstPlanDestination(result) {
      f.receipts.push(result.receipt);
      const destination = ctx.savedFirstPlanDestination(result);
      f.destinations.push(destination);
      return destination;
    } });
  };
  const renderDetail = (ctx: SourcePlanDetailSlotContext) => { if (!f.details.includes(ctx)) f.details.push(ctx); return detailRenderer(ctx); };
  const view = await render(<FormAccountApp resources={resources} appMode="basic" renderSettings={() => null}
    renderHome={TrainingSlot} renderContextConfirmation={renderContext} renderSourcePlanDetail={renderDetail} />);
  await screen.findByTestId('a-entry-context-review');
  await fireEvent.press(screen.getByTestId('a-entry-context-review'));
  await screen.findByTestId('context-row-name');
  const confirmation = f.contexts.at(-1)!.confirmation, generation = f.contexts.at(-1)!.sessionGeneration;
  await fireEvent.press(screen.getByTestId('context-confirm'));
  expect(screen.getByText('Your plan is saved.')).toBeTruthy();
  f.read = async () => json({ items: [saved.plan] });
  const capturedAccountReads = calls.filter(call => call.path === '/v1/me').length;
  const creates = () => calls.filter(call => call.path === '/v1/plans/first');
  const planReads = () => calls.filter(call => call.path === '/v1/plans');
  const assertNoNewCreation = (status: 'saved' | 'stale' = 'saved') => {
    expect(creates()).toHaveLength(1);
    expect(creates()[0]).toMatchObject({ method: 'POST', body: { profileRevision: 4, preferencesRevision: 7 }, key: expect.any(String) });
    expect(new Set(f.contexts.map(ctx => ctx.confirmation))).toEqual(new Set([confirmation]));
    expect(new Set(f.contexts.map(ctx => ctx.sessionGeneration))).toEqual(new Set([generation]));
    expect(f.receipts).toEqual([saved]); expect(f.destinations).toHaveLength(1);
    expect(calls.filter(call => call.path === '/v1/me')).toHaveLength(capturedAccountReads);
    expect(legacyReads).not.toHaveBeenCalled();
    expect(calls.filter(call => call.path === '/v1/workout-sessions')).toHaveLength(0);
    expect(screen.queryByTestId('screen-plan-edit')).toBeNull();
    expect(confirmation.snapshot()).toMatchObject({ status, effect: 'confirmed' });
  };
  return Object.assign(f, { api, saved, view, creates, planReads, assertNoNewCreation });
}
test('real shell source journey saves, guarded-reads, renders full source detail, closes back and explicitly reopens the same receipt', async () => {
  const f = await mountSourceJourney(), before = f.planReads().length;
  await fireEvent.press(screen.getByTestId('context-open'));
  await screen.findByTestId('screen-source-plan-detail');
  expect(f.details).toHaveLength(1);
  expect(f.details[0].plan).toEqual(f.saved.plan); expect(f.details[0].plan).not.toBe(f.saved.plan);
  expect(f.details[0].plan.schema).toBe('form.source-prescription-plan/v1');
  expect(Object.isFrozen(f.details[0].plan.items[0].native)).toBe(true);
  expect(screen.getByTestId('a-source-plan-item-1')).toHaveTextContent('Retained source note');
  const detailClose = screen.getByTestId('a-source-plan-close').props.onPress;
  await fireEvent.press(screen.getByTestId('a-source-plan-close'));
  expect(screen.getByTestId('context-open')).not.toBeDisabled();
  await fireEvent.press(screen.getByTestId('context-open'));
  await screen.findByTestId('screen-source-plan-detail');
  expect(f.details).toHaveLength(2); expect(f.details[1].plan).toEqual(f.saved.plan);
  await act(async () => { detailClose(); });
  expect(screen.getByTestId('screen-source-plan-detail')).toBeTruthy();
  expect(f.planReads()).toHaveLength(before + 2); f.assertNoNewCreation();
});
test('real source readback removes Back and guards the retained Close until completed, then normal context Back cannot re-navigate', async () => {
  const f = await mountSourceJourney(), read = deferredResponse(), before = f.planReads().length;
  const back = screen.getByTestId('a-back').props.onPress;
  const open = screen.UNSAFE_getAllByType(PrimaryAction).find(node => node.props.captureId === 'context-open')!.props.onPress;
  f.read = () => read.promise;
  await act(async () => { open(); open(); });
  expect(screen.queryByTestId('a-back')).toBeNull();
  await act(async () => { back(); });
  expect(screen.getByTestId('screen-context-review')).toBeTruthy(); expect(f.details).toHaveLength(0);
  expect(f.planReads()).toHaveLength(before + 1);
  await act(async () => { read.resolve(json({ items: [f.saved.plan] })); });
  await screen.findByTestId('screen-source-plan-detail');
  await fireEvent.press(screen.getByTestId('a-source-plan-close'));
  await fireEvent.press(screen.getByTestId('a-back'));
  await act(async () => { back(); open(); });
  expect(screen.queryByTestId('screen-context-review')).toBeNull();
  expect(screen.queryByTestId('screen-source-plan-detail')).toBeNull();
  expect(f.details).toHaveLength(1); expect(f.planReads()).toHaveLength(before + 1); f.assertNoNewCreation();
});
test('real source invalid readback explains unavailability and explicit retry only reads, preserving the original source receipt', async () => {
  const f = await mountSourceJourney(), before = f.planReads().length;
  f.read = async () => json({ items: [{ ...f.saved.plan, items: [{}] }] });
  await fireEvent.press(screen.getByTestId('context-open'));
  expect(screen.getByText('Your plan was saved. Its readback could not be verified.')).toBeTruthy();
  expect(f.details).toHaveLength(0);
  f.read = async () => json({ items: [f.saved.plan] });
  await fireEvent.press(screen.getByTestId('context-open'));
  await screen.findByTestId('screen-source-plan-detail');
  expect(f.details[0].plan).toEqual(f.saved.plan);
  expect(f.planReads()).toHaveLength(before + 2); f.assertNoNewCreation();
});
test('real shell auth replacement during source readback rejects stale navigation and retained old actions without new creation', async () => {
  const f = await mountSourceJourney(), read = deferredResponse(), before = f.planReads().length;
  f.read = () => read.promise;
  const open = screen.UNSAFE_getAllByType(PrimaryAction).find(node => node.props.captureId === 'context-open')!.props.onPress;
  const back = screen.getByTestId('a-back').props.onPress;
  await act(async () => { open(); });
  await act(async () => { await f.api.signIn('synthetic@example.invalid', 'synthetic'); });
  await act(async () => { read.resolve(json({ items: [f.saved.plan] })); open(); back(); });
  await act(async () => { expect(await f.destinations[0]!.openSavedPlan()).toEqual({ status: 'stale' }); });
  expect(f.details).toHaveLength(0); expect(screen.queryByTestId('screen-source-plan-detail')).toBeNull();
  expect(screen.queryByTestId('context-open')).toBeNull(); expect(screen.queryByTestId('context-row-name')).toBeNull();
  expect(f.planReads()).toHaveLength(before + 1); f.assertNoNewCreation('stale');
});
