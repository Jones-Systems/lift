// Screen-level transitions for the custom router: tab content and push/pop. Both animate the incoming
// content only (the outgoing screen is already gone when the key changes), never intercept touches, and
// swap travel for an opacity crossfade under Reduce Motion.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { fadeTiming, motionDistance, motionDuration, springConfig, timingConfig } from './motion';
import { useReduceMotion } from './motionProvider';

/** Incoming leg of the tab fade-through (the outgoing leg belongs to the screen that just unmounted). */
const TAB_FADE_IN_MS = 210;
/** Opacity a pushed page starts from, so it lifts as it slides in. */
const PUSH_LIFT_FROM = 0.7;

/**
 * Container for tab content. When `activeKey` changes the incoming content fades in while rising from
 * `motionDistance.tab` over ~210 ms; the first mount does not animate and there is no stagger. Reduce Motion:
 * a short crossfade with no shift. Children are not keyed or remounted by this container; key them (or switch
 * their type) if a tab should start fresh. v0 animates the incoming content only, with no snapshot of the
 * outgoing tab.
 */
export function TabTransition({ activeKey, children, style, testID }: {
  activeKey: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const reduce = useReduceMotion();
  const opacity = useSharedValue(1);
  const shift = useSharedValue(0);
  const previousKey = useRef(activeKey);

  useLayoutEffect(() => {
    if (previousKey.current === activeKey) return;
    previousKey.current = activeKey;
    opacity.value = 0;
    if (reduce) {
      shift.value = 0;
      opacity.value = withTiming(1, fadeTiming(reduce));
      return;
    }
    shift.value = motionDistance.tab;
    opacity.value = withTiming(1, timingConfig(TAB_FADE_IN_MS, reduce));
    shift.value = withTiming(0, timingConfig(TAB_FADE_IN_MS, reduce));
  }, [activeKey]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateY: shift.value }] }));
  return <Reanimated.View testID={testID} style={[styles.fill, style, animatedStyle]}>{children}</Reanimated.View>;
}

/** Navigation direction between two routes. */
export type StackDirection = 'push' | 'pop' | 'none';

/**
 * Container for one stack level. On a `routeKey` change: `push` slides the incoming content in from the
 * container width with the `page` spring plus a quick opacity lift, `pop` brings it in from a quarter of the
 * width to the left with a fade, `none` does not animate. Reduce Motion: a short crossfade. A new key mid-flight
 * retargets from the current offset instead of restarting. v0 animates the incoming view only; it does not
 * keep a snapshot of the outgoing screen or track an edge-swipe.
 */
export function StackTransition({ routeKey, direction, children, style, testID }: {
  routeKey: string;
  direction: StackDirection;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const reduce = useReduceMotion();
  const window = useWindowDimensions();
  const measuredWidth = useRef(0);
  const offset = useSharedValue(0);
  const opacity = useSharedValue(1);
  const previousKey = useRef(routeKey);

  useLayoutEffect(() => {
    if (previousKey.current === routeKey) return;
    previousKey.current = routeKey;
    if (direction === 'none') {
      offset.value = 0;
      opacity.value = 1;
      return;
    }
    if (reduce) {
      offset.value = 0;
      opacity.value = 0;
      opacity.value = withTiming(1, fadeTiming(reduce, motionDuration.quick));
      return;
    }
    const span = measuredWidth.current || window.width;
    const inFlight = Math.abs(offset.value) > 0.5 || opacity.value < 0.99;
    if (!inFlight) {
      offset.value = direction === 'push' ? span * motionDistance.push : -span * motionDistance.pushUnder;
      opacity.value = direction === 'push' ? PUSH_LIFT_FROM : 0;
    }
    offset.value = withSpring(0, springConfig('page', reduce));
    opacity.value = withTiming(1, timingConfig(motionDuration.quick, reduce));
  }, [routeKey]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateX: offset.value }] }));
  const onLayout = (event: LayoutChangeEvent) => { measuredWidth.current = event.nativeEvent.layout.width; };
  return <Reanimated.View testID={testID} onLayout={onLayout} style={[styles.fill, style, animatedStyle]}>{children}</Reanimated.View>;
}

/**
 * Direction implied by a stack depth change: deeper is `push`, shallower is `pop`, unchanged is `none`.
 * Reflects the change in the render where `depth` changed; later renders at the same depth report `none`.
 */
export function useStackDirection(depth: number): StackDirection {
  const previous = useRef(depth);
  const direction: StackDirection = depth > previous.current ? 'push' : depth < previous.current ? 'pop' : 'none';
  useEffect(() => { previous.current = depth; });
  return direction;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
