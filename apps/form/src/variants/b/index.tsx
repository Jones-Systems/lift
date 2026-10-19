// Club Circuit (B) variant root: one local fixture state shared by five tab roots,
// a persistent tab bar, an optional action dock and presented sheets.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, Platform, ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { VariantProps } from '../../types';
import { Dock, TabBar } from './components';
import { SheetLayer } from './sheet';
import { PAGES, type Api } from './screens';
import { Showcase } from './showcase';
import { EnvProvider, t, useClubEnvironment } from './theme';
import { focusElement, installCaptureHook, setCaptureRoot } from './capture';
import { launchState, reducer, sets, type Action, type PageId, type State } from './model';

const IS_WEB = Platform.OS === 'web';

function successHaptic() {
  // Package: one light success haptic on Finish, Apply and Move commits only.
  if (Platform.OS === 'ios') void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/** Announcements and commit haptics, derived from an actual state transition (no-ops never fire). */
function feedback(prev: State, next: State, action: Action) {
  if (action.type === 'confirm-set' && next.workout.justRecordedId && next.workout.justRecordedId !== prev.workout.justRecordedId) {
    AccessibilityInfo.announceForAccessibility(`Set ${next.workout.setNumber} recorded.`);
  }
  if (action.type === 'apply-plan' && next.planKey === 'short' && prev.planKey !== 'short') {
    AccessibilityInfo.announceForAccessibility('20-minute plan applied.');
    successHaptic();
  }
  if (action.type === 'finish-keep' && next.finished && !prev.finished) {
    AccessibilityInfo.announceForAccessibility(`${next.finished.status === 'partial' ? 'Partial workout recorded. ' : 'Workout recorded. '}${sets(next.finished.confirmedSets.length)}.`);
    successHaptic();
  }
  if ((action.type === 'confirm-move' || action.type === 'move-here') && next.pendingDate !== prev.pendingDate) successHaptic();
}

export default function VariantApp({ initialScreen = 'today', initialState, showcase = false, onScreenChange }: VariantProps) {
  const env = useClubEnvironment();
  const insets = useSafeAreaInsets();
  // Web previews simulate the reference device's safe areas; native uses the device's real insets.
  const top = IS_WEB ? t.layout.screen.safeTop : insets.top;
  const bottom = IS_WEB ? t.layout.screen.safeBottom : insets.bottom;
  const [state, setState] = useState<State>(() => launchState(initialScreen, initialState));
  const current = useRef(state);
  const trigger = useRef<string | null>(null);
  const root = useRef<View | null>(null);

  useEffect(() => installCaptureHook(), []);

  const act = useCallback((action: Action, triggerId?: string) => {
    const prev = current.current;
    const next = reducer(prev, action);
    if (next === prev) return;
    if (!prev.sheet && next.sheet) trigger.current = triggerId ?? null;
    current.current = next;
    setState(next);
    feedback(prev, next, action);
  }, []);
  const go = useCallback((to: PageId) => {
    act({ type: 'nav', to });
    onScreenChange?.(to);
  }, [act, onScreenChange]);
  const api: Api = { act, go };

  // Focus returns to the control that opened a sheet once it is dismissed.
  const hadSheet = useRef(!!state.sheet);
  useEffect(() => {
    if (hadSheet.current && !state.sheet && trigger.current) {
      const id = trigger.current;
      trigger.current = null;
      requestAnimationFrame(() => focusElement(id));
    }
    hadSheet.current = !!state.sheet;
  }, [state.sheet]);

  const page = PAGES[state.screen](state, api);
  return (
    <EnvProvider value={env}>
      <View
        ref={root}
        testID={showcase ? 'b.showcase' : `b.screen.${state.screen}`}
        onLayout={(e) => setCaptureRoot(root.current, e.nativeEvent.layout.width)}
        style={[s.root, { paddingTop: top }]}>
        <StatusBar barStyle="dark-content" />
        {showcase ? <Showcase bottomInset={bottom} /> : (
          <>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.fill}>
              <ScrollView key={state.screen} style={s.fill} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
                {page.scroll}
              </ScrollView>
              <Dock>{page.dock}</Dock>
            </KeyboardAvoidingView>
            <TabBar current={state.screen} bottomInset={bottom} onSelect={go} />
            {page.sheet ? (
              <SheetLayer key={page.sheet.id} spec={page.sheet} topInset={top} bottomInset={bottom} onClose={() => act({ type: 'close-sheet' })} />
            ) : null}
          </>
        )}
      </View>
    </EnvProvider>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: t.color.surface.canvas },
  fill: { flex: 1 },
  content: { paddingHorizontal: t.layout.screen.gutter, paddingBottom: t.layout.screen.bottomClearance },
});
