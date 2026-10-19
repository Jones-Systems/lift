import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfiguredBrowserSession } from '../public/browser-session.mjs';

// Explicit in-memory .invalid transport; no credentials, real cookies, network, timers, or scratch.
const origin = 'https://web.invalid';
const config = { apiBase: 'https://api.invalid', verifiedBrowserOrigin: origin, trackingEnabled: false };
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const me = accountId => ({ accountId, appAccountToken: accountId, profile: { revision: 0, name: 'Synthetic' }, preferences: { revision: 1 }, onboarding: { revision: 0, status: 'draft' } });
const grants = accountId => ({ accountId, appAccountToken: accountId, grants: [], active: [], purchases: { status: 'unconfigured', environment: 'Sandbox', chargesEnabled: false, verification: 'apple_jws_offline', onlineCertificateRevocation: false } });
const capabilities = { authentication: { emailPassword: { status: 'configured_unverified', registration: 'closed', passwordRecovery: 'unconfigured', emailChange: 'unconfigured' }, session: { transport: 'signed_bearer_or_cookie', expiresInSeconds: 604800 } } };
const preferences = (changes = {}) => ({ revision: 1, appMode: 'advanced', mascot: 'buff', animationStyle: 'long', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [], remindersEnabled: false, ...changes });
const profile = (changes = {}) => ({ revision: 0, name: 'Stored name', age: null, heightCm: null, weightKg: null,
  trainingBackground: null, injuryHistory: '', goals: [], ...changes });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(handler = () => undefined) {
  const calls = []; let identity = A;
  const options = { config: { ...config }, browserOrigin: origin, fetchImpl: async (url, init) => {
    assert.equal(new URL(url).origin, config.apiBase);
    const call = { path: new URL(url).pathname, ...init, payload: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    assert.equal(init.credentials, 'include'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.Origin, undefined);
    const handled = await handler(call, calls);
    if (handled !== undefined) return handled;
    if (call.path === '/v1/capabilities') return response(capabilities);
    if (call.path === '/v1/me') return response(identity ? me(identity) : {}, identity ? 200 : 401);
    if (call.path === '/v1/entitlements') return response(grants(identity));
    if (call.path === '/api/auth/sign-out') { identity = null; return response({ success: true }); }
    if (call.path === '/v1/me/preferences') return response(preferences());
    if (call.path === '/v1/plans') return response({ items: [] });
    assert.fail(`Unexpected path ${call.path}`);
  } };
  return { session: createConfiguredBrowserSession(options), calls, options, switchTo: id => { identity = id; } };
}

test('explicit configuration constructs an idle session; no flags or credentials establish identity', async () => {
  assert.throws(() => createConfiguredBrowserSession(), /configured_session_options_required/);
  for (const bad of [null, 'http://api.invalid', 'https://api.invalid/path', 'https://user:pass@api.invalid', 'https://api.invalid?token=x']) {
    assert.throws(() => createConfiguredBrowserSession({ config: { ...config, apiBase: bad }, browserOrigin: origin, fetchImpl() {} }), /configured_session_options_required/);
  }
  const f = fixture();
  assert.equal(f.calls.length, 0); assert.equal(f.session.snapshot().status, 'empty');
  assert.equal(f.session.snapshot().runtimeQualified, false);
  assert.throws(() => f.session.preferences(), /session_not_ready/);
  for (const method of ['signin', 'signup', 'switchAccount']) {
    assert.throws(() => f.session[method]({ authenticated: true }), /credential_submission_unavailable/);
  }
  assert.equal(f.calls.length, 0);
  const bound = await f.session.refresh();
  assert.equal(bound.status, 'ready'); assert.equal(bound.runtimeQualified, false);
  assert.equal(bound.account.account.accountId, A); assert.equal(bound.application.account.accountId, A);
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/capabilities', '/v1/me', '/v1/entitlements', '/v1/me', '/v1/me', '/v1/entitlements', '/v1/me']);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('configured options are captured; caller mutation cannot redirect later dispatch', async () => {
  const f = fixture();
  f.options.config.apiBase = 'https://changed.invalid';
  f.options.browserOrigin = 'https://changed.invalid';
  f.options.fetchImpl = () => assert.fail('Replacement transport must not run');
  await f.session.refresh(); await f.session.preferences();
  const state = f.session.snapshot({ assetReady: true });
  assert.equal(state.application.presentation.data.animationStyle, 'long');
  assert.equal(state.application.resources.preferences.data.appMode, 'advanced');
  assert.equal(Object.isFrozen(state.application.resources.preferences.data), true);
});

test('compatible capabilities and an absent cookie do not admit resource operations', async () => {
  const f = fixture(); f.switchTo(null);
  const state = await f.session.refresh();
  assert.equal(state.status, 'anonymous'); assert.equal(state.application.account, null);
  assert.throws(() => f.session.plans(), /session_not_ready/);
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/capabilities', '/v1/me']);
});

test('identity disagreement between account and resource bindings closes admission', async () => {
  let reads = 0;
  const f = fixture(call => {
    if (call.path === '/v1/me') return response(me(++reads <= 2 ? A : B));
    if (call.path === '/v1/entitlements') return response(grants(reads <= 2 ? A : B));
  });
  const state = await f.session.refresh();
  assert.equal(state.status, 'unavailable'); assert.equal(state.error.code, 'account_changed');
  assert.equal(state.account.account, null); assert.equal(state.application.account, null);
  assert.throws(() => f.session.plans(), /session_not_ready/);
});

test('pending resource write settles before signout; obsolete queued operations never dispatch', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => {
    if (call.path === '/v1/me/preferences' && call.method === 'PATCH') { entered.resolve(); return gate.promise; }
  });
  await f.session.refresh();
  const write = f.session.savePreferences(preferences(), { mascot: 'none' });
  const discardedWrite = assert.rejects(write, /stale_generation/);
  await entered.promise;
  const read = f.session.plans(), discardedRead = assert.rejects(read, /stale_generation/);
  const leaving = f.session.signout();
  assert.equal(f.session.snapshot().status, 'signing-out');
  assert.equal(f.session.snapshot().account.account, null);
  assert.equal(f.session.snapshot().application.account, null);
  assert.throws(() => f.session.preferences(), /session_not_ready/);
  assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out').length, 0);
  gate.resolve(response(preferences({ revision: 2, mascot: 'none' })));
  await discardedWrite; await discardedRead; await leaving;
  assert.equal(f.session.snapshot().status, 'anonymous');
  assert.equal(f.calls.filter(call => call.path === '/v1/plans').length, 0);
  assert.equal(f.calls.at(-1).path, '/api/auth/sign-out');
  assert.deepEqual(f.session.snapshot().application.resources, {});
});

test('signout supersedes pending refresh and refresh cannot cancel a pending signout', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => {
    if (call.path === '/v1/capabilities') { entered.resolve(); return gate.promise; }
  });
  const refresh = f.session.refresh(); await entered.promise;
  const leaving = f.session.signout();
  await assert.rejects(f.session.refresh(), /session_transition_pending/);
  assert.equal(f.session.signout(), leaving);
  gate.resolve(response(capabilities));
  await refresh; await leaving;
  assert.equal(f.session.snapshot().status, 'anonymous');
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/capabilities', '/api/auth/sign-out']);
});

test('clear cancels an undispatched signout without claiming server signout', async () => {
  const f = fixture();
  const leaving = f.session.signout();
  const cleared = f.session.clear();
  assert.equal(cleared.status, 'empty'); assert.equal(cleared.application.account, null);
  await leaving;
  assert.equal(f.calls.length, 0);
  assert.match(f.session.snapshot().account.message, /Local clear does not perform server sign-out/);
});

test('explicit rebind clears projections immediately and a late read cannot restore the old identity', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => {
    if (call.path === '/v1/me/preferences') { entered.resolve(); return gate.promise; }
  });
  await f.session.refresh(); f.session.selectView('preferences');
  const reading = f.session.preferences(), discarded = assert.rejects(reading, /stale_generation/);
  await entered.promise;
  f.switchTo(B);
  const rebinding = f.session.refresh();
  assert.equal(f.session.snapshot().application.presentation, null);
  assert.equal(f.session.snapshot().application.selectedView, 'plans');
  gate.resolve(response(preferences()));
  await discarded; const state = await rebinding;
  assert.equal(state.status, 'ready'); assert.equal(state.application.account.accountId, B);
  assert.equal(state.application.presentation, null);
});

test('resource write 401 closes admission and preserves unknown effect without old account facts', async () => {
  const f = fixture(call => call.method === 'PATCH' ? response({}, 401) : undefined);
  await f.session.refresh(); await f.session.preferences();
  const result = await f.session.savePreferences(preferences(), { mascot: 'none' });
  assert.equal(result.status, 'unknown'); assert.equal(result.error.effect, 'unknown');
  const state = f.session.snapshot();
  assert.equal(state.status, 'unavailable'); assert.equal(state.account.account, null);
  assert.equal(state.application.account, null); assert.equal(state.application.entitlements, null);
  assert.equal(state.application.presentation.status, 'unknown'); assert.equal(state.application.presentation.data, null);
  assert.equal(state.application.presentation.error.code, 'unauthenticated');
  assert.throws(() => f.session.plans(), /session_not_ready/);
});

test('unknown resource write retains facts and exact intent; refresh cannot erase its hold', async () => {
  let saved = preferences();
  const f = fixture(call => {
    if (call.path !== '/v1/me/preferences') return;
    if (call.method === 'GET') return response(saved);
    assert.deepEqual(call.payload, { mascot: 'none', expectedRevision: 1 });
    saved = preferences({ revision: 2, mascot: 'none' }); throw new Error('lost after commit');
  });
  await f.session.refresh(); await f.session.preferences();
  assert.equal((await f.session.savePreferences(preferences(), { mascot: 'none' })).status, 'unknown');
  await assert.rejects(f.session.refresh(), /unknown_intent_pending/);
  const retained = f.session.snapshot().application.presentation;
  assert.equal(retained.status, 'unknown'); assert.equal(retained.data.mascot, 'buff');
  assert.deepEqual(retained.pending.body, { mascot: 'none', expectedRevision: 1 });
  await f.session.reconcilePreferences();
  assert.equal(f.session.snapshot().application.presentation.status, 'ready');
  assert.equal(f.session.snapshot().application.presentation.data.mascot, 'none');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('conflict remains conflict through composition without retry or optimistic preference change', async () => {
  const f = fixture(call => call.method === 'PATCH' ? response({}, 409) : undefined);
  await f.session.refresh(); await f.session.preferences();
  const result = await f.session.savePreferences(preferences(), { mascot: 'none' });
  assert.equal(result.status, 'conflict');
  const state = f.session.snapshot().application.presentation;
  assert.equal(state.status, 'conflict'); assert.equal(state.data.mascot, 'buff');
  assert.equal(state.error.status, 409); assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('unknown dispatched signout survives clear and requires readback before another signout', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => {
    if (call.path === '/api/auth/sign-out') { entered.resolve(); return gate.promise; }
  });
  await f.session.refresh();
  const leaving = f.session.signout(); await entered.promise;
  f.session.clear();
  gate.resolve(response({}, 503));
  await leaving;
  const unknown = f.session.snapshot();
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.error.effect, 'unknown');
  assert.equal(unknown.application.account, null);
  const count = f.calls.length;
  await f.session.signout(); f.session.clear(); await f.session.signout();
  assert.equal(f.calls.length, count); assert.equal(f.session.snapshot().status, 'unknown');
  f.switchTo(null);
  const reconciled = await f.session.refresh();
  assert.equal(reconciled.status, 'anonymous'); assert.equal(reconciled.error, null);
  assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out').length, 1);
});

test('profile uncertainty holds refresh through pending failed and malformed readbacks until reconciliation', async () => {
  const gate = deferred(), entered = deferred(); let mode = 'initial';
  const f = fixture(call => {
    if (call.path !== '/v1/me/profile') return;
    if (call.method === 'PATCH') throw new Error('lost response');
    if (mode === 'pending') { entered.resolve(); return gate.promise; }
    if (mode === 'malformed') return response({});
    return response(profile(mode === 'confirmed' ? { revision: 1, trainingContext: 'Own context' } : {}));
  });
  assert.throws(() => f.session.profile(), /session_not_ready/); assert.equal(f.calls.length, 0);
  await f.session.refresh(); await f.session.profile();
  await f.session.saveProfile(profile(), { trainingContext: '  Own context  ' });
  mode = 'pending'; const reading = f.session.profile(); await entered.promise;
  assert.equal(f.session.snapshot().application.resources.profile.status, 'unknown');
  await assert.rejects(f.session.refresh(), /unknown_intent_pending/);
  gate.resolve(response({}, 503)); await reading;
  const intent = f.session.snapshot().application.resources.profile.pending;
  await assert.rejects(f.session.refresh(), /unknown_intent_pending/);
  mode = 'malformed'; await f.session.reconcileProfile();
  assert.deepEqual(f.session.snapshot().application.resources.profile.pending, intent);
  await assert.rejects(f.session.refresh(), /unknown_intent_pending/);
  mode = 'confirmed'; await f.session.reconcileProfile();
  assert.equal(f.session.snapshot().application.resources.profile.status, 'ready');
  assert.equal(f.session.snapshot().runtimeQualified, false);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('profile write shares the signout barrier and a queued duplicate cannot reach a retired generation', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => {
    if (call.path !== '/v1/me/profile') return;
    if (call.method === 'PATCH') { entered.resolve(); return gate.promise; }
    return response(profile());
  });
  await f.session.refresh(); await f.session.profile();
  const writing = f.session.saveProfile(profile(), { age: 30 }); const retiredWrite = assert.rejects(writing, /stale_generation/);
  await entered.promise;
  const duplicate = f.session.saveProfile(profile(), { age: 30 }); const retiredDuplicate = assert.rejects(duplicate, /stale_generation/);
  const leaving = f.session.signout();
  assert.equal(f.session.snapshot().status, 'signing-out'); assert.deepEqual(f.session.snapshot().application.resources, {});
  assert.throws(() => f.session.profile(), /session_not_ready/);
  assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out').length, 0);
  gate.resolve(response(profile({ revision: 1, age: 30 })));
  await retiredWrite; await retiredDuplicate; await leaving;
  assert.equal(f.session.snapshot().status, 'anonymous'); assert.deepEqual(f.session.snapshot().application.resources, {});
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(f.calls.at(-1).path, '/api/auth/sign-out');
});

test('profile identity loss removes stored facts and closes session admission while keeping unknown effect', async () => {
  const f = fixture(call => call.path === '/v1/me/profile' ? response(call.method === 'PATCH' ? {} : profile(), call.method === 'PATCH' ? 401 : 200) : undefined);
  await f.session.refresh(); await f.session.profile(); await f.session.saveProfile(profile(), { injuryHistory: 'Own history' });
  const state = f.session.snapshot();
  assert.equal(state.status, 'unavailable'); assert.equal(state.account.account, null);
  assert.equal(state.application.resources.profile.status, 'unknown'); assert.equal(state.application.resources.profile.data, null);
  assert.equal(state.application.resources.profile.pending, null); assert.equal(state.application.resources.profile.error.effect, 'unknown');
  assert.throws(() => f.session.profile(), /session_not_ready/);
});
