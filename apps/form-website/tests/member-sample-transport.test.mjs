import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampleTransport } from '../public/member-sample/sample-transport.mjs';
import { createSyntheticApplicationController } from '../public/application-controller.mjs';
import { createSyntheticContractAdapter, parseCapabilities, parseEntitlements, parseMe } from '../public/account.mjs';
import { parseSession, parseStats } from '../public/resource-contract.mjs';

const browserOrigin = 'https://web.invalid';
const config = { apiBase: 'https://api.invalid', verifiedBrowserOrigin: browserOrigin, trackingEnabled: false };
const now = () => Date.parse('2026-10-18T12:00:00.000Z');
const options = fetchImpl => ({ config, browserOrigin, fetchImpl });
const fields = { name: 'Fictional test plan', minutes: 25, items: [
  { id: 'row_one', exerciseId: 'goblet-squat', setTarget: 3, repMin: 6, repMax: 8, targetKg: 24 },
] };
const confirmed = state => { assert.equal(state.status, 'ready', JSON.stringify(state.error)); return state.data; };
const request = (transport, path, method = 'GET', body, key) => transport.fetchImpl(`https://api.invalid${path}`, {
  method, headers: { ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function fixture({ empty = false, plus = false, fetchWrapper } = {}) {
  const transport = createSampleTransport({ now, seed: 42, plus });
  if (empty) transport.setScenario('empty');
  const controller = createSyntheticApplicationController(options(fetchWrapper ? fetchWrapper(transport.fetchImpl) : transport.fetchImpl));
  assert.equal((await controller.bindIdentity()).status, 'ready');
  return { transport, controller };
}
const refreshWorkout = async (controller, session) => confirmed(await controller.workout(session.id));

test('seeded fictional resources pass actual parsers and totals derive from performed history', async () => {
  const { controller: c, transport: t } = await fixture({ plus: true });
  assert.equal(t.runtimeQualified, false);
  assert.equal(parseCapabilities(await (await request(t, '/v1/capabilities')).json()).registration, 'closed');
  const account = parseMe(await (await request(t, '/v1/me')).json());
  assert.equal(account.accountId, account.appAccountToken);
  const grants = parseEntitlements(await (await request(t, '/v1/entitlements')).json(), account);
  assert.deepEqual(grants.active, ['form_plus']); assert.equal(grants.purchases, 'unavailable');
  confirmed(await c.profile()); confirmed(await c.preferences());
  const exercises = confirmed(await c.exercises()), plans = confirmed(await c.plans());
  assert.ok(plans.items[0].items.every(item => exercises.items.some(exercise => exercise.id === item.exerciseId)));
  const history = confirmed(await c.history()), totals = confirmed(await c.stats());
  assert.equal(history.items.length, 2);
  const sets = history.items.flatMap(session => parseSession(session).sets).filter(set => set.status === 'confirmed');
  assert.equal(totals.completedSessions, 2);
  assert.equal(totals.confirmedSets, sets.length);
  assert.equal(totals.repetitions, sets.reduce((sum, set) => sum + set.reps, 0));
  assert.equal(totals.volumeKg, sets.reduce((sum, set) => sum + set.reps * set.weightKg, 0));
  assert.notEqual(history.items[0].sets[0].weightKg, history.items[0].occurrences[0].target.targetKg);
});

test('real controller runs create, edit, start, log, edit, void, complete, history, stats and archive', async () => {
  const { controller: c } = await fixture({ empty: true });
  assert.equal((await c.plans()).status, 'empty'); assert.equal((await c.history()).status, 'empty');
  assert.equal(confirmed(await c.stats()).confirmedSets, 0);
  let plan = confirmed(await c.createPlan(fields, 'create'));
  plan = confirmed(await c.editPlan(plan, { name: 'Edited fictional plan' }));
  let session = confirmed(await c.startWorkout(plan, 'start'));
  assert.equal(session.revision, 1); assert.deepEqual(session.sets, []);
  const setFields = { occurrenceId: session.occurrences[0].id, setNumber: 1, reps: 6, weightKg: 10, status: 'confirmed' };
  const first = confirmed(await c.addSet(session, setFields, 'add')).set;
  session = await refreshWorkout(c, session);
  assert.equal(session.revision, 2);
  const changed = confirmed(await c.editSet(session, first, { reps: 7, weightKg: 12, status: 'confirmed' }, 'edit')).set;
  assert.equal(changed.revision, 2); session = await refreshWorkout(c, session);
  const second = confirmed(await c.addSet(session, { ...setFields, setNumber: 2, reps: 0, status: 'draft' }, 'draft')).set;
  session = await refreshWorkout(c, session);
  assert.equal(confirmed(await c.stats()).confirmedSets, 1);
  confirmed(await c.voidSet(session, changed, 'void')); session = await refreshWorkout(c, session);
  assert.equal(confirmed(await c.stats()).confirmedSets, 0);
  confirmed(await c.editSet(session, second, { reps: 8, weightKg: 14, status: 'confirmed' }, 'confirm'));
  session = await refreshWorkout(c, session);
  assert.equal(session.revision, 6);
  assert.equal(session.occurrences[0].target.targetKg, 24);
  session = confirmed(await c.completeWorkout(session, 'complete'));
  assert.equal(session.revision, 7); assert.equal(session.status, 'completed');
  assert.throws(() => c.addSet(session, { ...setFields, setNumber: 3 }, 'too_late'), /session_completed/);
  const history = confirmed(await c.history()), stats = confirmed(await c.stats());
  assert.equal(history.items[0].id, session.id);
  assert.deepEqual({ sets: stats.confirmedSets, reps: stats.repetitions, volume: stats.volumeKg, sessions: stats.completedSessions },
    { sets: 1, reps: 8, volume: 112, sessions: 1 });
  assert.equal(c.snapshot().workoutSummaries[`workout:${session.id}`].data.performed.volumeKg, 112);
  assert.equal(confirmed(await c.archivePlan(plan, 'archive')).archived, true);
  assert.equal((await c.startWorkout(plan, 'old_revision')).status, 'conflict');
  assert.equal((await refreshWorkout(c, session)).planSnapshot.archived, false);
});

test('history uses opaque account-scoped pages and totals include active confirmed sets', async () => {
  const { controller: c, transport: t } = await fixture();
  const first = confirmed(await c.history({ limit: 1 })); assert.ok(first.nextBefore);
  const second = confirmed(await c.history({ limit: 1, before: first.nextBefore }));
  assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextBefore, null);
  const initial = confirmed(await c.stats()), plan = confirmed(await c.plans()).items[0];
  const session = confirmed(await c.startWorkout(plan, 'active'));
  confirmed(await c.addSet(session, { occurrenceId: session.occurrences[0].id, setNumber: 1, reps: 5, weightKg: 2.5, status: 'confirmed' }, 'active_set'));
  const totals = confirmed(await c.stats());
  assert.equal(totals.completedSessions, initial.completedSessions);
  assert.equal(totals.volumeKg, initial.volumeKg + 12.5);
  c.clear(); t.switchAccount(); await c.bindIdentity();
  assert.equal((await c.history({ before: first.nextBefore })).status, 'error');
});

test('read errors and malformed resource responses fail through real client states and recover once', async () => {
  const { controller: c, transport: t } = await fixture();
  t.setScenario('read-error'); assert.equal((await c.plans()).status, 'error');
  const initial = confirmed(await c.plans());
  t.setScenario('malformed-response'); const malformed = await c.plans();
  assert.equal(malformed.status, 'stale'); assert.equal(malformed.error.code, 'invalid_plans');
  assert.deepEqual(malformed.data, initial); confirmed(await c.plans());
  t.setScenario('conflict'); const conflict = await c.createPlan(fields, 'conflict');
  assert.equal(conflict.status, 'conflict'); assert.equal(conflict.error.effect, 'none');
  assert.equal(confirmed(await c.plans()).items.length, initial.items.length);
  confirmed(await c.createPlan(fields, 'conflict'));
});

test('revision conflicts and retired item identities leave committed plans and sets unchanged', async () => {
  const { controller: c } = await fixture({ empty: true });
  const original = confirmed(await c.createPlan(fields, 'plan'));
  const edited = confirmed(await c.editPlan(original, { name: 'Later revision' }));
  assert.equal((await c.editPlan(original, { name: 'Stale edit' })).status, 'conflict');
  assert.equal(confirmed(await c.plan(original.id)).name, edited.name);
  const replacement = { ...fields.items[0], id: 'replacement', exerciseId: 'floor-press' };
  const removed = confirmed(await c.editPlan(edited, { items: [replacement] }));
  assert.equal((await c.editPlan(removed, { items: [{ ...replacement, id: fields.items[0].id }] })).status, 'conflict');
  let session = confirmed(await c.startWorkout(removed, 'session'));
  const initial = session;
  const input = { occurrenceId: session.occurrences[0].id, setNumber: 1, reps: 5, weightKg: 10, status: 'confirmed' };
  const set = confirmed(await c.addSet(session, input, 'set')).set;
  assert.equal((await c.addSet(initial, { ...input, setNumber: 2 }, 'stale_set')).status, 'conflict');
  session = await refreshWorkout(c, session);
  confirmed(await c.editSet(session, set, { reps: 6, weightKg: 12, status: 'confirmed' }, 'set_edit'));
  session = await refreshWorkout(c, session);
  assert.equal((await c.voidSet(session, set, 'stale_void')).status, 'conflict');
  assert.equal((await refreshWorkout(c, session)).sets[0].reps, 6);
});

test('lost keyed reply holds unknown through readback; exact replay returns the original detached receipt', async () => {
  const { controller: c, transport: t } = await fixture({ empty: true });
  t.setScenario('lost-write-response');
  const lost = await c.createPlan(fields, 'lost');
  assert.equal(lost.status, 'unknown'); assert.equal(lost.error.effect, 'unknown');
  const existing = confirmed(await c.plans()).items;
  assert.equal(existing.length, 1); assert.equal(c.snapshot().resources['plans:create'].status, 'unknown');
  const count = t.calls.filter(call => call.method !== 'GET').length;
  assert.equal((await c.createPlan(fields, 'different')).status, 'unknown');
  assert.equal(t.calls.filter(call => call.method !== 'GET').length, count);
  const original = confirmed(await c.createPlan(fields, 'lost'));
  assert.equal(original.id, existing[0].id); assert.equal(confirmed(await c.plans()).items.length, 1);
  confirmed(await c.editPlan(original, { name: 'Later name' }));
  const replay = await request(t, '/v1/plans', 'POST', fields, 'lost');
  assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), original);
  const detached = await replay.json(); detached.name = 'Cannot mutate receipt';
  assert.deepEqual(await replay.json(), original);
  assert.equal((await request(t, '/v1/plans', 'POST', { ...fields, name: 'Wrong intent' }, 'lost')).status, 409);
  assert.equal(confirmed(await c.plan(original.id)).name, 'Later name');
});

test('lost set and completion receipts replay after later revisions without duplicate effects', async () => {
  const { controller: c, transport: t } = await fixture({ empty: true });
  const plan = confirmed(await c.createPlan(fields, 'plan'));
  let session = confirmed(await c.startWorkout(plan, 'start'));
  const initial = session, input = { occurrenceId: session.occurrences[0].id, setNumber: 1, reps: 6, weightKg: 10, status: 'confirmed' };
  t.setScenario('lost-write-response'); assert.equal((await c.addSet(initial, input, 'set')).status, 'unknown');
  session = await refreshWorkout(c, session); assert.equal(session.sets.length, 1);
  const receipt = confirmed(await c.addSet(initial, input, 'set'));
  assert.equal(receipt.set.id, session.sets[0].id);
  const beforeCompletion = session;
  t.setScenario('lost-write-response'); assert.equal((await c.completeWorkout(session, 'finish')).status, 'unknown');
  const readback = await c.workout(session.id);
  assert.equal(readback.status, 'unknown'); assert.equal(readback.data.status, 'completed');
  confirmed(await c.completeWorkout(beforeCompletion, 'finish'));
  const rawReplay = await request(t, `/v1/workout-sessions/${session.id}/sets`, 'POST', { ...input, expectedRevision: initial.revision }, 'set');
  assert.deepEqual(await rawReplay.json(), receipt);
  assert.equal(confirmed(await c.stats()).confirmedSets, 1);
  assert.equal(confirmed(await c.stats()).completedSessions, 1);
});

test('revision-only preferences and profile losses require explicit reconciliation', async () => {
  const { controller: c, transport: t } = await fixture();
  const prefs = confirmed(await c.preferences()); t.setScenario('lost-write-response');
  assert.equal((await c.savePreferences(prefs, { mascot: 'none', equipment: [], remindersEnabled: false })).status, 'unknown');
  assert.equal((await c.preferences()).status, 'unknown');
  const reconciled = confirmed(await c.reconcilePreferences()); assert.equal(reconciled.revision, prefs.revision + 1);
  assert.deepEqual(reconciled.equipment, []);
  assert.equal((await c.savePreferences(prefs, { loadUnit: 'lb' })).status, 'conflict');
  const profile = confirmed(await c.profile()); t.setScenario('lost-write-response');
  assert.equal((await c.saveProfile(profile, { name: ' Fictional changed name ', goals: [], age: null })).status, 'unknown');
  assert.equal((await c.profile()).status, 'unknown');
  const saved = confirmed(await c.reconcileProfile()); assert.equal(saved.name, 'Fictional changed name');
  assert.equal(saved.revision, profile.revision + 1); assert.deepEqual(saved.goals, []);
});

test('malformed session revision is rejected without weakening the actual parser', async () => {
  let corrupt = false;
  const { controller: c } = await fixture({ fetchWrapper: fetch => async (url, init) => {
    const result = await fetch(url, init);
    if (corrupt && init.method === 'GET' && new URL(url).pathname.startsWith('/v1/workout-sessions/')) {
      const value = await result.json(); value.revision++;
      return { status: 200, ok: true, json: async () => value };
    }
    return result;
  } });
  const session = confirmed(await c.history()).items[0];
  corrupt = true; const bad = await c.workout(session.id);
  assert.equal(bad.status, 'error'); assert.equal(bad.error.code, 'invalid_session'); assert.equal(bad.data, null);
  corrupt = false; confirmed(await c.workout(session.id));
});

test('account transitions fence delayed old responses; records, receipts and preferences stay separate', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let hold = false;
  const { controller: c, transport: t } = await fixture({ empty: true, fetchWrapper: fetch => async (url, init) => {
    const result = await fetch(url, init);
    if (hold && new URL(url).pathname === '/v1/plans') { entered(); await gate; }
    return result;
  } });
  const primary = c.snapshot().account.accountId;
  const first = confirmed(await c.createPlan(fields, 'shared_key'));
  const prefs = confirmed(await c.preferences()); confirmed(await c.savePreferences(prefs, { loadUnit: 'lb' }));
  hold = true; const pending = c.plans(); await started;
  c.clear(); assert.deepEqual(c.snapshot().resources, {});
  release(); await pending; hold = false;
  t.switchAccount('alternate'); await c.bindIdentity();
  assert.notEqual(c.snapshot().account.accountId, primary); assert.deepEqual(c.snapshot().resources, {});
  assert.equal((await c.plan(first.id)).status, 'error');
  assert.equal(confirmed(await c.preferences()).loadUnit, 'kg');
  const alternate = confirmed(await c.createPlan(fields, 'shared_key')); assert.notEqual(alternate.id, first.id);
  c.clear(); t.switchAccount('primary'); await c.bindIdentity();
  assert.equal(confirmed(await c.plan(first.id)).id, first.id);
  assert.equal(confirmed(await c.preferences()).loadUnit, 'lb');
  assert.equal((await c.plan(alternate.id)).status, 'error');
  c.clear(); t.reset(); await c.bindIdentity();
  assert.equal((await c.plan(first.id)).status, 'error');
  assert.equal(confirmed(await c.preferences()).loadUnit, 'kg');
});

test('membership revocation is coherent, signout denies resources and reset never reuses prior IDs', async () => {
  const { controller: c, transport: t } = await fixture({ plus: true });
  const oldPlan = confirmed(await c.plans()).items[0].id;
  c.clear(); t.setScenario('revoked-membership'); await c.bindIdentity();
  assert.deepEqual(c.snapshot().entitlements.active, []);
  c.clear(); t.setPlus(true); await c.bindIdentity(); assert.deepEqual(c.snapshot().entitlements.active, ['form_plus']);
  const account = createSyntheticContractAdapter(options(t.fetchImpl)); await account.refresh();
  assert.equal((await account.signout()).status, 'anonymous');
  assert.equal((await request(t, '/v1/me')).status, 401);
  await c.plans(); assert.equal(c.snapshot().account, null); assert.deepEqual(c.snapshot().resources.plans.data, null);
  c.clear(); t.reset(); await c.bindIdentity(); assert.equal((await c.plan(oldPlan)).status, 'error');
  t.signout(); assert.equal((await request(t, '/v1/stats')).status, 401);
});

test('transport rejects non-sample destinations and credentials, uses no fallback, and copies JSON results', async () => {
  const t = createSampleTransport({ now });
  for (const url of ['http://api.invalid/v1/me', 'https://example.com/v1/me', 'https://api.invalid.evil/v1/me',
    'https://user@api.invalid/v1/me', 'https://api.invalid/v1/me#fragment', '/v1/me']) {
    await assert.rejects(t.fetchImpl(url));
  }
  await assert.rejects(t.fetchImpl('https://api.invalid/v1/me', { headers: { Authorization: 'fictional' } }), /sample_credentials_forbidden/);
  assert.equal(t.calls.length, 0);
  assert.equal((await request(t, '/api/auth/sign-in/email', 'POST', {})).status, 404);
  const result = await request(t, '/v1/plans'), data = await result.json(); data.items.length = 0;
  assert.equal((await result.json()).items.length, 1);
  assert.throws(() => t.switchAccount('real-account'), /unknown_sample_account/);
  assert.throws(() => t.setScenario('invented'), /unknown_sample_scenario/);
  assert.throws(() => createSampleTransport({ seed: -1 }), /invalid_sample_options/);
});

test('deterministic varied commands preserve revision equations and aggregate conservation', async () => {
  const { controller: c } = await fixture({ empty: true });
  let random = 123456;
  const next = maximum => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % maximum; };
  const plan = confirmed(await c.createPlan(fields, 'varied'));
  let session = confirmed(await c.startWorkout(plan, 'varied_start'));
  for (let index = 1; index <= 12; index++) {
    const input = { occurrenceId: session.occurrences[0].id, setNumber: index, reps: next(12) + 1,
      weightKg: next(60) / 2, status: next(2) ? 'confirmed' : 'draft' };
    let set = confirmed(await c.addSet(session, input, `add_${index}`)).set;
    session = await refreshWorkout(c, session);
    if (index % 2 === 0) {
      set = confirmed(await c.editSet(session, set, { reps: next(12) + 1, weightKg: next(60) / 2, status: 'confirmed' }, `edit_${index}`)).set;
      session = await refreshWorkout(c, session);
    }
    if (index % 3 === 0) { confirmed(await c.voidSet(session, set, `void_${index}`)); session = await refreshWorkout(c, session); }
    assert.equal(parseSession(session).revision, session.sets.reduce((sum, value) => sum + value.revision, 1));
    const totals = parseStats(confirmed(await c.stats())), performed = session.sets.filter(value => value.status === 'confirmed');
    assert.equal(totals.confirmedSets, performed.length);
    assert.equal(totals.volumeKg, performed.reduce((sum, value) => sum + value.reps * value.weightKg, 0));
  }
  confirmed(await c.completeWorkout(session, 'varied_complete'));
  assert.equal(confirmed(await c.stats()).completedSessions, 1);
});
