import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { CredentialOutcome, CredentialsPort } from '../../src/api/credentials';
import { createForgotPasswordController } from '../../src/features/credentials/model';
import { ForgotPasswordScreen } from '../../src/features/credentials/forgot-password';

const saved: CredentialOutcome = { status: 'saved' };
const failure = (code: 'INVALID_OTP' | 'invalid_password' | 'password_recovery_unavailable', status = 422): CredentialOutcome =>
  ({ status: 'failed', issue: { code, status, effectUnknown: false } });
function fixture() {
  const requests: { email: string }[] = [];
  let resets = 0;
  const completions: ((value: CredentialOutcome) => void)[] = [];
  let clock = Date.now();
  const unexpected = async (): Promise<CredentialOutcome> => { throw new Error('Unexpected credential operation'); };
  const port: CredentialsPort = {
    replacementGuard: { isCurrent: () => true }, isCurrent: () => true, dispose() {},
    requestPasswordReset: input => { requests.push(input); return new Promise(resolve => completions.push(resolve)); },
    resetPassword: () => { resets++; return new Promise(resolve => completions.push(resolve)); },
    changePassword: unexpected, requestEmailChange: unexpected, changeEmail: unexpected,
  };
  const controller = createForgotPasswordController(port, () => clock);
  const onBack = jest.fn(), onSignIn = jest.fn();
  return { controller, requests, get resets() { return resets; }, onBack, onSignIn,
    advance() { clock += 61000; },
    async finish(value = saved) { await act(async () => { completions.shift()!(value); }); },
    element: () => <ForgotPasswordScreen controller={controller} onBack={onBack} onSignIn={onSignIn} />,
  };
}
afterEach(async () => { await cleanup(); jest.useRealTimers(); });
const press = async (id: string) => { await fireEvent.press(screen.getByTestId(id)); };
async function enterEmail() {
  await fireEvent.changeText(screen.getByTestId('recovery-email-input'), ' Person@Example.test ');
  await press('recovery-request');
}
async function enterSecrets(password = 'synthetic-password') {
  await fireEvent.changeText(screen.getByTestId('recovery-code-input'), '12345678');
  await fireEvent.changeText(screen.getByTestId('recovery-password-input'), password);
}
async function codeFixture() {
  const f = fixture(); await render(f.element()); await enterEmail(); await f.finish(); return f;
}

test('email request normalizes input, deduplicates pending actions and shows enumeration-safe code notice', async () => {
  const f = fixture(); await render(f.element());
  expect(screen.getByTestId('screen-forgot-password-email')).toBeTruthy();
  expect(f.requests).toHaveLength(0);
  await enterEmail(); await press('recovery-request'); await press('recovery-sign-in');
  expect(f.requests).toEqual([{ email: 'person@example.test' }]);
  expect(f.onSignIn).not.toHaveBeenCalled();
  await f.finish();
  expect(screen.getByTestId('screen-forgot-password-code')).toBeTruthy();
  expect(screen.getByText('Check your email for an 8-digit code, if it belongs to a Form password account.')).toBeTruthy();
  expect(f.controller.transition()).toBeNull();
});

test('unconfigured service remains visibly unavailable', async () => {
  const f = fixture(); await render(f.element()); await enterEmail();
  await f.finish(failure('password_recovery_unavailable', 501));
  expect(screen.getByText("Password reset isn't available on this Form service yet.")).toBeTruthy();
  expect(screen.queryByTestId('screen-forgot-password-done')).toBeNull();
  expect(f.onSignIn).not.toHaveBeenCalled();
});

test('local password validation blocks dispatch; wrong code and server password rejection remain errors', async () => {
  const f = await codeFixture(); await enterSecrets('short'); await press('recovery-submit');
  expect(f.resets).toBe(0);
  await enterSecrets(); await press('recovery-submit');
  expect(screen.getByTestId('recovery-code-input').props.value).toBe('');
  expect(screen.getByTestId('recovery-password-input').props.value).toBe('');
  await press('recovery-submit'); expect(f.resets).toBe(1);
  await f.finish(failure('INVALID_OTP'));
  expect(screen.getByText("That code didn't work. Check it and try again.")).toBeTruthy();
  await enterSecrets(); await press('recovery-submit'); await f.finish(failure('invalid_password'));
  expect(screen.getByText('Use a password between 12 and 128 characters.')).toBeTruthy();
  expect(f.controller.transition()).toBeNull();
});

test('only confirmed reset reaches done, and sign-in requires explicit action with the saved transition', async () => {
  const f = await codeFixture(); await enterSecrets(); await press('recovery-submit');
  expect(screen.queryByTestId('screen-forgot-password-done')).toBeNull();
  await f.finish(); expect(screen.getByTestId('screen-forgot-password-done')).toBeTruthy();
  expect(f.onSignIn).not.toHaveBeenCalled(); await press('recovery-sign-in');
  expect(f.onSignIn).toHaveBeenCalledWith({ destination: 'sign-in', reason: 'password-reset', emailPrefill: 'person@example.test' });
});

test('unknown reset never completes or retries automatically and returns without a saved transition', async () => {
  const f = await codeFixture(); await enterSecrets(); await press('recovery-submit');
  await f.finish({ status: 'unknown', issue: { code: 'network_unavailable', status: 0, effectUnknown: true } });
  expect(screen.getByText("We couldn't confirm the reset. Try signing in with your new password; if that fails, request a new code.")).toBeTruthy();
  await enterSecrets(); await press('recovery-submit'); expect(f.resets).toBe(1);
  expect(f.controller.transition()).toBeNull(); await press('recovery-sign-in');
  expect(f.onSignIn).toHaveBeenCalledWith(null);
  await press('recovery-start-over'); expect(screen.getByTestId('screen-forgot-password-email')).toBeTruthy();
  expect(f.requests).toHaveLength(1);
});

test('cooldown gates resend until expiry and pending resend blocks conflicting actions', async () => {
  jest.useFakeTimers(); const f = await codeFixture();
  await press('recovery-resend'); expect(f.requests).toHaveLength(1);
  f.advance(); await act(async () => { jest.advanceTimersByTime(61000); });
  await press('recovery-resend'); expect(f.requests).toHaveLength(2);
  await press('recovery-start-over'); await press('recovery-sign-in');
  expect(f.controller.snapshot().step).toBe('code'); expect(f.onSignIn).not.toHaveBeenCalled();
  await f.finish();
});

test('replacement clears local secrets and ignores original disposed controller completion', async () => {
  const old = fixture(); const view = await render(old.element());
  await enterEmail(); await old.finish(); await enterSecrets(); await press('recovery-submit');
  const next = fixture();
  await act(async () => { old.controller.dispose(); });
  await view.rerender(next.element());
  await old.finish();
  expect(screen.getByTestId('screen-forgot-password-email')).toBeTruthy();
  expect(screen.getByTestId('recovery-email-input').props.value).toBe('');
  expect(next.requests).toHaveLength(0);
  await enterEmail(); await next.finish();
  expect(screen.getByTestId('recovery-code-input').props.value).toBe('');
  expect(screen.getByTestId('recovery-password-input').props.value).toBe('');
  expect(old.onSignIn).not.toHaveBeenCalled(); expect(next.onSignIn).not.toHaveBeenCalled();
  await act(async () => { next.controller.dispose(); });
  await press('recovery-resend'); await press('recovery-sign-in');
  expect(next.requests).toHaveLength(1); expect(next.onSignIn).not.toHaveBeenCalled();
});
