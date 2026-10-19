import { isDeepStrictEqual } from 'node:util';
import { GroundingInputError, type GroundingRequest, type GroundingResult, type GroundingRetriever, type ObservationEntry } from './index.js';

export interface AnswerContext {
  readonly revision: string;
  readonly facts: readonly { readonly id: string; readonly text: string; readonly origin: 'user_provided' }[];
  readonly supersedesRevision: string | null;
}
export interface GroundedAnswerRequest {
  readonly retrieval: GroundingRequest;
  readonly context: AnswerContext;
}
export interface CitedStatement {
  readonly id: string;
  readonly evidenceKind: 'retained_source_observation';
  readonly text: string;
  readonly citation: ObservationEntry;
  readonly originalPassageVerified: false;
}
export interface LiteratureOption {
  readonly id: string;
  readonly kind: 'literature_consideration';
  readonly title: string;
  readonly statementId: string;
  readonly adoption: 'not_applied';
}
export interface AnswerConflict {
  readonly observationId: string;
  readonly conflictingObservationId: string;
  readonly referencedObservationIncluded: boolean;
  readonly disposition: 'unresolved';
}
export interface GroundedAnswer {
  readonly schema: 'form.grounded-answer/v1';
  readonly status: 'informative' | 'gap';
  readonly evidence: GroundingResult;
  readonly context: AnswerContext;
  readonly contextUse: 'acknowledged_not_applicability_assessed';
  readonly introduction: string;
  readonly statements: readonly CitedStatement[];
  readonly conflicts: readonly AnswerConflict[];
  readonly options: readonly LiteratureOption[];
  readonly choice: { readonly decisionOwner: 'user'; readonly automaticAdoption: false; readonly text: string };
}
export interface GroundedAnswerEvaluation {
  readonly schema: 'form.grounded-answer-evaluation/v1';
  readonly passed: boolean;
  readonly scope: 'source_fidelity_and_contract';
  readonly failures: readonly {
    readonly code: 'malformed_answer' | 'source_mismatch' | 'statement_mismatch' | 'citation_mismatch' | 'qualifier_loss' | 'conflict_loss' | 'missingness_loss' | 'context_mismatch' | 'choice_violation';
    readonly statementId: string | null;
  }[];
  readonly scientificValidityAssessed: false;
  readonly individualApplicabilityAssessed: false;
  readonly publicationRightsAssessed: false;
}

const informativeIntroduction = 'These retained research observations describe what the cited literature reports. Their qualifications and unresolved differences are included below.';
const gapIntroduction = 'No matching observations were found for this search in the retained corpus.';
const choiceText = 'You can use these observations when considering your options. No choice or change has been applied.';
type DataObject = Record<string, unknown>;
type Failure = GroundedAnswerEvaluation['failures'][number];
function dataObject(value: unknown): value is DataObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, keys: readonly string[]): value is DataObject {
  return dataObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\uD800-\uDFFF]/u.test(value);
}
function invalid(message: string): never { throw new GroundingInputError('invalid_request', message); }

// Copy data without invoking accessors; returned answers own their context and evidence snapshots.
function copyData(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) return invalid('expected acyclic data');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid('expected plain data');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) return invalid('unsupported symbol fields');
  if (array && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key as string)))) return invalid('expected dense data array');
  ancestors.add(value);
  const result: unknown[] | DataObject = array ? [] : {};
  for (const key of keys) {
    if (array && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in property) || !property.enumerable) return invalid('expected enumerable data properties');
    Object.defineProperty(result, key, { value: copyData(property.value, ancestors), enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value);
  return result;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function contextSnapshot(value: unknown): AnswerContext {
  const context = copyData(value);
  if (!fields(context, ['revision', 'facts', 'supersedesRevision']) || !nonempty(context.revision) || !Array.isArray(context.facts)) return invalid('invalid answer context');
  if (context.supersedesRevision !== null && (!nonempty(context.supersedesRevision) || context.supersedesRevision === context.revision)) return invalid('invalid context supersession');
  const ids = new Set<string>();
  for (const fact of context.facts) {
    if (!fields(fact, ['id', 'text', 'origin']) || !nonempty(fact.id) || !nonempty(fact.text) || fact.origin !== 'user_provided' || ids.has(fact.id)) return invalid('invalid or duplicate context fact');
    ids.add(fact.id);
  }
  return context as unknown as AnswerContext;
}

export function composeGroundedAnswer(retriever: GroundingRetriever, request: GroundedAnswerRequest): GroundedAnswer {
  const input = copyData(request);
  if (!fields(input, ['retrieval', 'context'])) return invalid('invalid grounded answer request');
  const context = contextSnapshot(input.context);
  const evidence = copyData(retriever.retrieve(input.retrieval as GroundingRequest)) as GroundingResult;
  const included = new Set(evidence.observations.map(entry => entry.record.id));
  return freeze({
    schema: 'form.grounded-answer/v1', status: evidence.status === 'gap' ? 'gap' : 'informative', evidence, context,
    contextUse: 'acknowledged_not_applicability_assessed',
    introduction: evidence.status === 'gap' ? gapIntroduction : informativeIntroduction,
    statements: evidence.observations.map(citation => ({
      id: citation.record.id, evidenceKind: 'retained_source_observation', text: citation.record.summary, citation, originalPassageVerified: false,
    })),
    conflicts: evidence.observations.flatMap(({ record }) => record.conflicts.map(id => ({
      observationId: record.id, conflictingObservationId: id, referencedObservationIncluded: included.has(id), disposition: 'unresolved',
    }))),
    options: evidence.observations.map(({ record }) => ({ id: record.id, kind: 'literature_consideration', title: record.title, statementId: record.id, adoption: 'not_applied' })),
    choice: { decisionOwner: 'user', automaticAdoption: false, text: choiceText },
  } as GroundedAnswer);
}

export function evaluateGroundedAnswer(answer: unknown, expectedEvidence: GroundingResult, currentContext: AnswerContext): GroundedAnswerEvaluation {
  const failures: Failure[] = [];
  const fail = (code: Failure['code'], statementId: string | null = null): void => {
    if (!failures.some(item => item.code === code && item.statementId === statementId)) failures.push({ code, statementId });
  };
  const finish = (): GroundedAnswerEvaluation => freeze({
    schema: 'form.grounded-answer-evaluation/v1', passed: failures.length === 0, scope: 'source_fidelity_and_contract', failures,
    scientificValidityAssessed: false, individualApplicabilityAssessed: false, publicationRightsAssessed: false,
  });
  let value: unknown;
  try { value = copyData(answer); } catch { fail('malformed_answer'); return finish(); }
  if (!fields(value, ['schema', 'status', 'evidence', 'context', 'contextUse', 'introduction', 'statements', 'conflicts', 'options', 'choice'])) {
    fail('malformed_answer'); return finish();
  }
  const status = expectedEvidence.status === 'gap' ? 'gap' : 'informative';
  if (value.schema !== 'form.grounded-answer/v1' || value.status !== status || value.introduction !== (status === 'gap' ? gapIntroduction : informativeIntroduction)) fail('malformed_answer');
  try {
    if (!isDeepStrictEqual(contextSnapshot(value.context), contextSnapshot(currentContext)) || value.contextUse !== 'acknowledged_not_applicability_assessed') fail('context_mismatch');
  } catch { fail('context_mismatch'); }
  if (!fields(value.choice, ['decisionOwner', 'automaticAdoption', 'text']) || value.choice.decisionOwner !== 'user' || value.choice.automaticAdoption !== false || value.choice.text !== choiceText) fail('choice_violation');

  // The oracle is supplied separately by the caller, never reconstructed by running the composer.
  if (!isDeepStrictEqual(value.evidence, expectedEvidence)) fail('source_mismatch');
  const evidence = dataObject(value.evidence) ? value.evidence : {};
  for (const key of ['status', 'reason', 'clinicalReadiness', 'verbatimPassagesAvailable', 'limit', 'totalMatches', 'truncated', 'coverage', 'corpusStatus'] as const) {
    if (!isDeepStrictEqual(evidence[key], (expectedEvidence as unknown as DataObject)[key])) fail('missingness_loss');
  }
  const qualifiers = ['access_level', 'source_native_certainty', 'form_appraisal', 'applicability', 'rights_status', 'freshness_status', 'clinical_readiness', 'provenance'] as const;
  const inspectCitation = (candidate: unknown, expected: ObservationEntry): void => {
    if (!isDeepStrictEqual(candidate, expected)) fail('citation_mismatch', expected.record.id);
    const record = dataObject(candidate) && dataObject(candidate.record) ? candidate.record : {};
    for (const key of qualifiers) if (!isDeepStrictEqual(record[key], expected.record[key])) fail('qualifier_loss', expected.record.id);
  };
  const statements = Array.isArray(value.statements) ? value.statements : [];
  const options = Array.isArray(value.options) ? value.options : [];
  const observations = Array.isArray(evidence.observations) ? evidence.observations : [];
  if (!Array.isArray(value.statements) || statements.length !== expectedEvidence.observations.length) fail('statement_mismatch');
  if (!Array.isArray(value.options) || options.length !== expectedEvidence.observations.length) fail('choice_violation');
  for (const [index, entry] of expectedEvidence.observations.entries()) {
    const id = entry.record.id;
    inspectCitation(observations[index], entry);
    const statement = statements[index];
    if (!fields(statement, ['id', 'evidenceKind', 'text', 'citation', 'originalPassageVerified'])) {
      fail('statement_mismatch', id);
    } else {
      if (statement.id !== id || statement.evidenceKind !== 'retained_source_observation' || statement.text !== entry.record.summary) fail('statement_mismatch', id);
      if (statement.originalPassageVerified !== false) fail('citation_mismatch', id);
      inspectCitation(statement.citation, entry);
    }
    const option = options[index];
    if (!fields(option, ['id', 'kind', 'title', 'statementId', 'adoption']) || option.id !== id || option.kind !== 'literature_consideration' || option.title !== entry.record.title || option.statementId !== id || option.adoption !== 'not_applied') fail('choice_violation', id);
  }
  const conflicts = Array.isArray(value.conflicts) ? value.conflicts : [];
  let edgeIndex = 0;
  for (const entry of expectedEvidence.observations) {
    for (const referencedId of entry.record.conflicts) {
      const edge = conflicts[edgeIndex++];
      const present = expectedEvidence.observations.some(item => item.record.id === referencedId);
      if (!fields(edge, ['observationId', 'conflictingObservationId', 'referencedObservationIncluded', 'disposition']) || edge.observationId !== entry.record.id || edge.conflictingObservationId !== referencedId || edge.referencedObservationIncluded !== present || edge.disposition !== 'unresolved') fail('conflict_loss', entry.record.id);
    }
  }
  if (!Array.isArray(value.conflicts) || conflicts.length !== edgeIndex) fail('conflict_loss');
  return finish();
}
