import type { Sqlite } from '../storage.js';
import type { AccountContext, LifecycleBindings } from '../lifecycle/types.js';
export type { AccountContext } from '../lifecycle/types.js';

export type FamilyCommand =
  | { type: 'create' }
  | { type: 'accept'; invitationId: string }
  | { type: 'invite'; familyId: string; expectedRevision: string; inviteeAccountId: string }
  | { type: 'revoke'; familyId: string; expectedRevision: string; invitationId: string }
  | { type: 'remove'; familyId: string; expectedRevision: string; memberAccountId: string }
  | { type: 'leave'; familyId: string; expectedRevision: string };
export type FamilyRequest = { command: FamilyCommand; idempotencyKey: string };
export type FamilyOutcome = { status: 'applied'; receiptId: string } | { status: 'rejected' | 'unknown'; code: string };
export type FamilySnapshot = {
  kind: 'commercial_family'; familyId: string; revision: string; ownerAccountId: string; totalSeats: number;
  members: { accountId: string; role: 'owner' | 'member' }[];
  pendingInvitations: { invitationId: string; inviteeAccountId: string }[];
  entitlement: { accountId: string; status: 'active' | 'inactive' | 'unknown' };
};
export type FamilyInvitation = { invitationId: string; familyId: string; ownerAccountId: string };
export type TrustedFamilyGrant = {
  familyId: string; ownerAccountId: string; status: 'active';
  grant: { id: string; entitlement: string; grantedAt: string; expiresAt: string | null; environment: string };
};
export type FamilyGrantContribution = TrustedFamilyGrant['grant'] & {
  accountId: string; source: 'family'; sourceId: string; active: true;
};
export type FamilyDependencies = {
  db: Sqlite;
  lifecycle: Pick<LifecycleBindings, 'assertActive' | 'withActiveWrite'>;
  subjectActive(accountId: string): boolean;
  totalSeats?: number;
  /** Trusted server composition only; social membership and client flags are never grant sources. */
  entitlement?: { read(ownerAccountId: string, familyId: string): TrustedFamilyGrant | { status: 'inactive' | 'unavailable' } };
};
