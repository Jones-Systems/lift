import { createHash } from 'node:crypto';
import { CatalogQualificationError, fields, freeze, requireValue } from './validation.js';

const inventoryRoot = 'sources/businesslessons/core/research/form-knowledge-campaign-2026-10-01/inventory';
export const RETAINED_CATALOG_SOURCE = freeze({
  repository: 'Jones-Systems/BusinessLessons',
  revision: '7636efca55195b1dc6a5980864452575478116b7',
  manifestSha256: 'bb87a03258981f3b85612ebd8b9a61b8933220e59cfd29ddb58ed349b3814dc7',
  legacyRepository: 'Jones-Systems/movement-engine',
  legacyRevision: '442c5cd07f14142326af10fe0eb6d079b0e62a71',
  legacyPath: 'data/catalog/exercises.v2.json',
  legacySha256: '4bc95300958e769555128e0e44fd210d0e773659ef2fd00e4d5748f1a32026d5',
} as const);

export const RETAINED_CATALOG_INPUTS = freeze({
  legacy: { path: `${inventoryRoot}/legacy-movement-engine.json`, bytes: 229763, sha256: 'fc45be4e7129c39ef46d130a92d6bcf995d2dad64951b40c72fa125ca1561e4b', gitBlob: 'f19d54022e173891e53e162fd391a07de2ba6d67' },
  firstCatalog: { path: `${inventoryRoot}/free-exercise-db-metadata.json`, bytes: 348955, sha256: 'e94c15445c2c2a2bd1468a6a13c024cb8dc5157b097abd77e1d4d2eaa1da0e07', gitBlob: '6d80e5590a3b2a2795e5457f07dd8bfaf79eec03' },
  crosswalk: { path: `${inventoryRoot}/legacy-catalog-crosswalk-candidates.json`, bytes: 60927, sha256: 'fb0b9a22f06c53c955fff8512b24108a6a70fb7c7b54ba822f8e659aafadc7f1', gitBlob: '03c146ceadc6dea30e892b6613972308d2c7653f' },
  secondCatalog: { path: `${inventoryRoot}/second-catalog-name-candidates.json`, bytes: 21668, sha256: 'e40f33e6995e8c7f79534ab00e972195788243a72f95d6519aa21d900e7d26ae', gitBlob: '0e0b3ca5741af49b60872937ff726b81ccd7aa7f' },
} as const);

export type RetainedCatalogInputs = { readonly [K in keyof typeof RETAINED_CATALOG_INPUTS]: Uint8Array };
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type SourceRecord = { readonly [key: string]: Json };
export type LegacyRecord = {
  readonly id: string;
  readonly name: string;
  readonly body_regions: readonly string[];
  readonly movement_patterns: readonly string[];
  readonly equipment: { readonly required: readonly string[]; readonly alternatives: readonly (readonly string[])[] };
  readonly cues: readonly string[];
  readonly provenance: { readonly migration: string; readonly sources: readonly string[] };
  readonly aging_athlete_notes: string;
  readonly contraindications?: readonly string[];
  readonly safety_flags?: readonly string[];
  readonly regressions?: readonly string[];
  readonly progressions?: readonly string[];
};

export type LegacyExtraction = {
  schema: 'form.legacy-exercise-extraction/v1'; authority_effect: 'none';
  source_path: string; source_revision: string; source_sha256: string;
  exercise_dispositions: { legacy_id: string; legacy_record: LegacyRecord; mapping_status: string; name: string; research_roles: string }[];
  cue_slots: { cue_id: string; legacy_exercise_id: string; ordinal: number; wording: string; human_source: null; rights_status: string; clinical_readiness: 'CL-0'; wording_origin: string; source_paths: LegacyRecord['provenance'] }[];
};
export type FirstCatalog = {
  schema: string; source_commit: string; source_sha256: string; source_url: string;
  authority_effect: 'none'; rights_status: string; status: string;
  biological_roles: string; access_date_utc: string; excluded_fields: string[];
  entries: (SourceRecord & { id: string; name: string; source_record_locator: string })[];
};
export type Crosswalk = {
  schema: string; authority_effect: 'none'; clinical_readiness: 'CL-0';
  repository_revision_observed: string;
  bindings: { legacy: SourceRecord; catalog: SourceRecord };
  interpretation: SourceRecord; alias_normalization_proposals: SourceRecord[];
  region_tag_crosswalk_candidates: SourceRecord[];
  rows: {
    observed: { id: string; name: string; movement_patterns: readonly string[]; body_regions: readonly string[] };
    family: string; axes: SourceRecord;
    candidates: { id: string; basis: 'lexical' | 'semantic'; unresolved: string }[];
    excluded: { id: string; reason: string }[]; gap: string | null;
  }[];
};
export type SecondCandidate = SourceRecord & {
  name: string; source: string; legacy_ids: string[]; rights_binding: string;
  basis: 'lexical' | 'semantic'; disposition: string; unknown: string; url: string;
  exercise_id?: number; translation_id?: number; language_id?: number;
  snapshot_binding?: string;
};
export type SecondCatalog = {
  schema: string; authority_effect: 'none'; clinical_readiness: 'CL-0';
  scope: string; status: string; descriptions_retained: false; instructions_retained: false;
  images_fetched: false; videos_fetched: false; live_api_files_retained: false;
  automatic_merging: false; canonical_ids_created: false; complete_universe_claim: false;
  limitations: string[]; wger_schema: SourceRecord; english_language_binding: SourceRecord;
  targeted_query_batch: SourceRecord; rights_bindings: Record<string, SourceRecord>;
  page_snapshots: Record<string, SourceRecord>; candidates: SecondCandidate[];
  additional_exclusions_and_unresolved_gaps: SourceRecord[]; failed_routes: SourceRecord[];
};

export function readRetained(inputs: RetainedCatalogInputs) {
  const keys = Object.keys(RETAINED_CATALOG_INPUTS) as (keyof RetainedCatalogInputs)[];
  const input = fields(inputs, keys, 'invalid_artifact');
  const documents: Record<string, unknown> = {};
  for (const key of keys) {
    const pin = RETAINED_CATALOG_INPUTS[key];
    const value = input[key];
    requireValue(value instanceof Uint8Array && value.byteLength === pin.bytes, 'invalid_artifact', `${key}: invalid bytes`);
    const owned = new Uint8Array(value);
    // Pins authenticate retained bytes; caller metadata cannot authorize a replacement corpus.
    requireValue(createHash('sha256').update(owned).digest('hex') === pin.sha256, 'invalid_artifact', `${key}: digest mismatch`);
    try { documents[key] = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(owned)); }
    catch { throw new CatalogQualificationError('invalid_artifact', `${key}: invalid JSON encoding`); }
  }
  const legacy = documents.legacy as LegacyExtraction;
  const first = documents.firstCatalog as FirstCatalog;
  const crosswalk = documents.crosswalk as Crosswalk;
  const second = documents.secondCatalog as SecondCatalog;
  fields(legacy, ['schema', 'authority_effect', 'source_path', 'source_revision', 'source_sha256', 'exercise_dispositions', 'cue_slots'], 'invalid_artifact');
  fields(first, ['schema', 'authority_effect', 'access_date_utc', 'biological_roles', 'entries', 'excluded_fields', 'rights_status', 'source_commit', 'source_sha256', 'source_url', 'status'], 'invalid_artifact');
  fields(crosswalk, ['schema', 'authority_effect', 'clinical_readiness', 'repository_revision_observed', 'bindings', 'interpretation', 'alias_normalization_proposals', 'region_tag_crosswalk_candidates', 'rows'], 'invalid_artifact');
  fields(second, ['schema', 'authority_effect', 'clinical_readiness', 'scope', 'status', 'descriptions_retained', 'instructions_retained', 'images_fetched', 'videos_fetched', 'live_api_files_retained', 'automatic_merging', 'canonical_ids_created', 'complete_universe_claim', 'limitations', 'wger_schema', 'english_language_binding', 'targeted_query_batch', 'rights_bindings', 'page_snapshots', 'candidates', 'additional_exclusions_and_unresolved_gaps', 'failed_routes'], 'invalid_artifact');
  requireValue(legacy.schema === 'form.legacy-exercise-extraction/v1' && legacy.source_revision === RETAINED_CATALOG_SOURCE.legacyRevision && legacy.source_sha256 === RETAINED_CATALOG_SOURCE.legacySha256 && legacy.source_path === RETAINED_CATALOG_SOURCE.legacyPath, 'invalid_artifact', 'legacy source mismatch');
  requireValue(legacy.exercise_dispositions.length === 59 && legacy.cue_slots.length === 177 && first.entries.length === 876 && crosswalk.rows.length === 59 && second.candidates.length === 15, 'invalid_artifact', 'retained counts mismatch');
  requireValue(crosswalk.bindings.legacy.metadata_sha256 === RETAINED_CATALOG_INPUTS.legacy.sha256 && crosswalk.bindings.catalog.metadata_sha256 === RETAINED_CATALOG_INPUTS.firstCatalog.sha256 && crosswalk.bindings.catalog.source_commit === first.source_commit && crosswalk.bindings.catalog.source_sha256 === first.source_sha256, 'invalid_artifact', 'crosswalk binding mismatch');
  return freeze({ legacy, first, crosswalk, second });
}
