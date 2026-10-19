import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { createNodeAuthCipher } from '../../src/wearables/direct-provider-transport/node-auth-cipher.ts';
import { createSqliteAuthStateStore } from '../../src/wearables/direct-provider-transport/sqlite-auth-store.ts';
import { AuthStateFailure } from '../../src/wearables/direct-provider-transport/auth-state.ts';
import { fixture, scope, redirect, tokens, blank } from './concrete-auth-fixture.mjs';

const cipherFailure = error => error.message === 'provider_auth_cipher_invalid' && error.cause === undefined;
const storeFailure = error => error.message === 'provider_auth_store_unavailable' && error.cause === undefined;
const authFailure = error => error instanceof AuthStateFailure;
const signal = () => new AbortController().signal;

test('AES-GCM round trips UTF-8 with fresh nonces and a detached supplied key', () => {
  const key = new Uint8Array(32).fill(7), cipher = createNodeAuthCipher({ key });
  assert.deepEqual(key, new Uint8Array(32).fill(7)); key.fill(9);
  const first = cipher.seal('invented-credential-\u2603', 'invented-aad');
  const second = cipher.seal('invented-credential-\u2603', 'invented-aad');
  assert.notEqual(first.split('.')[1], second.split('.')[1]);
  assert.equal(createNodeAuthCipher({ key: new Uint8Array(32).fill(7) }).open(first, 'invented-aad'), 'invented-credential-\u2603');
  assert.equal(cipher.open(second, 'invented-aad'), 'invented-credential-\u2603');
  assert.equal(cipher.open(cipher.seal('\ufeffinvented', 'invented-aad'), 'invented-aad'), '\ufeffinvented');
  assert.equal(first.includes('invented-credential'), false);
});

test('AES-GCM authenticates nonce, tag, ciphertext, key and every AAD byte', () => {
  const cipher = createNodeAuthCipher({ key: new Uint8Array(32).fill(7) });
  const sealed = cipher.seal('invented-credential', 'invented-aad');
  for (const index of [1, 2, 3]) {
    const fields = sealed.split('.'), bytes = Buffer.from(fields[index], 'base64url'); bytes[0] ^= 1;
    fields[index] = bytes.toString('base64url'); assert.throws(() => cipher.open(fields.join('.'), 'invented-aad'), cipherFailure);
  }
  assert.throws(() => cipher.open(sealed, 'invented-aaD'), cipherFailure);
  assert.throws(() => createNodeAuthCipher({ key: new Uint8Array(32).fill(8) }).open(sealed, 'invented-aad'), cipherFailure);
});

test('cipher rejects noncanonical envelopes, invalid key sizes and bounded text violations', () => {
  for (const key of [undefined, [], new Uint8Array(31), new Uint8Array(33)]) assert.throws(() => createNodeAuthCipher({ key }), cipherFailure);
  const cipher = createNodeAuthCipher({ key: new Uint8Array(32) }), valid = cipher.seal('invented', 'aad');
  for (const envelope of ['', valid.replace('v1.', 'v2.'), valid + '.', valid + '=', valid.replace(/\.[^.]+$/, '.!'), 'x'.repeat(22001)]) {
    assert.throws(() => cipher.open(envelope, 'aad'), cipherFailure);
  }
  for (const plaintext of ['', '\ud800', 'x'.repeat(16385), '\u2603'.repeat(5462)]) assert.throws(() => cipher.seal(plaintext, 'aad'), cipherFailure);
  for (const aad of ['', '\ud800', 'x'.repeat(65537)]) assert.throws(() => cipher.seal('invented', aad), cipherFailure);
  const maximum = 'x'.repeat(16384); assert.equal(cipher.open(cipher.seal(maximum, 'a'.repeat(65536)), 'a'.repeat(65536)), maximum);
});

test('authenticated but invalid UTF-8 plaintext is never returned', () => {
  const key = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 1), writer = createCipheriv('aes-256-gcm', key, nonce);
  writer.setAAD(Buffer.from('aad')); const encrypted = Buffer.concat([writer.update(Buffer.from([0xff])), writer.final()]);
  const envelope = ['v1', nonce.toString('base64url'), writer.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  assert.throws(() => createNodeAuthCipher({ key }).open(envelope, 'aad'), cipherFailure);
});

test('store factory requires preinstalled exact schema and never installs it', t => {
  const h = fixture(t, { installSchema: false }); assert.throws(() => h.makeStore(), storeFailure);
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='wearable_provider_auth_state'").get().n, 0);
  h.db.exec('CREATE TABLE wearable_provider_auth_state(record_key TEXT PRIMARY KEY,account_id TEXT,revision INTEGER,data TEXT)');
  assert.throws(() => h.makeStore(), storeFailure);
});

test('schema drift and disabled foreign keys fail closed even after successful factory qualification', t => {
  const h = fixture(t), store = h.makeStore(); h.db.pragma('foreign_keys = OFF');
  assert.throws(() => store.transaction(tx => tx.get(blank().key)), storeFailure);
  h.db.pragma('foreign_keys = ON'); h.db.exec('CREATE INDEX unexpected_auth_index ON wearable_provider_auth_state(revision)');
  assert.throws(() => store.transaction(tx => tx.get(blank().key)), storeFailure);
});

test('root writer custody is required beyond merely having a SQL transaction', t => {
  const h = fixture(t), store = h.makeStore(); assert.throws(() => store.currentTransaction(), storeFailure);
  h.db.transaction(() => {
    assert.throws(() => store.currentTransaction(), storeFailure);
    assert.throws(() => store.transaction(tx => tx.compareAndSwap(blank().key, null, blank())), storeFailure);
  }).immediate();
  assert.equal(h.record(), null);
  h.runRootWrite(() => assert.equal(store.currentTransaction().get(blank().key), null));
  const denied = createSqliteAuthStateStore({ ...h.storeOptions, assertRootWriter() { throw Error('invented-private-writer-detail'); } });
  assert.throws(() => denied.transaction(tx => tx.get(blank().key)), storeFailure);
});

test('independent adapter instances share atomic revisions and return detached records', t => {
  const h = fixture(t), first = h.makeStore(), second = h.makeStore(), initial = blank();
  assert.equal(first.transaction(tx => tx.compareAndSwap(initial.key, null, initial)), true);
  assert.equal(second.transaction(tx => tx.compareAndSwap(initial.key, null, initial)), false);
  const read = first.transaction(tx => tx.get(initial.key)); read.scope.sessionId = 'changed-outside-transaction';
  assert.equal(second.transaction(tx => tx.get(initial.key)).scope.sessionId, scope.sessionId);
  const next = { ...initial, revision: 1 };
  assert.equal(second.transaction(tx => tx.compareAndSwap(initial.key, 0, next)), true);
  assert.equal(first.transaction(tx => tx.compareAndSwap(initial.key, 0, next)), false);
  assert.equal(first.transaction(tx => tx.delete(initial.key, 0)), false);
  assert.equal(second.transaction(tx => tx.delete(initial.key, 1)), true);
});

test('caught inner failures roll back savepoint writes while root retains its own work', t => {
  const h = fixture(t), store = h.makeStore();
  h.runRootWrite(() => {
    h.db.prepare('INSERT INTO fixture_markers VALUES(?)').run('root-before');
    assert.throws(() => store.transaction(tx => { tx.compareAndSwap(blank().key, null, blank()); throw Error('invented-private-detail'); }), storeFailure);
    assert.equal(store.currentTransaction().get(blank().key), null);
  });
  assert.deepEqual(h.db.prepare('SELECT value FROM fixture_markers').all(), [{ value: 'root-before' }]);
});

test('outer rollback removes successful nested writes and async callbacks cannot commit', t => {
  const h = fixture(t), store = h.makeStore();
  assert.throws(() => h.runRootWrite(() => { store.transaction(tx => tx.compareAndSwap(blank().key, null, blank())); throw Error('outer failure'); }));
  assert.equal(h.record(), null);
  assert.throws(() => store.transaction(tx => { tx.compareAndSwap(blank().key, null, blank()); return Promise.resolve('forbidden'); }), storeFailure);
  assert.equal(h.record(), null);
});

test('escaped transaction handles cannot read or write outside witnessed root custody', t => {
  const h = fixture(t), tx = h.makeStore().transaction(value => value);
  assert.throws(() => tx.get(blank().key), storeFailure);
  assert.throws(() => tx.compareAndSwap(blank().key, null, blank()), storeFailure);
  assert.throws(() => tx.listAccount(scope.accountId, 1), storeFailure);
  assert.throws(() => tx.delete(blank().key, 0), storeFailure);
});

test('strict serialized records reject unknown fields, revision jumps and custom serializers', t => {
  const h = fixture(t), store = h.makeStore();
  for (const value of [{ ...blank(), credential: 'invented-plaintext' }, { ...blank(), revision: 1 }, { ...blank(), scope: { ...scope, extra: true } }]) {
    assert.throws(() => store.transaction(tx => tx.compareAndSwap(blank().key, null, value)), storeFailure);
  }
  const crafted = blank(); Object.defineProperty(crafted, 'toJSON', { value: () => ({ ...blank(), credential: 'invented-plaintext' }) });
  assert.throws(() => store.transaction(tx => tx.compareAndSwap(blank().key, null, crafted)), storeFailure);
  assert.equal(h.record(), null);
});

test('SQL constraints and read validation reject corrupt metadata and extra payload fields', t => {
  const h = fixture(t), value = blank(), store = h.makeStore();
  store.transaction(tx => tx.compareAndSwap(value.key, null, value));
  assert.throws(() => h.db.prepare('UPDATE wearable_provider_auth_state SET revision=99').run());
  assert.throws(() => h.db.prepare('UPDATE wearable_provider_auth_state SET data=?').run('{invalid'));
  h.db.prepare('UPDATE wearable_provider_auth_state SET data=?').run(JSON.stringify({ ...value, credential: 'invented' }));
  assert.throws(() => store.transaction(tx => tx.get(value.key)), storeFailure);
});

test('account listing is scoped and bounded; oversized records fail before persistence', t => {
  const h = fixture(t), store = h.makeStore(), other = blank({ ...scope, accountId: 'invented-other-account' });
  h.db.prepare('INSERT INTO form_accounts VALUES(?,?)').run(other.scope.accountId, 'invented-other-user');
  store.transaction(tx => { tx.compareAndSwap(blank().key, null, blank()); tx.compareAndSwap(other.key, null, other); });
  assert.deepEqual(store.transaction(tx => tx.listAccount(scope.accountId, 1)).map(record => record.key), [blank().key]);
  for (const limit of [0, 258, 1.5]) assert.throws(() => store.transaction(tx => tx.listAccount(scope.accountId, limit)), storeFailure);
  const huge = { ...blank({ ...scope, generation: 2 }), flows: Array.from({ length: 16 }, (_, index) => ({
    stateDigest: index.toString(16).padStart(64, '0'), operationId: 'operation-' + index, redirectUri: redirect,
    expiresAtMs: 61000, expectedVersion: 0, status: 'pending',
    verifier: { reference: 'verifier-' + index, purpose: 'code_verifier', ciphertext: 'x'.repeat(65536), expiresAtMs: 61000, version: 0 },
  })) };
  assert.throws(() => store.transaction(tx => tx.compareAndSwap(huge.key, null, huge)), storeFailure);
  assert.equal(h.record(huge.key), null);
});

test('real cipher and SQLite preserve one-use callback and token rotation across instance recreation', async t => {
  const h = fixture(t), original = h.make(), state = new URL(original.beginAuthorization(redirect, ['daily']).url).searchParams.get('state');
  assert.equal(JSON.stringify(h.record()).includes(state), false);
  const recreated = h.make(), callback = recreated.consumeCallback(state, 'invented-code');
  assert.throws(() => original.consumeCallback(state, 'invented-code'), authFailure);
  const codeLease = recreated.vault.begin('code', callback.operationId);
  const verifier = await recreated.secrets.acquire(scope, callback.verifierRef, 'code_verifier', signal());
  assert.equal(verifier.value.length, 43); verifier.release();
  const first = recreated.vault.commit(codeLease.id, tokens());
  const acquired = await h.make().secrets.acquire(scope, first.accessSecretRef, 'access_token', signal());
  assert.equal(acquired.value, tokens().access_token); acquired.release();
  const rotation = h.make().vault.begin('refresh', 'invented-rotation'), second = h.make().vault.commit(rotation.id, tokens(2));
  assert.equal(second.version, 2); assert.deepEqual(original.vault.commit(rotation.id, tokens(2)), second);
  await assert.rejects(original.secrets.acquire(scope, first.accessSecretRef, 'access_token', signal()), authFailure);
  const stored = h.db.prepare('SELECT data FROM wearable_provider_auth_state').get().data;
  for (const plaintext of [state, 'invented-code', tokens().access_token, tokens().refresh_token, tokens(2).access_token]) assert.equal(stored.includes(plaintext), false);
});

test('crashed or explicitly unknown leases stay exclusive across store and service recreation', t => {
  const h = fixture(t), seeded = h.seed(), lease = seeded.service.vault.begin('refresh', 'invented-uncertain');
  assert.deepEqual(h.make().reconcile('invented-uncertain'), { status: 'unknown' });
  assert.throws(() => h.make().vault.begin('refresh', 'invented-second'), authFailure);
  h.make().vault.unknown(lease.id); h.root.now += 900000;
  assert.throws(() => h.make().vault.begin('refresh', 'invented-third'), authFailure);
  assert.equal(h.record().operations.at(-1).phase, 'unknown');
});

test('original session, epoch and generation loss deny late token commits', t => {
  for (const loss of ['session', 'epoch', 'generation']) {
    const h = fixture(t), seeded = h.seed(), lease = seeded.service.vault.begin('refresh', 'invented-late'), before = h.record();
    if (loss === 'session') h.db.prepare('DELETE FROM session WHERE id=?').run(scope.sessionId);
    if (loss === 'epoch') h.db.prepare('UPDATE account_lifecycle SET epoch=2 WHERE account_id=?').run(scope.accountId);
    if (loss === 'generation') h.root.generation = 2;
    assert.throws(() => seeded.service.vault.commit(lease.id, tokens(2)), authFailure); assert.deepEqual(h.record(), before);
  }
});

test('currentness loss during cipher work rolls back rotation in the real SQLite transaction', t => {
  const h = fixture(t), seeded = h.seed(), lease = seeded.service.vault.begin('refresh', 'invented-midflight'), before = h.record();
  const service = h.make({ cipher: { ...h.cipher, seal(value, aad) { const result = h.cipher.seal(value, aad); h.root.generation = 2; return result; } } });
  assert.throws(() => service.vault.commit(lease.id, tokens(2)), authFailure); assert.deepEqual(h.record(), before);
});

test('ciphertext swapping across token purposes cannot bypass authenticated scope binding', async t => {
  const h = fixture(t), seeded = h.seed(), store = h.makeStore();
  store.transaction(tx => { const record = tx.get(blank().key), revision = record.revision; record.tokens.access.ciphertext = record.tokens.refresh.ciphertext;
    record.revision++; assert.equal(tx.compareAndSwap(record.key, revision, record), true); });
  await assert.rejects(h.make().secrets.acquire(scope, seeded.receipt.accessSecretRef, 'access_token', signal()), authFailure);
});

test('lifecycle exports metadata only and requires ledger proof plus exact purge readiness', t => {
  const h = fixture(t), auth = h.authorize(), lifecycle = h.lifecycle(), sections = [];
  assert.equal(lifecycle.inventory(h.context).count, 1);
  lifecycle.export(h.context, { snapshotAtMs: h.root.now, append(category, value) { sections.push({ category, value }); } });
  const exported = JSON.stringify(sections); assert.equal(exported.includes(auth.callback.verifierRef), false); assert.equal(exported.includes('v1.'), false);
  assert.throws(() => h.lifecycleWrite(() => lifecycle.suppress(scope.accountId, 2)), authFailure);
  h.suppressLedger();
  h.lifecycleWrite(() => { assert.equal(lifecycle.suppress(scope.accountId, 2).status, 'complete'); assert.equal(lifecycle.verifySuppressed(scope.accountId, 2).status, 'complete'); });
  assert.equal(h.record().operations[0].phase, 'unknown'); assert.equal(h.record().flows[0].verifier, null);
  assert.throws(() => auth.service.vault.commit(auth.lease.id, tokens()), authFailure);
  assert.equal(h.lifecycleWrite(() => lifecycle.purge('invented-purge', scope.accountId)).status, 'unavailable');
  h.root.purgeReady = true;
  assert.equal(h.lifecycleWrite(() => lifecycle.purge('wrong-request', scope.accountId)).status, 'unavailable');
  assert.equal(h.lifecycleWrite(() => lifecycle.purge('invented-purge', scope.accountId)).count, 1); assert.equal(h.record(), null);
});

test('lifecycle savepoint rolls back partial suppression when root catches a late proof failure', t => {
  const h = fixture(t); h.authorize(); const before = h.record(), lifecycle = h.lifecycle(); h.suppressLedger(); h.root.failProofAt = 2;
  h.lifecycleWrite(() => {
    h.db.prepare('INSERT INTO fixture_markers VALUES(?)').run('root-kept');
    assert.throws(() => lifecycle.suppress(scope.accountId, 2), authFailure);
  });
  assert.deepEqual(h.record(), before); assert.equal(h.root.suppression.has(scope.accountId), true);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM fixture_markers').get().n, 1);
  assert.throws(() => h.make().beginAuthorization(redirect, ['daily']), authFailure);
});
