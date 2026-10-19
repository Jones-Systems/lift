import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  expectedRevision, planFields, planItem, preferenceFields, profileFields, resourceId,
  sourcePrescriptionItem, sourcePrescriptionPlanFields,
} from '../../schemas.js';
import type {
  ContextConfirmation, EvaluationInput, NormalizationRequest, NormalizationResult, PlanCandidate, PlanItem,
  PlanningContext, SourceEvaluationInput, SourcePlanCandidate, SourcePrescriptionItem,
} from './types.js';

export const text = z.string().trim().min(1).max(4000);
export const sourceSchema = z.object({
  id: text, revision: text, locator: text, qualification: text,
  currentness: z.enum(['current', 'unknown', 'superseded', 'withdrawn']),
}).strict();
const contextSchema = z.object({
  accountId: resourceId,
  profile: profileFields.pick({ goals: true, trainingBackground: true, injuryHistory: true }).extend({
    revision: expectedRevision, trainingContext: z.string().trim().max(4000).optional(),
  }).strict(),
  preferences: preferenceFields.pick({ equipment: true, sessionMinutes: true, trainingDaysPerWeek: true })
    .extend({ revision: expectedRevision }).strict(),
}).strict();
const confirmationSchema = z.object({
  accountId: resourceId, profileRevision: expectedRevision, preferencesRevision: expectedRevision,
}).strict();
export const candidateSchema = z.object({
  id: resourceId, qualification: z.enum(['qualified', 'provisional']), source: sourceSchema, plan: planFields,
}).strict();
export const sourceCandidateSchema = z.object({
  id: resourceId, qualification: z.enum(['qualified', 'provisional']), source: sourceSchema, plan: sourcePrescriptionPlanFields,
}).strict();

export function key(kind: string, value: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function prescriptionKey(item: PlanItem): string {
  return key('form-prescription-v1', planItem.parse(item));
}
export function sourcePrescriptionKey(item: SourcePrescriptionItem): string {
  return key('form-source-prescription-v1', sourcePrescriptionItem.parse(item));
}

export function normalizeContext(contextInput: PlanningContext, confirmationInput: ContextConfirmation | null) {
  const blocked = (code: string) => ({ status: 'blocked' as const, gaps: [{ code }] });
  const context = contextSchema.safeParse(contextInput);
  if (!context.success) return blocked('invalid_context');
  const confirmation = confirmationSchema.safeParse(confirmationInput);
  if (!confirmation.success) return blocked('confirmation_required');
  if (confirmation.data.accountId !== context.data.accountId ||
    confirmation.data.profileRevision !== context.data.profile.revision ||
    confirmation.data.preferencesRevision !== context.data.preferences.revision) return blocked('stale_confirmation');
  return freeze({ status: 'valid' as const, context: context.data, confirmation: confirmation.data,
    contextKey: key('form-context-v1', context.data) });
}

export function normalizeFirstPlanInput(request: NormalizationRequest<PlanCandidate>): NormalizationResult<EvaluationInput> {
  const context = normalizeContext(request.context, request.confirmation);
  if (context.status === 'blocked') return context;
  const parsed = candidateSchema.safeParse(request.candidate);
  if (!parsed.success) return { status: 'blocked', gaps: [{ code: 'invalid_candidate' }] };
  const candidate = parsed.data;
  return freeze({ status: 'valid', confirmation: context.confirmation, input: {
    context: context.context, contextKey: context.contextKey, candidate,
    candidateKey: key('form-candidate-v1', candidate),
    prescriptions: candidate.plan.items.map(item => ({ itemId: item.id, prescriptionKey: prescriptionKey(item) })),
  } });
}

export function normalizeSourceFirstPlanInput(request: NormalizationRequest<SourcePlanCandidate>): NormalizationResult<SourceEvaluationInput> {
  const context = normalizeContext(request.context, request.confirmation);
  if (context.status === 'blocked') return context;
  const parsed = sourceCandidateSchema.safeParse(request.candidate);
  if (!parsed.success) return { status: 'blocked', gaps: [{ code: 'invalid_candidate' }] };
  const candidate = parsed.data;
  return freeze({ status: 'valid', confirmation: context.confirmation, input: {
    format: 'form.source-prescription-evaluation/v1',
    context: context.context, contextKey: context.contextKey, candidate,
    candidateKey: key('form-source-candidate-v1', candidate),
    comparisonMinutes: candidate.plan.duration.maxMinutes,
    prescriptions: candidate.plan.items.map(item => ({ itemId: item.id, prescriptionKey: sourcePrescriptionKey(item) })),
  } });
}
