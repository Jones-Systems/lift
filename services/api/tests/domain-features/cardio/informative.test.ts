import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundingRetriever } from '../../../src/grounding/index.js';
import { createInformativeCardioConsumer } from '../../../src/domain-features/cardio/index.js';
import { informativeFixture } from './informative-fixture.js';

const choice = { optionId: 'SYN-S100', intent: 'explain_citation', confirmedByUser: true };

test('real composer preserves full summaries, qualifiers, off-page conflicts and bounded evaluation', () => {
  const { retriever, input } = informativeFixture();
  const expected = retriever.retrieve({ query: 'concurrent', topic: 'CAR-H4', limit: 20 });
  const result = createInformativeCardioConsumer(retriever).evaluate(input);
  assert.equal(result.answer.status, 'informative');
  assert.deepEqual(result.answer.evidence, expected);
  assert.equal(result.answer.statements[0]!.text, expected.observations[0]!.record.summary);
  assert.deepEqual(result.answer.statements[0]!.citation, expected.observations[0]);
  assert.equal(result.answer.statements[0]!.originalPassageVerified, false);
  assert.deepEqual(result.answer.conflicts, [{ observationId: 'SYN-S100', conflictingObservationId: 'SYN-S121', referencedObservationIncluded: false, disposition: 'unresolved' }]);
  assert.equal(result.answer.evidence.truncated, true);
  assert.equal(result.evaluation.passed, true);
  assert.deepEqual(result.evaluation.failures, []);
  assert.equal(result.evaluation.scientificValidityAssessed, false);
  assert.equal(result.evaluation.individualApplicabilityAssessed, false);
  assert.equal(result.allowed_action, 'consider_literature');
  assert.deepEqual(result.request, input);
  assert.equal(result.escalation_route, input.routing.escalation_route);
  assert.match(result.uncertainty_or_abstention.join(' '), /no training action/);
  assert.throws(() => { (result.answer.statements[0] as { text: string }).text = 'Changed'; });
});

test('real retrieval gaps retain missingness and cannot yield an option', () => {
  const { retriever, input } = informativeFixture();
  const consumer = createInformativeCardioConsumer(retriever);
  const current = { ...input, job: { kind: 'intensity', intent: 'explain', modality: 'cycling', method: 'heart_rate' } };
  const response = consumer.evaluate(current);
  assert.equal(response.answer.status, 'gap');
  assert.equal(response.answer.evidence.status, 'gap');
  assert.equal(response.evaluation.passed, true);
  assert.equal(response.allowed_action, 'abstain');
  assert.deepEqual(response.answer.options, []);
  assert.throws(() => consumer.select(response, choice, current), /unavailable_literature_option/);
});

test('explicit user choices stay unapplied and context/job corrections revoke old choices', () => {
  const { retriever, input } = informativeFixture();
  const consumer = createInformativeCardioConsumer(retriever);
  const first = consumer.evaluate(input);
  const selected = consumer.select(first, choice, input);
  assert.equal(selected.adoption, 'not_applied');
  assert.equal(selected.option.adoption, 'not_applied');
  assert.equal(selected.automaticAdoption, false);
  assert.equal(selected.nextIntent, 'explain_citation');
  assert.equal(consumer.isSelectionCurrent(selected, input), true);
  const corrected = { ...input, userContext: { revision: 'user-2', supersedesRevision: 'user-1', facts: [{ id: 'goal', text: 'I prefer endurance literature.', origin: 'user_provided' as const }] } };
  assert.equal(consumer.isCurrent(first, corrected), false);
  assert.throws(() => consumer.evaluate({ ...corrected, userContext: { ...corrected.userContext, revision: 'user-1' } }), /explicit_context_correction_required/);
  const second = consumer.evaluate(corrected);
  assert.deepEqual(second.answer.context, corrected.userContext);
  assert.equal(consumer.isSelectionCurrent(selected, input), false);
  assert.throws(() => consumer.select(first, choice, input), /stale_or_unissued/);
  const changedJob = { ...corrected, job: { ...input.job, outcome: 'endurance' } };
  assert.throws(() => consumer.evaluate(changedJob), /explicit_job_revision_required/);
  const third = consumer.evaluate({ ...changedJob, jobRevision: 'job-2' });
  assert.equal(third.evaluation.passed, true);
  assert.equal(consumer.isCurrent(second, corrected), false);
});

test('source revisions, digests, routes and correction/withdrawal invalidate selections', () => {
  const { retriever, input } = informativeFixture();
  const consumer = createInformativeCardioConsumer(retriever);
  for (const reason of ['correction', 'source_change', 'deletion', 'consent_withdrawal'] as const) {
    const response = consumer.evaluate(input);
    const selected = consumer.select(response, choice, input);
    for (const field of ['sourceRevision', 'corpusInputSha256', 'trainingRoute', 'regionalRoute', 'confirmation_state', 'escalation_route'] as const) {
      const current = { ...input, routing: { ...input.routing, [field]: 'changed' } };
      assert.equal(consumer.isSelectionCurrent(selected, current), false);
      assert.throws(() => consumer.select(response, choice, current), /stale_or_unissued/);
    }
    consumer.invalidate(reason);
    assert.equal(consumer.isSelectionCurrent(selected, input), false);
    assert.throws(() => consumer.select(response, choice, input), /stale_or_unissued/);
  }
  assert.throws(() => consumer.evaluate({ ...input, routing: { ...input.routing, sourceRevision: 'stale' } }), /stale_evidence_binding/);
});

test('selection checks current source content independently of the saved answer', () => {
  const { retriever, projection, binding, input } = informativeFixture();
  let current = retriever;
  const consumer = createInformativeCardioConsumer({ retrieve: request => current.retrieve(request) });
  const response = consumer.evaluate(input);
  const selected = consumer.select(response, choice, input);
  projection.records[0]!.record = { ...projection.records[0]!.record, summary: projection.records[0]!.record.summary + ' Corrected observation.' };
  current = createGroundingRetriever(projection, binding);
  assert.throws(() => consumer.select(response, choice, input), /stale_literature_option/);
  assert.equal(consumer.isSelectionCurrent(selected, input), false);
});

test('wearable provenance, clinical actions and automatic selections reject before retrieval', () => {
  const { retriever, input } = informativeFixture();
  let calls = 0;
  const consumer = createInformativeCardioConsumer({ retrieve(request) { calls++; return retriever.retrieve(request); } });
  for (const origin of ['wearable', 'imported_wearable', 'inferred']) {
    assert.throws(() => consumer.evaluate({ ...input, userContext: { ...input.userContext, facts: [{ id: 'sleep', text: '8 hours', origin }] } }));
  }
  for (const intent of ['diagnose', 'treat', 'clearance', 'apply_workout']) {
    assert.throws(() => consumer.evaluate({ ...input, job: { ...input.job, intent } }));
  }
  assert.throws(() => consumer.evaluate({ ...input, importedWearable: { heartRate: 170 } }));
  assert.throws(() => consumer.evaluate({ ...input, job: { ...input.job, wearableData: [170] } }));
  assert.equal(calls, 0);
  const response = consumer.evaluate(input);
  const beforeSelection = calls;
  for (const invalid of [{ ...choice, confirmedByUser: false }, { ...choice, intent: 'apply_workout' }, { ...choice, automaticAdoption: true }]) assert.throws(() => consumer.select(response, invalid, input));
  assert.equal(calls, beforeSelection);
});
