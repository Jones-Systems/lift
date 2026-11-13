import React from 'react';
import { afterEach, expect, jest, test } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { CredentialOutcome, CredentialsPort } from '../../src/api/credentials';
import { createChangePasswordController } from '../../src/features/credentials/model';
import { ChangePasswordScreen } from '../../src/features/credentials/change-password';
import { Nav, PlainAction } from '../../src/features/shared/ui';

jest.mock('../../src/features/shared/ui', () => {
  const actual = jest.requireActual<typeof import('../../src/features/shared/ui')>('../../src/features/shared/ui');
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ...actual,
    Nav: jest.fn((props: React.ComponentProps<typeof actual.Nav>) => React.createElement(actual.Nav, props)),
    PlainAction: jest.fn((props: React.ComponentProps<typeof actual.PlainAction>) => React.createElement(actual.PlainAction, props)),
  };
});

const currentPassword = ' old password ';
const newPassword = ' new password with spaces ';
function fixture() {
  let current = true;
  const requests: { input: { currentPassword: string; newPassword: string }; resolve: (outcome: CredentialOutcome) => void }[] = [];
  const unexpected = async (): Promise<CredentialOutcome> => { throw new Error('Unexpected credential command'); };
  const port: CredentialsPort = {
    replacementGuard: { isCurrent: () => current }, isCurrent: () => current,
    dispose() { current = false; }, requestPasswordReset: unexpected, resetPassword: unexpected,
    requestEmailChange: unexpected, changeEmail: unexpected,
    changePassword(input) { return new Promise(resolve => { requests.push({ input, resolve }); }); },
  };
  const controller = createChangePasswordController(port);
  return { controller, requests, expire() { current = false; },
    async finish(outcome: CredentialOutcome, index = 0) {
      await act(async () => { requests[index].resolve(outcome); });
    } };
}
const failure = (code: 'INVALID_PASSWORD' | 'unauthenticated' | 'session_changed'): CredentialOutcome => ({
  status: 'failed', issue: { code, status: code === 'unauthenticated' ? 401 : 409, effectUnknown: false },
});
afterEach(async () => {
  await cleanup();
  jest.mocked(Nav).mockClear(); jest.mocked(PlainAction).mockClear();
});
async function mount(f = fixture(), strict = false) {
  const onBack = jest.fn(), onContinue = jest.fn();
  const leaf = <ChangePasswordScreen controller={f.controller} onBack={onBack} onContinue={onContinue} />;
  const view = await render(strict ? <React.StrictMode>{leaf}</React.StrictMode> : leaf);
  return { ...f, onBack, onContinue, view };
}
async function fill(password = newPassword, confirmation = password) {
  await fireEvent.changeText(screen.getByLabelText('Current password'), currentPassword);
  await fireEvent.changeText(screen.getByLabelText('New password'), password);
  await fireEvent.changeText(screen.getByLabelText('Confirm new password'), confirmation);
}
const submit = () => fireEvent.press(screen.getByRole('button', { name: 'Change password' }));
const back = () => fireEvent.press(screen.getByRole('button', { name: 'Back to Settings' }));
function pressHandler(name: string): () => void {
  const handler = name === 'Back to Settings'
    ? jest.mocked(Nav).mock.calls.slice().reverse().find(([props]) => props.back === 'Settings')?.[0].onBack
    : jest.mocked(PlainAction).mock.calls.slice().reverse().find(([props]) => props.label === name)?.[0].onPress;
  if (!handler) throw new Error(`Missing action-boundary handler for ${name}`);
  return handler;
}
const proceed = () => fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

const strictModeCases: { name: string; outcome: CredentialOutcome; notice: string }[] = [
  { name: 'saved', outcome: { status: 'saved' }, notice: 'Password changed. Your other devices were signed out.' },
  { name: 'failed', outcome: failure('INVALID_PASSWORD'), notice: "That isn't your current password." },
  { name: 'unknown', outcome: { status: 'unknown', issue: { code: 'network_unavailable', status: 0, effectUnknown: true } },
    notice: "We couldn't confirm the change. If signing in later fails, use your new password." },
];
test.each(strictModeCases)('StrictMode replay keeps pending and $name completion visible', async ({ outcome, notice }) => {
  const didMount = jest.spyOn(ChangePasswordScreen.prototype, 'componentDidMount');
  const willUnmount = jest.spyOn(ChangePasswordScreen.prototype, 'componentWillUnmount');
  const f = await mount(fixture(), true);
  expect(didMount).toHaveBeenCalledTimes(2);
  expect(willUnmount).toHaveBeenCalledTimes(1);
  expect(f.requests).toHaveLength(0);
  await fill(); await submit();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].input).toEqual({ currentPassword, newPassword });
  expect(screen.getByText('Changing your password…')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  for (const label of ['Current password', 'New password', 'Confirm new password']) {
    expect(screen.getByLabelText(label).props.value).toBe('');
  }
  await f.finish(outcome);
  expect(f.controller.snapshot().status).toBe(outcome.status);
  expect(screen.queryByText('Changing your password…')).toBeNull();
  expect(screen.getByText(notice)).toBeTruthy();
  expect(f.onContinue).not.toHaveBeenCalled();
  if (outcome.status === 'saved') {
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    const retainedContinue = pressHandler('Continue');
    const transition = f.controller.transition();
    expect(transition).not.toBeNull();
    await proceed();
    await act(async () => { retainedContinue(); });
    expect(f.onContinue).toHaveBeenCalledTimes(1);
    expect(f.onContinue).toHaveBeenCalledWith(transition);
    await submit();
  } else {
    expect(f.controller.transition()).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await proceed();
    expect(f.onContinue).not.toHaveBeenCalled();
    if (outcome.status === 'unknown') { await fill(); await submit(); }
    else {
      await fill();
      expect(screen.getByLabelText('Current password').props.value).toBe(currentPassword);
      expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled();
    }
  }
  expect(f.requests).toHaveLength(1);
});

test('real validation rejects length and confirmation; exact untrimmed strings reach the port', async () => {
  const f = await mount();
  expect(f.requests).toHaveLength(0);
  await fill('short'); await submit();
  expect(f.controller.snapshot().issue?.code).toBe('invalid_password');
  await fill(newPassword, 'different'); await submit();
  expect(f.controller.snapshot().issue?.code).toBe('password_mismatch');
  expect(f.requests).toHaveLength(0);
  await fill(); await submit();
  expect(f.requests[0].input).toEqual({ currentPassword, newPassword });
  await f.finish({ status: 'saved' });
  const publicState = JSON.stringify([f.controller.snapshot(), f.controller.transition()]);
  expect(publicState).not.toContain(currentPassword);
  expect(publicState).not.toContain(newPassword);
});

test('pending clears all fields and visibility, blocks edits and duplicate submits, and permits Back', async () => {
  const f = await mount(); await fill();
  await fireEvent.press(screen.getByRole('button', { name: 'Show current password' }));
  await submit(); await submit();
  for (const label of ['Current password', 'New password', 'Confirm new password']) {
    expect(screen.getByLabelText(label).props.value).toBe('');
    expect(screen.getByLabelText(label).props.secureTextEntry).toBe(true);
    await fireEvent.changeText(screen.getByLabelText(label), 'ignored');
    expect(screen.getByLabelText(label).props.value).toBe('');
  }
  await fireEvent.press(screen.getByRole('button', { name: 'Show current password' }));
  expect(screen.getByLabelText('Current password').props.secureTextEntry).toBe(true);
  await back(); expect(f.onBack).toHaveBeenCalledTimes(1);
  expect(f.requests).toHaveLength(1);
  expect(f.onContinue).not.toHaveBeenCalled();
  await f.finish({ status: 'saved' });
});

test('wrong current password permits explicit correction, and saved requires explicit Continue once', async () => {
  const f = await mount(); await fill(); await submit();
  await f.finish(failure('INVALID_PASSWORD'));
  expect(screen.getByText("That isn't your current password.")).toBeTruthy();
  await fill(); await submit(); expect(f.requests).toHaveLength(2);
  await proceed(); expect(f.onContinue).not.toHaveBeenCalled();
  await f.finish({ status: 'saved' }, 1);
  expect(f.onContinue).not.toHaveBeenCalled();
  const retainedContinue = pressHandler('Continue');
  await act(async () => { retainedContinue(); retainedContinue(); });
  await proceed(); await submit();
  expect(f.onContinue).toHaveBeenCalledTimes(1);
  expect(f.onContinue).toHaveBeenCalledWith(f.controller.transition());
  expect(f.requests).toHaveLength(2);
});

test('unknown has no confirmed target or replay and retains safe exit', async () => {
  const f = await mount(); await fill(); await submit();
  await f.finish({ status: 'unknown', issue: { code: 'network_unavailable', status: 0, effectUnknown: true } });
  expect(f.controller.transition()).toBeNull();
  expect(screen.getByText("We couldn't confirm the change. If signing in later fails, use your new password.")).toBeTruthy();
  await fill(); await submit(); await proceed(); await back();
  expect(f.requests).toHaveLength(1); expect(f.onContinue).not.toHaveBeenCalled();
  expect(f.onBack).toHaveBeenCalledTimes(1);
});

test('disposed initial presentation permits exit with zero commands', async () => {
  const source = fixture(); source.expire();
  const f = await mount(source); await fill(); await submit(); await proceed(); await back();
  expect(f.controller.snapshot().status).toBe('disposed');
  expect(f.requests).toHaveLength(0); expect(f.onContinue).not.toHaveBeenCalled();
  expect(f.onBack).toHaveBeenCalledTimes(1);
});

test('known session-ended result navigates only while its synthetic owner remains current', async () => {
  const f = await mount(); await fill(); await submit(); await f.finish(failure('unauthenticated'));
  await proceed();
  expect(f.onContinue).toHaveBeenCalledWith(expect.objectContaining({ destination: 'sign-in', reason: 'session-ended' }));
});

test('replacement fences retained handlers and late old completion; unmount fences the new handlers', async () => {
  const f = await mount(); await fill();
  const oldEdit = screen.getByLabelText('Current password').props.onChangeText;
  const oldSubmit = screen.getByLabelText('Confirm new password').props.onSubmitEditing;
  const oldBack = pressHandler('Back to Settings');
  await submit();
  const next = fixture(), nextBack = jest.fn(), nextContinue = jest.fn();
  await f.view.rerender(<ChangePasswordScreen controller={next.controller} onBack={nextBack} onContinue={nextContinue} />);
  await act(async () => { oldEdit('stale'); oldSubmit(); oldBack(); });
  await f.finish({ status: 'saved' });
  expect(screen.getByLabelText('Current password').props.value).toBe('');
  expect(next.requests).toHaveLength(0); expect(f.onBack).not.toHaveBeenCalled();
  expect(f.onContinue).not.toHaveBeenCalled(); expect(nextContinue).not.toHaveBeenCalled();
  await fill(); await submit();
  const retainedSubmit = screen.getByLabelText('Confirm new password').props.onSubmitEditing;
  const retainedBack = pressHandler('Back to Settings');
  const retainedContinue = pressHandler('Continue');
  await f.view.unmount();
  await act(async () => { retainedSubmit(); retainedBack(); retainedContinue(); });
  await next.finish({ status: 'saved' });
  await act(async () => { retainedContinue(); });
  expect(next.requests).toHaveLength(1); expect(nextBack).not.toHaveBeenCalled();
  expect(nextContinue).not.toHaveBeenCalled();
});

test('saved Continue reads currentness again and retained navigation cannot survive replacement', async () => {
  const f = await mount(); await fill(); await submit(); await f.finish({ status: 'saved' });
  const oldContinue = pressHandler('Continue');
  f.expire();
  await act(async () => { oldContinue(); });
  expect(f.onContinue).not.toHaveBeenCalled();
  const next = fixture(), onContinue = jest.fn();
  await f.view.rerender(<ChangePasswordScreen controller={next.controller} onBack={jest.fn()} onContinue={onContinue} />);
  await act(async () => { oldContinue(); });
  expect(onContinue).not.toHaveBeenCalled(); expect(next.requests).toHaveLength(0);
});
