import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createServer, type FormServer } from '../src/server.js';
import { activityMigration } from '../src/activity/migration.js';
import { communityMigration } from '../src/community/migration.js';
import { ExistingSuppressionLedger, suppressionLedgerSchema } from '../src/lifecycle/ledger.js';
import { lifecyclePolicy } from '../src/lifecycle/service.js';
import type { LifecycleAdapter } from '../src/lifecycle/types.js';

// Handler-level maintained-auth qualification. Real module storage is not exercised by these synthetic empty adapters.
const emptyAdapter = (category: string): LifecycleAdapter => ({ category,
  inventory: () => ({ category, status: 'complete', count: 0 }), export: () => ({ category, status: 'complete', count: 0 }),
  suppress: () => ({ status: 'complete' }), purge: () => ({ status: 'pending', reason: 'synthetic_no_purge' }), verifySuppressed: () => ({ status: 'complete' }) });
const password = 'synthetic-lifecycle-http-password-12345';
const secret = 'synthetic-lifecycle-http-auth-secret-over-32-chars';
async function fixture(run: (request: (path: string, token?: string, method?: string, value?: unknown, key?: string, extra?: Record<string,string>) => Promise<{ status: number; value: any; headers: Headers }>, backend: FormServer) => Promise<void>) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'lifecycle-http-')); chmodSync(root, 0o700);
  let backend: FormServer | undefined, ledger: ExistingSuppressionLedger | undefined;
  const cleanup = () => { if (backend?.db.open) backend.close(); ledger?.close(); ledger = undefined; rmSync(root, { recursive: true, force: true }); };
  const interrupted = () => { cleanup(); process.exit(130); }, terminated = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', terminated);
  try {
    const authorityPath = join(root, 'authority.sqlite'), provision = new Database(authorityPath);
    try { provision.exec(suppressionLedgerSchema); provision.prepare('INSERT INTO suppression_authority VALUES(?,0)').run('synthetic-handler-authority'); }
    finally { provision.close(); }
    chmodSync(authorityPath, 0o600); ledger = new ExistingSuppressionLedger(authorityPath, 'synthetic-handler-authority', 0);
    const base = 'http://127.0.0.1:47831';
    backend = await createServer({ publicStagedLifecycleEnabled:true, dbPath: join(root, 'app.sqlite'), baseURL: base, secret,
      registration: { mode: 'allowlist', emails: ['one@synthetic.invalid', 'two@synthetic.invalid'] },
      moduleMigrations: { activity: activityMigration, community: communityMigration },
      lifecycle: { ledger, adapters: [emptyAdapter('activity'), emptyAdapter('community')] } });
    const request = async (path: string, token?: string, method = 'GET', value?: unknown, key?: string, extra: Record<string,string> = {}) => {
      const headers: Record<string,string> = { origin: base, ...extra };
      if (token) headers.authorization = `Bearer ${token}`;
      if (value !== undefined) headers['content-type'] = 'application/json';
      if (key) headers['idempotency-key'] = key;
      const response = await backend!.handleRequest(new Request(base + path, { method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), '127.0.0.1');
      const text = await response.text(); return { status: response.status, value: text ? JSON.parse(text) : null, headers: response.headers };
    };
    await run(request, backend);
  } finally { process.off('SIGINT', interrupted); process.off('SIGTERM', terminated); cleanup(); }
}

test('staged lifecycle handlers use maintained password verification and separate export, initiation, disable and secret status', () => fixture(async request => {
  const first = await request('/api/auth/sign-up/email', undefined, 'POST', { name: 'One', email: 'one@synthetic.invalid', password });
  const second = await request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Two', email: 'two@synthetic.invalid', password });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const token = first.headers.get('set-auth-token')!, otherToken = second.headers.get('set-auth-token')!;
  assert.ok(token); assert.ok(otherToken);
  const own = await request('/v1/me', token); await request('/v1/me', otherToken);
  assert.equal(own.value.preferences.mascot, 'scholarly'); assert.equal(own.value.preferences.animationStyle, 'short');
  assert.equal((await request('/v1/me/settings', token)).value.capabilities.accountDeletion.supported, false);
  assert.equal((await request('/api/auth/delete-user', token, 'POST', {})).status, 404);
  assert.equal((await request('/v1/me/account-action-grants', token, 'POST', { purpose: 'account_export', password: 'wrong' })).status, 403);
  const exportGrant = await request('/v1/me/account-action-grants', token, 'POST', { purpose: 'account_export', password });
  assert.equal(exportGrant.status, 201);
  const exportResponse = await request('/v1/me/account-export', token, 'POST', { grant: exportGrant.value.grant });
  assert.equal(exportResponse.status, 200); assert.equal(exportResponse.value.manifest.complete, false);
  assert.equal(exportResponse.headers.get('cache-control'), 'no-store');
  assert.match(exportResponse.headers.get('content-disposition')!, /attachment/);
  assert.equal((await request('/v1/me/account-export', token, 'POST', { grant: exportGrant.value.grant })).status, 403);
  const requestId = randomUUID(), statusSecret = randomBytes(32).toString('base64url');
  const input = { requestId, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account', statusSecret };
  assert.equal((await request('/v1/me/deletion-requests', token, 'POST', { ...input, accountId: own.value.accountId }, 'delete-intent')).status, 422);
  const initiated = await request('/v1/me/deletion-requests', token, 'POST', input, 'delete-intent');
  assert.equal(initiated.status, 201); assert.equal(initiated.value.phase, 'awaiting_reauthentication'); assert.equal(initiated.value.disabled, false);
  assert.equal((await request('/v1/me/deletion-requests', token, 'POST', { ...input, statusSecret: randomBytes(32).toString('base64url') }, 'delete-intent')).status, 409);
  const grant = await request('/v1/me/account-action-grants', token, 'POST', { purpose: 'account_delete', password });
  assert.equal(grant.status, 201);
  const confirm = { grant: grant.value.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' };
  assert.equal((await request(`/v1/me/deletion-requests/${requestId}/confirm`, otherToken, 'POST', confirm)).status, 404);
  const disabled = await request(`/v1/me/deletion-requests/${requestId}/confirm`, token, 'POST', confirm);
  assert.equal(disabled.status, 200); assert.equal(disabled.value.phase, 'disabled_pending_purge'); assert.equal(disabled.value.complete, false);
  assert.equal((await request('/v1/me', token)).status, 401); assert.equal((await request('/v1/me', otherToken)).status, 200);
  const status = await request('/v1/account-deletion/status', undefined, 'POST', { requestId }, undefined, { authorization: `DeletionReceipt ${statusSecret}` });
  assert.equal(status.status, 200); assert.equal(status.value.disabled, true); assert.equal(status.value.complete, false);
  assert.equal(status.value.accountId, undefined); assert.equal(status.value.statusSecret, undefined);
  assert.equal((await request('/v1/account-deletion/status', undefined, 'POST', { requestId }, undefined, { authorization: `DeletionReceipt ${randomBytes(32).toString('base64url')}` })).status, 401);
  assert.equal((await request('/api/auth/sign-in/email', undefined, 'POST', { email: 'one@synthetic.invalid', password })).status, 403);
}));
