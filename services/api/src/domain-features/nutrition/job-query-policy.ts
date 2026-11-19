// Default off: job-query mode needs an owner-approved mapping and a separately admitted
// qualification, and this file supplies no mapping.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { GroundingResult, SourceBinding } from '../../grounding/index.js';
import { nutritionJobTopics, type NutritionJob, type NutritionTopic } from './index.js';

export type NutritionQueryPolicySelection =
  | { readonly mode: 'form.nutrition-raw-question/v1' }
  | { readonly mode: 'form.nutrition-job-query/v1';
      readonly mapping: { readonly version: string; readonly queries: Readonly<Record<NutritionJob, string>> };
      readonly corpus: SourceBinding };

export type CapturedNutritionQueryPolicy =
  | Extract<NutritionQueryPolicySelection, { mode: 'form.nutrition-raw-question/v1' }>
  | (Extract<NutritionQueryPolicySelection, { mode: 'form.nutrition-job-query/v1' }>
      & { readonly mappingDigest: string });

const captured = new WeakSet<object>();
const jobs = Object.keys(nutritionJobTopics) as NutritionJob[];
type Data = Record<string, unknown>;

function invalid(): never { throw new TypeError('invalid-nutrition-query-policy'); }
function fields(value: unknown, keys: readonly string[]): Data {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
    const field = descriptors[key];
    return !field || !('value' in field) || !field.enumerable;
  })) return invalid();
  return value as Data;
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\uD800-\uDFFF]/u.test(value);
}

// Host injection only: no phrases, mounted lifetime, rights or currentness authority is supplied here.
export function captureNutritionQueryPolicy(
  selection?: NutritionQueryPolicySelection,
): CapturedNutritionQueryPolicy {
  if (selection !== null && typeof selection === 'object' && captured.has(selection)) return selection as CapturedNutritionQueryPolicy;
  const input: unknown = selection === undefined ? { mode: 'form.nutrition-raw-question/v1' } : selection;
  if (input === null || typeof input !== 'object') return invalid();
  const mode = Object.getOwnPropertyDescriptor(input, 'mode');
  if (!mode || !('value' in mode)) return invalid();
  let policy: CapturedNutritionQueryPolicy;
  if (mode.value === 'form.nutrition-raw-question/v1') {
    fields(input, ['mode']);
    policy = Object.freeze({ mode: 'form.nutrition-raw-question/v1' });
  } else if (mode.value === 'form.nutrition-job-query/v1') {
    const value = fields(input, ['mode', 'mapping', 'corpus']);
    const mapping = fields(value.mapping, ['version', 'queries']);
    if (!text(mapping.version)) return invalid();
    const values = fields(mapping.queries, jobs);
    const queries = {} as Record<NutritionJob, string>;
    for (const job of jobs) {
      const query = values[job];
      if (!text(query) || !/[\p{L}\p{N}]/u.test(query)) return invalid();
      queries[job] = query;
    }
    const source = fields(value.corpus, ['repository', 'revision', 'corpusRoot', 'corpusInputSha256']);
    if (!text(source.repository) || !text(source.corpusRoot)
      || typeof source.revision !== 'string' || !/^[0-9a-f]{40}$/.test(source.revision)
      || typeof source.corpusInputSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.corpusInputSha256)) return invalid();
    const corpus = Object.freeze({ repository: source.repository, revision: source.revision,
      corpusRoot: source.corpusRoot, corpusInputSha256: source.corpusInputSha256 });
    const frozenMapping = Object.freeze({ version: mapping.version, queries: Object.freeze(queries) });
    const mappingDigest = createHash('sha256').update(JSON.stringify([
      'form.nutrition-job-query/v1', frozenMapping.version, jobs.map(job => [job, queries[job]]),
    ])).digest('hex');
    policy = Object.freeze({ mode: 'form.nutrition-job-query/v1', mapping: frozenMapping, mappingDigest, corpus });
  } else {
    throw new TypeError('unsupported-nutrition-query-policy');
  }
  captured.add(policy);
  return policy;
}

export function resolveNutritionQuery(selection: NutritionQueryPolicySelection | undefined,
  job: NutritionJob, originalQuestion: string): Readonly<{ query: string; topic: NutritionTopic }> {
  const policy = captureNutritionQueryPolicy(selection);
  if (!Object.hasOwn(nutritionJobTopics, job)) throw new TypeError('unsupported-nutrition-job');
  if (typeof originalQuestion !== 'string' || !originalQuestion.trim()) throw new TypeError('invalid-nutrition-question');
  return Object.freeze({ query: policy.mode === 'form.nutrition-job-query/v1'
    ? policy.mapping.queries[job] : originalQuestion, topic: nutritionJobTopics[job] });
}

export function nutritionQueryMatchesEvidence(selection: NutritionQueryPolicySelection | undefined,
  job: NutritionJob, question: string, evidence: GroundingResult): boolean {
  const policy = captureNutritionQueryPolicy(selection);
  const effective = resolveNutritionQuery(policy, job, question);
  return evidence.query === effective.query && evidence.filters.topic === effective.topic
    && evidence.observations.every(({ record }) => record.topic_ids.includes(effective.topic))
    && (policy.mode === 'form.nutrition-raw-question/v1'
      || (evidence.schema === 'form.observation-grounding/v1' && isDeepStrictEqual(evidence.source, policy.corpus)));
}

export interface NutritionQueryExpectation {
  readonly turnId: number;
  readonly previousTurnId: number | null;
  readonly job: NutritionJob;
  readonly question: string;
  readonly userContext: readonly string[];
}

export interface NutritionQuerySidecar {
  readonly schema: 'form.nutrition-query-binding/v1';
  readonly mode: CapturedNutritionQueryPolicy['mode'];
  readonly mappingVersion: string | null;
  readonly mappingDigest: string | null;
  readonly effectiveQuery: string;
  readonly job: NutritionJob;
  readonly topic: NutritionTopic;
  readonly corpus: SourceBinding;
  readonly turn: NutritionQueryExpectation;
  readonly authorityEffect: 'none';
  readonly requestedDetailSupport: 'unassessed';
}

// Evidence and turn inputs must be trusted current expectations, never candidate-answer metadata.
// The host must retain/transport this separately; neither answers nor user prose select it.
export function createNutritionQuerySidecar(selection: NutritionQueryPolicySelection | undefined,
  current: NutritionQueryExpectation, evidence: GroundingResult): NutritionQuerySidecar {
  const policy = captureNutritionQueryPolicy(selection);
  const effective = resolveNutritionQuery(policy, current.job, current.question);
  if (!Number.isSafeInteger(current.turnId) || current.turnId < 1
    || current.previousTurnId !== (current.turnId === 1 ? null : current.turnId - 1)
    || !Array.isArray(current.userContext) || current.userContext.some(value => !text(value))) {
    throw new TypeError('invalid-nutrition-query-turn');
  }
  if (!nutritionQueryMatchesEvidence(policy, current.job, current.question, evidence)) {
    throw new TypeError('nutrition-query-evidence-mismatch');
  }
  return Object.freeze({ schema: 'form.nutrition-query-binding/v1', mode: policy.mode,
    mappingVersion: policy.mode === 'form.nutrition-job-query/v1' ? policy.mapping.version : null,
    mappingDigest: policy.mode === 'form.nutrition-job-query/v1' ? policy.mappingDigest : null,
    effectiveQuery: effective.query, job: current.job, topic: effective.topic,
    corpus: Object.freeze({ ...evidence.source }),
    turn: Object.freeze({ turnId: current.turnId, previousTurnId: current.previousTurnId,
      job: current.job, question: current.question, userContext: Object.freeze([...current.userContext]) }),
    authorityEffect: 'none', requestedDetailSupport: 'unassessed' });
}
