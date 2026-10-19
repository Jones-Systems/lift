import { dataArray, fields, freeze, identifiers, requireValue, textValue } from './validation.js';
import type { CatalogQualification } from './index.js';

export type CueControl = {
  readonly id: string;
  readonly kind: 'coaching' | 'technical' | 'safety' | 'unclassified';
  readonly rightsStatus: 'display_permitted' | 'unresolved' | 'restricted';
  readonly contentStatus: 'qualified' | 'unreviewed';
  readonly source: { readonly revision: string; readonly path: string; readonly sha256: string; readonly locator: string };
};
export type CuePolicy = {
  readonly schema: 'form.cue-policy/v1'; readonly exerciseId: string;
  readonly revision: string; readonly cues: readonly CueControl[];
};
export type CuePreferenceInput = {
  readonly expectedPolicyRevision: string;
  readonly kept: readonly string[]; readonly rejected: readonly string[];
  readonly order: readonly string[]; readonly replacementRequested: readonly string[];
};
export type QualifiedCuePreferences = {
  readonly exerciseId: string; readonly policyRevision: string;
  readonly preferences: Omit<CuePreferenceInput, 'expectedPolicyRevision'>;
  readonly mutableCueIds: readonly string[]; readonly fixedCueIds: readonly string[];
  readonly withheldCueIds: readonly string[]; readonly replacementStatus: 'not_requested' | 'requested_not_generated';
};
export type CuePreferenceValidator = {
  readonly policy: CuePolicy;
  validate(input: unknown): QualifiedCuePreferences;
};

export function createLegacyCuePreferenceValidator(catalog: CatalogQualification, legacyExerciseId: string): CuePreferenceValidator {
  const exercise = catalog.getLegacy(legacyExerciseId);
  requireValue(exercise, 'invalid_request', 'unknown legacy exercise');
  return createCuePreferenceValidator({
    schema: 'form.cue-policy/v1', exerciseId: exercise.legacyId,
    revision: `legacy-unreviewed:${exercise.source.sha256}`,
    cues: exercise.cueSlots.map(cue => ({
      id: cue.id, kind: 'unclassified', rightsStatus: 'unresolved', contentStatus: 'unreviewed',
      source: { revision: cue.source.revision, path: cue.source.path, sha256: cue.source.sha256, locator: cue.source.pointer },
    })),
  });
}

// The injecting content owner authenticates this policy; schema conformance is not rights clearance or clinical appraisal.
export function createCuePreferenceValidator(input: unknown): CuePreferenceValidator {
  const root = fields(input, ['schema', 'exerciseId', 'revision', 'cues'], 'invalid_policy');
  requireValue(root.schema === 'form.cue-policy/v1', 'invalid_policy', 'unsupported cue policy schema');
  const exerciseId = textValue(root.exerciseId, 'invalid_policy');
  const revision = textValue(root.revision, 'invalid_policy');
  const cues: CueControl[] = dataArray(root.cues, 'invalid_policy', 1000).map(value => {
    const cue = fields(value, ['id', 'kind', 'rightsStatus', 'contentStatus', 'source'], 'invalid_policy');
    const id = textValue(cue.id, 'invalid_policy');
    requireValue(cue.kind === 'coaching' || cue.kind === 'technical' || cue.kind === 'safety' || cue.kind === 'unclassified', 'invalid_policy', 'unknown cue classification');
    requireValue(cue.rightsStatus === 'display_permitted' || cue.rightsStatus === 'unresolved' || cue.rightsStatus === 'restricted', 'invalid_policy', 'unknown cue rights');
    requireValue(cue.contentStatus === 'qualified' || cue.contentStatus === 'unreviewed', 'invalid_policy', 'unknown content qualification');
    const source = fields(cue.source, ['revision', 'path', 'sha256', 'locator'], 'invalid_policy');
    const sha256 = textValue(source.sha256, 'invalid_policy');
    requireValue(/^[a-f0-9]{64}$/u.test(sha256), 'invalid_policy', 'invalid source digest');
    return { id, kind: cue.kind, rightsStatus: cue.rightsStatus, contentStatus: cue.contentStatus,
      source: { revision: textValue(source.revision, 'invalid_policy'), path: textValue(source.path, 'invalid_policy'), sha256, locator: textValue(source.locator, 'invalid_policy') } };
  });
  requireValue(new Set(cues.map(cue => cue.id)).size === cues.length, 'invalid_policy', 'duplicate policy cue IDs');
  const policy: CuePolicy = freeze({ schema: 'form.cue-policy/v1', exerciseId, revision, cues });
  const mutableCueIds = cues.filter(cue => cue.kind === 'coaching' && cue.rightsStatus === 'display_permitted' && cue.contentStatus === 'qualified').map(cue => cue.id);
  const mutable = new Set(mutableCueIds);
  const fixedCueIds = cues.filter(cue => cue.kind === 'technical' || cue.kind === 'safety').map(cue => cue.id);
  const withheldCueIds = cues.filter(cue => cue.kind === 'unclassified' || cue.rightsStatus !== 'display_permitted' || cue.contentStatus !== 'qualified').map(cue => cue.id);
  return freeze({
    policy,
    validate(input: unknown): QualifiedCuePreferences {
      const request = fields(input, ['expectedPolicyRevision', 'kept', 'rejected', 'order', 'replacementRequested'], 'invalid_request');
      const expectedPolicyRevision = textValue(request.expectedPolicyRevision, 'invalid_request');
      requireValue(expectedPolicyRevision === policy.revision, 'stale_policy', 'cue policy changed');
      const kept = identifiers(request.kept, 'invalid_request');
      const rejected = identifiers(request.rejected, 'invalid_request');
      const order = identifiers(request.order, 'invalid_request');
      const replacementRequested = identifiers(request.replacementRequested, 'invalid_request');
      for (const ids of [kept, rejected, order, replacementRequested]) {
        requireValue(ids.every(id => mutable.has(id)), 'invalid_request', 'only qualified coaching cues accept preferences');
      }
      const keepSet = new Set(kept);
      requireValue(!rejected.some(id => keepSet.has(id)), 'invalid_request', 'cue cannot be both kept and rejected');
      requireValue(order.length === kept.length && order.every(id => keepSet.has(id)), 'invalid_request', 'order must contain every kept cue exactly once');
      return freeze({ exerciseId: policy.exerciseId, policyRevision: policy.revision, preferences: { kept, rejected, order, replacementRequested }, mutableCueIds, fixedCueIds, withheldCueIds,
        replacementStatus: replacementRequested.length ? 'requested_not_generated' : 'not_requested' });
    },
  });
}
