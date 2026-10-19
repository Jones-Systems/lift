import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFormAdapter, toolDescriptors } from '../src/index.mjs';

const clock = 1000;
const identity = (accountId = 'account_a') => ({
  accountId, subject: `subject_${accountId}`, expiresAtMs: clock + 1000,
  scopes: ['form:workouts:read', 'form:plans:read'],
});
const item = () => ({ id: 'item_1', exerciseId: 'squat', setTarget: 3, repMin: 8, repMax: 10, targetKg: 20 });
const plan = (accountId = 'account_a') => ({
  accountId, id: 'plan_1', name: 'Synthetic plan', minutes: 30, revision: 1, archived: false, items: [item()],
});
const workout = (accountId = 'account_a') => ({
  accountId, id: 'workout_1', planId: 'plan_1', planRevision: 1, revision: 2,
  status: 'completed', startedAt: '2026-10-10T12:00:00.000Z', completedAt: '2026-10-10T12:30:00.000Z',
  occurrences: [{ id: 'occurrence_1', itemId: 'item_1', exerciseId: 'squat', position: 0, target: item() }],
  sets: [{ id: 'set_1', occurrenceId: 'occurrence_1', setNumber: 1, reps: 8, weightKg: 20, status: 'confirmed' }],
});
const adapter = (ports = {}, options = {}) => createFormAdapter({
  verifyIdentity: async () => identity(), now: () => clock, ports, ...options,
});
const body = response => response.structuredContent;
function error(response, code) {
  assert.equal(response.isError, true);
  assert.equal(body(response).ok, false);
  assert.equal(body(response).error.code, code);
  assert.equal(response.content[0].text, body(response).error.message);
}

test('descriptors expose only fixed read tools and explicit bounded schemas', () => {
  assert.deepEqual(toolDescriptors.map(tool => tool.name), [
    'form_capabilities', 'form_list_workouts', 'form_get_workout', 'form_list_plans', 'form_get_plan',
  ]);
  for (const descriptor of toolDescriptors) {
    assert.deepEqual(descriptor.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.equal(descriptor.inputSchema.additionalProperties, false);
    assert.equal(descriptor.outputSchema.type, 'object');
    assert.ok(Object.isFrozen(descriptor.inputSchema.properties));
    assert.equal(Object.hasOwn(descriptor.inputSchema.properties, 'accountId'), false);
  }
  assert.throws(() => { toolDescriptors[0].annotations.readOnlyHint = false; }, TypeError);
});

test('missing injection performs no reads and reports unavailable', async () => {
  let calls = 0;
  const reads = { listWorkouts: () => { calls++; } };
  error(await createFormAdapter({ ports: reads }).dispatch('form_list_workouts', {}), 'unavailable');
  error(await adapter().dispatch('form_list_workouts', {}), 'unavailable');
  error(await adapter().dispatch('form_get_workout', { workoutId: 'workout_1' }), 'unavailable');
  error(await adapter().dispatch('form_list_plans', {}), 'unavailable');
  error(await adapter().dispatch('form_get_plan', { planId: 'plan_1' }), 'unavailable');
  assert.equal(calls, 0);
});

test('capabilities are port availability within verified scopes, never generation or entitlement', async () => {
  let calls = 0;
  const read = () => { calls++; };
  const response = await adapter({ listWorkouts: read, getWorkout: read, listPlans: read, getPlan: read }, {
    verifyIdentity: () => ({ ...identity(), scopes: ['form:workouts:read'] }),
  }).dispatch('form_capabilities', {});
  assert.deepEqual(body(response), { ok: true, data: {
    listWorkouts: true, getWorkout: true, listPlans: false, getPlan: false, workoutGeneration: false, writes: false,
  } });
  assert.equal(calls, 0);
});

test('unknown methods and malformed arguments are rejected before identity or data calls', async () => {
  let calls = 0;
  const instance = adapter({ getWorkout: () => { calls++; } }, { verifyIdentity: () => { calls++; } });
  for (const name of ['__proto__', 'constructor', 'https://example.invalid', 'deleteWorkout']) {
    error(await instance.dispatch(name, {}), 'unknown_tool');
  }
  for (const input of [null, [], 'workout_1', {}, { workoutId: 'workout_1', accountId: 'account_b' },
    { workoutId: '../escape' }, { workoutId: 'x\n' }, { workoutId: 'x'.repeat(81) },
    { workoutId: 'workout_1', method: 'DELETE' }, { workoutId: 'workout_1', url: 'https://example.invalid' }]) {
    error(await instance.dispatch('form_get_workout', input), 'invalid_input');
  }
  assert.equal(calls, 0);
});

test('list argument bounds reject nonintegers, huge pages and invalid cursors before reads', async () => {
  let calls = 0;
  const instance = adapter({ listWorkouts: () => { calls++; } });
  for (const input of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: NaN }, { limit: '10' },
    { before: '' }, { before: 'x'.repeat(513) }, { before: 'http://example.invalid' }, { before: 'x\n' }]) {
    error(await instance.dispatch('form_list_workouts', input), 'invalid_input');
  }
  assert.equal(calls, 0);
});

test('unverified, expired and malformed identities never reach a read port', async () => {
  let reads = 0;
  for (const invalid of [null, {}, { ...identity(), expiresAtMs: clock }, { ...identity(), expiresAtMs: Infinity },
    { ...identity(), accountId: '' }, { ...identity(), subject: 'x\n' }, { ...identity(), scopes: ['x'.repeat(101)] }]) {
    error(await adapter({ listWorkouts: () => { reads++; } }, { verifyIdentity: () => invalid })
      .dispatch('form_list_workouts', {}), 'authentication_required');
  }
  error(await adapter({ listWorkouts: () => { reads++; } }, { verifyIdentity: () => { throw new Error('private auth detail'); } })
    .dispatch('form_list_workouts', {}), 'authentication_required');
  assert.equal(reads, 0);
});

test('tool-specific scopes deny a read even if a port is configured', async () => {
  let reads = 0;
  error(await adapter({ getPlan: () => { reads++; } }, {
    verifyIdentity: () => ({ ...identity(), scopes: ['form:workouts:read'] }),
  }).dispatch('form_get_plan', { planId: 'plan_1' }), 'permission_denied');
  assert.equal(reads, 0);
});

test('each dispatch validates its server context and forwards only an immutable identity and bounded arguments', async () => {
  const contexts = [];
  const requests = [];
  const instance = adapter({ listWorkouts: request => {
    requests.push(request);
    assert.ok(Object.isFrozen(request.identity));
    assert.ok(Object.isFrozen(request.identity.scopes));
    return { accountId: request.identity.accountId, items: [workout(request.identity.accountId)], nextBefore: null };
  } }, { verifyIdentity: context => { contexts.push(context); return identity(context.account); } });
  for (const account of ['account_a', 'account_b']) {
    assert.equal(body(await instance.dispatch('form_list_workouts', { limit: 1, before: 'opaque_cursor' }, { account })).ok, true);
  }
  assert.deepEqual(contexts, [{ account: 'account_a' }, { account: 'account_b' }]);
  assert.deepEqual(requests.map(request => request.identity.accountId), ['account_a', 'account_b']);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['before', 'identity', 'limit']);
});

test('workout page projects summaries and omits account, profile, plan snapshots and set details', async () => {
  let requestedLimit;
  const response = await adapter({ listWorkouts: ({ limit }) => {
    requestedLimit = limit;
    return { accountId: 'account_a', items: [{ ...workout(), email: 'private@example.invalid', planSnapshot: { notes: 'private' } }],
      nextBefore: 'opaque_cursor', internal: 'private' };
  } }).dispatch('form_list_workouts', {});
  assert.equal(requestedLimit, 10);
  assert.deepEqual(body(response), { ok: true, data: { items: [{
    id: 'workout_1', planId: 'plan_1', planRevision: 1, revision: 2, status: 'completed',
    startedAt: '2026-10-10T12:00:00.000Z', completedAt: '2026-10-10T12:30:00.000Z',
  }], nextBefore: 'opaque_cursor' } });
  assert.equal(JSON.stringify(response).includes('private'), false);
});

test('workout detail preserves saved targets and sets, excluding unrequested private fields', async () => {
  const response = await adapter({ getWorkout: () => ({ ...workout(), profile: { injuryHistory: 'private' } }) })
    .dispatch('form_get_workout', { workoutId: 'workout_1' });
  assert.equal(body(response).ok, true);
  assert.deepEqual(body(response).data.sets, workout().sets);
  assert.deepEqual(body(response).data.occurrences, workout().occurrences);
  assert.equal(JSON.stringify(response).includes('private'), false);
  assert.equal(Object.hasOwn(body(response).data, 'accountId'), false);
});

test('saved plan summary and detail have separate bounded projections', async () => {
  const instance = adapter({
    listPlans: ({ limit }) => { assert.equal(limit, 1); return { accountId: 'account_a', items: [plan()], hasMore: true }; },
    getPlan: () => plan(),
  });
  assert.deepEqual(body(await instance.dispatch('form_list_plans', { limit: 1 })), { ok: true, data: {
    items: [{ id: 'plan_1', name: 'Synthetic plan', minutes: 30, revision: 1, archived: false }], hasMore: true,
  } });
  assert.deepEqual(body(await instance.dispatch('form_get_plan', { planId: 'plan_1' })).data.items, [item()]);
});

test('cross-account envelopes or records fail closed without partial list disclosure', async () => {
  for (const raw of [
    { accountId: 'account_b', items: [workout()], nextBefore: null },
    { accountId: 'account_a', items: [workout(), { ...workout('account_b'), id: 'other' }], nextBefore: null },
    { accountId: 'account_a', items: [{ ...workout(), accountId: undefined }], nextBefore: null },
  ]) error(await adapter({ listWorkouts: () => raw }).dispatch('form_list_workouts', {}), 'invalid_result');
  error(await adapter({ getWorkout: () => workout('account_b') }).dispatch('form_get_workout', { workoutId: 'workout_1' }), 'invalid_result');
  error(await adapter({ getPlan: () => plan('account_b') }).dispatch('form_get_plan', { planId: 'plan_1' }), 'invalid_result');
  error(await adapter({ listPlans: () => ({ accountId: 'account_a', items: [plan('account_b')], hasMore: false }) })
    .dispatch('form_list_plans', {}), 'invalid_result');
});

test('an identity that expires while reading cannot disclose the result', async () => {
  let current = clock;
  const instance = adapter({ getPlan: async () => { current = clock + 1000; return plan(); } }, { now: () => current });
  error(await instance.dispatch('form_get_plan', { planId: 'plan_1' }), 'authentication_required');
});

test('identity changes on a later call do not reuse earlier authorization', async () => {
  let valid = true;
  let reads = 0;
  const instance = adapter({ getPlan: () => { reads++; return plan(); } }, { verifyIdentity: () => valid ? identity() : null });
  assert.equal(body(await instance.dispatch('form_get_plan', { planId: 'plan_1' })).ok, true);
  valid = false;
  error(await instance.dispatch('form_get_plan', { planId: 'plan_1' }), 'authentication_required');
  assert.equal(reads, 1);
});

test('port exceptions have fixed safe errors and null details mean not found', async () => {
  const instance = adapter({ getWorkout: () => { throw new Error('private account_b bearer synthetic'); }, getPlan: () => null });
  const response = await instance.dispatch('form_get_workout', { workoutId: 'workout_1' });
  error(response, 'unavailable');
  assert.equal(JSON.stringify(response).includes('private'), false);
  error(await instance.dispatch('form_get_plan', { planId: 'plan_1' }), 'not_found');
});

test('malformed, oversized and mismatched results are rejected rather than truncated', async () => {
  for (const raw of [
    { ...plan(), id: 'other' }, { ...plan(), name: 'x'.repeat(101) }, { ...plan(), minutes: NaN },
    { ...plan(), items: [] }, { ...plan(), items: [item(), item()] },
    { ...plan(), items: [{ ...item(), repMin: 10, repMax: 8 }] },
    { ...plan(), items: Array.from({ length: 51 }, (_, i) => ({ ...item(), id: `item_${i}` })) },
  ]) error(await adapter({ getPlan: () => raw }).dispatch('form_get_plan', { planId: 'plan_1' }), 'invalid_result');
  for (const raw of [
    { ...workout(), id: 'other' }, { ...workout(), completedAt: null },
    { ...workout(), startedAt: '2026-02-30T12:00:00.000Z' },
    { ...workout(), sets: [{ ...workout().sets[0], occurrenceId: 'other' }] },
    { ...workout(), sets: [{ ...workout().sets[0], reps: 0 }] },
    { ...workout(), sets: Array.from({ length: 201 }, (_, i) => ({ ...workout().sets[0], id: `set_${i}` })) },
  ]) error(await adapter({ getWorkout: () => raw }).dispatch('form_get_workout', { workoutId: 'workout_1' }), 'invalid_result');
});

test('page overflow, duplicate IDs and invalid continuation never return a partial page', async () => {
  for (const raw of [
    { accountId: 'account_a', items: [workout(), { ...workout(), id: 'other' }], nextBefore: null },
    { accountId: 'account_a', items: [], nextBefore: 'cursor' },
    { accountId: 'account_a', items: [workout()], nextBefore: 'cursor' },
    { accountId: 'account_a', items: [workout()], nextBefore: 'x'.repeat(513) },
  ]) error(await adapter({ listWorkouts: () => raw }).dispatch('form_list_workouts', { limit: 1, before: 'cursor' }), 'invalid_result');
  error(await adapter({ listPlans: () => ({ accountId: 'account_a', items: [plan(), plan()], hasMore: false }) })
    .dispatch('form_list_plans', {}), 'invalid_result');
});
