import test from 'node:test';
import assert from 'node:assert/strict';
import { createInformativeRecoveryConsumer, type InformativeRecoveryJob } from '../../../src/domain-features/recovery/index.js';
import { informativeFixture } from '../cardio/informative-fixture.js';

const jobs: InformativeRecoveryJob[] = [
  { kind: 'sleep', intent: 'explain', focus: 'quality' },
  { kind: 'hydration', intent: 'explain', focus: 'measurement_limits' },
  { kind: 'soreness_readiness', intent: 'explain', construct: 'readiness_limitations' },
  { kind: 'recovery_modalities', intent: 'explain', modality: 'massage' },
  { kind: 'stress', intent: 'explain', focus: 'recovery_relationship' },
  { kind: 'injury_literacy', intent: 'explain', focus: 'regional_preflight', topic: 'INJ-K7' },
  { kind: 'return_framework', intent: 'explain', focus: 'clinician_plan_limits' },
];
test('all recovery jobs expose cited explanations and user choices under unchanged routing', () => {
  const { retriever, input } = informativeFixture();
  for (const job of jobs) {
    for (const route of ['urgent', 'same_day', 'clinical_review', 'safety_unknown', 'clinician_plan', 'adapted', 'self_directed']) {
      const consumer = createInformativeRecoveryConsumer(retriever);
      const current = { ...input, job, routing: { ...input.routing, trainingRoute: route } };
      const result = consumer.evaluate(current);
      assert.equal(result.answer.status, 'informative');
      const expectedTopics = { sleep: 'REC-J1', hydration: 'REC-J2', soreness_readiness: 'REC-J3', recovery_modalities: 'REC-J4', stress: 'REC-J5', injury_literacy: 'INJ-K7', return_framework: 'INJ-K4' };
      assert.equal(result.answer.evidence.filters.topic, expectedTopics[job.kind]);
      assert.ok(result.answer.evidence.observations.every(entry => entry.record.topic_ids.includes(expectedTopics[job.kind])));
      assert.equal(result.evaluation.passed, true);
      assert.deepEqual(result.request.routing, current.routing);
      assert.deepEqual(result.answer.context, current.userContext);
      const selected = consumer.select(result, { optionId: result.answer.options[0]!.id, intent: 'compare_qualifications', confirmedByUser: true }, current);
      assert.equal(selected.adoption, 'not_applied');
      assert.equal(selected.nextIntent, 'compare_qualifications');
      assert.equal(consumer.followThrough(selected, current).kind, 'compare_qualifications');
      assert.equal(result.answer.choice.automaticAdoption, false);
    }
  }
});

test('injury literacy requires an explicit supported topic before retrieving, without deriving clinical routing', () => {
  const { retriever, input } = informativeFixture();
  let calls = 0;
  const consumer = createInformativeRecoveryConsumer({ retrieve(request) { calls++; return retriever.retrieve(request); } });
  const job = { kind: 'injury_literacy', intent: 'explain', focus: 'terminology' };
  assert.throws(() => consumer.evaluate({ ...input, job }), /injury_topic_selection_required/);
  for (const topic of ['NUT-I1', 'INJ-K99', '', { topic: 'INJ-K1', origin: 'wearable' }]) {
    assert.throws(() => consumer.evaluate({ ...input, job: { ...job, topic } }));
  }
  assert.equal(calls, 0);
  const current = { ...input, job: { ...job, topic: 'INJ-K1' } };
  const result = consumer.evaluate(current);
  assert.equal(result.answer.evidence.filters.topic, 'INJ-K1');
  assert.equal(result.answer.status, 'gap');
  assert.deepEqual(result.request.routing, input.routing);
});
