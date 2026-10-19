import type { AnswerConflict, CitedStatement, GroundedAnswer } from '../../grounding/answer.js';
import type { GroundingRetriever } from '../../grounding/index.js';
import type { NutritionConversationInput, NutritionConversationSources, NutritionConversationState } from './conversation.js';
import { createGroundedNutritionConversation } from './synthesis-adapter.js';

export interface NutritionCitationRequest {
  readonly parentTurnId: number;
  readonly statementId: string;
}

export type NutritionCitationSelection = NutritionCitationRequest & { readonly id: number } & (
  | { readonly status: 'selected'; readonly statement: CitedStatement;
      readonly conflicts: readonly AnswerConflict[]; readonly sources: NutritionConversationSources }
  | { readonly status: 'stale-turn' | 'answer-unavailable' | 'unknown-statement' }
);

type SelectedCitation = Extract<NutritionCitationSelection, { status: 'selected' }>;

export interface NutritionCitationState {
  readonly conversation: NutritionConversationState<GroundedAnswer>;
  readonly selections: readonly NutritionCitationSelection[];
  readonly currentSelection: SelectedCitation | null;
}

export function createNutritionCitationConversation(retriever: GroundingRetriever) {
  const conversation = createGroundedNutritionConversation(retriever);
  const selections: NutritionCitationSelection[] = [];
  let currentSelection: SelectedCitation | null = null;

  function snapshot(): NutritionCitationState {
    return structuredClone({ conversation: conversation.snapshot(), selections, currentSelection });
  }

  function submit(input: NutritionConversationInput): Promise<NutritionCitationState> {
    const previousTurnId = conversation.snapshot().currentTurnId;
    const pending = conversation.submit(input);
    // Accepted turns become pending synchronously; rejected inputs do not replace the current turn.
    if (conversation.snapshot().currentTurnId !== previousTurnId) currentSelection = null;
    return pending.then(() => snapshot());
  }

  function selectCitation(request: NutritionCitationRequest): NutritionCitationState {
    const state = conversation.snapshot();
    const turn = state.turns.at(-1);
    const base = { id: selections.length + 1, parentTurnId: request.parentTurnId, statementId: request.statementId };
    currentSelection = null;
    let selection: NutritionCitationSelection;
    if (request.parentTurnId !== state.currentTurnId) {
      selection = { ...base, status: 'stale-turn' };
    } else if (turn?.status !== 'explanation' || turn.explanation === null || turn.sources === null) {
      selection = { ...base, status: 'answer-unavailable' };
    } else {
      const statement = turn.explanation.statements.find(item => item.id === request.statementId);
      if (!statement) {
        selection = { ...base, status: 'unknown-statement' };
      } else {
        currentSelection = { ...base, status: 'selected', statement, sources: turn.sources,
          conflicts: turn.explanation.conflicts.filter(edge => edge.observationId === statement.id
            || edge.conflictingObservationId === statement.id) };
        selection = currentSelection;
      }
    }
    selections.push(selection);
    return snapshot();
  }

  return Object.freeze({ snapshot, submit, selectCitation });
}
