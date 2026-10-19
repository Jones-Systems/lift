import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { catalogSeed } from '../../src/catalog.js';
import {
  CatalogQualificationError, RETAINED_CATALOG_INPUTS, createNativeMovementCatalogFromRetained,
  createRegisteredNativeCatalogFactory, type NativeDomainRegistrationV1, type RegisteredBinding,
  type RegisteredBindingRequest, type RegisteredDomainProjection, type RegisteredNativeExercise,
  type RegistrationPin,
} from '../../src/catalog-qualification/index.js';

const retained = readFileSync(resolve(process.cwd(), '../..', RETAINED_CATALOG_INPUTS.legacy.path));
const native = createNativeMovementCatalogFromRetained(retained);
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

// This fixed schema-order oracle is independent of the implementation's recursive key-sorting algorithm.
function recordDigest(record: RegisteredNativeExercise): string {
  const { sourceIdentity: source, registration } = record.provenance;
  const q = JSON.stringify;
  return hash(`{"cues":[],"id":${q(record.id)},"loadLabel":${q(record.loadLabel)},"name":${q(record.name)},"provenance":{"cueStatus":${q(record.provenance.cueStatus)},"loadBasis":${q(record.provenance.loadBasis)},"registration":{"id":${q(registration.id)},"revision":${q(registration.revision)}},"sourceIdentity":{"nativeId":${q(source.nativeId)},"path":${q(source.path)},"repository":${q(source.repository)},"revision":${q(source.revision)},"sha256":${q(source.sha256)}}},"requiredConstraints":[],"retired":false}`);
}

// These records, accepted pins and persisted projections are synthetic mechanism fixtures, never production registrations.
const artifact: NativeDomainRegistrationV1 = {
  schema: 'form.native-domain-registration/v1', id: 'synthetic-registration', revision: 'synthetic-v1',
  entries: native.variants.map((variant, index) => {
    const exerciseId = `synthetic_registered_${index}`;
    const record: RegisteredNativeExercise = {
      id: exerciseId, name: variant.name, loadLabel: 'Load (unspecified basis)', retired: false,
      provenance: { sourceIdentity: variant.identity, registration: { id: 'synthetic-registration', revision: 'synthetic-v1' },
        loadBasis: 'unknown', cueStatus: 'withheld' },
      requiredConstraints: [], cues: [],
    };
    return { exerciseId, sourceIdentity: variant.identity, recordDigest: recordDigest(record), record };
  }),
};

function packet(document: unknown = artifact) {
  const bytes = Buffer.from(JSON.stringify(document));
  const pin: RegistrationPin = { id: artifact.id, revision: artifact.revision, digest: hash(bytes), bytes: bytes.byteLength };
  return { bytes, pin };
}
function instantiate(document: unknown = artifact) {
  const { bytes, pin } = packet(document);
  return createRegisteredNativeCatalogFactory([pin])({ legacyBytes: retained, registrationBytes: bytes });
}
const catalog = instantiate();
const first = artifact.entries[0]!;
function active(entry = first): RegisteredDomainProjection {
  return { exerciseId: entry.exerciseId, embeddedId: entry.record.id, recordDigest: entry.recordDigest, retired: false,
    registration: { id: artifact.id, revision: artifact.revision, digest: packet().pin.digest },
    sourceIdentity: entry.sourceIdentity, catalogRevision: 'synthetic-persisted-catalog-v1', currentness: 'current' };
}
function request(projection: RegisteredDomainProjection | null = active()): RegisteredBindingRequest {
  return { nativeId: first.sourceIdentity.nativeId, exerciseId: first.exerciseId, active: projection };
}
function rejects(code: CatalogQualificationError['code'], action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof CatalogQualificationError && error.code === code);
}
function unavailable(result: RegisteredBinding, reasons: readonly string[]): void {
  assert.equal(result.status, 'unavailable');
  if (result.status === 'unavailable') assert.deepEqual(result.reasons, reasons);
}

test('no accepted production registry is implicit: absent, empty, unknown and changed bytes are unavailable', () => {
  const { bytes, pin } = packet();
  for (const registrationBytes of [null, bytes]) {
    const empty = createRegisteredNativeCatalogFactory()({ legacyBytes: retained, registrationBytes });
    assert.equal(empty.registration, null);
    assert.equal(empty.getRegisteredRecord(first.exerciseId), null);
    unavailable(empty.bindRegisteredDomainExercise(request()), ['registry_unavailable']);
  }
  const changed = Buffer.from(bytes);
  changed[20] = changed[20]! ^ 1;
  for (const registrationBytes of [null, changed, bytes.subarray(1)]) {
    const unknown = createRegisteredNativeCatalogFactory([pin])({ legacyBytes: retained, registrationBytes });
    unavailable(unknown.bindRegisteredDomainExercise(request()), ['registry_unavailable']);
    assert.equal(unknown.registration, null);
  }
  const empty = instantiate({ ...artifact, entries: [] });
  unavailable(empty.bindRegisteredDomainExercise(request()), ['registry_unavailable']);
  assert.equal(empty.getRegisteredRecord(first.exerciseId), null);
  rejects('invalid_artifact', () => createRegisteredNativeCatalogFactory()({ legacyBytes: bytes, registrationBytes: null }));
});

test('all 59 real identities bind only through explicit synthetic registrations with operational scope', () => {
  assert.equal(artifact.entries.length, 59);
  for (const entry of artifact.entries) {
    assert.notEqual(entry.exerciseId, entry.sourceIdentity.nativeId);
    assert.deepEqual(catalog.getRegisteredRecord(entry.exerciseId), entry.record);
    assert.equal(catalog.getRegisteredRecord(entry.sourceIdentity.nativeId), null);
    const variant = native.get(entry.sourceIdentity.nativeId)!;
    const result = catalog.bindRegisteredDomainExercise({ nativeId: entry.sourceIdentity.nativeId, exerciseId: entry.exerciseId, active: active(entry) });
    assert.deepEqual(result, {
      schema: 'form.registered-native-binding/v1', status: 'bound', exerciseId: entry.exerciseId,
      variantId: variant.variantId, identity: variant.identity,
      registration: active(entry).registration, recordDigest: entry.recordDigest,
      catalogRevision: 'synthetic-persisted-catalog-v1', qualificationScope: 'operational_identity_only',
    });
    assert.equal(entry.record.name, variant.name);
    assert.equal(variant.demands, 'not_supplied');
    assert.equal(variant.prescriptions, 'not_supplied');
    assert.equal(variant.cueRights, 'unresolved');
    for (const key of ['eligible', 'prescriptionKey', 'demands', 'loadBasis', 'laterality', 'cues', 'comparability', 'approved']) assert.equal(key in result, false);
  }
});

test('record digests use canonical content, independent of artifact whitespace or record property order', () => {
  const reversed = { ...artifact, entries: artifact.entries.map(entry => ({ ...entry,
    record: Object.fromEntries(Object.entries(entry.record).reverse()) })) };
  assert.deepEqual(instantiate(reversed).getRegisteredRecord(first.exerciseId), first.record);
  const spaced = Buffer.from(JSON.stringify(artifact, null, 2));
  const pin = { ...packet().pin, bytes: spaced.byteLength, digest: hash(spaced) };
  const loaded = createRegisteredNativeCatalogFactory([pin])({ legacyBytes: retained, registrationBytes: spaced });
  assert.deepEqual(loaded.getRegisteredRecord(first.exerciseId), first.record);
  assert.notEqual(hash(JSON.stringify(first.record)), first.recordDigest);
  rejects('invalid_artifact', () => instantiate({ ...artifact, entries: [{ ...first, recordDigest: hash(JSON.stringify(first.record)) }] }));
  const escapedRef = { id: 'synthetic-"quoted"-é', revision: 'synthetic-\\-revision' };
  const escapedRecord = { ...first.record, provenance: { ...first.record.provenance, registration: escapedRef } };
  const escapedArtifact = { ...artifact, ...escapedRef, entries: [{ ...first, record: escapedRecord, recordDigest: recordDigest(escapedRecord) }] };
  const escaped = packet(escapedArtifact);
  const escapedCatalog = createRegisteredNativeCatalogFactory([{ ...escaped.pin, ...escapedRef }])({ legacyBytes: retained, registrationBytes: escaped.bytes });
  assert.deepEqual(escapedCatalog.getRegisteredRecord(first.exerciseId), escapedRecord);
});

test('accepted bytes still require the genuine name and every field of the pinned native tuple', () => {
  for (const key of ['repository', 'revision', 'path', 'sha256', 'nativeId'] as const) {
    const sourceIdentity = { ...first.sourceIdentity, [key]: key === 'sha256' ? '0'.repeat(64) : 'different-native-source' };
    const changedRecord = { ...first.record, provenance: { ...first.record.provenance, sourceIdentity } };
    for (const entry of [
      { ...first, sourceIdentity },
      { ...first, record: changedRecord, recordDigest: recordDigest(changedRecord) },
    ]) rejects('invalid_artifact', () => instantiate({ ...artifact, entries: [entry] }));
  }
  for (const name of ['Goblet squat alias', first.record.name.toUpperCase(), ' ' + first.record.name]) {
    const changedRecord = { ...first.record, name };
    rejects('invalid_artifact', () => instantiate({ ...artifact, entries: [{ ...first, record: changedRecord, recordDigest: recordDigest(changedRecord) }] }));
  }
});

test('the immutable record admits only seven fields and unknown load basis with withheld empty cues', () => {
  const { cues: _cues, ...missingCues } = first.record;
  const records: unknown[] = [
    missingCues, { ...first.record, approved: true }, { ...first.record, loadLabel: 'kg total' },
    { ...first.record, retired: true }, { ...first.record, cues: ['invented-cue'] },
    { ...first.record, requiredConstraints: ['invented-rule'] },
    { ...first.record, provenance: { ...first.record.provenance, loadBasis: 'total' } },
    { ...first.record, provenance: { ...first.record.provenance, cueStatus: 'approved' } },
    { ...first.record, provenance: { ...first.record.provenance, rights: 'cleared' } },
    { ...first.record, provenance: { ...first.record.provenance, registration: { ...first.record.provenance.registration, digest: packet().pin.digest } } },
    { ...first.record, provenance: { ...first.record.provenance, registration: { id: artifact.id, revision: 'wrong' } } },
    catalogSeed.find(row => row.id === 'goblet-squat')!,
  ];
  for (const record of records) rejects('invalid_artifact', () => instantiate({ ...artifact, entries: [{ ...first, record }] }));
  const wrongRefRecord = { ...first.record, provenance: { ...first.record.provenance, registration: { id: artifact.id, revision: 'wrong' } } };
  rejects('invalid_artifact', () => instantiate({ ...artifact, entries: [{ ...first, record: wrongRefRecord, recordDigest: recordDigest(wrongRefRecord) }] }));
});

test('closed registry shape rejects forged approval, pin-reference mismatch, duplicate IDs and malformed encoding', () => {
  const { record: _record, ...missingRecord } = first;
  const beyondBorrowedCeiling = Array.from({ length: 1001 }, (_, index) => {
    const record = { ...first.record, id: `synthetic_limit_${index}` };
    return { ...first, exerciseId: record.id, record, recordDigest: recordDigest(record) };
  });
  for (const document of [
    { ...artifact, schema: 'form.native-domain-registration/v2' }, { ...artifact, approved: true },
    { ...artifact, id: 'different-registry' }, { ...artifact, revision: 'different-revision' },
    { ...artifact, entries: [{ ...first, approved: true }] }, { ...artifact, entries: [missingRecord] },
    { ...artifact, entries: [first, first] }, { ...artifact, entries: [{ ...first, exerciseId: 'other_domain_id' }] },
    { ...artifact, entries: [{ ...first, recordDigest: 'A'.repeat(64) }] },
  ]) rejects('invalid_artifact', () => instantiate(document));
  const larger = instantiate({ ...artifact, entries: beyondBorrowedCeiling });
  assert.deepEqual(larger.getRegisteredRecord('synthetic_limit_1000'), beyondBorrowedCeiling[1000]!.record);
  for (const changedRef of [{ id: 'different-registry', revision: artifact.revision }, { id: artifact.id, revision: 'different-revision' }]) {
    const changedRecord = { ...first.record, provenance: { ...first.record.provenance, registration: changedRef } };
    rejects('invalid_artifact', () => instantiate({ ...artifact, ...changedRef, entries: [{ ...first, record: changedRecord, recordDigest: recordDigest(changedRecord) }] }));
  }
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff])]) {
    const pin = { ...packet().pin, bytes: bytes.byteLength, digest: hash(bytes) };
    rejects('invalid_artifact', () => createRegisteredNativeCatalogFactory([pin])({ legacyBytes: retained, registrationBytes: bytes }));
  }
});

test('accepted pins are closed trusted configuration, copied before use and never read through accessors', () => {
  const { bytes, pin } = packet();
  for (const pins of [
    [{ ...pin, approved: true }], [{ ...pin, bytes: 0 }], [{ ...pin, bytes: 1.5 }],
    [{ ...pin, bytes: Number.MAX_SAFE_INTEGER + 1 }], [{ ...pin, digest: 'not-a-digest' }],
    [{ ...pin, id: '' }], [{ ...pin, revision: 'r'.repeat(513) }],
    [pin, pin], [pin, { ...pin, digest: '0'.repeat(64) }], [pin, { ...pin, id: 'other-registry' }],
  ]) rejects('invalid_policy', () => createRegisteredNativeCatalogFactory(pins as readonly RegistrationPin[]));
  const manyPins = Array.from({ length: 1000 }, (_, index) => ({ ...pin, id: `synthetic_pin_${index}`, digest: hash(`synthetic_bytes_${index}`) }));
  const beyondBorrowedCeiling = createRegisteredNativeCatalogFactory([...manyPins, pin]);
  assert.deepEqual(beyondBorrowedCeiling({ legacyBytes: retained, registrationBytes: bytes }).registration, pin);
  let invoked = false;
  const getter = { ...pin };
  Object.defineProperty(getter, 'digest', { enumerable: true, get() { invoked = true; return pin.digest; } });
  rejects('invalid_policy', () => createRegisteredNativeCatalogFactory([getter]));
  const sparse = new Array<RegistrationPin>(1);
  rejects('invalid_policy', () => createRegisteredNativeCatalogFactory(sparse));
  assert.equal(invoked, false);
  const mutable = { ...pin };
  const factory = createRegisteredNativeCatalogFactory([mutable]);
  mutable.digest = '0'.repeat(64);
  assert.deepEqual(factory({ legacyBytes: retained, registrationBytes: bytes }).registration, pin);
});

test('binding requests and persisted projections reject malformed fields, coercion and authority overrides', () => {
  const projection = active();
  const invalid = (value: unknown) => rejects('invalid_request', () => catalog.bindRegisteredDomainExercise(value as RegisteredBindingRequest));
  for (const value of [
    null, { nativeId: first.sourceIdentity.nativeId, exerciseId: first.exerciseId }, { ...request(), approved: true },
    { ...request(), exerciseId: 'd'.repeat(81) }, { ...request(), nativeId: 1 },
    { ...request(), exerciseId: native.variants[0]!.variantId }, { ...request(), exerciseId: 'invented alias' },
    { ...request(), active: { ...projection, retired: 'false' } },
    { ...request(), active: { ...projection, currentness: 'approved' } },
    { ...request(), active: { ...projection, catalogRevision: '' } },
    { ...request(), active: { ...projection, recordDigest: 'bad-digest' } },
    { ...request(), active: { ...projection, embeddedId: null } },
    { ...request(), active: { ...projection, sourceIdentity: null } },
    { ...request(), active: { ...projection, registration: { ...projection.registration, approved: true } } },
    { ...request(), active: { ...projection, sourceIdentity: { ...projection.sourceIdentity, approved: true } } },
    Object.assign(Object.create({ approved: true }) as object, request()),
  ]) invalid(value);
  let invoked = false;
  const getter = { ...projection };
  Object.defineProperty(getter, 'recordDigest', { enumerable: true, get() { invoked = true; return projection.recordDigest; } });
  invalid(request(getter));
  const source = { ...projection.sourceIdentity };
  Object.defineProperty(source, 'nativeId', { enumerable: true, get() { invoked = true; return source.nativeId; } });
  invalid(request({ ...projection, sourceIdentity: source }));
  assert.equal(invoked, false);
  rejects('invalid_request', () => catalog.getRegisteredRecord('d'.repeat(81)));
});

test('binding matches request, row, embedded ID, record digest, registry, full native tuple and current retirement', () => {
  unavailable(catalog.bindRegisteredDomainExercise(request(null)), ['domain_absent']);
  unavailable(catalog.bindRegisteredDomainExercise({ ...request(), nativeId: 'unknown-native' }), ['unknown_native_id']);
  unavailable(catalog.bindRegisteredDomainExercise({ ...request(), exerciseId: 'unregistered', active: { ...active(), exerciseId: 'unregistered', embeddedId: 'unregistered' } }), ['unknown_exercise_id']);
  for (const key of ['exerciseId', 'embeddedId'] as const) unavailable(catalog.bindRegisteredDomainExercise(request({ ...active(), [key]: 'another_domain_id' })), ['domain_id_mismatch']);
  unavailable(catalog.bindRegisteredDomainExercise(request({ ...active(), recordDigest: '0'.repeat(64) })), ['record_digest_mismatch']);
  for (const key of ['id', 'revision', 'digest'] as const) {
    unavailable(catalog.bindRegisteredDomainExercise(request({ ...active(), registration: { ...active().registration, [key]: key === 'digest' ? '0'.repeat(64) : 'different-registry' } })), ['unknown_registration']);
  }
  for (const key of ['repository', 'revision', 'path', 'sha256', 'nativeId'] as const) {
    unavailable(catalog.bindRegisteredDomainExercise(request({ ...active(), sourceIdentity: { ...first.sourceIdentity, [key]: key === 'sha256' ? '0'.repeat(64) : 'different-native' } })), ['source_identity_mismatch']);
  }
  const other = artifact.entries[1]!;
  unavailable(catalog.bindRegisteredDomainExercise({ ...request(), nativeId: other.sourceIdentity.nativeId, active: { ...active(), sourceIdentity: other.sourceIdentity } }), ['source_identity_mismatch']);
  unavailable(catalog.bindRegisteredDomainExercise(request({ ...active(), retired: true })), ['retired']);
  for (const currentness of ['stale', 'unavailable'] as const) unavailable(catalog.bindRegisteredDomainExercise(request({ ...active(), currentness })), ['registration_not_current']);
});

test('explicit registration leaves the equality bridge and differently sourced Open Mat rows unchanged', () => {
  const equality = native.bindActiveDomainExercise({ nativeId: first.sourceIdentity.nativeId, exerciseId: first.exerciseId,
    active: { exerciseId: first.exerciseId, retired: false, sourceIdentity: first.sourceIdentity, catalogRevision: 'synthetic-v1', currentness: 'current' } });
  assert.equal(equality.status, 'unavailable');
  if (equality.status === 'unavailable') assert.deepEqual(equality.reasons, ['id_mismatch']);
  const goblet = artifact.entries.find(entry => entry.sourceIdentity.nativeId === 'goblet-squat')!;
  const openMat = catalogSeed.find(row => row.id === 'goblet-squat')!;
  assert.equal(catalog.getRegisteredRecord(openMat.id), null);
  const collision = catalog.bindRegisteredDomainExercise({ nativeId: goblet.sourceIdentity.nativeId, exerciseId: goblet.exerciseId,
    active: { ...active(goblet), exerciseId: openMat.id, embeddedId: openMat.id,
      sourceIdentity: { ...goblet.sourceIdentity, repository: 'Jones-Systems/Form', revision: openMat.provenance.revision, path: openMat.provenance.source } } });
  unavailable(collision, ['domain_id_mismatch', 'source_identity_mismatch']);
  assert.equal(catalogSeed.find(row => row.id === 'goblet-squat'), openMat);
});

test('byte and projection mutation cannot rewrite frozen records or earlier bindings; fresh retirement still blocks', () => {
  const { bytes, pin } = packet();
  const ownedRetained = Buffer.from(retained);
  const fresh = createRegisteredNativeCatalogFactory([pin])({ legacyBytes: ownedRetained, registrationBytes: bytes });
  bytes.fill(0);
  ownedRetained.fill(0);
  assert.deepEqual(fresh.getRegisteredRecord(first.exerciseId), first.record);
  const projection = structuredClone(active());
  const result = fresh.bindRegisteredDomainExercise(request(projection));
  assert.equal(result.status, 'bound');
  Object.assign(projection, { retired: true });
  unavailable(fresh.bindRegisteredDomainExercise(request(projection)), ['retired']);
  Object.assign(projection.sourceIdentity, { revision: 'changed-after-binding' });
  if (result.status === 'bound') assert.equal(result.identity.revision, native.source.revision);
  for (const value of [fresh, fresh.registration!, fresh.source, fresh.getRegisteredRecord(first.exerciseId)!,
    fresh.getRegisteredRecord(first.exerciseId)!.provenance, fresh.getRegisteredRecord(first.exerciseId)!.cues, result]) {
    assert.equal(Object.isFrozen(value), true);
    assert.throws(() => Object.assign(value, { approved: true }), TypeError);
  }
  const missing = fresh.bindRegisteredDomainExercise(request(null));
  if (missing.status === 'unavailable') assert.throws(() => Object.assign(missing.reasons, { 0: 'approved' }), TypeError);
});
