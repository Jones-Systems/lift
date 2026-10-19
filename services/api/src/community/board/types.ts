import type Database from 'better-sqlite3';
import type { AccountContext, AdultEligibility, LifecycleBindings } from '../../lifecycle/types.js';
export type { AccountContext } from '../../lifecycle/types.js';
export const boardCategories = ['general', 'workouts', 'plans', 'coaching', 'accessibility', 'community', 'settings'] as const;
export const boardStatuses = ['submitted', 'under_consideration', 'planned', 'in_progress', 'released', 'not_planned'] as const;
export const BOARD_POLICY_VERSION = 'form_feature_board_v1';
export type BoardCategory = typeof boardCategories[number];
export type BoardStatus = typeof boardStatuses[number];
export type BoardVisibility = 'pending' | 'published' | 'hidden' | 'withdrawn';
export type FeatureView = Readonly<{
  id: string; title: string; description: string; category: BoardCategory; status: BoardStatus;
  statusReason: string | null; revision: number; createdAt: string; visibility: BoardVisibility;
  authorLabel: 'Form member'; voteCount: number; supported: boolean;
}>;
export type FeatureSubmissionView = Readonly<{
  id: string; featureId: string; canonicalFeatureId: string; title: string; description: string;
  category: BoardCategory; revision: number; visibility: BoardVisibility; createdAt: string;
  predecessorSubmissionId?: string; successorSubmissionId?: string;
}>;
export type OwnFeatureVote = Readonly<{ featureId: string; active: boolean; revision: number }>;
export type FeatureAliasResolution = Readonly<{
  requestedId: string; canonicalId: string; combined: boolean; feature: FeatureView;
  original?: Readonly<{ title: string; description: string }>;
}>;
export type BoardTextModeration = Readonly<{
  checkText: (input: Readonly<{ purpose: 'feature_board'; title: string; description: string; policyVersion: string }>) =>
    'allowed' | 'rejected' | 'pending' | 'unavailable';
}>;
export type BoardStaffedModeration = Readonly<{
  assertAuthorized: (actor: AccountContext, submissionId: string, action: 'publish' | 'hide') => void;
}>;
export type BoardSteward = Readonly<{
  assertAuthorized: (actor: AccountContext, featureIds: readonly string[], action: 'merge' | 'status') => void;
  assertReleasedEvidence: (actor: AccountContext, featureId: string, evidence: string) => void;
}>;
export type BoardSafety = Readonly<{
  report: (input: Readonly<{ actor: AccountContext; featureId: string; reason: 'harassment' | 'privacy' | 'unsafe' | 'other'; operationId: string }>) =>
    Readonly<{ receiptId: string; status: 'pending' }>;
}>;
export type BoardDependencies = Readonly<{
  db: Database.Database; now: () => Date; lifecycle?: LifecycleBindings;
  subjectEligibility?: (accountId: string) => AdultEligibility;
  isBlocked?: (viewer: AccountContext, authorAccountId: string) => boolean;
  textModeration?: BoardTextModeration; moderation?: BoardStaffedModeration; steward?: BoardSteward;
  safety?: BoardSafety;
  retention?: Readonly<{ assertPublicationQualified: (submissionId: string) => void }>;
  support?: Readonly<{ assertStaffed: () => void }>;
}>;
export type BoardRestoreAuthority = Readonly<{
  ready: true; lookup: (accountId: string) => Readonly<{ state: 'active' | 'suppressed'; epoch: number }> | undefined;
}>;
export type BoardCounts = Readonly<{ submissions: number; votes: number; voteEvents: number; receipts: number; quotas: number; stewardEvents: number; corrections: number }>;

export type FeatureCorrectionInput = Readonly<{
  expectedRevision: number; expectedCanonicalFeatureId: string;
  title: string; description: string; category: BoardCategory;
  policyVersion: typeof BOARD_POLICY_VERSION; policyAccepted: true; audienceAccepted: true;
}>;
export type FeatureCorrectionReceipt = Readonly<{
  schema: 'form.feature-board-correction/v1'; key: string; eventId: string;
  submissionId: string; featureId: string; expectedRevision: number; resultRevision: number;
  canonicalFeatureId: string; canonicalRevision: number;
  successor: Readonly<{ submissionId: string; featureId: string }>;
  replacement: Omit<FeatureCorrectionInput, 'expectedRevision' | 'expectedCanonicalFeatureId'>;
  createdAt: string;
}>;
export type FeatureCorrectionResult = Readonly<{ receipt: FeatureCorrectionReceipt; successor: FeatureSubmissionView | null }>;
