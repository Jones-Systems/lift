const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();
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
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { createActivitySession } = load('integration/activitySession.ts');
const key = () => 'be3d603c-1095-45c4-b5d4-e673fd67c324';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(request, generation = 'fresh-session-one', issueKey = key) {
  let current = true;
  const session = createActivitySession({ sessionGeneration: generation, isCurrentSession: () => current, api: { request } }, issueKey);
  return { session, expire: () => { current = false; } };
}
const changed = original => error => error.code === 'session_changed' && error.effectUnknown === false && error.originalEffectUnknown === original;

test('root Activity binding uses existing API and exact nullable calendar read', async () => {
  const calls = [];
  const { session } = fixture(async (...args) => { calls.push(args); return null; });
  assert.equal(await session.resources.calendar(), null);
  assert.deepEqual(calls, [['/v1/activity/calendar', 'GET', undefined, undefined]]);
  await session.dispose();
});
test('expired view cannot dispatch a mutation under a later token', async () => {
  let calls = 0;
  const { session, expire } = fixture(async () => { calls++; });
  expire();
  await assert.rejects(session.resources.createCalendar('America/New_York', key()), changed(false));
  assert.equal(calls, 0);
  await session.dispose();
});
test('late old-session read never releases private result', async () => {
  const pending = deferred();
  const { session, expire } = fixture(() => pending.promise);
  const result = session.resources.catalog();
  expire(); pending.resolve({ items: [{ private: 'synthetic-old-account' }] });
  await assert.rejects(result, changed(false));
  await session.dispose();
});
test('late mutation acknowledgment preserves original uncertainty without new-session retry', async () => {
  const pending = deferred();
  const { session, expire } = fixture(() => pending.promise);
  const result = session.resources.createCalendar('America/New_York', key());
  expire(); pending.resolve({ revision: 1 });
  await assert.rejects(result, changed(true));
  await session.dispose();
});
test('late mutation rejection also reserves the old operation outcome', async () => {
  const pending = deferred();
  const { session, expire } = fixture(() => pending.promise);
  const result = session.resources.createCalendar('America/New_York', key());
  expire(); pending.reject(new Error('synthetic connection loss'));
  await assert.rejects(result, changed(true));
  await session.dispose();
});
test('disposed resource aliases remain unusable and dispose is idempotent', async () => {
  let calls = 0;
  const { session } = fixture(async () => { calls++; return {}; });
  const resources = session.resources;
  await session.dispose(); await session.dispose();
  await assert.rejects(resources.capabilities(), changed(false));
  assert.equal(calls, 0);
  assert.equal(session.controller.getState().phase, 'cancelled');
});
test('background and disposal cancel the dedicated speech port without a network request', async () => {
  let cancels = 0, disposals = 0, calls = 0;
  const speech = { cancel: async () => { cancels++; }, dispose: async () => { disposals++; } };
  const session = createActivitySession({ sessionGeneration: 'speech-generation', isCurrentSession: () => true,
    api: { request: async () => { calls++; } } }, key, speech);
  await session.background(); await session.dispose(); await session.dispose();
  assert.equal(cancels, 2); assert.equal(disposals, 1); assert.equal(calls, 0);
});
test('new sign-in of the same account gets a separate controller and denies old view dispatch', async () => {
  let calls = 0;
  const api = async () => { calls++; return { items: [] }; };
  const old = fixture(api, 'same-account-session-one');
  old.expire();
  const next = fixture(api, 'same-account-session-two');
  await assert.rejects(old.session.resources.catalog(), changed(false));
  await next.session.resources.catalog();
  assert.equal(calls, 1);
  assert.notEqual(old.session.controller.getState().accountGeneration, next.session.controller.getState().accountGeneration);
  await old.session.dispose(); await next.session.dispose();
});

test('root session exposes only the dedicated Activity owner-input channel', async () => {
  let calls = 0, inspected = 0;
  const body = new Proxy({}, { get() { inspected++; throw new Error('payload_read'); },
    ownKeys() { inspected++; throw new Error('payload_clone'); } });
  const { session } = fixture(async () => { calls++; return {}; });
  for (const [route, method] of [['/v1/me/profile', 'PATCH'], ['/v1/body/operations/manual', 'POST'],
    ['/v1/activity/entries', 'DELETE'], ['/v1/activity/entries/../profile', 'POST']]) {
    await assert.rejects(session.resources.api.request(route, method, body, key()),
      error => error.code === 'activity_route_not_allowed');
  }
  assert.equal(calls, 0); assert.equal(inspected, 0);
  await session.dispose();
});

test('current session exposes the supplied secure command key issuer', async () => {
  let calls = 0;
  const issued = [key(), 'b72b62f0-699f-43c8-a848-dedac08b6a58'];
  const { session } = fixture(async () => {}, 'current-key-session', () => issued[calls++]);
  try {
    assert.equal(session.newSecureKey(), issued[0]);
    assert.equal(session.newSecureKey(), issued[1]);
    assert.equal(calls, 2);
  } finally { await session.dispose(); }
});

test('invalidated session rejects secure key issuance before consuming the issuer', async () => {
  let calls = 0;
  const { session, expire } = fixture(async () => {}, 'old-key-session', () => { calls++; return key(); });
  const issue = session.newSecureKey;
  try {
    assert.equal(issue(), key());
    expire();
    assert.throws(issue, changed(false));
    assert.throws(() => session.newSecureKey(), changed(false));
    assert.equal(calls, 1);
  } finally { await session.dispose(); }
});

test('disposed session rejects retained secure key issuers without consuming a key', async () => {
  let calls = 0;
  const { session } = fixture(async () => {}, 'disposed-key-session', () => { calls++; return key(); });
  const issue = session.newSecureKey;
  try {
    await session.dispose();
    assert.throws(issue, changed(false));
    assert.throws(() => session.newSecureKey(), changed(false));
    assert.equal(calls, 0);
  } finally { await session.dispose(); }
});
