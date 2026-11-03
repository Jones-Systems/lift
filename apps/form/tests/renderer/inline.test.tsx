import React, { useState } from 'react';
import { describe, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BusyIndicator, FieldError, InlineStatus, StatusBadge, useInlineTask } from '../../src/features/shared/inline';
import { Highlight, Shake, useHighlight, useShake } from '../../src/features/shared/motionFeedback';
import { MotionProvider } from '../../src/features/shared/motionProvider';
import { StepperField, TextAnswer } from '../../src/features/shared/ui';

// RN's jest setup already mocks AccessibilityInfo, so spyOn returns the shared mock: clear earlier calls.
function spyOnAnnounce() {
  const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  spy.mockClear();
  return spy;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const motion = (reduceMotion: boolean, children: React.ReactNode) => <MotionProvider reduceMotion={reduceMotion}>{children}</MotionProvider>;

describe('FieldError', () => {
  test('renders nothing for an empty message', async () => {
    const announce = spyOnAnnounce();
    await render(motion(false, <><FieldError message={null} testID="e1" /><FieldError message="" testID="e2" /><FieldError message={undefined} testID="e3" /></>));
    expect(screen.queryByTestId('e1')).toBeNull();
    expect(screen.queryByTestId('e2')).toBeNull();
    expect(screen.queryByTestId('e3')).toBeNull();
    expect(announce).not.toHaveBeenCalled();
  });

  test('is one polite alert that announces once when it appears and again when the text changes', async () => {
    const announce = spyOnAnnounce();
    const view = await render(motion(false, <FieldError message="Enter a name" testID="err" nativeID="name-error" />));
    const alert = screen.getByRole('alert');
    expect(alert.props.accessibilityLiveRegion).toBe('polite');
    expect(alert.props.accessibilityLabel).toBe('Enter a name');
    expect(screen.getByTestId('err').props.nativeID).toBe('name-error');
    expect(screen.getByText('Enter a name')).toBeTruthy();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith('Enter a name');

    await view.rerender(motion(false, <FieldError message="Enter a name" testID="err" nativeID="name-error" />));
    expect(announce).toHaveBeenCalledTimes(1);
    await view.rerender(motion(false, <FieldError message="Name is too long" testID="err" nativeID="name-error" />));
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith('Name is too long');

    await view.rerender(motion(false, <FieldError message={null} testID="err" nativeID="name-error" />));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('renders under Reduce Motion', async () => {
    await render(motion(true, <FieldError message="Required" />));
    expect(screen.getByText('Required')).toBeTruthy();
  });
});

describe('field integration', () => {
  function Harness({ errorMessage }: { errorMessage: string | null }) {
    const [value, setValue] = useState('');
    return <TextAnswer testID="name" label="Name" value={value} onChangeText={setValue} errorMessage={errorMessage} />;
  }

  test('TextAnswer shows the message and keeps what was typed', async () => {
    const view = await render(motion(false, <Harness errorMessage={null} />));
    expect(screen.queryByTestId('name-error')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('name-input'), 'Sam');
    await view.rerender(motion(false, <Harness errorMessage="Use at least 4 characters" />));
    expect(screen.getByTestId('name-input').props.value).toBe('Sam');
    expect(screen.getByDisplayValue('Sam')).toBeTruthy();
    expect(screen.getByTestId('name-error')).toBeTruthy();
    expect(screen.getByText('Use at least 4 characters')).toBeTruthy();
    expect(screen.getByTestId('name-input').props.accessibilityHint).toBe('Use at least 4 characters');

    await view.rerender(motion(false, <Harness errorMessage={null} />));
    expect(screen.getByTestId('name-input').props.value).toBe('Sam');
    expect(screen.queryByTestId('name-error')).toBeNull();
    expect(screen.getByTestId('name-input').props.accessibilityHint).toBeUndefined();
  });

  test('TextAnswer styles the box as an error for errorMessage, like the error flag', async () => {
    const styleOf = () => JSON.stringify(screen.getByTestId('name').props.style);
    const view = await render(motion(false, <TextAnswer testID="name" value="" onChangeText={() => undefined} />));
    const plain = styleOf();
    await view.rerender(motion(false, <TextAnswer testID="name" value="" onChangeText={() => undefined} errorMessage="Required" />));
    const withMessage = styleOf();
    await view.rerender(motion(false, <TextAnswer testID="name" value="" onChangeText={() => undefined} error />));
    expect(withMessage).not.toBe(plain);
    expect(styleOf()).toBe(withMessage);
  });

  test('StepperField shows the message under the field and keeps its steps working', async () => {
    const onStep = jest.fn();
    const view = await render(motion(false, <StepperField testID="reps" label="Reps" value="8" onStep={onStep} />));
    expect(screen.queryByTestId('reps-error')).toBeNull();
    await view.rerender(motion(false, <StepperField testID="reps" label="Reps" value="8" onStep={onStep} errorMessage="Reps must be at least 1" />));
    expect(screen.getByTestId('reps-error')).toBeTruthy();
    expect(screen.getByText('Reps must be at least 1')).toBeTruthy();
    expect(screen.getByTestId('reps').props.accessibilityHint).toBe('Reps must be at least 1');
    expect(screen.getByText('8')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Increase Reps'));
    expect(onStep).toHaveBeenCalledWith(1);
  });
});

describe('InlineStatus', () => {
  test('shows the tone icon and message with an alert role for errors', async () => {
    await render(motion(false, <InlineStatus tone="error" message="Could not sync this set" testID="status" />));
    expect(screen.getByText('Could not sync this set')).toBeTruthy();
    expect(screen.getByLabelText('Could not sync this set').props.accessibilityRole).toBe('alert');
    expect(screen.queryByTestId('status-retry')).toBeNull();
  });

  test('retry shows busy on the button until the promise settles and ignores presses meanwhile', async () => {
    const gate = deferred();
    const onRetry = jest.fn(() => gate.promise);
    await render(motion(false, <InlineStatus tone="error" message="Upload failed" onRetry={onRetry} testID="status" />));
    const button = () => screen.getByTestId('status-retry');
    expect(button().props.accessibilityLabel).toBe('Retry');
    expect(button().props.accessibilityState).toMatchObject({ busy: false });
    await fireEvent.press(button());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(button().props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    expect(screen.getByText('Retry')).toBeTruthy();
    await fireEvent.press(button());
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve(); });
    expect(button().props.accessibilityState).toMatchObject({ busy: false });
    expect(screen.getByText('Upload failed')).toBeTruthy();
  });

  test('a rejected retry keeps the error, becomes retryable again and does not throw', async () => {
    const gate = deferred();
    const onRetry = jest.fn(() => gate.promise);
    await render(motion(false, <InlineStatus tone="error" message="Upload failed" onRetry={onRetry} retryLabel="Try again" testID="status" />));
    await fireEvent.press(screen.getByTestId('status-retry'));
    await act(async () => { gate.reject(new Error('still offline')); });
    expect(screen.getByText('Upload failed')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
    expect(screen.getByTestId('status-retry').props.accessibilityState).toMatchObject({ busy: false });
    await fireEvent.press(screen.getByTestId('status-retry'));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test('a synchronous retry never shows busy', async () => {
    const onRetry = jest.fn<() => void>();
    await render(motion(true, <InlineStatus tone="warning" message="Offline" onRetry={onRetry} testID="status" />));
    await fireEvent.press(screen.getByTestId('status-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('status-retry').props.accessibilityState).toMatchObject({ busy: false });
  });

  test('busy tone exposes a busy state and the other tones render', async () => {
    const view = await render(motion(false, <InlineStatus tone="busy" message="Syncing" testID="status" />));
    expect(screen.getByLabelText('Syncing').props.accessibilityState).toMatchObject({ busy: true });
    for (const tone of ['success', 'info', 'warning', 'error'] as const) {
      await view.rerender(motion(false, <InlineStatus tone={tone} message={`Message ${tone}`} testID="status" />));
      expect(screen.getByText(`Message ${tone}`)).toBeTruthy();
    }
  });
});

describe('BusyIndicator', () => {
  test('is a labelled progressbar reporting busy', async () => {
    const view = await render(motion(false, <BusyIndicator testID="spinner" />));
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByTestId('spinner').props.accessibilityLabel).toBe('Loading');
    expect(screen.getByTestId('spinner').props.accessibilityState).toEqual({ busy: true });
    await view.rerender(motion(true, <BusyIndicator testID="spinner" label="Saving workout" />));
    expect(screen.getByLabelText('Saving workout')).toBeTruthy();
    expect(screen.getByTestId('spinner').props.accessibilityState).toEqual({ busy: true });
  });

  test('can be decorative inside a control that already reports busy', async () => {
    await render(motion(false, <BusyIndicator testID="spinner" decorative />));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByTestId('spinner', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
  });
});

describe('StatusBadge', () => {
  test('is decorative unless labelled', async () => {
    const view = await render(motion(false, <StatusBadge tone="error" testID="badge" />));
    expect(screen.getByTestId('badge', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
    await view.rerender(motion(false, <StatusBadge tone="success" testID="badge" accessibilityLabel="Saved" />));
    expect(screen.getByLabelText('Saved').props.accessibilityRole).toBe('image');
  });
});

describe('useInlineTask', () => {
  let task: ReturnType<typeof useInlineTask<string>>;
  function Probe() {
    task = useInlineTask<string>();
    return <Text>{task.state}</Text>;
  }

  test('moves idle → busy → success and returns the value', async () => {
    await render(<Probe />);
    expect(task.state).toBe('idle');
    const gate = deferred<string>();
    let result: Promise<string | undefined>;
    await act(async () => { result = task.run(() => gate.promise); });
    expect(task.state).toBe('busy');
    await act(async () => { gate.resolve('done'); });
    expect(await result!).toBe('done');
    expect(task.state).toBe('success');
    expect(task.error).toBeUndefined();
    await act(async () => { task.reset(); });
    expect(task.state).toBe('idle');
  });

  test('keeps the failure, resolves undefined and ignores re-entrant runs while busy', async () => {
    await render(<Probe />);
    const gate = deferred<string>();
    const work = jest.fn(() => gate.promise);
    let first: Promise<string | undefined>;
    await act(async () => { first = task.run(work); });
    let second: string | undefined = 'unset';
    await act(async () => { second = await task.run(work); });
    expect(second).toBeUndefined();
    expect(work).toHaveBeenCalledTimes(1);
    const failure = new Error('nope');
    await act(async () => { gate.reject(failure); });
    expect(await first!).toBeUndefined();
    expect(task.state).toBe('error');
    expect(task.error).toBe(failure);
    await act(async () => { await task.run(async () => 'again'); });
    expect(task.state).toBe('success');
  });

  test('reset during a run discards its outcome', async () => {
    await render(<Probe />);
    const gate = deferred<string>();
    await act(async () => { void task.run(() => gate.promise); });
    await act(async () => { task.reset(); });
    await act(async () => { gate.resolve('late'); });
    expect(task.state).toBe('idle');
  });
});

describe('motion feedback', () => {
  for (const reduceMotion of [false, true]) {
    test(`Shake plays on trigger changes without throwing (reduceMotion ${reduceMotion})`, async () => {
      const view = await render(motion(reduceMotion, <Shake trigger={0} testID="shake"><Text>content</Text></Shake>));
      expect(screen.getByText('content')).toBeTruthy();
      await view.rerender(motion(reduceMotion, <Shake trigger={1} testID="shake"><Text>content</Text></Shake>));
      await view.rerender(motion(reduceMotion, <Shake trigger={2} testID="shake"><Text>content</Text></Shake>));
      await view.rerender(motion(reduceMotion, <Shake trigger={null} testID="shake"><Text>content</Text></Shake>));
      expect(screen.getByText('content')).toBeTruthy();
    });

    test(`Highlight plays on trigger changes without throwing (reduceMotion ${reduceMotion})`, async () => {
      const view = await render(motion(reduceMotion, <Highlight trigger="a" tone="success" testID="hl"><Text>row</Text></Highlight>));
      await view.rerender(motion(reduceMotion, <Highlight trigger="b" tone="success" testID="hl"><Text>row</Text></Highlight>));
      await view.rerender(motion(reduceMotion, <Highlight trigger="c" testID="hl"><Text>row</Text></Highlight>));
      expect(screen.getByText('row')).toBeTruthy();
    });

    test(`hooks can be restarted repeatedly (reduceMotion ${reduceMotion})`, async () => {
      let shake: () => void = () => undefined;
      let highlight: (tone?: 'action' | 'success' | 'error' | 'warning') => void = () => undefined;
      function Hooks() {
        shake = useShake().shake;
        highlight = useHighlight().highlight;
        return <Text>hooks</Text>;
      }
      await render(motion(reduceMotion, <Hooks />));
      expect(() => {
        shake(); shake(); shake();
        highlight(); highlight('error'); highlight('warning');
      }).not.toThrow();
    });
  }
});
