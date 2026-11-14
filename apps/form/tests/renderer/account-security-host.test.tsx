import React, { StrictMode, useLayoutEffect } from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo, AppState, View } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import App from '../../App';
import { FormRuntime } from '../../src/FormRuntime';
import { FormResources } from '../../src/api/resources';
import { FormTransport } from '../../src/api/transport';
import type { Account } from '../../src/api/domain';
import type { AccountSecuritySlotContext, HomeSlotContext } from '../../src/features/contract';
import type { SettingsPresentationContext } from '../../src/settings';
import type { ChangePasswordScreenProps } from '../../src/features/credentials/change-password';
import type { ChangeEmailScreenProps } from '../../src/features/credentials/change-email';

type RuntimeProps = React.ComponentProps<typeof FormRuntime>;
let mockResources: FormResources | undefined;
let mockOverrides: Partial<RuntimeProps> = {};
const mockSettings: SettingsPresentationContext[] = [];
const mockSecurity: AccountSecuritySlotContext[] = [];
const mockHomes: HomeSlotContext[] = [];
const mockRenderers: RuntimeProps['renderAccountSecurity'][] = [];
const mockPasswords: ChangePasswordScreenProps[] = [];
const mockEmails: ChangeEmailScreenProps[] = [];
const mockActions = new Map<string, (() => void) | undefined>();
const pendingCleanup: (() => void)[] = [];

// These typed probes call through the actual App, Runtime, shell, Settings, host and frozen leaves.
jest.mock('../../src/FormRuntime', () => {
  const actual = jest.requireActual<typeof import('../../src/FormRuntime')>('../../src/FormRuntime');
  return { ...actual, FormRuntime: (props: RuntimeProps) => {
    mockRenderers.push(props.renderAccountSecurity);
    return <actual.FormRuntime {...props} resources={mockResources} {...mockOverrides} />;
  } };
});
jest.mock('../../src/fonts', () => ({ useFormFonts: () => true }));
jest.mock('../../src/settings', () => {
  const actual = jest.requireActual<typeof import('../../src/settings')>('../../src/settings');
  return { ...actual, SettingsSlot(ctx: SettingsPresentationContext) {
    mockSettings.push(ctx); return <actual.SettingsSlot {...ctx} />;
  } };
});
jest.mock('../../src/features/training', () => {
  const actual = jest.requireActual<typeof import('../../src/features/training')>('../../src/features/training');
  return { ...actual, TrainingSlot(ctx: HomeSlotContext) { mockHomes.push(ctx); return <actual.TrainingSlot {...ctx} />; } };
});
jest.mock('../../src/features/credentials/account-security', () => {
  const actual = jest.requireActual<typeof import('../../src/features/credentials/account-security')>('../../src/features/credentials/account-security');
  return { ...actual, AccountSecurityScreen(ctx: AccountSecuritySlotContext) {
    mockSecurity.push(ctx); return <actual.AccountSecurityScreen {...ctx} />;
  } };
});
jest.mock('../../src/features/credentials/change-password', () => {
  const actual = jest.requireActual<typeof import('../../src/features/credentials/change-password')>('../../src/features/credentials/change-password');
  return { ...actual, ChangePasswordScreen(props: ChangePasswordScreenProps) {
    mockPasswords.push(props); return <actual.ChangePasswordScreen {...props} />;
  } };
});
jest.mock('../../src/features/credentials/change-email', () => {
  const actual = jest.requireActual<typeof import('../../src/features/credentials/change-email')>('../../src/features/credentials/change-email');
  return { ...actual, ChangeEmailScreen(props: ChangeEmailScreenProps) {
    mockEmails.push(props); return <actual.ChangeEmailScreen {...props} />;
  } };
});
jest.mock('../../src/features/shared/ui', () => {
  const actual = jest.requireActual<typeof import('../../src/features/shared/ui')>('../../src/features/shared/ui');
  return { ...actual,
    PrimaryAction(props: React.ComponentProps<typeof actual.PrimaryAction>) {
      mockActions.set(props.label, props.onPress); return <actual.PrimaryAction {...props} />;
    },
    PlainAction(props: React.ComponentProps<typeof actual.PlainAction>) {
      mockActions.set(props.captureId ?? props.label, props.onPress); return <actual.PlainAction {...props} />;
    },
    Nav(props: React.ComponentProps<typeof actual.Nav>) {
      mockActions.set('back', props.onBack); return <actual.Nav {...props} />;
    },
  };
});

function last<T>(values: T[]): T { const value = values.at(-1); if (!value) throw Error('Missing actual boundary'); return value; }
function action(id: string) { const callback = mockActions.get(id); if (!callback) throw Error('Missing action: ' + id); return callback; }
function host() { const value = last(mockSecurity).credentialHost; if (!value) throw Error('Missing original host'); return value; }
function json(value: unknown, status = 200, headers = {}): Response {
  const response = new Response(JSON.stringify(value), { status, headers });
  response.json = async () => JSON.parse(await response.text());
  return response;
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  pendingCleanup.push(() => resolve(json({ code: 'unavailable' }, 503)));
  return { promise, resolve };
}
function account(): Account {
  return { accountId: 'original', appAccountToken: 'synthetic-app-token',
    onboarding: { revision: 1, step: 'review', status: 'completed', answers: {}, preferences: {}, completedAt: null },
    profile: { revision: 4, name: 'Original', age: null, heightCm: null, weightKg: null,
      trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 30,
      equipment: ['dumbbell'], remindersEnabled: false } };
}
function settings() {
  return { accountId: 'original', identity: { displayName: 'Original', displayNameSource: 'formProfile',
    email: 'old@example.invalid', emailVerified: true, signInMethods: ['emailPassword'], phoneNumber: null },
    capabilities: { changePassword: { supported: true, status: 'available' }, changeEmail: { supported: true, status: 'verified' },
      revokeOtherSessions: { supported: true, method: 'POST', path: '/api/auth/revoke-other-sessions',
        scope: 'otherFormSessions', authentication: 'currentFormSession', requestBody: 'emptyObject' } }, policies: {} };
}
function fixture() {
  const f: { account: Account; settings: ReturnType<typeof settings>; password: null | (() => Promise<Response>);
    request: null | (() => Promise<Response>); confirm: null | (() => Promise<Response>);
    read: null | (() => Promise<Response>); readSettings: null | (() => Promise<Response>);
    store: null | (() => Promise<void>); clearCount: number; saves: string[];
    calls: { path: string; method: string; authorization: string | null }[];
  } = { account: account(), settings: settings(), password: null, request: null, confirm: null, read: null,
    readSettings: null, store: null, clearCount: 0, saves: [], calls: [] };
  const origin = 'https://form.renderer.invalid';
  const api = new FormTransport(origin, {
    async load() { return JSON.stringify({ version: 1, baseURL: origin, token: 'synthetic-original' }); },
    async save(value) { f.saves.push(JSON.parse(value).token); await f.store?.(); }, async clear() { f.clearCount++; },
  }, async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET';
    f.calls.push({ path, method, authorization: new Headers(init?.headers).get('Authorization') });
    switch (path) {
      case '/api/auth/get-session': return json({ session: { id: 'synthetic-session', token: 'synthetic-original', userId: 'original',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, user: { id: 'original' } });
      case '/api/auth/sign-in/email': return json({}, 200, { 'set-auth-token': 'synthetic-foreign' });
      case '/api/auth/change-password': return f.password ? f.password() : json({}, 200, { 'set-auth-token': 'synthetic-password' });
      case '/api/auth/email-otp/request-email-change': return f.request ? f.request() : json({ success: true });
      case '/api/auth/email-otp/change-email':
        if (f.confirm) return f.confirm();
        f.settings.identity.email = 'new@example.invalid'; return json({ success: true });
      case '/api/auth/revoke-other-sessions': return json({ status: true });
      case '/api/auth/sign-out': return json({ success: true });
      case '/v1/capabilities': return json({});
      case '/v1/me': return f.read ? f.read() : json(f.account);
      case '/v1/entitlements': return json({ accountId: f.account.accountId, grants: [], active: [] });
      case '/v1/me/settings': return f.readSettings ? f.readSettings() : json(f.settings);
      case '/v1/plans': case '/v1/exercises': return json({ items: [] });
      case '/v1/history': return json({ items: [], nextBefore: null });
      case '/v1/stats': return json({ confirmedSets: 0, repetitions: 0, volumeKg: 0, completedSessions: 0, byExercise: [],
        units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true });
      default: throw Error('Unexpected actual mounted request: ' + method + ' ' + path);
    }
  });
  return Object.assign(f, { api, resources: new FormResources(api), mutations: () => f.calls.filter(call => call.method === 'POST'),
    count: (path: string) => f.calls.filter(call => call.path === path).length });
}
async function mount(f = fixture(), strict = false) {
  mockResources = f.resources;
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  const view = await render(strict ? <StrictMode><App /></StrictMode> : <App />);
  await screen.findByTestId('a-entry-context-review');
  await act(async () => { last(mockHomes).openSettings(); });
  await screen.findByTestId('screen-settings');
  return Object.assign(f, { view });
}
async function enter(kind?: 'password' | 'email') {
  await fireEvent.press(screen.getByTestId('a-row-security'));
  await screen.findByTestId('screen-account-security');
  if (kind) { await fireEvent.press(screen.getByTestId('security-change-' + kind)); await screen.findByTestId('screen-change-' + kind); }
  return host();
}
async function fillPassword() {
  for (const [label, value] of [['Current password', 'synthetic-current'], ['New password', 'synthetic-password-new'],
    ['Confirm new password', 'synthetic-password-new']]) await fireEvent.changeText(screen.getByLabelText(label), value);
}
async function emailCode() {
  await fireEvent.changeText(screen.getByLabelText('New email'), 'new@example.invalid');
  await fireEvent.changeText(screen.getByLabelText('Current password'), 'synthetic-current');
  await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
  await screen.findByLabelText('8-digit code');
  await fireEvent.changeText(screen.getByLabelText('8-digit code'), '12345678');
}
afterEach(async () => {
  await cleanup();
  await act(async () => { pendingCleanup.splice(0).forEach(finish => finish()); });
  mockResources = undefined; mockOverrides = {};
  mockSettings.length = 0; mockSecurity.length = 0; mockHomes.length = 0; mockRenderers.length = 0;
  mockPasswords.length = 0; mockEmails.length = 0; mockActions.clear();
});

test('actual App supplies a stable renderer and enters both leaves without a mutation or a second credential port', async () => {
  const f = await mount(), originalRenderer = last(mockRenderers), admitted = await enter('password');
  const ctx = last(mockSecurity), password = last(mockPasswords).controller;
  await f.view.rerender(<App />);
  expect(last(mockRenderers)).toBe(originalRenderer); expect(host()).toBe(admitted);
  expect(last(mockSecurity).credentials).toBe(ctx.credentials); expect(last(mockPasswords).controller).toBe(password);
  await act(async () => { admitted.open('email'); });
  await screen.findByTestId('screen-change-email');
  expect(password.snapshot().status).toBe('disposed'); expect(f.mutations()).toHaveLength(0);
  expect(ctx.credentials.isCurrent()).toBe(true);
});

const deniedRows: { name: string; change: (f: ReturnType<typeof fixture>) => void }[] = [
  { name: 'absent', change: f => { Reflect.deleteProperty(f.settings.capabilities, 'changePassword'); Reflect.deleteProperty(f.settings.capabilities, 'changeEmail'); } },
  { name: 'foreign', change: f => { f.settings.accountId = 'foreign'; } },
  { name: 'unsupported', change: f => { f.settings.capabilities.changePassword.supported = false; f.settings.capabilities.changeEmail.supported = false; } },
  { name: 'unknown', change: f => { f.settings.capabilities.changePassword.status = 'future'; f.settings.capabilities.changeEmail.status = 'future'; } },
  { name: 'unconfigured', change: f => { f.settings.capabilities.changePassword.status = 'unconfigured'; f.settings.capabilities.changeEmail.status = 'unconfigured'; } },
  { name: 'provider only', change: f => { f.settings.identity.signInMethods = ['apple']; } },
  { name: 'missing current email', change: f => {
    Reflect.deleteProperty(f.settings.capabilities, 'changePassword');
    Reflect.set(f.settings.identity, 'email', null);
  } },
];
for (const row of deniedRows) test('Settings denies ' + row.name + ' credential authority', async () => {
  const f = fixture(); row.change(f);
  if (row.name === 'foreign') {
    // The real shell refuses a mismatched settings account before Settings can be adopted.
    mockResources = f.resources; jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    await render(<App />); await screen.findByTestId('screen-error');
  } else { await mount(f); expect(screen.queryByTestId('a-row-security')).toBeNull(); }
  expect(f.mutations()).toHaveLength(0);
});

test('the original controller survives StrictMode and ordinary rerenders while pending and excludes duplicate submission', async () => {
  const f = await mount(fixture(), true), gate = deferred(); f.password = () => gate.promise;
  const admitted = await enter('password'); await fillPassword(); const submit = action('Change password');
  await act(async () => { submit(); submit(); });
  const controller = last(mockPasswords).controller;
  await f.view.rerender(<StrictMode><App /></StrictMode>);
  expect(host()).toBe(admitted); expect(last(mockPasswords).controller).toBe(controller);
  expect(controller.snapshot().status).toBe('pending'); expect(f.count('/api/auth/change-password')).toBe(1);
  await act(async () => { gate.resolve(json({}, 200, { 'set-auth-token': 'synthetic-password' })); });
  expect(controller.snapshot().status).toBe('saved'); expect(f.clearCount).toBe(0);
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByTestId('screen-settings');
  expect(screen.getByTestId('settings-security-notice')).toBeTruthy();
  expect(last(mockSettings).account.accountId).toBe('original');
  expect(f.calls.filter(call => call.path === '/v1/me').at(-1)?.authorization).toBe('Bearer synthetic-password');
});

test('known password failure permits correction, and the accepted completion is consumed once', async () => {
  const f = await mount(); f.password = async () => json({ code: 'INVALID_PASSWORD' }, 400);
  const admitted = await enter('password'); await fillPassword();
  await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
  expect(last(mockPasswords).controller.snapshot().status).toBe('failed');
  f.password = null; await fillPassword(); await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
  const complete = action('Continue');
  await act(async () => { complete(); complete(); admitted.complete(); });
  await screen.findByTestId('screen-settings'); expect(f.count('/api/auth/change-password')).toBe(2);
  expect(last(mockSettings).securityNotice?.text).toMatch(/Password changed/);
  const reads = f.count('/v1/me'); await act(async () => { complete(); admitted.complete(); });
  expect(f.count('/v1/me')).toBe(reads);
});

test('unknown password is never repeated, Back disposes it and performs bounded readback without clearing Keychain', async () => {
  const f = await mount(); f.password = async () => { throw Error('Synthetic unavailable'); };
  const admitted = await enter('password'); await fillPassword();
  await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
  const controller = last(mockPasswords).controller;
  expect(controller.snapshot().status).toBe('unknown');
  await act(async () => { action('Change password')(); admitted.open('email'); admitted.complete(); });
  expect(f.count('/api/auth/change-password')).toBe(1); expect(controller.transition()).toBeNull();
  await act(async () => { action('back')(); }); await screen.findByTestId('screen-settings');
  expect(controller.snapshot().status).toBe('disposed'); expect(f.clearCount).toBe(0);
  expect(last(mockSettings).securityNotice).toBeUndefined();
});

for (const outcome of ['saved', 'unknown', 'failed-read', 'foreign-read']) test('email ' + outcome + ' uses authoritative readback and the existing explicit revocation sheet', async () => {
  const f = await mount(); await enter('email'); await emailCode();
  if (outcome === 'unknown') f.confirm = async () => { f.settings.identity.email = 'new@example.invalid'; throw Error('Synthetic unavailable'); };
  if (outcome === 'failed-read') f.readSettings = async () => json({ code: 'unavailable' }, 503);
  if (outcome === 'foreign-read') f.read = async () => json({ ...account(), accountId: 'foreign' });
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm email' }));
  const controller = last(mockEmails).controller;
  expect(controller.snapshot().status).toBe(outcome === 'unknown' ? 'unknown' : 'saved');
  f.account = { ...f.account, profile: { ...f.account.profile, revision: 5, name: 'Reacquired name' },
    preferences: { ...f.account.preferences, revision: 8 } };
  if (outcome === 'unknown') {
    await act(async () => { action('Confirm email')(); });
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh account details' }));
  } else await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  if (outcome === 'failed-read' || outcome === 'foreign-read') {
    await screen.findByTestId('screen-security-return');
    expect(screen.queryByTestId('settings-security-notice')).toBeNull();
    expect(last(mockSettings).settings?.identity.email).toBe('old@example.invalid');
    f.read = null; f.readSettings = null;
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh account details' }));
  }
  await screen.findByTestId('screen-settings');
  expect(last(mockSettings).settings?.identity.email).toBe('new@example.invalid');
  expect(last(mockSettings).entitlements?.accountId).toBe('original');
  expect(last(mockSettings).account.profile.revision).toBe(5);
  expect(last(mockSettings).account.profile.name).toBe('Reacquired name');
  expect(last(mockSettings).account.preferences.revision).toBe(8);
  expect(f.count('/api/auth/email-otp/change-email')).toBe(1);
  expect(f.count('/api/auth/email-otp/request-email-change')).toBe(1);
  expect(f.count('/api/auth/revoke-other-sessions')).toBe(0);
  if (outcome !== 'unknown') {
    await fireEvent.press(screen.getByTestId('security-review-other-sessions'));
    expect(screen.getByTestId('a-signout-sheet')).toBeTruthy();
    expect(f.count('/api/auth/revoke-other-sessions')).toBe(0);
    await fireEvent.press(screen.getByTestId('a-signout-cancel'));
    await fireEvent.press(screen.getByTestId('security-review-other-sessions'));
    await fireEvent.press(screen.getByTestId('a-signout-confirm'));
    expect(f.count('/api/auth/revoke-other-sessions')).toBe(1);
  } else expect(last(mockSettings).securityNotice).toBeUndefined();
  expect(f.clearCount).toBe(0);
});

test('pending Back clears the original controller before the response, preserves transport custody, and never claims cancellation', async () => {
  const f = await mount(), gate = deferred(); f.password = () => gate.promise;
  const admitted = await enter('password'); await fillPassword();
  await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
  const controller = last(mockPasswords).controller;
  await act(async () => { action('back')(); });
  expect(controller.snapshot().status).toBe('disposed'); expect(host()).toBe(admitted);
  await screen.findByTestId('screen-security-return');
  await act(async () => { gate.resolve(json({}, 200, { 'set-auth-token': 'synthetic-password' })); });
  await screen.findByTestId('screen-settings');
  expect(f.count('/api/auth/change-password')).toBe(1); expect(last(mockSettings).securityNotice).toBeUndefined();
  expect(f.clearCount).toBe(0);
});

for (const stage of ['before', 'during-network', 'during-storage', 'after']) test('foreign authentication ' + stage + ' fences the original controller and completion', async () => {
  const f = await mount(); await enter('password'); await fillPassword();
  const controller = last(mockPasswords).controller, complete = host().complete;
  const gate = deferred();
  let releaseStore: (() => void) | undefined;
  if (stage === 'during-network') f.password = () => gate.promise;
  if (stage === 'during-storage') {
    const store = new Promise<void>(yes => { releaseStore = yes; }); f.store = () => store;
    pendingCleanup.push(() => releaseStore?.());
  }
  if (stage !== 'before') await fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
  await act(async () => {
    f.store = null;
    const foreign = f.api.signIn('synthetic@example.invalid', 'synthetic-foreign-password');
    releaseStore?.(); gate.resolve(json({}, 200, { 'set-auth-token': 'synthetic-password' }));
    await foreign;
  });
  await screen.findByTestId('screen-sign-in');
  const mutations = f.count('/api/auth/change-password');
  await act(async () => { complete(); await controller.submit('synthetic-current', 'synthetic-password-new', 'synthetic-password-new'); });
  expect(controller.snapshot().status).toBe('disposed'); expect(controller.transition()).toBeNull();
  expect(f.count('/api/auth/change-password')).toBe(mutations);
  expect(screen.queryByTestId('settings-security-notice')).toBeNull();
});

function EarlierLayout({ callback, children }: { callback?: () => void; children: React.ReactNode }) {
  useLayoutEffect(() => { callback?.(); }, [callback]);
  return <View>{children}</View>;
}
for (const loss of ['removal', 'renderer', 'resources', 'unmount']) test(loss + ' fences callbacks before earlier sibling layout can dispatch', async () => {
  const f = await mount(); await enter('password'); await fillPassword();
  const submit = action('Change password'), controller = last(mockPasswords).controller;
  await f.view.rerender(<><EarlierLayout><View /></EarlierLayout><App /></>);
  // Remount above deliberately expires the first admission; enter the new original before capturing its callbacks.
  await screen.findByTestId('a-entry-context-review');
  await act(async () => { last(mockHomes).openSettings(); }); await enter('password'); await fillPassword();
  const retained = action('Change password'), original = last(mockPasswords).controller;
  const originalContext = last(mockSecurity);
  const invokeRetained = () => {
    retained();
    void originalContext.credentials.changePassword({ currentPassword: 'synthetic-current', newPassword: 'synthetic-password-new' });
  };
  if (loss === 'removal') mockOverrides = { renderAccountSecurity: undefined };
  if (loss === 'renderer') mockOverrides = { renderAccountSecurity: () => <View /> };
  if (loss === 'resources') mockResources = new FormResources(f.api);
  await f.view.rerender(<><EarlierLayout callback={invokeRetained}><View /></EarlierLayout>{loss === 'unmount' ? null : <App />}</>);
  await act(async () => { submit(); retained(); });
  expect(controller.snapshot().status).toBe('disposed'); expect(original.snapshot().status).toBe('disposed');
  expect(f.count('/api/auth/change-password')).toBe(0);
});

test('background expires the original flow and reactivation cannot revive retained secrets or callbacks', async () => {
  const listeners = new Set<(state: string) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, callback) => {
    const listener = (state: string) => callback(state === 'active' ? 'active' : 'background');
    listeners.add(listener); return { remove: () => { listeners.delete(listener); } };
  });
  const f = await mount(); await enter('email'); await emailCode();
  const controller = last(mockEmails).controller, confirm = action('Confirm email');
  await act(async () => { for (const listener of [...listeners]) listener('background'); });
  await screen.findByTestId('screen-settings');
  await act(async () => { for (const listener of [...listeners]) listener('active'); confirm(); });
  expect(controller.snapshot().status).toBe('disposed'); expect(f.count('/api/auth/email-otp/change-email')).toBe(0);
});

test('capability loss synchronously fences retained controller commands without adopting a submitted email as authority', async () => {
  const f = await mount(); await enter('email');
  const ctx = last(mockSecurity), controller = last(mockEmails).controller;
  const own = ctx.settings;
  if (!own) throw Error('Expected own settings');
  Reflect.deleteProperty(own.capabilities, 'changeEmail');
  await act(async () => { await controller.requestCode('new@example.invalid', 'synthetic-current'); });
  expect(controller.snapshot().status).toBe('disposed'); expect(f.count('/api/auth/email-otp/request-email-change')).toBe(0);
  expect(last(mockSettings).settings?.identity.email).toBe('old@example.invalid');
});
