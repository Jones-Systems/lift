const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function load(file, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(imports, name), 'Unexpected runtime dependency: ' + name); return imports[name];
  }, module, module.exports);
  return module.exports;
}
const transport = load('api/transport'), { FormTransport, ApiError } = transport;
const firstPlan = load('api/firstPlan', { './transport': transport, './trainingCodec': load('api/trainingCodec', { './transport': transport }) });
const { FormResources } = load('api/resources', { './client': { ApiError, formApi: null }, './firstPlan': firstPlan });
const { createContextConfirmation } = load('integration/contextConfirmation', { '../api/transport': transport });
function account() {
  return { accountId: 'original', appAccountToken: 'never-public',
    profile: { revision: 4, name: 'Original', age: null, heightCm: 170, weightKg: 75, trainingBackground: 'returning',
      injuryHistory: 'Reviewed context', goals: ['strength'], trainingContext: 'At home' },
    preferences: { revision: 7, appMode: 'advanced', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['dumbbell'], remindersEnabled: false },
    onboarding: { revision: 1, status: 'completed', step: 'review', answers: { name: 'Historical' }, preferences: {}, completedAt: '2026-10-11T12:00:00.000Z' } };
}
function receipt(confirmation = { profileRevision: 4, preferencesRevision: 7 }) {
  return { plan: { id: 'saved_plan', name: 'Saved plan', minutes: 30, revision: 0, archived: false,
    createdAt: '2026-10-11T12:00:00.000Z', updatedAt: '2026-10-11T12:00:00.000Z',
    items: [{ id: 'item_1', exerciseId: 'exercise_1', setTarget: 3, repMin: 6, repMax: 10, targetKg: 12.5 }] },
    provenance: { schema: 'form.first-plan-provenance/v1', contextKey: 'context:v1', selectedCandidateId: 'candidate_1', ...confirmation,
      sources: [{ id: 'source_1', revision: 'revision_1' }], candidates: [{ id: 'candidate_1', status: 'eligible', gapCodes: [] }] } };
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const failure = (status, code) => response({ error: { code, message: 'Synthetic failure' } }, status);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(overrides = {}) {
  const f = { value: account(), calls: [], keys: 0, edits: [], generation: 'one', accountId: 'original',
    get: null, post: null, issuer: null };
  const api = new FormTransport('https://form.example.invalid', { async load() { return null; }, async save() {}, async clear() {} }, async (url, init) => {
    if (url.endsWith('/sign-in/email')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic' } });
    const call = { path: new URL(url).pathname, method: init.method, body: init.body && JSON.parse(init.body), key: init.headers['Idempotency-Key'] };
    f.calls.push(call);
    if (call.path === '/v1/me') return f.get ? f.get() : response(f.value);
    assert.equal(call.path, '/v1/plans/first'); assert.equal(call.method, 'POST');
    return f.post ? f.post(call) : response(receipt(call.body));
  });
  await api.signIn('synthetic@example.invalid', 'synthetic');
  const resources = new FormResources(api);
  f.api = api; f.resources = resources;
  f.options = { resources, scope: { accountId: 'original', sessionGeneration: 'one', originalAuth: api.captureAuthContext(),
    isCurrentSession: binding => binding.accountId === f.accountId && binding.sessionGeneration === f.generation && binding.resources === f.resources },
    newIdempotencyKey: () => { f.keys++; return f.issuer ? f.issuer() : f.keys === 1 ? 'original-key' : 'original-key-' + f.keys; }, openEdit: target => { f.edits.push(target); }, ...overrides };
  f.controller = createContextConfirmation(f.options);
  f.posts = () => f.calls.filter(call => call.method === 'POST');
  return f;
}

test('full current context is detached and deeply immutable with metadata-only status and no onboarding defaults', async () => {
  const f = await fixture(), { review, snapshot } = await f.controller.capture();
  assert.equal(snapshot.status, 'ready'); assert.deepEqual(review.profile, f.value.profile); assert.deepEqual(review.preferences, f.value.preferences);
  assert.equal(review.profile.name, 'Original');
  for (const value of [review, review.profile, review.profile.goals, review.preferences, review.preferences.equipment]) assert.ok(Object.isFrozen(value));
  assert.throws(() => review.profile.goals.push('other'), TypeError);
  f.value.profile.name = 'Later'; f.value.preferences.equipment.push('barbell');
  assert.equal(review.profile.name, 'Original'); assert.deepEqual(review.preferences.equipment, ['dumbbell']);
  assert.deepEqual(Object.keys(f.controller.snapshot()).sort(), ['canEdit', 'canRetry', 'effect', 'status']);
  assert.equal(JSON.stringify(review).includes('never-public'), false); assert.equal('accountId' in review, false);
});
test('explicit confirm sends captured revisions/key once and adopts complete decoded immutable receipt', async () => {
  const f = await fixture(), { review } = await f.controller.capture();
  f.value.profile.revision = 90; f.value.preferences.revision = 91;
  const result = await review.confirm();
  assert.equal(result.snapshot.status, 'saved'); assert.deepEqual(result.receipt, receipt());
  assert.ok(Object.isFrozen(result.receipt.provenance.sources[0]));
  assert.deepEqual(f.posts(), [{ path: '/v1/plans/first', method: 'POST', body: { profileRevision: 4, preferencesRevision: 7 }, key: 'original-key' }]);
  assert.equal(f.keys, 1); assert.equal(f.calls.filter(c => c.path === '/v1/me').length, 1);
  await review.confirm(); await f.controller.capture(); assert.equal(f.posts().length, 1);
});
test('edit uses existing target, invalidates old confirm and requires a fresh explicit review', async () => {
  const f = await fixture(), original = await f.controller.capture();
  assert.equal(original.review.edit('experience').status, 'stale'); assert.deepEqual(f.edits, ['experience']);
  assert.equal((await original.review.confirm()).snapshot.status, 'stale'); assert.equal(f.posts().length, 0);
  f.value.profile.trainingBackground = 'regular'; f.value.profile.revision++;
  const next = await f.controller.capture(); assert.equal(next.review.profile.trainingBackground, 'regular');
  assert.equal(f.posts().length, 0); await next.review.confirm(); assert.equal(f.posts()[0].body.profileRevision, 5);
});
test('cancel is local before dispatch and old closures cannot confirm a later review', async () => {
  const f = await fixture(), original = await f.controller.capture();
  assert.equal(original.review.cancel().status, 'cancelled');
  assert.equal((await original.review.confirm()).snapshot.status, 'stale'); assert.equal(f.keys, 0); assert.equal(f.posts().length, 0);
  const next = await f.controller.capture(); original.review.cancel(); assert.equal(f.controller.snapshot().status, 'ready');
  await next.review.confirm(); assert.equal(f.posts().length, 1);
});
for (const field of ['profile', 'preferences']) test('stale ' + field + ' revision requires recapture and explicit confirmation', async () => {
  const f = await fixture(), original = await f.controller.capture();
  f.value[field].revision++;
  f.post = call => call.body[field + 'Revision'] !== f.value[field].revision ? failure(409, 'stale_revision') : response(receipt(call.body));
  assert.equal((await original.review.confirm()).snapshot.status, 'stale'); assert.equal(f.posts().length, 1);
  await original.review.confirm(); assert.equal(f.posts().length, 1);
  const next = await f.controller.capture(); assert.equal(f.posts().length, 1); await next.review.confirm(); assert.equal(f.posts().length, 2);
});
test('same-account auth replacement invalidates review even when external account predicate remains true', async () => {
  const f = await fixture(), { review } = await f.controller.capture();
  await f.api.signIn('synthetic@example.invalid', 'replacement');
  assert.equal((await review.confirm()).snapshot.status, 'stale'); assert.equal(f.keys, 0); assert.equal(f.posts().length, 0);
  assert.equal((await f.controller.capture()).snapshot.status, 'stale');
});
for (const change of ['generation', 'account', 'resources']) test('original binding expires permanently after ' + change + ' replacement', async () => {
  const f = await fixture(), { review } = await f.controller.capture();
  if (change === 'generation') f.generation = 'two'; else if (change === 'account') f.accountId = 'foreign'; else f.resources = new FormResources(f.api);
  assert.equal((await review.confirm()).snapshot.status, 'stale');
  f.generation = 'one'; f.accountId = 'original'; f.resources = f.options.resources;
  assert.equal((await f.controller.capture()).snapshot.status, 'stale'); assert.equal(f.posts().length, 0); assert.equal(f.keys, 0);
});
test('late account capture cannot expose a review after auth replacement', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); f.get = () => { entered.resolve(); return gate.promise; };
  const pending = f.controller.capture(); await entered.promise;
  await f.api.signIn('other@example.invalid', 'synthetic'); gate.resolve(response(f.value));
  const result = await pending; assert.equal(result.snapshot.status, 'stale'); assert.equal(result.review, undefined);
});
test('unknown request refuses edit/cancel/recapture and explicit retry preserves original key/body after later known rejection', async () => {
  const f = await fixture(), { review } = await f.controller.capture();
  f.post = () => { throw new Error('Disconnected'); };
  assert.equal((await review.confirm()).snapshot.status, 'unknown'); assert.equal(f.controller.snapshot().canRetry, true);
  assert.equal(review.cancel().status, 'unknown'); assert.equal(review.edit('goals').status, 'unknown');
  assert.equal((await f.controller.capture()).snapshot.status, 'unknown'); assert.equal(f.edits.length, 0);
  f.value.profile.revision = 90; f.value.preferences.revision = 91;
  for (const [status, code] of [[422, 'invalid_request'], [409, 'stale_revision'], [501, 'first_plan_unavailable']]) {
    f.post = () => failure(status, code); assert.equal((await f.controller.retry()).snapshot.status, 'unknown');
  }
  f.post = call => response(receipt(call.body)); assert.equal((await f.controller.retry()).snapshot.status, 'saved');
  assert.equal(f.keys, 1); assert.equal(f.calls.filter(c => c.path === '/v1/me').length, 1);
  assert.equal(f.posts().length, 5); assert.ok(f.posts().every(c => c.key === 'original-key' && c.body.profileRevision === 4 && c.body.preferencesRevision === 7));
});
test('unknown followed by unauthorized retains liability while original auth expires and retry is denied', async () => {
  const f = await fixture(), { review } = await f.controller.capture(); f.post = () => failure(500, 'server_error');
  await review.confirm(); f.post = () => failure(401, 'unauthenticated'); const result = await f.controller.retry();
  assert.equal(result.snapshot.status, 'stale'); assert.equal(result.snapshot.effect, 'unknown'); assert.equal(result.snapshot.canRetry, false);
  await f.controller.retry(); assert.equal(f.posts().length, 2);
});
test('exact initial unavailable response is unavailable with no automatic fallback', async () => {
  const f = await fixture(), { review } = await f.controller.capture(); f.post = () => failure(501, 'first_plan_unavailable');
  const result = await review.confirm(); assert.equal(result.snapshot.status, 'unavailable'); assert.equal(result.snapshot.effect, 'none');
  assert.equal(f.posts().length, 1); assert.equal(result.receipt, undefined);
});
test('malformed receipt is unknown through the actual decoder', async () => {
  const f = await fixture(), { review } = await f.controller.capture(); f.post = () => response({ plan: receipt().plan });
  const result = await review.confirm(); assert.equal(result.snapshot.status, 'unknown'); assert.equal(result.receipt, undefined);
});
test('missing complete profile or preferences fields never acquires a key or writes', async () => {
  for (const section of ['profile', 'preferences']) for (const field of Object.keys(account()[section])) {
    if (field === 'trainingContext') continue;
    const f = await fixture(); delete f.value[section][field];
    const result = await f.controller.capture(); assert.equal(result.snapshot.status, 'unavailable', section + '.' + field);
    assert.equal(result.review, undefined); assert.equal(f.keys, 0); assert.equal(f.posts().length, 0);
  }
});
test('invalid fields or foreign account are unavailable and optional training context remains absent', async () => {
  for (const mutate of [a => { a.accountId = 'foreign'; }, a => { a.profile.age = '30'; }, a => { a.profile.goals = [3]; },
    a => { a.preferences.remindersEnabled = null; }, a => { a.preferences.revision = -1; }, a => { a.profile.trainingContext = {}; }]) {
    const f = await fixture(); mutate(f.value); assert.equal((await f.controller.capture()).snapshot.status, 'unavailable');
  }
  const f = await fixture(); delete f.value.profile.trainingContext;
  const result = await f.controller.capture(); assert.equal(result.snapshot.status, 'ready'); assert.equal('trainingContext' in result.review.profile, false);
});
test('missing trusted scope or key issuer is unavailable without even an account request', async () => {
  for (const overrides of [{ scope: null }, { newIdempotencyKey: undefined }]) {
    const f = await fixture(overrides); assert.equal((await f.controller.capture()).snapshot.status, 'unavailable'); assert.equal(f.calls.length, 0);
  }
});
test('absent edit port is explicitly unavailable with no write', async () => {
  const f = await fixture({ openEdit: undefined }), { review, snapshot } = await f.controller.capture();
  assert.equal(snapshot.canEdit, false); assert.equal(review.edit('experience').status, 'unavailable'); assert.equal(f.posts().length, 0);
});
test('double confirm and reentrant issuer share one local attempt; pending cannot cancel or retry', async () => {
  const f = await fixture(), { review } = await f.controller.capture(), gate = deferred(), entered = deferred(); let reentrant;
  f.issuer = () => { reentrant = review.confirm(); return 'original-key'; };
  f.post = () => { entered.resolve(); return gate.promise; };
  const first = review.confirm(), second = review.confirm(); assert.equal(first, second); await entered.promise; assert.equal(first, reentrant);
  assert.equal(review.cancel().status, 'pending'); assert.equal(review.edit('goals').status, 'pending'); await f.controller.retry();
  assert.equal(f.posts().length, 1); assert.equal(f.keys, 1); assert.equal(f.edits.length, 0);
  gate.resolve(response(receipt())); assert.equal((await first).snapshot.status, 'saved');
});
test('duplicate capture cannot dispatch and replacement edit callback is not adopted', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); f.get = () => { entered.resolve(); return gate.promise; };
  const pending = f.controller.capture(); await entered.promise;
  assert.equal((await f.controller.capture()).snapshot.status, 'loading'); assert.equal(f.calls.length, 1);
  gate.resolve(response(f.value)); const { review } = await pending;
  f.options.openEdit = () => { throw new Error('Replacement must not be used'); };
  review.edit('name'); assert.deepEqual(f.edits, ['name']); assert.equal(f.posts().length, 0);
});
test('disposal before dispatch consumes no key and late success after disposal keeps unknown metadata without receipt', async () => {
  const before = await fixture(), { review } = await before.controller.capture();
  const queued = review.confirm(); before.controller.dispose(); assert.equal((await queued).snapshot.status, 'stale'); assert.equal(before.keys, 0);
  const f = await fixture(), captured = await f.controller.capture(), gate = deferred(), entered = deferred();
  f.post = () => { entered.resolve(); return gate.promise; };
  const pending = captured.review.confirm(); await entered.promise; f.controller.dispose(); gate.resolve(response(receipt()));
  const result = await pending; assert.equal(result.snapshot.status, 'stale'); assert.equal(result.snapshot.effect, 'unknown'); assert.equal(result.receipt, undefined);
  await f.controller.retry(); assert.equal(f.posts().length, 1);
});
test('late receipt after same-account auth replacement is hidden and cannot be retried in replacement session', async () => {
  const f = await fixture(), { review } = await f.controller.capture(), gate = deferred(), entered = deferred();
  f.post = () => { entered.resolve(); return gate.promise; };
  const pending = review.confirm(); await entered.promise; await f.api.signIn('synthetic@example.invalid', 'replacement'); gate.resolve(response(receipt()));
  const result = await pending; assert.equal(result.snapshot.status, 'stale'); assert.equal(result.snapshot.effect, 'unknown'); assert.equal(result.receipt, undefined);
  await f.controller.retry(); assert.equal(f.posts().length, 1);
});
test('cancel during account loading invalidates late review without claiming a server write was cancelled', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); f.get = () => { entered.resolve(); return gate.promise; };
  const pending = f.controller.capture(); await entered.promise;
  assert.equal(f.controller.cancel().status, 'cancelled'); gate.resolve(response(f.value));
  const result = await pending; assert.equal(result.snapshot.status, 'cancelled'); assert.equal(result.review, undefined);
  assert.equal(f.keys, 0); assert.equal(f.posts().length, 0);
});
test('cancelled capture remains cancelled when its late account read fails', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); f.get = () => { entered.resolve(); return gate.promise; };
  const pending = f.controller.capture(); await entered.promise; f.controller.cancel(); gate.resolve(failure(503, 'unavailable'));
  assert.equal((await pending).snapshot.status, 'cancelled'); assert.equal(f.posts().length, 0);
});
test('invalid or throwing trusted key issuer cannot dispatch and does not invent a key', async () => {
  for (const issuer of [() => '', () => { throw new Error('Unavailable'); }]) {
    const f = await fixture(), { review } = await f.controller.capture(); f.issuer = issuer;
    const result = await review.confirm(); assert.equal(result.snapshot.status, 'unavailable'); assert.equal(result.snapshot.effect, 'none');
    assert.equal(f.keys, 1); assert.equal(f.posts().length, 0);
  }
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

test('actual stored source receipt remains complete deeply frozen and one confirmed intent', async () => {
  const f = await fixture(); f.post = () => response(sourceReceipt());
  const { review } = await f.controller.capture(), first = review.confirm(), second = review.confirm();
  assert.equal(first, second); const saved = await first;
  assert.equal(saved.snapshot.status, 'saved'); assert.deepEqual(saved.receipt, sourceReceipt());
  for (const value of [saved.receipt, saved.receipt.plan.duration, saved.receipt.plan.items[0].native.notes,
    saved.receipt.plan.items[0].registeredDomain.identity]) assert.ok(Object.isFrozen(value));
  assert.equal('rep_range' in saved.receipt.plan.items[1].native, false);
  await f.controller.retry(); await f.controller.capture(); await review.confirm();
  assert.equal(f.posts().length, 1); assert.equal(f.keys, 1);
});

test('malformed source acknowledgement stays unknown through unavailable retry and reuses original intent', async () => {
  const f = await fixture(); const bad = sourceReceipt(); bad.plan.items[0].native.exercise_id = 'wrong_association';
  f.post = () => response(bad); const { review } = await f.controller.capture();
  assert.equal((await review.confirm()).snapshot.status, 'unknown');
  f.post = () => failure(501, 'first_plan_unavailable'); const retry = await f.controller.retry();
  assert.equal(retry.snapshot.status, 'unknown'); assert.equal(retry.snapshot.effect, 'unknown');
  f.post = () => response(sourceReceipt()); assert.equal((await f.controller.retry()).snapshot.status, 'saved');
  assert.equal(f.keys, 1); assert.equal(f.posts().length, 3);
  for (const call of f.posts()) { assert.equal(call.key, 'original-key'); assert.deepEqual(call.body, { profileRevision: 4, preferencesRevision: 7 }); }
});

test('late source receipt cannot publish after original generation or authentication loss', async () => {
  for (const invalidate of [f => { f.generation = 'two'; }, f => f.api.signIn('replacement@synthetic.invalid', 'synthetic')]) {
    const f = await fixture(), gate = deferred(), started = deferred(); f.post = () => { started.resolve(); return gate.promise; };
    const { review } = await f.controller.capture(), pending = review.confirm();
    await started.promise; await invalidate(f); gate.resolve(response(sourceReceipt()));
    const result = await pending; assert.equal(result.snapshot.status, 'stale'); assert.equal(result.snapshot.effect, 'unknown');
    assert.equal(result.receipt, undefined); assert.equal(f.posts().length, 1);
  }
});
