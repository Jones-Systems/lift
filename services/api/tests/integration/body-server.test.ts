import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createServer, type FormServer, type ServerConfig } from '../../src/server.js';
import { hash, migrations } from '../../src/storage.js';
import { lifecycleMigration } from '../../src/lifecycle/migration.js';
import type { SuppressionLedger } from '../../src/lifecycle/types.js';
import { createManualMeasurements, manualMeasurementMigrationSql } from '../../src/body/measurements.js';
import { formatManualRetentionHeader } from '../../src/body/manual-retention-contract.js';
import { fullBodySourceConfiguration, selectedManualRetentionMigrations, manualRetentionGrant, manualRetentionAttempt, seedHistoricalMeasurement } from '../body/manual-retention-fixture.js';
import { moduleMigrations, requestConfiguration } from './account-modules/fixture.js';

const baseURL = 'http://127.0.0.1:47833';
const emails = ['body-one@synthetic.invalid', 'body-two@synthetic.invalid'];
const input = { kind: 'waist', value: 30, unit: 'in', measuredOn: '2026-10-10' };
const measurements = '/v1/body/measurements';
const ledger: SuppressionLedger = {
  currentSequence: () => 0, lookup: () => null, reconcileRestore: () => 0,
  recordDisable: () => { throw new Error('Synthetic fixture does not issue disable records'); },
};

function client(backend: FormServer) {
  const request = async (path: string, token?: string, value?: unknown, key = 'synthetic-measurement', authority?: string) => {
    const response = await backend.handleRequest(new Request(baseURL + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { origin: baseURL, 'content-type': 'application/json', 'idempotency-key': key,
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(authority ? { 'X-Form-Manual-Retention': authority } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }), '192.0.2.33');
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  };
  const signup = async (email: string) => {
    const response = await request('/api/auth/sign-up/email', undefined, {
      name: 'Synthetic body member', email, password: 'Synthetic-body-server-password-1234',
    });
    assert.equal(response.status, 200, response.text);
    const token = response.headers.get('set-auth-token'); assert.ok(token);
    const initialized = await request('/v1/me', token); assert.equal(initialized.status, 200);
    return { token, accountId: initialized.body.accountId as string };
  };
  return { backend, request, signup };
}

async function fixture(run: (f: ReturnType<typeof client>) => Promise<void>, enabled: boolean | 'retention' = false,
  overrides: Partial<ServerConfig> = {}) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'body-server-'));
  let backend: FormServer | undefined;
  const cleanup = () => { try { if (backend?.db.open) backend.close(); } finally { rmSync(root, { recursive: true, force: true }); } };
  const interrupted = () => { cleanup(); process.exit(130); };
  const terminated = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', terminated);
  try {
    const dbPath = join(root, 'synthetic.sqlite');
    const seed = new Database(dbPath);
    try {
      seed.pragma('foreign_keys = ON');
      seed.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
      for (const migration of enabled === 'retention' ? selectedManualRetentionMigrations.filter(entry => entry.version !== 23) : migrations) {
        seed.exec(migration.sql);
        seed.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
      }
      if (enabled === true) { seed.exec(lifecycleMigration.sql); seed.exec(manualMeasurementMigrationSql); }
    } finally { seed.close(); }
    backend = await createServer({ dbPath, baseURL, secret: 'synthetic-body-server-secret-more-than-32-characters',
      registration: { mode: 'allowlist', emails },
      ...(enabled ? { lifecycle: { ledger }, sourceBodyMeasurements: createManualMeasurements } : {}),
      ...(enabled === 'retention' ? { moduleMigrations, sourceRequestFactories: requestConfiguration,
        sourceAccountModules: fullBodySourceConfiguration, sourceManualRetention: 'selected-migration-23' as const } : {}), ...overrides });
    await run(client(backend));
  } finally {
    process.off('SIGINT', interrupted); process.off('SIGTERM', terminated); cleanup();
  }
}

test('body server defaults to unavailable without creating retained measurement tables', () => fixture(async f => {
  const user = await f.signup(emails[0]!);
  assert.equal((await f.request(measurements)).status, 401);
  const capabilities = await f.request('/v1/body/capabilities', user.token);
  assert.equal(capabilities.body.retainedMeasurements.status, 'unavailable');
  for (const value of [undefined, input]) {
    const response = await f.request(measurements, user.token, value);
    assert.equal(response.status, 501); assert.equal(response.body.error.code, 'body_retention_unavailable');
  }
  assert.equal(f.backend.db.prepare("SELECT name FROM sqlite_master WHERE name='body_manual_measurements'").get(), undefined);
}));

test('genuine selected23 body factory mounts account-scoped manual CRUD and registers its lifecycle adapter', () => fixture(async f => {
  const one = await f.signup(emails[0]!), two = await f.signup(emails[1]!);
  const capabilities = await f.request('/v1/body/capabilities', one.token);
  assert.equal(capabilities.body.retainedMeasurements.status, 'available');
  for (const field of ['photoUpload', 'inference', 'accountDeletion', 'externalProvider'])
    assert.equal(capabilities.body[field].status, 'unavailable', field);
  assert.equal(capabilities.body.strictNoSave.nativeZeroPersistenceVerified, false);
  assert.equal(capabilities.body.manualRetention.status, 'available');
  const grant = manualRetentionGrant();
  assert.equal((await f.request('/v1/body/manual-retention', one.token, grant, 'retention-grant')).status, 200);
  const authority = formatManualRetentionHeader(manualRetentionAttempt(grant.decisionId))!;
  const created = await f.request(measurements, one.token, input, 'synthetic-measurement', authority);
  assert.equal(created.status, 201, created.text); assert.equal(created.body.value, 76.2);
  assert.equal(created.body.unit, 'cm'); assert.equal(created.body.provenance, 'manual_reported');
  assert.deepEqual((await f.request(measurements, one.token, input)).body, created.body);
  assert.deepEqual((await f.request(measurements, two.token)).body, { items: [] });
  const denied = await f.request(`${measurements}/${created.body.id}/delete`, two.token, {}, 'delete');
  assert.equal(denied.status, 404);
  assert.deepEqual((await f.request(measurements, one.token)).body, { items: [created.body] });
  assert.equal(f.backend.lifecycle?.adapters.filter(adapter => adapter.category === 'body').length, 1);
  const removed = await f.request(`${measurements}/${created.body.id}/delete`, one.token, {}, 'delete');
  assert.equal(removed.status, 200); assert.deepEqual((await f.request(measurements, one.token)).body, { items: [] });
  assert.equal((await f.request('/v1/me/account-export', one.token, {})).status, 501);
}, 'retention'));

test('legacy raw Body factory lists deletes and replays historical rows while denying new saves', () => fixture(async f => {
  const one = await f.signup(emails[0]!), two = await f.signup(emails[1]!);
  const saved = seedHistoricalMeasurement(f.backend.db, one.accountId, input, 'legacy', { value: 76.2, unit: 'cm' });
  const capabilities = await f.request('/v1/body/capabilities', one.token);
  assert.equal(capabilities.body.manualRetention.status, 'unavailable');
  assert.equal(capabilities.body.operations.save_manual_measurement.status, 'unavailable');
  assert.equal(capabilities.body.operations.list_progress.status, 'available');
  assert.equal(capabilities.body.operations.delete_assessment.status, 'available');
  assert.equal((f.backend.db.prepare('SELECT max(version) n FROM form_migrations').get() as { n: number }).n, 7);
  assert.deepEqual((await f.request(measurements, one.token, input, 'legacy')).body, saved);
  assert.equal((await f.request(measurements, one.token, input, 'new')).status, 403);
  assert.equal((await f.request(measurements, one.token, { ...input, value: 31 }, 'legacy')).status, 409);
  assert.deepEqual((await f.request(measurements, two.token)).body, { items: [] });
  assert.equal((await f.request(`${measurements}/${saved.id}/delete`, two.token, {}, 'foreign')).status, 404);
  assert.equal((await f.request(`${measurements}/${saved.id}/delete`, one.token, {}, 'delete')).status, 200);
  assert.equal((await f.request(measurements, one.token, input, 'legacy')).status, 404);
}, true));

test('body server preserves authentication, strict inputs, size limit and current-session guards', () => fixture(async f => {
  const user = await f.signup(emails[0]!);
  assert.equal((await f.request(measurements, undefined, input)).status, 401);
  for (const extra of [{ retention: 'no_save' }, { choices: { retention: 'no_save' } }, { accountId: user.accountId }, { ownerId: user.accountId }]) {
    const response = await f.request(measurements, user.token, { ...input, ...extra });
    assert.equal(response.status, 422); assert.equal(response.body.error.code, 'body_invalid_input');
  }
  const oversized = await f.request(measurements, user.token, { ...input, note: 'a'.repeat(4096) });
  assert.equal(oversized.status, 413); assert.equal(oversized.body.error.code, 'body_too_large');
  f.backend.db.prepare('DELETE FROM session WHERE userId=(SELECT auth_user_id FROM form_accounts WHERE id=?)').run(user.accountId);
  assert.equal((await f.request(measurements, user.token, input)).status, 401);
  for (const table of ['body_manual_measurements', 'body_manual_receipts'])
    assert.equal((f.backend.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
}, true));

test('body factory requires lifecycle binding and rejects duplicate adapter registration', async () => {
  await assert.rejects(fixture(async () => {}, false, { sourceBodyMeasurements: createManualMeasurements }),
    { code: 'body_lifecycle_bindings_required' });
  await assert.rejects(fixture(async () => {}, true, { lifecycle: {
    ledger, createAdapters: (db, bindings) => [createManualMeasurements(db, bindings).lifecycleAdapter],
  } }), { code: 'duplicate_module_lifecycle_adapter' });
});

test('body server rechecks the authenticated session after awaiting the measurement payload', () => fixture(async f => {
  const user = await f.signup(emails[0]!);
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { admitted(); } }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half', headers: {
    origin: baseURL, authorization: `Bearer ${user.token}`, 'content-type': 'application/json',
    'content-length': String(bytes.byteLength), 'idempotency-key': 'paused',
  } };
  const result = Promise.resolve(f.backend.handleRequest(new Request(baseURL + measurements, init), '192.0.2.33'));
  void result.catch(() => {});
  try {
    await Promise.race([admission, result.then(response => { throw new Error(`Body request ended before admission: ${response.status}`); })]);
    f.backend.db.prepare('DELETE FROM session WHERE userId=(SELECT auth_user_id FROM form_accounts WHERE id=?)').run(user.accountId);
    controller.enqueue(bytes); controller.close();
    assert.equal((await result).status, 401);
    for (const table of ['body_manual_measurements', 'body_manual_receipts'])
      assert.equal((f.backend.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
  } finally {
    try { controller.error(new Error('Synthetic body request cleanup')); } catch {}
    await result.catch(() => {});
  }
}, true));
