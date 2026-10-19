// Today, workout-start, stats (Progress tab root), history and read-only session detail
// (settings-training v2 DESIGN #training, flow.md, contracts.md#mode-matrix). Server data only; no sample numbers.
import { Pressable, StyleSheet, View } from 'react-native';
import type { AppMode, Exercise, History, Plan, Preferences, Stats, WorkoutSession } from '../../api/domain';
import { EmptyBlock, LoadingSkeleton, SessionSummary, SummaryRow } from '../../variants/a/components';
import { L, t } from '../shared/tokens';
import {
  AccountRow, Art, ChoiceRow, Choices, Gutter, MetaLine, Nav, Notice, PlainAction, PrimaryAction, Screen, Section, Spinner, StatusLine,
  Subtitle, Title, Txt, Wordmark,
} from '../shared/ui';
import { TC, trainingErrorCopy } from './copy';
import {
  completedPerWeek, historyCovers, loadLabel, orderedOccurrences, plural, repsRange, sessionDate, sessionMinutes, sessionTotals,
  setsOf, startedTime, weekStart, WEEK_MS, type PendingCommand, type Remote, type ServerError,
} from './model';
import { ExerciseStatRow, rowStatus, SessionRow, TargetTable, WeekBars } from './parts';

type LoadUnit = Preferences['loadUnit'];

function ErrorNotice({ remote, onRetry }: { remote: Remote<unknown>; onRetry: () => void }) {
  if (remote.status !== 'error') return null;
  return <Notice kind="error" text={trainingErrorCopy(remote.error, false)} announce action={{ label: TC.tryAgain, onPress: onRetry }} />;
}

/* ---------------- Today ---------------- */

export function TodayScreen({ name, appMode, activePlan, active, history, stats, onSettings, onStart, onResume, onCreatePlan,
  entries }: {
  name: string; appMode: AppMode; activePlan: Plan | null; active: WorkoutSession | null;
  history: Remote<History>; stats: Remote<Stats>;
  onSettings: () => void; onStart: () => void; onResume: (session: WorkoutSession) => void; onCreatePlan: () => void;
  entries: { label: string; onPress: () => void; testID: string }[];
}) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const week = weekStart(new Date()).getTime();
  const thisWeek = history.status === 'ready' && historyCovers(history.value, new Date(week))
    ? history.value.items.filter((s) => s.status === 'completed' && s.completedAt && Date.parse(s.completedAt) >= week) : null;
  return (
    <Screen testID="screen-today" nav={(
      <Nav leading={<Wordmark />} trailing={(
        <View style={s.navTrail}>
          <Txt role="meta" tone="secondary">{today}</Txt>
          {/* DGR-001 (v2): the avatar opens Settings directly. */}
          <Pressable testID="a-account-entry" accessibilityRole="button" accessibilityLabel={`Settings, ${name}`} onPress={onSettings} style={s.avatar}>
            <Txt role="bodyStrong">{(name.trim()[0] ?? '·').toUpperCase()}</Txt>
          </Pressable>
        </View>
      )} />
    )}>
      <Gutter>
        <Title display text={`Hello, ${name}.`} testID="a-today-title" />
        <Subtitle text="Let’s make room to move." />
      </Gutter>
      <Gutter style={s.gap32}><Art /></Gutter>
      <Section>
        {active ? (
          <>
            <SessionSummary eyebrow={`In progress · started ${startedTime(active.startedAt)}`} title={active.planSnapshot.name}
              meta={[plural(active.sets.filter((x) => x.status === 'confirmed').length, 'set logged', 'sets logged')]} />
            <PrimaryAction label="Resume workout" captureId="a-today-primary" onPress={() => onResume(active)} />
          </>
        ) : activePlan ? (
          <>
            <SessionSummary title={activePlan.name} meta={[`${activePlan.minutes} minutes`, plural(activePlan.items.length, 'movement', 'movements')]} />
            <PrimaryAction label="Start" captureId="a-today-primary" onPress={onStart} />
          </>
        ) : (
          <PrimaryAction label="Create a plan" icon="plus" captureId="a-today-primary" onPress={onCreatePlan} />
        )}
      </Section>
      {appMode === 'advanced' && thisWeek && stats.status === 'ready' ? (
        <Section tight>
          <Txt role="meta" tone="secondary">This week</Txt>
          <MetaLine items={[plural(thisWeek.length, 'workout finished', 'workouts finished'),
            plural(thisWeek.reduce((n, x) => n + sessionTotals(x).confirmedSets, 0), 'confirmed set', 'confirmed sets')]} />
        </Section>
      ) : null}
      {entries.length ? (
        <Section tight>
          {entries.map((e, i) => <AccountRow key={e.testID} label={e.label} testID={e.testID} onPress={e.onPress} last={i === entries.length - 1} />)}
        </Section>
      ) : null}
    </Screen>
  );
}

/* ---------------- Workout start (tab root) ---------------- */

export function WorkoutStartScreen({ appMode, plans, exercises, active, selectedId, start, onSelect, onStart, onRetryStart, onResume,
  onOpenPlans, onRetryLoad }: {
  appMode: AppMode; plans: Plan[]; exercises: Record<string, Exercise>; active: Remote<WorkoutSession | null>; selectedId: string | null;
  start: PendingCommand<{ planId: string; expectedPlanRevision: number }> | null;
  onSelect: (planId: string) => void; onStart: (plan: Plan) => void; onRetryStart: () => void;
  onResume: (session: WorkoutSession) => void; onOpenPlans: () => void; onRetryLoad: () => void;
}) {
  const advanced = appMode === 'advanced';
  const selected = plans.find((p) => p.id === selectedId) ?? plans[0] ?? null;
  const resume = active.status === 'ready' ? active.value : null;
  const startState = start?.state;
  const meta = (p: Plan) => [`${p.minutes} min`,
    ...(advanced ? [plural(p.items.length, 'movement', 'movements'), plural(p.items.reduce((n, i) => n + i.setTarget, 0), 'set', 'sets')] : [])];
  return (
    <Screen testID="screen-workout-start" nav={<Nav leading={<Txt role="bodyStrong">Workout</Txt>} />}>
      <Gutter><Title text="Workout" testID="a-workout-start-title" /></Gutter>
      <Section>
        <ErrorNotice remote={active} onRetry={onRetryLoad} />
        {active.status === 'loading' ? <LoadingSkeleton /> : null}
        {resume ? (
          <>
            <SessionSummary eyebrow={`In progress · started ${startedTime(resume.startedAt)}`} title={resume.planSnapshot.name}
              meta={[plural(resume.sets.filter((x) => x.status === 'confirmed').length, 'set logged', 'sets logged')]} />
            <PrimaryAction label={`Resume ${resume.planSnapshot.name}`} captureId="a-resume" onPress={() => onResume(resume)} />
          </>
        ) : null}
      </Section>
      {plans.length === 0 ? (
        <Section>
          <Txt role="sectionTitle" accessibilityRole="header">{TC.plansEmpty}</Txt>
          <PrimaryAction label="Create a plan" icon="plus" captureId="a-create-plan" onPress={onOpenPlans} />
        </Section>
      ) : (
        <Section>
          <Choices>
            {plans.map((p) => (
              <ChoiceRow key={p.id} title={p.name} detail={meta(p).join(' · ')} selected={selected?.id === p.id}
                testID={`a-start-plan-${p.id}`} onPress={() => onSelect(p.id)} />
            ))}
          </Choices>
          {advanced && selected ? (
            <View style={s.targets}>
              {selected.items.map((item) => (
                <Txt key={item.id} role="meta" tone="secondary">
                  {`${exercises[item.exerciseId]?.name ?? 'Movement'} · ${plural(item.setTarget, 'set', 'sets')} · ${repsRange(item.repMin, item.repMax)}`}
                </Txt>
              ))}
            </View>
          ) : null}
          {startState?.status === 'unknown' ? (
            <Notice kind="warning" text={TC.writeUnknown} announce action={{ label: TC.tryAgain, onPress: onRetryStart }} />
          ) : null}
          {startState?.status === 'failed' || startState?.status === 'conflict' ? (
            <Notice kind="error" text={trainingErrorCopy(startState.error, true)} announce />
          ) : null}
          {selected ? (resume
            ? <PlainAction label={`Start ${selected.name}`} captureId="a-start" disabled={startState?.status === 'pending' || startState?.status === 'unknown'} onPress={() => onStart(selected)} />
            : <PrimaryAction label="Start" captureId="a-start" loading={startState?.status === 'pending'}
              disabled={startState?.status === 'unknown'} onPress={() => onStart(selected)} />) : null}
          {resume ? <Txt role="meta" tone="secondary">{TC.resumeFootnote}</Txt> : null}
        </Section>
      )}
    </Screen>
  );
}

/* ---------------- Stats (Progress tab root) ---------------- */

export function StatsScreen({ appMode, stats, history, active, exercises, loadUnit, onRefresh, onOpenHistory, onOpenSession,
  onStartWorkout }: {
  appMode: AppMode; stats: Remote<Stats>; history: Remote<History>; active: WorkoutSession | null;
  exercises: Record<string, Exercise>; loadUnit: LoadUnit;
  onRefresh: () => void; onOpenHistory: () => void; onOpenSession: (id: string) => void; onStartWorkout: () => void;
}) {
  const advanced = appMode === 'advanced';
  const nav = <Nav leading={<Txt role="bodyStrong">Progress</Txt>} />;
  if (stats.status === 'loading') return <Screen testID="screen-stats" nav={nav}><Section><LoadingSkeleton /></Section></Screen>;
  if (stats.status === 'error') return <Screen testID="screen-stats" nav={nav}><Section><ErrorNotice remote={stats} onRetry={onRefresh} /></Section></Screen>;
  const value = stats.value;
  const empty = value.completedSessions === 0 && value.confirmedSets === 0;
  const since = new Date(weekStart(new Date()).getTime() - 3 * WEEK_MS);
  const weeks = advanced && history.status === 'ready' && historyCovers(history.value, since)
    ? completedPerWeek(history.value.items, new Date(), 4) : null;
  return (
    <Screen testID="screen-stats" nav={nav}>
      <Gutter><Title text="Look what adds up." testID="a-progress-heading" /></Gutter>
      {stats.refreshError ? (
        <Section tight><Notice kind="info" text={TC.statsStale} action={{ label: 'Retry', onPress: onRefresh }} /></Section>
      ) : null}
      {empty ? (
        <Section>
          <EmptyBlock title={TC.statsEmptyTitle} body={TC.statsEmptyBody} action={TC.statsEmptyAction} onAction={onStartWorkout}
            captureId="a-progress-empty" actionId="a-progress-primary" />
        </Section>
      ) : (
        <>
          <Section>
            <View accessible accessibilityLabel={`${value.completedSessions} workouts finished`} style={s.stat} testID="a-progress-stat">
              <Txt role="stat">{String(value.completedSessions)}</Txt>
              <Txt role="body">{value.completedSessions === 1 ? 'workout finished' : 'workouts finished'}</Txt>
            </View>
            <SummaryRow value={value.confirmedSets} text={value.confirmedSets === 1 ? ' confirmed set' : ' confirmed sets'} />
            <SummaryRow value={value.repetitions} text={value.repetitions === 1 ? ' rep' : ' total reps'} />
            {advanced && value.volumeKg > 0 ? <Txt role="body">{`${loadLabel(value.volumeKg, loadUnit)} total volume`}</Txt> : null}
          </Section>
          {weeks ? (
            <Section>
              <Txt role="sectionTitle" accessibilityRole="header">Last 4 weeks</Txt>
              <WeekBars weeks={weeks} />
            </Section>
          ) : null}
          {advanced && value.byExercise.length ? (
            <Section>
              <Txt role="sectionTitle" accessibilityRole="header">By movement</Txt>
              {value.byExercise.map((b, i) => (
                <ExerciseStatRow key={b.exerciseId} name={exercises[b.exerciseId]?.name ?? 'Movement'} sets={b.confirmedSets} reps={b.repetitions}
                  volumeKg={b.volumeKg} bestKg={b.maxWeightKg} unit={loadUnit} last={i === value.byExercise.length - 1} />
              ))}
              {value.includesActiveConfirmedSets && active ? <Txt role="meta" tone="secondary">{TC.statsActiveIncluded}</Txt> : null}
            </Section>
          ) : null}
        </>
      )}
      <Section>
        <Txt role="sectionTitle" accessibilityRole="header">Recent workouts</Txt>
        <ErrorNotice remote={history} onRetry={onRefresh} />
        {history.status === 'loading' ? <Spinner /> : null}
        {history.status === 'ready' ? history.value.items.slice(0, 3).map((x, i, list) => (
          <SessionRow key={x.id} session={x} meta={historyMeta(x, appMode, loadUnit)} onPress={() => onOpenSession(x.id)} last={i === list.length - 1} />
        )) : null}
        {history.status === 'ready' && history.value.items.length ? (
          <PlainAction label="See all workouts" captureId="a-history-all" onPress={onOpenHistory} />
        ) : null}
      </Section>
    </Screen>
  );
}

export function historyMeta(x: WorkoutSession, appMode: AppMode, unit: LoadUnit): string[] {
  const totals = sessionTotals(x);
  const items = [sessionDate(x.startedAt), plural(totals.confirmedSets, 'set logged', 'sets logged')];
  if (x.status === 'active') items.unshift('In progress');
  if (appMode === 'advanced') {
    items.push(plural(x.occurrences.length, 'movement', 'movements'));
    if (totals.volumeKg > 0) items.push(loadLabel(totals.volumeKg, unit)); // never "0 kg" for bodyweight sessions
  }
  return items;
}

/* ---------------- History ---------------- */

export function HistoryScreen({ appMode, pages, more, loadUnit, onBack, onOpen, onLoadMore, onRefresh, onStartWorkout }: {
  appMode: AppMode; pages: Remote<History>; more: { state: 'idle' | 'loading'; error: ServerError | null };
  loadUnit: LoadUnit; onBack: () => void; onOpen: (id: string) => void; onLoadMore: () => void; onRefresh: () => void; onStartWorkout: () => void;
}) {
  const nav = <Nav back="Progress" onBack={onBack} />;
  return (
    <Screen testID="screen-history" nav={nav}>
      <Gutter><Title text="History" testID="a-history-title" /></Gutter>
      <Section>
        <ErrorNotice remote={pages} onRetry={onRefresh} />
        {pages.status === 'loading' ? <LoadingSkeleton /> : null}
        {pages.status === 'ready' && pages.value.items.length === 0 ? (
          <EmptyBlock title={TC.statsEmptyTitle} body={TC.statsEmptyBody} action={TC.statsEmptyAction} onAction={onStartWorkout} />
        ) : null}
        {pages.status === 'ready' ? pages.value.items.map((x, i, list) => (
          <SessionRow key={x.id} session={x} meta={historyMeta(x, appMode, loadUnit)} onPress={() => onOpen(x.id)} last={i === list.length - 1} />
        )) : null}
        {pages.status === 'ready' && pages.value.items.length ? (
          pages.value.nextBefore === null ? <Txt role="meta" tone="secondary" testID="a-history-end">{TC.historyEnd}</Txt>
            : more.state === 'loading' ? <Spinner />
              : more.error ? <Notice kind="error" text={TC.getUnavailable} action={{ label: TC.tryAgain, onPress: onLoadMore }} />
                : <PlainAction label="Show more" captureId="a-history-more" chevron="chevron-down" onPress={onLoadMore} />
        ) : null}
      </Section>
    </Screen>
  );
}

/* ---------------- Session detail (read-only) ---------------- */

export function SessionDetailScreen({ appMode, session, exercises, loadUnit, backLabel, onBack, onResume, onRetry }: {
  appMode: AppMode; session: Remote<WorkoutSession>; exercises: Record<string, Exercise>; loadUnit: LoadUnit; backLabel: string;
  onBack: () => void; onResume: (session: WorkoutSession) => void; onRetry: () => void;
}) {
  const nav = <Nav back={backLabel} onBack={onBack} />;
  if (session.status !== 'ready') {
    return (
      <Screen testID="screen-session" nav={nav}>
        <Section>{session.status === 'loading' ? <LoadingSkeleton /> : <ErrorNotice remote={session} onRetry={onRetry} />}</Section>
      </Screen>
    );
  }
  const x = session.value;
  const minutes = sessionMinutes(x);
  const totals = sessionTotals(x);
  return (
    <Screen testID="screen-session" nav={nav}>
      <Gutter>
        <Title text={x.planSnapshot.name} testID="a-session-title" />
        <MetaLine items={[sessionDate(x.startedAt), ...(minutes ? [`${minutes} min`] : []), x.status === 'completed' ? 'Completed' : TC.notFinished]} />
      </Gutter>
      {x.status === 'active' ? (
        <Section tight><PrimaryAction label="Resume workout" captureId="a-session-resume" onPress={() => onResume(x)} /></Section>
      ) : null}
      <Section>
        {orderedOccurrences(x).map((o, i, list) => {
          const sets = setsOf(x, o.id);
          const confirmed = sets.filter((y) => y.status === 'confirmed').length;
          const name = exercises[o.exerciseId]?.name ?? 'Movement';
          if (appMode !== 'advanced') {
            return <AccountRow key={o.id} label={name} value={plural(confirmed, 'set logged', 'sets logged')} last={i === list.length - 1} />;
          }
          return (
            <View key={o.id} style={s.movement}>
              <Txt role="bodyStrong">{name}</Txt>
              <TargetTable target={o.target} unit={loadUnit}
                rows={sets.map((set) => ({ n: set.setNumber, set, status: rowStatus(set, null, false), current: false }))} />
            </View>
          );
        })}
      </Section>
      {appMode === 'advanced' ? (
        <Section tight>
          <MetaLine items={[plural(totals.confirmedSets, 'confirmed set', 'confirmed sets'), plural(totals.repetitions, 'rep', 'reps'),
            ...(totals.volumeKg > 0 ? [`${loadLabel(totals.volumeKg, loadUnit)} volume`] : [])]} />
        </Section>
      ) : null}
    </Screen>
  );
}

/* ---------------- Coach tab ---------------- */

/** The fifth Open Mat tab has no backing feature yet; it says so instead of drawing a fake chat. */
export function CoachUnavailable() {
  return (
    <Screen testID="screen-coach" nav={<Nav leading={<Txt role="bodyStrong">Coach</Txt>} />}>
      <Gutter><Title text="Coach" /></Gutter>
      <Section><StatusLine text="Coach chat isn’t available yet." testID="a-coach-status" /></Section>
    </Screen>
  );
}

const s = StyleSheet.create({
  gap32: { marginTop: t.space.s32 },
  navTrail: { flexDirection: 'row', alignItems: 'center', gap: t.space.s12 },
  avatar: {
    width: L.account.avatar, height: L.account.avatar, borderRadius: t.radius.capsule, backgroundColor: t.color.selection,
    alignItems: 'center', justifyContent: 'center',
  },
  targets: { gap: t.space.s4 },
  stat: { flexDirection: 'row', alignItems: 'baseline', gap: t.space.s8, flexWrap: 'wrap' },
  movement: { gap: t.space.s8, paddingVertical: t.space.s12 },
});
