import { createHash } from 'node:crypto';

export type AccessLevel = 'abstract' | 'partial' | 'full' | 'official' | 'unknown';
export interface SourceObservation {
  readonly id: string;
  readonly kind: 'source_observation';
  readonly topic_ids: readonly string[];
  readonly title: string;
  readonly url: string;
  readonly doi: string | null;
  readonly pmid: string | null;
  readonly published: string;
  readonly accessed: string;
  readonly access_level: AccessLevel;
  readonly locator: string;
  readonly summary: string;
  readonly source_native_certainty: string;
  readonly form_appraisal: string;
  readonly applicability: string;
  readonly rights_status: string;
  readonly freshness_status: string;
  readonly clinical_readiness: 'CL-0';
  readonly provenance: string;
  readonly conflicts: readonly string[];
}
export interface ObservationEntry {
  readonly record: SourceObservation;
  readonly source_path: string;
  readonly line: number;
  readonly source_packet_sha256: string;
}
export interface SourceBinding {
  readonly repository: string;
  readonly revision: string;
  readonly corpusRoot: string;
  readonly corpusInputSha256: string;
}
export interface ResearchCoverage {
  readonly schema: 'form.research-coverage/v1';
  readonly authority_effect: 'none';
  readonly source_plan: string;
  readonly source_plan_revision: string;
  readonly units: readonly {
    readonly unit_id: string;
    readonly title: string;
    readonly state: 'unsearched' | 'partial' | 'saturated' | 'unknown' | 'blocked';
  }[];
}
export interface CorpusStatus {
  readonly state: 'partial';
  readonly scope: 'fenced source_observation records only';
  readonly clinical_readiness: 'CL-0';
  readonly limitation: string;
  readonly units_without_observations: readonly string[];
  readonly source_packets_without_records: readonly string[];
}
export interface GroundingRequest {
  readonly query: string;
  readonly topic?: string;
  readonly access?: AccessLevel;
  readonly limit?: number;
}
export interface GroundingContext {
  readonly schema: 'form.observation-grounding/v1';
  readonly source: SourceBinding;
  readonly clinicalReadiness: 'CL-0';
  readonly corpusStatus: CorpusStatus;
  readonly coverage: ResearchCoverage;
  readonly query: string;
  readonly filters: { readonly topic: string | null; readonly access: AccessLevel | null };
  readonly limit: number;
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly verbatimPassagesAvailable: false;
}
export type GroundingResult = GroundingContext & (
  | { readonly status: 'observations'; readonly observations: readonly ObservationEntry[] }
  | { readonly status: 'gap'; readonly reason: 'no_matching_observations'; readonly observations: readonly [] }
);
export interface GroundingRetriever {
  retrieve(request: GroundingRequest): GroundingResult;
}
export class GroundingInputError extends Error {
  constructor(readonly code: 'invalid_projection' | 'invalid_binding' | 'invalid_request', message: string) {
    super(message);
    this.name = 'GroundingInputError';
  }
}

type ObjectValue = Record<string, unknown>;
type ErrorCode = GroundingInputError['code'];
const accessLevels = new Set(['abstract', 'partial', 'full', 'official', 'unknown']);
const states = new Set(['unsearched', 'partial', 'saturated', 'unknown', 'blocked']);
const sourceId = /^[A-Z]{3}-S[0-9]+$/;
const topicId = /^[A-Z]{3}-[A-Z][1-9][0-9]*$/;
const sha256 = /^[0-9a-f]{64}$/;
const revision = /^[0-9a-f]{40}$/;
const limitation = 'Research observations only; no claim promotion, clinical validation, answer generation, catalog or cue ingestion.';
const recordFields = 'id kind topic_ids title url doi pmid published accessed access_level locator summary source_native_certainty form_appraisal applicability rights_status freshness_status clinical_readiness provenance conflicts'.split(' ');

function requireValue(condition: unknown, message: string, code: ErrorCode = 'invalid_projection'): asserts condition {
  if (!condition) throw new GroundingInputError(code, message);
}
function object(value: unknown, fields: readonly string[], location: string): ObjectValue {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${location}: expected object`);
  const keys = Object.keys(value);
  requireValue(keys.length === fields.length && keys.every(key => fields.includes(key)), `${location}: invalid fields`);
  return value as ObjectValue;
}
function string(value: unknown, location: string): asserts value is string {
  requireValue(typeof value === 'string' && value.trim() && !/[\uD800-\uDFFF]/u.test(value), `${location}: expected nonempty Unicode string`);
}
function pattern(value: unknown, expression: RegExp, location: string): asserts value is string {
  string(value, location);
  requireValue(expression.test(value), `${location}: invalid format`);
}
function stringArray(value: unknown, location: string): asserts value is string[] {
  requireValue(Array.isArray(value), `${location}: expected array`);
  for (const item of value) string(item, location);
  requireValue(new Set(value).size === value.length, `${location}: duplicate values`);
}
function relativePath(value: unknown, location: string): asserts value is string {
  pattern(value, /^[A-Za-z0-9_./-]+$/, location);
  requireValue(value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), `${location}: expected relative path`);
}
function packetPath(value: unknown): asserts value is string {
  relativePath(value, 'packet path');
  requireValue(/^sources\/[^/]+\.md$/.test(value), 'expected sources/<packet>.md');
}
function equalMembers(actual: unknown, expected: Iterable<string>, location: string): void {
  stringArray(actual, location);
  const members = new Set(expected);
  requireValue(actual.length === members.size && actual.every(item => members.has(item)), `${location}: inconsistent omissions`);
}

// Accept data objects only: never invoke a caller's accessors while snapshotting input.
function snapshot(value: unknown, code: ErrorCode, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  requireValue(typeof value === 'object' && value !== null, 'expected JSON data', code);
  requireValue(!ancestors.has(value), 'cyclic input', code);
  const array = Array.isArray(value);
  requireValue(array || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'expected plain data', code);
  const keys = Reflect.ownKeys(value);
  requireValue(keys.every(key => typeof key === 'string'), 'symbol fields are unsupported', code);
  if (array) requireValue(keys.length === value.length + 1, 'expected dense array without extra fields', code);
  ancestors.add(value);
  const copy: ObjectValue | unknown[] = array ? [] : {};
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireValue('value' in descriptor && descriptor.enumerable, 'expected enumerable data fields', code);
    const item = snapshot(descriptor.value, code, ancestors);
    Object.defineProperty(copy, key, { value: item, enumerable: true, configurable: true, writable: true });
  }
  ancestors.delete(value);
  return copy;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function tokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
function codeUnitOrder(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function validateObservation(value: unknown, topics: Set<string>): SourceObservation {
  const record = object(value, recordFields, 'record');
  for (const key of recordFields) {
    if (!['topic_ids', 'conflicts', 'doi', 'pmid'].includes(key)) string(record[key], key);
  }
  pattern(record.id, sourceId, 'source ID');
  requireValue(record.kind === 'source_observation', 'unsupported record kind');
  stringArray(record.topic_ids, 'topic_ids');
  requireValue(record.topic_ids.length > 0 && record.topic_ids.every(id => topics.has(id)), 'unbound topics');
  stringArray(record.conflicts, 'conflicts');
  for (const id of record.conflicts) pattern(id, sourceId, 'conflict');
  requireValue(accessLevels.has(record.access_level as string) && record.clinical_readiness === 'CL-0', 'unsupported access or clinical readiness');
  const url = record.url as string;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new GroundingInputError('invalid_projection', 'invalid URL'); }
  requireValue(/^https?:\/\//i.test(url) && ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password && !url.split('/')[2]?.includes('@') && parsed.port !== '0' && !/[\\\s\u0000-\u001f\u007f]/u.test(url), 'expected HTTP(S) URL without credentials');
  if (record.doi !== null) pattern(record.doi, /^10\.[0-9]{4,9}\/\S+$/u, 'doi');
  if (record.pmid !== null) pattern(record.pmid, /^[1-9][0-9]*$/, 'pmid');
  pattern(record.accessed, /^\d{4}-\d{2}-\d{2}$/, 'accessed');
  const date = new Date(`${record.accessed}T00:00:00.000Z`);
  requireValue(!record.accessed.startsWith('0000') && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === record.accessed, 'invalid accessed date');
  return record as unknown as SourceObservation;
}

interface Projection {
  readonly coverage: ResearchCoverage;
  readonly corpus_status: CorpusStatus;
  readonly records: readonly ObservationEntry[];
  readonly corpus_input_sha256: string;
}
function validateProjection(value: unknown): Projection {
  const projection = object(value, ['schema', 'projector_version', 'corpus_input_sha256', 'inputs', 'coverage', 'corpus_status', 'records'], 'projection');
  requireValue(projection.schema === 'form.source-observation-projection/v1' && projection.projector_version === '1', 'unsupported projection version');
  pattern(projection.corpus_input_sha256, sha256, 'corpus digest');
  const coverage = object(projection.coverage, ['schema', 'authority_effect', 'source_plan', 'source_plan_revision', 'units'], 'coverage');
  requireValue(coverage.schema === 'form.research-coverage/v1' && coverage.authority_effect === 'none', 'unsupported coverage contract');
  relativePath(coverage.source_plan, 'source_plan');
  requireValue(coverage.source_plan.endsWith('.md'), 'expected Markdown source_plan');
  pattern(coverage.source_plan_revision, revision, 'source_plan_revision');
  requireValue(Array.isArray(coverage.units) && coverage.units.length === 106, 'coverage must declare exactly 106 units');
  const topics = new Set<string>();
  for (const item of coverage.units) {
    const unit = object(item, ['unit_id', 'title', 'state'], 'coverage unit');
    pattern(unit.unit_id, topicId, 'unit_id');
    requireValue(!topics.has(unit.unit_id), 'duplicate coverage unit');
    topics.add(unit.unit_id);
    string(unit.title, 'unit title');
    requireValue(typeof unit.state === 'string' && states.has(unit.state), 'unsupported coverage state');
  }
  requireValue(Array.isArray(projection.inputs) && projection.inputs.length >= 2, 'expected coverage and packet inputs');
  const inputs = new Map<string, string>();
  for (const item of projection.inputs) {
    const input = object(item, ['source_path', 'sha256'], 'input');
    if (input.source_path !== 'coverage.md') packetPath(input.source_path);
    pattern(input.sha256, sha256, 'input digest');
    const path = input.source_path as string;
    requireValue(!inputs.has(path), 'duplicate input path');
    inputs.set(path, input.sha256);
  }
  requireValue(inputs.has('coverage.md'), 'missing coverage input');
  // Python canonical_bytes sorts object keys, retains list order, and appends one LF.
  const canonicalInputs = [...inputs].map(([source_path, sha256]) => ({ sha256, source_path }));
  const digest = createHash('sha256').update(`${JSON.stringify(canonicalInputs)}\n`).digest('hex');
  requireValue(digest === projection.corpus_input_sha256, 'inconsistent corpus input digest');
  requireValue(Array.isArray(projection.records), 'expected records');
  const seen = new Set<string>();
  const locations = new Set<string>();
  const represented = new Set<string>();
  const packets = new Set<string>();
  for (const item of projection.records) {
    const entry = object(item, ['record', 'source_path', 'line', 'source_packet_sha256'], 'entry');
    const record = validateObservation(entry.record, topics);
    requireValue(!seen.has(record.id), 'duplicate source ID');
    seen.add(record.id);
    packetPath(entry.source_path);
    requireValue(Number.isSafeInteger(entry.line) && (entry.line as number) > 0, 'expected positive fence line');
    const location = `${entry.source_path}:${entry.line}`;
    requireValue(!locations.has(location), 'duplicate record location');
    locations.add(location);
    pattern(entry.source_packet_sha256, sha256, 'packet digest');
    requireValue(inputs.get(entry.source_path) === entry.source_packet_sha256, 'inconsistent packet digest or missing input');
    packets.add(entry.source_path);
    for (const id of record.topic_ids) represented.add(id);
  }
  for (const entry of projection.records as unknown as ObservationEntry[]) {
    requireValue(entry.record.conflicts.every(id => seen.has(id)), 'dangling conflict');
  }
  const status = object(projection.corpus_status, ['state', 'scope', 'clinical_readiness', 'limitation', 'units_without_observations', 'source_packets_without_records'], 'corpus_status');
  requireValue(status.state === 'partial' && status.scope === 'fenced source_observation records only' && status.clinical_readiness === 'CL-0' && status.limitation === limitation, 'unsupported corpus status');
  equalMembers(status.units_without_observations, [...topics].filter(id => !represented.has(id)), 'units_without_observations');
  equalMembers(status.source_packets_without_records, [...inputs.keys()].filter(path => path !== 'coverage.md' && !packets.has(path)), 'source_packets_without_records');
  return projection as unknown as Projection;
}
function validateBinding(value: unknown, digest: string): SourceBinding {
  try {
    const binding = object(value, ['repository', 'revision', 'corpusRoot', 'corpusInputSha256'], 'binding');
    string(binding.repository, 'repository');
    pattern(binding.revision, revision, 'revision');
    relativePath(binding.corpusRoot, 'corpusRoot');
    pattern(binding.corpusInputSha256, sha256, 'corpusInputSha256');
    requireValue(binding.corpusInputSha256 === digest, 'binding digest differs from projection');
    return binding as unknown as SourceBinding;
  } catch (error) {
    if (error instanceof GroundingInputError) throw new GroundingInputError('invalid_binding', error.message);
    throw error;
  }
}

// Digest agreement is consistency only; the caller must authenticate source and export provenance.
export function createGroundingRetriever(projection: unknown, binding: SourceBinding): GroundingRetriever {
  const corpus = freeze(validateProjection(snapshot(projection, 'invalid_projection')));
  const source = freeze(validateBinding(snapshot(binding, 'invalid_binding'), corpus.corpus_input_sha256));
  const topics = new Set(corpus.coverage.units.map(unit => unit.unit_id));
  const indexed = corpus.records.map(entry => ({ entry, terms: new Set(tokens(
    Object.values(entry.record).flatMap(value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).join('\n'),
  )) })).sort((a, b) => codeUnitOrder(a.entry.record.id, b.entry.record.id));
  return Object.freeze({
    retrieve(request: GroundingRequest): GroundingResult {
      const input = snapshot(request, 'invalid_request');
      requireValue(input !== null && typeof input === 'object' && !Array.isArray(input), 'expected request object', 'invalid_request');
      const req = input as ObjectValue;
      requireValue(Object.keys(req).every(key => ['query', 'topic', 'access', 'limit'].includes(key)), 'unsupported request fields', 'invalid_request');
      requireValue(typeof req.query === 'string' && !/[\uD800-\uDFFF]/u.test(req.query), 'expected query string', 'invalid_request');
      const terms = tokens(req.query);
      requireValue(terms.length > 0, 'query must contain words or numbers', 'invalid_request');
      requireValue(!('topic' in req) || typeof req.topic === 'string' && topics.has(req.topic), 'unbound topic filter', 'invalid_request');
      requireValue(!('access' in req) || typeof req.access === 'string' && accessLevels.has(req.access), 'unsupported access filter', 'invalid_request');
      const limit = 'limit' in req ? req.limit : 20;
      requireValue(typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit must be an integer between 1 and 100', 'invalid_request');
      const matches = indexed.filter(({ entry, terms: available }) =>
        (!('topic' in req) || entry.record.topic_ids.includes(req.topic as string)) &&
        (!('access' in req) || entry.record.access_level === req.access) && terms.every(term => available.has(term)));
      const common: GroundingContext = {
        schema: 'form.observation-grounding/v1', source, clinicalReadiness: 'CL-0', corpusStatus: corpus.corpus_status,
        coverage: corpus.coverage, query: req.query, filters: { topic: req.topic as string ?? null, access: req.access as AccessLevel ?? null },
        limit, totalMatches: matches.length, truncated: matches.length > limit, verbatimPassagesAvailable: false,
      };
      return freeze(matches.length === 0
        ? { ...common, status: 'gap', reason: 'no_matching_observations', observations: [] } as GroundingResult
        : { ...common, status: 'observations', observations: matches.slice(0, limit).map(({ entry }) => entry) } as GroundingResult);
    },
  });
}
