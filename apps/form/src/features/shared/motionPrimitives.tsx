// Shared motion primitives: press feedback, entrances, number roll, progress bar/ring and the completion
// moment. Durations, distances, springs and haptics come from motion.ts and Reduce Motion from
// useReduceMotion; nothing here blocks input (content is pressable from its first frame).
// Worklet note: callbacks passed to useAnimatedStyle/useAnimatedProps capture primitives and use Math only,
// so they run on the UI thread without calling plain JS helpers.
import { Children, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View, type GestureResponderEvent, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, G, RadialGradient, Stop } from 'react-native-svg';
import Reanimated, { useAnimatedProps, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { CheckMark } from '../../variants/a/art';
import { Txt } from '../../variants/a/primitives';
import type { ColorRole, TypeRole } from '../../variants/a/theme';
import {
  fadeTiming, haptic, motionDistance, motionDuration, motionEasing, motionScale, springConfig, staggerDelay, timingConfig,
  type HapticIntent,
} from './motion';
import { useReduceMotion } from './motionProvider';
import { light, t } from './tokens';

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/* ---------------- press feedback ---------------- */

/** Size class of a pressable: buttons scale the most, rows the least (larger surfaces move less). */
export type PressKind = 'button' | 'row' | 'card';

/** Opacity dip that replaces the scale under Reduce Motion. */
const PRESSED_OPACITY = 0.85;

/**
 * Press feedback for any pressable: scale to `motionScale[kind]` over `motionDuration.press`, release with the
 * `instant` spring. Under Reduce Motion nothing moves; opacity dips to 0.85 and is restored on release.
 * Pass `animatedStyle` to a Reanimated view and the handlers to its Pressable.
 */
export function usePressFeedback(opts: { kind?: PressKind; scale?: number; disabled?: boolean } = {}) {
  const { kind = 'button', scale, disabled = false } = opts;
  const reduce = useReduceMotion();
  const pressedScale = scale ?? motionScale[kind];
  const scaleValue = useSharedValue(1);
  const opacityValue = useSharedValue(1);

  useEffect(() => {
    if (!disabled) return;
    scaleValue.value = 1;
    opacityValue.value = 1;
  }, [disabled]);

  const onPressIn = useCallback(() => {
    if (disabled) return;
    if (reduce) opacityValue.value = withTiming(PRESSED_OPACITY, timingConfig(motionDuration.press, reduce, motionEasing.out, true));
    else scaleValue.value = withTiming(pressedScale, timingConfig(motionDuration.press, reduce));
  }, [disabled, reduce, pressedScale]);

  const onPressOut = useCallback(() => {
    scaleValue.value = withSpring(1, springConfig('instant', reduce));
    opacityValue.value = withTiming(1, timingConfig(motionDuration.press, reduce, motionEasing.out, true));
  }, [reduce]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacityValue.value,
    transform: [{ scale: scaleValue.value }],
  }));

  return { animatedStyle, onPressIn, onPressOut };
}

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);

/** Props of {@link PressFeedback}: Pressable props (minus render-function style/children) plus feedback options. */
export type PressFeedbackProps = Omit<PressableProps, 'style' | 'children'> & {
  kind?: PressKind;
  scale?: number;
  /** Haptic fired once from `onPress` (never from press-in, never when disabled). Omit for none. */
  haptic?: HapticIntent;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/**
 * Pressable with scale feedback and an optional haptic. Forwards accessibility props (role defaults to
 * `button`), `onPress`, `onLongPress` and `hitSlop`. A pointer leaving the target cancels the press without
 * firing, as with any Pressable.
 */
export function PressFeedback({
  kind, scale, haptic: intent, style, children, disabled, onPress, onPressIn, onPressOut,
  accessibilityRole = 'button', accessibilityState, ...rest
}: PressFeedbackProps) {
  const isDisabled = disabled === true;
  const feedback = usePressFeedback({ kind, scale, disabled: isDisabled });
  const handlePress = (event: GestureResponderEvent) => {
    if (isDisabled) return;
    if (intent) haptic(intent);
    onPress?.(event);
  };
  return (
    <AnimatedPressable
      {...rest}
      accessibilityRole={accessibilityRole}
      accessibilityState={isDisabled ? { ...accessibilityState, disabled: true } : accessibilityState}
      disabled={disabled}
      onPress={handlePress}
      onPressIn={(event) => { feedback.onPressIn(); onPressIn?.(event); }}
      onPressOut={(event) => { feedback.onPressOut(); onPressOut?.(event); }}
      style={[style, feedback.animatedStyle]}
    >
      {children}
    </AnimatedPressable>
  );
}

/* ---------------- entrances ---------------- */

/**
 * Entrance for one block: opacity 0→1 with a small rise (`up`), a scale from `motionScale.enterCard`
 * (`scale`) or a plain fade (`fade`). Position uses the `smooth` spring, opacity a short tween. The delay is
 * `delay` or the capped stagger step for `index`. Reduce Motion: a single short fade, no delay, no travel.
 * `play` is read on mount; false renders the final state at once (return visits do not animate).
 */
export function Entrance({ index = 0, delay, from = 'up', distance = motionDistance.entrance, play = true, children, style, testID }: {
  index?: number;
  delay?: number;
  from?: 'up' | 'fade' | 'scale';
  distance?: number;
  play?: boolean;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const reduce = useReduceMotion();
  const move = useSharedValue(play ? 0 : 1);
  const fade = useSharedValue(play ? 0 : 1);
  const wait = reduce ? 0 : (delay ?? staggerDelay(index, reduce));

  useEffect(() => {
    if (!play) return;
    if (reduce) {
      move.value = 1;
      fade.value = withTiming(1, fadeTiming(reduce));
      return;
    }
    move.value = withDelay(wait, withSpring(1, springConfig('smooth', reduce)));
    fade.value = withDelay(wait, withTiming(1, fadeTiming(reduce, motionDuration.base)));
  }, [play, reduce, wait]);

  const enterScale = motionScale.enterCard;
  const animatedStyle = useAnimatedStyle(() => {
    const travel = move.value;
    if (reduce || from === 'fade') return { opacity: fade.value };
    if (from === 'scale') return { opacity: fade.value, transform: [{ scale: enterScale + (1 - enterScale) * travel }] };
    return { opacity: fade.value, transform: [{ translateY: distance * (1 - travel) }] };
  });

  return <Reanimated.View testID={testID} style={[style, animatedStyle]}>{children}</Reanimated.View>;
}

/**
 * Wraps each element child in an {@link Entrance} with its index, so the group arrives in reading order with
 * the capped stagger. Use for the first entrance of a screen only; return visits pass `play={false}`.
 */
export function Stagger({ children, step = motionDuration.stagger, play = true, style }: {
  children?: ReactNode;
  step?: number;
  play?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const reduce = useReduceMotion();
  let position = 0;
  const items = Children.toArray(children).map((child) => {
    if (!isValidElement(child)) return child;
    const index = position;
    position += 1;
    return <Entrance key={child.key ?? index} index={index} delay={staggerDelay(index, reduce, step)} play={play}>{child}</Entrance>;
  });
  return <View style={style}>{items}</View>;
}

/* ---------------- number roll ---------------- */

const easeOutQuint = (progress: number) => 1 - Math.pow(1 - progress, 5);
const roundedText = (n: number) => String(Math.round(n));

/**
 * Number that rolls to a new `value` from the one currently shown (ease-out over `durationMs`, retargeting if
 * `value` changes mid-roll). It shows the final value at once on first mount unless `from` is given, and
 * under Reduce Motion. The accessibility label is always the final formatted value (or `accessibilityLabel`),
 * never an intermediate number. `format` receives fractional values while rolling; round inside it.
 */
export function AnimatedNumber({ value, format = roundedText, from, durationMs = motionDuration.value, role = 'stat', tone, style, testID, accessibilityLabel }: {
  value: number;
  format?: (n: number) => string;
  from?: number;
  durationMs?: number;
  role?: TypeRole;
  tone?: ColorRole;
  style?: StyleProp<TextStyle>;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const reduce = useReduceMotion();
  const displayed = useRef(from ?? value);
  const [shown, setShown] = useState(displayed.current);

  useEffect(() => {
    if (reduce || durationMs <= 0 || !Number.isFinite(value) || displayed.current === value) {
      displayed.current = value;
      setShown(value);
      return undefined;
    }
    const start = displayed.current;
    const startedAt = Date.now();
    let frame = 0;
    const tick = () => {
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      const next = progress >= 1 ? value : start + (value - start) * easeOutQuint(progress);
      displayed.current = next;
      setShown(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduce, durationMs]);

  return (
    <Txt role={role} tone={tone} style={style} testID={testID} accessibilityLabel={accessibilityLabel ?? format(value)}>
      {format(shown)}
    </Txt>
  );
}

/* ---------------- progress ---------------- */

/** `spring` (gentle) for value changes, or a timed fill: `linear` for clock-driven drains, `out` otherwise. */
export type ProgressTransition = 'spring' | { durationMs: number; easing?: 'linear' | 'out' };

type ProgressProps = {
  /** 0..1, clamped. */
  progress: number;
  transition?: ProgressTransition;
  color?: string;
  trackColor?: string;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Animates toward `progress` from the current rendered value. A timed linear transition is kept under
 * Reduce Motion (it is essential progress, e.g. a rest-timer drain); springs and eased fills complete at once.
 */
function useProgressValue(progress: number, transition: ProgressTransition) {
  const reduce = useReduceMotion();
  const clamped = clamp01(progress);
  const value = useSharedValue(clamped);
  const timed = transition !== 'spring';
  const durationMs = timed ? transition.durationMs : 0;
  const linear = timed && transition.easing === 'linear';

  useEffect(() => {
    if (!timed) {
      value.value = withSpring(clamped, springConfig('gentle', reduce));
    } else if (durationMs <= 0) {
      value.value = clamped;
    } else {
      value.value = withTiming(clamped, timingConfig(durationMs, reduce, linear ? motionEasing.linear : motionEasing.out, linear));
    }
  }, [clamped, reduce, timed, durationMs, linear]);

  return { value, clamped };
}

const progressValue = (clamped: number) => ({ min: 0, max: 100, now: Math.round(clamped * 100) });

/**
 * Horizontal progress bar. The fill scales on X from the left edge (transform only). Exposes a
 * `progressbar` role with a 0–100 value. For a clock-driven drain set `progress` to 0 once with
 * `{ durationMs: remainingMs, easing: 'linear' }`; never step it per second.
 */
export function ProgressBar({ progress, transition = 'spring', height = 8, color = t.color.action, trackColor = t.color.line, accessibilityLabel, testID, style }: ProgressProps & { height?: number }) {
  const { value, clamped } = useProgressValue(progress, transition);
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: Math.min(1, Math.max(0, value.value)) }] }));
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={progressValue(clamped)}
      style={[{ height, borderRadius: height / 2, backgroundColor: trackColor, overflow: 'hidden' }, style]}
    >
      <Reanimated.View style={[StyleSheet.absoluteFill, { backgroundColor: color, transformOrigin: 'left center' }, fillStyle]} />
    </View>
  );
}

const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);

/**
 * Circular progress starting at 12 o'clock with a round cap; `children` are centred inside. Same transition
 * and accessibility rules as {@link ProgressBar}.
 */
export function ProgressRing({ progress, transition = 'spring', size = 64, strokeWidth = 6, color = t.color.action, trackColor = t.color.line, accessibilityLabel, testID, style, children }: ProgressProps & {
  size?: number;
  strokeWidth?: number;
  children?: ReactNode;
}) {
  const { value, clamped } = useProgressValue(progress, transition);
  const centre = size / 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const arcProps = useAnimatedProps(() => {
    const fraction = Math.min(1, Math.max(0, value.value));
    // A zero-length round cap would draw a dot, so the arc is hidden at 0.
    return { strokeDashoffset: circumference * (1 - fraction), strokeOpacity: fraction <= 0.001 ? 0 : 1 };
  });
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={progressValue(clamped)}
      style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={StyleSheet.absoluteFill}>
        <Circle cx={centre} cy={centre} r={radius} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
        <G rotation={-90} origin={`${centre}, ${centre}`}>
          <AnimatedCircle
            cx={centre} cy={centre} r={radius} stroke={color} strokeWidth={strokeWidth} fill="none"
            strokeLinecap="round" strokeDasharray={[circumference, circumference]} animatedProps={arcProps}
          />
        </G>
      </Svg>
      {children}
    </View>
  );
}

/* ---------------- completion ---------------- */

const GLOW_SIZE = 176;
const BADGE_SIZE = 64;
const GLOW_PEAK = 0.6;
const GLOW_REST = 0.3;
/** Glow rises over the first half of the ~900 ms moment and settles over the second. */
const GLOW_LEG = 450;
const COPY_DELAY = 150;

function CompletionBody({ title, detail, onShown, testID, children }: {
  title: string;
  detail?: string;
  onShown?: () => void;
  testID?: string;
  children?: ReactNode;
}) {
  const reduce = useReduceMotion();
  const gradientId = `glow${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const glow = useSharedValue(0);
  const badgeOpacity = useSharedValue(0);
  const badgeScale = useSharedValue(reduce ? 1 : motionScale.pop);
  const copy = useSharedValue(0);
  const announced = useRef(false);
  const latest = useRef({ title, onShown });
  latest.current = { title, onShown };

  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    haptic('success');
    AccessibilityInfo.announceForAccessibility(latest.current.title);
    latest.current.onShown?.();
  }, []);

  useEffect(() => {
    if (reduce) {
      const fade = fadeTiming(true);
      glow.value = withTiming(GLOW_REST, fade);
      badgeOpacity.value = withTiming(1, fade);
      copy.value = withTiming(1, fade);
      return;
    }
    glow.value = withSequence(
      withTiming(GLOW_PEAK, timingConfig(GLOW_LEG, false)),
      withTiming(GLOW_REST, timingConfig(GLOW_LEG, false, motionEasing.inOut)),
    );
    badgeOpacity.value = withTiming(1, fadeTiming(false, motionDuration.quick));
    badgeScale.value = withSpring(1, springConfig('lively', false));
    copy.value = withDelay(COPY_DELAY, withTiming(1, fadeTiming(false, motionDuration.base)));
  }, [reduce]);

  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));
  const badgeStyle = useAnimatedStyle(() => ({ opacity: badgeOpacity.value, transform: [{ scale: badgeScale.value }] }));
  const copyStyle = useAnimatedStyle(() => ({ opacity: copy.value }));

  return (
    <View testID={testID} style={completion.root}>
      <View style={completion.stage}>
        <Reanimated.View
          style={[StyleSheet.absoluteFill, glowStyle]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Svg width={GLOW_SIZE} height={GLOW_SIZE} viewBox={`0 0 ${GLOW_SIZE} ${GLOW_SIZE}`}>
            <Defs>
              <RadialGradient id={gradientId} cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor={light.color.glowWarm} stopOpacity={1} />
                <Stop offset="1" stopColor={light.color.glowWarm} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={GLOW_SIZE / 2} cy={GLOW_SIZE / 2} r={GLOW_SIZE / 2} fill={`url(#${gradientId})`} />
          </Svg>
        </Reanimated.View>
        <Reanimated.View style={[completion.badge, badgeStyle]}>
          <CheckMark size={BADGE_SIZE / 2} color={t.color.success} draw reduceMotion={reduce} />
        </Reanimated.View>
      </View>
      <Reanimated.View style={[completion.copy, copyStyle]}>
        <Txt role="sectionTitle" accessibilityRole="header" style={completion.centred}>{title}</Txt>
        {detail ? <Txt role="body" tone="secondary" style={completion.centred}>{detail}</Txt> : null}
      </Reanimated.View>
      {children}
    </View>
  );
}

/**
 * Calm completion: a soft warm glow, a check badge that pops once and draws its check, then the title and
 * detail. On becoming visible it fires a `success` haptic and announces the title once. Reduce Motion fades
 * everything in over `motionDuration.reduced` with no pop or glow pulse. Never a medal, flame, trophy or
 * confetti. Renders nothing while `visible` is false; showing it again replays it.
 */
export function CompletionMoment({ visible, title, detail, onShown, testID, children }: {
  visible: boolean;
  title: string;
  detail?: string;
  onShown?: () => void;
  testID?: string;
  children?: ReactNode;
}) {
  if (!visible) return null;
  return <CompletionBody title={title} detail={detail} onShown={onShown} testID={testID}>{children}</CompletionBody>;
}

const completion = StyleSheet.create({
  root: { alignItems: 'center' },
  stage: { width: GLOW_SIZE, height: GLOW_SIZE, alignItems: 'center', justifyContent: 'center' },
  badge: {
    width: BADGE_SIZE, height: BADGE_SIZE, borderRadius: t.radius.capsule, backgroundColor: t.color.successSurface,
    alignItems: 'center', justifyContent: 'center',
  },
  copy: { alignItems: 'center', gap: t.space.s8 },
  centred: { textAlign: 'center' },
});
