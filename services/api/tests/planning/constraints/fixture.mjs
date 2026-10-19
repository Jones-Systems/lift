// Entirely artificial qualification, variants, units and limits; no medical policy or actual catalog clearance.
export function source(id = 'invented-source', changes = {}) {
  return { id, revision: 'fixture-1', locator: 'synthetic-fixture:only', currentness: 'current', qualification: 'qualified', ...changes };
}

export function demand(changes = {}) {
  return { key: 'invented-demand', region: 'invented-region', side: 'left', value: 2,
    unit: 'invented-unit', source: source('invented-demand-source'), ...changes };
}

export function item(changes = {}) {
  return { id: 'slot-a', exerciseId: 'invented-exercise-a', variantId: 'invented-variant-a',
    prescriptionKey: 'invented-dose-a', equipment: ['invented-equipment'], contexts: ['invented-context'],
    purposes: ['invented-purpose-a'], demands: [demand()], ...changes };
}

export function candidate(changes = {}) {
  return { id: 'candidate-a', minutes: 20, source: source('invented-catalog'), items: [item()], ...changes };
}

export function fact(changes = {}) {
  return { id: 'fact-a', revision: 'fixture-1', kind: 'user_reported_history',
    region: 'invented-region', side: 'left', resolution: 'confirmed',
    source: source('invented-report', { qualification: 'accepted_instruction' }), ...changes };
}

export function rule(changes = {}) {
  return { id: 'rule-a', revision: 'fixture-1', origin: 'qualified_rule',
    source: source('invented-rule-source'), factIds: ['fact-a'], variantIds: 'all',
    effect: { kind: 'require_demand', test: { key: 'invented-demand', region: 'invented-region',
      side: 'left', unit: 'invented-unit', operator: 'at_most', value: 3 } }, ...changes };
}

export function request(changes = {}) {
  const input = {
    binding: { context: 'context-1', catalog: 'catalog-1', rules: 'rules-1', preflight: 'preflight-1' },
    current: { context: 'context-1', catalog: 'catalog-1', rules: 'rules-1', preflight: 'preflight-1' },
    preflight: { complete: true, trainingState: 'adapted', source: source('invented-r1-output'),
      regions: [{ region: 'invented-region', side: 'left', route: 'screened_self_management' }],
      restrictionCoverage: { complete: true, ruleIds: [], instructions: [] } },
    facts: [fact()], requiredFactIds: ['fact-a'], rules: [rule()],
    limits: { maxMinutes: 30, equipment: ['invented-equipment'], context: 'invented-context' },
    purposes: { required: ['invented-purpose-a'], preferred: [] }, locks: [], preferences: [],
    candidates: [candidate()], baseline: null, ...changes,
  };
  return cover(input);
}

// This fixture simulates a trusted upstream receipt; production must obtain it from its accepted owner.
export function cover(input) {
  input = structuredClone(input);
  input.preflight.restrictionCoverage = { complete: true, ruleIds: input.rules.map((rule) => rule.id),
    instructions: input.facts.filter((fact) => fact.kind !== 'user_reported_history').map((fact) => ({
      factId: fact.id, disposition: 'mapped', ruleIds: input.rules.filter((rule) =>
        rule.origin !== 'qualified_rule' && rule.factIds.includes(fact.id)).map((rule) => rule.id),
    })) };
  return input;
}

export function exclusion(changes = {}) {
  return rule({ id: 'exclusion', variantIds: ['invented-variant-a'], effect: { kind: 'exclude' }, ...changes });
}

export function reasons(result) {
  return [...result.reasons, ...result.candidates.flatMap((entry) => entry.reasons)].map((entry) => entry.code);
}

// Synthetic equipment and operational attestation; no source acceptance or active-row/R1 claim.
export function groupedEquipment(changes = {}) {
  return { schema: 'form.equipment-requirements/v1', required: ['invented-required'],
    alternatives: [['invented-first-a', 'invented-first-b'], ['invented-second-a', 'invented-second-b']],
    native: { identity: { repository: 'synthetic/repository', revision: 'synthetic-revision',
      path: 'synthetic/catalog.json', sha256: 'a'.repeat(64), nativeId: 'synthetic-native' },
      variantId: 'movement-engine:synthetic-revision:synthetic-native', qualification: 'source_native_operational_identity' },
    operationalSource: source('invented-catalog'), ...changes };
}
