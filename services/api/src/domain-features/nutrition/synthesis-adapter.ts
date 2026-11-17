import { isDeepStrictEqual } from 'node:util';
import { composeGroundedAnswer, evaluateGroundedAnswer, type AnswerContext,
  type GroundedAnswer, type GroundedAnswerEvaluation } from '../../grounding/answer.js';
import type { GroundingResult, GroundingRetriever } from '../../grounding/index.js';
import { createNutritionConversation, type NutritionInformativeSynthesisPort } from './conversation.js';
import { createNutritionGroundingPort } from './grounding-adapter.js';
import { nutritionJobTopics, type NutritionJob } from './index.js';
import { captureNutritionQueryPolicy, createNutritionQuerySidecar, nutritionQueryMatchesEvidence,
  type NutritionQueryPolicySelection, type NutritionQuerySidecar } from './job-query-policy.js';

export interface NutritionAnswerExpectation {
  readonly turnId: number;
  readonly previousTurnId: number | null;
  readonly job: NutritionJob;
  readonly question: string;
  readonly userContext: readonly string[];
}

export function nutritionAnswerContext(
  turnId: number, previousTurnId: number | null, userContext: readonly string[],
): AnswerContext {
  if (!Number.isSafeInteger(turnId) || turnId < 1
    || previousTurnId !== (turnId === 1 ? null : turnId - 1)) {
    throw new TypeError('invalid-nutrition-answer-lineage');
  }
  if (userContext.some(text => typeof text !== 'string' || !text.trim())) {
    throw new TypeError('invalid-nutrition-answer-context');
  }
  return {
    revision: `nutrition-turn-${turnId}`,
    supersedesRevision: previousTurnId === null ? null : `nutrition-turn-${previousTurnId}`,
    facts: userContext.map((text, index) => ({
      id: `nutrition-turn-${turnId}-fact-${index + 1}`, text, origin: 'user_provided',
    })),
  };
}

function evidenceMatchesRequest(evidence: GroundingResult, expected: Pick<NutritionAnswerExpectation, 'job' | 'question'>,
  selection?: NutritionQueryPolicySelection): boolean {
  return nutritionQueryMatchesEvidence(selection, expected.job, expected.question, evidence);
}

export function createNutritionInformativeSynthesisPort(
  selection?: NutritionQueryPolicySelection,
): NutritionInformativeSynthesisPort<GroundedAnswer> {
  const policy = captureNutritionQueryPolicy(selection);
  return {
    async explain(input) {
      const evidence = input.sources.retrievalContext;
      if (evidence === null || !evidenceMatchesRequest(evidence, input.sources.request, policy)) {
        throw new TypeError('nutrition-answer-evidence-request-mismatch');
      }
      const snapshot = structuredClone(evidence);
      const retrieval = { query: snapshot.query, topic: nutritionJobTopics[input.sources.request.job],
        limit: snapshot.limit, ...(snapshot.filters.access === null ? {} : { access: snapshot.filters.access }) };
      const boundRetriever: GroundingRetriever = {
        retrieve(request) {
          if (!isDeepStrictEqual(request, retrieval)) throw new TypeError('nutrition-answer-retrieval-mismatch');
          return snapshot;
        },
      };
      return composeGroundedAnswer(boundRetriever, { retrieval,
        context: nutritionAnswerContext(input.turnId, input.previousTurnId, input.userContext) });
    },
  };
}

export interface NutritionAnswerEvaluation {
  readonly passed: boolean;
  readonly requestMatchesExpectedEvidence: boolean;
  readonly fidelity: GroundedAnswerEvaluation;
}

// Both expectations come from trusted current consumer state, never from the candidate answer.
export function evaluateNutritionAnswer(answer: unknown, expectedEvidence: GroundingResult,
  current: NutritionAnswerExpectation, selection?: NutritionQueryPolicySelection,
  sidecar?: NutritionQuerySidecar): NutritionAnswerEvaluation {
  const policy = captureNutritionQueryPolicy(selection);
  const evidenceMatches = evidenceMatchesRequest(expectedEvidence, current, policy);
  const context = nutritionAnswerContext(current.turnId, current.previousTurnId, current.userContext);
  const fidelity = evaluateGroundedAnswer(answer, expectedEvidence, context);
  const requestMatchesExpectedEvidence = evidenceMatches && (sidecar === undefined
    || isDeepStrictEqual(sidecar, createNutritionQuerySidecar(policy, current, expectedEvidence)));
  return { passed: requestMatchesExpectedEvidence && fidelity.passed, requestMatchesExpectedEvidence, fidelity };
}

// Capture once for a trusted consumer that evaluates multiple turns with the same injection.
export function createNutritionAnswerEvaluator(selection?: NutritionQueryPolicySelection) {
  const policy = captureNutritionQueryPolicy(selection);
  return (answer: unknown, expectedEvidence: GroundingResult, current: NutritionAnswerExpectation,
    sidecar?: NutritionQuerySidecar): NutritionAnswerEvaluation =>
    evaluateNutritionAnswer(answer, expectedEvidence, current, policy, sidecar);
}

export function createGroundedNutritionConversation(retriever: GroundingRetriever,
  selection?: NutritionQueryPolicySelection) {
  const policy = captureNutritionQueryPolicy(selection);
  return createNutritionConversation({ grounding: createNutritionGroundingPort(retriever, policy),
    synthesis: createNutritionInformativeSynthesisPort(policy) });
}
