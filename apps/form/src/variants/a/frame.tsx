// CMP-A01 NativeFrame pieces (tab bar, web-only simulated chrome) and CMP-A13 ReviewSheet shell.
// Installed dependencies include no native tab bar, glass or sheet module (see DGR A-RN-01/02):
// the tab bar is the package's opaque surface fallback (= Reduce Transparency appearance) and
// sheets are an in-tree modal layer with grabber, Close, scrim tap and swipe-down dismissal.
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Icon, StatusGlyph } from './art';
import type { IconName } from './assets/generatedicons';
import { focusElement, useCapture } from './capture';
import { Txt } from './primitives';
import { easeOut, L, t } from './theme';
import type { ScreenId } from '../../types';

/* ---------------- tab bar ---------------- */

const TABS: readonly { id: ScreenId; label: string; icon: IconName }[] = [
  { id: 'today', label: 'Today', icon: 'house' },
  { id: 'plan', label: 'Plan', icon: 'calendar-days' },
  { id: 'workout', label: 'Workout', icon: 'dumbbell' },
  { id: 'coach', label: 'Coach', icon: 'message-circle' },
  { id: 'progress', label: 'Progress', icon: 'chart-no-axes-combined' },
];

export function TabBar({ current, bottomInset, onSelect, register = true }: {
  current: ScreenId; bottomInset: number; onSelect: (id: ScreenId) => void; register?: boolean;
}) {
  const ref = useCapture(register ? 'a-tabbar' : undefined);
  return (
    <View ref={ref} testID={register ? 'a-tabbar' : undefined} accessibilityRole="tablist"
      style={[s.tabbar, { height: L.frame.tabHeight + bottomInset, paddingBottom: bottomInset }]}>
      {TABS.map((tab) => <TabItem key={tab.id} tab={tab} selected={tab.id === current} register={register} onPress={() => onSelect(tab.id)} />)}
    </View>
  );
}

function TabItem({ tab, selected, onPress, register }: { tab: (typeof TABS)[number]; selected: boolean; onPress: () => void; register: boolean }) {
  const id = register ? `a-tab-${tab.id}` : undefined;
  const ref = useCapture(id);
  const color = selected ? t.color.chrome.tabSelected : t.color.ink;
  return (
    <Pressable ref={ref} testID={id} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected }}
      onPress={onPress} style={s.tab}>
      <View style={[s.tabPill, selected && s.tabPillSelected]}>
        <Icon name={tab.icon} size={L.icon.nav} color={color} />
      </View>
      <Txt role="tab" style={{ color }}>{tab.label}</Txt>
    </Pressable>
  );
}

/* ---------------- web-only simulated chrome (reference frame) ---------------- */

/** The mockup's simulated status bar, island and home indicator, drawn only on web; the OS draws the real ones. */
export function SimulatedChrome() {
  if (Platform.OS !== 'web') return null;
  const ink = t.color.chrome.statusInk;
  return (
    <>
      <View testID="chrome-status" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={s.status}>
        <View style={s.statusRow}>
          <View style={s.statusTime}><Txt role="bodyStrong" style={{ color: ink }}>9:41</Txt></View>
          <View style={s.statusIcons}>
            <StatusGlyph name="signal" color={ink} />
            <StatusGlyph name="wifi" color={ink} />
            <StatusGlyph name="battery" color={ink} />
          </View>
        </View>
        <View style={s.islandRow}><View style={s.island} /></View>
      </View>
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={s.homeRow}>
        <View style={s.homeIndicator} />
      </View>
    </>
  );
}

/* ---------------- CMP-A13 sheet ---------------- */

export type SheetSpec = {
  id: string;
  title: string;
  closeId: string;
  large?: boolean;
  label?: string;
  body: ReactNode;
};

/** Close request with the reason it was dismissed; `after` runs once the exit motion ends. */
export type SheetClose = (after?: () => void) => void;

/**
 * Modal sheet layer. Enters over motion.sheet with motion.easeOut (Reduce Motion: opacity over
 * motion.reduced); every dismissal (Close, scrim, swipe, Escape, VoiceOver escape) reverses it
 * before its effect is dispatched. Focus moves to the title and returns to the opener on close.
 */
export function SheetLayer({ spec, topInset, bottomInset, reduceMotion, onDismiss, closeRef }: {
  spec: SheetSpec; topInset: number; bottomInset: number; reduceMotion: boolean;
  onDismiss: () => void; closeRef: { current: SheetClose | null };
}) {
  const { height: windowHeight } = useWindowDimensions();
  const sheetHeight = useSharedValue<number>(windowHeight);
  const progress = useSharedValue<number>(0);
  const drag = useSharedValue<number>(0);
  const closing = useRef(false);
  const titleId = `${spec.id}-title`;
  const ref = useCapture(spec.id);
  const duration = reduceMotion ? t.motion.reduced : t.motion.sheet;

  useEffect(() => {
    progress.value = withTiming(1, { duration, easing: easeOut });
    const frame = requestAnimationFrame(() => focusElement(titleId));
    return () => cancelAnimationFrame(frame);
    // Presentation runs once per mounted sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback<SheetClose>((after) => {
    if (closing.current) return;
    closing.current = true;
    const finish = () => { onDismiss(); after?.(); };
    progress.value = withTiming(0, { duration, easing: easeOut }, (done) => { if (done) runOnJS(finish)(); });
  }, [duration, onDismiss, progress]);
  closeRef.current = close;

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  // Swipe down on the grabber/header: follows the finger; dismisses past a quarter of the sheet's
  // measured height or on a downward fling faster than one sheet height per second (DGR A-RN-02).
  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY(t.space.s8)
    .onUpdate((e) => { drag.value = Math.max(0, e.translationY); })
    .onEnd((e) => {
      if (drag.value > sheetHeight.value / 4 || e.velocityY > sheetHeight.value) close();
      else drag.value = withTiming(0, { duration, easing: easeOut });
    });

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const sheetStyle = useAnimatedStyle(() => (reduceMotion
    ? { opacity: progress.value, transform: [{ translateY: drag.value }] }
    : { transform: [{ translateY: (1 - progress.value) * sheetHeight.value + drag.value }] }));

  const largeTop = topInset + L.sheet.largeTop - L.viewport.safeTop;
  return (
    <View style={s.layer} accessibilityViewIsModal onAccessibilityEscape={() => close()}>
      <Reanimated.View style={[s.scrim, scrimStyle]}>
        <Pressable style={s.fill} onPress={() => close()} accessible={false} importantForAccessibility="no" />
      </Reanimated.View>
      <Reanimated.View
        onLayout={(e) => { sheetHeight.value = e.nativeEvent.layout.height; }}
        style={[s.sheetMotion, spec.large ? { top: largeTop } : { maxHeight: windowHeight - largeTop }, sheetStyle]}
      >
        <View ref={ref} testID={spec.id} accessibilityLabel={spec.label}
          style={[s.sheet, spec.large ? s.fill : s.bodyAuto, { paddingBottom: Math.max(L.sheet.paddingBottom, bottomInset) }]}>
          <GestureDetector gesture={pan}>
            <View>
              <View style={s.handle} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
              <SheetHead title={spec.title} titleId={titleId} closeId={spec.closeId} onClose={() => close()} />
            </View>
          </GestureDetector>
          <ScrollView style={spec.large ? s.fill : s.bodyAuto} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {spec.body}
          </ScrollView>
        </View>
      </Reanimated.View>
    </View>
  );
}

/** Sheet head: Bricolage title and a labelled 44 pt Close circle. Also used by showcase specimens. */
export function SheetHead({ title, titleId, closeId, onClose }: { title: string; titleId?: string; closeId?: string; onClose?: () => void }) {
  const ref = useCapture(closeId);
  return (
    <View style={s.head}>
      <Txt role="sectionTitle" accessibilityRole="header" captureId={titleId} style={s.headTitle}>{title}</Txt>
      <Pressable ref={ref} testID={closeId} accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}
        style={({ pressed }) => [s.close, pressed && s.closePressed]}>
        <Icon name="x" size={L.icon.standard} color={t.color.ink} />
      </Pressable>
    </View>
  );
}

/** Static sheet anatomy for the showcase (same head, handle and surface, no modal layer). */
export function SheetSpecimen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={s.specimen}>
      <View style={s.handle} />
      <SheetHead title={title} />
      {children}
    </View>
  );
}

export function SheetSection({ children }: { children: ReactNode }) {
  return <View style={s.section}>{children}</View>;
}

export function SheetActions({ children }: { children: ReactNode }) {
  return <View style={s.actions}>{children}</View>;
}

/** Label/value row inside a sheet (min 44, divider between rows). */
export function SheetRow({ left, right, last }: { left: ReactNode; right: ReactNode; last?: boolean }) {
  return <View style={[s.row, last && s.rowLast]}>{left}{right}</View>;
}

/** Vertical before/after block ("Current" then "Proposed"); never side-by-side. */
export function Compare({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.compare}>
      <Txt role="meta" tone="secondary">{label}</Txt>
      <Txt role="bodyStrong">{value}</Txt>
    </View>
  );
}

/* ---------------- styles ---------------- */

const C = L.chrome;

const s = StyleSheet.create({
  fill: { flex: 1 },
  tabbar: {
    flexDirection: 'row', backgroundColor: t.color.chrome.tabBar,
    borderTopWidth: t.stroke.divider, borderTopColor: t.color.line, overflow: 'visible',
  },
  tab: {
    flex: 1, height: L.frame.tabHeight, paddingTop: L.tab.paddingTop, alignItems: 'center',
    justifyContent: 'flex-start', gap: L.tab.iconLabelGap,
  },
  tabPill: {
    width: L.tab.pillWidth, height: L.tab.pillHeight, borderRadius: t.radius.tabPill, borderCurve: 'continuous',
    alignItems: 'center', justifyContent: 'center',
  },
  tabPillSelected: { backgroundColor: t.color.chrome.tabPill },
  status: { position: 'absolute', top: 0, left: 0, right: 0, height: L.viewport.safeTop, backgroundColor: t.color.canvas },
  statusRow: {
    position: 'absolute', top: 0, left: 0, right: 0, height: C.statusBarHeight, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: C.statusSideInset,
  },
  statusTime: { width: C.statusTimeWidth, alignItems: 'center' },
  statusIcons: { width: C.statusTimeWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: C.statusIconGap },
  islandRow: { position: 'absolute', top: C.islandTop, left: 0, right: 0, alignItems: 'center' },
  island: { width: C.islandWidth, height: C.islandHeight, borderRadius: t.radius.capsule, backgroundColor: t.color.chrome.island },
  homeRow: { position: 'absolute', bottom: C.homeIndicatorBottom, left: 0, right: 0, alignItems: 'center' },
  homeIndicator: { width: C.homeIndicatorWidth, height: C.homeIndicatorHeight, borderRadius: t.radius.capsule, backgroundColor: t.color.chrome.homeIndicator },
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.color.scrim },
  sheetMotion: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: t.color.surface,
    borderTopLeftRadius: L.sheet.topRadius, borderTopRightRadius: L.sheet.topRadius, borderCurve: 'continuous',
    paddingTop: L.sheet.paddingTop, paddingHorizontal: L.sheet.paddingX,
  },
  bodyAuto: { flexGrow: 0, flexShrink: 1 },
  handle: {
    width: L.sheet.handleWidth, height: L.sheet.handleHeight, borderRadius: t.radius.capsule,
    backgroundColor: t.color.line, alignSelf: 'center',
  },
  head: { marginTop: L.sheet.handleGap, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: t.space.s12 },
  headTitle: { paddingTop: t.space.s8, flexShrink: 1 },
  close: {
    width: L.sheet.closeTarget, height: L.sheet.closeTarget, borderRadius: t.radius.capsule, backgroundColor: t.color.selection,
    alignItems: 'center', justifyContent: 'center',
  },
  closePressed: { backgroundColor: t.color.line },
  specimen: {
    backgroundColor: t.color.surface, borderTopLeftRadius: L.sheet.topRadius, borderTopRightRadius: L.sheet.topRadius,
    borderCurve: 'continuous', paddingTop: L.sheet.paddingTop, paddingHorizontal: L.sheet.paddingX,
    paddingBottom: L.sheet.paddingX, borderWidth: t.stroke.divider, borderColor: t.color.line,
  },
  section: { marginTop: L.sheet.sectionGap },
  actions: { marginTop: L.sheet.sectionGap, gap: L.sheet.actionGap },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: t.space.s12,
    minHeight: L.frame.minimumTarget, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  rowLast: { borderBottomWidth: 0 },
  compare: {
    gap: t.space.s4, paddingVertical: t.space.s12, paddingHorizontal: t.space.s0,
    borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
});
