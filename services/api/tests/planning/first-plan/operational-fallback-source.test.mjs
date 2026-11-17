import test from 'node:test';
import assert from 'node:assert/strict';
import { createFallbackFirstPlanSource } from '../../../src/planning/first-plan/operational-fallback-source.ts';

// Public-safe negative seam: no retained catalog, acceptance metadata, installed rows or R1 authority.
const actor = { accountId: 'account-a', sessionId: 'session-a', authUserId: 'user-a', epoch: 0 };
const context = { accountId: actor.accountId,
  profile: { revision: 0, goals: [], trainingBackground: null, injuryHistory: '' },
  preferences: { revision: 0, equipment: ['bodyweight', 'wall', 'machine'], sessionMinutes: 25, trainingDaysPerWeek: 2 } };

test('missing, malformed and unaccepted registration cannot reach metadata or capture authority', async () => {
  for (const registration of [null, {}, { acceptedPins: [], input: { legacyBytes: new Uint8Array(), registrationBytes: null } }]) {
    const source = createFallbackFirstPlanSource({ registration: () => registration,
      captureHost() { assert.fail('No bound registration'); }, acceptedMetadata() { assert.fail('No bound registration'); } });
    assert.equal(await source.capture(actor, context), null);
    assert.equal(source.readCurrent(actor, context), null);
  }
});

test('registration thenables fail closed and consume rejection without asynchronous currentness', async () => {
  for (const registration of [() => Promise.reject(new Error('Synthetic rejected registration')),
    () => ({ then(_resolve, reject) { reject(new Error('Synthetic rejected thenable')); } }),
    () => { throw new Error('Synthetic port failure'); }]) {
    const source = createFallbackFirstPlanSource({ registration,
      captureHost() { assert.fail('Synchronous registration required'); }, acceptedMetadata() { assert.fail('No metadata authority'); } });
    assert.equal(await source.capture(actor, context), null);
    assert.equal(source.readCurrent(actor, context), null);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('foreign account and replaced port identities cannot acquire capture authority', async () => {
  let registrations = 0;
  const ports = { registration() { registrations++; return null; }, captureHost: () => null, acceptedMetadata: () => null };
  const source = createFallbackFirstPlanSource(ports);
  assert.equal(await source.capture({ ...actor, accountId: 'foreign' }, context), null);
  assert.equal(registrations, 0);
  ports.registration = () => { assert.fail('Replaced port'); };
  assert.equal(await source.capture(actor, context), null);
  assert.equal(source.readCurrent(actor, context), null);
});
