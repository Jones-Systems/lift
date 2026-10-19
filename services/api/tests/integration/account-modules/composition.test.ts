import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSourceAccountModules, selectAccountModuleMigrations, createSourceTrainingLifecycleAdapters,
  sourceProgressComparisonMigration, sourceFeedbackMigration } from '../../../src/integration/account-modules/index.js';
import { createCanonicalAccountWriter } from '../../../src/integration/account-modules/canonical-writer.js';
import { Domain } from '../../../src/domain.js';
import { progressComparisonMigrationSql } from '../../../src/progress-comparison/migration.js';
import { feedbackMigrationSql } from '../../../src/training-feedback/migration.js';
import { AccountLifecycle, lifecyclePolicy } from '../../../src/lifecycle/service.js';
import { runtimeMigrations } from '../../../src/runtime-modules/migrations.js';
import { usageMigrationSql, usageOwnedTables } from '../../../src/usage-limits/index.js';
import { bugIntakeMigrationSql, bugIntakeOwnedTables } from '../../../src/bug-intake/index.js';
import { communityRemovalSnapshotsMigrationSql } from '../../../src/community/removal-snapshots.js';
import { featureBoardCorrectionMigrationVersion, featureBoardCorrectionMigrationSql } from '../../../src/community/board/correction-migration.js';
import { sourcePrescriptionMigration } from '../../../src/source-prescription-migration.js';
import { hash } from '../../../src/storage.js';
import { baseMigrations, selectedMigrations, selector, fixture, reportInput } from './fixture.js';

test('selected source migrations require genuine current 1–16 without duplicating usage14 or bug15', () => {
  assert.deepEqual(selectedMigrations.map(value => value.version), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.deepEqual(selectedMigrations.map(value => hash(value.sql)), runtimeMigrations.map(value => hash(value.sql)));
  assert.equal(runtimeMigrations.length, 16);
  assert.equal(selectedMigrations[13]!.sql, usageMigrationSql); assert.equal(selectedMigrations[14]!.sql, bugIntakeMigrationSql);
  assert.equal(selectedMigrations[15]!.sql, communityRemovalSnapshotsMigrationSql);
  for (const length of [11, 13, 15])
    assert.throws(() => selectAccountModuleMigrations(selector, baseMigrations.slice(0, length)), { code: 'account_modules_migration_prerequisites_required' });
  for (const version of [12, 16])
    assert.throws(() => selectAccountModuleMigrations(selector, baseMigrations.map(value => value.version === version ? { ...value, sql: 'SELECT 1;' } : value)), { code: 'account_modules_migration_prerequisites_required' });
  assert.throws(() => selectAccountModuleMigrations({ ...selector, mode: 'runtime' } as unknown as typeof selector, baseMigrations), { code: 'account_modules_configuration_invalid' });
});

test('explicit TRAIN selector appends authentic 17 and 18 while legacy and runtime retain exact 16', () => {
  const selected = selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-and-training-feedback' }, baseMigrations);
  assert.equal(selected.length, 18); assert.deepEqual(selected.slice(0, 16), selectedMigrations);
  assert.deepEqual(selected.slice(0, 16).map(entry => hash(entry.sql)), runtimeMigrations.map(entry => hash(entry.sql)));
  assert.deepEqual(selected.slice(16), [sourceProgressComparisonMigration, sourceFeedbackMigration]);
  assert.deepEqual(selected.slice(16).map(entry => entry.sql), [progressComparisonMigrationSql, feedbackMigrationSql]);
  assert.equal(runtimeMigrations.length, 16);
  assert.throws(() => selectAccountModuleMigrations(selector, selected), { code: 'account_modules_migration_prerequisites_required' });
  assert.throws(() => selectAccountModuleMigrations({ ...selector, modules: 'training' } as unknown as typeof selector, baseMigrations),
    { code: 'account_modules_configuration_invalid' });
});

test('TRAIN lifecycle inventory requires both complete schemas and original canonical adapters without purge authority', t => {
  const f = fixture(); t.after(f.close);
  const domain = new Domain(f.db), writer = createCanonicalAccountWriter(f.db), baseline = [...f.existing.adapters, ...f.modules.adapters];
  f.db.exec(progressComparisonMigrationSql);
  assert.throws(() => createSourceTrainingLifecycleAdapters(f.db, domain, writer), { code: 'training_feedback_schema_unavailable' });
  assert.throws(() => new AccountLifecycle(f.db, baseline, f.ledger), { code: 'lifecycle_adapter_required' });
  f.db.exec(feedbackMigrationSql);
  const adapters = createSourceTrainingLifecycleAdapters(f.db, domain, writer), all = [...baseline, ...adapters];
  assert.deepEqual(adapters.map(adapter => adapter.category), ['progressComparison', 'trainingFeedback']);
  for (const missing of adapters) assert.throws(() => new AccountLifecycle(f.db, all.filter(adapter => adapter !== missing), f.ledger),
    { code: 'lifecycle_adapter_required' });
  assert.throws(() => new AccountLifecycle(f.db, [...all, adapters[0]!], f.ledger), /Duplicate lifecycle category/);
  const lifecycle = new AccountLifecycle(f.db, all, f.ledger);
  for (const adapter of adapters) {
    assert.equal(adapter.inventory(f.one).status, 'complete');
    assert.throws(() => adapter.inventory({ ...f.one, sessionId: f.two.sessionId }), { code: 'account_session_invalid' });
    assert.throws(() => adapter.suppress(f.one.accountId, 1), { code: 'canonical_writer_unproved' });
    assert.equal(adapter.purge('unqualified', f.one.accountId).status, 'unavailable');
  }
  const deletion = lifecycle.initiate(f.one, 'training-delete', { requestId: randomUUID(), policyVersion: lifecyclePolicy,
    confirmation: 'delete_whole_account', statusSecret: 'b'.repeat(43) });
  assert.ok(deletion.steps.some(step => step.category === 'progressComparison'));
  assert.ok(deletion.steps.some(step => step.category === 'trainingFeedback'));
  const record = f.ledger.recordDisable({ accountId: f.one.accountId, authUserId: f.one.authUserId, epoch: 1, requestId: deletion.requestId, disabledAtMs: 1 });
  f.db.transaction(() => {
    f.db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=1,disabled_at_ms=1,suppression_seq=? WHERE account_id=?").run(record.sequence, f.one.accountId);
    for (const adapter of adapters) assert.equal(adapter.suppress(f.one.accountId, 1).status, 'complete');
  }).immediate();
});

test('explicit correction20 selection preserves genuine 16 18 and 19 checksum prefixes without changing runtime', () => {
  const previous = selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-training-feedback-and-source-prescription' }, baseMigrations);
  const current = selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, baseMigrations);
  assert.equal(previous.length, 19); assert.deepEqual(previous.slice(16), [sourceProgressComparisonMigration, sourceFeedbackMigration, sourcePrescriptionMigration]);
  assert.equal(current.length, 20); assert.deepEqual(current.slice(0, 19), previous);
  assert.deepEqual(current.slice(0, 19).map(entry => hash(entry.sql)), previous.map(entry => hash(entry.sql)));
  assert.deepEqual(current[19], { version: featureBoardCorrectionMigrationVersion, sql: featureBoardCorrectionMigrationSql });
  assert.equal(featureBoardCorrectionMigrationVersion, 20);
  assert.deepEqual(current.map(entry => entry.version), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(Object.isFrozen(current), true); assert.ok(current.every(Object.isFrozen));
  assert.deepEqual(current.slice(0, 16), selectedMigrations); assert.equal(runtimeMigrations.length, 16);
  assert.equal(selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-and-training-feedback' }, baseMigrations).length, 18);
  assert.throws(() => selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, previous),
    { code: 'account_modules_migration_prerequisites_required' });
});

test('composition returns one paired ledger and immutable account services while admission and external authority stay unavailable', t => {
  const f = fixture(); t.after(f.close);
  assert.equal(createSourceAccountModules(f.db, f.bindings), f.modules);
  assert.throws(() => createSourceAccountModules(f.db, { ...f.bindings }), { code: 'account_modules_already_bound' });
  assert.equal(f.modules.usage.status(f.one).configured, false);
  assert.throws(() => f.modules.usage.reserve(f.one, { operation: 'standard', idempotencyKey: 'synthetic-admission', intentHash: 'a'.repeat(64),
    subjectId: 'synthetic', charges: [{ metric: 'coach_messages', amount: 1 }], dispatchStages: ['dispatch'] }), { code: 'usage_unconfigured' });
  const mutable = { ...f.one }, service = f.modules.bugFor(mutable);
  Object.assign(mutable, f.two);
  const submitted = service.submit(reportInput, 'synthetic-key');
  assert.equal(f.modules.bugFor(f.one).get(submitted.report.id).id, submitted.report.id);
  assert.throws(() => f.modules.bugFor(f.two).get(submitted.report.id), { code: 'bug_report_not_found' });
  assert.equal(service.triage(submitted.report.id).status, 'unavailable');
  assert.throws(() => service.prepare(submitted.report.id), { code: 'bug_intake_authority_unavailable' });
  for (const table of usageOwnedTables) assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
  assert.deepEqual(f.db.prepare('SELECT state,binding,dispatch_receipt FROM bug_intake_reports').all(), [{ state: 'received', binding: null, dispatch_receipt: null }]);
});

test('stored usage and bug tables require their registered adapters and retain duplicate rejection and deletion category union', t => {
  const f = fixture(); t.after(f.close);
  const all = [...f.existing.adapters, ...f.modules.adapters];
  for (const missing of ['usage_limits', 'bugIntake'])
    assert.throws(() => new AccountLifecycle(f.db, all.filter(adapter => adapter.category !== missing), f.ledger), { code: 'lifecycle_adapter_required' });
  assert.throws(() => new AccountLifecycle(f.db, [...all, f.modules.adapters[0]!], f.ledger), /Duplicate lifecycle category/);
  const lifecycle = new AccountLifecycle(f.db, all, f.ledger);
  const result = lifecycle.initiate(f.one, 'synthetic-delete', { requestId: randomUUID(), policyVersion: lifecyclePolicy,
    confirmation: 'delete_whole_account', statusSecret: 'a'.repeat(43) });
  for (const category of ['form_training_history', 'providers', 'activity', 'community', 'usage_limits', 'bugIntake'])
    assert.equal(result.steps.filter(step => step.category === category).length, 1);
});

test('suppression requires same-database canonical ledger and row proof; unavailable purge never removes module rows', t => {
  const f = fixture(); t.after(f.close);
  f.modules.bugFor(f.one).submit(reportInput, 'synthetic-key');
  f.db.prepare('INSERT INTO usage_accounts VALUES(?,?)').run(f.one.accountId, 'synthetic-policy');
  const before = [...usageOwnedTables, ...bugIntakeOwnedTables].map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]);
  for (const adapter of f.modules.adapters) {
    assert.throws(() => adapter.suppress(f.one.accountId, 1), { code: 'canonical_suppression_unproved' });
    assert.throws(() => f.db.transaction(() => adapter.suppress(f.one.accountId, 1)).immediate(), { code: 'canonical_suppression_unproved' });
    assert.deepEqual(adapter.purge('unqualified-request', f.one.accountId), { status: 'unavailable', reason: 'exact_purge_executor_binding_required' });
  }
  assert.deepEqual([...usageOwnedTables, ...bugIntakeOwnedTables].map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]), before);
  const record = f.ledger.recordDisable({ accountId: f.one.accountId, authUserId: f.one.authUserId, epoch: 1, requestId: 'synthetic-disable', disabledAtMs: 1 });
  f.db.transaction(() => {
    for (const adapter of f.modules.adapters)
      assert.throws(() => adapter.suppress(f.one.accountId, 1), { code: 'canonical_suppression_unproved' });
    f.db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=1,disabled_at_ms=1,suppression_seq=? WHERE account_id=?").run(record.sequence, f.one.accountId);
    f.records.set(f.one.accountId, { ...record, sequence: record.sequence + 1 });
    for (const adapter of f.modules.adapters)
      assert.throws(() => adapter.suppress(f.one.accountId, 1), { code: 'canonical_suppression_unproved' });
    f.records.set(f.one.accountId, record);
    for (const adapter of f.modules.adapters) {
      assert.equal(adapter.suppress(f.one.accountId, 1).status, 'complete');
      assert.equal(adapter.verifySuppressed(f.one.accountId, 1).status, 'complete');
    }
  }).immediate();
  const retained = [...usageOwnedTables, ...bugIntakeOwnedTables].map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]);
  f.db.transaction(() => {
    for (const adapter of f.modules.adapters) assert.equal(adapter.purge('unqualified-request', f.one.accountId).status, 'unavailable');
  }).immediate();
  assert.deepEqual([...usageOwnedTables, ...bugIntakeOwnedTables].map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]), retained);
  assert.equal(f.modules.bugFor(f.two).list().length, 0);
  assert.throws(() => f.modules.bugFor(f.one), { code: 'account_disabled' });
});
