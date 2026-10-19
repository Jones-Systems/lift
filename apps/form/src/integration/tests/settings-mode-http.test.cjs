const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { inspect } = require('node:util');
const ts = require('typescript');

const appRoot = path.resolve(__dirname, '../..');
const repository = path.resolve(appRoot, '../../..');
const apiRoot = path.join(repository, 'services/api');
const origin = 'https://settings-mode.synthetic.invalid';
const password = 'Synthetic-settings-mode-password-12345';
const preferencesPath = '/v1/me/preferences';
const jsx = (type, props, key) => ({ type, props, key });
const names = new Proxy({}, { get: (_, name) => name });
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const sha = value => createHash('sha256').update(value).digest('hex');

// Hook frames follow account-switch-session; each mounted lifetime owns its slots and effects.
function harness() {
  let active;
  const frames = new Set();
  const changed = (old, deps) => !old || deps.length !== old.deps.length || deps.some((v, i) => !Object.is(v, old.deps[i]));
  const react = {
    useState(initial) { const h = active, i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [h.slots[i], value => { if (!h.disposed) h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value; }]; },
    useRef(initial) { const h = active, i = h.cursor++; return h.slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const h = active, i = h.cursor++; if (changed(h.slots[i], deps)) h.slots[i] = { deps, value: fn() }; return h.slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const h = active, i = h.cursor++, old = h.slots[i]; if (changed(old, deps)) h.effects.push(() => {
      old?.cleanup?.(); h.slots[i] = { deps, cleanup: fn() }; }); },
  };
  react.useLayoutEffect = react.useEffect;
  return { react, mount() {
    const h = { slots: [], cursor: 0, effects: [], disposed: false }; frames.add(h);
    return { render(Component, props) {
      assert.equal(h.disposed, false); active = h; h.cursor = 0; h.effects = [];
      const node = Component(props); for (const effect of h.effects) effect(); return node;
    }, data: () => h.slots.find(slot => slot && Object.hasOwn(slot, 'plans') && Object.hasOwn(slot, 'account')),
    routes: () => h.slots.find(slot => Array.isArray(slot) && typeof slot.at(-1)?.name === 'string'),
    dispose() {
      if (h.disposed) return; h.disposed = true; const failures = [];
      for (const slot of h.slots) { try { slot?.cleanup?.(); } catch (error) { failures.push(error); } }
      h.slots = []; frames.delete(h); if (failures.length) throw new AggregateError(failures, 'Hook frame disposal failed');
    } };
  }, remaining: () => frames.size };
}

// One APP cache preserves transport/ApiError identity. Replacements stop at native and UI leaves.
function appLoader(h, subscriptions) {
  const cache = new Map();
  const subscribe = () => { const record = {}; subscriptions.add(record); return { remove() { subscriptions.delete(record); } }; };
  const unavailable = () => { throw new Error('Native/provider leaf must not execute in Settings HTTP source evidence'); };
  const native = { Platform: { OS: 'web' }, StyleSheet: { create: value => value }, View: 'View', Pressable: 'Pressable',
    AppState: { addEventListener: subscribe }, BackHandler: { addEventListener: subscribe },
    AccessibilityInfo: { addEventListener: subscribe, isReduceMotionEnabled: async () => false } };
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
    'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', Rect: 'Rect', Line: 'Line' },
    'react-native-reanimated': { default: { createAnimatedComponent: value => value },
      Easing: { linear: unavailable }, useAnimatedProps: unavailable, useAnimatedStyle: unavailable,
      useSharedValue: unavailable, withDelay: unavailable, withTiming: unavailable, runOnJS: unavailable },
    'react-native-gesture-handler': { Gesture: { Pan: unavailable }, GestureDetector: 'GestureDetector' },
    expo: { isRunningInExpoGo: () => true, requireOptionalNativeModule: unavailable },
    'expo-crypto': { randomUUID, getRandomBytesAsync: unavailable, digestStringAsync: unavailable },
    'expo-secure-store': { isAvailableAsync: unavailable, getItemAsync: unavailable, setItemAsync: unavailable, deleteItemAsync: unavailable },
    'expo-apple-authentication': { isAvailableAsync: unavailable, signInAsync: unavailable } };
  const leaves = new Map([
    ['features/shared/ui', names], ['variants/a/components', names],
  ]);
  function load(name) {
    let file = path.resolve(appRoot, name);
    if (!fs.existsSync(file)) file += fs.existsSync(file + '.ts') ? '.ts' : '.tsx';
    else if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.ts');
    assert.ok(file.startsWith(appRoot + path.sep));
    const relative = path.relative(appRoot, file), stem = relative.replace(/\.(ts|tsx)$/, '').split(path.sep).join('/');
    if (stem === 'api/client') return { ...load('api/transport.ts'), formApi: null, commandKey: randomUUID };
    if (stem === 'variants/a/theme') return { ...load('features/shared/tokens.ts'), useTextScale: () => ({ large: false }) };
    if (leaves.has(stem)) return leaves.get(stem);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      assert.ok(name.startsWith('.'), `Unexpected APP dependency: ${name}`);
      return load(path.relative(appRoot, path.resolve(path.dirname(file), name)));
    }, module, module.exports);
    return module.exports;
  }
  return load;
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of [tree.props?.children, tree.props?.actions, tree.props?.nav].flat(Infinity)) {
    const found = find(child, predicate); if (found) return found;
  }
  return null;
}
const byId = (tree, id) => { const node = find(tree, n => n.props?.testID === id || n.props?.captureId === id);
  assert.ok(node, `Missing actual auth element ${id}`); return node; };

async function apiInputs(t) {
  const files = ['src/server.ts', 'src/domain.ts', 'src/storage.ts', 'src/schemas.ts', 'src/auth.ts', 'src/settings.ts',
    'dist/src/server.js', 'dist/src/domain.js', 'dist/src/storage.js', 'dist/src/schemas.js', 'dist/src/auth.js', 'dist/src/settings.js'];
  const inventory = files.map(file => ({ file, sha256: sha(fs.readFileSync(path.join(apiRoot, file))) }));
  const identity = sha(JSON.stringify(inventory));
  // This bounded inventory identifies inputs; the root separately qualifies the full source-identical API dist.
  t.diagnostic(`Settings mode HTTP API input inventory ${identity}: ${JSON.stringify(inventory)}`);
  return import(pathToFileURL(path.join(apiRoot, 'dist/src/server.js')).href + '?settingsModeHttp=' + identity);
}

async function fixture(t, run) {
  const { createServer } = await apiInputs(t);
  t.signal.throwIfAborted();
  const parent = path.join(repository, '.scratch'); fs.mkdirSync(parent, { recursive: true });
  const ownedRoot = fs.mkdtempSync(path.join(parent, 'settings-mode-http-'));
  const dbPath = path.join(ownedRoot, 'synthetic.sqlite');
  const requests = new Set(), operations = new Set(), gates = new Set(), rules = new Map(), presentations = new Set();
  const constructions = new Set(), backends = new Set(), calls = [], subscriptions = new Set();
  const h = harness(), load = appLoader(h, subscriptions);
  let backend, stopping = false, restarting = false, cleanupResult, primary, failed = false;
  const track = (set, promise) => { set.add(promise); void promise.then(() => set.delete(promise), () => set.delete(promise)); return promise; };
  const operation = promise => track(operations, promise);
  const drain = async () => { while (requests.size || operations.size) await Promise.allSettled([...requests, ...operations]); };
  const cleanup = () => cleanupResult ??= (async () => {
    stopping = true; const failures = [];
    for (const gate of gates) gate.release(); rules.clear();
    for (const presentation of presentations) { try { presentation.dispose(); } catch (error) { failures.push(error); } }
    for (const construction of constructions) { try { backends.add(await construction); } catch { /* Startup error is preserved by the fixture's primary path. */ } }
    await drain(); await tick(); await drain();
    for (const value of backends) { try { await value.close(false); } catch (error) { failures.push(error); } }
    try {
      for (const value of backends) assert.equal(value.db.open, false, 'Close actual SQLite before owned-root removal');
      fs.rmSync(ownedRoot, { recursive: true, force: true }); assert.equal(fs.existsSync(ownedRoot), false);
    } catch (error) { failures.push(error); }
    try { assert.equal(h.remaining(), 0, 'Dispose every hook frame'); } catch (error) { failures.push(error); }
    try { assert.equal(subscriptions.size, 0, 'Remove native leaf subscriptions'); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Settings mode HTTP exact scratch cleanup failed');
  })();
  const signalExit = code => { void cleanup().then(() => {
    if (failed) process.stderr.write(inspect(primary, { depth: 4 }) + '\n'); process.exit(code);
  }, error => { process.stderr.write(inspect(failed ? new AggregateError([primary, error], 'Primary result and signal cleanup failed') : error, { depth: 4 }) + '\n'); process.exit(code); }); };
  const interrupt = () => signalExit(130), terminate = () => signalExit(143);
  const cancel = () => { void cleanup().catch(() => {}); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate); t.signal.addEventListener('abort', cancel, { once: true });
  try {
    const config = { dbPath, baseURL: origin, secret: 'synthetic-settings-http-secret-longer-than-32-characters',
      registration: { mode: 'allowlist', emails: ['one@synthetic.invalid', 'two@synthetic.invalid'] } };
    async function construct() {
      assert.equal(stopping, false);
      const construction = createServer(config); constructions.add(construction);
      const value = await construction; backends.add(value);
      if (stopping) throw new Error('Settings HTTP fixture is closing');
      backend = value;
      assert.equal(value.db.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(value.db.pragma('foreign_key_check'), []);
      assert.ok(value.migrationBackups.every(file => file.startsWith(ownedRoot + path.sep)));
      return value;
    }
    await construct();
    function dispatch(label, url, init = {}) {
      return track(requests, (async () => {
        if (stopping || restarting) throw new Error('Settings HTTP admission is closed');
        const request = new Request(url, init), parsed = new URL(request.url); assert.equal(parsed.origin, origin);
        const call = { label, path: parsed.pathname + parsed.search, method: request.method,
          authorization: request.headers.get('authorization'), key: request.headers.get('idempotency-key'),
          bodyText: request.method === 'GET' ? undefined : await request.clone().text(), status: null, response: undefined };
        call.body = call.bodyText === undefined || call.bodyText === '' ? undefined : JSON.parse(call.bodyText);
        calls.push(call);
        const rule = call.path === preferencesPath && call.method === 'PATCH' ? rules.get(label) : undefined;
        if (rule) rules.delete(label);
        const response = await backend.app.fetch(request);
        call.status = response.status; call.response = await response.clone().json();
        call.authToken = response.headers.get('set-auth-token');
        if (rule) {
          rule.entered.resolve(call);
          if (rule.lose) throw new Error('Synthetic delivery loss after actual preference PATCH committed');
          if (!stopping) await rule.delivery.promise;
        }
        return response;
      })());
    }
    const { FormTransport, ApiError } = load('api/transport.ts'), { FormResources } = load('api/resources.ts');
    const { FormRuntime } = load('FormRuntime.tsx'), { FormAccountApp } = load('features/shell/FormAccountApp.tsx');
    const { AuthFlow } = load('features/auth/AuthFlow.tsx'), { useSettingsScreenModel } = load('settings/SettingsScreen.tsx');
    const { appModeFrom } = load('settings/appMode.ts');
    const newClient = (label, storage) => {
      if (stopping) throw new Error('Settings HTTP fixture is closing');
      const api = new FormTransport(origin, storage, (url, init) => dispatch(label, url, init));
      return { label, api, resources: new FormResources(api), storage };
    };
    async function account(name) {
      let envelope = null;
      const storage = { async load() { return envelope; }, async save(value) { envelope = value; }, async clear() { envelope = null; } };
      const client = newClient(name, storage);
      await operation(client.api.signUp('Synthetic ' + name, name + '@synthetic.invalid', password));
      const signup = calls.at(-1); assert.equal(signup.path, '/api/auth/sign-up/email'); assert.ok(signup.authToken);
      assert.ok(signup.status >= 200 && signup.status < 300); assert.equal(JSON.parse(envelope).token, signup.authToken);
      const initial = await operation(client.resources.account()); assert.equal(initial.preferences.appMode, 'basic');
      const draft = await operation(client.resources.onboarding(initial.onboarding, { step: 'review',
        answers: { goals: ['Get stronger'], trainingBackground: 'returning' }, preferences: { equipment: ['Dumbbells'] } }));
      const complete = await operation(client.resources.completeOnboarding(draft, 'synthetic-settings-onboarding-' + name));
      assert.equal(complete.status, 'completed');
      const value = await operation(client.resources.account()); assert.equal(value.onboarding.status, 'completed');
      return { ...client, name, value, token: () => JSON.parse(envelope).token };
    }
    const one = await account('one'), two = await account('two');
    assert.notEqual(one.value.accountId, two.value.accountId); assert.notEqual(one.token(), two.token());
    const persisted = account => backend.db.prepare("SELECT revision,data FROM documents WHERE account_id=? AND kind='preferences'").get(account.value.accountId);
    const history = account => backend.db.prepare("SELECT revision,data FROM document_revisions WHERE account_id=? AND kind='preferences' ORDER BY revision").all(account.value.accountId);
    const writes = client => calls.filter(call => call.label === client.label && call.path === preferencesPath && call.method === 'PATCH');
    const heldPatch = (client, lose = false) => {
      assert.equal(stopping, false); assert.equal(rules.has(client.label), false);
      const entered = deferred(), delivery = deferred();
      const gate = { entered, delivery, lose, release: () => delivery.resolve(),
        wait: flight => Promise.race([entered.promise, flight.then(() => { throw new Error('Mode operation settled before held backend delivery'); })]) };
      gates.add(gate); rules.set(client.label, gate); return gate;
    };
    function mount(client) {
      if (stopping) throw new Error('Settings HTTP fixture is closing');
      const runtime = h.mount(), shell = h.mount();
      let settingsFrame = null, settingsKey = null, settingsContext = null, model = null, home = null, tree, runtimeEntry, snapshot;
      let authFrame = null, emailFrame = null, signInFrame = null, disposed = false;
      const attempts = [], reloads = [];
      const observe = (kind, run) => (...args) => {
        const flight = operation(Promise.resolve(run(...args)));
        const record = { kind, flight, result: undefined }; attempts.push(record);
        void flight.then(result => { record.result = result; }, error => { record.error = error; });
        return flight;
      };
      const props = { resources: client.resources, identity: {}, onSnapshot: value => { snapshot = value; },
        renderHome: ctx => { home = ctx; return 'synthetic-home-leaf'; },
        renderSettings: ctx => { settingsContext = { ...ctx,
          savePreferences: observe('preferences', ctx.savePreferences), signOut: observe('signOut', ctx.signOut),
          reload: () => { const flight = operation(ctx.reload()); reloads.push(flight); return flight; } };
          return 'synthetic-settings-leaf'; } };
      function disposeSettings() { settingsFrame?.dispose(); settingsFrame = null; settingsKey = null; model = null; }
      function disposeAuth() { emailFrame?.dispose(); signInFrame?.dispose(); authFrame?.dispose(); emailFrame = signInFrame = authFrame = null; }
      const host = { client, attempts, reloads,
        render() {
          if (stopping || disposed) throw new Error('Settings HTTP presentation is closing');
          settingsContext = null;
          runtimeEntry = runtime.render(FormRuntime, props); assert.equal(runtimeEntry.type, FormAccountApp);
          tree = shell.render(runtimeEntry.type, runtimeEntry.props);
          const entry = find(tree, node => node.type === 'View' && typeof node.key === 'string' && node.key.startsWith('settings:'));
          if (!entry) disposeSettings();
          else {
            assert.ok(settingsContext);
            if (settingsKey !== entry.key) { disposeSettings(); settingsFrame = h.mount(); settingsKey = entry.key; }
            model = settingsFrame.render(useSettingsScreenModel, settingsContext);
          }
          if (tree?.type !== AuthFlow) disposeAuth();
          return tree;
        },
        async until(predicate, message) {
          const deadline = Date.now() + 10000;
          do { t.signal.throwIfAborted(); host.render(); if (predicate()) return; await tick(); } while (Date.now() < deadline);
          assert.fail(message);
        },
        async ready(account) {
          await host.until(() => snapshot?.phase === 'ready' && home?.account.accountId === account.value.accountId &&
            shell.data()?.plansError === null && calls.some(call => call.label === client.label && call.path === '/v1/exercises' && call.status === 200),
          'Actual runtime/shell did not restore completed onboarding to Home');
          host.render(); assert.equal(shell.data().account.onboarding.status, 'completed');
          assert.deepEqual(shell.routes(), [{ name: 'home' }]);
        },
        async openSettings() {
          home.openSettings(); host.render(); host.render();
          assert.equal(shell.routes().at(-1).name, 'settings'); assert.ok(model?.snapshot.active); return model;
        },
        async closeSettings() {
          assert.ok(model); model.onBack(); host.render(); assert.equal(model, null);
          assert.deepEqual(shell.routes(), [{ name: 'home' }]);
        },
        async signIn(account) {
          assert.equal(host.render().type, AuthFlow);
          authFrame ??= h.mount(); signInFrame ??= h.mount(); emailFrame ??= h.mount();
          const entry = authFrame.render(AuthFlow, tree.props), signIn = signInFrame.render(entry.type, entry.props);
          byId(signIn, 'a-signin-email').props.onPress();
          let emailEntry = authFrame.render(AuthFlow, tree.props), email = emailFrame.render(emailEntry.type, emailEntry.props);
          assert.equal(byId(email, 'a-email-field').props.value, ''); assert.equal(byId(email, 'a-password-field').props.value, '');
          byId(email, 'a-email-field').props.onChangeText(account.name + '@synthetic.invalid');
          byId(email, 'a-password-field').props.onChangeText(password);
          email = emailFrame.render(emailEntry.type, emailEntry.props); byId(email, 'a-email-submit').props.onPress();
          await host.ready(account);
        },
        model: () => model, settings: () => settingsContext, home: () => home,
        data: shell.data, routes: shell.routes, runtimeMode: () => runtimeEntry.props.appMode,
        key: () => settingsKey, snapshot: () => snapshot,
        dispose() {
          if (disposed) return; disposed = true; const failures = [];
          for (const work of [disposeSettings, disposeAuth, shell.dispose, runtime.dispose]) {
            try { work(); } catch (error) { failures.push(error); }
          }
          if (failures.length) throw new AggregateError(failures, 'Settings HTTP presentation disposal failed');
        },
      };
      presentations.add(host); return host;
    }
    async function restart() {
      assert.equal(stopping, false); restarting = true;
      for (const gate of gates) gate.release();
      for (const host of presentations) host.dispose();
      await drain(); await tick(); await drain();
      await backend.close(false); assert.equal(backend.db.open, false);
      await construct(); restarting = false;
    }
    await run({ one, two, calls, ApiError, appModeFrom, operation, newClient, mount, persisted, history, writes, heldPatch, restart });
  } catch (error) { failed = true; primary = error; }
  finally {
    try { await cleanup(); } catch (error) {
      if (failed) throw new AggregateError([primary, error], 'Settings HTTP primary result and cleanup both failed');
      throw error;
    } finally {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); t.signal.removeEventListener('abort', cancel);
    }
  }
  if (failed) throw primary;
}

function modes(f, host, mode, revision) {
  assert.equal(host.model().snapshot.appModeControl.value, mode);
  assert.equal(host.model().snapshot.facts.appMode, mode);
  assert.equal(host.model().snapshot.account.preferences.revision, revision);
  assert.equal(f.appModeFrom(host.data().account), mode);
  assert.equal(host.data().account.preferences.revision, revision);
  assert.equal(host.settings().appMode, mode); assert.equal(host.home().appMode, mode); assert.equal(host.runtimeMode(), mode);
}
async function settled(host, state) {
  await host.until(() => host.model()?.snapshot.command.status === state && !host.model().snapshot.busy,
    `Actual Settings mode command did not settle as ${state}`);
  host.render(); host.render();
}

test('Settings HTTP actual mode event publishes only after delivery and persists across route, transport and SQLite restart', { timeout: 30000 }, t => fixture(t, async f => {
  const host = f.mount(f.one); await host.ready(f.one); await host.openSettings();
  const before = f.one.value.preferences.revision, b = f.persisted(f.two), bHistory = f.history(f.two);
  modes(f, host, 'basic', before); const key = host.key();
  const gate = f.heldPatch(f.one); host.model().onSelectAppMode('advanced');
  const attempt = host.attempts.at(-1), committed = await gate.wait(attempt.flight);
  assert.equal(committed.status, 200); assert.deepEqual(committed.body, { appMode: 'advanced', expectedRevision: before });
  assert.equal(committed.key, null); assert.equal(committed.authorization, 'Bearer ' + f.one.token());
  assert.equal(f.persisted(f.one).revision, before + 1); assert.equal(JSON.parse(f.persisted(f.one).data).appMode, 'advanced');
  host.render(); host.render(); assert.equal(host.key(), key); modes(f, host, 'basic', before);
  assert.equal(host.model().snapshot.command.status, 'pending'); assert.equal(host.model().snapshot.appModeControl.requested, 'advanced');
  assert.equal(host.model().snapshot.busy, true); assert.equal(f.writes(f.one).length, 1);
  gate.release(); assert.equal((await attempt.flight).status, 'saved'); await settled(host, 'idle');
  modes(f, host, 'advanced', before + 1); assert.equal(host.model().snapshot.appModeControl.requested, null);
  await host.closeSettings(); await host.openSettings(); modes(f, host, 'advanced', before + 1);
  host.dispose();
  const fresh = f.newClient('same-account-fresh', f.one.storage), reopened = f.mount(fresh);
  await reopened.ready(f.one); await reopened.openSettings(); modes(f, reopened, 'advanced', before + 1);
  assert.equal(reopened.data().account.accountId, f.one.value.accountId);
  const persisted = f.persisted(f.one), history = f.history(f.one);
  await f.restart();
  const afterRestart = f.mount(f.newClient('same-account-after-restart', f.one.storage));
  await afterRestart.ready(f.one); await afterRestart.openSettings(); modes(f, afterRestart, 'advanced', before + 1);
  assert.equal(afterRestart.data().account.accountId, f.one.value.accountId);
  assert.deepEqual(f.persisted(f.one), persisted); assert.deepEqual(f.history(f.one), history);
  assert.deepEqual(f.persisted(f.two), b); assert.deepEqual(f.history(f.two), bHistory);
  assert.equal(f.calls.filter(call => call.path === preferencesPath && call.method === 'PATCH').length, 1);
}));

test('Settings HTTP real stale CAS reconciles latest mode and actual refresh propagates read-only changes', { timeout: 30000 }, t => fixture(t, async f => {
  const host = f.mount(f.one); await host.ready(f.one); await host.openSettings();
  const before = f.one.value.preferences.revision, b = f.persisted(f.two), key = host.key();
  const second = f.newClient('one-second-transport', f.one.storage); assert.equal(await f.operation(second.api.restore()), true);
  const latest = await f.operation(second.resources.preferences(f.one.value.preferences, { appMode: 'advanced' }));
  assert.equal(latest.revision, before + 1); modes(f, host, 'basic', before);
  const callIndex = f.calls.length; host.model().onSelectAppMode('advanced');
  const attempt = host.attempts.at(-1); assert.equal((await attempt.flight).status, 'stale'); await settled(host, 'conflict');
  const stale = f.writes(f.one)[0]; assert.equal(stale.status, 409); assert.equal(stale.response.error.code, 'stale_revision');
  assert.deepEqual(stale.body, { appMode: 'advanced', expectedRevision: before }); assert.equal(stale.key, null);
  assert.deepEqual(attempt.result.latest, latest); assert.equal(host.key(), key); modes(f, host, 'advanced', before + 1);
  assert.equal(host.model().snapshot.appModeControl.requested, null); assert.equal(host.model().snapshot.intent, null);
  assert.ok(f.calls.slice(callIndex).some(call => call.label === f.one.label && call.path === '/v1/me' && call.method === 'GET' && call.status === 200));
  const refreshed = await f.operation(second.resources.preferences(latest, { appMode: 'basic' }));
  const db = f.persisted(f.one), history = f.history(f.one), writes = f.calls.filter(call => call.path === preferencesPath && call.method === 'PATCH').length;
  modes(f, host, 'advanced', before + 1); const refreshIndex = f.calls.length;
  host.model().onRefresh(); await host.reloads.at(-1); host.render(); host.render();
  await host.until(() => host.model().snapshot.settings.status === 'ready' && !host.model().snapshot.settings.refreshing, 'Settings refresh did not finish');
  host.render(); modes(f, host, 'basic', refreshed.revision);
  assert.ok(f.calls.slice(refreshIndex).some(call => call.path === '/v1/me' && call.method === 'GET' && call.status === 200));
  assert.equal(f.calls.filter(call => call.path === preferencesPath && call.method === 'PATCH').length, writes);
  assert.deepEqual(f.persisted(f.one), db); assert.deepEqual(f.history(f.one), history); assert.deepEqual(f.persisted(f.two), b);
}));

test('Settings HTTP late committed A mode delivery expires original auth/session fences after actual shell sign-out and B auth', { timeout: 30000 }, t => fixture(t, async f => {
  const host = f.mount(f.one); await host.ready(f.one); await host.openSettings();
  const oldModel = host.model(), oldSettings = host.settings(), oldHome = host.home(), auth = f.one.api.captureAuthContext();
  const before = f.one.value.preferences.revision, b = f.persisted(f.two), bHistory = f.history(f.two), oldKey = host.key();
  const gate = f.heldPatch(f.one); oldModel.onSelectAppMode('advanced');
  const attempt = host.attempts.at(-1), committed = await gate.wait(attempt.flight);
  assert.equal(committed.status, 200); assert.equal(f.persisted(f.one).revision, before + 1);
  host.render(); modes(f, host, 'basic', before);
  assert.equal((await f.operation(oldSettings.signOut())).status, 'saved');
  host.render(); assert.equal(host.model(), null); assert.equal(auth.isCurrent(), false); assert.equal(oldHome.isCurrentSession(), false);
  assert.deepEqual(host.routes(), [{ name: 'home' }]); assert.equal(host.data().account, null);
  await host.signIn(f.two); await host.openSettings();
  assert.notEqual(host.key(), oldKey); assert.notEqual(host.home().sessionGeneration, oldHome.sessionGeneration);
  modes(f, host, 'basic', f.two.value.preferences.revision); const current = host.data().account;
  gate.release(); const result = await attempt.flight;
  assert.equal(result.status, 'failed'); assert.ok(result.error instanceof f.ApiError);
  assert.equal(result.error.code, 'session_changed'); assert.equal(result.error.originalEffectUnknown, true);
  host.render(); host.render(); assert.equal(host.data().account, current); modes(f, host, 'basic', f.two.value.preferences.revision);
  const count = f.calls.length;
  oldModel.onSelectAppMode('basic'); oldModel.onRetryAppMode(); oldModel.onRefresh(); oldModel.onBack();
  oldHome.openSettings(); assert.equal((await oldSettings.savePreferences({ appMode: 'basic' })).status, 'failed');
  await assert.rejects(oldSettings.resources.account(), error => error instanceof f.ApiError && error.code === 'session_changed');
  await tick(); assert.equal(f.calls.length, count); assert.equal(f.writes(f.one).length, 1);
  assert.deepEqual(f.persisted(f.two), b); assert.deepEqual(f.history(f.two), bHistory);
  const freshA = f.newClient('one-fresh-after-late', { async load() { return null; }, async save() {}, async clear() {} });
  await f.operation(freshA.api.signIn('one@synthetic.invalid', password)); const restoredA = await f.operation(freshA.resources.account());
  assert.equal(restoredA.accountId, f.one.value.accountId); assert.equal(restoredA.preferences.appMode, 'advanced');
  assert.equal(restoredA.preferences.revision, before + 1); modes(f, host, 'basic', f.two.value.preferences.revision);
}));

test('Settings HTTP commit then delivery loss retains exact explicit retry and reconciles CAS without a second preference effect', { timeout: 30000 }, t => fixture(t, async f => {
  const host = f.mount(f.one); await host.ready(f.one); await host.openSettings();
  const before = f.one.value.preferences.revision, b = f.persisted(f.two), key = host.key();
  f.heldPatch(f.one, true); host.model().onSelectAppMode('advanced');
  const attempt = host.attempts.at(-1), unknown = await attempt.flight;
  assert.equal(unknown.status, 'unknown'); assert.equal(typeof unknown.retry, 'function'); await settled(host, 'unknown');
  modes(f, host, 'basic', before); assert.equal(host.key(), key);
  assert.equal(host.model().snapshot.appModeControl.requested, 'advanced'); assert.equal(host.model().snapshot.canRetry, true);
  assert.deepEqual(host.model().snapshot.intent, { appMode: 'advanced' });
  const committed = f.persisted(f.one), history = f.history(f.one);
  assert.equal(committed.revision, before + 1); assert.equal(JSON.parse(committed.data).appMode, 'advanced');
  assert.equal(f.writes(f.one)[0].status, 200); assert.equal(f.writes(f.one).length, 1);
  // Ordinary mode selection and refresh cannot turn an unknown write into an automatic new intent.
  host.model().onSelectAppMode('basic'); host.model().onRefresh(); await tick(); host.render(); await tick();
  assert.equal(f.writes(f.one).length, 1); modes(f, host, 'basic', before);
  const retryIndex = f.calls.length; host.model().onRetryAppMode(); await settled(host, 'conflict');
  const [first, retry] = f.writes(f.one); assert.equal(f.writes(f.one).length, 2);
  assert.equal(retry.bodyText, first.bodyText); assert.deepEqual(retry.body, first.body);
  assert.equal(retry.body.expectedRevision, before); assert.equal(retry.authorization, first.authorization);
  assert.equal(first.key, null); assert.equal(retry.key, null); assert.equal(retry.status, 409);
  assert.equal(retry.response.error.code, 'stale_revision');
  assert.ok(f.calls.slice(retryIndex).some(call => call.label === f.one.label && call.path === '/v1/me' && call.method === 'GET' && call.status === 200));
  modes(f, host, 'advanced', before + 1); assert.equal(host.model().snapshot.appModeControl.requested, null);
  assert.equal(host.model().snapshot.canRetry, false); assert.equal(host.model().snapshot.retried, true);
  assert.deepEqual(f.persisted(f.one), committed); assert.deepEqual(f.history(f.one), history);
  assert.equal(history.filter(row => row.revision > before).length, 1); assert.deepEqual(f.persisted(f.two), b);
}));
