import 'react-native-gesture-handler/jestSetup';
import React from 'react';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo, StyleSheet, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { motionDuration } from '../../src/features/shared/motion';
import { MotionProvider } from '../../src/features/shared/motionProvider';
import { ToastProvider, useToast, type ToastApi, type ToastOptions } from '../../src/features/shared/toast';
import {
  initialToastState, newlyDismissed, renderedToasts, resolveSwipe, resolveToastTiming, toastReducer, TOAST_DURATION, TOAST_MAX_VISIBLE,
  visibleToasts, type ToastInput, type ToastState,
} from '../../src/features/shared/toastModel';

/* ---------------- model ---------------- */

const input = (id: string, extra: Partial<ToastInput> = {}): ToastInput => ({ id, tone: 'info', title: `Title ${id}`, ...extra });
const run = (state: ToastState, ...inputs: ToastInput[]) => inputs.reduce((acc, toast) => toastReducer(acc, { type: 'show', toast }), state);
const ids = (state: ToastState) => visibleToasts(state).map((record) => record.id);

describe('toast timing', () => {
  test('default durations stay in sync with the motion tokens', () => {
    expect(TOAST_DURATION).toEqual({
      info: motionDuration.toastInfo, success: motionDuration.toastSuccess, warning: motionDuration.toastWarning,
      error: motionDuration.toastError, actionMin: motionDuration.toastActionMin,
    });
  });

  test('transient defaults come from the tone', () => {
    expect(resolveToastTiming({ tone: 'info' })).toEqual({ persistent: false, durationMs: 4000 });
    expect(resolveToastTiming({ tone: 'success' })).toEqual({ persistent: false, durationMs: 3600 });
    expect(resolveToastTiming({ tone: 'warning' })).toEqual({ persistent: false, durationMs: 6000 });
    expect(resolveToastTiming({ tone: 'error' })).toEqual({ persistent: false, durationMs: 7000 });
  });

  test('error and warning toasts with an action persist; info and success get at least the action minimum', () => {
    const action = { label: 'Retry', onPress: () => undefined };
    expect(resolveToastTiming({ tone: 'error', action })).toEqual({ persistent: true, durationMs: null });
    expect(resolveToastTiming({ tone: 'warning', action })).toEqual({ persistent: true, durationMs: null });
    expect(resolveToastTiming({ tone: 'info', action })).toEqual({ persistent: false, durationMs: motionDuration.toastActionMin });
    expect(resolveToastTiming({ tone: 'success', action })).toEqual({ persistent: false, durationMs: motionDuration.toastActionMin });
    expect(resolveToastTiming({ tone: 'error', action, persistent: false })).toEqual({ persistent: false, durationMs: motionDuration.toastActionMin });
  });

  test('explicit options win over defaults', () => {
    expect(resolveToastTiming({ tone: 'info', durationMs: 1500 })).toEqual({ persistent: false, durationMs: 1500 });
    expect(resolveToastTiming({ tone: 'info', durationMs: 20000, action: {} })).toEqual({ persistent: false, durationMs: 20000 });
    expect(resolveToastTiming({ tone: 'info', persistent: true })).toEqual({ persistent: true, durationMs: null });
    expect(resolveToastTiming({ tone: 'info', durationMs: 0 })).toEqual({ persistent: true, durationMs: null });
  });
});

describe('toast reducer', () => {
  test('show resolves timing and lists newest first', () => {
    const state = run(initialToastState, input('a'), input('b', { tone: 'error', action: { label: 'Retry', onPress: () => undefined } }));
    expect(ids(state)).toEqual(['b', 'a']);
    expect(visibleToasts(state)[0]).toMatchObject({ persistent: true, durationMs: null, version: 1 });
    expect(visibleToasts(state)[1]).toMatchObject({ persistent: false, durationMs: 4000, version: 1 });
  });

  test('the same key updates in place, keeps the id and position, and bumps the version', () => {
    let state = run(initialToastState, input('a', { key: 'save', title: 'Saving' }), input('b'));
    state = toastReducer(state, { type: 'show', toast: input('ignored', { key: 'save', tone: 'success', title: 'Saved' }) });
    expect(ids(state)).toEqual(['b', 'a']);
    expect(visibleToasts(state)[1]).toMatchObject({ id: 'a', title: 'Saved', tone: 'success', version: 2, durationMs: 3600 });
  });

  test('a replacing show drops fields the new toast does not set', () => {
    let state = run(initialToastState, input('a', { key: 'k', body: 'old body', action: { label: 'Undo', onPress: () => undefined } }));
    state = toastReducer(state, { type: 'show', toast: input('x', { key: 'k', body: undefined, action: undefined }) });
    expect(visibleToasts(state)[0]).toMatchObject({ id: 'a', body: undefined, action: undefined });
  });

  test('update patches fields, re-resolves timing and bumps the version', () => {
    let state = run(initialToastState, input('a', { durationMs: 2000 }));
    state = toastReducer(state, { type: 'update', id: 'a', patch: { tone: 'error', title: 'Failed', action: { label: 'Retry', onPress: () => undefined } } });
    expect(visibleToasts(state)[0]).toMatchObject({ title: 'Failed', version: 2, persistent: true, durationMs: null });
    state = toastReducer(state, { type: 'update', id: 'a', patch: { persistent: false } });
    expect(visibleToasts(state)[0]).toMatchObject({ version: 3, persistent: false, durationMs: motionDuration.toastActionMin });
    expect(toastReducer(state, { type: 'update', id: 'missing', patch: { title: 'x' } })).toEqual(state);
  });

  test('a full window drops the oldest transient toast as overflow', () => {
    let state = run(initialToastState, input('a', { persistent: true }), input('b'), input('c'));
    expect(ids(state)).toEqual(['c', 'b', 'a']);
    state = run(state, input('d'));
    expect(ids(state)).toEqual(['d', 'c', 'a']);
    expect(visibleToasts(state)).toHaveLength(TOAST_MAX_VISIBLE);
    // The dropped toast stays in the rendered list until its exit finishes.
    expect(renderedToasts(state).map((record) => [record.id, record.leaving])).toEqual([['d', undefined], ['c', undefined], ['b', 'overflow'], ['a', undefined]]);
    expect(newlyDismissed(run(initialToastState, input('a', { persistent: true }), input('b'), input('c')), state).map((x) => [x.record.id, x.reason]))
      .toEqual([['b', 'overflow']]);
    state = toastReducer(state, { type: 'remove', id: 'b' });
    expect(renderedToasts(state).map((record) => record.id)).toEqual(['d', 'c', 'a']);
  });

  test('persistent toasts beyond the window wait and appear when space frees', () => {
    const persistent = (id: string) => input(id, { persistent: true });
    let state = run(initialToastState, persistent('a'), persistent('b'), persistent('c'), persistent('d'), input('e'));
    expect(ids(state)).toEqual(['c', 'b', 'a']);
    expect(state.queue.map((record) => record.id)).toEqual(['d', 'e']);
    state = toastReducer(state, { type: 'dismiss', id: 'b', reason: 'close' });
    // Space frees as soon as the dismissed toast starts leaving.
    expect(ids(state)).toEqual(['d', 'c', 'a']);
    expect(state.queue.map((record) => record.id)).toEqual(['e']);
    state = toastReducer(state, { type: 'remove', id: 'b' });
    expect(renderedToasts(state).map((record) => record.id)).toEqual(['d', 'c', 'a']);
  });

  test('dismiss marks the reason once; remove deletes; queued toasts are removed outright', () => {
    let state = run(initialToastState, input('a'), input('b'));
    state = toastReducer(state, { type: 'dismiss', id: 'a', reason: 'swipe' });
    state = toastReducer(state, { type: 'dismiss', id: 'a', reason: 'close' });
    expect(renderedToasts(state).find((record) => record.id === 'a')?.leaving).toBe('swipe');
    expect(ids(state)).toEqual(['b']);
    expect(toastReducer(state, { type: 'dismiss', id: 'missing' })).toEqual(state);
    state = toastReducer(state, { type: 'remove', id: 'a' });
    expect(renderedToasts(state).map((record) => record.id)).toEqual(['b']);

    const queued = run(initialToastState, input('p', { persistent: true }), input('q', { persistent: true }), input('r', { persistent: true }), input('s', { persistent: true }));
    expect(queued.queue).toHaveLength(1);
    const after = toastReducer(queued, { type: 'dismiss', id: 's' });
    expect(after.queue).toHaveLength(0);
    expect(newlyDismissed(queued, after).map((x) => x.record.id)).toEqual(['s']);
  });

  test('clear starts every toast leaving and drops the queue', () => {
    let state = run(initialToastState, input('a', { persistent: true }), input('b', { persistent: true }), input('c', { persistent: true }), input('d', { persistent: true }));
    state = toastReducer(state, { type: 'clear' });
    expect(visibleToasts(state)).toEqual([]);
    expect(state.queue).toEqual([]);
    expect(renderedToasts(state).every((record) => record.leaving === 'programmatic')).toBe(true);
  });
});

describe('swipe decision', () => {
  test('distance or velocity commits horizontally either way', () => {
    expect(resolveSwipe('top', 45, 0, 0, 0)).toEqual({ axis: 'x', sign: 1 });
    expect(resolveSwipe('top', -45, 0, 0, 0)).toEqual({ axis: 'x', sign: -1 });
    expect(resolveSwipe('top', 10, 0, 110, 0)).toEqual({ axis: 'x', sign: 1 });
    expect(resolveSwipe('top', 0, 0, -110, 0)).toEqual({ axis: 'x', sign: -1 });
    expect(resolveSwipe('top', 44, 0, 109, 0)).toBeNull();
  });

  test('only motion toward the stack edge commits vertically', () => {
    expect(resolveSwipe('top', 0, -45, 0, 0)).toEqual({ axis: 'y', sign: -1 });
    expect(resolveSwipe('top', 0, 60, 0, 300)).toBeNull();
    expect(resolveSwipe('bottom', 0, 45, 0, 0)).toEqual({ axis: 'y', sign: 1 });
    expect(resolveSwipe('bottom', 0, -60, 0, -300)).toBeNull();
    expect(resolveSwipe('top', 50, -120, 0, 0)).toEqual({ axis: 'y', sign: -1 });
  });
});

/* ---------------- provider ---------------- */

let api: ToastApi;
function Capture() {
  api = useToast();
  return null;
}

async function mount(props: { placement?: 'top' | 'bottom'; bottomOffset?: number; reduceMotion?: boolean } = {}) {
  const { reduceMotion = false, ...provider } = props;
  await render(
    <MotionProvider reduceMotion={reduceMotion}>
      <ToastProvider {...provider}><Capture /></ToastProvider>
    </MotionProvider>,
  );
}

async function show(options: ToastOptions): Promise<string> {
  let id = '';
  await act(async () => { id = api.show(options); });
  return id;
}

// RN's jest setup already mocks AccessibilityInfo, so spyOn returns the shared mock: clear earlier calls.
function spyOnAnnounce(method: 'announceForAccessibility' | 'announceForAccessibilityWithOptions') {
  const spy = jest.spyOn(AccessibilityInfo, method).mockImplementation(() => undefined);
  spy.mockClear();
  return spy;
}

const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });

// scheduleOnRN defers through queueMicrotask, which the exit animation callback relies on to finish removal.
beforeEach(() => { jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }); });
afterEach(() => { jest.useRealTimers(); });

describe('ToastProvider', () => {
  test('show renders the card with title and body, and returns its id', async () => {
    await mount();
    const id = await show({ tone: 'success', title: 'Workout saved', body: 'Logged to history' });
    expect(id).not.toBe('');
    expect(screen.getByTestId(`toast-${id}`)).toBeTruthy();
    expect(screen.getByText('Workout saved')).toBeTruthy();
    expect(screen.getByText('Logged to history')).toBeTruthy();
    expect(screen.getByTestId('toast-host').props.pointerEvents).toBe('box-none');
  });

  test('a custom testID names the card and the title/body read as one accessible group', async () => {
    await mount();
    await show({ tone: 'info', title: 'Synced', body: 'Just now', testID: 'sync' });
    expect(screen.getByTestId('toast-sync')).toBeTruthy();
    expect(screen.getByLabelText('Synced. Just now')).toBeTruthy();
  });

  test('error and warning announce assertively and carry the alert role; info and success announce politely', async () => {
    const withOptions = spyOnAnnounce('announceForAccessibilityWithOptions');
    await mount();
    const errorId = await show({ tone: 'error', title: 'Could not save', body: 'Check your connection' });
    expect(withOptions).toHaveBeenLastCalledWith('Could not save. Check your connection', { queue: false });
    expect(screen.getByTestId(`toast-${errorId}`).props.accessibilityRole).toBe('alert');
    expect(screen.getByTestId(`toast-${errorId}`).props.accessibilityLiveRegion).toBe('assertive');
    await show({ tone: 'warning', title: 'Offline' });
    expect(withOptions).toHaveBeenLastCalledWith('Offline', { queue: false });
    const infoId = await show({ tone: 'info', title: 'Synced' });
    expect(withOptions).toHaveBeenLastCalledWith('Synced', { queue: true });
    expect(screen.getByTestId(`toast-${infoId}`).props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId(`toast-${infoId}`).props.accessibilityRole).toBeUndefined();
    await show({ tone: 'success', title: 'Saved' });
    expect(withOptions).toHaveBeenLastCalledWith('Saved', { queue: true });
    expect(withOptions).toHaveBeenCalledTimes(4);
  });

  test('falls back to plain announcements when options are unavailable', async () => {
    const original = AccessibilityInfo.announceForAccessibilityWithOptions;
    const plain = spyOnAnnounce('announceForAccessibility');
    (AccessibilityInfo as { announceForAccessibilityWithOptions?: unknown }).announceForAccessibilityWithOptions = undefined;
    try {
      await mount();
      await show({ tone: 'error', title: 'Failed' });
      expect(plain).toHaveBeenCalledWith('Failed');
    } finally {
      AccessibilityInfo.announceForAccessibilityWithOptions = original;
    }
  });

  test('a transient toast dismisses itself after its tone duration with reason timeout', async () => {
    await mount();
    const onDismiss = jest.fn();
    await show({ tone: 'info', title: 'Hello', onDismiss });
    await advance(motionDuration.toastInfo - 1);
    expect(screen.getByText('Hello')).toBeTruthy();
    await advance(1);
    expect(screen.queryByText('Hello')).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(expect.any(String), 'timeout');
  });

  test('a persistent error toast with an action outlasts any display time until acted on', async () => {
    await mount();
    const onPress = jest.fn();
    const onDismiss = jest.fn();
    const id = await show({ tone: 'error', title: 'Upload failed', action: { label: 'Retry', onPress, icon: 'rotate-cw' }, onDismiss });
    await advance(60000);
    expect(screen.getByText('Upload failed')).toBeTruthy();
    expect(onPress).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('toast-action'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Upload failed')).toBeNull();
    expect(onDismiss).toHaveBeenCalledWith(id, 'action');
  });

  test('an actionable transient toast lasts at least the action minimum', async () => {
    await mount();
    await show({ tone: 'info', title: 'Set deleted', action: { label: 'Undo', onPress: () => undefined } });
    await advance(motionDuration.toastInfo + 1000);
    expect(screen.getByText('Set deleted')).toBeTruthy();
    await advance(motionDuration.toastActionMin);
    expect(screen.queryByText('Set deleted')).toBeNull();
  });

  test('the close button dismisses with reason close and is a labelled 44 pt button', async () => {
    await mount();
    const onDismiss = jest.fn();
    const id = await show({ tone: 'error', title: 'Oops', onDismiss });
    const close = screen.getByTestId('toast-dismiss');
    expect(close.props.accessibilityLabel).toBe('Dismiss notification');
    expect(close.props.accessibilityRole).toBe('button');
    expect(StyleSheet.flatten(close.props.style)).toMatchObject({ width: 44, height: 44 });
    await fireEvent.press(close);
    expect(screen.queryByText('Oops')).toBeNull();
    expect(onDismiss).toHaveBeenCalledWith(id, 'close');
  });

  test('api.dismiss and api.clear remove toasts as programmatic', async () => {
    await mount();
    const onDismiss = jest.fn();
    const a = await show({ tone: 'info', title: 'A', persistent: true, onDismiss });
    await show({ tone: 'info', title: 'B', persistent: true, onDismiss });
    await act(async () => { api.dismiss(a); });
    expect(screen.queryByText('A')).toBeNull();
    expect(screen.getByText('B')).toBeTruthy();
    await act(async () => { api.clear(); });
    expect(screen.queryByText('B')).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onDismiss).toHaveBeenNthCalledWith(1, a, 'programmatic');
  });

  test('the same key updates the visible toast in place and announces again', async () => {
    const withOptions = spyOnAnnounce('announceForAccessibilityWithOptions');
    await mount();
    const first = await show({ key: 'save', tone: 'info', title: 'Saving…' });
    const second = await show({ key: 'save', tone: 'success', title: 'Saved' });
    expect(second).toBe(first);
    expect(screen.queryByText('Saving…')).toBeNull();
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getAllByTestId(/^toast-toast-/)).toHaveLength(1);
    expect(withOptions).toHaveBeenCalledTimes(2);
    expect(withOptions).toHaveBeenLastCalledWith('Saved', { queue: true });
  });

  test('an update restarts the countdown', async () => {
    await mount();
    const id = await show({ tone: 'info', title: 'Working', durationMs: 2000 });
    await advance(1500);
    await act(async () => { api.update(id, { title: 'Still working' }); });
    await advance(1500);
    expect(screen.getByText('Still working')).toBeTruthy();
    await advance(600);
    expect(screen.queryByText('Still working')).toBeNull();
  });

  test('a fourth toast drops the oldest transient one as overflow', async () => {
    await mount();
    const onDismiss = jest.fn();
    const first = await show({ tone: 'info', title: 'One', onDismiss });
    await show({ tone: 'info', title: 'Two' });
    await show({ tone: 'info', title: 'Three' });
    await show({ tone: 'info', title: 'Four' });
    expect(screen.queryByText('One')).toBeNull();
    expect(screen.getByText('Two')).toBeTruthy();
    expect(screen.getByText('Four')).toBeTruthy();
    expect(onDismiss).toHaveBeenCalledWith(first, 'overflow');
  });

  test('persistent toasts past the limit queue and appear when space frees', async () => {
    await mount();
    const retry = { label: 'Retry', onPress: () => undefined };
    const a = await show({ tone: 'error', title: 'E1', action: retry });
    await show({ tone: 'error', title: 'E2', action: retry });
    await show({ tone: 'error', title: 'E3', action: retry });
    await show({ tone: 'error', title: 'E4', action: retry });
    expect(screen.queryByText('E4')).toBeNull();
    await act(async () => { api.dismiss(a); });
    expect(screen.getByText('E4')).toBeTruthy();
    expect(screen.queryByText('E1')).toBeNull();
  });

  test('placement bottom clears the safe area plus the tab bar offset', async () => {
    await mount({ placement: 'bottom', bottomOffset: 83 });
    await show({ tone: 'info', title: 'Hi' });
    const host = StyleSheet.flatten(screen.getByTestId('toast-host').props.style);
    expect(host.bottom).toBe(83 + 8);
    expect(host.top).toBeUndefined();
    expect(host.flexDirection).toBe('column-reverse');
  });

  test('placement top sits below the safe area', async () => {
    await mount();
    await show({ tone: 'info', title: 'Hi' });
    const host = StyleSheet.flatten(screen.getByTestId('toast-host').props.style);
    expect(host.top).toBe(8);
    expect(host.bottom).toBeUndefined();
  });

  test('reduce motion keeps toasts working', async () => {
    await mount({ reduceMotion: true });
    await show({ tone: 'success', title: 'Done' });
    expect(screen.getByText('Done')).toBeTruthy();
    await advance(motionDuration.toastSuccess);
    expect(screen.queryByText('Done')).toBeNull();
  });

  test('a swipe past the threshold dismisses with reason swipe; a short one springs back', async () => {
    await mount();
    const onDismiss = jest.fn();
    const id = await show({ tone: 'info', title: 'Swipe me', persistent: true, onDismiss });
    const pan = getByGestureTestId(`toast-pan-${id}`);
    await act(async () => { fireGestureHandler(pan, [{ translationX: 20, translationY: 0, velocityX: 0, velocityY: 0 }]); });
    expect(screen.getByText('Swipe me')).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => { fireGestureHandler(pan, [{ translationX: -80, translationY: 0, velocityX: -50, velocityY: 0 }]); });
    expect(screen.queryByText('Swipe me')).toBeNull();
    expect(onDismiss).toHaveBeenCalledWith(id, 'swipe');
  });

  test('touching a toast pauses its countdown and resumes with at least the resume floor', async () => {
    await mount();
    const id = await show({ tone: 'info', title: 'Held', durationMs: 2000 });
    await advance(1500);
    // 500 ms remain; a touch that does not commit pauses the clock and resumes with the 800 ms floor.
    await act(async () => { fireGestureHandler(getByGestureTestId(`toast-pan-${id}`), [{ translationX: 5, translationY: 0, velocityX: 0, velocityY: 0 }]); });
    await advance(700);
    expect(screen.getByText('Held')).toBeTruthy();
    await advance(200);
    expect(screen.queryByText('Held')).toBeNull();
  });
});

describe('useToast outside a provider', () => {
  test('is an inert API that returns an empty id and renders nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let outside: ToastApi | undefined;
    function Outside() {
      outside = useToast();
      return <Text>outside</Text>;
    }
    await render(<Outside />);
    await render(<Outside />);
    expect(outside?.show({ tone: 'error', title: 'Nope' })).toBe('');
    expect(() => { outside?.update('x', { title: 'y' }); outside?.dismiss('x'); outside?.clear(); }).not.toThrow();
    expect(screen.queryByText('Nope')).toBeNull();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
