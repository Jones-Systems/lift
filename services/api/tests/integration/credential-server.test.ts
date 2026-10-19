import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer, type FormServer, type ServerConfig } from '../../src/server.js';
import type { SocialProviders } from '../../src/auth.js';
import type { CredentialMailInput, CredentialMailStatus } from '../../src/credentials/mail.js';

const baseURL = 'http://127.0.0.1:47832';
const email = 'member@synthetic.invalid';
const password = 'Synthetic-credential-server-password-1234';
const nextPassword = 'Replacement-credential-server-password-5678';
const peerAddress = '192.0.2.10';
type Fixture = Awaited<ReturnType<typeof client>>;
function client(backend: FormServer) {
  const request = async (path: string, input?: unknown, token?: string, extra: Record<string, string> = {}) => {
    const headers = { origin: baseURL, 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
    const response = await backend.handleRequest(new Request(baseURL + path, {
      method: input === undefined ? 'GET' : 'POST', headers,
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }), peerAddress);
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  };
  const signup = async () => {
    const response = await request('/api/auth/sign-up/email', { name: 'Synthetic member', email, password }, undefined,
      { 'x-form-peer-ip': '198.51.100.20', 'x-forwarded-for': '198.51.100.21', 'x-real-ip': '198.51.100.22' });
    assert.equal(response.status, 200, response.text);
    const token = response.headers.get('set-auth-token'); assert.ok(token);
    return { ...response, token };
  };
  return { backend, request, signup };
}
async function fixture(run: (f: Fixture) => Promise<void>, config: Partial<ServerConfig> = {}) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'credential-server-'));
  let backend: FormServer | undefined;
  const cleanup = () => { try { if (backend?.db.open) backend.close(); } finally { rmSync(root, { recursive: true, force: true }); } };
  const interrupted = () => { cleanup(); process.exit(130); };
  const terminated = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', terminated);
  try {
    backend = await createServer({ dbPath: join(root, 'synthetic.sqlite'), baseURL,
      secret: 'synthetic-credential-server-secret-over-32-characters',
      registration: { mode: 'allowlist', emails: [email] }, ...config });
    await run(client(backend));
  } finally {
    process.off('SIGINT', interrupted); process.off('SIGTERM', terminated); cleanup();
  }
}

test('server denies unregistered auth routes and undefined social providers', () => fixture(async f => {
  const first = await f.signup();
  for (const path of ['/update-user', '/delete-user', '/list-sessions', '/email-otp/send-verification-otp', '/phone-number/send-otp']) {
    const response = await f.request('/api/auth' + path, { name: 'Unregistered update' }, first.token);
    assert.equal(response.status, 404, path); assert.equal(response.body.error.code, 'not_found');
  }
  for (const path of ['/callback/apple', '/callback/google'])
    assert.equal((await f.request('/api/auth' + path)).status, 404, path);
  assert.equal((await f.request('/api/auth/sign-in/social', { provider: 'apple' })).status, 404);
  const user = f.backend.db.prepare('SELECT name FROM "user" WHERE email=?').get(email) as { name: string };
  assert.equal(user.name, 'Synthetic member');
}, { socialProviders: { apple: undefined } as unknown as SocialProviders }));

test('server password change replaces both sessions despite an explicit opt-out', () => fixture(async f => {
  const first = await f.signup();
  const second = await f.request('/api/auth/sign-in/email', { email, password });
  assert.equal(second.status, 200, second.text);
  const other = second.headers.get('set-auth-token'); assert.ok(other);
  const me = await f.request('/v1/me', undefined, first.token); assert.equal(me.status, 200);
  const changed = await f.request('/api/auth/change-password', {
    currentPassword: password, newPassword: nextPassword, revokeOtherSessions: false,
  }, first.token);
  assert.equal(changed.status, 200, changed.text);
  const replacement = changed.headers.get('set-auth-token'); assert.ok(replacement);
  assert.notEqual(replacement, first.token); assert.notEqual(replacement, other);
  assert.equal((await f.request('/v1/me', undefined, first.token)).status, 401);
  assert.equal((await f.request('/v1/me', undefined, other)).status, 401);
  const current = await f.request('/v1/me', undefined, replacement);
  assert.equal(current.status, 200); assert.equal(current.body.accountId, me.body.accountId);
}));

test('server defaults mail capabilities and credential recovery routes to unavailable', () => fixture(async f => {
  const capabilities = await f.request('/v1/capabilities');
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.authentication.emailPassword.passwordRecovery, 'unconfigured');
  assert.equal(capabilities.body.authentication.emailPassword.emailChange, 'unconfigured');
  const first = await f.signup();
  const recovery = await f.request('/api/auth/email-otp/request-password-reset', { email });
  assert.equal(recovery.status, 501); assert.equal(recovery.body.error.code, 'password_recovery_unavailable');
  assert.equal((await f.request('/api/auth/email-otp/request-email-change', { newEmail: 'new@synthetic.invalid', currentPassword: password }, first.token)).status, 501);
}));

test('server forwards the injected mail port and reports its current status', async () => {
  const sent: CredentialMailInput[] = [];
  let status: CredentialMailStatus = 'configured_unverified';
  await fixture(async f => {
    const first = await f.signup();
    for (const next of ['configured_unverified', 'verified'] as const) {
      status = next;
      const capabilities = await f.request('/v1/capabilities');
      assert.equal(capabilities.body.authentication.emailPassword.passwordRecovery, next);
      assert.equal(capabilities.body.authentication.emailPassword.emailChange, next);
    }
    const recovery = await f.request('/api/auth/email-otp/request-password-reset', { email });
    assert.equal(recovery.status, 200, recovery.text); assert.deepEqual(recovery.body, { success: true });
    assert.equal(sent.length, 1); assert.equal(sent[0]!.email, email); assert.equal(sent[0]!.type, 'forget-password');
    assert.match(sent[0]!.otp, /^[0-9]{8}$/); assert.ok(!recovery.text.includes(sent[0]!.otp));
    const change = await f.request('/api/auth/email-otp/request-email-change', {
      newEmail: 'new@synthetic.invalid', currentPassword: password,
    }, first.token);
    assert.equal(change.status, 200, change.text); assert.equal(sent.length, 2);
    assert.equal(sent[1]!.email, 'new@synthetic.invalid'); assert.equal(sent[1]!.type, 'change-email');
  }, { credentialMail: { status: () => status, dispatch: input => { sent.push(input); } } });
});

test('server auth composition preserves registration, origin, body limit and trusted peer address', () => fixture(async f => {
  const denied = await f.request('/api/auth/sign-up/email', { name: 'Denied', email: 'denied@synthetic.invalid', password });
  assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'registration_unavailable');
  const extra = await f.request('/api/auth/sign-up/email', { name: 'Extra', email, password, role: 'admin' });
  assert.equal(extra.status, 422);
  const origin = await f.request('/api/auth/sign-up/email', { name: 'Origin', email, password }, undefined, { origin: 'https://untrusted.invalid' });
  assert.equal(origin.status, 403);
  const oversized = await f.request('/api/auth/sign-up/email', { name: 'a'.repeat(65 * 1024), email, password });
  assert.equal(oversized.status, 413); assert.equal(oversized.body.error.code, 'body_too_large');
  const first = await f.signup();
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  const session = f.backend.db.prepare('SELECT ipAddress FROM session WHERE userId=?').get(first.body.user.id) as { ipAddress: string };
  assert.equal(session.ipAddress, peerAddress);
}));
