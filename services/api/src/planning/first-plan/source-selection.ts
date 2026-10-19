import { sourcePrescriptionPlanFields } from '../../schemas.js';
import { evaluate } from './evaluation.js';
import { normalizeContext, normalizeSourceFirstPlanInput, sourceCandidateSchema } from './normalization.js';
import type {
  Gap, SourceFirstPlanPorts, SourceFirstPlanRequest, SourceFirstPlanResult, SourcePlanCandidate, SourceSelectionTrace,
} from './types.js';

export function selectSourceFirstPlan(request: SourceFirstPlanRequest, ports: SourceFirstPlanPorts = {}): SourceFirstPlanResult {
  const trace: SourceSelectionTrace = {
    version: 'form.source-first-plan-selection/v1', selection: 'first-eligible-in-supplied-order', candidates: [],
  };
  const blocked = (code: string): SourceFirstPlanResult => ({ status: 'blocked', gaps: [{ code }], trace });
  const context = normalizeContext(request.context, request.confirmation);
  if (context.status === 'blocked') return blocked(context.gaps[0]!.code);
  trace.contextKey = context.contextKey;
  trace.confirmation = { ...context.confirmation };
  if (!Array.isArray(request.candidates) || request.candidates.length === 0) return blocked('candidates_unavailable');
  const parsed = request.candidates.map(candidate => sourceCandidateSchema.safeParse(candidate));
  if (parsed.some(candidate => !candidate.success)) return blocked('invalid_candidate');
  const candidates: SourcePlanCandidate[] = parsed.map(candidate => candidate.data!);
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) return blocked('duplicate_candidate_id');
  let selected: SourcePlanCandidate | undefined;
  for (const candidate of candidates) {
    const normalized = normalizeSourceFirstPlanInput({ context: context.context, confirmation: context.confirmation, candidate });
    if (normalized.status === 'blocked') return blocked(normalized.gaps[0]!.code);
    const result = evaluate(normalized.input, ports);
    trace.candidates.push(result);
    if (!selected && result.status === 'eligible') selected = candidate;
  }
  if (selected) {
    trace.selectedCandidateId = selected.id;
    return { status: 'ready', plan: sourcePrescriptionPlanFields.parse(selected.plan), trace };
  }
  const gaps: Gap[] = trace.candidates.flatMap(candidate => candidate.reasons);
  return { status: trace.candidates.every(candidate => candidate.status === 'excluded') ? 'infeasible' : 'blocked', gaps, trace };
}
