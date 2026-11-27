import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo, AppState, type AppStateStatus } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { FormRuntime } from '../../src/FormRuntime';
import { createPhoneSignInAttempt } from '../../src/api/phoneSignIn';
import { FormResources } from '../../src/api/resources';
import { FormTransport, type SessionStorage } from '../../src/api/transport';
import { createAuthSession } from '../../src/integration/authSession';

jest.mock('expo-crypto', () => ({
  ...jest.requireActual<typeof import('expo-crypto')>('expo-crypto'),
  randomUUID: () => require('node:crypto').randomUUID(),
}));

const numbers = ['+12025550101', '+12025550102'] as const;
const retryNotice = 'Form couldn’t confirm the result. Retry the same action without changing it.';
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const failure = (code: string, status: number) => json({ error: { code, message: code } }, status);
const signed = () => json({ status: true, token: 'synthetic-unsigned', user: {
  id: '00000000-0000-4000-8000-000000000001', email: `${'a'.repeat(64)}@phone.form.invalid`,
  phoneNumber: numbers[0], phoneNumberVerified: true,
} }, 200, { 'set-auth-token': 'synthetic-issued-phone' });
const pendingCleanup: (() => void)[] = [];

function deferred<T>(fallback: () => T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  pendingCleanup.push(() => resolve(fallback()));
  return { promise, resolve };
}

afterEach(async () => {
  await cleanup();
  await act(async () => { pendingCleanup.splice(0).forEach(finish => finish()); });
});

type Call = { path: string; authorization: string | null; key: string | null; body: Record<string, unknown> };
type PhoneReply = (count: number) => Response | Promise<Response> | undefined;

async function mountPhone(options: {
  send?: PhoneReply; resend?: PhoneReply; verify?: PhoneReply;
  lateCapabilities?: Promise<Response>; firstRandom?: Promise<Uint8Array>;
} = {}) {
  const calls: Call[] = [];
  const saves: string[] = [];
  const storage: SessionStorage = {
    async load() { return null; },
    async save(value) { saves.push(value); },
    async clear() {},
  };
  const appStateListeners = new Set<(state: AppStateStatus) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    const change = listener as (state: AppStateStatus) => void;
    if (event === 'change') appStateListeners.add(change);
    return { remove: () => { appStateListeners.delete(change); } };
  });
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);

  let capabilityReads = 0, sends = 0, resends = 0, checks = 0, randomValue = 0, disposals = 0;
  const api = new FormTransport('https://form.renderer.invalid', storage, async (url, init) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, authorization: headers.get('Authorization'), key: headers.get('Idempotency-Key'), body });
    switch (path) {
      case '/v1/capabilities':
        if (++capabilityReads === 1 && options.lateCapabilities) return options.lateCapabilities;
        return json({ authentication: {
          emailPassword: { status: 'configured', registration: 'closed', passwordRecovery: 'unconfigured' },
          apple: { status: 'unconfigured' }, google: { status: 'unconfigured' }, phone: { status: 'configured_unverified' },
          session: { transport: 'bearer', expiresInSeconds: 3600 },
        } });
      case '/api/auth/phone-number/challenge': {
        const count = ++sends;
        return options.send?.(count) ?? json({
          challengeId: `00000000-0000-4000-8000-${String(count).padStart(12, '0')}`,
          phoneNumber: body.phoneNumber, status: 'pending',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          resendAfter: new Date(Date.now() + 30_000).toISOString(),
        });
      }
      case '/api/auth/phone-number/verify':
        return options.verify?.(++checks) ?? failure('invalid_phone_code', 400);
      case '/api/auth/phone-number/resend':
        return options.resend?.(++resends) ?? failure('unexpected_resend', 400);
      case '/api/auth/sign-out': return json({ success: true });
      default: throw new Error(`Unexpected synthetic request: ${path}`);
    }
  });
  const result = await render(<FormRuntime resources={new FormResources(api)} renderSettings={() => null} identity={{
    phoneFactory: guard => {
      const attempt = createPhoneSignInAttempt(api, {
        isCurrentSession: guard.isCurrent,
        randomBytes32: async () => {
          const count = ++randomValue;
          return count === 1 && options.firstRandom ? options.firstRandom : new Uint8Array(32).fill(count);
        },
      });
      return { ...attempt, dispose() { disposals++; attempt.dispose(); } };
    },
  }} />);
  if (options.lateCapabilities) {
    await waitFor(() => expect(capabilityReads).toBe(1));
    await fireEvent.press(await screen.findByRole('button', { name: 'Try again' }));
  }
  await fireEvent.press(await screen.findByTestId('a-signin-phone'));
  return {
    calls, saves, unmount: result.unmount, randomCalls: () => randomValue, disposals: () => disposals,
    challenges: () => calls.filter(call => call.path === '/api/auth/phone-number/challenge'),
    verifies: () => calls.filter(call => call.path === '/api/auth/phone-number/verify'),
    changeAppState: (state: AppStateStatus) => act(async () => appStateListeners.forEach(listener => listener(state))),
  };
}

const button = (name: string) => screen.getByRole('button', { name });
const enterNumber = (number: string) => fireEvent.changeText(screen.getByTestId('a-phone-field-input'), number);
const enterCode = (code: string) => fireEvent.changeText(screen.getByTestId('a-otp-field-input'), code);
const submit = (label: string) => fireEvent.press(button(label));

async function requestCode(number: string = numbers[0]) {
  await enterNumber(number);
  await submit('Text me a code');
}

async function firstCode() {
  await requestCode();
  await screen.findByTestId('screen-phone-code');
  await enterCode('123456');
}

test('an unguarded direct port cannot enable phone sign-in', () => {
  const identity = {
    apple: async () => {},
    phone: {
      challenge: () => { throw new Error('Unexpected direct challenge'); },
      resend: () => { throw new Error('Unexpected direct resend'); },
      verify: () => { throw new Error('Unexpected direct verify'); },
    },
  };
  const api = {} as FormTransport;
  const auth = createAuthSession(api, identity);
  auth.activate();
  expect(auth.phone).toBeUndefined();
});

test('Back reopens the same valid challenge and a changed number gets a new binding', async () => {
  const f = await mountPhone();
  await firstCode();
  await submit('Back to Phone');
  expect(screen.getByDisplayValue(numbers[0])).toBeTruthy();
  await submit('Enter code');
  expect(screen.getByTestId('a-otp-field-input').props.value).toBe('');
  expect(f.challenges()).toHaveLength(1);

  await submit('Back to Phone');
  await requestCode(numbers[1]);
  await screen.findByText('We sent a 6-digit code to (202) 555-0102.');
  expect(screen.getByTestId('a-otp-field-input').props.value).toBe('');
  const [first, second] = f.challenges();
  expect(f.challenges()).toHaveLength(2);
  expect(second.body.phoneNumber).toBe(numbers[1]);
  expect(second.body.binding).not.toBe(first.body.binding);
  expect(second.key).not.toBe(first.key);
});

test.each(['clock', 'server'] as const)('%s expiry offers an explicit restart with no implicit send', async expiry => {
  const start = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
  const f = await mountPhone({ verify: () => failure('phone_challenge_expired', 409) });
  await firstCode();
  expect(screen.getByRole('button', { name: 'Send a new code', disabled: true })).toBeTruthy();
  expect(screen.getByTestId('a-resend-countdown')).toBeTruthy();

  if (expiry === 'clock') clock.mockReturnValue(start + 60_000);
  else await submit('Verify');
  await screen.findByText('That code has expired', {}, { timeout: 2_500 });
  expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send a new code' })).toBeNull();
  expect(screen.queryByTestId('a-otp-field-input')).toBeNull();
  expect(f.disposals()).toBe(1);
  const callsBeforeRestart = f.calls.length;
  await submit('Start over');
  expect(screen.getByDisplayValue(numbers[0])).toBeTruthy();
  expect(f.calls).toHaveLength(callsBeforeRestart);
  await submit('Text me a code');
  await screen.findByTestId('screen-phone-code');
  expect(f.challenges()).toHaveLength(2);
  expect(f.challenges()[1].body.binding).not.toBe(f.challenges()[0].body.binding);
});

test('a resend near expiry preserves the binding and leaves Verify available', async () => {
  const start = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
  const challengeId = '00000000-0000-4000-8000-000000000001';
  const f = await mountPhone({ resend: () => json({
    challengeId, phoneNumber: numbers[0], status: 'pending',
    expiresAt: new Date(start + 60_000).toISOString(),
    resendAfter: new Date(start + 70_000).toISOString(),
  }) });
  await firstCode();
  clock.mockReturnValue(start + 40_000);
  await screen.findByRole('button', { name: 'Send a new code', disabled: false }, { timeout: 2_500 });
  await submit('Send a new code');
  await screen.findByText('Send a new code in 0:30');
  await submit('Verify');
  await screen.findByText('invalid_phone_code');
  expect(f.verifies()).toHaveLength(1);
  expect(f.verifies()[0].body).toMatchObject({ challengeId, binding: f.challenges()[0].body.binding });
});

test('an uncertain send replays exactly, then can start with a fresh binding after server expiry', async () => {
  const f = await mountPhone({ send: count => {
    if (count === 1) throw new Error('Synthetic lost response');
    if (count === 2) return failure('phone_challenge_expired', 409);
    if (count === 3) return failure('phone_challenge_cooldown', 429);
  } });
  await requestCode();
  await screen.findByText(retryNotice);
  await enterNumber(numbers[1]);
  expect(screen.getByRole('button', { name: 'Text me a code', disabled: true })).toBeTruthy();
  expect(f.challenges()).toHaveLength(1);
  await requestCode();
  await screen.findByText('That code has expired');
  expect(f.challenges()[1]).toEqual(f.challenges()[0]);

  await submit('Start over');
  expect(f.challenges()).toHaveLength(2);
  await submit('Text me a code');
  await screen.findByText('phone_challenge_cooldown');
  expect(f.challenges()[2].body.binding).not.toBe(f.challenges()[0].body.binding);
  expect(f.challenges()[2].key).not.toBe(f.challenges()[0].key);
  await submit('Text me a code');
  await screen.findByTestId('screen-phone-code');
  expect(f.challenges()).toHaveLength(4);
  expect(f.saves).toEqual([]);
});

test('an uncertain Verify keeps the exact proof and wire key through a generic 429', async () => {
  const f = await mountPhone({ verify: count => {
    if (count === 1) throw new Error('Synthetic lost response');
    if (count === 2) return json({ message: 'Too many requests' }, 429);
    if (count === 3) return failure('invalid_phone_code', 400);
    return failure('phone_challenge_consumed', 409);
  } });
  await firstCode();
  await submit('Verify');
  await screen.findByText(retryNotice);
  await submit('Verify');
  await screen.findByText(retryNotice);
  await enterCode('654321');
  expect(screen.getByRole('button', { name: 'Verify', disabled: true })).toBeTruthy();
  expect(f.verifies()).toHaveLength(2);

  await enterCode('123456');
  await submit('Verify');
  await screen.findByText('invalid_phone_code');
  expect(f.verifies()).toEqual(Array(3).fill(f.verifies()[0]));
  await enterCode('654321');
  await submit('Verify');
  await screen.findByText('That code is no longer available');
  expect(f.verifies()[3].key).not.toBe(f.verifies()[0].key);
  expect(f.verifies()[3].body).toEqual({ ...f.verifies()[0].body, code: '654321' });
  expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
  await submit('Start over');
  await submit('Text me a code');
  await screen.findByTestId('screen-phone-code');
  expect(f.verifies()).toHaveLength(4);
  expect(f.challenges()[1].body.binding).not.toBe(f.challenges()[0].body.binding);
  expect(f.saves).toEqual([]);
});

test.each(['Back', 'capability loss', 'background', 'clock expiry', 'unmount'] as const)(
  '%s fences a late signed Verify response before storage',
  async departure => {
    const startedAt = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(startedAt);
    const verify = deferred(signed);
    const capabilities = departure === 'capability loss' ? deferred(() => failure('unavailable', 503)) : null;
    const f = await mountPhone({ verify: () => verify.promise, lateCapabilities: capabilities?.promise });
    await firstCode();
    await submit('Verify');
    await waitFor(() => expect(f.verifies()).toHaveLength(1));

    if (departure === 'Back') {
      await submit('Back to Phone');
      expect(screen.getByText('A phone request is in progress.')).toBeTruthy();
      await enterNumber(numbers[1]);
      expect(screen.getByRole('button', { name: 'Text me a code', disabled: true })).toBeTruthy();
    } else if (capabilities) {
      await act(async () => { capabilities.resolve(failure('unavailable', 503)); });
      await screen.findByTestId('screen-sign-in');
      expect(screen.queryByTestId('screen-phone-code')).toBeNull();
    } else if (departure === 'background') {
      await f.changeAppState('background');
      await screen.findByText('That code is no longer available');
    } else if (departure === 'clock expiry') {
      clock.mockReturnValue(startedAt + 60_000);
      await screen.findByText('That code has expired', {}, { timeout: 2_500 });
      expect(f.disposals()).toBe(1);
    } else {
      await f.unmount();
    }

    await act(async () => { verify.resolve(signed()); });
    await waitFor(() => expect(f.calls.filter(call => call.path === '/api/auth/sign-out').map(call => call.authorization))
      .toEqual(['Bearer synthetic-issued-phone']));
    expect(f.saves).toEqual([]);
    expect(f.calls.filter(call => call.path === '/v1/me')).toEqual([]);
    if (departure === 'Back') {
      await submit('Text me a code');
      await screen.findByText('We sent a 6-digit code to (202) 555-0102.');
      expect(f.challenges()).toHaveLength(2);
    }
  },
);

test('departure before first dispatch allows the same number to start again', async () => {
  const random = deferred(() => new Uint8Array(32).fill(1));
  const f = await mountPhone({ firstRandom: random.promise });
  await requestCode();
  await waitFor(() => expect(f.randomCalls()).toBe(1));
  await submit('Back to Sign in');
  await fireEvent.press(await screen.findByTestId('a-signin-phone'));
  await act(async () => { random.resolve(new Uint8Array(32).fill(1)); });
  expect(f.challenges()).toEqual([]);
  await requestCode();
  await screen.findByTestId('screen-phone-code');
  expect(f.challenges()).toHaveLength(1);
});
