// The five Club Circuit pages (package screens/b-pages.js), composed from the shared components.
import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  Box, Chart, Compare, Composer, ConversationTurn, Counts, Disclosure, Header, Heading, Icon, Notice, NumericEntry, OutlineAction,
  PrimaryButton, Proposal, Rail, Section, Segment, SessionBoard, SetRow, StatusLabel, Summary, TextAction, Total, TrainingRow, WeekRow,
  componentStyles as cs, type BoardProps, type TrainingRowProps,
} from './components';
import type { SheetSpec } from './sheet';
import { dividerColor, t, Txt, useEnv } from './theme';
import { fixtures as FX } from './generatedfixtures';
import {
  ACTIVE_DATE, COPY, MOVE_CHOICES, PLANS, canStep, chartMax, confirmedCount, dayInfo, exerciseById, fullExercises, hasActiveRecords,
  isConfirmed, longDate, planExercises, planLocked, planOf, plural, possessiveDay, presc, recordsFor, sessionById, sessionsForWeek,
  setValues, sets, todayBoard, trainingDays, weekDays, weekRange, weekSummaryText, weekdayName, weeklySummary, workoutPrimary,
  type Action, type PageId, type Session, type State, type StatusText,
} from './model';

export type Api = { act: (action: Action, trigger?: string) => void; go: (to: PageId) => void };
export type PageOut = { scroll: ReactNode; dock?: ReactNode; sheet?: SheetSpec | null };

/** Confirmed sets grouped by exercise as compact station rows (summary, recorded sheet, sessions sheet). */
export function ExerciseSummaryList({ session }: { session: Session }) {
  const byEx = new Map<string, Session['confirmedSets']>();
  session.confirmedSets.forEach((r) => byEx.set(r.exerciseId, [...(byEx.get(r.exerciseId) ?? []), r]));
  return (
    <View>
      {Array.from(byEx, ([id, records]) => {
        const ex = exerciseById(id);
        return <TrainingRow key={id} compact num={ex.station} title={ex.name} prescription={records.map(setValues).join(', ')}
          ariaLabel={`${ex.name}, ${records.map(setValues).join('; ')}`} />;
      })}
    </View>
  );
}

// ---------------- Today ----------------
export function today(state: State, api: Api): PageOut {
  const v = state.view.variant;
  const b = todayBoard(state);
  let board: BoardProps;
  if (v === 'loading') {
    board = { kind: 'loading', id: 'b.today.session-board', num: 1,
      action: <PrimaryButton label="Review workout" disabled id="b.today.review-workout" /> };
  } else if (v === 'error') {
    board = { kind: 'error', id: 'b.today.session-board', label: 'Today', titleType: 'sectionTitle', title: 'Your plan did not load.',
      action: <PrimaryButton label="Try again" id="b.today.try-again" onPress={() => api.act({ type: 'reset' })} /> };
  } else if (b.kind === 'empty') {
    board = { id: 'b.today.session-board', label: 'Today', titleType: 'sectionTitle', title: 'No workout planned for today.',
      note: 'You can choose a session from your week.',
      action: <PrimaryButton label="View plan" id="b.today.view-plan" onPress={() => api.go('plan')} /> };
  } else {
    board = { id: 'b.today.session-board', num: 1, stationId: 'b.today.station.next', label: b.label, minutes: b.minutes,
      title: v === 'long-text' ? 'Full-body strength with a supported single-arm row' : b.title };
    if (b.kind === 'planned' || b.kind === 'short-plan') {
      board.counts = [plural(b.exercises, 'exercise', 'exercises'), plural(b.planned, 'planned set', 'planned sets')];
      if (b.kind === 'short-plan') { board.status = { tone: 'current', text: 'Shorter plan applied' }; board.statusId = 'b.today.session-plan-status'; }
      board.action = <PrimaryButton label="Review workout" id="b.today.review-workout" onPress={() => api.go('workout')} />;
    } else if (b.kind === 'in-progress') {
      board.counts = [plural(b.count, 'set recorded', 'sets recorded'), plural(b.planned, 'planned set', 'planned sets')];
      board.action = <PrimaryButton label="Continue workout" id="b.today.continue-workout" onPress={() => api.go('workout')} />;
    } else {
      board.counts = [plural(b.count, 'set recorded', 'sets recorded')];
      const finishedId = state.finished?.id ?? '';
      board.action = <PrimaryButton label="Review your session" id="b.today.review-recorded"
        onPress={() => { api.act({ type: 'open-session-detail', sessionId: finishedId }, 'b.today.review-recorded'); api.go('progress'); }} />;
    }
  }
  const rows = trainingDays(state).map((d) => (
    <WeekRow key={d.date} info={d} id={`b.today.week.${d.date}`} onPress={() => {
      const trigger = `b.today.week.${d.date}`;
      if (d.kind === 'recorded' && d.sessionId) { api.act({ type: 'open-session-detail', sessionId: d.sessionId }, trigger); api.go('progress'); }
      else { api.act({ type: 'select-day', date: d.date }, trigger); api.go('plan'); }
    }} />
  ));
  return {
    scroll: (
      <>
        <Header title="Today" id="b.today.heading" lines={[
          { text: `Ready when you are, ${FX.user.name}.`, type: 'body', id: 'b.today.greeting' },
          { text: longDate(ACTIVE_DATE), id: 'b.today.date' },
        ]} />
        <Section first><SessionBoard {...board} /></Section>
        <Section>
          <Heading title="Your training week" id="b.today.section.week" />
          <Box id="b.today.week">{rows}</Box>
          <Txt type="support" tone="secondary" captureId="b.today.week-summary">{weekSummaryText(state)}</Txt>
        </Section>
      </>
    ),
  };
}

// ---------------- Plan ----------------
function RecordedSheet(state: State, page: PageId, sessionId: string): SheetSpec | null {
  const rec = sessionById(state, sessionId);
  if (!rec) return null;
  return {
    id: `b.${page}.sheet.recorded`, title: longDate(rec.date), closeId: `b.${page}.sheet.close`,
    body: (
      <>
        <Txt type="rowTitle">{rec.name}</Txt>
        <Counts items={[plural(rec.confirmedSets.length, 'set recorded', 'sets recorded')]} />
        <ExerciseSummaryList session={rec} />
      </>
    ),
  };
}

function MoveChoice({ date, on, onPress }: { date: string; on: boolean; onPress: () => void }) {
  const env = useEnv();
  return (
    <Pressable testID={`b.plan.move-choice.${date}`} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={longDate(date)}
      onPress={onPress} style={({ pressed }) => [cs.row, cs.rowCompact, { borderBottomColor: dividerColor(env) }, on && cs.rowSelected, pressed && !on && cs.pressed]}>
      {on ? <View style={cs.selectionRule} /> : null}
      <View style={[cs.rowMain, s.choiceMain]}><Txt type="bodyStrong">{longDate(date)}</Txt></View>
      <View style={[cs.rowTrail, cs.rowTrailCompact]}>{on ? <Icon name="check" size={t.layout.icon.control} /> : null}</View>
    </Pressable>
  );
}

export function plan(state: State, api: Api): PageOut {
  const v = state.view.variant;
  const sel = dayInfo(state, state.selectedPlanDate);
  const p = planOf(state);
  let rows: ReactNode;
  if (v === 'loading') rows = <Txt type="support" tone="secondary" accessibilityState={{ busy: true }}>Loading your week</Txt>;
  else if (v === 'error') rows = <Notice tone="error" id="b.plan.notice.error" title="The week could not load" body="The sample week is still on this device."
    action={<TextAction label="Try again" id="b.plan.try-again" onPress={() => api.act({ type: 'reset' })} />} />;
  else rows = weekDays(state).map((d) => (
    <WeekRow key={d.date} info={d} id={`b.plan.day.${d.date}`} selected={d.date === state.selectedPlanDate} selectable
      onPress={() => api.act({ type: 'select-day', date: d.date })} />
  ));

  const n = state.notice.plan;
  let notice: ReactNode = null;
  if (n?.kind === 'moved' && n.to) notice = <Notice tone="recorded" id="b.plan.notice.moved" title={`Session moved to ${weekdayName(n.to)}.`}
    action={<TextAction label="Undo move" id="b.plan.undo-move" icon="undo" onPress={() => api.act({ type: 'undo-move' })} />} />;
  if (n?.kind === 'move-undone') notice = <Notice id="b.plan.notice.move-undone" title={`Session is back on ${weekdayName(state.pendingDate)}.`} />;
  if (n?.kind === 'move-blocked') notice = <Notice tone="attention" id="b.plan.notice.move-blocked" title="Finish the active workout before moving this session." />;

  let detail: ReactNode;
  let dock: ReactNode = null;
  if (sel.kind === 'rest') {
    const eligible = MOVE_CHOICES.includes(sel.date) && state.pendingDate === ACTIVE_DATE && !planLocked(state);
    detail = (
      <>
        <Heading title={sel.longDay} id="b.plan.selected-heading" />
        <Txt type="body">No session planned.</Txt>
        {eligible ? <TextAction label="Move Wednesday here" id="b.plan.move-here" onPress={() => api.act({ type: 'move-here', date: sel.date })} /> : null}
      </>
    );
  } else if (sel.kind === 'recorded') {
    const rec = sessionById(state, sel.sessionId)!;
    detail = (
      <>
        <Heading title={possessiveDay(sel.date)} id="b.plan.selected-heading" />
        <Txt type="rowTitle">{rec.name}</Txt>
        <Counts items={[plural(rec.confirmedSets.length, 'set recorded', 'sets recorded')]} />
        <OutlineAction label="Review recorded sets" id="b.plan.review-recorded"
          onPress={() => api.act({ type: 'open-recorded', sessionId: rec.id, page: 'plan' }, 'b.plan.review-recorded')} />
      </>
    );
  } else {
    const exs = sel.pending ? planExercises(state) : fullExercises();
    const meta = sel.pending ? p : PLANS.full;
    detail = (
      <>
        <Heading title={possessiveDay(sel.date)} id="b.plan.selected-heading" />
        <Txt type="rowTitle">{meta.name}</Txt>
        <Counts items={[`${meta.minutes} min`, plural(exs.length, 'exercise', 'exercises'), plural(meta.plannedSetCount, 'planned set', 'planned sets')]} />
        <View>
          {exs.map((ex, i) => (
            <TrainingRow key={ex.id} num={i + 1} title={v === 'long-text' && i === 2 ? FX.longTextFixture.exerciseName : ex.name} prescription={presc(ex)}
              id={`b.plan.exercise.${ex.id}`} ariaLabel={`Station ${i + 1} of ${exs.length}, ${ex.name}, ${presc(ex)}`} />
          ))}
        </View>
        {sel.pending
          ? <TextAction label="Move session" id="b.plan.move-session" onPress={() => api.act({ type: 'open-move' }, 'b.plan.move-session')} />
          : <Txt type="support" tone="secondary">This session is planned for {sel.longDate}.</Txt>}
      </>
    );
    if (sel.pending && state.workout.status !== 'finished') {
      dock = <PrimaryButton label={state.workout.status === 'active' ? 'Continue workout' : 'Review workout'} id="b.plan.review-workout" onPress={() => api.go('workout')} />;
    }
  }

  let sheet: SheetSpec | null = null;
  if (state.sheet?.page === 'plan' && state.sheet.kind === 'move') {
    const choice = state.sheet.choice;
    const day = choice ? weekdayName(choice) : null;
    sheet = {
      id: 'b.plan.sheet.move', title: 'Move this session', closeId: 'b.plan.sheet.close',
      body: (
        <>
          <Txt type="body">Choose a day for {p.name}.</Txt>
          <View accessibilityRole="radiogroup" accessibilityLabel="Days available">
            {MOVE_CHOICES.filter((d) => d !== state.pendingDate).map((d) => (
              <MoveChoice key={d} date={d} on={d === choice} onPress={() => api.act({ type: 'choose-move', date: d })} />
            ))}
          </View>
        </>
      ),
      actions: (
        <>
          <PrimaryButton label={day ? `Move to ${day}` : 'Move session'} id="b.plan.confirm-move" disabled={!day} reason={day ? null : 'Choose a day.'}
            onPress={() => api.act({ type: 'confirm-move' })} />
          <OutlineAction label="Cancel" id="b.plan.sheet.cancel" full onPress={() => api.act({ type: 'close-sheet' })} />
        </>
      ),
    };
  }
  if (state.sheet?.page === 'plan' && state.sheet.kind === 'recorded') sheet = RecordedSheet(state, 'plan', state.sheet.sessionId);

  return {
    scroll: (
      <>
        <Header title="Plan" id="b.plan.heading" lines={[{ text: weekRange(FX.schedule[0].date), id: 'b.plan.week-range' }]} />
        <Section first>
          <Heading title="Three days for strength" id="b.plan.section.week" desc="Space between sessions is part of this sample week." />
          <View>{rows}</View>
        </Section>
        {notice ? <Section>{notice}</Section> : null}
        <Section id="b.plan.selected-session">{detail}</Section>
      </>
    ),
    dock,
    sheet,
  };
}

// ---------------- Workout ----------------
function finishSheet(state: State, api: Api): SheetSpec | null {
  if (state.sheet?.page !== 'workout' || state.sheet.kind !== 'finish') return null;
  const n = confirmedCount(state), planned = planOf(state).plannedSetCount;
  if (n === 0) {
    return {
      id: 'b.workout.sheet.finish', title: 'No sets recorded yet', closeId: 'b.workout.sheet.close',
      body: <Txt type="body">Finishing now adds nothing to Progress.</Txt>,
      actions: (
        <>
          <PrimaryButton label="Return to workout" id="b.workout.return-to-workout" onPress={() => api.act({ type: 'close-sheet' })} />
          <OutlineAction label="End without recording" id="b.workout.end-without-recording" full onPress={() => api.act({ type: 'end-without' })} />
        </>
      ),
    };
  }
  const missing = planned - n;
  return {
    id: 'b.workout.sheet.finish', title: 'Finish this workout?', closeId: 'b.workout.sheet.close',
    body: (
      <>
        <Txt type="bodyStrong">{sets(n)} recorded.</Txt>
        <Txt type="body">{missing > 0 ? `${plural(missing, 'planned set was', 'planned sets were')} not recorded.` : 'Every planned set is recorded.'}</Txt>
      </>
    ),
    actions: (
      <>
        <PrimaryButton label={`Finish and keep ${sets(n)}`} id="b.workout.finish-keep" onPress={() => api.act({ type: 'finish-keep' })} />
        <OutlineAction label="Keep working" id="b.workout.keep-working" full onPress={() => api.act({ type: 'close-sheet' })} />
      </>
    ),
  };
}

export function workout(state: State, api: Api): PageOut {
  const w = state.workout, v = state.view.variant;
  const p = planOf(state), exs = planExercises(state);
  const prim = workoutPrimary(state);
  const dock = (
    <PrimaryButton label={prim.label} id={prim.id} onPress={() => {
      if (prim.action === 'nav-today') api.go('today');
      else api.act({ type: prim.action }, prim.id);
    }} />
  );

  if (v === 'loading') {
    return {
      scroll: (
        <>
          <Header title="Workout" id="b.workout.heading" />
          <Txt type="support" tone="secondary" accessibilityState={{ busy: true }}>Loading this workout</Txt>
        </>
      ),
      dock: <PrimaryButton label="Start workout" id="b.workout.start-workout" disabled />,
    };
  }

  if (w.status === 'ready') {
    return {
      scroll: (
        <>
          <Header title="Workout" id="b.workout.heading" lines={[{ text: p.name, type: 'rowTitle', id: 'b.workout.session-title' }]} />
          <Counts id="b.workout.session-facts" items={[`${p.minutes} min`, plural(exs.length, 'exercise', 'exercises'), plural(p.plannedSetCount, 'planned set', 'planned sets')]} />
          <Section>
            <Heading title="Your stations" id="b.workout.section.stations" desc="Nothing is recorded until you confirm a set." />
            <View>
              {exs.map((ex, i) => (
                <TrainingRow key={ex.id} num={i + 1} title={ex.name} prescription={presc(ex)} id={`b.workout.exercise.${ex.id}`}
                  ariaLabel={`Station ${i + 1} of ${exs.length}, ${ex.name}, ${presc(ex)}`} />
              ))}
            </View>
            <TextAction label="Back to Today" id="b.workout.back-today" onPress={() => api.go('today')} />
          </Section>
        </>
      ),
      dock,
      sheet: finishSheet(state, api),
    };
  }

  if (w.status === 'finished' && state.finished) {
    const f = state.finished, n = f.confirmedSets.length, missing = f.plannedSetCount - n;
    return {
      scroll: (
        <>
          <Header title="Workout" id="b.workout.heading" lines={[{ text: f.name, type: 'rowTitle', id: 'b.workout.session-title' }]} />
          <Summary title={f.status === 'partial' ? 'Partial workout recorded' : 'Workout recorded'} count={n} countLabel={n === 1 ? 'set recorded' : 'sets recorded'}
            note={missing > 0 ? `${plural(missing, 'planned set was', 'planned sets were')} not recorded.` : 'Every planned set is recorded.'} filing={w.filing} />
          <Section>
            <Heading title="What you recorded" id="b.workout.section.recorded" />
            <ExerciseSummaryList session={f} />
          </Section>
        </>
      ),
      dock,
    };
  }

  // active
  const ex = exs[w.exIndex];
  const name = v === 'long-text' ? FX.longTextFixture.exerciseName : ex.name;
  const cue = v === 'long-text' ? FX.longTextFixture.cue : ex.cue;
  const done = recordsFor(state, ex.id);
  const lastRec = done[done.length - 1];
  const currentDone = isConfirmed(state, ex.id, w.setNumber);
  const exIndexLabel = `Exercise ${w.exIndex + 1} of ${exs.length}`;
  const confirm = () => api.act({ type: 'confirm-set' }, 'b.workout.confirm-set');

  let entry: ReactNode;
  if (currentDone) {
    const r = done.find((x) => x.setNumber === w.setNumber)!;
    entry = <Notice tone="recorded" id="b.workout.notice.set-recorded" title={`Set ${r.setNumber} recorded.`} body={setValues(r)}
      action={<TextAction label="Undo set" id="b.workout.undo-set" icon="undo" onPress={() => api.act({ type: 'undo-set' })} />} />;
  } else {
    entry = (
      <Box id="b.workout.entry" style={s.entry}>
        <NumericEntry label="Repetitions" hint={`Target ${ex.targetRepsMin}–${ex.targetRepsMax} reps`} value={w.draft.reps} unit="reps" id="b.workout.repetitions"
          decLabel="Decrease repetitions" incLabel="Increase repetitions" canDec={canStep(state, 'reps', -t.dataVisual.repStep)} canInc={canStep(state, 'reps', t.dataVisual.repStep)}
          error={w.errors.reps} keyboard="number-pad" step={t.dataVisual.repStep} onSubmit={confirm}
          onChange={(value) => api.act({ type: 'edit', field: 'reps', value })} onStep={(delta) => api.act({ type: 'step', field: 'reps', delta })} />
        <NumericEntry label="Weight" hint={ex.loadLabel} value={w.draft.kg} unit="kg" id="b.workout.weight"
          decLabel="Decrease weight" incLabel="Increase weight" canDec={canStep(state, 'kg', -t.dataVisual.loadStepKg)} canInc={canStep(state, 'kg', t.dataVisual.loadStepKg)}
          error={w.errors.kg} keyboard="decimal-pad" step={t.dataVisual.loadStepKg} onSubmit={confirm}
          onChange={(value) => api.act({ type: 'edit', field: 'kg', value })} onStep={(delta) => api.act({ type: 'step', field: 'kg', delta })} />
        {v === 'error' ? <Notice tone="error" id="b.workout.notice.record-error" title="The set was not recorded. Try again." body="Your values are still in the fields." /> : null}
      </Box>
    );
  }
  const wn = state.notice.workout;
  const setRows = Array.from({ length: ex.sets }, (_, i) => i + 1).map((k) => {
    const rec = done.find((x) => x.setNumber === k);
    const isCur = k === w.setNumber && !rec;
    const status: StatusText = rec ? { tone: 'recorded', icon: 'check', text: 'Recorded' } : isCur ? { tone: 'current', text: 'Current' } : { tone: 'plain', text: 'Not recorded' };
    return (
      <SetRow key={k} ordinal={k} id={`b.workout.set.${ex.id}.${k}`} current={isCur} status={status}
        title={rec ? setValues(rec) : `Target ${ex.targetRepsMin}–${ex.targetRepsMax} reps`} valuesType={rec ? 'rowTitle' : 'body'} valuesTone={rec ? 'primary' : 'secondary'}
        ariaLabel={`Set ${k}, ${rec ? setValues(rec) + ', recorded' : isCur ? 'current, not recorded' : 'not recorded'}`} />
    );
  });
  const stations = exs.map((e, i) => {
    const c = recordsFor(state, e.id).length;
    const status: StatusText | null = i === w.exIndex ? { tone: 'current', text: 'Current' }
      : c >= e.sets ? { tone: 'recorded', icon: 'check', text: `${sets(c)} recorded` } : c > 0 ? { tone: 'plain', text: `${c} of ${e.sets} sets recorded` } : null;
    return <TrainingRow key={e.id} num={i + 1} current={i === w.exIndex} title={e.name} prescription={presc(e)} status={status} id={`b.workout.exercise.${e.id}`}
      ariaLabel={`Station ${i + 1} of ${exs.length}, ${e.name}, ${presc(e)}${status ? ', ' + status.text : ''}`} />;
  });

  return {
    scroll: (
      <>
        <Header title="Workout" id="b.workout.heading" lines={[{ text: p.name, id: 'b.workout.session-title' }]}
          trailing={<TextAction label="Finish" id="b.workout.finish" align="center" onPress={() => api.act({ type: 'open-finish' }, 'b.workout.finish')} />} />
        <Box id={`b.workout.station.${ex.id}`} accessibilityLabel={`Current station, ${exIndexLabel}`} style={[cs.row, s.station]}>
          <Rail num={w.exIndex + 1} current />
          <View style={cs.rowMain}>
            <Txt type="display" captureId="b.workout.exercise-title" accessibilityRole="header">{name}</Txt>
            <Txt type="support" tone="secondary">{exIndexLabel}</Txt>
            <Counts id="b.workout.set-position" middle items={[
              <Txt key="pos" type="bodyStrong">Set {w.setNumber} of {ex.sets}</Txt>,
              done.length ? <StatusLabel key="st" tone="recorded" icon="check" text={plural(done.length, 'set recorded', 'sets recorded')} />
                : <StatusLabel key="st" tone="plain" text="No sets recorded yet" />,
            ]} />
          </View>
        </Box>
        <View style={s.target}>
          <Txt type="body" captureId="b.workout.target">Target: {ex.targetRepsMin}–{ex.targetRepsMax} repetitions.</Txt>
          {lastRec && !currentDone ? <Txt type="support" tone="secondary" captureId="b.workout.last-set">Last set: {setValues(lastRec)}.</Txt> : null}
        </View>
        <View style={s.block}>{entry}</View>
        {wn?.kind === 'set-undone' ? (
          <View style={s.undone}><Notice id="b.workout.notice.set-undone" title={`Set ${wn.setNumber} is not recorded.`} body="Its values are back in the fields." /></View>
        ) : null}
        <View style={s.block}>
          <Disclosure summary="One cue for this set" content={cue} open={w.cueOpen} id="b.workout.cue-toggle" contentId="b.workout.cue-content"
            onToggle={() => api.act({ type: 'toggle-cue' })} />
        </View>
        <Section><Heading title={`${ex.name} sets`} id="b.workout.section.sets" /><View>{setRows}</View></Section>
        <Section><Heading title="Your stations" id="b.workout.section.stations" /><View>{stations}</View></Section>
      </>
    ),
    dock,
    sheet: finishSheet(state, api),
  };
}


function coachNotice(state: State): ReactNode {
  const n = state.notice.coach;
  if (hasActiveRecords(state) || n?.kind === 'guard') return <Notice tone="attention" id="b.coach.notice.guard" title="This workout has recorded sets. Finish it before changing today's plan." />;
  if (state.finished) return <Notice id="b.coach.notice.unavailable" title="This option is unavailable" body="Today's workout is already recorded." />;
  if (n?.kind === 'undone') return <Notice id="b.coach.notice.undone" title="Original 35-minute plan restored." />;
  return null;
}

/** CMP-13 as used on Coach: proposed, applied (Undo change), undone and guarded states from one state model. */
export function CoachProposal({ state, api, ids = true }: { state: State; api: Api; ids?: boolean }) {
  const short = PLANS.short, full = PLANS.full;
  const applied = state.planKey === 'short';
  const locked = hasActiveRecords(state);
  const id = (value: string) => (ids ? value : undefined);
  const rows: TrainingRowProps[] = short.exerciseIds.map((exerciseId, i) => {
    const ex = exerciseById(exerciseId);
    return { num: i + 1, title: ex.name, trailing: sets(ex.sets), id: id(`b.coach.proposal.${exerciseId}`), ariaLabel: `Kept: ${ex.name}, ${sets(ex.sets)}` };
  });
  let action: ReactNode = null;
  if (applied) action = <OutlineAction label="Undo change" id={id('b.coach.undo-plan')} icon="undo" full onPress={() => api.act({ type: 'undo-plan' })} />;
  else if (!locked && !state.finished) action = <PrimaryButton label="Review shorter plan" id={id('b.coach.review-plan')} onPress={() => api.act({ type: 'open-plan-review' }, 'b.coach.review-plan')} />;
  return (
    <Proposal id={id('b.coach.proposal')} title={applied ? '20-minute plan applied' : 'A 20-minute option'} rows={rows}
      facts={applied
        ? [{ text: `${short.minutes} min`, type: 'bodyStrong' }, { text: plural(short.plannedSetCount, 'planned set', 'planned sets') }]
        : [{ text: `${full.minutes} min → ${short.minutes} min`, type: 'bodyStrong', aria: `Duration changes from ${full.minutes} minutes to ${short.minutes} minutes` },
          { text: plural(short.plannedSetCount, 'planned set', 'planned sets') }]}
      note="Hinge and calf raise are not in this session." notice={coachNotice(state)} action={action} />
  );
}

/** The shorter-plan review sheet content (CMP-13 review + CMP-18). */
export function planReviewSheet(api: Api, ids = true): SheetSpec {
  const short = PLANS.short, full = PLANS.full;
  return {
    id: 'b.coach.sheet.plan-review', title: 'Use the shorter session?', closeId: 'b.coach.sheet.close',
    body: (
      <>
        <Compare id={ids ? 'b.coach.compare' : undefined} before="Current" after="Proposed" rows={[
          { label: 'Duration', from: `${full.minutes} min`, to: `${short.minutes} min` },
          { label: 'Exercises', from: String(full.exerciseIds.length), to: String(short.exerciseIds.length) },
          { label: 'Planned sets', from: String(full.plannedSetCount), to: String(short.plannedSetCount) },
        ]} />
        <View style={s.sheetNote}>
          <Txt type="body">Hinge and calf raise are not in this session.</Txt>
          <Txt type="support" tone="secondary">This changes today&apos;s session only.</Txt>
        </View>
      </>
    ),
    actions: (
      <>
        <PrimaryButton label="Use this plan" id={ids ? 'b.coach.apply-plan' : undefined} onPress={() => api.act({ type: 'apply-plan' })} />
        <OutlineAction label="Keep current plan" id={ids ? 'b.coach.keep-plan' : undefined} full onPress={() => api.act({ type: 'keep-plan' })} />
      </>
    ),
  };
}

// ---------------- Coach ----------------
export function coach(state: State, api: Api): PageOut {
  const v = state.view.variant;
  let turns = state.coach.turns;
  if (v === 'empty') turns = [];
  if (v === 'long-text') turns = [{ id: 't1', speaker: 'you', text: FX.longTextFixture.message }, { id: 't2', speaker: 'coach', text: COPY.coachProposal, proposal: true }];
  let lastProposal = -1;
  turns.forEach((turn, i) => { if (turn.proposal) lastProposal = i; });

  const notice = coachNotice(state);
  const proposal = () => <CoachProposal state={state} api={api} />;

  let body: ReactNode;
  if (v === 'loading') {
    body = (
      <View style={s.turns}>
        <ConversationTurn speaker="you" text={turns[0].text} id="b.coach.turn.t1" />
        <View style={s.pendingTurn} accessibilityState={{ busy: true }}>
          <ConversationTurn speaker="coach" text="Preparing the sample reply…" pending />
          <View style={[cs.skeleton, cs.skeletonLine, s.pendingLine]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        </View>
      </View>
    );
  } else if (v === 'error') {
    body = (
      <View style={s.turns}>
        <ConversationTurn speaker="you" text={turns[0].text} id="b.coach.turn.t1" />
        <Notice tone="error" id="b.coach.notice.error" title="The sample reply did not load."
          action={<TextAction label="Try again" id="b.coach.try-again" onPress={() => api.act({ type: 'reset' })} />} />
      </View>
    );
  } else if (!turns.length) {
    body = <Txt type="body">What would help with today&apos;s workout?</Txt>;
  } else {
    body = (
      <>
        <View style={s.turns}>
          {turns.map((turn, i) => (i === lastProposal ? (
            <View key={turn.id} style={s.turnGroup}>
              <ConversationTurn speaker={turn.speaker} text={turn.text} id={`b.coach.turn.${turn.id}`} />
              {proposal()}
            </View>
          ) : <ConversationTurn key={turn.id} speaker={turn.speaker} text={turn.text} id={`b.coach.turn.${turn.id}`} />))}
        </View>
        {lastProposal < 0 && notice ? <Section>{notice}</Section> : null}
      </>
    );
  }
  const prompts = (
    <View style={s.prompts} accessibilityRole="none" accessibilityLabel="Suggested questions">
      {!turns.length ? <OutlineAction label="I have 20 minutes today" id="b.coach.prompt.shorter" onPress={() => api.act({ type: 'prompt', kind: 'shorter' })} /> : null}
      <OutlineAction label="Why these exercises?" id="b.coach.prompt.explain" onPress={() => api.act({ type: 'prompt', kind: 'explain' })} />
      <OutlineAction label="Keep the full session" id="b.coach.prompt.full" onPress={() => api.act({ type: 'prompt', kind: 'full' })} />
    </View>
  );

  const sheet = state.sheet?.page === 'coach' && state.sheet.kind === 'plan-review' ? planReviewSheet(api) : null;

  return {
    scroll: (
      <>
        <Header title="Coach" id="b.coach.heading" lines={[{ text: "Today's full-body session.", id: 'b.coach.context' }]}
          trailing={<StatusLabel tone="plain" text="Sample conversation" id="b.coach.sample-label" />} />
        <View style={s.coachBody}>{body}</View>
        {v === 'loading' || v === 'error' ? null : prompts}
      </>
    ),
    dock: (
      <Composer value={state.coach.composer} onChange={(value) => api.act({ type: 'composer', value })}
        onSend={() => api.act({ type: 'send' }, 'b.coach.send-message')} />
    ),
    sheet,
  };
}

// ---------------- Progress ----------------
export function progress(state: State, api: Api): PageOut {
  const v = state.view.variant;
  const weeks = weeklySummary(state);
  const metric = state.progress.metric;
  const week = weeks.find((w) => w.weekStart === state.progress.week) ?? weeks[weeks.length - 1];
  const setsN = v === 'empty' ? 0 : week.sets, sessN = v === 'empty' ? 0 : week.sessions;
  const isSets = metric === 'sets';
  let total: ReactNode;
  if (v === 'loading') total = <Txt type="support" tone="secondary" accessibilityState={{ busy: true }}>Loading your record</Txt>;
  else if (v === 'error') total = <Notice tone="error" id="b.progress.notice.error" title="The record did not load." body="Sets you confirmed are still on this device."
    action={<TextAction label="Try again" id="b.progress.try-again" onPress={() => api.act({ type: 'reset' })} />} />;
  else if (v === 'empty') total = (
    <>
      <Total value={0} label="sets recorded" id="b.progress.selected-total" />
      <Txt type="body">Nothing recorded this week yet.</Txt>
      <Txt type="support" tone="secondary">Your confirmed sets will appear here.</Txt>
      <TextAction label="View your plan" id="b.progress.view-plan" onPress={() => api.go('plan')} />
    </>
  );
  else total = (
    <>
      <Total value={isSets ? setsN : sessN} id="b.progress.selected-total" unitId="b.progress.selected-unit"
        label={isSets ? (setsN === 1 ? 'set recorded' : 'sets recorded') : (sessN === 1 ? 'session recorded' : 'sessions recorded')} />
      <Txt type="support" tone="secondary">{isSets ? `${plural(sessN, 'session', 'sessions')} recorded this week.` : `${plural(setsN, 'set', 'sets')} recorded this week.`}</Txt>
    </>
  );
  const chartWeeks = v === 'empty' ? weeks.map((w) => (w.weekStart === state.progress.week ? { ...w, sets: 0, sessions: 0 } : w)) : weeks;

  let sheet: SheetSpec | null = null;
  if (state.sheet?.page === 'progress' && state.sheet.kind === 'sessions') {
    const list = sessionsForWeek(state, state.progress.week);
    sheet = {
      id: 'b.progress.sheet.sessions', title: `Sessions, ${weekRange(state.progress.week)}`, closeId: 'b.progress.sheet.close',
      body: list.length ? (
        <View>
          {list.map((session) => (
            <SessionItem key={session.id} session={session} open={state.progress.expanded === session.id}
              onPress={() => api.act({ type: 'toggle-session', id: session.id })} />
          ))}
        </View>
      ) : <Txt type="body">Nothing recorded this week yet.</Txt>,
    };
  }
  if (state.sheet?.kind === 'recorded' && state.sheet.page === 'progress') sheet = RecordedSheet(state, 'progress', state.sheet.sessionId);

  return {
    scroll: (
      <>
        <Header title="Progress" id="b.progress.heading" lines={[{ text: "Work you've recorded.", id: 'b.progress.subtitle' }]} />
        <Section first>
          <Txt type="sectionTitle" accessibilityRole="header" captureId="b.progress.week-range">{weekRange(state.progress.week)}</Txt>
          {total}
        </Section>
        <Section gap="md">
          <Heading title="Last four weeks" id="b.progress.section.weeks" />
          <Segment label="Measure" id="b.progress.metric" selected={metric} onSelect={(value) => api.act({ type: 'set-metric', metric: value })}
            items={[{ value: 'sets', label: 'Sets', id: 'b.progress.metric.sets' }, { value: 'sessions', label: 'Sessions', id: 'b.progress.metric.sessions' }]} />
          <Chart weeks={chartWeeks} metric={metric} selected={state.progress.week} max={chartMax(metric)} unit={isSets ? 'sets' : 'sessions'}
            onSelect={(value) => api.act({ type: 'select-week', week: value })} />
        </Section>
        <Section>
          <PrimaryButton label="Review sessions" id="b.progress.review-sessions" onPress={() => api.act({ type: 'open-sessions' }, 'b.progress.review-sessions')} />
          <Txt type="support" tone="secondary" captureId="b.progress.footnote">Only confirmed sets appear here.</Txt>
        </Section>
      </>
    ),
    sheet,
  };
}

function SessionItem({ session, open, onPress }: { session: Session; open: boolean; onPress: () => void }) {
  const env = useEnv();
  const n = session.confirmedSets.length;
  const status: StatusText = session.status === 'partial'
    ? { tone: 'recorded', icon: 'check', text: `Partial workout, ${sets(n)} recorded` }
    : { tone: 'recorded', icon: 'check', text: `${sets(n)} recorded` };
  return (
    <View>
      <Pressable testID={`b.progress.recorded-session.${session.id}`} accessibilityRole="button" accessibilityState={{ expanded: open }}
        accessibilityLabel={`${longDate(session.date)}, ${session.name}, ${status.text}`} onPress={onPress}
        style={({ pressed }) => [cs.row, cs.rowWeek, { borderBottomColor: dividerColor(env) }, env.stacked && cs.wrap, pressed && cs.pressed]}>
        <View style={cs.rowMain}>
          <Txt type="rowTitle">{longDate(session.date)}</Txt>
          <Txt type="support" tone="secondary">{session.name}</Txt>
          <View style={cs.alignStart}><StatusLabel {...status} /></View>
        </View>
        <View style={[cs.rowTrail, env.stacked && cs.rowTrailStacked]}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={t.layout.icon.inline} color={t.color.text.secondary} />
        </View>
      </Pressable>
      {open ? <ExerciseSummaryList session={session} /> : null}
    </View>
  );
}

export const PAGES = { today, plan, workout, coach, progress };

const s = StyleSheet.create({
  choiceMain: { paddingLeft: t.space.md },
  entry: { gap: t.layout.entry.rowGap },
  station: { borderBottomWidth: t.space.none, paddingTop: t.space.none },
  target: { marginTop: t.space.base, gap: t.space.xs },
  block: { marginTop: t.space.base },
  undone: { marginTop: t.space.md },
  turns: { gap: t.layout.conversation.turnGap },
  turnGroup: { gap: t.space.md },
  pendingTurn: { gap: t.layout.conversation.speakerGap },
  pendingLine: { backgroundColor: t.color.surface.field },
  prompts: { flexDirection: 'row', flexWrap: 'wrap', gap: t.layout.composer.promptGap, marginTop: t.layout.screen.sectionGap },
  coachBody: { marginTop: t.space.md },
  sheetNote: { gap: t.space.xs },
});
