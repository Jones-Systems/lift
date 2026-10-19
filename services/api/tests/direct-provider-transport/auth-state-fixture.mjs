import assert from 'node:assert/strict';
import { createProviderAuthState, authStateKey } from '../../src/wearables/direct-provider-transport/auth-state.ts';
import { createProviderAuthLifecycle } from '../../src/wearables/direct-provider-transport/auth-lifecycle.ts';

export const scope = Object.freeze({ accountId: 'invented-account', sessionId: 'invented-session', epoch: 1, connectionId: 'invented-connection', generation: 1, provider: 'oura' });
export const redirect = 'https://form.invalid/provider/callback';
export const tokens = (version = 1) => ({ access_token: 'invented-access-' + version, refresh_token: 'invented-refresh-' + version,
  token_type: 'bearer', expires_in: 120, refresh_token_expires_in: 600, scope: 'daily' });
export function fixture() {
  const root = { records: new Map(), ciphertext: new Map(), currentScope: { ...scope }, enabled: true, now: 1000, serial: 0,
    depth: 0, failCas: false, failDelete: false, failSeal: false, failOpen: false, afterCas: null, afterSeal: null,
    suppression: null, purgeReady: false, unknownExpiryQualified: false, clientReleaseCount: 0, clientAcquire: null };
  const tx = {
    get(key) { return structuredClone(root.records.get(key) ?? null); },
    compareAndSwap(key, revision, next) {
      assert.ok(root.depth > 0);
      if (root.failCas || (root.records.get(key)?.revision ?? null) !== revision) return false;
      root.records.set(key, structuredClone(next)); root.afterCas?.(); return true;
    },
    listAccount(accountId, limit) { return [...root.records.values()].filter(record => record.scope.accountId === accountId).slice(0, limit).map(record => structuredClone(record)); },
    delete(key, revision) {
      assert.ok(root.depth > 0);
      if (root.failDelete || root.records.get(key)?.revision !== revision) return false;
      return root.records.delete(key);
    },
  };
  const store = {
    transaction(effect) {
      const before = structuredClone(root.records); root.depth++;
      try {
        const value = effect(tx); if (value && typeof value.then === 'function') throw Error('async transaction forbidden'); return value;
      } catch (error) { root.records = before; throw error; } finally { root.depth--; }
    },
    currentTransaction() { if (!root.depth) throw Error('root transaction required'); return tx; },
  };
  const assertCurrent = requested => {
    if (!root.enabled || root.suppression || JSON.stringify(requested) !== JSON.stringify(root.currentScope)) throw Error('invented-private-currentness-detail');
  };
  const cipher = {
    seal(value, associatedData) {
      if (root.failSeal) throw Error('invented-private-cipher-detail');
      const sealed = 'invented-opaque-ciphertext-' + (++root.serial);
      root.ciphertext.set(sealed, { value, associatedData }); root.afterSeal?.(); return sealed;
    },
    open(sealed, associatedData) {
      if (root.failOpen) throw Error('invented-private-cipher-detail');
      const found = root.ciphertext.get(sealed);
      if (!found || found.associatedData !== associatedData) throw Error('invented-authentication-failure'); return found.value;
    },
  };
  const options = {
    scope, store, cipher, assertCurrent, now: () => root.now,
    randomBytes(length) { const value = new Uint8Array(length); new DataView(value.buffer).setUint32(length - 4, ++root.serial); return value; },
    assertRefreshUsable(bound, token) { assertCurrent(bound); if (token.expiresAtMs === null && !root.unknownExpiryQualified) throw Error('refresh expiry unqualified'); },
    clientId: 'invented-client', clientSecretRef: 'invented-client-ref',
    clientSecrets: { async acquire(bound, reference, purpose, signal) {
      assertCurrent(bound); assert.equal(reference, 'invented-client-ref'); assert.equal(purpose, 'client_secret'); assert.equal(signal.aborted, false);
      if (root.clientAcquire) return root.clientAcquire();
      return { value: 'invented-client-secret', release() { root.clientReleaseCount++; } };
    } },
    allowedRedirectUris: [redirect], stateLifetimeMs: 60000,
  };
  const make = (changes = {}) => createProviderAuthState({ ...options, ...changes });
  const context = { accountId: scope.accountId, authUserId: 'invented-auth-user', sessionId: scope.sessionId, epoch: scope.epoch };
  const lifecycle = createProviderAuthLifecycle({ store,
    assertAccountCurrent(ctx) { if (ctx.accountId !== root.currentScope.accountId || ctx.authUserId !== context.authUserId || ctx.sessionId !== root.currentScope.sessionId || ctx.epoch !== root.currentScope.epoch || !root.enabled || root.suppression) throw Error('invented-private-account-detail'); },
    assertSuppression(accountId, epoch) { assert.ok(root.depth > 0); if (!root.suppression || root.suppression.accountId !== accountId || root.suppression.epoch !== epoch) throw Error('ledger proof unavailable'); },
    purgeReadiness(requestId, accountId) { return root.purgeReady && requestId === 'invented-purge' && accountId === scope.accountId
      ? { status: 'ready', epoch: 2 } : { status: 'unavailable', reason: 'exact_purge_executor_binding_required' }; },
  });
  function authorize(service = make()) {
    const started = service.beginAuthorization(redirect, ['daily']);
    const state = new URL(started.url).searchParams.get('state');
    const bound = service.consumeCallback(state, 'invented-code');
    return { service, started, state, bound, lease: service.vault.begin('code', bound.operationId) };
  }
  function seed(service = make(), issued = tokens()) {
    const auth = authorize(service); return { ...auth, receipt: service.vault.commit(auth.lease.id, issued) };
  }
  return { root, store, options, make, context, lifecycle, authorize, seed,
    record: () => structuredClone(root.records.get(authStateKey(scope))) };
}
