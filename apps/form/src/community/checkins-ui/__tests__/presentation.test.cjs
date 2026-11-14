const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../../..'), cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative); assert.ok(file.startsWith(root + path.sep));
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'));
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { CommunityResources } = load('api/community.ts');
const { FormTransport } = load('api/transport.ts');
const { createCheckinsPresentation } = load('community/checkins-ui/presentation.ts');
const G = '11111111-1111-4111-8111-111111111111', P = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const at = '2026-10-09T12:00:00.000Z';
const post = (extra = {}) => ({ id: P, revision: 1, kind: 'check_in', state: 'published', createdAt: at, expiresAt: at, ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t) {
  const calls = [], state = { generation: 'session-one', mounted: true, response: () => ({ posts: [post()], nextCursor: null }) };
  const transport = new FormTransport('https://synthetic.invalid', {
    async load() { return null; }, async save() {}, async clear() {},
  }, async (url, options) => {
    if (url.includes('/api/auth/sign-in')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic-session' } });
    const parsed = new URL(url), call = { path: parsed.pathname, search: parsed.search, method: options.method, body: options.body };
    calls.push(call); const value = await state.response(call); return value instanceof Response ? value : json(value);
  });
  await transport.signIn('synthetic@example.invalid', 'synthetic-password');
  const resources = new CommunityResources(transport, () => state.mounted), controller = resources.createPostsController(G);
  let closes = 0;
  const onClose = () => { closes++; };
  const contextFor = (sessionGeneration = 'session-one') => ({ controller, groupId: G, sessionGeneration,
    isCurrentSession: () => state.generation === sessionGeneration, onClose });
  const context = contextFor();
  const models = [];
  function model(ctx = context) { const value = createCheckinsPresentation(ctx); models.push(value); value.attach(); return value; }
  t.after(() => { for (const value of models) value.detach(); resources.dispose(); });
  return { calls, state, transport, resources, controller, context, contextFor, model, closes: () => closes };
}

test('explicit idle read uses only GET and projects current DTO content without inventing missing fields', async t => {
  const f = await fixture(t), m = f.model();
  assert.equal(m.getSnapshot().status, 'idle'); assert.equal(f.calls.length, 0);
  await m.refresh();
  let view = m.getSnapshot();
  assert.equal(view.status, 'ready'); assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].alias, null); assert.equal(view.rows[0].text, null); assert.equal(view.rows[0].template, null);
  assert.equal(view.rows[0].createdAt, at); assert.equal(view.rows[0].expiresAt, at);
  f.state.response = () => ({ posts: [post({ alias: 'Leaf', text: 'W'.repeat(500), template: 'at_my_pace' })], nextCursor: null });
  await m.refresh(); view = m.getSnapshot();
  assert.equal(view.rows[0].alias, 'Leaf'); assert.equal(view.rows[0].text, 'W'.repeat(500));
  assert.equal(view.rows[0].template, 'Taking it at my pace');
  assert.ok(f.calls.every(call => call.method === 'GET' && call.body === undefined));
});

test('all post states stay distinct and unpublished content is redacted before presentation', async t => {
  const f = await fixture(t), m = f.model();
  f.state.response = () => ({ posts: ['pending', 'published', 'hidden', 'rejected'].map((state, n) =>
    post({ id: [P, C, D, G][n], state, alias: `Alias ${state}`, text: `Text ${state}`, template: 'checking_in' })), nextCursor: null });
  await m.refresh(); const rows = m.getSnapshot().rows;
  assert.deepEqual(rows.map(row => row.state), ['pending', 'published', 'hidden', 'rejected']);
  assert.equal(rows[1].text, 'Text published'); assert.equal(rows[1].template, 'Checking in');
  for (const row of [rows[0], rows[2], rows[3]]) {
    assert.equal(row.alias, null); assert.equal(row.text, null); assert.equal(row.template, null);
    assert.equal(row.createdAt, null); assert.equal(row.expiresAt, null); assert.ok(row.notice);
  }
  assert.equal(new Set(rows.map(row => row.label)).size, 4);
});

test('next reads pass the exact opaque cursor, replace pages, and preserve an empty page with another cursor', async t => {
  const f = await fixture(t), m = f.model();
  f.state.response = call => call.search.includes(C) ? { posts: [], nextCursor: D } :
    call.search.includes(D) ? { posts: [post({ id: D })], nextCursor: null } : { posts: [post()], nextCursor: C };
  await m.refresh(); await m.next();
  assert.equal(f.calls[1].search, `?cursor=${C}`); assert.equal(m.getSnapshot().status, 'empty');
  assert.deepEqual(m.getSnapshot().rows, []); assert.equal(m.getSnapshot().canNext, true);
  assert.match(m.getSnapshot().notice.text, /No posts on this page/);
  await m.next(); assert.equal(f.calls[2].search, `?cursor=${D}`);
  assert.deepEqual(m.getSnapshot().rows.map(row => row.id), [D]); assert.equal(m.getSnapshot().canNext, false);
  await m.next(); assert.equal(f.calls.length, 3);
  await m.refresh(); assert.equal(f.calls[3].search, ''); assert.deepEqual(m.getSnapshot().rows.map(row => row.id), [P]);
});

test('synchronous duplicate refresh and next clicks dispatch only one read per in-flight operation', async t => {
  const f = await fixture(t), m = f.model(), first = deferred();
  f.state.response = () => first.promise;
  const reading = m.refresh(), duplicate = m.refresh();
  assert.equal(f.calls.length, 1); assert.equal(m.getSnapshot().busy, true); assert.equal(m.getSnapshot().canRefresh, false);
  first.resolve({ posts: [], nextCursor: C }); await Promise.all([reading, duplicate]);
  const second = deferred(); f.state.response = () => second.promise;
  const next = m.next(), repeated = m.next(); assert.equal(f.calls.length, 2);
  second.resolve({ posts: [], nextCursor: null }); await Promise.all([next, repeated]);
  assert.equal(m.getSnapshot().busy, false); assert.equal(m.getSnapshot().status, 'empty');
});

test('controller latest-read result wins without leaf page accumulation', async t => {
  const f = await fixture(t), m = f.model(), older = deferred(), latest = deferred();
  f.state.response = call => call.search ? latest.promise : older.promise;
  const first = m.refresh(), second = f.controller.loadPage({ cursor: C });
  latest.resolve({ posts: [post({ id: C, text: 'Latest page' })], nextCursor: null }); await second;
  older.resolve({ posts: [post({ text: 'Old page' })], nextCursor: D }); await first;
  assert.deepEqual(m.getSnapshot().rows.map(row => row.text), ['Latest page']); assert.equal(m.getSnapshot().nextCursor, null);
});

test('read errors and stale invalidation clear rows and require explicit refresh without retry loops', async t => {
  const f = await fixture(t), m = f.model(); await m.refresh();
  f.state.response = () => json({ error: { code: 'community_unavailable', message: 'RAW private error' } }, 503);
  await m.refresh(); assert.equal(m.getSnapshot().status, 'error'); assert.deepEqual(m.getSnapshot().rows, []);
  assert.equal(m.getSnapshot().canRefresh, true); assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(m.getSnapshot()).includes('RAW'), false);
  f.state.response = () => ({ id: P, revision: 2, state: 'hidden' }); await f.controller.hidePost(P, 1, 'host-hide');
  assert.equal(m.getSnapshot().status, 'stale'); assert.deepEqual(m.getSnapshot().rows, []);
  assert.equal(m.getSnapshot().canRefresh, true);
  f.state.response = () => ({ posts: [], nextCursor: null }); await m.refresh();
  assert.equal(m.getSnapshot().status, 'empty'); assert.equal(f.calls.length, 4);
});

test('the actual parser rejects provided empty alias or text rather than turning it into a missing value', async t => {
  const f = await fixture(t), m = f.model();
  for (const field of ['alias', 'text']) {
    f.state.response = () => ({ posts: [post({ [field]: '' })], nextCursor: null });
    await m.refresh(); assert.equal(m.getSnapshot().status, 'error'); assert.deepEqual(m.getSnapshot().rows, []);
    assert.equal(f.controller.getSnapshot().page.error.code, 'community_invalid_response');
  }
});

test('closing during a read expires callbacks and late completion cannot repopulate or navigate the old presentation', async t => {
  const f = await fixture(t), m = f.model(), waiting = deferred(); f.state.response = () => waiting.promise;
  const refresh = m.refresh, next = m.next, close = m.close, read = refresh();
  close(); assert.equal(f.closes(), 1); assert.equal(m.getSnapshot().status, 'sessionended');
  waiting.resolve({ posts: [post({ text: 'Late private content' })], nextCursor: C }); await read;
  await refresh(); await next(); close();
  assert.equal(f.calls.length, 1); assert.equal(f.closes(), 1); assert.deepEqual(m.getSnapshot().rows, []);
  assert.equal(f.controller.getSnapshot().disposed, false);
  const remount = f.model(); assert.equal(remount.getSnapshot().rows[0].text, 'Late private content');
});

test('detach permanently expires old callbacks and remount preserves the host current page without another read', async t => {
  const f = await fixture(t), old = f.model(); await old.refresh();
  old.detach(); const next = f.model({ ...f.context });
  await old.refresh(); await old.next(); old.close();
  assert.equal(f.calls.length, 1); assert.equal(f.closes(), 0); assert.equal(next.getSnapshot().rows.length, 1);
  assert.equal(f.controller.getSnapshot().disposed, false);
  next.close(); assert.equal(f.closes(), 1);
});

test('a synchronous subscriber removal fences dispatch before loadPage', async t => {
  const f = await fixture(t), m = f.model();
  m.subscribe(() => m.detach()); await m.refresh();
  assert.equal(f.calls.length, 0); assert.equal(m.getSnapshot().status, 'sessionended');
});

test('new auth generation cannot adopt reused controller state even if old session guard later returns true', async t => {
  const f = await fixture(t), old = f.model(); await old.refresh(); old.detach();
  f.state.generation = 'session-two'; const replacement = f.model(f.contextFor('session-two'));
  assert.equal(replacement.getSnapshot().status, 'sessionended'); assert.deepEqual(replacement.getSnapshot().rows, []);
  f.state.generation = 'session-one'; const returned = f.model(); await returned.refresh(); returned.close();
  assert.equal(returned.getSnapshot().status, 'sessionended'); assert.equal(f.calls.length, 1); assert.equal(f.closes(), 0);
});

test('disposed controller and both group-binding mismatches redact content and dispatch nothing', async t => {
  for (const mismatch of ['snapshot', 'page', 'disposed']) {
    const f = await fixture(t); await f.controller.loadPage();
    if (mismatch === 'disposed') f.controller.dispose();
    else {
      const original = f.controller.getSnapshot.bind(f.controller);
      f.controller.getSnapshot = () => { const value = original(); return mismatch === 'snapshot'
        ? { ...value, groupId: C } : { ...value, page: { ...value.page, groupId: C } }; };
    }
    const m = f.model(); await m.refresh(); await m.next(); m.close();
    assert.deepEqual(m.getSnapshot().rows, []); assert.equal(f.calls.length, 1); assert.equal(f.closes(), 0);
    assert.equal(m.getSnapshot().status, mismatch === 'disposed' ? 'disposed' : 'sessionended');
  }
});

test('session end and real transport auth replacement fence deferred pages and old handlers', async t => {
  for (const end of ['host', 'auth']) {
    const f = await fixture(t), m = f.model(), waiting = deferred(); f.state.response = () => waiting.promise;
    const read = m.refresh();
    if (end === 'host') f.state.generation = 'session-two';
    else await f.transport.signIn('other@example.invalid', 'synthetic-password');
    waiting.resolve({ posts: [post({ text: 'Old session page' })], nextCursor: C }); await read;
    await m.refresh(); await m.next(); m.close();
    assert.deepEqual(m.getSnapshot().rows, []); assert.equal(f.calls.length, 1); assert.equal(f.closes(), 0);
  }
});

test('foreign pending and unknown commands block navigation and reads without leaf writes or mutation retry', async t => {
  const f = await fixture(t), m = f.model(), waiting = deferred();
  f.state.response = () => waiting.promise;
  const host = f.controller.createPost({ kind: 'win', text: 'Private original draft', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'host-command');
  const failure = assert.rejects(host, error => error.originalEffectUnknown);
  assert.equal(m.getSnapshot().canClose, false); assert.match(m.getSnapshot().commandNotice.text, /in progress/);
  await m.refresh(); await m.next(); m.close(); assert.equal(f.calls.length, 1); assert.equal(f.closes(), 0);
  waiting.resolve(json({ error: { code: 'community_posting_unavailable' } }, 503)); await failure;
  assert.match(m.getSnapshot().commandNotice.text, /unconfirmed outcome/);
  assert.equal(JSON.stringify(m.getSnapshot()).includes('Private original draft'), false);
  await m.refresh(); await m.next(); m.close(); assert.equal(f.calls.length, 1); assert.equal(f.closes(), 0);
  assert.equal(f.controller.getSnapshot().command.intent.state, 'unknown');
});

test('known command rejection does not retain a false read-unavailable state or echo rejected text', async t => {
  const f = await fixture(t), m = f.model();
  f.state.response = () => json({ error: { code: 'community_text_rejected', message: 'Private rejected draft' } }, 422);
  await assert.rejects(f.controller.createPost({ kind: 'win', text: 'Private rejected draft', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'host-rejected'));
  assert.equal(m.getSnapshot().canRefresh, true); assert.equal(m.getSnapshot().canClose, true);
  assert.equal(JSON.stringify(m.getSnapshot()).includes('Private rejected draft'), false);
  f.state.response = () => ({ posts: [], nextCursor: null }); await m.refresh();
  assert.equal(m.getSnapshot().status, 'empty'); assert.equal(f.calls.length, 2);
});
