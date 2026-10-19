import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../errors.js';
import type {
  AccountContext, FamilyCommand, FamilyDependencies, FamilyGrantContribution, FamilyInvitation,
  FamilyOutcome, FamilyRequest, FamilySnapshot,
} from './types.js';

type FamilyRow = { id: string; owner_account_id: string; total_seats: number; revision: number; suppressed: number };
type InviteRow = { id: string; family_id: string; invitee_account_id: string; status: string };
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;
const reject = (code: string): never => { throw new DomainError(409, code); };

function parseRequest(input: FamilyRequest): FamilyRequest {
  if (!input || !text(input.idempotencyKey) || !input.command || typeof input.command !== 'object') throw new DomainError(400, 'invalid_family_request');
  const command = input.command;
  let fields: string[];
  switch (command.type) {
    case 'create': fields = ['type']; break;
    case 'accept': fields = ['type', 'invitationId']; break;
    case 'invite': fields = ['type', 'familyId', 'expectedRevision', 'inviteeAccountId']; break;
    case 'revoke': fields = ['type', 'familyId', 'expectedRevision', 'invitationId']; break;
    case 'remove': fields = ['type', 'familyId', 'expectedRevision', 'memberAccountId']; break;
    case 'leave': fields = ['type', 'familyId', 'expectedRevision']; break;
    default: throw new DomainError(400, 'invalid_family_command');
  }
  const values = command as unknown as Record<string, unknown>;
  if (Object.keys(input).some(key => !['command', 'idempotencyKey'].includes(key))
    || Object.keys(command).length !== fields.length || fields.some(key => !text(values[key]))) throw new DomainError(400, 'invalid_family_command');
  return { command: { ...command }, idempotencyKey: input.idempotencyKey };
}
const fingerprint = (command: FamilyCommand): string => createHash('sha256')
  .update(JSON.stringify(Object.entries(command).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

export class FamilyMembershipService {
  private readonly capacity: number;
  constructor(private readonly deps: FamilyDependencies) {
    this.capacity = deps.totalSeats ?? 5;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) throw new DomainError(400, 'invalid_family_capacity');
    this.storageReady();
  }

  private storageReady(): void {
    const db = this.deps.db;
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || ![2, 3].includes(Number(db.pragma('synchronous', { simple: true })))
      || (!db.memory && db.pragma('journal_mode', { simple: true }) !== 'wal')) throw new DomainError(503, 'family_storage_unqualified');
  }
  private get<T>(sql: string, ...values: unknown[]): T | undefined { return this.deps.db.prepare(sql).get(...values) as T | undefined; }
  private all<T>(sql: string, ...values: unknown[]): T[] { return this.deps.db.prepare(sql).all(...values) as T[]; }
  private run(sql: string, ...values: unknown[]) { return this.deps.db.prepare(sql).run(...values); }

  private assertActor(actor: AccountContext): void {
    if (!actor || !text(actor.accountId) || !text(actor.authUserId) || !text(actor.sessionId) || !Number.isSafeInteger(actor.epoch) || actor.epoch < 0)
      throw new DomainError(401, 'unauthenticated');
    this.deps.lifecycle.assertActive(actor);
    if (!this.subjectActive(actor.accountId)) throw new DomainError(403, 'family_account_unavailable');
  }
  private subjectActive(accountId: string): boolean {
    if (this.get('SELECT 1 FROM family_account_suppression WHERE account_id=?', accountId)) return false;
    try { return this.deps.subjectActive(accountId) === true; } catch { return false; }
  }
  private active<T>(actor: AccountContext, effect: (captured: AccountContext) => T): T {
    const captured = Object.freeze({ ...actor });
    this.storageReady(); this.assertActor(captured);
    return this.deps.lifecycle.withActiveWrite(captured, () => {
      if (!this.deps.db.inTransaction) throw new DomainError(503, 'family_serialization_required');
      this.assertActor(captured);
      const result = effect(captured);
      this.assertActor(captured);
      return result;
    });
  }
  private family(id: string): FamilyRow {
    const row = this.get<FamilyRow>('SELECT * FROM family_memberships WHERE id=? AND suppressed=0', id);
    if (!row || !this.subjectActive(row.owner_account_id)) throw new DomainError(404, 'family_not_found');
    return row;
  }
  private membership(accountId: string) { return this.get<{ family_id: string; role: 'owner' | 'member' }>('SELECT family_id,role FROM family_members WHERE account_id=?', accountId); }
  private revision(row: FamilyRow, expected: string): void { if (String(row.revision) !== expected) reject('family_stale_revision'); }
  private advance(familyId: string): void { this.run('UPDATE family_memberships SET revision=revision+1 WHERE id=?', familyId); }

  command(actor: AccountContext, input: FamilyRequest): FamilyOutcome {
    const request = parseRequest(input);
    return this.active(actor, captured => {
      const existing = this.receiptUnchecked(captured.accountId, request);
      if (existing) return existing;
      let outcome: FamilyOutcome;
      try {
        // Savepoint rollback keeps a rejected command from leaving a partial effect before its receipt.
        this.deps.db.transaction(() => this.apply(captured, request.command))();
        outcome = { status: 'applied', receiptId: randomUUID() };
      } catch (error) {
        if (!(error instanceof DomainError) || ![400, 403, 404, 409].includes(error.status)) throw error;
        outcome = { status: 'rejected', code: error.code };
      }
      this.run('INSERT INTO family_command_receipts VALUES(?,?,?,?)', captured.accountId, request.idempotencyKey,
        fingerprint(request.command), JSON.stringify(outcome));
      return outcome;
    });
  }

  receipt(actor: AccountContext, input: FamilyRequest): FamilyOutcome {
    const request = parseRequest(input);
    return this.active(actor, captured => this.receiptUnchecked(captured.accountId, request) ?? { status: 'unknown', code: 'family_receipt_not_found' });
  }
  private receiptUnchecked(accountId: string, request: FamilyRequest): FamilyOutcome | null {
    const row = this.get<{ intent_hash: string; outcome: string }>('SELECT intent_hash,outcome FROM family_command_receipts WHERE account_id=? AND idempotency_key=?', accountId, request.idempotencyKey);
    if (!row) return null;
    if (row.intent_hash !== fingerprint(request.command)) reject('family_idempotency_conflict');
    return JSON.parse(row.outcome) as FamilyOutcome;
  }

  private apply(actor: AccountContext, command: FamilyCommand): void {
    if (command.type === 'create') {
      if (this.membership(actor.accountId)) reject('family_already_joined');
      const id = randomUUID();
      this.run('INSERT INTO family_memberships(id,owner_account_id,total_seats) VALUES(?,?,?)', id, actor.accountId, this.capacity);
      this.run("INSERT INTO family_members VALUES(?,?,'owner')", actor.accountId, id);
      return;
    }
    if (command.type === 'accept') {
      const invite = this.get<InviteRow>("SELECT * FROM family_invitations WHERE id=? AND invitee_account_id=? AND status='pending'", command.invitationId, actor.accountId);
      if (!invite) throw new DomainError(404, 'family_invitation_not_found');
      const family = this.family(invite.family_id);
      if (this.membership(actor.accountId)) reject('family_already_joined');
      const count = this.get<{ count: number }>('SELECT count(*) AS count FROM family_members WHERE family_id=?', family.id)!.count;
      if (count >= family.total_seats) reject('family_full');
      this.run("INSERT INTO family_members VALUES(?,?,'member')", actor.accountId, family.id);
      this.run("UPDATE family_invitations SET status='accepted' WHERE id=?", invite.id);
      this.advance(family.id);
      return;
    }
    const family = this.family(command.familyId);
    const member = this.membership(actor.accountId);
    if (member?.family_id !== family.id) throw new DomainError(404, 'family_not_found');
    if (command.type !== 'leave' && family.owner_account_id !== actor.accountId) throw new DomainError(403, 'family_owner_required');
    this.revision(family, command.expectedRevision);
    if (command.type === 'invite') {
      if (!this.subjectActive(command.inviteeAccountId) || !this.get('SELECT 1 FROM form_accounts WHERE id=?', command.inviteeAccountId)) throw new DomainError(404, 'family_invitee_unavailable');
      if (this.membership(command.inviteeAccountId)) reject('family_already_joined');
      if (this.get("SELECT 1 FROM family_invitations WHERE family_id=? AND invitee_account_id=? AND status='pending'", family.id, command.inviteeAccountId)) reject('family_invitation_pending');
      this.run("INSERT INTO family_invitations VALUES(?,?,?,'pending')", randomUUID(), family.id, command.inviteeAccountId);
    } else if (command.type === 'revoke') {
      const result = this.run("UPDATE family_invitations SET status='revoked' WHERE id=? AND family_id=? AND status='pending'", command.invitationId, family.id);
      if (result.changes !== 1) throw new DomainError(404, 'family_invitation_not_found');
    } else {
      const target = command.type === 'leave' ? actor.accountId : command.memberAccountId;
      if (target === family.owner_account_id) reject('family_owner_cannot_leave');
      const result = this.run("DELETE FROM family_members WHERE account_id=? AND family_id=? AND role='member'", target, family.id);
      if (result.changes !== 1) throw new DomainError(404, 'family_member_not_found');
    }
    this.advance(family.id);
  }

  read(actor: AccountContext): FamilySnapshot | null {
    return this.active(actor, captured => {
      const member = this.membership(captured.accountId);
      if (!member) return null;
      const family = this.get<FamilyRow>('SELECT * FROM family_memberships WHERE id=?', member.family_id)!;
      if (family.suppressed || !this.subjectActive(family.owner_account_id)) return null;
      return { kind: 'commercial_family', familyId: family.id, revision: String(family.revision), ownerAccountId: family.owner_account_id,
        totalSeats: family.total_seats,
        members: this.all<{ accountId: string; role: 'owner' | 'member' }>('SELECT account_id AS accountId,role FROM family_members WHERE family_id=? ORDER BY account_id', family.id),
        pendingInvitations: member.role === 'owner' ? this.all<{ invitationId: string; inviteeAccountId: string }>("SELECT id AS invitationId,invitee_account_id AS inviteeAccountId FROM family_invitations WHERE family_id=? AND status='pending' ORDER BY id", family.id) : [],
        entitlement: { accountId: captured.accountId, status: this.grantUnchecked(captured.accountId, family).status } };
    });
  }

  invitations(actor: AccountContext): FamilyInvitation[] {
    return this.active(actor, captured => this.all<FamilyInvitation>(`SELECT i.id AS invitationId,i.family_id AS familyId,f.owner_account_id AS ownerAccountId
      FROM family_invitations i JOIN family_memberships f ON f.id=i.family_id
      WHERE i.invitee_account_id=? AND i.status='pending' AND f.suppressed=0 ORDER BY i.id`, captured.accountId)
      .filter(invite => this.subjectActive(invite.ownerAccountId)));
  }

  entitlementContribution(actor: AccountContext): FamilyGrantContribution[] {
    return this.active(actor, captured => {
      const member = this.membership(captured.accountId);
      if (!member) return [];
      const family = this.get<FamilyRow>('SELECT * FROM family_memberships WHERE id=?', member.family_id)!;
      const { grant } = this.grantUnchecked(captured.accountId, family);
      return grant ? [grant] : [];
    });
  }
  private grantUnchecked(accountId: string, family: FamilyRow): { status: 'active' | 'inactive' | 'unknown'; grant: FamilyGrantContribution | null } {
    if (family.suppressed || !this.subjectActive(accountId) || !this.subjectActive(family.owner_account_id)) return { status: 'inactive', grant: null };
    try {
      const result = this.deps.entitlement?.read(family.owner_account_id, family.id);
      if (result?.status === 'inactive') return { status: 'inactive', grant: null };
      if (result?.status !== 'active' || result.ownerAccountId !== family.owner_account_id || result.familyId !== family.id
        || !text(result.grant.id) || !text(result.grant.entitlement) || !text(result.grant.grantedAt) || !text(result.grant.environment)) return { status: 'unknown', grant: null };
      return { status: 'active', grant: { ...result.grant, id: `family:${family.id}:${accountId}:${result.grant.id}`,
        accountId, source: 'family', sourceId: family.id, active: true } };
    } catch { return { status: 'unknown', grant: null }; }
  }

  exportAccount(actor: AccountContext) {
    return this.active(actor, captured => ({
      membership: this.get<{ familyId: string; role: string; totalSeats: number; revision: number }>(`SELECT m.family_id AS familyId,m.role,f.total_seats AS totalSeats,f.revision
        FROM family_members m JOIN family_memberships f ON f.id=m.family_id WHERE m.account_id=?`, captured.accountId) ?? null,
      invitations: this.all<{ invitationId: string; familyId: string; status: string }>('SELECT id AS invitationId,family_id AS familyId,status FROM family_invitations WHERE invitee_account_id=? ORDER BY id', captured.accountId),
      receipts: this.all<{ idempotencyKey: string; outcome: string }>('SELECT idempotency_key AS idempotencyKey,outcome FROM family_command_receipts WHERE account_id=? ORDER BY idempotency_key', captured.accountId),
    }));
  }

  suppressAccount(accountId: string, epoch: number): void {
    this.storageReady();
    if (!text(accountId) || !Number.isSafeInteger(epoch) || epoch < 0) throw new DomainError(400, 'invalid_family_suppression');
    this.deps.db.transaction(() => {
      this.run('INSERT INTO family_account_suppression VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET epoch=max(epoch,excluded.epoch)', accountId, epoch);
      this.run('UPDATE family_memberships SET suppressed=1,revision=revision+1 WHERE owner_account_id=? AND suppressed=0', accountId);
      const member = this.membership(accountId);
      if (member?.role === 'member') { this.run('DELETE FROM family_members WHERE account_id=?', accountId); this.advance(member.family_id); }
      this.run("UPDATE family_invitations SET status='revoked' WHERE status='pending' AND (invitee_account_id=? OR family_id IN (SELECT id FROM family_memberships WHERE owner_account_id=?))", accountId, accountId);
    }).immediate();
  }

  verifySuppressed(accountId: string): boolean {
    return !this.get(`SELECT 1 FROM family_members m JOIN family_memberships f ON f.id=m.family_id WHERE m.account_id=? AND f.suppressed=0`, accountId)
      && !this.get("SELECT 1 FROM family_invitations WHERE invitee_account_id=? AND status='pending'", accountId)
      && !this.get('SELECT 1 FROM family_memberships WHERE owner_account_id=? AND suppressed=0', accountId);
  }

  purgeAccount(accountId: string): number {
    this.storageReady();
    return this.deps.db.transaction(() => {
      if (!this.get('SELECT 1 FROM family_account_suppression WHERE account_id=?', accountId) || !this.verifySuppressed(accountId)) throw new DomainError(409, 'family_suppression_required');
      let count = this.run('DELETE FROM family_memberships WHERE owner_account_id=?', accountId).changes;
      count += this.run('DELETE FROM family_members WHERE account_id=?', accountId).changes;
      count += this.run('DELETE FROM family_invitations WHERE invitee_account_id=?', accountId).changes;
      count += this.run('DELETE FROM family_command_receipts WHERE account_id=?', accountId).changes;
      return count;
    }).immediate();
  }
}
