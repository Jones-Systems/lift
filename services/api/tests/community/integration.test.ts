import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../src/errors.js';
import { createCommunity, createCommunityIntegration, allFalse, type AccountContext, type CommunityIntegrationDependencies } from '../../src/community/index.js';
import { featureBoardMigrationSql } from '../../src/community/board/migration.js';
import { BOARD_POLICY_VERSION } from '../../src/community/board/types.js';
import { fixture, bindings, eligibility } from './fixture.js';

const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
const range = { from: '2026-10-02', to: '2026-10-02' };
function integratedFixture() {
  const f = fixture(); f.db.pragma('foreign_keys=ON'); f.db.exec(featureBoardMigrationSql); const joined = f.join(f.b);
  const deps: CommunityIntegrationDependencies = { db: f.db, now: f.now, lifecycle: bindings(f.db), subjectEligibility: id => eligibility(f.db, id),
    parent: { assertRateLimit: () => {} },
    // All permissive capabilities here are synthetic, never production defaults.
    extension: { textModeration: { policyVersion: 'community-v1', checkText: () => 'allowed' }, assertRateLimit: () => {},
      moderation: { withReviewWrite: effect => f.db.transaction(effect).immediate(), assertReview: () => {} },
      support: { qualified: true }, retention: { qualified: true } },
    board: { textModeration: { checkText: () => 'allowed' }, moderation: { assertAuthorized: actor => {
      if (actor.accountId !== f.a.accountId) throw new DomainError(403, 'synthetic_moderator_denied');
    } }, retention: { assertPublicationQualified: () => {} }, support: { assertStaffed: () => {} },
      safety: { report: () => ({ receiptId: randomUUID(), status: 'pending' }) } },
  };
  const module = createCommunityIntegration(deps);
  const published = (author: AccountContext, title = 'Improve workout planning') => {
    const row = module.board.submit(author, { title, description: 'Please make the exercise planning more flexible.', category: 'plans', policyVersion: BOARD_POLICY_VERSION, policyAccepted: true, audienceAccepted: true }, randomUUID());
    module.board.moderate(f.a, row.id, { visibility: 'published', expectedRevision: row.revision }, randomUUID());
    return module.board.ownSubmissions(author).find(value => value.id === row.id)!;
  };
  return { ...f, deps, module, joined, published };
}
function match(f: ReturnType<typeof integratedFixture>): void {
  f.db.prepare("INSERT INTO community_group_policy VALUES(?,'matched','accountability',12,1,'community-v1',NULL)").run(f.group.id);
}

test('internal resolved-author pair seam is group independent, current and either direction', t => {
  const f = integratedFixture(); t.after(() => f.db.close());
  assert.throws(() => f.module.extension.isBlocked(f.a, f.outsider.accountId), errorCode('community_lifecycle_serialization_required'));
  assert.equal(f.db.transaction(() => f.module.extension.isBlocked(f.a, f.outsider.accountId)).immediate(), false);
  f.db.prepare('INSERT INTO community_blocks VALUES(?,?,?,1,1,?)').run(randomUUID(), f.outsider.accountId, f.a.accountId, f.clock.value);
  assert.equal(f.db.transaction(() => f.module.extension.isBlocked(f.a, f.outsider.accountId)).immediate(), true);
  assert.equal(f.db.transaction(() => f.module.extension.isBlocked(f.outsider, f.a.accountId)).immediate(), true);
  f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.a.sessionId);
  assert.throws(() => f.db.transaction(() => f.module.extension.isBlocked(f.a, f.outsider.accountId)).immediate(), errorCode('synthetic_session_invalid'));
});

test('blocked pair is concealed in roster/summary/proof and sensitive Activity adapter is never fetched', t => {
  const f = integratedFixture(); t.after(() => f.db.close());
  f.module.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'share');
  let factories = 0, reads = 0;
  const module = createCommunityIntegration({ ...f.deps, parent: { ...f.deps.parent, activityFor: () => { factories++; return { readDays: () => { reads++; return { status: 'unavailable' }; } }; } } });
  f.module.extension.blockMember(f.b, f.group.id, f.group.memberId, {}, 'block');
  assert.deepEqual(module.community.readGroup(f.a, f.group.id).members.map(value => value.memberId), [f.group.memberId]);
  assert.equal(module.community.readSummary(f.a, f.group.id, range).members.some(value => value.memberId === f.joined.memberId), false);
  assert.throws(() => module.community.withActivityAuthorization(f.a, f.group.id, { subjectAccountId: f.b.accountId, ...range, fields: ['workout'] }, () => { throw new Error('must never consume'); }));
  assert.equal(factories, 0); assert.equal(reads, 0);
});

test('Activity proof rechecks blocks after a synchronous consumer before returning', t => {
  const f = integratedFixture(); t.after(() => f.db.close());
  f.module.community.updateSharing(f.b, f.group.id, { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'share');
  assert.throws(() => f.module.community.withActivityAuthorization(f.a, f.group.id, { subjectAccountId: f.b.accountId, ...range, fields: ['workout'] }, () => {
    f.db.prepare('INSERT INTO community_blocks VALUES(?,?,?,1,1,?)').run(randomUUID(), f.b.accountId, f.a.accountId, f.clock.value);
    return 'sensitive sentinel';
  }));
  assert.equal((f.db.prepare('SELECT count(*) n FROM community_blocks').get() as { n: number }).n, 0);
});

test('board uses the real resolved-author callback without shared group membership', t => {
  const f = integratedFixture(); t.after(() => f.db.close()); const row = f.published(f.outsider);
  assert.equal(f.module.board.detail(f.b, row.featureId).feature.id, row.featureId);
  f.db.prepare('INSERT INTO community_blocks VALUES(?,?,?,1,1,?)').run(randomUUID(), f.outsider.accountId, f.b.accountId, f.clock.value);
  assert.throws(() => f.module.board.detail(f.b, row.featureId), errorCode('board_not_found'));
  assert.equal(f.module.board.browse(f.b).features.some(value => value.id === row.featureId), false);
});

test('parent governance guards deny matched legacy receipt replay and raw token preview/join', t => {
  const f = integratedFixture(); t.after(() => f.db.close());
  const issued = f.module.community.issueInvitation(f.a, f.group.id, {}, 'cached-issue'); assert.ok(issued.tokenAvailable);
  const body = { token: issued.token, alias: 'Another member', membershipDisclosureAccepted: true };
  f.module.community.joinInvitation(f.c, body, 'cached-join'); match(f);
  assert.throws(() => f.module.community.issueInvitation(f.a, f.group.id, {}, 'cached-issue'), errorCode('community_governed_action_required'));
  assert.throws(() => f.module.community.joinInvitation(f.c, body, 'cached-join'), errorCode('community_reserved_join_required'));
  assert.equal(f.module.friendBridge.status, 'available');
  assert.throws(() => f.module.community.removeMember(f.a, f.group.id, f.joined.memberId, { expectedRevision: 1 }, 'remove'), errorCode('community_governed_action_required'));
  assert.throws(() => f.module.community.updateRole(f.a, f.group.id, f.joined.memberId, { role: 'admin', expectedRevision: 1 }, 'role'), errorCode('community_governed_action_required'));
});

test('blocked authority denies legacy role receipt replay and invitation metadata', t => {
  const f = integratedFixture(); t.after(() => f.db.close()); const role = { role: 'admin', expectedRevision: 1 };
  f.module.community.updateRole(f.a, f.group.id, f.joined.memberId, role, 'cached-role');
  f.module.extension.blockMember(f.a, f.group.id, f.joined.memberId, {}, 'block');
  assert.throws(() => f.module.community.updateRole(f.a, f.group.id, f.joined.memberId, role, 'cached-role'), errorCode('community_not_found'));
  assert.equal(f.module.community.readGroup(f.b, f.group.id).members.some(value => value.memberId === f.group.memberId), false);
});

test('moderation is required for parent text before effect and replay; absent hooks fail closed', t => {
  const f = integratedFixture(); t.after(() => f.db.close());
  const unconfigured = createCommunityIntegration({ db: f.db, now: f.now, lifecycle: bindings(f.db), subjectEligibility: id => eligibility(f.db, id) });
  assert.throws(() => unconfigured.community.createGroup(f.a, { name: 'Unsafe bypass', alias: 'Alias', membershipDisclosureAccepted: true }, 'unconfigured'), errorCode('community_text_moderation_unavailable'));
  assert.throws(() => unconfigured.community.updateAlias(f.a, f.group.id, { alias: 'Alias', expectedRevision: 1 }, 'alias'), errorCode('community_text_moderation_unavailable'));
  const renamed = f.module.community.renameGroup(f.a, f.group.id, { name: 'New name', expectedRevision: 1 }, 'rename'); assert.equal(renamed.name, 'New name');
  assert.throws(() => unconfigured.community.renameGroup(f.a, f.group.id, { name: 'New name', expectedRevision: 1 }, 'rename'), errorCode('community_text_moderation_unavailable'));
  const raw = createCommunity({ db: f.db, now: f.now, lifecycle: bindings(f.db) });
  assert.throws(() => raw.createGroup(f.a, { name: 'Bypass', alias: 'Alias', membershipDisclosureAccepted: true }, 'raw'), errorCode('community_parent_guards_unavailable'));
});

test('request-scoped integration freezes canonical identity across B2/B4/B5', t => {
  const f = integratedFixture(); t.after(() => f.db.close()); const mutable = { ...f.a }; const scoped = createCommunityIntegration(f.deps, mutable);
  mutable.accountId = f.b.accountId;
  assert.equal(scoped.community.readGroup(f.a, f.group.id).role, 'owner');
  assert.throws(() => scoped.community.readGroup(f.b, f.group.id), errorCode('community_request_scope_mismatch'));
  assert.throws(() => scoped.extension.readMatching(f.b), errorCode('community_request_scope_mismatch'));
  assert.throws(() => scoped.board.ownSubmissions(f.b), errorCode('community_request_scope_mismatch'));
  const other = createCommunityIntegration(f.deps, f.b); assert.equal(other.community.readGroup(f.b, f.group.id).role, 'member');
});

test('leave and owner close invoke disclosure cleanup under the parent transaction', t => {
  const f = integratedFixture(); t.after(() => f.db.close());
  const post = f.module.extension.createPost(f.b, f.group.id, { kind: 'win', text: 'A synthetic win', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'post');
  f.module.community.leave(f.b, f.group.id, {}, 'leave');
  const hidden = f.db.prepare('SELECT state,text FROM community_posts WHERE id=?').get(post.id) as { state: string; text: string | null };
  assert.deepEqual(hidden, { state: 'hidden', text: null });
  assert.equal(f.module.community.readGroup(f.a, f.group.id).members.length, 1);
  const own = f.module.extension.createPost(f.a, f.group.id, { kind: 'win', text: 'Owner synthetic win', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'owner-post');
  f.module.community.closeGroup(f.a, f.group.id, { expectedRevision: 1 }, 'close');
  assert.equal((f.db.prepare('SELECT state FROM community_posts WHERE id=?').get(own.id) as { state: string }).state, 'hidden');
});

test('sharing withdrawal preserves independent manual UGC and matched membership', t => {
  const f = integratedFixture(); t.after(() => f.db.close()); match(f);
  const post = f.module.extension.createPost(f.b, f.group.id, { kind: 'win', text: 'Synthetic personal win', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'post');
  f.module.community.withdraw(f.b, f.group.id, {}, 'withdraw');
  assert.equal(f.module.community.listGroups(f.b).length, 1);
  assert.deepEqual(f.module.community.readSharing(f.b, f.group.id).flags, allFalse());
  assert.deepEqual(f.db.prepare('SELECT state,text FROM community_posts WHERE id=?').get(post.id), { state: 'pending', text: 'Synthetic personal win' });
});

test('one community adapter exports all own modules and suppresses every module including owner closure', t => {
  const f = integratedFixture(); t.after(() => f.db.close()); const row = f.published(f.a); f.published(f.b, 'Other member text sentinel');
  const sections: unknown[] = [];
  f.db.transaction(() => {
    assert.equal(f.module.lifecycleAdapter.inventory(f.a).status, 'complete');
    assert.equal(f.module.lifecycleAdapter.export(f.a, { snapshotAtMs: Date.parse(f.clock.value), append: (category, value) => { assert.equal(category, 'community'); sections.push(value); } }).status, 'complete');
    assert.equal(f.module.lifecycleAdapter.purge(randomUUID(), f.a.accountId).status, 'pending');
  }).immediate();
  const encoded = JSON.stringify(sections); assert.equal(encoded.includes('community-b4'), true); assert.equal(encoded.includes('featureBoard'), true); assert.equal(encoded.includes('Other member text sentinel'), false);
  f.db.transaction(() => {
    f.db.prepare("UPDATE synthetic_accounts SET state='suppressed',epoch=1 WHERE id=?").run(f.a.accountId);
    assert.equal(f.module.lifecycleAdapter.suppress(f.a.accountId, 1).status, 'complete');
    assert.equal(f.module.lifecycleAdapter.verifySuppressed(f.a.accountId, 1).status, 'complete');
  }).immediate();
  assert.equal((f.db.prepare('SELECT state FROM community_groups WHERE id=?').get(f.group.id) as { state: string }).state, 'closed');
  assert.equal((f.db.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(row.id) as { visibility: string }).visibility, 'hidden');
});

test('restore preflights B4-only owners and both block directions before touching restored state', t => {
  const f = integratedFixture(); t.after(() => f.db.close()); const row = f.published(f.b);
  f.db.prepare('INSERT INTO community_blocks VALUES(?,?,?,1,1,?)').run(randomUUID(), f.outsider.accountId, f.c.accountId, f.clock.value);
  const seen: string[] = [];
  assert.throws(() => f.db.transaction(() => f.module.reconcileRestore({ ready: true, lookup: id => { seen.push(id); return id === f.outsider.accountId ? undefined : { state: 'active', epoch: 0 }; } })).immediate(), errorCode('community_restore_authority_required'));
  assert.equal(seen.includes(f.outsider.accountId), true);
  assert.equal((f.db.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(row.id) as { visibility: string }).visibility, 'published');
  f.db.transaction(() => f.module.reconcileRestore({ ready: true, lookup: id => ({ state: id === f.outsider.accountId ? 'suppressed' : 'active', epoch: id === f.outsider.accountId ? 1 : 0 }) })).immediate();
  assert.equal((f.db.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(row.id) as { visibility: string }).visibility, 'hidden');
  assert.equal(f.module.board.browse(f.b).features.length, 0);
});

test('parent cleanup failure rolls back membership and sharing in the same canonical writer', t => {
  const f = integratedFixture(); t.after(() => f.db.close());
  const extension = f.module.extension;
  const guarded = createCommunity({ db: f.db, now: f.now, lifecycle: bindings(f.db), subjectEligibility: id => eligibility(f.db, id), extension: {
    assertPairVisible: (actor, group, account) => extension.assertPairVisible(actor, group, account),
    guardLegacy: (actor, group, action, target) => extension.guardLegacy(actor, group, action, target),
    authorizeGroupText: (actor, purpose, text) => extension.authorizeGroupText(actor, purpose, text),
    afterMemberEnds: () => { throw new DomainError(503, 'synthetic_cleanup_failure'); },
    afterGroupCloses: group => extension.afterGroupCloses(group),
  } });
  assert.throws(() => guarded.leave(f.b, f.group.id, {}, 'leave'), errorCode('synthetic_cleanup_failure'));
  assert.equal(f.module.community.listGroups(f.b).length, 1);
  assert.equal((f.db.prepare("SELECT count(*) n FROM community_command_receipts WHERE account_id=? AND operation=?").get(f.b.accountId, `leave:${f.group.id}`) as { n: number }).n, 0);
});

test('withdrawn board source remains withdrawn across suppression and restore', t => {
  const f = integratedFixture(); t.after(() => f.db.close()); const row = f.published(f.b);
  f.module.board.withdraw(f.b, row.id, { expectedRevision: row.revision }, 'withdraw');
  f.db.transaction(() => {
    assert.equal(f.module.lifecycleAdapter.suppress(f.b.accountId, 1).status, 'complete');
    assert.equal(f.module.lifecycleAdapter.verifySuppressed(f.b.accountId, 1).status, 'complete');
    f.module.reconcileRestore({ ready: true, lookup: id => ({ state: id === f.b.accountId ? 'suppressed' : 'active', epoch: id === f.b.accountId ? 1 : 0 }) });
  }).immediate();
  assert.equal((f.db.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(row.id) as { visibility: string }).visibility, 'withdrawn');
});
