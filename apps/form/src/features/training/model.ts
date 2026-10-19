// Training view model (settings-training v2 contracts.md#shared, #training). Pure helpers; no I/O.
// Targets are plan snapshot data; performance is set data. Totals count confirmed sets only.
import { ApiError } from '../../api/client';
import type { CuePreferences, History, PerformedSet, Preferences, WorkoutSession, SavedSet, SourcePerformedSet,
  SourcePerformance, SourceSetCreate, SourceSetPatch, SourceWorkoutSession, SourceStatsCoverage,
  StoredHistory, StoredWorkoutSession } from '../../api/domain';
import { normalizeCues } from '../cues/CuesScreen';

/** From ApiError. `effectUnknown` is true when a write may have applied. */
export type ServerError = { status: number; code: string; message: string; effectUnknown: boolean };

/** Read state for one server resource. Data the server has not returned is never shown or filled with placeholders. */
export type Remote<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T; refreshing: boolean; refreshError: ServerError | null }
  | { status: 'error'; error: ServerError };

export type CommandState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'failed'; error: ServerError }
  | { status: 'conflict'; error: ServerError }
  | { status: 'unknown'; error: ServerError };

/** A keyed command the caller owns. The key and payload are kept until the command reaches a terminal result. */
export type PendingCommand<P> = { key: string; payload: P; state: CommandState };

export type LegacySetDraft = { occurrenceId: string; setNumber: number; reps: number; weightKg: number; status: 'draft' | 'confirmed' };
export type LegacySetChanges = { reps: number; weightKg: number; status: 'draft' | 'confirmed' };

type WithoutExpectedRevision<T> = T extends unknown ? Omit<T, 'expectedRevision'> : never;
export type SourceSetDraft = WithoutExpectedRevision<SourceSetCreate>;
export type SourceSetChanges = WithoutExpectedRevision<SourceSetPatch>;
export type SetDraft = LegacySetDraft | SourceSetDraft;
export type SetChanges = LegacySetChanges | SourceSetChanges;
type TrainingSession = WorkoutSession | SourceWorkoutSession;

function assertData(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Training intent must be plain data.');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('Training intent must not contain accessors.');
    assertData(descriptor.value, seen);
  }
  seen.delete(value);
}

/** Detach the user-entered performance before the queue owns its retry intent. */
function freezePerformance<T extends SourcePerformance>(performance: T): T;
function freezePerformance(performance: SourcePerformance): SourcePerformance {
  return performance.schema === 'form.source-performance/v1'
    ? Object.freeze({ ...performance, load: Object.freeze({ ...performance.load }) })
    : Object.freeze({ ...performance, load: Object.freeze({ ...performance.load }) });
}

export function freezeSetDraft<T extends SetDraft>(set: T): T;
export function freezeSetDraft(set: SourceSetDraft): SourceSetDraft;
export function freezeSetDraft(set: SetDraft): SetDraft;
export function freezeSetDraft(set: SetDraft): SetDraft {
  assertData(set);
  if (!('schema' in set)) return Object.freeze({ ...set });
  return set.schema === 'form.source-performed-set/v1'
    ? Object.freeze({ ...set, performance: freezePerformance(set.performance) })
    : Object.freeze({ ...set, performance: freezePerformance(set.performance) });
}

export function freezeSetChanges<T extends SetChanges>(changes: T): T;
export function freezeSetChanges(changes: SourceSetChanges): SourceSetChanges;
export function freezeSetChanges(changes: SetChanges): SetChanges;
export function freezeSetChanges(changes: SetChanges): SetChanges {
  assertData(changes);
  if (!('schema' in changes)) return Object.freeze({ ...changes });
  return changes.schema === 'form.source-performed-set/v1'
    ? Object.freeze({ ...changes, performance: freezePerformance(changes.performance) })
    : Object.freeze({ ...changes, performance: freezePerformance(changes.performance) });
}

export function freezeSavedSet<T extends SavedSet>(set: T): T;
export function freezeSavedSet(set: SavedSet): SavedSet {
  assertData(set);
  if (!('schema' in set)) return Object.freeze({ ...set });
  return set.schema === 'form.source-performed-set/v1'
    ? Object.freeze({ ...set, performance: freezePerformance(set.performance) })
    : Object.freeze({ ...set, performance: freezePerformance(set.performance) });
}

/** Value equality is only one part of acknowledgement; the caller must also bind identity and revision. */
export function setValuesMatch(set: SavedSet, intended: SetChanges | SavedSet): boolean {
  if (set.status !== intended.status) return false;
  if ('schema' in intended) {
    if (!('schema' in set) || set.schema !== intended.schema) return false;
    const a = set.performance, b = intended.performance;
    if (a.schema !== b.schema || a.kind !== b.kind
      || !(a.kind === 'controlled-practice' || (b.kind === 'repetitions' && Number.isFinite(a.reps) && a.reps === b.reps))) return false;
    if (a.schema === 'form.source-performance/v1' && b.schema === 'form.source-performance/v1') {
      return set.schema === 'form.source-performed-set/v1'
        && a.load.kind === 'unspecified' && b.load.kind === a.load.kind
        && a.load.basis === 'unknown' && b.load.basis === a.load.basis;
    }
    if (set.schema !== 'form.source-performed-set/v2'
      || a.schema !== 'form.source-performance/v2' || b.schema !== 'form.source-performance/v2') return false;
    const left = a.load, right = b.load;
    switch (left.state) {
      case 'knownValue': return right.state === 'knownValue' && Number.isFinite(left.value)
        && left.value === right.value && left.unit === right.unit && left.basis === right.basis;
      case 'unknown': return right.state === 'unknown' && left.confirmed === true && right.confirmed === true;
      case 'notApplicable': return right.state === 'notApplicable' && left.reason === right.reason;
      default: return false;
    }
  }
  return !('schema' in set) && Number.isFinite(set.reps) && Number.isFinite(set.weightKg)
    && set.reps === intended.reps && set.weightKg === intended.weightKg;
}

export const CONFLICT_CODES = new Set(['stale_revision', 'set_number_exists', 'session_completed', 'plan_archived', 'set_voided']);

export function toServerError(error: unknown): ServerError {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message, effectUnknown: error.effectUnknown };
  }
  return { status: 0, code: 'client_error', message: error instanceof Error ? error.message : 'Something went wrong.', effectUnknown: false };
}

export function commandStateFrom(error: ServerError): CommandState {
  if (error.effectUnknown) return { status: 'unknown', error };
  if (error.status === 409 && CONFLICT_CODES.has(error.code)) return { status: 'conflict', error };
  return { status: 'failed', error };
}

export const ready = <T,>(value: T): Remote<T> => ({ status: 'ready', value, refreshing: false, refreshError: null });

/** Keeps the last loaded value while refreshing (stale state); never replaces it with placeholders. */
export const refreshing = <T,>(remote: Remote<T>): Remote<T> =>
  (remote.status === 'ready' ? { ...remote, refreshing: true, refreshError: null } : { status: 'loading' });

export const refreshFailed = <T,>(remote: Remote<T>, error: ServerError): Remote<T> =>
  (remote.status === 'ready' ? { ...remote, refreshing: false, refreshError: error } : { status: 'error', error });

/* ---------------- loads (every API value stays in kg) ---------------- */

export const KG_PER_LB = 0.45359237;
type LoadUnit = Preferences['loadUnit'];

/** Display value in the user's unit, rounded to 0.5 for display only. */
export function displayLoad(kg: number, unit: LoadUnit): number {
  const value = unit === 'kg' ? kg : kg / KG_PER_LB;
  return Math.round(value * 2) / 2;
}

export function loadLabel(kg: number, unit: LoadUnit): string {
  return `${formatNumber(displayLoad(kg, unit))} ${unit}`;
}

/** Converts a value the user edited in the shown unit back to kg for the write. */
export function kgFromDisplay(value: number, unit: LoadUnit): number {
  return unit === 'kg' ? value : Math.round(value * KG_PER_LB * 1000) / 1000;
}

/** Stepper increment in the shown unit (matches the plan editor: 0.5 kg or 1 lb). */
export const loadStep = (unit: LoadUnit) => (unit === 'kg' ? 0.5 : 1);

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export const repsRange = (min: number, max: number) => (min === max ? `${min} reps` : `${min}–${max} reps`);
export const plural = (n: number, one: string, many: string) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/* ---------------- session derivations ---------------- */

export const isConfirmed = (set: SavedSet) => set.status === 'confirmed';

export function setsOf(session: WorkoutSession, occurrenceId: string): PerformedSet[];
export function setsOf(session: SourceWorkoutSession, occurrenceId: string): SourcePerformedSet[];
export function setsOf(session: TrainingSession, occurrenceId: string): SavedSet[];
export function setsOf(session: TrainingSession, occurrenceId: string): SavedSet[] {
  return session.sets.filter((s) => s.occurrenceId === occurrenceId).sort((a, b) => a.setNumber - b.setNumber);
}

/** Server uniqueness covers every set number, including voided ones, so the next number skips all of them. */
export function nextSetNumber(session: TrainingSession, occurrenceId: string, queued: readonly SetDraft[]): number {
  const used = [...setsOf(session, occurrenceId).map((s) => s.setNumber),
    ...queued.filter((d) => d.occurrenceId === occurrenceId).map((d) => d.setNumber)];
  return used.length ? Math.max(...used) + 1 : 1;
}

export type Totals = { confirmedSets: number; repetitions: number; volumeKg: number };

export type CoveredTotals = {
  confirmedSets: number; repetitions: number | null; volumeKg: number | null; coverage: SourceStatsCoverage;
};

export function sessionTotals(session: WorkoutSession): Totals;
export function sessionTotals(session: SourceWorkoutSession): CoveredTotals;
export function sessionTotals(session: TrainingSession): Totals | CoveredTotals;
export function sessionTotals(session: TrainingSession): Totals | CoveredTotals {
  const confirmed = session.sets.filter(isConfirmed);
  const coverage = { repetitionSets: 0, loadSets: 0, practiceSets: 0 };
  let repetitions = 0, volumeKg = 0;
  for (const set of confirmed) {
    if ('schema' in set) {
      if (set.performance.kind === 'controlled-practice') coverage.practiceSets++;
      else { coverage.repetitionSets++; repetitions += set.performance.reps; }
    } else {
      coverage.repetitionSets++; coverage.loadSets++;
      repetitions += set.reps; volumeKg += set.reps * set.weightKg;
    }
  }
  // A partial sum must not read as complete observed work; zero confirmed sets still has zero totals.
  if ('schema' in session.planSnapshot) return { confirmedSets: confirmed.length,
    repetitions: coverage.practiceSets ? null : repetitions,
    volumeKg: coverage.loadSets < confirmed.length ? null : volumeKg, coverage };
  return { confirmedSets: confirmed.length, repetitions, volumeKg };
}

export const plannedSets = (session: TrainingSession) => session.occurrences.reduce((n, o) =>
  n + ('native' in o.target ? o.target.native.sets : o.target.setTarget), 0);

export function orderedOccurrences(session: WorkoutSession): WorkoutSession['occurrences'];
export function orderedOccurrences(session: SourceWorkoutSession): SourceWorkoutSession['occurrences'];
export function orderedOccurrences(session: TrainingSession): TrainingSession['occurrences'];
export function orderedOccurrences(session: TrainingSession) {
  return [...session.occurrences].sort((a, b) => a.position - b.position);
}

type ExecutionReadonly<T> = T extends object ? { readonly [K in keyof T]: ExecutionReadonly<T[K]> } : T;

export type SourceOccurrenceExecution = Readonly<{
  occurrence: ExecutionReadonly<SourceWorkoutSession['occurrences'][number]>;
  prescribedSets: number;
  observedCounts: Readonly<{ confirmed: number; draft: number; voided: number }>;
  confirmedShortfall: number;
  confirmedExcess: number;
  sets: readonly ExecutionReadonly<SourcePerformedSet>[];
}>;

export type SourceExecution = Readonly<{
  sessionId: string; sessionRevision: number; planId: string; planRevision: number;
  sessionStatus: SourceWorkoutSession['status']; startedAt: string; completedAt: string | null;
  occurrences: readonly SourceOccurrenceExecution[];
}>;

function executionSnapshot<T>(value: T): ExecutionReadonly<T> {
  if (value === null || typeof value !== 'object') return value as ExecutionReadonly<T>;
  const copy = Array.isArray(value) ? value.map(executionSnapshot)
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, executionSnapshot(child)]));
  return Object.freeze(copy) as ExecutionReadonly<T>;
}

/** Decoded source readback only: count coverage does not classify an occurrence or acknowledge queued intent. */
export function sourceExecution(session: SourceWorkoutSession): SourceExecution {
  const occurrences = orderedOccurrences(session).map(occurrence => {
    const sets = setsOf(session, occurrence.id);
    const observedCounts = { confirmed: 0, draft: 0, voided: 0 };
    for (const set of sets) observedCounts[set.status]++;
    const prescribedSets = occurrence.target.native.sets;
    return Object.freeze({ occurrence: executionSnapshot(occurrence), prescribedSets,
      observedCounts: Object.freeze(observedCounts),
      confirmedShortfall: Math.max(0, prescribedSets - observedCounts.confirmed),
      confirmedExcess: Math.max(0, observedCounts.confirmed - prescribedSets),
      sets: Object.freeze(sets.map(executionSnapshot)),
    });
  });
  return Object.freeze({ sessionId: session.id, sessionRevision: session.revision,
    planId: session.planId, planRevision: session.planRevision, sessionStatus: session.status,
    startedAt: session.startedAt, completedAt: session.completedAt, occurrences: Object.freeze(occurrences) });
}

/** First history item with status 'active' (G-T3: the most recent unfinished workout). */
export function activeFrom(history: History | null): WorkoutSession | null;
export function activeFrom(history: StoredHistory | null): StoredWorkoutSession | null;
export function activeFrom(history: History | StoredHistory | null): TrainingSession | null;
export function activeFrom(history: History | StoredHistory | null): TrainingSession | null {
  return history?.items.find((s) => s.status === 'active') ?? null;
}

export function sessionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function sessionMinutes(session: WorkoutSession): number | null;
export function sessionMinutes(session: StoredWorkoutSession): number | null;
export function sessionMinutes(session: TrainingSession): number | null;
export function sessionMinutes(session: TrainingSession): number | null {
  if (!session.completedAt) return null;
  const ms = Date.parse(session.completedAt) - Date.parse(session.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.max(1, Math.round(ms / 60000)) : null;
}

export function startedTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Kept cues in the user's order with hidden ("Not for me") cues excluded, as the Cues screen shows them. */
export function keptCues(prefs: CuePreferences): string[] {
  const byId = new Map(prefs.availableCues.map((c) => [c.id, c.text]));
  return normalizeCues(prefs).order.map((id) => byId.get(id)).filter((text): text is string => !!text);
}

/* ---------------- weeks (Advanced; derived from loaded history pages only) ---------------- */

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Monday 00:00 local of the week containing `date`. */
export function weekStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

/** Completed sessions in loaded pages per week, oldest first; historyCovers checks whether the requested range is covered. */
export function completedPerWeek(sessions: readonly WorkoutSession[], now: Date, weeks: number): { start: Date; count: number }[];
export function completedPerWeek(sessions: readonly StoredWorkoutSession[], now: Date, weeks: number): { start: Date; count: number }[];
export function completedPerWeek(sessions: readonly TrainingSession[], now: Date, weeks: number): { start: Date; count: number }[];
export function completedPerWeek(sessions: readonly TrainingSession[], now: Date, weeks: number) {
  const thisWeek = weekStart(now).getTime();
  return Array.from({ length: weeks }, (_, i) => {
    const start = thisWeek - (weeks - 1 - i) * WEEK_MS;
    const count = sessions.filter((s) => s.status === 'completed' && s.completedAt
      && Date.parse(s.completedAt) >= start && Date.parse(s.completedAt) < start + WEEK_MS).length;
    return { start: new Date(start), count };
  });
}

export function weekLabel(start: Date): string {
  return start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** True when the loaded history reaches back past `since` (or is complete), so derived counts are not truncated. */
export function historyCovers(history: History, since: Date): boolean;
export function historyCovers(history: StoredHistory, since: Date): boolean;
export function historyCovers(history: History | StoredHistory, since: Date): boolean;
export function historyCovers(history: History | StoredHistory, since: Date): boolean {
  if (history.nextBefore === null) return true;
  const last = history.items.at(-1);
  return !!last && Date.parse(last.startedAt) < since.getTime();
}
