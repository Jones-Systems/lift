const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');

const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };
function sourceFunction(relative, name, dependencies) {
  const file = resolve(__dirname, '..', relative);
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(declarations.length, 1, `One actual ${name} declaration exists`);
  // Compile the unchanged private function text in memory; this adds no production export or copied implementation.
  const compiled = ts.transpileModule(declarations[0].getText(source), { compilerOptions: options }).outputText;
  return new Function(...Object.keys(dependencies), 'exports', `${compiled}\nreturn ${name};`)(...Object.values(dependencies), {});
}
const transport = { exports: {} };
const compiledTransport = ts.transpileModule(readFileSync(resolve(__dirname, '../../../api/transport.ts'), 'utf8'),
  { compilerOptions: options }).outputText;
new Function('require', 'module', 'exports', compiledTransport)(name => { throw new Error(`Unexpected import: ${name}`); }, transport, transport.exports);
const { ApiError } = transport.exports;
const toServerError = sourceFunction('model.ts', 'toServerError', { ApiError });
const drain = () => new Promise(resolve => setImmediate(resolve));
const preferences = (id, revision = 1) => ({ exerciseId: id, revision, order: [], hidden: [], availableCues: [] });

function fixture() {
  const slots = []; const requests = []; let cursor = 0; let effects = []; let writes = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, next => { writes++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++; const previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
      }
    },
  };
  const useCues = sourceFunction('WorkoutScreen.tsx', 'useCues', { ...react, toServerError });
  const resources = { cues(id) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    requests.push({ id, resolve, reject }); return promise;
  } };
  return {
    requests, writes: () => writes,
    read(id) {
      cursor = 0; effects = [];
      const result = useCues(resources, id);
      for (const effect of effects) effect();
      return result;
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('pending A to B to A refetches A and ignores its cancelled response', async () => {
  for (const late of ['success', 'failure']) {
    const f = fixture();
    try {
      f.read('a'); f.read('a'); assert.equal(f.requests.length, 1);
      f.read('b'); f.read('a');
      assert.deepEqual(f.requests.map(request => request.id), ['a', 'b', 'a']);
      if (late === 'success') f.requests[0].resolve(preferences('a', 1));
      else f.requests[0].reject(new ApiError(0, 'network_unavailable', 'Late failure'));
      await drain(); assert.equal(f.read('a').status, 'loading');
      const fresh = preferences('a', 2);
      f.requests[2].resolve(fresh); await drain();
      assert.equal(f.read('a').status, 'ready'); assert.deepEqual(f.read('a').value, fresh);
      f.requests[1].resolve(preferences('b')); await drain();
      assert.deepEqual(f.read('a').value, fresh); assert.equal(f.requests.length, 3);
    } finally {
      f.unmount(); for (const request of f.requests) request.resolve(preferences(request.id)); await drain();
    }
  }
});

test('settled cue preferences stay cached and null focus performs no request', async () => {
  const f = fixture();
  try {
    assert.equal(f.read(null).status, 'loading'); assert.equal(f.requests.length, 0);
    f.read('a'); const value = preferences('a'); f.requests[0].resolve(value); await drain();
    assert.deepEqual(f.read('a').value, value);
    assert.equal(f.read(null).status, 'loading');
    assert.deepEqual(f.read('a').value, value); assert.equal(f.requests.length, 1);
  } finally { f.unmount(); }
});

test('unmount suppresses late cue success and failure callbacks', async () => {
  for (const late of ['success', 'failure']) {
    const f = fixture(); f.read('a'); f.unmount(); const writes = f.writes();
    if (late === 'success') f.requests[0].resolve(preferences('a'));
    else f.requests[0].reject(new ApiError(0, 'network_unavailable', 'Late failure'));
    await drain(); assert.equal(f.writes(), writes);
  }
});
