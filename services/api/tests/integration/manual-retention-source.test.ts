import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { createServer, type FormServer, type ServerConfig } from '../../src/server.js';
import { manualMeasurementMigrationSql as leafMeasurementSql } from '../../src/body/manual-measurement-migration.js';
import { createManualMeasurements, manualMeasurementMigrationSql } from '../../src/body/measurements.js';
import { manualRetentionOwnedTables, sourceManualRetentionMigration } from '../../src/body/manual-retention-migration.js';
import { MANUAL_RETENTION_PROTOCOL, MANUAL_RETENTION_STATEMENT_BINDING, MANUAL_RETENTION_STATEMENT_SHA256,
  formatManualRetentionHeader, captureManualRetentionCapability } from '../../src/body/manual-retention-contract.js';
import { sourceReportedLoadMigration } from '../../src/source-reported-load-migration.js';
import { appendSourceBodyMeasurementMigration, appendSourceManualRetentionMigration, appendSourceReportedLoadMigration,
  assertSourceManualRetentionHistory, assertSourceManualRetentionSelection, assertSourceReportedLoadHistory,
  selectAccountModuleMigrations, sourceBodyMeasurementMigration } from '../../src/integration/account-modules/migrations.js';
import { hash, openStorage, migrate, type Sqlite, type Migration } from '../../src/storage.js';
import { baseMigrations, moduleMigrations, requestConfiguration, suppressionLedger, install } from './account-modules/fixture.js';

const fullConfiguration = { mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' } as const;
const full20 = selectAccountModuleMigrations(fullConfiguration, baseMigrations);
const full21 = appendSourceBodyMeasurementMigration(full20);
const retention = appendSourceManualRetentionMigration(full21);
const both = appendSourceReportedLoadMigration(retention);
const history = (selected: readonly Migration[]) => selected.map(entry => ({ version: entry.version, checksum: hash(entry.sql) }));
const readHistory = (db: Sqlite) => db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all();
async function scratch(run: (root: string) => Promise<void>) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'manual-retention-'));
  const cleanup = () => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); };
  const interrupt = () => { cleanup(); process.exit(130); }, terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  let failure: unknown, failed = false;
  try { await run(root); } catch (error) { failure = error; failed = true; }
  finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    try { cleanup(); } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Manual retention check and exact scratch cleanup failed');
      throw error;
    }
  }
  if (failed) throw failure;
}
function seed(dbPath: string, selected: readonly Migration[], modify?: (db: Sqlite) => void) {
  const db: Sqlite = new Database(dbPath);
  try { install(db, selected); modify?.(db); } finally { db.close(); }
}

test('23 selection is exact genuine21 plus optional explicit22; old SQL identity is unchanged', () => {
  assert.equal(leafMeasurementSql, manualMeasurementMigrationSql);
  const descriptor = Object.getOwnPropertyDescriptor(sourceBodyMeasurementMigration, 'sql');
  assert.equal(descriptor?.value, manualMeasurementMigrationSql); assert.equal(descriptor?.get, undefined);
  assert.equal(hash(manualMeasurementMigrationSql), '5165c125d7bd499e7531a891abd593bad1d42ff8a0ff16fa88f90c364ff026f0');
  assert.equal(hash(sourceReportedLoadMigration.sql), 'b027ac49e4b5cc4eeb4a28aa5ade142b73e415fff02f3a88c620ea76936de771');
  assert.deepEqual(retention.map(entry => entry.version), [...Array.from({ length: 21 }, (_, index) => index + 1), 23]);
  assert.deepEqual(both.map(entry => entry.version), Array.from({ length: 23 }, (_, index) => index + 1));
  assert.equal(retention.find(entry => entry.version === 21)?.sql, manualMeasurementMigrationSql);
  assert.equal(both.find(entry => entry.version === 22)?.sql, sourceReportedLoadMigration.sql);
  assert.equal(both.find(entry => entry.version === 23)?.sql, sourceManualRetentionMigration.sql);
  assertSourceManualRetentionSelection(retention); assertSourceManualRetentionSelection(both);
  assertSourceReportedLoadHistory(history(both), true);
  for (const invalid of [full21, retention.filter(entry => entry.version !== 21), [...retention, sourceManualRetentionMigration],
    retention.map(entry => entry.version === 20 ? { ...entry, sql: entry.sql + '\nSELECT 1;' } : entry),
    [...retention, { version: 24, sql: 'SELECT 1;' }]]) assert.throws(() => assertSourceManualRetentionSelection(invalid));
  for (const invalid of [history(retention).filter(entry => entry.version !== 21), [...history(retention), history(retention)[0]!],
    history(retention).map(entry => entry.version === 23 ? { ...entry, checksum: '0'.repeat(64) } : entry),
    [...history(retention), { version: 24, checksum: hash('SELECT 1;') }]]) assert.throws(() => assertSourceManualRetentionHistory(invalid, true));
});

test('genuine durable late21+23 after20+22 and explicit late22 after21+23 preserve histories', () => scratch(async root => {
  for (const direction of ['retention-after-load', 'load-after-retention']) {
    const dbPath = join(root, direction + '.sqlite');
    seed(dbPath, direction === 'retention-after-load' ? appendSourceReportedLoadMigration(full20) : retention);
    const opened = await openStorage(dbPath, both, 'selected-migration-22', 'selected-migration-23');
    try { assert.deepEqual(readHistory(opened.db), history(both));
      assert.equal(opened.migrationBackups.length, direction === 'retention-after-load' ? 2 : 1);
      assert.deepEqual(opened.db.pragma('foreign_key_check'), []);
    } finally { opened.db.close(); }
    const reopened = await openStorage(dbPath, both, 'selected-migration-22', 'selected-migration-23');
    try { assert.deepEqual(readHistory(reopened.db), history(both)); assert.equal(reopened.migrationBackups.length, 0); }
    finally { reopened.db.close(); }
  }
}));

test('23 never auto-selects22 or accepts undeclared23; bad history and raw tables fail before migration effects', () => scratch(async root => {
  const path = join(root, 'retention.sqlite'); seed(path, full21);
  const opened = await openStorage(path, retention, undefined, 'selected-migration-23');
  try { assert.deepEqual(readHistory(opened.db), history(retention));
    assert.equal(opened.db.prepare('SELECT 1 FROM form_migrations WHERE version=22').get(), undefined);
  } finally { opened.db.close(); }
  await assert.rejects(openStorage(path, retention));
  await assert.rejects(openStorage(path, both, undefined, 'selected-migration-23'));
  for (const failure of ['checksum', 'unknown-history', 'missing-prerequisite', 'raw-tables']) {
    const dbPath = join(root, failure + '.sqlite'); seed(dbPath, full21, db => {
      if (failure === 'checksum') db.prepare('UPDATE form_migrations SET checksum=? WHERE version=20').run('0'.repeat(64));
      if (failure === 'unknown-history') db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(24, hash('SELECT 1;'), 'synthetic');
      if (failure === 'missing-prerequisite') db.prepare('DELETE FROM form_migrations WHERE version=10').run();
      if (failure === 'raw-tables') db.exec(sourceManualRetentionMigration.sql);
    });
    const before = new Database(dbPath);
    const snapshot = { history: before.prepare('SELECT * FROM form_migrations').all(), schema: before.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all() };
    before.close();
    await assert.rejects(openStorage(dbPath, retention, undefined, 'selected-migration-23'));
    const after = new Database(dbPath);
    try { assert.deepEqual(after.prepare('SELECT * FROM form_migrations').all(), snapshot.history);
      assert.deepEqual(after.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), snapshot.schema);
    } finally { after.close(); }
  }
}));

test('23 migration failure rolls back all new tables and receipt atomically', () => scratch(async root => {
  const dbPath = join(root, 'rollback.sqlite'); seed(dbPath, full21);
  const db: Sqlite = new Database(dbPath); db.pragma('foreign_keys=ON');
  try {
    db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON form_migrations WHEN NEW.version=23 BEGIN SELECT RAISE(ABORT,'synthetic migration rollback'); END;");
    await assert.rejects(migrate(db, dbPath, retention, undefined, 'selected-migration-23'), /synthetic migration rollback/);
    assert.deepEqual(readHistory(db), history(full21));
    for (const table of manualRetentionOwnedTables) assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table), undefined);
  } finally { db.close(); }
}));

const origin = 'http://127.0.0.1:47849';
const input = { kind: 'weight', value: 100, unit: 'lb', measuredOn: '2026-10-10' };
const g = (decisionId = randomUUID()) => ({ decisionId, processing: 'manual_entry', purpose: 'personal_measurement_progress', choice: 'retain',
  statementId: 'manual-personal-progress', statementVersion: 1, statementSha256: MANUAL_RETENTION_STATEMENT_SHA256 });
const config = (dbPath: string): ServerConfig => ({ dbPath, baseURL: origin, secret: 'synthetic-body-retention-secret-over-32-characters',
  moduleMigrations, sourceRequestFactories: requestConfiguration, sourceAccountModules: fullConfiguration,
  sourceBodyMeasurements: createManualMeasurements, sourceManualRetention: 'selected-migration-23', lifecycle: { ledger: suppressionLedger().ledger },
  registration: { mode: 'allowlist', emails: ['retention@synthetic.invalid'] } });
function client(server: FormServer) {
  return async (path: string, token?: string, value?: unknown, key = 'synthetic', authority?: string) => {
    const response = await server.handleRequest(new Request(origin + path, { method: value === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', 'idempotency-key': key,
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(authority ? { 'X-Form-Manual-Retention': authority } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), '192.0.2.49');
    const text = await response.text(); return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, text };
  };
}

test('actual authenticated server owns selected23 controls, survives restart and rechecks session after body await', () => scratch(async root => {
  const dbPath = join(root, 'server.sqlite'); seed(dbPath, full21);
  const configuration = config(dbPath); let server = await createServer(configuration);
  try {
    let request = client(server);
    const signup = await request('/api/auth/sign-up/email', undefined, { name: 'Synthetic retention', email: 'retention@synthetic.invalid', password: 'Synthetic-retention-password-12345' });
    assert.equal(signup.status, 200, signup.text); const token = signup.headers.get('set-auth-token'); assert.ok(token);
    const me = await request('/v1/me', token); assert.equal(me.status, 200, me.text);
    const capability = await request('/v1/body/capabilities', token);
    assert.ok(captureManualRetentionCapability(capability.body.manualRetention));
    assert.equal(capability.body.manualRetention.status, 'available');
    assert.deepEqual(capability.body.manualRetention.statement, MANUAL_RETENTION_STATEMENT_BINDING);
    const grant = g(); const createdGrant = await request('/v1/body/manual-retention', token, grant, 'grant');
    assert.equal(createdGrant.status, 200, createdGrant.text);
    const header = formatManualRetentionHeader({ protocol: MANUAL_RETENTION_PROTOCOL, decisionId: grant.decisionId, revision: 1, statementSha256: MANUAL_RETENTION_STATEMENT_SHA256 })!;
    assert.equal((await request('/v1/body/measurements', token, input, 'absent')).status, 403);
    const saved = await request('/v1/body/measurements', token, input, 'save', header); assert.equal(saved.status, 201, saved.text);
    assert.equal(saved.body.value, 45.359237);
    await server.close(); server = await createServer(configuration); request = client(server);
    assert.equal(server.migrationBackups.length, 0);
    const revoked = await request(`/v1/body/manual-retention/${grant.decisionId}/revoke`, token, {}, 'revoke'); assert.equal(revoked.status, 200);
    const old = await request('/v1/body/manual-retention', token, grant, 'grant');
    assert.deepEqual(old.body.receipt, createdGrant.body.receipt); assert.equal(old.body.current.state, 'revoked');
    assert.deepEqual((await request('/v1/body/measurements', token, input, 'save')).body, saved.body);
    assert.equal((await request('/v1/body/measurements', token, input, 'new', header)).status, 403);
    assert.equal((await request(`/v1/body/measurements/${saved.body.id}/delete`, token, {}, 'delete')).status, 200);
    assert.equal((await request('/v1/body/measurements', token, input, 'save')).status, 404);
    const bytes = new TextEncoder().encode(JSON.stringify(g()));
    let streamController!: ReadableStreamDefaultController<Uint8Array>, admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; }, pull() { admitted(); } }, { highWaterMark: 0 });
    const pending = Promise.resolve(server.handleRequest(new Request(origin + '/v1/body/manual-retention', {
      method: 'POST', body: stream, duplex: 'half', headers: { origin, authorization: `Bearer ${token}`,
        'content-type': 'application/json', 'content-length': String(bytes.byteLength), 'idempotency-key': 'paused' },
    } as RequestInit & { duplex: 'half' }), '192.0.2.49'));
    void pending.catch(() => {});
    try {
      await Promise.race([admission, pending.then(response => { throw new Error(`Unexpected early response: ${response.status}`); })]);
      server.db.prepare('DELETE FROM session WHERE userId=(SELECT auth_user_id FROM form_accounts WHERE id=?)').run(me.body.accountId);
      streamController.enqueue(bytes); streamController.close(); assert.equal((await pending).status, 401);
    } finally { try { streamController.error(new Error('Synthetic stream cleanup')); } catch {} await pending.catch(() => {}); }
    assert.equal((server.db.prepare('SELECT count(*) n FROM body_manual_retention_decisions').get() as { n: number }).n, 1);
  } finally { if (server.db.open) await server.close(false); }
}));

test('explicit23 rejects fake factories and incomplete configuration before storage effects', () => scratch(async root => {
  for (const [name, modify] of [
    ['wrapper', (c: ServerConfig) => ({ ...c, sourceBodyMeasurements: (db: Sqlite, bindings: Parameters<typeof createManualMeasurements>[1]) => createManualMeasurements(db, bindings) })],
    ['partial', (c: ServerConfig) => ({ ...c, sourceAccountModules: { mode: 'source-only', modules: 'usage-and-bug-intake' } })],
    ['missing-factory', (c: ServerConfig) => { const { sourceBodyMeasurements: _unused, ...rest } = c; return rest; }],
  ] as const) {
    const dbPath = join(root, name + '.sqlite');
    await assert.rejects(createServer(modify(config(dbPath)) as ServerConfig)); assert.equal(existsSync(dbPath), false);
  }
}));
