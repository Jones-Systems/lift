import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo, AppState, View } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { FormRuntime } from '../../src/FormRuntime';
import { FormTransport, type SessionStorage } from '../../src/api/transport';
import { FormResources } from '../../src/api/resources';
import type { Account } from '../../src/api/domain';
import type { AccountSecuritySlotContext, SaveResult, SettingsSlotContext } from '../../src/features/contract';
import { SettingsScreen } from '../../src/settings/SettingsScreen';

const origin = 'https://form.renderer.invalid';
const pendingCleanup: (() => Promise<void>)[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const denied = () => json({ error: { code: 'unauthenticated', message: 'Synthetic authoritative 401' } }, 401);
function account(id: string): Account {
  return { accountId: id, appAccountToken: `synthetic-${id}`,
    onboarding: { revision: 1, step: 'review', answers: {}, preferences: {}, status: 'completed', completedAt: null },
    profile: { revision: 4, name: id, age: null, heightCm: null, weightKg: null,
      trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30,
      equipment: ['dumbbell'], remindersEnabled: false } };
}

async function mountRuntime(options: { sameAccount?: boolean; passwordDenied?: boolean; signOutUnknown?: boolean } = {}) {
  const calls: { path: string; authorization: string | null }[] = [];
  const storageEvents: { kind: string; value: string | null }[] = [];
  const appSubscriptions = new Set<() => void>();
  const motionSubscriptions = new Set<() => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => {
    const remove = () => { appSubscriptions.delete(remove); };
    appSubscriptions.add(remove); return { remove };
  });
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(() => {
    const remove = () => { motionSubscriptions.delete(remove); };
    motionSubscriptions.add(remove);
    return { remove } as ReturnType<typeof AccessibilityInfo.addEventListener>;
  });
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  let stored: string | null = JSON.stringify({ version: 1, baseURL: origin, token: 'synthetic-original' });
  let current = account('original');
  let blocked: ReturnType<typeof deferred<Response>> | null = null;
  let blockedSignOut: ReturnType<typeof deferred<Response>> | null = null;
  let settings!: SettingsSlotContext;
  let security!: AccountSecuritySlotContext;
  let signOutCalls = 0;
  const storage: SessionStorage = {
    async load() { return stored; },
    async save(value) { storageEvents.push({ kind: 'save', value }); stored = value; },
    async clear() { storageEvents.push({ kind: 'clear', value: stored }); stored = null; },
  };
  const api = new FormTransport(origin, storage, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const authorization = new Headers(init?.headers).get('Authorization');
    calls.push({ path, authorization });
    switch (path) {
      case '/api/auth/get-session': return json({ session: { id: 'synthetic-session', token: authorization?.slice(7),
        userId: current.accountId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, user: { id: current.accountId } });
      case '/api/auth/sign-out':
        if (blockedSignOut) return blockedSignOut.promise;
        if (options.signOutUnknown && signOutCalls++ === 0) return json({ error: { code: 'unavailable' } }, 503);
        return json({ success: true });
      case '/api/auth/revoke-sessions': return json({ status: true });
      case '/api/auth/change-password':
        return options.passwordDenied ? json({ code: 'INVALID_PASSWORD', message: 'Synthetic invalid password' }, 400)
          : json({}, 200, { 'set-auth-token': 'synthetic-password-replacement' });
      case '/api/auth/sign-in/email':
        current = account(options.sameAccount ? 'original' : 'replacement');
        return json({}, 200, { 'set-auth-token': 'synthetic-replacement' });
      case '/v1/capabilities': return json({ authentication: {
        emailPassword: { status: 'configured', registration: 'closed', passwordRecovery: 'unconfigured' },
        apple: { status: 'unconfigured' }, google: { status: 'unconfigured' }, phone: { status: 'unconfigured' },
        session: { transport: 'bearer', expiresInSeconds: 3600 } } });
      case '/v1/me': return json(current);
      case '/v1/me/settings': return json({ accountId: current.accountId, identity: {
        displayName: current.profile.name, email: `${current.accountId}@example.invalid`, signInMethods: ['emailPassword'],
        displayNameSource: 'formProfile', phoneNumber: null, emailVerified: true }, capabilities: {}, policies: {} });
      case '/v1/entitlements': return json({ accountId: current.accountId, grants: [], active: [] });
      case '/v1/plans': case '/v1/exercises': return json({ items: [] });
      case '/v1/stats':
        if (!blocked) throw new Error('Missing controlled stats response');
        return blocked.promise;
      default: throw new Error(`Unexpected synthetic request: ${path}`);
    }
  });
  const authSubscriptions = new Set<() => void>();
  const subscribe = api.subscribeAuthChanges.bind(api);
  jest.spyOn(api, 'subscribeAuthChanges').mockImplementation(observer => {
    const subscription = subscribe(observer);
    const remove = () => { subscription.remove(); authSubscriptions.delete(remove); };
    authSubscriptions.add(remove); return { remove };
  });
  const resources = new FormResources(api);
  const result = await render(<FormRuntime resources={resources}
    renderAccountSecurity={ctx => { security = ctx; return <View testID="screen-security-slot" />; }}
    renderSettings={ctx => { settings = ctx; return <SettingsScreen {...ctx} />; }} />);
  await screen.findByTestId('screen-today');
  await fireEvent.press(screen.getByTestId('a-account-entry'));
  expect(screen.getByTestId('screen-settings')).toBeTruthy();
  expect(screen.getByText('original · original@example.invalid')).toBeTruthy();
  return { api, calls, storageEvents, stored: () => stored, settings: () => settings, security: () => security,
    subscriptions: { appSubscriptions, motionSubscriptions, authSubscriptions },
    async denyLater() {
      blocked = deferred<Response>();
      let outcome!: Promise<unknown>;
      await act(async () => { outcome = api.request('/v1/stats').catch(error => error); });
      expect(calls.at(-1)).toEqual({ path: '/v1/stats', authorization: 'Bearer synthetic-original' });
      const response = blocked;
      pendingCleanup.push(async () => { response.resolve(denied()); await outcome; });
      return { async release() {
        let error: unknown;
        await act(async () => { response.resolve(denied()); error = await outcome; });
        return error;
      } };
    },
    async signOutLater() {
      blockedSignOut = deferred<Response>();
      let outcome!: Promise<SaveResult<null>>;
      await act(async () => { outcome = settings.signOut(); });
      expect(calls.at(-1)?.path).toBe('/api/auth/sign-out');
      const response = blockedSignOut;
      pendingCleanup.push(async () => { response.resolve(json({ success: true })); await outcome; });
      return { async release() {
        let value!: SaveResult<null>;
        await act(async () => { response.resolve(json({ success: true })); value = await outcome; });
        return value;
      } };
    },
    async unmount() { await result.unmount(); },
  };
}

afterEach(async () => {
  await cleanup();
  await act(async () => { await Promise.all(pendingCleanup.splice(0).map(finish => finish())); });
});

test.each(['allowlist', 'closed'] as const)('empty-session startup applies deferred %s registration capabilities', async registration => {
  const response = deferred<Response>();
  const capabilities = { authentication: {
    emailPassword: { status: 'configured', registration, passwordRecovery: 'unconfigured' },
    apple: { status: 'unconfigured' }, google: { status: 'unconfigured' }, phone: { status: 'unconfigured' },
    session: { transport: 'bearer', expiresInSeconds: 3600 } } };
  pendingCleanup.push(async () => { response.resolve(json(capabilities)); });
  const storage: SessionStorage = {
    async load() { return null; },
    async save() { throw new Error('Empty-session startup must not save a session'); },
    async clear() {},
  };
  const calls: string[] = [];
  const api = new FormTransport(origin, storage, async url => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path !== '/v1/capabilities') throw new Error(`Unexpected startup request: ${path}`);
    return response.promise;
  });
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  await render(<FormRuntime resources={new FormResources(api)} renderSettings={() => null} />);
  expect(await screen.findByTestId('screen-sign-in')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('a-signin-email'));
  expect(screen.queryByTestId('a-email-mode')).toBeNull();

  await act(async () => { response.resolve(json(capabilities)); });

  expect(calls).toEqual(['/v1/capabilities']);
  if (registration === 'allowlist') expect(screen.getByText('Create an account')).toBeTruthy();
  else expect(screen.queryByTestId('a-email-mode')).toBeNull();
});

async function assertRetainedBlocked(f: Awaited<ReturnType<typeof mountRuntime>>, retained: SettingsSlotContext) {
  const before = f.calls.length;
  await act(async () => {
    await expect(retained.resources.account()).rejects.toMatchObject({ code: 'session_changed' });
    await expect(retained.resources.profile(retained.account.profile, { name: 'stale' })).rejects.toMatchObject({ code: 'session_changed' });
    expect(await retained.saveProfile({ name: 'stale' })).toMatchObject({ status: 'failed', error: { code: 'session_changed' } });
    retained.openAccount(); retained.close(); await retained.reload();
  });
  expect(f.calls).toHaveLength(before);
}

function expectSubscriptionsRemoved(f: Awaited<ReturnType<typeof mountRuntime>>) {
  for (const subscriptions of Object.values(f.subscriptions)) expect(subscriptions.size).toBe(0);
}

test('current authenticated 401 clears original custody, mounts actual sign-in, and blocks retained Settings operations', async () => {
  const f = await mountRuntime();
  const retained = f.settings();
  const pending = await f.denyLater();
  expect(screen.getByTestId('screen-settings')).toBeTruthy();
  expect(f.stored()).toContain('synthetic-original');
  expect(await pending.release()).toMatchObject({ status: 401, code: 'unauthenticated' });
  expect(f.storageEvents).toEqual([{ kind: 'clear', value: JSON.stringify({ version: 1, baseURL: origin, token: 'synthetic-original' }) }]);
  expect(f.stored()).toBeNull();
  expect(await screen.findByTestId('screen-sign-in')).toBeTruthy();
  expect(screen.getByText('Step onto the mat.')).toBeTruthy();
  expect(screen.queryByTestId('screen-settings')).toBeNull();
  await assertRetainedBlocked(f, retained);
  expect(screen.getByTestId('screen-sign-in')).toBeTruthy();
  await f.unmount(); expectSubscriptionsRemoved(f);
});

test('delayed old 401 cannot clear replacement custody or replace actual replacement Settings presentation', async () => {
  const f = await mountRuntime();
  const retained = f.settings();
  const pending = await f.denyLater();
  await fireEvent.press(screen.getByTestId('a-sign-out'));
  await fireEvent.press(screen.getByTestId('a-signout-confirm'));
  await screen.findByTestId('screen-sign-in');
  await fireEvent.press(screen.getByTestId('a-signin-email'));
  await fireEvent.changeText(screen.getByTestId('a-email-field'), 'replacement@example.invalid');
  await fireEvent.changeText(screen.getByTestId('a-password-field'), 'synthetic-password');
  await fireEvent.press(screen.getByTestId('a-email-submit'));
  await screen.findByTestId('screen-today');
  await fireEvent.press(screen.getByTestId('a-account-entry'));
  expect(screen.getByText('replacement · replacement@example.invalid')).toBeTruthy();
  const stored = f.stored(), events = [...f.storageEvents];
  expect(stored).toContain('synthetic-replacement');
  expect(await pending.release()).toMatchObject({ status: 409, code: 'session_changed' });
  expect(f.stored()).toBe(stored); expect(f.storageEvents).toEqual(events);
  expect(screen.getByTestId('screen-settings')).toBeTruthy();
  expect(screen.getByText('replacement · replacement@example.invalid')).toBeTruthy();
  expect(screen.queryByTestId('screen-sign-in')).toBeNull();
  await assertRetainedBlocked(f, retained);
  expect(screen.getByText('replacement · replacement@example.invalid')).toBeTruthy();
  await f.unmount(); expectSubscriptionsRemoved(f);
});

test('unmount removes Runtime and shell subscriptions and fences retained Settings operations', async () => {
  const f = await mountRuntime(), retained = f.settings();
  for (const subscriptions of Object.values(f.subscriptions)) expect(subscriptions.size).toBeGreaterThan(0);
  await f.unmount(); expectSubscriptionsRemoved(f);
  await assertRetainedBlocked(f, retained);
});

async function signInThroughScreen() {
  await fireEvent.press(screen.getByTestId('a-signin-email'));
  await fireEvent.changeText(screen.getByTestId('a-email-field'), 'replacement@example.invalid');
  await fireEvent.changeText(screen.getByTestId('a-password-field'), 'synthetic-password');
  await fireEvent.press(screen.getByTestId('a-email-submit'));
  await screen.findByTestId('screen-today');
  await fireEvent.press(screen.getByTestId('a-account-entry'));
}

test('same-account sign-in after current 401 captures a new session and keeps old Settings fenced', async () => {
  const f = await mountRuntime({ sameAccount: true }), retained = f.settings();
  const pending = await f.denyLater();
  await pending.release();
  await screen.findByTestId('screen-sign-in');
  await signInThroughScreen();
  expect(screen.getByText('original · original@example.invalid')).toBeTruthy();
  expect(f.stored()).toContain('synthetic-replacement');
  expect(f.settings().resources).not.toBe(retained.resources);
  await act(async () => { expect((await f.settings().resources.account()).accountId).toBe('original'); });
  await assertRetainedBlocked(f, retained);
  expect(screen.getByTestId('screen-settings')).toBeTruthy();
  await f.unmount(); expectSubscriptionsRemoved(f);
});

test.each([false, true])('owned password replacement (denied=%s) retains its admission, reacquires and fences a late old 401', async passwordDenied => {
  const f = await mountRuntime({ passwordDenied }), retained = f.settings();
  const pending = await f.denyLater();
  await act(async () => { retained.openAccountSecurity!(); });
  expect(screen.getByTestId('screen-security-slot')).toBeTruthy();
  const security = f.security();
  await act(async () => {
    const outcome = await security.credentials.changePassword({ currentPassword: 'synthetic-current', newPassword: 'synthetic-next-password' });
    expect(outcome.status).toBe(passwordDenied ? 'failed' : 'saved');
    expect(security.isCurrentSession()).toBe(true);
  });
  expect(screen.queryByTestId('screen-sign-in')).toBeNull();
  expect(screen.getByTestId('screen-security-slot')).toBeTruthy();
  expect(f.stored()).toContain(passwordDenied ? 'synthetic-original' : 'synthetic-password-replacement');
  await act(async () => { await security.reload(); });
  expect(screen.getByTestId('screen-settings')).toBeTruthy();
  expect(f.settings().resources).not.toBe(retained.resources);
  const stored = f.stored(), events = [...f.storageEvents];
  expect(await pending.release()).toMatchObject({ status: 409, code: 'session_changed' });
  expect(f.stored()).toBe(stored); expect(f.storageEvents).toEqual(events);
  await assertRetainedBlocked(f, retained);
  await act(async () => { expect((await f.settings().resources.account()).accountId).toBe('original'); });
  expect(screen.getByTestId('screen-settings')).toBeTruthy();
  await f.unmount(); expectSubscriptionsRemoved(f);
});

test('unknown owned sign-out retains custody and its retry until confirmed revocation', async () => {
  const f = await mountRuntime({ signOutUnknown: true });
  let result!: SaveResult<null>;
  await act(async () => { result = await f.settings().signOut(); });
  expect(result.status).toBe('unknown');
  expect(f.stored()).toContain('synthetic-original');
  expect(screen.getByTestId('screen-settings')).toBeTruthy();
  expect(screen.queryByTestId('screen-sign-in')).toBeNull();
  if (result.status !== 'unknown') throw new Error('Expected original unknown retry');
  const retry = result.retry;
  await act(async () => { expect(await retry()).toEqual({ status: 'saved', value: null }); });
  expect(f.calls.filter(call => call.path === '/api/auth/sign-out')).toHaveLength(2);
  expect(f.stored()).toBeNull();
  expect(screen.getByTestId('screen-sign-in')).toBeTruthy();
  await f.unmount(); expectSubscriptionsRemoved(f);
});

test('unknown old sign-out retry cannot dispatch after a replacement sign-in', async () => {
  const f = await mountRuntime({ signOutUnknown: true });
  let result!: SaveResult<null>;
  await act(async () => { result = await f.settings().signOut(); });
  if (result.status !== 'unknown') throw new Error('Expected original unknown retry');
  const retry = result.retry;
  await act(async () => { await f.api.signIn('replacement@example.invalid', 'synthetic-password'); });
  expect(screen.getByTestId('screen-sign-in')).toBeTruthy();
  await signInThroughScreen();
  const before = f.calls.length;
  await act(async () => { expect(await retry()).toMatchObject({ status: 'failed', error: { code: 'session_changed', originalEffectUnknown: true } }); });
  expect(f.calls).toHaveLength(before);
  expect(f.stored()).toContain('synthetic-replacement');
  expect(screen.getByText('replacement · replacement@example.invalid')).toBeTruthy();
  await f.unmount(); expectSubscriptionsRemoved(f);
});

test('owned revoke-all completes after auth invalidation and removes the rendered account', async () => {
  const f = await mountRuntime();
  await act(async () => { expect(await f.settings().sessionAction!('revokeAllSessions')).toEqual({ status: 'saved', value: null }); });
  expect(f.stored()).toBeNull();
  expect(screen.getByTestId('screen-sign-in')).toBeTruthy();
  expect(screen.queryByTestId('screen-settings')).toBeNull();
  await f.unmount(); expectSubscriptionsRemoved(f);
});

test('foreign auth during pending owned sign-out expires presentation immediately and fences its late result', async () => {
  const f = await mountRuntime(), retained = f.settings();
  const pending = await f.signOutLater();
  expect(screen.getByTestId('screen-settings')).toBeTruthy();
  await act(async () => { await f.api.signIn('replacement@example.invalid', 'synthetic-password'); });
  expect(screen.getByTestId('screen-sign-in')).toBeTruthy();
  expect(screen.queryByTestId('screen-settings')).toBeNull();
  await signInThroughScreen();
  const stored = f.stored(), events = [...f.storageEvents];
  expect(await pending.release()).toMatchObject({ status: 'failed', error: { code: 'session_changed' } });
  expect(f.stored()).toBe(stored); expect(f.storageEvents).toEqual(events);
  expect(screen.getByText('replacement · replacement@example.invalid')).toBeTruthy();
  await assertRetainedBlocked(f, retained);
  await f.unmount(); expectSubscriptionsRemoved(f);
});
