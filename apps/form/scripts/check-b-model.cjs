'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '../src/variants/b');
const loaded = new Map();
const sources = {};

function load(filename) {
  const file = path.resolve(filename);
  assert(file.startsWith(root + path.sep), 'model import escaped its source cone');
  if (loaded.has(file)) return loaded.get(file).exports;
  const source = fs.readFileSync(file, 'utf8');
  sources[path.relative(root, file)] = crypto.createHash('sha256').update(source).digest('hex');
  const module = { exports: {} };
  loaded.set(file, module);
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const requireLocal = (id) => {
    assert(id.startsWith('.'), 'only local model inputs are allowed');
    return load(path.resolve(path.dirname(file), id + '.ts'));
  };
  vm.runInNewContext(output, { module, exports: module.exports, require: requireLocal }, { filename: file, timeout: 2000 });
  return module.exports;
}

const model = load(path.join(root, 'model.ts'));
const checks = [];
function check(name, predicate) {
  assert(predicate, name);
  checks.push({ name, status: 'pass' });
}
const reduce = model.reducer;
let state = model.initialState('workout');
check('ordinary entry records no sets', model.confirmedCount(state) === 0 && state.workout.status === 'ready');
state = reduce(state, { type: 'start-workout' });
check('cannot advance an unconfirmed set', reduce(state, { type: 'next' }).workout.setNumber === 1);
check('cannot save a zero-set workout', reduce(state, { type: 'finish-keep' }).finished === null);
const invalid = reduce(state, { type: 'edit', field: 'reps', value: 'invalid' });
check('invalid repetitions never create records', model.confirmedCount(reduce(invalid, { type: 'confirm-set' })) === 0);
state = reduce(state, { type: 'confirm-set' });
check('explicit confirmation creates exactly one record', model.confirmedCount(state) === 1);
check('duplicate confirmation is idempotent', model.confirmedCount(reduce(state, { type: 'confirm-set' })) === 1);
const guarded = reduce(state, { type: 'apply-plan' });
check('plan adaptation cannot discard confirmed work', guarded.planKey === state.planKey && model.confirmedCount(guarded) === 1);
const finished = reduce(state, { type: 'finish-keep' });
check('partial save preserves actual set count', finished.finished.status === 'partial' && finished.finished.confirmedSets.length === 1);
state = reduce(reduce(state, { type: 'next' }), { type: 'undo-set' });
check('undo removes the last confirmation and restores its editor', model.confirmedCount(state) === 0 && state.workout.setNumber === 1);
let plan = model.initialState('coach');
plan = reduce(plan, { type: 'apply-plan' });
check('short plan changes planned work without inventing records', model.planOf(plan).plannedSetCount === 7 && model.confirmedCount(plan) === 0);
plan = reduce(plan, { type: 'undo-plan' });
check('plan undo restores the full session', model.planOf(plan).plannedSetCount === 11 && model.confirmedCount(plan) === 0);
const output = { schema: 'form2-model-behavior/v1', direction: 'b', checks, sources, scope: 'Actual TypeScript model and generated inputs, transpiled in memory; UI and native behavior are separate.' };
fs.writeFileSync(path.resolve(__dirname, '../evidence/b-model-behavior-checks.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', checks: checks.length }));
