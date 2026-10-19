import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackSessionSourceReader } from '../../src/training-feedback/session-source.ts';

const context = { accountId: 'account-a', authUserId: 'auth-a', sessionId: 'login-a', epoch: 3 };
const selection = { sessionId: 'workout-a', occurrenceId: 'occurrence-a' };

function session() {
  const target = { id: 'item-a', exerciseId: 'exercise-a', setTarget: 3, repMin: 5, repMax: 8, targetKg: 20 };
  const createdAt = '2026-10-11T12:00:00Z';
  return { id: 'workout-a', revision: 6, planId: 'plan-a', planRevision: 2, status: 'completed',
    planSnapshot: { name: 'Historical plan', minutes: 30, items: [target] },
    occurrences: [
      { id: 'occurrence-a', itemId: 'item-a', exerciseId: 'exercise-a', position: 0, target },
      { id: 'occurrence-b', itemId: 'item-b', exerciseId: 'exercise-b', position: 1,
        target: { ...target, id: 'item-b', exerciseId: 'exercise-b' } },
    ],
    sets: [
      { id: 'set-confirmed', revision: 2, occurrenceId: 'occurrence-a', setNumber: 1, reps: 6, weightKg: 15, status: 'confirmed', createdAt, updatedAt: createdAt },
      { id: 'set-other-occurrence', revision: 1, occurrenceId: 'occurrence-b', setNumber: 1, reps: 8, weightKg: 10, status: 'confirmed', createdAt, updatedAt: createdAt },
      { id: 'set-draft', revision: 1, occurrenceId: 'occurrence-a', setNumber: 2, reps: 0, weightKg: 15, status: 'draft', createdAt, updatedAt: createdAt },
      { id: 'set-voided', revision: 3, occurrenceId: 'occurrence-a', setNumber: 3, reps: 5, weightKg: 15, status: 'voided', createdAt, updatedAt: createdAt },
    ],
    startedAt: createdAt, completedAt: '2026-10-11T12:30:00Z' };
}

function fixture() {
  const current = session();
  let denial = null;
  let readError = null;
  let inSnapshot = false;
  const calls = [];
  const reader = createFeedbackSessionSourceReader({
    withReadSnapshot(actor, read) {
      calls.push(['snapshot-enter', actor]);
      if (denial) throw denial;
      inSnapshot = true;
      try { return read(); }
      finally { inSnapshot = false; calls.push(['snapshot-exit']); }
    },
    domain: { session(accountId, id) {
      assert.equal(inSnapshot, true);
      calls.push(['session', accountId, id]);
      if (readError) throw readError;
      return current;
    } },
  });
  return { reader, calls, get session() { return current; },
    deny(error) { denial = error; }, failRead(error) { readError = error; } };
}

test('source witness reads authenticated account and actual session inside the released snapshot port', () => {
  const f = fixture();
  const witness = f.reader.read(context, selection);
  assert.deepEqual(f.calls, [['snapshot-enter', context], ['session', 'account-a', 'workout-a'], ['snapshot-exit']]);
  assert.deepEqual(witness.source, { accountId: 'account-a', kind: 'session', id: 'workout-a', revision: 6, itemId: 'occurrence-a' });
  assert.deepEqual(witness.occurrence, { id: 'occurrence-a', itemId: 'item-a', exerciseId: 'exercise-a' });
  assert.equal(witness.sessionStatus, 'completed');
});

test('selected occurrence retains actual set IDs, revisions and all statuses without importing other sets or targets', () => {
  const f = fixture();
  const witness = f.reader.read(context, selection);
  assert.deepEqual(witness.sets, [
    { id: 'set-confirmed', revision: 2, status: 'confirmed' },
    { id: 'set-draft', revision: 1, status: 'draft' },
    { id: 'set-voided', revision: 3, status: 'voided' },
  ]);
  const second = f.reader.read(context, { ...selection, occurrenceId: 'occurrence-b' });
  assert.deepEqual(second.sets, [{ id: 'set-other-occurrence', revision: 1, status: 'confirmed' }]);
  assert.equal(second.source.itemId, 'occurrence-b');
  assert.deepEqual(Object.keys(witness).sort(), ['occurrence', 'planSnapshot', 'sessionStatus', 'sets', 'source']);
});

test('missing selected occurrence never returns a witness for another occurrence', () => {
  const f = fixture();
  assert.throws(() => f.reader.read(context, { ...selection, occurrenceId: 'missing' }),
    error => error instanceof RangeError && error.message === 'feedback_occurrence_missing');
  assert.deepEqual(f.calls.at(-1), ['snapshot-exit']);
});

test('snapshot denial propagates the original error before any source read', () => {
  const f = fixture();
  const denied = new Error('synthetic-account-disabled');
  f.deny(denied);
  assert.throws(() => f.reader.read(context, selection), error => error === denied);
  assert.deepEqual(f.calls, [['snapshot-enter', context]]);
});

test('deleted or unavailable session reads propagate without an earlier successful witness fallback', () => {
  const f = fixture();
  const first = f.reader.read(context, selection);
  for (const message of ['synthetic-not-found', 'synthetic-session-denied']) {
    const failure = new Error(message);
    f.failRead(failure);
    assert.throws(() => f.reader.read(context, selection), error => error === failure);
  }
  assert.equal(first.source.revision, 6);
  assert.equal(f.calls.filter(call => call[0] === 'session').length, 3);
});

test('completed-session corrections and voids expose new source and set revisions on every read', () => {
  const f = fixture();
  const before = f.reader.read(context, selection);
  f.session.revision++;
  f.session.sets[0].revision++;
  f.session.sets[0].reps = 7;
  const corrected = f.reader.read(context, selection);
  assert.equal(corrected.source.revision, before.source.revision + 1);
  assert.equal(corrected.sets[0].revision, before.sets[0].revision + 1);
  assert.equal(corrected.sessionStatus, 'completed');
  f.session.revision++;
  f.session.sets[0].revision++;
  f.session.sets[0].status = 'voided';
  const voided = f.reader.read(context, selection);
  assert.equal(voided.source.revision, corrected.source.revision + 1);
  assert.equal(voided.sets[0].revision, corrected.sets[0].revision + 1);
  assert.equal(voided.sets[0].status, 'voided');
  assert.equal(before.sets[0].status, 'confirmed');
});

test('historical plan identity comes only from the session snapshot, without current-plan or performed-identity inference', () => {
  const f = fixture();
  const witness = f.reader.read(context, { ...selection, planId: 'client-plan', planRevision: 99,
    accountId: 'client-account', revision: 99, token: 'client-token', variantId: 'client-variant' });
  assert.deepEqual(witness.planSnapshot, { planId: 'plan-a', planRevision: 2 });
  assert.equal(witness.source.accountId, 'account-a');
  assert.equal(witness.source.revision, 6);
  assert.equal(Object.hasOwn(witness, 'token'), false);
  assert.equal(Object.hasOwn(witness.occurrence, 'variantId'), false);
  assert.equal(f.calls.filter(call => call[0] === 'session').length, 1);
});

test('returned witness, input session and later witnesses have no shared mutable objects', () => {
  const f = fixture();
  const original = structuredClone(f.session);
  const first = f.reader.read(context, selection);
  first.source.revision = 500;
  first.planSnapshot.planRevision = 500;
  first.occurrence.exerciseId = 'changed';
  first.sets[0].status = 'voided';
  first.sets.push({ id: 'invented', revision: 1, status: 'confirmed' });
  assert.deepEqual(f.session, original);
  const next = f.reader.read(context, selection);
  assert.equal(next.source.revision, 6);
  assert.equal(next.planSnapshot.planRevision, 2);
  assert.equal(next.occurrence.exerciseId, 'exercise-a');
  assert.equal(next.sets.length, 3);
  f.session.sets[0].revision = 10;
  assert.equal(next.sets[0].revision, 2);
});

test('an occurrence without sets yields an empty source witness rather than invented work', () => {
  const f = fixture();
  f.session.status = 'active';
  f.session.sets = [];
  const witness = f.reader.read(context, selection);
  assert.deepEqual(witness.sets, []);
  assert.equal(witness.sessionStatus, 'active');
});
