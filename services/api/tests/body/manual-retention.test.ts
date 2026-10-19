import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { DomainError } from '../../src/errors.js';
import { createManualMeasurements } from '../../src/body/measurements.js';
import { createBodyMeasurementRoutes, createManualRetentionRoutes } from '../../src/body/routes.js';
import { bodyCapabilities } from '../../src/body/index.js';
import { sourceManualRetentionMigration, manualRetentionOwnedTables } from '../../src/body/manual-retention-migration.js';
import { MANUAL_RETENTION_PROTOCOL, MANUAL_RETENTION_STATEMENT, MANUAL_RETENTION_STATEMENT_SHA256,
  MANUAL_RETENTION_STATEMENT_BINDING, formatManualRetentionHeader, parseManualRetentionHeader } from '../../src/body/manual-retention-contract.js';
import { appendSourceBodyMeasurementMigration, appendSourceManualRetentionMigration, selectAccountModuleMigrations } from '../../src/integration/account-modules/migrations.js';
import { createCanonicalAccountWriter } from '../../src/integration/account-modules/canonical-writer.js';
import { hash } from '../../src/storage.js';
import { buildAccountExport } from '../../src/lifecycle/export.js';
import { baseMigrations, fixture } from '../integration/account-modules/fixture.js';

const input = { kind: 'waist', value: 30, unit: 'in', measuredOn: '2026-10-10' };
const grant = (decisionId = randomUUID()) => ({ decisionId, processing: 'manual_entry', purpose: 'personal_measurement_progress',
  choice: 'retain', statementId: MANUAL_RETENTION_STATEMENT.id, statementVersion: 1, statementSha256: MANUAL_RETENTION_STATEMENT_SHA256 });
const authority = (decisionId: string) => ({ protocol: MANUAL_RETENTION_PROTOCOL, decisionId, revision: 1, statementSha256: MANUAL_RETENTION_STATEMENT_SHA256 });
const full = appendSourceManualRetentionMigration(appendSourceBodyMeasurementMigration(selectAccountModuleMigrations({ mode: 'source-only',
  modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, baseMigrations)));
function setup(t: TestContext, selected = true) {
  const f = fixture(); t.after(f.close);
  for (const migration of full.filter(entry => entry.version > 16 && (selected || entry.version !== 23))) {
    f.db.exec(migration.sql);
    f.db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
  }
  const writer = createCanonicalAccountWriter(f.db);
  const measurements = createManualMeasurements(f.db, writer.lifecycle, undefined, selected ? 'selected-migration-23' : undefined);
  return { ...f, writer, measurements, retention: measurements.manualRetention! };
}
const code = (value: string) => ({ code: value });

test('grant/revoke receipts are immutable but replay observes fresh terminal current', t => {
  const f = setup(t), g = grant();
  assert.equal(f.retention.current(f.one, g.decisionId).current, null);
  const first = f.retention.grant(f.one, g, 'grant');
  assert.deepEqual(first.current, { decisionId: g.decisionId, state: 'granted', revision: 1, statement: MANUAL_RETENTION_STATEMENT_BINDING });
  assert.deepEqual(f.retention.grant(f.one, g, 'grant'), first);
  assert.throws(() => f.retention.grant(f.one, g, 'another-grant'), code('body_manual_retention_decision_exists'));
  const revoked = f.retention.revoke(f.one, g.decisionId, {}, 'revoke');
  assert.equal(revoked.current.revision, 2);
  const replay = f.retention.grant(f.one, g, 'grant');
  assert.deepEqual(replay.receipt, first.receipt); assert.deepEqual(replay.current, revoked.current);
  const delayed = f.retention.grant(f.one, g, 'delayed-grant');
  assert.equal(delayed.receipt.outcome, 'blocked_by_revocation'); assert.equal(delayed.receipt.decisionRevision, 2);
  assert.deepEqual(f.retention.revoke(f.one, g.decisionId, {}, 'revoke'), revoked);
  assert.throws(() => f.retention.grant(f.one, grant(), 'grant'), code('idempotency_conflict'));
  assert.throws(() => f.db.prepare('UPDATE body_manual_retention_receipts SET key=? WHERE account_id=?').run('changed', f.one.accountId));
  assert.throws(() => f.db.prepare("UPDATE body_manual_retention_decisions SET state='granted',revision=1 WHERE account_id=?").run(f.one.accountId));
  assert.equal(f.retention.grant(f.one, grant(), 'fresh-decision').current.state, 'granted');
});

test('revoke before grant stores a terminal revision1 tombstone without a statement', t => {
  const f = setup(t), g = grant();
  const revoked = f.retention.revoke(f.one, g.decisionId, {}, 'stop-before-grant');
  assert.deepEqual(revoked.current, { decisionId: g.decisionId, state: 'revoked', revision: 1, statement: null });
  const blocked = f.retention.grant(f.one, g, 'delayed');
  assert.equal(blocked.receipt.outcome, 'blocked_by_revocation'); assert.equal(blocked.receipt.decisionRevision, 1);
  assert.deepEqual(blocked.current, revoked.current);
  assert.throws(() => f.measurements.create(f.one, input, 'measurement', authority(g.decisionId)), code('body_manual_retention_required'));
});

test('measurement authority follows receipt lookup; attribution persists across revocation, deletion and replays', t => {
  const f = setup(t), g = grant();
  f.retention.grant(f.one, g, 'grant');
  const created = f.measurements.create(f.one, input, 'measurement', authority(g.decisionId));
  assert.equal(created.value, 76.2); assert.equal(Object.keys(created).length, 8);
  const receipt = f.db.prepare('SELECT * FROM body_manual_receipts WHERE account_id=? AND key=?').get(f.one.accountId, 'measurement') as { intent_hash: string };
  assert.equal(receipt.intent_hash, createHash('sha256').update(JSON.stringify({ operation: 'create', input })).digest('hex'));
  const attribution = f.db.prepare('SELECT * FROM body_manual_retention_attributions WHERE account_id=?').get(f.one.accountId);
  f.retention.revoke(f.one, g.decisionId, {}, 'revoke');
  assert.deepEqual(f.measurements.create(f.one, input, 'measurement'), created);
  const replacement = grant(); f.retention.grant(f.one, replacement, 'replacement');
  assert.deepEqual(f.measurements.create(f.one, input, 'measurement', authority(replacement.decisionId)), created);
  assert.deepEqual(f.db.prepare('SELECT * FROM body_manual_retention_attributions WHERE account_id=?').get(f.one.accountId), attribution);
  assert.throws(() => f.measurements.create(f.one, input, 'new', authority(g.decisionId)), code('body_manual_retention_required'));
  f.measurements.delete(f.one, created.id, {}, 'delete');
  assert.throws(() => f.measurements.create(f.one, input, 'measurement'), code('body_measurement_not_found'));
  assert.deepEqual(f.db.prepare('SELECT * FROM body_manual_retention_attributions WHERE account_id=?').get(f.one.accountId), attribution);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('original receipt and new attribution are one rollback boundary', t => {
  const f = setup(t), g = grant(); f.retention.grant(f.one, g, 'grant');
  f.db.exec("CREATE TRIGGER synthetic_attribution_failure BEFORE INSERT ON body_manual_retention_attributions BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END;");
  assert.throws(() => f.measurements.create(f.one, input, 'measurement', authority(g.decisionId)), /synthetic rollback/);
  for (const table of ['body_manual_measurements', 'body_manual_receipts', 'body_manual_retention_attributions'])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
  f.db.exec('DROP TRIGGER synthetic_attribution_failure');
  assert.ok(f.measurements.create(f.one, input, 'measurement', authority(g.decisionId)).id);
  f.db.exec("CREATE TRIGGER synthetic_control_failure BEFORE INSERT ON body_manual_retention_receipts BEGIN SELECT RAISE(ABORT,'synthetic control rollback'); END;");
  const other = grant(); assert.throws(() => f.retention.grant(f.one, other, 'other'), /synthetic control rollback/);
  assert.equal(f.retention.current(f.one, other.decisionId).current, null);
  assert.throws(() => f.retention.revoke(f.one, g.decisionId, {}, 'stop'), /synthetic control rollback/);
  assert.equal(f.retention.current(f.one, g.decisionId).current?.state, 'granted');
});

test('legacy matching receipt replays without grant and stays unattributed; new writes fail without selected23', t => {
  const f = setup(t, false), id = randomUUID();
  f.db.prepare('INSERT INTO body_manual_measurements VALUES(?,?,?,?,?,?,?,?,?)').run(id, f.one.accountId, 'waist', 76.2, 'cm', 'in', input.measuredOn, null, 'synthetic');
  f.db.prepare('INSERT INTO body_manual_receipts VALUES(?,?,?,?,?)').run(f.one.accountId, 'legacy',
    createHash('sha256').update(JSON.stringify({ operation: 'create', input })).digest('hex'), id, 'create');
  assert.equal(f.measurements.create(f.one, input, 'legacy').id, id);
  assert.throws(() => f.measurements.create(f.one, input, 'new'), code('body_manual_retention_required'));
  assert.throws(() => f.measurements.create(f.one, { ...input, value: 31 }, 'legacy'), code('idempotency_conflict'));
  f.db.exec(sourceManualRetentionMigration.sql);
  f.db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(23, hash(sourceManualRetentionMigration.sql), 'synthetic');
  const selected = createManualMeasurements(f.db, f.writer.lifecycle, undefined, 'selected-migration-23');
  assert.equal(selected.create(f.one, input, 'legacy').id, id);
  assert.equal((f.db.prepare('SELECT count(*) n FROM body_manual_retention_attributions').get() as { n: number }).n, 0);
  selected.delete(f.one, id, {}, 'delete');
  assert.throws(() => selected.create(f.one, input, 'legacy'), code('body_measurement_not_found'));
});

test('control and authority are original account/session/epoch scoped, including epoch0', t => {
  const f = setup(t), g = grant(); f.retention.grant(f.one, g, 'grant');
  assert.equal(f.retention.current(f.two, g.decisionId).current, null);
  assert.throws(() => f.measurements.create(f.two, input, 'wrong-account', authority(g.decisionId)), code('body_manual_retention_required'));
  f.db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run('another-session', f.one.authUserId, 'another-token', Date.now() + 600000, Date.now(), Date.now());
  const otherSession = { ...f.one, sessionId: 'another-session' };
  for (const run of [() => f.retention.current(otherSession, g.decisionId), () => f.retention.revoke(otherSession, g.decisionId, {}, 'revoke'),
    () => f.measurements.create(otherSession, input, 'measurement', authority(g.decisionId))])
    assert.throws(run, code('body_manual_retention_context_mismatch'));
  assert.throws(() => f.retention.grant(otherSession, g, 'grant'), code('idempotency_conflict'));
  f.db.prepare('UPDATE account_lifecycle SET epoch=1 WHERE account_id=?').run(f.one.accountId);
  assert.throws(() => f.retention.current(f.one, g.decisionId), code('account_epoch_changed'));
  assert.throws(() => f.retention.current({ ...f.one, epoch: 1 }, g.decisionId), code('body_manual_retention_context_mismatch'));
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.two.sessionId);
  assert.throws(() => f.retention.current(f.two, g.decisionId), code('account_session_invalid'));
});

test('single lifecycle adapter inventories all relations and omits decision metadata from export', t => {
  const f = setup(t), g = grant(); f.retention.grant(f.one, g, 'grant');
  const saved = f.measurements.create(f.one, input, 'measurement', authority(g.decisionId));
  const other = grant(); f.retention.grant(f.two, other, 'other');
  const adapter = f.writer.guardLifecycleAdapter(f.measurements.lifecycleAdapter);
  assert.equal(adapter.inventory(f.one).count, 5);
  const data: unknown[] = [], exported = adapter.export(f.one, { snapshotAtMs: Date.now(), append: (_category, value) => data.push(value) });
  assert.deepEqual(data, [{ measurements: [saved] }]); assert.equal(exported.status, 'unavailable');
  assert.equal(exported.reason, 'manual_retention_metadata_omitted');
  const accountExport = buildAccountExport(f.db, f.one, f.writer.lifecycle.assertActive, [adapter]);
  const accountManifest = JSON.parse(accountExport.json).manifest as { categories: { category: string; status: string; reason: string }[] };
  assert.equal(accountManifest.categories.find(entry => entry.category === 'body')?.reason, 'manual_retention_metadata_omitted');
  assert.equal(accountManifest.categories.find(entry => entry.category === 'body')?.status, 'unavailable');
  assert.equal(accountExport.json.includes(g.decisionId), false);
  assert.equal(accountExport.complete, false);
  assert.deepEqual(adapter.purge('request', f.one.accountId), { status: 'unavailable', reason: 'exact_purge_executor_binding_required' });
  assert.throws(() => f.measurements.lifecycleAdapter.suppress(f.one.accountId, 1), code('body_lifecycle_serialization_required'));
  f.db.transaction(() => {
    f.measurements.lifecycleAdapter.suppress(f.one.accountId, 1);
    assert.equal(f.measurements.lifecycleAdapter.verifySuppressed(f.one.accountId, 1).status, 'complete');
  }).immediate();
  for (const table of [...manualRetentionOwnedTables, 'body_manual_measurements', 'body_manual_receipts'])
    assert.equal((f.db.prepare(`SELECT count(*) n FROM ${table} WHERE account_id=?`).get(f.one.accountId) as { n: number }).n, 0);
  assert.equal(f.retention.current(f.two, other.decisionId).current?.state, 'granted');
});

test('HTTP strict grant/revoke input and exact 134-character attempt header preserve measurement shape', async t => {
  const f = setup(t), app = new Hono();
  app.onError((error, c) => c.json({ error: { code: error instanceof DomainError ? error.code : 'unexpected' } }, error instanceof DomainError ? error.status : 500));
  app.route('/v1/body/measurements', createBodyMeasurementRoutes({ context: () => f.one, serviceFor: () => f.measurements }));
  app.route('/v1/body/manual-retention', createManualRetentionRoutes({ context: () => f.one, serviceFor: () => f.retention }));
  const request = (path: string, value: unknown, key: string, header?: string | string[]) => {
    const headers = new Headers({ 'content-type': 'application/json', 'idempotency-key': key });
    for (const v of Array.isArray(header) ? header : header ? [header] : []) headers.append('X-Form-Manual-Retention', v);
    return app.request('/v1/body/' + path, { method: 'POST', headers, body: JSON.stringify(value) });
  };
  const g = grant();
  for (const bad of [{ ...g, accountId: f.one.accountId }, { ...g, purpose: 'research' }, { ...g, statementVersion: 2 }, { ...g, statementSha256: 'a'.repeat(64) }])
    assert.equal((await request('manual-retention', bad, randomUUID())).status, 422);
  assert.equal((await request('manual-retention', g, 'grant')).status, 200);
  const header = formatManualRetentionHeader(authority(g.decisionId))!; assert.equal(header.length, 134);
  const paddedHeader = header + ' ';
  assert.equal(parseManualRetentionHeader(paddedHeader), null);
  // Headers strips surrounding whitespace before routing; the route cannot recover the discarded raw value.
  const normalized = new Headers({ 'X-Form-Manual-Retention': paddedHeader });
  assert.equal(normalized.get('X-Form-Manual-Retention'), header);
  assert.equal((await request('measurements', input, 'normalized-header', paddedHeader)).status, 201);
  const interiorWhitespace = header.replace(';revision=', '; revision=');
  assert.equal(new Headers({ 'X-Form-Manual-Retention': interiorWhitespace }).get('X-Form-Manual-Retention'), interiorWhitespace);
  assert.equal(parseManualRetentionHeader(interiorWhitespace), null);
  for (const invalid of [undefined, '', interiorWhitespace, [header, header], header.replace('revision=1', 'revision=2'), header.replace(MANUAL_RETENTION_STATEMENT_SHA256, 'a'.repeat(64))])
    assert.equal((await request('measurements', input, randomUUID(), invalid)).status, 403, `Invalid observable header: ${JSON.stringify(invalid)}`);
  const created = await request('measurements', input, 'measurement', header); assert.equal(created.status, 201);
  assert.equal((await request(`manual-retention/${g.decisionId}/revoke`, { accountId: f.one.accountId }, 'bad-revoke')).status, 422);
  assert.equal((await request(`manual-retention/${g.decisionId}/revoke`, {}, 'revoke')).status, 200);
  assert.deepEqual(await (await request('measurements', input, 'measurement')).json(), await created.json());
  const current = await (await app.request(`/v1/body/manual-retention/${g.decisionId}`)).json() as { schema: string; current: { state: string } };
  assert.equal(current.schema, 'form.manual-retention-current/v1'); assert.equal(current.current.state, 'revoked');
  assert.equal(bodyCapabilities(true).operations.save_manual_measurement?.status, 'unavailable');
  assert.equal(bodyCapabilities(true).operations.list_progress?.status, 'available');
  assert.equal(bodyCapabilities(true, true).manualRetention.status, 'available');
});

test('each retained new relation alone requires the Body lifecycle adapter', async t => {
  const { AccountLifecycle } = await import('../../src/lifecycle/service.js');
  for (const table of manualRetentionOwnedTables) {
    const f = fixture();
    try {
      const adapters = [...f.existing.adapters, ...f.modules.adapters];
      assert.doesNotThrow(() => new AccountLifecycle(f.db, adapters, f.ledger));
      f.db.exec(`CREATE TABLE ${table}(account_id TEXT NOT NULL)`);
      assert.throws(() => new AccountLifecycle(f.db, adapters, f.ledger), code('lifecycle_adapter_required'));
    } finally { f.close(); }
  }
});
