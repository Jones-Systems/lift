import type Database from 'better-sqlite3';

import type { AccountContext, AdultEligibility, LifecycleBindings } from '../lifecycle/types.js';
export type { AccountContext, AdultEligibility, LifecycleBindings } from '../lifecycle/types.js';
export type CommunityActor = AccountContext;
export const shareFields = ['participation', 'workout', 'exerciseSnack', 'planAdherence', 'workoutMinutes', 'exerciseCount', 'streakDays'] as const;
export type ShareField = typeof shareFields[number];
export type OwnShareFlags = Record<ShareField, boolean>;
export type OwnShare = { revision: number; flags: OwnShareFlags; enabledAt: Partial<Record<ShareField, string>> };
export const activityFields = ['workout', 'exerciseSnack', 'planAdherence', 'workoutMinutes', 'exerciseCount', 'streakDays'] as const;
export type ActivityField = typeof activityFields[number];
export type CommunityActivityReadInput = Readonly<{
  subjectAccountId: string; from: string; to: string; fields: readonly ActivityField[];
}>;
export type CommunityActivityAuthorization = Readonly<{
  subjectAccountId: string;
  assertAuthorized: (input: CommunityActivityReadInput) => void;
  assertSubjectActive: () => void;
}>;
export type CommunityActivityReaderFactory = (authorization: CommunityActivityAuthorization) => ActivityCommunityReader;
export type RecordedStatus = 'recorded' | 'not_recorded' | 'unknown';
export type AdherenceStatus = 'met' | 'not_met' | 'pending' | 'unknown' | 'not_applicable';
export type ActivityCommunityDay = Readonly<{
  localDate: string; timeZone: string; dayStartAt: string; dayEndAt: string; revision: number;
  workout?: RecordedStatus; exerciseSnack?: RecordedStatus; planAdherence?: AdherenceStatus;
  workoutMinutes?: number; exerciseCount?: number; streakDays?: number;
}>;
export type ActivityCommunityReader = {
  readDays(input: { subjectAccountId: string; from: string; to: string; fields: readonly ActivityField[] }):
    { status: 'available'; days: readonly ActivityCommunityDay[] } | { status: 'unavailable' };
};
export type CommunityParentHooks = Readonly<{
  assertPairVisible: (actor: AccountContext, groupId: string, subjectAccountId: string) => void;
  guardLegacy: (actor: AccountContext, groupId: string,
    action: 'issue_invitation' | 'join' | 'remove' | 'role' | 'reinvite' | 'rename' | 'read', targetAccountId?: string) => void;
  authorizeGroupText: (actor: AccountContext, purpose: 'alias' | 'profile', text: string) => void;
  beforeFriendIssue?: (actor: AccountContext, groupId: string, reservationId: string) => void;
  bindFriendInvitation?: (actor: AccountContext, groupId: string, reservationId: string, invitationId: string) => void;
  beforeReservedJoin?: (actor: AccountContext, groupId: string, invitationId: string) => void;
  consumeReservedJoin?: (actor: AccountContext, groupId: string, invitationId: string) => void;
  afterMemberEnds: (groupId: string, accountId: string) => void;
  afterGroupCloses: (groupId: string) => void;
}>;
export type CommunityDependencies = {
  db: Database.Database;
  now: () => Date;
  lifecycle?: LifecycleBindings | undefined;
  subjectEligibility?: ((accountId: string) => AdultEligibility) | undefined;
  assertRateLimit?: (context: AccountContext, action: 'invitation_attempt' | 'invitation_issue') => void;
  extension?: CommunityParentHooks;
  activity?: ActivityCommunityReader;
  activityFor?: CommunityActivityReaderFactory;
};
export type GroupView = { id: string; name: string; revision: number; role: 'owner' | 'admin' | 'member'; memberId: string };
export type MemberView = { memberId: string; alias: string; role: 'owner' | 'admin' | 'member'; revision: number };
export type InvitationView = {
  id: string; groupId: string; revision: number; createdAt: string; expiresAt: string;
  state: 'pending' | 'redeemed' | 'revoked' | 'expired'; tokenAvailable: false;
};
export type IssuedInvitation = Omit<InvitationView, 'tokenAvailable'> & ({ tokenAvailable: true; token: string } | { tokenAvailable: false });
export type SharedDay = { localDate: string; participation?: RecordedStatus; workout?: RecordedStatus; exerciseSnack?: RecordedStatus;
  planAdherence?: AdherenceStatus; workoutMinutes?: number; exerciseCount?: number; streakDays?: number };
export type CommunitySummary = { summaryStatus: 'available' | 'unavailable'; members: { memberId: string; alias: string; days: SharedDay[] }[] };
export type CommunityCounts = { groups: number; memberships: number; sharing: number; invitations: number; receipts: number };
export type AuthoritativeRestoreState = { ready: true; lookup: (accountId: string) => { state: 'active' | 'suppressed'; epoch: number } | undefined };

export type RemovedMembershipView = Readonly<{ groupId: string; memberId: string; membershipGeneration: number; removedAt: string | null;
  groupLabel: Readonly<{ status: 'available'; value: string } | { status: 'unavailable' }> }>;
