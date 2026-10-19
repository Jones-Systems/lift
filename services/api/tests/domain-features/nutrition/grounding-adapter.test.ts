import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroundingRetriever, type SourceObservation } from '../../../src/grounding/index.js';
import { syntheticFixture, syntheticRecord } from '../../grounding/fixture.js';
import { createNutritionGroundingPort } from '../../../src/domain-features/nutrition/grounding-adapter.js';
import { nutritionJobTopics, nutritionSourceRequest, retrieveNutritionSources } from '../../../src/domain-features/nutrition/index.js';

// These nutrition topics label artificial observations; no fixture asserts a nutrition outcome.
function nutritionFixture(records: readonly SourceObservation[]) {
  const fixture = syntheticFixture(records);
  Object.values(nutritionJobTopics).forEach((topic, index) => {
    fixture.projection.coverage.units[index]!.unit_id = topic;
  });
  const represented = new Set(records.flatMap(record => record.topic_ids));
  fixture.projection.corpus_status.units_without_observations = fixture.projection.coverage.units
    .map(unit => unit.unit_id).filter(id => !represented.has(id));
  return fixture;
}

test('native retriever receives every exact nutrition topic and original query without correction rewriting', async () => {
  const records = Object.values(nutritionJobTopics).map((topic, index) =>
    syntheticRecord(`SYN-S${index + 1}`, { topic_ids: [topic] }));
  const { projection, binding } = nutritionFixture(records);
  const adapter = createNutritionGroundingPort(createGroundingRetriever(projection, binding));
  for (const job of Object.keys(nutritionJobTopics) as (keyof typeof nutritionJobTopics)[]) {
    const request = nutritionSourceRequest({ job, question: '  STRENGTH  ', corrections: ['unmatchable correction token'] });
    const result = await adapter.retrieve(request);
    assert.equal(result.context.query, '  STRENGTH  ');
    assert.equal(result.context.filters.topic, nutritionJobTopics[job]);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.candidates[0]?.observation.record.topic_ids, [nutritionJobTopics[job]]);
    assert.deepEqual(request.corrections, ['unmatchable correction token']);
  }
});

test('native entries and full source context survive with explicit partial, CL-0, passage and appraisal limits', async () => {
  const { projection, binding } = nutritionFixture([syntheticRecord('SYN-S1', { topic_ids: ['NUT-I3'] })]);
  const retriever = createGroundingRetriever(projection, binding);
  const expected = retriever.retrieve({ query: 'strength', topic: 'NUT-I3' });
  const result = await retrieveNutritionSources({ job: 'protein', question: 'strength', corrections: ['retain me'] },
    createNutritionGroundingPort(retriever));
  assert.deepEqual(result.retrievalContext, expected);
  assert.deepEqual(result.candidates[0]?.observation, expected.observations[0]);
  const provenance = result.candidates[0]?.provenance;
  assert.ok(provenance?.status === 'source-observation');
  assert.equal(provenance.sourceRevision, binding.revision);
  assert.equal(provenance.locator, `${binding.corpusRoot}/${projection.records[0]!.source_path}:5`);
  assert.ok(provenance.limits.includes(projection.records[0]!.record.form_appraisal));
  assert.ok(provenance.limits.includes(projection.records[0]!.record.rights_status));
  for (const prefix of ['clinical-readiness: CL-0', 'verbatim-passages-unavailable:',
    'scientific-appraisal-not-performed:', 'corpus-partial:', 'topic-coverage: NUT-I3; partial',
    'units-without-observations:', 'packets-without-records:']) {
    assert.ok(result.gaps.some(gap => gap.code === 'retrieval-gap' && gap.detail.startsWith(prefix)), prefix);
  }
  assert.equal(result.status, 'evidence-gap');
  assert.deepEqual(result.traceableCandidateIndexes, [0]);
  assert.equal(result.adviceAuthority, 'none');
  assert.equal(result.scientificAppraisal, 'not-performed');
  assert.deepEqual(result.request.corrections, ['retain me']);
});

test('native no-match remains a bounded query gap with complete omission metadata', async () => {
  const { projection, binding } = nutritionFixture([]);
  const result = await createNutritionGroundingPort(createGroundingRetriever(projection, binding)).retrieve(
    nutritionSourceRequest({ job: 'logging-accuracy', question: 'strength', corrections: [] }));
  assert.equal(result.context.status, 'gap');
  assert.deepEqual(result.context.corpusStatus, projection.corpus_status);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.gaps.includes('retrieval-gap: no_matching_observations; no match within this bounded projection and query.'));
});

test('native default pagination keeps unresolved conflicts outside the page and reports truncation', async () => {
  const records = Array.from({ length: 21 }, (_, index) => syntheticRecord(`SYN-S${String(index + 1).padStart(2, '0')}`, {
    topic_ids: ['NUT-I6'], conflicts: index === 0 ? ['SYN-S21'] : [],
  }));
  const { projection, binding } = nutritionFixture(records);
  const result = await createNutritionGroundingPort(createGroundingRetriever(projection, binding)).retrieve(
    nutritionSourceRequest({ job: 'supplements', question: 'strength', corrections: [] }));
  assert.equal(result.context.limit, 20);
  assert.equal(result.candidates.length, 20);
  assert.ok(result.gaps.includes('retrieval-truncated: 20 of 21 matching observations returned.'));
  assert.ok(result.gaps.includes('unresolved-conflicts: SYN-S01; SYN-S21.'));
  assert.deepEqual(result.candidates[0]?.observation.record.conflicts, ['SYN-S21']);
  assert.equal(result.candidates.some(candidate => candidate.observation.record.id === 'SYN-S21'), false);
});

test('native invalid lexical input fails closed through the nutrition consumer', async () => {
  const { projection, binding } = nutritionFixture([]);
  const result = await retrieveNutritionSources({ job: 'nutrition-boundaries', question: '!!!', corrections: [] },
    createNutritionGroundingPort(createGroundingRetriever(projection, binding)));
  assert.equal(result.status, 'evidence-gap');
  assert.equal(result.retrievalContext, null);
  assert.ok(result.gaps.some(gap => gap.code === 'retrieval-unavailable'));
  assert.equal(result.adviceAuthority, 'none');
});
