import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createServer, type FormServer, type ServerConfig } from '../../src/server.js';
import { createManualMeasurements, manualMeasurementMigrationSql, type ManualMeasurements, type ManualMeasurement } from '../../src/body/measurements.js';
import { sourceManualRetentionMigration } from '../../src/body/manual-retention-migration.js';
import { formatManualRetentionHeader } from '../../src/body/manual-retention-contract.js';
import { manualRetentionGrant, manualRetentionAttempt, seedHistoricalMeasurement } from '../body/manual-retention-fixture.js';
import { AccountLifecycle, lifecyclePolicy } from '../../src/lifecycle/service.js';
import { buildAccountExport } from '../../src/lifecycle/export.js';
import { lifecycleMigration } from '../../src/lifecycle/migration.js';
import type { AccountContext } from '../../src/lifecycle/types.js';
import { selectAccountModuleMigrations } from '../../src/integration/account-modules/migrations.js';
import type { RuntimeOwner } from '../../src/runtime-modules/admission.js';
import { hash, migrations, type Migration, type Sqlite } from '../../src/storage.js';
import { baseMigrations, moduleMigrations, requestConfiguration, suppressionLedger,
  fixture as accountFixture, install } from './account-modules/fixture.js';

const origin = 'http://127.0.0.1:47839';
const secret = 'synthetic-numbered-body-server-secret-over-32-characters';
const password = 'Synthetic-numbered-body-password-12345';
const measurements = '/v1/body/measurements';
const fullSelection = { mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' } as const;
const partialSelections = [
  { mode: 'source-only', modules: 'usage-and-bug-intake' },
  { mode: 'source-only', modules: 'usage-bug-and-training-feedback' },
  { mode: 'source-only', modules: 'usage-bug-training-feedback-and-source-prescription' },
] as const;
const full20 = selectAccountModuleMigrations(fullSelection, baseMigrations);
const expectedBodyMigration: Migration = { version: 21, sql: manualMeasurementMigrationSql };
const bodyTables = ['body_manual_measurements', 'body_manual_receipts'] as const;
const waist = { kind: 'waist', value: 30, unit: 'in', measuredOn: '2026-10-10', note: 'Synthetic original account' };

// These fixtures supply synthetic accounts, active rows and suppression evidence; numbered SQL grants no retention or purge authority.
async function withScratch(run: (f: {
  root: string; dbPath: string;
  seed(selected: readonly Migration[], mutate?: (db: Sqlite) => void): void;
  open(config: ServerConfig): Promise<FormServer>;
  close(server: FormServer): Promise<void>;
}) => Promise<void>) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'body-numbered-')), dbPath = join(root, 'synthetic.sqlite');
  const servers = new Set<FormServer>();
  let cleanupResult: Promise<void> | undefined;
  const cleanup = () => cleanupResult ??= (async () => {
    const failures: unknown[] = [];
    for (const server of servers) if (server.db.open) {
      try { await server.close(false); } catch (error) { failures.push(error); }
    }
    try { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Exact numbered Body scratch cleanup failed');
  })();
  const interrupt = () => { void cleanup().then(() => process.exit(130), error => { process.stderr.write(String(error)); process.exit(130); }); };
  const terminate = () => { void cleanup().then(() => process.exit(143), error => { process.stderr.write(String(error)); process.exit(143); }); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  let failure: unknown, failed = false;
  try {
    await run({ root, dbPath,
      seed(selected, mutate) {
        const db: Sqlite = new Database(dbPath);
        try { install(db, selected); mutate?.(db); } finally { db.close(); }
      },
      async open(config) { const server = await createServer(config); servers.add(server); return server; },
      async close(server) { if (server.db.open) await server.close(); },
    });
  } catch (error) { failure = error; failed = true; }
  finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    try { await cleanup(); } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Numbered Body test failed and exact scratch cleanup failed');
      throw error;
    }
  }
  if (failed) throw failure;
}
function configuration(dbPath: string, body = true, authority = suppressionLedger()) {
  const state = { factories: 0, rawPurges: 0, body: null as ManualMeasurements | null };
  const factory: NonNullable<ServerConfig['sourceBodyMeasurements']> = (db, bindings) => {
    state.factories++;
    const service = createManualMeasurements(db, bindings), raw = service.lifecycleAdapter;
    const measured = { ...service, lifecycleAdapter: { ...raw,
      purge(requestId: string, accountId: string) { state.rawPurges++; return raw.purge(requestId, accountId); },
    } };
    state.body = measured; return measured;
  };
  const config: ServerConfig = { dbPath, baseURL: origin, secret,
    registration: { mode: 'allowlist', emails: ['one@synthetic.invalid', 'two@synthetic.invalid'] },
    lifecycle: { ledger: authority.ledger }, moduleMigrations, sourceRequestFactories: requestConfiguration,
    sourceAccountModules: fullSelection, ...(body ? { sourceBodyMeasurements: factory } : {}),
  };
  return { config, state, authority };
}
function client(server: FormServer) {
  const request = async (path: string, token?: string, value?: unknown, key = 'synthetic-body-key', authority?: string) => {
    const response = await server.handleRequest(new Request(origin + path, { method: value === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', 'idempotency-key': key,
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(authority ? { 'X-Form-Manual-Retention': authority } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), '192.0.2.39');
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, text };
  };
  const signup = async (name: 'one' | 'two') => {
    const registered = await request('/api/auth/sign-up/email', undefined, { name, email: `${name}@synthetic.invalid`, password });
    assert.equal(registered.status, 200, registered.text);
    const token = registered.headers.get('set-auth-token'); assert.ok(token);
    const initialized = await request('/v1/me', token); assert.equal(initialized.status, 200, initialized.text);
    const row = server.db.prepare('SELECT f.auth_user_id AS authUserId,s.id AS sessionId FROM form_accounts f JOIN session s ON s.userId=f.auth_user_id WHERE f.id=?')
      .get(initialized.body.accountId) as { authUserId: string; sessionId: string };
    return { token, actor: { accountId: initialized.body.accountId as string, ...row, epoch: 0 } satisfies AccountContext };
  };
  return { request, signup };
}
function installed(db: Sqlite, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function assertNumberedBody(server: FormServer, selectedRetention = false) {
  const rows = server.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as { version: number; checksum: string }[];
  assert.deepEqual(rows, [...full20, expectedBodyMigration, ...(selectedRetention ? [sourceManualRetentionMigration] : [])].map(value => ({ version: value.version, checksum: hash(value.sql) })));
  for (const table of bodyTables) assert.equal(installed(server.db, table), true, table);
  assert.deepEqual(server.db.prepare("PRAGMA index_info('body_manual_account_date')").all().map(row => (row as { name: string }).name),
    ['account_id', 'measured_on', 'id']);
  for (const table of bodyTables) {
    const keys = server.db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as { table: string; from: string; to: string }[];
    assert.ok(keys.some(key => key.table === 'form_accounts' && key.from === 'account_id' && key.to === 'id'));
  }
  assert.equal(server.db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(server.db.pragma('foreign_key_check'), []);
}
function bodyRows(db: Sqlite) {
  return bodyTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY account_id,rowid`).all()]);
}
function storeSnapshot(dbPath: string) {
  const db: Sqlite = new Database(dbPath, { readonly: true });
  try {
    return { history: db.prepare('SELECT * FROM form_migrations ORDER BY version').all(),
      schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      data: bodyTables.filter(table => installed(db, table)).map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
      markers: installed(db, 'synthetic_body_marker') ? db.prepare('SELECT * FROM synthetic_body_marker').all() : [] };
  } finally { db.close(); }
}
function seedRetainedBodyRows(db: Sqlite) {
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)')
    .run('synthetic-retained-user', 'Synthetic retained member', 'retained@synthetic.invalid', 1, 1);
  db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run('synthetic-retained-account', 'synthetic-retained-user', 'synthetic');
  if (installed(db, 'body_manual_measurements')) db.prepare('INSERT INTO body_manual_measurements VALUES(?,?,?,?,?,?,?,?,?)')
    .run('synthetic-retained-measurement', 'synthetic-retained-account', 'waist', 76.2, 'cm', 'in', '2026-10-10', 'Synthetic retained original', 'synthetic');
  if (installed(db, 'body_manual_receipts')) db.prepare('INSERT INTO body_manual_receipts VALUES(?,?,?,?,?)')
    .run('synthetic-retained-account', 'synthetic-retained-key', 'a'.repeat(64), 'synthetic-retained-measurement', 'create');
}

for (const selectedRetention of [false, true]) test(selectedRetention
  ? 'genuine selected23 grants preserve two-account new CRUD and unit conversion across reopen'
  : 'genuine numbered21 wrapper preserves two-account historical rows receipts and deletion across reopen', () => withScratch(async f => {
  f.seed(baseMigrations); const source = configuration(f.dbPath), { state } = source;
  const config: ServerConfig = selectedRetention ? { ...source.config, sourceBodyMeasurements: createManualMeasurements,
    sourceManualRetention: 'selected-migration-23' } : source.config;
  const server = await f.open(config);
  assertNumberedBody(server, selectedRetention); assert.equal(state.factories, selectedRetention ? 0 : 1);
  assert.equal(server.migrationBackups.length, selectedRetention ? 6 : 5); assert.ok(server.migrationBackups.every(path => path.startsWith(f.root + '/')));
  const c = client(server), one = await c.signup('one'), two = await c.signup('two');
  const authorities = new Map<string, string>();
  if (selectedRetention) for (const member of [one, two]) {
    const payload = manualRetentionGrant();
    const granted = await c.request('/v1/body/manual-retention', member.token, payload, 'retention-grant');
    assert.equal(granted.status, 200, granted.text);
    authorities.set(member.token, formatManualRetentionHeader(manualRetentionAttempt(payload.decisionId))!);
  }
  const save = async (member: typeof one, input: unknown, key: string, canonical: Pick<ManualMeasurement, 'value' | 'unit'>) => {
    if (!selectedRetention) seedHistoricalMeasurement(server.db, member.actor.accountId, input, key, canonical);
    return c.request(measurements, member.token, input, key, authorities.get(member.token));
  };
  const capability = await c.request('/v1/body/capabilities', one.token);
  assert.equal(capability.body.manualRetention.status, selectedRetention ? 'available' : 'unavailable');
  assert.equal(capability.body.operations.save_manual_measurement.status, selectedRetention ? 'available' : 'unavailable');
  assert.equal(capability.body.operations.list_progress.status, 'available');
  assert.equal((await c.request(measurements, one.token, waist, 'missing-authority')).status, 403);
  assert.equal(capability.body.retainedMeasurements.status, 'available');
  for (const feature of ['photoUpload', 'inference', 'accountDeletion', 'externalProvider']) assert.equal(capability.body[feature].status, 'unavailable');
  assert.equal(capability.body.strictNoSave.nativeZeroPersistenceVerified, false);
  const first = await save(one, waist, 'shared-create', { value: 76.2, unit: 'cm' });
  assert.equal(first.status, 201, first.text); assert.equal(first.body.value, 76.2); assert.equal(first.body.unit, 'cm');
  assert.equal(first.body.originalUnit, 'in'); assert.equal(first.body.provenance, 'manual_reported');
  assert.deepEqual((await c.request(measurements, one.token, waist, 'shared-create')).body, first.body);
  assert.equal((await c.request(measurements, one.token, { ...waist, value: 31 }, 'shared-create')).status, 409);
  const kg = await save(one, { kind: 'weight', value: 80, unit: 'kg', measuredOn: '2026-10-11' }, 'kg', { value: 80, unit: 'kg' });
  assert.equal(kg.status, 201); assert.equal(kg.body.value, 80); assert.equal(kg.body.originalUnit, 'kg'); assert.equal(kg.body.unit, 'kg');
  const pounds = await save(two, { kind: 'weight', value: 100, unit: 'lb', measuredOn: '2026-10-11', note: 'Synthetic second account' }, 'shared-create', { value: 45.359237, unit: 'kg' });
  assert.equal(pounds.status, 201); assert.equal(pounds.body.value, 45.359237); assert.equal(pounds.body.unit, 'kg'); assert.equal(pounds.body.originalUnit, 'lb');
  assert.deepEqual((await c.request(measurements, two.token)).body, { items: [pounds.body] });
  assert.equal((await c.request(`${measurements}/${first.body.id}/delete`, two.token, {}, 'foreign-delete')).status, 404);
  const cm = await save(one, { kind: 'hips', value: 90, unit: 'cm', measuredOn: '2026-10-12' }, 'cm', { value: 90, unit: 'cm' });
  assert.equal(cm.status, 201); assert.equal(cm.body.value, 90); assert.equal(cm.body.unit, 'cm'); assert.equal(cm.body.originalUnit, 'cm');
  const rows = bodyRows(server.db), history = server.db.prepare('SELECT * FROM form_migrations ORDER BY version').all();
  await f.close(server); const restarted = await f.open(config), next = client(restarted);
  assertNumberedBody(restarted, selectedRetention); assert.deepEqual(restarted.migrationBackups, []); assert.equal(state.factories, selectedRetention ? 0 : 2);
  assert.deepEqual(bodyRows(restarted.db), rows); assert.deepEqual(restarted.db.prepare('SELECT * FROM form_migrations ORDER BY version').all(), history);
  assert.deepEqual((await next.request(measurements, one.token, waist, 'shared-create')).body, first.body);
  assert.deepEqual((await next.request(measurements, two.token)).body, { items: [pounds.body] });
  assert.equal((await next.request(`${measurements}/${first.body.id}/delete`, one.token, {}, 'delete')).status, 200);
  assert.equal((await next.request(`${measurements}/${first.body.id}/delete`, one.token, {}, 'delete')).status, 200);
  assert.equal((await next.request(measurements, one.token, waist, 'shared-create')).status, 404);
  assert.equal(state.rawPurges, 0);
}));

test('partial16 18 and19 source Body configurations reject before storage or factory effects', async t => {
  for (const selection of partialSelections) await t.test(selection.modules, () => withScratch(async f => {
    const { config, state } = configuration(f.dbPath);
    let rejected: unknown;
    try { await f.open({ ...config, sourceAccountModules: selection }); } catch (error) { rejected = error; }
    assert.equal(existsSync(f.dbPath), false, 'Partial source Body selection opened storage');
    assert.equal(existsSync(join(f.root, 'backups')), false); assert.equal(state.factories, 0);
    assert.ok(rejected, 'Partial source Body selection must reject');
    assert.deepEqual(readdirSync(f.root), []);
  }));
});

test('malformed genuine-prefix inputs fail before opening numbered Body storage', async t => {
  for (const kind of ['changed-activity', 'missing-additions'] as const) await t.test(kind, () => withScratch(async f => {
    const { config, state } = configuration(f.dbPath);
    const changed = kind === 'changed-activity' ? { ...moduleMigrations, activity: { ...moduleMigrations.activity, sql: moduleMigrations.activity.sql + '\nSELECT 1;' } } :
      { activity: moduleMigrations.activity, community: moduleMigrations.community };
    await assert.rejects(f.open({ ...config, moduleMigrations: changed }));
    assert.equal(existsSync(f.dbPath), false); assert.equal(state.factories, 0); assert.deepEqual(readdirSync(f.root), []);
  }));
});

test('numbered Body rejects conflicting21 history and raw pre-existing tables without adopting data or rewriting history', async t => {
  for (const kind of ['collision21', 'checksum21', 'checksum20', 'raw-body', 'raw-measurements', 'raw-receipts'] as const) await t.test(kind, () => withScratch(async f => {
    f.seed(full20, db => {
      db.exec('CREATE TABLE synthetic_body_marker(value TEXT NOT NULL)');
      db.prepare('INSERT INTO synthetic_body_marker VALUES(?)').run('Synthetic history must survive failed admission');
      if (kind === 'collision21') db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(21, hash('SELECT 1;'), 'synthetic-collision');
      if (kind === 'checksum21') { db.exec(manualMeasurementMigrationSql); db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(21, 'a'.repeat(64), 'synthetic-wrong-checksum'); }
      if (kind === 'checksum20') db.prepare('UPDATE form_migrations SET checksum=? WHERE version=20').run('a'.repeat(64));
      if (kind.startsWith('raw-')) {
        db.exec(manualMeasurementMigrationSql);
        if (kind === 'raw-measurements') db.exec('DROP TABLE body_manual_receipts');
        if (kind === 'raw-receipts') db.exec('DROP TABLE body_manual_measurements');
      }
      seedRetainedBodyRows(db);
    });
    const before = storeSnapshot(f.dbPath), { config, state } = configuration(f.dbPath);
    await assert.rejects(f.open(config));
    assert.deepEqual(storeSnapshot(f.dbPath), before); assert.equal(state.factories, 0);
  }));
});

test('ordinary default and genuine full20 without Body retain their existing migration histories and absent Body tables', async t => {
  for (const kind of ['default', 'full20'] as const) await t.test(kind, () => withScratch(async f => {
    const source = configuration(f.dbPath, false);
    const config: ServerConfig = kind === 'default' ? { dbPath: f.dbPath, baseURL: origin, secret } : source.config;
    const server = await f.open(config);
    assert.equal((server.db.prepare('SELECT max(version) n FROM form_migrations').get() as { n: number }).n, kind === 'default' ? 7 : 20);
    for (const table of bodyTables) assert.equal(installed(server.db, table), false);
    assert.equal(server.lifecycle?.adapters.some(adapter => adapter.category === 'body') ?? false, false);
    assert.equal(source.state.factories, 0);
  }));
});

test('legacy raw-seeded Body factory without account-module selection is preserved without claiming numbered21', () => withScratch(async f => {
  f.seed(migrations, db => { db.exec(lifecycleMigration.sql); db.exec(manualMeasurementMigrationSql); });
  const authority = suppressionLedger();
  const server = await f.open({ dbPath: f.dbPath, baseURL: origin, secret, lifecycle: { ledger: authority.ledger }, sourceBodyMeasurements: createManualMeasurements });
  assert.equal(server.sourceAccountModules, undefined);
  assert.equal((server.db.prepare('SELECT max(version) n FROM form_migrations').get() as { n: number }).n, 7);
  for (const table of bodyTables) assert.equal(installed(server.db, table), true);
  assert.equal(server.lifecycle?.adapters.filter(adapter => adapter.category === 'body').length, 1);
}));

test('either exact retained Body table requires a Body lifecycle adapter and unrelated names do not claim coverage', async t => {
  for (const table of bodyTables) await t.test(table, t => {
    const f = accountFixture(); t.after(() => { if (f.db.open) f.close(); });
    f.db.exec(manualMeasurementMigrationSql);
    f.db.exec(`DROP TABLE ${table === 'body_manual_measurements' ? 'body_manual_receipts' : 'body_manual_measurements'}`);
    const before = f.db.prepare('SELECT * FROM form_migrations ORDER BY version').all();
    assert.throws(() => new AccountLifecycle(f.db, [...f.existing.adapters, ...f.modules.adapters], f.ledger), { code: 'lifecycle_adapter_required' });
    assert.equal(installed(f.db, table), true); assert.deepEqual(f.db.prepare('SELECT * FROM form_migrations ORDER BY version').all(), before);
  });
  await t.test('unrelated-body-name', t => {
    const f = accountFixture(); t.after(() => { if (f.db.open) f.close(); });
    f.db.exec('CREATE TABLE body_manual_measurements_archive(value TEXT)');
    assert.doesNotThrow(() => new AccountLifecycle(f.db, [...f.existing.adapters, ...f.modules.adapters], f.ledger));
  });
});

test('numbered Body server uses guarded inventory export and ledger-proved original-account suppression with purge unavailable', () => withScratch(async f => {
  f.seed(baseMigrations); const { config, state, authority } = configuration(f.dbPath), server = await f.open(config);
  assertNumberedBody(server);
  const c = client(server), one = await c.signup('one'), two = await c.signup('two');
  seedHistoricalMeasurement(server.db, one.actor.accountId, waist, 'one', { value: 76.2, unit: 'cm' });
  const first = await c.request(measurements, one.token, waist, 'one');
  const secondInput = { kind: 'weight', value: 90, unit: 'kg', measuredOn: '2026-10-10', note: 'Synthetic account B must remain' };
  seedHistoricalMeasurement(server.db, two.actor.accountId, secondInput, 'two', { value: 90, unit: 'kg' });
  const second = await c.request(measurements, two.token, secondInput, 'two');
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const lifecycle = server.lifecycle!; assert.ok(lifecycle);
  const adapter = lifecycle.adapters.find(value => value.category === 'body')!; assert.ok(adapter);
  assert.equal(lifecycle.adapters.filter(value => value.category === 'body').length, 1);
  assert.deepEqual(adapter.inventory(one.actor), { category: 'body', status: 'complete', count: 2 });
  assert.throws(() => adapter.inventory({ ...one.actor, sessionId: two.actor.sessionId }), { code: 'account_session_invalid' });
  const exported = buildAccountExport(server.db, one.actor, actor => lifecycle.assertActive(actor), [adapter]);
  const exportManifest = JSON.parse(exported.json).manifest as { categories: { category: string; status: string; reason: string }[] };
  assert.equal(exportManifest.categories.find(entry => entry.category === 'body')?.status, 'unavailable');
  assert.equal(exportManifest.categories.find(entry => entry.category === 'body')?.reason, 'manual_retention_metadata_omitted');
  assert.ok(exported.json.includes(first.body.id)); assert.equal(exported.json.includes(second.body.id), false);
  assert.equal(exported.json.includes('Synthetic account B must remain'), false); assert.equal(server.db.inTransaction, false);
  const before = bodyRows(server.db);
  assert.throws(() => adapter.suppress(one.actor.accountId, 1), { code: 'canonical_writer_unproved' });
  assert.throws(() => server.db.transaction(() => adapter.suppress(one.actor.accountId, 1)).immediate(), { code: 'canonical_writer_unproved' });
  assert.deepEqual(adapter.purge('synthetic-unqualified-purge', one.actor.accountId), { status: 'unavailable', reason: 'exact_purge_executor_binding_required' });
  assert.equal(state.rawPurges, 0); assert.deepEqual(bodyRows(server.db), before);
  const requestId = randomUUID(), grant = 'g'.repeat(43);
  lifecycle.initiate(one.actor, 'synthetic-body-disable', { requestId, policyVersion: lifecyclePolicy,
    confirmation: 'delete_whole_account', statusSecret: 's'.repeat(43) });
  server.db.prepare('INSERT INTO account_action_grants VALUES(?,?,?,?,?,?,?,?,NULL)').run(hash(grant), one.actor.accountId,
    one.actor.sessionId, one.actor.epoch, 'account_delete', 'password', Date.now(), Date.now() + 600000);
  const disabled = lifecycle.confirm(one.actor, requestId, { grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' });
  assert.equal(disabled.disabled, true); assert.equal(disabled.complete, false);
  const proof = authority.records.get(one.actor.accountId)!; assert.ok(proof); assert.equal(proof.epoch, 1);
  assert.equal(authority.records.has(two.actor.accountId), false);
  assert.deepEqual(server.db.prepare('SELECT state,epoch,suppression_seq FROM account_lifecycle WHERE account_id=?').get(one.actor.accountId),
    { state: 'disabled', epoch: 1, suppression_seq: proof.sequence });
  assert.deepEqual(server.db.prepare('SELECT state,epoch FROM account_lifecycle WHERE account_id=?').get(two.actor.accountId), { state: 'active', epoch: 0 });
  for (const table of bodyTables) assert.equal((server.db.prepare(`SELECT count(*) n FROM ${table} WHERE account_id=?`).get(one.actor.accountId) as { n: number }).n, 0);
  assert.equal(server.db.prepare('SELECT id FROM session WHERE id=?').get(one.actor.sessionId), undefined);
  assert.ok(server.db.prepare('SELECT id FROM session WHERE id=?').get(two.actor.sessionId));
  server.db.transaction(() => {
    assert.equal(adapter.verifySuppressed(one.actor.accountId, 1).status, 'complete');
    assert.throws(() => adapter.verifySuppressed(one.actor.accountId, 2), { code: 'canonical_writer_unproved' });
  }).immediate();
  assert.deepEqual((await c.request(measurements, two.token)).body, { items: [second.body] });
  assert.equal((await c.request(measurements, one.token)).status, 401);
  assert.deepEqual(adapter.purge(requestId, one.actor.accountId), { status: 'unavailable', reason: 'exact_purge_executor_binding_required' });
  assert.equal(state.rawPurges, 0);
}));

test('existing numbered21 rejects restart with Body omitted and preserves its data and migration history', () => withScratch(async f => {
  f.seed([...full20, expectedBodyMigration], seedRetainedBodyRows);
  const { config, state } = configuration(f.dbPath, false), before = storeSnapshot(f.dbPath);
  await assert.rejects(f.open(config)); assert.deepEqual(storeSnapshot(f.dbPath), before); assert.equal(state.factories, 0);
}));

test('runtime ownership still rejects source Body injection before opening storage', () => withScratch(async f => {
  let closed = 0;
  const runtimeOwner = { close(clean: boolean) { assert.equal(clean, false); closed++; } } as unknown as RuntimeOwner;
  await assert.rejects(f.open({ dbPath: f.dbPath, baseURL: origin, secret, runtimeOwner, sourceBodyMeasurements: createManualMeasurements }),
    /Runtime ownership cannot mix source injections/);
  assert.equal(closed, 1); assert.equal(existsSync(f.dbPath), false); assert.deepEqual(readdirSync(f.root), []);
}));
