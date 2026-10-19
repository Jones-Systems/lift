import { z } from 'zod';
import type { NativeRecordIdentity } from './catalog-qualification/native-identity.js';
import type { RegistrationPin } from './catalog-qualification/registered-identity.js';

export const resourceId = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
export const expectedRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().trim().min(1).max(200);
const contextText = z.string().trim().max(4000);
const stringList = z.array(shortText).max(30);
export const profileFields = z.object({
  name: z.string().trim().min(1).max(100),
  age: z.number().int().min(13).max(120).nullable(),
  heightCm: z.number().finite().min(50).max(260).nullable(),
  weightKg: z.number().finite().min(15).max(500).nullable(),
  trainingBackground: z.enum(['new', 'returning', 'regular']).nullable(),
  trainingContext: contextText.optional(),
  injuryHistory: contextText,
  goals: stringList,
}).strict();
export const profilePatch = profileFields.partial().extend({ expectedRevision }).strict();
export const mascotVariant = z.enum(['scholarly', 'baby', 'buff', 'none']);
export const animationStyle = z.enum(['short', 'long']);
export type MascotVariant = z.infer<typeof mascotVariant>;
export type AnimationStyle = z.infer<typeof animationStyle>;
export const preferenceFields = z.object({
  mascot: mascotVariant,
  animationStyle,
  appMode: z.enum(['basic', 'advanced']),
  loadUnit: z.enum(['kg', 'lb']),
  heightUnit: z.enum(['cm', 'ft-in']),
  coachVoice: z.enum(['calm', 'direct', 'encouraging']),
  communication: z.enum(['concise', 'detailed']),
  trainingDaysPerWeek: z.number().int().min(1).max(7),
  sessionMinutes: z.number().int().min(5).max(180),
  equipment: stringList,
  remindersEnabled: z.boolean(),
}).strict();
export const preferencesPatch = preferenceFields.partial().extend({ expectedRevision }).strict();
export const onboardingPatch = z.object({
  expectedRevision,
  step: z.enum(['welcome', 'name', 'measurements', 'background', 'goals', 'injuries', 'preferences', 'review']),
  answers: profileFields.partial().optional(),
  preferences: preferenceFields.partial().optional(),
}).strict();
export const revisionCommand = z.object({ expectedRevision }).strict();
export const firstPlanConfirmation = z.object({ profileRevision: expectedRevision, preferencesRevision: expectedRevision }).strict();
export const planItem = z.object({
  id: resourceId,
  exerciseId: resourceId,
  setTarget: z.number().int().min(1).max(20),
  repMin: z.number().int().min(1).max(100),
  repMax: z.number().int().min(1).max(100),
  targetKg: z.number().finite().min(0).max(500),
}).strict().refine(x => x.repMax >= x.repMin, { message: 'repMax must be at least repMin' });
export const planFields = z.object({
  name: z.string().trim().min(1).max(100),
  minutes: z.number().int().min(5).max(180),
  items: z.array(planItem).min(1).max(50).refine(items => new Set(items.map(x => x.id)).size === items.length, { message: 'Duplicate item ID' }),
}).strict();
export const planPatch = planFields.partial().extend({ expectedRevision }).strict();
export const sessionCreate = z.object({ planId: resourceId, expectedPlanRevision: expectedRevision }).strict();
const setShape = {
  occurrenceId: resourceId,
  setNumber: z.number().int().min(1).max(100),
  reps: z.number().int().min(0).max(100),
  weightKg: z.number().finite().min(0).max(500),
  status: z.enum(['draft', 'confirmed']),
};
export const setCreate = z.object({ ...setShape, expectedRevision }).strict().refine(x => x.status !== 'confirmed' || x.reps > 0, { message: 'A confirmed set requires 1–100 repetitions' });
export const setPatch = z.object({ expectedRevision, reps: z.number().int().min(1).max(100), weightKg: z.number().finite().min(0).max(500), status: z.enum(['draft', 'confirmed']) }).strict();
export const cuePatch = z.object({
  expectedRevision,
  kept: z.array(resourceId).max(20),
  rejected: z.array(resourceId).max(20),
  order: z.array(resourceId).max(20),
  replacementRequested: z.array(resourceId).max(20),
}).strict();
export const promoRedemption = z.object({ code: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export const promoDefinition = z.object({
  code: promoRedemption.shape.code,
  entitlement: z.enum(['form_plus']),
  days: z.number().int().min(1).max(3650),
  maxRedemptions: z.number().int().min(1).max(10000),
  expiresAt: z.iso.datetime(),
}).strict();
export const registration = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('closed') }).strict(),
  z.object({ mode: z.literal('allowlist'), emails: z.array(z.email().max(254)).min(1).max(100) }).strict(),
]);
export type Profile = z.infer<typeof profileFields>;
export type Preferences = z.infer<typeof preferenceFields>;
export type PlanFields = z.infer<typeof planFields>;
export type PlanItem = z.infer<typeof planItem>;
export type Registration = z.infer<typeof registration>;
export type PromoDefinition = z.infer<typeof promoDefinition>;

const sourceReferenceText = z.string().min(1).max(512)
  .refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value), { message: 'Expected exact source reference text' });
const sourceDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceNativeIdentity = z.object({
  repository: sourceReferenceText,
  revision: sourceReferenceText,
  path: sourceReferenceText,
  sha256: sourceDigest,
  nativeId: resourceId,
}).strict() satisfies z.ZodType<NativeRecordIdentity>;
const sourceRegistrationPin = z.object({
  id: sourceReferenceText,
  revision: sourceReferenceText,
  digest: sourceDigest,
  bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict() satisfies z.ZodType<RegistrationPin>;
const nativePrescriptionText = z.string().min(1).max(200)
  .refine(value => value.trim().length > 0, { message: 'Expected nonblank native prescription text' });
export const nativePrescription = z.object({
  exercise_id: resourceId,
  movement_pattern: nativePrescriptionText,
  role: nativePrescriptionText,
  sets: z.number().int().min(1).max(20),
  rest_seconds: z.number().int().min(0).max(10800),
  rep_range: z.tuple([z.number().int().min(1).max(100), z.number().int().min(1).max(100)])
    .refine(([min, max]) => min <= max, { message: 'rep_range must be ordered' }).optional(),
  target_rir: z.number().int().min(0).max(100).optional(),
  substituted_for: resourceId.optional(),
  notes: z.array(z.string().max(4000)).min(1).max(30).optional(),
}).strict().refine(value => (['rep_range', 'target_rir', 'substituted_for', 'notes'] as const)
  .every(key => !Object.hasOwn(value, key) || value[key] !== undefined), { message: 'Present native optional fields must have a value' });
export const sourcePrescriptionItem = z.object({
  id: resourceId,
  native: nativePrescription,
  registeredDomain: z.object({
    exerciseId: resourceId,
    variantId: sourceReferenceText,
    identity: sourceNativeIdentity,
    registration: sourceRegistrationPin,
    recordDigest: sourceDigest,
  }).strict(),
  load: z.object({ kind: z.literal('unspecified'), basis: z.literal('unknown') }).strict(),
}).strict().refine(item => item.native.exercise_id === item.registeredDomain.identity.nativeId, { message: 'Native exercise identity mismatch' });
export const sourcePrescriptionPlanFields = z.object({
  schema: z.literal('form.source-prescription-plan/v1'),
  name: z.string().trim().min(1).max(100),
  origin: z.object({ kind: z.literal('form-adaptation'), id: sourceReferenceText, revision: sourceReferenceText }).strict(),
  duration: z.object({
    kind: z.literal('estimated-range'),
    minMinutes: z.number().int().min(5).max(180),
    maxMinutes: z.number().int().min(5).max(180),
  }).strict().refine(value => value.minMinutes <= value.maxMinutes, { message: 'Duration range must be ordered' }),
  items: z.array(sourcePrescriptionItem).min(1).max(50)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, { message: 'Duplicate item ID' }),
}).strict();
export type NativePrescription = z.infer<typeof nativePrescription>;
export type SourcePrescriptionItem = z.infer<typeof sourcePrescriptionItem>;
export type SourcePrescriptionPlanFields = z.infer<typeof sourcePrescriptionPlanFields>;

export const storedPlanFields = z.union([planFields, sourcePrescriptionPlanFields]);
const savedPlanMetadata = { id: resourceId, revision: expectedRevision, archived: z.boolean(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };
export const savedLegacyPlan = planFields.extend(savedPlanMetadata).strict();
export const savedSourcePlan = sourcePrescriptionPlanFields.extend(savedPlanMetadata).strict();
export const savedPlan = z.union([savedLegacyPlan, savedSourcePlan]);
export const storedPlanRevisionFields = z.union([
  planFields.extend({ archived: z.boolean() }).strict(),
  sourcePrescriptionPlanFields.extend({ archived: z.boolean() }).strict(),
]);
export const savedPlanRevision = z.union([
  planFields.extend({ id: resourceId, revision: expectedRevision, archived: z.boolean() }).strict(),
  sourcePrescriptionPlanFields.extend({ id: resourceId, revision: expectedRevision, archived: z.boolean() }).strict(),
]);
const sourcePerformanceV1 = z.discriminatedUnion('kind', [
  z.object({ schema: z.literal('form.source-performance/v1'), kind: z.literal('repetitions'),
    reps: z.number().int().min(0).max(100), load: z.object({ kind: z.literal('unspecified'), basis: z.literal('unknown') }).strict() }).strict(),
  z.object({ schema: z.literal('form.source-performance/v1'), kind: z.literal('controlled-practice'),
    load: z.object({ kind: z.literal('unspecified'), basis: z.literal('unknown') }).strict() }).strict(),
]);
export const sourceReportedLoad = z.discriminatedUnion('state', [
  z.object({ state: z.literal('knownValue'), value: z.number().finite().min(0), unit: z.enum(['kg', 'lb']),
    basis: z.enum(['total', 'perImplement', 'perSide', 'assistance']) }).strict()
    .refine(value => value.value * (value.unit === 'lb' ? 0.45359237 : 1) <= 500),
  z.object({ state: z.literal('unknown'), confirmed: z.literal(true) }).strict(),
  z.object({ state: z.literal('notApplicable'), reason: z.enum(['bodyweight', 'unloaded', 'timedActivity']) }).strict(),
]);
const sourcePerformanceV2 = z.discriminatedUnion('kind', [
  z.object({ schema: z.literal('form.source-performance/v2'), kind: z.literal('repetitions'),
    reps: z.number().int().min(0).max(100), load: sourceReportedLoad }).strict(),
  z.object({ schema: z.literal('form.source-performance/v2'), kind: z.literal('controlled-practice'),
    load: sourceReportedLoad }).strict(),
]);
// Only command capture fills omission. Stored observations must already contain explicit missingness.
const sourcePerformanceV2Capture = z.discriminatedUnion('kind', [
  sourcePerformanceV2.options[0].extend({ load: sourceReportedLoad.default({ state: 'unknown', confirmed: true }) }),
  sourcePerformanceV2.options[1].extend({ load: sourceReportedLoad.default({ state: 'unknown', confirmed: true }) }),
]);
export const sourcePerformance = z.union([sourcePerformanceV1, sourcePerformanceV2]);
const sourceSetFields = { expectedRevision, status: z.enum(['draft', 'confirmed']) };
const sourceSetV1Fields = { ...sourceSetFields, schema: z.literal('form.source-performed-set/v1'), performance: sourcePerformanceV1 };
const sourceSetV2Fields = { ...sourceSetFields, schema: z.literal('form.source-performed-set/v2'), performance: sourcePerformanceV2Capture };
const confirmedSourcePerformance = (value: { status: string; performance: SourcePerformance }) =>
  value.status !== 'confirmed' || value.performance.kind !== 'repetitions' || value.performance.reps > 0;
const sourceSetIdentity = { occurrenceId: resourceId, setNumber: z.number().int().min(1).max(100) };
export const sourceSetCreate = z.discriminatedUnion('schema', [
  z.object({ ...sourceSetV1Fields, ...sourceSetIdentity }).strict(),
  z.object({ ...sourceSetV2Fields, ...sourceSetIdentity }).strict(),
]).refine(confirmedSourcePerformance, { message: 'A confirmed repetition set requires 1–100 reported repetitions' });
export const sourceSetPatch = z.discriminatedUnion('schema', [
  z.object(sourceSetV1Fields).strict(), z.object(sourceSetV2Fields).strict(),
]).refine(confirmedSourcePerformance, { message: 'A confirmed repetition set requires 1–100 reported repetitions' });
const savedSetMetadata = { id: resourceId, occurrenceId: resourceId, setNumber: z.number().int().min(1).max(100),
  revision: expectedRevision, status: z.enum(['draft', 'confirmed', 'voided']), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };
export const savedLegacySet = z.object({ ...savedSetMetadata, reps: z.number().int().min(0).max(100),
  weightKg: z.number().finite().min(0).max(500) }).strict().refine(value => value.status !== 'confirmed' || value.reps > 0);
export const savedSourceSet = z.discriminatedUnion('schema', [
  z.object({ ...savedSetMetadata, schema: z.literal('form.source-performed-set/v1'), performance: sourcePerformanceV1 }).strict(),
  z.object({ ...savedSetMetadata, schema: z.literal('form.source-performed-set/v2'), performance: sourcePerformanceV2 }).strict(),
]).refine(confirmedSourcePerformance);
export const savedSet = z.union([savedLegacySet, savedSourceSet]);
export type StoredPlanFields = z.infer<typeof storedPlanFields>;
export type SavedPlan = z.infer<typeof savedPlan>;
export type SavedPlanRevision = z.infer<typeof savedPlanRevision>;
export type SourcePerformance = z.infer<typeof sourcePerformance>;
export type SourceSetCreate = z.infer<typeof sourceSetCreate>;
export type SourceSetPatch = z.infer<typeof sourceSetPatch>;
export type SavedSet = z.infer<typeof savedSet>;
