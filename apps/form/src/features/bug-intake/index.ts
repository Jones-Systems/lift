export { BugIntakeController, type BugIntakePort } from './controller';
export { createBugIntakeSession, type BugIntakeSession, type BugIntakeSessionBinding } from './session';
export { bugIntakeCopy, reportStatusCopy, type BugDraft, type BugIntakePhase, type BugIntakeReason, type BugIntakeState } from './model';
export { BugIntakeResources, bugReportLimits } from '../../api/bugIntake';
export type { BugDiagnostics, BugReportInput, CanonicalBugReportInput, BugReportStatus, BugReport, BugSubmission, BugReportQuery } from '../../api/bugIntake';
export { createBugIntakeFlow, type BugIntakeFlow, type BugIntakeFlowBinding, type BugIntakeFlowState, type BugReportReview } from './flow';
export { createBugOutcomeConsumer, parseBugReporterOutcome, type BugReporterOutcomeStatus, type BugReporterOutcome, type BugReporterOutcomePort,
  type BugOutcomeConsumerBinding, type BugOutcomeConsumerState, type BugOutcomeConsumer } from './outcome';
