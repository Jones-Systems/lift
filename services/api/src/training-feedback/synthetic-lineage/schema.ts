import { fail, requireThat, type Json } from './strict-json.js';
export type Check = (value: Json) => void;
export type Row = { [key: string]: Json };
export function row(value: Json): Row {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'wrong_type'); return value;
}
export const one = (...values: readonly Json[]): Check => value => requireThat(values.includes(value), 'unsupported_version');
export const text = (max = 4000, min = 1): Check => value => requireThat(typeof value === 'string' && value.length >= min &&
  value.length <= max && (min === 0 || value.trim().length > 0), typeof value === 'string' ? 'invalid_string' : 'wrong_type');
export const exact: Check = value => { text(512)(value); requireThat(typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value), 'invalid_string'); };
export const id = text(160);
export const syn: Check = value => requireThat(typeof value === 'string' && /^syn_[A-Za-z0-9_-]{1,76}$/.test(value), 'invalid_string');
export const digest: Check = value => requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'invalid_string');
export const bool: Check = value => requireThat(typeof value === 'boolean', 'wrong_type');
export const numeric = (min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, integer = true): Check => value =>
  requireThat(typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && value >= min && value <= max &&
    (!integer || Number.isSafeInteger(value)), 'invalid_number');
export const natural = numeric(0);
export const nullable = (check: Check): Check => value => { if (value !== null) check(value); };
export const list = (check: Check, min = 0, max = 256): Check => value => {
  requireThat(Array.isArray(value), 'wrong_type'); requireThat(value.length >= min && value.length <= max, 'bounds_exceeded'); value.forEach(check);
};
export function object(value: Json, fields: Readonly<Record<string, Check>>, optional: Readonly<Record<string, Check>> = {}): Row {
  const data = row(value);
  for (const key of Object.keys(data)) requireThat(Object.hasOwn(fields, key) || Object.hasOwn(optional, key), 'unknown_field');
  for (const key of Object.keys(fields)) { requireThat(Object.hasOwn(data, key), 'missing_field'); fields[key]!(data[key]!); }
  for (const key of Object.keys(optional)) if (Object.hasOwn(data, key)) optional[key]!(data[key]!);
  return data;
}
export const shape = (fields: Readonly<Record<string, Check>>, optional: Readonly<Record<string, Check>> = {}): Check => value => { object(value, fields, optional); };
export const revision = (domain: string, min = 0): Check => shape({ domain: one(domain), value: numeric(min) });
export const sourceRef = shape({ sourceId: exact, revision: exact, locator: exact, qualification: exact });
export const syntheticRef = shape({ sourceId: syn, revision: exact, locator: exact, qualification: exact });
export function unique(values: readonly unknown[]): void { requireThat(new Set(values).size === values.length, 'duplicate_identity'); }
const json: Check = value => {
  if (typeof value === 'number') naturalOrSigned(value);
  else if (Array.isArray(value)) value.forEach(json);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(json);
};
const naturalOrSigned = numeric();
export const feedbackScope: Check = value => {
  const kind = row(value).kind;
  object(value, { kind: one('context', 'plan', 'session'), contextId: id,
    ...(kind === 'plan' ? { planId: id } : kind === 'session' ? { sessionId: id, planId: nullable(id) } : {}) });
};
const selection = nullable(shape({ sessionId: id, occurrenceId: id }));
const source = shape({ accountId: id, kind: one('session', 'activity'), id, revision: numeric(1), itemId: id });
const occurrence = shape({ id, itemId: id, exerciseId: id });
const contextWitness = shape({ contextId: id, profileRevision: natural, preferencesRevision: natural,
  sessionSource: nullable(value => {
    const r = object(value, { source, sessionStatus: one('active', 'completed'), planSnapshot: shape({ planId: id, planRevision: numeric(1) }),
      occurrence, sets: list(shape({ id, revision: numeric(1), status: one('draft', 'confirmed', 'voided') })) });
    requireThat(row(r.source!).kind === 'session'); unique((r.sets as Row[]).map(s => s.id));
  }), targetPlan: nullable(shape({ id, revision: numeric(1), archived: bool })) });
const binding = nullable(shape({ scope: feedbackScope, selection, witness: contextWitness }));
const signal: Check = value => {
  const state = row(value).state;
  object(value, { dimension: one('rir', 'effort', 'discomfort', 'weakness', 'function', 'performance', 'sensation', 'soreness'),
    ...(state === 'reported' ? { state: one('reported'), value: (v: Json) => { requireThat(v !== null, 'wrong_type'); json(v); }, unit: nullable(text()), scale: nullable(text()) }
      : { state: one('missing'), reason: one('not-asked', 'not-reported', 'unknown', 'declined') }) });
};
const content = shape({ scope: feedbackScope, sourceRefs: list(sourceRef, 1), qualifications: list(text(), 1), payload: value => {
  if (row(value).kind === 'edit') object(value, { kind: one('edit'), field: text(), before: json, after: json });
  else object(value, { kind: one('feedback'), signals: list(signal, 1) });
} });
const recordStatus = one('active', 'withdrawn', 'deleted', 'undone');
const record = shape({ recordId: id, revision: natural, status: recordStatus, confirmed: bool, content: nullable(content) });
const sourceSelection = shape({ kind: one('session', 'activity'), id, itemId: id });
const declaration = shape({ id, contextId: id, selections: shape({ baseline: sourceSelection, current: sourceSelection }) });
const exercise: Check = value => {
  object(value, { source: one('global', 'personal'), id, ...(row(value).source === 'personal' ? { revision: numeric(1) } : {}) });
};
const identity = { id: nullable(id), revision: nullable(numeric(1)), status: one('confirmed', 'withdrawn', 'missing'), current: bool };
const inputWitness = shape({ identity: shape({ ...identity, state: one('missing', 'withdrawn', 'stale', 'unqualified', 'qualified') }), scope: value => {
  const r = object(value, { source, exercise: nullable(exercise), session: nullable(shape({ planId: id, planRevision: numeric(1), occurrence: nullable(occurrence) })) });
  requireThat((row(r.source!).kind === 'activity') === (r.session === null));
} });
const fraction = numeric(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false);
const positiveFraction = numeric(0, Number.MAX_SAFE_INTEGER, false);
const summary = shape({ confirmedSets: natural, repetitions: natural, volumeKgRepetitions: nullable(positiveFraction),
  loads: list(shape({ setId: id, repetitions: natural, kg: nullable(positiveFraction) })) });
const reasons = one('source_missing', 'work_unconfirmed', 'no_confirmed_sets', 'identity_unknown', 'identity_stale', 'invalid_work',
  'repetitions_unknown', 'load_unknown', 'load_basis_unknown', 'mixed_load_meaning', 'account_mismatch', 'exercise_mismatch',
  'variant_mismatch', 'equipment_mismatch', 'laterality_mismatch', 'load_basis_mismatch', 'load_meaning_mismatch', 'same_observation', 'identity_provenance_mismatch');
const comparisonResult: Check = value => {
  const common = { policy: one('confirmed-work-comparison-v1'), evidenceToken: text() };
  if (row(value).status === 'comparable') object(value, { ...common, status: one('comparable'), baseline: summary, current: summary,
    delta: shape({ confirmedSets: numeric(), repetitions: numeric(), volumeKgRepetitions: nullable(fraction) }),
    units: shape({ load: one('kg'), volume: one('kg-repetitions') }), interpretation: one('observed_work_only') });
  else {
    const r = object(value, { ...common, status: one('unknown', 'incomparable'), reasons: list(reasons, 1) });
    if ((r.reasons as Json[]).includes('identity_provenance_mismatch')) requireThat(r.status === 'incomparable' && (r.reasons as Json[]).length === 1);
  }
};
export const witness: Check = value => {
  const r = object(value, { accountId: id, contextId: id, witnessVersion: one('progress-comparison-witness-v2'),
    inputs: shape({ baseline: inputWitness, current: inputWitness }), scope: shape({ baseline: source, current: source }),
    bindings: list(shape(identity)), sourceRefs: list(sourceRef), result: comparisonResult, evidenceToken: text(), interpretation: one('observed_work_only') });
  const inputs = row(r.inputs!), scopes = row(r.scope!);
  for (const side of ['baseline', 'current']) {
    requireThat(row(scopes[side]!).accountId === r.accountId);
    requireThat(row(row(inputs[side]!).scope!).source !== null);
    requireThat(row(row(row(inputs[side]!).scope!).source!).accountId === r.accountId);
  }
};
const producer: Check = value => {
  if (row(value).status === 'unavailable') object(value, { status: one('unavailable'), reason: one('reader_unavailable', 'source_missing', 'item_missing'), side: one('baseline', 'current') });
  else object(value, { status: one('observed'), witness });
};
const association: Check = value => {
  if (row(value).status === 'associated') object(value, { status: one('associated'), evidenceToken: text(), sourceRefs: list(sourceRef) });
  else object(value, { status: one('unavailable'), reason: one('association_unproved') });
};
export const comparisonLineage = shape({ registryVersion: nullable(text()), registryDigest: text(), recipeId: id, recipeVersion: text(), inputId: id,
  declaration: nullable(declaration), producer: nullable(producer), association: nullable(association), blockedBy: list(text()) });
const dependency: Check = value => {
  if (row(value).kind === 'comparisonIdentity') object(value, { kind: one('comparisonIdentity'), sourceKind: one('session', 'activity'), sourceId: id, itemId: id });
  else object(value, { kind: one('context', 'session', 'activity', 'plan'), id });
};
const derived = shape({ id, version: text(), kind: one('history', 'summary', 'recommendation'), scope: feedbackScope, status: one('ready', 'blocked'), value: json,
  blockedBy: list(text()), lineage: list(shape({ recordId: id, revision: natural, status: one('active', 'withdrawn', 'deleted', 'undone', 'missing'), confirmed: bool,
    scope: nullable(feedbackScope), sourceRefs: list(sourceRef), qualifications: list(text()) })),
  recipeLineage: list(shape({ id, version: text(), sourceRefs: list(sourceRef), qualifications: list(text()) })),
  comparisonLineage: list(comparisonLineage), comparisonDependencies: list(dependency) });
export const analysisRead = shape({ analysis: shape({ basis: one('current_profile_and_goals'), contextId: id, profileRevision: natural, preferencesRevision: natural }),
  result: shape({ ledgerRevision: natural, projectionRevision: natural, records: list(record), derivations: list(derived, 0, 64),
    sources: list(shape({ recordId: id, state: one('current', 'changed', 'missing', 'unbound'), binding })) }) });
export const implementation = shape({ repository: one('Jones-Systems/lift', 'Jones-Systems/Form'), revision: exact, path: exact, sha256: digest });
export const recipe = shape({ schema: one('form.synthetic-recipe-manifest/v1'), recipeId: syn, semanticVersion: exact,
  executable: shape({ repository: exact, revision: exact, path: exact, sha256: digest }), implementationManifestDigest: digest,
  constants: shape({ fixtureId: syn, digest, justification: one('synthetic-nonprescriptive') }), registrationEvidenceId: syn,
  rootDerivationId: syn, nodes: list(shape({ id: syn, semanticVersion: exact, kind: one('history', 'summary', 'recommendation'),
    parentIds: list(syn, 0, 64), sourceRecordIds: list(syn), sourceRefs: list(syntheticRef, 1), qualifications: list(exact) }), 1, 64) });
export const dispositions = shape({ schema: one('synthetic.accepted-input-dispositions/v1'), rows: list(shape({ inputId: syn, sourceRef: syntheticRef,
  disposition: one('keep', 'refresh', 'retire'), applicabilityRevision: revision('input-applicability'), qualified: bool,
  dependencyKey: shape({ kind: one('input-disposition'), ownerId: syn, id: syn }) }), 1) });
export const embeddedChecks = Object.freeze({
  'synthetic.training-feedback-analysis.pinned-v1': analysisRead,
  'synthetic.feedback-comparison-lineage.pinned-v1': comparisonLineage,
  'synthetic.comparison-witness.pinned-v2': witness,
  'synthetic.registration-manifest/v1': recipe,
  'synthetic.accepted-input-dispositions/v1': dispositions,
});
