const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const { ApiError } = (() => {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../transport.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('module', 'exports', code)(module, module.exports);
  return module.exports;
})();
const moduleUnderTest = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../resources.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', code)(name => {
  if (name === './firstPlan') {
    const decoded = { exports: {} };
    const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../firstPlan.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function('require', 'module', 'exports', compiled)(dependency => {
      if (dependency === './trainingCodec') {
        const codec = { exports: {} };
        const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../trainingCodec.ts'), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        new Function('require', 'module', 'exports', source)(name => {
          assert.equal(name, './transport'); return { ApiError };
        }, codec, codec.exports);
        return codec.exports;
      }
      assert.equal(dependency, './transport'); return { ApiError };
    }, decoded, decoded.exports);
    return decoded.exports;
  }
  assert.equal(name, './client'); return { ApiError, formApi: null };
}, moduleUnderTest, moduleUnderTest.exports);
const { FormResources } = moduleUnderTest.exports;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  let generation = 1, mounted = true;
  const calls = [], next = deferred();
  const api = {
    captureAuthContext() { const initial = generation; return { isCurrent: () => generation === initial }; },
    async request(path, method = 'GET', body, key) { calls.push({ path, method, body, key, generation }); return next.promise; },
  };
  const base = new FormResources(api);
  const resources = base.boundTo ? base.boundTo(() => mounted) : base;
  return { resources, calls, next, switchAccount: () => generation++, unmount: () => { mounted = false; }, api };
}
const stale = error => error instanceof ApiError && error.code === 'session_changed';

test('onboarding continuation cannot read or create a plan under a replacement account', async () => {
  const f = fixture();
  const completion = f.resources.completeOnboarding({ revision: 2 }, 'original-intent');
  f.next.resolve({ status: 'completed' }); await completion;
  f.switchAccount();
  await assert.rejects(f.resources.account(), stale);
  await assert.rejects(f.resources.createPlan({ name: 'Original plan', minutes: 20, items: [] }, 'original-plan-intent'), stale);
  assert.equal(f.calls.length, 1);
});

test('delayed write acknowledgement preserves uncertain original effect and hides the result', async () => {
  const f = fixture(); const pending = f.resources.completeOnboarding({ revision: 2 }, 'original-intent');
  f.switchAccount(); f.next.resolve({ status: 'completed' });
  await assert.rejects(pending, error => stale(error) && error.originalEffectUnknown && !error.effectUnknown);
  assert.equal(f.calls.length, 1);
});

test('mounted lifetime rejects read results and later chained requests after disposal', async () => {
  const f = fixture(); const pending = f.resources.account();
  f.unmount(); f.next.resolve({ accountId: 'original' });
  await assert.rejects(pending, error => stale(error) && !error.originalEffectUnknown);
  await assert.rejects(f.resources.exercises(), stale);
  assert.equal(f.calls.length, 1);
});

test('unknown write remains unknown but same-key retry cannot cross the bound session', async () => {
  const f = fixture(); const fields = { name: 'Own plan', minutes: 20, items: [] };
  const pending = f.resources.createPlan(fields, 'retained-key');
  f.next.reject(new ApiError(0, 'network_error', 'Unknown outcome', true));
  await assert.rejects(pending, error => error.effectUnknown);
  f.switchAccount();
  await assert.rejects(f.resources.createPlan(fields, 'retained-key'), stale);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].key, 'retained-key');
});

test('an old error cannot masquerade as a new-account authentication failure', async () => {
  const f = fixture(); const pending = f.resources.account();
  f.switchAccount(); f.next.reject(new ApiError(401, 'unauthorized', 'Old session'));
  await assert.rejects(pending, error => stale(error) && error.status === 409);
});

test('fresh bound session sends its exact payload and returns its own result', async () => {
  const f = fixture(); f.switchAccount();
  const base = new FormResources(f.api);
  const fresh = base.boundTo ? base.boundTo(() => true) : base;
  const fields = { name: 'New account plan', minutes: 15, items: [] };
  const pending = fresh.createPlan(fields, 'new-account-key');
  const result = { id: 'own-plan', revision: 1 }; f.next.resolve(result);
  assert.equal(await pending, result);
  assert.deepEqual(f.calls, [{ path: '/v1/plans', method: 'POST', body: fields, key: 'new-account-key', generation: 2 }]);
});
