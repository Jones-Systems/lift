import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceClient, createSyntheticResourceClient, createConfiguredResourceClient } from '../public/resource-client.mjs';

// In-memory .invalid transport only; these fixtures prove no deployed API behavior.
const origin = 'https://web.invalid';
const config = { apiBase: 'https://api.invalid', verifiedBrowserOrigin: origin, trackingEnabled: false };
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const date = '2026-10-09T00:00:00.000Z';
const preferences = (revision = 0) => ({ revision, appMode: 'basic', mascot: 'scholarly', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [], remindersEnabled: false });
const me = (id = accountId) => ({ accountId: id, appAccountToken: id, profile: { revision: 0, name: 'Synthetic' }, preferences: { revision: 0 }, onboarding: { revision: 0, status: 'draft' } });
const grants = (id = accountId) => ({ accountId: id, appAccountToken: id, grants: [], active: [], purchases: { status: 'unconfigured', environment: 'Sandbox', chargesEnabled: false, verification: 'apple_jws_offline', onlineCertificateRevocation: false } });
const item = { id: 'item1', exerciseId: 'squat', setTarget: 3, repMin: 5, repMax: 8, targetKg: 20 };
const plan = { id: 'plan1', revision: 1, name: 'Synthetic plan', minutes: 30, items: [item], archived: false, createdAt: date, updatedAt: date };
const session = () => ({ id: 'session1', planId: plan.id, planRevision: 1, revision: 1, status: 'active', planSnapshot: plan, occurrences: [{ id: 'occ1', itemId: item.id, exerciseId: item.exerciseId, position: 0, target: item }], sets: [], startedAt: date, completedAt: null });
const performed = (id = 'set1', revision = 1) => ({ id, occurrenceId: 'occ1', setNumber: 1, revision, reps: 5, weightKg: 20, status: 'confirmed', createdAt: date, updatedAt: date });
const response = (data, status = 200) => ({ status, json: async () => structuredClone(data) });
function fixture(handler = () => response({ items: [] })) {
  const calls = []; let identity = accountId;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, ...init, payload: init.body === undefined ? undefined : JSON.parse(init.body) });
    assert.equal(init.credentials, 'include'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined);
    if (path === '/v1/me') return response(me(identity));
    if (path === '/v1/entitlements') return response(grants(identity));
    return handler(path, init, calls.at(-1));
  };
  return { client: createSyntheticResourceClient({ config, browserOrigin: origin, fetchImpl }), calls, switchTo: id => { identity = id; } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const profile = (changes = {}) => ({ revision: 0, name: '  Synthetic  ', age: null, heightCm: null, weightKg: null,
  trainingBackground: null, injuryHistory: '', goals: [], ...changes });

test('profile operations stay unavailable by default and require identity before transport', async () => {
  let calls = 0;
  const closed = createResourceClient({ config, browserOrigin: origin, enabled: true, fetchImpl() { calls++; } });
  assert.equal((await closed.profile()).status, 'unavailable');
  assert.equal((await closed.saveProfile(profile(), { name: 'Changed' })).status, 'unavailable');
  assert.equal((await closed.reconcileProfile()).status, 'unavailable'); assert.equal(calls, 0);
  const f = fixture(); assert.equal((await f.client.profile()).error.code, 'identity_required'); assert.equal(f.calls.length, 0);
});

test('profile writes normalize supplied fields only and preserve sparse null empty and omitted values', async () => {
  let saved = profile({ age: 30, heightCm: 172.5, weightKg: 80, trainingBackground: 'returning', injuryHistory: '  Stored history  ', goals: [' Stored goal '] });
  const f = fixture((path, init, call) => {
    assert.equal(path, '/v1/me/profile');
    if (init.method === 'PATCH') {
      const { expectedRevision, ...changes } = call.payload;
      assert.equal(expectedRevision, saved.revision); assert.equal(init.headers['Idempotency-Key'], undefined);
      saved = { ...saved, ...changes, revision: saved.revision + 1 };
    }
    return response(saved);
  });
  await f.client.bindIdentity(); const first = (await f.client.profile()).data;
  assert.equal(Object.hasOwn(first, 'trainingContext'), false);
  const changed = (await f.client.saveProfile(first, { age: null, heightCm: null, weightKg: null, trainingBackground: null, goals: [], injuryHistory: '  ' })).data;
  assert.deepEqual(f.calls.find(call => call.method === 'PATCH').payload,
    { expectedRevision: 0, age: null, heightCm: null, weightKg: null, trainingBackground: null, goals: [], injuryHistory: '' });
  assert.equal(changed.name, first.name); assert.equal(Object.hasOwn(changed, 'trainingContext'), false);
  const values = { trainingContext: '  Morning\nsessions  ', goals: [' Goal one ', 'Goal one'] };
  const next = (await f.client.saveProfile(changed, values)).data;
  assert.deepEqual(values.goals, [' Goal one ', 'Goal one']);
  assert.deepEqual(next.goals, ['Goal one', 'Goal one']); assert.equal(next.trainingContext, 'Morning\nsessions');
  const cleared = await f.client.saveProfile(next, { name: '  New name  ', trainingContext: '' });
  assert.equal(cleared.data.name, 'New name'); assert.equal(cleared.data.trainingContext, '');
  assert.deepEqual(f.calls.filter(call => call.method === 'PATCH').at(-1).payload, { expectedRevision: 2, name: 'New name', trainingContext: '' });
});

test('invalid profile changes and unsupported keys never dispatch a PATCH', async () => {
  const f = fixture(() => response(profile())); await f.client.bindIdentity(); const count = f.calls.length;
  for (const changes of [{}, { expectedRevision: 8 }, { accountId }, { authSessionId: accountId }, { name: ' ' }, { name: 'x'.repeat(101) },
    { age: 12 }, { age: 121 }, { age: 13.5 }, { heightCm: 49 }, { heightCm: 261 }, { weightKg: 14 }, { weightKg: 501 },
    { trainingBackground: 'expert' }, { trainingContext: null }, { trainingContext: 'x'.repeat(4001) },
    { injuryHistory: null }, { injuryHistory: 'x'.repeat(4001) }, { goals: [' '] }, { goals: ['x'.repeat(201)] }, { goals: Array(31).fill('Goal') }, { goals: [null] }, { name: undefined }]) {
    assert.throws(() => f.client.saveProfile(profile(), changes), /invalid_fields|invalid_profile/);
  }
  assert.throws(() => f.client.saveProfile(profile(), { name: 'Changed' }, 'unsupported-key'), /invalid_fields/);
  assert.throws(() => f.client.saveProfile(profile({ revision: Number.MAX_SAFE_INTEGER }), { name: 'Changed' }), /invalid_fields/);
  assert.equal(f.calls.length, count);
});

test('an identical queued profile PATCH cannot replay an unknown unkeyed effect', async () => {
  const entered = deferred(), gate = deferred();
  const f = fixture((path, init) => {
    assert.equal(path, '/v1/me/profile');
    if (init.method === 'PATCH') { entered.resolve(); return gate.promise; }
    return response(profile());
  });
  await f.client.bindIdentity(); await f.client.profile();
  const first = f.client.saveProfile(profile(), { name: 'Changed' }); await entered.promise;
  const queued = f.client.saveProfile(profile(), { name: 'Changed' });
  gate.resolve(response({}, 503));
  assert.equal((await first).status, 'unknown'); assert.equal((await queued).status, 'unknown');
  assert.equal((await f.client.saveProfile(profile(), { name: 'Changed' })).status, 'unknown');
  assert.equal((await f.client.savePreferences(preferences(), { mascot: 'buff' })).status, 'unknown');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.deepEqual(f.client.snapshot('profile').pending, { path: '/v1/me/profile', method: 'PATCH', body: { name: 'Changed', expectedRevision: 0 }, key: null });
});

for (const outcome of ['matching', 'conflicting', 'unchanged']) test(`profile uncertainty requires explicit ${outcome} revision reconciliation`, async () => {
  let saved = profile();
  const f = fixture((path, init) => {
    assert.equal(path, '/v1/me/profile');
    if (init.method === 'PATCH') {
      if (outcome !== 'unchanged') saved = profile({ revision: 1, trainingContext: outcome === 'matching' ? 'Own context' : 'Other context', goals: [] });
      throw new Error('lost response');
    }
    return response(saved);
  });
  await f.client.bindIdentity(); await f.client.profile();
  assert.equal((await f.client.saveProfile(profile(), { trainingContext: '  Own context  ', goals: [] })).status, 'unknown');
  assert.equal((await f.client.profile()).status, 'unknown');
  const result = await f.client.reconcileProfile();
  assert.equal(result.status, { matching: 'ready', conflicting: 'conflict', unchanged: 'unknown' }[outcome]);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  if (outcome === 'unchanged') assert.deepEqual(result.pending.body, { trainingContext: 'Own context', goals: [], expectedRevision: 0 });
});

test('malformed or nonconfirming successful profile responses remain unknown rather than saved', async () => {
  for (const body of [{}, profile(), profile({ revision: 1, name: 'Different' })]) {
    const f = fixture((path, init) => response(init.method === 'PATCH' ? body : profile()));
    await f.client.bindIdentity(); await f.client.profile();
    const result = await f.client.saveProfile(profile(), { name: 'Changed' });
    assert.equal(result.status, 'unknown'); assert.equal(result.error.effect, 'unknown');
    assert.equal(result.data.name, profile().name); assert.equal(result.pending.body.name, 'Changed');
  }
});

test('failed profile reads and reconciliation retain unresolved intent and remove facts on 401', async () => {
  let failure = null;
  const f = fixture((path, init) => {
    assert.equal(path, '/v1/me/profile');
    if (init.method === 'PATCH' || failure === 'transport') throw new Error('disconnected');
    if (failure === 'malformed') return response({});
    if (failure === '401') return response({}, 401);
    return response(profile());
  });
  await f.client.bindIdentity(); await f.client.profile(); await f.client.saveProfile(profile(), { name: 'Changed' });
  const pending = f.client.snapshot('profile').pending;
  for (const mode of ['transport', 'malformed']) for (const method of ['profile', 'reconcileProfile']) {
    failure = mode; const result = await f.client[method]();
    assert.equal(result.status, 'unknown'); assert.equal(result.error.effect, 'unknown');
    assert.deepEqual(result.pending, pending); assert.equal(result.data.name, profile().name);
  }
  failure = '401'; const denied = await f.client.profile();
  assert.equal(denied.status, 'unknown'); assert.equal(denied.error.effect, 'unknown'); assert.equal(denied.data, null); assert.equal(denied.pending, null);
  assert.equal(f.client.snapshot().account, null); assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
});

test('profile read generation fence discards late data after an account switch', async () => {
  const entered = deferred(), gate = deferred();
  const f = fixture(() => { entered.resolve(); return gate.promise; }); await f.client.bindIdentity();
  const reading = f.client.profile(); await entered.promise;
  f.client.clear(); f.switchTo(otherId); const rebinding = f.client.bindIdentity();
  gate.resolve(response(profile({ name: 'Old private profile' }))); await reading; await rebinding;
  assert.equal(f.client.snapshot().account.accountId, otherId); assert.deepEqual(f.client.snapshot().resources, {});
});

test('configured resource factory rejects incomplete bindings without changing unavailable defaults', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('unexpected request'); };
  const sessionDispatch = { run: operation => Promise.resolve().then(operation) };
  for (const options of [{ config, browserOrigin: origin, fetchImpl }, { config, browserOrigin: origin, sessionDispatch },
    { config: { ...config, apiBase: 'http://api.invalid' }, browserOrigin: origin, fetchImpl, sessionDispatch }]) {
    assert.throws(() => createConfiguredResourceClient(options), /configured_session_options_required/);
  }
  const client = createConfiguredResourceClient({ config, browserOrigin: origin, fetchImpl, sessionDispatch });
  assert.equal(client.snapshot().status, 'empty');
  assert.equal((await client.plans()).error.code, 'identity_required');
  const closed = createResourceClient({ config, browserOrigin: origin, fetchImpl, sessionDispatch, enabled: true });
  await closed.bindIdentity(); await closed.plans();
  assert.equal(closed.snapshot().status, 'unavailable'); assert.equal(calls, 0);
});

test('production ignores all activation flags and performs zero requests', async () => {
  let calls = 0;
  const client = createResourceClient({ config, browserOrigin: origin, activate: true, enabled: true, fetchImpl: () => { calls++; } });
  await client.bindIdentity(); await client.preferences(); await client.plans(); await client.createPlan({ name: plan.name, minutes: plan.minutes, items: plan.items }, 'key1');
  assert.equal(calls, 0); assert.equal(client.snapshot().status, 'unavailable');
});

test('synthetic constructor rejects network origins and absent/global transport', () => {
  assert.throws(() => createSyntheticResourceClient({ config, browserOrigin: origin }), /synthetic_transport_required/);
  assert.throws(() => createSyntheticResourceClient({ config, browserOrigin: origin, fetchImpl: globalThis.fetch }), /synthetic_transport_required/);
  assert.throws(() => createSyntheticResourceClient({ config: { ...config, apiBase: 'https://api.example' }, browserOrigin: origin, fetchImpl() {} }), /synthetic_transport_required/);
});

test('identity is server-confirmed UUID/token plus entitlements; caller booleans confer nothing', async () => {
  const f = fixture();
  assert.equal((await f.client.plans()).error.code, 'identity_required'); assert.equal(f.calls.length, 0);
  await f.client.bindIdentity({ authenticated: true });
  assert.deepEqual(f.calls.map(x => x.path), ['/v1/me', '/v1/entitlements', '/v1/me']);
  assert.equal(f.client.snapshot().account.accountId, accountId);
  assert.ok(Object.isFrozen(f.client.snapshot().entitlements.active));
});

test('preferences PATCH stays sparse, revision-only by default, and confirmed only', async () => {
  const gate = deferred();
  const f = fixture((path, init, call) => {
    assert.equal(path, '/v1/me/preferences'); assert.equal(init.method, 'PATCH');
    assert.deepEqual(call.payload, { mascot: 'none', animationStyle: 'long', expectedRevision: 4 });
    assert.equal(init.headers['Idempotency-Key'], undefined);
    return gate.promise;
  });
  await f.client.bindIdentity();
  const saving = f.client.savePreferences(preferences(4), { mascot: 'none', animationStyle: 'long' });
  assert.notEqual(f.client.snapshot('preferences').status, 'ready');
  gate.resolve(response({ ...preferences(5), mascot: 'none', animationStyle: 'long' }));
  const saved = await saving; assert.equal(saved.status, 'ready'); assert.equal(saved.data.revision, 5);
  assert.throws(() => f.client.savePreferences(saved.data, { mascot: 'default' }), /invalid_preferences/);
  assert.throws(() => f.client.savePreferences(saved.data, { accountId: otherId }), /invalid_fields/);
});

test('unkeyed response lost after commit holds changed writes, retries exact, reconciles without overwrite', async () => {
  let committed = preferences(1), writes = 0;
  const f = fixture((path, init, call) => {
    if (init.method === 'GET') return response(committed);
    writes++;
    if (writes === 1) { committed = { ...preferences(2), mascot: 'baby' }; throw new Error('lost after commit'); }
    assert.deepEqual(call.payload, { mascot: 'baby', expectedRevision: 1 });
    return response({}, 409);
  });
  await f.client.bindIdentity();
  const first = await f.client.savePreferences(preferences(1), { mascot: 'baby' });
  assert.equal(first.status, 'unknown'); assert.equal(first.data, null);
  assert.throws(() => f.client.savePreferences(preferences(1), { mascot: 'buff' }), /key_payload_conflict/);
  assert.equal((await f.client.createPlan({ name: plan.name, minutes: plan.minutes, items: plan.items }, 'different')).status, 'unknown');
  assert.equal(writes, 1);
  assert.equal((await f.client.savePreferences(preferences(1), { mascot: 'baby' })).status, 'unknown');
  assert.equal((await f.client.preferences()).status, 'unknown');
  assert.equal((await f.client.reconcilePreferences()).status, 'ready');
  assert.equal(writes, 2);
});

test('optional keyed preference receipt retries the identical key and payload after unknown', async () => {
  let writes = 0;
  const f = fixture((path, init, call) => {
    assert.equal(init.headers['Idempotency-Key'], 'prefs1');
    assert.deepEqual(call.payload, { animationStyle: 'long', expectedRevision: 0 });
    if (++writes === 1) throw new Error('lost');
    return response({ ...preferences(1), animationStyle: 'long' });
  });
  await f.client.bindIdentity();
  assert.equal((await f.client.savePreferences(preferences(), { animationStyle: 'long' }, 'prefs1')).status, 'unknown');
  assert.throws(() => f.client.savePreferences(preferences(), { animationStyle: 'short' }, 'prefs1'), /key_payload_conflict/);
  assert.equal((await f.client.savePreferences(preferences(), { animationStyle: 'long' }, 'prefs1')).status, 'ready');
  await f.client.savePreferences(preferences(), { animationStyle: 'long' }, 'prefs1');
  assert.equal(writes, 2);
});

test('session command queue retains exact session versus set revision payloads', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture((path, init, call) => {
    if (path.endsWith('/sets')) {
      assert.deepEqual(call.payload, { occurrenceId: 'occ1', setNumber: 1, reps: 5, weightKg: 20, status: 'confirmed', expectedRevision: 1 });
      entered.resolve(); return gate.promise;
    }
    assert.equal(path, '/v1/workout-sessions/session1/sets/set1');
    assert.deepEqual(call.payload, { reps: 6, weightKg: 22, status: 'confirmed', expectedRevision: 1 });
    return response({ set: { ...performed('set1', 2), reps: 6, weightKg: 22 }, sessionRevision: 3 });
  });
  await f.client.bindIdentity();
  const first = f.client.addSet(session(), { occurrenceId: 'occ1', setNumber: 1, reps: 5, weightKg: 20, status: 'confirmed' }, 'add1');
  await entered.promise;
  const second = f.client.editSet({ ...session(), revision: 2, sets: [performed()] }, performed(), { reps: 6, weightKg: 22, status: 'confirmed' }, 'edit1');
  assert.equal(f.calls.filter(x => x.method !== 'GET').length, 1);
  gate.resolve(response({ set: performed(), sessionRevision: 2 }));
  assert.equal((await first).status, 'ready'); assert.equal((await second).data.sessionRevision, 3);
});

test('completion and void endpoints use the appropriate revisions; completed sessions reject edits', async () => {
  const s = { ...session(), revision: 2, sets: [performed()] };
  const f = fixture((path, init, call) => {
    if (path.endsWith('/void')) {
      assert.deepEqual(call.payload, { expectedRevision: 1 });
      return response({ set: { ...performed('set1', 2), status: 'voided' }, sessionRevision: 3 });
    }
    assert.equal(path, '/v1/workout-sessions/session1/complete'); assert.deepEqual(call.payload, { expectedRevision: 3 });
    return response({ ...s, sets: [{ ...performed('set1', 2), status: 'voided' }], revision: 4, status: 'completed', completedAt: date });
  });
  await f.client.bindIdentity();
  assert.equal((await f.client.voidSet(s, performed(), 'void1')).data.set.status, 'voided');
  const result = await f.client.completeWorkout({ ...s, sets: [{ ...performed('set1', 2), status: 'voided' }], revision: 3 }, 'complete1');
  assert.equal(result.status, 'ready');
  assert.throws(() => f.client.addSet(s, { occurrenceId: 'occ1', setNumber: 2, reps: 1, weightKg: 0, status: 'confirmed' }, 'add2'), /session_completed/);
});

test('schema failures fail closed; malformed successful mutation remains unknown', async () => {
  const f = fixture(() => response({ mascot: 'unrecognized' })); await f.client.bindIdentity();
  assert.equal((await f.client.preferences()).status, 'error');
  assert.equal((await f.client.savePreferences(preferences(), { mascot: 'buff' })).status, 'unknown');
});

test('late resource and late 401 cannot restore or clear a new account generation', async () => {
  for (const status of [200, 401]) {
    const gate = deferred(), entered = deferred();
    const f = fixture(() => { entered.resolve(); return gate.promise; });
    await f.client.bindIdentity();
    const old = f.client.plans(); await entered.promise;
    f.client.clear(); assert.deepEqual(f.client.snapshot().resources, {});
    f.switchTo(otherId); const binding = f.client.bindIdentity();
    gate.resolve(response({ items: [plan] }, status)); await old; await binding;
    assert.equal(f.client.snapshot().account.accountId, otherId);
    assert.equal(f.client.snapshot('plans').data, null);
  }
});

test('a cookie-account mismatch discards unlabelled resource responses', async () => {
  const f = fixture(() => { f.switchTo(otherId); return response({ items: [plan] }); });
  await f.client.bindIdentity(); await f.client.plans();
  assert.equal(f.client.snapshot().account, null); assert.equal(f.client.snapshot('plans').data, null);
});

test('plan CRUD and workout start preserve endpoint payloads; history cursor is opaque', async () => {
  const f = fixture((path, init, call) => {
    if (path.startsWith('/v1/history')) return response({ items: [], nextBefore: null });
    if (path === '/v1/workout-sessions') { assert.deepEqual(call.payload, { planId: 'plan1', expectedPlanRevision: 1 }); return response(session()); }
    if (path.endsWith('/archive')) { assert.deepEqual(call.payload, { expectedRevision: 1 }); return response({ ...plan, archived: true, revision: 2 }); }
    if (init.method === 'PATCH') { assert.deepEqual(call.payload, { name: 'Changed', expectedRevision: 1 }); return response({ ...plan, name: 'Changed', revision: 2 }); }
    if (init.method === 'POST') assert.deepEqual(call.payload, { name: plan.name, minutes: plan.minutes, items: plan.items });
    return response(init.method === 'GET' && path === '/v1/plans' ? { items: [plan] } : plan);
  });
  await f.client.bindIdentity();
  await f.client.plans(); await f.client.plan('plan1');
  await f.client.createPlan({ name: plan.name, minutes: plan.minutes, items: plan.items }, 'create1');
  await f.client.editPlan(plan, { name: 'Changed' }); await f.client.archivePlan(plan, 'archive1');
  await f.client.startWorkout(plan, 'start1');
  assert.equal((await f.client.history({ before: 'opaque_cursor', limit: 50 })).status, 'empty');
  assert.ok(f.calls.some(x => x.path === '/v1/history?limit=50&before=opaque_cursor'));
  assert.throws(() => f.client.history({ limit: 51 }), /invalid_history_query/);
  assert.throws(() => f.client.workout('../account'), /invalid_id/);
});

test('keyed create lost after commit retries exactly and refuses changed payload even after success', async () => {
  let writes = 0;
  const payloads = [];
  const f = fixture((path, init, call) => {
    payloads.push({ key: init.headers['Idempotency-Key'], payload: call.payload });
    if (++writes === 1) throw new Error('committed but response lost');
    return response(plan, 201);
  });
  await f.client.bindIdentity();
  const fields = { name: plan.name, minutes: plan.minutes, items: plan.items };
  assert.equal((await f.client.createPlan(fields, 'planKey')).status, 'unknown');
  assert.equal((await f.client.createPlan(fields, 'planKey')).status, 'ready');
  assert.deepEqual(payloads[0], payloads[1]);
  assert.throws(() => f.client.createPlan({ ...fields, name: 'Different' }, 'planKey'), /key_payload_conflict/);
});

test('preference reconciliation reports another confirmed revision instead of silently rebasing', async () => {
  let writes = 0;
  const f = fixture((path, init) => {
    if (init.method === 'PATCH') { writes++; throw new Error('lost'); }
    return response({ ...preferences(2), mascot: 'buff' });
  });
  await f.client.bindIdentity();
  await f.client.savePreferences(preferences(1), { mascot: 'baby' });
  const reconciled = await f.client.reconcilePreferences();
  assert.equal(reconciled.status, 'conflict'); assert.equal(reconciled.data.mascot, 'buff'); assert.equal(writes, 1);
});

test('invalidation cancels queued intents logically and fences an in-flight write result', async () => {
  const gate = deferred(), entered = deferred(); let writes = 0;
  const f = fixture(() => { writes++; entered.resolve(); return gate.promise; });
  await f.client.bindIdentity();
  const first = f.client.savePreferences(preferences(), { mascot: 'baby' }, 'first');
  await entered.promise;
  const queued = f.client.createPlan({ name: plan.name, minutes: plan.minutes, items: plan.items }, 'queued');
  f.client.invalidate();
  assert.deepEqual(f.client.snapshot().resources, {});
  gate.resolve(response({ ...preferences(1), mascot: 'baby' }));
  await first; await queued;
  assert.equal(writes, 1); assert.equal(f.client.snapshot().account, null); assert.deepEqual(f.client.snapshot().resources, {});
});

test('stats/exercise reads remain detached, fenced and explicitly empty or stale on failure', async () => {
  let broken = false;
  const totals = { confirmedSets: 0, repetitions: 0, volumeKg: 0, completedSessions: 0, byExercise: [], units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true };
  const f = fixture(path => {
    if (broken) throw new Error('offline');
    return response(path === '/v1/stats' ? totals : { items: [] });
  });
  await f.client.bindIdentity();
  const stats = await f.client.stats(); assert.equal(stats.status, 'ready'); assert.ok(Object.isFrozen(stats.data.units));
  assert.equal((await f.client.exercises()).status, 'empty');
  totals.units.load = 'lb'; assert.equal(stats.data.units.load, 'kg');
  broken = true;
  const stale = await f.client.stats(); assert.equal(stale.status, 'stale'); assert.equal(stale.data, stats.data);
});
