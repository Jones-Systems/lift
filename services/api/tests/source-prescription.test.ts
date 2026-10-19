import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nativePrescription, sourcePrescriptionItem, sourcePrescriptionPlanFields,
  planItem, planFields, planPatch,
  type NativePrescription, type SourcePrescriptionItem, type SourcePrescriptionPlanFields,
} from '../src/schemas.js';

function native(): NativePrescription {
  return { exercise_id: 'native-squat', movement_pattern: ' squat ', role: 'source-defined role', sets: 2, rest_seconds: 60 };
}
function item(id = 'item_1'): SourcePrescriptionItem {
  return {
    id, native: native(),
    registeredDomain: {
      exerciseId: 'domain_registered_squat', variantId: 'source:variant/squat',
      identity: { repository: 'synthetic/repository', revision: 'synthetic-revision', path: 'data/catalog.json', sha256: 'a'.repeat(64), nativeId: 'native-squat' },
      registration: { id: 'synthetic-registration', revision: 'synthetic-v1', digest: 'b'.repeat(64), bytes: 123 },
      recordDigest: 'c'.repeat(64),
    },
    load: { kind: 'unspecified', basis: 'unknown' },
  };
}
function plan(): SourcePrescriptionPlanFields {
  return {
    schema: 'form.source-prescription-plan/v1', name: 'Synthetic Form adaptation',
    origin: { kind: 'form-adaptation', id: 'synthetic-recipe', revision: 'synthetic-v1' },
    duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 },
    items: Array.from({ length: 4 }, (_, index) => item(`item_${index + 1}`)),
  };
}

test('native prescription roundtrip preserves all supplied values and ordered notes without normalization', () => {
  const input: NativePrescription = { ...native(), role: ' novel role ', rep_range: [6, 10], target_rir: 0, substituted_for: 'native-original', notes: [' second ', '', 'first', ' second '] };
  const parsed = nativePrescription.parse(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(parsed, input);
  assert.equal(JSON.stringify(parsed), JSON.stringify(input));
  assert.notEqual(parsed.notes, input.notes);
});

test('optional native fields preserve omission and explicit values while rejecting null', () => {
  const parsed = nativePrescription.parse(native());
  for (const key of ['rep_range', 'target_rir', 'substituted_for', 'notes']) {
    assert.equal(Object.hasOwn(parsed, key), false);
    assert.equal(nativePrescription.safeParse({ ...native(), [key]: null }).success, false, key);
    const presentUndefined = { ...native(), [key]: undefined };
    assert.equal(Object.hasOwn(presentUndefined, key), true);
    assert.equal(nativePrescription.safeParse(presentUndefined).success, false, key);
  }
  const supplied = nativePrescription.parse({ ...native(), rep_range: [1, 1], target_rir: 0, substituted_for: 'original', notes: [''] });
  assert.deepEqual(supplied.notes, ['']);
  assert.equal(supplied.target_rir, 0);
  assert.equal(nativePrescription.safeParse({ ...native(), notes: [] }).success, false);
});

test('required native fields are present and closed without inventing role or movement enums', () => {
  for (const key of Object.keys(native())) {
    const input: Record<string, unknown> = { ...native() }; delete input[key];
    assert.equal(nativePrescription.safeParse(input).success, false, key);
    assert.equal(nativePrescription.safeParse({ ...native(), [key]: null }).success, false, key);
  }
  assert.equal(nativePrescription.safeParse({ ...native(), clinicalClearance: true }).success, false);
  for (const key of ['role', 'movement_pattern']) {
    for (const value of ['', ' \t\n ', 'x'.repeat(201), 5]) assert.equal(nativePrescription.safeParse({ ...native(), [key]: value }).success, false);
    for (const value of ['x', 'x'.repeat(200), ' arbitrary source phrase ']) assert.equal(nativePrescription.safeParse({ ...native(), [key]: value }).success, true);
  }
});

test('native integer capacities accept endpoints and reject fractions, nonfinite and out-of-range values', () => {
  for (const [key, min, max] of [['sets', 1, 20], ['rest_seconds', 0, 10800], ['target_rir', 0, 100]] as const) {
    for (const value of [min, max]) assert.equal(nativePrescription.safeParse({ ...native(), [key]: value }).success, true, `${key}:${value}`);
    for (const value of [min - 1, max + 1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
      assert.equal(nativePrescription.safeParse({ ...native(), [key]: value }).success, false, `${key}:${value}`);
    }
  }
});

test('repetition range is exactly two ordered safe integers without coercion', () => {
  for (const value of [[1, 100], [1, 1], [100, 100]]) assert.equal(nativePrescription.safeParse({ ...native(), rep_range: value }).success, true);
  for (const value of [[], [1], [1, 2, 3], [0, 2], [1, 101], [5, 4], [1.5, 2], [1, Infinity], [NaN, 2], ['1', 2], { min: 1, max: 2 }]) {
    assert.equal(nativePrescription.safeParse({ ...native(), rep_range: value }).success, false);
  }
});

test('native IDs and notes retain their exact representation within mechanical capacities', () => {
  for (const key of ['exercise_id', 'substituted_for']) {
    for (const value of ['x', 'x'.repeat(80), 'A_b-1']) assert.equal(nativePrescription.safeParse({ ...native(), [key]: value }).success, true);
    for (const value of ['', 'x'.repeat(81), ' native-id', 'native/id', 1]) assert.equal(nativePrescription.safeParse({ ...native(), [key]: value }).success, false);
  }
  for (const notes of [[''], ['x'.repeat(4000)], Array.from({ length: 30 }, () => ' note ')]) assert.deepEqual(nativePrescription.parse({ ...native(), notes }).notes, notes);
  for (const notes of [[], ['x'.repeat(4001)], Array(31).fill('x'), [null], [1], 'note']) assert.equal(nativePrescription.safeParse({ ...native(), notes }).success, false);
});

test('registered mapping keeps Domain ID separate and binds only the supplied native identity', () => {
  const input = item();
  assert.notEqual(input.native.exercise_id, input.registeredDomain.exerciseId);
  assert.deepEqual(sourcePrescriptionItem.parse(input), input);
  input.registeredDomain.identity.nativeId = 'other-native';
  assert.equal(sourcePrescriptionItem.safeParse(input).success, false);
  input.native.exercise_id = 'other-native';
  assert.deepEqual(sourcePrescriptionItem.parse(input), input);
});

test('item and registered Domain IDs use the existing resource bounds without native-ID equivalence', () => {
  for (const value of ['x', 'x'.repeat(80), 'A_b-1']) {
    const input = item(value); input.registeredDomain.exerciseId = value;
    assert.deepEqual(sourcePrescriptionItem.parse(input), input);
  }
  for (const value of ['', 'x'.repeat(81), ' padded', 'domain/id', null, 1]) {
    const input = item();
    assert.equal(sourcePrescriptionItem.safeParse({ ...input, id: value }).success, false);
    assert.equal(sourcePrescriptionItem.safeParse({ ...input, registeredDomain: { ...input.registeredDomain, exerciseId: value } }).success, false);
    assert.equal(sourcePrescriptionItem.safeParse({ ...input, registeredDomain: { ...input.registeredDomain, identity: { ...input.registeredDomain.identity, nativeId: value } } }).success, false);
  }
});

test('source references reject normalization and controls with exact 512-character capacities', () => {
  const setters: Array<(input: SourcePrescriptionPlanFields, value: string) => void> = [
    (p, v) => { p.origin.id = v; }, (p, v) => { p.origin.revision = v; },
    (p, v) => { p.items[0]!.registeredDomain.variantId = v; },
    (p, v) => { p.items[0]!.registeredDomain.identity.repository = v; },
    (p, v) => { p.items[0]!.registeredDomain.identity.revision = v; },
    (p, v) => { p.items[0]!.registeredDomain.identity.path = v; },
    (p, v) => { p.items[0]!.registeredDomain.registration.id = v; },
    (p, v) => { p.items[0]!.registeredDomain.registration.revision = v; },
  ];
  for (const set of setters) {
    for (const value of ['x', 'x'.repeat(512), 'exact internal space']) { const input = plan(); set(input, value); assert.deepEqual(sourcePrescriptionPlanFields.parse(input), input); }
    for (const value of ['', 'x'.repeat(513), ' padded', 'padded ', '\tvalue', 'value\n', ...Array.from({ length: 32 }, (_, code) => `a${String.fromCharCode(code)}b`), 'a\u007fb']) {
      const input = plan(); set(input, value); assert.equal(sourcePrescriptionPlanFields.safeParse(input).success, false);
    }
  }
});

test('association digests and registration byte count reject malformed or unsafe representations', () => {
  for (const value of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '', null, 1]) {
    const input = item();
    for (const registeredDomain of [
      { ...input.registeredDomain, recordDigest: value },
      { ...input.registeredDomain, identity: { ...input.registeredDomain.identity, sha256: value } },
      { ...input.registeredDomain, registration: { ...input.registeredDomain.registration, digest: value } },
    ]) assert.equal(sourcePrescriptionItem.safeParse({ ...input, registeredDomain }).success, false);
  }
  for (const bytes of [1, Number.MAX_SAFE_INTEGER]) { const input = item(); input.registeredDomain.registration.bytes = bytes; assert.deepEqual(sourcePrescriptionItem.parse(input), input); }
  for (const bytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, null, '1']) {
    const input = item(); assert.equal(sourcePrescriptionItem.safeParse({ ...input, registeredDomain: { ...input.registeredDomain, registration: { ...input.registeredDomain.registration, bytes } } }).success, false);
  }
});

test('new plan and every nested object reject unknown properties and nullable substitutions', () => {
  const p = plan(), i = p.items[0]!;
  const changes: unknown[] = [
    { ...p, extra: true }, { ...p, schema: 'other' }, { ...p, origin: { ...p.origin, extra: true } },
    { ...p, duration: { ...p.duration, extra: true } },
    { ...p, origin: { ...p.origin, kind: 'clinical-prescription' } },
    { ...p, duration: { ...p.duration, kind: 'exact' } },
    ...['origin', 'duration', 'items', 'name'].map(key => ({ ...p, [key]: null })),
    ...[
      { ...i, extra: true }, { ...i, native: { ...i.native, extra: true } },
      { ...i, registeredDomain: { ...i.registeredDomain, extra: true } },
      { ...i, registeredDomain: { ...i.registeredDomain, identity: { ...i.registeredDomain.identity, extra: true } } },
      { ...i, registeredDomain: { ...i.registeredDomain, registration: { ...i.registeredDomain.registration, extra: true } } },
      { ...i, load: { ...i.load, targetKg: 0 } }, { ...i, load: { kind: 'specified', basis: 'kg' } },
      ...['native', 'registeredDomain', 'load'].map(key => ({ ...i, [key]: null })),
    ].map(value => ({ ...p, items: [value] })),
  ];
  for (const input of changes) assert.equal(sourcePrescriptionPlanFields.safeParse(input).success, false);
});

test('synthetic four-item adaptation preserves range, ordered items and unknown load without legacy projection', () => {
  const input = plan(); input.items[2]!.native.notes = ['later', '', 'earlier'];
  const parsed = sourcePrescriptionPlanFields.parse(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(parsed, input);
  assert.deepEqual(parsed.duration, { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 });
  assert.deepEqual(parsed.items.map(value => value.id), ['item_1', 'item_2', 'item_3', 'item_4']);
  for (const value of parsed.items) { assert.deepEqual(value.load, { kind: 'unspecified', basis: 'unknown' }); assert.equal(Object.hasOwn(value, 'targetKg'), false); }
  assert.equal(Object.hasOwn(parsed, 'minutes'), false);
});

test('new plan range, name and unique item limits accept endpoints and reject invalid bounds', () => {
  for (const [minMinutes, maxMinutes] of [[5, 5], [180, 180], [5, 180]]) assert.equal(sourcePrescriptionPlanFields.safeParse({ ...plan(), duration: { kind: 'estimated-range', minMinutes, maxMinutes } }).success, true);
  for (const [minMinutes, maxMinutes] of [[4, 5], [5, 181], [20, 15], [5.5, 10], [5, Infinity], [NaN, 10]]) assert.equal(sourcePrescriptionPlanFields.safeParse({ ...plan(), duration: { kind: 'estimated-range', minMinutes, maxMinutes } }).success, false);
  for (const length of [1, 50]) assert.equal(sourcePrescriptionPlanFields.safeParse({ ...plan(), items: Array.from({ length }, (_, index) => item(`item_${index}`)) }).success, true);
  for (const items of [[], Array.from({ length: 51 }, (_, index) => item(`item_${index}`)), [item(), item()]]) assert.equal(sourcePrescriptionPlanFields.safeParse({ ...plan(), items }).success, false);
  assert.equal(sourcePrescriptionPlanFields.parse({ ...plan(), name: ' name ' }).name, 'name');
  assert.equal(sourcePrescriptionPlanFields.safeParse({ ...plan(), name: 'x'.repeat(100) }).success, true);
  for (const name of ['', ' ', 'x'.repeat(101)]) assert.equal(sourcePrescriptionPlanFields.safeParse({ ...plan(), name }).success, false);
});

test('legacy plan, item and patch parsers keep their existing shape and refuse the additive source representation', () => {
  const legacyItem = { id: 'item', exerciseId: 'exercise', setTarget: 2, repMin: 6, repMax: 10, targetKg: 0 };
  const legacyPlan = { name: 'Legacy plan', minutes: 20, items: [legacyItem] };
  assert.deepEqual(planItem.parse(legacyItem), legacyItem);
  assert.deepEqual(planFields.parse(legacyPlan), legacyPlan);
  assert.deepEqual(planPatch.parse({ expectedRevision: 0, name: ' renamed ' }), { expectedRevision: 0, name: 'renamed' });
  assert.equal(planItem.safeParse(item()).success, false);
  assert.equal(planFields.safeParse(plan()).success, false);
  assert.equal(planPatch.safeParse({ expectedRevision: 0, ...plan() }).success, false);
  assert.equal(sourcePrescriptionPlanFields.safeParse(legacyPlan).success, false);
  assert.equal(planItem.safeParse({ ...legacyItem, repMax: 5 }).success, false);
  assert.equal(planItem.safeParse({ ...legacyItem, targetKg: -1 }).success, false);
});
