import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { service } from './fixture.js';
import type { AccountContext } from '../../src/community/index.js';
import { DomainError } from '../../src/errors.js';
const data = workerData as { path: string; actor: AccountContext; token: string; barrier: SharedArrayBuffer };
const db = new Database(data.path, { timeout: 5000 });
try {
  const signal = new Int32Array(data.barrier);
  Atomics.add(signal, 0, 1); parentPort!.postMessage({ ready: true });
  Atomics.wait(signal, 1, 0);
  const community = service(db, () => new Date('2026-10-01T12:00:00.000Z'));
  try { parentPort!.postMessage({ result: community.joinInvitation(data.actor, { token: data.token, alias: 'Race adult', membershipDisclosureAccepted: true }, 'race-join') }); }
  catch (error) { parentPort!.postMessage({ status: error instanceof DomainError ? error.status : 503 }); }
} finally { db.close(); }
