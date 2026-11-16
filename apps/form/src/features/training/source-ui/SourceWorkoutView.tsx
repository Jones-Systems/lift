import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PreviewDenial } from '../../syntheticPreviewContract';
import type { ForegroundRestState, SourceWorkoutViewProps } from './contracts';
import { CloseFooter, DismissHeader, LocalMessage, NoticeStack, PreviewNotice, PreviewText,
  PrimaryButton, SafeMetadata, denialCopy, fenceReason, isDenial, object, positiveRevision, textValue, ui,
  useLocalResult } from '../../../community/group-ui/COM01GroupList';
import type { NoticeCopy } from '../../../community/group-ui/COM01GroupList';
import { theme as t } from './theme';

function clock(seconds: number) {
  const rounded = Math.ceil(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

function duration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10800;
}
function validContext(value: unknown): boolean {
  if (!object(value) || !object(value.session) || !object(value.occurrence)
    || !object(value.prescription) || !object(value.prescribedLoad)) return false;
  const { session, occurrence, prescription, prescribedLoad } = value;
  return textValue(session.sessionId) && positiveRevision(session.sessionRevision)
    && textValue(session.planId) && positiveRevision(session.planRevision)
    && (session.sessionStatus === 'active' || session.sessionStatus === 'completed')
    && textValue(occurrence.id) && textValue(occurrence.itemId) && textValue(occurrence.exerciseId)
    && typeof occurrence.position === 'number' && Number.isSafeInteger(occurrence.position)
    && occurrence.position >= 0 && Number.isSafeInteger(occurrence.position + 1)
    && duration(prescription.rest_seconds)
    && prescribedLoad.kind === 'unspecified' && prescribedLoad.basis === 'unknown';
}
type ActiveRest = Exclude<ForegroundRestState, { status: 'unavailable' }>;
type RestPresentation = Readonly<{
  contextSafe: boolean; active: ActiveRest | null;
  reason: PreviewDenial | 'no_rest' | 'rest_finished' | null;
  copy: NoticeCopy | null; plainPanel: boolean;
}>;
function restPresentation(props: SourceWorkoutViewProps): RestPresentation {
  const fail = (reason: PreviewDenial): RestPresentation => ({ contextSafe: false, active: null,
    reason, copy: denialCopy(reason), plainPanel: false });
  // Defensive projection checks do not establish admission, currentness or a live lease.
  if (!validContext(props.context) || typeof props.onClose !== 'function')
    return fail('invalid_fixture');
  const invalidFence = fenceReason(props.fence, 'rest');
  if (invalidFence) return fail(invalidFence);
  const rest: unknown = props.rest;
  if (!object(rest)) return fail('invalid_fixture');
  if (rest.status !== 'unavailable' && rest.status !== 'running' && rest.status !== 'paused') return fail('unsupported_state');
  if (rest.status === 'unavailable') {
    if (rest.value !== null) return fail('invalid_fixture');
    if (rest.reason === 'no_rest' || rest.reason === 'rest_finished') return {
      contextSafe: true, active: null, reason: rest.reason, plainPanel: true,
      copy: rest.reason === 'no_rest'
        ? { title: 'Rest unavailable', body: 'No practice rest is available for this movement.' }
        : { title: 'Rest finished', body: 'This practice rest has finished. No timer controls are available.' },
    };
    if (!isDenial(rest.reason)) return fail('unsupported_state');
    return { contextSafe: true, active: null, reason: rest.reason, copy: denialCopy(rest.reason), plainPanel: false };
  }
  const value = rest.value;
  if (!object(value)) return fail('invalid_fixture');
  if (typeof value.remainingMs !== 'number' || !Number.isFinite(value.remainingMs) || value.remainingMs < 0
    || !duration(value.durationSeconds) || value.durationSeconds !== props.context.prescription.rest_seconds
    || value.remainingMs > value.durationSeconds * 1000 || value.occurrenceId !== props.context.occurrence.id)
    return fail('invalid_fixture');
  if (value.status === 'finished' || value.status === 'idle') return fail('unsupported_state');
  if (value.status !== rest.status || (rest.status === 'running' ? typeof rest.onPause !== 'function' : typeof rest.onResume !== 'function'))
    return fail('invalid_fixture');
  if (value.remainingMs === 0) return fail('unsupported_state');
  return { contextSafe: true, active: props.rest.status === 'unavailable' ? null : props.rest,
    reason: null, copy: null, plainPanel: false };
}

export function SourceWorkoutView(props: SourceWorkoutViewProps) {
  const local = useLocalResult(props);
  const view = restPresentation(props);
  const active = view.active;
  const value = active?.value;
  return <View testID="fdev-source-workout" style={s.page}>
    <DismissHeader id="fdev-source-close" onClose={() => local.close(props.onClose)} />
    <ScrollView style={s.scroll} contentContainerStyle={s.content} contentInsetAdjustmentBehavior="never">
      <View style={s.heading}>
        <PreviewText id="fdev-preview-status" kind="caption" secondary>Synthetic preview</PreviewText>
        <PreviewText kind="exerciseTitle" heading>{view.contextSafe ? 'Rest between sets' : 'Rest preview'}</PreviewText>
        {view.contextSafe && <PreviewText id="fdev-source-occurrence" kind="meta" secondary>Movement {props.context.occurrence.position + 1}</PreviewText>}
      </View>
      {active && value && <View style={s.panel}>
        <View style={s.row}>
          <PreviewText kind="sectionTitle" heading>Rest</PreviewText>
          <PreviewText id="fdev-rest-status" kind="meta" secondary>{active.status === 'running' ? 'Running' : 'Paused'}</PreviewText>
        </View>
        <View style={s.timerGroup}>
          <Text testID="fdev-rest-remaining" allowFontScaling dynamicTypeRamp="title1" style={s.timer}>{clock(value.remainingMs / 1000)}</Text>
          <PreviewText kind="meta" secondary>of {clock(value.durationSeconds)} practice rest</PreviewText>
        </View>
        <View accessible={false} importantForAccessibility="no-hide-descendants" style={s.track}>
          <View style={[s.remaining, { flex: value.remainingMs / (value.durationSeconds * 1000) }]} />
          <View style={{ flex: 1 - value.remainingMs / (value.durationSeconds * 1000) }} />
        </View>
        {!local.blocked && <View style={s.restActions}>
          <PrimaryButton id="fdev-rest-toggle" label={active.status === 'running' ? 'Pause rest' : 'Resume rest'}
            disabled={!local.canRequest('rest')} onPress={() => local.request('rest', () => active.status === 'running' ? active.onPause() : active.onResume())} />
        </View>}
      </View>}
      {view.copy && (view.plainPanel ? <View testID="fdev-rest-notice" accessibilityLiveRegion="polite" style={[s.panel, s.plainPanel]}>
        <PreviewText kind="sectionTitle" heading>{view.copy.title}</PreviewText>
        <PreviewText>{view.copy.body}</PreviewText>
        <PreviewText kind="meta" secondary>Reason: {view.reason}</PreviewText>
      </View> : <View style={ui.sectionGap}><PreviewNotice id="fdev-rest-notice" copy={view.copy} /></View>)}
      <NoticeStack base={null} baseId="fdev-rest-notice" uncertainty="none" local={local} />
      {((view.reason && !view.plainPanel) || local.reason) && <SafeMetadata reason={view.plainPanel ? null : view.reason}
        localReason={local.reason} uncertainty="none" />}
      <LocalMessage local={local} />
      {view.contextSafe && <View style={ui.sectionGap}><PreviewText id="fdev-source-load" kind="meta" secondary>Load not specified.</PreviewText></View>}
    </ScrollView>
    <CloseFooter onClose={() => local.close(props.onClose)} />
  </View>;
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: t.color.canvas }, scroll: { flex: 1 },
  content: { paddingHorizontal: t.layout.frame.gutter, paddingTop: t.space.s16, paddingBottom: t.checkpoint.scrollPad },
  heading: { gap: t.space.s4 },
  panel: { marginTop: t.space.s24, padding: t.layout.restPanel.padding, borderRadius: t.radius.rest,
    borderCurve: 'continuous', backgroundColor: t.color.selection },
  plainPanel: { gap: t.layout.restPanel.gap },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: t.space.s12 },
  timerGroup: { marginTop: t.checkpoint.timerTopGap, marginBottom: t.checkpoint.timerBottomGap, gap: t.space.s4 },
  timer: { ...t.type.stat, color: t.color.ink, fontVariant: ['tabular-nums'] },
  track: { flexDirection: 'row', height: t.checkpoint.progressHeight, borderRadius: t.radius.capsule,
    overflow: 'hidden', backgroundColor: t.color.line },
  remaining: { backgroundColor: t.color.action },
  restActions: { marginTop: t.space.s20, gap: t.space.s8 },
});
