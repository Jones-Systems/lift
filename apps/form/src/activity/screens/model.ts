// Activity screens: pure presentation model (no React, no network, no storage).
// Mirrors docs/workstreams/form-accounts-onboarding/continuation/activity/ui/design/v1 (DRAFT) and its
// copy.md. It formats authoritative Activity data for display only: it never computes adherence, streaks,
// calendars or parser results (those come from ActivityResources and ../drafts). Production screens built on
// this model wait for a READY design package.
import type { AppMode } from '../../api/domain';
import type {
  ActivityCalendar, ActivityCapabilities, ActivityPlanTarget, Adherence, AdherenceDay, DayExpectation, Distance, Load,
  Pace, ScheduleRevision, Speed,
} from '../contracts';
import type { DraftPhase } from '../drafts/controller';
import { addCivilDays, parseCivilDate } from '../drafts/dates';
import type { DraftLoad } from '../drafts/model';

/* ---------------- copy (design/v1/copy.md) ---------------- */

export const ACTIVITY_COPY = {
  streakUnit: 'plan days in a row',
  streakStarting: 'Your streak starts when you set a weekly plan.',
  rulesTitle: 'How plan days work',
  rules: [
    'A plan day counts when you do what your plan says: a workout, an exercise snack or rest.',
    'Extra exercise on a rest day is always welcome. It never counts against you.',
    'Each calendar month, one missed workout or snack day can keep your streak going. Form uses it on the first missed day that month. It doesn’t carry over.',
    'A day kept this way isn’t counted as done. It just keeps your count going.',
  ],
  privacy: 'Your activity is private. Groups see only what you choose to share there.',
  dayRest: 'Rest day. Counts toward your streak.',
  dayRestExtra: 'Extra activity on a rest day is welcome. It never counts against you.',
  dayMissed: 'Nothing was logged for this planned day.',
  dayUnknown: 'There was no weekly plan yet, so this day doesn’t count either way.',
  dayFuture: 'You can log activity once the day arrives. To change what’s planned, edit your weekly plan.',
  loadEnter: 'Enter weight',
  loadNone: 'No added weight',
  loadUnknown: 'I don’t remember',
  loadUnknownSaved: 'Weight not remembered',
  repsAbsent: 'Not recorded',
  customUnassessed: 'Form hasn’t reviewed this exercise, so it comes without cues or safety guidance.',
  retireExplain: 'It stays in your past logs and plans. You won’t be able to pick it for new ones.',
  zoneFixed: 'Your days are counted in this time zone, even when you travel. You can’t change it later in this version of Form.',
  scheduleProspective: 'Changes start on the day you choose. Past days keep the plan they had.',
  correctDay: 'This changes one past day only. The original plan stays in your history.',
  voiceNothingSaved: 'Nothing is saved until you tap Save activity.',
  voiceTranscriptLocal: 'What you said stays on this iPhone and is cleared when you leave.',
  dateConflictTitle: 'Which day was this?',
  savedEdit: 'Changes saved.',
  savedVoid: 'Removed. Your streak has been recounted.',
  unknownSave: 'We couldn’t confirm this was saved. Try again. It won’t be saved twice.',
  stale: 'This changed on another device. We’ve loaded the latest, so check it and save again.',
  duplicateDraft: 'This log was already saved with different details. Check your activity for this day before saving again.',
  itemIdentity: 'That exercise changed. Remove it and add the new one instead.',
  futureDate: 'You can’t log activity for a day that hasn’t happened yet.',
  dateReview: 'Check the day before saving.',
  concealed: 'This isn’t available any more.',
  network: 'Couldn’t reach Form. Check your connection, then try again.',
  listError: 'Your activity didn’t load. Try again. Nothing you logged is affected.',
  offline: 'You’re offline. You can look at what’s loaded, but saving needs a connection.',
  noSchedule: 'No weekly plan yet. Set one to start counting plan days. You can log activity any time.',
  noExercises: 'You haven’t added your own exercises yet. Add one for anything Form’s list doesn’t have.',
  noPlans: 'No Activity plans yet. Make one, or copy one of your Form plans.',
} as const;

export const loadQuestion = (exercise: string) => `What weight did you use for ${exercise}?`;
export const dayOpenText = (zoneName: string) => `Open until midnight, ${zoneName} time.`;
export const savedToText = (date: string) => `Saved to ${formatCivilDate(date)}.`;
export const exerciseRetiredText = (exercise: string) => `${exercise} is retired. Pick another exercise.`;
export const dateConflictText = (selected: string, phrase: string, spoken: string) =>
  `You picked ${formatCivilDate(selected)}, but said “${phrase}”, which is ${formatCivilDate(spoken)}.`;
export const unsupportedText = (fragment: string) => `We couldn’t use this part: “${fragment}”. Add it by hand or leave it out.`;
export const importedPlanText = (name: string, revision: number, copiedOn: string) =>
  `Copied from your Form plan “${name}”, version ${revision}, on ${formatCivilDate(copiedOn)}. Changes there won’t change this plan.`;
export const coverageText = (coverageStart: string) =>
  `Counting started ${formatCivilDate(coverageStart)}, when you set your weekly plan. Days before that don’t count either way.`;

/* ---------------- civil dates (display only; arithmetic stays in ../drafts) ---------------- */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Thu, Oct 8" (or "Thu, Oct 8, 2025" outside `currentYear`). Formats the civil date itself; no zone shift. */
export function formatCivilDate(date: string, options: { long?: boolean; currentYear?: number } = {}): string {
  const civil = parseCivilDate(date);
  if (!civil) return date;
  const showYear = options.currentYear !== undefined && civil.year !== options.currentYear;
  return new Intl.DateTimeFormat('en-US', {
    weekday: options.long ? 'long' : 'short', month: options.long ? 'long' : 'short', day: 'numeric',
    ...(showYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(new Date(Date.UTC(civil.year, civil.month - 1, civil.day)));
}

/** "Today, Fri Oct 9" / "Yesterday, Thu Oct 8" / "Wed, Oct 7": relative words only beside the absolute date. */
export function relativeDayLabel(date: string, today: string): string {
  const absolute = formatCivilDate(date);
  if (date === today) return `Today, ${absolute.replace(',', '')}`;
  if (date === addCivilDays(today, -1)) return `Yesterday, ${absolute.replace(',', '')}`;
  return absolute;
}

/** "October" for "2026-10" (the allowance month key in the fixed calendar zone). */
export function monthName(monthKey: string): string {
  const month = Number(monthKey.slice(5, 7));
  return MONTHS[month - 1] ?? monthKey;
}

/** Zone label from an IANA id, e.g. "America/New_York" → "New York". The UI pairs it with "time". */
export function zoneName(timeZone: string): string {
  const city = timeZone.split('/').pop() ?? timeZone;
  return city.replace(/_/g, ' ');
}

/* ---------------- day status (design/v1 DESIGN.md#day-status) ---------------- */

export type DayGlyph = 'check' | 'ring' | 'none' | 'shield-check' | 'minus' | 'circle-question-mark';
export type DayStatusPresentation = { glyph: DayGlyph; words: string; a11ySuffix: string; countsAsDone: boolean };

const EXPECTATION_WORD: Record<DayExpectation, string> = { workout: 'Workout', exerciseSnack: 'Exercise snack', rest: 'Rest day' };

/**
 * Text and glyph for selected evaluator day fields. Callers can pass `day.planDay?.expectation`
 * as context; without it the words stay generic rather than guessed.
 */
export function dayStatus(day: Pick<AdherenceDay, 'localDate' | 'state'>, context: {
  today: string; zone: string; expectation?: DayExpectation; allowanceMonth?: string;
}): DayStatusPresentation {
  const planned = context.expectation && context.expectation !== 'rest' ? `${EXPECTATION_WORD[context.expectation]} planned` : 'Planned';
  switch (day.state) {
    case 'activityRecorded':
      return { glyph: 'check', words: 'Done: activity logged', a11ySuffix: ', activity logged', countsAsDone: true };
    case 'plannedRest':
      return { glyph: 'none', words: ACTIVITY_COPY.dayRest, a11ySuffix: ', rest day', countsAsDone: true };
    case 'pending':
      if (day.localDate > context.today) return { glyph: 'ring', words: planned, a11ySuffix: ', planned', countsAsDone: false };
      if (context.expectation === 'rest') return { glyph: 'none', words: 'Rest day. Counts once the day ends.', a11ySuffix: ', rest day, still open', countsAsDone: false };
      return { glyph: 'ring', words: `${planned}. ${dayOpenText(zoneName(context.zone))}`, a11ySuffix: ', planned, still open', countsAsDone: false };
    case 'protectedMiss': {
      const month = context.allowanceMonth ? `${monthName(context.allowanceMonth)}’s` : 'this month’s';
      return { glyph: 'shield-check', words: `Not logged. Kept by ${month} allowance.`, a11ySuffix: ', not logged, kept by this month’s allowance', countsAsDone: false };
    }
    case 'missed':
      return { glyph: 'minus', words: 'Not logged', a11ySuffix: ', not logged', countsAsDone: false };
    case 'unknownPlan':
      return { glyph: 'circle-question-mark', words: 'No plan for this day', a11ySuffix: ', no plan', countsAsDone: false };
  }
}

/** VoiceOver label for a day button: "Thursday, October 8, rest day". */
export function dayAccessibilityLabel(date: string, status: DayStatusPresentation): string {
  return formatCivilDate(date, { long: true }) + status.a11ySuffix;
}

/* ---------------- streak (counts only what Adherence reports) ---------------- */

export type StreakPresentation =
  | { kind: 'starting'; text: string }
  | { kind: 'restarted'; text: string; allowance: string }
  | { kind: 'counting'; count: number; unit: string; through: string; breakdown: string; longest: string; allowance: string };

export function streakPresentation(adherence: Adherence | null, today: string): StreakPresentation {
  if (!adherence || adherence.coverageStart === null) return { kind: 'starting', text: ACTIVITY_COPY.streakStarting };
  const n = adherence.currentPlanDays;
  const longestDays = `${adherence.longestPlanDays} plan ${adherence.longestPlanDays === 1 ? 'day' : 'days'}`;
  // A reset is stated as the next step, never as a large "0" (copy.md streakRestarted).
  if (n === 0) return { kind: 'restarted', text: `Your next plan day starts a new count. Longest so far: ${longestDays}.`, allowance: allowanceText(adherence.monthlyAllowance) };
  const through = adherence.throughDate === today
    ? `Through ${formatCivilDate(today)}.`
    : `Through ${formatCivilDate(adherence.throughDate)}. Today is still open.`;
  const parts = [`${adherence.satisfiedDaysInCurrentStreak} followed your plan`];
  if (adherence.protectedDaysInCurrentStreak > 0) parts.push(`${adherence.protectedDaysInCurrentStreak} kept by an allowance`);
  return {
    kind: 'counting', count: n, unit: ACTIVITY_COPY.streakUnit, through, breakdown: parts.join(', '),
    longest: `Longest so far: ${longestDays}`,
    allowance: allowanceText(adherence.monthlyAllowance),
  };
}

export function allowanceText(allowance: Adherence['monthlyAllowance']): string {
  const month = monthName(allowance.month);
  if (allowance.protectedDate) return `${month}: used for ${formatCivilDate(allowance.protectedDate)}`;
  return allowance.remaining === 1 ? `${month}: available` : `${month}: not available`;
}

/* ---------------- values as entered (never invented) ---------------- */

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const BASIS_SUFFIX = { total: '', unspecified: '', perImplement: ' each', perSide: ' each side', assistance: ' assistance' } as const;

/**
 * Load as the person reported it. Known 0 stays "0 kg" (unlike features/shared/copy.ts loadText, which renders
 * legacy 0 kg as body weight). Missing returns null: the screen asks the weight question instead.
 */
export function loadText(load: Load | DraftLoad): string | null {
  switch (load.state) {
    case 'missing': return null;
    case 'knownValue': return `${number.format(load.value)} ${load.unit}${BASIS_SUFFIX[load.basis]}`;
    case 'unknown': return ACTIVITY_COPY.loadUnknownSaved;
    case 'notApplicable':
      return load.reason === 'bodyweight' ? ACTIVITY_COPY.loadNone : load.reason === 'timedActivity' ? 'Timed' : 'No load';
  }
}

/** 3360 → "56 min"; 3930 → "1 hr 5 min 30 sec". Null for a missing or invalid duration (never "0 min"). */
export function durationText(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return [h ? `${h} hr` : '', m ? `${m} min` : '', s ? `${s} sec` : ''].filter(Boolean).join(' ') || `${number.format(seconds)} sec`;
}

/** 510 s/mi → "8:30 per mile". Display rounds to whole seconds; the stored value is unchanged. */
export function paceText(pace: Pace): string {
  const total = Math.round(pace.secondsPerUnit);
  const m = Math.floor(total / 60), s = total % 60;
  return `${m}:${String(s).padStart(2, '0')} per ${pace.unit === 'mi' ? 'mile' : 'km'}`;
}

export function distanceText(distance: Distance): string {
  const unit = distance.unit === 'mi' ? (distance.value === 1 ? 'mile' : 'miles') : distance.unit;
  return `${number.format(distance.value)} ${unit}`;
}

export function speedText(speed: Speed): string {
  return `${number.format(speed.value)} ${speed.unit === 'mi/h' ? 'mph' : speed.unit}`;
}

/**
 * Activity plan target, e.g. "3 sets, 8–10 reps, 40 kg". Targets are optional and never defaulted:
 * an item without any target reads "No target set" rather than "0 sets".
 */
export function planTargetText(target: ActivityPlanTarget): string {
  const parts: string[] = [];
  if (target.setCount !== undefined) parts.push(`${target.setCount} ${target.setCount === 1 ? 'set' : 'sets'}`);
  if (target.repMin !== undefined && target.repMax !== undefined) {
    parts.push(target.repMin === target.repMax ? `${target.repMin} reps` : `${target.repMin}–${target.repMax} reps`);
  }
  const load = target.load ? loadText(target.load) : null;
  if (load) parts.push(load);
  const duration = durationText(target.durationSeconds);
  if (duration) parts.push(duration);
  if (target.distance) parts.push(distanceText(target.distance));
  return parts.length ? parts.join(', ') : 'No target set';
}

/** Plan length: null means the person never gave one ("No time set"), not zero. */
export const planMinutesText = (minutes: number | null) => (minutes === null ? 'No time set' : `${minutes} min`);

/* ---------------- load states (honest unknown; integration-contract.md#resources) ---------------- */

/**
 * What a screen may claim about a resource. GET /v1/activity/calendar and /v1/activity/schedule answer a
 * valid JSON null for "not configured" (root transport accepts null only on those two exact reads), so
 * `ready` with value null is an explicit not-configured state. `unavailable` (network, malformed body, 5xx)
 * is a load failure with Try again and is never converted into "not set up" or an empty plan.
 */
export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'unavailable'; error: { code: string; status: number } };

export type SetupState = 'configured' | 'notConfigured' | 'unknown';

/** Calendar: explicit null or capability `not_configured` → setup; any failed or pending read → unknown. */
export function calendarState(calendar: ResourceState<ActivityCalendar | null>, capabilities?: ResourceState<ActivityCapabilities>): SetupState {
  if (calendar.status === 'ready') return calendar.value === null ? 'notConfigured' : 'configured';
  if (capabilities?.status === 'ready') return capabilities.value.calendar === 'not_configured' ? 'notConfigured' : 'configured';
  return 'unknown';
}

/** Weekly plan: explicit null → "No weekly plan yet"; failed or pending read → unknown (never "no plan"). */
export function scheduleState(schedule: ResourceState<ScheduleRevision | null>): SetupState {
  if (schedule.status !== 'ready') return 'unknown';
  return schedule.value === null ? 'notConfigured' : 'configured';
}

/** Minutes and seconds fields → seconds. Whole, nonnegative parts only; null when the person entered neither. */
export function secondsFromFields(minutes: number | null, seconds: number | null): number | null {
  if (minutes === null && seconds === null) return null;
  const m = minutes ?? 0, s = seconds ?? 0;
  if (!Number.isInteger(m) || !Number.isInteger(s) || m < 0 || s < 0 || s > 59) return null;
  return m * 60 + s;
}

/* ---------------- save outcome (SaveResult / DraftController phases) ---------------- */

export type OutcomeNotice = { kind: 'success' | 'warning' | 'error' | 'info'; text: string; action?: 'retry' | 'editPlan' | 'reload' };

/** Notice for a controller phase and error code. Saving and idle show no notice; the primary shows busy instead. */
export function saveOutcomeNotice(phase: DraftPhase, error: { code: string; status: number } | null, savedDate?: string): OutcomeNotice | null {
  if (phase === 'saved') return { kind: 'success', text: savedDate ? savedToText(savedDate) : ACTIVITY_COPY.savedEdit };
  if (phase === 'unknown') return { kind: 'warning', text: ACTIVITY_COPY.unknownSave, action: 'retry' };
  if (phase === 'stale' || phase === 'rejected') return errorNotice(error);
  return null;
}

export function errorNotice(error: { code: string; status: number } | null): OutcomeNotice {
  switch (error?.code) {
    case 'stale_revision': return { kind: 'info', text: ACTIVITY_COPY.stale, action: 'reload' };
    case 'idempotency_mismatch':
    case 'draft_identity_conflict': return { kind: 'error', text: ACTIVITY_COPY.duplicateDraft, action: 'reload' };
    case 'item_identity_conflict': return { kind: 'error', text: ACTIVITY_COPY.itemIdentity };
    case 'future_activity_date': return { kind: 'error', text: ACTIVITY_COPY.futureDate, action: 'editPlan' };
    case 'date_review_required': return { kind: 'error', text: ACTIVITY_COPY.dateReview };
    case 'exercise_retired': return { kind: 'error', text: 'That exercise is retired. Pick another exercise.' };
    case 'not_found': return { kind: 'error', text: ACTIVITY_COPY.concealed };
    default:
      if (!error || error.status === 0 || error.status >= 500) return { kind: 'error', text: ACTIVITY_COPY.network };
      if (error.status === 404) return { kind: 'error', text: ACTIVITY_COPY.concealed };
      // 422 invalid_request: the screen marks fields from the bounded field paths; never echo the payload.
      return { kind: 'error', text: 'Check the highlighted details and try again.' };
  }
}

/* ---------------- Basic / Advanced (presentation only; DESIGN.md#modes) ---------------- */

export type ModePresentation = {
  streakBreakdown: boolean; perSetList: boolean; loadBasisChips: boolean;
  runMetricsExpanded: boolean; derivedMetrics: boolean; revisionHistory: boolean; longestStreak: boolean;
};

/** Never hides review, privacy, safety, error or save status: those are not in this table. */
export function modePresentation(appMode: AppMode): ModePresentation {
  const advanced = appMode === 'advanced';
  return {
    streakBreakdown: advanced, perSetList: advanced, loadBasisChips: advanced,
    runMetricsExpanded: advanced, derivedMetrics: advanced, revisionHistory: advanced, longestStreak: advanced,
  };
}

/* ---------------- navigation (flow.md) ---------------- */

export type ActivityRoute =
  | { name: 'activity' }
  | { name: 'calendar-setup' }
  | { name: 'day'; date: string }
  | { name: 'log'; date: string | null; entryId?: string }
  | { name: 'run'; itemId: string }
  | { name: 'voice-review' }
  | { name: 'entry'; entryId: string; date: string }
  | { name: 'exercises' }
  | { name: 'exercise-edit'; exerciseId: string | null; from: 'exercises' | 'picker' }
  | { name: 'schedule' }
  | { name: 'plans' }
  | { name: 'plan-edit'; planId: string | null }
  | { name: 'streak' };

/** Back label for a pushed route, given the route beneath it. The slot root's Back reads "Today". */
export function backLabel(parent: ActivityRoute | null): string {
  if (!parent) return 'Today';
  switch (parent.name) {
    case 'activity': return 'Activity';
    case 'day': return formatCivilDate(parent.date);
    case 'log': return 'Log activity';
    case 'exercises': return 'Your exercises';
    case 'schedule': return 'Weekly plan';
    case 'plans': return 'Activity plans';
    case 'entry': return formatCivilDate(parent.date);
    case 'calendar-setup': return 'Calendar';
    case 'voice-review': return 'Check what we heard';
    case 'run': return 'Run';
    case 'exercise-edit': return 'Exercise';
    case 'plan-edit': return 'Plan';
    case 'streak': return 'Your streak';
  }
}

/* ---------------- account-scoped screen cache ---------------- */

/**
 * Volatile per-account screen data (catalog, history pages, schedule, adherence). `reset` on 401 or account
 * change drops everything and bumps the generation, so a late response for an older generation is ignored.
 * Draft text and pending commands live in DraftController, which has its own accountChanged().
 */
export class ActivityScreenCache {
  private generation = 0;
  private values = new Map<string, unknown>();
  constructor(private accountId: string) {}
  get current(): { accountId: string; generation: number } { return { accountId: this.accountId, generation: this.generation }; }
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  /** Stores only when the response belongs to the current account generation. */
  accept<T>(stamp: { accountId: string; generation: number }, key: string, value: T): boolean {
    if (stamp.accountId !== this.accountId || stamp.generation !== this.generation) return false;
    this.values.set(key, value);
    return true;
  }
  invalidate(key: string): void { this.values.delete(key); }
  reset(accountId: string): void { this.accountId = accountId; this.generation += 1; this.values.clear(); }
}
