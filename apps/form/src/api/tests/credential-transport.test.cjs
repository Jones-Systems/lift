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
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const store = () => ({ value: null, async load() { return this.value; }, async save(value) { this.value = value; }, async clear() { this.value = null; } });
const origin = 'https://form.example.invalid';
const guard = { isCurrent: () => true };

test('recovery sends no bearer and cannot adopt a returned session', async () => {
  const storage = store();
  const calls = [];
  const api = new FormTransport(origin, storage, async (url, init) => {
    calls.push(init);
    return url.endsWith('/sign-in/email') ? json({}, 200, { 'set-auth-token': 'original' })
      : json({ success: true }, 200, { 'set-auth-token': 'unexpected' });
  });
  await api.signIn('account@example.invalid', 'synthetic-password');
  const context = api.captureAuthContext();
  for (const route of ['request-password-reset', 'reset-password']) {
    assert.deepEqual(await api.anonymousAuthCommand(`/api/auth/email-otp/${route}`, {}), { success: true });
    assert.equal(calls.at(-1).headers.Authorization, undefined);
    assert.equal(JSON.parse(storage.value).token, 'original');
    assert.equal(context.isCurrent(), true);
  }
  await assert.rejects(api.anonymousAuthCommand('/api/auth/sign-in/email', {}), { code: 'invalid_auth_command' });
});

test('password change uses the old bearer then stores only the new signed header', async () => {
  const storage = store();
  const calls = [];
  const api = new FormTransport(origin, storage, async (url, init) => {
    calls.push(init);
    return url.endsWith('/sign-in/email') ? json({}, 200, { 'set-auth-token': 'original' })
      : json({ token: 'raw-body-token' }, 200, { 'set-auth-token': 'replacement' });
  });
  await api.signIn('account@example.invalid', 'synthetic-password');
  const context = api.captureAuthContext();
  await api.replaceSession('/api/auth/change-password', { currentPassword: 'old', newPassword: 'synthetic-new-password' }, guard);
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer original');
  assert.equal(JSON.parse(storage.value).token, 'replacement');
  assert.equal(context.isCurrent(), false);
});

test('uncertain password change retains the original token and does not retry', async () => {
  const storage = store();
  let changes = 0;
  const api = new FormTransport(origin, storage, async url => {
    if (url.endsWith('/sign-in/email')) return json({}, 200, { 'set-auth-token': 'original' });
    changes++;
    throw new Error('synthetic connection loss');
  });
  await api.signIn('account@example.invalid', 'synthetic-password');
  await assert.rejects(api.replaceSession('/api/auth/change-password', {}, guard), { code: 'network_unavailable', effectUnknown: true });
  assert.equal(changes, 1);
  assert.equal(JSON.parse(storage.value).token, 'original');
});

test('late replacement cannot overwrite another account and cleans up its own issued token', async () => {
  const storage = store();
  let release;
  let signIns = 0;
  const cleanups = [];
  const api = new FormTransport(origin, storage, async (url, init) => {
    if (url.endsWith('/sign-in/email')) return json({}, 200, { 'set-auth-token': `account-${++signIns}` });
    if (url.endsWith('/sign-out')) {
      if (init.credentials !== 'omit') return json({ code: 'MISSING_OR_NULL_ORIGIN' }, 403);
      cleanups.push(init.headers.Authorization); return json({ success: true });
    }
    return new Promise(resolve => { release = resolve; });
  });
  await api.signIn('first@example.invalid', 'synthetic-password');
  const pending = api.replaceSession('/api/auth/change-password', {}, guard);
  const rejected = assert.rejects(pending, { code: 'session_changed', originalEffectUnknown: true });
  await api.signIn('second@example.invalid', 'synthetic-password');
  release(json({}, 200, { 'set-auth-token': 'late-replacement' }));
  await rejected;
  assert.equal(JSON.parse(storage.value).token, 'account-2');
  assert.deepEqual(cleanups, ['Bearer late-replacement']);
});

test('late recovery result cannot enter a newly signed-in flow', async () => {
  const storage = store();
  let release;
  const api = new FormTransport(origin, storage, async url => url.endsWith('/sign-in/email')
    ? json({}, 200, { 'set-auth-token': 'new-account' }) : new Promise(resolve => { release = resolve; }));
  const pending = api.anonymousAuthCommand('/api/auth/email-otp/reset-password', {});
  const rejected = assert.rejects(pending, { code: 'session_changed', originalEffectUnknown: true });
  await api.signIn('next@example.invalid', 'synthetic-password');
  release(json({ success: true }));
  await rejected;
  assert.equal(JSON.parse(storage.value).token, 'new-account');
});

// Model an ambient native cookie jar: cookie-bearing auth is rejected without Origin.
test('bearer auth isolates ambient cookies and retains the session until sign-out succeeds', async () => {
  const storage = store(), revoked = [], calls = [];
  let rejectRevocation = true;
  const api = new FormTransport(origin, storage, async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization });
    if (init.credentials !== 'omit') return json({ code: 'MISSING_OR_NULL_ORIGIN' }, 403);
    if (url.endsWith('/sign-in/email')) return json({ token: 'body-is-not-authority' }, 200, { 'set-auth-token': 'original' });
    if (url.endsWith('/sign-out')) {
      if (rejectRevocation) return json({ code: 'synthetic_revocation_denied' }, 403);
      revoked.push(init.headers.Authorization); return json({ success: true });
    }
    return json({ authenticated: init.headers.Authorization === 'Bearer original' });
  });
  await api.signIn('synthetic@example.invalid', 'synthetic-password');
  assert.equal(calls[0].authorization, undefined);
  assert.equal(JSON.parse(storage.value).token, 'original');
  await assert.rejects(api.signOut(), { status: 403, code: 'synthetic_revocation_denied' });
  assert.equal(JSON.parse(storage.value).token, 'original');
  assert.deepEqual(await api.request('/v1/me'), { authenticated: true });
  assert.deepEqual(revoked, []);
  rejectRevocation = false;
  await api.signOut();
  assert.deepEqual(revoked, ['Bearer original']);
  assert.equal(storage.value, null);
  assert.deepEqual(await api.request('/v1/me'), { authenticated: false });
  assert.equal(calls.filter(call => call.url.endsWith('/sign-out')).length, 2);
});

test('late sign-in cleans only its issued bearer despite an ambient cookie session', async () => {
  const storage = store(), revoked = [];
  let release, signIns = 0;
  const api = new FormTransport(origin, storage, async (url, init) => {
    if (url.endsWith('/sign-in/email')) {
      if (++signIns === 1) return new Promise(resolve => { release = resolve; });
      return json({}, 200, { 'set-auth-token': 'current-account' });
    }
    if (init.credentials !== 'omit') return json({ code: 'MISSING_OR_NULL_ORIGIN' }, 403);
    revoked.push(init.headers.Authorization); return json({ success: true });
  });
  const pending = api.signIn('first@example.invalid', 'synthetic-password');
  const rejected = assert.rejects(pending, { code: 'session_changed', originalEffectUnknown: true });
  await api.signIn('second@example.invalid', 'synthetic-password');
  release(json({}, 200, { 'set-auth-token': 'late-account' }));
  await rejected;
  assert.deepEqual(revoked, ['Bearer late-account']);
  assert.equal(JSON.parse(storage.value).token, 'current-account');
});
