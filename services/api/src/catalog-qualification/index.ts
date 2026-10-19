import { createHash } from 'node:crypto';
import {
  readRetained, RETAINED_CATALOG_INPUTS, RETAINED_CATALOG_SOURCE,
  type RetainedCatalogInputs, type LegacyRecord, type SourceRecord,
} from './retained.js';
import { fields, freeze, identifiers, requireValue, textValue } from './validation.js';

export { RETAINED_CATALOG_INPUTS, RETAINED_CATALOG_SOURCE } from './retained.js';
export type { RetainedCatalogInputs, LegacyRecord, SourceRecord } from './retained.js';
export { CatalogQualificationError } from './validation.js';
export { projectNativeEquipmentRequirements } from './native-equipment.js';
export {
  NATIVE_MOVEMENT_CATALOG, createNativeMovementCatalog, createNativeMovementCatalogFromRetained,
} from './native-identity.js';
export type {
  NativeRecordIdentity, NativeVariant, ActiveDomainExercise, NativeIdentityBindingRequest,
  NativeIdentityUnavailableReason, NativeIdentityBinding, NativeMovementCatalog,
} from './native-identity.js';
export { createRegisteredNativeCatalogFactory } from './registered-identity.js';
export type {
  RegistrationRef, RegistrationPin, RegisteredNativeExercise, NativeDomainRegistrationV1,
  RegisteredDomainProjection, RegisteredBindingRequest, RegisteredBindingUnavailableReason,
  RegisteredBinding, RegisteredNativeCatalog, RegisteredNativeCatalogInput,
} from './registered-identity.js';

export type CatalogLocator = {
  readonly repository: string; readonly revision: string;
  readonly path: string; readonly sha256: string; readonly pointer: string;
};
export type CueQualification = {
  readonly id: string; readonly legacyExerciseId: string; readonly ordinal: number;
  readonly source: CatalogLocator; readonly wordingSha256: string;
  readonly wordingOrigin: 'legacy_unattributed'; readonly humanSource: null;
  readonly rightsStatus: 'unreviewed_legacy_provenance'; readonly clinicalReadiness: 'CL-0';
  readonly classification: 'unclassified'; readonly display: 'withheld'; readonly mutable: false;
  readonly gaps: readonly string[];
};
export type CatalogCandidate = {
  readonly catalog: 'free-exercise-db' | 'wger' | 'institutional-name-index';
  readonly source: CatalogLocator; readonly nativeId: string | number | null;
  readonly name: string; readonly basis: 'lexical' | 'semantic';
  readonly identityConfirmed: false; readonly reuse: 'not_cleared';
  readonly sourceMetadata: SourceRecord; readonly rights: SourceRecord;
  readonly unresolved: string;
};
export type LegacyQualification = {
  readonly legacyId: string; readonly source: CatalogLocator;
  readonly observed: {
    readonly name: string; readonly movementPatterns: readonly string[];
    readonly bodyRegions: readonly string[]; readonly equipment: LegacyRecord['equipment'];
    readonly interpretation: 'source_metadata_not_variant_or_safety_rule';
  };
  readonly variantMapping: 'unmapped'; readonly variantIds: readonly never[];
  readonly planningEligibility: 'unresolved'; readonly clinicalReadiness: 'CL-0';
  readonly muscleRoles: 'not_appraised'; readonly demands: 'unsupported'; readonly substitutions: 'unsupported';
  readonly inferredFamily: string; readonly inferredAxes: SourceRecord;
  readonly inferenceUse: 'candidate_discovery_only';
  readonly firstCatalog: {
    readonly source: CatalogLocator; readonly candidates: readonly CatalogCandidate[];
    readonly excluded: readonly { readonly id: string; readonly reason: string }[];
    readonly retainedGap: string | null;
  };
  readonly secondCatalog: {
    readonly candidates: readonly CatalogCandidate[];
    readonly exclusionsAndGaps: readonly SourceRecord[];
    readonly coverage: 'partial_name_search';
    readonly disposition: 'candidates_only' | 'no_candidate_in_retained_packet';
  };
  readonly cueSlots: readonly CueQualification[];
  readonly gaps: readonly string[];
};
export type IdQualification = {
  readonly requestedId: string; readonly identityStatus: 'found' | 'unknown';
  readonly legacyId: string | null; readonly source: CatalogLocator | null;
  readonly variantMapping: 'unmapped'; readonly variantIds: readonly never[];
  readonly planningEligibility: 'unresolved'; readonly gaps: readonly string[];
};
export type QualificationBatch = {
  readonly schema: 'form.catalog-qualification-result/v1';
  readonly sourceRevision: string; readonly status: 'unresolved';
  readonly items: readonly IdQualification[];
};
export type CatalogQualification = {
  readonly schema: 'form.catalog-qualification/v1';
  readonly source: typeof RETAINED_CATALOG_SOURCE;
  readonly inventory: readonly LegacyQualification[];
  readonly summary: {
    readonly legacyExercises: number; readonly cueSlots: number;
    readonly firstCatalogRecords: number; readonly firstCatalogCandidateLinks: number;
    readonly firstCatalogExcludedLinks: number; readonly secondCatalogCandidates: number;
    readonly secondCatalogWgerCandidates: number; readonly secondCatalogInstitutionalCandidates: number;
    readonly approvedVariants: 0; readonly displayableLegacyCues: 0;
  };
  readonly researchLimits: {
    readonly interpretation: SourceRecord; readonly secondCatalogLimitations: readonly string[];
    readonly secondCatalogPageSnapshots: Readonly<Record<string, SourceRecord>>;
    readonly secondCatalogWgerSchema: SourceRecord; readonly secondCatalogEnglishLanguageBinding: SourceRecord;
    readonly secondCatalogQueryBatch: SourceRecord;
    readonly secondCatalogExclusionsAndGaps: readonly SourceRecord[];
    readonly secondCatalogFailedRoutes: readonly SourceRecord[];
  };
  getLegacy(id: string): LegacyQualification | null;
  getCue(id: string): CueQualification | null;
  qualifyIds(ids: readonly string[]): QualificationBatch;
  getUnreviewedLegacyRecord(id: string): {
    readonly classification: 'unreviewed_legacy_content'; readonly operationalUse: false;
    readonly publicationRights: 'not_cleared'; readonly source: CatalogLocator; readonly record: LegacyRecord;
  } | null;
};

const mappingGaps = [
  'variant_identity_unresolved', 'muscle_roles_not_appraised', 'demands_unsupported',
  'substitution_equivalence_unsupported', 'legacy_cue_rights_and_attribution_unresolved',
] as const;

function locator(input: keyof RetainedCatalogInputs, pointer: string): CatalogLocator {
  const pin = RETAINED_CATALOG_INPUTS[input];
  return { repository: RETAINED_CATALOG_SOURCE.repository, revision: RETAINED_CATALOG_SOURCE.revision, path: pin.path, sha256: pin.sha256, pointer };
}

export function createRetainedCatalogQualification(inputs: RetainedCatalogInputs): CatalogQualification {
  const { legacy, first, crosswalk, second } = readRetained(inputs);
  const records = new Map(legacy.exercise_dispositions.map((row, index) => [row.legacy_id, { row, index }]));
  const firstRecords = new Map(first.entries.map(row => [row.id, row]));
  const crosswalkRows = new Map(crosswalk.rows.map((row, index) => [row.observed.id, { row, index }]));
  requireValue(records.size === 59 && firstRecords.size === 876 && crosswalkRows.size === 59, 'invalid_artifact', 'duplicate retained IDs');
  const cueIndex = new Map<string, CueQualification>();
  const cuesByExercise = new Map<string, CueQualification[]>();
  for (const [index, cue] of legacy.cue_slots.entries()) {
    fields(cue, ['clinical_readiness', 'cue_id', 'human_source', 'legacy_exercise_id', 'ordinal', 'rights_status', 'source_paths', 'wording', 'wording_origin'], 'invalid_artifact');
    const owner = records.get(cue.legacy_exercise_id)?.row.legacy_record;
    requireValue(owner && Number.isSafeInteger(cue.ordinal) && cue.ordinal > 0 && owner.cues[cue.ordinal - 1] === cue.wording, 'invalid_artifact', 'cue owner or ordinal mismatch');
    requireValue(cue.cue_id === `LEGACY-${owner.id}-${cue.ordinal}` && !cueIndex.has(cue.cue_id), 'invalid_artifact', 'cue identity mismatch');
    requireValue(cue.human_source === null && cue.rights_status === 'unreviewed_legacy_provenance' && cue.wording_origin === 'legacy_unattributed' && cue.clinical_readiness === 'CL-0' && JSON.stringify(cue.source_paths) === JSON.stringify(owner.provenance), 'invalid_artifact', 'cue qualification mismatch');
    const qualified: CueQualification = {
      id: cue.cue_id, legacyExerciseId: cue.legacy_exercise_id, ordinal: cue.ordinal,
      source: locator('legacy', `/cue_slots/${index}`), wordingSha256: createHash('sha256').update(cue.wording, 'utf8').digest('hex'),
      wordingOrigin: 'legacy_unattributed', humanSource: null, rightsStatus: 'unreviewed_legacy_provenance',
      clinicalReadiness: 'CL-0', classification: 'unclassified', display: 'withheld', mutable: false,
      gaps: ['human_attribution_unresolved', 'wording_rights_unresolved', 'cue_classification_unreviewed', 'individual_applicability_unreviewed'],
    };
    cueIndex.set(cue.cue_id, qualified);
    const collection = cuesByExercise.get(owner.id) ?? [];
    collection.push(qualified);
    cuesByExercise.set(owner.id, collection);
  }
  const inventory: LegacyQualification[] = [];
  for (const [id, { row, index }] of records) {
    const observed = row.legacy_record;
    const allowed = ['id', 'name', 'body_regions', 'movement_patterns', 'equipment', 'cues', 'provenance', 'aging_athlete_notes', 'contraindications', 'safety_flags', 'regressions', 'progressions'];
    requireValue(Object.keys(observed).every(key => allowed.includes(key)) && row.legacy_id === observed.id && row.name === observed.name && row.mapping_status === 'legacy_id_retained_variant_normalization_pending' && row.research_roles === 'not_appraised', 'invalid_artifact', 'strict legacy record mismatch');
    fields(observed.equipment, ['required', 'alternatives'], 'invalid_artifact');
    const comparison = crosswalkRows.get(id);
    requireValue(comparison && comparison.row.observed.name === observed.name && JSON.stringify(comparison.row.observed.movement_patterns) === JSON.stringify(observed.movement_patterns) && JSON.stringify(comparison.row.observed.body_regions) === JSON.stringify(observed.body_regions), 'invalid_artifact', 'crosswalk observed identity mismatch');
    const cueSlots = cuesByExercise.get(id) ?? [];
    requireValue(cueSlots.length === observed.cues.length && cueSlots.every((cue, i) => cue.ordinal === i + 1), 'invalid_artifact', 'missing cue slots');
    const candidates: CatalogCandidate[] = comparison.row.candidates.map((candidate, candidateIndex) => {
      const metadata = firstRecords.get(candidate.id);
      requireValue(metadata, 'invalid_artifact', 'unknown first catalog candidate');
      return {
        catalog: 'free-exercise-db', source: locator('crosswalk', `/rows/${comparison.index}/candidates/${candidateIndex}`),
        nativeId: candidate.id, name: metadata.name, basis: candidate.basis, identityConfirmed: false, reuse: 'not_cleared',
        sourceMetadata: metadata, rights: { status: first.rights_status, biologicalRoles: first.biological_roles, sourceCommit: first.source_commit, sourceSha256: first.source_sha256, sourceUrl: first.source_url },
        unresolved: candidate.unresolved,
      };
    });
    for (const excluded of comparison.row.excluded) requireValue(firstRecords.has(excluded.id), 'invalid_artifact', 'unknown excluded first catalog record');
    const secondCandidates: CatalogCandidate[] = [];
    for (const [candidateIndex, candidate] of second.candidates.entries()) {
      requireValue(candidate.legacy_ids.every(legacyId => records.has(legacyId)), 'invalid_artifact', 'unknown second catalog legacy ID');
      if (!candidate.legacy_ids.includes(id)) continue;
      const rights = second.rights_bindings[candidate.rights_binding];
      requireValue(rights, 'invalid_artifact', 'unknown rights binding');
      if (candidate.source === 'wger') requireValue(candidate.language_id === 2 && typeof candidate.exercise_id === 'number' && typeof candidate.translation_id === 'number', 'invalid_artifact', 'unqualified wger identity');
      secondCandidates.push({
        catalog: candidate.source === 'wger' ? 'wger' : 'institutional-name-index',
        source: locator('secondCatalog', `/candidates/${candidateIndex}`), nativeId: candidate.exercise_id ?? null,
        name: candidate.name, basis: candidate.basis, identityConfirmed: false, reuse: 'not_cleared',
        sourceMetadata: candidate, rights, unresolved: candidate.unknown,
      });
    }
    inventory.push({
      legacyId: id, source: locator('legacy', `/exercise_dispositions/${index}`),
      observed: { name: observed.name, movementPatterns: observed.movement_patterns, bodyRegions: observed.body_regions, equipment: observed.equipment, interpretation: 'source_metadata_not_variant_or_safety_rule' },
      variantMapping: 'unmapped', variantIds: [], planningEligibility: 'unresolved', clinicalReadiness: 'CL-0',
      muscleRoles: 'not_appraised', demands: 'unsupported', substitutions: 'unsupported',
      inferredFamily: comparison.row.family, inferredAxes: comparison.row.axes, inferenceUse: 'candidate_discovery_only',
      firstCatalog: { source: locator('crosswalk', `/rows/${comparison.index}`), candidates, excluded: comparison.row.excluded, retainedGap: comparison.row.gap },
      secondCatalog: { candidates: secondCandidates, exclusionsAndGaps: second.additional_exclusions_and_unresolved_gaps.filter(gap => Array.isArray(gap.legacy_ids) && gap.legacy_ids.includes(id)), coverage: 'partial_name_search', disposition: secondCandidates.length ? 'candidates_only' : 'no_candidate_in_retained_packet' },
      cueSlots, gaps: mappingGaps,
    });
  }
  const index = new Map(inventory.map(row => [row.legacyId, row]));
  return freeze({
    schema: 'form.catalog-qualification/v1', source: RETAINED_CATALOG_SOURCE, inventory,
    summary: {
      legacyExercises: inventory.length, cueSlots: cueIndex.size, firstCatalogRecords: firstRecords.size,
      firstCatalogCandidateLinks: crosswalk.rows.reduce((total, row) => total + row.candidates.length, 0),
      firstCatalogExcludedLinks: crosswalk.rows.reduce((total, row) => total + row.excluded.length, 0),
      secondCatalogCandidates: second.candidates.length,
      secondCatalogWgerCandidates: second.candidates.filter(row => row.source === 'wger').length,
      secondCatalogInstitutionalCandidates: second.candidates.filter(row => row.source !== 'wger').length,
      approvedVariants: 0, displayableLegacyCues: 0,
    },
    researchLimits: {
      interpretation: crosswalk.interpretation, secondCatalogLimitations: second.limitations,
      secondCatalogPageSnapshots: second.page_snapshots, secondCatalogWgerSchema: second.wger_schema,
      secondCatalogEnglishLanguageBinding: second.english_language_binding, secondCatalogQueryBatch: second.targeted_query_batch,
      secondCatalogExclusionsAndGaps: second.additional_exclusions_and_unresolved_gaps, secondCatalogFailedRoutes: second.failed_routes,
    },
    getLegacy(id: string) { return index.get(textValue(id, 'invalid_request')) ?? null; },
    getCue(id: string) { return cueIndex.get(textValue(id, 'invalid_request')) ?? null; },
    qualifyIds(ids: readonly string[]): QualificationBatch {
      const requested = identifiers(ids, 'invalid_request');
      requireValue(requested.length > 0, 'invalid_request', 'at least one ID required');
      const items: IdQualification[] = requested.map(requestedId => {
        const match = index.get(requestedId);
        return { requestedId, identityStatus: match ? 'found' : 'unknown', legacyId: match?.legacyId ?? null, source: match?.source ?? null, variantMapping: 'unmapped', variantIds: [], planningEligibility: 'unresolved', gaps: match?.gaps ?? ['unknown_legacy_id', 'variant_identity_unresolved'] };
      });
      return freeze({ schema: 'form.catalog-qualification-result/v1', sourceRevision: RETAINED_CATALOG_SOURCE.revision, status: 'unresolved', items });
    },
    getUnreviewedLegacyRecord(id: string) {
      const match = records.get(textValue(id, 'invalid_request'));
      return match ? freeze({ classification: 'unreviewed_legacy_content' as const, operationalUse: false as const, publicationRights: 'not_cleared' as const, source: locator('legacy', `/exercise_dispositions/${match.index}/legacy_record`), record: match.row.legacy_record }) : null;
    },
  });
}
