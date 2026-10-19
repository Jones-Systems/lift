// CMP-18 review/detail sheet. Installed dependencies offer no native content-sized
// sheet detent (DGR B-RN-01), so this is an in-tree opaque paper sheet: one scrim,
// grabber, swipe-down dismiss, critically damped spring, focus to title and back.
import React, { useEffect, useRef, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { IconButton } from './components';
import { t, Txt, useEnv } from './theme';
import { focusElement, useCapture } from './capture';

export type SheetSpec = { id: string; title: string; closeId: string; closeLabel?: string; body: ReactNode; actions?: ReactNode };

const L = t.layout;
const VISIBLE = t.motion.opacity.visible;
const HIDDEN = t.motion.opacity.hidden;
const spring = { dampingRatio: t.motion.spring.dampingRatio, duration: t.motion.spring.settleDuration };

export function SheetLayer({ spec, onClose, topInset, bottomInset }: { spec: SheetSpec; onClose: () => void; topInset: number; bottomInset: number }) {
  const env = useEnv();
  const titleId = `${spec.id}.title`;
  const height = useSharedValue(0);
  const progress = useSharedValue<number>(t.motion.opacity.hidden);
  const drag = useSharedValue<number>(t.motion.travel.reduced);
  const presented = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const id = requestAnimationFrame(() => focusElement(titleId));
    if (Platform.OS !== 'web' || typeof document === 'undefined') return () => cancelAnimationFrame(id);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    document.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(id); document.removeEventListener('keydown', onKey); };
  }, [titleId]);

  const present = (measured: number) => {
    height.value = measured;
    if (presented.current) return;
    presented.current = true;
    progress.value = env.reduceMotion
      ? withTiming(t.motion.opacity.visible, { duration: t.motion.duration.reduced, easing: Easing.bezier(...t.motion.easing.linear) })
      : withSpring(t.motion.opacity.visible, spring);
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY(t.space.sm)
    .onUpdate((e) => { drag.value = Math.max(t.motion.travel.reduced, e.translationY); })
    .onEnd((e) => {
      const projected = drag.value + (e.velocityY * t.motion.spring.settleDuration) / 1000;
      if (projected > height.value / 2) close.current();
      else drag.value = env.reduceMotion ? t.motion.travel.reduced : withSpring(t.motion.travel.reduced, spring);
    });

  const scrim = useAnimatedStyle(() => ({ opacity: progress.value }));
  const reduce = env.reduceMotion;
  const sheet = useAnimatedStyle(() => (reduce
    ? { opacity: progress.value, transform: [{ translateY: drag.value }] }
    : { opacity: height.value > 0 ? VISIBLE : HIDDEN, transform: [{ translateY: (VISIBLE - progress.value) * height.value + drag.value }] }));

  return (
    <View style={[s.layer, { paddingTop: topInset }]}>
      <Animated.View style={[s.scrim, scrim]}>
        <Pressable style={s.fill} onPress={() => close.current()} accessible={false} importantForAccessibility="no" />
      </Animated.View>
      <Animated.View style={[s.motion, sheet]}>
        <SheetPanel spec={spec} onClose={() => close.current()} bottomInset={bottomInset} gesture={pan} modal
          onMeasure={(measured) => present(measured)} />
      </Animated.View>
    </View>
  );
}

type PanGesture = ReturnType<typeof Gesture.Pan>;

/** The sheet's visual anatomy: grabber, title, 48 pt Close, scrollable body, primary then outline actions. */
export function SheetPanel({ spec, onClose, bottomInset, gesture, modal, onMeasure }: {
  spec: SheetSpec; onClose: () => void; bottomInset: number; gesture?: PanGesture; modal?: boolean; onMeasure?: (height: number) => void;
}) {
  const capture = useCapture(modal ? spec.id : undefined);
  const head = (
    <View>
      <View style={s.grabberRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><View style={s.grabber} /></View>
      <View style={s.head}>
        <Txt type="sectionTitle" captureId={modal ? `${spec.id}.title` : undefined} accessibilityRole="header" style={s.title}>{spec.title}</Txt>
        <IconButton icon="close" label={spec.closeLabel ?? 'Close'} id={modal ? spec.closeId : undefined} onPress={onClose} />
      </View>
    </View>
  );
  return (
    <View ref={capture.ref} testID={modal ? spec.id : undefined} accessibilityViewIsModal={modal}
      onLayout={(e) => { capture.onLayout(); onMeasure?.(e.nativeEvent.layout.height); }}
      style={[s.sheet, { paddingBottom: bottomInset }]}>
      {gesture ? <GestureDetector gesture={gesture}>{head}</GestureDetector> : head}
      <ScrollView style={s.body} contentContainerStyle={s.bodyContent} showsVerticalScrollIndicator={false}>{spec.body}</ScrollView>
      <View style={s.actions}>{spec.actions}</View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  layer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'flex-end' },
  motion: { marginTop: L.sheet.viewportTopClearance, maxHeight: '100%', flexShrink: 1 },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: t.color.overlay.scrim },
  sheet: {
    flexShrink: 1, backgroundColor: t.color.surface.paper,
    borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, borderCurve: 'continuous',
    paddingTop: L.sheet.paddingTop, paddingHorizontal: L.sheet.paddingHorizontal,
  },
  grabberRow: { position: 'absolute', top: L.sheet.grabberTop - L.sheet.paddingTop, left: 0, right: 0, alignItems: 'center' },
  grabber: { width: L.sheet.grabberWidth, height: L.sheet.grabberHeight, borderRadius: L.deviceChrome.homeIndicatorRadius, backgroundColor: t.color.border.divider },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: L.sheet.titleGap },
  title: { flexGrow: 1, flexShrink: 1, paddingTop: t.space.md },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingTop: L.sheet.titleGap, gap: L.sheet.sectionGap },
  actions: { gap: L.sheet.actionGap, paddingTop: L.sheet.sectionGap, paddingBottom: L.sheet.paddingBottom },
});
