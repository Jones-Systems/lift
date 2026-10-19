import type { PreparedFirstPlan } from '../../../src/integration/first-plan/contracts.js';
import type { PlanCandidate } from '../../../src/planning/first-plan/types.js';

export const source = { id: 'synthetic-source', revision: 'test-v1', locator: 'fixture:invented',
  currentness: 'current' as const, qualification: 'Synthetic mechanics only; no production qualification.' };
export const candidate: PlanCandidate = { id: 'synthetic-candidate', qualification: 'qualified', source,
  plan: { name: 'Synthetic plan', minutes: 20, items: [
    { id: 'one', exerciseId: 'synthetic-one', setTarget: 1, repMin: 4, repMax: 8, targetKg: 2 },
    { id: 'two', exerciseId: 'synthetic-two', setTarget: 1, repMin: 5, repMax: 9, targetKg: 3 },
  ] } };
export function prepared(assertCurrent: () => void = () => {}): PreparedFirstPlan {
  return { candidates: [structuredClone(candidate)], assertCurrent, ports: {
    qualifyCatalog(input) {
      return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified', source,
        evidence: { schema: 'synthetic/v1', value: { health: 'PRIVATE-TEST-EVIDENCE' } },
        items: input.candidate.plan.items.map((item, index) => ({ itemId: item.id, exerciseId: item.exerciseId,
          variantId: `synthetic-variant-${item.id}`, prescriptionKey: input.prescriptions[index]!.prescriptionKey,
          retired: false, source })) };
    },
    evaluateConstraints(input) {
      return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'eligible', source,
        reasons: [], rules: [{ ruleId: 'synthetic-rule', outcome: 'satisfied', source, reasons: [] }],
        evidence: { schema: 'synthetic/v1', value: { context: 'PRIVATE-TEST-EVIDENCE' } } };
    },
  } };
}
