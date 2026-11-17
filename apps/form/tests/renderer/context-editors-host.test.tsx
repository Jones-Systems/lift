import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import App from '../../App';
import { FormRuntime } from '../../src/FormRuntime';
import type { Account, SourcePlan } from '../../src/api/domain';
import { FormResources } from '../../src/api/resources';
import { FormTransport } from '../../src/api/transport';
import { decodePlan } from '../../src/api/trainingCodec';
import type { ContextConfirmationSlotContext, SourcePlanDetailSlotContext } from '../../src/features/contract';
import type { SettingsPresentationContext } from '../../src/settings';
import type { ContextEditorEntry, ContextEditorScreenProps } from '../../src/settings/context-editors';
import type { createTrainingContextPresentation } from '../../src/integration/trainingContextPresentation';

type RuntimeProps = React.ComponentProps<typeof FormRuntime>;
type Presentation = ReturnType<typeof createTrainingContextPresentation>;
const mockEditors: ContextEditorEntry[] = [];
let mockHome: import('../../src/features/contract').HomeSlotContext | undefined;
let mockResources: FormResources | undefined;
let mockOverrides: Partial<RuntimeProps> = {};
const mockBundles: Presentation[] = [];
const mockContexts: ContextConfirmationSlotContext[] = [];
const mockDetails: SourcePlanDetailSlotContext[] = [];
const mockSettings: SettingsPresentationContext[] = [];
const mockActions = new Map<string, (() => void) | undefined>();

// Inject only the synthetic transport; every App/runtime/shell component still renders.
jest.mock('../../src/FormRuntime', () => {
  const actual = jest.requireActual<typeof import('../../src/FormRuntime')>('../../src/FormRuntime');
  return { ...actual, FormRuntime: (props: RuntimeProps) =>
    <actual.FormRuntime {...props} resources={mockResources} {...mockOverrides} /> };
});
jest.mock('../../src/features/training', () => {
  const actual = jest.requireActual<typeof import('../../src/features/training')>('../../src/features/training');
  return { ...actual, TrainingSlot(props: import('../../src/features/contract').HomeSlotContext) {
    mockHome = props; return <actual.TrainingSlot {...props} />;
  } };
});
jest.mock('../../src/settings/context-editors', () => {
  const actual = jest.requireActual<typeof import('../../src/settings/context-editors')>('../../src/settings/context-editors');
  return { ...actual, ContextEditorScreen(props: ContextEditorScreenProps) {
    mockEditors.push(props.entry); return <actual.ContextEditorScreen {...props} />;
  } };
});
jest.mock('../../src/fonts', () => ({ useFormFonts: () => true }));
jest.mock('../../src/integration/trainingContextPresentation', () => {
  const actual = jest.requireActual<typeof import('../../src/integration/trainingContextPresentation')>('../../src/integration/trainingContextPresentation');
  return { ...actual, createTrainingContextPresentation() {
    const original = actual.createTrainingContextPresentation();
    const bundle: Presentation = {
      renderContextConfirmation(ctx) { mockContexts.push(ctx); return original.renderContextConfirmation(ctx); },
      renderSourcePlanDetail(ctx) { if (!mockDetails.includes(ctx)) mockDetails.push(ctx); return original.renderSourcePlanDetail(ctx); },
    };
    mockBundles.push(bundle);
    return bundle;
  } };
});
jest.mock('../../src/settings', () => {
  const actual = jest.requireActual<typeof import('../../src/settings')>('../../src/settings');
  return { ...actual, SettingsSlot(ctx: SettingsPresentationContext) {
    mockSettings.push(ctx); return <actual.SettingsSlot {...ctx} />;
  } };
});
// Retain callbacks before Pressability; all UI primitives call through unchanged.
jest.mock('../../src/features/shared/ui', () => {
  const actual = jest.requireActual<typeof import('../../src/features/shared/ui')>('../../src/features/shared/ui');
  return { ...actual,
    PrimaryAction(props: React.ComponentProps<typeof actual.PrimaryAction>) {
      if (props.captureId) mockActions.set(props.captureId, props.onPress);
      if (props.label === 'Save changes') mockActions.set('editor-save', props.onPress);
      return <actual.PrimaryAction {...props} />;
    },
    PlainAction(props: React.ComponentProps<typeof actual.PlainAction>) {
      if (props.captureId) mockActions.set(props.captureId, props.onPress);
      return <actual.PlainAction {...props} />;
    },
    AccountRow(props: React.ComponentProps<typeof actual.AccountRow>) {
      if (props.testID) mockActions.set(props.testID, props.onPress);
      return <actual.AccountRow {...props} />;
    },
    Nav(props: React.ComponentProps<typeof actual.Nav>) {
      mockActions.set('a-back', props.onBack); return <actual.Nav {...props} />;
    },
    Sheet(props: React.ComponentProps<typeof actual.Sheet>) {
      if (props.closeTestID) mockActions.set(props.closeTestID, props.onClose);
      return <actual.Sheet {...props} />;
    },
  };
});

function action(id: string): () => void {
  const callback = mockActions.get(id);
  if (!callback) throw Error('Missing original callback: ' + id);
  return callback;
}
function lastContext() {
  const value = mockContexts.at(-1);
  if (!value) throw Error('Context not mounted');
  return value;
}
function lastSettings() {
  const value = mockSettings.at(-1);
  if (!value) throw Error('Settings not mounted');
  return value;
}
function bundle() {
  const value = mockBundles.at(-1);
  if (!value) throw Error('App presentation not created');
  return value;
}
function json(value: unknown, status = 200, headers = {}): Response {
  const response = new Response(JSON.stringify(value), { status, headers });
  response.json = async () => JSON.parse(await response.text());
  return response;
}
const pendingCleanup: (() => void)[] = [];
function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  pendingCleanup.push(() => resolve(json({ error: { code: 'unavailable', message: 'Synthetic cleanup' } }, 503)));
  return { promise, resolve };
}
function account(): Account {
  return { accountId: 'original', appAccountToken: 'synthetic-app-token',
    onboarding: { revision: 1, step: 'review', status: 'completed', answers: {}, preferences: {}, completedAt: null },
    profile: { revision: 4, name: 'Original name', age: null, heightCm: null, weightKg: null,
      trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 30,
      equipment: ['dumbbell'], remindersEnabled: false } };
}
function sourceReceipt() {
  const plan = decodePlan({ id: 'saved-source', name: 'Saved source plan', revision: 1, archived: false,
    createdAt: '2026-10-11T12:00:00.000Z', updatedAt: '2026-10-11T12:00:00.000Z',
    schema: 'form.source-prescription-plan/v1', origin: { kind: 'form-adaptation', id: 'synthetic-plan', revision: 'r1' },
    duration: { kind: 'estimated-range', minMinutes: 20, maxMinutes: 35 },
    items: [{ id: 'source-item', native: { exercise_id: 'native-rep', movement_pattern: 'synthetic movement', role: 'practice',
      sets: 3, rest_seconds: 45, rep_range: [6, 10], target_rir: 2, notes: ['Retained source note'] },
      registeredDomain: { exerciseId: 'domain-rep', variantId: 'variant:rep',
        identity: { repository: 'Synthetic/Source', revision: 'rev:source', path: 'retained/native.json', sha256: 'a'.repeat(64), nativeId: 'native-rep' },
        registration: { id: 'synthetic-registration', revision: 'r1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
      load: { kind: 'unspecified', basis: 'unknown' } }] });
  if (!('schema' in plan)) throw Error('Expected source fixture');
  return { plan, provenance: { schema: 'form.first-plan-provenance/v1', contextKey: 'context:v1', selectedCandidateId: 'candidate',
    profileRevision: 4, preferencesRevision: 7, sources: [{ id: 'source', revision: 'revision' }],
    candidates: [{ id: 'candidate', status: 'eligible', gapCodes: [] }] } };
}
function fixture() {
  const saved = sourceReceipt();
  const f: { account: Account; plans: SourcePlan[];
    patch?: () => Promise<Response>; read: null | (() => Promise<Response>); post: null | (() => Promise<Response>);
    calls: { path: string; method: string; body: unknown; key: string | null; authorization: string | null }[];
  } = { account: account(), plans: [], read: null, post: null, calls: [] };
  const origin = 'https://form.renderer.invalid';
  const api = new FormTransport(origin, {
    async load() { return JSON.stringify({ version: 1, baseURL: origin, token: 'synthetic-original' }); },
    async save() {}, async clear() {},
  }, async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET', headers = new Headers(init?.headers);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    f.calls.push({ path, method, body, key: headers.get('Idempotency-Key'), authorization: headers.get('Authorization') });
    switch (path) {
      case '/api/auth/get-session': return json({ session: { id: 'synthetic-session', token: 'synthetic-original', userId: f.account.accountId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, user: { id: f.account.accountId } });
      case '/api/auth/sign-in/email': return json({}, 200, { 'set-auth-token': 'synthetic-replacement' });
      case '/v1/capabilities': return json({});
      case '/v1/me': return json(f.account);
      case '/v1/me/settings': return json({ accountId: f.account.accountId, identity: { displayName: f.account.profile.name,
        email: 'synthetic@example.invalid', signInMethods: ['emailPassword'], displayNameSource: 'formProfile', phoneNumber: null,
        emailVerified: true }, capabilities: {}, policies: {} });
      case '/v1/me/profile':
        if (f.patch) return f.patch();
        if (method !== 'PATCH') throw Error('Unexpected profile method');
        f.account = { ...f.account, profile: { ...f.account.profile, revision: 5,
          ...(body && typeof body === 'object' && 'name' in body && typeof body.name === 'string' ? { name: body.name } : {}),
          ...(body && typeof body === 'object' && 'injuryHistory' in body && typeof body.injuryHistory === 'string'
            ? { injuryHistory: body.injuryHistory } : {}) } };
        return json(f.account.profile);
      case '/v1/me/preferences':
        if (method !== 'PATCH') throw Error('Unexpected preferences method');
        f.account = { ...f.account, preferences: { ...f.account.preferences, revision: 8 } };
        return json(f.account.preferences);
      case '/v1/entitlements': return json({ accountId: f.account.accountId, grants: [], active: [] });
      case '/v1/exercises': return json({ items: [] });
      case '/v1/history': return json({ items: [], nextBefore: null });
      case '/v1/stats': return json({ confirmedSets: 0, repetitions: 0, volumeKg: 0, completedSessions: 0, byExercise: [],
        units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true });
      case '/v1/plans': return f.read ? f.read() : json({ items: f.plans });
      case '/v1/plans/first':
        if (f.post) return f.post();
        f.plans = [saved.plan];
        return json({ ...saved, provenance: { ...saved.provenance,
          profileRevision: f.account.profile.revision, preferencesRevision: f.account.preferences.revision } });
      default: throw Error('Unexpected mounted request: ' + method + ' ' + path);
    }
  });
  const resources = new FormResources(api);
  return Object.assign(f, { api, resources, saved,
    creates: () => f.calls.filter(call => call.path === '/v1/plans/first'),
    reads: () => f.calls.filter(call => call.path === '/v1/me'),
    planReads: () => f.calls.filter(call => call.path === '/v1/plans'),
    writes: () => f.calls.filter(call => call.method === 'PATCH'),
  });
}
async function mountApp(f = fixture()) {
  mockResources = f.resources;
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  const view = await render(<App />);
  await screen.findByTestId('a-entry-context-review');
  return Object.assign(f, { view });
}
async function enter() {
  await fireEvent.press(screen.getByTestId('a-entry-context-review'));
  await screen.findByTestId('context-row-name');
  return lastContext();
}
afterEach(async () => {
  await cleanup();
  await act(async () => { pendingCleanup.splice(0).forEach(finish => finish()); });
  mockEditors.length = 0; mockHome = undefined; mockResources = undefined; mockOverrides = {};
  mockBundles.length = 0; mockContexts.length = 0; mockDetails.length = 0; mockSettings.length = 0; mockActions.clear();
});


function editor() { const entry = mockEditors.at(-1); if (!entry) throw Error('Editor not mounted'); return entry; }
async function editName() {
  await enter(); await fireEvent.press(screen.getByTestId('context-row-name'));
  await screen.findByTestId('screen-context-editor'); return editor();
}
test('App mounts all six standard editors with stable entries', async () => {
  const f = await mountApp(); const ctx = await enter();
  for (const target of ['name', 'age', 'experience', 'goals', 'schedule', 'equipment'] as const) {
    if (target !== 'name') await act(async () => { await ctx.confirmation.capture(); });
    await fireEvent.press(screen.getByTestId('context-row-' + target));
    await screen.findByTestId('screen-context-editor'); const entry = editor();
    expect(entry.target).toBe(target); expect(Object.isFrozen(entry.profile.goals)).toBe(true);
    await f.view.rerender(<App />); expect(editor()).toBe(entry);
    await act(async () => { entry.closeFromEntry(); });
    await screen.findByTestId('screen-context-review'); expect(entry.isCurrentEditor()).toBe(false);
  }
});
test('shell refresh cannot rebase first save; Training return requires explicit fresh review', async () => {
  const f = await mountApp(), entry = await editName();
  f.account = { ...f.account, profile: { ...f.account.profile, revision: 9, name: 'Refreshed' } };
  await act(async () => { await mockHome!.reload(); });
  expect(editor()).toBe(entry); expect(entry.profile.revision).toBe(4);
  await fireEvent.changeText(screen.getByLabelText('Name'), 'Edited');
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  expect(f.writes().at(-1)?.body).toEqual({ name: 'Edited', expectedRevision: 4 });
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Settings' }));
  await screen.findByTestId('screen-context-review');
  const ctx = lastContext(); expect(ctx.confirmation.snapshot().status).toBe('stale');
  await act(async () => { await ctx.confirmation.capture(); });
  expect(ctx.confirmation.snapshot().status).toBe('ready');
  await fireEvent.press(screen.getByTestId('context-row-name')); await screen.findByTestId('screen-context-editor');
  expect(editor()).not.toBe(entry); expect(editor().profile.revision).toBe(5);
  await act(async () => { await entry.saveProfileFromEntry({ name: 'Retired' }); entry.closeFromEntry(); });
  expect(f.writes()).toHaveLength(1);
});
test('earlier sibling layout callback cannot dispatch or close after renderer replacement', async () => {
  const f = await mountApp(), old = await editName(); const results: unknown[] = [];
  function Earlier() { React.useLayoutEffect(() => {
    old.closeFromEntry(); void old.saveProfileFromEntry({ name: 'Retired' }).then(value => results.push(value.status));
  }, []); return null; }
  mockOverrides = { renderContextEditor: () => null, renderHome: () => <Earlier /> };
  await f.view.rerender(<App />);
  expect(results).toEqual(['failed']); expect(f.writes()).toHaveLength(0); expect(old.isCurrentEditor()).toBe(false);
});
test('same-account replacement refuses retained callbacks', async () => {
  const f = await mountApp(), old = await editName();
  await act(async () => { await f.api.signIn('synthetic@example.invalid', 'synthetic-password'); });
  await act(async () => { expect((await old.saveProfileFromEntry({ name: 'Retired' })).status).toBe('failed'); old.closeFromEntry(); });
  expect(f.writes()).toHaveLength(0);
});
test('pending and unknown fence navigation; original retry preserves the entire request', async () => {
  const f = await mountApp(), entry = await editName(); let reject!: (error: Error) => void;
  const pending = new Promise<Response>((_resolve, no) => { reject = no; });
  pendingCleanup.push(() => reject(Error('synthetic cleanup'))); f.patch = () => pending;
  await fireEvent.changeText(screen.getByLabelText('Name'), 'Captured intent');
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  await act(async () => { entry.closeFromEntry(); mockHome!.openSettings(); });
  expect(screen.getByTestId('screen-context-editor')).toBeTruthy();
  await act(async () => { reject(Error('synthetic lost response')); });
  await screen.findByRole('button', { name: 'Try again' });
  const retry = screen.getByRole('button', { name: 'Try again' }).props.onPress;
  await act(async () => { entry.closeFromEntry(); mockHome!.openSettings(); });
  expect(screen.getByTestId('screen-context-editor')).toBeTruthy();
  f.account = { ...f.account, profile: { ...f.account.profile, revision: 20 } };
  await act(async () => { await mockHome!.reload(); }); f.patch = undefined;
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(f.writes()).toHaveLength(2); expect(f.writes()[0]).toEqual(f.writes()[1]);
  await act(async () => { entry.closeFromEntry(); retry(); }); expect(f.writes()).toHaveLength(2);
});
test('Settings name row mounts the standard editor through the actual shell', async () => {
  await mountApp(); await act(async () => { mockHome!.openSettings(); });
  await screen.findByTestId('a-row-name'); await fireEvent.press(screen.getByTestId('a-row-name'));
  await screen.findByTestId('screen-context-editor'); expect(editor().target).toBe('name');
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Settings' }));
  expect(screen.getByTestId('a-row-name')).toBeTruthy();
});
