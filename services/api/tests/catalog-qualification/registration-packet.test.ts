import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { catalogSeed } from '../../src/catalog.js';
import {
  RETAINED_CATALOG_INPUTS, createNativeMovementCatalogFromRetained, createRegisteredNativeCatalogFactory,
  type NativeDomainRegistrationV1, type RegistrationPin,
} from '../../src/catalog-qualification/index.js';

const root = resolve(process.cwd(), '../..');
const retained = readFileSync(resolve(root, RETAINED_CATALOG_INPUTS.legacy.path));
const bytes = readFileSync(resolve(root, 'docs/knowledge/catalog-cues/registrations/native-engine-v1.candidate.json'));
const review = JSON.parse(readFileSync(resolve(root, 'docs/knowledge/catalog-cues/registrations/native-engine-v1.review.json'), 'utf8'));
const document = JSON.parse(bytes.toString('utf8')) as NativeDomainRegistrationV1;
const native = createNativeMovementCatalogFromRetained(retained);
const pin: RegistrationPin = {
  id: 'form-native-engine-registration-candidate', revision: '442c5cd07f14142326af10fe0eb6d079b0e62a71-v1',
  digest: 'c326ccbba03fcc1fe5807d20811e7cd57b87be4c2ebf0361e922028e7bb131ed', bytes: 77470,
};

test('real review packet retains all 59 identities and withholds the exact existing Domain collision', () => {
  assert.equal(native.variants.length, 59);
  assert.equal(document.entries.length, 58);
  assert.equal(review.coverage.length, 59);
  assert.deepEqual(review.existing_seed_ids, catalogSeed.map(record => record.id));
  const existing = new Set(catalogSeed.map(record => record.id));
  assert.deepEqual(document.entries.map(entry => entry.exerciseId), native.variants.filter(record => !existing.has(record.identity.nativeId)).map(record => record.identity.nativeId));
  assert.deepEqual(review.coverage.map((row: { native_id: string }) => row.native_id), native.variants.map(record => record.identity.nativeId));
  const withheld = review.coverage.filter((row: { proposed_domain_id: string | null }) => row.proposed_domain_id === null);
  assert.equal(withheld.length, 1);
  assert.equal(withheld[0].native_id, 'goblet-squat');
  assert.equal(withheld[0].state, 'withheld_existing_domain_identity_collision');
  assert.equal(document.entries.some(entry => entry.exerciseId === 'goblet-squat'), false);
});

test('real byte-pinned records validate exact names, tuples and canonical digests without row or dose qualification', () => {
  assert.equal(bytes.length, pin.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.digest);
  assert.deepEqual(review.candidate_pin, pin);
  const validationOnly = createRegisteredNativeCatalogFactory([pin])({ legacyBytes: retained, registrationBytes: bytes });
  for (const entry of document.entries) {
    const original = native.variants.find(record => record.identity.nativeId === entry.exerciseId)!;
    assert.deepEqual(entry.sourceIdentity, original.identity);
    assert.equal(entry.record.name, original.name);
    assert.deepEqual(validationOnly.getRegisteredRecord(entry.exerciseId), entry.record);
    assert.equal(entry.record.provenance.loadBasis, 'unknown');
    assert.equal(entry.record.provenance.cueStatus, 'withheld');
    assert.deepEqual(entry.record.cues, []);
    assert.deepEqual(entry.record.requiredConstraints, []);
    assert.deepEqual(validationOnly.bindRegisteredDomainExercise({ nativeId: original.identity.nativeId, exerciseId: entry.exerciseId, active: null }), {
      schema: 'form.registered-native-binding/v1', status: 'unavailable', nativeId: original.identity.nativeId,
      exerciseId: entry.exerciseId, reasons: ['domain_absent'],
    });
  }
});

test('a real candidate pin is descriptive and never enters the default trusted policy', () => {
  assert.equal(review.status, 'candidate_only');
  assert.equal(review.authority_effect, 'none');
  assert.equal(review.accepted_pin, null);
  assert.equal(review.accepted_domain_allocations, null);
  assert.equal(review.persisted_row_receipt, null);
  const unavailable = createRegisteredNativeCatalogFactory()({ legacyBytes: retained, registrationBytes: bytes });
  assert.equal(unavailable.registration, null);
  for (const entry of document.entries) {
    assert.equal(unavailable.getRegisteredRecord(entry.exerciseId), null);
    const result = unavailable.bindRegisteredDomainExercise({ nativeId: entry.sourceIdentity.nativeId, exerciseId: entry.exerciseId, active: null });
    assert.equal(result.status, 'unavailable');
    if (result.status === 'unavailable') assert.deepEqual(result.reasons, ['registry_unavailable', 'domain_absent']);
  }
});
