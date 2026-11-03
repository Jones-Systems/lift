'use strict';
// Authored only; run in a separately admitted qualification stage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(scenario = 'rest-running', command = null) {
  const env = { EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW: scenario };
  const context = vm.createContext({ process: { env }, __DEV__: true, URLSearchParams,
    setInterval: () => assert.fail('Only injected timing may schedule'),
    fetch: () => assert.fail('No HTTP allowed') });
  const allowed = new Set(['integration/syntheticPreview/presentation.ts', 'integration/syntheticPreview/admission.ts',
    'integration/syntheticPreview/entry.ts', 'integration/syntheticPreview/fixtures.ts', 'features/training/source-rest.ts']);
  const cache = new Map(), loaded = [];
  function load(relative) {
    if (!path.extname(relative)) relative += '.ts';
    assert.ok(allowed.has(relative), `Unexpected runtime import: ${relative}`);
    if (cache.has(relative)) return cache.get(relative).exports;
    const module = { exports: {} }; cache.set(relative, module); loaded.push(relative);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
      fileName: relative, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: relative })(name => {
      assert.ok(name.startsWith('.'));
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), name)));
    }, module, module.exports);
    if (relative.endsWith('/fixtures.ts') && command) {
      const original = module.exports.previewFixture;
      module.exports.previewFixture = scenario => {
        const value = plain(original(scenario)); if (value.kind === 'com01') value.command = command;
        return module.exports.frozenPreviewCopy(value);
      };
    }
    return module.exports;
  }
  let now = 800000, wall = 900000, started = 0, view;
  const active = new Set(), retained = [];
  const timing = { now: () => now, wallNow: () => wall, subscribe(tick) {
    started++; active.add(tick); retained.push(tick); return () => active.delete(tick);
  } };
  const api = load('integration/syntheticPreview/presentation.ts');
  assert.equal(started, 0, 'Import must not schedule or admit');
  const presentation = api.createPreviewPresentation(next => { view = next; }, timing);
  return { presentation, env, context, loaded, active, retained, started: () => started, view: () => view,
    advance(ms) { now += ms; wall += ms; for (const tick of [...active]) tick(); },
    clocks(nextNow, nextWall) { now = nextNow; wall = nextWall; }, now: () => now, wall: () => wall };
}
function journey(f) {
  const list = f.view(); assert.equal(list.kind, 'groups');
  const id = list.props.groups.data[0].id;
  assert.equal(list.props.onSelectGroup(id).status, 'previewed');
  const members = f.view(); assert.equal(members.kind, 'members');
  return { list, members, id, target: '33333333-3333-4333-8333-333333333333' };
}
const ignored = (result, reason) => assert.deepEqual(plain(result), { status: 'ignored', reason });

test('all six fixtures map to the exact leaf props; stale stops at unavailable members', () => {
  for (const scenario of ['rest-running', 'rest-paused', 'com01-owner-current', 'com01-admin-current', 'com01-member-current', 'com01-stale']) {
    const f = fixture(scenario);
    if (scenario.startsWith('rest-')) {
      assert.equal(f.view().kind, 'rest'); assert.equal(f.view().props.rest.status, scenario.slice(5));
      assert.equal(f.view().props.rest.value.remainingMs, 67500);
      assert.deepEqual(plain(f.view().props.context.prescription), { rest_seconds: 90 });
      assert.equal(f.view().props.context.session.sessionRevision, 1); assert.equal(f.view().props.context.session.planRevision, 2);
    } else {
      const { members, target } = journey(f);
      if (scenario === 'com01-stale') {
        assert.equal(members.props.detail.status, 'stale'); assert.equal(members.props.detail.data, null);
        ignored(members.props.onSelectMember(target), 'not_current'); assert.equal(f.view(), members);
      } else {
        assert.equal(members.props.onSelectMember(target).status, 'previewed');
        const role = f.view(); assert.equal(role.kind, 'role');
        assert.deepEqual(plain(role.underlay.detail), plain(members.props.detail), 'Underlay retains the seen snapshot');
        assert.equal(role.props.roleState.status, scenario === 'com01-owner-current' ? 'current' : 'denied');
        assert.equal(role.props.roleState.subject.group.revision, 4);
        assert.equal(role.props.roleState.subject.target.revision, 9);
        assert.equal(role.underlay.detail.data.members[0].revision, 7);
      }
    }
    f.presentation.dispose(); assert.equal(f.active.size, 0);
  }
});

test('group, member, reload and role transitions expire original callbacks without changing domain revisions', () => {
  const f = fixture('com01-owner-current'); const { list, members, target, id } = journey(f);
  ignored(list.props.onSelectGroup(id), 'selection_changed');
  assert.equal(members.props.onSelectMember(target).status, 'previewed');
  ignored(members.props.onReloadFixture(), 'selection_changed');
  let role = f.view();
  const invoke = role.props.roleState.onPreviewRoleChange;
  const intent = { groupId: id, expectedGroupRevision: 4, memberId: target, expectedMemberRevision: 9, role: 'admin' };
  ignored(invoke({ ...intent, expectedMemberRevision: 7 }), 'stale_revision');
  ignored(invoke({ ...intent, expectedGroupRevision: 9 }), 'stale_revision');
  ignored(invoke({ ...intent, memberId: '22222222-2222-4222-8222-222222222222' }), 'selection_changed');
  assert.equal(invoke(intent).status, 'previewed');
  ignored(invoke(intent), 'selection_changed');
  role = f.view(); assert.equal(role.props.roleState.subject.target.role, 'member');
  assert.equal(role.props.roleState.subject.target.revision, 9);
  assert.equal(role.props.onReloadFixture().status, 'previewed');
  ignored(role.props.roleState.onPreviewRoleChange(intent), 'selection_changed');
  assert.equal(f.view().props.roleState.subject.target.role, 'member'); f.presentation.dispose();
});

test('reload requests the local fixture and preserves original command uncertainty', () => {
  const command = { status: 'error', kind: 'role', uncertainty: 'original',
    error: { code: 'community_forbidden', status: 403, effectUnknown: false, originalEffectUnknown: true } };
  const f = fixture('com01-owner-current', command); const { members, target } = journey(f);
  ignored(members.props.onSelectMember(target), 'command_unresolved');
  assert.equal(members.props.onReloadFixture().status, 'previewed');
  assert.deepEqual(plain(f.view().props.command), command); f.presentation.dispose();
});

test('one retained helper uses wall deadlines, exact pause remainder and a single resumed subscription', () => {
  const f = fixture(); const original = f.view();
  assert.equal(f.active.size, 1); assert.equal(f.started(), 1);
  f.advance(123.5); assert.equal(f.view().props.rest.value.remainingMs, 67376.5);
  assert.equal(f.started(), 1);
  const oldTick = f.retained[0], pause = f.view().props.rest.onPause;
  assert.equal(pause().status, 'previewed'); assert.equal(f.active.size, 0);
  const paused = f.view(); f.advance(10000); oldTick();
  assert.equal(f.view().props.rest.value.remainingMs, 67376.5);
  assert.equal(paused.props.rest.onResume().status, 'previewed');
  assert.equal(f.active.size, 1); assert.equal(f.started(), 2);
  ignored(original.props.rest.onPause(), 'selection_changed');
  oldTick(); assert.equal(f.view().props.rest.value.remainingMs, 67376.5);
  f.advance(67376.5); assert.equal(f.active.size, 0);
  assert.equal(f.view().props.rest.status, 'unavailable'); assert.equal(f.view().props.rest.reason, 'rest_finished');
  assert.equal(f.view().props.rest.onResume, undefined); f.presentation.dispose();
});

test('invalid or backward clocks close timing truthfully; failed resume is not automatically called a clock error', () => {
  for (const invalid of [NaN, -1, 799999]) {
    const f = fixture(); f.clocks(invalid, f.wall()); f.retained[0]();
    assert.equal(f.view().props.rest.status, 'unavailable');
    assert.equal(f.view().props.rest.reason, 'clock_unavailable'); assert.equal(f.active.size, 0); f.presentation.dispose();
  }
  const f = fixture('rest-paused'); assert.equal(f.active.size, 0);
  f.clocks(NaN, f.wall()); ignored(f.view().props.rest.onResume(), 'unsupported_state');
  assert.equal(f.view().props.rest.reason, 'unsupported_state'); assert.equal(f.active.size, 0); f.presentation.dispose();
});

test('close, unknown/background, session, presentation and selector replacement cannot revive retained handlers or ticks', () => {
  for (const end of ['close', 'leaveForeground', 'invalidateSession', 'invalidatePresentation', 'dispose', 'selector']) {
    const f = fixture(), props = f.view().props, tick = f.retained[0];
    if (end === 'close') props.onClose();
    else if (end === 'selector') { f.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = 'rest-paused'; tick(); }
    else f.presentation[end]();
    assert.equal(f.active.size, 0); assert.equal(f.view().kind, 'denied');
    const reason = f.view().reason; f.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = 'rest-running';
    tick(); ignored(props.rest.onPause(), reason); assert.equal(f.view().kind, 'denied');
    f.presentation.dispose();
  }
});
