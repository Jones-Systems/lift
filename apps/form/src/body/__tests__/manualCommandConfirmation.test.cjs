const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(join(__dirname, '..', 'manualCommandConfirmation.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => { throw new Error(`Unexpected runtime import ${name}`); }, mod, mod.exports);
const { validateManualCommandConfirmation: validates } = mod.exports;
const id = 'a16b2c30-4d50-4670-890a-bcdef0123456';
const make = (payload = {}) => ({ operation: 'save_manual_measurement', command: { key: 'synthetic', payload: {
  kind: 'waist', value: 80, unit: 'cm', measuredOn: '2026-10-11', ...payload,
} } });
const result = intent => { const p = intent.command.payload; return { id, kind: p.kind,
  value: p.value * (p.unit === 'in' ? 2.54 : p.unit === 'lb' ? 0.45359237 : 1), unit: p.kind === 'weight' ? 'kg' : 'cm',
  originalUnit: p.unit, measuredOn: p.measuredOn, note: p.note === undefined ? null : p.note.trim(), provenance: 'manual_reported' }; };

test('exact producer normalization for every kind/unit and optional trimmed note', () => {
  for (const kind of ['waist', 'hips', 'chest', 'thigh', 'upper_arm', 'weight']) {
    for (const unit of kind === 'weight' ? ['kg', 'lb'] : ['cm', 'in']) {
      for (const note of [undefined, '', '  ', ' trimmed ', 'x'.repeat(200)]) {
        const intent = make({ kind, unit, note, value: 13.7 }); assert.equal(validates(intent, result(intent)), true);
      }
    }
  }
});

test('producer input bounds, civil dates and note normalization cannot be substituted', () => {
  for (const payload of [{ value: 0 }, { value: -1 }, { value: 10000.01 }, { value: NaN }, { value: Infinity },
    { unit: 'kg' }, { kind: 'weight', unit: 'in' }, { kind: 'other' }, { measuredOn: '2026-02-29' },
    { measuredOn: '2026-13-01' }, { measuredOn: '2026-1-01' }, { note: null }, { note: 'x'.repeat(201) }]) {
    const intent = make(payload); const response = { ...result(make()), ...payload }; assert.equal(validates(intent, response), false);
  }
  for (const payload of [{ value: 10000 }, { measuredOn: '2024-02-29' }, { note: ` ${'x'.repeat(200)} ` }]) {
    const intent = make(payload); assert.equal(validates(intent, result(intent)), true);
  }
});

test('confirmation requires exact fields, UUID, original input and unrounded canonical result', () => {
  const intent = make({ unit: 'in', value: 13.7, note: ' trimmed ' }), response = result(intent);
  for (const change of [{ id: 'not-uuid' }, { kind: 'hips' }, { measuredOn: '2026-10-10' }, { originalUnit: 'cm' },
    { unit: 'kg' }, { value: Math.round(response.value * 100) / 100 }, { value: response.value + 1e-10 },
    { note: ' trimmed ' }, { note: null }, { provenance: 'inferred' }, { key: 'synthetic' }, { accountId: 'synthetic-a' }]) {
    assert.equal(validates(intent, { ...response, ...change }), false);
  }
  const missing = { ...response }; delete missing.note; assert.equal(validates(intent, missing), false);
  let accessed = false; const getter = { ...response };
  Object.defineProperty(getter, 'value', { enumerable: true, get() { accessed = true; return response.value; } });
  assert.equal(validates(intent, getter), false); assert.equal(accessed, false);
  assert.equal(validates(intent, Object.assign(Object.create({}), response)), false);
  assert.equal(validates(intent, { ...response, [Symbol('extra')]: true }), false);
  const badIntent = make(); Object.defineProperty(badIntent.command.payload, 'value', { enumerable: true, get() { accessed = true; return 80; } });
  assert.equal(validates(badIntent, result(make())), false); assert.equal(accessed, false);
});

test('delete proof qualifies exact original ID/key/empty payload and exact one-field response', () => {
  const intent = { operation: 'delete_assessment', command: { id, key: 'delete', payload: {} } };
  assert.equal(validates(intent, { deleted: true }), true);
  for (const response of [null, true, {}, { deleted: false }, { deleted: true, id }, { items: [] }]) assert.equal(validates(intent, response), false);
  for (const command of [{ ...intent.command, id: 'invalid' }, { ...intent.command, key: '' }, { ...intent.command, payload: { id } }, { ...intent.command, extra: true }]) {
    assert.equal(validates({ ...intent, command }, { deleted: true }), false);
  }
  const accessor = {}; Object.defineProperty(accessor, 'deleted', { enumerable: true, get() { throw new Error('must not read'); } });
  assert.equal(validates(intent, accessor), false);
});
