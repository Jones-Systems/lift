import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { hash, migrations } from '../../../src/storage.js';
import { lifecycleMigration } from '../../../src/lifecycle/migration.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { DomainError } from '../../../src/errors.js';
import type { AccountContext, SuppressionLedger } from '../../../src/lifecycle/types.js';
import { createNutritionConversationRoutes } from '../../../src/integration/nutrition-conversation/routes.js';
import { createServer, type FormServer } from '../../../src/server.js';
import type { NutritionWireResponse } from '../../../src/integration/nutrition-conversation/wire.js';
import { envelope, input, fixture } from './fixturewire.js';

const prefix = '/v1/nutrition/conversations';
function routes(t: TestContext) {
  const f = fixture(t);
  type Env = { Variables: { actor: AccountContext } };
  const app = new Hono<Env>();
  app.onError((error, c) => error instanceof DomainError ? c.json({ error: { code: error.code } }, error.status)
    : c.json({ error: { code: error instanceof z.ZodError ? 'invalid_request' : 'internal_error' } }, error instanceof z.ZodError ? 422 : 500));
  app.use('*', async (c, next) => {
    const actor = c.req.header('authorization') === 'Synthetic one' ? f.actor : c.req.header('authorization') === 'Synthetic two' ? f.other : null;
    if (!actor) throw new DomainError(401, 'unauthenticated');
    f.lifecycle.assertActive(actor); c.set('actor', actor); await next();
  });
  app.route(prefix, createNutritionConversationRoutes<Env>({ context: c => c.get('actor'), lifecycle: f.lifecycle, controller: f.controller }));
  const post = (suffix: string, value: unknown = envelope(), authorization = 'Synthetic one') => app.request(prefix + suffix,
    { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { f, app, post };
}

test('HTTP authenticates, strictly parses bounded input and preserves account-isolated complete replies', async t => {
  const { post, f } = routes(t);
  assert.equal((await post('/reset-fresh-empty', envelope(), '')).status, 401);
  assert.equal((await post('/reset-fresh-empty', { ...envelope(), accountId: 'other' })).status, 422);
  const reset = await post('/reset-fresh-empty'); assert.equal(reset.status, 201);
  assert.equal(reset.headers.get('cache-control'), 'no-store');
  const binding = (await reset.json() as NutritionWireResponse).binding!;
  const foreign = await post(`/${binding.id}/snapshot`, envelope(), 'Synthetic two');
  assert.equal((await foreign.json() as NutritionWireResponse).code, 'conversation_unavailable');
  const submitted = await post(`/${binding.id}/submit`, { ...envelope(), input: input() });
  assert.equal(submitted.status, 200);
  const state = (await submitted.json() as NutritionWireResponse).state;
  assert.equal(state?.conversation.turns.length, 1); assert.equal(state?.conversation.currentExplanation?.choice.automaticAdoption, false);
  const selected = await post(`/${binding.id}/select-citation`, { ...envelope(), input: { parentTurnId: 1, statementId: 'SYN-S01' } });
  assert.equal((await selected.json() as NutritionWireResponse).state?.currentSelection?.statement.citation.record.clinical_readiness, 'CL-0');
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    [{ name: 'account_lifecycle' }, { name: 'form_accounts' }, { name: 'session' }]);
});
test('HTTP media, malformed JSON and streamed body limits fail before producer invocation', async t => {
  const { app, f } = routes(t);
  const request = (body: string, type: string) => app.request(prefix + '/reset-fresh-empty', {
    method: 'POST', headers: { authorization: 'Synthetic one', 'content-type': type }, body,
  });
  assert.equal((await request('{}', 'text/plain')).status, 415);
  assert.equal((await request('{', 'application/json')).status, 400);
  assert.equal((await request(' '.repeat(16385), 'application/json')).status, 413);
  assert.equal(f.calls(), 0);
});
test('HTTP rechecks the original canonical actor after each streamed read', async t => {
  const { app, f } = routes(t);
  const bytes = new TextEncoder().encode(JSON.stringify(envelope()));
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (reads++ === 0) controller.enqueue(bytes.subarray(0, 10));
    else { f.db.exec("DELETE FROM session WHERE id='s1'"); controller.enqueue(bytes.subarray(10)); controller.close(); }
  } });
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', body: stream,
    headers: { authorization: 'Synthetic one', 'content-type': 'application/json' } };
  const response = await app.fetch(new Request('http://synthetic.invalid' + prefix + '/reset-fresh-empty', init));
  assert.equal(response.status, 401); assert.equal(f.calls(), 0);
});

async function serverFixture(t: TestContext, enabled: boolean): Promise<FormServer> {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'nutrition-wire-'));
  let backend: FormServer | undefined;
  const cleanup = () => { try { if (backend?.db.open) backend.close(); } finally { rmSync(root, { recursive: true, force: true }); } };
  const interrupted = () => { cleanup(); process.exit(130); };
  const terminated = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', terminated);
  t.after(() => { process.off('SIGINT', interrupted); process.off('SIGTERM', terminated); cleanup(); });
  const ledger: SuppressionLedger = { currentSequence: () => 0, lookup: () => null, reconcileRestore: () => 0,
    recordDisable: () => { throw Error('Synthetic ledger does not disable accounts'); } };
  const projectionBytes = enabled ? readFileSync(new URL('../../../grounding/84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8/projection.json', import.meta.url)) : undefined;
  const dbPath = join(root, 'synthetic.sqlite');
  const seed = new Database(dbPath);
  try {
    seed.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
    for (const migration of migrations) {
      seed.exec(migration.sql);
      seed.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
    }
    if (enabled) seed.exec(lifecycleMigration.sql);
  } finally { seed.close(); }
  backend = await createServer({ dbPath, baseURL: 'http://127.0.0.1:47933',
    secret: 'synthetic-nutrition-wire-secret-over-32-characters', registration: { mode: 'allowlist', emails: ['nutrition@synthetic.invalid'] },
    ...(projectionBytes ? { lifecycle: { ledger }, sourceNutritionConversations: { projectionBytes } } : {}),
  });
  return backend;
}
test('actual server defaults unavailable and mounts retained bytes only through explicit source injection', async t => {
  for (const enabled of [false, true]) {
    const backend = await serverFixture(t, enabled);
    const request = (path: string, value?: unknown, token?: string) => backend.handleRequest(new Request('http://127.0.0.1:47933' + path, {
      method: value === undefined ? 'GET' : 'POST', headers: { origin: 'http://127.0.0.1:47933', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }), '192.0.2.33');
    assert.equal((await request(prefix + '/reset-fresh-empty', envelope())).status, 401);
    const signup = await request('/api/auth/sign-up/email', { name: 'Synthetic nutrition', email: 'nutrition@synthetic.invalid', password: 'Synthetic-nutrition-password-1234' });
    assert.equal(signup.status, 200); const token = signup.headers.get('set-auth-token'); assert.ok(token);
    assert.equal((await request('/v1/me', undefined, token)).status, 200);
    const reset = await request(prefix + '/reset-fresh-empty', envelope(), token);
    const payload = await reset.json() as NutritionWireResponse;
    assert.equal(reset.status, enabled ? 201 : 200);
    assert.equal(payload.code, enabled ? null : 'nutrition_unconfigured');
    if (enabled) {
      assert.deepEqual(payload.state?.conversation.turns, []);
      const submitted = await request(`${prefix}/${payload.binding!.id}/submit`, { ...envelope(), input: input() }, token);
      const result = await submitted.json() as NutritionWireResponse;
      assert.equal(result.status, 'ok'); assert.equal(result.state?.conversation.turns.length, 1);
      assert.equal(result.state?.conversation.currentExplanation?.choice.automaticAdoption, false);
    }
    assert.equal((backend.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%nutrition%' OR name LIKE '%conversation%'").get() as { n: number }).n, 0);
  }
});
