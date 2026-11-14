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
import type { createTrainingContextPresentation } from '../../src/integration/trainingContextPresentation';

type RuntimeProps = React.ComponentProps<typeof FormRuntime>;
type Presentation = ReturnType<typeof createTrainingContextPresentation>;
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
    read: null | (() => Promise<Response>); post: null | (() => Promise<Response>);
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
        if (method !== 'PATCH') throw Error('Unexpected profile method');
        f.account = { ...f.account, profile: { ...f.account.profile, revision: 5,
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
  mockResources = undefined; mockOverrides = {};
  mockBundles.length = 0; mockContexts.length = 0; mockDetails.length = 0; mockSettings.length = 0; mockActions.clear();
});

test('actual App mount retains one factory and controller across rerender and close/reopen, revoking the old Confirm', async () => {
  const f = await mountApp(), ctx = await enter(), confirm = action('context-confirm'), first = bundle();
  const reads = f.reads().length;
  await f.view.rerender(<App />);
  expect(mockBundles).toEqual([first]); expect(lastContext().confirmation).toBe(ctx.confirmation);
  expect(f.reads()).toHaveLength(reads);
  await fireEvent.press(screen.getByTestId('context-cancel'));
  await screen.findByTestId('a-entry-context-review');
  await enter(); expect(lastContext().confirmation).toBe(ctx.confirmation);
  expect(f.reads()).toHaveLength(reads + 1);
  await act(async () => { confirm(); }); expect(f.creates()).toHaveLength(0);
  await fireEvent.press(screen.getByTestId('context-confirm')); expect(f.creates()).toHaveLength(1);
});

test('runtime renderer removal and replacement reattach the original pending/unknown command without recapture or new key', async () => {
  const f = await mountApp(), ctx = await enter(), write = deferredResponse(), first = bundle(), reads = f.reads().length;
  const back = action('a-back'), confirm = action('context-confirm');
  f.post = () => write.promise;
  await fireEvent.press(screen.getByTestId('context-confirm'));
  mockOverrides = { renderContextConfirmation: undefined }; await f.view.rerender(<App />);
  expect(screen.queryByTestId('screen-context-review')).toBeNull();
  await act(async () => { back(); confirm(); }); expect(f.creates()).toHaveLength(1);
  mockOverrides = { renderContextConfirmation: value => first.renderContextConfirmation(value) };
  await f.view.rerender(<App />);
  expect(lastContext().confirmation).toBe(ctx.confirmation); expect(ctx.confirmation.snapshot().effect).toBe('pending');
  expect(screen.queryByTestId('a-back')).toBeNull(); expect(f.reads()).toHaveLength(reads);
  await act(async () => { write.resolve(json({ error: { code: 'unavailable' } }, 503)); });
  expect(ctx.confirmation.snapshot().effect).toBe('unknown');
  mockOverrides = { renderContextConfirmation: undefined }; await f.view.rerender(<App />);
  mockOverrides = {}; await f.view.rerender(<App />);
  expect(lastContext().confirmation).toBe(ctx.confirmation); expect(screen.queryByTestId('a-back')).toBeNull();
  f.post = async () => json(f.saved);
  await fireEvent.press(screen.getByTestId('context-retry'));
  expect(screen.getByText('Your plan is saved.')).toBeTruthy(); expect(f.creates()).toHaveLength(2);
  expect(f.creates()[1].key).toBe(f.creates()[0].key); expect(f.creates()[1].body).toEqual(f.creates()[0].body);
  expect(f.reads()).toHaveLength(reads); expect(mockBundles).toEqual([first]);
});

test('departing App revokes its old callbacks before replacement layout effects can submit or navigate', async () => {
  const f = await mountApp(); await enter(); const confirm = action('context-confirm'), back = action('a-back');
  let layoutCalls = 0;
  function Replacement() {
    React.useLayoutEffect(() => { layoutCalls++; confirm(); back(); }, []);
    return null;
  }
  await f.view.rerender(<Replacement />);
  expect(layoutCalls).toBe(1); expect(f.creates()).toHaveLength(0);
  await f.view.rerender(<App />); await screen.findByTestId('a-entry-context-review'); await enter();
  await act(async () => { confirm(); back(); });
  expect(screen.getByTestId('screen-context-review')).toBeTruthy(); expect(f.creates()).toHaveLength(0);
});

test('replacing the context presentation revokes old Confirm before the replacement layout effect', async () => {
  const f = await mountApp(); await enter(); const confirm = action('context-confirm'), first = bundle(), reads = f.reads().length;
  let layoutCalls = 0;
  function Replacement({ ctx }: { ctx: ContextConfirmationSlotContext }) {
    React.useLayoutEffect(() => { layoutCalls++; confirm(); }, []);
    return first.renderContextConfirmation(ctx);
  }
  mockOverrides = { renderContextConfirmation: ctx => <Replacement ctx={ctx} /> };
  await f.view.rerender(<App />);
  expect(layoutCalls).toBe(1); expect(f.creates()).toHaveLength(0); expect(f.reads()).toHaveLength(reads);
  await fireEvent.press(screen.getByTestId('context-confirm')); expect(f.creates()).toHaveLength(1);
});

test.each(['height', 'limitations', 'coach'])('original-session %s edit uses an existing Settings sheet and returns to explicit fresh review', async row => {
  const f = await mountApp(), original = await enter(), confirm = action('context-confirm'), reads = f.reads().length;
  await fireEvent.press(screen.getByTestId('context-row-' + row));
  const editor = lastSettings();
  expect(editor.resources.api).toBe(f.api);
  expect(editor.account.accountId).toBe('original'); expect(original.isCurrentSession()).toBe(true);
  expect(editor.editTarget).toBe(row === 'height' ? 'body' : row === 'limitations' ? 'workAround' : 'coach');
  const save = action('editor-save');
  await act(async () => { save(); });
  await screen.findByTestId('context-recapture');
  expect(lastContext().confirmation).toBe(original.confirmation); expect(lastContext().sessionGeneration).toBe(original.sessionGeneration);
  expect(f.reads()).toHaveLength(reads); expect(f.writes()).toHaveLength(1);
  expect(f.writes()[0]).toMatchObject({ method: 'PATCH', authorization: 'Bearer synthetic-original' });
  expect(f.writes()[0].body).toMatchObject({ expectedRevision: row === 'coach' ? 7 : 4 });
  const writes = f.writes().length;
  await act(async () => { save(); confirm(); }); expect(f.writes()).toHaveLength(writes); expect(f.creates()).toHaveLength(0);
  await fireEvent.press(screen.getByTestId('context-recapture'));
  await screen.findByTestId('context-row-name'); expect(f.reads()).toHaveLength(reads + 1);
  await fireEvent.press(screen.getByTestId('context-confirm'));
  expect(f.creates()).toHaveLength(1);
  expect(f.creates()[0].body).toEqual({ profileRevision: row === 'coach' ? 4 : 5, preferencesRevision: row === 'coach' ? 8 : 7 });
});

test.each(['name', 'age', 'experience', 'goals', 'schedule', 'equipment'])('%s has precise read-only Settings fallback and no invented write', async target => {
  const f = await mountApp(), original = await enter(), reads = f.reads().length;
  await fireEvent.press(screen.getByTestId('context-row-' + target));
  expect(lastSettings().editTarget).toBe(target);
  expect(screen.getByTestId('settings-edit-unavailable')).toHaveTextContent('is read-only here. An editor is not available.');
  expect(screen.queryByText('Save changes')).toBeNull(); expect(f.writes()).toHaveLength(0);
  await fireEvent.press(screen.getByTestId('a-back'));
  expect(screen.getByTestId('context-recapture')).toBeTruthy(); expect(original.confirmation.snapshot().status).toBe('stale');
  expect(f.reads()).toHaveLength(reads); expect(f.creates()).toHaveLength(0);
});

test('replacing a Settings target revokes the original Back and write handlers without leaving a dead editor on the stack', async () => {
  const f = await mountApp(); await enter(); await fireEvent.press(screen.getByTestId('context-row-name'));
  const back = action('a-back'), originalEditor = lastSettings();
  await fireEvent.press(screen.getByTestId('a-row-coach'));
  expect(lastSettings().editTarget).toBe('coach'); expect(screen.getByTestId('a-coach-close')).toBeTruthy();
  await act(async () => { back(); await originalEditor.savePreferences({ coachVoice: 'calm' }); });
  expect(screen.getByTestId('a-coach-close')).toBeTruthy(); expect(f.writes()).toHaveLength(0);
  await fireEvent.press(screen.getByTestId('a-coach-close'));
  expect(screen.getByTestId('context-recapture')).toBeTruthy(); expect(screen.queryByTestId('screen-settings')).toBeNull();
});

test('actual App source receipt readback opens detail, returns and reopens the same saved receipt without selection', async () => {
  const f = await mountApp(), ctx = await enter(), legacy = jest.spyOn(FormResources.prototype, 'plans');
  await fireEvent.press(screen.getByTestId('context-confirm')); const reads = f.reads().length, planReads = f.planReads().length;
  expect(screen.getByText('Your plan is saved.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('context-open')); await screen.findByTestId('screen-source-plan-detail');
  expect(screen.getByTestId('a-source-plan-item-1')).toHaveTextContent('Retained source note');
  expect(screen.getByTestId('a-source-plan-select')).toBeDisabled();
  expect(screen.getByText('Plan selection is unavailable in this view.')).toBeTruthy();
  expect(mockDetails.at(-1)?.plan).toEqual(f.saved.plan); expect(screen.queryByTestId('screen-plan-edit')).toBeNull();
  const close = action('a-source-plan-close'); await act(async () => { close(); });
  await fireEvent.press(screen.getByTestId('context-open')); await screen.findByTestId('screen-source-plan-detail');
  await act(async () => { close(); }); expect(screen.getByTestId('screen-source-plan-detail')).toBeTruthy();
  expect(lastContext().confirmation).toBe(ctx.confirmation); expect(mockDetails).toHaveLength(2);
  expect(f.planReads()).toHaveLength(planReads + 2); expect(f.reads()).toHaveLength(reads); expect(f.creates()).toHaveLength(1);
  expect(f.calls.filter(call => call.path === '/v1/workout-sessions')).toHaveLength(0); expect(legacy).not.toHaveBeenCalled();
});

test('source detail removal permanently fences captured saved navigation, including after renderer restoration', async () => {
  const f = await mountApp(); await enter(); await fireEvent.press(screen.getByTestId('context-confirm'));
  mockOverrides = { renderSourcePlanDetail: undefined }; await f.view.rerender(<App />);
  await fireEvent.press(screen.getByTestId('context-open'));
  expect(screen.queryByTestId('screen-source-plan-detail')).toBeNull(); expect(f.creates()).toHaveLength(1);
  mockOverrides = {}; await f.view.rerender(<App />);
  // Renderer replacement permanently expires the captured destination; a fresh command is never fabricated.
  await act(async () => { action('context-open')(); });
  expect(screen.queryByTestId('screen-source-plan-detail')).toBeNull(); expect(f.creates()).toHaveLength(1);
});

test('saving with no detail renderer keeps the source destination absent-safe even if it later returns', async () => {
  const f = await mountApp(); await enter();
  mockOverrides = { renderSourcePlanDetail: undefined }; await f.view.rerender(<App />);
  await fireEvent.press(screen.getByTestId('context-confirm'));
  expect(screen.getByText('Your plan is saved. Opening it is unavailable here.')).toBeTruthy();
  expect(screen.getByTestId('context-open')).toBeDisabled(); expect(screen.getByTestId('a-back')).toBeTruthy();
  mockOverrides = {}; await f.view.rerender(<App />);
  expect(screen.getByTestId('context-open')).toBeDisabled(); expect(f.creates()).toHaveLength(1);
  expect(mockDetails).toHaveLength(0); expect(screen.queryByTestId('screen-plan-edit')).toBeNull();
});

test('same-account auth replacement during source readback fences old open, close and confirm handlers', async () => {
  const f = await mountApp(), original = await enter(), confirm = action('context-confirm');
  await fireEvent.press(screen.getByTestId('context-confirm'));
  const read = deferredResponse(), open = action('context-open'), back = action('a-back'); f.read = () => read.promise;
  await act(async () => { open(); }); expect(screen.queryByTestId('a-back')).toBeNull();
  await act(async () => { await f.api.signIn('synthetic@example.invalid', 'synthetic'); });
  await act(async () => { read.resolve(json({ items: [f.saved.plan] })); open(); back(); });
  expect(screen.queryByTestId('screen-source-plan-detail')).toBeNull(); expect(screen.queryByTestId('context-row-name')).toBeNull();
  expect(f.creates()).toHaveLength(1); expect(mockDetails).toHaveLength(0);
  f.read = null; f.plans = []; f.account.profile.name = 'Fresh session name';
  await fireEvent.press(screen.getByTestId('a-signin-email'));
  await fireEvent.changeText(screen.getByTestId('a-email-field'), 'synthetic@example.invalid');
  await fireEvent.changeText(screen.getByTestId('a-password-field'), 'synthetic');
  await fireEvent.press(screen.getByTestId('a-email-submit'));
  await screen.findByTestId('a-entry-context-review'); const fresh = await enter();
  expect(screen.getByText('Fresh session name')).toBeTruthy();
  expect(fresh.confirmation).not.toBe(original.confirmation); expect(fresh.sessionGeneration).not.toBe(original.sessionGeneration);
  await act(async () => { confirm(); open(); back(); });
  expect(screen.getByTestId('screen-context-review')).toBeTruthy(); expect(f.creates()).toHaveLength(1);
  expect(fresh.confirmation.snapshot().status).toBe('ready'); expect(original.confirmation.snapshot().status).toBe('stale');
});

test('same-account auth replacement fences original Settings sheet save and close callbacks', async () => {
  const f = await mountApp(); await enter(); await fireEvent.press(screen.getByTestId('context-row-coach'));
  const save = action('editor-save'), close = action('a-coach-close'), editor = lastSettings();
  await act(async () => { await f.api.signIn('synthetic@example.invalid', 'synthetic'); });
  await act(async () => { save(); close(); });
  let result: Awaited<ReturnType<SettingsPresentationContext['savePreferences']>> | undefined;
  await act(async () => { result = await editor.savePreferences({ coachVoice: 'calm' }); });
  expect(result).toMatchObject({ status: 'failed', error: { code: 'session_changed' } });
  expect(f.writes()).toHaveLength(0); expect(f.creates()).toHaveLength(0);
});
