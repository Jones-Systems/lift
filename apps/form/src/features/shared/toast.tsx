// Toast host and API: stacked, swipeable, announced feedback that never blocks input outside the cards.
// Queue rules live in toastModel.ts; this file owns rendering, timers, gestures and motion.
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { Txt } from '../../variants/a/primitives';
import { Icon, semanticIcon, type IconName } from './icons';
import {
  fadeTiming, haptic as fireHaptic, motionDistance, motionDuration, springConfig, timingConfig, type HapticIntent,
} from './motion';
import { useReduceMotion } from './motionProvider';
import { L, t } from './tokens';
import {
  findToastByKey, initialToastState, newlyDismissed, renderedToasts, resolveSwipe, toastReducer, TOAST_RESUME_MIN_MS,
  type SwipeResult, type ToastAction, type ToastDismissReason, type ToastEvent, type ToastInput, type ToastRecord, type ToastState,
  type ToastTone,
} from './toastModel';

export type { ToastAction, ToastDismissReason, ToastTone };

export type ToastOptions = {
  tone: ToastTone;
  title: string;
  body?: string;
  action?: ToastAction;
  /** Stay until acted on or dismissed. Default: error/warning toasts with an action. */
  persistent?: boolean;
  durationMs?: number;
  /** Same key updates the visible toast in place instead of stacking another. */
  key?: string;
  icon?: IconName;
  /** Fired once when the toast appears; leave unset when the triggering action already gave feedback. */
  haptic?: HapticIntent;
  testID?: string;
  onDismiss?: (id: string, reason: ToastDismissReason) => void;
};

export type ToastApi = {
  show(options: ToastOptions): string;
  update(id: string, patch: Partial<ToastOptions>): void;
  dismiss(id: string): void;
  clear(): void;
};

const ToastContext = createContext<ToastApi | null>(null);

const inertApi: ToastApi = { show: () => '', update: () => undefined, dismiss: () => undefined, clear: () => undefined };
let warnedOutsideProvider = false;

/** Toast API for the nearest ToastProvider. Outside one it is a no-op (warns once in development). */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api) return api;
  if (__DEV__ && !warnedOutsideProvider) {
    warnedOutsideProvider = true;
    console.warn('useToast() was used outside a ToastProvider; toasts are ignored.');
  }
  return inertApi;
}

function toInput(id: string, o: ToastOptions): ToastInput {
  return {
    id, key: o.key, tone: o.tone, title: o.title, body: o.body, action: o.action, icon: o.icon, haptic: o.haptic,
    testID: o.testID, onDismiss: o.onDismiss, persistent: o.persistent, durationMs: o.durationMs,
  };
}

function notifyDismissed(record: ToastRecord, reason: ToastDismissReason) {
  try {
    record.onDismiss?.(record.id, reason);
  } catch (error) {
    if (__DEV__) console.warn('Toast onDismiss threw', error);
  }
}

/**
 * Mount once near the app root, inside the safe-area and motion providers and a full-screen container.
 * `bottomOffset` is the height of any bottom chrome (tab bar) the bottom placement must clear.
 */
export function ToastProvider({ children, placement = 'top', bottomOffset = 0 }: {
  children: ReactNode; placement?: 'top' | 'bottom'; bottomOffset?: number;
}) {
  const [state, setState] = useState<ToastState>(initialToastState);
  const stateRef = useRef(state);
  const counter = useRef(0);

  const apply = useCallback((event: ToastEvent) => {
    const before = stateRef.current;
    const after = toastReducer(before, event);
    if (after === before) return;
    stateRef.current = after;
    setState(after);
    for (const { record, reason } of newlyDismissed(before, after)) notifyDismissed(record, reason);
  }, []);

  const api = useMemo<ToastApi>(() => ({
    show(options) {
      const existing = options.key === undefined ? undefined : findToastByKey(stateRef.current, options.key);
      const id = existing?.id ?? `toast-${++counter.current}`;
      apply({ type: 'show', toast: toInput(id, options) });
      return id;
    },
    update(id, patch) { apply({ type: 'update', id, patch: { ...patch } }); },
    dismiss(id) { apply({ type: 'dismiss', id, reason: 'programmatic' }); },
    clear() { apply({ type: 'clear', reason: 'programmatic' }); },
  }), [apply]);

  const requestDismiss = useCallback((id: string, reason: ToastDismissReason) => apply({ type: 'dismiss', id, reason }), [apply]);
  const remove = useCallback((id: string) => apply({ type: 'remove', id }), [apply]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost state={state} placement={placement} bottomOffset={bottomOffset} onRequestDismiss={requestDismiss} onRemoved={remove} />
    </ToastContext.Provider>
  );
}

function ToastHost({ state, placement, bottomOffset, onRequestDismiss, onRemoved }: {
  state: ToastState; placement: 'top' | 'bottom'; bottomOffset: number;
  onRequestDismiss: (id: string, reason: ToastDismissReason) => void; onRemoved: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const edge = placement === 'top' ? { top: insets.top + t.space.s8 } : { bottom: insets.bottom + bottomOffset + t.space.s8 };
  return (
    <View testID="toast-host" pointerEvents="box-none" style={[s.host, placement === 'top' ? s.hostTop : s.hostBottom, edge]}>
      {renderedToasts(state).map((record) => (
        <ToastCard key={record.id} record={record} placement={placement} reduce={reduce} onRequestDismiss={onRequestDismiss} onRemoved={onRemoved} />
      ))}
    </View>
  );
}

/* ---------------- announcements ---------------- */

/** Errors and warnings interrupt; info and success queue behind current speech. */
function announceToast(tone: ToastTone, title: string, body: string | undefined) {
  const text = body ? `${title}. ${body}` : title;
  const interrupt = tone === 'error' || tone === 'warning';
  if (typeof AccessibilityInfo.announceForAccessibilityWithOptions === 'function') {
    AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: !interrupt });
  } else {
    AccessibilityInfo.announceForAccessibility(text);
  }
}

/* ---------------- countdown ---------------- */

/** Auto-dismiss countdown that restarts on every version bump and can be paused while the card is touched. */
function useToastTimer(record: ToastRecord, onElapsed: () => void) {
  const handle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remaining = useRef<number | null>(null);
  const startedAt = useRef(0);
  const elapsed = useRef(onElapsed);
  elapsed.current = onElapsed;
  const idle = !!record.leaving || record.persistent || record.durationMs === null;

  const disarm = useCallback(() => {
    if (handle.current !== null) clearTimeout(handle.current);
    handle.current = null;
  }, []);
  const arm = useCallback((ms: number) => {
    disarm();
    remaining.current = ms;
    startedAt.current = Date.now();
    handle.current = setTimeout(() => {
      handle.current = null;
      remaining.current = null;
      elapsed.current();
    }, ms);
  }, [disarm]);

  useEffect(() => {
    if (idle || record.durationMs === null) { remaining.current = null; return disarm; }
    arm(record.durationMs);
    return disarm;
  }, [arm, disarm, idle, record.durationMs, record.version]);

  const pause = useCallback(() => {
    if (handle.current === null || remaining.current === null) return;
    const left = remaining.current - (Date.now() - startedAt.current);
    disarm();
    remaining.current = Math.max(TOAST_RESUME_MIN_MS, left);
  }, [disarm]);
  const resume = useCallback(() => {
    if (handle.current === null && remaining.current !== null) arm(remaining.current);
  }, [arm]);
  return { pause, resume };
}

/* ---------------- card ---------------- */

const TONE: Record<ToastTone, { icon: IconName; color: string }> = {
  info: { icon: semanticIcon.info, color: t.color.action },
  success: { icon: semanticIcon.success, color: t.color.success },
  warning: { icon: semanticIcon.warning, color: t.color.warning },
  error: { icon: semanticIcon.error, color: t.color.error },
};

type CardProps = {
  record: ToastRecord; placement: 'top' | 'bottom'; reduce: boolean;
  onRequestDismiss: (id: string, reason: ToastDismissReason) => void; onRemoved: (id: string) => void;
};

const ToastCard = memo(function ToastCard({ record, placement, reduce, onRequestDismiss, onRemoved }: CardProps) {
  const { id, tone, title, body, action, leaving } = record;
  const interrupt = tone === 'error' || tone === 'warning';
  const toward = placement === 'top' ? -1 : 1;
  const enter = useSharedValue(reduce ? 0 : toward * motionDistance.toast);
  const opacity = useSharedValue(0);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const swipe = useRef<SwipeResult>(null);
  const timer = useToastTimer(record, () => onRequestDismiss(id, 'timeout'));
  const { pause, resume } = timer;

  useEffect(() => {
    opacity.value = withTiming(1, fadeTiming(reduce));
    if (!reduce) enter.value = withSpring(0, springConfig('snappy', false));
    if (record.haptic) fireHaptic(record.haptic);
    // Entrance and haptic play once per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { announceToast(tone, title, body); }, [id, record.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!leaving) return undefined;
    const finish = () => onRemoved(id);
    // The animation callback is the normal path; the timer guarantees removal if it never reports back.
    const fallback = setTimeout(finish, motionDuration.confirm + 300);
    if (!reduce) {
      const leave = swipe.current;
      if (leave?.axis === 'x') dragX.value = withTiming(leave.sign * L.viewport.width, timingConfig(motionDuration.confirm, false));
      else enter.value = withTiming((leave?.axis === 'y' ? leave.sign : toward) * motionDistance.toast, timingConfig(motionDuration.confirm, false));
    }
    opacity.value = withTiming(0, fadeTiming(reduce, motionDuration.confirm), () => { scheduleOnRN(finish); });
    return () => clearTimeout(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  const pan = useMemo(() => Gesture.Pan()
    .runOnJS(true)
    .withTestId(`toast-pan-${id}`)
    .enabled(!leaving)
    .activeOffsetX([-12, 12])
    .activeOffsetY(placement === 'top' ? [-12, 10000] : [-10000, 12])
    .onBegin(pause)
    .onUpdate((e) => {
      dragX.value = e.translationX;
      dragY.value = placement === 'top' ? Math.min(0, e.translationY) : Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      const result = resolveSwipe(placement, e.translationX, e.translationY, e.velocityX, e.velocityY);
      if (result) {
        swipe.current = result;
        onRequestDismiss(id, 'swipe');
        return;
      }
      dragX.value = withSpring(0, springConfig('instant', reduce));
      dragY.value = withSpring(0, springConfig('instant', reduce));
    })
    .onFinalize(resume),
  [leaving, placement, reduce, id, pause, resume, onRequestDismiss, dragX, dragY]);

  const animated = useAnimatedStyle(() => ({
    opacity: opacity.value * (1 - Math.min(0.7, Math.abs(dragX.value) / 360)),
    transform: [{ translateX: dragX.value }, { translateY: enter.value + dragY.value }],
  }));

  const tint = TONE[tone];
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        testID={`toast-${record.testID ?? id}`}
        pointerEvents={leaving ? 'none' : 'auto'}
        accessibilityRole={interrupt ? 'alert' : undefined}
        accessibilityLiveRegion={interrupt ? 'assertive' : 'polite'}
        style={[s.card, animated]}>
        <View style={s.iconSlot}><Icon name={record.icon ?? tint.icon} size="notice" color={tint.color} /></View>
        <View style={s.content}>
          <View accessible accessibilityRole="text" accessibilityLabel={body ? `${title}. ${body}` : title} style={s.text}>
            <Txt role="bodyStrong">{title}</Txt>
            {body ? <Txt role="meta" tone="secondary">{body}</Txt> : null}
          </View>
          {action ? (
            <Pressable testID="toast-action" accessibilityRole="button" accessibilityLabel={action.label}
              onPress={() => {
                try { action.onPress(); } finally { onRequestDismiss(id, 'action'); }
              }}
              style={({ pressed }) => [s.action, pressed && s.pressed]}>
              {action.icon ? <Icon name={action.icon} size="inline" color={t.color.action} /> : null}
              <Txt role="bodyStrong" tone="action">{action.label}</Txt>
            </Pressable>
          ) : null}
        </View>
        <Pressable testID="toast-dismiss" accessibilityRole="button" accessibilityLabel="Dismiss notification"
          onPress={() => onRequestDismiss(id, 'close')} style={({ pressed }) => [s.close, pressed && s.pressed]}>
          <Icon name={semanticIcon.dismiss} size="notice" color={t.color.secondary} />
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
});

const s = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, alignItems: 'center', gap: t.space.s8, paddingHorizontal: t.space.s16 },
  hostTop: { flexDirection: 'column' },
  hostBottom: { flexDirection: 'column-reverse' },
  card: {
    width: '100%', maxWidth: L.frame.largeContentWidth, flexDirection: 'row', alignItems: 'flex-start', gap: L.notice.iconGap,
    padding: L.notice.padding, backgroundColor: t.color.surface, borderRadius: t.radius.chip, borderCurve: 'continuous',
    borderWidth: t.stroke.divider, borderColor: t.color.line,
    shadowColor: t.color.ink, shadowOpacity: 0.14, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 6,
  },
  iconSlot: { marginTop: t.space.s2 },
  content: { flex: 1, minWidth: 0, gap: t.space.s2 },
  text: { gap: t.space.s2 },
  action: {
    minHeight: L.notice.actionMinHeight, minWidth: L.frame.minimumTarget, alignSelf: 'flex-start', flexDirection: 'row',
    alignItems: 'center', gap: t.space.s4, borderRadius: t.radius.small,
  },
  close: {
    width: L.frame.minimumTarget, height: L.frame.minimumTarget, marginTop: -t.space.s12, marginRight: -t.space.s12,
    borderRadius: t.radius.capsule, alignItems: 'center', justifyContent: 'center',
  },
  pressed: { backgroundColor: t.color.selection },
});
