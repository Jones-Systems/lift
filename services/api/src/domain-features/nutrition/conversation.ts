import type { GroundingResult, ObservationEntry } from '../../grounding/index.js';
import { nutritionSourceRequest, retrieveNutritionSources, type NutritionGroundingPort,
  type NutritionJob, type NutritionSourceResult } from './index.js';

export type NutritionConversationChoice = 'ask' | 'continue-question' | 'source-explanation'
  | 'request-clarification' | 'correct-question' | 'update-context';

export interface NutritionConversationInput {
  readonly choice: NutritionConversationChoice;
  readonly previousTurnId: number | null;
  readonly job: NutritionJob;
  readonly question: string;
  readonly userContext: readonly string[];
  readonly correction: string | null;
}

export type NutritionConversationSources = NutritionSourceResult<ObservationEntry, GroundingResult>;

// The injected owner must return its shared, cited and qualified synthesis result unchanged.
export interface NutritionInformativeSynthesisPort<TExplanation> {
  explain(input: {
    readonly turnId: number;
    readonly previousTurnId: number | null;
    readonly choice: NutritionConversationChoice;
    readonly userContext: readonly string[];
    readonly sources: NutritionConversationSources;
  }): Promise<TExplanation>;
}

export interface NutritionConversationTurn<TExplanation> {
  readonly id: number;
  readonly input: NutritionConversationInput;
  readonly supersedesTurnId: number | null;
  readonly status: 'pending' | 'explanation' | 'synthesis-unavailable' | 'retrieval-unavailable';
  readonly sources: NutritionConversationSources | null;
  readonly explanation: TExplanation | null;
}

export interface NutritionConversationState<TExplanation> {
  readonly turns: readonly NutritionConversationTurn<TExplanation>[];
  readonly rejectedChoices: readonly {
    readonly input: NutritionConversationInput;
    readonly reason: 'nutrition-turn-in-progress' | 'stale-nutrition-turn';
  }[];
  readonly currentTurnId: number | null;
  readonly currentExplanation: TExplanation | null;
  readonly automaticAdoption: 'none';
}

const choices: readonly NutritionConversationChoice[] = ['ask', 'continue-question', 'source-explanation',
  'request-clarification', 'correct-question', 'update-context'];

export function createNutritionConversation<TExplanation>(dependencies: {
  readonly grounding: NutritionGroundingPort<ObservationEntry, GroundingResult>;
  readonly synthesis?: NutritionInformativeSynthesisPort<TExplanation>;
}) {
  const turns: NutritionConversationTurn<TExplanation>[] = [];
  const rejectedChoices: { input: NutritionConversationInput; reason: 'nutrition-turn-in-progress' | 'stale-nutrition-turn' }[] = [];
  let busy = false;

  function snapshot(): NutritionConversationState<TExplanation> {
    const current = turns.at(-1);
    return structuredClone({ turns, rejectedChoices, currentTurnId: current?.id ?? null,
      currentExplanation: current?.explanation ?? null, automaticAdoption: 'none' });
  }

  async function submit(input: NutritionConversationInput): Promise<NutritionConversationState<TExplanation>> {
    if (busy) {
      rejectedChoices.push({ input: structuredClone(input), reason: 'nutrition-turn-in-progress' });
      throw new Error('nutrition-turn-in-progress');
    }
    const previous = turns.at(-1);
    if (!choices.includes(input.choice)) throw new TypeError('unsupported-nutrition-choice');
    if (input.previousTurnId !== (previous?.id ?? null)) {
      rejectedChoices.push({ input: structuredClone(input), reason: 'stale-nutrition-turn' });
      throw new Error('stale-nutrition-turn');
    }
    if ((input.choice === 'ask') !== (previous === undefined)) throw new Error('invalid-nutrition-turn-choice');
    const correcting = input.choice === 'correct-question' || input.choice === 'update-context';
    if (correcting ? typeof input.correction !== 'string' || !input.correction.trim() : input.correction !== null) {
      throw new TypeError('invalid-nutrition-correction');
    }
    if (!Array.isArray(input.userContext) || input.userContext.some(value => typeof value !== 'string' || !value.trim())) {
      throw new TypeError('invalid-nutrition-context');
    }
    const accepted = structuredClone(input);
    const corrections = [...turns.map(turn => turn.input.correction).filter((value): value is string => value !== null),
      ...(accepted.correction === null ? [] : [accepted.correction])];
    const request = nutritionSourceRequest({ job: accepted.job, question: accepted.question, corrections });
    const turn: NutritionConversationTurn<TExplanation> = {
      id: turns.length + 1, input: accepted, supersedesTurnId: correcting ? previous!.id : null,
      status: 'pending', sources: null, explanation: null,
    };
    const index = turns.length;
    turns.push(turn);
    busy = true;
    try {
      const sources = await retrieveNutritionSources(request, dependencies.grounding);
      if (sources.retrievalContext === null) {
        turns[index] = { ...turn, status: 'retrieval-unavailable', sources };
      } else if (!dependencies.synthesis) {
        turns[index] = { ...turn, status: 'synthesis-unavailable', sources };
      } else {
        try {
          const explanation = await dependencies.synthesis.explain({
            turnId: turn.id, previousTurnId: accepted.previousTurnId,
            choice: accepted.choice, userContext: [...accepted.userContext], sources: structuredClone(sources),
          });
          turns[index] = { ...turn, status: 'explanation', sources, explanation: structuredClone(explanation) };
        } catch {
          turns[index] = { ...turn, status: 'synthesis-unavailable', sources };
        }
      }
    } catch {
      turns[index] = { ...turn, status: 'retrieval-unavailable' };
    } finally {
      busy = false;
    }
    return snapshot();
  }

  return Object.freeze({ snapshot, submit });
}
