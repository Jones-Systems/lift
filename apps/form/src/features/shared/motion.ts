// Shared motion language for Form screens: duration, easing and spring tokens plus haptic intents.
// Values follow the Open Mat motion rules (purposeful, brief, interruptible, never blocking input):
// feedback lands within ~100 ms, UI transitions settle in 150–400 ms, value animations may take up to
// 600 ms because they never hold up navigation. Reduce Motion replaces travel with an opacity change
// (see useReduceMotion in motionProvider.tsx); never branch on the OS setting directly in a screen.
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Easing, ReduceMotion, type WithSpringConfig, type WithTimingConfig } from 'react-native-reanimated';
import { tokens } from '../../variants/a/tokens';

/** Durations in milliseconds. `press`/`reduced` are feedback, not transitions, so they sit below 150 ms. */
export const motionDuration = {
  instant: tokens.motion.immediate,
  /** Press-in (scale and pressed colour). */
  press: 90,
  /** Reduce Motion crossfade, icon swap, check fade (Open Mat `motion.reduced`). */
  reduced: tokens.motion.reduced,
  /** Colour/opacity state changes and small exits. */
  quick: 160,
  /** Check draw (Open Mat `motion.confirm`), toast exit, inline error reveal. */
  confirm: tokens.motion.confirm,
  /** Block fade-in; tab fade-through total. */
  base: 240,
  /** Ceiling-adjacent page and sheet tween fallback. */
  page: 380,
  /** Upper bound for any UI transition. */
  ceiling: 400,
  /** Value animations (number roll, progress fill); never block navigation. */
  value: 600,
  /** One error shake, played only on a failed confirm/submit attempt. */
  shake: 360,
  /** Change highlight: hold, then fade. */
  highlightHold: 400,
  highlightFade: 1200,
  /** Entrance stagger step between groups, between list rows, and the maximum number of steps. */
  stagger: 40,
  staggerRow: 30,
  staggerMaxSteps: 5,
  /** Toast display times (actionable toasts persist until acted on or dismissed). */
  toastInfo: 4000,
  toastSuccess: 3600,
  toastWarning: 6000,
  toastError: 7000,
  /** Minimum time an actionable but non-persistent toast stays visible. */
  toastActionMin: 10000,
  /** One ambient breath of the Open Mat figure (decorative; off under Reduce Motion). */
  breath: 4000,
} as const;

/** Travel distances in points. Small amplitude for an audience reading between sets. */
export const motionDistance = {
  entrance: 8,
  toast: 16,
  push: 1, // fraction of the container width for push/pop
  pushUnder: 0.25, // outgoing page offset fraction under a pushed page
  tab: 8,
  valueTick: 6,
  shake: 6,
} as const;

/** Press feedback scales: buttons, rows and cards (cards/rows move less because they are larger). */
export const motionScale = {
  button: 0.97,
  row: 0.985,
  card: 0.98,
  pop: 0.6,
  enterCard: 0.98,
} as const;

/** Tween easings (Reanimated easing functions). Springs below are preferred for position/size. */
export const motionEasing = {
  /** Default for entering, responding, fades and exits (Open Mat `motion.easeOut`). */
  out: Easing.bezier(...tokens.motion.easeOut),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  standard: Easing.bezier(0.2, 0, 0, 1),
  /** iOS-like sheet curve. */
  sheet: Easing.bezier(0.32, 0.72, 0, 1),
  /** Only for progress tied to a clock (rest timer drain) and indeterminate spinners. */
  linear: Easing.linear,
} as const;

type SpringPhysics = { stiffness: number; damping: number; mass: number };

/**
 * Spring presets (physics form, mass 1). Names match the Open Mat motion presets so screens cite names,
 * not numbers. `press`, `standard` and `gentle` are the three every screen needs; the rest are specialised.
 */
export const motionSpring = {
  /** Press release, drag catch-up, rubber-band return (critically damped, ~180 ms). */
  instant: { stiffness: 1755, damping: 83.8, mass: 1 },
  /** Small elements: chips, toggles, tab pill, toast enter, value ticks, row insert. */
  snappy: { stiffness: 520, damping: 38, mass: 1 },
  /** Content entrances, crossfades, tab content, cards. */
  smooth: { stiffness: 260, damping: 30, mass: 1 },
  /** Number roll, progress fill, figure settle, celebration settle. */
  gentle: { stiffness: 170, damping: 24, mass: 1 },
  /** The single completion pop on small elements only (check badge, ring close). Low overshoot. */
  lively: { stiffness: 386, damping: 29.5, mass: 1 },
  /** Push/pop and depth. */
  page: { stiffness: 340, damping: 36, mass: 1 },
  /** Sheet rise and settle. */
  sheet: { stiffness: 300, damping: 32, mass: 1 },
  /** Shared-element (continuity) morph. */
  morph: { stiffness: 280, damping: 32, mass: 1 },
} as const satisfies Record<string, SpringPhysics>;

export type SpringPreset = keyof typeof motionSpring | 'press' | 'standard' | 'bouncy';

const ALIAS: Record<'press' | 'standard' | 'bouncy', keyof typeof motionSpring> = {
  press: 'snappy',
  standard: 'smooth',
  bouncy: 'lively',
};

function physics(preset: SpringPreset): SpringPhysics {
  return preset in ALIAS ? motionSpring[ALIAS[preset as keyof typeof ALIAS]] : motionSpring[preset as keyof typeof motionSpring];
}

/**
 * Reanimated spring config for a preset. The caller's live Reduce Motion value is passed explicitly so a
 * system change made while the app runs is honoured (Reanimated alone only reads the launch-time value).
 * Under Reduce Motion the spring completes immediately; animate opacity with `fadeTiming` instead.
 */
export function springConfig(preset: SpringPreset, reduceMotion: boolean, velocity?: number): WithSpringConfig {
  return {
    ...physics(preset),
    ...(velocity === undefined ? null : { velocity }),
    reduceMotion: reduceMotion ? ReduceMotion.Always : ReduceMotion.Never,
  };
}

/** Tween config. Under Reduce Motion the tween completes immediately unless `keepUnderReducedMotion`. */
export function timingConfig(
  duration: number,
  reduceMotion: boolean,
  easing: WithTimingConfig['easing'] = motionEasing.out,
  keepUnderReducedMotion = false,
): WithTimingConfig {
  return {
    duration,
    easing,
    reduceMotion: reduceMotion && !keepUnderReducedMotion ? ReduceMotion.Always : ReduceMotion.Never,
  };
}

/**
 * Opacity fade that always plays (it is not movement): the normal duration with full motion, the short
 * Open Mat `motion.reduced` crossfade under Reduce Motion.
 */
export function fadeTiming(reduceMotion: boolean, duration: number = motionDuration.quick): WithTimingConfig {
  return {
    duration: reduceMotion ? motionDuration.reduced : duration,
    easing: reduceMotion ? motionEasing.linear : motionEasing.out,
    reduceMotion: ReduceMotion.Never,
  };
}

/** Stagger delay for the item at `index`, capped so the last group arrives by `staggerMaxSteps` steps. */
export function staggerDelay(index: number, reduceMotion: boolean, step: number = motionDuration.stagger): number {
  if (reduceMotion || index <= 0) return 0;
  return Math.min(index, motionDuration.staggerMaxSteps) * step;
}

/**
 * Haptic intents. One haptic per user action at most; none for passive events (background sync, timers
 * advancing) and none after the third tick of a long-press repeat. iOS only, like the existing selection
 * haptic; other platforms and failures are silent.
 */
export type HapticIntent = 'selection' | 'light' | 'medium' | 'success' | 'warning' | 'error';

export function haptic(intent: HapticIntent): void {
  if (Platform.OS !== 'ios') return;
  let pending: Promise<void>;
  switch (intent) {
    case 'selection': pending = Haptics.selectionAsync(); break;
    case 'light': pending = Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); break;
    case 'medium': pending = Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); break;
    case 'success': pending = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); break;
    case 'warning': pending = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); break;
    case 'error': pending = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); break;
  }
  void pending.catch(() => undefined);
}
