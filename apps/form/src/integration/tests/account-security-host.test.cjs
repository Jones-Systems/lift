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
const { captureAccountSecuritySession } = load('integration/accountSecuritySession.ts');
const password = 'synthetic-password-new';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture() {
  const f = { live: true, settings: { accountId: 'original', identity: { email: 'old@example.invalid', emailVerified: true,
    signInMethods: ['emailPassword'], phoneNumber: null }, capabilities: {
    changePassword: { supported: true, status: 'available' }, changeEmail: { supported: true, status: 'verified' } } },
    account: { accountId: 'original', profile: { revision: 4 }, preferences: { revision: 7 } },
    read: null, password: null, confirmation: null, adopted: [], calls: [], stored: [], cleared: 0, foreign: 0 };
  const origin = 'https://form.integration.invalid';
  f.api = new FormTransport(origin, {
    async load() { return JSON.stringify({ version: 1, baseURL: origin, token: 'synthetic-original' }); },
    async save(value) { f.stored.push(JSON.parse(value).token); }, async clear() { f.cleared++; },
  }, async (url, init) => {
    const route = new URL(url).pathname;
    f.calls.push({ path: route, method: init.method, authorization: init.headers.Authorization });
    if (route === '/api/auth/change-password') return f.password ? f.password() : json({}, 200, { 'set-auth-token': 'synthetic-password' });
    if (route === '/api/auth/sign-in/email') return json({}, 200, { 'set-auth-token': 'synthetic-foreign' });
    if (route === '/api/auth/sign-out') return json({ success: true });
    if (route === '/api/auth/email-otp/request-email-change') return json({ success: true });
    if (route === '/api/auth/email-otp/change-email') {
      if (f.confirmation) return f.confirmation();
      f.settings.identity.email = 'server@example.invalid'; return json({ success: true });
    }
    if (route === '/v1/me') return f.read ? f.read() : json(f.account);
    if (route === '/v1/me/settings') return json(f.settings);
    if (route === '/v1/entitlements') return json({ accountId: f.account.accountId, grants: [], active: [] });
    assert.fail('Unexpected request: ' + route);
  });
  await f.api.restore();
  f.resources = new FormResources(f.api);
  const admission = captureAccountSecuritySession(f.resources, { accountId: 'original', sessionGeneration: 'original-generation',
    isOwnerCurrent: () => f.live, onForeignAuth() { f.foreign++; }, settings: () => f.settings,
    async returnToSettings(completion) {
      const acquired = await admission.reacquire();
      if (!acquired || !acquired.isCurrent()) return false;
      f.adopted.push({ account: acquired.account, settings: acquired.settings, entitlements: acquired.entitlements, completion });
      return true;
    },
  }, f.api.captureAuthContext());
  f.admission = admission; f.host = admission.host;
  f.open = kind => { f.host.open(kind); const flow = f.host.snapshot().flow; assert.ok(flow); return flow.controller; };
  f.mutations = () => f.calls.filter(call => call.method === 'POST' && call.path !== '/api/auth/sign-out');
  return f;
}

test('real transport originating replacement remains current; fresh one-use host completion reacquires under its signed bearer', async () => {
  const f = await fixture();
  try {
    const controller = f.open('password'); assert.equal(f.mutations().length, 0);
    await controller.submit('synthetic-current', password, password);
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(f.foreign, 0);
    f.account = { ...f.account, profile: { revision: 5 } };
    const returnCheckpoint = f.calls.length;
    f.host.complete(); f.host.complete(); await f.host.retryReturn();
    assert.equal(controller.snapshot().status, 'disposed'); assert.equal(f.adopted.length, 1);
    assert.equal(f.adopted[0].account.profile.revision, 5);
    assert.equal(f.adopted[0].completion.reason, 'password-changed');
    const returnedAccountRead = f.calls.slice(returnCheckpoint).find(call => call.path === '/v1/me');
    assert.ok(returnedAccountRead, 'Completion must reacquire the account after replacement');
    assert.equal(returnedAccountRead.authorization, 'Bearer synthetic-password');
    assert.equal(f.stored.at(-1), 'synthetic-password'); assert.equal(f.cleared, 0);
  } finally { f.admission.dispose(); }
});

test('pending departure disposes the controller immediately but shell port custody allows exactly one replacement and readback', async () => {
  const f = await fixture(), pending = gate();
  try {
    f.password = () => pending.promise;
    const controller = f.open('password'), command = controller.submit('synthetic-current', password, password);
    const departing = f.host.depart();
    assert.equal(controller.snapshot().status, 'disposed'); assert.equal(f.host.snapshot().status, 'returning');
    await controller.submit('synthetic-current', password, password); f.host.open('email');
    pending.resolve(json({}, 200, { 'set-auth-token': 'synthetic-password' }));
    await command; await departing;
    assert.equal(f.mutations().length, 1); assert.equal(f.adopted.length, 1); assert.equal(f.adopted[0].completion, null);
    assert.equal(f.cleared, 0);
  } finally { pending.resolve(json({ code: 'unavailable' }, 503)); f.admission.dispose(); }
});

test('known password failure corrects once; unknown never repeats and keeps the existing Keychain session', async () => {
  for (const unknown of [false, true]) {
    const f = await fixture();
    try {
      f.password = () => unknown ? Promise.reject(Error('Synthetic network')) : Promise.resolve(json({ code: 'INVALID_PASSWORD' }, 400));
      const controller = f.open('password'); await controller.submit('synthetic-current', password, password);
      assert.equal(controller.snapshot().status, unknown ? 'unknown' : 'failed');
      f.password = null; await controller.submit('synthetic-current', password, password);
      assert.equal(f.mutations().length, unknown ? 1 : 2);
      if (unknown) { await f.host.depart(); assert.equal(f.adopted[0].completion, null); }
      else { f.host.complete(); await f.host.retryReturn(); assert.equal(f.adopted[0].completion.reason, 'password-changed'); }
      assert.equal(f.cleared, 0);
    } finally { f.admission.dispose(); }
  }
});

test('email completion survives failed/foreign reads; only authoritative account/settings are adopted on a read retry', async () => {
  for (const invalid of ['failed', 'foreign']) {
    const f = await fixture();
    try {
      const controller = f.open('email'); await controller.requestCode('submitted@example.invalid', 'synthetic-current');
      await controller.confirm('12345678'); assert.equal(controller.snapshot().status, 'saved');
      f.read = async () => invalid === 'failed' ? json({ code: 'unavailable' }, 503) : json({ ...f.account, accountId: 'foreign' });
      f.host.complete(); await f.host.retryReturn();
      assert.equal(f.adopted.length, 0); assert.equal(f.host.snapshot().readFailed, true);
      f.read = null; await f.host.retryReturn();
      assert.equal(f.adopted.length, 1); assert.equal(f.adopted[0].completion.reason, 'email-changed');
      assert.equal(f.adopted[0].settings.identity.email, 'server@example.invalid');
      assert.notEqual(f.adopted[0].settings.identity.email, f.adopted[0].completion.newEmail);
      assert.equal(f.mutations().length, 2);
    } finally { f.admission.dispose(); }
  }
});

test('unknown email confirmation permits readback only and never manufactures a saved transition', async () => {
  const f = await fixture();
  try {
    f.confirmation = () => Promise.reject(Error('Synthetic unknown'));
    const controller = f.open('email'); await controller.requestCode('submitted@example.invalid', 'synthetic-current');
    await controller.confirm('12345678'); assert.equal(controller.snapshot().status, 'unknown');
    await controller.confirm('12345678'); f.host.complete(); f.host.open('password');
    assert.equal(f.mutations().length, 2); assert.equal(f.adopted.length, 0);
    await f.host.reconcile(); assert.equal(f.adopted.length, 1); assert.equal(f.adopted[0].completion, null);
    assert.equal(f.mutations().length, 2); assert.equal(f.cleared, 0);
  } finally { f.admission.dispose(); }
});

for (const loss of ['capability', 'identity', 'session', 'dispose', 'flow-switch']) test(loss + ' fences retained original commands', async () => {
  const f = await fixture();
  try {
    const controller = f.open('password');
    if (loss === 'capability') f.settings.capabilities.changePassword.supported = false;
    if (loss === 'identity') f.settings.identity.signInMethods = ['google'];
    if (loss === 'session') await f.api.signIn('synthetic@example.invalid', 'synthetic-foreign');
    if (loss === 'dispose') f.host.dispose();
    if (loss === 'flow-switch') f.host.open('email');
    await controller.submit('synthetic-current', password, password); f.host.complete();
    assert.equal(controller.snapshot().status, 'disposed'); assert.equal(f.adopted.length, 0);
    assert.equal(f.calls.filter(call => call.path === '/api/auth/change-password').length, 0);
  } finally { f.admission.dispose(); }
});

test('actual authenticated 401 invalidates the original host, while a foreign auth during readback cannot be adopted', async () => {
  for (const stage of ['401', 'readback']) {
    const f = await fixture(), read = gate();
    try {
      const controller = f.open('password');
      if (stage === '401') {
        f.password = async () => json({ code: 'unauthenticated' }, 401);
        await controller.submit('synthetic-current', password, password);
        assert.equal(controller.snapshot().status, 'disposed'); assert.equal(controller.transition(), null);
      } else {
        await controller.submit('synthetic-current', password, password);
        f.read = () => read.promise;
        f.host.complete();
        const returning = f.host.retryReturn();
        await f.api.signIn('synthetic@example.invalid', 'synthetic-foreign');
        read.resolve(json(f.account)); await returning;
        assert.equal(f.cleared, 0);
      }
      f.host.complete(); assert.equal(f.host.snapshot().status, 'disposed'); assert.equal(f.adopted.length, 0);
    } finally { read.resolve(json({ code: 'unavailable' }, 503)); f.admission.dispose(); }
  }
});
