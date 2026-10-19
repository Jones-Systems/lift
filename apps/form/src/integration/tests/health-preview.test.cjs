const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
function compile(file, dependencies = {}) {
  const m = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected runtime import: ${name}`);
    return dependencies[name];
  }, m, m.exports);
  return m.exports;
}
const { ApiError } = compile('api/transport.ts');
const { FormResources } = compile('api/resources.ts', { './client': { ApiError, formApi: null },
  './firstPlan': compile('api/firstPlan.ts', { './transport': { ApiError },
    './trainingCodec': compile('api/trainingCodec.ts', { './transport': { ApiError } }) }),
});
let createHealthPlanPreview;
before(async () => {
  const portable = await import(pathToFileURL(path.join(root, 'integration/healthPreview/portable-adapter.mjs')));
  ({ createHealthPlanPreview } = compile('integration/healthPreview.ts', {
    '../api/transport': { ApiError }, './healthPreview/portable-adapter.mjs': portable,
  }));
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const plan = id => ({ revision: 3, id, name: 'Saved template', minutes: 20,
  items: [{ id: 'item-1', exerciseId: 'press', setTarget: 3, repMin: 8, repMax: 12, targetKg: 15 }],
  archived: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' });
function fixture() {
  let authGeneration = 1, mounted = true;
  const wait = deferred(), calls = [], rendered = [];
  const api = {
    captureAuthContext() { const original = authGeneration; return { isCurrent: () => original === authGeneration }; },
    async request(...args) { calls.push({ args, authGeneration }); return wait.promise; },
  };
  const resources = new FormResources(api);
  const create = generation => createHealthPlanPreview({ resources, sessionGeneration: generation,
    isCurrentSession: () => mounted }, value => rendered.push(value));
  return { wait, calls, rendered, resources, preview: create('account-session-1'), create,
    switchAuth: () => authGeneration++, leave: () => { mounted = false; } };
}
test('preview reads the selected saved template through canonical plans and exposes no write capability', async () => {
  const f = fixture(), own = plan('own'), other = plan('other');
  const pending = f.preview.reviewPlan('own'); f.wait.resolve({ items: [other, own] });
  const result = await pending;
  assert.deepEqual(result, { status: 'ok', value: own });
  assert.deepEqual(f.calls, [{ args: ['/v1/plans', 'GET', undefined, undefined], authGeneration: 1 }]);
  assert.equal(f.preview.capability, 'read_only');
  assert.deepEqual(await f.preview.dispatch({ kind: 'apply' }), { status: 'rejected', code: 'read_only' });
  assert.equal(f.calls.length, 1);
  result.value.items[0].targetKg = 999;
  assert.equal(own.items[0].targetKg, 15);
});
test('old preview cannot obtain replacement-login resources even when the screen predicate has not caught up', async () => {
  const f = fixture(); f.switchAuth();
  assert.deepEqual(await f.preview.reviewPlan('own'), { status: 'rejected', code: 'stale_session' });
  assert.equal(f.calls.length, 0); assert.deepEqual(f.rendered, []);
});
test('delayed old-account read cannot paint the new session', async () => {
  const f = fixture(), pending = f.preview.reviewPlan('own');
  f.switchAuth(); f.wait.resolve({ items: [plan('own')] });
  assert.deepEqual(await pending, { status: 'rejected', code: 'stale_session' });
  assert.deepEqual(f.rendered, []); assert.equal(f.calls.length, 1);
});
test('screen disposal invalidates pending reads and retained callbacks synchronously', async () => {
  const f = fixture(), pending = f.preview.reviewPlan('own'); f.preview.dispose();
  f.wait.resolve({ items: [plan('own')] });
  assert.deepEqual(await pending, { status: 'rejected', code: 'stale_session' });
  assert.deepEqual(await f.preview.reviewPlan('own'), { status: 'rejected', code: 'stale_session' });
  assert.deepEqual(f.rendered, []); assert.equal(f.calls.length, 1);
});
test('leaving the screen suppresses pending results without disposing a replacement controller', async () => {
  const f = fixture(), pending = f.preview.reviewPlan('own'); f.leave(); f.wait.resolve({ items: [plan('own')] });
  assert.equal((await pending).code, 'stale_session'); assert.deepEqual(f.rendered, []);
});
test('missing or duplicate plan identity never selects a substitute', async () => {
  for (const items of [[plan('different')], [plan('own'), plan('own')]]) {
    const f = fixture(), pending = f.preview.reviewPlan('own'); f.wait.resolve({ items });
    assert.equal((await pending).status, 'rejected'); assert.equal(f.calls.length, 1);
  }
});
test('portable closed validation rejects body-derived or extra plan fields before rendering a plan', async () => {
  const f = fixture(), pending = f.preview.reviewPlan('own');
  f.wait.resolve({ items: [{ ...plan('own'), bodyMeasurement: 42 }] });
  assert.deepEqual(await pending, { status: 'rejected', code: 'no_save_forbidden' });
  assert.equal(f.rendered[0].value, undefined);
});
test('failed reads expose a fixed unavailable code without echoing sensitive error text', async () => {
  const f = fixture(), pending = f.preview.reviewPlan('own'); f.wait.reject(new Error('synthetic private diagnostic'));
  assert.deepEqual(await pending, { status: 'rejected', code: 'plan_unavailable' }); assert.deepEqual(f.rendered, []);
});
test('new login requires deliberate fresh binding; old controller remains stale', async () => {
  const f = fixture(); f.switchAuth(); const fresh = f.create('account-session-2');
  const pending = fresh.reviewPlan('own'); f.wait.resolve({ items: [plan('own')] });
  assert.equal((await pending).status, 'ok'); assert.equal(f.calls[0].authGeneration, 2);
  assert.equal((await f.preview.reviewPlan('own')).code, 'stale_session'); assert.equal(f.calls.length, 1);
});
test('invalid identifiers are rejected before an account request', async () => {
  const f = fixture();
  assert.equal((await f.preview.reviewPlan('')).code, 'invalid_input');
  assert.equal((await f.preview.reviewPlan('x'.repeat(2049))).code, 'invalid_input');
  assert.equal(f.calls.length, 0);
});
