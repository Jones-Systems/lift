import { z } from 'zod';
import type { NutritionConversationInput } from '../../domain-features/nutrition/conversation.js';
import type { NutritionCitationRequest, NutritionCitationState } from '../../domain-features/nutrition/citation-followthrough.js';

export const nutritionWireSchema = 'form.nutrition-conversation-wire/v1' as const;
export type NutritionWireOperation = 'resetFreshEmpty' | 'submit' | 'selectCitation' | 'snapshot' | 'dispose';
export type NutritionWireStatus = 'reset' | 'ok' | 'rejected' | 'unavailable' | 'unknown' | 'disposed';
export type NutritionWireCode = 'stale_turn' | 'turn_in_progress' | 'answer_unavailable' | 'unknown_statement'
  | 'retrieval_unavailable' | 'synthesis_unavailable' | 'nutrition_unconfigured' | 'conversation_unavailable'
  | 'capacity_exceeded' | 'history_limit' | 'response_limit' | 'outcome_unknown';
export type NutritionWireBinding = Readonly<{ id: string; expiresAt: string }>;
export type NutritionWireRequest = Readonly<{ schema: typeof nutritionWireSchema; requestId: string }>;
export type NutritionSubmitRequest = NutritionWireRequest & Readonly<{ input: NutritionConversationInput }>;
export type NutritionSelectionRequest = NutritionWireRequest & Readonly<{ input: NutritionCitationRequest }>;
export type NutritionWireResponse = Readonly<{
  schema: typeof nutritionWireSchema;
  requestId: string;
  operation: NutritionWireOperation;
  status: NutritionWireStatus;
  code: NutritionWireCode | null;
  binding: NutritionWireBinding | null;
  stateVersion: number | null;
  state: NutritionCitationState | null;
  resetRequired: boolean;
}>;
export type { NutritionConversationInput, NutritionCitationRequest, NutritionCitationState };

const utf8 = (maximum: number) => z.string().refine(value => new TextEncoder().encode(value).length <= maximum);
const nonblank = (maximum: number) => utf8(maximum).refine(value => value.trim().length > 0);
export const nutritionEnvelope = z.object({ schema: z.literal(nutritionWireSchema), requestId: z.uuid() }).strict();
export const nutritionInput = z.object({
  choice: z.enum(['ask', 'continue-question', 'source-explanation', 'request-clarification', 'correct-question', 'update-context']),
  previousTurnId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  job: z.enum(['energy-uncertainty', 'deficit-surplus-rate', 'protein', 'nutrients-dietary-patterns', 'logging-accuracy', 'supplements', 'nutrition-boundaries']),
  question: nonblank(2000),
  userContext: z.array(nonblank(1000)).max(16).refine(values => values.reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0) <= 8000),
  correction: nonblank(2000).nullable(),
}).strict().refine(input => ['correct-question', 'update-context'].includes(input.choice) ? input.correction !== null : input.correction === null);
export const nutritionSubmit = nutritionEnvelope.extend({ input: nutritionInput }).strict();
export const nutritionSelection = nutritionEnvelope.extend({ input: z.object({
  parentTurnId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), statementId: nonblank(128),
}).strict() }).strict();
