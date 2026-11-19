import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { DomainError } from '../../src/errors.js';
import type { AccountContext } from '../../src/lifecycle/types.js';
import { createUsageLedger, usageMigrationVersion, usageOwnedTables } from '../../src/usage-limits/index.js';
import type { UsageIntent, UsageLimitsPort, UsagePolicy, UsageReservationHandle } from '../../src/usage-limits/index.js';
import { createUsageStatusRoutes } from '../../src/usage-limits/status-routes.js';
import { actor, otherActor, END, fixture, intent, START, testPolicy } from './fixture.js';

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const liveIntent = (key: string, ms: number): UsageIntent => ({ ...intent(key), operation: 'live',
  charges: [{ metric: 'live_voice_ms', amount: ms }, { metric: 'coach_messages', amount: 1 }], dispatchStages: ['createCall'] });

test('two independent SQLite connections serialize a simultaneous last-unit race and retain it on restart', { timeout: 15_000 }, async t => {
  const f = fixture(t, testPolicy(1));
  const gate = new SharedArrayBuffer(4), ready: Promise<void>[] = [], results: Promise<string>[] = [];
  const workers = ['first', 'second'].map(key => {
    const worker = new Worker(new URL('./race-worker.js', import.meta.url), { workerData: { path: f.path, key, gate } });
    ready.push(new Promise((resolve, reject) => {
      worker.on('message', message => { if (message.ready) resolve(); }); worker.once('error', reject);
    }));
    results.push(new Promise((resolve, reject) => {
      worker.on('message', message => { if (typeof message.result === 'string') resolve(message.result); }); worker.once('error', reject);
      worker.once('exit', exit => { if (exit !== 0) reject(new Error(`race worker exited ${exit}`)); });
    }));
    return worker;
  });
  t.signal.addEventListener('abort', () => { for (const worker of workers) void worker.terminate(); }, { once: true });
  try {
    await Promise.all(ready); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
    assert.deepEqual((await Promise.all(results)).sort(), ['new', 'usage_limit_exceeded']);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  f.db.close();
  const restarted = createUsageLedger(f.options(f.open()));
  assert.equal(restarted.usage.status(actor).metrics?.coach_messages.reserved, 1);
  assert.throws(() => restarted.usage.reserve(actor, intent('after-restart')), code('usage_limit_exceeded'));
});

test('post-write lifecycle failure rolls back reservation, counters, period and idempotency key together', t => {
  const f = fixture(t);
  f.state.failAfterWrite = true;
  assert.throws(() => f.ledger.usage.reserve(actor, intent('rollback')), /injected lifecycle failure/);
  for (const table of usageOwnedTables) assert.equal((f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  f.state.failAfterWrite = false;
  assert.equal(f.ledger.usage.reserve(actor, intent('rollback')).kind, 'new');
});

test('exact 150-minute live cap is admitted and one additional millisecond is refused', t => {
  const f = fixture(t);
  const admitted = f.ledger.usage.reserve(actor, liveIntent('cap', 9_000_000));
  assert.equal(admitted.snapshot.metrics?.live_voice_ms.remaining, 0);
  assert.throws(() => f.ledger.usage.reserve(actor, liveIntent('over-cap', 1)), code('usage_limit_exceeded'));
  f.ledger.usage.markDispatching(admitted.handle, 'createCall');
  f.ledger.trusted.settle(admitted.handle, { charges: liveIntent('unused', 9_000_000).charges });
  assert.equal(f.ledger.usage.status(actor).metrics?.live_voice_ms.settled, 9_000_000);
});

test('a failed multi-metric admission never consumes another metric or the intent key', t => {
  const f = fixture(t, testPolicy(2, 0));
  const generate: UsageIntent = { ...intent('generate'), operation: 'generate',
    charges: [{ metric: 'coach_messages', amount: 1 }, { metric: 'workout_generations', amount: 1 }] };
  assert.throws(() => f.ledger.usage.reserve(actor, generate), code('usage_limit_exceeded'));
  assert.equal(f.ledger.usage.status(actor).metrics?.coach_messages.remaining, 2);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM usage_reservations').get() as { n: number }).n, 0);
});

test('matching replay retains the original state; intent, subject, charge and stage changes conflict', t => {
  const f = fixture(t), original = intent('replay'), first = f.ledger.usage.reserve(actor, original);
  const again = f.ledger.usage.reserve(actor, original);
  assert.equal(again.kind, 'replay'); assert.equal(again.state, 'reserved');
  assert.equal(again.handle.reservationId, first.handle.reservationId);
  assert.throws(() => f.ledger.usage.markDispatching(again.handle, 'transcribe'), code('usage_replay_cannot_dispatch'));
  for (const change of [{ intentHash: 'b'.repeat(64) }, { subjectId: 'other-subject' },
    { charges: [{ metric: 'coach_messages' as const, amount: 2 }] }, { dispatchStages: ['complete'] }])
    assert.throws(() => f.ledger.usage.reserve(actor, { ...original, ...change }), code('usage_idempotency_mismatch'));
  f.ledger.usage.markDispatching(first.handle, 'transcribe');
  assert.equal(f.ledger.usage.reserve(actor, original).state, 'dispatching');
});

test('stage permits commit before use, follow declared order and cannot be acquired twice or within an outer transaction', t => {
  const f = fixture(t), row = f.ledger.usage.reserve(actor, intent('stages'));
  assert.throws(() => f.ledger.usage.markDispatching(row.handle, 'complete'), code('usage_stage_unavailable'));
  assert.throws(() => f.db.transaction(() => f.ledger.usage.markDispatching(row.handle, 'transcribe'))(),
    code('usage_dispatch_requires_outermost_transaction'));
  const secondConnection = f.open();
  for (const stage of ['transcribe', 'complete', 'synthesize']) {
    const permit = f.ledger.usage.markDispatching(row.handle, stage);
    assert.equal(permit.stage, stage);
    assert.equal((secondConnection.prepare('SELECT dispatched_at_ms FROM usage_dispatches WHERE reservation_id=? AND stage=?')
      .get(row.handle.reservationId, stage) as { dispatched_at_ms: number }).dispatched_at_ms, f.state.now);
    assert.throws(() => f.ledger.usage.markDispatching(row.handle, stage), code('usage_stage_unavailable'));
  }
  assert.throws(() => f.ledger.usage.markDispatching(row.handle, 'retry'), code('usage_stage_unavailable'));
});

test('unknown effects keep liability through restart and revocation until actor-bound authoritative reconciliation', t => {
  const f = fixture(t, testPolicy(1)), admitted = f.ledger.usage.reserve(actor, intent('unknown'));
  f.ledger.usage.markDispatching(admitted.handle, 'transcribe');
  const unknown = f.ledger.trusted.markUnknown(admitted.handle);
  assert.deepEqual(unknown.metrics?.coach_messages, { limit: 1, settled: 0, reserved: 0, unknown: 1, remaining: 0 });
  assert.throws(() => f.ledger.trusted.release(admitted.handle), code('usage_release_requires_reconciliation'));
  assert.throws(() => f.ledger.trusted.settle(admitted.handle, { charges: intent('unused').charges }), code('usage_settlement_state_invalid'));
  assert.throws(() => f.ledger.usage.markDispatching(admitted.handle, 'complete'), code('usage_dispatch_state_invalid'));
  assert.throws(() => f.ledger.usage.reserve(actor, intent('replacement')), code('usage_limit_exceeded'));
  f.db.close();
  f.state.active = false; f.state.epoch = 2; f.state.rights = { policyId: 'revoked', capabilities: [], configuredOperations: [] };
  const restarted = createUsageLedger(f.options(f.open()));
  assert.throws(() => restarted.trusted.recover(otherActor, admitted.handle.reservationId), code('usage_actor_mismatch'));
  assert.throws(() => restarted.trusted.recover({ ...actor, epoch: 2 }, admitted.handle.reservationId), code('usage_actor_mismatch'));
  const handle = restarted.trusted.recover(actor, admitted.handle.reservationId);
  assert.throws(() => restarted.usage.markDispatching(handle, 'complete'), code('usage_replay_cannot_dispatch'));
  const result = restarted.trusted.reconcile(handle, { outcome: 'settled', evidenceId: 'authoritative-provider-receipt',
    settlement: { charges: intent('unused').charges } });
  assert.equal(result.metrics?.coach_messages.settled, 1); assert.equal(result.metrics?.coach_messages.unknown, 0);
  assert.throws(() => restarted.usage.reserve(actor, intent('fresh-revoked')), code('test_actor_revoked'));
});

test('forged or cross-instance handles never authorize settlement and actor-session epochs fence idempotency', t => {
  const f = fixture(t), admitted = f.ledger.usage.reserve(actor, intent('ownership'));
  const forged = { ...admitted.handle } as UsageReservationHandle;
  assert.throws(() => f.ledger.trusted.release(forged), code('usage_handle_invalid'));
  assert.throws(() => createUsageLedger(f.options()).trusted.release(admitted.handle), code('usage_handle_invalid'));
  assert.throws(() => f.ledger.usage.reserve({ ...actor, sessionId: 'new-session' }, intent('ownership')), code('usage_actor_mismatch'));
  f.state.epoch = 2;
  assert.throws(() => f.ledger.usage.reserve({ ...actor, epoch: 2 }, intent('ownership')), code('usage_actor_mismatch'));
  assert.equal(f.ledger.trusted.release(admitted.handle).metrics?.coach_messages.reserved, 0);
});

test('settlement is idempotent, records overrun truthfully, and rejects altered terminal evidence', t => {
  const f = fixture(t, testPolicy(2)), admitted = f.ledger.usage.reserve(actor, intent('settlement'));
  f.ledger.usage.markDispatching(admitted.handle, 'transcribe');
  const settlement = { charges: [{ metric: 'coach_messages' as const, amount: 3 }] };
  const settled = f.ledger.trusted.settle(admitted.handle, settlement);
  assert.equal(settled.metrics?.coach_messages.settled, 3); assert.equal(settled.metrics?.coach_messages.remaining, 0);
  assert.equal(f.ledger.trusted.settle(admitted.handle, settlement).metrics?.coach_messages.settled, 3);
  assert.throws(() => f.ledger.trusted.settle(admitted.handle, { charges: intent('unused').charges }), code('usage_resolution_mismatch'));
  assert.throws(() => f.ledger.usage.reserve(actor, intent('after-overrun')), code('usage_limit_exceeded'));
});

test('configured calendar rollover allocates old settlement to its original period and rejects straddling live admission', t => {
  const f = fixture(t), admitted = f.ledger.usage.reserve(actor, intent('october'));
  f.ledger.usage.markDispatching(admitted.handle, 'transcribe');
  f.state.now = END - 10;
  assert.throws(() => f.ledger.usage.reserve(actor, liveIntent('straddling', 11)), code('usage_period_boundary'));
  const last = f.ledger.usage.reserve(actor, liveIntent('last-10-ms', 10));
  f.ledger.usage.markDispatching(last.handle, 'createCall');
  f.state.now = END;
  const november = f.ledger.usage.reserve(actor, intent('november'));
  assert.notEqual(november.snapshot.period?.id, admitted.snapshot.period?.id);
  const old = f.ledger.trusted.settle(admitted.handle, { charges: intent('unused').charges });
  assert.equal(old.period?.endMs, END); assert.equal(old.metrics?.coach_messages.settled, 1);
  assert.equal(f.ledger.usage.status(actor).metrics?.coach_messages.settled, 0);
  f.ledger.trusted.settle(last.handle, { charges: liveIntent('unused', 10).charges });
  assert.equal(f.ledger.usage.status(actor).metrics?.live_voice_ms.settled, 0);
});

test('no default UTC policy or period-reset escape; injected boundaries and stable calendar policy are enforced', t => {
  const f = fixture(t);
  const custom = { ...testPolicy(), periodPolicyId: 'configured-eastern-month',
    periodResolver: () => ({ id: 'eastern-october', startMs: START + 4 * 3_600_000, endMs: END + 4 * 3_600_000 }) };
  f.state.now = START + 5 * 3_600_000;
  const service = createUsageLedger(f.options(f.db, custom));
  assert.equal(service.usage.reserve(actor, intent('custom')).snapshot.period?.startMs, START + 4 * 3_600_000);
  assert.throws(() => f.ledger.usage.reserve(actor, intent('changed-policy')), code('usage_period_policy_changed'));
  const relabeled = createUsageLedger(f.options(f.db, { ...custom, periodResolver: () => ({ id: 'renamed', startMs: START, endMs: END }) }));
  assert.throws(() => relabeled.usage.reserve(actor, intent('overlap')), code('usage_period_changed'));
});

test('exact millisecond settlement accumulates small leases without repeated second rounding', t => {
  const f = fixture(t);
  for (const key of ['a', 'b', 'c']) {
    const item = f.ledger.usage.reserve(actor, liveIntent(key, 333));
    f.ledger.usage.markDispatching(item.handle, 'createCall');
    f.ledger.trusted.settle(item.handle, { charges: liveIntent('unused', 333).charges });
  }
  assert.equal(f.ledger.usage.status(actor).metrics?.live_voice_ms.settled, 999);
  assert.throws(() => f.ledger.usage.reserve(actor, liveIntent('fractional', 0.1)), code('usage_invalid_quantity'));
});

test('grant downgrade and lower configured limits retain counters and fence undispatched work', t => {
  const f = fixture(t, testPolicy(3)), reserved = f.ledger.usage.reserve(actor, intent('before-downgrade', 2));
  f.state.rights = { ...f.state.rights, capabilities: [] };
  assert.throws(() => f.ledger.usage.markDispatching(reserved.handle, 'transcribe'), code('usage_capability_denied'));
  assert.equal(f.ledger.usage.status(actor).metrics?.coach_messages.reserved, 2);
  f.state.rights = { ...f.state.rights, capabilities: ['coach'] };
  const lower = createUsageLedger(f.options(f.db, testPolicy(1)));
  assert.equal(lower.usage.status(actor).metrics?.coach_messages.reserved, 2);
  assert.throws(() => lower.usage.reserve(actor, intent('lower')), code('usage_limit_exceeded'));
  f.ledger.trusted.release(reserved.handle);
  assert.equal(lower.usage.reserve(actor, intent('after-release')).kind, 'new');
});

test('missing policy, grants, provider configuration or required policy fields produces zero dispatch', t => {
  const f = fixture(t);
  const options = f.options();
  const { policy: _policy, ...withoutPolicy } = options;
  const { resolveRights: _rights, ...withoutRights } = options;
  let calls = 0;
  for (const service of [createUsageLedger(withoutPolicy), createUsageLedger(withoutRights)]) {
    assert.throws(() => { const result = service.usage.reserve(actor, intent('disabled')); service.usage.markDispatching(result.handle, 'transcribe'); calls++; },
      code('usage_unconfigured'));
    const { configured, policyId, period, metrics } = service.usage.status(actor);
    assert.deepEqual({ configured, policyId, period, metrics }, { configured: false, policyId: null, period: null, metrics: null });
  }
  f.state.rights = { ...f.state.rights, configuredOperations: [] };
  assert.throws(() => { const r = f.ledger.usage.reserve(actor, intent('provider-missing')); f.ledger.usage.markDispatching(r.handle, 'transcribe'); calls++; },
    code('usage_provider_unconfigured'));
  for (const change of [{ liveRounding: undefined }, { liveMessageCounting: undefined }, { periodResolver: undefined }])
    assert.throws(() => createUsageLedger({ ...options, policy: { ...testPolicy(), ...change } as unknown as UsagePolicy }), code('usage_policy_invalid'));
  assert.equal(calls, 0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM usage_reservations').get() as { n: number }).n, 0);
});

function statusApp(usage: Pick<UsageLimitsPort, 'status'>) {
  type Env = { Variables: { actor: AccountContext | undefined } };
  const app = new Hono<Env>();
  const accounts = new Map([['Bearer synthetic-a', actor], ['Bearer synthetic-b', otherActor]]);
  app.use('/v1/usage', async (c, next) => {
    c.set('actor', accounts.get(c.req.header('authorization') ?? ''));
    await next();
  });
  app.onError((error, c) => {
    if (!(error instanceof DomainError)) throw error;
    return c.json({ error: { code: error.code } }, error.status);
  });
  app.route('/v1/usage', createUsageStatusRoutes<Env>({ context: c => c.get('actor'), usage }));
  return (session?: string, query = '') => app.request(`/v1/usage${query}`, {
    headers: session ? { Authorization: `Bearer ${session}` } : {},
  });
}

test('the usage HTTP route exposes only the authenticated account aggregates without writes', async t => {
  const f = fixture(t, testPolicy(5));
  const settled = f.ledger.usage.reserve(actor, intent('status-settled'));
  f.ledger.usage.markDispatching(settled.handle, 'transcribe');
  f.ledger.trusted.settle(settled.handle, { charges: [{ metric: 'coach_messages', amount: 1 }] });
  const uncertain = f.ledger.usage.reserve(actor, intent('status-unknown'));
  f.ledger.usage.markDispatching(uncertain.handle, 'transcribe');
  f.ledger.trusted.markUnknown(uncertain.handle);
  f.ledger.usage.reserve(actor, intent('status-reserved'));

  const request = statusApp(f.ledger.usage);
  const writes = f.db.prepare('SELECT total_changes() AS count');
  const before = writes.get();
  const noSession = await request();
  assert.equal(noSession.status, 401);
  assert.equal(noSession.headers.get('Cache-Control'), 'no-store');
  const foreignQuery = await request('synthetic-b', '?accountId=account-a');
  assert.equal(foreignQuery.status, 422);

  const first = await request('synthetic-a');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  assert.equal(first.headers.get('X-Content-Type-Options'), 'nosniff');
  const firstBody = await first.json();
  assert.deepEqual(firstBody, f.ledger.usage.status(actor));
  assert.ok(firstBody.metrics);
  assert.deepEqual(firstBody.metrics.coach_messages, { limit: 5, settled: 1, reserved: 1, unknown: 1, remaining: 2 });
  assert.doesNotMatch(JSON.stringify(firstBody), /status-(settled|unknown|reserved)|subject-a|account-a|session-a/);

  const second = await request('synthetic-b');
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).metrics.coach_messages, { limit: 5, settled: 0, reserved: 0, unknown: 0, remaining: 5 });
  f.state.epoch++;
  const revoked = await request('synthetic-a');
  assert.equal(revoked.status, 403);
  assert.deepEqual(await revoked.json(), { error: { code: 'test_actor_revoked' } });
  assert.deepEqual(writes.get(), before);
});

test('the usage HTTP route returns an unconfigured snapshot with no metrics when grants are absent', async t => {
  const f = fixture(t);
  const { resolveRights: _resolveRights, ...options } = f.options();
  const request = statusApp(createUsageLedger(options).usage);
  const response = await request('synthetic-a');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1, configured: false, policyId: null, serverTimeMs: f.state.now, period: null, metrics: null,
    ordinaryWorkoutExecution: 'unrestricted_by_usage_limits',
    ordinaryWorkoutLogging: 'unrestricted_by_usage_limits',
  });
});

test('standard voice has no duration charge; ordinary workout execution and logging have no ledger admission gate', t => {
  const f = fixture(t, testPolicy(0));
  const state = f.ledger.usage.status(actor);
  assert.equal(state.ordinaryWorkoutExecution, 'unrestricted_by_usage_limits');
  assert.equal(state.ordinaryWorkoutLogging, 'unrestricted_by_usage_limits');
  assert.throws(() => f.ledger.usage.reserve(actor, intent('capped-message')), code('usage_limit_exceeded'));
  assert.equal(testPolicy().operations.standard?.metrics.includes('live_voice_ms'), false);
  assert.throws(() => f.ledger.usage.reserve(actor, { ...intent('wrong-charge'), charges: [{ metric: 'live_voice_ms', amount: 1 }] }),
    code('usage_charge_policy_mismatch'));
});

test('migration is additive slot 14 and intent metadata cannot be edited in place', t => {
  const f = fixture(t), item = f.ledger.usage.reserve(actor, intent('immutable'));
  assert.equal(usageMigrationVersion, 14);
  assert.throws(() => f.db.prepare('UPDATE usage_reservations SET subject_id=? WHERE id=?').run('rewritten', item.handle.reservationId), /usage_immutable_intent/);
  assert.throws(() => f.db.prepare('UPDATE usage_charges SET amount=2 WHERE reservation_id=?').run(item.handle.reservationId), /usage_immutable_charge/);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});
