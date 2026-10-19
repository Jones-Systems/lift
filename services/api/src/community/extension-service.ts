import { createHash, randomUUID } from 'node:crypto';
import { DomainError, revision } from '../errors.js';
import type { AccountContext, ExportSnapshot } from '../lifecycle/types.js';
import { shareFields } from './types.js';
import { estimateCommunityRows, addCommunityExportBounds, assertCommunityExportBounds, type CommunityExportBounds } from './export-bounds.js';
import * as s from './extension-schemas.js';
import { captureRemovalSnapshot } from './removal-snapshots.js';
import { batchIdentity, pairRelaxations, planCommunityBatch, sundayPolicy } from './matching.js';
import { DAY_MS, motionOutcome, requiredYes, reserveCapacity } from './governance.js';
import { privateProfile, profileProjection } from './profiles.js';
import { postExpiry, postReadable } from './posts.js';
import type { BatchCandidate, BatchSnapshot, CommunityExtensionCapabilities, ExtensionDependencies, ExtensionMember, GroupPolicyView, GroupPostView,
 FriendInvitationView, FriendReservationView, GroupProfileShare, MatchBatchPolicy, MatchEnrollmentView, MatchIntent, MotionView, SafetyCaseView, SafetyReferenceView } from './extension-types.js';
type Enrollment = { id: string; account_id: string; revision: number; generation: number; state: MatchEnrollmentView['state']; preferences: string | null; queued_at: string | null; consent_at: string | null; cooldown_until: string | null; missed_batches: number };
type Group = { id: string; state: string; generation: number; owner_account_id: string; created_at: string; revision: number };
type Policy = { group_id: string; kind: 'matched'; intent: MatchIntent; capacity: number; revision: number; last_growth_at: string | null };
type Post = { id: string; group_id: string; group_generation: number; author_account_id: string; membership_generation: number; revision: number;
 kind: 'check_in' | 'win'; template: 'checking_in' | 'at_my_pace' | null; text: string | null; state: GroupPostView['state']; created_at: string; expires_at: string };
type Motion = { id: string; group_id: string; group_generation: number; sponsor_account_id: string; sponsor_generation: number; kind: 'growth' | 'friend' | 'removal';
 subject_account_id: string | null; subject_generation: number | null; places: number; revision: number; electorate_size: number; required_yes: number; state: string; created_at: string; expires_at: string };
type Reservation = { id: string; motion_id: string; group_id: string; group_generation: number; sponsor_account_id: string; sponsor_generation: number;
 seats: number; consumed: number; state: FriendReservationView['state']; expires_at: string; invitation_id: string | null };
type Case = { id: string; account_id: string; state: string; revision: number; created_at: string; expires_at: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
 ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value) ?? 'null';
function missing(): never { throw new DomainError(404, 'community_not_found'); }
export class CommunityExtensionService {
 constructor(private readonly deps: ExtensionDependencies) {}
 private get<T>(sql: string, ...args: unknown[]): T | undefined { return this.deps.db.prepare(sql).get(...args) as T | undefined; }
 private rows<T>(sql: string, ...args: unknown[]): T[] { return this.deps.db.prepare(sql).all(...args) as T[]; }
 private write(sql: string, ...args: unknown[]) { return this.deps.db.prepare(sql).run(...args); }
 private now(): string { const value = this.deps.now(); if (!Number.isFinite(value.getTime())) throw new DomainError(503, 'community_clock_unavailable'); return value.toISOString(); }
 private session(actor: AccountContext): void { if (!actor?.accountId || !actor.authUserId || !actor.sessionId || !Number.isSafeInteger(actor.epoch) || actor.epoch < 0) throw new DomainError(401, 'unauthenticated');
  if (!this.deps.lifecycle) throw new DomainError(503, 'community_lifecycle_unavailable'); this.deps.lifecycle.assertActive(actor); }
 private active<T>(actor: AccountContext, effect: () => T): T { this.session(actor); return this.deps.lifecycle!.withActiveWrite(actor, () => { this.session(actor); const value = effect(); this.session(actor); return value; }); }
 private adult(actor: AccountContext): void { this.session(actor); const value = this.deps.lifecycle!.adultEligibility(actor); if (!this.eligible(value)) throw new DomainError(403, 'community_adult_eligibility_unavailable'); }
 private eligible(value: ReturnType<NonNullable<ExtensionDependencies['subjectEligibility']>> | undefined): boolean { return value?.policy === 'self_reported_adult_v1' && value.status === 'eligible' && Number.isSafeInteger(value.profileRevision) && (value.profileRevision ?? -1) >= 0; }
 private subject(member: ExtensionMember): boolean { try { return this.eligible(this.deps.subjectEligibility?.(member.account_id)); } catch { return false; } }
 private access(actor: AccountContext, groupId: string, adult = true): { group: Group; member: ExtensionMember } {
  s.parse(s.id, groupId); if (adult) this.adult(actor); else this.session(actor);
  const group = this.get<Group>("SELECT * FROM community_groups WHERE id=? AND state='active'", groupId);
  const member = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", groupId, actor.accountId);
  if (!group || !member) missing(); return { group, member };
 }
 private policy(groupId: string): Policy { const value = this.get<Policy>('SELECT * FROM community_group_policy WHERE group_id=?', groupId); if (!value) missing(); return value; }
 private target(groupId: string, memberId: string): ExtensionMember { s.parse(s.id, memberId); const value = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND member_id=? AND state='active'", groupId, memberId); if (!value) missing(); return value; }
 // Internal callers must resolve the author through their own resource authority first.
 isBlocked(viewer: AccountContext, authorAccountId: string): boolean {
  this.serialization(); this.session(viewer); s.parse(s.id, authorAccountId);
  const result = this.blocked(viewer.accountId, authorAccountId); this.session(viewer); return result;
 }
 private blocked(a: string, b: string): boolean { return !!this.get("SELECT 1 FROM community_blocks WHERE active=1 AND ((owner_account_id=? AND subject_account_id=?) OR (owner_account_id=? AND subject_account_id=?))", a, b, b, a); }
 private limit(actor: AccountContext, action: 'post' | 'reaction' | 'report' | 'motion'): void { if (!this.deps.assertRateLimit) throw new DomainError(503, 'community_limiter_unavailable'); this.deps.assertRateLimit(actor, action); }
 private count(sql: string, ...args: unknown[]): number { return this.get<{ n: number }>(sql, ...args)?.n ?? 0; }
 private bounded(raw: string, max = 8192): unknown { if (Buffer.byteLength(raw) > max) throw new DomainError(413, 'community_stored_value_too_large'); try { return JSON.parse(raw); } catch { throw new DomainError(503, 'community_integrity_unavailable'); } }
 private replay(actor: AccountContext, operation: string, key: string, intent: unknown): string | null {
  s.parse(s.keySchema, key); const row = this.get<{ intent_hash: string; effect_id: string }>('SELECT intent_hash,effect_id FROM community_extension_receipts WHERE account_id=? AND operation=? AND key=? AND expires_at>?', actor.accountId, operation, key, this.now());
  if (!row) return null; if (row.intent_hash !== digest(canonical(intent))) throw new DomainError(409, 'idempotency_conflict'); return row.effect_id;
 }
 private receipt(actor: AccountContext, operation: string, key: string, intent: unknown, effectId: string): void {
  const now = this.now(); this.write('DELETE FROM community_extension_receipts WHERE account_id=? AND expires_at<=?', actor.accountId, now);
  if (this.count('SELECT count(*) n FROM community_extension_receipts WHERE account_id=?', actor.accountId) >= 2000) throw new DomainError(429, 'community_receipt_capacity');
  this.write('INSERT INTO community_extension_receipts VALUES(?,?,?,?,?,?,?)', actor.accountId, operation, key, digest(canonical(intent)), effectId, now, new Date(Date.parse(now) + 30 * DAY_MS).toISOString());
 }
 capabilities(): CommunityExtensionCapabilities { return { enrollment: !!this.deps.lifecycle, planner: true, batchApplication: !!this.deps.batch, posting: !!(this.deps.textModeration && this.deps.moderation && this.deps.support && this.deps.retention && this.deps.assertRateLimit), moderation: !!this.deps.moderation, contacts: false, age: false, photo: false, aggregates: false }; }
 private enrollmentView(actor: AccountContext, row: Enrollment | undefined): MatchEnrollmentView { return row ? { revision: row.revision, generation: row.generation, state: row.state, assignedGroupId: this.assignedGroupId(actor, row), preferences: row.preferences ? s.boundedJson(row.preferences, s.preferences) : null, queuedAt: row.queued_at, cooldownUntil: row.cooldown_until, missedBatches: row.missed_batches, relaxation: this.ownRelaxation(row) } : { revision: 0, generation: 0, state: 'cancelled', assignedGroupId: null, preferences: null, queuedAt: null, cooldownUntil: null, missedBatches: 0, relaxation: [] }; }
 private assignedGroupId(actor: AccountContext, row: Enrollment): string | null {
  if (row.state !== 'assigned' || row.account_id !== actor.accountId) return null;
  // Role changes advance membership generation too; an old assignment is never repaired by this read.
  const assignment = this.get<{ group_id: string }>(`SELECT a.group_id FROM community_match_assignments a
   JOIN community_groups g ON g.id=a.group_id AND g.state='active'
   JOIN community_members m ON m.group_id=a.group_id AND m.account_id=a.account_id AND m.state='active' AND m.generation=a.member_generation
   WHERE a.enrollment_id=? AND a.enrollment_generation=? AND a.account_id=?`, row.id, row.generation, actor.accountId);
  if (!assignment) return null;
  if (!s.id.safeParse(assignment.group_id).success) throw new DomainError(503, 'community_integrity_unavailable');
  try { this.access(actor, assignment.group_id); }
  catch (error) {
   if (error instanceof DomainError && ((error.status === 404 && error.code === 'community_not_found') ||
    (error.status === 403 && error.code === 'community_adult_eligibility_unavailable'))) return null;
   throw error;
  }
  return assignment.group_id;
 }
 private ownRelaxation(row: Enrollment): ('broader_region' | 'mixed_goals')[] { if (row.state !== 'assigned') return []; const assignment = this.get<{ relaxation: string }>('SELECT relaxation FROM community_match_assignments WHERE enrollment_id=? AND enrollment_generation=?', row.id, row.generation); if (!assignment) return []; const value = this.bounded(assignment.relaxation, 512); if (!Array.isArray(value) || value.length > 2 || value.some(v => !['broader_region', 'mixed_goals'].includes(v))) throw new DomainError(503, 'community_integrity_unavailable'); return value as ('broader_region' | 'mixed_goals')[]; }
 readMatching(actor: AccountContext): MatchEnrollmentView { return this.active(actor, () => this.enrollmentView(actor, this.get<Enrollment>('SELECT * FROM community_match_enrollments WHERE account_id=?', actor.accountId))); }
 enroll(actor: AccountContext, raw: unknown, key: string): MatchEnrollmentView { const input = s.parse(s.enrollment, raw); return this.active(actor, () => {
  this.adult(actor); const old = this.get<Enrollment>('SELECT * FROM community_match_enrollments WHERE account_id=?', actor.accountId);
  if (this.replay(actor, 'enroll', key, input)) return this.enrollmentView(actor, old);
  revision(old?.revision ?? 0, input.expectedRevision); const now = this.now();
  if (old?.cooldown_until && old.cooldown_until > now) throw new DomainError(409, 'community_matching_cooldown');
  if (this.get("SELECT 1 FROM community_members m JOIN community_group_policy p ON p.group_id=m.group_id JOIN community_groups g ON g.id=m.group_id WHERE m.account_id=? AND m.state='active' AND g.state='active'", actor.accountId)) throw new DomainError(409, 'community_already_matched');
  this.checkText('alias', input.preferences.alias, true);
  const id = old?.id ?? randomUUID(); const generation = old?.state === 'queued' ? old.generation : (old?.generation ?? 0) + 1;
  this.write(`INSERT INTO community_match_enrollments VALUES(?,?,?,?,?,?,?,?,?,0) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,state='queued',preferences=excluded.preferences,queued_at=excluded.queued_at,consent_at=excluded.consent_at,missed_batches=0`, id, actor.accountId, (old?.revision ?? 0) + 1, generation, 'queued', JSON.stringify(input.preferences), old?.state === 'queued' ? old.queued_at : now, now, old?.cooldown_until ?? null);
  this.receipt(actor, 'enroll', key, input, id); return this.enrollmentView(actor, this.get<Enrollment>('SELECT * FROM community_match_enrollments WHERE account_id=?', actor.accountId));
 }); }
 cancelEnrollment(actor: AccountContext, raw: unknown, key: string): MatchEnrollmentView { const input = s.parse(s.revisionInput, raw); return this.active(actor, () => {
  const row = this.get<Enrollment>('SELECT * FROM community_match_enrollments WHERE account_id=?', actor.accountId);
  if (this.replay(actor, 'cancel_enrollment', key, input)) return this.enrollmentView(actor, row); revision(row?.revision ?? 0, input.expectedRevision);
  if (row?.state === 'assigned') throw new DomainError(409, 'community_leave_required');
  if (row) this.write("UPDATE community_match_enrollments SET state='cancelled',preferences=NULL,revision=revision+1 WHERE account_id=?", actor.accountId);
  this.receipt(actor, 'cancel_enrollment', key, input, row?.id ?? actor.accountId); return this.enrollmentView(actor, this.get<Enrollment>('SELECT * FROM community_match_enrollments WHERE account_id=?', actor.accountId));
 }); }
 private checkText(purpose: 'alias' | 'profile' | 'post' | 'safety', text: string, mustAllow = false): 'allowed' | 'pending' {
  const port = this.deps.textModeration; if (!port || port.policyVersion !== 'community-v1') throw new DomainError(503, 'community_text_moderation_unavailable');
  const result = port.checkText({ purpose, text, policyVersion: 'community-v1' }); if (result === 'rejected') throw new DomainError(422, 'community_text_rejected');
  if (result === 'unavailable' || (mustAllow && result !== 'allowed')) throw new DomainError(503, 'community_text_moderation_unavailable'); return result === 'allowed' ? 'allowed' : 'pending';
 }
 freezeBatch(rawPolicy: MatchBatchPolicy, intent: MatchIntent, language: string, attemptId: string): { id: string; state: string; inputDigest: string } {
  const authority = this.deps.batch; if (!authority) throw new DomainError(503, 'community_batch_authority_unavailable');
  const policy = s.parse(s.policy, rawPolicy); s.parse(s.id, attemptId); const resolved = sundayPolicy(policy.cutoffLocalDate, policy.runtimeVersion);
  if (canonical(policy) !== canonical(resolved)) throw new DomainError(409, 'community_schedule_conflict');
  return authority.withEnrollmentWrite(() => { this.serialization(); const now = this.now(); if (now < policy.cutoffAt) throw new DomainError(409, 'community_batch_not_frozen');
   const snapshot = s.parse(s.snapshot, authority.snapshot(policy, intent, language)); if (snapshot.intent !== intent || snapshot.language !== language) throw new DomainError(409, 'community_batch_scope_conflict');
   const encoded = canonical(snapshot); if (Buffer.byteLength(encoded) > 524288) throw new DomainError(413, 'community_batch_capacity');
   const id = batchIdentity(policy, intent, language), inputDigest = digest(encoded);
   const prior = this.get<{ input_digest: string; state: string }>('SELECT input_digest,state FROM community_match_runs WHERE id=?', id);
   if (prior) { if (prior.input_digest !== inputDigest) throw new DomainError(409, 'community_batch_input_conflict'); return { id, state: prior.state, inputDigest }; }
   this.write('INSERT INTO community_match_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)', id, policy.policyVersion, policy.batchZone, policy.cutoffLocalDate, intent, language, JSON.stringify(policy), inputDigest, encoded, 'frozen', attemptId, now);
   return { id, state: 'frozen', inputDigest };
  });
 }
 applyBatch(runId: string): { id: string; state: string; groupsCreated: number } {
  const authority = this.deps.batch; if (!authority) throw new DomainError(503, 'community_batch_authority_unavailable');
  if (!/^[a-f0-9]{64}$/.test(runId)) throw new DomainError(422, 'community_invalid_input');
  return authority.withEnrollmentWrite(() => { this.serialization();
   const run = this.get<{ id: string; state: string; policy: string; snapshot: string; input_digest: string }>('SELECT * FROM community_match_runs WHERE id=?', runId); if (!run) missing();
   const policy = s.boundedJson(run.policy, s.policy), snapshot = s.parse(s.snapshot, this.bounded(run.snapshot, 524288));
   if (digest(canonical(snapshot)) !== run.input_digest) throw new DomainError(503, 'community_batch_integrity');
   if (run.state !== 'frozen') return { id: run.id, state: run.state, groupsCreated: this.count('SELECT count(DISTINCT group_id) n FROM community_match_assignments WHERE run_id=?', run.id) };
   const now = this.now(); if (now < policy.runAt) throw new DomainError(409, 'community_batch_not_due');
   if (now > policy.resumeUntil) { this.write("UPDATE community_match_runs SET state='missed',finished_at=? WHERE id=?", now, run.id); for (const c of snapshot.candidates) this.write("UPDATE community_match_enrollments SET missed_batches=missed_batches+1 WHERE id=? AND state='queued' AND revision=?", c.enrollmentId, c.revision); return { id: run.id, state: 'missed', groupsCreated: 0 }; }
   const candidates = snapshot.candidates.filter(c => this.currentCandidate(c));
   if (candidates.some(c => c.preferences.fillExistingGroups) && this.get("SELECT 1 FROM community_seat_reservations r JOIN community_motions m ON m.id=r.motion_id JOIN community_group_policy p ON p.group_id=r.group_id WHERE r.state='available' AND r.expires_at>? AND m.kind='growth' AND p.intent=?", now, snapshot.intent)) { if (!authority.assertRefillsExhausted) throw new DomainError(503, 'community_refill_order_authority_unavailable'); authority.assertRefillsExhausted(runId, candidates); }
   const plan = planCommunityBatch({ ...snapshot, candidates, excludedPairs: [...snapshot.excludedPairs, ...this.blockPairs(candidates)] }, policy);
   if (plan.status !== 'planned') { this.write("UPDATE community_match_runs SET state='pending',finished_at=? WHERE id=?", now, run.id); return { id: run.id, state: 'pending', groupsCreated: 0 }; }
   for (const cohort of plan.cohorts) {
    const people = cohort.enrollmentIds.map(id => candidates.find(c => c.enrollmentId === id)!);
    if (!people.every(c => this.currentCandidate(c))) throw new DomainError(409, 'community_candidate_changed');
    const host = people.find(c => c.enrollmentId === cohort.hostEnrollmentId)!; const groupId = randomUUID();
    this.write("INSERT INTO community_groups VALUES(?,? ,?,'active',1,1,?,NULL)", groupId, 'Accountability and support', host.accountId, now);
    this.write("INSERT INTO community_group_policy VALUES(?,'matched',?,12,1,'community-v1',NULL)", groupId, host.preferences.intent);
    for (const c of people) { this.assignCandidate(c, run.id, groupId, c === host ? 'owner' : 'member', cohort.relaxation[c.enrollmentId] ?? []); }
   }
   for (const id of plan.pendingEnrollmentIds) { const c = candidates.find(c => c.enrollmentId === id); if (c) this.write("UPDATE community_match_enrollments SET missed_batches=missed_batches+1 WHERE id=? AND revision=? AND state='queued'", c.enrollmentId, c.revision); }
   this.write("UPDATE community_match_runs SET state='applied',finished_at=? WHERE id=?", now, run.id); return { id: run.id, state: 'applied', groupsCreated: plan.cohorts.length };
  });
 }
 private serialization(): void { if (!this.deps.db.inTransaction) throw new DomainError(503, 'community_lifecycle_serialization_required'); }
 private currentCandidate(c: BatchCandidate): boolean {
  const row = this.get<Enrollment>("SELECT * FROM community_match_enrollments WHERE id=? AND account_id=? AND state='queued'", c.enrollmentId, c.accountId);
  if (!row || row.revision !== c.revision || row.generation !== c.generation || !row.preferences || canonical(s.boundedJson(row.preferences, s.preferences)) !== canonical(c.preferences) || row.consent_at !== c.consentAt || row.queued_at !== c.queuedAt || (row.cooldown_until && row.cooldown_until > this.now())) return false;
  const current = this.deps.batch!.current(c.accountId);
  if (!current.active || !this.eligible(current.eligibility) || current.exclusionRevision !== c.exclusionRevision || !c.eligible) return false;
  if (this.get("SELECT 1 FROM community_members m JOIN community_group_policy p ON p.group_id=m.group_id JOIN community_groups g ON g.id=m.group_id WHERE m.account_id=? AND m.state='active' AND g.state='active'", c.accountId)) return false;
  return !this.get("SELECT 1 FROM community_safety_notices WHERE account_id=? AND state='active' AND expires_at>?", c.accountId, this.now());
 }
 private blockPairs(candidates: readonly BatchCandidate[]): [string, string][] { const ids = new Set(candidates.map(c => c.accountId)); const rows = this.rows<{ owner_account_id: string; subject_account_id: string }>('SELECT owner_account_id,subject_account_id FROM community_blocks WHERE active=1 LIMIT 125001'); if (rows.length > 125000) throw new DomainError(413, 'community_exclusion_capacity'); return rows.filter(r => ids.has(r.owner_account_id) && ids.has(r.subject_account_id)).map(r => [r.owner_account_id, r.subject_account_id]); }
 private assignCandidate(c: BatchCandidate, runId: string, groupId: string, role: 'owner' | 'member', relaxation: readonly string[]): void {
  const old = this.get<ExtensionMember>('SELECT * FROM community_members WHERE group_id=? AND account_id=?', groupId, c.accountId);
  if (old?.state === 'removed') throw new DomainError(409, 'community_group_restriction');
  this.checkText('alias', c.preferences.alias, true); const generation = (old?.generation ?? 0) + 1, now = this.now();
  this.write(`INSERT INTO community_members VALUES(?,?,?,?,?,'active',?,?,?,NULL) ON CONFLICT(group_id,account_id) DO UPDATE SET member_id=excluded.member_id,alias=excluded.alias,role=excluded.role,state='active',revision=excluded.revision,generation=excluded.generation,joined_at=excluded.joined_at,ended_at=NULL`, groupId, c.accountId, randomUUID(), c.preferences.alias, role, (old?.revision ?? 0) + 1, generation, now);
  this.write('DELETE FROM community_share_settings WHERE group_id=? AND account_id=?', groupId, c.accountId);
  const columns = shareFields.flatMap(f => [f, `${f}_enabled_at`]);
  this.write(`INSERT INTO community_share_settings(group_id,account_id,membership_generation,revision,${columns.join(',')},updated_at) VALUES(?,?,?,1,${columns.map(() => '?').join(',')},?)`, groupId, c.accountId, generation, ...shareFields.flatMap(() => [0, null]), now);
  this.write('DELETE FROM community_profile_shares WHERE group_id=? AND account_id=?', groupId, c.accountId);
  this.write('INSERT INTO community_match_assignments VALUES(?,?,?,?,?,?,?,?,?,?)', randomUUID(), c.enrollmentId, c.generation, c.revision, runId, groupId, c.accountId, generation, JSON.stringify(relaxation), now);
  this.write("UPDATE community_match_enrollments SET state='assigned',revision=revision+1 WHERE id=? AND revision=?", c.enrollmentId, c.revision);
 }
 readPolicy(actor: AccountContext, groupId: string): GroupPolicyView { return this.active(actor, () => { this.access(actor, groupId); const p = this.policy(groupId); return { kind: p.kind, intent: p.intent, capacity: p.capacity, revision: p.revision }; }); }
 private ownProfile(member: ExtensionMember): GroupProfileShare { const row = this.get<{ profile: string; generation: number }>('SELECT profile,generation FROM community_profile_shares WHERE group_id=? AND account_id=?', member.group_id, member.account_id); return row && row.generation === member.generation ? s.boundedJson(row.profile, s.storedProfile) : privateProfile(); }
 readProfile(actor: AccountContext, groupId: string): GroupProfileShare { return this.active(actor, () => this.ownProfile(this.access(actor, groupId, false).member)); }
 updateProfile(actor: AccountContext, groupId: string, raw: unknown, key: string): GroupProfileShare { const input = s.parse(s.profile, raw); return this.active(actor, () => {
  const { member } = this.access(actor, groupId, Object.values(input.flags).some(Boolean)); const intent = { groupId, ...input }; const old = this.ownProfile(member);
  if (this.replay(actor, 'profile', key, intent)) return old; revision(old.revision, input.expectedRevision);
  if (input.flags.sex && input.sexDescription) this.checkText('profile', input.sexDescription, true);
  const value: GroupProfileShare = { revision: old.revision + 1, flags: input.flags, sexDescription: input.flags.sex ? input.sexDescription : null, region: input.flags.region ? input.region : null, avatar: input.flags.avatar ? input.avatar : null };
  this.write('INSERT INTO community_profile_shares VALUES(?,?,?,?,?,?) ON CONFLICT(group_id,account_id) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,profile=excluded.profile,updated_at=excluded.updated_at', groupId, actor.accountId, member.generation, value.revision, JSON.stringify(value), this.now());
  this.receipt(actor, 'profile', key, intent, groupId); return value;
 }); }
 rosterProfiles(actor: AccountContext, groupId: string): { memberId: string; alias: string; profile: ReturnType<typeof profileProjection> }[] { return this.active(actor, () => {
  this.access(actor, groupId); return this.rows<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND state='active' ORDER BY member_id LIMIT 51", groupId).filter(m => !this.blocked(actor.accountId, m.account_id) && (m.account_id === actor.accountId || this.subject(m))).map(m => ({ memberId: m.member_id, alias: m.alias, profile: profileProjection(this.ownProfile(m)) }));
 }); }
 rankings(actor: AccountContext, groupId: string, metric: string): { status: 'unavailable' } { if (!['current_streak', 'month_adherence', 'longest_streak'].includes(metric)) throw new DomainError(422, 'community_invalid_input'); return this.active(actor, () => { this.access(actor, groupId); return { status: 'unavailable' }; }); }
 private postFor(actor: AccountContext, group: Group, viewer: ExtensionMember, postId: string, authorOnly = false): { post: Post; author: ExtensionMember } {
  s.parse(s.id, postId); const post = this.get<Post>('SELECT * FROM community_posts WHERE id=? AND group_id=?', postId, group.id); if (!post || post.group_generation !== group.generation) missing();
  const author = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", group.id, post.author_account_id);
  if (!author || author.generation !== post.membership_generation || (authorOnly && author.account_id !== actor.accountId)) missing();
  if (author.account_id !== actor.accountId && !this.subject(author)) missing();
  if (!postReadable({ state: post.state, expiresAt: post.expires_at, createdAt: post.created_at, now: this.now(), author: actor.accountId === author.account_id, viewerJoinedAt: viewer.joined_at, blocked: this.blocked(actor.accountId, author.account_id) })) missing();
  return { post, author };
 }
 private postView(post: Post, author: ExtensionMember): GroupPostView {
  return { id: post.id, revision: post.revision, kind: post.kind, state: post.state, createdAt: post.created_at, expiresAt: post.expires_at,
   ...(post.text ? { text: post.text } : {}), ...(post.template ? { template: post.template } : {}), memberId: author.member_id, alias: author.alias };
 }
 listPosts(actor: AccountContext, groupId: string): GroupPostView[] { return this.readPostsPage(actor, groupId).posts; }
 readPostsPage(actor: AccountContext, groupId: string, cursorId?: string, limit = 20): { posts: GroupPostView[]; nextCursor: string | null } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new DomainError(422, 'community_invalid_input'); if (cursorId) s.parse(s.id, cursorId);
  return this.active(actor, () => { const { group, member } = this.access(actor, groupId);
   const cursor = cursorId ? this.get<{ before_created_at: string; before_id: string; group_generation: number; membership_generation: number }>('SELECT * FROM community_post_cursors WHERE id=? AND account_id=? AND group_id=? AND expires_at>?', cursorId, actor.accountId, groupId, this.now()) : undefined;
   if (cursorId && (!cursor || cursor.group_generation !== group.generation || cursor.membership_generation !== member.generation)) missing();
   const ids = this.rows<{ id: string; created_at: string }>("SELECT id,created_at FROM community_posts WHERE group_id=? AND expires_at>? AND (state='published' OR author_account_id=?) AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 201", groupId, this.now(), actor.accountId, cursor?.before_created_at ?? '9999', cursor?.before_created_at ?? '9999', cursor?.before_id ?? '');
   const posts: GroupPostView[] = []; let scanned = 0; let last: { id: string; created_at: string } | undefined;
   for (const row of ids.slice(0, 200)) { scanned++; last = row; try { const { post, author } = this.postFor(actor, group, member, row.id); posts.push(this.postView(post, author)); } catch (error) { if (!(error instanceof DomainError && error.status === 404)) throw error; } if (posts.length === limit) break; }
   let nextCursor: string | null = null;
   if (last && scanned < ids.length) { this.write('DELETE FROM community_post_cursors WHERE account_id=? AND expires_at<=?', actor.accountId, this.now());
    if (this.count('SELECT count(*) n FROM community_post_cursors WHERE account_id=?', actor.accountId) >= 100) throw new DomainError(429, 'community_cursor_capacity');
    nextCursor = randomUUID(); this.write('INSERT INTO community_post_cursors VALUES(?,?,?,?,?,?,?,?)', nextCursor, actor.accountId, groupId, group.generation, member.generation, last.created_at, last.id, new Date(Date.parse(this.now()) + 600000).toISOString()); }
   return { posts, nextCursor };
  });
 }
 createPost(actor: AccountContext, groupId: string, raw: unknown, key: string): GroupPostView { const input = s.parse(s.post, raw); return this.active(actor, () => {
  const { group, member } = this.access(actor, groupId); const intent = { groupId, ...input }; const prior = this.replay(actor, 'post', key, intent);
  if (prior) { const { post, author } = this.postFor(actor, group, member, prior, true); return this.postView(post, author); }
  if (!this.capabilities().posting) throw new DomainError(503, 'community_posting_unavailable'); this.limit(actor, 'post');
  if (this.count('SELECT count(*) n FROM community_posts WHERE author_account_id=? AND group_id=? AND created_at>?', actor.accountId, groupId, new Date(Date.parse(this.now()) - DAY_MS).toISOString()) >= 3) throw new DomainError(429, 'community_post_quota');
  const text = input.kind === 'win' ? input.text ?? null : null; if (text) this.checkText('post', text);
  const id = randomUUID(), now = this.now();
  this.write("INSERT INTO community_posts VALUES(?,?,?,?,?,1,?,?,?,'pending','community-v1',?,?)", id, groupId, group.generation, actor.accountId, member.generation, input.kind, input.kind === 'check_in' ? input.template : null, text, now, postExpiry(now, false));
  this.receipt(actor, 'post', key, intent, id); const { post, author } = this.postFor(actor, group, member, id, true); return this.postView(post, author);
 }); }
 hidePost(actor: AccountContext, groupId: string, postId: string, raw: unknown, key: string): { id: string; revision: number; state: 'hidden' } { const input = s.parse(s.revisionInput, raw); return this.active(actor, () => {
  const { group, member } = this.access(actor, groupId, false), intent = { groupId, postId, ...input }; const { post } = this.postFor(actor, group, member, postId, true);
  if (this.replay(actor, 'hide_post', key, intent)) return { id: post.id, revision: post.revision, state: 'hidden' }; revision(post.revision, input.expectedRevision);
  this.write("UPDATE community_posts SET state='hidden',text=NULL,revision=revision+1 WHERE id=?", post.id); this.write('UPDATE community_reactions SET active=0,revision=revision+1 WHERE post_id=?', post.id);
  this.receipt(actor, 'hide_post', key, intent, post.id); return { id: post.id, revision: post.revision + 1, state: 'hidden' };
 }); }
 setReaction(actor: AccountContext, groupId: string, postId: string, raw: unknown, key: string): { active: boolean; revision: number } { const input = s.parse(s.reaction, raw); return this.active(actor, () => {
  const { group, member } = this.access(actor, groupId, input.active); s.parse(s.id, postId); if (input.active) { const { post } = this.postFor(actor, group, member, postId); if (post.state !== 'published') missing(); } else if (!this.get('SELECT 1 FROM community_reactions r JOIN community_posts p ON p.id=r.post_id WHERE r.post_id=? AND r.account_id=? AND p.group_id=? AND r.reaction=?', postId, actor.accountId, groupId, input.reaction)) missing();
  const operation = `reaction:${groupId}`; const intent = { groupId, postId, ...input }; const old = this.get<{ active: number; revision: number; membership_generation: number }>('SELECT * FROM community_reactions WHERE post_id=? AND account_id=? AND reaction=?', postId, actor.accountId, input.reaction);
  const current = old?.membership_generation === member.generation ? old : undefined;
  if (this.replay(actor, operation, key, intent)) return { active: current?.active === 1, revision: current?.revision ?? 0 }; revision(current?.revision ?? 0, input.expectedRevision);
  if (input.active) { this.limit(actor, 'reaction'); const since = new Date(Date.parse(this.now()) - DAY_MS).toISOString();
   if (this.count('SELECT count(*) n FROM community_extension_receipts WHERE account_id=? AND operation=? AND created_at>?', actor.accountId, operation, since) >= 20 || this.get('SELECT 1 FROM community_reactions WHERE account_id=? AND updated_at>?', actor.accountId, new Date(Date.parse(this.now()) - 1000).toISOString())) throw new DomainError(429, 'community_reaction_quota'); }
  const rev = (old?.revision ?? 0) + 1; this.write('INSERT INTO community_reactions VALUES(?,?,?,?,?,?,?) ON CONFLICT(post_id,account_id,reaction) DO UPDATE SET membership_generation=excluded.membership_generation,active=excluded.active,revision=excluded.revision,updated_at=excluded.updated_at', postId, actor.accountId, member.generation, input.reaction, Number(input.active), rev, this.now());
  this.receipt(actor, operation, key, intent, postId); return { active: input.active, revision: rev };
 }); }
 reviewPost(postId: string, expectedRevision: number, decision: 'publish' | 'reject'): { id: string; state: string } {
  const authority = this.deps.moderation; if (!authority || !this.deps.support || !this.deps.retention) throw new DomainError(503, 'community_moderation_unavailable'); s.parse(s.id, postId);
  if (!['publish', 'reject'].includes(decision)) throw new DomainError(422, 'community_invalid_input');
  return authority.withReviewWrite(() => { this.serialization(); const post = this.get<Post>('SELECT * FROM community_posts WHERE id=?', postId); if (!post) missing(); authority.assertReview({ groupId: post.group_id, purpose: 'post', resourceId: post.id });
   revision(post.revision, expectedRevision); const group = this.get<Group>("SELECT * FROM community_groups WHERE id=? AND state='active'", post.group_id), member = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", post.group_id, post.author_account_id);
   if (!group || group.generation !== post.group_generation || !member || member.generation !== post.membership_generation || !this.subject(member) || post.state !== 'pending' || post.expires_at <= this.now()) missing();
   if (decision === 'publish') { if (post.text) this.checkText('post', post.text, true); this.checkText('alias', member.alias, true); }
   const state = decision === 'publish' ? 'published' : 'rejected'; this.write('UPDATE community_posts SET state=?,revision=revision+1,expires_at=? WHERE id=?', state, postExpiry(post.created_at, decision === 'publish'), postId); return { id: postId, state };
  });
 }
 private motionSubjectMemberId(actor: AccountContext, motion: Motion): string | null {
  if (motion.kind !== 'removal') return null;
  const subject = this.get<ExtensionMember>(`SELECT m.* FROM community_members m
   JOIN community_groups g ON g.id=m.group_id AND g.state='active' AND g.generation=?
   JOIN community_members viewer ON viewer.group_id=m.group_id AND viewer.account_id=? AND viewer.state='active'
   WHERE m.group_id=? AND m.account_id=? AND m.generation=? AND m.state='active' AND m.role='member'`,
   motion.group_generation, actor.accountId, motion.group_id, motion.subject_account_id, motion.subject_generation);
  if (!subject || this.blocked(actor.accountId, subject.account_id) || !this.subject(subject)) return null;
  if (!s.id.safeParse(subject.member_id).success) throw new DomainError(503, 'community_integrity_unavailable');
  return subject.member_id;
 }
 private motionPlaces(motion: Motion): number | null {
  if (motion.kind !== 'growth') return null;
  if (!Number.isSafeInteger(motion.places) || motion.places < 1 || motion.places > 4) throw new DomainError(503, 'community_integrity_unavailable');
  return motion.places;
 }
 private motionView(actor: AccountContext, motion: Motion): MotionView { const ballot = this.get<{ choice: 'yes' | 'no' | 'abstain'; revision: number }>('SELECT b.choice,b.revision FROM community_ballots b JOIN community_motion_electorate e ON e.motion_id=b.motion_id AND e.account_id=b.account_id WHERE b.motion_id=? AND b.account_id=? AND e.active=1', motion.id, actor.accountId); return { id: motion.id, kind: motion.kind, places: this.motionPlaces(motion), subjectMemberId: this.motionSubjectMemberId(actor, motion), revision: motion.revision, state: motion.state === 'open' && motion.expires_at <= this.now() ? 'awaiting_finalization' : motion.state, expiresAt: motion.expires_at, electorateSize: motion.electorate_size, requiredYes: motion.required_yes, ownBallot: ballot?.choice ?? null, ballotRevision: ballot?.revision ?? 0 }; }
 listMotions(actor: AccountContext, groupId: string): MotionView[] { return this.active(actor, () => { this.access(actor, groupId); this.policy(groupId); return this.rows<Motion>('SELECT * FROM community_motions WHERE group_id=? ORDER BY created_at DESC LIMIT 50', groupId).filter(m => !m.subject_account_id || !this.blocked(actor.accountId, m.subject_account_id)).map(m => this.motionView(actor, m)); }); }
 createMotion(actor: AccountContext, groupId: string, raw: unknown, key: string): MotionView { const input = s.parse(s.motion, raw); return this.active(actor, () => {
  const { group, member } = this.access(actor, groupId), policy = this.policy(groupId), intent = { groupId, ...input };
  const target = input.kind === 'removal' ? this.target(groupId, input.memberId) : null;
  if (target && (target.account_id === actor.accountId || target.role !== 'member' || this.blocked(actor.accountId, target.account_id) || !this.subject(target))) missing();
  const prior = this.replay(actor, 'motion', key, intent); if (prior) { const row = this.get<Motion>('SELECT * FROM community_motions WHERE id=?', prior); if (!row) missing(); return this.motionView(actor, row); }
  revision(policy.revision, input.expectedRevision); this.limit(actor, 'motion'); const now = this.now(), tenure = new Date(Date.parse(now) - 7 * DAY_MS).toISOString();
  if (!this.deps.accountCreatedAt) throw new DomainError(503, 'community_account_tenure_unavailable');
  if (member.joined_at > tenure || !this.accountOldEnough(member, tenure)) throw new DomainError(403, 'community_motion_tenure_required');
  if (this.count("SELECT count(*) n FROM community_motions WHERE group_id=? AND state='open'", groupId) >= 2 || this.get("SELECT 1 FROM community_motions WHERE sponsor_account_id=? AND (state='open' OR created_at>?)", actor.accountId, tenure)) throw new DomainError(429, 'community_motion_quota');
  if (this.get("SELECT 1 FROM community_motions WHERE group_id=? AND kind=? AND subject_account_id IS ? AND state<>'open' AND coalesce(finalized_at,created_at)>?", groupId, input.kind, target?.account_id ?? null, new Date(Date.parse(now) - 28 * DAY_MS).toISOString())) throw new DomainError(409, 'community_motion_cooldown');
  if (input.kind === 'growth' && (policy.capacity + input.places > 20 || (policy.last_growth_at && policy.last_growth_at > new Date(Date.parse(now) - 28 * DAY_MS).toISOString()))) throw new DomainError(409, 'community_growth_unavailable');
  const electors = this.rows<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND state='active' AND joined_at<=? ORDER BY member_id LIMIT 21", groupId, tenure).filter(m => this.subject(m) && this.accountOldEnough(m, tenure) && (input.kind !== 'friend' || m.account_id !== actor.accountId) && m.account_id !== target?.account_id);
  if (electors.length < 3 || electors.length > 20) throw new DomainError(409, 'community_electorate_unavailable');
  const id = randomUUID(), expires = new Date(Date.parse(now) + 72 * 3600000).toISOString();
  this.write("INSERT INTO community_motions VALUES(?,?,?,?,?,?,?,?,?,1,?,?,'open',?,?,NULL)", id, groupId, group.generation, actor.accountId, member.generation, input.kind, target?.account_id ?? null, target?.generation ?? null, input.kind === 'growth' ? input.places : 1, electors.length, requiredYes(electors.length), now, expires);
  for (const elector of electors) this.write('INSERT INTO community_motion_electorate VALUES(?,?,?,1)', id, elector.account_id, elector.generation);
  this.receipt(actor, 'motion', key, intent, id); return this.motionView(actor, this.get<Motion>('SELECT * FROM community_motions WHERE id=?', id)!);
 }); }
 private accountOldEnough(member: ExtensionMember, at: string): boolean { try { const created = this.deps.accountCreatedAt?.(member.account_id); return typeof created === 'string' && Number.isFinite(Date.parse(created)) && created <= at; } catch { return false; } }
 setBallot(actor: AccountContext, groupId: string, motionId: string, raw: unknown, key: string): MotionView { const input = s.parse(s.ballot, raw); s.parse(s.id, motionId); return this.active(actor, () => {
  const { group, member } = this.access(actor, groupId), motion = this.get<Motion>('SELECT * FROM community_motions WHERE id=? AND group_id=?', motionId, groupId); if (!motion || motion.group_generation !== group.generation) missing();
  const elector = this.get<{ membership_generation: number; active: number }>('SELECT * FROM community_motion_electorate WHERE motion_id=? AND account_id=?', motionId, actor.accountId);
  if (!elector?.active || elector.membership_generation !== member.generation || (motion.subject_account_id && this.blocked(actor.accountId, motion.subject_account_id))) missing();
  const intent = { groupId, motionId, ...input }; if (this.replay(actor, 'ballot', key, intent)) return this.motionView(actor, motion);
  if (motion.state !== 'open' || motion.expires_at <= this.now()) throw new DomainError(409, 'community_motion_expired');
  const prior = this.get<{ revision: number }>('SELECT revision FROM community_ballots WHERE motion_id=? AND account_id=?', motionId, actor.accountId); revision(prior?.revision ?? 0, input.expectedRevision);
  this.write('INSERT INTO community_ballots VALUES(?,?,1,?,?) ON CONFLICT(motion_id,account_id) DO UPDATE SET revision=revision+1,choice=excluded.choice,updated_at=excluded.updated_at', motionId, actor.accountId, input.choice, this.now());
  this.receipt(actor, 'ballot', key, intent, motionId); return this.motionView(actor, motion);
 }); }
 finalizeMotion(actor: AccountContext, groupId: string, motionId: string): MotionView {
  s.parse(s.id, motionId); return this.active(actor, () => this.finalizeMotionInside(actor, groupId, motionId));
 }
 finalizeMotionCommand(actor: AccountContext, groupId: string, motionId: string, raw: unknown, key: string): MotionView {
  s.parse(s.empty, raw); s.parse(s.id, motionId); return this.active(actor, () => {
   const { group } = this.access(actor, groupId), intent = { groupId, motionId };
   const motion = this.get<Motion>('SELECT * FROM community_motions WHERE id=? AND group_id=?', motionId, groupId);
   if (!motion || motion.group_generation !== group.generation) missing();
   if (this.replay(actor, 'finalize_motion', key, intent)) return this.motionView(actor, motion);
   const result = this.finalizeMotionInside(actor, groupId, motionId);
   this.receipt(actor, 'finalize_motion', key, intent, motionId); return result;
  });
 }
 private finalizeMotionInside(actor: AccountContext, groupId: string, motionId: string): MotionView {
  const { group } = this.access(actor, groupId), policy = this.policy(groupId), motion = this.get<Motion>('SELECT * FROM community_motions WHERE id=? AND group_id=?', motionId, groupId); if (!motion || motion.group_generation !== group.generation) missing();
  if (motion.state !== 'open') return this.motionView(actor, motion); const now = this.now(); if (now < motion.expires_at) throw new DomainError(409, 'community_motion_not_due');
  const sponsor = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", groupId, motion.sponsor_account_id);
  const electors = this.rows<{ account_id: string; membership_generation: number; active: number }>('SELECT * FROM community_motion_electorate WHERE motion_id=?', motionId);
  let yes = 0, active = 0;
  for (const elector of electors) { const member = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", groupId, elector.account_id);
   if (!elector.active || !member || member.generation !== elector.membership_generation || !this.subject(member)) { this.write('UPDATE community_motion_electorate SET active=0 WHERE motion_id=? AND account_id=?', motionId, elector.account_id); this.write('DELETE FROM community_ballots WHERE motion_id=? AND account_id=?', motionId, elector.account_id); continue; }
   active++; if (this.get("SELECT 1 FROM community_ballots WHERE motion_id=? AND account_id=? AND choice='yes'", motionId, elector.account_id)) yes++;
  }
  let state: string = motionOutcome(now, motion.expires_at, motion.electorate_size, yes, active);
  if (!sponsor || sponsor.generation !== motion.sponsor_generation || !this.subject(sponsor)) state = 'expired';
  if (state === 'passed' && motion.kind === 'removal') {
   const subject = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", groupId, motion.subject_account_id);
   if (!subject || subject.generation !== motion.subject_generation || subject.role !== 'member') state = 'expired';
   else if (this.deps.moderation) state = 'review_pending';
   else this.endMember(groupId, subject.account_id, true);
  }
  if (state === 'passed' && motion.kind !== 'removal') {
   const members = this.count("SELECT count(*) n FROM community_members WHERE group_id=? AND state='active'", groupId), reserved = this.reservedSeats(groupId);
   let capacity = policy.capacity;
   if (motion.kind === 'growth') { const cooldown = new Date(Date.parse(now) - 28 * DAY_MS).toISOString(); if (policy.last_growth_at && policy.last_growth_at > cooldown) state = 'expired'; else capacity += motion.places; }
   if (state === 'passed') { try { reserveCapacity(capacity, members, reserved, motion.places); } catch (error) { if (!(error instanceof DomainError && error.status === 409)) throw error; state = 'expired'; } }
   if (state === 'passed') { if (motion.kind === 'growth') this.write('UPDATE community_group_policy SET capacity=?,revision=revision+1,last_growth_at=? WHERE group_id=?', capacity, now, groupId);
    this.write("INSERT INTO community_seat_reservations VALUES(?,?,?,?,?,?,?,0,'available',?,NULL,NULL)", randomUUID(), motion.id, groupId, group.generation, motion.sponsor_account_id, motion.sponsor_generation, motion.places, new Date(Date.parse(now) + (motion.kind === 'friend' ? DAY_MS : 7 * DAY_MS)).toISOString()); }
  }
  this.write('UPDATE community_motions SET state=?,revision=revision+1,finalized_at=? WHERE id=?', state, now, motionId); return this.motionView(actor, this.get<Motion>('SELECT * FROM community_motions WHERE id=?', motionId)!);
 }
 listFriendReservations(actor: AccountContext, groupId: string): FriendReservationView[] { return this.active(actor, () => {
  const { group, member } = this.access(actor, groupId); this.policy(groupId);
  return this.rows<Reservation>(`SELECT r.id,r.motion_id,r.state,r.expires_at,r.invitation_id FROM community_seat_reservations r
   JOIN community_motions m ON m.id=r.motion_id AND m.kind='friend' AND m.group_id=r.group_id
    AND m.group_generation=r.group_generation AND m.sponsor_account_id=r.sponsor_account_id AND m.sponsor_generation=r.sponsor_generation
   WHERE r.group_id=? AND r.group_generation=? AND r.sponsor_account_id=? AND r.sponsor_generation=?
   ORDER BY r.expires_at DESC,r.id LIMIT 50`, groupId, group.generation, actor.accountId, member.generation)
   .map(row => ({ id: row.id, motionId: row.motion_id, state: row.state, expiresAt: row.expires_at, invitationId: row.invitation_id }));
 }); }
 readFriendInvitation(actor: AccountContext, groupId: string, reservationId: string): FriendInvitationView {
  s.parse(s.id, reservationId); return this.active(actor, () => {
   const { group, member } = this.access(actor, groupId); this.policy(groupId);
   const row = this.get<{ id: string; revision: number; state: FriendInvitationView['state']; expires_at: string;
    issuer_account_id: string; redeemed_account_id: string | null }>(`SELECT i.id,i.revision,i.state,i.expires_at,i.issuer_account_id,i.redeemed_account_id
    FROM community_seat_reservations r JOIN community_motions m ON m.id=r.motion_id AND m.kind='friend'
     AND m.group_id=r.group_id AND m.group_generation=r.group_generation
     AND m.sponsor_account_id=r.sponsor_account_id AND m.sponsor_generation=r.sponsor_generation
    JOIN community_invitations i ON i.id=r.invitation_id AND i.group_id=r.group_id AND i.group_generation=r.group_generation
     AND i.issuer_account_id=r.sponsor_account_id AND i.issuer_membership_generation=r.sponsor_generation
    WHERE r.id=? AND r.group_id=? AND r.group_generation=? AND r.sponsor_account_id=? AND r.sponsor_generation=?`,
    reservationId, groupId, group.generation, actor.accountId, member.generation);
   if (!row) missing();
   this.assertPairVisible(actor, groupId, row.issuer_account_id);
   if (row.redeemed_account_id) this.assertPairVisible(actor, groupId, row.redeemed_account_id);
   return { id: row.id, revision: row.revision, state: row.state === 'pending' && this.now() >= row.expires_at ? 'expired' : row.state, expiresAt: row.expires_at };
  });
 }
 private reservedSeats(groupId: string): number { return this.get<{ n: number }>("SELECT coalesce(sum(seats-consumed),0) n FROM community_seat_reservations WHERE group_id=? AND state='available' AND expires_at>?", groupId, this.now())!.n; }
 authorizeGroupText(actor: AccountContext, purpose: 'alias' | 'profile', text: string): void { this.serialization(); this.session(actor); s.parse(s.plainText(80), text); this.checkText(purpose, text, true); }
 guardLegacy(actor: AccountContext, groupId: string, action: 'issue_invitation' | 'join' | 'remove' | 'role' | 'reinvite' | 'rename' | 'read', targetAccountId?: string): void {
  this.serialization(); this.session(actor); s.parse(s.id, groupId);
  if (targetAccountId && this.blocked(actor.accountId, targetAccountId)) missing();
  const policy = this.get<Policy>('SELECT * FROM community_group_policy WHERE group_id=?', groupId);
  if (policy && ['issue_invitation', 'remove', 'role', 'reinvite'].includes(action)) throw new DomainError(409, 'community_governed_action_required');
  if (policy && action === 'join') throw new DomainError(409, 'community_reserved_join_required');
  if (action === 'join') { const people = this.rows<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND state='active' LIMIT 51", groupId); if (people.length > 50 || people.some(m => this.blocked(actor.accountId, m.account_id) || !this.subject(m))) missing(); }
  // The parent rename path separately requires currently allowed text before replay.
 }
 assertPairVisible(actor: AccountContext, groupId: string, subjectAccountId: string): void {
  this.serialization(); const { member } = this.access(actor, groupId); const subject = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", groupId, subjectAccountId);
  if (!subject || this.blocked(member.account_id, subject.account_id) || (subject.account_id !== actor.accountId && !this.subject(subject))) missing();
 }
 beforeFriendIssue(actor: AccountContext, groupId: string, reservationId: string): void {
  this.serialization(); const { group, member } = this.access(actor, groupId); s.parse(s.id, reservationId); this.policy(groupId);
  const r = this.get<Reservation>("SELECT * FROM community_seat_reservations WHERE id=? AND group_id=? AND state='available' AND expires_at>?", reservationId, groupId, this.now());
  const motion = r ? this.get<Motion>("SELECT * FROM community_motions WHERE id=? AND kind='friend' AND state='passed'", r.motion_id) : undefined;
  if (!r || !motion || r.group_generation !== group.generation || r.sponsor_account_id !== actor.accountId || r.sponsor_generation !== member.generation || r.invitation_id || r.consumed !== 0) missing();
  reserveCapacity(this.policy(groupId).capacity, this.count("SELECT count(*) n FROM community_members WHERE group_id=? AND state='active'", groupId), this.reservedSeats(groupId) - 1, 1);
 }
 bindFriendInvitation(actor: AccountContext, groupId: string, reservationId: string, invitationId: string): void {
  this.beforeFriendIssue(actor, groupId, reservationId); s.parse(s.id, invitationId);
  const invite = this.get<{ issuer_account_id: string; expires_at: string }>("SELECT * FROM community_invitations WHERE id=? AND group_id=? AND state='pending'", invitationId, groupId);
  const reservation = this.get<Reservation>('SELECT * FROM community_seat_reservations WHERE id=?', reservationId)!;
  if (!invite || invite.issuer_account_id !== actor.accountId) missing();
  this.write('UPDATE community_invitations SET expires_at=? WHERE id=?', invite.expires_at < reservation.expires_at ? invite.expires_at : reservation.expires_at, invitationId);
  this.write('UPDATE community_seat_reservations SET invitation_id=? WHERE id=?', invitationId, reservationId);
 }
 beforeReservedJoin(actor: AccountContext, groupId: string, invitationId: string): void {
  this.serialization(); this.adult(actor); s.parse(s.id, groupId); s.parse(s.id, invitationId); const policy = this.policy(groupId);
  if (!this.deps.assertReservedJoin) throw new DomainError(503, 'community_join_exclusion_authority_unavailable'); this.deps.assertReservedJoin({ actor, groupId, invitationId });
  const r = this.get<Reservation>("SELECT * FROM community_seat_reservations WHERE invitation_id=? AND group_id=? AND state='available' AND expires_at>? AND consumed=0", invitationId, groupId, this.now());
  const group = this.get<Group>("SELECT * FROM community_groups WHERE id=? AND state='active'", groupId); if (!r || !group || r.group_generation !== group.generation || r.sponsor_account_id === actor.accountId) missing();
  const sponsor = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", groupId, r.sponsor_account_id);
  if (!sponsor || sponsor.generation !== r.sponsor_generation || !this.subject(sponsor)) missing();
  if (this.get("SELECT 1 FROM community_members m JOIN community_group_policy p ON p.group_id=m.group_id JOIN community_groups g ON g.id=m.group_id WHERE m.account_id=? AND m.state='active' AND g.state='active'", actor.accountId)) throw new DomainError(409, 'community_already_matched');
  const members = this.rows<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND state='active' LIMIT 21", groupId);
  if (members.some(m => this.blocked(actor.accountId, m.account_id) || !this.subject(m))) missing();
  if (this.get("SELECT 1 FROM community_members WHERE group_id=? AND account_id=? AND state='removed'", groupId, actor.accountId) || this.get("SELECT 1 FROM community_safety_notices WHERE account_id=? AND group_id=? AND state='active' AND expires_at>?", actor.accountId, groupId, this.now())) missing();
  const enrollment = this.get<Enrollment>('SELECT * FROM community_match_enrollments WHERE account_id=?', actor.accountId); if (enrollment?.cooldown_until && enrollment.cooldown_until > this.now()) throw new DomainError(409, 'community_matching_cooldown');
  reserveCapacity(policy.capacity, members.length, this.reservedSeats(groupId) - 1, 1);
 }
 consumeReservedJoin(actor: AccountContext, groupId: string, invitationId: string): void {
  this.serialization(); this.session(actor); const member = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", groupId, actor.accountId); if (!member) missing();
  const changed = this.write("UPDATE community_seat_reservations SET consumed=1,state='consumed' WHERE invitation_id=? AND group_id=? AND state='available' AND consumed=0 AND expires_at>?", invitationId, groupId, this.now());
  if (changed.changes !== 1) throw new DomainError(409, 'community_reservation_consumed');
  this.write("UPDATE community_match_enrollments SET state='cancelled',preferences=NULL,revision=revision+1 WHERE account_id=? AND state='queued'", actor.accountId);
  this.write('DELETE FROM community_profile_shares WHERE group_id=? AND account_id=?', groupId, actor.accountId);
 }
 applyRefill(runId: string, reservationId: string, enrollmentIds: readonly string[]): { assigned: number } {
  const authority = this.deps.batch; if (!authority) throw new DomainError(503, 'community_batch_authority_unavailable'); s.parse(s.id, reservationId);
  if (enrollmentIds.length < 1 || enrollmentIds.length > 4 || new Set(enrollmentIds).size !== enrollmentIds.length) throw new DomainError(422, 'community_invalid_input');
  return authority.withEnrollmentWrite(() => { this.serialization(); const r = this.get<Reservation>("SELECT * FROM community_seat_reservations WHERE id=? AND state='available' AND expires_at>? AND invitation_id IS NULL", reservationId, this.now()); if (!r) missing();
   const motion = this.get<Motion>("SELECT * FROM community_motions WHERE id=? AND kind='growth' AND state='passed'", r.motion_id); if (!motion) missing();
   if (this.get("SELECT 1 FROM community_seat_reservations r JOIN community_motions m ON m.id=r.motion_id WHERE r.state='available' AND r.expires_at>? AND m.kind='growth' AND m.created_at<?", this.now(), motion.created_at)) throw new DomainError(409, 'community_older_reservation_first');
   const run = this.get<{ snapshot: string; policy: string; state: string }>("SELECT * FROM community_match_runs WHERE id=? AND state='frozen'", runId); if (!run) missing();
   const policy = s.boundedJson(run.policy, s.policy); if (this.now() < policy.runAt || this.now() > policy.resumeUntil) throw new DomainError(409, 'community_batch_not_due');
   const snapshot = s.parse(s.snapshot, this.bounded(run.snapshot, 524288)); if (!snapshot.exclusionsKnown) throw new DomainError(503, 'community_exclusions_unavailable');
   const candidates = enrollmentIds.map(id => snapshot.candidates.find(c => c.enrollmentId === id));
   if (candidates.some(c => !c || !c.preferences.fillExistingGroups || c.consentAt >= policy.cutoffAt || c.queuedAt >= policy.cutoffAt || !this.currentCandidate(c))) throw new DomainError(409, 'community_candidate_changed');
   const people = candidates as BatchCandidate[]; const groupPolicy = this.policy(r.group_id), group = this.get<Group>("SELECT * FROM community_groups WHERE id=? AND state='active'", r.group_id);
   if (!group || group.generation !== r.group_generation || people.some(c => c.preferences.intent !== groupPolicy.intent || c.preferences.language !== snapshot.language)) missing();
   const members = this.rows<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND state='active' LIMIT 21", r.group_id);
   const sponsor = members.find(m => m.account_id === r.sponsor_account_id); if (!sponsor || sponsor.generation !== r.sponsor_generation) missing();
   const memberPrefs = members.map(m => { const row = this.get<Enrollment>('SELECT * FROM community_match_enrollments WHERE account_id=?', m.account_id); if (!row?.preferences) throw new DomainError(503, 'community_member_exclusions_unavailable'); return { member: m, preferences: s.boundedJson(row.preferences, s.preferences) }; });
   const excluded = new Set(snapshot.excludedPairs.flatMap(([a, b]) => [`${a}:${b}`, `${b}:${a}`]));
   for (const c of people) { for (const other of people.filter(p => p !== c)) if (excluded.has(`${c.accountId}:${other.accountId}`) || this.blocked(c.accountId, other.accountId) || pairRelaxations(c.preferences, other.preferences) === null || pairRelaxations(other.preferences, c.preferences) === null) throw new DomainError(409, 'community_hard_exclusion');
    for (const { member, preferences } of memberPrefs) if (!this.subject(member) || excluded.has(`${c.accountId}:${member.account_id}`) || this.blocked(c.accountId, member.account_id) || pairRelaxations(c.preferences, preferences) === null || pairRelaxations(preferences, c.preferences) === null) throw new DomainError(409, 'community_hard_exclusion'); }
   if (people.length > r.seats - r.consumed) throw new DomainError(409, 'community_reservation_consumed'); reserveCapacity(groupPolicy.capacity, members.length, this.reservedSeats(r.group_id) - (r.seats - r.consumed), people.length);
   for (const c of people) this.assignCandidate(c, runId, r.group_id, 'member', []);
   this.write("UPDATE community_seat_reservations SET consumed=consumed+?,state=CASE WHEN consumed+?=seats THEN 'consumed' ELSE 'available' END,run_id=? WHERE id=?", people.length, people.length, runId, r.id); return { assigned: people.length };
  });
 }
 blockMember(actor: AccountContext, groupId: string, memberId: string, raw: unknown, key: string): { id: string; revision: number; active: boolean } { s.parse(s.empty, raw); return this.active(actor, () => {
  this.access(actor, groupId, false); const target = this.target(groupId, memberId); if (target.account_id === actor.accountId) throw new DomainError(422, 'community_invalid_input');
  const intent = { groupId, memberId }; const old = this.get<{ id: string; revision: number; active: number }>('SELECT * FROM community_blocks WHERE owner_account_id=? AND subject_account_id=?', actor.accountId, target.account_id);
  if (this.replay(actor, 'block', key, intent) && old) return { id: old.id, revision: old.revision, active: old.active === 1 };
  if (this.count('SELECT count(*) n FROM community_blocks WHERE owner_account_id=?', actor.accountId) >= 500 && !old) throw new DomainError(413, 'community_block_capacity');
  const id = old?.id ?? randomUUID(), rev = (old?.revision ?? 0) + 1;
  this.write('INSERT INTO community_blocks VALUES(?,?,?, ?,1,?) ON CONFLICT(owner_account_id,subject_account_id) DO UPDATE SET active=1,revision=revision+1', id, actor.accountId, target.account_id, rev, this.now());
  for (const person of [actor.accountId, target.account_id]) this.write("UPDATE community_invitations SET state='revoked',revision=revision+1 WHERE group_id=? AND issuer_account_id=? AND state='pending'", groupId, person);
  this.write("UPDATE community_seat_reservations SET state='cancelled' WHERE group_id=? AND sponsor_account_id IN(?,?) AND state='available'", groupId, actor.accountId, target.account_id);
  this.write("UPDATE community_motions SET state='cancelled',revision=revision+1,finalized_at=? WHERE group_id=? AND state='open' AND subject_account_id IN(?,?)", this.now(), groupId, actor.accountId, target.account_id);
  this.write('UPDATE community_reactions SET active=0,revision=revision+1 WHERE (account_id=? AND post_id IN(SELECT id FROM community_posts WHERE author_account_id=?)) OR (account_id=? AND post_id IN(SELECT id FROM community_posts WHERE author_account_id=?))', actor.accountId, target.account_id, target.account_id, actor.accountId);
  this.receipt(actor, 'block', key, intent, id); return { id, revision: rev, active: true };
 }); }
 listBlocks(actor: AccountContext): { id: string; revision: number; active: boolean }[] { return this.active(actor, () => this.rows<{ id: string; revision: number; active: number }>('SELECT id,revision,active FROM community_blocks WHERE owner_account_id=? ORDER BY created_at DESC LIMIT 500', actor.accountId).map(r => ({ id: r.id, revision: r.revision, active: r.active === 1 }))); }
 unblock(actor: AccountContext, blockId: string, raw: unknown, key: string): { id: string; revision: number; active: boolean } { s.parse(s.id, blockId); const input = s.parse(s.revisionInput, raw); return this.active(actor, () => {
  const block = this.get<{ id: string; revision: number; subject_account_id: string; active: number }>('SELECT * FROM community_blocks WHERE id=? AND owner_account_id=?', blockId, actor.accountId); if (!block) missing(); const intent = { blockId, ...input };
  if (this.replay(actor, 'unblock', key, intent)) return { id: blockId, revision: block.revision, active: block.active === 1 }; revision(block.revision, input.expectedRevision);
  const groups = this.rows<{ group_id: string }>('SELECT a.group_id FROM community_members a JOIN community_members b ON b.group_id=a.group_id WHERE a.account_id=? AND b.account_id=?', actor.accountId, block.subject_account_id);
  for (const group of groups) for (const accountId of [actor.accountId, block.subject_account_id]) {
   this.write('DELETE FROM community_profile_shares WHERE group_id=? AND account_id=?', group.group_id, accountId);
   this.write(`UPDATE community_share_settings SET ${shareFields.flatMap(f => [`${f}=0`, `${f}_enabled_at=NULL`]).join(',')},revision=revision+1 WHERE group_id=? AND account_id=?`, group.group_id, accountId);
   this.write("UPDATE community_posts SET state='hidden',text=NULL,revision=revision+1 WHERE group_id=? AND author_account_id=?", group.group_id, accountId);
  }
  this.write('UPDATE community_blocks SET active=0,revision=revision+1 WHERE id=?', blockId); this.receipt(actor, 'unblock', key, intent, blockId); return { id: blockId, revision: block.revision + 1, active: false };
 }); }
 createSafetyReference(actor: AccountContext, groupId: string, raw: unknown, key: string): SafetyReferenceView {
  const input = s.parse(s.safetyReference, raw); s.parse(s.keySchema, key);
  return this.safetyReference(actor, groupId, input.kind, input.resourceId, key);
 }
 safetyReference(actor: AccountContext, groupId: string, kind: 'member' | 'post', resourceId: string, key?: string): SafetyReferenceView {
  s.parse(s.id, groupId); s.parse(s.safetyReference, { kind, resourceId }); if (key !== undefined) s.parse(s.keySchema, key);
  return this.active(actor, () => {
   const { group, member } = this.access(actor, groupId);
   let target: { accountId: string; memberId: string; generation: number; revision: number };
   if (kind === 'member') {
    const subject = this.target(groupId, resourceId); if (this.blocked(actor.accountId, subject.account_id) || !this.subject(subject)) missing();
    target = { accountId: subject.account_id, memberId: subject.member_id, generation: subject.generation, revision: subject.revision };
   } else {
    const { post, author } = this.postFor(actor, group, member, resourceId);
    target = { accountId: author.account_id, memberId: author.member_id, generation: author.generation, revision: post.revision };
   }
   const intent = { accountId: actor.accountId, epoch: actor.epoch, groupId, groupGeneration: group.generation,
    memberId: member.member_id, memberGeneration: member.generation, kind, resourceId, target };
   const now = this.now();
   if (key !== undefined) {
    const prior = this.replay(actor, 'safety_reference', key, intent);
    if (prior) {
     const reference = this.get<{ id: string; expires_at: string }>('SELECT id,expires_at FROM community_safety_references WHERE id=? AND account_id=? AND group_id=? AND resource_kind=? AND resource_id=?', prior, actor.accountId, groupId, kind, resourceId);
     if (!reference || reference.expires_at <= now) missing();
     return { id: reference.id, expiresAt: reference.expires_at };
    }
   }
   this.write('DELETE FROM community_safety_references WHERE account_id=? AND expires_at<=? AND id NOT IN(SELECT safety_reference FROM community_reports WHERE safety_reference IS NOT NULL)', actor.accountId, now);
   if (this.count('SELECT count(*) n FROM community_safety_references WHERE account_id=?', actor.accountId) >= 200) throw new DomainError(429, 'community_reference_capacity');
   const id = randomUUID(), expiresAt = new Date(Date.parse(now) + 180 * DAY_MS).toISOString();
   this.write('INSERT INTO community_safety_references VALUES(?,?,?,?,?,?,?)', id, actor.accountId, groupId, kind, resourceId, now, expiresAt);
   if (key !== undefined) this.receipt(actor, 'safety_reference', key, intent, id);
   return { id, expiresAt };
  });
 }
 private caseView(row: Case): SafetyCaseView { return { id: row.id, revision: row.revision, state: row.state, createdAt: row.created_at, expiresAt: row.expires_at, support: this.deps.support ? 'pending' : 'unavailable' }; }
 report(actor: AccountContext, raw: unknown, key: string): SafetyCaseView { const input = s.parse(s.report, raw); return this.active(actor, () => {
  if (input.safetyReference && !this.get('SELECT 1 FROM community_safety_references WHERE id=? AND account_id=? AND expires_at>?', input.safetyReference, actor.accountId, this.now())) missing();
  const prior = this.replay(actor, 'report', key, input); if (prior) { const row = this.get<Case>('SELECT * FROM community_reports WHERE id=? AND account_id=?', prior, actor.accountId); if (!row) missing(); return this.caseView(row); }
  const duplicate = input.safetyReference ? this.get<Case>("SELECT * FROM community_reports WHERE account_id=? AND safety_reference=? AND category=? AND state='pending' AND expires_at>?", actor.accountId, input.safetyReference, input.category, this.now()) : undefined;
  if (duplicate) { this.receipt(actor, 'report', key, input, duplicate.id); return this.caseView(duplicate); }
  this.limit(actor, 'report'); if (this.count('SELECT count(*) n FROM community_reports WHERE account_id=? AND created_at>?', actor.accountId, new Date(Date.parse(this.now()) - DAY_MS).toISOString()) >= 10) throw new DomainError(429, 'community_report_quota', 'community_report_quota', { support: this.deps.support ? 'pending' : 'unavailable' });
  const id = randomUUID(), now = this.now(); this.write("INSERT INTO community_reports VALUES(?,?,?,?,?,'pending',1,?,?)", id, actor.accountId, input.safetyReference ?? null, input.category, input.text, now, new Date(Date.parse(now) + 180 * DAY_MS).toISOString());
  this.receipt(actor, 'report', key, input, id); return this.caseView(this.get<Case>('SELECT * FROM community_reports WHERE id=?', id)!);
 }); }
 listReports(actor: AccountContext): SafetyCaseView[] { return this.active(actor, () => this.rows<Case>('SELECT id,account_id,revision,state,created_at,expires_at FROM community_reports WHERE account_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 200', actor.accountId, this.now()).map(r => this.caseView(r))); }
 listNotices(actor: AccountContext): (SafetyCaseView & { reason: string; rule: string; appealUntil: string })[] { return this.active(actor, () => this.rows<Case & { reason: string; rule: string; appeal_until: string }>('SELECT * FROM community_safety_notices WHERE account_id=? AND appeal_until>? ORDER BY created_at DESC LIMIT 200', actor.accountId, this.now()).map(r => ({ ...this.caseView(r), reason: r.reason, rule: r.rule, appealUntil: r.appeal_until }))); }
 appeal(actor: AccountContext, noticeId: string, raw: unknown, key: string): SafetyCaseView { const input = s.parse(s.appeal, raw); s.parse(s.id, noticeId); return this.active(actor, () => {
  const notice = this.get<{ revision: number; appeal_until: string }>('SELECT * FROM community_safety_notices WHERE id=? AND account_id=?', noticeId, actor.accountId); if (!notice) missing(); const intent = { noticeId, ...input };
  const prior = this.replay(actor, 'appeal', key, intent); if (prior) { const row = this.get<Case>('SELECT * FROM community_appeals WHERE id=? AND account_id=?', prior, actor.accountId); if (!row) missing(); return this.caseView(row); }
  revision(notice.revision, input.expectedRevision); if (notice.appeal_until <= this.now()) throw new DomainError(409, 'community_appeal_expired');
  const old = this.get<Case>('SELECT * FROM community_appeals WHERE account_id=? AND notice_id=?', actor.accountId, noticeId); if (old) throw new DomainError(409, 'community_appeal_exists');
  const id = randomUUID(); this.write("INSERT INTO community_appeals VALUES(?,?,?,?,1,'pending',?,?)", id, actor.accountId, noticeId, input.text, this.now(), notice.appeal_until); this.receipt(actor, 'appeal', key, intent, id); return this.caseView(this.get<Case>('SELECT * FROM community_appeals WHERE id=?', id)!);
 }); }
 listAppeals(actor: AccountContext): SafetyCaseView[] { return this.active(actor, () => this.rows<Case>('SELECT * FROM community_appeals WHERE account_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 200', actor.accountId, this.now()).map(r => this.caseView(r))); }
 reviewRemoval(motionId: string, expectedRevision: number, evidence: { rule: string; reason: string; restrictionExpiresAt: string; reviewBinding: string }): { noticeId: string } {
  const authority = this.deps.moderation; if (!authority || !this.deps.support || !this.deps.retention) throw new DomainError(503, 'community_moderation_unavailable'); s.parse(s.id, motionId); s.parse(s.plainText(100), evidence.rule); s.parse(s.plainText(500), evidence.reason); s.parse(s.keySchema, evidence.reviewBinding);
  if (!Number.isFinite(Date.parse(evidence.restrictionExpiresAt)) || evidence.restrictionExpiresAt <= this.now() || Date.parse(evidence.restrictionExpiresAt) > Date.parse(this.now()) + 30 * DAY_MS) throw new DomainError(422, 'community_invalid_input');
  return authority.withReviewWrite(() => { this.serialization(); const motion = this.get<Motion>("SELECT * FROM community_motions WHERE id=? AND state='review_pending' AND kind='removal'", motionId); if (!motion) missing(); authority.assertReview({ groupId: motion.group_id, purpose: 'removal', resourceId: motion.id }); revision(motion.revision, expectedRevision);
   const currentGroup = this.get<Group>("SELECT * FROM community_groups WHERE id=? AND state='active'", motion.group_id); if (!currentGroup || currentGroup.generation !== motion.group_generation) missing(); const subject = this.get<ExtensionMember>("SELECT * FROM community_members WHERE group_id=? AND account_id=? AND state='active'", motion.group_id, motion.subject_account_id); if (!subject || subject.generation !== motion.subject_generation || subject.role !== 'member') missing();
   this.endMember(subject.group_id, subject.account_id, true); const noticeId = randomUUID(), now = this.now(); this.write("INSERT INTO community_safety_notices VALUES(?,?,?,?,?,1,'active',?,?,?,?)", noticeId, subject.account_id, subject.group_id, evidence.reason, evidence.rule, now, evidence.restrictionExpiresAt, new Date(Date.parse(now) + 30 * DAY_MS).toISOString(), evidence.reviewBinding);
   this.write("UPDATE community_motions SET state='passed',revision=revision+1 WHERE id=?", motion.id); return { noticeId };
  });
 }
 afterMemberEnds(groupId: string, accountId: string): void { this.serialization(); this.endMember(groupId, accountId, false); }
 private endMember(groupId: string, accountId: string, remove: boolean): void {
  const now = this.now();
  if (remove) {
   const group = this.get<{ display_name: string }>("SELECT display_name FROM community_groups WHERE id=? AND state='active'", groupId);
   if (!group) missing();
   const changed = this.write("UPDATE community_members SET state='removed',alias='',revision=revision+1,ended_at=? WHERE group_id=? AND account_id=? AND state='active'", now, groupId, accountId);
   if (changed.changes === 1) captureRemovalSnapshot(this.deps.db, groupId, accountId, group.display_name, now);
  }
  this.write('DELETE FROM community_profile_shares WHERE group_id=? AND account_id=?', groupId, accountId); this.write('DELETE FROM community_post_cursors WHERE group_id=? AND account_id=?', groupId, accountId);
  this.write(`UPDATE community_share_settings SET ${shareFields.flatMap(f => [`${f}=0`, `${f}_enabled_at=NULL`]).join(',')},revision=revision+1 WHERE group_id=? AND account_id=?`, groupId, accountId);
  this.write("UPDATE community_posts SET state='hidden',text=NULL,revision=revision+1 WHERE group_id=? AND author_account_id=?", groupId, accountId);
  this.write('UPDATE community_reactions SET active=0,revision=revision+1 WHERE account_id=? AND post_id IN(SELECT id FROM community_posts WHERE group_id=?)', accountId, groupId);
  this.write('UPDATE community_motion_electorate SET active=0 WHERE account_id=? AND motion_id IN(SELECT id FROM community_motions WHERE group_id=?)', accountId, groupId);
  this.write('DELETE FROM community_ballots WHERE account_id=? AND motion_id IN(SELECT id FROM community_motions WHERE group_id=?)', accountId, groupId);
  this.write("UPDATE community_motions SET state='cancelled',revision=revision+1,finalized_at=? WHERE group_id=? AND sponsor_account_id=? AND state='open'", now, groupId, accountId);
  this.write("UPDATE community_invitations SET state='revoked',revision=revision+1 WHERE group_id=? AND issuer_account_id=? AND state='pending'", groupId, accountId);
  this.write("UPDATE community_seat_reservations SET state='cancelled' WHERE group_id=? AND sponsor_account_id=? AND state='available'", groupId, accountId);
  if (this.get('SELECT 1 FROM community_group_policy WHERE group_id=?', groupId)) this.write("UPDATE community_match_enrollments SET state='cancelled',preferences=NULL,revision=revision+1,cooldown_until=? WHERE account_id=?", new Date(Date.parse(now) + DAY_MS).toISOString(), accountId);
 }
 afterGroupCloses(groupId: string): void { this.serialization();
  this.write("UPDATE community_posts SET state='hidden',text=NULL,revision=revision+1 WHERE group_id=?", groupId);
  this.write('UPDATE community_reactions SET active=0,revision=revision+1 WHERE post_id IN(SELECT id FROM community_posts WHERE group_id=?)', groupId);
  this.write("UPDATE community_motions SET state='cancelled',revision=revision+1,finalized_at=? WHERE group_id=? AND state IN('open','review_pending')", this.now(), groupId);
  this.write("UPDATE community_seat_reservations SET state='cancelled' WHERE group_id=? AND state='available'", groupId); this.write('DELETE FROM community_profile_shares WHERE group_id=?', groupId); this.write('DELETE FROM community_post_cursors WHERE group_id=?', groupId);
 }
 reviewAppeal(appealId: string, expectedRevision: number, reviewBinding: string, decision: 'upheld' | 'overturned'): { id: string; state: string } {
  const authority = this.deps.moderation; if (!authority?.assertAppealReview || !this.deps.support || !this.deps.retention) throw new DomainError(503, 'community_appeal_review_unavailable');
  s.parse(s.id, appealId); s.parse(s.keySchema, reviewBinding); if (!['upheld', 'overturned'].includes(decision)) throw new DomainError(422, 'community_invalid_input');
  return authority.withReviewWrite(() => { this.serialization(); const appeal = this.get<Case & { notice_id: string }>("SELECT * FROM community_appeals WHERE id=? AND state='pending'", appealId); if (!appeal) missing();
   const notice = this.get<{ id: string; review_binding: string }>('SELECT * FROM community_safety_notices WHERE id=? AND account_id=?', appeal.notice_id, appeal.account_id); if (!notice || notice.review_binding === reviewBinding) throw new DomainError(403, 'community_independent_review_required');
   authority.assertAppealReview!({ noticeId: notice.id, appealId, initialReviewBinding: notice.review_binding, reviewBinding }); revision(appeal.revision, expectedRevision);
   if (appeal.expires_at <= this.now()) throw new DomainError(409, 'community_appeal_expired');
   this.write('UPDATE community_appeals SET state=?,revision=revision+1 WHERE id=?', decision, appealId);
   if (decision === 'overturned') this.write("UPDATE community_safety_notices SET state='expired',revision=revision+1 WHERE id=?", notice.id);
   return { id: appealId, state: decision };
  });
 }
 private readonly accountQueries = {
  enrollment: 'SELECT * FROM community_match_enrollments WHERE account_id=?',
  assignments: 'SELECT id,enrollment_generation,consent_revision,group_id,member_generation,relaxation,created_at FROM community_match_assignments WHERE account_id=?',
  profiles: 'SELECT group_id,generation,revision,profile FROM community_profile_shares WHERE account_id=?',
  blocks: 'SELECT id,revision,active,created_at FROM community_blocks WHERE owner_account_id=?',
  motions: 'SELECT id,kind,revision,state,created_at,expires_at FROM community_motions WHERE sponsor_account_id=?',
  electorate: 'SELECT motion_id,membership_generation,active FROM community_motion_electorate WHERE account_id=?',
  ballots: 'SELECT motion_id,revision,choice,updated_at FROM community_ballots WHERE account_id=?',
  reservations: 'SELECT id,motion_id,seats,consumed,state,expires_at FROM community_seat_reservations WHERE sponsor_account_id=?',
  posts: 'SELECT id,group_id,membership_generation,revision,kind,template,text,state,created_at,expires_at FROM community_posts WHERE author_account_id=?',
  reactions: 'SELECT post_id,reaction,active,revision,updated_at FROM community_reactions WHERE account_id=?',
  references: 'SELECT id,created_at,expires_at FROM community_safety_references WHERE account_id=?',
  reports: 'SELECT id,category,state,revision,created_at,expires_at FROM community_reports WHERE account_id=?',
  notices: 'SELECT id,reason,rule,revision,state,created_at,expires_at,appeal_until FROM community_safety_notices WHERE account_id=?',
  appeals: 'SELECT id,notice_id,revision,state,created_at,expires_at FROM community_appeals WHERE account_id=?',
  receipts: 'SELECT operation,effect_id,created_at,expires_at FROM community_extension_receipts WHERE account_id=?',
  cursors: 'SELECT id,expires_at FROM community_post_cursors WHERE account_id=?',
 } as const;
 private exportRows(sql: string, accountId: string): Record<string, unknown>[] {
  const table = /FROM (community_[a-z_]+)/.exec(sql)?.[1]; if (!table) throw new DomainError(503, 'community_export_query_invalid');
  const ownerColumn = table === 'community_blocks' ? 'owner_account_id' : table === 'community_motions' || table === 'community_seat_reservations' ? 'sponsor_account_id' : table === 'community_posts' ? 'author_account_id' : 'account_id';
  const bound = this.get<{ n: number; bytes: number }>(`SELECT count(*) n,coalesce(sum(length(CAST(${table === 'community_posts' ? "coalesce(text,'')" : table === 'community_profile_shares' ? 'profile' : table === 'community_match_enrollments' ? "coalesce(preferences,'')" : "''"} AS BLOB))),0) bytes FROM ${table} WHERE ${ownerColumn}=?`, accountId)!;
  if (bound.n > 2000 || bound.bytes > 1048576) throw new DomainError(413, 'community_export_capacity');
  return this.rows<Record<string, unknown>>(`${sql} LIMIT 2001`, accountId);
 }
 inventoryAccount(actor: AccountContext): Record<string, number> { this.serialization(); this.session(actor);
  const result: Record<string, number> = {}; for (const [name, sql] of Object.entries(this.accountQueries)) result[name] = this.count(`SELECT count(*) n FROM (${sql})`, actor.accountId);
  result.runs = this.count('SELECT count(*) n FROM community_match_runs WHERE instr(snapshot,?)>0', actor.accountId); result.groupPolicies = this.count('SELECT count(*) n FROM community_group_policy p JOIN community_groups g ON g.id=p.group_id WHERE g.owner_account_id=?', actor.accountId); return result;
 }
 exportBounds(actor: AccountContext): CommunityExportBounds {
  this.serialization(); this.session(actor);
  return addCommunityExportBounds([
      { rows: 0, bytes: 2048 },
   ...Object.values(this.accountQueries).map(sql => estimateCommunityRows(this.deps.db, sql, [actor.accountId])),
   estimateCommunityRows(this.deps.db, 'SELECT id,state,policy,snapshot FROM community_match_runs WHERE instr(snapshot,?)>0', [actor.accountId]),
   estimateCommunityRows(this.deps.db, 'SELECT p.group_id,p.kind,p.intent,p.capacity,p.revision FROM community_group_policy p JOIN community_groups g ON g.id=p.group_id WHERE g.owner_account_id=?', [actor.accountId]),
  ]);
 }
 exportAccount(actor: AccountContext, append: ExportSnapshot['append']): number { this.serialization(); this.session(actor); assertCommunityExportBounds(this.exportBounds(actor));
  const sections: Record<string, unknown> = {}; let count = 0, size = 0;
  for (const [name, sql] of Object.entries(this.accountQueries)) {
   const rows = this.exportRows(sql, actor.accountId); for (const row of rows) {
    if (typeof row.preferences === 'string') row.preferences = s.boundedJson(row.preferences, s.preferences);
    if (typeof row.profile === 'string') row.profile = s.boundedJson(row.profile, s.storedProfile);
    if (typeof row.relaxation === 'string') { const v = this.bounded(row.relaxation, 512); if (!Array.isArray(v) || v.length > 2 || v.some(x => !['broader_region', 'mixed_goals'].includes(x))) throw new DomainError(503, 'community_integrity_unavailable'); row.relaxation = v; }
    if (name === 'posts' && typeof row.expires_at === 'string' && row.expires_at <= this.now()) delete row.text;
   }
   size += Buffer.byteLength(JSON.stringify(rows)); if (size > 2097152) throw new DomainError(413, 'community_export_capacity'); count += rows.length; sections[name] = rows;
  }
  const runBounds = this.get<{ n: number; bytes: number }>('SELECT count(*) n,coalesce(sum(length(CAST(snapshot AS BLOB))),0) bytes FROM community_match_runs WHERE instr(snapshot,?)>0', actor.accountId)!;
  if (runBounds.n > 200 || runBounds.bytes > 2097152 - size) throw new DomainError(413, 'community_export_capacity');
  const runs = this.rows<{ id: string; state: string; policy: string; snapshot: string }>('SELECT id,state,policy,snapshot FROM community_match_runs WHERE instr(snapshot,?)>0 LIMIT 201', actor.accountId);
  sections.runs = runs.flatMap(run => { const snapshot = s.parse(s.snapshot, this.bounded(run.snapshot, 524288)); const ownRevisions = snapshot.candidates.filter(c => c.accountId === actor.accountId).map(c => ({ revision: c.revision, generation: c.generation })); return ownRevisions.length ? [{ id: run.id, state: run.state, policy: s.boundedJson(run.policy, s.policy), ownRevisions }] : []; });
  const policies = this.rows<Record<string, unknown>>('SELECT p.group_id,p.kind,p.intent,p.capacity,p.revision FROM community_group_policy p JOIN community_groups g ON g.id=p.group_id WHERE g.owner_account_id=? LIMIT 1001', actor.accountId); if (policies.length > 1000) throw new DomainError(413, 'community_export_capacity'); sections.groupPolicies = policies; count += policies.length;
  const payload = { module: 'community-b4', ...sections }; if (Buffer.byteLength(JSON.stringify(payload)) > 2097152) throw new DomainError(413, 'community_export_capacity'); append('community', payload); this.session(actor); return count + runs.length;
 }
 suppressAccount(accountId: string, epoch: number): void {
  this.serialization(); s.parse(s.id, accountId); if (!Number.isSafeInteger(epoch) || epoch < 0) throw new DomainError(422, 'community_invalid_input');
  const groups = this.rows<{ group_id: string }>('SELECT group_id FROM community_members WHERE account_id=? LIMIT 1001', accountId); if (groups.length > 1000) throw new DomainError(413, 'community_lifecycle_capacity');
  for (const group of groups) this.endMember(group.group_id, accountId, false);
  const owned = this.rows<{ id: string }>('SELECT id FROM community_groups WHERE owner_account_id=? LIMIT 1001', accountId); if (owned.length > 1000) throw new DomainError(413, 'community_lifecycle_capacity'); for (const group of owned) this.afterGroupCloses(group.id);
  this.write("UPDATE community_match_enrollments SET state='cancelled',preferences=NULL,revision=revision+1 WHERE account_id=?", accountId);
  this.write('UPDATE community_motion_electorate SET active=0 WHERE account_id=?', accountId); this.write('DELETE FROM community_ballots WHERE account_id=?', accountId);
  this.write('UPDATE community_reactions SET active=0,revision=revision+1 WHERE account_id=?', accountId);
  this.write("UPDATE community_posts SET state='hidden',text=NULL,revision=revision+1 WHERE author_account_id=?", accountId);
  this.write('DELETE FROM community_extension_receipts WHERE account_id=?', accountId); this.write('DELETE FROM community_post_cursors WHERE account_id=?', accountId);
  this.redactRunCandidates(accountId);
 }
 private redactRunCandidates(accountId: string): void {
  const bound = this.get<{ n: number; bytes: number }>('SELECT count(*) n,coalesce(sum(length(CAST(snapshot AS BLOB))),0) bytes FROM community_match_runs WHERE instr(snapshot,?)>0', accountId)!;
  if (bound.n > 200 || bound.bytes > 2097152) throw new DomainError(413, 'community_lifecycle_capacity');
  for (const run of this.rows<{ id: string; snapshot: string }>('SELECT id,snapshot FROM community_match_runs WHERE instr(snapshot,?)>0 LIMIT 201', accountId)) {
   const snapshot = s.parse(s.snapshot, this.bounded(run.snapshot, 524288)); const redacted: BatchSnapshot = { ...snapshot, candidates: snapshot.candidates.filter(c => c.accountId !== accountId), excludedPairs: snapshot.excludedPairs.filter(([a, b]) => a !== accountId && b !== accountId) };
   const encoded = canonical(redacted); this.write("UPDATE community_match_runs SET snapshot=?,input_digest=?,state='missed',finished_at=? WHERE id=?", encoded, digest(encoded), this.now(), run.id);
  }
 }
 verifySuppressed(accountId: string, epoch: number): boolean {
  this.serialization(); s.parse(s.id, accountId); if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
  return !this.get("SELECT 1 FROM community_match_enrollments WHERE account_id=? AND (state='queued' OR preferences IS NOT NULL)", accountId)
   && !this.get('SELECT 1 FROM community_profile_shares WHERE account_id=?', accountId)
   && !this.get("SELECT 1 FROM community_posts WHERE author_account_id=? AND (state<>'hidden' OR text IS NOT NULL)", accountId)
   && !this.get('SELECT 1 FROM community_reactions WHERE account_id=? AND active=1', accountId)
   && !this.get('SELECT 1 FROM community_motion_electorate WHERE account_id=? AND active=1', accountId)
   && !this.get('SELECT 1 FROM community_ballots WHERE account_id=?', accountId)
   && !this.get("SELECT 1 FROM community_seat_reservations WHERE sponsor_account_id=? AND state='available'", accountId)
   && !this.get('SELECT 1 FROM community_match_runs WHERE instr(snapshot,?)>0', accountId)
   && !this.get('SELECT 1 FROM community_extension_receipts WHERE account_id=?', accountId) && !this.get('SELECT 1 FROM community_post_cursors WHERE account_id=?', accountId);
 }
 purgeAccount(accountId: string): number {
  this.serialization(); s.parse(s.id, accountId); if (!this.verifySuppressed(accountId, 0)) throw new DomainError(409, 'community_suppression_required'); let count = 0;
  for (const [table, column] of [['community_post_cursors', 'account_id'], ['community_extension_receipts', 'account_id'], ['community_appeals', 'account_id'], ['community_safety_notices', 'account_id'], ['community_reports', 'account_id'], ['community_safety_references', 'account_id'], ['community_reactions', 'account_id'], ['community_posts', 'author_account_id'], ['community_ballots', 'account_id'], ['community_motion_electorate', 'account_id'], ['community_profile_shares', 'account_id'], ['community_match_assignments', 'account_id'], ['community_match_enrollments', 'account_id']] as const) count += this.write(`DELETE FROM ${table} WHERE ${column}=?`, accountId).changes;
  count += this.write('DELETE FROM community_seat_reservations WHERE sponsor_account_id=?', accountId).changes;
  count += this.write('DELETE FROM community_motions WHERE sponsor_account_id=? OR subject_account_id=?', accountId, accountId).changes;
  count += this.write('DELETE FROM community_blocks WHERE owner_account_id=? OR subject_account_id=?', accountId, accountId).changes;
  return count;
 }
 restoreBarrier(authoritative: { ready: true; suppressed: readonly { accountId: string; epoch: number }[] }): void {
  this.serialization(); if (!authoritative?.ready || authoritative.suppressed.length > 1000) throw new DomainError(503, 'community_restore_authority_unavailable');
  this.write('DELETE FROM community_profile_shares'); this.write("UPDATE community_posts SET state='hidden',text=NULL,revision=revision+1"); this.write('UPDATE community_reactions SET active=0,revision=revision+1');
  this.write('DELETE FROM community_ballots'); this.write('UPDATE community_motion_electorate SET active=0'); this.write("UPDATE community_motions SET state='cancelled',revision=revision+1,finalized_at=? WHERE state IN('open','review_pending')", this.now());
  this.write("UPDATE community_seat_reservations SET state='cancelled' WHERE state='available'"); this.write("UPDATE community_match_runs SET state='missed',finished_at=? WHERE state='frozen'", this.now());
  this.write("UPDATE community_match_enrollments SET state='cancelled',preferences=NULL,revision=revision+1 WHERE state='queued' OR preferences IS NOT NULL"); this.write('DELETE FROM community_extension_receipts'); this.write('DELETE FROM community_post_cursors');
  for (const entry of authoritative.suppressed) this.suppressAccount(entry.accountId, entry.epoch);
 }
}
export const createCommunityExtension = (deps: ExtensionDependencies): CommunityExtensionService => new CommunityExtensionService(deps);
