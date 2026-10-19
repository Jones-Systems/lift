import { z } from 'zod';
import { resourceId } from '../../schemas.js';
import { freeze, prescriptionKey, sourcePrescriptionKey, sourceSchema as source, text } from './normalization.js';
import type {
  Binding, CandidateTrace, CatalogDecision, ConstraintDecision, EvaluationInput, QualifiedCatalog, SourceEvaluationInput,
} from './types.js';

const gap = z.object({ code: text, itemId: resourceId.optional(), detail: text.optional() }).strict();
const binding = { contextKey: text, candidateKey: text };
const evidence = z.object({ schema: text, value: z.json() }).strict().optional();
const catalogSchema = z.discriminatedUnion('status', [
  z.object({ ...binding, evidence, status: z.literal('qualified'), source, items: z.array(z.object({
    itemId: resourceId, exerciseId: resourceId, variantId: text, prescriptionKey: text,
    retired: z.literal(false), source,
  }).strict()).min(1).max(50) }).strict(),
  z.object({ ...binding, evidence, status: z.enum(['excluded', 'unknown']), reasons: z.array(gap).min(1) }).strict(),
]);
const constraintsSchema = z.object({
  ...binding, evidence, status: z.enum(['eligible', 'excluded', 'unknown']), source, reasons: z.array(gap),
  rules: z.array(z.object({
    ruleId: text, itemId: resourceId.optional(), outcome: z.enum(['satisfied', 'violated', 'unknown']),
    source, reasons: z.array(gap),
  }).strict()),
}).strict();


function unavailable(trace: CandidateTrace, code: string): CandidateTrace {
  return { ...trace, status: 'unknown', reasons: [{ code }] };
}

function matches(input: Binding, result: { contextKey: string; candidateKey: string }): boolean {
  return input.contextKey === result.contextKey && input.candidateKey === result.candidateKey;
}

export function evaluate<I extends EvaluationInput | SourceEvaluationInput>(input: I, ports: {
  qualifyCatalog?: (input: I) => CatalogDecision;
  evaluateConstraints?: (input: I, catalog: QualifiedCatalog) => ConstraintDecision;
}): CandidateTrace {
  const trace: CandidateTrace = {
    candidateId: input.candidate.id, candidateKey: input.candidateKey,
    source: input.candidate.source, status: 'unknown', reasons: [],
  };
  if (input.candidate.qualification !== 'qualified') return unavailable(trace, 'candidate_unqualified');
  if (input.candidate.source.currentness !== 'current') return unavailable(trace, 'candidate_source_not_current');
  if (!ports.qualifyCatalog) return unavailable(trace, 'catalog_unavailable');
  let catalog: QualifiedCatalog;
  try {
    const parsed = catalogSchema.safeParse(ports.qualifyCatalog(input));
    if (!parsed.success) return unavailable(trace, 'invalid_catalog_result');
    const result = parsed.data;
    if (!matches(input, result)) return unavailable(trace, 'stale_catalog_result');
    trace.catalog = result;
    if (result.status !== 'qualified') return { ...trace, status: result.status, reasons: result.reasons };
    if (result.source.currentness !== 'current' || result.items.some(item => item.source.currentness !== 'current')) {
      return unavailable(trace, 'catalog_source_not_current');
    }
    const byItem = new Map(result.items.map(item => [item.itemId, item]));
    if (byItem.size !== result.items.length || byItem.size !== input.candidate.plan.items.length ||
        input.candidate.plan.items.some(item => {
          const proof = byItem.get(item.id);
          return !proof || ('registeredDomain' in item
            ? proof.exerciseId !== item.registeredDomain.exerciseId || proof.variantId !== item.registeredDomain.variantId ||
              proof.prescriptionKey !== sourcePrescriptionKey(item)
            : proof.exerciseId !== item.exerciseId || proof.prescriptionKey !== prescriptionKey(item));
        })) return unavailable(trace, 'catalog_mapping_incomplete');
    catalog = freeze(result);
  } catch {
    return unavailable(trace, 'catalog_unavailable');
  }
  if (!ports.evaluateConstraints) return unavailable(trace, 'constraints_unavailable');
  let decision: ConstraintDecision;
  try {
    const parsed = constraintsSchema.safeParse(ports.evaluateConstraints(input, catalog));
    if (!parsed.success) return unavailable(trace, 'invalid_constraints_result');
    decision = parsed.data;
  } catch {
    return unavailable(trace, 'constraints_unavailable');
  }
  if (!matches(input, decision)) return unavailable(trace, 'stale_constraints_result');
  trace.constraints = decision;
  if (decision.source.currentness !== 'current' || decision.rules.some(rule => rule.source.currentness !== 'current')) {
    return unavailable(trace, 'constraints_source_not_current');
  }
  const itemIds = new Set(input.candidate.plan.items.map(item => item.id));
  if (decision.rules.some(rule => rule.itemId !== undefined && !itemIds.has(rule.itemId)) ||
      (decision.status === 'eligible' && decision.rules.some(rule => rule.outcome !== 'satisfied')) ||
      (decision.status !== 'eligible' && decision.reasons.length === 0)) {
    return unavailable(trace, 'inconsistent_constraints_result');
  }
  return { ...trace, status: decision.status, reasons: decision.reasons };
}
