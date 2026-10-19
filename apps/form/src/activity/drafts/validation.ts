import type { ActivityDate, ActivityItemInput, ActivityPlanFields, ActivityWrite, DayCorrection, ExerciseRef, Load, PersonalExerciseFields, ScheduleWrite } from '../contracts';
import { civilDayBoundaries, instantMilliseconds, localDateAt, parseCivilDate } from './dates';
import { distanceMetres, KG_PER_POUND, metricConflicts, paceSecondsPerMetre, speedMetresPerSecond } from './metrics';
import type { DraftResult } from './model';
export type ValidationProblem = { fieldPath: string; code: string };
export class ActivityValidationError extends Error {
  constructor(public readonly problems: ValidationProblem[]) { super('Review the Activity fields before saving.'); this.name = 'ActivityValidationError'; }
}
type ObjectValue = Record<string, unknown>;
export function strictObject(value: unknown, allowed: readonly string[], required: readonly string[], path = ''): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(path, 'invalid_object');
  const record = value as ObjectValue;
  if (Object.getOwnPropertyNames(record).some(key => !allowed.includes(key)) || Object.getOwnPropertySymbols(record).length || Object.values(Object.getOwnPropertyDescriptors(record)).some(descriptor => !('value' in descriptor))) fail(path, 'unexpected_field');
  if (required.some(key => record[key] === undefined)) fail(path, 'required_field');
  return record;
}
function fail(fieldPath: string, code: string): never { throw new ActivityValidationError([{ fieldPath, code }]); }
export function resourceId(value: unknown, path = 'id'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail(path, 'invalid_id');
  return value;
}
export function commandId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{16,128}$/.test(value)) fail('key', 'invalid_command_key');
  return value;
}
export function revision(value: unknown, initial = false): number { return integer(value, initial ? 0 : 1, Number.MAX_SAFE_INTEGER, 'expectedRevision'); }
function numeric(value: unknown, min: number, max: number, path: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (positive && value === 0)) fail(path, 'invalid_number');
  return value;
}
function integer(value: unknown, min: number, max: number, path: string): number {
  const result = numeric(value, min, max, path);
  if (!Number.isInteger(result)) fail(path, 'invalid_integer'); return result;
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, 'invalid_enum'); return value as T;
}
function boundedText(value: unknown, min: number, max: number, path: string): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(path, 'invalid_text'); return value.trim();
}
export function sanitizeExerciseRef(value: unknown, path = 'exercise'): ExerciseRef {
  const source = strictObject(value, ['source', 'id', 'revision'], ['source', 'id'], path);
  const id = resourceId(source.id, `${path}.id`);
  if (source.source === 'global') { strictObject(value, ['source', 'id'], ['source', 'id'], path); return { source: 'global', id }; }
  if (source.source === 'personal') return { source: 'personal', id, revision: revision(source.revision) };
  return fail(path, 'invalid_exercise_source');
}
export function sanitizeLoad(value: unknown, path = 'load'): Load {
  const object = strictObject(value, ['state', 'value', 'unit', 'basis', 'confirmed', 'reason'], ['state'], path);
  if (object.state === 'unknown') {
    strictObject(value, ['state', 'confirmed'], ['state', 'confirmed'], path);
    if (object.confirmed !== true) fail(path, 'unknown_requires_confirmation'); return { state: 'unknown', confirmed: true };
  }
  if (object.state === 'notApplicable') {
    strictObject(value, ['state', 'reason'], ['state', 'reason'], path);
    return { state: 'notApplicable', reason: enumeration(object.reason, ['bodyweight', 'unloaded', 'timedActivity'] as const, path) };
  }
  if (object.state === 'knownValue') {
    strictObject(value, ['state', 'value', 'unit', 'basis'], ['state', 'value', 'unit', 'basis'], path);
    const unit = enumeration(object.unit, ['kg', 'lb'] as const, `${path}.unit`);
    const load = numeric(object.value, 0, 500 / (unit === 'lb' ? KG_PER_POUND : 1), `${path}.value`);
    return { state: 'knownValue', value: load, unit, basis: enumeration(object.basis, ['total', 'perImplement', 'perSide', 'assistance', 'unspecified'] as const, `${path}.basis`) };
  }
  return fail(path, 'load_review_required');
}
const metricKeys = ['durationSeconds', 'distance', 'pace', 'speed'] as const;
function sanitizeMetrics(object: ObjectValue, path: string): Pick<ActivityItemInput, typeof metricKeys[number]> {
  const output: Pick<ActivityItemInput, typeof metricKeys[number]> = {};
  if (object.durationSeconds !== undefined) output.durationSeconds = numeric(object.durationSeconds, 0, 604800, `${path}.durationSeconds`, true);
  if (object.distance !== undefined) {
    const value = strictObject(object.distance, ['value', 'unit'], ['value', 'unit'], `${path}.distance`);
    output.distance = { value: numeric(value.value, 0, 10000000, `${path}.distance.value`, true), unit: enumeration(value.unit, ['m', 'km', 'mi'] as const, `${path}.distance.unit`) };
    if (distanceMetres(output.distance) > 10000000) fail(`${path}.distance`, 'distance_out_of_range');
  }
  if (object.pace !== undefined) {
    const value = strictObject(object.pace, ['secondsPerUnit', 'unit'], ['secondsPerUnit', 'unit'], `${path}.pace`);
    output.pace = { secondsPerUnit: numeric(value.secondsPerUnit, 0, 86400 * 1.609344, `${path}.pace.secondsPerUnit`, true), unit: enumeration(value.unit, ['km', 'mi'] as const, `${path}.pace.unit`) };
    if (paceSecondsPerMetre(output.pace) > 86.4) fail(`${path}.pace`, 'pace_out_of_range');
  }
  if (object.speed !== undefined) {
    const value = strictObject(object.speed, ['value', 'unit'], ['value', 'unit'], `${path}.speed`);
    output.speed = { value: numeric(value.value, 0, 1000, `${path}.speed.value`, true), unit: enumeration(value.unit, ['m/s', 'km/h', 'mi/h'] as const, `${path}.speed.unit`) };
    if (speedMetresPerSecond(output.speed) * 3.6 > 1000) fail(`${path}.speed`, 'speed_out_of_range');
  }
  return output;
}
function array(value: unknown, min: number, max: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(path, 'invalid_array'); return value;
}
function unique(values: string[], path: string) { if (new Set(values).size !== values.length) fail(path, 'duplicate_id'); }
export function sanitizeActivityItems(value: unknown): ActivityItemInput[] {
  const items = array(value, 1, 50, 'items').map((raw, index) => {
    const path = `items.${index}`, object = strictObject(raw, ['id', 'exercise', 'load', 'sets', 'reportedSetCount', ...metricKeys, 'splits', 'splitCoverage'], ['id', 'exercise', 'load'], path);
    const item: ActivityItemInput = { id: resourceId(object.id, `${path}.id`), exercise: sanitizeExerciseRef(object.exercise, `${path}.exercise`), load: sanitizeLoad(object.load, `${path}.load`), ...sanitizeMetrics(object, path) };
    if (object.reportedSetCount !== undefined) item.reportedSetCount = integer(object.reportedSetCount, 1, 100, `${path}.reportedSetCount`);
    if (object.sets !== undefined) {
      item.sets = array(object.sets, 1, 100, `${path}.sets`).map((rawSet, setIndex) => {
        const setPath = `${path}.sets.${setIndex}`, set = strictObject(rawSet, ['id', 'repetitions', 'durationSeconds', 'load'], ['id', 'load'], setPath);
        return { id: resourceId(set.id, `${setPath}.id`), load: sanitizeLoad(set.load, `${setPath}.load`),
          ...(set.repetitions === undefined ? {} : { repetitions: integer(set.repetitions, 1, 100, `${setPath}.repetitions`) }),
          ...(set.durationSeconds === undefined ? {} : { durationSeconds: numeric(set.durationSeconds, 0, 604800, `${setPath}.durationSeconds`, true) }) };
      });
      unique(item.sets.map(set => set.id), `${path}.sets`);
      if (item.reportedSetCount !== undefined && item.sets.length !== item.reportedSetCount) fail(`${path}.sets`, 'set_count_conflict');
    }
    if (object.splits !== undefined) {
      if (item.durationSeconds === undefined) fail(`${path}.durationSeconds`, 'split_total_duration_required');
      item.splits = array(object.splits, 1, 200, `${path}.splits`).map((rawSplit, splitIndex) => {
        const splitPath = `${path}.splits.${splitIndex}`, split = strictObject(rawSplit, ['id', 'sequence', ...metricKeys], ['id', 'sequence', 'durationSeconds'], splitPath);
        const sequence = integer(split.sequence, 1, 200, `${splitPath}.sequence`);
        if (sequence !== splitIndex + 1) fail(splitPath, 'split_sequence_conflict');
        return { id: resourceId(split.id, `${splitPath}.id`), sequence, ...sanitizeMetrics(split, splitPath), durationSeconds: numeric(split.durationSeconds, 0, 604800, `${splitPath}.durationSeconds`, true) };
      });
      unique(item.splits.map(split => split.id), `${path}.splits`);
      item.splitCoverage = enumeration(object.splitCoverage, ['partial', 'complete'] as const, `${path}.splitCoverage`);
    } else if (object.splitCoverage !== undefined) fail(`${path}.splitCoverage`, 'splits_required');
    return item;
  });
  unique(items.map(item => item.id), 'items');
  unique(items.flatMap(item => (item.sets ?? []).map(set => set.id)), 'sets');
  unique(items.flatMap(item => (item.splits ?? []).map(split => split.id)), 'splits');
  if (items.reduce((sum, item) => sum + (item.sets?.length ?? 0), 0) > 200 || items.reduce((sum, item) => sum + (item.splits?.length ?? 0), 0) > 200) fail('items', 'observation_limit');
  return items;
}
export function sanitizeActivityDate(value: unknown): ActivityDate {
  const date = strictObject(value, ['localDate', 'timeZone', 'calendar', 'source', 'capturedAt', 'referenceLocalDate', 'confirmed'], ['localDate', 'timeZone', 'calendar', 'source', 'capturedAt', 'referenceLocalDate', 'confirmed'], 'date');
  if (typeof date.localDate !== 'string' || !parseCivilDate(date.localDate) || date.localDate < '1900-01-01') fail('date.localDate', 'invalid_activity_date');
  if (typeof date.referenceLocalDate !== 'string' || !parseCivilDate(date.referenceLocalDate)) fail('date.referenceLocalDate', 'invalid_reference_date');
  if (typeof date.capturedAt !== 'string' || instantMilliseconds(date.capturedAt) === null) fail('date.capturedAt', 'invalid_instant');
  if (typeof date.timeZone !== 'string' || civilDayBoundaries(date.localDate, date.timeZone).status !== 'available') fail('date.timeZone', 'date_or_zone_unavailable');
  if (date.calendar !== 'iso8601' || date.confirmed !== true) fail('date', 'date_review_required');
  if (localDateAt(date.capturedAt, date.timeZone) !== date.referenceLocalDate) fail('date', 'capture_reference_conflict');
  return { localDate: date.localDate, timeZone: date.timeZone, calendar: 'iso8601', capturedAt: date.capturedAt, referenceLocalDate: date.referenceLocalDate, confirmed: true,
    source: enumeration(date.source, ['selected', 'spokenExplicit', 'spokenRelative', 'captureDefault'] as const, 'date.source') };
}
// Exact shape validation precedes serialization/dispatch. Semantic no-save origin is enforced by root's trusted data flow.
export function sanitizeActivityWrite(value: unknown): ActivityWrite {
  const object = strictObject(value, ['date', 'kind', 'items', 'performedConfirmed', 'source', 'draftId', 'acknowledgedIssues'], ['date', 'kind', 'items', 'performedConfirmed', 'source', 'draftId', 'acknowledgedIssues']);
  if (object.performedConfirmed !== true) fail('performedConfirmed', 'performance_review_required');
  const items = sanitizeActivityItems(object.items);
  const acknowledgedIssues = array(object.acknowledgedIssues, 0, 100, 'acknowledgedIssues').map((raw, index) => {
    const issue = strictObject(raw, ['fieldPath', 'code'], ['fieldPath', 'code'], `acknowledgedIssues.${index}`);
    const fieldPath = boundedText(issue.fieldPath, 1, 120, `acknowledgedIssues.${index}.fieldPath`);
    if (fieldPath && !/^items\.\d+(?:\.(?:durationSeconds|distance|pace|speed|splits|splitCoverage)(?:\.\d+)?)?$/.test(fieldPath)) fail('acknowledgedIssues', 'invalid_issue_path');
    return { fieldPath, code: enumeration(issue.code, ['approximateMetrics', 'possibleDuplicate'] as const, 'acknowledgedIssues') };
  });
  for (const [index, item] of items.entries()) for (const conflict of metricConflicts(item)) {
    const fieldPath = `items.${index}${conflict.fieldPath ? `.${conflict.fieldPath}` : ''}`;
    if (!acknowledgedIssues.some(issue => issue.code === 'approximateMetrics' && issue.fieldPath === fieldPath)) fail(fieldPath, 'metric_conflict');
  }
  return { date: sanitizeActivityDate(object.date), kind: enumeration(object.kind, ['workout', 'exerciseSnack'] as const, 'kind'), items, performedConfirmed: true,
    source: enumeration(object.source, ['manual', 'nativeSpeech'] as const, 'source'), draftId: resourceId(object.draftId, 'draftId'), acknowledgedIssues };
}
export function sanitizePersonalExercise(value: unknown): PersonalExerciseFields {
  const fields = strictObject(value, ['name', 'description', 'movement', 'measurementType', 'kind', 'loadApplicability', 'loadLabel'], ['name', 'description', 'movement', 'measurementType', 'kind', 'loadApplicability', 'loadLabel']);
  return { name: boundedText(fields.name, 1, 100, 'name'), description: boundedText(fields.description, 0, 2000, 'description'),
    movement: fields.movement === null ? null : boundedText(fields.movement, 1, 120, 'movement'),
    measurementType: enumeration(fields.measurementType, ['repetitions', 'duration', 'distance', 'mixed', 'unspecified'] as const, 'measurementType'),
    kind: enumeration(fields.kind, ['resistance', 'timed', 'run'] as const, 'kind'),
    loadApplicability: enumeration(fields.loadApplicability, ['applicable', 'notApplicable', 'unspecified'] as const, 'loadApplicability'),
    loadLabel: fields.loadLabel === null ? null : boundedText(fields.loadLabel, 1, 80, 'loadLabel') };
}
function sanitizePlanRef(value: unknown): { id: string; revision: number } | null {
  if (value === null) return null;
  const ref = strictObject(value, ['id', 'revision'], ['id', 'revision']); return { id: resourceId(ref.id), revision: revision(ref.revision) };
}
export function sanitizeSchedule(value: unknown): ScheduleWrite {
  const schedule = strictObject(value, ['expectedRevision', 'effectiveFrom', 'week'], ['expectedRevision', 'effectiveFrom', 'week']);
  if (typeof schedule.effectiveFrom !== 'string' || !parseCivilDate(schedule.effectiveFrom)) fail('effectiveFrom', 'invalid_civil_date');
  const week = array(schedule.week, 7, 7, 'week').map(raw => {
    const day = strictObject(raw, ['isoWeekday', 'expectation', 'plan'], ['isoWeekday', 'expectation', 'plan']);
    const expectation = enumeration(day.expectation, ['workout', 'exerciseSnack', 'rest'] as const, 'expectation'), plan = sanitizePlanRef(day.plan);
    if (expectation === 'rest' && plan !== null) fail('week', 'rest_has_plan');
    return { isoWeekday: integer(day.isoWeekday, 1, 7, 'isoWeekday') as 1 | 2 | 3 | 4 | 5 | 6 | 7, expectation, plan };
  });
  if (new Set(week.map(day => day.isoWeekday)).size !== 7 || week.every(day => day.expectation === 'rest')) fail('week', 'invalid_schedule');
  return { expectedRevision: revision(schedule.expectedRevision, true), effectiveFrom: schedule.effectiveFrom, week };
}
export function sanitizeDayCorrection(value: unknown): DayCorrection {
  const day = strictObject(value, ['expectedRevision', 'expectation', 'plan', 'reason', 'confirmed'], ['expectedRevision', 'expectation', 'plan', 'reason', 'confirmed']);
  const expectation = enumeration(day.expectation, ['workout', 'exerciseSnack', 'rest'] as const, 'expectation'), plan = sanitizePlanRef(day.plan);
  if (expectation === 'rest' && plan) fail('plan', 'rest_has_plan');
  if (day.reason !== 'scheduleWasIncorrect' || day.confirmed !== true) fail('reason', 'invalid_reason');
  return { expectedRevision: revision(day.expectedRevision, true), expectation, plan, reason: 'scheduleWasIncorrect', confirmed: true };
}
export function draftToActivityWrite(result: DraftResult): ActivityWrite {
  const unresolved = result.issues.filter(issue => issue.blocking && !issue.resolution);
  if (unresolved.length) throw new ActivityValidationError(unresolved.map(issue => ({ fieldPath: issue.fieldPath, code: issue.code })));
  const draft = result.candidate;
  if (draft.draftId !== result.context.draftId || draft.date?.capturedAt !== result.context.capturedAt || draft.date?.referenceLocalDate !== result.context.referenceLocalDate || draft.date?.timeZone !== result.context.timeZone) fail('date', 'frozen_capture_context_conflict');
  strictObject(draft, ['date', 'kind', 'items', 'performedConfirmed', 'source', 'draftId'], ['date', 'kind', 'items', 'performedConfirmed', 'source', 'draftId']);
  if (!draft.date || !draft.date.confirmed || !draft.performedConfirmed) fail('', 'structured_review_required');
  const items = draft.items.map((item, index) => {
    if (item.exercise.state !== 'selected') fail(`items.${index}.exercise`, 'exercise_review_required');
    const kind = item.exercise.snapshot.kind;
    if (kind === 'run' && (!item.durationSeconds || item.load.state !== 'notApplicable' || item.load.reason !== 'timedActivity')) fail(`items.${index}`, 'run_duration_or_load_required');
    return { ...item, exercise: item.exercise.ref };
  });
  strictObject(draft.date, ['localDate', 'timeZone', 'calendar', 'source', 'capturedAt', 'referenceLocalDate', 'confirmed', 'spokenDates', 'selectedDate'], ['localDate', 'timeZone', 'calendar', 'source', 'capturedAt', 'referenceLocalDate', 'confirmed']);
  const { spokenDates: _spoken, selectedDate: _selected, ...date } = draft.date;
  return sanitizeActivityWrite({ date, kind: draft.kind, items, performedConfirmed: true, source: draft.source, draftId: draft.draftId,
    acknowledgedIssues: result.issues.flatMap(issue => issue.resolution?.kind === 'acknowledged' ? [{ fieldPath: issue.fieldPath, code: issue.resolution.code }] : []) });
}

export function sanitizeActivityPlan(value: unknown): ActivityPlanFields {
  const fields = strictObject(value, ['name', 'minutes', 'items'], ['name', 'minutes', 'items']);
  const items = array(fields.items, 1, 50, 'items').map((raw, index) => {
    const path = `items.${index}`, item = strictObject(raw, ['id', 'exercise', 'target'], ['id', 'exercise', 'target'], path);
    const target = strictObject(item.target, ['setCount', 'repMin', 'repMax', 'load', 'durationSeconds', 'distance'], [], `${path}.target`);
    const sanitized = { ...sanitizeMetrics(target, `${path}.target`),
      ...(target.setCount === undefined ? {} : { setCount: integer(target.setCount, 1, 100, `${path}.target.setCount`) }),
      ...(target.load === undefined ? {} : { load: sanitizeLoad(target.load, `${path}.target.load`) }),
      ...(target.repMin === undefined ? {} : { repMin: integer(target.repMin, 1, 100, `${path}.target.repMin`) }),
      ...(target.repMax === undefined ? {} : { repMax: integer(target.repMax, 1, 100, `${path}.target.repMax`) }) };
    if ((sanitized.repMin === undefined) !== (sanitized.repMax === undefined) || (sanitized.repMin !== undefined && sanitized.repMax !== undefined && sanitized.repMin > sanitized.repMax)) fail(`${path}.target`, 'rep_range_conflict');
    return { id: resourceId(item.id, `${path}.id`), exercise: sanitizeExerciseRef(item.exercise, `${path}.exercise`), target: sanitized };
  });
  unique(items.map(item => item.id), 'items');
  return { name: boundedText(fields.name, 1, 100, 'name'), minutes: fields.minutes === null ? null : integer(fields.minutes, 5, 180, 'minutes'), items };
}
export function draftValidationProblems(result: DraftResult): ValidationProblem[] {
  try { draftToActivityWrite(result); return []; }
  catch (error) { if (error instanceof ActivityValidationError) return error.problems; throw error; }
}
