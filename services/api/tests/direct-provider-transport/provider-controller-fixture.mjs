import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture as wearableFixture, a, b, record } from '../wearables/persistence/fixture.mjs';
import { createSqliteAuthStateStore } from '../../src/wearables/direct-provider-transport/sqlite-auth-store.ts';
import { providerAuthStateSql } from '../../src/wearables/direct-provider-transport/auth-store-schema.ts';
import { createNodeAuthCipher } from '../../src/wearables/direct-provider-transport/node-auth-cipher.ts';
import { createProviderAuthState, authStateKey } from '../../src/wearables/direct-provider-transport/auth-state.ts';
import { createProviderConnectionAuthPurge } from '../../src/wearables/direct-provider-transport/connection-auth-purge.ts';
import { stable } from '../../src/wearables/validation.ts';
import { createProviderController } from '../../src/wearables/direct-provider-transport/provider-controller.ts';

export { a, b };
export const direct = Object.freeze({ id: 'invented-direct', provider: 'oura', generation: 3, connected: true,
  types: ['steps'], consentVersion: 'invented-consent', retentionConsent: true, lastImportAt: null });
export const tokens = { access_token: 'invented-access', refresh_token: 'invented-refresh', token_type: 'bearer',
  expires_in: 120, refresh_token_expires_in: 600, scope: 'daily' };

export function fixture(t) {
  let hook, afterHook = null, calls = 0;
  // The reused fixture owns an in-memory handle and registers its close before creating tables.
  const h = wearableFixture(t, { externalConnectionPurge(ctx, scope) {
    calls++; const result = hook(ctx, scope); afterHook?.(result); return result;
  } });
  h.db.exec(providerAuthStateSql);
  h.db.exec('CREATE TABLE provider_fixture_markers(value TEXT NOT NULL)');
  for (const ctx of [a, b]) h.write(ctx, () => h.store.putConnection(ctx, direct));
  const makeStore = (ctx = a) => createSqliteAuthStateStore({ db: h.db, runRootWrite: effect => h.write(ctx, effect),
    assertRootWriter(handle) { assert.equal(handle, h.db); h.deps.control.assertWithinWrite(ctx); h.deps.lifecycle.assertActive(ctx); } });
  const authStore = makeStore(), cipher = createNodeAuthCipher({ key: new Uint8Array(32).fill(7) });
  const options = { authStore, wearableStore: h.store, assertActive: h.deps.lifecycle.assertActive,
    assertWithinWrite: h.deps.control.assertWithinWrite };
  const makeHook = (changes = {}) => createProviderConnectionAuthPurge({ ...options, ...changes });
  hook = makeHook();
  const seed = ({ ctx = a, connectionId = direct.id, generation = direct.generation } = {}) => {
    const scope = { accountId: ctx.accountId, sessionId: ctx.sessionId, epoch: ctx.epoch, connectionId, generation, provider: 'oura' };
    const value = { schema: 1, key: authStateKey(scope), revision: 0, scope, suppressedEpoch: null, flows: [], operations: [],
      tokens: { version: 1, issuedAtMs: 1000,
        access: { reference: 'invented-access-ref', purpose: 'access_token', ciphertext: cipher.seal('invented-access', 'invented-aad'), expiresAtMs: 121000, version: 1 },
        refresh: { reference: 'invented-refresh-ref', purpose: 'refresh_token', ciphertext: cipher.seal('invented-refresh', 'invented-aad'), expiresAtMs: 601000, version: 1 } } };
    makeStore(ctx).transaction(tx => assert.equal(tx.compareAndSwap(value.key, null, value), true)); return value;
  };
  const retired = { connectionId: direct.id, generation: direct.generation + 1 };
  const retire = (changes = {}) => h.store.putConnection(a, { ...direct, generation: retired.generation, connected: false, retentionConsent: false, ...changes });
  function populateImport() {
    const page = { version: 1, connectionId: direct.id, generation: direct.generation, stream: 'invented-oura-stream',
      fromCursor: null, nextCursor: 'invented-next', pageId: 'invented-import', batch: [record()], tombstones: [] };
    const binding = stable([a.accountId, a.sessionId, a.epoch, 'oura', direct.id, direct.generation, page.stream, null]);
    h.providerIntent({ ctx: a, provider: 'oura', connectionId: direct.id, generation: direct.generation, stream: page.stream, cursor: null })
      .save({ key: page.pageId, binding, page });
    h.service.ingest(a, page.pageId, page, { provider: 'oura' });
  }
  function makeAuth() {
    const scope = { accountId: a.accountId, sessionId: a.sessionId, epoch: a.epoch, provider: 'oura', connectionId: direct.id, generation: direct.generation };
    const assertCurrent = bound => {
      assert.deepEqual(bound, scope); h.deps.lifecycle.assertActive(a);
      const connection = h.store.connection(a, direct.id);
      assert.equal(connection.generation, bound.generation); assert.equal(connection.connected, true); assert.equal(connection.retentionConsent, true);
    };
    return createProviderAuthState({ scope, store: authStore, cipher, randomBytes, now: () => 1000, assertCurrent,
      assertRefreshUsable: bound => assertCurrent(bound), clientId: 'invented-client', clientSecretRef: 'invented-client-ref',
      clientSecrets: { async acquire() { throw Error('no client acquisition in local purge fixture'); } },
      allowedRedirectUris: ['https://form.invalid/callback'], stateLifetimeMs: 60000 });
  }
  const rows = () => h.db.prepare('SELECT record_key,data FROM wearable_provider_auth_state ORDER BY record_key').all();
  return { ...h, authStore, makeStore, makeHook, seed, retire, retired, rows, populateImport, makeAuth,
    hook: (ctx, scope) => hook(ctx, scope), setHook: value => { hook = value; },
    setAfterHook: value => { afterHook = value; }, calls: () => calls };
}

export function faultStore(store, wrap) {
  return { currentTransaction: () => store.currentTransaction(), transaction: effect => store.transaction(tx => effect(wrap(tx))) };
}

export function controllerFixture(t, changes = {}) {
  const h = wearableFixture(t); h.db.exec(providerAuthStateSql);
  const state = { now: Date.parse('2026-10-11T00:00:00Z'), calls: [], responses: [], serial: 0, allowed: true, releases: 0, afterDispatch: null };
  const clientSecrets = { async acquire(scope, reference, purpose, signal) {
    assert.equal(scope.accountId, a.accountId); assert.equal(reference, 'invented-client-ref'); assert.equal(purpose, 'client_secret'); assert.equal(signal.aborted, false);
    return { value: 'invented-client-secret', release() { state.releases++; } };
  } };
  const configuration = { clientId: 'invented-client', clientSecretRef: 'invented-client-ref', clientSecrets,
    allowedRedirectUris: ['https://form.invalid/callback'], stateLifetimeMs: 60000 };
  const options = { context: a, root: h.deps, key: new Uint8Array(32).fill(7),
    assertRootWriter(db) { assert.equal(db, h.db); h.deps.control.assertWithinWrite(a); },
    enabled: () => true, assertAllowed() { if (!state.allowed) throw Error('invented-provider-denial'); },
    assertRefreshUsable(scope, token) { h.deps.lifecycle.assertActive(a); assert.equal(scope.accountId, a.accountId); assert.notEqual(token.expiresAtMs, null); },
    now: () => state.now, newKey: () => 'invented-page-' + (++state.serial), providers: { oura: configuration, garmin: configuration },
    async transport(request) {
      state.calls.push({ method: request.method, url: request.url }); state.afterDispatch?.();
      const next = state.responses.shift(); if (next instanceof Error) throw next;
      assert.ok(next, 'synthetic response must be explicitly queued');
      const bytes = new TextEncoder().encode(JSON.stringify(next)); let read = false;
      return { status: 200, headers: [['content-type', 'application/json']],
        async read(maxBytes) { if (read) return null; read = true; assert.ok(bytes.length <= maxBytes); return bytes; }, cancel() {} };
    }, ...changes };
  const make = (extra = {}) => createProviderController({ ...options, ...extra });
  const controller = make();
  const prepare = (provider = 'oura') => controller.prepare('invented-prepare-' + provider, { provider, connectionId: 'invented-controller-' + provider,
    expectedGeneration: null, types: ['steps', 'active_energy'], consentVersion: 'invented-consent', retentionConsent: true });
  const authorize = (binding = prepare(), owner = controller) => {
    const session = owner.session(binding), started = session.beginAuthorization('https://form.invalid/callback', binding.provider === 'oura' ? ['daily'] : []);
    const callbackState = new URL(started.url).searchParams.get('state'); return { binding, session, callbackState };
  };
  async function connected(provider = 'oura') {
    const auth = authorize(prepare(provider)); state.responses.push(tokens);
    const receipt = await auth.session.completeCode(auth.callbackState, 'invented-code'); return { ...auth, receipt };
  }
  const authRecord = binding => {
    const row = h.db.prepare('SELECT data FROM wearable_provider_auth_state WHERE record_key=?')
      .get(authStateKey({ ...binding, accountId: a.accountId })); return row ? JSON.parse(row.data) : null;
  };
  return { ...h, state, options, make, controller, prepare, authorize, connected, authRecord };
}

export const ouraPage = { data: [{ id: 'invented-day', day: '2026-10-09', timestamp: '2026-10-09T00:00:00Z', steps: 123, active_calories: 45 }], next_token: 'invented-next' };
export const ouraRange = { collection: 'daily_activity', from: '2026-10-09', to: '2026-10-10', cursor: null };
