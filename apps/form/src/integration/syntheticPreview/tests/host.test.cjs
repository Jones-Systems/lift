'use strict';
// Source-authored component/lifecycle checks, UNRUN until separate EXE admission.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const app = path.resolve(__dirname, '../../../..');
const jsx = (type, props, key) => ({ type, props, key });
function fixture({ selector = '', dev = true, fonts = true, search = '', appState = 'active' } = {}) {
  let slots = [], cursor = 0, queued = [], states = [], now = 100000;
  const intervals = new Set(), retained = [], listeners = new Set(), cache = new Map(), loaded = [];
  const context = vm.createContext({ process: { env: { EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW: selector } },
    __DEV__: dev, URLSearchParams, window: { location: { search } },
    performance: { now: () => now }, Date: { now: () => now },
    setInterval(tick, delay) { assert.equal(delay, 250); intervals.add(tick); retained.push(tick); return tick; },
    clearInterval(tick) { intervals.delete(tick); }, fetch: () => assert.fail('No preview network') });
  const react = {
    lazy: load => ({ lazy: load }), Suspense: 'Suspense',
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = value; }]; },
    useLayoutEffect(setup, deps) { const i = cursor++, previous = slots[i];
      if (!previous || deps.some((v, n) => v !== previous.deps[n])) queued.push(() => {
        previous?.cleanup?.(); slots[i] = { deps, setup, cleanup: setup() };
      }); },
  };
  const native = { Platform: { OS: 'web' }, StyleSheet: { create: value => value },
    View: 'View', Text: 'Text', Modal: 'Modal', AppState: { currentState: appState,
      addEventListener(event, fn) { assert.equal(event, 'change'); listeners.add(fn); return { remove: () => listeners.delete(fn) }; } } };
  const mocks = { react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': native,
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
    'react-native-gesture-handler': { GestureHandlerRootView: 'GestureHandlerRootView' },
    'src/fonts.ts': { useFormFonts: () => fonts }, 'src/GalleryShell.tsx': { GalleryShell: 'GalleryShell' },
    'src/FormRuntime.tsx': { FormRuntime: 'FormRuntime' }, 'src/settings': { SettingsSlot: 'SettingsSlot' },
    'src/features/training': { TrainingSlot: 'TrainingSlot' },
    'src/features/training/source-ui/SourceWorkoutView.tsx': { SourceWorkoutView: 'SourceWorkoutView' },
    'src/community/group-ui/COM01GroupList.tsx': { COM01GroupList: 'COM01GroupList' },
    'src/community/group-ui/COM01Members.tsx': { COM01Members: 'COM01Members' },
    'src/community/group-ui/COM01RoleState.tsx': { COM01RoleState: 'COM01RoleState' } };
  const allowed = new Set(['App.tsx', 'src/integration/syntheticPreview/TrainingCommunityPreviewHost.tsx',
    'src/integration/syntheticPreview/presentation.ts', 'src/integration/syntheticPreview/entry.ts',
    'src/integration/syntheticPreview/admission.ts', 'src/integration/syntheticPreview/fixtures.ts',
    'src/features/training/source-rest.ts', 'src/community/group-ui/theme.ts']);
  function load(relative) {
    if (Object.hasOwn(mocks, relative)) { loaded.push(relative); return mocks[relative]; }
    if (!path.extname(relative)) relative = ['.ts', '.tsx'].map(ext => relative + ext).find(p => fs.existsSync(path.join(app, p)));
    if (Object.hasOwn(mocks, relative)) { loaded.push(relative); return mocks[relative]; }
    assert.ok(allowed.has(relative), `Unexpected preview runtime module: ${relative}`);
    if (cache.has(relative)) return cache.get(relative).exports;
    loaded.push(relative); const module = { exports: {} }; cache.set(relative, module);
    const code = ts.transpileModule(fs.readFileSync(path.join(app, relative), 'utf8'), { fileName: relative,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: relative })(name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      assert.ok(name.startsWith('.'), `Forbidden external runtime port: ${name}`);
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), name)));
    }, module, module.exports);
    return module.exports;
  }
  const render = Component => { cursor = 0; queued = []; return Component(); };
  return { load, loaded, intervals, retained, listeners, context,
    render, commit() { for (const run of queued) run(); queued = []; },
    replay() { for (const slot of slots) if (slot) { slot.cleanup?.(); slot.cleanup = slot.setup(); } },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
    state(value) { native.AppState.currentState = value; for (const listener of [...listeners]) listener(value); },
    advance(ms) { now += ms; for (const tick of [...intervals]) tick(); } };
}
function nodes(tree, found = []) {
  if (!tree || typeof tree !== 'object') return found;
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props), found);
  found.push(tree);
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) nodes(child, found);
  return found;
}

test('App keeps the exact off composition and capture/device frame, and does not read the preview selector before fonts', () => {
  const f = fixture({ search: '?capture=3&device=iphone-17-pro-max' });
  const tree = nodes(f.render(f.load('App.tsx').default));
  const runtime = tree.find(node => node.type === 'FormRuntime'); assert.ok(runtime);
  assert.equal(runtime.props.renderSettings({ marker: 1 }).type, 'SettingsSlot');
  assert.equal(runtime.props.renderHome({ marker: 1 }).type, 'TrainingSlot');
  assert.equal(tree.find(n => n.type === 'SafeAreaProvider').props.style[2].width, 440);
  assert.ok(!f.loaded.some(p => p.endsWith('/admission.ts') || p.includes('PreviewHost')));
  const gallery = fixture({ search: '?gallery=1' });
  assert.ok(nodes(gallery.render(gallery.load('App.tsx').default)).some(n => n.type === 'GalleryShell'));
  const cold = fixture({ selector: 'rest-running', fonts: false });
  Object.defineProperty(cold.context.process.env, 'EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW', {
    get() { assert.fail('Font-unready App must not read admission'); } });
  assert.ok(!nodes(cold.render(cold.load('App.tsx').default)).some(n => ['FormRuntime', 'GalleryShell'].includes(n.type)));
});

test('App selected denials never render runtime/gallery or load the lazy host; admitted selection loads it lazily', async () => {
  for (const options of [{ selector: 'rest-running', dev: false }, { selector: 'arbitrary' },
    { selector: 'rest-paused', search: '?gallery=1' }]) {
    const f = fixture(options), tree = nodes(f.render(f.load('App.tsx').default));
    assert.ok(tree.some(n => n.props?.testID === 'synthetic-preview-denial'));
    assert.ok(!tree.some(n => ['FormRuntime', 'GalleryShell'].includes(n.type)));
    assert.ok(!f.loaded.some(p => p.includes('PreviewHost')));
  }
  const f = fixture({ selector: 'rest-running' }), tree = nodes(f.render(f.load('App.tsx').default));
  assert.ok(!tree.some(n => ['FormRuntime', 'GalleryShell'].includes(n.type)));
  assert.equal(f.intervals.size, 0); assert.ok(!f.loaded.some(p => p.includes('PreviewHost')));
  const lazy = tree.find(n => n.type?.lazy); assert.ok(lazy);
  await lazy.type.lazy(); assert.ok(f.loaded.some(p => p.includes('PreviewHost')));
  assert.equal(f.intervals.size, 0, 'Lazy module import is effect-free');
});

test('host binds only in commit and StrictMode cleanup/replay expires old callbacks with one subscription', () => {
  const f = fixture({ selector: 'rest-running' });
  const Host = f.load('src/integration/syntheticPreview/TrainingCommunityPreviewHost.tsx').default;
  f.render(Host); assert.equal(f.intervals.size, 0); assert.equal(f.listeners.size, 0);
  f.commit();
  let tree = nodes(f.render(Host)); const old = tree.find(n => n.type === 'SourceWorkoutView').props;
  const oldTick = f.retained[0]; assert.equal(f.intervals.size, 1); assert.equal(f.listeners.size, 1);
  f.replay(); tree = nodes(f.render(Host));
  assert.equal(f.intervals.size, 1); assert.equal(f.listeners.size, 1);
  assert.equal(old.rest.onPause().status, 'ignored'); oldTick();
  assert.equal(tree.find(n => n.type === 'SourceWorkoutView').props.rest.status, 'running');
  f.advance(250); f.render(Host); assert.equal(f.intervals.size, 1);
  f.dispose(); assert.equal(f.intervals.size, 0); assert.equal(f.listeners.size, 0);
  oldTick(); assert.equal(old.rest.onPause().status, 'ignored');
});

test('unknown/non-active AppState permanently closes; foreground re-entry never reopens', () => {
  for (const state of [null, 'unknown', 'inactive', 'background']) {
    const f = fixture({ selector: 'rest-running', appState: state });
    const Host = f.load('src/integration/syntheticPreview/TrainingCommunityPreviewHost.tsx').default;
    f.render(Host); f.commit(); assert.equal(f.intervals.size, 0);
    f.state('active'); assert.ok(nodes(f.render(Host)).some(n => n.props?.testID === 'synthetic-preview-denial')); f.dispose();
  }
  const f = fixture({ selector: 'rest-running' }); const Host = f.load('src/integration/syntheticPreview/TrainingCommunityPreviewHost.tsx').default;
  f.render(Host); f.commit(); const oldTick = f.retained[0];
  f.state('background'); assert.equal(f.intervals.size, 0); f.state('active'); oldTick();
  assert.ok(nodes(f.render(Host)).some(n => n.props?.testID === 'synthetic-preview-denial')); f.dispose();
});

test('role uses only the retained seen member underlay, native dismissal closes the entire preview', () => {
  const f = fixture({ selector: 'com01-owner-current' });
  const Host = f.load('src/integration/syntheticPreview/TrainingCommunityPreviewHost.tsx').default;
  f.render(Host); f.commit();
  let tree = nodes(f.render(Host)), list = tree.find(n => n.type === 'COM01GroupList');
  list.props.onSelectGroup(list.props.groups.data[0].id);
  tree = nodes(f.render(Host)); const members = tree.find(n => n.type === 'COM01Members');
  members.props.onSelectMember(members.props.detail.data.members[1].memberId);
  tree = nodes(f.render(Host)); const modal = tree.find(n => n.type === 'Modal');
  assert.equal(modal.props.presentationStyle, 'pageSheet'); assert.equal(modal.props.allowSwipeDismissal, true);
  assert.ok(tree.some(n => n.props?.pointerEvents === 'none' && n.props.accessibilityElementsHidden && n.props.importantForAccessibility === 'no-hide-descendants'));
  assert.deepEqual(JSON.parse(JSON.stringify(tree.find(n => n.type === 'COM01Members').props.detail)), JSON.parse(JSON.stringify(members.props.detail)));
  modal.props.onRequestClose(); assert.ok(nodes(f.render(Host)).some(n => n.props?.testID === 'synthetic-preview-denial'));
  f.dispose(); assert.equal(f.listeners.size, 0);
});

test('host independently rechecks trusted admission and selection replacement before exposing new props', () => {
  const revoked = fixture({ selector: 'rest-running' });
  const RevokedHost = revoked.load('src/integration/syntheticPreview/TrainingCommunityPreviewHost.tsx').default;
  revoked.context.__DEV__ = false;
  revoked.render(RevokedHost); revoked.commit();
  assert.equal(revoked.intervals.size, 0);
  assert.ok(nodes(revoked.render(RevokedHost)).some(n => n.props?.testID === 'synthetic-preview-denial'));
  revoked.dispose();
  const f = fixture({ selector: 'rest-running' });
  const Host = f.load('src/integration/syntheticPreview/TrainingCommunityPreviewHost.tsx').default;
  f.render(Host); f.commit();
  const old = nodes(f.render(Host)).find(n => n.type === 'SourceWorkoutView').props;
  const tick = f.retained[0];
  f.context.process.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = 'com01-owner-current';
  const pending = nodes(f.render(Host));
  assert.ok(!pending.some(n => ['SourceWorkoutView', 'COM01GroupList'].includes(n.type)));
  f.commit(); assert.equal(f.intervals.size, 0);
  assert.ok(nodes(f.render(Host)).some(n => n.type === 'COM01GroupList'));
  tick(); assert.equal(old.rest.onPause().status, 'ignored');
  f.context.process.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW = 'rest-running';
  f.render(Host); f.commit();
  assert.equal(f.intervals.size, 1); tick(); assert.equal(old.rest.onPause().status, 'ignored');
  f.dispose(); assert.equal(f.intervals.size, 0); assert.equal(f.listeners.size, 0);
});
