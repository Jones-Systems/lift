import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguredBrowserSession } from '../../public/browser-session.mjs';
import { createServer } from '../../../../services/api/src/server.ts';

// Explicit Node 24/API-dependency integration suite; the default website tests
// remain dependency-free. No listener, global fetch, provider or real account.
// This fixture jar transports server cookies; it does not qualify browser
// SameSite/CORS behavior, UI rendering, or the disabled production entry point.
const apiBase = 'https://api.synthetic.invalid';
const browserOrigin = 'https://web.synthetic.invalid';
const emails = ['first@synthetic.invalid', 'second@synthetic.invalid'];
const password = 'Synthetic-browser-session-password-1234';

function browser(backend) {
  const cookies = new Map();
  const calls = [];
  let losePreferenceResponse = false;
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  async function dispatch(path, init = {}) {
    const headers = new Headers(init.headers);
    assert.equal(headers.has('authorization'), false);
    headers.set('origin', browserOrigin);
    if (cookies.size) headers.set('cookie', cookieHeader());
    const response = await backend.handleRequest(new Request(apiBase + path, { ...init, headers }), '192.0.2.10');
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';');
      const split = pair.indexOf('=');
      assert.ok(split > 0);
      const name = pair.slice(0, split), value = pair.slice(split + 1);
      if (attributes.some(attribute => /^max-age=0$/i.test(attribute.trim()))) cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  }
  const session = createConfiguredBrowserSession({
    config: { apiBase, verifiedBrowserOrigin: browserOrigin, trackingEnabled: false },
    browserOrigin,
    fetchImpl: async (url, init) => {
      const target = new URL(url);
      assert.equal(target.origin, apiBase);
      assert.equal(init.credentials, 'include');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.redirect, 'error');
      const path = target.pathname + target.search;
      calls.push({ path, method: init.method });
      const response = await dispatch(path, init);
      if (losePreferenceResponse && path === '/v1/me/preferences' && init.method === 'PATCH') {
        losePreferenceResponse = false;
        assert.equal(response.status, 200);
        await response.text(); // The actual server committed; only its response is lost.
        throw new Error('Synthetic response loss after server commit');
      }
      return response;
    },
  });
  return {
    session, calls, cookieHeader,
    loseNextPreferenceResponse() { losePreferenceResponse = true; },
    async signup(email, name) {
      const response = await dispatch('/api/auth/sign-up/email', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, name, password }),
      });
      assert.equal(response.status, 200, await response.text());
      assert.ok(cookies.size > 0, 'server must establish the fixture cookie session');
    },
  };
}

async function fixture(run) {
  const parent = fileURLToPath(new URL('../../.scratch/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'api-session-'));
  let backend;
  const cleanup = () => {
    try { if (backend?.db.open) backend.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  };
  const interrupted = () => { cleanup(); process.exit(130); };
  const terminated = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);
  try {
    backend = await createServer({
      dbPath: join(root, 'synthetic.sqlite'), baseURL: apiBase,
      secret: 'synthetic-browser-session-secret-over-32-characters',
      trustedOrigins: [browserOrigin], registration: { mode: 'allowlist', emails },
    });
    await run({ backend, first: browser(backend), second: browser(backend) });
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', terminated);
    cleanup();
  }
}

function ready(state) {
  assert.equal(state.status, 'ready', JSON.stringify(state.error));
  return state.data;
}

test('configured cookie session reads and writes account-owned API resources and revokes signout', () => fixture(async ({ backend, first, second }) => {
  assert.equal((await first.session.refresh()).status, 'anonymous');
  assert.throws(() => first.session.preferences(), /session_not_ready/);
  await first.signup(emails[0], 'Synthetic first');
  const bound = await first.session.refresh();
  assert.equal(bound.status, 'ready');
  assert.equal(bound.runtimeQualified, false);
  const identity = bound.account.account;
  assert.equal(bound.application.account.accountId, identity.accountId);
  assert.equal(bound.application.entitlements.accountId, identity.accountId);
  assert.equal(bound.application.entitlements.appAccountToken, identity.appAccountToken);
  assert.deepEqual(bound.application.entitlements.active, []);
  assert.equal(bound.application.entitlements.purchases, 'unavailable');

  const preferences = ready(await first.session.preferences());
  const savedPreferences = ready(await first.session.savePreferences(preferences, { mascot: 'none', loadUnit: 'lb' }));
  assert.equal(savedPreferences.revision, preferences.revision + 1);
  assert.deepEqual(ready(await first.session.preferences()), savedPreferences);
  const profile = ready(await first.session.profile());
  const savedProfile = ready(await first.session.saveProfile(profile, { name: 'Synthetic updated', trainingContext: 'Synthetic test context' }));
  assert.equal(savedProfile.revision, profile.revision + 1);
  assert.deepEqual(ready(await first.session.profile()), savedProfile);

  const exercise = ready(await first.session.exercises()).items.find(item => !item.retired);
  assert.ok(exercise);
  const plan = ready(await first.session.createPlan({
    name: 'Synthetic owned plan', minutes: 30,
    items: [{ id: 'synthetic_item', exerciseId: exercise.id, setTarget: 2, repMin: 5, repMax: 8, targetKg: 10 }],
  }, 'synthetic_plan_create'));
  assert.deepEqual(ready(await first.session.plan(plan.id)), plan);
  assert.deepEqual(ready(await first.session.plans()).items, [plan]);

  await second.signup(emails[1], 'Synthetic second');
  const other = await second.session.refresh();
  assert.equal(other.status, 'ready');
  assert.notEqual(other.account.account.accountId, identity.accountId);
  assert.equal(ready(await second.session.profile()).name, 'Synthetic second');
  assert.deepEqual(ready(await second.session.preferences()), preferences);
  const otherPlans = await second.session.plans();
  assert.equal(otherPlans.status, 'empty');
  assert.deepEqual(otherPlans.data.items, []);
  const denied = await second.session.plan(plan.id);
  assert.equal(denied.status, 'error');
  assert.equal(denied.error.status, 404);

  const revokedCookie = first.cookieHeader();
  assert.equal((await first.session.signout()).status, 'anonymous');
  assert.deepEqual(first.session.snapshot().application.resources, {});
  assert.throws(() => first.session.profile(), /session_not_ready/);
  const replay = await backend.handleRequest(new Request(apiBase + '/v1/me', {
    headers: { origin: browserOrigin, cookie: revokedCookie },
  }), '192.0.2.10');
  assert.equal(replay.status, 401, 'server must revoke the captured cookie, not only clear local state');
  assert.equal((await first.session.refresh()).status, 'anonymous');
  assert.equal((await second.session.refresh()).status, 'ready');
}));

test('lost preference response reconciles the real committed API revision without repeating the write', () => fixture(async ({ first }) => {
  await first.signup(emails[0], 'Synthetic first');
  assert.equal((await first.session.refresh()).status, 'ready');
  const before = ready(await first.session.preferences());
  first.loseNextPreferenceResponse();
  const result = await first.session.savePreferences(before, { mascot: 'none' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.error.effect, 'unknown');
  assert.deepEqual(result.pending.body, { mascot: 'none', expectedRevision: before.revision });
  await assert.rejects(first.session.refresh(), /unknown_intent_pending/);
  const reconciled = ready(await first.session.reconcilePreferences());
  assert.equal(reconciled.mascot, 'none');
  assert.equal(reconciled.revision, before.revision + 1);
  assert.equal(first.calls.filter(call => call.path === '/v1/me/preferences' && call.method === 'PATCH').length, 1);
  assert.equal((await first.session.refresh()).status, 'ready');
  assert.deepEqual(ready(await first.session.preferences()), reconciled);
}));
