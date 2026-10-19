import type { Sqlite } from '../storage.js';
import type { AccountContext, LifecycleBindings, LifecycleResult } from '../lifecycle/types.js';
import type { ReportInput, TrustedBinding } from './schemas.js';
import type { BugTriageSource } from './triage.js';
import type { BugOutcomeSource } from './outcome.js';

export type ReportState = 'received' | 'prepared' | 'dispatch_unavailable' | 'dispatch_unknown' | 'dispatched';
export type BugReport = Readonly<ReportInput & { id: string; state: ReportState; createdAt: string; dispatchReceiptId?: string }>;
export type PreparedHandoff = Readonly<{
  handoffId: string;
  binding: TrustedBinding;
  report: Readonly<{ kind: 'untrusted_user_report'; content: ReportInput }>;
}>;
export type DispatchOutcome = Readonly<{ status: 'accepted'; receiptId: string } | { status: 'known_no_effect' | 'unknown' }>;
export type BugIntakeDependencies = Readonly<{
  db: Sqlite;
  lifecycle: LifecycleBindings;
  now?: () => Date;
  triage?: BugTriageSource;
  outcomeSource?: BugOutcomeSource;
  lifecycleControl?: Readonly<{
    assertSuppression: (accountId: string, epoch: number) => void;
    purgeReadiness: (requestId: string, accountId: string) => { status: 'ready'; epoch: number } | LifecycleResult;
  }>;
  // Composition owns authority. Neither report text nor a caller-supplied body establishes execution scope.
  authority?: Readonly<{
    bindingFor: (context: AccountContext, reportId: string) => TrustedBinding | null;
    assertCurrent: (context: AccountContext, reportId: string, binding: TrustedBinding) => void;
  }>;
  dispatch?: Readonly<{ submit: (handoff: PreparedHandoff) => Promise<DispatchOutcome> }>;
}>;
