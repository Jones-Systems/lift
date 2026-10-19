import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, a, b, record } from './bootstrap-fixture.mjs';

test('factory requires preinstalled exact auth schema and never installs missing DDL', t => {
  const h = fixture(t, { schema: false });
  assert.throws(() => h.make(), /provider_auth_store_unavailable/);
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='wearable_provider_auth_state'").get().n, 0);
});

test('full original context is frozen before resolver and caller mutation cannot change the store actor', t => {
  const h = fixture(t), storage = h.make(), original = { ...a };
  h.state.afterResolver = () => Object.assign(original, b);
  const store = storage.storeFor(original);
  assert.equal(h.state.currentCalls, 0); assert.equal(Object.isFrozen(h.state.captured), true); assert.deepEqual(h.state.captured, a);
  const value = record(a); store.transaction(tx => tx.compareAndSwap(value.key, null, value));
  assert.equal(h.rows()[0].scope.accountId, a.accountId); assert.ok(h.state.currentCalls > 0);
});

test('authUserId is required and cannot be reconstructed from a provider scope', t => {
  const h = fixture(t), storage = h.make(), scope = record().scope;
  assert.throws(() => storage.storeFor(scope), /provider_auth_bootstrap_invalid/);
  for (const changed of [{ ...a, authUserId: '' }, { ...a, epoch: -1 }, { ...a, sessionId: '' }]) assert.throws(() => storage.storeFor(changed), /provider_auth_bootstrap_invalid/);
  assert.equal(h.state.captured, null);
});

test('account, auth identity, session and epoch mismatches reject when root admits the operation', t => {
  const h = fixture(t), storage = h.make();
  for (const changed of [{ ...a, accountId: b.accountId }, { ...a, authUserId: b.authUserId }, { ...a, sessionId: b.sessionId }, { ...a, epoch: 1 }]) {
    const store = storage.storeFor(changed);
    assert.throws(() => store.transaction(tx => tx.get(record().key)));
  }
  assert.equal(h.rows().length, 0);
});

test('active options must select the identical lifecycle database despite equivalent schemas', t => {
  const h = fixture(t), other = fixture(t);
  const storage = h.make({ activeStoreOptionsFor: ctx => other.options.activeStoreOptionsFor(ctx) });
  assert.throws(() => storage.storeFor(a), /provider_auth_bootstrap_invalid/);
  assert.equal(h.rows().length, 0); assert.equal(other.rows().length, 0);
});

test('raw SQL transaction and another active writer do not grant the original actor store authority', t => {
  const h = fixture(t), store = h.make().storeFor(a);
  assert.throws(() => store.currentTransaction());
  h.db.transaction(() => assert.throws(() => store.currentTransaction())).immediate();
  h.write(b, () => assert.throws(() => store.transaction(tx => tx.get(record().key))));
  h.write(a, () => assert.equal(store.currentTransaction().get(record().key), null));
});

test('currentness is rechecked after writes and rolls back a lost original session', t => {
  const h = fixture(t), store = h.make().storeFor(a), value = record();
  assert.throws(() => store.transaction(tx => {
    tx.compareAndSwap(value.key, null, value); h.db.prepare('DELETE FROM session WHERE id=?').run(a.sessionId);
  }));
  assert.equal(h.rows().length, 0); assert.ok(h.db.prepare('SELECT id FROM session WHERE id=?').get(a.sessionId));
});

test('synchronous option resolution rejects a thenable and a denied writer fails closed', t => {
  const h = fixture(t), selected = h.options.activeStoreOptionsFor(a);
  const asyncResolver = h.make({ activeStoreOptionsFor: () => Promise.resolve(selected) });
  assert.throws(() => asyncResolver.storeFor(a), /provider_auth_bootstrap_invalid/);
  const denied = h.make({ activeStoreOptionsFor: () => ({ ...selected, assertRootWriter() { throw Error('invented wrong writer'); } }) });
  assert.throws(() => denied.storeFor(a).transaction(tx => tx.get(record().key))); assert.equal(h.rows().length, 0);
});

test('raw lifecycle inventory and metadata export need an existing active root frame', t => {
  const h = fixture(t), storage = h.make(); h.seed(storage); h.seed(storage, b);
  assert.throws(() => storage.lifecycleAdapter.inventory(a)); assert.equal(h.state.lifecycleEntries, 1);
  h.write(a, () => {
    assert.equal(storage.lifecycleAdapter.inventory(a).count, 1);
    const exported = []; storage.lifecycleAdapter.export(a, { snapshotAtMs: 1000, append(category, value) { exported.push({ category, value }); } });
    assert.equal(exported[0].value.recordCount, 1); assert.equal(JSON.stringify(exported).includes('invented-connection'), false);
  });
  assert.equal(h.state.lifecycleEntries, 1);
});

test('distinct lifecycle custody suppresses records while active stores remain fenced and purge stays unavailable', t => {
  const h = fixture(t), storage = h.make(), activeStore = storage.storeFor(a); h.seed(storage); h.seed(storage, b);
  h.write(a, () => assert.throws(() => storage.lifecycleAdapter.suppress(a.accountId, 1)));
  h.lifecycleWrite(a, epoch => {
    assert.equal(storage.lifecycleAdapter.suppress(a.accountId, epoch).status, 'complete');
    assert.equal(storage.lifecycleAdapter.verifySuppressed(a.accountId, epoch).status, 'complete');
    assert.throws(() => activeStore.currentTransaction());
    assert.deepEqual(storage.lifecycleAdapter.purge('invented-purge', a.accountId), { status: 'unavailable', reason: 'exact_purge_executor_binding_required' });
  });
  assert.equal(h.rows().find(row => row.scope.accountId === a.accountId).suppressedEpoch, 1);
  assert.equal(h.rows().find(row => row.scope.accountId === b.accountId).suppressedEpoch, null);
  assert.throws(() => activeStore.transaction(tx => tx.get(record().key)));
});
