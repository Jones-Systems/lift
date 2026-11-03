// Feedback motion for inline states: a one-shot error shake and a change-highlight wash.
// Shake is travel, so Reduce Motion skips it (the message and icon already carry the meaning);
// the highlight is a colour fade, which stays under Reduce Motion.
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';
import { motionDistance, motionDuration, motionEasing, timingConfig } from './motion';
import { useReduceMotion } from './motionProvider';
import { t } from './tokens';

/** Offsets of one shake as fractions of motionDistance.shake: out, back, and three shrinking swings to rest. */
const SHAKE_STEPS = [-1, 1, -2 / 3, 2 / 3, -1 / 3, 0] as const;

/** Horizontal shake for a failed confirm or submit. `shake()` restarts if already playing; no-op under Reduce Motion. */
export function useShake() {
  const reduce = useReduceMotion();
  const x = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const shake = useCallback(() => {
    if (reduce) return;
    cancelAnimation(x);
    const config = timingConfig(motionDuration.shake / SHAKE_STEPS.length, false, motionEasing.inOut);
    const [first, ...rest] = SHAKE_STEPS.map((step) => withTiming(step * motionDistance.shake, config));
    x.value = 0;
    x.value = withSequence(first, ...rest);
  }, [reduce, x]);
  return { style, shake };
}

/** Plays a shake whenever `trigger` changes after mount (for example a submit-attempt counter). */
export function Shake({ trigger, children, style, testID }: {
  trigger: number | string | null | undefined; children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string;
}) {
  const { style: animated, shake } = useShake();
  const previous = useRef(trigger);
  useEffect(() => {
    if (Object.is(previous.current, trigger)) return;
    previous.current = trigger;
    if (trigger !== null && trigger !== undefined) shake();
  }, [trigger, shake]);
  return <Animated.View testID={testID} style={[style, animated]}>{children}</Animated.View>;
}

export type HighlightTone = 'action' | 'success' | 'error' | 'warning';

const WASH: Record<HighlightTone, string> = {
  action: t.color.selection,
  success: t.color.successSurface,
  error: t.color.errorSurface,
  warning: t.color.warningSurface,
};

/** Background wash that holds briefly, then fades out; marks a value that just changed. */
export function useHighlight() {
  const reduce = useReduceMotion();
  const color = useSharedValue<string>(t.color.transparent);
  const style = useAnimatedStyle(() => ({ backgroundColor: color.value }));
  const highlight = useCallback((tone: HighlightTone = 'action') => {
    cancelAnimation(color);
    color.value = WASH[tone];
    color.value = withDelay(
      motionDuration.highlightHold,
      withTiming(t.color.transparent, timingConfig(motionDuration.highlightFade, reduce, motionEasing.out, true)),
    );
  }, [reduce, color]);
  return { style, highlight };
}

/** Plays a highlight whenever `trigger` changes after mount. */
export function Highlight({ trigger, tone, children, style, testID }: {
  trigger: unknown; tone?: HighlightTone; children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string;
}) {
  const { style: animated, highlight } = useHighlight();
  const previous = useRef(trigger);
  useEffect(() => {
    if (Object.is(previous.current, trigger)) return;
    previous.current = trigger;
    highlight(tone);
  }, [trigger, tone, highlight]);
  return <Animated.View testID={testID} style={[style, animated]}>{children}</Animated.View>;
}
