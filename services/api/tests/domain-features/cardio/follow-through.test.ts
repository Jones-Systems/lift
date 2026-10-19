import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundingRetriever } from '../../../src/grounding/index.js';
import { createInformativeCardioConsumer, type CardioJob } from '../../../src/domain-features/cardio/index.js';
import { informativeFixture } from './informative-fixture.js';

const choice = { optionId: 'SYN-S100', intent: 'explain_citation', confirmedByUser: true };

test('topic filters exclude same-word off-domain observations from evaluation and follow-through', () => {
  const { retriever, input } = informativeFixture();
  assert.ok(retriever.retrieve({ query: 'concurrent', limit: 100 }).observations.some(entry => entry.record.topic_ids.includes('REC-J1')));
  const consumer = createInformativeCardioConsumer(retriever);
  const response = consumer.evaluate(input);
  assert.equal(response.answer.evidence.filters.topic, 'CAR-H4');
  assert.equal(response.answer.evidence.totalMatches, 22);
  assert.ok(response.answer.evidence.observations.every(entry => entry.record.topic_ids.includes('CAR-H4')));
  const follow = consumer.followThrough(consumer.select(response, choice, input), input);
  assert.equal(follow.kind, 'explain_citation');
  if (follow.kind !== 'explain_citation') throw new Error('wrong follow-through variant');
  assert.deepEqual(follow.explanation, response.answer.statements[0]);
  assert.deepEqual(follow.answer, response.answer);
  assert.deepEqual(follow.request, input);
  assert.deepEqual(follow.answer.conflicts, response.answer.conflicts);
  assert.equal(follow.answer.evidence.truncated, true);
  assert.equal(follow.evaluation.passed, true);
  assert.equal(follow.adoption, 'not_applied');
  assert.equal(follow.automaticAdoption, false);
  assert.throws(() => { (follow.explanation as { text: string }).text = 'replacement'; });
});

test('qualification comparison exposes unchanged fields side by side without ranking or conflict resolution', () => {
  const { retriever, input } = informativeFixture();
  const consumer = createInformativeCardioConsumer(retriever);
  const response = consumer.evaluate(input);
  const selected = consumer.select(response, { ...choice, optionId: 'SYN-S101', intent: 'compare_qualifications' }, input);
  const follow = consumer.followThrough(selected, input);
  assert.equal(follow.kind, 'compare_qualifications');
  if (follow.kind !== 'compare_qualifications') throw new Error('wrong follow-through variant');
  assert.equal(follow.comparisonScope, 'returned_observations_only');
  assert.equal(follow.ranking, 'none');
  assert.equal(follow.columns.length, response.answer.statements.length);
  assert.deepEqual(follow.columns.filter(column => column.selectedByUser).map(column => column.statementId), ['SYN-S101']);
  for (const [index, column] of follow.columns.entries()) {
    const citation = response.answer.statements[index]!.citation;
    assert.deepEqual(column.citation, citation);
    assert.deepEqual(column.qualifications, {
      access_level: citation.record.access_level, source_native_certainty: citation.record.source_native_certainty,
      form_appraisal: citation.record.form_appraisal, applicability: citation.record.applicability,
      rights_status: citation.record.rights_status, freshness_status: citation.record.freshness_status,
      clinical_readiness: citation.record.clinical_readiness, provenance: citation.record.provenance,
    });
  }
  assert.deepEqual(follow.answer.evidence, response.answer.evidence);
  assert.deepEqual(follow.answer.conflicts, response.answer.conflicts);
});

test('all cardio jobs use their declared topic; declared empty coverage remains a qualified gap', () => {
  const { retriever, input } = informativeFixture();
  const jobs: [CardioJob, string][] = [
    [{ kind: 'activity_guidelines', intent: 'explain', population: 'general_adult' }, 'CAR-H1'],
    [{ kind: 'intensity', intent: 'explain', method: 'heart_rate', modality: 'walking' }, 'CAR-H2'],
    [{ kind: 'modalities', intent: 'explain', modality: 'walking', comparison: 'cycling' }, 'CAR-H3'],
    [input.job, 'CAR-H4'],
    [{ kind: 'energy_balance', intent: 'explain', focus: 'compensation' }, 'CAR-H5'],
  ];
  for (const [job, topic] of jobs) {
    const result = createInformativeCardioConsumer(retriever).evaluate({ ...input, job });
    assert.equal(result.answer.evidence.filters.topic, topic);
    if (topic !== 'CAR-H4') {
      assert.equal(result.answer.status, 'gap');
      assert.equal(result.allowed_action, 'abstain');
      assert.ok(result.answer.evidence.corpusStatus.units_without_observations.includes(topic));
      assert.equal(result.evaluation.passed, true);
    }
  }
});

test('a mapped topic absent from corpus coverage fails instead of falling back to an unfiltered query', () => {
  const { projection, binding, input } = informativeFixture();
  projection.coverage.units.find(unit => unit.unit_id === 'CAR-H2')!.unit_id = 'SYN-Z1';
  projection.corpus_status.units_without_observations = projection.corpus_status.units_without_observations.map(id => id === 'CAR-H2' ? 'SYN-Z1' : id);
  const consumer = createInformativeCardioConsumer(createGroundingRetriever(projection, binding));
  assert.throws(() => consumer.evaluate({ ...input, job: { kind: 'intensity', intent: 'explain', method: 'heart_rate', modality: 'walking' } }), /unbound topic filter/);
});

test('follow-through rejects stale context, routes, source and unissued/forged choices before retrieval', () => {
  const { retriever, input } = informativeFixture();
  let calls = 0;
  const consumer = createInformativeCardioConsumer({ retrieve(request) { calls++; return retriever.retrieve(request); } });
  const response = consumer.evaluate(input);
  const selected = consumer.select(response, choice, input);
  const before = calls;
  const changedContexts = [
    { ...input, jobRevision: 'job-2' },
    { ...input, userContext: { ...input.userContext, revision: 'user-2', supersedesRevision: 'user-1' } },
    ...(['sourceRevision', 'corpusInputSha256', 'regionalRoute', 'trainingRoute', 'confirmation_state'] as const).map(field => ({ ...input, routing: { ...input.routing, [field]: 'changed' } })),
    { ...input, userContext: { ...input.userContext, facts: [{ id: 'device', text: 'sleep', origin: 'wearable' }] } },
    { ...input, job: { ...input.job, intent: 'diagnose' } },
  ];
  for (const current of changedContexts) assert.throws(() => consumer.followThrough(selected, current), /stale_or_unissued_selection/);
  for (const forged of [structuredClone(selected), { ...selected, nextIntent: 'apply_workout' }, { ...selected, automaticAdoption: true }]) {
    assert.throws(() => consumer.followThrough(forged as typeof selected, input), /stale_or_unissued_selection/);
  }
  assert.equal(calls, before);
  consumer.invalidate('consent_withdrawal');
  assert.throws(() => consumer.followThrough(selected, input), /stale_or_unissued_selection/);
});

test('fresh oracle rejects changed evidence and invalidation during follow-through', () => {
  const { retriever, projection, binding, input } = informativeFixture();
  let current = retriever;
  let invalidate = false;
  const consumer = createInformativeCardioConsumer({ retrieve(request) {
    if (invalidate) consumer.invalidate('source_change');
    return current.retrieve(request);
  } });
  const response = consumer.evaluate(input);
  const selected = consumer.select(response, choice, input);
  projection.records[0]!.record = { ...projection.records[0]!.record, form_appraisal: 'Corrected qualification.' };
  current = createGroundingRetriever(projection, binding);
  assert.throws(() => consumer.followThrough(selected, input), /stale_literature_selection/);
  current = retriever;
  invalidate = true;
  assert.throws(() => consumer.followThrough(selected, input), /stale_literature_selection/);
});
