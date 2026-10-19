import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { DomainError } from '../../../src/errors.js';
import { createFeatureBoard, type AccountContext } from '../../../src/community/board/index.js';
import { bindings, eligibility } from '../fixture.js';
type Work = { path: string; actor: AccountContext; gate: SharedArrayBuffer; command: 'vote' | 'merge' | 'suppress' | 'correct' | 'withdraw'; id: string; input: unknown; key: string };
const work = workerData as Work; const db = new Database(work.path); db.pragma('foreign_keys=ON'); db.pragma('busy_timeout=5000');
try {
  const board = createFeatureBoard({ db, now: () => new Date('2026-10-09T12:00:00.000Z'), lifecycle: bindings(db),
    subjectEligibility: id => eligibility(db, id), isBlocked: () => false,
    steward: { assertAuthorized: () => {}, assertReleasedEvidence: () => { throw new DomainError(503, 'synthetic_release_unproved'); } } });
  parentPort!.postMessage({ ready: true }); Atomics.wait(new Int32Array(work.gate), 0, 0);
  const result = work.command === 'vote' ? board.setVote(work.actor, work.id, work.input, work.key)
    : work.command === 'merge' ? board.merge(work.actor, work.input, work.key)
    : work.command === 'correct' ? board.correct(work.actor, work.id, work.input, work.key)
    : work.command === 'withdraw' ? board.withdraw(work.actor, work.id, work.input, work.key)
    : db.transaction(() => {
      db.prepare("UPDATE synthetic_accounts SET state='suppressed',epoch=1 WHERE id=?").run(work.id);
      return board.suppressAccount(work.id, 1);
    }).immediate();
  parentPort!.postMessage({ ok: true, result });
} catch (error) { parentPort!.postMessage({ ok: false, code: error instanceof DomainError ? error.code : 'sqlite_or_worker_failure' }); }
finally { db.close(); }
