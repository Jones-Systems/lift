import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampleTransport } from '../public/member-sample/sample-transport.mjs';
import { createSampleSession } from '../public/member-sample/sample-session.mjs';

const fixedNow = () => Date.parse('2026-10-18T12:00:00.000Z');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fixture = (change = value => value) => {
  const transport = createSampleTransport({ now: fixedNow, seed: 31 });
  return { transport, session: createSampleSession({ transport: change(transport) }) };
};
const code = expected => error => error.code === expected;

// These cases execute only the injected memory transport and the real parsers/controller.
test('sample facade has one authoritative identity/resource snapshot and no construction requests', async () => {
  const { session, transport } = fixture();
  assert.equal(transport.calls.length, 0);
  assert.equal(session.snapshot().status, 'empty');
  assert.equal(session.readAccount(), null);
  await session.refresh();
  const snapshot = session.snapshot();
  assert.equal(snapshot.runtimeQualified, false);
  assert.equal(snapshot.status, 'ready');
  assert.strictEqual(snapshot.account.account, snapshot.application.account);
  assert.strictEqual(snapshot.account.entitlements, snapshot.application.entitlements);
  assert.notEqual(session.readAccount().authSessionId, snapshot.account.account.accountId);
  assert.equal(session.readAccount().accountEpoch, snapshot.generation);
  await session.plans();
  assert.equal(session.snapshot().application.resources.plans.status, 'ready');
  assert.throws(() => session.selectView('coach'), /Unknown application view/);
});

test('sample read failures retain stale qualification and empty scenario clears confirmed resources', async () => {
  const { session } = fixture(); await session.refresh(); await session.plans();
  await session.setScenario('read-error');
  await session.plans();
  assert.equal(session.snapshot().application.resources.plans.status, 'stale');
  await session.setScenario('malformed-response'); await session.plans();
  assert.equal(session.snapshot().application.resources.plans.status, 'stale');
  const before = session.snapshot().generation;
  await session.setScenario('empty');
  assert.ok(session.snapshot().generation > before);
  assert.deepEqual(session.snapshot().application.resources, {});
  await session.plans();
  assert.equal(session.snapshot().application.resources.plans.status, 'empty');
  assert.deepEqual(session.snapshot().application.resources.plans.data.items, []);
});

test('unknown write holds refresh and membership changes until explicit real-client reconciliation', async () => {
  const { session } = fixture(); await session.refresh(); await session.plans();
  const plan = session.snapshot().application.resources.plans.data.items[0];
  await session.plan(plan.id);
  await session.setScenario('lost-write-response');
  await session.editPlan(plan, { name: 'Fictional correction' });
  const generation = session.snapshot().generation;
  assert.equal(session.snapshot().application.resources[`plan:${plan.id}`].status, 'unknown');
  assert.throws(() => session.refresh(), code('unknown_intent_pending'));
  assert.throws(() => session.setPlus(true), code('unknown_intent_pending'));
  assert.equal(session.snapshot().generation, generation);
  await session.plan(plan.id);
  assert.equal(session.snapshot().application.resources[`plan:${plan.id}`].status, 'unknown');
  await session.reconcilePlan(plan.id);
  assert.equal(session.snapshot().application.resources[`plan:${plan.id}`].status, 'ready');
  await session.setPlus(true);
  assert.deepEqual(session.snapshot().account.entitlements.active, ['form_plus']);
  await session.setScenario('revoked-membership'); await session.refresh();
  assert.deepEqual(session.snapshot().account.entitlements.active, []);
});

test('conflict stays a conflict with confirmed prior facts and no optimistic plan overwrite', async () => {
  const { session } = fixture(); await session.refresh(); await session.plans();
  const plan = session.snapshot().application.resources.plans.data.items[0];
  await session.plan(plan.id); await session.setScenario('conflict');
  await session.editPlan(plan, { name: 'Not confirmed' });
  const state = session.snapshot().application.resources[`plan:${plan.id}`];
  assert.equal(state.status, 'conflict'); assert.equal(state.data.name, plan.name);
});

test('signout wipes immediately, drains an admitted read and discards its late response', async () => {
  const entered = deferred(), release = deferred();
  let signouts = 0;
  const { session } = fixture(transport => ({ ...transport,
    signout() { signouts++; return transport.signout(); },
    async fetchImpl(url, options) {
      const result = await transport.fetchImpl(url, options);
      if (new URL(url).pathname === '/v1/plans') { entered.resolve(); await release.promise; }
      return result;
    },
  }));
  await session.refresh();
  const read = session.plans();
  const rejection = assert.rejects(read, code('stale_generation'));
  await entered.promise;
  const logout = session.signout();
  assert.equal(session.snapshot().status, 'signing-out');
  assert.equal(session.readAccount(), null);
  assert.deepEqual(session.snapshot().application.resources, {});
  assert.equal(signouts, 0);
  release.resolve(); await rejection; await logout;
  assert.equal(signouts, 1); assert.equal(session.snapshot().status, 'anonymous');
  await session.refresh(); assert.equal(session.snapshot().status, 'anonymous');
});

test('replacement drains committed late writes before resetting fixture and isolates next account', async () => {
  const entered = deferred(), release = deferred(); let resets = 0;
  const { session } = fixture(transport => ({ ...transport,
    reset() { resets++; return transport.reset(); },
    async fetchImpl(url, options) {
      const result = await transport.fetchImpl(url, options);
      if (options.method === 'PATCH') { entered.resolve(); await release.promise; }
      return result;
    },
  }));
  await session.refresh(); await session.preferences();
  const saved = session.snapshot().application.resources.preferences.data;
  const write = session.savePreferences(saved, { sessionMinutes: 45 });
  const rejection = assert.rejects(write, code('stale_generation'));
  await entered.promise;
  const reset = session.reset();
  assert.equal(resets, 0); assert.equal(session.readAccount(), null);
  release.resolve(); await rejection; await reset;
  assert.equal(resets, 1);
  await session.preferences();
  assert.equal(session.snapshot().application.resources.preferences.data.sessionMinutes, 30);
  const first = session.readAccount();
  await session.switchAccount('alternate');
  assert.notEqual(session.readAccount().accountId, first.accountId);
  assert.notEqual(session.readAccount().authSessionId, first.authSessionId);
  assert.deepEqual(session.snapshot().application.resources, {});
});

test('late identity binding after invalidate cannot repopulate the session', async () => {
  const entered = deferred(), release = deferred(); let first = true;
  const { session } = fixture(transport => ({ ...transport, async fetchImpl(url, options) {
    const result = await transport.fetchImpl(url, options);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return result;
  } }));
  const checking = session.refresh(); await entered.promise;
  session.invalidate(); release.resolve(); await checking;
  assert.equal(session.snapshot().status, 'empty');
  assert.equal(session.snapshot().account.account, null);
  assert.deepEqual(session.snapshot().application.resources, {});
});

test('unexpected identity and failed signout expose no prior account and do not invent success', async () => {
  const { session, transport } = fixture(value => ({ ...value, signout() { throw new Error('fixture_signout_failed'); } }));
  await session.refresh(); transport.switchAccount('alternate');
  await assert.rejects(session.plans(), code('stale_generation'));
  assert.equal(session.snapshot().account.account, null);
  await session.refresh();
  await assert.rejects(session.signout(), /fixture_signout_failed/);
  assert.equal(session.snapshot().status, 'unknown');
  assert.equal(session.readAccount(), null);
  await session.refresh(); assert.equal(session.snapshot().status, 'ready');
});
