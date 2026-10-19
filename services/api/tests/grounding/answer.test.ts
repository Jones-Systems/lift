import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeGroundedAnswer, evaluateGroundedAnswer, type AnswerContext, type GroundedAnswer, type GroundedAnswerRequest, type GroundedAnswerEvaluation } from '../../src/grounding/answer.js';
import { createGroundingRetriever, GroundingInputError, type GroundingRequest } from '../../src/grounding/index.js';
import { createRetainedGroundingRetriever } from '../../src/grounding/artifact.js';
import { syntheticFixture, syntheticRecord } from './fixture.js';

const context = (): AnswerContext => ({ revision: 'synthetic-context-1', facts: [{ id: 'goal', text: 'Synthetic user asks to understand the literature.', origin: 'user_provided' }], supersedesRevision: null });
const synthetic = () => {
  const { projection, binding } = syntheticFixture([
    syntheticRecord('SYN-S1', { conflicts: ['SYN-S2'] }), syntheticRecord('SYN-S2'),
  ]);
  return createGroundingRetriever(projection, binding);
};
const retained = () => createRetainedGroundingRetriever(readFileSync(new URL('../../grounding/84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8/projection.json', import.meta.url)));
function failure(result: GroundedAnswerEvaluation, code: GroundedAnswerEvaluation['failures'][number]['code']): void {
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(item => item.code === code), JSON.stringify(result.failures));
  assert.equal(result.scientificValidityAssessed, false);
  assert.equal(result.individualApplicabilityAssessed, false);
  assert.equal(result.publicationRightsAssessed, false);
}

test('explains retained DOS-S02 and DOS-S01 with exact full summaries, limits and literature options', () => {
  const retriever = retained();
  for (const id of ['DOS-S02', 'DOS-S01']) {
    const retrieval = { query: id, limit: 100 };
    const evidence = retriever.retrieve(retrieval);
    const snapshot = context();
    const answer = composeGroundedAnswer(retriever, { retrieval, context: snapshot });
    const expected = evidence.observations.find(entry => entry.record.id === id)!;
    assert.ok(expected);
    const statement = answer.statements.find(item => item.id === id)!;
    assert.equal(answer.status, 'informative');
    assert.equal(statement.text, expected.record.summary);
    assert.deepEqual(statement.citation, expected);
    assert.equal(statement.evidenceKind, 'retained_source_observation');
    assert.equal(statement.originalPassageVerified, false);
    assert.deepEqual(answer.options.find(item => item.id === id), { id, kind: 'literature_consideration', title: expected.record.title, statementId: id, adoption: 'not_applied' });
    if (id === 'DOS-S02') {
      for (const qualification of ['14 trained men/women', 'within-person legs,9weeks2/week', 'not broad equivalence']) assert.ok(statement.text.includes(qualification));
    } else {
      assert.ok(statement.text.includes('search ends October2024 despite2026 publication'));
      assert.ok(statement.text.includes('CC BY-NC-ND4: no adapted/commercial tables'));
      assert.equal(statement.citation.record.form_appraisal, 'provisional researcher appraisal; not formal GRADE');
      assert.equal(statement.citation.record.rights_status, 'metadata and original paraphrase only; fulltext/tables/media not retained or cleared');
    }
    assert.equal(evaluateGroundedAnswer(answer, evidence, snapshot).passed, true);
  }
});

test('explains unresolved nutrition erratum and bounded hydration evidence without inventing a correction or personal quota', () => {
  const retriever = retained();
  for (const id of ['NUT-S017', 'HYD-S01']) {
    const retrieval = { query: id, limit: 100 };
    const evidence = retriever.retrieve(retrieval);
    const answer = composeGroundedAnswer(retriever, { retrieval, context: context() });
    const statement = answer.statements.find(item => item.id === id)!;
    assert.ok(statement);
    assert.deepEqual(statement.citation, evidence.observations.find(entry => entry.record.id === id));
    if (id === 'NUT-S017') {
      assert.equal(statement.text, 'Erratum exists for NUT-S015; substantive text was not obtained.');
      assert.ok(statement.citation.record.form_appraisal.includes('no inference that recommendations are unchanged'));
      assert.equal(statement.citation.record.access_level, 'unknown');
    } else {
      assert.ok(statement.text.includes('adequate hydration cannot prevent heat accumulation under every combination of workload, temperature, humidity and clothing'));
      assert.ok(statement.citation.record.applicability.includes('no ordinary indoor resistance-session quota or personal heat-illness management'));
    }
    assert.deepEqual(answer.choice, { decisionOwner: 'user', automaticAdoption: false, text: 'You can use these observations when considering your options. No choice or change has been applied.' });
    assert.equal(evaluateGroundedAnswer(answer, evidence, context()).passed, true);
  }
});

test('real off-page BON conflict stays unresolved and included references are marked only when returned', () => {
  const retriever = retained();
  const retrieval = { query: 'BON', topic: 'HLT-Y1', limit: 1 };
  const evidence = retriever.retrieve(retrieval);
  const answer = composeGroundedAnswer(retriever, { retrieval, context: context() });
  assert.equal(answer.statements[0]?.id, 'BON-S01');
  assert.deepEqual(answer.conflicts, [{ observationId: 'BON-S01', conflictingObservationId: 'BON-S02', referencedObservationIncluded: false, disposition: 'unresolved' }]);
  assert.equal(answer.evidence.truncated, true);
  assert.equal(evaluateGroundedAnswer(answer, evidence, context()).passed, true);
  const complete = composeGroundedAnswer(retriever, { retrieval: { ...retrieval, limit: 100 }, context: context() });
  assert.equal(complete.conflicts.find(edge => edge.observationId === 'BON-S01')?.referencedObservationIncluded, true);
});

test('synthetic gap and truncated answers keep distinct full evidence and status templates', () => {
  const retriever = synthetic();
  for (const retrieval of [{ query: 'absentuniquesyntheticword' }, { query: 'strength', limit: 1 }]) {
    const evidence = retriever.retrieve(retrieval);
    const answer = composeGroundedAnswer(retriever, { retrieval, context: context() });
    assert.deepEqual(answer.evidence, evidence);
    assert.equal(answer.evidence.clinicalReadiness, 'CL-0');
    assert.equal(answer.evidence.verbatimPassagesAvailable, false);
    assert.equal(answer.evidence.corpusStatus.limitation, 'Research observations only; no claim promotion, clinical validation, answer generation, catalog or cue ingestion.');
    if (evidence.status === 'gap') {
      assert.equal(answer.status, 'gap');
      assert.equal(answer.introduction, 'No matching observations were found for this search in the retained corpus.');
      assert.deepEqual([answer.statements, answer.options, answer.conflicts], [[], [], []]);
    } else {
      assert.equal(answer.status, 'informative');
      assert.equal(answer.introduction, 'These retained research observations describe what the cited literature reports. Their qualifications and unresolved differences are included below.');
      assert.equal(answer.statements.length, 1);
      assert.equal(answer.evidence.totalMatches, 2);
      assert.equal(answer.evidence.truncated, true);
    }
    assert.equal(evaluateGroundedAnswer(answer, evidence, context()).passed, true);
  }
});

test('context corrections replace the explicit snapshot and never implicitly rewrite retrieval', () => {
  const retriever = synthetic();
  const calls: GroundingRequest[] = [];
  const spy = { retrieve(request: GroundingRequest) { calls.push(structuredClone(request)); return retriever.retrieve(request); } };
  const retrieval = { query: 'strength', limit: 1 };
  const original = context();
  const corrected: AnswerContext = { revision: 'synthetic-context-2', facts: [{ id: 'goal', text: 'Synthetic corrected user fact.', origin: 'user_provided' }], supersedesRevision: original.revision };
  const oldAnswer = composeGroundedAnswer(spy, { retrieval, context: original });
  const newAnswer = composeGroundedAnswer(spy, { retrieval, context: corrected });
  assert.deepEqual(calls, [retrieval, retrieval]);
  assert.deepEqual(newAnswer.context, corrected);
  assert.deepEqual(newAnswer.evidence, oldAnswer.evidence);
  assert.equal(newAnswer.contextUse, 'acknowledged_not_applicability_assessed');
  failure(evaluateGroundedAnswer(oldAnswer, retriever.retrieve(retrieval), corrected), 'context_mismatch');
  assert.equal(evaluateGroundedAnswer(newAnswer, retriever.retrieve(retrieval), corrected).passed, true);
});

test('invalid context and request fields reject before invoking retrieval', () => {
  let calls = 0;
  const retriever = { retrieve() { calls++; throw new Error('must not retrieve'); } };
  const invalid: unknown[] = [null, {}, { ...context(), revision: ' ' }, { ...context(), extra: true },
    { ...context(), supersedesRevision: context().revision }, { ...context(), supersedesRevision: '' },
    { ...context(), facts: [{ id: '', text: 'x', origin: 'user_provided' }] },
    { ...context(), facts: [{ id: 'x', text: '', origin: 'user_provided' }] },
    { ...context(), facts: [{ id: 'x', text: 'x', origin: 'inferred' }] },
    { ...context(), facts: [context().facts[0], context().facts[0]] },
    { ...context(), facts: [{ ...context().facts[0], extra: 'unsupported' }] },
  ];
  for (const value of invalid) {
    assert.throws(() => composeGroundedAnswer(retriever, { retrieval: { query: 'strength' }, context: value as AnswerContext }), error => error instanceof GroundingInputError && error.code === 'invalid_request');
  }
  assert.throws(() => composeGroundedAnswer(retriever, { retrieval: { query: 'strength' }, context: context(), extra: true } as GroundedAnswerRequest), GroundingInputError);
  assert.equal(calls, 0);
});

test('answers own immutable context/evidence snapshots and preserve plain text as content', () => {
  const retriever = synthetic();
  const mutableContext = structuredClone(context()) as { revision: string; facts: { id: string; text: string; origin: 'user_provided' }[]; supersedesRevision: string | null };
  mutableContext.facts[0]!.text = '<script>synthetic content, never execute</script>';
  const evidence = structuredClone(retriever.retrieve({ query: 'strength' }));
  const answer = composeGroundedAnswer({ retrieve: () => evidence }, { retrieval: { query: 'strength' }, context: mutableContext });
  mutableContext.facts[0]!.text = 'changed';
  (evidence.observations[0]!.record as { summary: string }).summary = 'changed';
  assert.equal(answer.context.facts[0]?.text, '<script>synthetic content, never execute</script>');
  assert.notEqual(answer.statements[0]?.text, 'changed');
  for (const value of [answer, answer.context, answer.context.facts, answer.context.facts[0], answer.evidence, answer.evidence.coverage.units, answer.statements, answer.statements[0], answer.statements[0]?.citation.record, answer.options, answer.options[0], answer.conflicts, answer.conflicts[0], answer.choice]) assert.ok(Object.isFrozen(value));
  assert.throws(() => (answer.statements as unknown[]).pop(), TypeError);
});

test('evaluation uses external evidence to reject adulterated summaries, qualifiers, citations, priors, conflicts and adoption', () => {
  const retriever = synthetic();
  const retrieval = { query: 'strength', limit: 1 };
  const evidence = retriever.retrieve(retrieval);
  const answer = composeGroundedAnswer(retriever, { retrieval, context: context() });
  const cases: [GroundedAnswerEvaluation['failures'][number]['code'], (value: any) => void][] = [
    ['statement_mismatch', value => { value.statements[0].text = 'Unsupported stronger conclusion'; }],
    ['qualifier_loss', value => { delete value.statements[0].citation.record.rights_status; }],
    ['citation_mismatch', value => { value.statements[0].citation.record.url = 'https://example.invalid/forged'; }],
    ['statement_mismatch', value => { value.statements.push({ ...value.statements[0], id: 'MODEL-PRIOR', text: 'Uncited model prior' }); }],
    ['conflict_loss', value => { value.conflicts = []; }],
    ['conflict_loss', value => { value.conflicts[0].disposition = 'resolved'; }],
    ['conflict_loss', value => { value.conflicts[0].referencedObservationIncluded = true; }],
    ['citation_mismatch', value => { value.statements[0].originalPassageVerified = true; }],
    ['choice_violation', value => { value.choice.automaticAdoption = true; }],
    ['choice_violation', value => { value.options[0].adoption = 'applied'; }],
    ['choice_violation', value => { value.options[0].title = 'Mandatory rule'; }],
    ['choice_violation', value => { value.choice.text = 'You must follow this rule.'; }],
    ['missingness_loss', value => { value.evidence.truncated = false; }],
    ['missingness_loss', value => { value.evidence.coverage.units.pop(); }],
    ['missingness_loss', value => { value.evidence.corpusStatus.units_without_observations = []; }],
    ['missingness_loss', value => { value.evidence.verbatimPassagesAvailable = true; }],
    ['source_mismatch', value => { value.evidence.source.revision = '0'.repeat(40); }],
    ['source_mismatch', value => { value.evidence.query = 'rewritten'; }],
    ['source_mismatch', value => { value.evidence.filters.access = 'full'; }],
    ['source_mismatch', value => { value.evidence.observations[0].record.summary = value.statements[0].text = value.statements[0].citation.record.summary = 'Self-consistent forged summary'; }],
    ['malformed_answer', value => { value.inferredPersonalApplicability = true; }],
    ['statement_mismatch', value => { value.statements[0].extra = 'unapproved'; }],
    ['context_mismatch', value => { value.contextUse = 'personalized'; }],
  ];
  for (const [code, mutate] of cases) {
    const changed = structuredClone(answer);
    mutate(changed);
    failure(evaluateGroundedAnswer(changed, evidence, context()), code);
  }
});

test('evaluation rejects missing/reordered membership, unknown nested fields and malformed data', () => {
  const retriever = synthetic();
  const evidence = retriever.retrieve({ query: 'strength' });
  const answer = composeGroundedAnswer(retriever, { retrieval: { query: 'strength' }, context: context() });
  const reversed = structuredClone(answer);
  (reversed.statements as unknown[]).reverse();
  failure(evaluateGroundedAnswer(reversed, evidence, context()), 'statement_mismatch');
  const removed = structuredClone(answer);
  (removed.evidence.observations as unknown[]).pop();
  failure(evaluateGroundedAnswer(removed, evidence, context()), 'source_mismatch');
  const changed = structuredClone(answer);
  Object.assign(changed.statements[0]!.citation.record, { extra: 'model-prior' });
  failure(evaluateGroundedAnswer(changed, evidence, context()), 'citation_mismatch');
  let invoked = false;
  const accessor = { get schema() { invoked = true; return 'form.grounded-answer/v1'; } };
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of [null, undefined, {}, [], new Date(), accessor, cyclic]) failure(evaluateGroundedAnswer(value, evidence, context()), 'malformed_answer');
  assert.equal(invoked, false);
});

test('independently assembled answer passes fidelity only, with all assessment exclusions explicit', () => {
  const { projection, binding } = syntheticFixture([syntheticRecord('SYN-S1')]);
  const evidence = createGroundingRetriever(projection, binding).retrieve({ query: 'strength' });
  const entry = evidence.observations[0]!;
  const answer: GroundedAnswer = {
    schema: 'form.grounded-answer/v1', status: 'informative', evidence, context: context(), contextUse: 'acknowledged_not_applicability_assessed',
    introduction: 'These retained research observations describe what the cited literature reports. Their qualifications and unresolved differences are included below.',
    statements: [{ id: 'SYN-S1', evidenceKind: 'retained_source_observation', text: entry.record.summary, citation: entry, originalPassageVerified: false }],
    conflicts: [], options: [{ id: 'SYN-S1', kind: 'literature_consideration', title: entry.record.title, statementId: 'SYN-S1', adoption: 'not_applied' }],
    choice: { decisionOwner: 'user', automaticAdoption: false, text: 'You can use these observations when considering your options. No choice or change has been applied.' },
  };
  const result = evaluateGroundedAnswer(answer, evidence, context());
  assert.deepEqual(result, { schema: 'form.grounded-answer-evaluation/v1', passed: true, scope: 'source_fidelity_and_contract', failures: [], scientificValidityAssessed: false, individualApplicabilityAssessed: false, publicationRightsAssessed: false });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.failures));
});
