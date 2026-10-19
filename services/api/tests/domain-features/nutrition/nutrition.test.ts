import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  nutritionSourceRequest, retrieveNutritionSources,
  type NutritionBoundaryDisposition, type NutritionBoundaryPort, type NutritionJob,
  type NutritionSourceCandidate, type NutritionSourceJob, type NutritionSourceRequest,
} from '../../../src/domain-features/nutrition/index.js';

// Artificial retained observations prove transport and missingness, never nutrition outcomes.
const observation = {
  id: 'synthetic-observation', summary: 'Synthetic retained observation only.',
  appraisal: 'unappraised', conflicts: ['synthetic-conflict'], clinicalReadiness: 'CL-0',
};
const sourceContext = { revision: 'synthetic-revision', partial: true, omitted: ['synthetic-omission'] };
const candidate = (): NutritionSourceCandidate<typeof observation> => ({
  observation: structuredClone(observation), topicIds: ['NUT-I3'],
  provenance: { status: 'source-observation', sourceRevision: 'synthetic-revision',
    locator: 'synthetic-packet:12', limits: ['Synthetic fixture; not scientific evidence.'] },
});
const input = (): NutritionSourceJob => ({
  job: 'protein', question: '  Original question?  ', corrections: ['Original correction.'],
});
const boundary = (status: 'source-navigation-only' | 'hold' = 'source-navigation-only'): NutritionBoundaryPort => ({
  async assess() {
    return { status, policyRevision: 'synthetic-policy', locator: 'synthetic-policy:1',
      qualifications: ['Artificial routing fixture only.'] };
  },
});

test('explicit jobs map to all seven retained topics without interpreting question text', () => {
  const cases: [NutritionJob, string][] = [
    ['energy-uncertainty', 'NUT-I1'], ['deficit-surplus-rate', 'NUT-I2'], ['protein', 'NUT-I3'],
    ['nutrients-dietary-patterns', 'NUT-I4'], ['logging-accuracy', 'NUT-I5'],
    ['supplements', 'NUT-I6'], ['nutrition-boundaries', 'NUT-I7'],
  ];
  for (const [job, topic] of cases) {
    const request = nutritionSourceRequest({ ...input(), job, question: 'protein supplement deficit' });
    assert.deepEqual(request.topicIds, [topic]);
    assert.equal(request.consumer, 'CHAT');
  }
});

test('unsupported jobs and malformed questions stop before any dependency call', async () => {
  let called = false;
  const port = { async retrieve() { called = true; return { context: sourceContext, candidates: [], gaps: [] }; } };
  for (const job of ['toString', '__proto__', 'food-log', 'target-adoption']) {
    await assert.rejects(retrieveNutritionSources({ ...input(), job: job as NutritionJob }, port), /unsupported-nutrition-job/);
  }
  await assert.rejects(retrieveNutritionSources({ ...input(), question: ' ' }, port), /invalid-nutrition-source-job/);
  assert.equal(called, false);
});

test('retrieval preserves original text, corrections, observation qualifiers and full producer context', async () => {
  const original = input();
  const retained = candidate();
  const calls: NutritionSourceRequest[] = [];
  const result = await retrieveNutritionSources(original, {
    async retrieve(request) { calls.push(request); return { context: sourceContext, candidates: [retained], gaps: [] }; },
  }, boundary());
  assert.deepEqual(calls, [result.request]);
  assert.equal(result.request.question, original.question);
  assert.deepEqual(result.request.corrections, original.corrections);
  assert.notEqual(result.request.corrections, original.corrections);
  assert.deepEqual(result.candidates, [retained]);
  assert.deepEqual(result.retrievalContext, sourceContext);
  assert.deepEqual(result.traceableCandidateIndexes, [0]);
  assert.equal(result.status, 'source-observations');
  assert.equal(result.adviceAuthority, 'none');
  assert.equal(result.scientificAppraisal, 'not-performed');
});

test('missing policy permits source navigation but reports an unresolved dependency', async () => {
  const result = await retrieveNutritionSources(input(), {
    async retrieve() { return { context: sourceContext, candidates: [candidate()], gaps: [] }; },
  });
  assert.equal(result.status, 'evidence-gap');
  assert.deepEqual(result.gaps, [{ code: 'policy-unavailable' }]);
  assert.deepEqual(result.traceableCandidateIndexes, [0]);
  assert.equal(result.boundary.status, 'unavailable');
  assert.equal(result.adviceAuthority, 'none');
});

test('retrieval gaps retain exact qualifications and cannot become absence-of-evidence claims', async () => {
  const result = await retrieveNutritionSources(input(), {
    async retrieve() { return { context: sourceContext, candidates: [], gaps: ['No lexical match in this bounded projection.'] }; },
  }, boundary());
  assert.equal(result.status, 'evidence-gap');
  assert.deepEqual(result.gaps, [
    { code: 'retrieval-gap', detail: 'No lexical match in this bounded projection.' },
    { code: 'no-traceable-observations' },
  ]);
  assert.deepEqual(result.retrievalContext, sourceContext);
});

test('unqualified and unrelated candidates remain inspectable but are not source support', async () => {
  const unqualified: NutritionSourceCandidate<typeof observation> = {
    ...candidate(), provenance: { status: 'unqualified', reason: 'Missing original locator.' },
  };
  const outside = { ...candidate(), topicIds: ['NUT-I6'] };
  const result = await retrieveNutritionSources(input(), {
    async retrieve() { return { context: sourceContext, candidates: [unqualified, outside], gaps: [] }; },
  }, boundary());
  assert.deepEqual(result.candidates, [unqualified, outside]);
  assert.deepEqual(result.traceableCandidateIndexes, []);
  assert.deepEqual(result.gaps, [
    { code: 'candidate-unqualified', candidateIndex: 0 },
    { code: 'candidate-outside-topic', candidateIndex: 1 },
    { code: 'no-traceable-observations' },
  ]);
});

test('empty provenance or missing qualification text cannot mark an observation traceable', async () => {
  for (const fields of [{ sourceRevision: '' }, { locator: ' ' }, { limits: [] }, { limits: [' '] }]) {
    const retained = candidate();
    assert.equal(retained.provenance.status, 'source-observation');
    if (retained.provenance.status !== 'source-observation') throw new Error('fixture');
    const result = await retrieveNutritionSources(input(), {
      async retrieve() { return { context: sourceContext, candidates: [{ ...retained, provenance: { ...retained.provenance, ...fields } }], gaps: [] }; },
    }, boundary());
    assert.deepEqual(result.traceableCandidateIndexes, []);
    assert.equal(result.status, 'evidence-gap');
  }
});

test('partial retrieval remains a gap even when one observation is traceable', async () => {
  const result = await retrieveNutritionSources(input(), {
    async retrieve() { return { context: sourceContext, candidates: [candidate()], gaps: ['Uninspected original.'] }; },
  }, boundary());
  assert.deepEqual(result.traceableCandidateIndexes, [0]);
  assert.equal(result.status, 'evidence-gap');
  assert.deepEqual(result.gaps, [{ code: 'retrieval-gap', detail: 'Uninspected original.' }]);
});

test('boundary holds preserve policy qualifications and observations without advice', async () => {
  const result = await retrieveNutritionSources(input(), {
    async retrieve() { return { context: sourceContext, candidates: [candidate()], gaps: [] }; },
  }, boundary('hold'));
  assert.deepEqual(result.boundary, await boundary('hold').assess(result.request));
  assert.deepEqual(result.gaps, [{ code: 'boundary-hold' }]);
  assert.equal(result.adviceAuthority, 'none');
});

test('failed ports and missing policy provenance fail closed without leaking thrown details', async () => {
  const result = await retrieveNutritionSources(input(), {
    async retrieve() { throw new Error('provider-private-diagnostic'); },
  }, { async assess() { throw new Error('policy-private-diagnostic'); } });
  assert.equal(result.status, 'evidence-gap');
  assert.equal(result.retrievalContext, null);
  assert.deepEqual(result.gaps, [
    { code: 'policy-unavailable' }, { code: 'retrieval-unavailable' }, { code: 'no-traceable-observations' },
  ]);
  assert.equal(JSON.stringify(result).includes('private-diagnostic'), false);
  const disposition: NutritionBoundaryDisposition = {
    status: 'source-navigation-only', policyRevision: '', locator: 'synthetic', qualifications: [],
  };
  const missing = await retrieveNutritionSources(input(), {
    async retrieve() { return { context: sourceContext, candidates: [candidate()], gaps: [] }; },
  }, { async assess() { return disposition; } });
  assert.equal(missing.boundary.status, 'unavailable');
  assert.deepEqual(missing.gaps, [{ code: 'policy-unavailable' }]);
});
