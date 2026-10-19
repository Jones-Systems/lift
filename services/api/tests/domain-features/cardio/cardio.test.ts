import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardioConsumer, type CardioJob, type ObservationGrounding } from '../../../src/domain-features/cardio/index.js';
import { context, observation } from './fixture.js';

const job: CardioJob = { kind: 'concurrent_training', intent: 'explain', modality: 'cycling', order: 'strength_first', spacing: 'separate_days', outcome: 'power' };

test('concurrent job dimensions and exact evidence qualifiers survive without granting actions', () => {
  const evidence = observation();
  const consumer = createCardioConsumer({ retrieve(request) { assert.deepEqual(request, { query: 'concurrent', limit: 20 }); return evidence; } });
  const result = consumer.evaluate(job, context);
  assert.deepEqual(result.job, job);
  assert.deepEqual(result.grounding, evidence);
  assert.deepEqual(result.source_ids, ['SYN-1']);
  assert.equal(result.answer, null);
  assert.equal(result.allowed_action, 'abstain');
  assert.equal(result.resultStatus, 'research_observations');
  assert.match(result.uncertainty_or_abstention.join(' '), /partial CL-0.*unresolved/);
  evidence.observations[0]!.record.summary = 'changed externally';
  assert.notDeepEqual(result.grounding, evidence);
  assert.throws(() => { result.context.trainingRoute = 'self_directed'; });
  assert.throws(() => { result.grounding!.observations[0]!.record.id = 'changed'; });
});

test('guidelines, HR/RPE/talk test/device limits, modalities and energy balance have bounded jobs', () => {
  const jobs: CardioJob[] = [
    { kind: 'activity_guidelines', intent: 'explain', population: 'older_adult' },
    ...(['heart_rate', 'rpe', 'talk_test', 'device_limitations'] as const).map(method => ({ kind: 'intensity' as const, intent: 'explain' as const, method, modality: 'walking' as const })),
    { kind: 'modalities', intent: 'explain', modality: 'running', comparison: 'cycling' },
    { kind: 'energy_balance', intent: 'explain', focus: 'compensation' },
  ];
  for (const input of jobs) {
    const result = createCardioConsumer({ retrieve: request => observation(request.query) }).evaluate(input, context);
    assert.deepEqual(result.job, input);
    assert.equal(result.allowed_action, 'abstain');
  }
});

test('wearable payloads, provenance, invalid dimensions and clinical intents never reach retrieval', () => {
  let calls = 0;
  const consumer = createCardioConsumer({ retrieve() { calls++; return observation(); } });
  for (const input of [
    { ...job, importedWearable: { heartRate: 170 } }, { ...job, modality: { value: 'cycling', origin: 'wearable' } },
    { ...job, provenance: 'wearable' }, { ...job, order: 'invented' }, { ...job, intent: 'prescribe' },
    { ...job, intent: 'clearance' }, { ...job, intent: 'diagnose' }, { ...job, intent: 'treat' },
  ]) assert.throws(() => consumer.evaluate(input, context));
  assert.throws(() => consumer.evaluate(job, { ...context, importedWearable: { sleep: 8 } } as typeof context));
  assert.equal(calls, 0);
});

test('missing, unavailable, stale and purported qualified evidence stay abstentions', () => {
  const missing: ObservationGrounding = { ...observation(), status: 'gap', reason: 'no_matching_observations', observations: [], totalMatches: 0 };
  const gap = createCardioConsumer({ retrieve: () => missing }).evaluate(job, context);
  assert.equal(gap.resultStatus, 'gap');
  assert.deepEqual(gap.source_ids, []);
  assert.match(gap.uncertainty_or_abstention.join(' '), /not evidence of a null result/);
  const badInputs = [
    { ...observation(), source: { ...observation().source, revision: 'stale' } },
    { ...observation(), clinicalReadiness: 'qualified' },
    { ...observation(), verbatimPassagesAvailable: true },
  ];
  for (const bad of badInputs) {
    const result = createCardioConsumer({ retrieve: () => bad as ObservationGrounding }).evaluate(job, context);
    assert.equal(result.resultStatus, 'unavailable'); assert.equal(result.grounding, null); assert.equal(result.answer, null);
  }
  const unavailable = createCardioConsumer({ retrieve() { throw new Error('offline'); } }).evaluate(job, context);
  assert.equal(unavailable.resultStatus, 'unavailable');
});

test('correction, withdrawal, deletion and source changes invalidate prior responses and route changes prevent reuse', () => {
  const consumer = createCardioConsumer({ retrieve: () => observation() });
  for (const reason of ['correction', 'consent_withdrawal', 'deletion', 'source_change'] as const) {
    const result = consumer.evaluate(job, context);
    assert.equal(consumer.isCurrent(result, context), true);
    for (const key of ['contextRevision', 'sourceRevision', 'corpusInputSha256', 'trainingRoute', 'regionalRoute', 'confirmation_state', 'escalation_route'] as const) {
      assert.equal(consumer.isCurrent(result, { ...context, [key]: 'changed' }), false);
    }
    assert.equal(consumer.isCurrent(result, { ...context, regionalPreflight: 'resolved' }), false);
    assert.equal(consumer.isCurrent(structuredClone(result), context), false);
    consumer.invalidate(reason);
    assert.equal(consumer.isCurrent(result, context), false);
  }
});

test('invalidation during retrieval cannot issue a reusable old result', () => {
  const consumer = createCardioConsumer({ retrieve() { consumer.invalidate('source_change'); return observation(); } });
  const result = consumer.evaluate(job, context);
  assert.equal(result.resultStatus, 'unavailable');
  assert.equal(consumer.isCurrent(result, context), false);
});
