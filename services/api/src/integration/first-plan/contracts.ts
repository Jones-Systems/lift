import { z } from 'zod';
import type { AccountContext } from '../../lifecycle/types.js';
import type { FirstPlanPorts, PlanCandidate, PlanningContext, SourcePlanCandidate, SourceFirstPlanPorts } from '../../planning/first-plan/types.js';
import { expectedRevision, savedPlan, resourceId } from '../../schemas.js';

export type FirstPlanConfirmation = Readonly<{ profileRevision: number; preferencesRevision: number }>;
export type PreparedFirstPlan = Readonly<{
  candidates: PlanCandidate[];
  ports: FirstPlanPorts;
  assertCurrent: () => void;
}>;
export type PreparedSourceFirstPlan = Readonly<{
  schema: 'form.source-first-plan-preparation/v1';
  candidates: SourcePlanCandidate[];
  ports: SourceFirstPlanPorts;
  assertCurrent: () => void;
}>;
export type FirstPlanPreparationPort = (
  actor: AccountContext, context: PlanningContext,
) => Promise<PreparedFirstPlan | PreparedSourceFirstPlan>;

export const firstPlanOperation = 'plan.first';
export const firstPlanProvenanceLimit = 64 * 1024;
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
export const firstPlanProvenanceSchema = z.object({
  schema: z.literal('form.first-plan-provenance/v1'),
  contextKey: identifier,
  selectedCandidateId: resourceId,
  profileRevision: expectedRevision,
  preferencesRevision: expectedRevision,
  sources: z.array(z.object({ id: identifier, revision: identifier }).strict()).max(256),
  candidates: z.array(z.object({
    id: resourceId,
    status: z.enum(['eligible', 'excluded', 'unknown']),
    gapCodes: z.array(identifier).max(64),
  }).strict()).max(64),
}).strict();
export const firstPlanReceiptSchema = z.object({
  plan: savedPlan,
  provenance: firstPlanProvenanceSchema,
}).strict();
export type FirstPlanProvenance = z.infer<typeof firstPlanProvenanceSchema>;
export type FirstPlanReceipt = z.infer<typeof firstPlanReceiptSchema>;
