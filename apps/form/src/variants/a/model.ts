// Open Mat local demo model. Mirrors design/form2-three-directions/a/v2/app/app.js behaviour:
// fixed fictional fixtures, a canned local "Demo coach", and no backend, account or persistence.
// Only an explicit Confirm set records a set; steppers, rest expiry, Finish and tab switches never do.
import type { ScreenId } from '../../types';
import { COMPOSER_LIMIT, setsOf, type DayId, type HistoryRecord, type Move, type PlanVariant } from './components';
import { fixtures } from './generatedfixtures';

export const MOVES: readonly Move[] = fixtures.moves;

/* Domain rules from handoff.yaml interactions (step-value, field-error, coach-send); not visual values. */
const REPS_STEP = 1;
const KG_STEP = 0.5;
const REPS_RANGE = [1, 99] as const;
const KG_RANGE = [0, 200] as const;
export const MS_PER_SECOND = 1000;
/** app.js rest tick (setInterval 250 ms); the value shown is always recomputed from the stored end time. */
export const REST_TICK_MS = 250;
const SECONDS_PER_MINUTE = 60;
export const COACH_REPLY = 'This demo can explain the workout or preview the 20-minute option. Choose one below.';
export const EXPLAIN_REPLY = 'Squat, press and row keep a lower-body movement, a push and a pull. The shorter option removes hinge and calf raise and two planned sets.';
/** The fixture "resting" reference render freezes the timer at 0:48 (handoff intent_not_in_mockup). */
export const FIXTURE_REST_SECONDS = 48;

export type SheetId = 'adjust' | 'finish' | 'history' | 'list';
export type SessionStatus = 'active' | 'resting' | 'ready-next' | 'complete';
export type Session = { status: SessionStatus; move: number; set: number; restEndsAt: number | null; frozenRest: number | null };
export type Confirmed = { move: number; set: number; reps: number; kg: number };
export type NoticeState = { tab: ScreenId; kind: 'success' | 'info'; text: string; undo: boolean };
export type ChatEntry = { who: 'user' | 'coach'; text: string };
export type DraftError = 'reps' | 'kg' | null;

export type State = {
  tab: ScreenId;
  selectedDay: DayId;
  plan: PlanVariant;
  sheet: SheetId | null;
  sheetFrom: ScreenId | null;
  session: Session | null;
  draft: { reps: number; kg: number; error: DraftError; focus: 'reps' | 'kg' | null };
  confirmed: Confirmed[];
  history: HistoryRecord[];
  progressExpanded: boolean;
  notice: NoticeState | null;
  chat: ChatEntry[];
  composer: string;
  selectedWeek: number;
  firstConfirmAnimated: boolean;
  /** "move:set" whose check draws (first confirmation of a session only); cleared by the next action. */
  drawCheck: string | null;
  emptyHistory: boolean;
  historyOpen: string | null;
};

export function planMoves(variant: PlanVariant): Move[] {
  return MOVES.filter((m) => setsOf(m, variant) > 0);
}

export function planTotals(variant: PlanVariant) {
  const moves = planMoves(variant);
  return { minutes: fixtures.planMinutes[variant], moves: moves.length, sets: moves.reduce((sum, m) => sum + setsOf(m, variant), 0) };
}

export function planTitle(variant: PlanVariant) {
  return variant === 'short' ? 'Full-body strength, short' : 'Full-body strength';
}

/** m:ss from whole seconds (1:00 → 0:00). */
export function clock(seconds: number) {
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`;
}

/** Accessible timer name from the same value as the visible text. */
export function restName(seconds: number) {
  const amount = seconds >= SECONDS_PER_MINUTE ? '1 minute' : seconds === 1 ? '1 second' : `${seconds} seconds`;
  return `${amount} of rest left`;
}

export function secondsLeft(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / MS_PER_SECOND));
}

export function remainingRest(session: Session, now: number): number {
  if (session.restEndsAt === null) return session.frozenRest ?? fixtures.restSeconds;
  return secondsLeft(session.restEndsAt, now);
}

/** One stepper press: reps move by 1, kilograms by 0.5 (handoff step-value). Never records. */
export function stepValue(field: 'reps' | 'kg', value: number, direction: -1 | 1): number {
  return field === 'reps'
    ? Math.round(value + direction * REPS_STEP)
    : Math.round((value + direction * KG_STEP) / KG_STEP) * KG_STEP;
}

export function currentMove(state: State): Move {
  return planMoves(state.plan)[state.session ? state.session.move : 0];
}

/** The current movement's last set is confirmed, so the next thing is the next movement. */
export function movementDone(state: State): boolean {
  const s = state.session;
  if (!s) return false;
  return state.confirmed.some((c) => c.move === s.move && c.set === s.set) && s.set >= setsOf(currentMove(state), state.plan);
}

export function validate(draft: State['draft']): DraftError {
  const { reps, kg } = draft;
  if (!(reps >= REPS_RANGE[0] && reps <= REPS_RANGE[1] && Math.round(reps) === reps)) return 'reps';
  if (!(kg >= KG_RANGE[0] && kg <= KG_RANGE[1] && Math.round(kg / KG_STEP) * KG_STEP === kg)) return 'kg';
  return null;
}

export function weekCounts(history: readonly HistoryRecord[]): number[] {
  const counts = fixtures.weeks.map(() => 0);
  for (const record of history) counts[record.week] += 1;
  return counts;
}

function newSession(): Session {
  return { status: 'active', move: 0, set: 1, restEndsAt: null, frozenRest: null };
}

export function initialState(): State {
  const first = MOVES[0];
  return {
    tab: 'today',
    selectedDay: 'wed',
    plan: 'full',
    sheet: null,
    sheetFrom: null,
    session: null,
    draft: { reps: first.defReps, kg: first.kg, error: null, focus: null },
    confirmed: [],
    history: fixtures.history.map((h) => ({ ...h })),
    progressExpanded: false,
    notice: null,
    chat: [],
    composer: '',
    selectedWeek: fixtures.thisWeek,
    firstConfirmAnimated: false,
    drawCheck: null,
    emptyHistory: false,
    historyOpen: null,
  };
}

/** Declared fixture states (handoff screens[].states). Unknown states fall back to the screen default. */
export const FIXTURE_STATES: Record<ScreenId, readonly string[]> = {
  today: ['default'],
  plan: ['default', 'rest-day', 'changed'],
  workout: ['default', 'field-error', 'resting', 'finish-review'],
  coach: ['default', 'review', 'applied'],
  progress: ['default', 'empty'],
};

export function launchState(screen: ScreenId, fixture?: string): State {
  const s = initialState();
  s.tab = screen;
  const state = fixture && FIXTURE_STATES[screen].includes(fixture) ? fixture : 'default';
  const first = MOVES[0];
  if (screen === 'plan' && state === 'rest-day') s.selectedDay = 'thu';
  if (screen === 'plan' && state === 'changed') {
    s.plan = 'short';
    s.notice = { tab: 'plan', kind: 'success', text: '20-minute option applied.', undo: true };
  }
  if (screen === 'workout') {
    // The normal initial workout has zero confirmed sets.
    s.session = newSession();
    if (state === 'field-error') s.draft = { ...s.draft, reps: 0, error: 'reps', focus: 'reps' };
    if (state === 'resting') {
      s.confirmed = [{ move: 0, set: 1, reps: first.defReps, kg: first.kg }];
      s.session = { status: 'resting', move: 0, set: 2, restEndsAt: null, frozenRest: FIXTURE_REST_SECONDS };
    }
    if (state === 'finish-review') {
      s.confirmed = [{ move: 0, set: 1, reps: first.defReps, kg: first.kg }, { move: 0, set: 2, reps: first.defReps, kg: first.kg }];
      s.session = { status: 'active', move: 0, set: 3, restEndsAt: null, frozenRest: null };
      s.sheet = 'finish';
    }
  }
  if (screen === 'coach' && state === 'review') { s.sheet = 'adjust'; s.sheetFrom = 'coach'; }
  if (screen === 'coach' && state === 'applied') {
    s.plan = 'short';
    s.notice = { tab: 'coach', kind: 'success', text: '20-minute option applied to today.', undo: true };
  }
  if (screen === 'progress' && state === 'empty') { s.history = []; s.emptyHistory = true; }
  return s;
}

export type Action =
  | { type: 'tab'; to: ScreenId }
  | { type: 'go'; to: ScreenId }
  | { type: 'select-day'; id: DayId }
  | { type: 'today-day'; id: DayId }
  | { type: 'open-adjust'; from: ScreenId }
  | { type: 'close-sheet' }
  | { type: 'apply-short' }
  | { type: 'undo-short' }
  | { type: 'start-workout' }
  | { type: 'step'; field: 'reps' | 'kg'; direction: -1 | 1 }
  | { type: 'confirm-set'; now: number }
  | { type: 'end-rest' }
  | { type: 'next-set' }
  | { type: 'open-sheet'; sheet: 'finish' | 'list' }
  | { type: 'open-history'; id: string }
  | { type: 'save' }
  | { type: 'end-without-recording' }
  | { type: 'coach-explain' }
  | { type: 'composer'; text: string }
  | { type: 'coach-send' }
  | { type: 'select-week'; week: number }
  | { type: 'toggle-history' };

/** HTML go(): switch root and close any sheet. Viewing Workout opens the session (0 confirmed sets). */
function go(s: State, to: ScreenId): State {
  return { ...s, tab: to, sheet: null, session: to === 'workout' && !s.session ? newSession() : s.session };
}

/** Pure transition. Returns the same object for a no-op so callers can skip feedback and renders. */
export function reducer(prev: State, action: Action): State {
  const s: State = action.type === 'confirm-set' || prev.drawCheck === null ? prev : { ...prev, drawCheck: null };
  switch (action.type) {
    case 'tab':
      return go({ ...s, notice: null }, action.to);
    case 'go':
      return go(s, action.to);
    case 'select-day':
      return s.selectedDay === action.id ? s : { ...s, selectedDay: action.id };
    case 'today-day':
      return go({ ...s, selectedDay: action.id }, 'plan');
    case 'open-adjust':
      return { ...s, sheet: 'adjust', sheetFrom: action.from };
    case 'close-sheet':
      return s.sheet === null ? s : { ...s, sheet: null };
    case 'apply-short': {
      // Idempotent: applying again leaves plan short and the same notice.
      if (s.session) return s;
      const from = s.sheetFrom ?? s.tab;
      return {
        ...s, plan: 'short', sheet: null,
        notice: { tab: from, kind: 'success', text: from === 'coach' ? '20-minute option applied to today.' : '20-minute option applied.', undo: true },
      };
    }
    case 'undo-short':
      if (s.session) {
        return { ...s, notice: { tab: s.tab, kind: 'info', text: 'Undo isn’t available after the workout starts. Finish or save it first.', undo: false } };
      }
      return { ...s, plan: 'full', notice: { tab: s.tab, kind: 'success', text: '35-minute workout restored.', undo: false } };
    case 'start-workout':
      return go({ ...s, session: s.session ?? newSession() }, 'workout');
    case 'step': {
      const value = stepValue(action.field, s.draft[action.field], action.direction);
      const draft = action.field === 'reps' ? { ...s.draft, reps: value } : { ...s.draft, kg: value };
      return { ...s, draft: { ...draft, error: validate(draft) } };
    }
    case 'confirm-set': {
      const session = s.session;
      if (!session || session.status !== 'active' || validate(s.draft)) return s;
      // Idempotent per session/movement/set key: a second tap is a no-op.
      if (s.confirmed.some((c) => c.move === session.move && c.set === session.set)) return s;
      const confirmed = [...s.confirmed, { move: session.move, set: session.set, reps: s.draft.reps, kg: s.draft.kg }];
      const key = `${session.move}:${session.set}`;
      const first = !s.firstConfirmAnimated;
      const base = { ...s, confirmed, firstConfirmAnimated: true, drawCheck: first ? key : null };
      const move = planMoves(s.plan)[session.move];
      const total = setsOf(move, s.plan);
      if (session.set >= total && session.move >= planMoves(s.plan).length - 1) {
        return { ...base, session: { ...session, status: 'complete' } };
      }
      return {
        ...base,
        session: {
          ...session,
          set: session.set < total ? session.set + 1 : session.set,
          status: 'resting',
          restEndsAt: action.now + fixtures.restSeconds * MS_PER_SECOND,
          frozenRest: null,
        },
      };
    }
    case 'end-rest':
      if (!s.session || s.session.status !== 'resting') return s;
      return { ...s, session: { ...s.session, status: 'ready-next', restEndsAt: null, frozenRest: null } };
    case 'next-set': {
      if (!s.session || s.session.status !== 'ready-next') return s;
      if (movementDone(s)) {
        const next = planMoves(s.plan)[s.session.move + 1];
        return {
          ...s,
          session: { ...s.session, move: s.session.move + 1, set: 1, status: 'active' },
          draft: { reps: next.defReps, kg: next.kg, error: null, focus: null },
        };
      }
      return { ...s, session: { ...s.session, status: 'active' }, draft: { ...s.draft, error: null } };
    }
    case 'open-sheet':
      return { ...s, sheet: action.sheet };
    case 'open-history':
      return { ...s, sheet: 'history', historyOpen: action.id };
    case 'save': {
      const n = s.confirmed.length;
      if (n === 0) return s;
      // Saved record copy follows the fixture (app.js saveRecorded): Wed, Oct 7, 18 min, this week.
      const record: HistoryRecord = {
        id: `w${s.history.length + 9}`, day: 'Wed, Oct 7', min: 18, sets: n, week: fixtures.thisWeek,
        partial: n < planTotals(s.plan).sets,
      };
      return go({
        ...s, history: [record, ...s.history], confirmed: [], session: null, firstConfirmAnimated: false,
        notice: { tab: 'progress', kind: 'success', text: 'Workout saved.', undo: false },
      }, 'progress');
    }
    case 'end-without-recording':
      return go({ ...s, session: null, firstConfirmAnimated: false, confirmed: [] }, 'today');
    case 'coach-explain':
      return { ...s, chat: [...s.chat, { who: 'user', text: 'Why these movements?' }, { who: 'coach', text: EXPLAIN_REPLY }] };
    case 'composer':
      return { ...s, composer: action.text };
    case 'coach-send': {
      const text = s.composer;
      if (text.trim() === '' || text.length > COMPOSER_LIMIT) return s;
      return { ...s, composer: '', chat: [...s.chat, { who: 'user', text }, { who: 'coach', text: COACH_REPLY }] };
    }
    case 'select-week':
      return s.selectedWeek === action.week ? s : { ...s, selectedWeek: action.week };
    case 'toggle-history':
      return { ...s, progressExpanded: !s.progressExpanded };
    default:
      return s;
  }
}
