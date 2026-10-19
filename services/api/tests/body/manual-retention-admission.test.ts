import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createManualMeasurements } from '../../src/body/measurements.js';
import { createBodyMeasurementRoutes } from '../../src/body/routes.js';
import { DomainError } from '../../src/errors.js';
import { hash } from '../../src/storage.js';
import { appendSourceBodyMeasurementMigration, selectAccountModuleMigrations } from '../../src/integration/account-modules/migrations.js';
import { fixture, baseMigrations } from '../integration/account-modules/fixture.js';

// This check imports only pre-existing source APIs and can run unchanged before and after N1 producer intake.
test('legacy HTTP receipts replay but a new manual save requires explicit retention authority', async t => {
  const f = fixture(); t.after(f.close);
  const selected = appendSourceBodyMeasurementMigration(selectAccountModuleMigrations({ mode: 'source-only',
    modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, baseMigrations));
  for (const migration of selected.filter(entry => entry.version > 16)) {
    f.db.exec(migration.sql);
    f.db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
  }
  const service = createManualMeasurements(f.db, f.bindings), app = new Hono();
  app.onError((error, c) => c.json({ code: error instanceof DomainError ? error.code : 'unexpected' }, error instanceof DomainError ? error.status : 500));
  app.route('/v1/body/measurements', createBodyMeasurementRoutes({ context: () => f.one, serviceFor: () => service }));
  const input = { kind: 'waist', value: 30, unit: 'in', measuredOn: '2026-10-10' }, id = randomUUID();
  f.db.prepare('INSERT INTO body_manual_measurements VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, f.one.accountId, 'waist', 76.2, 'cm', 'in', input.measuredOn, null, 'synthetic');
  f.db.prepare('INSERT INTO body_manual_receipts VALUES(?,?,?,?,?)').run(f.one.accountId, 'legacy',
    createHash('sha256').update(JSON.stringify({ operation: 'create', input })).digest('hex'), id, 'create');
  const request = (key: string) => app.request('/v1/body/measurements', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(input) });
  const replay = await request('legacy'); assert.equal(replay.status, 201);
  assert.equal((await replay.json() as { id: string }).id, id);
  const denied = await request('new-without-authority'); assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { code: string }).code, 'body_manual_retention_required');
  assert.equal((f.db.prepare('SELECT count(*) n FROM body_manual_measurements').get() as { n: number }).n, 1);
});
