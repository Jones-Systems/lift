import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  normalizeFirstPlanInput, normalizeSourceFirstPlanInput, prescriptionKey, sourcePrescriptionKey, selectFirstPlan, selectSourceFirstPlan,
} from '../../../src/planning/first-plan/index.ts';
import { sourceFixture } from './source-fixture.mjs';

test('legacy normalization retains exact historical canonical bytes and key namespaces', () => {
  const context = { accountId: 'a', profile: { revision: 1, goals: [], trainingBackground: null, injuryHistory: '' },
    preferences: { revision: 2, equipment: [], sessionMinutes: 25, trainingDaysPerWeek: 2 } };
  const source = { id: 's', revision: 'r', locator: 'l', currentness: 'current', qualification: 'fixture' };
  const item = { id: 'i', exerciseId: 'e', setTarget: 2, repMin: 6, repMax: 12, targetKg: 0 };
  const candidate = { id: 'c', qualification: 'qualified', source, plan: { name: 'p', minutes: 25, items: [item] } };
  const confirmation = { accountId: 'a', profileRevision: 1, preferencesRevision: 2 };
  const bytes = {
    context: '{"accountId":"a","profile":{"goals":[],"trainingBackground":null,"injuryHistory":"","revision":1},"preferences":{"equipment":[],"sessionMinutes":25,"trainingDaysPerWeek":2,"revision":2}}',
    item: '{"id":"i","exerciseId":"e","setTarget":2,"repMin":6,"repMax":12,"targetKg":0}',
    candidate: '{"id":"c","qualification":"qualified","source":{"id":"s","revision":"r","locator":"l","qualification":"fixture","currentness":"current"},"plan":{"name":"p","minutes":25,"items":[{"id":"i","exerciseId":"e","setTarget":2,"repMin":6,"repMax":12,"targetKg":0}]}}',
  };
  const digest = value => createHash('sha256').update(value).digest('hex');
  const normalized = normalizeFirstPlanInput({ context, confirmation, candidate });
  assert.equal(normalized.status, 'valid');
  assert.equal(normalized.input.contextKey, `form-context-v1:${digest(bytes.context)}`);
  assert.equal(normalized.input.candidateKey, `form-candidate-v1:${digest(bytes.candidate)}`);
  assert.equal(prescriptionKey(item), `form-prescription-v1:${digest(bytes.item)}`);
  let received;
  selectFirstPlan({ context, confirmation, candidates: [candidate] }, {
    qualifyCatalog(input) { received = input; return { ...input, status: 'unknown', reasons: [{ code: 'fixture' }] }; },
  });
  assert.deepEqual(received, normalized.input);
  assert.equal(Object.hasOwn(normalized.input, 'format'), false);
});

test('both normalizers fence confirmations before exposing detached frozen inputs', () => {
  const f = sourceFixture();
  const source = normalizeSourceFirstPlanInput({ ...f.selection, candidate: f.candidate });
  assert.equal(source.status, 'valid');
  assert.equal(source.input.format, 'form.source-prescription-evaluation/v1');
  assert.equal(source.input.comparisonMinutes, 25);
  assert.throws(() => { source.input.context.preferences.equipment.push('other'); }, TypeError);
  assert.throws(() => { source.input.candidate.plan.items[0].native.rep_range[0] = 1; }, TypeError);
  assert.throws(() => { source.input.prescriptions[0].prescriptionKey = 'other'; }, TypeError);
  f.context.profile.trainingContext = 'edited';
  assert.equal(source.input.context.profile.trainingContext, 'Confirmed text');
  for (const confirmation of [null, { ...f.confirmation, accountId: 'other' }, { ...f.confirmation, profileRevision: 99 }]) {
    assert.equal(normalizeSourceFirstPlanInput({ context: f.context, confirmation, candidate: f.candidate }).status, 'blocked');
    assert.equal(normalizeFirstPlanInput({ context: f.context, confirmation, candidate: {} }).status, 'blocked');
  }
});

test('source normalization is the exact input exposed to both ports and rejects format mixing', () => {
  const f = sourceFixture();
  const normalized = normalizeSourceFirstPlanInput({ ...f.selection, candidate: f.candidate });
  assert.equal(selectSourceFirstPlan(f.selection, f.ports).status, 'ready');
  assert.deepEqual(f.calls[0][1], normalized.input);
  assert.deepEqual(f.calls[1][1], normalized.input);
  assert.equal(normalizeFirstPlanInput({ ...f.selection, candidate: f.candidate }).gaps[0].code, 'invalid_candidate');
  assert.throws(() => prescriptionKey(f.candidate.plan.items[0]));
});

test('source item hashes bind every native field, registration association and explicit unknown load', () => {
  const original = sourceFixture().candidate.plan.items[0], key = sourcePrescriptionKey(original);
  const mutations = [
    i => { i.id = 'other'; }, i => { i.native.movement_pattern = 'other'; }, i => { i.native.role = 'warmup'; },
    i => { i.native.sets++; }, i => { i.native.rest_seconds++; }, i => { i.native.rep_range[0]++; },
    i => { i.native.rep_range[1]++; }, i => { i.native.target_rir++; }, i => { i.native.notes = ['new']; },
    i => { i.native.substituted_for = 'other'; }, i => { i.registeredDomain.exerciseId = 'other'; },
    i => { i.registeredDomain.variantId = 'other'; }, i => { i.registeredDomain.identity.repository = 'other'; },
    i => { i.registeredDomain.identity.revision = 'other'; }, i => { i.registeredDomain.identity.path = 'other'; },
    i => { i.registeredDomain.identity.sha256 = 'c'.repeat(64); },
    i => { i.native.exercise_id = 'other'; i.registeredDomain.identity.nativeId = 'other'; },
    i => { i.registeredDomain.registration.id = 'other'; }, i => { i.registeredDomain.registration.revision = 'other'; },
    i => { i.registeredDomain.registration.digest = 'c'.repeat(64); }, i => { i.registeredDomain.registration.bytes++; },
    i => { i.registeredDomain.recordDigest = 'c'.repeat(64); },
  ];
  assert.match(key, /^form-source-prescription-v1:[a-f0-9]{64}$/);
  for (const mutate of mutations) { const item = structuredClone(original); mutate(item); assert.notEqual(sourcePrescriptionKey(item), key); }
  for (const load of [undefined, null, { kind: 'unspecified', basis: 'external' }, { targetKg: 0 }]) {
    assert.throws(() => sourcePrescriptionKey({ ...original, load }));
  }
});

test('source candidate hash binds origin, both duration bounds, order and every prescription', () => {
  const f = sourceFixture();
  const normalize = candidate => normalizeSourceFirstPlanInput({ ...f.selection, candidate }).input;
  const before = normalize(f.candidate);
  assert.match(before.candidateKey, /^form-source-candidate-v1:[a-f0-9]{64}$/);
  for (const mutate of [
    p => { p.name = 'other'; }, p => { p.origin.id = 'other'; }, p => { p.origin.revision = '2'; },
    p => { p.duration.minMinutes++; }, p => { p.duration.maxMinutes++; }, p => { p.items.reverse(); },
    p => { p.items[0].native.rest_seconds++; },
  ]) {
    const candidate = structuredClone(f.candidate); mutate(candidate.plan);
    assert.notEqual(normalize(candidate).candidateKey, before.candidateKey);
  }
  const reversed = Object.fromEntries(Object.entries(f.candidate.plan.items[0]).reverse());
  assert.equal(sourcePrescriptionKey(reversed), sourcePrescriptionKey(f.candidate.plan.items[0]));
});
