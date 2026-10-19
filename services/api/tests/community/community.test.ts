import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { communityRemovalSnapshotsMigrationSql } from '../../src/community/removal-snapshots.js';
import { Hono } from 'hono';
import { DomainError } from '../../src/errors.js';
import { allFalse, createCommunityLifecycleAdapter, createCommunityRoutes, type ActivityCommunityReader, type ActivityCommunityDay } from '../../src/community/index.js';
import { fixture, service, actor, eligibility } from './fixture.js';

function error(run: () => unknown, status: number, code?: string): void {
  assert.throws(run, (e: unknown) => e instanceof DomainError && e.status === status && (code === undefined || e.code === code));
}
const day: ActivityCommunityDay = { localDate: '2026-10-02', timeZone: 'UTC', dayStartAt: '2026-10-02T00:00:00.000Z',
  dayEndAt: '2026-10-03T00:00:00.000Z', revision: 1, workout: 'recorded' };
const range = { from: '2026-10-01', to: '2026-10-03' };
function sharedFixture() {
  const f = fixture(); f.join(f.b); f.clock.value = '2026-10-04T12:00:00.000Z';
  f.clock.value = '2026-10-01T12:00:00.000Z';
  f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'share');
  f.clock.value = '2026-10-04T12:00:00.000Z'; return f;
}

test('community: private defaults, group-scoped IDs and strict ownership fields', () => {
  const f = fixture(); try {
    const joined = f.join(f.b);
    assert.deepEqual(f.community.readSharing(f.b, f.group.id).flags, allFalse());
    const second = f.community.createGroup(f.a, { name: 'Friends', alias: 'Other owner alias', membershipDisclosureAccepted: true }, 'second');
    const issued = f.community.issueInvitation(f.a, second.id, {}, 'second-invite'); assert.ok(issued.tokenAvailable);
    const other = f.community.joinInvitation(f.b, { token: issued.token, alias: 'Other alias', membershipDisclosureAccepted: true }, 'second-join');
    assert.notEqual(joined.memberId, other.memberId);
    assert.deepEqual(Object.keys(f.community.readGroup(f.b, f.group.id).members[0]!).sort(), ['alias', 'memberId', 'revision', 'role']);
    error(() => f.community.createGroup(f.a, { name: 'Bad', alias: 'Alias', membershipDisclosureAccepted: true, ownerAccountId: f.b.accountId }, 'bad'), 422);
    error(() => f.community.joinInvitation(f.c, { token: f.invite().token, alias: 'Alias', membershipDisclosureAccepted: true, role: 'owner' }, 'bad-join'), 422);
    error(() => f.community.readGroup(f.outsider, f.group.id), 404);
    error(() => f.community.removeMember(f.a, second.id, joined.memberId, { expectedRevision: 1 }, 'cross-target'), 404);
  } finally { f.db.close(); }
});

test('community: one-time invitation token is never persisted or recovered by replay', () => {
  const f = fixture(); try {
    const issued = f.community.issueInvitation(f.a, f.group.id, {}, 'issue'); assert.ok(issued.tokenAvailable);
    assert.equal(issued.token.length, 43); assert.equal(Buffer.from(issued.token, 'base64url').length, 32);
    const replay = f.community.issueInvitation(f.a, f.group.id, {}, 'issue'); assert.equal(replay.tokenAvailable, false); assert.equal('token' in replay, false);
    for (const table of ['community_groups', 'community_members', 'community_share_settings', 'community_invitations', 'community_command_receipts'])
      assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()).includes(issued.token), false);
    const preview = f.community.previewInvitation(f.b, { token: issued.token });
    assert.deepEqual(Object.keys(preview).sort(), ['expiresAt', 'membershipDisclosure', 'name']);
    assert.equal(JSON.stringify(f.community.listInvitations(f.a, f.group.id)).includes('token_hash'), false);
    error(() => f.community.joinInvitation(f.b, { token: issued.token, alias: issued.token, membershipDisclosureAccepted: true }, 'secret-alias'), 422);
    error(() => f.community.joinInvitation(f.b, { token: issued.token, alias: 'B', membershipDisclosureAccepted: true }, issued.token), 422);
    const joined = f.community.joinInvitation(f.b, { token: issued.token, alias: 'B', membershipDisclosureAccepted: true }, 'join');
    assert.deepEqual(f.community.joinInvitation(f.b, { token: issued.token, alias: 'B', membershipDisclosureAccepted: true }, 'join'), joined);
    error(() => f.community.joinInvitation(f.c, { token: issued.token, alias: 'C', membershipDisclosureAccepted: true }, 'other'), 404, 'community_invitation_unavailable');
    error(() => f.community.joinInvitation(f.b, { token: issued.token, alias: 'Changed', membershipDisclosureAccepted: true }, 'join'), 409, 'idempotency_conflict');
    f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.b.sessionId);
    error(() => f.community.joinInvitation(f.b, { token: issued.token, alias: 'B', membershipDisclosureAccepted: true }, 'join'), 401);
  } finally { f.db.close(); }
});

test('community: malformed, expired and revoked tokens share one concealed error', () => {
  const f = fixture(); try {
    const expired = f.invite(); f.clock.value = expired.expiresAt;
    const outcomes: unknown[] = [];
    for (const token of [expired.token, 'x', 'A'.repeat(42) + 'B', 'A'.repeat(44)]) {
      try { f.community.previewInvitation(f.b, { token }); } catch (e) { const d = e as DomainError; outcomes.push({ status: d.status, code: d.code, details: d.details }); }
    }
    assert.equal(outcomes.length, 4); for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
    const revoked = f.invite(); f.community.revokeInvitation(f.a, f.group.id, revoked.id, { expectedRevision: 1 }, 'revoke');
    error(() => f.community.previewInvitation(f.b, { token: revoked.token }), 404, 'community_invitation_unavailable');
    const replacement = f.community.replaceInvitation(f.a, f.group.id, revoked.id, { expectedRevision: 2 }, 'replace'); assert.ok(replacement.tokenAvailable);
    assert.equal(f.community.replaceInvitation(f.a, f.group.id, revoked.id, { expectedRevision: 2 }, 'replace').tokenAvailable, false);
    error(() => f.community.previewInvitation(f.b, { token: revoked.token }), 404);
  } finally { f.db.close(); }
});

test('community: current self-reported eligibility and missing lifecycle/subject bindings fail closed', () => {
  const f = fixture(); try {
    for (const age of [null, 13, 17, 121, 18.5]) {
      const person = actor(f.db, age);
      error(() => f.community.createGroup(person, { name: 'Denied', alias: 'Alias', membershipDisclosureAccepted: true }, randomUUID()), 403);
      error(() => f.community.joinInvitation(person, { token: f.invite().token, alias: 'Alias', membershipDisclosureAccepted: true }, randomUUID()), 403);
    }
    f.join(f.b);
    f.db.prepare('UPDATE synthetic_accounts SET age=17,profile_revision=2 WHERE id=?').run(f.b.accountId);
    error(() => f.community.readGroup(f.b, f.group.id), 403);
    error(() => f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'denied-share'), 403);
    assert.deepEqual(f.community.withdraw(f.b, f.group.id, {}, 'withdraw'), { withdrawn: true });
    assert.deepEqual(f.community.leave(f.b, f.group.id, {}, 'leave'), { left: true });
    error(() => service(f.db, f.now, { lifecycle: undefined }).listGroups(f.a), 503);
    const unavailable = service(f.db, f.now, { subjectEligibility: undefined });
    assert.equal(unavailable.readGroup(f.a, f.group.id).members.length, 1);
    f.db.prepare("UPDATE synthetic_accounts SET state='disabled',epoch=1 WHERE id=?").run(f.a.accountId);
    error(() => f.community.createGroup(f.a, { name: 'Replay', alias: 'Alias', membershipDisclosureAccepted: true }, 'create'), 403);
  } finally { f.db.close(); }
});

test('community: hierarchy, demotion, closure and removal cannot reopen old capabilities', () => {
  const f = fixture(); try {
    const b = f.join(f.b); const c = f.join(f.c);
    error(() => f.community.issueInvitation(f.b, f.group.id, {}, 'member-invite'), 404);
    f.community.updateRole(f.a, f.group.id, b.memberId, { expectedRevision: 1, role: 'admin' }, 'promote');
    const issued = f.community.issueInvitation(f.b, f.group.id, {}, 'admin-invite'); assert.ok(issued.tokenAvailable);
    error(() => f.community.updateRole(f.b, f.group.id, c.memberId, { expectedRevision: 1, role: 'admin' }, 'forbidden-promote'), 404);
    error(() => f.community.removeMember(f.b, f.group.id, f.group.memberId, { expectedRevision: 1 }, 'forbidden-remove-owner'), 404);
    f.community.updateRole(f.a, f.group.id, b.memberId, { expectedRevision: 2, role: 'member' }, 'demote');
    error(() => f.community.previewInvitation(f.outsider, { token: issued.token }), 404);
    f.community.removeMember(f.a, f.group.id, c.memberId, { expectedRevision: 1 }, 'remove');
    const pending = f.invite(); error(() => f.community.joinInvitation(f.c, { token: pending.token, alias: 'C', membershipDisclosureAccepted: true }, 'removed'), 404);
    f.community.allowReinvite(f.a, f.group.id, c.memberId, { expectedRevision: 2 }, 'allow');
    assert.equal(f.community.readGroup(f.a, f.group.id).members.some(m => m.memberId === c.memberId), false);
    const rejoined = f.community.joinInvitation(f.c, { token: pending.token, alias: 'C again', membershipDisclosureAccepted: true }, 'rejoin');
    assert.notEqual(rejoined.memberId, c.memberId); assert.deepEqual(f.community.readSharing(f.c, f.group.id).flags, allFalse());
    error(() => f.community.leave(f.a, f.group.id, {}, 'owner-leave'), 409, 'community_owner_must_close');
    const last = f.invite(); f.community.closeGroup(f.a, f.group.id, { expectedRevision: 1 }, 'close');
    assert.deepEqual(f.community.closeGroup(f.a, f.group.id, { expectedRevision: 1 }, 'close'), { closed: true });
    error(() => f.community.previewInvitation(f.outsider, { token: last.token }), 404);
    error(() => f.community.readGroup(f.b, f.group.id), 404);
    error(() => f.community.issueInvitation(f.b, f.group.id, {}, 'admin-invite'), 404);
  } finally { f.db.close(); }
});

test('community: stale sharing and receipt replay never re-enable after withdrawal or rejoin', () => {
  const f = fixture(); try {
    const invitation = f.invite(); const input = { token: invitation.token, alias: 'B', membershipDisclosureAccepted: true };
    f.community.joinInvitation(f.b, input, 'join');
    const flags = { ...allFalse(), workout: true, workoutMinutes: true };
    const enabled = f.community.updateSharing(f.b, f.group.id, { flags, expectedRevision: 1 }, 'share'); assert.equal(enabled.revision, 2);
    f.community.withdraw(f.b, f.group.id, {}, 'withdraw');
    assert.deepEqual(f.community.updateSharing(f.b, f.group.id, { flags, expectedRevision: 1 }, 'share').flags, allFalse());
    error(() => f.community.updateSharing(f.b, f.group.id, { flags, expectedRevision: 2 }, 'late'), 409, 'stale_revision');
    const withdrawnRevision = f.community.readSharing(f.b, f.group.id).revision;
    f.community.withdraw(f.b, f.group.id, {}, 'withdraw'); assert.equal(f.community.readSharing(f.b, f.group.id).revision, withdrawnRevision);
    f.community.leave(f.b, f.group.id, {}, 'leave');
    error(() => f.community.joinInvitation(f.b, input, 'join'), 404);
    const rejoined = f.join(f.b);
    error(() => f.community.updateSharing(f.b, f.group.id, { flags, expectedRevision: 1 }, 'share'), 404);
    error(() => f.community.leave(f.b, f.group.id, {}, 'leave'), 409);
    error(() => f.community.withdraw(f.b, f.group.id, {}, 'withdraw'), 409);
    assert.notEqual(rejoined.memberId, f.group.memberId); assert.deepEqual(f.community.readSharing(f.b, f.group.id).flags, allFalse());
  } finally { f.db.close(); }
});

test('community: parent flags enforce selected details and preserve independent start times', () => {
  const f = fixture(); try {
    f.join(f.b);
    error(() => f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workoutMinutes: true } }, 'bad-child'), 422);
    const first = f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'base');
    f.clock.value = '2026-10-02T12:00:00.000Z';
    const detailed = f.community.updateSharing(f.b, f.group.id, { expectedRevision: first.revision, flags: { ...first.flags, workoutMinutes: true } }, 'detail');
    assert.notEqual(detailed.enabledAt.workout, detailed.enabledAt.workoutMinutes);
    const off = f.community.updateSharing(f.b, f.group.id, { expectedRevision: detailed.revision, flags: { ...detailed.flags, workout: false } }, 'off');
    assert.equal(off.flags.workoutMinutes, false); assert.equal(off.enabledAt.workoutMinutes, undefined);
  } finally { f.db.close(); }
});

test('community: projection authorizes before adapter, requests only selected fields and constructs fresh output', () => {
  const f = sharedFixture(); try {
    let calls = 0;
    const activity: ActivityCommunityReader = { readDays: input => { calls++; assert.equal(input.subjectAccountId, f.b.accountId); assert.deepEqual(input.fields, ['workout']); return { status: 'available', days: [day] }; } };
    const reader = service(f.db, f.now, { activity });
    error(() => reader.readSummary(f.outsider, f.group.id, range), 404); assert.equal(calls, 0);
    const summary = reader.readSummary(f.a, f.group.id, range); assert.equal(summary.summaryStatus, 'available');
    const b = summary.members.find(m => m.memberId !== f.group.memberId)!;
    assert.deepEqual(b.days, [{ localDate: '2026-10-02', workout: 'recorded' }]);
    assert.equal(JSON.stringify(summary).includes(f.b.accountId), false);
    assert.equal(JSON.stringify(summary).includes('timeZone'), false);
    f.community.withdraw(f.b, f.group.id, {}, 'stop');
    assert.equal(reader.readSummary(f.a, f.group.id, range).members.find(m => m.memberId === b.memberId)!.days.length, 0);
    assert.equal(calls, 1);
  } finally { f.db.close(); }
});

test('community: absent/unavailable/async/malformed or overbroad activity fails closed', () => {
  const f = sharedFixture(); try {
    assert.equal(f.community.readSummary(f.a, f.group.id, range).summaryStatus, 'unavailable');
    const bad: unknown[] = [
      { status: 'unavailable', rawWorkout: 'NO_SAVE_SENTINEL' },
      { status: 'available', days: [{ ...day, coach: 'NO_SAVE_SENTINEL' }] },
      { status: 'available', days: [{ ...day, exerciseSnack: 'recorded' }] },
      { status: 'available', days: [{ ...day, workout: undefined }] },
      { status: 'available', days: [{ ...day, dayEndAt: day.dayStartAt }] },
      { status: 'available', days: [{ ...day, timeZone: 'Invalid/Zone' }] },
      { status: 'available', days: [day, day] },
      { status: 'available', days: [{ ...day, localDate: '2026-02-30' }] },
      Promise.resolve({ status: 'available', days: [day] }),
    ];
    for (const result of bad) {
      const reader = service(f.db, f.now, { activity: { readDays: () => result } as ActivityCommunityReader });
      assert.deepEqual(reader.readSummary(f.a, f.group.id, range), { summaryStatus: 'unavailable', members: [] });
    }
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM community_command_receipts').all()).includes('NO_SAVE_SENTINEL'), false);
    error(() => f.community.readSummary(f.a, f.group.id, { from: '2026-01-01', to: '2026-02-01' }), 422);
  } finally { f.db.close(); }
});

test('community: subject/viewer join and per-field enablement exclude pre-consent days; corrections are fresh', () => {
  const f = sharedFixture(); try {
    let verdict: 'recorded' | 'not_recorded' = 'recorded';
    const reader = service(f.db, f.now, { activity: { readDays: () => ({ status: 'available', days: [
      { ...day, localDate: '2026-10-01', dayStartAt: '2026-10-01T00:00:00.000Z', dayEndAt: '2026-10-02T00:00:00.000Z' },
      { ...day, workout: verdict },
    ] }) } });
    assert.equal(reader.readSummary(f.a, f.group.id, range).members.find(m => m.memberId !== f.group.memberId)!.days.length, 1);
    verdict = 'not_recorded';
    assert.equal(reader.readSummary(f.a, f.group.id, range).members.find(m => m.memberId !== f.group.memberId)!.days[0]!.workout, 'not_recorded');
    f.clock.value = '2026-10-02T12:00:00.000Z'; const c = f.join(f.c); f.clock.value = '2026-10-04T12:00:00.000Z';
    assert.equal(reader.readSummary(f.c, f.group.id, range).members.find(m => m.memberId !== f.group.memberId && m.memberId !== c.memberId)!.days.length, 0);
    f.community.withdraw(f.b, f.group.id, {}, 'withdraw');
    f.community.updateSharing(f.b, f.group.id, { expectedRevision: 3, flags: { ...allFalse(), workout: true } }, 'reenable');
    assert.equal(reader.readSummary(f.a, f.group.id, range).members.find(m => m.memberId !== f.group.memberId && m.memberId !== c.memberId)!.days.length, 0);
  } finally { f.db.close(); }
});

test('community: participation unknown and allowed streak aggregate do not disclose private history', () => {
  const f = fixture(); try {
    const b = f.join(f.b); f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1,
      flags: { ...allFalse(), participation: true, planAdherence: true, streakDays: true } }, 'share');
    f.clock.value = '2026-10-04T00:00:00.000Z';
    const reader = service(f.db, f.now, { activity: { readDays: input => {
      assert.deepEqual([...input.fields].sort(), ['exerciseSnack', 'planAdherence', 'streakDays', 'workout']);
      return { status: 'available', days: [{ ...day, workout: 'not_recorded', exerciseSnack: 'unknown', planAdherence: 'pending', streakDays: 8 }] };
    } } });
    assert.deepEqual(reader.readSummary(f.a, f.group.id, range).members.find(m => m.memberId === b.memberId)!.days,
      [{ localDate: '2026-10-02', participation: 'unknown', planAdherence: 'pending', streakDays: 8 }]);
  } finally { f.db.close(); }
});

test('community: withdrawal/removal during synchronous adapter read discards late result', () => {
  const f = sharedFixture(); try {
    const reader = service(f.db, f.now, { activity: { readDays: () => {
      f.community.withdraw(f.b, f.group.id, {}, 'race-withdraw'); return { status: 'available', days: [day] };
    } } });
    assert.deepEqual(reader.readSummary(f.a, f.group.id, range), { summaryStatus: 'unavailable', members: [] });
  } finally { f.db.close(); }
});

test('community: lifecycle suppress, bounded own export, purge and restore hooks preserve independent groups', () => {
  const f = sharedFixture(); try {
    const group2 = f.community.createGroup(f.b, { name: 'Independent', alias: 'B owner', membershipDisclosureAccepted: true }, 'independent');
    const invite = f.community.issueInvitation(f.b, group2.id, {}, 'independent-invite'); assert.ok(invite.tokenAvailable);
    const c = f.community.joinInvitation(f.c, { token: invite.token, alias: 'C private alias', membershipDisclosureAccepted: true }, 'independent-join');
    const adapter = createCommunityLifecycleAdapter(f.community);
    const exported: unknown[] = [];
    f.db.transaction(() => {
      assert.equal(adapter.inventory(f.a).status, 'complete');
      assert.equal(adapter.export(f.a, { snapshotAtMs: 0, append: (_category, value) => exported.push(value) }).status, 'complete');
      assert.equal(adapter.suppress(f.a.accountId, 1).status, 'complete');
      assert.equal(adapter.verifySuppressed(f.a.accountId, 1).status, 'complete');
      assert.equal(adapter.purge(randomUUID(), f.a.accountId).status, 'pending');
    }).immediate();
    assert.equal(JSON.stringify(exported).includes(f.b.accountId), false); assert.equal(JSON.stringify(exported).includes('token_hash'), false);
    assert.equal(f.community.readGroup(f.c, group2.id).members.some(m => m.memberId === c.memberId), true);
    f.db.transaction(() => {
      const qualified = createCommunityLifecycleAdapter(f.community, { purgeQualified: true });
      assert.equal(qualified.purge(randomUUID(), f.a.accountId).status, 'complete');
      assert.equal(qualified.purge(randomUUID(), f.a.accountId).status, 'complete');
    }).immediate();
    assert.equal(f.community.readGroup(f.c, group2.id).members.length, 2);
    const outstanding = f.community.issueInvitation(f.b, group2.id, {}, 'restored-invite'); assert.ok(outstanding.tokenAvailable);
    f.community.updateSharing(f.b, group2.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'restored-share');
    f.db.transaction(() => f.community.reconcileCommunityRestore({ ready: true, lookup: id => ({ state: id === f.a.accountId ? 'suppressed' : 'active', epoch: 0 }) })).immediate();
    assert.deepEqual(f.community.readSharing(f.b, group2.id).flags, allFalse());
    error(() => f.community.previewInvitation(f.outsider, { token: outstanding.token }), 404);
    f.db.transaction(() => error(() => f.community.reconcileCommunityRestore({ ready: true, lookup: () => undefined }), 503)).immediate();
    error(() => f.community.suppressAccountCommunity(f.b.accountId, 1), 503);
  } finally { f.db.close(); }
});

test('community: quotas and bounded capacities do not block withdrawal', () => {
  const f = fixture(); try {
    f.join(f.b);
    const limited = service(f.db, f.now, { assertRateLimit: () => { throw new DomainError(429, 'limited'); } });
    error(() => limited.issueInvitation(f.a, f.group.id, {}, 'limited'), 429);
    assert.deepEqual(limited.withdraw(f.b, f.group.id, {}, 'safe'), { withdrawn: true });
    for (let i = 0; i < 20; i++) f.community.issueInvitation(f.a, f.group.id, {}, `bounded-${i}`);
    error(() => f.community.issueInvitation(f.a, f.group.id, {}, 'overflow'), 409, 'community_invitation_capacity');
    for (let i = 1; i < 20; i++) f.community.createGroup(f.a, { name: `Group ${i}`, alias: 'Owner', membershipDisclosureAccepted: true }, `group-${i}`);
    error(() => f.community.createGroup(f.a, { name: 'Overflow', alias: 'Owner', membershipDisclosureAccepted: true }, 'group-overflow'), 409, 'community_account_capacity');
  } finally { f.db.close(); }
});

test('community: real request adapter limits JSON, derives trusted context and conceals errors', async () => {
  const f = fixture(); try {
    const app = new Hono(); app.route('/v1/community', createCommunityRoutes({ service: f.community, context: () => f.a }));
    const post = (path: string, input: unknown, key = 'http') => app.request(`/v1/community${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(input) });
    const denied = await post('/groups', { name: 'Bad', alias: 'Alias', membershipDisclosureAccepted: true, accountId: f.b.accountId });
    assert.equal(denied.status, 422); assert.equal(denied.headers.get('cache-control'), 'no-store');
    const large = await post('/invitations/preview', { token: 'NO_SAVE_SENTINEL'.repeat(1000) }); assert.equal(large.status, 413);
    const bad = await post('/invitations/preview', { token: 'invalid' }); assert.equal(bad.status, 404);
    assert.deepEqual(await bad.json(), { error: { code: 'community_invitation_unavailable' } });
    const created = await post('/groups', { name: 'HTTP group', alias: 'HTTP alias', membershipDisclosureAccepted: true }, 'http-create'); assert.equal(created.status, 201);
    const json = await created.json() as { id: string };
    const read = await app.request(`/v1/community/groups/${json.id}`); assert.equal(read.status, 200);
    const duplicateRange = await app.request(`/v1/community/groups/${f.group.id}/summary?from=2026-10-01&from=2026-10-02&to=2026-10-03`); assert.equal(duplicateRange.status, 422);
  } finally { f.db.close(); }
});

test('community: duplicate active join consumes exactly one invitation without resetting sharing', () => {
  const f = fixture(); try {
    const b = f.join(f.b); f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'share');
    const invite = f.invite();
    const input = { token: invite.token, alias: 'Would replace alias', membershipDisclosureAccepted: true };
    assert.equal(f.community.joinInvitation(f.b, input, 'duplicate-member').memberId, b.memberId);
    assert.equal(f.community.readSharing(f.b, f.group.id).flags.workout, true);
    assert.equal(f.community.readGroup(f.a, f.group.id).members.find(m => m.memberId === b.memberId)!.alias, 'Synthetic member');
    error(() => f.community.joinInvitation(f.c, { token: invite.token, alias: 'C', membershipDisclosureAccepted: true }, 'used'), 404);
    error(() => f.community.joinInvitation(f.b, { ...input, alias: 'Different' }, 'duplicate-member'), 409);
  } finally { f.db.close(); }
});

test('community: group member capacity and unknown subject do not leak an unauthorized projection', () => {
  const f = fixture(); try {
    for (let i = 1; i < 50; i++) f.join(actor(f.db), `Member ${i}`);
    error(() => f.join(f.b), 409, 'community_group_capacity');
    assert.equal(f.community.readGroup(f.a, f.group.id).members.length, 50);
    const reader = service(f.db, f.now, { subjectEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'unknown', profileRevision: null }),
      activity: { readDays: () => { throw new Error('Unknown subject must not be read'); } } });
    assert.equal(reader.readSummary(f.a, f.group.id, range).members.length, 1);
  } finally { f.db.close(); }
});

test('community: cross-group withdrawal leaves other group disclosure selected', () => {
  const f = fixture(); try {
    f.join(f.b);
    const group2 = f.community.createGroup(f.b, { name: 'Private independent', alias: 'Owner B', membershipDisclosureAccepted: true }, 'b-group');
    for (const groupId of [f.group.id, group2.id]) f.community.updateSharing(f.b, groupId, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, `share-${groupId}`);
    f.community.withdraw(f.b, f.group.id, {}, 'withdraw-one');
    assert.deepEqual(f.community.readSharing(f.b, f.group.id).flags, allFalse());
    assert.equal(f.community.readSharing(f.b, group2.id).flags.workout, true);
  } finally { f.db.close(); }
});

test('community: recorded DST day boundaries are validated without inferring viewer timezone', () => {
  const f = fixture(); try {
    f.clock.value = '2026-10-31T12:00:00.000Z'; const b = f.join(f.b);
    f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'share-dst');
    f.clock.value = '2026-11-03T12:00:00.000Z';
    const reader = service(f.db, f.now, { activity: { readDays: () => ({ status: 'available', days: [{ ...day,
      localDate: '2026-11-01', timeZone: 'America/New_York', dayStartAt: '2026-11-01T04:00:00.000Z', dayEndAt: '2026-11-02T05:00:00.000Z' }] }) } });
    assert.deepEqual(reader.readSummary(f.a, f.group.id, { from: '2026-11-01', to: '2026-11-01' }).members.find(m => m.memberId === b.memberId)!.days,
      [{ localDate: '2026-11-01', workout: 'recorded' }]);
  } finally { f.db.close(); }
});

test('community: forged session context, changed epoch and revoked session deny cached receipts', () => {
  const f = fixture(); try {
    error(() => f.community.listGroups({ ...f.a, accountId: f.b.accountId }), 401);
    error(() => f.community.listGroups({ ...f.a, epoch: 1 }), 403);
    f.community.issueInvitation(f.a, f.group.id, {}, 'cached-invite');
    f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.a.sessionId);
    error(() => f.community.issueInvitation(f.a, f.group.id, {}, 'cached-invite'), 401);
    error(() => f.community.withdraw(f.a, f.group.id, {}, 'revoked-withdraw'), 401);
  } finally { f.db.close(); }
});

test('community: malformed retained settings are denied and SQLite checks enforce private state', () => {
  const f = fixture(); try {
    f.join(f.b);
    assert.throws(() => f.db.prepare('UPDATE community_share_settings SET workoutMinutes=1 WHERE group_id=? AND account_id=?').run(f.group.id, f.b.accountId));
    assert.throws(() => f.db.prepare('UPDATE community_share_settings SET workout=1 WHERE group_id=? AND account_id=?').run(f.group.id, f.b.accountId));
    f.db.pragma('ignore_check_constraints=ON');
    f.db.prepare('UPDATE community_share_settings SET workout=2 WHERE group_id=? AND account_id=?').run(f.group.id, f.b.accountId);
    error(() => f.community.readSharing(f.b, f.group.id), 503, 'community_integrity_unavailable');
  } finally { f.db.close(); }
});

test('community: authoritative suppression during projection denies release and future receipt replay', () => {
  const f = sharedFixture(); try {
    const base = service(f.db, f.now); let suppressed = false;
    const canonical = { assertActive: (context: typeof f.a) => {
      if (suppressed && context.accountId === f.a.accountId) throw new DomainError(403, 'suppressed');
    }, withActiveWrite: <T>(context: typeof f.a, effect: () => T): T => f.db.transaction(() => {
      canonical.assertActive(context); const result = effect(); canonical.assertActive(context); return result;
    }).immediate(), adultEligibility: (context: typeof f.a) => eligibility(f.db, context.accountId) };
    const reader = service(f.db, f.now, { lifecycle: canonical, activity: { readDays: () => {
      suppressed = true; return { status: 'available', days: [day] };
    } } });
    error(() => reader.readSummary(f.a, f.group.id, range), 403);
    error(() => reader.createGroup(f.a, { name: 'Synthetic family', alias: 'Owner', membershipDisclosureAccepted: true }, 'create'), 403);
    assert.equal(base.readSharing(f.b, f.group.id).flags.workout, true);
  } finally { f.db.close(); }
});


test('community: own removal snapshot keeps the visible label and actual event time across rename replay and closure', t => {
  const f = fixture(); t.after(() => f.db.close()); const joined = f.join(f.b); f.join(f.c);
  f.clock.value = '2026-10-02T12:00:00.000Z';
  f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 1 }, 'remove');
  const expected = [{ groupId: f.group.id, memberId: joined.memberId, membershipGeneration: 2, removedAt: f.clock.value,
    groupLabel: { status: 'available', value: 'Synthetic family' } }];
  assert.deepEqual(f.community.listRemovedMemberships(f.b), expected);
  assert.deepEqual(f.community.listRemovedMemberships(f.a), []); assert.deepEqual(f.community.listRemovedMemberships(f.c), []);
  f.community.renameGroup(f.a, f.group.id, { name: 'Later private name', expectedRevision: 1 }, 'rename');
  f.clock.value = '2026-10-03T12:00:00.000Z';
  f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 1 }, 'remove');
  f.community.closeGroup(f.a, f.group.id, { expectedRevision: 2 }, 'close');
  assert.deepEqual(f.community.listRemovedMemberships(f.b), expected);
  assert.deepEqual(f.community.listRemovedMemberships(f.c), []);
});

test('community: removing a former member preserves leave history and captures a distinct removal time without a label', t => {
  const f = fixture(); t.after(() => f.db.close()); const joined = f.join(f.b), leftAt = f.clock.value;
  f.community.leave(f.b, f.group.id, {}, 'leave'); assert.deepEqual(f.community.listRemovedMemberships(f.b), []);
  f.community.renameGroup(f.a, f.group.id, { name: 'Never visible after leave', expectedRevision: 1 }, 'rename');
  f.clock.value = '2026-10-04T12:00:00.000Z';
  f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 2 }, 'remove-left');
  assert.deepEqual(f.db.prepare('SELECT ended_at FROM community_members WHERE group_id=? AND account_id=?').get(f.group.id, f.b.accountId), { ended_at: leftAt });
  const expected = [{ groupId: f.group.id, memberId: joined.memberId, membershipGeneration: 3, removedAt: f.clock.value, groupLabel: { status: 'unavailable' } }];
  assert.deepEqual(f.community.listRemovedMemberships(f.b), expected);
  f.clock.value = '2026-10-05T12:00:00.000Z';
  f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 2 }, 'remove-left');
  assert.deepEqual(f.community.listRemovedMemberships(f.b), expected);
});

test('community: additive snapshot fragment does not backfill uncertain historical labels or removal times', t => {
  const f = fixture(); t.after(() => f.db.close()); const joined = f.join(f.b);
  f.db.exec('DROP TRIGGER community_removal_snapshot_membership_changed; DROP TABLE community_removal_snapshots;');
  f.db.prepare("UPDATE community_members SET state='removed',alias='',ended_at=? WHERE group_id=? AND account_id=?").run(f.clock.value, f.group.id, f.b.accountId);
  f.db.exec(communityRemovalSnapshotsMigrationSql);
  assert.deepEqual(f.community.listRemovedMemberships(f.b), [{ groupId: f.group.id, memberId: joined.memberId, membershipGeneration: 1,
    removedAt: null, groupLabel: { status: 'unavailable' } }]);
  assert.equal(f.db.prepare('SELECT 1 FROM community_removal_snapshots').get(), undefined);
});

test('community: removal snapshots are invalidated by membership lineage changes and reinvitation never shows an old removal', t => {
  for (const change of ['generation=generation+1', "member_id='11111111-1111-4111-8111-111111111111'", "ended_at='2026-10-02T00:00:00.000Z'"]) {
    const f = fixture(); t.after(() => f.db.close()); const joined = f.join(f.b);
    f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 1 }, 'remove');
    f.db.prepare(`UPDATE community_members SET ${change} WHERE group_id=? AND account_id=?`).run(f.group.id, f.b.accountId);
    assert.equal(f.db.prepare('SELECT 1 FROM community_removal_snapshots').get(), undefined);
    assert.equal(f.community.listRemovedMemberships(f.b)[0]!.removedAt, null);
    assert.deepEqual(f.community.listRemovedMemberships(f.b)[0]!.groupLabel, { status: 'unavailable' });
  }
  const f = fixture(); t.after(() => f.db.close()); const joined = f.join(f.b);
  f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 1 }, 'remove');
  f.community.allowReinvite(f.a, f.group.id, joined.memberId, { expectedRevision: 2 }, 'allow');
  assert.deepEqual(f.community.listRemovedMemberships(f.b), []); f.join(f.b);
  assert.deepEqual(f.community.listRemovedMemberships(f.b), []);
  assert.equal(f.db.prepare('SELECT 1 FROM community_removal_snapshots').get(), undefined);
});

test('community: direct removal snapshot failure rolls back membership sharing and receipt atomically', t => {
  const f = fixture(); t.after(() => f.db.close()); const joined = f.join(f.b);
  f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'share');
  f.db.exec("CREATE TRIGGER synthetic_snapshot_failure BEFORE INSERT ON community_removal_snapshots BEGIN SELECT RAISE(ABORT, 'snapshot failure'); END");
  assert.throws(() => f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 1 }, 'remove'), /snapshot failure/);
  assert.equal(f.community.readGroup(f.b, f.group.id).members.length, 2);
  assert.equal(f.community.readSharing(f.b, f.group.id).flags.workout, true);
  assert.deepEqual(f.community.listRemovedMemberships(f.b), []);
  f.db.exec('DROP TRIGGER synthetic_snapshot_failure');
  f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 1 }, 'remove');
  assert.equal(f.community.listRemovedMemberships(f.b).length, 1);
});

test('community: own removal HTTP read is actor-bound query-strict and rechecks current account state', async t => {
  const f = fixture(); t.after(() => f.db.close()); const joined = f.join(f.b);
  f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 1 }, 'remove');
  let current = f.b; const app = new Hono(); app.route('/v1/community', createCommunityRoutes({ service: f.community, context: () => current }));
  const url = '/v1/community/me/removed-memberships';
  const read = await app.request(url); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await read.json(), f.community.listRemovedMemberships(f.b));
  assert.equal((await app.request(url + '?accountId=' + f.a.accountId)).status, 422);
  current = f.c; assert.deepEqual(await (await app.request(url)).json(), []);
  current = f.b; f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.b.sessionId);
  assert.equal((await app.request(url)).status, 401);
});

test('community: removal snapshot export suppression restore and purge preserve only current own metadata', t => {
  const f = fixture(); t.after(() => f.db.close()); const joined = f.join(f.b);
  f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 1 }, 'remove');
  const rows: unknown[] = []; const otherRows: unknown[] = [];
  f.db.transaction(() => {
    f.community.exportAccount(f.b, (_, value) => rows.push(value)); f.community.exportAccount(f.c, (_, value) => otherRows.push(value));
  }).immediate();
  const exported = rows.filter(row => (row as { kind: string }).kind === 'own_removal_snapshot');
  assert.equal(exported.length, 1); assert.equal(JSON.stringify(exported).includes('Synthetic family'), true);
  assert.equal(JSON.stringify(exported).includes(f.a.accountId), false); assert.deepEqual(otherRows, []);
  const before = f.community.listRemovedMemberships(f.b);
  f.db.transaction(() => f.community.reconcileCommunityRestore({ ready: true, lookup: () => ({ state: 'active', epoch: 0 }) })).immediate();
  assert.deepEqual(f.community.listRemovedMemberships(f.b), before);
  f.db.transaction(() => f.community.reconcileCommunityRestore({ ready: true, lookup: id => ({ state: id === f.b.accountId ? 'suppressed' : 'active', epoch: 0 }) })).immediate();
  assert.equal(f.db.prepare('SELECT 1 FROM community_removal_snapshots WHERE account_id=?').get(f.b.accountId), undefined);
  f.db.transaction(() => {
    assert.equal(f.community.verifySuppressed(f.b.accountId, 0), true);
    f.community.purgeAccountCommunity(randomUUID(), f.b.accountId);
  }).immediate();
  assert.deepEqual(f.community.listRemovedMemberships(f.b), []);
});

test('community: removal snapshot foreign key cascades with its canonical membership', t => {
  const f = fixture(); t.after(() => f.db.close()); const joined = f.join(f.b);
  f.community.removeMember(f.a, f.group.id, joined.memberId, { expectedRevision: 1 }, 'remove');
  f.db.pragma('foreign_keys = ON');
  f.db.prepare('DELETE FROM community_members WHERE group_id=? AND account_id=?').run(f.group.id, f.b.accountId);
  assert.equal(f.db.prepare('SELECT 1 FROM community_removal_snapshots').get(), undefined);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});
