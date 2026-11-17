import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { DomainError } from '../../src/errors.js';
import type { AccountContext, LifecycleBindings } from '../../src/lifecycle/types.js';
import type { createGroundedAnswerHost } from '../../src/integration/grounded-answer.js';
import { createStandardCoachingRoutes } from '../../src/integration/standard-coaching/routes.js';
import type { StandardCoachingConfiguration, StandardCoachingTurnRequest } from '../../src/integration/standard-coaching/composition.js';
import {
  createStandardTurnUsageBinding, standardNoStageSucceededEvidenceId, standardVoiceTurnOperation,
} from '../../src/integration/standard-coaching/usage-binding.js';
import type { StandardPartialTurnCounting } from '../../src/integration/standard-coaching/usage-binding.js';
import { createUsageLedger, createUsageLimitsConfiguration, usageMigrationSql, usageOwnedTables } from '../../src/usage-limits/index.js';
import type { UsageIntent, UsageLedger, UsageReservationResult } from '../../src/usage-limits/index.js';
import type { StandardOutcome, StandardProvider, StandardSpeech } from '../../src/voice-coaching/standard/index.js';
import { createStandardWireCodec } from '../../src/voice-coaching/standard/wire-codec.js';
import type { CoachingRequestScope } from '../../src/voice-coaching/contracts.js';
import type { StandardTurnEvidence, StandardTurnStageEvidence } from '../../src/voice-coaching/index.js';
import { actor, START } from '../usage-limits/fixture.js';
import { exampleGrantState, exampleGrants, exampleUsagePolicyConfig } from '../usage-limits/policy-fixture.js';

const limits = { maxAudioBytes: 128, maxEnvelopeBytes: 4096, maxTextCharacters: 128 };
const codec = createStandardWireCodec(limits);
const markers = { transcript: 'PRIVATE_TRANSCRIPT_USAGE', reply: 'PRIVATE_REPLY_USAGE', audio: 'PRIVATE_AUDIO_USAGE' };
const audioBytes = new TextEncoder().encode(markers.audio), otherAudioBytes = new TextEncoder().encode('PRIVATE_OTHER_AUDIO_USAGE');
const speech: StandardSpeech = { audio: new Uint8Array([82, 73, 70, 70, 1, 2, 3]), mediaType: 'audio/wav' };
const defaultRequest = codec.encodeRequest({ audio: audioBytes, mediaType: 'audio/wav' });
const otherRequest = codec.encodeRequest({ audio: otherAudioBytes, mediaType: 'audio/wav' });
const url = 'https://form.example.invalid/v1/coaching/standard/turn';
const stageList = ['transcribe', 'complete', 'synthesize'] as const;
type StageName = typeof stageList[number];
type Behaviour<T> = () => StandardOutcome<T> | Promise<StandardOutcome<T>>;

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
const drain = async (rounds = 25) => { for (let i = 0; i < rounds; i++) await new Promise<void>(setImmediate); };
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise<void>(setImmediate);
  assert.ok(condition(), 'condition was not reached');
}
function refusal(action: () => unknown, code: string, status: number, label: string = code): void {
  try { action(); } catch (error) {
    assert.ok(error instanceof DomainError, `${label}: expected DomainError, got ${String(error)}`);
    assert.deepEqual([error.status, error.code], [status, code], label);
    return;
  }
  assert.fail(`${label}: expected ${status} ${code}`);
}

type Row = { operation: string; state: string; idempotency_key: string; account_epoch: number; evidence_id: string | null };
function fixture(t: TestContext, options: { cap?: number; counting?: StandardPartialTurnCounting; configured?: boolean } = {}) {
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO form_accounts VALUES(?)').run(actor.accountId);
  db.exec(usageMigrationSql);
  const state = { active: true, epoch: 1, actor: actor as AccountContext };
  const clock = { ms: START + 60_000 };
  const grantState = exampleGrantState(['cap.standard']);
  const lifecycle: LifecycleBindings = {
    assertActive(context) { if (!state.active || context.epoch !== state.epoch) throw new DomainError(403, 'test_actor_revoked'); },
    withActiveWrite(context, effect) { lifecycle.assertActive(context); const result = effect(); lifecycle.assertActive(context); return result; },
    adultEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'eligible', profileRevision: 1 }),
  };
  const configuration = options.configured === false ? undefined : createUsageLimitsConfiguration({
    policy: exampleUsagePolicyConfig({ limits: { live_voice_ms: 9_000_000, coach_messages: options.cap ?? 1000, workout_generations: 100 } }),
    grants: exampleGrants(grantState, ['standard_voice_turn']),
  });
  const ledger: UsageLedger = createUsageLedger({ db, lifecycle, now: () => clock.ms, ...(configuration ?? {}) });

  const calls: string[] = [], scopes: CoachingRequestScope[] = [], intents: UsageIntent[] = [], turns: { authorized: boolean }[] = [];
  const turnRequests: StandardCoachingTurnRequest[] = [];
  const script: { transcribe?: Behaviour<string>; complete?: Behaviour<string>; synthesize?: Behaviour<StandardSpeech> } = {};
  const gates: Partial<Record<StageName, Promise<void>>> = {};
  const hooks: { afterReserve?: (result: UsageReservationResult) => void } = {};
  const provider: StandardProvider = {
    enabled: true,
    async transcribe() {
      calls.push('transcribe'); if (gates.transcribe) await gates.transcribe;
      return script.transcribe ? script.transcribe() : { kind: 'succeeded', value: markers.transcript };
    },
    async complete() {
      calls.push('complete'); if (gates.complete) await gates.complete;
      return script.complete ? script.complete() : { kind: 'succeeded', value: markers.reply };
    },
    async synthesize() {
      calls.push('synthesize'); if (gates.synthesize) await gates.synthesize;
      return script.synthesize ? script.synthesize() : { kind: 'succeeded', value: speech };
    },
  };
  const wrapped: Pick<UsageLedger, 'usage' | 'trusted'> = {
    trusted: ledger.trusted,
    usage: { ...ledger.usage, reserve(received, intent) {
      intents.push(intent);
      const result = ledger.usage.reserve(received, intent);
      hooks.afterReserve?.(result);
      return result;
    } },
  };
  // Structural fake: the real grounded host needs a private projection that Lift does not carry.
  const host = { configured: true, answer(received: AccountContext, _request: unknown, assertCurrent: (actor: AccountContext) => void) {
    assertCurrent(received); return { status: 'informative' };
  } } as unknown as ReturnType<typeof createGroundedAnswerHost>;
  const counting = options.counting ?? 'settle_one';
  const configurationForRoutes: StandardCoachingConfiguration = { limits, deadlineMs: 5000, forTurn(scope, turn) {
    scopes.push(scope); turnRequests.push(turn);
    const authority = { authorized: true }; turns.push(authority);
    return {
      assertCurrent() { if (!authority.authorized) throw new DomainError(403, 'synthetic_authority_revoked'); },
      grounding: { host, request: { retrieval: { query: 'FLE-S01', topic: 'EXU-B5', access: 'full', limit: 1 },
        context: { revision: 'synthetic:1', facts: [], supersedesRevision: null } },
        maxTextCharacters: 32_000, maxProviderTextBytes: 200_000,
        assertAuthorized(received) { received.assertCurrent(); }, assertDisclosureAllowed(received) { received.assertCurrent(); } },
      provider,
      ...createStandardTurnUsageBinding({ ledger: wrapped, turn, subjectId: 'synthetic-subject', partialTurnCounting: counting }),
    };
  } };
  const app = new Hono();
  app.onError((error, c) => error instanceof DomainError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: 'unexpected' }, 500));
  app.route('/v1/coaching/standard', createStandardCoachingRoutes({ context: () => state.actor, lifecycle, configuration: configurationForRoutes }));

  const send = (key?: string, body: string = defaultRequest, signal?: AbortSignal) => app.fetch(new Request(url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(key === undefined ? {} : { 'idempotency-key': key }) }, body, ...(signal ? { signal } : {}) }));
  const snapshot = () => usageOwnedTables.map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
  const rows = () => db.prepare('SELECT operation,state,idempotency_key,account_epoch,evidence_id FROM usage_reservations ORDER BY rowid').all() as Row[];
  const metrics = () => ledger.usage.status(actor).metrics ?? assert.fail('no metrics');
  return { db, state, clock, grantState, ledger, calls, scopes, intents, turns, turnRequests, script, gates, hooks, app, send, snapshot, rows, metrics, configuration: configurationForRoutes };
}
type Fixture = ReturnType<typeof fixture>;
const decode = async (response: Response) => codec.decodeResult(await response.text());
const body = async (response: Response) => await response.json() as { error: { code: string } };
function assertNoTimeCharged(f: Fixture): void {
  const live = f.db.prepare("SELECT settled,reserved,unknown FROM usage_counters WHERE metric='live_voice_ms'").all() as
    { settled: number; reserved: number; unknown: number }[];
  assert.ok(live.every(row => row.settled === 0 && row.reserved === 0 && row.unknown === 0), 'no live_voice_ms counter may move');
  assert.deepEqual(f.db.prepare("SELECT count(*) AS n FROM usage_charges WHERE metric<>'coach_messages'").get(), { n: 0 });
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const failed = (kind: 'rejected' | 'unknown' = 'rejected'): Behaviour<never> => () => ({ kind, reason: 'synthetic' });

test('a successful turn settles exactly one coach message against the real ledger', async t => {
  const f = fixture(t, { cap: 5 });
  const response = await f.send('key-success-1');
  assert.equal(response.status, 200);
  const result = await decode(response);
  assert.equal(result.outcome.kind, 'succeeded'); assert.equal(result.accounting, 'settled');
  assert.deepEqual(result.review, { transcript: markers.transcript, reply: markers.reply });
  assert.deepEqual(f.calls, ['transcribe', 'complete', 'synthesize']);
  assert.deepEqual(f.metrics().coach_messages, { limit: 5, settled: 1, reserved: 0, unknown: 0, remaining: 4 });
  assert.deepEqual(f.rows(), [{ operation: 'standard_voice_turn', state: 'settled', idempotency_key: 'key-success-1', account_epoch: 1, evidence_id: null }]);
  assert.deepEqual(f.db.prepare('SELECT metric,amount,settled_amount FROM usage_charges').all(), [{ metric: 'coach_messages', amount: 1, settled_amount: 1 }]);
  assert.deepEqual(f.intents.map(intent => [intent.operation, intent.dispatchStages, intent.charges]),
    [[standardVoiceTurnOperation, ['transcribe', 'complete', 'synthesize'], [{ metric: 'coach_messages', amount: 1 }]]]);
  assertNoTimeCharged(f);
});

test('a retry with the same key and body replays without any provider call or ledger write', async t => {
  const f = fixture(t, { cap: 5 });
  assert.equal((await decode(await f.send('key-replay-1'))).accounting, 'settled');
  const before = f.snapshot();
  const response = await f.send('key-replay-1');
  assert.equal(response.status, 200);
  assert.deepEqual(await decode(response), { outcome: { kind: 'not_dispatched', reason: 'usage_replay_no_dispatch' }, accounting: 'replay' });
  assert.equal(f.calls.length, 3); assert.deepEqual(f.snapshot(), before);
  assert.equal(f.scopes.length, 2);
});

test('the same key with different audio is a key conflict that cannot dispatch and leaves the ledger untouched', async t => {
  const f = fixture(t, { cap: 5 });
  await f.send('key-mismatch-1');
  const before = f.snapshot();
  const response = await f.send('key-mismatch-1', otherRequest);
  assert.equal(response.status, 200);
  assert.deepEqual(await decode(response), { outcome: { kind: 'not_dispatched', reason: 'usage_key_conflict' }, accounting: 'not_reserved' });
  assert.equal(f.calls.length, 3); assert.deepEqual(f.snapshot(), before);
  assert.notEqual(f.intents[0]?.intentHash, f.intents[1]?.intentHash);
});

test('a new key is a new reservation', async t => {
  const f = fixture(t, { cap: 5 });
  await f.send('key-new-0001'); await f.send('key-new-0002');
  assert.equal(f.metrics().coach_messages.settled, 2); assert.equal(f.rows().length, 2);
  assert.equal(f.calls.length, 6);
});

test('a missing or malformed Idempotency-Key is refused before any reservation or provider call', async t => {
  const f = fixture(t, { cap: 5 });
  const missing = await f.send();
  assert.equal(missing.status, 400); assert.equal((await body(missing)).error.code, 'idempotency_key_required');
  assert.equal(f.scopes.length, 1, 'the factory runs for the missing-key case and refuses there');
  const scopesBefore = f.scopes.length;
  for (const key of ['bad key', 'k'.repeat(200), 'short', 'a'.repeat(129), 'has/slash-key', 'émoji-key-1']) {
    const response = await f.send(key);
    assert.equal(response.status, 400, key); assert.equal((await body(response)).error.code, 'idempotency_key_invalid', key);
  }
  assert.equal(f.scopes.length, scopesBefore, 'invalid keys are refused before forTurn');
  assert.deepEqual(f.rows(), []); assert.deepEqual(f.calls, []);
  assert.ok(f.snapshot().every(table => table.rows.length === 0));
  assert.equal((await f.send('a'.repeat(128))).status, 200);
});

test('a reached cap is a distinct usage_limit_reached outcome, pins the 429 at the ledger, and does not burn the key', async t => {
  const f = fixture(t, { cap: 1 });
  assert.equal((await decode(await f.send('key-cap-0001'))).accounting, 'settled');
  const before = f.snapshot(), calls = f.calls.length;
  const response = await f.send('key-cap-0002');
  assert.equal(response.status, 200);
  assert.deepEqual(await decode(response), { outcome: { kind: 'not_dispatched', reason: 'usage_limit_reached' }, accounting: 'not_reserved' });
  assert.equal(f.calls.length, calls); assert.deepEqual(f.snapshot(), before);
  const refused = f.intents[1] ?? assert.fail('the refused reserve was observed');
  refusal(() => f.ledger.usage.reserve(actor, refused), 'usage_limit_exceeded', 429);
  assert.deepEqual(f.snapshot(), before);
  // The refusal threw before any insert, so the same key succeeds once the next calendar period opens.
  f.clock.ms = START + 40 * 86_400_000;
  const next = await decode(await f.send('key-cap-0002'));
  assert.equal(next.outcome.kind, 'succeeded'); assert.equal(next.accounting, 'settled');
  assert.equal(f.calls.length, calls + 3);
  assert.deepEqual(f.rows().map(row => [row.idempotency_key, row.state]), [['key-cap-0001', 'settled'], ['key-cap-0002', 'settled']]);
});

test('a definitely rejected first stage releases the reservation with the no-stage evidence', async t => {
  const f = fixture(t, { cap: 5 });
  f.script.transcribe = failed('rejected');
  const result = await decode(await f.send('key-reject-001'));
  assert.equal(result.outcome.kind, 'rejected'); assert.equal(result.accounting, 'not_consumed');
  assert.deepEqual(f.calls, ['transcribe']);
  assert.deepEqual(f.rows(), [{ operation: 'standard_voice_turn', state: 'released', idempotency_key: 'key-reject-001', account_epoch: 1,
    evidence_id: 'standard-turn-no-stage-succeeded-v1' }]);
  assert.equal(standardNoStageSucceededEvidenceId, 'standard-turn-no-stage-succeeded-v1');
  assert.deepEqual(f.metrics().coach_messages, { limit: 5, settled: 0, reserved: 0, unknown: 0, remaining: 5 });
  delete f.script.transcribe;
  assert.equal((await decode(await f.send('key-reject-002'))).accounting, 'settled');
  assert.equal(f.metrics().coach_messages.settled, 1);
  assertNoTimeCharged(f);
});

test('an unknown or thrown completion keeps the unit held until trusted reconciliation', async t => {
  for (const mode of ['unknown', 'thrown'] as const) {
    const f = fixture(t, { cap: 5 });
    f.script.complete = mode === 'unknown' ? failed('unknown') : () => { throw new Error('synthetic provider failure'); };
    const result = await decode(await f.send(`key-unknown-${mode}`));
    assert.equal(result.outcome.kind, 'unknown', mode); assert.equal(result.accounting, 'unknown', mode);
    assert.deepEqual(f.calls, ['transcribe', 'complete'], mode);
    assert.deepEqual(f.metrics().coach_messages, { limit: 5, settled: 0, reserved: 0, unknown: 1, remaining: 4 }, mode);
    const row = f.rows()[0] ?? assert.fail('a reservation row exists');
    assert.equal(row.state, 'unknown', mode);
    const reservationId = (f.db.prepare('SELECT id FROM usage_reservations').get() as { id: string }).id;
    const handle = f.ledger.trusted.recover(actor, reservationId);
    refusal(() => f.ledger.trusted.release(handle), 'usage_release_requires_reconciliation', 409, mode);
    const settled = f.ledger.trusted.reconcile(handle, { outcome: 'settled', evidenceId: 'synthetic-reconciliation-evidence',
      settlement: { charges: [{ metric: 'coach_messages', amount: 1 }] } });
    assert.deepEqual(settled.metrics?.coach_messages, { limit: 5, settled: 1, reserved: 0, unknown: 0, remaining: 4 }, mode);
    assertNoTimeCharged(f);
  }
});

test('a partly failed turn follows the explicit counting mode and never silently releases', async t => {
  const expected = {
    settle_one: { accounting: 'settled', state: 'settled', counters: { settled: 1, reserved: 0, unknown: 0 } },
    settle_zero: { accounting: 'settled', state: 'settled', counters: { settled: 0, reserved: 0, unknown: 0 } },
    retain_unknown: { accounting: 'unknown', state: 'unknown', counters: { settled: 0, reserved: 0, unknown: 1 } },
  } as const;
  for (const counting of ['settle_one', 'settle_zero', 'retain_unknown'] as const) {
    const f = fixture(t, { cap: 5, counting });
    f.script.complete = failed('rejected');
    const result = await decode(await f.send(`key-partial-${counting}`));
    assert.equal(result.outcome.kind, 'rejected', counting); assert.equal(result.accounting, expected[counting].accounting, counting);
    assert.deepEqual(f.calls, ['transcribe', 'complete'], counting);
    assert.equal(f.rows()[0]?.state, expected[counting].state, counting); assert.equal(f.rows()[0]?.evidence_id, null, counting);
    const { limit, remaining, ...counters } = f.metrics().coach_messages;
    assert.deepEqual(counters, expected[counting].counters, counting);
    assert.equal(limit, 5); assert.equal(remaining, 5 - counters.settled - counters.unknown, counting);
    assertNoTimeCharged(f);
  }
});

test('a client abort during the first stage ends in unknown when the provider then fails and follows the counting mode when it succeeds', async t => {
  const failing = fixture(t, { cap: 5, counting: 'settle_one' }), gate = deferred();
  failing.gates.transcribe = gate.promise;
  const abort = new AbortController(), pending = failing.send('key-abort-fail-1', defaultRequest, abort.signal);
  await until(() => failing.calls.includes('transcribe')); abort.abort();
  const response = await pending;
  assert.equal(response.status, 503); assert.equal((await body(response)).error.code, 'standard_coaching_interrupted');
  gate.reject(new Error('synthetic provider failure')); await drain();
  assert.equal(failing.rows()[0]?.state, 'unknown'); assert.equal(failing.metrics().coach_messages.unknown, 1);
  assert.deepEqual(failing.calls, ['transcribe']);

  for (const counting of ['settle_one', 'retain_unknown'] as const) {
    const succeeding = fixture(t, { cap: 5, counting }), open = deferred();
    succeeding.gates.transcribe = open.promise;
    const controller = new AbortController(), request = succeeding.send('key-abort-ok-001', defaultRequest, controller.signal);
    await until(() => succeeding.calls.includes('transcribe')); controller.abort();
    assert.equal((await request).status, 503, counting);
    open.resolve(); await drain();
    assert.deepEqual(succeeding.calls, ['transcribe'], counting);
    assert.equal(succeeding.rows()[0]?.state, counting === 'settle_one' ? 'settled' : 'unknown', counting);
    assert.equal(succeeding.metrics().coach_messages[counting === 'settle_one' ? 'settled' : 'unknown'], 1, counting);
    assertNoTimeCharged(succeeding);
  }
});

test('trusted per-turn authority revoked right after reservation releases the unit before any provider call', async t => {
  const f = fixture(t, { cap: 5 });
  f.hooks.afterReserve = () => { const turn = f.turns[0] ?? assert.fail('the turn exists'); turn.authorized = false; };
  const response = await f.send('key-revoked-001');
  assert.equal(response.status, 403); assert.equal((await body(response)).error.code, 'synthetic_authority_revoked');
  assert.deepEqual(f.calls, []);
  assert.equal(f.rows()[0]?.state, 'released');
  assert.deepEqual(f.metrics().coach_messages, { limit: 5, settled: 0, reserved: 0, unknown: 0, remaining: 5 });
});

test('aborting while the request body is held creates no reservation', async t => {
  const f = fixture(t, { cap: 5 });
  const entered = deferred(), abort = new AbortController();
  const held = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); } });
  const pending = f.app.fetch(new Request(url, { method: 'POST', body: held, signal: abort.signal,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-held-body-1' }, ...({ duplex: 'half' } as Record<string, unknown>) }));
  await entered.promise; abort.abort();
  assert.equal((await pending).status, 503);
  assert.equal(f.scopes.length, 0); assert.deepEqual(f.rows(), []); assert.deepEqual(f.calls, []);
});

test('session, epoch and lifecycle fences hold through the real ledger', async t => {
  const sessions = fixture(t, { cap: 5 });
  await sessions.send('key-fence-0001');
  const before = sessions.snapshot(), calls = sessions.calls.length;
  sessions.state.actor = { ...actor, sessionId: 'session-b' };
  const other = await sessions.send('key-fence-0001');
  assert.equal(other.status, 200);
  assert.deepEqual(await decode(other), { outcome: { kind: 'not_dispatched', reason: 'usage_key_conflict' }, accounting: 'not_reserved' });
  assert.equal(sessions.calls.length, calls); assert.deepEqual(sessions.snapshot(), before);

  const expected = { settle_one: ['settled', 1, 0], settle_zero: ['settled', 0, 0], retain_unknown: ['unknown', 0, 1] } as const;
  for (const counting of ['settle_one', 'settle_zero', 'retain_unknown'] as const) {
    const f = fixture(t, { cap: 5, counting });
    f.script.synthesize = () => { f.state.epoch = 2; return { kind: 'succeeded', value: speech }; };
    const bumped = await f.send('key-epoch-0001');
    assert.equal(bumped.status, 403, counting); assert.equal((await body(bumped)).error.code, 'test_actor_revoked', counting);
    const [state, settled, unknown] = expected[counting];
    assert.deepEqual(f.rows().map(row => [row.state, row.account_epoch]), [[state, 1]], counting);
    const counters = f.db.prepare("SELECT settled,unknown FROM usage_counters WHERE metric='coach_messages'").get();
    assert.deepEqual(counters, { settled, unknown }, counting);
    delete f.script.synthesize; f.state.actor = { ...actor, epoch: 2 };
    assert.equal((await decode(await f.send('key-epoch-0002'))).accounting, 'settled', counting);
    assert.deepEqual(f.rows().map(row => row.account_epoch), [1, 2], counting);
    assertNoTimeCharged(f);
  }

  const inactive = fixture(t, { cap: 5 });
  inactive.state.active = false;
  assert.equal((await inactive.send('key-inactive-01')).status, 403);
  assert.deepEqual(inactive.rows(), []); assert.deepEqual(inactive.calls, []); assert.equal(inactive.scopes.length, 0);
});

test('a ledger without a policy is usage_unconfigured and never dispatches or writes', async t => {
  const f = fixture(t, { configured: false });
  const response = await f.send('key-unconfigured');
  assert.equal(response.status, 200);
  assert.deepEqual(await decode(response), { outcome: { kind: 'not_dispatched', reason: 'usage_unconfigured' }, accounting: 'not_reserved' });
  assert.deepEqual(f.calls, []); assert.ok(f.snapshot().every(table => table.rows.length === 0));
  assert.equal(f.ledger.usage.status(actor).configured, false);
});

test('a missing capability is usage_not_entitled with zero rows and no provider call', async t => {
  const f = fixture(t, { cap: 5 });
  f.grantState.capabilities = [];
  const response = await f.send('key-no-entitle');
  assert.equal(response.status, 200);
  assert.deepEqual(await decode(response), { outcome: { kind: 'not_dispatched', reason: 'usage_not_entitled' }, accounting: 'not_reserved' });
  assert.deepEqual(f.calls, []); assert.ok(f.snapshot().every(table => table.rows.length === 0));
  f.grantState.capabilities = ['cap.standard'];
  assert.equal((await decode(await f.send('key-no-entitle'))).accounting, 'settled');
});

test('the client turn key shape std-turn:<id> is accepted and a duplicate delivery is a ledger replay', async t => {
  const uuid = 'std-turn:' + '01234567-89ab-4def-8123-456789abcdef';
  const keys = [uuid, 'std-turn:a', 'std-turn:' + 'a'.repeat(112)];
  assert.deepEqual(keys.map(key => key.length), [45, 10, 121]);
  for (const key of keys) {
    const f = fixture(t, { cap: 5 });
    const response = await f.send(key);
    assert.equal(response.status, 200, key);
    assert.equal((await decode(response)).accounting, 'settled', key);
  }
  const f = fixture(t, { cap: 5 });
  assert.equal((await decode(await f.send(uuid))).accounting, 'settled');
  const before = f.snapshot();
  assert.deepEqual(await decode(await f.send(uuid)), { outcome: { kind: 'not_dispatched', reason: 'usage_replay_no_dispatch' }, accounting: 'replay' });
  assert.equal(f.calls.length, 3); assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.rows().map(row => [row.idempotency_key, row.state]), [[uuid, 'settled']]);
});

test('standard turns charge only messages and ordinary logging flags are never touched', async t => {
  const f = fixture(t, { cap: 20 });
  f.script.complete = failed('rejected'); await f.send('key-mixed-0001');
  delete f.script.complete; await f.send('key-mixed-0002');
  f.script.transcribe = failed('rejected'); await f.send('key-mixed-0003');
  delete f.script.transcribe; f.script.synthesize = failed('unknown'); await f.send('key-mixed-0004');
  assertNoTimeCharged(f);
  const status = f.ledger.usage.status(actor);
  assert.equal(status.ordinaryWorkoutExecution, 'unrestricted_by_usage_limits');
  assert.equal(status.ordinaryWorkoutLogging, 'unrestricted_by_usage_limits');
  assert.equal(status.metrics?.live_voice_ms.remaining, 9_000_000); assert.equal(status.metrics?.workout_generations.remaining, 100);
  assert.deepEqual(f.db.prepare('SELECT DISTINCT metric FROM usage_charges').all(), [{ metric: 'coach_messages' }]);
});

test('usage tables never contain the transcript, reply or audio', async t => {
  const f = fixture(t, { cap: 20 });
  await f.send('key-private-001');
  f.script.complete = failed('unknown'); await f.send('key-private-002');
  const stored = JSON.stringify(f.snapshot());
  const encodedAudio = Buffer.from(audioBytes).toString('base64');
  for (const secret of [markers.transcript, markers.reply, markers.audio, encodedAudio, Buffer.from(speech.audio).toString('base64')])
    assert.equal(stored.includes(secret), false, secret);
});

test('the factory receives the optional header and the SHA-256 of the exact request string', async t => {
  const f = fixture(t, { cap: 5 });
  await f.send('key-digest-001'); await f.send(undefined, otherRequest);
  assert.deepEqual(f.turnRequests, [{ idempotencyKey: 'key-digest-001', requestSha256: sha256(defaultRequest) },
    { idempotencyKey: undefined, requestSha256: sha256(otherRequest) }]);
  assert.ok(f.turnRequests.every(Object.isFrozen));
  assert.notEqual(f.turnRequests[0]?.requestSha256, f.turnRequests[1]?.requestSha256);
});

test('a legacy one-argument factory still type-checks and behaves the same without the header', async t => {
  const f = fixture(t, { cap: 5 });
  const legacy: StandardCoachingConfiguration = { limits, deadlineMs: 5000,
    forTurn(scope) { return f.configuration.forTurn(scope, { idempotencyKey: 'legacy-key-01', requestSha256: 'a'.repeat(64) }); } };
  const app = new Hono();
  app.onError((error, c) => error instanceof DomainError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: 'unexpected' }, 500));
  app.route('/v1/coaching/standard', createStandardCoachingRoutes({ context: () => actor, lifecycle: { assertActive() {} }, configuration: legacy }));
  const response = await app.fetch(new Request(url, { method: 'POST', body: defaultRequest, headers: { 'content-type': 'application/json' } }));
  assert.equal(response.status, 200);
  assert.equal((await decode(response)).accounting, 'settled');
  assert.deepEqual(f.rows().map(row => row.idempotency_key), ['legacy-key-01']);
});

// Binding unit ------------------------------------------------------------------------------------------------------------

const stageEvidence = (...outcomes: StandardTurnStageEvidence['outcome'][]): StandardTurnEvidence => ({
  completed: false,
  stages: stageList.map((stage, index) => ({ stage, permit: outcomes[index] === undefined ? 'not_requested' : 'granted',
    outcome: outcomes[index] ?? 'not_dispatched' })),
});
function binding(overrides: Partial<Parameters<typeof createStandardTurnUsageBinding>[0]> = {}) {
  const unused = { usage: {}, trusted: {} } as unknown as Pick<UsageLedger, 'usage' | 'trusted'>;
  return createStandardTurnUsageBinding({ ledger: unused, turn: { idempotencyKey: 'binding-key-1', requestSha256: 'a'.repeat(64) },
    subjectId: 'synthetic-subject', partialTurnCounting: 'settle_one', ...overrides });
}

test('the binding builds the exact message-only intent and refuses incomplete composition', () => {
  const built = binding(), policy = built.policy ?? assert.fail('a policy is bound');
  assert.deepEqual(policy.intent.charges, [{ metric: 'coach_messages', amount: 1 }]);
  assert.deepEqual(policy.intent.dispatchStages, ['transcribe', 'complete', 'synthesize']);
  assert.equal(policy.intent.operation, 'standard_voice_turn'); assert.equal(policy.intent.idempotencyKey, 'binding-key-1');
  assert.match(policy.intent.intentHash, /^[a-f0-9]{64}$/);
  assert.notEqual(binding({ subjectId: 'another-subject' }).policy?.intent.intentHash, policy.intent.intentHash);
  assert.notEqual(binding({ turn: { idempotencyKey: 'binding-key-1', requestSha256: 'b'.repeat(64) } }).policy?.intent.intentHash, policy.intent.intentHash);
  assert.equal(binding({ turn: { idempotencyKey: 'binding-key-2', requestSha256: 'a'.repeat(64) } }).policy?.intent.intentHash, policy.intent.intentHash);
  refusal(() => binding({ turn: { idempotencyKey: undefined, requestSha256: 'a'.repeat(64) } }), 'idempotency_key_required', 400, 'no key');
  const invalid = 'standard_coaching_usage_binding_invalid';
  refusal(() => binding({ subjectId: 'has space' }), invalid, 503, 'subject');
  refusal(() => binding({ subjectId: '' }), invalid, 503, 'empty subject');
  refusal(() => binding({ partialTurnCounting: undefined as unknown as StandardPartialTurnCounting }), invalid, 503, 'no counting mode');
  refusal(() => binding({ partialTurnCounting: 'settle_all' as StandardPartialTurnCounting }), invalid, 503, 'unknown counting mode');
  refusal(() => binding({ turn: { idempotencyKey: 'binding-key-1', requestSha256: 'A'.repeat(64) } }), invalid, 503, 'digest');
  refusal(() => binding({ ledger: undefined as never }), invalid, 503, 'no ledger');
  refusal(() => binding({ turn: { idempotencyKey: undefined, requestSha256: 'a'.repeat(64) }, subjectId: 'has space' }), invalid, 503, 'composition fault outranks the missing key');
});

test('the binding resolves every evidence shape to a message-only decision', () => {
  const settle = (amount: number) => ({ kind: 'settle', settlement: { charges: [{ metric: 'coach_messages', amount }] } });
  const notConsumed = { kind: 'not_consumed', evidenceId: 'standard-turn-no-stage-succeeded-v1' };
  const all: StandardTurnEvidence = { completed: true, stages: stageList.map(stage => ({ stage, permit: 'granted', outcome: 'succeeded' })) };
  const cases: [string, StandardTurnEvidence][] = [['completed', all], ['no stage', stageEvidence()], ['first rejected', stageEvidence('rejected')],
    ['first not dispatched', stageEvidence('not_dispatched')], ['first ok then rejected', stageEvidence('succeeded', 'rejected')],
    ['two ok then rejected', stageEvidence('succeeded', 'succeeded', 'rejected')], ['first ok then not dispatched', stageEvidence('succeeded', 'not_dispatched')]];
  const expected: Record<StandardPartialTurnCounting, unknown[]> = {
    settle_one: [settle(1), notConsumed, notConsumed, notConsumed, settle(1), settle(1), settle(1)],
    settle_zero: [settle(1), notConsumed, notConsumed, notConsumed, settle(0), settle(0), settle(0)],
    retain_unknown: [settle(1), notConsumed, notConsumed, notConsumed, { kind: 'unknown' }, { kind: 'unknown' }, { kind: 'unknown' }],
  };
  for (const counting of ['settle_one', 'settle_zero', 'retain_unknown'] as const) {
    const policy = binding({ partialTurnCounting: counting }).policy ?? assert.fail('a policy is bound');
    cases.forEach(([label, evidence], index) => {
      const decision = policy.resolve(evidence);
      assert.deepEqual(decision, expected[counting][index], `${counting}: ${label}`);
      if (decision.kind === 'settle') assert.ok(decision.settlement.charges.every(charge => charge.metric === 'coach_messages'), `${counting}: ${label}`);
    });
  }
});
