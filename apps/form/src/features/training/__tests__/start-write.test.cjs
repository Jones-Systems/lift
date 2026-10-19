const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');

const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX };
const compiled = new Map();
function source(relative, name = '') {
  const file = resolve(__dirname, '..', relative), key = `${file}:${name}`;
  if (!compiled.has(key)) {
    const text = readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (name) assert.equal(functions.length, 1, `One actual ${name} declaration exists`);
    compiled.set(key, ts.transpileModule(name ? functions[0].getText(ast) : text, { fileName: file, compilerOptions: options }).outputText);
  }
  return compiled.get(key);
}
const unexpected = name => { throw new Error(`Unexpected runtime import: ${name}`); };
function load(relative, requireModule) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source(relative))(requireModule, module, module.exports);
  return module.exports;
}
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
function actualFunction(relative, name, dependencies) {
  // Expose unchanged source declarations only in memory; no production export or copied controller is added.
  return new Function(...Object.keys(dependencies), 'require', 'exports', `${source(relative, name)}\nreturn ${name};`)(
    ...Object.values(dependencies), name => name === 'react/jsx-runtime' ? jsx : unexpected(name), {});
}
const { ApiError } = load('../../api/transport.ts', unexpected);
const model = load('model.ts', name => name === '../../api/client' ? { ApiError }
  : name === '../cues/CuesScreen' ? { normalizeCues: unexpected } : unexpected(name));
const copy = load('copy.ts', unexpected);
const { decodePlan } = load('../../api/trainingCodec.ts', name => name === './transport' ? { ApiError } : unexpected(name));
const helpers = {};
for (const name of ['isSourcePlan', 'isSourceSession', 'sourceUnavailable', 'legacyHistory', 'legacyStats', 'legacyDetail', 'freezePlan']) {
  helpers[name] = actualFunction('TrainingSlot.tsx', name, { ...helpers, decodePlan });
}
const ui = Object.fromEntries(['View', 'Screen', 'Nav', 'Txt', 'Gutter', 'Title', 'Section', 'ErrorNotice', 'LoadingSkeleton',
  'SessionSummary', 'PrimaryAction', 'PlainAction', 'Choices', 'ChoiceRow', 'Notice'].map(name => [name, name]));
const WorkoutStartScreen = actualFunction('screens.tsx', 'WorkoutStartScreen', { ...ui, ...model, ...copy, s: { targets: {} } });
const drain = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const unknown = () => new ApiError(0, 'network_unavailable', 'Response lost', true);
const plan = id => ({ id, revision: 4, name: id, minutes: 30, archived: false,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  items: [{ id: 'item-1', exerciseId: 'exercise-1', setTarget: 2, repMin: 6, repMax: 12, targetKg: 0 }] });
const session = id => ({ id, revision: 1, status: 'active', startedAt: '2026-10-01T00:00:00Z', sets: [], planSnapshot: { name: id } });
function nodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [...(value.type ? [value] : []), ...Object.values(value.props ?? {}).flatMap(nodes)];
}
function find(tree, predicate) {
  const node = nodes(tree).find(predicate); assert.ok(node, 'Expected native screen callback is present'); return node.props;
}

function fixture(startWorkout, accountId = 'account-1') {
  const calls = { start: [], history: 0, reload: 0 };
  const plans = [plan('plan-a'), plan('plan-b')];
  const slots = [], cleanups = []; let cursor = 0, key = 0, writes = 0;
  // Persistent hook slots and mount cleanup drive the actual callbacks; this is not a native renderer.
  const react = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, next => { writes++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useMemo: fn => fn(), useCallback: fn => fn,
    useEffect(effect) { const index = cursor++; if (!slots[index]) { slots[index] = true; cleanups.push(effect()); } },
  };
  const commands = load('../shared/commands.ts', name => name === 'react' ? react
    : name === '../../api/client' ? { ApiError, commandKey: () => `${accountId}-command-${++key}` } : unexpected(name));
  const feedback = load('useTrainingFeedback.ts', name => name === 'react' ? react
    : name === '../../api/transport' ? { ApiError }
    : name === '../../api/training-feedback' ? load('../../api/training-feedback.ts', name => name === './transport' ? { ApiError } : unexpected(name))
    : unexpected(name));
  const resources = {
    history: async () => { calls.history++; return { items: [session('existing-session')], nextBefore: null }; },
    stats: async () => ({ completedSessions: 0, confirmedSets: 0, repetitions: 0, volumeKg: 0, byExercise: [] }),
    startWorkout: (value, commandKey) => {
      calls.start.push({ planId: value.id, expectedPlanRevision: value.revision, key: commandKey });
      return startWorkout(value, commandKey);
    },
  };
  resources.sourceTraining = async () => resources;
  const ctx = { resources, appMode: 'basic', account: { accountId, profile: { name: 'Owner' }, preferences: { loadUnit: 'kg' } },
    plans, storedPlans: plans, sessionGeneration: accountId, isCurrentSession: () => true, activePlan: plans[0], exercises: [], reload: async () => { calls.reload++; } };
  const TrainingHome = actualFunction('TrainingSlot.tsx', 'TrainingHome', { ...react, ...model, ...helpers, decodePlan, useCommandKey: commands.useCommandKey,
    ...feedback,
    useSafeAreaInsets: () => ({ bottom: 0 }), View: 'View', TabBar: 'TabBar', TodayScreen: 'TodayScreen', WorkoutStartScreen,
    CoachUnavailable: 'CoachUnavailable', HistoryScreen: 'HistoryScreen', SessionDetailScreen: 'SessionDetailScreen',
    StatsScreen: 'StatsScreen', Notice: 'Notice', ActiveSourceWorkout: 'ActiveSourceWorkout', ActiveWorkout: 'ActiveWorkout', s: { fill: {}, hidden: {} } });
  const read = () => { cursor = 0; return TrainingHome(ctx); };
  const start = () => find(read(), node => node.type === WorkoutStartScreen);
  return { calls, plans, ctx, read, start, writes: () => writes,
    action: () => find(WorkoutStartScreen(start()), node => node.props.captureId === 'a-start'),
    async open() { read(); await drain(); find(read(), node => node.type === 'TodayScreen').onStart(); },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}

test('unknown start cannot be replaced when Resume and the plain Start action are present', async () => {
  const f = fixture(async () => { throw unknown(); }); await f.open();
  const staleStart = f.start().onStart; staleStart(f.plans[0]); await drain();
  const original = f.start().start;
  assert.equal(f.action().disabled, true, 'The actual resume-present Start action is disabled while unknown');
  f.start().onSelect(f.plans[1].id); staleStart(f.plans[1]); f.start().onStart(f.plans[1]); await drain();
  assert.equal(f.calls.start.length, 1); assert.deepEqual(f.start().start, original); f.unmount();
});

test('unknown start keeps its original key and revision after later 422/500 retry rejection', async () => {
  for (const status of [422, 500]) {
    let attempts = 0;
    const f = fixture(async () => {
      if (++attempts === 1) throw unknown();
      if (attempts === 2) throw new ApiError(status, 'rejected_retry', 'Rejected retry');
      return session('saved-session');
    });
    await f.open(); const staleStart = f.start().onStart; staleStart(f.plans[0]); await drain();
    const first = f.calls.start[0]; f.ctx.plans[0] = { ...f.plans[0], revision: 9 };
    f.start().onRetryStart(); await drain();
    assert.equal(f.start().start.state.status, 'unknown'); assert.equal(f.start().start.key, first.key);
    staleStart(f.plans[1]); await drain(); assert.equal(f.calls.start.length, 2);
    f.start().onRetryStart(); await drain();
    assert.deepEqual(f.calls.start, [first, first, first]);
    assert.equal(find(f.read(), node => node.type === 'ActiveWorkout').initial.id, 'saved-session'); f.unmount();
  }
});

test('synchronous stale start and retry callbacks allow only one live request', async () => {
  for (const retrying of [false, true]) {
    const pending = deferred(); let attempts = 0;
    const f = fixture(() => retrying && ++attempts === 1 ? Promise.reject(unknown()) : pending.promise);
    await f.open(); const start = f.start().onStart;
    if (retrying) { start(f.plans[0]); await drain(); }
    const invoke = retrying ? f.start().onRetryStart : () => start(f.plans[0]);
    invoke(); invoke(); f.start().onStart(f.plans[1]); await drain();
    try { assert.equal(f.calls.start.length, retrying ? 2 : 1); }
    finally { pending.resolve(session('saved-session')); await drain(); f.unmount(); }
  }
});

test('definite first start rejection permits a new plan and fresh command key', async () => {
  let attempts = 0;
  const f = fixture(async () => {
    if (++attempts === 1) throw new ApiError(422, 'invalid_plan', 'Rejected');
    return session('new-session');
  });
  await f.open(); f.start().onStart(f.plans[0]); await drain();
  assert.equal(f.start().start.state.status, 'failed'); assert.equal(f.action().disabled, false);
  f.start().onStart(f.plans[1]); await drain();
  assert.deepEqual(f.calls.start.map(call => call.planId), ['plan-a', 'plan-b']);
  assert.notEqual(f.calls.start[0].key, f.calls.start[1].key);
  assert.equal(find(f.read(), node => node.type === 'ActiveWorkout').initial.id, 'new-session'); f.unmount();
});

test('unmounted account callbacks neither dispatch nor update while a new account starts separately', async () => {
  for (const uncertain of [false, true]) {
    const pending = deferred();
    const old = fixture(() => uncertain ? Promise.reject(unknown()) : pending.promise, 'old-account');
    await old.open(); const staleStart = old.start().onStart; staleStart(old.plans[0]); await drain();
    const staleRetry = old.start().onRetryStart; old.unmount(); const writes = old.writes();
    const fresh = fixture(async () => session('new-account-session'), 'new-account');
    await fresh.open(); fresh.start().onStart(fresh.plans[1]); await drain();
    pending.resolve(session('old-account-session')); await drain();
    staleStart(old.plans[1]); if (uncertain) staleRetry(); await drain();
    assert.equal(old.calls.start.length, 1); assert.equal(old.writes(), writes);
    assert.equal(fresh.calls.start.length, 1);
    assert.equal(find(fresh.read(), node => node.type === 'ActiveWorkout').initial.id, 'new-account-session'); fresh.unmount();
  }
});
