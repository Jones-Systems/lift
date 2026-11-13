/**
 * Type-only synthetic lineage checkpoint. No validation, brand issuance or atomicity
 * is implemented. Existing wire formats and production authority are separate.
 */
declare const checked: unique symbol;
type Checked<T, K extends string> = T & { readonly [checked]: K };
export type SynId<K extends string> = Checked<string, `synthetic-id:${K}`>;
export type Digest = Checked<string, 'sha256-lowercase-hex'>;
export type ExactText = Checked<string, 'bounded-exact-text'>;
export type SafeNatural = Checked<number, 'safe-integer-at-least-zero'>;
export type Revision<D extends string> = Readonly<{ domain: D; value: SafeNatural }>;
export type SourceRevision = ExactText; // Immutable source identity, not a numeric plan revision.
export type NonEmpty<T> = readonly [T, ...T[]];
export type CodecVersion = 'form.synthetic-cjson/v1';
export type Capability = 'source_prescription_adoption_synthetic_v1';

export type ActorBinding = Readonly<{
  accountId: SynId<'account'>; authUserId: SynId<'auth-user'>;
  sessionId: SynId<'session'>; epoch: Revision<'account-epoch'>;
}>; // Comparison evidence only. Trusted actor comes from the harness frame.
export type SourceRef = Readonly<{
  sourceId: SynId<'source'>; revision: SourceRevision;
  locator: ExactText; qualification: ExactText;
}>;
export type Scope =
  | Readonly<{ kind: 'context'; contextId: SynId<'context'> }>
  | Readonly<{ kind: 'session'; contextId: SynId<'context'>; sessionId: SynId<'session'> }>
  | Readonly<{ kind: 'activity'; contextId: SynId<'context'>; activityId: SynId<'activity'> }>;
export type SourceJoin = Readonly<{
  sourceKind: 'session' | 'activity'; sourceId: SynId<'source'>;
  sourceRevision: Revision<'source'>;
  occurrenceId: SynId<'occurrence'>;
  itemId: SynId<'item'>; itemRevision: Revision<'source-item'>;
  set: Readonly<{ id: SynId<'set'>; revision: Revision<'source-set'> }> | null;
  historicalPlan: Readonly<{ planId: SynId<'plan'>; planRevision: Revision<'historical-plan'> }> | null;
  identityId: SynId<'identity'>; identityRevision: Revision<'comparison-identity'>;
  associationEvidenceDigest: Digest;
}>;
export type OriginalAssociation = Readonly<{
  accountId: SynId<'account'>; contextId: SynId<'context'>; scope: Scope;
  profileRevision: Revision<'profile'>; preferencesRevision: Revision<'preferences'>;
  joins: readonly SourceJoin[]; sourceRefs: NonEmpty<SourceRef>;
}>;

// Logical source-plan v1 shape; numeric bounds require runtime validation.
// IDs below are synthetic-only refinements of resourceId/sourceReferenceText.
export type NativePrescriptionV1 = Readonly<{
  exercise_id: SynId<'native-exercise'>; movement_pattern: ExactText; role: ExactText;
  sets: number; rest_seconds: number;
  rep_range?: readonly [number, number]; target_rir?: number;
  substituted_for?: SynId<'native-exercise'>; notes?: NonEmpty<string>;
}>;
export type SourceItemV1 = Readonly<{
  id: SynId<'item'>; native: NativePrescriptionV1;
  registeredDomain: Readonly<{
    exerciseId: SynId<'domain-exercise'>; variantId: ExactText;
    identity: Readonly<{
      repository: ExactText; revision: SourceRevision; path: ExactText;
      sha256: Digest; nativeId: SynId<'native-exercise'>;
    }>;
    registration: Readonly<{ id: ExactText; revision: SourceRevision; digest: Digest; bytes: number }>;
    recordDigest: Digest;
  }>;
  load: Readonly<{ kind: 'unspecified'; basis: 'unknown' }>;
}>;
export type SourcePlanFieldsV1 = Readonly<{
  schema: 'form.source-prescription-plan/v1'; name: string;
  origin: Readonly<{ kind: 'form-adaptation'; id: ExactText; revision: SourceRevision }>;
  duration: Readonly<{ kind: 'estimated-range'; minMinutes: number; maxMinutes: number }>;
  items: NonEmpty<SourceItemV1>;
}>;
export type SourcePlanSnapshotV1 = Readonly<{
  planId: SynId<'plan'>; planRevision: Revision<'plan'>;
  archived: boolean; fields: SourcePlanFieldsV1;
}>;
export type SourceChangeV1 = Readonly<{
  schema: 'form.synthetic-source-change/v1'; kind: 'replace-source-plan';
  capability: Capability; targetPlanId: SynId<'plan'>; expectedRevision: Revision<'plan'>;
  before: SourcePlanSnapshotV1; after: SourcePlanFieldsV1;
  itemMapping: NonEmpty<Readonly<{ afterItemId: SynId<'item'>; beforeItemId: SynId<'item'> | null }>>;
}>;

// Explicit wrapper schemas are NEW synthetic tags; embedded old wire gets no new fields.
// canonicalJson contains the ENTIRE selected old response/witness, not a lossy projection.
// Required embedded codecs are injected through subcodec-types.ts; none is implemented here.
export type EmbeddedSchema =
  | 'synthetic.training-feedback-analysis.pinned-v1'
  | 'synthetic.feedback-comparison-lineage.pinned-v1'
  | 'synthetic.comparison-witness.pinned-v2'
  | 'synthetic.registration-manifest/v1'
  | 'synthetic.accepted-input-dispositions/v1';
export type EvidenceBlobV1 = Readonly<{
  id: SynId<'evidence'>; schema: EmbeddedSchema; subcodecDigest: Digest;
  payloadDigest: Digest; canonicalJson: string;
}>;
export type AcceptedInputDispositionsV1 = Readonly<{
  schema: 'synthetic.accepted-input-dispositions/v1';
  rows: NonEmpty<Readonly<{
    inputId: SynId<'input'>; sourceRef: SourceRef;
    disposition: 'keep' | 'refresh' | 'retire';
    applicabilityRevision: Revision<'input-applicability'>; qualified: boolean;
    dependencyKey: Readonly<{ kind: 'input-disposition'; ownerId: SynId<'dependency-owner'>; id: SynId<'dependency'> }>;
  }>>;
}>;
export type RecipeNode = Readonly<{
  id: SynId<'derivation'>; semanticVersion: ExactText;
  kind: 'history' | 'summary' | 'recommendation';
  parentIds: readonly SynId<'derivation'>[]; sourceRecordIds: readonly SynId<'record'>[];
  sourceRefs: NonEmpty<SourceRef>; qualifications: readonly ExactText[];
}>;
export type RecipeManifestV1 = Readonly<{
  schema: 'form.synthetic-recipe-manifest/v1'; recipeId: SynId<'recipe'>;
  semanticVersion: ExactText;
  executable: Readonly<{ repository: ExactText; revision: SourceRevision; path: ExactText; sha256: Digest }>;
  implementationManifestDigest: Digest;
  constants: Readonly<{ fixtureId: SynId<'constants'>; digest: Digest; justification: 'synthetic-nonprescriptive' }>;
  registrationEvidenceId: SynId<'evidence'>;
  rootDerivationId: SynId<'derivation'>; nodes: NonEmpty<RecipeNode>;
}>;
export type DependencyKind =
  | 'context' | 'profile' | 'preferences' | 'target-plan' | 'historical-plan'
  | 'session' | 'session-item' | 'session-set' | 'activity' | 'activity-item' | 'activity-set'
  | 'comparison-identity' | 'association' | 'feedback-record' | 'ledger' | 'projection'
  | 'source' | 'catalog-row' | 'input-disposition' | 'recipe' | 'executable' | 'constants'
  | 'registry' | 'recipe-authority' | 'rights' | 'retention' | 'schema' | 'codec' | 'boundary';
// revision is the fake producer's authority generation for this exact key,
// never a reinterpretation of a source Git OID, semantic version, or session.planRevision.
export type DependencyToken = {
  [K in DependencyKind]: Readonly<{
    key: Readonly<{ kind: K; ownerId: SynId<'dependency-owner'>; id: SynId<'dependency'> }>;
    revision: Revision<`dependency:${K}`>;
    contentDigest: Digest; state: 'current' | 'changed' | 'missing' | 'void' | 'withdrawn' | 'unconfirmed';
  }>
}[DependencyKind];
export type Operation = 'review-display' | 'review-retain' | 'adopt' | 'reconcile' | 'compensate';
export type DataCategory = 'recommendation' | 'review' | 'intent' | 'minimal-receipt' | 'receipt-detail';
export type FakeDecisionV1 = Readonly<{
  schema: 'form.synthetic-policy-decision/v1'; kind: 'recipe-authority' | 'rights' | 'retention';
  realmId: SynId<'realm'>; issuerId: SynId<'issuer'>; decisionId: SynId<'decision'>;
  revision: Revision<'policy-decision'>; revocationRevision: Revision<'policy-revocation'>;
  accountId: SynId<'account'>; recommendationId: SynId<'recommendation'>;
  operation: Operation; purpose: 'isolated-contract-fixture';
  dataCategories: NonEmpty<DataCategory>; permittedFieldPaths: NonEmpty<ExactText>;
  applicabilityDigest: Digest; outcome: 'allow' | 'deny' | 'unavailable';
}>; // No retention duration or production issuer; runtime membership requires a separate check.
export type EvidenceClosureV1 = Readonly<{
  schema: 'form.synthetic-evidence-closure/v1';
  association: OriginalAssociation;
  ledgerRevision: Revision<'feedback-ledger'>; projectionRevision: Revision<'feedback-projection'>;
  records: NonEmpty<Readonly<{
    recordId: SynId<'record'>; eventId: SynId<'event'>; recordRevision: Revision<'feedback-record'>;
    status: 'active' | 'withdrawn' | 'deleted' | 'undone' | 'missing'; confirmed: boolean;
    acceptedLedgerRevision: Revision<'feedback-ledger'>; evidenceId: SynId<'evidence'>;
  }>>;
  recipe: RecipeManifestV1;
  registry: Readonly<{
    schema: 'feedback-comparison-inputs-v1'; version: ExactText; digest: Digest;
    selectedInputIds: readonly SynId<'comparison-input'>[];
    lineageEvidenceIds: readonly SynId<'evidence'>[];
  }> | null;
  inputsEvidenceId: SynId<'evidence'>;
  blobs: NonEmpty<EvidenceBlobV1>; dependencies: NonEmpty<DependencyToken>;
  decisions: NonEmpty<FakeDecisionV1>;
}>;
export type RecommendationV1 = Readonly<{
  schema: 'form.training-recommendation.synthetic/v1'; environment: 'synthetic-only';
  realmId: SynId<'realm'>; recommendationId: SynId<'recommendation'>;
  kind: 'recommendation'; status: 'ready'; blockedBy: readonly [];
  derivationId: SynId<'derivation'>; derivationVersion: ExactText;
  change: SourceChangeV1; evidence: EvidenceClosureV1; evidenceDigest: Digest;
}>;
export type ReviewV1 = Readonly<{
  schema: 'form.training-review.synthetic/v1'; reviewId: SynId<'review'>;
  recommendation: RecommendationV1; reviewingActor: ActorBinding;
  reviewedMeaningDigest: Digest; consent: 'explicit-synthetic-review';
}>;
export type IntentV1 = Readonly<{
  schema: 'form.training-lineage.synthetic/v1'; environment: 'synthetic-only';
  codec: CodecVersion; boundary: Capability; operationNamespace: 'training.synthetic-lineage/v1';
  realmId: SynId<'realm'>; adoptionId: SynId<'adoption'>; attemptId: SynId<'attempt'>;
  originalActor: ActorBinding; review: ReviewV1;
  action: Readonly<{ kind: 'adopt'; consent: 'explicit-synthetic-adoption'; undoOf: null }>
    | Readonly<{ kind: 'compensate'; consent: 'explicit-synthetic-compensation'; undoOf: SynId<'receipt'>; appliedRevision: Revision<'plan'>; appliedAfterDigest: Digest }>;
}>;
export type AttemptV1 = Readonly<{ intent: IntentV1; intentDigest: Digest }>;
export type Correlation = Readonly<{
  realmId: SynId<'realm'>; accountId: SynId<'account'>; planId: SynId<'plan'>;
  recommendationId: SynId<'recommendation'>; reviewId: SynId<'review'>;
  adoptionId: SynId<'adoption'>; attemptId: SynId<'attempt'>;
  intentDigest: Digest; evidenceDigest: Digest;
}>;
export type MinimalReceiptV1 = Readonly<{
  schema: 'form.training-lineage.synthetic-receipt/v1'; receiptId: SynId<'receipt'>;
  correlation: Correlation; sourceSchema: 'form.source-prescription-plan/v1';
  boundary: Capability; fromRevision: Revision<'plan'>; toRevision: Revision<'plan'>;
  beforeDigest: Digest; afterDigest: Digest; undoOf: SynId<'receipt'> | null;
}>;
export type Disclosure =
  | Readonly<{ state: 'available'; receipt: MinimalReceiptV1 }>
  | Readonly<{ state: 'unavailable'; reason: 'receipt_disclosure' }>;
export type CommitProof = Readonly<{
  kind: 'synthetic-retained-commit'; receiptId: SynId<'receipt'>; receiptDigest: Digest;
  correlation: Correlation; fromRevision: Revision<'plan'>; toRevision: Revision<'plan'>;
}>; // Only trusted harness observation plus exact correlation establishes it.
export type NoEffectProof = Readonly<{
  kind: 'synthetic-authoritative-no-effect'; correlation: Correlation;
  provenance: 'not-dispatched' | 'rolled-back-attempt'; observationId: SynId<'observation'>;
}>;
export type OriginalEffect =
  | Readonly<{ state: 'committed'; proof: CommitProof }>
  | Readonly<{ state: 'no_effect'; proof: NoEffectProof }>
  | Readonly<{ state: 'unknown' }>;
export type FailureReasons = {
  denied: 'actor_or_lifecycle' | 'malformed_intent' | 'intent_mismatch' | 'duplicate_recommendation'
    | 'incompatible_boundary' | 'target_not_editable';
  conflict: 'stale_target' | 'stale_input' | 'stale_recipe_or_registry' | 'intervening_edit';
  unavailable: 'registration_or_authority' | 'rights' | 'retention' | 'input_unqualified'
    | 'integration_failure' | 'receipt_disclosure';
  unknown: 'transport_ambiguous' | 'response_unverifiable' | 'original_effect_unresolved';
};
type ResultBase = Readonly<{
  schema: 'form.training-lineage.synthetic-result/v1'; correlation: Correlation;
}>;
export type ResultV1 = ResultBase & (
  | Readonly<{ outcome: 'committed'; reason: 'new_revision'; invocationEffect: 'committed';
      originalEffect: Extract<OriginalEffect, { state: 'committed' }>; disclosure: Disclosure; recovery: 'none' }>
  | Readonly<{ outcome: 'reconciled'; reason: 'retained_exact_receipt'; invocationEffect: 'no_new_effect';
      originalEffect: Extract<OriginalEffect, { state: 'committed' }>; disclosure: Disclosure; recovery: 'none' }>
  | Readonly<{ outcome: 'denied'; reason: FailureReasons['denied']; invocationEffect: 'no_new_effect';
      originalEffect: OriginalEffect; disclosure: Readonly<{ state: 'unavailable'; reason: 'receipt_disclosure' }>;
      recovery: 'hold' | 'reconcile-exact' | 'explicit-new-review-after-resolution' }>
  | Readonly<{ outcome: 'conflict'; reason: FailureReasons['conflict']; invocationEffect: 'no_new_effect';
      originalEffect: OriginalEffect; disclosure: Readonly<{ state: 'unavailable'; reason: 'receipt_disclosure' }>;
      recovery: 'hold' | 'reconcile-exact' | 'explicit-new-review-after-resolution' }>
  | Readonly<{ outcome: 'unavailable'; reason: FailureReasons['unavailable']; invocationEffect: 'no_new_effect' | 'unknown';
      originalEffect: OriginalEffect; disclosure: Readonly<{ state: 'unavailable'; reason: 'receipt_disclosure' }>;
      recovery: 'hold' | 'reconcile-exact' }>
  | Readonly<{ outcome: 'unknown'; reason: FailureReasons['unknown']; invocationEffect: 'unknown';
      originalEffect: Readonly<{ state: 'unknown' }>; disclosure: Readonly<{ state: 'unavailable'; reason: 'receipt_disclosure' }>;
      recovery: 'hold' | 'reconcile-exact' }>
);
export type ReconcileV1 = Readonly<{
  schema: 'form.training-lineage.synthetic-reconcile/v1'; environment: 'synthetic-only';
  correlation: Correlation; originalActor: ActorBinding;
}>; // Current actor arrives out of band. No new plan payload or replacement fingerprint.
export type EligibilityV1 =
  | Readonly<{ state: 'eligible'; reviewId: SynId<'review'>; evidenceDigest: Digest }>
  | Readonly<{ state: 'ineligible'; reason: FailureReasons['conflict'] | FailureReasons['unavailable'] }>
  | Readonly<{ state: 'unavailable' }>;
// Eligibility is a distinct authorized query; it never rewrites a historical receipt.

export type CodecError = Readonly<{
  kind: 'codec-error'; code:
    | 'bad_utf8' | 'bad_json' | 'duplicate_key' | 'unknown_field' | 'missing_field' | 'wrong_type'
    | 'invalid_number' | 'invalid_string' | 'unsupported_version' | 'unsupported_evidence_schema'
    | 'bounds_exceeded' | 'duplicate_identity' | 'unresolved_reference' | 'cycle'
    | 'digest_mismatch' | 'context_mismatch' | 'invalid_transition' | 'uncorrelated_response';
  path: string; // Bounded structural path only; never echo raw input or private values.
}>;
export type Decode<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: CodecError }>;
export interface SyntheticCodecV1 {
  decodeAttempt(bytes: Uint8Array): Decode<AttemptV1>;
  encodeAttempt(attempt: AttemptV1): Decode<Uint8Array>;
  decodeReconcile(bytes: Uint8Array): Decode<ReconcileV1>;
  decodeResult(bytes: Uint8Array, expected: AttemptV1): Decode<ResultV1>;
  encodeResult(result: ResultV1, expected: AttemptV1): Decode<Uint8Array>;
}
// Opaque type markers only; live capabilities require private runtime membership.
// No public constructor or boolean/environment-variable bypass is supplied here.
declare const realmBrand: unique symbol;
declare const frameBrand: unique symbol;
export type SyntheticRealm = Readonly<{ [realmBrand]: true }>;
export type SyntheticWriteFrame = Readonly<{ [frameBrand]: true }>;
export interface IsolatedSyntheticPortV1 {
  readonly capability: Capability;
  submit(frame: SyntheticWriteFrame, attempt: AttemptV1): ResultV1;
  reconcile(frame: SyntheticWriteFrame, input: ReconcileV1): ResultV1;
  eligibility(frame: SyntheticWriteFrame, review: ReviewV1): EligibilityV1;
}
// These signatures supply no executable codec, transaction or runtime membership check.
// A production factory must not accept SyntheticRealm, SyntheticWriteFrame or fake decisions.
