import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Domain } from '../../src/domain.js';
import { DomainError } from '../../src/errors.js';
import { createCanonicalAccountWriter } from '../../src/integration/account-modules/canonical-writer.js';
import { createPlanRevisionPort } from '../../src/planning/plan-revision-port.js';
import { createWearablePersistence, wearablePersistenceSql } from '../../src/wearables/persistence/index.js';
import { createWearablesService } from '../../src/wearables/service.js';
import type { PlanRevisionPort, Suggestion } from '../../src/wearables/types.js';
import { fixture as accountFixture } from '../integration/account-modules/fixture.js';

function fixture(t: TestContext) {
  const f = accountFixture(); t.after(f.close);
  const domain = new Domain(f.db), writer = createCanonicalAccountWriter(f.db);
  const port = createPlanRevisionPort(domain, writer);
  const within = <T>(effect: () => T): T => writer.lifecycle.withActiveWrite(f.one, effect);
  f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)')
    .run('exercise', JSON.stringify({ id: 'exercise', name: 'Synthetic', cues: [], requiredConstraints: [] }));
  const before = [{ id: 'item', exerciseId: 'exercise', setTarget: 3, repMin: 8, repMax: 12, targetKg: 0 }];
  const after = [{ ...before[0]!, setTarget: 2 }];
  const plan = within(() => domain.createPlan(f.one.accountId, { name: 'Synthetic', minutes: 20, items: before }));
  const accept = { planId: plan.id, expectedRevision: 1, items: after,
    receipt: { operation: 'suggestion_accept' as const, suggestionId: 'suggestion' } };
  const undo = { planId: plan.id, expectedRevision: 2, items: before,
    receipt: { operation: 'suggestion_undo' as const, suggestionId: 'suggestion' } };
  const apply = (input: Parameters<PlanRevisionPort['applyWithinWrite']>[1]) =>
    within(() => port.applyWithinWrite(f.one, input));
  const receipts = () => f.db.prepare("SELECT * FROM command_receipts WHERE operation LIKE 'plan.suggestion_%' ORDER BY operation,key").all();
  return { ...f, domain, writer, port, within, before, after, plan, accept, undo, apply, receipts };
}

test('PATCH and suggestions share revision history; undo appends and leaves old workout snapshots immutable', t => {
  const f = fixture(t);
  const session = f.within(() => f.domain.startSession(f.one.accountId, f.plan.id, 1));
  const snapshot = structuredClone(session.planSnapshot), old = f.domain.planRevision(f.one.accountId, f.plan.id, 1);
  assert.equal(f.within(() => f.port.readWithinWrite(f.one, f.plan.id)).activeWorkout, true);
  assert.throws(() => f.apply(f.accept), /workout_in_progress/);
  // Existing PATCH behavior permits saved-plan edits without mutating the workout.
  f.domain.patchPlan(f.one.accountId, f.plan.id, { expectedRevision: 1, name: 'Edited' });
  assert.deepEqual(f.domain.session(f.one.accountId, session.id).planSnapshot, snapshot);
  f.within(() => f.domain.completeSession(f.one.accountId, session.id, session.revision));
  assert.throws(() => f.apply(f.accept), (error: unknown) =>
    error instanceof DomainError && error.status === 409 && error.code === 'stale_revision' &&
    typeof error.details === 'object' && error.details !== null &&
    'revision' in error.details && error.details.revision === 2);
  assert.deepEqual(f.receipts(), []);
  const accept = { ...f.accept, expectedRevision: 2 };
  assert.deepEqual(f.apply(accept), { revision: 3 });
  assert.deepEqual(f.apply({ ...f.undo, expectedRevision: 3 }), { revision: 4 });
  assert.deepEqual(f.domain.planRevision(f.one.accountId, f.plan.id, 1), old);
  assert.deepEqual(f.domain.session(f.one.accountId, session.id).planSnapshot, snapshot);
  assert.deepEqual(f.domain.planRevision(f.one.accountId, f.plan.id, 3).items, f.after);
  assert.deepEqual(f.domain.planRevision(f.one.accountId, f.plan.id, 4).items, f.before);
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).name, 'Edited');
});

test('exact accept/undo retries and lost-response recovery use durable receipts without additional revisions', t => {
  const f = fixture(t);
  f.apply(f.accept); // Commit completed, but the simulated caller discards its response.
  const reopenedPort = createPlanRevisionPort(new Domain(f.db), f.writer);
  const committed = f.receipts();
  assert.deepEqual(f.within(() => reopenedPort.applyWithinWrite(f.one, f.accept)), { revision: 2 });
  assert.deepEqual(f.receipts(), committed);
  assert.throws(() => f.apply({ ...f.accept, items: f.before }), /idempotency_mismatch/);
  assert.deepEqual(f.apply(f.undo), { revision: 3 });
  assert.deepEqual(f.apply(f.undo), { revision: 3 });
  assert.deepEqual(f.apply(f.accept), { revision: 2 });
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 3);
  const lineage = f.db.prepare('SELECT operation,result FROM command_receipts ORDER BY operation').all() as { operation: string; result: string }[];
  assert.deepEqual(lineage.map(row => JSON.parse(row.result)), [
    { planId: f.plan.id, fromRevision: 1, toRevision: 2, undoOf: null },
    { planId: f.plan.id, fromRevision: 2, toRevision: 3, undoOf: 'suggestion' },
  ]);
});

test('undo requires exact accepted result and compensating items; an intervening edit cannot be overwritten', t => {
  const f = fixture(t);
  assert.throws(() => f.apply(f.undo), /plan_changed_since_apply/);
  f.apply(f.accept);
  assert.throws(() => f.apply({ ...f.undo, items: f.after }), /plan_changed_since_apply/);
  f.domain.patchPlan(f.one.accountId, f.plan.id, { expectedRevision: 2, name: 'Intervening' });
  assert.throws(() => f.apply(f.undo), /plan_changed_since_apply/);
  assert.throws(() => f.apply({ ...f.undo, expectedRevision: 3 }), /plan_changed_since_apply/);
  assert.equal(f.receipts().length, 1);
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).name, 'Intervening');
});

test('undo also rejects changed current items even when a faulty writer left the revision unchanged', t => {
  const f = fixture(t); f.apply(f.accept);
  const data = f.db.prepare('SELECT data FROM plans WHERE account_id=? AND id=?')
    .get(f.one.accountId, f.plan.id) as { data: string };
  const changed = JSON.parse(data.data) as { items: typeof f.before };
  changed.items = f.before;
  f.db.prepare('UPDATE plans SET data=? WHERE account_id=? AND id=?')
    .run(JSON.stringify(changed), f.one.accountId, f.plan.id);
  assert.throws(() => f.apply(f.undo), /plan_changed_since_apply/);
  assert.equal(f.receipts().length, 1);
});

test('same suggestion key on another plan is a collision; outer failure rolls back mutation, history and receipt', t => {
  const f = fixture(t);
  assert.throws(() => f.within(() => {
    f.port.applyWithinWrite(f.one, f.accept);
    throw Error('synthetic rollback');
  }), /synthetic rollback/);
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 1);
  assert.deepEqual(f.receipts(), []);
  assert.throws(() => f.domain.planRevision(f.one.accountId, f.plan.id, 2), /not_found/);
  f.apply(f.accept);
  const other = f.within(() => f.domain.createPlan(f.one.accountId, { name: 'Other', minutes: 20, items: f.before }));
  assert.throws(() => f.apply({ ...f.accept, planId: other.id }), /idempotency_mismatch/);
  assert.equal(f.domain.plan(f.one.accountId, other.id).revision, 1);
});

test('port requires exact writer/database/actor and denies foreign, archived and source plans', t => {
  const f = fixture(t), otherDb = fixture(t);
  assert.throws(() => f.port.readWithinWrite(f.one, f.plan.id), /canonical_writer_unproved/);
  assert.throws(() => f.db.transaction(() => f.port.applyWithinWrite(f.one, f.accept)).immediate(), /canonical_writer_unproved/);
  const wrongDb = createPlanRevisionPort(otherDb.domain, f.writer);
  assert.throws(() => f.within(() => wrongDb.readWithinWrite(f.one, f.plan.id)), /canonical_writer_unproved/);
  assert.throws(() => f.within(() => f.port.applyWithinWrite(f.two, f.accept)), /canonical_writer_unproved/);
  assert.throws(() => f.writer.lifecycle.withActiveWrite(f.two, () => f.port.applyWithinWrite(f.two, f.accept)), /not_found/);
  f.within(() => f.domain.archivePlan(f.one.accountId, f.plan.id, 1));
  assert.throws(() => f.apply({ ...f.accept, expectedRevision: 2 }), /plan_archived/);
  assert.throws(() => f.within(() => f.port.readWithinWrite(f.one, f.plan.id)), /plan_archived/);
  // Valid stored source shape is deliberately read-only here; no schema coercion.
  const source = {
    schema: 'form.source-prescription-plan/v1', name: 'Source',
    origin: { kind: 'form-adaptation', id: 'synthetic', revision: 'v1' },
    duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 },
    items: [{ id: 'source-item', native: { exercise_id: 'native', movement_pattern: 'synthetic', role: 'synthetic', sets: 2, rest_seconds: 60 },
      registeredDomain: { exerciseId: 'exercise', variantId: 'synthetic:variant',
        identity: { repository: 'synthetic/repository', revision: 'v1', path: 'catalog.json', sha256: 'a'.repeat(64), nativeId: 'native' },
        registration: { id: 'synthetic', revision: 'v1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
      load: { kind: 'unspecified', basis: 'unknown' } }],
  };
  f.db.prepare('INSERT INTO plans VALUES(?,?,1,0,?,?,?)')
    .run(f.one.accountId, 'source-plan', JSON.stringify(source), new Date().toISOString(), new Date().toISOString());
  assert.throws(() => f.within(() => f.port.readWithinWrite(f.one, 'source-plan')), /source_plan_legacy_edit_denied/);
  assert.throws(() => f.apply({ ...f.accept, planId: 'source-plan' }), /source_plan_legacy_edit_denied/);
});

test('receipt replay still checks session, epoch and suppression authority', t => {
  const f = fixture(t); f.apply(f.accept);
  const committed = f.receipts();
  const now = Date.now();
  f.db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run('fresh-session', f.one.authUserId, 'synthetic-fresh-token', now + 600000, now, now);
  const fresh = { ...f.one, sessionId: 'fresh-session' };
  assert.throws(() => f.writer.lifecycle.withActiveWrite(fresh,
    () => f.port.applyWithinWrite(fresh, f.accept)), /idempotency_mismatch/);
  assert.throws(() => f.writer.lifecycle.withActiveWrite({ ...f.one, epoch: 1 },
    () => f.port.applyWithinWrite({ ...f.one, epoch: 1 }, f.accept)), /account_epoch_changed/);
  assert.throws(() => f.writer.lifecycle.withActiveWrite({ ...f.one, sessionId: f.two.sessionId },
    () => f.port.applyWithinWrite({ ...f.one, sessionId: f.two.sessionId }, f.accept)), /account_session_invalid/);
  f.ledger.recordDisable({ accountId: f.one.accountId, authUserId: f.one.authUserId, epoch: 1,
    requestId: 'synthetic-delete', disabledAtMs: Date.now() });
  assert.throws(() => f.apply(f.accept), /account_disabled/);
  assert.deepEqual(f.receipts(), committed);
});

test('joined wearable consumer commits suggestion, plan and both receipts in one canonical transaction', t => {
  const f = fixture(t); f.db.exec(wearablePersistenceSql);
  const persistence = createWearablePersistence({ db: f.db, lifecycle: f.writer.lifecycle, control: f.writer,
    assertImportAllowed: () => {} });
  const service = createWearablesService({ ...f.writer.lifecycle, store: persistence.store, plans: f.port,
    enabled: () => true, now: () => '2026-10-01T00:00:00Z', assertImportAllowed: () => {}, assertSuggestionAllowed: () => {} });
  const suggestion: Suggestion = { id: 'suggestion', planId: f.plan.id, baseRevision: 1, appliedRevision: null,
    state: 'pending', beforeItems: f.before, afterItems: f.after, reviewDigest: 'synthetic-review',
    expiresAt: '2026-11-01T00:00:00Z', reason: 'Synthetic fixture', limits: ['No physiological qualification'],
    policyVersion: 'synthetic', evidenceRefs: [] };
  f.within(() => persistence.store.putSuggestion(f.one, suggestion));
  const review = { expectedPlanRevision: 1, reviewDigest: suggestion.reviewDigest };
  assert.throws(() => f.within(() => {
    service.suggestion(f.one, 'accept', suggestion.id, 'accept', review);
    throw Error('joined rollback');
  }), /joined rollback/);
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 1);
  assert.equal(persistence.store.suggestion(f.one, suggestion.id)?.state, 'pending');
  assert.deepEqual(f.receipts(), []);
  const accepted = service.suggestion(f.one, 'accept', suggestion.id, 'accept', review);
  assert.deepEqual(service.suggestion(f.one, 'accept', suggestion.id, 'accept', review), accepted);
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 2);
  service.suggestion(f.one, 'undo', suggestion.id, 'undo', { ...review, expectedPlanRevision: 2 });
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 3);
  assert.equal(persistence.store.suggestion(f.one, suggestion.id)?.state, 'undone');
});
