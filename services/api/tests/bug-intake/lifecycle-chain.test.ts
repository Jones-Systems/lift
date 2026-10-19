import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { migrations } from '../../src/storage.js';
import { assertActive, adultEligibility, withActiveWrite } from '../../src/lifecycle/guards.js';
import { lifecycleMigration } from '../../src/lifecycle/migration.js';
import { AccountLifecycle, lifecyclePolicy } from '../../src/lifecycle/service.js';
import type { AccountContext, DisableRecord, SuppressionLedger } from '../../src/lifecycle/types.js';
import { bugIntakeMigrationSql, bugIntakeOwnedTables, createBugIntakeLifecycleAdapter, createBugIntakeService,
  type BugIntakeDependencies } from '../../src/bug-intake/index.js';
import { authority, errorCode, input } from './fixture.js';

function chain(t: TestContext, effect?: 'unknown' | 'accepted') {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  const sourceMigrations = migrations.filter(migration => migration.version >= 1 && migration.version <= 7);
  assert.deepEqual(sourceMigrations.map(migration => migration.version), [1, 2, 3, 4, 5, 6, 7]);
  for (const migration of sourceMigrations) db.exec(migration.sql);
  db.exec(lifecycleMigration.sql); db.exec(bugIntakeMigrationSql);
  const now = Date.now();
  const contexts: Record<'A' | 'B', AccountContext> = {
    A: { accountId: '11111111-1111-4111-8111-111111111111', authUserId: 'synthetic-auth-A', sessionId: 'synthetic-session-A', epoch: 0 },
    B: { accountId: '22222222-2222-4222-8222-222222222222', authUserId: 'synthetic-auth-B', sessionId: 'synthetic-session-B', epoch: 0 },
  };
  for (const [name, context] of Object.entries(contexts)) {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(context.authUserId, `Synthetic ${name}`, `${name}@synthetic.invalid`, 1, now, now);
    db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(context.accountId, context.authUserId, 'synthetic');
    db.prepare('INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
      .run(`credential-${name}`, `subject-${name}`, 'credential', context.authUserId, 'synthetic-password-hash', now, now);
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)')
      .run(context.sessionId, now + 86400_000, `synthetic-token-${name}`, now, now, context.authUserId);
  }
  // Independent memory custody models the injected ledger without disk or coordinator substitutes.
  const records = new Map<string, DisableRecord>();
  let sequence = 0;
  const ledger: SuppressionLedger = {
    recordDisable(record) {
      assert.equal(records.has(record.accountId), false);
      const stored = Object.freeze({ ...record, sequence: ++sequence });
      records.set(record.accountId, stored); return stored;
    },
    lookup: accountId => records.get(accountId) ?? null,
    currentSequence: () => sequence,
    reconcileRestore(apply) { for (const record of records.values()) apply(record); return sequence; },
  };
  const assertSuppression = (accountId: string, epoch: number) => {
    const record = ledger.lookup(accountId);
    const state = db.prepare('SELECT state,epoch,suppression_seq FROM account_lifecycle WHERE account_id=?').get(accountId) as
      { state: string; epoch: number; suppression_seq: number } | undefined;
    assert.ok(record); assert.equal(record.accountId, accountId); assert.equal(record.epoch, epoch);
    assert.ok(state); assert.equal(state.state, 'disabled'); assert.equal(state.epoch, epoch); assert.equal(state.suppression_seq, record.sequence);
  };
  let dispatchCalls = 0;
  const deps: BugIntakeDependencies = {
    db, authority,
    lifecycle: { assertActive: context => assertActive(db, context),
      withActiveWrite: (context, operation) => withActiveWrite(db, context, operation),
      adultEligibility: context => adultEligibility(db, context) },
    lifecycleControl: {
      assertSuppression,
      purgeReadiness(requestId, accountId) {
        const record = ledger.lookup(accountId);
        const request = db.prepare('SELECT account_id,phase FROM account_deletion_requests WHERE id=?').get(requestId) as
          { account_id: string; phase: string } | undefined;
        if (!record || !request || record.requestId !== requestId || request.account_id !== accountId
          || !['disabled_pending_purge', 'pending_external'].includes(request.phase)) return { status: 'unavailable' };
        assertSuppression(accountId, record.epoch);
        return { status: 'ready', epoch: record.epoch };
      },
    },
    ...(effect ? { dispatch: { async submit() {
      dispatchCalls++;
      return effect === 'accepted' ? { status: 'accepted' as const, receiptId: 'synthetic-external-receipt' }
        : { status: 'unknown' as const };
    } } } : {}),
  };
  const adapter = createBugIntakeLifecycleAdapter(deps);
  const lifecycle = new AccountLifecycle(db, [adapter], ledger, () => now);
  const A = createBugIntakeService(deps, contexts.A), B = createBugIntakeService(deps, contexts.B);
  const requestId = '33333333-3333-4333-8333-333333333333';
  async function disable() {
    const grant = await lifecycle.issueGrant(contexts.A, { purpose: 'account_delete', password: 'synthetic-password' }, async () => true);
    lifecycle.initiate(contexts.A, 'synthetic-delete-key', { requestId, policyVersion: lifecyclePolicy,
      confirmation: 'delete_whole_account', statusSecret: 's'.repeat(43) });
    const result = lifecycle.confirm(contexts.A, requestId, { grant: grant.grant, policyVersion: lifecyclePolicy,
      confirmation: 'delete_whole_account' });
    assert.equal(result.disabled, true); assert.equal(result.localPurged, false);
  }
  const counts = (accountId: string) => bugIntakeOwnedTables.map(table =>
    (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId) as { n: number }).n);
  return { db, contexts, A, B, adapter, lifecycle, ledger, requestId, disable, counts, dispatchCalls: () => dispatchCalls };
}

test('actual canonical purge qualifies an empty bug module and preserves account suppression', async t => {
  const f = chain(t);
  f.A.submit(input, 'request-key-A'); const other = f.B.submit(input, 'request-key-B').report;
  await f.disable();
  assert.equal(f.adapter.verifySuppressed(f.contexts.A.accountId, 1).status, 'complete');
  assert.equal(f.db.transaction(() => f.adapter.purge('wrong-request', f.contexts.A.accountId))().status, 'unavailable');
  const result = f.lifecycle.purgeLocal(f.requestId);
  assert.equal(result.localPurged, true, 'successful component purge must qualify the actual root localPurged result');
  assert.deepEqual(f.counts(f.contexts.A.accountId), [0, 0, 0]);
  assert.equal(f.adapter.verifySuppressed(f.contexts.A.accountId, 1).status, 'complete');
  assert.equal(f.lifecycle.purgeLocal(f.requestId).localPurged, true);
  assert.equal(result.phase, 'pending_external'); assert.equal(result.complete, false);
  for (const category of ['backups', 'providers']) assert.equal(result.steps.find(step => step.category === category)?.status, 'pending');
  assert.equal(f.ledger.lookup(f.contexts.A.accountId)?.epoch, 1);
  assert.deepEqual(f.db.prepare('SELECT state,epoch FROM account_lifecycle WHERE account_id=?').get(f.contexts.A.accountId),
    { state: 'disabled', epoch: 1 });
  assert.throws(() => f.A.submit(input, 'request-key-A'), errorCode('account_session_invalid'));
  assert.equal(f.B.get(other.id).id, other.id); assert.deepEqual(f.counts(f.contexts.B.accountId), [1, 1, 0]);
  assert.equal(f.dispatchCalls(), 0);
});

for (const effect of ['unknown', 'accepted'] as const) {
  test(`actual canonical purge remains unqualified for ${effect} external routing effects`, async t => {
    const f = chain(t, effect);
    const report = f.A.submit(input, 'request-key-A').report;
    f.A.prepare(report.id); await f.A.dispatch(report.id);
    await f.disable();
    const before = f.counts(f.contexts.A.accountId);
    assert.equal(f.adapter.verifySuppressed(f.contexts.A.accountId, 1).status, 'unknown');
    const result = f.lifecycle.purgeLocal(f.requestId);
    assert.equal(result.localPurged, false); assert.equal(result.complete, false);
    assert.equal(result.steps.find(step => step.category === 'bugIntake')?.status, 'unknown');
    assert.deepEqual(f.counts(f.contexts.A.accountId), before);
    assert.equal(f.adapter.verifySuppressed(f.contexts.A.accountId, 1).status, 'unknown');
    assert.equal(f.dispatchCalls(), 1);
  });
}
