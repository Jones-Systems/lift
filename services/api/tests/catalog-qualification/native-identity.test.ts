import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { catalogSeed } from '../../src/catalog.js';
import {
  CatalogQualificationError, NATIVE_MOVEMENT_CATALOG, RETAINED_CATALOG_INPUTS,
  createNativeMovementCatalog, createNativeMovementCatalogFromRetained,
  type ActiveDomainExercise, type LegacyRecord, type NativeIdentityBindingRequest,
} from '../../src/catalog-qualification/index.js';

const retained = readFileSync(resolve(process.cwd(), '../..', RETAINED_CATALOG_INPUTS.legacy.path));
const extraction = JSON.parse(retained.toString('utf8')) as {
  exercise_dispositions: { legacy_id: string; legacy_record: LegacyRecord }[];
};
const records = extraction.exercise_dispositions.map(row => row.legacy_record);
const original = Buffer.from(`${JSON.stringify({ exercises: records, schema_version: 2 }, null, 2)}\n`);
const catalog = createNativeMovementCatalogFromRetained(retained);

// These projections are synthetic contract inputs, not persisted catalog associations or source approval receipts.
function syntheticProjection(nativeId = 'goblet-squat'): ActiveDomainExercise {
  return {
    exerciseId: nativeId, retired: false, sourceIdentity: catalog.get(nativeId)!.identity,
    catalogRevision: 'synthetic-contract-catalog/v1', currentness: 'current',
  };
}

function request(active: ActiveDomainExercise | null = syntheticProjection()): NativeIdentityBindingRequest {
  return { nativeId: 'goblet-squat', exerciseId: 'goblet-squat', active };
}

function invalidArtifact(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof CatalogQualificationError && error.code === 'invalid_artifact');
}

test('retained records reproduce the exact original catalog bytes without a second source snapshot', () => {
  assert.equal(retained.byteLength, 229763);
  assert.equal(createHash('sha256').update(retained).digest('hex'), 'fc45be4e7129c39ef46d130a92d6bcf995d2dad64951b40c72fa125ca1561e4b');
  assert.equal(original.byteLength, 72737);
  assert.equal(createHash('sha256').update(original).digest('hex'), '4bc95300958e769555128e0e44fd210d0e773659ef2fd00e4d5748f1a32026d5');
  assert.deepEqual(catalog.source, NATIVE_MOVEMENT_CATALOG);
  assert.deepEqual(createNativeMovementCatalog(original).variants, catalog.variants);
  assert.equal(catalog.variants.length, 59);
  assert.deepEqual(catalog.variants.map(variant => variant.identity.nativeId), extraction.exercise_dispositions.map(row => row.legacy_id));
});

test('every real native record has a full stable identity and preserves AND requirements and OR groups', () => {
  for (const record of records) {
    const variant = catalog.get(record.id)!;
    assert.deepEqual(variant.identity, {
      repository: 'Jones-Systems/movement-engine', revision: '442c5cd07f14142326af10fe0eb6d079b0e62a71',
      path: 'data/catalog/exercises.v2.json', sha256: '4bc95300958e769555128e0e44fd210d0e773659ef2fd00e4d5748f1a32026d5', nativeId: record.id,
    });
    assert.equal(variant.variantId, `movement-engine:442c5cd07f14142326af10fe0eb6d079b0e62a71:${record.id}`);
    assert.equal(variant.name, record.name);
    assert.deepEqual(variant.equipment, record.equipment);
  }
  assert.deepEqual(catalog.get('goblet-squat')!.equipment, { required: ['kettlebell', 'dumbbell'], alternatives: [] });
  assert.deepEqual(catalog.get('farmer-carry')!.equipment, { required: [], alternatives: [['dumbbell', 'kettlebell']] });
  assert.deepEqual(catalog.get('suitcase-carry')!.equipment, { required: [], alternatives: [['dumbbell', 'kettlebell']] });
  assert.ok(catalog.get('pelvic-floor-gentle-lift-release')!.variantId.length > 80);
});

test('changed bytes, native schemas, relationships and caller replacement artifacts fail closed', () => {
  const changed = Buffer.from(original);
  changed[20] = changed[20]! ^ 1;
  for (const bytes of [changed, original.subarray(1), Buffer.concat([original, Buffer.from('\n')]), retained, new Uint8Array(), null, {}]) {
    invalidArtifact(() => createNativeMovementCatalog(bytes as Uint8Array));
  }
  const changedDocuments = [
    { exercises: records, schema_version: 1 },
    { exercises: records, schema_version: 2, approved: true },
    { exercises: [...records.slice(1), records[1]], schema_version: 2 },
    { exercises: [{ ...records[0], regressions: ['not-a-record'] }, ...records.slice(1)], schema_version: 2 },
    { exercises: [{ ...records[0], regressions: ['sit-to-stand'] }, ...records.slice(1)], schema_version: 2 },
    { exercises: [{ ...records[0], equipment: ['chair'] }, ...records.slice(1)], schema_version: 2 },
  ];
  for (const document of changedDocuments) invalidArtifact(() => createNativeMovementCatalog(Buffer.from(JSON.stringify(document))));
  const changedRetained = Buffer.from(retained);
  changedRetained[20] = changedRetained[20]! ^ 1;
  for (const bytes of [changedRetained, original, retained.subarray(1), extraction]) {
    invalidArtifact(() => createNativeMovementCatalogFromRetained(bytes as Uint8Array));
  }
});

test('synthetic exact active projections bind all 59 identities without qualifying a plan or dose', () => {
  for (const variant of catalog.variants) {
    const exerciseId = variant.identity.nativeId;
    const result = catalog.bindActiveDomainExercise({ nativeId: exerciseId, exerciseId, active: syntheticProjection(exerciseId) });
    assert.deepEqual(result, {
      status: 'bound', exerciseId, variantId: variant.variantId, identity: variant.identity,
      catalogRevision: 'synthetic-contract-catalog/v1', qualificationScope: 'operational_identity_only',
    });
    assert.equal(variant.qualification, 'source_native_operational_identity');
    assert.equal(variant.axes, 'not_defined');
    assert.equal(variant.demands, 'not_supplied');
    assert.equal(variant.prescriptions, 'not_supplied');
    assert.equal(variant.clinicalQualification, 'not_assessed');
    assert.equal(variant.cueRights, 'unresolved');
    for (const key of ['eligible', 'prescriptionKey', 'targetKg', 'laterality', 'loadBasis', 'cues', 'wording', 'comparability']) {
      assert.equal(key in variant, false);
      assert.equal(key in result, false);
    }
  }
});

test('absent, unknown, aliased, retired and noncurrent Domain identities stay unavailable', () => {
  assert.deepEqual(catalog.bindActiveDomainExercise(request(null)), {
    status: 'unavailable', nativeId: 'goblet-squat', exerciseId: 'goblet-squat', reasons: ['domain_absent'],
  });
  for (const id of ['Goblet_Squat', 'GOBLET-SQUAT', 'floor-press', 'supported-row', 'dumbbell-hinge', 'calf-raise']) {
    assert.equal(catalog.get(id), null);
    const result = catalog.bindActiveDomainExercise({ nativeId: id, exerciseId: id, active: null });
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.deepEqual(result.reasons, ['unknown_id', 'domain_absent']);
  }
  assert.equal(catalog.get('Goblet squat'), null);
  const mismatch = catalog.bindActiveDomainExercise({ ...request(), exerciseId: 'floor-press' });
  assert.equal(mismatch.status, 'unavailable');
  if (mismatch.status === 'unavailable') assert.deepEqual(mismatch.reasons, ['id_mismatch']);
  for (const currentness of ['unknown', 'superseded', 'withdrawn'] as const) {
    const result = catalog.bindActiveDomainExercise(request({ ...syntheticProjection(), currentness }));
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.deepEqual(result.reasons, ['source_not_current']);
  }
  const retired = catalog.bindActiveDomainExercise(request({ ...syntheticProjection(), retired: true }));
  assert.equal(retired.status, 'unavailable');
  if (retired.status === 'unavailable') assert.deepEqual(retired.reasons, ['retired']);
});

test('every source tuple field and the active exercise ID must match; the Open Mat collision is not an association', () => {
  const projection = syntheticProjection();
  for (const key of ['repository', 'revision', 'path', 'sha256', 'nativeId'] as const) {
    const result = catalog.bindActiveDomainExercise(request({
      ...projection, sourceIdentity: { ...projection.sourceIdentity!, [key]: 'different-source' },
    }));
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.deepEqual(result.reasons, ['provenance_mismatch']);
  }
  const wrongActive = catalog.bindActiveDomainExercise(request({ ...projection, exerciseId: 'bird-dog' }));
  assert.equal(wrongActive.status, 'unavailable');
  if (wrongActive.status === 'unavailable') assert.deepEqual(wrongActive.reasons, ['id_mismatch']);
  const openMat = catalogSeed.find(row => row.id === 'goblet-squat')!;
  for (const sourceIdentity of [null, {
    repository: 'Jones-Systems/Form', revision: openMat.provenance.revision,
    path: openMat.provenance.source, sha256: catalog.get(openMat.id)!.identity.sha256, nativeId: openMat.id,
  }]) {
    const result = catalog.bindActiveDomainExercise(request({ ...projection, exerciseId: openMat.id, sourceIdentity }));
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.deepEqual(result.reasons, ['provenance_mismatch']);
  }
});

test('closed binding fields reject malformed, accessor and forged qualification inputs without coercion', () => {
  const reject = (input: unknown) => assert.throws(() => catalog.bindActiveDomainExercise(input as NativeIdentityBindingRequest),
    (error: unknown) => error instanceof CatalogQualificationError && error.code === 'invalid_request');
  for (const input of [
    { ...request(), qualification: 'qualified' }, { nativeId: 'goblet-squat', exerciseId: 'goblet-squat' },
    { ...request(), exerciseId: catalog.get('pelvic-floor-gentle-lift-release')!.variantId },
    { ...request(), exerciseId: 'a'.repeat(81) }, { ...request(), nativeId: ' goblet-squat' },
    { ...request(), nativeId: 'goblet-squat\n' }, { ...request(), nativeId: 1 },
    { ...request(), active: { ...syntheticProjection(), retired: 'false' } },
    { ...request(), active: { ...syntheticProjection(), currentness: 'approved' } },
    { ...request(), active: { ...syntheticProjection(), catalogRevision: '' } },
    { ...request(), active: { ...syntheticProjection(), approved: true } },
    { ...request(), active: { ...syntheticProjection(), sourceIdentity: { ...syntheticProjection().sourceIdentity, locator: '/invented' } } },
    { ...request(), active: { ...syntheticProjection(), sourceIdentity: {} } },
    Object.assign(Object.create({ inherited: true }) as object, request()), null,
  ]) reject(input);
  let invoked = false;
  const top = { ...request() };
  Object.defineProperty(top, 'nativeId', { enumerable: true, get() { invoked = true; return 'goblet-squat'; } });
  reject(top);
  const active = { ...syntheticProjection() };
  Object.defineProperty(active, 'sourceIdentity', { enumerable: true, get() { invoked = true; return syntheticProjection().sourceIdentity; } });
  reject(request(active));
  const identity = { ...syntheticProjection().sourceIdentity };
  Object.defineProperty(identity, 'revision', { enumerable: true, get() { invoked = true; return NATIVE_MOVEMENT_CATALOG.revision; } });
  reject({ ...request(), active: { ...syntheticProjection(), sourceIdentity: identity } });
  assert.equal(invoked, false);
});

test('caller byte and projection mutations cannot alter frozen identities, equipment or binding outcomes', () => {
  const bytes = Buffer.from(retained);
  const fresh = createNativeMovementCatalogFromRetained(bytes);
  bytes.fill(0);
  const active = structuredClone(syntheticProjection());
  const result = fresh.bindActiveDomainExercise(request(active));
  Object.assign(active.sourceIdentity!, { revision: 'changed-after-binding' });
  Object.assign(active, { exerciseId: 'bird-dog' });
  assert.equal(result.status, 'bound');
  if (result.status === 'bound') assert.equal(result.identity.revision, NATIVE_MOVEMENT_CATALOG.revision);
  assert.throws(() => Object.assign(fresh.source, { revision: 'forged' }), TypeError);
  assert.throws(() => Object.assign(fresh.variants, { 0: {} }), TypeError);
  assert.throws(() => Object.assign(fresh.get('goblet-squat')!.identity, { nativeId: 'alias' }), TypeError);
  assert.throws(() => Object.assign(fresh.get('farmer-carry')!.equipment.alternatives[0]!, { 0: 'machine' }), TypeError);
  assert.throws(() => Object.assign(result, { qualificationScope: 'fully_qualified' }), TypeError);
  const absent = fresh.bindActiveDomainExercise(request(null));
  if (absent.status === 'unavailable') assert.throws(() => Object.assign(absent.reasons, { 0: 'approved' }), TypeError);
});
