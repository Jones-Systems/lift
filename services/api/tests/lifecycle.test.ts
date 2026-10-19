import { Domain, defaultPreferences } from '../src/domain.js';
import { createCanonicalAccountWriter } from '../src/integration/account-modules/canonical-writer.js';
import { createConfirmedCaptureHost, confirmedCaptureKind, confirmedCaptureOperation } from '../src/integration/first-plan/confirmed-capture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../src/errors.js';
import { command, hash, integrity, migrations, type Sqlite } from '../src/storage.js';
import { adultEligibility, subjectEligibility, assertAccountActive, assertActive, assertPrincipalActive, bindSuppressionAuthority, withActiveWrite } from '../src/lifecycle/guards.js';
import { ExistingSuppressionLedger, suppressionLedgerSchema } from '../src/lifecycle/ledger.js';
import { lifecycleMigration } from '../src/lifecycle/migration.js';
import { mascotPreferencesMigration } from '../src/lifecycle/preferences-migration.js';
import { AccountLifecycle, actionGrantRequest, deletionConfirmation, deletionRequest, deletionStatusRequest, exportRequest, lifecyclePolicy } from '../src/lifecycle/service.js';
import type { AccountContext, DisableRecord, LifecycleAdapter } from '../src/lifecycle/types.js';
import { ApplePurchaseService } from '../src/purchases/service.js';
import type { AppleDeliveryRequest, AppleSandboxConfiguration, VerifiedAppleTransaction } from '../src/purchases/types.js';
import { onboardingPatch, preferencesPatch, profilePatch } from '../src/schemas.js';
import { Transcription } from '../src/transcription.js';

const accountA = '11111111-1111-4111-8111-111111111111';
const accountB = '22222222-2222-4222-8222-222222222222';
const contextA: AccountContext = { accountId: accountA, authUserId: 'auth-a', sessionId: 'session-a', epoch: 0 };
const contextB: AccountContext = { accountId: accountB, authUserId: 'auth-b', sessionId: 'session-b', epoch: 0 };
const secret = () => randomBytes(32).toString('base64url');
const intent = (): ReturnType<typeof deletionRequest.parse> => ({ requestId: randomUUID(), policyVersion: lifecyclePolicy,
  confirmation: 'delete_whole_account' as const, statusSecret: secret() });
const confirmation = (grant: string): ReturnType<typeof deletionConfirmation.parse> => ({ grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' as const });
const domain = (code: string, status?: number) => (error: unknown): boolean => {
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
};
const count = (db: Sqlite, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const rows = (db: Sqlite, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const triggers = (db: Sqlite) => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all() as { name: string; sql: string }[];

type Fixture = {
  root: string; db: Sqlite; ledgerPath: string; ledger: ExistingSuppressionLedger; now: number;
  open: (path: string) => Sqlite;
  openLedger: (path?: string, minimum?: number) => ExistingSuppressionLedger;
  closeLedger: (ledger: ExistingSuppressionLedger) => void;
  lifecycle: (db?: Sqlite, ledger?: ExistingSuppressionLedger, adapters?: readonly LifecycleAdapter[]) => AccountLifecycle;
};

// Direct schema fixtures deliberately omit pending module migrations 8/9 and aggregate migrate/openStorage.
function applyLegacy(db: Sqlite): void {
  const selected = migrations.filter(m => m.version >= 1 && m.version <= 7);
  assert.deepEqual(selected.map(m => m.version), [1, 2, 3, 4, 5, 6, 7]);
  db.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of selected) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
  }
}

function seed(db: Sqlite, now: number): void {
  for (const [accountId, suffix] of [[accountA, 'a'], [accountB, 'b']] as const) {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(`auth-${suffix}`, `Synthetic ${suffix}`, `${suffix}@synthetic.invalid`, 1, now, now);
    db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(accountId, `auth-${suffix}`, 'synthetic');
    db.prepare('INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
      .run(`credential-${suffix}`, `subject-${suffix}`, 'credential', `auth-${suffix}`, 'synthetic-password-hash', now, now);
    addSession(db, `session-${suffix}`, `auth-${suffix}`, now);
    for (const [kind, data] of [['profile', { name: `Synthetic ${suffix}`, age: 18 }],
      ['preferences', { appMode: 'basic', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise',
        trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: [], remindersEnabled: false }]] as const) {
      db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run(accountId, kind, 2, JSON.stringify(data));
      db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?)').run(accountId, kind, 1, JSON.stringify({ syntheticHistory: suffix }), 'synthetic-old');
      db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?)').run(accountId, kind, 2, JSON.stringify(data), 'synthetic-current');
    }
  }
  addSession(db, 'session-a-other', 'auth-a', now);
}

function addSession(db: Sqlite, id: string, authUserId: string, now: number): void {
  db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)')
    .run(id, now + 86_400_000, `synthetic-token-${id}`, now, now, authUserId);
}

async function fixture<T>(run: (f: Fixture) => T | Promise<T>, lifecycleSchema = true): Promise<T> {
  const testsDir = dirname(fileURLToPath(import.meta.url));
  const apiRoot = resolve(testsDir, basename(dirname(testsDir)) === 'dist' ? '../..' : '..');
  const scratch = join(apiRoot, '.scratch');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(scratch, 'lifecycle-'));
  const databases = new Set<Sqlite>();
  const ledgers = new Set<ExistingSuppressionLedger>();
  const cleanup = () => {
    const errors: unknown[] = [];
    for (const ledger of ledgers) { try { ledger.close(); } catch (error) { errors.push(error); } }
    ledgers.clear();
    for (const db of databases) { try { if (db.open) db.close(); } catch (error) { errors.push(error); } }
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Synthetic lifecycle cleanup failed');
  };
  const cancel = (status: number) => {
    try { cleanup(); } catch (error) { console.error('Lifecycle cancellation cleanup failed', error); }
    finally { process.exit(status); }
  };
  const sigint = () => cancel(130);
  const sigterm = () => cancel(143);
  process.once('SIGINT', sigint); process.once('SIGTERM', sigterm);
  let failed = false;
  try {
    const open = (path: string) => {
      const db = new Database(path); databases.add(db);
      db.pragma('foreign_keys = ON'); db.pragma('synchronous = FULL'); db.pragma('journal_mode = DELETE');
      if (path !== ':memory:') chmodSync(path, 0o600);
      return db;
    };
    const db = open(join(root, 'app.sqlite'));
    applyLegacy(db);
    const now = Date.now(); seed(db, now);
    if (lifecycleSchema) db.exec(lifecycleMigration.sql);
    const ledgerPath = join(root, 'authority.sqlite');
    const authority = open(ledgerPath);
    authority.exec(suppressionLedgerSchema);
    authority.prepare('INSERT INTO suppression_authority VALUES(?,0)').run('synthetic-lifecycle-authority-v1');
    authority.close();
    const openLedger = (path = ledgerPath, minimum = 0) => {
      const ledger = new ExistingSuppressionLedger(path, 'synthetic-lifecycle-authority-v1', minimum);
      ledgers.add(ledger); return ledger;
    };
    const ledger = openLedger();
    const f: Fixture = { root, db, ledgerPath, ledger, now, open, openLedger,
      closeLedger: value => { value.close(); ledgers.delete(value); },
      lifecycle: (source = db, authorityLedger = ledger, adapters = []) => new AccountLifecycle(source, adapters, authorityLedger, () => f.now) };
    return await run(f);
  } catch (error) { failed = true; throw error; }
  finally {
    try { cleanup(); }
    catch (error) { if (!failed) throw error; console.error('Cleanup failed after lifecycle test failure', error); }
    finally { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); }
  }
}

function installGrant(f: Fixture, overrides: Partial<{ accountId: string; sessionId: string; epoch: number;
  purpose: 'account_delete' | 'account_export'; expiresAt: number; consumedAt: number | null }> = {}): string {
  const token = secret();
  f.db.prepare('INSERT INTO account_action_grants VALUES(?,?,?,?,?,?,?,?,?)').run(hash(token), overrides.accountId ?? accountA,
    overrides.sessionId ?? contextA.sessionId, overrides.epoch ?? 0, overrides.purpose ?? 'account_delete', 'password',
    f.now, overrides.expiresAt ?? f.now + 300_000, overrides.consumedAt ?? null);
  return token;
}
function disable(f: Fixture, lifecycle = f.lifecycle()) {
  const request = intent(); lifecycle.initiate(contextA, 'delete-a', request);
  const result = lifecycle.confirm(contextA, request.requestId, confirmation(installGrant(f)));
  return { request, result, lifecycle };
}

test('independent migration 10 backfills exact 1..7 accounts and preserves legacy rows, checksums and triggers', () => fixture(async f => {
  const trainingTables = seedTrainingAndPhone(f.db, f.now);
  const purchases = new ApplePurchaseService(f.db, purchaseConfig, { verify: async () => purchaseProof(f.now) }, () => f.now);
  assert.equal((await purchases.deliver(accountA, delivery())).status, 'delivered');
  const before = Object.fromEntries([...new Set([...trainingTables, 'user', 'session', 'account', 'form_accounts', 'form_migrations',
    'phone_challenges', 'phone_operations', 'apple_purchase_owners', 'apple_purchase_transactions', 'apple_purchase_observations',
    'apple_purchase_grants', 'apple_purchase_commands', 'apple_purchase_deliveries'])]
    .map(table => [table, rows(f.db, table)]));
  const oldTriggers = triggers(f.db);
  assert.equal(lifecycleMigration.version, 10);
  f.db.exec(lifecycleMigration.sql);
  assert.deepEqual(f.db.prepare('SELECT account_id,state,epoch,disabled_at_ms,suppression_seq FROM account_lifecycle ORDER BY account_id').all(),
    [accountA, accountB].map(account_id => ({ account_id, state: 'active', epoch: 0, disabled_at_ms: null, suppression_seq: null })));
  for (const [table, original] of Object.entries(before)) assert.deepEqual(rows(f.db, table), original);
  for (const trigger of oldTriggers) assert.deepEqual(triggers(f.db).find(row => row.name === trigger.name), trigger);
  const newId = randomUUID();
  f.db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run('auth-c', 'Synthetic C', 'c@synthetic.invalid', 1, f.now, f.now);
  f.db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(newId, 'auth-c', 'synthetic');
  assert.deepEqual(f.db.prepare('SELECT state,epoch FROM account_lifecycle WHERE account_id=?').get(newId), { state: 'active', epoch: 0 });
  integrity(f.db);
}, false));

test('lifecycle monotonic state, identity and auth SQL boundaries reject resurrection and retain other accounts', () => fixture(f => {
  disable(f);
  for (const sql of ["UPDATE account_lifecycle SET state='active',disabled_at_ms=NULL,suppression_seq=NULL WHERE account_id=?",
    'UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?', 'DELETE FROM account_lifecycle WHERE account_id=?'])
    assert.throws(() => f.db.prepare(sql).run(accountA));
  assert.throws(() => f.db.prepare('UPDATE account_lifecycle SET account_id=? WHERE account_id=?').run(randomUUID(), accountA));
  assert.throws(() => addSession(f.db, 'new-a', 'auth-a', f.now), /account_disabled/);
  assert.throws(() => f.db.prepare('UPDATE session SET userId=? WHERE id=?').run('auth-a', 'session-b'), /account_disabled/);
  assert.throws(() => f.db.prepare('UPDATE "user" SET name=? WHERE id=?').run('resurrected', 'auth-a'), /account_disabled/);
  assert.throws(() => f.db.prepare('UPDATE account SET password=? WHERE userId=?').run('new-synthetic-hash', 'auth-a'), /account_disabled/);
  assert.throws(() => f.db.prepare('UPDATE account SET userId=? WHERE userId=?').run('auth-a', 'auth-b'), /account_disabled/);
  assert.throws(() => f.db.prepare('INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run('new-provider-a', 'new-subject-a', 'synthetic-provider', 'auth-a', f.now, f.now), /account_disabled/);
  assert.equal(assertAccountActive(f.db, accountB), 0); assertActive(f.db, contextB);
  integrity(f.db);
}));

test('existing independent ledger is immutable, idempotent, conflict rejecting and durable across reopen', () => fixture(f => {
  const input = { accountId: accountA, authUserId: 'auth-a', epoch: 1, requestId: randomUUID(), disabledAtMs: f.now };
  const recorded = f.ledger.recordDisable(input);
  assert.deepEqual(recorded, { ...input, sequence: 1 });
  assert.deepEqual(f.ledger.recordDisable(input), recorded); assert.equal(f.ledger.currentSequence(), 1);
  for (const changed of [{ authUserId: 'auth-b' }, { epoch: 2 }, { requestId: randomUUID() }])
    assert.throws(() => f.ledger.recordDisable({ ...input, ...changed }), /conflict/);
  const direct = f.open(f.ledgerPath);
  assert.throws(() => direct.exec('UPDATE suppression_records SET epoch=2'), /suppression_immutable/);
  assert.throws(() => direct.exec('DELETE FROM suppression_records'), /suppression_retained/);
  assert.throws(() => direct.exec('DELETE FROM suppression_authority'), /suppression_authority_retained/);
  assert.throws(() => direct.exec('UPDATE suppression_authority SET sequence=0'), /suppression_sequence/);
  f.closeLedger(f.ledger);
  const reopened = f.openLedger(f.ledgerPath, 1);
  assert.deepEqual(reopened.lookup(accountA), recorded); assert.equal(reopened.lookup(accountB), null);
  const replay: DisableRecord[] = [];
  assert.equal(reopened.reconcileRestore(entry => replay.push(entry)), 1); assert.deepEqual(replay, [recorded]);
}));

test('missing, wrong identity, stale, empty and unbound suppression authorities fail closed without recreation', () => fixture(f => {
  const missing = join(f.root, 'missing.sqlite');
  assert.throws(() => f.openLedger(missing)); assert.equal(existsSync(missing), false);
  assert.throws(() => new ExistingSuppressionLedger(f.ledgerPath, 'wrong-identity', 0));
  assert.throws(() => f.openLedger(f.ledgerPath, 1), /currentness/);
  const empty = join(f.root, 'empty.sqlite'); f.open(empty).close();
  assert.throws(() => f.openLedger(empty));
  const link = join(f.root, 'authority-link.sqlite'); symlinkSync(f.ledgerPath, link);
  assert.throws(() => f.openLedger(link));
  assert.throws(() => assertActive(f.db, contextA), domain('suppression_authority_required', 503));
  bindSuppressionAuthority(f.db, f.ledger);
  assertActive(f.db, contextA);
  const lifecycle = f.lifecycle(); const request = intent(); lifecycle.initiate(contextA, 'delete-a', request);
  // One-sided authority advancement represents an inconsistent/stale currentness source, not valid evidence.
  f.open(f.ledgerPath).exec('UPDATE suppression_authority SET sequence=sequence+1');
  assert.throws(() => assertActive(f.db, contextA), domain('suppression_authority_unavailable', 503));
  assert.throws(() => lifecycle.status(request.requestId, request.statusSecret), domain('suppression_authority_unavailable', 503));
  assert.throws(() => f.lifecycle());
}));

test('authority binding checks continue after initialization and reject permission loss or file replacement', () => fixture(f => {
  f.lifecycle();
  chmodSync(f.ledgerPath, 0o644);
  assert.throws(() => assertActive(f.db, contextA), domain('suppression_authority_unavailable', 503));
  chmodSync(f.ledgerPath, 0o600); assertActive(f.db, contextA);
  const replacement = join(f.root, 'replacement.sqlite');
  copyFileSync(f.ledgerPath, replacement); chmodSync(replacement, 0o600);
  rmSync(f.ledgerPath); copyFileSync(replacement, f.ledgerPath); chmodSync(f.ledgerPath, 0o600);
  assert.throws(() => assertActive(f.db, contextA), domain('suppression_authority_unavailable', 503));
}));

test('session ownership, expiry and epoch are rechecked before and after write effects', () => fixture(f => {
  f.lifecycle();
  for (const invalid of [{ ...contextA, sessionId: 'missing' }, { ...contextA, sessionId: 'session-b' },
    { ...contextA, authUserId: 'auth-b' }, { ...contextA, accountId: accountB }])
    assert.throws(() => assertActive(f.db, invalid), domain('account_session_invalid', 401));
  f.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(Date.now() - 1, 'session-a');
  assert.throws(() => assertActive(f.db, contextA), domain('account_session_invalid', 401));
  f.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(f.now + 86_400_000, 'session-a');
  assert.throws(() => assertActive(f.db, { ...contextA, epoch: 1 }), domain('account_epoch_changed', 403));
  assert.throws(() => withActiveWrite(f.db, contextA, () => {
    f.db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?').run('{"late":"forbidden"}', accountA, 'profile');
    f.db.prepare('DELETE FROM session WHERE id=?').run('session-a');
  }), domain('account_session_invalid', 401));
  assertActive(f.db, contextA);
  assert.equal((f.db.prepare('SELECT data FROM documents WHERE account_id=? AND kind=?').get(accountA, 'profile') as { data: string }).data.includes('forbidden'), false);
  const second = f.open(join(f.root, 'app.sqlite')); bindSuppressionAuthority(second, f.ledger);
  f.ledger.recordDisable({ accountId: accountA, authUserId: 'auth-a', epoch: 1, requestId: randomUUID(), disabledAtMs: f.now });
  assert.throws(() => withActiveWrite(second, contextA, () => assert.fail('stale effect executed')), domain('account_disabled', 403));
  assert.throws(() => assertPrincipalActive(f.db, 'auth-a'), domain('account_disabled', 403));
}));

test('canonical adult eligibility uses only current own profile age and revision without age disclosure', () => fixture(f => {
  f.lifecycle();
  let revision = 2;
  const cases: readonly [unknown, 'eligible' | 'not_adult' | 'unknown'][] = [[13, 'not_adult'], [17, 'not_adult'],
    [18, 'eligible'], [120, 'eligible'], [null, 'unknown'], [12, 'unknown'], [121, 'unknown'], ['18', 'unknown'], [18.5, 'unknown']];
  for (const [age, status] of cases) {
    revision += 1;
    const data = JSON.stringify({ age });
    f.db.prepare('UPDATE documents SET revision=?,data=? WHERE account_id=? AND kind=?').run(revision, data, accountA, 'profile');
    f.db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?)').run(accountA, 'profile', revision, data, 'synthetic');
    assert.deepEqual(adultEligibility(f.db, contextA), { policy: 'self_reported_adult_v1', status, profileRevision: revision });
    assert.deepEqual(adultEligibility(f.db, contextB), { policy: 'self_reported_adult_v1', status: 'eligible', profileRevision: 2 });
  }
  f.db.prepare('UPDATE documents SET revision=revision+1,data=? WHERE account_id=? AND kind=?').run('{}', accountA, 'profile');
  assert.equal(adultEligibility(f.db, contextA).status, 'unknown');
  f.db.prepare('DELETE FROM document_revisions WHERE account_id=? AND kind=?').run(accountA, 'profile');
  f.db.prepare('DELETE FROM documents WHERE account_id=? AND kind=?').run(accountA, 'profile');
  assert.deepEqual(adultEligibility(f.db, contextA), { policy: 'self_reported_adult_v1', status: 'unknown', profileRevision: null });
  disable(f);
  assert.throws(() => adultEligibility(f.db, contextA), domain('account_session_invalid', 401));
}));

test('trusted subject eligibility requires the active actor transaction and creates no subject identity or profile', () => fixture(f => {
  f.lifecycle();
  const unknown = { policy: 'self_reported_adult_v1', status: 'unknown', profileRevision: null };
  assert.throws(() => subjectEligibility(f.db, contextB, accountA), domain('subject_authorization_transaction_required', 503));
  withActiveWrite(f.db, contextB, () => {
    assert.deepEqual(subjectEligibility(f.db, contextB, accountA), { policy: 'self_reported_adult_v1', status: 'eligible', profileRevision: 2 });
    const before = count(f.db, 'form_accounts');
    assert.deepEqual(subjectEligibility(f.db, contextB, randomUUID()), unknown);
    assert.equal(count(f.db, 'form_accounts'), before);
  });
  disable(f);
  withActiveWrite(f.db, contextB, () => assert.deepEqual(subjectEligibility(f.db, contextB, accountA), unknown));
  assert.throws(() => withActiveWrite(f.db, contextA, () => subjectEligibility(f.db, contextA, accountB)), domain('account_session_invalid', 401));
  f.closeLedger(f.ledger);
  assert.throws(() => withActiveWrite(f.db, contextB, () => subjectEligibility(f.db, contextB, accountA)), domain('suppression_authority_unavailable', 503));
}));

test('strict lifecycle request schemas reject forged ownership, login proofs, altered purpose and extra fields', () => {
  const request = intent(); const grant = secret();
  assert.ok(deletionRequest.safeParse(request).success);
  assert.ok(actionGrantRequest.safeParse({ purpose: 'account_delete', password: 'synthetic-password' }).success);
  for (const extra of [{ accountId: accountB }, { authUserId: 'auth-b' }, { epoch: 1 }, { sessionId: 'session-b' }, { complete: true }])
    assert.equal(deletionRequest.safeParse({ ...request, ...extra }).success, false);
  for (const bad of [{ purpose: 'login', password: 'synthetic' }, { purpose: 'account_delete', otp: '123456' },
    { purpose: 'account_delete', password: 'synthetic', verified: true }, { purpose: 'account_delete', password: '' }])
    assert.equal(actionGrantRequest.safeParse(bad).success, false);
  assert.equal(deletionRequest.safeParse({ ...request, confirmation: 'disable_only' }).success, false);
  assert.equal(deletionRequest.safeParse({ ...request, policyVersion: 'old-policy' }).success, false);
  assert.equal(deletionRequest.safeParse({ ...request, statusSecret: 'too-short' }).success, false);
  assert.equal(deletionConfirmation.safeParse({ ...confirmation(grant), accountId: accountA }).success, false);
  assert.equal(exportRequest.safeParse({ grant, statusSecret: request.statusSecret }).success, false);
  assert.equal(deletionStatusRequest.safeParse({ requestId: request.requestId, secret: request.statusSecret }).success, false);
});

test('password grants hash secrets, use the maintained verifier and reject wrong or unqualified authentication', () => fixture(async f => {
  const lifecycle = f.lifecycle();
  await assert.rejects(lifecycle.issueGrant(contextA, { purpose: 'account_delete', password: 'synthetic-wrong' }, async () => false),
    domain('action_reauthentication_failed', 403));
  await assert.rejects(lifecycle.issueGrant(contextA, { purpose: 'account_delete', password: 'synthetic-wrong' }, async () => { throw new Error('synthetic-provider-secret'); }),
    error => { assert.ok(domain('action_reauthentication_failed', 403)(error)); assert.equal(JSON.stringify(error).includes('synthetic-provider-secret'), false); return true; });
  assert.equal(count(f.db, 'account_action_grants'), 0);
  let verified = 0;
  const result = await lifecycle.issueGrant(contextA, { purpose: 'account_export', password: 'synthetic-correct' }, async () => { verified += 1; return true; });
  assert.equal(verified, 1); assert.equal(result.purpose, 'account_export'); assert.equal(result.method, 'password');
  assert.equal((f.db.prepare('SELECT token_hash FROM account_action_grants').get() as { token_hash: string }).token_hash, hash(result.grant));
  assert.equal(JSON.stringify(rows(f.db, 'account_action_grants')).includes(result.grant), false);
  f.db.prepare('DELETE FROM account WHERE userId=?').run('auth-b');
  await assert.rejects(lifecycle.issueGrant(contextB, { purpose: 'account_delete', password: 'synthetic' }, async () => assert.fail('unqualified verifier invoked')),
    domain('action_reauthentication_unqualified', 501));
}));

test('wrong-purpose, account, session, epoch, expired and consumed grants cannot confirm deletion', () => fixture(f => {
  const lifecycle = f.lifecycle(); const request = intent(); lifecycle.initiate(contextA, 'delete-a', request);
  const invalid = [installGrant(f, { purpose: 'account_export' }), installGrant(f, { accountId: accountB, sessionId: contextB.sessionId }),
    installGrant(f, { sessionId: 'session-a-other' }), installGrant(f, { epoch: 1 }),
    installGrant(f, { expiresAt: f.now }), installGrant(f, { consumedAt: f.now }), secret()];
  for (const grant of invalid) {
    assert.throws(() => lifecycle.confirm(contextA, request.requestId, confirmation(grant)), domain('action_grant_invalid', 403));
    assert.equal(f.ledger.currentSequence(), 0); assertActive(f.db, contextA);
  }
  assert.throws(() => lifecycle.confirm(contextB, request.requestId, confirmation(installGrant(f, { accountId: accountB, sessionId: contextB.sessionId }))), domain('not_found', 404));
  const exportGrant = installGrant(f, { purpose: 'account_export' });
  lifecycle.consumeExportGrant(contextA, exportGrant);
  assert.throws(() => lifecycle.consumeExportGrant(contextA, exportGrant), domain('action_grant_invalid', 403));
  assert.throws(() => lifecycle.consumeExportGrant(contextA, installGrant(f)), domain('action_grant_invalid', 403));
}));

test('deletion intent deduplicates exactly, changed intent conflicts and status receipts do not disclose secrets', () => fixture(f => {
  const lifecycle = f.lifecycle(); const request = intent();
  const first = lifecycle.initiate(contextA, 'delete-a', request);
  assert.deepEqual(lifecycle.initiate(contextA, 'delete-a', request), first);
  assert.equal(count(f.db, 'account_deletion_requests'), 1);
  for (const changed of [{ ...request, statusSecret: secret() }, { ...request, requestId: randomUUID() }])
    assert.throws(() => lifecycle.initiate(contextA, 'delete-a', changed), domain('idempotency_mismatch', 409));
  assert.throws(() => lifecycle.initiate(contextA, 'different-key', request), domain('idempotency_mismatch', 409));
  assert.throws(() => lifecycle.initiate(contextA, undefined, request), domain('idempotency_key_required', 400));
  assert.throws(() => lifecycle.initiate(contextB, 'delete-b', { ...request, statusSecret: secret() }), domain('deletion_request_conflict', 409));
  for (const [id, token] of [[request.requestId, secret()], [randomUUID(), request.statusSecret], [request.requestId, 'short']])
    assert.throws(() => lifecycle.status(id!, token!), domain('status_receipt_invalid', 401));
  assert.equal((f.db.prepare('SELECT status_token_hash FROM account_deletion_requests').get() as { status_token_hash: string }).status_token_hash, hash(request.statusSecret));
  const status = lifecycle.status(request.requestId, request.statusSecret);
  assert.equal(status.phase, 'awaiting_reauthentication'); assert.equal(status.complete, false); assert.equal(status.disabled, false);
  for (const excluded of [request.statusSecret, hash(request.statusSecret), 'synthetic-password-hash', 'synthetic-token-session-a'])
    assert.equal(JSON.stringify(status).includes(excluded), false);
  f.now += 30 * 86_400_000;
  assert.throws(() => lifecycle.status(request.requestId, request.statusSecret), domain('status_receipt_invalid', 401));
}));

test('confirmation disables every own session and grant, denies receipt replay and never claims whole deletion', () => fixture(async f => {
  const lifecycle = f.lifecycle();
  command(f.db, accountA, 'synthetic-operation', 'receipt-a', { value: 1 }, () => assertActive(f.db, contextA),
    () => ({ status: 201, body: { privateMarker: 'synthetic-old-receipt' } }));
  installGrant(f, { purpose: 'account_export' }); installGrant(f, { sessionId: 'session-a-other' });
  const { request, result } = disable(f, lifecycle);
  assert.equal(result.phase, 'disabled_pending_purge'); assert.equal(result.disabled, true);
  assert.equal(result.complete, false); assert.equal(result.localPurged, false); assert.equal(result.backupExpiryAt, null);
  assert.equal(result.billingCancellation, 'not_performed');
  assert.deepEqual(f.db.prepare('SELECT id,userId FROM session ORDER BY id').all(), [{ id: 'session-b', userId: 'auth-b' }]);
  assert.equal(count(f.db, 'account_action_grants'), 0);
  assert.equal(f.ledger.lookup(accountA)?.epoch, 1);
  assert.throws(() => command(f.db, accountA, 'synthetic-operation', 'receipt-a', { value: 1 }, () => {},
    () => assert.fail('disabled receipt replay executed effect')), domain('account_disabled', 403));
  assert.throws(() => lifecycle.confirm(contextA, request.requestId, confirmation(secret())), domain('account_session_invalid', 401));
  await assert.rejects(lifecycle.issueGrant(contextA, { purpose: 'account_delete', password: 'synthetic' }, async () => assert.fail('disabled verifier invoked')),
    domain('account_session_invalid', 401));
  assert.equal(lifecycle.status(request.requestId, request.statusSecret).complete, false);
  assertActive(f.db, contextB); integrity(f.db);
}));

test('ledger-first evidence survives main rollback; status stays unknown until restart reconciles safely', () => fixture(f => {
  const lifecycle = f.lifecycle(); const request = intent(); lifecycle.initiate(contextA, 'delete-a', request);
  const grant = installGrant(f);
  f.db.exec("CREATE TRIGGER synthetic_main_failure BEFORE UPDATE OF state ON account_lifecycle BEGIN SELECT RAISE(ABORT,'synthetic_main_failure'); END");
  assert.throws(() => lifecycle.confirm(contextA, request.requestId, confirmation(grant)), domain('deletion_effect_unknown', 503));
  assert.equal(f.ledger.currentSequence(), 1);
  assert.deepEqual(f.db.prepare('SELECT state,epoch FROM account_lifecycle WHERE account_id=?').get(accountA), { state: 'active', epoch: 0 });
  assert.equal(count(f.db, 'session'), 3);
  assert.throws(() => assertActive(f.db, contextA), domain('account_disabled', 403));
  const unknown = lifecycle.status(request.requestId, request.statusSecret);
  assert.equal(unknown.phase, 'disabled_pending_reconciliation'); assert.equal(unknown.disabled, true); assert.equal(unknown.complete, false);
  f.db.exec('DROP TRIGGER synthetic_main_failure');
  f.db.close(); f.closeLedger(f.ledger);
  const reopenedDb = f.open(join(f.root, 'app.sqlite')); const reopenedLedger = f.openLedger(f.ledgerPath, 1);
  const restarted = f.lifecycle(reopenedDb, reopenedLedger);
  assert.equal(restarted.status(request.requestId, request.statusSecret).phase, 'disabled_pending_purge');
  assert.equal(count(reopenedDb, 'session'), 1);
  assert.throws(() => assertAccountActive(reopenedDb, accountA), domain('account_disabled', 403));
  restarted.reconcileRestore(); assert.equal(reopenedLedger.currentSequence(), 1); integrity(reopenedDb);
}));

test('old synthetic application backup is suppressed using current independent ledger before admission', () => fixture(async f => {
  const lifecycle = f.lifecycle(); const backup = join(f.root, 'pre-disable.sqlite');
  seedConfirmedCapture(f.db, contextA); seedConfirmedCapture(f.db, contextB);
  await f.db.backup(backup); chmodSync(backup, 0o600);
  const { request } = disable(f, lifecycle);
  const restored = f.open(backup);
  assert.equal(count(restored, 'session'), 3);
  assert.throws(() => assertActive(restored, contextA), domain('suppression_authority_required', 503));
  const restoredLifecycle = f.lifecycle(restored, f.ledger);
  assert.throws(() => restoredLifecycle.assertActive(contextA), domain('account_session_invalid', 401));
  assert.throws(() => assertAccountActive(restored, accountA), domain('account_disabled', 403));
  assert.equal(count(restored, 'session'), 1); assertActive(restored, contextB);
  assert.throws(() => new Domain(restored).confirmedCapture(accountA), domain('account_disabled', 403));
  assert.equal(new Domain(restored).confirmedCapture(accountB)?.record.pin.accountId, accountB);
  assert.equal(count(restored, 'account_deletion_requests'), 0);
  assert.throws(() => restoredLifecycle.status(request.requestId, request.statusSecret), domain('status_receipt_invalid', 401));
  assert.throws(() => addSession(restored, 'resurrected-session', 'auth-a', f.now), /account_disabled/);
  integrity(restored);
}));

test('adapter suppression uncertainty remains unknown and prevents restore admission without weakening ledger evidence', () => fixture(f => {
  let suppressCalls = 0;
  const adapter: LifecycleAdapter = {
    category: 'synthetic_module', inventory: () => ({ category: 'synthetic_module', status: 'pending' }),
    export: () => ({ category: 'synthetic_module', status: 'unavailable' }),
    suppress: () => { suppressCalls += 1; return { status: 'unknown' }; },
    purge: () => ({ status: 'unavailable' }), verifySuppressed: () => ({ status: 'unknown' }),
  };
  const lifecycle = f.lifecycle(f.db, f.ledger, [adapter]);
  const { request, result } = disable(f, lifecycle);
  assert.equal(suppressCalls, 1);
  assert.equal(result.steps.find(step => step.category === 'synthetic_module')?.status, 'unknown');
  assert.equal(result.complete, false); assert.equal(result.localPurged, false);
  assert.throws(() => lifecycle.reconcileRestore(), /Module suppression admission pending/);
  assert.equal(f.ledger.lookup(accountA)?.requestId, request.requestId);
  assert.throws(() => assertAccountActive(f.db, accountA), domain('account_disabled', 403));
}));

function seedTrainingAndPhone(db: Sqlite, now: number): readonly string[] {
  db.prepare('INSERT INTO exercises(id,data,retired) VALUES(?,?,0)').run('synthetic-exercise', '{}');
  db.prepare('INSERT INTO promos VALUES(?,?,?)').run('synthetic-promo', '{}', 2);
  for (const [accountId, suffix, phone] of [[accountA, 'a', '+12025550111'], [accountB, 'b', '+12025550122']] as const) {
    const data = JSON.stringify({ name: `synthetic-private-training-${suffix}` });
    db.prepare('INSERT INTO plans VALUES(?,?,1,0,?,?,?)').run(accountId, `plan-${suffix}`, data, 'synthetic', 'synthetic');
    db.prepare('INSERT INTO plan_revisions VALUES(?,?,1,?,?)').run(accountId, `plan-${suffix}`, data, 'synthetic');
    db.prepare('INSERT INTO plan_item_ids VALUES(?,?,?,?)').run(accountId, `plan-${suffix}`, `item-${suffix}`, 'synthetic-exercise');
    db.prepare("INSERT INTO workout_sessions VALUES(?,?,?,1,1,?,'active',?,NULL)")
      .run(accountId, `workout-${suffix}`, `plan-${suffix}`, data, 'synthetic');
    db.prepare('INSERT INTO session_occurrences VALUES(?,?,?,?,?,0,?)')
      .run(accountId, `workout-${suffix}`, `occurrence-${suffix}`, `item-${suffix}`, 'synthetic-exercise', '{}');
    db.prepare("INSERT INTO performed_sets VALUES(?,?,?,?,1,1,5,20,'confirmed',?,?)")
      .run(accountId, `workout-${suffix}`, `set-${suffix}`, `occurrence-${suffix}`, 'synthetic', 'synthetic');
    db.prepare('INSERT INTO set_revisions VALUES(?,?,?,1,?,?)')
      .run(accountId, `workout-${suffix}`, `set-${suffix}`, data, 'synthetic');
    db.prepare("INSERT INTO command_receipts VALUES(?,?,'synthetic-key','synthetic-intent',201,?,?)")
      .run(accountId, 'synthetic-operation', data, 'synthetic');
    db.prepare("INSERT INTO transcription_attempts VALUES(?,?,?,'synthetic-intent','succeeded',?,NULL,?,?)")
      .run(accountId, `transcript-${suffix}`, `transcript-key-${suffix}`, `synthetic-private-text-${suffix}`, 'synthetic', 'synthetic');
    db.prepare("INSERT INTO entitlement_grants VALUES(?,?,'form_plus','promo','synthetic-promo',?,?,'zero_charge')")
      .run(accountId, `promo-grant-${suffix}`, 'synthetic', 'synthetic');
    db.prepare('UPDATE "user" SET phoneNumber=?,phoneNumberVerified=1 WHERE id=?').run(phone, `auth-${suffix}`);
    db.prepare("INSERT INTO phone_challenges VALUES(?,?,?,?,'pending',NULL,?,?,?,1,0,NULL,?)")
      .run(`challenge-${suffix}`, phone, `synthetic-binding-${suffix}`, `start-${suffix}`, now, now + 300_000, now, `auth-${suffix}`);
    db.prepare("INSERT INTO phone_operations VALUES(?,'start',?,'synthetic-intent','done',?)")
      .run(`challenge-${suffix}`, `phone-key-${suffix}`, now);
  }
  db.prepare("INSERT INTO phone_challenges VALUES(?,?,?,?,'pending',NULL,?,?,?,1,0,NULL,NULL)")
    .run('unbound-a', '+12025550111', 'synthetic-unbound-binding', 'synthetic-unbound-start', now, now + 300_000, now);
  db.prepare("INSERT INTO phone_operations VALUES(?,'start',?,'synthetic-intent','done',?)")
    .run('unbound-a', 'synthetic-unbound-operation', now);
  return ['command_receipts', 'transcription_attempts', 'set_revisions', 'performed_sets', 'session_occurrences',
    'workout_sessions', 'plan_item_ids', 'plan_revisions', 'plans', 'document_revisions', 'documents', 'entitlement_grants'];
}

test('synthetic local purge removes exact current and historical scope while retaining immutable purchase proofs and identity shell', () => fixture(async f => {
  const lifecycle = f.lifecycle(); const core = seedTrainingAndPhone(f.db, f.now);
  seedConfirmedCapture(f.db, contextA); seedConfirmedCapture(f.db, contextB);
  assert.equal(new Domain(f.db).confirmedCapture(accountA)?.revision, 1);
  f.db.prepare('INSERT INTO account(id,accountId,providerId,userId,accessToken,refreshToken,idToken,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('synthetic-oauth-a', 'synthetic-provider-subject-a', 'google', 'auth-a', 'synthetic-revocation-access',
      'synthetic-revocation-refresh', 'synthetic-provider-id', f.now, f.now);
  const purchases = new ApplePurchaseService(f.db, purchaseConfig, { verify: async () => purchaseProof(f.now) }, () => f.now);
  assert.equal((await purchases.deliver(accountA, delivery())).status, 'delivered');
  const request = intent(); lifecycle.initiate(contextA, 'delete-a', request);
  assert.throws(() => lifecycle.purgeLocal(request.requestId), domain('suppression_required', 409));
  assert.throws(() => lifecycle.purgeLocal(randomUUID()), domain('not_found', 404));
  lifecycle.confirm(contextA, request.requestId, confirmation(installGrant(f)));
  const second = Object.fromEntries(core.map(table => [table, f.db.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY rowid`).all(accountB)]));
  const retained = Object.fromEntries(['apple_purchase_owners', 'apple_purchase_transactions', 'apple_purchase_deliveries', 'apple_purchase_observations',
    'apple_purchase_commands', 'user', 'form_accounts', 'exercises', 'promos'].map(table => [table, rows(f.db, table)]));
  const secondCredentials = f.db.prepare('SELECT * FROM account WHERE userId=?').all('auth-b');
  const pendingProvider = f.db.prepare("SELECT * FROM account WHERE userId=? AND providerId<>'credential'").all('auth-a');
  const secondPhone = f.db.prepare('SELECT * FROM phone_challenges WHERE auth_user_id=?').all('auth-b');
  const secondOperations = f.db.prepare("SELECT * FROM phone_operations WHERE challenge_id='challenge-b'").all();
  const result = lifecycle.purgeLocal(request.requestId);
  assert.equal(result.phase, 'pending_external'); assert.equal(result.localPurged, true); assert.equal(result.complete, false);
  assert.equal(result.backupExpiryAt, null); assert.equal(result.billingCancellation, 'not_performed');
  assert.equal(result.steps.find(step => step.category === 'purchase_proofs')?.status, 'retained');
  assert.equal(result.steps.find(step => step.category === 'auth_identity')?.status, 'retained');
  for (const table of core) {
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(accountA), []);
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY rowid`).all(accountB), second[table]);
  }
  assert.deepEqual(f.db.prepare("SELECT * FROM account WHERE userId=? AND providerId='credential'").all('auth-a'), []);
  assert.deepEqual(f.db.prepare('SELECT * FROM account WHERE userId=?').all('auth-a'), pendingProvider);
  assert.deepEqual(f.db.prepare('SELECT * FROM account WHERE userId=?').all('auth-b'), secondCredentials);
  assert.deepEqual(rows(f.db, 'phone_challenges'), secondPhone); assert.deepEqual(rows(f.db, 'phone_operations'), secondOperations);
  assert.equal(count(f.db, 'apple_purchase_grants'), 0);
  for (const [table, original] of Object.entries(retained)) assert.deepEqual(rows(f.db, table), original);
  assert.equal(f.ledger.lookup(accountA)?.requestId, request.requestId);
  for (const hidden of ['synthetic-revocation-access', 'synthetic-revocation-refresh', 'synthetic-provider-id'])
    assert.equal(JSON.stringify(result).includes(hidden), false);
  assert.throws(() => purchases.accountBinding(accountA), domain('account_disabled', 403));
  for (const table of ['documents', 'document_revisions'])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table} WHERE account_id=? AND kind=?`).get(accountA, confirmedCaptureKind) as { n: number }).n, 0);
  assert.equal((f.db.prepare('SELECT count(*) n FROM command_receipts WHERE account_id=? AND operation=?').get(accountA, confirmedCaptureOperation) as { n: number }).n, 0);
  assert.equal(new Domain(f.db).confirmedCapture(accountB)?.revision, 1);
  assert.equal(lifecycle.purgeLocal(request.requestId).complete, false); assertActive(f.db, contextB); integrity(f.db);
}));

test('unadapted synthetic module storage prevents local purge qualification and whole deletion completion', () => fixture(f => {
  const lifecycle = f.lifecycle();
  // This test-only inventory marker exercises admission, and is not a placeholder for reserved migration 8.
  f.db.exec('CREATE TABLE activity_lifecycle_test_inventory(account_id TEXT NOT NULL REFERENCES form_accounts(id),value TEXT NOT NULL)');
  f.db.prepare('INSERT INTO activity_lifecycle_test_inventory VALUES(?,?)').run(accountA, 'synthetic-remaining-module-row');
  const { request } = disable(f, lifecycle);
  const result = lifecycle.purgeLocal(request.requestId);
  assert.equal(result.localPurged, false); assert.equal(result.complete, false); assert.equal(result.phase, 'pending_external');
  assert.equal(result.steps.find(step => step.category === 'activity')?.status, 'pending');
  assert.equal(count(f.db, 'activity_lifecycle_test_inventory'), 1);
}));

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>(resolve => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}

test('late maintained password verification cannot mint a purpose grant after disablement', () => fixture(async f => {
  const lifecycle = f.lifecycle(); const paused = deferred<boolean>(); let calls = 0;
  const pending = lifecycle.issueGrant(contextA, { purpose: 'account_export', password: 'synthetic' }, () => { calls += 1; return paused.promise; });
  const rejected = assert.rejects(pending, domain('account_session_invalid', 401));
  assert.equal(calls, 1); disable(f, lifecycle); paused.resolve(true); await rejected;
  assert.equal(count(f.db, 'account_action_grants'), 0);
}));

const purchaseConfig: AppleSandboxConfiguration = { bundleId: 'com.form.synthetic.lifecycle', products: [
  { productId: 'form.synthetic.lifetime', type: 'Non-Consumable', entitlement: 'form_plus' },
] };
function purchaseProof(now: number, transactionId = '10001'): VerifiedAppleTransaction {
  return { transactionId, originalTransactionId: '10000', bundleId: purchaseConfig.bundleId, environment: 'Sandbox',
    productId: 'form.synthetic.lifetime', type: 'Non-Consumable', appAccountToken: accountA, inAppOwnershipType: 'PURCHASED',
    purchaseDate: now - 1000, signedDate: now, quantity: 1 };
}
function delivery(transactionId = '10001'): AppleDeliveryRequest {
  return { transactionId, productId: 'form.synthetic.lifetime', jwsRepresentation: 'synthetic.lifecycle.signature', idempotencyKey: `synthetic:${transactionId}` };
}

test('immutable purchase ownership and exact proofs survive disablement; replays and future token deliveries deny grants', () => fixture(async f => {
  const lifecycle = f.lifecycle(); let verifies = 0;
  const purchases = new ApplePurchaseService(f.db, purchaseConfig, { verify: async () => { verifies += 1; return purchaseProof(f.now); } }, () => f.now);
  assert.deepEqual(purchases.accountBinding(accountA), { accountId: accountA, appAccountToken: accountA });
  assert.equal((await purchases.deliver(accountA, delivery())).status, 'delivered');
  const tables = ['apple_purchase_owners', 'apple_purchase_transactions', 'apple_purchase_deliveries', 'apple_purchase_observations', 'apple_purchase_grants'];
  const retained = Object.fromEntries(tables.map(table => [table, rows(f.db, table)]));
  disable(f, lifecycle);
  assert.throws(() => purchases.accountBinding(accountA), domain('account_disabled', 403));
  assert.throws(() => purchases.entitlements(accountA), domain('account_disabled', 403));
  assert.notEqual((await purchases.deliver(accountA, delivery())).status, 'delivered');
  assert.notEqual((await purchases.deliver(accountA, delivery('10002'))).status, 'delivered');
  assert.equal(verifies, 1);
  assert.deepEqual(await purchases.deliver(accountB, delivery()), { status: 'rejected', code: 'apple_account_token_mismatch' });
  for (const sql of ['UPDATE apple_purchase_owners SET account_id=?', 'UPDATE apple_purchase_transactions SET account_id=?',
    'UPDATE apple_purchase_transactions SET app_account_token=?']) assert.throws(() => f.db.prepare(sql).run(accountB));
  for (const table of ['apple_purchase_owners', 'apple_purchase_deliveries', 'apple_purchase_observations']) {
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`));
  }
  assert.throws(() => f.db.exec("UPDATE apple_purchase_observations SET exact_jws='forged-proof'"), /immutable_apple_purchase_observation/);
  assert.throws(() => f.db.exec("UPDATE apple_purchase_deliveries SET exact_jws='forged-proof'"), /immutable_apple_purchase_delivery/);
  for (const table of tables) assert.deepEqual(rows(f.db, table), retained[table]);
  assert.equal(count(f.db, 'apple_purchase_grants'), 1); integrity(f.db);
}));

test('purchase verification returning after disablement cannot commit ownership, grants or receipts', () => fixture(async f => {
  const lifecycle = f.lifecycle(); const paused = deferred<VerifiedAppleTransaction>(); let calls = 0;
  const purchases = new ApplePurchaseService(f.db, purchaseConfig, { verify: () => { calls += 1; return paused.promise; } }, () => f.now);
  const pending = purchases.deliver(accountA, delivery()); assert.equal(calls, 1);
  disable(f, lifecycle); paused.resolve(purchaseProof(f.now));
  assert.deepEqual(await pending, { status: 'rejected', code: 'account_disabled' });
  for (const table of ['apple_purchase_owners', 'apple_purchase_transactions', 'apple_purchase_grants', 'apple_purchase_deliveries']) assert.equal(count(f.db, table), 0);
}));

function syntheticWav(): Uint8Array {
  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
  return wav;
}

test('late synthetic transcription response is never stored or disclosed after disablement', () => fixture(async f => {
  const lifecycle = f.lifecycle(); const paused = deferred<Response>(); let uploads = 0;
  const transcription = new Transcription(f.db, { apiKey: 'synthetic-not-a-credential', allowCloudRequests: true,
    fetch: async () => { uploads += 1; return paused.promise; } });
  const pending = transcription.transcribe(accountA, 'synthetic-transcription', syntheticWav(), contextA);
  const rejected = assert.rejects(pending, domain('account_session_invalid', 401));
  assert.equal(uploads, 1); assert.equal(count(f.db, 'transcription_attempts'), 1);
  disable(f, lifecycle); paused.resolve(new Response(JSON.stringify({ text: 'synthetic-late-private-text' })));
  await rejected;
  assert.deepEqual(f.db.prepare('SELECT status,text FROM transcription_attempts').get(), { status: 'pending', text: null });
  assert.throws(() => transcription.get(accountA, (f.db.prepare('SELECT id FROM transcription_attempts').get() as { id: string }).id), domain('account_disabled', 403));
  assert.equal(JSON.stringify(rows(f.db, 'transcription_attempts')).includes('synthetic-late-private-text'), false);
}));

test('independent B3 migration 11 adds current mascot defaults and one new revision without changing history or explicit choices', () => fixture(f => {
  const historical = rows(f.db, 'document_revisions');
  const explicit = { mascot: 'buff', animationStyle: 'long', appMode: 'advanced', ownerMarker: 'synthetic-b' };
  f.db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?').run(JSON.stringify(explicit), accountB, 'preferences');
  assert.equal(mascotPreferencesMigration.version, 11); f.db.exec(mascotPreferencesMigration.sql);
  const current = f.db.prepare('SELECT revision,data FROM documents WHERE account_id=? AND kind=?').get(accountA, 'preferences') as { revision: number; data: string };
  assert.equal(current.revision, 3);
  assert.deepEqual({ ...JSON.parse(current.data), mascot: undefined, animationStyle: undefined },
    { ...JSON.parse((f.db.prepare('SELECT data FROM document_revisions WHERE account_id=? AND kind=? AND revision=2').get(accountA, 'preferences') as { data: string }).data), mascot: undefined, animationStyle: undefined });
  assert.equal(JSON.parse(current.data).mascot, 'scholarly'); assert.equal(JSON.parse(current.data).animationStyle, 'short');
  for (const original of historical) assert.ok(rows(f.db, 'document_revisions').some(row => JSON.stringify(row) === JSON.stringify(original)));
  assert.equal((f.db.prepare('SELECT data FROM document_revisions WHERE account_id=? AND kind=? AND revision=3').get(accountA, 'preferences') as { data: string }).data, current.data);
  assert.deepEqual(f.db.prepare('SELECT revision,data FROM documents WHERE account_id=? AND kind=?').get(accountB, 'preferences'), { revision: 2, data: JSON.stringify(explicit) });
  const after = rows(f.db, 'document_revisions'); f.db.exec(mascotPreferencesMigration.sql);
  assert.deepEqual(rows(f.db, 'document_revisions'), after); integrity(f.db);
}));

test('B3 strict preference enums remain isolated from profile answers and client lifecycle fields', () => {
  for (const mascot of ['scholarly', 'baby', 'buff', 'none'])
    for (const animationStyle of ['short', 'long']) assert.ok(preferencesPatch.safeParse({ expectedRevision: 2, mascot, animationStyle }).success);
  for (const bad of [{ mascot: 'unknown' }, { animationStyle: 'static' }, { age: 18 }, { accountId: accountB }, { statusSecret: secret() }])
    assert.equal(preferencesPatch.safeParse({ expectedRevision: 2, ...bad }).success, false);
  assert.equal(profilePatch.safeParse({ expectedRevision: 2, mascot: 'baby' }).success, false);
  assert.ok(onboardingPatch.safeParse({ expectedRevision: 2, step: 'preferences', preferences: { mascot: 'baby', animationStyle: 'long' } }).success);
  assert.equal(onboardingPatch.safeParse({ expectedRevision: 2, step: 'preferences', answers: { mascot: 'baby' } }).success, false);
});

// Existing owned lifecycle fixtures exercise capture rows under the same suppression/restore/purge rules.
function seedConfirmedCapture(db: Sqlite, actor: AccountContext): void {
  const domain = new Domain(db);
  domain.patchDocument(actor.accountId, 'profile', { expectedRevision: 2, name: 'Synthetic', age: 18,
    heightCm: null, weightKg: null, trainingBackground: null, injuryHistory: '', goals: [] });
  domain.patchDocument(actor.accountId, 'preferences', { expectedRevision: 2, ...defaultPreferences });
  const writer = createCanonicalAccountWriter(db);
  const host = createConfirmedCaptureHost(domain, writer, { readWithinWrite: () => ({
    inventory: { id: 'synthetic', revision: '1', source: { id: 'test', revision: '1', locator: 'fixture:only',
      qualification: 'qualified', currentness: 'current' },
    questions: [{ id: 'question', revision: '1', prompt: 'Synthetic question', kind: 'text', required: true }],
    consent: { id: 'consent', revision: '1', text: 'Synthetic permission only' } },
    permission: { id: 'permission', revision: '1', inventoryId: 'synthetic', inventoryRevision: '1',
      statementId: 'consent', statementRevision: '1', decision: 'granted', retention: 'retain_confirmed_capture_and_history' },
  }) });
  for (const revision of [0, 1]) {
    const review = host.review(actor); if (review.status !== 'ready') throw new Error('synthetic review missing');
    host.confirm(actor, `capture-${revision}`, { review: review.review, payload: {
      answers: [{ questionId: 'question', questionRevision: '1', response: { state: 'answered', literal: `Synthetic literal ${revision}` } }],
      facts: [], restrictionInventory: { response: { state: 'no', literal: 'No instructions reported' }, instructionIds: [] },
      consent: { decision: 'granted', statementId: 'consent', statementRevision: '1' },
    } });
  }
}
