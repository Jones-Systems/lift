import { migrations } from '../../src/storage.js';
import { Domain } from '../../src/domain.js';
import { assertActive, withActiveWrite } from '../../src/lifecycle/guards.js';
import { buildAccountExport } from '../../src/lifecycle/export.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createManualMeasurements, manualMeasurementMigrationSql } from '../../src/body/measurements.js';
import { createBodyMeasurementRoutes } from '../../src/body/routes.js';
import { bodyCapabilities } from '../../src/body/index.js';
import { manualRetentionFixture, seedHistoricalMeasurement } from './manual-retention-fixture.js';
import { formatManualRetentionHeader } from '../../src/body/manual-retention-contract.js';
import { DomainError } from '../../src/errors.js';

test('manual measurement CRUD isolates accounts, canonicalizes units and hard deletes with replay protection', async t => {
  const f = manualRetentionFixture(); t.after(f.close);
  const { db, service, one: a, two: b } = f, authority = f.grantFor(a);
  const retentionHeader = formatManualRetentionHeader(authority)!;
  const app = new Hono(); app.onError((error, c) => error instanceof DomainError ? c.json({ code: error.code }, error.status) : c.json({ code: 'unexpected' }, 500));
  app.route('/v1/body/measurements', createBodyMeasurementRoutes({ context: c => c.req.header('authorization') === 'b' ? b : a, serviceFor: () => service }));
  const request = (path: string, input?: unknown, who = 'a', key = 'create') => app.request('/v1/body/measurements' + path, { method: input === undefined ? 'GET' : 'POST', headers: { authorization: who, 'content-type': 'application/json', 'idempotency-key': key, 'X-Form-Manual-Retention': retentionHeader }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const input = { kind: 'waist', value: 30, unit: 'in', measuredOn: '2026-10-10', note: 'Synthetic note' };
  const created = await request('', input); assert.equal(created.status, 201); const value = await created.json() as { id: string; value: number; unit: string }; assert.equal(value.value, 76.2); assert.equal(value.unit, 'cm');
  assert.deepEqual(await (await request('', input)).json(), value);
  assert.equal((await request('', { ...input, value: 31 })).status, 409);
  assert.equal((await request(`/${value.id}/delete`, {}, 'b', 'delete')).status, 404);
  assert.deepEqual(await (await request('', undefined, 'b')).json(), { items: [] });
  const weight = service.create(a, { kind: 'weight', value: 100, unit: 'lb', measuredOn: '2026-10-10' }, 'weight', authority); assert.equal(weight.value, 45.359237); assert.equal(weight.unit, 'kg');
  assert.throws(() => service.create(a, { ...input, unit: 'kg' }, 'invalid'), { code: 'body_invalid_input' });
  assert.throws(() => service.create(a, { ...input, measuredOn: '2026-02-30' }, 'invalid'), { code: 'body_invalid_input' });
  assert.equal((await request(`/${value.id}/delete`, {}, 'a', 'delete')).status, 200);
  assert.equal((await request(`/${value.id}/delete`, {}, 'a', 'delete')).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM body_manual_measurements WHERE id=?').get(value.id), undefined);
  assert.equal((await request('', input)).status, 404, 'creation receipt cannot resurrect deleted values');
  const exported: unknown[] = []; service.lifecycleAdapter.export(a, { snapshotAtMs: Date.now(), append: (_category, data) => exported.push(data) }); assert.deepEqual(exported, [{ measurements: [weight] }]);
  db.transaction(() => { assert.equal(service.lifecycleAdapter.purge('synthetic', a.accountId).status, 'complete'); assert.equal(service.lifecycleAdapter.verifySuppressed(a.accountId, 1).status, 'complete'); }).immediate();
  assert.equal(service.list(a).items.length, 0);
});

test('body route and capabilities stay unavailable without explicit composition', async () => {
  assert.equal(bodyCapabilities().retainedMeasurements.status, 'unavailable');
  const app = new Hono(); app.onError((error, c) => c.json({}, error instanceof DomainError ? error.status : 500));
  app.route('/measurements', createBodyMeasurementRoutes({ context: () => ({ accountId: 'synthetic', authUserId: 'synthetic', sessionId: 'synthetic', epoch: 0 }) }));
  assert.equal((await app.request('/measurements')).status, 501);
});


test('legacy body lifecycle adapter exports only its account and purges historical measurements and receipts', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  for (const migration of migrations) db.exec(migration.sql);
  db.exec(manualMeasurementMigrationSql); const domain = new Domain(db);
  const contexts = ['one', 'two'].map(name => {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(name, name, `${name}@synthetic.invalid`, Date.now(), Date.now());
    const accountId = domain.account(name, name);
    db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(name, name, `synthetic-${name}`, Date.now() + 600000, Date.now(), Date.now());
    return { accountId, authUserId: name, sessionId: name, epoch: 0 };
  });
  const service = createManualMeasurements(db, { assertActive: actor => assertActive(db, actor), withActiveWrite: (actor, effect) => withActiveWrite(db, actor, effect), adultEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'eligible', profileRevision: 0 }) });
  const first = seedHistoricalMeasurement(db, contexts[0]!.accountId, { kind: 'weight', value: 80, unit: 'kg', measuredOn: '2026-10-10', note: 'Synthetic account one' }, 'measurement', { value: 80, unit: 'kg' });
  const second = seedHistoricalMeasurement(db, contexts[1]!.accountId, { kind: 'weight', value: 90, unit: 'kg', measuredOn: '2026-10-10', note: 'Synthetic account two' }, 'measurement', { value: 90, unit: 'kg' });
  assert.throws(() => service.create(contexts[0]!, { kind: 'weight', value: 80, unit: 'kg', measuredOn: '2026-10-10' }, 'new'), { code: 'body_manual_retention_required' });
  const exported = buildAccountExport(db, contexts[0]!, actor => assertActive(db, actor), [service.lifecycleAdapter]);
  assert.ok(exported.json.includes(first.id)); assert.equal(exported.json.includes(second.id), false); assert.equal(exported.json.includes('Synthetic account two'), false);
  db.transaction(() => service.lifecycleAdapter.purge('synthetic-request', contexts[0]!.accountId)).immediate();
  assert.equal(service.list(contexts[0]!).items.length, 0); assert.equal(service.list(contexts[1]!).items.length, 1);
  assert.equal(db.prepare('SELECT 1 FROM body_manual_receipts WHERE account_id=?').get(contexts[0]!.accountId), undefined);
});
