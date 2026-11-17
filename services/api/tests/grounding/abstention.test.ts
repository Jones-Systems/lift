import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundingRetriever, type GroundingRequest } from '../../src/grounding/index.js';
import { composeGroundedAnswer, evaluateGroundedAnswer, type AnswerContext, type GroundedAnswer } from '../../src/grounding/answer.js';
import { createGroundedNutritionConversation, evaluateNutritionAnswer, nutritionAnswerContext,
  type NutritionAnswerExpectation } from '../../src/domain-features/nutrition/synthesis-adapter.js';
import type { NutritionConversationInput } from '../../src/domain-features/nutrition/conversation.js';
import { syntheticFixture, syntheticRecord } from './fixture.js';

const gapIntroduction = 'No matching observations were found for this search in the retained corpus.';
const answerContext: AnswerContext = { revision: 'context-1', facts: [], supersedesRevision: null };
const unmatched = 'Does running improve strength?';
const matched = 'What is the running strength signal for adults?';

function retriever(records = [syntheticRecord('SYN-S1'), syntheticRecord('SYN-S2', { title: 'Second synthetic title', summary: 'Second synthetic strength summary.' })]) {
  const { projection, binding } = syntheticFixture(records);
  return createGroundingRetriever(projection, binding);
}
const mutable = (answer: GroundedAnswer) => structuredClone(answer) as unknown as Record<string, unknown>;
const codes = (evaluation: ReturnType<typeof evaluateGroundedAnswer>): string[] => evaluation.failures.map(failure => failure.code);

test('an unmatched natural question composes an empty, fixed-introduction gap answer', () => {
  const native = retriever();
  const answer = composeGroundedAnswer(native, { retrieval: { query: unmatched }, context: answerContext });
  assert.equal(answer.status, 'gap');
  assert.deepEqual(answer.statements, []);
  assert.deepEqual(answer.options, []);
  assert.deepEqual(answer.conflicts, []);
  assert.equal(answer.introduction, gapIntroduction);
  assert.equal(answer.evidence.status, 'gap');
  assert.equal(answer.evidence.totalMatches, 0);
  assert.equal(answer.evidence.query, unmatched);
  assert.equal(answer.choice.automaticAdoption, false);
  const evaluation = evaluateGroundedAnswer(answer, native.retrieve({ query: unmatched }), answerContext);
  assert.equal(evaluation.passed, true);
});

test('informative statements and option titles are exactly the retained summary and title', () => {
  const native = retriever();
  const answer = composeGroundedAnswer(native, { retrieval: { query: matched }, context: answerContext });
  assert.equal(answer.status, 'informative');
  assert.equal(answer.evidence.query, matched);
  assert.equal(answer.statements.length, 1);
  const [entry] = answer.evidence.observations;
  assert.equal(entry?.record.id, 'SYN-S1');
  assert.equal(answer.statements[0]?.text, entry?.record.summary);
  assert.equal(answer.options[0]?.title, entry?.record.title);
  const both = composeGroundedAnswer(native, { retrieval: { query: 'What is the strength?' }, context: answerContext });
  assert.equal(both.statements.length, 2);
  both.evidence.observations.forEach(({ record }, index) => {
    assert.equal(both.statements[index]?.text, record.summary);
    assert.equal(both.options[index]?.title, record.title);
  });
});

test('the evaluator rejects a gap with an injected statement, an altered introduction or an altered statement', () => {
  const native = retriever();
  const gapRequest: GroundingRequest = { query: unmatched };
  const gap = composeGroundedAnswer(native, { retrieval: gapRequest, context: answerContext });
  const expectedGap = native.retrieve(gapRequest);
  assert.equal(evaluateGroundedAnswer(gap, expectedGap, answerContext).passed, true);

  const informative = composeGroundedAnswer(native, { retrieval: { query: matched }, context: answerContext });
  const injectedStatement = informative.statements[0];
  const injected = mutable(gap);
  injected.statements = [injectedStatement];
  const injectedEvaluation = evaluateGroundedAnswer(injected, expectedGap, answerContext);
  assert.equal(injectedEvaluation.passed, false);
  assert.ok(codes(injectedEvaluation).includes('statement_mismatch'));

  const introduction = mutable(gap);
  introduction.introduction = 'These retained research observations describe what the cited literature reports.';
  const introEvaluation = evaluateGroundedAnswer(introduction, expectedGap, answerContext);
  assert.equal(introEvaluation.passed, false);
  assert.ok(codes(introEvaluation).includes('malformed_answer'));

  const expectedMatch = native.retrieve({ query: matched });
  assert.equal(evaluateGroundedAnswer(informative, expectedMatch, answerContext).passed, true);
  const altered = mutable(informative);
  (altered.statements as { text: string }[])[0]!.text = 'An invented statement that the record does not contain.';
  const alteredEvaluation = evaluateGroundedAnswer(altered, expectedMatch, answerContext);
  assert.equal(alteredEvaluation.passed, false);
  assert.ok(codes(alteredEvaluation).includes('statement_mismatch'));
});

function nutritionRetriever() {
  const source = syntheticFixture([syntheticRecord('SYN-S1', { topic_ids: ['NUT-I3'],
    summary: 'Synthetic observation reports 12 arbitrary units; applicability unknown.' })]);
  source.projection.coverage.units[0]!.unit_id = 'NUT-I3';
  source.projection.corpus_status.units_without_observations = source.projection.coverage.units
    .map(unit => unit.unit_id).filter(id => id !== 'NUT-I3');
  return createGroundingRetriever(source.projection, source.binding);
}
const asking = (question: string): NutritionConversationInput => ({ choice: 'ask', previousTurnId: null,
  job: 'protein', question, userContext: ['User supplied synthetic context.'], correction: null });
const expectationFor = (input: NutritionConversationInput): NutritionAnswerExpectation => ({
  turnId: 1, previousTurnId: input.previousTurnId, job: input.job, question: input.question, userContext: input.userContext,
});

test('the nutrition path abstains on an unmatched question and keeps the exact question on a match', async () => {
  const native = nutritionRetriever();
  const miss = asking(unmatched);
  const gapState = await createGroundedNutritionConversation(native).submit(miss);
  const gap = gapState.currentExplanation!;
  assert.equal(gap.status, 'gap');
  assert.deepEqual(gap.statements, []);
  assert.deepEqual(gap.options, []);
  assert.equal(gap.evidence.query, unmatched);
  assert.equal(evaluateNutritionAnswer(gap, native.retrieve({ query: unmatched, topic: 'NUT-I3' }), expectationFor(miss)).passed, true);

  const hit = asking('What are the 12 arbitrary units for strength?');
  const state = await createGroundedNutritionConversation(native).submit(hit);
  const answer = state.currentExplanation!;
  assert.equal(answer.status, 'informative');
  assert.equal(answer.evidence.query, hit.question);
  assert.equal(answer.statements[0]?.text, 'Synthetic observation reports 12 arbitrary units; applicability unknown.');
  assert.deepEqual(answer.context, nutritionAnswerContext(1, null, hit.userContext));
  const evaluation = evaluateNutritionAnswer(answer, native.retrieve({ query: hit.question, topic: 'NUT-I3' }), expectationFor(hit));
  assert.equal(evaluation.passed, true);
});
