import { createHash } from 'node:crypto';
import { RETAINED_CATALOG_INPUTS, type LegacyRecord } from './retained.js';
import { CatalogQualificationError, dataArray, fields, freeze, requireValue, textValue } from './validation.js';

export const NATIVE_MOVEMENT_CATALOG = freeze({
  repository: 'Jones-Systems/movement-engine',
  revision: '442c5cd07f14142326af10fe0eb6d079b0e62a71',
  path: 'data/catalog/exercises.v2.json',
  sha256: '4bc95300958e769555128e0e44fd210d0e773659ef2fd00e4d5748f1a32026d5',
  bytes: 72737,
  schemaVersion: 2,
} as const);

export type NativeRecordIdentity = Readonly<{
  repository: string; revision: string; path: string; sha256: string; nativeId: string;
}>;
export type NativeVariant = Readonly<{
  identity: NativeRecordIdentity;
  variantId: string;
  name: string;
  equipment: LegacyRecord['equipment'];
  qualification: 'source_native_operational_identity';
  axes: 'not_defined';
  demands: 'not_supplied';
  prescriptions: 'not_supplied';
  clinicalQualification: 'not_assessed';
  cueRights: 'unresolved';
}>;
export type ActiveDomainExercise = Readonly<{
  exerciseId: string;
  retired: boolean;
  sourceIdentity: NativeRecordIdentity | null;
  catalogRevision: string;
  currentness: 'current' | 'unknown' | 'superseded' | 'withdrawn';
}>;
export type NativeIdentityBindingRequest = Readonly<{
  nativeId: string; exerciseId: string; active: ActiveDomainExercise | null;
}>;
export type NativeIdentityUnavailableReason =
  'unknown_id' | 'domain_absent' | 'id_mismatch' | 'retired' | 'provenance_mismatch' | 'source_not_current';
export type NativeIdentityBinding =
  | Readonly<{
    status: 'bound'; exerciseId: string; variantId: string; identity: NativeRecordIdentity;
    catalogRevision: string; qualificationScope: 'operational_identity_only';
  }>
  | Readonly<{
    status: 'unavailable'; nativeId: string; exerciseId: string;
    reasons: readonly NativeIdentityUnavailableReason[];
  }>;
export type NativeMovementCatalog = Readonly<{
  source: typeof NATIVE_MOVEMENT_CATALOG;
  variants: readonly NativeVariant[];
  get(nativeId: string): NativeVariant | null;
  bindActiveDomainExercise(request: NativeIdentityBindingRequest): NativeIdentityBinding;
}>;

const identityKeys = ['repository', 'revision', 'path', 'sha256', 'nativeId'] as const;
const requiredRecordKeys = ['id', 'name', 'movement_patterns', 'body_regions', 'equipment', 'provenance'];
const optionalListKeys = ['cues', 'regressions', 'progressions', 'contraindications', 'safety_flags'] as const;

function pinnedJson(bytes: Uint8Array, pin: { bytes: number; sha256: string }): unknown {
  requireValue(bytes instanceof Uint8Array && bytes.byteLength === pin.bytes, 'invalid_artifact', 'catalog byte length mismatch');
  const owned = new Uint8Array(bytes);
  requireValue(createHash('sha256').update(owned).digest('hex') === pin.sha256, 'invalid_artifact', 'catalog digest mismatch');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(owned)); }
  catch { throw new CatalogQualificationError('invalid_artifact', 'invalid catalog JSON encoding'); }
}

function sourceText(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.trim().length > 0, 'invalid_artifact', 'expected source text');
}

function sourceList(value: unknown, emptyAllowed: boolean): string[] {
  const result = dataArray(value, 'invalid_artifact', 1000);
  requireValue(emptyAllowed || result.length > 0, 'invalid_artifact', 'empty source list');
  for (const item of result) sourceText(item);
  return result as string[];
}

function originalRecord(value: unknown): LegacyRecord {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_artifact', 'expected native record');
  const optional = [...optionalListKeys, 'aging_athlete_notes'].filter(key => Object.hasOwn(value, key));
  const row = fields(value, [...requiredRecordKeys, ...optional], 'invalid_artifact');
  sourceText(row.id);
  requireValue(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.id), 'invalid_artifact', 'invalid native record ID');
  sourceText(row.name);
  sourceList(row.movement_patterns, false);
  sourceList(row.body_regions, false);
  for (const key of optionalListKeys) if (Object.hasOwn(row, key)) sourceList(row[key], false);
  if (Object.hasOwn(row, 'aging_athlete_notes')) sourceText(row.aging_athlete_notes);
  const equipment = fields(row.equipment, ['required', 'alternatives'], 'invalid_artifact');
  const required = sourceList(equipment.required, true);
  const alternatives = dataArray(equipment.alternatives, 'invalid_artifact', 1000).map(group => sourceList(group, false));
  const groupKeys = alternatives.map(group => JSON.stringify([...group].sort()));
  requireValue(new Set(required).size === required.length && alternatives.every(group => group.length >= 2 && new Set(group).size === group.length), 'invalid_artifact', 'invalid equipment requirement group');
  requireValue(new Set(groupKeys).size === groupKeys.length && !alternatives.flat().some(item => required.includes(item)), 'invalid_artifact', 'overlapping equipment requirements');
  requireValue(required.length > 0 || alternatives.length > 0, 'invalid_artifact', 'empty equipment requirements');
  const provenance = fields(row.provenance, ['sources', 'migration'], 'invalid_artifact');
  const paths = sourceList(provenance.sources, false);
  requireValue(paths.every(path => /^(?:lanes|synthesis|reviews)(?:\/[A-Za-z0-9._-]+)+\.md$/u.test(path)), 'invalid_artifact', 'invalid native provenance path');
  sourceText(provenance.migration);
  return value as LegacyRecord;
}

function domainId(value: unknown): string {
  const id = textValue(value, 'invalid_request');
  requireValue(id.length <= 80 && /^[a-zA-Z0-9_-]+$/u.test(id), 'invalid_request', 'invalid Domain resource ID');
  return id;
}

function identityInput(value: unknown): NativeRecordIdentity {
  const row = fields(value, identityKeys, 'invalid_request');
  return {
    repository: textValue(row.repository, 'invalid_request'), revision: textValue(row.revision, 'invalid_request'),
    path: textValue(row.path, 'invalid_request'), sha256: textValue(row.sha256, 'invalid_request'),
    nativeId: domainId(row.nativeId),
  };
}

function bindingInput(input: NativeIdentityBindingRequest): NativeIdentityBindingRequest {
  const request = fields(input, ['nativeId', 'exerciseId', 'active'], 'invalid_request');
  const nativeId = domainId(request.nativeId), exerciseId = domainId(request.exerciseId);
  if (request.active === null) return { nativeId, exerciseId, active: null };
  const row = fields(request.active, ['exerciseId', 'retired', 'sourceIdentity', 'catalogRevision', 'currentness'], 'invalid_request');
  requireValue(typeof row.retired === 'boolean', 'invalid_request', 'invalid retirement state');
  requireValue(row.currentness === 'current' || row.currentness === 'unknown' || row.currentness === 'superseded' || row.currentness === 'withdrawn', 'invalid_request', 'invalid source currentness');
  return { nativeId, exerciseId, active: {
    exerciseId: domainId(row.exerciseId), retired: row.retired,
    sourceIdentity: row.sourceIdentity === null ? null : identityInput(row.sourceIdentity),
    catalogRevision: textValue(row.catalogRevision, 'invalid_request'), currentness: row.currentness,
  } };
}

export function createNativeMovementCatalog(bytes: Uint8Array): NativeMovementCatalog {
  const root = fields(pinnedJson(bytes, NATIVE_MOVEMENT_CATALOG), ['exercises', 'schema_version'], 'invalid_artifact');
  requireValue(root.schema_version === NATIVE_MOVEMENT_CATALOG.schemaVersion, 'invalid_artifact', 'native schema version mismatch');
  const records = dataArray(root.exercises, 'invalid_artifact', 59).map(originalRecord);
  const recordIndex = new Map(records.map(record => [record.id, record]));
  requireValue(records.length === 59 && recordIndex.size === 59, 'invalid_artifact', 'native record count or identity mismatch');
  for (const record of records) {
    for (const reference of [...(record.regressions ?? []), ...(record.progressions ?? [])]) {
      requireValue(reference !== record.id && recordIndex.has(reference), 'invalid_artifact', 'invalid native record relationship');
    }
  }
  for (const record of records) {
    const pending = [...(record.regressions ?? [])], visited = new Set<string>();
    while (pending.length) {
      const reference = pending.pop()!;
      requireValue(reference !== record.id, 'invalid_artifact', 'cyclic native regression');
      if (!visited.has(reference)) {
        visited.add(reference);
        pending.push(...(recordIndex.get(reference)!.regressions ?? []));
      }
    }
  }
  const variants: NativeVariant[] = records.map(record => ({
    identity: {
      repository: NATIVE_MOVEMENT_CATALOG.repository, revision: NATIVE_MOVEMENT_CATALOG.revision,
      path: NATIVE_MOVEMENT_CATALOG.path, sha256: NATIVE_MOVEMENT_CATALOG.sha256, nativeId: record.id,
    },
    variantId: `movement-engine:${NATIVE_MOVEMENT_CATALOG.revision}:${record.id}`,
    name: record.name, equipment: record.equipment, qualification: 'source_native_operational_identity',
    axes: 'not_defined', demands: 'not_supplied', prescriptions: 'not_supplied',
    clinicalQualification: 'not_assessed', cueRights: 'unresolved',
  }));
  const index = new Map(variants.map(variant => [variant.identity.nativeId, variant]));
  return freeze({
    source: NATIVE_MOVEMENT_CATALOG, variants,
    get(nativeId: string) { return index.get(textValue(nativeId, 'invalid_request')) ?? null; },
    // WS01 supplies this projection from its current persisted catalog; a client assertion is not an active association.
    bindActiveDomainExercise(input: NativeIdentityBindingRequest): NativeIdentityBinding {
      const { nativeId, exerciseId, active } = bindingInput(input);
      const variant = index.get(nativeId);
      const reasons: NativeIdentityUnavailableReason[] = [];
      if (!variant) reasons.push('unknown_id');
      if (nativeId !== exerciseId || (active && active.exerciseId !== exerciseId)) reasons.push('id_mismatch');
      if (!active) reasons.push('domain_absent');
      else {
        if (active.retired) reasons.push('retired');
        if (active.currentness !== 'current') reasons.push('source_not_current');
        if (!active.sourceIdentity || (variant && !identityKeys.every(key => active.sourceIdentity![key] === variant.identity[key]))) reasons.push('provenance_mismatch');
      }
      if (reasons.length) return freeze({ status: 'unavailable', nativeId, exerciseId, reasons });
      return freeze({ status: 'bound', exerciseId, variantId: variant!.variantId, identity: variant!.identity,
        catalogRevision: active!.catalogRevision, qualificationScope: 'operational_identity_only' });
    },
  });
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, sortedJson(child)]));
  }
  return value;
}

export function createNativeMovementCatalogFromRetained(bytes: Uint8Array): NativeMovementCatalog {
  const root = fields(pinnedJson(bytes, RETAINED_CATALOG_INPUTS.legacy), ['schema', 'authority_effect', 'source_path', 'source_revision', 'source_sha256', 'exercise_dispositions', 'cue_slots'], 'invalid_artifact');
  requireValue(root.schema === 'form.legacy-exercise-extraction/v1' && root.authority_effect === 'none' && root.source_path === NATIVE_MOVEMENT_CATALOG.path && root.source_revision === NATIVE_MOVEMENT_CATALOG.revision && root.source_sha256 === NATIVE_MOVEMENT_CATALOG.sha256, 'invalid_artifact', 'retained native source mismatch');
  const records = dataArray(root.exercise_dispositions, 'invalid_artifact', 59).map(value => {
    const row = fields(value, ['legacy_id', 'legacy_record', 'mapping_status', 'name', 'research_roles'], 'invalid_artifact');
    const record = originalRecord(row.legacy_record);
    requireValue(row.legacy_id === record.id && row.name === record.name, 'invalid_artifact', 'retained native identity mismatch');
    return record;
  });
  // The original migrator sorts object keys but retains exercise order; only an exact original-file digest permits reconstruction.
  const original = `${JSON.stringify(sortedJson({ exercises: records, schema_version: 2 }), null, 2)}\n`;
  return createNativeMovementCatalog(new TextEncoder().encode(original));
}
