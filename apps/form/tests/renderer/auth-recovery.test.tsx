import React, { StrictMode, useLayoutEffect } from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { AppState, type AppStateStatus } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { AuthFlow } from '../../src/features/auth/AuthFlow';
import { ForgotPasswordScreen } from '../../src/features/credentials/forgot-password';
import { FormTransport, type SessionStorage } from '../../src/api/transport';
import { FormResources } from '../../src/api/resources';
import type { Capabilities } from '../../src/api/domain';
import type { IdentityPorts } from '../../src/features/contract';

const requestPath = '/api/auth/email-otp/request-password-reset';
const resetPath = '/api/auth/email-otp/reset-password';
const origin = 'https://auth-recovery.renderer.invalid';
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const pendingCleanup: (() => void)[] = [];
function BeforePassive({ run }: { run: () => void }) { useLayoutEffect(run); return null; }
function capabilities(status: string | undefined): Capabilities {
  // Only the consumed public authentication projection is supplied; no provider is activated.
  return { authentication: {
    emailPassword: { status: 'configured', registration: 'allowlist', passwordRecovery: status },
    apple: { status: 'unconfigured' }, google: { status: 'unconfigured' }, phone: { status: 'unconfigured' },
    session: { transport: 'bearer', expiresInSeconds: 3600 },
  } } as Capabilities;
}
function transport() {
  const calls: { path: string; method: string | undefined; body: unknown; authorization: string | null }[] = [];
  const storageEvents: string[] = [];
  const responses: ((response: Response) => void)[] = [];
  const storage: SessionStorage = {
    async load() { return null; }, async save() { storageEvents.push('save'); }, async clear() { storageEvents.push('clear'); },
  };
  const api = new FormTransport(origin, storage, async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: new Headers(init?.headers).get('Authorization') });
    if (path === '/api/auth/sign-in/email') return json({ user: { id: 'synthetic' } }, 200, { 'set-auth-token': 'synthetic-replacement' });
    if (path !== requestPath && path !== resetPath) throw new Error(`Unexpected synthetic request: ${path}`);
    return new Promise<Response>(resolve => { responses.push(resolve); pendingCleanup.push(() => resolve(json({ success: true }))); });
  });
  const subscriptions = new Set<() => void>();
  const subscribe = api.subscribeAuthChanges.bind(api);
  jest.spyOn(api, 'subscribeAuthChanges').mockImplementation(observer => {
    const original = subscribe(observer);
    const remove = () => { original.remove(); subscriptions.delete(remove); };
    subscriptions.add(remove); return { remove };
  });
  return { api, resources: new FormResources(api), calls, storageEvents, subscriptions,
    async finish(value: unknown = { success: true }, status = 200) {
      await act(async () => { const resolve = responses.shift(); if (!resolve) throw new Error('No synthetic request'); resolve(json(value, status)); });
    } };
}
async function fixture(status: string | undefined = 'configured_unverified', strict = false) {
  const f = transport();
  const listeners = new Set<(state: AppStateStatus) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    listeners.add(listener); return { remove() { listeners.delete(listener); } };
  });
  const onAuthenticated = jest.fn(), onRetryCapabilities = jest.fn();
  let resources = f.resources, identity: IdentityPorts | undefined, caps: Capabilities | null = capabilities(status);
  let beforePassive = () => {};
  const element = () => {
    const content = <><AuthFlow resources={resources} capabilities={caps} identity={identity} notice={null}
      onAuthenticated={onAuthenticated} onRetryCapabilities={onRetryCapabilities} /><BeforePassive run={() => beforePassive()} /></>;
    return strict ? <StrictMode>{content}</StrictMode> : content;
  };
  const view = await render(element());
  return { ...f, view, listeners, onAuthenticated, onRetryCapabilities,
    controller: () => view.UNSAFE_getByType(ForgotPasswordScreen).props.controller as React.ComponentProps<typeof ForgotPasswordScreen>['controller'],
    hostBack: () => view.UNSAFE_getByType(ForgotPasswordScreen).props.onBack as () => void,
    async appState(state: AppStateStatus) { await act(async () => { for (const listener of [...listeners]) listener(state); }); },
    async replaceResources(next: FormResources, probe = () => {}) {
      resources = next; beforePassive = probe; await view.rerender(element()); beforePassive = () => {};
    },
    async replaceIdentity() { identity = {}; await view.rerender(element()); },
    async updateCapabilities(next: Capabilities | null) { caps = next; await view.rerender(element()); },
  };
}
afterEach(async () => {
  await cleanup();
  await act(async () => { for (const finish of pendingCleanup.splice(0)) finish(); });
  jest.useRealTimers();
});
const press = async (id: string) => { await fireEvent.press(screen.getByTestId(id)); };
async function open() { await press('a-signin-email'); await press('a-email-forgot'); }
async function request() {
  await fireEvent.changeText(screen.getByTestId('recovery-email-input'), ' Person@Example.test ');
  await press('recovery-request');
}
async function secrets(code = '12345678', password = 'synthetic-new-password') {
  await fireEvent.changeText(screen.getByTestId('recovery-code-input'), code);
  await fireEvent.changeText(screen.getByTestId('recovery-password-input'), password);
}

test('render and create mode are inert; ordinary email sign-in still uses its existing endpoint', async () => {
  const f = await fixture();
  expect(f.calls).toHaveLength(0); expect(f.subscriptions.size).toBe(0);
  await press('a-signin-email');
  expect(screen.getByTestId('a-email-forgot')).toBeTruthy();
  expect(f.subscriptions.size).toBe(0);
  await press('a-email-mode');
  expect(screen.queryByTestId('a-email-forgot')).toBeNull();
  expect(f.calls).toHaveLength(0); expect(f.subscriptions.size).toBe(0);
  await press('a-email-mode');
  await fireEvent.changeText(screen.getByTestId('a-email-field-input'), 'ordinary@example.test');
  await fireEvent.changeText(screen.getByTestId('a-password-field-input'), 'synthetic-password');
  await press('a-email-submit');
  expect(f.calls.map(call => call.path)).toEqual(['/api/auth/sign-in/email']);
  expect(f.onAuthenticated).toHaveBeenCalledTimes(1);
});

test.each(['unconfigured', 'unknown', 'configured', '', undefined])('capability %s fails closed, retries only a read, and exits safely', async status => {
  const f = await fixture(); await f.updateCapabilities(capabilities(status)); await open();
  expect(screen.getByTestId('screen-recovery-unavailable')).toBeTruthy();
  expect(screen.getByText("Password reset isn't available on this Form service yet.")).toBeTruthy();
  await press('recovery-request'); await press('recovery-retry');
  expect(f.onRetryCapabilities).toHaveBeenCalledTimes(1);
  expect(f.calls).toHaveLength(0); expect(f.subscriptions.size).toBe(0);
  await press('recovery-sign-in'); expect(screen.getByTestId('screen-email')).toBeTruthy();
  await press('a-email-forgot'); await f.updateCapabilities(capabilities('verified'));
  expect(f.calls).toHaveLength(0); await press('recovery-open');
  expect(screen.getByTestId('screen-forgot-password-email')).toBeTruthy();
  expect(f.calls).toHaveLength(0);
});

test('missing capabilities never construct a port or dispatch a reset', async () => {
  const f = await fixture(); await f.updateCapabilities(null); await open();
  await press('recovery-request'); await press('a-back');
  expect(screen.getByTestId('screen-email')).toBeTruthy();
  expect(f.calls).toHaveLength(0); expect(f.subscriptions.size).toBe(0);
});

test.each(['configured_unverified', 'verified'])('configured %s recovery crosses the real boundary and only explicit confirmed return prefills sign-in', async status => {
  const f = await fixture(status); await open();
  expect(f.calls).toHaveLength(0); expect(f.subscriptions.size).toBeGreaterThan(0);
  const controller = f.controller();
  await request();
  expect(f.calls).toEqual([{ path: requestPath, method: 'POST', body: { email: 'person@example.test' }, authorization: null }]);
  await f.finish(); await secrets('1234567'); await press('recovery-submit');
  expect(f.calls).toHaveLength(1);
  await secrets(); await press('recovery-submit');
  expect(f.calls[1]).toEqual({ path: resetPath, method: 'POST', body: {
    email: 'person@example.test', otp: '12345678', password: 'synthetic-new-password',
  }, authorization: null });
  expect(screen.getByTestId('recovery-code-input').props.value).toBe('');
  expect(screen.getByTestId('recovery-password-input').props.value).toBe('');
  await f.finish(); expect(screen.getByTestId('screen-forgot-password-done')).toBeTruthy();
  expect(f.onAuthenticated).not.toHaveBeenCalled(); expect(f.storageEvents).toEqual([]);
  await press('recovery-sign-in');
  expect(screen.getByTestId('a-email-field-input').props.value).toBe('person@example.test');
  expect(screen.getByTestId('a-password-field-input').props.value).toBe('');
  expect(screen.getByText("You've been signed out everywhere. Sign in with your new password.")).toBeTruthy();
  expect(controller.snapshot().status).toBe('disposed'); expect(f.subscriptions.size).toBe(0);
  expect(f.onAuthenticated).not.toHaveBeenCalled(); expect(f.storageEvents).toEqual([]);
});

test('unknown reset returns with honest notice, empty fields and no saved transition or replay', async () => {
  const f = await fixture(); await open(); await request(); await f.finish(); await secrets(); await press('recovery-submit');
  const controller = f.controller(); await f.finish({ error: { code: 'unavailable' } }, 503);
  expect(controller.snapshot().status).toBe('unknown'); expect(controller.transition()).toBeNull();
  await press('recovery-submit'); expect(f.calls).toHaveLength(2);
  await press('recovery-sign-in');
  expect(screen.getByTestId('a-email-field-input').props.value).toBe('');
  expect(screen.getByTestId('a-password-field-input').props.value).toBe('');
  expect(screen.getByText("We couldn't confirm the reset. Try signing in with your new password; if that fails, request a new code.")).toBeTruthy();
  await f.appState('background'); await f.appState('active');
  expect(f.calls).toHaveLength(2); expect(f.onAuthenticated).not.toHaveBeenCalled(); expect(f.storageEvents).toEqual([]);
});

test('pending resend departure reports unconfirmed code delivery without claiming a reset', async () => {
  jest.useFakeTimers();
  const f = await fixture(); await open(); await request(); await f.finish();
  await act(async () => { jest.advanceTimersByTime(61000); });
  await press('recovery-resend'); expect(f.calls.map(call => call.path)).toEqual([requestPath, requestPath]);
  await f.appState('background');
  expect(screen.getByText("We couldn't confirm the code was sent. You can explicitly request a new code.")).toBeTruthy();
  await f.appState('active'); await f.finish();
  expect(f.calls).toHaveLength(2); expect(f.onAuthenticated).not.toHaveBeenCalled();
});

test.each(['request', 'reset'] as const)('late %s after host route departure cannot publish or dispatch through retained handlers', async operation => {
  const f = await fixture(); await open();
  const controller = f.controller(), depart = f.hostBack();
  if (operation === 'reset') { await request(); await f.finish(); await secrets(); await press('recovery-submit'); }
  else await request();
  // The frozen leaf blocks its visible Back while pending. Exercise the actual host callback separately.
  await act(async () => { depart(); });
  expect(screen.getByTestId('screen-email')).toBeTruthy();
  expect(screen.getByTestId('a-email-notice')).toBeTruthy();
  await press('a-email-forgot'); const replacement = f.controller();
  const count = f.calls.length;
  await act(async () => { depart(); await controller.requestCode('stale@example.test'); await controller.submit('12345678', 'synthetic-stale-password'); });
  expect(f.calls).toHaveLength(count); expect(f.controller()).toBe(replacement);
  await f.finish(); expect(controller.snapshot().status).toBe('disposed');
  expect(replacement.snapshot()).toMatchObject({ status: 'idle', step: 'email' });
  expect(f.onAuthenticated).not.toHaveBeenCalled(); expect(f.storageEvents).toEqual([]);
});

test.each(['request', 'reset'] as const)('background during %s removes subscriptions, clears the leaf, and foreground never revives its guard', async operation => {
  const f = await fixture(); await open(); const controller = f.controller();
  await request();
  if (operation === 'reset') { await f.finish(); await secrets(); await press('recovery-submit'); }
  await f.appState('background');
  expect(f.subscriptions.size).toBe(0); expect(controller.snapshot().status).toBe('disposed');
  expect(screen.getByTestId('screen-email')).toBeTruthy(); expect(screen.getByTestId('a-email-notice')).toBeTruthy();
  const count = f.calls.length; await f.appState('active');
  await act(async () => { await controller.requestCode('old@example.test'); await controller.submit('12345678', 'synthetic-old-password'); });
  await f.finish(); expect(f.calls).toHaveLength(count);
  await press('a-email-forgot'); expect(f.controller()).not.toBe(controller);
  expect(f.controller().snapshot()).toMatchObject({ step: 'email', status: 'idle' });
  expect(f.calls).toHaveLength(count); expect(f.onAuthenticated).not.toHaveBeenCalled();
});

test.each((['request', 'reset'] as const).flatMap(operation =>
  (['resources', 'same-api-resources', 'identity', 'transport-auth', 'capability'] as const).map(replacement => ({ operation, replacement }))))(
  '$replacement replacement fences pending original $operation before late completion', async ({ operation, replacement }) => {
  const f = await fixture(); await open(); await request();
  if (operation === 'reset') { await f.finish(); await secrets(); await press('recovery-submit'); }
  const controller = f.controller(), depart = f.hostBack(), next = transport();
  if (replacement === 'resources') await f.replaceResources(next.resources);
  else if (replacement === 'same-api-resources') await f.replaceResources(new FormResources(f.api));
  else if (replacement === 'identity') await f.replaceIdentity();
  else if (replacement === 'capability') await f.updateCapabilities(capabilities('unconfigured'));
  else await act(async () => { await f.api.signIn('replacement@example.test', 'synthetic-password'); });
  expect(screen.getByTestId('screen-email')).toBeTruthy();
  expect(f.subscriptions.size).toBe(0); expect(controller.snapshot().status).toBe('disposed');
  const count = f.calls.length, events = [...f.storageEvents];
  await act(async () => { depart(); await controller.submit('12345678', 'synthetic-stale-password'); });
  await f.finish(); expect(f.calls).toHaveLength(count); expect(next.calls).toHaveLength(0);
  expect(f.storageEvents).toEqual(events); expect(f.onAuthenticated).not.toHaveBeenCalled();
  expect(screen.queryByTestId('screen-forgot-password-done')).toBeNull();
});

test('visible Back leaves idle recovery and never preserves password or code in sign-in', async () => {
  const f = await fixture(); await open(); await request(); await f.finish(); await secrets();
  const controller = f.controller();
  await press('a-back'); expect(screen.getByTestId('screen-email')).toBeTruthy();
  expect(screen.getByTestId('a-email-field-input').props.value).toBe('');
  expect(screen.getByTestId('a-password-field-input').props.value).toBe('');
  expect(controller.snapshot().status).toBe('disposed'); expect(f.subscriptions.size).toBe(0);
  expect(f.calls).toHaveLength(1); expect(f.onAuthenticated).not.toHaveBeenCalled();
});

test('retained leaf reset handler is fenced in replacement layout before passive cleanup', async () => {
  const f = await fixture(); await open(); await request(); await f.finish(); await secrets();
  const controller = f.controller();
  const submit = screen.getByTestId('recovery-submit').props.onPress as () => void;
  const next = transport(); let observed: string | undefined;
  await f.replaceResources(next.resources, () => { observed = controller.snapshot().status; submit(); });
  expect(observed).toBe('disposed'); expect(f.calls).toHaveLength(1); expect(next.calls).toHaveLength(0);
  expect(screen.getByTestId('a-password-field-input').props.value).toBe('');
  expect(f.onAuthenticated).not.toHaveBeenCalled();
});

test('host-owned controller disposal leaves the frozen disposed leaf safely without a credential command', async () => {
  const f = await fixture(); await open(); const controller = f.controller(), depart = f.hostBack();
  await act(async () => { controller.dispose(); });
  expect(screen.getByTestId('screen-email')).toBeTruthy(); expect(f.subscriptions.size).toBe(0);
  await act(async () => { depart(); await controller.requestCode('old@example.test'); });
  expect(f.calls).toHaveLength(0); expect(f.onAuthenticated).not.toHaveBeenCalled();
});

test('StrictMode leaves render inert, removes original subscriptions on unmount and remount creates no recovery intent', async () => {
  const f = await fixture('verified', true);
  expect(f.subscriptions.size).toBe(0); expect(f.listeners.size).toBe(1);
  await open(); await request(); const controller = f.controller();
  await f.view.unmount();
  expect(f.listeners.size).toBe(0); expect(f.subscriptions.size).toBe(0);
  expect(controller.snapshot().status).toBe('disposed');
  const count = f.calls.length; await f.finish();
  const remount = await render(<StrictMode><AuthFlow resources={f.resources} capabilities={capabilities('verified')}
    notice={null} onAuthenticated={f.onAuthenticated} onRetryCapabilities={f.onRetryCapabilities} /></StrictMode>);
  expect(screen.getByTestId('screen-sign-in')).toBeTruthy(); expect(f.calls).toHaveLength(count);
  expect(f.subscriptions.size).toBe(0); expect(f.onAuthenticated).not.toHaveBeenCalled();
  await remount.unmount(); expect(f.listeners.size).toBe(0);
});
