import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Domain } from '../../src/domain.js';
import { migrations } from '../../src/storage.js';
import { profileFields, profilePatch, onboardingPatch, type Profile } from '../../src/schemas.js';

function fixture(run: (domain: Domain, accountId: string) => void) {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrations) db.exec(migration.sql);
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)')
      .run('training-subject', 'Synthetic', 'training@synthetic.invalid', 1, 1);
    const domain = new Domain(db);
    run(domain, domain.account('training-subject', 'Synthetic'));
  } finally { db.close(); }
}

test('training context accepts trimmed optional text and rejects null or over 4000 characters', () => {
  assert.equal(profilePatch.parse({ expectedRevision: 0, trainingContext: '  Training context  ' }).trainingContext, 'Training context');
  assert.equal(profilePatch.parse({ expectedRevision: 0, trainingContext: '  ' }).trainingContext, '');
  assert.equal(profilePatch.parse({ expectedRevision: 0, trainingContext: 'a'.repeat(4000) }).trainingContext?.length, 4000);
  for (const trainingContext of [null, 42, {}, 'a'.repeat(4001)]) {
    assert.equal(profilePatch.safeParse({ expectedRevision: 0, trainingContext }).success, false);
    assert.equal(onboardingPatch.safeParse({ expectedRevision: 0, step: 'background', answers: { trainingContext } }).success, false);
  }
});

test('profile context omission preserves stored or legacy missing data and empty text clears explicitly', () => fixture((domain, id) => {
  const read = () => domain.document<Profile>(id, 'profile');
  assert.equal(Object.hasOwn(read(), 'trainingContext'), false);
  const { revision: _initialRevision, ...legacy } = read();
  assert.equal(profileFields.safeParse(legacy).success, true);
  domain.patchDocument<Profile>(id, 'profile', profilePatch.parse({ expectedRevision: 0, name: 'Updated' }));
  assert.equal(Object.hasOwn(read(), 'trainingContext'), false);
  domain.patchDocument<Profile>(id, 'profile', profilePatch.parse({ expectedRevision: 1, trainingContext: '  Prefer mornings  ', injuryHistory: 'Separate history' }));
  assert.equal(read().trainingContext, 'Prefer mornings');
  domain.patchDocument<Profile>(id, 'profile', profilePatch.parse({ expectedRevision: 2, goals: ['Strength'] }));
  assert.equal(read().trainingContext, 'Prefer mornings');
  assert.throws(() => domain.patchDocument<Profile>(id, 'profile', profilePatch.parse({ expectedRevision: 2, trainingContext: 'stale' })), { code: 'stale_revision' });
  domain.patchDocument<Profile>(id, 'profile', profilePatch.parse({ expectedRevision: 3, trainingContext: '' }));
  assert.equal(read().trainingContext, ''); assert.equal(read().injuryHistory, 'Separate history');
}));

test('onboarding context merges answers with revision checks and completes into the profile', () => fixture((domain, id) => {
  domain.patchDocument<Profile>(id, 'profile', profilePatch.parse({ expectedRevision: 0, injuryHistory: 'Separate history' }));
  const first = domain.patchOnboarding(id, onboardingPatch.parse({ expectedRevision: 0, step: 'background', answers: { trainingContext: '  Early sessions  ' } }));
  assert.equal(first.answers.trainingContext, 'Early sessions');
  const next = domain.patchOnboarding(id, onboardingPatch.parse({ expectedRevision: 1, step: 'goals', answers: { goals: ['Strength'] } }));
  assert.equal(next.answers.trainingContext, 'Early sessions');
  assert.throws(() => domain.patchOnboarding(id, onboardingPatch.parse({ expectedRevision: 1, step: 'background', answers: { trainingContext: 'stale' } })), { code: 'stale_revision' });
  domain.db.transaction(() => domain.completeOnboarding(id, 2)).immediate();
  const profile = domain.document<Profile>(id, 'profile');
  assert.equal(profile.trainingContext, 'Early sessions'); assert.equal(profile.injuryHistory, 'Separate history');
  assert.deepEqual(profile.goals, ['Strength']);
}));

test('onboarding explicit empty context clears a previously saved profile context', () => fixture((domain, id) => {
  domain.patchDocument<Profile>(id, 'profile', profilePatch.parse({ expectedRevision: 0, trainingContext: 'Earlier context' }));
  domain.patchOnboarding(id, onboardingPatch.parse({ expectedRevision: 0, step: 'background', answers: { trainingContext: '  ' } }));
  domain.db.transaction(() => domain.completeOnboarding(id, 1)).immediate();
  assert.equal(domain.document<Profile>(id, 'profile').trainingContext, '');
}));
