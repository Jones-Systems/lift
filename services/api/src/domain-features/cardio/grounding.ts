import { z } from 'zod';

export type AccessLevel = 'abstract' | 'partial' | 'full' | 'official' | 'unknown';

// WS14 contract e24f70f: structural port only; exact runtime injection belongs to WS01.
export interface ObservationGrounding {
  schema: 'form.observation-grounding/v1';
  source: { repository: string; revision: string; corpusRoot: string; corpusInputSha256: string };
  clinicalReadiness: 'CL-0';
  corpusStatus: unknown;
  coverage: unknown;
  query: string;
  filters: { topic: string | null; access: AccessLevel | null };
  limit: number;
  totalMatches: number;
  truncated: boolean;
  verbatimPassagesAvailable: false;
  status: 'observations' | 'gap';
  reason?: 'no_matching_observations';
  observations: readonly {
    record: { id: string; kind: 'source_observation'; clinical_readiness: 'CL-0' };
    source_path: string;
    line: number;
    source_packet_sha256: string;
  }[];
}

export interface GroundingPort {
  retrieve(request: { query: string; topic?: string; access?: AccessLevel; limit?: number }): ObservationGrounding;
}

export interface ConsumerContext {
  contextRevision: string;
  sourceRevision: string;
  corpusInputSha256: string;
  regionalPreflight: 'resolved' | 'unresolved';
  trainingRoute: string;
  regionalRoute: string;
  escalation_route: string;
  confirmation_state: string;
}

export const contextSchema = z.strictObject({
  contextRevision: z.string().min(1), sourceRevision: z.string().min(1), corpusInputSha256: z.string().min(1),
  regionalPreflight: z.enum(['resolved', 'unresolved']), trainingRoute: z.string().min(1),
  regionalRoute: z.string().min(1), escalation_route: z.string().min(1), confirmation_state: z.string().min(1),
});

export interface DomainResearchResponse<Job> {
  answer: null;
  uncertainty_or_abstention: readonly string[];
  source_ids: readonly string[];
  allowed_action: 'abstain';
  escalation_route: string;
  confirmation_state: string;
  job: Job;
  context: ConsumerContext;
  grounding: ObservationGrounding | null;
  resultStatus: 'research_observations' | 'gap' | 'unavailable';
}

export interface ResearchJob {
  kind: string;
  intent: 'explain';
}

export function createResearchConsumer<Job extends ResearchJob>(
  port: GroundingPort,
  parse: (input: unknown) => Job,
  queryFor: (job: Job) => string,
) {
  let generation = 0;
  const issued = new WeakMap<object, number>();

  function evaluate(input: unknown, context: ConsumerContext): DomainResearchResponse<Job> {
    const job = parse(input);
    const snapshot = contextSchema.parse(context);
    const startGeneration = generation;
    const reasons = ['Retained observations are partial CL-0 research, not verified original passages or adopted advice.'];
    if (snapshot.regionalPreflight !== 'resolved') reasons.push('Regional preflight is unresolved; no training action is available.');
    let grounding: ObservationGrounding | null = null;
    let resultStatus: DomainResearchResponse<Job>['resultStatus'] = 'unavailable';
    try {
      const query = queryFor(job);
      const retrieved = structuredClone(port.retrieve({ query, limit: 20 }));
      if (startGeneration !== generation || retrieved.source.revision !== snapshot.sourceRevision
        || retrieved.source.corpusInputSha256 !== snapshot.corpusInputSha256) {
        reasons.push('Evidence or context has changed; retrieve again against the current binding.');
      } else if (retrieved.schema !== 'form.observation-grounding/v1'
        || retrieved.clinicalReadiness !== 'CL-0' || retrieved.verbatimPassagesAvailable !== false
        || retrieved.query !== query || retrieved.limit !== 20
        || retrieved.filters.topic !== null || retrieved.filters.access !== null
        || !['observations', 'gap'].includes(retrieved.status)
        || (retrieved.status === 'gap' && (retrieved.reason !== 'no_matching_observations' || retrieved.observations.length !== 0))
        || (retrieved.status === 'observations' && retrieved.observations.length === 0)
        || retrieved.observations.some(entry => entry.record.kind !== 'source_observation' || entry.record.clinical_readiness !== 'CL-0')) {
        reasons.push('Unsupported evidence contract; no qualified-content or clinical authority is accepted.');
      } else {
        grounding = retrieved;
        resultStatus = retrieved.status === 'gap' ? 'gap' : 'research_observations';
        if (retrieved.status === 'gap') reasons.push('No matching observations in this bounded query; this is not evidence of a null result.');
      }
    } catch {
      reasons.push('Grounding is unavailable; no model-prior answer is substituted.');
    }
    const response: DomainResearchResponse<Job> = {
      answer: null, uncertainty_or_abstention: reasons,
      source_ids: grounding?.observations.map(entry => entry.record.id) ?? [],
      allowed_action: 'abstain', escalation_route: snapshot.escalation_route,
      confirmation_state: snapshot.confirmation_state, job, context: snapshot, grounding, resultStatus,
    };
    deepFreeze(response);
    issued.set(response, startGeneration);
    return response;
  }

  return {
    evaluate,
    invalidate(_reason: 'correction' | 'source_change' | 'deletion' | 'consent_withdrawal') { generation += 1; },
    isCurrent(response: DomainResearchResponse<Job>, current: ConsumerContext): boolean {
      return response.resultStatus !== 'unavailable' && issued.get(response) === generation
        && Object.keys(response.context).every(key => response.context[key as keyof ConsumerContext] === current[key as keyof ConsumerContext]);
    },
  };
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}
