import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import type { GroundingResult } from '../../../src/grounding/index.js';
import { createFormFollowupGroundingRetriever } from '../../../src/grounding/form-artifact.js';
import { createNutritionConversationHost, NutritionConversationUnavailable } from '../../../src/integration/nutrition-conversation/index.js';
import type { NutritionConversationInput } from '../../../src/domain-features/nutrition/conversation.js';
import type { NutritionCitationState } from '../../../src/domain-features/nutrition/citation-followthrough.js';
import { proteinOriginal, proteinCoverage, proteinCorpusStatus } from './form-nutrition-oracle.js';

// Measured successor input only; expected evidence remains frozen independently in the packet oracle.
const artifact = { sha256: '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10', bytes: 80588, corpusInputSha256: 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971' };
const source = { repository: 'Jones-Systems/Form', revision: '0c68e72727f04a7307407a4a6b73d43b7dca61a6',
  corpusRoot: 'docs/knowledge/research-followups', corpusInputSha256: artifact.corpusInputSha256 };
const firstQuestion = 'protein supplementation resistance training';
const gapQuestion = 'How should I distribute protein across breakfast and dinner?';
const followupQuestion = 'FFM proxy';
const initial: NutritionConversationInput = { choice: 'ask', previousTurnId: null, job: 'protein', question: firstQuestion,
  userContext: ['Artificial participant wants to understand protein supplementation research.'], correction: null };
const corrected: NutritionConversationInput = { ...initial, choice: 'update-context', previousTurnId: 1,
  userContext: ['I am restricting energy intake.', 'Explain the study scope without choosing a supplement or intake target.'],
  correction: 'Replace my context: I am restricting energy intake.' };

function expectedEvidence(question: string): GroundingResult {
  assert.ok([firstQuestion, gapQuestion, followupQuestion].includes(question));
  const common = { schema: 'form.observation-grounding/v1' as const, source, clinicalReadiness: 'CL-0' as const,
    coverage: proteinCoverage, corpusStatus: proteinCorpusStatus, query: question,
    filters: { topic: 'NUT-I3', access: null }, limit: 20, truncated: false, verbatimPassagesAvailable: false as const };
  return question === gapQuestion
    ? { ...common, totalMatches: 0, status: 'gap', reason: 'no_matching_observations', observations: [] }
    : { ...common, totalMatches: 1, status: 'observations', observations: [proteinOriginal] };
}

function assertTrace(state: NutritionCitationState): void {
  assert.equal(state.conversation.automaticAdoption, 'none');
  const corrections: string[] = [];
  for (const turn of state.conversation.turns) {
    assert.equal(turn.status, 'explanation');
    if (turn.input.correction) corrections.push(turn.input.correction);
    const answer = turn.explanation, sources = turn.sources;
    assert.ok(answer && sources);
    const evidence = expectedEvidence(turn.input.question);
    assert.deepEqual(answer.evidence, evidence);
    assert.deepEqual(sources.retrievalContext, evidence);
    assert.deepEqual(sources.request, { job: 'protein', question: turn.input.question,
      corrections: [...corrections], consumer: 'CHAT', topicIds: ['NUT-I3'] });
    assert.equal(sources.adviceAuthority, 'none');
    assert.equal(sources.scientificAppraisal, 'not-performed');
    assert.equal(sources.status, 'evidence-gap');
    assert.deepEqual(sources.boundary, { status: 'unavailable', reason: 'medical-boundary-policy-not-bound' });
    assert.ok(sources.gaps.some(item => item.code === 'policy-unavailable'));
    assert.deepEqual(sources.candidates.map(item => item.observation), evidence.observations);
    for (const candidate of sources.candidates) {
      assert.equal(candidate.provenance.status, 'source-observation');
      if (candidate.provenance.status !== 'source-observation') throw Error('source provenance missing');
      assert.equal(candidate.provenance.sourceRevision, source.revision);
      assert.equal(candidate.provenance.locator, 'docs/knowledge/research-followups/sources/nut-i3-protein-original.md:9');
      assert.deepEqual(candidate.provenance.limits, [proteinCorpusStatus.limitation, 'access-level: partial',
        proteinOriginal.record.source_native_certainty, proteinOriginal.record.form_appraisal, proteinOriginal.record.applicability,
        proteinOriginal.record.rights_status, proteinOriginal.record.freshness_status, proteinOriginal.record.provenance]);
    }
    assert.deepEqual(answer.context, { revision: `nutrition-turn-${turn.id}`,
      supersedesRevision: turn.id === 1 ? null : `nutrition-turn-${turn.id - 1}`,
      facts: turn.input.userContext.map((text, index) => ({ id: `nutrition-turn-${turn.id}-fact-${index + 1}`, text, origin: 'user_provided' })) });
    assert.equal(answer.contextUse, 'acknowledged_not_applicability_assessed');
    assert.equal(answer.status, evidence.status === 'gap' ? 'gap' : 'informative');
    assert.deepEqual(answer.statements, evidence.observations.map(citation => ({ id: 'NUT-S034',
      evidenceKind: 'retained_source_observation', text: proteinOriginal.record.summary, citation, originalPassageVerified: false })));
    assert.deepEqual(answer.options, evidence.observations.map(() => ({ id: 'NUT-S034', kind: 'literature_consideration',
      title: proteinOriginal.record.title, statementId: 'NUT-S034', adoption: 'not_applied' })));
    assert.deepEqual(answer.conflicts, []);
    assert.deepEqual(answer.choice, { decisionOwner: 'user', automaticAdoption: false,
      text: 'You can use these observations when considering your options. No choice or change has been applied.' });
  }
  if (state.currentSelection) {
    assert.equal(state.currentSelection.parentTurnId, state.conversation.currentTurnId);
    assert.deepEqual(state.currentSelection.statement.citation, proteinOriginal);
    assert.equal(state.currentSelection.statement.originalPassageVerified, false);
    assert.deepEqual(state.currentSelection.sources, state.conversation.turns.at(-1)?.sources);
  }
}

function fixture(t: TestContext) {
  const bytes = readFileSync(new URL(`../../../grounding/${artifact.sha256}/projection.json`, import.meta.url));
  assert.equal(bytes.byteLength, artifact.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  const retriever = createFormFollowupGroundingRetriever(bytes);
  const actor = { accountId: 'artificial-protein-account', authUserId: 'artificial-protein-user', sessionId: 'artificial-protein-session', epoch: 0 };
  const lifetime = { conversation: {}, generation: {} }, request = { identity: {}, signal: new AbortController().signal };
  let checks = 0;
  const host = createNutritionConversationHost({ retriever, bindings: { actor, lifetime,
    lifecycle: { assertActive: captured => { checks++; assert.deepEqual(captured, actor); } },
    isCurrentHost: (captured, capturedActor) => captured.conversation === lifetime.conversation
      && captured.generation === lifetime.generation && capturedActor.accountId === actor.accountId,
    captureRequest: () => request, isCurrentRequest: identity => identity === request.identity,
  } });
  assert.equal(host.status, 'available');
  if (host.status !== 'available') throw Error('real host unavailable');
  t.after(host.dispose);
  return { host, checks: () => checks };
}

const unavailable = (error: unknown) => error instanceof NutritionConversationUnavailable
  && error.outcome === 'not-started' && !Object.hasOwn(error, 'state');

test('EVAL-FORM-NUT-01: real successor supports qualified protein, correction, citation, bounded gap and useful follow-up', async t => {
  const { host, checks } = fixture(t);
  const original = await host.submit(initial);
  assertTrace(original);
  const selected = host.selectCitation({ parentTurnId: 1, statementId: 'NUT-S034' });
  assert.equal(selected.currentSelection?.status, 'selected');
  assertTrace(selected);
  const correctionPending = host.submit(corrected);
  const pending = host.snapshot();
  assert.equal(pending.currentSelection, null);
  assert.equal(pending.conversation.currentExplanation, null);
  assert.equal(pending.conversation.turns[1]?.status, 'pending');
  assert.equal(host.selectCitation({ parentTurnId: 1, statementId: 'NUT-S034' }).selections.at(-1)?.status, 'stale-turn');
  assert.equal(host.selectCitation({ parentTurnId: 2, statementId: 'NUT-S034' }).selections.at(-1)?.status, 'answer-unavailable');
  const replacement = await correctionPending;
  assertTrace(replacement);
  assert.deepEqual(replacement.conversation.turns[0], original.conversation.turns[0]);
  assert.equal(replacement.conversation.turns[1]?.supersedesTurnId, 1);
  assert.deepEqual(replacement.conversation.currentExplanation?.context.facts.map(item => item.text), corrected.userContext);
  assertTrace(host.selectCitation({ parentTurnId: 2, statementId: 'NUT-S034' }));
  const staleInput = { ...corrected, previousTurnId: 1 };
  await assert.rejects(host.submit(staleInput), /stale-nutrition-turn/);
  const gapInput: NutritionConversationInput = { ...corrected, choice: 'continue-question', previousTurnId: 2, question: gapQuestion, correction: null };
  const gap = await host.submit(gapInput);
  assertTrace(gap);
  assert.equal(gap.currentSelection, null);
  assert.equal(gap.conversation.currentExplanation?.introduction, 'No matching observations were found for this search in the retained corpus.');
  assert.ok(gap.conversation.turns[2]?.sources?.gaps.some(item => item.code === 'no-traceable-observations'));
  const gapSelection = host.selectCitation({ parentTurnId: 3, statementId: 'NUT-S034' });
  assert.equal(gapSelection.currentSelection, null);
  assert.equal(gapSelection.selections.at(-1)?.status, 'unknown-statement');
  const followupInput: NutritionConversationInput = { ...gapInput, previousTurnId: 3, question: followupQuestion };
  const followup = await host.submit(followupInput);
  assertTrace(followup);
  assert.deepEqual(followup.conversation.turns.map(turn => turn.input), [initial, corrected, gapInput, followupInput]);
  assert.deepEqual(followup.conversation.turns.map(turn => turn.id), [1, 2, 3, 4]);
  assert.deepEqual(followup.conversation.turns[2], gap.conversation.turns[2]);
  const final = host.selectCitation({ parentTurnId: 4, statementId: 'NUT-S034' });
  assertTrace(final);
  assert.deepEqual(final.selections.map(item => item.status), ['selected', 'stale-turn', 'answer-unavailable', 'selected', 'unknown-statement', 'selected']);
  assert.deepEqual(final.conversation.rejectedChoices, [{ input: staleInput, reason: 'stale-nutrition-turn' }]);
  assert.deepEqual(host.snapshot(), final);
  assert.ok(checks() > 0);
});

test('EVAL-FORM-NUT-02: disposal prevents replay and an independently constructed host starts empty', async t => {
  const first = fixture(t);
  await first.host.submit(initial);
  const historical = first.host.selectCitation({ parentTurnId: 1, statementId: 'NUT-S034' });
  const copy = structuredClone(historical);
  first.host.dispose();
  assert.throws(() => first.host.snapshot(), unavailable);
  assert.throws(() => first.host.selectCitation({ parentTurnId: 1, statementId: 'NUT-S034' }), unavailable);
  await assert.rejects(first.host.submit(corrected), unavailable);
  const fresh = fixture(t);
  const empty = fresh.host.snapshot();
  assert.deepEqual(empty.conversation, { turns: [], rejectedChoices: [], currentTurnId: null, currentExplanation: null, automaticAdoption: 'none' });
  assert.equal(empty.currentSelection, null);
  assert.deepEqual(empty.selections, []);
  const restarted = await fresh.host.submit(initial);
  assertTrace(restarted);
  assert.equal(restarted.conversation.turns.length, 1);
  assert.equal(restarted.conversation.currentTurnId, 1);
  assert.deepEqual(restarted.selections, []);
  assert.deepEqual(historical, copy);
  assert.throws(() => first.host.snapshot(), unavailable);
});
