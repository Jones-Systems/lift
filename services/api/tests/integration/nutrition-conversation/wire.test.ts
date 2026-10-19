import assert from 'node:assert/strict';
import test from 'node:test';
import { nutritionEnvelope, nutritionSubmit, nutritionSelection } from '../../../src/integration/nutrition-conversation/wire.js';
import { envelope, input } from './fixturewire.js';

test('strict wire rejects actor selectors, invalid schema/UUID and invalid native choice without rewriting text', () => {
  for (const extra of [{ accountId: 'other' }, { epoch: 1 }, { schema: 'other' }, { requestId: 'not-uuid' }])
    assert.equal(nutritionEnvelope.safeParse({ ...envelope(), ...extra }).success, false);
  const original = { ...envelope(), input: { ...input(), question: '  strength  ', userContext: ['  exact context  '] } };
  assert.deepEqual(nutritionSubmit.parse(original), original);
  for (const extra of [{ choice: 'automatic' }, { correction: 'not a correction choice' }, { previousTurnId: 0 }, { question: '' }, { unknown: true }])
    assert.equal(nutritionSubmit.safeParse({ ...envelope(), input: { ...input(), ...extra } }).success, false);
});
test('UTF-8 byte and context limits reject instead of truncating', () => {
  const valid = (extra: object) => nutritionSubmit.safeParse({ ...envelope(), input: { ...input(), ...extra } }).success;
  assert.equal(valid({ question: 'é'.repeat(1000) }), true);
  assert.equal(valid({ question: 'é'.repeat(1001) }), false);
  assert.equal(valid({ userContext: Array(8).fill('x'.repeat(1000)) }), true);
  assert.equal(valid({ userContext: Array(9).fill('x'.repeat(1000)) }), false);
  assert.equal(valid({ userContext: Array(17).fill('x') }), false);
  assert.equal(valid({ userContext: ['é'.repeat(501)] }), false);
  assert.equal(valid({ choice: 'update-context', correction: 'é'.repeat(1001) }), false);
  assert.equal(nutritionSelection.safeParse({ ...envelope(), input: { parentTurnId: 1, statementId: 'é'.repeat(65) } }).success, false);
});
