import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrustedActivityCommunityContext } from '../../src/activity/types.js';
import { allFalse, createCommunityRoutes, type CommunityActivityAuthorization, type CommunityActivityReadInput } from '../../src/community/index.js';
import { fixture, service, eligibility } from './fixture.js';

const range = { from: '2026-10-02', to: '2026-10-03' };
function streamRequest(path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string>): Request {
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, headers, duplex: 'half' };
  return new Request(`http://synthetic.test${path}`, init);
}
function sharingFixture() {
  const f = fixture(); f.join(f.b);
  f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'share');
  return f;
}

test('community proof: exact actor/group/subject/range/fields and expired lease', () => {
  const f = sharingFixture(); try {
    const input: CommunityActivityReadInput = { subjectAccountId: f.b.accountId, ...range, fields: ['workout'] };
    let captured: CommunityActivityAuthorization | undefined;
    f.community.withActivityAuthorization(f.a, f.group.id, input, proof => {
      const compatible: TrustedActivityCommunityContext = proof;
      captured = compatible;
      assert.deepEqual(Object.keys(proof).sort(), ['assertAuthorized', 'assertSubjectActive', 'subjectAccountId']);
      proof.assertAuthorized(input); proof.assertSubjectActive();
      assert.throws(() => proof.assertAuthorized({ ...input, subjectAccountId: f.c.accountId }));
      assert.throws(() => proof.assertAuthorized({ ...input, from: '2026-10-01' }));
      assert.throws(() => proof.assertAuthorized({ ...input, fields: ['workout', 'exerciseCount'] }));
    });
    const expired = captured;
    assert.ok(expired); assert.throws(() => expired.assertAuthorized(input));
    f.db.transaction(() => assert.throws(() => expired.assertSubjectActive()))();
    assert.throws(() => f.community.withActivityAuthorization(f.outsider, f.group.id, input, () => null));
    assert.throws(() => f.community.withActivityAuthorization(f.a, f.group.id, { ...input, subjectAccountId: f.c.accountId }, () => null));
    const other = f.community.createGroup(f.a, { name: 'Other', alias: 'Other', membershipDisclosureAccepted: true }, 'other');
    assert.throws(() => f.community.withActivityAuthorization(f.a, other.id, input, () => null));
  } finally { f.db.close(); }
});

test('community proof: participation permits only the three base signals', () => {
  const f = fixture(); try {
    f.join(f.b);
    f.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), participation: true } }, 'share');
    const input: CommunityActivityReadInput = { subjectAccountId: f.b.accountId, ...range, fields: ['workout', 'exerciseSnack', 'planAdherence'] };
    f.community.withActivityAuthorization(f.a, f.group.id, input, proof => proof.assertAuthorized(input));
    for (const field of ['workoutMinutes', 'exerciseCount', 'streakDays'] as const)
      assert.throws(() => f.community.withActivityAuthorization(f.a, f.group.id, { ...input, fields: [field] }, () => null));
    assert.throws(() => f.community.withActivityAuthorization(f.a, f.group.id, { ...input, fields: ['workout', 'workout'] }, () => null));
  } finally { f.db.close(); }
});

test('community proof: missing canonical subject provider denies even self', () => {
  const f = sharingFixture(); try {
    const absent = service(f.db, f.now, { subjectEligibility: undefined });
    assert.throws(() => absent.withActivityAuthorization(f.a, f.group.id, { subjectAccountId: f.b.accountId, ...range, fields: ['workout'] }, () => null));
    assert.throws(() => absent.withActivityAuthorization(f.b, f.group.id, { subjectAccountId: f.b.accountId, ...range, fields: ['workout'] }, () => null));
  } finally { f.db.close(); }
});

test('community proof: late session/subject/profile/group/member/share changes reject output', () => {
  const changes = [
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.a.sessionId),
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare("UPDATE synthetic_accounts SET state='suppressed' WHERE id=?").run(f.b.accountId),
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare('UPDATE synthetic_accounts SET age=17 WHERE id=?').run(f.b.accountId),
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare('UPDATE synthetic_accounts SET profile_revision=profile_revision+1 WHERE id=?').run(f.b.accountId),
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare('UPDATE community_groups SET revision=revision+1 WHERE id=?').run(f.group.id),
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare("UPDATE community_groups SET state='closed',generation=generation+1 WHERE id=?").run(f.group.id),
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare('UPDATE community_members SET generation=generation+1 WHERE group_id=? AND account_id=?').run(f.group.id, f.a.accountId),
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare("UPDATE community_members SET state='left',generation=generation+1 WHERE group_id=? AND account_id=?").run(f.group.id, f.b.accountId),
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare('UPDATE community_members SET revision=revision+1 WHERE group_id=? AND account_id=?').run(f.group.id, f.b.accountId),
    (f: ReturnType<typeof sharingFixture>) => f.db.prepare('UPDATE community_share_settings SET revision=revision+1 WHERE group_id=? AND account_id=?').run(f.group.id, f.b.accountId),
  ];
  for (const change of changes) {
    const f = sharingFixture(); try {
      assert.throws(() => f.community.withActivityAuthorization(f.a, f.group.id,
        { subjectAccountId: f.b.accountId, ...range, fields: ['workout'] }, () => { change(f); return 'must not return'; }));
    } finally { f.db.close(); }
  }
});

test('community summary: reader factory gets live proof, post-reader changes deny, lease expires', () => {
  const f = sharingFixture(); try {
    f.clock.value = '2026-10-04T12:00:00.000Z';
    let captured: CommunityActivityAuthorization | undefined;
    let reads = 0;
    const scoped = service(f.db, f.now, { activityFor: proof => {
      captured = proof;
      return { readDays: input => {
        proof.assertAuthorized(input); proof.assertSubjectActive(); reads++;
        f.db.prepare('UPDATE community_share_settings SET revision=revision+1 WHERE group_id=? AND account_id=?').run(f.group.id, f.b.accountId);
        return { status: 'available', days: [] };
      } };
    } });
    assert.deepEqual(scoped.readSummary(f.a, f.group.id, range), { summaryStatus: 'unavailable', members: [] });
    assert.equal(reads, 1); const expired = captured; assert.ok(expired); assert.throws(() => expired.assertSubjectActive());
  } finally { f.db.close(); }
});

test('community routes: interleaved body awaits retain one exact actor and service per request', async () => {
  const f = fixture(); try {
    const contexts: string[] = []; const factories: string[] = []; const subjects: string[] = [];
    let signalReady: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { signalReady = resolve; });
    const routes = createCommunityRoutes({
      context: c => { const who = c.req.header('x-synthetic-actor'); const actor = who === 'b' ? f.b : f.a; contexts.push(actor.accountId); return actor; },
      serviceFor: actor => {
        factories.push(actor.accountId); if (actor.accountId === f.b.accountId) signalReady?.();
        return service(f.db, f.now, { subjectEligibility: id => { subjects.push(actor.accountId); return eligibility(f.db, id); } });
      },
    });
    const token = f.invite().token;
    const encoded = new TextEncoder().encode(JSON.stringify({ token }));
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(encoded.slice(0, 4)); } });
    const slow = routes.fetch(streamRequest('/invitations/preview', stream, { 'content-type': 'application/json', 'x-synthetic-actor': 'b' }));
    await ready;
    const fast = await routes.request('/groups', { headers: { 'x-synthetic-actor': 'a' } });
    assert.equal(fast.status, 200);
    assert.ok(controller); controller.enqueue(encoded.slice(4)); controller.close();
    const response = await slow; assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(contexts, [f.b.accountId, f.a.accountId]); assert.deepEqual(factories, contexts);
    assert.deepEqual(subjects, [f.b.accountId, f.b.accountId]);
  } finally { f.db.close(); }
});

test('community routes: body-await session revocation rechecks static compatibility service', async () => {
  const f = fixture(); try {
    let signalReady: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { signalReady = resolve; });
    const routes = createCommunityRoutes({ service: f.community, context: () => { signalReady?.(); return f.a; } });
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const pending = routes.fetch(streamRequest('/groups', stream, { 'content-type': 'application/json', 'idempotency-key': 'denied' }));
    await ready;
    f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.a.sessionId);
    assert.ok(controller);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: 'Denied', alias: 'Denied', membershipDisclosureAccepted: true }))); controller.close();
    const response = await pending;
    assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
    const count = f.db.prepare('SELECT count(*) n FROM community_groups').get() as { n: number };
    assert.equal(count.n, 1);
  } finally { f.db.close(); }
});
