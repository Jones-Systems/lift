import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFirstPlan, prescriptionKey } from '../../../src/planning/first-plan/index.ts';
import { planFields } from '../../../src/schemas.ts';

const source = {
  id: 'synthetic-test-only', revision: 'fixture-v1', locator: 'fixture:selection.test.mjs', currentness: 'current',
  qualification: 'Synthetic mechanics fixture; no exercise or dose recommendation.',
};
function fixture() {
  const context = {
    accountId: 'account-a',
    profile: { revision: 4, goals: ['user-entered-purpose'], trainingBackground: null, injuryHistory: 'user-entered limitation' },
    preferences: { revision: 2, equipment: [], sessionMinutes: 25, trainingDaysPerWeek: 2 },
  };
  const candidate = {
    id: 'candidate-a', qualification: 'qualified', source,
    plan: { name: 'Synthetic candidate', minutes: 25, items: [
      { id: 'item-a', exerciseId: 'exercise-a', setTarget: 2, repMin: 4, repMax: 8, targetKg: 0 },
      { id: 'item-b', exerciseId: 'exercise-b', setTarget: 1, repMin: 6, repMax: 6, targetKg: 3.5 },
    ] },
  };
  const request = {
    context, confirmation: { accountId: 'account-a', profileRevision: 4, preferencesRevision: 2 }, candidates: [candidate],
  };
  const calls = [];
  const ports = {
    qualifyCatalog(input) {
      calls.push(['catalog', input]);
      return {
        contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified', source,
        items: input.candidate.plan.items.map(item => ({
          itemId: item.id, exerciseId: item.exerciseId, variantId: `synthetic-${item.id}`,
          prescriptionKey: prescriptionKey(item), retired: false, source,
        })),
      };
    },
    evaluateConstraints(input) {
      calls.push(['constraints', input]);
      return {
        contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'eligible', source, reasons: [],
        rules: [{ ruleId: 'synthetic-rule', itemId: 'item-a', outcome: 'satisfied', source, reasons: [] }],
      };
    },
  };
  return { request, candidate, context, ports, calls };
}

test('returns an API-compatible candidate with exact supplied dose, order, IDs and qualified trace', () => {
  const f = fixture(), result = selectFirstPlan(f.request, f.ports);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.plan, f.candidate.plan);
  assert.deepEqual(planFields.parse(result.plan), f.candidate.plan);
  assert.equal(result.trace.selectedCandidateId, 'candidate-a');
  assert.deepEqual(result.trace.candidates[0].source, source);
  assert.equal(result.trace.candidates[0].constraints.rules[0].ruleId, 'synthetic-rule');
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(result.trace).includes('user-entered limitation'), false);
});

test('requires explicit current account/profile/preferences confirmation before any qualification', () => {
  for (const change of [
    f => { f.request.confirmation = null; },
    f => { f.request.confirmation.accountId = 'account-b'; },
    f => { f.context.profile.revision++; },
    f => { f.context.preferences.revision++; },
    f => { delete f.context.profile.goals; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(selectFirstPlan(f.request, f.ports).status, 'blocked');
    assert.deepEqual(f.calls, []);
  }
});

test('preserves absent versus explicitly cleared training context and rejects null', () => {
  for (const value of [undefined, '', 'reviewed text']) {
    const f = fixture();
    if (value !== undefined) f.context.profile.trainingContext = value;
    assert.equal(selectFirstPlan(f.request, f.ports).status, 'ready');
    const observed = f.calls[0][1].context.profile;
    assert.equal(observed.trainingContext, value);
    assert.equal(Object.hasOwn(observed, 'trainingContext'), value !== undefined);
  }
  const f = fixture(); f.context.profile.trainingContext = null;
  assert.equal(selectFirstPlan(f.request, f.ports).gaps[0].code, 'invalid_context');
});

test('does not fill missing dose, coerce unknown load to zero, or repair invalid API items', () => {
  for (const change of [
    item => { delete item.targetKg; }, item => { item.targetKg = null; },
    item => { item.repMax = 1; }, item => { item.setTarget = 0; },
  ]) {
    const f = fixture(); change(f.candidate.plan.items[0]);
    assert.equal(selectFirstPlan(f.request, f.ports).gaps[0].code, 'invalid_candidate');
    assert.deepEqual(f.calls, []);
  }
});

test('explicit catalog identity gaps and provisional candidate sources do not become ready', () => {
  const f = fixture();
  f.ports.qualifyCatalog = input => ({
    contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'unknown',
    reasons: [{ code: 'variant_unmapped', itemId: 'item-a' }, { code: 'planning_eligibility_unresolved' }],
  });
  const result = selectFirstPlan(f.request, f.ports);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.gaps.map(g => g.code), ['variant_unmapped', 'planning_eligibility_unresolved']);
  assert.deepEqual(f.calls, []);
  const provisional = fixture(); provisional.candidate.qualification = 'provisional';
  assert.equal(selectFirstPlan(provisional.request, provisional.ports).gaps[0].code, 'candidate_unqualified');
  assert.deepEqual(provisional.calls, []);
});

test('requires complete active catalog mapping bound to exact dose and current context', () => {
  for (const [change, code] of [
    [proof => { proof.items.pop(); }, 'catalog_mapping_incomplete'],
    [proof => { proof.items[1] = proof.items[0]; }, 'catalog_mapping_incomplete'],
    [proof => { proof.items[0].exerciseId = 'unrelated'; }, 'catalog_mapping_incomplete'],
    [proof => { proof.items[0].prescriptionKey = 'old-dose'; }, 'catalog_mapping_incomplete'],
    [proof => { proof.items[0].retired = true; }, 'invalid_catalog_result'],
    [proof => { proof.items[0].variantId = ''; }, 'invalid_catalog_result'],
    [proof => { proof.contextKey = 'old-context'; }, 'stale_catalog_result'],
    [proof => { proof.candidateKey = 'old-candidate'; }, 'stale_catalog_result'],
  ]) {
    const f = fixture(), original = f.ports.qualifyCatalog;
    f.ports.qualifyCatalog = input => { const proof = original(input); change(proof); return proof; };
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, 'blocked');
    assert.equal(result.gaps[0].code, code);
    assert.equal(f.calls.some(([kind]) => kind === 'constraints'), false);
  }
});

test('selects first eligible supplied candidate without reordering or relaxing excluded rules', () => {
  const f = fixture();
  f.request.candidates.push({ ...structuredClone(f.candidate), id: 'candidate-b' }, { ...structuredClone(f.candidate), id: 'candidate-c' });
  const original = f.ports.evaluateConstraints;
  f.ports.evaluateConstraints = input => input.candidate.id === 'candidate-a'
    ? { ...original(input), status: 'excluded', reasons: [{ code: 'accepted_limit' }], rules: [
      { ruleId: 'user-limit', itemId: 'item-a', outcome: 'violated', source, reasons: [{ code: 'accepted_limit' }] },
    ] } : original(input);
  const result = selectFirstPlan(f.request, f.ports);
  assert.equal(result.status, 'ready');
  assert.equal(result.trace.selectedCandidateId, 'candidate-b');
  assert.deepEqual(result.trace.candidates.map(c => c.candidateId), ['candidate-a', 'candidate-b', 'candidate-c']);
  assert.equal(result.trace.candidates[0].constraints.rules[0].outcome, 'violated');
});

test('distinguishes all excluded from incomplete qualification; no empty success plan', () => {
  const f = fixture(), original = f.ports.evaluateConstraints;
  f.ports.evaluateConstraints = input => ({ ...original(input), status: 'excluded', reasons: [{ code: 'time_conflict' }] });
  assert.equal(selectFirstPlan(f.request, f.ports).status, 'infeasible');
  f.ports.evaluateConstraints = input => ({ ...original(input), status: 'unknown', reasons: [{ code: 'rule_not_qualified' }] });
  assert.equal(selectFirstPlan(f.request, f.ports).status, 'blocked');
  f.request.candidates = [];
  assert.equal(selectFirstPlan(f.request, f.ports).gaps[0].code, 'candidates_unavailable');
});

test('unavailable, throwing, stale and inconsistent ports fail closed without echoing errors', () => {
  for (const [change, code] of [
    [f => { delete f.ports.qualifyCatalog; }, 'catalog_unavailable'],
    [f => { delete f.ports.evaluateConstraints; }, 'constraints_unavailable'],
    [f => { f.ports.qualifyCatalog = () => { throw Error('private upstream error'); }; }, 'catalog_unavailable'],
    [f => { f.ports.evaluateConstraints = () => { throw Error('private upstream error'); }; }, 'constraints_unavailable'],
    [f => { f.ports.evaluateConstraints = () => null; }, 'invalid_constraints_result'],
    [f => { const original = f.ports.evaluateConstraints; f.ports.evaluateConstraints = input => ({ ...original(input), contextKey: 'old' }); }, 'stale_constraints_result'],
    [f => { const original = f.ports.evaluateConstraints; f.ports.evaluateConstraints = input => ({ ...original(input), rules: [{ ...original(input).rules[0], outcome: 'unknown' }] }); }, 'inconsistent_constraints_result'],
  ]) {
    const f = fixture(); change(f);
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, 'blocked');
    assert.equal(result.gaps[0].code, code);
    assert.equal(JSON.stringify(result).includes('private upstream error'), false);
  }
});

test('uses isolated immutable inputs and returns detached plan fields', () => {
  const f = fixture(), before = structuredClone(f.request), original = f.ports.evaluateConstraints;
  f.ports.evaluateConstraints = (input, catalog) => {
    assert.throws(() => { input.candidate.plan.items[0].targetKg = 99; }, TypeError);
    assert.throws(() => { input.context.profile.trainingContext = 'unconfirmed'; }, TypeError);
    assert.throws(() => { catalog.items[0].variantId = 'other'; }, TypeError);
    return original(input);
  };
  const result = selectFirstPlan(f.request, f.ports);
  assert.equal(result.status, 'ready');
  result.plan.items[0].targetKg = 88;
  assert.deepEqual(f.request, before);
});

test('dose keys bind every API prescription field; no random selection identity', () => {
  const f = fixture(), item = f.candidate.plan.items[0], key = prescriptionKey(item);
  for (const [field, value] of Object.entries({ id: 'other-item', exerciseId: 'other-exercise', setTarget: 3, repMin: 5, repMax: 9, targetKg: 2 })) {
    assert.notEqual(prescriptionKey({ ...item, [field]: value }), key);
  }
  assert.deepEqual(selectFirstPlan(f.request, f.ports), selectFirstPlan(f.request, f.ports));
  f.request.candidates.push(structuredClone(f.candidate));
  assert.equal(selectFirstPlan(f.request, f.ports).gaps[0].code, 'duplicate_candidate_id');
});

test('source currentness is explicit and never inferred from retained identity', () => {
  for (const currentness of ['unknown', 'superseded', 'withdrawn']) {
    const f = fixture(); f.candidate.source = { ...source, currentness };
    assert.equal(selectFirstPlan(f.request, f.ports).gaps[0].code, 'candidate_source_not_current');
    assert.deepEqual(f.calls, []);
  }
  for (const [port, code] of [['qualifyCatalog', 'catalog_source_not_current'], ['evaluateConstraints', 'constraints_source_not_current']]) {
    const f = fixture(), original = f.ports[port];
    f.ports[port] = input => ({ ...original(input), source: { ...source, currentness: 'unknown' } });
    assert.equal(selectFirstPlan(f.request, f.ports).gaps[0].code, code);
  }
});

test('retains native qualified evidence including comparison and source lineage without projecting it away', () => {
  const f = fixture(), original = f.ports.evaluateConstraints;
  const evidence = {
    schema: 'synthetic-constraints-evidence/v1',
    value: { applied: false, binding: { rules: 'fixture-rules' }, comparison: { lostPurposes: ['synthetic-purpose'] },
      rules: [{ ruleRevision: 'fixture-rule-v2', facts: [{ id: 'fact', revision: '3' }], demandSources: [source] }] },
  };
  f.ports.evaluateConstraints = input => ({ ...original(input), evidence });
  const result = selectFirstPlan(f.request, f.ports);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.trace.candidates[0].constraints.evidence, evidence);
  result.trace.candidates[0].constraints.evidence.value.binding.rules = 'changed-copy';
  assert.equal(evidence.value.binding.rules, 'fixture-rules');
});
