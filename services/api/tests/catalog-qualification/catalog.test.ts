import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { catalogSeed } from '../../src/catalog.js';
import { createLegacyCuePreferenceValidator } from '../../src/catalog-qualification/cue-preferences.js';
import {
  CatalogQualificationError, createRetainedCatalogQualification, RETAINED_CATALOG_INPUTS,
  RETAINED_CATALOG_SOURCE, type RetainedCatalogInputs,
} from '../../src/catalog-qualification/index.js';

const root = resolve(process.cwd(), '../..');
const inputs: RetainedCatalogInputs = {
  legacy: readFileSync(resolve(root, RETAINED_CATALOG_INPUTS.legacy.path)),
  firstCatalog: readFileSync(resolve(root, RETAINED_CATALOG_INPUTS.firstCatalog.path)),
  crosswalk: readFileSync(resolve(root, RETAINED_CATALOG_INPUTS.crosswalk.path)),
  secondCatalog: readFileSync(resolve(root, RETAINED_CATALOG_INPUTS.secondCatalog.path)),
};
const adapter = createRetainedCatalogQualification(inputs);
const source = JSON.parse(Buffer.from(inputs.legacy).toString('utf8'));

test('all four artifacts match the immutable Form manifest identities', () => {
  const bytes = readFileSync(resolve(root, 'sources/manifest.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), RETAINED_CATALOG_SOURCE.manifestSha256);
  const manifest = JSON.parse(bytes.toString('utf8'));
  for (const [key, pin] of Object.entries(RETAINED_CATALOG_INPUTS)) {
    const rows = manifest.files.filter((row: { destination: string }) => row.destination === pin.path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].revision, '7636efca55195b1dc6a5980864452575478116b7');
    assert.equal(rows[0].sha256, pin.sha256);
    assert.equal(rows[0].bytes, pin.bytes);
    assert.equal(rows[0].git_blob, pin.gitBlob);
    assert.equal(createHash('sha256').update(inputs[key as keyof RetainedCatalogInputs]).digest('hex'), pin.sha256);
  }
});

test('reconciles every real legacy ID and cue slot with explicit unsupported dispositions', () => {
  assert.deepEqual(adapter.summary, {
    legacyExercises: 59, cueSlots: 177, firstCatalogRecords: 876,
    firstCatalogCandidateLinks: 42, firstCatalogExcludedLinks: 101,
    secondCatalogCandidates: 15, secondCatalogWgerCandidates: 3, secondCatalogInstitutionalCandidates: 12,
    approvedVariants: 0, displayableLegacyCues: 0,
  });
  assert.deepEqual(adapter.inventory.map(row => row.legacyId), source.exercise_dispositions.map((row: { legacy_id: string }) => row.legacy_id));
  const slots = adapter.inventory.flatMap(row => row.cueSlots);
  assert.deepEqual(slots.map(cue => cue.id).sort(), source.cue_slots.map((cue: { cue_id: string }) => cue.cue_id).sort());
  for (const row of adapter.inventory) {
    assert.equal(row.variantMapping, 'unmapped');
    assert.deepEqual(row.variantIds, []);
    assert.equal(row.planningEligibility, 'unresolved');
    assert.equal(row.muscleRoles, 'not_appraised');
    assert.equal(row.demands, 'unsupported');
    assert.equal(row.substitutions, 'unsupported');
    assert.equal(row.clinicalReadiness, 'CL-0');
    assert.equal(row.cueSlots.length, 3);
    for (const cue of row.cueSlots) {
      assert.equal(adapter.getCue(cue.id), cue);
      assert.equal(cue.display, 'withheld');
      assert.equal(cue.mutable, false);
      assert.equal(cue.classification, 'unclassified');
      assert.equal(cue.rightsStatus, 'unreviewed_legacy_provenance');
      assert.equal(cue.humanSource, null);
      assert.equal('wording' in cue, false);
      const original = source.cue_slots.find((candidate: { cue_id: string }) => candidate.cue_id === cue.id);
      assert.equal(cue.wordingSha256, createHash('sha256').update(original.wording).digest('hex'));
      assert.deepEqual(JSON.parse(Buffer.from(inputs.legacy).toString()).cue_slots[Number(cue.source.pointer.split('/').at(-1))], original);
    }
  }
});

test('strict legacy record round-trip preserves exact fields and equipment semantics without operational promotion', () => {
  for (const original of source.exercise_dispositions) {
    const result = adapter.getUnreviewedLegacyRecord(original.legacy_id)!;
    assert.equal(result.classification, 'unreviewed_legacy_content');
    assert.equal(result.operationalUse, false);
    assert.equal(result.publicationRights, 'not_cleared');
    assert.deepEqual(result.record, original.legacy_record);
    assert.deepEqual(Object.keys(result.record), Object.keys(original.legacy_record));
    assert.deepEqual(adapter.getLegacy(original.legacy_id)!.observed.equipment, original.legacy_record.equipment);
  }
  assert.deepEqual(adapter.getLegacy('goblet-squat')!.observed.equipment, { required: ['kettlebell', 'dumbbell'], alternatives: [] });
  assert.ok(adapter.getUnreviewedLegacyRecord('wall-calf-stretch')!.record.contraindications!.length > 0);
  assert.equal(adapter.getUnreviewedLegacyRecord('unseen'), null);
});

test('real legacy cue controls withhold all 177 slots and never expose them as mutable coaching', () => {
  let heldSlots = 0;
  for (const exercise of adapter.inventory) {
    const validator = createLegacyCuePreferenceValidator(adapter, exercise.legacyId);
    const input = { expectedPolicyRevision: validator.policy.revision, kept: [], rejected: [], order: [], replacementRequested: [] };
    const result = validator.validate(input);
    assert.deepEqual(result.mutableCueIds, []);
    assert.deepEqual(result.withheldCueIds, exercise.cueSlots.map(cue => cue.id));
    heldSlots += result.withheldCueIds.length;
    for (const cue of exercise.cueSlots) {
      assert.throws(() => validator.validate({ ...input, rejected: [cue.id] }), CatalogQualificationError);
      assert.throws(() => validator.validate({ ...input, kept: [cue.id], order: [cue.id] }), CatalogQualificationError);
      assert.throws(() => validator.validate({ ...input, replacementRequested: [cue.id] }), CatalogQualificationError);
    }
  }
  assert.equal(heldSlots, 177);
  assert.throws(() => createLegacyCuePreferenceValidator(adapter, 'floor-press'), CatalogQualificationError);
});

test('compares two independent catalogs while preserving exclusions, exact native IDs and rights limits', () => {
  const goblet = adapter.getLegacy('goblet-squat')!;
  assert.equal(goblet.firstCatalog.candidates[0]!.nativeId, 'Goblet_Squat');
  assert.equal(goblet.firstCatalog.candidates[0]!.identityConfirmed, false);
  assert.equal(goblet.firstCatalog.candidates[0]!.rights.status, 'repository_asserts_unlicense_upstream_chain_unverified');
  assert.match(goblet.firstCatalog.candidates[0]!.unresolved, /without automatic OR reinterpretation/u);
  assert.ok(goblet.firstCatalog.excluded.some(row => row.id === 'Plie_Dumbbell_Squat'));
  const bird = adapter.getLegacy('bird-dog')!.secondCatalog.candidates[0]!;
  assert.equal(bird.catalog, 'wger');
  assert.equal(bird.nativeId, 1572);
  assert.equal(bird.sourceMetadata.translation_id, 2520);
  assert.equal(bird.sourceMetadata.language_id, 2);
  assert.equal(bird.sourceMetadata.license_author, 'Settebello');
  assert.equal(bird.rights.source_short_name, 'CC-BY-SA 4');
  assert.equal(bird.reuse, 'not_cleared');
  assert.match(String(bird.rights.unknown), /downstream reuse compliance not assessed/u);
  const chair = adapter.getLegacy('sit-to-stand')!.secondCatalog.candidates[0]!;
  assert.equal(chair.catalog, 'institutional-name-index');
  assert.equal(chair.nativeId, null);
  assert.equal(chair.sourceMetadata.locator, 'Heading Sit-to-stand');
  assert.match(String(chair.rights.status), /conditional site terms/u);
  assert.equal(adapter.getLegacy('step-down')!.secondCatalog.disposition, 'no_candidate_in_retained_packet');
  assert.ok(adapter.getLegacy('step-down')!.secondCatalog.exclusionsAndGaps.length > 0);
  assert.ok(adapter.researchLimits.secondCatalogExclusionsAndGaps.some(row => row.disposition === 'excluded_from_English_candidate_set'));
  assert.ok(adapter.researchLimits.secondCatalogLimitations.some(text => text.includes('do not establish catalog absence')));
  for (const row of adapter.inventory) for (const candidate of [...row.firstCatalog.candidates, ...row.secondCatalog.candidates]) {
    assert.equal(candidate.identityConfirmed, false);
    assert.equal(candidate.reuse, 'not_cleared');
    assert.equal(candidate.source.revision, RETAINED_CATALOG_SOURCE.revision);
  }
});

test('actual Form consumer IDs never acquire aliases or variants from similar names', () => {
  const result = adapter.qualifyIds(catalogSeed.map(exercise => exercise.id));
  assert.deepEqual(result.items.map(row => [row.requestedId, row.identityStatus]), [
    ['goblet-squat', 'found'], ['floor-press', 'unknown'], ['supported-row', 'unknown'], ['dumbbell-hinge', 'unknown'], ['calf-raise', 'unknown'],
  ]);
  assert.ok(result.items.every(row => row.planningEligibility === 'unresolved' && row.variantIds.length === 0));
  assert.equal(adapter.getLegacy('Goblet_Squat'), null);
  assert.equal(adapter.getLegacy('Goblet squat'), null);
  assert.equal(adapter.getLegacy('GOBLET-SQUAT'), null);
  assert.equal(adapter.getCue('controlled-tempo'), null);
  assert.equal(adapter.qualifyIds(['dumbbell-floor-press']).items[0]!.identityStatus, 'found');
});

test('rejects changed, omitted, injected and swapped artifacts before any qualification', () => {
  const reject = (input: unknown) => assert.throws(() => createRetainedCatalogQualification(input as RetainedCatalogInputs), (error: unknown) => error instanceof CatalogQualificationError && error.code === 'invalid_artifact');
  reject({ ...inputs, firstCatalog: inputs.secondCatalog });
  reject({ ...inputs, callerReceipt: { approved: true } });
  reject({ legacy: inputs.legacy, firstCatalog: inputs.firstCatalog, crosswalk: inputs.crosswalk });
  reject({ ...inputs, legacy: JSON.parse(Buffer.from(inputs.legacy).toString('utf8')) });
  for (const key of Object.keys(inputs) as (keyof RetainedCatalogInputs)[]) {
    const changed = Uint8Array.from(inputs[key]);
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    reject({ ...inputs, [key]: changed });
  }
  let invoked = false;
  const accessor = { ...inputs };
  Object.defineProperty(accessor, 'legacy', { enumerable: true, get() { invoked = true; return inputs.legacy; } });
  reject(accessor);
  assert.equal(invoked, false);
});

test('validates exact ID requests and preserves immutable state independently of caller buffers', () => {
  for (const ids of [[], ['bird-dog', 'bird-dog'], [' bird-dog'], ['bird-dog\n'], [3], new Array(1), ['']]) {
    assert.throws(() => adapter.qualifyIds(ids as string[]), CatalogQualificationError);
  }
  const owned = { ...inputs, legacy: Uint8Array.from(inputs.legacy) };
  const fresh = createRetainedCatalogQualification(owned);
  owned.legacy.fill(0);
  assert.equal(fresh.getLegacy('bird-dog')!.observed.name, 'Bird dog');
  assert.throws(() => Object.assign(fresh.getLegacy('bird-dog')!.observed.equipment.required, { 0: 'forged' }), TypeError);
  assert.throws(() => Object.assign(fresh.getCue('LEGACY-bird-dog-1')!, { display: 'allowed' }), TypeError);
  assert.throws(() => Object.assign(fresh.qualifyIds(['bird-dog']).items[0]!, { planningEligibility: 'eligible' }), TypeError);
});
