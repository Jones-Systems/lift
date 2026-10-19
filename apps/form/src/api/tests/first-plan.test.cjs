const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
function load(file, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../' + file + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(imports, name), 'Unexpected runtime dependency: ' + name); return imports[name];
  }, module, module.exports);
  return module.exports;
}
const transport = load('transport'), { ApiError, FormTransport } = transport;
const decoder = load('firstPlan', { './transport': transport, './trainingCodec': load('trainingCodec', { './transport': transport }) });
const { FormResources } = load('resources', { './client': { ApiError, formApi: null }, './firstPlan': decoder });
const confirmation = () => ({ profileRevision: 4, preferencesRevision: 7 });
function receipt() {
  return { plan: { id: 'plan_saved', name: 'Saved plan', minutes: 30, revision: 0, archived: false,
    createdAt: '2026-10-11T12:00:00.000Z', updatedAt: '2026-10-11T12:00:00.000Z',
    items: [{ id: 'item_1', exerciseId: 'exercise_1', setTarget: 3, repMin: 6, repMax: 10, targetKg: 12.5 }] },
    provenance: { schema: 'form.first-plan-provenance/v1', contextKey: 'context:v1', selectedCandidateId: 'candidate_1',
      ...confirmation(), sources: [{ id: 'qualified-source', revision: 'rev:123' }],
      candidates: [{ id: 'candidate_1', status: 'eligible', gapCodes: [] }, { id: 'candidate_2', status: 'unknown', gapCodes: ['source-unavailable'] }] } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const next = deferred(), calls = []; let generation = 1, mounted = true;
  const api = { captureAuthContext() { const initial = generation; return { isCurrent: () => generation === initial }; },
    request(path, method, body, key) { calls.push({ path, method, body, key }); return next.promise; } };
  return { resources: new FormResources(api).boundTo(() => mounted), calls, next,
    switchAccount: () => generation++, unmount: () => { mounted = false; } };
}
const unknown = error => error instanceof ApiError && error.code === 'first_plan_response_invalid' && error.effectUnknown;

test('first-plan uses exact confirmation and caller key and returns the complete saved receipt without fallback', async () => {
  const f = fixture(), expected = receipt();
  const pending = f.resources.createFirstPlan(confirmation(), 'original-first-plan-key');
  assert.deepEqual(f.calls, [{ path: '/v1/plans/first', method: 'POST', body: confirmation(), key: 'original-first-plan-key' }]);
  assert.equal(Object.isFrozen(f.calls[0].body), true);
  f.next.resolve(expected); const result = await pending;
  assert.deepEqual(result, expected); assert.notEqual(result, expected); assert.notEqual(result.plan.items, expected.plan.items);
  assert.deepEqual(await f.resources.createFirstPlan(confirmation(), 'original-first-plan-key'), expected);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.path === '/v1/plans/first' && call.key === 'original-first-plan-key'));
});
test('invalid confirmation rejects before transport rather than creating a different plan', async () => {
  for (const input of [null, {}, { ...confirmation(), profileRevision: -1 }, { ...confirmation(), preferencesRevision: 1.5 },
    { ...confirmation(), profileRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...confirmation(), accountId: 'foreign' }]) {
    const f = fixture(); await assert.rejects(f.resources.createFirstPlan(input, 'key'), error => error instanceof ApiError && error.code === 'invalid_request' && !error.effectUnknown);
    assert.equal(f.calls.length, 0);
  }
});
test('malformed success across complete plan and provenance becomes unknown with no follow-up request', async () => {
  const mutations = [
    value => { delete value.plan; }, value => { value.rawTrace = {}; }, value => { value.plan.id = '../other'; },
    value => { value.plan.name = ' '; }, value => { value.plan.minutes = 181; }, value => { value.plan.revision = 0.5; },
    value => { value.plan.archived = 'false'; }, value => { value.plan.createdAt = '2026-02-30T00:00:00Z'; },
    value => { value.plan.updatedAt = '2026-10-11T12:00:00+01:00'; }, value => { value.plan.items = []; },
    value => { value.plan.items.push({ ...value.plan.items[0] }); }, value => { value.plan.items[0].repMax = 2; },
    value => { value.plan.items[0].targetKg = Infinity; }, value => { value.plan.items[0].setTarget = 21; },
    value => { value.plan.items[0].exerciseId = ''; }, value => { value.plan.items[0].rawContext = 'private'; },
    value => { value.provenance.schema = 'form.first-plan-provenance/v2'; }, value => { value.provenance.contextKey = 'raw prose'; },
    value => { value.provenance.selectedCandidateId = 'x'.repeat(81); }, value => { value.provenance.sources[0].revision = ''; },
    value => { value.provenance.sources = Array(257).fill(value.provenance.sources[0]); },
    value => { value.provenance.candidates[0].status = 'approved'; }, value => { value.provenance.candidates[0].gapCodes = ['raw prose']; },
    value => { value.provenance.candidates[0].gapCodes = Array(65).fill('gap'); },
    value => { value.provenance.healthContext = 'private'; },
    value => { value.provenance.candidates = Array.from({ length: 64 }, (_, i) => ({ id: 'c' + i, status: 'unknown', gapCodes: Array(64).fill('x'.repeat(128)) })); },
  ];
  for (const mutate of mutations) {
    const f = fixture(), value = receipt(); mutate(value);
    const pending = f.resources.createFirstPlan(confirmation(), 'same-original-key'); f.next.resolve(value);
    await assert.rejects(pending, unknown); assert.equal(f.calls.length, 1);
  }
});
test('response revisions must match frozen dispatched confirmation despite caller mutation', async () => {
  for (const mismatch of [null, 'profileRevision', 'preferencesRevision']) {
    const f = fixture(), original = confirmation(), value = receipt();
    const pending = f.resources.createFirstPlan(original, 'frozen-context'); original.profileRevision = 8; original.preferencesRevision = 9;
    if (mismatch) value.provenance[mismatch] = original[mismatch];
    f.next.resolve(value);
    if (mismatch === null) assert.deepEqual(await pending, receipt()); else await assert.rejects(pending, unknown);
    assert.deepEqual(f.calls[0].body, confirmation());
  }
});
test('original mounted scope and auth context fence both late success and old-account errors', async () => {
  for (const invalidation of ['switchAccount', 'unmount']) for (const outcome of ['success', 'error']) {
    const f = fixture(), pending = f.resources.createFirstPlan(confirmation(), 'original-scope'); f[invalidation]();
    if (outcome === 'success') f.next.resolve(receipt()); else f.next.reject(new ApiError(401, 'unauthenticated', 'Old account'));
    await assert.rejects(pending, error => error instanceof ApiError && error.code === 'session_changed' && error.originalEffectUnknown);
    await assert.rejects(f.resources.createFirstPlan(confirmation(), 'original-scope'), error => error.code === 'session_changed');
    assert.equal(f.calls.length, 1);
  }
});
test('known unavailable and unknown transport outcomes pass through without normalization or automatic replay', async () => {
  for (const original of [new ApiError(501, 'first_plan_unavailable', 'Unconfigured'), new ApiError(0, 'network_error', 'Unknown', true)]) {
    const f = fixture(), pending = f.resources.createFirstPlan(confirmation(), 'retained-key'); f.next.reject(original);
    await assert.rejects(pending, error => error === original); assert.equal(f.calls.length, 1);
  }
});
test('real transport auth replacement cannot disclose a delayed first-plan acknowledgement', async () => {
  const next = deferred(); let serial = 0;
  const api = new FormTransport('https://form.example.invalid', { async load() { return null; }, async save() {}, async clear() {} }, async (url) => {
    if (url.endsWith('/sign-in/email')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic-' + (++serial) } });
    assert.ok(url.endsWith('/v1/plans/first')); return next.promise;
  });
  await api.signIn('one@synthetic.invalid', 'synthetic-password');
  const resources = new FormResources(api).boundTo(() => true);
  const pending = resources.createFirstPlan(confirmation(), 'original-key');
  await api.signIn('two@synthetic.invalid', 'synthetic-password');
  next.resolve(new Response(JSON.stringify(receipt())));
  await assert.rejects(pending, error => error instanceof ApiError && error.code === 'session_changed' && error.originalEffectUnknown);
});


function sourceReceipt() {
  const result = receipt();
  const item = (id, nativeId, repetitions) => ({ id,
    native: { exercise_id: nativeId, movement_pattern: 'synthetic movement', role: 'practice', sets: repetitions ? 3 : 1,
      rest_seconds: 45, ...(repetitions ? { rep_range: [6, 10], target_rir: 2, substituted_for: 'prior_native', notes: ['Retained source note', ''] } : {}) },
    registeredDomain: { exerciseId: 'domain_' + id, variantId: 'variant:' + id,
      identity: { repository: 'Synthetic/Source', revision: 'rev:source', path: 'retained/native.json', sha256: 'a'.repeat(64), nativeId },
      registration: { id: 'synthetic-registration', revision: 'r1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
    load: { kind: 'unspecified', basis: 'unknown' } });
  const { minutes, ...metadata } = result.plan;
  result.plan = { ...metadata, schema: 'form.source-prescription-plan/v1', origin: { kind: 'form-adaptation', id: 'synthetic-plan', revision: 'r1' },
    duration: { kind: 'estimated-range', minMinutes: 20, maxMinutes: 35 },
    items: [item('source_rep', 'native_rep', true), item('source_practice', 'native_practice', false)] };
  return result;
}

test('stored receipt decoder preserves full source fields and legacy compatibility with detached data', () => {
  for (const value of [receipt(), sourceReceipt()]) {
    const decoded = decoder.decodeStoredFirstPlanReceipt(value, confirmation());
    assert.deepEqual(decoded, value); assert.notEqual(decoded.plan, value.plan);
    if ('schema' in decoded.plan) {
      assert.equal('minutes' in decoded.plan, false); assert.equal('rep_range' in decoded.plan.items[1].native, false);
      value.plan.items[0].native.notes.push('caller mutation');
      assert.deepEqual(decoded.plan.items[0].native.notes, ['Retained source note', '']);
      assert.throws(() => decoder.decodeFirstPlanReceipt(sourceReceipt(), confirmation()), unknown);
    } else assert.deepEqual(decoded, decoder.decodeFirstPlanReceipt(value, confirmation()));
  }
});

test('stored first-plan command captures original confirmation and same endpoint without a create fallback', async () => {
  const f = fixture(), input = confirmation(), pending = f.resources.createStoredFirstPlan(input, 'source-original');
  input.profileRevision = 90; input.preferencesRevision = 91; f.next.resolve(sourceReceipt());
  assert.deepEqual(await pending, sourceReceipt());
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/v1/plans/first');
  assert.equal(f.calls[0].method, 'POST'); assert.equal(f.calls[0].key, 'source-original'); assert.deepEqual(f.calls[0].body, confirmation());
});

test('malformed stored acknowledgements are unknown including native association optional fields and provenance', async () => {
  const cases = [value => { value.plan.minutes = 30; }, value => { value.plan.items[0].native.exercise_id = 'foreign'; },
    value => { value.plan.items[1].native.rep_range = undefined; }, value => { value.plan.items[0].native.rep_range = [10, 6]; },
    value => { value.plan.duration.maxMinutes = 19; }, value => { value.plan.items[0].load = { kind: 'external', kg: 0 }; },
    value => { value.plan.items[0].registeredDomain.registration.digest = 'invalid'; },
    value => { value.plan.items.push(value.plan.items[0]); }, value => { value.plan.items[0].native.notes = []; },
    value => { value.provenance.preferencesRevision++; }, value => { value.provenance.extra = 'untrusted'; },
    value => { value.provenance.candidates = Array.from({ length: 64 }, (_, i) => ({ id: 'c' + i, status: 'unknown', gapCodes: Array(64).fill('x'.repeat(128)) })); }];
  for (const change of cases) {
    const f = fixture(), value = sourceReceipt(); change(value);
    const pending = f.resources.createStoredFirstPlan(confirmation(), 'same-key'); f.next.resolve(value);
    await assert.rejects(pending, unknown); assert.equal(f.calls.length, 1);
  }
});

test('stored first-plan delayed success and error stay with the original bound session', async () => {
  for (const invalidate of ['switchAccount', 'unmount']) for (const success of [true, false]) {
    const f = fixture(), pending = f.resources.createStoredFirstPlan(confirmation(), 'original-source-key'); f[invalidate]();
    if (success) f.next.resolve(sourceReceipt()); else f.next.reject(new ApiError(401, 'unauthenticated', 'Original session'));
    await assert.rejects(pending, error => error.code === 'session_changed' && error.originalEffectUnknown);
    await assert.rejects(f.resources.createStoredFirstPlan(confirmation(), 'original-source-key'), error => error.code === 'session_changed');
    assert.equal(f.calls.length, 1);
  }
});
