// Club Circuit local demo state: a typed port of the package reducer (screens/b-state.js).
// Pure functions over generated fixtures; no network, no device clock, no persistence.
import { fixtures as FX } from './generatedfixtures';
import { tokens as t } from './generatedtokens';
import type { ScreenId } from '../../types';

export type PageId = ScreenId;
export const PAGES: readonly PageId[] = ['today', 'plan', 'workout', 'coach', 'progress'];
export const ACTIVE_DATE: string = FX.activeDate;
export const PENDING_ID: string = FX.captureFixture.activeSessionId;
export const MOVE_CHOICES: readonly string[] = ['2026-10-01', '2026-10-03']; // Thursday, Saturday (page contract)
const LIMITS = FX.inputDemoConstraints;

export const COPY = {
  coachProposal: "Let's keep the squat, press and row. That gives you 7 planned sets. The hinge and calf raise can stay out of this session.",
  coachExplain: 'The sample shorter plan keeps one squat, one press and one row. It removes two exercises so the session has fewer sets.',
  coachKeepFull: 'Your 35-minute session stays as it is.',
  coachKeepFullApplied: 'A 20-minute plan is applied right now. Use Undo change if you want the 35-minute session back.',
  coachAlreadyShort: 'The 20-minute plan is already applied. You can undo it below.',
  coachFallback: 'This sample can explain the workout or show a 20-minute option. Choose one below.',
};

export type PlanKey = keyof typeof FX.plans;
export type Exercise = (typeof FX.exercises)[number];
export type SetRecord = { id: string; exerciseId: string; setNumber: number; repetitions: number; loadKg: number; confirmed: boolean };
export type Session = { id: string; date: string; name: string; planKey: string; plannedSetCount: number; status: string; confirmedSets: SetRecord[] };
export type Field = 'reps' | 'kg';
export type Tone = 'plain' | 'current' | 'recorded' | 'attention' | 'error';
export type StatusText = { tone: Tone; text: string; icon?: 'check' };
export type Turn = { id: string; speaker: 'you' | 'coach'; text: string; proposal?: boolean; prompts?: boolean };
export type Variant = null | 'loading' | 'error' | 'long-text' | 'empty';
export type Sheet =
  | { page: 'plan'; kind: 'move'; choice: string | null }
  | { page: PageId; kind: 'recorded'; sessionId: string }
  | { page: 'workout'; kind: 'finish' }
  | { page: 'coach'; kind: 'plan-review' }
  | { page: 'progress'; kind: 'sessions' };
type Notice = { kind: string; to?: string; id?: string; setNumber?: number } | null;

export type State = {
  screen: PageId;
  planKey: PlanKey;
  planUndo: { planKey: PlanKey } | null;
  schedule: Record<string, { kind: string; sessionId: string | null }>;
  pendingDate: string;
  moveUndo: { from: string; to: string } | null;
  selectedPlanDate: string;
  workout: {
    status: 'ready' | 'active' | 'finished';
    exIndex: number;
    setNumber: number;
    confirmed: SetRecord[];
    draft: Record<Field, string>;
    errors: Record<Field, string | null>;
    cueOpen: boolean;
    justRecordedId: string | null;
    filing: boolean;
  };
  finished: Session | null;
  coach: { status: string; turns: Turn[]; seq: number; composer: string };
  progress: { metric: 'sets' | 'sessions'; week: string; expanded: string | null };
  notice: Record<PageId, Notice>;
  sheet: Sheet | null;
  view: { variant: Variant };
};

export type Action =
  | { type: 'reset' } | { type: 'nav'; to: PageId }
  | { type: 'select-day'; date: string } | { type: 'open-move' } | { type: 'choose-move'; date: string }
  | { type: 'confirm-move' } | { type: 'move-here'; date: string } | { type: 'undo-move' }
  | { type: 'open-recorded'; sessionId: string; page?: PageId }
  | { type: 'start-workout' } | { type: 'step'; field: Field; delta: number } | { type: 'edit'; field: Field; value: string }
  | { type: 'confirm-set' } | { type: 'next' } | { type: 'undo-set' } | { type: 'toggle-cue' } | { type: 'open-finish' }
  | { type: 'finish-keep' } | { type: 'end-without' }
  | { type: 'open-plan-review' } | { type: 'apply-plan' } | { type: 'keep-plan' } | { type: 'undo-plan' }
  | { type: 'composer'; value: string } | { type: 'send'; text?: string } | { type: 'prompt'; kind: 'shorter' | 'explain' | 'full' }
  | { type: 'set-metric'; metric: 'sets' | 'sessions' } | { type: 'select-week'; week: string } | { type: 'open-sessions' }
  | { type: 'toggle-session'; id: string } | { type: 'open-session-detail'; sessionId: string }
  | { type: 'close-sheet' } | { type: 'dismiss-notice'; page: PageId };

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export const exerciseById = (id: string): Exercise => FX.exercises.find((e) => e.id === id) as Exercise;
export type PlanFixture = { name: string; minutes: number; exerciseIds: readonly string[]; plannedSetCount: number };
export const PLANS: Record<PlanKey, PlanFixture> = FX.plans;
export const planOf = (s: State): PlanFixture => PLANS[s.planKey];
export const planExercises = (s: State): Exercise[] => planOf(s).exerciseIds.map(exerciseById);
export const fullExercises = (): Exercise[] => PLANS.full.exerciseIds.map(exerciseById);

// ---- calendar copy for the fixed fixture week (no device locale or clock) ----
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 864e5;
const utc = (date: string) => new Date(date + 'T00:00:00Z');
export const weekdayName = (date: string) => WEEKDAYS[utc(date).getUTCDay()];
export const longDate = (date: string) => {
  const d = utc(date);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
export const possessiveDay = (date: string) => `${weekdayName(date)}'s workout`;
export function weekRange(weekStart: string) {
  const a = utc(weekStart);
  const b = new Date(a.getTime() + 6 * DAY_MS);
  const ma = MONTHS[a.getUTCMonth()], mb = MONTHS[b.getUTCMonth()];
  return `${ma} ${a.getUTCDate()}–${ma === mb ? '' : mb + ' '}${b.getUTCDate()}`;
}
export function weekStartOf(date: string) {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const sets = (n: number) => plural(n, 'set', 'sets');
export const presc = (ex: Exercise) => `${ex.sets} sets of ${ex.targetRepsMin}–${ex.targetRepsMax} reps`;
export const loadText = (kg: number) => `${kg} kg`;
export const setValues = (r: SetRecord) => `${r.repetitions} reps × ${loadText(r.loadKg)}`;

function initialTurns(): Turn[] {
  return [
    { id: 't1', speaker: 'you', text: 'I have 20 minutes today.' },
    { id: 't2', speaker: 'coach', text: COPY.coachProposal, proposal: true },
  ];
}
const draftFor = (ex: Exercise) => ({ reps: String(ex.proposedReps), kg: String(ex.proposedLoadKg) });

export function initialState(screen: PageId = 'today'): State {
  const schedule: State['schedule'] = {};
  FX.schedule.forEach((day) => { schedule[day.date] = { kind: day.kind, sessionId: day.sessionId }; });
  return {
    screen,
    planKey: FX.initialState.pendingPlanKey as PlanKey,
    planUndo: null,
    schedule,
    pendingDate: ACTIVE_DATE,
    moveUndo: null,
    selectedPlanDate: FX.initialState.selectedPlanDate,
    workout: { status: 'ready', exIndex: 0, setNumber: 1, confirmed: [], draft: draftFor(exerciseById(FX.plans.full.exerciseIds[0])),
      errors: { reps: null, kg: null }, cueOpen: false, justRecordedId: null, filing: false },
    finished: null,
    coach: { status: FX.initialState.coachState, turns: initialTurns(), seq: 2, composer: '' },
    progress: { metric: FX.initialState.progressMetric as 'sets', week: FX.initialState.selectedProgressWeek, expanded: null },
    notice: { today: null, plan: null, workout: null, coach: null, progress: null },
    sheet: null,
    view: { variant: null },
  };
}

// ---- selectors ----
export const confirmedCount = (s: State) => s.workout.confirmed.length;
export const hasActiveRecords = (s: State) => s.workout.status === 'active' && confirmedCount(s) > 0;
export const planLocked = (s: State) => hasActiveRecords(s) || s.finished !== null;
export const currentExercise = (s: State) => planExercises(s)[s.workout.exIndex];
const recordId = (exerciseId: string, setNumber: number) => `${PENDING_ID}:${exerciseId}:${setNumber}`;
export const isConfirmed = (s: State, exerciseId: string, setNumber: number) =>
  s.workout.confirmed.some((r) => r.id === recordId(exerciseId, setNumber));
export const recordsFor = (s: State, exerciseId: string) => s.workout.confirmed.filter((r) => r.exerciseId === exerciseId);

export type Board =
  | { kind: 'empty' }
  | { kind: 'planned' | 'short-plan' | 'in-progress' | 'recorded'; label: string; title: string; minutes: number; exercises: number; planned: number; count: number };
export function todayBoard(s: State): Board {
  const p = planOf(s);
  const base = { title: p.name, minutes: p.minutes, exercises: p.exerciseIds.length, planned: p.plannedSetCount };
  if (s.finished) {
    const partial = s.finished.status === 'partial';
    return { ...base, kind: 'recorded', label: partial ? 'Partial workout recorded' : 'Workout recorded', count: s.finished.confirmedSets.length };
  }
  if (s.workout.status === 'active') return { ...base, kind: 'in-progress', label: 'Workout in progress', count: confirmedCount(s) };
  if (s.pendingDate !== ACTIVE_DATE) return { kind: 'empty' };
  return { ...base, kind: s.planKey === 'short' ? 'short-plan' : 'planned', label: 'Your next workout', count: 0 };
}

export type DayInfo = {
  date: string; day: string; dateLabel: string; longDay: string; longDate: string; kind: string; sessionId: string | null;
  isToday: boolean; title: string; fact: string | null; status: StatusText; pending?: boolean;
};
export function allSessions(s: State): Session[] {
  const list = clone(FX.recordedSessions) as unknown as Session[];
  if (s.finished) list.push(s.finished);
  return list;
}
export const sessionById = (s: State, id: string | null) => allSessions(s).find((x) => x.id === id) ?? null;
export const sessionsForWeek = (s: State, weekStart: string) => allSessions(s).filter((x) => weekStartOf(x.date) === weekStart);

export function dayInfo(s: State, date: string): DayInfo {
  const entry = s.schedule[date];
  const fx = FX.schedule.find((d) => d.date === date)!;
  const info: DayInfo = { date, day: fx.dayLabel, dateLabel: fx.dateLabel, longDay: weekdayName(date), longDate: longDate(date),
    kind: entry.kind, sessionId: entry.sessionId, isToday: date === ACTIVE_DATE, title: '', fact: null, status: { tone: 'plain', text: '' } };
  const p = planOf(s);
  if (entry.kind === 'rest') {
    info.title = 'Rest day'; info.status = { tone: 'plain', text: 'Rest day' };
  } else if (entry.kind === 'recorded') {
    const rec = sessionById(s, entry.sessionId)!;
    info.title = rec.name; info.fact = sets(rec.confirmedSets.length) + ' recorded';
    info.status = { tone: 'recorded', text: rec.status === 'partial' ? 'Partial' : 'Recorded', icon: 'check' };
  } else if (entry.sessionId === PENDING_ID) {
    info.title = p.name; info.fact = `${p.minutes} min`;
    info.status = s.workout.status === 'active' ? { tone: 'attention', text: 'In progress' }
      : date === ACTIVE_DATE ? { tone: 'current', text: 'Today' } : { tone: 'plain', text: 'Planned' };
    info.pending = true;
  } else {
    info.title = FX.plans.full.name; info.fact = `${FX.plans.full.minutes} min`; info.status = { tone: 'plain', text: 'Planned' };
  }
  return info;
}
export const weekDays = (s: State) => FX.schedule.map((d) => dayInfo(s, d.date));
export const trainingDays = (s: State) => weekDays(s).filter((d) => d.kind !== 'rest');
export function weekSummaryText(s: State) {
  const days = trainingDays(s);
  return `${days.filter((d) => d.kind === 'recorded').length} of ${days.length} planned sessions recorded.`;
}
export function weeklySummary(s: State) {
  return FX.weeklySummary.map((w) => {
    const extra = !!s.finished && weekStartOf(s.finished.date) === w.weekStart;
    return { weekStart: w.weekStart, label: w.label, sets: w.sets + (extra ? s.finished!.confirmedSets.length : 0), sessions: w.sessions + (extra ? 1 : 0) };
  });
}
export type Week = ReturnType<typeof weeklySummary>[number];
export const chartMax = (metric: 'sets' | 'sessions') => (metric === 'sets' ? t.dataVisual.setMax : t.dataVisual.sessionMax);

export type Primary = { action: 'start-workout' | 'nav-today' | 'confirm-set' | 'next' | 'open-finish'; label: string; id: string };
export function workoutPrimary(s: State): Primary {
  const w = s.workout;
  if (w.status === 'ready') return { action: 'start-workout', label: 'Start workout', id: 'b.workout.start-workout' };
  if (w.status === 'finished') return { action: 'nav-today', label: 'Back to Today', id: 'b.workout.back-today' };
  const exs = planExercises(s), ex = exs[w.exIndex];
  if (!isConfirmed(s, ex.id, w.setNumber)) return { action: 'confirm-set', label: 'Confirm set', id: 'b.workout.confirm-set' };
  if (w.setNumber < ex.sets) return { action: 'next', label: 'Next set', id: 'b.workout.next-set' };
  if (w.exIndex < exs.length - 1) return { action: 'next', label: 'Next exercise', id: 'b.workout.next-set' };
  return { action: 'open-finish', label: 'Review workout', id: 'b.workout.review-workout' };
}

// ---- validation: demo input limits, not training advice ----
export function validate(draft: Record<Field, string>) {
  const errors: Record<Field, string | null> = { reps: null, kg: null };
  const reps = String(draft.reps).trim();
  if (!/^\d+$/.test(reps) || +reps < LIMITS.repMinimum || +reps > LIMITS.repMaximum) errors.reps = `Enter ${LIMITS.repMinimum}–${LIMITS.repMaximum} repetitions.`;
  const kg = String(draft.kg).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(kg) || +kg < LIMITS.weightKgMinimum || +kg > LIMITS.weightKgMaximum) errors.kg = `Enter a weight from ${LIMITS.weightKgMinimum} to ${LIMITS.weightKgMaximum} kg.`;
  return { ok: !errors.reps && !errors.kg, errors, reps: +reps, kg: +kg };
}
const stepBounds = (field: Field) => (field === 'reps' ? [0, LIMITS.repMaximum] : [LIMITS.weightKgMinimum, LIMITS.weightKgMaximum]);
export function canStep(s: State, field: Field, delta: number) {
  const n = parseFloat(String(s.workout.draft[field]).trim().replace(',', '.'));
  const [lo, hi] = stepBounds(field);
  if (Number.isNaN(n)) return delta > 0;
  return delta < 0 ? n - 1 >= lo : n + 1 <= hi;
}

// ---- reducer ----
function freshWorkout(s: State): State['workout'] {
  return { status: 'ready', exIndex: 0, setNumber: 1, confirmed: [], draft: draftFor(planExercises(s)[0]),
    errors: { reps: null, kg: null }, cueOpen: false, justRecordedId: null, filing: false };
}
function addTurn(s: State, speaker: Turn['speaker'], text: string, extra?: Partial<Turn>) {
  s.coach.seq += 1;
  s.coach.turns.push({ id: 't' + s.coach.seq, speaker, text, ...extra });
}
function coachReply(s: State, kind: string) {
  if (kind === 'shorter') {
    if (s.planKey === 'short') addTurn(s, 'coach', COPY.coachAlreadyShort);
    else addTurn(s, 'coach', COPY.coachProposal, { proposal: true });
    if (s.coach.status !== 'applied') s.coach.status = 'proposed';
  } else if (kind === 'explain') addTurn(s, 'coach', COPY.coachExplain);
  else if (kind === 'full') addTurn(s, 'coach', s.planKey === 'short' ? COPY.coachKeepFullApplied : COPY.coachKeepFull);
  else addTurn(s, 'coach', COPY.coachFallback, { prompts: true });
}
function classify(text: string) {
  if (/\b(20|twenty|shorter|short|quick|less time|minutes?)\b/i.test(text)) return 'shorter';
  if (/\b(why|explain|these exercises)\b/i.test(text)) return 'explain';
  if (/\b(full session|keep the full|35)\b/i.test(text)) return 'full';
  return 'other';
}
function doMove(s: State, to: string) {
  const from = s.pendingDate;
  if (to === from || !MOVE_CHOICES.includes(to) || s.schedule[to].kind !== 'rest') return;
  s.moveUndo = { from, to };
  s.schedule[from] = { kind: 'rest', sessionId: null };
  s.schedule[to] = { kind: 'planned', sessionId: PENDING_ID };
  s.pendingDate = to; s.selectedPlanDate = to; s.sheet = null;
  s.notice.plan = { kind: 'moved', to };
}

export function reducer(prev: State, action: Action): State {
  const s = clone(prev);
  const w = s.workout;
  w.filing = false;
  switch (action.type) {
    case 'reset': return initialState(prev.screen);
    case 'nav':
      s.screen = action.to;
      if (s.sheet && s.sheet.page !== action.to) s.sheet = null;
      s.view = { variant: null };
      return s;

    case 'select-day': s.selectedPlanDate = action.date; s.notice.plan = null; return s;
    case 'open-move':
      if (planLocked(s)) { s.notice.plan = { kind: 'move-blocked' }; return s; }
      s.sheet = { page: 'plan', kind: 'move', choice: null }; return s;
    case 'choose-move': if (s.sheet?.kind === 'move') s.sheet.choice = action.date; return s;
    case 'confirm-move':
      if (s.sheet?.kind !== 'move' || !s.sheet.choice || planLocked(s)) return prev;
      doMove(s, s.sheet.choice); return s;
    case 'move-here':
      if (planLocked(s) || s.pendingDate !== ACTIVE_DATE) return prev;
      doMove(s, action.date); return s;
    case 'undo-move':
      if (!s.moveUndo || planLocked(s)) return prev;
      s.schedule[s.moveUndo.to] = { kind: 'rest', sessionId: null };
      s.schedule[s.moveUndo.from] = { kind: 'planned', sessionId: PENDING_ID };
      s.pendingDate = s.moveUndo.from; s.selectedPlanDate = s.moveUndo.from;
      s.moveUndo = null; s.notice.plan = { kind: 'move-undone' }; return s;
    case 'open-recorded': s.sheet = { page: action.page ?? 'plan', kind: 'recorded', sessionId: action.sessionId }; return s;

    case 'start-workout':
      if (w.status !== 'ready') return prev;
      s.workout = { ...freshWorkout(s), status: 'active' }; s.notice.workout = null; return s;
    case 'step': {
      if (w.status !== 'active' || !canStep(s, action.field, action.delta)) return prev;
      let n = parseFloat(String(w.draft[action.field]).trim().replace(',', '.'));
      n = Number.isNaN(n) ? (action.delta > 0 ? 1 : 0) : n + action.delta;
      w.draft[action.field] = String(Math.round(n * 10) / 10);
      w.errors[action.field] = null; return s;
    }
    case 'edit': w.draft[action.field] = action.value; w.errors[action.field] = null; return s;
    case 'confirm-set': {
      if (w.status !== 'active') return prev;
      const ex = currentExercise(s);
      if (isConfirmed(s, ex.id, w.setNumber)) return prev; // duplicate confirmation is a no-op
      const v = validate(w.draft);
      if (!v.ok) { w.errors = v.errors; return s; }
      const rec: SetRecord = { id: recordId(ex.id, w.setNumber), exerciseId: ex.id, setNumber: w.setNumber, repetitions: v.reps, loadKg: v.kg, confirmed: true };
      w.confirmed.push(rec); w.justRecordedId = rec.id; w.errors = { reps: null, kg: null };
      s.notice.workout = { kind: 'set-recorded', id: rec.id }; return s;
    }
    case 'next': {
      if (w.status !== 'active') return prev;
      const exs = planExercises(s), cur = exs[w.exIndex];
      if (!isConfirmed(s, cur.id, w.setNumber)) return prev;
      if (w.setNumber < cur.sets) { w.setNumber += 1; w.draft = draftFor(cur); }
      else if (w.exIndex < exs.length - 1) { w.exIndex += 1; w.setNumber = 1; w.draft = draftFor(exs[w.exIndex]); }
      else { s.sheet = { page: 'workout', kind: 'finish' }; return s; }
      w.justRecordedId = null; w.cueOpen = false; s.notice.workout = null; return s;
    }
    case 'undo-set': {
      if (w.status !== 'active' || !w.confirmed.length) return prev;
      const last = w.confirmed.pop()!;
      w.exIndex = Math.max(0, planExercises(s).findIndex((e) => e.id === last.exerciseId));
      w.setNumber = last.setNumber;
      w.draft = { reps: String(last.repetitions), kg: String(last.loadKg) };
      w.justRecordedId = null;
      s.notice.workout = { kind: 'set-undone', setNumber: last.setNumber }; return s;
    }
    case 'toggle-cue': w.cueOpen = !w.cueOpen; return s;
    case 'open-finish':
      if (w.status !== 'active') return prev;
      s.sheet = { page: 'workout', kind: 'finish' }; return s;
    case 'finish-keep': {
      if (w.status !== 'active' || !w.confirmed.length) return prev;
      const p = planOf(s);
      s.finished = { id: 'session-' + s.pendingDate, date: s.pendingDate, name: p.name, planKey: s.planKey, plannedSetCount: p.plannedSetCount,
        status: w.confirmed.length >= p.plannedSetCount ? 'recorded' : 'partial', confirmedSets: clone(w.confirmed) };
      s.schedule[s.pendingDate] = { kind: 'recorded', sessionId: s.finished.id };
      w.status = 'finished'; w.filing = true; w.justRecordedId = null; s.sheet = null; s.notice.workout = null; return s;
    }
    case 'end-without':
      if (w.status !== 'active' || w.confirmed.length) return prev;
      s.workout = freshWorkout(s); s.sheet = null; return s;

    case 'open-plan-review':
      if (hasActiveRecords(s)) { s.notice.coach = { kind: 'guard' }; return s; }
      if (s.finished) { s.notice.coach = { kind: 'unavailable' }; return s; }
      if (s.planKey === 'short') return prev;
      s.sheet = { page: 'coach', kind: 'plan-review' }; return s;
    case 'apply-plan':
      if (s.planKey === 'short') { s.sheet = null; return s; } // second apply is a no-op
      if (planLocked(s)) { s.sheet = null; s.notice.coach = { kind: 'guard' }; return s; }
      s.planUndo = { planKey: s.planKey }; s.planKey = 'short'; s.coach.status = 'applied';
      if (w.status === 'active') { w.exIndex = 0; w.setNumber = 1; w.draft = draftFor(planExercises(s)[0]); }
      s.sheet = null; s.notice.coach = { kind: 'applied' }; return s;
    case 'keep-plan': s.sheet = null; return s;
    case 'undo-plan':
      if (!s.planUndo) return prev;
      if (planLocked(s)) { s.notice.coach = { kind: 'guard' }; return s; }
      s.planKey = s.planUndo.planKey; s.planUndo = null; s.coach.status = 'undone';
      s.notice.coach = { kind: 'undone' }; return s;
    case 'composer': s.coach.composer = action.value; return s;
    case 'send': {
      const text = String(action.text ?? s.coach.composer).trim();
      if (!text) return prev; // whitespace-only cannot send
      addTurn(s, 'you', text); coachReply(s, classify(text)); s.coach.composer = ''; return s;
    }
    case 'prompt': {
      const said = { shorter: 'I have 20 minutes today.', explain: 'Why these exercises?', full: 'Keep the full session.' }[action.kind];
      addTurn(s, 'you', said); coachReply(s, action.kind); return s;
    }

    case 'set-metric': s.progress.metric = action.metric; return s;
    case 'select-week': s.progress.week = action.week; s.progress.expanded = null; return s;
    case 'open-sessions': s.sheet = { page: 'progress', kind: 'sessions' }; return s;
    case 'toggle-session': s.progress.expanded = s.progress.expanded === action.id ? null : action.id; return s;
    case 'open-session-detail': {
      const sess = sessionById(s, action.sessionId);
      if (!sess) return prev;
      s.progress.week = weekStartOf(sess.date); s.progress.expanded = sess.id;
      s.sheet = { page: 'progress', kind: 'sessions' }; return s;
    }
    case 'close-sheet': s.sheet = null; return s;
    case 'dismiss-notice': s.notice[action.page] = null; return s;
    default: return prev;
  }
}

export function captureWorkout(state: State): State {
  // Explicit, disclosed screenshot fixture: squat set 1 confirmed, set 2 in the editor.
  const cf = FX.captureFixture;
  const s = clone(state);
  s.workout.status = 'active'; s.workout.exIndex = 0; s.workout.setNumber = cf.currentSetNumber;
  s.workout.confirmed = clone(cf.confirmedCurrentSets) as unknown as SetRecord[];
  s.workout.draft = { reps: cf.draft.repetitions, kg: cf.draft.loadKg };
  return s;
}
function completeAll(state: State) {
  let s = reducer(state, { type: 'start-workout' });
  for (let guard = 0; s.workout.status === 'active' && !s.sheet && guard < 40; guard++) {
    s = reducer(s, { type: 'confirm-set' });
    s = reducer(s, { type: 'next' });
  }
  return { ...s, sheet: null };
}

type Step = Action | 'capture' | 'complete-all' | `view:${Exclude<Variant, null>}`;
export const PRESETS: Record<PageId, Record<string, Step[]>> = {
  today: {
    default: [], 'short-plan': [{ type: 'apply-plan' }], 'in-progress': ['capture'],
    recorded: ['capture', { type: 'confirm-set' }, { type: 'finish-keep' }], empty: [{ type: 'move-here', date: '2026-10-01' }],
    'loading-example': ['view:loading'], 'error-example': ['view:error'], 'long-text': ['view:long-text'],
  },
  plan: {
    default: [], 'selected-rest': [{ type: 'select-day', date: '2026-09-29' }], 'move-sheet': [{ type: 'open-move' }],
    'move-sheet-chosen': [{ type: 'open-move' }, { type: 'choose-move', date: '2026-10-01' }],
    moved: [{ type: 'open-move' }, { type: 'choose-move', date: '2026-10-01' }, { type: 'confirm-move' }],
    'move-blocked': ['capture', { type: 'open-move' }],
    'recorded-detail': [{ type: 'select-day', date: '2026-09-28' }, { type: 'open-recorded', sessionId: 'recorded-2026-09-28' }],
    'loading-example': ['view:loading'], 'error-example': ['view:error'], 'long-text': ['view:long-text'],
  },
  workout: {
    default: ['capture'], ready: [], active: ['capture'], 'set-recorded': ['capture', { type: 'confirm-set' }],
    'invalid-values': ['capture', { type: 'edit', field: 'reps', value: '0' }, { type: 'confirm-set' }],
    'finish-review': ['capture', { type: 'confirm-set' }, { type: 'open-finish' }],
    'empty-finish-review': [{ type: 'start-workout' }, { type: 'open-finish' }],
    'partial-summary': ['capture', { type: 'confirm-set' }, { type: 'finish-keep' }],
    'recorded-summary': ['complete-all', { type: 'finish-keep' }], 'cue-expanded': ['capture', { type: 'toggle-cue' }],
    'short-plan-ready': [{ type: 'apply-plan' }], 'loading-example': ['view:loading'],
    'error-example': ['capture', 'view:error'], 'long-text': ['capture', 'view:long-text'],
  },
  coach: {
    default: [], review: [{ type: 'open-plan-review' }], applied: [{ type: 'open-plan-review' }, { type: 'apply-plan' }],
    undone: [{ type: 'apply-plan' }, { type: 'undo-plan' }], 'active-workout-guard': ['capture', { type: 'open-plan-review' }],
    explain: [{ type: 'prompt', kind: 'explain' }], 'fallback-reply': [{ type: 'send', text: 'Can I use the rowing machine instead?' }],
    'long-message': ['view:long-text'], 'empty-conversation': ['view:empty'],
    'loading-example': ['view:loading'], 'error-example': ['view:error'],
  },
  progress: {
    default: [], 'sessions-metric': [{ type: 'set-metric', metric: 'sessions' }], 'previous-week': [{ type: 'select-week', week: '2026-09-21' }],
    'session-detail': [{ type: 'open-sessions' }, { type: 'toggle-session', id: 'recorded-2026-09-28' }],
    'after-partial-workout': ['capture', { type: 'confirm-set' }, { type: 'finish-keep' }], 'empty-week': ['view:empty'],
    'loading-example': ['view:loading'], 'error-example': ['view:error'], 'long-text': ['view:long-text'],
  },
};

/** Declared state → deterministic state built from the fixture through real actions; null when undeclared. */
export function preset(page: PageId, stateId: string): State | null {
  const steps = PRESETS[page]?.[stateId];
  if (!steps) return null;
  let s = initialState(page);
  for (const step of steps) {
    if (step === 'capture') s = captureWorkout(s);
    else if (step === 'complete-all') s = completeAll(s);
    else if (typeof step === 'string') s = { ...s, view: { variant: step.slice(5) as Variant } };
    else s = reducer(s, step);
  }
  return { ...s, screen: page, workout: { ...s.workout, filing: false } };
}

/** Gallery launch: an explicit declared state is a preset; no state opens the fresh local fixture. */
export function launchState(screen: PageId, stateId?: string): State {
  return (stateId ? preset(screen, stateId) : null) ?? initialState(screen);
}
