'use strict';
// Source-authored acceptance cases. Execution requires a separately admitted test stage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const cases = ['rest-running', 'rest-paused', 'com01-owner-current', 'com01-admin-current', 'com01-member-current', 'com01-stale'];

function fixture({ selector = 'com01-owner-current', dev = true, missingDev = false, search, corrupt } = {}) {
  let selectorValue = selector, reads = 0;
  const env = {};
  Object.defineProperty(env, 'EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW', { configurable: true, enumerable: true,
    get() { reads++; return selectorValue; }, set(value) { selectorValue = value; } });
  const context = vm.createContext({ process: { env }, URLSearchParams,
    ...(missingDev ? {} : { __DEV__: dev }),
    ...(search === undefined ? {} : { window: { location: { search } } }),
    fetch: () => assert.fail('No network is permitted'),
    setTimeout: () => assert.fail('No timer is permitted'),
    setInterval: () => assert.fail('No subscription is permitted'),
  });
  const cache = new Map(), loaded = [];
  function load(file) {
    assert.ok(['entry.ts', 'admission.ts', 'fixtures.ts'].includes(file), `Unexpected runtime import: ${file}`);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module); loaded.push(file);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename: file });
    run(name => { assert.ok(name.startsWith('./')); return load(name.slice(2) + '.ts'); }, module, module.exports);
    if (file === 'fixtures.ts' && corrupt) {
      const original = module.exports.previewFixture;
      module.exports.previewFixture = scenario => corrupt(plain(original(scenario)));
    }
    return module.exports;
  }
  const api = load('admission.ts');
  return { api, context, env, loaded, reads: () => reads, selection: load('entry.ts').readSyntheticPreviewSelection,
    open() {
      const entry = api.openSyntheticPreview();
      assert.equal(entry.admission.status, 'admitted');
      const binding = api.bindSyntheticPreview(entry.instance);
      assert.equal(binding.status, 'bound');
      return { entry, host: binding.host };
    },
  };
}

const intent = (overrides = {}) => ({ groupId: '11111111-1111-4111-8111-111111111111',
  expectedGroupRevision: 4, memberId: '33333333-3333-4333-8333-333333333333',
  expectedMemberRevision: 9, role: 'admin', ...overrides });
const ignored = (value, reason) => assert.deepEqual(plain(value), { status: 'ignored', reason });

test('imports perform no selection or admission; empty/unset selection is off even outside development', () => {
  const f = fixture();
  assert.equal(f.reads(), 0);
  f.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = '';
  assert.deepEqual(plain(f.selection()), { status: 'off' });
  for (const missingDev of [false, true]) for (const selector of ['', undefined]) {
    const off = fixture({ dev: false, missingDev });
    if (selector === undefined) delete off.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW;
    else off.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = selector;
    assert.deepEqual(plain(off.api.openSyntheticPreview()), { admission: { status: 'off' }, instance: null });
  }
});

test('selected release, unknown and nonboolean development globals are denied without a host', () => {
  for (const options of [{ dev: false }, { missingDev: true }, { dev: undefined, missingDev: true },
    { dev: null }, { dev: 1 }, { dev: 'true' }]) {
    const f = fixture(options), entry = f.api.openSyntheticPreview();
    assert.deepEqual(plain(entry), { admission: { status: 'denied', reason: 'release_or_unknown_build' }, instance: null });
    ignored(f.api.bindSyntheticPreview(entry.admission), 'foreign_identity');
  }
});

test('only six exact development selectors admit compiled fixtures, without loading runtime or views', () => {
  for (const selector of cases) {
    const f = fixture({ selector }), { entry, host } = f.open();
    const snapshot = host.snapshot();
    assert.equal(snapshot.status, 'current');
    assert.equal(snapshot.fixture.scenario, selector);
    assert.equal(entry.admission.fence.scenario, selector);
    assert.equal(snapshot.fixture.identity.authority, 'none');
    assert.equal(host.check().status, 'previewed');
    assert.deepEqual(f.loaded.sort(), ['admission.ts', 'entry.ts', 'fixtures.ts']);
    host.dispose();
  }
  for (const selector of ['rest-running ', 'REST-RUNNING', ' ', 'true', 'constructor', '__proto__', 'com01-owner', '?gallery=1']) {
    const f = fixture({ selector });
    assert.deepEqual(plain(f.api.openSyntheticPreview()), { admission: { status: 'denied', reason: 'unknown_case' }, instance: null });
  }
});

test('gallery conflict is read from the real entry global and never yields a preview instance', () => {
  const f = fixture({ search: '?gallery=1' });
  assert.deepEqual(plain(f.api.openSyntheticPreview()), { admission: { status: 'denied', reason: 'conflicting_entry' }, instance: null });
  assert.equal(fixture({ search: '?gallery=0' }).api.openSyntheticPreview().admission.status, 'admitted');
});

test('invalid compiled fixtures are denied; callers cannot inject admission options or a registry', () => {
  for (const corrupt of [() => null, value => { value.identity.accountId = 'foreign'; return value; },
    value => { value.detail.data.members.push(value.detail.data.members[0]); return value; }]) {
    const f = fixture({ corrupt });
    assert.deepEqual(plain(f.api.openSyntheticPreview()), { admission: { status: 'denied', reason: 'invalid_fixture' }, instance: null });
  }
  const f = fixture({ dev: false });
  assert.equal(f.api.openSyntheticPreview.length, 0);
  assert.equal(f.api.openSyntheticPreview({ isDev: true, scenario: 'rest-running', registry: {} }).admission.reason,
    'release_or_unknown_build');
});

test('fabricated admissions, public fences, foreign identities and copied instances cannot bind', () => {
  const f = fixture(), { entry, host } = f.open();
  for (const forged of [null, {}, plain(entry), entry.admission, plain(entry.admission), entry.admission.fence,
    { ...plain(entry.admission.fence), identity: { accountId: 'foreign' } }, { ...entry.instance }]) {
    ignored(f.api.bindSyntheticPreview(forged), 'foreign_identity');
  }
  const foreign = fixture().open();
  ignored(f.api.bindSyntheticPreview(foreign.entry.instance), 'foreign_identity');
  assert.equal(host.check().status, 'previewed');
});

test('snapshots are detached frozen provenance and repeated binding does not mint a new generation', () => {
  const f = fixture(), { entry, host } = f.open();
  const a = host.snapshot(), b = host.snapshot();
  assert.notEqual(a.fence, entry.admission.fence);
  assert.notEqual(a.fence.identity, a.fixture.identity);
  assert.notEqual(a.fixture.detail.data.members, b.fixture.detail.data.members);
  assert.ok(Object.isFrozen(a.fixture.detail.data.members[0]));
  assert.throws(() => { a.fixture.detail.data.members[0].role = 'member'; }, TypeError);
  const copied = plain(a); copied.fence.selectionGeneration++;
  copied.fixture.identity.accountId = 'foreign';
  assert.equal(host.check().status, 'previewed');
  const rebound = f.api.bindSyntheticPreview(entry.instance);
  assert.equal(rebound.host.snapshot().fence.sessionGeneration, a.fence.sessionGeneration);
});

test('only current owner-to-non-owner local role simulation accepts the original distinct revision tuple', () => {
  const { host } = fixture().open();
  for (const [overrides, reason] of [
    [{ expectedMemberRevision: 4 }, 'stale_revision'], [{ expectedMemberRevision: 7 }, 'stale_revision'],
    [{ expectedGroupRevision: 9 }, 'stale_revision'], [{ expectedMemberRevision: NaN }, 'stale_revision'],
    [{ memberId: '22222222-2222-4222-8222-222222222222' }, 'selection_changed'],
    [{ groupId: 'foreign' }, 'selection_changed'], [{ role: 'owner' }, 'role_not_eligible'],
  ]) ignored(host.previewRoleChange(intent(overrides)), reason);
  ignored(host.previewRoleChange({ ...intent(), extra: true }), 'invalid_fixture');
  assert.equal(host.snapshot().rolePreview, null);
  assert.deepEqual(plain(host.previewRoleChange(intent())), { status: 'previewed', effect: 'local-only' });
  const snapshot = host.snapshot();
  assert.deepEqual(plain(snapshot.rolePreview), { memberId: intent().memberId, role: 'admin' });
  assert.equal(snapshot.fixture.detail.data.members[1].role, 'member');
  assert.equal(snapshot.fixture.detail.data.members[1].revision, 9);
  for (const [selector, reason] of [['com01-admin-current', 'role_not_eligible'], ['com01-member-current', 'role_not_eligible'],
    ['com01-stale', 'not_current'], ['rest-running', 'unsupported_state']]) {
    ignored(fixture({ selector }).open().host.previewRoleChange(intent()), reason);
  }
});

test('session, renderer, selection, nonforeground, close and disposal invalidate synchronously and cannot revive', () => {
  for (const [hook, reason] of [['invalidateSession', 'session_changed'], ['invalidatePresentation', 'presentation_changed'],
    ['invalidateSelection', 'selection_changed'], ['leaveForeground', 'not_foreground'], ['close', 'not_current'], ['dispose', 'not_current']]) {
    const f = fixture(), { entry, host } = f.open();
    const captured = host.previewRoleChange;
    host.previewRoleChange(intent());
    host[hook]();
    ignored(host.check(), reason); ignored(host.snapshot(), reason); ignored(captured(intent()), reason);
    ignored(f.api.bindSyntheticPreview(entry.instance), reason);
    const next = f.open();
    assert.notEqual(next.entry.admission.fence.sessionGeneration, entry.admission.fence.sessionGeneration);
    assert.notEqual(next.entry.admission.fence.selectionGeneration, entry.admission.fence.selectionGeneration);
    ignored(captured(intent()), reason);
    host.close();
    assert.equal(next.host.check().status, 'previewed');
  }
});

test('scene change, same-scene replacement and trusted-state loss expire original callbacks permanently', () => {
  const f = fixture(), first = f.open();
  f.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = 'com01-admin-current';
  ignored(first.host.previewRoleChange(intent()), 'selection_changed');
  f.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = 'com01-owner-current';
  const second = f.open();
  ignored(first.host.check(), 'selection_changed');
  const third = f.open();
  ignored(second.host.check(), 'presentation_changed');
  assert.equal(third.host.check().status, 'previewed');
  for (const [change, restore, reason] of [
    [x => { x.context.__DEV__ = false; }, x => { x.context.__DEV__ = true; }, 'release_or_unknown_build'],
    [x => { delete x.context.__DEV__; }, x => { x.context.__DEV__ = true; }, 'release_or_unknown_build'],
    [x => { x.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = ''; }, x => { x.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = 'com01-owner-current'; }, 'not_current'],
    [x => { x.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = 'arbitrary'; }, x => { x.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = 'com01-owner-current'; }, 'unknown_case'],
    [x => { x.context.window = { location: { search: '?gallery=1' } }; }, x => { delete x.context.window; }, 'conflicting_entry'],
  ]) {
    const runtime = fixture(), original = runtime.open(); change(runtime);
    ignored(original.host.previewRoleChange(intent()), reason); restore(runtime);
    ignored(original.host.check(), reason);
    assert.equal(runtime.open().host.check().status, 'previewed');
  }
});

test('a lifecycle change while reading a local intent is rechecked immediately before mutation', () => {
  const { host } = fixture().open(), value = intent();
  Object.defineProperty(value, 'role', { enumerable: true, get() { host.leaveForeground(); return 'admin'; } });
  ignored(host.previewRoleChange(value), 'not_foreground');
  ignored(host.snapshot(), 'not_foreground');
});
