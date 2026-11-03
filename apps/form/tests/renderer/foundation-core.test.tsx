import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { act, render, renderHook, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ReduceMotion } from 'react-native-reanimated';
import { hasIcon, Icon, iconNames, semanticIcon } from '../../src/features/shared/icons';
import { MovementIllustration, poseForMovement } from '../../src/features/shared/illustration';
import { fadeTiming, haptic, motionDuration, springConfig, staggerDelay, timingConfig } from '../../src/features/shared/motion';
import { MotionProvider, useMotionState, useReduceMotion } from '../../src/features/shared/motionProvider';

afterEach(() => { jest.useRealTimers(); });

describe('motion tokens', () => {
  test('springs honour the live Reduce Motion value explicitly', () => {
    expect(springConfig('standard', false)).toMatchObject({ stiffness: 260, damping: 30, mass: 1, reduceMotion: ReduceMotion.Never });
    expect(springConfig('press', true).reduceMotion).toBe(ReduceMotion.Always);
    expect(springConfig('gentle', false, 3).velocity).toBe(3);
  });

  test('fades always play, shorter under Reduce Motion; tweens can opt to keep essential progress', () => {
    expect(fadeTiming(false)).toMatchObject({ duration: motionDuration.quick, reduceMotion: ReduceMotion.Never });
    expect(fadeTiming(true)).toMatchObject({ duration: motionDuration.reduced, reduceMotion: ReduceMotion.Never });
    expect(timingConfig(300, true).reduceMotion).toBe(ReduceMotion.Always);
    expect(timingConfig(90_000, true, undefined, true).reduceMotion).toBe(ReduceMotion.Never);
  });

  test('transition durations stay inside the 150–400 ms band and stagger is capped', () => {
    for (const key of ['quick', 'confirm', 'base', 'page', 'ceiling'] as const) {
      expect(motionDuration[key]).toBeGreaterThanOrEqual(150);
      expect(motionDuration[key]).toBeLessThanOrEqual(400);
    }
    expect(staggerDelay(2, false)).toBe(2 * motionDuration.stagger);
    expect(staggerDelay(20, false)).toBe(motionDuration.staggerMaxSteps * motionDuration.stagger);
    expect(staggerDelay(3, true)).toBe(0);
  });

  test('haptic intents map to expo-haptics on iOS only', () => {
    const selection = jest.spyOn(Haptics, 'selectionAsync').mockResolvedValue(undefined);
    const notify = jest.spyOn(Haptics, 'notificationAsync').mockResolvedValue(undefined);
    haptic('selection');
    haptic('success');
    expect(selection).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
    const os = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try { haptic('error'); } finally { Object.defineProperty(Platform, 'OS', { value: os, configurable: true }); }
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('useReduceMotion', () => {
  test('a provider override wins and nested hooks share it', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <MotionProvider reduceMotion>{children}</MotionProvider>;
    const { result } = await renderHook(() => useMotionState(), { wrapper });
    expect(result.current).toEqual({ reduceMotion: true, resolved: true });
  });

  test('without an override it resolves from the system and follows later system changes', async () => {
    let listener: ((enabled: boolean) => void) | undefined;
    let answer: (enabled: boolean) => void = () => undefined;
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((event: string, callback: (enabled: boolean) => void) => {
      if (event === 'reduceMotionChanged') listener = callback;
      return { remove: () => undefined };
    }) as typeof AccessibilityInfo.addEventListener);
    const wrapper = ({ children }: { children: ReactNode }) => <MotionProvider>{children}</MotionProvider>;
    const { result } = await renderHook(() => useReduceMotion(), { wrapper });
    // Unknown readings behave as reduced until the system answers.
    expect(result.current).toBe(true);
    await act(async () => { answer(false); await Promise.resolve(); });
    expect(result.current).toBe(false);
    await act(() => listener?.(true));
    expect(result.current).toBe(true);
  });
});

describe('icons', () => {
  test('every listed icon renders and semantic choices are drawable', async () => {
    for (const name of iconNames) await render(<Icon name={name} />);
    for (const name of Object.values(semanticIcon)) expect(hasIcon(name)).toBe(true);
    expect(semanticIcon.retry).toBe('rotate-cw');
    expect(semanticIcon.undo).toBe('undo-2');
    expect(hasIcon('not-an-icon')).toBe(false);
  });

  test('icons are decorative unless labelled', async () => {
    await render(<Icon name="wifi-off" size="notice" testID="offline-glyph" accessibilityLabel="Offline" />);
    const glyph = screen.getByTestId('offline-glyph');
    expect(glyph.props.accessibilityLabel).toBe('Offline');
    expect(glyph.props.accessibilityRole).toBe('image');
    await render(<Icon name="play" testID="play-glyph" />);
    expect(screen.getByTestId('play-glyph', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
  });
});

describe('movement illustrations', () => {
  test('draw a figure only where the pose matches the movement', () => {
    expect(poseForMovement({ exerciseId: 'goblet-squat' })).toBe('squat');
    expect(poseForMovement('Goblet squat')).toBe('squat');
    expect(poseForMovement({ exerciseId: 'bench-press', name: 'Bench press' })).toBeNull();
    expect(poseForMovement('split squat')).toBeNull();
    expect(poseForMovement(null)).toBeNull();
  });

  test('unmatched movements render nothing or the empty mat, never the squat figure', async () => {
    const { toJSON, rerender } = await render(<MovementIllustration movement="bench-press" testID="art" />);
    expect(toJSON()).toBeNull();
    await rerender(<MovementIllustration movement="bench-press" fallback="mat" testID="art" />);
    expect(screen.getByTestId('art', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
    await rerender(<MotionProvider reduceMotion><MovementIllustration movement="goblet-squat" breathKey={1} testID="art" /></MotionProvider>);
    expect(screen.getByTestId('art', { includeHiddenElements: true })).toBeTruthy();
    // Decorative art is excluded from accessibility queries.
    expect(screen.queryByTestId('art')).toBeNull();
  });
});
