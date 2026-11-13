import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Domain } from '../src/domain.js';
import { DomainError } from '../src/errors.js';
import { backupAndVerify, hash, integrity, migrate, openStorage, type Sqlite } from '../src/storage.js';
import { bindSuppressionAuthority, subjectEligibility } from '../src/lifecycle/guards.js';
import { lifecyclePolicy } from '../src/lifecycle/service.js';
import { buildAccountExport } from '../src/lifecycle/export.js';
import { issueLocalPurgeAuthority, type LocalPurgeAuthority } from '../src/lifecycle/purge-executor.js';
import { suppressionLedgerSchema } from '../src/lifecycle/ledger.js';
import { sourceLifecycleEvidenceMigration, lifecycleEvidenceSchemaObjects } from '../src/lifecycle/evidence-migration.js';
import { assertSourceLifecycleEvidenceHistory, assertSourceLifecycleEvidenceSelection, selectSourceLifecycleEvidenceMigrations } from '../src/lifecycle/source-migrations.js';
import { assertLifecycleEvidenceSchema, LifecycleEvidenceStore } from '../src/lifecycle/evidence-store.js';
import { bindSourceLifecycleLocalAbsenceReader, bindSourceLifecycleEvidenceWitnessReader, createSourceLifecycleEvidence, openSourceLifecycleEvidenceStorage,
  type SourceLifecycleEvidenceWitnessReader, type SourceLifecycleEvidenceGeneration } from '../src/lifecycle/evidence-source.js';
import { evidenceCanonical, evidenceDigest, encodeDurableEvidence, decodeDurableEvidence, type DurableEvidence } from '../src/lifecycle/evidence-codec.js';
import { CurrentSuppressionAuthority, genesisHead, ledgerSchemaDigest, witnessSchema, type Witness } from '../src/runtime-modules/currentness.js';
import { AuthorityLock, JsonFile, canonicalPath, fileDigest } from '../src/runtime-modules/files.js';
import { readClosedReceipts } from '../src/runtime-modules/closed-read.js';
import { runtimeMigrations, migrationDigests } from '../src/runtime-modules/migrations.js';
import { prepareRelocatedAdmission } from '../src/runtime-modules/admission.js';
import { createCanonicalAccountWriter } from '../src/integration/account-modules/canonical-writer.js';
import { createSourceAccountModules, createSourceTrainingLifecycleAdapters } from '../src/integration/account-modules/index.js';
import { createSourceRequestFactories } from '../src/lifecycle/request-factories.js';
import { createManualMeasurements } from '../src/body/measurements.js';
import type { AccountContext, LifecycleAdapter, LifecycleResult } from '../src/lifecycle/types.js';
import { install } from './integration/account-modules/fixture.js';
import { withRestoreDrill } from './runtime-modules/restore-drill-fixture.js';
import { provision, readAdmission } from './runtime-modules/fixture.js';

const configuration = { mode: 'source-only', cohort: 'lifecycle-evidence-v1' } as const;
const selected = selectSourceLifecycleEvidenceMigrations();
const requestId = '33333333-3333-4333-8333-333333333333';
const A: AccountContext = { accountId: '11111111-1111-4111-8111-111111111111', authUserId: 'evidence-auth-a', sessionId: 'evidence-session-a', epoch: 0 };
const B: AccountContext = { accountId: '22222222-2222-4222-8222-222222222222', authUserId: 'evidence-auth-b', sessionId: 'evidence-session-b', epoch: 0 };
const statusSecret = 's'.repeat(43);
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

function scratch(t: TestContext): { root: string; handles: Set<Sqlite>; closers: (() => void)[] } {
  const root = mkdtempSync(join(homedir(), '.form-lifecycle-evidence-test-')); chmodSync(root, 0o700);
  const handles = new Set<Sqlite>(), closers: (() => void)[] = [];
  let cleaned = false;
  const close = () => {
    if (cleaned) return; cleaned = true;
    const errors: unknown[] = [];
    for (const db of handles) if (db.open) try { db.close(); } catch (error) { errors.push(error); }
    for (const closer of closers.reverse()) try { closer(); } catch (error) { errors.push(error); }
    if (!errors.length) rmSync(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Evidence fixture cleanup failed');
  };
  const interrupted = () => { try { close(); } finally { process.exitCode = 130; } };
  const terminated = () => { try { close(); } finally { process.exitCode = 143; } };
  t.after(close);
  process.once('SIGINT', interrupted); process.once('SIGTERM', terminated);
  t.after(() => { process.off('SIGINT', interrupted); process.off('SIGTERM', terminated); });
  t.diagnostic(`synthetic source24 fixture cleanup owner: ${root}`);
  return { root, handles, closers };
}
function file(f: ReturnType<typeof scratch>, name: string, prefix = 24): Sqlite {
  const db: Sqlite = new Database(join(f.root, name)); f.handles.add(db); chmodSync(db.name, 0o600);
  install(db, selected.slice(0, prefix)); return db;
}
function authority(f: ReturnType<typeof scratch>) {
  const directory = join(f.root, 'authority'); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'ledger.sqlite'), uid = process.getuid!(), authorityId = randomUUID();
  const db = new Database(path); chmodSync(path, 0o600);
  try { db.exec(suppressionLedgerSchema); db.prepare('INSERT INTO suppression_authority VALUES(?,0)').run(authorityId); } finally { db.close(); }
  const lock = new AuthorityLock(directory, uid, randomUUID()); f.closers.push(() => lock.release());
  const witness = JsonFile.create(join(directory, 'currentness.json'), uid, witnessSchema, {
    version: 1, authorityId, ledgerSchemaDigest, revision: 0, directory: lock.directoryIdentity,
    ledger: canonicalPath(path, uid), committedSequence: 0, committedHeadDigest: genesisHead(authorityId), pending: null,
  });
  const current = new CurrentSuppressionAuthority(lock, witness, path, authorityId); f.closers.push(() => current.close());
  return { current, witness, lock, directory };
}
const adapterCache = new WeakMap<Sqlite, readonly LifecycleAdapter[]>();
function adapters(db: Sqlite, current: CurrentSuppressionAuthority): readonly LifecycleAdapter[] {
  const cached = adapterCache.get(db); if (cached) return cached;
  bindSuppressionAuthority(db, current);
  const writer = createCanonicalAccountWriter(db);
  const factories = createSourceRequestFactories({ db, lifecycle: writer.lifecycle, purgeReadiness: writer.purgeReadiness,
    configuration: { mode: 'source-only', communityModules: 'b2-b4-b5' },
    subjectEligibilityFor: actor => accountId => subjectEligibility(db, actor, accountId) });
  const result = [...factories.adapters, ...createSourceAccountModules(db, writer.lifecycle).adapters,
    ...createSourceTrainingLifecycleAdapters(db, new Domain(db), writer),
    createManualMeasurements(db, writer.lifecycle).lifecycleAdapter];
  adapterCache.set(db, result); return result;
}
function actors(db: Sqlite): void {
  const now = Date.now();
  for (const actor of [A, B]) {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)')
      .run(actor.authUserId, 'Synthetic evidence', `${actor.authUserId}@synthetic.invalid`, now, now);
    db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(actor.accountId, actor.authUserId, 'synthetic');
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)')
      .run(actor.sessionId, now + 86400000, `synthetic-${actor.sessionId}`, now, now, actor.authUserId);
    db.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,'credential',?,?,?,?)")
      .run(actor.authUserId, actor.authUserId, actor.authUserId, 'synthetic-password-hash', now, now);
    db.prepare('INSERT INTO documents VALUES(?,?,1,?)').run(actor.accountId, 'profile', '{"age":30}');
  }
}
function fixture(t: TestContext, decorate: (values: readonly LifecycleAdapter[], db: Sqlite) => readonly LifecycleAdapter[] = values => values) {
  const f = scratch(t), db = file(f, 'main.sqlite'), auth = authority(f); actors(db);
  const generationPath = join(f.root, 'independent-generation.json');
  const writeGeneration = (databaseGeneration: string, witnessRevision = 1) => writeFileSync(generationPath,
    JSON.stringify({ databaseGeneration, mainStoreId: 'synthetic-source-main', witnessRevision }), { mode: 0o600 });
  writeGeneration('generation-one');
  let now = Date.now();
  const compose = (store: Sqlite) => {
    const witness = bindSourceLifecycleEvidenceWitnessReader(store, auth.current, exact => {
      assert.equal(exact, store);
      return JSON.parse(readFileSync(generationPath, 'utf8')) as SourceLifecycleEvidenceGeneration;
    });
    const values = decorate(adapters(store, auth.current), store);
    const localAbsence = ([['activity', 'activity-owned-v1'], ['progressComparison', 'progress-comparison-owned-v1'],
      ['trainingFeedback', 'training-feedback-owned-v1']] as const).map(([category, owner]) =>
      bindSourceLifecycleLocalAbsenceReader(store, values.find(adapter => adapter.category === category)!, owner));
    return createSourceLifecycleEvidence({ configuration, db: store, authority: auth.current, witness,
      adapters: values, localAbsence, clock: () => now });
  };
  const source = compose(db);
  const initiate = () => source.lifecycle.initiate(A, 'evidence-delete', {
    requestId, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account', statusSecret });
  const confirm = async () => {
    initiate();
    const grant = await source.lifecycle.issueGrant(A, { purpose: 'account_delete', password: 'synthetic-password' }, async () => true);
    source.lifecycle.confirm(A, requestId, { grant: grant.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' });
  };
  const purge = (operationId = 'local-operation') => source.lifecycle.purgeLocal(issueLocalPurgeAuthority(source.lifecycle, { requestId, operationId }));
  const facts = () => db.prepare('SELECT * FROM account_deletion_evidence ORDER BY rowid').all();
  return { ...f, db, auth, source, initiate, confirm, purge, facts, compose, writeGeneration, advanceClock: () => { now += 1000; } };
}

test('fresh source24 migration and populated full23 upgrade retain genuine history, backups and reopen identity', async t => {
  const f = scratch(t), path = join(f.root, 'fresh.sqlite');
  const fresh = await openSourceLifecycleEvidenceStorage(path, configuration); f.handles.add(fresh.db);
  assert.equal(fresh.migrationBackups.length, 23);
  assertSourceLifecycleEvidenceHistory(fresh.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as { version: number; checksum: string }[], true);
  const history = fresh.db.prepare('SELECT * FROM form_migrations ORDER BY version').all(); fresh.db.close();
  const reopen = await openSourceLifecycleEvidenceStorage(path, configuration); f.handles.add(reopen.db);
  assert.deepEqual(reopen.migrationBackups, []); assert.deepEqual(reopen.db.prepare('SELECT * FROM form_migrations ORDER BY version').all(), history);
  const prefix = file(f, 'upgrade.sqlite', 23); actors(prefix);
  const original = prefix.prepare('SELECT * FROM form_migrations ORDER BY version').all(), profile = prefix.prepare('SELECT * FROM documents ORDER BY account_id').all();
  prefix.close();
  const upgrade = await openSourceLifecycleEvidenceStorage(join(f.root, 'upgrade.sqlite'), configuration); f.handles.add(upgrade.db);
  assert.equal(upgrade.migrationBackups.length, 1);
  assert.deepEqual(upgrade.db.prepare('SELECT * FROM form_migrations WHERE version<24 ORDER BY version').all(), original);
  assert.deepEqual(upgrade.db.prepare('SELECT * FROM documents ORDER BY account_id').all(), profile);
  for (const backup of [...fresh.migrationBackups, ...upgrade.migrationBackups]) {
    const check = new Database(backup, { readonly: true }); try { integrity(check); } finally { check.close(); }
  }
  integrity(upgrade.db); assertLifecycleEvidenceSchema(upgrade.db, true);
});

test('selection rejects false compositions and receipt gaps, ordering, duplicates and foreign hashes before DDL', async t => {
  const f = scratch(t), path = join(f.root, 'never-created.sqlite');
  for (const value of [selected.slice(0, 23), [...runtimeMigrations, sourceLifecycleEvidenceMigration],
    selected.filter(row => row.version !== 21), selected.filter(row => row.version !== 22),
    [...selected.slice(0, 23), { ...sourceLifecycleEvidenceMigration, sql: 'SELECT 1' }]]) {
    assert.throws(() => assertSourceLifecycleEvidenceSelection(value));
    await assert.rejects(openStorage(path, value, 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24'));
    assert.equal(existsSync(path), false);
  }
  await assert.rejects(openStorage(path, selected)); assert.equal(existsSync(path), false);
  await assert.rejects(openStorage(path, selected, undefined, 'selected-migration-23', 'selected-lifecycle-evidence-24')); assert.equal(existsSync(path), false);
  const receipts = selected.map(entry => ({ version: entry.version, checksum: hash(entry.sql) }));
  for (const value of [receipts.filter(row => row.version !== 21), [...receipts].reverse(), [...receipts, receipts[23]!],
    receipts.map(row => row.version === 24 ? { ...row, checksum: 'a'.repeat(64) } : row), [...receipts, { version: 25, checksum: 'a'.repeat(64) }]])
    assert.throws(() => assertSourceLifecycleEvidenceHistory(value));
  for (const prefix of [0, 7, 16, 20, 21, 22, 23, 24]) assert.doesNotThrow(() => assertSourceLifecycleEvidenceHistory(receipts.slice(0, prefix)));
  const gap = file(f, 'gap.sqlite', 23); gap.prepare('DELETE FROM form_migrations WHERE version=22').run();
  const before = gap.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
  await assert.rejects(migrate(gap, gap.name, selected, 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24'));
  assert.deepEqual(gap.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), before);
});

test('unreceipted lookalikes, altered evidence constraints and migration24 faults cannot be adopted', async t => {
  const f = scratch(t), db = file(f, 'unnumbered.sqlite', 23);
  db.exec('CREATE TABLE account_deletion_evidence(request_id TEXT)');
  await assert.rejects(migrate(db, db.name, selected, 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24'));
  assert.equal(db.prepare('SELECT 1 FROM form_migrations WHERE version=24').get(), undefined);
  const malformed = file(f, 'malformed.sqlite', 23);
  malformed.exec(sourceLifecycleEvidenceMigration.sql.replace("CHECK(purpose='local_purge')", "CHECK(purpose IN('local_purge','forged'))"));
  malformed.prepare('INSERT INTO form_migrations VALUES(24,?,?)').run(hash(sourceLifecycleEvidenceMigration.sql), 'synthetic');
  assert.throws(() => assertLifecycleEvidenceSchema(malformed, true), code('lifecycle_evidence_held'));
  for (const point of ['before-ddl', 'after-first-table'] as const) {
    const target = file(f, `${point}.sqlite`, 23), original = target.exec.bind(target);
    target.exec = ((sql: string) => {
      if (sql === sourceLifecycleEvidenceMigration.sql) {
        if (point === 'after-first-table') original(lifecycleEvidenceSchemaObjects[0]!.sql);
        throw new Error('synthetic-migration24-fault');
      }
      return original(sql);
    }) as typeof target.exec;
    await assert.rejects(migrate(target, target.name, selected, 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24'), /synthetic-migration24-fault/);
    target.exec = original;
    assertLifecycleEvidenceSchema(target, false);
    assert.equal(target.prepare('SELECT 1 FROM form_migrations WHERE version=24').get(), undefined); integrity(target);
  }
});

test('actual guarded purge commits immutable scoped facts, preserves B, and identical replay survives clean restart', async t => {
  const f = fixture(t); await f.confirm();
  const other = f.db.prepare('SELECT * FROM documents WHERE account_id=?').all(B.accountId);
  const result = f.purge();
  assert.equal(result.phase, 'pending_external'); assert.equal(result.complete, false); assert.equal(result.backupExpiryAt, null);
  assert.equal(result.billingCancellation, 'not_performed'); assert.equal(result.reauthentication, 'password_only_qualified_source');
  assert.equal(result.steps.find(step => step.category === 'form_training_history')?.status, 'complete');
  assert.deepEqual(f.db.prepare('SELECT * FROM documents WHERE account_id=?').all(B.accountId), other);
  const facts = f.facts(), operation = f.db.prepare('SELECT * FROM account_deletion_evidence_operations').all();
  const stepTimes = f.db.prepare("SELECT category,updated_at_ms FROM account_deletion_steps WHERE status='complete' ORDER BY category").all();
  assert.ok(facts.length > 2); for (const row of facts as { payload: string }[]) assert.doesNotThrow(() => decodeDurableEvidence(row.payload));
  f.advanceClock(); f.purge(); assert.deepEqual(f.facts(), facts); assert.deepEqual(f.db.prepare('SELECT * FROM account_deletion_evidence_operations').all(), operation);
  assert.deepEqual(f.db.prepare("SELECT category,updated_at_ms FROM account_deletion_steps WHERE status='complete' ORDER BY category").all(), stepTimes);
  for (const table of ['account_deletion_evidence_operations', 'account_deletion_evidence']) {
    assert.throws(() => f.db.prepare(`DELETE FROM ${table}`).run(), /lifecycle_evidence_immutable/);
    assert.throws(() => f.db.prepare(`UPDATE ${table} SET operation_id='forged'`).run(), /lifecycle_evidence_immutable/);
  }
  const projection = f.source.completion(requestId)!;
  assert.equal(projection.calculation.wholeAccountDeviceProviderErasure, 'unproven');
  assert.equal(projection.residuals.retentionPolicy, 'unavailable'); assert.equal(projection.residuals.providers, 'unavailable'); assert.equal(projection.residuals.backups, 'unavailable');
  f.db.close(); const reopened: Sqlite = new Database(join(f.root, 'main.sqlite')); f.handles.add(reopened); reopened.pragma('foreign_keys=ON');
  const source = f.compose(reopened), recovered = source.completion(requestId)!;
  assert.deepEqual(recovered, projection); assert.deepEqual(reopened.prepare('SELECT * FROM account_deletion_evidence ORDER BY rowid').all(), facts);
  const status = source.lifecycle.status(requestId, statusSecret);
  assert.equal(status.steps.find(step => step.category === 'form_training_history')?.status, 'complete');
  source.lifecycle.assertActive(B); integrity(reopened);
});

test('same operation binds proof, policy and exact category scope before any new deletion', async t => {
  const f = fixture(t); await f.confirm(); f.purge();
  const before = f.facts();
  f.db.prepare('UPDATE account_deletion_requests SET policy_version=? WHERE id=?').run('changed-policy', requestId);
  assert.throws(() => f.purge(), code('lifecycle_evidence_conflict')); assert.deepEqual(f.facts(), before);
  f.db.prepare('UPDATE account_deletion_requests SET policy_version=?,verified_at_ms=verified_at_ms+1 WHERE id=?').run(lifecyclePolicy, requestId);
  assert.throws(() => f.purge(), code('lifecycle_evidence_conflict')); assert.deepEqual(f.facts(), before);
  const changed = fixture(t);
  await changed.confirm(); changed.purge();
  const witness = bindSourceLifecycleEvidenceWitnessReader(changed.db, changed.auth.current, () => ({ databaseGeneration: 'generation-one', mainStoreId: 'synthetic-source-main', witnessRevision: 1 }));
  const composed = createSourceLifecycleEvidence({ configuration, db: changed.db, authority: changed.auth.current, witness,
    adapters: [...adapters(changed.db, changed.auth.current), { category: 'synthetic-foreign-category', suppress: () => ({ status: 'complete' }),
      verifySuppressed: () => ({ status: 'complete' }), purge: () => ({ status: 'complete' }),
      inventory: () => ({ category: 'synthetic-foreign-category', status: 'complete' }), export: () => ({ category: 'synthetic-foreign-category', status: 'complete' }) }] });
  assert.throws(() => composed.lifecycle.purgeLocal(issueLocalPurgeAuthority(composed.lifecycle, { requestId, operationId: 'local-operation' })), code('lifecycle_evidence_conflict'));
});

for (const failure of ['thenable', 'adapter', 'readback', 'foreign-key', 'generation', 'final-witness'] as const)
  test(`${failure} after local effects rolls back facts, steps and main rows while independent suppression stays committed`, async t => {
    let fail = () => {}, reads = 0;
    const f = fixture(t, (values, db) => {
      if (failure === 'foreign-key') db.exec('CREATE TABLE synthetic_parent(id TEXT PRIMARY KEY); CREATE TABLE synthetic_child(parent TEXT REFERENCES synthetic_parent(id) DEFERRABLE INITIALLY DEFERRED)');
      return values.map(value => value.category !== 'activity' ? value : { ...value,
      purge: (request: string, account: string) => {
        const result = value.purge(request, account);
        if (failure === 'thenable') return { then() {} } as unknown as LifecycleResult;
        if (failure === 'adapter') throw new Error('synthetic-adapter-fault');
        if (failure === 'readback') db.prepare('INSERT INTO documents VALUES(?,?,1,?)').run(A.accountId, 'late', '{}');
        if (failure === 'foreign-key') db.prepare('INSERT INTO synthetic_child VALUES(?)').run('missing');
        if (failure === 'generation') fail();
        return result;
      },
      verifySuppressed: (account: string, epoch: number) => { const result = value.verifySuppressed(account, epoch);
        if (failure === 'final-witness' && ++reads === 3) fail(); return result; },
      });
    });
    await f.confirm(); reads = 0;
    fail = () => f.writeGeneration('generation-two', 2);
    const tables = ['documents', 'account_deletion_requests', 'account_deletion_steps', 'account_deletion_evidence_operations', 'account_deletion_evidence'];
    const before = tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const record = f.auth.current.lookup(A.accountId), capability = issueLocalPurgeAuthority(f.source.lifecycle, { requestId, operationId: 'local-operation' });
    assert.throws(() => f.source.lifecycle.purgeLocal(capability));
    assert.deepEqual(tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
    assert.deepEqual(f.auth.current.lookup(A.accountId), record);
    assert.throws(() => f.source.lifecycle.purgeLocal(capability), code('purge_authority_invalid'));
  });

test('new independent generation on a restored request invalidates mutable successes and requires fresh guarded evidence', async t => {
  const f = fixture(t); await f.confirm();
  const before = join(f.root, 'before-purge.sqlite'); await backupAndVerify(f.db, before);
  f.purge(); const facts = f.facts();
  const after = join(f.root, 'after-purge.sqlite'); await backupAndVerify(f.db, after);
  f.db.close();
  const restoredPath = join(f.root, 'restored.sqlite'); copyFileSync(after, restoredPath); chmodSync(restoredPath, 0o600);
  f.writeGeneration('generation-two', 2);
  const restored: Sqlite = new Database(restoredPath); f.handles.add(restored); restored.pragma('foreign_keys=ON');
  const source = f.compose(restored);
  assert.equal(source.completion(requestId)!.calculation.staleFactCount, facts.length);
  assert.equal(source.lifecycle.status(requestId, statusSecret).steps.find(step => step.category === 'form_training_history')?.status, 'pending');
  source.lifecycle.purgeLocal(issueLocalPurgeAuthority(source.lifecycle, { requestId, operationId: 'local-operation' }));
  const renewed = restored.prepare('SELECT * FROM account_deletion_evidence ORDER BY rowid').all();
  assert.deepEqual(renewed.slice(0, facts.length), facts); assert.ok(renewed.length > facts.length);
  assert.equal(source.lifecycle.status(requestId, statusSecret).steps.find(step => step.category === 'form_training_history')?.status, 'complete');
  const predatingPath = join(f.root, 'predating.sqlite'); copyFileSync(before, predatingPath); chmodSync(predatingPath, 0o600);
  f.writeGeneration('generation-three', 3);
  const predating: Sqlite = new Database(predatingPath); f.handles.add(predating); predating.pragma('foreign_keys=ON');
  const earlier = f.compose(predating); assert.equal(earlier.completion(requestId)!.calculation.historicalFactCount, 0);
  earlier.lifecycle.purgeLocal(issueLocalPurgeAuthority(earlier.lifecycle, { requestId, operationId: 'restored-operation' }));
  assert.equal(predating.prepare('SELECT 1 FROM documents WHERE account_id=?').get(A.accountId), undefined); integrity(predating);
});

test('request-absent restore never reconstructs intent or facts from independent suppression', async t => {
  const f = fixture(t), path = join(f.root, 'before-request.sqlite'); await backupAndVerify(f.db, path);
  await f.confirm(); f.db.close(); f.writeGeneration('generation-two', 2);
  const restored: Sqlite = new Database(path); f.handles.add(restored); restored.pragma('foreign_keys=ON');
  const source = f.compose(restored);
  assert.throws(() => issueLocalPurgeAuthority(source.lifecycle, { requestId, operationId: 'missing-request' }), code('deletion_request_absent_restore_held'));
  assert.deepEqual(restored.prepare('SELECT count(*) n FROM account_deletion_requests').get(), { n: 0 });
  assert.deepEqual(restored.prepare('SELECT count(*) n FROM account_deletion_evidence_operations').get(), { n: 0 });
  assert.throws(() => source.lifecycle.assertActive(A), error => error instanceof DomainError);
  assert.deepEqual(restored.prepare('SELECT * FROM documents WHERE account_id=?').all(B.accountId), [{ account_id: B.accountId, kind: 'profile', revision: 1, data: '{"age":30}' }]);
});

test('omitted, shaped, foreign-db, async, stale and unknown generation witnesses never authorize the source consumer', async t => {
  const f = fixture(t); await f.confirm();
  for (const witness of [undefined, {}, { databaseGeneration: 'generation-one', current: true }])
    assert.throws(() => createSourceLifecycleEvidence({ configuration, db: f.db, authority: f.auth.current,
      witness: witness as unknown as SourceLifecycleEvidenceWitnessReader, adapters: adapters(f.db, f.auth.current) }), code('lifecycle_evidence_held'));
  const other = file(f, 'other.sqlite');
  const foreign = bindSourceLifecycleEvidenceWitnessReader(other, f.auth.current, () => ({ databaseGeneration: 'generation-one', mainStoreId: 'other', witnessRevision: 1 }));
  assert.throws(() => new LifecycleEvidenceStore(f.db, foreign), code('lifecycle_evidence_held'));
  for (const read of [() => null, (() => Promise.resolve({ databaseGeneration: 'forged' })) as unknown as () => SourceLifecycleEvidenceGeneration])
    assert.throws(() => bindSourceLifecycleEvidenceWitnessReader(f.db, f.auth.current, read), code('lifecycle_evidence_held'));
  f.writeGeneration('generation-two', 2);
  const before = f.db.prepare('SELECT * FROM documents ORDER BY account_id').all();
  assert.throws(() => f.purge(), code('lifecycle_evidence_held')); assert.deepEqual(f.facts(), []);
  assert.deepEqual(f.db.prepare('SELECT * FROM documents ORDER BY account_id').all(), before);
  assert.equal(f.source.lifecycle.status(requestId, statusSecret).localPurged, false);
});

test('checkpoint advance is historical until fresh proof; late contradiction, schema drift and corrupt rows hold', async t => {
  const f = fixture(t); await f.confirm(); f.purge(); const facts = f.facts();
  f.auth.current.recordDisable({ accountId: B.accountId, authUserId: B.authUserId, requestId: 'other-request', epoch: 1, disabledAtMs: Date.now() });
  assert.equal(f.source.completion(requestId)!.calculation.staleFactCount, facts.length);
  assert.equal(f.source.lifecycle.status(requestId, statusSecret).steps.find(step => step.category === 'form_training_history')?.status, 'pending');
  f.purge(); assert.ok(f.facts().length > facts.length);
  f.db.exec('CREATE TABLE synthetic_schema_drift(id TEXT)');
  assert.throws(() => f.source.completion(requestId), code('lifecycle_evidence_held'));
  assert.equal(f.source.lifecycle.status(requestId, statusSecret).localPurged, false);
  const corrupt = fixture(t); await corrupt.confirm(); corrupt.purge();
  corrupt.db.exec('DROP TRIGGER account_deletion_evidence_no_update');
  corrupt.db.prepare("UPDATE account_deletion_evidence SET payload=json_set(payload,'$.privateToken','synthetic-never-export')").run();
  corrupt.db.exec(lifecycleEvidenceSchemaObjects.find(object => object.name === 'account_deletion_evidence_no_update')!.sql);
  assert.throws(() => corrupt.source.completion(requestId), code('lifecycle_evidence_held'));
  assert.equal(corrupt.source.lifecycle.status(requestId, statusSecret).steps.find(step => step.category === 'form_training_history')?.status, 'pending');
});

test('evidence remains outside explicit export and genuine source24 stays outside runtime16 closed admission', async t => {
  const f = fixture(t);
  f.initiate();
  const exported = buildAccountExport(f.db, A, actor => f.source.lifecycle.assertActive(actor), f.source.lifecycle.adapters);
  const serialized = JSON.stringify(exported);
  for (const forbidden of ['account_deletion_evidence', 'scope_digest', 'proof_digest', 'payload_digest', statusSecret]) assert.equal(serialized.includes(forbidden), false);
  await f.confirm(); f.purge();
  const otherExport = JSON.stringify(buildAccountExport(f.db, B, actor => f.source.lifecycle.assertActive(actor), f.source.lifecycle.adapters));
  const operation = f.db.prepare('SELECT scope_digest,proof_digest FROM account_deletion_evidence_operations').get() as
    { scope_digest: string; proof_digest: string };
  for (const forbidden of [operation.scope_digest, operation.proof_digest, 'payload_digest', 'account_deletion_evidence'])
    assert.equal(otherExport.includes(forbidden), false);
  assert.throws(() => buildAccountExport(f.db, A, actor => f.source.lifecycle.assertActive(actor)), error => error instanceof DomainError);
  f.db.close();
  const digests = [...migrationDigests];
  assert.equal(digests.length, 16);
  assert.throws(() => readClosedReceipts(f.auth.lock, f.db.name,
    canonicalPath(f.db.name, process.getuid!()), fileDigest(f.db.name, process.getuid!())), /Migration provenance mismatch/);
  assert.deepEqual(migrationDigests, digests);
  await withRestoreDrill(t, async target => {
    await provision(target.d); const runtime = await target.runtime(); await runtime.server.close();
    const d = target.d, prior = readAdmission(d), admissionPath = join(d.configuration.authorityDirectory, 'admission.json');
    const mainBytes = readFileSync(d.path), admissionBytes = readFileSync(admissionPath), destination = join(d.root, 'source24-rejected.sqlite');
    assert.throws(() => prepareRelocatedAdmission({ configuration: d.configuration, mainPath: d.path,
      expectedMain: canonicalPath(d.path, d.configuration.ownerUid), expectedRevision: prior.revision as number,
      expectedGeneration: prior.databaseGeneration as number, expectedPredecessorDigest: prior.closedDigest as string,
      backupPath: f.db.name, expectedBackupDigest: fileDigest(f.db.name, d.configuration.ownerUid), destination,
      operationId: randomUUID(), provenance: 'synthetic source24 negative admission', oldWriterStopped: true }), /Relocation runtime migration mismatch/);
    assert.deepEqual(readFileSync(d.path), mainBytes); assert.deepEqual(readFileSync(admissionPath), admissionBytes);
  });
});

test('two issued same-operation capabilities serialize to one durable fact set and foreign capabilities leave no evidence', async t => {
  const f = fixture(t), other = fixture(t); await f.confirm(); await other.confirm();
  const input = { requestId, operationId: 'duplicate-operation' };
  const one = issueLocalPurgeAuthority(f.source.lifecycle, input), two = issueLocalPurgeAuthority(f.source.lifecycle, input);
  f.source.lifecycle.purgeLocal(one); const facts = f.facts();
  f.advanceClock(); f.source.lifecycle.purgeLocal(two); assert.deepEqual(f.facts(), facts);
  assert.throws(() => f.source.lifecycle.purgeLocal({} as LocalPurgeAuthority), code('purge_authority_invalid'));
  const foreign = issueLocalPurgeAuthority(f.source.lifecycle, input);
  const before = other.db.prepare('SELECT * FROM documents ORDER BY account_id').all();
  assert.throws(() => other.source.lifecycle.purgeLocal(foreign), code('purge_authority_invalid'));
  assert.deepEqual(other.facts(), []); assert.deepEqual(other.db.prepare('SELECT * FROM documents ORDER BY account_id').all(), before);
  const capability = issueLocalPurgeAuthority(other.source.lifecycle, input);
  assert.throws(() => other.db.transaction(() => other.source.lifecycle.purgeLocal(capability)).immediate(), code('purge_executor_transaction_required'));
  assert.deepEqual(other.facts(), []);
});

test('suppression-first confirmation rollback preserves disable and never creates verification or evidence', async t => {
  const f = fixture(t); f.initiate();
  const grant = await f.source.lifecycle.issueGrant(A, { purpose: 'account_delete', password: 'synthetic-password' }, async () => true);
  f.db.exec("CREATE TRIGGER synthetic_confirm_fault BEFORE UPDATE OF verified_at_ms ON account_deletion_requests BEGIN SELECT RAISE(ABORT,'synthetic-confirm-fault'); END");
  assert.throws(() => f.source.lifecycle.confirm(A, requestId, { grant: grant.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' }), code('deletion_effect_unknown'));
  assert.equal(f.auth.current.lookup(A.accountId)?.requestId, requestId); assert.deepEqual(f.facts(), []);
  f.db.exec('DROP TRIGGER synthetic_confirm_fault'); f.source.lifecycle.reconcileRestore();
  assert.throws(() => f.purge(), code('lifecycle_evidence_held'));
  assert.equal((f.db.prepare('SELECT verified_at_ms FROM account_deletion_requests WHERE id=?').get(requestId) as { verified_at_ms: number | null }).verified_at_ms, null);
  assert.throws(() => f.source.lifecycle.assertActive(A), error => error instanceof DomainError);
  assert.deepEqual(f.facts(), []);
});

for (const divergence of ['head', 'revision', 'floor'] as const) test(`independent ${divergence} rollback/divergence holds existing facts`, async t => {
  const f = fixture(t); await f.confirm(); f.purge(); const facts = f.facts();
  const before = f.auth.current.checkpoint();
  const changed: Witness = { ...before, ...(divergence === 'head' ? { committedHeadDigest: 'a'.repeat(64) }
    : divergence === 'revision' ? { revision: before.revision - 1 } : { committedSequence: 0 }) };
  f.auth.witness.replace(changed, 'synthetic-currentness-divergence');
  assert.throws(() => f.source.completion(requestId)); assert.deepEqual(f.facts(), facts);
  assert.throws(() => f.purge()); assert.deepEqual(f.facts(), facts);
});

test('late unavailable observation remains historical and replaying an earlier success cannot clear it', async t => {
  let retained = false;
  const f = fixture(t, values => values.map(value => value.category !== 'activity' ? value : { ...value,
    purge: (request: string, account: string) => retained ? { status: 'unknown' as const } : value.purge(request, account) }));
  await f.confirm(); f.purge(); const first = f.facts();
  retained = true; f.advanceClock(); f.purge(); const uncertain = f.facts(); assert.ok(uncertain.length > first.length);
  retained = false; f.purge(); assert.deepEqual(f.facts(), uncertain);
  assert.equal(f.source.completion(requestId)!.completedCategories.includes('activity'), false);
  assert.equal(f.source.lifecycle.status(requestId, statusSecret).steps.find(step => step.category === 'activity')?.status, 'pending');
});

test('elapsed planned retention, retained proofs and missing external witnesses stay incomplete; source receipt drift holds', async t => {
  const f = fixture(t); await f.confirm(); f.purge();
  f.db.prepare("UPDATE account_deletion_steps SET retain_until_ms=0 WHERE category IN('backups','providers','auth_identity','purchase_proofs')").run();
  const projection = f.source.completion(requestId)!;
  assert.equal(projection.calculation.eligibility === 'qualifying', false);
  assert.equal(projection.residuals.identityAnchors, 'retained'); assert.equal(projection.residuals.purchaseProofs, 'retained');
  assert.equal(projection.residuals.providers, 'unavailable'); assert.equal(projection.residuals.backups, 'unavailable');
  const status = f.source.lifecycle.status(requestId, statusSecret); assert.equal(status.complete, false); assert.equal(status.backupExpiryAt, null);
  const facts = f.facts(); f.db.prepare('UPDATE form_migrations SET checksum=? WHERE version=24').run('f'.repeat(64));
  assert.throws(() => f.source.completion(requestId)); assert.throws(() => f.purge()); assert.deepEqual(f.facts(), facts);
});

test('P1 current Activity row reappearance dequalifies source completion without changing generation or authority', async t => {
  const f = fixture(t); await f.confirm(); f.purge();
  assert.equal(f.source.completion(requestId)!.completedCategories.includes('activity'), true);
  const facts = f.facts(), checkpoint = f.auth.current.checkpoint();
  f.db.prepare('INSERT INTO activity_state(account_id,generation) VALUES(?,0)').run(B.accountId);
  const other = f.db.prepare('SELECT * FROM activity_state WHERE account_id=?').all(B.accountId);
  f.db.prepare('INSERT INTO activity_state(account_id,generation) VALUES(?,0)').run(A.accountId);
  assert.equal(f.source.completion(requestId)!.completedCategories.includes('activity'), false);
  assert.equal(f.source.lifecycle.status(requestId, statusSecret).steps.find(step => step.category === 'activity')?.status, 'pending');
  assert.deepEqual(f.facts(), facts); assert.deepEqual(f.auth.current.checkpoint(), checkpoint);
  assert.deepEqual(f.db.prepare('SELECT * FROM activity_state WHERE account_id=?').all(B.accountId), other);
});

test('P1 later adapter Activity repopulation rolls back the guarded purge and evidence', async t => {
  const f = fixture(t, (values, db) => values.map(value => value.category !== 'trainingFeedback' ? value : { ...value,
    purge: (request: string, account: string) => {
      const result = value.purge(request, account);
      db.prepare('INSERT INTO activity_state(account_id,generation) VALUES(?,0)').run(account);
      return result;
    } }));
  await f.confirm();
  const tables = ['documents', 'activity_state', 'account_deletion_requests', 'account_deletion_steps', 'account_deletion_evidence_operations', 'account_deletion_evidence'];
  const before = tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const checkpoint = f.auth.current.checkpoint();
  assert.throws(() => f.purge());
  assert.deepEqual(tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before);
  assert.deepEqual(f.auth.current.checkpoint(), checkpoint);
});

test('P1 explicit absence readers bind exact DB and adapter identity; missing readers withhold qualification', async t => {
  const f = fixture(t); await f.confirm();
  const values = adapters(f.db, f.auth.current);
  const activity = values.find(value => value.category === 'activity')!;
  const reader = bindSourceLifecycleLocalAbsenceReader(f.db, activity, 'activity-owned-v1');
  const witness = bindSourceLifecycleEvidenceWitnessReader(f.db, f.auth.current,
    () => ({ databaseGeneration: 'generation-one', mainStoreId: 'synthetic-source-main', witnessRevision: 1 }));
  const compose = (adapters: readonly LifecycleAdapter[], localAbsence: readonly typeof reader[]) =>
    createSourceLifecycleEvidence({ configuration, db: f.db, authority: f.auth.current, witness, adapters, localAbsence });
  assert.throws(() => compose(values, [{} as typeof reader]), code('lifecycle_local_absence_held'));
  assert.throws(() => compose(values.map(value => ({ ...value })), [reader]), code('lifecycle_local_absence_held'));
  assert.throws(() => compose(values, [reader, reader]), code('lifecycle_local_absence_held'));
  const other = file(f, 'foreign-reader.sqlite');
  assert.throws(() => compose(values, [bindSourceLifecycleLocalAbsenceReader(other, activity, 'activity-owned-v1')]), code('lifecycle_local_absence_held'));
  assert.throws(() => bindSourceLifecycleLocalAbsenceReader(f.db, activity, 'training-feedback-owned-v1'), code('lifecycle_local_absence_held'));
  const source = compose(values, []);
  source.lifecycle.purgeLocal(issueLocalPurgeAuthority(source.lifecycle, { requestId, operationId: 'no-readers' }));
  assert.equal(source.completion(requestId)!.completedCategories.includes('activity'), false);
  assert.equal(source.lifecycle.status(requestId, statusSecret).steps.find(step => step.category === 'activity')?.status, 'pending');
  const row = f.db.prepare("SELECT payload FROM account_deletion_evidence WHERE category='activity'").get() as { payload: string };
  assert.equal(decodeDurableEvidence(row.payload).fact.status, 'unavailable');
});

for (const owner of ['trainingFeedback', 'progressComparison'] as const)
  test(`P1 ${owner} requires real scoped owned-row absence separately from suppression`, async t => {
    const f = fixture(t); await f.confirm(); f.purge();
    assert.equal(f.source.completion(requestId)!.completedCategories.includes(owner), true);
    const table = owner === 'trainingFeedback' ? 'feedback_state' : 'progress_comparison_identities';
    const insert = (account: string) => owner === 'trainingFeedback'
      ? f.db.prepare('INSERT INTO feedback_state VALUES(?,0,0)').run(account)
      : f.db.prepare("INSERT INTO progress_comparison_identities VALUES(?,'identity','activity','source','item',1,1,'withdrawn',NULL,'synthetic')").run(account);
    insert(B.accountId);
    const other = f.db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(B.accountId), facts = f.facts();
    assert.equal(f.source.completion(requestId)!.completedCategories.includes(owner), true);
    insert(A.accountId);
    assert.equal(f.source.completion(requestId)!.completedCategories.includes(owner), false);
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(B.accountId), other);
    assert.deepEqual(f.facts(), facts);
  });

test('P1 adapter side effect during the response readback cannot bypass the final in-transaction absence check', async t => {
  let reads = 0;
  const f = fixture(t, (values, db) => values.map(value => value.category !== 'activity' ? value : { ...value,
    verifySuppressed: (account: string, epoch: number) => {
      const result = value.verifySuppressed(account, epoch);
      if (++reads === 4) db.prepare('INSERT INTO activity_state(account_id,generation) VALUES(?,0)').run(account);
      return result;
    } }));
  await f.confirm(); reads = 0;
  const before = f.db.prepare('SELECT * FROM documents ORDER BY account_id').all();
  assert.throws(() => f.purge());
  assert.deepEqual(f.facts(), []);
  assert.deepEqual(f.db.prepare('SELECT * FROM documents ORDER BY account_id').all(), before);
  assert.equal(f.db.prepare('SELECT 1 FROM activity_state WHERE account_id=?').get(A.accountId), undefined);
});

test('P1 two different successful operations at different times preserve compatible positive proof and immutable history', async t => {
  const f = fixture(t); await f.confirm(); f.purge('first-operation');
  const first = f.facts(); f.advanceClock(); f.purge('second-operation');
  const all = f.facts(); assert.deepEqual(all.slice(0, first.length), first); assert.ok(all.length > first.length);
  assert.equal(f.source.completion(requestId)!.calculation.hold, null);
  assert.equal(f.source.completion(requestId)!.completedCategories.includes('form_training_history'), true);
  const operations = f.db.prepare('SELECT created_at_ms FROM account_deletion_evidence_operations ORDER BY rowid').all() as { created_at_ms: number }[];
  assert.ok(operations[1]!.created_at_ms > operations[0]!.created_at_ms);
  f.advanceClock(); f.purge('first-operation'); assert.deepEqual(f.facts(), all);
});

test('P1 fresh guarded operation resolves later uncertainty while old replay preserves it and all first observations', async t => {
  let unknown = false;
  const f = fixture(t, values => values.map(value => value.category !== 'activity' ? value : { ...value,
    purge: (request: string, account: string) => unknown ? { status: 'unknown' as const } : value.purge(request, account) }));
  await f.confirm(); f.purge('first-operation'); const first = f.facts();
  unknown = true; f.advanceClock(); f.purge('first-operation'); const uncertain = f.facts();
  unknown = false; f.advanceClock(); f.purge('first-operation'); assert.deepEqual(f.facts(), uncertain);
  assert.equal(f.source.completion(requestId)!.completedCategories.includes('activity'), false);
  f.advanceClock(); f.purge('fresh-operation');
  assert.equal(f.source.completion(requestId)!.calculation.hold, null);
  assert.equal(f.source.completion(requestId)!.completedCategories.includes('activity'), true);
  assert.deepEqual(f.facts().slice(0, uncertain.length), uncertain); assert.deepEqual(uncertain.slice(0, first.length), first);
  const recovered = f.facts(); f.advanceClock(); f.purge('first-operation'); assert.deepEqual(f.facts(), recovered);
  assert.equal(f.source.completion(requestId)!.completedCategories.includes('activity'), true);
});

test('P1 fresh envelopes retain genuine operation time, immutable first proof, B rows and replay bytes', async t => {
  const f = fixture(t); await f.confirm(); f.purge('proof-operation');
  const first = f.facts() as { category: string; payload: string }[];
  const other = f.db.prepare('SELECT * FROM documents WHERE account_id=?').all(B.accountId);
  f.advanceClock(); f.purge('observation-operation');
  const all = f.facts() as { category: string; payload: string }[];
  assert.deepEqual(all.slice(0, first.length), first);
  const operation = f.db.prepare('SELECT created_at_ms FROM account_deletion_evidence_operations WHERE operation_id=?')
    .get('observation-operation') as { created_at_ms: number };
  for (const row of all.slice(first.length)) {
    const next = decodeDurableEvidence(row.payload);
    const prior = decodeDurableEvidence(first.find(value => value.category === row.category)!.payload);
    assert.equal(next.observedAtMs, operation.created_at_ms);
    assert.ok(next.observedAtMs > prior.observedAtMs);
    if (next.fact.status === 'qualifying') {
      assert.equal(prior.fact.status, 'qualifying');
      assert.deepEqual(next.fact.witness, prior.fact.witness);
      assert.equal(next.fact.witness.observedAtMs, prior.observedAtMs);
      assert.ok(next.fact.witness.observedAtMs < next.observedAtMs);
    }
  }
  assert.deepEqual(f.db.prepare('SELECT * FROM documents WHERE account_id=?').all(B.accountId), other);
  f.source.lifecycle.assertActive(B);
  f.advanceClock(); f.purge('observation-operation'); assert.deepEqual(f.facts(), all);
  f.db.close();
  const reopened: Sqlite = new Database(join(f.root, 'main.sqlite')); f.handles.add(reopened); reopened.pragma('foreign_keys=ON');
  const restored = f.compose(reopened);
  assert.equal(restored.completion(requestId)!.calculation.hold, null);
  assert.deepEqual(reopened.prepare('SELECT * FROM account_deletion_evidence ORDER BY rowid').all(), all);
});

for (const status of ['pending', 'unavailable'] as const)
  test(`P1 only fresh guarded success resolves later ${status} with the original local proof`, async t => {
    let uncertain = false;
    const f = fixture(t, values => values.map(value => value.category !== 'activity' ? value : { ...value,
      purge: (request: string, account: string) => uncertain ? { status } : value.purge(request, account) }));
    await f.confirm(); f.purge('proof-operation'); const first = f.facts() as { category: string; payload: string }[];
    uncertain = true; f.advanceClock(); f.purge('proof-operation');
    const before = f.facts() as { category: string; payload: string }[];
    const pending = before.map(row => decodeDurableEvidence(row.payload)).find(value => value.fact.status === status &&
      value.fact.target.kind === 'category' && value.fact.target.category === 'activity')!;
    uncertain = false; f.advanceClock(); f.purge('proof-operation'); assert.deepEqual(f.facts(), before);
    assert.equal(f.source.completion(requestId)!.completedCategories.includes('activity'), false);
    f.advanceClock(); f.purge('fresh-operation');
    const all = f.facts() as { category: string; payload: string }[];
    assert.deepEqual(all.slice(0, before.length), before);
    const recovered = decodeDurableEvidence(all.slice(before.length).find(row => row.category === 'activity')!.payload);
    assert.equal(recovered.fact.status, 'qualifying');
    assert.deepEqual(recovered.fact.resolves, [pending.evidenceId]);
    assert.deepEqual(recovered.fact.witness, decodeDurableEvidence(first.find(row => row.category === 'activity')!.payload).fact.witness);
    assert.ok(recovered.observedAtMs > pending.observedAtMs);
    assert.equal(f.source.completion(requestId)!.completedCategories.includes('activity'), true);
  });

function replaceSyntheticEvidence(db: Sqlite, row: { operation_id: string; evidence_id: string; payload: string }, value: DurableEvidence): void {
  const payload = encodeDurableEvidence(value), b = value.fact.binding, c = b.checkpoint;
  assert.equal(value.fact.target.kind, 'category');
  db.exec('DROP TRIGGER account_deletion_evidence_no_update');
  try {
    db.prepare(`UPDATE account_deletion_evidence SET evidence_id=?, category=?, target_digest=?, result=?, observed_at_ms=?,
      database_generation=?, schema_digest=?, authority_id=?, authority_schema_digest=?, suppression_sequence=?,
      suppression_floor=?, suppression_head=?, witness_revision=?, policy_version=?, payload=?, payload_digest=?
      WHERE operation_id=? AND evidence_id=?`).run(value.evidenceId,
      value.fact.target.kind === 'category' ? value.fact.target.category : '', evidenceDigest(value.fact.target), value.fact.status,
      value.observedAtMs, b.databaseGeneration, b.schemaDigest, c.authorityId, c.ledgerSchemaDigest, b.sequence,
      c.committedSequence, c.committedHeadDigest, c.revision, value.policyVersion, payload, evidenceDigest(payload), row.operation_id, row.evidence_id);
  } finally { db.exec(lifecycleEvidenceSchemaObjects.find(object => object.name === 'account_deletion_evidence_no_update')!.sql); }
}

for (const mismatch of ['scope', 'proof', 'policy'] as const)
  test(`P1 a fresh operation cannot reuse local proof across a ${mismatch} mismatch`, async t => {
    const f = fixture(t); await f.confirm(); f.purge('proof-operation'); const before = f.facts();
    if (mismatch === 'scope') {
      const witness = bindSourceLifecycleEvidenceWitnessReader(f.db, f.auth.current,
        () => ({ databaseGeneration: 'generation-one', mainStoreId: 'synthetic-source-main', witnessRevision: 1 }));
      const values = [...adapters(f.db, f.auth.current), { category: 'synthetic-foreign-category',
        suppress: () => ({ status: 'complete' as const }), verifySuppressed: () => ({ status: 'complete' as const }),
        purge: () => ({ status: 'unavailable' as const }), inventory: () => ({ category: 'synthetic-foreign-category', status: 'unavailable' as const }),
        export: () => ({ category: 'synthetic-foreign-category', status: 'unavailable' as const }) }];
      const localAbsence = ([['activity', 'activity-owned-v1'], ['trainingFeedback', 'training-feedback-owned-v1'], ['progressComparison', 'progress-comparison-owned-v1']] as const)
        .map(([category, owner]) => bindSourceLifecycleLocalAbsenceReader(f.db, values.find(value => value.category === category)!, owner));
      const changed = createSourceLifecycleEvidence({ configuration, db: f.db, authority: f.auth.current, witness, adapters: values, localAbsence });
      f.advanceClock();
      changed.lifecycle.purgeLocal(issueLocalPurgeAuthority(changed.lifecycle, { requestId, operationId: 'foreign-scope-operation' }));
      assert.equal(changed.completion(requestId)!.calculation.hold, 'evidence_conflict');
      assert.deepEqual(changed.completion(requestId)!.completedCategories, []);
      assert.deepEqual(f.facts().slice(0, before.length), before);
    } else {
      if (mismatch === 'proof') f.db.prepare('UPDATE account_deletion_requests SET verified_at_ms=verified_at_ms+1 WHERE id=?').run(requestId);
      else f.db.prepare('UPDATE account_deletion_requests SET policy_version=? WHERE id=?').run('foreign-policy', requestId);
      f.advanceClock(); assert.throws(() => f.purge('foreign-operation'), code('lifecycle_evidence_held'));
      assert.deepEqual(f.facts(), before);
    }
  });

for (const mismatch of ['digest', 'target', 'binding', 'future', 'operation-time'] as const)
  test(`P1 ${mismatch} evidence cannot supply a matching earlier local proof`, async t => {
    const f = fixture(t); await f.confirm(); f.purge('proof-operation');
    const row = (f.facts() as { operation_id: string; evidence_id: string; category: string; payload: string }[])
      .find(value => value.category === 'activity')!;
    const value = decodeDurableEvidence(row.payload); assert.equal(value.fact.status, 'qualifying');
    if (value.fact.status !== 'qualifying') throw new Error('expected positive fixture');
    const changed: DurableEvidence = mismatch === 'digest' ? { ...value, fact: { ...value.fact,
      witness: { ...value.fact.witness, evidenceDigest: 'f'.repeat(64) } } }
      : mismatch === 'target' ? { ...value, fact: { ...value.fact, target: { kind: 'category', category: 'synthetic-other-target' } } }
      : mismatch === 'binding' ? { ...value, fact: { ...value.fact, binding: { ...value.fact.binding, databaseGeneration: 'foreign-generation' } } }
      : mismatch === 'future' ? { ...value, observedAtMs: value.observedAtMs + 10000,
        fact: { ...value.fact, witness: { ...value.fact.witness, observedAtMs: value.observedAtMs + 10000 } } }
      : { ...value, observedAtMs: value.observedAtMs - 1,
        fact: { ...value.fact, witness: { ...value.fact.witness, observedAtMs: value.observedAtMs - 1 } } };
    replaceSyntheticEvidence(f.db, row, changed);
    const before = f.facts(); f.advanceClock();
    if (mismatch === 'future' || mismatch === 'operation-time') {
      assert.throws(() => f.purge('fresh-operation'), code('lifecycle_evidence_held')); assert.deepEqual(f.facts(), before);
    } else {
      f.purge('fresh-operation');
      const current = f.source.completion(requestId)!;
      const rows = f.facts() as { operation_id: string; category: string; payload: string }[];
      const fresh = decodeDurableEvidence(rows.find(item => item.operation_id === 'fresh-operation' && item.category === 'activity')!.payload);
      assert.equal(fresh.fact.status, 'qualifying');
      if (fresh.fact.status !== 'qualifying') throw new Error('expected current positive');
      assert.equal(fresh.fact.witness.observedAtMs, fresh.observedAtMs);
      assert.notDeepEqual(fresh.fact.witness, changed.fact.witness);
      assert.deepEqual(rows.slice(0, before.length), before);
      if (mismatch === 'digest') { assert.equal(current.calculation.hold, 'evidence_conflict'); assert.deepEqual(current.completedCategories, []); }
      else assert.equal(current.calculation.hold, null);
    }
  });

for (const status of ['retained', 'not_qualifying', 'conflicting'] as const)
  test(`P1 fresh success never resolves ${status} evidence`, async t => {
    let retained = false;
    const f = fixture(t, values => values.map(value => value.category !== 'activity' ? value : { ...value,
      purge: (request: string, account: string) => retained ? { status: 'retained' as const } : value.purge(request, account) }));
    await f.confirm(); f.purge('proof-operation'); retained = true; f.advanceClock(); f.purge('proof-operation');
    if (status !== 'retained') {
      const row = (f.facts() as { operation_id: string; evidence_id: string; result: string; payload: string }[]).find(value => value.result === 'retained')!;
      const value = decodeDurableEvidence(row.payload);
      replaceSyntheticEvidence(f.db, row, { ...value, fact: { ...value.fact, status, witness: null } });
    }
    const before = f.facts(); retained = false; f.advanceClock(); f.purge('fresh-operation');
    const all = f.facts() as { operation_id: string; category: string; payload: string }[];
    assert.deepEqual(all.slice(0, before.length), before);
    const fresh = decodeDurableEvidence(all.find(value => value.operation_id === 'fresh-operation' && value.category === 'activity')!.payload);
    assert.deepEqual(fresh.fact.resolves, []);
    assert.equal(f.source.completion(requestId)!.completedCategories.includes('activity'), false);
    if (status === 'conflicting') assert.equal(f.source.completion(requestId)!.calculation.hold, 'evidence_conflict');
  });
