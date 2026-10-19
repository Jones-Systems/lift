import { ApiError, type FormTransport } from './transport';
import type { AnalysisResult } from '../../../../services/api/src/integration/account-modules/index';
import type { FeedbackContextWitness, FeedbackCurrentView, FeedbackMutationResult, FeedbackWitnessRequest } from '../../../../services/api/src/training-feedback/ledger-types';
import type { TrainingFeedbackEventRequest } from '../../../../services/api/src/training-feedback/request-schema';
export type { FeedbackWitnessRequest, TrainingFeedbackEventRequest };

type Check = (value: unknown) => void;
type Row = Record<string, unknown>;
function need(value: unknown): asserts value { if (!value) throw new Error('Invalid training feedback shape'); }
const text = (max = Infinity): Check => value => need(typeof value === 'string' && value.trim().length > 0 && value.length <= max);
const id = text(160);
const bool: Check = value => need(typeof value === 'boolean');
const number: Check = value => need(typeof value === 'number' && Number.isFinite(value));
const revision = (min = 0): Check => value => need(typeof value === 'number' && Number.isSafeInteger(value) && value >= min);
const one = (...values: unknown[]): Check => value => need(values.includes(value));
const nullable = (check: Check): Check => value => { if (value !== null) check(value); };
const array = (check: Check, min = 0, max = Infinity): Check => value => {
  need(Array.isArray(value) && value.length >= min && value.length <= max); value.forEach(check);
};
function object(value: unknown, fields: Record<string, Check>): Row {
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  const row = value as Row, keys = Object.keys(fields);
  need(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)));
  for (const key of keys) fields[key]!(row[key]);
  return row;
}
const shape = (fields: Record<string, Check>): Check => value => { object(value, fields); };
function detached(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { number(value); return value; }
  need(typeof value === 'object' && !ancestors.has(value));
  const list = Array.isArray(value);
  need(Object.getPrototypeOf(value) === (list ? Array.prototype : Object.prototype));
  const keys = Reflect.ownKeys(value);
  need(keys.every(key => typeof key === 'string'));
  if (list) need(keys.length === value.length + 1 && keys.every(key => key === 'length' || /^(0|[1-9][0-9]*)$/.test(String(key)) && Number(key) < value.length));
  const result: unknown[] | Row = list ? [] : {};
  ancestors.add(value);
  for (const key of keys) {
    if (list && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    need('value' in descriptor && descriptor.enumerable);
    Object.defineProperty(result, key, { value: detached(descriptor.value, ancestors), enumerable: true });
  }
  ancestors.delete(value);
  return Object.freeze(result);
}
function boundedJson(value: unknown): void {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    need(++nodes <= 2048 && item.depth <= 8);
    if (typeof item.value === 'string') need(item.value.length <= 4096);
    if (item.value !== null && typeof item.value === 'object') {
      const entries = Object.entries(item.value);
      if (Array.isArray(item.value)) need(item.value.length <= 128);
      else need(entries.length <= 64 && entries.every(([key]) => key.length <= 128));
      pending.push(...entries.map(([, value]) => ({ value, depth: item.depth + 1 })));
    }
  }
}
// detached() has already validated every JSON value; only declared payload/value fields are open JSON.
const json: Check = () => {};
const scope: Check = value => {
  const kind = (value as Row)?.kind;
  object(value, { kind: one(kind), contextId: id, ...(kind === 'session' ? { sessionId: id, planId: nullable(id) } : kind === 'plan' ? { planId: id } : {}) });
  one('session', 'plan', 'context')(kind);
};
const selection = nullable(shape({ sessionId: id, occurrenceId: id }));
const reference = shape({ sourceId: text(), revision: text(), locator: text(), qualification: text() });
const source = (accountId: string): Check => shape({ accountId: one(accountId), kind: one('session', 'activity'), id, revision: revision(1), itemId: id });
const occurrence = shape({ id, itemId: id, exerciseId: id });
function witness(accountId: string, bounded = false): Check {
  return shape({ contextId: id, profileRevision: revision(), preferencesRevision: revision(), sessionSource: nullable(value => {
    const row = object(value, { source: source(accountId), sessionStatus: one('active', 'completed'),
      planSnapshot: shape({ planId: id, planRevision: revision(1) }), occurrence,
      sets: array(shape({ id, revision: revision(1), status: one('draft', 'confirmed', 'voided') }), 0, bounded ? 256 : Infinity) });
    need((row.source as Row).kind === 'session');
    const sets = row.sets as Row[]; need(new Set(sets.map(set => set.id)).size === sets.length);
  }), targetPlan: nullable(shape({ id, revision: revision(1), archived: bool })) });
}
function content(bounded = false): Check {
  const string = text(bounded ? 4096 : Infinity);
  const ref = bounded ? shape({ sourceId: string, revision: string, locator: string, qualification: string }) : reference;
  return shape({ scope, sourceRefs: array(ref, 1, bounded ? 64 : Infinity), qualifications: array(string, 1, bounded ? 32 : Infinity), payload: value => {
    const kind = (value as Row)?.kind;
    if (kind === 'edit') object(value, { kind: one('edit'), field: string, before: bounded ? boundedJson : json, after: bounded ? boundedJson : json });
    else object(value, { kind: one('feedback'), signals: array(signal => {
      const state = (signal as Row)?.state;
      object(signal, { dimension: one('rir', 'effort', 'discomfort', 'weakness', 'function', 'performance', 'sensation', 'soreness'),
        ...(state === 'reported' ? { state: one('reported'), value: (value: unknown) => { need(value !== null); if (bounded) boundedJson(value); }, unit: nullable(string), scale: nullable(string) }
          : { state: one('missing'), reason: one('not-asked', 'not-reported', 'unknown', 'declined') }) });
    }, 1, bounded ? 32 : Infinity) });
  } });
}
const status = one('active', 'withdrawn', 'deleted', 'undone');
const record = shape({ recordId: id, revision: revision(), status, confirmed: bool, content: nullable(content()) });
const binding = (accountId: string) => nullable(shape({ scope, selection, witness: witness(accountId) }));
const sourceSelection = shape({ kind: one('session', 'activity'), id, itemId: id });
const selections = shape({ baseline: sourceSelection, current: sourceSelection });
const declaration = shape({ id, contextId: id, selections });
const exercise: Check = value => {
  const kind = (value as Row)?.source;
  object(value, { source: one('global', 'personal'), id, ...(kind === 'personal' ? { revision: revision(1) } : {}) });
};
const identity = { id: nullable(id), revision: nullable(revision(1)), status: one('confirmed', 'withdrawn', 'missing'), current: bool };
const inputWitness = (accountId: string): Check => shape({ identity: shape({ ...identity, state: one('missing', 'withdrawn', 'stale', 'unqualified', 'qualified') }), scope: value => {
  const row = object(value, { source: source(accountId), exercise: nullable(exercise), session: nullable(shape({ planId: id, planRevision: revision(1), occurrence: nullable(occurrence) })) });
  need(((row.source as Row).kind === 'activity') === (row.session === null));
} });
const summary = shape({ confirmedSets: revision(), repetitions: revision(), volumeKgRepetitions: nullable(number),
  loads: array(shape({ setId: id, repetitions: revision(), kg: nullable(number) })) });
const reasons = one('source_missing', 'work_unconfirmed', 'no_confirmed_sets', 'identity_unknown', 'identity_stale', 'invalid_work',
  'repetitions_unknown', 'load_unknown', 'load_basis_unknown', 'mixed_load_meaning', 'account_mismatch', 'exercise_mismatch',
  'variant_mismatch', 'equipment_mismatch', 'laterality_mismatch', 'load_basis_mismatch', 'load_meaning_mismatch', 'same_observation', 'identity_provenance_mismatch');
const comparisonResult: Check = value => {
  const common = { policy: one('confirmed-work-comparison-v1'), evidenceToken: text() };
  if ((value as Row)?.status === 'comparable') object(value, { ...common, status: one('comparable'), baseline: summary, current: summary,
    delta: shape({ confirmedSets: number, repetitions: number, volumeKgRepetitions: nullable(number) }),
    units: shape({ load: one('kg'), volume: one('kg-repetitions') }), interpretation: one('observed_work_only') });
  else {
    const row = object(value, { ...common, status: one('unknown', 'incomparable'), reasons: array(reasons, 1) });
    if ((row.reasons as string[]).includes('identity_provenance_mismatch')) need(row.status === 'incomparable' && (row.reasons as string[]).length === 1);
  }
};
const producer = (accountId: string): Check => value => {
  if ((value as Row)?.status === 'unavailable') object(value, { status: one('unavailable'), reason: one('reader_unavailable', 'source_missing', 'item_missing'), side: one('baseline', 'current') });
  else object(value, { status: one('observed'), witness: shape({ accountId: one(accountId), contextId: id,
    witnessVersion: one('progress-comparison-witness-v2'), inputs: shape({ baseline: inputWitness(accountId), current: inputWitness(accountId) }),
    scope: shape({ baseline: source(accountId), current: source(accountId) }), bindings: array(shape(identity)),
    sourceRefs: array(reference), result: comparisonResult, evidenceToken: text(), interpretation: one('observed_work_only') }) });
};
const association: Check = value => {
  if ((value as Row)?.status === 'associated') object(value, { status: one('associated'), evidenceToken: text(), sourceRefs: array(reference) });
  else object(value, { status: one('unavailable'), reason: one('association_unproved') });
};
const dependency: Check = value => {
  if ((value as Row)?.kind === 'comparisonIdentity') object(value, { kind: one('comparisonIdentity'), sourceKind: one('session', 'activity'), sourceId: id, itemId: id });
  else object(value, { kind: one('context', 'session', 'activity', 'plan'), id });
};
const derived = (accountId: string): Check => shape({ id, version: text(), kind: one('history', 'summary', 'recommendation'), scope,
  status: one('ready', 'blocked'), value: json, blockedBy: array(text()),
  lineage: array(shape({ recordId: id, revision: revision(), status: one('active', 'withdrawn', 'deleted', 'undone', 'missing'), confirmed: bool,
    scope: nullable(scope), sourceRefs: array(reference), qualifications: array(text()) })),
  recipeLineage: array(shape({ id, version: text(), sourceRefs: array(reference), qualifications: array(text()) })),
  comparisonLineage: array(shape({ registryVersion: nullable(text()), registryDigest: text(), recipeId: id, recipeVersion: text(), inputId: id,
    declaration: nullable(declaration), producer: nullable(producer(accountId)), association: nullable(association), blockedBy: array(text()) })),
  comparisonDependencies: array(dependency) });
const view = (accountId: string): Check => shape({ ledgerRevision: revision(), projectionRevision: revision(), records: array(record),
  derivations: array(derived(accountId)), sources: array(shape({ recordId: id, state: one('current', 'changed', 'missing', 'unbound'), binding: binding(accountId) })) });
const receipt = shape({ eventId: id, recordId: id, cause: one('record', 'correct', 'confirm', 'withdraw', 'undo'), outcome: one('changed', 'unchanged', 'rejected'),
  revision: revision(), reason: nullable(text()), acceptedLedgerRevision: revision() });
const mutation = (accountId: string): Check => shape({ receipt, replayed: bool, current: view(accountId) });
const analysis = shape({ basis: one('current_profile_and_goals'), contextId: id, profileRevision: revision(), preferencesRevision: revision() });
function decode<T>(value: unknown, check: Check): AnalysisResult<T> {
  try { const owned = detached(value); object(owned, { analysis, result: check }); return owned as AnalysisResult<T>; }
  catch { throw new ApiError(502, 'training_feedback_invalid_response', 'The training feedback response could not be verified.'); }
}
function request<T>(value: unknown, check: Check): T {
  try {
    const owned = detached(value); check(owned);
    need(new TextEncoder().encode(JSON.stringify(owned)).length <= 64 * 1024);
    return owned as T;
  } catch { throw new ApiError(422, 'training_feedback_invalid_request', 'Check the training feedback fields.'); }
}
const eventRequest = (accountId: string): Check => shape({ expectedLedgerRevision: revision(), selection, expectedWitness: nullable(witness(accountId, true)), event: value => {
  const kind = (value as Row)?.kind;
  object(value, { eventId: id, recordId: id, expectedRevision: revision(), kind: one('record', 'correct', 'confirm', 'withdraw', 'undo'),
    ...(kind === 'record' || kind === 'correct' ? { content: content(true) } : kind === 'undo' ? { targetEventId: id } : {}) });
} });
export type TrainingFeedbackDependencies = Readonly<{
  api: Pick<FormTransport, 'request' | 'captureAuthContext'>;
  accountId: string;
  sessionGeneration: string;
  isCurrentSession(accountId: string, sessionGeneration: string): boolean;
}>;
export function createTrainingFeedbackCaller(dependencies: TrainingFeedbackDependencies) {
  const { api, accountId, sessionGeneration, isCurrentSession } = dependencies;
  const auth = api.captureAuthContext(); let disposed = false, expired = false;
  const current = () => {
    try { if (!accountId || !sessionGeneration || auth.isCurrent() !== true || isCurrentSession(accountId, sessionGeneration) !== true) expired = true; }
    catch { expired = true; }
    return !disposed && !expired;
  };
  const changed = (unknown = false) => new ApiError(409, 'session_changed', 'The original account session is no longer current.', unknown, unknown);
  async function read<T>(path: string, check: Check, body?: unknown): Promise<AnalysisResult<T>> {
    if (!current()) throw changed();
    try {
      const raw = await api.request(path, body === undefined ? 'GET' : 'POST', body);
      if (!current()) throw changed();
      const result = decode<T>(raw, check);
      if (!current()) throw changed();
      return result;
    } catch (error) { if (!current()) throw changed(); throw error; }
  }
  return Object.freeze({
    read: () => read<FeedbackCurrentView>('/v1/training-feedback', view(accountId)),
    witness(input: FeedbackWitnessRequest) {
      const body = request<FeedbackWitnessRequest>(input, shape({ scope, selection }));
      return read<FeedbackContextWitness>('/v1/training-feedback/witness', witness(accountId), body);
    },
    prepareEvent(input: TrainingFeedbackEventRequest, key: string) {
      if (!current()) throw changed();
      const body = request<TrainingFeedbackEventRequest>(input, eventRequest(accountId));
      if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key))
        throw new ApiError(422, 'training_feedback_invalid_request', 'A valid idempotency key is required.');
      let unknown = false, running = false;
      return Object.freeze({ async run(): Promise<AnalysisResult<FeedbackMutationResult>> {
        if (!current()) throw changed(unknown);
        if (running) throw new ApiError(409, 'training_feedback_attempt_pending', 'This attempt is already running.', unknown, unknown);
        running = true;
        try {
          const raw = await api.request('/v1/training-feedback/events', 'POST', body, key);
          if (!current()) { unknown = true; throw changed(true); }
          const result = decode<FeedbackMutationResult>(raw, mutation(accountId)), receipt = result.result.receipt;
          if (!current()) { unknown = true; throw changed(true); }
          if (receipt.eventId !== body.event.eventId || receipt.recordId !== body.event.recordId || receipt.cause !== body.event.kind)
            throw new ApiError(502, 'training_feedback_receipt_mismatch', 'The original event receipt could not be verified.');
          const conflict = receipt.reason !== null && ['idempotency-key-conflict', 'event-id-conflict', 'ledger-revision-conflict'].includes(receipt.reason);
          if (unknown && (conflict || receipt.outcome === 'rejected' && !result.result.replayed))
            throw new ApiError(409, 'training_feedback_original_unknown', 'This response does not resolve the original event.', true, true);
          unknown = false;
          return result;
        } catch (error) {
          if (!current()) { unknown = true; throw changed(true); }
          if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.effectUnknown || error.originalEffectUnknown) unknown = true;
          if (error instanceof ApiError) throw new ApiError(error.status, error.code, error.message, unknown || error.effectUnknown, unknown || error.originalEffectUnknown);
          throw new ApiError(0, 'training_feedback_unavailable', 'The event result could not be confirmed.', true, true);
        } finally { running = false; }
      } });
    },
    dispose() { disposed = true; },
  });
}
