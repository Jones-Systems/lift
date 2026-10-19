const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..'), modules = new Map();
function load(name) {
  const file = path.resolve(root, name);
  assert.ok(file.startsWith(root + path.sep));
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
    const resolved = path.resolve(path.dirname(file), name + '.ts');
    if (resolved === path.join(root, 'api/client.ts')) return { ...load('api/transport.ts'), formApi: null };
    return load(path.relative(root, resolved));
  }, module, module.exports);
  return module.exports;
}
const { FormResources } = load('api/resources.ts');
const { ApiError } = load('api/transport.ts');
const { captureAccountSession } = load('integration/accountSession.ts');
const { createActivitySession } = load('integration/activitySession.ts');
const changed = original => error => error.code === 'session_changed' && error.originalEffectUnknown === original;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(request = async () => ({})) {
  let authGeneration = 1, epoch = 1, mounted = true, accountId = 'account-one';
  const calls = [];
  const api = {
    captureAuthContext() { const captured = authGeneration; return { isCurrent: () => captured === authGeneration }; },
    request(...args) { calls.push(args); return request(...args); },
  };
  const base = new FormResources(api);
  const capture = () => {
    const originalEpoch = epoch, originalAccount = accountId;
    return captureAccountSession(base, { accountId, sessionGeneration: `shell:${epoch}`,
      isCurrentSession: () => mounted && epoch === originalEpoch && accountId === originalAccount });
  };
  return { api, calls, capture, session: capture(), replaceAuth: () => { authGeneration++; },
    replaceEpoch: () => { epoch++; }, switchAccount: () => { accountId = 'account-two'; },
    unmount: () => { mounted = false; } };
}

test('same-account replacement auth rejects retained plan, workout, history and settings ports before dispatch', async () => {
  const f = fixture();
  const old = f.session.resources;
  f.replaceAuth();
  for (const read of [old.plans, old.history, old.settings, () => old.workout('saved-workout')]) {
    await assert.rejects(read(), changed(false));
  }
  await assert.rejects(old.startWorkout({ id: 'plan-one', revision: 3 }, 'original-key'), changed(false));
  assert.equal(f.calls.length, 0);
  await f.capture().resources.history();
  assert.equal(f.calls.length, 1);
});

test('account, epoch and mounted lifetime independently expire the original view', async () => {
  for (const change of ['switchAccount', 'replaceEpoch', 'unmount']) {
    const f = fixture();
    f[change]();
    assert.equal(f.session.isCurrentSession(), false);
    await assert.rejects(f.session.resources.entitlements(), changed(false));
    assert.equal(f.calls.length, 0);
  }
});

test('a view cannot revive after its supplied currentness guard has expired', async () => {
  const f = fixture(); let current = true;
  const scope = { accountId: 'account-one', sessionGeneration: 'original', isCurrentSession: () => current };
  const session = captureAccountSession(new FormResources(f.api), scope);
  scope.accountId = 'replacement'; scope.sessionGeneration = 'replacement';
  current = false; assert.equal(session.isCurrentSession(), false);
  current = true;
  await assert.rejects(session.resources.plans(), changed(false));
  assert.equal(session.accountId, 'account-one'); assert.equal(session.sessionGeneration, 'original');
  assert.equal(f.calls.length, 0);
});

test('an acquisition guard cannot be replaced by the newer auth present when ready resources are composed', async () => {
  const f = fixture(), acquiredAuth = f.api.captureAuthContext();
  f.replaceAuth();
  const session = captureAccountSession(new FormResources(f.api), {
    accountId: 'account-one', sessionGeneration: 'acquired-session', isCurrentSession: () => true,
  }, acquiredAuth);
  assert.equal(session.isCurrentSession(), false);
  await assert.rejects(session.resources.settings(), changed(false));
  assert.equal(f.calls.length, 0);
});

test('late private reads are hidden and late workout writes preserve the original uncertain effect', async () => {
  for (const write of [false, true]) {
    const wait = deferred(), f = fixture(() => wait.promise);
    const pending = write ? f.session.resources.completeWorkout({ id: 'workout', revision: 2 }, 'complete-key')
      : f.session.resources.history();
    f.replaceAuth(); wait.resolve({ private: 'original-account' });
    await assert.rejects(pending, changed(write));
    assert.equal(f.calls.length, 1);
  }
});

test('same-session unknown command retry retains its resource, body and key; replacement cannot replay it', async () => {
  let attempts = 0;
  const f = fixture(async () => { if (++attempts === 1) throw new ApiError(0, 'network_error', 'Unknown', true); return { id: 'workout' }; });
  const resources = f.session.resources, plan = { id: 'saved-plan', revision: 4 };
  const retry = () => resources.startWorkout(plan, 'retained-workout-key');
  await assert.rejects(retry(), error => error.effectUnknown);
  assert.equal(f.session.resources, resources);
  assert.deepEqual(await retry(), { id: 'workout' });
  assert.deepEqual(f.calls[0], f.calls[1]);
  f.replaceEpoch(); await assert.rejects(retry(), changed(false));
  assert.equal(f.calls.length, 2);
});

test('Activity original auth independently blocks retained requests and secure key consumption', async () => {
  const f = fixture(); let issued = 0;
  const session = createActivitySession({ api: f.api, auth: f.api.captureAuthContext(),
    sessionGeneration: 'original', isCurrentSession: () => true }, () => `key-${++issued}`);
  try {
    assert.equal(session.newSecureKey(), 'key-1');
    f.replaceAuth();
    assert.throws(() => session.newSecureKey(), changed(false));
    await assert.rejects(session.resources.catalog(), changed(false));
    assert.equal(issued, 1); assert.equal(f.calls.length, 0);
  } finally { await session.dispose(); }
});

test('Activity late mutation rejection is fenced by original auth even if its view guard stays true', async () => {
  const wait = deferred(), f = fixture(() => wait.promise);
  const session = createActivitySession({ api: f.api, auth: f.api.captureAuthContext(),
    sessionGeneration: 'original', isCurrentSession: () => true }, () => 'calendar-key-original');
  try {
    const pending = session.resources.createCalendar('America/New_York', 'calendar-key-original');
    f.replaceAuth(); wait.reject(new Error('synthetic old connection loss'));
    await assert.rejects(pending, changed(true));
    assert.equal(f.calls.length, 1);
  } finally { await session.dispose(); }
});
