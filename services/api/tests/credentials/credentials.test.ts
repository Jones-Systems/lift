import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { serve } from '@hono/node-server';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { getMigrations } from 'better-auth/db/migration';
import { createServer } from '../../src/server.js';
import { createAuth } from '../../src/auth.js';
import { credentialAuthProxy, supportedAuthRoute } from '../../src/credentials/proxy.js';
import { bindCredentialMail, type CredentialMailInput } from '../../src/credentials/mail.js';
import { phoneEmail } from '../../src/phone/challenges.js';
import { withActiveWrite } from '../../src/lifecycle/guards.js';

const password = 'Synthetic-password-only-1234', nextPassword = 'Another-synthetic-password-1234';
const emails = ['first@synthetic.invalid', 'second@synthetic.invalid'];
async function fixture(t: TestContext, configured = true) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(join(parent, 'credentials-'));
  let backend: Awaited<ReturnType<typeof createServer>> | undefined;
  let auth: ReturnType<typeof createAuth>;
  const registration = { mode: 'allowlist' as const, emails };
  const listener = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    if (new URL(request.url).pathname.startsWith('/api/auth/')) {
      try { const headers = new Headers(request.headers); headers.set('x-form-peer-ip', '127.0.0.1'); request = new Request(request, { headers }); return await credentialAuthProxy(request, { db: backend!.db, auth, registration, providers: [] }); }
      catch (error) { const e = error as { status?: number; code?: string }; return Response.json({ error: { code: e.code ?? 'internal_error' } }, { status: e.status ?? 500 }); }
    }
    return backend!.handleRequest(request, '127.0.0.1');
  } });
  const dispose = () => { if ('closeAllConnections' in listener) listener.closeAllConnections(); listener.close(); if (backend?.db.open) backend.close(); rmSync(root, { recursive: true, force: true }); };
  const cancel = () => { dispose(); process.exit(130); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  t.after(() => { dispose(); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); });
  await new Promise<void>(done => listener.listening ? done() : listener.once('listening', done));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const config = { dbPath: join(root, 'synthetic.sqlite'), baseURL: base, secret: 'synthetic-only-credential-test-secret-123456', registration };
  backend = await createServer(config);
  const sent: CredentialMailInput[] = [];
  auth = createAuth(backend.db, { ...config, trustedOrigins: [base], ...(configured ? { credentialMail: { status: () => 'verified' as const, dispatch: (input: CredentialMailInput) => { sent.push(input); } } } : {}) });
  const request = async (path: string, input?: unknown, token?: string) => {
    const response = await fetch(base + path, { method: input === undefined ? 'GET' : 'POST', headers: { origin: base, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const text = await response.text(); return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  };
  const signup = async (email = emails[0]!) => { const result = await request('/api/auth/sign-up/email', { email, password, name: 'Synthetic member' }); assert.equal(result.status, 200, result.text); const token = result.headers.get('set-auth-token')!; assert.ok(token); await request('/v1/me', undefined, token); return { ...result, token }; };
  const signin = async (email = emails[0]!, secret = password) => { const result = await request('/api/auth/sign-in/email', { email, password: secret }); assert.equal(result.status, 200, result.text); return result.headers.get('set-auth-token')!; };
  const clearRate = () => backend!.db.prepare('DELETE FROM rateLimit').run();
  return { backend, auth, sent, request, signup, signin, clearRate, base };
}

test('auth allowlist and unchanged auth schema, unconfigured recovery is independent of account', async t => {
  const f = await fixture(t, false); await f.signup();
  for (const path of ['/sign-in/email-otp', '/email-otp/send-verification-otp', '/email-otp/verify-email', '/email-otp/check-verification-otp', '/forget-password/email-otp', '/request-password-reset', '/reset-password', '/reset-password/token', '/change-email', '/update-user', '/delete-user', '/delete-user/token', '/list-sessions', '/link-social', '/unlink-account', '/set-password', '/verify-password', '/phone-number/send-otp', '/phone-number/request-password-reset'])
    assert.equal((await f.request('/api/auth' + path, {})).status, 404, path);
  const a = await f.request('/api/auth/email-otp/request-password-reset', { email: emails[0] });
  const b = await f.request('/api/auth/email-otp/request-password-reset', { email: 'unknown@synthetic.invalid' });
  assert.equal(a.status, 501); assert.equal(a.text, b.text); assert.equal(f.sent.length, 0);
  const schema = await getMigrations(f.auth.options); for (const key of ['toBeCreated', 'toBeAdded', 'unsafeChanges', 'schemaProblems'] as const) assert.equal(schema[key].length, 0);
});

test('reset is uniform for unknown, provider-only and phone principals; eligibility prevents credential creation', async t => {
  const f = await fixture(t); await f.signup(); const second = await f.signup(emails[1]);
  f.backend.db.prepare("UPDATE account SET providerId='google',password=NULL WHERE userId=?").run(second.body.user.id);
  const phoneUser = randomUUID();
  f.backend.db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt,phoneNumber,phoneNumberVerified) VALUES(?,?,?,0,?,?,?,1)').run(phoneUser, 'Synthetic phone member', phoneEmail('+12025550123'), Date.now(), Date.now(), '+12025550123');
  for (const email of [emails[0], 'unknown@synthetic.invalid', emails[1], phoneEmail('+12025550123')]) {
    f.clearRate(); const started = performance.now(); const result = await f.request('/api/auth/email-otp/request-password-reset', { email });
    assert.equal(result.status, 200); assert.equal(result.text, '{"success":true}'); assert.ok(performance.now() - started >= 700);
  }
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.email, emails[0]);
  const invalid = await f.request('/api/auth/email-otp/reset-password', { email: emails[1], otp: '12345678', password: nextPassword });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.code, 'INVALID_OTP');
  assert.equal((f.backend.db.prepare("SELECT count(*) n FROM account WHERE userId=? AND providerId='credential'").get(second.body.user.id) as { n: number }).n, 0);
});

test('reset is single use, revokes all sessions and rejects an admitted late write', async t => {
  const f = await fixture(t), first = await f.signup(), second = await f.signin();
  const me = await f.request('/v1/me', undefined, first.token);
  const session = await f.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${first.token}` }) }); assert.ok(session);
  const mapping = f.backend.db.prepare('SELECT id FROM form_accounts WHERE auth_user_id=?').get(session.user.id) as { id: string };
  const actor = { accountId: mapping.id, authUserId: session.user.id, sessionId: session.session.id, epoch: 0 };
  assert.equal(withActiveWrite(f.backend.db, actor, () => 'committed-before'), 'committed-before');
  await f.request('/api/auth/email-otp/request-password-reset', { email: emails[0] });
  const input = { email: emails[0], otp: f.sent[0]!.otp, password: nextPassword };
  assert.equal((await f.request('/api/auth/email-otp/reset-password', input)).status, 200);
  assert.equal((await f.request('/v1/me', undefined, first.token)).status, 401); assert.equal((await f.request('/v1/me', undefined, second)).status, 401);
  let wrote = false; assert.throws(() => withActiveWrite(f.backend.db, actor, () => { wrote = true; }), { code: 'account_session_invalid' }); assert.equal(wrote, false);
  assert.equal((await f.request('/api/auth/email-otp/reset-password', input)).body.code, 'INVALID_OTP');
  const replacement = await f.signin(emails[0], nextPassword); assert.equal((await f.request('/v1/me', undefined, replacement)).body.accountId, me.body.accountId);
});

test('three incorrect codes lock out a correct fourth code, then consume; expiry uses injected clock', async t => {
  const f = await fixture(t); await f.signup(); await f.request('/api/auth/email-otp/request-password-reset', { email: emails[0] });
  const code = f.sent[0]!.otp, wrong = code === '00000000' ? '11111111' : '00000000';
  for (let i = 0; i < 3; i++) { const result = await f.request('/api/auth/email-otp/reset-password', { email: emails[0], otp: wrong, password: nextPassword }); assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_OTP'); }
  const row = f.backend.db.prepare("SELECT value FROM verification WHERE identifier LIKE '%forget-password%'").get() as { value: string }; assert.ok(row.value.endsWith(':3')); assert.ok(!row.value.includes(code));
  const fourth = await f.request('/api/auth/email-otp/reset-password', { email: emails[0], otp: code, password: nextPassword }); assert.equal(fourth.status, 403); assert.equal(fourth.body.code, 'TOO_MANY_ATTEMPTS');
  assert.equal(f.backend.db.prepare("SELECT 1 FROM verification WHERE identifier LIKE '%forget-password%'").get(), undefined);
  f.clearRate(); await f.request('/api/auth/email-otp/request-password-reset', { email: emails[0] });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 601000 });
  const expired = await f.request('/api/auth/email-otp/reset-password', { email: emails[0], otp: f.sent.at(-1)!.otp, password: nextPassword });
  assert.equal(expired.body.code, 'OTP_EXPIRED'); t.mock.timers.reset();
});

test('password change forces session replacement even when opt-out is submitted', async t => {
  const f = await fixture(t), first = await f.signup(), other = await f.signin();
  assert.equal((await f.request('/api/auth/change-password', { currentPassword: 'wrong-password', newPassword: nextPassword }, first.token)).status, 400);
  const changed = await f.request('/api/auth/change-password', { currentPassword: password, newPassword: nextPassword, revokeOtherSessions: false }, first.token);
  assert.equal(changed.status, 200, changed.text); const replacement = changed.headers.get('set-auth-token'); assert.ok(replacement);
  assert.equal((await f.request('/v1/me', undefined, first.token)).status, 401); assert.equal((await f.request('/v1/me', undefined, other)).status, 401);
  assert.equal((await f.request('/v1/me', undefined, replacement)).status, 200);
});

test('email change reauthenticates, hides occupied targets, preserves account and settings', async t => {
  const f = await fixture(t), first = await f.signup(); await f.signup(emails[1]);
  const before = await f.request('/v1/me/settings', undefined, first.token);
  assert.equal((await f.request('/api/auth/email-otp/request-email-change', { newEmail: 'new@synthetic.invalid', currentPassword: 'wrong-password' }, first.token)).body.code, 'INVALID_PASSWORD');
  assert.equal((await f.request('/api/auth/email-otp/request-email-change', { newEmail: phoneEmail('+12025550123'), currentPassword: password }, first.token)).status, 422);
  const occupied = await f.request('/api/auth/email-otp/request-email-change', { newEmail: emails[1], currentPassword: password }, first.token);
  assert.equal(occupied.status, 200); assert.equal(f.sent.length, 0);
  const issued = await f.request('/api/auth/email-otp/request-email-change', { newEmail: 'new@synthetic.invalid', currentPassword: password }, first.token);
  assert.equal(issued.status, 200, issued.text); assert.equal(issued.text, occupied.text);
  const changed = await f.request('/api/auth/email-otp/change-email', { newEmail: 'new@synthetic.invalid', otp: f.sent[0]!.otp }, first.token);
  assert.equal(changed.status, 200, changed.text);
  const after = await f.request('/v1/me/settings', undefined, first.token);
  assert.equal(after.body.accountId, before.body.accountId); assert.equal(after.body.identity.email, 'new@synthetic.invalid'); assert.equal(after.body.identity.displayName, before.body.identity.displayName);
});

test('mail dispatch is bounded, synchronous failures are silent, and reauthentication has its own rate budget', async t => {
  const f = await fixture(t), first = await f.signup();
  for (let i = 0; i < 4; i++) { f.clearRate(); assert.equal((await f.request('/api/auth/email-otp/request-password-reset', { email: emails[0] })).status, 200); }
  assert.equal(f.sent.length, 3);
  const throwingMail = bindCredentialMail(f.backend.db, { status: () => 'verified', dispatch: () => { throw new Error('synthetic delivery failure'); } });
  assert.doesNotThrow(() => throwingMail.dispatch({ email: emails[0]!, otp: '12345678', type: 'forget-password' }));
  f.clearRate(); const failed = await f.request('/api/auth/email-otp/request-password-reset', { email: emails[0] }); assert.equal(failed.text, '{"success":true}');
  f.clearRate();
  for (let i = 0; i < 3; i++) assert.equal((await f.request('/api/auth/email-otp/request-email-change', { newEmail: 'new@synthetic.invalid', currentPassword: 'wrong-password' }, first.token)).status, 400);
  assert.equal((await f.request('/api/auth/email-otp/request-email-change', { newEmail: 'new@synthetic.invalid', currentPassword: password }, first.token)).status, 429);
});


test('auth route allowlist rejects inherited object names and unsupported methods', () => {
  for (const path of ['/toString', '/constructor', '/__proto__', '/hasOwnProperty', '/unknown']) {
    assert.equal(supportedAuthRoute('POST', path, []), false, path);
    assert.equal(supportedAuthRoute('GET', path, []), false, path);
  }
  for (const path of ['/phone-number/challenge', '/phone-number/resend', '/phone-number/verify'])
    assert.equal(supportedAuthRoute('POST', path, []), true, path);
  assert.equal(supportedAuthRoute('GET', '/get-session', []), true);
  assert.equal(supportedAuthRoute('GET', '/sign-in/email', []), false);
  assert.equal(supportedAuthRoute('POST', '/sign-in/social', []), false);
  assert.equal(supportedAuthRoute('POST', '/sign-in/social', ['apple']), true);
  assert.equal(supportedAuthRoute('GET', '/callback/apple', ['apple']), true);
  assert.equal(supportedAuthRoute('POST', '/callback/apple', ['apple']), true);
  assert.equal(supportedAuthRoute('GET', '/callback/google', ['apple']), false);
});

test('settings distinguish mail configuration from credential-account support', async t => {
  const f = await fixture(t, false), first = await f.signup();
  let settings = (await f.request('/v1/me/settings', undefined, first.token)).body;
  assert.deepEqual(settings.capabilities.changePassword, { supported: true, status: 'available' });
  assert.deepEqual(settings.capabilities.passwordRecovery, { supported: false, status: 'unconfigured' });
  assert.deepEqual(settings.capabilities.changeEmail, { supported: false, status: 'unconfigured' });
  for (const status of ['configured_unverified', 'verified'] as const) {
    bindCredentialMail(f.backend.db, { status: () => status, dispatch: () => {} });
    settings = (await f.request('/v1/me/settings', undefined, first.token)).body;
    assert.deepEqual(settings.capabilities.passwordRecovery, { supported: true, status });
    assert.deepEqual(settings.capabilities.changeEmail, { supported: true, status });
  }
  f.backend.db.prepare("UPDATE account SET providerId='google',password=NULL WHERE userId=?").run(first.body.user.id);
  settings = (await f.request('/v1/me/settings', undefined, first.token)).body;
  assert.deepEqual(settings.capabilities.changePassword, { supported: false, status: 'unavailable' });
  assert.deepEqual(settings.capabilities.changeEmail, { supported: false, status: 'verified' });
  assert.deepEqual(settings.capabilities.passwordRecovery, { supported: false, status: 'verified' });
});

test('credential mutation schemas reject extra fields and email change requires the current session', async t => {
  const f = await fixture(t), first = await f.signup();
  const request = { newEmail: 'new@synthetic.invalid', currentPassword: password };
  assert.equal((await f.request('/api/auth/email-otp/request-email-change', request)).status, 401);
  assert.equal((await f.request('/api/auth/email-otp/request-email-change', { ...request, accountId: first.body.user.id }, first.token)).status, 422);
  assert.equal((await f.request('/api/auth/email-otp/change-email', { newEmail: request.newEmail, otp: '12345678', currentPassword: password }, first.token)).status, 422);
  assert.equal((await f.request('/api/auth/change-password', { currentPassword: password, newPassword: nextPassword, userId: first.body.user.id }, first.token)).status, 422);
  assert.equal((await f.request('/api/auth/email-otp/reset-password', { email: emails[0], otp: '1234', password: nextPassword })).status, 422);
  assert.equal(f.sent.length, 0);
});
