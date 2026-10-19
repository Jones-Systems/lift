import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLocalTextModeration } from '../../src/community/moderation/index.js';
import { BOARD_POLICY_VERSION } from '../../src/community/board/types.js';
import { createCommunityIntegration } from '../../src/community/integration.js';
import { createCommunityExtensionRoutes } from '../../src/community/extension-routes.js';
import { createCommunityExtension } from '../../src/community/extension-service.js';
import { featureBoardMigrationSql } from '../../src/community/board/migration.js';
import { b4Fixture } from './b4-fixture.js';
import { actor, bindings, eligibility } from './fixture.js';

const policy = { version: 'synthetic-v1', rejectedTokens: ['badtoken'], allowedTokens: ['scunthorpe', 'notbadtoken'], directedProfanity: ['swear'] };
test('local text policy rejects evasion and aggression without Scunthorpe false positives; safety quotes remain allowed', () => {
  const port = createLocalTextModeration(policy);
  for (const text of ['badtoken', 'b4dt0k3n', 'b a d t o k e n', 'b\u200badtoken', 'bádtoken', "I'll hurt you", 'kill yourself', 'you swear you swear'])
    assert.equal(port.community.checkText({ purpose: 'post', policyVersion: 'community-v1', text }), 'rejected');
  for (const text of ['Scunthorpe', 'notbadtoken', 'I enjoyed training', 'My muscles hurt', 'I will help you'])
    assert.equal(port.community.checkText({ purpose: 'alias', policyVersion: 'community-v1', text }), 'allowed');
  assert.equal(port.community.checkText({ purpose: 'safety', policyVersion: 'community-v1', text: 'badtoken' }), 'allowed');
  assert.equal(port.board.checkText({ purpose: 'feature_board', policyVersion: BOARD_POLICY_VERSION, title: 'badtoken', description: 'Hello' }), 'rejected');
  assert.equal(createLocalTextModeration(null).community.checkText({ purpose: 'post', policyVersion: 'community-v1', text: 'Hello' }), 'unavailable');
});

function integrated() {
  const f = b4Fixture(); f.db.exec(featureBoardMigrationSql);
  const text = createLocalTextModeration(policy);
  const module = createCommunityIntegration({ db: f.db, now: f.now, lifecycle: bindings(f.db), subjectEligibility: id => eligibility(f.db, id),
    parent: { assertRateLimit: () => {} }, extension: { accountCreatedAt: () => '2026-09-01T00:00:00Z', textModeration: text.community, assertRateLimit: () => {} }, board: { textModeration: text.board } });
  f.clock.value = '2026-10-10T12:00:00.000Z';
  return { ...f, module };
}
function passFriend(f: ReturnType<typeof integrated>, sponsor = f.people[1]!) {
  const motion = f.module.extension.createMotion(sponsor, f.group.id, { kind: 'friend', expectedRevision: 1 }, randomUUID());
  for (const person of f.people.filter(p => p !== sponsor)) f.module.extension.setBallot(person, f.group.id, motion.id, { expectedRevision: 0, choice: 'yes' }, randomUUID());
  f.clock.value = motion.expiresAt; assert.equal(f.module.extension.finalizeMotion(f.a, f.group.id, motion.id).state, 'passed');
  const row = f.db.prepare('SELECT id,expires_at FROM community_seat_reservations WHERE motion_id=?').get(motion.id) as { id: string; expires_at: string };
  return { ...row, sponsor };
}
test('ordinary-member removal vote is a group decision, hides posts, and cannot target an admin or owner', t => {
  const f = integrated(); t.after(() => f.db.close()); const subject = f.people[1]!;
  const subjectMember = f.module.community.listGroups(subject)[0]!;
  const post = f.extension.createPost(subject, f.group.id, { kind: 'win', text: 'Synthetic progress', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'subject-post');
  for (const id of [f.group.memberId]) assert.throws(() => f.module.extension.createMotion(subject, f.group.id, { kind: 'removal', memberId: id, expectedRevision: 1 }, randomUUID()), { code: 'community_not_found' });
  f.db.prepare("UPDATE community_members SET role='admin' WHERE account_id=?").run(subject.accountId);
  assert.throws(() => f.module.extension.createMotion(f.a, f.group.id, { kind: 'removal', memberId: subjectMember.memberId, expectedRevision: 1 }, randomUUID()), { code: 'community_not_found' });
  f.db.prepare("UPDATE community_members SET role='member' WHERE account_id=?").run(subject.accountId);
  const motion = f.module.extension.createMotion(f.a, f.group.id, { kind: 'removal', memberId: subjectMember.memberId, expectedRevision: 1 }, randomUUID());
  for (const person of f.people.filter(p => p !== subject)) f.module.extension.setBallot(person, f.group.id, motion.id, { expectedRevision: 0, choice: 'yes' }, randomUUID());
  f.clock.value = motion.expiresAt; assert.equal(f.module.extension.finalizeMotion(f.a, f.group.id, motion.id).state, 'passed');
  assert.equal((f.db.prepare('SELECT state FROM community_members WHERE account_id=?').get(subject.accountId) as { state: string }).state, 'removed');
  assert.equal((f.db.prepare('SELECT count(*) n FROM community_safety_notices').get() as { n: number }).n, 0);
  assert.equal((f.db.prepare('SELECT count(*) n FROM community_seat_reservations').get() as { n: number }).n, 0);
  assert.equal(f.module.community.listGroups(subject).length, 0);
  assert.deepEqual(f.db.prepare('SELECT state,text FROM community_posts WHERE id=?').get(post.id), { state: 'hidden', text: null });
  assert.throws(() => f.module.community.removeMember(f.people[2]!, f.group.id, f.group.memberId, { expectedRevision: 1 }, randomUUID()), { code: 'community_not_found' });
});

test('friend sponsor issues once, reserved join atomically consumes seat, and replay never reveals token', t => {
  const f = integrated(); t.after(() => f.db.close()); const reservation = passFriend(f);
  assert.throws(() => f.module.community.issueFriendInvitation(f.a, f.group.id, reservation.id, {}, 'not-sponsor'), { code: 'community_not_found' });
  const issued = f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'issue'); assert.ok(issued.tokenAvailable);
  const replay = f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'issue'); assert.equal(replay.tokenAvailable, false);
  assert.throws(() => f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'new-key'));
  const friend = actor(f.db), input = { token: issued.token, alias: 'New friend', membershipDisclosureAccepted: true };
  assert.ok(f.module.community.previewInvitation(friend, { token: issued.token }));
  const joined = f.module.community.joinInvitation(friend, input, 'join');
  assert.deepEqual(f.module.community.joinInvitation(friend, input, 'join'), joined);
  assert.throws(() => f.module.community.joinInvitation(friend, { ...input, alias: 'Changed intent' }, 'join'), { code: 'idempotency_conflict' });
  assert.equal((f.db.prepare('SELECT consumed,state FROM community_seat_reservations WHERE id=?').get(reservation.id) as { consumed: number }).consumed, 1);
  assert.throws(() => f.module.community.joinInvitation(actor(f.db), input, 'other'));
});

test('friend expiry, sponsor revocation, denied join rollback and mismatched issue intent', t => {
  const f = integrated(); t.after(() => f.db.close()); const reservation = passFriend(f);
  const issued = f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'issue'); assert.ok(issued.tokenAvailable);
  const friend = actor(f.db); f.db.prepare('INSERT INTO community_blocks VALUES(?,?,?,1,1,?)').run(randomUUID(), f.a.accountId, friend.accountId, f.clock.value);
  assert.throws(() => f.module.community.joinInvitation(friend, { token: issued.token, alias: 'Friend', membershipDisclosureAccepted: true }, 'join'));
  assert.equal((f.db.prepare('SELECT consumed FROM community_seat_reservations WHERE id=?').get(reservation.id) as { consumed: number }).consumed, 0);
  assert.equal(f.db.prepare('SELECT 1 FROM community_members WHERE account_id=?').get(friend.accountId), undefined);
  const revoked = f.module.community.revokeInvitation(reservation.sponsor, f.group.id, issued.id, { expectedRevision: 1 }, 'revoke'); assert.equal(revoked.state, 'revoked');
  assert.throws(() => f.module.community.previewInvitation(actor(f.db), { token: issued.token }), { code: 'community_invitation_unavailable' });
  f.clock.value = reservation.expires_at;
  assert.throws(() => f.module.community.joinInvitation(actor(f.db), { token: issued.token, alias: 'Friend', membershipDisclosureAccepted: true }, 'expired'), { code: 'community_invitation_unavailable' });
});

test('injected local policy allows pending posts, reports, appeals and board submissions; rejects persist nothing', t => {
  const ports = createLocalTextModeration(policy), f = b4Fixture({ textModeration: ports.community }); t.after(() => f.db.close()); f.db.exec(featureBoardMigrationSql);
  const module = createCommunityIntegration({ db: f.db, now: f.now, lifecycle: bindings(f.db), subjectEligibility: id => eligibility(f.db, id),
    parent: { assertRateLimit: () => {} }, extension: f.dependencies, board: { textModeration: ports.board } });
  const post = { kind: 'win', text: 'Happy to be training today', policyVersion: 'community-v1', audiencePreviewAccepted: true };
  assert.equal(module.extension.createPost(f.a, f.group.id, post, 'post').state, 'pending');
  assert.throws(() => module.extension.createPost(f.b, f.group.id, { ...post, text: 'badtoken' }, 'rejected'), { code: 'community_text_rejected' });
  assert.equal(f.db.prepare("SELECT 1 FROM community_posts WHERE text LIKE '%badtoken%'").get(), undefined);
  const board = { title: 'More flexible training', description: 'Please support more training options.', category: 'plans', policyVersion: BOARD_POLICY_VERSION, policyAccepted: true, audienceAccepted: true };
  assert.equal(module.board.submit(f.a, board, 'board').visibility, 'pending');
  assert.throws(() => module.board.submit(f.b, { ...board, title: 'badtoken' }, 'rejected'), { code: 'board_text_rejected' });
  assert.equal(f.db.prepare("SELECT 1 FROM community_board_submissions WHERE title LIKE '%badtoken%'").get(), undefined);
  const reference = module.extension.safetyReference(f.b, f.group.id, 'member', f.group.memberId);
  assert.equal(module.extension.report(f.b, { category: 'harassment', text: 'Quoted badtoken', safetyReference: reference.id }, 'report').state, 'pending');
  const notice = randomUUID(); f.db.prepare("INSERT INTO community_safety_notices VALUES(?,?,?,?,?,1,'active',?,?,?,?)").run(notice, f.b.accountId, f.group.id, 'Synthetic reason', 'Synthetic rule', f.clock.value, '2026-10-20T00:00:00Z', '2026-10-30T00:00:00Z', 'synthetic-review');
  assert.equal(module.extension.appeal(f.b, notice, { expectedRevision: 1, text: 'Quoted badtoken' }, 'appeal').state, 'pending');
});

test('friend invitation expires without consuming the seat or creating membership', t => {
  const f = integrated(); t.after(() => f.db.close()); const reservation = passFriend(f);
  const issued = f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'issue'); assert.ok(issued.tokenAvailable);
  f.clock.value = reservation.expires_at; const friend = actor(f.db);
  assert.throws(() => f.module.community.joinInvitation(friend, { token: issued.token, alias: 'Friend', membershipDisclosureAccepted: true }, 'join'), { code: 'community_invitation_unavailable' });
  assert.equal(f.db.prepare('SELECT 1 FROM community_members WHERE account_id=?').get(friend.accountId), undefined);
  assert.equal((f.db.prepare('SELECT consumed FROM community_seat_reservations WHERE id=?').get(reservation.id) as { consumed: number }).consumed, 0);
});

function passRemovalBallots(f: ReturnType<typeof integrated>) {
  const subject = f.people[1]!, memberId = f.module.community.listGroups(subject)[0]!.memberId;
  const motion = f.module.extension.createMotion(f.a, f.group.id, { kind: 'removal', memberId, expectedRevision: 1 }, randomUUID());
  for (const person of f.people.filter(p => p !== subject)) f.module.extension.setBallot(person, f.group.id, motion.id, { expectedRevision: 0, choice: 'yes' }, randomUUID());
  f.clock.value = motion.expiresAt;
  return { subject, motion };
}

test('removal expires when the subject becomes an admin or its membership generation changes', t => {
  for (const change of ["role='admin'", 'generation=generation+1']) {
    const f = integrated(); t.after(() => f.db.close()); const { subject, motion } = passRemovalBallots(f);
    f.db.prepare(`UPDATE community_members SET ${change} WHERE group_id=? AND account_id=?`).run(f.group.id, subject.accountId);
    assert.equal(f.module.extension.finalizeMotion(f.a, f.group.id, motion.id).state, 'expired');
    assert.equal((f.db.prepare('SELECT state FROM community_members WHERE group_id=? AND account_id=?').get(f.group.id, subject.accountId) as { state: string }).state, 'active');
    assert.equal((f.db.prepare('SELECT count(*) n FROM community_safety_notices').get() as { n: number }).n, 0);
  }
});

test('removal finalization rolls back membership and posts if the motion write fails', t => {
  const f = integrated(); t.after(() => f.db.close()); const { subject, motion } = passRemovalBallots(f);
  const post = f.extension.createPost(subject, f.group.id, { kind: 'win', text: 'Synthetic progress', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'rollback-post');
  f.db.exec("CREATE TRIGGER synthetic_motion_failure BEFORE UPDATE ON community_motions WHEN NEW.state='passed' BEGIN SELECT RAISE(ABORT, 'synthetic motion failure'); END");
  assert.throws(() => f.module.extension.finalizeMotion(f.a, f.group.id, motion.id), /synthetic motion failure/);
  assert.equal((f.db.prepare('SELECT state FROM community_motions WHERE id=?').get(motion.id) as { state: string }).state, 'open');
  assert.equal((f.db.prepare('SELECT state FROM community_members WHERE group_id=? AND account_id=?').get(f.group.id, subject.accountId) as { state: string }).state, 'active');
  assert.deepEqual(f.db.prepare('SELECT state,text FROM community_posts WHERE id=?').get(post.id), { state: 'pending', text: 'Synthetic progress' });
  assert.deepEqual(f.module.community.listRemovedMemberships(subject), []);
  assert.equal(f.db.prepare('SELECT 1 FROM community_removal_snapshots').get(), undefined);
  f.db.exec('DROP TRIGGER synthetic_motion_failure');
  assert.equal(f.module.extension.finalizeMotion(f.a, f.group.id, motion.id).state, 'passed');
  assert.deepEqual(f.db.prepare('SELECT state,text FROM community_posts WHERE id=?').get(post.id), { state: 'hidden', text: null });
});

test('reserved join rolls back invitation and membership when reservation consumption fails', t => {
  const f = integrated(); t.after(() => f.db.close()); const reservation = passFriend(f);
  const issued = f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'issue'); assert.ok(issued.tokenAvailable);
  const friend = actor(f.db), input = { token: issued.token, alias: 'Friend', membershipDisclosureAccepted: true };
  f.db.exec("CREATE TRIGGER synthetic_reservation_failure BEFORE UPDATE ON community_seat_reservations WHEN NEW.state='consumed' BEGIN SELECT RAISE(ABORT, 'synthetic reservation failure'); END");
  assert.throws(() => f.module.community.joinInvitation(friend, input, 'join'), /synthetic reservation failure/);
  assert.equal(f.db.prepare('SELECT 1 FROM community_members WHERE account_id=?').get(friend.accountId), undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM community_share_settings WHERE account_id=?').get(friend.accountId), undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM community_command_receipts WHERE account_id=?').get(friend.accountId), undefined);
  assert.equal((f.db.prepare('SELECT state FROM community_invitations WHERE id=?').get(issued.id) as { state: string }).state, 'pending');
  assert.deepEqual(f.db.prepare('SELECT state,consumed FROM community_seat_reservations WHERE id=?').get(reservation.id), { state: 'available', consumed: 0 });
  f.db.exec('DROP TRIGGER synthetic_reservation_failure');
  assert.ok(f.module.community.joinInvitation(friend, input, 'join').memberId);
  assert.deepEqual(f.db.prepare('SELECT state,consumed FROM community_seat_reservations WHERE id=?').get(reservation.id), { state: 'consumed', consumed: 1 });
});

test('friend finalization HTTP requires empty input and key, preserves due time, and rechecks access on replay', async t => {
  const f = integrated(); t.after(() => f.db.close()); const sponsor = f.people[1]!;
  let currentActor = sponsor;
  const routes = createCommunityExtensionRoutes({ context: () => currentActor, serviceFor: () => f.module.extension });
  const motion = f.module.extension.createMotion(sponsor, f.group.id, { kind: 'friend', expectedRevision: 1 }, 'friend');
  const path = `/groups/${f.group.id}/motions/${motion.id}/finalize`;
  const send = (payload: unknown = {}, key: string | null = 'finalize', endpoint = path) => routes.request(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'idempotency-key': key }) }, body: JSON.stringify(payload),
  });
  assert.equal((await send()).status, 409);
  for (const person of f.people.filter(p => p !== sponsor)) f.module.extension.setBallot(person, f.group.id, motion.id, { expectedRevision: 0, choice: 'yes' }, randomUUID());
  f.clock.value = motion.expiresAt;
  for (const payload of [null, [], { state: 'passed' }, { expectedRevision: 1 }]) assert.equal((await send(payload)).status, 422);
  assert.equal((await send({}, null)).status, 400);
  assert.equal((await send({}, 'bad key')).status, 422);
  assert.equal((await send({}, 'id', `/groups/${f.group.id}/motions/invalid/finalize`)).status, 422);
  f.db.exec("CREATE TRIGGER synthetic_finalize_receipt_failure BEFORE INSERT ON community_extension_receipts WHEN NEW.operation='finalize_motion' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
  assert.equal((await send()).status, 503);
  assert.equal((f.db.prepare('SELECT state FROM community_motions WHERE id=?').get(motion.id) as { state: string }).state, 'open');
  assert.equal(f.db.prepare('SELECT 1 FROM community_seat_reservations WHERE motion_id=?').get(motion.id), undefined);
  f.db.exec('DROP TRIGGER synthetic_finalize_receipt_failure');
  const response = await send(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json() as { id: string; state: string }; assert.equal(result.id, motion.id); assert.equal(result.state, 'passed');
  assert.deepEqual(await (await send()).json(), result);
  assert.equal((f.db.prepare('SELECT count(*) n FROM community_seat_reservations WHERE motion_id=?').get(motion.id) as { n: number }).n, 1);
  const other = f.module.extension.createMotion(f.people[2]!, f.group.id, { kind: 'growth', places: 1, expectedRevision: 1 }, 'growth');
  assert.equal((await send({}, 'finalize', `/groups/${f.group.id}/motions/${other.id}/finalize`)).status, 409);
  currentActor = actor(f.db); assert.equal((await send()).status, 404);
  currentActor = sponsor; f.db.prepare("UPDATE community_members SET state='left',alias='',ended_at=? WHERE group_id=? AND account_id=?").run(f.clock.value, f.group.id, sponsor.accountId);
  assert.equal((await send()).status, 404);
});

test('friend reservation HTTP projects only current sponsor metadata and preserves stored state and expiry', async t => {
  const f = integrated(); t.after(() => f.db.close()); const reservation = passFriend(f);
  let currentActor = reservation.sponsor;
  const routes = createCommunityExtensionRoutes({ context: () => currentActor, serviceFor: () => f.module.extension });
  const path = `/groups/${f.group.id}/me/friend-reservations`;
  const rows = async () => { const response = await routes.request(path); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json(); };
  const motion = f.module.extension.listMotions(currentActor, f.group.id)[0]!;
  const expected = { id: reservation.id, motionId: motion.id, state: 'available', expiresAt: reservation.expires_at, invitationId: null as string | null };
  assert.deepEqual(await rows(), [expected]);
  currentActor = f.a; assert.deepEqual(await rows(), []);
  currentActor = actor(f.db); assert.equal((await routes.request(path)).status, 404);
  currentActor = reservation.sponsor;
  assert.equal((await routes.request(`/groups/${randomUUID()}/me/friend-reservations`)).status, 404);
  assert.equal((await routes.request('/groups/invalid/me/friend-reservations')).status, 422);
  const issued = f.module.community.issueFriendInvitation(currentActor, f.group.id, reservation.id, {}, 'issue');
  expected.invitationId = issued.id; assert.deepEqual(await rows(), [expected]);
  f.clock.value = reservation.expires_at; assert.deepEqual(await rows(), [expected]);
  for (const state of ['cancelled', 'consumed']) {
    f.db.prepare('UPDATE community_seat_reservations SET state=? WHERE id=?').run(state, reservation.id);
    assert.deepEqual(await rows(), [{ ...expected, state }]);
  }
  f.db.prepare("UPDATE community_motions SET kind='growth' WHERE id=?").run(motion.id); assert.deepEqual(await rows(), []);
  f.db.prepare("UPDATE community_motions SET kind='friend' WHERE id=?").run(motion.id);
  f.db.prepare('UPDATE community_members SET generation=generation+1 WHERE group_id=? AND account_id=?').run(f.group.id, currentActor.accountId);
  assert.deepEqual(await rows(), []);
  f.db.prepare('UPDATE community_members SET generation=generation-1 WHERE group_id=? AND account_id=?').run(f.group.id, currentActor.accountId);
  f.db.prepare('UPDATE community_groups SET generation=generation+1 WHERE id=?').run(f.group.id); assert.deepEqual(await rows(), []);
});

test('finalization command uses one lifecycle writer and terminal replay does not recalculate votes', t => {
  const f = integrated(); t.after(() => f.db.close()); const lifecycle = bindings(f.db);
  const extension = createCommunityExtension({ ...f.dependencies, lifecycle: { ...lifecycle, withActiveWrite: (context, effect) => {
    assert.equal(f.db.inTransaction, false); return lifecycle.withActiveWrite(context, effect);
  } } });
  const motion = extension.createMotion(f.a, f.group.id, { kind: 'friend', expectedRevision: 1 }, 'friend');
  f.clock.value = motion.expiresAt;
  const result = extension.finalizeMotionCommand(f.a, f.group.id, motion.id, {}, 'finalize'); assert.equal(result.state, 'expired');
  for (const person of f.people.slice(1)) f.db.prepare('INSERT INTO community_ballots VALUES(?,?,1,?,?)').run(motion.id, person.accountId, 'yes', f.clock.value);
  assert.deepEqual(extension.finalizeMotionCommand(f.a, f.group.id, motion.id, {}, 'finalize'), result);
  assert.equal(f.db.prepare('SELECT 1 FROM community_seat_reservations WHERE motion_id=?').get(motion.id), undefined);
});

test('own friend invitation metadata lets an ordinary sponsor reload the actual revision and revoke', async t => {
  const f = integrated(); t.after(() => f.db.close()); const reservation = passFriend(f);
  const issued = f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'issue');
  assert.throws(() => f.module.community.listInvitations(reservation.sponsor, f.group.id));
  f.db.prepare('UPDATE community_invitations SET revision=4 WHERE id=?').run(issued.id);
  const routes = createCommunityExtensionRoutes({ context: () => reservation.sponsor, serviceFor: () => f.module.extension });
  const path = `/groups/${f.group.id}/me/friend-reservations/${reservation.id}/invitation`;
  const response = await routes.request(path); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const metadata = await response.json() as { id: string; revision: number; state: string; expiresAt: string };
  assert.deepEqual(metadata, { id: issued.id, revision: 4, state: 'pending', expiresAt: issued.expiresAt });
  const revoked = f.module.community.revokeInvitation(reservation.sponsor, f.group.id, metadata.id, { expectedRevision: metadata.revision }, 'revoke');
  assert.equal(revoked.state, 'revoked');
  assert.deepEqual(f.module.extension.readFriendInvitation(reservation.sponsor, f.group.id, reservation.id),
    { id: issued.id, revision: 5, state: 'revoked', expiresAt: issued.expiresAt });
  assert.equal((await routes.request(`${path}?accountId=${f.a.accountId}`)).status, 422);
  assert.equal((await routes.request(`/groups/${f.group.id}/me/friend-reservations/invalid/invitation`)).status, 422);
  assert.equal((await routes.request(`/groups/invalid/me/friend-reservations/${reservation.id}/invitation`)).status, 422);
  assert.equal((await routes.request(path, { method: 'POST' })).status, 404);
});

test('friend invitation metadata requires exact actor group sponsor motion and issuer generations', t => {
  const f = integrated(); t.after(() => f.db.close()); const reservation = passFriend(f);
  assert.throws(() => f.module.extension.readFriendInvitation(reservation.sponsor, f.group.id, reservation.id), { code: 'community_not_found' });
  const issued = f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'issue');
  for (const viewer of [f.a, actor(f.db)]) assert.throws(() => f.module.extension.readFriendInvitation(viewer, f.group.id, reservation.id), { code: 'community_not_found' });
  assert.throws(() => f.module.extension.readFriendInvitation(reservation.sponsor, randomUUID(), reservation.id), { code: 'community_not_found' });
  const mutations = [
    "UPDATE community_groups SET generation=generation+1",
    "UPDATE community_groups SET state='closed',closed_at='2026-10-13T12:00:00.000Z'",
    "UPDATE community_members SET generation=generation+1",
    "UPDATE community_members SET state='left',alias='',ended_at='2026-10-13T12:00:00.000Z'",
    'UPDATE community_seat_reservations SET sponsor_generation=sponsor_generation+1',
    'UPDATE community_seat_reservations SET group_generation=group_generation+1',
    'UPDATE community_seat_reservations SET invitation_id=NULL',
    "UPDATE community_motions SET kind='growth'",
    'UPDATE community_motions SET sponsor_generation=sponsor_generation+1',
    'UPDATE community_motions SET group_generation=group_generation+1',
    `UPDATE community_motions SET sponsor_account_id='${f.a.accountId}'`,
    'UPDATE community_invitations SET issuer_membership_generation=issuer_membership_generation+1',
    'UPDATE community_invitations SET group_generation=group_generation+1',
    `UPDATE community_invitations SET issuer_account_id='${f.a.accountId}' WHERE id='${issued.id}'`,
  ];
  const rollback = new Error('synthetic rollback');
  for (const sql of mutations) {
    assert.throws(() => f.db.transaction(() => {
      f.db.exec(sql);
      assert.throws(() => f.module.extension.readFriendInvitation(reservation.sponsor, f.group.id, reservation.id), { code: 'community_not_found' });
      throw rollback;
    })(), error => error === rollback);
  }
  assert.equal(f.module.extension.readFriendInvitation(reservation.sponsor, f.group.id, reservation.id).id, issued.id);
});

test('friend invitation metadata projects expiry without mutating invitation or reservation history', t => {
  const f = integrated(); t.after(() => f.db.close()); const reservation = passFriend(f);
  const issued = f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'issue');
  const before = f.db.prepare('SELECT * FROM community_invitations WHERE id=?').get(issued.id);
  const reservationBefore = f.db.prepare('SELECT * FROM community_seat_reservations WHERE id=?').get(reservation.id);
  f.clock.value = issued.expiresAt;
  assert.deepEqual(f.module.extension.readFriendInvitation(reservation.sponsor, f.group.id, reservation.id),
    { id: issued.id, revision: issued.revision, state: 'expired', expiresAt: issued.expiresAt });
  assert.deepEqual(f.db.prepare('SELECT * FROM community_invitations WHERE id=?').get(issued.id), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM community_seat_reservations WHERE id=?').get(reservation.id), reservationBefore);
});

test('friend invitation metadata conceals redeemed targets after block eligibility loss or membership end', t => {
  const f = integrated(); t.after(() => f.db.close()); const reservation = passFriend(f);
  const issued = f.module.community.issueFriendInvitation(reservation.sponsor, f.group.id, reservation.id, {}, 'issue');
  assert.ok(issued.tokenAvailable); const friend = actor(f.db);
  f.module.community.joinInvitation(friend, { token: issued.token, alias: 'Synthetic friend', membershipDisclosureAccepted: true }, 'join');
  assert.equal(f.module.extension.readFriendInvitation(reservation.sponsor, f.group.id, reservation.id).state, 'redeemed');
  const rollback = new Error('synthetic rollback');
  for (const effect of [
    () => f.db.prepare('INSERT INTO community_blocks VALUES(?,?,?,1,1,?)').run(randomUUID(), friend.accountId, reservation.sponsor.accountId, f.clock.value),
    () => f.db.prepare('UPDATE synthetic_accounts SET age=NULL WHERE id=?').run(friend.accountId),
    () => f.db.prepare("UPDATE community_members SET state='left',alias='',ended_at=? WHERE account_id=?").run(f.clock.value, friend.accountId),
    () => f.db.prepare('UPDATE synthetic_accounts SET age=NULL WHERE id=?').run(reservation.sponsor.accountId),
  ]) assert.throws(() => f.db.transaction(() => {
    effect(); assert.throws(() => f.module.extension.readFriendInvitation(reservation.sponsor, f.group.id, reservation.id)); throw rollback;
  })(), error => error === rollback);
});


test('ordinary voted removal captures only the removed actor snapshot atomically and finalization replay cannot rename it', t => {
  const f = integrated(); t.after(() => f.db.close()); const { subject, motion } = passRemovalBallots(f);
  const before = f.module.community.readGroup(subject, f.group.id);
  assert.equal(f.module.extension.finalizeMotion(f.a, f.group.id, motion.id).state, 'passed');
  const expected = f.module.community.listRemovedMemberships(subject);
  assert.equal(expected.length, 1); assert.equal(expected[0]!.removedAt, f.clock.value);
  assert.deepEqual(expected[0]!.groupLabel, { status: 'available', value: before.name });
  assert.deepEqual(f.module.community.listRemovedMemberships(f.a), []);
  f.db.prepare('UPDATE community_groups SET display_name=? WHERE id=?').run('Later private name', f.group.id);
  f.clock.value = '2026-10-20T12:00:00.000Z';
  assert.equal(f.module.extension.finalizeMotion(f.a, f.group.id, motion.id).state, 'passed');
  assert.deepEqual(f.module.community.listRemovedMemberships(subject), expected);
  assert.equal(f.db.prepare('SELECT 1 FROM community_safety_notices').get(), undefined);
});
