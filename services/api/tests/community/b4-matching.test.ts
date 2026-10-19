import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../src/errors.js';
import { planCommunityBatch, sundayPolicy, nextSundayPolicy } from '../../src/community/matching.js';
import { createCommunityExtension } from '../../src/community/extension-service.js';
import type { BatchSnapshot } from '../../src/community/extension-types.js';
import { b4Fixture, syntheticCandidates, syntheticPreferences } from './b4-fixture.js';
import { actor } from './fixture.js';
function snapshot(count: number): BatchSnapshot { return { intent: 'accountability', language: 'en', exclusionsKnown: true, exclusionGeneration: 0, excludedPairs: [], candidates: Array.from({ length: count }, (_, i) => ({ enrollmentId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, accountId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, revision: 1, generation: 1, queuedAt: '2026-10-01T00:00:00.000Z', consentAt: '2026-10-01T00:00:00.000Z', eligible: true, exclusionRevision: 0, preferences: syntheticPreferences() })) }; }
for (const [count, sizes] of [[4, [4]], [12, [12]], [13, [7, 6]], [25, [9, 8, 8]]] as const) test(`synthetic ${count} balances without stranded tail`, () => { const input = snapshot(count), policy = sundayPolicy('2026-10-11'); const plan = planCommunityBatch(input, policy); assert.deepEqual(plan.cohorts.map(c => c.enrollmentIds.length), sizes); assert.deepEqual(planCommunityBatch(input, policy), plan); });
test('Sunday uses civil date across DST; cutoff equality moves to next Sunday', () => { assert.equal(sundayPolicy('2026-03-08').cutoffAt, '2026-03-08T21:00:00.000Z'); assert.equal(sundayPolicy('2026-11-01').cutoffAt, '2026-11-01T22:00:00.000Z'); assert.equal(nextSundayPolicy(new Date('2026-10-11T21:00:00.000Z')).cutoffLocalDate, '2026-10-18'); });
test('no willing host, missing exclusion authority, under minimum and cutoff equality remain pending', () => {
 const policy = sundayPolicy('2026-10-11'); const input = snapshot(4);
 assert.equal(planCommunityBatch({ ...input, candidates: input.candidates.map(c => ({ ...c, preferences: syntheticPreferences({ willingHost: false }) })) }, policy).cohorts.length, 0);
 assert.equal(planCommunityBatch({ ...input, exclusionsKnown: false }, policy).status, 'pending_authority');
 assert.equal(planCommunityBatch(snapshot(3), policy).cohorts.length, 0);
 assert.equal(planCommunityBatch({ ...input, candidates: input.candidates.map(c => ({ ...c, consentAt: policy.cutoffAt })) }, policy).cohorts.length, 0);
});
test('every pair respects hard exclusions and intent separation', () => { const input = snapshot(4), policy = sundayPolicy('2026-10-11'); const a = input.candidates[1]!, b = input.candidates[2]!; assert.equal(planCommunityBatch({ ...input, excludedPairs: [[a.accountId, b.accountId]] }, policy).cohorts.length, 0); assert.equal(planCommunityBatch({ ...input, candidates: input.candidates.map((c, i) => i === 2 ? { ...c, preferences: syntheticPreferences({ intent: 'supportive_community' }) } : c) }, policy).cohorts.length, 0); });
test('durable frozen run applies once and creates private parent memberships', () => {
 const f = b4Fixture(); try { const people = syntheticCandidates(f.db, f.extension, 13), policy = sundayPolicy('2026-10-11'); f.clock.value = policy.cutoffAt; const run = f.extension.freezeBatch(policy, 'accountability', 'en', randomUUID()); f.clock.value = policy.runAt;
 const result = f.extension.applyBatch(run.id); assert.equal(result.groupsCreated, 2); assert.deepEqual(f.extension.applyBatch(run.id), result);
 const replacement = createCommunityExtension(f.dependencies); assert.equal(replacement.readMatching(people[0]!).state, 'assigned');
 const shares = f.db.prepare('SELECT * FROM community_share_settings WHERE account_id=?').get(people[0]!.accountId) as { participation: number; workout: number }; assert.equal(shares.participation, 0); assert.equal(shares.workout, 0);
 assert.equal((f.db.prepare('SELECT count(*) n FROM community_match_assignments WHERE run_id=?').get(run.id) as { n: number }).n, 13);
 } finally { f.db.close(); }
});
test('cancel after freeze wins before atomic assignment', () => { const f = b4Fixture(); try { const people = syntheticCandidates(f.db, f.extension, 4), policy = sundayPolicy('2026-10-11'); f.clock.value = policy.cutoffAt; const run = f.extension.freezeBatch(policy, 'accountability', 'en', randomUUID()); f.extension.cancelEnrollment(people[0]!, { expectedRevision: 1 }, 'cancel'); f.clock.value = policy.runAt; assert.equal(f.extension.applyBatch(run.id).groupsCreated, 0); assert.equal(f.extension.readMatching(people[0]!).state, 'cancelled'); } finally { f.db.close(); } });
test('batch capability absent never fabricates an actor or applies writes', () => { const f = b4Fixture(); try { const { batch: _batch, ...dependencies } = f.dependencies; const service = createCommunityExtension(dependencies); assert.throws(() => service.freezeBatch(sundayPolicy('2026-10-11'), 'accountability', 'en', randomUUID()), (e: unknown) => e instanceof DomainError && e.code === 'community_batch_authority_unavailable'); } finally { f.db.close(); } });
test('freeze conflict and stale enrollment revisions fail without replacing intent', () => { const f = b4Fixture(); try { const people = syntheticCandidates(f.db, f.extension, 4), policy = sundayPolicy('2026-10-11'); assert.throws(() => f.extension.enroll(people[0]!, { expectedRevision: 0, preferences: syntheticPreferences() }, 'stale')); f.clock.value = policy.cutoffAt; f.extension.freezeBatch(policy, 'accountability', 'en', randomUUID()); f.extension.cancelEnrollment(people[0]!, { expectedRevision: 1 }, 'cancel'); assert.throws(() => f.extension.freezeBatch(policy, 'accountability', 'en', randomUUID()), (e: unknown) => e instanceof DomainError && e.status === 409); } finally { f.db.close(); } });

function assignedFixture(t: TestContext) {
 const f = b4Fixture(); t.after(() => f.db.close());
 const people = syntheticCandidates(f.db, f.extension, 4), policy = sundayPolicy('2026-10-11');
 f.clock.value = policy.cutoffAt; const run = f.extension.freezeBatch(policy, 'accountability', 'en', randomUUID());
 f.clock.value = policy.runAt; f.extension.applyBatch(run.id);
 const group = f.db.prepare('SELECT g.id,g.owner_account_id FROM community_groups g JOIN community_match_assignments a ON a.group_id=g.id WHERE a.account_id=?').get(people[0]!.accountId) as { id: string; owner_account_id: string };
 const owner = people.find(person => person.accountId === group.owner_account_id)!;
 const member = people.find(person => person !== owner)!;
 const receipt = f.db.prepare("SELECT key FROM community_extension_receipts WHERE account_id=? AND operation='enroll'").get(member.accountId) as { key: string };
 return { ...f, people, assignedGroup: group.id, owner, member, enrollmentKey: receipt.key };
}

test('matching projection exposes only the current own assignment and refreshes enrollment replay', t => {
 const f = assignedFixture(t);
 const view = f.extension.readMatching(f.member); assert.equal(view.state, 'assigned'); assert.equal(view.assignedGroupId, f.assignedGroup);
 assert.deepEqual(Object.keys(view).sort(), ['assignedGroupId', 'cooldownUntil', 'generation', 'missedBatches', 'preferences', 'queuedAt', 'relaxation', 'revision', 'state']);
 const replay = () => f.extension.enroll(f.member, { expectedRevision: 0, preferences: syntheticPreferences() }, f.enrollmentKey);
 assert.equal(replay().assignedGroupId, f.assignedGroup);
 // This synthetic role transition models the generation change without bypassing production governance.
 f.db.prepare("UPDATE community_members SET role='admin',generation=generation+1 WHERE group_id=? AND account_id=?").run(f.assignedGroup, f.member.accountId);
 const changed = f.extension.readMatching(f.member); assert.equal(changed.assignedGroupId, null); assert.equal(changed.state, 'assigned');
 assert.equal(f.community.readGroup(f.member, f.assignedGroup).id, f.assignedGroup);
 assert.equal(replay().assignedGroupId, null);
 assert.equal((f.db.prepare('SELECT member_generation FROM community_match_assignments WHERE account_id=?').get(f.member.accountId) as { member_generation: number }).member_generation, 1);
});

test('matching assignment projection rejects wrong actors and enrollment or membership generations', t => {
 const f = assignedFixture(t);
 const assignment = f.db.prepare('SELECT id,enrollment_generation FROM community_match_assignments WHERE account_id=?').get(f.member.accountId) as { id: string; enrollment_generation: number };
 f.db.prepare('UPDATE community_match_assignments SET account_id=? WHERE id=?').run(f.owner.accountId, assignment.id);
 assert.equal(f.extension.readMatching(f.member).assignedGroupId, null);
 f.db.prepare('UPDATE community_match_assignments SET account_id=?,enrollment_generation=enrollment_generation+1 WHERE id=?').run(f.member.accountId, assignment.id);
 assert.equal(f.extension.readMatching(f.member).assignedGroupId, null);
 f.db.prepare('UPDATE community_match_assignments SET enrollment_generation=?,member_generation=member_generation+1 WHERE id=?').run(assignment.enrollment_generation, assignment.id);
 assert.equal(f.extension.readMatching(f.member).assignedGroupId, null);
 assert.equal(f.extension.readMatching(f.owner).assignedGroupId, f.assignedGroup);
});

test('matching assignment projection hides ended memberships and closed groups without rewriting enrollment', t => {
 const f = assignedFixture(t);
 f.db.prepare("UPDATE community_members SET state='removed',alias='',ended_at=? WHERE group_id=? AND account_id=?").run(f.clock.value, f.assignedGroup, f.member.accountId);
 const ended = f.extension.readMatching(f.member); assert.equal(ended.assignedGroupId, null); assert.equal(ended.state, 'assigned');
 f.db.prepare("UPDATE community_groups SET state='closed',closed_at=?,generation=generation+1 WHERE id=?").run(f.clock.value, f.assignedGroup);
 const closed = f.extension.readMatching(f.owner); assert.equal(closed.assignedGroupId, null); assert.equal(closed.state, 'assigned');
});

test('matching assignment projection uses declared eligibility and propagates unexpected failures', t => {
 const f = assignedFixture(t), lifecycle = f.dependencies.lifecycle!;
 for (const value of [
  { policy: 'self_reported_adult_v1', status: 'not_adult', profileRevision: 1 },
  { policy: 'self_reported_adult_v1', status: 'unknown', profileRevision: null },
  { policy: 'unsupported', status: 'eligible', profileRevision: 1 },
 ]) {
  const extension = createCommunityExtension({ ...f.dependencies, lifecycle: { ...lifecycle,
   adultEligibility: () => value as ReturnType<typeof lifecycle.adultEligibility> } });
  assert.equal(extension.readMatching(f.member).assignedGroupId, null);
 }
 const fault = new DomainError(503, 'community_integrity_unavailable');
 const broken = createCommunityExtension({ ...f.dependencies, lifecycle: { ...lifecycle, adultEligibility: () => { throw fault; } } });
 assert.throws(() => broken.readMatching(f.member), error => error === fault);
 assert.equal(f.extension.readMatching(f.member).assignedGroupId, f.assignedGroup);
});

test('leave and re-enrollment never reuse an old assigned group and close cancels remaining links', t => {
 const f = assignedFixture(t);
 f.community.leave(f.member, f.assignedGroup, {}, 'leave');
 const left = f.extension.readMatching(f.member); assert.equal(left.assignedGroupId, null); assert.equal(left.state, 'cancelled'); assert.ok(left.cooldownUntil);
 f.clock.value = left.cooldownUntil!;
 const queued = f.extension.enroll(f.member, { expectedRevision: left.revision, preferences: syntheticPreferences() }, 'reenroll');
 assert.equal(queued.assignedGroupId, null); assert.equal(queued.state, 'queued'); assert.equal(queued.generation, left.generation + 1);
 const cancelled = f.extension.cancelEnrollment(f.member, { expectedRevision: queued.revision }, 'cancel-new');
 assert.equal(cancelled.assignedGroupId, null);
 assert.equal(f.extension.cancelEnrollment(f.member, { expectedRevision: queued.revision }, 'cancel-new').assignedGroupId, null);
 f.community.closeGroup(f.owner, f.assignedGroup, { expectedRevision: 1 }, 'close');
 const closed = f.extension.readMatching(f.owner); assert.equal(closed.assignedGroupId, null); assert.equal(closed.state, 'cancelled');
 assert.equal((f.db.prepare('SELECT count(*) n FROM community_match_assignments WHERE account_id=?').get(f.member.accountId) as { n: number }).n, 1);
});

test('absent enrollment restore and account suppression project null without assignment history disclosure', t => {
 for (const operation of ['restore', 'suppress']) {
  const f = assignedFixture(t), fresh = actor(f.db);
  assert.equal(f.extension.readMatching(fresh).assignedGroupId, null);
  assert.equal(f.extension.enroll(fresh, { expectedRevision: 0, preferences: syntheticPreferences() }, 'new').assignedGroupId, null);
  f.db.transaction(() => operation === 'restore' ? f.extension.restoreBarrier({ ready: true, suppressed: [] }) : f.extension.suppressAccount(f.member.accountId, f.member.epoch)).immediate();
  const restored = f.extension.readMatching(f.member); assert.equal(restored.assignedGroupId, null); assert.equal(restored.state, 'cancelled');
  assert.equal((f.db.prepare('SELECT count(*) n FROM community_match_assignments WHERE account_id=?').get(f.member.accountId) as { n: number }).n, 1);
 }
});
