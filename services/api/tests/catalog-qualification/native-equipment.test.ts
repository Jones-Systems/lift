import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createNativeMovementCatalogFromRetained, projectNativeEquipmentRequirements,
  RETAINED_CATALOG_INPUTS } from '../../src/catalog-qualification/index.js';

const retained = readFileSync(resolve(process.cwd(), '../..', RETAINED_CATALOG_INPUTS.legacy.path));
const catalog = createNativeMovementCatalogFromRetained(retained);

test('projector preserves all authenticated native equipment without operational promotion', () => {
  for (const variant of catalog.variants) {
    const result = projectNativeEquipmentRequirements(catalog, variant.identity.nativeId)!;
    assert.deepEqual(result.required, variant.equipment.required);
    assert.deepEqual(result.alternatives, variant.equipment.alternatives);
    assert.deepEqual(result.native.identity, variant.identity);
    assert.equal(result.native.variantId, variant.variantId);
    assert.equal(result.native.qualification, 'source_native_operational_identity');
    assert.equal(result.operationalSource, null);
    assert.notEqual(result.required, variant.equipment.required);
    assert.notEqual(result.alternatives, variant.equipment.alternatives);
    assert.notEqual(result.native.identity, variant.identity);
    assert(Object.isFrozen(result)); assert(Object.isFrozen(result.native.identity));
    assert(Object.isFrozen(result.required)); assert(Object.isFrozen(result.alternatives));
    assert(result.alternatives.every(Object.isFrozen));
    assert.deepEqual(Object.keys(result), ['schema', 'required', 'alternatives', 'native', 'operationalSource']);
  }
  assert.equal(projectNativeEquipmentRequirements(catalog, 'unregistered-alias'), null);
});

test('authentic carry OR and rowing AND retain singular/plural literals and detached frozen values', () => {
  for (const id of ['farmer-carry', 'suitcase-carry']) {
    const projected = projectNativeEquipmentRequirements(catalog, id)!;
    assert.deepEqual(projected.required, []);
    assert.deepEqual(projected.alternatives, [['dumbbell', 'kettlebell']]);
    assert.throws(() => Object.assign(projected.alternatives[0]!, { 0: 'dumbbells' }), TypeError);
    assert.deepEqual(catalog.get(id)!.equipment.alternatives, [['dumbbell', 'kettlebell']]);
  }
  const row = projectNativeEquipmentRequirements(catalog, 'one-arm-dumbbell-row')!;
  assert.deepEqual(row.required, ['dumbbell', 'bench']); assert.deepEqual(row.alternatives, []);
  assert.throws(() => Object.assign(row.native.identity, { sha256: 'changed' }), TypeError);
  assert.equal(row.operationalSource, null);
  // Source metadata for the withheld collision is not a registered Domain association or operational witness.
  assert.equal(projectNativeEquipmentRequirements(catalog, 'goblet-squat')!.operationalSource, null);
});
