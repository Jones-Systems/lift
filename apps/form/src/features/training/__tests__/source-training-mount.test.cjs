const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
const compiled = new Map();
let sharedTransport;
const jsx = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
const drain = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const unexpected = name => { throw new Error(`Unexpected runtime import ${name}`); };

// Dependency-aware hook slots execute the actual mount/queue callbacks without a native renderer or disk output.
function hooks() {
  const slots = []; let cursor = 0, effects = [], writes = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value) { const i = cursor++; slots[i] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[i].value, next => { writes++; slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
    useReducer(reducer, value) { const [state, set] = react.useState(value); return [state, action => set(old => reducer(old, action))]; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(effect, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) {
      const old = slots[i]; slots[i] = { deps }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); });
    } },
  };
  return { react, render(fn) { cursor = 0; effects = []; const result = fn(); const pending = effects; effects = []; pending.forEach(effect => effect()); return result; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); }, writes: () => writes };
}
function loader(react, key, appState) {
  const modules = new Map();
  const load = name => {
    const filename = path.resolve(root, name);
    if (name === 'api/transport.ts' && sharedTransport) return sharedTransport;
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    if (!compiled.has(filename)) {
      let source = fs.readFileSync(filename, 'utf8');
      if (name.endsWith('TrainingSlot.tsx')) source += '\nexport { TrainingHome, ActiveSourceWorkout };';
      compiled.set(filename, ts.transpileModule(source, { fileName: filename, compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
      } }).outputText);
    }
    const requireModule = specifier => {
      if (specifier === 'react') return react;
      if (specifier === 'react/jsx-runtime') return jsx;
      if (specifier === 'react-native') return { AppState: appState, View: 'View', StyleSheet: { create: value => value } };
      if (specifier === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ bottom: 0 }) };
      if (specifier.endsWith('/api/client') || (specifier === './client' && name.startsWith('api/'))) return { ...load('api/transport.ts'), commandKey: key, formApi: null };
      if (specifier.endsWith('/shared/tokens')) return { t: { color: { canvas: 'canvas' } } };
      if (specifier.endsWith('/shared/ui')) return { Notice: 'Notice' };
      if (specifier.endsWith('/variants/a/frame')) return { TabBar: 'TabBar' };
      if (specifier === './screens') return Object.fromEntries(['CoachUnavailable', 'HistoryScreen', 'SessionDetailScreen', 'StatsScreen', 'TodayScreen', 'WorkoutStartScreen'].map(name => [name, name]));
      if (specifier === './WorkoutScreen') return { WorkoutScreen: 'WorkoutScreen' };
      if (specifier === '../cues/CuesScreen') return { normalizeCues: unexpected };
      if (!specifier.startsWith('.')) return unexpected(specifier);
      const target = path.resolve(path.dirname(filename), specifier);
      const file = fs.existsSync(target + '.ts') ? target + '.ts' : target + '.tsx';
      return load(path.relative(root, file));
    };
    new Function('require', 'module', 'exports', compiled.get(filename))(requireModule, module, module.exports);
    if (name === 'api/transport.ts') sharedTransport = module.exports;
    return module.exports;
  };
  return load;
}
const date = '2026-10-11T12:00:00.000Z';
const item = { id: 'practice_item', native: { exercise_id: 'native_practice', movement_pattern: 'core', role: 'practice', sets: 2, rest_seconds: 90,
  notes: ['Controlled practice; no quantity target.'] },
  registeredDomain: { exerciseId: 'domain_practice', variantId: 'variant:practice',
    identity: { repository: 'synthetic/catalog', revision: 'v1', path: 'catalog.json', sha256: 'a'.repeat(64), nativeId: 'native_practice' },
    registration: { id: 'registration', revision: 'v1', digest: 'b'.repeat(64), bytes: 512 }, recordDigest: 'c'.repeat(64) },
  load: { kind: 'unspecified', basis: 'unknown' } };
const sourcePlan = () => ({ schema: 'form.source-prescription-plan/v1', id: 'source_plan', revision: 2, archived: false,
  name: 'Practice plan', createdAt: date, updatedAt: date, origin: { kind: 'form-adaptation', id: 'recipe', revision: 'v1' },
  duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 }, items: [clone(item)] });
const legacyPlan = () => ({ id: 'legacy_plan', revision: 1, archived: false, name: 'Legacy plan', createdAt: date, updatedAt: date, minutes: 30,
  items: [{ id: 'legacy_item', exerciseId: 'legacy_exercise', setTarget: 2, repMin: 6, repMax: 12, targetKg: 10 }] });
const sessionFor = (plan = sourcePlan(), id = 'source_workout', completed = false) => ({ id, revision: 1, planId: plan.id, planRevision: plan.revision,
  status: completed ? 'completed' : 'active', startedAt: date, completedAt: completed ? date : null, planSnapshot: clone(plan),
  occurrences: plan.items.map((target, position) => ({ id: `occ_${position}`, itemId: target.id,
    exerciseId: target.registeredDomain?.exerciseId ?? target.exerciseId, position, target: clone(target) })), sets: [] });
const emptyStats = () => ({ confirmedSets: 0, repetitions: 0, volumeKg: 0, completedSessions: 0, byExercise: [],
  units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true });
const practiceStats = () => ({ confirmedSets: 1, repetitions: null, volumeKg: null, maxWeightKg: null, completedSessions: 1,
  coverage: { repetitionSets: 0, loadSets: 0, practiceSets: 1 },
  byExercise: [{ exerciseId: 'domain_practice', confirmedSets: 1, repetitions: null, volumeKg: null, maxWeightKg: null,
    coverage: { repetitionSets: 0, loadSets: 0, practiceSets: 1 } }], units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true });
const practice = () => ({ schema: 'form.source-performed-set/v1', occurrenceId: 'occ_0', setNumber: 1, status: 'confirmed',
  performance: { schema: 'form.source-performance/v1', kind: 'controlled-practice', load: { kind: 'unspecified', basis: 'unknown' } } });
function nodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [...(value.type ? [value] : []), ...Object.values(value.props ?? {}).flatMap(nodes)];
}
const find = (tree, type) => nodes(tree).find(node => node.type === type);

function fixture(options = {}) {
  const home = hooks(), active = hooks(); let key = 0, auth = 1, current = true, acquisitions = 0, registered = null;
  const foregroundListeners = new Set(), retainedForeground = [];
  const appState = { addEventListener(event, listener) {
    assert.equal(event, 'change'); foregroundListeners.add(listener); retainedForeground.push(listener);
    return { remove: () => foregroundListeners.delete(listener) };
  } };
  const load = loader(home.react, () => `mount-key-${++key}`, appState);
  const activeLoad = loader(active.react, () => `set-key-${++key}`, appState);
  const { FormResources } = load('api/resources.ts'), { ApiError } = load('api/transport.ts');
  const { TrainingHome, ActiveSourceWorkout } = load('features/training/TrainingSlot.tsx');
  const activeMount = activeLoad('features/training/TrainingSlot.tsx').ActiveSourceWorkout;
  const calls = [], plans = options.plans ?? [sourcePlan(), legacyPlan()]; let storedSession = sessionFor();
  const api = { captureAuthContext() { const captured = auth; return { isCurrent: () => captured === auth }; },
    async request(url, method = 'GET', body, commandKey) {
      const call = { url, method, body: body === undefined ? undefined : clone(body), key: commandKey }; calls.push(call);
      if (options.respond) { const response = await options.respond(call, { ApiError, session: storedSession }); if (response !== undefined) return clone(response); }
      if (url === '/v1/history') return clone(options.history ?? { items: [], nextBefore: null });
      if (url.startsWith('/v1/history?')) return clone(options.nextHistory ?? { items: [], nextBefore: null });
      if (url === '/v1/stats') return clone(options.stats ?? emptyStats());
      if (url === '/v1/workout-sessions' && method === 'POST') {
        storedSession = sessionFor(plans.find(plan => plan.id === body.planId)); return clone(storedSession);
      }
      if (url.endsWith('/sets')) {
        const { expectedRevision, ...set } = body;
        const saved = { ...set, id: 'saved_set', revision: 1, createdAt: date, updatedAt: date };
        storedSession = { ...storedSession, revision: expectedRevision + 1, sets: [...storedSession.sets, saved] };
        return clone({ set: saved, sessionRevision: storedSession.revision });
      }
      if (url.endsWith('/complete')) {
        storedSession = { ...storedSession, revision: storedSession.revision + 1, status: 'completed', completedAt: date };
        options.history = { items: [storedSession], nextBefore: null }; options.stats = practiceStats(); return clone(storedSession);
      }
      if (url.startsWith('/v1/workout-sessions/')) return clone(storedSession);
      return unexpected(url);
    } };
  const resources = new FormResources(api).boundTo(() => current);
  const acquire = resources.sourceTraining.bind(resources);
  resources.sourceTraining = async () => { acquisitions++; if (options.acquisition) await options.acquisition.promise; return acquire(); };
  const renderer = value => ({ type: 'SourcePresenter', props: { value } });
  const ctx = { account: { accountId: 'account_1', profile: { name: 'Owner' }, preferences: { loadUnit: 'kg' } },
    appMode: 'basic', sessionGeneration: 'session_1', isCurrentSession: () => current && auth === 1, resources,
    storedPlans: plans, plans: plans.filter(plan => !plan.schema), activePlan: plans.find(plan => !plan.schema) ?? null, exercises: [],
    reload: async () => {}, openPlans() {}, renderSourceTraining: options.absentRenderer ? undefined : renderer,
    registerSourceTraining(select) { registered = select; return () => { if (registered === select) registered = null; }; } };
  let lastActive = null;
  const read = () => {
    const tree = home.render(() => TrainingHome(ctx));
    if (lastActive && !find(tree, ActiveSourceWorkout)) { active.unmount(); lastActive = null; }
    return tree;
  };
  const navigation = () => { const result = find(read(), 'SourcePresenter'); assert.ok(result); return result.props.value; };
  const readActive = () => {
    const node = find(read(), ActiveSourceWorkout); assert.ok(node, 'Persistent source owner remains mounted');
    if (lastActive) assert.equal(node.key, lastActive.key, 'Queue key is independent of tab/route/renderer');
    lastActive = node;
    return active.render(() => activeMount(node.props));
  };
  const workout = () => { const node = find(readActive(), 'SourcePresenter'); assert.ok(node); return node.props.value; };
  return { ctx, calls, plans, ApiError, read, navigation, readActive, workout, activeType: ActiveSourceWorkout,
    foregroundListeners, retainedForeground, appState: state => [...foregroundListeners].forEach(listener => listener(state)),
    acquisitions: () => acquisitions, writes: () => home.writes() + active.writes(), register: () => registered,
    expireAuth() { auth++; }, replaceOwner() { ctx.resources = new FormResources(api).boundTo(() => true); },
    async ready() { read(); await drain(); read(); },
    async start() { assert.equal(registered(plans[0]), true); navigation().startSelected(); await drain(); return workout(); },
    unmount() { current = false; home.unmount(); active.unmount(); } };
}

test('saved source selection starts only on explicit action, retaining the entire detached snapshot and original retry key', async () => {
  let sends = 0;
  const f = fixture({ respond(call, { ApiError }) {
    if (call.method === 'POST' && call.url === '/v1/workout-sessions' && ++sends === 1) throw new ApiError(0, 'network_unavailable', 'Lost', true);
  } });
  await f.ready(); assert.equal(f.acquisitions(), 1);
  assert.equal(f.register()(f.plans[0]), true); assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  f.navigation().startSelected(); await drain();
  const retained = f.navigation().start; assert.equal(retained.state.status, 'unknown');
  assert.deepEqual(retained.plan, sourcePlan()); assert.ok(Object.isFrozen(retained.plan.items[0].native));
  const first = f.calls.find(call => call.method === 'POST');
  f.plans[0] = { ...f.plans[0], revision: 9 };
  f.navigation().retryStart(); await drain();
  const sendsMade = f.calls.filter(call => call.method === 'POST'); assert.deepEqual(sendsMade[1], first);
  // The server fixture returned a new snapshot: the real closed port refuses to acknowledge that mismatched replay.
  assert.equal(f.navigation().start.state.status, 'unknown');
  assert.equal(find(f.read(), f.activeType), undefined); f.unmount();
});

test('unknown source start remains sticky after later rejection, then accepts the exact original full snapshot', async () => {
  for (const status of [422, 500]) {
    let sends = 0; const original = sessionFor();
    const f = fixture({ respond(call, { ApiError }) {
      if (call.url === '/v1/workout-sessions' && call.method === 'POST') {
        if (++sends === 1) throw new ApiError(0, 'network_unavailable', 'Lost', true);
        if (sends === 2) throw new ApiError(status, 'rejected', 'Rejected');
        return original;
      }
    } });
    await f.ready(); f.register()(f.plans[0]); f.navigation().startSelected(); await drain();
    const first = f.navigation().start; f.navigation().retryStart(); f.navigation().retryStart(); await drain();
    assert.equal(f.navigation().start.state.status, 'unknown'); assert.equal(f.register()(sourcePlan()), false);
    f.navigation().retryStart(); await drain();
    assert.deepEqual(f.workout().workout.session, original);
    assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => [call.body, call.key]),
      Array(3).fill([{ planId: 'source_plan', expectedPlanRevision: 2 }, first.key])); f.unmount();
  }
});

test('delayed source acquisition is once per owner and cannot publish after auth or resource replacement', async () => {
  for (const replacement of ['expireAuth', 'replaceOwner', 'unmount']) {
    const acquisition = deferred(), f = fixture({ acquisition }); f.read(); f.read();
    assert.equal(f.acquisitions(), 1); f[replacement](); if (replacement !== 'unmount') f.read();
    const writes = f.writes(); acquisition.resolve(); await drain();
    assert.equal(f.writes(), writes); assert.equal(f.calls.length, 0); if (replacement !== 'unmount') f.unmount();
  }
});

test('late start acknowledgement cannot publish after auth replacement and retained callbacks cannot dispatch', async () => {
  const pending = deferred(); const f = fixture({ respond: call => call.method === 'POST' ? pending.promise : undefined });
  await f.ready(); f.register()(f.plans[0]); const old = f.navigation(); old.startSelected(); await drain();
  f.expireAuth(); const writes = f.writes(); pending.resolve(sessionFor()); await drain();
  old.startSelected(); old.retryStart(); await drain();
  assert.equal(f.writes(), writes); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); f.unmount();
});

test('absent presenter cannot select or start, and source data never reaches legacy screens as complete data', async () => {
  const source = sessionFor(), legacy = sessionFor(legacyPlan(), 'legacy_workout', true);
  const f = fixture({ absentRenderer: true, history: { items: [legacy, source], nextBefore: null }, stats: practiceStats() });
  await f.ready(); assert.equal(f.register(), null);
  const tree = f.read(); assert.ok(find(tree, 'Notice'));
  for (const type of ['TodayScreen', 'WorkoutStartScreen', 'HistoryScreen', 'StatsScreen', 'SessionDetailScreen']) assert.equal(find(tree, type), undefined);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0); f.unmount();
});

test('mixed pagination keeps source and legacy sessions and nullable coverage without projection or duplicate pages', async () => {
  const legacy = sessionFor(legacyPlan(), 'legacy_workout', true), source = sessionFor();
  const f = fixture({ history: { items: [legacy], nextBefore: 'opaque_page_2' },
    nextHistory: { items: [legacy, source], nextBefore: null }, stats: practiceStats() });
  await f.ready(); const nav = f.navigation(); nav.openHistory(); nav.loadMore(); nav.loadMore(); await drain();
  const view = f.navigation(); assert.deepEqual(view.history.value.items, [legacy, source]);
  assert.equal(view.history.value.nextBefore, null); assert.equal(view.stats.value.repetitions, null);
  assert.equal(view.stats.value.volumeKg, null); assert.equal(view.stats.value.coverage.practiceSets, 1);
  assert.equal(f.calls.filter(call => call.url.includes('?before=')).length, 1);
  assert.equal(f.calls.find(call => call.url.includes('?before=')).url, '/v1/history?before=opaque_page_2'); f.unmount();
});

test('source queue survives tabs, pushed-route hiding and presenter removal while stale renderer actions expire', async () => {
  let sets = 0; const f = fixture({ respond(call, { ApiError }) {
    if (call.url.endsWith('/sets') && ++sets === 1) throw new ApiError(0, 'network_unavailable', 'Lost', true);
  } });
  await f.ready(); const started = await f.start(); const old = started;
  started.workout.logSet(practice()); old.onLeave(); await drain();
  let mounted = f.workout(); assert.equal(mounted.workout.commands.length, 1);
  const retained = mounted.workout.commands[0]; assert.equal(retained.state.status, 'unknown');
  const tab = find(f.read(), 'TabBar'); tab.props.onSelect('progress'); f.readActive();
  const routeKey = find(f.read(), f.activeType).key;
  tab.props.onSelect('plan'); await drain(); f.readActive(); assert.equal(find(f.read(), f.activeType).key, routeKey);
  const presenter = f.ctx.renderSourceTraining; f.ctx.renderSourceTraining = undefined;
  assert.ok(find(f.readActive(), 'Notice')); const count = f.calls.length;
  old.workout.logSet(practice()); old.workout.retryCommand(retained.key); old.onLeave(); await drain(); assert.equal(f.calls.length, count);
  f.ctx.renderSourceTraining = presenter; mounted = f.workout();
  old.workout.retryCommand(retained.key); await drain(); assert.equal(f.calls.length, count, 'Removed renderer callbacks never revive');
  assert.equal(mounted.workout.commands[0].key, retained.key); mounted.workout.retryCommand(retained.key); await drain();
  const writes = f.calls.filter(call => call.url.endsWith('/sets'));
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.equal(f.workout().workout.commands.length, 0); f.unmount();
});

test('source completion retains the full practice session and refreshes mixed history and null statistics', async () => {
  const f = fixture(); await f.ready(); let view = await f.start();
  view.workout.logSet(practice()); await drain(); view = f.workout();
  assert.equal(view.workout.session.sets[0].performance.kind, 'controlled-practice');
  assert.equal(Object.hasOwn(view.workout.session.sets[0].performance, 'reps'), false);
  const historyReads = f.calls.filter(call => call.url === '/v1/history').length;
  await view.workout.finish(); await drain();
  assert.equal(find(f.read(), f.activeType), undefined);
  const result = f.navigation(); assert.equal(result.route.name, 'session'); assert.equal(result.detail.value.status, 'completed');
  assert.deepEqual(result.detail.value.planSnapshot, sourcePlan()); assert.equal(result.detail.value.sets[0].performance.load.basis, 'unknown');
  assert.equal(result.stats.value.repetitions, null); assert.equal(result.stats.value.volumeKg, null);
  assert.ok(f.calls.filter(call => call.url === '/v1/history').length > historyReads);
  const sent = f.calls.find(call => call.url.endsWith('/sets')).body;
  assert.equal(Object.hasOwn(sent, 'weightKg'), false); assert.equal(Object.hasOwn(sent.performance, 'reps'), false); f.unmount();
});

test('source rest facade rejects stale presentation and expired owner controls without API effects', async () => {
  const f = fixture(); await f.ready(); const old = await f.start();
  try {
    const count = f.calls.length;
    assert.equal(old.workout.startRest('occ_0'), true); assert.equal(f.foregroundListeners.size, 1);
    assert.equal(old.workout.pauseRest(), true); assert.equal(f.foregroundListeners.size, 0);
    const paused = f.workout().workout.rest; f.appState('active');
    assert.deepEqual(f.workout().workout.rest, paused);
    assert.equal(f.workout().workout.rest.occurrenceId, 'occ_0');
    const renderer = f.ctx.renderSourceTraining; f.ctx.renderSourceTraining = undefined; f.readActive();
    assert.equal(old.workout.resumeRest(), false); assert.equal(old.workout.dismissRest(), false);
    assert.equal(old.workout.startRest('occ_0'), false);
    f.ctx.renderSourceTraining = renderer; const fresh = f.workout();
    assert.equal(old.workout.resumeRest(), false); assert.equal(fresh.workout.resumeRest(), true);
    assert.equal(f.foregroundListeners.size, 1);
    assert.equal(fresh.workout.dismissRest(), true); assert.equal(f.foregroundListeners.size, 0); assert.equal(f.workout().workout.rest, null);
    assert.equal(f.calls.length, count);
    f.expireAuth(); assert.equal(fresh.workout.startRest('occ_0'), false);
    assert.equal(fresh.workout.pauseRest(), false); assert.equal(fresh.workout.resumeRest(), false);
    assert.equal(fresh.workout.dismissRest(), false); assert.equal(f.calls.length, count);
  } finally { f.unmount(); }
});

test('source facade publishes authoritative per-occurrence execution across hidden presentation and practice confirmation', async () => {
  const f = fixture(); await f.ready(); const original = await f.start();
  try {
    const initial = original.workout.execution;
    assert.equal(initial.planId, 'source_plan'); assert.equal(initial.planRevision, 2);
    assert.deepEqual(initial.occurrences[0].occurrence.target, sourcePlan().items[0]);
    assert.equal(initial.occurrences[0].confirmedShortfall, 2);
    original.workout.logSet(practice()); await drain(); const confirmed = f.workout().workout.execution;
    assert.equal(confirmed.sessionRevision, 2); assert.equal(confirmed.occurrences[0].observedCounts.confirmed, 1);
    assert.equal(confirmed.occurrences[0].confirmedShortfall, 1);
    assert.equal(confirmed.occurrences[0].sets[0].performance.kind, 'controlled-practice');
    assert.deepEqual(confirmed.occurrences[0].sets[0].performance.load, { kind: 'unspecified', basis: 'unknown' });
    const renderer = f.ctx.renderSourceTraining; f.ctx.renderSourceTraining = undefined; f.readActive();
    f.ctx.renderSourceTraining = renderer; const restored = f.workout().workout.execution;
    assert.deepEqual(restored, confirmed); assert.equal(initial.occurrences[0].observedCounts.confirmed, 0);
    assert.ok(Object.isFrozen(restored.occurrences[0].occurrence.target.native));
  } finally { f.unmount(); }
});

test('legacy-only data still mounts legacy screens through the same closed resource acquisition', async () => {
  const legacy = sessionFor(legacyPlan(), 'legacy_workout', true);
  const f = fixture({ plans: [legacyPlan()], history: { items: [legacy], nextBefore: null } });
  await f.ready(); const today = find(f.read(), 'TodayScreen'); assert.ok(today);
  assert.deepEqual(today.props.history.value.items, [legacy]); assert.equal(today.props.stats.value.volumeKg, 0);
  assert.equal(find(f.read(), 'SourcePresenter'), undefined); assert.equal(f.acquisitions(), 1); f.unmount();
});

function feedbackResponses(eventResponse) {
  const scope = { kind: 'context', contextId: 'context_1' };
  const analysis = { basis: 'current_profile_and_goals', contextId: 'context_1', profileRevision: 1, preferencesRevision: 1 };
  const witness = { contextId: 'context_1', profileRevision: 1, preferencesRevision: 1, sessionSource: null, targetPlan: null };
  const current = { ledgerRevision: 0, projectionRevision: 0, records: [], derivations: [], sources: [] };
  const intent = { key: 'mounted_feedback_key', expectedLedgerRevision: 0, selection: null,
    event: { kind: 'record', eventId: 'mounted_feedback_event', recordId: 'mounted_feedback_record', expectedRevision: 0,
      content: { scope, sourceRefs: [{ sourceId: 'owner_report', revision: 'v1', locator: 'feedback', qualification: 'reported-only' }],
        qualifications: ['reported-only'], payload: { kind: 'feedback', signals: [
          { dimension: 'effort', state: 'reported', value: 7, unit: null, scale: 'owner_scale' }] } } } };
  const acknowledged = body => ({ analysis, result: { receipt: { eventId: body.event.eventId, recordId: body.event.recordId,
    cause: 'record', outcome: 'changed', revision: 1, reason: null, acceptedLedgerRevision: 1 }, replayed: true,
    current: { ...current, ledgerRevision: 1, projectionRevision: 1,
      records: [{ recordId: body.event.recordId, revision: 1, status: 'active', confirmed: false, content: body.event.content }],
      sources: [{ recordId: body.event.recordId, state: 'current', binding: { scope, selection: null, witness } }] } } });
  return { intent, acknowledged, respond(call, context) {
    if (call.url === '/v1/training-feedback') return { analysis, result: current };
    if (call.url === '/v1/training-feedback/witness') return { analysis, result: witness };
    if (call.url === '/v1/training-feedback/events') return eventResponse(call, context, acknowledged);
  } };
}

test('mounted Home exposes both lazy feedback branches and makes no feedback request without explicit intent', async () => {
  for (const absentRenderer of [false, true]) {
    const f = fixture({ absentRenderer }); await f.ready();
    assert.equal(f.calls.filter(call => call.url.includes('training-feedback')).length, 0);
    if (!absentRenderer) {
      assert.equal(f.navigation().feedback.state.status, 'idle'); assert.equal(f.navigation().feedback.state.read, 'idle');
      const active = await f.start(); assert.equal(active.feedback.state.status, 'idle');
      assert.equal(f.calls.filter(call => call.url.includes('training-feedback')).length, 0);
    }
    f.unmount();
  }
});

test('actual Home retains unknown feedback across start, tabs, renderer removal and workout completion', async () => {
  let sends = 0;
  const feedback = feedbackResponses((call, { ApiError }, acknowledged) => {
    if (++sends <= 2) throw new ApiError(0, 'lost_feedback', 'Lost feedback', true);
    return acknowledged(call.body);
  });
  const f = fixture({ respond: feedback.respond }); await f.ready();
  const originalNavigation = f.navigation(); await originalNavigation.feedback.review(feedback.intent); await originalNavigation.feedback.send();
  const retained = f.navigation().feedback.state.review; assert.equal(f.navigation().feedback.state.status, 'unknown');
  const originalWorkout = await f.start(); assert.strictEqual(originalWorkout.feedback.state.review, retained);
  const tab = find(f.read(), 'TabBar'); tab.props.onSelect('progress'); f.readActive();
  assert.strictEqual(f.navigation().feedback.state.review, retained); tab.props.onSelect('workout'); f.readActive();
  const renderer = f.ctx.renderSourceTraining; f.ctx.renderSourceTraining = undefined; f.read(); f.readActive();
  await drain();
  const count = f.calls.length;
  for (const facade of [originalNavigation.feedback, originalWorkout.feedback]) {
    await facade.read(); await facade.review(feedback.intent); await facade.send(); await facade.retry();
  }
  assert.equal(f.calls.length, count);
  f.ctx.renderSourceTraining = renderer; const currentWorkout = f.workout();
  await originalNavigation.feedback.retry(); await originalWorkout.feedback.retry(); assert.equal(f.calls.length, count);
  await currentWorkout.feedback.retry(); assert.equal(sends, 2); assert.equal(f.workout().feedback.state.status, 'unknown');
  await currentWorkout.workout.finish(); await drain(); assert.equal(find(f.read(), f.activeType), undefined);
  const completed = f.navigation(); assert.strictEqual(completed.feedback.state.review, retained);
  assert.equal(completed.feedback.state.status, 'unknown'); assert.equal(completed.detail.value.status, 'completed');
  const afterCompletion = f.calls.length; await currentWorkout.feedback.retry(); assert.equal(f.calls.length, afterCompletion);
  await completed.feedback.retry(); assert.equal(f.navigation().feedback.state.status, 'succeeded');
  const sent = f.calls.filter(call => call.url.endsWith('/training-feedback/events'));
  assert.equal(sent.length, 3); assert.deepEqual(sent[1], sent[0]); assert.deepEqual(sent[2], sent[0]); f.unmount();
});

test('mounted feedback pending acknowledgement and callbacks are fenced by resource, account, generation and auth expiry', async () => {
  for (const replacement of ['resources', 'account', 'generation', 'auth', 'unmount']) {
    const pending = deferred(); const feedback = feedbackResponses(() => pending.promise);
    const f = fixture({ respond: feedback.respond }); await f.ready(); const old = f.navigation().feedback;
    await old.review(feedback.intent); const sending = old.send(); await drain();
    const sent = f.calls.find(call => call.url.endsWith('/training-feedback/events'));
    if (replacement === 'resources') f.replaceOwner();
    if (replacement === 'account') f.ctx.account = { ...f.ctx.account, accountId: 'another_account' };
    if (replacement === 'generation') f.ctx.sessionGeneration = 'another_generation';
    if (replacement === 'auth') f.expireAuth();
    if (replacement === 'unmount') f.unmount(); else f.read();
    const count = f.calls.length, writes = f.writes(); pending.resolve(feedback.acknowledged(sent.body)); await sending;
    await old.read(); await old.review(feedback.intent); await old.send(); await old.retry();
    assert.equal(f.calls.length, count); assert.equal(f.writes(), writes);
    if (replacement !== 'unmount') f.unmount();
  }
});

test('mounted v2 uncertain create and correction retain exact intent until matching fresh readback', async () => {
  const loads = [
    { state: 'knownValue', value: 0, unit: 'kg', basis: 'total' },
    { state: 'knownValue', value: 0, unit: 'lb', basis: 'total' },
    { state: 'knownValue', value: 0, unit: 'kg', basis: 'perImplement' },
    { state: 'knownValue', value: 0, unit: 'kg', basis: 'perSide' },
    { state: 'knownValue', value: 0, unit: 'kg', basis: 'assistance' },
    { state: 'knownValue', value: 10, unit: 'kg', basis: 'total' },
    { state: 'unknown', confirmed: true },
    ...['bodyweight', 'unloaded', 'timedActivity'].map(reason => ({ state: 'notApplicable', reason })),
  ];
  for (const load of loads) {
    let readback;
    const f = fixture({ respond(call, { ApiError }) {
      if (call.url.endsWith('/sets') || call.method === 'PATCH') throw new ApiError(0, 'lost', 'Lost', true);
      if (call.method === 'GET' && call.url === '/v1/workout-sessions/source_workout') return readback;
    } });
    try {
      await f.ready(); const started = await f.start();
      const draft = { ...practice(), schema: 'form.source-performed-set/v2',
        performance: { schema: 'form.source-performance/v2', kind: 'controlled-practice', load: clone(load) } };
      const original = clone(draft); started.workout.logSet(draft); await drain();
      draft.performance.load.state = 'changed';
      const command = f.workout().workout.commands[0]; assert.equal(command.state.status, 'unknown');
      f.workout().workout.retryCommand(command.key); await drain();
      const creates = f.calls.filter(call => call.url.endsWith('/sets'));
      assert.equal(creates.length, 2); assert.deepEqual(creates[1], creates[0]);
      assert.deepEqual(creates[0].body, { ...original, expectedRevision: 1 });
      const saved = { ...original, id: 'saved_set', revision: 1, createdAt: date, updatedAt: date };
      for (const other of loads.filter(other => JSON.stringify(other) !== JSON.stringify(load))) {
        readback = { ...sessionFor(), revision: 2, sets: [{ ...saved, performance: { ...saved.performance, load: other } }] };
        await f.workout().workout.reconcile(); await drain();
        assert.equal(f.workout().workout.commands[0].key, command.key);
        assert.equal(f.workout().workout.commands[0].state.status, 'unknown');
      }
      readback = { ...sessionFor(), revision: 2, sets: [saved] };
      await f.workout().workout.reconcile(); await drain(); assert.equal(f.workout().workout.commands.length, 0);
      const changes = { schema: original.schema, status: 'draft', performance: clone(original.performance) };
      f.workout().workout.editSet(saved, changes); await drain();
      changes.performance.load.state = 'changed';
      const correction = f.workout().workout.commands[0]; assert.equal(correction.state.status, 'unknown');
      f.workout().workout.retryCommand(correction.key); await drain();
      const patches = f.calls.filter(call => call.method === 'PATCH');
      assert.equal(patches.length, 2); assert.deepEqual(patches[1], patches[0]);
      assert.deepEqual(patches[0].body, { schema: original.schema, status: 'draft', performance: original.performance, expectedRevision: 1 });
      readback = { ...readback, revision: 3, sets: [{ ...saved, status: 'draft' }] };
      await f.workout().workout.reconcile(); await drain(); assert.equal(f.workout().workout.commands.length, 1);
      for (const other of loads.filter(other => JSON.stringify(other) !== JSON.stringify(load))) {
        readback = { ...readback, sets: [{ ...saved, revision: 2, status: 'draft', performance: { ...saved.performance, load: other } }] };
        await f.workout().workout.reconcile(); await drain(); assert.equal(f.workout().workout.commands.length, 1);
      }
      readback = { ...readback, sets: [{ ...saved, revision: 2, status: 'draft' }] };
      await f.workout().workout.reconcile(); await drain(); assert.equal(f.workout().workout.commands.length, 0);
    } finally { f.unmount(); }
  }
});


test('foreground event reconciles the mounted rest deadline and stale events cannot update after unmount', async t => {
  let wall = 100000;
  t.mock.method(Date, 'now', () => wall);
  const f = fixture(); await f.ready(); const view = await f.start();
  try {
    const calls = f.calls.length;
    assert.equal(view.workout.startRest('occ_0'), true); assert.equal(f.foregroundListeners.size, 1);
    wall += 60000; f.appState('background');
    assert.equal(f.workout().workout.rest.remainingMs, 90000);
    f.appState('active'); assert.equal(f.workout().workout.rest.remainingMs, 30000);
    wall += 30000; f.appState('active');
    assert.equal(f.workout().workout.rest.status, 'finished'); assert.equal(f.foregroundListeners.size, 0);
    assert.equal(view.workout.startRest('occ_0'), true); assert.equal(f.foregroundListeners.size, 1);
    f.unmount(); assert.equal(f.foregroundListeners.size, 0);
    const writes = f.writes(); wall += 120000;
    f.retainedForeground.forEach(listener => listener('active'));
    assert.equal(f.writes(), writes); assert.equal(f.calls.length, calls);
  } finally { f.unmount(); }
});
