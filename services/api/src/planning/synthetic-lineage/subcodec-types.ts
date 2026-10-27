/**
 * Type-only injection contract for isolated synthetic evidence. Training supplies
 * the embedded decoders and semantic guard; Platform supplies the strict outer
 * parser, canonical encoding, hashes and correlation. No binding is installed.
 */
import type { AnalysisResult } from '../../integration/account-modules/index.js';
import type { FeedbackComparisonLineage, FeedbackCurrentView } from '../../training-feedback/ledger-types.js';
import type { FreshComparisonWitness } from '../../progress-comparison/persistence-types.js';
import type {
  AcceptedInputDispositionsV1, AttemptV1, Decode, Digest, EmbeddedSchema,
  EvidenceBlobV1, ExactText, NonEmpty, RecipeManifestV1, SourceRevision,
} from './types.js';

export type EmbeddedReadonly<T> = T extends object
  ? { readonly [K in keyof T]: EmbeddedReadonly<T[K]> }
  : T;

// The constraint makes a new EmbeddedSchema arm require an explicit full payload.
type ExhaustivePayloads<P extends { [S in EmbeddedSchema]: object }> = {
  readonly [S in EmbeddedSchema]: EmbeddedReadonly<P[S]>;
};

export type EmbeddedPayloadsV1 = ExhaustivePayloads<{
  'synthetic.training-feedback-analysis.pinned-v1': AnalysisResult<FeedbackCurrentView>;
  'synthetic.feedback-comparison-lineage.pinned-v1': FeedbackComparisonLineage;
  'synthetic.comparison-witness.pinned-v2': FreshComparisonWitness;
  'synthetic.registration-manifest/v1': RecipeManifestV1;
  'synthetic.accepted-input-dispositions/v1': AcceptedInputDispositionsV1;
}>;

type CheckpointSource<P extends string, B extends string> = Readonly<{
  repository: 'Jones-Systems/lift';
  revision: 'c203aadd49592011a39c1344b0016ca191a3f007';
  path: P;
  gitBlob: B;
}>;

/** Source identity only; these pins neither export nor bind existing decoders. */
export type EmbeddedSourcePinsV1 = Readonly<{
  clientDecoder: CheckpointSource<'apps/form/src/api/training-feedback.ts',
    '82d76013a16face4f8ea8d9b4ec672edce8038b1'>;
  analysis: CheckpointSource<'services/api/src/integration/account-modules/index.ts',
    '94cad393f631eaedb06f5b4c2155e0432faf6781'>;
  feedback: CheckpointSource<'services/api/src/training-feedback/index.ts',
    '34595d826c39c0f742022f861cfb988fd4c67892'>;
  ledger: CheckpointSource<'services/api/src/training-feedback/ledger-types.ts',
    '087e0ebd27f38f525fa965cf4d0f1854c18edcba'>;
  comparisonInputs: CheckpointSource<'services/api/src/training-feedback/comparison-inputs.ts',
    '3e03c9ad4a3879de14613c23a4888dc21482993f'>;
  witness: CheckpointSource<'services/api/src/progress-comparison/persistence-types.ts',
    '7ccb97b83b2d407e64c9602e4a46fa67dd747d02'>;
  comparison: CheckpointSource<'services/api/src/progress-comparison/index.ts',
    '608aa113379c6beb4caed9f945d9ff375a08d2ff'>;
}>;

export type SyntheticImplementationPinV1 = Readonly<{
  repository: 'Jones-Systems/lift' | 'Jones-Systems/Form';
  revision: SourceRevision;
  path: ExactText;
  sha256: Digest;
}>;

export type EmbeddedCodecIdentityV1<S extends EmbeddedSchema> = Readonly<{
  schema: S;
  implementation: SyntheticImplementationPinV1;
  subcodecDigest: Digest;
  sources: EmbeddedSourcePinsV1;
}>;

/**
 * Implementations must reject duplicate decoded keys, invalid UTF-8/surrogates,
 * extra/missing fields, unknown versions and all pinned field/budget violations.
 * They must preserve the entire payload, including nullability, blockedBy,
 * association, performed-work identity/load/missingness/units and revisions.
 * The outer codec must enforce aggregate budgets and exact canonical re-encoding;
 * a legacy object decoder alone does not satisfy this byte-seam contract.
 */
export interface EmbeddedSubcodecV1<S extends EmbeddedSchema> {
  readonly identity: EmbeddedCodecIdentityV1<S>;
  readonly decodeStrict: (bytes: Uint8Array) => Decode<EmbeddedPayloadsV1[S]>;
  // Encoding revalidates detached plain data, never trusts a TypeScript assertion.
  readonly validateForEncoding: (value: unknown) => Decode<EmbeddedPayloadsV1[S]>;
}

/** Distributive union retains schema/value correlation for every evidence blob. */
export type DecodedEmbeddedEvidenceV1 = {
  [S in EmbeddedSchema]: Readonly<{
    blob: EvidenceBlobV1 & Readonly<{ schema: S }>;
    identity: EmbeddedCodecIdentityV1<S>;
    value: EmbeddedPayloadsV1[S];
  }>;
}[EmbeddedSchema];

export type EmbeddedClosureInputV1 = Readonly<{
  attempt: EmbeddedReadonly<AttemptV1>;
  evidence: NonEmpty<DecodedEmbeddedEvidenceV1>;
}>;

declare const semanticClosure: unique symbol;
/** Local semantic-check result only; never a policy grant, frame or commit proof. */
export type ProducerCheckedClosureV1 = EmbeddedClosureInputV1 & Readonly<{
  [semanticClosure]: 'synthetic-producer-closure/v1';
}>;

/**
 * Must check complete cross-payload meaning: original associations and record
 * bindings; source/item mapping and registration; recipe graph/executable pins;
 * registry inputs, lineage and witnesses; all dependency coverage; and used input
 * dispositions (keep and qualified). Missing/blocked/unqualified evidence fails.
 * This pure guard cannot establish live currentness, realm/decision membership,
 * rights, retention or transaction effects; trusted composition must check those.
 * Output retains the full attempt/evidence, not a summary or authority boolean.
 */
export interface SyntheticProducerGuardV1 {
  readonly implementation: SyntheticImplementationPinV1;
  readonly validateClosure: (input: EmbeddedClosureInputV1) => Decode<ProducerCheckedClosureV1>;
}

/**
 * A later isolated composition must bind this complete, fixed table to reviewed
 * implementation bytes and compare each blob's schema/subcodecDigest. Neither
 * request data nor a caller-selected allowlist may choose a codec. Absence of any
 * required decoder/guard leaves qualified recommendation/submit unavailable.
 * These readonly declarations do not freeze objects or enforce any checks.
 */
export type SyntheticSubcodecBindingsV1 = Readonly<{
  schema: 'form.synthetic-subcodec-bindings/v1';
  codecs: { readonly [S in EmbeddedSchema]: EmbeddedSubcodecV1<S> };
  producer: SyntheticProducerGuardV1;
}>;
