import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroundingRetriever } from '../../../src/grounding/index.js';
import { syntheticFixture, syntheticRecord } from '../../grounding/fixture.js';
import { createNutritionGroundingPort } from '../../../src/domain-features/nutrition/grounding-adapter.js';
import { createNutritionConversation, type NutritionConversationInput,
  type NutritionInformativeSynthesisPort } from '../../../src/domain-features/nutrition/conversation.js';

function grounding() {
  const fixture = syntheticFixture([syntheticRecord('SYN-S1', { topic_ids: ['NUT-I3'] })]);
  fixture.projection.coverage.units[0]!.unit_id = 'NUT-I3';
  fixture.projection.corpus_status.units_without_observations = fixture.projection.coverage.units
    .map(unit => unit.unit_id).filter(id => id !== 'NUT-I3');
  return createNutritionGroundingPort(createGroundingRetriever(fixture.projection, fixture.binding));
}

const ask = (): NutritionConversationInput => ({ choice: 'ask', previousTurnId: null, job: 'protein',
  question: 'strength', userContext: ['Synthetic initial context.'], correction: null });
const correction = (): NutritionConversationInput => ({ choice: 'correct-question', previousTurnId: 1,
  job: 'protein', question: 'running', userContext: ['Synthetic replacement context.'],
  correction: 'I meant the retained running observation.' });

// This opaque test output exercises transport only; it is not a shared synthesis schema or clinical answer.
const synthesis: NutritionInformativeSynthesisPort<{ query: string; sourceIds: string[]; qualification: string }> = {
  async explain({ sources }) {
    return { query: sources.request.question, sourceIds: sources.candidates.map(item => item.observation.record.id),
      qualification: 'Artificial explanation fixture; source qualification remains in complete sources.' };
  },
};

test('informative synthesis receives complete source gaps despite unresolved medical policy', async () => {
  let called = false;
  const conversation = createNutritionConversation({ grounding: grounding(), synthesis: {
    async explain(input) {
      called = true;
      assert.equal(input.turnId, 1);
      assert.equal(input.previousTurnId, null);
      assert.equal(input.sources.retrievalContext?.clinicalReadiness, 'CL-0');
      assert.equal(input.sources.retrievalContext?.verbatimPassagesAvailable, false);
      assert.equal(input.sources.status, 'evidence-gap');
      assert.ok(input.sources.gaps.some(gap => gap.code === 'policy-unavailable'));
      assert.equal(input.sources.candidates[0]?.observation.record.form_appraisal, 'Synthetic incomplete appraisal; full text unavailable.');
      assert.deepEqual(input.userContext, ask().userContext);
      assert.equal('previousExplanation' in input, false);
      return synthesis.explain(input);
    },
  } });
  const state = await conversation.submit(ask());
  assert.equal(called, true);
  assert.equal(state.turns[0]?.status, 'explanation');
  assert.deepEqual(state.currentExplanation?.sourceIds, ['SYN-S1']);
  assert.equal(state.automaticAdoption, 'none');
});

test('explicit correction propagates replacement query and preserves original, source and correction lineage', async () => {
  const conversation = createNutritionConversation({ grounding: grounding(), synthesis });
  const original = await conversation.submit(ask());
  const corrected = await conversation.submit(correction());
  assert.equal(corrected.currentExplanation?.query, 'running');
  assert.deepEqual(corrected.turns[0], original.turns[0]);
  assert.equal(corrected.turns[1]?.supersedesTurnId, 1);
  assert.equal(corrected.turns[1]?.input.previousTurnId, 1);
  assert.equal(corrected.turns[1]?.sources?.retrievalContext?.query, 'running');
  assert.deepEqual(corrected.turns[1]?.sources?.request.corrections, [correction().correction]);
  assert.equal(corrected.turns[0]?.explanation?.query, 'strength');
  assert.equal(corrected.currentTurnId, 2);
});

test('accepted replacement hides old answer immediately and failed synthesis never resurrects it', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const conversation = createNutritionConversation({ grounding: grounding(), synthesis: {
    async explain(input) {
      if (input.sources.request.question === 'running') { await gate; throw new Error('synthetic private failure'); }
      return synthesis.explain(input);
    },
  } });
  await conversation.submit(ask());
  const pending = conversation.submit(correction());
  assert.equal(conversation.snapshot().currentExplanation, null);
  assert.equal(conversation.snapshot().turns[1]?.status, 'pending');
  await assert.rejects(conversation.submit({ ...correction(), previousTurnId: 2 }), /nutrition-turn-in-progress/);
  release();
  const failed = await pending;
  assert.equal(failed.currentExplanation, null);
  assert.equal(failed.turns[1]?.status, 'synthesis-unavailable');
  assert.equal(failed.turns[0]?.explanation?.query, 'strength');
  assert.equal(failed.rejectedChoices[0]?.reason, 'nutrition-turn-in-progress');
  assert.equal(JSON.stringify(failed).includes('private failure'), false);
});

test('stale choices are visible and cannot replay a superseded answer or trigger another retrieval', async () => {
  const conversation = createNutritionConversation({ grounding: grounding(), synthesis });
  await conversation.submit(ask());
  await conversation.submit(correction());
  await assert.rejects(conversation.submit(correction()), /stale-nutrition-turn/);
  const state = conversation.snapshot();
  assert.equal(state.turns.length, 2);
  assert.equal(state.currentExplanation?.query, 'running');
  assert.deepEqual(state.rejectedChoices, [{ input: correction(), reason: 'stale-nutrition-turn' }]);
});

test('context replacement and followthrough require explicit user choices and retain the complete turn chain', async () => {
  const conversation = createNutritionConversation({ grounding: grounding(), synthesis });
  await conversation.submit(ask());
  const contextual = { ...correction(), choice: 'update-context' as const, correction: 'Replace my earlier context.' };
  await conversation.submit(contextual);
  let previousTurnId = 2;
  for (const choice of ['continue-question', 'source-explanation', 'request-clarification'] as const) {
    const state = await conversation.submit({ ...ask(), choice, previousTurnId,
      userContext: ['Synthetic replacement context.'] });
    assert.equal(state.turns.at(-1)?.input.choice, choice);
    assert.equal(state.turns.at(-1)?.input.previousTurnId, previousTurnId);
    assert.deepEqual(state.turns.at(-1)?.sources?.request.corrections, ['Replace my earlier context.']);
    assert.equal(state.automaticAdoption, 'none');
    previousTurnId += 1;
  }
  const state = conversation.snapshot();
  assert.equal(state.turns.length, 5);
  assert.equal(state.turns[1]?.supersedesTurnId, 1);
  assert.deepEqual(state.turns[0]?.input.userContext, ask().userContext);
  assert.deepEqual(state.turns[1]?.input.userContext, contextual.userContext);
});

test('missing synthesis and failed retrieval stay explicit without reusing an old explanation', async () => {
  const unbound = createNutritionConversation({ grounding: grounding() });
  const absent = await unbound.submit(ask());
  assert.equal(absent.turns[0]?.status, 'synthesis-unavailable');
  assert.ok(absent.turns[0]?.sources?.retrievalContext);
  assert.equal(absent.currentExplanation, null);
  const failing = createNutritionConversation({ grounding: { async retrieve() { throw new Error('synthetic'); } }, synthesis });
  const failed = await failing.submit(ask());
  assert.equal(failed.turns[0]?.status, 'retrieval-unavailable');
  assert.ok(failed.turns[0]?.sources?.gaps.some(gap => gap.code === 'retrieval-unavailable'));
  assert.equal(failed.currentExplanation, null);
});

test('caller and snapshot mutation cannot rewrite accepted lineage and implicit correction is rejected', async () => {
  const conversation = createNutritionConversation({ grounding: grounding(), synthesis });
  const input = ask();
  const pending = conversation.submit(input);
  (input.userContext as string[])[0] = 'changed externally';
  const state = await pending;
  assert.deepEqual(state.turns[0]?.input.userContext, ['Synthetic initial context.']);
  (state.turns as unknown[]).length = 0;
  assert.equal(conversation.snapshot().turns.length, 1);
  await assert.rejects(conversation.submit({ ...correction(), correction: null }), /invalid-nutrition-correction/);
  await assert.rejects(conversation.submit({ ...ask(), previousTurnId: 1 }), /invalid-nutrition-turn-choice/);
  assert.equal(conversation.snapshot().turns.length, 1);
});
