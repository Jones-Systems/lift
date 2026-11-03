import React, { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo, Text } from 'react-native';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import * as motion from '../../src/features/shared/motion';
import { MotionProvider } from '../../src/features/shared/motionProvider';
import {
  AnimatedNumber, CompletionMoment, Entrance, PressFeedback, ProgressBar, ProgressRing, Stagger,
} from '../../src/features/shared/motionPrimitives';
import { StackTransition, TabTransition, useStackDirection } from '../../src/features/shared/motionTransitions';

afterEach(() => { jest.useRealTimers(); });

const withMotion = (ui: ReactElement, reduceMotion = false) => <MotionProvider reduceMotion={reduceMotion}>{ui}</MotionProvider>;
const mountMotion = (ui: ReactElement, reduceMotion = false) => render(withMotion(ui, reduceMotion));
const quietHaptic = () => jest.spyOn(motion, 'haptic').mockImplementation(() => undefined);
// The React Native jest mock is one shared jest.fn, so clear calls left by earlier tests.
const quietAnnounce = () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  announce.mockClear();
  return announce.mockImplementation(() => undefined);
};

describe('PressFeedback', () => {
  test('press fires onPress and the haptic intent once; press-in alone fires neither', async () => {
    const haptic = quietHaptic();
    const onPress = jest.fn();
    await mountMotion(<PressFeedback testID="save" haptic="light" onPress={onPress}><Text>Save</Text></PressFeedback>);
    await fireEvent(screen.getByTestId('save'), 'pressIn');
    expect(onPress).not.toHaveBeenCalled();
    expect(haptic).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('save'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith('light');
  });

  test('without a haptic intent it only calls onPress', async () => {
    const haptic = quietHaptic();
    const onPress = jest.fn();
    await mountMotion(<PressFeedback testID="plain" onPress={onPress}><Text>Plain</Text></PressFeedback>);
    await fireEvent.press(screen.getByTestId('plain'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptic).not.toHaveBeenCalled();
  });

  test('disabled never calls onPress or the haptic and reports the disabled state', async () => {
    const haptic = quietHaptic();
    const onPress = jest.fn();
    await mountMotion(
      <PressFeedback testID="locked" haptic="medium" disabled onPress={onPress} accessibilityLabel="Locked"><Text>Locked</Text></PressFeedback>,
    );
    await fireEvent.press(screen.getByTestId('locked'));
    expect(onPress).not.toHaveBeenCalled();
    expect(haptic).not.toHaveBeenCalled();
    expect(screen.getByTestId('locked').props.accessibilityState).toMatchObject({ disabled: true });
  });

  test('forwards role, label, hint, state, hit slop and long press', async () => {
    const onLongPress = jest.fn();
    await mountMotion(
      <PressFeedback
        testID="forwarded" accessibilityLabel="Finish workout" accessibilityHint="Saves the session"
        accessibilityState={{ busy: true }} hitSlop={12} onLongPress={onLongPress}
      ><Text>Finish</Text></PressFeedback>,
    );
    const button = screen.getByRole('button', { name: 'Finish workout' });
    expect(button).toBe(screen.getByTestId('forwarded'));
    expect(button.props.accessibilityHint).toBe('Saves the session');
    expect(button.props.accessibilityState).toMatchObject({ busy: true });
    await fireEvent(button, 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  test('a custom role replaces the default button role', async () => {
    await mountMotion(<PressFeedback testID="tab" accessibilityRole="tab" accessibilityLabel="Plan"><Text>Plan</Text></PressFeedback>);
    expect(screen.getByRole('tab', { name: 'Plan' })).toBe(screen.getByTestId('tab'));
  });

  test.each([true, false])('renders and presses with reduceMotion=%s', async (reduceMotion) => {
    const onPress = jest.fn();
    await mountMotion(<PressFeedback testID="row" kind="row" onPress={onPress}><Text>Row</Text></PressFeedback>, reduceMotion);
    await fireEvent(screen.getByTestId('row'), 'pressIn');
    await fireEvent(screen.getByTestId('row'), 'pressOut');
    await fireEvent.press(screen.getByTestId('row'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('Entrance and Stagger', () => {
  test.each([true, false])('Entrance children are visible and pressable immediately (reduceMotion=%s)', async (reduceMotion) => {
    const onPress = jest.fn();
    await mountMotion(
      <Entrance testID="entrance" index={3}><PressFeedback testID="inside" onPress={onPress}><Text>Inside</Text></PressFeedback></Entrance>,
      reduceMotion,
    );
    expect(screen.getByText('Inside')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('inside'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test.each(['up', 'fade', 'scale'] as const)('Entrance from=%s renders its children', async (from) => {
    await mountMotion(<Entrance from={from} delay={20}><Text>Block {from}</Text></Entrance>);
    expect(screen.getByText(`Block ${from}`)).toBeTruthy();
  });

  test('Entrance with play=false renders its children', async () => {
    await mountMotion(<Entrance play={false}><Text>Static</Text></Entrance>);
    expect(screen.getByText('Static')).toBeTruthy();
  });

  test('Stagger renders every child and each stays pressable, past the stagger cap', async () => {
    const presses = Array.from({ length: 8 }, () => jest.fn());
    await mountMotion(
      <Stagger>
        {presses.map((onPress, index) => (
          <PressFeedback key={index} testID={`item-${index}`} onPress={onPress}><Text>Item {index}</Text></PressFeedback>
        ))}
      </Stagger>,
    );
    for (const [index, onPress] of presses.entries()) {
      expect(screen.getByText(`Item ${index}`)).toBeTruthy();
      await fireEvent.press(screen.getByTestId(`item-${index}`));
      expect(onPress).toHaveBeenCalledTimes(1);
    }
  });

  test('Stagger skips empty children and still renders the elements', async () => {
    await mountMotion(<Stagger>{null}{false}<Text>First</Text>{undefined}<Text>Second</Text></Stagger>);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
  });
});

describe('AnimatedNumber', () => {
  test.each([true, false])('shows the final value and a final-value label on first mount (reduceMotion=%s)', async (reduceMotion) => {
    await mountMotion(<AnimatedNumber value={42} testID="count" />, reduceMotion);
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByTestId('count').props.accessibilityLabel).toBe('42');
  });

  test('rolls from `from`, keeping the label on the final value throughout', async () => {
    jest.useFakeTimers();
    await mountMotion(<AnimatedNumber value={40} from={0} testID="count" format={(n) => `${Math.round(n)} sets`} />);
    expect(screen.getByTestId('count').props.accessibilityLabel).toBe('40 sets');
    expect(screen.getByText('0 sets')).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(250); });
    const midway = Number(String(screen.getByTestId('count').props.children).replace(' sets', ''));
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(40);
    expect(screen.getByTestId('count').props.accessibilityLabel).toBe('40 sets');
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(screen.getByText('40 sets')).toBeTruthy();
    expect(screen.getByTestId('count').props.accessibilityLabel).toBe('40 sets');
  });

  test('Reduce Motion jumps straight to the final value', async () => {
    jest.useFakeTimers();
    await mountMotion(<AnimatedNumber value={40} from={0} testID="count" />, true);
    await act(async () => { jest.advanceTimersByTime(0); });
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.getByTestId('count').props.accessibilityLabel).toBe('40');
  });

  test('a new value mid-roll retargets from the displayed number and settles on the new final value', async () => {
    jest.useFakeTimers();
    const view = await mountMotion(<AnimatedNumber value={10} from={0} testID="count" />);
    await act(async () => { jest.advanceTimersByTime(200); });
    const shown = Number(screen.getByTestId('count').props.children);
    await view.rerender(withMotion(<AnimatedNumber value={30} testID="count" />));
    expect(screen.getByTestId('count').props.accessibilityLabel).toBe('30');
    expect(Number(screen.getByTestId('count').props.children)).toBeGreaterThanOrEqual(shown);
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(screen.getByText('30')).toBeTruthy();
  });

  test('an explicit accessibility label wins over the formatted value', async () => {
    await mountMotion(<AnimatedNumber value={7} testID="count" accessibilityLabel="7 sets recorded" />);
    expect(screen.getByTestId('count').props.accessibilityLabel).toBe('7 sets recorded');
  });

  test('unmounting mid-roll cancels the pending frame', async () => {
    jest.useFakeTimers();
    const cancel = jest.spyOn(globalThis, 'cancelAnimationFrame');
    const view = await mountMotion(<AnimatedNumber value={40} from={0} />);
    await act(async () => { jest.advanceTimersByTime(100); });
    cancel.mockClear();
    await view.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('ProgressBar and ProgressRing', () => {
  test.each([
    [0.426, 43], [1.7, 100], [-2, 0], [Number.NaN, 0],
  ])('ProgressBar progress %s exposes now=%s', async (progress, now) => {
    await mountMotion(<ProgressBar testID="bar" progress={progress} accessibilityLabel="Rest" />);
    const bar = screen.getByRole('progressbar', { name: 'Rest' });
    expect(bar).toBe(screen.getByTestId('bar'));
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100, now });
  });

  test('ProgressRing clamps, exposes the value and centres its children', async () => {
    await mountMotion(
      <ProgressRing testID="ring" progress={2} size={80} strokeWidth={8} accessibilityLabel="Rest timer"><Text>0:30</Text></ProgressRing>,
    );
    const ring = screen.getByRole('progressbar', { name: 'Rest timer' });
    expect(ring.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 100 });
    expect(screen.getByText('0:30')).toBeTruthy();
  });

  test.each([true, false])('a timed linear drain mounts and updates (reduceMotion=%s)', async (reduceMotion) => {
    const view = await mountMotion(<ProgressBar testID="drain" progress={1} />, reduceMotion);
    await view.rerender(withMotion(<ProgressBar testID="drain" progress={0} transition={{ durationMs: 30000, easing: 'linear' }} />, reduceMotion));
    expect(screen.getByTestId('drain').props.accessibilityValue).toEqual({ min: 0, max: 100, now: 0 });
    await view.rerender(withMotion(<ProgressRing testID="ring" progress={0.5} transition={{ durationMs: 400 }} />, reduceMotion));
    expect(screen.getByTestId('ring').props.accessibilityValue).toEqual({ min: 0, max: 100, now: 50 });
  });
});

describe('CompletionMoment', () => {
  test('visible announces the title and fires the success haptic once, then shows the copy', async () => {
    const haptic = quietHaptic();
    const announce = quietAnnounce();
    const onShown = jest.fn();
    const view = await mountMotion(<CompletionMoment visible title="Workout saved" detail="7 sets recorded" onShown={onShown} testID="done" />);
    expect(screen.getByText('Workout saved')).toBeTruthy();
    expect(screen.getByText('7 sets recorded')).toBeTruthy();
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith('success');
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Workout saved');
    expect(onShown).toHaveBeenCalledTimes(1);
    await view.rerender(withMotion(<CompletionMoment visible title="Workout saved" detail="8 sets recorded" onShown={onShown} testID="done" />));
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  test('not visible renders nothing and does nothing', async () => {
    const haptic = quietHaptic();
    const announce = quietAnnounce();
    await mountMotion(<CompletionMoment visible={false} title="Workout saved" testID="done" />);
    expect(screen.queryByText('Workout saved')).toBeNull();
    expect(screen.queryByTestId('done')).toBeNull();
    expect(haptic).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  test('becoming visible later fires once at that point', async () => {
    const haptic = quietHaptic();
    const announce = quietAnnounce();
    const view = await mountMotion(<CompletionMoment visible={false} title="Plan updated" />);
    await view.rerender(withMotion(<CompletionMoment visible title="Plan updated"><Text>Next</Text></CompletionMoment>));
    expect(screen.getByText('Plan updated')).toBeTruthy();
    expect(screen.getByText('Next')).toBeTruthy();
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  test('Reduce Motion still shows the copy and announces once', async () => {
    const haptic = quietHaptic();
    const announce = quietAnnounce();
    await mountMotion(<CompletionMoment visible title="Workout saved" />, true);
    expect(screen.getByText('Workout saved')).toBeTruthy();
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledTimes(1);
  });
});

describe('TabTransition', () => {
  function Counter({ label }: { label: string }) {
    const [count, setCount] = useState(0);
    return <PressFeedback testID={`counter-${label}`} onPress={() => setCount((n) => n + 1)}><Text>{`${label}:${count}`}</Text></PressFeedback>;
  }
  const tabs = (tab: 'a' | 'b') => (
    <TabTransition activeKey={tab} testID="tabs">{tab === 'a' ? <Text>Alpha</Text> : <Text>Beta</Text>}</TabTransition>
  );

  test.each([true, false])('switches content when the key changes (reduceMotion=%s)', async (reduceMotion) => {
    const view = await mountMotion(tabs('a'), reduceMotion);
    expect(screen.getByText('Alpha')).toBeTruthy();
    await view.rerender(withMotion(tabs('b'), reduceMotion));
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  test('does not remount children while the key is unchanged', async () => {
    const screenFor = (key: string) => <TabTransition activeKey={key}><Counter label="plan" /></TabTransition>;
    const view = await mountMotion(screenFor('plan'));
    await fireEvent.press(screen.getByTestId('counter-plan'));
    await fireEvent.press(screen.getByTestId('counter-plan'));
    expect(screen.getByText('plan:2')).toBeTruthy();
    await view.rerender(withMotion(screenFor('plan')));
    expect(screen.getByText('plan:2')).toBeTruthy();
  });

  test('content stays pressable straight after a switch', async () => {
    const onPress = jest.fn();
    const view = await mountMotion(tabs('a'));
    await view.rerender(withMotion(
      <TabTransition activeKey="b"><PressFeedback testID="next" onPress={onPress}><Text>Next</Text></PressFeedback></TabTransition>,
    ));
    await fireEvent.press(screen.getByTestId('next'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('StackTransition', () => {
  const stack = (routeKey: string, direction: 'push' | 'pop' | 'none') => (
    <StackTransition routeKey={routeKey} direction={direction} testID="stack"><Text>{`Route ${routeKey}`}</Text></StackTransition>
  );

  test.each([true, false])('push, pop and none all swap the routed content (reduceMotion=%s)', async (reduceMotion) => {
    const view = await mountMotion(stack('today', 'none'), reduceMotion);
    expect(screen.getByText('Route today')).toBeTruthy();
    await view.rerender(withMotion(stack('workout', 'push'), reduceMotion));
    expect(screen.getByText('Route workout')).toBeTruthy();
    await view.rerender(withMotion(stack('today', 'pop'), reduceMotion));
    expect(screen.getByText('Route today')).toBeTruthy();
    await view.rerender(withMotion(stack('settings', 'none'), reduceMotion));
    expect(screen.getByText('Route settings')).toBeTruthy();
  });

  test('a rapid second push retargets without throwing and keeps the new route pressable', async () => {
    const onPress = jest.fn();
    const view = await mountMotion(stack('a', 'none'));
    await view.rerender(withMotion(stack('b', 'push')));
    await view.rerender(withMotion(
      <StackTransition routeKey="c" direction="push"><PressFeedback testID="go" onPress={onPress}><Text>Go</Text></PressFeedback></StackTransition>,
    ));
    await fireEvent.press(screen.getByTestId('go'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('useStackDirection', () => {
  test('reports push when deeper, pop when shallower and none otherwise', async () => {
    const { result, rerender } = await renderHook(({ depth }: { depth: number }) => useStackDirection(depth), { initialProps: { depth: 1 } });
    expect(result.current).toBe('none');
    await rerender({ depth: 2 });
    expect(result.current).toBe('push');
    await rerender({ depth: 2 });
    expect(result.current).toBe('none');
    await rerender({ depth: 3 });
    expect(result.current).toBe('push');
    await rerender({ depth: 1 });
    expect(result.current).toBe('pop');
    await rerender({ depth: 1 });
    expect(result.current).toBe('none');
  });
});
