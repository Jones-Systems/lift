import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { assertActive, bindSuppressionAuthority, withActiveWrite } from '../../src/lifecycle/guards.ts';
import { createProviderAuthState, authStateKey } from '../../src/wearables/direct-provider-transport/auth-state.ts';
import { createProviderAuthLifecycle } from '../../src/wearables/direct-provider-transport/auth-lifecycle.ts';
import { createNodeAuthCipher } from '../../src/wearables/direct-provider-transport/node-auth-cipher.ts';
import { createSqliteAuthStateStore } from '../../src/wearables/direct-provider-transport/sqlite-auth-store.ts';
import { providerAuthStateSql } from '../../src/wearables/direct-provider-transport/auth-store-schema.ts';

export const scope = Object.freeze({ accountId: 'invented-account', sessionId: 'invented-session', epoch: 1,
  connectionId: 'invented-connection', generation: 1, provider: 'oura' });
export const redirect = 'https://form.invalid/provider/callback';
export const tokens = (version = 1) => ({ access_token: 'invented-access-' + version,
  refresh_token: 'invented-refresh-' + version, token_type: 'bearer', expires_in: 120,
  refresh_token_expires_in: 600, scope: 'daily' });
export const blank = (bound = scope) => ({ schema: 1, key: authStateKey(bound), revision: 0,
  scope: { ...bound }, suppressedEpoch: null, flows: [], operations: [], tokens: null });

export function fixture(t, { installSchema = true } = {}) {
  const db = new Database(':memory:');
  // Register handle cleanup before any schema, factory or assertion can fail; no file database or scratch is created.
  t.after(() => { if (db.open) db.close(); });
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE form_accounts(id TEXT PRIMARY KEY,auth_user_id TEXT NOT NULL UNIQUE);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE account_lifecycle(account_id TEXT PRIMARY KEY REFERENCES form_accounts(id),state TEXT NOT NULL,epoch INTEGER NOT NULL);
    CREATE TABLE fixture_markers(value TEXT NOT NULL);`);
  const context = { accountId: scope.accountId, authUserId: 'invented-user', sessionId: scope.sessionId, epoch: scope.epoch };
  db.prepare('INSERT INTO form_accounts VALUES(?,?)').run(context.accountId, context.authUserId);
  db.prepare('INSERT INTO session VALUES(?,?,?)').run(context.sessionId, context.authUserId, 8640000000000000);
  db.prepare('INSERT INTO account_lifecycle VALUES(?,?,?)').run(context.accountId, 'active', context.epoch);
  if (installSchema) db.exec(providerAuthStateSql);
  const root = { now: 1000, generation: 1, suppression: new Map(), purgeReady: false, failProofAt: 0, proofCalls: 0 };
  bindSuppressionAuthority(db, {
    currentSequence: () => root.suppression.size,
    lookup: accountId => root.suppression.get(accountId) ?? null,
    recordDisable(record) { const result = { ...record, sequence: root.suppression.size + 1 }; root.suppression.set(record.accountId, result); return result; },
    reconcileRestore(apply) { for (const record of root.suppression.values()) apply(record); return root.suppression.size; },
  });
  let writer = null;
  function witnessed(effect, kind) { const previous = writer; writer = kind; try { return effect(); } finally { writer = previous; } }
  const runRootWrite = effect => withActiveWrite(db, context, () => witnessed(effect, 'active'));
  const lifecycleWrite = effect => db.transaction(() => witnessed(effect, 'lifecycle')).immediate();
  const storeOptions = { db, runRootWrite, assertRootWriter(handle) {
    assert.equal(handle, db); assert.ok(writer); assert.equal(db.inTransaction, true);
    if (writer === 'active') assertActive(db, context);
  } };
  const makeStore = () => createSqliteAuthStateStore(storeOptions);
  const cipher = createNodeAuthCipher({ key: new Uint8Array(32).fill(7) });
  const assertCurrent = bound => { assert.deepEqual(bound, scope); assertActive(db, context); assert.equal(root.generation, bound.generation); };
  const make = (changes = {}) => createProviderAuthState({ scope, store: makeStore(), cipher, randomBytes,
    now: () => root.now, assertCurrent,
    assertRefreshUsable(bound, token) { assertCurrent(bound); assert.notEqual(token.expiresAtMs, null); },
    clientId: 'invented-client', clientSecretRef: 'invented-client-reference',
    clientSecrets: { async acquire() { throw Error('client secret acquisition is outside this fixture'); } },
    allowedRedirectUris: [redirect], stateLifetimeMs: 60000, ...changes });
  const lifecycle = () => createProviderAuthLifecycle({ store: makeStore(), assertAccountCurrent: ctx => assertActive(db, ctx),
    assertSuppression(accountId, epoch) {
      root.proofCalls++; assert.notEqual(root.proofCalls, root.failProofAt);
      assert.equal(writer, 'lifecycle'); assert.equal(root.suppression.get(accountId)?.epoch, epoch);
    },
    purgeReadiness(requestId, accountId) { return root.purgeReady && requestId === 'invented-purge' && accountId === scope.accountId
      ? { status: 'ready', epoch: 2 } : { status: 'unavailable', reason: 'exact_purge_executor_binding_required' }; },
  });
  function suppressLedger() { root.suppression.set(scope.accountId, { ...context, epoch: 2, requestId: 'invented-purge', disabledAtMs: root.now, sequence: 1 }); }
  function authorize(service = make()) {
    const started = service.beginAuthorization(redirect, ['daily']), state = new URL(started.url).searchParams.get('state');
    const callback = service.consumeCallback(state, 'invented-code');
    return { service, state, callback, lease: service.vault.begin('code', callback.operationId) };
  }
  function seed(service = make()) { const result = authorize(service); return { ...result, receipt: service.vault.commit(result.lease.id, tokens()) }; }
  const record = (key = authStateKey(scope)) => {
    const row = db.prepare('SELECT data FROM wearable_provider_auth_state WHERE record_key=?').get(key);
    return row ? JSON.parse(row.data) : null;
  };
  return { db, root, context, storeOptions, makeStore, cipher, make, lifecycle, runRootWrite, lifecycleWrite,
    suppressLedger, authorize, seed, record };
}
