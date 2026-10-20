import { issueLocalPurgeAuthority } from '../../src/lifecycle/purge-executor.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { DomainError } from '../../src/errors.js';
import { hash, migrations, type Sqlite } from '../../src/storage.js';
import { adultEligibility, assertAccountActive, assertActive, suppressionAuthority, withActiveWrite } from '../../src/lifecycle/guards.js';
import { lifecycleMigration } from '../../src/lifecycle/migration.js';
import { AccountLifecycle, lifecyclePolicy } from '../../src/lifecycle/service.js';
import type { AccountContext, DisableRecord, SuppressionLedger } from '../../src/lifecycle/types.js';
import { createUsageLedger, usageMigrationSql, usageOwnedTables, type UsageLedgerOptions } from '../../src/usage-limits/index.js';
import { actor, otherActor, fixture, intent, testPolicy } from './fixture.js';

function canonicalFixture(t: TestContext) {
  const db: Sqlite = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  db.pragma('foreign_keys = ON');
  const legacy = migrations.filter(migration => migration.version <= 7);
  assert.deepEqual(legacy.map(migration => migration.version), [1, 2, 3, 4, 5, 6, 7]);
  for (const migration of legacy) db.exec(migration.sql);
  const now = Date.now(), context: AccountContext = { ...actor, epoch: 0 }, other: AccountContext = { ...otherActor, epoch: 0 };
  for (const principal of [context, other]) {
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)')
      .run(principal.authUserId, 'Synthetic', `${principal.authUserId}@synthetic.invalid`, now, now);
    db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run(principal.accountId, principal.authUserId, 'synthetic');
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)')
      .run(principal.sessionId, now + 86_400_000, `synthetic-${principal.sessionId}`, now, now, principal.authUserId);
  }
  db.exec(lifecycleMigration.sql); db.exec(usageMigrationSql);
  // This synthetic authority is independent of the app transaction; it makes no durability claim.
  const records = new Map<string, DisableRecord>(), authorityState = { available: true };
  let sequence = 0;
  const authority: SuppressionLedger = {
    recordDisable(record) {
      assert.equal(records.has(record.accountId), false);
      const entry = Object.freeze({ ...record, sequence: ++sequence });
      records.set(entry.accountId, entry); return entry;
    },
    lookup: accountId => records.get(accountId) ?? null,
    currentSequence() {
      if (!authorityState.available) throw new Error('synthetic authority unavailable');
      return sequence;
    },
    reconcileRestore(apply) { for (const record of records.values()) apply(record); return sequence; },
  };
  // Match the canonical request-factory suppression fences without importing unrelated module composition.
  const assertSuppression = (accountId: string, epoch: number) => {
    if (!db.inTransaction || !Number.isSafeInteger(epoch) || epoch < 1)
      throw new DomainError(503, 'canonical_suppression_unproved');
    const record = suppressionAuthority(db).lookup(accountId);
    const row = db.prepare('SELECT state,epoch,suppression_seq FROM account_lifecycle WHERE account_id=?')
      .get(accountId) as { state: string; epoch: number; suppression_seq: number } | undefined;
    if (!record || record.accountId !== accountId || record.epoch !== epoch || row?.state !== 'disabled' ||
      row.epoch !== epoch || row.suppression_seq !== record.sequence)
      throw new DomainError(503, 'canonical_suppression_unproved');
  };
  const options: UsageLedgerOptions = {
    db, now: () => now, policy: testPolicy(),
    lifecycle: {
      assertActive: principal => assertActive(db, principal),
      withActiveWrite: (principal, effect) => withActiveWrite(db, principal, effect),
      adultEligibility: principal => adultEligibility(db, principal),
    },
    resolveRights: () => ({ policyId: 'synthetic-canonical-grants', capabilities: ['coach'], configuredOperations: ['standard'] }),
    lifecycleControl: {
      assertSuppression,
      assertPurge(requestId, accountId) {
        const record = suppressionAuthority(db).lookup(accountId);
        const request = db.prepare('SELECT account_id FROM account_deletion_requests WHERE id=?').get(requestId) as { account_id: string } | undefined;
        if (!record || record.requestId !== requestId || request?.account_id !== accountId)
          throw new DomainError(503, 'canonical_purge_unproved');
        assertSuppression(accountId, record.epoch);
      },
    },
  };
  const ledger = createUsageLedger(options), lifecycle = new AccountLifecycle(db, [ledger.lifecycle], authority, () => now);
  const requestId = '11111111-1111-4111-8111-111111111111';
  const disable = () => {
    const initiated = lifecycle.initiate(context, 'synthetic-delete', { requestId, policyVersion: lifecyclePolicy,
      confirmation: 'delete_whole_account', statusSecret: 'a'.repeat(43) });
    assert.equal(initiated.disabled, false);
    const grant = 'b'.repeat(43);
    db.prepare('INSERT INTO account_action_grants VALUES(?,?,?,?,?,?,?,?,NULL)')
      .run(hash(grant), context.accountId, context.sessionId, context.epoch, 'account_delete', 'password', now, now + 300_000);
    return lifecycle.confirm(context, requestId, { grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' });
  };
  const snapshot = () => usageOwnedTables.map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
  const verify = (accountId = context.accountId, epoch = 1) => db.transaction(() => ledger.lifecycle.verifySuppressed(accountId, epoch)).immediate();
  return { db, context, other, ledger, lifecycle, authority, authorityState, options, requestId, disable, snapshot, verify };
}

test('no-save accounting and export contain only validated counts, fences, identifiers and telemetry metadata', t => {
  const f = fixture(t), secret = 'TRANSCRIPT AUDIO WORKOUT PROPOSAL MUST NOT BE RETAINED';
  const supplied = { ...intent('no-save'), transcript: secret, audio: secret, workoutProposal: secret };
  const admitted = f.ledger.usage.reserve(actor, supplied);
  f.ledger.usage.markDispatching(admitted.handle, 'transcribe');
  f.ledger.trusted.settle(admitted.handle, { charges: supplied.charges,
    economics: [{ providerId: 'configured-provider', modelId: 'configured-model', sourceId: 'provider-usage-event',
      telemetry: 'partial', quantities: [{ unitId: 'input_tokens', quantity: 42 }], ...{ transcript: secret } }] });
  f.ledger.usage.reserve(otherActor, { ...intent('other-account'), subjectId: 'PRIVATE_OTHER_ACCOUNT' });
  const output: unknown[] = [];
  const result = f.ledger.lifecycle.export(actor, { snapshotAtMs: f.state.now, append: (_category, value) => output.push(value) });
  assert.equal(result.status, 'complete'); assert.equal(result.count, output.length);
  const encoded = JSON.stringify(output);
  assert.equal(encoded.includes(secret), false); assert.equal(encoded.includes('PRIVATE_OTHER_ACCOUNT'), false);
  assert.ok(encoded.includes('input_tokens')); assert.ok(encoded.includes('unconfigured'));
  const economics = f.db.prepare('SELECT telemetry,quantities,pricing_state FROM usage_economics').get() as Record<string, string>;
  assert.equal(economics.telemetry, 'partial'); assert.equal(economics.pricing_state, 'unconfigured');
  for (const table of usageOwnedTables) {
    const rows = f.db.prepare(`SELECT * FROM ${table}`).all();
    assert.equal(JSON.stringify(rows).includes(secret), false);
  }
  assert.equal(f.ledger.lifecycle.inventory(actor).count, output.length);
});

test('missing versus partial versus complete telemetry stays explicit and invalid evidence rolls settlement back', t => {
  const f = fixture(t), item = f.ledger.usage.reserve(actor, intent('telemetry'));
  f.ledger.usage.markDispatching(item.handle, 'transcribe');
  assert.throws(() => f.ledger.trusted.settle(item.handle, { charges: intent('unused').charges,
    economics: [{ providerId: 'p', modelId: 'm', sourceId: 's', telemetry: 'complete', quantities: [] }] }),
  (error: unknown) => (error as { code: string }).code === 'usage_economics_invalid');
  assert.equal(f.ledger.usage.status(actor).metrics?.coach_messages.reserved, 1);
  f.ledger.trusted.settle(item.handle, { charges: intent('unused').charges,
    economics: [{ providerId: 'p', modelId: 'm', sourceId: 'unavailable', telemetry: 'missing', quantities: [] },
      { providerId: 'p', modelId: 'm', sourceId: 'observed', telemetry: 'complete', quantities: [{ unitId: 'output_tokens', quantity: 0 }] }] });
  assert.deepEqual(f.db.prepare('SELECT telemetry FROM usage_economics ORDER BY ordinal').all(), [{ telemetry: 'missing' }, { telemetry: 'complete' }]);
});

test('suppression releases undispatched holds but purge waits for unresolved provider work and preserves account isolation', t => {
  const f = fixture(t), undispatched = f.ledger.usage.reserve(actor, intent('never-dispatched'));
  const uncertain = f.ledger.usage.reserve(actor, intent('provider-pending'));
  f.ledger.usage.markDispatching(uncertain.handle, 'transcribe');
  f.ledger.trusted.markUnknown(uncertain.handle);
  f.ledger.usage.reserve(otherActor, intent('other'));
  assert.throws(() => f.ledger.lifecycle.suppress(actor.accountId, 2), /canonical suppression absent/);
  f.state.suppressed = true;
  assert.equal(f.ledger.lifecycle.suppress(actor.accountId, 2).status, 'complete');
  assert.equal(f.ledger.lifecycle.verifySuppressed(actor.accountId, 2).status, 'complete');
  assert.equal((f.db.prepare('SELECT state FROM usage_reservations WHERE id=?').get(undispatched.handle.reservationId) as { state: string }).state, 'released');
  const beforePurge = f.db.prepare('SELECT * FROM usage_reservations').all();
  assert.deepEqual(f.ledger.lifecycle.purge('deletion-a', actor.accountId),
    { status: 'pending', count: 1, reason: 'usage_provider_reconciliation_required' });
  assert.deepEqual(f.db.prepare('SELECT * FROM usage_reservations').all(), beforePurge);
  assert.throws(() => f.ledger.usage.reserve(actor, intent('after-disable')), (error: unknown) => (error as { code: string }).code === 'usage_suppressed');
  f.state.active = false;
  f.ledger.trusted.reconcile(uncertain.handle, { outcome: 'not_consumed', evidenceId: 'provider-authoritative-no-consumption' });
  assert.equal(f.ledger.lifecycle.purge('deletion-a', actor.accountId).status, 'complete');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM usage_reservations WHERE account_id=?').get(actor.accountId) as { n: number }).n, 0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM usage_reservations WHERE account_id=?').get(otherActor.accountId) as { n: number }).n, 1);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('lifecycle absence fails closed without suppressing or purging any accounting data', t => {
  const f = fixture(t), { lifecycleControl: _controls, ...options } = f.options();
  const service = createUsageLedger(options);
  service.usage.reserve(actor, intent('retained'));
  const before = service.lifecycle.inventory(actor).count;
  assert.equal(service.lifecycle.suppress(actor.accountId, 2).status, 'unavailable');
  assert.equal(service.lifecycle.purge('deletion-a', actor.accountId).status, 'unavailable');
  assert.equal(service.lifecycle.verifySuppressed(actor.accountId, 2).status, 'unavailable');
  assert.equal(service.lifecycle.inventory(actor).count, before);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM usage_suppressions').get() as { n: number }).n, 0);
});

test('canonical purgeLocal completes usage purge after provider reconciliation and retains suppression across repeat purge', t => {
  const f = canonicalFixture(t);
  const other = f.ledger.usage.reserve(f.other, intent('canonical-other'));
  f.ledger.usage.markDispatching(other.handle, 'transcribe');
  f.ledger.trusted.settle(other.handle, { charges: intent('unused').charges,
    economics: [{ providerId: 'synthetic-provider', modelId: 'synthetic-model', sourceId: 'synthetic-meter',
      telemetry: 'partial', quantities: [{ unitId: 'input_tokens', quantity: 12 }] }] });
  const otherOnly = f.snapshot();
  const undispatched = f.ledger.usage.reserve(f.context, intent('canonical-undispatched'));
  const uncertain = f.ledger.usage.reserve(f.context, intent('canonical-unknown'));
  f.ledger.usage.markDispatching(uncertain.handle, 'transcribe');
  f.ledger.trusted.markUnknown(uncertain.handle);
  assert.equal(f.disable().disabled, true);
  const suppression = f.authority.lookup(f.context.accountId);
  assert.ok(suppression);
  assert.deepEqual(f.db.prepare('SELECT state FROM usage_reservations WHERE id=?').get(undispatched.handle.reservationId), { state: 'released' });
  assert.deepEqual(f.db.prepare('SELECT state FROM usage_reservations WHERE id=?').get(uncertain.handle.reservationId), { state: 'unknown' });
  const held = f.snapshot();
  const pending = f.lifecycle.purgeLocal(issueLocalPurgeAuthority(f.lifecycle, { requestId: f.requestId, operationId: 'synthetic-purge' }));
  assert.equal(pending.localPurged, false);
  assert.equal(pending.complete, false);
  assert.deepEqual(f.snapshot(), held);
  assert.equal(f.verify().status, 'complete');
  assert.throws(() => f.ledger.usage.reserve(f.context, intent('canonical-disabled')),
    (error: unknown) => error instanceof DomainError && error.code === 'account_session_invalid');

  f.ledger.trusted.reconcile(uncertain.handle, { outcome: 'not_consumed', evidenceId: 'synthetic-authoritative-not-consumed' });
  const purged = f.lifecycle.purgeLocal(issueLocalPurgeAuthority(f.lifecycle, { requestId: f.requestId, operationId: 'synthetic-purge' }));
  assert.deepEqual(f.snapshot(), otherOnly);
  assert.equal(f.db.prepare('SELECT 1 FROM usage_suppressions WHERE account_id=?').get(f.context.accountId), undefined);
  assert.equal(purged.localPurged, true, 'canonical purgeLocal must qualify the empty usage module after authoritative reconciliation');
  assert.equal(purged.complete, false);
  assert.equal(purged.phase, 'pending_external');
  assert.equal(f.verify().status, 'complete');
  assert.deepEqual(f.authority.lookup(f.context.accountId), suppression);
  assert.deepEqual(f.db.prepare('SELECT state,epoch,suppression_seq FROM account_lifecycle WHERE account_id=?').get(f.context.accountId),
    { state: 'disabled', epoch: suppression.epoch, suppression_seq: suppression.sequence });
  assert.throws(() => assertAccountActive(f.db, f.context.accountId),
    (error: unknown) => error instanceof DomainError && error.code === 'account_disabled');
  assert.throws(() => f.ledger.usage.reserve(f.context, intent('canonical-after-purge')),
    (error: unknown) => error instanceof DomainError && error.code === 'account_session_invalid');
  assert.equal(f.lifecycle.purgeLocal(issueLocalPurgeAuthority(f.lifecycle, { requestId: f.requestId, operationId: 'synthetic-purge' })).localPurged, true);
  assert.equal(f.verify().status, 'complete');
  assert.deepEqual(f.snapshot(), otherOnly);
  assert.deepEqual(f.authority.lookup(f.context.accountId), suppression);
  assert.equal(f.ledger.usage.status(f.other).metrics?.coach_messages.settled, 1);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('canonical usage verification requires trusted authority and cannot accept a missing marker while usage data remains', t => {
  const f = canonicalFixture(t), { lifecycleControl: _controls, ...withoutControls } = f.options;
  assert.equal(createUsageLedger(withoutControls).lifecycle.verifySuppressed(f.context.accountId, 1).status, 'unavailable');
  assert.throws(() => f.verify(),
    (error: unknown) => error instanceof DomainError && error.code === 'canonical_suppression_unproved');
  assert.equal(f.snapshot().every(table => table.rows.length === 0), true);

  f.ledger.usage.reserve(f.context, intent('canonical-retained-data'));
  f.disable();
  f.authorityState.available = false;
  assert.throws(() => f.verify(),
    (error: unknown) => error instanceof DomainError && error.code === 'suppression_authority_unavailable');
  f.authorityState.available = true;
  assert.throws(() => f.verify(f.context.accountId, 2),
    (error: unknown) => error instanceof DomainError && error.code === 'canonical_suppression_unproved');
  assert.throws(() => f.ledger.lifecycle.verifySuppressed(f.context.accountId, 1),
    (error: unknown) => error instanceof DomainError && error.code === 'canonical_suppression_unproved');
  f.db.prepare('DELETE FROM usage_suppressions WHERE account_id=?').run(f.context.accountId);
  const remaining = f.snapshot();
  assert.ok(remaining.some(table => table.rows.length > 0));
  assert.deepEqual(f.verify(), { status: 'unknown', reason: 'usage_suppression_unproved' });
  assert.equal(f.lifecycle.purgeLocal(issueLocalPurgeAuthority(f.lifecycle, { requestId: f.requestId, operationId: 'synthetic-purge' })).localPurged, false);
  assert.deepEqual(f.snapshot(), remaining);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});
