import { planFields } from '../../schemas.js';
import { evaluate } from './evaluation.js';
import { candidateSchema, normalizeContext, normalizeFirstPlanInput } from './normalization.js';
import type { FirstPlanPorts, FirstPlanRequest, FirstPlanResult, Gap, PlanCandidate, SelectionTrace } from './types.js';

export type * from './types.js';
export { normalizeFirstPlanInput, normalizeSourceFirstPlanInput, prescriptionKey, sourcePrescriptionKey } from './normalization.js';
export { selectSourceFirstPlan } from './source-selection.js';
export { produceFallbackCandidate, FALLBACK_POLICY } from './fallback-producer.js';
export type { FallbackProductionRequest, FallbackProductionResult } from './fallback-producer.js';

export function selectFirstPlan(request: FirstPlanRequest, ports: FirstPlanPorts = {}): FirstPlanResult {
  const trace: SelectionTrace = {
    version: 'form.first-plan-selection/v1', selection: 'first-eligible-in-supplied-order', candidates: [],
  };
  const blocked = (code: string): FirstPlanResult => ({ status: 'blocked', gaps: [{ code }], trace });
  const context = normalizeContext(request.context, request.confirmation);
  if (context.status === 'blocked') return blocked(context.gaps[0]!.code);
  trace.contextKey = context.contextKey;
  trace.confirmation = { ...context.confirmation };
  if (!Array.isArray(request.candidates) || request.candidates.length === 0) return blocked('candidates_unavailable');
  const parsed = request.candidates.map(candidate => candidateSchema.safeParse(candidate));
  if (parsed.some(candidate => !candidate.success)) return blocked('invalid_candidate');
  const candidates: PlanCandidate[] = parsed.map(candidate => candidate.data!);
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) return blocked('duplicate_candidate_id');

  let selected: PlanCandidate | undefined;
  for (const candidate of candidates) {
    const normalized = normalizeFirstPlanInput({ context: context.context, confirmation: context.confirmation, candidate });
    if (normalized.status === 'blocked') return blocked(normalized.gaps[0]!.code);
    const input = normalized.input;
    const result = evaluate(input, ports);
    trace.candidates.push(result);
    if (!selected && result.status === 'eligible') selected = candidate;
  }
  if (selected) {
    trace.selectedCandidateId = selected.id;
    return { status: 'ready', plan: planFields.parse(selected.plan), trace };
  }
  const gaps: Gap[] = trace.candidates.flatMap(candidate => candidate.reasons);
  return {
    status: trace.candidates.every(candidate => candidate.status === 'excluded') ? 'infeasible' : 'blocked',
    gaps, trace,
  };
}
