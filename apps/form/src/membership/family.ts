import type {
  FamilyCommand, FamilyOutcome, FamilyPolicy, FamilyPorts, FamilyRecovery, FamilyRequest,
  FamilyResponse, FamilySession, FamilySnapshot, FamilyState,
} from './family.types';

export function familyPolicy(totalSeats = 5): FamilyPolicy {
  if (!Number.isSafeInteger(totalSeats) || totalSeats < 1) throw new RangeError('invalid_family_capacity');
  return { totalSeats, ownerIncluded: true, commercialActivation: 'unavailable' };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Structural consistency is not authorization; the server owns capacity, roles and paid access. */
export function isFamilySnapshot(value: unknown, accountId: string): value is FamilySnapshot {
  if (!record(value) || value.kind !== 'commercial_family' || !identity(value.familyId) || !identity(value.revision)
    || !identity(value.ownerAccountId) || !Number.isSafeInteger(value.totalSeats) || (value.totalSeats as number) < 1
    || !Array.isArray(value.members) || value.members.length > (value.totalSeats as number)
    || !Array.isArray(value.pendingInvitations) || !record(value.entitlement)
    || value.entitlement.accountId !== accountId || !['active', 'inactive', 'unknown'].includes(String(value.entitlement.status))) return false;
  const members = value.members;
  if (!members.every(member => record(member) && identity(member.accountId) && ['owner', 'member'].includes(String(member.role)))
    || new Set(members.map(member => member.accountId)).size !== members.length
    || members.filter(member => member.role === 'owner').length !== 1
    || !members.some(member => member.role === 'owner' && member.accountId === value.ownerAccountId)) return false;
  if (!value.pendingInvitations.every(invite => record(invite) && identity(invite.invitationId) && identity(invite.inviteeAccountId))
    || new Set(value.pendingInvitations.map(invite => invite.invitationId)).size !== value.pendingInvitations.length) return false;
  return value.entitlement.status !== 'active' || members.some(member => member.accountId === accountId);
}

export function occupiedFamilySeats(snapshot: FamilySnapshot): number {
  return snapshot.members.length;
}

function copySnapshot(value: FamilySnapshot): FamilySnapshot {
  return { kind: value.kind, familyId: value.familyId, revision: value.revision,
    ownerAccountId: value.ownerAccountId, totalSeats: value.totalSeats,
    members: value.members.map(member => ({ accountId: member.accountId, role: member.role })),
    pendingInvitations: value.pendingInvitations.map(invite => ({ invitationId: invite.invitationId, inviteeAccountId: invite.inviteeAccountId })),
    entitlement: { ...value.entitlement } };
}

function validCommand(command: FamilyCommand): boolean {
  if (!record(command)) return false;
  if (command.type === 'create') return true;
  if (command.type === 'accept') return identity(command.invitationId);
  if (!('familyId' in command) || !identity(command.familyId) || !identity(command.expectedRevision)) return false;
  switch (command.type) {
    case 'invite': return identity(command.inviteeAccountId);
    case 'revoke': return identity(command.invitationId);
    case 'remove': return identity(command.memberAccountId);
    case 'leave': return true;
    default: return false;
  }
}

const copyRequest = (request: FamilyRequest): FamilyRequest => ({ command: { ...request.command }, idempotencyKey: request.idempotencyKey });

export class FamilyMembershipController {
  private readonly ports: FamilyPorts;
  private readonly owner: FamilySession | null;
  private state: FamilyState = { status: 'unavailable', snapshot: null, reason: 'not_loaded' };
  private recovery: FamilyRecovery | null = null;
  private busy = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(ports: FamilyPorts) {
    this.ports = ports;
    this.owner = this.capture();
  }

  getState(): FamilyState {
    if (!this.current()) return { status: 'unavailable', snapshot: null, reason: this.owner ? 'session_changed' : 'authentication_required' };
    return { ...this.state, snapshot: this.state.snapshot ? copySnapshot(this.state.snapshot) : null };
  }

  getRecovery(): FamilyRecovery | null {
    return this.recovery ? { ...this.recovery, request: copyRequest(this.recovery.request) } : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async load(): Promise<void> {
    const session = this.begin();
    if (!session) return;
    try {
      this.publish('loading');
      await this.read(session);
      this.publish(this.recovery ? 'unknown' : 'ready');
    } catch { this.publish(this.recovery ? 'unknown' : 'failed', 'family_read_failed'); }
    finally { this.busy = false; }
  }

  async command(command: FamilyCommand): Promise<void> {
    if (this.recovery || !validCommand(command)) return;
    const session = this.begin();
    if (!session) return;
    try {
      const key = this.ports.newIdempotencyKey();
      if (!identity(key)) { this.publish('failed', 'idempotency_key_missing'); return; }
      this.recovery = { accountId: session.accountId, generation: session.generation,
        request: { command: { ...command }, idempotencyKey: key }, receiptId: null };
      this.publish('submitting');
      if (!this.current(session)) { this.recovery = null; return; }
      const response = await session.command(copyRequest(this.recovery.request));
      await this.receive(session, response);
    } catch { this.publish('unknown', 'family_command_unknown'); }
    finally { this.busy = false; }
  }

  async checkAgain(): Promise<void> {
    if (!this.recovery) { await this.load(); return; }
    const session = this.begin();
    if (!session) return;
    try {
      this.publish('loading');
      if (!this.current(session)) return;
      if (this.recovery.receiptId) {
        await this.read(session);
        if (this.current(session)) { this.recovery = null; this.publish('ready'); }
      } else {
        await this.receive(session, await session.reconcile(copyRequest(this.recovery.request)));
      }
    } catch { this.publish('unknown', 'family_reconciliation_unknown'); }
    finally { this.busy = false; }
  }

  dispose(): void { this.disposed = true; this.listeners.clear(); }

  private capture(): FamilySession | null {
    const session = this.ports.captureSession();
    if (!session || !identity(session.accountId) || !identity(session.generation) || !session.isCurrent()) return null;
    return { accountId: session.accountId, generation: session.generation, isCurrent: session.isCurrent.bind(session),
      read: session.read.bind(session), command: session.command.bind(session), reconcile: session.reconcile.bind(session) };
  }

  private current(session = this.owner): boolean {
    return !this.disposed && !!this.owner?.isCurrent() && !!session?.isCurrent()
      && session.accountId === this.owner.accountId && session.generation === this.owner.generation;
  }

  private begin(): FamilySession | null {
    if (this.busy || !this.current()) return null;
    const session = this.capture();
    if (!this.current(session)) return null;
    this.busy = true;
    return session;
  }

  private publish(status: FamilyState['status'], reason: string | null = null): void {
    if (!this.current()) return;
    this.state = { ...this.state, status, reason };
    for (const listener of this.listeners) listener();
  }

  private matches<T>(session: FamilySession, response: FamilyResponse<T>): boolean {
    return this.current(session) && !!response && response.accountId === session.accountId && response.generation === session.generation;
  }

  private async read(session: FamilySession): Promise<void> {
    if (!this.current(session)) return;
    const response = await session.read();
    if (!this.current(session)) return;
    if (!this.matches(session, response) || (response.value !== null && !isFamilySnapshot(response.value, session.accountId))) {
      throw new Error('invalid_family_response');
    }
    this.state = { ...this.state, snapshot: response.value ? copySnapshot(response.value) : null };
  }

  private async receive(session: FamilySession, response: FamilyResponse<FamilyOutcome>): Promise<void> {
    if (!this.current(session)) return;
    if (!this.matches(session, response)) { this.publish('unknown', 'family_response_mismatch'); return; }
    const outcome = response.value;
    if (outcome?.status === 'applied' && identity(outcome.receiptId)) {
      this.recovery!.receiptId = outcome.receiptId;
      await this.read(session);
      if (this.current(session)) { this.recovery = null; this.publish('ready'); }
    } else if (outcome?.status === 'rejected' && identity(outcome.code)) {
      this.recovery = null;
      this.publish('failed', outcome.code);
    } else { this.publish('unknown', 'family_command_unknown'); }
  }
}
