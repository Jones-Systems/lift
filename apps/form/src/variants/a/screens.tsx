// Open Mat five tab roots (Today, Plan, Workout, Coach, Progress) and their four sheets,
// composed only from the shared components. Layout follows app/app.js + app/open-mat.css.
import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, OpenMatArt } from './art';
import { useCapture } from './capture';
import {
  ChatMessage, Composer, Cue, DayPicker, EmptyBlock, FieldError, HistoryRow, kgLabel, loadText, MovementRow, NumericField,
  ProposalBlock, RestPanel, SessionSummary, setsOf, SetChips, SummaryRow, WeeklyChart, COMPOSER_LIMIT, type ChipState,
} from './components';
import { Compare, SheetActions, SheetRow, SheetSection, type SheetSpec } from './frame';
import { fixtures } from './generatedfixtures';
import {
  clock, currentMove, movementDone, planMoves, planTitle, planTotals, remainingRest, restName, weekCounts, MOVES,
  type Action, type State,
} from './model';
import { Gutter, MetaLine, mt, NavRow, Notice, PageTitle, PlainAction, PrimaryAction, PromptChoice, Txt } from './primitives';
import { L, t, tabular, useTextScale } from './theme';

export type Api = {
  act: (action: Action, triggerId?: string) => void;
  /** Close the presented sheet with its exit motion, then run `after`. */
  closeSheet: (after?: () => void) => void;
  now: number;
  reduceMotion: boolean;
  composerFocused: boolean;
  setComposerFocused: (focused: boolean) => void;
};

type ScreenProps = { state: State; api: Api };

/** Page root: testID a-screen-{id}; nav sits layout.frame.navGap below the safe area. */
function Page({ id, children }: { id: string; children: ReactNode }) {
  const ref = useCapture(id);
  return (
    <View ref={ref} testID={id} style={s.page}>
      {children}
      <View style={s.scrollPad} />
    </View>
  );
}

function noticeFor(state: State, tab: State['tab']) {
  return state.notice && state.notice.tab === tab ? state.notice : null;
}

/* ---------------- Today ---------------- */

export function TodayScreen({ state, api }: ScreenProps) {
  const { large } = useTextScale();
  const totals = planTotals(state.plan);
  const active = !!state.session;
  const n = noticeFor(state, 'today');
  const artRef = useCapture('a-open-mat-art');
  return (
    <Page id="a-screen-today">
      <NavRow title="form" titleRole="sectionTitle" trailing={<Txt role="meta" tone="secondary">Wed, Oct 7</Txt>} />
      <Gutter>
        <PageTitle role="display" text="Hello, Alex." captureId="a-today-heading" />
        <Txt role="body" tone="secondary" style={s.subtitle}>Let’s make room to move.</Txt>
      </Gutter>
      <View style={[mt('s20'), s.center]}>
        <OpenMatArt variant="today" testID="a-open-mat-art" captureRef={artRef} />
      </View>
      <Gutter style={mt('s20')}>
        <SessionSummary captureId="a-today-session" title={planTitle(state.plan)}
          meta={[`${totals.minutes} minutes`, `${totals.moves} movements`, active ? `${state.confirmed.length} of ${totals.sets} sets recorded` : `${totals.sets} sets`]} />
        {n ? (
          <Notice kind={n.kind} text={n.text} announce style={mt('s16')}
            action={n.undo ? { label: 'Undo change', captureId: 'a-today-undo', onPress: () => api.act({ type: 'undo-short' }) } : null} />
        ) : null}
        <PrimaryAction style={mt('s20')} captureId="a-today-primary" label={active ? 'Resume workout' : `Start ${totals.minutes}-minute workout`}
          onPress={() => api.act({ type: 'start-workout' })} />
        {state.plan === 'full' && !active ? (
          <PlainAction style={mt('s12')} label="Only have 20 minutes?" captureId="a-short-option"
            onPress={() => api.act({ type: 'open-adjust', from: 'today' }, 'a-short-option')} />
        ) : null}
        <View style={mt('s24')}>
          {large ? (
            <>
              <Txt role="sectionTitle" accessibilityRole="header">This week</Txt>
              <PlainAction style={mt('s4')} label="1 of 3 workouts recorded" captureId="a-today-week-link" onPress={() => api.act({ type: 'go', to: 'plan' })} />
            </>
          ) : (
            <>
              <WeekHead />
              <View style={mt('s12')}>
                <DayPicker selected={state.selectedDay} onSelect={(id) => api.act({ type: 'today-day', id })} />
              </View>
            </>
          )}
        </View>
      </Gutter>
    </Page>
  );
}

function WeekHead() {
  const ref = useCapture('a-today-week-head');
  return (
    <View ref={ref} testID="a-today-week-head" style={s.weekHead}>
      <Txt role="sectionTitle" accessibilityRole="header">This week</Txt>
      <Txt role="meta" tone="secondary">1 of 3 workouts recorded</Txt>
    </View>
  );
}

/* ---------------- Plan ---------------- */

export function PlanScreen({ state, api }: ScreenProps) {
  const day = fixtures.days.find((d) => d.id === state.selectedDay) ?? fixtures.days[0];
  const n = noticeFor(state, 'plan');
  const panelRef = useCapture('a-plan-session');
  let panel: ReactNode;
  let after: ReactNode = null;
  if (day.kind === 'rest') {
    panel = (
      <>
        <OpenMatArt variant="small" />
        <Txt role="meta" tone="secondary" style={mt('s12')}>{day.long}</Txt>
        <Txt role="sectionTitle" accessibilityRole="header" style={mt('s4')}>{`${day.long.split(',')[0]} is a rest day.`}</Txt>
        <Txt role="body" style={mt('s8')}>Your next strength session is Friday.</Txt>
      </>
    );
    // v2: the rest panel holds only the rest day; Friday's session follows on the canvas (s24) with its action (s20).
    const fri = fixtures.days.find((d) => d.kind === 'planned') ?? day;
    const ft = planTotals('full');
    after = (
      <View style={mt('s24')}>
        <SessionSummary captureId="a-plan-next" eyebrow={`Next: ${fri.long}`} title="Full-body strength"
          meta={[`${ft.minutes} minutes`, `${ft.moves} movements`, `${ft.sets} sets`]} />
        <PrimaryAction style={mt('s20')} captureId="a-plan-primary" label="See Friday’s workout"
          onPress={() => api.act({ type: 'select-day', id: fri.id })} />
      </View>
    );
  } else if (day.kind === 'done') {
    // A-RN-05 (B): open this day's own history record ("Mon, Oct 5") in the existing history-detail sheet.
    // No matching record leaves the action without a handler rather than showing another workout.
    const record = state.history.find((r) => r.day === `${day.label}, ${day.long.split(', ')[1]}`);
    panel = (
      <>
        <Txt role="meta" tone="secondary">{day.long}</Txt>
        <Txt role="sectionTitle" accessibilityRole="header" style={mt('s4')}>Full-body strength</Txt>
        <View style={[s.recorded, mt('s8')]}>
          <IconSlot name="circle-check" color={t.color.success} />
          <Txt role="meta" tone="success">Recorded Monday, 31 minutes</Txt>
        </View>
        <View style={mt('s12')}>
          {MOVES.map((m, i) => (
            <MovementRow key={m.id} move={m} variant="full" ord={i + 1} last={i === MOVES.length - 1}
              detail={`${m.full} × ${m.defReps} reps at ${kgLabel(m, m.kg)}`} />
          ))}
        </View>
        <PlainAction style={mt('s12')} label="See recorded workout" captureId="a-plan-history"
          onPress={record ? () => api.act({ type: 'open-history', id: record.id }, 'a-plan-history') : undefined} />
      </>
    );
  } else {
    const variant = day.kind === 'today' ? state.plan : 'full';
    const totals = planTotals(variant);
    const moves = planMoves(variant);
    panel = (
      <>
        <Txt role="meta" tone="secondary">{(day.kind === 'today' ? 'Today, ' : '') + day.long}</Txt>
        <Txt role="sectionTitle" accessibilityRole="header" style={mt('s4')}>{planTitle(variant)}</Txt>
        <MetaLine style={mt('s8')} items={[`${totals.minutes} minutes`, `${totals.moves} movements`, `${totals.sets} sets`]} />
        <View style={mt('s12')}>
          {moves.map((m, i) => <MovementRow key={m.id} move={m} variant={variant} ord={i + 1} last={i === moves.length - 1} />)}
        </View>
        <PrimaryAction style={s.planAction} captureId="a-plan-change" label="Change this workout"
          onPress={() => api.act({ type: 'open-adjust', from: 'plan' }, 'a-plan-change')} />
      </>
    );
  }
  return (
    <Page id="a-screen-plan">
      <NavRow title="Plan" trailing={<Txt role="meta" tone="secondary">Oct 5–11</Txt>} />
      <Gutter>
        <PageTitle text={'Your week,\nyour pace.'} captureId="a-plan-heading" />
        <View style={mt('s20')}>
          <DayPicker selected={state.selectedDay} onSelect={(id) => api.act({ type: 'select-day', id })} />
        </View>
        {n && day.kind === 'today' ? (
          <Notice kind={n.kind} text={n.text} announce style={mt('s20')}
            action={n.undo ? { label: 'Undo change', captureId: 'a-plan-undo', onPress: () => api.act({ type: 'undo-short' }) } : null} />
        ) : null}
        <View ref={panelRef} testID="a-plan-session" style={[s.planPanel, mt('s20')]}>{panel}</View>
        {after}
      </Gutter>
    </Page>
  );
}

/* ---------------- Workout ---------------- */

export function WorkoutScreen({ state, api }: ScreenProps) {
  const { large } = useTextScale();
  const session = state.session ?? { status: 'active' as const, move: 0, set: 1, restEndsAt: null, frozenRest: null };
  const view = { ...state, session };
  const m = currentMove(view);
  const moves = planMoves(state.plan);
  const total = setsOf(m, state.plan);
  const last = state.confirmed.filter((c) => c.move === session.move).slice(-1)[0];
  const artRef = useCapture(large ? undefined : 'a-open-mat-art');
  const chips: ChipState[] = Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    if (state.confirmed.some((c) => c.move === session.move && c.set === n)) return 'done';
    return n === session.set ? 'current' : 'not-started';
  });
  const drawSet = state.drawCheck && state.drawCheck.startsWith(`${session.move}:`) ? Number(state.drawCheck.split(':')[1]) : null;
  const done = movementDone(view);
  const nextName = done && moves[session.move + 1] ? moves[session.move + 1].name : `Set ${session.set}`;
  const fieldState = (kind: 'reps' | 'kg') => (state.draft.error === kind ? 'error' : state.draft.focus === kind ? 'focused' : 'default');
  const recordedText = last ? `Set ${last.set} recorded: ${last.reps} reps at ${loadText(last.kg)}.` : '';
  let body: ReactNode = null;
  if (session.status === 'active') {
    body = (
      <>
        <View style={[s.fields, large && s.fieldsLarge, mt('s16')]}>
          <NumericField kind="reps" label="Reps" value={state.draft.reps} state={fieldState('reps')} moveName={m.name}
            onStep={(direction) => api.act({ type: 'step', field: 'reps', direction })} />
          <NumericField kind="kg" label="Weight, kg" value={state.draft.kg} state={fieldState('kg')} moveName={m.name}
            onStep={(direction) => api.act({ type: 'step', field: 'kg', direction })} />
        </View>
        {state.draft.error ? (
          <FieldError captureId="a-workout-error" text={state.draft.error === 'reps' ? 'Enter 1–99 reps.' : 'Use 0–200 kg in 0.5 kg steps.'} />
        ) : null}
        <PrimaryAction style={mt('s20')} captureId="a-confirm-set" label="Confirm set" disabled={!!state.draft.error}
          onPress={() => api.act({ type: 'confirm-set', now: Date.now() })} />
      </>
    );
  } else if (session.status === 'resting' || session.status === 'ready-next') {
    const seconds = remainingRest(session, api.now);
    body = (
      <>
        {last ? <Notice kind="success" text={recordedText} announce style={mt('s16')} /> : null}
        {session.status === 'resting' ? (
          <View style={mt('s12')}>
            <RestPanel captureId="a-rest-panel" clock={clock(seconds)} accessibleName={restName(seconds)} next={nextName}
              onSkip={() => api.act({ type: 'end-rest' })} />
          </View>
        ) : (
          <PrimaryAction style={mt('s20')} captureId="a-next-set" label={done ? `Start ${nextName}` : `Start set ${session.set}`}
            onPress={() => api.act({ type: 'next-set' })} />
        )}
      </>
    );
  } else if (session.status === 'complete') {
    body = (
      <>
        {last ? <Notice kind="success" text={recordedText} announce style={mt('s16')} /> : null}
        <PrimaryAction style={mt('s20')} captureId="a-workout-primary" label="Finish workout"
          onPress={() => api.act({ type: 'open-sheet', sheet: 'finish' }, 'a-workout-primary')} />
      </>
    );
  }
  return (
    <Page id="a-screen-workout">
      <NavRow title="Workout" trailing={
        <PlainAction label="Finish" captureId="a-workout-finish" placement="trailing" chevron={null}
          onPress={() => api.act({ type: 'open-sheet', sheet: 'finish' }, 'a-workout-finish')} />
      } />
      <Gutter>
        <Txt role="bodyStrong" style={mt('s16')}>{planTitle(state.plan)}</Txt>
        <Txt role="meta" tone="secondary" style={mt('s8')}>{`Movement ${session.move + 1} of ${moves.length}`}</Txt>
        <Txt role="exerciseTitle" accessibilityRole="header" captureId="a-workout-heading" style={mt('s12')}>{m.name}</Txt>
      </Gutter>
      {large ? null : (
        <View style={[mt('s12'), s.center]}>
          <OpenMatArt variant="workout" testID="a-open-mat-art" captureRef={artRef} />
        </View>
      )}
      <Gutter>
        <View style={mt('s16')}>
          <Cue cue={m.cue} last={`Last time: ${m.defReps} reps at ${kgLabel(m, m.kg)}`} />
        </View>
        <View style={mt('s16')}>
          <SetChips label={`Set ${session.set} of ${total}`} chips={chips} drawSet={drawSet} reduceMotion={api.reduceMotion} />
        </View>
        {body}
        <Txt role="meta" tone="secondary" style={mt('s12')}>Only confirmed sets enter your history.</Txt>
        <PlainAction style={s.moreGap} label={`See all ${moves.length} movements`} captureId="a-workout-list"
          onPress={() => api.act({ type: 'open-sheet', sheet: 'list' }, 'a-workout-list')} />
      </Gutter>
    </Page>
  );
}

/* ---------------- Coach ---------------- */

export function CoachScreen({ state, api }: ScreenProps) {
  const { large } = useTextScale();
  const n = noticeFor(state, 'coach');
  const full = state.plan === 'full';
  const totals = planTotals('full');
  const short = planTotals('short');
  const contextRef = useCapture(full ? 'a-coach-context' : undefined);
  const replyIndex = state.chat.map((c) => c.who).lastIndexOf('coach');
  return (
    <Page id="a-screen-coach">
      <NavRow title="Coach" />
      <Gutter>
        <PageTitle text={'Make it fit\nyour day.'} captureId="a-coach-heading" />
        {full ? (
          <View ref={contextRef} testID="a-coach-context" style={[s.context, mt('s20')]}>
            <Txt role="bodyStrong">{`Today: Full-body strength, ${totals.minutes} minutes`}</Txt>
          </View>
        ) : null}
        <View style={[s.thread, full ? mt('s16') : mt('s20')]}>
          <ChatMessage from="coach" text={fixtures.seedLine} />
          {state.chat.map((c, i) => (
            <ChatMessage key={i} from={c.who} text={c.text} captureId={c.who === 'coach' && i === replyIndex ? 'a-coach-reply' : undefined} />
          ))}
        </View>
        <View style={mt('s16')}>
          <ProposalBlock captureId="a-coach-proposal" moves={planMoves('short')} sets={short.sets} />
        </View>
        {n ? (
          <Notice kind={n.kind} text={n.text} announce style={mt('s16')}
            action={n.undo ? { label: 'Undo change', captureId: 'a-coach-undo', onPress: () => api.act({ type: 'undo-short' }) } : null} />
        ) : full ? (
          <PrimaryAction style={mt('s16')} captureId="a-coach-review" label="Review 20-minute option"
            onPress={() => api.act({ type: 'open-adjust', from: 'coach' }, 'a-coach-review')} />
        ) : null}
        <View style={[s.prompts, mt('s16')]}>
          {full ? (
            <PromptChoice label="I have 20 minutes" captureId="a-coach-short-prompt"
              onPress={() => api.act({ type: 'open-adjust', from: 'coach' }, 'a-coach-short-prompt')} />
          ) : null}
          <PromptChoice label="Why these movements?" captureId="a-coach-explain-prompt" onPress={() => api.act({ type: 'coach-explain' })} />
        </View>
        {/* v2: at large text the footnote ends the thread (s16 after the prompts) instead of the pinned accessory. */}
        {large ? <Txt role="meta" tone="secondary" captureId="a-coach-footnote" style={mt('s16')}>{fixtures.footnote}</Txt> : null}
      </Gutter>
    </Page>
  );
}

/**
 * Coach bottom accessory above the tab bar. The scroll view is its flex sibling, so the scroll
 * area always ends at the accessory's measured top (no hard-coded inset) and refits as the
 * composer grows. Default size: footnote + composer, bottom padding composer.outerGap.
 * Accessibility sizes: composer alone with s8 above and below.
 */
export function CoachAccessory({ state, api }: ScreenProps) {
  const { large } = useTextScale();
  const ref = useCapture('a-coach-composer-zone');
  const tooLong = state.composer.length > COMPOSER_LIMIT;
  return (
    <View ref={ref} testID="a-coach-composer-zone" style={[s.accessory, large && s.accessoryLarge]}>
      {large ? null : <Txt role="meta" tone="secondary">{fixtures.footnote}</Txt>}
      <Composer value={state.composer} focused={api.composerFocused}
        onFocus={() => api.setComposerFocused(true)} onBlur={() => api.setComposerFocused(false)}
        onChange={(text) => api.act({ type: 'composer', text })} onSend={() => api.act({ type: 'coach-send' })} />
      {tooLong ? <FieldError text="Keep messages under 280 characters." style={s.accessoryError} /> : null}
    </View>
  );
}

/* ---------------- Progress ---------------- */

export function ProgressScreen({ state, api }: ScreenProps) {
  const n = noticeFor(state, 'progress');
  const counts = weekCounts(state.history);
  const total = state.history.length;
  const chart = <WeeklyChart counts={counts} selected={state.selectedWeek} onSelect={(week) => api.act({ type: 'select-week', week })} />;
  if (state.emptyHistory && total === 0) {
    return (
      <Page id="a-screen-progress">
        <NavRow title="Progress" />
        <Gutter>
          <PageTitle text={'Look what\nadds up.'} captureId="a-progress-heading" />
          <View style={mt('s24')}>
            <EmptyBlock captureId="a-progress-empty" actionId="a-progress-primary" title="No recorded workouts yet."
              body="Confirm a set during a workout and save it here." action="Go to workout" onAction={() => api.act({ type: 'start-workout' })} />
          </View>
          <View style={mt('s32')}>
            <Txt role="sectionTitle" accessibilityRole="header">Last 4 weeks</Txt>
            <Txt role="meta" tone="secondary" style={mt('s4')}>0 workouts recorded</Txt>
          </View>
          <View style={mt('s16')}>{chart}</View>
        </Gutter>
      </Page>
    );
  }
  const week = state.history.filter((r) => r.week === state.selectedWeek);
  const weekSets = week.reduce((sum, r) => sum + r.sets, 0);
  const weekMinutes = week.reduce((sum, r) => sum + r.min, 0);
  const list = state.progressExpanded ? state.history : state.history.slice(0, 2);
  return (
    <Page id="a-screen-progress">
      <NavRow title="Progress" />
      <Gutter>
        <PageTitle text={'Look what\nadds up.'} captureId="a-progress-heading" />
        {n ? <Notice kind={n.kind} text={n.text} announce style={mt('s16')} /> : null}
        <ProgressStat total={total} />
        <View style={mt('s24')}>{chart}</View>
        <ProgressSummary title={state.selectedWeek === fixtures.thisWeek ? 'This week' : `Week of ${fixtures.weeks[state.selectedWeek]}`}
          workouts={week.length} sets={weekSets} minutes={weekMinutes} />
        <Txt role="sectionTitle" accessibilityRole="header" style={mt('s32')}>Recent workouts</Txt>
        <View style={mt('s4')}>
          {list.map((r) => (
            <HistoryRow key={r.id} record={r} onPress={() => api.act({ type: 'open-history', id: r.id }, `a-history-${r.id}`)} />
          ))}
        </View>
        {/* r3b (D8-1): the history toggle is a disclosure PlainAction, never the filled primary. */}
        <PlainAction style={mt('s16')} captureId="a-history-toggle" label={state.progressExpanded ? 'Show less' : `Show all ${total} workouts`}
          chevron={state.progressExpanded ? 'chevron-up' : 'chevron-down'} expanded={state.progressExpanded}
          onPress={() => api.act({ type: 'toggle-history' })} />
      </Gutter>
    </Page>
  );
}

function ProgressStat({ total }: { total: number }) {
  const ref = useCapture('a-progress-stat');
  return (
    <View ref={ref} testID="a-progress-stat" accessible accessibilityLabel={`${total} workouts in 4 weeks`} style={[s.stat, mt('s20')]}>
      <Txt role="stat">{String(total)}</Txt>
      <Txt role="body">workouts in 4 weeks</Txt>
    </View>
  );
}

function ProgressSummary({ title, workouts, sets, minutes }: { title: string; workouts: number; sets: number; minutes: number }) {
  const ref = useCapture('a-progress-summary');
  return (
    <View ref={ref} testID="a-progress-summary" style={mt('s24')}>
      <Txt role="sectionTitle" accessibilityRole="header">{title}</Txt>
      <View style={mt('s8')}>
        <SummaryRow value={workouts} text={workouts === 1 ? ' workout recorded' : ' workouts recorded'} />
        <SummaryRow value={sets} text=" confirmed sets" />
        <SummaryRow value={minutes} text=" minutes recorded" />
      </View>
    </View>
  );
}

/* ---------------- sheets ---------------- */

export function sheetFor(state: State, api: Api): SheetSpec | null {
  switch (state.sheet) {
    case 'adjust':
      return adjustSheet(state, api);
    case 'finish':
      return finishSheet(state, api);
    case 'history':
      return historySheet(state);
    case 'list':
      return {
        id: 'a-exercise-list', title: 'Today’s movements', closeId: 'a-exercise-list-close', large: true,
        body: (
          <SheetSection>
            {planMoves(state.plan).map((m, i, all) => <MovementRow key={m.id} move={m} variant={state.plan} ord={i + 1} last={i === all.length - 1} />)}
          </SheetSection>
        ),
      };
    default:
      return null;
  }
}

function adjustSheet(state: State, api: Api): SheetSpec {
  const cur = planTotals('full');
  const pro = planTotals('short');
  if (state.session) {
    // active-guard: an active session is never reconfigured; no Apply.
    return {
      id: 'a-adjust-review', title: 'Make room for 20 minutes', closeId: 'a-adjust-close', label: 'Make room for 20 minutes',
      body: (
        <>
          <Notice kind="info" text="Finish or save this workout before changing its plan." style={mt('s12')} />
          <SheetActions>
            <PrimaryAction label="Back to workout" captureId="a-adjust-workout" onPress={() => api.closeSheet(() => api.act({ type: 'go', to: 'workout' }))} />
          </SheetActions>
        </>
      ),
    };
  }
  const kept = planMoves('short');
  const left = MOVES.filter((m) => m.short === 0);
  return {
    id: 'a-adjust-review', title: 'Make room for 20 minutes', closeId: 'a-adjust-close', label: 'Make room for 20 minutes', large: true,
    body: (
      <>
        <SheetSection>
          <Compare label="Current" value={`${cur.minutes} minutes, ${cur.moves} movements, ${cur.sets} sets`} />
          <Compare label="Proposed" value={`${pro.minutes} minutes, ${pro.moves} movements, ${pro.sets} sets`} />
        </SheetSection>
        <SheetSection>
          <Txt role="bodyStrong" accessibilityRole="header">Keep</Txt>
          {kept.map((m, i) => (
            <SheetRow key={m.id} last={i === kept.length - 1} left={<Txt role="body" style={s.shrink}>{m.name}</Txt>}
              right={<Txt role="bodyStrong" style={tabular}>{`${m.short} sets`}</Txt>} />
          ))}
        </SheetSection>
        <SheetSection>
          <Txt role="bodyStrong" accessibilityRole="header">Leave for another day</Txt>
          {left.map((m, i) => (
            <SheetRow key={m.id} last={i === left.length - 1} left={<Txt role="body" style={s.shrink}>{m.name}</Txt>}
              right={<Txt role="bodyStrong" style={tabular}>{`${m.full} set`}</Txt>} />
          ))}
          <Txt role="meta" tone="secondary" style={mt('s8')}>One fewer press set and one fewer row set.</Txt>
        </SheetSection>
        <SheetActions>
          <Txt role="body">Nothing changes until you apply this option.</Txt>
          <PrimaryAction label="Apply 20-minute option" captureId="a-adjust-apply" onPress={() => api.closeSheet(() => api.act({ type: 'apply-short' }))} />
          <PlainAction label="Keep 35-minute workout" captureId="a-adjust-keep" chevron={null} placement="centered" onPress={() => api.closeSheet()} />
        </SheetActions>
      </>
    ),
  };
}

function finishSheet(state: State, api: Api): SheetSpec {
  const n = state.confirmed.length;
  const totals = planTotals(state.plan);
  if (n === 0) {
    return {
      id: 'a-finish-review', title: 'No sets recorded yet', closeId: 'a-finish-close',
      body: (
        <>
          <Txt role="body" style={mt('s12')}>Confirm a set to record it. Ending now saves nothing.</Txt>
          <SheetActions>
            <PrimaryAction label="Keep going" captureId="a-finish-continue" onPress={() => api.closeSheet()} />
            <PlainAction label="End without recording" captureId="a-finish-end" chevron={null} placement="centered"
              onPress={() => api.closeSheet(() => api.act({ type: 'end-without-recording' }))} />
          </SheetActions>
        </>
      ),
    };
  }
  const moves = planMoves(state.plan);
  return {
    id: 'a-finish-review', title: 'Save what you did?', closeId: 'a-finish-close', label: 'Save what you did?',
    body: (
      <>
        <Txt role="body" style={mt('s12')}>{`${n} sets recorded. ${totals.sets - n} planned sets remain unrecorded.`}</Txt>
        <SheetSection>
          {state.confirmed.map((c, i) => (
            <SheetRow key={`${c.move}:${c.set}`} last={i === n - 1}
              left={<View style={s.recordedRow}><IconSlot name="check" color={t.color.success} /><Txt role="body" style={s.shrink}>{`${moves[c.move].name}, set ${c.set}`}</Txt></View>}
              right={<Txt role="bodyStrong" style={tabular}>{`${c.reps} × ${loadText(c.kg)}`}</Txt>} />
          ))}
        </SheetSection>
        <SheetActions>
          <PrimaryAction label={`Save ${n} recorded sets`} captureId="a-finish-save" onPress={() => api.closeSheet(() => api.act({ type: 'save' }))} />
          <PlainAction label="Keep going" captureId="a-finish-continue" chevron={null} placement="centered" onPress={() => api.closeSheet()} />
        </SheetActions>
      </>
    ),
  };
}

function historySheet(state: State): SheetSpec {
  const r = state.history.find((x) => x.id === state.historyOpen) ?? state.history[0];
  const rows = r.partial ? planMoves('full').slice(0, 1) : planMoves('full');
  return {
    id: 'a-history-detail', title: 'Full-body strength', closeId: 'a-history-close', label: 'Recorded workout',
    body: (
      <>
        <MetaLine style={mt('s8')} items={[r.day, `${r.min} minutes recorded`, r.partial ? 'Partial' : 'Complete']} />
        <SheetSection>
          {rows.map((m, i) => (
            <SheetRow key={m.id} last={i === rows.length - 1} left={<Txt role="body" style={s.shrink}>{m.name}</Txt>}
              right={<Txt role="bodyStrong" style={tabular}>{`${r.partial ? r.sets : m.full} × ${m.defReps} at ${kgLabel(m, m.kg)}`}</Txt>} />
          ))}
        </SheetSection>
      </>
    ),
  };
}

/* 16 pt inline icon used beside recorded text (circle-check / check). */
function IconSlot({ name, color }: { name: 'check' | 'circle-check'; color: string }) {
  return <Icon name={name} size={L.icon.inline} color={color} />;
}

/* ---------------- styles ---------------- */

const s = StyleSheet.create({
  page: { paddingTop: L.frame.navGap },
  scrollPad: { height: L.frame.scrollBottomGap },
  subtitle: { marginTop: L.header.subtitleGap },
  center: { alignItems: 'center' },
  shrink: { flexShrink: 1 },
  weekHead: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'baseline', columnGap: t.space.s12 },
  planPanel: {
    backgroundColor: t.color.atmosphere, borderRadius: t.radius.selectedPlan, borderCurve: 'continuous',
    paddingTop: L.planPanel.paddingTop, paddingHorizontal: L.planPanel.paddingX, paddingBottom: L.planPanel.paddingBottom,
  },
  planAction: { marginTop: t.page.plan.actionGap },
  recorded: { flexDirection: 'row', alignItems: 'center', gap: t.space.s8 },
  recordedRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.s8, flexShrink: 1 },
  fields: { flexDirection: 'row', gap: L.field.pairGap },
  fieldsLarge: { flexDirection: 'column' },
  moreGap: { marginTop: t.page.workout.moreGap },
  context: { paddingBottom: t.space.s12, borderBottomWidth: t.stroke.divider, borderBottomColor: t.color.line },
  thread: { gap: L.message.gap },
  prompts: { gap: L.prompt.gap, alignItems: 'flex-start' },
  accessory: {
    paddingTop: t.space.s8, paddingHorizontal: L.frame.gutter, paddingBottom: L.composer.outerGap,
    backgroundColor: t.color.canvas, gap: L.composer.labelGap,
  },
  accessoryLarge: { paddingBottom: t.space.s8 },
  accessoryError: { marginTop: t.space.s0 },
  stat: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.s12, alignItems: 'baseline' },
});
