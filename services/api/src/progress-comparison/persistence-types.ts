import type { Domain } from '../domain.js';
import type { ActivityService } from '../activity/service.js';
import type { ExerciseRef } from '../activity/schemas.js';
import type { AccountContext, LifecycleResult } from '../lifecycle/types.js';
import type { Sqlite } from '../storage.js';
import type { ComparisonIdentity, IdentityBinding, SourceRef, ComparisonResult } from './index.js';

export type PerformedIdentity = { [K in keyof ComparisonIdentity]: ComparisonIdentity[K] | null };
export type IdentityProvenance = { kind: 'user_reported' } | {
  kind: 'source_native'; repo: string; revision: string; path: string; sha256: string; nativeId: string;
};
export type SourceSelection = Readonly<{ kind: SourceRef['kind']; id: string; itemId: string }>;
export type StoredIdentity = Readonly<{
  id: string; source: SourceRef; revision: number; status: 'confirmed' | 'withdrawn'; updatedAt: string;
  data: { exercise: ExerciseRef; identity: PerformedIdentity; provenance: IdentityProvenance } | null;
}>;
export type ComparisonSelection = Readonly<{ baseline: SourceSelection; current: SourceSelection }>;
export type ComparisonSourceScope = Readonly<{
  source: SourceRef & { kind: 'session' };
  exercise: ExerciseRef | null;
  session: { planId: string; planRevision: number; occurrence: { id: string; itemId: string; exerciseId: string } | null };
}> | Readonly<{
  source: SourceRef & { kind: 'activity' };
  exercise: ExerciseRef | null;
  session: null;
}>;
export type ComparisonInputWitness = Readonly<{
  scope: ComparisonSourceScope;
  identity: { id: string | null; revision: number | null; status: 'confirmed' | 'withdrawn' | 'missing'; current: boolean;
    state: 'missing' | 'withdrawn' | 'stale' | 'unqualified' | 'qualified' };
}>;
export type ComparisonContextInput = Readonly<{
  contextId: string; baseline: ComparisonSourceScope; current: ComparisonSourceScope;
}>;
export type AssertComparisonContextWithinWrite = (context: AccountContext, input: ComparisonContextInput) => void;
export type ComparisonRead = Readonly<{ status: 'observed'; witness: FreshComparisonWitness }> | Readonly<{
  status: 'unavailable'; reason: 'reader_unavailable' | 'source_missing' | 'item_missing'; side: 'baseline' | 'current';
}>;
export type FreshComparisonWitness = Readonly<{
  accountId: string; contextId: string;
  witnessVersion: 'progress-comparison-witness-v2';
  inputs: Readonly<{ baseline: ComparisonInputWitness; current: ComparisonInputWitness }>;
  scope: { baseline: SourceRef; current: SourceRef };
  bindings: readonly { id: string | null; revision: number | null; status: 'confirmed' | 'withdrawn' | 'missing'; current: boolean }[];
  sourceRefs: readonly { sourceId: string; revision: string; locator: string; qualification: string }[];
  result: ComparisonResult | (Pick<ComparisonResult, 'policy' | 'evidenceToken'> & { status: 'incomparable'; reasons: ['identity_provenance_mismatch'] });
  evidenceToken: string; interpretation: 'observed_work_only';
}>;
export type ProgressComparisonDependencies = Readonly<{
  db: Sqlite; domain: Domain; activity?: Pick<ActivityService, 'entry'>;
  // Authorization to retain metadata is separate from authority to treat it as comparable work.
  assertIdentityAllowed: (context: AccountContext, input: { source: SourceRef; exercise: ExerciseRef; identity: PerformedIdentity; provenance: IdentityProvenance }) => void;
  assertPersistable: (context: AccountContext, operation: 'confirm' | 'withdraw', validatedIntent: unknown) => void;
  comparisonBindingFor: (context: AccountContext, record: StoredIdentity) => IdentityBinding | null;
  // Legacy readers can omit this port; the production derivation reader requires it in an active writer.
  assertComparisonContextWithinWrite?: AssertComparisonContextWithinWrite;
  lifecycleControl: {
    assertSuppression: (accountId: string, epoch: number) => void;
    purgeReadiness: (requestId: string, accountId: string) => { status: 'ready'; epoch: number } | LifecycleResult;
  };
  now?: () => Date;
}>;
