import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDomainReadPorts } from '../src/domain-ports.mjs';
import { createFormAdapter } from '../src/index.mjs';
import { identity, now, plan, workout } from './fixtures.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const domain = {
    history: (...args) => { calls.push(['history', ...args]); return { items: [workout()], nextBefore: null }; },
    session: (...args) => { calls.push(['session', ...args]); return { ...workout(), wearable: 'private', planSnapshot: {} }; },
    plan: (...args) => { calls.push(['plan', ...args]); return { ...plan(), health: 'private' }; },
    plans: () => assert.fail('Unbounded plan read'),
    account: () => assert.fail('Provisioning read'),
  };
  const ports = createDomainReadPorts({ domain, now, resolveAccount: subject => subject === identity().subject ? 'account_a' : null,
    withActiveAccountRead: (context, read) => { calls.push(['guard', context]); return read(); }, ...overrides });
  return { ports, calls };
}

test('bridge is unavailable without both trusted boundary functions', () => {
  const domain = { history: () => assert.fail('No read') };
  assert.deepEqual(createDomainReadPorts(), {});
  assert.deepEqual(createDomainReadPorts({ domain }), {});
  assert.deepEqual(createDomainReadPorts({ domain, resolveAccount: () => 'account_a' }), {});
});

test('named Domain reads receive verified account, bounded arguments and preserve voided sets', async () => {
  const { ports, calls } = fixture();
  const adapter = createFormAdapter({ ports, now, verifyIdentity: identity });
  const detail = await adapter.dispatch('form_get_workout', { workoutId: 'workout_1' });
  assert.equal(detail.structuredContent.ok, true);
  assert.equal(detail.structuredContent.data.sets[0].status, 'voided');
  assert.ok(!JSON.stringify(detail).includes('private'));
  assert.ok(!JSON.stringify(detail).includes('planSnapshot'));
  const page = ports.listWorkouts({ identity: identity(), limit: 1, before: 'cursor' });
  assert.equal(page.items[0].accountId, 'account_a');
  assert.deepEqual(calls.at(-1), ['history', 'account_a', 1, 'cursor']);
  assert.equal(ports.getPlan({ identity: identity(), planId: 'plan_1' }).health, undefined);
  assert.equal(ports.listPlans, undefined);
});

test('foreign mappings, expired identities, scopes and lifecycle denial prevent domain reads', () => {
  for (const overrides of [
    { resolveAccount: () => 'account_b' }, { resolveAccount: () => null },
    { withActiveAccountRead: () => { throw new Error('Inactive'); } },
  ]) {
    const { ports, calls } = fixture(overrides);
    assert.throws(() => ports.getWorkout({ identity: identity(), workoutId: 'workout_1' }));
    assert.equal(calls.filter(call => call[0] === 'session').length, 0);
  }
  const { ports, calls } = fixture();
  for (const value of [{ ...identity(), expiresAtMs: 1000 }, { ...identity(), scopes: [] }]) {
    assert.throws(() => ports.listWorkouts({ identity: value, limit: 1 }));
  }
  assert.equal(calls.length, 0);
});

test('bridge rejects oversized pages and invalid direct arguments before reading', () => {
  const { ports, calls } = fixture();
  for (const limit of [0, 21, 1.5]) assert.throws(() => ports.listWorkouts({ identity: identity(), limit }));
  assert.throws(() => ports.getPlan({ identity: identity(), planId: '../escape' }));
  assert.equal(calls.length, 0);
  const huge = fixture({ domain: { history: () => ({ items: [workout(), workout()], nextBefore: null }) } });
  assert.throws(() => huge.ports.listWorkouts({ identity: identity(), limit: 1 }));
});

test('bounded plan reader is explicit and hasMore is preserved', () => {
  let args;
  const { ports } = fixture({ plansPage: (...input) => { args = input; return { items: [plan()], hasMore: true }; } });
  assert.deepEqual(ports.listPlans({ identity: identity(), limit: 1 }), {
    accountId: 'account_a', items: [{ ...plan(), items: undefined, accountId: 'account_a' }].map(({ items, ...rest }) => rest), hasMore: true,
  });
  assert.deepEqual(args, ['account_a', 1]);
});

test('only exact Domain not_found becomes null, other failures stay unavailable', async () => {
  const missing = fixture({ domain: { session: () => { throw Object.assign(new Error('private'), { status: 404, code: 'not_found' }); } } });
  assert.equal(missing.ports.getWorkout({ identity: identity(), workoutId: 'workout_1' }), null);
  const broken = fixture({ domain: { session: () => { throw new Error('private health detail'); } } });
  const result = await createFormAdapter({ ports: broken.ports, now, verifyIdentity: identity })
    .dispatch('form_get_workout', { workoutId: 'workout_1' });
  assert.equal(result.structuredContent.error.code, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('health detail'));
});

test('async resolvers or guards and expiry during the guarded read fail closed', () => {
  const asynchronous = fixture({ resolveAccount: async () => 'account_a' });
  assert.throws(() => asynchronous.ports.getPlan({ identity: identity(), planId: 'plan_1' }));
  const asyncGuard = fixture({ withActiveAccountRead: async (_context, read) => read() });
  assert.throws(() => asyncGuard.ports.getPlan({ identity: identity(), planId: 'plan_1' }));
  let time = 1000;
  const stale = fixture({ now: () => time, domain: { plan: () => { time = 2000; return plan(); } } });
  assert.throws(() => stale.ports.getPlan({ identity: identity(), planId: 'plan_1' }));
});
