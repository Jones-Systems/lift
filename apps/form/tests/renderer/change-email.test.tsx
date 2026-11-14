import React, { StrictMode } from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { CredentialIssueCode, CredentialOutcome, CredentialsPort } from '../../src/api/credentials';
import { createChangeEmailController } from '../../src/features/credentials/model';
import { ChangeEmailScreen } from '../../src/features/credentials/change-email';

const mockActions = new Map<string, () => void>();
jest.mock('../../src/features/shared/ui', () => {
  const actual = jest.requireActual<typeof import('../../src/features/shared/ui')>('../../src/features/shared/ui');
  const react = jest.requireActual<typeof import('react')>('react');
  return { ...actual, PrimaryAction: (props: React.ComponentProps<typeof actual.PrimaryAction>) => {
    if (props.onPress) mockActions.set(props.label, props.onPress);
    return react.createElement(actual.PrimaryAction, props);
  } };
});
afterEach(async () => { await cleanup(); mockActions.clear(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const saved: CredentialOutcome = { status: 'saved' };
function problem(code: CredentialIssueCode, unknown = false): CredentialOutcome {
  return { status: unknown ? 'unknown' : 'failed', issue: { code, status: unknown ? 0 : 422, effectUnknown: unknown } };
}
function fixture(refreshSettings?: () => Promise<void>) {
  const request = deferred<CredentialOutcome>();
  const confirm = deferred<CredentialOutcome>();
  const requests: Parameters<CredentialsPort['requestEmailChange']>[0][] = [];
  const confirmations: Parameters<CredentialsPort['changeEmail']>[0][] = [];
  const unsupported = async (): Promise<CredentialOutcome> => { throw new Error('Unexpected command'); };
  const port: CredentialsPort = {
    replacementGuard: { isCurrent: () => true }, isCurrent: () => true, dispose() {},
    requestPasswordReset: unsupported, resetPassword: unsupported, changePassword: unsupported,
    requestEmailChange(input) { requests.push(input); return request.promise; },
    changeEmail(input) { confirmations.push(input); return confirm.promise; },
  };
  const controller = createChangeEmailController(port, { currentEmail: 'old@example.invalid', refreshSettings });
  return { controller, request, confirm, requests, confirmations };
}
async function enterEmail(email = ' NEW@Example.invalid ', password = ' exact password ') {
  await fireEvent.changeText(screen.getByLabelText('New email'), email);
  await fireEvent.changeText(screen.getByLabelText('Current password'), password);
}
async function requestCode(f: ReturnType<typeof fixture>) {
  await enterEmail();
  await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
  await act(async () => { f.request.resolve(saved); });
}

test('normalizes only the email, clears secrets at dispatch, deduplicates pending commands and continues explicitly once', async () => {
  const f = fixture(); const onCompletion = jest.fn(); const onBack = jest.fn();
  await render(<ChangeEmailScreen controller={f.controller} onBack={onBack} onCompletion={onCompletion} />);
  await enterEmail();
  await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
  expect(screen.getByLabelText('Current password').props.value).toBe('');
  expect(f.requests).toEqual([{ newEmail: 'new@example.invalid', currentPassword: ' exact password ' }]);
  await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
  expect(f.requests).toHaveLength(1);
  await act(async () => { f.request.resolve(saved); });
  await fireEvent.changeText(screen.getByLabelText('8-digit code'), '12345678');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm email' }));
  expect(screen.getByLabelText('8-digit code').props.value).toBe('');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm email' }));
  expect(f.confirmations).toEqual([{ newEmail: 'new@example.invalid', otp: '12345678' }]);
  await act(async () => { f.confirm.resolve(saved); });
  expect(onCompletion).not.toHaveBeenCalled();
  const retained = mockActions.get('Continue');
  expect(retained).toBeDefined();
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  await act(async () => { retained?.(); });
  expect(onCompletion).toHaveBeenCalledTimes(1);
  expect(onCompletion).toHaveBeenCalledWith(f.controller.transition());
});

for (const email of ['broken', ' OLD@EXAMPLE.INVALID ']) {
  test(`rejects invalid or current target: ${email}`, async () => {
    const f = fixture();
    await render(<ChangeEmailScreen controller={f.controller} onBack={() => {}} onCompletion={() => {}} />);
    await enterEmail(email);
    await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
    expect(f.requests).toHaveLength(0);
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
  });
}

for (const code of ['invalid_code', 'INVALID_OTP', 'OTP_EXPIRED', 'EMAIL_ALREADY_IN_USE'] satisfies CredentialIssueCode[]) {
  test(`presents controller failure ${code} without completing`, async () => {
    const f = fixture(); const complete = jest.fn();
    await render(<ChangeEmailScreen controller={f.controller} onBack={() => {}} onCompletion={complete} />);
    await requestCode(f);
    await fireEvent.changeText(screen.getByLabelText('8-digit code'), code === 'invalid_code' ? '12' : '12345678');
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm email' }));
    await act(async () => { f.confirm.resolve(problem(code)); });
    expect(f.controller.snapshot().issue?.code).toBe(code);
    expect(screen.getByText(f.controller.snapshot().notice!)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
}

test('unknown confirmation never replays and only explicitly requests host readback', async () => {
  const f = fixture(); const read = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('read unavailable'));
  const complete = jest.fn();
  await render(<ChangeEmailScreen controller={f.controller} onBack={() => {}} onCompletion={complete} onReconcile={read} />);
  await requestCode(f);
  await fireEvent.changeText(screen.getByLabelText('8-digit code'), '12345678');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm email' }));
  await act(async () => { f.confirm.resolve(problem('network_unavailable', true)); });
  expect(read).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm email' }));
  expect(f.confirmations).toHaveLength(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh account details' }));
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.controller.snapshot().status).toBe('unknown');
  expect(screen.getByText('Account details could not be refreshed. Return to settings and try the read again.')).toBeTruthy();
  expect(complete).not.toHaveBeenCalled();
});

test('a failed settings read preserves known saved completion', async () => {
  const refresh = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('read failed'));
  const f = fixture(refresh);
  await render(<ChangeEmailScreen controller={f.controller} onBack={() => {}} onCompletion={() => {}} />);
  await requestCode(f);
  await fireEvent.changeText(screen.getByLabelText('8-digit code'), '12345678');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm email' }));
  await act(async () => { f.confirm.resolve(saved); });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(f.controller.snapshot()).toMatchObject({ status: 'saved', refreshRequired: true });
  expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
});

for (const disposed of [false, true]) {
  test(`explicit exit remains available during ${disposed ? 'disposed' : 'pending'} state`, async () => {
    const f = fixture(); const back = jest.fn();
    await render(<ChangeEmailScreen controller={f.controller} onBack={back} onCompletion={() => {}} />);
    await enterEmail();
    await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
    if (disposed) await act(async () => { f.controller.dispose(); });
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(back).toHaveBeenCalledTimes(1);
  });
}

test('replacement and unmount fence retained input handlers and late deferred results', async () => {
  const old = fixture(); const next = fixture(); const complete = jest.fn();
  const view = await render(<ChangeEmailScreen controller={old.controller} onBack={() => {}} onCompletion={complete} />);
  const oldAction = mockActions.get('Send code');
  const oldInput: (value: string) => void = screen.getByLabelText('New email').props.onChangeText;
  const oldSubmit: () => void = screen.getByLabelText('Current password').props.onSubmitEditing;
  await enterEmail();
  await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
  await view.rerender(<ChangeEmailScreen controller={next.controller} onBack={() => {}} onCompletion={complete} />);
  await act(async () => { oldInput('stale@example.invalid'); oldSubmit(); oldAction?.(); old.request.resolve(saved); });
  expect(screen.getByLabelText('New email').props.value).toBe('');
  expect(screen.getByLabelText('Current password').props.value).toBe('');
  expect(screen.queryByLabelText('8-digit code')).toBeNull();
  await view.unmount();
  await act(async () => { oldInput('unmounted@example.invalid'); oldSubmit(); });
  expect(next.requests).toHaveLength(0); expect(complete).not.toHaveBeenCalled();
});

test('StrictMode effect reattachment receives real deferred controller completion', async () => {
  const f = fixture();
  const view = await render(<StrictMode><ChangeEmailScreen controller={f.controller} onBack={() => {}} onCompletion={() => {}} /></StrictMode>);
  await requestCode(f);
  expect(screen.getByLabelText('8-digit code')).toBeTruthy();
  await view.unmount();
});

test('unknown without host readback stays safe and offers a settings return', async () => {
  const f = fixture();
  await render(<ChangeEmailScreen controller={f.controller} onBack={() => {}} onCompletion={() => {}} />);
  await requestCode(f);
  await fireEvent.changeText(screen.getByLabelText('8-digit code'), '12345678');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm email' }));
  await act(async () => { f.confirm.resolve(problem('network_unavailable', true)); });
  expect(screen.getByText('Return to settings to refresh account details.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Refresh account details' }));
  expect(f.confirmations).toHaveLength(1);
});

test('changed host callbacks fence retained handlers even for the same controller', async () => {
  const f = fixture(); const first = jest.fn(); const second = jest.fn();
  const view = await render(<ChangeEmailScreen controller={f.controller} onBack={first} onCompletion={() => {}} />);
  await enterEmail();
  const retained: () => void = screen.getByLabelText('Current password').props.onSubmitEditing;
  await view.rerender(<ChangeEmailScreen controller={f.controller} onBack={second} onCompletion={() => {}} />);
  await act(async () => { retained(); });
  expect(f.requests).toHaveLength(0);
  await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
  expect(f.requests).toHaveLength(1);
  await fireEvent.press(screen.getByRole('button', { name: 'Back to Settings' }));
  expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
  await act(async () => { f.request.resolve(saved); });
  expect(first).not.toHaveBeenCalled();
});

test('Continue uses a fresh transition and current host callback, fencing a retained old action', async () => {
  const read = deferred<void>(); const f = fixture(() => read.promise);
  const first = jest.fn(); const second = jest.fn();
  const view = await render(<ChangeEmailScreen controller={f.controller} onBack={() => {}} onCompletion={first} />);
  await requestCode(f);
  await fireEvent.changeText(screen.getByLabelText('8-digit code'), '12345678');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm email' }));
  await act(async () => { f.confirm.resolve(saved); });
  const retained = mockActions.get('Continue');
  expect(f.controller.transition()).toMatchObject({ refreshRequired: true });
  await view.rerender(<ChangeEmailScreen controller={f.controller} onBack={() => {}} onCompletion={second} />);
  await act(async () => { read.resolve(); retained?.(); });
  expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
  expect(second).toHaveBeenCalledWith(expect.objectContaining({ reason: 'email-changed', refreshRequired: false }));
});
