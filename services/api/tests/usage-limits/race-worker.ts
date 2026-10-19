import { parentPort, workerData } from 'node:worker_threads';
import { createUsageLedger } from '../../src/usage-limits/index.js';
import { actor, intent, openConnection, START, testPolicy } from './fixture.js';

const { path, key, gate } = workerData as { path: string; key: string; gate: SharedArrayBuffer };
const db = openConnection(path);
try {
  const ledger = createUsageLedger({ db, policy: testPolicy(1), now: () => START + 1_000,
    lifecycle: { assertActive: () => {}, withActiveWrite: (_actor, effect) => effect(),
      adultEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'eligible', profileRevision: 1 }) },
    resolveRights: () => ({ policyId: 'synthetic-race', capabilities: ['coach'], configuredOperations: ['standard'] }),
  });
  parentPort!.postMessage({ ready: true });
  const view = new Int32Array(gate);
  Atomics.wait(view, 0, 0, 5_000);
  try { parentPort!.postMessage({ result: ledger.usage.reserve(actor, intent(key)).kind }); }
  catch (error) { parentPort!.postMessage({ result: (error as { code?: string }).code ?? 'unexpected_error' }); }
} finally { db.close(); }
