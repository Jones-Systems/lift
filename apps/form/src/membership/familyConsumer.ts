import { FamilyMembershipController } from './family';
import type { FamilyCommand, FamilyInvitation, FamilyPorts, FamilyRecovery, FamilySession, FamilySnapshot, FamilyState } from './family.types';

export type FamilyInvitationState = {
  status: 'unavailable' | 'loading' | 'ready' | 'failed';
  items: FamilyInvitation[];
  reason: string | null;
};
export type FamilyConsumerState = { family: FamilyState; invitations: FamilyInvitationState; busy: boolean };

const unavailable = (reason: string): FamilyInvitationState => ({ status: 'unavailable', items: [], reason });
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;
function invitations(value: unknown): FamilyInvitation[] | null {
  if (!Array.isArray(value)) return null;
  const result: FamilyInvitation[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !identity(item.invitationId)
      || !identity(item.familyId) || !identity(item.ownerAccountId) || ids.has(item.invitationId)) return null;
    ids.add(item.invitationId);
    result.push({ invitationId: item.invitationId, familyId: item.familyId, ownerAccountId: item.ownerAccountId });
  }
  return result;
}

export class FamilyMembershipConsumer {
  private readonly ports: FamilyPorts;
  private readonly owner: FamilySession | null;
  private readonly controller: FamilyMembershipController;
  private readonly unsubscribeController: () => void;
  private activeSession: FamilySession | null = null;
  private invitationState: FamilyInvitationState = unavailable('not_loaded');
  private busy = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(ports: FamilyPorts) {
    this.ports = ports;
    this.owner = this.capture();
    this.controller = new FamilyMembershipController({
      // Both discovery and controller commands use the same synchronous capture for each operation.
      captureSession: () => this.activeSession ?? this.owner,
      newIdempotencyKey: () => ports.newIdempotencyKey(),
    });
    this.unsubscribeController = this.controller.subscribe(() => this.notify());
  }

  getState(): FamilyConsumerState {
    if (!this.current()) return { family: { status: 'unavailable', snapshot: null,
      reason: this.disposed ? 'disposed' : this.owner ? 'session_changed' : 'authentication_required' },
    invitations: unavailable(this.disposed ? 'disposed' : this.owner ? 'session_changed' : 'authentication_required'), busy: false };
    return { family: this.controller.getState(), invitations: { ...this.invitationState,
      items: this.invitationState.items.map(item => ({ ...item })) }, busy: this.busy };
  }

  getRecovery(): FamilyRecovery | null { return this.controller.getRecovery(); }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async load(): Promise<void> {
    const session = this.begin();
    if (!session) return;
    try {
      this.invitationState = { status: 'loading', items: [], reason: null };
      this.notify();
      if (!this.current(session)) return;
      await this.controller.load();
      await this.readInvitations(session);
    } finally { this.end(); }
  }

  async acceptInvitation(invitationId: string): Promise<void> {
    if (this.invitationState.status !== 'ready' || !this.invitationState.items.some(item => item.invitationId === invitationId)
      || this.controller.getRecovery()) return;
    await this.submit({ type: 'accept', invitationId }, 'acceptance_pending');
  }

  async createFamily(): Promise<void> {
    const state = this.settled();
    if (!state || state.snapshot !== null) return;
    await this.submit({ type: 'create' });
  }

  async inviteAccount(inviteeAccountId: string): Promise<void> {
    const snapshot = this.ownedSnapshot();
    if (!snapshot || !identity(inviteeAccountId)) return;
    await this.submit({ type: 'invite', familyId: snapshot.familyId,
      expectedRevision: snapshot.revision, inviteeAccountId });
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    const snapshot = this.ownedSnapshot();
    if (!snapshot || !snapshot.pendingInvitations.some(invite => invite.invitationId === invitationId)) return;
    await this.submit({ type: 'revoke', familyId: snapshot.familyId,
      expectedRevision: snapshot.revision, invitationId });
  }

  async removeMember(memberAccountId: string): Promise<void> {
    const snapshot = this.ownedSnapshot();
    if (!snapshot || memberAccountId === snapshot.ownerAccountId
      || !snapshot.members.some(member => member.accountId === memberAccountId && member.role === 'member')) return;
    await this.submit({ type: 'remove', familyId: snapshot.familyId,
      expectedRevision: snapshot.revision, memberAccountId });
  }

  async leaveFamily(): Promise<void> {
    const snapshot = this.settled()?.snapshot;
    if (!snapshot || snapshot.ownerAccountId === this.owner?.accountId
      || !snapshot.members.some(member => member.accountId === this.owner?.accountId && member.role === 'member')) return;
    await this.submit({ type: 'leave', familyId: snapshot.familyId, expectedRevision: snapshot.revision });
  }

  async checkAgain(): Promise<void> {
    const session = this.begin();
    if (!session) return;
    try {
      this.invitationState = { status: 'loading', items: [], reason: null };
      this.notify();
      if (!this.current(session)) return;
      await this.controller.checkAgain();
      if (!this.current(session)) return;
      if (this.controller.getRecovery()) this.invitationState = unavailable('reconciliation_required');
      else await this.readInvitations(session);
    } finally { this.end(); }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeController();
    this.controller.dispose();
    this.listeners.clear();
    this.invitationState = unavailable('disposed');
  }

  private settled(): FamilyState | null {
    if (!this.current() || this.busy || this.controller.getRecovery()) return null;
    const state = this.controller.getState();
    return state.status === 'ready' ? state : null;
  }

  private ownedSnapshot(): FamilySnapshot | null {
    const snapshot = this.settled()?.snapshot;
    return snapshot && snapshot.ownerAccountId === this.owner?.accountId
      && snapshot.members.some(member => member.accountId === this.owner?.accountId && member.role === 'owner') ? snapshot : null;
  }

  private async submit(command: FamilyCommand, reason = 'command_pending'): Promise<void> {
    if (!this.settled()) return;
    const session = this.begin();
    if (!session) return;
    try {
      this.invitationState = unavailable(reason);
      await this.controller.command(command);
      if (!this.current(session)) return;
      if (this.controller.getRecovery()) this.invitationState = unavailable('reconciliation_required');
      else await this.readInvitations(session);
    } finally { this.end(); }
  }

  private capture(): FamilySession | null {
    const source = this.ports.captureSession();
    if (!source || !identity(source.accountId) || !identity(source.generation) || !source.isCurrent()) return null;
    const { accountId, generation } = source;
    return { accountId, generation,
      isCurrent: () => !this.disposed && source.isCurrent() && source.accountId === accountId && source.generation === generation,
      read: source.read.bind(source), command: source.command.bind(source), reconcile: source.reconcile.bind(source),
      ...(typeof source.invitations === 'function' ? { invitations: source.invitations.bind(source) } : {}),
    };
  }

  private current(session = this.owner): boolean {
    return !this.disposed && !!this.owner?.isCurrent() && !!session?.isCurrent()
      && session.accountId === this.owner.accountId && session.generation === this.owner.generation;
  }

  private begin(): FamilySession | null {
    if (this.busy || !this.current()) return null;
    const session = this.capture();
    if (!this.current(session)) return null;
    this.activeSession = session;
    this.busy = true;
    return session;
  }

  private end(): void { this.activeSession = null; this.busy = false; this.notify(); }
  private notify(): void { if (this.current()) for (const listener of this.listeners) listener(); }

  private async readInvitations(session: FamilySession): Promise<void> {
    if (!this.current(session)) return;
    if (!session.invitations) { this.invitationState = unavailable('invitation_discovery_unavailable'); return; }
    try {
      const response = await session.invitations();
      if (!this.current(session)) return;
      if (!response || response.accountId !== session.accountId || response.generation !== session.generation) throw new Error('invitation_response_mismatch');
      const items = invitations(response.value);
      if (!items) throw new Error('invalid_family_invitations');
      this.invitationState = { status: 'ready', items, reason: null };
    } catch {
      if (this.current(session)) this.invitationState = { status: 'failed', items: [], reason: 'invitation_read_failed' };
    }
  }
}
