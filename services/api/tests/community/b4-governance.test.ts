import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DAY_MS, requiredYes, reserveCapacity } from '../../src/community/governance.js';
import { createCommunityExtension } from '../../src/community/extension-service.js';
import { actor } from './fixture.js';
import { b4Fixture } from './b4-fixture.js';
test('fixed electorate, expiry-only finalization and minimum three yes', () => { const f = b4Fixture(); try {
 f.clock.value = '2026-10-10T12:00:00.000Z'; const motion = f.extension.createMotion(f.a, f.group.id, { kind: 'growth', places: 4, expectedRevision: 1 }, 'motion'); assert.equal(motion.electorateSize, 6); assert.equal(motion.requiredYes, 4);
 for (const person of f.people.slice(0, 4)) f.extension.setBallot(person, f.group.id, motion.id, { choice: 'yes', expectedRevision: 0 }, randomUUID());
 assert.throws(() => f.extension.finalizeMotion(f.a, f.group.id, motion.id)); f.clock.value = motion.expiresAt; assert.equal(f.extension.finalizeMotion(f.a, f.group.id, motion.id).state, 'passed'); assert.equal(f.extension.readPolicy(f.a, f.group.id).capacity, 16); assert.equal(f.extension.finalizeMotion(f.a, f.group.id, motion.id).state, 'passed');
 } finally { f.db.close(); } });
test('unanimous removal only requests independent moderation; subject is excluded', () => { const f = b4Fixture(); try { f.clock.value = '2026-10-10T12:00:00.000Z'; const subject = f.people[1]!, member = f.community.readGroup(subject, f.group.id).members.find(m => m.memberId === f.community.listGroups(subject)[0]!.memberId)!;
 const motion = f.extension.createMotion(f.a, f.group.id, { kind: 'removal', memberId: member.memberId, expectedRevision: 1 }, 'remove'); assert.equal(motion.electorateSize, 5);
 assert.throws(() => f.extension.setBallot(subject, f.group.id, motion.id, { choice: 'yes', expectedRevision: 0 }, 'subject'));
 for (const person of f.people.filter(p => p !== subject)) f.extension.setBallot(person, f.group.id, motion.id, { choice: 'yes', expectedRevision: 0 }, randomUUID()); f.clock.value = motion.expiresAt;
 assert.equal(f.extension.finalizeMotion(f.a, f.group.id, motion.id).state, 'review_pending'); assert.equal(f.community.listGroups(subject).length, 1);
 } finally { f.db.close(); } });
test('departing electors do not shrink required yes or restore old ballots', () => { const f = b4Fixture(); try { f.clock.value = '2026-10-10T12:00:00.000Z'; const motion = f.extension.createMotion(f.a, f.group.id, { kind: 'growth', places: 1, expectedRevision: 1 }, 'motion');
 for (const person of f.people.slice(0, 4)) f.extension.setBallot(person, f.group.id, motion.id, { choice: 'yes', expectedRevision: 0 }, randomUUID());
 const leaver = f.people[3]!; f.db.transaction(() => { f.db.prepare("UPDATE community_members SET state='left',alias='',ended_at=? WHERE group_id=? AND account_id=?").run(f.clock.value, f.group.id, leaver.accountId); f.extension.afterMemberEnds(f.group.id, leaver.accountId); }).immediate();
 f.clock.value = motion.expiresAt; const result = f.extension.finalizeMotion(f.a, f.group.id, motion.id); assert.equal(result.requiredYes, 4); assert.equal(result.state, 'expired');
 } finally { f.db.close(); } });
test('friend sponsor is excluded; one expiring reservation cannot overfill cap20', () => { const f = b4Fixture(); try { f.clock.value = '2026-10-10T12:00:00.000Z'; const motion = f.extension.createMotion(f.a, f.group.id, { kind: 'friend', expectedRevision: 1 }, 'friend'); assert.equal(motion.electorateSize, 5); assert.throws(() => f.extension.setBallot(f.a, f.group.id, motion.id, { choice: 'yes', expectedRevision: 0 }, 'sponsor'));
 for (const person of f.people.slice(1, 5)) f.extension.setBallot(person, f.group.id, motion.id, { choice: 'yes', expectedRevision: 0 }, randomUUID()); f.clock.value = motion.expiresAt; f.extension.finalizeMotion(f.a, f.group.id, motion.id);
 const row = f.db.prepare('SELECT seats,expires_at FROM community_seat_reservations WHERE motion_id=?').get(motion.id) as { seats: number; expires_at: string }; assert.equal(row.seats, 1); assert.equal(Date.parse(row.expires_at) - Date.parse(f.clock.value), DAY_MS); assert.throws(() => reserveCapacity(20, 19, 1, 1)); assert.equal(requiredYes(3), 3);
 } finally { f.db.close(); } });


function removalLinkFixture() {
 const f = b4Fixture(); f.clock.value = '2026-10-10T12:00:00.000Z';
 const subject = f.people[1]!, memberId = f.community.listGroups(subject)[0]!.memberId;
 const input = { kind: 'removal', memberId, expectedRevision: 1 };
 const motion = f.extension.createMotion(f.a, f.group.id, input, 'remove-link');
 return { ...f, subject, memberId, input, motion };
}

test('removal motion links the current visible group member consistently across create list ballot and replay', t => {
 const f = removalLinkFixture(); t.after(() => f.db.close());
 assert.equal(f.motion.subjectMemberId, f.memberId);
 assert.equal(f.extension.listMotions(f.c, f.group.id)[0]!.subjectMemberId, f.memberId);
 const ballot = f.extension.setBallot(f.a, f.group.id, f.motion.id, { choice: 'yes', expectedRevision: 0 }, 'vote');
 assert.equal(ballot.subjectMemberId, f.memberId); assert.equal(ballot.ownBallot, 'yes');
 assert.equal(f.extension.createMotion(f.a, f.group.id, f.input, 'remove-link').subjectMemberId, f.memberId);
 assert.deepEqual(Object.keys(ballot).sort(), ['id', 'kind', 'places', 'subjectMemberId', 'revision', 'state', 'expiresAt', 'electorateSize', 'requiredYes', 'ownBallot', 'ballotRevision'].sort());
 assert.equal(JSON.stringify(ballot).includes(f.subject.accountId), false);
 assert.equal(JSON.stringify(ballot).includes('Synthetic member'), false);
});

test('non-removal motions never link a subject member', t => {
 for (const kind of ['friend', 'growth'] as const) {
  const f = b4Fixture(); t.after(() => f.db.close()); f.clock.value = '2026-10-10T12:00:00.000Z';
  const value = f.extension.createMotion(f.a, f.group.id, kind === 'growth' ? { kind, places: 1, expectedRevision: 1 } : { kind, expectedRevision: 1 }, kind);
  assert.equal(value.subjectMemberId, null); assert.equal(f.extension.listMotions(f.a, f.group.id)[0]!.subjectMemberId, null);
 }
});

test('removal linkage rejects stale group or membership generations promotion and cross-group subjects', t => {
 for (const change of ['group', 'member', 'promotion', 'other-group']) {
  const f = removalLinkFixture(); t.after(() => f.db.close());
  if (change === 'group') f.db.prepare('UPDATE community_groups SET generation=generation+1 WHERE id=?').run(f.group.id);
  else if (change === 'member') f.db.prepare('UPDATE community_members SET generation=generation+1 WHERE group_id=? AND account_id=?').run(f.group.id, f.subject.accountId);
  else if (change === 'promotion') f.db.prepare("UPDATE community_members SET role='admin' WHERE group_id=? AND account_id=?").run(f.group.id, f.subject.accountId);
  else {
   const person = actor(f.db), other = f.community.createGroup(f.a, { name: 'Other group', alias: 'Other owner', membershipDisclosureAccepted: true }, 'other');
   const invite = f.community.issueInvitation(f.a, other.id, {}, 'other-invite'); assert.ok(invite.tokenAvailable);
   f.community.joinInvitation(person, { token: invite.token, alias: 'Other target', membershipDisclosureAccepted: true }, 'other-join');
   f.db.prepare('UPDATE community_motions SET subject_account_id=? WHERE id=?').run(person.accountId, f.motion.id);
  }
  const value = f.extension.listMotions(f.a, f.group.id)[0]!;
  assert.equal(value.subjectMemberId, null); assert.equal(value.state, 'open'); assert.equal(value.id, f.motion.id);
 }
});

test('removal linkage does not follow a subject through leave and rejoin or disclose a closed group', t => {
 const f = removalLinkFixture(); t.after(() => f.db.close());
 f.community.leave(f.subject, f.group.id, {}, 'leave');
 assert.equal(f.extension.listMotions(f.a, f.group.id)[0]!.subjectMemberId, null);
 const newMember = randomUUID();
 f.db.prepare("UPDATE community_members SET state='active',alias='New membership',member_id=?,generation=generation+1,ended_at=NULL WHERE group_id=? AND account_id=?")
  .run(newMember, f.group.id, f.subject.accountId);
 assert.equal(f.extension.listMotions(f.a, f.group.id)[0]!.subjectMemberId, null);
 f.db.prepare("UPDATE community_groups SET state='closed',closed_at=? WHERE id=?").run(f.clock.value, f.group.id);
 assert.throws(() => f.extension.listMotions(f.a, f.group.id), { code: 'community_not_found' });
});

test('blocked removal subjects retain existing list concealment and command projections expose no target', t => {
 const f = removalLinkFixture(); t.after(() => f.db.close());
 f.extension.blockMember(f.c, f.group.id, f.memberId, {}, 'block');
 assert.deepEqual(f.extension.listMotions(f.c, f.group.id), []);
 const value = f.extension.finalizeMotionCommand(f.c, f.group.id, f.motion.id, {}, 'finalize');
 assert.equal(value.state, 'cancelled'); assert.equal(value.subjectMemberId, null);
 assert.equal(f.extension.finalizeMotionCommand(f.c, f.group.id, f.motion.id, {}, 'finalize').subjectMemberId, null);
 assert.equal(f.extension.listMotions(f.a, f.group.id)[0]!.subjectMemberId, f.memberId);
});

test('removal linkage rechecks eligibility and generations on replay without changing stored motion history', t => {
 const f = removalLinkFixture(); t.after(() => f.db.close());
 f.extension.setBallot(f.a, f.group.id, f.motion.id, { choice: 'yes', expectedRevision: 0 }, 'vote');
 f.db.prepare('UPDATE synthetic_accounts SET age=NULL WHERE id=?').run(f.subject.accountId);
 const replay = f.extension.setBallot(f.a, f.group.id, f.motion.id, { choice: 'yes', expectedRevision: 0 }, 'vote');
 assert.equal(replay.subjectMemberId, null); assert.equal(replay.ownBallot, 'yes');
 f.db.prepare('UPDATE synthetic_accounts SET age=17 WHERE id=?').run(f.subject.accountId);
 assert.equal(f.extension.listMotions(f.a, f.group.id)[0]!.subjectMemberId, null);
 f.db.prepare('UPDATE synthetic_accounts SET age=40 WHERE id=?').run(f.subject.accountId);
 f.db.prepare('UPDATE community_members SET generation=generation+1 WHERE group_id=? AND account_id=?').run(f.group.id, f.subject.accountId);
 assert.equal(f.extension.createMotion(f.a, f.group.id, f.input, 'remove-link').subjectMemberId, null);
 assert.deepEqual(f.db.prepare('SELECT subject_generation,state FROM community_motions WHERE id=?').get(f.motion.id), { subject_generation: 1, state: 'open' });
});

test('passed ordinary removal returns unavailable current linkage without restoring removed identity on finalization replay', t => {
 const f = removalLinkFixture(); t.after(() => f.db.close());
 const { moderation: _moderation, ...dependencies } = f.dependencies; const extension = createCommunityExtension(dependencies);
 for (const person of f.people.filter(person => person !== f.subject))
  extension.setBallot(person, f.group.id, f.motion.id, { choice: 'yes', expectedRevision: 0 }, randomUUID());
 f.clock.value = f.motion.expiresAt;
 const value = extension.finalizeMotionCommand(f.a, f.group.id, f.motion.id, {}, 'finalize');
 assert.equal(value.state, 'passed'); assert.equal(value.subjectMemberId, null);
 assert.equal(extension.listMotions(f.a, f.group.id)[0]!.subjectMemberId, null);
 assert.equal(extension.finalizeMotionCommand(f.a, f.group.id, f.motion.id, {}, 'finalize').subjectMemberId, null);
 assert.equal(f.db.prepare('SELECT 1 FROM community_safety_notices').get(), undefined);
});

test('growth places survive ordinary sponsor create reload ballot finalization and receipt replay without exposing identities', t => {
 const f = b4Fixture(); t.after(() => f.db.close()); f.clock.value = '2026-10-10T12:00:00.000Z';
 const input = { kind: 'growth', places: 3, expectedRevision: 1 }, sponsor = f.b;
 const created = f.extension.createMotion(sponsor, f.group.id, input, 'growth');
 assert.equal(created.places, 3); assert.equal(created.subjectMemberId, null);
 assert.equal(f.extension.listMotions(f.c, f.group.id)[0]!.places, 3);
 for (const person of f.people.slice(0, 4)) assert.equal(f.extension.setBallot(person, f.group.id, created.id, { choice: 'yes', expectedRevision: 0 }, randomUUID()).places, 3);
 f.clock.value = created.expiresAt;
 const result = f.extension.finalizeMotionCommand(f.c, f.group.id, created.id, {}, 'finish');
 assert.equal(result.state, 'passed'); assert.equal(result.places, 3); assert.equal(f.extension.readPolicy(f.a, f.group.id).capacity, 15);
 assert.equal(f.extension.createMotion(sponsor, f.group.id, input, 'growth').places, 3);
 assert.deepEqual(f.extension.finalizeMotionCommand(f.c, f.group.id, created.id, {}, 'finish'), result);
 assert.equal(f.community.readGroup(f.a, f.group.id).members.length, 6);
 assert.deepEqual(Object.keys(result).sort(), ['id', 'kind', 'places', 'subjectMemberId', 'revision', 'state', 'expiresAt', 'electorateSize', 'requiredYes', 'ownBallot', 'ballotRevision'].sort());
 assert.equal(JSON.stringify(result).includes(sponsor.accountId), false);
 assert.equal((f.db.prepare('SELECT seats FROM community_seat_reservations WHERE motion_id=?').get(created.id) as { seats: number }).seats, 3);
});

test('growth requested places remain visible after expiry without votes while other motion kinds project null', t => {
 const f = b4Fixture(); t.after(() => f.db.close()); f.clock.value = '2026-10-10T12:00:00.000Z';
 const growth = f.extension.createMotion(f.a, f.group.id, { kind: 'growth', places: 4, expectedRevision: 1 }, 'growth');
 const friend = f.extension.createMotion(f.b, f.group.id, { kind: 'friend', expectedRevision: 1 }, 'friend');
 assert.equal(friend.places, null);
 f.clock.value = growth.expiresAt;
 assert.equal(f.extension.listMotions(f.c, f.group.id).find(value => value.id === growth.id)!.state, 'awaiting_finalization');
 const expired = f.extension.finalizeMotion(f.a, f.group.id, growth.id);
 assert.equal(expired.state, 'expired'); assert.equal(expired.places, 4); assert.equal(f.extension.readPolicy(f.a, f.group.id).capacity, 12);
 const removal = removalLinkFixture(); t.after(() => removal.db.close()); assert.equal(removal.motion.places, null);
});

test('growth projection rejects corrupt stored fractional places instead of rounding or guessing', t => {
 const f = b4Fixture(); t.after(() => f.db.close()); f.clock.value = '2026-10-10T12:00:00.000Z';
 const input = { kind: 'growth', places: 1, expectedRevision: 1 }, motion = f.extension.createMotion(f.a, f.group.id, input, 'growth');
 f.db.prepare('UPDATE community_motions SET places=1.5 WHERE id=?').run(motion.id);
 assert.throws(() => f.extension.listMotions(f.c, f.group.id), { code: 'community_integrity_unavailable' });
 assert.throws(() => f.extension.createMotion(f.a, f.group.id, input, 'growth'), { code: 'community_integrity_unavailable' });
 assert.equal((f.db.prepare('SELECT places FROM community_motions WHERE id=?').get(motion.id) as { places: number }).places, 1.5);
});

test('growth places projection retains current membership access and existing removal block filters', t => {
 const f = removalLinkFixture(); t.after(() => f.db.close());
 const growth = f.extension.createMotion(f.b, f.group.id, { kind: 'growth', places: 2, expectedRevision: 1 }, 'growth');
 f.extension.blockMember(f.c, f.group.id, f.memberId, {}, 'block');
 const visible = f.extension.listMotions(f.c, f.group.id);
 assert.equal(visible.some(value => value.id === f.motion.id), false);
 assert.equal(visible.find(value => value.id === growth.id)!.places, 2);
 f.community.leave(f.c, f.group.id, {}, 'leave');
 assert.throws(() => f.extension.listMotions(f.c, f.group.id), { code: 'community_not_found' });
});
