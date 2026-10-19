import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFirstPlan, prescriptionKey, normalizeSourceFirstPlanInput, sourcePrescriptionKey,
  selectSourceFirstPlan } from '../../../src/planning/first-plan/index.ts';
import { evaluateFirstPlanConstraints, evaluateSourceFirstPlanConstraints } from '../../../src/planning/constraints/first-plan-adapter.ts';
import { inspectConstraintCapture, prepareConfirmedConstraintReceipt,
  prepareConfirmedSourceConstraintReceipt } from '../../../src/planning/constraints/confirmed-capture.ts';
import { source } from './fixture.mjs';
import { sourceFixture } from '../first-plan/source-fixture.mjs';
import { readFileSync } from 'node:fs';
import { createNativeMovementCatalogFromRetained } from '../../../src/catalog-qualification/native-identity.ts';
import { projectNativeEquipmentRequirements } from '../../../src/catalog-qualification/native-equipment.ts';

// These invented confirmations and R1 witnesses prove software behavior, never real routing or source adoption.
function fixture() {
  const original = source('invented-original', { qualification: 'Synthetic product metadata only.' });
  const request = { context: { accountId: 'account_a',
    profile: { revision: 2, goals: [], trainingBackground: 'returning', injuryHistory: 'Unstructured text stays unclassified.' },
    preferences: { revision: 3, equipment: [], sessionMinutes: 30, trainingDaysPerWeek: 2 } },
    confirmation: { accountId: 'account_a', profileRevision: 2, preferencesRevision: 3 },
    candidates: [{ id: 'candidate_a', qualification: 'qualified', source: original,
      plan: { name: 'Synthetic candidate', minutes: 20,
        items: [{ id: 'item_a', exerciseId: 'exercise_a', setTarget: 2, repMin: 5, repMax: 8, targetKg: 0 }] } }] };
  let input, catalog;
  const ports = {
    qualifyCatalog(value) { return { contextKey: value.contextKey, candidateKey: value.candidateKey, status: 'qualified',
      source: source('invented-catalog', { revision: 'catalog-v1', qualification: 'Synthetic applicability fixture.' }),
      items: value.candidate.plan.items.map(item => ({ itemId: item.id, exerciseId: item.exerciseId,
        variantId: 'variant_a', prescriptionKey: prescriptionKey(item), retired: false,
        source: source('invented-catalog-item', { qualification: 'Synthetic applicability fixture.' }) })) }; },
    evaluateConstraints(value, proof) {
      input = value; catalog = proof;
      return evaluateFirstPlanConstraints(value, proof, null);
    },
  };
  selectFirstPlan(request, ports);
  const questions = { id: 'invented-questions', revision: 'questions-v1', source: source('invented-question-review'),
    questions: [
      { id: 'control', revision: 'q1', prompt: 'Invented yes/no question', kind: 'yes_no', required: true },
      { id: 'locale', revision: 'q1', prompt: 'Invented text question', kind: 'text', required: true },
    ], consent: { id: 'capture-consent', revision: 'consent-v1', text: 'Invented capture consent text' } };
  const payload = {
    answers: [{ questionId: 'control', questionRevision: 'q1', response: { state: 'yes', literal: ' Yes, as asked. ' } },
      { questionId: 'locale', questionRevision: 'q1', response: { state: 'answered', literal: ' Original locale wording ' } }],
    facts: [{ id: 'history_a', kind: 'user_reported_history', wording: ' Original user statement. ',
      region: 'none', side: 'none', resolution: 'reported', reportedDate: 'as remembered', reviewDate: null }],
    restrictionInventory: { response: { state: 'no', literal: 'None reported by me at this confirmation.' }, instructionIds: [] },
    consent: { decision: 'granted', statementId: 'capture-consent', statementRevision: 'consent-v1' },
  };
  const metadataSource = source('invented-operational-metadata');
  const metadata = { source: metadataSource,
    candidate: { id: input.candidate.id, minutes: input.candidate.plan.minutes, source: metadataSource,
      items: input.candidate.plan.items.map(item => ({ id: item.id, exerciseId: item.exerciseId, variantId: 'variant_a',
        prescriptionKey: prescriptionKey(item), equipment: [], contexts: 'any', purposes: [], demands: [] })) },
    structuredContext: { value: 'invented-context', source: source('invented-context-source') },
    purposes: { required: [], preferred: [] }, locks: [], preferences: [], baseline: null };
  const variants = { source: source('invented-variant-inventory', { qualification: 'Identity only.' }),
    variants: ['variant_a', 'variant_other'].map(id => ({ id, source: source(`invented-${id}`, { qualification: 'Identity only.' }) })) };
  const f = { request, ports, input, catalog, questions, payload, metadata, variants, reads: 0, active: true };
  f.refresh = () => {
    const inspection = inspectConstraintCapture(f.payload, f.questions);
    assert.equal(inspection.status, 'captured');
    const pin = { id: 'capture_a', revision: 'capture-v1', digest: inspection.digest,
      accountId: 'account_a', sessionId: 'original-session-a', contextKey: input.contextKey,
      profileRevision: 2, preferencesRevision: 3 };
    const captureSource = { id: 'original-capture-source', revision: pin.revision, locator: 'fixture:original-capture', currentness: 'current' };
    const rawFacts = f.payload.facts;
    const exclusions = rawFacts.filter(entry => entry.kind === 'user_exclusion');
    const rules = rawFacts.filter(entry => entry.kind === 'clinician_instruction_as_reported').map(entry => ({
      id: `instruction:${entry.id}`, revision: 'rule-v1', origin: 'clinician_instruction',
      source: source('invented-instruction-acceptance', { qualification: 'accepted_instruction' }),
      factIds: [entry.id], variantIds: ['variant_other'], effect: { kind: 'exclude' },
    }));
    const revisionBinding = { context: input.contextKey, catalog: catalog.source.revision, rules: 'rules-v1', preflight: 'r1-v1' };
    const facts = rawFacts.filter(entry => entry.kind !== 'user_exclusion').map(entry => ({ id: entry.id,
      revision: pin.revision, kind: entry.kind, region: entry.region, side: entry.side, resolution: 'confirmed',
      source: source('invented-report-acceptance', { locator: `${captureSource.locator}#fact=${encodeURIComponent(entry.id)}` }) }));
    const r1 = { capture: structuredClone(pin), captureFactIds: rawFacts.map(entry => entry.id), snapshot: {
      binding: revisionBinding, current: { ...revisionBinding }, facts, requiredFactIds: rawFacts.map(entry => entry.id), rules,
      preflight: { complete: true, trainingState: 'self_directed', source: source('invented-r1-producer'),
        regions: rawFacts.filter(entry => entry.region !== 'none').map(entry => ({ region: entry.region, side: entry.side, route: 'screened_self_management' })),
        restrictionCoverage: { complete: true, ruleIds: [...rules.map(rule => rule.id), ...exclusions.map(entry => `user-exclusion:${entry.id}`)],
          instructions: rawFacts.filter(entry => entry.kind !== 'user_reported_history').map(entry => ({ factId: entry.id,
            disposition: 'mapped', ruleIds: [entry.kind === 'user_exclusion' ? `user-exclusion:${entry.id}` : `instruction:${entry.id}`] })) } },
    } };
    f.current = { capture: { pin, payload: structuredClone(f.payload), source: captureSource,
      confirmation: { id: 'actual-confirm-action-a', captureRevision: pin.revision, captureDigest: pin.digest, confirmedAt: '2026-10-11T20:00:00Z' } },
      questions: structuredClone(f.questions), variants: structuredClone(f.variants), r1 };
    f.host = { pin: structuredClone(pin), assertActive() { if (!f.active) throw new Error('Session is no longer active.'); },
      readCurrent() { f.reads++; return f.current; } };
  };
  f.prepare = () => prepareConfirmedConstraintReceipt(f.input, f.catalog, f.metadata, f.host);
  f.refresh();
  return f;
}
const gapCodes = result => result.gaps.map(gap => gap.code);
function instruction(kind = 'user_exclusion', extra = {}) {
  return { id: 'instruction_a', kind, wording: ' My exact instruction. ', region: 'invented-region', side: 'left',
    resolution: 'reported', reportedDate: null, reviewDate: 'review date as supplied',
    ...(kind === 'user_exclusion' ? { variantIds: ['variant_other'] } : {}), ...extra };
}
function addInstruction(f, entry) {
  f.payload.facts.push(entry);
  f.payload.restrictionInventory = { response: { state: 'yes', literal: 'These are my reported instructions.' }, instructionIds: [entry.id] };
  f.refresh();
}

test('literal capture preserves wording, reported dates and source distinctions without routing', () => {
  const f = fixture(); addInstruction(f, instruction('clinician_instruction_as_reported'));
  const before = structuredClone(f.payload), result = inspectConstraintCapture(f.payload, f.questions);
  assert.equal(result.status, 'captured'); assert.deepEqual(result.capture, before); assert.deepEqual(result.gaps, []);
  assert.equal(result.capture.facts[1].kind, 'clinician_instruction_as_reported');
  assert.equal(result.capture.facts[1].reviewDate, 'review date as supplied');
  assert.equal(result.trainingState, undefined); assert.equal(result.complete, undefined);
  assert.throws(() => { result.capture.facts[0].wording = 'changed'; }, TypeError);
  assert.deepEqual(f.payload, before);
});

test('public capture rejects authority flags at every structured boundary', () => {
  for (const field of ['source', 'qualified', 'qualification', 'current', 'currentness', 'complete', 'trainingState', 'route']) {
    for (const at of [value => value, value => value.facts[0], value => value.answers[0].response,
      value => value.restrictionInventory, value => value.consent]) {
      const f = fixture(); at(f.payload)[field] = true;
      assert.equal(inspectConstraintCapture(f.payload, f.questions).status, 'invalid', field);
    }
  }
});

test('every missingness reason survives capture and never becomes a negative answer', () => {
  for (const reason of ['blank', 'unclear', 'declined', 'conflicting', 'unavailable', 'unresolved']) {
    const f = fixture(); f.payload.answers[0].response = { state: 'unknown', literal: ' Original uncertain wording ', reason };
    const result = inspectConstraintCapture(f.payload, f.questions);
    assert.equal(result.status, 'captured'); assert.equal(result.capture.answers[0].response.reason, reason);
    assert(gapCodes(result).includes('capture_answer_unknown'));
    f.refresh(); const prepared = f.prepare();
    assert.equal(prepared.status, 'unavailable'); assert(gapCodes(prepared).includes('capture_answer_unknown'));
    assert.equal(prepared.evidence.capture.payload.answers[0].response.reason, reason);
  }
  const f = fixture(); f.payload.answers = [];
  assert.equal(inspectConstraintCapture(f.payload, f.questions).gaps.filter(gap => gap.code === 'capture_answer_unknown').length, 2);
});

test('trusted question revisions, response kinds, duplicate IDs and instruction inventory are exact', () => {
  for (const change of [
    f => { f.payload.answers[0].questionRevision = 'older'; },
    f => { f.payload.answers[0].response = { state: 'answered', literal: 'Yes' }; },
    f => { f.payload.answers[0].response = { state: 'no', literal: '   ' }; },
    f => { f.payload.answers.push(f.payload.answers[0]); },
    f => { f.payload.facts.push(f.payload.facts[0]); },
    f => { f.payload.restrictionInventory.instructionIds = ['not-present']; },
  ]) {
    const f = fixture(); change(f); assert.equal(inspectConstraintCapture(f.payload, f.questions).status, 'invalid');
  }
  const f = fixture(); f.questions.source.currentness = 'withdrawn';
  assert.deepEqual(gapCodes(inspectConstraintCapture(f.payload, f.questions)), ['question_inventory_unavailable']);
  const empty = fixture(); empty.questions.questions = [];
  assert.deepEqual(gapCodes(inspectConstraintCapture(empty.payload, empty.questions)), ['question_inventory_unavailable']);
});

test('unresolved fact side, wording and consent remain captured gaps', () => {
  const f = fixture();
  f.payload.facts[0] = { ...f.payload.facts[0], region: 'unknown', side: 'unknown', resolution: 'declined', wording: '' };
  f.payload.consent.decision = 'declined';
  f.payload.restrictionInventory.response = { state: 'unknown', reason: 'conflicting', literal: 'Not sure.' };
  const result = inspectConstraintCapture(f.payload, f.questions);
  assert.equal(result.status, 'captured');
  assert.deepEqual(gapCodes(result), ['capture_restriction_inventory_unknown', 'capture_fact_unresolved', 'capture_consent_unavailable']);
  assert.equal(result.capture.facts[0].side, 'unknown');
});

test('capture digest changes for wording, consent and question changes but ignores object key order', () => {
  const f = fixture(), initial = inspectConstraintCapture(f.payload, f.questions).digest;
  const reorder = Object.fromEntries(Object.entries(f.payload).reverse());
  assert.equal(inspectConstraintCapture(reorder, f.questions).digest, initial);
  for (const change of [
    f => { f.payload.facts[0].wording += ' '; },
    f => { f.payload.consent.decision = 'declined'; },
    f => { f.questions.questions[0].prompt += ' amended'; },
    f => { f.questions.revision = 'questions-v2'; },
  ]) {
    const next = fixture(); change(next);
    assert.notEqual(inspectConstraintCapture(next.payload, next.questions).digest, initial);
  }
});

test('actual first-plan consumer accepts only the assembled confirmed receipt and retains original reports', () => {
  const f = fixture(), before = structuredClone(f.current);
  const prepared = f.prepare(); assert.equal(prepared.status, 'prepared'); assert.equal(prepared.decision.status, 'eligible');
  assert(f.reads >= 2);
  f.ports.evaluateConstraints = (input, catalog) => evaluateFirstPlanConstraints(input, catalog, prepared.readCurrent());
  const result = selectFirstPlan(f.request, f.ports);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.plan, f.request.candidates[0].plan);
  assert.deepEqual(prepared.evidence.capture.payload, f.payload);
  assert(!JSON.stringify(result.trace).includes(f.payload.facts[0].wording));
  assert.deepEqual(f.current, before);
});

test('account/session/context/revision pins and explicit full-content confirmation cannot be substituted', () => {
  for (const field of ['id', 'revision', 'digest', 'accountId', 'sessionId', 'contextKey', 'profileRevision', 'preferencesRevision']) {
    const f = fixture(); f.current.capture.pin[field] = typeof f.current.capture.pin[field] === 'number' ? 99 : 'other';
    assert(gapCodes(f.prepare()).includes('confirmed_capture_binding_mismatch'), field);
  }
  for (const change of [
    f => { f.current.capture.confirmation.captureDigest = 'other'; },
    f => { f.current.capture.confirmation.captureRevision = 'other'; },
    f => { f.current.capture.source.currentness = 'withdrawn'; },
    f => { f.current.capture.confirmation.confirmedAt = 'not-a-date'; },
  ]) {
    const f = fixture(); change(f); assert(gapCodes(f.prepare()).includes('capture_confirmation_unavailable'));
  }
  const changed = fixture(); changed.current.capture.payload.facts[0].wording += ' changed';
  assert(gapCodes(changed.prepare()).includes('capture_digest_mismatch'));
});

test('actor identity and operational template metadata do not substitute for host confirmation or R1', () => {
  const missing = fixture(); missing.current.capture = null;
  assert.deepEqual(gapCodes(missing.prepare()), ['confirmed_capture_unavailable']);
  const noR1 = fixture(); noR1.current.r1 = null;
  const result = noR1.prepare(); assert.deepEqual(gapCodes(result), ['r1_witness_unavailable']);
  assert.equal(result.evidence.capture.payload.restrictionInventory.response.state, 'no');
  assert.equal(result.receipt, undefined);
  const noHost = fixture(); delete noHost.host.assertActive;
  assert.deepEqual(gapCodes(noHost.prepare()), ['capture_host_unavailable']);
});

test('exact original-capture R1 fact coverage and raw region/side/source associations cannot be rewritten', () => {
  for (const [change, expected] of [
    [f => { f.current.r1.capture.digest = 'older'; }, 'r1_capture_mismatch'],
    [f => { f.current.r1.captureFactIds = []; }, 'r1_capture_mismatch'],
    [f => { f.current.r1.snapshot.requiredFactIds = ['orphan']; }, 'r1_fact_inventory_mismatch'],
    [f => { f.current.r1.snapshot.facts = []; }, 'r1_fact_inventory_mismatch'],
    [f => { f.current.r1.snapshot.facts[0].side = 'right'; }, 'r1_fact_projection_mismatch'],
    [f => { f.current.r1.snapshot.facts[0].kind = 'clinician_instruction_as_reported'; }, 'r1_fact_projection_mismatch'],
    [f => { f.current.r1.snapshot.facts[0].source.locator = 'unrelated'; }, 'r1_fact_projection_mismatch'],
  ]) {
    const f = fixture(); change(f); assert(gapCodes(f.prepare()).includes(expected));
  }
});

test('R1 owns required-fact selection while unresolved optional history stays unknown in the full inventory', () => {
  const f = fixture(); f.payload.facts[0].resolution = 'unknown'; f.refresh();
  f.current.r1.snapshot.facts[0].resolution = 'unknown';
  f.current.r1.snapshot.requiredFactIds = [];
  const optional = f.prepare(); assert.equal(optional.status, 'prepared');
  assert.equal(optional.receipt.snapshot.facts[0].resolution, 'unknown');
  assert.equal(optional.evidence.capture.payload.facts[0].resolution, 'unknown');
  f.current.r1.snapshot.requiredFactIds = ['history_a'];
  const required = f.prepare(); assert.equal(required.status, 'unavailable');
  assert(gapCodes(required).includes('required_fact_unknown'));
});

test('explicit variant exclusions produce accepted instructions with original facts and remain hard constraints', () => {
  const f = fixture(); addInstruction(f, instruction('user_exclusion', { variantIds: ['variant_a'], side: 'bilateral' }));
  const result = f.prepare(); assert.equal(result.status, 'prepared'); assert.equal(result.decision.status, 'excluded');
  const rule = result.receipt.snapshot.rules[0], fact = result.receipt.snapshot.facts.find(entry => entry.id === 'instruction_a');
  assert.equal(rule.origin, 'user_exclusion'); assert.equal(rule.source.qualification, 'accepted_instruction');
  assert.deepEqual(rule.effect, { kind: 'exclude' }); assert.deepEqual(rule.variantIds, ['variant_a']);
  assert.equal(fact.side, 'bilateral'); assert.equal(fact.kind, 'user_exclusion');
  assert.equal(fact.source.locator, 'fixture:original-capture#fact=instruction_a');
  f.ports.evaluateConstraints = (input, catalog) => evaluateFirstPlanConstraints(input, catalog, result.receipt);
  assert.equal(selectFirstPlan(f.request, f.ports).status, 'infeasible');
});

test('unmapped or non-current exclusion identities do not become inferred restrictions', () => {
  for (const change of [
    f => { f.current.variants.variants = []; },
    f => { f.current.variants.variants[1].source.currentness = 'superseded'; },
  ]) {
    const f = fixture(); addInstruction(f, instruction()); change(f);
    assert(gapCodes(f.prepare()).includes('exclusion_variant_unavailable'));
  }
  const f = fixture(); addInstruction(f, instruction()); f.current.variants.source.currentness = 'unknown';
  assert(gapCodes(f.prepare()).includes('exclusion_variants_unavailable'));
});

test('receipt assembly cannot manufacture complete restriction coverage from a confirmed inventory', () => {
  const f = fixture(); addInstruction(f, instruction());
  f.current.r1.snapshot.preflight.restrictionCoverage.ruleIds = [];
  const result = f.prepare(); assert.equal(result.status, 'unavailable');
  assert(gapCodes(result).includes('restriction_coverage_incomplete'));
  assert.equal(result.evidence.capture.payload.restrictionInventory.response.state, 'yes');
  assert.equal(result.decision.status, 'unknown'); assert.equal(result.receipt, undefined);
});

test('authentic blocking R1 outcomes remain visible without producing an eligible receipt', () => {
  for (const state of ['urgent', 'same_day', 'clinical_review', 'safety_unknown']) {
    const f = fixture(); f.current.r1.snapshot.preflight.trainingState = state;
    const result = f.prepare(); assert.equal(result.status, 'unavailable'); assert.equal(result.decision.status, 'unknown');
    assert.equal(result.evidence.r1.snapshot.preflight.trainingState, state);
    assert.equal(result.decision.evidence.value.evaluation.routing.trainingState, state);
    assert(gapCodes(result).includes('training_route_blocks')); assert.equal(result.receipt, undefined);
  }
  const f = fixture(); f.current.r1.snapshot.preflight.source.currentness = 'withdrawn';
  assert(gapCodes(f.prepare()).includes('preflight_unavailable'));
  const regional = fixture(); addInstruction(regional, instruction());
  regional.current.r1.snapshot.preflight.regions[0].route = 'unknown';
  const result = regional.prepare(); assert.equal(result.status, 'unavailable');
  assert(gapCodes(result).includes('regional_route_blocks'));
  assert.equal(result.evidence.r1.snapshot.preflight.regions[0].route, 'unknown');
});

test('currentness re-reads capture, consent, answers, questions, variants and R1 even without profile revision changes', () => {
  for (const change of [
    f => { f.current.capture.payload.facts[0].wording += ' corrected'; },
    f => { f.current.capture.source.currentness = 'withdrawn'; },
    f => { f.current.capture.payload.consent.decision = 'declined'; },
    f => { f.current.capture.payload.answers[0].response.state = 'no'; },
    f => { f.current.questions.revision = 'newer'; },
    f => { f.current.variants.source.revision = 'newer'; },
    f => { f.current.r1.snapshot.current.preflight = 'newer'; },
    f => { f.current.capture = null; },
  ]) {
    const f = fixture(), prepared = f.prepare(); assert.equal(prepared.status, 'prepared');
    const reads = f.reads; change(f);
    assert.throws(prepared.assertCurrent, error => error.code === 'capture_witness_changed');
    assert.equal(prepared.readCurrent(), null); assert(f.reads >= reads + 2);
    assert.equal(f.input.context.profile.revision, 2);
  }
});

test('host revocation, callback changes and asynchronous witnesses invalidate the source', () => {
  const f = fixture(), prepared = f.prepare(); assert.equal(prepared.status, 'prepared');
  f.active = false; assert.equal(prepared.readCurrent(), null);
  const swapped = fixture(), prior = swapped.prepare(); swapped.host.readCurrent = () => swapped.current;
  assert.throws(prior.assertCurrent, error => error.code === 'capture_host_changed');
  for (const field of ['assertActive', 'readCurrent']) {
    const next = fixture(); next.host[field] = () => Promise.resolve(next.current);
    assert(gapCodes(next.prepare()).includes('capture_synchronous_witness_required'));
  }
});

test('withdrawal between initial capture and final read prevents returning a usable receipt', () => {
  const f = fixture(); f.host.readCurrent = () => {
    f.reads++; if (f.reads === 2) f.current.capture.payload.consent.decision = 'declined'; return f.current;
  };
  const result = f.prepare(); assert.equal(result.status, 'unavailable');
  assert.deepEqual(gapCodes(result), ['capture_witness_changed']); assert.equal(result.receipt, undefined);
});

// Actual source prescriptions and retained registrations do not qualify these invented capture, active-row or R1 witnesses.
function sourceCaptureFixture(exclude = false) {
  const original = sourceFixture(), f = fixture();
  const normalized = normalizeSourceFirstPlanInput({ context: original.context, confirmation: original.confirmation,
    candidate: original.candidate });
  assert.equal(normalized.status, 'valid');
  const input = normalized.input, catalog = original.ports.qualifyCatalog(input);
  if (exclude) addInstruction(f, instruction('user_exclusion', { variantIds: [input.candidate.plan.items[0].registeredDomain.variantId] }));
  const pin = { ...f.current.capture.pin, accountId: input.context.accountId, contextKey: input.contextKey,
    profileRevision: input.context.profile.revision, preferencesRevision: input.context.preferences.revision };
  f.current.capture.pin = structuredClone(pin); f.current.r1.capture = structuredClone(pin); f.host.pin = structuredClone(pin);
  f.current.r1.snapshot.binding = { ...f.current.r1.snapshot.binding, context: input.contextKey, catalog: catalog.source.revision };
  f.current.r1.snapshot.current = { ...f.current.r1.snapshot.binding };
  f.current.variants = { source: source('invented-current-source-variant-inventory'),
    variants: input.candidate.plan.items.map(item => ({ id: item.registeredDomain.variantId,
      source: source(`invented-current-${item.id}`, { qualification: 'Identity only.' }) })) };
  f.input = input; f.catalog = catalog;
  f.metadata.candidate = { id: input.candidate.id, minutes: input.comparisonMinutes, source: f.metadata.source,
    items: input.candidate.plan.items.map(item => ({ id: item.id, exerciseId: item.registeredDomain.exerciseId,
      variantId: item.registeredDomain.variantId, prescriptionKey: sourcePrescriptionKey(item),
      equipment: [], contexts: 'any', purposes: [], demands: [] })) };
  f.prepare = () => prepareConfirmedSourceConstraintReceipt(f.input, f.catalog, f.metadata, f.host);
  f.original = original;
  f.select = prepared => selectSourceFirstPlan(original.selection, { ...original.ports,
    evaluateConstraints: (actual, proof) => evaluateSourceFirstPlanConstraints(actual, proof, prepared.readCurrent()) });
  return f;
}

test('source capture assembles the unchanged receipt scope with complete native evidence and original literal reports', () => {
  const f = sourceCaptureFixture(), before = structuredClone(f.current), prepared = f.prepare();
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.decision.status, 'eligible');
  assert.equal(prepared.receipt.scope, 'form.confirmed-constraint-snapshot/v1');
  assert.match(prepared.receipt.candidateKey, /^form-source-candidate-v1:/);
  assert(prepared.receipt.candidate.items.every(item => item.prescriptionKey.startsWith('form-source-prescription-v1:')));
  assert.deepEqual(prepared.decision.evidence.value.sourcePlan, f.input.candidate.plan);
  assert.deepEqual(prepared.evidence.capture.payload, f.payload);
  const selected = f.select(prepared); assert.equal(selected.status, 'ready');
  assert.deepEqual(selected.plan, f.input.candidate.plan);
  assert(!JSON.stringify(selected.trace).includes(f.payload.facts[0].wording));
  assert.deepEqual(f.current, before);
});

test('capture entry points preserve legacy behavior and cannot exchange source and legacy formats', () => {
  const legacy = fixture(), original = legacy.prepare(); assert.equal(original.status, 'prepared');
  const wrongSource = prepareConfirmedSourceConstraintReceipt(legacy.input, legacy.catalog, legacy.metadata, legacy.host);
  assert.equal(wrongSource.status, 'unavailable'); assert(gapCodes(wrongSource).includes('constraint_source_input_invalid'));
  const f = sourceCaptureFixture();
  const wrongLegacy = prepareConfirmedConstraintReceipt(f.input, f.catalog, f.metadata, f.host);
  assert.equal(wrongLegacy.status, 'unavailable'); assert.equal(wrongLegacy.receipt, undefined);
  const again = legacy.prepare();
  assert.deepEqual(again.receipt, original.receipt); assert.deepEqual(again.decision, original.decision);
  assert.deepEqual(again.evidence, original.evidence);
});

test('source receipt production requires exact original capture, session, revisions and R1 association', () => {
  for (const change of [
    f => { f.current.capture.pin.accountId = 'other'; },
    f => { f.current.capture.pin.sessionId = 'other-session'; },
    f => { f.current.capture.pin.contextKey = 'other'; },
    f => { f.current.capture.pin.profileRevision++; },
    f => { f.current.capture.pin.preferencesRevision++; },
    f => { f.current.capture.confirmation.captureDigest = 'other'; },
    f => { f.current.capture.payload.facts[0].wording += ' correction'; },
    f => { f.current.r1.capture.digest = 'other'; },
    f => { f.current.r1.captureFactIds = []; },
  ]) {
    const f = sourceCaptureFixture(); change(f); const result = f.prepare();
    assert.equal(result.status, 'unavailable'); assert.equal(result.receipt, undefined);
  }
});

test('source capture cannot reuse old context or prescription bindings after a native plan edit', () => {
  for (const change of [
    input => { input.candidate.plan.items[0].native.rest_seconds++; },
    input => { input.candidate.plan.items[0].registeredDomain.registration.digest = 'c'.repeat(64); },
    input => { input.candidate.plan.duration.minMinutes++; },
    input => { input.candidate.plan.items.reverse(); },
    input => { input.context.profile.trainingContext += ' corrected'; },
  ]) {
    const f = sourceCaptureFixture(); f.input = structuredClone(f.input); change(f.input);
    assert.equal(f.prepare().status, 'unavailable');
    const normalized = normalizeSourceFirstPlanInput({ context: f.input.context, candidate: f.input.candidate,
      confirmation: f.original.confirmation });
    assert.equal(normalized.status, 'valid'); f.input = normalized.input;
    assert.equal(f.prepare().status, 'unavailable');
  }
});

test('source capture currentness consults fresh whole records even when profile and preferences are unchanged', () => {
  for (const change of [
    f => { f.current.capture.payload.consent.decision = 'declined'; },
    f => { f.current.capture.payload.answers[0].response.literal += ' corrected'; },
    f => { f.current.capture.source.currentness = 'withdrawn'; },
    f => { f.current.questions.questions[0].revision = 'newer'; },
    f => { f.current.variants.variants[0].source.currentness = 'withdrawn'; },
    f => { f.current.r1.snapshot.current.preflight = 'newer'; },
    f => { f.current.r1 = null; },
  ]) {
    const f = sourceCaptureFixture(), prepared = f.prepare(); assert.equal(prepared.status, 'prepared');
    const revisions = [f.input.context.profile.revision, f.input.context.preferences.revision], reads = f.reads;
    change(f); assert.throws(prepared.assertCurrent, error => error.code === 'capture_witness_changed');
    assert.equal(prepared.readCurrent(), null); assert(f.reads > reads);
    assert.equal(f.select(prepared).status, 'blocked');
    assert.deepEqual([f.input.context.profile.revision, f.input.context.preferences.revision], revisions);
  }
  const inactive = sourceCaptureFixture(), prepared = inactive.prepare(); inactive.active = false;
  assert.equal(prepared.readCurrent(), null);
});

test('actual source policy does not supply missing question authority, confirmation, R1 or restriction coverage', () => {
  for (const [change, expected] of [
    [f => { f.current.questions.source.qualification = 'creator_assertion'; }, 'question_inventory_unavailable'],
    [f => { f.current.capture = null; }, 'confirmed_capture_unavailable'],
    [f => { f.current.r1 = null; }, 'r1_witness_unavailable'],
    [f => { f.current.r1.snapshot.preflight.restrictionCoverage.complete = false; }, 'restriction_coverage_incomplete'],
  ]) {
    const f = sourceCaptureFixture(); change(f); const result = f.prepare();
    assert.equal(result.status, 'unavailable'); assert(gapCodes(result).includes(expected));
    assert.equal(result.receipt, undefined);
  }
  const blocked = sourceCaptureFixture(); blocked.current.r1.snapshot.preflight.trainingState = 'clinical_review';
  const result = blocked.prepare(); assert.equal(result.status, 'unavailable');
  assert.equal(result.evidence.r1.snapshot.preflight.trainingState, 'clinical_review');
  assert.equal(result.decision.evidence.value.evaluation.routing.trainingState, 'clinical_review');
  assert.deepEqual(result.decision.evidence.value.sourcePlan, blocked.input.candidate.plan);
});

test('original user exclusion of an exact source variant remains a hard exclusion through the source selector', () => {
  const f = sourceCaptureFixture(true), prepared = f.prepare();
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.decision.status, 'excluded');
  const rule = prepared.receipt.snapshot.rules[0];
  assert.equal(rule.origin, 'user_exclusion'); assert.equal(rule.source.qualification, 'accepted_instruction');
  assert.deepEqual(rule.variantIds, [f.input.candidate.plan.items[0].registeredDomain.variantId]);
  assert.equal(f.select(prepared).status, 'infeasible');
  f.current.variants.variants[0].source.currentness = 'withdrawn';
  assert.equal(prepared.readCurrent(), null);
  assert(gapCodes(f.prepare()).includes('exclusion_variant_unavailable'));
});

const captureEquipmentCatalog = createNativeMovementCatalogFromRetained(readFileSync(new URL(
  '../../../../../sources/businesslessons/core/research/form-knowledge-campaign-2026-10-01/inventory/legacy-movement-engine.json', import.meta.url)));

// Authentic grouped source metadata; all confirmation, active-row, operational and R1 witnesses remain synthetic.
function groupedCaptureFixture() {
  const f = sourceCaptureFixture();
  f.metadata.candidate.items.forEach((metadata, index) => {
    metadata.equipment = { ...structuredClone(projectNativeEquipmentRequirements(captureEquipmentCatalog,
      f.input.candidate.plan.items[index].native.exercise_id)), operationalSource: structuredClone(f.metadata.source) };
  });
  return f;
}

test('actual confirmed source capture preserves grouped provenance and independent attestation through selector', () => {
  const f = groupedCaptureFixture(), before = structuredClone(f.metadata), prepared = f.prepare();
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.decision.status, 'eligible');
  assert.equal(f.select(prepared).status, 'ready');
  const traces = prepared.decision.evidence.value.evaluation.candidates[0].equipmentTrace;
  assert.equal(traces.length, 4); assert(traces.every(trace => trace.outcome === 'matched'));
  assert.deepEqual(traces[0].requirements, before.candidate.items[0].equipment);
  assert.deepEqual(f.metadata, before); assert.equal(Object.isFrozen(f.metadata.candidate.items[0].equipment), false);
  f.metadata.candidate.items[0].equipment.required.push('mutated-after-capture');
  assert.deepEqual(prepared.readCurrent().candidate.items[0].equipment, before.candidate.items[0].equipment);
  f.current.capture.source.currentness = 'withdrawn'; assert.equal(prepared.readCurrent(), null);
  assert.equal(f.select(prepared).status, 'blocked');
});

test('capture validates grouped closed data before structuredClone without invoking accessors', () => {
  let reads = 0;
  for (const target of ['equipment', 'required', 'native', 'identity', 'member', 'source']) {
    const f = groupedCaptureFixture(), metadata = f.metadata.candidate.items[0], equipment = metadata.equipment;
    const [object, key] = target === 'equipment' ? [metadata, 'equipment'] : target === 'required' ? [equipment, 'required'] :
      target === 'native' ? [equipment, 'native'] : target === 'identity' ? [equipment.native.identity, 'path'] :
        target === 'member' ? [equipment.required, '0'] : [equipment.operationalSource, 'locator'];
    Object.defineProperty(object, key, { enumerable: true, get() { reads++; throw new Error('must not invoke'); } });
    const prepared = f.prepare(); assert.equal(prepared.status, 'unavailable');
    assert(gapCodes(prepared).includes('capture_witness_invalid')); assert.equal(prepared.receipt, undefined);
  }
  assert.equal(reads, 0);
  for (const mutate of [equipment => { equipment.extra = true; }, equipment => { equipment.required = new Array(1); },
    equipment => { equipment.required.push(equipment.required[0]); }, equipment => { equipment.alternatives = [['bodyweight', 'wall']]; },
    equipment => { equipment.native.identity[Symbol('extra')] = true; }]) {
    const f = groupedCaptureFixture(); mutate(f.metadata.candidate.items[0].equipment);
    assert.equal(f.prepare().status, 'unavailable');
  }
});

test('grouped confirmed capture retains R1 blocks, operational unknowns and exact user exclusions', () => {
  const blocked = groupedCaptureFixture(); blocked.current.r1.snapshot.preflight.complete = false;
  const result = blocked.prepare(); assert.equal(result.status, 'unavailable');
  assert(result.decision.evidence.value.evaluation.candidates[0].equipmentTrace.every(trace => trace.outcome === 'not_evaluated'));
  const unknown = groupedCaptureFixture(); unknown.metadata.candidate.items[0].equipment.operationalSource = null;
  assert.equal(unknown.prepare().status, 'unavailable'); assert(gapCodes(unknown.prepare()).includes('equipment_unknown'));
  const excluded = sourceCaptureFixture(true);
  excluded.metadata.candidate.items.forEach((metadata, index) => {
    metadata.equipment = { ...structuredClone(projectNativeEquipmentRequirements(captureEquipmentCatalog,
      excluded.input.candidate.plan.items[index].native.exercise_id)), operationalSource: structuredClone(excluded.metadata.source) };
  });
  const prepared = excluded.prepare(); assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.decision.status, 'excluded'); assert.equal(excluded.select(prepared).status, 'infeasible');
});
