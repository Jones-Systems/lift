import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DomainError } from '../../src/errors.js';
import type { FormServer } from '../../src/server.js';
import { lifecyclePolicy } from '../../src/lifecycle/service.js';
import { issueLocalPurgeAuthority } from '../../src/lifecycle/purge-executor.js';
import { prepareRelocatedAdmission, RuntimeOwner, type PrepareRelocatedAdmissionInput } from '../../src/runtime-modules/admission.js';
import { operateClosedStorage } from '../../src/runtime-modules/storage-operations.js';
import { canonicalPath, fileDigest } from '../../src/runtime-modules/files.js';
import { migrationDigests } from '../../src/runtime-modules/migrations.js';
import { backupAndVerify, integrity } from '../../src/storage.js';
import { feedbackOwnedTables } from '../../src/training-feedback/migration.js';
import { progressComparisonOwnedTables } from '../../src/progress-comparison/migration.js';
import { manualRetentionOwnedTables } from '../../src/body/manual-retention-migration.js';
import { provision, login, request, password, readAdmission, type User, type Deployment } from './fixture.js';
import { usefulActivity } from './http-fixture.js';
import { populateCommunity } from './community-fixture.js';
import { drillEmails, withRestoreDrill } from './restore-drill-fixture.js';

const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const residuals = {
  activity: 'complete', auth_identity: 'retained', backups: 'pending', bugIntake: 'complete',
  community: 'pending', form_training_history: 'complete', phone_challenges: 'complete',
  providers: 'pending', purchase_proofs: 'retained', usage_limits: 'complete',
};
const absentPaths = {
  providerCallback: 'path_absent_in_composition',
  wearableImport: 'path_absent_in_composition',
  familyContribution: 'path_absent_in_composition',
};

async function initiate(server: FormServer, user: User) {
  const intent = { requestId: randomUUID(), statusSecret: randomBytes(32).toString('base64url'),
    policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' as const };
  const response = await request(server, '/v1/me/deletion-requests', user, 'POST', intent, randomUUID());
  assert.equal(response.status, 201, await response.clone().text());
  return intent;
}
async function confirm(server: FormServer, user: User, requestId: string) {
  const response = await request(server, '/v1/me/account-action-grants', user, 'POST', { purpose: 'account_delete', password });
  assert.equal(response.status, 201, await response.clone().text());
  const { grant } = await response.json() as { grant: string };
  const confirmed = await request(server, `/v1/me/deletion-requests/${requestId}/confirm`, user, 'POST',
    { grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
}
function purge(server: FormServer, requestId: string) {
  assert.ok(server.lifecycle);
  const authority = issueLocalPurgeAuthority(server.lifecycle, { requestId, operationId: randomUUID() });
  const result = server.lifecycle.purgeLocal(authority);
  assert.equal(result.phase, 'pending_external'); assert.equal(result.complete, false);
  assert.equal(result.backupExpiryAt, null); assert.equal(result.billingCancellation, 'not_performed');
  assert.equal(result.localPurged, false);
  assert.throws(() => server.lifecycle!.purgeLocal(authority), code('purge_authority_invalid'));
  return Object.fromEntries(result.steps.map(step => [step.category, step.status]));
}
function relocation(d: Deployment, backupPath: string): PrepareRelocatedAdmissionInput {
  const prior = readAdmission(d);
  return { configuration: d.configuration, mainPath: d.path, expectedMain: canonicalPath(d.path, d.configuration.ownerUid),
    expectedRevision: prior.revision as number, expectedGeneration: prior.databaseGeneration as number,
    expectedPredecessorDigest: prior.closedDigest as string, backupPath,
    expectedBackupDigest: fileDigest(backupPath, d.configuration.ownerUid),
    destination: join(d.root, `restore-${randomUUID()}.sqlite`), operationId: randomUUID(),
    provenance: 'synthetic closed runtime snapshot', oldWriterStopped: true };
}
async function exportAccount(server: FormServer, user: User) {
  const grantResponse = await request(server, '/v1/me/account-action-grants', user, 'POST', { purpose: 'account_export', password });
  assert.equal(grantResponse.status, 201, await grantResponse.clone().text());
  const { grant } = await grantResponse.json() as { grant: string };
  const exported = await request(server, '/v1/me/account-export', user, 'POST', { grant });
  assert.equal(exported.status, 200, await exported.clone().text());
  return await exported.json() as { manifest: { complete: boolean; scope: { accountId: string };
    categories: { category: string; status: string }[]; omissions: { category: string; reason: string }[];
    residuals: { category: string; status: string; reason: string }[] } };
}
async function plan(server: FormServer, user: User, name: string) {
  const response = await request(server, '/v1/plans', user, 'POST', { name, minutes: 15,
    items: [{ id: 'row', exerciseId: 'goblet-squat', setTarget: 1, repMin: 8, repMax: 12, targetKg: 10 }] }, randomUUID());
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json() as { id: string; revision: number };
}

test('Tier R16 joined restore keeps later disablements, holds missing intent and executes retained intent with exact residuals', async t => {
  await withRestoreDrill(t, async f => {
    await provision(f.d);
    const first = await f.runtime();
    const a = await login(first.server, drillEmails[0], true), b = await login(first.server, drillEmails[1], true),
      c = await login(first.server, drillEmails[2], true);
    for (const user of [a, b, c]) {
      const profile = await (await request(first.server, '/v1/me/profile', user)).json() as { revision: number };
      assert.equal((await request(first.server, '/v1/me/profile', user, 'PATCH', { expectedRevision: profile.revision, age: 30 })).status, 200);
    }
    const aPlan = await plan(first.server, a, 'A before snapshot'), bPlan = await plan(first.server, b, 'B before snapshot');
    await usefulActivity(first.server, a); await usefulActivity(first.server, c);
    const community = await populateCommunity(first.server, a, b);
    const cIntent = await initiate(first.server, c);
    await first.server.close();
    mkdirSync(join(f.d.root, 'drill-test-backups'), { mode: 0o700 });
    const backupPath = join(f.d.root, 'drill-test-backups', 'before-disable.sqlite');
    const snapshotAt = Date.now();
    const manifest = await operateClosedStorage({ configuration: f.d.configuration, mainPath: f.d.path,
      expectedClosedDigest: fileDigest(f.d.path, f.d.configuration.ownerUid), action: 'backup', destination: backupPath });
    assert.deepEqual(manifest.migrationDigests, migrationDigests);
    assert.equal(manifest.encryption, 'none_held'); assert.equal(manifest.offhost, 'none_held');
    assert.equal(manifest.suppressionSequence, 0);
    const current = await f.runtime();
    const aIntent = await initiate(current.server, a);
    await confirm(current.server, a, aIntent.requestId); await confirm(current.server, c, cIntent.requestId);
    const newerAt = Date.now(), newer = await plan(current.server, b, 'B after snapshot');
    assert.deepEqual(purge(current.server, aIntent.requestId), residuals);
    assert.deepEqual(purge(current.server, cIntent.requestId), residuals);
    assert.equal((await request(current.server, `/v1/plans/${bPlan.id}`, b)).status, 200);
    const checkpoint = current.owner.ledger.checkpoint();
    assert.equal(checkpoint.committedSequence, 2);
    await current.server.close();
    const input = relocation(f.d, backupPath), source = readFileSync(f.d.path);
    const declaredLoss = performance.now();
    const prepared = prepareRelocatedAdmission(input);
    assert.equal(prepared.suppressionSequence, checkpoint.committedSequence);
    assert.equal(prepared.suppressionHead, checkpoint.committedHeadDigest);
    assert.deepEqual(readFileSync(input.mainPath), source);
    assert.deepEqual(canonicalPath(input.mainPath, f.d.configuration.ownerUid), input.expectedMain);
    f.d.path = input.destination;
    const restored = await f.runtime(), elapsedMs = performance.now() - declaredLoss;
    assert.equal(restored.owner.fullBarrier, true); assert.equal(readAdmission(f.d).state, 'running');
    const db = restored.server.db;
    assert.equal((db.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(community.board.id) as { visibility: string }).visibility, 'hidden');
    assert.equal((db.prepare('SELECT count(*) n FROM community_board_votes WHERE active=1').get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) n FROM community_posts WHERE state<>'hidden' OR text IS NOT NULL").get() as { n: number }).n, 0);
    for (const table of ['session', 'account_action_grants', 'verification', 'community_profile_shares', 'community_ballots'])
      assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0, table);
    for (const user of [a, b, c]) assert.equal((await request(restored.server, '/v1/me', user)).status, 401);
    for (const path of ['/v1/me/account-export', `/v1/plans/${aPlan.id}`]) {
      const response = await request(restored.server, path, a, path.endsWith('account-export') ? 'POST' : 'GET',
        path.endsWith('account-export') ? { grant: 's'.repeat(43) } : undefined);
      assert.equal(response.status, 401);
    }
    await assert.rejects(() => login(restored.server, drillEmails[0]));
    assert.equal((db.prepare('SELECT state FROM account_lifecycle WHERE account_id=?').get(a.actor.accountId) as { state: string }).state, 'disabled');
    assert.ok(db.prepare('SELECT id FROM plans WHERE account_id=? AND id=?').get(a.actor.accountId, aPlan.id));
    assert.equal(db.prepare('SELECT id FROM account_deletion_requests WHERE id=?').get(aIntent.requestId), undefined);
    assert.throws(() => issueLocalPurgeAuthority(restored.server.lifecycle!, { requestId: aIntent.requestId, operationId: randomUUID() }),
      code('deletion_request_absent_restore_held'));
    assert.throws(() => restored.server.lifecycle!.status(aIntent.requestId, aIntent.statusSecret), code('status_receipt_invalid'));
    assert.deepEqual(purge(restored.server, cIntent.requestId), residuals);
    const freshB = await login(restored.server, drillEmails[1]);
    assert.equal((await request(restored.server, `/v1/plans/${bPlan.id}`, freshB)).status, 200);
    assert.equal((await request(restored.server, `/v1/plans/${newer.id}`, freshB)).status, 404);
    const exported = await exportAccount(restored.server, freshB);
    assert.equal(exported.manifest.complete, false); assert.equal(exported.manifest.scope.accountId, b.actor.accountId);
    for (const missing of ['body', 'phone', 'privacyChoices'])
      assert.equal(exported.manifest.categories.find(entry => entry.category === missing)?.status, 'unavailable');
    assert.deepEqual(exported.manifest.residuals, [
      { category: 'purchaseRawProofs', status: 'retained', reason: 'immutable_evidence_not_in_export' },
      { category: 'unboundPhoneChallenges', status: 'unavailable', reason: 'exact_subject_attribution_requires_qualified_phone_adapter' },
      { category: 'backupsAndExternalProviders', status: 'unavailable', reason: 'no_qualified_snapshot_or_retention_adapter' },
      { category: 'deviceCopies', status: 'unavailable', reason: 'outside_server_snapshot' },
    ]);
    assert.equal(JSON.stringify(exported).includes('A before snapshot'), false);
    assert.equal(JSON.stringify(exported).includes('B before snapshot'), true);
    const settings = await (await request(restored.server, '/v1/me/settings', freshB)).json() as {
      runtimeModules: { accountDeletion: { purge: boolean; complete: boolean } };
    };
    assert.deepEqual(settings.runtimeModules.accountDeletion, { supported: false, purge: false, complete: false });
    integrity(db); assert.deepEqual(readFileSync(input.mainPath), source);
    t.diagnostic(JSON.stringify({ tier: 'R16', scope: 'disposable_synthetic_backend', elapsedRecoveryMs: elapsedMs,
      observedWriteLossWindowMs: newerAt - snapshotAt, lostWrite: newer.id, restoredIntent: cIntent.requestId,
      missingIntent: 'purge_authority_missing_after_restore', residuals, absentPaths,
      keyCases: 'missing_or_corrupt_key_held_no_encryption_binding', operationalRpoRto: 'not_accepted_or_claimed' }));
  });
});

for (const faultKind of ['interrupted', 'moving-authority'] as const)
  test(`Tier R16 ${faultKind} barrier cannot serve or publish running admission`, async t => {
    await withRestoreDrill(t, async f => {
      await provision(f.d);
      const initial = await f.runtime(), a = await login(initial.server, drillEmails[0], true);
      await initial.server.close();
      mkdirSync(join(f.d.root, 'drill-test-backups'), { mode: 0o700 });
      const backup = join(f.d.root, 'drill-test-backups', 'fault.sqlite');
      await operateClosedStorage({ configuration: f.d.configuration, mainPath: f.d.path,
        expectedClosedDigest: fileDigest(f.d.path, f.d.configuration.ownerUid), action: 'backup', destination: backup });
      const input = relocation(f.d, backup), preserved = readFileSync(f.d.path);
      prepareRelocatedAdmission(input); f.d.path = input.destination;
      let reached = false;
      await assert.rejects(() => f.runtime((point, owner) => {
        if (point !== 'barrier:canonical') return;
        reached = true;
        if (faultKind === 'interrupted') throw new Error('synthetic drill interrupted replay');
        owner.ledger.recordDisable({ accountId: a.actor.accountId, authUserId: a.actor.authUserId,
          epoch: 1, requestId: randomUUID(), disabledAtMs: Date.now() });
      }), faultKind === 'interrupted' ? /synthetic drill interrupted replay/ : /Authority changed across barrier/);
      assert.equal(reached, true); assert.equal(readAdmission(f.d).state, 'opening');
      assert.deepEqual(readFileSync(input.mainPath), preserved);
      assert.throws(() => new RuntimeOwner(f.d.configuration, f.d.path));
      const candidate = new Database(f.d.path, { readonly: true });
      try {
        assert.equal((candidate.prepare('SELECT state FROM account_lifecycle WHERE account_id=?').get(a.actor.accountId) as { state: string }).state, 'active');
        assert.ok(candidate.prepare('SELECT id FROM session WHERE id=?').get(a.actor.sessionId));
      } finally { candidate.close(); }
      t.diagnostic(JSON.stringify({ fault: faultKind, admission: 'opening_held', listenerOpened: false,
        retry: 'requires_exact_offline_recovery_and_new_attempt_no_blind_restart' }));
    });
  });

test('Tier S23 qualifies source adapters and rejects its genuine backup at the runtime16 boundary', async t => {
  await withRestoreDrill(t, async f => {
    await provision(f.d);
    const runtime = await f.runtime(); await runtime.server.close();
    const source = await f.source23(), a = await login(source, drillEmails[0], true), b = await login(source, drillEmails[1], true);
    const versions = source.db.prepare('SELECT version FROM form_migrations ORDER BY version').all() as { version: number }[];
    assert.deepEqual(versions.map(row => row.version), Array.from({ length: 23 }, (_, i) => i + 1));
    const sourceTables = [...feedbackOwnedTables, ...progressComparisonOwnedTables,
      'body_manual_measurements', 'body_manual_receipts', ...manualRetentionOwnedTables];
    // Historical synthetic rows exercise owned deletion without granting a new
    // retention decision or pretending these source modules are runtime-admitted.
    for (const user of [a, b]) {
      const id = user.actor.accountId, now = new Date().toISOString(), measurementId = randomUUID(), decisionId = randomUUID();
      source.db.prepare('INSERT INTO feedback_state VALUES(?,1,1)').run(id);
      source.db.prepare('INSERT INTO feedback_events VALUES(?,1,?,?)').run(id, 'synthetic-event', '{}');
      source.db.prepare('INSERT INTO feedback_receipts VALUES(?,?,?,?)').run(id, 'synthetic-event', 'synthetic-digest', '{}');
      source.db.prepare('INSERT INTO feedback_keys VALUES(?,?,?)').run(id, 'synthetic-key', 'synthetic-event');
      source.db.prepare('INSERT INTO feedback_projections VALUES(?,?)').run(id, '{}');
      source.db.prepare('INSERT INTO feedback_dependencies VALUES(?,?,?,?)').run(id, 'synthetic-record', 'plan', 'synthetic-plan');
      source.db.prepare('INSERT INTO progress_comparison_identities VALUES(?,?,?,?,?,1,1,?,NULL,?)')
        .run(id, 'synthetic-identity', 'session', 'synthetic-session', 'synthetic-item', 'withdrawn', now);
      source.db.prepare('INSERT INTO progress_comparison_identity_revisions VALUES(?,?,1,1,?,?)')
        .run(id, 'synthetic-identity', 'withdraw', now);
      source.db.prepare('INSERT INTO body_manual_measurements VALUES(?,?,?,?,?,?,?,?,?)')
        .run(measurementId, id, 'waist', 80, 'cm', 'cm', '2026-10-01', null, now);
      source.db.prepare('INSERT INTO body_manual_receipts VALUES(?,?,?,?,?)')
        .run(id, 'synthetic-measurement', 'synthetic-intent', measurementId, 'create');
      source.db.prepare("INSERT INTO body_manual_retention_decisions VALUES(?,?,?,?,0,'granted',1,?,?,?,?)")
        .run(id, decisionId, user.actor.authUserId, user.actor.sessionId, 'a'.repeat(64), 'synthetic-grant', now, now);
      source.db.prepare('INSERT INTO body_manual_retention_receipts VALUES(?,?,?,?,?,?)')
        .run(id, 'synthetic-grant', 'synthetic-intent', decisionId, '{}', now);
      source.db.prepare('INSERT INTO body_manual_retention_attributions VALUES(?,?,?,?,1,?,?)')
        .run(id, 'synthetic-measurement', measurementId, decisionId, 'a'.repeat(64), now);
    }
    const otherRows = sourceTables.map(table => source.db.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY rowid`).all(b.actor.accountId));
    const backup = join(f.d.root, 'source23-backup.sqlite');
    await backupAndVerify(source.db, backup);
    const intent = await initiate(source, a); await confirm(source, a, intent.requestId);
    // Body suppression erases its owned rows immediately; Training retains
    // suppressed history until the exact executor enters its purge subframes.
    assert.ok(source.db.prepare('SELECT account_id FROM feedback_state WHERE account_id=?').get(a.actor.accountId));
    const states = purge(source, intent.requestId);
    for (const category of ['body', 'trainingFeedback', 'progressComparison']) assert.equal(states[category], 'complete');
    for (const [index, table] of sourceTables.entries()) {
      assert.deepEqual(source.db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(a.actor.accountId), [], table);
      assert.deepEqual(source.db.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY rowid`).all(b.actor.accountId), otherRows[index], table);
    }
    integrity(source.db); await source.close();
    const input = relocation(f.d, backup), original = readFileSync(f.d.path),
      admissionPath = join(f.d.configuration.authorityDirectory, 'admission.json'), admission = readFileSync(admissionPath);
    assert.throws(() => prepareRelocatedAdmission(input), /Relocation runtime migration mismatch/);
    assert.deepEqual(readFileSync(f.d.path), original); assert.deepEqual(readFileSync(admissionPath), admission);
    assert.deepEqual(canonicalPath(f.d.path, f.d.configuration.ownerUid), input.expectedMain);
    t.diagnostic(JSON.stringify({ tier: 'S23', qualification: 'source-qualified_not_runtime-admitted',
      categories: ['body', 'trainingFeedback', 'progressComparison'], runtime16Adoption: 'rejected', complete: false, absentPaths }));
  });
});
