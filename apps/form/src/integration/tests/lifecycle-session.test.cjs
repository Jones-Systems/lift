const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..'), modules = new Map();
function load(file) {
  file = path.resolve(root, file); assert.ok(file.startsWith(root + path.sep));
  if (file === path.join(root, 'native/runtime.ts')) return {
    FormNativeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    bindFormNativeModule: () => ({ module: null, reason: 'platform_unsupported' }),
  };
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
    return load(path.resolve(path.dirname(file), name + '.ts'));
  }, module, module.exports);
  return module.exports;
}
const { createLifecycleSession, createLifecycleRecovery } = load('integration/lifecycleSession.ts');
const { createAccountLifecycleController } = load('account-lifecycle/controller.ts');
const { FormTransport } = load('api/transport.ts');
const { createSharedVoice } = load('integration/sharedVoice.ts');
const origin = 'https://form.example.invalid';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers });
const receipt = { accountId: 'account-a', baseURL: origin, requestId: 'dbd28a74-8d68-4f1e-8ac2-2c4cb1fc23bc',
  statusSecret: 's'.repeat(64), commandKey: 'synthetic-command' };
const disabled = { requestId: receipt.requestId, phase: 'disabled_pending_purge', initiated: true, disabled: true,
  localPurged: false, complete: false, requestedAt: '2026-10-11T00:00:00Z', backupExpiryAt: null,
  billingCancellation: 'not_performed', reauthentication: 'password_only_qualified_source',
  steps: ['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community']
    .map(category => ({ category, status: 'pending', retain_until_ms: null })) };
const settings = { accountId: 'account-a', stagedAccountLifecycle: { status: 'configured_unverified', initiation: true,
  passwordActionReauthentication: true, phoneActionReauthentication: false, oauthActionReauthentication: false,
  wholeAccountDeletionComplete: false, exportMaxBytes: 16777216, billingCancellation: 'not_performed' } };
function selection(current = () => true) { return { accountId: 'account-a', baseURL: origin, sessionKey: 'recovery-1', isCurrent: current }; }
async function fixture(t, overrides = {}) {
  let token = 0, epoch = 1, account = 'account-a';
  const calls = [], effects = [], custodyCalls = [];
  const storage = { value: null, async load() { return this.value; }, async save(value) { this.value = value; }, async clear() { effects.push('clear'); this.value = null; } };
  const api = new FormTransport(origin, storage, async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/sign-in/email') ? json({}, { 'set-auth-token': `synthetic-${++token}` }) : json(settings);
  });
  await api.signIn('a@example.invalid', 'synthetic-password'); calls.length = 0;
  const shell = { accountId: 'account-a', sessionKey: 'shell:1',
    voiceScope: { account: { accountId: 'account-a', accountEpoch: 1, authSessionId: 'shell:1' }, isCurrent: () => epoch === 1 },
    isCurrent: () => epoch === 1 && account === 'account-a',
    claimAccessDisabled() {
      if (epoch !== 1 || account !== 'account-a') throw new Error('foreign shell');
      effects.push('claim'); epoch++; account = null;
      return { isCurrent: () => epoch === 2 && account === null, async disposeSpeech() { effects.push('speech'); } };
    },
  };
  const host = createLifecycleSession({ api, shell,
    receiptCustody: async (id, baseURL) => { custodyCalls.push([id, baseURL]); return { receipts: { load: async () => null, save: async () => assert.fail('save unavailable') } }; },
    captureResources: () => async () => { effects.push('resources'); },
    stopAudio: async () => { effects.push('audio'); return { status: 'released', failedSteps: [] }; },
    ...overrides,
  });
  t.after(() => host.dispose());
  return { api, storage, host, calls, effects, custodyCalls, switchShell: () => { epoch++; account = 'account-b'; } };
}

test('host actions remain hard false, export absent, and custody stays lazy', async t => {
  const s = await fixture(t);
  assert.equal(s.host.context.actionsQualified, false); assert.equal(s.host.context.deliverExport, undefined);
  assert.equal(s.host.context.createReceipt, undefined); assert.deepEqual(s.calls, []); assert.deepEqual(s.custodyCalls, []);
  const controller = createAccountLifecycleController(s.host.context); t.after(() => controller.dispose());
  await controller.initialize();
  assert.equal(controller.snapshot().available, false);
  await controller.requestDeletion(); await controller.confirmDeletion('synthetic-password', 'DELETE'); await controller.exportAccount('synthetic-password');
  assert.equal(s.calls.length, 1); assert.ok(s.calls[0].url.endsWith('/v1/me/settings'));
  assert.deepEqual(s.effects, []); assert.deepEqual(s.custodyCalls, [['account-a', origin]]);
});

test('disabled callback claims synchronously, memoizes teardown, and survives its own auth invalidation', async t => {
  const s = await fixture(t), original = s.api.captureAuthContext();
  const one = s.host.context.onAccessDisabled(), two = s.host.context.onAccessDisabled();
  assert.equal(one, two); assert.equal(s.effects[0], 'claim');
  assert.equal(s.host.cleanupSnapshot().status, 'pending');
  await one;
  assert.deepEqual(s.host.cleanupSnapshot(), { status: 'complete', failedSteps: [] });
  assert.equal(original.isCurrent(), false); assert.equal(s.host.context.isCurrent(), false);
  assert.equal(s.storage.value, null); assert.deepEqual(s.calls, []);
  assert.deepEqual([...s.effects].sort(), ['audio', 'claim', 'clear', 'resources', 'speech']);
  await s.api.signIn('b@example.invalid', 'synthetic-password'); s.switchShell();
  const before = [...s.effects]; await s.host.context.onAccessDisabled();
  assert.deepEqual(s.effects, before); assert.equal(JSON.parse(s.storage.value).token, 'synthetic-2');
});

test('foreign switch before disabled callback cannot clear token, caches, resources, or audio', async t => {
  const s = await fixture(t);
  await s.api.signIn('b@example.invalid', 'synthetic-password'); s.switchShell();
  await assert.rejects(s.host.context.onAccessDisabled(), { code: 'session_changed' });
  assert.deepEqual(s.effects, []); assert.equal(JSON.parse(s.storage.value).token, 'synthetic-2');
});

test('aggregate cleanup failure is retained for recovery after old auth and view expire', async t => {
  const s = await fixture(t, { captureResources: () => async () => { throw new Error('resource failure'); },
    stopAudio: async () => ({ status: 'incomplete', failedSteps: ['deactivate'] }),
    receiptCustody: async () => ({ receipts: { load: async () => receipt, save: async () => assert.fail('save unavailable') } }),
    fetcher: async () => json(disabled),
  });
  const clearing = s.host.context.onAccessDisabled(); s.host.dispose();
  await assert.rejects(clearing, { code: 'device_cleanup_incomplete' });
  assert.equal(s.host.context.isCurrent(), false); assert.equal(s.storage.value, null);
  assert.equal(s.host.cleanupSnapshot().status, 'incomplete');
  assert.deepEqual([...s.host.cleanupSnapshot().failedSteps].sort(), ['audio', 'resources']);
  const recovery = s.host.recovery(selection()); assert.ok(recovery); t.after(() => recovery.dispose());
  const controller = createAccountLifecycleController(recovery.context); t.after(() => controller.dispose());
  await controller.initialize(); await controller.checkStatus();
  assert.equal(controller.snapshot().phase, 'disabled');
  assert.match(controller.snapshot().message, /Device cleanup could not be confirmed/);
  assert.equal(recovery.cleanupSnapshot().status, 'incomplete');
});

test('foreign auth during pending cleanup is not erased or retried after late audio completion', async t => {
  const audio = deferred(), entered = deferred(), clearGate = deferred();
  const s = await fixture(t, { stopAudio: async () => { entered.resolve(); await audio.promise; return { status: 'released', failedSteps: [] }; } });
  s.storage.clear = async function () { await clearGate.promise; this.value = null; };
  const cleanup = s.host.context.onAccessDisabled(); const rejected = assert.rejects(cleanup, { code: 'device_cleanup_incomplete' });
  await entered.promise; await turn();
  const replacing = s.api.signIn('b@example.invalid', 'synthetic-password'); s.switchShell();
  clearGate.resolve(); await replacing; audio.resolve(); await rejected;
  assert.equal(JSON.parse(s.storage.value).token, 'synthetic-2');
  const count = s.calls.length;
  await assert.rejects(s.host.context.onAccessDisabled(), { code: 'device_cleanup_incomplete' });
  assert.equal(s.calls.length, count); assert.equal(JSON.parse(s.storage.value).token, 'synthetic-2');
});

test('recovery requires explicit selection and has no authenticated no-receipt fallback', async t => {
  assert.equal(createLifecycleRecovery({ selection: null }), null);
  let calls = 0;
  const recovery = createLifecycleRecovery({ selection: selection(), fetcher: async () => { calls++; throw new Error('unexpected'); },
    receiptCustody: async () => ({ receipts: { load: async () => null, save: async () => assert.fail('save unavailable') } }) });
  t.after(() => recovery.dispose());
  const controller = createAccountLifecycleController(recovery.context); t.after(() => controller.dispose());
  await controller.initialize();
  assert.equal(controller.snapshot().phase, 'error'); assert.equal(calls, 0);
  for (const name of ['settings', 'grant', 'export', 'initiate', 'confirm']) await assert.rejects(recovery.context.api[name](), { code: 'lifecycle_action_unavailable' });
  assert.equal(recovery.context.actionsQualified, false); assert.equal(recovery.context.createReceipt, undefined);
  assert.equal(recovery.context.deliverExport, undefined); assert.equal(recovery.context.onAccessDisabled, undefined);
});

test('recovery status uses only receipt authorization and expires permanently with its view', async t => {
  let current = true; const calls = [];
  const recovery = createLifecycleRecovery({ selection: selection(() => current),
    receiptCustody: async () => ({ receipts: { load: async () => receipt, save: async () => assert.fail('save unavailable') } }),
    fetcher: async (url, init) => { calls.push({ url, init }); return json(disabled); } });
  t.after(() => recovery.dispose());
  const controller = createAccountLifecycleController(recovery.context); t.after(() => controller.dispose());
  await controller.initialize(); await controller.checkStatus();
  assert.equal(controller.snapshot().phase, 'disabled'); assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, `DeletionReceipt ${receipt.statusSecret}`);
  assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error');
  current = false; await assert.rejects(recovery.context.api.status(receipt), { code: 'session_changed' });
  current = true; await assert.rejects(recovery.context.api.status(receipt), { code: 'session_changed' });
  assert.equal(calls.length, 1);
});

test('late recovery status and custody results are withheld after disposal', async () => {
  const response = deferred(); let calls = 0;
  const recovery = createLifecycleRecovery({ selection: selection(), fetcher: async () => { calls++; return response.promise; } });
  const reading = recovery.context.api.status(receipt); const rejected = assert.rejects(reading, { code: 'session_changed' });
  recovery.dispose(); response.resolve(json(disabled)); await rejected;
  assert.equal(calls, 1);
  const custody = deferred(); let loads = 0;
  const next = createLifecycleRecovery({ selection: selection(), receiptCustody: () => custody.promise });
  const loading = next.context.receipts.load(); const missing = assert.rejects(loading, { code: 'session_changed' });
  next.dispose(); custody.resolve({ receipts: { load: async () => { loads++; return receipt; } } });
  await missing; assert.equal(loads, 0);
});

test('authenticated context rejects late settings and never dispatches under the replacement bearer', async t => {
  const s = await fixture(t), late = deferred();
  const original = s.api.request.bind(s.api); s.api.request = () => late.promise;
  const reading = s.host.context.api.settings(); const rejected = assert.rejects(reading, { code: 'session_changed' });
  s.switchShell(); late.resolve(settings); await rejected;
  s.api.request = original;
  await assert.rejects(s.host.context.api.settings(), { code: 'session_changed' }); assert.deepEqual(s.calls, []);
});

test('captured audio teardown never cancels a replacement account scope', async t => {
  const calls = [], handlers = new Map(); let accountA = true;
  const native = { availability: async locale => ({ available: true, reason: 'available', locale }),
    start: async (locale, id) => { for (const h of handlers.get('onState') ?? []) h({ sessionId: id, state: 'recording' }); return { sessionId: id }; },
    cancel: async id => { calls.push(id); }, stop: async () => {},
    addListener(name, handler) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(handler);
      return { remove: () => handlers.get(name).delete(handler) }; } };
  const voice = createSharedVoice({ speech: { module: native } }); t.after(async () => voice.dispose());
  const firstScope = { account: { accountId: 'a', authSessionId: 'shell:1', accountEpoch: 1 }, isCurrent: () => accountA };
  const first = voice.speech(firstScope), firstId = await first.start('en-US');
  await voice.stopScope(firstScope); accountA = false;
  const next = voice.speech({ account: { accountId: 'b', authSessionId: 'shell:2', accountEpoch: 2 }, isCurrent: () => true });
  const nextId = await next.start('en-US');
  const count = calls.length; await voice.stopScope(firstScope);
  assert.equal(calls.length, count); assert.deepEqual(calls, [firstId]); assert.equal(next.getDraft().sessionId, nextId);
});

test('recovery rejects a different receipt account or endpoint before status dispatch', async () => {
  let calls = 0;
  const recovery = createLifecycleRecovery({ selection: selection(), fetcher: async () => { calls++; return json(disabled); } });
  await assert.rejects(recovery.context.api.status({ ...receipt, accountId: 'account-b' }), { code: 'session_changed' });
  await assert.rejects(recovery.context.api.status({ ...receipt, baseURL: 'https://other.example.invalid' }), { code: 'session_changed' });
  assert.equal(calls, 0); recovery.dispose();
});
