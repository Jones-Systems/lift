export type FamilyPolicy = {
  totalSeats: number;
  ownerIncluded: true;
  commercialActivation: 'unavailable';
};

export type FamilySnapshot = {
  kind: 'commercial_family';
  familyId: string;
  revision: string;
  ownerAccountId: string;
  totalSeats: number;
  members: { accountId: string; role: 'owner' | 'member' }[];
  pendingInvitations: { invitationId: string; inviteeAccountId: string }[];
  entitlement: { accountId: string; status: 'active' | 'inactive' | 'unknown' };
};

type FamilyRevision = { familyId: string; expectedRevision: string };
export type FamilyCommand =
  | { type: 'create' }
  | { type: 'accept'; invitationId: string }
  | (FamilyRevision & { type: 'invite'; inviteeAccountId: string })
  | (FamilyRevision & { type: 'revoke'; invitationId: string })
  | (FamilyRevision & { type: 'remove'; memberAccountId: string })
  | (FamilyRevision & { type: 'leave' });

export type FamilyRequest = { command: FamilyCommand; idempotencyKey: string };
export type FamilyOutcome =
  | { status: 'applied'; receiptId: string }
  | { status: 'rejected' | 'unknown'; code: string };
export type FamilyResponse<T> = { accountId: string; generation: string; value: T };
export type FamilyInvitation = { invitationId: string; familyId: string; ownerAccountId: string };

export interface FamilySession {
  accountId: string;
  generation: string;
  isCurrent(): boolean;
  read(): Promise<FamilyResponse<FamilySnapshot | null>>;
  invitations?(): Promise<FamilyResponse<FamilyInvitation[]>>;
  command(request: FamilyRequest): Promise<FamilyResponse<FamilyOutcome>>;
  /** Read the original command's receipt; never replay or submit it as another account. */
  reconcile(request: FamilyRequest): Promise<FamilyResponse<FamilyOutcome>>;
}

export interface FamilyPorts {
  /** Capture account and generation synchronously; every callback remains bound to that auth context. */
  captureSession(): FamilySession | null;
  newIdempotencyKey(): string;
}

export type FamilyState = {
  status: 'unavailable' | 'loading' | 'ready' | 'submitting' | 'unknown' | 'failed';
  snapshot: FamilySnapshot | null;
  reason: string | null;
};
export type FamilyRecovery = {
  accountId: string;
  generation: string;
  request: FamilyRequest;
  receiptId: string | null;
};
