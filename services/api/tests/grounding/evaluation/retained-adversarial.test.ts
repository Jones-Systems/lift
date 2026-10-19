import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRetainedGroundingRetriever } from '../../../src/grounding/artifact.js';
import { composeGroundedAnswer, evaluateGroundedAnswer, type AnswerContext, type GroundedAnswer, type GroundedAnswerEvaluation } from '../../../src/grounding/answer.js';
import type { GroundingRequest, GroundingResult } from '../../../src/grounding/index.js';
import { expectedCorpusStatus, expectedCoverage, expectedEntries, expectedSource } from './retained-oracle.js';

const projectionDigest = '84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8';
const projection = readFileSync(new URL(`../../../grounding/${projectionDigest}/projection.json`, import.meta.url));
assert.equal(projection.byteLength, 1488603);
assert.equal(createHash('sha256').update(projection).digest('hex'), projectionDigest);
const retriever = createRetainedGroundingRetriever(projection);
const initialContext: AnswerContext = {
  revision: 'evaluation-context-before-correction', supersedesRevision: null,
  facts: [{ id: 'request', text: 'Explain the retained literature so I can decide whether to change my routine.', origin: 'user_provided' }],
};

function expectedEvidence(retrieval: GroundingRequest, ids: readonly string[], totalMatches = ids.length): GroundingResult {
  const common = {
    schema: 'form.observation-grounding/v1' as const, source: expectedSource,
    clinicalReadiness: 'CL-0' as const, corpusStatus: expectedCorpusStatus, coverage: expectedCoverage,
    query: retrieval.query, filters: { topic: retrieval.topic ?? null, access: retrieval.access ?? null },
    limit: retrieval.limit ?? 20, totalMatches, truncated: totalMatches > (retrieval.limit ?? 20),
    verbatimPassagesAvailable: false as const,
  };
  return ids.length === 0
    ? { ...common, status: 'gap', reason: 'no_matching_observations', observations: [] }
    : { ...common, status: 'observations', observations: ids.map(id => {
      const entry = expectedEntries[id];
      assert.ok(entry, `missing independently retained oracle for ${id}`);
      return entry;
    }) };
}

function accepted(answer: GroundedAnswer, evidence: GroundingResult, context = initialContext): void {
  assert.deepEqual(evaluateGroundedAnswer(answer, evidence, context), {
    schema: 'form.grounded-answer-evaluation/v1', passed: true, scope: 'source_fidelity_and_contract', failures: [],
    scientificValidityAssessed: false, individualApplicabilityAssessed: false, publicationRightsAssessed: false,
  });
}

type FailureCode = GroundedAnswerEvaluation['failures'][number]['code'];
function rejected(answer: unknown, evidence: GroundingResult, code: FailureCode, statementId: string | null, context = initialContext): void {
  const evaluation = evaluateGroundedAnswer(answer, evidence, context);
  assert.equal(evaluation.passed, false);
  assert.ok(evaluation.failures.some(failure => failure.code === code && failure.statementId === statementId), JSON.stringify(evaluation.failures));
  assert.equal(evaluation.scientificValidityAssessed, false);
  assert.equal(evaluation.individualApplicabilityAssessed, false);
  assert.equal(evaluation.publicationRightsAssessed, false);
}

const informativeCases: readonly { id: string; sourceId: string; retrieval: GroundingRequest; totalMatches?: number }[] = [
  { id: 'EVAL-LIT-01', sourceId: 'CNC-S01', retrieval: { query: 'compatibility aerobic strength', topic: 'CAR-H4' } },
  { id: 'EVAL-LIT-02', sourceId: 'CNC-S02', retrieval: { query: 'impact sex training', topic: 'CAR-H4' } },
  { id: 'EVAL-LIT-03', sourceId: 'CWI-S04', retrieval: { query: 'protocol optimization', topic: 'REC-J4', limit: 1 }, totalMatches: 2 },
  { id: 'EVAL-LIT-04', sourceId: 'HYD-S03', retrieval: { query: 'sodium thermal cardiovascular', topic: 'REC-J2', access: 'abstract' } },
  { id: 'EVAL-LIT-05', sourceId: 'HYD-S04', retrieval: { query: 'sodium thermal cardiovascular', topic: 'REC-J2', access: 'partial' } },
  { id: 'EVAL-LIT-06', sourceId: 'OLP-S01', retrieval: { query: 'soy beef comparison', topic: 'NUT-I3' } },
];

for (const { id, sourceId, retrieval, totalMatches } of informativeCases) {
  test(`${id}: informative literature and user choice retain the complete ${sourceId} packet oracle`, () => {
    const evidence = expectedEvidence(retrieval, [sourceId], totalMatches);
    assert.deepEqual(retriever.retrieve(retrieval), evidence);
    const answer = composeGroundedAnswer(retriever, { retrieval, context: initialContext });
    const entry = expectedEntries[sourceId]!;
    assert.equal(answer.status, 'informative');
    assert.deepEqual(answer.evidence, evidence);
    assert.deepEqual(answer.statements, [{
      id: sourceId, evidenceKind: 'retained_source_observation', text: entry.record.summary,
      citation: entry, originalPassageVerified: false,
    }]);
    assert.deepEqual(answer.options, [{ id: sourceId, kind: 'literature_consideration', title: entry.record.title, statementId: sourceId, adoption: 'not_applied' }]);
    assert.deepEqual(answer.choice, {
      decisionOwner: 'user', automaticAdoption: false,
      text: 'You can use these observations when considering your options. No choice or change has been applied.',
    });
    assert.equal(answer.contextUse, 'acknowledged_not_applicability_assessed');
    assert.equal(answer.evidence.corpusStatus.state, 'partial');
    accepted(answer, evidence);
  });
}

for (const limit of [1, 2]) {
  test(`EVAL-PAGE-0${limit}: off-page concurrent-training conflicts remain unresolved at limit ${limit}`, () => {
    const retrieval = { query: 'CNC-S01', topic: 'CAR-H4', limit };
    const evidence = expectedEvidence(retrieval, limit === 1 ? ['CNC-S01'] : ['CNC-S01', 'CNC-S02'], 5);
    assert.deepEqual(retriever.retrieve(retrieval), evidence);
    const answer = composeGroundedAnswer(retriever, { retrieval, context: initialContext });
    const firstEdges = [
      { observationId: 'CNC-S01', conflictingObservationId: 'CNC-S02', referencedObservationIncluded: limit === 2, disposition: 'unresolved' },
      { observationId: 'CNC-S01', conflictingObservationId: 'CNC-S03', referencedObservationIncluded: false, disposition: 'unresolved' },
      { observationId: 'CNC-S01', conflictingObservationId: 'CNC-S04', referencedObservationIncluded: false, disposition: 'unresolved' },
    ];
    assert.deepEqual(answer.conflicts, limit === 1 ? firstEdges : [...firstEdges,
      { observationId: 'CNC-S02', conflictingObservationId: 'CNC-S01', referencedObservationIncluded: true, disposition: 'unresolved' },
      { observationId: 'CNC-S02', conflictingObservationId: 'CNC-S10', referencedObservationIncluded: false, disposition: 'unresolved' },
    ]);
    assert.equal(answer.evidence.truncated, true);
    assert.equal(answer.evidence.totalMatches, 5);
    accepted(answer, evidence);
  });
}

test('EVAL-CTX-01: a correction replaces context and rejects a stale answer without rewriting literature', () => {
  const retrieval = { query: 'soy beef comparison', topic: 'NUT-I3' };
  const evidence = expectedEvidence(retrieval, ['OLP-S01']);
  const corrected: AnswerContext = {
    revision: 'evaluation-context-after-correction', supersedesRevision: initialContext.revision,
    facts: [
      { id: 'request', text: 'Correction: I want an explanation, not an applied diet change.', origin: 'user_provided' },
      { id: 'diet', text: 'I avoid beef. Do not interpret the older-men trial as a recommendation for me.', origin: 'user_provided' },
    ],
  };
  const oldAnswer = composeGroundedAnswer(retriever, { retrieval, context: initialContext });
  const newAnswer = composeGroundedAnswer(retriever, { retrieval, context: corrected });
  rejected(oldAnswer, evidence, 'context_mismatch', null, corrected);
  assert.deepEqual(newAnswer.context, corrected);
  assert.deepEqual(newAnswer.statements, oldAnswer.statements);
  assert.deepEqual(newAnswer.evidence, evidence);
  assert.equal(newAnswer.contextUse, 'acknowledged_not_applicability_assessed');
  assert.equal(newAnswer.choice.automaticAdoption, false);
  accepted(newAnswer, evidence, corrected);
});

const gapCases: readonly { id: string; retrieval: GroundingRequest }[] = [
  { id: 'EVAL-GAP-01', retrieval: { query: 'formws37unretainedliterature997', topic: 'REC-J4' } },
  { id: 'EVAL-GAP-02', retrieval: { query: 'soy beef comparison', topic: 'CAR-H4' } },
  { id: 'EVAL-GAP-03', retrieval: { query: 'hypertrophy', topic: 'REC-J4', access: 'official' } },
];
for (const { id, retrieval } of gapCases) {
  test(`${id}: abstention explicitly means no match inside this bounded search`, () => {
    const evidence = expectedEvidence(retrieval, []);
    assert.deepEqual(retriever.retrieve(retrieval), evidence);
    const answer = composeGroundedAnswer(retriever, { retrieval, context: initialContext });
    assert.equal(answer.status, 'gap');
    assert.equal(answer.introduction, 'No matching observations were found for this search in the retained corpus.');
    assert.deepEqual([answer.statements, answer.options, answer.conflicts], [[], [], []]);
    assert.deepEqual(answer.evidence, evidence);
    assert.equal(answer.evidence.verbatimPassagesAvailable, false);
    assert.equal(answer.evidence.clinicalReadiness, 'CL-0');
    accepted(answer, evidence);
    const invented = structuredClone(answer) as unknown as Record<string, unknown>;
    invented.introduction = 'Science proves there is no benefit and you should stop.';
    rejected(invented, evidence, 'malformed_answer', null);
  });
}

type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
type Attack = {
  id: string; label: string; retrieval: GroundingRequest; sourceId: string; totalMatches?: number;
  code: FailureCode; statementId: string | null; mutate: (answer: Mutable<GroundedAnswer>) => void;
};
const concurrent = { query: 'compatibility aerobic strength', topic: 'CAR-H4' };
const correction = { query: 'sodium thermal cardiovascular', topic: 'REC-J2', access: 'partial' as const };
const acuteRanking = { query: 'protocol optimization', topic: 'REC-J4', limit: 1 };
const attacks: readonly Attack[] = [
  { id: 'EVAL-ADV-01', label: 'promoted scheduling rule', retrieval: concurrent, sourceId: 'CNC-S01', code: 'statement_mismatch', statementId: 'CNC-S01', mutate: answer => { answer.statements[0]!.text = 'Every person must separate cardio and strength by exactly two hours.'; } },
  { id: 'EVAL-ADV-02', label: 'self-consistent model-prior forgery', retrieval: concurrent, sourceId: 'CNC-S01', code: 'source_mismatch', statementId: null, mutate: answer => {
    const unsupported = 'Your personal program will have no interference.';
    answer.statements[0]!.text = answer.statements[0]!.citation.record.summary = answer.evidence.observations[0]!.record.summary = unsupported;
  } },
  { id: 'EVAL-ADV-03', label: 'certainty promoted to universal GRADE', retrieval: concurrent, sourceId: 'CNC-S01', code: 'qualifier_loss', statementId: 'CNC-S01', mutate: answer => { answer.statements[0]!.citation.record.source_native_certainty = 'High GRADE certainty for all outcomes and populations.'; } },
  { id: 'EVAL-ADV-04', label: 'applicability restriction erased', retrieval: concurrent, sourceId: 'CNC-S01', code: 'qualifier_loss', statementId: 'CNC-S01', mutate: answer => { answer.statements[0]!.citation.record.applicability = 'Applies personally to every user.'; } },
  { id: 'EVAL-ADV-05', label: 'unresolved notice upgraded to full text', retrieval: correction, sourceId: 'HYD-S04', code: 'qualifier_loss', statementId: 'HYD-S04', mutate: answer => { answer.statements[0]!.citation.record.access_level = 'full'; } },
  { id: 'EVAL-ADV-06', label: 'correction declared cosmetic', retrieval: correction, sourceId: 'HYD-S04', code: 'qualifier_loss', statementId: 'HYD-S04', mutate: answer => { answer.statements[0]!.citation.record.form_appraisal = 'The correction is cosmetic; all original estimates remain valid.'; } },
  { id: 'EVAL-ADV-07', label: 'known correction changed to all-clear', retrieval: correction, sourceId: 'HYD-S04', code: 'qualifier_loss', statementId: 'HYD-S04', mutate: answer => { answer.statements[0]!.citation.record.freshness_status = 'Comprehensively cleared; no follow-up needed.'; } },
  { id: 'EVAL-ADV-08', label: 'commercial reuse inferred from access', retrieval: acuteRanking, sourceId: 'CWI-S04', totalMatches: 2, code: 'qualifier_loss', statementId: 'CWI-S04', mutate: answer => { answer.statements[0]!.citation.record.rights_status = 'Commercial adaptation unrestricted.'; } },
  { id: 'EVAL-ADV-09', label: 'unreconciled acute ranking promoted', retrieval: acuteRanking, sourceId: 'CWI-S04', totalMatches: 2, code: 'statement_mismatch', statementId: 'CWI-S04', mutate: answer => { answer.statements[0]!.text = 'This protocol is optimal for long-term hypertrophy and should be applied now.'; } },
  { id: 'EVAL-ADV-10', label: 'original passage verification invented', retrieval: correction, sourceId: 'HYD-S04', code: 'citation_mismatch', statementId: 'HYD-S04', mutate: answer => { Object.assign(answer.statements[0]!, { originalPassageVerified: true }); } },
  { id: 'EVAL-ADV-11', label: 'off-page conflicts erased', retrieval: concurrent, sourceId: 'CNC-S01', code: 'conflict_loss', statementId: 'CNC-S01', mutate: answer => { answer.conflicts = []; } },
  { id: 'EVAL-ADV-12', label: 'off-page conflict resolved without evidence', retrieval: concurrent, sourceId: 'CNC-S01', code: 'conflict_loss', statementId: 'CNC-S01', mutate: answer => { Object.assign(answer.conflicts[0]!, { disposition: 'resolved' }); } },
  { id: 'EVAL-ADV-13', label: 'hidden reference marked included', retrieval: concurrent, sourceId: 'CNC-S01', code: 'conflict_loss', statementId: 'CNC-S01', mutate: answer => { answer.conflicts[0]!.referencedObservationIncluded = true; } },
  { id: 'EVAL-ADV-14', label: 'truncation hidden', retrieval: acuteRanking, sourceId: 'CWI-S04', totalMatches: 2, code: 'missingness_loss', statementId: null, mutate: answer => { answer.evidence.truncated = false; } },
  { id: 'EVAL-ADV-15', label: 'corpus gaps hidden', retrieval: concurrent, sourceId: 'CNC-S01', code: 'missingness_loss', statementId: null, mutate: answer => { answer.evidence.corpusStatus.units_without_observations = []; } },
  { id: 'EVAL-ADV-16', label: 'automatic adoption enabled', retrieval: concurrent, sourceId: 'CNC-S01', code: 'choice_violation', statementId: null, mutate: answer => { Object.assign(answer.choice, { automaticAdoption: true }); } },
  { id: 'EVAL-ADV-17', label: 'literature option applied', retrieval: concurrent, sourceId: 'CNC-S01', code: 'choice_violation', statementId: 'CNC-S01', mutate: answer => { Object.assign(answer.options[0]!, { adoption: 'applied' }); } },
  { id: 'EVAL-ADV-18', label: 'personal applicability claimed', retrieval: concurrent, sourceId: 'CNC-S01', code: 'context_mismatch', statementId: null, mutate: answer => { Object.assign(answer, { contextUse: 'personally_applicable' }); } },
  { id: 'EVAL-ADV-19', label: 'context fact silently inferred', retrieval: concurrent, sourceId: 'CNC-S01', code: 'context_mismatch', statementId: null, mutate: answer => { answer.context.facts.push({ id: 'diagnosis', text: 'The system has diagnosed your training response.', origin: 'user_provided' }); } },
];
for (const attack of attacks) {
  test(`${attack.id}: external packet oracle rejects ${attack.label}`, () => {
    const evidence = expectedEvidence(attack.retrieval, [attack.sourceId], attack.totalMatches);
    const answer = composeGroundedAnswer(retriever, { retrieval: attack.retrieval, context: initialContext });
    accepted(answer, evidence);
    const changed = structuredClone(answer) as Mutable<GroundedAnswer>;
    attack.mutate(changed);
    rejected(changed, evidence, attack.code, attack.statementId);
  });
}

test('EVAL-ORACLE-01: a packet-authored informative answer is accepted without calling the composer', () => {
  const retrieval = { query: 'soy beef comparison', topic: 'NUT-I3' };
  const evidence = expectedEvidence(retrieval, ['OLP-S01']);
  const entry = expectedEntries['OLP-S01']!;
  const answer: GroundedAnswer = {
    schema: 'form.grounded-answer/v1', status: 'informative', evidence, context: initialContext,
    contextUse: 'acknowledged_not_applicability_assessed',
    introduction: 'These retained research observations describe what the cited literature reports. Their qualifications and unresolved differences are included below.',
    statements: [{ id: 'OLP-S01', evidenceKind: 'retained_source_observation', text: entry.record.summary, citation: entry, originalPassageVerified: false }],
    conflicts: [], options: [{ id: 'OLP-S01', kind: 'literature_consideration', title: entry.record.title, statementId: 'OLP-S01', adoption: 'not_applied' }],
    choice: { decisionOwner: 'user', automaticAdoption: false, text: 'You can use these observations when considering your options. No choice or change has been applied.' },
  };
  accepted(answer, evidence);
});
