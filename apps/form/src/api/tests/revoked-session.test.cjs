const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const loaded = { exports: {} };
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../transport.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('module', 'exports', compiled)(loaded, loaded.exports);
const { FormTransport } = loaded.exports;
const origin = 'https://form.example.invalid';
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture() {
  let clears = 0, token = 0;
  const storage = { value: null, async load() { return this.value; }, async save(value) { this.value = value; }, async clear() { clears++; this.value = null; } };
  const calls = [];
  const api = new FormTransport(origin, storage, async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/sign-in/email') ? json({}, { 'set-auth-token': `synthetic-${++token}` }) : json({ ok: true });
  });
  await api.signIn('a@example.invalid', 'synthetic-password');
  return { api, storage, calls, clears: () => clears };
}
test('captured revoked-session clear is local-only, memoized, and invalidates auth and bearer', async () => {
  const s = await fixture(), auth = s.api.captureAuthContext(), events = [];
  const subscription = s.api.subscribeAuthChanges(source => events.push(source));
  const clear = s.api.captureRevokedSessionClear(auth), before = s.calls.length;
  const one = clear(), two = clear();
  assert.equal(one, two); await one;
  assert.equal(s.calls.length, before); assert.equal(s.storage.value, null); assert.equal(s.clears(), 1);
  assert.equal(auth.isCurrent(), false); assert.deepEqual(events, [auth, auth]);
  await s.api.request('/probe');
  assert.equal(s.calls.at(-1).init.headers.Authorization, undefined);
  await s.api.signIn('b@example.invalid', 'synthetic-password');
  await clear();
  assert.equal(JSON.parse(s.storage.value).token, 'synthetic-2'); assert.equal(s.clears(), 1);
  subscription.remove();
});
test('stale capture rejects before storage, auth notification, or network effects', async () => {
  const s = await fixture(), clear = s.api.captureRevokedSessionClear();
  await s.api.signIn('b@example.invalid', 'synthetic-password');
  const before = s.calls.length; let changes = 0;
  const subscription = s.api.subscribeAuthChanges(() => changes++);
  await assert.rejects(clear(), { code: 'session_changed' });
  assert.equal(s.calls.length, before); assert.equal(s.clears(), 0); assert.equal(changes, 0);
  assert.equal(JSON.parse(s.storage.value).token, 'synthetic-2'); subscription.remove();
});
test('foreign auth during serialized removal repairs storage before adopting its new session', async () => {
  const s = await fixture(), entered = deferred(), release = deferred();
  s.storage.clear = async function () { entered.resolve(); await release.promise; this.value = null; };
  const clear = s.api.captureRevokedSessionClear();
  const removing = clear(); const rejected = assert.rejects(removing, { code: 'session_changed' });
  await entered.promise;
  const replacing = s.api.signIn('b@example.invalid', 'synthetic-password');
  release.resolve(); await Promise.all([rejected, replacing]);
  assert.equal(JSON.parse(s.storage.value).token, 'synthetic-2');
  await s.api.request('/probe'); assert.equal(s.calls.at(-1).init.headers.Authorization, 'Bearer synthetic-2');
  await assert.rejects(clear(), { code: 'session_changed' });
  assert.equal(JSON.parse(s.storage.value).token, 'synthetic-2');
});
test('storage failure is retained and never reported as successful local removal', async () => {
  const s = await fixture(); let clears = 0;
  s.storage.clear = async () => { clears++; throw new Error('synthetic locked store'); };
  const clear = s.api.captureRevokedSessionClear();
  const first = clear(); await assert.rejects(first, { code: 'secure_storage_failed' });
  assert.equal(clear(), first); await assert.rejects(clear(), { code: 'secure_storage_failed' });
  assert.equal(clears, 1); assert.equal(JSON.parse(s.storage.value).token, 'synthetic-1');
});
test('reentrant foreign auth observer cannot lend its generation to revoked-session cleanup', async () => {
  const s = await fixture(), auth = s.api.captureAuthContext();
  let replacing;
  const subscription = s.api.subscribeAuthChanges(source => {
    if (source === auth) replacing = s.api.signIn('b@example.invalid', 'synthetic-password');
  });
  await assert.rejects(s.api.captureRevokedSessionClear(auth)(), { code: 'session_changed' });
  await replacing; subscription.remove();
  assert.equal(s.clears(), 0); assert.equal(JSON.parse(s.storage.value).token, 'synthetic-2');
});
