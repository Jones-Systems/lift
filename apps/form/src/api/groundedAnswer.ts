import { ApiError, type AuthAttemptGuard, type FormTransport } from './transport';
import type { AnswerContext, CitedStatement, GroundedAnswer } from '../../../../services/api/src/grounding/answer';
import type { ObservationEntry } from '../../../../services/api/src/grounding/index';
export type { AnswerContext, CitedStatement, GroundedAnswer };

type Row = Record<string, unknown>;
const source = Object.freeze({ repository: 'Jones-Systems/Form', revision: '0c68e72727f04a7307407a4a6b73d43b7dca61a6',
  corpusRoot: 'docs/knowledge/research-followups', corpusInputSha256: 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971' });
const access = ['abstract', 'partial', 'full', 'official', 'unknown'];
const fixedIds = new Set(['ANA-S10', 'ANA-S11', 'ANA-S12', 'ANA-S13', 'BCM-S09', 'BCM-S10', 'BEH-S14', 'FLE-S01', 'FLE-S02', 'FLE-S03', 'FLE-S04', 'FLE-S05', 'HLT-S13', 'HLT-S14', 'HLT-S15', 'HLT-S16', 'HLT-S17', 'HLT-S18', 'HLT-S19', 'HLT-S20', 'HLT-S21', 'HLT-S22', 'HLT-S23', 'HLT-S24', 'HLT-S25', 'NUT-S034']);
const representedTopics = new Set(['ANA-C2', 'BCM-Z1', 'BEH-X1', 'DOS-E1', 'EXU-B4', 'EXU-B5', 'HLT-Y1', 'NUT-I3']);
const sha = /^[0-9a-f]{64}$/, revision = /^[0-9a-f]{40}$/, topic = /^[A-Z]{3}-[A-Z][1-9][0-9]*$/, observation = /^[A-Z]{3}-S[0-9]+$/;
const limitation = 'Research observations only; no claim promotion, clinical validation, answer generation, catalog or cue ingestion.';
function invalid(): never { throw new ApiError(0, 'grounded_answer_invalid', 'The answer could not be verified.'); }
function need(value: unknown): asserts value { if (!value) invalid(); }
function row(value: unknown, keys: readonly string[]): Row {
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  need(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
  return value as Row;
}
function text(value: unknown): string {
  need(typeof value === 'string' && value.trim().length > 0 && !/[\uD800-\uDFFF]/u.test(value)); return value;
}
function pattern(value: unknown, format: RegExp): string { const result = text(value); need(format.test(result)); return result; }
function strings(value: unknown): string[] {
  need(Array.isArray(value)); const result = value.map(text); need(new Set(result).size === result.length); return result;
}
function integer(value: unknown, min = 0): number { need(typeof value === 'number' && Number.isSafeInteger(value) && value >= min); return value; }
function relative(value: unknown): string {
  const result = pattern(value, /^[A-Za-z0-9_./-]+$/); need(result.split('/').every(part => part && part !== '.' && part !== '..')); return result;
}
function packet(value: unknown): string { const result = relative(value); need(/^sources\/[^/]+\.md$/.test(result)); return result; }
function copy(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { need(Number.isFinite(value)); return value; }
  need(typeof value === 'object' && !ancestors.has(value) && depth <= 64);
  const array = Array.isArray(value), keys = Reflect.ownKeys(value);
  need(array || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  need(keys.every(key => typeof key === 'string'));
  if (array) need(keys.length === value.length + 1 && keys.every(key => key === 'length' || /^(0|[1-9][0-9]*)$/.test(String(key)) && Number(key) < value.length));
  ancestors.add(value);
  const result: Row | unknown[] = array ? [] : {};
  for (const key of keys) {
    if (array && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    need('value' in property && property.enumerable);
    Object.defineProperty(result, key, { value: copy(property.value, ancestors, depth + 1), enumerable: true });
  }
  ancestors.delete(value); return Object.freeze(result);
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal((a as Row)[key], (b as Row)[key]));
}
function context(value: unknown): AnswerContext {
  const result = row(value, ['revision', 'facts', 'supersedesRevision']); text(result.revision);
  need(result.supersedesRevision === null || text(result.supersedesRevision) !== result.revision);
  need(Array.isArray(result.facts));
  const ids = result.facts.map(value => { const fact = row(value, ['id', 'text', 'origin']); text(fact.text); need(fact.origin === 'user_provided'); return text(fact.id); });
  need(new Set(ids).size === ids.length); return result as unknown as AnswerContext;
}
function entry(value: unknown, topics: Set<string>): ObservationEntry {
  const outer = row(value, ['record', 'source_path', 'line', 'source_packet_sha256']);
  packet(outer.source_path); integer(outer.line, 1); pattern(outer.source_packet_sha256, sha);
  const keys = 'id kind topic_ids title url doi pmid published accessed access_level locator summary source_native_certainty form_appraisal applicability rights_status freshness_status clinical_readiness provenance conflicts'.split(' ');
  const record = row(outer.record, keys);
  for (const key of keys) if (!['topic_ids', 'conflicts', 'doi', 'pmid'].includes(key)) text(record[key]);
  pattern(record.id, observation); need(record.kind === 'source_observation' && record.clinical_readiness === 'CL-0');
  const bound = strings(record.topic_ids); need(bound.length > 0 && bound.every(id => topics.has(id)));
  strings(record.conflicts).forEach(id => pattern(id, observation)); need(access.includes(String(record.access_level)));
  if (record.doi !== null) pattern(record.doi, /^10\.[0-9]{4,9}\/\S+$/u);
  if (record.pmid !== null) pattern(record.pmid, /^[1-9][0-9]*$/);
  const url = text(record.url), parsed = new URL(url);
  need(/^https?:\/\//i.test(url) && ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password && !url.split('/')[2]?.includes('@') && parsed.port !== '0' && !/[\\\s\u0000-\u001f\u007f]/u.test(url));
  const date = pattern(record.accessed, /^\d{4}-\d{2}-\d{2}$/);
  need(!date.startsWith('0000') && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date);
  return outer as unknown as ObservationEntry;
}

export function decodeGroundedAnswer(value: unknown, question: string, expectedContext: AnswerContext): GroundedAnswer {
  try {
    const owned = copy(value), answer = row(owned, ['schema', 'status', 'evidence', 'context', 'contextUse', 'introduction', 'statements', 'conflicts', 'options', 'choice']);
    need(new TextEncoder().encode(JSON.stringify(owned)).length <= 4 * 1024 * 1024);
    need(answer.schema === 'form.grounded-answer/v1' && equal(context(answer.context), context(copy(expectedContext))) && answer.contextUse === 'acknowledged_not_applicability_assessed');
    const evidenceValue = answer.evidence as Row;
    const evidence = row(evidenceValue, ['schema', 'source', 'clinicalReadiness', 'corpusStatus', 'coverage', 'query', 'filters', 'limit', 'totalMatches', 'truncated', 'verbatimPassagesAvailable', 'status', 'observations', ...(evidenceValue?.status === 'gap' ? ['reason'] : [])]);
    need(evidence.schema === 'form.observation-grounding/v1' && equal(evidence.source, source) && evidence.query === question);
    need(evidence.clinicalReadiness === 'CL-0' && evidence.verbatimPassagesAvailable === false);
    need(equal(evidence.filters, { topic: null, access: null }) && evidence.limit === 20);
    const coverage = row(evidence.coverage, ['schema', 'authority_effect', 'source_plan', 'source_plan_revision', 'units']);
    need(coverage.schema === 'form.research-coverage/v1' && coverage.authority_effect === 'none');
    need(relative(coverage.source_plan).endsWith('.md')); pattern(coverage.source_plan_revision, revision);
    need(Array.isArray(coverage.units) && coverage.units.length === 106);
    const topics = new Set<string>();
    for (const value of coverage.units) {
      const unit = row(value, ['unit_id', 'title', 'state']); const id = pattern(unit.unit_id, topic);
      need(!topics.has(id)); topics.add(id); text(unit.title); need(['unsearched', 'partial', 'saturated', 'unknown', 'blocked'].includes(String(unit.state)));
    }
    const corpus = row(evidence.corpusStatus, ['state', 'scope', 'clinical_readiness', 'limitation', 'units_without_observations', 'source_packets_without_records']);
    need(corpus.state === 'partial' && corpus.scope === 'fenced source_observation records only' && corpus.clinical_readiness === 'CL-0' && corpus.limitation === limitation);
    const missing = strings(corpus.units_without_observations);
    need(missing.length === 98 && missing.every(id => topics.has(id) && !representedTopics.has(id)));
    need(strings(corpus.source_packets_without_records).length === 0);
    for (const unit of coverage.units as Row[]) need(unit.state === (representedTopics.has(String(unit.unit_id)) ? 'partial' : 'unsearched'));
    const total = integer(evidence.totalMatches); need(total <= 26);
    need(Array.isArray(evidence.observations)); const observations = evidence.observations.map(value => entry(value, topics));
    const ids = observations.map(item => item.record.id); need(new Set(ids).size === ids.length && ids.every((id, i) => fixedIds.has(id) && (i === 0 || ids[i - 1]! < id)));
    const packets = new Map<string, string>(), locations = new Set<string>();
    for (const item of observations) {
      need(item.record.topic_ids.every(id => representedTopics.has(id)) && item.record.conflicts.every(id => fixedIds.has(id)));
      const location = `${item.source_path}:${item.line}`; need(!locations.has(location)); locations.add(location);
      need(!packets.has(item.source_path) || packets.get(item.source_path) === item.source_packet_sha256);
      packets.set(item.source_path, item.source_packet_sha256);
    }
    need(observations.length === Math.min(total, 20) && evidence.truncated === (total > 20));
    if (evidence.status === 'gap') need(total === 0 && evidence.reason === 'no_matching_observations' && answer.status === 'gap');
    else need(evidence.status === 'observations' && total > 0 && answer.status === 'informative');
    need(answer.introduction === (answer.status === 'gap' ? 'No matching observations were found for this search in the retained corpus.' : 'These retained research observations describe what the cited literature reports. Their qualifications and unresolved differences are included below.'));
    need(Array.isArray(answer.statements) && answer.statements.length === observations.length && Array.isArray(answer.options) && answer.options.length === observations.length);
    const expectedConflicts: unknown[] = [];
    for (const [index, citation] of observations.entries()) {
      const statement = row(answer.statements[index], ['id', 'evidenceKind', 'text', 'citation', 'originalPassageVerified']);
      need(statement.id === citation.record.id && statement.evidenceKind === 'retained_source_observation' && statement.text === citation.record.summary && statement.originalPassageVerified === false && equal(statement.citation, citation));
      const option = row(answer.options[index], ['id', 'kind', 'title', 'statementId', 'adoption']);
      need(option.id === citation.record.id && option.kind === 'literature_consideration' && option.title === citation.record.title && option.statementId === citation.record.id && option.adoption === 'not_applied');
      for (const id of citation.record.conflicts) expectedConflicts.push({ observationId: citation.record.id, conflictingObservationId: id, referencedObservationIncluded: ids.includes(id), disposition: 'unresolved' });
    }
    need(equal(answer.conflicts, expectedConflicts));
    need(equal(answer.choice, { decisionOwner: 'user', automaticAdoption: false, text: 'You can use these observations when considering your options. No choice or change has been applied.' }));
    return owned as GroundedAnswer;
  } catch { return invalid(); }
}

export type GroundedAnswerSnapshot = Readonly<{
  status: 'idle' | 'pending' | 'ready' | 'unavailable' | 'stale' | 'disposed';
  code: string | null;
  answer: GroundedAnswer | null;
}>;
export type GroundedAnswerDependencies = Readonly<{
  api: Pick<FormTransport, 'request' | 'captureAuthContext'>;
  accountId: string;
  sessionGeneration: string;
  isCurrentSession(accountId: string, sessionGeneration: string): boolean;
  captureRequest(): AuthAttemptGuard;
  captureContext(context: AnswerContext): AuthAttemptGuard;
}>;
export function createGroundedAnswerCaller(dependencies: GroundedAnswerDependencies) {
  const { api, accountId, sessionGeneration, isCurrentSession, captureRequest, captureContext } = dependencies;
  const auth = api.captureAuthContext();
  let disposed = false, expired = false, sequence = 0;
  let delivery: (() => boolean) | undefined;
  const empty = (status: GroundedAnswerSnapshot['status'], code: string | null = null): GroundedAnswerSnapshot => Object.freeze({ status, code, answer: null });
  let visible = empty('idle');
  const sessionCurrent = () => {
    try { if (!accountId || !sessionGeneration || auth.isCurrent() !== true || isCurrentSession(accountId, sessionGeneration) !== true) expired = true; }
    catch { expired = true; }
    return !expired && !disposed;
  };
  const clear = (status: GroundedAnswerSnapshot['status'], code: string | null) => { sequence++; delivery = undefined; return visible = empty(status, code); };
  const getSnapshot = (): GroundedAnswerSnapshot => {
    if (disposed) return clear('disposed', null);
    if (!sessionCurrent()) return clear('stale', 'session_changed');
    if (delivery && !delivery()) return clear('stale', 'context_or_request_changed');
    return visible;
  };
  return Object.freeze({
    getSnapshot,
    invalidate: () => clear('stale', 'context_or_request_changed'),
    dispose: () => { disposed = true; return clear('disposed', null); },
    selectCitation(statementId: string): CitedStatement | null {
      return getSnapshot().answer?.statements.find(statement => statement.id === statementId) ?? null;
    },
    async ask(question: string, input: AnswerContext): Promise<GroundedAnswerSnapshot> {
      clear('pending', null);
      const requestSequence = sequence;
      if (!sessionCurrent()) return clear(disposed ? 'disposed' : 'stale', 'session_changed');
      if (typeof captureRequest !== 'function' || typeof captureContext !== 'function') return clear('unavailable', 'grounded_answer_scope_unavailable');
      let captured: AnswerContext, current: () => boolean;
      try {
        need(typeof question === 'string' && !/[\uD800-\uDFFF]/u.test(question) && /[\p{L}\p{N}]/u.test(question));
        captured = context(copy(input));
        need(new TextEncoder().encode(JSON.stringify({ retrieval: { query: question }, context: captured })).length <= 64 * 1024);
        const request = captureRequest(), witness = captureContext(captured);
        let invalidated = false;
        current = () => {
          try { if (!sessionCurrent() || request.isCurrent() !== true || witness.isCurrent() !== true) invalidated = true; }
          catch { invalidated = true; }
          return !invalidated;
        };
        const valid = current();
        if (requestSequence !== sequence) return empty('stale', 'request_changed');
        if (!valid) return clear('unavailable', 'grounded_answer_scope_unavailable');
      } catch { return requestSequence === sequence ? clear('unavailable', 'invalid_request') : empty('stale', 'request_changed'); }
      if (requestSequence !== sequence) return empty('stale', 'request_changed');
      delivery = current;
      try {
        const response = await api.request<unknown>('/v1/grounded-answers', 'POST', Object.freeze({ retrieval: Object.freeze({ query: question }), context: captured }));
        if (requestSequence !== sequence) return empty('stale', 'request_changed');
        const valid = current();
        if (requestSequence !== sequence) return empty('stale', 'request_changed');
        if (!valid) return clear('stale', 'context_or_request_changed');
        const answer = decodeGroundedAnswer(response, question, captured);
        if (requestSequence !== sequence) return empty('stale', 'request_changed');
        const stillCurrent = current();
        if (requestSequence !== sequence) return empty('stale', 'request_changed');
        if (!stillCurrent) return clear('stale', 'context_or_request_changed');
        return visible = Object.freeze({ status: 'ready', code: null, answer });
      } catch (error) {
        if (requestSequence !== sequence) return empty('stale', 'request_changed');
        const valid = current();
        if (requestSequence !== sequence) return empty('stale', 'request_changed');
        if (!valid) return clear('stale', 'context_or_request_changed');
        return clear('unavailable', error instanceof ApiError ? error.code : 'grounded_answer_unavailable');
      }
    },
  });
}
