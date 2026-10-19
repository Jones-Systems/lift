import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderOAuth } from '../../src/wearables/providers/oauth.ts';
import { createDirectProviderTransport } from '../../src/wearables/direct-provider-transport/index.ts';
import { AuthStateFailure, authStateKey } from '../../src/wearables/direct-provider-transport/auth-state.ts';
import { fixture, scope, redirect, tokens } from './auth-state-fixture.mjs';

const failure = error => error instanceof AuthStateFailure && !error.message.includes('invented-private');
const signal = () => new AbortController().signal;

test('one-use callback survives recreation; state and PKCE plaintext never persist', () => {
  const h = fixture(), first = h.make(); const started = first.beginAuthorization(redirect, ['daily']);
  const url = new URL(started.url), state = url.searchParams.get('state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(state.length, 43);
  const serialized = JSON.stringify([...h.root.records.values()]);
  assert.equal(serialized.includes(state), false); assert.equal(serialized.includes('invented-code'), false);
  const restarted = h.make(), callback = restarted.consumeCallback(state, 'invented-code');
  assert.equal(callback.redirectUri, redirect); assert.equal(h.record().flows[0].status, 'consumed');
  assert.throws(() => first.consumeCallback(state, 'invented-code'), failure);
  assert.equal(restarted.vault.begin('code', callback.operationId).secretRef, callback.verifierRef);
});

test('state rejects altered callback, unregistered redirect, expiry, and changed original identity', () => {
  for (const field of ['accountId', 'sessionId', 'epoch', 'connectionId', 'generation', 'provider']) {
    const h = fixture(), s = h.make(); const state = new URL(s.beginAuthorization(redirect, ['daily']).url).searchParams.get('state');
    h.root.currentScope[field] = typeof h.root.currentScope[field] === 'number' ? 9 : 'changed';
    assert.throws(() => s.consumeCallback(state, 'invented-code'), failure); assert.equal(h.record().flows[0].status, 'pending');
  }
  const h = fixture(), s = h.make(); assert.throws(() => s.beginAuthorization('https://other.invalid/callback', ['daily']), failure);
  const state = new URL(s.beginAuthorization(redirect, ['daily']).url).searchParams.get('state');
  assert.throws(() => s.consumeCallback(state + 'x', 'invented-code'), failure);
  h.root.now += 60000; assert.throws(() => s.consumeCallback(state, 'invented-code'), failure);
  assert.equal(h.record().operations.length, 0);
});

test('code and refresh leases exclude other instances; crashes and unknown outcomes never reopen by age', () => {
  const h = fixture(), auth = h.seed(); const other = h.make();
  const lease = auth.service.vault.begin('refresh', 'refresh-one');
  assert.throws(() => other.vault.begin('refresh', 'refresh-two'), failure);
  assert.deepEqual(other.reconcile('refresh-one'), { status: 'unknown' });
  h.root.now += 900000;
  assert.throws(() => h.make().vault.begin('refresh', 'refresh-three'), failure);
  other.vault.unknown(lease.id); assert.throws(() => other.vault.rejected(lease.id), failure);
  assert.throws(() => other.beginAuthorization(redirect, ['daily']), failure);
  assert.equal(h.record().operations.at(-1).phase, 'unknown');
});

test('token rotation is CAS-bound, retires old references and preserves exact completion receipts', async () => {
  const h = fixture(), first = h.seed();
  const access = await first.service.secrets.acquire(scope, first.receipt.accessSecretRef, 'access_token', signal());
  assert.equal(access.value, tokens().access_token); access.release(); assert.throws(() => access.value, failure);
  const lease = h.make().vault.begin('refresh', 'refresh-one');
  const refresh = await first.service.secrets.acquire(scope, lease.secretRef, 'refresh_token', signal());
  assert.equal(refresh.value, tokens().refresh_token); refresh.release();
  const result = first.service.vault.commit(lease.id, tokens(2)); assert.equal(result.version, 2);
  assert.deepEqual(h.make().vault.commit(lease.id, tokens(2)), result);
  assert.throws(() => first.service.vault.commit(lease.id, tokens(3)), failure);
  first.service.vault.unknown(lease.id); first.service.vault.rejected(lease.id);
  assert.deepEqual(h.make().reconcile('refresh-one'), { status: 'committed', receipt: result });
  await assert.rejects(first.service.secrets.acquire(scope, first.receipt.accessSecretRef, 'access_token', signal()), failure);
  assert.equal(JSON.stringify([...h.root.records.values()]).includes(tokens(2).access_token), false);
});

test('lease outcome transitions cannot overwrite committed receipt or recycle operation IDs', () => {
  const h = fixture(), seeded = h.seed();
  const lease = seeded.service.vault.begin('refresh', 'known-reject'); seeded.service.vault.rejected(lease.id);
  seeded.service.vault.unknown(lease.id); assert.deepEqual(h.make().reconcile('known-reject'), { status: 'rejected' });
  assert.throws(() => seeded.service.vault.begin('refresh', 'known-reject'), failure);
  assert.ok(seeded.service.vault.begin('refresh', 'fresh-operation').id);
  assert.deepEqual(h.make().reconcile('absent'), { status: 'absent' });
});

test('cipher/CAS/currentness failures roll back rotation and preserve unresolved lease', () => {
  for (const fault of ['cipher', 'cas', 'during-cipher', 'after-cas']) {
    const h = fixture(), s = h.seed().service, lease = s.vault.begin('refresh', 'refresh-one'), before = h.record();
    if (fault === 'cipher') h.root.failSeal = true;
    if (fault === 'cas') h.root.failCas = true;
    if (fault === 'during-cipher') h.root.afterSeal = () => { h.root.enabled = false; };
    if (fault === 'after-cas') h.root.afterCas = () => { h.root.enabled = false; };
    assert.throws(() => s.vault.commit(lease.id, tokens(2)), failure); assert.deepEqual(h.record(), before);
  }
});

test('callback consume rollback preserves one-use state on CAS/currentness failure', () => {
  const h = fixture(), s = h.make(), state = new URL(s.beginAuthorization(redirect, ['daily']).url).searchParams.get('state');
  h.root.failCas = true; assert.throws(() => s.consumeCallback(state, 'invented-code'), failure);
  assert.equal(h.record().flows[0].status, 'pending'); assert.equal(h.record().operations.length, 0);
  h.root.failCas = false; assert.ok(h.make().consumeCallback(state, 'invented-code').operationId);
});

test('resolver fences wrong purpose/scope/reference, expiry, authenticated ciphertext and abort', async () => {
  const h = fixture(), seeded = h.seed(), ref = seeded.receipt.accessSecretRef;
  await assert.rejects(seeded.service.secrets.acquire({ ...scope, sessionId: 'other-session' }, ref, 'access_token', signal()), failure);
  await assert.rejects(seeded.service.secrets.acquire(scope, ref, 'refresh_token', signal()), failure);
  await assert.rejects(seeded.service.secrets.acquire(scope, 'other-ref', 'access_token', signal()), failure);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(seeded.service.secrets.acquire(scope, ref, 'access_token', controller.signal), failure);
  const record = h.root.records.get(authStateKey(scope)); record.tokens.access.ciphertext = record.tokens.refresh.ciphertext;
  await assert.rejects(seeded.service.secrets.acquire(scope, ref, 'access_token', signal()), failure);
  h.root.now += 120000;
  await assert.rejects(seeded.service.secrets.acquire(scope, ref, 'access_token', signal()), failure);
});

test('PKCE resolution requires its exact active code lease and retires after commit', async () => {
  const h = fixture(), s = h.make(), state = new URL(s.beginAuthorization(redirect, ['daily']).url).searchParams.get('state');
  const callback = s.consumeCallback(state, 'invented-code');
  await assert.rejects(s.secrets.acquire(scope, callback.verifierRef, 'code_verifier', signal()), failure);
  const lease = s.vault.begin('code', callback.operationId);
  const verifier = await s.secrets.acquire(scope, callback.verifierRef, 'code_verifier', signal()); assert.equal(verifier.value.length, 43); verifier.release();
  s.vault.commit(lease.id, tokens());
  await assert.rejects(s.secrets.acquire(scope, callback.verifierRef, 'code_verifier', signal()), failure);
});

test('unknown provider refresh expiry needs explicit injected qualification, never an invented lifetime', () => {
  const h = fixture(), seeded = h.seed(h.make(), { ...tokens(), refresh_token_expires_in: null });
  assert.equal(h.record().tokens.refresh.expiresAtMs, null);
  assert.throws(() => seeded.service.vault.begin('refresh', 'unqualified'), failure);
  h.root.unknownExpiryQualified = true; assert.ok(seeded.service.vault.begin('refresh', 'qualified').id);
});

test('provider expiry is conservative from exchange start, with invalid/expired responses rejected', () => {
  const h = fixture(), auth = h.authorize(); h.root.now += 1000;
  auth.service.vault.commit(auth.lease.id, tokens()); assert.equal(h.record().tokens.access.expiresAtMs, 121000);
  for (const bad of [{ ...tokens(), expires_in: 0 }, { ...tokens(), expires_in: Number.MAX_SAFE_INTEGER }, { ...tokens(), token_type: 'basic' }]) {
    const next = fixture(), pending = next.authorize(); assert.throws(() => pending.service.vault.commit(pending.lease.id, bad), failure); assert.equal(next.record().tokens, null);
  }
  const expired = fixture(), pending = expired.authorize(); expired.root.now += 120000;
  assert.throws(() => pending.service.vault.commit(pending.lease.id, tokens()), failure); assert.equal(expired.record().tokens, null);
});

test('bounded records fail closed without evicting callback or operation uncertainty', () => {
  const h = fixture(), s = h.make({ limits: { flows: 1, operations: 1, accountRecords: 1 } });
  const seeded = h.seed(s); assert.throws(() => s.beginAuthorization(redirect, ['daily']), failure);
  assert.throws(() => s.vault.begin('refresh', 'over-capacity'), failure);
  assert.equal(h.record().operations.length, 1); assert.deepEqual(s.reconcile(seeded.bound.operationId), { status: 'committed', receipt: seeded.receipt });
  h.root.currentScope = { ...scope, connectionId: 'second-connection' };
  const second = h.make({ scope: h.root.currentScope, limits: { accountRecords: 1 } });
  assert.throws(() => second.beginAuthorization(redirect, ['daily']), failure); assert.equal(h.root.records.size, 1);
});

test('client-secret await rechecks original currentness and releases late lease after suppression', async () => {
  const h = fixture(), auth = h.authorize(); let finish; let started;
  const entered = new Promise(resolve => { started = resolve; });
  h.root.clientAcquire = () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const pending = auth.service.secrets.acquire(scope, 'invented-client-ref', 'client_secret', signal());
  const rejected = assert.rejects(pending, failure); await entered;
  h.root.suppression = { accountId: scope.accountId, epoch: 2 };
  finish({ value: 'invented-client-secret', release() { h.root.clientReleaseCount++; } }); await rejected;
  assert.equal(h.root.clientReleaseCount, 1);
});

test('existing OAuth and transport consume auth-state ports without changed interfaces or network', async () => {
  for (const provider of ['oura', 'garmin']) {
    const h = fixture(); h.root.currentScope = { ...scope, provider };
    const s = h.make({ scope: h.root.currentScope }); let count = 0;
    const http = createDirectProviderTransport({ scope: h.root.currentScope, assertCurrent: h.options.assertCurrent, secrets: s.secrets, allowedRedirectUris: [redirect],
      async transport(request) {
        count++; const form = new URLSearchParams(request.body); assert.equal(form.get('client_secret'), 'invented-client-secret');
        assert.equal(form.get('grant_type'), count === 1 ? 'authorization_code' : 'refresh_token');
        let read = false; return { status: 200, headers: [['content-type', 'application/json']], async read() { if (read) return null; read = true; return new TextEncoder().encode(JSON.stringify(tokens(count))); }, cancel() {} };
      } });
    const oauth = createProviderOAuth({ provider, clientId: 'invented-client', clientSecretRef: 'invented-client-ref', http, vault: s.vault,
      consumeCallback: s.consumeCallback, now: () => h.root.now, admission: { assertAllowed() {}, assertCurrent() { h.options.assertCurrent(h.root.currentScope); } } });
    const state = new URL(s.beginAuthorization(redirect, provider === 'oura' ? ['daily'] : []).url).searchParams.get('state');
    assert.equal((await oauth.completeCode(state, 'invented-code')).version, 1);
    assert.equal((await oauth.refresh('invented-refresh-operation')).version, 2);
    assert.equal(count, 2); assert.equal(h.root.clientReleaseCount, 2);
  }
});

test('lost provider response stays unknown through existing OAuth catch and recreation', async () => {
  const h = fixture(), seeded = h.seed();
  const oauth = createProviderOAuth({ provider: 'oura', clientId: 'invented-client', clientSecretRef: 'invented-client-ref',
    http: { async request() { throw Error('invented-network-loss'); } }, vault: seeded.service.vault, consumeCallback: seeded.service.consumeCallback,
    now: () => h.root.now, admission: { assertAllowed() {}, assertCurrent() {} } });
  await assert.rejects(oauth.refresh('lost-response'));
  assert.deepEqual(h.make().reconcile('lost-response'), { status: 'unknown' });
  assert.throws(() => h.make().vault.begin('refresh', 'retry'), failure);
});

test('lifecycle inventory/export emits counts and omissions only, with original-account guards', () => {
  const h = fixture(); h.seed(); const output = [];
  assert.equal(h.lifecycle.inventory(h.context).count, 1);
  assert.equal(h.lifecycle.export(h.context, { snapshotAtMs: h.root.now, append: (category, value) => output.push({ category, value }) }).status, 'complete');
  const text = JSON.stringify(output); assert.equal(text.includes('invented-access'), false); assert.equal(text.includes('authref:'), false);
  assert.deepEqual(Object.keys(output[0].value), ['recordCount', 'unresolvedOperationCount', 'omissions']);
  assert.throws(() => h.lifecycle.inventory({ ...h.context, accountId: 'other-account' }), failure);
  assert.throws(() => h.lifecycle.export(h.context, { snapshotAtMs: h.root.now, append() { h.root.enabled = false; } }), failure);
});

test('suppression requires root ledger and transaction, fences late commit and secret resolution', async () => {
  const h = fixture(), seeded = h.seed(), lease = seeded.service.vault.begin('refresh', 'inflight');
  assert.throws(() => h.lifecycle.suppress(scope.accountId, 2), failure);
  assert.throws(() => h.store.transaction(() => h.lifecycle.suppress(scope.accountId, 2)), failure);
  h.root.suppression = { accountId: scope.accountId, epoch: 2 };
  const result = h.store.transaction(() => h.lifecycle.suppress(scope.accountId, 2)); assert.equal(result.status, 'complete');
  assert.equal(h.record().operations.at(-1).phase, 'unknown'); assert.equal(h.record().flows[0].verifier, null);
  assert.throws(() => seeded.service.vault.commit(lease.id, tokens(2)), failure);
  await assert.rejects(seeded.service.secrets.acquire(scope, seeded.receipt.accessSecretRef, 'access_token', signal()), failure);
  assert.equal(h.store.transaction(() => h.lifecycle.verifySuppressed(scope.accountId, 2)).status, 'complete');
  assert.equal(h.lifecycle.verifySuppressed(scope.accountId, 2).status, 'unknown');
});

test('purge needs exact readiness, preserves other accounts, reads back and leaves root suppression intact', () => {
  const h = fixture(); h.seed();
  const otherScope = { ...scope, accountId: 'invented-other-account' }; h.root.currentScope = otherScope;
  h.make({ scope: otherScope }).beginAuthorization(redirect, ['daily']); h.root.currentScope = { ...scope };
  h.root.suppression = { accountId: scope.accountId, epoch: 2 };
  h.store.transaction(() => h.lifecycle.suppress(scope.accountId, 2));
  assert.equal(h.store.transaction(() => h.lifecycle.purge('invented-purge', scope.accountId)).status, 'unavailable');
  h.root.purgeReady = true;
  const purged = h.store.transaction(() => h.lifecycle.purge('invented-purge', scope.accountId));
  assert.equal(purged.status, 'complete'); assert.equal(purged.count, 1); assert.equal(h.root.records.size, 1);
  assert.equal(h.root.records.has(authStateKey(otherScope)), true); assert.ok(h.root.suppression);
  assert.throws(() => h.make().beginAuthorization(redirect, ['daily']), failure);
});

test('purge without local suppression stays pending and delete failure rolls back', () => {
  const h = fixture(); h.seed(); h.root.suppression = { accountId: scope.accountId, epoch: 2 }; h.root.purgeReady = true;
  assert.equal(h.store.transaction(() => h.lifecycle.purge('invented-purge', scope.accountId)).status, 'pending');
  h.store.transaction(() => h.lifecycle.suppress(scope.accountId, 2)); const before = h.record(); h.root.failDelete = true;
  assert.throws(() => h.store.transaction(() => h.lifecycle.purge('invented-purge', scope.accountId)), failure); assert.deepEqual(h.record(), before);
});

test('suppression savepoint rolls back partial writes even when root catches hook failure', () => {
  const h = fixture(); h.seed(); h.root.currentScope = { ...scope, connectionId: 'other-connection' };
  h.make({ scope: h.root.currentScope }).beginAuthorization(redirect, ['daily']); h.root.currentScope = { ...scope };
  const before = structuredClone(h.root.records); h.root.suppression = { accountId: scope.accountId, epoch: 2 };
  h.root.afterCas = () => { h.root.failCas = true; };
  h.store.transaction(() => { assert.throws(() => h.lifecycle.suppress(scope.accountId, 2), failure); });
  assert.deepEqual(h.root.records, before); assert.ok(h.root.suppression);
});
