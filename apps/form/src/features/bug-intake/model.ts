import type { BugDiagnostics, BugReport, BugReportStatus } from '../../api/bugIntake';

export type BugDraft = Readonly<{ title: string; description: string; diagnosticConsent: boolean; diagnostics?: BugDiagnostics }>;
export type BugIntakePhase = 'editing' | 'submitting' | 'submitted' | 'submission_unknown' | 'rejected' | 'unavailable';
export type BugIntakeReason = 'invalid_input' | 'submission_unconfirmed' | 'submission_rejected' | 'idempotency_conflict' | 'report_limit'
  | 'session_changed' | 'disposed' | 'authentication_required' | 'account_disabled' | 'read_unavailable';
export type BugIntakeState = Readonly<{
  phase: BugIntakePhase;
  draft: BugDraft;
  submitted: BugReport | null;
  reports: readonly BugReport[];
  selected: BugReport | null;
  reading: boolean;
  reason: BugIntakeReason | null;
  readReason: 'read_unavailable' | null;
  originalEffectUnknown: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  canRetrySubmission: boolean;
}>;
export const emptyBugDraft = (): BugDraft => ({ title: '', description: '', diagnosticConsent: false });
export const reportStatusCopy: Readonly<Record<BugReportStatus, string>> = Object.freeze({
  received: 'Report received.',
  prepared: 'Report handoff prepared.',
  dispatch_unavailable: 'Report received. Further routing is unavailable.',
  dispatch_unknown: 'Report received. The routing result is unconfirmed.',
  dispatched: 'Report handed off. This does not confirm a fix.',
});
export const bugIntakeCopy = Object.freeze({
  privacy: 'Only include details needed to describe the bug. Do not include passwords, health records, or other private information.',
  diagnostics: 'Optional technical details include only the app version, platform, build number, and screen.',
  unknown: 'We could not confirm whether your report was received. Retry this same report without changing it.',
  sessionChanged: 'This account session ended. Check reports in the original account before sending again.',
});
