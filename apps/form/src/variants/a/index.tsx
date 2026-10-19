// Open Mat (A) variant root: one local demo state shared by five tab roots, a persistent
// opaque tab bar, the Coach composer accessory and presented sheets. Fixtures are fictional;
// the Demo coach is canned and local. Nothing is sent anywhere or persisted.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, KeyboardAvoidingView, Platform, ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { ScreenId, VariantProps } from '../../types';
import { focusElement, installCaptureHook, setCaptureRoot } from './capture';
import { SheetLayer, SimulatedChrome, TabBar, type SheetClose } from './frame';
import { launchState, reducer, REST_TICK_MS, type Action, type State } from './model';
import { CoachAccessory, CoachScreen, PlanScreen, ProgressScreen, sheetFor, TodayScreen, WorkoutScreen, type Api } from './screens';
import { Showcase } from './showcase';
import { IS_WEB, L, PrefsContext, t, useAccessibilityPrefs } from './theme';

const SCROLL_EVENT_THROTTLE_MS = 16;

const SCREENS = { today: TodayScreen, plan: PlanScreen, workout: WorkoutScreen, coach: CoachScreen, progress: ProgressScreen } as const;

/** One optional haptic per user action, on the same frame as the visual change (iOS/Android only). */
function feedback(prev: State, next: State, action: Action) {
  if (Platform.OS === 'web') return;
  if (action.type === 'confirm-set' && next.confirmed.length > prev.confirmed.length) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } else if (action.type === 'apply-short' && next.plan === 'short' && prev.plan !== 'short') {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } else if (action.type === 'save' && next.history.length > prev.history.length) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } else if ((action.type === 'select-day' || action.type === 'today-day') && next.selectedDay !== prev.selectedDay) {
    void Haptics.selectionAsync();
  }
}

export default function VariantApp({ initialScreen = 'today', initialState, showcase = false, onScreenChange }: VariantProps) {
  const insets = useSafeAreaInsets();
  // Web previews simulate the reference device's safe areas; native uses the device's real insets.
  const top = IS_WEB ? L.viewport.safeTop : insets.top;
  const bottom = IS_WEB ? L.viewport.safeBottom : insets.bottom;
  const prefs = useAccessibilityPrefs();
  const { reduceMotion } = prefs;
  const [state, setState] = useState<State>(() => launchState(initialScreen, initialState));
  const [now, setNow] = useState(() => Date.now());
  const [composerFocused, setComposerFocused] = useState(false);
  const current = useRef(state);
  const trigger = useRef<string | null>(null);
  const root = useRef<View | null>(null);
  const closer = useRef<SheetClose | null>(null);
  const scroll = useRef<ScrollView | null>(null);
  const offsets = useRef<Partial<Record<ScreenId, number>>>({});
  const restored = useRef<ScreenId | null>(null);

  useEffect(() => installCaptureHook(), []);

  const act = useCallback((action: Action, triggerId?: string) => {
    const prev = current.current;
    const next = reducer(prev, action);
    if (next === prev) return;
    if (!prev.sheet && next.sheet) trigger.current = triggerId ?? null;
    current.current = next;
    setState(next);
    feedback(prev, next, action);
    if (next.tab !== prev.tab) onScreenChange?.(next.tab);
  }, [onScreenChange]);

  const closeSheet = useCallback((after?: () => void) => {
    if (closer.current) closer.current(after);
    else {
      act({ type: 'close-sheet' });
      after?.();
    }
  }, [act]);

  // Rest counts real elapsed time from a stored end time; recomputed every tick and on return to
  // the foreground. Expiry only ends the rest; it never records a set.
  const restEndsAt = state.session?.status === 'resting' ? state.session.restEndsAt : null;
  useEffect(() => {
    if (restEndsAt === null) return undefined;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (time >= restEndsAt) act({ type: 'end-rest' });
    };
    tick();
    const id = setInterval(tick, REST_TICK_MS);
    const subscription = AppState.addEventListener('change', (status) => { if (status === 'active') tick(); });
    return () => {
      clearInterval(id);
      subscription.remove();
    };
  }, [restEndsAt, act]);

  // Focus returns to the control that opened a sheet once it is dismissed.
  const hadSheet = useRef(!!state.sheet);
  useEffect(() => {
    if (hadSheet.current && !state.sheet && trigger.current) {
      const id = trigger.current;
      trigger.current = null;
      requestAnimationFrame(() => focusElement(id));
    }
    if (!state.sheet) closer.current = null;
    hadSheet.current = !!state.sheet;
  }, [state.sheet]);

  if (showcase) {
    return (
      <PrefsContext.Provider value={prefs}>
        <View ref={root} testID="a-showcase-root" onLayout={(e) => setCaptureRoot(root.current, e.nativeEvent.layout.width)}
          style={[s.root, { paddingTop: top }]}>
          <StatusBar barStyle="dark-content" />
          <Showcase initialSection={initialState} topInset={top} bottomInset={bottom} reduceMotion={reduceMotion} />
          <SimulatedChrome />
        </View>
      </PrefsContext.Provider>
    );
  }

  const api: Api = { act, closeSheet, now, reduceMotion, composerFocused, setComposerFocused };
  const Screen = SCREENS[state.tab];
  const sheet = sheetFor(state, api);
  const tab = state.tab;

  return (
    <PrefsContext.Provider value={prefs}>
      <View ref={root} testID="a-variant-root" onLayout={(e) => setCaptureRoot(root.current, e.nativeEvent.layout.width)}
        style={[s.root, { paddingTop: top }]}>
        <StatusBar barStyle="dark-content" />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.fill}>
          <ScrollView
            key={tab}
            ref={scroll}
            style={s.fill}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            scrollEventThrottle={SCROLL_EVENT_THROTTLE_MS}
            onScroll={(e) => { offsets.current[tab] = e.nativeEvent.contentOffset.y; }}
            onContentSizeChange={() => {
              // Restore this tab's scroll position once per visit (tab switches preserve scroll).
              if (restored.current === tab) return;
              restored.current = tab;
              const y = offsets.current[tab];
              if (y) scroll.current?.scrollTo({ y, animated: false });
            }}
          >
            <Screen state={state} api={api} />
          </ScrollView>
          {tab === 'coach' ? <CoachAccessory state={state} api={api} /> : null}
        </KeyboardAvoidingView>
        <TabBar current={tab} bottomInset={bottom} onSelect={(to) => { restored.current = null; act({ type: 'tab', to }); }} />
        {sheet ? (
          <SheetLayer key={sheet.id} spec={sheet} topInset={top} bottomInset={bottom} reduceMotion={reduceMotion}
            onDismiss={() => act({ type: 'close-sheet' })} closeRef={closer} />
        ) : null}
        <SimulatedChrome />
      </View>
    </PrefsContext.Provider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: t.color.canvas },
  fill: { flex: 1 },
});
