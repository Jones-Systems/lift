import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroundingRetriever } from '../../../src/grounding/index.js';
import { syntheticFixture, syntheticRecord } from '../../grounding/fixture.js';
import { createNutritionGroundingPort } from '../../../src/domain-features/nutrition/grounding-adapter.js';
import { retrieveNutritionSources } from '../../../src/domain-features/nutrition/index.js';
import { createGroundedNutritionConversation, createNutritionInformativeSynthesisPort,
  evaluateNutritionAnswer, nutritionAnswerContext, type NutritionAnswerExpectation } from '../../../src/domain-features/nutrition/synthesis-adapter.js';
import type { NutritionConversationInput } from '../../../src/domain-features/nutrition/conversation.js';

function fixture() {
  const source = syntheticFixture([syntheticRecord('SYN-S1', { topic_ids: ['NUT-I3'],
    summary: 'Synthetic observation reports 12 arbitrary units; applicability unknown.' })]);
  source.projection.coverage.units[0]!.unit_id = 'NUT-I3';
  source.projection.corpus_status.units_without_observations = source.projection.coverage.units
    .map(unit => unit.unit_id).filter(id => id !== 'NUT-I3');
  return source;
}
function retriever() {
  const { projection, binding } = fixture();
  return createGroundingRetriever(projection, binding);
}
const initial = (): NutritionConversationInput => ({ choice: 'ask', previousTurnId: null,
  job: 'protein', question: 'strength', userContext: ['User supplied synthetic context.'], correction: null });
const expectation = (input = initial(), turnId = 1): NutritionAnswerExpectation => ({
  turnId, previousTurnId: input.previousTurnId, job: input.job, question: input.question, userContext: input.userContext,
});

test('native nutrition composition retrieves once and retains quantitative source text, qualifications and choice', async () => {
  const native = retriever();
  let retrievals = 0;
  const conversation = createGroundedNutritionConversation({ retrieve(request) { retrievals += 1; return native.retrieve(request); } });
  const state = await conversation.submit(initial());
  assert.equal(retrievals, 1);
  const answer = state.currentExplanation!;
  assert.equal(answer.status, 'informative');
  assert.equal(answer.statements[0]?.text, fixture().projection.records[0]!.record.summary);
  assert.deepEqual(answer.statements[0]?.citation, fixture().projection.records[0]);
  assert.equal(answer.statements[0]?.originalPassageVerified, false);
  assert.equal(answer.options[0]?.adoption, 'not_applied');
  assert.equal(answer.choice.decisionOwner, 'user');
  assert.equal(answer.choice.automaticAdoption, false);
  assert.equal(answer.contextUse, 'acknowledged_not_applicability_assessed');
  assert.deepEqual(answer.context, nutritionAnswerContext(1, null, initial().userContext));
  assert.ok(state.turns[0]?.sources?.gaps.some(gap => gap.code === 'policy-unavailable'));
  const independentEvidence = retriever().retrieve({ query: 'strength', topic: 'NUT-I3' });
  const evaluation = evaluateNutritionAnswer(answer, independentEvidence, expectation());
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.fidelity.scope, 'source_fidelity_and_contract');
  assert.equal(evaluation.fidelity.scientificValidityAssessed, false);
  assert.equal(evaluation.fidelity.individualApplicabilityAssessed, false);
  assert.equal(evaluation.fidelity.publicationRightsAssessed, false);
});

test('fresh explicit corrections change retrieval/context and invalidate the old native answer', async () => {
  const conversation = createGroundedNutritionConversation(retriever());
  const original = await conversation.submit(initial());
  const replacement: NutritionConversationInput = { ...initial(), choice: 'correct-question', previousTurnId: 1,
    question: 'arbitrary units', userContext: ['User supplied corrected context.'], correction: 'Use my replacement question.' };
  const corrected = await conversation.submit(replacement);
  const independentEvidence = retriever().retrieve({ query: replacement.question, topic: 'NUT-I3' });
  assert.equal(evaluateNutritionAnswer(corrected.currentExplanation, independentEvidence, expectation(replacement, 2)).passed, true);
  assert.equal(corrected.currentExplanation?.context.supersedesRevision, 'nutrition-turn-1');
  assert.deepEqual(corrected.turns[1]?.sources?.request.corrections, [replacement.correction]);
  const stale = evaluateNutritionAnswer(original.currentExplanation, independentEvidence, expectation(replacement, 2));
  assert.equal(stale.passed, false);
  assert.ok(stale.fidelity.failures.some(failure => failure.code === 'context_mismatch'));
  assert.ok(stale.fidelity.failures.some(failure => failure.code === 'source_mismatch'));
  assert.deepEqual(corrected.turns[0], original.turns[0]);
});

test('context-only replacement invalidates old context even when source retrieval stays identical', async () => {
  const conversation = createGroundedNutritionConversation(retriever());
  const original = await conversation.submit(initial());
  const replacement: NutritionConversationInput = { ...initial(), choice: 'update-context', previousTurnId: 1,
    userContext: ['Explicitly replaced synthetic fact.'], correction: 'Replace my context only.' };
  const corrected = await conversation.submit(replacement);
  const evidence = retriever().retrieve({ query: 'strength', topic: 'NUT-I3' });
  const stale = evaluateNutritionAnswer(original.currentExplanation, evidence, expectation(replacement, 2));
  assert.equal(stale.passed, false);
  assert.deepEqual(stale.fidelity.failures, [{ code: 'context_mismatch', statementId: null }]);
  assert.equal(evaluateNutritionAnswer(corrected.currentExplanation, evidence, expectation(replacement, 2)).passed, true);
});

test('native evaluation rejects tampered qualifiers, choice, missingness and context against separate expectations', async () => {
  const state = await createGroundedNutritionConversation(retriever()).submit(initial());
  const answer = state.currentExplanation!;
  const evidence = retriever().retrieve({ query: 'strength', topic: 'NUT-I3' });
  const tampered: [unknown, string][] = [
    [{ ...answer, statements: answer.statements.map(statement => ({ ...statement,
      citation: { ...statement.citation, record: { ...statement.citation.record, form_appraisal: 'fabricated certainty' } },
    })) }, 'qualifier_loss'],
    [{ ...answer, choice: { ...answer.choice, automaticAdoption: true } }, 'choice_violation'],
    [{ ...answer, evidence: { ...answer.evidence, verbatimPassagesAvailable: true } }, 'missingness_loss'],
    [{ ...answer, context: { ...answer.context, facts: [] } }, 'context_mismatch'],
  ];
  for (const [candidate, code] of tampered) {
    const evaluation = evaluateNutritionAnswer(candidate, evidence, expectation());
    assert.equal(evaluation.passed, false);
    assert.ok(evaluation.fidelity.failures.some(failure => failure.code === code), code);
  }
});

test('native bounded no-match composes a useful gap without losing nutrition or corpus missingness', async () => {
  const input = { ...initial(), question: 'nonexistenttoken' };
  const state = await createGroundedNutritionConversation(retriever()).submit(input);
  assert.equal(state.turns[0]?.status, 'explanation');
  assert.equal(state.currentExplanation?.status, 'gap');
  assert.deepEqual(state.currentExplanation?.statements, []);
  assert.deepEqual(state.currentExplanation?.options, []);
  assert.ok(state.turns[0]?.sources?.gaps.some(gap => gap.code === 'no-traceable-observations'));
  assert.equal(state.currentExplanation?.evidence.corpusStatus.state, 'partial');
  const evidence = retriever().retrieve({ query: input.question, topic: 'NUT-I3' });
  assert.equal(evaluateNutritionAnswer(state.currentExplanation, evidence, expectation(input)).passed, true);
});

test('composition rejects mismatched cached evidence and evaluation binds its oracle to the current nutrition request', async () => {
  const sources = await retrieveNutritionSources({ job: 'protein', question: 'strength', corrections: [] },
    createNutritionGroundingPort(retriever()));
  await assert.rejects(createNutritionInformativeSynthesisPort().explain({ turnId: 1, previousTurnId: null,
    choice: 'ask', userContext: [], sources: { ...sources, request: { ...sources.request, question: 'changed' } },
  }), /nutrition-answer-evidence-request-mismatch/);
  const state = await createGroundedNutritionConversation(retriever()).submit(initial());
  const evidence = retriever().retrieve({ query: 'strength', topic: 'NUT-I3' });
  const wrongTopic = evaluateNutritionAnswer(state.currentExplanation, evidence, { ...expectation(), job: 'supplements' });
  assert.equal(wrongTopic.fidelity.passed, true);
  assert.equal(wrongTopic.requestMatchesExpectedEvidence, false);
  assert.equal(wrongTopic.passed, false);
  assert.throws(() => nutritionAnswerContext(2, null, []), /invalid-nutrition-answer-lineage/);
});
