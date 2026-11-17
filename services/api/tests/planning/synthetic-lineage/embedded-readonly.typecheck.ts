/** Compile-only recursive readonly handoff regression; never invoke as a runtime test. */
import type { AnalysisResult } from '../../../src/integration/account-modules/index.js';
import type { FeedbackSignal, JsonValue } from '../../../src/training-feedback/index.js';
import type {
  FeedbackContextWitness, FeedbackCurrentView, FeedbackMutationResult,
} from '../../../src/training-feedback/ledger-types.js';
import type {
  AcceptedInputDispositionsV1, AttemptV1, Digest, EmbeddedSchema, ExactText,
  IsolatedSyntheticPortV1, NonEmpty, RecipeManifestV1, Revision, SafeNatural,
  SourceRevision, SynId, SyntheticCodecV1, SyntheticWriteFrame,
} from '../../../src/planning/synthetic-lineage/types.js';
import type {
  DecodedEmbeddedEvidenceV1, EmbeddedClosureInputV1, EmbeddedCodecIdentityV1,
  EmbeddedPayloadsV1, EmbeddedReadonly, ProducerCheckedClosureV1,
  SyntheticSubcodecBindingsV1,
} from '../../../src/planning/synthetic-lineage/subcodec-types.js';

type Assert<Check extends true> = Check;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assignable<A, B> = [A] extends [B] ? true : false;
type Not<Check extends boolean> = Check extends true ? false : true;

// Independent expected shape: do not derive expectations with EmbeddedReadonly.
type ReadonlyJson =
  | null | boolean | number | string
  | readonly ReadonlyJson[]
  | { readonly [key: string]: ReadonlyJson };
type JsonRead = EmbeddedReadonly<JsonValue>;
export type BroadJsonShape = Assert<Equal<JsonRead, ReadonlyJson>>;
export type BroadJsonToExpected = Assert<Assignable<JsonRead, ReadonlyJson>>;
export type ExpectedToBroadJson = Assert<Assignable<ReadonlyJson, JsonRead>>;
export type JsonIdempotent = Assert<Equal<EmbeddedReadonly<JsonRead>, ReadonlyJson>>;
export type ReadonlyJsonFixedPoint = Assert<Equal<EmbeddedReadonly<ReadonlyJson>, ReadonlyJson>>;

type ReportedValue = Extract<FeedbackSignal, { state: 'reported' }>['value'];
type ReportedRead = EmbeddedReadonly<ReportedValue>;
export type ReportedExcludesNull = Assert<Not<Assignable<null, ReportedRead>>>;
export type ReportedExcludesUndefined = Assert<Not<Assignable<undefined, ReportedRead>>>;
export type ReportedAllowsNestedNull = Assert<Assignable<
  { nested: [null, { deeper: null }] }, ReportedRead
>>;
export type OptionalJson = Assert<Equal<EmbeddedReadonly<JsonValue | undefined>, ReadonlyJson | undefined>>;
export type JsonArray = Assert<Equal<EmbeddedReadonly<JsonValue[]>, readonly ReadonlyJson[]>>;
export type JsonDictionary = Assert<Equal<
  EmbeddedReadonly<{ [key: string]: JsonValue }>, { readonly [key: string]: ReadonlyJson }
>>;
export type NeverPreserved = Assert<Equal<EmbeddedReadonly<never>, never>>;
export type ReadonlyArray = Assert<Equal<EmbeddedReadonly<readonly JsonValue[]>, readonly ReadonlyJson[]>>;
export type ReadonlyArrayIdempotent = Assert<Equal<
  EmbeddedReadonly<readonly ReadonlyJson[]>, readonly ReadonlyJson[]
>>;
export type ArrayHasNoPush = Assert<Not<Assignable<'push', keyof EmbeddedReadonly<JsonValue[]>>>>;

type Narrow = {
  kind: 'narrow'; id: SynId<'realm'>; data: JsonValue;
  optional?: ExactText; pair: [SafeNatural, ExactText?];
};
type ExpectedNarrow = {
  readonly kind: 'narrow'; readonly id: SynId<'realm'>; readonly data: ReadonlyJson;
  readonly optional?: ExactText; readonly pair: readonly [SafeNatural, ExactText?];
};
type NarrowRead = EmbeddedReadonly<Narrow>;
export type NarrowExact = Assert<Equal<NarrowRead, ExpectedNarrow>>;
export type MissingIdRejected = Assert<Not<Assignable<Omit<ExpectedNarrow, 'id'>, NarrowRead>>>;
export type WrongKindRejected = Assert<Not<Assignable<
  Omit<ExpectedNarrow, 'kind'> & { kind: 'other' }, NarrowRead
>>>;
export type RawIdRejected = Assert<Not<Assignable<
  Omit<ExpectedNarrow, 'id'> & { id: string }, NarrowRead
>>>;
export type ExplicitUndefinedRejected = Assert<Not<Assignable<
  Omit<ExpectedNarrow, 'optional'> & { optional: undefined }, NarrowRead
>>>;
export type EmptyPairRejected = Assert<Not<Assignable<readonly [], NarrowRead['pair']>>>;
export type LongPairRejected = Assert<Not<Assignable<
  readonly [SafeNatural, ExactText, ExactText], NarrowRead['pair']
>>>;
export type WrongPairMemberRejected = Assert<Not<Assignable<
  readonly [SafeNatural, SafeNatural], NarrowRead['pair']
>>>;
export type PairHasNoPush = Assert<Not<Assignable<'push', keyof NarrowRead['pair']>>>;
export type LiteralUnion = Assert<Equal<EmbeddedReadonly<false | 0 | 'pinned'>, false | 0 | 'pinned'>>;

type Correlated = { kind: 'realm'; value: SynId<'realm'> } | { kind: 'count'; value: SafeNatural };
type ExpectedCorrelated =
  | { readonly kind: 'realm'; readonly value: SynId<'realm'> }
  | { readonly kind: 'count'; readonly value: SafeNatural };
export type CorrelationExact = Assert<Equal<EmbeddedReadonly<Correlated>, ExpectedCorrelated>>;
export type CrossedUnionRejected = Assert<Not<Assignable<
  { kind: 'realm'; value: SafeNatural }, EmbeddedReadonly<Correlated>
>>>;

declare const marker: unique symbol;
type Marked = { tag: 'narrow'; nested: { count: SafeNatural }; readonly [marker]: 'fixture' };
type ExpectedMarked = {
  readonly tag: 'narrow'; readonly nested: { readonly count: SafeNatural };
  readonly [marker]: 'fixture';
};
type MarkedRead = EmbeddedReadonly<Marked>;
export type ObjectBrandExact = Assert<Equal<MarkedRead, ExpectedMarked>>;
export type ObjectBrandKeys = Assert<Equal<keyof MarkedRead, 'tag' | 'nested' | typeof marker>>;
export type ObjectBrandLiteral = Assert<Equal<MarkedRead[typeof marker], 'fixture'>>;
export type UnbrandedObjectRejected = Assert<Not<Assignable<
  { tag: 'narrow'; nested: { count: SafeNatural } }, MarkedRead
>>>;

export type RealmBrandExact = Assert<Equal<EmbeddedReadonly<SynId<'realm'>>, SynId<'realm'>>>;
export type DigestExact = Assert<Equal<EmbeddedReadonly<Digest>, Digest>>;
export type TextExact = Assert<Equal<EmbeddedReadonly<ExactText>, ExactText>>;
export type SourceRevisionExact = Assert<Equal<EmbeddedReadonly<SourceRevision>, SourceRevision>>;
export type NaturalExact = Assert<Equal<EmbeddedReadonly<SafeNatural>, SafeNatural>>;
export type NullableScalar = Assert<Equal<
  EmbeddedReadonly<ExactText | null | undefined>, ExactText | null | undefined
>>;
export type RawRealmRejected = Assert<Not<Assignable<string, EmbeddedReadonly<SynId<'realm'>>>>>;
export type AccountAsRealmRejected = Assert<Not<Assignable<SynId<'account'>, EmbeddedReadonly<SynId<'realm'>>>>>;
export type TextAsDigestRejected = Assert<Not<Assignable<ExactText, EmbeddedReadonly<Digest>>>>;
export type RawNaturalRejected = Assert<Not<Assignable<number, EmbeddedReadonly<SafeNatural>>>>;
export type RevisionDomainRejected = Assert<Not<Assignable<
  ProducerCheckedClosureV1['attempt']['intent']['originalActor']['epoch'], EmbeddedReadonly<Revision<'plan'>>
>>>;
export type FixedPairExact = Assert<Equal<
  EmbeddedReadonly<[SynId<'realm'>, { count: SafeNatural }]>,
  readonly [SynId<'realm'>, { readonly count: SafeNatural }]
>>;
export type ShortPairRejected = Assert<Not<Assignable<
  readonly [SynId<'realm'>], EmbeddedReadonly<[SynId<'realm'>, { count: SafeNatural }]>
>>>;
export type NonemptyExact = Assert<Equal<EmbeddedReadonly<NonEmpty<SynId<'realm'>>>, NonEmpty<SynId<'realm'>>>>;
export type EmptyNonemptyRejected = Assert<Not<Assignable<readonly [], EmbeddedReadonly<NonEmpty<SynId<'realm'>>>>>>;
export type NonemptyHasNoPush = Assert<Not<Assignable<'push', keyof EmbeddedReadonly<NonEmpty<SynId<'realm'>>>>>>;
export type UncheckedClosureRejected = Assert<Not<Assignable<EmbeddedClosureInputV1, ProducerCheckedClosureV1>>>;
export type WrongPayloadRejected = Assert<Not<Assignable<
  EmbeddedPayloadsV1['synthetic.registration-manifest/v1'],
  EmbeddedPayloadsV1['synthetic.accepted-input-dispositions/v1']
>>>;

type FullRead = EmbeddedPayloadsV1['synthetic.training-feedback-analysis.pinned-v1'];
export type MutationIsNotRead = Assert<Not<Assignable<AnalysisResult<FeedbackMutationResult>, FullRead>>>;
export type ContextIsNotRead = Assert<Not<Assignable<AnalysisResult<FeedbackContextWitness>, FullRead>>>;
export type PartialIsNotRead = Assert<Not<Assignable<AnalysisResult<Pick<FeedbackCurrentView, 'records'>>, FullRead>>>;

type ExpectedSchemas =
  | 'synthetic.training-feedback-analysis.pinned-v1'
  | 'synthetic.feedback-comparison-lineage.pinned-v1'
  | 'synthetic.comparison-witness.pinned-v2'
  | 'synthetic.registration-manifest/v1'
  | 'synthetic.accepted-input-dispositions/v1';
export type ExactlyFiveSchemas = Assert<Equal<EmbeddedSchema, ExpectedSchemas>>;
export type ExactlyFivePayloads = Assert<Equal<keyof EmbeddedPayloadsV1, ExpectedSchemas>>;
export type PayloadsExhaustSchemas = Assert<Equal<keyof EmbeddedPayloadsV1, EmbeddedSchema>>;
type Codecs = SyntheticSubcodecBindingsV1['codecs'];
export type IncompleteCodecsRejected = Assert<Not<Assignable<
  Omit<Codecs, 'synthetic.comparison-witness.pinned-v2'>, Codecs
>>>;
export type SixthSchemaRejected = Assert<Not<Assignable<'synthetic.sixth/v1', EmbeddedSchema>>>;
type ReadEvidence = Extract<DecodedEmbeddedEvidenceV1, {
  identity: { schema: 'synthetic.training-feedback-analysis.pinned-v1' };
}>;
export type ReadEvidenceValue = Assert<Equal<ReadEvidence['value'], FullRead>>;
export type ReadEvidenceBlobSchema = Assert<Equal<
  ReadEvidence['blob']['schema'], 'synthetic.training-feedback-analysis.pinned-v1'
>>;
export type ReadEvidenceIdentity = Assert<Equal<
  ReadEvidence['identity'], EmbeddedCodecIdentityV1<'synthetic.training-feedback-analysis.pinned-v1'>
>>;
export type ComparisonLineageEvidenceValue = Assert<Equal<
  Extract<DecodedEmbeddedEvidenceV1, {
    identity: { schema: 'synthetic.feedback-comparison-lineage.pinned-v1' };
  }>['value'], EmbeddedPayloadsV1['synthetic.feedback-comparison-lineage.pinned-v1']
>>;
export type ComparisonWitnessEvidenceValue = Assert<Equal<
  Extract<DecodedEmbeddedEvidenceV1, {
    identity: { schema: 'synthetic.comparison-witness.pinned-v2' };
  }>['value'], EmbeddedPayloadsV1['synthetic.comparison-witness.pinned-v2']
>>;
export type RecipeEvidenceValue = Assert<Equal<
  Extract<DecodedEmbeddedEvidenceV1, {
    identity: { schema: 'synthetic.registration-manifest/v1' };
  }>['value'], EmbeddedPayloadsV1['synthetic.registration-manifest/v1']
>>;
export type DispositionsEvidenceValue = Assert<Equal<
  Extract<DecodedEmbeddedEvidenceV1, {
    identity: { schema: 'synthetic.accepted-input-dispositions/v1' };
  }>['value'], EmbeddedPayloadsV1['synthetic.accepted-input-dispositions/v1']
>>;
export type CrossedBlobRejected = Assert<Not<Assignable<
  Omit<ReadEvidence, 'blob'> & {
    blob: Omit<ReadEvidence['blob'], 'schema'> & { schema: 'synthetic.registration-manifest/v1' };
  }, DecodedEmbeddedEvidenceV1
>>>;
export type CrossedIdentityRejected = Assert<Not<Assignable<
  Omit<ReadEvidence, 'identity'> & {
    identity: EmbeddedCodecIdentityV1<'synthetic.registration-manifest/v1'>;
  }, DecodedEmbeddedEvidenceV1
>>>;
export type CrossedValueRejected = Assert<Not<Assignable<
  Omit<ReadEvidence, 'value'> & { value: RecipeManifestV1 }, DecodedEmbeddedEvidenceV1
>>>;

function recursiveJsonHandoff(canonical: JsonValue, mapped: JsonRead, expected: ReadonlyJson) {
  const read: JsonRead = canonical;
  const independent: ReadonlyJson = mapped;
  const back: JsonRead = expected;
  const nested: JsonRead = { nested: [null, true, 3, 'text', { deeper: [null] }] };
  const reported: ReportedRead = { nested: [null, { deeper: null }] };
  const repeated: EmbeddedReadonly<JsonRead> = mapped;
}

function scalarAndAttemptHandoff(
  checked: ProducerCheckedClosureV1, codec: SyntheticCodecV1,
  port: IsolatedSyntheticPortV1, frame: SyntheticWriteFrame,
  realm: EmbeddedReadonly<SynId<'realm'>>, digest: EmbeddedReadonly<Digest>,
  text: EmbeddedReadonly<ExactText>, sourceRevision: EmbeddedReadonly<SourceRevision>,
  natural: EmbeddedReadonly<SafeNatural>,
  embeddedRecipe: EmbeddedPayloadsV1['synthetic.registration-manifest/v1'],
  embeddedDispositions: EmbeddedPayloadsV1['synthetic.accepted-input-dispositions/v1'],
  mappedNonempty: EmbeddedReadonly<NonEmpty<SynId<'realm'>>>,
  mappedPair: EmbeddedReadonly<[SynId<'realm'>, { count: SafeNatural }]>,
) {
  const canonicalAttempt: AttemptV1 = checked.attempt;
  codec.encodeAttempt(checked.attempt);
  port.submit(frame, checked.attempt);
  const canonicalRealm: SynId<'realm'> = realm;
  const canonicalDigest: Digest = digest;
  const canonicalText: ExactText = text;
  const canonicalSourceRevision: SourceRevision = sourceRevision;
  const canonicalNatural: SafeNatural = natural;
  const methods: readonly [string, string, string] = [realm.toUpperCase(), text.trim(), natural.toFixed()];
  const canonicalRecipe: RecipeManifestV1 = embeddedRecipe;
  const canonicalDispositions: AcceptedInputDispositionsV1 = embeddedDispositions;
  const recipeBack: EmbeddedPayloadsV1['synthetic.registration-manifest/v1'] = canonicalRecipe;
  const dispositionsBack: EmbeddedPayloadsV1['synthetic.accepted-input-dispositions/v1'] = canonicalDispositions;
  const nonempty: NonEmpty<SynId<'realm'>> = mappedNonempty;
  const first: SynId<'realm'> = mappedNonempty[0];
  const pair: readonly [SynId<'realm'>, { readonly count: SafeNatural }] = mappedPair;
}

function fullReadHandoff(canonical: AnalysisResult<FeedbackCurrentView>, consume: (read: FullRead) => void) {
  const fullRead: FullRead = canonical;
  consume(fullRead);
  const analysisContext: string = fullRead.analysis.contextId;
  const ledgerRevision: number = fullRead.result.ledgerRevision;
  const projectionRevision: number = fullRead.result.projectionRevision;
  const records = fullRead.result.records;
  const sources = fullRead.result.sources;
  for (const derivation of fullRead.result.derivations) {
    const value: ReadonlyJson = derivation.value;
    const blockedBy: readonly string[] = derivation.blockedBy;
    const comparisonLineage = derivation.comparisonLineage;
    const comparisonDependencies = derivation.comparisonDependencies;
  }
}

function readonlyRejections(
  narrow: NarrowRead, marked: MarkedRead,
  dictionary: EmbeddedReadonly<{ [key: string]: JsonValue }>,
) {
  // @ts-expect-error Intentional negative: tuple elements remain readonly.
  narrow.pair[0] = narrow.pair[0];
  // @ts-expect-error Intentional negative: mapped nested object properties remain readonly.
  marked.nested.count = marked.nested.count;
  // @ts-expect-error Intentional negative: mapped JSON dictionaries remain readonly.
  dictionary.field = null;
}
