import assert from 'node:assert/strict';
import test from 'node:test';
import { createCuePreferenceValidator, type CuePolicy } from '../../src/catalog-qualification/cue-preferences.js';
import { CatalogQualificationError } from '../../src/catalog-qualification/index.js';

// Synthetic policy declarations exercise control boundaries; they establish no real content qualification or rights.
function policy(): CuePolicy {
  const source = { revision: 'synthetic-v1', path: 'synthetic/cue-policy', sha256: 'a'.repeat(64), locator: 'synthetic fixture' };
  return {
    schema: 'form.cue-policy/v1', exerciseId: 'synthetic-exercise', revision: 'synthetic-v1',
    cues: [
      { id: 'coach-a', kind: 'coaching', rightsStatus: 'display_permitted', contentStatus: 'qualified', source },
      { id: 'coach-b', kind: 'coaching', rightsStatus: 'display_permitted', contentStatus: 'qualified', source },
      { id: 'tech', kind: 'technical', rightsStatus: 'display_permitted', contentStatus: 'qualified', source },
      { id: 'safety', kind: 'safety', rightsStatus: 'display_permitted', contentStatus: 'qualified', source },
      { id: 'rights-unknown', kind: 'coaching', rightsStatus: 'unresolved', contentStatus: 'qualified', source },
      { id: 'rights-restricted', kind: 'coaching', rightsStatus: 'restricted', contentStatus: 'qualified', source },
      { id: 'unappraised', kind: 'coaching', rightsStatus: 'display_permitted', contentStatus: 'unreviewed', source },
      { id: 'unclassified', kind: 'unclassified', rightsStatus: 'display_permitted', contentStatus: 'qualified', source },
    ],
  };
}
const empty = () => ({ expectedPolicyRevision: 'synthetic-v1', kept: [], rejected: [], order: [], replacementRequested: [] });

test('coaching preferences retain fixed technical/safety IDs and request alternatives without generating them', () => {
  const validator = createCuePreferenceValidator(policy());
  const result = validator.validate({ ...empty(), kept: ['coach-b', 'coach-a'], order: ['coach-a', 'coach-b'], replacementRequested: ['coach-a'] });
  assert.deepEqual(result.preferences.order, ['coach-a', 'coach-b']);
  assert.deepEqual(result.fixedCueIds, ['tech', 'safety']);
  assert.deepEqual(result.mutableCueIds, ['coach-a', 'coach-b']);
  assert.deepEqual(result.withheldCueIds, ['rights-unknown', 'rights-restricted', 'unappraised', 'unclassified']);
  assert.equal(result.replacementStatus, 'requested_not_generated');
  const revised = validator.validate({ ...empty(), kept: ['coach-b'], order: ['coach-b'], rejected: ['coach-a'], replacementRequested: ['coach-a'] });
  assert.deepEqual(revised.fixedCueIds, result.fixedCueIds);
  assert.deepEqual(validator.validate(empty()).fixedCueIds, result.fixedCueIds);
});

test('every preference operation rejects technical/safety/unclassified, unappraised, rights-held and unknown IDs', () => {
  const validator = createCuePreferenceValidator(policy());
  for (const id of ['tech', 'safety', 'unclassified', 'unappraised', 'rights-unknown', 'rights-restricted', 'unknown', 'LEGACY-goblet-squat-1']) {
    for (const field of ['kept', 'rejected', 'order', 'replacementRequested']) {
      assert.throws(() => validator.validate({ ...empty(), [field]: [id] }), (error: unknown) => error instanceof CatalogQualificationError && error.code === 'invalid_request');
    }
  }
});

test('strict preferences reject stale revisions, extra fields, inconsistent sets, duplicates and malformed arrays', () => {
  const validator = createCuePreferenceValidator(policy());
  assert.throws(() => validator.validate({ ...empty(), expectedPolicyRevision: 'old' }), (error: unknown) => error instanceof CatalogQualificationError && error.code === 'stale_policy');
  for (const input of [
    { ...empty(), requiredConstraints: [] }, { ...empty(), fixedCueIds: [] },
    { ...empty(), kept: ['coach-a'], rejected: ['coach-a'], order: ['coach-a'] },
    { ...empty(), kept: ['coach-a'], order: [] }, { ...empty(), kept: [], order: ['coach-a'] },
    { ...empty(), rejected: ['coach-a', 'coach-a'] }, { ...empty(), replacementRequested: ['coach-a', 'coach-a'] },
    { ...empty(), kept: new Array(1) }, { ...empty(), kept: 'coach-a' },
  ]) assert.throws(() => validator.validate(input), CatalogQualificationError);
});

test('policy shape rejects missing qualification, invented statuses, duplicate identities and accessor execution', () => {
  const source = policy();
  for (const input of [
    { ...source, approved: true }, { ...source, revision: '' },
    { ...source, cues: [...source.cues, source.cues[0]] },
    { ...source, cues: [{ ...source.cues[0], kind: 'optional' }] },
    { ...source, cues: [{ ...source.cues[0], rightsStatus: 'retained_locally' }] },
    { ...source, cues: [{ ...source.cues[0], contentStatus: 'CL-0' }] },
    { ...source, cues: [{ id: 'coach-a', kind: 'coaching' }] },
    { ...source, cues: [{ ...source.cues[0], source: { ...source.cues[0]!.source, sha256: 'missing' } }] },
  ]) assert.throws(() => createCuePreferenceValidator(input), CatalogQualificationError);
  let invoked = false;
  const accessor = { ...source };
  Object.defineProperty(accessor, 'cues', { enumerable: true, get() { invoked = true; return source.cues; } });
  assert.throws(() => createCuePreferenceValidator(accessor), CatalogQualificationError);
  assert.equal(invoked, false);
  const validator = createCuePreferenceValidator(source);
  const request = empty();
  Object.defineProperty(request, 'kept', { enumerable: true, get() { invoked = true; return []; } });
  assert.throws(() => validator.validate(request), CatalogQualificationError);
  assert.equal(invoked, false);
});

test('policy and validated preferences are isolated from input mutation', () => {
  const original = policy();
  const validator = createCuePreferenceValidator(original);
  Object.assign(original.cues[0]!, { kind: 'safety' });
  const request = { ...empty(), kept: ['coach-a'], order: ['coach-a'] };
  const result = validator.validate(request);
  request.kept[0] = 'tech';
  assert.deepEqual(result.preferences.kept, ['coach-a']);
  assert.throws(() => Object.assign(result.preferences.order, { 0: 'tech' }), TypeError);
  assert.throws(() => Object.assign(validator.policy.cues[0]!, { rightsStatus: 'restricted' }), TypeError);
  assert.equal(validator.policy.cues[0]!.kind, 'coaching');
});
