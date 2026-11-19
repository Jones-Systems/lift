import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Domain } from '../../../src/domain.ts';
import { migrations } from '../../../src/storage.ts';
import { lifecycleMigration } from '../../../src/lifecycle/migration.ts';
import { bindSuppressionAuthority } from '../../../src/lifecycle/guards.ts';
import { buildAccountExport } from '../../../src/lifecycle/export.ts';
import { createCanonicalAccountWriter } from '../../../src/integration/account-modules/canonical-writer.ts';
import { createWearablesService } from '../../../src/wearables/service.ts';
import { createWearablePersistence, createWearableLifecycleAdapter, wearablePersistenceSql } from '../../../src/wearables/persistence/index.ts';
import { wearableTables } from '../../../src/wearables/persistence/schema.ts';

const importedAt = '2026-10-11T00:00:00Z';
const cursorMarker = 'synthetic-private-cursor-marker';
const receiptMarker = 'synthetic-private-receipt-marker';
const intentMarker = 'synthetic-private-intent-marker';
const revisionMarker = 'synthetic-private-revision-token';
const omissionReasons = [
  { code: 'credentials', reason: 'credentials_never_exported_auth_state_owned_separately' },
  { code: 'cursors', reason: 'provider_sync_position_internal' },
  { code: 'raw_provider_intents', reason: 'raw_provider_pages_restricted' },
  { code: 'receipt_results', reason: 'idempotency_receipts_internal' },
  { code: 'suggestion_plan_snapshots', reason: 'plan_snapshots_restricted' },
  { code: 'connection_consent_metadata', reason: 'export_qualification_covers_measures_only' },
  { code: 'suggestion_records', reason: 'export_qualification_covers_measures_only' },
  { code: 'measure_tombstones', reason: 'deleted_records_not_exported' },
];

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  for (const migration of migrations) db.exec(migration.sql);
  db.exec(lifecycleMigration.sql);
  db.exec(wearablePersistenceSql);
  const records = new Map();
  let sequence = 0;
  bindSuppressionAuthority(db, {
    currentSequence: () => sequence,
    lookup: id => records.get(id) ?? null,
    reconcileRestore: apply => { for (const value of records.values()) apply(value); return sequence; },
    recordDisable: input => {
      const record = { ...input, sequence: ++sequence };
      records.set(input.accountId, record);
      return record;
    },
  });
  const domain = new Domain(db);
  const [actor, other] = ['canonical-wearable-one', 'canonical-wearable-two'].map(id => {
    const now = Date.now();
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)')
      .run(id, id, `${id}@synthetic.invalid`, now, now);
    const accountId = domain.account(id, id);
    db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(id, id, `synthetic-session-${id}`, now + 600000, now, now);
    return { accountId, authUserId: id, sessionId: id, epoch: 0 };
  });
  const writer = createCanonicalAccountWriter(db);
  const deps = { db, lifecycle: writer.lifecycle, control: writer, assertImportAllowed: () => {} };
  const persistence = createWearablePersistence(deps);
  const service = createWearablesService({
    store: persistence.store, enabled: () => true, now: () => importedAt,
    assertActive: writer.lifecycle.assertActive, withActiveWrite: writer.lifecycle.withActiveWrite,
    assertImportAllowed: deps.assertImportAllowed,
  });
  for (const ctx of [actor, other]) service.connectHealthKit(ctx, 'connect', {
    connectionId: 'hk', types: ['steps'], consentVersion: 'synthetic', retentionConsent: true,
  });
  const adapter = options => writer.guardLifecycleAdapter(createWearableLifecycleAdapter({ ...deps, ...options }));
  return { db, actor, other, writer, service, persistence, adapter, deps };
}

function measure(id = 'qualified') {
  return {
    id, metric: 'steps', value: 123, unit: 'count', start: '2026-10-09T00:00:00Z',
    end: '2026-10-10T00:00:00Z', day: '2026-10-09', zone: 'UTC', aggregation: 'sum',
    source: { bundleId: 'synthetic', name: 'Synthetic', device: null, algorithm: null, originalId: null },
    revision: { token: revisionMarker, order: 1 }, quality: 'complete',
  };
}

function page(batch = [measure()]) {
  return { version: 1, connectionId: 'hk', generation: 1, stream: 'steps', fromCursor: null,
    nextCursor: cursorMarker, pageId: receiptMarker, batch, tombstones: [] };
}

function rows(db, actor) {
  return Object.fromEntries(wearableTables.map(table => [table,
    db.prepare(`SELECT * FROM ${table} WHERE account_id=? ORDER BY rowid`).all(actor.accountId)]));
}

function exported(f, options) {
  return buildAccountExport(f.db, f.actor, f.writer.lifecycle.assertActive, [f.adapter(options)]);
}

function wearableValues(result) {
  return JSON.parse(result.json).records.filter(row => row.category === 'wearables').map(row => row.value);
}

function assertOmissions(manifest) {
  assert.deepEqual(manifest.omissions, omissionReasons.map(({ code }) => code));
  assert.deepEqual(manifest.omissionReasons, omissionReasons);
}

test('canonical writer rolls back a service page atomically, retries once, and rejects the invalidated original session', t => {
  const f = fixture(t);
  f.service.ingest(f.other, 'other-import', page([measure('other')]));
  const before = rows(f.db, f.actor), otherBefore = rows(f.db, f.other);
  assert.equal(before.wearable_connections.length, 1);
  assert.equal(before.wearable_receipts.length, 1);
  assert.throws(() => f.writer.lifecycle.withActiveWrite(f.actor, () => {
    const result = f.service.ingest(f.actor, 'import', page());
    assert.equal(result.accepted, 1);
    const pending = rows(f.db, f.actor);
    assert.equal(pending.wearable_measures.length, 1);
    assert.equal(pending.wearable_cursors.length, 1);
    assert.equal(pending.wearable_receipts.length, 3);
    assert.equal(JSON.parse(pending.wearable_connections[0].data).lastImportAt, importedAt);
    throw Error('synthetic-outer-rollback');
  }), /synthetic-outer-rollback/);
  assert.deepEqual(rows(f.db, f.actor), before);
  assert.deepEqual(rows(f.db, f.other), otherBefore);

  const result = f.service.ingest(f.actor, 'import', page());
  assert.deepEqual(result, { accepted: 1, duplicates: 0, cursor: cursorMarker, pageId: receiptMarker });
  const committed = rows(f.db, f.actor);
  assert.equal(committed.wearable_measures.length, 1);
  assert.equal(committed.wearable_cursors[0].cursor, cursorMarker);
  assert.equal(committed.wearable_receipts.length, 3);
  assert.equal(JSON.parse(committed.wearable_connections[0].data).lastImportAt, importedAt);
  assert.deepEqual(f.service.ingest(f.actor, 'import', page()), result);
  assert.deepEqual(rows(f.db, f.actor), committed);
  assert.deepEqual(rows(f.db, f.other), otherBefore);

  f.db.prepare('DELETE FROM session WHERE id=?').run(f.actor.sessionId);
  assert.throws(() => f.service.ingest(f.actor, 'import', page()), /account_session_invalid/);
  assert.deepEqual(rows(f.db, f.actor), committed);
  assert.deepEqual(rows(f.db, f.other), otherBefore);
});

test('composed account export omits measures with missing or false qualification', t => {
  const f = fixture(t);
  f.service.ingest(f.actor, 'import', page());
  for (const options of [{}, { qualifyExport: () => false }]) {
    const result = exported(f, options), document = JSON.parse(result.json);
    assert.equal(result.complete, false);
    assert.equal(document.manifest.complete, false);
    const values = wearableValues(result);
    assert.deepEqual(values.map(value => value.kind), ['manifest']);
    assertOmissions(values[0]);
    assert.equal(document.manifest.categories.find(value => value.category === 'wearables').status, 'unavailable');
    assert.equal(result.json.includes(revisionMarker), false);
  }
});

test('qualified composed export preserves allowed measure lineage, omits private state and keeps external coverage unavailable', t => {
  const f = fixture(t);
  const credentialMarker = 'synthetic-provider-private-value';
  f.service.ingest(f.actor, 'import', {
    ...page([measure(), measure('unqualified')]), tombstones: [{ id: 'tombstone-marker', revision: { token: 'deleted-revision', order: 2 } }],
  });
  f.service.ingest(f.other, 'other-import', page([measure('other-account-only')]));
  f.writer.lifecycle.withActiveWrite(f.actor, () => {
    const { store } = f.persistence;
    store.putConnection(f.actor, { ...store.connection(f.actor, 'hk'), id: 'oura-connection-marker', provider: 'oura', consentVersion: 'consent-marker' });
    store.putSuggestion(f.actor, {
      id: 'suggestion-marker', planId: 'plan-marker', baseRevision: 1, appliedRevision: null, state: 'pending', beforeItems: [], afterItems: [],
      reviewDigest: 'review-marker', expiresAt: '2026-12-01T00:00:00Z', reason: 'suggestion-reason-marker', limits: [], policyVersion: 'synthetic', evidenceRefs: [],
    });
  });
  f.db.prepare('INSERT INTO wearable_provider_intents VALUES(?,?,?,?,?,?,?,?,?)').run(
    f.actor.accountId, 'oura-connection-marker', 1, 'synthetic-intent', f.actor.sessionId, f.actor.epoch,
    intentMarker, intentMarker, JSON.stringify({ marker: intentMarker, credentials: credentialMarker }),
  );
  const before = rows(f.db, f.actor), otherBefore = rows(f.db, f.other);
  const result = exported(f, { qualifyExport: (_ctx, record) => record.id === 'qualified' });
  const document = JSON.parse(result.json), values = wearableValues(result);
  assert.deepEqual(values.map(value => value.kind), ['measure', 'manifest']);
  const [exportedMeasure, manifest] = values;
  const value = exportedMeasure.data, original = measure();
  for (const key of ['id', 'metric', 'value', 'unit', 'start', 'end', 'day', 'zone', 'aggregation', 'source', 'quality'])
    assert.deepEqual(value[key], original[key]);
  assert.equal(value.provider, 'healthkit');
  assert.equal(value.connectionId, 'hk');
  assert.equal(value.generation, 1);
  assert.equal(value.importedAt, importedAt);
  assert.deepEqual(value.revision, { order: 1 });
  assert.equal(value.aiEligible, false);
  assert.equal(value.provenance, 'unqualified_import');
  assert.equal(result.complete, false);
  assert.equal(document.manifest.complete, false);
  assertOmissions(manifest);
  assert.equal(manifest.exported, 1);
  assert.equal(manifest.unqualified, 1);
  assert.equal(manifest.externalStatus, 'unavailable');
  assert.equal(manifest.status, 'unavailable');
  assert.equal(document.manifest.categories.find(value => value.category === 'wearables').status, 'unavailable');
  for (const marker of [cursorMarker, receiptMarker, intentMarker, revisionMarker, credentialMarker, `synthetic-session-${f.actor.sessionId}`,
    '"credentials":', 'oura-connection-marker', 'consent-marker', 'suggestion-marker', 'plan-marker', 'review-marker', 'tombstone-marker', 'other-account-only'])
    assert.equal(result.json.includes(marker), false, marker);
  assert.deepEqual(rows(f.db, f.actor), before);
  assert.deepEqual(rows(f.db, f.other), otherBefore);
});

test('guarded populated wearable adapter denies purge before invoking its destructive callback', t => {
  const f = fixture(t);
  f.service.ingest(f.actor, 'import', page());
  const before = rows(f.db, f.actor);
  let called = 0;
  const underlying = createWearableLifecycleAdapter(f.deps);
  const adapter = f.writer.guardLifecycleAdapter({ ...underlying, purge: (...args) => {
    called++;
    return underlying.purge(...args);
  } });
  assert.deepEqual(adapter.purge('synthetic-request', f.actor.accountId), {
    status: 'unavailable', reason: 'exact_purge_executor_binding_required',
  });
  assert.equal(called, 0);
  assert.deepEqual(rows(f.db, f.actor), before);
});
