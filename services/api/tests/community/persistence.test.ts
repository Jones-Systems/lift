import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { actor, install, service } from './fixture.js';
import { DomainError } from '../../src/errors.js';

const cleanup = new Set<() => Promise<void>>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  for (const dispose of cleanup) await dispose(); process.exit(signal === 'SIGINT' ? 130 : 143);
});
async function durable(run: (f: { path: string; open: () => Database.Database; workers: Set<Worker> }) => Promise<void>): Promise<void> {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'community-')); const path = join(root, 'synthetic.sqlite');
  const dbs = new Set<Database.Database>(); const workers = new Set<Worker>();
  const open = () => { const db = new Database(path, { timeout: 5000 }); db.pragma('journal_mode=WAL'); dbs.add(db); return db; };
  const dispose = async () => {
    await Promise.all([...workers].map(worker => worker.terminate())); workers.clear();
    for (const db of dbs) if (db.open) db.close(); dbs.clear(); rmSync(root, { recursive: true, force: true });
  };
  cleanup.add(dispose);
  try { await run({ path, open, workers }); }
  finally { await dispose(); cleanup.delete(dispose); assert.equal(existsSync(root), false); }
}

test('community: populated migration, restart, consumed token and no secret persistence', async () => {
  await durable(async f => {
    const db = f.open();
    db.exec('CREATE TABLE synthetic_legacy_history(id TEXT PRIMARY KEY,data TEXT NOT NULL); INSERT INTO synthetic_legacy_history VALUES(\'retained\',\'synthetic legacy\')');
    install(db); const a = actor(db); const b = actor(db);
    const now = () => new Date('2026-10-01T12:00:00.000Z'); const community = service(db, now);
    const group = community.createGroup(a, { name: 'Durable group', alias: 'Owner', membershipDisclosureAccepted: true }, 'create');
    const invitation = community.issueInvitation(a, group.id, {}, 'invite'); assert.ok(invitation.tokenAvailable);
    const joined = community.joinInvitation(b, { token: invitation.token, alias: 'Joined', membershipDisclosureAccepted: true }, 'join');
    db.close(); const restarted = f.open(); const restored = service(restarted, now);
    assert.equal(restored.readGroup(b, group.id).memberId, joined.memberId);
    assert.equal(restored.issueInvitation(a, group.id, {}, 'invite').tokenAvailable, false);
    assert.equal(JSON.stringify(restarted.prepare('SELECT * FROM community_command_receipts').all()).includes(invitation.token), false);
    assert.deepEqual(restarted.prepare('SELECT * FROM synthetic_legacy_history').all(), [{ id: 'retained', data: 'synthetic legacy' }]);
    assert.equal(restarted.pragma('integrity_check', { simple: true }), 'ok');
    restored.leave(b, group.id, {}, 'leave');
    assert.throws(() => restored.joinInvitation(b, { token: invitation.token, alias: 'Joined', membershipDisclosureAccepted: true }, 'join'), (e: unknown) => e instanceof DomainError && e.status === 404);
  });
});

test('community: two simultaneous SQLite connections redeem one token with exactly one winner', async () => {
  await durable(async f => {
    const db = f.open(); install(db); const a = actor(db); const b = actor(db); const c = actor(db);
    const community = service(db, () => new Date('2026-10-01T12:00:00.000Z'));
    const group = community.createGroup(a, { name: 'Race group', alias: 'Owner', membershipDisclosureAccepted: true }, 'create');
    const invite = community.issueInvitation(a, group.id, {}, 'invite'); assert.ok(invite.tokenAvailable);
    const barrier = new SharedArrayBuffer(8); const signal = new Int32Array(barrier);
    let ready = 0; const results: { status?: number; result?: unknown }[] = [];
    await Promise.all([b, c].map(person => new Promise<void>((resolveWorker, reject) => {
      const worker = new Worker(new URL('./race-worker.js', import.meta.url), { workerData: { path: f.path, actor: person, token: invite.token, barrier } });
      f.workers.add(worker);
      const deadline = setTimeout(() => reject(new Error('Synthetic race worker timeout')), 15000);
      worker.on('message', (message: { ready?: boolean; status?: number; result?: unknown }) => {
        if (message.ready) {
          ready++; if (ready === 2) { Atomics.store(signal, 1, 1); Atomics.notify(signal, 1, 2); }
        } else results.push(message);
      });
      worker.once('error', reject);
      worker.once('exit', code => { clearTimeout(deadline); f.workers.delete(worker); if (code) reject(new Error(`Worker exit ${code}`)); else resolveWorker(); });
    })));
    assert.equal(results.filter(r => r.result).length, 1); assert.equal(results.filter(r => r.status === 404).length, 1);
    const rows = db.prepare("SELECT count(*) n FROM community_members WHERE group_id=? AND state='active'").get(group.id) as { n: number };
    assert.equal(rows.n, 2);
    assert.equal((db.prepare('SELECT state FROM community_invitations WHERE id=?').get(invite.id) as { state: string }).state, 'redeemed');
  });
});

test('community: scratch cleanup preserves original deliberate failure', async () => {
  await assert.rejects(durable(async f => { const db = f.open(); install(db); throw new Error('synthetic deliberate failure'); }), /synthetic deliberate failure/);
});
