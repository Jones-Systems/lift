import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccountContext } from '../../src/lifecycle/types.js';
import type {
  ReservationState, TrustedUsageControls, UsageIntent, UsageLimitsPort,
  UsageReservationHandle, UsageSettlement, UsageSnapshot,
} from '../../src/usage-limits/types.js';
import type { CoachingRequestScope, ProviderOutcome } from '../../src/voice-coaching/contracts.js';
import type {
  StandardProvider, StandardProviderMetadata, StandardSpeech, StandardTextInput, StandardUsageField,
} from '../../src/voice-coaching/standard/index.js';
import { createCoachingRequestScope } from '../../src/voice-coaching/request-scope.js';
import {
  createStandardTurnController, standardTurnStages,
  type StandardCompletionPreparation, type StandardTurnEvidence, type StandardTurnPolicy, type StandardTurnObservation,
} from '../../src/voice-coaching/turn-controller.js';

const speech: StandardSpeech = { audio: new Uint8Array([1, 2, 3]), mediaType: 'audio/wav' };
const fullReview = { transcript: 'private transcript', reply: 'private reply' };
const audio = () => ({ audio: new Blob(['recording']), format: 'wav' as const });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const actor = { accountId: 'account-a', authUserId: 'user-a', sessionId: 'session-a', epoch: 1 };
  const abort = new AbortController();
  let activeEpoch = 1;
  const seenActors: AccountContext[] = [];
  const scope = createCoachingRequestScope(actor, { assertActive(value) {
    seenActors.push(value);
    if (value.epoch !== activeEpoch) throw new Error('expired');
  } }, abort.signal);
  const intent: UsageIntent = {
    operation: 'configured_standard_turn', idempotencyKey: 'turn-1', intentHash: 'hash-1', subjectId: 'subject-1',
    charges: [{ metric: 'coach_messages', amount: 7 }], dispatchStages: [...standardTurnStages],
  };
  const settlement: UsageSettlement = { charges: [{ metric: 'coach_messages', amount: 3 }] };
  const snapshot: UsageSnapshot = {
    schemaVersion: 1, configured: true, policyId: 'fixture-policy', serverTimeMs: 1,
    period: null, metrics: null,
    ordinaryWorkoutExecution: 'unrestricted_by_usage_limits', ordinaryWorkoutLogging: 'unrestricted_by_usage_limits',
  };
  const handle = Object.freeze({ reservationId: 'reservation-1', actor: scope.actor,
    operation: intent.operation, intentHash: intent.intentHash, subjectId: intent.subjectId }) as UsageReservationHandle;
  const events: string[] = [];
  const evidence: StandardTurnEvidence[] = [];
  const dispatched = new Set<string>();
  let reserved = false;
  let state: ReservationState = 'reserved';
  const assertHandle = (value: UsageReservationHandle) => { assert.equal(value, handle); assert.equal(value.actor, scope.actor); };
  const usage: UsageLimitsPort = {
    reserve(value, supplied) {
      events.push('reserve'); assert.equal(value, scope.actor); assert.deepEqual(supplied, intent);
      const kind = reserved ? 'replay' as const : 'new' as const;
      reserved = true;
      return { kind, handle, state, snapshot };
    },
    markDispatching(value, stage) {
      assertHandle(value);
      assert.ok(state === 'reserved' || state === 'dispatching');
      const index = standardTurnStages.indexOf(stage as typeof standardTurnStages[number]);
      assert.ok(index >= 0);
      assert.deepEqual([...dispatched], standardTurnStages.slice(0, index));
      assert.equal(dispatched.has(stage), false);
      events.push(`permit:${stage}`); dispatched.add(stage); state = 'dispatching';
      return { reservationId: handle.reservationId, stage, dispatchedAtMs: 10 };
    },
    status() { assert.fail('status is not turn dispatch authority'); },
  };
  const trusted: TrustedUsageControls = {
    recover() { assert.fail('recovery is not turn dispatch authority'); },
    settle(value, actual) {
      assertHandle(value); assert.equal(state, 'dispatching'); assert.deepEqual(actual, settlement);
      events.push('settle'); state = 'settled'; return snapshot;
    },
    release(value) {
      assertHandle(value); assert.equal(state, 'reserved'); assert.equal(dispatched.size, 0);
      events.push('release'); state = 'released'; return snapshot;
    },
    markUnknown(value) {
      assertHandle(value); assert.equal(state, 'dispatching');
      events.push('unknown'); state = 'unknown'; return snapshot;
    },
    reconcile(value, decision) {
      assertHandle(value); assert.equal(state, 'dispatching');
      assert.deepEqual(decision, { outcome: 'not_consumed', evidenceId: 'authoritative-evidence-1' });
      events.push('reconcile'); state = 'released'; return snapshot;
    },
  };
  const provider: StandardProvider = {
    enabled: true,
    async transcribe(value, input) {
      assert.equal(value, scope); assert.equal(input.audio.size, audio().audio.size);
      assert.equal(events.at(-1), 'permit:transcribe'); events.push('transcribe');
      return { kind: 'succeeded', value: 'private transcript' };
    },
    async complete(value, input) {
      assert.equal(value, scope); assert.equal(input.text, 'private transcript');
      assert.equal(events.at(-1), 'permit:complete'); events.push('complete');
      return { kind: 'succeeded', value: 'private reply' };
    },
    async synthesize(value, input) {
      assert.equal(value, scope); assert.equal(input.text, 'private reply');
      assert.equal(events.at(-1), 'permit:synthesize'); events.push('synthesize');
      return { kind: 'succeeded', value: speech };
    },
  };
  const policy: StandardTurnPolicy = {
    intent,
    resolve(value) { evidence.push(value); events.push('resolve'); return { kind: 'settle', settlement }; },
  };
  const prepareCompletion: StandardCompletionPreparation = async (value, input) => {
    assert.equal(value, scope);
    return { text: input.transcript };
  };
  return { actor, scope, abort, intent, settlement, snapshot, handle, events, evidence, usage, trusted, provider, policy, prepareCompletion,
    expire() { activeEpoch = 2; }, seenActors, state: () => state };
}

test('one reservation, three ordered one-use permits, one aggregate configured settlement', async () => {
  const f = fixture();
  const result = await createStandardTurnController(f).run(f.scope, audio());
  assert.deepEqual(result, { outcome: { kind: 'succeeded', value: speech }, accounting: 'settled', review: fullReview });
  assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'transcribe', 'permit:complete', 'complete',
    'permit:synthesize', 'synthesize', 'resolve', 'settle']);
  assert.deepEqual(f.evidence, [{ completed: true, stages: standardTurnStages.map(stage => ({ stage, permit: 'granted', outcome: 'succeeded' })) }]);
  assert.equal(JSON.stringify(f.evidence).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('reservation'), false);
  assert.equal(Object.isFrozen(f.evidence[0]), true);
  assert.ok(f.evidence[0]!.stages.every(Object.isFrozen));
});

test('missing or invalid stage policy and disabled provider perform no reservation or dispatch', async () => {
  for (const mode of ['missing', 'invalid', 'disabled']) {
    const f = fixture();
    const options = mode === 'missing' ? { provider: f.provider, usage: f.usage, trusted: f.trusted, prepareCompletion: f.prepareCompletion }
      : mode === 'invalid' ? { ...f, policy: { ...f.policy, intent: { ...f.intent, dispatchStages: ['transcribe', 'complete'] } } }
      : { ...f, provider: { ...f.provider, enabled: false } };
    assert.deepEqual(await createStandardTurnController(options).run(f.scope, audio()), {
      outcome: { kind: 'not_dispatched', reason: 'standard_turn_disabled' }, accounting: 'not_reserved',
    });
    assert.deepEqual(f.events, []);
  }
});

test('aborted admission is rejected even with a no-op injected scope assertion', async () => {
  const f = fixture(); f.abort.abort();
  const scope: CoachingRequestScope = { actor: f.scope.actor, signal: f.abort.signal, assertCurrent() {} };
  assert.deepEqual(await createStandardTurnController(f).run(scope, audio()), {
    outcome: { kind: 'not_dispatched', reason: 'scope_not_current' }, accounting: 'not_reserved',
  });
  assert.deepEqual(f.events, []);
});

test('replay in every stored state cannot dispatch, recover, or rewrite accounting', async () => {
  for (const state of ['reserved', 'dispatching', 'unknown', 'settled', 'released'] as const) {
    const f = fixture();
    const controller = createStandardTurnController({ ...f, usage: { ...f.usage,
      reserve() { f.events.push('replay'); return { kind: 'replay', handle: f.handle, state, snapshot: f.snapshot }; },
    } });
    assert.deepEqual(await controller.run(f.scope, audio()), {
      outcome: { kind: 'not_dispatched', reason: 'usage_replay_no_dispatch' }, accounting: 'replay',
    });
    assert.deepEqual(f.events, ['replay']);
  }
});

test('reservation failure produces no provider call or invented release handle', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f, usage: { ...f.usage,
    reserve() { f.events.push('reserve-failed'); throw new Error('private ledger details'); },
  } });
  const result = await controller.run(f.scope, audio());
  assert.deepEqual(result, { outcome: { kind: 'not_dispatched', reason: 'usage_reservation_unavailable' }, accounting: 'unresolved' });
  assert.deepEqual(f.events, ['reserve-failed']);
});

test('cancellation after reserve but before a permit releases only the original reservation', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f, usage: { ...f.usage,
    reserve(actor, intent) { const result = f.usage.reserve(actor, intent); f.abort.abort(); return result; },
  } });
  const result = await controller.run(f.scope, audio());
  assert.equal(result.outcome.kind, 'unknown');
  assert.equal(result.accounting, 'released');
  assert.deepEqual(f.events, ['reserve', 'release']);
});

test('first-stage not-dispatched and rejected outcomes need authoritative not-consumed evidence', async () => {
  for (const kind of ['not_dispatched', 'rejected'] as const) {
    const f = fixture();
    const controller = createStandardTurnController({ ...f,
      provider: { ...f.provider, async transcribe() { f.events.push('refused'); return { kind, reason: 'private provider details' }; } },
      policy: { ...f.policy, resolve(evidence) {
        assert.equal(evidence.stages[0]!.outcome, kind);
        return { kind: 'not_consumed', evidenceId: 'authoritative-evidence-1' };
      } },
    });
    assert.deepEqual(await controller.run(f.scope, audio()), {
      outcome: { kind, reason: `standard_transcribe_${kind}` }, accounting: 'not_consumed',
    });
    assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'refused', 'reconcile']);
  }
});

test('refusal after a successful transcription uses configured partial settlement, never release', async () => {
  for (const kind of ['not_dispatched', 'rejected'] as const) {
    const f = fixture();
    const controller = createStandardTurnController({ ...f,
      provider: { ...f.provider, async complete() { f.events.push('refused'); return { kind, reason: 'refused' }; } },
    });
    const result = await controller.run(f.scope, audio());
    assert.equal(result.outcome.kind, kind); assert.equal(result.accounting, 'settled');
    assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'transcribe', 'permit:complete', 'refused', 'resolve', 'settle']);
    assert.deepEqual(f.evidence[0]!.stages.map(stage => stage.outcome), ['succeeded', kind, 'not_dispatched']);
    assert.equal(f.evidence[0]!.completed, false);
  }
});

test('a whole-turn not-consumed decision cannot erase an earlier successful stage', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f,
    provider: { ...f.provider, async complete() { return { kind: 'rejected', reason: 'refused' }; } },
    policy: { ...f.policy, resolve() { return { kind: 'not_consumed', evidenceId: 'authoritative-evidence-1' }; } },
  });
  const result = await controller.run(f.scope, audio());
  assert.equal(result.accounting, 'unknown'); assert.equal(f.state(), 'unknown');
  assert.equal(f.events.includes('reconcile'), false); assert.equal(f.events.includes('release'), false);
});

test('unknown outcome or thrown provider call at any stage retains the whole hold without retry', async () => {
  for (const stage of standardTurnStages) {
    for (const thrown of [false, true]) {
      const f = fixture(); let calls = 0;
      const unknown = async (): Promise<ProviderOutcome<never>> => {
        ++calls;
        if (thrown) throw new Error('private provider error');
        return { kind: 'unknown', reason: 'private provider error' };
      };
      const controller = createStandardTurnController({ ...f, provider: { ...f.provider, [stage]: unknown } });
      const result = await controller.run(f.scope, audio());
      assert.equal(result.outcome.kind, 'unknown'); assert.equal(result.accounting, 'unknown');
      assert.equal(f.state(), 'unknown'); assert.equal(calls, 1);
      assert.equal(f.evidence.length, 0);
      assert.equal(f.events.includes('settle'), false); assert.equal(f.events.includes('release'), false);
      const laterStages = standardTurnStages.slice(standardTurnStages.indexOf(stage) + 1);
      assert.ok(laterStages.every(later => !f.events.includes(`permit:${later}`)));
    }
  }
});

test('a permit failure or mismatched permit never authorizes its provider call', async () => {
  for (const mode of ['throw', 'mismatch'] as const) {
    const f = fixture();
    const controller = createStandardTurnController({ ...f, usage: { ...f.usage,
      markDispatching(handle, stage) {
        const permit = f.usage.markDispatching(handle, stage);
        if (mode === 'throw') throw new Error('acknowledgement lost');
        return { ...permit, stage: 'different-stage' };
      },
    } });
    const result = await controller.run(f.scope, audio());
    assert.equal(result.outcome.kind, 'not_dispatched'); assert.equal(result.accounting, 'unknown');
    assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'unknown']);
  }
});

test('failed permit with no commit preserves unresolved accounting instead of claiming release', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f, usage: { ...f.usage,
    markDispatching() { f.events.push('permit-failed'); throw new Error('unavailable'); },
  } });
  const result = await controller.run(f.scope, audio());
  assert.equal(result.accounting, 'unresolved'); assert.equal(f.state(), 'reserved');
  assert.deepEqual(f.events, ['reserve', 'permit-failed']);
});

test('cancellation after permit skips dispatch and requires explicit trusted resolution', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f,
    usage: { ...f.usage, markDispatching(handle, stage) {
      const permit = f.usage.markDispatching(handle, stage); f.abort.abort(); return permit;
    } },
    policy: { ...f.policy, resolve(evidence) {
      assert.equal(evidence.stages[0]!.permit, 'granted');
      assert.equal(evidence.stages[0]!.outcome, 'not_dispatched');
      return { kind: 'not_consumed', evidenceId: 'authoritative-evidence-1' };
    } },
  });
  const result = await controller.run(f.scope, audio());
  assert.equal(result.outcome.kind, 'unknown'); assert.equal(result.accounting, 'not_consumed');
  assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'reconcile']);
});

test('caller mutation and epoch invalidation after await never rebind old work or accounting', async () => {
  const f = fixture(); const pending = deferred<ProviderOutcome<string>>();
  const controller = createStandardTurnController({ ...f,
    provider: { ...f.provider, transcribe(scope) { assert.equal(scope.actor.accountId, 'account-a'); return pending.promise; } },
  });
  const result = controller.run(f.scope, audio());
  f.actor.accountId = 'account-b'; f.actor.sessionId = 'session-b'; f.actor.epoch = 2; f.expire();
  pending.resolve({ kind: 'succeeded', value: 'private stale text' });
  assert.deepEqual(await result, { outcome: { kind: 'unknown', reason: 'scope_not_current' }, accounting: 'settled' });
  assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'resolve', 'settle']);
  assert.ok(f.seenActors.every(actor => actor.accountId === 'account-a' && actor.sessionId === 'session-a' && actor.epoch === 1));
  assert.equal(f.handle.actor.accountId, 'account-a');
});

test('an abort after an awaited success suppresses the response but preserves configured accounting', async () => {
  const f = fixture();
  const pending = deferred<ProviderOutcome<StandardSpeech>>();
  const entered = deferred<void>();
  const controller = createStandardTurnController({ ...f,
    provider: { ...f.provider, synthesize() { entered.resolve(); return pending.promise; } },
  });
  const result = controller.run(f.scope, audio());
  await entered.promise;
  f.abort.abort(); pending.resolve({ kind: 'succeeded', value: speech });
  assert.deepEqual(await result, { outcome: { kind: 'unknown', reason: 'scope_not_current' }, accounting: 'settled' });
  assert.equal(f.evidence[0]!.stages[2]!.outcome, 'succeeded');
});

test('configured intent and nested charges are copied before caller mutation', async () => {
  const f = fixture(); let observed: UsageIntent | undefined;
  const controller = createStandardTurnController({ ...f, usage: { ...f.usage,
    reserve(actor, intent) {
      observed = intent;
      assert.equal(actor, f.scope.actor);
      return { kind: 'replay', handle: f.handle, state: 'reserved', snapshot: f.snapshot };
    },
  } });
  (f.intent.charges[0] as { amount: number }).amount = 999;
  (f.intent.dispatchStages as string[])[0] = 'changed';
  (f.intent as { subjectId: string }).subjectId = 'different-subject';
  await controller.run(f.scope, audio());
  assert.equal(observed!.subjectId, 'subject-1');
  assert.deepEqual(observed!.charges, [{ metric: 'coach_messages', amount: 7 }]);
  assert.deepEqual(observed!.dispatchStages, ['transcribe', 'complete', 'synthesize']);
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed!.charges[0]), true);
  assert.equal(Object.isFrozen(standardTurnStages), true);
});

test('unknown or failed policy resolution preserves liability and cannot qualify successful audio', async () => {
  for (const thrown of [false, true]) {
    const f = fixture();
    const controller = createStandardTurnController({ ...f, policy: { ...f.policy, resolve() {
      if (thrown) throw new Error('metering unavailable');
      return { kind: 'unknown' };
    } } });
    assert.deepEqual(await controller.run(f.scope, audio()), {
      outcome: { kind: 'unknown', reason: 'usage_accounting_unknown' }, accounting: 'unknown', review: fullReview,
    });
    assert.equal(f.state(), 'unknown'); assert.equal(f.events.includes('release'), false);
  }
});

test('failed settlement does not qualify success or retry an accounting effect that may have committed', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f, trusted: { ...f.trusted,
    settle(handle, settlement) { f.trusted.settle(handle, settlement); throw new Error('acknowledgement lost'); },
  } });
  assert.deepEqual(await controller.run(f.scope, audio()), {
    outcome: { kind: 'unknown', reason: 'usage_accounting_unresolved' }, accounting: 'unresolved', review: fullReview,
  });
  assert.equal(f.state(), 'settled');
  assert.equal(f.events.filter(event => event === 'settle').length, 1);
  assert.equal(f.events.includes('unknown'), false);
  assert.equal(f.events.includes('release'), false);
});

test('markUnknown failure remains visible and does not free the hold', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f,
    provider: { ...f.provider, async transcribe() { return { kind: 'unknown', reason: 'ambiguous' }; } },
    trusted: { ...f.trusted, markUnknown() { f.events.push('unknown-failed'); throw new Error('unavailable'); } },
  });
  const result = await controller.run(f.scope, audio());
  assert.equal(result.outcome.kind, 'unknown'); assert.equal(result.accounting, 'unresolved');
  assert.equal(f.state(), 'dispatching');
  assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'unknown-failed']);
});

test('repeat execution after settlement returns replay with no cached audio or provider resend', async () => {
  const f = fixture(); const controller = createStandardTurnController(f);
  assert.equal((await controller.run(f.scope, audio())).outcome.kind, 'succeeded');
  const before = [...f.events];
  assert.deepEqual(await controller.run(f.scope, audio()), {
    outcome: { kind: 'not_dispatched', reason: 'usage_replay_no_dispatch' }, accounting: 'replay',
  });
  assert.deepEqual(f.events, [...before, 'reserve']);
});

test('account expiry during trusted settlement still suppresses the final successful response', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f, trusted: { ...f.trusted,
    settle(handle, settlement) { const snapshot = f.trusted.settle(handle, settlement); f.expire(); return snapshot; },
  } });
  assert.deepEqual(await controller.run(f.scope, audio()), {
    outcome: { kind: 'unknown', reason: 'scope_not_current' }, accounting: 'settled',
  });
  assert.equal(f.state(), 'settled');
  assert.equal(f.events.filter(event => event === 'settle').length, 1);
});

test('failed reconciliation remains unresolved without replacing or releasing its effect', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f,
    provider: { ...f.provider, async transcribe() { return { kind: 'not_dispatched', reason: 'invalid input' }; } },
    policy: { ...f.policy, resolve() { return { kind: 'not_consumed', evidenceId: 'authoritative-evidence-1' }; } },
    trusted: { ...f.trusted, reconcile(handle, decision) {
      f.trusted.reconcile(handle, decision); throw new Error('acknowledgement lost');
    } },
  });
  const result = await controller.run(f.scope, audio());
  assert.equal(result.accounting, 'unresolved');
  assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'reconcile']);
  assert.equal(f.state(), 'released');
});

function metadata(operation: StandardProviderMetadata['operation']): StandardProviderMetadata {
  return {
    schemaVersion: 1, providerId: 'groq', operation, requestedModelId: `requested-${operation}`,
    telemetry: { status: 'unavailable', invalidFields: [] },
  };
}

test('all three stages forward only accepted metadata fields without exposing metadata in the response', async () => {
  const f = fixture();
  const byStage = {
    transcribe: { ...metadata('transcribe'), requestId: 'transcription-request' },
    complete: {
      ...metadata('complete'), requestedModelId: 'requested-alias', reportedModelId: 'reported-model',
      requestId: 'completion-request', responseId: 'completion-response',
      telemetry: { status: 'complete' as const, promptTokens: 12, completionTokens: 4, cachedPromptTokens: 2,
        totalTokens: 16, invalidFields: [] },
    },
    synthesize: metadata('synthesize'),
  };
  const contaminated = (value: StandardProviderMetadata) => ({
    ...value, text: 'PRIVATE-EXTRA', audio: new Uint8Array([99]), raw: { content: 'PRIVATE-EXTRA' },
    telemetry: { ...value.telemetry, content: 'PRIVATE-EXTRA', providerResponse: { text: 'PRIVATE-EXTRA' } },
  });
  const provider: StandardProvider = {
    ...f.provider,
    async transcribe(scope, input) { return { ...await f.provider.transcribe(scope, input), metadata: contaminated(byStage.transcribe), raw: 'PRIVATE-EXTRA' }; },
    async complete(scope, input) { return { ...await f.provider.complete(scope, input), metadata: contaminated(byStage.complete), raw: 'PRIVATE-EXTRA' }; },
    async synthesize(scope, input) { return { ...await f.provider.synthesize(scope, input), metadata: contaminated(byStage.synthesize), raw: 'PRIVATE-EXTRA' }; },
  };
  const result = await createStandardTurnController({ ...f, provider }).run(f.scope, audio());
  assert.deepEqual(result, { outcome: { kind: 'succeeded', value: speech }, accounting: 'settled', review: fullReview });
  assert.deepEqual(f.evidence[0]!.stages.map(stage => stage.metadata), standardTurnStages.map(stage => byStage[stage]));
  assert.equal(JSON.stringify(f.evidence).includes('PRIVATE-EXTRA'), false);
  for (const stage of f.evidence[0]!.stages) {
    assert.equal(Object.isFrozen(stage.metadata), true);
    assert.equal(Object.isFrozen(stage.metadata!.telemetry), true);
    assert.equal(Object.isFrozen(stage.metadata!.telemetry.invalidFields), true);
  }
});

test('absent metadata, missing counters and invalidFields retain their exact qualified meaning', async () => {
  const f = fixture();
  const partial: StandardProviderMetadata = {
    ...metadata('complete'),
    telemetry: { status: 'partial', promptTokens: 0, invalidFields: ['completionTokens', 'cachedPromptTokens'] },
  };
  const controller = createStandardTurnController({ ...f, provider: {
    ...f.provider,
    async complete(scope, input) { return { ...await f.provider.complete(scope, input), metadata: partial }; },
    async synthesize(scope, input) { return { ...await f.provider.synthesize(scope, input), metadata: metadata('synthesize') }; },
  } });
  await controller.run(f.scope, audio());
  const [transcribe, complete, synthesize] = f.evidence[0]!.stages;
  assert.equal(Object.hasOwn(transcribe!, 'metadata'), false);
  assert.deepEqual(complete!.metadata, partial);
  assert.equal(Object.hasOwn(complete!.metadata!, 'reportedModelId'), false);
  assert.equal(Object.hasOwn(complete!.metadata!.telemetry, 'cachedPromptTokens'), false);
  assert.equal(Object.hasOwn(complete!.metadata!.telemetry, 'completionTokens'), false);
  assert.equal(Object.hasOwn(complete!.metadata!.telemetry, 'totalTokens'), false);
  assert.deepEqual(synthesize!.metadata!.telemetry, { status: 'unavailable', invalidFields: [] });
});

test('metadata snapshots resist producer mutation between awaits and policy mutation before settlement', async () => {
  const f = fixture();
  const transcription = {
    ...metadata('transcribe'), requestId: 'original-request',
    telemetry: { status: 'unavailable' as const, invalidFields: [] as StandardUsageField[] },
  };
  const completion = {
    ...metadata('complete'), reportedModelId: 'original-model',
    telemetry: { status: 'partial' as const, promptTokens: 9, invalidFields: ['cachedPromptTokens'] as StandardUsageField[] },
  };
  const synthesis = metadata('synthesize');
  const controller = createStandardTurnController({ ...f, provider: {
    ...f.provider,
    async transcribe(scope, input) { return { ...await f.provider.transcribe(scope, input), metadata: transcription }; },
    async complete(scope, input) {
      transcription.requestId = 'changed-request';
      transcription.telemetry.invalidFields.push('usage');
      return { ...await f.provider.complete(scope, input), metadata: completion };
    },
    async synthesize(scope, input) {
      completion.reportedModelId = 'changed-model'; completion.telemetry.promptTokens = 99;
      completion.telemetry.invalidFields.push('totalTokens');
      return { ...await f.provider.synthesize(scope, input), metadata: synthesis };
    },
  }, policy: { ...f.policy, resolve(evidence) {
    const captured = evidence.stages[1]!.metadata!;
    assert.equal(captured.reportedModelId, 'original-model');
    assert.equal(captured.telemetry.promptTokens, 9);
    assert.deepEqual(captured.telemetry.invalidFields, ['cachedPromptTokens']);
    assert.throws(() => { (captured.telemetry as { promptTokens: number }).promptTokens = 999; }, TypeError);
    assert.throws(() => { (captured.telemetry.invalidFields as StandardUsageField[]).push('usage'); }, TypeError);
    return f.policy.resolve(evidence);
  } } });
  const result = await controller.run(f.scope, audio());
  assert.equal(result.accounting, 'settled');
  assert.equal(f.evidence[0]!.stages[0]!.metadata!.requestId, 'original-request');
  assert.deepEqual(f.evidence[0]!.stages[0]!.metadata!.telemetry.invalidFields, []);
  assert.notEqual(f.evidence[0]!.stages[0]!.metadata, transcription);
  assert.notEqual(f.evidence[0]!.stages[1]!.metadata!.telemetry.invalidFields, completion.telemetry.invalidFields);
  assert.notEqual(f.evidence[0]!.stages[2]!.metadata, synthesis);
});

test('metadata for another operation is omitted without reattributing or changing known stage outcomes', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f, provider: {
    ...f.provider,
    async transcribe(scope, input) { return { ...await f.provider.transcribe(scope, input), metadata: metadata('complete') }; },
    async complete(scope, input) { return { ...await f.provider.complete(scope, input), metadata: metadata('synthesize') }; },
    async synthesize(scope, input) { return { ...await f.provider.synthesize(scope, input), metadata: metadata('transcribe') }; },
  } });
  assert.equal((await controller.run(f.scope, audio())).accounting, 'settled');
  assert.ok(f.evidence[0]!.stages.every(stage => !Object.hasOwn(stage, 'metadata') && stage.outcome === 'succeeded'));
});

test('cancellation after known success retains parsed metadata for the original reservation accounting', async () => {
  const f = fixture();
  const parsed = { ...metadata('transcribe'), requestId: 'original-request' };
  const controller = createStandardTurnController({ ...f, provider: {
    ...f.provider,
    async transcribe(scope, input) {
      const outcome = await f.provider.transcribe(scope, input);
      f.actor.accountId = 'replacement-account'; f.actor.sessionId = 'replacement-session'; f.abort.abort();
      return { ...outcome, metadata: parsed };
    },
  } });
  const result = await controller.run(f.scope, audio());
  assert.deepEqual(result, { outcome: { kind: 'unknown', reason: 'scope_not_current' }, accounting: 'settled' });
  assert.deepEqual(f.evidence[0]!.stages[0]!.metadata, parsed);
  assert.equal(f.evidence[0]!.stages[0]!.outcome, 'succeeded');
  assert.equal(f.handle.actor.accountId, 'account-a');
  assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'transcribe', 'resolve', 'settle']);
});

test('unknown outcomes with matching or mismatched metadata still retain the whole hold without invoking policy', async () => {
  for (const operation of ['transcribe', 'complete'] as const) {
    const f = fixture();
    const controller = createStandardTurnController({ ...f, provider: {
      ...f.provider,
      async transcribe() { return { kind: 'unknown', reason: 'PRIVATE-EXTRA', metadata: metadata(operation) }; },
    } });
    assert.deepEqual(await controller.run(f.scope, audio()), {
      outcome: { kind: 'unknown', reason: 'standard_transcribe_unknown' }, accounting: 'unknown',
    });
    assert.equal(f.evidence.length, 0);
    assert.equal(f.state(), 'unknown');
    assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'unknown']);
  }
});

test('qualified rejection metadata reaches configured accounting without forwarding the provider reason', async () => {
  const f = fixture();
  const parsed: StandardProviderMetadata = { ...metadata('transcribe'), requestId: 'rejected-request' };
  const controller = createStandardTurnController({ ...f, provider: {
    ...f.provider,
    async transcribe() { return { kind: 'rejected', reason: 'PRIVATE-EXTRA', metadata: parsed }; },
  } });
  const result = await controller.run(f.scope, audio());
  assert.deepEqual(result, { outcome: { kind: 'rejected', reason: 'standard_transcribe_rejected' }, accounting: 'settled' });
  assert.deepEqual(f.evidence[0]!.stages[0]!.metadata, parsed);
  assert.equal(f.evidence[0]!.stages[0]!.outcome, 'rejected');
  assert.equal(JSON.stringify(f.evidence).includes('PRIVATE-EXTRA'), false);
});

test('missing completion preparation disables an otherwise configured turn before reservation', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ provider: f.provider, usage: f.usage, trusted: f.trusted, policy: f.policy });
  assert.deepEqual(await controller.run(f.scope, audio()), {
    outcome: { kind: 'not_dispatched', reason: 'standard_turn_disabled' }, accounting: 'not_reserved',
  });
  assert.deepEqual(f.events, []);
  assert.equal(f.evidence.length, 0);
});

test('captured preparation uses the original scope before the completion permit and keeps prepared context out of review', async () => {
  const f = fixture();
  const prepared = { text: 'AUTHORIZED PREPARED CONTEXT', extra: 'PRIVATE EXTRA' };
  const options = {
    ...f,
    prepareCompletion: async (scope: CoachingRequestScope, input: Readonly<{ transcript: string }>) => {
      assert.equal(scope, f.scope); assert.equal(scope.actor, f.handle.actor);
      assert.deepEqual(input, { transcript: 'private transcript' });
      assert.equal(Object.isFrozen(input), true);
      assert.equal(f.events.at(-1), 'transcribe'); f.events.push('prepare');
      return prepared;
    },
    usage: { ...f.usage, markDispatching(handle: UsageReservationHandle, stage: string) {
      if (stage === 'complete') {
        assert.equal(f.events.at(-1), 'prepare');
        prepared.text = 'LATE MUTATION';
      }
      return f.usage.markDispatching(handle, stage);
    } },
    provider: { ...f.provider, async complete(scope: CoachingRequestScope, input: StandardTextInput) {
      assert.equal(scope, f.scope);
      assert.deepEqual(input, { text: 'AUTHORIZED PREPARED CONTEXT' });
      assert.equal(Object.isFrozen(input), true);
      assert.equal(f.events.at(-1), 'permit:complete'); f.events.push('complete');
      return { kind: 'succeeded' as const, value: 'private reply' };
    } },
  };
  const controller = createStandardTurnController(options);
  options.prepareCompletion = async () => { assert.fail('replacement preparation must not be used'); };
  const result = await controller.run(f.scope, audio());
  assert.deepEqual(result, { outcome: { kind: 'succeeded', value: speech }, accounting: 'settled', review: fullReview });
  assert.equal(Object.isFrozen(result.review), true);
  assert.throws(() => { (result.review as { transcript: string }).transcript = 'changed'; }, TypeError);
  assert.equal(JSON.stringify(result).includes('PREPARED'), false);
  assert.equal(JSON.stringify(f.evidence).includes('PREPARED'), false);
  assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'transcribe', 'prepare', 'permit:complete', 'complete',
    'permit:synthesize', 'synthesize', 'resolve', 'settle']);
  assert.deepEqual(f.evidence[0]!.stages.map(stage => stage.stage), ['transcribe', 'complete', 'synthesize']);
});

test('preparation throw, rejection, or invalid text prevents later permits while retaining transcription accounting', async () => {
  const failures: readonly { prepare: StandardCompletionPreparation; reason: string }[] = [
    { prepare: () => { throw new Error('PRIVATE PREPARATION ERROR'); }, reason: 'completion_preparation_failed' },
    { prepare: async () => { throw new Error('PRIVATE PREPARATION ERROR'); }, reason: 'completion_preparation_failed' },
    ...[undefined, null, {}, { text: 42 }, { text: '' }, { text: ' \n\t ' }].map(value => ({
      prepare: async () => value as unknown as StandardTextInput, reason: 'completion_preparation_invalid',
    })),
  ];
  for (const { prepare, reason } of failures) {
    const f = fixture();
    const result = await createStandardTurnController({ ...f, prepareCompletion: prepare }).run(f.scope, audio());
    assert.deepEqual(result, {
      outcome: { kind: 'not_dispatched', reason }, accounting: 'settled', review: { transcript: 'private transcript' },
    });
    assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'transcribe', 'resolve', 'settle']);
    assert.deepEqual(f.evidence[0]!.stages.map(stage => [stage.permit, stage.outcome]), [
      ['granted', 'succeeded'], ['not_requested', 'not_dispatched'], ['not_requested', 'not_dispatched'],
    ]);
    assert.equal(JSON.stringify(f.evidence).includes('PRIVATE PREPARATION'), false);
    assert.equal(f.events.includes('release'), false);
  }
});

test('abort or epoch expiry during preparation prevents later dispatch and removes review while accounting the original actor', async () => {
  for (const invalidate of ['abort', 'epoch'] as const) {
    const f = fixture(); const pending = deferred<StandardTextInput>(); const entered = deferred<void>();
    const controller = createStandardTurnController({ ...f, prepareCompletion: async (scope, input) => {
      assert.equal(scope, f.scope); assert.equal(input.transcript, 'private transcript');
      f.events.push('prepare'); entered.resolve(); return pending.promise;
    } });
    const result = controller.run(f.scope, audio());
    await entered.promise;
    f.actor.accountId = 'replacement'; f.actor.sessionId = 'replacement-session'; f.actor.epoch = 2;
    if (invalidate === 'abort') f.abort.abort(); else f.expire();
    pending.resolve({ text: 'STALE PREPARED CONTEXT' });
    assert.deepEqual(await result, { outcome: { kind: 'unknown', reason: 'scope_not_current' }, accounting: 'settled' });
    assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'transcribe', 'prepare', 'resolve', 'settle']);
    assert.equal(f.handle.actor.accountId, 'account-a');
    assert.ok(f.seenActors.every(actor => actor.accountId === 'account-a' && actor.sessionId === 'session-a'));
    assert.equal(JSON.stringify(f.evidence).includes('STALE'), false);
  }
});

test('scope is rechecked after copying prepared text and before the completion permit', async () => {
  const f = fixture();
  const result = await createStandardTurnController({ ...f, prepareCompletion: async () => ({
    get text() { f.expire(); return 'STALE CONTEXT'; },
  }) }).run(f.scope, audio());
  assert.deepEqual(result, { outcome: { kind: 'unknown', reason: 'scope_not_current' }, accounting: 'settled' });
  assert.deepEqual(f.events, ['reserve', 'permit:transcribe', 'transcribe', 'resolve', 'settle']);
});

test('failed or unknown completion exposes only the known transcript without synthesizing or retrying', async () => {
  for (const kind of ['not_dispatched', 'rejected', 'unknown'] as const) {
    const f = fixture(); let calls = 0;
    const controller = createStandardTurnController({ ...f, provider: { ...f.provider,
      async complete() { ++calls; return { kind, reason: 'PRIVATE PROVIDER FAILURE' }; },
    } });
    const result = await controller.run(f.scope, audio());
    assert.deepEqual(result, {
      outcome: { kind, reason: `standard_complete_${kind}` },
      accounting: kind === 'unknown' ? 'unknown' : 'settled', review: { transcript: 'private transcript' },
    });
    assert.equal(Object.isFrozen(result.review), true);
    assert.equal(calls, 1); assert.equal(f.events.includes('permit:synthesize'), false);
    assert.equal(f.events.includes('release'), false);
  }
});

test('failed or unknown synthesis preserves known review text without changing accounting or dispatching a fallback', async () => {
  for (const kind of ['not_dispatched', 'rejected', 'unknown'] as const) {
    const f = fixture(); let calls = 0;
    const controller = createStandardTurnController({ ...f, provider: { ...f.provider,
      async synthesize() { ++calls; return { kind, reason: 'PRIVATE PROVIDER FAILURE' }; },
    } });
    const result = await controller.run(f.scope, audio());
    assert.deepEqual(result, {
      outcome: { kind, reason: `standard_synthesize_${kind}` }, accounting: kind === 'unknown' ? 'unknown' : 'settled', review: fullReview,
    });
    assert.equal(Object.isFrozen(result.review), true);
    assert.equal(calls, 1);
    assert.deepEqual(f.events.filter(event => event.startsWith('permit:')), ['permit:transcribe', 'permit:complete', 'permit:synthesize']);
    assert.equal(f.events.includes('release'), false);
  }
});

test('a denied synthesis permit retains known review without a synthesis call or automatic retry', async () => {
  const f = fixture();
  const controller = createStandardTurnController({ ...f, usage: { ...f.usage,
    markDispatching(handle, stage) {
      if (stage === 'synthesize') { f.events.push('synthesis-permit-denied'); throw new Error('denied'); }
      return f.usage.markDispatching(handle, stage);
    },
  } });
  assert.deepEqual(await controller.run(f.scope, audio()), {
    outcome: { kind: 'not_dispatched', reason: 'usage_permit_unavailable' }, accounting: 'unknown', review: fullReview,
  });
  assert.equal(f.events.includes('synthesize'), false);
  assert.equal(f.events.filter(event => event === 'synthesis-permit-denied').length, 1);
  assert.equal(f.events.includes('release'), false);
});

test('replay does not call preparation or return prior review content', async () => {
  const f = fixture(); let preparations = 0;
  const controller = createStandardTurnController({ ...f, prepareCompletion: async (scope, input) => {
    ++preparations; return f.prepareCompletion(scope, input);
  } });
  assert.deepEqual((await controller.run(f.scope, audio())).review, fullReview);
  const priorEvents = [...f.events];
  const replay = await controller.run(f.scope, audio());
  assert.deepEqual(replay, { outcome: { kind: 'not_dispatched', reason: 'usage_replay_no_dispatch' }, accounting: 'replay' });
  assert.equal(preparations, 1);
  assert.deepEqual(f.events, [...priorEvents, 'reserve']);
});

test('stage observer captures original reservation identity at admission and runs once before accounting', async () => {
  const f = fixture(); const observations: StandardTurnObservation[] = [];
  const mutableHandle = {
    reservationId: f.handle.reservationId, actor: { ...f.handle.actor }, operation: f.handle.operation,
    intentHash: f.handle.intentHash, subjectId: f.handle.subjectId,
  };
  const handle = mutableHandle as UsageReservationHandle;
  const options = { ...f,
    usage: { ...f.usage,
      reserve(actor: AccountContext, intent: UsageIntent) { return { ...f.usage.reserve(actor, intent), handle }; },
      markDispatching(value: UsageReservationHandle, stage: string) {
        assert.equal(value, handle); return f.usage.markDispatching(f.handle, stage);
      },
    },
    trusted: { ...f.trusted, settle(value: UsageReservationHandle, settlement: UsageSettlement) {
      assert.equal(value, handle); assert.equal(f.events.at(-1), 'resolve');
      return f.trusted.settle(f.handle, settlement);
    } },
    provider: { ...f.provider, async synthesize(scope: CoachingRequestScope, input: StandardTextInput) {
      const result = await f.provider.synthesize(scope, input);
      mutableHandle.actor.accountId = 'replacement'; mutableHandle.actor.authUserId = 'replacement-user';
      mutableHandle.actor.sessionId = 'replacement-session'; mutableHandle.actor.epoch = 99;
      mutableHandle.reservationId = 'replacement-reservation'; mutableHandle.operation = 'replacement-operation';
      mutableHandle.intentHash = 'replacement-hash'; mutableHandle.subjectId = 'replacement-subject';
      return result;
    } },
    observeStages(observation: StandardTurnObservation) {
      assert.equal(f.events.at(-1), 'synthesize'); f.events.push('observe'); observations.push(observation);
    },
  };
  const controller = createStandardTurnController(options);
  options.observeStages = () => { assert.fail('replacement observer must not be called'); };
  assert.equal((await controller.run(f.scope, audio())).accounting, 'settled');
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], {
    actor: f.scope.actor, reservationId: 'reservation-1', operation: f.intent.operation,
    intentHash: f.intent.intentHash, subjectId: f.intent.subjectId, evidence: f.evidence[0],
  });
  assert.notEqual(observations[0]!.actor, handle.actor);
  assert.equal(observations[0]!.evidence, f.evidence[0]);
  assert.deepEqual(f.events.slice(-3), ['observe', 'resolve', 'settle']);
});

test('unknown synthesis observation retains earlier successful completion metadata while settlement resolution is bypassed', async () => {
  const f = fixture(); const observations: StandardTurnObservation[] = [];
  const completionMetadata: StandardProviderMetadata = {
    ...metadata('complete'), requestId: 'completed-request', reportedModelId: 'reported-model',
    telemetry: { status: 'partial', promptTokens: 12, completionTokens: 4, invalidFields: ['cachedPromptTokens'] },
  };
  const controller = createStandardTurnController({ ...f,
    provider: { ...f.provider,
      async complete(scope, input) { return { ...await f.provider.complete(scope, input), metadata: completionMetadata }; },
      async synthesize() { return { kind: 'unknown', reason: 'PRIVATE FAILURE', metadata: metadata('synthesize') }; },
    },
    observeStages(observation) { observations.push(observation); f.events.push('observe'); },
  });
  const result = await controller.run(f.scope, audio());
  assert.deepEqual(result, {
    outcome: { kind: 'unknown', reason: 'standard_synthesize_unknown' }, accounting: 'unknown', review: fullReview,
  });
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0]!.evidence.stages.map(stage => stage.outcome), ['succeeded', 'succeeded', 'unknown']);
  assert.deepEqual(observations[0]!.evidence.stages[1]!.metadata, completionMetadata);
  assert.equal(observations[0]!.evidence.completed, false);
  assert.equal(f.evidence.length, 0);
  assert.deepEqual(f.events.slice(-2), ['observe', 'unknown']);
});

test('cancelled and expired turns emit original identity once while keeping all text out of the public stale result', async () => {
  for (const invalidation of ['abort', 'epoch'] as const) {
    const f = fixture(); const observations: StandardTurnObservation[] = [];
    const controller = createStandardTurnController({ ...f,
      provider: { ...f.provider, async complete(scope, input) {
        const result = await f.provider.complete(scope, input);
        f.actor.accountId = 'new-account'; f.actor.authUserId = 'new-user'; f.actor.sessionId = 'new-session'; f.actor.epoch = 2;
        if (invalidation === 'abort') f.abort.abort(); else f.expire();
        return { ...result, metadata: metadata('complete') };
      } },
      observeStages(observation) { observations.push(observation); },
    });
    assert.deepEqual(await controller.run(f.scope, audio()), {
      outcome: { kind: 'unknown', reason: 'scope_not_current' }, accounting: 'settled',
    });
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0]!.actor, { accountId: 'account-a', authUserId: 'user-a', sessionId: 'session-a', epoch: 1 });
    assert.equal(observations[0]!.evidence.stages[1]!.outcome, 'succeeded');
    assert.deepEqual(observations[0]!.evidence.stages[1]!.metadata, metadata('complete'));
    assert.equal(f.events.includes('permit:synthesize'), false);
  }
});

test('only newly reserved turns emit, including cancellation before a permit and preparation or uncertain-permit failure', async () => {
  for (const path of ['disabled', 'initial-stale', 'reserve-failed', 'replay', 'fresh-cancel', 'prepare-failed', 'permit-uncertain'] as const) {
    const f = fixture(); const observations: StandardTurnObservation[] = [];
    if (path === 'initial-stale') f.abort.abort();
    const controller = createStandardTurnController({ ...f,
      provider: path === 'disabled' ? { ...f.provider, enabled: false } : f.provider,
      prepareCompletion: path === 'prepare-failed' ? async () => { throw new Error('PRIVATE PREPARATION FAILURE'); } : f.prepareCompletion,
      usage: { ...f.usage,
        reserve(actor, intent) {
          if (path === 'reserve-failed') throw new Error('reserve failed');
          const result = f.usage.reserve(actor, intent);
          if (path === 'fresh-cancel') f.abort.abort();
          return path === 'replay' ? { ...result, kind: 'replay' } : result;
        },
        markDispatching(handle, stage) {
          const permit = f.usage.markDispatching(handle, stage);
          if (path === 'permit-uncertain') throw new Error('permit acknowledgement lost');
          return permit;
        },
      },
      observeStages(observation) { observations.push(observation); f.events.push('observe'); },
    });
    const result = await controller.run(f.scope, audio());
    const emits = ['fresh-cancel', 'prepare-failed', 'permit-uncertain'].includes(path);
    assert.equal(observations.length, emits ? 1 : 0);
    if (path === 'fresh-cancel') {
      assert.equal(result.accounting, 'released');
      assert.deepEqual(f.events, ['reserve', 'observe', 'release']);
      assert.ok(observations[0]!.evidence.stages.every(stage => stage.permit === 'not_requested'));
    } else if (path === 'prepare-failed') {
      assert.equal(result.accounting, 'settled');
      assert.equal(observations[0]!.evidence.stages[0]!.outcome, 'succeeded');
      assert.equal(observations[0]!.evidence.stages[1]!.permit, 'not_requested');
    } else if (path === 'permit-uncertain') {
      assert.equal(result.accounting, 'unknown');
      assert.equal(observations[0]!.evidence.stages[0]!.permit, 'uncertain');
      assert.equal(f.evidence.length, 0);
    }
  }
});

test('synchronous observer exceptions do not change the turn result, accounting, or dispatch count', async () => {
  const f = fixture(); let calls = 0;
  const controller = createStandardTurnController({ ...f, observeStages() {
    ++calls; throw new Error('PRIVATE OBSERVER ERROR');
  } });
  assert.deepEqual(await controller.run(f.scope, audio()), {
    outcome: { kind: 'succeeded', value: speech }, accounting: 'settled', review: fullReview,
  });
  assert.equal(calls, 1);
  assert.equal(f.events.filter(event => event === 'settle').length, 1);
  assert.equal(f.events.filter(event => event.startsWith('permit:')).length, 3);
});

test('rejected and never-resolving observer promises cannot delay accounting or produce an unhandled rejection', async () => {
  for (const mode of ['reject', 'pending'] as const) {
    const f = fixture(); let calls = 0;
    const controller = createStandardTurnController({ ...f, observeStages() {
      ++calls;
      return mode === 'reject' ? Promise.reject(new Error('PRIVATE OBSERVER ERROR')) : new Promise<void>(() => {});
    } });
    const result = await controller.run(f.scope, audio());
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(result, { outcome: { kind: 'succeeded', value: speech }, accounting: 'settled', review: fullReview });
    assert.equal(calls, 1); assert.equal(f.state(), 'settled');
  }
});

test('observation is deeply immutable and contains no content, reason, authority, or mismatched metadata', async () => {
  const f = fixture(); const observations: StandardTurnObservation[] = [];
  const privateSymbol = Symbol('private capability');
  const extraMetadata = {
    ...metadata('complete'), text: 'PRIVATE CONTENT', audio: speech.audio,
    telemetry: { status: 'partial' as const, promptTokens: 3, invalidFields: ['cachedPromptTokens'] as StandardUsageField[], text: 'PRIVATE CONTENT' },
  };
  const extendedActor = { ...f.handle.actor, scope: f.scope, signal: f.scope.signal, secret: 'PRIVATE CONTENT' };
  const extendedHandle = { ...f.handle, actor: extendedActor, [privateSymbol]: f.trusted,
    idempotencyKey: 'PRIVATE CONTENT', charges: f.intent.charges, controls: f.trusted } as UsageReservationHandle;
  const controller = createStandardTurnController({ ...f,
    usage: { ...f.usage,
      reserve(actor, intent) { return { ...f.usage.reserve(actor, intent), handle: extendedHandle }; },
      markDispatching(handle, stage) { assert.equal(handle, extendedHandle); return f.usage.markDispatching(f.handle, stage); },
    },
    trusted: { ...f.trusted, markUnknown(handle) { assert.equal(handle, extendedHandle); return f.trusted.markUnknown(f.handle); } },
    provider: { ...f.provider,
      async transcribe(scope, input) { return { ...await f.provider.transcribe(scope, input), metadata: metadata('complete') }; },
      async complete(scope, input) { return { ...await f.provider.complete(scope, input), metadata: extraMetadata }; },
      async synthesize() { return { kind: 'unknown', reason: 'PRIVATE CONTENT', metadata: metadata('synthesize') }; },
    },
    observeStages(observation) { observations.push(observation); },
  });
  assert.equal((await controller.run(f.scope, audio())).accounting, 'unknown');
  assert.equal(observations.length, 1);
  const observed = observations[0]!;
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.actor), true);
  assert.equal(Object.isFrozen(observed.evidence), true);
  assert.equal(Object.isFrozen(observed.evidence.stages), true);
  const stage = observed.evidence.stages[1]!;
  assert.equal(Object.isFrozen(stage), true); assert.equal(Object.isFrozen(stage.metadata), true);
  assert.equal(Object.isFrozen(stage.metadata!.telemetry), true);
  assert.equal(Object.isFrozen(stage.metadata!.telemetry.invalidFields), true);
  assert.throws(() => { (observed.actor as { accountId: string }).accountId = 'changed'; }, TypeError);
  assert.throws(() => { (stage.metadata!.telemetry.invalidFields as StandardUsageField[]).push('usage'); }, TypeError);
  assert.deepEqual(Object.keys(observed).sort(), ['actor', 'evidence', 'intentHash', 'operation', 'reservationId', 'subjectId']);
  assert.deepEqual(Object.keys(observed.actor).sort(), ['accountId', 'authUserId', 'epoch', 'sessionId']);
  assert.deepEqual(Object.getOwnPropertySymbols(observed), []);
  assert.deepEqual(Object.getOwnPropertySymbols(observed.actor), []);
  assert.equal(Object.hasOwn(observed.evidence.stages[0]!, 'metadata'), false);
  assert.equal(JSON.stringify(observed).includes('PRIVATE CONTENT'), false);
  assert.equal(JSON.stringify(observed).includes('private transcript'), false);
  assert.equal(JSON.stringify(observed).includes('private reply'), false);
  assert.equal(JSON.stringify(observed).includes('reason'), false);
});
