const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function loader(mocks = {}) {
  const cache = new Map();
  function load(name) {
    let file = path.resolve(root, name);
    if (!fs.existsSync(file)) file += fs.existsSync(file + '.ts') ? '.ts' : '.tsx';
    else if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.ts');
    assert.ok(file.startsWith(root + path.sep));
    const relative = path.relative(root, file);
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
      return load(path.relative(root, path.resolve(path.dirname(file), name)));
    }, module, module.exports);
    return module.exports;
  }
  return load;
}
function harness() {
  let active;
  const instances = [];
  const changed = (old, deps) => !old || deps.length !== old.deps.length || deps.some((v, i) => !Object.is(v, old.deps[i]));
  const react = {
    useState(initial) { const h = active, i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial;
      return [h.slots[i], value => {
        const apply = () => { h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value; };
        if (h.holdRoutes && Array.isArray(h.slots[i]) && typeof h.slots[i].at(-1)?.name === 'string') h.routeUpdates.push(apply);
        else apply();
      }]; },
    useRef(initial) { const h = active, i = h.cursor++; return h.slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const h = active, i = h.cursor++; if (changed(h.slots[i], deps)) h.slots[i] = { deps, value: fn() }; return h.slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const h = active, i = h.cursor++, old = h.slots[i]; if (changed(old, deps)) h.effects.push(() => {
      old?.cleanup?.(); h.slots[i] = { deps, cleanup: fn() }; }); },
  };
  react.useLayoutEffect = react.useEffect;
  return { react, mount() {
    const h = { slots: [], cursor: 0, effects: [], holdRoutes: false, routeUpdates: [] }; instances.push(h);
    return { render(Component, props) { active = h; h.cursor = 0; h.effects = []; const node = Component(props);
      for (const effect of h.effects) effect(); return node; },
    data: () => h.slots.find(slot => slot && Object.hasOwn(slot, 'plans') && Object.hasOwn(slot, 'account')),
    routes: () => h.slots.find(slot => Array.isArray(slot) && typeof slot.at(-1)?.name === 'string'),
    holdRoutes() { h.holdRoutes = true; },
    flushRoutes() { h.holdRoutes = false; for (const apply of h.routeUpdates.splice(0)) apply(); },
    dispose() { for (const slot of h.slots) slot?.cleanup?.(); h.slots = []; } };
  }, dispose() { for (const h of instances) for (const slot of h.slots) slot?.cleanup?.(); } };
}

const jsx = (type, props, key) => ({ type, props, key }), noop = () => {};
const load = loader(), { ApiError } = load('api/transport.ts');
const { createCommandOwnerRegistry } = load('integration/commandOwnerSession.ts');
const { createManualProgressController } = load('body/manualProgressController.ts');
const { validateManualCommandConfirmation } = load('body/manualCommandConfirmation.ts');
const { validateManualRetentionCommandConfirmation } = load('body/manualRetentionConfirmation.ts');
const contract = load('body/manualRetentionContract.ts');
const { createManualProgressSession } = load('integration/manualProgressSession.ts');
const { FormResources } = loader({ 'api/client.ts': { ApiError, formApi: null } })('api/resources.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
const available = () => ({ status: 'available', scope: 'manual_only', provenance: 'manual_reported' });
const caps = () => ({ schema: 'form.body-capabilities/v1', manualRetention: {
  schema: contract.MANUAL_RETENTION_CAPABILITY_SCHEMA, protocol: contract.MANUAL_RETENTION_PROTOCOL,
  statement: contract.MANUAL_RETENTION_STATEMENT_BINDING, status: 'available', grant: 'available', revoke: 'available', current: 'available',
}, retainedMeasurements: available(), progress: available(), bodyDeletion: available(),
  operations: { save_manual_measurement: available(), list_progress: available(), delete_assessment: available() } });
const input = Object.freeze({ kind: 'waist', value: 80, unit: 'cm', measuredOn: '2026-10-11' });
const command = key => ({ key, payload: { ...input } });
const confirmed = call => ({ id: 'f11b84c3-2857-4a78-9c5a-cc4b3223da51', kind: call.body.kind, value: call.body.value,
  unit: call.body.unit, originalUnit: call.body.unit, measuredOn: call.body.measuredOn, note: null, provenance: 'manual_reported' });
function localRetain(controller) {
  const fence = controller.captureFence(); controller.chooseProcessing(fence);
  controller.chooseDerivedRetention(contract.MANUAL_RETENTION_PROTOCOL, fence); return fence;
}
const grantCommand = () => { const decisionId = randomUUID(); return { key: 'grant-' + decisionId, payload: {
  decisionId, processing: 'manual_entry', purpose: 'personal_measurement_progress', choice: 'retain',
  statementId: 'manual-personal-progress', statementVersion: 1, statementSha256: contract.MANUAL_RETENTION_STATEMENT_SHA256,
} }; };
const grantResponse = command => ({ schema: contract.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA,
  receipt: { operation: 'grant', decisionId: command.payload.decisionId, outcome: 'granted', decisionRevision: 1 },
  current: { decisionId: command.payload.decisionId, state: 'granted', revision: 1, statement: contract.MANUAL_RETENTION_STATEMENT_BINDING },
});
async function consent(controller) {
  const result = await controller.grantRetention(grantCommand(), localRetain(controller));
  assert.equal(result.effect, 'confirmed'); controller.acknowledgeCommand(result.id);
  return controller.captureFence();
}
function fixture({ customBody = true, validator, owner = true } = {}) {
  const h = harness(), runtimeMount = h.mount(), listeners = new Set(), authListeners = new Set();
  const f = { current: true, authEpoch: 1, calls: [], controllers: [], dependencies: [], registryValidators: [], postWork: null, body: null };
  const api = { captureAuthContext() { const original = f.authEpoch; return { isCurrent: () => original === f.authEpoch }; },
    subscribeAuthChanges(listener) { authListeners.add(listener); return { remove: () => authListeners.delete(listener) }; },
    async request(path, method = 'GET', body, key) {
      const call = { path, method, body, key }; f.calls.push(call);
      if (path === '/v1/body/capabilities') return caps();
      if (path === '/v1/body/manual-retention' && method === 'POST') return grantResponse({ key, payload: body });
      if (path === '/v1/body/measurements' && method === 'GET') return { items: [] };
      if (path === '/v1/body/measurements' && method === 'POST') return f.postWork ? f.postWork(call) : confirmed(call);
      assert.fail('Unexpected actual manual client route: ' + method + ' ' + path);
    } };
  const resources = new FormResources(api);
  const voice = { speech: () => ({}), stop: async () => ({ status: 'released', failedSteps: [] }), stopScope: async () => ({ status: 'released', failedSteps: [] }), dispose: async () => {} };
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { AccessibilityInfo: {}, AppState: {
    addEventListener(_name, listener) { listeners.add(listener); return { remove: () => listeners.delete(listener) }; } } }, 'expo-crypto': {},
    'api/client.ts': { ApiError, commandKey: () => 'synthetic-command' }, 'api/resources.ts': { formResources: null },
    'api/phoneSignIn.ts': {}, 'api/featureBoard.ts': {}, 'api/community.ts': {}, 'api/appleSignIn.ts': {},
    'body/index.ts': { BodyFlow: 'DefaultBody', bodyPrivacySummary: () => ({ status: 'unavailable' }) },
    'native/runtime.ts': { bindFormNativeModule: () => ({ module: null, reason: 'platform_unsupported' }) },
    'integration/sharedVoice.ts': { createSharedVoice: () => voice }, 'account-lifecycle/native.ts': {},
    'integration/lifecycleSession.ts': { createLifecycleSession: options => options },
    'integration/commandOwnerSession.ts': { createCommandOwnerRegistry(predicate) { f.registryValidators.push(predicate); return createCommandOwnerRegistry(predicate); } },
    'body/manualProgressController.ts': { createManualProgressController(deps) {
      f.dependencies.push(deps); const controller = createManualProgressController(deps); f.controllers.push(controller); return controller;
    } },
    'integration/presentationPolicy.ts': {}, 'integration/systemMotion.ts': { observeSystemMotion: () => noop },
    'settings/appMode.ts': {}, 'features/index.ts': { FormAccountApp: 'Shell' } };
  const { FormRuntime } = loader(mocks)('FormRuntime.tsx');
  const props = { resources, renderSettings: () => null,
    ...(customBody ? { renderBody: ctx => { f.body = ctx; return 'manual-body'; } } : {}),
    ...(validator ? { validateConfirmation: validator } : {}) };
  let shell = runtimeMount.render(FormRuntime, props), bodyMount = h.mount();
  const originalAuth = api.captureAuthContext();
  const hostCurrent = () => f.current && originalAuth.isCurrent();
  const commandSession = { accountId: 'original', sessionGeneration: 'original:1', resources, originalAuth, isCurrentSession: hostCurrent };
  const custody = owner ? shell.props.commandOwnerForSession(commandSession) : undefined;
  const ctx = { account: { accountId: 'original' }, resources, sessionGeneration: 'original:1', isCurrentSession: hostCurrent,
    ...(custody ? { commandOwner: custody } : {}), appMode: 'basic', close: noop };
  const access = { accountId: 'original', sessionGeneration: 'original:1' };
  function renderBody() { const node = shell.props.renderBody(ctx); return typeof node.type === 'function' ? bodyMount.render(node.type, node.props) : node; }
  Object.assign(f, { props, ctx, resources, api, access, custody, renderBody,
    renderRuntime() { shell = runtimeMount.render(FormRuntime, props); },
    reopen() { bodyMount.dispose(); bodyMount = h.mount(); renderBody(); renderBody(); return f.body; },
    close() { bodyMount.dispose(); },
    background() { for (const listener of [...listeners]) listener('background'); },
    replaceAuth() { f.authEpoch++; for (const listener of [...authListeners]) listener(); },
    captureCleanup() { return shell.props.lifecycleSession({ accountId: 'original', sessionKey: 'original:1' }).captureResources(); },
    posts: () => f.calls.filter(call => call.method === 'POST' && call.path === '/v1/body/measurements'), dispose: h.dispose,
  });
  renderBody(); renderBody(); return f;
}

test('custom Body alone exposes one lazy actual controller; default Body props and startup HTTP remain unchanged', async () => {
  const ordinary = fixture({ customBody: false });
  try {
    const node = ordinary.renderBody(); assert.equal(node.type, 'DefaultBody');
    assert.deepEqual(Object.keys(node.props).sort(), ['accountId', 'appMode', 'onClose']);
    assert.equal(node.props.accountId, 'original'); assert.equal(node.props.appMode, 'basic'); assert.equal(node.props.onClose, ordinary.ctx.close);
    assert.equal(ordinary.controllers.length, 0); assert.equal(ordinary.calls.length, 0);
  } finally { ordinary.dispose(); }
  const f = fixture();
  try {
    assert.equal(f.controllers.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.registryValidators.length, 1);
    const c = f.body.createManualProgress(); assert.equal(c, f.controllers[0]); assert.equal(f.body.createManualProgress(), c);
    f.renderBody(); assert.equal(f.body.createManualProgress(), c); assert.equal(f.controllers.length, 1); assert.equal(f.calls.length, 0);
    assert.equal(c.snapshot().retention.choices.derived.choice, 'unset'); assert.equal(c.snapshot().retention.processing, null);
    f.close(); assert.equal(c.snapshot().active, false); assert.equal(f.body.createManualProgress(), null);
  } finally { f.dispose(); }
});

test('producer captures original account API generation owner and host predicate before caller retargeting', async () => {
  const f = fixture();
  try {
    const ctx = { ...f.ctx, account: { ...f.ctx.account } }, session = createManualProgressSession(ctx);
    ctx.account.accountId = 'foreign'; ctx.resources = new FormResources({ request: () => assert.fail('replacement API'), captureAuthContext: () => ({ isCurrent: () => true }) });
    ctx.sessionGeneration = 'foreign:2'; ctx.commandOwner = undefined; ctx.isCurrentSession = () => false;
    const c = session.create(); assert.ok(c); await c.loadProgress();
    assert.equal(c.snapshot().writes.available, true); assert.equal(c.captureFence().accountId, 'original');
    assert.equal(f.calls.every(call => call.method === 'GET'), true); session.dispose(); assert.equal(session.create(), null);
    f.current = false; assert.equal(createManualProgressSession(f.ctx).create(), null);
  } finally { f.dispose(); }
});

test('missing command owner remains read-only even when server capabilities advertise manual writes', async () => {
  const f = fixture({ owner: false });
  try {
    const c = f.body.createManualProgress(); await c.loadProgress();
    assert.equal(c.snapshot().progress.status, 'empty'); assert.equal(c.snapshot().capabilities.value.create, true);
    assert.deepEqual(c.snapshot().writes, { available: false, reason: 'command_owner_unbound' });
    assert.equal(c.create, undefined); assert.equal(c.delete, undefined); assert.equal(f.posts().length, 0);
  } finally { f.dispose(); }
});

test('Runtime captures the actual measurement and retention predicates once; status reads never prove controls', async () => {
  const f = fixture();
  try {
    const predicate = f.registryValidators[0], g = grantCommand(), proof = grantResponse(g);
    const grantIntent = { operation: 'grant_manual_retention', command: g };
    const revokeIntent = { operation: 'revoke_manual_retention', command: { decisionId: g.payload.decisionId, key: 'revoke-proof', payload: {} } };
    const revoked = { schema: contract.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA,
      receipt: { operation: 'revoke', decisionId: g.payload.decisionId, outcome: 'revoked', decisionRevision: 2 },
      current: { ...proof.current, state: 'revoked', revision: 2 } };
    const measurementIntent = { operation: 'save_manual_measurement', command: command('measurement-proof') };
    const measurement = confirmed({ body: input });
    const deletionIntent = { operation: 'delete_assessment', command: { id: measurement.id, key: 'delete-proof', payload: {} } };
    for (const [intent, result] of [[grantIntent, proof], [revokeIntent, revoked], [measurementIntent, measurement], [deletionIntent, { deleted: true }]])
      assert.equal(predicate(intent, result), true);
    for (const intent of [grantIntent, revokeIntent]) {
      assert.equal(predicate(intent, { schema: contract.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current: proof.current }), false);
      assert.equal(predicate(intent, { schema: contract.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current: null }), false);
      assert.equal(predicate(intent, measurement), false);
    }
    assert.equal(predicate(grantIntent, revoked), false); assert.equal(predicate(revokeIntent, proof), false);
    assert.equal(predicate(measurementIntent, proof), false); assert.equal(predicate(deletionIntent, revoked), false);
    assert.equal(validateManualRetentionCommandConfirmation(grantIntent, proof), true);
    assert.equal(validateManualCommandConfirmation(measurementIntent, measurement), true);
    f.props.validateConfirmation = () => false; f.renderRuntime(); f.renderBody();
    assert.equal(f.registryValidators.length, 1); assert.equal(f.registryValidators[0], predicate);
    const c = f.body.createManualProgress(), result = await c.create(command('default-qualified'), await consent(c));
    assert.equal(result.effect, 'confirmed'); assert.equal(f.custody.snapshot(f.access)[0].effect, 'confirmed');
  } finally { f.dispose(); }
});

test('Runtime custom false or throwing validators are captured once and never fall back for any command', async () => {
  for (const validator of [() => false, () => { throw new Error('synthetic validator rejection'); }]) {
    const f = fixture({ validator });
    try {
      const c = f.body.createManualProgress(), g = grantCommand();
      const rejectedGrant = await c.grantRetention(g, localRetain(c));
      assert.equal(rejectedGrant.effect, 'unknown');
      assert.throws(() => c.create(command('no-authority-from-custom'), c.captureFence()), { code: 'body_command_not_started' });
      f.props.validateConfirmation = validateManualRetentionCommandConfirmation; f.renderRuntime(); f.renderBody();
      assert.equal((await c.retryCommand(rejectedGrant.id, c.captureFence())).effect, 'unknown');
      for (const [intent, response] of [
        [{ operation: 'save_manual_measurement', command: command('custom-measurement') }, confirmed({ body: input })],
        [{ operation: 'delete_assessment', command: { id: confirmed({ body: input }).id, key: 'custom-delete', payload: {} } }, { deleted: true }],
        [{ operation: 'revoke_manual_retention', command: { decisionId: g.payload.decisionId, key: 'custom-revoke', payload: {} } },
          { schema: contract.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA,
            receipt: { operation: 'revoke', decisionId: g.payload.decisionId, outcome: 'revoked', decisionRevision: 2 },
            current: { ...grantResponse(g).current, state: 'revoked', revision: 2 } }],
      ]) {
        const attempt = f.custody.hold({ ...f.access, ...intent });
        attempt.report({ status: 'confirmed', settled: true, response });
        assert.equal(f.custody.reconcile(f.access, attempt.id).snapshot().effect, 'unknown');
      }
      assert.equal(f.registryValidators.length, 1); assert.equal(f.registryValidators[0], validator);
      assert.equal(f.custody.snapshot(f.access).every(value => value.effect === 'unknown'), true);
      assert.equal(f.posts().length, 0);
    } finally { f.dispose(); }
  }
});

test('presentation disposal keeps original late confirmation reporting alive and reopened consent unset', async () => {
  const f = fixture(), late = deferred(), entered = deferred(); let flight;
  try {
    const c = f.body.createManualProgress(); f.postWork = call => { entered.resolve(call); return late.promise; };
    flight = c.create(command('late-original'), await consent(c)); const call = await entered.promise;
    const id = f.custody.snapshot(f.access)[0].id; f.close();
    assert.equal(c.snapshot().active, false); assert.equal(f.dependencies[0].isCurrentSession(), true);
    assert.equal(f.custody.snapshot(f.access)[0].locallyPending, 1);
    const next = f.reopen().createManualProgress(); assert.notEqual(next, c); assert.equal(f.dependencies[1].commandOwner, f.custody);
    assert.equal(next.snapshot().retention.choices.derived.choice, 'unset');
    assert.deepEqual(next.recoverCommand(id).intent.command, command('late-original'));
    assert.throws(() => next.retryCommand(id, next.captureFence()), { code: 'body_command_not_started' });
    const renewed = await consent(next);
    assert.throws(() => next.retryCommand(id, renewed), { code: 'attempt_pending' }); assert.equal(f.posts().length, 1);
    late.resolve(confirmed(call)); assert.equal(await flight, null);
    assert.equal(f.custody.snapshot(f.access)[0].effect, 'confirmed'); assert.equal(f.custody.snapshot(f.access)[0].locallyPending, 0);
    assert.equal(next.recoverCommand(id).metadata.effect, 'confirmed');
  } finally { late.resolve({}); await flight; f.dispose(); }
});

test('same-session reopen recovers original unknown intent and key and requires renewed consent before explicit retry', async () => {
  const f = fixture();
  try {
    const c = f.body.createManualProgress(); f.postWork = () => Promise.reject(new ApiError(0, 'synthetic_unknown', 'Synthetic unknown', true));
    const first = await c.create(command('original-key'), await consent(c)); assert.equal(first.effect, 'unknown');
    f.close(); const next = f.reopen().createManualProgress();
    const recovered = next.recoverCommand(first.id); assert.deepEqual(recovered.intent.command, command('original-key'));
    assert.equal(next.snapshot().retention.choices.derived.choice, 'unset');
    assert.throws(() => next.retryCommand(first.id, next.captureFence()), { code: 'body_command_not_started' });
    f.postWork = null; const retry = await next.retryCommand(first.id, await consent(next));
    assert.equal(retry.effect, 'confirmed'); assert.equal(retry.attempts, 2); assert.deepEqual(f.posts()[1], f.posts()[0]);
  } finally { f.dispose(); }
});

test('background permanently closes presentation factory while a fresh reopen uses the same owner with unset consent', async () => {
  const f = fixture();
  try {
    const oldContext = f.body, c = oldContext.createManualProgress(); await consent(c); f.background();
    assert.equal(c.snapshot().active, false); assert.equal(oldContext.createManualProgress(), null);
    const next = f.reopen().createManualProgress(); assert.notEqual(next, c);
    assert.equal(next.snapshot().writes.available, true); assert.equal(next.snapshot().retention.choices.derived.choice, 'unset'); assert.equal(f.posts().length, 0);
  } finally { f.dispose(); }
});

test('captured account cleanup retains pending liabilities and stale auth cannot dispatch, revive or acknowledge them', async () => {
  const f = fixture(), late = deferred(), entered = deferred(); let flight;
  try {
    const c = f.body.createManualProgress(); f.postWork = call => { entered.resolve(call); return late.promise; };
    flight = c.create(command('cleanup-liability'), await consent(c)); await entered.promise;
    const pending = f.custody.snapshot(f.access)[0], cleanup = f.captureCleanup();
    await assert.rejects(cleanup, /cleanup is incomplete/);
    assert.equal(c.snapshot().active, false); assert.equal(f.body.createManualProgress(), null);
    assert.equal(f.custody.snapshot(f.access)[0].locallyPending, 1);
    f.replaceAuth(); late.resolve(confirmed(f.posts()[0])); await flight;
    assert.throws(() => f.custody.snapshot(f.access), { code: 'session_changed' });
    assert.throws(() => f.custody.acknowledge(f.access, pending.id), { code: 'session_changed' });
    await assert.rejects(cleanup, /cleanup is incomplete/); assert.equal(f.posts().length, 1);
    assert.equal(f.reopen().createManualProgress(), null);
  } finally { late.resolve({}); await flight; f.dispose(); }
});

function shellAccount() {
  return { accountId: 'original', onboarding: { status: 'completed' },
    profile: { revision: 4, name: 'Original', age: null, heightCm: null, weightKg: null, trainingBackground: 'returning', injuryHistory: '', goals: ['strength'] },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'direct',
      communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['dumbbell'], remindersEnabled: false } };
}

// This fixture composes actual Runtime, shell, transport, resources and manual controller. Native/UI leaves remain synthetic.
async function actualShellFixture() {
  const h = harness(), runtimeMount = h.mount(), shellMount = h.mount();
  let bodyMount = null, home, body;
  const f = { calls: [], controllers: [], dependencies: [], postWork: null, heldCleanup: false };
  const { FormTransport } = load('api/transport.ts');
  const json = value => new Response(JSON.stringify(value));
  const api = new FormTransport('https://form.example.invalid', {
    async load() { return JSON.stringify({ version: 1, baseURL: 'https://form.example.invalid', token: 'synthetic-original' }); },
    async save() {}, async clear() {},
  }, async (url, init) => {
    const call = { path: new URL(url).pathname, method: init.method, body: init.body ? JSON.parse(init.body) : undefined,
      key: init.headers['Idempotency-Key'], authorization: init.headers.Authorization };
    f.calls.push(call);
    if (call.path === '/v1/capabilities') return json({});
    if (call.path === '/v1/me') return json(shellAccount());
    if (call.path === '/v1/me/settings' || call.path === '/v1/entitlements') return json({ accountId: 'original' });
    if (call.path === '/v1/exercises' || call.path === '/v1/plans') return json({ items: [] });
    if (call.path === '/v1/body/capabilities') return json(caps());
    if (call.path === '/v1/body/manual-retention' && call.method === 'POST') return json(grantResponse({ key: call.key, payload: call.body }));
    if (call.path === '/v1/body/measurements' && call.method === 'POST') return f.postWork ? f.postWork(call) : json(confirmed(call));
    if (call.path === '/v1/body/measurements' && call.method === 'GET') return json({ items: [] });
    assert.fail('Unexpected actual shell/body HTTP: ' + call.method + ' ' + call.path);
  });
  const resources = new FormResources(api);
  const names = new Proxy({}, { get: (_, name) => name }), tokens = new Proxy({}, { get: () => tokens });
  const speech = { cancel: async () => {}, dispose: async () => {} };
  const voice = { speech: () => speech, stop: async () => ({ status: 'released', failedSteps: [] }),
    stopScope: async () => ({ status: 'released', failedSteps: [] }), dispose: async () => {} };
  const native = { View: 'View', Pressable: 'Pressable', StyleSheet: { create: value => value }, AccessibilityInfo: {},
    AppState: { addEventListener: () => ({ remove: noop }) } };
  const mocks = { react: h.react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native, 'expo-crypto': {},
    'api/client.ts': { ApiError, commandKey: () => 'synthetic-key' }, 'api/resources.ts': { formResources: null },
    'api/phoneSignIn.ts': {}, 'api/featureBoard.ts': {}, 'api/community.ts': {}, 'api/appleSignIn.ts': {},
    'body/index.ts': { BodyFlow: 'DefaultBody', bodyPrivacySummary: () => ({ status: 'unavailable' }) },
    'native/runtime.ts': { bindFormNativeModule: () => ({ module: null, reason: 'platform_unsupported' }) },
    'native/speech.ts': { FormSpeechAdapter: function () { return speech; } },
    'integration/sharedVoice.ts': { createSharedVoice: () => voice,
      captureSharedVoiceScope(transport, account, current) {
        const auth = transport.captureAuthContext(); return { account, isCurrent: () => auth.isCurrent() && current() };
      } },
    'account-lifecycle/native.ts': {}, 'integration/lifecycleSession.ts': { createLifecycleSession: options => ({ ...options, dispose: noop }) },
    'integration/commandOwnerSession.ts': { createCommandOwnerRegistry },
    'body/manualProgressController.ts': { createManualProgressController(deps) {
      f.dependencies.push(deps); const controller = createManualProgressController(deps); f.controllers.push(controller); return controller;
    } },
    'integration/presentationPolicy.ts': { resolvePresentationPolicy: () => ({}) },
    'integration/systemMotion.ts': { observeSystemMotion: () => noop }, 'settings/appMode.ts': { appModeFrom: () => 'basic' },
    'features/index.ts': { FormAccountApp: 'ActualShellEntry' },
    'features/account/AccountScreens.tsx': names, 'features/auth/AuthFlow.tsx': names, 'features/cues/CuesScreen.tsx': names,
    'features/onboarding/OnboardingFlow.tsx': names, 'features/plans/PlansScreens.tsx': names,
    'features/shared/copy.ts': { COPY: {}, errorCopy: error => error.message },
    'features/shared/tokens.ts': { t: tokens, L: tokens }, 'features/shared/ui.tsx': names,
  };
  const fixtureLoad = loader(mocks);
  const { FormRuntime } = fixtureLoad('FormRuntime.tsx'), { FormAccountApp } = fixtureLoad('features/shell/FormAccountApp.tsx');
  const runtimeProps = { resources, renderSettings: () => 'settings', renderHome: ctx => { home = ctx; return 'home'; },
    renderBody: ctx => { body = ctx; return 'manual-body'; } };
  const shellEntry = runtimeMount.render(FormRuntime, runtimeProps);
  const findBoundary = tree => {
    if (!tree || typeof tree !== 'object') return null;
    if (typeof tree.type === 'function' && tree.type.name === 'ManualProgressBoundary') return tree;
    for (const child of [tree.props?.children].flat(Infinity)) { const found = findBoundary(child); if (found) return found; }
    return null;
  };
  function render() {
    const tree = shellMount.render(FormAccountApp, shellEntry.props), boundary = findBoundary(tree);
    if (boundary) {
      bodyMount ??= h.mount(); bodyMount.render(boundary.type, boundary.props);
    } else if (bodyMount && !f.heldCleanup) { bodyMount.dispose(); bodyMount = null; }
    return tree;
  }
  Object.assign(f, { api, resources, render, home: () => home, body: () => body, data: shellMount.data, routes: shellMount.routes,
    holdNavigation() { shellMount.holdRoutes(); f.heldCleanup = true; },
    flushNavigation() { f.heldCleanup = false; shellMount.flushRoutes(); render(); render(); },
    openBody() { home.openBody(); render(); render(); return body; },
    posts: () => f.calls.filter(call => call.path === '/v1/body/measurements' && call.method === 'POST'),
    dispose: h.dispose,
  });
  render(); await tick(); await tick(); render(); await tick(); render();
  assert.equal(home.isCurrentSession(), true); f.calls.length = 0;
  return f;
}

for (const departure of ['rendered close', 'retained Home route'])
  test(`Body pre-close actual shell ${departure} ends presentation before held cleanup and preserves original issued custody`, async () => {
    const f = await actualShellFixture(), late = deferred(), entered = deferred(); let flight;
    try {
      const oldContext = f.openBody(), c = oldContext.createManualProgress(), owner = oldContext.commandOwner;
      const access = { accountId: oldContext.account.accountId, sessionGeneration: oldContext.sessionGeneration };
      f.postWork = call => { entered.resolve(call); return late.promise; };
      flight = c.create(command('pre-close-' + departure.replaceAll(' ', '-')), await consent(c)); const issued = await entered.promise;
      assert.equal(issued.authorization, 'Bearer synthetic-original');
      const id = owner.snapshot(access)[0].id, routes = f.routes(), oldClose = oldContext.close, retainedHome = f.home();
      f.holdNavigation();
      if (departure === 'rendered close') oldClose(); else retainedHome.openSettings();
      assert.equal(f.routes(), routes); assert.equal(c.snapshot().active, false);
      assert.equal(oldContext.createManualProgress(), null); assert.equal(f.dependencies[0].isCurrentSession(), true);
      assert.equal(owner.snapshot(access)[0].locallyPending, 1); assert.equal(f.posts().length, 1);
      const before = f.calls.length;
      await c.loadProgress(); assert.throws(() => c.create(command('retained-dispatch'), c.captureFence()), { code: 'body_command_not_started' });
      assert.equal(f.calls.length, before);
      late.resolve(new Response(JSON.stringify(confirmed(issued)))); assert.equal(await flight, null);
      assert.equal(owner.snapshot(access)[0].effect, 'confirmed'); assert.equal(owner.snapshot(access)[0].locallyPending, 0);
      f.flushNavigation(); const nextContext = f.openBody(), next = nextContext.createManualProgress();
      assert.notEqual(next, c); assert.equal(nextContext.commandOwner, owner); assert.equal(next.snapshot().retention.choices.derived.choice, 'unset');
      assert.equal(next.recoverCommand(id).metadata.effect, 'confirmed');
      const replacementRoutes = f.routes(), replacementControllerCount = f.controllers.length;
      oldClose(); f.render();
      assert.equal(f.routes(), replacementRoutes); assert.equal(next.snapshot().active, true);
      assert.equal(nextContext.createManualProgress(), next); assert.equal(f.controllers.length, replacementControllerCount); assert.equal(f.posts().length, 1);
    } finally { late.resolve(new Response('{}')); await flight; f.dispose(); }
  });

test('manual session forwards detached attempt authority only through its captured original host transport', async () => {
  let dependencies, current = true;
  const calls = [], contract = load('body/manualRetentionContract.ts');
  const sessionLoad = loader({ 'body/manualProgressController.ts': {
    createManualProgressController(deps) { dependencies = deps; return { snapshot: () => ({ active: true }), dispose() {} }; },
  } });
  const { createManualProgressSession } = sessionLoad('integration/manualProgressSession.ts');
  const api = { captureAuthContext: () => ({ isCurrent: () => current }), async request(...args) { calls.push(args); return {}; } };
  const resources = { api }, session = createManualProgressSession({ account: { accountId: 'synthetic-account' }, resources,
    sessionGeneration: 'original-host', isCurrentSession: () => current });
  session.create();
  const authority = { protocol: contract.MANUAL_RETENTION_PROTOCOL, decisionId: '11111111-1111-4111-8111-111111111111',
    revision: 1, statementSha256: contract.MANUAL_RETENTION_STATEMENT_SHA256 };
  const context = { manualRetention: authority, assertCurrent() {} };
  await dependencies.transport.request('/v1/body/measurements', 'POST', input, 'original-key', context);
  authority.decisionId = '22222222-2222-4222-8222-222222222222';
  assert.equal(calls[0][4].manualRetention.decisionId, '11111111-1111-4111-8111-111111111111');
  assert.ok(Object.isFrozen(calls[0][4].manualRetention));
  resources.api = { ...api, request() { assert.fail('Replacement API must not receive the original attempt'); } };
  await assert.rejects(dependencies.transport.request('/v1/body/manual-retention', 'POST', {}, 'grant-key'), { code: 'session_changed' });
  resources.api = api;
  await assert.rejects(dependencies.transport.request('/v1/body/measurements', 'POST', input, 'original-key', context), { code: 'session_changed' });
  assert.equal(calls.length, 1); current = false; session.dispose();
});


test('removing custom Body renderer synchronously closes stale factory and close while preserving issued custody', async () => {
  const f = fixture(), late = deferred(), entered = deferred(); let flight;
  try {
    let closes = 0; f.ctx.close = () => { closes++; }; f.reopen();
    const old = f.body, c = old.createManualProgress();
    f.postWork = call => { entered.resolve(call); return late.promise; };
    flight = c.create(command('renderer-removal'), await consent(c));
    const call = await entered.promise, id = f.custody.snapshot(f.access)[0].id;
    delete f.props.renderBody;
    // The old boundary never renders or runs passive cleanup in this interval.
    f.renderRuntime(); assert.equal(f.renderBody().type, 'DefaultBody');
    assert.equal(c.snapshot().active, false); assert.equal(old.createManualProgress(), null);
    old.close(); assert.equal(closes, 0);
    assert.equal(f.custody.snapshot(f.access)[0].locallyPending, 1);
    late.resolve(confirmed(call)); assert.equal(await flight, null);
    assert.equal(f.custody.snapshot(f.access)[0].effect, 'confirmed');
    f.props.renderBody = ctx => { f.body = ctx; return 'manual-body'; };
    f.renderRuntime(); const next = f.reopen().createManualProgress();
    assert.deepEqual(next.recoverCommand(id).intent.command, command('renderer-removal'));
    assert.equal(old.createManualProgress(), null); old.close(); assert.equal(closes, 0);
  } finally { late.resolve({}); await flight; f.dispose(); }
});
