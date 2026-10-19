import { composeGroundedAnswer, type GroundedAnswerRequest } from '../grounding/answer.js';
import { createFormFollowupGroundingRetriever } from '../grounding/form-artifact.js';
import { GroundingInputError } from '../grounding/index.js';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';

export function createGroundedAnswerHost(configuration?: { projectionBytes: Uint8Array }) {
  const retriever = configuration ? createFormFollowupGroundingRetriever(configuration.projectionBytes) : undefined;
  return Object.freeze({
    configured: retriever !== undefined,
    answer(actor: AccountContext, input: unknown, assertCurrent: (actor: AccountContext) => void) {
      const original = Object.freeze({ ...actor });
      assertCurrent(original);
      if (!retriever) throw new DomainError(501, 'grounded_answer_unavailable');
      try {
        const answer = composeGroundedAnswer(retriever, input as GroundedAnswerRequest);
        assertCurrent(original);
        return answer;
      } catch (error) {
        assertCurrent(original);
        if (error instanceof GroundingInputError && error.code === 'invalid_request')
          throw new DomainError(422, 'invalid_request');
        throw error;
      }
    },
  });
}
