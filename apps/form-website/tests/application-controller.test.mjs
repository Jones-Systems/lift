import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationController, createSyntheticApplicationController, createConfiguredApplicationController } from '../public/application-controller.mjs';

// In-memory .invalid fixtures prove composition only, never authenticated runtime behavior.
const origin = 'https://web.invalid';
const config = { apiBase: 'https://api.invalid', verifiedBrowserOrigin: origin, trackingEnabled: false };
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const date = '2026-10-09T00:00:00.000Z';
const preferences = (changes = {}) => ({ revision: 1, appMode: 'advanced', mascot: 'buff', animationStyle: 'long', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [], remindersEnabled: false, ...changes });
const me = id => ({ accountId: id, appAccountToken: id, profile: { revision: 0, name: 'Synthetic' }, preferences: { revision: 0 }, onboarding: { revision: 0, status: 'draft' } });
const grants = id => ({ accountId: id, appAccountToken: id, grants: [], active: [], purchases: { status: 'unconfigured', environment: 'Sandbox', chargesEnabled: false, verification: 'apple_jws_offline', onlineCertificateRevocation: false } });
const item = { id: 'item1', exerciseId: 'squat', setTarget: 3, repMin: 5, repMax: 8, targetKg: 20 };
const plan = { id: 'plan1', revision: 1, name: 'Synthetic plan', minutes: 30, items: [item], archived: false, createdAt: date, updatedAt: date };
const performed = { id: 'set1', occurrenceId: 'occ1', setNumber: 1, revision: 1, reps: 5, weightKg: 10, status: 'confirmed', createdAt: date, updatedAt: date };
const session = (changes = {}) => ({ id: 'session1', planId: plan.id, planRevision: 1, revision: 2, status: 'active', planSnapshot: plan, occurrences: [{ id: 'occ1', itemId: item.id, exerciseId: item.exerciseId, position: 0, target: item }], sets: [performed], startedAt: date, completedAt: null, ...changes });
const response = (data, status = 200) => ({ status, json: async () => structuredClone(data) });
const profile = (changes = {}) => ({ revision: 0, name: '  Stored profile name  ', age: null, heightCm: null, weightKg: null,
  trainingBackground: null, injuryHistory: '', goals: [], ...changes });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(handler = () => response({ items: [] })) {
  const calls = []; let identity = accountId;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    const call = { path, ...init, payload: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    assert.equal(init.headers.Authorization, undefined);
    if (path === '/v1/me') return response(me(identity));
    if (path === '/v1/entitlements') return response(grants(identity));
    return handler(call);
  };
  return { controller: createSyntheticApplicationController({ config, browserOrigin: origin, fetchImpl }), calls, switchTo: id => { identity = id; } };
}

test('configured controller requires the explicit session binding and stays idle until an operation', () => {
  let calls = 0;
  assert.throws(() => createConfiguredApplicationController({ config, browserOrigin: origin }), /configured_session_options_required/);
  const controller = createConfiguredApplicationController({ config, browserOrigin: origin,
    fetchImpl() { calls++; }, sessionDispatch: { run: operation => Promise.resolve().then(operation) } });
  assert.equal(controller.snapshot().status, 'empty'); assert.equal(controller.snapshot().account, null);
  assert.equal(controller.selectView('workout').selectedView, 'workout');
  controller.invalidate();
  assert.equal(controller.snapshot().selectedView, 'plans'); assert.equal(calls, 0);
});

test('production remains unavailable with zero requests despite activation or client injection', async () => {
  let calls = 0;
  const controller = createApplicationController({ config, browserOrigin: origin, activate: true, enabled: true, synthetic: true,
    client: { bindIdentity() { calls++; } }, fetchImpl() { calls++; } });
  await controller.bindIdentity(); await controller.preferences(); await controller.plans();
  await controller.profile(); await controller.saveProfile(profile(), { name: 'Changed' }); await controller.reconcileProfile();
  await controller.createPlan({ name: plan.name, minutes: plan.minutes, items: plan.items }, 'plan1');
  assert.equal(calls, 0);
  const state = controller.selectView('preferences');
  assert.equal(state.status, 'unavailable'); assert.equal(state.selectedView, 'preferences');
  assert.equal(state.presentation, null); assert.equal(state.account, null);
  assert.deepEqual(state.resources, {});
  assert.equal(Object.isFrozen(controller), true);
});

test('synthetic controller preserves the isolated transport gate', () => {
  assert.throws(() => createSyntheticApplicationController(), /synthetic_transport_required/);
  assert.throws(() => createSyntheticApplicationController({ config, browserOrigin: origin, fetchImpl: globalThis.fetch }), /synthetic_transport_required/);
  assert.throws(() => createSyntheticApplicationController({ config: { ...config, apiBase: 'https://api.example' }, browserOrigin: origin, fetchImpl() {} }), /synthetic_transport_required/);
});

test('navigation is ephemeral and cannot load data or imply account identity', async () => {
  const f = fixture();
  for (const view of ['workout', 'history', 'preferences', 'plans']) {
    assert.equal(f.controller.selectView(view).selectedView, view);
    assert.equal(f.controller.snapshot().account, null);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.controller.selectView('billing'), TypeError);
  assert.equal((await f.controller.preferences()).error.code, 'identity_required');
  assert.equal(f.controller.snapshot().presentation.status, 'error');
  assert.equal(f.calls.length, 0);
  f.controller.selectView('workout');
  await f.controller.bindIdentity();
  assert.equal(f.controller.snapshot().selectedView, 'plans');
  assert.equal(f.controller.snapshot().account.accountId, accountId);
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/me', '/v1/entitlements', '/v1/me']);
});

test('server preferences remain intact while motion and asset state affect only projection', async () => {
  const f = fixture(() => response(preferences()));
  await f.controller.bindIdentity(); await f.controller.preferences();
  const visible = f.controller.snapshot({ assetReady: true });
  assert.equal(visible.presentation.status, 'ready');
  assert.equal(visible.presentation.data.appMode, 'advanced');
  assert.equal(visible.presentation.data.mascot, 'buff');
  assert.equal(visible.presentation.data.animationStyle, 'long');
  const reduced = f.controller.snapshot({ assetReady: true, reduceMotion: true });
  assert.equal(reduced.presentation.data.animationStyle, 'static');
  assert.equal(reduced.resources.preferences.data.animationStyle, 'long');
  assert.equal(f.controller.snapshot().presentation.data.mascotVisible, false);
  assert.throws(() => { reduced.resources.preferences.data.mascot = 'none'; }, TypeError);
  assert.throws(() => f.controller.snapshot({ reduceMotion: 'false' }), TypeError);
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});

test('workout targets and loaded history remain separate from performed and all-time claims', async () => {
  const f = fixture(call => response(call.path.startsWith('/v1/history')
    ? { items: [session()], nextBefore: null } : session()));
  await f.controller.bindIdentity();
  await f.controller.workout('session1'); await f.controller.history({ before: 'cursor1', limit: 5 });
  const state = f.controller.snapshot();
  const workout = state.workoutSummaries['workout:session1'];
  assert.equal(workout.status, 'ready');
  assert.deepEqual(workout.data.performed, { confirmedSets: 1, repetitions: 5, volumeKg: 50 });
  assert.equal(workout.data.occurrences[0].target.targetKg, 20);
  const history = state.historyWindows['history:cursor1:5'];
  assert.equal(history.status, 'ready'); assert.equal(history.data.loadedCount, 1);
  assert.equal(history.data.coverage.scope, 'loaded-window');
  assert.equal(history.data.coverage.allHistory, false); assert.equal(history.data.coverage.weekComplete, false);
  assert.equal(history.data.coverage.newerCoverage, 'unknown');
  assert.equal(Object.isFrozen(state.workoutSummaries), true);
  assert.equal(state.resources['workout:session1'].data.sets[0].weightKg, 10);
});

test('conflicts and invalid arguments retain their original failure and never report saved preferences', async () => {
  const f = fixture(call => call.method === 'GET' ? response(preferences()) : response({}, 409));
  await f.controller.bindIdentity(); await f.controller.preferences();
  const result = await f.controller.savePreferences(preferences(), { mascot: 'none' });
  assert.equal(result.status, 'conflict');
  const projection = f.controller.snapshot().presentation;
  assert.equal(projection.status, 'conflict');
  assert.deepEqual(projection.error, { code: 'conflict', status: 409, effect: 'none' });
  assert.equal(projection.data.mascot, 'buff');
  assert.throws(() => f.controller.savePreferences(preferences(), { mascot: 'default' }), /invalid_preferences/);
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 1);
});

test('a failed refresh exposes stale confirmed facts with the transport error', async () => {
  let reads = 0;
  const f = fixture(() => {
    if (++reads === 1) return response(preferences());
    throw new Error('disconnected');
  });
  await f.controller.bindIdentity(); await f.controller.preferences();
  await f.controller.preferences();
  const state = f.controller.snapshot().presentation;
  assert.equal(state.status, 'stale'); assert.equal(state.data.mascot, 'buff');
  assert.deepEqual(state.error, { code: 'transport_failed', status: null, effect: 'none' });
  assert.equal(reads, 2);
});

test('a set receipt does not invent a full updated session or performed summary', async () => {
  const initial = session({ revision: 1, sets: [] });
  const f = fixture(call => {
    if (call.path === '/v1/workout-sessions') return response(initial);
    assert.equal(call.path, '/v1/workout-sessions/session1/sets');
    assert.deepEqual(call.payload, { occurrenceId: 'occ1', setNumber: 1, reps: 5, weightKg: 10, status: 'confirmed', expectedRevision: 1 });
    return response({ set: performed, sessionRevision: 2 });
  });
  await f.controller.bindIdentity();
  const started = await f.controller.startWorkout(plan, 'start1');
  const result = await f.controller.addSet(started.data,
    { occurrenceId: 'occ1', setNumber: 1, reps: 5, weightKg: 10, status: 'confirmed' }, 'set1');
  assert.equal(result.status, 'ready'); assert.equal(result.data.sessionRevision, 2);
  const state = f.controller.snapshot();
  assert.equal(state.resources['sets:session1'].data.set.reps, 5);
  assert.equal(state.workoutSummaries['workout:start'].status, 'stale');
  assert.equal(state.workoutSummaries['workout:start'].data.performed.confirmedSets, 0);
  assert.equal(state.workoutSummaries['workout:session1'], undefined);
});

test('unknown writes keep prior facts and pending intent until explicit reconciliation, without retry', async () => {
  let saved = preferences();
  const f = fixture(call => {
    if (call.method === 'GET') return response(saved);
    saved = preferences({ revision: 2, mascot: 'none' });
    throw new Error('response lost after commit');
  });
  await f.controller.bindIdentity(); await f.controller.preferences();
  assert.equal((await f.controller.savePreferences(preferences(), { mascot: 'none' })).status, 'unknown');
  const unknown = f.controller.snapshot().presentation;
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.error.effect, 'unknown');
  assert.equal(unknown.data.mascot, 'buff');
  assert.deepEqual(unknown.pending.body, { mascot: 'none', expectedRevision: 1 });
  await f.controller.createPlan({ name: plan.name, minutes: plan.minutes, items: plan.items }, 'other');
  assert.equal(f.controller.snapshot().resources['plans:create'].status, 'unknown');
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 1);
  await f.controller.reconcilePreferences();
  assert.equal(f.controller.snapshot().presentation.status, 'ready');
  assert.equal(f.controller.snapshot().presentation.data.mascot, 'none');
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 1);
});

test('clear is synchronous and a late read cannot revive account facts or navigation', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(() => { entered.resolve(); return gate.promise; });
  await f.controller.bindIdentity(); f.controller.selectView('preferences');
  const pending = f.controller.preferences(); await entered.promise;
  const cleared = f.controller.clear();
  assert.equal(cleared.account, null); assert.equal(cleared.presentation, null);
  assert.equal(cleared.selectedView, 'plans'); assert.deepEqual(cleared.resources, {});
  gate.resolve(response(preferences())); await pending;
  assert.deepEqual(f.controller.snapshot(), cleared);
});

test('invalidation retains the physical write barrier before binding a different account', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => {
    assert.equal(call.method, 'PATCH'); entered.resolve(); return gate.promise;
  });
  await f.controller.bindIdentity();
  const write = f.controller.savePreferences(preferences(), { mascot: 'none' }); await entered.promise;
  const cleared = f.controller.invalidate();
  assert.equal(cleared.account, null); assert.equal(cleared.presentation, null);
  f.switchTo(otherId);
  const callCount = f.calls.length;
  const binding = f.controller.bindIdentity();
  await Promise.resolve();
  assert.equal(f.calls.length, callCount);
  gate.resolve(response(preferences({ revision: 2, mascot: 'none' })));
  await write; await binding;
  const next = f.controller.snapshot();
  assert.equal(next.account.accountId, otherId); assert.equal(next.presentation, null);
  assert.deepEqual(next.resources, {});
});

test('automatic identity loss removes projections without requiring renderer cleanup', async () => {
  const f = fixture(() => response(preferences()));
  await f.controller.bindIdentity(); await f.controller.preferences();
  f.switchTo(otherId);
  await f.controller.preferences();
  const state = f.controller.snapshot();
  assert.equal(state.account, null); assert.equal(state.entitlements, null);
  assert.equal(state.presentation, null); assert.deepEqual(state.workoutSummaries, {});
  assert.deepEqual(state.historyWindows, {});
});

test('profile passes through as one qualified resource without rewriting account or presentation state', async () => {
  let saved = profile();
  const f = fixture(call => {
    assert.equal(call.path, '/v1/me/profile');
    if (call.method === 'PATCH') { saved = profile({ revision: 1, name: 'Changed' }); throw new Error('lost response'); }
    return response(saved);
  });
  await f.controller.bindIdentity(); f.controller.selectView('preferences'); await f.controller.profile();
  const before = f.controller.snapshot();
  assert.equal(before.resources.profile.data.name, profile().name); assert.equal(before.presentation, null);
  assert.equal(Object.hasOwn(before.resources.profile.data, 'trainingContext'), false);
  await f.controller.saveProfile(before.resources.profile.data, { name: ' Changed ' });
  const held = f.controller.snapshot();
  assert.equal(held.resources.profile.status, 'unknown'); assert.equal(held.resources.profile.error.effect, 'unknown');
  assert.equal(held.resources.profile.data.name, profile().name);
  assert.deepEqual(held.resources.profile.pending.body, { name: 'Changed', expectedRevision: 0 });
  assert.equal(held.account.name, 'Synthetic'); assert.equal(held.presentation, null); assert.deepEqual(held.workoutSummaries, {});
  await f.controller.profile(); assert.equal(f.controller.snapshot().resources.profile.status, 'unknown');
  await f.controller.reconcileProfile(); assert.equal(f.controller.snapshot().resources.profile.status, 'ready');
  assert.equal(f.controller.snapshot().resources.profile.data.name, 'Changed');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  f.controller.clear(); assert.deepEqual(f.controller.snapshot().resources, {});
  assert.equal(before.resources.profile.data.name, profile().name);
});
