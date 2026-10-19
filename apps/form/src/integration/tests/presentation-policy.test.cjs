const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const file = path.resolve(__dirname, '../presentationPolicy.ts');
const moduleValue = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('module', 'exports', code)(moduleValue, moduleValue.exports);
const { resolvePresentationPolicy } = moduleValue.exports;

test('system motion changes do not overwrite the saved independent long choice', () => {
  const preferences = Object.freeze({ appMode: 'advanced', mascot: 'baby', animationStyle: 'long' });
  assert.equal(resolvePresentationPolicy(preferences, true).effectiveAnimationStyle, 'static');
  assert.equal(resolvePresentationPolicy(preferences, null).effectiveAnimationStyle, 'static');
  const restored = resolvePresentationPolicy(preferences, false);
  assert.equal(restored.effectiveAnimationStyle, 'long');
  assert.equal(restored.savedAnimationStyle, 'long');
  assert.deepEqual(preferences, { appMode: 'advanced', mascot: 'baby', animationStyle: 'long' });
});

test('no mascot preserves mode, content motion choice and immediate result access', () => {
  for (const appMode of ['basic', 'advanced']) for (const animationStyle of ['short', 'long']) {
    const ordinary = resolvePresentationPolicy({ appMode, mascot: 'scholarly', animationStyle }, false);
    const none = resolvePresentationPolicy({ appMode, mascot: 'none', animationStyle }, false);
    assert.equal(none.mascotVisible, false);
    assert.equal(none.appMode, ordinary.appMode);
    assert.equal(none.effectiveAnimationStyle, ordinary.effectiveAnimationStyle);
    assert.equal(none.resultAccessDelayMs, ordinary.resultAccessDelayMs);
    assert.equal(none.resultAccessDelayMs, 0);
  }
});

test('switching accounts derives each policy from its own current preferences', () => {
  const first = resolvePresentationPolicy({ appMode: 'advanced', mascot: 'buff', animationStyle: 'long' }, false);
  const second = resolvePresentationPolicy({ appMode: 'basic', mascot: 'none', animationStyle: 'short' }, false);
  assert.equal(second.appMode, 'basic');
  assert.equal(second.mascotVisible, false);
  assert.equal(second.savedAnimationStyle, 'short');
  assert.equal(first.mascot, 'buff');
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(second));
});

test('fixture adult and unknown server choices cannot silently become saved defaults', () => {
  for (const preferences of [
    { appMode: 'basic', mascot: 'adult', animationStyle: 'short' },
    { appMode: 'basic', mascot: 'scholarly', animationStyle: 'automatic' },
    { appMode: 'local', mascot: 'scholarly', animationStyle: 'short' },
  ]) assert.throws(() => resolvePresentationPolicy(preferences, false), TypeError);
});
