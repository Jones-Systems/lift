import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrations } from '../src/storage.js';
import { DomainError } from '../src/errors.js';
import { bindSuppressionAuthority } from '../src/lifecycle/guards.js';
import { createSourceAccountModules } from '../src/integration/account-modules/index.js';
import { usageMigrationSql } from '../src/usage-limits/index.js';
import { bugIntakeMigrationSql } from '../src/bug-intake/index.js';
import { lifecycleMigration } from '../src/lifecycle/migration.js';
import { AccountLifecycle, lifecyclePolicy } from '../src/lifecycle/service.js';
import { issueLocalPurgeAuthority, type LocalPurgeAuthority } from '../src/lifecycle/purge-executor.js';
import { createCanonicalAccountWriter } from '../src/integration/account-modules/canonical-writer.js';
import type { AccountContext, DisableRecord, LifecycleAdapter, LifecycleResult, SuppressionLedger } from '../src/lifecycle/types.js';

const requestId = '33333333-3333-4333-8333-333333333333';
const A: AccountContext = { accountId: '11111111-1111-4111-8111-111111111111', authUserId: 'auth-a', sessionId: 'session-a', epoch: 0 };
const B: AccountContext = { accountId: '22222222-2222-4222-8222-222222222222', authUserId: 'auth-b', sessionId: 'session-b', epoch: 0 };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
function fixture(t: TestContext, makeAdapters: (db: Database.Database, writer: ReturnType<typeof createCanonicalAccountWriter>) => LifecycleAdapter[] = () => []) {
  const db = new Database(':memory:'); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  for (const migration of migrations.filter(m => m.version <= 7)) db.exec(migration.sql);
  db.exec(lifecycleMigration.sql);
  const now = Date.now();
  for (const actor of [A, B]) {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(actor.authUserId, 'Synthetic', `${actor.authUserId}@synthetic.invalid`, 1, now, now);
    db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(actor.accountId, actor.authUserId, 'synthetic');
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)')
      .run(actor.sessionId, now + 86400_000, `synthetic-${actor.sessionId}`, now, now, actor.authUserId);
    db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run(actor.accountId, 'profile', 1, '{"age":18}');
    db.prepare('UPDATE "user" SET phoneNumber=? WHERE id=?').run(actor === A ? '+12025550111' : '+12025550122', actor.authUserId);
    db.prepare("INSERT INTO phone_challenges VALUES(?,?,?,?,'pending',NULL,?,?,?,1,0,NULL,?)")
      .run(actor.authUserId, '+12025550111', `binding-${actor.authUserId}`, `start-${actor.authUserId}`, now, now + 300_000, now, actor.authUserId);
    db.prepare("INSERT INTO phone_operations VALUES(?,'start',?,'synthetic-intent','done',?)")
      .run(actor.authUserId, `key-${actor.authUserId}`, now);
  }
  const records = new Map<string, DisableRecord>();
  let sequence = 0, available = true;
  const ledger: SuppressionLedger = {
    currentSequence() { if (!available) throw new Error('Synthetic unavailable authority'); return sequence; },
    lookup(accountId) { this.currentSequence(); return records.get(accountId) ?? null; },
    recordDisable(record) { const stored = Object.freeze({ ...record, sequence: ++sequence }); records.set(record.accountId, stored); return stored; },
    reconcileRestore(apply) { for (const record of records.values()) apply(record); return this.currentSequence(); },
  };
  bindSuppressionAuthority(db, ledger);
  const writer = createCanonicalAccountWriter(db), adapters = makeAdapters(db, writer);
  const lifecycle = new AccountLifecycle(db, adapters, ledger, () => now);
  function initiate() {
    lifecycle.initiate(A, 'synthetic-delete', { requestId, policyVersion: lifecyclePolicy,
      confirmation: 'delete_whole_account', statusSecret: 's'.repeat(43) });
  }
  function disable() {
    initiate(); ledger.recordDisable({ ...A, epoch: 1, requestId, disabledAtMs: now }); lifecycle.reconcileRestore();
  }
  const mint = () => issueLocalPurgeAuthority(lifecycle, { requestId, operationId: 'synthetic-operation' });
  const snapshot = () => ['documents', 'phone_challenges', 'phone_operations', 'user', 'form_accounts', 'account_lifecycle',
    'account', 'session', 'account_deletion_requests', 'account_deletion_steps'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { db, writer, lifecycle, records, ledger, initiate, disable, mint, snapshot, unavailable: () => { available = false; } };
}
function adapter(category: string, purge: LifecycleAdapter['purge']): LifecycleAdapter {
  return { category, purge, inventory: () => ({ category, status: 'complete' }), export: () => ({ category, status: 'complete' }),
    suppress: () => ({ status: 'complete' }), verifySuppressed: () => ({ status: 'complete' }) };
}

test('issuer owns its transaction and requires matching current deletion intent', t => {
  const f = fixture(t);
  assert.throws(f.mint, code('not_found'));
  f.initiate(); assert.throws(f.mint, code('suppression_required'));
  f.ledger.recordDisable({ ...A, epoch: 1, requestId, disabledAtMs: Date.now() }); f.lifecycle.reconcileRestore();
  assert.throws(() => f.db.transaction(f.mint).immediate(), code('purge_issuer_transaction_required'));
  const record = f.records.get(A.accountId)!;
  for (const patch of [{ requestId: 'foreign' }, { authUserId: 'foreign' }, { epoch: 2 }, { sequence: 2 }]) {
    f.records.set(A.accountId, { ...record, ...patch });
    assert.throws(f.mint, code('requestId' in patch ? 'deletion_request_mismatch' : 'suppression_required'));
  }
  f.records.set(A.accountId, record);
  const capability = f.mint(); assert.deepEqual(Object.keys(capability), []);
  assert.throws(() => JSON.stringify(capability), code('purge_authority_not_serializable'));
  assert.throws(() => f.lifecycle.purgeLocal({} as LocalPurgeAuthority), code('purge_authority_invalid'));
});

test('authority is single-use, database-specific and stale state is rejected without mutation', t => {
  const f = fixture(t), other = fixture(t); f.disable(); other.disable();
  const foreign = f.mint(), before = other.snapshot();
  assert.throws(() => other.lifecycle.purgeLocal(foreign), code('purge_authority_invalid'));
  assert.deepEqual(other.snapshot(), before);
  assert.throws(() => f.lifecycle.purgeLocal(foreign), code('purge_authority_invalid'));
  const stale = f.mint();
  const record = f.records.get(A.accountId)!;
  f.records.set(A.accountId, { ...record, sequence: 2 });
  const changed = f.snapshot();
  assert.throws(() => f.lifecycle.purgeLocal(stale), code('suppression_required')); assert.deepEqual(f.snapshot(), changed);
  f.records.set(A.accountId, record);
  assert.throws(() => f.lifecycle.purgeLocal(stale), code('purge_authority_invalid'));
});

test('qualified subframes delegate readiness, reject category switching and retain held residuals', t => {
  let calls = 0, heldCalls = 0;
  const f = fixture(t, (_db, writer) => {
    const wrong = writer.guardLifecycleAdapter(adapter('body', () => { throw new Error('Wrong category entered'); }));
    return [adapter('activity', (request, account) => {
      calls++; assert.deepEqual(writer.purgeReadiness(request, account), { status: 'ready', epoch: 1 });
      assert.equal(writer.purgeReadiness('foreign', account).status, 'unavailable');
      assert.equal(wrong.purge(request, account).status, 'unavailable');
      return { status: 'retained', reason: 'synthetic_shared_receipts' };
    }), adapter('community', () => { heldCalls++; return { status: 'complete' }; }),
    adapter('direct_provider_auth', () => { heldCalls++; return { status: 'complete' }; })];
  });
  f.disable();
  assert.equal(f.writer.purgeReadiness(requestId, A.accountId).status, 'unavailable');
  const unframed = f.writer.guardLifecycleAdapter(adapter('activity', () => { throw new Error('Unframed implementation entered'); }));
  assert.equal(f.db.transaction(() => unframed.purge(requestId, A.accountId)).immediate().status, 'unavailable');
  const otherRows = f.db.prepare('SELECT * FROM documents WHERE account_id=?').all(B.accountId);
  const otherSession = f.db.prepare('SELECT * FROM session WHERE id=?').get(B.sessionId);
  const capability = f.mint(), result = f.lifecycle.purgeLocal(capability);
  assert.equal(calls, 1); assert.equal(heldCalls, 0);
  assert.equal(result.complete, false); assert.equal(result.localPurged, false); assert.equal(result.phase, 'pending_external');
  assert.equal(result.backupExpiryAt, null); assert.equal(result.billingCancellation, 'not_performed');
  const states = Object.fromEntries(result.steps.map(step => [step.category, step.status]));
  assert.deepEqual(states, { activity: 'retained', auth_identity: 'retained', backups: 'pending', community: 'pending',
    direct_provider_auth: 'pending', form_training_history: 'complete', phone_challenges: 'complete', providers: 'pending', purchase_proofs: 'retained' });
  assert.deepEqual(f.db.prepare('SELECT * FROM documents WHERE account_id=?').all(B.accountId), otherRows);
  assert.deepEqual(f.db.prepare('SELECT * FROM session WHERE id=?').get(B.sessionId), otherSession);
  assert.deepEqual(f.db.prepare('SELECT DISTINCT evidence_ref FROM account_deletion_steps WHERE status=\'complete\'').all(), [{ evidence_ref: 'synthetic-operation' }]);
  assert.throws(() => f.lifecycle.purgeLocal(capability), code('purge_authority_invalid'));
  assert.equal(f.lifecycle.purgeLocal(f.mint()).complete, false); assert.equal(calls, 2);
});

test('contact reassociation never widens immutable phone purge ownership', t => {
  const f = fixture(t);
  for (const [id, phone, subject] of [['old-unbound', '+12025550111', null], ['new-unbound', '+12025550133', null],
    ['new-foreign', '+12025550133', B.authUserId]] as const) {
    f.db.prepare("INSERT INTO phone_challenges VALUES(?,?,?,?,'pending',NULL,1,2,1,1,0,NULL,?)")
      .run(id, phone, `binding-${id}`, `start-${id}`, subject);
    f.db.prepare("INSERT INTO phone_operations VALUES(?,'start',?,'synthetic-intent','done',1)").run(id, `key-${id}`);
  }
  f.db.prepare('UPDATE "user" SET phoneNumber=? WHERE id=?').run('+12025550133', A.authUserId);
  const preserved = ['phone_challenges', 'phone_operations'].map(table => f.db.prepare(table === 'phone_challenges'
    ? "SELECT * FROM phone_challenges WHERE auth_user_id IS NULL OR auth_user_id<>? ORDER BY rowid"
    : 'SELECT o.* FROM phone_operations o JOIN phone_challenges c ON c.id=o.challenge_id WHERE c.auth_user_id IS NULL OR c.auth_user_id<>? ORDER BY o.rowid').all(A.authUserId));
  f.disable();
  const other = f.db.prepare('SELECT * FROM session WHERE id=?').get(B.sessionId);
  const result = f.lifecycle.purgeLocal(f.mint());
  assert.deepEqual(['phone_challenges', 'phone_operations'].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), preserved);
  assert.equal(result.steps.find(step => step.category === 'phone_challenges')?.status, 'complete');
  assert.equal(result.complete, false); assert.equal(result.backupExpiryAt, null);
  assert.deepEqual(f.db.prepare('SELECT * FROM session WHERE id=?').get(B.sessionId), other);
  f.lifecycle.assertActive(B);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

for (const failure of ['thenable', 'adapter', 'readback', 'authority'] as const) test(`${failure} failure rolls back core, steps and phase and consumes authority`, t => {
  let unavailable = () => {};
  const f = fixture(t, db => [adapter('activity', () => {
    assert.deepEqual(db.prepare('SELECT * FROM phone_challenges WHERE auth_user_id=?').all(A.authUserId), []);
    assert.deepEqual(db.prepare('SELECT * FROM phone_operations WHERE challenge_id=?').all(A.authUserId), []);
    if (failure === 'thenable') return { then() {} } as unknown as LifecycleResult;
    if (failure === 'adapter') throw new DomainError(503, 'synthetic_adapter_failed');
    if (failure === 'readback') db.prepare("INSERT INTO phone_challenges VALUES('late-own','+12025550111','late-binding','late-start','pending',NULL,1,2,1,1,0,NULL,?)").run(A.authUserId);
    if (failure === 'authority') unavailable();
    return { status: 'complete' };
  })]);
  unavailable = f.unavailable;
  f.disable(); const before = f.snapshot(), capability = f.mint();
  const suppression = [...f.records];
  assert.throws(() => f.lifecycle.purgeLocal(capability), code(failure === 'thenable' ? 'canonical_writer_requires_synchronous_effect'
    : failure === 'adapter' ? 'synthetic_adapter_failed' : failure === 'readback' ? 'local_purge_readback_failed' : 'suppression_authority_unavailable'));
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual([...f.records], suppression);
  assert.equal(f.records.get(A.accountId)?.requestId, requestId);
  assert.throws(() => f.lifecycle.purgeLocal(capability), code('purge_authority_invalid'));
});

test('deferred foreign-key violation rolls back without reordering core or adapters', t => {
  const f = fixture(t, (db) => [adapter('activity', () => {
    db.prepare('INSERT INTO synthetic_child VALUES(?)').run('missing'); return { status: 'complete' };
  })]);
  f.db.exec('CREATE TABLE synthetic_parent(id TEXT PRIMARY KEY); CREATE TABLE synthetic_child(parent TEXT REFERENCES synthetic_parent(id) DEFERRABLE INITIALLY DEFERRED)');
  f.disable(); const before = f.snapshot();
  assert.throws(() => f.lifecycle.purgeLocal(f.mint()), code('local_purge_foreign_key_check_failed'));
  assert.deepEqual(f.snapshot(), before); assert.deepEqual(f.db.prepare('SELECT * FROM synthetic_child').all(), []);
});

test('suppression without a restored request retains data and reports held intent', t => {
  const f = fixture(t);
  f.ledger.recordDisable({ ...A, epoch: 1, requestId, disabledAtMs: Date.now() }); f.lifecycle.reconcileRestore();
  const before = f.snapshot();
  assert.throws(f.mint, code('deletion_request_absent_restore_held'));
  assert.throws(() => f.lifecycle.status(requestId, 's'.repeat(43)), code('status_receipt_invalid'));
  assert.deepEqual(f.snapshot(), before);
  assert.throws(() => f.lifecycle.assertActive(A), code('account_session_invalid'));
});

test('runtime-composed usage and bug adapters receive scoped readiness through canonical guards', t => {
  const f = fixture(t, (db, writer) => {
    db.exec(usageMigrationSql); db.exec(bugIntakeMigrationSql);
    return [...createSourceAccountModules(db, writer.lifecycle).adapters];
  });
  f.disable();
  for (const owned of f.lifecycle.adapters) assert.equal(f.db.transaction(() => owned.purge(requestId, A.accountId)).immediate().status, 'unavailable');
  const result = f.lifecycle.purgeLocal(f.mint());
  for (const category of ['usage_limits', 'bugIntake']) assert.equal(result.steps.find(step => step.category === category)?.status, 'complete');
  assert.equal(result.complete, false);
  assert.equal(f.lifecycle.purgeLocal(f.mint()).complete, false);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('capability rejects an enclosing transaction and replacement suppression authority', t => {
  const f = fixture(t); f.disable();
  const capability = f.mint(), before = f.snapshot();
  assert.throws(() => f.db.transaction(() => f.lifecycle.purgeLocal(capability)).immediate(), code('purge_executor_transaction_required'));
  assert.deepEqual(f.snapshot(), before);
  assert.throws(() => f.lifecycle.purgeLocal(capability), code('purge_authority_invalid'));
  const replaced = f.mint();
  bindSuppressionAuthority(f.db, { ...f.ledger });
  assert.throws(() => f.lifecycle.purgeLocal(replaced), code('purge_authority_stale'));
  assert.deepEqual(f.snapshot(), before);
});

test('verification exceptions and unknown verification cannot claim module completion', t => {
  let purging = false, throwOnVerify = true;
  const f = fixture(t, () => [{ ...adapter('activity', () => { purging = true; return { status: 'complete' }; }),
    verifySuppressed() {
      if (!purging) return { status: 'complete' };
      if (throwOnVerify) throw new DomainError(503, 'synthetic_verify_failed');
      return { status: 'unknown' };
    },
  }]);
  f.disable(); const before = f.snapshot();
  assert.throws(() => f.lifecycle.purgeLocal(f.mint()), code('synthetic_verify_failed'));
  assert.deepEqual(f.snapshot(), before);
  throwOnVerify = false;
  const result = f.lifecycle.purgeLocal(f.mint());
  assert.equal(result.localPurged, false);
  assert.equal(result.steps.find(step => step.category === 'activity')?.status, 'unknown');
});
