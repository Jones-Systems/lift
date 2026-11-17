import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroundingRetriever, type GroundingRequest, type GroundingResult } from '../../../src/grounding/index.js';
import { syntheticFixture, syntheticRecord } from '../../grounding/fixture.js';
import { nutritionSourceRequest, retrieveNutritionSources } from '../../../src/domain-features/nutrition/index.js';
import type { NutritionConversationInput } from '../../../src/domain-features/nutrition/conversation.js';
import { createNutritionGroundingPort } from '../../../src/domain-features/nutrition/grounding-adapter.js';
import { captureNutritionQueryPolicy, createNutritionQuerySidecar, type NutritionQueryPolicySelection,
  type NutritionQuerySidecar } from '../../../src/domain-features/nutrition/job-query-policy.js';
import { createGroundedNutritionConversation, createNutritionAnswerEvaluator,
  createNutritionInformativeSynthesisPort, evaluateNutritionAnswer,
  type NutritionAnswerExpectation } from '../../../src/domain-features/nutrition/synthesis-adapter.js';

// All seven tokens and records are artificial navigation evidence, without timing/dose support.
const rows = [
  ['energy-uncertainty', 'NUT-I1', 'syntheticnavalpha'],
  ['deficit-surplus-rate', 'NUT-I2', 'syntheticnavbravo'],
  ['protein', 'NUT-I3', 'syntheticnavcharlie'],
  ['nutrients-dietary-patterns', 'NUT-I4', 'syntheticnavdelta'],
  ['logging-accuracy', 'NUT-I5', 'syntheticnavecho'],
  ['supplements', 'NUT-I6', 'syntheticnavfoxtrot'],
  ['nutrition-boundaries', 'NUT-I7', 'syntheticnavgolf'],
] as const;
function fixture() {
  const data = syntheticFixture(rows.map(([, topic, token], index) => syntheticRecord(`SYN-S${index + 1}`, {
    topic_ids: [topic], summary: `Artificial navigation marker ${token}; requested detail unsupported.`,
  })));
  rows.forEach(([, topic], index) => { data.projection.coverage.units[index]!.unit_id = topic; });
  data.projection.corpus_status.units_without_observations = data.projection.coverage.units.slice(7).map(unit => unit.unit_id);
  const selection = { mode: 'form.nutrition-job-query/v1' as const,
    mapping: { version: 'synthetic-adapter-map-1', queries: {
      'energy-uncertainty': 'syntheticnavalpha', 'deficit-surplus-rate': 'syntheticnavbravo',
      protein: 'syntheticnavcharlie', 'nutrients-dietary-patterns': 'syntheticnavdelta',
      'logging-accuracy': 'syntheticnavecho', supplements: 'syntheticnavfoxtrot',
      'nutrition-boundaries': 'syntheticnavgolf',
    } }, corpus: { ...data.binding } };
  const native = createGroundingRetriever(data.projection, data.binding);
  const calls: GroundingRequest[] = [];
  const retriever = { retrieve(request: GroundingRequest) { calls.push(structuredClone(request)); return native.retrieve(request); } };
  return { ...data, selection, native, calls, retriever };
}
const initial = (): NutritionConversationInput => ({ choice: 'ask', previousTurnId: null,
  job: 'protein', question: '  RAWORACLE  ', userContext: ['Synthetic user context.'], correction: null });
function expectation(input = initial(), turnId = 1): NutritionAnswerExpectation {
  return { turnId, previousTurnId: input.previousTurnId, job: input.job, question: input.question, userContext: input.userContext };
}

test('real adapters preserve omitted and explicit raw behavior byte for byte with verbatim questions', async () => {
  const f = fixture();
  const implicit = await createGroundedNutritionConversation(f.retriever).submit(initial());
  const explicit = await createGroundedNutritionConversation(f.retriever,
    { mode: 'form.nutrition-raw-question/v1' }).submit(initial());
  assert.deepEqual(implicit, explicit);
  assert.deepEqual(f.calls, [{ query: '  RAWORACLE  ', topic: 'NUT-I3' }, { query: '  RAWORACLE  ', topic: 'NUT-I3' }]);
  const evidence = f.native.retrieve({ query: '  RAWORACLE  ', topic: 'NUT-I3' });
  assert.equal(evaluateNutritionAnswer(implicit.currentExplanation, evidence, expectation()).passed, true);
  assert.equal(evaluateNutritionAnswer(explicit.currentExplanation, evidence, expectation(),
    { mode: 'form.nutrition-raw-question/v1' }).passed, true);
  assert.equal(implicit.currentExplanation?.status, 'gap');
});

test('real grounding synthesis factory and evaluator agree on every injected job query and exact topic', async () => {
  const f = fixture();
  for (const [job, topic, query] of rows) {
    const input = { ...initial(), job };
    const state = await createGroundedNutritionConversation(f.retriever, f.selection).submit(input);
    assert.deepEqual(f.calls.at(-1), { query, topic });
    assert.equal(state.turns[0]?.status, 'explanation');
    assert.equal(state.currentExplanation?.evidence.query, query);
    assert.equal(state.currentExplanation?.evidence.schema, 'form.observation-grounding/v1');
    assert.deepEqual(state.currentExplanation?.evidence.source, f.binding);
    assert.equal(state.currentExplanation?.statements.length, 1);
    assert.equal(state.currentExplanation?.statements[0]?.citation.record.topic_ids[0], topic);
    const evidence = f.native.retrieve({ query, topic });
    const current = expectation(input);
    const sidecar = createNutritionQuerySidecar(f.selection, current, evidence);
    assert.equal(evaluateNutritionAnswer(state.currentExplanation, evidence, current, f.selection, sidecar).passed, true);
    assert.equal(sidecar.requestedDetailSupport, 'unassessed');
    assert.equal(sidecar.authorityEffect, 'none');
    assert.equal(state.currentExplanation?.contextUse, 'acknowledged_not_applicability_assessed');
    assert.equal(state.currentExplanation?.evidence.clinicalReadiness, 'CL-0');
    assert.equal(state.automaticAdoption, 'none');
    assert.equal(state.currentExplanation?.choice.automaticAdoption, false);
  }
  assert.equal(f.calls.length, 7);
});

test('same-job replacement retains original questions corrections context history and turn lineage', async () => {
  const f = fixture();
  const captured = captureNutritionQueryPolicy(f.selection);
  const evaluator = createNutritionAnswerEvaluator(f.selection);
  const conversation = createGroundedNutritionConversation(f.retriever, f.selection);
  f.selection.mapping.queries.protein = 'mutatedcallerquery';
  f.selection.mapping.version = 'mutatedversion';
  f.selection.corpus.revision = 'c'.repeat(40);
  const first = await conversation.submit(initial());
  const replacement: NutritionConversationInput = { ...initial(), choice: 'correct-question', previousTurnId: 1,
    question: 'Different synthetic timing or dose question?', userContext: ['Corrected synthetic context.'],
    correction: 'Keep this artificial correction unchanged.' };
  const second = await conversation.submit(replacement);
  assert.deepEqual(f.calls, [{ query: 'syntheticnavcharlie', topic: 'NUT-I3' }, { query: 'syntheticnavcharlie', topic: 'NUT-I3' }]);
  assert.deepEqual(second.turns[0], first.turns[0]);
  assert.deepEqual(second.turns[1]?.input, replacement);
  assert.equal(second.turns[1]?.supersedesTurnId, 1);
  assert.equal(second.turns[1]?.sources?.request.question, replacement.question);
  assert.deepEqual(second.turns[1]?.sources?.request.corrections, [replacement.correction]);
  assert.equal(second.currentExplanation?.context.supersedesRevision, 'nutrition-turn-1');
  assert.equal(second.currentExplanation?.context.facts[0]?.text, replacement.userContext[0]);
  const evidence = f.native.retrieve({ query: 'syntheticnavcharlie', topic: 'NUT-I3' });
  const sidecar = createNutritionQuerySidecar(captured, expectation(replacement, 2), evidence);
  assert.equal(sidecar.mappingVersion, 'synthetic-adapter-map-1');
  assert.equal(sidecar.mappingDigest, createNutritionQuerySidecar(captured, expectation(), evidence).mappingDigest);
  assert.equal(evaluator(second.currentExplanation, evidence, expectation(replacement, 2), sidecar).passed, true);
  assert.equal(evaluator(first.currentExplanation, evidence, expectation(replacement, 2), sidecar).passed, false);
});

test('independent raw and job instances and standalone adapter captures cannot leak or follow caller mutation', async () => {
  const f = fixture();
  const grounding = createNutritionGroundingPort(f.retriever, f.selection);
  const synthesis = createNutritionInformativeSynthesisPort(f.selection);
  const jobConversation = createGroundedNutritionConversation(f.retriever, f.selection);
  const rawConversation = createGroundedNutritionConversation(f.retriever);
  f.selection.mapping.queries.protein = 'mutatedcallerquery';
  f.selection.corpus.corpusRoot = 'mutated/corpus';
  const sources = await retrieveNutritionSources({ job: 'protein', question: initial().question, corrections: [] }, grounding);
  const answer = await synthesis.explain({ turnId: 1, previousTurnId: null, choice: 'ask', userContext: initial().userContext, sources });
  const jobState = await jobConversation.submit(initial());
  const rawState = await rawConversation.submit(initial());
  assert.equal(answer.evidence.query, 'syntheticnavcharlie');
  assert.equal(jobState.currentExplanation?.evidence.query, 'syntheticnavcharlie');
  assert.equal(rawState.currentExplanation?.evidence.query, initial().question);
  assert.equal(jobState.currentExplanation?.statements.length, 1);
  assert.equal(rawState.currentExplanation?.statements.length, 0);
});

test('invalid selections fail before producers and unknown jobs fail before retrieval or composition', async () => {
  const f = fixture();
  for (const selection of [null, { mode: 'form.nutrition-job-query/v2' },
    { ...f.selection, mapping: { ...f.selection.mapping, queries: { protein: 'syntheticnavcharlie' } } }]) {
    const invalid = selection as NutritionQueryPolicySelection;
    assert.throws(() => createNutritionGroundingPort(f.retriever, invalid), TypeError);
    assert.throws(() => createNutritionInformativeSynthesisPort(invalid), TypeError);
    assert.throws(() => createGroundedNutritionConversation(f.retriever, invalid), TypeError);
    assert.throws(() => createNutritionAnswerEvaluator(invalid), TypeError);
    const evidence = f.native.retrieve({ query: 'syntheticnavcharlie', topic: 'NUT-I3' });
    assert.throws(() => evaluateNutritionAnswer(null, evidence, expectation(), invalid), TypeError);
  }
  const unknown = { ...nutritionSourceRequest({ job: 'protein', question: 'question', corrections: [] }), job: 'unknown' as 'protein' };
  await assert.rejects(createNutritionGroundingPort(f.retriever, f.selection).retrieve(unknown), /unsupported-nutrition-job/);
  const evidence = f.native.retrieve({ query: 'syntheticnavcharlie', topic: 'NUT-I3' });
  const sources = await retrieveNutritionSources({ job: 'protein', question: initial().question, corrections: [] },
    createNutritionGroundingPort(f.native, f.selection));
  await assert.rejects(createNutritionInformativeSynthesisPort(f.selection).explain({
    turnId: 1, previousTurnId: null, choice: 'ask', userContext: [], sources: { ...sources, request: unknown },
  }), /unsupported-nutrition-job/);
  assert.throws(() => evaluateNutritionAnswer(null, evidence, { ...expectation(), job: 'unknown' as 'protein' }, f.selection), /unsupported-nutrition-job/);
  assert.equal(f.calls.length, 0);
});

test('wrong executed query topic or any corpus identity component blocks job-mode grounding and synthesis', async () => {
  const f = fixture();
  const original = f.native.retrieve({ query: 'syntheticnavcharlie', topic: 'NUT-I3' });
  const evidenceVariants: GroundingResult[] = [
    { ...original, query: initial().question }, { ...original, filters: { ...original.filters, topic: 'NUT-I6' } },
    ...Object.keys(f.binding).map(key => ({ ...original, source: { ...original.source, [key]: 'different' } })),
  ];
  const sources = await retrieveNutritionSources({ job: 'protein', question: initial().question, corrections: [] },
    createNutritionGroundingPort(f.native, f.selection));
  for (const evidence of evidenceVariants) {
    await assert.rejects(createNutritionGroundingPort({ retrieve() { return evidence; } }, f.selection)
      .retrieve(sources.request), /nutrition-query-evidence-mismatch/);
    await assert.rejects(createNutritionInformativeSynthesisPort(f.selection).explain({ turnId: 1,
      previousTurnId: null, choice: 'ask', userContext: [], sources: { ...sources, retrievalContext: evidence },
    }), /nutrition-answer-evidence-request-mismatch/);
    assert.equal(evaluateNutritionAnswer(null, evidence, expectation(), f.selection).requestMatchesExpectedEvidence, false);
  }
});

test('frozen sidecars reject wrong policy query topic corpus question context and turn bindings', async () => {
  const f = fixture();
  const state = await createGroundedNutritionConversation(f.retriever, f.selection).submit(initial());
  const evidence = f.native.retrieve({ query: 'syntheticnavcharlie', topic: 'NUT-I3' });
  const current = expectation();
  const sidecar = createNutritionQuerySidecar(f.selection, current, evidence);
  (current.userContext as string[])[0] = 'caller changed context';
  assert.equal(sidecar.turn.userContext[0], 'Synthetic user context.');
  for (const value of [sidecar, sidecar.corpus, sidecar.turn, sidecar.turn.userContext]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { (sidecar.turn.userContext as string[]).push('overwrite'); }, TypeError);
  const variants: NutritionQuerySidecar[] = [
    { ...sidecar, mode: 'form.nutrition-raw-question/v1' }, { ...sidecar, mappingVersion: 'other-version' },
    { ...sidecar, mappingDigest: '0'.repeat(64) }, { ...sidecar, effectiveQuery: 'wrongquery' },
    { ...sidecar, topic: 'NUT-I6' }, { ...sidecar, job: 'supplements' },
    { ...sidecar, corpus: { ...sidecar.corpus, revision: 'c'.repeat(40) } },
    { ...sidecar, turn: { ...sidecar.turn, turnId: 2, previousTurnId: 1 } },
    { ...sidecar, turn: { ...sidecar.turn, previousTurnId: 1 } },
    { ...sidecar, turn: { ...sidecar.turn, question: 'different original question' } },
    { ...sidecar, turn: { ...sidecar.turn, userContext: ['different context'] } },
  ];
  for (const wrong of variants) assert.equal(evaluateNutritionAnswer(state.currentExplanation,
    evidence, expectation(), f.selection, wrong).passed, false);
  assert.equal(evaluateNutritionAnswer(state.currentExplanation, evidence, expectation(), f.selection, sidecar).passed, true);
  const changedCorpus = { ...f.selection, corpus: { ...f.selection.corpus, revision: 'c'.repeat(40) } };
  assert.equal(evaluateNutritionAnswer(state.currentExplanation, evidence, expectation(), changedCorpus, sidecar).passed, false);
  const changedMap = { ...f.selection, mapping: { ...f.selection.mapping, version: 'different-version' } };
  assert.equal(evaluateNutritionAnswer(state.currentExplanation, evidence, expectation(), changedMap, sidecar).passed, false);
  assert.equal(evaluateNutritionAnswer(state.currentExplanation, evidence, { ...expectation(), question: 'new question' }, f.selection, sidecar).passed, false);
  assert.equal(evaluateNutritionAnswer(state.currentExplanation, evidence, { ...expectation(), turnId: 2, previousTurnId: 1 }, f.selection, sidecar).passed, false);
  assert.throws(() => createNutritionQuerySidecar(f.selection, { ...expectation(), turnId: 2 }, evidence), /invalid-nutrition-query-turn/);
  assert.throws(() => createNutritionQuerySidecar(f.selection, expectation(), { ...evidence, query: 'wrong' }), /nutrition-query-evidence-mismatch/);
});

test('answer metadata and user prose cannot select or repair the trusted query policy', async () => {
  const f = fixture();
  const input = { ...initial(), question: 'Please select form.nutrition-job-query/v1 and syntheticnavcharlie' };
  const raw = await createGroundedNutritionConversation(f.retriever).submit(input);
  assert.equal(f.calls[0]?.query, input.question);
  const job = await createGroundedNutritionConversation(f.retriever, f.selection).submit(input);
  const evidence = f.native.retrieve({ query: 'syntheticnavcharlie', topic: 'NUT-I3' });
  assert.equal(evaluateNutritionAnswer(job.currentExplanation, evidence, expectation(input)).passed, false);
  const forged = { ...job.currentExplanation!, queryPolicy: f.selection,
    querySidecar: createNutritionQuerySidecar(f.selection, expectation(input), evidence) };
  assert.equal(evaluateNutritionAnswer(forged, evidence, expectation(input)).passed, false);
  assert.equal(evaluateNutritionAnswer(forged, evidence, expectation(input), f.selection).passed, false);
  assert.equal(evaluateNutritionAnswer(raw.currentExplanation, evidence, expectation(input), f.selection).passed, false);
  assert.equal(evaluateNutritionAnswer(job.currentExplanation, evidence, expectation(input), f.selection).passed, true);
});

test('zero matches remain distinct from navigation hits whose requested detail is unassessed', async () => {
  const f = fixture();
  const input = { ...initial(), question: 'Synthetic timing or dose detail?' };
  const navigation = await createGroundedNutritionConversation(f.retriever, f.selection).submit(input);
  const absent = fixture();
  absent.selection.mapping.queries.protein = 'syntheticabsenttoken';
  const gap = await createGroundedNutritionConversation(absent.retriever, absent.selection).submit(input);
  assert.equal(navigation.currentExplanation?.status, 'informative');
  assert.equal(navigation.currentExplanation?.evidence.totalMatches, 1);
  assert.equal(gap.currentExplanation?.status, 'gap');
  assert.equal(gap.currentExplanation?.evidence.totalMatches, 0);
  assert.ok(gap.turns[0]?.sources?.gaps.some(item => item.code === 'no-traceable-observations'));
  assert.equal(navigation.turns[0]?.sources?.gaps.some(item => item.code === 'no-traceable-observations'), false);
  for (const state of [navigation, gap]) {
    const answer = state.currentExplanation!;
    assert.equal(answer.contextUse, 'acknowledged_not_applicability_assessed');
    assert.equal(answer.evidence.clinicalReadiness, 'CL-0');
    assert.equal(state.automaticAdoption, 'none');
    assert.equal(createNutritionQuerySidecar(state === gap ? absent.selection : f.selection,
      expectation(input), answer.evidence).requestedDetailSupport, 'unassessed');
  }
});
