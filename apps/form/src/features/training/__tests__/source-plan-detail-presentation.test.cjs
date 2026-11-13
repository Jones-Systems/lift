const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');

function portable(file, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(resolve(__dirname, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(imports, name), 'Unexpected dependency: ' + name);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const transport = portable('../../../api/transport.ts');
const { decodePlan } = portable('../../../api/trainingCodec.ts', { './transport': transport });
const { sourcePlanSummaryRows, sourcePlanItemHeading, sourcePlanItemRows } = portable('../source-plan-detail/rows.ts');

function wire() {
  const item = id => ({ id, native: { exercise_id: 'unfamiliar_native_id', movement_pattern: 'source_pattern',
    role: 'source_role', sets: 3, rest_seconds: 45, rep_range: [6, 10], target_rir: 2,
    substituted_for: 'original_native_id', notes: ['  Exact note  ', '', 'Second unfamiliar note'] },
  registeredDomain: { exerciseId: 'registered_exercise', variantId: 'variant/private-pin',
    identity: { repository: 'synthetic/implementation', revision: 'source-pin', path: 'implementation/catalog.json',
      sha256: 'a'.repeat(64), nativeId: 'unfamiliar_native_id' },
    registration: { id: 'registration-pin', revision: 'registration-revision', digest: 'b'.repeat(64), bytes: 123 },
    recordDigest: 'c'.repeat(64) }, load: { kind: 'unspecified', basis: 'unknown' } });
  return { schema: 'form.source-prescription-plan/v1', id: 'saved_plan', revision: 0, name: 'Saved source plan',
    origin: { kind: 'form-adaptation', id: 'adaptation-pin', revision: 'adaptation-revision' },
    duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 }, items: [item('first'), item('second')],
    archived: false, createdAt: '2026-11-13T12:00:00Z', updatedAt: '2026-11-13T12:30:00Z' };
}

test('source prescription rows retain every native value, units, range and note order without changing the plan', () => {
  const plan = decodePlan(wire()), before = structuredClone(plan);
  assert.deepEqual(sourcePlanSummaryRows(plan), [
    { label: 'Status', detail: 'Saved' }, { label: 'Estimated duration', detail: '15–25 minutes (estimated)' },
    { label: 'Movements', detail: '2' },
  ]);
  assert.deepEqual(sourcePlanItemRows(plan.items[0]), [
    { label: 'Movement pattern', detail: 'source_pattern' }, { label: 'Role', detail: 'source_role' },
    { label: 'Sets', detail: '3' }, { label: 'Rep range', detail: '6–10 reps' }, { label: 'Rest', detail: '45 seconds' },
    { label: 'Target reps in reserve (RIR)', detail: '2' }, { label: 'Prescribed load', detail: 'Unspecified (basis unknown)' },
    { label: 'Substituted for exercise ID', detail: 'original_native_id' },
    { label: 'Note 1', detail: '  Exact note  ' }, { label: 'Note 2', detail: 'Empty note' },
    { label: 'Note 3', detail: 'Second unfamiliar note' },
  ]);
  assert.deepEqual(plan, before);
});

test('missing optionals stay unspecified while zero rest and RIR remain explicit valid values', () => {
  const input = wire();
  input.items[0].native = { exercise_id: 'unfamiliar_native_id', movement_pattern: 'unknown pattern', role: 'unknown role',
    sets: 1, rest_seconds: 0 };
  input.items[1].native = { ...input.items[0].native, target_rir: 0, rep_range: [1, 1], notes: [''] };
  const plan = decodePlan(input), rows = sourcePlanItemRows(plan.items[0]);
  assert.deepEqual(rows.slice(2), [
    { label: 'Sets', detail: '1' }, { label: 'Rep range', detail: 'Not specified' }, { label: 'Rest', detail: '0 seconds' },
    { label: 'Target reps in reserve (RIR)', detail: 'Not specified' },
    { label: 'Prescribed load', detail: 'Unspecified (basis unknown)' },
    { label: 'Substituted for exercise ID', detail: 'Not provided' }, { label: 'Notes', detail: 'Not provided' },
  ]);
  const explicit = sourcePlanItemRows(plan.items[1]);
  assert.deepEqual(explicit.find(row => row.label === 'Target reps in reserve (RIR)'), { label: 'Target reps in reserve (RIR)', detail: '0' });
  assert.deepEqual(explicit.find(row => row.label === 'Rep range'), { label: 'Rep range', detail: '1–1 reps' });
  assert.deepEqual(explicit.at(-1), { label: 'Note 1', detail: 'Empty note' });
});

test('codec-bound numeric limits and estimated duration never become precision, progress or a load target', () => {
  for (const [minutes, sets, reps, rest, rir] of [[5, 1, 1, 0, 0], [180, 20, 100, 10800, 100]]) {
    const input = wire(); input.duration.minMinutes = minutes; input.duration.maxMinutes = minutes;
    Object.assign(input.items[0].native, { sets, rep_range: [reps, reps], rest_seconds: rest, target_rir: rir });
    const plan = decodePlan(input), rows = sourcePlanItemRows(plan.items[0]);
    assert.equal(sourcePlanSummaryRows(plan)[1].detail, `${minutes} minutes (estimated)`);
    assert.equal(rows.find(row => row.label === 'Sets').detail, String(sets));
    assert.equal(rows.find(row => row.label === 'Rest').detail, `${rest} seconds`);
    assert.equal(rows.find(row => row.label === 'Target reps in reserve (RIR)').detail, String(rir));
    assert.equal(rows.find(row => row.label === 'Prescribed load').detail, 'Unspecified (basis unknown)');
    assert.doesNotMatch(JSON.stringify(rows), /kg|\blb\b|progress|completed|recommended/i);
  }
});

test('long unfamiliar values and duplicate exercises keep item identity, count and source order without leaking pins', () => {
  const input = wire();
  input.items[0].native.movement_pattern = 'Unfamiliar-pattern-'.repeat(10);
  input.items[0].native.role = 'Unfamiliar-role-'.repeat(10);
  input.items[0].native.notes = ['a'.repeat(4000), '   ', 'last'];
  input.archived = true;
  const plan = decodePlan(input), before = structuredClone(plan);
  const headings = plan.items.map(sourcePlanItemHeading), rows = plan.items.map(sourcePlanItemRows);
  assert.deepEqual(headings, ['1. Exercise ID: unfamiliar_native_id', '2. Exercise ID: unfamiliar_native_id']);
  assert.deepEqual(plan.items.map(item => item.id), ['first', 'second']);
  assert.equal(rows[0][0].detail, input.items[0].native.movement_pattern);
  assert.equal(rows[0][1].detail, input.items[0].native.role);
  assert.deepEqual(rows[0].slice(-3).map(row => row.detail), ['a'.repeat(4000), '   ', 'last']);
  assert.equal(sourcePlanSummaryRows(plan)[0].detail, 'Archived');
  const output = JSON.stringify([sourcePlanSummaryRows(plan), headings, rows]);
  for (const pin of ['synthetic/implementation', 'source-pin', 'implementation/catalog.json', 'variant/private-pin',
    'registration-pin', 'registration-revision', 'adaptation-pin', 'adaptation-revision', 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]) {
    assert.equal(output.includes(pin), false, pin);
  }
  assert.deepEqual(plan, before);
});
