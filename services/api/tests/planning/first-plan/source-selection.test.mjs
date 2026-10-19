import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_POLICY, produceFallbackCandidate, selectFirstPlan, selectSourceFirstPlan, sourcePrescriptionKey,
} from '../../../src/planning/first-plan/index.ts';
import { nativePrescription, planFields, sourcePrescriptionPlanFields } from '../../../src/schemas.ts';
import { sourceFixture } from './source-fixture.mjs';

test('produces the actual accepted four-task Form adaptation with source-native dose and estimated duration', () => {
  const f = sourceFixture(), { plan } = f.candidate;
  assert.deepEqual(plan.items.map(item => item.native), [
    { exercise_id: 'bodyweight-squat', movement_pattern: 'knee_dominant', role: 'primary', sets: 2, rest_seconds: 150, rep_range: [6, 12], target_rir: 3 },
    { exercise_id: 'wall-push-up', movement_pattern: 'push', role: 'accessory', sets: 2, rest_seconds: 150, rep_range: [6, 12], target_rir: 3 },
    { exercise_id: 'chest-supported-machine-row', movement_pattern: 'pull', role: 'accessory', sets: 2, rest_seconds: 150, rep_range: [6, 12], target_rir: 3 },
    { exercise_id: 'dead-bug', movement_pattern: 'trunk', role: 'accessory', sets: 2, rest_seconds: 90, notes: ['controlled practice task; no rep target'] },
  ]);
  assert.deepEqual(plan.duration, { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 });
  assert.deepEqual(plan.origin, { kind: 'form-adaptation', id: 'form-strength-fallback', revision: '1' });
  assert.deepEqual(plan.items.map(item => item.registeredDomain.exerciseId), ['bodyweight-squat', 'wall-push-up', 'chest-supported-machine-row', 'dead-bug']);
  for (const item of plan.items) {
    assert.deepEqual(item.load, { kind: 'unspecified', basis: 'unknown' });
    assert.equal(Object.hasOwn(item, 'targetKg'), false);
    assert.equal(Object.hasOwn(item, 'repMin'), false);
  }
  assert.deepEqual(sourcePrescriptionPlanFields.parse(JSON.parse(JSON.stringify(plan))), plan);
  assert.equal(planFields.safeParse(plan).success, false);
});

test('requires matching current internal policy attestation, independent of catalog identity', () => {
  for (const mutate of [
    r => { r.policy = null; }, r => { r.policy.qualification = 'provisional'; },
    ...['id', 'revision', 'locator', 'qualification'].map(key => r => { r.policy.source[key] = 'different'; }),
    ...['unknown', 'superseded', 'withdrawn'].map(value => r => { r.policy.source.currentness = value; }),
  ]) {
    const f = sourceFixture(); mutate(f.request);
    assert.deepEqual(produceFallbackCandidate(f.request), { status: 'blocked', gaps: [{ code: 'fallback_policy_unavailable' }] });
  }
});

test('rejects absent and inconsistent registration without aliasing native names to Domain IDs', () => {
  for (const mutate of [
    r => { r.registration = null; }, r => { r.registration.bindings.pop(); },
    r => { r.registration.bindings[0].status = 'unavailable'; },
    r => { r.registration.bindings[0].qualificationScope = 'clinical'; },
    r => { r.registration.bindings[0].identity.nativeId = 'goblet-squat'; },
    r => { r.registration.bindings[0].identity.sha256 = 'c'.repeat(64); },
    r => { r.registration.bindings[0].variantId = 'alias'; },
    r => { r.registration.bindings[0].registration.digest = 'c'.repeat(64); },
    r => { r.registration.bindings[0].catalogRevision = 'stale'; },
    r => { r.registration.bindings[1].exerciseId = r.registration.bindings[0].exerciseId; },
    r => { r.registration.bindings[1] = r.registration.bindings[0]; },
    r => { r.registration.pin.bytes = 0; },
    r => { r.registration.bindings[0].recordDigest = 'not-a-digest'; },
  ]) {
    const f = sourceFixture(); mutate(f.request);
    assert.equal(produceFallbackCandidate(f.request).status, 'blocked');
  }
  const f = sourceFixture(); f.request.registration.bindings.reverse();
  assert.deepEqual(produceFallbackCandidate(f.request).candidate, f.candidate);
});

test('uses equipment membership and the estimate upper bound, never the requested time as a prescription', () => {
  for (const equipment of ['bodyweight', 'wall', 'machine']) {
    const f = sourceFixture(); f.context.preferences.equipment = f.context.preferences.equipment.filter(value => value !== equipment);
    assert.equal(produceFallbackCandidate(f.request).gaps[0].code, 'fallback_equipment_unavailable');
  }
  for (const minutes of [5, 15, 24, 25, 26, 90]) {
    const f = sourceFixture(); f.context.preferences.sessionMinutes = minutes;
    const result = produceFallbackCandidate(f.request);
    if (minutes < 25) assert.equal(result.gaps[0].code, 'fallback_time_exceeds_limit');
    else assert.deepEqual(result.candidate.plan.duration, { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 });
  }
});

test('requires confirmed context and returns isolated frozen policy and recipe values', () => {
  const f = sourceFixture();
  const produced = produceFallbackCandidate(f.request);
  assert.throws(() => { produced.candidate.plan.items[0].native.rest_seconds = 1; }, TypeError);
  assert.throws(() => { FALLBACK_POLICY.recipe[0].rep_range[0] = 1; }, TypeError);
  f.request.registration.bindings[0].exerciseId = 'changed-after-production';
  assert.equal(produced.candidate.plan.items[0].registeredDomain.exerciseId, 'bodyweight-squat');
  f.context.profile.revision++;
  assert.equal(produceFallbackCandidate(f.request).gaps[0].code, 'stale_confirmation');
});

test('source selection is explicit, retains unknown load and native evidence, and does not invoke legacy ports', () => {
  const f = sourceFixture();
  assert.equal(selectFirstPlan(f.selection, f.ports).gaps[0].code, 'invalid_candidate');
  assert.deepEqual(f.calls, []);
  const result = selectSourceFirstPlan(f.selection, f.ports);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.plan, f.candidate.plan);
  assert.equal(result.trace.version, 'form.source-first-plan-selection/v1');
  assert.equal(f.calls[0][1].comparisonMinutes, 25);
  assert.deepEqual(result.trace.candidates[0].constraints.evidence.value, { applied: false });
  result.plan.items[0].native.rest_seconds = 1;
  assert.equal(f.candidate.plan.items[0].native.rest_seconds, 150);
});

test('source selection rejects mismatched registered variants, item keys and stale decisions', () => {
  for (const mutate of [
    r => { r.items[0].exerciseId = 'unregistered-domain-alias'; },
    r => { r.items[0].variantId = 'another-variant'; },
    r => { r.items[0].prescriptionKey = 'old-key'; },
    r => { r.items.pop(); }, r => { r.contextKey = 'old-context'; },
  ]) {
    const f = sourceFixture(), original = f.ports.qualifyCatalog;
    f.ports.qualifyCatalog = input => { const result = original(input); mutate(result); return result; };
    assert.equal(selectSourceFirstPlan(f.selection, f.ports).status, 'blocked');
    assert.equal(f.calls.some(([kind]) => kind === 'constraints'), false);
  }
});

test('source format preserves unknown versus excluded and selects supplied candidates without dose changes', () => {
  const f = sourceFixture(), original = f.ports.evaluateConstraints;
  f.selection.candidates.push({ ...structuredClone(f.candidate), id: 'alternative' });
  f.ports.evaluateConstraints = input => input.candidate.id === f.candidate.id
    ? { ...original(input), status: 'excluded', reasons: [{ code: 'accepted_limit' }] } : original(input);
  const result = selectSourceFirstPlan(f.selection, f.ports);
  assert.equal(result.trace.selectedCandidateId, 'alternative');
  assert.deepEqual(result.plan, f.candidate.plan);
  f.selection.candidates.pop();
  assert.equal(selectSourceFirstPlan(f.selection, f.ports).status, 'infeasible');
  f.ports.evaluateConstraints = input => ({ ...original(input), status: 'unknown', reasons: [{ code: 'receipt_missing' }] });
  assert.equal(selectSourceFirstPlan(f.selection, f.ports).status, 'blocked');
  assert.equal(selectSourceFirstPlan(f.selection).gaps[0].code, 'catalog_unavailable');
});

test('all native optional fields survive JSON and hashing without trimming, reordering or invented values', () => {
  const f = sourceFixture(), item = f.candidate.plan.items[0];
  item.native = { ...item.native, substituted_for: 'another-native-id', notes: ['  exact native text  ', 'second note'] };
  const roundTrip = sourcePrescriptionPlanFields.parse(JSON.parse(JSON.stringify(f.candidate.plan)));
  assert.deepEqual(roundTrip, f.candidate.plan);
  const key = sourcePrescriptionKey(item);
  const changed = structuredClone(item); changed.native.notes.reverse();
  assert.notEqual(sourcePrescriptionKey(changed), key);
  changed.native.notes = ['exact native text', 'second note'];
  assert.notEqual(sourcePrescriptionKey(changed), key);
  for (const field of ['rep_range', 'target_rir', 'substituted_for', 'notes']) {
    const absent = structuredClone(item); delete absent.native[field];
    assert.notEqual(sourcePrescriptionKey(absent), key);
    assert.equal(nativePrescription.safeParse({ ...absent.native, [field]: undefined }).success, false);
  }
  assert.equal(nativePrescription.safeParse({ ...item.native, notes: [] }).success, false);
});
