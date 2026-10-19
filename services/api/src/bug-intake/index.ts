export { bugIntakeMigrationSql, bugIntakeOwnedTables, bugIntakePurgeOrder } from './migration.js';
export { createBugIntakeService, createBugIntakeServiceFactory, type BugIntakeService } from './service.js';
export { createBugIntakeRoutes, type BugIntakeRouteBindings } from './routes.js';
export { createBugIntakeLifecycleAdapter } from './lifecycle.js';
export { bugIntakeLimits } from './schemas.js';
export type { ReportInput, TrustedBinding } from './schemas.js';
export type * from './types.js';
export { createBugTriagePacket, bugReportFingerprint, bugTriageSnapshotFingerprint, bugTriageLimits } from './triage.js';
export type { BugInvestigationBinding, BugTriageSnapshotContent, RetainedBugTriageSnapshot, BugTriageRequest, BugTriageSource, BugTriageUnavailableReason, BugTriagePacket } from './triage.js';
export { bugEvidenceLimits, parseBugEvidenceCandidate, parseReviewedBugEvidence, bugEvidenceCandidateDigest,
  createBugTechnicalEvidence, assertBugTechnicalEvidenceCurrent } from './evidence.js';
export type { TechnicalFact, BugTechnicalExtract, BugEvidenceBinding, BugEvidenceRecipientPolicy, BugEvidenceCandidate,
  BugEvidenceReviewWitness, ReviewedBugEvidence, BugEvidenceSource, BugEvidenceAccess, BugEvidenceUnavailableReason, BugEvidenceResult } from './evidence.js';
export { bugOutcomeLimits, parseBugOutcomeSnapshot, bugOutcomeSnapshotDigest, createBugOutcomeView, createBugReporterOutcome } from './outcome.js';
export type { OutcomeEvidenceRef, BugOutcomeReference, BugOutcomeBinding, BugOwnerDecision, BugFixReadback, BugOutcomeSnapshotContent,
  BugOutcomeSnapshot, BugOutcomeSource, BugOutcomeReadOptions, BugOutcomeStatus, BugOutcomeView, BugReporterOutcome, BugReporterProjectionAuthority } from './outcome.js';
