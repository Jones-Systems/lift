// Body capability statuses. Pure: no React, native, storage or network imports.
// Evidence: docs/workstreams/form-accounts-onboarding/continuation/body/research-feasibility.md (dc6561f) and the
// compliance report at Codex-V3 56bc466. A status may move to 'qualified' only through a source change that cites
// native/storage/deletion evidence; no runtime prop, flag or app mode can raise it.

/** Not one "AI available" boolean: each capability carries its own qualification state. */
export type CapabilityStatus = 'unsupported' | 'unconfigured' | 'implemented_unverified' | 'qualified';

export type UnavailableReason =
  /** Ordinary Expo capture writes a file to the app cache; no verified in-memory native path exists. */
  | 'no_memory_only_camera_path'
  /** No landmark/measurement method, calibration or population has been validated for Form. */
  | 'no_qualified_method'
  /** Femur length, hip level, pelvic tilt and posture are not observable from ordinary photos or tape. */
  | 'construct_not_observable'
  /** No qualified protective storage with complete deletion of receipts, history and backups. */
  | 'no_qualified_storage_or_deletion'
  /** Deliberately not offered: no external provider, no shared-system training. */
  | 'not_offered';

export type BodyCapability = { status: CapabilityStatus; reason: UnavailableReason | null };

export type BodyCapabilityId =
  | 'manualSession'
  | 'cameraCapture'
  | 'automaticEstimates'
  | 'anatomicalAssessment'
  | 'retainedMeasurements'
  | 'retainedPhotos'
  | 'externalProcessing'
  | 'improvementContribution';

export const BODY_CAPABILITIES: Readonly<Record<BodyCapabilityId, Readonly<BodyCapability>>> = Object.freeze({
  // Source exists; its synthetic tests have not been executed and native memory behavior is unqualified.
  manualSession: Object.freeze({ status: 'implemented_unverified', reason: null }),
  cameraCapture: Object.freeze({ status: 'unsupported', reason: 'no_memory_only_camera_path' }),
  automaticEstimates: Object.freeze({ status: 'unsupported', reason: 'no_qualified_method' }),
  anatomicalAssessment: Object.freeze({ status: 'unsupported', reason: 'construct_not_observable' }),
  retainedMeasurements: Object.freeze({ status: 'unconfigured', reason: 'no_qualified_storage_or_deletion' }),
  retainedPhotos: Object.freeze({ status: 'unconfigured', reason: 'no_qualified_storage_or_deletion' }),
  externalProcessing: Object.freeze({ status: 'unsupported', reason: 'not_offered' }),
  improvementContribution: Object.freeze({ status: 'unsupported', reason: 'not_offered' }),
} satisfies Record<BodyCapabilityId, BodyCapability>);

/** The manual, memory-only session is the only usable body path; unverified still counts as usable here. */
export function isUsable(capability: BodyCapability): boolean {
  return capability.status === 'qualified' || capability.status === 'implemented_unverified';
}

/**
 * Future retained-mode gate. Images and derived data are separate explicit decisions; silence (null) is never
 * consent, and both must be answered before either adapter may run. Improvement is never implied by either.
 * With the current BODY_CAPABILITIES every result is denied.
 */
export type RetentionDecision = {
  photos: 'accept' | 'decline' | null;
  derived: 'accept' | 'decline' | null;
  /** Version of the consent text the person actually saw; null means no consent record exists. */
  consentVersion: string | null;
};

export type RetentionGate = {
  photos: boolean;
  derived: boolean;
  reason: 'allowed' | 'choice_missing' | 'consent_missing' | 'capability_unqualified';
};

export function retentionGate(
  capabilities: Readonly<Record<BodyCapabilityId, Readonly<BodyCapability>>>,
  decision: RetentionDecision,
): RetentionGate {
  if (decision.photos === null || decision.derived === null) return { photos: false, derived: false, reason: 'choice_missing' };
  if (!decision.consentVersion) return { photos: false, derived: false, reason: 'consent_missing' };
  const derivedReady = capabilities.retainedMeasurements.status === 'qualified';
  // Keeping photos also requires a qualified capture path; retained photos never imply retained derivatives.
  const photosReady = capabilities.retainedPhotos.status === 'qualified' && capabilities.cameraCapture.status === 'qualified';
  const photos = photosReady && decision.photos === 'accept';
  const derived = derivedReady && decision.derived === 'accept';
  const unmet = (decision.photos === 'accept' && !photos) || (decision.derived === 'accept' && !derived);
  return { photos, derived, reason: unmet ? 'capability_unqualified' : 'allowed' };
}

/**
 * Structural match for the Settings `BodyPrivacySummary` proposed in
 * continuation/mobile/design/settings-training/contracts.md (gap G-B1). Body supplies only these two variants.
 */
export type BodyChoiceRow = { label: string; value: string };
export type BodyPrivacySummary =
  | { status: 'unavailable'; reason: string }
  | { status: 'ready'; photos: BodyChoiceRow; derived: BodyChoiceRow; improvement: BodyChoiceRow };

const NOT_AVAILABLE = 'Not available yet';
const NOT_OFFERED = 'Not offered';

/** Labels come from real state: nothing here is chosen, so no row reads as on or consented. */
export function bodyPrivacySummary(
  capabilities: Readonly<Record<BodyCapabilityId, Readonly<BodyCapability>>> = BODY_CAPABILITIES,
): BodyPrivacySummary {
  const value = (capability: BodyCapability) =>
    capability.status === 'qualified' ? 'Not chosen' : capability.reason === 'not_offered' ? NOT_OFFERED : NOT_AVAILABLE;
  return {
    status: 'ready',
    photos: { label: 'Save progress photos', value: value(capabilities.retainedPhotos) },
    derived: { label: 'Save measurements and results', value: value(capabilities.retainedMeasurements) },
    improvement: { label: 'Help improve Form', value: value(capabilities.improvementContribution) },
  };
}
