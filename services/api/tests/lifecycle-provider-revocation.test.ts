import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Domain } from '../src/domain.js';
import { DomainError } from '../src/errors.js';
import { backupAndVerify, hash, integrity, openStorage, type Sqlite } from '../src/storage.js';
import { bindSuppressionAuthority, subjectEligibility } from '../src/lifecycle/guards.js';
import { lifecyclePolicy } from '../src/lifecycle/service.js';
import { buildAccountExport } from '../src/lifecycle/export.js';
import { issueLocalPurgeAuthority } from '../src/lifecycle/purge-executor.js';
import { suppressionLedgerSchema } from '../src/lifecycle/ledger.js';
import { assertSourceLifecycleEvidenceHistory, selectSourceLifecycleEvidenceMigrations } from '../src/lifecycle/source-migrations.js';
import { bindSourceLifecycleLocalAbsenceReader } from '../src/lifecycle/local-absence.js';
import { LifecycleEvidenceStore, bindSourceLifecycleEvidenceWitnessReader, bindSourceLifecycleCurrentness, readSourceLifecycleCurrentness,
  type SourceLifecycleEvidenceGeneration, type SourceLifecycleEvidenceWitnessReader } from '../src/lifecycle/evidence-store.js';
import { evidenceCanonical, evidenceDigest } from '../src/lifecycle/evidence-codec.js';
import { CurrentSuppressionAuthority, genesisHead, ledgerSchemaDigest, witnessSchema } from '../src/runtime-modules/currentness.js';
import { AuthorityLock, JsonFile, canonicalPath } from '../src/runtime-modules/files.js';
import { runtimeMigrations } from '../src/runtime-modules/migrations.js';
import { createCanonicalAccountWriter } from '../src/integration/account-modules/canonical-writer.js';
import { createSourceAccountModules, createSourceTrainingLifecycleAdapters } from '../src/integration/account-modules/index.js';
import { createSourceRequestFactories } from '../src/lifecycle/request-factories.js';
import { createManualMeasurements } from '../src/body/measurements.js';
import type { AccountContext, LifecycleAdapter } from '../src/lifecycle/types.js';
import { install } from './integration/account-modules/fixture.js';
import { selectSourceProviderRevocationMigrations, assertSourceProviderRevocationSelection, assertSourceProviderRevocationHistory } from '../src/lifecycle/providers/source-migrations.js';
import { providerRevocationMigrationSql, providerRevocationSchemaObjects, assertProviderRevocationSchema } from '../src/lifecycle/providers/outbox-migration.js';
import { createSourceProviderRevocation, openSourceProviderRevocationStorage } from '../src/lifecycle/providers/source.js';
import { parseIntent, parseAttempt, decodeProviderFact, encodeProviderFact, providerTarget, referenceFor, intentCheckpoint, type ProviderIntent } from '../src/lifecycle/providers/outbox-codec.js';
import { captureReference, tokenReferenceVersion, validateResolvedReference } from '../src/lifecycle/providers/reference.js';
import type { BoundedAppleTransport, MaterialCustodian, QualifiedToken, CaptureMaterial, ResolveMaterial, AppleResponse,
  BoundedProviderOperation, ProviderBudget } from '../src/lifecycle/providers/types.js';
const configuration = { mode: 'source-only', cohort: 'provider-revocation-v1' } as const;
const selected = selectSourceProviderRevocationMigrations();
const requestId = '33333333-3333-4333-8333-333333333333';
const A: AccountContext = { accountId: '11111111-1111-4111-8111-111111111111', authUserId: 'revoke-auth-a', sessionId: 'revoke-session-a', epoch: 0 };
const B: AccountContext = { accountId: '22222222-2222-4222-8222-222222222222', authUserId: 'revoke-auth-b', sessionId: 'revoke-session-b', epoch: 0 };
const statusSecret = 's'.repeat(43);
const done = <T>(value: T): BoundedProviderOperation<T> => ({ settled: Promise.resolve(value), cancel: async () => {} });
function scratch(t: TestContext): { root: string; handles: Set<Sqlite>; closers: (() => void)[] } {
  const root = mkdtempSync(join(homedir(), '.form-provider-revocation-test-')); chmodSync(root, 0o700);
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
  t.diagnostic(`synthetic source25 fixture cleanup owner: ${root}`);
  return { root, handles, closers };
}
function file(f: ReturnType<typeof scratch>, name: string, prefix = 25): Sqlite {
  const db: Sqlite = new Database(join(f.root, name)); f.handles.add(db); chmodSync(db.name, 0o600);
  install(db, selected.slice(0, prefix)); return db;
}
function authority(f: ReturnType<typeof scratch>, fault: (point: string) => void = () => {}) {
  const directory = join(f.root, 'authority'); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'ledger.sqlite'), uid = process.getuid!(), authorityId = randomUUID();
  const db = new Database(path); chmodSync(path, 0o600);
  try { db.exec(suppressionLedgerSchema); db.prepare('INSERT INTO suppression_authority VALUES(?,0)').run(authorityId); } finally { db.close(); }
  const lock = new AuthorityLock(directory, uid, randomUUID()); f.closers.push(() => lock.release());
  const witness = JsonFile.create(join(directory, 'currentness.json'), uid, witnessSchema, {
    version: 1, authorityId, ledgerSchemaDigest, revision: 0, directory: lock.directoryIdentity,
    ledger: canonicalPath(path, uid), committedSequence: 0, committedHeadDigest: genesisHead(authorityId), pending: null,
  });
  const current = new CurrentSuppressionAuthority(lock, witness, path, authorityId, fault); f.closers.push(() => current.close());
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

function fixture(t: TestContext, fault: (point: string) => void = () => {}) {
  const f = scratch(t), db = file(f, 'main.sqlite'), auth = authority(f, fault); actors(db);
  const generationPath = join(f.root, 'external-generation.json');
  const writeGeneration = (databaseGeneration: string, witnessRevision = 1) => writeFileSync(generationPath,
    JSON.stringify({ databaseGeneration, mainStoreId: 'synthetic-provider-main', witnessRevision }), { mode: 0o600 });
  writeGeneration('generation-one');
  let now = Date.now(), sends = 0, captures = 0, resolutions = 0;
  const material: QualifiedToken = Object.freeze({ rowId: 'apple-row-a', authUserId: A.authUserId, provider: 'apple',
    immutableSubject: 'synthetic-apple-subject-a', clientBindingId: 'synthetic-issuer-a', clientId: 'synthetic.form.client',
    tokenKind: 'refresh_token', token: 'synthetic-refresh-a', provenance: 'issuer-client-subject-token-v1' });
  for (const [actor, suffix] of [[A, 'a'], [B, 'b']] as const) db.prepare(`INSERT INTO account(id,accountId,providerId,userId,refreshToken,accessToken,idToken,createdAt,updatedAt)
    VALUES(?,?,'apple',?,?,?,?,1,1)`).run(`apple-row-${suffix}`, `synthetic-apple-subject-${suffix}`, actor.authUserId,
      `synthetic-refresh-${suffix}`, `synthetic-access-${suffix}`, `synthetic-id-${suffix}`);
  const behavior: { capture: (account: Parameters<MaterialCustodian['capture']>[0]) => CaptureMaterial;
    resolve: MaterialCustodian['resolve']; post: BoundedAppleTransport['post'] } = {
    capture: account => account.rowId === material.rowId ? { status: 'qualified', material } : { status: 'unavailable', reason: 'token_provenance_unavailable' },
    resolve: () => done({ status: 'qualified', value: { material, clientSecret: 'synthetic-secret' } }),
    post: () => done({ status: 200, body: new Uint8Array(), truncated: false }),
  };
  const custodian: MaterialCustodian = { contract: 'bounded-provider-material-v1', capture: account => {
    captures++; assert.equal(db.inTransaction || handlesInTransaction(), true); return behavior.capture(account);
  }, resolve: (reference, budget) => { resolutions++; assert.equal(handlesInTransaction(), false); return behavior.resolve(reference, budget); } };
  const transport: BoundedAppleTransport = { contract: 'bounded-apple-revoke-v1', post: (request, budget) => {
    sends++; assert.equal(handlesInTransaction(), false); return behavior.post(request, budget);
  } };
  const handlesInTransaction = () => [...f.handles].some(handle => handle.open && handle.inTransaction);
  const compose = (store: Sqlite) => {
    const witness = bindSourceLifecycleEvidenceWitnessReader(store, auth.current, exact => {
      assert.equal(exact, store); return JSON.parse(readFileSync(generationPath, 'utf8')) as SourceLifecycleEvidenceGeneration;
    });
    const values = adapters(store, auth.current);
    const localAbsence = ([['activity', 'activity-owned-v1'], ['progressComparison', 'progress-comparison-owned-v1'],
      ['trainingFeedback', 'training-feedback-owned-v1']] as const).map(([category, owner]) =>
      bindSourceLifecycleLocalAbsenceReader(store, values.find(adapter => adapter.category === category)!, owner));
    const source = createSourceProviderRevocation({ configuration, db: store, authority: auth.current, witness,
      adapters: values, localAbsence, custodian, transport, clock: () => now });
    return { ...source, witness };
  };
  const source = compose(db);
  const initiate = () => source.lifecycle.initiate(A, 'provider-delete', { requestId, policyVersion: lifecyclePolicy,
    confirmation: 'delete_whole_account', statusSecret });
  const grant = async (purpose: 'account_delete' | 'account_export' = 'account_delete') => source.lifecycle.issueGrant(A,
    { purpose, password: 'synthetic-password' }, async () => true);
  const confirm = async () => { initiate(); const g = await grant(); return source.lifecycle.confirm(A, requestId,
    { grant: g.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' }); };
  const intents = () => (db.prepare('SELECT * FROM account_provider_revocation_intents ORDER BY source_account_row_id').all()).map(parseIntent);
  const intent = () => intents().find(i => i.source_account_row_id === material.rowId)!;
  const attempt = (id: string) => db.prepare('SELECT * FROM account_provider_revocation_attempts WHERE attempt_id=?').get(id);
  const reopen = (path = db.name) => { const other: Sqlite = new Database(path); f.handles.add(other); other.pragma('foreign_keys=ON'); return other; };
  return { ...f, db, auth, source, compose, material, custodian, transport, behavior, initiate, grant, confirm, intents, intent, attempt,
    writeGeneration, reopen, sends: () => sends, captures: () => captures, resolutions: () => resolutions,
    advance: (ms = 1000) => { now += ms; }, now: () => now };
}

test('exact25 selection preserves every historical byte and rejects forged, gap, trailing and default24 histories', () => {
  assert.equal(Buffer.byteLength(providerRevocationMigrationSql), 7612);
  assert.equal(hash(providerRevocationMigrationSql), '84397747353ce2cbe56de43fd64dcb4a849e0b1702363f79d222ff11e92f5c6f');
  assert.deepEqual(selected.slice(0, 24), selectSourceLifecycleEvidenceMigrations());
  assert.deepEqual(selected.map(i => i.version), Array.from({ length: 25 }, (_, i) => i + 1));
  assert.deepEqual(runtimeMigrations.map(i => i.version), Array.from({ length: 16 }, (_, i) => i + 1));
  assertSourceProviderRevocationSelection(selected);
  const history = selected.map(i => ({ version: i.version, checksum: hash(i.sql) }));
  for (let length = 0; length <= 25; length++) assertSourceProviderRevocationHistory(history.slice(0, length));
  assertSourceProviderRevocationHistory(history, true);
  assert.throws(() => assertSourceLifecycleEvidenceHistory(history, true));
  for (const value of [selected.slice(1), selected.slice(0, 24), [...selected, { version: 26, sql: '' }],
    selected.map(i => i.version === 24 ? { ...i, sql: i.sql + ' ' } : i), selected.map(i => i.version === 25 ? { ...i, sql: i.sql + ' ' } : i)])
    assert.throws(() => assertSourceProviderRevocationSelection(value));
  for (const value of [history.filter(i => i.version !== 7), [...history, { version: 27, checksum: 'a'.repeat(64) }],
    history.map(i => i.version === 25 ? { ...i, checksum: 'a'.repeat(64) } : i), [...history.slice(0, 24), history[23]!]])
    assert.throws(() => assertSourceProviderRevocationHistory(value));
  assert.throws(() => assertSourceProviderRevocationHistory(history.slice(0, 24), true));
});

test('storage preflight runs before creating files; genuine24 upgrade backs up and exact25 reopens without migration', async t => {
  const f = scratch(t), bad = join(f.root, 'not-created', 'main.sqlite');
  await assert.rejects(openStorage(bad, selected, 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24'));
  await assert.rejects(openStorage(bad, [...selected, { version: 26, sql: '' }], 'selected-migration-22', 'selected-migration-23',
    'selected-lifecycle-evidence-24', 'selected-provider-revocation-25'));
  assert.equal(existsSync(join(f.root, 'not-created')), false);
  const old = file(f, 'upgrade.sqlite', 24); old.close();
  const opened = await openSourceProviderRevocationStorage(old.name, configuration); f.handles.add(opened.db);
  assert.equal(opened.migrationBackups.length, 1);
  assert.equal(existsSync(opened.migrationBackups[0]!), true); assertProviderRevocationSchema(opened.db, true); integrity(opened.db);
  opened.db.close();
  const again = await openSourceProviderRevocationStorage(old.name, configuration); f.handles.add(again.db);
  assert.deepEqual(again.migrationBackups, []);
  await assert.rejects(openStorage(old.name, selectSourceLifecycleEvidenceMigrations(), 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24'));
});

test('schema rejects orphan objects, altered table/index/trigger and rolls back partial migration25 without receipt', async t => {
  const f = scratch(t);
  for (const object of providerRevocationSchemaObjects) {
    const db = file(f, `${object.name}.sqlite`);
    if (object.type !== 'table') db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`);
    else db.exec(`ALTER TABLE ${object.name} ADD COLUMN synthetic_tamper TEXT`);
    assert.throws(() => assertProviderRevocationSchema(db, true));
  }
  const orphan = file(f, 'orphan.sqlite', 24); orphan.exec('CREATE TABLE account_provider_revocation_intents(id TEXT)'); orphan.close();
  await assert.rejects(openSourceProviderRevocationStorage(orphan.name, configuration));
  const target = file(f, 'partial.sqlite', 24), original = target.exec.bind(target);
  target.exec = ((sql: string) => {
    if (sql === providerRevocationMigrationSql) { original(providerRevocationSchemaObjects[0]!.sql); throw new Error('synthetic-partial-ddl'); }
    return original(sql);
  }) as typeof target.exec;
  const { migrate } = await import('../src/storage.js');
  await assert.rejects(migrate(target, target.name, selected, 'selected-migration-22', 'selected-migration-23',
    'selected-lifecycle-evidence-24', 'selected-provider-revocation-25'), /synthetic-partial-ddl/);
  target.exec = original; assertProviderRevocationSchema(target, false);
  assert.equal(target.prepare('SELECT 1 FROM form_migrations WHERE version=25').get(), undefined); integrity(target);
});

test('capture follows grant/session/epoch/request ownership and leaves foreign user material unchanged', async t => {
  const f = fixture(t); f.initiate(); const grant = await f.grant();
  const input = { grant: grant.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' as const };
  for (const actor of [{ ...A, authUserId: B.authUserId }, { ...A, sessionId: B.sessionId }, { ...A, epoch: 1 }, B])
    assert.throws(() => f.source.lifecycle.confirm(actor, requestId, input));
  const exportGrant = await f.grant('account_export');
  assert.throws(() => f.source.lifecycle.confirm(A, requestId, { ...input, grant: exportGrant.grant }));
  assert.throws(() => f.source.lifecycle.confirm(A, randomUUID(), input));
  assert.equal(f.captures(), 0); assert.deepEqual(f.intents(), []); assert.equal(f.auth.current.lookup(A.accountId), null);
  f.advance(300001); assert.throws(() => f.source.lifecycle.confirm(A, requestId, input)); assert.equal(f.captures(), 0);
  const fresh = await f.grant();
  const other = f.db.prepare('SELECT * FROM account WHERE userId=?').all(B.authUserId);
  f.source.lifecycle.confirm(A, requestId, { ...input, grant: fresh.grant });
  assert.equal(f.captures(), 1); assert.equal(f.intents().length, 1);
  assert.deepEqual(f.db.prepare('SELECT * FROM account WHERE userId=?').all(B.authUserId), other);
  assert.equal(f.db.prepare('SELECT 1 FROM session WHERE userId=?').get(A.authUserId), undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM account_action_grants WHERE account_id=?').get(A.accountId), undefined);
  assert.throws(() => f.source.lifecycle.confirm(A, requestId, input)); assert.equal(f.captures(), 1);
  f.source.lifecycle.assertActive(B); assert.equal(f.sends(), 0);
});

for (const reason of ['material_missing', 'client_binding_unavailable', 'token_provenance_unavailable', 'material_invalid'] as const)
  test(`unavailable ${reason} survives local purge without fabricating a provider target or credential copy`, async t => {
    const f = fixture(t); f.behavior.capture = () => ({ status: 'unavailable', reason });
    await f.confirm(); const i = f.intent(); assert.equal(i.residual_code, reason); assert.equal(i.reference_version, null);
    const foreign = f.db.prepare('SELECT * FROM account WHERE userId=?').all(B.authUserId);
    f.source.lifecycle.purgeLocal(issueLocalPurgeAuthority(f.source.lifecycle, { requestId, operationId: 'purge-unavailable' }));
    assert.equal(f.source.localCompletion(requestId)!.localPurged, true);
    assert.equal(f.source.lifecycle.status(requestId, statusSecret).complete, false);
    assert.deepEqual(f.source.providerCompletion(i.intent_id), { status: 'unavailable', residual: reason, wholeAccountDeviceProviderErasure: 'unproven' });
    await assert.rejects(f.source.attemptOne(i.intent_id, 'missing-material')); assert.equal(f.sends(), 0);
    assert.deepEqual(f.db.prepare('SELECT * FROM account WHERE userId=?').all(B.authUserId), foreign);
    assert.equal(f.db.prepare('SELECT refreshToken FROM account WHERE id=?').get('apple-row-a') !== undefined, true);
    assert.deepEqual(f.intents(), [i]);
  });

test('capture validates actual auth row and qualified historical issuer/token, preferring custodian-qualified refresh', t => {
  const f = fixture(t), account = { rowId: f.material.rowId, authUserId: A.authUserId, provider: 'apple', immutableSubject: f.material.immutableSubject };
  const capture = (material: QualifiedToken) => captureReference(f.db, account, { ...f.custodian, capture: () => ({ status: 'qualified', material }) });
  const good = capture(f.material); assert.equal(good.referenceVersion, tokenReferenceVersion(f.material));
  for (const material of [{ ...f.material, rowId: 'apple-row-b' }, { ...f.material, authUserId: B.authUserId },
    { ...f.material, immutableSubject: 'other-subject' }, { ...f.material, token: 'synthetic-id-a' },
    { ...f.material, tokenKind: 'id_token' }, { ...f.material, provenance: 'current-config' },
    { ...f.material, clientId: 'x'.repeat(256) }, { ...f.material, token: 'x'.repeat(16385) }])
    assert.equal(capture(material as QualifiedToken).residualCode, 'material_invalid');
  const access = { ...f.material, tokenKind: 'access_token' as const, token: 'synthetic-access-a' };
  assert.equal(capture(access).tokenKind, 'access_token');
  assert.equal(captureReference(f.db, { ...account, provider: 'google' }, f.custodian).residualCode, 'unsupported_provider');
  assert.equal(validateResolvedReference(f.db, good, { material: { ...f.material, clientBindingId: 'changed' }, clientSecret: 'synthetic' }), false);
});

test('suppression commits independently when main intent insert fails; restart denies sessions and never reconstructs intent', async t => {
  const f = fixture(t); f.initiate(); const grant = await f.grant();
  const original = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => { if (sql.startsWith('INSERT INTO account_provider_revocation_intents')) throw new Error('synthetic-main-failure'); return original(sql); }) as typeof f.db.prepare;
  assert.throws(() => f.source.lifecycle.confirm(A, requestId, { grant: grant.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' }));
  f.db.prepare = original;
  assert.equal(f.auth.current.lookup(A.accountId)?.requestId, requestId); assert.deepEqual(f.intents(), []);
  assert.equal((f.db.prepare('SELECT verified_at_ms FROM account_deletion_requests WHERE id=?').get(requestId) as { verified_at_ms: number | null }).verified_at_ms, null);
  assert.throws(() => f.source.lifecycle.assertActive(A));
  f.db.close(); const reopened = f.reopen(), source = f.compose(reopened);
  assert.equal(reopened.prepare('SELECT 1 FROM session WHERE userId=?').get(A.authUserId), undefined);
  await assert.rejects(source.attemptOne('no-original-intent', 'must-not-send')); assert.equal(f.sends(), 0);
});

test('original immutable intent and empty200 scoped acknowledgment replay after clean reopen with zero additional sends', async t => {
  const f = fixture(t);
  const otherRows = f.db.prepare('SELECT * FROM account WHERE userId=?').all(B.authUserId);
  const beforeExport = JSON.stringify(buildAccountExport(f.db, B, actor => f.source.lifecycle.assertActive(actor), f.source.lifecycle.adapters));
  await f.confirm(); const i = f.intent();
  const ack = await f.source.attemptOne(i.intent_id, 'ack-one'); assert.equal(ack.state, 'acknowledged'); assert.equal(f.sends(), 1);
  const a = parseAttempt(f.attempt('ack-one'), i), fact = decodeProviderFact(a.result_fact_json!);
  assert.equal(fact.status, 'qualifying'); assert.deepEqual(fact.target, providerTarget(i));
  assert.equal(fact.status === 'qualifying' && fact.witness.kind, 'provider_revocation_acknowledgment');
  assert.equal(f.source.providerCompletion(i.intent_id).status, 'qualifying');
  assert.equal(f.source.lifecycle.status(requestId, statusSecret).complete, false);
  assert.equal(f.db.prepare('SELECT 1 FROM account WHERE id=?').get(f.material.rowId) !== undefined, true);
  assert.deepEqual(f.db.prepare('SELECT * FROM account WHERE userId=?').all(B.authUserId), otherRows);
  const afterExport = JSON.stringify(buildAccountExport(f.db, B, actor => f.source.lifecycle.assertActive(actor), f.source.lifecycle.adapters));
  for (const secret of [f.material.token, f.material.immutableSubject, i.payload_digest, i.reference_version!]) assert.equal(afterExport.includes(secret), false);
  const restricted = JSON.stringify([f.intents(), f.db.prepare('SELECT * FROM account_provider_revocation_attempts').all()]);
  for (const secret of [f.material.token, 'synthetic-secret', f.material.immutableSubject, statusSecret]) assert.equal(restricted.includes(secret), false);
  assert.equal(beforeExport.includes(i.payload_digest), false); assert.equal(beforeExport.includes(i.reference_version!), false);
  for (const table of ['account_provider_revocation_intents', 'account_provider_revocation_attempts']) assert.throws(() => f.db.prepare(`DELETE FROM ${table}`).run());
  assert.throws(() => f.db.prepare('UPDATE account_provider_revocation_intents SET provider=?').run('google'));
  f.db.close(); const reopened = f.reopen(), source = f.compose(reopened);
  assert.deepEqual(reopened.prepare('SELECT * FROM account_provider_revocation_intents').get(), i);
  assert.deepEqual(await source.attemptOne(i.intent_id, 'ack-one'), ack); assert.equal(f.sends(), 1);
  await assert.rejects(source.attemptOne(i.intent_id, 'new-after-ack')); assert.equal(f.sends(), 1); integrity(reopened);
});

function pending<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const settled = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { settled, resolve, reject };
}

test('two actual connections serialize claims; duplicate stable ID replays and concurrent new ID cannot send', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent(), started = pending<void>(), response = pending<AppleResponse>();
  f.behavior.post = () => { started.resolve(); return { settled: response.settled, cancel: async () => {} }; };
  const running = f.source.attemptOne(i.intent_id, 'concurrent-one'); await started.settled;
  const second = f.compose(f.reopen());
  assert.equal((await second.attemptOne(i.intent_id, 'concurrent-one')).state, 'in_flight');
  await assert.rejects(second.attemptOne(i.intent_id, 'concurrent-two'));
  assert.throws(() => second.reconcileOne('concurrent-one')); assert.equal(f.sends(), 1);
  response.resolve({ status: 200, body: new Uint8Array(), truncated: false });
  assert.equal((await running).state, 'acknowledged'); assert.equal(f.sends(), 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM account_provider_revocation_attempts').get() !== undefined, true);
});

test('explicit new attempts retain unknown history, exact-target ACK resolves compatible uncertainty, stable replay never sends twice', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent();
  f.behavior.post = () => ({ settled: Promise.reject(new Error('synthetic transport secret must not escape')), cancel: async () => {} });
  assert.equal((await f.source.attemptOne(i.intent_id, 'retry-one')).state, 'unknown');
  const first = f.attempt('retry-one');
  assert.deepEqual(await f.source.attemptOne(i.intent_id, 'retry-one'), { attemptId: 'retry-one', intentId: i.intent_id,
    state: 'unknown', outcomeCode: 'transport_unknown', protocolStatus: null }); assert.equal(f.sends(), 1);
  f.behavior.post = () => done({ status: 503, body: Buffer.from('synthetic-private-response'), truncated: false });
  assert.equal((await f.source.attemptOne(i.intent_id, 'retry-two')).state, 'unknown');
  f.behavior.post = () => done({ status: 200, body: new Uint8Array(), truncated: false });
  assert.equal((await f.source.attemptOne(i.intent_id, 'retry-three')).state, 'acknowledged');
  const final = parseAttempt(f.attempt('retry-three'), i), fact = decodeProviderFact(final.result_fact_json!);
  assert.deepEqual(fact.resolves, ['retry-one', 'retry-two']); assert.equal(f.source.providerCompletion(i.intent_id).status, 'qualifying');
  assert.deepEqual(f.attempt('retry-one'), first);
  await assert.rejects(f.source.attemptOne(i.intent_id, 'retry-four')); assert.equal(f.sends(), 3);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM account_provider_revocation_attempts').all()).includes('synthetic-private-response'), false);
});

test('three unknown claims exhaust the bound without automatic or fourth dispatch', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent();
  f.behavior.post = () => done({ status: 400, body: new Uint8Array(), truncated: false });
  for (const id of ['limit-one', 'limit-two', 'limit-three']) assert.equal((await f.source.attemptOne(i.intent_id, id)).state, 'unknown');
  await assert.rejects(f.source.attemptOne(i.intent_id, 'limit-four')); assert.equal(f.sends(), 3);
  assert.equal(f.source.providerCompletion(i.intent_id).status, 'unknown');
});

for (const fault of ['missing', 'rotated', 'foreign-client', 'foreign-subject', 'rejected', 'cancelled'] as const)
  test(`resolver ${fault} cannot send and leaves exact guarded no-effect evidence`, async t => {
    const f = fixture(t); await f.confirm(); const i = f.intent();
    const controller = new AbortController();
    f.behavior.resolve = () => {
      if (fault === 'cancelled') { controller.abort(); return done({ status: 'unavailable' }); }
      if (fault === 'missing') return done({ status: 'unavailable' });
      if (fault === 'rejected') return { settled: Promise.reject(new Error('synthetic resolver failed')), cancel: async () => {} };
      if (fault === 'rotated') f.db.prepare('UPDATE account SET refreshToken=? WHERE id=?').run('synthetic-rotated', f.material.rowId);
      return done({ status: 'qualified', value: { material: { ...f.material,
        ...(fault === 'foreign-client' ? { clientBindingId: 'other-client' } : {}),
        ...(fault === 'foreign-subject' ? { immutableSubject: 'other-subject' } : {}) }, clientSecret: 'synthetic-secret' } });
    };
    const a = await f.source.attemptOne(i.intent_id, `resolve-${fault}`, controller.signal);
    assert.equal(a.state, 'no_effect'); assert.equal(f.sends(), 0); assert.deepEqual(f.intents(), [i]);
    assert.equal(f.source.providerCompletion(i.intent_id).status, 'unavailable');
  });

function crashClaim(f: ReturnType<typeof fixture>, attemptId: string, inFlight: boolean) {
  const i = f.intent(), port = bindSourceLifecycleCurrentness(f.db, f.source.witness, 'selected-provider-revocation-25', 'provider-revocation-v1');
  const snapshot = readSourceLifecycleCurrentness(port, requestId, intentCheckpoint(i));
  f.db.transaction(() => {
    f.db.prepare(`INSERT INTO account_provider_revocation_attempts(attempt_id,intent_id,ordinal,binding_json,binding_digest,state,revision,started_at_ms,deadline_at_ms)
      VALUES(?,?,1,?,?,'preparing',0,?,?)`).run(attemptId, i.intent_id, evidenceCanonical(snapshot.binding), evidenceDigest(snapshot.binding), f.now(), f.now() + 10000);
    if (inFlight) f.db.prepare("UPDATE account_provider_revocation_attempts SET state='in_flight',revision=1,dispatch_at_ms=? WHERE attempt_id=?").run(f.now(), attemptId);
  }).immediate();
}
for (const inFlight of [false, true]) test(`restart at committed ${inFlight ? 'dispatch gap' : 'preparing'} recovers only the named attempt without sending`, async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent(), id = inFlight ? 'crash-flight' : 'crash-prepare';
  crashClaim(f, id, inFlight); f.advance(10001); f.db.close(); const source = f.compose(f.reopen());
  const recovered = source.reconcileOne(id);
  assert.equal(recovered.state, inFlight ? 'unknown' : 'no_effect'); assert.equal(f.sends(), 0);
  assert.deepEqual(source.reconcileOne(id), recovered);
  assert.equal((await source.attemptOne(i.intent_id, 'explicit-after-crash')).state, 'acknowledged'); assert.equal(f.sends(), 1);
});

test('lost ACK transaction rolls back fact and stable-ID reconciliation reads before any deliberate retry', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent(), original = f.db.prepare.bind(f.db);
  let fail = true;
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (!sql.startsWith('UPDATE account_provider_revocation_attempts SET state=?,revision=?')) return statement;
    const run = statement.run.bind(statement);
    statement.run = ((...args: unknown[]) => { const effect = run(...args); if (fail) { fail = false; throw new Error('synthetic-ack-commit-failure'); } return effect; }) as typeof statement.run;
    return statement;
  }) as typeof f.db.prepare;
  const result = await f.source.attemptOne(i.intent_id, 'ack-commit-lost'); f.db.prepare = original;
  assert.equal(result.state, 'in_flight'); assert.equal(f.sends(), 1);
  assert.equal(parseAttempt(f.attempt('ack-commit-lost'), i).result_fact_json, null);
  assert.equal((await f.source.attemptOne(i.intent_id, 'ack-commit-lost')).state, 'in_flight'); assert.equal(f.sends(), 1);
  f.advance(10001); assert.equal(f.source.reconcileOne('ack-commit-lost').state, 'unknown');
  assert.equal((await f.source.attemptOne(i.intent_id, 'explicit-ack-retry')).state, 'acknowledged'); assert.equal(f.sends(), 2);
});

for (const fault of ['generation', 'proof', 'schema', 'history', 'subject', 'token', 'file', 'authority', 'pending-authority', 'checkpoint-head'] as const)
  test(`fresh post-await ${fault} denial never records a qualifying fact or changes original intent`, async t => {
    const f = fixture(t); await f.confirm(); const i = f.intent(), response = pending<AppleResponse>(), started = pending<void>();
    f.behavior.post = () => { started.resolve(); return { settled: response.settled, cancel: async () => {} }; };
    const running = f.source.attemptOne(i.intent_id, `late-${fault}`); await started.settled;
    if (fault === 'generation') f.writeGeneration('generation-two', 2);
    if (fault === 'proof') f.db.prepare('UPDATE account_deletion_requests SET intent_hash=? WHERE id=?').run('changed-proof', requestId);
    if (fault === 'schema') f.db.exec('DROP INDEX account_provider_revocation_attempts_deadline');
    if (fault === 'history') f.db.prepare('UPDATE form_migrations SET checksum=? WHERE version=25').run('a'.repeat(64));
    if (fault === 'subject') f.db.prepare('UPDATE account SET accountId=? WHERE id=?').run('different-subject', f.material.rowId);
    if (fault === 'token') f.db.prepare('UPDATE account SET refreshToken=? WHERE id=?').run('synthetic-rotated', f.material.rowId);
    if (fault === 'file') renameSync(f.db.name, join(f.root, 'moved-main.sqlite'));
    if (fault === 'authority') f.auth.current.close();
    if (fault === 'pending-authority' || fault === 'checkpoint-head') {
      const path = join(f.auth.directory, 'currentness.json'), witness = JSON.parse(readFileSync(path, 'utf8'));
      if (fault === 'checkpoint-head') witness.committedHeadDigest = 'f'.repeat(64);
      else witness.pending = { sequence: witness.committedSequence + 1, priorHeadDigest: witness.committedHeadDigest,
        nextHeadDigest: 'a'.repeat(64), recordDigest: 'b'.repeat(64), operationId: randomUUID() };
      writeFileSync(path, JSON.stringify(witness), { mode: 0o600 });
    }
    response.resolve({ status: 200, body: new Uint8Array(), truncated: false });
    let observed: Awaited<typeof running> | null = null;
    try { observed = await running; } catch (error) { assert.ok(error instanceof DomainError); }
    assert.notEqual(observed?.state, 'acknowledged'); assert.equal(f.sends(), 1);
    const row = f.attempt(`late-${fault}`) as { state: string; result_fact_json: string | null };
    assert.notEqual(row.state, 'acknowledged');
    if (row.result_fact_json) assert.notEqual(decodeProviderFact(row.result_fact_json).status, 'qualifying');
    assert.deepEqual(f.intents(), [i]);
  });

test('unrelated suppression advance validates saved prefix, constructs fresh ACK binding and leaves earlier uncertainty historical', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent();
  f.behavior.post = () => done({ status: 500, body: new Uint8Array(), truncated: false });
  await f.source.attemptOne(i.intent_id, 'older-uncertainty');
  f.behavior.post = () => {
    f.auth.current.recordDisable({ accountId: B.accountId, authUserId: B.authUserId, epoch: 1, requestId: randomUUID(), disabledAtMs: f.now() });
    return done({ status: 200, body: new Uint8Array(), truncated: false });
  };
  assert.equal((await f.source.attemptOne(i.intent_id, 'advanced-ack')).state, 'acknowledged');
  const a = parseAttempt(f.attempt('advanced-ack'), i), fact = decodeProviderFact(a.result_fact_json!);
  assert.equal(fact.binding.checkpoint.committedSequence, i.checkpoint_sequence + 1);
  assert.deepEqual(fact.resolves, []); assert.equal(f.source.providerCompletion(i.intent_id).status, 'qualifying');
});

test('restore before original request or intent cannot reconstruct from suppression; surviving old intent cannot rebind generation', async t => {
  const f = fixture(t), before = join(f.root, 'before-request.sqlite'); await backupAndVerify(f.db, before);
  await f.confirm(); const i = f.intent(), withIntent = join(f.root, 'with-intent.sqlite'); await backupAndVerify(f.db, withIntent);
  const restored = join(f.root, 'restored-before.sqlite'); copyFileSync(before, restored); chmodSync(restored, 0o600);
  f.writeGeneration('restored-generation', 2); const source = f.compose(f.reopen(restored));
  assert.throws(() => source.lifecycle.assertActive(A)); await assert.rejects(source.attemptOne(i.intent_id, 'restore-missing'));
  const survives = join(f.root, 'restored-with-intent.sqlite'); copyFileSync(withIntent, survives); chmodSync(survives, 0o600);
  const old = f.compose(f.reopen(survives)); await assert.rejects(old.attemptOne(i.intent_id, 'restore-old-generation'));
  assert.equal(f.sends(), 0); assert.deepEqual(f.intents(), [i]);
});

test('opaque source currentness rejects foreign handles, forged reader/port, wrong purpose and stale saved checkpoint', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent();
  assert.throws(() => new LifecycleEvidenceStore(f.db, f.source.witness, f.source.lifecycle.adapters));
  assert.throws(() => bindSourceLifecycleCurrentness(f.reopen(), f.source.witness, 'selected-provider-revocation-25', 'provider-revocation-v1'));
  assert.throws(() => bindSourceLifecycleCurrentness(f.db, {} as SourceLifecycleEvidenceWitnessReader, 'selected-provider-revocation-25', 'provider-revocation-v1'));
  assert.throws(() => bindSourceLifecycleCurrentness(f.db, f.source.witness, 'selected-lifecycle-evidence-24', 'provider-revocation-v1'));
  assert.throws(() => readSourceLifecycleCurrentness({} as ReturnType<typeof bindSourceLifecycleCurrentness>, requestId));
  const port = bindSourceLifecycleCurrentness(f.db, f.source.witness, 'selected-provider-revocation-25', 'provider-revocation-v1');
  for (const checkpoint of [{ ...intentCheckpoint(i), committedHeadDigest: 'f'.repeat(64) },
    { ...intentCheckpoint(i), authorityId: randomUUID() }, { ...intentCheckpoint(i), revision: i.checkpoint_revision + 100 }])
    assert.throws(() => readSourceLifecycleCurrentness(port, requestId, checkpoint));
});

test('strict fact/intent/attempt codecs reject extra fields, alternate target, wrong cohort, malformed digest and noncanonical replay', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent(); await f.source.attemptOne(i.intent_id, 'codec-ack');
  const a = parseAttempt(f.attempt('codec-ack'), i), fact = decodeProviderFact(a.result_fact_json!);
  assert.throws(() => parseIntent({ ...i, token: 'synthetic-no-copy' }));
  assert.throws(() => parseIntent({ ...i, proof_digest: 'f'.repeat(64) }));
  assert.throws(() => parseAttempt({ ...a, intent_id: 'other' }, i));
  assert.throws(() => parseAttempt({ ...a, binding_digest: 'a'.repeat(64) }, i));
  assert.throws(() => decodeProviderFact(' ' + a.result_fact_json));
  assert.throws(() => encodeProviderFact({ ...fact, token: 'synthetic-no-copy' }));
  assert.throws(() => encodeProviderFact({ ...fact, binding: { ...fact.binding, cohort: 'lifecycle-evidence-v1' } }));
  assert.throws(() => parseAttempt({ ...a, result_fact_json: encodeProviderFact({ ...fact, target: { ...providerTarget(i), subjectDigest: 'e'.repeat(64) } }) }, i));
  assert.throws(() => f.db.transaction(() => f.source.reconcileOne('codec-ack')).immediate());
});

for (const point of ['ledger:before-commit', 'ledger:after-commit']) test(`real independent ${point} fault never acknowledges the main intent or dispatches`, async t => {
  const f = fixture(t, observed => { if (observed === point) throw new Error('synthetic-suppression-fault'); });
  await assert.rejects(f.confirm()); assert.deepEqual(f.intents(), []); assert.equal(f.sends(), 0);
  assert.throws(() => f.auth.current.checkpoint()); assert.throws(() => f.source.lifecycle.assertActive(A));
  const raw: Sqlite = new Database(join(f.auth.directory, 'ledger.sqlite'), { readonly: true }); f.handles.add(raw);
  assert.deepEqual(raw.prepare('SELECT count(*) n FROM suppression_records').get(), { n: point === 'ledger:before-commit' ? 0 : 1 });
  assert.equal((f.db.prepare('SELECT verified_at_ms FROM account_deletion_requests WHERE id=?').get(requestId) as { verified_at_ms: number | null }).verified_at_ms, null);
});

test('unsupported provider creates an unavailable retained intent while local purge proceeds', async t => {
  const f = fixture(t);
  f.db.prepare(`INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('unsupported-row','synthetic-other-subject','other-provider',?,1,1)`).run(A.authUserId);
  await f.confirm();
  const unsupported = f.intents().find(i => i.source_account_row_id === 'unsupported-row')!;
  assert.equal(unsupported.residual_code, 'unsupported_provider'); assert.equal(unsupported.token_kind, null);
  await assert.rejects(f.source.attemptOne(unsupported.intent_id, 'unsupported-attempt')); assert.equal(f.sends(), 0);
  f.source.lifecycle.purgeLocal(issueLocalPurgeAuthority(f.source.lifecycle, { requestId, operationId: 'unsupported-local-purge' }));
  assert.equal(f.source.localCompletion(requestId)!.localPurged, true); assert.equal(f.intents().length, 2);
});

test('total deadline covers resolution and transport, and expiry never acknowledges a late empty200', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent();
  f.behavior.resolve = () => { f.advance(10001); return done({ status: 'qualified', value: { material: f.material, clientSecret: 'synthetic' } }); };
  assert.equal((await f.source.attemptOne(i.intent_id, 'resolution-expired')).state, 'no_effect'); assert.equal(f.sends(), 0);
  f.behavior.resolve = () => done({ status: 'qualified', value: { material: f.material, clientSecret: 'synthetic' } });
  f.behavior.post = () => { f.advance(10001); return done({ status: 200, body: new Uint8Array(), truncated: false }); };
  assert.equal((await f.source.attemptOne(i.intent_id, 'http-expired')).state, 'unknown'); assert.equal(f.sends(), 1);
});

test('caller cancellation retains active claim until HTTP producer and cleanup settle, preventing overlapping retry', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent(), started = pending<void>(), response = pending<AppleResponse>(), cleanup = pending<void>();
  const controller = new AbortController(); let cancellations = 0, returned = false;
  f.behavior.post = () => { started.resolve(); return { settled: response.settled, cancel: async () => { cancellations++; await cleanup.settled; } }; };
  const running = f.source.attemptOne(i.intent_id, 'cancel-active', controller.signal).then(value => { returned = true; return value; });
  await started.settled; controller.abort(); await Promise.resolve();
  assert.equal(cancellations, 1); assert.equal(returned, false);
  f.advance(10001); assert.throws(() => f.source.reconcileOne('cancel-active'));
  await assert.rejects(f.source.attemptOne(i.intent_id, 'no-overlap')); assert.equal(f.sends(), 1);
  response.resolve({ status: 200, body: new Uint8Array(), truncated: false }); await Promise.resolve(); assert.equal(returned, false);
  cleanup.resolve(); assert.equal((await running).state, 'unknown');
  f.behavior.post = () => done({ status: 200, body: new Uint8Array(), truncated: false });
  assert.equal((await f.source.attemptOne(i.intent_id, 'explicit-after-cancel')).state, 'acknowledged'); assert.equal(f.sends(), 2);
});

test('lost response after ACK commit reads back the terminal fact and never resends on replay', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent(), original = f.db.transaction.bind(f.db); let lost = false;
  f.db.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const transaction = original(fn), immediate = transaction.immediate.bind(transaction);
    transaction.immediate = ((...args: unknown[]) => {
      const value = immediate(...args);
      if (!lost && (value as { state?: string } | undefined)?.state === 'acknowledged') { lost = true; throw new Error('synthetic-post-commit-response-loss'); }
      return value;
    }) as typeof transaction.immediate;
    return transaction;
  }) as typeof f.db.transaction;
  const result = await f.source.attemptOne(i.intent_id, 'ack-response-lost'); f.db.transaction = original;
  assert.equal(lost, true); assert.equal(result.state, 'acknowledged'); assert.equal(f.sends(), 1);
  assert.equal(parseAttempt(f.attempt('ack-response-lost'), i).state, 'acknowledged');
  assert.deepEqual(await f.source.attemptOne(i.intent_id, 'ack-response-lost'), result); assert.equal(f.sends(), 1);
});

test('real competing terminal CAS during transport wins without a second fact or fabricated ACK', async t => {
  const f = fixture(t); await f.confirm(); const i = f.intent();
  f.behavior.post = () => {
    const other = f.reopen(), a = parseAttempt(other.prepare('SELECT * FROM account_provider_revocation_attempts WHERE attempt_id=?').get('cas-one'), i);
    const encoded = encodeProviderFact({ operationId: a.attempt_id, binding: JSON.parse(a.binding_json), target: providerTarget(i),
      resolves: [], status: 'unknown', witness: null });
    const changed = other.prepare(`UPDATE account_provider_revocation_attempts SET state='unknown',revision=2,finished_at_ms=?,outcome_code='transport_unknown',result_fact_json=?
      WHERE attempt_id=? AND intent_id=? AND state='in_flight' AND revision=1 AND binding_digest=?`)
      .run(f.now(), encoded, a.attempt_id, i.intent_id, a.binding_digest);
    assert.equal(changed.changes, 1);
    return done({ status: 200, body: new Uint8Array(), truncated: false });
  };
  assert.equal((await f.source.attemptOne(i.intent_id, 'cas-one')).state, 'unknown'); assert.equal(f.sends(), 1);
  const a = parseAttempt(f.attempt('cas-one'), i); assert.equal(decodeProviderFact(a.result_fact_json!).status, 'unknown');
  assert.equal(f.source.providerCompletion(i.intent_id).status, 'unknown');
});
