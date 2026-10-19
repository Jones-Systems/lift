import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../src/errors.js';
import { createCommunityIntegration } from '../../../src/community/integration.js';
import { createFeatureBoard, createFeatureBoardRoutes, featureBoardCorrectionMigrationSql, featureBoardCorrectionMigrationVersion } from '../../../src/community/board/index.js';
import { fixture, submission, merge, vote } from './fixture.js';
const error = (code: string) => (value: unknown) => value instanceof DomainError && value.code === code;
const correction = (row: { revision: number; canonicalFeatureId: string }, title = 'Corrected workout request') => ({ ...submission(title), expectedRevision: row.revision, expectedCanonicalFeatureId: row.canonicalFeatureId });

test('migration20 is additive and correction unavailable against immutable13 alone', t => {
  const f = fixture(); t.after(() => f.db.close()); const row = f.board.submit(f.a, submission(), 'original');
  assert.equal(featureBoardCorrectionMigrationVersion, 20);
  assert.throws(() => f.board.correct(f.a, row.id, correction(row), 'correct'), error('board_correction_unavailable'));
  f.db.exec(featureBoardCorrectionMigrationSql);
  const result = f.board.correct(f.a, row.id, correction(row), 'correct');
  assert.equal(result.successor?.visibility, 'pending'); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.throws(() => f.db.prepare('UPDATE community_board_correction_events SET receipt_json=receipt_json').run(), /immutable_board_correction/);
  f.db.prepare('DELETE FROM community_board_correction_events WHERE id=?').run(result.receipt.eventId);
  f.db.prepare('INSERT INTO community_board_correction_events VALUES(?,?,?,?)').run(result.receipt.eventId, row.id, result.successor!.id,
    JSON.stringify({ ...result.receipt, eventId: 'mismatched-event' }));
  assert.throws(() => f.board.correct(f.a, row.id, correction(row), 'correct'), error('board_correction_receipt_unavailable'));
});

test('published and merged original corrections preserve content aliases votes and other authors', t => {
  for (const merged of [false, true]) {
    const f = fixture(); t.after(() => f.db.close()); f.db.exec(featureBoardCorrectionMigrationSql);
    let row = f.published(f.a); const target = f.published(f.b, 'Equivalent existing request'); vote(f, f.c, row.featureId);
    if (merged) { merge(f, row.featureId, target.featureId); row = f.board.ownSubmissions(f.a)[0]!; }
    const before = ['votes', 'vote_events', 'aliases', 'merge_events'].map(name => f.db.prepare(`SELECT * FROM community_board_${name}`).all());
    const result = f.board.correct(f.a, row.id, correction(row), 'correct');
    assert.deepEqual(['votes', 'vote_events', 'aliases', 'merge_events'].map(name => f.db.prepare(`SELECT * FROM community_board_${name}`).all()), before);
    const own = f.board.ownSubmissions(f.a).find(value => value.id === row.id)!;
    assert.equal(own.title, row.title); assert.equal(own.description, row.description); assert.equal(own.visibility, row.visibility);
    assert.equal(own.revision, row.revision + 1); assert.equal(own.successorSubmissionId, result.successor!.id);
    assert.equal(result.successor!.predecessorSubmissionId, row.id);
    assert.equal(f.board.detail(f.a, result.successor!.featureId).feature.voteCount, 0);
    assert.equal(f.board.ownSubmissions(f.b)[0]!.title, target.title);
    assert.throws(() => f.board.detail(f.b, result.successor!.featureId), error('board_not_found'));
  }
});

test('author canonical revision unchanged-content strict-input and eligibility guards are zero effect', t => {
  const f = fixture(); t.after(() => f.db.close()); f.db.exec(featureBoardCorrectionMigrationSql);
  const row = f.published(f.a); const input = correction(row);
  for (const [actor, body, code] of [
    [f.b, input, 'board_not_found'], [f.a, { ...input, expectedRevision: row.revision + 1 }, 'stale_revision'],
    [f.a, { ...input, expectedCanonicalFeatureId: 'wrong' }, 'board_canonical_changed'],
    [f.a, { ...input, title: row.title, description: row.description }, 'board_correction_unchanged'],
    [f.a, { ...input, voteOnSubmit: true }, 'board_invalid_input'], [f.a, { ...input, audienceAccepted: false }, 'board_invalid_input'],
  ] as const) assert.throws(() => f.board.correct(actor, row.id, body, randomUUID()), error(code));
  f.db.prepare('UPDATE synthetic_accounts SET age=17 WHERE id=?').run(f.a.accountId);
  assert.throws(() => f.board.correct(f.a, row.id, input, 'minor'), error('board_adult_eligibility_unavailable'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM community_board_correction_events').pluck().get(), 0);
  assert.equal(f.board.ownSubmissions(f.a).length, 1);
});

test('replay keeps original receipt while successor withdrawal and further correction change only fresh view', t => {
  const f = fixture(); t.after(() => f.db.close()); f.db.exec(featureBoardCorrectionMigrationSql);
  const row = f.board.submit(f.a, submission(), 'submit'); const body = correction(row);
  const result = f.board.correct(f.a, row.id, body, 'original-correction');
  const second = f.board.correct(f.a, result.successor!.id, correction(result.successor!, 'Further corrected request'), 'next-correction');
  const advanced = f.board.ownSubmissions(f.a).find(value => value.id === result.successor!.id)!;
  f.board.withdraw(f.a, advanced.id, { expectedRevision: advanced.revision }, 'withdraw');
  f.board.withdraw(f.a, row.id, { expectedRevision: result.receipt.resultRevision }, 'withdraw-original');
  const replay = f.board.correct(f.a, row.id, body, 'original-correction');
  assert.deepEqual(replay.receipt, result.receipt); assert.equal(replay.successor!.visibility, 'withdrawn');
  assert.equal(replay.successor!.successorSubmissionId, second.successor!.id);
  assert.throws(() => f.board.correct(f.a, row.id, { ...body, title: 'Changed retry intent' }, 'original-correction'), error('idempotency_conflict'));
  f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.a.sessionId);
  assert.throws(() => f.board.correct(f.a, row.id, body, 'original-correction'), error('synthetic_session_invalid'));
});

test('moderation rejection quota and callback lifecycle loss roll back every correction effect', t => {
  for (const mode of ['reject', 'quota', 'lifecycle'] as const) {
    const f = fixture(); t.after(() => f.db.close()); f.db.exec(featureBoardCorrectionMigrationSql);
    const row = f.board.submit(f.a, submission(), 'submit');
    if (mode === 'quota') { f.board.submit(f.a, submission('Second request today'), 'two'); f.board.submit(f.a, submission('Third request today'), 'three'); }
    const board = createFeatureBoard({ ...f.deps, textModeration: { checkText: () => {
      if (mode === 'lifecycle') f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.a.sessionId);
      return mode === 'reject' ? 'rejected' : 'allowed';
    } } });
    const count = f.db.prepare('SELECT count(*) FROM community_board_submissions').pluck().get();
    assert.throws(() => board.correct(f.a, row.id, correction(row), 'correction'), error(mode === 'quota' ? 'board_rate_limited' : mode === 'reject' ? 'board_text_rejected' : 'synthetic_session_invalid'));
    assert.equal(f.db.prepare('SELECT count(*) FROM community_board_submissions').pluck().get(), count);
    assert.equal(f.db.prepare('SELECT count(*) FROM community_board_correction_events').pluck().get(), 0);
    assert.equal(f.board.ownSubmissions(f.a).find(value => value.id === row.id)!.revision, row.revision);
  }
});

test('later qualified merge deduplicates voters and removed support is not revived by correction replay', t => {
  const f = fixture(); t.after(() => f.db.close()); f.db.exec(featureBoardCorrectionMigrationSql);
  const row = f.published(f.a); vote(f, f.b, row.featureId); vote(f, f.c, row.featureId);
  const input = correction(row); const result = f.board.correct(f.a, row.id, input, 'correct');
  const successor = result.successor!;
  f.board.moderate(f.moderator, successor.id, { expectedRevision: successor.revision, visibility: 'published' }, 'publish-new');
  vote(f, f.b, successor.featureId); vote(f, f.c, row.featureId, false);
  merge(f, row.featureId, successor.featureId);
  assert.equal(f.board.detail(f.a, successor.featureId).feature.voteCount, 1);
  f.board.correct(f.a, row.id, input, 'correct');
  assert.equal(f.board.detail(f.a, successor.featureId).feature.voteCount, 1);
  assert.ok(f.board.ownVotes(f.c).every(value => !value.active));
});

test('owned export suppression restore and qualified purge cover lineage without personal tombstones', t => {
  const f = fixture(); t.after(() => f.db.close()); f.db.exec(featureBoardCorrectionMigrationSql);
  const row = f.board.submit(f.a, submission(), 'original'); const input = correction(row);
  const result = f.board.correct(f.a, row.id, input, 'correct'); let exported: unknown;
  f.db.transaction(() => {
    assert.equal(f.board.inventoryAccount(f.a).corrections, 1);
    f.board.exportAccount(f.a, (_category, value) => { exported = value; });
  }).immediate();
  assert.ok(JSON.stringify(exported).includes(result.receipt.eventId)); assert.equal(JSON.stringify(exported).includes(f.a.sessionId), false);
  const integrated = createCommunityIntegration({ db: f.db, now: f.now, lifecycle: f.deps.lifecycle! });
  f.db.transaction(() => integrated.reconcileRestore({ ready: true, lookup: () => ({ state: 'active', epoch: 0 }) })).immediate();
  assert.throws(() => f.board.correct(f.a, row.id, input, 'correct'), error('board_restore_reconsent_required'));
  f.db.transaction(() => {
    f.board.suppressAccount(f.a.accountId, 1); assert.equal(f.board.verifySuppressed(f.a.accountId, 1), true);
    f.board.purgeAccount('purge', f.a.accountId, { retentionAndAuditRedactionQualified: true });
    assert.equal(f.db.prepare('SELECT count(*) FROM community_board_correction_events').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT count(*) FROM community_board_command_receipts WHERE account_id=?').pluck().get(f.a.accountId), 0);
  }).immediate();
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('author route keeps request limits and rechecks original actor after awaited body', async t => {
  const f = fixture(); t.after(() => f.db.close()); f.db.exec(featureBoardCorrectionMigrationSql);
  const row = f.board.submit(f.a, submission(), 'original'); const routes = createFeatureBoardRoutes({ context: () => f.a, service: f.board });
  const response = await routes.request(`/submissions/${row.id}/correct`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'correct' }, body: JSON.stringify(correction(row)) });
  assert.equal(response.status, 201); const result = await response.json() as { receipt: { submissionId: string }; successor: { visibility: string } };
  assert.equal(result.receipt.submissionId, row.id); assert.equal(result.successor.visibility, 'pending');
  const huge = await routes.request(`/submissions/${row.id}/correct`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'huge' }, body: JSON.stringify({ title: 'x'.repeat(9000) }) });
  assert.equal(huge.status, 413);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let admitted!: () => void;
  const captured = new Promise<void>(resolve => { admitted = resolve; });
  const delayed = createFeatureBoardRoutes({ context: () => { admitted(); return f.a; }, service: f.board });
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const request = new Request(`http://synthetic/submissions/${row.id}/correct`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'late' }, body: stream, duplex: 'half' } as RequestInit);
  const pending = delayed.request(request);
  try {
    await captured;
    f.db.prepare('UPDATE synthetic_sessions SET valid=0 WHERE id=?').run(f.a.sessionId);
    controller.enqueue(new TextEncoder().encode(JSON.stringify(correction(row))));
  } finally { controller.close(); }
  assert.equal((await pending).status, 401);
  assert.equal(f.db.prepare('SELECT count(*) FROM community_board_correction_events').pluck().get(), 1);
});
