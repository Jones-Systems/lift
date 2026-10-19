const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');

const compiled = new Map();
function load(relative, requireModule) {
  const file = resolve(__dirname, '..', relative);
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.get(file))(requireModule, module, module.exports);
  return module.exports;
}
const unexpected = name => { throw new Error(`Unexpected runtime import: ${name}`); };
const { ApiError } = load('../../api/transport.ts', unexpected);
const model = load('model.ts', name => {
  if (name === '../../api/client') return { ApiError };
  if (name === '../cues/CuesScreen') return { normalizeCues: unexpected };
  return unexpected(name);
});
const copy = load('copy.ts', unexpected);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const drain = () => new Promise(resolve => setImmediate(resolve));
const unknown = () => new ApiError(0, 'network_unavailable', 'Response lost', true);
const stale = () => new ApiError(409, 'stale_revision', 'Revision changed');
const draft = number => ({ occurrenceId: 'movement-1', setNumber: number, reps: 8, weightKg: 20, status: 'confirmed' });
const performed = { ...draft(1), id: 'set-1', revision: 1 };
const session = (overrides = {}) => ({ id: 'workout-1', revision: 4, status: 'active', sets: [performed],
  occurrences: [{ id: 'movement-1', target: { setTarget: 3 } }], ...overrides });
const completed = (overrides = {}) => session({ status: 'completed', revision: 5, ...overrides });

function fixture(overrides = {}, initial = session(), source = false) {
  const calls = { complete: [], add: [], edit: [], void: [], reads: [], completed: [], changed: 0, unauthenticated: 0 };
  const resources = {
    completeWorkout: async value => completed({ revision: value.revision + 1 }),
    addSet: async (value, set) => ({ set: { ...set, id: `set-${set.setNumber}`, revision: 1 }, sessionRevision: value.revision + 1 }),
    editSet: async (id, set, changes) => ({ set: { ...set, ...changes, revision: set.revision + 1 }, sessionRevision: 5 }),
    voidSet: async (id, set) => ({ set: { ...set, status: 'voided', revision: set.revision + 1 }, sessionRevision: 5 }),
    workout: async () => session(),
    ...overrides,
  };
  for (const [method, bucket] of Object.entries({ completeWorkout: 'complete', addSet: 'add', editSet: 'edit', voidSet: 'void', workout: 'reads' })) {
    const invoke = resources[method];
    resources[method] = (...args) => { calls[bucket].push(args); return invoke(...args); };
  }
  // Only the hook's ref, reducer and mount cleanup seams are modeled; no renderer or native UI is simulated.
  const slots = []; const cleanups = []; let cursor = 0; let key = 0;
  const react = {
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useReducer(reducer, value) { const index = cursor++; slots[index] ??= value;
      return [slots[index], () => { slots[index] = reducer(slots[index]); }]; },
    useEffect(effect) { const index = cursor++; if (!slots[index]) { slots[index] = true; cleanups.push(effect()); } },
  };
  const hooks = load('useWorkout.ts', name => {
    if (name === 'react') return react;
    if (name === '../../api/client') return { ApiError, commandKey: () => `command-${++key}` };
    if (name === './model') return model;
    if (name === './copy') return copy;
    if (name === './source-rest') return load('source-rest.ts', unexpected);
    return unexpected(name);
  });
  const read = (replacement = {}) => {
    cursor = 0;
    return hooks[source ? 'useSourceWorkout' : 'useWorkout']({ resources, initial, onCompleted: value => calls.completed.push(value),
      onChanged: () => calls.changed++, onUnauthenticated: () => calls.unauthenticated++, ...replacement });
  };
  return { read, calls, unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
}

function attemptSets(workout) {
  workout.logSet(draft(2));
  workout.editSet(performed, { reps: 9, weightKg: 20, status: 'confirmed' });
  workout.voidSet(performed);
}
function assertNoSets(calls) {
  assert.deepEqual([calls.add.length, calls.edit.length, calls.void.length], [0, 0, 0]);
}

test('completion is single-flight across stale callbacks; confirmed completion stays read-only', async () => {
  const pending = deferred();
  const { read, calls } = fixture({ completeWorkout: () => pending.promise });
  const first = read();
  const flight = first.finish();
  const repeats = [first.finish(), read().finish()];
  try { assert.equal(calls.complete.length, 1); }
  finally { pending.resolve(completed()); await Promise.all([flight, ...repeats]); }
  assert.equal(read().session.status, 'completed');
  assert.equal(read().complete, null);
  attemptSets(first); await first.finish(); await read().finish(); await drain();
  assertNoSets(calls);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.completed.length, 1);
});

test('pending completion blocks sets, reset and manual readback from releasing its flight', async () => {
  const pending = deferred();
  const { read, calls } = fixture({ completeWorkout: () => pending.promise, workout: async () => completed() });
  const flight = read().finish();
  read().resetFinish(); attemptSets(read());
  await read().reconcile(); const repeat = read().finish();
  try {
    assertNoSets(calls);
    assert.equal(read().commands.length, 0);
    assert.equal(calls.complete.length, 1);
  } finally { pending.resolve(completed()); await Promise.all([flight, repeat]); }
  assert.equal(calls.completed.length, 1);
});

test('unknown completion retains exact key and body through active/failed readback and same-key retry', async () => {
  const retry = deferred(); let sends = 0; let reads = 0;
  const { read, calls } = fixture({
    completeWorkout: () => ++sends === 1 ? Promise.reject(unknown()) : retry.promise,
    workout: async () => { if (++reads === 1) return session({ revision: 9 }); throw new ApiError(0, 'network_unavailable', 'Offline'); },
  });
  await read().finish(); const retained = read().complete;
  assert.equal(retained.state.status, 'unknown');
  read().resetFinish(); attemptSets(read()); await read().reconcile(); await read().reconcile();
  assertNoSets(calls);
  assert.equal(read().complete.key, retained.key);
  assert.deepEqual(read().complete.payload, { expectedRevision: 4 });
  const flight = read().finish(); const repeat = read().finish(); attemptSets(read());
  try {
    assert.equal(calls.complete.length, 2);
    assert.deepEqual(calls.complete.map(([value, key]) => [value.id, value.revision, key]),
      [['workout-1', 4, retained.key], ['workout-1', 4, retained.key]]);
    assertNoSets(calls);
  } finally { retry.resolve(completed({ revision: 10 })); await Promise.all([flight, repeat]); }
  assert.equal(read().complete, null); assert.equal(calls.completed.length, 1);
});

test('completed readback settles unknown without another completion request', async () => {
  const { read, calls } = fixture({ completeWorkout: async () => { throw unknown(); }, workout: async () => completed() });
  await read().finish(); await read().reconcile(); await read().finish(); attemptSets(read());
  assert.equal(read().complete, null); assert.equal(read().session.status, 'completed');
  assert.equal(calls.complete.length, 1); assert.equal(calls.completed.length, 1); assertNoSets(calls);
});

test('queued set writes settle in order before finish uses their latest session revision', async () => {
  const first = deferred(); let adds = 0;
  const { read, calls } = fixture({ addSet: async (value, set) => ++adds === 1 ? first.promise :
    { set: { ...set, id: 'set-3', revision: 1 }, sessionRevision: 6 } });
  read().logSet(draft(2)); read().logSet(draft(3)); await read().finish();
  assert.equal(calls.add.length, 1); assert.equal(calls.complete.length, 0);
  first.resolve({ set: { ...draft(2), id: 'set-2', revision: 1 }, sessionRevision: 5 }); await drain();
  assert.deepEqual(calls.add.map(([value]) => value.revision), [4, 5]);
  await read().finish(); assert.equal(calls.complete[0][0].revision, 6);
});

test('unknown set blocks finish until its same-key retry settles', async () => {
  let adds = 0;
  const { read, calls } = fixture({ addSet: async (value, set) => {
    if (++adds === 1) throw unknown();
    return { set: { ...set, id: 'set-2', revision: 1 }, sessionRevision: 5 };
  } });
  read().logSet(draft(2)); await drain(); await read().finish();
  assert.equal(calls.complete.length, 0);
  const command = read().commands[0]; read().retryCommand(command.key); await drain();
  assert.equal(calls.add[0][2], calls.add[1][2]);
  await read().finish(); assert.equal(calls.complete[0][0].revision, 5);
});

test('definite completion rejection allows new sets and builds a fresh command at the advanced revision', async () => {
  let finishes = 0;
  const { read, calls } = fixture({ completeWorkout: async value => {
    if (++finishes === 1) throw new ApiError(422, 'invalid_completion', 'Rejected');
    return completed({ revision: value.revision + 1 });
  } });
  await read().finish(); assert.equal(read().complete.state.status, 'failed');
  read().logSet(draft(2)); await drain(); await read().finish();
  assert.equal(calls.add.length, 1);
  assert.deepEqual(calls.complete.map(([value]) => value.revision), [4, 5]);
  assert.notEqual(calls.complete[0][1], calls.complete[1][1]);
});

test('stale completion holds serialization through readback and accepts already completed state', async () => {
  const refresh = deferred();
  const { read, calls } = fixture({ completeWorkout: async () => { throw stale(); }, workout: () => refresh.promise });
  const flight = read().finish(); await drain();
  const repeat = read().finish(); attemptSets(read());
  try { assertNoSets(calls); assert.equal(calls.complete.length, 1); }
  finally { refresh.resolve(completed()); await Promise.all([flight, repeat]); }
  assert.equal(read().complete, null); assert.equal(read().session.status, 'completed');
  assert.equal(calls.completed.length, 1);
});

test('unknown retry with conflict and unavailable readback keeps the original command unresolved', async () => {
  let finishes = 0;
  const { read, calls } = fixture({ completeWorkout: async () => { throw ++finishes === 1 ? unknown() : stale(); },
    workout: async () => { throw new ApiError(0, 'network_unavailable', 'Offline'); } });
  await read().finish(); const original = read().complete;
  await read().finish(); read().resetFinish(); attemptSets(read());
  assert.equal(read().complete.state.status, 'unknown'); assertNoSets(calls);
  assert.equal(read().complete.key, original.key); assert.deepEqual(read().complete.payload, original.payload);
});

test('any later retry rejection preserves the original unknown completion until same-key success', async () => {
  for (const rejection of [new ApiError(422, 'invalid_completion', 'Rejected retry'), new ApiError(500, 'server_error', 'Failed retry')]) {
    let finishes = 0;
    const { read, calls } = fixture({ completeWorkout: async () => {
      if (++finishes === 1) throw unknown();
      if (finishes === 2) throw rejection;
      return completed();
    } });
    await read().finish(); const original = read().complete;
    await read().finish(); read().resetFinish(); attemptSets(read());
    assert.equal(read().complete?.state.status, 'unknown', `Retry ${rejection.status} cannot settle the first attempt`);
    assertNoSets(calls);
    assert.equal(read().complete.key, original.key); assert.deepEqual(read().complete.payload, original.payload);
    await read().finish();
    assert.deepEqual(calls.complete.map(([value, key]) => [value.revision, key]),
      Array.from({ length: 3 }, () => [4, original.key]));
    assert.equal(read().session.status, 'completed'); assert.equal(read().complete, null);
  }
});

test('completed initial state and unmounted callbacks never dispatch session mutations', async () => {
  const closed = fixture({}, completed());
  attemptSets(closed.read()); await closed.read().finish(); assertNoSets(closed.calls); assert.equal(closed.calls.complete.length, 0);
  const open = fixture(); const staleCallbacks = open.read(); open.unmount();
  attemptSets(staleCallbacks); await staleCallbacks.finish();
  assertNoSets(open.calls); assert.equal(open.calls.complete.length, 0);
});

const setMethod = { add: 'addSet', edit: 'editSet', void: 'voidSet' };
function enqueueHead(read, kind) {
  if (kind === 'add') read().logSet(draft(2));
  else if (kind === 'edit') read().editSet(performed, { reps: 9, weightKg: 20, status: 'confirmed' });
  else read().voidSet(performed);
}
function setResponse(kind, args, sessionRevision) {
  const set = kind === 'add' ? { ...args[1], id: 'set-2', revision: 1 }
    : { ...args[1], ...(kind === 'edit' ? args[2] : { status: 'voided' }), revision: args[1].revision + 1 };
  return { set, sessionRevision };
}
const tailCalls = calls => calls.add.filter(([, set]) => set.setNumber === 3);
const headCalls = (calls, kind) => kind === 'add' ? calls.add.filter(([, set]) => set.setNumber === 2) : calls[kind];
const tailResponse = args => ({ set: { ...args[1], id: 'set-3', revision: 1 }, sessionRevision: args[0].revision + 1 });

for (const kind of ['add', 'edit', 'void']) test(`unknown ${kind} retains its request after later 422/500 rejection until same-key success`, async () => {
  for (const status of [422, 500]) {
    let attempts = 0;
    const { read, calls } = fixture({ [setMethod[kind]]: async (...args) => {
      if (kind === 'add' && args[1].setNumber === 3) return tailResponse(args);
      if (++attempts === 1) throw unknown();
      if (attempts === 2) throw new ApiError(status, 'rejected_retry', 'Retry rejected');
      return setResponse(kind, args, 5);
    } });
    enqueueHead(read, kind); await drain();
    const key = read().commands[0].key;
    const first = structuredClone(headCalls(calls, kind)[0]);
    read().logSet(draft(3)); read().retryCommand(key); read().retryCommand(key); await drain();
    await read().finish();
    assert.equal(read().commands[0]?.key, key, `${kind}/${status} retains its original command`);
    assert.equal(read().commands[0].state.status, 'unknown');
    assert.equal(read().notice?.retryKey, key);
    assert.equal(headCalls(calls, kind).length, 2);
    assert.equal(tailCalls(calls).length, 0); assert.equal(calls.complete.length, 0);
    assert.equal(calls.changed, 0);
    read().retryCommand(key); await drain();
    assert.deepEqual(headCalls(calls, kind), [first, first, first]);
    assert.equal(tailCalls(calls).length, 1); assert.equal(tailCalls(calls)[0][0].revision, 5);
    assert.equal(read().commands.length, 0);
    await read().finish(); assert.equal(calls.complete[0][0].revision, 6);
  }
});

for (const readback of ['failed', 'nonmatching']) test(`unknown set conflict with ${readback} readback retains its retry and blocks later commands`, async () => {
  for (const [kind, code] of [['add', 'stale_revision'], ['edit', 'stale_revision'], ['void', 'stale_revision'],
    ['edit', 'set_voided'], ['void', 'set_voided']]) {
    let attempts = 0;
    const { read, calls } = fixture({
      [setMethod[kind]]: async (...args) => {
        if (kind === 'add' && args[1].setNumber === 3) return tailResponse(args);
        if (++attempts === 1) throw unknown();
        throw new ApiError(409, code, 'Changed');
      },
      workout: async () => {
        if (readback === 'failed') throw new ApiError(0, 'network_unavailable', 'Offline');
        return session({ revision: 8 });
      },
    });
    enqueueHead(read, kind); await drain(); const key = read().commands[0].key;
    const first = structuredClone(headCalls(calls, kind)[0]);
    read().logSet(draft(3)); read().retryCommand(key); await drain(); await read().finish();
    assert.equal(read().commands[0]?.key, key, `${kind}/${code} retains the unknown command`);
    assert.equal(read().commands[0].state.status, 'unknown');
    assert.equal(read().notice?.retryKey, key);
    assert.equal(tailCalls(calls).length, 0); assert.equal(calls.complete.length, 0);
    read().retryCommand(key); await drain();
    assert.equal(headCalls(calls, kind).length, 3);
    const request = args => kind === 'add' ? [args[0].id, args[0].revision, args[1], args[2]] : args;
    assert.deepEqual(headCalls(calls, kind).map(request), [request(first), request(first), request(first)]);
  }
});

for (const kind of ['add', 'edit', 'void']) test(`matching ${kind} readback settles the unknown head before dispatching the queued tail`, async () => {
  const pending = deferred();
  const { read, calls } = fixture({
    [setMethod[kind]]: async (...args) => {
      if (kind === 'add' && args[1].setNumber === 3) return tailResponse(args);
      throw unknown();
    },
    workout: () => pending.promise,
  });
  enqueueHead(read, kind); await drain(); read().logSet(draft(3));
  const refresh = read().reconcile();
  const changed = kind === 'add' ? { ...draft(2), id: 'set-2', revision: 1 }
    : { ...performed, ...(kind === 'edit' ? { reps: 9 } : { status: 'voided' }), revision: 2 };
  try { assert.equal(tailCalls(calls).length, 0); await read().finish(); assert.equal(calls.complete.length, 0); }
  finally { pending.resolve(session({ revision: 8, sets: kind === 'add' ? [performed, changed] : [changed] })); await refresh; await drain(); }
  assert.equal(headCalls(calls, kind).length, 1); assert.equal(read().commands.length, 0);
  assert.equal(tailCalls(calls).length, 1); assert.equal(tailCalls(calls)[0][0].revision, 8);
  assert.equal(read().notice, null);
  await read().finish(); assert.equal(calls.complete[0][0].revision, 9);
});

test('definite first set rejection still releases the queue without retrying the rejected command', async () => {
  for (const kind of ['add', 'edit', 'void']) {
    const { read, calls } = fixture({ [setMethod[kind]]: async (...args) => {
      if (kind === 'add' && args[1].setNumber === 3) return tailResponse(args);
      throw new ApiError(422, 'invalid_set', 'Rejected');
    } });
    enqueueHead(read, kind); read().logSet(draft(3)); await drain();
    assert.equal(headCalls(calls, kind).length, 1); assert.equal(read().commands.length, 0);
    assert.equal(tailCalls(calls).length, 1); assert.equal(tailCalls(calls)[0][0].revision, 4);
    await read().finish(); assert.equal(calls.complete[0][0].revision, 5);
  }
});

test('enqueue snapshots keep the original user values through queued delay and unknown retry', async () => {
  const pending = deferred(); let sends = 0;
  const { read, calls } = fixture({ addSet: async (value, input) => {
    sends++;
    if (sends === 1) return pending.promise;
    if (sends === 2) throw unknown();
    return { set: { ...input, id: 'set-3', revision: 1 }, sessionRevision: value.revision + 1 };
  } });
  const first = draft(2), second = draft(3);
  read().logSet(first); read().logSet(second);
  first.reps = 99; second.reps = 100; second.weightKg = 500;
  pending.resolve({ set: { ...draft(2), id: 'set-2', revision: 1 }, sessionRevision: 5 }); await drain();
  const retained = read().commands[0];
  assert.equal(retained.state.status, 'unknown'); assert.ok(Object.isFrozen(retained.payload.set));
  read().retryCommand(retained.key); await drain();
  assert.deepEqual(calls.add.map(([, input]) => [input.reps, input.weightKg]), [[8, 20], [8, 20], [8, 20]]);
  assert.deepEqual(calls.add.slice(1).map(([value, input, key]) => [value.revision, input, key]),
    Array.from({ length: 2 }, () => [5, draft(3), retained.key]));
  assert.equal(read().commands.length, 0);
});

test('unknown add requires exact status, original session identity and revision advancement in readback', async () => {
  for (const overrides of [{ status: 'draft' }, { sessionRevision: 4 }, { sessionId: 'foreign-session' }]) {
    const candidate = { ...draft(2), id: 'set-2', revision: 1, status: overrides.status ?? 'confirmed' };
    const { read, calls } = fixture({ addSet: async () => { throw unknown(); },
      workout: async () => session({ id: overrides.sessionId ?? 'workout-1', revision: overrides.sessionRevision ?? 5, sets: [performed, candidate] }) });
    read().logSet(draft(2)); await drain(); const retained = read().commands[0];
    await read().reconcile();
    assert.equal(read().commands[0]?.key, retained.key); assert.equal(read().commands[0]?.state.status, 'unknown');
    assert.equal(calls.add.length, 1); assert.equal(read().session.id, 'workout-1');
  }
});

test('late set success or failure after hook teardown cannot publish or dispatch queued successors', async () => {
  for (const rejected of [false, true]) {
    const pending = deferred();
    const { read, calls, unmount } = fixture({ addSet: () => pending.promise });
    const staleCallback = read(); staleCallback.logSet(draft(2)); staleCallback.logSet(draft(3)); unmount();
    if (rejected) pending.reject(unknown());
    else pending.resolve({ set: { ...draft(2), id: 'set-2', revision: 1 }, sessionRevision: 5 });
    await drain(); staleCallback.retryCommand('command-1'); await staleCallback.finish();
    assert.equal(calls.add.length, 1); assert.equal(calls.changed, 0); assert.equal(calls.completed.length, 0);
    assert.equal(calls.complete.length, 0); assert.equal(calls.unauthenticated, 0);
  }
});

const sourceDraft = (number, reps) => ({ schema: 'form.source-performed-set/v1', occurrenceId: 'movement-1',
  setNumber: number, status: 'confirmed', performance: { schema: 'form.source-performance/v1',
    kind: reps === undefined ? 'controlled-practice' : 'repetitions', ...(reps === undefined ? {} : { reps }),
    load: { kind: 'unspecified', basis: 'unknown' } } });
const sourcePerformed = () => ({ ...sourceDraft(1, 8), id: 'set-1', revision: 1 });
const sourceSession = (overrides = {}) => session({ planSnapshot: { schema: 'form.source-prescription-plan/v1',
  name: 'Source snapshot', items: [], duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 } },
  occurrences: [{ id: 'movement-1', target: { native: { sets: 3 } } }], sets: [sourcePerformed()], ...overrides });
const sourceFixture = (overrides = {}, initial = sourceSession()) => fixture({
  workout: async () => sourceSession(),
  completeWorkout: async value => sourceSession({ revision: value.revision + 1, status: 'completed' }), ...overrides,
}, initial, true);

function restFixture(overrides = {}) {
  let time = 1000;
  const subscriptions = new Set();
  const restTiming = { now: () => time, wallNow: () => time, subscribe: tick => { subscriptions.add(tick); return () => subscriptions.delete(tick); } };
  const f = sourceFixture(overrides, sourceSession({ occurrences: [{ id: 'movement-1', target: { native: { sets: 3, rest_seconds: 150 } } }] }));
  return { ...f, subscriptions, read: (replacement = {}) => f.read({ restTiming, ...replacement }),
    time: value => { time = value; }, tick: () => [...subscriptions].forEach(tick => tick()) };
}

test('source rest controls use only the occurrence duration without writes and clean up on completion', async () => {
  const f = restFixture(), old = f.read();
  assert.equal(old.startRest('movement-1'), true); f.time(11000); f.tick();
  assert.equal(f.read().rest.remainingMs, 140000); assert.equal(old.pauseRest(), true);
  assert.equal(f.subscriptions.size, 0); assert.equal(old.resumeRest(), true);
  assertNoSets(f.calls); assert.deepEqual(f.calls.reads, []); assert.deepEqual(f.calls.complete, []);
  await old.finish();
  assert.equal(f.subscriptions.size, 0); assert.equal(f.read().rest, null);
  assert.equal(old.startRest('movement-1'), false); assert.equal(old.resumeRest(), false);
  assert.equal(f.calls.complete.length, 1); f.unmount();
});

test('source rest cannot restart through captured controls during pending or unknown completion', async () => {
  const pending = deferred(), f = restFixture({ completeWorkout: () => pending.promise }), old = f.read();
  old.startRest('movement-1'); const finish = old.finish();
  assert.equal(f.subscriptions.size, 0); assert.equal(old.startRest('movement-1'), false);
  assert.equal(f.read().startRest('movement-1'), false);
  pending.reject(unknown()); await finish;
  assert.equal(f.read().complete.state.status, 'unknown'); assert.equal(old.startRest('movement-1'), false);
  assert.equal(f.read().rest, null); assert.equal(f.subscriptions.size, 0); f.unmount();
});

test('source rest owner replacement, auth expiry and unmount invalidate subscriptions and stale controls', () => {
  for (const end of ['resource', 'auth', 'unmount']) {
    const f = restFixture(); let current = true;
    const old = f.read({ isCurrent: () => current }); old.startRest('movement-1');
    if (end === 'resource') f.read({ resources: {}, isCurrent: () => current });
    else if (end === 'auth') { current = false; f.tick(); }
    else f.unmount();
    assert.equal(f.subscriptions.size, 0); assert.equal(old.startRest('movement-1'), false);
    assert.equal(old.pauseRest(), false); assert.equal(old.resumeRest(), false); assert.equal(old.dismissRest(), false);
    assertNoSets(f.calls); assert.deepEqual(f.calls.complete, []); f.unmount();
  }
});

test('source practice unknown retry preserves nested intent, key and revision before releasing the repetition tail', async () => {
  let sends = 0;
  const { read, calls } = sourceFixture({ addSet: async (value, set) => {
    if (++sends === 1) throw unknown();
    return { set: { ...set, id: `set-${set.setNumber}`, revision: 1 }, sessionRevision: value.revision + 1 };
  } });
  const practice = sourceDraft(2); read().logSet(practice); await drain();
  const original = read().commands[0];
  practice.performance.kind = 'repetitions'; practice.performance.reps = 99; practice.performance.load.basis = 'total';
  read().logSet(sourceDraft(3, 6)); await read().finish();
  assert.equal(calls.add.length, 1); assert.equal(calls.complete.length, 0);
  read().retryCommand(original.key); read().retryCommand(original.key); await drain();
  assert.deepEqual(calls.add.slice(0, 2).map(([value, set, key]) => [value.revision, set, key]),
    Array.from({ length: 2 }, () => [4, sourceDraft(2), original.key]));
  assert.ok(Object.isFrozen(original.payload) && Object.isFrozen(original.payload.set.performance.load));
  assert.equal(calls.add[2][0].revision, 5);
  assert.equal(read().session.sets[1].performance.kind, 'controlled-practice');
  assert.equal(Object.hasOwn(read().session.sets[1], 'reps'), false);
  await read().finish(); assert.equal(calls.complete[0][0].revision, 6);
});

test('source corrections snapshot original nested set and changes across lost acknowledgement and later rejection', async () => {
  let sends = 0;
  const initial = sourceSession(), originalSet = initial.sets[0];
  const { read, calls } = sourceFixture({ editSet: async (id, set, patch) => {
    if (++sends === 1) throw unknown();
    if (sends === 2) throw new ApiError(422, 'rejected_retry', 'Rejected retry');
    return { set: { ...set, ...patch, revision: set.revision + 1 }, sessionRevision: 5 };
  } }, initial);
  const { occurrenceId, setNumber, ...patch } = sourceDraft(1, 9);
  read().editSet(originalSet, patch); await drain(); const retained = read().commands[0];
  originalSet.performance.reps = 50; originalSet.revision = 7; patch.performance.reps = 70;
  read().retryCommand(retained.key); await drain();
  assert.equal(read().commands[0].state.status, 'unknown');
  read().retryCommand(retained.key); await drain();
  assert.deepEqual(calls.edit.map(([, set, changes, key]) => [set.revision, set.performance.reps, changes.performance.reps, key]),
    Array.from({ length: 3 }, () => [1, 8, 9, retained.key]));
  assert.equal(read().session.sets[0].performance.reps, 9);
});

test('source readback never treats absent legacy numeric fields as acknowledgement of a different performance', async () => {
  for (const mutate of [set => { set.performance = sourceDraft(2, 8).performance; }, set => { set.status = 'draft'; },
    set => { delete set.schema; delete set.performance; }]) {
    const candidate = { ...sourceDraft(2), id: 'set-2', revision: 1 }; mutate(candidate);
    const { read, calls } = sourceFixture({ addSet: async () => { throw unknown(); },
      workout: async () => sourceSession({ revision: 5, sets: [sourcePerformed(), candidate] }) });
    read().logSet(sourceDraft(2)); await drain(); const command = read().commands[0];
    await read().reconcile(); await read().finish();
    assert.equal(read().commands[0]?.key, command.key); assert.equal(calls.complete.length, 0);
  }
});

test('source queue keeps malformed acknowledgement unknown and suppresses late effects after teardown', async () => {
  const pending = deferred(); let sends = 0;
  const { read, calls, unmount } = sourceFixture({ addSet: async () => {
    if (++sends === 1) throw new ApiError(502, 'training_response_invalid', 'Invalid receipt', true);
    return pending.promise;
  } });
  read().logSet(sourceDraft(2)); await drain(); const command = read().commands[0];
  assert.equal(command.state.status, 'unknown'); read().retryCommand(command.key); unmount();
  pending.resolve({ set: { ...sourceDraft(2), id: 'set-2', revision: 1 }, sessionRevision: 5 }); await drain();
  assert.equal(calls.changed, 0); assert.equal(calls.completed.length, 0); assert.equal(calls.add[0][2], calls.add[1][2]);
});

test('source hook refuses getter intents and latches an owner replacement before stale callbacks can dispatch', async () => {
  const f = sourceFixture(); let getters = 0;
  const invalid = sourceDraft(2);
  Object.defineProperty(invalid.performance, 'load', { enumerable: true, get() { getters++; return { kind: 'unspecified', basis: 'unknown' }; } });
  assert.throws(() => f.read().logSet(invalid)); assert.equal(getters, 0); assert.equal(f.calls.add.length, 0);
  const staleCallback = f.read(); f.read({ initial: sourceSession({ id: 'replacement' }) });
  staleCallback.logSet(sourceDraft(2)); await staleCallback.finish(); await drain();
  assert.equal(f.calls.add.length, 0); assert.equal(f.calls.complete.length, 0);
});

test('source execution follows authoritative correction and void revisions without mutating prior projections', async () => {
  const f = sourceFixture({ editSet: async (id, set, patch) => ({
    set: { ...set, ...patch, revision: 2 }, sessionRevision: 5 }),
  voidSet: async (id, set) => ({ set: { ...set, status: 'voided', revision: 3 }, sessionRevision: 6 }) });
  const original = f.read().execution;
  assert.equal(original.occurrences[0].observedCounts.confirmed, 1);
  f.read().editSet(f.read().session.sets[0], { schema: 'form.source-performed-set/v1', status: 'confirmed', performance: sourceDraft(1, 9).performance });
  await drain(); const corrected = f.read().execution;
  assert.equal(corrected.sessionRevision, 5); assert.equal(corrected.occurrences[0].sets[0].revision, 2);
  assert.equal(corrected.occurrences[0].sets[0].performance.kind, 'repetitions');
  assert.equal(corrected.occurrences[0].sets[0].performance.reps, 9);
  f.read().voidSet(f.read().session.sets[0]); await drain(); const voided = f.read().execution;
  assert.equal(voided.sessionRevision, 6); assert.deepEqual(voided.occurrences[0].observedCounts, { confirmed: 0, draft: 0, voided: 1 });
  assert.equal(voided.occurrences[0].confirmedShortfall, 3); assert.equal(voided.occurrences[0].sets[0].revision, 3);
  assert.equal(original.sessionRevision, 4); assert.equal(original.occurrences[0].sets[0].performance.reps, 8);
  assert.equal(corrected.occurrences[0].observedCounts.confirmed, 1); f.unmount();
});

test('source execution excludes pending and unknown queue intent until an authoritative readback', async () => {
  const pending = deferred(), authoritative = sourceSession({ revision: 9, sets: [sourcePerformed(),
    { ...sourceDraft(2), id: 'set-2', revision: 1 }] });
  const f = sourceFixture({ addSet: () => pending.promise, workout: async () => authoritative });
  f.read().logSet(sourceDraft(2)); f.read().logSet(sourceDraft(3, 6));
  assert.equal(f.read().commands.length, 2); assert.equal(f.read().execution.occurrences[0].observedCounts.confirmed, 1);
  assert.equal(f.read().execution.sessionRevision, 4);
  pending.reject(unknown()); await drain();
  assert.equal(f.read().commands[0].state.status, 'unknown');
  assert.equal(f.read().execution.occurrences[0].sets.length, 1);
  await f.read().reconcile(); const execution = f.read().execution;
  assert.equal(execution.sessionRevision, 9); assert.equal(execution.occurrences[0].observedCounts.confirmed, 2);
  assert.deepEqual(execution.occurrences[0].sets.map(set => set.id), ['set-1', 'set-2']);
  assert.equal(execution.occurrences[0].confirmedShortfall, 1); f.unmount();
});

test('source execution preserves empty completion without declaring prescribed occurrences complete', async () => {
  const initial = sourceSession({ sets: [] });
  const f = sourceFixture({ completeWorkout: async value => ({ ...value, revision: 5, status: 'completed', completedAt: '2026-10-12T12:00:00Z' }) }, initial);
  await f.read().finish(); const execution = f.read().execution;
  assert.equal(execution.sessionStatus, 'completed'); assert.equal(execution.sessionRevision, 5);
  assert.equal(execution.occurrences[0].observedCounts.confirmed, 0); assert.equal(execution.occurrences[0].confirmedShortfall, 3);
  assert.deepEqual(execution.occurrences[0].sets, []); assert.equal(Object.hasOwn(execution.occurrences[0], 'completed'), false);
  assert.equal(f.calls.complete.length, 1); f.unmount();
});
