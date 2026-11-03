// Inline error, warning, busy and success indicators on the affected element. The user's input is never
// touched: these only add a message, an icon, a corner badge or an in-place retry next to it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Txt } from '../../variants/a/primitives';
import { Icon, semanticIcon, type IconName, type IconSize } from './icons';
import { fadeTiming, motionDuration, motionEasing, timingConfig } from './motion';
import { Shake } from './motionFeedback';
import { useReduceMotion } from './motionProvider';
import { L, t } from './tokens';

/* ---------------- busy ---------------- */

/** One full turn of the busy spinner. */
const SPIN_MS = 900;
/** Points the error text rises from when it appears. */
const REVEAL_OFFSET = 4;

/**
 * Rotating loader-circle. Under Reduce Motion it is a static icon; the busy state is still exposed to
 * assistive tech. `decorative` hides it when a parent control already reports busy (for example a button).
 */
export function BusyIndicator({ label, size = 'standard', color, testID, decorative }: {
  label?: string; size?: IconSize | number; color?: string; testID?: string; decorative?: boolean;
}) {
  const reduce = useReduceMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduce) {
      cancelAnimation(turn);
      turn.value = 0;
      return undefined;
    }
    turn.value = 0;
    turn.value = withRepeat(withTiming(360, timingConfig(SPIN_MS, false, motionEasing.linear)), -1, false);
    return () => cancelAnimation(turn);
  }, [reduce, turn]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));
  const a11y = decorative
    ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const }
    : { accessible: true, accessibilityRole: 'progressbar' as const, accessibilityState: { busy: true }, accessibilityLabel: label ?? 'Loading' };
  return (
    <View testID={testID} {...a11y}>
      <Animated.View style={spin}><Icon name={semanticIcon.busy} size={size} color={color} /></Animated.View>
    </View>
  );
}

/* ---------------- field error ---------------- */

/**
 * Error text under a field. Renders nothing when empty; otherwise one accessible alert that is announced
 * when it appears or its text changes, and eases in (fade only under Reduce Motion).
 */
export function FieldError({ message, testID, nativeID }: { message: string | null | undefined; testID?: string; nativeID?: string }) {
  if (!message) return null;
  return <FieldErrorRow message={message} testID={testID} nativeID={nativeID} />;
}

function FieldErrorRow({ message, testID, nativeID }: { message: string; testID?: string; nativeID?: string }) {
  const reduce = useReduceMotion();
  const reveal = useSharedValue(0);
  useEffect(() => {
    reveal.value = withTiming(1, fadeTiming(reduce, motionDuration.confirm));
  }, [reduce, reveal]);
  useEffect(() => { AccessibilityInfo.announceForAccessibility(message); }, [message]);
  const style = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: reduce ? 0 : (1 - reveal.value) * -REVEAL_OFFSET }],
  }));
  return (
    <Animated.View testID={testID} nativeID={nativeID} accessible accessibilityRole="alert" accessibilityLiveRegion="polite"
      accessibilityLabel={message} style={[s.fieldError, style]}>
      <View style={s.fieldErrorIcon}><Icon name={semanticIcon.error} size="inline" color={t.color.error} /></View>
      <Txt role="meta" tone="error" style={s.flex}>{message}</Txt>
    </Animated.View>
  );
}

/* ---------------- status line and badge ---------------- */

export type InlineTone = 'error' | 'warning' | 'success' | 'info' | 'busy';

const TONE: Record<Exclude<InlineTone, 'busy'>, { icon: IconName; color: string; surface: string; text: 'error' | 'warning' | 'success' | 'ink' }> = {
  error: { icon: semanticIcon.error, color: t.color.error, surface: t.color.errorSurface, text: 'error' },
  warning: { icon: semanticIcon.warning, color: t.color.warning, surface: t.color.warningSurface, text: 'warning' },
  success: { icon: semanticIcon.success, color: t.color.success, surface: t.color.successSurface, text: 'success' },
  info: { icon: semanticIcon.info, color: t.color.ink, surface: t.color.selection, text: 'ink' },
};

/**
 * Status line for a row or card: tone icon (spinner when busy) plus message, with an optional in-place Retry.
 * A promise-returning `onRetry` shows busy on the button until it settles, ignores presses meanwhile, and
 * shakes the line if it rejects. The status itself stays as given; the caller clears it on success.
 */
export function InlineStatus({ tone, message, onRetry, retryLabel = 'Retry', testID, style }: {
  tone: InlineTone; message: string; onRetry?: () => void | Promise<unknown>; retryLabel?: string; testID?: string; style?: StyleProp<ViewStyle>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [failures, setFailures] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const retry = useCallback(async () => {
    if (!onRetry || inFlight.current) return;
    let pending: unknown;
    try {
      pending = onRetry();
    } catch {
      setFailures((count) => count + 1);
      return;
    }
    if (!pending || typeof (pending as PromiseLike<unknown>).then !== 'function') return;
    inFlight.current = true;
    setRetrying(true);
    try {
      await pending;
    } catch {
      if (mounted.current) setFailures((count) => count + 1);
    } finally {
      inFlight.current = false;
      if (mounted.current) setRetrying(false);
    }
  }, [onRetry]);

  const spec = tone === 'busy' ? null : TONE[tone];
  return (
    <Shake trigger={failures || null} testID={testID} style={[s.status, style]}>
      <View accessible accessibilityRole={tone === 'error' || tone === 'warning' ? 'alert' : 'text'} accessibilityLiveRegion="polite"
        accessibilityState={tone === 'busy' ? { busy: true } : undefined} accessibilityLabel={message} style={s.statusMessage}>
        <View style={s.statusIcon}>
          {spec ? <Icon name={spec.icon} size="inline" color={spec.color} /> : <BusyIndicator size="inline" color={t.color.secondary} decorative />}
        </View>
        <Txt role="meta" tone={spec?.text ?? 'secondary'} style={s.flex}>{message}</Txt>
      </View>
      {onRetry ? (
        <Pressable testID={testID ? `${testID}-retry` : undefined} accessibilityRole="button" accessibilityLabel={retryLabel}
          accessibilityState={{ busy: retrying, disabled: retrying }} disabled={retrying} onPress={() => { void retry(); }}
          style={({ pressed }) => [s.retry, pressed && s.pressed]}>
          {retrying ? <BusyIndicator size="inline" color={t.color.action} decorative /> : <Icon name={semanticIcon.retry} size="inline" color={t.color.action} />}
          <Txt role="bodyStrong" tone="action">{retryLabel}</Txt>
        </Pressable>
      ) : null}
    </Shake>
  );
}

/** Small round tone badge for a card corner. Decorative unless it has an accessibilityLabel. */
export function StatusBadge({ tone, accessibilityLabel, testID, style }: {
  tone: Exclude<InlineTone, 'busy'>; accessibilityLabel?: string; testID?: string; style?: StyleProp<ViewStyle>;
}) {
  const spec = TONE[tone];
  const a11y = accessibilityLabel
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel }
    : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
  return (
    <View testID={testID} {...a11y} style={[s.badge, { backgroundColor: spec.surface }, style]}>
      <Icon name={spec.icon} size="inline" color={spec.color} />
    </View>
  );
}

/* ---------------- task helper ---------------- */

export type InlineTaskState = 'idle' | 'busy' | 'error' | 'success';

/**
 * Tracks one async action for inline feedback. It never touches caller-owned input, ignores `run` while a
 * run is in flight, and keeps the failure in `error` so the UI can show it next to the field or row.
 */
export function useInlineTask<T>() {
  const [snapshot, setSnapshot] = useState<{ state: InlineTaskState; error: unknown }>({ state: 'idle', error: undefined });
  const generation = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async (work: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    const mine = ++generation.current;
    setSnapshot({ state: 'busy', error: undefined });
    try {
      const value = await work();
      if (mounted.current && mine === generation.current) setSnapshot({ state: 'success', error: undefined });
      return value;
    } catch (error) {
      if (mounted.current && mine === generation.current) setSnapshot({ state: 'error', error });
      return undefined;
    } finally {
      if (mine === generation.current) busy.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    generation.current += 1;
    busy.current = false;
    setSnapshot({ state: 'idle', error: undefined });
  }, []);

  return { state: snapshot.state, error: snapshot.error, run, reset };
}

const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  fieldError: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.s8, marginTop: t.space.s8 },
  fieldErrorIcon: { marginTop: t.space.s2 },
  status: { gap: t.space.s4 },
  statusMessage: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.s8 },
  statusIcon: { marginTop: t.space.s2 },
  retry: {
    minHeight: L.frame.minimumTarget, minWidth: L.frame.minimumTarget, alignSelf: 'flex-start', flexDirection: 'row',
    alignItems: 'center', gap: t.space.s4, borderRadius: t.radius.small,
  },
  pressed: { backgroundColor: t.color.selection },
  badge: {
    width: L.icon.standard + t.space.s4, height: L.icon.standard + t.space.s4, borderRadius: t.radius.capsule,
    borderWidth: t.stroke.divider, borderColor: t.color.surface, alignItems: 'center', justifyContent: 'center',
  },
});
