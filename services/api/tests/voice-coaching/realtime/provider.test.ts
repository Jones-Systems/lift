import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoachingRequestScope } from '../../../src/voice-coaching/contracts.js';
import { classifyRealtimeFailure, createDisabledRealtimeProvider } from '../../../src/voice-coaching/realtime/provider.js';

function fixture() {
  const abort = new AbortController();
  let checks = 0;
  const scope: CoachingRequestScope = {
    actor: { accountId: 'fixture-account', authUserId: 'fixture-user', sessionId: 'fixture-session', epoch: 1 },
    signal: abort.signal,
    assertCurrent() { checks++; abort.signal.throwIfAborted(); },
  };
  return { abort, scope, checks: () => checks };
}

test('default provider advertises disabled and never accepts an offer or claims hangup success', async () => {
  const { scope, checks } = fixture();
  const provider = createDisabledRealtimeProvider<string, string>();
  assert.deepEqual(provider.capability, {
    available: false, provider: 'openai-realtime', reason: 'transport_policy_pending',
  });
  assert.deepEqual(await provider.createCall(scope, { operationId: 'create', offer: 'synthetic' }), {
    kind: 'not_dispatched', reason: 'transport_policy_pending',
  });
  assert.deepEqual(await provider.hangup(scope, { operationId: 'stop', providerCallId: 'synthetic' }), {
    kind: 'not_dispatched', reason: 'transport_policy_pending',
  });
  assert.equal(checks(), 2);
});

test('even disabled operations preserve the original request scope and reject stale callers', async () => {
  const { scope, abort } = fixture();
  const provider = createDisabledRealtimeProvider<string, string>('provider_unconfigured');
  abort.abort();
  await assert.rejects(provider.createCall(scope, { operationId: 'create', offer: 'synthetic' }));
  await assert.rejects(provider.hangup(scope, { operationId: 'stop', providerCallId: 'synthetic' }));
});

test('possible dispatch remains unknown without documented rejection evidence', () => {
  assert.deepEqual(classifyRealtimeFailure({ dispatch: 'may_have_been_sent', rejection: 'unproved' }), {
    kind: 'unknown', reason: 'provider_effect_unconfirmed',
  });
  assert.equal(classifyRealtimeFailure({ dispatch: 'not_sent' }).kind, 'not_dispatched');
  assert.equal(classifyRealtimeFailure({ dispatch: 'may_have_been_sent', rejection: 'documented_no_effect' }).kind, 'rejected');
});
