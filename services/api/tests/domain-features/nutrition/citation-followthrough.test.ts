import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroundingRetriever } from '../../../src/grounding/index.js';
import { syntheticFixture, syntheticRecord } from '../../grounding/fixture.js';
import { createNutritionCitationConversation } from '../../../src/domain-features/nutrition/citation-followthrough.js';
import type { NutritionConversationInput } from '../../../src/domain-features/nutrition/conversation.js';

function fixture() {
  const source = syntheticFixture(Array.from({ length: 21 }, (_, index) =>
    syntheticRecord(`SYN-S${String(index + 1).padStart(2, '0')}`, { topic_ids: ['NUT-I3'],
      conflicts: index === 0 ? ['SYN-S21'] : index === 1 ? ['SYN-S01'] : [] })));
  source.projection.coverage.units[0]!.unit_id = 'NUT-I3';
  source.projection.corpus_status.units_without_observations = source.projection.coverage.units
    .map(unit => unit.unit_id).filter(id => id !== 'NUT-I3');
  return createGroundingRetriever(source.projection, source.binding);
}
const initial = (): NutritionConversationInput => ({ choice: 'ask', previousTurnId: null,
  job: 'protein', question: 'strength', userContext: ['Synthetic user context.'], correction: null });
const corrected = (): NutritionConversationInput => ({ ...initial(), choice: 'correct-question', previousTurnId: 1,
  question: 'running', userContext: ['Explicit synthetic correction.'], correction: 'Use the replacement question.' });

test('explicit citation selection retains full native statement, qualifications and relevant off-page conflicts without retrieval', async () => {
  const native = fixture();
  let calls = 0;
  const conversation = createNutritionCitationConversation({ retrieve(request) { calls += 1; return native.retrieve(request); } });
  const accepted = await conversation.submit(initial());
  const selected = conversation.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' });
  assert.equal(calls, 1);
  assert.deepEqual(selected.currentSelection?.statement, accepted.conversation.currentExplanation?.statements[0]);
  assert.deepEqual(selected.currentSelection?.sources, accepted.conversation.turns[0]?.sources);
  assert.deepEqual(selected.currentSelection?.conflicts, [
    { observationId: 'SYN-S01', conflictingObservationId: 'SYN-S21', referencedObservationIncluded: false, disposition: 'unresolved' },
    { observationId: 'SYN-S02', conflictingObservationId: 'SYN-S01', referencedObservationIncluded: true, disposition: 'unresolved' },
  ]);
  assert.ok(selected.currentSelection?.sources.gaps.some(gap => gap.code === 'policy-unavailable'));
  assert.equal(selected.currentSelection?.sources.retrievalContext?.truncated, true);
  assert.equal(selected.currentSelection?.statement.citation.record.clinical_readiness, 'CL-0');
  assert.equal(selected.conversation.currentExplanation?.choice.automaticAdoption, false);
  assert.equal(selected.conversation.currentExplanation?.contextUse, 'acknowledged_not_applicability_assessed');
});

test('unknown or off-page statement selection stays explicit without searching or retaining a different active citation', async () => {
  const native = fixture();
  let calls = 0;
  const conversation = createNutritionCitationConversation({ retrieve(request) { calls += 1; return native.retrieve(request); } });
  await conversation.submit(initial());
  conversation.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' });
  for (const statementId of ['missing-statement', 'SYN-S21']) {
    const state = conversation.selectCitation({ parentTurnId: 1, statementId });
    assert.equal(state.selections.at(-1)?.status, 'unknown-statement');
    assert.equal(state.currentSelection, null);
  }
  assert.equal(calls, 1);
  assert.equal(conversation.snapshot().selections[0]?.status, 'selected');
});

test('accepted correction invalidates citation immediately while pending and requires selection from the new turn', async () => {
  const conversation = createNutritionCitationConversation(fixture());
  await conversation.submit(initial());
  const original = conversation.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' });
  const pending = conversation.submit(corrected());
  assert.equal(conversation.snapshot().currentSelection, null);
  assert.equal(conversation.snapshot().conversation.turns[1]?.status, 'pending');
  assert.equal(conversation.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' }).selections.at(-1)?.status, 'stale-turn');
  assert.equal(conversation.selectCitation({ parentTurnId: 2, statementId: 'SYN-S01' }).selections.at(-1)?.status, 'answer-unavailable');
  await pending;
  assert.equal(conversation.snapshot().currentSelection, null);
  const selected = conversation.selectCitation({ parentTurnId: 2, statementId: 'SYN-S01' });
  assert.equal(selected.currentSelection?.parentTurnId, 2);
  assert.deepEqual(selected.selections[0], original.selections[0]);
  assert.deepEqual(selected.currentSelection?.sources.request.corrections, [corrected().correction]);
  assert.equal(selected.currentSelection?.sources.retrievalContext?.query, 'running');
});

test('failed accepted turn never resurrects an old citation and preserves failed selection lineage', async () => {
  const native = fixture();
  const conversation = createNutritionCitationConversation({ retrieve(request) {
    if (request.query === 'running') throw new Error('synthetic retrieval failure');
    return native.retrieve(request);
  } });
  await conversation.submit(initial());
  conversation.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' });
  const pending = conversation.submit(corrected());
  assert.equal(conversation.snapshot().currentSelection, null);
  const failed = await pending;
  assert.equal(failed.conversation.turns[1]?.status, 'retrieval-unavailable');
  assert.equal(failed.currentSelection, null);
  assert.equal(conversation.selectCitation({ parentTurnId: 2, statementId: 'SYN-S01' }).selections.at(-1)?.status, 'answer-unavailable');
  assert.equal(conversation.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' }).selections.at(-1)?.status, 'stale-turn');
  assert.equal(conversation.snapshot().selections[0]?.status, 'selected');
});

test('selection history is ordered and copied, and rejected turn inputs do not invalidate the accepted citation', async () => {
  const conversation = createNutritionCitationConversation(fixture());
  await conversation.submit(initial());
  const first = conversation.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' });
  const second = conversation.selectCitation({ parentTurnId: 1, statementId: 'SYN-S02' });
  assert.deepEqual(second.selections.map(item => item.id), [1, 2]);
  assert.deepEqual(second.selections[0], first.selections[0]);
  (second.selections as unknown[]).length = 0;
  (second.currentSelection!.sources.request.corrections as string[]).push('external mutation');
  assert.equal(conversation.snapshot().selections.length, 2);
  assert.deepEqual(conversation.snapshot().currentSelection?.sources.request.corrections, []);
  await assert.rejects(conversation.submit({ ...corrected(), previousTurnId: 0 }), /stale-nutrition-turn/);
  assert.equal(conversation.snapshot().currentSelection?.statementId, 'SYN-S02');
  assert.equal(conversation.snapshot().conversation.rejectedChoices.length, 1);
});

test('gap answers have no selectable citation and preserve the bounded no-match answer', async () => {
  const conversation = createNutritionCitationConversation(fixture());
  const accepted = await conversation.submit({ ...initial(), question: 'nonexistenttoken' });
  assert.equal(accepted.conversation.currentExplanation?.status, 'gap');
  const selected = conversation.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' });
  assert.equal(selected.currentSelection, null);
  assert.equal(selected.selections.at(-1)?.status, 'unknown-statement');
  assert.deepEqual(selected.conversation, accepted.conversation);
});
