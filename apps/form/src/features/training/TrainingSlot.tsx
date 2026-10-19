// One account/session owner retains starts, workout queues and feedback across tabs and shell routes.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Exercise, History, Stats, WorkoutSession, SourcePlan, SourceWorkoutSession,
  StoredPlan, StoredWorkoutSession, StoredHistory, StoredStats } from '../../api/domain';
import type { SourceTrainingResources } from '../../api/sourceTrainingResources';
import { decodePlan } from '../../api/trainingCodec';
import { TabBar } from '../../variants/a/frame';
import type { ScreenId } from '../../types';
import type { HomeSlotContext } from '../contract';
import { useCommandKey } from '../shared/commands';
import { Notice } from '../shared/ui';
import { t } from '../shared/tokens';
import {
  activeFrom, commandStateFrom, ready, refreshFailed, refreshing, toServerError, type PendingCommand, type Remote, type ServerError,
} from './model';
import { CoachUnavailable, HistoryScreen, SessionDetailScreen, StatsScreen, TodayScreen, WorkoutStartScreen } from './screens';
import { useWorkout, useSourceWorkout } from './useWorkout';
import { monotonicRestTiming, type RestTiming } from './source-rest';
import { WorkoutScreen } from './WorkoutScreen';
import { guardTrainingFeedback, useTrainingFeedback, type TrainingFeedbackControls } from './useTrainingFeedback';

// Foreground reconciliation shares the controller's generation fence and cleanup.
const foregroundRestTiming: RestTiming = {
  ...monotonicRestTiming,
  subscribe: tick => {
    const stop = monotonicRestTiming.subscribe(tick);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') tick(); });
    return () => { stop(); subscription.remove(); };
  },
};

type Tab = 'today' | 'workout' | 'coach' | 'progress';
type ProgressRoute = { name: 'stats' } | { name: 'history' } | { name: 'session'; id: string; back: 'History' | 'Progress' };
export type TrainingStartCommand = PendingCommand<{ planId: string; expectedPlanRevision: number }> & { plan: StoredPlan };
export type SourceTrainingSlotContext = {
  kind: 'navigation'; tab: Tab; route: ProgressRoute;
  plans: readonly StoredPlan[]; selectedPlan: SourcePlan | null; start: TrainingStartCommand | null;
  availability: 'loading' | 'ready' | 'unavailable';
  history: Remote<StoredHistory>; stats: Remote<StoredStats>; detail: Remote<StoredWorkoutSession>;
  more: { state: 'idle' | 'loading'; error: ServerError | null };
  feedback: TrainingFeedbackControls;
  selectPlan(plan: SourcePlan): boolean; startSelected(): void; retryStart(): void;
  resume(session: StoredWorkoutSession): void; openHistory(): void; openSession(id: string): void;
  back(): void; refresh(): void; loadMore(): void; openPlans(): void;
} | {
  kind: 'workout'; workout: ReturnType<typeof useSourceWorkout>; feedback: TrainingFeedbackControls; onLeave(): void;
};
export type SourceTrainingRenderer = (ctx: SourceTrainingSlotContext) => ReactNode;

function isSourcePlan(plan: StoredPlan): plan is SourcePlan { return 'schema' in plan; }
function isSourceSession(session: StoredWorkoutSession): session is SourceWorkoutSession { return isSourcePlan(session.planSnapshot); }
function sourceUnavailable(): ServerError {
  return { status: 0, code: 'source_training_unavailable', message: 'Source training display is unavailable.', effectUnknown: false };
}
// A mixed page is never filtered into an apparently complete legacy page or numeric total.
function legacyHistory(value: Remote<StoredHistory>): Remote<History> {
  if (value.status !== 'ready') return value;
  const items: WorkoutSession[] = [];
  for (const session of value.value.items) {
    if (isSourceSession(session)) return { status: 'error', error: sourceUnavailable() };
    items.push(session);
  }
  return { ...value, value: { ...value.value, items } };
}
function legacyStats(value: Remote<StoredStats>): Remote<Stats> {
  if (value.status !== 'ready') return value;
  if ('coverage' in value.value) return { status: 'error', error: sourceUnavailable() };
  return { ...value, value: value.value };
}
function legacyDetail(value: Remote<StoredWorkoutSession>): Remote<WorkoutSession> {
  if (value.status !== 'ready') return value;
  if (isSourceSession(value.value)) return { status: 'error', error: sourceUnavailable() };
  return { ...value, value: value.value };
}
function freezePlan(plan: StoredPlan): StoredPlan {
  const captured = decodePlan(plan);
  const freeze = (value: object) => {
    for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
    Object.freeze(value);
  };
  freeze(captured);
  return captured;
}

export function TrainingSlot(ctx: HomeSlotContext) {
  return <TrainingHome key={`${ctx.account.accountId}:${ctx.sessionGeneration}`} {...ctx} />;
}

function TrainingHome(ctx: HomeSlotContext) {
  const { resources, appMode, account } = ctx;
  const loadUnit = account.preferences.loadUnit;
  const insets = useSafeAreaInsets();
  const alive = useRef(true);
  const latest = useRef(ctx); latest.current = ctx;
  const owner = useRef({ resources, accountId: account.accountId, generation: ctx.sessionGeneration,
    isCurrentSession: ctx.isCurrentSession, expired: false });
  if (owner.current.resources !== resources || owner.current.accountId !== account.accountId
    || owner.current.generation !== ctx.sessionGeneration) owner.current.expired = true;
  const isCurrent = useCallback(() => alive.current && !owner.current.expired && owner.current.isCurrentSession(), []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const presentation = useRef({ renderer: ctx.renderSourceTraining, epoch: 0 });
  if (presentation.current.renderer !== ctx.renderSourceTraining) {
    presentation.current = { renderer: ctx.renderSourceTraining, epoch: presentation.current.epoch + 1 };
  }
  const presentationEpoch = presentation.current.epoch;
  const canPresent = () => isCurrent() && !!ctx.renderSourceTraining && presentation.current.epoch === presentationEpoch;

  const exercises = useMemo(() => Object.fromEntries(ctx.exercises.map((e) => [e.id, e])) as Record<string, Exercise>, [ctx.exercises]);
  const [tab, setTab] = useState<Tab>('today');
  const [progress, setProgress] = useState<ProgressRoute[]>([{ name: 'stats' }]);
  const [openSession, setOpenSession] = useState<StoredWorkoutSession | null>(null);
  const activeOwner = useRef<StoredWorkoutSession | null>(null);
  const resumeFlight = useRef(false);
  const [history, setHistory] = useState<Remote<StoredHistory>>({ status: 'loading' });
  const [more, setMore] = useState<{ state: 'idle' | 'loading'; error: ServerError | null }>({ state: 'idle', error: null });
  const moreFlight = useRef(false), historyVersion = useRef(0);
  const [stats, setStats] = useState<Remote<StoredStats>>({ status: 'loading' });
  const [detail, setDetail] = useState<Remote<StoredWorkoutSession>>({ status: 'loading' });
  const detailVersion = useRef(0);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourcePlan | null>(null);
  const selectedSourceRef = useRef<SourcePlan | null>(null);
  const [start, setStart] = useState<TrainingStartCommand | null>(null);
  // Both the full detached snapshot and original key survive an unknown result.
  const startCommand = useRef<TrainingStartCommand | null>(null);
  const startFlight = useRef(false);
  const startKey = useCommandKey();
  const acquisition = useRef<Promise<SourceTrainingResources> | null>(null);
  const port = useRef<SourceTrainingResources | null>(null);
  const [availability, setAvailability] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const getSource = useCallback(async () => {
    if (!isCurrent()) return null;
    acquisition.current ??= owner.current.resources.sourceTraining();
    const result = await acquisition.current;
    if (!isCurrent()) return null;
    port.current = result;
    setAvailability('ready');
    return result;
  }, [isCurrent]);

  /** Only the original current session can ask the shell to handle authentication failure. */
  const unauthenticated = useCallback(() => { if (isCurrent()) void latest.current.reload(); }, [isCurrent]);
  const feedback = useTrainingFeedback({ api: owner.current.resources.api, accountId: owner.current.accountId,
    sessionGeneration: owner.current.generation,
    isCurrentSession: (accountId, generation) => accountId === owner.current.accountId && generation === owner.current.generation && isCurrent(),
    onUnauthenticated: unauthenticated });
  const failed = useCallback((error: unknown) => {
    const e = toServerError(error);
    if (e.status === 401) unauthenticated();
    return e;
  }, [unauthenticated]);
  const loadHistory = useCallback(async () => {
    if (!isCurrent()) return;
    const version = ++historyVersion.current;
    setHistory((h) => refreshing(h)); setMore({ state: 'idle', error: null });
    try {
      const source = await getSource(); if (!source || !isCurrent()) return;
      const page = await source.history();
      if (isCurrent() && version === historyVersion.current) setHistory(ready(page));
    } catch (error) {
      if (!isCurrent()) return;
      const e = failed(error);
      if (!port.current) setAvailability('unavailable');
      if (version === historyVersion.current) setHistory((h) => refreshFailed(h, e));
    }
  }, [getSource, isCurrent, failed]);
  const loadMore = useCallback(async () => {
    if (!isCurrent() || history.status !== 'ready' || history.value.nextBefore === null || moreFlight.current) return;
    const before = history.value.nextBefore, version = historyVersion.current;
    moreFlight.current = true; setMore({ state: 'loading', error: null });
    try {
      const source = await getSource(); if (!source || !isCurrent()) return;
      const page = await source.history(before);
      if (!isCurrent() || version !== historyVersion.current) return;
      setHistory((h) => (h.status === 'ready' && h.value.nextBefore === before
        ? ready({ items: [...h.value.items, ...page.items.filter((x) => !h.value.items.some((y) => y.id === x.id))], nextBefore: page.nextBefore }) : h));
      setMore({ state: 'idle', error: null });
    } catch (error) {
      if (isCurrent() && version === historyVersion.current) setMore({ state: 'idle', error: failed(error) });
    } finally { moreFlight.current = false; }
  }, [getSource, isCurrent, history, failed]);
  const loadStats = useCallback(async () => {
    if (!isCurrent()) return;
    setStats((x) => refreshing(x));
    try {
      const source = await getSource(); if (!source || !isCurrent()) return;
      const value = await source.stats();
      if (isCurrent()) setStats(ready(value));
    } catch (error) {
      if (!isCurrent()) return;
      if (!port.current) setAvailability('unavailable');
      setStats((x) => refreshFailed(x, failed(error)));
    }
  }, [getSource, isCurrent, failed]);
  const refreshAll = useCallback(() => { void loadHistory(); void loadStats(); }, [loadHistory, loadStats]);
  useEffect(() => { refreshAll(); }, [refreshAll]);

  // Advanced charts use only loaded pages; the opaque cursor remains owned by the server.
  useEffect(() => {
    if (appMode !== 'advanced' || tab !== 'progress' || history.status !== 'ready' || more.state === 'loading' || more.error) return;
    const last = history.value.items.at(-1);
    if (history.value.nextBefore !== null && last && Date.parse(last.startedAt) >= Date.now() - 35 * 24 * 60 * 60 * 1000) void loadMore();
  }, [appMode, tab, history, more, loadMore]);

  const displaySession = (session: StoredWorkoutSession) => {
    if (!isCurrent()) return;
    if (session.status === 'active') {
      if (activeOwner.current && activeOwner.current.id !== session.id) return;
      activeOwner.current = session; setOpenSession(session); setTab('workout');
    } else {
      setDetail(ready(session)); setProgress([{ name: 'stats' }, { name: 'session', id: session.id, back: 'Progress' }]); setTab('progress');
    }
  };
  const resume = async (session: StoredWorkoutSession | WorkoutSession) => {
    if (!isCurrent() || startCommand.current || activeOwner.current || resumeFlight.current) return;
    resumeFlight.current = true;
    try {
      const source = await getSource(); if (!source || !isCurrent()) return;
      const fresh = await source.workout(session.id);
      if (isCurrent()) displaySession(fresh);
    } catch (error) { if (isCurrent()) failed(error); }
    finally { resumeFlight.current = false; }
  };
  const sendStart = async (sent: TrainingStartCommand, retry: boolean) => {
    if (!isCurrent() || startFlight.current) return;
    startFlight.current = true; startCommand.current = sent;
    setStart({ ...sent, state: { status: 'pending' } });
    try {
      const source = await getSource(); if (!source || !isCurrent()) return;
      const session = await source.startWorkout(sent.plan, sent.key);
      if (!isCurrent()) return;
      startCommand.current = null; startKey.settle(); setStart(null); displaySession(session); void loadHistory();
    } catch (error) {
      if (!isCurrent()) return;
      const e = failed(error);
      // A rejection on retry cannot disprove the earlier unknown effect.
      const next: TrainingStartCommand = Object.freeze({ ...sent, state: retry && e.status !== 401
        ? { status: 'unknown' as const, error: { ...e, effectUnknown: true } } : commandStateFrom(e) });
      if (next.state.status === 'unknown' && e.status !== 401) startCommand.current = next;
      else { startCommand.current = null; startKey.settle(); }
      setStart(next);
      if (!retry && (e.code === 'plan_archived' || e.code === 'stale_revision')) void latest.current.reload();
    } finally { startFlight.current = false; }
  };
  const startPlan = (plan: StoredPlan) => {
    if (!isCurrent() || startFlight.current || startCommand.current || activeOwner.current || resumeFlight.current) return;
    let captured: StoredPlan;
    try { captured = freezePlan(plan); } catch { return; }
    if (captured.archived) return;
    const payload = Object.freeze({ planId: captured.id, expectedPlanRevision: captured.revision });
    void sendStart({ plan: captured, payload, key: startKey.keyFor(payload), state: { status: 'pending' } }, false);
  };
  const retryStart = () => {
    const sent = startCommand.current;
    if (isCurrent() && !startFlight.current && sent?.state.status === 'unknown') void sendStart(sent, true);
  };
  const selectSource = (plan: SourcePlan): boolean => {
    if (!canPresent() || startCommand.current || startFlight.current || activeOwner.current || resumeFlight.current) return false;
    let captured: StoredPlan;
    try { captured = freezePlan(plan); } catch { return false; }
    if (!isSourcePlan(captured) || captured.archived) return false;
    const saved = latest.current.storedPlans.find(value => value.id === captured.id);
    try { if (!saved || JSON.stringify(decodePlan(saved)) !== JSON.stringify(captured)) return false; }
    catch { return false; }
    selectedSourceRef.current = captured; setSelectedSource(captured); setTab('workout'); return true;
  };
  useEffect(() => {
    if (!isCurrent() || !ctx.renderSourceTraining || !ctx.registerSourceTraining) return;
    return ctx.registerSourceTraining(selectSource);
  }, [ctx.registerSourceTraining, ctx.renderSourceTraining, presentationEpoch, isCurrent]);

  const selectTab = (id: ScreenId) => {
    if (!isCurrent()) return;
    if (id === 'plan') { ctx.openPlans(); return; }
    setTab(id); if (id === 'progress' || id === 'today') refreshAll();
  };
  const openDetail = (id: string, back: 'History' | 'Progress') => {
    if (!isCurrent()) return;
    const version = ++detailVersion.current;
    setTab('progress'); setProgress((r) => [...r, { name: 'session', id, back }]); setDetail({ status: 'loading' });
    void (async () => {
      try {
        const source = await getSource(); if (!source || !isCurrent()) return;
        const value = await source.workout(id);
        if (isCurrent() && version === detailVersion.current) setDetail(ready(value));
      } catch (error) {
        if (isCurrent() && version === detailVersion.current) setDetail({ status: 'error', error: failed(error) });
      }
    })();
  };
  const popProgress = () => { if (isCurrent()) { detailVersion.current++; setProgress((r) => r.length > 1 ? r.slice(0, -1) : r); } };
  const legacyPages = legacyHistory(history), numericStats = legacyStats(stats), legacySession = legacyDetail(detail);
  const activeSession = legacyPages.status === 'ready' ? activeFrom(legacyPages.value) : null;
  const activeRemote: Remote<WorkoutSession | null> = legacyPages.status === 'ready' ? ready(activeSession)
    : legacyPages.status === 'error' ? { status: 'error', error: legacyPages.error } : { status: 'loading' };
  const entries = [
    ...(ctx.openActivity ? [{ label: 'Activity', onPress: ctx.openActivity, testID: 'a-entry-activity' }] : []),
    ...(ctx.openCommunity ? [{ label: 'Community', onPress: ctx.openCommunity, testID: 'a-entry-community' }] : []),
    ...(ctx.openBody ? [{ label: 'Body assessment', onPress: ctx.openBody, testID: 'a-entry-body' }] : []),
  ];
  const route = progress[progress.length - 1];
  const needsSource = ctx.storedPlans.some(isSourcePlan) || !!selectedSource
    || (history.status === 'ready' && history.value.items.some(isSourceSession))
    || (stats.status === 'ready' && 'coverage' in stats.value)
    || (detail.status === 'ready' && isSourceSession(detail.value));
  let screen;
  if (tab === 'coach') screen = <CoachUnavailable />;
  else if (tab === 'workout' && openSession) screen = null;
  else if (needsSource) {
    screen = ctx.renderSourceTraining ? ctx.renderSourceTraining({ kind: 'navigation', tab, route,
      plans: ctx.storedPlans, selectedPlan: selectedSource, start, availability, history, stats, detail, more,
      feedback: guardTrainingFeedback(feedback, canPresent),
      selectPlan: selectSource,
      startSelected: () => { if (canPresent() && selectedSourceRef.current) startPlan(selectedSourceRef.current); },
      retryStart: () => { if (canPresent()) retryStart(); },
      resume: session => { if (canPresent()) void resume(session); },
      openHistory: () => { if (canPresent()) { setTab('progress'); setProgress(r => [...r, { name: 'history' }]); } },
      openSession: id => { if (canPresent()) openDetail(id, 'History'); },
      back: () => { if (canPresent()) popProgress(); }, refresh: () => { if (canPresent()) refreshAll(); },
      loadMore: () => { if (canPresent()) void loadMore(); }, openPlans: () => { if (canPresent()) ctx.openPlans(); },
    }) : <Notice kind="info" text="Source training display is unavailable." />;
  } else if (tab === 'today') {
    screen = <TodayScreen name={account.profile.name} appMode={appMode} activePlan={ctx.activePlan} active={activeSession}
      history={legacyPages} stats={numericStats} onSettings={ctx.openSettings} entries={entries}
      onStart={() => { if (isCurrent() && ctx.activePlan) { setSelectedPlan(ctx.activePlan.id); setTab('workout'); } }}
      onResume={(x) => void resume(x)} onCreatePlan={ctx.openPlans} />;
  } else if (tab === 'workout') {
    screen = <WorkoutStartScreen appMode={appMode} plans={ctx.plans} exercises={exercises} active={activeRemote}
      selectedId={selectedPlan} start={start} onSelect={id => { if (isCurrent()) setSelectedPlan(id); }}
      onStart={startPlan} onRetryStart={retryStart} onResume={(x) => void resume(x)} onOpenPlans={ctx.openPlans} onRetryLoad={() => void loadHistory()} />;
  } else if (route.name === 'history') {
    screen = <HistoryScreen appMode={appMode} pages={legacyPages} more={more} loadUnit={loadUnit} onBack={popProgress}
      onOpen={(id) => openDetail(id, 'History')} onLoadMore={() => void loadMore()} onRefresh={() => void loadHistory()} onStartWorkout={() => setTab('workout')} />;
  } else if (route.name === 'session') {
    screen = <SessionDetailScreen appMode={appMode} session={legacySession} exercises={exercises} loadUnit={loadUnit} backLabel={route.back}
      onBack={popProgress} onResume={(x) => void resume(x)} onRetry={() => { popProgress(); openDetail(route.id, route.back); }} />;
  } else {
    screen = <StatsScreen appMode={appMode} stats={numericStats} history={legacyPages} active={activeSession} exercises={exercises} loadUnit={loadUnit}
      onRefresh={refreshAll} onOpenHistory={() => setProgress((r) => [...r, { name: 'history' }])}
      onOpenSession={(id) => openDetail(id, 'Progress')} onStartWorkout={() => setTab('workout')} />;
  }
  const workoutShown = tab === 'workout' && !!openSession;
  const leave = () => { if (isCurrent()) { activeOwner.current = null; setOpenSession(null); void loadHistory(); } };
  const completedSource = (done: SourceWorkoutSession) => {
    if (!isCurrent()) return;
    activeOwner.current = null; setOpenSession(null); setDetail(ready(done));
    setProgress([{ name: 'stats' }, { name: 'session', id: done.id, back: 'Progress' }]); setTab('progress'); refreshAll();
  };
  const completedLegacy = (done: WorkoutSession) => {
    if (!isCurrent()) return;
    activeOwner.current = null; setOpenSession(null);
    openDetail(done.id, 'Progress'); refreshAll();
  };
  // Queue identity excludes tab, route and renderer: hidden or absent presentation cannot discard command keys.
  return <View style={s.fill}>
    {openSession ? <View style={[s.fill, !workoutShown && s.hidden]} accessibilityElementsHidden={!workoutShown}
      importantForAccessibility={workoutShown ? 'auto' : 'no-hide-descendants'}>
      {isSourceSession(openSession) && port.current
        ? <ActiveSourceWorkout key={`${ctx.sessionGeneration}:${openSession.id}`} ctx={ctx} resources={port.current}
            feedback={feedback}
            initial={openSession} isCurrent={isCurrent} onUnauthenticated={unauthenticated} onChanged={refreshAll} onLeave={leave} onCompleted={completedSource} />
        : !isSourceSession(openSession) ? <ActiveWorkout key={openSession.id} ctx={ctx} initial={openSession} exercises={exercises} loadUnit={loadUnit}
            stats={numericStats.status === 'ready' ? numericStats.value : null} onUnauthenticated={unauthenticated} onChanged={refreshAll}
            onLeave={leave} onCompleted={completedLegacy} /> : null}
    </View> : null}
    {workoutShown ? null : <View style={s.fill}>{screen}</View>}
    <TabBar current={tab} bottomInset={insets.bottom} onSelect={selectTab} register={false} />
  </View>;
}

function ActiveSourceWorkout({ ctx, resources, initial, feedback, isCurrent, onUnauthenticated, onChanged, onLeave, onCompleted }: {
  ctx: HomeSlotContext; resources: SourceTrainingResources; initial: SourceWorkoutSession; isCurrent: () => boolean;
  feedback: TrainingFeedbackControls;
  onUnauthenticated: () => void; onChanged: () => void; onLeave: () => void; onCompleted: (session: SourceWorkoutSession) => void;
}) {
  const workout = useSourceWorkout({ resources, initial, isCurrent, onUnauthenticated, onCompleted, onChanged, restTiming: foregroundRestTiming });
  const owner = useRef({ resources, sessionId: initial.id, expired: false });
  if (owner.current.resources !== resources || owner.current.sessionId !== initial.id) owner.current.expired = true;
  const presentation = useRef({ renderer: ctx.renderSourceTraining, epoch: 0 });
  if (presentation.current.renderer !== ctx.renderSourceTraining) presentation.current = { renderer: ctx.renderSourceTraining, epoch: presentation.current.epoch + 1 };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const unresolved = useRef(false);
  unresolved.current = workout.commands.length > 0 || workout.complete?.state.status === 'unknown' || workout.complete?.state.status === 'pending';
  const epoch = presentation.current.epoch;
  const canPresent = () => alive.current && !owner.current.expired && isCurrent()
    && !!ctx.renderSourceTraining && presentation.current.epoch === epoch;
  const guarded: ReturnType<typeof useSourceWorkout> = { ...workout,
    logSet: set => { if (canPresent()) { unresolved.current = true; workout.logSet(set); } },
    editSet: (set, changes) => { if (canPresent()) { unresolved.current = true; workout.editSet(set, changes); } },
    voidSet: set => { if (canPresent()) { unresolved.current = true; workout.voidSet(set); } },
    retryCommand: key => { if (canPresent()) { unresolved.current = true; workout.retryCommand(key); } },
    reconcile: async () => { if (canPresent()) await workout.reconcile(); },
    finish: async () => { if (canPresent()) { unresolved.current = true; await workout.finish(); } },
    resetFinish: () => { if (canPresent()) workout.resetFinish(); },
    dismissNotice: () => { if (canPresent()) workout.dismissNotice(); },
    startRest: id => canPresent() ? workout.startRest(id) : false,
    pauseRest: () => canPresent() ? workout.pauseRest() : false,
    resumeRest: () => canPresent() ? workout.resumeRest() : false,
    dismissRest: () => canPresent() ? workout.dismissRest() : false,
  };
  return ctx.renderSourceTraining ? ctx.renderSourceTraining({ kind: 'workout', workout: guarded,
    feedback: guardTrainingFeedback(feedback, canPresent),
    onLeave: () => {
      if (canPresent() && !unresolved.current) onLeave();
    },
  }) : <Notice kind="info" text="Source training display is unavailable." />;
}

function ActiveWorkout({ ctx, initial, exercises, loadUnit, stats, onUnauthenticated, onChanged, onLeave, onCompleted }: {
  ctx: HomeSlotContext; initial: WorkoutSession; exercises: Record<string, Exercise>; loadUnit: 'kg' | 'lb'; stats: Stats | null;
  onUnauthenticated: () => void; onChanged: () => void; onLeave: () => void; onCompleted: (session: WorkoutSession) => void;
}) {
  const workout = useWorkout({ resources: ctx.resources, initial, onUnauthenticated, onCompleted, onChanged });
  // Leaving cannot discard a queued command or an unresolved completion key.
  const unresolved = workout.commands.length > 0 || workout.complete?.state.status === 'unknown' || workout.complete?.state.status === 'pending';
  return <WorkoutScreen resources={ctx.resources} appMode={ctx.appMode} workout={workout} exercises={exercises} loadUnit={loadUnit}
    stats={stats} onLeave={unresolved ? () => undefined : onLeave} onOpenCues={(exerciseId) => ctx.openCues(exerciseId, 'Workout')} />;
}

const s = StyleSheet.create({ fill: { flex: 1, backgroundColor: t.color.canvas }, hidden: { display: 'none' } });
