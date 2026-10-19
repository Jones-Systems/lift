import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AccountContext, LifecycleBindings } from '../../src/lifecycle/types.js';
import type { Sqlite } from '../../src/storage.js';
import { DomainError } from '../../src/errors.js';
import { createUsageLedger, usageMigrationSql } from '../../src/usage-limits/index.js';
import type { UsageIntent, UsageLedgerOptions, UsagePolicy, UsageRights } from '../../src/usage-limits/index.js';

export type UsageFixture = {
  db: Sqlite;
  root: string;
  path: string;
  open: () => Sqlite;
  state: { now: number; active: boolean; epoch: number; failAfterWrite: boolean; suppressed: boolean; rights: UsageRights };
  lifecycle: LifecycleBindings;
  options: (connection?: Sqlite, selectedPolicy?: UsagePolicy) => UsageLedgerOptions;
  ledger: ReturnType<typeof createUsageLedger>;
};

export const actor: AccountContext = Object.freeze({ accountId: 'account-a', authUserId: 'auth-a', sessionId: 'session-a', epoch: 1 });
export const otherActor: AccountContext = Object.freeze({ accountId: 'account-b', authUserId: 'auth-b', sessionId: 'session-b', epoch: 1 });
export const START = Date.UTC(2026, 9, 1);
export const END = Date.UTC(2026, 10, 1);
export function testPolicy(messageLimit = 1_000, generationLimit = 100): UsagePolicy {
  return {
    id: 'synthetic-limits-v1', periodPolicyId: 'test-only-utc-calendar-v1',
    periodResolver(atMs) {
      const date = new Date(atMs), year = date.getUTCFullYear(), month = date.getUTCMonth();
      return { id: `${year}-${month + 1}`, startMs: Date.UTC(year, month, 1), endMs: Date.UTC(year, month + 1, 1) };
    },
    periodAllocation: 'reservation_period', liveRounding: 'exact_milliseconds', liveMessageCounting: 'included',
    limits: { live_voice_ms: 9_000_000, coach_messages: messageLimit, workout_generations: generationLimit },
    operations: {
      standard: { capability: 'coach', metrics: ['coach_messages'] },
      live: { capability: 'live', metrics: ['live_voice_ms', 'coach_messages'] },
      generate: { capability: 'generate', metrics: ['workout_generations', 'coach_messages'] },
    },
  };
}
export function intent(key: string, amount = 1): UsageIntent {
  return { operation: 'standard', idempotencyKey: key, intentHash: 'a'.repeat(64), subjectId: 'subject-a',
    charges: [{ metric: 'coach_messages', amount }], dispatchStages: ['transcribe', 'complete', 'synthesize'] };
}
export function openConnection(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000'); db.pragma('journal_mode = WAL');
  return db;
}
export function fixture(t: TestContext, policy: UsagePolicy | undefined = testPolicy()): UsageFixture {
  const root = mkdtempSync(join(tmpdir(), 'form-usage-test-'));
  const connections = new Set<Database.Database>();
  const cleanup = () => {
    for (const db of connections) if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  };
  // Node test teardown covers assertion failure/cancellation; these cover normal process signals.
  const onInterrupt = () => { cleanup(); process.exit(130); };
  const onTerminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  t.after(() => { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); cleanup(); });
  const path = join(root, 'usage.sqlite');
  const open = () => { const db = openConnection(path); connections.add(db); return db; };
  const db = open();
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO form_accounts VALUES(?)').run(actor.accountId);
  db.prepare('INSERT INTO form_accounts VALUES(?)').run(otherActor.accountId);
  db.exec(usageMigrationSql);
  const state = { now: START + 60_000, active: true, epoch: 1, failAfterWrite: false, suppressed: false,
    rights: { policyId: 'test-grant-mapping-v1', capabilities: ['coach', 'live', 'generate'], configuredOperations: ['standard', 'live', 'generate'] } as UsageRights };
  const lifecycle: LifecycleBindings = {
    assertActive(context) {
      if (!state.active || context.epoch !== state.epoch) throw new DomainError(403, 'test_actor_revoked');
      if (context.accountId !== actor.accountId && context.accountId !== otherActor.accountId) throw new DomainError(403, 'test_actor_unknown');
    },
    withActiveWrite(context, effect) {
      lifecycle.assertActive(context); const result = effect();
      if (state.failAfterWrite) throw new Error('injected lifecycle failure after ledger write');
      lifecycle.assertActive(context); return result;
    },
    adultEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'eligible', profileRevision: 1 }),
  };
  const options = (connection = db, selectedPolicy = policy): UsageLedgerOptions => ({ db: connection, lifecycle,
    ...(selectedPolicy ? { policy: selectedPolicy } : {}), resolveRights: () => state.rights, now: () => state.now,
    lifecycleControl: {
      assertSuppression(accountId, epoch) {
        if (!state.suppressed || accountId !== actor.accountId || epoch !== 2) throw new Error('canonical suppression absent');
      },
      assertPurge(requestId, accountId) {
        if (!state.suppressed || requestId !== 'deletion-a' || accountId !== actor.accountId) throw new Error('canonical purge absent');
      },
    },
  });
  return { db, root, path, open, state, lifecycle, options, ledger: createUsageLedger(options()) };
}
