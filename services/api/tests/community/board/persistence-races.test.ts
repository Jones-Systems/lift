import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createFeatureBoard, featureBoardMigrationSql, featureBoardCorrectionMigrationSql } from '../../../src/community/board/index.js';
import { install, bindings, eligibility } from '../fixture.js';
import { fixture, submission, featureRevision, merge, vote, type BoardFixture } from './fixture.js';
type Outcome = { ok: boolean; code?: string; result?: unknown };
async function race(f: BoardFixture, path: string, commands: { command: 'vote' | 'merge' | 'suppress' | 'correct' | 'withdraw'; actor: typeof f.a; id: string; input: unknown }[]): Promise<Outcome[]> {
  const gate = new SharedArrayBuffer(4); const workers: Worker[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Synthetic race deadline exceeded')), 10000); });
  try {
    const started = commands.map(command => {
      const worker = new Worker(new URL('./race-worker.js', import.meta.url), { workerData: { ...command, path, gate, key: randomUUID() } }); workers.push(worker);
      let ready!: () => void; const readiness = new Promise<void>(resolve => { ready = resolve; });
      const outcome = new Promise<Outcome>((resolve, reject) => {
        worker.on('message', (message: Outcome & { ready?: boolean }) => { if (message.ready) ready(); else resolve(message); });
        worker.on('error', cause => { ready(); reject(cause); }); worker.on('exit', code => { if (code !== 0) { ready(); reject(new Error(`Synthetic worker exit ${code}`)); } });
      });
      void outcome.catch(() => {}); return { readiness, outcome };
    });
    await Promise.race([Promise.all(started.map(item => item.readiness)), deadline]); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
    return await Promise.race([Promise.all(started.map(item => item.outcome)), deadline]);
  } finally { if (timer) clearTimeout(timer); await Promise.all(workers.map(worker => worker.terminate())); }
}
function diskFixture(): { root: string; path: string; f: BoardFixture } {
  const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.board-fixture-')); const path = join(root, 'synthetic.sqlite');
  let db: Database.Database | undefined;
  try {
    db = new Database(path); db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); db.pragma('busy_timeout=5000'); install(db); db.exec(featureBoardMigrationSql); db.exec(featureBoardCorrectionMigrationSql);
    return { root, path, f: fixture(db) };
  } catch (error) { db?.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}

test('real SQLite survives close/reopen; community-only FKs and no nested BEGIN', t => {
  const { root, path, f } = diskFixture(); t.after(() => { if (f.db.open) f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const row = f.published(f.a); vote(f, f.b, row.featureId); const context = f.b; f.db.close();
  const reopened = new Database(path);
  try {
    reopened.pragma('foreign_keys=ON');
    const board = createFeatureBoard({ db: reopened, now: f.now, lifecycle: bindings(reopened), subjectEligibility: id => eligibility(reopened, id), isBlocked: () => false });
    assert.equal(board.detail(context, row.featureId).feature.voteCount, 1);
    reopened.transaction(() => assert.equal(board.detail(context, row.featureId).feature.voteCount, 1)).immediate();
    for (const name of ['features', 'submissions', 'aliases', 'votes', 'vote_events', 'merge_events', 'status_events', 'command_receipts', 'quota_events']) {
      const foreignKeys = reopened.prepare(`PRAGMA foreign_key_list(community_board_${name})`).all() as { table: string }[];
      for (const fk of foreignKeys) assert.match(fk.table, /^community_board_/);
    }
    assert.deepEqual(reopened.pragma('foreign_key_check'), []);
  } finally { reopened.close(); }
});

test('two serialized SQLite writers exclude stale concurrent votes; retry known no effect only', { timeout: 15000 }, async t => {
  const { root, path, f } = diskFixture(); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const row = f.published(f.a); const expectedRevision = featureRevision(f, row.featureId);
  const outcomes = await race(f, path, [f.b, f.c].map(actor => ({ command: 'vote', actor, id: row.featureId, input: { active: true, expectedRevision } })));
  assert.equal(outcomes.filter(item => item.ok).length, 1); assert.equal(outcomes.filter(item => item.code === 'stale_revision').length, 1);
  assert.equal(f.board.detail(f.a, row.featureId).feature.voteCount, 1);
  const loser = f.board.ownVotes(f.b).some(item => item.active) ? f.c : f.b; vote(f, loser, row.featureId);
  assert.equal(f.board.detail(f.a, row.featureId).feature.voteCount, 2);
});

test('concurrent merge chains linearize without cycles or double counts', { timeout: 15000 }, async t => {
  const { root, path, f } = diskFixture(); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const a = f.published(f.a); const b = f.published(f.b, 'Equivalent second feature'); const c = f.published(f.c, 'Equivalent third feature');
  vote(f, f.a, a.featureId); vote(f, f.b, a.featureId); vote(f, f.b, b.featureId); vote(f, f.c, c.featureId);
  const command = (sourceId: string, targetId: string) => ({ command: 'merge' as const, actor: f.steward, id: sourceId,
    input: { sourceId, targetId, sourceRevision: featureRevision(f, sourceId), targetRevision: featureRevision(f, targetId), reason: 'Equivalent synthetic request', semanticEquivalent: true } });
  const outcomes = await race(f, path, [command(a.featureId, b.featureId), command(b.featureId, c.featureId)]);
  assert.ok(outcomes.every(item => item.ok || item.code === 'stale_revision'));
  if (f.board.detail(f.a, b.featureId).canonicalId !== c.featureId) merge(f, b.featureId, c.featureId);
  if (f.board.detail(f.a, a.featureId).canonicalId !== c.featureId) merge(f, a.featureId, c.featureId);
  assert.equal(f.board.detail(f.a, a.featureId).canonicalId, c.featureId);
  assert.equal(f.board.detail(f.a, c.featureId).feature.voteCount, 3); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('suppression races a vote under same SQLite lock; neither final order leaves an active suppressed vote', { timeout: 15000 }, async t => {
  const { root, path, f } = diskFixture(); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const row = f.published(f.a); const outcomes = await race(f, path, [
    { command: 'vote', actor: f.b, id: row.featureId, input: { active: true, expectedRevision: featureRevision(f, row.featureId) } },
    { command: 'suppress', actor: f.steward, id: f.b.accountId, input: {} },
  ]);
  assert.equal(outcomes[1]?.ok, true); assert.ok(outcomes[0]?.ok || outcomes[0]?.code === 'synthetic_account_disabled');
  assert.equal(f.board.detail(f.a, row.featureId).feature.voteCount, 0);
  f.db.transaction(() => assert.equal(f.board.verifySuppressed(f.b.accountId, 1), true)).immediate();
});

test('withdraw racing a merge cannot resurrect source support; stale loser retries only known no effect', { timeout: 15000 }, async t => {
  const { root, path, f } = diskFixture(); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const a = f.published(f.a); const b = f.published(f.b, 'Equivalent withdrawal request'); vote(f, f.c, a.featureId);
  const sourceRevision = featureRevision(f, a.featureId); const targetRevision = featureRevision(f, b.featureId);
  const outcomes = await race(f, path, [
    { command: 'merge', actor: f.steward, id: a.featureId, input: { sourceId: a.featureId, targetId: b.featureId, sourceRevision, targetRevision, reason: 'Equivalent synthetic scope', semanticEquivalent: true } },
    { command: 'vote', actor: f.c, id: a.featureId, input: { active: false, expectedRevision: sourceRevision } },
  ]);
  assert.ok(outcomes.every(item => item.ok || item.code === 'stale_revision'));
  if (f.board.detail(f.a, a.featureId).canonicalId !== b.featureId) merge(f, a.featureId, b.featureId);
  if (f.board.ownVotes(f.c).some(row => row.active)) vote(f, f.c, a.featureId, false);
  assert.equal(f.board.detail(f.c, b.featureId).feature.voteCount, 0);
  assert.equal(f.board.ownVotes(f.c).filter(row => row.active).length, 0);
});


test('correction competing with correction or withdrawal has one revision winner', { timeout: 15000 }, async t => {
  for (const competing of ['correct', 'withdraw'] as const) {
    const { root, path, f } = diskFixture(); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
    const row = f.published(f.a);
    const input = { ...submission('Corrected competing request'), expectedRevision: row.revision, expectedCanonicalFeatureId: row.canonicalFeatureId };
    const outcomes = await race(f, path, [
      { command: 'correct', actor: f.a, id: row.id, input },
      { command: competing, actor: f.a, id: row.id, input: competing === 'correct' ? input : { expectedRevision: row.revision } },
    ]);
    assert.equal(outcomes.filter(value => value.ok).length, 1);
    assert.ok(outcomes.filter(value => !value.ok).every(value => ['stale_revision', 'board_not_found'].includes(value.code!)));
    const events = f.db.prepare('SELECT count(*) FROM community_board_correction_events').pluck().get();
    assert.equal(events, outcomes[0]!.ok || competing === 'correct' ? 1 : 0);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  }
});

test('correction versus merge binds observed canonical identity without moving support', { timeout: 15000 }, async t => {
  const { root, path, f } = diskFixture(); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const row = f.published(f.a); const target = f.published(f.b, 'Equivalent merge destination'); vote(f, f.c, row.featureId);
  const outcomes = await race(f, path, [
    { command: 'correct', actor: f.a, id: row.id, input: { ...submission('Corrected competing request'), expectedRevision: row.revision, expectedCanonicalFeatureId: row.featureId } },
    { command: 'merge', actor: f.steward, id: row.featureId, input: { sourceId: row.featureId, targetId: target.featureId,
      sourceRevision: featureRevision(f, row.featureId), targetRevision: featureRevision(f, target.featureId), reason: 'Equivalent synthetic scope', semanticEquivalent: true } },
  ]);
  assert.equal(outcomes[1]!.ok, true);
  assert.ok(outcomes[0]!.ok || outcomes[0]!.code === 'board_canonical_changed');
  assert.equal(f.board.detail(f.a, target.featureId).feature.voteCount, 1);
  for (const own of f.board.ownSubmissions(f.a).filter(value => value.id !== row.id)) assert.equal(f.board.detail(f.a, own.featureId).feature.voteCount, 0);
});

test('suppression racing correction leaves no accessible successor in either lock order', { timeout: 15000 }, async t => {
  const { root, path, f } = diskFixture(); t.after(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const row = f.published(f.a);
  const outcomes = await race(f, path, [
    { command: 'correct', actor: f.a, id: row.id, input: { ...submission('Corrected competing request'), expectedRevision: row.revision, expectedCanonicalFeatureId: row.featureId } },
    { command: 'suppress', actor: f.steward, id: f.a.accountId, input: {} },
  ]);
  assert.equal(outcomes[1]!.ok, true); assert.ok(outcomes[0]!.ok || outcomes[0]!.code === 'synthetic_account_disabled');
  f.db.transaction(() => assert.equal(f.board.verifySuppressed(f.a.accountId, 1), true)).immediate();
  assert.equal(f.board.browse(f.b).features.length, 0);
});

test('lost correction acknowledgement reopens one immutable receipt and fresh successor', t => {
  const { root, path, f } = diskFixture(); t.after(() => { if (f.db.open) f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const row = f.published(f.a); const input = { ...submission('Corrected persisted request'), expectedRevision: row.revision, expectedCanonicalFeatureId: row.featureId };
  const result = f.board.correct(f.a, row.id, input, 'original-key'); f.db.close();
  const reopened = new Database(path);
  try {
    reopened.pragma('foreign_keys=ON');
    const board = createFeatureBoard({ db: reopened, now: f.now, lifecycle: bindings(reopened) });
    board.withdraw(f.a, result.successor!.id, { expectedRevision: 1 }, 'withdraw');
    const replay = board.correct(f.a, row.id, input, 'original-key');
    assert.deepEqual(replay.receipt, result.receipt); assert.equal(replay.successor!.visibility, 'withdrawn');
    assert.equal(reopened.prepare('SELECT count(*) FROM community_board_correction_events').pluck().get(), 1);
    assert.deepEqual(reopened.pragma('foreign_key_check'), []);
  } finally { reopened.close(); }
});
