import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCommunityExtensionLifecycleAdapter } from '../../src/community/extension-lifecycle.js';
import { createCommunityExtensionRoutes } from '../../src/community/extension-routes.js';
import { b4Fixture, syntheticCandidates } from './b4-fixture.js';
import { sundayPolicy } from '../../src/community/matching.js';
test('independent per-group switches default off; age/client account fields are rejected', () => { const f = b4Fixture(); try { const profile = f.extension.readProfile(f.a, f.group.id); assert.equal(Object.values(profile.flags).some(Boolean), false);
 const input = { expectedRevision: 0, flags: { ...profile.flags, region: true }, sexDescription: null, region: 'US-NE', avatar: null, audiencePreviewAccepted: true };
 f.extension.updateProfile(f.a, f.group.id, input, 'profile'); assert.equal(f.extension.rosterProfiles(f.b, f.group.id).find(m => m.memberId === f.group.memberId)?.profile.region, 'US-NE');
 assert.throws(() => f.extension.updateProfile(f.a, f.group.id, { ...input, flags: { ...input.flags, age: true } }, 'age'));
 const other = f.community.createGroup(f.a, { name: 'Another synthetic family', alias: 'Owner', membershipDisclosureAccepted: true }, 'other'); assert.equal(f.extension.readProfile(f.a, other.id).flags.region, false);
 assert.deepEqual(f.extension.rankings(f.a, f.group.id, 'month_adherence'), { status: 'unavailable' });
 } finally { f.db.close(); } });
test('mutual block conceals profiles/posts and legacy guard denies direct policy bypass', () => { const f = b4Fixture(); try { const b = f.community.listGroups(f.b)[0]!.memberId; const post = f.extension.createPost(f.b, f.group.id, { kind: 'check_in', template: 'checking_in', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'post'); f.extension.reviewPost(post.id, 1, 'publish');
 f.extension.blockMember(f.a, f.group.id, b, {}, 'block'); assert.equal(f.extension.rosterProfiles(f.a, f.group.id).some(m => m.memberId === b), false); assert.equal(f.extension.rosterProfiles(f.b, f.group.id).some(m => m.memberId === f.group.memberId), false); assert.equal(f.extension.listPosts(f.a, f.group.id).length, 0);
 f.db.transaction(() => { assert.throws(() => f.extension.guardLegacy(f.a, f.group.id, 'remove', f.b.accountId)); assert.throws(() => f.extension.guardLegacy(f.a, f.group.id, 'issue_invitation')); assert.throws(() => f.extension.assertPairVisible(f.a, f.group.id, f.b.accountId)); }).immediate();
 const block = f.extension.listBlocks(f.a)[0]!; f.extension.unblock(f.a, block.id, { expectedRevision: block.revision }, 'unblock'); assert.equal(f.extension.listPosts(f.a, f.group.id).length, 0);
 } finally { f.db.close(); } });
test('account-scoped safety reference reports after leave without reading old group', () => { const f = b4Fixture(); try { const reference = f.extension.safetyReference(f.b, f.group.id, 'member', f.group.memberId);
 const member = f.community.listGroups(f.b)[0]!; f.community.leave(f.b, f.group.id, {}, 'leave'); f.db.transaction(() => f.extension.afterMemberEnds(f.group.id, f.b.accountId)).immediate();
 const receipt = f.extension.report(f.b, { category: 'privacy', text: 'Synthetic report after leaving', safetyReference: reference.id }, 'report'); assert.equal(receipt.state, 'pending'); assert.equal(f.extension.listReports(f.b).length, 1); assert.throws(() => f.extension.rosterProfiles(f.b, member.id)); assert.equal(f.extension.listReports(f.a).length, 0);
 } finally { f.db.close(); } });
test('own export does not contain another member alias, ballot or frozen preferences', () => { const f = b4Fixture(); try { const people = syntheticCandidates(f.db, f.extension, 4), policy = sundayPolicy('2026-10-11'); f.clock.value = policy.cutoffAt; f.extension.freezeBatch(policy, 'accountability', 'en', randomUUID()); const exported: unknown[] = [];
 f.db.transaction(() => f.extension.exportAccount(people[0]!, (category, value) => { assert.equal(category, 'community'); exported.push(value); })).immediate();
 const encoded = JSON.stringify(exported); assert.equal(encoded.includes(people[1]!.accountId), false); assert.equal(encoded.includes('Owner'), false);
 } finally { f.db.close(); } });
test('canonical suppression, readback and restore keep UGC/profile/ballots/assignments private', () => { const f = b4Fixture(); try { f.extension.createPost(f.a, f.group.id, { kind: 'check_in', template: 'at_my_pace', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'post'); const adapter = createCommunityExtensionLifecycleAdapter(f.extension);
 f.db.transaction(() => { f.db.prepare("UPDATE synthetic_accounts SET state='suppressed',epoch=1 WHERE id=?").run(f.a.accountId); assert.equal(adapter.suppress(f.a.accountId, 1).status, 'complete'); assert.equal(adapter.verifySuppressed(f.a.accountId, 1).status, 'complete'); assert.equal(adapter.purge(randomUUID(), f.a.accountId).status, 'pending'); f.extension.restoreBarrier({ ready: true, suppressed: [{ accountId: f.a.accountId, epoch: 1 }] }); }).immediate();
 assert.throws(() => f.extension.readMatching(f.a)); assert.equal((f.db.prepare("SELECT count(*) n FROM community_posts WHERE state='published'").get() as { n: number }).n, 0);
 } finally { f.db.close(); } });
test('idempotent block replay returns current unblocked state without restoring UGC', () => { const f = b4Fixture(); try { const memberId = f.community.listGroups(f.b)[0]!.memberId;
 const block = f.extension.blockMember(f.a, f.group.id, memberId, {}, 'block'); f.extension.unblock(f.a, block.id, { expectedRevision: block.revision }, 'unblock');
 assert.equal(f.extension.blockMember(f.a, f.group.id, memberId, {}, 'block').active, false);
 } finally { f.db.close(); } });

test('safety reference HTTP requires strict keyed input and returns only actor-owned opaque metadata', async t => {
 const f = b4Fixture(); t.after(() => f.db.close()); let currentActor = f.b, contextCalls = 0;
 const routes = createCommunityExtensionRoutes({ context: () => { contextCalls++; return currentActor; }, serviceFor: () => f.extension });
 const path = `/groups/${f.group.id}/safety-references`, input = { kind: 'member', resourceId: f.group.memberId };
 const send = (value: unknown = input, key: string | null = 'reference', endpoint = path) => routes.request(endpoint, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'idempotency-key': key }) }, body: JSON.stringify(value),
 });
 for (const value of [null, [], {}, { ...input, accountId: f.a.accountId }, { ...input, expiresAt: f.clock.value },
  { ...input, kind: 'group' }, { ...input, resourceId: 'invalid' }]) assert.equal((await send(value)).status, 422);
 assert.equal((await send(input, null)).status, 400); assert.equal((await send(input, 'bad key')).status, 422);
 assert.equal((await send({ ...input, padding: 'x'.repeat(8192) })).status, 413);
 assert.equal((await routes.request(path, { method: 'POST', headers: { 'content-type': 'text/plain', 'idempotency-key': 'reference' }, body: JSON.stringify(input) })).status, 415);
 assert.equal((await send(input, 'reference', '/groups/invalid/safety-references')).status, 422);
 assert.equal((await send(input, 'reference', `/groups/${randomUUID()}/safety-references`)).status, 404);
 assert.equal((await routes.request(path)).status, 404);
 assert.equal((f.db.prepare('SELECT count(*) n FROM community_safety_references').get() as { n: number }).n, 0);
 const before = contextCalls, response = await send(); assert.equal(contextCalls, before + 1);
 assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
 const reference = await response.json() as { id: string; expiresAt: string };
 assert.deepEqual(Object.keys(reference).sort(), ['expiresAt', 'id']); assert.deepEqual(await (await send()).json(), reference);
 assert.equal((f.db.prepare('SELECT count(*) n FROM community_safety_references').get() as { n: number }).n, 1);
 const receipt = f.db.prepare("SELECT created_at,expires_at FROM community_extension_receipts WHERE operation='safety_reference'").get() as { created_at: string; expires_at: string };
 assert.equal(Date.parse(reference.expiresAt) - Date.parse(receipt.created_at), 180 * 86400000);
 assert.equal(Date.parse(receipt.expires_at) - Date.parse(receipt.created_at), 30 * 86400000);
 assert.throws(() => f.extension.report(f.a, { category: 'privacy', text: 'Synthetic report', safetyReference: reference.id }, 'other-report'), { code: 'community_not_found' });
 currentActor = f.c; const other = await (await send()).json() as { id: string }; assert.notEqual(other.id, reference.id);
 currentActor = f.b; assert.equal((await send({ kind: 'member', resourceId: f.community.listGroups(f.c)[0]!.memberId })).status, 409);
 const otherGroup = f.community.createGroup(f.b, { name: 'Another group', alias: 'Owner', membershipDisclosureAccepted: true }, 'other-group');
 assert.equal((await send({ kind: 'member', resourceId: otherGroup.memberId }, 'reference', `/groups/${otherGroup.id}/safety-references`)).status, 409);
});

test('safety reference command preserves visible post lineage and never reports automatically', t => {
 const f = b4Fixture(); t.after(() => f.db.close());
 const post = f.extension.createPost(f.c, f.group.id, { kind: 'check_in', template: 'checking_in', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'post');
 assert.throws(() => f.extension.createSafetyReference(f.b, f.group.id, { kind: 'post', resourceId: post.id }, 'reference'), { code: 'community_not_found' });
 f.extension.reviewPost(post.id, 1, 'publish');
 const input = { kind: 'post', resourceId: post.id }, reference = f.extension.createSafetyReference(f.b, f.group.id, input, 'reference');
 assert.deepEqual(f.extension.createSafetyReference(f.b, f.group.id, input, 'reference'), reference);
 assert.equal(f.extension.listReports(f.b).length, 0);
 const report = f.extension.report(f.b, { category: 'privacy', text: 'Synthetic quoted report', safetyReference: reference.id }, 'report');
 assert.equal(report.state, 'pending');
 f.extension.hidePost(f.c, f.group.id, post.id, { expectedRevision: 2 }, 'hide');
 assert.throws(() => f.extension.createSafetyReference(f.b, f.group.id, input, 'reference'), { code: 'community_not_found' });
 assert.equal((f.db.prepare('SELECT count(*) n FROM community_safety_references').get() as { n: number }).n, 1);
});

test('safety reference replay rechecks block leave and actor group or target generation changes', t => {
 for (const change of ['block', 'leave', 'close', 'target-left', 'actor-generation', 'group-generation', 'target-generation']) {
  const f = b4Fixture(); t.after(() => f.db.close());
  const input = { kind: 'member', resourceId: change === 'target-left' ? f.community.listGroups(f.c)[0]!.memberId : f.group.memberId };
  f.extension.createSafetyReference(f.b, f.group.id, input, 'reference');
  if (change === 'block') f.extension.blockMember(f.b, f.group.id, f.group.memberId, {}, 'block');
  if (change === 'leave') f.community.leave(f.b, f.group.id, {}, 'leave');
  if (change === 'target-left') f.community.leave(f.c, f.group.id, {}, 'leave');
  if (change === 'close') f.community.closeGroup(f.a, f.group.id, { expectedRevision: 1 }, 'close');
  if (change === 'actor-generation') f.db.prepare('UPDATE community_members SET generation=generation+1 WHERE group_id=? AND account_id=?').run(f.group.id, f.b.accountId);
  if (change === 'target-generation') f.db.prepare('UPDATE community_members SET generation=generation+1 WHERE group_id=? AND account_id=?').run(f.group.id, f.a.accountId);
  if (change === 'group-generation') f.db.prepare('UPDATE community_groups SET generation=generation+1 WHERE id=?').run(f.group.id);
  assert.throws(() => f.extension.createSafetyReference(f.b, f.group.id, input, 'reference'), { code: ['block', 'leave', 'close', 'target-left'].includes(change) ? 'community_not_found' : 'idempotency_conflict' });
  assert.equal((f.db.prepare('SELECT count(*) n FROM community_safety_references').get() as { n: number }).n, 1);
 }
});

test('safety reference retained receipt cannot replace a missing or expired reference', t => {
 for (const change of ['missing', 'expired']) {
  const f = b4Fixture(); t.after(() => f.db.close()); const input = { kind: 'member', resourceId: f.group.memberId };
  const reference = f.extension.createSafetyReference(f.b, f.group.id, input, 'reference');
  if (change === 'missing') f.db.prepare('DELETE FROM community_safety_references WHERE id=?').run(reference.id);
  else f.db.prepare('UPDATE community_safety_references SET expires_at=? WHERE id=?').run(f.clock.value, reference.id);
  assert.throws(() => f.extension.createSafetyReference(f.b, f.group.id, input, 'reference'), { code: 'community_not_found' });
  assert.equal((f.db.prepare('SELECT count(*) n FROM community_safety_references').get() as { n: number }).n, change === 'missing' ? 0 : 1);
 }
});

test('safety reference quota permits existing replay and receipt capacity failure rolls back creation', t => {
 const f = b4Fixture(); t.after(() => f.db.close()); const input = { kind: 'member', resourceId: f.group.memberId };
 const first = f.extension.createSafetyReference(f.b, f.group.id, input, 'first');
 f.db.transaction(() => {
  const insert = f.db.prepare('INSERT INTO community_safety_references VALUES(?,?,?,?,?,?,?)');
  for (let i = 1; i < 200; i++) insert.run(randomUUID(), f.b.accountId, f.group.id, 'member', f.group.memberId, f.clock.value, first.expiresAt);
 }).immediate();
 assert.deepEqual(f.extension.createSafetyReference(f.b, f.group.id, input, 'first'), first);
 assert.throws(() => f.extension.createSafetyReference(f.b, f.group.id, input, 'new'), { code: 'community_reference_capacity' });
 f.db.transaction(() => {
  const insert = f.db.prepare('INSERT INTO community_extension_receipts VALUES(?,?,?,?,?,?,?)');
  for (let i = 0; i < 2000; i++) insert.run(f.c.accountId, 'synthetic', `cap-${i}`, '0'.repeat(64), randomUUID(), f.clock.value, first.expiresAt);
 }).immediate();
 assert.throws(() => f.extension.createSafetyReference(f.c, f.group.id, input, 'full'), { code: 'community_receipt_capacity' });
 assert.equal((f.db.prepare('SELECT count(*) n FROM community_safety_references WHERE account_id=?').get(f.c.accountId) as { n: number }).n, 0);
 f.db.exec("CREATE TRIGGER synthetic_reference_failure BEFORE INSERT ON community_extension_receipts WHEN NEW.operation='safety_reference' BEGIN SELECT RAISE(ABORT, 'synthetic reference receipt failure'); END");
 assert.throws(() => f.extension.createSafetyReference(f.a, f.group.id, input, 'broken'), /synthetic reference receipt failure/);
 assert.equal((f.db.prepare('SELECT count(*) n FROM community_safety_references WHERE account_id=?').get(f.a.accountId) as { n: number }).n, 0);
});
