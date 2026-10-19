import { z } from 'zod';
import { assertCivilDate, assertTimeZone } from './calendar.js';

export const resourceId = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
export const expectedRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const civilDate = z.string().refine(x => { try { assertCivilDate(x); return true; } catch { return false; } });
export const timeZone = z.string().refine(x => { try { assertTimeZone(x); return true; } catch { return false; } });
const positive = z.number().finite().positive();
export const exerciseRef = z.discriminatedUnion('source', [
  z.object({ source: z.literal('global'), id: resourceId }).strict(),
  z.object({ source: z.literal('personal'), id: resourceId, revision: expectedRevision.min(1) }).strict(),
]);
export const personalExerciseFields = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().trim().max(2000),
  movement: z.string().trim().min(1).max(120).nullable(),
  measurementType: z.enum(['repetitions', 'duration', 'distance', 'mixed', 'unspecified']),
  kind: z.enum(['resistance', 'timed', 'run']),
  loadApplicability: z.enum(['applicable', 'notApplicable', 'unspecified']),
  loadLabel: z.string().trim().min(1).max(80).nullable(),
}).strict();
export const exerciseSnapshot = personalExerciseFields.extend({
  ref: exerciseRef, guidance: z.enum(['globalReference', 'userDefinedUnassessed']),
  cueStatus: z.enum(['globalReference', 'unknown']), safetyAssessment: z.literal('notEstablished'),
}).strict();
export const load = z.discriminatedUnion('state', [
  z.object({ state: z.literal('knownValue'), value: z.number().finite().min(0), unit: z.enum(['kg', 'lb']),
    basis: z.enum(['total', 'perImplement', 'perSide', 'assistance', 'unspecified']) }).strict()
    .refine(x => x.value * (x.unit === 'lb' ? 0.45359237 : 1) <= 500),
  z.object({ state: z.literal('unknown'), confirmed: z.literal(true) }).strict(),
  z.object({ state: z.literal('notApplicable'), reason: z.enum(['bodyweight', 'unloaded', 'timedActivity']) }).strict(),
]);
export const distance = z.object({ value: positive, unit: z.enum(['m', 'km', 'mi']) }).strict()
  .refine(x => x.value * (x.unit === 'm' ? 1 : x.unit === 'km' ? 1000 : 1609.344) <= 10_000_000);
export const pace = z.object({ secondsPerUnit: positive, unit: z.enum(['km', 'mi']) }).strict()
  .refine(x => x.secondsPerUnit / (x.unit === 'mi' ? 1.609344 : 1) <= 86400);
export const speed = z.object({ value: positive, unit: z.enum(['m/s', 'km/h', 'mi/h']) }).strict()
  .refine(x => x.value * (x.unit === 'm/s' ? 3.6 : x.unit === 'mi/h' ? 1.609344 : 1) <= 1000);
const duration = positive.max(604800);
export const split = z.object({ id: resourceId, sequence: z.number().int().min(1).max(200),
  durationSeconds: duration, distance: distance.optional(), pace: pace.optional(), speed: speed.optional() }).strict();
export const setObservation = z.object({ id: resourceId, repetitions: z.number().int().min(1).max(100).optional(),
  durationSeconds: duration.optional(), load }).strict();
export const activityItem = z.object({
  id: resourceId, exercise: exerciseRef, load, sets: z.array(setObservation).max(100).optional(),
  reportedSetCount: z.number().int().min(1).max(100).optional(), durationSeconds: duration.optional(),
  distance: distance.optional(), pace: pace.optional(), speed: speed.optional(),
  splits: z.array(split).max(200).optional(), splitCoverage: z.enum(['partial', 'complete']).optional(),
}).strict().superRefine((item, ctx) => {
  if (item.sets && new Set(item.sets.map(x => x.id)).size !== item.sets.length) ctx.addIssue({ code: 'custom', message: 'Duplicate set identity' });
  if (item.sets && item.reportedSetCount !== undefined && item.sets.length !== item.reportedSetCount)
    ctx.addIssue({ code: 'custom', message: 'Set count mismatch' });
  if (item.splits && (new Set(item.splits.map(x => x.id)).size !== item.splits.length ||
    item.splits.some((x, i) => x.sequence !== i + 1) || !item.splitCoverage || !item.durationSeconds))
    ctx.addIssue({ code: 'custom', message: 'Review split sequence and coverage' });
  if (!item.splits && item.splitCoverage) ctx.addIssue({ code: 'custom', message: 'Missing splits' });
});
const items = z.array(activityItem).min(1).max(50).superRefine((value, ctx) => {
  if (new Set(value.map(x => x.id)).size !== value.length || value.reduce((n, x) => n + (x.sets?.length ?? 0), 0) > 200 ||
    value.reduce((n, x) => n + (x.splits?.length ?? 0), 0) > 200) ctx.addIssue({ code: 'custom', message: 'Item identity or aggregate limit' });
});
export const activityDate = z.object({
  localDate: civilDate, timeZone, calendar: z.literal('iso8601'),
  source: z.enum(['selected', 'spokenExplicit', 'spokenRelative', 'captureDefault']),
  capturedAt: z.iso.datetime({ offset: true }), referenceLocalDate: civilDate, confirmed: z.literal(true),
}).strict();
export const issueAcknowledgement = z.object({ fieldPath: z.string().min(1).max(120).regex(/^[A-Za-z0-9_.\[\]-]+$/),
  code: z.enum(['approximateMetrics', 'possibleDuplicate']) }).strict();
export const activityWrite = z.object({
  date: activityDate, kind: z.enum(['workout', 'exerciseSnack']), items,
  performedConfirmed: z.literal(true), source: z.enum(['manual', 'nativeSpeech']), draftId: resourceId,
  acknowledgedIssues: z.array(issueAcknowledgement).max(100),
}).strict();
export const activityPatch = activityWrite.extend({ expectedRevision }).strict();
export const planTarget = z.object({ setCount: z.number().int().min(1).max(100).optional(),
  repMin: z.number().int().min(1).max(100).optional(), repMax: z.number().int().min(1).max(100).optional(),
  load: load.optional(), durationSeconds: duration.optional(), distance: distance.optional(),
}).strict().refine(x => (x.repMin === undefined) === (x.repMax === undefined) &&
  (x.repMin === undefined || x.repMax! >= x.repMin));
export const planItem = z.object({ id: resourceId, exercise: exerciseRef, target: planTarget }).strict();
export const planFields = z.object({ name: z.string().trim().min(1).max(100), minutes: z.number().int().min(5).max(180).nullable().default(null),
  items: z.array(planItem).min(1).max(50).refine(value => new Set(value.map(x => x.id)).size === value.length) }).strict();
export const legacyPlanSnapshot = z.object({ id: resourceId, revision: expectedRevision.min(1), name: z.string().trim().min(1).max(100),
  minutes: z.number().int().min(5).max(180), archived: z.boolean(), items: z.array(z.object({ id: resourceId, exerciseId: resourceId,
    setTarget: z.number().int().min(1).max(20), repMin: z.number().int().min(1).max(100), repMax: z.number().int().min(1).max(100),
    targetKg: z.number().finite().min(0).max(500) }).strict().refine(x => x.repMax >= x.repMin)).min(1).max(50) }).strict();
export const planPatch = planFields.extend({ expectedRevision }).strict();
export const calendarCreate = z.object({ timeZone, confirmed: z.literal(true) }).strict();
export const revisionCommand = z.object({ expectedRevision }).strict();
export const legacyImport = z.object({ planId: resourceId, revision: expectedRevision.min(1) }).strict();
export const weekDay = z.object({ isoWeekday: z.number().int().min(1).max(7),
  expectation: z.enum(['workout', 'exerciseSnack', 'rest']),
  plan: z.object({ id: resourceId, revision: expectedRevision.min(1) }).strict().nullable(),
}).strict().refine(x => x.expectation !== 'rest' || x.plan === null);
export const scheduleWrite = z.object({ expectedRevision, effectiveFrom: civilDate, week: z.array(weekDay).length(7)
  .refine(x => new Set(x.map(y => y.isoWeekday)).size === 7 && x.some(y => y.expectation !== 'rest')) }).strict();
export const dayCorrection = z.object({ expectedRevision, expectation: z.enum(['workout', 'exerciseSnack', 'rest']),
  plan: z.object({ id: resourceId, revision: expectedRevision.min(1) }).strict().nullable(),
  reason: z.literal('scheduleWasIncorrect'), confirmed: z.literal(true),
}).strict().refine(x => x.expectation !== 'rest' || x.plan === null);
export const rangeQuery = z.object({ from: civilDate, to: civilDate }).strict();
export const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50),
  cursor: z.string().max(500).optional(), retired: z.enum(['true', 'false']).optional() }).strict();
export const entriesQuery = listQuery.omit({ retired: true }).extend({ from: civilDate, to: civilDate }).strict();
export type ExerciseRef = z.infer<typeof exerciseRef>;
export type PersonalExerciseFields = z.infer<typeof personalExerciseFields>;
export type ExerciseSnapshot = z.infer<typeof exerciseSnapshot>;
export type Load = z.infer<typeof load>;
export type ActivityItemInput = z.infer<typeof activityItem>;
export type ActivityWrite = z.infer<typeof activityWrite>;
export type PlanFields = z.infer<typeof planFields>;
export type ScheduleWrite = z.infer<typeof scheduleWrite>;

export type PlanTarget = z.infer<typeof planTarget>;
export type ActivityPlanItemInput = z.infer<typeof planItem>;
