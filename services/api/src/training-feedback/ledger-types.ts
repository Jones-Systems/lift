import type { AccountContext, LifecycleBindings, LifecycleResult } from '../lifecycle/types.js';
import type { Sqlite } from '../storage.js';
import type { SessionSelection } from '../progress-comparison/index.js';
import type { ComparisonRead, ComparisonSelection, FreshComparisonWitness } from '../progress-comparison/persistence-types.js';
import type { ProgressComparisonService } from '../progress-comparison/service.js';
import type { DerivationSpec, DerivedFeedback, FeedbackEvent, FeedbackRecord, FeedbackReceipt, FeedbackScope, JsonValue, SourceReference } from './index.js';
import type { FeedbackSessionSource } from './session-source.js';

export type NonDeletionEvent = FeedbackEvent & { kind: Exclude<FeedbackEvent['kind'], 'delete'> };
export type FeedbackContextWitness = Readonly<{
  contextId: string;
  profileRevision: number;
  preferencesRevision: number;
  sessionSource: FeedbackSessionSource | null;
  targetPlan: Readonly<{ id: string; revision: number; archived: boolean }> | null;
}>;
export type FeedbackWitnessRequest = Readonly<{ scope: FeedbackScope; selection: SessionSelection | null }>;
// WS01 supplies current context identity and actual Domain reads in the already active same-DB transaction.
export type ReadFeedbackContextWithinWrite = (context: AccountContext, request: FeedbackWitnessRequest) => FeedbackContextWitness;
export type FeedbackBinding = FeedbackWitnessRequest & Readonly<{ witness: FeedbackContextWitness }>;
export type FeedbackLedgerEntry = Readonly<{
  sequence: number;
  event: NonDeletionEvent;
  beforeBinding: FeedbackBinding | null;
  afterBinding: FeedbackBinding | null;
}>;
export type FeedbackSourceState = Readonly<{
  recordId: string;
  state: 'current' | 'changed' | 'missing' | 'unbound';
  binding: FeedbackBinding | null;
}>;
export type DeclaredComparison = Readonly<{ id: string; contextId: string; selections: ComparisonSelection }>;
export type FeedbackComparisonRegistry = Readonly<{
  schema: 'feedback-comparison-inputs-v1'; version: string; inputs: readonly DeclaredComparison[];
}>;
export type ReadComparisonWithinWrite = ProgressComparisonService['readForDerivationWithinWrite'];
export type ComparisonAssociationRequest = Readonly<{
  recipe: Pick<DerivationSpec, 'id' | 'version' | 'kind' | 'scope'>;
  declaration: DeclaredComparison;
  witness: FreshComparisonWitness;
  feedback: readonly Readonly<{ record: FeedbackRecord; binding: FeedbackBinding | null }>[];
}>;
export type ComparisonAssociation = Readonly<{
  status: 'associated'; evidenceToken: string; sourceRefs: readonly SourceReference[];
}> | Readonly<{ status: 'unavailable'; reason: 'association_unproved' }>;
export type AssociateComparisonWithinWrite = (context: AccountContext, input: ComparisonAssociationRequest) => ComparisonAssociation;
export type ComparableFeedbackInput = Omit<FreshComparisonWitness, 'result'> & Readonly<{
  result: Extract<FreshComparisonWitness['result'], { status: 'comparable' }>;
}>;
export type FeedbackDerivationSpec = Omit<DerivationSpec, 'compute'> & {
  comparisonIds?: readonly string[];
  compute(input: { sources: FeedbackRecord[]; parents: DerivedFeedback[];
    comparisons: Readonly<Record<string, ComparableFeedbackInput>> }): JsonValue;
};
export type FeedbackComparisonLineage = Readonly<{
  registryVersion: string | null; registryDigest: string;
  recipeId: string; recipeVersion: string; inputId: string;
  declaration: DeclaredComparison | null; producer: ComparisonRead | null;
  association: ComparisonAssociation | null; blockedBy: readonly string[];
}>;
export type FeedbackSourceKey = Readonly<{ kind: 'context' | 'session' | 'activity' | 'plan'; id: string }> | Readonly<{
  kind: 'comparisonIdentity'; sourceKind: 'session' | 'activity'; sourceId: string; itemId: string;
}>;
export type FeedbackDerivedResult = DerivedFeedback & {
  comparisonLineage: FeedbackComparisonLineage[];
  comparisonDependencies: FeedbackSourceKey[];
};
export type FeedbackStoredProjection = {
  records: FeedbackRecord[];
  derivations: FeedbackDerivedResult[];
  sources: FeedbackSourceState[];
};
export type FeedbackVersions = Readonly<{ ledgerRevision: number; projectionRevision: number }>;
export type FeedbackLedgerState = FeedbackVersions & Readonly<{
  entries: FeedbackLedgerEntry[];
  projection: FeedbackStoredProjection | null;
}>;
export type FeedbackMinimalReceipt = Pick<FeedbackReceipt, 'eventId' | 'recordId' | 'cause' | 'outcome' | 'revision' | 'reason'> & {
  acceptedLedgerRevision: number;
};
export type FeedbackStoredReceipt = Readonly<{
  eventId: string;
  intentDigest: string;
  receipt: FeedbackMinimalReceipt;
}>;
export type FeedbackLedgerReplacement = Readonly<{
  projection: FeedbackStoredProjection;
  entry?: FeedbackLedgerEntry;
  receipt?: FeedbackStoredReceipt;
  key?: Readonly<{ idempotencyKey: string; eventId: string }>;
}>;
export interface FeedbackLedgerStore {
  loadWithinWrite(context: AccountContext): FeedbackLedgerState;
  receiptWithinWrite(context: AccountContext, lookup: { eventId: string } | { idempotencyKey: string }): FeedbackStoredReceipt | null;
  replaceWithinWrite(context: AccountContext, expected: FeedbackVersions, replacement: FeedbackLedgerReplacement): FeedbackVersions;
  dependsOnWithinWrite(context: AccountContext, sources: readonly FeedbackSourceKey[]): boolean;
}
export type FeedbackStoreDependencies = Readonly<{
  db: Sqlite;
  lifecycle: Pick<LifecycleBindings, 'assertActive'>;
  assertWithinWrite(context: AccountContext): void;
}>;
export type FeedbackCommand = Readonly<{
  idempotencyKey: string;
  expectedLedgerRevision: number;
  event: NonDeletionEvent;
  selection: SessionSelection | null;
  // Required for record/correct/confirm; withdrawal and undo retain their historical binding.
  expectedWitness: FeedbackContextWitness | null;
}>;
export type FeedbackCurrentView = FeedbackVersions & FeedbackStoredProjection;
export type FeedbackMutationResult = Readonly<{ receipt: FeedbackMinimalReceipt; replayed: boolean; current: FeedbackCurrentView }>;
export interface FeedbackLedgerService {
  mutate(context: AccountContext, command: FeedbackCommand): FeedbackMutationResult;
  mutateWithinWrite(context: AccountContext, command: FeedbackCommand): FeedbackMutationResult;
  read(context: AccountContext): FeedbackCurrentView;
  invalidateWithinWrite(context: AccountContext, sources: readonly FeedbackSourceKey[]): FeedbackCurrentView;
}
export type FeedbackServiceDependencies = Readonly<{
  store: FeedbackLedgerStore;
  lifecycle: Pick<LifecycleBindings, 'assertActive' | 'withActiveWrite'>;
  readContextWithinWrite: ReadFeedbackContextWithinWrite;
  derivations: readonly FeedbackDerivationSpec[];
  derivationAuthorityWithinWrite(context: AccountContext, recipe: Readonly<{ id: string; version: string }>): boolean;
  comparisonRegistry?: FeedbackComparisonRegistry;
  readComparisonWithinWrite?: ReadComparisonWithinWrite;
  associateComparisonWithinWrite?: AssociateComparisonWithinWrite;
}>;
export type FeedbackLifecycleDependencies = Readonly<{
  db: Sqlite;
  lifecycle: Pick<LifecycleBindings, 'assertActive'>;
  control: Readonly<{
    assertSuppression(accountId: string, epoch: number): void;
    purgeReadiness(requestId: string, accountId: string): { status: 'ready'; epoch: number } | LifecycleResult;
  }>;
}>;
