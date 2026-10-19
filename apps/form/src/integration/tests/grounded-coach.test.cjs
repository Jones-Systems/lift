const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const { pathToFileURL } = require('node:url'), { createHash } = require('node:crypto');
const app = path.resolve(__dirname, '../..'), root = path.resolve(app, '../../..');
function load(file, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(app, file + '.ts'), 'utf8'), {
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
const grounded = load('api/groundedAnswer', { './transport': transport });
const { createGroundedCoach } = load('integration/groundedCoach', { '../api/groundedAnswer': grounded });
const digest = '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10';
let hostPromise;
function host() {
  return hostPromise ??= (async () => {
    const bytes = fs.readFileSync(path.join(root, 'services/api/dist/grounding', digest, 'projection.json'));
    assert.equal(bytes.length, 80588); assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
    const native = await import(pathToFileURL(path.join(root, 'services/api/dist/src/integration/grounded-answer.js')).href);
    return native.createGroundedAnswerHost({ projectionBytes: bytes });
  })();
}
async function answer(body) {
  const result = (await host()).answer({ accountId: 'synthetic', authUserId: 'synthetic', sessionId: 'synthetic', epoch: 0 }, body, () => {});
  return JSON.parse(JSON.stringify(result));
}
const response = value => new Response(JSON.stringify(value), { status: 200 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const draft = (question = 'FLE-S05') => ({ question, facts: [{ id: 'walking', text: ' I walk regularly. ' }, { id: 'choice', text: 'Keep my wording.' }] });
async function fixture(overrides = {}, create = createGroundedCoach) {
  const f = { calls: [], keys: 0, profile: 4, preferences: 7, accountId: 'original', generation: 'shell:1', post: null, issuer: null, capture: null };
  f.api = new FormTransport('https://form.example.invalid', { async load() { return null; }, async save() {}, async clear() {} }, async (url, init) => {
    if (url.endsWith('/sign-in/email')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic' } });
    const call = { path: new URL(url).pathname, method: init.method, body: JSON.parse(init.body) };
    f.calls.push(call); assert.equal(call.path, '/v1/grounded-answers'); assert.equal(call.method, 'POST');
    return f.post ? f.post(call) : response(await answer(call.body));
  });
  await f.api.signIn('synthetic@example.invalid', 'synthetic');
  f.resources = new FormResources(f.api);
  f.options = { resources: f.resources, accountId: 'original', sessionGeneration: 'shell:1',
    isCurrentSession: (accountId, generation) => accountId === f.accountId && generation === f.generation,
    newRevision: () => { f.keys++; return f.issuer ? f.issuer() : '00000000-0000-4000-8000-' + String(f.keys).padStart(12, '0'); },
    captureDocuments: () => {
      if (f.capture) return f.capture();
      const profileRevision = f.profile, preferencesRevision = f.preferences;
      return { profileRevision, preferencesRevision, isCurrent: () => f.profile === profileRevision && f.preferences === preferencesRevision };
    }, ...overrides };
  f.entry = create(f.options);
  f.confirm = (value = draft()) => { f.entry.edit(value); const review = f.entry.review().review; assert.ok(review); assert.equal(review.confirm().status, 'confirmed'); return review; };
  return f;
}

test('literal review is detached and frozen; only explicit confirm permits the exact captured POST', async () => {
  const f = await fixture(), input = draft('  FLE-S05?  ');
  f.entry.edit(input); const review = f.entry.review().review; input.question = 'replaced'; input.facts[0].text = 'replaced';
  assert.equal(review.question, '  FLE-S05?  '); assert.equal(review.facts[0].text, ' I walk regularly. ');
  assert.ok(Object.isFrozen(review)); assert.ok(Object.isFrozen(review.facts)); assert.ok(Object.isFrozen(review.facts[0]));
  assert.equal((await f.entry.ask()).status, 'idle'); assert.equal(f.calls.length, 0); assert.equal(f.keys, 0);
  const confirmed = review.confirm(); assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.answer.status, 'idle');
  assert.equal(f.calls.length, 0); assert.equal(f.keys, 1); assert.equal(confirmed.context.supersedesRevision, null);
  assert.ok(Object.isFrozen(confirmed.context.facts[0])); assert.equal('accountId' in confirmed.context, false);
  const result = await f.entry.ask(); assert.equal(result.status, 'ready');
  assert.deepEqual(f.calls[0].body, { retrieval: { query: review.question }, context: confirmed.context });
  assert.deepEqual(f.entry.getSnapshot().context.facts, review.facts.map(fact => ({ ...fact, origin: 'user_provided' })));
  const citation = f.entry.selectCitation('FLE-S05'); assert.ok(citation); assert.equal(citation.originalPassageVerified, false);
  assert.equal(f.entry.selectCitation('unregistered'), null); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(f.entry.getSnapshot()).includes('synthetic@example.invalid'), false);
});

test('empty facts require an issued review and synchronous idempotent confirmation', async () => {
  const f = await fixture(); f.entry.edit({ question: 'FLE-S05', facts: [] });
  await f.entry.ask(); assert.equal(f.calls.length, 0);
  const review = f.entry.review().review, confirmed = review.confirm();
  assert.deepEqual(confirmed.context.facts, []); assert.equal(review.confirm().context, confirmed.context); assert.equal(f.keys, 1);
  await f.entry.ask(); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].body.context.facts, []);
});

test('fabricated and superseded review handles cannot confirm or cancel the current review', async () => {
  const f = await fixture(); f.entry.edit(draft()); const old = f.entry.review().review, fabricated = { ...old };
  assert.equal(fabricated.confirm().status, 'stale'); assert.equal(f.keys, 0);
  f.entry.edit(draft('ANA-S13')); const current = f.entry.review().review;
  assert.equal(old.confirm().status, 'stale'); assert.equal(old.cancel().status, 'stale');
  assert.equal(f.entry.getSnapshot().review, current); current.confirm(); assert.equal(f.keys, 1); assert.equal(f.calls.length, 0);
});

for (const field of ['profile', 'preferences']) test(field + ' change before confirmation requires fresh review without consuming a revision', async () => {
  const f = await fixture(); f.entry.edit(draft()); const old = f.entry.review().review; f[field]++;
  assert.equal(old.confirm().status, 'stale'); assert.equal(f.keys, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.entry.getSnapshot().context, null); const fresh = f.entry.review().review; assert.ok(fresh);
  assert.equal(fresh.confirm().status, 'confirmed'); assert.equal(f.keys, 1); assert.equal(old.confirm().status, 'stale');
});

for (const field of ['profile', 'preferences']) test(field + ' change during delivery hides context and rejects the late authentic answer', async () => {
  const f = await fixture(), next = deferred(); f.post = () => next.promise; f.confirm();
  const pending = f.entry.ask(), body = f.calls[0].body; f[field]++;
  assert.equal(f.entry.getSnapshot().status, 'stale'); assert.equal(f.entry.selectCitation('FLE-S05'), null);
  next.resolve(response(await answer(body))); assert.equal((await pending).status, 'stale');
  assert.equal(f.entry.getSnapshot().answer.answer, null); assert.equal(f.calls.length, 1);
});

test('same-account auth replacement invalidates the original scope even when the account predicate stays true', async () => {
  const f = await fixture(); const review = f.confirm();
  await f.api.signIn('synthetic@example.invalid', 'synthetic');
  assert.equal(f.options.isCurrentSession('original', 'shell:1'), true);
  assert.equal(review.confirm().status, 'stale'); assert.equal(f.entry.getSnapshot().draft, null);
  await f.entry.ask(); assert.equal(f.calls.length, 0); assert.equal(f.entry.review().review, null);
});

test('same-account auth replacement during pending delivery never publishes the earlier response', async () => {
  const f = await fixture(), next = deferred(); f.post = () => next.promise; f.confirm();
  const pending = f.entry.ask(), body = f.calls[0].body;
  await f.api.signIn('synthetic@example.invalid', 'synthetic');
  next.resolve(response(await answer(body))); assert.equal((await pending).status, 'stale');
  assert.equal(f.entry.getSnapshot().context, null); assert.equal(f.entry.selectCitation('FLE-S05'), null);
  assert.equal(f.entry.getSnapshot().draft, null); assert.equal(f.calls.length, 1);
});

test('account, generation and resource replacement permanently invalidate the captured producer', async () => {
  for (const change of [f => { f.accountId = 'foreign'; }, f => { f.generation = 'shell:2'; }, f => { f.options.resources = new FormResources(f.api); }]) {
    const f = await fixture(); f.confirm(); change(f);
    assert.equal(f.entry.getSnapshot().status, 'stale'); assert.equal(f.entry.getSnapshot().draft, null);
    f.accountId = 'original'; f.generation = 'shell:1'; f.options.resources = f.resources;
    assert.equal(f.entry.edit(draft()).status, 'stale'); assert.equal(f.entry.review().review, null); assert.equal(f.calls.length, 0);
  }
});

test('captureContext compares complete ordered facts and supersession despite matching revision', async () => {
  let dependencies;
  const wrapped = { ...grounded, createGroundedAnswerCaller: value => { dependencies = value; return grounded.createGroundedAnswerCaller(value); } };
  const { createGroundedCoach: create } = load('integration/groundedCoach', { '../api/groundedAnswer': wrapped });
  const f = await fixture({}, create); f.confirm(); const original = f.entry.getSnapshot().context;
  const valid = dependencies.captureContext(JSON.parse(JSON.stringify(original))); assert.equal(valid.isCurrent(), true);
  for (const mutate of [value => { value.facts[0].text = 'altered'; }, value => { value.facts.reverse(); },
    value => { value.supersedesRevision = 'other'; }, value => { value.facts[0].origin = 'profile'; }, value => { delete value.facts[0]; }]) {
    const altered = JSON.parse(JSON.stringify(original)); mutate(altered);
    assert.equal(dependencies.captureContext(altered).isCurrent(), false);
  }
  f.entry.edit(draft()); assert.equal(valid.isCurrent(), false); assert.equal(f.calls.length, 0);
});

test('correction supersedes the confirmed revision and late older delivery cannot replace the newer answer', async () => {
  const f = await fixture(), first = deferred(); f.post = () => first.promise;
  f.confirm(); const original = f.entry.getSnapshot().context, old = f.entry.ask(), originalBody = f.calls[0].body;
  f.confirm(draft('ANA-S13')); const corrected = f.entry.getSnapshot().context;
  assert.equal(corrected.supersedesRevision, original.revision); assert.notEqual(corrected.revision, original.revision);
  assert.equal(f.entry.selectCitation('FLE-S05'), null); assert.equal(f.entry.getSnapshot().answer.answer, null);
  f.post = call => answer(call.body).then(response); const latest = await f.entry.ask(); assert.equal(latest.status, 'ready');
  first.resolve(response(await answer(originalBody))); assert.equal((await old).status, 'stale');
  assert.equal(f.entry.getSnapshot().context, corrected); assert.equal(f.entry.selectCitation('FLE-S05'), null);
  assert.ok(f.entry.selectCitation('ANA-S13')); assert.equal(f.calls.length, 2);
});

test('edit and explicit invalidation immediately hide a delivered citation with no second retrieval', async () => {
  const f = await fixture(); f.confirm(); await f.entry.ask(); assert.ok(f.entry.selectCitation('FLE-S05'));
  f.entry.edit(draft('ANA-S13')); assert.equal(f.entry.selectCitation('FLE-S05'), null); assert.equal(f.entry.getSnapshot().context, null);
  f.entry.review().review.confirm(); await f.entry.ask(); assert.ok(f.entry.selectCitation('ANA-S13'));
  f.entry.invalidate(); assert.equal(f.entry.selectCitation('ANA-S13'), null); assert.equal(f.entry.getSnapshot().answer.answer, null);
  assert.equal(f.calls.length, 2);
});

test('cancel and permanent disposal clear pending presentation without claiming network cancellation', async () => {
  for (const operation of ['cancel', 'dispose']) {
    const f = await fixture(), next = deferred(); f.post = () => next.promise; const review = f.confirm();
    const pending = f.entry.ask(), body = f.calls[0].body, snapshot = f.entry[operation]();
    assert.equal(snapshot.status, operation === 'cancel' ? 'cancelled' : 'disposed');
    assert.equal(snapshot.context, null); assert.equal(snapshot.draft, null); assert.equal(snapshot.review, null);
    assert.equal(f.calls.length, 1); assert.equal(review.confirm().status, 'stale');
    next.resolve(response(await answer(body))); await pending;
    assert.equal(f.entry.getSnapshot().answer.answer, null); assert.equal(f.entry.selectCitation('FLE-S05'), null);
    if (operation === 'dispose') { assert.equal(f.entry.edit(draft()).status, 'disposed'); assert.equal(f.entry.review().review, null); }
  }
});

test('missing scope, document witness, invalid text and oversized wire are unavailable with zero dispatch', async () => {
  for (const override of [{ newRevision: undefined }, { captureDocuments: undefined }, { resources: undefined }, { isCurrentSession: undefined }]) {
    const f = await fixture(override); assert.equal(f.entry.getSnapshot().status, 'unavailable');
    f.entry.edit(draft()); assert.equal(f.entry.review().review, null); await f.entry.ask(); assert.equal(f.calls.length, 0);
  }
  for (const witness of [null, { profileRevision: -1, preferencesRevision: 7, isCurrent: () => true },
    { profileRevision: 4, preferencesRevision: 7 }, { profileRevision: 4, preferencesRevision: 7, isCurrent: () => false }]) {
    const f = await fixture(); f.capture = () => witness; f.entry.edit(draft()); assert.equal(f.entry.review().review, null);
    assert.equal(f.entry.getSnapshot().context, null); assert.equal(f.keys, 0); assert.equal(f.calls.length, 0);
  }
  for (const input of [draft('  '), draft('?!'), draft('\ud800'), { question: 'FLE-S05', facts: [{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }] },
    { question: 'FLE-S05', facts: [{ id: 'x', text: '界'.repeat(23000) }] }]) {
    const f = await fixture(); f.entry.edit(input); assert.equal(f.entry.review().review, null); assert.equal(f.entry.getSnapshot().status, 'unavailable');
    assert.equal(f.keys, 0); assert.equal(f.calls.length, 0);
  }
});

test('malformed answer and uncertain transport delivery stay unavailable without automatic retry', async () => {
  for (const post of [async () => response({ schema: 'invented' }), async () => { throw new TypeError('Synthetic delivery uncertainty'); }]) {
    const f = await fixture(); f.post = post; f.confirm(); const result = await f.entry.ask();
    assert.equal(result.status, 'unavailable'); assert.equal(f.entry.getSnapshot().status, 'unavailable');
    assert.equal(result.answer, null); assert.equal(f.entry.selectCitation('FLE-S05'), null);
    f.entry.getSnapshot(); assert.equal(f.calls.length, 1); assert.equal(f.keys, 1);
  }
});

test('same-revision response with altered facts is rejected by the actual portable decoder', async () => {
  const f = await fixture(); f.post = async call => {
    const result = await answer(call.body); result.context.facts[0].text = 'server replacement'; return response(result);
  };
  f.confirm(); const result = await f.entry.ask(); assert.equal(result.status, 'unavailable'); assert.equal(result.answer, null);
  assert.equal(f.entry.getSnapshot().context.facts[0].text, ' I walk regularly. '); assert.equal(f.calls.length, 1);
});

test('single flight is installed before reentrant fetch and late results stay in the original request', async () => {
  const f = await fixture(), next = deferred(); let reentrant;
  f.post = () => { reentrant = f.entry.ask(); return next.promise; }; f.confirm(); const pending = f.entry.ask();
  assert.equal(f.entry.ask(), pending); assert.equal(reentrant, pending); assert.equal(f.calls.length, 1);
  assert.equal(f.entry.getSnapshot().answer.status, 'pending');
  next.resolve(response(await answer(f.calls[0].body))); assert.equal((await pending).status, 'ready');
});

test('reentrant document capture or revision issue cannot restore a superseded review', async () => {
  const f = await fixture(); f.entry.edit(draft());
  f.capture = () => { f.entry.edit(draft('ANA-S13')); return { profileRevision: 4, preferencesRevision: 7, isCurrent: () => true }; };
  assert.equal(f.entry.review().review, null); assert.equal(f.entry.getSnapshot().draft.question, 'ANA-S13'); assert.equal(f.keys, 0);
  f.capture = null; const review = f.entry.review().review;
  f.issuer = () => { f.entry.edit(draft('EXU-S03')); throw new Error('Synthetic interrupted issuer'); };
  assert.equal(review.confirm().status, 'stale'); assert.equal(f.entry.getSnapshot().status, 'editing');
  assert.equal(f.entry.getSnapshot().draft.question, 'EXU-S03'); assert.equal(f.calls.length, 0);
});

test('a repeated revision cannot confirm a correction or consume a stale session issuer', async () => {
  const f = await fixture(); f.confirm(); const id = f.entry.getSnapshot().context.revision;
  f.issuer = () => id; f.entry.edit(draft('ANA-S13')); const review = f.entry.review().review;
  assert.equal(review.confirm().status, 'unavailable'); assert.equal(f.entry.getSnapshot().context, null); assert.equal(f.calls.length, 0);
  f.entry.edit(draft()); const next = f.entry.review().review; f.generation = 'shell:2'; const consumed = f.keys;
  assert.equal(next.confirm().status, 'stale'); assert.equal(f.keys, consumed);
});
