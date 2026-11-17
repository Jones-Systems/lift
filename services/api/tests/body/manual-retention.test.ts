import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { DomainError } from '../../src/errors.js';
import { createManualMeasurements } from '../../src/body/measurements.js';
import { createBodyMeasurementRoutes, createManualRetentionRoutes } from '../../src/body/routes.js';
import { bodyCapabilities } from '../../src/body/index.js';
import { BODY_EXPORT_MEASUREMENT_CAP, MANUAL_RETENTION_EXPORT_ROW_CAP } from '../../src/body/manual-export.js';
import type { Sqlite } from '../../src/storage.js';
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
// Fast synthetic bulk insert of valid measurement rows; bypasses the create path and its per-account cap on purpose.
function insertSyntheticMeasurements(db: Sqlite, accountId: string, count: number): void {
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO body_manual_measurements SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)
      ||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),?,'weight',80,'kg','kg','2026-10-10',NULL,'2026-10-10T00:00:00.000Z' FROM n`)
    .run(count, accountId);
}

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

test('single lifecycle adapter inventories all relations and exports owner-only retained metadata after the unchanged measurements payload', t => {
  const f = setup(t), g = grant(); f.retention.grant(f.one, g, 'secret-grant-key');
  const saved = f.measurements.create(f.one, input, 'secret-measurement-key', authority(g.decisionId));
  const other = grant(); f.retention.grant(f.two, other, 'secret-other-grant-key');
  const otherSaved = f.measurements.create(f.two, { ...input, note: 'Other account note' }, 'secret-other-measurement-key', authority(other.decisionId));
  const adapter = f.writer.guardLifecycleAdapter(f.measurements.lifecycleAdapter);
  assert.equal(adapter.inventory(f.one).count, 5);
  const data: unknown[] = [], exported = adapter.export(f.one, { snapshotAtMs: Date.now(), append: (_category, value) => data.push(value) });
  assert.equal(data.length, 2);
  assert.equal(JSON.stringify(data[0]), JSON.stringify({ measurements: [saved] }), 'first payload keeps its exact shape and bytes');
  const decision = f.db.prepare('SELECT created_at,updated_at FROM body_manual_retention_decisions WHERE account_id=?').get(f.one.accountId) as { created_at: string; updated_at: string };
  const retained = f.db.prepare('SELECT created_at FROM body_manual_retention_receipts WHERE account_id=?').get(f.one.accountId) as { created_at: string };
  const attributed = f.db.prepare('SELECT created_at FROM body_manual_retention_attributions WHERE account_id=?').get(f.one.accountId) as { created_at: string };
  const stored = f.db.prepare('SELECT created_at FROM body_manual_measurements WHERE id=?').get(saved.id) as { created_at: string };
  assert.ok(Number.isFinite(Date.parse(stored.created_at)));
  assert.deepEqual(data[1], { schema: 'form.body-manual-retention-export/v1', retention: 'installed', statement: MANUAL_RETENTION_STATEMENT_BINDING,
    decisions: [{ decisionId: g.decisionId, state: 'granted', revision: 1, statement: MANUAL_RETENTION_STATEMENT_BINDING, createdAt: decision.created_at, updatedAt: decision.updated_at }],
    receipts: [{ operation: 'grant', decisionId: g.decisionId, outcome: 'granted', decisionRevision: 1, createdAt: retained.created_at }],
    attributions: [{ measurementId: saved.id, decisionId: g.decisionId, decisionRevision: 1, createdAt: attributed.created_at }],
    measurementMetadata: [{ measurementId: saved.id, createdAt: stored.created_at }],
    operations: [{ measurementId: saved.id, operation: 'create' }] });
  // The adapter count is the number of Body records appended, matching the account manifest's per-record count.
  assert.deepEqual({ category: exported.category, status: exported.status, reason: (exported as { reason?: string }).reason, count: exported.count },
    { category: 'body', status: 'complete', reason: undefined, count: data.length });
  const accountExport = buildAccountExport(f.db, f.one, f.writer.lifecycle.assertActive, [adapter]);
  const accountManifest = JSON.parse(accountExport.json).manifest as { categories: { category: string; status: string; reason?: string; count: number }[]; complete: boolean; omissions: { category: string }[] };
  assert.deepEqual(accountManifest.categories.find(entry => entry.category === 'body'), { category: 'body', status: 'complete', count: 2 });
  assert.equal(accountManifest.omissions.some(entry => entry.category === 'body'), false);
  assert.equal(accountManifest.complete, false); assert.equal(accountExport.complete, false);
  assert.ok(accountExport.json.includes(g.decisionId)); assert.ok(accountExport.json.includes(saved.id));
  // Owner-only: nothing about the other account, and no key/auth/session/epoch/intent-hash material for either account.
  for (const value of [other.decisionId, otherSaved.id, 'Other account note', 'secret-', 'grant:'])
    assert.equal(accountExport.json.includes(value), false, `leaked ${value}`);
  const secretValues = [...(f.db.prepare('SELECT intent_hash h FROM body_manual_receipts UNION SELECT intent_hash FROM body_manual_retention_receipts').all() as { h: string }[]).map(row => row.h),
    ...(f.db.prepare('SELECT session_id s FROM body_manual_retention_decisions').all() as { s: string }[]).map(row => row.s).filter(value => value.length > 3)];
  assert.ok(secretValues.length >= 4);
  for (const value of secretValues) assert.equal(accountExport.json.includes(value), false, 'leaked secret/derivation value');
  const bodyRecords = JSON.stringify((JSON.parse(accountExport.json) as { records: { category: string }[] }).records.filter(record => record.category === 'body'));
  assert.deepEqual([...new Set(bodyRecords.match(/[0-9a-f]{64}/g) ?? [])], [MANUAL_RETENTION_STATEMENT_SHA256]);
  assert.equal(/"(epoch|sessionId|session_id|authUserId|auth_user_id|key|intentHash|intent_hash|grantKey|measurementKey)"/.test(bodyRecords), false);
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

// Retained rows are immutable by trigger, so each corruption drops the guarding trigger first: this simulates damaged storage.
type Fixture = ReturnType<typeof setup>;
const exportCases: [string, (f: Fixture, ids: { decision: string; measurement: string; otherMeasurement: string; otherDecision: string }) => void, string][] = [
  ['non-JSON retention receipt', f => { f.db.exec('DROP TRIGGER immutable_body_manual_retention_receipt');
    f.db.prepare('UPDATE body_manual_retention_receipts SET receipt=? WHERE account_id=?').run('{"opaque":"value"}', f.one.accountId); }, 'body_manual_export_invalid_data'],
  ['retention receipt naming another decision', f => { f.db.exec('DROP TRIGGER immutable_body_manual_retention_receipt');
    f.db.prepare('UPDATE body_manual_retention_receipts SET receipt=? WHERE account_id=?').run(JSON.stringify({ operation: 'grant', decisionId: randomUUID(),
      outcome: 'granted', decisionRevision: 1 }), f.one.accountId); }, 'body_manual_export_invalid_data'],
  ['malformed intent hash', f => { f.db.prepare('UPDATE body_manual_receipts SET intent_hash=? WHERE account_id=?').run('not-a-digest', f.one.accountId); }, 'body_manual_export_invalid_data'],
  ['decision with a foreign statement digest', f => { f.db.exec('DROP TRIGGER terminal_body_manual_retention_decision');
    f.db.prepare('UPDATE body_manual_retention_decisions SET statement_sha256=? WHERE account_id=?').run('a'.repeat(64), f.one.accountId); }, 'body_manual_export_invalid_data'],
  ['decision with a malformed instant', f => { f.db.exec('DROP TRIGGER terminal_body_manual_retention_decision');
    f.db.prepare('UPDATE body_manual_retention_decisions SET created_at=? WHERE account_id=?').run('yesterday', f.one.accountId); }, 'body_manual_export_invalid_data'],
  ['attribution without its creation record (partial)', f => { f.db.exec('DROP TRIGGER immutable_body_manual_retention_attribution');
    f.db.prepare('UPDATE body_manual_retention_attributions SET measurement_id=? WHERE account_id=?').run(randomUUID(), f.one.accountId); }, 'body_manual_export_invalid_data'],
  ['missing retained relation (partial schema)', f => { f.db.exec('DROP TABLE body_manual_retention_attributions'); }, 'body_manual_retention_migration_required'],
  ['attribution pointing at another account measurement', (f, ids) => { f.db.exec('DROP TRIGGER immutable_body_manual_retention_attribution');
    f.db.prepare('UPDATE body_manual_retention_attributions SET measurement_id=? WHERE account_id=?').run(ids.otherMeasurement, f.one.accountId); }, 'body_manual_export_scope_mismatch'],
  ['operation history pointing at another account measurement', (f, ids) => { f.db.prepare('UPDATE body_manual_receipts SET measurement_id=? WHERE account_id=?')
    .run(ids.otherMeasurement, f.one.accountId); }, 'body_manual_export_scope_mismatch'],
  ['decision bound to another principal', f => { f.db.exec('DROP TRIGGER terminal_body_manual_retention_decision');
    f.db.prepare('UPDATE body_manual_retention_decisions SET auth_user_id=? WHERE account_id=?').run(f.two.authUserId, f.one.accountId); }, 'body_manual_export_scope_mismatch'],
  ['oversized operation history', f => {
    f.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO body_manual_receipts SELECT ?,'bulk-'||i,?,?,'create' FROM n`).run(MANUAL_RETENTION_EXPORT_ROW_CAP + 1, f.one.accountId, 'b'.repeat(64), randomUUID()); }, 'account_export_packaging_required'],
  ['measurement with a malformed stored created_at', (f, ids) => { f.db.prepare('UPDATE body_manual_measurements SET created_at=? WHERE id=?')
    .run('2026-10-10 10:00:00', ids.measurement); }, 'body_manual_export_invalid_data'],
  ['measurement with a malformed measured_on', (f, ids) => { f.db.prepare('UPDATE body_manual_measurements SET measured_on=? WHERE id=?')
    .run('', ids.measurement); }, 'body_manual_export_invalid_data'],
  ['more measurements than the export capacity', f => { insertSyntheticMeasurements(f.db, f.one.accountId, BODY_EXPORT_MEASUREMENT_CAP); }, 'body_export_capacity_exceeded'],
];
for (const [name, corrupt, expected] of exportCases) test(`export fails closed without partial output: ${name}`, t => {
  const f = setup(t), g = grant(); f.retention.grant(f.one, g, 'grant');
  const saved = f.measurements.create(f.one, input, 'measurement', authority(g.decisionId));
  const other = grant(); f.retention.grant(f.two, other, 'other-grant');
  const otherSaved = f.measurements.create(f.two, input, 'other-measurement', authority(other.decisionId));
  const adapter = f.writer.guardLifecycleAdapter(f.measurements.lifecycleAdapter);
  const baseline: unknown[] = []; adapter.export(f.one, { snapshotAtMs: Date.now(), append: (_category, value) => baseline.push(value) });
  assert.equal(baseline.length, 2);
  corrupt(f, { decision: g.decisionId, measurement: saved.id, otherMeasurement: otherSaved.id, otherDecision: other.decisionId });
  const appended: unknown[] = [];
  assert.throws(() => adapter.export(f.one, { snapshotAtMs: Date.now(), append: (_category, value) => appended.push(value) }), code(expected));
  assert.deepEqual(appended, [], 'nothing is appended before every relation validates');
  assert.throws(() => buildAccountExport(f.db, f.one, f.writer.lifecycle.assertActive, [adapter]), code(expected));
  assert.equal(f.db.inTransaction, false);
});

test('export keeps the aggregate account export bound and still refuses disabled accounts', t => {
  const f = setup(t), g = grant(); f.retention.grant(f.one, g, 'grant');
  f.measurements.create(f.one, input, 'measurement', authority(g.decisionId));
  const adapter = f.writer.guardLifecycleAdapter(f.measurements.lifecycleAdapter);
  const whole = buildAccountExport(f.db, f.one, f.writer.lifecycle.assertActive, [adapter]);
  assert.throws(() => buildAccountExport(f.db, f.one, f.writer.lifecycle.assertActive, [adapter], whole.bytes - 1), code('account_export_packaging_required'));
  assert.equal(buildAccountExport(f.db, f.one, f.writer.lifecycle.assertActive, [adapter], whole.bytes).bytes, whole.bytes);
  f.db.prepare('UPDATE account_lifecycle SET epoch=1 WHERE account_id=?').run(f.one.accountId);
  assert.throws(() => adapter.export(f.one, { snapshotAtMs: Date.now(), append: () => assert.fail('disabled epoch must not append') }), code('account_epoch_changed'));
});

test('revoked-before-grant tombstones and terminal revocations export their state without fabricating authority', t => {
  const f = setup(t), g = grant(), stopped = grant();
  f.retention.revoke(f.one, stopped.decisionId, {}, 'stop-first'); f.retention.grant(f.one, stopped, 'late-grant');
  f.retention.grant(f.one, g, 'grant'); f.retention.revoke(f.one, g.decisionId, {}, 'revoke');
  const adapter = f.writer.guardLifecycleAdapter(f.measurements.lifecycleAdapter), data: { decisions?: { decisionId: string; state: string; revision: number; statement: unknown }[];
    receipts?: { outcome: string }[]; attributions?: unknown[]; operations?: unknown[] }[] = [];
  adapter.export(f.one, { snapshotAtMs: Date.now(), append: (_category, value) => data.push(value as never) });
  const byId = new Map(data[1]!.decisions!.map(entry => [entry.decisionId, entry]));
  assert.deepEqual(byId.get(stopped.decisionId), { ...byId.get(stopped.decisionId)!, state: 'revoked', revision: 1, statement: null });
  assert.equal(byId.get(g.decisionId)!.state, 'revoked'); assert.equal(byId.get(g.decisionId)!.revision, 2);
  assert.deepEqual(data[1]!.receipts!.map(entry => entry.outcome).sort(), ['blocked_by_revocation', 'granted', 'revoked', 'revoked']);
  assert.deepEqual(data[1]!.attributions, []); assert.deepEqual(data[1]!.operations, []);
});

test('export counts measurements first and fails closed above the 10,000 cap instead of truncating', t => {
  const f = setup(t), g = grant(); f.retention.grant(f.one, g, 'grant');
  const adapter = f.writer.guardLifecycleAdapter(f.measurements.lifecycleAdapter);
  insertSyntheticMeasurements(f.db, f.one.accountId, BODY_EXPORT_MEASUREMENT_CAP);
  const atCap: unknown[] = []; adapter.export(f.one, { snapshotAtMs: Date.now(), append: (_category, value) => atCap.push(value) });
  const [first, retained] = atCap as [{ measurements: unknown[] }, { measurementMetadata: unknown[] }];
  assert.equal(first.measurements.length, BODY_EXPORT_MEASUREMENT_CAP); assert.equal(retained.measurementMetadata.length, BODY_EXPORT_MEASUREMENT_CAP);
  // The public list route keeps its own unchanged LIMIT behaviour.
  assert.equal(f.measurements.list(f.one).items.length, BODY_EXPORT_MEASUREMENT_CAP);
  insertSyntheticMeasurements(f.db, f.one.accountId, 1);
  const appended: unknown[] = [];
  assert.throws(() => adapter.export(f.one, { snapshotAtMs: Date.now(), append: (_category, value) => appended.push(value) }),
    (error: unknown) => error instanceof DomainError && error.status === 413 && error.code === 'body_export_capacity_exceeded');
  assert.deepEqual(appended, [], 'nothing is appended for an over-capacity account');
  assert.throws(() => buildAccountExport(f.db, f.one, f.writer.lifecycle.assertActive, [adapter]), code('body_export_capacity_exceeded'));
  assert.equal(f.db.inTransaction, false);
  assert.equal(f.measurements.list(f.one).items.length, BODY_EXPORT_MEASUREMENT_CAP, 'list still truncates at its route limit');
});

function notInstalled(t: TestContext) {
  const f = setup(t, false);
  assert.equal(manualRetentionOwnedTables.some(table => f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)), false);
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='body_manual_receipts'").get());
  const seed = (actor: { accountId: string }, key: string, operation: 'create' | 'delete', id: string = randomUUID(), createdAt: string | null = '2026-10-10T08:00:00.000Z') => {
    if (createdAt !== null) f.db.prepare('INSERT INTO body_manual_measurements VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, actor.accountId, 'weight', 80, 'kg', 'kg', '2026-10-10', 'Synthetic legacy note', createdAt);
    f.db.prepare('INSERT INTO body_manual_receipts VALUES(?,?,?,?,?)').run(actor.accountId, key,
      createHash('sha256').update(`${operation}:${key}`).digest('hex'), id, operation);
    return id;
  };
  return { ...f, seed, adapter: f.writer.guardLifecycleAdapter(f.measurements.lifecycleAdapter) };
}

test('without retention tables the export carries stored created_at and timestamp-free create/delete history only', t => {
  const f = notInstalled(t);
  const kept = f.seed(f.one, 'secret-legacy-create', 'create', undefined, '2026-10-10T08:00:00.000Z');
  const gone = f.seed(f.one, 'secret-legacy-create-gone', 'create', undefined, null);
  f.seed(f.one, 'secret-legacy-delete', 'delete', gone, null);
  const foreign = f.seed(f.two, 'secret-other-create', 'create', undefined, '2026-10-11T08:00:00.000Z');
  const data: unknown[] = [], section = f.adapter.export(f.one, { snapshotAtMs: Date.now(), append: (_category, value) => data.push(value) });
  assert.deepEqual(section, { category: 'body', status: 'complete', count: 2 });
  assert.equal(JSON.stringify(data[0]), JSON.stringify(f.measurements.list(f.one)).replace('"items"', '"measurements"'),
    'first payload stays byte-identical to the list projection');
  assert.deepEqual(data[1], { schema: 'form.body-manual-retention-export/v1', retention: 'not_installed',
    measurementMetadata: [{ measurementId: kept, createdAt: '2026-10-10T08:00:00.000Z' }],
    operations: [{ measurementId: kept, operation: 'create' }, { measurementId: gone, operation: 'create' }, { measurementId: gone, operation: 'delete' }] });
  const whole = buildAccountExport(f.db, f.one, f.writer.lifecycle.assertActive, [f.adapter]);
  const document = JSON.parse(whole.json) as { records: { category: string; value: unknown }[]; manifest: { complete: boolean; snapshotAtMs: number;
    categories: { category: string; status: string; count: number }[] } };
  const bodyRecords = document.records.filter(record => record.category === 'body');
  assert.deepEqual(document.manifest.categories.find(entry => entry.category === 'body'), { category: 'body', status: 'complete', count: bodyRecords.length });
  assert.equal(document.manifest.complete, false); assert.equal(whole.complete, false); assert.equal(document.manifest.snapshotAtMs, whole.snapshotAtMs);
  const bodyJson = JSON.stringify(bodyRecords);
  for (const value of [foreign, 'secret-',
    ...(f.db.prepare('SELECT intent_hash h FROM body_manual_receipts').all() as { h: string }[]).map(row => row.h)])
    assert.equal(bodyJson.includes(value), false, `leaked ${value}`);
  assert.equal(/"(key|intentHash|intent_hash|epoch|sessionId|session_id|authUserId|auth_user_id|grantKey)"/.test(bodyJson), false);
  assert.deepEqual(Object.keys((data[1] as { operations: object[] }).operations[0]!), ['measurementId', 'operation'], 'operation history carries no timestamp or secret');
});

const notInstalledCorruptions: [string, (f: ReturnType<typeof notInstalled>) => void, string][] = [
  ['unknown operation', f => { f.seed(f.one, 'odd', 'create'); f.db.prepare("UPDATE body_manual_receipts SET operation='update' WHERE key='odd'").run(); }, 'body_manual_export_invalid_data'],
  ['non-UUID measurement id', f => { f.seed(f.one, 'odd', 'delete', 'not-a-uuid', null); }, 'body_manual_export_invalid_data'],
  ['malformed intent hash', f => { f.seed(f.one, 'odd', 'create'); f.db.prepare("UPDATE body_manual_receipts SET intent_hash='short' WHERE key='odd'").run(); }, 'body_manual_export_invalid_data'],
  ['receipt naming another account measurement', f => { const foreign = f.seed(f.two, 'other', 'create'); f.seed(f.one, 'odd', 'delete', foreign, null); }, 'body_manual_export_scope_mismatch'],
  ['malformed stored created_at', f => { f.seed(f.one, 'odd', 'create', undefined, 'synthetic historical'); }, 'body_manual_export_invalid_data'],
  ['receipts relation missing its operation column (partial schema)', f => { f.db.exec('ALTER TABLE body_manual_receipts DROP COLUMN operation'); }, 'body_manual_export_schema_incomplete'],
  ['receipts relation dropped (partial schema)', f => { f.db.exec('DROP TABLE body_manual_receipts'); }, 'body_manual_export_schema_incomplete'],
];
for (const [name, corrupt, expected] of notInstalledCorruptions) test(`not_installed export fails closed without partial output: ${name}`, t => {
  const f = notInstalled(t); f.seed(f.one, 'valid', 'create');
  corrupt(f);
  const appended: unknown[] = [];
  assert.throws(() => f.adapter.export(f.one, { snapshotAtMs: Date.now(), append: (_category, value) => appended.push(value) }), code(expected));
  assert.deepEqual(appended, []);
  assert.throws(() => buildAccountExport(f.db, f.one, f.writer.lifecycle.assertActive, [f.adapter]), code(expected));
  assert.equal(f.db.inTransaction, false);
});
