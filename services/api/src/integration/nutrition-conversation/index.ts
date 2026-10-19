import { createNutritionCitationConversation, type NutritionCitationRequest, type NutritionCitationState } from '../../domain-features/nutrition/citation-followthrough.js';
import type { NutritionConversationInput } from '../../domain-features/nutrition/conversation.js';
import { createRetainedGroundingRetriever } from '../../grounding/artifact.js';
import type { GroundingRetriever } from '../../grounding/index.js';
import type { AccountContext, LifecycleBindings } from '../../lifecycle/types.js';

export type ConversationLifetime = Readonly<{ conversation: object; generation: object }>;
export type ConversationRequest = Readonly<{ identity: object; signal: AbortSignal }>;
export type NutritionHostBindings = Readonly<{
  actor: AccountContext;
  lifecycle: Pick<LifecycleBindings, 'assertActive'>;
  lifetime: ConversationLifetime;
  isCurrentHost: (lifetime: ConversationLifetime, actor: AccountContext) => boolean;
  captureRequest: () => ConversationRequest;
  isCurrentRequest: (identity: object) => boolean;
}>;
export type NutritionConversationHost = Readonly<{
  status: 'available';
  submit: (input: NutritionConversationInput) => Promise<NutritionCitationState>;
  selectCitation: (request: NutritionCitationRequest) => NutritionCitationState;
  snapshot: () => NutritionCitationState;
  dispose: () => void;
}>;
export type NutritionHostResult = NutritionConversationHost | Readonly<{
  status: 'unavailable'; reason: 'nutrition_host_binding_required' | 'retained_grounding_unavailable';
}>;

export class NutritionConversationUnavailable extends Error {
  readonly code = 'nutrition_conversation_unavailable';
  constructor(readonly outcome: 'not-started' | 'unknown') {
    super('Nutrition conversation delivery is unavailable.');
    this.name = 'NutritionConversationUnavailable';
  }
}

export function createNutritionConversationHost(dependencies?: Readonly<{
  bindings?: NutritionHostBindings; retriever?: GroundingRetriever;
}>): NutritionHostResult {
  const bindings = dependencies?.bindings;
  const retriever = dependencies?.retriever;
  if (!bindings || !retriever || !bindings.actor || !bindings.lifecycle?.assertActive || !bindings.lifetime?.conversation ||
      !bindings.lifetime.generation || !bindings.isCurrentHost || !bindings.captureRequest || !bindings.isCurrentRequest) {
    return Object.freeze({ status: 'unavailable', reason: 'nutrition_host_binding_required' });
  }
  const actor = Object.freeze({ ...bindings.actor });
  const lifetime = Object.freeze({ ...bindings.lifetime });
  const { isCurrentHost, captureRequest, isCurrentRequest } = bindings;
  const assertActive = bindings.lifecycle.assertActive;
  let disposed = false;
  let retrievalRequest: ConversationRequest | null = null;
  let producer: ReturnType<typeof createNutritionCitationConversation> | null = null;
  const dispose = () => { disposed = true; producer = null; };
  const guard = (request: ConversationRequest, started: boolean): void => {
    try {
      if (disposed || request.signal.aborted || !isCurrentHost(lifetime, actor) || !isCurrentRequest(request.identity)) throw new Error();
      assertActive(actor);
      if (disposed || request.signal.aborted || !isCurrentHost(lifetime, actor) || !isCurrentRequest(request.identity)) throw new Error();
    } catch {
      dispose();
      throw new NutritionConversationUnavailable(started ? 'unknown' : 'not-started');
    }
  };
  const capture = (): ConversationRequest => {
    try {
      const request = Object.freeze({ ...captureRequest() });
      guard(request, false);
      return request;
    } catch {
      dispose();
      throw new NutritionConversationUnavailable('not-started');
    }
  };
  producer = createNutritionCitationConversation({ retrieve(request) {
    const captured = retrievalRequest;
    if (!captured) { dispose(); throw new NutritionConversationUnavailable('unknown'); }
    guard(captured, true);
    try {
      const result = retriever.retrieve(request);
      guard(captured, true);
      return result;
    } catch (error) { guard(captured, true); throw error; }
  } });
  const read = (operation: (current: NonNullable<typeof producer>) => NutritionCitationState): NutritionCitationState => {
    const request = capture();
    const current = producer;
    if (!current) throw new NutritionConversationUnavailable('not-started');
    try {
      const result = operation(current);
      guard(request, true);
      return result;
    } catch (error) { guard(request, true); throw error; }
  };
  return Object.freeze({
    status: 'available', dispose,
    async submit(input: NutritionConversationInput): Promise<NutritionCitationState> {
      const request = capture();
      const current = producer;
      if (!current) throw new NutritionConversationUnavailable('not-started');
      try {
        let pending: Promise<NutritionCitationState>;
        retrievalRequest = request;
        try { pending = current.submit(input); }
        finally { retrievalRequest = null; }
        const result = await pending;
        guard(request, true);
        return result;
      } catch (error) { guard(request, true); throw error; }
    },
    selectCitation: (request: NutritionCitationRequest) => read(current => current.selectCitation(request)),
    snapshot: () => read(current => current.snapshot()),
  });
}

export function createRetainedNutritionConversationHost(dependencies?: Readonly<{
  bindings?: NutritionHostBindings; projectionBytes?: Uint8Array;
}>): NutritionHostResult {
  if (!dependencies?.bindings || !dependencies.projectionBytes) {
    return Object.freeze({ status: 'unavailable', reason: 'nutrition_host_binding_required' });
  }
  let retriever: GroundingRetriever;
  try { retriever = createRetainedGroundingRetriever(dependencies.projectionBytes); }
  catch { return Object.freeze({ status: 'unavailable', reason: 'retained_grounding_unavailable' }); }
  return createNutritionConversationHost({ bindings: dependencies.bindings, retriever });
}
