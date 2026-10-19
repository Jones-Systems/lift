const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const moduleValue = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../systemMotion.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('module', 'exports', code)(moduleValue, moduleValue.exports);
const { observeSystemMotion } = moduleValue.exports;
function fixture() {
  let listener, resolve, reject, removed = 0;
  const values = [];
  const port = {
    isReduceMotionEnabled: () => new Promise((yes, no) => { resolve = yes; reject = no; }),
    addEventListener(event, callback) {
      assert.equal(event, 'reduceMotionChanged'); listener = callback;
      return { remove() { removed++; } };
    },
  };
  const dispose = observeSystemMotion(port, value => values.push(value));
  return { values, dispose, emit: value => listener(value), resolve: value => resolve(value),
    reject: () => reject(new Error('native query unavailable')), removed: () => removed };
}
test('initial unknown state resolves from the system and later events remain live', async () => {
  const f = fixture(); assert.deepEqual(f.values, [null]);
  f.resolve(false); await Promise.resolve(); f.emit(true);
  assert.deepEqual(f.values, [null, false, true]); f.dispose();
  assert.equal(f.removed(), 1);
});
test('a stale initial query cannot undo a newer Reduce Motion event', async () => {
  const f = fixture(); f.emit(true); f.resolve(false); await Promise.resolve();
  assert.deepEqual(f.values, [null, true]); f.dispose();
});
test('unmount removes subscription and denies late query and retained event callbacks', async () => {
  const f = fixture(); f.dispose(); f.emit(false); f.resolve(false); await Promise.resolve();
  assert.deepEqual(f.values, [null]); assert.equal(f.removed(), 1);
});
test('failed initial query keeps the conservative state until a system event arrives', async () => {
  const f = fixture(); f.reject(); await Promise.resolve();
  assert.deepEqual(f.values, [null]); f.emit(false);
  assert.deepEqual(f.values, [null, false]); f.dispose();
});
