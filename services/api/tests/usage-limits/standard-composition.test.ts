import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { DomainError } from '../../src/errors.js';
import type { Sqlite } from '../../src/storage.js';
import type { LifecycleBindings } from '../../src/lifecycle/types.js';
import {
  createUsageLedger, createStandardUsageObservationCollector, normalizeStandardUsageMetadata, usageMigrationSql, usageOwnedTables,
  type StandardUsageObservationCollector,
  type StandardUsageContext, type StandardUsageEvidence, type UsagePolicy, type UsageReservationResult, type UsageRights,
} from '../../src/usage-limits/index.js';
import {
  createCoachingRequestScope, createStandardTurnController, type StandardCompletionPreparation, type StandardTurnEvidence, type StandardTurnPolicy,
} from '../../src/voice-coaching/index.js';
import { createGroqStandardProvider, type GroqHttp, type GroqStandardConfiguration } from '../../src/voice-coaching/standard/index.js';
import { actor, intent, START, testPolicy } from './fixture.js';

const privateTranscript = 'PRIVATE_TRANSCRIPT_COMPOSITION';
const privateReply = 'PRIVATE_REPLY_COMPOSITION';
const privateAudio = 'PRIVATE_AUDIO_COMPOSITION';
const privateFailure = 'PRIVATE_PROVIDER_ERROR_COMPOSITION';
const configuration: GroqStandardConfiguration = {
  apiKey: 'synthetic-offline-key', transcriptionModel: 'whisper-large-v3-turbo', completionModel: 'fixture-chat-alias',
  speechModel: 'canopylabs/orpheus-v1-english', voice: 'troy',
};
const context: StandardUsageContext = {
  operation: 'complete', sourceId: 'synthetic-http-composition', asOf: '2026-10-01T00:01:00Z', identityKind: 'response',
  modelBinding: { requestedModelId: 'fixture-chat-alias', reportedModelId: 'fixture-chat-revision' },
};
const input = () => ({ audio: new Blob([privateAudio]), format: 'wav' as const });
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});
const completeUsage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 7 } };
const completion = (usage: unknown = completeUsage, status = 200) => json({
  id: 'fixture-response', model: 'fixture-chat-revision', x_groq: { id: 'fixture-request' }, usage,
  choices: [{ finish_reason: 'stop', message: { content: privateReply } }], error: { message: privateFailure },
}, status);
const wav = () => Uint8Array.from(Buffer.from(
  '524946462600000057415645666d74201000000001000100803e0000007d00000200100064617461020000000000', 'hex'));
const responses = (reply = completion(), speech = new Response(wav())) => [json({ text: privateTranscript }), reply, speech];

function fixture(t: TestContext, policy: UsagePolicy | null = testPolicy(9)) {
  const db: Sqlite = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO form_accounts VALUES(?)').run(actor.accountId);
  db.exec(usageMigrationSql);
  const state = { active: true, rights: {
    policyId: 'synthetic-composition-grants', capabilities: ['coach'], configuredOperations: ['standard'],
  } as UsageRights };
  const lifecycle: LifecycleBindings = {
    assertActive(value) {
      if (!state.active || value.accountId !== actor.accountId || value.authUserId !== actor.authUserId
        || value.sessionId !== actor.sessionId || value.epoch !== actor.epoch) throw new DomainError(403, 'test_actor_revoked');
    },
    withActiveWrite(value, effect) {
      lifecycle.assertActive(value); const result = effect(); lifecycle.assertActive(value); return result;
    },
    adultEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'unknown', profileRevision: null }),
  };
  const ledger = createUsageLedger({ db, lifecycle, ...(policy ? { policy } : {}), resolveRights: () => state.rights,
    now: () => START + 60_000 });
  const scope = createCoachingRequestScope(actor, lifecycle, new AbortController().signal);
  const snapshot = () => usageOwnedTables.map(table => ({ table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }));
  return { db, state, ledger, scope, snapshot };
}

function turn(f: ReturnType<typeof fixture>, key: string, scripted: readonly Response[], options: {
  providerConfiguration?: GroqStandardConfiguration; omitTurnPolicy?: boolean; omitPreparation?: boolean; revokeOnSpeech?: boolean;
} = {}) {
  const calls: string[] = [], evidence: StandardTurnEvidence[] = [], reports: StandardUsageEvidence[] = [];
  const reservations: UsageReservationResult[] = [];
  let collector: StandardUsageObservationCollector | undefined;
  let observationCount = 0;
  const selectedIntent = intent(key, 7);
  const http: GroqHttp = async url => {
    const stage = url.endsWith('/audio/transcriptions') ? 'transcribe'
      : url.endsWith('/chat/completions') ? 'complete' : url.endsWith('/audio/speech') ? 'synthesize' : undefined;
    assert.ok(stage, 'the actual provider must use a known standard endpoint');
    assert.equal(f.db.inTransaction, false, 'provider dispatch must follow the outermost SQLite commit');
    const reservation = reservations[0]; assert.ok(reservation);
    assert.deepEqual(f.db.prepare('SELECT stage,dispatched_at_ms FROM usage_dispatches WHERE reservation_id=? AND stage=?')
      .get(reservation.handle.reservationId, stage), { stage, dispatched_at_ms: START + 60_000 });
    calls.push(stage);
    const response = scripted[calls.length - 1]; assert.ok(response, 'unexpected HTTP dispatch');
    if (options.revokeOnSpeech && stage === 'synthesize') f.state.active = false;
    return response;
  };
  const provider = createGroqStandardProvider(options.providerConfiguration ?? configuration, http);
  const prepareCompletion: StandardCompletionPreparation = async (scope, { transcript }) => {
    assert.deepEqual(scope.actor, f.scope.actor);
    scope.signal.throwIfAborted();
    scope.assertCurrent();
    return { text: transcript };
  };
  const policy: StandardTurnPolicy = {
    intent: selectedIntent,
    resolve(value) {
      evidence.push(value);
      reports.push(normalizeStandardUsageMetadata(value.stages.find(stage => stage.stage === 'complete')?.metadata, context));
      // This explicit synthetic counting rule is independent of token telemetry and adopts no commercial policy.
      return value.completed ? { kind: 'settle', settlement: { charges: [{ metric: 'coach_messages', amount: 3 }] } }
        : { kind: 'unknown' };
    },
  };
  const controller = createStandardTurnController({ provider, trusted: f.ledger.trusted,
    usage: { ...f.ledger.usage, reserve(value, supplied) {
      const result = f.ledger.usage.reserve(value, supplied); reservations.push(result);
      if (result.kind === 'new') {
        const original = result.handle;
        collector = createStandardUsageObservationCollector({ expected: {
          actor: original.actor, reservationId: original.reservationId, operation: original.operation,
          intentHash: original.intentHash, subjectId: original.subjectId,
        }, contexts: { transcribe: undefined, complete: context, synthesize: undefined } });
      }
      return result;
    } },
    observeStages(observation) {
      observationCount++; assert.ok(collector); collector.observe(observation);
    },
    ...(options.omitTurnPolicy ? {} : { policy }),
    ...(options.omitPreparation ? {} : { prepareCompletion }),
  });
  return { controller, calls, evidence, reports, reservations, observation: () => collector?.snapshot(), observationCount: () => observationCount };
}

function assertNoContent(f: ReturnType<typeof fixture>): void {
  const stored = JSON.stringify(f.snapshot());
  for (const secret of [privateTranscript, privateReply, privateAudio, privateFailure]) assert.equal(stored.includes(secret), false);
  assert.deepEqual(f.db.prepare('SELECT * FROM usage_economics').all(), []);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
}

test('actual standard provider, workflow, ledger and normalizer separate configured quota settlement from reported token units', async t => {
  const f = fixture(t), run = turn(f, 'successful-turn', responses());
  const result = await run.controller.run(f.scope, input());
  assert.equal(result.outcome.kind, 'succeeded'); assert.equal(result.accounting, 'settled');
  if (result.outcome.kind === 'succeeded') assert.deepEqual(result.outcome.value.audio, wav());
  assert.deepEqual(run.calls, ['transcribe', 'complete', 'synthesize']);
  assert.deepEqual(run.evidence[0]?.stages.map(stage => [stage.stage, stage.permit, stage.outcome]),
    [['transcribe', 'granted', 'succeeded'], ['complete', 'granted', 'succeeded'], ['synthesize', 'granted', 'succeeded']]);
  const report = run.reports[0]; assert.ok(report); assert.equal(report.kind, 'qualified');
  if (report.kind === 'qualified') assert.deepEqual(report.units, [
    { unitId: 'input_uncached_tokens', quantity: 13 }, { unitId: 'input_cached_tokens', quantity: 7 }, { unitId: 'output_tokens', quantity: 5 },
  ]);
  assert.equal(report.reported?.requestedModelId, 'fixture-chat-alias');
  assert.equal(report.reported?.reportedModelId, 'fixture-chat-revision');
  assert.equal(report.pricingState, 'unconfigured'); assert.equal(report.actualBilledCost, false);
  const captured = run.observation(); assert.ok(captured);
  assert.deepEqual(captured.stages[1]?.usage, report); assert.equal(run.observationCount(), 1);
  assert.deepEqual(captured.binding.actor, actor);
  assert.equal(captured.binding.reservationId, run.reservations[0]?.handle.reservationId);
  assert.equal(Object.hasOwn(result, 'observation'), false);
  for (const secret of [privateTranscript, privateReply, privateAudio, privateFailure])
    assert.equal(JSON.stringify([run.evidence, run.reports, captured]).includes(secret), false);
  const metrics = f.ledger.usage.status(actor).metrics;
  assert.deepEqual(metrics?.coach_messages, { limit: 9, settled: 3, reserved: 0, unknown: 0, remaining: 6 });
  assert.equal(metrics?.live_voice_ms.settled, 0); assert.equal(metrics?.workout_generations.settled, 0);
  assertNoContent(f);
});

test('the same immutable controller intent replays without provider HTTP or a second settlement', async t => {
  const f = fixture(t), run = turn(f, 'same-turn', responses());
  assert.equal((await run.controller.run(f.scope, input())).accounting, 'settled');
  const before = f.snapshot(), originalObservation = run.observation();
  assert.deepEqual(await run.controller.run(f.scope, input()), {
    outcome: { kind: 'not_dispatched', reason: 'usage_replay_no_dispatch' }, accounting: 'replay',
  });
  assert.deepEqual(run.reservations.map(reservation => reservation.kind), ['new', 'replay']);
  assert.equal(run.calls.length, 3); assert.equal(run.evidence.length, 1);
  assert.equal(run.observationCount(), 1); assert.equal(run.observation(), originalObservation);
  assert.deepEqual(f.snapshot(), before); assertNoContent(f);
});

test('a fresh controller and key cannot dispatch when its reservation exceeds the remaining real quota', async t => {
  const f = fixture(t), first = turn(f, 'first-turn', responses());
  assert.equal((await first.controller.run(f.scope, input())).accounting, 'settled');
  const before = f.snapshot(), next = turn(f, 'new-turn', responses());
  assert.deepEqual(await next.controller.run(f.scope, input()), {
    outcome: { kind: 'not_dispatched', reason: 'usage_reservation_unavailable' }, accounting: 'unresolved',
  });
  assert.deepEqual(next.calls, []); assert.deepEqual(next.reservations, []);
  assert.equal(next.observation(), undefined); assert.equal(next.observationCount(), 0);
  assert.deepEqual(f.snapshot(), before); assertNoContent(f);
});

test('missing ledger policy, server rights, turn policy, preparation or provider configuration produces zero HTTP and zero accounting rows', async t => {
  for (const missing of ['ledger-policy', 'rights', 'turn-policy', 'preparation', 'provider'] as const) {
    const f = fixture(t, missing === 'ledger-policy' ? null : testPolicy(9));
    if (missing === 'rights') f.state.rights = { ...f.state.rights, capabilities: [] };
    const run = turn(f, `missing-${missing}`, responses(), {
      ...(missing === 'turn-policy' ? { omitTurnPolicy: true } : {}),
      ...(missing === 'preparation' ? { omitPreparation: true } : {}),
      ...(missing === 'provider' ? { providerConfiguration: {} } : {}),
    });
    const result = await run.controller.run(f.scope, input());
    assert.equal(result.outcome.kind, 'not_dispatched', missing);
    assert.deepEqual(run.calls, []); assert.deepEqual(run.reservations, []); assert.deepEqual(run.evidence, []);
    assert.equal(run.observation(), undefined); assert.equal(run.observationCount(), 0);
    assert.ok(f.snapshot().every(table => table.rows.length === 0), missing);
    assertNoContent(f);
  }
});

test('partial actual completion telemetry stays unknown while the explicitly configured completed-turn quota still settles', async t => {
  const f = fixture(t), run = turn(f, 'partial-telemetry', responses(completion({ prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 })));
  assert.equal((await run.controller.run(f.scope, input())).accounting, 'settled');
  const report = run.reports[0]; assert.ok(report); assert.equal(report.kind, 'unknown');
  assert.equal(report.reported?.telemetry?.status, 'partial');
  assert.equal(Object.hasOwn(report.reported?.telemetry ?? {}, 'cachedPromptTokens'), false);
  assert.equal(Object.hasOwn(report, 'units'), false); assert.equal(report.actualBilledCost, false);
  assert.deepEqual(run.observation()?.stages[1]?.usage, report);
  assert.equal(f.ledger.usage.status(actor).metrics?.coach_messages.settled, 3); assertNoContent(f);
});

test('zero token metadata on an actual rejected completion does not erase the earlier successful stage or release its liability', async t => {
  const f = fixture(t), run = turn(f, 'rejected-completion', responses(completion({
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 },
  }, 400)));
  const result = await run.controller.run(f.scope, input());
  assert.equal(result.outcome.kind, 'rejected'); assert.equal(result.accounting, 'unknown');
  assert.deepEqual(run.calls, ['transcribe', 'complete']);
  assert.equal(run.evidence[0]?.stages[0]?.outcome, 'succeeded');
  assert.equal(run.evidence[0]?.stages[1]?.outcome, 'rejected');
  const report = run.reports[0]; assert.ok(report); assert.equal(report.kind, 'qualified');
  if (report.kind === 'qualified') assert.deepEqual(report.units.map(unit => unit.quantity), [0, 0, 0]);
  assert.equal(report.actualBilledCost, false);
  assert.deepEqual(run.observation()?.stages[1]?.usage, report);
  assert.equal(JSON.stringify([run.evidence, run.reports]).includes(privateFailure), false);
  assert.deepEqual(f.ledger.usage.status(actor).metrics?.coach_messages, { limit: 9, settled: 0, reserved: 0, unknown: 7, remaining: 2 });
  assertNoContent(f);
});

test('unknown final-stage HTTP retains the whole hold until trusted original-handle settlement after revocation', async t => {
  const f = fixture(t), run = turn(f, 'unknown-speech', responses(completion(), json({ error: privateFailure }, 503)));
  const result = await run.controller.run(f.scope, input());
  assert.equal(result.outcome.kind, 'unknown'); assert.equal(result.accounting, 'unknown');
  assert.deepEqual(run.calls, ['transcribe', 'complete', 'synthesize']);
  assert.deepEqual(run.evidence, []); assert.deepEqual(run.reports, []);
  const captured = run.observation(); assert.ok(captured);
  assert.equal(run.observationCount(), 1); assert.equal(captured.completed, false);
  assert.equal(captured.stages[1]?.usage.kind, 'qualified');
  assert.equal(captured.stages[2]?.outcome, 'unknown'); assert.equal(captured.stages[2]?.usage.kind, 'unknown');
  for (const secret of [privateTranscript, privateReply, privateAudio, privateFailure]) assert.equal(JSON.stringify(captured).includes(secret), false);
  assert.deepEqual(f.ledger.usage.status(actor).metrics?.coach_messages, { limit: 9, settled: 0, reserved: 0, unknown: 7, remaining: 2 });
  const reservation = run.reservations[0]; assert.ok(reservation);
  const before = f.snapshot();
  assert.throws(() => f.ledger.trusted.release(reservation.handle),
    (error: unknown) => error instanceof DomainError && error.code === 'usage_release_requires_reconciliation');
  assert.deepEqual(f.snapshot(), before);
  f.state.active = false;
  assert.throws(() => f.ledger.usage.reserve(actor, intent('after-revocation')),
    (error: unknown) => error instanceof DomainError && error.code === 'test_actor_revoked');
  const reconciliation = { outcome: 'settled' as const, evidenceId: 'synthetic-authoritative-completed-stage-usage',
    settlement: { charges: [{ metric: 'coach_messages' as const, amount: 3 }] } };
  const settled = f.ledger.trusted.reconcile(reservation.handle, reconciliation);
  assert.deepEqual(settled.metrics?.coach_messages, { limit: 9, settled: 3, reserved: 0, unknown: 0, remaining: 6 });
  assert.deepEqual(f.ledger.trusted.reconcile(reservation.handle, reconciliation), settled);
  assert.equal(run.calls.length, 3); assertNoContent(f);
});

test('revocation during actual speech HTTP preserves private original-reservation metadata without publishing stale review', async t => {
  const f = fixture(t), run = turn(f, 'revoked-during-speech', responses(), { revokeOnSpeech: true });
  const result = await run.controller.run(f.scope, input());
  assert.equal(f.state.active, false);
  assert.equal(result.outcome.kind, 'unknown'); assert.equal(result.accounting, 'unknown');
  assert.equal(Object.hasOwn(result, 'review'), false); assert.equal(Object.hasOwn(result, 'observation'), false);
  assert.deepEqual(run.calls, ['transcribe', 'complete', 'synthesize']);
  assert.deepEqual(run.evidence, []); assert.deepEqual(run.reports, []);
  const captured = run.observation(); assert.ok(captured);
  assert.equal(run.observationCount(), 1); assert.equal(captured.completed, false);
  assert.deepEqual(captured.binding.actor, actor);
  assert.equal(captured.binding.reservationId, run.reservations[0]?.handle.reservationId);
  assert.equal(captured.stages[1]?.usage.kind, 'qualified');
  assert.equal(captured.stages[2]?.outcome, 'unknown'); assert.equal(captured.stages[2]?.usage.kind, 'unknown');
  assert.deepEqual(f.db.prepare('SELECT settled,reserved,unknown FROM usage_counters WHERE account_id=? AND metric=?')
    .get(actor.accountId, 'coach_messages'), { settled: 0, reserved: 0, unknown: 7 });
  for (const secret of [privateTranscript, privateReply, privateAudio, privateFailure]) assert.equal(JSON.stringify(captured).includes(secret), false);
  assertNoContent(f);
});
