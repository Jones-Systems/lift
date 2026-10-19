export const nutritionJobTopics = Object.freeze({
  'energy-uncertainty': 'NUT-I1',
  'deficit-surplus-rate': 'NUT-I2',
  protein: 'NUT-I3',
  'nutrients-dietary-patterns': 'NUT-I4',
  'logging-accuracy': 'NUT-I5',
  supplements: 'NUT-I6',
  'nutrition-boundaries': 'NUT-I7',
} as const);

export type NutritionJob = keyof typeof nutritionJobTopics;
export type NutritionTopic = typeof nutritionJobTopics[NutritionJob];

export interface NutritionSourceJob {
  readonly job: NutritionJob;
  readonly question: string;
  readonly corrections: readonly string[];
}

export interface NutritionSourceRequest extends NutritionSourceJob {
  readonly consumer: 'CHAT';
  readonly topicIds: readonly NutritionTopic[];
}

export type ObservationProvenance =
  | { readonly status: 'source-observation'; readonly sourceRevision: string;
      readonly locator: string; readonly limits: readonly string[] }
  | { readonly status: 'unqualified'; readonly reason: string };

// The adapter retains its producer's observation unchanged; this is not an appraisal schema.
export interface NutritionSourceCandidate<TObservation> {
  readonly observation: TObservation;
  readonly topicIds: readonly string[];
  readonly provenance: ObservationProvenance;
}

export interface NutritionRetrieval<TObservation, TContext = unknown> {
  readonly context: TContext;
  readonly candidates: readonly NutritionSourceCandidate<TObservation>[];
  readonly gaps: readonly string[];
}

export interface NutritionGroundingPort<TObservation, TContext = unknown> {
  retrieve(request: NutritionSourceRequest): Promise<NutritionRetrieval<TObservation, TContext>>;
}

export type NutritionBoundaryDisposition =
  | { readonly status: 'source-navigation-only' | 'hold'; readonly policyRevision: string;
      readonly locator: string; readonly qualifications: readonly string[] }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface NutritionBoundaryPort {
  assess(request: NutritionSourceRequest): Promise<NutritionBoundaryDisposition>;
}

export type NutritionGap =
  | { readonly code: 'retrieval-gap'; readonly detail: string }
  | { readonly code: 'retrieval-unavailable' | 'no-traceable-observations'
      | 'policy-unavailable' | 'boundary-hold' }
  | { readonly code: 'candidate-unqualified' | 'candidate-outside-topic'; readonly candidateIndex: number };

export interface NutritionSourceResult<TObservation, TContext = unknown> {
  readonly retrievalContext: TContext | null;
  readonly request: NutritionSourceRequest;
  readonly status: 'source-observations' | 'evidence-gap';
  readonly candidates: readonly NutritionSourceCandidate<TObservation>[];
  readonly traceableCandidateIndexes: readonly number[];
  readonly boundary: NutritionBoundaryDisposition;
  readonly gaps: readonly NutritionGap[];
  readonly adviceAuthority: 'none';
  readonly scientificAppraisal: 'not-performed';
}

export function nutritionSourceRequest(input: NutritionSourceJob): NutritionSourceRequest {
  if (!Object.hasOwn(nutritionJobTopics, input.job)) throw new TypeError('unsupported-nutrition-job');
  if (typeof input.question !== 'string' || input.question.trim().length === 0
    || !Array.isArray(input.corrections) || input.corrections.some(value => typeof value !== 'string')) {
    throw new TypeError('invalid-nutrition-source-job');
  }
  return Object.freeze({
    job: input.job, question: input.question, corrections: Object.freeze([...input.corrections]),
    consumer: 'CHAT', topicIds: Object.freeze([nutritionJobTopics[input.job]]),
  });
}

export async function retrieveNutritionSources<TObservation, TContext = unknown>(
  input: NutritionSourceJob,
  grounding: NutritionGroundingPort<TObservation, TContext>,
  boundaryPort?: NutritionBoundaryPort,
): Promise<NutritionSourceResult<TObservation, TContext>> {
  const request = nutritionSourceRequest(input);
  const gaps: NutritionGap[] = [];
  let boundary: NutritionBoundaryDisposition = { status: 'unavailable', reason: 'medical-boundary-policy-not-bound' };
  if (boundaryPort) {
    try {
      boundary = await boundaryPort.assess(request);
      if (boundary.status !== 'unavailable' && (!boundary.policyRevision.trim() || !boundary.locator.trim())) {
        boundary = { status: 'unavailable', reason: 'medical-boundary-policy-provenance-missing' };
      }
    } catch {
      boundary = { status: 'unavailable', reason: 'medical-boundary-policy-unavailable' };
    }
  }
  if (boundary.status === 'unavailable') gaps.push({ code: 'policy-unavailable' });
  if (boundary.status === 'hold') gaps.push({ code: 'boundary-hold' });

  let retrieval: NutritionRetrieval<TObservation, TContext> | null = null;
  try {
    retrieval = await grounding.retrieve(request);
  } catch {
    gaps.push({ code: 'retrieval-unavailable' });
  }
  for (const detail of retrieval?.gaps ?? []) gaps.push({ code: 'retrieval-gap', detail });
  const traceableCandidateIndexes: number[] = [];
  (retrieval?.candidates ?? []).forEach((candidate, candidateIndex) => {
    if (!candidate.topicIds.includes(nutritionJobTopics[request.job])) {
      gaps.push({ code: 'candidate-outside-topic', candidateIndex });
      return;
    }
    const qualification = candidate.provenance;
    if (qualification.status !== 'source-observation'
      || !qualification.sourceRevision.trim() || !qualification.locator.trim()
      || qualification.limits.length === 0 || qualification.limits.some(limit => !limit.trim())) {
      gaps.push({ code: 'candidate-unqualified', candidateIndex });
      return;
    }
    traceableCandidateIndexes.push(candidateIndex);
  });
  if (traceableCandidateIndexes.length === 0) gaps.push({ code: 'no-traceable-observations' });
  return {
    request, status: gaps.length === 0 ? 'source-observations' : 'evidence-gap',
    candidates: retrieval?.candidates ?? [], retrievalContext: retrieval?.context ?? null,
    traceableCandidateIndexes, boundary, gaps,
    adviceAuthority: 'none', scientificAppraisal: 'not-performed',
  };
}
