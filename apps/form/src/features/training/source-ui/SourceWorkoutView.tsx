import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SourceWorkoutViewProps } from './contracts';
import { theme as t } from './theme';

function clock(seconds: number) {
  const rounded = Math.ceil(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

export function SourceWorkoutView({ fence, context, rest, onClose }: SourceWorkoutViewProps) {
  const active = rest.status !== 'unavailable' ? rest : null;
  const value = active?.value;
  const valid = fence.identity.kind === 'synthetic' && fence.identity.authority === 'none'
    && (fence.scenario === 'rest-running' || fence.scenario === 'rest-paused')
    && context.prescribedLoad.kind === 'unspecified' && context.prescribedLoad.basis === 'unknown'
    && (!value || (value.occurrenceId === context.occurrence.id
      && value.status === active?.status && Number.isFinite(value.remainingMs)
      && value.remainingMs > 0 && Number.isSafeInteger(value.durationSeconds)
      && value.durationSeconds > 0 && value.durationSeconds <= 10800
      && value.durationSeconds === context.prescription.rest_seconds
      && value.remainingMs <= value.durationSeconds * 1000));
  return <View testID="fdev-source-workout" style={s.page}>
    <Pressable testID="fdev-source-close" accessibilityRole="button"
      accessibilityLabel="Close synthetic preview" onPress={onClose} style={s.close}>
      <Text style={s.closeText}>Close</Text>
    </Pressable>
    {valid && active && value ? <ScrollView contentContainerStyle={s.content}
      contentInsetAdjustmentBehavior="automatic">
      <View testID="fdev-source-occurrence" style={s.heading}>
        <Text testID="fdev-preview-status" style={s.caption}>Synthetic preview</Text>
        <Text style={s.title}>Rest between sets</Text>
        <Text style={s.meta}>Movement {context.occurrence.position + 1}</Text>
      </View>
      <View style={s.panel}>
        <View style={s.row}><Text style={s.section}>Rest</Text>
          <Text testID="fdev-rest-status" style={s.meta}>{active.status === 'running' ? 'Running' : 'Paused'}</Text>
        </View>
        <View style={s.timerGroup}>
          <Text testID="fdev-rest-remaining" style={s.timer}>{clock(value.remainingMs / 1000)}</Text>
          <Text style={s.meta}>of {clock(value.durationSeconds)} practice rest</Text>
        </View>
        <View accessible={false} style={s.track}>
          <View style={{ flex: value.remainingMs / (value.durationSeconds * 1000), backgroundColor: t.action }} />
          <View style={{ flex: 1 - value.remainingMs / (value.durationSeconds * 1000) }} />
        </View>
        <Pressable testID="fdev-rest-toggle" accessibilityRole="button"
          onPress={() => { if (active.status === 'running') active.onPause(); else active.onResume(); }}
          style={({ pressed }) => [s.button, pressed && s.pressed]}>
          <Text style={s.buttonText}>{active.status === 'running' ? 'Pause rest' : 'Resume rest'}</Text>
        </Pressable>
      </View>
      <Text testID="fdev-source-load" style={s.load}>Load not specified.</Text>
    </ScrollView> : null}
  </View>;
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: t.canvas },
  close: { minHeight: t.target, marginHorizontal: t.gutter, marginTop: t.navGap, justifyContent: 'center' },
  closeText: { ...t.body, color: t.action },
  content: { paddingHorizontal: t.gutter, paddingTop: t.contentTop, paddingBottom: t.gutter },
  heading: { gap: t.small }, caption: { ...t.caption, color: t.secondary },
  title: { ...t.title, color: t.ink }, meta: { ...t.meta, color: t.secondary },
  panel: { marginTop: t.gutter, padding: t.panelPadding, borderRadius: t.radius,
    borderCurve: 'continuous', backgroundColor: t.selection },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.gap },
  section: { ...t.section, color: t.ink },
  timerGroup: { marginTop: t.timerTop, marginBottom: t.timerBottom, gap: t.small },
  timer: { ...t.timer, color: t.ink, fontVariant: ['tabular-nums'] },
  track: { flexDirection: 'row', height: t.trackHeight, borderRadius: t.capsule,
    overflow: 'hidden', backgroundColor: t.line },
  button: { marginTop: t.panelPadding, minHeight: t.buttonHeight, paddingVertical: t.contentTop,
    paddingHorizontal: t.gutter, borderRadius: t.buttonRadius, borderCurve: 'continuous',
    alignItems: 'center', justifyContent: 'center', backgroundColor: t.action },
  pressed: { backgroundColor: t.pressed }, buttonText: { ...t.button, color: t.onAction },
  load: { ...t.meta, color: t.secondary, marginTop: t.gutter },
});
