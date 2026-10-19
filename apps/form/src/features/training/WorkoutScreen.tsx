// workout (settings-training v2 DESIGN #training, #remove-set; contracts.md#mode-matrix). Logs one active server session.
// Both modes log sets as confirmed. Required-constraint cues and unknown/conflict notices look the same in both modes.
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AppMode, CuePreferences, Exercise, PerformedSet, Preferences, Stats, WorkoutSession } from '../../api/domain';
import type { FormResources } from '../../api/resources';
import { SetChips, type ChipState } from '../../variants/a/components';
import { useTextScale, usePrefs } from '../../variants/a/theme';
import { Icon } from '../shared/icons';
import { L, t } from '../shared/tokens';
import {
  Art, Fields, Gutter, MetaLine, Nav, Notice, PlainAction, PrimaryAction, Screen, Section, Sheet, Spinner, StepperField, Txt,
} from '../shared/ui';
import { TC, trainingErrorCopy } from './copy';
import {
  displayLoad, formatNumber, kgFromDisplay, keptCues, loadLabel, loadStep, nextSetNumber, orderedOccurrences, plannedSets, plural,
  repsRange, sessionTotals, setsOf, toServerError, type Remote,
} from './model';
import { rowStatus, SetLogRow, TargetTable, type TargetRow } from './parts';
import type { SetCommand, useWorkout } from './useWorkout';

type Workout = ReturnType<typeof useWorkout>;
type LoadUnit = Preferences['loadUnit'];
type Draft = { occurrenceId: string; reps: number; weightKg: number };

export function WorkoutScreen({ resources, appMode, workout, exercises, loadUnit, stats, onLeave, onOpenCues }: {
  resources: FormResources;
  appMode: AppMode;
  workout: Workout;
  exercises: Record<string, Exercise>;
  loadUnit: LoadUnit;
  stats: Stats | null;
  onLeave: () => void;
  onOpenCues: (exerciseId: string) => void;
}) {
  const { session, commands, notice, complete } = workout;
  const advanced = appMode === 'advanced';
  const { large } = useTextScale();
  const { reduceMotion } = usePrefs();
  const occurrences = useMemo(() => orderedOccurrences(session), [session]);
  const [focusId, setFocusId] = useState<string>(() => firstOpen(session) ?? occurrences[0]?.id ?? '');
  const occurrence = occurrences.find((o) => o.id === focusId) ?? occurrences[0];
  const index = occurrence ? occurrences.indexOf(occurrence) : 0;
  const exercise = occurrence ? exercises[occurrence.exerciseId] : undefined;
  const exerciseName = exercise?.name ?? 'Movement';
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<PerformedSet | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const cues = useCues(resources, occurrence?.exerciseId ?? null);
  const voidAvailable = typeof resources.voidSet === 'function';
  const active = session.status === 'active';

  if (!occurrence) {
    return (
      <Screen testID="screen-workout" nav={<Nav back="Workout" onBack={onLeave} />}>
        <Section><Notice kind="info" text="This workout has no movements." /></Section>
      </Screen>
    );
  }

  const performed = setsOf(session, occurrence.id);
  const confirmed = performed.filter((s) => s.status === 'confirmed');
  const queuedAdds = commands.filter((c) => c.payload.kind === 'add' && c.payload.set.occurrenceId === occurrence.id);
  const target = occurrence.target;
  const doneCount = confirmed.length;
  const reachedTarget = doneCount >= target.setTarget;
  const last = confirmed.at(-1);
  // Prefill from the last confirmed set of this occurrence, otherwise the snapshot target.
  const baseReps = last?.reps ?? target.repMax;
  const baseKg = last?.weightKg ?? target.targetKg;
  const current = draft && draft.occurrenceId === occurrence.id ? draft : { occurrenceId: occurrence.id, reps: baseReps, weightKg: baseKg };
  const next = occurrences[index + 1];

  const commandFor = (setId: string) => commands.find((c) => c.payload.kind !== 'add' && c.payload.setId === setId) ?? null;
  const unknownNotice = notice?.kind === 'warning' ? notice : null;

  const logSet = () => {
    const queued = commands.flatMap((c) => (c.payload.kind === 'add' ? [c.payload.set] : []));
    workout.logSet({
      occurrenceId: occurrence.id, setNumber: nextSetNumber(session, occurrence.id, queued),
      reps: current.reps, weightKg: current.weightKg, status: 'confirmed',
    });
    setDraft(null);
  };
  const focus = (id: string) => { setFocusId(id); setDraft(null); setListOpen(false); };

  const primary = (() => {
    if (!active) return null;
    if (reachedTarget && next) return { label: `Next: ${exercises[next.exerciseId]?.name ?? 'Movement'}`, onPress: () => focus(next.id) };
    if (reachedTarget) return { label: 'Finish workout', onPress: () => setFinishOpen(true) };
    return { label: TC.confirm, onPress: logSet };
  })();

  const stepReps = (d: -1 | 1) => setDraft({ ...current, reps: Math.min(100, Math.max(0, current.reps + d)) });
  const stepWeight = (d: -1 | 1) => {
    const shown = displayLoad(current.weightKg, loadUnit) + d * loadStep(loadUnit);
    setDraft({ ...current, weightKg: Math.min(500, Math.max(0, kgFromDisplay(Math.max(0, shown), loadUnit))) });
  };

  const best = advanced ? stats?.byExercise.find((b) => b.exerciseId === occurrence.exerciseId) : undefined;
  const totals = sessionTotals(session);
  const required = exercise?.requiredConstraints ?? [];
  const cueTexts = cues.status === 'ready' ? keptCues(cues.value) : [];

  const fields = (
    <Fields>
      <StepperField label="Reps" value={String(current.reps)} testID="a-workout-reps" onStep={stepReps} />
      <StepperField label={`Weight, ${loadUnit}`} value={formatNumber(displayLoad(current.weightKg, loadUnit))}
        testID="a-workout-weight" onStep={stepWeight} />
    </Fields>
  );

  const loggedRows = [
    ...performed.map((set) => {
      const command = commandFor(set.id);
      return (
        <SetLogRow key={set.id} n={set.setNumber} reps={set.reps} weightKg={set.weightKg} unit={loadUnit}
          testID={`a-setlog-${set.setNumber}`}
          status={rowStatus(set, command?.state ?? null, command?.payload.kind === 'void')}
          onPress={active && set.status !== 'voided' && !command ? () => setEditing(set) : undefined}
          onRetry={command ? () => workout.retryCommand(command.key) : undefined}
          onConfirm={active && set.status === 'draft' && !command
            ? () => workout.editSet(set, { reps: set.reps, weightKg: set.weightKg, status: 'confirmed' }) : undefined} />
      );
    }),
    ...queuedAdds.map((c) => c.payload.kind === 'add' ? (
      <SetLogRow key={c.key} n={c.payload.set.setNumber} reps={c.payload.set.reps} weightKg={c.payload.set.weightKg} unit={loadUnit}
        status={rowStatus(null, c.state, false)} onRetry={() => workout.retryCommand(c.key)} />
    ) : null),
  ];

  const tableRows: TargetRow[] = [
    ...performed.map((set) => {
      const command = commandFor(set.id);
      return { n: set.setNumber, set, status: rowStatus(set, command?.state ?? null, command?.payload.kind === 'void'), current: false };
    }),
    ...queuedAdds.flatMap((c) => (c.payload.kind === 'add'
      ? [{ n: c.payload.set.setNumber, set: null, status: rowStatus(null, c.state, false), current: false,
        reps: c.payload.set.reps, weightKg: c.payload.set.weightKg }] : [])),
  ];
  const nextN = nextSetNumber(session, occurrence.id, queuedAdds.flatMap((c) => (c.payload.kind === 'add' ? [c.payload.set] : [])));
  if (active && !reachedTarget) tableRows.push({ n: nextN, set: null, status: 'saved', current: true });

  const chips: ChipState[] = Array.from({ length: target.setTarget }, (_, i) =>
    (i < doneCount ? 'done' : i === doneCount ? 'current' : 'not-started'));

  const requiredBlock = required.length ? (
    <View style={s.cues} testID="a-workout-required">
      {required.map((c) => (
        <View key={c.id} style={s.locked}>
          <Icon name="lock" size={L.icon.notice} color={t.color.ink} />
          <Txt role="body" style={s.flex}>{c.text}</Txt>
        </View>
      ))}
    </View>
  ) : null;

  return (
    <>
      <Screen testID="screen-workout" nav={(
        <Nav back="Workout" onBack={onLeave} trailing={active
          ? <PlainAction label="Finish" captureId="a-workout-finish" chevron={null} placement="trailing" onPress={() => setFinishOpen(true)} />
          : undefined} />
      )}>
        <Gutter>
          <Txt role="bodyStrong">{session.planSnapshot.name}</Txt>
          <Txt role="meta" tone="secondary">{`Movement ${index + 1} of ${occurrences.length}`}</Txt>
          <Txt role="exerciseTitle" accessibilityRole="header" style={s.title}>{exerciseName}</Txt>
        </Gutter>
        {!advanced && !large ? <Gutter style={s.gap24}><Art /></Gutter> : null}
        <Section tight>
          {requiredBlock}
          {!advanced && cueTexts[0] ? <Txt role="body" testID="a-workout-cue">{cueTexts[0]}</Txt> : null}
          <Txt role="bodyStrong" testID="a-workout-target">
            {`${plural(target.setTarget, 'set', 'sets')} · ${repsRange(target.repMin, target.repMax)} · ${loadLabel(target.targetKg, loadUnit)}`}
          </Txt>
          {advanced && best && best.maxWeightKg > 0 ? (
            <Txt role="meta" tone="secondary">{`Best confirmed: ${loadLabel(best.maxWeightKg, loadUnit)}`}</Txt>
          ) : null}
          {advanced
            ? <TargetTable target={target} rows={tableRows} unit={loadUnit}
              onPress={active ? (row) => row.set && !commandFor(row.set.id) && setEditing(row.set) : undefined}
              onRetry={(row) => {
                const c = row.set ? commandFor(row.set.id) : queuedAdds.find((q) => q.payload.kind === 'add' && q.payload.set.setNumber === row.n);
                if (c) workout.retryCommand(c.key);
              }} />
            : <SetChips label={`Set ${Math.min(doneCount + 1, target.setTarget)} of ${target.setTarget}`} chips={chips} reduceMotion={reduceMotion} register={false} />}
        </Section>
        {active ? <Section tight>{fields}</Section> : null}
        {workout.notice && workout.notice.kind !== 'warning' ? (
          <Section tight>
            <Notice kind={workout.notice.kind} text={workout.notice.text} announce
              action={workout.notice.retryKey ? { label: TC.tryAgain, onPress: () => workout.retryCommand(workout.notice!.retryKey!) } : null} />
          </Section>
        ) : null}
        {unknownNotice ? (
          <Section tight>
            <Notice kind="warning" text={unknownNotice.text} announce
              action={{ label: TC.tryAgain, onPress: () => unknownNotice.retryKey && workout.retryCommand(unknownNotice.retryKey) }} />
            <PlainAction label="Check what saved" chevron={null} onPress={() => void workout.reconcile()} />
          </Section>
        ) : null}
        {primary ? (
          <Section tight>
            <PrimaryAction label={primary.label} captureId="a-workout-primary" onPress={primary.onPress} />
            {reachedTarget ? <PlainAction label="Log another set" captureId="a-log-another" chevron={null} onPress={logSet} /> : null}
          </Section>
        ) : null}
        {advanced ? (
          <Section tight>
            {cueTexts.length ? (
              <View style={s.cues}>
                <Txt role="bodyStrong">Cues</Txt>
                {cueTexts.map((text, i) => <Txt key={text} role="body">{`${i + 1}. ${text}`}</Txt>)}
              </View>
            ) : null}
            <PlainAction label="Cue settings" captureId="a-cue-settings" onPress={() => onOpenCues(occurrence.exerciseId)} />
            <View style={s.cues} testID="a-workout-totals">
              <Txt role="bodyStrong">This workout</Txt>
              <MetaLine items={[plural(totals.confirmedSets, 'confirmed set', 'confirmed sets'), plural(totals.repetitions, 'rep', 'reps'),
                ...(totals.volumeKg > 0 ? [`${loadLabel(totals.volumeKg, loadUnit)} volume`] : [])]} />
            </View>
          </Section>
        ) : (
          <Section tight>{loggedRows}</Section>
        )}
        <Section tight>
          <Txt role="meta" tone="secondary">{TC.confirmedOnly}</Txt>
          <PlainAction label={`See all ${occurrences.length} movements`} captureId="a-all-movements" onPress={() => setListOpen(true)} />
        </Section>
        {workout.refresh.error ? (
          <Section tight>
            <Notice kind="error" text={trainingErrorCopy(workout.refresh.error, false)} action={{ label: TC.tryAgain, onPress: () => void workout.reconcile() }} />
          </Section>
        ) : null}
      </Screen>

      <Sheet visible={listOpen} title={`${occurrences.length} movements`} onClose={() => setListOpen(false)}>
        {occurrences.map((o) => {
          const done = setsOf(session, o.id).filter((x) => x.status === 'confirmed').length;
          return (
            <PlainAction key={o.id} label={`${exercises[o.exerciseId]?.name ?? 'Movement'} · ${done} of ${o.target.setTarget}`}
              tone={o.id === occurrence.id ? 'ink' : 'action'} onPress={() => focus(o.id)} />
          );
        })}
      </Sheet>

      <EditSetSheet set={editing} unit={loadUnit} voidAvailable={voidAvailable && active} onClose={() => setEditing(null)}
        onSave={(set, changes) => { workout.editSet(set, changes); setEditing(null); }}
        onRemove={(set) => { workout.voidSet(set); setEditing(null); }} />

      <FinishSheet visible={finishOpen} session={session} commands={commands} complete={complete}
        onClose={() => { setFinishOpen(false); workout.resetFinish(); }} onFinish={() => void workout.finish()} />
    </>
  );
}

function firstOpen(session: WorkoutSession): string | null {
  const open = orderedOccurrences(session).find((o) =>
    setsOf(session, o.id).filter((x) => x.status === 'confirmed').length < o.target.setTarget);
  return open?.id ?? null;
}

/** Cue preferences for the focused movement, fetched lazily. A failed load simply shows no personal cue. */
function useCues(resources: FormResources, exerciseId: string | null): Remote<CuePreferences> {
  const [byId, setById] = useState<Record<string, Remote<CuePreferences>>>({});
  useEffect(() => {
    if (!exerciseId || (byId[exerciseId] && byId[exerciseId].status !== 'loading')) return;
    let alive = true;
    setById((m) => ({ ...m, [exerciseId]: { status: 'loading' } }));
    resources.cues(exerciseId)
      .then((value) => { if (alive) setById((m) => ({ ...m, [exerciseId]: { status: 'ready', value, refreshing: false, refreshError: null } })); })
      .catch((error) => { if (alive) setById((m) => ({ ...m, [exerciseId]: { status: 'error', error: toServerError(error) } })); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseId, resources]);
  return exerciseId ? byId[exerciseId] ?? { status: 'loading' } : { status: 'loading' };
}

/* ---------------- edit-set sheet with Remove (active sessions only) ---------------- */

function EditSetSheet({ set, unit, voidAvailable, onClose, onSave, onRemove }: {
  set: PerformedSet | null; unit: LoadUnit; voidAvailable: boolean; onClose: () => void;
  onSave: (set: PerformedSet, changes: { reps: number; weightKg: number; status: 'draft' | 'confirmed' }) => void;
  onRemove: (set: PerformedSet) => void;
}) {
  const [reps, setReps] = useState<number | null>(null);
  const [kg, setKg] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const close = () => { setReps(null); setKg(null); setConfirmRemove(false); onClose(); };
  if (!set) return <Sheet visible={false} title="" onClose={close}>{null}</Sheet>;
  const r = reps ?? set.reps;
  const w = kg ?? set.weightKg; // unchanged weight is written back exactly, never through display rounding
  if (confirmRemove) {
    return (
      <Sheet visible title={`Set ${set.setNumber}`} onClose={close} testID="a-remove-sheet"
        actions={(
          <>
            <PrimaryAction label={TC.removePrimary} captureId="a-set-remove-confirm" onPress={() => { onRemove(set); close(); }} />
            <PlainAction label={TC.removeCancel} chevron={null} placement="centered" onPress={() => setConfirmRemove(false)} />
          </>
        )}>
        <Txt role="body">{TC.removeConfirm(set.setNumber)}</Txt>
      </Sheet>
    );
  }
  return (
    <Sheet visible title={`Set ${set.setNumber}`} onClose={close} testID="a-edit-set"
      actions={(
        <>
          {/* A draft set logged elsewhere is confirmed here ("Not confirmed" → Confirm); both modes log confirmed sets. */}
          <PrimaryAction label={set.status === 'draft' ? TC.confirm : 'Save changes'} captureId="a-set-save"
            disabled={set.status !== 'draft' && reps === null && kg === null}
            onPress={() => { onSave(set, { reps: r, weightKg: w, status: 'confirmed' }); close(); }} />
          {voidAvailable ? (
            <PlainAction label={TC.removePrimary} captureId="a-set-remove" tone="ink" chevron={null} placement="centered" onPress={() => setConfirmRemove(true)} />
          ) : null}
        </>
      )}>
      <Fields>
        <StepperField label="Reps" value={String(r)} onStep={(d) => setReps(Math.min(100, Math.max(0, r + d)))} />
        <StepperField label={`Weight, ${unit}`} value={formatNumber(displayLoad(w, unit))}
          onStep={(d) => setKg(Math.min(500, Math.max(0, kgFromDisplay(Math.max(0, displayLoad(w, unit) + d * loadStep(unit)), unit))))} />
      </Fields>
    </Sheet>
  );
}

/* ---------------- finish sheet ---------------- */

function FinishSheet({ visible, session, commands, complete, onClose, onFinish }: {
  visible: boolean; session: WorkoutSession; commands: readonly SetCommand[];
  complete: Workout['complete']; onClose: () => void; onFinish: () => void;
}) {
  const done = session.sets.filter((x) => x.status === 'confirmed').length;
  const settling = commands.length > 0;
  const state = complete?.state;
  return (
    <Sheet visible={visible} title={TC.finishTitle} onClose={onClose} testID="a-finish-sheet"
      actions={(
        <>
          <PrimaryAction label="Finish workout" captureId="a-finish-confirm" disabled={settling}
            loading={state?.status === 'pending'} onPress={onFinish} />
          <PlainAction label={TC.keepGoing} chevron={null} placement="centered" onPress={onClose} />
        </>
      )}>
      <Txt role="body">{TC.finishBody(done, plannedSets(session))}</Txt>
      {settling ? (
        <View style={s.row}><Spinner /><Txt role="meta" tone="secondary" style={s.flex}>Waiting for your sets to save first.</Txt></View>
      ) : null}
      {state?.status === 'unknown' ? <Notice kind="warning" text={TC.writeUnknown} announce /> : null}
      {state?.status === 'failed' || state?.status === 'conflict' ? <Notice kind="error" text={trainingErrorCopy(state.error, true)} announce /> : null}
    </Sheet>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  title: { marginTop: t.space.s8 },
  gap24: { marginTop: t.space.s24 },
  cues: { gap: t.space.s8 },
  locked: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.s12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.space.s8 },
});
