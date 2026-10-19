import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationLifecycle } from '../public/application-lifecycle.mjs';
import { createConfiguredBrowserSession } from '../public/browser-session.mjs';

// Synchronous injected targets make listener failures and late completions deterministic without timers.
class Target {
  listeners = new Map();
  added = [];
  removed = [];
  failAdd = null;
  failRemove = null;
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler); this.added.push({ type, handler });
    if (this.failAdd === type) throw new Error(`add:${type}`);
  }
  removeEventListener(type, handler) {
    this.removed.push({ type, handler });
    if (this.failRemove === type) throw new Error(`remove:${type}`);
    this.listeners.get(type)?.delete(handler);
  }
  emit(type) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler({ type }); }
  count() { return [...this.listeners.values()].reduce((total, handlers) => total + handlers.size, 0); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture({ methods = {}, visibility = 'visible', onSnapshot, onSuspend } = {}) {
  const pageTarget = new Target(), visibilityTarget = new Target(), snapshots = [], suspensions = [], calls = [];
  let view = 'plans', value = 'initial';
  const session = {
    snapshot: () => Object.freeze({ view, value }),
    selectView(next) { if (!['plans', 'workout', 'history', 'preferences'].includes(next)) throw new Error('invalid_view'); calls.push('selectView'); view = next; return this.snapshot(); },
    preferences() { calls.push('preferences'); value = 'loaded'; return Promise.resolve({ resource: true }); },
    refresh() { calls.push('refresh'); return Promise.resolve(this.snapshot()); },
    clear() { calls.push('clear'); value = null; return this.snapshot(); },
    invalidate() { calls.push('invalidate'); value = null; return this.snapshot(); },
    signout() { calls.push('signout'); value = null; return Promise.resolve(this.snapshot()); },
    ...methods,
  };
  const inputs = { session, pageTarget, visibilityTarget, readVisibility: () => visibility,
    onSnapshot(snapshot) { snapshots.push(snapshot); onSnapshot?.(snapshot); },
    onSuspend(status) { suspensions.push(status); onSuspend?.(status); } };
  const lifecycle = createApplicationLifecycle(inputs);
  return { lifecycle, inputs, pageTarget, visibilityTarget, session, snapshots, suspensions, calls,
    visibility: value => { visibility = value; }, value: next => { value = next; } };
}

test('attachment owns only three listeners and performs no operation or initial publication', () => {
  const f = fixture();
  assert.deepEqual(f.pageTarget.added.map(item => item.type), ['pagehide', 'pageshow']);
  assert.deepEqual(f.visibilityTarget.added.map(item => item.type), ['visibilitychange']);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.snapshots, []);
  assert.equal(f.lifecycle.status().state, 'active'); assert.equal(Object.isFrozen(f.lifecycle.status()), true);
  f.lifecycle.dispose();
});

test('explicit operation publishes current state before, during, and after settlement, never its returned data', async () => {
  const gate = deferred();
  const f = fixture({ methods: { preferences() { f.calls.push('preferences'); f.value('loading'); return gate.promise; } } });
  const pending = f.lifecycle.execute('preferences');
  assert.deepEqual(f.snapshots.map(value => value.value), ['initial', 'loading']);
  f.value('confirmed'); const oldReturn = { value: 'obsolete-result' }; gate.resolve(oldReturn);
  assert.equal(await pending, oldReturn);
  assert.deepEqual(f.snapshots.map(value => value.value), ['initial', 'loading', 'confirmed']);
  assert.ok(f.snapshots.every(value => value !== oldReturn));
  assert.deepEqual(f.calls, ['preferences']); f.lifecycle.dispose();
});

test('navigation fences earlier callbacks while later explicit publication reads current session facts', async () => {
  const gate = deferred();
  const f = fixture({ methods: { preferences: () => gate.promise } });
  const pending = f.lifecycle.execute('preferences');
  f.lifecycle.selectView('history');
  const count = f.snapshots.length;
  f.value('late-fact'); gate.resolve({ stale: true }); await pending;
  assert.equal(f.snapshots.length, count); assert.equal(f.snapshots.at(-1).view, 'history');
  f.lifecycle.resume();
  assert.deepEqual(f.snapshots.at(-1), { view: 'history', value: 'late-fact' });
  assert.deepEqual(f.calls, ['selectView']); f.lifecycle.dispose();
});

test('hidden and pagehide suspend once; pageshow and visibility alone never resume or refresh', () => {
  const f = fixture();
  f.visibility('hidden'); f.visibilityTarget.emit('visibilitychange');
  f.visibilityTarget.emit('visibilitychange'); f.pageTarget.emit('pagehide');
  assert.equal(f.suspensions.length, 1); assert.equal(f.lifecycle.status().state, 'suspended');
  assert.throws(() => f.lifecycle.execute('preferences'), /lifecycle_suspended/);
  assert.throws(() => f.lifecycle.resume(), /page_not_visible/);
  f.visibility('visible'); f.visibilityTarget.emit('visibilitychange');
  assert.throws(() => f.lifecycle.resume(), /page_not_visible/);
  f.pageTarget.emit('pageshow');
  assert.equal(f.lifecycle.status().state, 'suspended'); assert.deepEqual(f.snapshots, []);
  f.lifecycle.resume();
  assert.equal(f.lifecycle.status().state, 'active'); assert.equal(f.snapshots.length, 1);
  assert.deepEqual(f.calls, []); f.lifecycle.dispose();
});

test('initial hidden attachment clears the renderer through callback without touching session state', () => {
  const f = fixture({ visibility: 'hidden' });
  assert.equal(f.suspensions.length, 1); assert.equal(f.suspensions[0].reason, 'hidden');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.session.snapshot(), { view: 'plans', value: 'initial' });
  f.lifecycle.dispose();
});

test('resume never revives an older pending callback generation', async () => {
  const gate = deferred();
  const f = fixture({ methods: { preferences: () => gate.promise } });
  const pending = f.lifecycle.execute('preferences');
  f.pageTarget.emit('pagehide'); f.pageTarget.emit('pageshow'); f.lifecycle.resume();
  const count = f.snapshots.length;
  gate.resolve('done'); await pending;
  assert.equal(f.snapshots.length, count); assert.deepEqual(f.calls, []);
  f.lifecycle.dispose();
});

test('disposal preserves foreign listeners, retires callbacks, and never clears or signs out the session', async () => {
  const gate = deferred(), error = new Error('late failure');
  const f = fixture({ methods: { preferences: () => gate.promise } });
  let foreignCalls = 0;
  const foreign = () => { foreignCalls++; }; f.pageTarget.addEventListener('pagehide', foreign);
  const pending = f.lifecycle.execute('preferences');
  const failure = assert.rejects(pending, value => value === error);
  const retired = f.lifecycle.dispose(), snapshotCount = f.snapshots.length;
  assert.equal(retired.state, 'disposed'); assert.equal(f.suspensions.at(-1).reason, 'disposed');
  assert.equal(f.pageTarget.count(), 1); assert.equal(f.visibilityTarget.count(), 0);
  assert.deepEqual(f.pageTarget.removed.map(item => item.type), ['pagehide', 'pageshow']);
  assert.ok(f.pageTarget.removed.every(item => item.handler !== foreign));
  assert.deepEqual(f.lifecycle.dispose(), retired); assert.equal(f.suspensions.length, 1);
  assert.throws(() => f.lifecycle.execute('preferences'), /lifecycle_disposed/);
  assert.throws(() => f.lifecycle.resume(), /lifecycle_disposed/);
  assert.throws(() => f.lifecycle.selectView('plans'), /lifecycle_disposed/);
  gate.reject(error); await failure;
  f.pageTarget.emit('pagehide'); assert.equal(foreignCalls, 1);
  assert.equal(f.snapshots.length, snapshotCount); assert.deepEqual(f.calls, []);
  f.pageTarget.removeEventListener('pagehide', foreign);
});

test('synchronous and asynchronous operation failures remain the original errors', async () => {
  const syncError = new Error('invalid_fields'), asyncError = new Error('transport_failed');
  const f = fixture({ methods: { preferences() { throw syncError; }, plans: () => Promise.reject(asyncError) } });
  assert.throws(() => f.lifecycle.execute('preferences'), error => error === syncError);
  await assert.rejects(f.lifecycle.execute('plans'), error => error === asyncError);
  assert.throws(() => f.lifecycle.execute('snapshot'), /unknown_lifecycle_operation/);
  assert.throws(() => f.lifecycle.execute('constructor'), /unknown_lifecycle_operation/);
  f.lifecycle.dispose();
});

test('a callback that suspends the adapter before dispatch prevents the operation', () => {
  let f;
  f = fixture({ onSnapshot() { f.pageTarget.emit('pagehide'); } });
  assert.throws(() => f.lifecycle.execute('preferences'), /lifecycle_changed/);
  assert.deepEqual(f.calls, []); assert.equal(f.lifecycle.status().state, 'suspended');
  f.lifecycle.dispose();
});

test('one adapter owns a session until disposal, after which a new owner can attach', () => {
  const f = fixture();
  const pageTarget = new Target(), visibilityTarget = new Target();
  assert.throws(() => createApplicationLifecycle({ ...f.inputs, pageTarget, visibilityTarget }), /session_already_owned/);
  assert.equal(pageTarget.count(), 0); assert.equal(visibilityTarget.count(), 0);
  f.lifecycle.dispose();
  const next = createApplicationLifecycle({ ...f.inputs, pageTarget, visibilityTarget });
  next.dispose(); assert.deepEqual(f.calls, []);
});

test('registration failure removes every attempted owned listener, including one installed before the throw', () => {
  const f = fixture(); f.lifecycle.dispose();
  const pageTarget = new Target(), visibilityTarget = new Target();
  visibilityTarget.failAdd = 'visibilitychange';
  assert.throws(() => createApplicationLifecycle({ ...f.inputs, pageTarget, visibilityTarget }), /add:visibilitychange/);
  assert.equal(pageTarget.count(), 0); assert.equal(visibilityTarget.count(), 0);
  assert.equal(pageTarget.removed.length, 2); assert.equal(visibilityTarget.removed.length, 1);
  visibilityTarget.failAdd = null;
  createApplicationLifecycle({ ...f.inputs, pageTarget, visibilityTarget }).dispose();
});

test('removal failure retires delivery, reports the error, and retries only failed removals on disposal', () => {
  const f = fixture(); f.pageTarget.failRemove = 'pagehide';
  assert.throws(() => f.lifecycle.dispose(), error => error instanceof AggregateError && error.errors[0].message === 'remove:pagehide');
  assert.equal(f.lifecycle.status().state, 'disposed'); assert.equal(f.visibilityTarget.count(), 0);
  const notices = f.suspensions.length;
  f.pageTarget.emit('pagehide'); assert.equal(f.suspensions.length, notices);
  f.pageTarget.failRemove = null; f.lifecycle.dispose();
  assert.deepEqual(f.pageTarget.removed.map(item => item.type), ['pagehide', 'pageshow', 'pagehide']);
  assert.equal(f.pageTarget.count(), 0); assert.equal(f.suspensions.length, notices);
});

test('invalid visibility fails before attachment or suspends later admission without requests', () => {
  assert.throws(() => createApplicationLifecycle(), /application_lifecycle_inputs_required/);
  const f = fixture(); f.lifecycle.dispose();
  const pageTarget = new Target();
  assert.throws(() => createApplicationLifecycle({ ...f.inputs, pageTarget, readVisibility: () => 'prerender' }), /visibility_must_be_visible_or_hidden/);
  assert.equal(pageTarget.count(), 0);
  const next = fixture(); next.visibility('invalid');
  assert.throws(() => next.lifecycle.execute('preferences'), /visibility_must_be_visible_or_hidden/);
  assert.equal(next.lifecycle.status().state, 'suspended'); assert.deepEqual(next.calls, []);
  next.lifecycle.dispose();
});

test('notification failure after dispatch does not retry or hide an operation rejection', async () => {
  const gate = deferred(), operationError = new Error('operation failed'), observerError = new Error('observer failed');
  let notifications = 0, calls = 0;
  const f = fixture({ methods: { preferences() { calls++; return gate.promise; } },
    onSnapshot() { if (++notifications === 2) throw observerError; } });
  const pending = f.lifecycle.execute('preferences');
  const rejection = assert.rejects(pending, error => error instanceof AggregateError && error.errors[0] === operationError && error.errors[1] === observerError);
  gate.reject(operationError); await rejection;
  assert.equal(calls, 1); f.lifecycle.dispose();
});

test('explicit clear delegates once and fences older completion notifications', async () => {
  const gate = deferred();
  const f = fixture({ methods: { preferences: () => gate.promise } });
  const pending = f.lifecycle.execute('preferences');
  f.lifecycle.execute('clear'); const count = f.snapshots.length;
  gate.resolve('late'); await pending;
  assert.deepEqual(f.calls, ['clear']); assert.equal(f.snapshots.length, count);
  assert.equal(f.snapshots.at(-1).value, null); f.lifecycle.dispose();
});

test('real session unknown intent survives background and disposal and remains explicitly reconcilable', async () => {
  const origin = 'https://web.invalid', id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let preferences = { revision: 1, appMode: 'advanced', mascot: 'buff', animationStyle: 'long', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [], remindersEnabled: false };
  const calls = [], snapshots = [];
  const response = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
  const session = createConfiguredBrowserSession({ config: { apiBase: 'https://api.invalid', verifiedBrowserOrigin: origin, trackingEnabled: false }, browserOrigin: origin,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname; calls.push({ path, method: init.method });
      if (path === '/v1/capabilities') return response({ authentication: { emailPassword: { status: 'configured_unverified', registration: 'closed', passwordRecovery: 'unconfigured', emailChange: 'unconfigured' }, session: { transport: 'signed_bearer_or_cookie', expiresInSeconds: 604800 } } });
      if (path === '/v1/me') return response({ accountId: id, appAccountToken: id, profile: { revision: 0, name: 'Synthetic' }, preferences: { revision: 1 }, onboarding: { revision: 0, status: 'draft' } });
      if (path === '/v1/entitlements') return response({ accountId: id, appAccountToken: id, grants: [], active: [], purchases: { status: 'unconfigured', environment: 'Sandbox', chargesEnabled: false, verification: 'apple_jws_offline', onlineCertificateRevocation: false } });
      assert.equal(path, '/v1/me/preferences');
      if (init.method === 'GET') return response(preferences);
      preferences = { ...preferences, revision: 2, mascot: 'none' }; throw new Error('lost after commit');
    } });
  const pageTarget = new Target(), visibilityTarget = new Target(); let visibility = 'visible';
  const inputs = { session, pageTarget, visibilityTarget, readVisibility: () => visibility, onSnapshot: value => snapshots.push(value), onSuspend() {} };
  const lifecycle = createApplicationLifecycle(inputs);
  assert.equal(calls.length, 0);
  await lifecycle.execute('refresh'); await lifecycle.execute('preferences');
  await lifecycle.execute('savePreferences', preferences, { mascot: 'none' });
  const unknown = session.snapshot().application.resources.preferences;
  assert.equal(unknown.status, 'unknown');
  const count = calls.length;
  visibility = 'hidden'; visibilityTarget.emit('visibilitychange');
  visibility = 'visible'; visibilityTarget.emit('visibilitychange'); lifecycle.resume(); lifecycle.dispose();
  assert.equal(calls.length, count);
  assert.deepEqual(session.snapshot().application.resources.preferences, unknown);
  const next = createApplicationLifecycle(inputs); next.resume();
  assert.equal(snapshots.at(-1).application.presentation.status, 'unknown');
  await next.execute('reconcilePreferences');
  assert.equal(session.snapshot().application.presentation.status, 'ready');
  assert.equal(session.snapshot().application.presentation.data.mascot, 'none');
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
  next.dispose();
});

test('profile lifecycle dispatch preserves supplied arguments and rejects absent or retired operations', async () => {
  const f = fixture();
  assert.throws(() => f.lifecycle.execute('profile'), /unknown_lifecycle_operation/); f.lifecycle.dispose();
  const error = new Error('invalid_profile'), received = [];
  const next = fixture({ methods: {
    profile() { received.push(['profile']); return Promise.resolve('read return'); },
    saveProfile(...args) { received.push(['saveProfile', ...args]); throw error; },
    reconcileProfile() { received.push(['reconcileProfile']); return Promise.resolve('reconcile return'); },
  } });
  const current = { revision: 0 }, changes = { age: null };
  await next.lifecycle.execute('profile');
  assert.throws(() => next.lifecycle.execute('saveProfile', current, changes), value => value === error);
  await next.lifecycle.execute('reconcileProfile');
  assert.deepEqual(received, [['profile'], ['saveProfile', current, changes], ['reconcileProfile']]);
  assert.ok(next.snapshots.every(value => value.value === 'initial'));
  next.pageTarget.emit('pagehide'); assert.throws(() => next.lifecycle.execute('profile'), /lifecycle_suspended/);
  next.lifecycle.dispose(); assert.throws(() => next.lifecycle.execute('reconcileProfile'), /lifecycle_disposed/);
  assert.equal(received.length, 3);
});

test('real profile uncertainty survives late suspended settlement and disposal until explicit reconciliation', async () => {
  const origin = 'https://web.invalid', id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let profile = { revision: 0, name: 'Stored name', age: null, heightCm: null, weightKg: null, trainingBackground: null, injuryHistory: '', goals: [] };
  const gate = deferred(), entered = deferred(), calls = [], snapshots = [];
  const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => structuredClone(data) });
  const session = createConfiguredBrowserSession({ config: { apiBase: 'https://api.invalid', verifiedBrowserOrigin: origin, trackingEnabled: false }, browserOrigin: origin,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname; calls.push({ path, method: init.method });
      if (path === '/v1/capabilities') return response({ authentication: { emailPassword: { status: 'configured_unverified', registration: 'closed', passwordRecovery: 'unconfigured', emailChange: 'unconfigured' }, session: { transport: 'signed_bearer_or_cookie', expiresInSeconds: 604800 } } });
      if (path === '/v1/me') return response({ accountId: id, appAccountToken: id, profile: { revision: profile.revision, name: profile.name }, preferences: { revision: 1 }, onboarding: { revision: 0, status: 'draft' } });
      if (path === '/v1/entitlements') return response({ accountId: id, appAccountToken: id, grants: [], active: [], purchases: { status: 'unconfigured', environment: 'Sandbox', chargesEnabled: false, verification: 'apple_jws_offline', onlineCertificateRevocation: false } });
      assert.equal(path, '/v1/me/profile');
      if (init.method === 'GET') return response(profile);
      assert.deepEqual(JSON.parse(init.body), { expectedRevision: 0, trainingContext: 'Own context' });
      profile = { ...profile, revision: 1, trainingContext: 'Own context' }; entered.resolve(); return gate.promise;
    } });
  const pageTarget = new Target(), visibilityTarget = new Target();
  const inputs = { session, pageTarget, visibilityTarget, readVisibility: () => 'visible', onSnapshot: value => snapshots.push(value), onSuspend() {} };
  const lifecycle = createApplicationLifecycle(inputs);
  assert.throws(() => lifecycle.execute('profile'), /session_not_ready/); assert.equal(calls.length, 0);
  await lifecycle.execute('refresh'); await lifecycle.execute('profile');
  const writing = lifecycle.execute('saveProfile', profile, { trainingContext: '  Own context  ' }); await entered.promise;
  pageTarget.emit('pagehide'); const count = snapshots.length;
  gate.resolve(response({}, 503)); await writing;
  assert.equal(snapshots.length, count); assert.equal(session.snapshot().application.resources.profile.status, 'unknown');
  lifecycle.dispose(); const requests = calls.length;
  const next = createApplicationLifecycle(inputs); next.resume();
  assert.equal(calls.length, requests); assert.equal(snapshots.at(-1).application.resources.profile.status, 'unknown');
  await next.execute('profile'); assert.equal(snapshots.at(-1).application.resources.profile.status, 'unknown');
  await next.execute('reconcileProfile'); assert.equal(snapshots.at(-1).application.resources.profile.status, 'ready');
  assert.equal(snapshots.at(-1).application.resources.profile.data.trainingContext, 'Own context');
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
  next.dispose(); assert.equal(pageTarget.count(), 0); assert.equal(visibilityTarget.count(), 0);
});
