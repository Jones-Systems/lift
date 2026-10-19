import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFirstPlan, prescriptionKey, normalizeSourceFirstPlanInput, sourcePrescriptionKey,
  selectSourceFirstPlan } from '../../../src/planning/first-plan/index.ts';
import { evaluateFirstPlanConstraints, evaluateSourceFirstPlanConstraints } from '../../../src/planning/constraints/first-plan-adapter.ts';
import { request as engineRequest, source, demand, rule } from './fixture.mjs';
import { sourceFixture } from '../first-plan/source-fixture.mjs';
import { readFileSync } from 'node:fs';
import { createNativeMovementCatalogFromRetained } from '../../../src/catalog-qualification/native-identity.ts';
import { projectNativeEquipmentRequirements } from '../../../src/catalog-qualification/native-equipment.ts';

// Invented accepted receipts exercise the real consumer. This factory is never an operational qualification provider.
function fixture() {
  const originalSource = { id: 'invented_candidate_source', revision: 'candidate_v1', locator: 'fixture:candidate',
    currentness: 'current', qualification: 'Synthetic metadata; no real exercise or dose qualification.' };
  const context = {
    accountId: 'account_a',
    profile: { revision: 2, goals: ['free-text goal'], trainingBackground: 'returning',
      injuryHistory: 'Private unstructured injury text; do not infer clearance.', trainingContext: 'Free-text context; not a category.' },
    preferences: { revision: 3, equipment: ['equipment_a'], sessionMinutes: 25, trainingDaysPerWeek: 2 },
  };
  const candidate = { id: 'candidate_a', qualification: 'qualified', source: originalSource,
    plan: { name: 'Artificial plan', minutes: 20, items: [
      { id: 'item_a', exerciseId: 'exercise_a', setTarget: 2, repMin: 5, repMax: 8, targetKg: 0 },
    ] } };
  const request = { context, confirmation: { accountId: 'account_a', profileRevision: 2, preferencesRevision: 3 }, candidates: [candidate] };
  const observed = [];
  const ports = {
    qualifyCatalog(input) {
      return {
        contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified',
        source: { ...originalSource, id: 'invented_catalog', revision: 'catalog_v1', locator: 'fixture:catalog' },
        items: input.candidate.plan.items.map((item) => ({ itemId: item.id, exerciseId: item.exerciseId,
          variantId: `variant_${item.id}`, prescriptionKey: prescriptionKey(item), retired: false,
          source: { ...originalSource, id: `catalog_${item.id}`, locator: `fixture:catalog/${item.id}` },
        })),
      };
    },
    evaluateConstraints(input, catalog) {
      const receipt = makeReceipt(input, catalog);
      observed.push({ input, catalog, receipt });
      return evaluateFirstPlanConstraints(input, catalog, receipt);
    },
  };
  return { request, ports, observed };
}

function makeReceipt(input, catalog) {
  const receiptSource = source('invented_operational_approval', { revision: 'receipt_v1', locator: 'fixture:independent-approval' });
  const { limits: _limits, candidates: _candidates, ...snapshot } = engineRequest();
  snapshot.binding = { ...snapshot.binding, context: input.contextKey, catalog: catalog.source.revision };
  snapshot.current = { ...snapshot.binding };
  return {
    scope: 'form.confirmed-constraint-snapshot/v1',
    contextKey: input.contextKey, candidateKey: input.candidateKey,
    accountId: input.context.accountId, profileRevision: input.context.profile.revision,
    preferencesRevision: input.context.preferences.revision, source: receiptSource,
    candidateSource: structuredClone(input.candidate.source), catalog: structuredClone(catalog),
    structuredContext: { value: 'context_a', source: source('invented_context_approval') }, snapshot,
    candidate: { id: input.candidate.id, minutes: input.candidate.plan.minutes, source: receiptSource,
      items: input.candidate.plan.items.map((item) => ({
        id: item.id, exerciseId: item.exerciseId, variantId: catalog.items.find((entry) => entry.itemId === item.id).variantId,
        prescriptionKey: prescriptionKey(item), equipment: ['equipment_a'], contexts: ['context_a'],
        purposes: ['invented-purpose-a'], demands: [demand()],
      })),
    },
  };
}

function withReceipt(f, change) {
  f.ports.evaluateConstraints = (input, catalog) => {
    const receipt = makeReceipt(input, catalog);
    return evaluateFirstPlanConstraints(input, catalog, change(receipt, input, catalog));
  };
}

function codes(result) {
  return result.status === 'ready' ? [] : result.gaps.map((gap) => gap.code);
}

test('actual selectFirstPlan consumes the adapter and preserves exact plan plus complete native evidence', () => {
  const f = fixture();
  const result = selectFirstPlan(f.request, f.ports);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.plan, f.request.candidates[0].plan);
  const decision = result.trace.candidates[0].constraints;
  assert.equal(decision.contextKey, result.trace.contextKey);
  assert.equal(decision.candidateKey, result.trace.candidates[0].candidateKey);
  assert.equal(decision.rules[0].outcome, 'satisfied');
  assert.equal(decision.evidence.schema, 'form.constraints.first-plan-adapter/v1');
  const native = decision.evidence.value;
  assert.equal(native.evaluation.candidates[0].rules[0].outcome, 'matched');
  assert.equal(native.evaluation.applied, false);
  assert.deepEqual(native.candidateSource, f.request.candidates[0].source);
  assert.equal(native.qualificationScope, 'form.confirmed-constraint-snapshot/v1');
  assert.notEqual(native.receiptSource.id, native.candidateSource.id);
  assert.deepEqual(native.catalogItems, f.observed[0].catalog.items);
  assert(!JSON.stringify(result.trace).includes(f.request.context.profile.injuryHistory));
  assert(!JSON.stringify(result.trace).includes(f.request.context.profile.trainingContext));
});

test('confirmed preference time and equipment override any conflicting receipt extras', () => {
  for (const [mutate, expected] of [
    [f => { f.request.context.preferences.sessionMinutes = 15; }, 'time_exceeded'],
    [f => { f.request.context.preferences.equipment = []; }, 'equipment_missing'],
  ]) {
    const f = fixture(); mutate(f);
    withReceipt(f, receipt => {
      receipt.snapshot.limits = { maxMinutes: 180, equipment: ['equipment_a'], context: 'context_a' };
      return receipt;
    });
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, 'infeasible'); assert(codes(result).includes(expected));
  }
  const duplicate = fixture(); duplicate.request.context.preferences.equipment.push('equipment_a');
  assert.equal(selectFirstPlan(duplicate.request, duplicate.ports).status, 'ready');
});

test('free-text context never supplies a missing or unqualified categorical context', () => {
  for (const [change, expected] of [
    [receipt => { receipt.structuredContext = null; }, 'context_unknown'],
    [receipt => { receipt.structuredContext.source.currentness = 'superseded'; }, 'constraint_structured_context_unqualified'],
    [receipt => { receipt.structuredContext.source.qualification = 'hypothesis'; }, 'constraint_structured_context_unqualified'],
    [receipt => { receipt.structuredContext.source.locator = ''; }, 'constraint_structured_context_unqualified'],
  ]) {
    const f = fixture(); f.request.context.profile.trainingContext = 'context_a';
    withReceipt(f, receipt => { change(receipt); return receipt; });
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, 'blocked'); assert(codes(result).includes(expected));
  }
});

test('missing qualified receipts and actual catalog gaps remain blocked rather than inferred from labels', () => {
  const missing = fixture();
  missing.ports.evaluateConstraints = (input, catalog) => evaluateFirstPlanConstraints(input, catalog, null);
  assert(codes(selectFirstPlan(missing.request, missing.ports)).includes('constraint_receipt_unavailable'));
  const catalogGap = fixture();
  catalogGap.ports.qualifyCatalog = input => ({ contextKey: input.contextKey, candidateKey: input.candidateKey,
    status: 'unknown', reasons: [{ code: 'variant_unmapped' }, { code: 'prescription_applicability_unqualified' }] });
  const result = selectFirstPlan(catalogGap.request, catalogGap.ports);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(codes(result), ['variant_unmapped', 'prescription_applicability_unqualified']);
  assert.deepEqual(catalogGap.observed, []);
});

test('every receipt identity is bound to the exact account, revisions and current candidate', () => {
  const changes = [
    ['contextKey', 'stale', 'constraint_receipt_binding_mismatch'],
    ['candidateKey', 'stale', 'constraint_receipt_binding_mismatch'],
    ['accountId', 'other_account', 'constraint_receipt_context_mismatch'],
    ['profileRevision', 100, 'constraint_receipt_context_mismatch'],
    ['preferencesRevision', 100, 'constraint_receipt_context_mismatch'],
  ];
  for (const [field, value, expected] of changes) {
    const f = fixture(); withReceipt(f, receipt => ({ ...receipt, [field]: value }));
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, 'blocked'); assert(codes(result).includes(expected));
  }
});

test('receipt replay after free-text edits or changed doses cannot reuse an earlier decision', () => {
  for (const change of [
    f => { f.request.context.profile.trainingContext = 'changed same-revision text'; },
    f => { f.request.candidates[0].plan.items[0].targetKg = 1; },
  ]) {
    const f = fixture(); assert.equal(selectFirstPlan(f.request, f.ports).status, 'ready');
    const oldReceipt = f.observed[0].receipt;
    change(f);
    f.ports.evaluateConstraints = (input, catalog) => evaluateFirstPlanConstraints(input, catalog, oldReceipt);
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, 'blocked'); assert(codes(result).includes('constraint_receipt_binding_mismatch'));
  }
});

test('independent accepted applicability cannot be replaced by relabeling an inherited source', () => {
  for (const qualification of ['hypothesis', 'creator_assertion', 'unreviewed']) {
    const f = fixture(); f.request.candidates[0].source.qualification = qualification;
    withReceipt(f, receipt => {
      receipt.source = { ...receipt.candidateSource, qualification: 'qualified' };
      receipt.candidate.source = receipt.source;
      return receipt;
    });
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, 'blocked'); assert(codes(result).includes('constraint_qualification_lineage_invalid'));
  }
  for (const change of [
    receipt => { receipt.scope = 'identity_only'; },
    receipt => { receipt.source.qualification = 'unreviewed'; },
    receipt => { receipt.source.currentness = 'unknown'; },
  ]) {
    const f = fixture(); withReceipt(f, receipt => { change(receipt); return receipt; });
    assert(codes(selectFirstPlan(f.request, f.ports)).includes('constraint_receipt_not_qualified_current'));
  }
});

test('candidate and catalog source qualifications and inventory revisions stay exact', () => {
  for (const [change, expected] of [
    [receipt => { receipt.candidateSource.qualification = 'changed claim'; }, 'constraint_receipt_candidate_mismatch'],
    [receipt => { receipt.catalog.source.qualification = 'changed claim'; }, 'constraint_receipt_catalog_mismatch'],
    [receipt => { receipt.catalog.items[0].source.qualification = 'changed claim'; }, 'constraint_receipt_item_mismatch'],
    [receipt => { receipt.snapshot.binding.catalog = 'unrelated'; receipt.snapshot.current.catalog = 'unrelated'; }, 'constraint_receipt_catalog_mismatch'],
    [receipt => { receipt.snapshot.current.catalog = 'newer_inventory'; }, 'stale_binding'],
    [receipt => { receipt.candidate.minutes = 5; }, 'constraint_receipt_candidate_mismatch'],
  ]) {
    const f = fixture(); withReceipt(f, receipt => { change(receipt); return receipt; });
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, 'blocked'); assert(codes(result).includes(expected));
  }
});

test('receipt item metadata must cover exact catalog variants and canonical prescription keys', () => {
  for (const [change, expected] of [
    [receipt => { receipt.candidate.items = []; }, 'constraint_receipt_items_incomplete'],
    [receipt => { receipt.catalog.items.push(receipt.catalog.items[0]); }, 'constraint_receipt_items_incomplete'],
    [receipt => { receipt.candidate.items[0].variantId = 'inferred_variant'; }, 'constraint_receipt_item_mismatch'],
    [receipt => { receipt.candidate.items[0].prescriptionKey = 'identity_without_dose'; }, 'constraint_receipt_item_mismatch'],
    [receipt => { receipt.catalog.items[0].source.currentness = 'withdrawn'; }, 'constraint_receipt_item_mismatch'],
  ]) {
    const f = fixture(); withReceipt(f, receipt => { change(receipt); return receipt; });
    assert(codes(selectFirstPlan(f.request, f.ports)).includes(expected));
  }
  const f = fixture(); selectFirstPlan(f.request, f.ports);
  const { input, catalog, receipt } = structuredClone(f.observed[0]);
  input.candidate.plan.items[0].repMin++;
  assert.equal(evaluateFirstPlanConstraints(input, catalog, receipt).reasons[0].code, 'constraint_receipt_item_mismatch');
});

test('actual consumer retains preflight, currentness and coverage holds from the pure evaluator', () => {
  for (const [change, expected] of [
    [receipt => { receipt.snapshot.preflight.complete = false; }, 'preflight_unavailable'],
    [receipt => { receipt.snapshot.preflight.regions[0].route = 'unknown'; }, 'regional_route_blocks'],
    [receipt => { receipt.snapshot.rules = []; }, 'restriction_coverage_incomplete'],
    [receipt => { receipt.snapshot.current.rules = 'new'; }, 'stale_binding'],
    [receipt => { receipt.snapshot.facts[0].source.currentness = 'withdrawn'; }, 'required_fact_unknown'],
  ]) {
    const f = fixture(); withReceipt(f, receipt => { change(receipt); return receipt; });
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, 'blocked'); assert(codes(result).includes(expected));
    assert.deepEqual(result.trace.candidates[0].constraints.evidence.value.evaluation.eligibleCandidateIds, []);
  }
});

test('hard locks, demand failures and unknowns retain the correct first-plan result', () => {
  for (const [change, expected, status] of [
    [receipt => { receipt.snapshot.locks = [{ itemId: 'item_a', variantId: 'variant_item_a', prescriptionKey: 'previous_dose' }]; }, 'lock_conflict', 'infeasible'],
    [receipt => { receipt.candidate.items[0].demands[0].value = 100; }, 'demand_mismatch', 'infeasible'],
    [receipt => { receipt.candidate.items[0].demands = []; }, 'demand_unknown', 'blocked'],
  ]) {
    const f = fixture(); withReceipt(f, receipt => { change(receipt); return receipt; });
    const result = selectFirstPlan(f.request, f.ports);
    assert.equal(result.status, status); assert(codes(result).includes(expected));
  }
});

test('not-applicable traces stay in native evidence without becoming unsatisfied consumer rules', () => {
  const f = fixture();
  withReceipt(f, receipt => {
    receipt.snapshot.rules.push(rule({ id: 'other_variant_only', variantIds: ['another_variant'], effect: { kind: 'exclude' } }));
    receipt.snapshot.preflight.restrictionCoverage.ruleIds.push('other_variant_only');
    return receipt;
  });
  const result = selectFirstPlan(f.request, f.ports);
  assert.equal(result.status, 'ready');
  const decision = result.trace.candidates[0].constraints;
  assert.equal(decision.rules.length, 1);
  assert.equal(decision.evidence.value.evaluation.candidates[0].rules[1].outcome, 'not_applicable');
});

test('adapter leaves caller data unchanged and malformed receipts produce an explicit unknown', () => {
  const f = fixture(); const before = structuredClone(f.request);
  assert.equal(selectFirstPlan(f.request, f.ports).status, 'ready');
  assert.deepEqual(f.request, before);
  const captured = f.observed[0], original = structuredClone(captured);
  const decision = evaluateFirstPlanConstraints(captured.input, captured.catalog, captured.receipt);
  decision.evidence.value.evaluation.routing.source.id = 'changed_output';
  assert.deepEqual(captured, original);
  withReceipt(f, receipt => { receipt.candidate.items[0].demands[0].value = NaN; return receipt; });
  const result = selectFirstPlan(f.request, f.ports);
  assert.equal(result.status, 'blocked'); assert(codes(result).includes('constraint_receipt_invalid'));
});

// The producer and retained registration bytes are real; active rows, applicability, demands and R1 remain synthetic.
function sourceAdapterFixture(change = () => {}) {
  const f = sourceFixture(); change(f);
  const normalized = normalizeSourceFirstPlanInput({ context: f.context, confirmation: f.confirmation, candidate: f.candidate });
  assert.equal(normalized.status, 'valid');
  const input = normalized.input, proof = f.ports.qualifyCatalog(input);
  const catalog = { ...proof, source: { ...proof.source }, items: proof.items.map(item => ({ ...item, source: { ...item.source } })) };
  const receiptSource = source('invented-source-format-acceptance');
  const { limits: _limits, candidates: _candidates, ...snapshot } = engineRequest();
  snapshot.binding = { ...snapshot.binding, context: input.contextKey, catalog: catalog.source.revision };
  snapshot.current = { ...snapshot.binding };
  const receipt = { scope: 'form.confirmed-constraint-snapshot/v1', contextKey: input.contextKey, candidateKey: input.candidateKey,
    accountId: input.context.accountId, profileRevision: input.context.profile.revision,
    preferencesRevision: input.context.preferences.revision, source: receiptSource,
    candidateSource: structuredClone(input.candidate.source), catalog: structuredClone(catalog),
    structuredContext: { value: 'context_a', source: source('invented-source-context') }, snapshot,
    candidate: { id: input.candidate.id, minutes: input.comparisonMinutes, source: receiptSource,
      items: input.candidate.plan.items.map(item => ({ id: item.id, exerciseId: item.registeredDomain.exerciseId,
        variantId: item.registeredDomain.variantId, prescriptionKey: sourcePrescriptionKey(item),
        equipment: ['machine'], contexts: ['context_a'], purposes: ['invented-purpose-a'], demands: [demand()] })) } };
  f.ports.evaluateConstraints = (actual, proof) => evaluateSourceFirstPlanConstraints(actual, proof, receipt);
  return { ...f, input, catalog, receipt, decide: () => evaluateSourceFirstPlanConstraints(input, catalog, receipt),
    select: () => selectSourceFirstPlan(f.selection, f.ports) };
}

test('actual fallback producer and source selector retain the complete native plan through constraints', () => {
  const f = sourceAdapterFixture(), before = structuredClone({ input: f.input, catalog: f.catalog, receipt: f.receipt });
  const result = f.select(); assert.equal(result.status, 'ready'); assert.deepEqual(result.plan, f.candidate.plan);
  const decision = result.trace.candidates[0].constraints, native = decision.evidence.value;
  assert.equal(decision.evidence.schema, 'form.constraints.source-first-plan-adapter/v1');
  assert.equal(native.sourceFormat, 'form.source-prescription-evaluation/v1');
  assert.equal(native.qualificationScope, 'form.confirmed-constraint-snapshot/v1');
  assert.deepEqual(native.sourcePlan, f.input.candidate.plan);
  assert.deepEqual(native.sourcePlan.duration, { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 });
  assert.equal(native.comparisonMinutes, 25); assert.equal(native.comparisonBasis, 'estimated-duration-upper-bound');
  const task = native.sourcePlan.items.find(item => item.native.exercise_id === 'dead-bug');
  assert.equal(Object.hasOwn(task.native, 'rep_range'), false); assert.equal(Object.hasOwn(task.native, 'target_rir'), false);
  assert.deepEqual(task.load, { kind: 'unspecified', basis: 'unknown' });
  assert.deepEqual(native.catalogItems, f.catalog.items);
  assert.equal(native.evaluation.candidates[0].rules.length, 4);
  assert.equal(native.evaluation.applied, false);
  native.sourcePlan.items[0].native.sets = 19;
  assert.deepEqual({ input: f.input, catalog: f.catalog, receipt: f.receipt }, before);
});

test('source input format and constructor bindings cannot be forged or partially supplied', () => {
  for (const change of [
    input => { delete input.format; }, input => { input.format = 'form-candidate-v1'; },
    input => { input.contextKey = 'other'; }, input => { input.candidateKey = 'other'; },
    input => { input.context.profile.trainingContext += ' changed'; },
    input => { input.comparisonMinutes = 15; }, input => { delete input.comparisonMinutes; },
    input => { input.prescriptions = []; }, input => { input.prescriptions.push(input.prescriptions[0]); },
    input => { input.prescriptions[0].prescriptionKey = 'form-prescription-v1:legacy'; },
  ]) {
    const f = sourceAdapterFixture(), input = structuredClone(f.input); change(input);
    const decision = evaluateSourceFirstPlanConstraints(input, f.catalog, f.receipt);
    assert.equal(decision.status, 'unknown'); assert.equal(decision.reasons[0].code, 'constraint_source_binding_mismatch');
  }
});

test('legacy and source adapters reject the other format while legacy evidence stays unchanged', () => {
  const legacy = fixture(); assert.equal(selectFirstPlan(legacy.request, legacy.ports).status, 'ready');
  const captured = legacy.observed[0], f = sourceAdapterFixture();
  assert.equal(evaluateSourceFirstPlanConstraints(captured.input, captured.catalog, captured.receipt).status, 'unknown');
  assert.equal(evaluateFirstPlanConstraints(f.input, f.catalog, f.receipt).status, 'unknown');
  const decision = evaluateFirstPlanConstraints(captured.input, captured.catalog, captured.receipt);
  assert.equal(decision.status, 'eligible'); assert.equal(decision.evidence.schema, 'form.constraints.first-plan-adapter/v1');
  assert.equal(Object.hasOwn(decision.evidence.value, 'sourcePlan'), false);
  assert.deepEqual(evaluateFirstPlanConstraints(captured.input, captured.catalog, null).evidence,
    { schema: 'form.constraints.first-plan-adapter/v1', value: { status: 'unavailable', gap: 'constraint_receipt_unavailable', applied: false } });
  assert.equal(evaluateSourceFirstPlanConstraints(f.input, f.catalog, null).evidence.schema, 'form.constraints.source-first-plan-adapter/v1');
});

test('whole source plan changes invalidate old receipts including every native and registration field', () => {
  const changes = [
    plan => { plan.name += ' revised'; }, plan => { plan.origin.id += '-other'; }, plan => { plan.origin.revision = '2'; },
    plan => { plan.duration.minMinutes++; }, plan => { plan.duration.maxMinutes++; }, plan => { plan.items.reverse(); },
    plan => { plan.items[0].id += '-other'; }, plan => { plan.items[0].native.movement_pattern = 'other'; },
    plan => { plan.items[0].native.role = 'warmup'; }, plan => { plan.items[0].native.sets++; },
    plan => { plan.items[0].native.rest_seconds++; }, plan => { plan.items[0].native.rep_range[0]++; },
    plan => { plan.items[0].native.rep_range[1]++; }, plan => { delete plan.items[0].native.rep_range; },
    plan => { plan.items[0].native.target_rir++; }, plan => { delete plan.items[0].native.target_rir; },
    plan => { plan.items[0].native.notes = ['Original additional wording']; },
    plan => { plan.items[0].native.substituted_for = 'other'; },
    plan => { plan.items[0].registeredDomain.exerciseId = 'other'; },
    plan => { plan.items[0].registeredDomain.variantId = 'other'; },
    ...['repository', 'revision', 'path'].map(field => plan => { plan.items[0].registeredDomain.identity[field] = 'other'; }),
    plan => { plan.items[0].registeredDomain.identity.sha256 = 'c'.repeat(64); },
    plan => { plan.items[0].native.exercise_id = 'other'; plan.items[0].registeredDomain.identity.nativeId = 'other'; },
    ...['id', 'revision'].map(field => plan => { plan.items[0].registeredDomain.registration[field] = 'other'; }),
    plan => { plan.items[0].registeredDomain.registration.digest = 'c'.repeat(64); },
    plan => { plan.items[0].registeredDomain.registration.bytes++; },
    plan => { plan.items[0].registeredDomain.recordDigest = 'c'.repeat(64); },
  ];
  for (const change of changes) {
    const f = sourceAdapterFixture(), altered = structuredClone(f.input); change(altered.candidate.plan);
    assert.equal(evaluateSourceFirstPlanConstraints(altered, f.catalog, f.receipt).reasons[0].code, 'constraint_source_binding_mismatch');
    const normalized = normalizeSourceFirstPlanInput({ context: altered.context, confirmation: f.confirmation, candidate: altered.candidate });
    assert.equal(normalized.status, 'valid'); assert.notEqual(normalized.input.candidateKey, f.input.candidateKey);
    assert.equal(evaluateSourceFirstPlanConstraints(normalized.input, f.catalog, f.receipt).reasons[0].code, 'constraint_receipt_binding_mismatch');
  }
});

test('missing or invented source load and invalid optional fields remain unknown without coercion', () => {
  for (const change of [
    item => { delete item.load; }, item => { item.load = null; }, item => { item.load = { targetKg: 0 }; },
    item => { item.load = { kind: 'unspecified', basis: 'bodyweight' }; },
    item => { item.native.rep_range = undefined; }, item => { item.registeredDomain.identity.nativeId = 'different'; },
  ]) {
    const f = sourceAdapterFixture(), input = structuredClone(f.input); change(input.candidate.plan.items[0]);
    const result = evaluateSourceFirstPlanConstraints(input, f.catalog, f.receipt);
    assert.equal(result.status, 'unknown'); assert.equal(result.reasons[0].code, 'constraint_source_input_invalid');
  }
});

test('source catalog proof must match exact registered variants even when all receipt copies agree', () => {
  for (const field of ['exerciseId', 'variantId', 'prescriptionKey']) {
    const f = sourceAdapterFixture();
    f.catalog.items[0][field] = 'other'; f.receipt.catalog.items[0][field] = 'other'; f.receipt.candidate.items[0][field] = 'other';
    assert.equal(f.decide().reasons[0].code, 'constraint_receipt_item_mismatch', field);
  }
  const reordered = sourceAdapterFixture(); reordered.receipt.candidate.items.reverse();
  assert.equal(reordered.decide().reasons[0].code, 'constraint_receipt_item_mismatch');
});

test('source time compares only the upper estimate and equipment remains accepted metadata', () => {
  const tight = sourceAdapterFixture(f => { f.context.preferences.sessionMinutes = 20; });
  assert.equal(tight.select().status, 'infeasible'); assert(codes(tight.select()).includes('time_exceeded'));
  const absent = sourceAdapterFixture(f => { f.context.preferences.equipment = ['bodyweight', 'wall']; });
  assert(codes(absent.select()).includes('equipment_missing'));
  const forged = sourceAdapterFixture(); forged.receipt.candidate.minutes = 15;
  assert.equal(forged.decide().reasons[0].code, 'constraint_receipt_candidate_mismatch');
  const unknown = sourceAdapterFixture(); unknown.receipt.candidate.items[0].equipment = null;
  assert(unknown.decide().reasons.some(reason => reason.code === 'equipment_unknown'));
  assert.deepEqual(tight.input.candidate.plan.duration, { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 });
});

test('source constraints retain authority, catalog currentness, R1, coverage and context holds', () => {
  for (const [change, expected] of [
    [f => { f.receipt.source.qualification = 'unreviewed'; }, 'constraint_receipt_not_qualified_current'],
    [f => { f.receipt.source = { ...f.input.candidate.source, qualification: 'qualified' }; f.receipt.candidate.source = f.receipt.source; }, 'constraint_qualification_lineage_invalid'],
    [f => { f.receipt.candidateSource.qualification = 'changed'; }, 'constraint_receipt_candidate_mismatch'],
    [f => { f.receipt.catalog.source.qualification = 'changed'; }, 'constraint_receipt_catalog_mismatch'],
    [f => { f.catalog.items[0].source.currentness = 'withdrawn'; }, 'constraint_receipt_item_mismatch'],
    [f => { f.receipt.snapshot.current.catalog = 'new'; }, 'stale_binding'],
    [f => { f.receipt.snapshot.preflight.complete = false; }, 'preflight_unavailable'],
    [f => { f.receipt.snapshot.preflight.trainingState = 'urgent'; }, 'training_route_blocks'],
    [f => { f.receipt.snapshot.rules = []; }, 'restriction_coverage_incomplete'],
    [f => { f.receipt.structuredContext = null; }, 'context_unknown'],
  ]) {
    const f = sourceAdapterFixture(); change(f); const decision = f.decide();
    assert.equal(decision.status, 'unknown'); assert(decision.reasons.some(reason => reason.code === expected), expected);
  }
});

test('source identities cannot replace demands, purposes or exact prescription locks', () => {
  for (const [change, expected, status] of [
    [f => { f.receipt.candidate.items[0].demands = []; }, 'demand_unknown', 'unknown'],
    [f => { f.receipt.candidate.items[0].demands[0].value = 100; }, 'demand_mismatch', 'excluded'],
    [f => { f.receipt.snapshot.purposes.required = ['unsupported-purpose']; }, 'required_purpose_missing', 'excluded'],
    [f => { const item = f.receipt.candidate.items[0]; f.receipt.snapshot.locks = [{ itemId: item.id, variantId: item.variantId, prescriptionKey: 'old-dose' }]; }, 'lock_conflict', 'excluded'],
  ]) {
    const f = sourceAdapterFixture(); change(f);
    f.receipt.snapshot.preferences = [{ id: 'favorite', kind: 'favorite', variantIds: f.receipt.candidate.items.map(item => item.variantId) }];
    const decision = f.decide(); assert.equal(decision.status, status);
    assert(decision.reasons.some(reason => reason.code === expected), expected);
  }
});

test('source native evidence preserves non-applicable rule traces without promoting their outcome', () => {
  const f = sourceAdapterFixture();
  f.receipt.snapshot.rules.push(rule({ id: 'unrelated', variantIds: ['unrelated'], effect: { kind: 'exclude' } }));
  f.receipt.snapshot.preflight.restrictionCoverage.ruleIds.push('unrelated');
  const decision = f.decide(); assert.equal(decision.status, 'eligible');
  assert.equal(decision.rules.length, 4);
  const full = decision.evidence.value.evaluation.candidates[0].rules;
  assert.equal(full.filter(trace => trace.ruleId === 'unrelated' && trace.outcome === 'not_applicable').length, 4);
  assert.deepEqual(decision.evidence.value.sourcePlan, f.input.candidate.plan);
});

const equipmentRoot = new URL('../../../../../', import.meta.url);
const equipmentCatalog = createNativeMovementCatalogFromRetained(readFileSync(new URL(
  'sources/businesslessons/core/research/form-knowledge-campaign-2026-10-01/inventory/legacy-movement-engine.json', equipmentRoot)));
const equipmentRegistration = JSON.parse(readFileSync(new URL(
  'docs/knowledge/catalog-cues/registrations/native-engine-v1.candidate.json', equipmentRoot), 'utf8'));

// Only equipment and retained registration bytes are authentic. Active rows, prescriptions, metadata acceptance and R1 are synthetic.
function groupedSourceAdapterFixture(nativeId = 'farmer-carry', available = ['dumbbell']) {
  const f = sourceAdapterFixture(original => {
    const entry = equipmentRegistration.entries.find(entry => entry.sourceIdentity.nativeId === nativeId);
    assert(entry, 'Withheld collisions cannot become fixture registrations');
    const planItem = original.candidate.plan.items[0], variant = equipmentCatalog.get(nativeId);
    planItem.native.exercise_id = nativeId;
    planItem.registeredDomain = { ...planItem.registeredDomain, exerciseId: entry.exerciseId,
      identity: structuredClone(variant.identity), variantId: variant.variantId, recordDigest: entry.recordDigest };
    original.context.preferences.equipment = ['bodyweight', 'wall', 'machine', ...available];
  });
  for (let index = 0; index < f.receipt.candidate.items.length; index++) {
    const planItem = f.input.candidate.plan.items[index], metadata = f.receipt.candidate.items[index];
    metadata.equipment = { ...structuredClone(projectNativeEquipmentRequirements(equipmentCatalog, planItem.native.exercise_id)),
      operationalSource: structuredClone(f.receipt.source) };
  }
  return f;
}

function groupedTrace(f) { return f.decide().evidence.value.evaluation.candidates[0].equipmentTrace[0]; }

test('actual source selector evaluates authentic carry OR and rowing AND without aliases or selected members', () => {
  for (const available of [['dumbbell'], ['kettlebell'], ['dumbbell', 'kettlebell']]) {
    const f = groupedSourceAdapterFixture('farmer-carry', available), result = f.select();
    assert.equal(result.status, 'ready'); assert.deepEqual(result.plan, f.candidate.plan);
    const trace = groupedTrace(f); assert.equal(trace.outcome, 'matched');
    assert.deepEqual(trace.requirements.required, []);
    assert.deepEqual(trace.requirements.alternatives, [['dumbbell', 'kettlebell']]);
    assert.deepEqual(trace.alternativeGroups[0].availableMembers, available);
  }
  for (const id of ['farmer-carry', 'suitcase-carry']) {
    for (const available of [[], ['dumbbells'], ['Dumbbell']]) {
      const f = groupedSourceAdapterFixture(id, available);
      assert.equal(f.select().status, 'infeasible'); assert.equal(groupedTrace(f).outcome, 'missing');
    }
  }
  const row = groupedSourceAdapterFixture('one-arm-dumbbell-row', ['dumbbell', 'bench']);
  assert.equal(row.select().status, 'ready'); assert.deepEqual(groupedTrace(row).requirements.required, ['dumbbell', 'bench']);
  for (const available of [['dumbbell'], ['bench'], ['dumbbells', 'bench'], []]) {
    assert.equal(groupedSourceAdapterFixture('one-arm-dumbbell-row', available).select().status, 'infeasible');
  }
});

test('existing receipt authority accepts every group value; multiple groups each need a match', () => {
  const f = groupedSourceAdapterFixture('farmer-carry', ['dumbbell']);
  // Explicitly synthetic extra group attested as part of this exact receipt candidate, not retained source evidence.
  f.receipt.candidate.items[0].equipment.alternatives.push(['synthetic-support-a', 'synthetic-support-b']);
  assert.equal(f.decide().status, 'excluded');
  assert.deepEqual(groupedTrace(f).missingAlternativeGroups, [['synthetic-support-a', 'synthetic-support-b']]);
  // Rebuild a separately confirmed synthetic receipt for the changed equipment context rather than replaying old acceptance.
  const fresh = groupedSourceAdapterFixture('farmer-carry', ['dumbbell', 'synthetic-support-b']);
  fresh.receipt.candidate.items[0].equipment.alternatives.push(['synthetic-support-a', 'synthetic-support-b']);
  assert.equal(fresh.select().status, 'ready');
  assert.deepEqual(groupedTrace(fresh).alternativeGroups.map(group => group.availableMembers), [['dumbbell'], ['synthetic-support-b']]);
});

test('normalized native identity binds all five fields and variant even when receipt and catalog copies agree', () => {
  const mutations = [
    ...['repository', 'path'].map(field => grouped => { grouped.native.identity[field] += '-other'; }),
    grouped => { grouped.native.identity.sha256 = 'b'.repeat(64); },
    grouped => { grouped.native.identity.revision += '-other'; grouped.native.variantId = `movement-engine:${grouped.native.identity.revision}:${grouped.native.identity.nativeId}`; },
    grouped => { grouped.native.identity.nativeId = 'different-native'; grouped.native.variantId = `movement-engine:${grouped.native.identity.revision}:different-native`; },
  ];
  for (const mutate of mutations) {
    const f = groupedSourceAdapterFixture(); mutate(f.receipt.candidate.items[0].equipment);
    const decision = f.decide(); assert.equal(decision.status, 'unknown');
    assert.equal(decision.reasons[0].code, 'constraint_equipment_identity_mismatch');
    assert.equal(decision.evidence.value.evaluation, undefined);
  }
  const variant = groupedSourceAdapterFixture();
  variant.receipt.candidate.items[0].equipment.native.variantId = 'other';
  assert.equal(variant.decide().reasons[0].code, 'constraint_receipt_invalid');
  for (const field of ['id', 'exerciseId', 'variantId', 'prescriptionKey']) {
    const f = groupedSourceAdapterFixture(); f.receipt.candidate.items[0][field] = 'consistent-altered';
    if (field !== 'id') {
      f.receipt.catalog.items[0][field] = 'consistent-altered'; f.catalog.items[0][field] = 'consistent-altered';
    } else {
      f.receipt.catalog.items[0].itemId = 'consistent-altered'; f.catalog.items[0].itemId = 'consistent-altered';
    }
    assert.equal(f.decide().reasons[0].code, 'constraint_receipt_item_mismatch');
  }
  assert.equal(equipmentRegistration.entries.some(entry => entry.sourceIdentity.nativeId === 'goblet-squat'), false);
});

test('detached operational SourceRef values match only the independent current qualified receipt source', () => {
  const detached = groupedSourceAdapterFixture();
  assert.notEqual(detached.receipt.candidate.items[0].equipment.operationalSource, detached.receipt.source);
  assert.equal(detached.select().status, 'ready');
  for (const mutate of [
    grouped => { grouped.operationalSource = null; },
    ...['id', 'revision', 'locator'].map(field => grouped => { grouped.operationalSource[field] += '-other'; }),
    ...['unknown', 'superseded', 'withdrawn'].map(state => grouped => { grouped.operationalSource.currentness = state; }),
    ...['unreviewed', 'hypothesis', 'creator_assertion', 'accepted_instruction'].map(qualification => grouped => { grouped.operationalSource.qualification = qualification; }),
  ]) {
    const f = groupedSourceAdapterFixture(); mutate(f.receipt.candidate.items[0].equipment);
    assert.equal(f.decide().status, 'unknown'); assert.equal(groupedTrace(f).outcome, 'unknown');
    assert(f.decide().reasons.some(reason => reason.code === 'equipment_unknown'));
    f.receipt.snapshot.rules[0].effect = { kind: 'exclude' };
    assert.equal(f.decide().status, 'excluded'); assert(f.decide().reasons.some(reason => reason.code === 'equipment_unknown'));
  }
  const mismatched = groupedSourceAdapterFixture();
  mismatched.receipt.candidate.items[0].equipment.native.identity.path += '-other';
  mismatched.receipt.snapshot.rules[0].effect = { kind: 'exclude' };
  assert.equal(mismatched.decide().status, 'unknown');
  assert.equal(mismatched.decide().reasons[0].code, 'constraint_equipment_identity_mismatch');
  const relabeled = groupedSourceAdapterFixture();
  relabeled.receipt.source = { ...relabeled.input.candidate.source, qualification: 'qualified' };
  relabeled.receipt.candidate.source = relabeled.receipt.source;
  relabeled.receipt.candidate.items.forEach(item => { item.equipment.operationalSource = { ...relabeled.receipt.source }; });
  assert.equal(relabeled.decide().reasons[0].code, 'constraint_qualification_lineage_invalid');
});

test('grouped adapter rejects accessor fields without invoking getters and detaches decisions without freezing caller data', () => {
  let reads = 0;
  for (const target of ['equipment', 'required', 'member', 'identity', 'source']) {
    const f = groupedSourceAdapterFixture(), metadata = f.receipt.candidate.items[0], grouped = metadata.equipment;
    const [object, key] = target === 'equipment' ? [metadata, 'equipment'] : target === 'required' ? [grouped, 'required'] :
      target === 'member' ? [grouped.alternatives[0], '0'] : target === 'identity' ? [grouped.native.identity, 'sha256'] : [grouped.operationalSource, 'id'];
    Object.defineProperty(object, key, { enumerable: true, get() { reads++; throw new Error('must not read'); } });
    assert.equal(f.decide().reasons[0].code, 'constraint_receipt_invalid');
  }
  assert.equal(reads, 0);
  const f = groupedSourceAdapterFixture(), before = structuredClone(f.receipt), decision = f.decide();
  assert.deepEqual(f.receipt, before); assert.equal(Object.isFrozen(f.receipt.candidate.items[0].equipment), false);
  f.receipt.candidate.items[0].equipment.operationalSource.currentness = 'withdrawn';
  assert.equal(f.decide().status, 'unknown');
  assert.equal(decision.evidence.value.evaluation.candidates[0].equipmentTrace[0].outcome, 'matched');
  decision.evidence.value.evaluation.candidates[0].equipmentTrace[0].requirements.native.identity.path = 'changed-output';
  assert.equal(f.receipt.candidate.items[0].equipment.native.identity.path, before.candidate.items[0].equipment.native.identity.path);
});

test('legacy grouped input remains unknown and grouped source preflight traces are not evaluated', () => {
  const legacy = fixture(); selectFirstPlan(legacy.request, legacy.ports);
  const { input, catalog, receipt } = legacy.observed[0];
  const grouped = groupedSourceAdapterFixture().receipt.candidate.items[0].equipment;
  receipt.candidate.items[0].equipment = structuredClone(grouped);
  assert.equal(evaluateFirstPlanConstraints(input, catalog, receipt).status, 'unknown');
  assert.equal(evaluateFirstPlanConstraints(input, catalog, receipt).reasons[0].code, 'constraint_equipment_identity_mismatch');
  const source = groupedSourceAdapterFixture(); source.receipt.snapshot.preflight.complete = false;
  assert.equal(source.decide().status, 'unknown'); assert.equal(groupedTrace(source).outcome, 'not_evaluated');
  assert.deepEqual(source.decide().evidence.value.evaluation.candidates[0].rules, []);
  // The current confirmed-preferences owner requires an equipment array; unavailable inventory cannot be forged into one.
  const unavailable = groupedSourceAdapterFixture(), inputWithUnavailableInventory = structuredClone(unavailable.input);
  inputWithUnavailableInventory.context.preferences.equipment = null;
  const decision = evaluateSourceFirstPlanConstraints(inputWithUnavailableInventory, unavailable.catalog, unavailable.receipt);
  assert.equal(decision.status, 'unknown'); assert.equal(decision.reasons[0].code, 'constraint_source_input_invalid');
});
