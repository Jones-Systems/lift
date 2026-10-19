const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../../..'), cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative);
  assert.ok(file.startsWith(root + path.sep));
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
const { BugIntakeResources, canonicalBugReport } = load('api/bugIntake.ts');
const { createBugIntakeSession } = load('features/bug-intake/session.ts');
const { ApiError } = load('api/transport.ts');
const id = '12345678-1234-4123-8123-123456789abc';
const otherId = '22345678-1234-4123-8123-123456789abc';
const input = () => ({ title: 'Start button does nothing', description: 'Tap Start on the workout screen.' });
const report = (payload = input(), overrides = {}) => ({ ...canonicalBugReport(payload), id, state: 'received', createdAt: '2026-10-11T12:00:00.000Z', ...overrides });
const receipt = (payload = input(), overrides = {}) => ({ report: report(payload), replayed: false, duplicate: false, ...overrides });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(response = async (_path, _method, body) => receipt(body)) {
  const calls = [], observers = new Set(), state = { current: true, auth: 0, issuedKeys: 0 };
  const api = {
    captureAuthContext() { const epoch = state.auth; return { isCurrent: () => state.auth === epoch }; },
    subscribeAuthChanges(observer) { observers.add(observer); return { remove() { observers.delete(observer); } }; },
    async request(...args) { calls.push(args); return response(...args); },
  };
  const resources = new BugIntakeResources(api, () => state.current);
  const session = createBugIntakeSession({ sessionGeneration: 'synthetic-account-generation-1', isCurrentSession: () => state.current, api },
    () => `synthetic-key-${++state.issuedKeys}`);
  return { api, calls, state, resources, session, controller: session.controller, observers,
    changeAuth() { state.auth++; for (const observer of observers) observer(); },
    close() { resources.dispose(); session.dispose(); },
  };
}
module.exports = { load, ApiError, id, otherId, input, report, receipt, deferred, fixture };
