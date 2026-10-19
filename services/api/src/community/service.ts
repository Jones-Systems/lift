import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError, revision } from '../errors.js';
import * as s from './schemas.js';
import { captureRemovalSnapshot, removalSnapshotExportSql } from './removal-snapshots.js';
import { estimateCommunityRows, addCommunityExportBounds, assertCommunityExportBounds, type CommunityExportBounds } from './export-bounds.js';
import { activityFields, shareFields, type AccountContext, type ActivityField, type AuthoritativeRestoreState,
  type CommunityCounts, type CommunityDependencies, type CommunitySummary, type CommunityActivityAuthorization, type CommunityActivityReadInput, type GroupView, type InvitationView,
  type IssuedInvitation, type MemberView, type RemovedMembershipView, type OwnShare, type OwnShareFlags, type SharedDay } from './types.js';

type Group = { id: string; display_name: string; owner_account_id: string; state: 'active' | 'closed'; revision: number;
  generation: number; created_at: string; closed_at: string | null };
type Member = { group_id: string; account_id: string; member_id: string; alias: string; role: 'owner' | 'admin' | 'member';
  state: 'active' | 'left' | 'removed'; revision: number; generation: number; joined_at: string; ended_at: string | null };
type Share = { group_id: string; account_id: string; membership_generation: number; revision: number; updated_at: string }
  & Record<typeof shareFields[number], number> & Record<`${typeof shareFields[number]}_enabled_at`, string | null>;
type Invite = { id: string; group_id: string; group_generation: number; issuer_account_id: string;
  issuer_membership_generation: number; token_hash: string; scope: 'join_member'; state: 'pending' | 'redeemed' | 'revoked';
  revision: number; created_at: string; expires_at: string; redeemed_account_id: string | null; member_generation: number | null };
type Receipt = { account_id: string; operation: string; key: string; group_id: string | null; intent_hash: string;
  status: number; effect_id: string; effect_generation: number; created_at: string };
function missing(): never { throw new DomainError(404, 'community_not_found'); }
function unavailableInvite(): never { throw new DomainError(404, 'community_invitation_unavailable'); }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenHash = (token: string) => digest(`form.community.invite.v1:${token}`);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export class CommunityService {
  constructor(private readonly deps: CommunityDependencies) {}
  private get<T>(sql: string, ...args: unknown[]): T | undefined { return this.deps.db.prepare(sql).get(...args) as T | undefined; }
  private rows<T>(sql: string, ...args: unknown[]): T[] { return this.deps.db.prepare(sql).all(...args) as T[]; }
  private write(sql: string, ...args: unknown[]) { return this.deps.db.prepare(sql).run(...args); }
  private now(): string {
    const date = this.deps.now(); if (!Number.isFinite(date.getTime())) throw new DomainError(503, 'community_clock_unavailable');
    return date.toISOString();
  }
  private active<T>(actor: AccountContext, effect: () => T): T {
    if (!this.deps.lifecycle) throw new DomainError(503, 'community_lifecycle_unavailable');
    return this.deps.lifecycle.withActiveWrite(actor, () => { this.session(actor); const result = effect(); this.session(actor); return result; });
  }
  private session(actor: AccountContext): void {
    if (!actor || !actor.accountId || !actor.authUserId || !actor.sessionId || !Number.isSafeInteger(actor.epoch) || actor.epoch < 0)
      throw new DomainError(401, 'unauthenticated');
    if (!this.deps.lifecycle) throw new DomainError(503, 'community_lifecycle_unavailable');
    this.deps.lifecycle.assertActive(actor);
  }
  private hooks(): NonNullable<CommunityDependencies['extension']> {
    this.lifecycleTransaction();
    if (!this.deps.extension) throw new DomainError(503, 'community_parent_guards_unavailable');
    return this.deps.extension;
  }
  private pairVisible(actor: AccountContext, groupId: string, accountId: string): boolean {
    try { this.hooks().assertPairVisible(actor, groupId, accountId); return true; }
    catch (error) {
      if (error instanceof DomainError && (error.status === 404 || error.code === 'community_parent_guards_unavailable')) return false;
      throw error;
    }
  }
  private eligible(accountId: string, actor?: AccountContext): boolean {
    try {
      const result = actor?.accountId === accountId ? this.deps.lifecycle?.adultEligibility(actor) : this.deps.subjectEligibility?.(accountId);
      return result?.policy === 'self_reported_adult_v1' && result.status === 'eligible' && Number.isSafeInteger(result.profileRevision) && (result.profileRevision ?? -1) >= 0;
    } catch { return false; }
  }
  private adult(actor: AccountContext): void {
    this.session(actor);
    if (!this.eligible(actor.accountId, actor)) throw new DomainError(403, 'community_adult_eligibility_unavailable');
  }
  private limit(actor: AccountContext, action: 'invitation_attempt' | 'invitation_issue'): void {
    if (!this.deps.assertRateLimit) throw new DomainError(503, 'community_limiter_unavailable');
    this.deps.assertRateLimit(actor, action);
  }
  private group(id: string): Group {
    s.parse(s.identifier, id); const row = this.get<Group>('SELECT * FROM community_groups WHERE id=?', id);
    if (!row || row.state !== 'active') missing(); return row;
  }
  private member(groupId: string, accountId: string): Member {
    const row = this.get<Member>('SELECT * FROM community_members WHERE group_id=? AND account_id=?', groupId, accountId);
    if (!row || row.state !== 'active') missing(); return row;
  }
  private access(actor: AccountContext, groupId: string, adult = true): { group: Group; member: Member } {
    if (adult) this.adult(actor); else this.session(actor);
    const group = this.group(groupId); const member = this.member(groupId, actor.accountId); return { group, member };
  }
  private manager(actor: AccountContext, groupId: string, owner = false) {
    const access = this.access(actor, groupId);
    if (access.member.role === 'member' || (owner && access.member.role !== 'owner')) missing();
    return access;
  }
  private groupView(group: Group, member: Member): GroupView {
    return { id: group.id, name: group.display_name, revision: group.revision, role: member.role, memberId: member.member_id };
  }
  private memberView(member: Member): MemberView {
    return { memberId: member.member_id, alias: member.alias, role: member.role, revision: member.revision };
  }
  private share(member: Member): Share {
    const row = this.get<Share>('SELECT * FROM community_share_settings WHERE group_id=? AND account_id=?', member.group_id, member.account_id);
    if (!row || row.membership_generation !== member.generation) throw new DomainError(503, 'community_integrity_unavailable');
    this.shareView(row); return row;
  }
  private shareView(row: Share): OwnShare {
    const flags = s.allFalse(); const enabledAt: OwnShare['enabledAt'] = {};
    for (const f of shareFields) {
      if (row[f] !== 0 && row[f] !== 1) throw new DomainError(503, 'community_integrity_unavailable');
      flags[f] = row[f] === 1; const at = row[`${f}_enabled_at`];
      if (flags[f]) {
        if (!at || !Number.isFinite(Date.parse(at))) throw new DomainError(503, 'community_integrity_unavailable');
        enabledAt[f] = at;
      } else if (at !== null) throw new DomainError(503, 'community_integrity_unavailable');
    }
    if ((flags.workoutMinutes || flags.exerciseCount) && !flags.workout || flags.streakDays && !flags.planAdherence)
      throw new DomainError(503, 'community_integrity_unavailable');
    return { revision: row.revision, flags, enabledAt };
  }
  private initShare(member: Member, now: string): void {
    const columns = shareFields.flatMap(f => [f, `${f}_enabled_at`]);
    this.write(`INSERT INTO community_share_settings(group_id,account_id,membership_generation,revision,${columns.join(',')},updated_at)
      VALUES(${Array(5 + columns.length).fill('?').join(',')})`, member.group_id, member.account_id, member.generation,
      member.revision, ...shareFields.flatMap(() => [0, null]), now);
  }
  private clearShare(groupId: string, accountId: string, now: string): void {
    this.write(`UPDATE community_share_settings SET ${shareFields.flatMap(f => [`${f}=0`, `${f}_enabled_at=NULL`]).join(',')},
      revision=revision+1,updated_at=? WHERE group_id=? AND account_id=?`, now, groupId, accountId);
  }
  private receipt(actor: AccountContext, operation: string, key: string, intent: unknown): Receipt | undefined {
    s.parse(s.commandKey, key); const hash = digest(canonical(intent));
    const row = this.get<Receipt>('SELECT * FROM community_command_receipts WHERE account_id=? AND operation=? AND key=?', actor.accountId, operation, key);
    if (row && row.intent_hash !== hash) throw new DomainError(409, 'idempotency_conflict'); return row;
  }
  private record(actor: AccountContext, operation: string, key: string, intent: unknown, groupId: string | null, effectId: string, generation: number, status = 200): void {
    this.write(`INSERT INTO community_command_receipts(account_id,operation,key,group_id,intent_hash,status,effect_id,effect_generation,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, actor.accountId, operation, key, groupId, digest(canonical(intent)), status, effectId, generation, this.now());
  }
  private accountCapacity(accountId: string): void {
    const count = this.get<{ n: number }>("SELECT count(*) n FROM community_members m JOIN community_groups g ON g.id=m.group_id WHERE m.account_id=? AND m.state='active' AND g.state='active'", accountId)!.n;
    if (count >= 20) throw new DomainError(409, 'community_account_capacity');
  }
  private revokeIssuer(groupId: string, accountId: string): void {
    this.write("UPDATE community_invitations SET state='revoked',revision=revision+1 WHERE group_id=? AND issuer_account_id=? AND state='pending'", groupId, accountId);
  }
  private endMember(member: Member, state: 'left' | 'removed', now: string): void {
    this.clearShare(member.group_id, member.account_id, now); this.revokeIssuer(member.group_id, member.account_id);
    this.write("UPDATE community_members SET state=?,alias='',revision=revision+1,generation=generation+1,ended_at=? WHERE group_id=? AND account_id=?", state, now, member.group_id, member.account_id);
    this.write('UPDATE community_share_settings SET membership_generation=? WHERE group_id=? AND account_id=?', member.generation + 1, member.group_id, member.account_id);
    if (state === 'removed') captureRemovalSnapshot(this.deps.db, member.group_id, member.account_id, this.group(member.group_id).display_name, now);
    this.hooks().afterMemberEnds(member.group_id, member.account_id);
  }
  private closeRows(group: Group, now: string): void {
    for (const member of this.rows<Member>("SELECT * FROM community_members WHERE group_id=? AND state='active'", group.id)) this.endMember(member, 'left', now);
    this.write("UPDATE community_invitations SET state='revoked',revision=revision+1 WHERE group_id=? AND state='pending'", group.id);
    this.write("UPDATE community_groups SET state='closed',generation=generation+1,revision=revision+1,closed_at=? WHERE id=? AND state='active'", now, group.id);
    this.hooks().afterGroupCloses(group.id);
  }
  private inviteView(row: Invite): InvitationView {
    return { id: row.id, groupId: row.group_id, revision: row.revision, createdAt: row.created_at, expiresAt: row.expires_at,
      state: row.state === 'pending' && this.now() >= row.expires_at ? 'expired' : row.state, tokenAvailable: false };
  }
  private invitation(groupId: string, id: string): Invite {
    s.parse(s.identifier, id); const row = this.get<Invite>('SELECT * FROM community_invitations WHERE id=? AND group_id=?', id, groupId);
    if (!row) missing(); return row;
  }
  private validInvite(hash: string, actor: AccountContext): Invite {
    const row = this.get<Invite>('SELECT * FROM community_invitations WHERE token_hash=?', hash);
    if (!row || row.state !== 'pending' || this.now() >= row.expires_at) unavailableInvite();
    const group = this.get<Group>("SELECT * FROM community_groups WHERE id=? AND state='active'", row.group_id);
    const issuer = this.get<Member>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", row.group_id, row.issuer_account_id);
    const actorMember = this.get<Member>('SELECT * FROM community_members WHERE group_id=? AND account_id=?', row.group_id, actor.accountId);
    if (!group || group.generation !== row.group_generation || !issuer || issuer.generation !== row.issuer_membership_generation ||
      (!['owner', 'admin'].includes(issuer.role) && !this.reservation(row.id)) || !this.eligible(issuer.account_id, actor) || actorMember?.state === 'removed') unavailableInvite();
    return row;
  }
  private reservation(invitationId: string): { id: string; sponsor_account_id: string; state: string; expires_at: string } | undefined {
    if (!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_seat_reservations'")) return undefined;
    return this.get('SELECT id,sponsor_account_id,state,expires_at FROM community_seat_reservations WHERE invitation_id=?', invitationId);
  }
  private joinGuard(actor: AccountContext, invite: Invite, replay = false): void {
    const reserved = this.reservation(invite.id);
    if (!reserved) { this.hooks().guardLegacy(actor, invite.group_id, 'join', invite.issuer_account_id); return; }
    if (reserved.sponsor_account_id !== invite.issuer_account_id) unavailableInvite();
    if (replay && reserved.state === 'consumed') {
      this.hooks().guardLegacy(actor, invite.group_id, 'read', invite.issuer_account_id); return;
    }
    if (reserved.state !== 'available' || reserved.expires_at <= this.now()) unavailableInvite();
    const hooks = this.hooks(); if (!hooks.beforeReservedJoin) throw new DomainError(503, 'community_reserved_join_unavailable');
    hooks.beforeReservedJoin(actor, invite.group_id, invite.id);
  }
  issueFriendInvitation(actor: AccountContext, groupId: string, reservationId: string, input: unknown, key: string): IssuedInvitation {
    const body = s.parse(s.issueInvitationSchema, input); s.parse(s.identifier, reservationId);
    return this.active(actor, () => {
      const { group, member } = this.access(actor, groupId), intent = { reservationId, ...body }, op = `friend-issue:${groupId}`;
      const reservation = this.get<{ sponsor_account_id: string; sponsor_generation: number; group_generation: number; invitation_id: string | null }>('SELECT * FROM community_seat_reservations WHERE id=? AND group_id=?', reservationId, groupId);
      if (!reservation || reservation.sponsor_account_id !== actor.accountId || reservation.sponsor_generation !== member.generation || reservation.group_generation !== group.generation) missing();
      const prior = this.receipt(actor, op, key, intent);
      if (prior) {
        if (prior.effect_generation !== member.generation || reservation.invitation_id !== prior.effect_id) missing();
        return this.inviteView(this.invitation(groupId, prior.effect_id));
      }
      const hooks = this.hooks(); if (!hooks.beforeFriendIssue || !hooks.bindFriendInvitation) throw new DomainError(503, 'community_friend_bridge_unavailable');
      hooks.beforeFriendIssue(actor, groupId, reservationId); this.limit(actor, 'invitation_issue');
      const issued = this.issue(group, member); hooks.bindFriendInvitation(actor, groupId, reservationId, issued.id);
      this.record(actor, op, key, intent, groupId, issued.id, member.generation, 201);
      return issued.tokenAvailable ? { ...this.inviteView(this.invitation(groupId, issued.id)), tokenAvailable: true, token: issued.token } : issued;
    });
  }
  private token(input: unknown): string {
    const token = s.tokenSchema.safeParse(input); if (!token.success) unavailableInvite();
    if (Buffer.from(token.data, 'base64url').toString('base64url') !== token.data) unavailableInvite(); return token.data;
  }
  private issue(group: Group, member: Member): IssuedInvitation {
    const now = this.now(); const n = this.get<{ n: number }>("SELECT count(*) n FROM community_invitations WHERE group_id=? AND state='pending' AND expires_at>?", group.id, now)!.n;
    if (n >= 20) throw new DomainError(409, 'community_invitation_capacity');
    const token = randomBytes(32).toString('base64url'); const id = randomUUID();
    this.write(`INSERT INTO community_invitations(id,group_id,group_generation,issuer_account_id,issuer_membership_generation,token_hash,
      scope,state,revision,created_at,expires_at,redeemed_account_id,member_generation) VALUES(?,?,?,?,?,?,'join_member','pending',1,?,?,NULL,NULL)`,
    id, group.id, group.generation, member.account_id, member.generation, tokenHash(token), now, new Date(Date.parse(now) + 86400000).toISOString());
    const metadata = this.inviteView(this.invitation(group.id, id)); return { ...metadata, tokenAvailable: true, token };
  }

  createGroup(actor: AccountContext, input: unknown, key: string): GroupView {
    const body = s.parse(s.createGroupSchema, input);
    return this.active(actor, () => {
      this.adult(actor); this.hooks().authorizeGroupText(actor, 'profile', body.name);
      this.hooks().authorizeGroupText(actor, 'alias', body.alias);
      const prior = this.receipt(actor, 'create_group', key, body);
      if (prior) {
        const { group, member } = this.access(actor, prior.effect_id);
        if (member.generation !== prior.effect_generation || member.role !== 'owner') missing(); return this.groupView(group, member);
      }
      this.accountCapacity(actor.accountId); const id = randomUUID(); const now = this.now();
      this.write("INSERT INTO community_groups(id,display_name,owner_account_id,state,revision,generation,created_at,closed_at) VALUES(?,?,?,'active',1,1,?,NULL)", id, body.name, actor.accountId, now);
      this.write("INSERT INTO community_members(group_id,account_id,member_id,alias,role,state,revision,generation,joined_at,ended_at) VALUES(?,?,?,?,'owner','active',1,1,?,NULL)", id, actor.accountId, randomUUID(), body.alias, now);
      const member = this.member(id, actor.accountId); this.initShare(member, now);
      this.record(actor, 'create_group', key, body, id, id, member.generation, 201); return this.groupView(this.group(id), member);
    });
  }
  listGroups(actor: AccountContext): GroupView[] {
    return this.active(actor, () => { this.adult(actor); return this.rows<Group>("SELECT g.* FROM community_groups g JOIN community_members m ON m.group_id=g.id WHERE m.account_id=? AND m.state='active' AND g.state='active' ORDER BY g.created_at,g.id LIMIT 20", actor.accountId)
      .map(group => this.groupView(group, this.member(group.id, actor.accountId))); });
  }
  listRemovedMemberships(actor: AccountContext): RemovedMembershipView[] {
    return this.active(actor, () => {
      const rows = this.rows<{ group_id: string; member_id: string; generation: number; removed_at: string | null; group_label_at_removal: string | null }>(`
        SELECT m.group_id,m.member_id,m.generation,s.removed_at,s.group_label_at_removal FROM community_members m
        LEFT JOIN community_removal_snapshots s ON s.group_id=m.group_id AND s.account_id=m.account_id
          AND s.member_id=m.member_id AND s.membership_generation=m.generation AND s.membership_ended_at=m.ended_at
        WHERE m.account_id=? AND m.state='removed' ORDER BY m.ended_at DESC,m.group_id LIMIT 1001`, actor.accountId);
      if (rows.length > 1000) throw new DomainError(413, 'community_lifecycle_capacity');
      return rows.map(row => ({ groupId: row.group_id, memberId: row.member_id, membershipGeneration: row.generation, removedAt: row.removed_at,
        groupLabel: row.group_label_at_removal === null ? { status: 'unavailable' as const } : { status: 'available' as const, value: row.group_label_at_removal } }));
    });
  }
  readGroup(actor: AccountContext, groupId: string): GroupView & { members: MemberView[] } {
    return this.active(actor, () => { const { group, member } = this.access(actor, groupId);
      const members = this.rows<Member>("SELECT * FROM community_members WHERE group_id=? AND state='active' ORDER BY member_id LIMIT 50", groupId)
        .filter(m => this.pairVisible(actor, groupId, m.account_id) && this.eligible(m.account_id, actor) && this.pairVisible(actor, groupId, m.account_id)).map(m => this.memberView(m));
      this.adult(actor); return { ...this.groupView(group, member), members }; });
  }
  renameGroup(actor: AccountContext, groupId: string, input: unknown, key: string): GroupView {
    const body = s.parse(s.renameSchema, input); return this.active(actor, () => {
      const { group, member } = this.manager(actor, groupId, true); const op = `rename:${groupId}`;
      this.hooks().guardLegacy(actor, groupId, 'rename'); this.hooks().authorizeGroupText(actor, 'profile', body.name);
      if (!this.receipt(actor, op, key, body)) { revision(group.revision, body.expectedRevision);
        this.write('UPDATE community_groups SET display_name=?,revision=revision+1 WHERE id=?', body.name, groupId);
        this.record(actor, op, key, body, groupId, groupId, group.generation); }
      return this.groupView(this.group(groupId), member);
    });
  }
  listInvitations(actor: AccountContext, groupId: string): InvitationView[] {
    return this.active(actor, () => { this.manager(actor, groupId); return this.rows<Invite>('SELECT * FROM community_invitations WHERE group_id=? ORDER BY created_at DESC,id LIMIT 100', groupId)
      .filter(row => this.pairVisible(actor, groupId, row.issuer_account_id) && (!row.redeemed_account_id || this.pairVisible(actor, groupId, row.redeemed_account_id)))
      .map(row => this.inviteView(row)); });
  }
  issueInvitation(actor: AccountContext, groupId: string, input: unknown, key: string): IssuedInvitation {
    const body = s.parse(s.issueInvitationSchema, input); return this.active(actor, () => {
      const { group, member } = this.manager(actor, groupId); const op = `issue:${groupId}`;
      this.hooks().guardLegacy(actor, groupId, 'issue_invitation');
      const prior = this.receipt(actor, op, key, body);
      if (prior) {
        if (prior.effect_generation !== member.generation) missing(); const current = this.invitation(groupId, prior.effect_id);
        this.hooks().guardLegacy(actor, groupId, 'read', current.issuer_account_id);
        if (current.redeemed_account_id) this.hooks().guardLegacy(actor, groupId, 'read', current.redeemed_account_id);
        return this.inviteView(current);
      }
      this.limit(actor, 'invitation_issue'); const issued = this.issue(group, member);
      this.record(actor, op, key, body, groupId, issued.id, member.generation, 201); return issued;
    });
  }
  previewInvitation(actor: AccountContext, input: unknown) {
    return this.active(actor, () => { this.adult(actor); this.limit(actor, 'invitation_attempt');
      const result = s.previewInvitationSchema.safeParse(input); if (!result.success) unavailableInvite();
      const row = this.validInvite(tokenHash(this.token(result.data.token)), actor); const group = this.group(row.group_id);
      this.joinGuard(actor, row);
      return { name: group.display_name, expiresAt: row.expires_at, membershipDisclosure: 'Your alias and membership will be visible to current members of this group.' }; });
  }
  joinInvitation(actor: AccountContext, input: unknown, key: string): { groupId: string; memberId: string } {
    return this.active(actor, () => {
      this.adult(actor); this.limit(actor, 'invitation_attempt');
      if (!input || typeof input !== 'object' || !('token' in input)) unavailableInvite();
      this.token((input as { token?: unknown }).token);
      const body = s.parse(s.joinInvitationSchema, input);
      if (body.alias.includes(body.token) || key.includes(body.token)) throw new DomainError(422, 'community_invalid_input');
      const hash = tokenHash(body.token);
      const intent = { tokenHash: hash, alias: body.alias, membershipDisclosureAccepted: body.membershipDisclosureAccepted };
      const resolved = this.get<Invite>('SELECT * FROM community_invitations WHERE token_hash=?', hash);
      if (!resolved) unavailableInvite();
      const resolvedGroup = this.group(resolved.group_id), issuer = this.member(resolved.group_id, resolved.issuer_account_id);
      if (resolvedGroup.generation !== resolved.group_generation || issuer.generation !== resolved.issuer_membership_generation ||
        (!['owner', 'admin'].includes(issuer.role) && !this.reservation(resolved.id)) || !this.eligible(issuer.account_id, actor)) unavailableInvite();

      this.hooks().authorizeGroupText(actor, 'alias', body.alias);
      const prior = this.receipt(actor, 'join', key, intent);
      if (prior) {
        this.joinGuard(actor, resolved, true);
        const invite = this.get<Invite>('SELECT * FROM community_invitations WHERE id=?', prior.effect_id);
        if (!invite || invite.state !== 'redeemed' || invite.redeemed_account_id !== actor.accountId || !prior.group_id) unavailableInvite();
        const group = this.get<Group>("SELECT * FROM community_groups WHERE id=? AND state='active'", prior.group_id);
        const member = this.get<Member>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", prior.group_id, actor.accountId);
        if (!group || !member || member.generation !== prior.effect_generation) unavailableInvite();
        return { groupId: group.id, memberId: member.member_id };
      }
      const invite = this.validInvite(hash, actor); this.joinGuard(actor, invite); const group = this.group(invite.group_id);
      const previous = this.get<Member>('SELECT * FROM community_members WHERE group_id=? AND account_id=?', group.id, actor.accountId);
      if (previous?.state === 'active') {
        const changed = this.write("UPDATE community_invitations SET state='redeemed',revision=revision+1,redeemed_account_id=?,member_generation=? WHERE id=? AND state='pending' AND expires_at>?", actor.accountId, previous.generation, invite.id, this.now());
        if (changed.changes !== 1) unavailableInvite();
        this.record(actor, 'join', key, intent, group.id, invite.id, previous.generation);
        return { groupId: group.id, memberId: previous.member_id };
      }
      this.accountCapacity(actor.accountId);
      if (this.get<{ n: number }>("SELECT count(*) n FROM community_members WHERE group_id=? AND state='active'", group.id)!.n >= 50)
        throw new DomainError(409, 'community_group_capacity');
      const now = this.now(); const generation = previous ? previous.generation + 1 : 1;
      const changed = this.write("UPDATE community_invitations SET state='redeemed',revision=revision+1,redeemed_account_id=?,member_generation=? WHERE id=? AND state='pending' AND expires_at>?", actor.accountId, generation, invite.id, now);
      if (changed.changes !== 1) unavailableInvite();
      const memberId = randomUUID(); const memberRevision = previous ? previous.revision + 1 : 1;
      this.write(`INSERT INTO community_members(group_id,account_id,member_id,alias,role,state,revision,generation,joined_at,ended_at)
        VALUES(?,?,?,?,'member','active',?,?,?,NULL) ON CONFLICT(group_id,account_id) DO UPDATE SET member_id=excluded.member_id,
        alias=excluded.alias,role='member',state='active',revision=excluded.revision,generation=excluded.generation,joined_at=excluded.joined_at,ended_at=NULL`,
      group.id, actor.accountId, memberId, body.alias, memberRevision, generation, now);
      this.write('DELETE FROM community_share_settings WHERE group_id=? AND account_id=?', group.id, actor.accountId);
      this.initShare(this.member(group.id, actor.accountId), now);
      if (this.reservation(invite.id)) { const hooks = this.hooks(); if (!hooks.consumeReservedJoin) throw new DomainError(503, 'community_reserved_join_unavailable'); hooks.consumeReservedJoin(actor, group.id, invite.id); }
      this.record(actor, 'join', key, intent, group.id, invite.id, generation, 201); return { groupId: group.id, memberId };
    });
  }
  revokeInvitation(actor: AccountContext, groupId: string, inviteId: string, input: unknown, key: string): InvitationView {
    const body = s.parse(s.revisionSchema, input); return this.active(actor, () => {
      const { member } = this.access(actor, groupId); const row = this.invitation(groupId, inviteId);
      if (member.role === 'member' && (row.issuer_account_id !== actor.accountId || !this.reservation(inviteId))) missing();
      const op = `revoke:${groupId}:${inviteId}`;
      this.hooks().guardLegacy(actor, groupId, 'read', row.issuer_account_id);
      if (row.redeemed_account_id) this.hooks().guardLegacy(actor, groupId, 'read', row.redeemed_account_id);
      if (!this.receipt(actor, op, key, body)) {
        revision(row.revision, body.expectedRevision);
        if (row.state === 'pending') this.write("UPDATE community_invitations SET state='revoked',revision=revision+1 WHERE id=?", inviteId);
        if (this.reservation(inviteId)) this.write("UPDATE community_seat_reservations SET state='cancelled' WHERE invitation_id=? AND state='available'", inviteId);
        this.record(actor, op, key, body, groupId, inviteId, row.revision);
      }
      return this.inviteView(this.invitation(groupId, inviteId));
    });
  }
  replaceInvitation(actor: AccountContext, groupId: string, inviteId: string, input: unknown, key: string): IssuedInvitation {
    const body = s.parse(s.revisionSchema, input); return this.active(actor, () => {
      const { group, member } = this.manager(actor, groupId); const op = `replace:${groupId}:${inviteId}`;
      const resolved = this.invitation(groupId, inviteId);
      this.hooks().guardLegacy(actor, groupId, 'issue_invitation', resolved.issuer_account_id);
      if (resolved.redeemed_account_id) this.hooks().guardLegacy(actor, groupId, 'read', resolved.redeemed_account_id);
      const prior = this.receipt(actor, op, key, body); if (prior) {
        if (prior.effect_generation !== member.generation) missing(); const current = this.invitation(groupId, prior.effect_id);
        this.hooks().guardLegacy(actor, groupId, 'read', current.issuer_account_id);
        if (current.redeemed_account_id) this.hooks().guardLegacy(actor, groupId, 'read', current.redeemed_account_id);
        return this.inviteView(current);
      }
      const old = this.invitation(groupId, inviteId); revision(old.revision, body.expectedRevision);
      if (old.state === 'redeemed') throw new DomainError(409, 'community_invitation_used');
      this.limit(actor, 'invitation_issue');
      if (old.state === 'pending') this.write("UPDATE community_invitations SET state='revoked',revision=revision+1 WHERE id=?", inviteId);
      const issued = this.issue(group, member); this.record(actor, op, key, body, groupId, issued.id, member.generation, 201); return issued;
    });
  }
  readSharing(actor: AccountContext, groupId: string): OwnShare {
    return this.active(actor, () => { const { member } = this.access(actor, groupId); return this.shareView(this.share(member)); });
  }
  updateSharing(actor: AccountContext, groupId: string, input: unknown, key: string): OwnShare {
    const body = s.parse(s.sharingSchema, input); return this.active(actor, () => {
      const { member } = this.access(actor, groupId); const row = this.share(member); const op = `sharing:${groupId}`;
      const prior = this.receipt(actor, op, key, body);
      if (prior) { if (member.generation !== prior.effect_generation) missing(); return this.shareView(row); }
      revision(row.revision, body.expectedRevision); const flags: OwnShareFlags = { ...body.flags };
      if ((!row.workout && !flags.workout && (flags.workoutMinutes || flags.exerciseCount)) ||
        (!row.planAdherence && !flags.planAdherence && flags.streakDays)) throw new DomainError(422, 'community_sharing_dependency');
      if (!flags.workout) { flags.workoutMinutes = false; flags.exerciseCount = false; }
      if (!flags.planAdherence) flags.streakDays = false;
      const now = this.now(); const assignments = shareFields.flatMap(f => [`${f}=?`, `${f}_enabled_at=?`]);
      const values = shareFields.flatMap(f => [flags[f] ? 1 : 0, flags[f] ? (row[f] === 1 ? row[`${f}_enabled_at`] : now) : null]);
      this.write(`UPDATE community_share_settings SET ${assignments.join(',')},revision=revision+1,updated_at=? WHERE group_id=? AND account_id=?`, ...values, now, groupId, actor.accountId);
      this.record(actor, op, key, body, groupId, member.member_id, member.generation); return this.shareView(this.share(member));
    });
  }
  withdraw(actor: AccountContext, groupId: string, input: unknown, key: string): { withdrawn: true } {
    const body = s.parse(s.emptySchema, input); return this.active(actor, () => {
      this.session(actor); s.parse(s.identifier, groupId); const op = `withdraw:${groupId}`; const prior = this.receipt(actor, op, key, body);
      const member = this.get<Member>('SELECT * FROM community_members WHERE group_id=? AND account_id=?', groupId, actor.accountId);
      if (!member) missing();
      if (prior && member.generation !== prior.effect_generation && member.state === 'active') throw new DomainError(409, 'community_membership_changed');
      const current = this.get<Share>('SELECT * FROM community_share_settings WHERE group_id=? AND account_id=?', groupId, actor.accountId);
      if (!prior || current && shareFields.some(f => current[f] !== 0)) this.clearShare(groupId, actor.accountId, this.now());
      if (!prior) this.record(actor, op, key, body, groupId, member.member_id, member.generation);
      return { withdrawn: true };
    });
  }
  updateAlias(actor: AccountContext, groupId: string, input: unknown, key: string): MemberView {
    const body = s.parse(s.aliasSchema, input); return this.active(actor, () => {
      const { member } = this.access(actor, groupId); const op = `alias:${groupId}`;
      this.hooks().authorizeGroupText(actor, 'alias', body.alias); const prior = this.receipt(actor, op, key, body);
      if (prior && prior.effect_generation !== member.generation) missing();
      if (!prior) { revision(member.revision, body.expectedRevision);
        this.write('UPDATE community_members SET alias=?,revision=revision+1 WHERE group_id=? AND account_id=?', body.alias, groupId, actor.accountId);
        this.record(actor, op, key, body, groupId, member.member_id, member.generation); }
      return this.memberView(this.member(groupId, actor.accountId));
    });
  }
  leave(actor: AccountContext, groupId: string, input: unknown, key: string): { left: true } {
    const body = s.parse(s.emptySchema, input); return this.active(actor, () => {
      this.session(actor); s.parse(s.identifier, groupId); const op = `leave:${groupId}`;
      const prior = this.receipt(actor, op, key, body);
      const member = this.get<Member>('SELECT * FROM community_members WHERE group_id=? AND account_id=?', groupId, actor.accountId);
      if (!member) missing();
      if (prior) {
        if (member.state === 'active') throw new DomainError(409, 'community_membership_changed'); return { left: true };
      }
      if (member.state === 'active') {
        if (member.role === 'owner' && this.get<Group>('SELECT * FROM community_groups WHERE id=?', groupId)?.state === 'active')
          throw new DomainError(409, 'community_owner_must_close');
        this.endMember(member, 'left', this.now());
      }
      this.record(actor, op, key, body, groupId, member.member_id, member.generation); return { left: true };
    });
  }
  private target(groupId: string, memberId: string): Member {
    s.parse(s.identifier, memberId); const member = this.get<Member>('SELECT * FROM community_members WHERE group_id=? AND member_id=?', groupId, memberId);
    if (!member) missing(); return member;
  }
  removeMember(actor: AccountContext, groupId: string, memberId: string, input: unknown, key: string): { removed: true } {
    const body = s.parse(s.revisionSchema, input); return this.active(actor, () => {
      const access = this.manager(actor, groupId); const target = this.target(groupId, memberId);
      if (target.role === 'owner' || (access.member.role === 'admin' && target.role !== 'member')) missing();
      this.hooks().guardLegacy(actor, groupId, 'remove', target.account_id);
      const op = `remove:${groupId}:${memberId}`;
      const prior = this.receipt(actor, op, key, body);
      if (prior && target.state === 'active') throw new DomainError(409, 'community_membership_changed');
      if (!prior) {
        revision(target.revision, body.expectedRevision); if (target.state === 'active') this.endMember(target, 'removed', this.now());
        else if (target.state === 'left') {
          this.write("UPDATE community_members SET state='removed',revision=revision+1,generation=generation+1 WHERE group_id=? AND account_id=?", groupId, target.account_id);
          this.write('UPDATE community_share_settings SET membership_generation=? WHERE group_id=? AND account_id=?', target.generation + 1, groupId, target.account_id);
          captureRemovalSnapshot(this.deps.db, groupId, target.account_id, null, this.now());
          this.hooks().afterMemberEnds(groupId, target.account_id);
        }
        this.record(actor, op, key, body, groupId, memberId, target.generation);
      }
      return { removed: true };
    });
  }
  updateRole(actor: AccountContext, groupId: string, memberId: string, input: unknown, key: string): MemberView {
    const body = s.parse(s.roleSchema, input); return this.active(actor, () => {
      this.manager(actor, groupId, true); const target = this.target(groupId, memberId);
      if (target.role === 'owner' || target.state !== 'active') missing();
      this.hooks().guardLegacy(actor, groupId, 'role', target.account_id); const op = `role:${groupId}:${memberId}`;
      if (!this.receipt(actor, op, key, body)) { revision(target.revision, body.expectedRevision);
        this.write('UPDATE community_members SET role=?,revision=revision+1,generation=generation+1 WHERE group_id=? AND account_id=?', body.role, groupId, target.account_id);
        this.revokeIssuer(groupId, target.account_id); this.clearShare(groupId, target.account_id, this.now());
        this.write('UPDATE community_share_settings SET membership_generation=? WHERE group_id=? AND account_id=?', target.generation + 1, groupId, target.account_id);
        this.record(actor, op, key, body, groupId, memberId, target.generation + 1);
      }
      return this.memberView(this.target(groupId, memberId));
    });
  }
  allowReinvite(actor: AccountContext, groupId: string, memberId: string, input: unknown, key: string): { allowed: true } {
    const body = s.parse(s.revisionSchema, input); return this.active(actor, () => {
      this.manager(actor, groupId, true); const target = this.target(groupId, memberId); const op = `reinvite:${groupId}:${memberId}`;
      this.hooks().guardLegacy(actor, groupId, 'reinvite', target.account_id);
      if (!this.receipt(actor, op, key, body)) {
        revision(target.revision, body.expectedRevision); if (target.state !== 'removed') throw new DomainError(409, 'community_member_not_removed');
        this.write("UPDATE community_members SET state='left',revision=revision+1,generation=generation+1 WHERE group_id=? AND account_id=?", groupId, target.account_id);
        this.write('UPDATE community_share_settings SET membership_generation=? WHERE group_id=? AND account_id=?', target.generation + 1, groupId, target.account_id);
        this.record(actor, op, key, body, groupId, memberId, target.generation + 1);
      }
      return { allowed: true };
    });
  }
  closeGroup(actor: AccountContext, groupId: string, input: unknown, key: string): { closed: true } {
    const body = s.parse(s.revisionSchema, input); return this.active(actor, () => {
      this.session(actor); s.parse(s.identifier, groupId);
      const group = this.get<Group>('SELECT * FROM community_groups WHERE id=?', groupId);
      if (!group || group.owner_account_id !== actor.accountId) missing();
      const op = `close:${groupId}`; const prior = this.receipt(actor, op, key, body);
      if (prior && group.state === 'closed') return { closed: true };
      this.manager(actor, groupId, true); revision(group.revision, body.expectedRevision); this.closeRows(group, this.now());
      this.record(actor, op, key, body, groupId, groupId, group.generation); return { closed: true };
    });
  }

  private activityProof(actor: AccountContext, groupId: string, input: CommunityActivityReadInput): {
    context: CommunityActivityAuthorization; release: () => void;
  } {
    const range = s.parse(s.rangeSchema, { from: input.from, to: input.to });
    s.parse(s.identifier, input.subjectAccountId);
    if (!Array.isArray(input.fields) || input.fields.length === 0 || new Set(input.fields).size !== input.fields.length ||
      input.fields.some(field => !activityFields.includes(field))) throw new DomainError(403, 'community_activity_unauthorized');
    const fields: readonly ActivityField[] = [...input.fields];
    const identity = Object.freeze({ ...actor });
    const { group, member: viewer } = this.access(identity, groupId);
    const subject = this.member(group.id, input.subjectAccountId);
    this.hooks().assertPairVisible(identity, group.id, subject.account_id);
    const initialShare = this.share(subject);
    const subjectEligibility = () => {
      const value = this.deps.subjectEligibility?.(subject.account_id);
      if (value?.policy !== 'self_reported_adult_v1' || value.status !== 'eligible' || value.profileRevision === null ||
        !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 0)
        throw new DomainError(403, 'community_activity_unauthorized');
      return value.profileRevision;
    };
    const profileRevision = subjectEligibility();
    let live = true;
    const assertBoundary = () => {
      if (!live || !this.deps.db.inTransaction) throw new DomainError(403, 'community_activity_unauthorized');
      this.session(identity);
    };
    const assertSubjectActive = () => {
      assertBoundary();
      const current = this.member(group.id, subject.account_id);
      this.hooks().assertPairVisible(identity, group.id, current.account_id);
      if (current.member_id !== subject.member_id || current.generation !== subject.generation || current.revision !== subject.revision ||
        subjectEligibility() !== profileRevision) throw new DomainError(403, 'community_activity_unauthorized');
    };
    const assertAuthorized = (request: CommunityActivityReadInput) => {
      assertBoundary();
      if (request.subjectAccountId !== subject.account_id || request.from !== range.from || request.to !== range.to ||
        !Array.isArray(request.fields) || request.fields.length !== fields.length || new Set(request.fields).size !== fields.length ||
        request.fields.some(field => !fields.includes(field))) throw new DomainError(403, 'community_activity_unauthorized');
      const current = this.access(identity, group.id);
      if (current.group.generation !== group.generation || current.group.revision !== group.revision ||
        current.member.member_id !== viewer.member_id || current.member.generation !== viewer.generation || current.member.revision !== viewer.revision)
        throw new DomainError(403, 'community_activity_unauthorized');
      assertSubjectActive();
      const sharing = this.share(this.member(group.id, subject.account_id));
      if (sharing.revision !== initialShare.revision || sharing.membership_generation !== initialShare.membership_generation)
        throw new DomainError(403, 'community_activity_unauthorized');
      const flags = this.shareView(sharing).flags;
      for (const field of fields) {
        const base = field === 'workout' || field === 'exerciseSnack' || field === 'planAdherence';
        if (!flags[field] && !(base && flags.participation)) throw new DomainError(403, 'community_activity_unauthorized');
      }
    };
    assertAuthorized(input);
    return { context: Object.freeze({ subjectAccountId: subject.account_id, assertAuthorized, assertSubjectActive }), release: () => { live = false; } };
  }
  withActivityAuthorization<T>(actor: AccountContext, groupId: string, input: CommunityActivityReadInput,
    consume: (context: CommunityActivityAuthorization) => T): T {
    return this.active(actor, () => {
      const proof = this.activityProof(actor, groupId, input);
      try {
        const value = consume(proof.context);
        proof.context.assertSubjectActive(); proof.context.assertAuthorized(input);
        return value;
      } finally { proof.release(); }
    });
  }

  readSummary(actor: AccountContext, groupId: string, input: unknown): CommunitySummary {
    const range = s.parse(s.rangeSchema, input);
    return this.active(actor, () => {
      const { member: viewer } = this.access(actor, groupId);
      if (!this.deps.activity && !this.deps.activityFor) return { summaryStatus: 'unavailable', members: [] };
      const members: CommunitySummary['members'] = [];
      const proofs: { context: CommunityActivityAuthorization; release: () => void; request: CommunityActivityReadInput }[] = [];
      try {
      for (const subject of this.rows<Member>("SELECT * FROM community_members WHERE group_id=? AND state='active' ORDER BY member_id LIMIT 50", groupId)) {
        if (!this.pairVisible(actor, groupId, subject.account_id) || !this.eligible(subject.account_id, actor)) continue;
        const share = this.shareView(this.share(subject));
        const fields = new Set<ActivityField>();
        for (const f of activityFields) if (share.flags[f]) fields.add(f);
        if (share.flags.participation) { fields.add('workout'); fields.add('exerciseSnack'); fields.add('planAdherence'); }
        if (fields.size === 0) { members.push({ memberId: subject.member_id, alias: subject.alias, days: [] }); continue; }
        let result: ReturnType<typeof s.activityResultSchema.parse>;
        try {
          const request = Object.freeze({ subjectAccountId: subject.account_id, ...range, fields: Object.freeze([...fields]) });
          const proof = this.activityProof(actor, groupId, request);
          proofs.push({ ...proof, request });
          const reader = this.deps.activityFor ? this.deps.activityFor(proof.context) : this.deps.activity!;
          proof.context.assertAuthorized(request); proof.context.assertSubjectActive();
          const raw: unknown = reader.readDays(request);
          proof.context.assertSubjectActive(); proof.context.assertAuthorized(request);
          const parsed = s.activityResultSchema.safeParse(raw);
          if (!parsed.success) return { summaryStatus: 'unavailable', members: [] };
          result = parsed.data;
        } catch { return { summaryStatus: 'unavailable', members: [] }; }
        if (result.status === 'unavailable') return { summaryStatus: 'unavailable', members: [] };
        const days: SharedDay[] = []; const dates = new Set<string>();
        for (const day of result.days) {
          const start = Date.parse(day.dayStartAt); const end = Date.parse(day.dayEndAt);
          if (day.localDate < range.from || day.localDate > range.to || dates.has(day.localDate) || start >= end ||
            start > Date.parse(this.now()) || end - start > 48 * 3600000) return { summaryStatus: 'unavailable', members: [] };
          dates.add(day.localDate);
          try {
            const local = (at: number) => {
              const parts = new Intl.DateTimeFormat('en-US', { timeZone: day.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
              const part = (kind: string) => parts.find(p => p.type === kind)?.value;
              return `${part('year')}-${part('month')}-${part('day')}`;
            };
            if (local(start) !== day.localDate || local(end - 1) !== day.localDate || local(start - 1) === day.localDate || local(end) === day.localDate)
              return { summaryStatus: 'unavailable', members: [] };
          } catch { return { summaryStatus: 'unavailable', members: [] }; }
          for (const field of activityFields) {
            if (!fields.has(field) && Object.hasOwn(day, field)) return { summaryStatus: 'unavailable', members: [] };
            if (fields.has(field) && ['workout', 'exerciseSnack', 'planAdherence'].includes(field) && day[field] === undefined)
              return { summaryStatus: 'unavailable', members: [] };
          }
          const visible = (field: typeof shareFields[number]) => share.flags[field] && start >= Math.max(
            Date.parse(share.enabledAt[field]!), Date.parse(subject.joined_at), Date.parse(viewer.joined_at));
          const projected: SharedDay = { localDate: day.localDate };
          if (visible('workout')) projected.workout = day.workout!;
          if (visible('exerciseSnack')) projected.exerciseSnack = day.exerciseSnack!;
          if (visible('planAdherence')) projected.planAdherence = day.planAdherence!;
          if (visible('workoutMinutes') && visible('workout') && day.workoutMinutes !== undefined) projected.workoutMinutes = day.workoutMinutes;
          if (visible('exerciseCount') && visible('workout') && day.exerciseCount !== undefined) projected.exerciseCount = day.exerciseCount;
          if (visible('streakDays') && visible('planAdherence') && day.streakDays !== undefined) projected.streakDays = day.streakDays;
          if (visible('participation')) {
            projected.participation = day.workout === 'recorded' || day.exerciseSnack === 'recorded' || day.planAdherence === 'met' ? 'recorded' :
              day.workout === 'unknown' || day.exerciseSnack === 'unknown' || day.planAdherence === 'unknown' || day.planAdherence === 'pending' ? 'unknown' : 'not_recorded';
          }
          if (Object.keys(projected).length > 1) days.push(projected);
        }
        const current = this.member(groupId, subject.account_id);
        if (!this.pairVisible(actor, groupId, current.account_id)) return { summaryStatus: 'unavailable', members: [] };
        const currentShare = this.share(current);
        if (current.generation !== subject.generation || currentShare.revision !== share.revision || !this.eligible(subject.account_id, actor))
          return { summaryStatus: 'unavailable', members: [] };
        members.push({ memberId: subject.member_id, alias: subject.alias, days });
      }
      for (const proof of proofs) { proof.context.assertSubjectActive(); proof.context.assertAuthorized(proof.request); }
      this.access(actor, groupId); return { summaryStatus: 'available', members };
      } finally { for (const proof of proofs) proof.release(); }
    });
  }

  private lifecycleTransaction(): void {
    if (!this.deps.db.inTransaction) throw new DomainError(503, 'community_lifecycle_serialization_required');
  }
  inventoryAccount(actor: AccountContext): CommunityCounts {
    this.lifecycleTransaction(); this.session(actor); return this.counts(actor.accountId);
  }
  private counts(accountId: string): CommunityCounts {
    const count = (table: string, column: string) => this.get<{ n: number }>(`SELECT count(*) n FROM ${table} WHERE ${column}=?`, accountId)!.n;
    return { groups: count('community_groups', 'owner_account_id'), memberships: count('community_members', 'account_id'),
      sharing: count('community_share_settings', 'account_id'), invitations: count('community_invitations', 'issuer_account_id'), receipts: count('community_command_receipts', 'account_id') };
  }
  exportBounds(actor: AccountContext): CommunityExportBounds {
    this.lifecycleTransaction(); this.session(actor);
    return addCommunityExportBounds([
      { rows: 0, bytes: 2048 },
      estimateCommunityRows(this.deps.db, removalSnapshotExportSql, [actor.accountId]),
      estimateCommunityRows(this.deps.db, 'SELECT id,display_name,state,revision,created_at,closed_at FROM community_groups WHERE owner_account_id=?', [actor.accountId]),
      estimateCommunityRows(this.deps.db, 'SELECT group_id,member_id,alias,role,state,revision,joined_at,ended_at FROM community_members WHERE account_id=?', [actor.accountId]),
      estimateCommunityRows(this.deps.db, 'SELECT * FROM community_share_settings WHERE account_id=?', [actor.accountId]),
      estimateCommunityRows(this.deps.db, 'SELECT id,group_id,state,revision,created_at,expires_at FROM community_invitations WHERE issuer_account_id=?', [actor.accountId]),
    ]);
  }
  exportAccount(actor: AccountContext, append: (category: string, value: unknown) => void): number {
    this.lifecycleTransaction(); this.session(actor); assertCommunityExportBounds(this.exportBounds(actor)); let count = 0;
    const emit = (value: unknown) => { if (++count > 100000) throw new DomainError(413, 'community_export_packaging_required'); append('community', value); };
    for (const row of this.deps.db.prepare(removalSnapshotExportSql).iterate(actor.accountId)) emit({ kind: 'own_removal_snapshot', data: row });
    for (const row of this.deps.db.prepare('SELECT id,display_name,state,revision,created_at,closed_at FROM community_groups WHERE owner_account_id=? ORDER BY id').iterate(actor.accountId)) emit({ kind: 'owned_group', data: row });
    for (const row of this.deps.db.prepare('SELECT group_id,member_id,alias,role,state,revision,joined_at,ended_at FROM community_members WHERE account_id=? ORDER BY group_id').iterate(actor.accountId)) emit({ kind: 'own_membership', data: row });
    for (const row of this.deps.db.prepare('SELECT * FROM community_share_settings WHERE account_id=? ORDER BY group_id').iterate(actor.accountId)) {
      const share = row as Share; emit({ kind: 'own_sharing', groupId: share.group_id, ...this.shareView(share) });
    }
    for (const row of this.deps.db.prepare('SELECT id,group_id,state,revision,created_at,expires_at FROM community_invitations WHERE issuer_account_id=? ORDER BY id').iterate(actor.accountId)) emit({ kind: 'issued_invitation', data: row });
    this.session(actor); return count;
  }
  suppressAccountCommunity(accountId: string, epoch: number): CommunityCounts {
    this.lifecycleTransaction(); this.validateLifecycleInput(accountId, epoch); const now = this.now();
    for (const group of this.rows<Group>("SELECT * FROM community_groups WHERE owner_account_id=? AND state='active'", accountId)) this.closeRows(group, now);
    for (const member of this.rows<Member>("SELECT * FROM community_members WHERE account_id=? AND state='active'", accountId)) this.endMember(member, 'left', now);
    this.write("UPDATE community_members SET alias='' WHERE account_id=?", accountId);
    this.write('DELETE FROM community_removal_snapshots WHERE account_id=?', accountId);
    for (const share of this.rows<{ group_id: string }>('SELECT group_id FROM community_share_settings WHERE account_id=?', accountId)) this.clearShare(share.group_id, accountId, now);
    this.write("UPDATE community_invitations SET state='revoked',revision=revision+1 WHERE issuer_account_id=? AND state='pending'", accountId);
    return this.counts(accountId);
  }
  private validateLifecycleInput(accountId: string, epoch: number): void {
    if (!accountId || !Number.isSafeInteger(epoch) || epoch < 0) throw new DomainError(422, 'community_invalid_lifecycle_input');
  }
  verifySuppressed(accountId: string, epoch: number): boolean {
    this.lifecycleTransaction(); this.validateLifecycleInput(accountId, epoch);
    if (this.get('SELECT 1 FROM community_removal_snapshots WHERE account_id=? LIMIT 1', accountId) ||
      this.get("SELECT 1 FROM community_groups WHERE owner_account_id=? AND state='active' LIMIT 1", accountId) ||
      this.get("SELECT 1 FROM community_members WHERE account_id=? AND (state='active' OR alias<>'') LIMIT 1", accountId) ||
      this.get(`SELECT 1 FROM community_share_settings WHERE account_id=? AND (${shareFields.map(f => `${f}<>0 OR ${f}_enabled_at IS NOT NULL`).join(' OR ')}) LIMIT 1`, accountId) ||
      this.get("SELECT 1 FROM community_invitations WHERE issuer_account_id=? AND state='pending' LIMIT 1", accountId)) return false;
    return true;
  }
  purgeAccountCommunity(requestId: string, accountId: string): CommunityCounts {
    this.lifecycleTransaction(); s.parse(s.identifier, requestId); this.validateLifecycleInput(accountId, 0);
    if (!this.verifySuppressed(accountId, 0)) throw new DomainError(409, 'community_suppression_required');
    const before = this.counts(accountId);
    for (const group of this.rows<{ id: string }>('SELECT id FROM community_groups WHERE owner_account_id=?', accountId)) {
      this.write('DELETE FROM community_share_settings WHERE group_id=?', group.id);
      this.write('DELETE FROM community_invitations WHERE group_id=?', group.id);
      this.write('DELETE FROM community_removal_snapshots WHERE group_id=?', group.id);
      this.write('DELETE FROM community_members WHERE group_id=?', group.id);
      this.write('DELETE FROM community_command_receipts WHERE group_id=?', group.id);
      this.write('DELETE FROM community_groups WHERE id=?', group.id);
    }
    this.write('DELETE FROM community_share_settings WHERE account_id=?', accountId);
    this.write('DELETE FROM community_invitations WHERE issuer_account_id=?', accountId);
    this.write('UPDATE community_invitations SET redeemed_account_id=NULL,member_generation=NULL,state=\'revoked\',revision=revision+1 WHERE redeemed_account_id=?', accountId);
    this.write('DELETE FROM community_removal_snapshots WHERE account_id=?', accountId);
    this.write('DELETE FROM community_members WHERE account_id=?', accountId);
    this.write('DELETE FROM community_command_receipts WHERE account_id=?', accountId);
    if (Object.values(this.counts(accountId)).some(n => n !== 0)) throw new DomainError(503, 'community_purge_readback_failed');
    return before;
  }
  reconcileCommunityRestore(authority: AuthoritativeRestoreState): { invitationsRevoked: number; sharesReset: number } {
    this.lifecycleTransaction(); if (authority?.ready !== true || typeof authority.lookup !== 'function') throw new DomainError(503, 'community_restore_authority_required');
    const accounts = this.rows<{ account_id: string }>(`SELECT account_id FROM community_members UNION SELECT owner_account_id FROM community_groups
      UNION SELECT issuer_account_id FROM community_invitations UNION SELECT account_id FROM community_share_settings UNION SELECT account_id FROM community_command_receipts`);
    for (const account of accounts) {
      const state = authority.lookup(account.account_id); if (!state || !Number.isSafeInteger(state.epoch) || state.epoch < 0) throw new DomainError(503, 'community_restore_authority_required');
      if (state.state === 'suppressed') this.suppressAccountCommunity(account.account_id, state.epoch);
      else if (state.state !== 'active') throw new DomainError(503, 'community_restore_authority_required');
    }
    this.write('DELETE FROM community_command_receipts');
    if (this.get('SELECT 1 FROM community_command_receipts LIMIT 1')) throw new DomainError(503, 'community_restore_integrity_failed');
    const revoked = this.write("UPDATE community_invitations SET state='revoked',revision=revision+1 WHERE state='pending'").changes;
    const reset = this.write(`UPDATE community_share_settings SET ${shareFields.flatMap(f => [`${f}=0`, `${f}_enabled_at=NULL`]).join(',')},revision=revision+1,updated_at=?`, this.now()).changes;
    this.write("UPDATE community_groups SET generation=generation+1,revision=revision+1 WHERE state='active'");
    this.write("UPDATE community_members SET generation=generation+1,revision=revision+1 WHERE state='active'");
    this.write(`UPDATE community_share_settings SET membership_generation=(SELECT generation FROM community_members m WHERE m.group_id=community_share_settings.group_id AND m.account_id=community_share_settings.account_id)`);
    if (this.get(`SELECT 1 FROM community_members m LEFT JOIN community_groups g ON g.id=m.group_id WHERE g.id IS NULL OR
      (m.state='active' AND g.state<>'active') LIMIT 1`) || this.get(`SELECT 1 FROM community_share_settings s LEFT JOIN community_members m
      ON m.group_id=s.group_id AND m.account_id=s.account_id WHERE m.account_id IS NULL OR s.membership_generation<>m.generation LIMIT 1`) ||
      this.get(`SELECT 1 FROM community_invitations i LEFT JOIN community_groups g ON g.id=i.group_id WHERE g.id IS NULL LIMIT 1`) ||
      this.get(`SELECT 1 FROM community_groups g WHERE g.state='active' AND (SELECT count(*) FROM community_members m WHERE m.group_id=g.id AND m.state='active' AND m.role='owner' AND m.account_id=g.owner_account_id)<>1 LIMIT 1`))
      throw new DomainError(503, 'community_restore_integrity_failed');
    return { invitationsRevoked: revoked, sharesReset: reset };
  }
}

export function createCommunity(deps: CommunityDependencies): CommunityService { return new CommunityService(deps); }
