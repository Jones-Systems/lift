import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryConsumer, type RecoveryJob } from '../../../src/domain-features/recovery/index.js';
import { context, observation } from '../cardio/fixture.js';

const jobs: RecoveryJob[] = [
  { kind: 'sleep', intent: 'explain', focus: 'quality' },
  { kind: 'hydration', intent: 'explain', focus: 'measurement_limits' },
  { kind: 'soreness_readiness', intent: 'explain', construct: 'readiness_limitations' },
  { kind: 'recovery_modalities', intent: 'explain', modality: 'massage' },
  { kind: 'stress', intent: 'explain', focus: 'recovery_relationship' },
  { kind: 'injury_literacy', intent: 'explain', focus: 'regional_preflight' },
  { kind: 'return_framework', intent: 'explain', focus: 'clinician_plan_limits' },
];

test('all recovery jobs retain conflicts and missingness without readiness scores or return clearance', () => {
  const consumer = createRecoveryConsumer({ retrieve: request => observation(request.query) });
  for (const job of jobs) {
    const result = consumer.evaluate(job, context);
    assert.deepEqual(result.job, job);
    assert.deepEqual(result.grounding, observation(result.grounding!.query));
    assert.equal(result.allowed_action, 'abstain');
    assert.equal(result.answer, null);
    assert.equal(result.confirmation_state, context.confirmation_state);
    assert.equal(result.escalation_route, context.escalation_route);
    assert.deepEqual(result.context, context);
  }
});

test('every accepted R1 route is opaque and unchanged, including regional unknown', () => {
  for (const trainingRoute of ['urgent', 'same_day', 'clinical_review', 'safety_unknown', 'clinician_plan', 'adapted', 'self_directed']) {
    for (const regionalRoute of ['emergency', 'urgent_assessment', 'clinician_routed', 'unknown', 'screened_self_management']) {
      const boundary = { ...context, trainingRoute, regionalRoute };
      const result = createRecoveryConsumer({ retrieve: request => observation(request.query) }).evaluate(jobs[6], boundary);
      assert.deepEqual(result.context, boundary);
      assert.equal(result.allowed_action, 'abstain');
    }
  }
});

test('pain trials, scoring, diagnosis and wearable facts are refused before retrieval', () => {
  let calls = 0;
  const consumer = createRecoveryConsumer({ retrieve(request) { calls++; return observation(request.query); } });
  for (const extra of [{ painThreshold: 3 }, { readinessScore: 90 }, { wearableSleep: 8 }, { intent: 'treat' }, { intent: 'diagnose' }, { intent: 'clearance' }]) {
    assert.throws(() => consumer.evaluate({ ...jobs[6], ...extra }, context));
  }
  assert.equal(calls, 0);
});
