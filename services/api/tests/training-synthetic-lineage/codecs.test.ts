import test from 'node:test';
import assert from 'node:assert/strict';
import type { EmbeddedSchema } from '../../src/planning/synthetic-lineage/types.js';
import { syntheticTrainingBindings } from '../../src/training-feedback/synthetic-lineage/bindings.js';
import { syntheticSuccessFixture } from '../../src/training-feedback/synthetic-lineage/fixtures.js';
import { canonical, detach, parseBytes } from '../../src/training-feedback/synthetic-lineage/strict-json.js';
import { row, type Row } from '../../src/training-feedback/synthetic-lineage/schema.js';
const bytes = (value: string) => new TextEncoder().encode(value);
const schema: EmbeddedSchema = 'synthetic.training-feedback-analysis.pinned-v1';
const codec = syntheticTrainingBindings.codecs[schema];
function sample(): Row {
  const entry = syntheticSuccessFixture().evidence.find(e => e.blob.schema === schema)!;
  return row(structuredClone(detach(entry.value)));
}
function reject(input: string | Uint8Array, code?: string): void {
  const result = codec.decodeStrict(typeof input === 'string' ? bytes(input) : input);
  assert.equal(result.ok, false); if (!result.ok && code) assert.equal(result.error.code, code);
}

test('every fixed arm preserves its full response, array order, optional absence and explicit nulls', () => {
  const fixture = syntheticSuccessFixture();
  for (const entry of fixture.evidence) {
    const selected = syntheticTrainingBindings.codecs[entry.blob.schema];
    const decoded = selected.decodeStrict(bytes(entry.blob.canonicalJson)); assert.equal(decoded.ok, true);
    if (decoded.ok) { assert.deepEqual(decoded.value, entry.value); assert.equal(canonical(detach(decoded.value)), entry.blob.canonicalJson); }
    const encoded = selected.validateForEncoding(entry.value); assert.equal(encoded.ok, true);
    if (encoded.ok) assert.deepEqual(encoded.value, entry.value);
  }
  const read = sample(); const result = row(read.result!);
  const d = (result.derivations as Row[])[0]!;
  const field = row(d.value!); const native = row((row((field.items as Row[])[0]!).native)!);
  assert.deepEqual(native.notes, ['synthetic first', 'synthetic second']);
  assert.equal(Object.hasOwn(native, 'substituted_for'), false);
  const records = result.records as Row[];
  assert.deepEqual(records.map(r => r.recordId), ['syn_record_baseline', 'syn_record_current']);
  const content = row(records[0]!.content!), signal = (row(content.payload!).signals as Row[])[0]!;
  assert.equal(signal.unit, null); assert.equal(signal.scale, null);
  const encoded = codec.validateForEncoding(read); assert.equal(encoded.ok, true);
  signal.scale = 'invented-scale'; const next = codec.validateForEncoding(read); assert.equal(next.ok, true);
  if (encoded.ok) { const saved = encoded.value.result.records[0]!.content!.payload;
    assert.equal(saved.kind, 'feedback'); if (saved.kind === 'feedback') { const signal = saved.signals[0]!; assert.equal(signal.state, 'reported');
      if (signal.state === 'reported') assert.equal(signal.scale, null); } }
});

test('nullable declaration, producer, association and blocked evidence are lossless payloads, never normalized', () => {
  const c = syntheticTrainingBindings.codecs['synthetic.feedback-comparison-lineage.pinned-v1'];
  const entry = syntheticSuccessFixture().evidence.find(e => e.blob.schema === 'synthetic.feedback-comparison-lineage.pinned-v1')!;
  const value = row(structuredClone(detach(entry.value)));
  value.registryVersion = null; value.declaration = null; value.producer = null; value.association = null;
  value.blockedBy = ['comparison:undeclared', 'comparison:producer-unbound'];
  const decoded = c.decodeStrict(bytes(canonical(value))); assert.equal(decoded.ok, true);
  if (decoded.ok) assert.deepEqual(decoded.value, value);
});

test('duplicate decoded keys, malformed UTF8/BOM/surrogates and non-JSON syntax fail at the byte seam', () => {
  reject('{"analysis":{},"\\u0061nalysis":{}}', 'duplicate_key');
  reject(new Uint8Array([0xc0, 0xaf]), 'bad_utf8');
  reject(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 'bad_utf8');
  reject('"\\ud800"', 'invalid_string'); reject('"\\udc00"', 'invalid_string');
  reject('{"x":"\\ud800a"}', 'invalid_string');
  reject('{}{}', 'bad_json'); reject('[1,]', 'bad_json'); reject('{"a":1,}', 'bad_json');
  reject('NaN', 'bad_json'); reject('Infinity', 'bad_json'); reject('01', 'bad_json'); reject('true false', 'bad_json');
  assert.deepEqual(parseBytes(bytes('{"\\ud83d\\ude00":"ok"}')), { '😀': 'ok' });
});

test('closed versions, nested fields, missing members and forbidden numbers fail without coercion', () => {
  const value = sample(); value.unexpected = true; reject(canonical(value), 'unknown_field'); delete value.unexpected;
  row(value.analysis!).basis = 'future-profile-v2'; reject(canonical(value), 'unsupported_version');
  row(value.analysis!).basis = 'current_profile_and_goals'; delete row(value.analysis!).contextId; reject(canonical(value), 'missing_field');
  for (const n of ['-0', '1e999', '9007199254740992']) reject(`{"analysis":${n}}`, 'invalid_number');
  reject(canonical(sample()).replace('"ledgerRevision":2', '"ledgerRevision":2.5'), 'invalid_number');
  const c = syntheticTrainingBindings.codecs['synthetic.comparison-witness.pinned-v2'];
  const entry = syntheticSuccessFixture().evidence.find(e => e.blob.schema === c.identity.schema)!;
  const w = row(structuredClone(detach(entry.value))); w.witnessVersion = 'progress-comparison-witness-v3';
  assert.equal(c.decodeStrict(bytes(canonical(w))).ok, false);
  w.witnessVersion = 'progress-comparison-witness-v2'; row(row(w.result!).units!).load = 'lb';
  assert.equal(c.validateForEncoding(w).ok, false);
});

test('byte/depth/node/string bounds reject before a schema can hide extra material', () => {
  reject(new Uint8Array(256 * 1024 + 1), 'bounds_exceeded');
  reject('['.repeat(33) + '0' + ']'.repeat(33), 'bounds_exceeded');
  reject('[' + Array(32768).fill('0').join(',') + ']', 'bounds_exceeded');
  reject(JSON.stringify('x'.repeat(4001)), 'bounds_exceeded');
});

test('encoding detaches deeply and rejects accessor/thenable/prototype/cycle/sparse/nonJSON without executing them', () => {
  let calls = 0;
  const getter = { get analysis() { calls++; throw new Error('must not execute'); } };
  const thenable = { then() { calls++; } };
  const inherited = Object.create({ analysis: 'inherited' });
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  const decorated = sample(); Object.defineProperty(decorated, 'hidden', { value: 1, enumerable: false });
  const sparse = Array(2); sparse[1] = 1;
  for (const invalid of [getter, thenable, inherited, cycle, sparse, decorated, new Date(), 1n, undefined, () => {}, Symbol('x'),
    { value: undefined }, { [Symbol('x')]: 1 }, { value: NaN }, { value: -0 }, Object.assign([], { other: 1 })]) {
    assert.equal(codec.validateForEncoding(invalid).ok, false);
  }
  assert.equal(calls, 0);
  const ambiguous = new Uint8Array([123, 125]); Object.defineProperty(ambiguous, 'buffer', { get() { calls++; throw new Error('no'); } });
  assert.equal(codec.decodeStrict(ambiguous).ok, false); assert.equal(calls, 0);
  assert.equal(codec.decodeStrict(new Proxy(new Uint8Array(), {})).ok, false);
});

test('new embedded schemas retain optional native data and enforce unique rows and graph references', () => {
  const fixture = syntheticSuccessFixture();
  const rc = syntheticTrainingBindings.codecs['synthetic.registration-manifest/v1'];
  const recipe = row(structuredClone(detach(fixture.evidence.find(e => e.blob.schema === rc.identity.schema)!.value)));
  const node = (recipe.nodes as Row[])[0]!; node.parentIds = [node.id!];
  const cycle = rc.validateForEncoding(recipe); assert.equal(cycle.ok, false); if (!cycle.ok) assert.equal(cycle.error.code, 'cycle');
  node.parentIds = ['syn_missing']; const absent = rc.validateForEncoding(recipe); assert.equal(absent.ok, false);
  const dc = syntheticTrainingBindings.codecs['synthetic.accepted-input-dispositions/v1'];
  const dispositions = row(structuredClone(detach(fixture.evidence.find(e => e.blob.schema === dc.identity.schema)!.value)));
  const rows = dispositions.rows as Row[]; rows.push(structuredClone(rows[0]!));
  const duplicate = dc.validateForEncoding(dispositions); assert.equal(duplicate.ok, false); if (!duplicate.ok) assert.equal(duplicate.error.code, 'duplicate_identity');
});
