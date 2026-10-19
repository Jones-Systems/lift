import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoachingRequestScope } from '../../src/voice-coaching/request-scope.js';
import { CoachingSessionController } from '../../src/voice-coaching/session-controller.js';
import { createCoachingLifecycleHooks } from '../../src/voice-coaching/lifecycle.js';
import type { AccountContext } from '../../src/lifecycle/types.js';

function actor() { return { accountId: 'account-a', authUserId: 'user-a', sessionId: 'session-a', epoch: 4 }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('scope validates immediately and preserves a frozen clone of the original actor', () => {
  const input = actor();
  const seen: AccountContext[] = [];
  const scope = createCoachingRequestScope(input, { assertActive: value => { seen.push(value); } }, new AbortController().signal);
  assert.equal(seen.length, 1);
  input.accountId = 'account-b'; input.authUserId = 'user-b'; input.sessionId = 'session-b'; input.epoch = 5;
  scope.assertCurrent();
  assert.deepEqual(scope.actor, actor());
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(Object.isFrozen(scope.actor), true);
  assert.notEqual(scope.actor, input);
  assert.equal(seen[0], scope.actor);
  assert.equal(seen[1], scope.actor);
});

test('pre-aborted requests cannot reach lifecycle admission', () => {
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  assert.throws(() => createCoachingRequestScope(actor(), { assertActive: () => assert.fail('admitted') }, abort.signal), /cancelled/);
});

test('lifecycle rejects expired admission before work', () => {
  assert.throws(() => createCoachingRequestScope(actor(), { assertActive: () => { throw new Error('expired'); } }, new AbortController().signal), /expired/);
});

test('epoch invalidation after await rejects completion under the original account', async () => {
  const input = actor();
  const seen: AccountContext[] = [];
  let epoch = 4;
  const controller = new CoachingSessionController(input, { assertActive: value => {
    seen.push(value);
    if (value.epoch !== epoch) throw new Error('epoch_expired');
  } }, new AbortController().signal);
  const operation = deferred<string>();
  const result = controller.run(async scope => { assert.equal(scope.actor.accountId, 'account-a'); return operation.promise; });
  input.accountId = 'account-b'; input.sessionId = 'session-b'; input.epoch = 5; epoch = 5;
  operation.resolve('old result');
  await assert.rejects(result, /epoch_expired/);
  assert.ok(seen.every(value => value.accountId === 'account-a' && value.sessionId === 'session-a' && value.epoch === 4));
});

test('abort during pending work rejects late success and all later dispatch', async () => {
  const abort = new AbortController();
  const controller = new CoachingSessionController(actor(), { assertActive: () => {} }, abort.signal);
  const operation = deferred<number>();
  const result = controller.run(() => operation.promise);
  abort.abort(new Error('request_cancelled'));
  operation.resolve(42);
  await assert.rejects(result, /request_cancelled/);
  await assert.rejects(controller.run(async () => { assert.fail('dispatched'); }));
});

test('lifecycle hook invalidation is idempotent and invalidates late completion', async () => {
  const controller = new CoachingSessionController(actor(), { assertActive: () => {} }, new AbortController().signal);
  const hook = createCoachingLifecycleHooks(controller);
  const operation = deferred<number>();
  const result = controller.run(() => operation.promise);
  hook.invalidate('logout'); hook.invalidate('account_changed');
  assert.equal(controller.scope.signal.reason, 'logout');
  operation.resolve(42);
  await assert.rejects(result);
});
