const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../../..'), cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative); assert.ok(file.startsWith(root + path.sep));
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'));
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { MatchingController } = load('community/matching/controller.ts');
const { createMatchingController } = load('community/matching/index.ts');
const { CommunityResources } = load('api/community.ts');
const { FormTransport } = load('api/transport.ts');
const at = '2026-10-09T12:00:00.000Z';
const preferences = () => ({ alias: 'Leaf', intent: 'accountability', language: 'en', goals: ['strength'],
  region: null, location: 'nonlocal_preferred', priorities: ['goals', 'location'],
  relax: { broaderRegion: false, mixedGoals: false }, willingHost: false, fillExistingGroups: false,
  membershipDisclosureAccepted: true, policyVersion: 'community-v1' });
const matching = (overrides = {}) => ({ revision: 0, generation: 0, state: 'cancelled', preferences: null,
  assignedGroupId: null, queuedAt: null, cooldownUntil: null, missedBatches: 0, relaxation: [], ...overrides });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function fixture(resourceBound = false) {
  const calls = [], state = { value: matching(), handler: null };
  const transport = new FormTransport('https://synthetic.invalid', {
    load: async () => null, save: async () => {}, clear: async () => {},
  }, async (url, options) => {
    if (url.includes('/api/auth/sign-in')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic-session' } });
    const call = { path: new URL(url).pathname, method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body), raw: options.body,
      key: options.headers['Idempotency-Key'] };
    calls.push(call);
    const result = state.handler ? await state.handler(call) : state.value;
    return result instanceof Response ? result : json(result);
  });
  await transport.signIn('synthetic@example.invalid', 'synthetic-password');
  const guard = transport.captureAuthContext();
  const mount = { current: true };
  const resources = new CommunityResources(transport, () => mount.current);
  const controller = resourceBound ? createMatchingController(resources) : new MatchingController(resources, {
    isCurrent: () => guard.isCurrent(), subscribe: listener => transport.subscribeAuthChanges(listener),
  });
  return { calls, state, transport, resources, controller, mount };
}
const unknown = error => error.originalEffectUnknown === true;

test('read is explicit and never opts in, imports contacts, or allocates a command', async () => {
  const f = await fixture();
  assert.equal(f.controller.getSnapshot().read.status, 'idle');
  assert.deepEqual(f.calls, []);
  assert.throws(() => f.controller.enroll(preferences(), 'enroll'), { code: 'matching_read_required' });
  await f.controller.load();
  assert.deepEqual(f.controller.getSnapshot().read.data, matching());
  assert.equal(f.controller.getSnapshot().command.status, 'idle');
  assert.deepEqual(f.calls.map(c => [c.path, c.method, c.key]), [['/v1/community/me/matching', 'GET', undefined]]);
});

test('enroll, update and cancel send exact explicit preferences and latest read revision', async () => {
  const f = await fixture(); await f.controller.load();
  const input = preferences();
  await f.controller.enroll(input, 'enroll');
  assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 0, preferences: input });
  assert.equal(f.calls.at(-1).path, '/v1/community/me/matching/enroll');
  assert.equal(f.controller.getSnapshot().read.status, 'stale');
  assert.equal(f.controller.getSnapshot().command.status, 'confirmed');
  assert.throws(() => f.controller.update(input, 'update'), { code: 'matching_read_required' });
  f.state.value = matching({ revision: 7, generation: 2, state: 'queued', preferences: input, queuedAt: at });
  await f.controller.load();
  const updated = { ...input, region: 'US-NE', location: 'local_preferred', goals: ['mobility', 'consistency'] };
  await f.controller.update(updated, 'update');
  assert.equal(f.calls.at(-1).method, 'PATCH');
  assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 7, preferences: updated });
  f.state.value = matching({ revision: 8 }); await f.controller.load(); await f.controller.cancel('cancel');
  assert.equal(f.calls.at(-1).path, '/v1/community/me/matching/cancel');
  assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 8 });
});

test('queued wait, relaxation, assignment and later generations remain server projections', async () => {
  const f = await fixture();
  for (const value of [
    matching({ revision: 2, generation: 1, state: 'queued', preferences: preferences(), queuedAt: at,
      missedBatches: 9, cooldownUntil: at, relaxation: ['mixed_goals'] }),
    matching({ revision: 3, generation: 1, state: 'assigned', assignedGroupId: '00000000-0000-4000-8000-000000000001', preferences: preferences() }),
    matching({ revision: 4, generation: 2, state: 'queued', preferences: preferences(), queuedAt: at }),
  ]) {
    f.state.value = value; await f.controller.load();
    assert.deepEqual(f.controller.getSnapshot().read.data, value);
    assert.equal(f.controller.getSnapshot().command.status, 'idle');
  }
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('published preferences and nested arrays cannot be mutated by consumers', async () => {
  const f = await fixture();
  f.state.value = matching({ revision: 1, state: 'queued', preferences: preferences() });
  await f.controller.load();
  const snapshot = f.controller.getSnapshot();
  assert.ok(Object.isFrozen(snapshot.read.data.preferences.relax));
  assert.throws(() => snapshot.read.data.preferences.goals.push('mobility'), TypeError);
  assert.deepEqual(f.controller.getSnapshot().read.data.preferences.goals, ['strength']);
});

test('API validation rejects unaccepted disclosure, missing location and undeclared age or contacts', async () => {
  const f = await fixture();
  for (const input of [
    { ...preferences(), membershipDisclosureAccepted: false },
    { ...preferences(), location: undefined },
    { ...preferences(), age: 40 },
    { ...preferences(), contacts: [] },
  ]) {
    await f.controller.load();
    await assert.rejects(f.controller.enroll(input, 'invalid'), { code: 'community_invalid_input' });
    assert.equal(f.controller.getSnapshot().command.error.originalEffectUnknown, false);
  }
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('unknown mutation survives reload and retries only original key, payload and revision', async () => {
  const f = await fixture(); await f.controller.load();
  f.state.handler = () => { throw new Error('synthetic lost response'); };
  const input = preferences();
  await assert.rejects(f.controller.enroll(input, 'original'), unknown);
  const original = f.calls.at(-1);
  input.goals.push('mobility'); input.location = 'anywhere';
  assert.throws(() => f.controller.cancel('replacement'), { code: 'matching_reconciliation_required' });
  f.state.handler = null; f.state.value = matching({ revision: 9, state: 'assigned', assignedGroupId: '00000000-0000-4000-8000-000000000001', preferences: preferences() });
  await f.controller.load();
  assert.equal(f.controller.getSnapshot().command.error.originalEffectUnknown, true);
  assert.throws(() => f.controller.update(preferences(), 'replacement'), { code: 'matching_reconciliation_required' });
  await f.controller.retry();
  assert.deepEqual(f.calls.at(-1), original);
  assert.equal(f.controller.getSnapshot().command.status, 'confirmed');
  assert.equal(f.controller.getSnapshot().read.status, 'stale');
  await f.controller.load();
  assert.equal(f.controller.getSnapshot().read.data.state, 'assigned');
  assert.throws(() => f.controller.retry(), { code: 'matching_retry_unavailable' });
});

test('definite retry rejection does not erase an earlier unknown effect', async () => {
  const f = await fixture(); await f.controller.load();
  f.state.handler = () => { throw new Error('synthetic timeout'); };
  await assert.rejects(f.controller.cancel('unknown-cancel'), unknown);
  f.state.handler = () => json({ code: 'revision_conflict', message: 'Conflict' }, 409);
  await assert.rejects(f.controller.retry(), unknown);
  assert.equal(f.controller.getSnapshot().command.intent.originalEffectUnknown, true);
  assert.throws(() => f.controller.enroll(preferences(), 'another'), { code: 'matching_reconciliation_required' });
});

test('known rejection requires reload and a fresh command key', async () => {
  const f = await fixture(); await f.controller.load();
  f.state.handler = () => json({ code: 'revision_conflict', message: 'Conflict' }, 409);
  await assert.rejects(f.controller.cancel('rejected'), { code: 'revision_conflict' });
  assert.equal(f.controller.getSnapshot().command.error.originalEffectUnknown, false);
  assert.throws(() => f.controller.cancel('fresh'), { code: 'matching_read_required' });
  f.state.handler = null; f.state.value = matching({ revision: 3 }); await f.controller.load();
  assert.throws(() => f.controller.cancel('rejected'), { code: 'matching_key_used' });
  await f.controller.cancel('fresh');
  assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 3 });
});

test('pending commands serialize taps, reads and retries without another request', async () => {
  const f = await fixture(); await f.controller.load();
  const pending = deferred(); f.state.handler = () => pending.promise;
  const operation = f.controller.enroll(preferences(), 'pending');
  assert.equal(f.controller.getSnapshot().command.status, 'pending');
  assert.throws(() => f.controller.cancel('cancel'), { code: 'matching_command_pending' });
  assert.throws(() => f.controller.retry(), { code: 'matching_retry_unavailable' });
  await assert.rejects(f.controller.load(), { code: 'matching_command_pending' });
  assert.equal(f.calls.length, 2);
  pending.resolve(matching({ revision: 1, state: 'queued', preferences: preferences() })); await operation;
});

test('late reads cannot overwrite newer reads or invalidate a later command', async () => {
  const f = await fixture(); const first = deferred();
  f.state.handler = () => first.promise;
  const early = f.controller.load();
  f.state.handler = null; f.state.value = matching({ revision: 5 });
  await f.controller.load();
  await f.controller.cancel('cancel');
  first.resolve(matching({ revision: 1 })); await early;
  assert.equal(f.controller.getSnapshot().read.status, 'stale');
  assert.equal(f.controller.getSnapshot().command.key, 'cancel');
  assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 5 });
});

test('auth changes immediately clear presentation and reject late command receipts', async () => {
  const f = await fixture(); await f.controller.load();
  const pending = deferred(); f.state.handler = () => pending.promise;
  const operation = f.controller.enroll(preferences(), 'old-account');
  await f.transport.signIn('replacement@example.invalid', 'synthetic-password');
  assert.equal(f.controller.getSnapshot().disposed, true);
  assert.equal(f.controller.getSnapshot().read.data, null);
  assert.equal(f.controller.getSnapshot().command.key, null);
  pending.resolve(matching({ revision: 1, state: 'queued', preferences: preferences() }));
  await assert.rejects(operation, error => error.code === 'session_changed' && error.originalEffectUnknown);
  assert.throws(() => f.controller.cancel('new-account'), { code: 'session_changed' });
  assert.equal(f.calls.length, 2);
});

test('unmount clears presentation and suppresses late read publications', async () => {
  const f = await fixture(); const pending = deferred();
  f.state.handler = () => pending.promise;
  const operation = f.controller.load();
  let notifications = 0; f.controller.subscribe(() => notifications++);
  f.controller.dispose(); assert.equal(notifications, 1);
  pending.resolve(matching()); await assert.rejects(operation, { code: 'session_changed' });
  assert.equal(notifications, 1);
  assert.equal(f.controller.getSnapshot().read.data, null);
});

test('keys belonging to other resource intents cannot be adopted or retried', async () => {
  const f = await fixture();
  f.state.handler = () => { throw new Error('synthetic foreign unknown'); };
  await assert.rejects(f.resources.createGroup({ name: 'Group', alias: 'Leaf', membershipDisclosureAccepted: true }, 'foreign'), unknown);
  f.state.handler = null; await f.controller.load();
  assert.throws(() => f.controller.enroll(preferences(), 'foreign'), { code: 'matching_key_used' });
  assert.throws(() => f.controller.retry(), { code: 'matching_retry_unavailable' });
  assert.equal(f.calls.length, 2);
});

test('observer exceptions cannot change outcomes and input is captured before pending notification', async () => {
  const f = await fixture(); await f.controller.load();
  const input = preferences();
  f.controller.subscribe(() => { input.goals.push('mobility'); throw new Error('synthetic observer failure'); });
  await f.controller.enroll(input, 'observer');
  assert.deepEqual(f.calls.at(-1).body.preferences.goals, ['strength']);
  assert.equal(f.controller.getSnapshot().command.status, 'confirmed');
});

test('disposal by a pending observer prevents dispatch', async () => {
  const f = await fixture(); await f.controller.load();
  f.controller.subscribe(() => { if (f.controller.getSnapshot().command.status === 'pending') f.controller.dispose(); });
  await assert.rejects(f.controller.enroll(preferences(), 'unmounted'), { code: 'session_changed' });
  assert.equal(f.calls.length, 1);
});

test('malformed projection is a read error or an uncertain mutation, never a confirmed assignment', async () => {
  const f = await fixture(); f.state.value = { ...matching(), contacts: [] };
  await assert.rejects(f.controller.load(), { code: 'community_invalid_response' });
  assert.equal(f.controller.getSnapshot().read.data, null);
  f.state.value = matching(); await f.controller.load();
  f.state.value = { ...matching({ state: 'assigned' }), groupId: 'invented' };
  await assert.rejects(f.controller.enroll(preferences(), 'bad-receipt'), unknown);
  assert.equal(f.controller.getSnapshot().command.status, 'error');
  assert.equal(f.controller.getSnapshot().read.data, null);
});

test('resource-bound factory is inert until explicit matching reads and commands', async () => {
  const f = await fixture(true);
  assert.deepEqual(f.calls, []);
  assert.equal(f.controller.getSnapshot().read.status, 'idle');
  await f.controller.load();
  await f.controller.enroll(preferences(), 'bound-enroll');
  assert.deepEqual(f.calls.map(c => [c.path, c.method]), [
    ['/v1/community/me/matching', 'GET'], ['/v1/community/me/matching/enroll', 'POST'],
  ]);
  assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 0, preferences: preferences() });
  f.state.value = matching({ revision: 2, state: 'queued', preferences: preferences() });
  await f.controller.load();
  const local = { ...preferences(), location: 'local_preferred', region: 'US-NE' };
  await f.controller.update(local, 'bound-update');
  assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 2, preferences: local });
  await f.controller.load(); await f.controller.cancel('bound-cancel');
  assert.equal(f.calls.at(-1).path, '/v1/community/me/matching/cancel');
  assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 2 });
});

test('resource disposal immediately clears factory consumer without another operation', async () => {
  const f = await fixture(true); await f.controller.load();
  const notifications = [];
  f.controller.subscribe(() => notifications.push(f.controller.getSnapshot()));
  f.resources.dispose();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].disposed, true);
  assert.equal(notifications[0].read.data, null);
  assert.equal(notifications[0].command.key, null);
  await assert.rejects(f.controller.load(), { code: 'session_changed' });
  assert.equal(f.calls.length, 1);
});

test('factory follows resource auth changes and cannot publish a late assignment', async () => {
  const f = await fixture(true); await f.controller.load();
  const pending = deferred(); f.state.handler = () => pending.promise;
  const operation = f.controller.enroll(preferences(), 'bound-old-account');
  const notifications = [];
  f.controller.subscribe(() => notifications.push(f.controller.getSnapshot()));
  await f.transport.signIn('replacement@example.invalid', 'synthetic-password');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].disposed, true);
  pending.resolve(matching({ revision: 1, state: 'assigned', assignedGroupId: '00000000-0000-4000-8000-000000000001', preferences: preferences() }));
  await assert.rejects(operation, error => error.code === 'session_changed' && error.originalEffectUnknown);
  assert.equal(notifications.length, 1);
  assert.throws(() => f.controller.cancel('replacement'), { code: 'session_changed' });
  assert.equal(f.calls.length, 2);
});

test('factory disposal releases its child while keeping siblings and shared resources usable', async () => {
  const f = await fixture(true);
  const sibling = f.resources.createGroupController();
  const childLifetimes = [];
  const createChild = f.resources.createGroupController.bind(f.resources);
  f.resources.createGroupController = () => {
    const child = createChild(); childLifetimes.push(child); return child;
  };
  const another = createMatchingController(f.resources);
  another.dispose(); another.dispose();
  assert.equal(childLifetimes.length, 1);
  assert.equal(childLifetimes[0].getSnapshot().disposed, true);
  assert.equal(sibling.getSnapshot().disposed, false);
  assert.deepEqual(await f.resources.readMatching(), matching());
  await f.controller.load();
  assert.equal(f.controller.getSnapshot().disposed, false);
  await assert.rejects(another.load(), { code: 'session_changed' });
  assert.equal(f.calls.length, 2);
});

test('expired mounted resource fences a factory consumer before dispatch', async () => {
  const f = await fixture(true); await f.controller.load();
  f.mount.current = false;
  assert.throws(() => f.controller.enroll(preferences(), 'expired'), { code: 'session_changed' });
  assert.equal(f.controller.getSnapshot().disposed, true);
  assert.equal(f.controller.getSnapshot().read.data, null);
  assert.equal(f.calls.length, 1);
  assert.throws(() => createMatchingController(f.resources), { code: 'session_changed' });
});
