const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function sourceLoader() {
  const cache = new Map();
  function load(name) {
    const file = path.resolve(root, name); assert.ok(file.startsWith(root + path.sep));
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    new Function('require', 'module', 'exports', code)(specifier => {
      if (specifier === 'react') return {};
      if (specifier === './client') return { ...load('api/transport.ts'), formApi: null };
      assert.ok(specifier.startsWith('.'), 'Unexpected dependency: ' + specifier);
      return load(path.relative(root, path.resolve(path.dirname(file), specifier + '.ts')));
    }, module, module.exports);
    return module.exports;
  }
  return load;
}
const load = sourceLoader();
const { FormTransport } = load('api/transport.ts');
const { FormResources } = load('api/resources.ts');
const { captureContextEditorSession } = load('integration/contextEditorSession.ts');
const { createContextEditorController } = load('settings/context-editors/model.ts');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
async function fixture(target = 'goals') {
  const f = { live: true, calls: [], adopted: [], closes: 0, mode: 'saved', account: {
    accountId: 'synthetic', profile: { revision: 1, name: 'Original', goals: ['custom goal'] },
    preferences: { revision: 1, equipment: ['custom equipment'] } } };
  const origin = 'https://context.integration.invalid';
  const api = new FormTransport(origin, {
    async load() { return JSON.stringify({ version: 1, baseURL: origin, token: 'synthetic-original' }); },
    async save() {}, async clear() {},
  }, async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/me') return json(f.account);
    if (path === '/api/auth/sign-in/email') return new Response('{}', { headers: { 'set-auth-token': 'synthetic-new-session' } });
    const body = JSON.parse(init.body);
    f.calls.push({ path, body, headers: init.headers });
    if (f.mode === 'unknown') throw Error('synthetic connection lost');
    if (f.mode === 'stale') return json({ error: { code: 'stale_revision', message: 'New revision' } }, 409);
    return json({ ...(path.endsWith('profile') ? f.account.profile : f.account.preferences), ...body, revision: 3 });
  });
  await api.restore();
  const resources = new FormResources(api);
  f.open = () => captureContextEditorSession(resources, f.account, target, {
    isCurrentSession: () => true, isCurrentEditor: () => f.live, close() { f.closes++; },
    profile(value) { f.adopted.push(value); }, preferences(value) { f.adopted.push(value); },
  });
  f.session = f.open(); f.entry = f.session.entry; f.api = api;
  return f;
}
test('original resource PATCH retains displayed revision and cloned arrays after server refresh', async () => {
  const f = await fixture();
  f.account.profile.goals.push('later mutation');
  f.account = { ...f.account, profile: { ...f.account.profile, revision: 2 } };
  assert.deepEqual(f.entry.profile.goals, ['custom goal']);
  const changes = { goals: ['custom goal', 'new goal'] };
  f.mode = 'unknown';
  const result = await f.entry.saveProfileFromEntry(changes);
  assert.equal(result.status, 'unknown');
  changes.goals.push('not original intent');
  f.mode = 'saved'; assert.equal((await result.retry()).status, 'saved');
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0], f.calls[1]);
  assert.deepEqual(f.calls[0].body, { goals: ['custom goal', 'new goal'], expectedRevision: 1 });
  assert.equal((await result.retry()).status, 'failed');
});
test('preferences initial save also uses displayed baseline', async () => {
  const f = await fixture('equipment'); f.account.preferences.revision = 2;
  assert.equal((await f.entry.savePreferencesFromEntry({ equipment: ['custom equipment'] })).status, 'saved');
  assert.equal(f.calls[0].body.expectedRevision, 1);
});
test('stale cannot reapply old intent; explicit reentry captures fresh revision', async () => {
  const f = await fixture(); f.mode = 'stale'; f.account.profile.revision = 2;
  const leaf = createContextEditorController(f.entry, f.entry.attachment);
  leaf.edit('goals', ['new goal']); await leaf.save();
  assert.equal(leaf.snapshot().status, 'stale'); leaf.edit('goals', ['reapply']); await leaf.save();
  assert.equal(f.calls.length, 1); leaf.close();
  assert.equal((await f.entry.saveProfileFromEntry({ goals: ['reapply'] })).status, 'failed');
  f.mode = 'saved'; const fresh = f.open();
  await fresh.entry.saveProfileFromEntry({ goals: ['fresh'] });
  assert.equal(f.calls[1].body.expectedRevision, 2);
});
test('retained save/retry/close refuse after retirement or same-account auth replacement', async () => {
  for (const kind of ['dispose', 'route', 'auth']) {
    const f = await fixture(); f.mode = 'unknown';
    const result = await f.entry.saveProfileFromEntry({ goals: ['new'] }); assert.equal(result.status, 'unknown');
    f.entry.closeFromEntry(); assert.equal(f.closes, 0);
    if (kind === 'dispose') f.session.dispose();
    if (kind === 'route') f.live = false;
    if (kind === 'auth') await f.api.signIn('synthetic@example.invalid', 'synthetic-password');
    assert.equal((await result.retry()).status, 'failed');
    assert.equal((await f.entry.saveProfileFromEntry({ goals: ['later'] })).status, 'failed');
    f.entry.closeFromEntry(); assert.equal(f.closes, 0); assert.equal(f.calls.length, 1);
  }
});

test('removed editor retains unresolved original-session navigation fence', async () => {
  const f = await fixture(); f.mode = 'unknown';
  const result = await f.entry.saveProfileFromEntry({ goals: ['issued'] });
  assert.equal(result.status, 'unknown'); f.session.dispose();
  assert.equal(f.session.navigationBlocked(), true);
  assert.equal((await result.retry()).status, 'failed'); assert.equal(f.calls.length, 1);
});
