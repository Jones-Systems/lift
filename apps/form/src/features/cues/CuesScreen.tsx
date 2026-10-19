// cues (form-onboarding v1): required constraints are read-only; personal cues can be kept, rejected, reordered
// and marked for new wording. No wording generator or voice-command interpreter exists (cues.voice-review deferred).
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { AppMode, Cue, CuePreferences } from '../../api/domain';
import type { FormResources } from '../../api/resources';
import type { SaveResult } from '../contract';
import { guardedSave, useBusy } from '../shared/commands';
import { COPY, errorCopy } from '../shared/copy';
import { Icon } from '../shared/icons';
import { L, t } from '../shared/tokens';
import { Gutter, Nav, Notice, PlainAction, Screen, Section, Spinner, Subtitle, Title, Txt, selectionHaptic } from '../shared/ui';
import { useTextScale } from '../../variants/a/theme';

type Fields = Pick<CuePreferences, 'kept' | 'rejected' | 'order' | 'replacementRequested'>;
/** settings-training v2 copy.md cues.basic_footnote (Basic is read-only text; DGR-002). */
const CUES_BASIC_FOOTNOTE = 'To reorder or hide cues, switch to Advanced in Settings.';
type Banner = { kind: 'error' | 'info'; text: string; retry?: () => void } | null;

/** Unclassified available cues join "Your cues" locally; nothing is saved until Done. */
export function normalizeCues(prefs: CuePreferences): Fields {
  const rejected = prefs.rejected.filter((id) => !prefs.kept.includes(id));
  const order = prefs.order.filter((id) => prefs.kept.includes(id));
  for (const id of prefs.kept) if (!order.includes(id)) order.push(id);
  for (const cue of prefs.availableCues) if (!order.includes(cue.id) && !rejected.includes(cue.id)) order.push(cue.id);
  return { kept: [...order], order, rejected, replacementRequested: prefs.replacementRequested.filter((id) => order.includes(id)) };
}

export function CuesScreen({ resources, exerciseId, exerciseName, backLabel, appMode, onBack, onUnauthenticated }: {
  resources: FormResources; exerciseId: string; exerciseName: string; backLabel: string; appMode: AppMode;
  onBack: () => void; onUnauthenticated: () => void;
}) {
  const [current, setCurrent] = useState<CuePreferences | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const { busy, run: single } = useBusy();
  const [banner, setBanner] = useState<Banner>(null);
  const advanced = appMode === 'advanced';

  const load = async () => {
    setBanner(null);
    try {
      const prefs = await resources.cues(exerciseId);
      setCurrent(prefs); setFields(normalizeCues(prefs));
    } catch (error) {
      if ((error as { status?: number }).status === 401) onUnauthenticated();
      else setBanner({ kind: 'error', text: errorCopy(error), retry: () => void load() });
    }
  };
  useEffect(() => { void load(); /* once per movement */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseId]);

  const byId = useMemo(() => new Map<string, Cue>((current?.availableCues ?? []).map((c) => [c.id, c])), [current]);
  const dirty = !!current && !!fields && JSON.stringify(normalizeCues(current)) !== JSON.stringify(fields);

  const settle = (result: SaveResult<CuePreferences>) => {
    switch (result.status) {
      case 'saved': setCurrent(result.value); setFields(normalizeCues(result.value)); onBack(); return;
      case 'stale': setCurrent(result.latest); setBanner({ kind: 'info', text: COPY.stale }); return; // local edits kept
      case 'unknown':
        setBanner({ kind: 'error', text: 'The result could not be confirmed. Retry this same action without changing it.',
          retry: () => void save(result.retry) });
        return;
      default:
        if (result.error.status === 401) onUnauthenticated();
        else setBanner({ kind: 'error', text: errorCopy(result.error) });
    }
  };
  const save = (attempt?: () => Promise<SaveResult<CuePreferences>>) => single(async () => {
    if (!current || !fields) return;
    setBanner(null);
    const base = current;
    const body: Fields = { ...fields, kept: [...fields.order] };
    settle(await (attempt ?? (() => guardedSave(() => resources.saveCues(base, body), () => resources.cues(exerciseId))))());
  });

  const edit = (fn: (f: Fields) => Fields) => setFields((f) => (f ? fn(f) : f));
  const reject = (id: string) => edit((f) => ({
    order: f.order.filter((x) => x !== id), kept: f.kept.filter((x) => x !== id),
    rejected: [...f.rejected, id], replacementRequested: f.replacementRequested.filter((x) => x !== id),
  }));
  const restore = (id: string) => edit((f) => ({ ...f, rejected: f.rejected.filter((x) => x !== id), order: [...f.order, id], kept: [...f.kept, id] }));
  const requestNew = (id: string) => edit((f) => (f.replacementRequested.includes(id) ? f : { ...f, replacementRequested: [...f.replacementRequested, id] }));
  const cancelNew = (id: string) => edit((f) => ({ ...f, replacementRequested: f.replacementRequested.filter((x) => x !== id) }));
  const move = (from: number, to: number) => edit((f) => {
    const order = [...f.order];
    const target = Math.max(0, Math.min(order.length - 1, to));
    if (target === from) return f;
    const [id] = order.splice(from, 1);
    order.splice(target, 0, id);
    selectionHaptic();
    return { ...f, order, kept: [...order] };
  });

  return (
    <Screen testID="screen-cues"
      nav={<Nav back={backLabel} onBack={onBack} trailing={dirty
        ? <PlainAction label="Done" captureId="a-cues-done" chevron={null} placement="trailing" disabled={busy} onPress={() => void save()} />
        : <PlainAction label="Done" captureId="a-cues-done" chevron={null} placement="trailing" onPress={onBack} />} />}>
      <Gutter>
        <Title text={`${exerciseName} cues`} testID="a-cues-title" />
        <Subtitle text="Keep the cues that help." />
      </Gutter>
      {banner ? (
        <Section tight><Notice kind={banner.kind} text={banner.text} announce action={banner.retry ? { label: 'Try again', onPress: banner.retry } : null} /></Section>
      ) : null}
      {!current || !fields ? <Section><Spinner /></Section> : (
        <>
          <Section style={s.first}>
            <View style={s.label}>
              <Txt role="bodyStrong">Always shown</Txt>
              <Txt role="meta" tone="secondary">These cues stay.</Txt>
            </View>
            <View testID="a-cues-locked" accessibilityRole="list">
              {current.requiredConstraints.map((c, i, list) => (
                <View key={c.id} style={[s.row, i === list.length - 1 && s.rowLast]}>
                  <View style={s.lock} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <Icon name="lock" size={L.icon.notice} color={t.color.ink} />
                  </View>
                  <Txt role="body" style={s.text}>{c.text}</Txt>
                </View>
              ))}
            </View>
          </Section>
          <Section>
            <Txt role="bodyStrong">Your cues</Txt>
            <View testID="a-cues-mine" accessibilityRole="list">
              {fields.order.map((id, i) => {
                const cue = byId.get(id);
                if (!cue) return null;
                const requested = fields.replacementRequested.includes(id);
                return (
                  <View key={id}>
                    <CueRow cue={cue} index={i} count={fields.order.length} advanced={advanced} requested={requested}
                      last={i === fields.order.length - 1 && !requested}
                      onMove={(to) => move(i, to)} onReject={() => reject(id)} onReplace={() => requestNew(id)} />
                    {requested ? (
                      <View testID="a-cue-proposal" style={s.proposal}>
                        <Txt role="bodyStrong">New wording requested</Txt>
                        <Txt role="meta" tone="secondary">This cue stays as it is until another way to say it is ready.</Txt>
                        {advanced ? <PlainAction label="Cancel request" captureId="a-cue-cancel-request" chevron={null} lead="undo-2" onPress={() => cancelNew(id)} /> : null}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
            {advanced ? <Txt role="meta" tone="secondary">Drag to change the order. Swipe left to remove, right for new wording.</Txt>
              : <Txt role="meta" tone="secondary" testID="a-cues-basic-footnote">{CUES_BASIC_FOOTNOTE}</Txt>}
          </Section>
          {advanced && fields.rejected.length ? (
            <Section style={s.bottom}>
              <Txt role="bodyStrong">Not for me</Txt>
              {fields.rejected.map((id, i) => {
                const cue = byId.get(id);
                if (!cue) return null;
                return (
                  <View key={id} style={[s.row, i === fields.rejected.length - 1 && s.rowLast]}>
                    <RemovedRow text={cue.text} onRestore={() => restore(id)} />
                  </View>
                );
              })}
            </Section>
          ) : null}
        </>
      )}
    </Screen>
  );
}

/** OB-09 CueRow (mine): grip + order + text + visible Replace. Basic presentation shows the text only (DGR-002). */
function CueRow({ cue, index, count, advanced, requested, last, onMove, onReject, onReplace }: {
  cue: Cue; index: number; count: number; advanced: boolean; requested: boolean; last: boolean;
  onMove: (to: number) => void; onReject: () => void; onReplace: () => void;
}) {
  const { large } = useTextScale();
  const dragY = useSharedValue(0);
  const swipeX = useSharedValue(0);
  const lifted = useSharedValue(0);
  const step = L.cue.minHeight;
  const swipeThreshold = L.cue.minHeight + t.space.s16;

  const drag = Gesture.Pan().activateAfterLongPress(t.motion.sheet)
    .onStart(() => { lifted.value = 1; })
    .onUpdate((e) => { dragY.value = e.translationY; })
    .onEnd((e) => { runOnJS(onMove)(index + Math.round(e.translationY / step)); })
    .onFinalize(() => { dragY.value = withTiming(0, { duration: t.motion.press }); lifted.value = 0; });
  const swipe = Gesture.Pan().activeOffsetX([-t.space.s20, t.space.s20]).failOffsetY([-t.space.s12, t.space.s12])
    .onUpdate((e) => { swipeX.value = e.translationX; })
    .onEnd((e) => {
      if (e.translationX <= -swipeThreshold) runOnJS(onReject)();
      else if (e.translationX >= swipeThreshold) runOnJS(onReplace)();
    })
    .onFinalize(() => { swipeX.value = withTiming(0, { duration: t.motion.press }); });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dragY.value }, { translateX: swipeX.value }],
    zIndex: lifted.value ? 1 : 0,
    backgroundColor: lifted.value ? t.color.selection : t.color.canvas,
  }));

  const actions = [
    ...(index > 0 ? [{ name: 'moveUp', label: 'Move up' }] : []),
    ...(index < count - 1 ? [{ name: 'moveDown', label: 'Move down' }] : []),
    { name: 'remove', label: 'Remove' },
    ...(requested ? [] : [{ name: 'replace', label: 'Ask for new wording' }]),
  ];

  const content = (
    <Reanimated.View testID={`a-cue-${index + 1}`} accessible accessibilityLabel={advanced ? `${index + 1}. ${cue.text}` : cue.text}
      accessibilityActions={advanced ? actions : []}
      onAccessibilityAction={(e) => {
        switch (e.nativeEvent.actionName) {
          case 'moveUp': onMove(index - 1); break;
          case 'moveDown': onMove(index + 1); break;
          case 'remove': onReject(); break;
          case 'replace': onReplace(); break;
        }
      }}
      style={[s.row, (last || requested) && s.rowLast, advanced && rowStyle]}>
      {advanced ? (
        <GestureDetector gesture={drag}>
          <View style={[s.grip, large && s.topAligned]} accessibilityLabel="Reorder" accessibilityRole="button">
            <Icon name="grip-vertical" size={L.icon.standard} color={t.color.secondary} />
          </View>
        </GestureDetector>
      ) : null}
      {advanced ? <Txt role="sectionTitle" style={[s.ord, large && s.ordLarge]} accessibilityElementsHidden importantForAccessibility="no">{String(index + 1)}</Txt> : null}
      <View style={[s.main, large && s.mainLarge]}>
        <Txt role="body" style={[s.text, large && s.textLarge]}>{cue.text}</Txt>
        {advanced && !requested ? (
          <PlainAction label="Replace" captureId={`a-cue-replace-${index + 1}`} chevron={null} onPress={onReplace}
            accessibilityLabel={`Replace: ask for new wording of “${cue.text}”`} style={large ? s.replaceLarge : s.replace} />
        ) : null}
      </View>
    </Reanimated.View>
  );
  return advanced ? <GestureDetector gesture={swipe}>{content}</GestureDetector> : content;
}

function RemovedRow({ text, onRestore }: { text: string; onRestore: () => void }) {
  const { large } = useTextScale();
  return (
    <View style={[s.main, large && s.mainLarge]}>
      <Txt role="body" tone="secondary" style={[s.text, large && s.textLarge]}>{text}</Txt>
      <PlainAction label="Restore" captureId="a-cue-restore" chevron={null} lead="undo-2" onPress={onRestore}
        accessibilityLabel={`Restore “${text}”`} style={large ? s.replaceLarge : s.replace} />
    </View>
  );
}

const s = StyleSheet.create({
  first: { marginTop: t.space.s24 },
  bottom: { marginBottom: t.space.s24 },
  label: { gap: t.space.s8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: t.space.s8, minHeight: L.cue.minHeight,
    borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line,
  },
  rowLast: { borderBottomWidth: 0 },
  lock: { width: L.cue.handleTarget, height: L.cue.handleTarget, alignItems: 'center', justifyContent: 'center', marginLeft: -t.space.s12 },
  grip: { width: L.cue.handleTarget, height: L.cue.handleTarget, alignItems: 'center', justifyContent: 'center', marginLeft: -t.space.s12 },
  topAligned: { alignSelf: 'flex-start', marginTop: t.space.s8 },
  ord: { minWidth: t.type.sectionTitle.fontSize * L.movementRow.ordinalColumn },
  ordLarge: { alignSelf: 'flex-start', marginTop: t.space.s12 },
  main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: t.space.s8 },
  mainLarge: { flexDirection: 'column', alignItems: 'flex-start', paddingBottom: t.space.s8 },
  text: { flex: 1, minWidth: 0, paddingVertical: t.space.s12 },
  textLarge: { flex: 0, paddingBottom: t.space.s0 },
  replace: { alignSelf: 'center', paddingLeft: L.plainAction.paddingX, paddingRight: t.space.s0 },
  replaceLarge: { alignSelf: 'flex-start', paddingLeft: t.space.s0 },
  proposal: {
    backgroundColor: t.color.selection, borderRadius: t.radius.message, paddingVertical: t.space.s16,
    paddingHorizontal: t.page.coach.proposalPadding, gap: t.space.s8, marginBottom: t.space.s12,
  },
});
