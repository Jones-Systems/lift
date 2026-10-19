import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { composeGroundedAnswer, evaluateGroundedAnswer, type AnswerContext, type CitedStatement, type GroundedAnswer, type GroundedAnswerEvaluation, type LiteratureOption } from '../../grounding/answer.js';
import type { GroundingResult, GroundingRetriever, ObservationEntry, SourceObservation } from '../../grounding/index.js';
import { contextSchema, type ConsumerContext, type ResearchJob } from './grounding.js';

const context = z.strictObject({
  revision: z.string().min(1), supersedesRevision: z.string().min(1).nullable(),
  facts: z.array(z.strictObject({ id: z.string().min(1), text: z.string().min(1), origin: z.literal('user_provided') })),
});
const request = z.strictObject({ jobRevision: z.string().min(1), job: z.unknown(), userContext: context, routing: contextSchema });
const choice = z.strictObject({ optionId: z.string().min(1), intent: z.enum(['explain_citation', 'compare_qualifications']), confirmedByUser: z.literal(true) });

export interface InformativeRequest<Job> {
  readonly jobRevision: string;
  readonly job: Job;
  readonly userContext: AnswerContext;
  readonly routing: ConsumerContext;
}
export interface InformativeResponse<Job> {
  readonly answer: GroundedAnswer;
  readonly evaluation: GroundedAnswerEvaluation;
  readonly uncertainty_or_abstention: readonly string[];
  readonly source_ids: readonly string[];
  readonly allowed_action: 'consider_literature' | 'abstain';
  readonly escalation_route: string;
  readonly confirmation_state: string;
  readonly request: InformativeRequest<Job>;
}
export interface LiteratureSelection<Job> {
  readonly response: InformativeResponse<Job>;
  readonly option: LiteratureOption;
  readonly nextIntent: 'explain_citation' | 'compare_qualifications';
  readonly confirmedByUser: true;
  readonly adoption: 'not_applied';
  readonly automaticAdoption: false;
  readonly evaluation: GroundedAnswerEvaluation;
}

const qualificationFields = ['access_level', 'source_native_certainty', 'form_appraisal', 'applicability', 'rights_status', 'freshness_status', 'clinical_readiness', 'provenance'] as const;
export interface QualificationColumn {
  readonly statementId: string;
  readonly selectedByUser: boolean;
  readonly citation: ObservationEntry;
  readonly qualifications: Pick<SourceObservation, typeof qualificationFields[number]>;
}
export type LiteratureFollowThrough<Job> = {
  readonly selection: LiteratureSelection<Job>;
  readonly source_ids: readonly string[];
  readonly allowed_action: 'consider_literature' | 'abstain';
  readonly answer: GroundedAnswer;
  readonly request: InformativeRequest<Job>;
  readonly evaluation: GroundedAnswerEvaluation;
  readonly adoption: 'not_applied';
  readonly automaticAdoption: false;
  readonly uncertainty_or_abstention: readonly string[];
  readonly escalation_route: string;
  readonly confirmation_state: string;
} & (
  | { readonly kind: 'explain_citation'; readonly explanation: CitedStatement }
  | { readonly kind: 'compare_qualifications'; readonly columns: readonly QualificationColumn[]; readonly comparisonScope: 'returned_observations_only'; readonly ranking: 'none' }
);

export function createInformativeConsumer<Job extends ResearchJob>(retriever: GroundingRetriever, parseJob: (value: unknown) => Job, queryFor: (job: Job) => string, topicFor: (job: Job) => string) {
  let generation = 0;
  let previous: InformativeRequest<Job> | undefined;
  const issued = new WeakMap<object, number>();
  const selections = new WeakMap<object, number>();
  const parse = (input: unknown): InformativeRequest<Job> => {
    const value = request.parse(input);
    return freeze({ ...value, job: parseJob(value.job) });
  };
  const retrievalFor = (job: Job) => ({ query: queryFor(job), topic: topicFor(job), limit: 20 });
  function checkSource(evidence: GroundingResult, routing: ConsumerContext): void {
    if (evidence.source.revision !== routing.sourceRevision || evidence.source.corpusInputSha256 !== routing.corpusInputSha256) throw new Error('stale_evidence_binding');
  }
  function isCurrent(response: InformativeResponse<Job>, current: unknown): boolean {
    try {
      return issued.get(response) === generation && response.evaluation.passed && isDeepStrictEqual(response.request, parse(current));
    } catch { return false; }
  }
  function evaluate(input: unknown): InformativeResponse<Job> {
    const snapshot = parse(input);
    if (previous && !isDeepStrictEqual(previous.userContext, snapshot.userContext)
      && (snapshot.userContext.revision === previous.userContext.revision || snapshot.userContext.supersedesRevision !== previous.userContext.revision)) throw new Error('explicit_context_correction_required');
    if (previous && !isDeepStrictEqual(previous.job, snapshot.job) && snapshot.jobRevision === previous.jobRevision) throw new Error('explicit_job_revision_required');
    const issuedGeneration = ++generation;
    let expectedEvidence: GroundingResult | undefined;
    const answer = composeGroundedAnswer({ retrieve(retrieval) {
      const evidence = retriever.retrieve(retrieval);
      checkSource(evidence, snapshot.routing);
      expectedEvidence = structuredClone(evidence);
      return evidence;
    } }, { retrieval: retrievalFor(snapshot.job), context: snapshot.userContext });
    if (!expectedEvidence || issuedGeneration !== generation) throw new Error('invalidated_during_retrieval');
    const evaluation = evaluateGroundedAnswer(answer, expectedEvidence, snapshot.userContext);
    const response = freeze({
      answer, evaluation, request: snapshot,
      uncertainty_or_abstention: [
        'These are retained research summaries; original passages, scientific validity and individual applicability are not verified.',
        'Job dimensions and user context frame this explanation; they do not establish a matched dose, outcome or personal recommendation.',
        ...(snapshot.routing.regionalPreflight === 'unresolved' ? ['Regional preflight remains unresolved; no training action is permitted.'] : []),
      ],
      source_ids: answer.statements.map(statement => statement.id),
      allowed_action: evaluation.passed && answer.status === 'informative' ? 'consider_literature' as const : 'abstain' as const,
      escalation_route: snapshot.routing.escalation_route, confirmation_state: snapshot.routing.confirmation_state,
    });
    previous = snapshot;
    issued.set(response, issuedGeneration);
    return response;
  }
  function select(response: InformativeResponse<Job>, input: unknown, current: unknown): LiteratureSelection<Job> {
    const selection = choice.parse(input);
    if (!isCurrent(response, current)) throw new Error('stale_or_unissued_response');
    const option = response.answer.options.find(item => item.id === selection.optionId);
    if (!option || response.allowed_action !== 'consider_literature') throw new Error('unavailable_literature_option');
    const selectedGeneration = generation;
    const evidence = retriever.retrieve(retrievalFor(response.request.job));
    checkSource(evidence, response.request.routing);
    const evaluation = evaluateGroundedAnswer(response.answer, evidence, response.request.userContext);
    if (!evaluation.passed || selectedGeneration !== generation) throw new Error('stale_literature_option');
    const result = freeze({ response, option, nextIntent: selection.intent, confirmedByUser: true as const,
      adoption: 'not_applied' as const, automaticAdoption: false as const, evaluation });
    selections.set(result, generation);
    return result;
  }
  function followThrough(selection: LiteratureSelection<Job>, current: unknown): LiteratureFollowThrough<Job> {
    if (selections.get(selection) !== generation || !isCurrent(selection.response, current)) throw new Error('stale_or_unissued_selection');
    const response = selection.response;
    const checkedGeneration = generation;
    const evidence = retriever.retrieve(retrievalFor(response.request.job));
    checkSource(evidence, response.request.routing);
    const evaluation = evaluateGroundedAnswer(response.answer, evidence, response.request.userContext);
    if (!evaluation.passed || checkedGeneration !== generation) throw new Error('stale_literature_selection');
    const shared = {
      selection, answer: response.answer, request: response.request, evaluation,
      source_ids: response.source_ids, allowed_action: response.allowed_action,
      adoption: 'not_applied' as const, automaticAdoption: false as const,
      uncertainty_or_abstention: response.uncertainty_or_abstention,
      escalation_route: response.escalation_route, confirmation_state: response.confirmation_state,
    };
    if (selection.nextIntent === 'explain_citation') {
      const explanation = response.answer.statements.find(statement => statement.id === selection.option.statementId);
      if (!explanation) throw new Error('unavailable_literature_option');
      return freeze({ ...shared, kind: 'explain_citation' as const, explanation });
    }
    const columns = response.answer.statements.map(statement => ({
      statementId: statement.id, selectedByUser: statement.id === selection.option.statementId,
      citation: statement.citation,
      qualifications: Object.fromEntries(qualificationFields.map(field => [field, statement.citation.record[field]])) as QualificationColumn['qualifications'],
    }));
    return freeze({ ...shared, kind: 'compare_qualifications' as const, columns, comparisonScope: 'returned_observations_only' as const, ranking: 'none' as const });
  }
  return {
    evaluate, select, isCurrent, followThrough,
    isSelectionCurrent(selection: LiteratureSelection<Job>, current: unknown): boolean {
      if (selections.get(selection) !== generation || !isCurrent(selection.response, current)) return false;
      try {
        const checkedGeneration = generation;
        const evidence = retriever.retrieve(retrievalFor(selection.response.request.job));
        checkSource(evidence, selection.response.request.routing);
        return evaluateGroundedAnswer(selection.response.answer, evidence, selection.response.request.userContext).passed && checkedGeneration === generation;
      } catch { return false; }
    },
    invalidate(_reason: 'correction' | 'source_change' | 'deletion' | 'consent_withdrawal') { generation++; previous = undefined; },
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
