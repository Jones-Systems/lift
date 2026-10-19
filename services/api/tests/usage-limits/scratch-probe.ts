import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { actor, fixture, intent } from './fixture.js';

test('owned fixture probe', async t => {
  const f = fixture(t);
  f.ledger.usage.reserve(actor, intent('scratch-probe'));
  await new Promise<void>((resolve, reject) => process.send!({ root: f.root }, error => {
    process.disconnect(); if (error) reject(error); else resolve();
  }));
  if (process.argv[2] === 'failure') throw new Error('intentional scratch probe failure');
  if (process.argv[2] === 'cancel') await setTimeout(10_000);
});
