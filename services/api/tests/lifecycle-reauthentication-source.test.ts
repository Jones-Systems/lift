import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { chmodSync, copyFileSync, existsSync, linkSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, migrate, openStorage, integrity } from '../src/storage.js';
import { runtimeMigrations } from '../src/runtime-modules/migrations.js';
import { actionReauthenticationMigrationSql, actionReauthenticationSchemaObjects, assertActionReauthenticationSchema } from '../src/lifecycle/reauthentication-migration.js';
import { assertSourceActionReauthenticationHistory, assertSourceActionReauthenticationSelection } from '../src/lifecycle/reauthentication-source-migrations.js';
import { assertSourceProviderRevocationHistory, selectSourceProviderRevocationMigrations } from '../src/lifecycle/providers/source-migrations.js';
import { createSourceProviderRevocation } from '../src/lifecycle/providers/source.js';
import { openSourceActionReauthenticationStorage, bindSourceActionContinuityWitness } from '../src/lifecycle/reauthentication-source.js';
import { bindSourceLifecycleEvidenceWitnessReader, bindSourceLifecycleCurrentness, readSourceLifecycleCurrentness } from '../src/lifecycle/evidence-store.js';
import { evidenceCanonical } from '../src/lifecycle/evidence-codec.js';
import { issueLocalPurgeAuthority } from '../src/lifecycle/purge-executor.js';
import { lifecyclePolicy } from '../src/lifecycle/service.js';
import { DomainError } from '../src/errors.js';
import { source26Fixture, A, B, selected, configuration, requestId, statusSecret, type DeliveryMode } from './lifecycle-reauthentication-fixture.js';
import type { SourceLifecycleEvidenceGeneration } from '../src/lifecycle/evidence-store.js';
import { encodeLifecycleV2, decodeLifecycleV2 } from '../src/lifecycle/wire-v2.js';
const issue = { purpose: 'account_delete', method: 'email_action_code', requestKey: 'source-action' } as const;
const denied = (error: unknown) => error instanceof DomainError;
const history = selected.map(row => ({ version: row.version, checksum: hash(row.sql) }));

async function minted(f: ReturnType<typeof source26Fixture>, method: 'email_action_code' | 'phone_action_code' = 'email_action_code') {
  const c = await f.source.issueChallenge(A, { ...issue, method });
  return f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() });
}

test('exact26 validates immutable full history, strict predecessor slices, SQL hash and all27 owned objects', t => {
  assert.equal(Buffer.byteLength(actionReauthenticationMigrationSql), 16444);
  assert.equal(hash(actionReauthenticationMigrationSql), 'ff96a0f3d43cf08210828260ae422acfe1d5559c678db49d1155bafe51815fe7');
  assert.deepEqual(selected.slice(0, 25), selectSourceProviderRevocationMigrations());
  assertSourceActionReauthenticationSelection(selected);
  for (let length = 0; length <= 26; length++) assertSourceActionReauthenticationHistory(history.slice(0, length));
  assertSourceActionReauthenticationHistory(history, true);
  assert.throws(() => assertSourceProviderRevocationHistory(history, true));
  assert.deepEqual(runtimeMigrations.map(row => row.version), Array.from({ length: 16 }, (_, i) => i + 1));
  for (const altered of [selected.slice(1), selected.slice(0, 25), [...selected, { version: 27, sql: '' }],
    selected.map(row => row.version === 26 ? { ...row, sql: row.sql + ' ' } : row)]) assert.throws(() => assertSourceActionReauthenticationSelection(altered));
  for (const altered of [history.filter(row => row.version !== 13), [...history.slice(0, 25), history[24]!],
    history.map(row => row.version === 25 ? { ...row, checksum: 'a'.repeat(64) } : row), [...history, { version: 27, checksum: '' }]])
    assert.throws(() => assertSourceActionReauthenticationHistory(altered));
  const f = source26Fixture(t); assertActionReauthenticationSchema(f.db, true); integrity(f.db);
  assert.equal(actionReauthenticationSchemaObjects.filter(o => o.type === 'table').length, 3);
  assert.equal(actionReauthenticationSchemaObjects.filter(o => o.type === 'index').length, 7);
  assert.equal(actionReauthenticationSchemaObjects.filter(o => o.type === 'trigger').length, 17);
  assert.equal(f.db.prepare('PRAGMA table_info(account_action_grants)').all().length, 9);
});

test('fresh26, intent-free25 upgrade and complete26 reopen execute real migration, receipt, backup and integrity checks', async t => {
  const f = source26Fixture(t, 25), old = f.db.prepare('SELECT * FROM form_migrations ORDER BY version').all(), b = f.bBytes();
  f.closeMain(); const upgraded = await openSourceActionReauthenticationStorage(f.path, configuration); f.adopt(upgraded.db);
  assert.equal(upgraded.migrationBackups.length, 1); assert.deepEqual(f.db.prepare('SELECT * FROM form_migrations WHERE version<=25 ORDER BY version').all(), old);
  assert.equal(f.bBytes(), b); assertActionReauthenticationSchema(f.db, true); integrity(f.db);
  f.closeMain(); const reopened = await openSourceActionReauthenticationStorage(f.path, configuration); f.adopt(reopened.db);
  assert.deepEqual(reopened.migrationBackups, []); assertSourceActionReauthenticationHistory(f.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as typeof history, true);
  f.closeMain(); const freshPath = join(f.main, 'fresh.sqlite');
  const fresh = await openSourceActionReauthenticationStorage(freshPath, configuration); f.adopt(fresh.db);
  assert.equal(fresh.migrationBackups.length, 25); assertActionReauthenticationSchema(fresh.db, true); integrity(fresh.db);
});

test('S26-CONTRACT-R1-F02: existing25 real provider intent holds pending26 before backup/DDL and preserves bytes, receipts and claims', async t => {
  const f = source26Fixture(t, 25), adapters = f.adapters(f.db);
  const witness = bindSourceLifecycleEvidenceWitnessReader(f.db, f.authority, () => {
    const r = JSON.parse(readFileSync(f.recordPath, 'utf8')) as SourceLifecycleEvidenceGeneration;
    return { databaseGeneration: r.databaseGeneration, mainStoreId: r.mainStoreId, witnessRevision: r.witnessRevision };
  });
  const old = createSourceProviderRevocation({ configuration: { mode: 'source-only', cohort: 'provider-revocation-v1' }, db: f.db,
    authority: f.authority, witness, adapters, custodian: f.custodian, transport: f.transport, clock: f.now });
  f.db.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('password-a','password-a','credential',?,'synthetic-existing-password',1,1)").run(A.authUserId);
  old.lifecycle.initiate(A, 'old25-delete', { requestId, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account', statusSecret });
  const g = await old.lifecycle.issueGrant(A, { purpose: 'account_delete', password: 'synthetic' }, async () => true);
  old.lifecycle.confirm(A, requestId, { grant: g.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' });
  assert.equal((f.db.prepare('SELECT count(*) n FROM account_provider_revocation_intents').get() as { n: number }).n, 1);
  const before = evidenceCanonical([f.db.prepare('SELECT * FROM form_migrations').all(), f.db.prepare('SELECT * FROM account_provider_revocation_intents').all(),
    f.db.prepare('SELECT * FROM account_provider_revocation_attempts').all()]);
  const digest = hash(readFileSync(f.path).toString('base64'));
  await assert.rejects(migrate(f.db, f.path, selected, 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24',
    'selected-provider-revocation-25', 'selected-action-reauthentication-26'), e => e instanceof DomainError && e.code === 'action_reauthentication_upgrade_held');
  assert.equal(existsSync(join(f.main, 'backups')), false);
  assert.equal(hash(readFileSync(f.path).toString('base64')), digest);
  assert.equal(evidenceCanonical([f.db.prepare('SELECT * FROM form_migrations').all(), f.db.prepare('SELECT * FROM account_provider_revocation_intents').all(),
    f.db.prepare('SELECT * FROM account_provider_revocation_attempts').all()]), before);
  f.closeMain();
  await assert.rejects(openSourceActionReauthenticationStorage(f.path, configuration), e => e instanceof DomainError && e.code === 'action_reauthentication_upgrade_held');
  assert.equal(hash(readFileSync(f.path).toString('base64')), digest); assert.equal(existsSync(join(f.main, 'backups')), false);
});

test('source26 rejects default/old selectors and every named old-table26 lookalike before migration effects', async t => {
  const f = source26Fixture(t, 25);
  const adapters = f.adapters(f.db), witness = bindSourceLifecycleEvidenceWitnessReader(f.db, f.authority, () => ({
    mainStoreId: 'synthetic-action-main', databaseGeneration: 'generation-one', witnessRevision: 1 }));
  await assert.rejects(openStorage(join(f.main, 'not-created.sqlite'), selected)); assert.equal(existsSync(join(f.main, 'not-created.sqlite')), false);
  for (const object of actionReauthenticationSchemaObjects.filter(o => o.type !== 'table' && /ON (?:"?user"?|account\b|phone_challenges|session)/.test(o.sql))) {
    f.db.exec(object.type === 'index' ? `CREATE INDEX ${object.name} ON phone_challenges(auth_user_id)` : `CREATE TRIGGER ${object.name} AFTER INSERT ON "user" BEGIN SELECT 1; END`);
    assert.throws(() => createSourceProviderRevocation({ configuration: { mode: 'source-only', cohort: 'provider-revocation-v1' },
      db: f.db, authority: f.authority, witness, adapters, custodian: f.custodian, transport: f.transport }));
    await assert.rejects(migrate(f.db, f.path, selected.slice(0, 25), 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24', 'selected-provider-revocation-25'));
    await assert.rejects(migrate(f.db, f.path, selected, 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24', 'selected-provider-revocation-25', 'selected-action-reauthentication-26'));
    assert.equal(existsSync(join(f.main, 'backups')), false);
    f.db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`);
  }
});

test('genuine email and phone confirmations retain actual proof/time through cascade, purge, local evidence and new26 provider hooks', async t => {
  for (const method of ['email_action_code', 'phone_action_code'] as const) {
    const f = source26Fixture(t); if (method === 'phone_action_code') f.phone();
    f.db.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('purge-null-credential','purge-null-credential','credential',?,NULL,1,1)").run(A.authUserId);
    f.initiate(); const b = f.bBytes(), verified = f.now(), g = await minted(f, method); f.advance(1000);
    assert.throws(() => f.source.consumeExportGrant(A, { grant: g.grant }), denied);
    const wire = encodeLifecycleV2({ schemaVersion: 'form.account-lifecycle.v2', kind: 'action_grant', payload: g });
    assert.ok(decodeLifecycleV2(wire, { schemaVersion: 'form.account-lifecycle.v2', kind: 'action_grant', purpose: 'account_delete', allowedMethods: [method], nowMs: f.now() }));
    const confirmed = f.source.confirmDeletion(A, { requestId, grant: g.grant });
    assert.equal(confirmed.disabled, true); assert.equal(confirmed.complete, false); assert.equal(f.providerCaptures(), 1);
    const r = f.db.prepare('SELECT verified_at_ms,verification_method FROM account_deletion_requests WHERE id=?').get(requestId) as
      { verified_at_ms: number; verification_method: string };
    assert.equal(r.verification_method, method); assert.equal(r.verified_at_ms, verified);
    assert.equal((f.db.prepare('SELECT count(*) n FROM account_action_grants').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) n FROM session WHERE userId=?').get(A.authUserId) as { n: number }).n, 0);
    const { witness } = f.compose();
    const port = bindSourceLifecycleCurrentness(f.db, witness, 'selected-action-reauthentication-26', 'provider-revocation-v1');
    const before = readSourceLifecycleCurrentness(port, requestId);
    const intent = f.db.prepare('SELECT intent_id,proof_digest,schema_digest FROM account_provider_revocation_intents').get() as { intent_id: string; proof_digest: string; schema_digest: string };
    assert.equal(intent.proof_digest, before.proofDigest); assert.equal(intent.schema_digest, before.binding.schemaDigest);
    const attempt = await f.source.attemptOne(intent.intent_id, `action-provider-${method}`); assert.equal(attempt.state, 'acknowledged'); assert.equal(f.providerPosts(), 1);
    f.source.lifecycle.purgeLocal(issueLocalPurgeAuthority(f.source.lifecycle, { requestId, operationId: 'action-local-purge' }));
    const after = readSourceLifecycleCurrentness(port, requestId);
    assert.equal(after.proofDigest, before.proofDigest, 'live contact/budget changes after used proof cannot rewrite attribution');
    const operations = f.db.prepare('SELECT proof_digest FROM account_deletion_evidence_operations').all() as { proof_digest: string }[];
    assert.ok(operations.length > 0); assert.ok(operations.every(o => o.proof_digest === before.proofDigest));
    assert.equal(f.bBytes(), b);
    const reopened = f.reopen(); assert.ok(reopened.localCompletion(requestId));
    assert.throws(() => createSourceProviderRevocation({ configuration: { mode: 'source-only', cohort: 'provider-revocation-v1' }, db: f.db,
      authority: f.authority, witness: f.compose().witness, adapters: f.adapters(f.db), custodian: f.custodian, transport: f.transport }));
    f.cleanup();
  }
});

test('S26-CONTRACT-R1-F01: lost dispatch claim in held main copy never admits hour/reopen restore while original producer is unresolved', async t => {
  const f = source26Fixture(t), snapshot = await f.snapshot(); f.mode('pending');
  const pending = f.source.issueChallenge(A, issue).then(() => false, () => true);
  assert.equal(f.challenge().state, 'dispatching');
  f.interruptedUnprovedCopy(snapshot);
  assert.equal((f.db.prepare('SELECT count(*) n FROM account_action_challenges').get() as { n: number }).n, 0, 'snapshot really loses the durable claim');
  assert.throws(() => f.barrier(), /producer barrier held/);
  f.advance(3600001); assert.throws(() => f.compose(), denied); assert.throws(() => f.reopen(), denied);
  assert.throws(() => f.restore(snapshot), /producer barrier held/);
  assert.equal(f.sends(), 1); f.settle(); assert.equal(await pending, true, 'old operation cannot write after copy/ownership loss');
  f.loseCustody(); assert.throws(() => f.restore(snapshot), /producer barrier held/);
});

test('quiescent synthetic restore holds admission before copy and on partial failure; full readback advances generation then enforces the budget hour', async t => {
  const f = source26Fixture(t), snapshot = await f.snapshot(), g = await minted(f);
  assert.doesNotThrow(() => f.barrier());
  assert.throws(() => f.restore(snapshot, true), /interrupted/);
  f.advance(3600001); assert.throws(() => f.compose(), denied, 'reopen does not heal partial restore');
  f.restore(snapshot); const restored = f.compose().source;
  await assert.rejects(restored.issueChallenge(A, issue), denied);
  assert.throws(() => restored.confirmDeletion(A, { requestId, grant: g.grant }), denied);
  f.advance(3599999); await assert.rejects(restored.issueChallenge(A, issue), denied);
  f.advance(1); const c = await restored.issueChallenge(A, { ...issue, requestKey: 'post-quarantine' }); assert.equal(c.state, 'ready');
});

test('throwing start, malformed handle, rejected settlement, pending/rejected cancellation and late ACK keep durable exclusion at hour/reopen', async t => {
  for (const mode of ['throw', 'malformed', 'settlement_rejected', 'cancel_pending', 'cancel_rejected', 'late'] as readonly DeliveryMode[]) {
    const f = source26Fixture(t), snapshot = await f.snapshot(); f.mode(mode);
    await assert.rejects(f.source.issueChallenge(A, issue), denied);
    assert.equal(f.challenge().state, 'dispatching');
    const revision = f.challenge().revision;
    f.advance(3600001); const reopened = f.reopen();
    await assert.rejects(reopened.issueChallenge(A, { ...issue, requestKey: 'replacement' }), denied);
    assert.equal(f.challenge().state, 'dispatching'); assert.equal(f.challenge().revision, revision); assert.equal(f.sends(), 1);
    if (mode !== 'late') assert.throws(() => f.restore(snapshot), /producer barrier held/);
    f.cleanup();
  }
});

test('session revocation during actual delivery cannot release a dispatching producer or turn its late result ready', async t => {
  const f = source26Fixture(t); f.mode('pending');
  const pending = f.source.issueChallenge(A, issue);
  f.db.prepare('DELETE FROM session WHERE id=?').run(A.sessionId);
  assert.equal(f.challenge().state, 'dispatching'); f.settle(); await assert.rejects(pending, denied);
  assert.equal(f.challenge().state, 'dispatching');
});

test('continuity native file identity, modes, bounds, strict keys, monotonic high-water and generation survive distinct main handles', async t => {
  const f = source26Fixture(t), original = readFileSync(f.recordPath), c = await f.source.issueChallenge(A, issue);
  const second = f.openOther(), other = f.compose(second).source;
  const g = other.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() }); assert.ok(g.grant.length === 43);
  assert.throws(() => f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() }), denied);
  f.advance(1); f.compose(second);
  writeFileSync(f.recordPath, original); assert.throws(() => f.compose(), denied, 'independent high-water survives new handle'); f.publish();
  chmodSync(f.recordPath, 0o644); assert.throws(() => f.compose(), denied); chmodSync(f.recordPath, 0o600);
  writeFileSync(f.recordPath, 'x'.repeat(2049)); assert.throws(() => f.compose(), denied); f.publish();
  const record = JSON.parse(readFileSync(f.recordPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(f.recordPath, evidenceCanonical({ ...record, extra: true })); assert.throws(() => f.compose(), denied); f.publish();
  const alias = join(f.independent, 'continuity-hardlink'); linkSync(f.recordPath, alias); assert.throws(() => f.compose(), denied);
  second.close();
});

test('foreign owned-table schema and absent continuity are held by actual currentness', async t => {
  const f = source26Fixture(t), c = await f.source.issueChallenge(A, issue);
  f.db.exec('CREATE INDEX foreign_action_index ON account_action_challenges(state)');
  assert.throws(() => f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() }), denied);
  f.db.exec('DROP INDEX foreign_action_index');
  f.unavailable(); assert.throws(() => f.compose(), denied);
  const unbound = bindSourceLifecycleEvidenceWitnessReader(f.db, f.authority, () => ({ databaseGeneration: 'foreign-generation', mainStoreId: 'synthetic-action-main', witnessRevision: 1 }));
  assert.throws(() => bindSourceActionContinuityWitness(f.db, unbound, { recordPath: f.recordPath }), denied);
});

test('main SQL failure after independent suppression leaves effect unknown, suppresses active access and never reconstructs request proof', async t => {
  const f = source26Fixture(t, 26, () => {}, db => db.exec(`CREATE TRIGGER synthetic_action_main_failure BEFORE UPDATE OF phase ON account_deletion_requests
    WHEN NEW.phase='disabled_pending_purge' BEGIN SELECT RAISE(ABORT,'synthetic_main_failure'); END`));
  f.initiate(); const g = await minted(f);
  assert.throws(() => f.source.confirmDeletion(A, { requestId, grant: g.grant }), e => e instanceof DomainError && e.code === 'deletion_effect_unknown');
  assert.ok(f.authority.lookup(A.accountId)); assert.throws(() => f.source.lifecycle.assertActive(A));
  assert.equal((f.db.prepare('SELECT phase FROM account_deletion_requests WHERE id=?').get(requestId) as { phase: string }).phase, 'awaiting_reauthentication');
  const proof = f.db.prepare('SELECT used_at_ms,deletion_request_id FROM account_action_proof_consumptions').get() as { used_at_ms: number | null; deletion_request_id: string | null };
  assert.equal(proof.used_at_ms, null); assert.equal(proof.deletion_request_id, null);
  await assert.rejects(f.source.issueChallenge(A, { ...issue, requestKey: 'after-fault' }));
});


test('native main inode and generation changes invalidate captured authority; constructors cannot fabricate continuity', async t => {
  for (const kind of ['main-inode', 'generation'] as const) {
    const f = source26Fixture(t), c = await f.source.issueChallenge(A, issue);
    if (kind === 'main-inode') {
      const original = join(f.main, 'original-main.sqlite'); renameSync(f.path, original); copyFileSync(original, f.path);
    } else {
      const record = JSON.parse(readFileSync(f.recordPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(f.recordPath, evidenceCanonical({ ...record, databaseGeneration: 'different-generation', revision: Number(record.revision) + 1, witnessRevision: 2 }));
    }
    assert.throws(() => f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() }), denied);
    f.cleanup();
  }
});

test('replacing the independent continuity inode cannot reset retained high-water on a fresh main handle', t => {
  const f = source26Fixture(t), original = readFileSync(f.recordPath);
  f.advance(1); f.compose();
  renameSync(f.recordPath, join(f.independent, 'original-continuity.json'));
  writeFileSync(f.recordPath, original, { mode: 0o600 });
  assert.throws(() => f.compose(), denied);
  assert.throws(() => f.reopen(), denied);
});

test('real pending independent suppression holds all action admission; an unrelated settled prefix still permits account A proof', async t => {
  const f = source26Fixture(t, 26, point => { if (point === 'ledger:before-commit') throw new Error('synthetic unresolved ledger'); });
  assert.throws(() => f.authority.recordDisable({ accountId: B.accountId, authUserId: B.authUserId, epoch: 1,
    requestId: '44444444-4444-4444-8444-444444444444', disabledAtMs: f.now() }));
  assert.ok(f.witnessFile.read().pending);
  await assert.rejects(f.source.issueChallenge(A, issue), denied); f.cleanup();
  const settled = source26Fixture(t), c = await settled.source.issueChallenge(A, issue);
  settled.authority.recordDisable({ accountId: B.accountId, authUserId: B.authUserId, epoch: 1,
    requestId: '44444444-4444-4444-8444-444444444444', disabledAtMs: settled.now() });
  const g = settled.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: settled.code() }); assert.ok(g.grant.length === 43);
});
