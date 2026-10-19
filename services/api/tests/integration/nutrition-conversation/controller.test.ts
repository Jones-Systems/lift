import assert from 'node:assert/strict';
import test from 'node:test';
import { createNutritionController, createRetainedNutritionController } from '../../../src/integration/nutrition-conversation/host.js';
import { createNutritionCitationConversation } from '../../../src/domain-features/nutrition/citation-followthrough.js';
import type { NutritionWireResponse } from '../../../src/integration/nutrition-conversation/wire.js';
import { envelope, input, fixture, source } from './fixturewire.js';

const id = (value: NutritionWireResponse): string => { assert.ok(value.binding); return value.binding.id; };

test('missing and unverified retained bytes remain unavailable with no retrieval', async t => {
  const f = fixture(t);
  for (const controller of [createNutritionController({ lifecycle: f.lifecycle }),
    createRetainedNutritionController({ lifecycle: f.lifecycle, projectionBytes: new TextEncoder().encode('{}') })]) {
    t.after(controller.close);
    const result = await controller.dispatch(f.actor, 'resetFreshEmpty', envelope(), new AbortController().signal);
    const response = JSON.parse(result.serialize().json) as NutritionWireResponse;
    assert.equal(response.code, 'nutrition_unconfigured'); assert.equal(response.state, null);
  }
  assert.equal(f.calls(), 0);
});
test('reset and submissions retain exact native state, correction context and citation qualification without selection retrieval', async t => {
  const f = fixture(t), native = createNutritionCitationConversation(source());
  const reset = await f.request('resetFreshEmpty');
  assert.equal(reset.stateVersion, 1); assert.deepEqual(reset.state, native.snapshot());
  const first = await f.request('submit', id(reset), { ...envelope(), input: input() });
  assert.deepEqual(first.state, await native.submit(input()));
  const selection = { parentTurnId: 1, statementId: 'SYN-S01' };
  assert.deepEqual((await f.request('selectCitation', id(reset), { ...envelope(), input: selection })).state, native.selectCitation(selection));
  assert.equal(f.calls(), 1);
  const correction = { ...input(), choice: 'correct-question' as const, previousTurnId: 1,
    question: 'running', userContext: ['Complete replacement'], correction: 'Replace question' };
  const corrected = await f.request('submit', id(reset), { ...envelope(), input: correction });
  assert.deepEqual(corrected.state, await native.submit(correction));
  assert.equal(corrected.state?.currentSelection, null); assert.equal(f.calls(), 2);
});
test('foreign account/session and unknown IDs disclose the same empty unavailable response', async t => {
  const f = fixture(t), reset = await f.request('resetFreshEmpty');
  for (const [who, key] of [[f.other, id(reset)], [f.second, id(reset)], [f.actor, 'unknown']] as const) {
    const result = await f.request('snapshot', key, envelope(), who);
    assert.equal(result.code, 'conversation_unavailable'); assert.equal(result.state, null); assert.equal(result.binding, null);
  }
  assert.equal((await f.request('snapshot', id(reset))).status, 'ok');
});
test('stale rejection preserves the accepted turn and current citation with full authoritative state', async t => {
  const f = fixture(t), reset = await f.request('resetFreshEmpty');
  await f.request('submit', id(reset), { ...envelope(), input: input() });
  await f.request('selectCitation', id(reset), { ...envelope(), input: { parentTurnId: 1, statementId: 'SYN-S01' } });
  const rejected = await f.request('submit', id(reset), { ...envelope(), input: input() });
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.code, 'stale_turn');
  assert.equal(rejected.state?.conversation.turns.length, 1);
  assert.equal(rejected.state?.conversation.rejectedChoices.length, 1);
  assert.equal(rejected.state?.currentSelection?.statementId, 'SYN-S01'); assert.equal(f.calls(), 1);
});
test('reset, disposal, abort and shutdown defeat pending output and never replay it', async t => {
  for (const effect of ['reset', 'dispose', 'abort', 'close'] as const) {
    const f = fixture(t), reset = await f.request('resetFreshEmpty'), signal = new AbortController();
    const pending = f.controller.dispatch(f.actor, 'submit', { ...envelope(), input: input() }, signal.signal, id(reset));
    if (effect === 'reset') await f.request('resetFreshEmpty');
    if (effect === 'dispose') await f.request('dispose', id(reset));
    if (effect === 'abort') signal.abort();
    if (effect === 'close') f.controller.close();
    const response = JSON.parse((await pending).serialize().json) as NutritionWireResponse;
    assert.equal(response.status, 'unknown'); assert.equal(response.state, null); assert.equal(response.resetRequired, true);
    assert.equal(f.calls(), 1);
  }
});
test('canonical epoch/session/suppression changes during awaits and before delivery suppress content', async t => {
  for (const effect of ['epoch', 'session', 'suppression', 'error-settlement'] as const) {
    const f = fixture(t), reset = await f.request('resetFreshEmpty');
    if (effect === 'error-settlement') await f.request('submit', id(reset), { ...envelope(), input: input() });
    const pending = f.controller.dispatch(f.actor, 'submit', { ...envelope(), input: input() }, new AbortController().signal, id(reset));
    if (effect === 'epoch') f.db.exec('UPDATE account_lifecycle SET epoch=1');
    else if (effect === 'suppression') f.suppress();
    else f.db.exec("DELETE FROM session WHERE id='s1'");
    const response = JSON.parse((await pending).serialize().json) as NutritionWireResponse;
    assert.equal(response.status, 'unknown'); assert.equal(response.state, null);
  }
  const f = fixture(t), reset = await f.request('resetFreshEmpty');
  const ready = await f.controller.dispatch(f.actor, 'snapshot', envelope(), new AbortController().signal, id(reset));
  f.suppress(); assert.equal((JSON.parse(ready.serialize().json) as NutritionWireResponse).state, null);
});
test('serialization reads fresh state after awaits rather than delivering a previously captured selection', async t => {
  const f = fixture(t), reset = await f.request('resetFreshEmpty');
  await f.request('submit', id(reset), { ...envelope(), input: input() });
  const pendingDelivery = await f.controller.dispatch(f.actor, 'snapshot', envelope(), new AbortController().signal, id(reset));
  const selected = await f.request('selectCitation', id(reset), { ...envelope(), input: { parentTurnId: 1, statementId: 'SYN-S01' } });
  const delivered = JSON.parse(pendingDelivery.serialize().json) as NutritionWireResponse;
  assert.deepEqual(delivered.state, selected.state); assert.equal(delivered.stateVersion, selected.stateVersion);
});
test('account/process capacity, idle and absolute expiry do not evict other live conversations', async t => {
  const f = fixture(t, { conversations: 2, idleMs: 100, absoluteMs: 150 });
  const one = await f.request('resetFreshEmpty');
  const two = await f.request('resetFreshEmpty', undefined, envelope(), f.second);
  assert.equal((await f.request('resetFreshEmpty', undefined, envelope(), f.third)).code, 'capacity_exceeded');
  assert.equal((await f.request('resetFreshEmpty', undefined, envelope(), f.other)).code, 'capacity_exceeded');
  f.advance(90); assert.equal((await f.request('snapshot', id(one))).status, 'ok');
  f.advance(20); assert.equal((await f.request('snapshot', id(two), envelope(), f.second)).code, 'conversation_unavailable');
  f.advance(40); assert.equal((await f.request('snapshot', id(one))).code, 'conversation_unavailable');
});
test('pending admission survives invalidation until the original promise actually settles', async t => {
  const f = fixture(t, { pending: 1 }), reset = await f.request('resetFreshEmpty');
  const original = f.controller.dispatch(f.actor, 'submit', { ...envelope(), input: input() }, new AbortController().signal, id(reset));
  const replaced = f.controller.dispatch(f.actor, 'resetFreshEmpty', envelope(), new AbortController().signal);
  const replacement = JSON.parse((await replaced).serialize().json) as NutritionWireResponse;
  const rejected = await f.request('submit', id(replacement), { ...envelope(), input: input() });
  assert.equal(rejected.code, 'turn_in_progress'); assert.equal(f.calls(), 1);
  assert.equal((JSON.parse((await original).serialize().json) as NutritionWireResponse).status, 'unknown');
});
test('history and response limits require fresh reset and never truncate native qualifications', async t => {
  const f = fixture(t, { acceptedTurns: 1 }), reset = await f.request('resetFreshEmpty');
  await f.request('submit', id(reset), { ...envelope(), input: input() });
  const rejected = await f.request('submit', id(reset), { ...envelope(), input: input() });
  assert.equal(rejected.code, 'history_limit'); assert.equal(rejected.state, null); assert.equal(f.calls(), 1);
  const small = fixture(t, { responseBytes: 700 }), empty = await small.request('resetFreshEmpty');
  const large = await small.request('submit', id(empty), { ...envelope(), input: input() });
  assert.equal(large.code, 'response_limit'); assert.equal(large.state, null); assert.equal(large.binding, null);
  assert.equal((await small.request('snapshot', id(empty))).code, 'conversation_unavailable');
});
test('deadline expiry before delivery is unknown after mutation and cannot restore cached output', async t => {
  const f = fixture(t, { deadlineMs: 100 }), reset = await f.request('resetFreshEmpty');
  const delivery = await f.controller.dispatch(f.actor, 'submit', { ...envelope(), input: input() }, new AbortController().signal, id(reset));
  f.advance(101);
  const response = JSON.parse(delivery.serialize().json) as NutritionWireResponse;
  assert.equal(response.status, 'unknown'); assert.equal(response.state, null);
  assert.equal((await f.request('snapshot', id(reset))).code, 'conversation_unavailable');
});
test('citation and rejected-submission limits are enforced before another native mutation', async t => {
  const f = fixture(t, { citationAttempts: 1 }), reset = await f.request('resetFreshEmpty');
  await f.request('submit', id(reset), { ...envelope(), input: input() });
  const selection = { ...envelope(), input: { parentTurnId: 1, statementId: 'absent' } };
  assert.equal((await f.request('selectCitation', id(reset), selection)).code, 'unknown_statement');
  assert.equal((await f.request('selectCitation', id(reset), selection)).code, 'history_limit');
  assert.equal(f.calls(), 1);
  const rejected = fixture(t, { rejectedSubmissions: 1 }), other = await rejected.request('resetFreshEmpty');
  await rejected.request('submit', id(other), { ...envelope(), input: input() });
  assert.equal((await rejected.request('submit', id(other), { ...envelope(), input: input() })).code, 'stale_turn');
  assert.equal((await rejected.request('submit', id(other), { ...envelope(), input: input() })).code, 'history_limit');
  assert.equal(rejected.calls(), 1);
});
test('retrieval failure preserves the full native unavailable turn instead of silently dropping history', async t => {
  const f = fixture(t), reset = await f.request('resetFreshEmpty');
  f.hooks.retrieve = () => { throw Error('Synthetic retrieval unavailable'); };
  const result = await f.request('submit', id(reset), { ...envelope(), input: input() });
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'retrieval_unavailable');
  assert.equal(result.resetRequired, false); assert.ok(result.binding);
  assert.equal(result.state?.conversation.turns[0]?.status, 'retrieval-unavailable');
  assert.deepEqual(result.state?.conversation.turns[0]?.input, input());
});
