import { randomUUID } from 'node:crypto';
import type { AccountContext, LifecycleResult } from '../lifecycle/types.js';
import { canonical, hash } from '../storage.js';
import { usageMetrics } from './types.js';
import type { ReservationState, UsageCharge, UsageIntent, UsageLedger, UsageLedgerOptions,
  UsageMetric, UsagePeriod, UsageReservationHandle, UsageSettlement, UsageSnapshot } from './types.js';
import { actorCopy, charges, economicsCopy, fail, identifier, integer, intentCopy, periodCopy, policyCopy } from './validation.js';

type Reservation = {
  id: string; account_id: string; period_id: string; auth_user_id: string; auth_session_id: string;
  account_epoch: number; operation: string; idempotency_key: string; intent_hash: string;
  subject_id: string; fingerprint: string; policy_id: string; state: ReservationState;
  created_at_ms: number; resolution_hash: string | null; evidence_id: string | null;
};
type Counter = { settled: number; reserved: number; unknown: number };
type ChargeRow = { metric: UsageMetric; amount: number };
const category = 'usage_limits';
const childTables = ['usage_economics', 'usage_dispatches', 'usage_charges'] as const;
const accountTables = ['usage_reservations', 'usage_counters', 'usage_periods', 'usage_accounts', 'usage_suppressions'] as const;

export function createUsageLedger(options: UsageLedgerOptions): UsageLedger {
  const { db, lifecycle } = options;
  const policy = options.policy ? policyCopy(options.policy) : undefined;
  const handles = new WeakMap<UsageReservationHandle, Readonly<{ id: string; actor: AccountContext }>>();
  const dispatchOwners = new WeakSet<UsageReservationHandle>();
  const transaction = <T>(effect: () => T): T => db.transaction(effect).immediate();
  const now = () => { const value = options.now(); integer(value); return value; };
  const assertUnsuppressed = (actor: AccountContext) => {
    if (db.prepare('SELECT 1 FROM usage_suppressions WHERE account_id=?').get(actor.accountId)) fail('usage_suppressed', 403);
  };
  const active = <T>(actor: AccountContext, effect: () => T): T => transaction(() => lifecycle.withActiveWrite(actor, () => {
    lifecycle.assertActive(actor); assertUnsuppressed(actor);
    const result = effect();
    lifecycle.assertActive(actor); assertUnsuppressed(actor);
    return result;
  }));
  const authorize = (actor: AccountContext, operation: string) => {
    if (!policy || !options.resolveRights) fail('usage_unconfigured', 503);
    const rule = Object.hasOwn(policy.operations, operation) ? policy.operations[operation] : undefined;
    if (!rule) fail('usage_operation_unconfigured', 503);
    const rights = options.resolveRights(actor);
    identifier(rights.policyId);
    if (!Array.isArray(rights.capabilities) || !Array.isArray(rights.configuredOperations)) fail('usage_rights_unconfigured', 503);
    if (!rights.configuredOperations.includes(operation)) fail('usage_provider_unconfigured', 503);
    if (!rights.capabilities.includes(rule.capability)) fail('usage_capability_denied', 403);
    return rule;
  };
  const counter = (accountId: string, periodId: string, metric: UsageMetric): Counter =>
    db.prepare('SELECT settled,reserved,unknown FROM usage_counters WHERE account_id=? AND period_id=? AND metric=?')
      .get(accountId, periodId, metric) as Counter | undefined ?? { settled: 0, reserved: 0, unknown: 0 };
  const storedPeriod = (row: Reservation): UsagePeriod => {
    const period = db.prepare('SELECT period_id AS id,start_ms AS startMs,end_ms AS endMs FROM usage_periods WHERE account_id=? AND period_id=?')
      .get(row.account_id, row.period_id) as UsagePeriod | undefined;
    if (!period) fail('usage_period_missing', 503);
    return Object.freeze(period);
  };
  const validatePeriodBinding = (accountId: string, period: UsagePeriod) => {
    const account = db.prepare('SELECT period_policy_id FROM usage_accounts WHERE account_id=?').get(accountId) as { period_policy_id: string } | undefined;
    if (account && account.period_policy_id !== policy?.periodPolicyId) fail('usage_period_policy_changed', 503);
    const collision = db.prepare(`SELECT period_id,start_ms,end_ms FROM usage_periods WHERE account_id=?
      AND (period_id=? OR (start_ms<? AND end_ms>?))`).all(accountId, period.id, period.endMs, period.startMs) as
      { period_id: string; start_ms: number; end_ms: number }[];
    if (collision.some(row => row.period_id !== period.id || row.start_ms !== period.startMs || row.end_ms !== period.endMs))
      fail('usage_period_changed', 503);
  };
  const snapshot = (accountId: string, period: UsagePeriod | null, atMs = now()): UsageSnapshot => ({
    schemaVersion: 1, configured: !!policy && !!options.resolveRights, policyId: policy?.id ?? null,
    serverTimeMs: atMs, period,
    metrics: policy && period ? Object.fromEntries(usageMetrics.map(metric => {
      const value = counter(accountId, period.id, metric), limit = policy.limits[metric];
      return [metric, { limit, ...value, remaining: Math.max(0, limit - value.settled - value.reserved - value.unknown) }];
    })) as UsageSnapshot['metrics'] : null,
    ordinaryWorkoutExecution: 'unrestricted_by_usage_limits', ordinaryWorkoutLogging: 'unrestricted_by_usage_limits',
  });
  const readRow = (id: string): Reservation => {
    const row = db.prepare('SELECT * FROM usage_reservations WHERE id=?').get(id) as Reservation | undefined;
    if (!row) fail('usage_reservation_missing', 409);
    return row;
  };
  const matches = (row: Reservation, actor: AccountContext) => row.account_id === actor.accountId
    && row.auth_user_id === actor.authUserId && row.auth_session_id === actor.sessionId && row.account_epoch === actor.epoch;
  const makeHandle = (row: Reservation, fresh = false): UsageReservationHandle => {
    const actor = actorCopy({ accountId: row.account_id, authUserId: row.auth_user_id, sessionId: row.auth_session_id, epoch: row.account_epoch });
    const handle = Object.freeze({ reservationId: row.id, actor, operation: row.operation,
      intentHash: row.intent_hash, subjectId: row.subject_id }) as UsageReservationHandle;
    handles.set(handle, Object.freeze({ id: row.id, actor }));
    if (fresh) dispatchOwners.add(handle);
    return handle;
  };
  const bound = (handle: UsageReservationHandle): Reservation => {
    const binding = handles.get(handle);
    if (!binding) fail('usage_handle_invalid', 403);
    const row = readRow(binding.id);
    if (!matches(row, binding.actor)) fail('usage_actor_mismatch', 403);
    return row;
  };
  const heldCharges = (row: Reservation): ChargeRow[] =>
    db.prepare('SELECT metric,amount FROM usage_charges WHERE reservation_id=? ORDER BY metric').all(row.id) as ChargeRow[];
  const addCounter = (row: Reservation, metric: UsageMetric, settled: number, reserved: number, unknown: number) => {
    const previous = counter(row.account_id, row.period_id, metric);
    for (const value of [previous.settled + settled, previous.reserved + reserved, previous.unknown + unknown]) integer(value);
    db.prepare(`UPDATE usage_counters SET settled=settled+?,reserved=reserved+?,unknown=unknown+?
      WHERE account_id=? AND period_id=? AND metric=?`).run(settled, reserved, unknown, row.account_id, row.period_id, metric);
  };
  const resolve = (row: Reservation, settlement: UsageSettlement | null, evidenceId: string | null): UsageSnapshot => {
    const held = heldCharges(row);
    const actual = settlement ? charges(settlement.charges, true) : held.map(x => ({ metric: x.metric, amount: 0 }));
    if (actual.length !== held.length || actual.some(entry => !held.some(x => x.metric === entry.metric))) fail('usage_settlement_metrics_mismatch');
    const economics = economicsCopy(settlement?.economics);
    const resolutionHash = hash(canonical({ charges: actual, economics, outcome: settlement ? 'settled' : 'released', evidenceId }));
    if (row.state === 'settled' || row.state === 'released') {
      if (row.resolution_hash !== resolutionHash) fail('usage_resolution_mismatch', 409);
      return snapshot(row.account_id, storedPeriod(row));
    }
    for (const reserved of held) {
      const used = actual.find(x => x.metric === reserved.metric)!.amount;
      addCounter(row, reserved.metric, used, row.state === 'unknown' ? 0 : -reserved.amount,
        row.state === 'unknown' ? -reserved.amount : 0);
      db.prepare('UPDATE usage_charges SET settled_amount=? WHERE reservation_id=? AND metric=?').run(used, row.id, reserved.metric);
    }
    for (const [ordinal, item] of economics.entries()) db.prepare(`INSERT INTO usage_economics
      (reservation_id,ordinal,provider_id,model_id,source_id,telemetry,quantities) VALUES(?,?,?,?,?,?,?)`)
      .run(row.id, ordinal, item.providerId, item.modelId, item.sourceId, item.telemetry, JSON.stringify(item.quantities));
    db.prepare('UPDATE usage_reservations SET state=?,resolution_hash=?,evidence_id=? WHERE id=?')
      .run(settlement ? 'settled' : 'released', resolutionHash, evidenceId, row.id);
    return snapshot(row.account_id, storedPeriod(row));
  };
  const unresolved = (accountId: string) => (db.prepare(`SELECT count(*) AS n FROM usage_reservations
    WHERE account_id=? AND state IN ('dispatching','unknown')`).get(accountId) as { n: number }).n;
  const count = (accountId: string) => accountTables.reduce((total, table) => total + (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`)
    .get(accountId) as { n: number }).n, 0) + childTables.reduce((total, table) => total + (db.prepare(`SELECT count(*) AS n FROM ${table}
      WHERE reservation_id IN (SELECT id FROM usage_reservations WHERE account_id=?)`).get(accountId) as { n: number }).n, 0);

  return {
    usage: {
      reserve(inputActor, input) {
        const actor = actorCopy(inputActor), intent = intentCopy(input);
        return active(actor, () => {
          const prior = db.prepare('SELECT * FROM usage_reservations WHERE account_id=? AND operation=? AND idempotency_key=?')
            .get(actor.accountId, intent.operation, intent.idempotencyKey) as Reservation | undefined;
          const fingerprint = hash(canonical(intent));
          if (prior) {
            if (!matches(prior, actor)) fail('usage_actor_mismatch', 403);
            if (prior.fingerprint !== fingerprint) fail('usage_idempotency_mismatch', 409);
            return { kind: 'replay', handle: makeHandle(prior), state: prior.state, snapshot: snapshot(actor.accountId, storedPeriod(prior)) };
          }
          const rule = authorize(actor, intent.operation);
          if (!policy) fail('usage_unconfigured', 503);
          if (intent.charges.length !== rule.metrics.length || intent.charges.some(entry => !rule.metrics.includes(entry.metric)))
            fail('usage_charge_policy_mismatch');
          const atMs = now(), period = periodCopy(policy, atMs);
          validatePeriodBinding(actor.accountId, period);
          const live = intent.charges.find(entry => entry.metric === 'live_voice_ms');
          if (live && live.amount > period.endMs - atMs) fail('usage_period_boundary', 409);
          for (const entry of intent.charges) {
            const value = counter(actor.accountId, period.id, entry.metric);
            if (entry.amount > policy.limits[entry.metric] - value.settled - value.reserved - value.unknown) fail('usage_limit_exceeded', 429);
          }
          db.prepare('INSERT INTO usage_accounts(account_id,period_policy_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(actor.accountId, policy.periodPolicyId);
          db.prepare('INSERT INTO usage_periods VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(actor.accountId, period.id, period.startMs, period.endMs);
          for (const metric of usageMetrics) db.prepare('INSERT INTO usage_counters(account_id,period_id,metric) VALUES(?,?,?) ON CONFLICT DO NOTHING')
            .run(actor.accountId, period.id, metric);
          const id = randomUUID();
          db.prepare(`INSERT INTO usage_reservations(id,account_id,period_id,auth_user_id,auth_session_id,account_epoch,
            operation,idempotency_key,intent_hash,subject_id,fingerprint,policy_id,state,created_at_ms)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?)`).run(id, actor.accountId, period.id, actor.authUserId,
              actor.sessionId, actor.epoch, intent.operation, intent.idempotencyKey, intent.intentHash, intent.subjectId, fingerprint, policy.id, atMs);
          for (const entry of intent.charges) {
            db.prepare('INSERT INTO usage_charges(reservation_id,metric,amount) VALUES(?,?,?)').run(id, entry.metric, entry.amount);
            db.prepare('UPDATE usage_counters SET reserved=reserved+? WHERE account_id=? AND period_id=? AND metric=?')
              .run(entry.amount, actor.accountId, period.id, entry.metric);
          }
          for (const [ordinal, stage] of intent.dispatchStages.entries()) db.prepare('INSERT INTO usage_dispatches VALUES(?,?,?,NULL)').run(id, stage, ordinal);
          const row = readRow(id);
          return { kind: 'new', handle: makeHandle(row, true), state: row.state, snapshot: snapshot(actor.accountId, period, atMs) };
        });
      },
      markDispatching(handle, stage) {
        // A savepoint inside a caller transaction cannot authorize external I/O.
        if (db.inTransaction) fail('usage_dispatch_requires_outermost_transaction', 503);
        if (!dispatchOwners.has(handle)) fail('usage_replay_cannot_dispatch', 409);
        identifier(stage);
        return active(handle.actor, () => {
          const row = bound(handle); authorize(handle.actor, row.operation);
          if (row.state !== 'reserved' && row.state !== 'dispatching') fail('usage_dispatch_state_invalid', 409);
          const atMs = now(), period = storedPeriod(row);
          if (atMs < row.created_at_ms || atMs >= period.endMs) fail('usage_dispatch_expired', 409);
          if (policy) for (const entry of heldCharges(row)) {
            const value = counter(row.account_id, row.period_id, entry.metric);
            if (value.settled + value.reserved + value.unknown > policy.limits[entry.metric]) fail('usage_limit_exceeded', 429);
            if (entry.metric === 'live_voice_ms' && entry.amount > period.endMs - atMs) fail('usage_period_boundary', 409);
          }
          const changed = db.prepare(`UPDATE usage_dispatches SET dispatched_at_ms=? WHERE reservation_id=? AND stage=?
            AND dispatched_at_ms IS NULL AND NOT EXISTS (SELECT 1 FROM usage_dispatches earlier
              WHERE earlier.reservation_id=usage_dispatches.reservation_id AND earlier.ordinal<usage_dispatches.ordinal
              AND earlier.dispatched_at_ms IS NULL)`).run(atMs, row.id, stage).changes;
          if (changed !== 1) fail('usage_stage_unavailable', 409);
          db.prepare("UPDATE usage_reservations SET state='dispatching' WHERE id=?").run(row.id);
          return Object.freeze({ reservationId: row.id, stage, dispatchedAtMs: atMs });
        });
      },
      status(inputActor) {
        const actor = actorCopy(inputActor);
        return active(actor, () => {
          const atMs = now(), period = policy ? periodCopy(policy, atMs) : null;
          if (period) validatePeriodBinding(actor.accountId, period);
          return snapshot(actor.accountId, period, atMs);
        });
      },
    },
    trusted: {
      recover(inputActor, reservationId) {
        const actor = actorCopy(inputActor); identifier(reservationId);
        return transaction(() => {
          const row = readRow(reservationId);
          if (!matches(row, actor)) fail('usage_actor_mismatch', 403);
          return makeHandle(row);
        });
      },
      settle(handle, settlement) {
        return transaction(() => {
          const row = bound(handle);
          if (row.state !== 'dispatching' && row.state !== 'settled') fail('usage_settlement_state_invalid', 409);
          return resolve(row, settlement, null);
        });
      },
      release(handle) {
        return transaction(() => {
          const row = bound(handle);
          if (row.state !== 'reserved' && row.state !== 'released') fail('usage_release_requires_reconciliation', 409);
          return resolve(row, null, null);
        });
      },
      markUnknown(handle) {
        return transaction(() => {
          const row = bound(handle);
          if (row.state === 'unknown') return snapshot(row.account_id, storedPeriod(row));
          if (row.state !== 'dispatching') fail('usage_unknown_state_invalid', 409);
          for (const entry of heldCharges(row)) addCounter(row, entry.metric, 0, -entry.amount, entry.amount);
          db.prepare("UPDATE usage_reservations SET state='unknown' WHERE id=?").run(row.id);
          return snapshot(row.account_id, storedPeriod(row));
        });
      },
      reconcile(handle, evidence) {
        identifier(evidence.evidenceId);
        if (evidence.outcome !== 'settled' && evidence.outcome !== 'not_consumed') fail('usage_reconciliation_invalid');
        return transaction(() => {
          const row = bound(handle);
          if (!['unknown', 'dispatching', 'settled', 'released'].includes(row.state)) fail('usage_reconciliation_state_invalid', 409);
          return resolve(row, evidence.outcome === 'settled' ? evidence.settlement : null, evidence.evidenceId);
        });
      },
    },
    lifecycle: {
      category,
      inventory(actor) { return active(actorCopy(actor), () => ({ status: 'complete', category, count: count(actor.accountId) })); },
      export(actor, target) {
        integer(target.snapshotAtMs);
        return active(actorCopy(actor), () => {
          const total = count(actor.accountId);
          if (total > 20_000) return { status: 'unavailable', category, reason: 'usage_export_packaging_required' };
          for (const table of accountTables) for (const row of db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).iterate(actor.accountId)) {
            target.append(category, { table, metadata: row }); lifecycle.assertActive(actor);
          }
          for (const table of childTables) for (const row of db.prepare(`SELECT child.* FROM ${table} child
            JOIN usage_reservations r ON r.id=child.reservation_id WHERE r.account_id=?`).iterate(actor.accountId)) {
            target.append(category, { table, metadata: row }); lifecycle.assertActive(actor);
          }
          return { status: 'complete', category, count: total };
        });
      },
      suppress(accountId, epoch) {
        identifier(accountId); integer(epoch);
        if (!options.lifecycleControl) return { status: 'unavailable', reason: 'usage_lifecycle_control_required' };
        return transaction(() => {
          options.lifecycleControl!.assertSuppression(accountId, epoch);
          db.prepare(`INSERT INTO usage_suppressions VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET epoch=max(epoch,excluded.epoch)`)
            .run(accountId, epoch);
          const reserved = db.prepare("SELECT * FROM usage_reservations WHERE account_id=? AND state='reserved'").all(accountId) as Reservation[];
          for (const row of reserved) resolve(row, null, null);
          return { status: 'complete', reason: unresolved(accountId) ? 'admission_suppressed_provider_effects_unresolved' : 'admission_suppressed' };
        });
      },
      verifySuppressed(accountId, epoch): LifecycleResult {
        if (!options.lifecycleControl) return { status: 'unavailable', reason: 'usage_lifecycle_control_required' };
        options.lifecycleControl.assertSuppression(accountId, epoch);
        const row = db.prepare('SELECT epoch FROM usage_suppressions WHERE account_id=?').get(accountId) as { epoch: number } | undefined;
        if (row && row.epoch >= epoch) return { status: 'complete', reason: 'admission_suppressed_only' };
        return count(accountId) === 0 ? { status: 'complete', reason: 'canonical_suppression_no_usage_data' }
          : { status: 'unknown', reason: 'usage_suppression_unproved' };
      },
      purge(requestId, accountId) {
        identifier(requestId); identifier(accountId);
        if (!options.lifecycleControl) return { status: 'unavailable', reason: 'usage_lifecycle_control_required' };
        return transaction(() => {
          options.lifecycleControl!.assertPurge(requestId, accountId);
          if (!db.prepare('SELECT 1 FROM usage_suppressions WHERE account_id=?').get(accountId))
            return count(accountId) === 0 ? { status: 'complete', count: 0 } : { status: 'unavailable', reason: 'usage_suppression_required' };
          const pending = unresolved(accountId);
          if (pending) return { status: 'pending', count: pending, reason: 'usage_provider_reconciliation_required' };
          const total = count(accountId);
          for (const table of childTables) db.prepare(`DELETE FROM ${table} WHERE reservation_id IN
            (SELECT id FROM usage_reservations WHERE account_id=?)`).run(accountId);
          for (const table of accountTables) db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId);
          return { status: 'complete', count: total };
        });
      },
    },
  };
}
