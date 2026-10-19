import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../src/errors.js';
import { createFeatureBoard, createFeatureBoardRoutes, createFeatureBoardLifecycleAdapter } from '../../../src/community/board/index.js';
import { fixture, submission, vote, merge, featureRevision } from './fixture.js';
const error = (code: string) => (value: unknown) => value instanceof DomainError && value.code === code;

test('pending text is author-only; no identity/voter list or health join in published projection', t => {
  const f = fixture(); t.after(() => f.db.close());
  const row = f.board.submit(f.a, submission('The app is too restrictive'), 'submit');
  assert.equal(f.board.detail(f.a, row.featureId).feature.visibility, 'pending');
  assert.throws(() => f.board.detail(f.b, row.featureId), error('board_not_found'));
  assert.equal(f.board.browse(f.b).features.length, 0);
  f.board.moderate(f.moderator, row.id, { expectedRevision: 1, visibility: 'published' }, 'publish');
  const publicView = f.board.detail(f.b, row.featureId); const encoded = JSON.stringify(publicView);
  for (const person of [f.a, f.b, f.moderator]) assert.equal(encoded.includes(person.accountId), false);
  assert.equal(publicView.feature.authorLabel, 'Form member'); assert.equal(publicView.feature.voteCount, 0);
  assert.equal(f.board.browse(f.b, { q: 'restrictive', category: 'plans', status: 'submitted' }).features.length, 1);
});

test('default moderation/steward/safety unavailable; explicit synthetic ports do not claim live activation', t => {
  const f = fixture(); t.after(() => f.db.close());
  const minimal = createFeatureBoard({ db: f.db, now: f.now, lifecycle: f.deps.lifecycle! });
  const row = minimal.submit(f.a, submission(), 'pending');
  assert.equal(minimal.capabilities(f.a).moderation, 'unavailable');
  assert.equal(minimal.capabilities(f.a).liveActivation, 'unqualified');
  assert.throws(() => minimal.moderate(f.moderator, row.id, { expectedRevision: 1, visibility: 'published' }, 'm'), error('board_moderation_unavailable'));
  assert.throws(() => minimal.merge(f.steward, { sourceId: row.featureId, targetId: row.featureId, sourceRevision: 1, targetRevision: 1, reason: 'Same scope', semanticEquivalent: true }, 's'), error('board_steward_unavailable'));
  assert.throws(() => minimal.report(f.a, row.featureId, { reason: 'privacy' }, 'r'), error('board_safety_unavailable'));
});

test('strict plain Unicode schemas, affirmative audience/policy, and no implicit author vote', t => {
  const f = fixture(); t.after(() => f.db.close());
  for (const input of [ { ...submission(), accountId: f.b.accountId }, { ...submission(), policyAccepted: false },
    { ...submission(), audienceAccepted: false }, { ...submission(), title: '😀😀😀😀' }, { ...submission(), description: '<script>unsafe private content</script>' },
    { ...submission(), title: 'Visit https://example.com' }, { ...submission(), voteOnSubmit: 'true' }, { ...submission(), category: 'clinical' } ]) {
    assert.throws(() => f.board.submit(f.a, input, randomUUID()), error('board_invalid_input'));
  }
  const row = f.board.submit(f.a, { ...submission(), title: '😀😀😀😀😀' }, 'unicode');
  assert.equal(f.board.detail(f.a, row.featureId).feature.voteCount, 0);
  const voted = f.board.submit(f.a, { ...submission('Submit and support choice'), voteOnSubmit: true }, 'support');
  assert.equal(f.board.detail(f.a, voted.featureId).feature.voteCount, 1);
});

test('current auth and authorization precede receipts; changed intent conflicts and stale revision fails', t => {
  const f = fixture(); t.after(() => f.db.close()); const row = f.published(f.a);
  const input = { active: true, expectedRevision: featureRevision(f, row.featureId) };
  f.board.setVote(f.b, row.featureId, input, 'v');
  assert.deepEqual(f.board.setVote(f.b, row.featureId, input, 'v'), f.board.ownVotes(f.b)[0]);
  assert.throws(() => f.board.setVote(f.b, row.featureId, { ...input, active: false }, 'v'), error('idempotency_conflict'));
  assert.throws(() => f.board.setVote(f.c, row.featureId, input, 'stale'), error('stale_revision'));
  f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.b.sessionId);
  assert.throws(() => f.board.setVote(f.b, row.featureId, input, 'v'), error('synthetic_session_invalid'));
  assert.throws(() => f.board.withdraw(f.c, row.id, { expectedRevision: row.revision }, 'steal'), error('board_not_found'));
});

test('merge unions overlapping active voter sets once, aliases flatten, withdraw/replay never revives a vote', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.published(f.a, 'Flexible weekly plans'); const b = f.published(f.b, 'Flexible daily plans'); const c = f.published(f.c, 'Flexible calendar plans');
  vote(f, f.a, a.featureId); vote(f, f.b, a.featureId); vote(f, f.b, b.featureId); vote(f, f.c, b.featureId);
  merge(f, a.featureId, b.featureId); assert.equal(f.board.detail(f.c, b.featureId).feature.voteCount, 3);
  assert.equal(f.board.detail(f.c, a.featureId).canonicalId, b.featureId);
  const input = { active: true, expectedRevision: featureRevision(f, a.featureId) };
  f.board.setVote(f.a, a.featureId, input, 'old-set'); vote(f, f.a, a.featureId, false);
  assert.equal(f.board.setVote(f.a, a.featureId, input, 'old-set').active, false);
  merge(f, b.featureId, c.featureId);
  assert.equal(f.board.detail(f.a, a.featureId).canonicalId, c.featureId);
  assert.equal(f.board.detail(f.a, c.featureId).feature.voteCount, 2);
  assert.equal((f.db.prepare('SELECT target_id FROM community_board_aliases WHERE source_id=?').get(a.featureId) as { target_id: string }).target_id, c.featureId);
  assert.throws(() => merge(f, c.featureId, a.featureId), error('board_merge_cycle_or_self'));
});

test('suppressed voter excluded at merge even before local vote suppression; stale merge conflicts', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.published(f.a); const b = f.published(f.b, 'Another planning improvement');
  vote(f, f.a, a.featureId); vote(f, f.c, a.featureId); vote(f, f.c, b.featureId);
  const input = { sourceId: a.featureId, targetId: b.featureId, sourceRevision: featureRevision(f, a.featureId), targetRevision: featureRevision(f, b.featureId), reason: 'Same synthetic scope', semanticEquivalent: true };
  vote(f, f.b, b.featureId);
  assert.throws(() => f.board.merge(f.steward, input, 'stale-merge'), error('stale_revision'));
  f.db.prepare("UPDATE synthetic_accounts SET state='suppressed',epoch=1 WHERE id=?").run(f.c.accountId);
  merge(f, a.featureId, b.featureId);
  assert.equal(f.board.detail(f.a, b.featureId).feature.voteCount, 2);
  assert.equal((f.db.prepare('SELECT active FROM community_board_votes WHERE feature_id=? AND account_id=?').get(b.featureId, f.c.accountId) as { active: number }).active, 0);
});

test('blocked/hidden authors concealed through detail, search, alias, replay; withdrawal still available', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.published(f.a); const b = f.published(f.b, 'Equivalent planning request');
  const voteInput = { active: true, expectedRevision: featureRevision(f, a.featureId) }; f.board.setVote(f.c, a.featureId, voteInput, 'v');
  merge(f, a.featureId, b.featureId);
  const blocked = createFeatureBoard({ ...f.deps, isBlocked: (viewer, author) => viewer.accountId === f.c.accountId && author === f.a.accountId });
  assert.throws(() => blocked.detail(f.c, a.featureId), error('board_not_found'));
  assert.throws(() => blocked.setVote(f.c, a.featureId, voteInput, 'v'), error('board_not_found'));
  blocked.setVote(f.c, a.featureId, { active: false, expectedRevision: featureRevision(f, b.featureId) }, 'withdraw-vote');
  f.board.withdraw(f.a, a.id, { expectedRevision: a.revision }, 'withdraw-text');
  assert.throws(() => f.board.detail(f.c, a.featureId), error('board_not_found'));
  assert.equal(f.board.browse(f.c, { q: a.title }).features.length, 0);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM community_board_command_receipts').all()).includes(a.description), false);
});

test('positive quotas roll back atomically; safety and withdrawal bypass them', t => {
  const f = fixture(); t.after(() => f.db.close()); const row = f.published(f.a);
  f.board.submit(f.a, submission('Second request for planning'), '2'); f.board.submit(f.a, submission('Third request for planning'), '3');
  assert.throws(() => f.board.submit(f.a, submission('Fourth request for planning'), '4'), error('board_rate_limited'));
  for (let i = 0; i < 30; i++) f.board.browse(f.b, { q: 'planning' });
  assert.throws(() => f.board.browse(f.b, { q: 'planning' }), error('board_rate_limited'));
  assert.equal(f.board.report(f.b, row.featureId, { reason: 'privacy' }, 'report').status, 'pending');
  for (let i = 0; i < 30; i++) { vote(f, f.b, row.featureId, true); vote(f, f.b, row.featureId, false); }
  assert.throws(() => vote(f, f.b, row.featureId), error('board_rate_limited'));
  assert.equal(f.board.setVote(f.b, row.featureId, { active: false, expectedRevision: featureRevision(f, row.featureId) }, 'unvote').active, false);
  assert.equal(f.board.withdraw(f.a, row.id, { expectedRevision: row.revision }, 'withdraw').visibility, 'withdrawn');
});

test('qualified internal roles are separate; release requires real evidence port and public admin routes absent', async t => {
  const f = fixture(); t.after(() => f.db.close()); const row = f.published(f.a);
  assert.throws(() => f.board.setStatus(f.a, row.featureId, { expectedRevision: featureRevision(f, row.featureId), status: 'planned', reason: 'Member claims authority' }, 's'), error('synthetic_capability_denied'));
  assert.throws(() => f.board.moderate(f.steward, row.id, { expectedRevision: row.revision, visibility: 'hidden' }, 'm'), error('synthetic_capability_denied'));
  assert.throws(() => f.board.setStatus(f.steward, row.featureId, { expectedRevision: featureRevision(f, row.featureId), status: 'released', reason: 'Release should be proven' }, 's'), error('board_release_evidence_required'));
  f.board.setStatus(f.steward, row.featureId, { expectedRevision: featureRevision(f, row.featureId), status: 'released', reason: 'Synthetic release only', releaseEvidence: 'synthetic-release-evidence' }, 'released');
  const routes = createFeatureBoardRoutes({ context: () => f.a, service: f.board });
  for (const path of ['/admin/merge', '/moderators', '/batch']) assert.equal((await routes.request(path, { method: 'POST' })).status, 404);
});

test('request scope, strict queries and streamed 8KiB bound before parse; no-store on errors', async t => {
  const f = fixture(); t.after(() => f.db.close());
  const routes = createFeatureBoardRoutes({ context: c => c.req.header('x-synthetic-actor') === 'b' ? f.b : f.a, service: f.board });
  const submitResponse = await routes.request('/features', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'http' }, body: JSON.stringify(submission()) });
  assert.equal(submitResponse.status, 201);
  const row = await submitResponse.json() as { featureId: string };
  assert.equal((await routes.request(`/features/${row.featureId}`, { headers: { 'x-synthetic-actor': 'b' } })).status, 404);
  for (const query of ['pageSize=51', 'page=1&page=2', 'accountId=other', 'sort=clinical', 'page=1.2']) {
    const response = await routes.request(`/features?${query}`); assert.equal(response.status, 422); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(4000))); controller.enqueue(new TextEncoder().encode(' '.repeat(4193))); controller.close(); } });
  const request = new Request('http://synthetic/features', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'oversized' }, body: stream, duplex: 'half' } as RequestInit);
  const response = await routes.fetch(request); assert.equal(response.status, 413); assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('own-only bounded export, synchronous suppression, pending purge, restore barrier prevents vote replay', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.published(f.a); const b = f.published(f.b, 'Private other member sentinel');
  const input = { active: true, expectedRevision: featureRevision(f, b.featureId) }; f.board.setVote(f.a, b.featureId, input, 'old-vote');
  const sections: unknown[] = [];
  f.db.transaction(() => f.board.exportAccount(f.a, (category, value) => { assert.equal(category, 'community'); sections.push(value); })).immediate();
  const encoded = JSON.stringify(sections); assert.equal(encoded.includes(a.description), true); assert.equal(encoded.includes(b.title), false); assert.equal(encoded.includes(f.b.accountId), false);
  const adapter = createFeatureBoardLifecycleAdapter(f.board);
  assert.equal(adapter.purge(randomUUID(), f.a.accountId).status, 'pending');
  assert.equal(adapter.suppress(f.a.accountId, 1).status, 'unavailable');
  f.db.transaction(() => { assert.equal(adapter.suppress(f.a.accountId, 1).status, 'complete'); assert.equal(adapter.verifySuppressed(f.a.accountId, 1).status, 'complete'); }).immediate();
  assert.throws(() => f.board.detail(f.b, a.featureId), error('board_not_found'));
  f.db.transaction(() => f.board.reconcileRestore({ ready: true, lookup: () => ({ state: 'active', epoch: 0 }) })).immediate();
  assert.throws(() => f.board.setVote(f.a, b.featureId, input, 'old-vote'), error('board_not_found'));
  assert.equal(f.board.ownVotes(f.a).find(row => row.featureId === b.featureId)?.active, false);
  assert.equal(f.board.browse(f.c).features.length, 0);
  const restored = f.board.ownSubmissions(f.b).find(item => item.id === b.id)!;
  assert.throws(() => f.board.moderate(f.moderator, b.id, { expectedRevision: restored.revision, visibility: 'published' }, 'restore-publish'), error('board_restore_reconsent_required'));
});


test('export memory bounds precede materializing rows or appending sections; unqualified purge never claims completion', t => {
  const f = fixture(); t.after(() => f.db.close()); const row = f.published(f.a);
  const insert = f.db.prepare('INSERT INTO community_board_vote_events VALUES(?,?,?,?,?,?)');
  f.db.transaction(() => { for (let i = 0; i < 2100; i++) insert.run(randomUUID(), f.a.accountId, row.featureId, row.featureId, 0, f.clock.value); }).immediate();
  let appended = false;
  assert.throws(() => f.db.transaction(() => f.board.exportAccount(f.a, () => { appended = true; })).immediate(), error('board_export_too_large'));
  assert.equal(appended, false);
  const adapter = createFeatureBoardLifecycleAdapter(f.board);
  assert.equal(adapter.purge(randomUUID(), f.a.accountId).status, 'pending');
});

test('missing/current eligibility and block dependencies fail closed after content resolution', t => {
  const f = fixture(); t.after(() => f.db.close()); const row = f.published(f.a);
  const noBlock = createFeatureBoard({ db: f.db, now: f.now, lifecycle: f.deps.lifecycle!, subjectEligibility: f.deps.subjectEligibility! });
  assert.throws(() => noBlock.detail(f.b, row.featureId), error('board_not_found'));
  const unknownSubject = createFeatureBoard({ ...f.deps, subjectEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'unknown', profileRevision: null }) });
  assert.throws(() => unknownSubject.detail(f.b, row.featureId), error('board_not_found'));
  f.db.prepare('UPDATE synthetic_accounts SET age=17,profile_revision=2 WHERE id=?').run(f.b.accountId);
  assert.throws(() => f.board.submit(f.b, submission(), 'minor'), error('board_adult_eligibility_unavailable'));
  assert.equal(f.board.report(f.b, row.featureId, { reason: 'privacy' }, 'minor-report').status, 'pending');
});
