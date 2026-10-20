import assert from 'node:assert/strict';
import { fixture as persistenceFixture, a, b } from '../wearables/persistence/fixture.mjs';
import { providerAuthStateSql } from '../../src/wearables/direct-provider-transport/auth-store-schema.ts';
import { authStateKey } from '../../src/wearables/direct-provider-transport/auth-state.ts';
import { createProviderAuthStorage } from '../../src/wearables/direct-provider-transport/bootstrap.ts';

export { a, b };
export const record = (ctx = a) => {
  const scope = { accountId: ctx.accountId, sessionId: ctx.sessionId, epoch: ctx.epoch, provider: 'oura', connectionId: 'invented-connection', generation: 1 };
  return { schema: 1, key: authStateKey(scope), revision: 0, scope, suppressedEpoch: null, flows: [], operations: [], tokens: null };
};
export function fixture(t, { schema = true } = {}) {
  const h = persistenceFixture(t); if (schema) h.db.exec(providerAuthStateSql);
  const state = { captured: null, currentCalls: 0, lifecycleEntries: 0, afterResolver: null };
  let active = null, suppression = null;
  const write = (ctx, effect) => h.write(ctx, () => {
    const prior = active; active = ctx; try { return effect(); } finally { active = prior; }
  });
  const assertAccountCurrent = ctx => { state.currentCalls++; h.deps.control.assertWithinWrite(ctx); h.deps.lifecycle.assertActive(ctx); };
  const assertSuppression = (accountId, epoch) => {
    assert.ok(suppression); assert.equal(suppression.accountId, accountId); assert.equal(suppression.epoch, epoch);
    assert.equal(h.db.inTransaction, true); h.deps.control.assertSuppression(accountId, epoch);
  };
  const lifecycleStoreOptions = { db: h.db,
    runRootWrite() { state.lifecycleEntries++; throw Error('root lifecycle frame required'); },
    assertRootWriter(db) {
      assert.equal(db, h.db); assert.equal(db.inTransaction, true);
      if (suppression) assertSuppression(suppression.accountId, suppression.epoch);
      else { assert.ok(active); assertAccountCurrent(active); }
    } };
  const options = { lifecycleStoreOptions, assertAccountCurrent, assertSuppression,
    purgeReadiness: () => ({ status: 'unavailable', reason: 'exact_purge_executor_binding_required' }),
    activeStoreOptionsFor(ctx) {
      state.captured = ctx; state.afterResolver?.();
      return { db: h.db, runRootWrite: effect => write(ctx, effect), assertRootWriter(db) { assert.equal(db, h.db); assertAccountCurrent(ctx); } };
    } };
  // This is an explicitly synthetic lifecycle-port harness, not a copy or qualification of WS01's unreleased writer.
  const lifecycleWrite = (ctx, effect) => h.db.transaction(() => {
    h.disable(ctx); const epoch = ctx.epoch + 1;
    h.db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=? WHERE account_id=?").run(epoch, ctx.accountId);
    suppression = { accountId: ctx.accountId, epoch };
    try { return effect(epoch); } finally { suppression = null; }
  }).immediate();
  const make = (changes = {}) => createProviderAuthStorage({ ...options, ...changes });
  const seed = (storage, ctx = a) => { const value = record(ctx); storage.storeFor(ctx).transaction(tx => assert.equal(tx.compareAndSwap(value.key, null, value), true)); return value; };
  const rows = () => h.db.prepare('SELECT data FROM wearable_provider_auth_state ORDER BY record_key').all().map(row => JSON.parse(row.data));
  return { ...h, state, options, write, lifecycleWrite, make, seed, rows };
}
