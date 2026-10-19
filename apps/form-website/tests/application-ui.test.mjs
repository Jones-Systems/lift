import test from 'node:test';
import assert from 'node:assert/strict';
import { mountApplication, renderApplication, createUnavailableApplicationSession } from '../public/application-ui.mjs';
import { createConfiguredBrowserSession } from '../public/browser-session.mjs';
import { applicationPages } from '../src/application-page.mjs';

class Target {
  listeners = new Map();
  innerHTML = '';
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  async emit(name, event = {}) { for (const handler of [...(this.listeners.get(name) ?? [])]) await handler(event); }
  contains(node) { return node.owner === this; }
  count() { return [...this.listeners.values()].reduce((count, set) => count + set.size, 0); }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const date = '2026-10-09T00:00:00.000Z';
const identity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const item = { id: 'item1', exerciseId: 'squat', setTarget: 3, repMin: 5, repMax: 8, targetKg: 20 };
const plan = { id: 'plan1', revision: 1, name: 'Fixture plan', minutes: 30, items: [item], archived: false, createdAt: date, updatedAt: date };
const preferences = () => ({ revision: 1, appMode: 'advanced', mascot: 'buff', animationStyle: 'long', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: ['dumbbells'], remindersEnabled: false });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });

// The real consumers use only this injected .invalid transport; the fixture performs no I/O.
function fixture(hook = () => undefined, afterSet = () => {}) {
  const calls = []; let signedIn = true, saved = preferences(), workout = null;
  const session = createConfiguredBrowserSession({ config: { apiBase: 'https://api.invalid', verifiedBrowserOrigin: 'https://web.invalid', trackingEnabled: false }, browserOrigin: 'https://web.invalid',
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, 'https://api.invalid');
      const call = { path: new URL(url).pathname, query: new URL(url).search, method: init.method, payload: init.body ? JSON.parse(init.body) : null, key: init.headers['Idempotency-Key'] };
      calls.push(call);
      const result = await hook(call);
      if (result !== undefined) return result;
      if (call.path === '/v1/capabilities') return response({ authentication: { emailPassword: { status: 'configured_unverified', registration: 'closed', passwordRecovery: 'unconfigured', emailChange: 'unconfigured' }, session: { transport: 'signed_bearer_or_cookie', expiresInSeconds: 604800 } } });
      if (call.path === '/v1/me') return response(signedIn ? { accountId: identity, appAccountToken: identity, profile: { revision: 0, name: 'Fixture member' }, preferences: { revision: saved.revision }, onboarding: { revision: 0, status: 'draft' } } : {}, signedIn ? 200 : 401);
      if (call.path === '/v1/entitlements') return response({ accountId: identity, appAccountToken: identity, grants: [], active: [], purchases: { status: 'unconfigured', environment: 'Sandbox', chargesEnabled: false, verification: 'apple_jws_offline', onlineCertificateRevocation: false } });
      if (call.path === '/api/auth/sign-out') { signedIn = false; return response({ success: true }); }
      if (call.path === '/v1/plans') return response({ items: [plan] });
      if (call.path === '/v1/plans/plan1') return response(plan);
      if (call.path === '/v1/exercises') return response({ items: [{ id: 'squat', name: 'Fixture squat', loadLabel: 'Load', retired: false, provenance: {}, requiredConstraints: [{ id: 'cue1', text: 'Fixture required guidance', required: true }], cues: [] }] });
      if (call.path === '/v1/workout-sessions') {
        assert.deepEqual(call.payload, { planId: 'plan1', expectedPlanRevision: 1 });
        workout = { id: 'session1', planId: 'plan1', planRevision: 1, revision: 1, status: 'active', planSnapshot: plan,
          occurrences: [{ id: 'occ1', itemId: 'item1', exerciseId: 'squat', position: 0, target: item }], sets: [], startedAt: date, completedAt: null };
        return response(workout);
      }
      if (call.path === '/v1/workout-sessions/session1') return response(workout);
      if (call.path === '/v1/workout-sessions/session1/complete') {
        assert.equal(call.payload.expectedRevision, workout.revision);
        workout.revision++; workout.status = 'completed'; workout.completedAt = date;
        return response(workout);
      }
      if (call.path.startsWith('/v1/workout-sessions/session1/sets')) {
        let set;
        if (call.path.endsWith('/sets')) {
          assert.equal(call.payload.expectedRevision, workout.revision);
          const { expectedRevision, ...fields } = call.payload;
          set = { ...fields, id: `set${workout.sets.length + 1}`, revision: 1, createdAt: date, updatedAt: date };
          workout.sets.push(set);
        } else {
          set = workout.sets.find(value => value.id === call.path.split('/')[5]);
          assert.equal(call.payload.expectedRevision, set.revision);
          const { expectedRevision, ...fields } = call.payload;
          Object.assign(set, fields, { revision: set.revision + 1 });
          if (call.path.endsWith('/void')) set.status = 'voided';
        }
        workout.revision++;
        const receipt = structuredClone({ set, sessionRevision: workout.revision });
        await afterSet(call, receipt);
        return response(receipt);
      }
      if (call.path === '/v1/history') return response(call.query.includes('before=') ? { items: [], nextBefore: null } : { items: workout ? [workout] : [], nextBefore: workout ? 'older' : null });
      if (call.path === '/v1/me/preferences') {
        if (call.method === 'PATCH') { const { expectedRevision, ...changes } = call.payload; assert.equal(expectedRevision, saved.revision); saved = { ...saved, ...changes, revision: saved.revision + 1 }; }
        return response(saved);
      }
      assert.fail(`Unexpected fixture request ${call.path}`);
    } });
  return { session, calls, saved: () => saved };
}

function mounted(session, options = {}) {
  const root = new Target(), page = new Target(), visibility = new Target(); let visible = 'visible', nextKey = 0;
  const ui = mountApplication({ root, session, pageTarget: page, visibilityTarget: visibility, readVisibility: () => visible, keyFactory: () => `operation-${++nextKey}`, ...options });
  return { ui, root, page, visibility, hide: async () => { visible = 'hidden'; await visibility.emit('visibilitychange'); }, show: async () => { visible = 'visible'; await visibility.emit('visibilitychange'); } };
}
async function start(f, m) {
  await m.ui.perform('refresh'); await m.ui.perform('plans'); await m.ui.perform('plan', { id: 'plan1' }); await m.ui.perform('start');
  assert.equal(f.session.snapshot().application.selectedView, 'workout');
}

function planFixture({ initial = [plan], before = () => undefined, after = () => {} } = {}) {
  const records = new Map(initial.map(value => [value.id, structuredClone(value)])), receipts = new Map(), effects = [];
  const associations = new Map(initial.flatMap(value => value.items.map(row => [`${value.id}:${row.id}`, row.exerciseId])));
  const catalog = ['squat', 'press', 'retired'].map(id => ({ id, name: `Catalog ${id}`, loadLabel: 'Load', retired: id === 'retired', provenance: {}, requiredConstraints: [], cues: [] }));
  let nextId = 0, started = null;
  const context = { records, receipts, effects, catalog };
  const f = fixture(async call => {
    const intercepted = await before(call, context);
    if (intercepted !== undefined) return intercepted;
    if (call.path === '/v1/exercises') return response({ items: catalog });
    if (call.path === '/v1/workout-sessions') {
      const source = records.get(call.payload.planId);
      assert.equal(call.payload.expectedPlanRevision, source.revision);
      assert.equal(source.archived, false);
      started = { id: 'manual-session', planId: source.id, planRevision: source.revision, revision: 1, status: 'active', planSnapshot: structuredClone(source),
        occurrences: source.items.map((target, position) => ({ id: `occ-${position}`, itemId: target.id, exerciseId: target.exerciseId, position, target: structuredClone(target) })), sets: [], startedAt: date, completedAt: null };
      return response(started);
    }
    if (call.path === '/v1/workout-sessions/manual-session') return response(started);
    if (!call.path.startsWith('/v1/plans')) return undefined;
    const id = call.path.split('/')[3];
    if (call.method === 'GET') return response(id ? records.get(id) : { items: [...records.values()] });
    const receiptId = `${call.path}:${call.key}`, previous = call.key && receipts.get(receiptId);
    if (previous) { assert.deepEqual(call.payload, previous.payload); return response(previous.result); }
    let result;
    if (!id) {
      assert.equal(call.method, 'POST'); assert.ok(call.key);
      result = { id: `created-${++nextId}`, ...structuredClone(call.payload), revision: 1, archived: false, createdAt: date, updatedAt: date };
    } else {
      const saved = records.get(id);
      if (call.payload.expectedRevision !== saved.revision || saved.archived) return response({}, 409);
      const { expectedRevision, ...changes } = call.payload;
      result = { ...saved, ...structuredClone(changes), revision: saved.revision + 1 };
      if (call.path.endsWith('/archive')) { assert.ok(call.key); result.archived = true; }
      else { assert.equal(call.method, 'PATCH'); assert.equal(call.key, undefined); }
    }
    for (const row of result.items) {
      assert.equal(catalog.find(exercise => exercise.id === row.exerciseId)?.retired, false);
      const binding = `${result.id}:${row.id}`;
      if (associations.has(binding)) assert.equal(associations.get(binding), row.exerciseId);
      associations.set(binding, row.exerciseId);
    }
    records.set(result.id, structuredClone(result)); effects.push(structuredClone(call));
    if (call.key) receipts.set(receiptId, { payload: structuredClone(call.payload), result: structuredClone(result) });
    await after(call, context);
    return response(result);
  });
  return { ...f, ...context };
}

const editorRows = m => [...m.root.innerHTML.matchAll(/name="exerciseId-(row\d+)"/g)].map(match => match[1]);
function editorValues(m, { name = 'Manual plan', minutes = '25', rows = [{ exerciseId: 'squat', setTarget: '2', repMin: '5', repMax: '8', targetKg: '12.5' }] } = {}) {
  const keys = editorRows(m); assert.equal(keys.length, rows.length);
  return { name, minutes, ...Object.fromEntries(rows.flatMap((row, index) => Object.entries(row).map(([field, value]) => [`${field}-${keys[index]}`, value]))) };
}

test('page and default entry surface use YourSession assets without credential or synthetic account content', async () => {
  const [page] = applicationPages();
  assert.equal(page.path, 'app/index.html');
  assert.equal((page.html.match(/<main\b/g) ?? []).length, 1);
  for (const asset of ['variations.css', 'variant-session.css', 'application.css', 'application-entry.mjs']) assert.ok(page.html.includes(`/assets/${asset}`));
  assert.ok(!page.html.includes('data-account')); assert.ok(!page.html.includes('type="password"'));
  const defaultSession = createUnavailableApplicationSession(), m = mounted(defaultSession);
  await m.ui.perform('refresh');
  for (const id of ['plans', 'workout', 'history', 'preferences']) await m.ui.perform('navigate', { id });
  assert.equal(defaultSession.snapshot().status, 'unavailable');
  assert.deepEqual(defaultSession.snapshot().application.resources, {});
  assert.match(m.root.innerHTML, /Account service is unavailable/);
  assert.doesNotMatch(m.root.innerHTML, /Fixture|performed sets recorded/);
  m.ui.dispose();
});

test('real injected journey uses fresh revisions, full session readback, sparse settings and signout', async () => {
  const f = fixture(), m = mounted(f.session);
  assert.equal(f.calls.length, 0);
  await start(f, m);
  assert.match(m.root.innerHTML, /Plan target: 3 sets/); assert.match(m.root.innerHTML, /No performed sets recorded/);
  await m.ui.perform('add-set', { id: 'occ1', setNumber: '1', reps: '6', weightKg: '10' });
  assert.match(m.root.innerHTML, /1 confirmed sets · 6 performed reps · 60 kg-repetitions/);
  await m.ui.perform('edit-set', { id: 'set1', reps: '7', weightKg: '12.5' });
  await m.ui.perform('void-set', { id: 'set1' });
  assert.match(m.root.innerHTML, /Set 1 · voided/);
  await m.ui.perform('add-set', { id: 'occ1', setNumber: '2', reps: '5', weightKg: '20' });
  await assert.rejects(m.ui.perform('complete'), /Confirm completion/);
  await m.ui.perform('complete', { confirmed: 'on' });
  assert.match(m.root.innerHTML, /completed workout is read-only/);
  assert.doesNotMatch(m.root.innerHTML, /data-action="add-set"/);
  await assert.rejects(m.ui.perform('add-set', { id: 'occ1', setNumber: '3', reps: '5', weightKg: '20' }), /session_completed/);
  await m.ui.perform('navigate', { id: 'history' });
  assert.match(m.root.innerHTML, /not a complete week or all-time history/);
  await m.ui.perform('history-page', { id: 'older' }); assert.match(m.root.innerHTML, /No records in this result/);
  await m.ui.perform('history'); await m.ui.perform('open-workout', { id: 'session1' });
  assert.match(m.root.innerHTML, /completed workout is read-only/);
  await m.ui.perform('navigate', { id: 'preferences' });
  await m.ui.perform('save-preferences', { mascot: 'none', appMode: 'advanced', animationStyle: 'long', loadUnit: 'kg', heightUnit: 'cm' });
  const patch = f.calls.find(call => call.method === 'PATCH' && call.path === '/v1/me/preferences');
  assert.deepEqual(patch.payload, { mascot: 'none', expectedRevision: 1 });
  assert.deepEqual(f.saved().equipment, ['dumbbells']); assert.equal(f.saved().animationStyle, 'long');
  assert.match(m.root.innerHTML, /No active Form Plus entitlement/);
  const writes = f.calls.filter(call => call.method !== 'GET' && call.path.startsWith('/v1/workout-sessions'));
  assert.equal(new Set(writes.map(call => call.key)).size, writes.length);
  for (const mutation of writes.filter(call => call.path.includes('/sets'))) {
    const index = f.calls.indexOf(mutation);
    assert.ok(f.calls.slice(index + 1).some(call => call.path === '/v1/workout-sessions/session1' && call.method === 'GET'));
  }
  await m.ui.perform('signout'); assert.equal(f.session.snapshot().status, 'anonymous');
  assert.doesNotMatch(m.root.innerHTML, /Fixture member|Fixture plan|Fixture squat/);
  assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out').length, 1);
  m.ui.dispose();
});

test('invalid performed input cannot send a mutation and unavailable write key blocks submission', async () => {
  const f = fixture(), m = mounted(f.session); await start(f, m);
  const count = f.calls.length;
  await assert.rejects(m.ui.perform('add-set', { id: 'occ1', setNumber: '1', reps: '', weightKg: '20' }), /performed value/);
  await assert.rejects(m.ui.perform('add-set', { id: 'occ1', setNumber: '1', reps: '-2', weightKg: '20' }), /performed values/);
  assert.equal(f.calls.length, count); m.ui.dispose();
  const n = mounted(f.session, { keyFactory: undefined });
  await n.ui.perform('plan', { id: 'plan1' });
  await assert.rejects(n.ui.perform('start'), /write_key_factory_required/);
  n.ui.dispose();
});

test('write conflict keeps prior facts visible and requires readback before another submission', async () => {
  const f = fixture(call => call.method === 'PATCH' ? response({}, 409) : undefined), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('navigate', { id: 'preferences' });
  await m.ui.perform('save-preferences', { mascot: 'none' });
  assert.match(m.root.innerHTML, /server reported a conflict/);
  assert.match(m.root.innerHTML, /value="none" selected/);
  assert.match(m.root.innerHTML, /unsaved draft/);
  assert.equal(f.session.snapshot().application.resources.preferences.data.mascot, 'buff');
  await assert.rejects(m.ui.perform('save-preferences', { mascot: 'none' }), /readback_required/);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  m.ui.dispose();
});

test('failed reads label retained facts stale and preference uncertainty has explicit reconciliation', async () => {
  let planReads = 0, committed = null;
  const f = fixture(call => {
    if (call.path === '/v1/plans' && ++planReads > 1) throw new Error('disconnected');
    if (call.path === '/v1/me/preferences' && call.method === 'PATCH') {
      committed = { ...preferences(), revision: 2, mascot: call.payload.mascot }; throw new Error('lost response');
    }
    if (call.path === '/v1/me/preferences' && committed) return response(committed);
  }), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('plans'); await m.ui.perform('plans');
  assert.match(m.root.innerHTML, /Previously confirmed details/); assert.match(m.root.innerHTML, /Fixture plan/);
  await m.ui.perform('navigate', { id: 'preferences' }); await m.ui.perform('save-preferences', { mascot: 'none' });
  assert.match(m.root.innerHTML, /Check settings write outcome/);
  await m.ui.perform('preferences'); assert.equal(f.session.snapshot().application.resources.preferences.status, 'unknown');
  await m.ui.perform('reconcile-preferences');
  assert.equal(f.session.snapshot().application.resources.preferences.status, 'ready');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.match(m.root.innerHTML, /value="none" selected/); m.ui.dispose();
});

test('unknown set write survives backgrounding, readback and remount without replay or apparent success', async () => {
  const f = fixture(call => { if (call.path.endsWith('/sets')) throw new Error('lost response'); }), m = mounted(f.session);
  await start(f, m); await m.ui.perform('add-set', { id: 'occ1', setNumber: '1', reps: '5', weightKg: '10' });
  const held = f.session.snapshot().application.resources['sets:session1'];
  assert.equal(held.status, 'unknown'); assert.match(m.root.innerHTML, /write outcome is unknown/);
  await assert.rejects(m.ui.perform('refresh'), /unknown_intent_pending/);
  await m.hide(); assert.doesNotMatch(m.root.innerHTML, /Fixture member|Fixture plan/);
  const count = f.calls.length; await m.show(); assert.equal(f.calls.length, count);
  await m.ui.perform('resume'); await m.ui.perform('workout');
  assert.equal(f.session.snapshot().application.resources['sets:session1'].status, 'unknown');
  assert.match(m.root.innerHTML, /New writes and account refresh are held/);
  m.ui.dispose(); const n = mounted(f.session);
  assert.match(n.root.innerHTML, /write outcome is unknown/);
  assert.doesNotMatch(n.root.innerHTML, /Retry the same submitted change/);
  await assert.rejects(n.ui.perform('retry-write'), /exact_retry_unavailable/);
  assert.deepEqual(f.session.snapshot().application.resources['sets:session1'].pending, held.pending);
  assert.equal(f.calls.filter(call => call.path.endsWith('/sets')).length, 1); n.ui.dispose();
});

test('401 after a write removes account facts while retaining unresolved effect', async () => {
  const f = fixture(call => call.path.endsWith('/sets') ? response({}, 401) : undefined), m = mounted(f.session);
  await start(f, m); await m.ui.perform('add-set', { id: 'occ1', setNumber: '1', reps: '5', weightKg: '10' });
  assert.equal(f.session.snapshot().application.resources['sets:session1'].status, 'unknown');
  assert.doesNotMatch(m.root.innerHTML, /Fixture member|Fixture plan|Fixture squat/);
  assert.match(m.root.innerHTML, /write outcome is unknown/); m.ui.dispose();
});

test('ambiguous commit offers deliberate exact-key replay, one effect and confirmed full-session readback', async () => {
  let committed, original, effects = 0;
  const f = fixture(call => {
    if (call.path.endsWith('/sets') && committed) {
      assert.equal(call.key, original.key); assert.deepEqual(call.payload, original.payload);
      return response(committed);
    }
  }, (call, receipt) => { effects++; committed = receipt; original = call; throw new Error('response lost after commit'); });
  const m = mounted(f.session); await start(f, m);
  await m.ui.perform('add-set', { id: 'occ1', setNumber: '1', reps: '5', weightKg: '10' });
  assert.equal(effects, 1); assert.match(m.root.innerHTML, /Retry the same submitted change/);
  await m.hide(); await m.show(); await m.ui.perform('resume');
  assert.equal(f.calls.filter(call => call.path.endsWith('/sets')).length, 1);
  await m.ui.perform('workout');
  assert.equal(f.session.snapshot().application.resources['sets:session1'].status, 'unknown');
  await m.ui.perform('retry-write');
  assert.equal(effects, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/sets')).length, 2);
  assert.equal(f.session.snapshot().application.resources['sets:session1'].status, 'ready');
  assert.match(m.root.innerHTML, /1 confirmed sets · 5 performed reps · 50 kg-repetitions/);
  assert.doesNotMatch(m.root.innerHTML, /Retry the same submitted change/);
  await assert.rejects(m.ui.perform('retry-write'), /exact_retry_unavailable/); m.ui.dispose();
});

test('signout during a pending write immediately removes facts and waits for the physical operation', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => { if (call.path.endsWith('/sets')) { entered.resolve(); return gate.promise; } }), m = mounted(f.session);
  await start(f, m);
  const writing = m.ui.perform('add-set', { id: 'occ1', setNumber: '1', reps: '5', weightKg: '10' });
  const settledWrite = writing.catch(error => error);
  await entered.promise;
  assert.match(m.root.innerHTML, /data-action="signout">Sign out/);
  const leaving = m.ui.perform('signout');
  assert.equal(f.session.snapshot().status, 'signing-out');
  assert.doesNotMatch(m.root.innerHTML, /Fixture member|Fixture plan|Fixture squat/);
  assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out').length, 0);
  gate.resolve(response({}, 409)); await settledWrite; await leaving;
  assert.equal(f.session.snapshot().status, 'anonymous');
  assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out').length, 1);
  assert.doesNotMatch(m.root.innerHTML, /Fixture member|Fixture plan|Fixture squat/); m.ui.dispose();
});

test('explicit signout can leave an unknown resource effect but unknown signout requires readback', async () => {
  const f = fixture(call => {
    if (call.path.endsWith('/sets') || call.path === '/api/auth/sign-out') throw new Error('lost response');
  }), m = mounted(f.session);
  await start(f, m); await m.ui.perform('add-set', { id: 'occ1', setNumber: '1', reps: '5', weightKg: '10' });
  assert.match(m.root.innerHTML, /data-action="signout">Sign out/);
  await m.ui.perform('signout');
  assert.equal(f.session.snapshot().status, 'unknown');
  assert.match(m.root.innerHTML, /sign-out result is unknown/);
  assert.match(m.root.innerHTML, /Check sign-out outcome/);
  await m.ui.perform('signout');
  assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out').length, 1);
  await m.ui.perform('refresh'); assert.equal(f.session.snapshot().status, 'ready');
  assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out').length, 1); m.ui.dispose();
});

test('late operation returns cannot repopulate a suspended or disposed view', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => { if (call.path === '/v1/plans') { entered.resolve(); return gate.promise; } }), m = mounted(f.session);
  await m.ui.perform('refresh'); const work = m.ui.perform('plans'); await entered.promise;
  await m.hide(); const hidden = m.root.innerHTML;
  gate.resolve(response({ items: [plan] })); await work;
  assert.equal(m.root.innerHTML, hidden);
  await m.show(); await m.ui.perform('resume'); assert.match(m.root.innerHTML, /Fixture plan/);
  m.ui.dispose(); m.ui.dispose(); assert.equal(m.root.innerHTML, '');
  assert.equal(m.root.count(), 0); assert.equal(m.page.count(), 0); assert.equal(m.visibility.count(), 0);
  await assert.rejects(m.ui.perform('plans'), /application_disposed/);
});

test('navigation fences an older pending operation and renders the current destination', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => { if (call.path === '/v1/plans') { entered.resolve(); return gate.promise; } }), m = mounted(f.session);
  await m.ui.perform('refresh'); const older = m.ui.perform('plans'); await entered.promise;
  const next = m.ui.perform('navigate', { id: 'preferences' });
  gate.resolve(response({ items: [plan] })); await older; await next;
  assert.match(m.root.innerHTML, /Your preference draft/); assert.doesNotMatch(m.root.innerHTML, /Fixture plan/);
  assert.doesNotMatch(m.root.innerHTML, /aria-busy="true"/); m.ui.dispose();
});

test('current snapshot content is escaped and operation return objects are never rendered', async () => {
  const f = fixture(call => call.path === '/v1/plans' ? response({ items: [{ ...plan, name: '<img src=x onerror="evil()"> & "quoted"' }] }) : undefined);
  const session = { ...f.session, plans: async () => { await f.session.plans(); return { status: 'ready', data: { name: 'POISONED RETURN' } }; } };
  const m = mounted(session); await m.ui.perform('refresh'); await m.ui.perform('plans');
  assert.match(m.root.innerHTML, /&lt;img src=x onerror=&quot;evil\(\)&quot;&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(m.root.innerHTML, /<img|POISONED RETURN/);
  const html = renderApplication(f.session.snapshot(), { notice: '<script>bad</script>', planId: '" onmouseover="bad' });
  assert.doesNotMatch(html, /<script>|data-id="" onmouseover=/); m.ui.dispose();
});

test('delegated click and submit controls call the same guarded journey with string form values', async () => {
  const f = fixture(), m = mounted(f.session);
  const target = attrs => ({ owner: m.root, disabled: false, getAttribute: name => attrs[name] ?? null, closest() { return this; } });
  let prevented = 0;
  await m.root.emit('click', { target: target({ 'data-action': 'refresh' }), preventDefault() { prevented++; } });
  await m.root.emit('click', { target: target({ 'data-action': 'navigate', 'data-id': 'preferences' }), preventDefault() { prevented++; } });
  const form = target({ 'data-action': 'save-preferences', 'data-form': 'preferences' });
  form.elements = [{ name: 'mascot', value: 'none', disabled: false, type: 'select-one' }]; form.reportValidity = () => true;
  await m.root.emit('submit', { target: form, preventDefault() { prevented++; } });
  assert.equal(f.saved().mascot, 'none'); assert.equal(prevented, 3);
  const other = target({ 'data-action': 'signout' }); other.owner = null;
  await m.root.emit('click', { target: other }); assert.equal(f.session.snapshot().status, 'ready'); m.ui.dispose();
});

test('empty plans lead to an explicit blank editor, confirmed create and the existing workout flow', async () => {
  const f = planFixture({ initial: [] }), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('plans');
  assert.match(m.root.innerHTML, /No saved plans were returned/);
  assert.equal(f.calls.filter(call => call.path === '/v1/exercises').length, 0);
  await m.ui.perform('new-plan');
  assert.match(m.root.innerHTML, /name="minutes"[^>]*value=""/);
  assert.match(m.root.innerHTML, /name="targetKg-row1"[^>]*value=""/);
  assert.match(m.root.innerHTML, /value="" selected>Choose a movement/);
  assert.doesNotMatch(m.root.innerHTML, /value="retired"/);
  const name = '<img src=x onerror="bad"> & plan';
  await m.ui.perform('save-plan', editorValues(m, { name }));
  assert.equal(f.effects.length, 1);
  const created = f.records.get('created-1');
  assert.equal(created.name, name); assert.equal(created.minutes, 25);
  assert.deepEqual(created.items.map(({ id, ...row }) => row), [{ exerciseId: 'squat', setTarget: 2, repMin: 5, repMax: 8, targetKg: 12.5 }]);
  assert.match(created.items[0].id, /^[a-zA-Z0-9_-]{1,80}$/);
  assert.match(m.root.innerHTML, /&lt;img src=x onerror=&quot;bad&quot;&gt; &amp; plan/);
  assert.doesNotMatch(m.root.innerHTML, /<img|data-form="plan-editor"/);
  const tail = f.calls.slice(f.calls.findIndex(call => call.method === 'POST' && call.path === '/v1/plans') + 1);
  assert.ok(tail.some(call => call.path === '/v1/plans/created-1' && call.method === 'GET'));
  assert.ok(tail.some(call => call.path === '/v1/plans' && call.method === 'GET'));
  await m.ui.perform('start');
  assert.equal(f.session.snapshot().application.resources['workout:manual-session'].data.planId, created.id);
  assert.match(m.root.innerHTML, /Plan target: 2 sets · 5–8 reps · 12.5 kg/); m.ui.dispose();
});

test('plan edits are sparse and preserve or replace item identities across target, order and removal changes', async () => {
  const f = planFixture(), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('plan', { id: 'plan1' }); await m.ui.perform('start');
  const captured = structuredClone(f.session.snapshot().application.resources['workout:manual-session'].data.planSnapshot);
  await m.ui.perform('navigate', { id: 'plans' }); await m.ui.perform('plan', { id: 'plan1' }); await m.ui.perform('edit-plan');
  await m.ui.perform('save-plan', { name: 'Renamed only' });
  assert.deepEqual(f.effects.at(-1).payload, { name: 'Renamed only', expectedRevision: 1 });
  await m.ui.perform('edit-plan');
  const [originalRow] = editorRows(m);
  await m.ui.perform('save-plan', { [`targetKg-${originalRow}`]: '22.5' });
  assert.equal(f.records.get('plan1').items[0].id, 'item1');
  assert.deepEqual(Object.keys(f.effects.at(-1).payload).sort(), ['expectedRevision', 'items']);
  await m.ui.perform('edit-plan'); await m.ui.perform('plan-add-row');
  const keys = editorRows(m);
  const values = editorValues(m, { name: 'Renamed only', minutes: '30', rows: [
    { exerciseId: 'press', setTarget: '3', repMin: '5', repMax: '8', targetKg: '22.5' },
    { exerciseId: 'squat', setTarget: '2', repMin: '6', repMax: '10', targetKg: '15' },
  ] });
  await m.ui.perform('plan-row-up', { ...values, id: keys[1] });
  await m.ui.perform('save-plan');
  const changed = f.records.get('plan1');
  assert.deepEqual(changed.items.map(row => row.exerciseId), ['squat', 'press']);
  assert.ok(changed.items.every(row => row.id !== 'item1'));
  const retained = changed.items[1].id;
  await m.ui.perform('edit-plan');
  await m.ui.perform('plan-remove-row', { id: editorRows(m)[0] }); await m.ui.perform('save-plan');
  assert.equal(f.records.get('plan1').items[0].id, retained);
  assert.deepEqual(f.session.snapshot().application.resources['workout:manual-session'].data.planSnapshot, captured);
  const count = f.effects.length;
  await assert.rejects(m.ui.perform('archive-plan'), /archive_confirmation_required/); assert.equal(f.effects.length, count);
  await m.ui.perform('archive-plan', { confirmed: 'on' });
  assert.equal(f.records.get('plan1').archived, true); assert.match(m.root.innerHTML, /archived plan is read-only/);
  await assert.rejects(m.ui.perform('edit-plan'), /archived_plan/); await assert.rejects(m.ui.perform('start'), /archived_plan/);
  assert.deepEqual(f.session.snapshot().application.resources['workout:manual-session'].data.planSnapshot, captured); m.ui.dispose();
});

test('invalid plan targets, unavailable exercises and unsafe generated IDs never submit a plan', async () => {
  const f = planFixture({ initial: [] }), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('new-plan');
  const valid = editorValues(m);
  const row = editorRows(m)[0];
  for (const change of [{ name: ' ' }, { name: 'a'.repeat(101) }, { minutes: '4' }, { minutes: '181' },
    { [`setTarget-${row}`]: '21' }, { [`repMin-${row}`]: '9', [`repMax-${row}`]: '8' },
    { [`targetKg-${row}`]: 'NaN' }, { [`targetKg-${row}`]: '501' }, { [`exerciseId-${row}`]: 'retired' }, { [`exerciseId-${row}`]: 'invented' }]) {
    await assert.rejects(m.ui.perform('save-plan', { ...valid, ...change }), /invalid_plan_fields|exercise_unavailable/);
  }
  assert.equal(f.effects.length, 0); m.ui.dispose();
  const n = mounted(f.session, { keyFactory: () => 'a'.repeat(81) }); await n.ui.perform('new-plan');
  await assert.rejects(n.ui.perform('save-plan', editorValues(n)), /invalid_plan_item_id/);
  assert.equal(f.effects.length, 0); n.ui.dispose();
  const c = mounted(f.session, { keyFactory: () => 'same-id' }); await c.ui.perform('new-plan'); await c.ui.perform('plan-add-row');
  await assert.rejects(c.ui.perform('save-plan', editorValues(c, { rows: [
    { exerciseId: 'squat', setTarget: '2', repMin: '5', repMax: '8', targetKg: '10' },
    { exerciseId: 'press', setTarget: '2', repMin: '5', repMax: '8', targetKg: '10' },
  ] })), /fresh_write_key_required/);
  assert.equal(f.effects.length, 0); c.ui.dispose();
  const existing = planFixture(), replacement = mounted(existing.session, { keyFactory: () => 'item1' });
  await replacement.ui.perform('refresh'); await replacement.ui.perform('plan', { id: 'plan1' }); await replacement.ui.perform('edit-plan');
  await assert.rejects(replacement.ui.perform('save-plan', { [`exerciseId-${editorRows(replacement)[0]}`]: 'press' }), /invalid_plan_item_id/);
  assert.equal(existing.effects.length, 0); replacement.ui.dispose();
});

test('a draft cannot silently adopt a newer confirmed revision or survive backgrounding', async () => {
  const f = planFixture(), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('plan', { id: 'plan1' }); await m.ui.perform('edit-plan');
  const server = f.records.get('plan1'); server.revision++; server.name = 'Changed elsewhere';
  await m.ui.perform('plan', { id: 'plan1' });
  await assert.rejects(m.ui.perform('save-plan', { name: 'My old draft' }), /plan_draft_stale/);
  assert.equal(f.effects.length, 0); assert.match(m.root.innerHTML, /Replace draft with current plan/);
  await m.ui.perform('edit-plan'); await m.ui.perform('save-plan', { name: 'Reviewed new revision' });
  assert.deepEqual(f.effects[0].payload, { name: 'Reviewed new revision', expectedRevision: 2 });
  await m.ui.perform('edit-plan'); await m.hide(); await m.show(); await m.ui.perform('resume');
  assert.doesNotMatch(m.root.innerHTML, /data-form="plan-editor"/);
  await assert.rejects(m.ui.perform('save-plan', { name: 'Discarded draft' }), /plan_editor_required/); m.ui.dispose();
});

for (const operation of ['create', 'archive']) test(`unknown plan ${operation} preserves an exact replay recipe and confirms only one effect`, async () => {
  let lost = false;
  const f = planFixture({ initial: operation === 'create' ? [] : [plan], after: call => {
    if (!lost && (operation === 'create' ? call.path === '/v1/plans' : call.path.endsWith('/archive'))) { lost = true; throw new Error('committed response lost'); }
  } }), m = mounted(f.session);
  await m.ui.perform('refresh');
  if (operation === 'create') { await m.ui.perform('new-plan'); await m.ui.perform('save-plan', editorValues(m)); }
  else { await m.ui.perform('plan', { id: 'plan1' }); await m.ui.perform('archive-plan', { confirmed: 'on' }); }
  assert.match(m.root.innerHTML, /Retry the same submitted change/);
  assert.equal(f.effects.length, 1);
  const slot = operation === 'create' ? 'plans:create' : 'plan:plan1';
  const pending = f.session.snapshot().application.resources[slot].pending;
  await m.ui.perform('plans');
  if (operation === 'archive') await m.ui.perform('plan', { id: 'plan1' });
  assert.equal(f.session.snapshot().application.resources[slot].status, 'unknown');
  await m.hide(); await m.show(); await m.ui.perform('resume');
  await m.ui.perform('retry-write');
  assert.equal(f.effects.length, 1);
  const attempts = f.calls.filter(call => call.path === pending.path && call.method === pending.method);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].key, pending.key); assert.deepEqual(attempts[1].payload, pending.body);
  assert.equal(f.session.snapshot().application.selectedView, 'plans');
  assert.doesNotMatch(m.root.innerHTML, /Retry the same submitted change/);
  assert.match(m.root.innerHTML, operation === 'archive' ? /archived plan is read-only/ : /Manual plan/); m.ui.dispose();
});

for (const outcome of ['matching', 'conflicting', 'unchanged']) test(`unknown revision-only edit uses explicit ${outcome} reconciliation without replay`, async () => {
  const f = planFixture({ before: (call, { records }) => {
    if (call.method === 'PATCH' && call.path === '/v1/plans/plan1') {
      if (outcome !== 'unchanged') { const saved = records.get('plan1'); saved.revision++; saved.name = outcome === 'matching' ? call.payload.name : 'Another edit'; }
      throw new Error('edit response lost');
    }
  } }), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('plan', { id: 'plan1' }); await m.ui.perform('edit-plan');
  await m.ui.perform('save-plan', { name: 'Requested edit' });
  assert.match(m.root.innerHTML, /Check plan edit outcome/);
  assert.doesNotMatch(m.root.innerHTML, /Retry the same submitted change/);
  await m.ui.perform('plan', { id: 'plan1' }); assert.equal(f.session.snapshot().application.resources['plan:plan1'].status, 'unknown');
  await m.ui.perform('reconcile-plan');
  assert.equal(f.session.snapshot().application.resources['plan:plan1'].status, outcome === 'matching' ? 'ready' : outcome === 'conflicting' ? 'conflict' : 'unknown');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  if (outcome === 'matching') assert.doesNotMatch(m.root.innerHTML, /data-form="plan-editor"/);
  else assert.match(m.root.innerHTML, /data-form="plan-editor"/);
  m.ui.dispose();
});

test('pending plan creation admits signout, fences late UI work and discards its generation-bound recipe', async () => {
  const gate = deferred(), entered = deferred();
  const f = planFixture({ initial: [], before: call => {
    if (call.path === '/v1/plans' && call.method === 'POST') { entered.resolve(); return gate.promise; }
  } }), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('new-plan');
  const creating = m.ui.perform('save-plan', editorValues(m)).catch(error => error); await entered.promise;
  await assert.rejects(m.ui.perform('new-plan'), /operation_in_progress/);
  const leaving = m.ui.perform('signout');
  assert.doesNotMatch(m.root.innerHTML, /Fixture member|Manual plan|data-form="plan-editor"/);
  assert.equal(f.calls.filter(call => call.path === '/api/auth/sign-out').length, 0);
  gate.resolve(response({}, 409)); await creating; await leaving;
  assert.equal(f.session.snapshot().status, 'anonymous');
  assert.doesNotMatch(m.root.innerHTML, /Retry the same submitted change|data-form="plan-editor"/); m.ui.dispose();
});

test('plan readback failure remains qualified and disposal cannot reconstruct an unknown create retry', async () => {
  let failReadback = false;
  const f = planFixture({ initial: [], before: call => failReadback && call.method === 'GET' && call.path.startsWith('/v1/plans/') ? response({}, 503) : undefined,
    after: () => { failReadback = true; } }), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('new-plan'); await m.ui.perform('save-plan', editorValues(m));
  assert.equal(f.effects.length, 1);
  assert.equal(f.session.snapshot().application.resources['plan:created-1'].status, 'error');
  assert.match(m.root.innerHTML, /request failed/); m.ui.dispose();
  const lost = planFixture({ initial: [], after: () => { throw new Error('lost'); } }), n = mounted(lost.session);
  await n.ui.perform('refresh'); await n.ui.perform('new-plan'); await n.ui.perform('save-plan', editorValues(n)); n.ui.dispose();
  const remount = mounted(lost.session);
  assert.match(remount.root.innerHTML, /write outcome is unknown/);
  await assert.rejects(remount.ui.perform('retry-write'), /exact_retry_unavailable/);
  assert.equal(lost.effects.length, 1); remount.ui.dispose();
});

test('unavailable default rejects authoring without creating resource or draft facts', async () => {
  const session = createUnavailableApplicationSession(), m = mounted(session);
  for (const action of ['new-plan', 'edit-plan', 'save-plan', 'archive-plan', 'reconcile-plan']) await assert.rejects(m.ui.perform(action), /session_not_ready/);
  assert.deepEqual(session.snapshot().application.resources, {});
  assert.doesNotMatch(m.root.innerHTML, /data-form="plan-editor"/); m.ui.dispose();
});

test('delegated plan input and submission retain entered values across row controls', async () => {
  const f = planFixture({ initial: [] }), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('new-plan');
  const values = editorValues(m, { name: 'Entered through controls' });
  const form = { owner: m.root, getAttribute: name => ({ 'data-form': 'plan-editor', 'data-action': 'save-plan' })[name] ?? null,
    closest() { return this; }, reportValidity: () => true,
    elements: Object.entries(values).map(([name, value]) => ({ name, value, type: 'text', disabled: false })) };
  await m.root.emit('input', { target: form });
  await m.ui.perform('plan-add-row');
  assert.match(m.root.innerHTML, /value="Entered through controls"/);
  await m.ui.perform('plan-remove-row', { id: editorRows(m)[1] });
  let prevented = false;
  await m.root.emit('submit', { target: form, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.records.get('created-1').name, 'Entered through controls');
  assert.equal(f.records.get('created-1').items[0].targetKg, 12.5); m.ui.dispose();
});

const recordedTotals = () => ({ completedSessions: 0, confirmedSets: 2, repetitions: 10, volumeKg: 125,
  byExercise: [{ exerciseId: 'squat', confirmedSets: 2, repetitions: 10, volumeKg: 125, maxWeightKg: 12.5 }],
  units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true });
const zeroTotals = () => ({ ...recordedTotals(), confirmedSets: 0, repetitions: 0, volumeKg: 0, byExercise: [] });
async function settings(m) { await m.ui.perform('refresh'); await m.ui.perform('navigate', { id: 'preferences' }); }
function preferencesForm(m, values) {
  return { owner: m.root, getAttribute: name => ({ 'data-form': 'preferences', 'data-action': 'save-preferences' })[name] ?? null,
    closest() { return this; }, reportValidity: () => true,
    elements: Object.entries(values).map(([name, value]) => ({ name, value, type: 'text', disabled: false })) };
}

test('all eleven preferences render and save only canonical changes including explicit false and empty equipment', async () => {
  const f = fixture(), m = mounted(f.session); await settings(m);
  for (const name of Object.keys(preferences()).filter(name => !['revision', 'equipment'].includes(name))) assert.ok(m.root.innerHTML.includes(`name="${name}"`));
  assert.match(m.root.innerHTML, /name="equipment-0"/);
  await m.ui.perform('save-preferences', { coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: '7', sessionMinutes: '180', remindersEnabled: 'true', equipment: ['  bands\nlong  ', 'bands\nlong'] });
  const patches = () => f.calls.filter(call => call.method === 'PATCH');
  assert.deepEqual(patches()[0].payload, { expectedRevision: 1, coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: 7, sessionMinutes: 180, remindersEnabled: true, equipment: ['bands\nlong', 'bands\nlong'] });
  await m.ui.perform('save-preferences', { trainingDaysPerWeek: '07', sessionMinutes: '180.0', equipment: ['bands\nlong', 'bands\nlong'] });
  assert.equal(patches().length, 1); assert.match(m.root.innerHTML, /No preference changes/);
  await m.ui.perform('save-preferences', { remindersEnabled: false, equipment: [] });
  assert.deepEqual(patches()[1].payload, { expectedRevision: 2, remindersEnabled: false, equipment: [] });
  assert.equal(f.saved().coachVoice, 'direct'); assert.equal(f.saved().loadUnit, 'kg');
  await m.ui.perform('save-preferences', { trainingDaysPerWeek: '1', sessionMinutes: '5' });
  assert.deepEqual(patches()[2].payload, { expectedRevision: 3, trainingDaysPerWeek: 1, sessionMinutes: 5 });
  assert.match(m.root.innerHTML, /does not start audio, request permission or deliver notifications/);
  assert.ok(f.calls.every(call => ['/v1/capabilities', '/v1/me', '/v1/entitlements', '/v1/me/preferences'].includes(call.path)));
  m.ui.dispose();
});

test('preference limits reject invalid values without requests and accept thirty independent 200-character entries', async () => {
  const f = fixture(), m = mounted(f.session); await settings(m); const count = f.calls.length;
  const invalid = [
    ...['', '0', '8', '1.5', 'Infinity'].map(trainingDaysPerWeek => ({ trainingDaysPerWeek })),
    ...['4', '181', '5.5', 'NaN'].map(sessionMinutes => ({ sessionMinutes })),
    { coachVoice: 'invented' }, { communication: 'invented' }, { remindersEnabled: 'on' },
    { equipment: [''] }, { equipment: ['  '] }, { equipment: ['x'.repeat(201)] }, { equipment: Array(31).fill('band') }, { equipment: 'bands' }, { equipment: [false] },
  ];
  for (const values of invalid) {
    await assert.rejects(m.ui.perform('save-preferences', values), /invalid_preferences/);
    await m.ui.perform('replace-preferences-draft');
  }
  assert.equal(f.calls.length, count);
  await m.ui.perform('save-preferences', { equipment: Array(30).fill('x'.repeat(200)) });
  assert.equal(f.saved().equipment.length, 30); assert.equal(f.saved().equipment[0].length, 200);
  await assert.rejects(m.ui.perform('equipment-add'), /invalid_preferences/);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1); m.ui.dispose();
});

test('delegated equipment rows preserve literal strings and escape text while add and remove remain unsaved', async () => {
  const f = fixture(), m = mounted(f.session); await settings(m);
  const text = '</textarea><img src=x onerror="bad">\nlong band';
  await m.root.emit('input', { target: preferencesForm(m, { 'equipment-0': text }) });
  await m.ui.perform('equipment-add');
  assert.match(m.root.innerHTML, /&lt;\/textarea&gt;&lt;img/); assert.doesNotMatch(m.root.innerHTML, /<img/);
  assert.match(m.root.innerHTML, /name="equipment-1"/);
  await m.root.emit('input', { target: preferencesForm(m, { 'equipment-0': text, 'equipment-1': 'second entry' }) });
  await m.ui.perform('equipment-remove', { id: '1' });
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  await m.root.emit('submit', { target: preferencesForm(m, { 'equipment-0': text }), preventDefault() {} });
  assert.deepEqual(f.saved().equipment, [text]);
  await m.ui.perform('equipment-remove', { id: '0' });
  await m.ui.perform('save-preferences'); assert.deepEqual(f.saved().equipment, []); m.ui.dispose();
});

test('newer settings readback retains the draft revision and requires deliberate replacement', async () => {
  const f = fixture(), m = mounted(f.session); await settings(m);
  await m.root.emit('input', { target: preferencesForm(m, { coachVoice: 'direct', 'equipment-0': 'my unsaved equipment' }) });
  Object.assign(f.saved(), { revision: 2, coachVoice: 'encouraging', equipment: ['server equipment'] });
  await m.ui.perform('preferences');
  assert.match(m.root.innerHTML, /These settings have changed/); assert.match(m.root.innerHTML, /my unsaved equipment/);
  await assert.rejects(m.ui.perform('save-preferences'), /preferences_draft_stale/);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  await m.ui.perform('replace-preferences-draft'); assert.match(m.root.innerHTML, /server equipment/);
  assert.doesNotMatch(m.root.innerHTML, /my unsaved equipment/);
  await m.ui.perform('save-preferences', { communication: 'detailed' });
  assert.deepEqual(f.calls.find(call => call.method === 'PATCH').payload, { expectedRevision: 2, communication: 'detailed' }); m.ui.dispose();
});

for (const outcome of ['matching', 'conflicting', 'unchanged']) test(`uncertain preference write has ${outcome} revision reconciliation without replay`, async () => {
  let saved = preferences();
  const f = fixture(call => {
    if (call.path !== '/v1/me/preferences') return undefined;
    if (call.method === 'PATCH') {
      assert.deepEqual(call.payload, { expectedRevision: 1, equipment: [], remindersEnabled: true });
      if (outcome !== 'unchanged') saved = { ...saved, revision: 2, equipment: [], remindersEnabled: outcome === 'matching' };
      throw new Error('reply lost');
    }
    return response(saved);
  }), m = mounted(f.session); await settings(m);
  await m.ui.perform('save-preferences', { equipment: [], remindersEnabled: true });
  await m.ui.perform('preferences');
  assert.equal(f.session.snapshot().application.resources.preferences.status, 'unknown');
  await assert.rejects(m.ui.perform('save-preferences'), /unknown_intent_pending/);
  await m.ui.perform('reconcile-preferences');
  const state = f.session.snapshot().application.resources.preferences;
  assert.equal(state.status, { matching: 'ready', conflicting: 'conflict', unchanged: 'unknown' }[outcome]);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  if (outcome === 'matching') assert.match(m.root.innerHTML, /value="true" selected/);
  if (outcome === 'conflicting') {
    await m.ui.perform('preferences');
    await assert.rejects(m.ui.perform('save-preferences'), /preferences_draft_stale/);
    await m.ui.perform('replace-preferences-draft');
    assert.match(m.root.innerHTML, /value="false" selected/);
  }
  m.ui.dispose();
});

test('recorded totals load only explicitly and ready zero totals differ from unavailable history', async () => {
  const f = fixture(call => call.path === '/v1/stats' ? response(zeroTotals()) : undefined), m = mounted(f.session);
  assert.equal(f.calls.length, 0); await m.ui.perform('refresh'); await m.ui.perform('navigate', { id: 'history' });
  assert.equal(f.calls.filter(call => call.path === '/v1/stats').length, 0);
  assert.match(m.root.innerHTML, /Recorded totals have not been loaded/);
  await m.ui.perform('stats');
  assert.equal(f.session.snapshot().application.resources.stats.status, 'ready');
  assert.match(m.root.innerHTML, /Completed sessions<\/dt><dd>0/);
  assert.match(m.root.innerHTML, /0 kg-repetitions/); assert.match(m.root.innerHTML, /No confirmed sets are included/);
  await m.hide(); await m.show(); await m.ui.perform('resume');
  assert.equal(f.calls.filter(call => call.path === '/v1/stats').length, 1); m.ui.dispose();
});

test('active recorded totals are independent of history pagination and remain kg with a pounds preference', async () => {
  const f = fixture(call => {
    if (call.path === '/v1/stats') return response(recordedTotals());
    if (call.path === '/v1/exercises') return response({ items: [{ id: 'squat', name: '<img src=x> & exercise', loadLabel: 'Load', retired: false, provenance: {}, requiredConstraints: [], cues: [] }] });
  }), m = mounted(f.session);
  await settings(m); await m.ui.perform('save-preferences', { loadUnit: 'lb' });
  await m.ui.perform('navigate', { id: 'history' }); await m.ui.perform('history-page', { id: 'older' }); await m.ui.perform('stats');
  assert.match(m.root.innerHTML, /No records in this result/); assert.match(m.root.innerHTML, /Completed sessions<\/dt><dd>0/);
  assert.match(m.root.innerHTML, /Confirmed sets<\/dt><dd>2/); assert.match(m.root.innerHTML, /125 kg-repetitions/);
  assert.match(m.root.innerHTML, /Highest recorded load: 12.5 kg/);
  assert.match(m.root.innerHTML, /include confirmed sets in active workouts and exclude draft and voided/);
  assert.match(m.root.innerHTML, /Exercise name unavailable/);
  await m.ui.perform('plan', { id: 'plan1' });
  assert.match(m.root.innerHTML, /&lt;img src=x&gt; &amp; exercise/); assert.doesNotMatch(m.root.innerHTML, /<img/);
  assert.equal(f.calls.filter(call => call.path === '/v1/stats').length, 1); m.ui.dispose();
});

test('malformed totals remain error or stale and writes invalidate totals without automatic reload', async () => {
  let body = { ...recordedTotals(), confirmedSets: 3 };
  const f = fixture(call => call.path === '/v1/stats' ? response(body) : undefined), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('navigate', { id: 'history' }); await m.ui.perform('stats');
  assert.equal(f.session.snapshot().application.resources.stats.status, 'error');
  assert.doesNotMatch(m.root.innerHTML, /125 kg-repetitions/);
  body = recordedTotals(); await m.ui.perform('stats');
  await m.ui.perform('navigate', { id: 'preferences' }); await m.ui.perform('save-preferences', { communication: 'detailed' });
  await m.ui.perform('navigate', { id: 'history' });
  assert.equal(f.session.snapshot().application.resources.stats.status, 'stale');
  assert.equal(f.calls.filter(call => call.path === '/v1/stats').length, 2);
  body = { ...recordedTotals(), includesActiveConfirmedSets: false }; await m.ui.perform('stats');
  const state = f.session.snapshot().application.resources.stats;
  assert.equal(state.status, 'stale'); assert.ok(state.error);
  assert.match(m.root.innerHTML, /Previously confirmed details/); assert.match(m.root.innerHTML, /125 kg-repetitions/); m.ui.dispose();
});

test('late totals cannot revive hidden account content and signout clears totals and preference drafts', async () => {
  const entered = deferred(), gate = deferred();
  const f = fixture(call => { if (call.path === '/v1/stats') { entered.resolve(); return gate.promise; } }), m = mounted(f.session);
  await settings(m); await m.root.emit('input', { target: preferencesForm(m, { 'equipment-0': 'private draft' }) });
  await m.ui.perform('navigate', { id: 'history' }); const reading = m.ui.perform('stats'); await entered.promise;
  await m.hide(); const hidden = m.root.innerHTML; gate.resolve(response(recordedTotals())); await reading;
  assert.equal(m.root.innerHTML, hidden); await m.show(); await m.ui.perform('resume');
  assert.match(m.root.innerHTML, /125 kg-repetitions/);
  await m.ui.perform('navigate', { id: 'preferences' }); assert.doesNotMatch(m.root.innerHTML, /private draft/);
  await m.ui.perform('signout'); assert.deepEqual(f.session.snapshot().application.resources, {});
  assert.doesNotMatch(m.root.innerHTML, /private draft|125 kg-repetitions|dumbbells/); m.ui.dispose();
});

test('signout retires a pending totals read and unavailable defaults cannot load or save settings and totals', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture(call => { if (call.path === '/v1/stats') { entered.resolve(); return gate.promise; } }), m = mounted(f.session);
  await m.ui.perform('refresh'); await m.ui.perform('navigate', { id: 'history' });
  const reading = m.ui.perform('stats').catch(error => error); await entered.promise;
  const leaving = m.ui.perform('signout'); assert.doesNotMatch(m.root.innerHTML, /Recorded totals/);
  gate.resolve(response(recordedTotals())); await reading; await leaving;
  assert.doesNotMatch(m.root.innerHTML, /125 kg-repetitions/); assert.equal(f.session.snapshot().status, 'anonymous'); m.ui.dispose();
  const session = createUnavailableApplicationSession(), n = mounted(session);
  for (const action of ['stats', 'preferences', 'save-preferences', 'equipment-add', 'replace-preferences-draft']) await assert.rejects(n.ui.perform(action), /session_not_ready/);
  assert.deepEqual(session.snapshot().application.resources, {}); n.ui.dispose();
});


const manualProfile = () => ({ revision: 1, name: '  Provisioned member  ', age: 35, heightCm: 170.5, weightKg: 70.5,
  trainingBackground: 'returning', injuryHistory: '  stored history  ', goals: ['  literal\nentry  ', 'duplicate', 'duplicate'] });
function profileFixture({ initial = manualProfile(), before = () => undefined } = {}) {
  let saved = structuredClone(initial);
  const f = fixture(async call => {
    if (call.path !== '/v1/me/profile') return undefined;
    const result = await before(call, { saved, set: value => { saved = structuredClone(value); } });
    if (result !== undefined) return result;
    if (call.method === 'PATCH') {
      const { expectedRevision, ...changes } = call.payload;
      assert.equal(expectedRevision, saved.revision);
      assert.equal(call.key, undefined);
      saved = { ...saved, ...changes, revision: saved.revision + 1 };
    }
    return response(saved);
  });
  return { ...f, profile: () => saved, replace: value => { saved = structuredClone(value); },
    patches: () => f.calls.filter(call => call.path === '/v1/me/profile' && call.method === 'PATCH') };
}
function profileForm(m, values) {
  return { owner: m.root, getAttribute: name => ({ 'data-form': 'profile', 'data-action': 'save-profile' })[name] ?? null,
    closest() { return this; }, reportValidity: () => true,
    elements: Object.entries(values).map(([name, value]) => ({ name, value, type: 'text', disabled: false })) };
}
async function loadProfile(m) { await settings(m); await m.ui.perform('profile'); }

test('Profile is an explicit Settings read, preserves raw fields and optional context, and needs no key factory', async () => {
  for (const context of [undefined, '  stored context  ']) {
    const initial = { ...manualProfile(), ...(context === undefined ? {} : { trainingContext: context }) };
    const f = profileFixture({ initial }), m = mounted(f.session, { keyFactory: undefined });
    assert.equal(f.calls.length, 0); await settings(m);
    assert.equal(f.calls.filter(call => call.path === '/v1/me/profile').length, 0);
    await m.ui.perform('profile');
    assert.match(m.root.innerHTML, /value="  Provisioned member  "/);
    assert.match(m.root.innerHTML, /  stored history  /);
    assert.ok(m.root.innerHTML.includes('  literal\nentry  '));
    await m.root.emit('submit', { target: profileForm(m, { name: initial.name, age: '35', heightCm: '170.5', weightKg: '70.5', trainingBackground: 'returning', trainingContext: context ?? '', injuryHistory: initial.injuryHistory, ...Object.fromEntries(initial.goals.map((goal, index) => [`goal-${index}`, goal])) }), preventDefault() {} });
    assert.equal(f.patches().length, 0); assert.match(m.root.innerHTML, /No profile changes/);
    await m.ui.perform('save-profile', { age: '36' });
    assert.deepEqual(f.patches()[0].payload, { age: 36, expectedRevision: 1 });
    assert.equal(Object.hasOwn(f.profile(), 'trainingContext'), context !== undefined);
    assert.match(m.root.innerHTML, /Fixture member’s workspace/);
    m.ui.dispose();
  }
});

test('Profile sparse changes distinguish canonical numbers, explicit null, empty text and goals, and omitted context', async () => {
  const f = profileFixture(), m = mounted(f.session, { keyFactory: undefined }); await loadProfile(m);
  await m.ui.perform('save-profile', { age: '035', heightCm: '170.50' }); assert.equal(f.patches().length, 0);
  await m.ui.perform('save-profile', { age: '', heightCm: ' ', weightKg: '', trainingBackground: '', injuryHistory: '', goals: [] });
  assert.deepEqual(f.patches()[0].payload, { age: null, heightCm: null, weightKg: null, trainingBackground: null, injuryHistory: '', goals: [], expectedRevision: 1 });
  await m.ui.perform('save-profile', { trainingContext: '  my context  ', name: ' My name ' });
  assert.deepEqual(f.patches()[1].payload, { name: 'My name', trainingContext: 'my context', expectedRevision: 2 });
  await m.ui.perform('save-profile', { trainingContext: '' }); assert.deepEqual(f.patches()[2].payload, { trainingContext: '', expectedRevision: 3 });
  m.ui.dispose();
});

test('delegated Profile goals retain literal newlines, order and duplicates, escape markup, and permit removing the last row', async () => {
  const f = profileFixture(), m = mounted(f.session); await loadProfile(m);
  const text = '<img src=x>\nsecond line & "quote"';
  await m.root.emit('input', { target: profileForm(m, { 'goal-0': text }) });
  await m.ui.perform('goal-add');
  assert.match(m.root.innerHTML, /&lt;img src=x&gt;/); assert.doesNotMatch(m.root.innerHTML, /<img src=x>/);
  await m.root.emit('input', { target: profileForm(m, { 'goal-3': 'duplicate' }) });
  await m.ui.perform('goal-remove', { id: '1' });
  assert.equal(f.patches().length, 0);
  await m.root.emit('submit', { target: profileForm(m, {}), preventDefault() {} });
  assert.deepEqual(f.patches()[0].payload.goals, [text, 'duplicate', 'duplicate']);
  for (let i = 0; i < 3; i++) await m.ui.perform('goal-remove', { id: '0' });
  await m.ui.perform('save-profile'); assert.deepEqual(f.profile().goals, []); m.ui.dispose();
});

test('Profile field limits reject locally without PATCH and accept boundary values', async () => {
  const f = profileFixture(), m = mounted(f.session); await loadProfile(m);
  for (const values of [{ name: ' ' }, { name: 'x'.repeat(101) }, { age: '12' }, { age: '121' }, { age: '13.5' },
    { heightCm: '49' }, { heightCm: '261' }, { weightKg: '14' }, { weightKg: '501' }, { weightKg: 'Infinity' },
    { trainingBackground: 'expert' }, { trainingContext: 'x'.repeat(4001) }, { injuryHistory: 'x'.repeat(4001) },
    { goals: [' '] }, { goals: ['x'.repeat(201)] }, { goals: Array(31).fill('a') }, { goals: 'bad' }]) {
    await assert.rejects(m.ui.perform('save-profile', values), /invalid_profile/);
    await m.ui.perform('replace-profile-draft');
  }
  assert.equal(f.patches().length, 0);
  await m.ui.perform('save-profile', { name: 'x'.repeat(100), age: '13', heightCm: '50', weightKg: '15', trainingBackground: 'new',
    injuryHistory: 'x'.repeat(4000), trainingContext: 'x'.repeat(4000), goals: Array(30).fill('x'.repeat(200)) });
  await assert.rejects(m.ui.perform('goal-add'), /invalid_profile/);
  await m.ui.perform('save-profile', { age: '120', heightCm: '260', weightKg: '500', trainingBackground: 'regular' });
  assert.equal(f.patches().length, 2); m.ui.dispose();
});

test('Profile reload holds stale draft until explicit replacement rather than rebasing', async () => {
  const f = profileFixture(), m = mounted(f.session); await loadProfile(m);
  await m.root.emit('input', { target: profileForm(m, { name: 'my unsaved name' }) });
  f.replace({ ...f.profile(), revision: 2, name: 'server name' }); await m.ui.perform('profile');
  assert.match(m.root.innerHTML, /my unsaved name/);
  await assert.rejects(m.ui.perform('save-profile'), /profile_draft_stale/); assert.equal(f.patches().length, 0);
  await m.ui.perform('replace-profile-draft'); assert.doesNotMatch(m.root.innerHTML, /my unsaved name/);
  await m.ui.perform('save-profile', { age: '36' }); assert.deepEqual(f.patches()[0].payload, { age: 36, expectedRevision: 2 }); m.ui.dispose();
});

for (const outcome of ['matching', 'conflicting', 'unchanged']) test(`Profile unknown save requires explicit ${outcome} reconciliation with no replay`, async () => {
  const f = profileFixture({ before: (call, state) => {
    if (call.method === 'PATCH') {
      if (outcome !== 'unchanged') state.set({ ...state.saved, revision: 2, name: outcome === 'matching' ? call.payload.name : 'someone else' });
      throw new Error('lost response');
    }
  } }), m = mounted(f.session, { keyFactory: undefined }); await loadProfile(m);
  await m.ui.perform('save-profile', { name: 'new name' });
  await m.ui.perform('profile'); assert.equal(f.session.snapshot().application.resources.profile.status, 'unknown');
  assert.match(m.root.innerHTML, /Check profile save outcome/);
  assert.equal(m.root.innerHTML.includes('data-action="retry-write"'), false);
  await assert.rejects(m.ui.perform('save-profile'), /unknown_intent_pending/);
  await assert.rejects(m.ui.perform('save-preferences', { communication: 'detailed' }), /unknown_intent_pending/);
  await m.ui.perform('reconcile-profile');
  assert.equal(f.session.snapshot().application.resources.profile.status, { matching: 'ready', conflicting: 'conflict', unchanged: 'unknown' }[outcome]);
  assert.equal(f.patches().length, 1);
  if (outcome === 'matching') { await m.ui.perform('save-profile'); assert.equal(f.patches().length, 1); }
  else assert.match(m.root.innerHTML, /value="new name"/);
  m.ui.dispose();
});

for (const mode of ['malformed', 'failed']) test(`Profile ${mode} save/read never presents confirmed success or loses the draft`, async () => {
  let bad = false;
  const f = profileFixture({ before: call => {
    if (call.method === 'PATCH') { bad = true; return response({ revision: 2, name: 'new' }); }
    if (bad) { if (mode === 'failed') throw new Error('read failed'); return response({ revision: 2 }); }
  } }), m = mounted(f.session); await loadProfile(m);
  await m.ui.perform('save-profile', { name: 'my draft' }); await m.ui.perform('reconcile-profile');
  assert.equal(f.session.snapshot().application.resources.profile.status, 'unknown');
  assert.match(m.root.innerHTML, /value="my draft"/); assert.equal(f.patches().length, 1); m.ui.dispose();
});

test('Profile pending save allows signout, clears draft immediately and fences the late result', async () => {
  const entered = deferred(), finish = deferred();
  const f = profileFixture({ before: async (call, state) => {
    if (call.method === 'PATCH') { entered.resolve(); await finish.promise; return response({ ...state.saved, revision: 2, name: call.payload.name }); }
  } }), m = mounted(f.session); await loadProfile(m);
  const save = m.ui.perform('save-profile', { name: 'private profile draft' }); await entered.promise;
  await assert.rejects(m.ui.perform('profile'), /operation_in_progress/);
  const signout = m.ui.perform('signout'); assert.doesNotMatch(m.root.innerHTML, /private profile draft|Provisioned member/);
  const retiredSave = assert.rejects(save, error => error.code === 'stale_generation');
  finish.resolve(); await Promise.all([retiredSave, signout]);
  assert.equal(f.session.snapshot().status, 'anonymous'); assert.doesNotMatch(m.root.innerHTML, /private profile draft/); m.ui.dispose();
});

test('Profile navigation, suspension, generation change, disposal and remount retain fences without fetching or replay', async () => {
  const entered = deferred(), finish = deferred(); let delay = false;
  const f = profileFixture({ before: async call => { if (delay && call.method === 'GET') { entered.resolve(); await finish.promise; } } }), m = mounted(f.session);
  await loadProfile(m); await m.root.emit('input', { target: profileForm(m, { name: 'discard me' }) });
  delay = true; const read = m.ui.perform('profile'); await entered.promise;
  await m.ui.perform('navigate', { id: 'workout' }); finish.resolve(); await read;
  assert.doesNotMatch(m.root.innerHTML, /discard me|Your profile draft/);
  await m.hide(); const count = f.calls.length; await m.show(); await m.ui.perform('resume'); assert.equal(f.calls.length, count);
  await m.ui.perform('navigate', { id: 'preferences' }); assert.doesNotMatch(m.root.innerHTML, /discard me/);
  await m.root.emit('input', { target: profileForm(m, { name: 'old generation draft' }) });
  await m.ui.perform('refresh'); await m.ui.perform('navigate', { id: 'preferences' }); assert.doesNotMatch(m.root.innerHTML, /old generation draft/);
  m.ui.dispose(); assert.equal(m.root.innerHTML, '');
  const n = mounted(f.session); assert.doesNotMatch(n.root.innerHTML, /old generation draft/); n.ui.dispose();
});

test('unknown Profile outcome survives suspension and remount without a retry recipe or late content', async () => {
  const f = profileFixture({ before: call => { if (call.method === 'PATCH') throw new Error('lost'); } }), m = mounted(f.session); await loadProfile(m);
  await m.ui.perform('save-profile', { name: 'private unsaved' }); await m.hide(); assert.doesNotMatch(m.root.innerHTML, /private unsaved/);
  await m.show(); await m.ui.perform('resume'); assert.doesNotMatch(m.root.innerHTML, /private unsaved/);
  const count = f.calls.length; m.ui.dispose(); const n = mounted(f.session);
  assert.equal(f.calls.length, count); assert.match(n.root.innerHTML, /Check profile save outcome/);
  await assert.rejects(n.ui.perform('retry-write'), /exact_retry_unavailable/); assert.equal(f.patches().length, 1); n.ui.dispose();
});

test('unavailable default Profile controls perform no resource requests', async () => {
  const m = mounted(createUnavailableApplicationSession(), { keyFactory: undefined });
  for (const action of ['profile', 'save-profile', 'replace-profile-draft', 'goal-add', 'goal-remove', 'reconcile-profile']) await assert.rejects(m.ui.perform(action), /session_not_ready/);
  assert.doesNotMatch(m.root.innerHTML, /Your profile draft/); m.ui.dispose();
});
