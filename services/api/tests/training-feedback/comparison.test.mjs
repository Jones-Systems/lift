import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrations } from '../../src/storage.ts';
import { Domain } from '../../src/domain.ts';
import { DomainError } from '../../src/errors.ts';
import { lifecycleMigration } from '../../src/lifecycle/migration.ts';
import { assertActive, withActiveWrite, bindSuppressionAuthority } from '../../src/lifecycle/guards.ts';
import { createProgressComparisonService } from '../../src/progress-comparison/service.ts';
import { progressComparisonMigrationSql } from '../../src/progress-comparison/migration.ts';
import { createFeedbackSessionSourceReader } from '../../src/training-feedback/session-source.ts';
import { createSqliteFeedbackLedgerStore } from '../../src/training-feedback/ledger-store.ts';
import { createFeedbackLedgerService } from '../../src/training-feedback/ledger-service.ts';
import { feedbackMigrationSql, feedbackOwnedTables } from '../../src/training-feedback/migration.ts';

const code = expected => error => error instanceof DomainError && error.code === expected;
const refs = id => [{ sourceId: `synthetic-${id}`, revision: '1', locator: `comparison.test.mjs#${id}`,
  qualification: 'Synthetic integration fixture only; no clinical or prescription authority' }];
const identity = { variantId: 'fixture-variant', equipmentId: 'fixture-equipment', laterality: 'bilateral', loadBasis: 'total' };

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  for (const migration of migrations.filter(item => item.version <= 7)) db.exec(migration.sql);
  db.exec(lifecycleMigration.sql); db.exec(progressComparisonMigrationSql); db.exec(feedbackMigrationSql);
  bindSuppressionAuthority(db, { currentSequence: () => 0, lookup: () => null, reconcileRestore: () => 0,
    recordDisable() { throw new Error('fixture has no suppression writer'); } });
  db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)')
    .run('fixture-auth', 'Fixture', 'fixture@example.invalid');
  const domain = new Domain(db), accountId = domain.account('fixture-auth', 'Fixture');
  const context = { accountId, authUserId: 'fixture-auth', sessionId: 'fixture-login', epoch: 0 };
  db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,0,0,?)')
    .run(context.sessionId, 8_000_000_000_000, 'synthetic-login', context.authUserId);
  db.prepare('INSERT INTO exercises VALUES (?,?,0)').run('fixture-exercise', JSON.stringify({ id: 'fixture-exercise', name: 'Fixture exercise', cues: [] }));
  const plan = domain.createPlan(accountId, { name: 'Fixture plan', minutes: 30,
    items: [{ id: 'fixture-item', exerciseId: 'fixture-exercise', setTarget: 1, repMin: 4, repMax: 8, targetKg: 10 }] });
  const work = {};
  for (const [side, reps] of [['baseline', 5], ['current', 7]]) {
    const session = domain.startSession(accountId, plan.id, plan.revision);
    const set = domain.createSet(accountId, session.id, { occurrenceId: session.occurrences[0].id, expectedRevision: 1,
      setNumber: 1, reps, weightKg: 10, status: 'confirmed' }).set;
    const completed = domain.completeSession(accountId, session.id, 2);
    work[side] = { session: completed, set, selection: { kind: 'session', id: session.id, itemId: session.occurrences[0].id } };
  }
  let writerStarts = 0, associationAllowed = true, associationRevision = 1, contextAllowed = true, eventSequence = 0;
  const assertWriter = ctx => { assert.equal(db.inTransaction, true); assert.deepEqual(ctx, context); assertActive(db, ctx); };
  const lifecycle = { assertActive: ctx => assertActive(db, ctx), withActiveWrite(ctx, effect) {
    assert.equal(db.inTransaction, false, 'no nested consumer writer'); writerStarts++; return withActiveWrite(db, ctx, effect);
  } };
  const progressDeps = {
    db, domain,
    assertIdentityAllowed(ctx, input) { assert.deepEqual(ctx, context); assert.equal(input.source.accountId, accountId); },
    assertPersistable(ctx) { assert.deepEqual(ctx, context); },
    comparisonBindingFor(ctx, record) {
      assert.deepEqual(ctx, context);
      return { source: record.source, revision: record.revision, confirmed: true, identity: record.data.identity };
    },
    assertComparisonContextWithinWrite(ctx, input) {
      assertWriter(ctx);
      if (!contextAllowed || input.contextId !== 'fixture-context') throw new DomainError(403, 'fixture_context_unproved');
      for (const side of ['baseline', 'current']) {
        assert.equal(input[side].source.accountId, accountId);
        assert.equal(input[side].source.id, work[side].selection.id);
        assert.equal(input[side].source.itemId, work[side].selection.itemId);
        assert.equal(input[side].session.planId, plan.id);
        assert.equal(input[side].session.planRevision, 1);
      }
    },
    lifecycleControl: { assertSuppression() { throw new Error('fixture suppression unavailable'); },
      purgeReadiness: () => ({ status: 'unavailable', reason: 'fixture_purge_unavailable' }) },
  };
  const progress = createProgressComparisonService(progressDeps);
  const confirmIdentity = (side, changedIdentity = identity) => {
    const source = work[side].selection, previous = progress.identity(context, source);
    return progress.confirm(context, `identity-${side}-${previous?.revision ?? 0}`, { source,
      expectedSourceRevision: domain.session(accountId, source.id).revision, expectedBindingRevision: previous?.revision ?? 0,
      identity: changedIdentity, provenance: { kind: 'user_reported' }, confirmed: true });
  };
  confirmIdentity('baseline'); confirmIdentity('current');
  const sourceReader = createFeedbackSessionSourceReader({ domain, withReadSnapshot(ctx, effect) { assertWriter(ctx); return effect(); } });
  const selection = { sessionId: work.current.selection.id, occurrenceId: work.current.selection.itemId };
  const scope = { kind: 'session', contextId: 'fixture-context', sessionId: selection.sessionId, planId: plan.id };
  const calls = [], authority = new Map([['comparison', true], ['summary', true], ['later', false]]);
  const recipes = [
    { id: 'comparison', version: '1', kind: 'history', scope, sourceIds: ['feedback'], dependsOn: [], sourceRefs: refs('comparison'),
      qualifications: ['Observed work only'], comparisonIds: ['selected-work'], compute({ comparisons }) {
        calls.push(structuredClone(comparisons)); return { observedRepetitionDifference: comparisons['selected-work'].result.delta.repetitions };
      } },
    { id: 'summary', version: '1', kind: 'summary', scope, sourceIds: [], dependsOn: ['comparison'], sourceRefs: refs('summary'),
      qualifications: ['Synthetic summary'], compute({ parents, comparisons }) { assert.deepEqual(comparisons, {}); return parents[0].value; } },
    { id: 'later', version: '1', kind: 'recommendation', scope, sourceIds: [], dependsOn: ['summary'], sourceRefs: refs('later'),
      qualifications: ['No adopted rule'], compute() { throw new Error('unqualified prescription must not compute'); } },
  ];
  const registry = { schema: 'feedback-comparison-inputs-v1', version: 'fixture-registry-1', inputs: [
    { id: 'selected-work', contextId: 'fixture-context', selections: structuredClone({ baseline: work.baseline.selection, current: work.current.selection }) },
  ] };
  const store = createSqliteFeedbackLedgerStore({ db, lifecycle, assertWithinWrite: assertWriter });
  const deps = { store, lifecycle, derivations: recipes, comparisonRegistry: registry,
    derivationAuthorityWithinWrite: (_ctx, recipe) => authority.get(recipe.id) === true,
    readContextWithinWrite(ctx, request) {
      assertWriter(ctx);
      if (request.scope.contextId !== scope.contextId) throw new DomainError(403, 'fixture_feedback_context_unproved');
      return { contextId: scope.contextId, profileRevision: domain.document(accountId, 'profile').revision,
        preferencesRevision: domain.document(accountId, 'preferences').revision,
        sessionSource: sourceReader.read(ctx, request.selection), targetPlan: null };
    },
    readComparisonWithinWrite: progress.readForDerivationWithinWrite.bind(progress),
    // Fixture-only attestation checks the original current occurrence; it grants no production applicability.
    associateComparisonWithinWrite(ctx, input) {
      assertWriter(ctx);
      const valid = associationAllowed && input.declaration.contextId === scope.contextId && input.witness.accountId === accountId
        && input.witness.inputs.current.scope.source.id === scope.sessionId
        && input.witness.inputs.current.scope.source.itemId === selection.occurrenceId
        && input.recipe.scope.kind === 'session' && input.recipe.scope.sessionId === scope.sessionId
        && input.feedback.length === 1 && input.feedback[0].record.recordId === 'feedback'
        && input.feedback[0].binding?.witness.sessionSource?.source.itemId === selection.occurrenceId;
      return valid ? { status: 'associated', evidenceToken: `synthetic-association-${associationRevision}`,
        sourceRefs: [{ ...refs('association')[0], revision: String(associationRevision) }] }
        : { status: 'unavailable', reason: 'association_unproved' };
    },
  };
  const service = createFeedbackLedgerService(deps);
  const command = (kind, value = 'fixture feedback') => {
    const view = service.read(context), record = view.records[0];
    const expectedWitness = lifecycle.withActiveWrite(context, () => deps.readContextWithinWrite(context, { scope, selection }));
    const id = `feedback-event-${++eventSequence}`;
    const event = { eventId: id, recordId: 'feedback', accountId, expectedRevision: record?.revision ?? 0, kind };
    if (kind === 'record' || kind === 'correct') event.content = { scope: structuredClone(scope), sourceRefs: refs('feedback'),
      qualifications: ['Self report; synthetic fixture'], payload: { kind: 'feedback', signals: [
        { dimension: 'effort', state: 'reported', value, scale: null, unit: null },
      ] } };
    return { idempotencyKey: id, expectedLedgerRevision: view.ledgerRevision, event, selection: structuredClone(selection), expectedWitness };
  };
  const record = command('record'); service.mutate(context, record);
  const confirmation = command('confirm'); service.mutate(context, confirmation);
  const dump = () => feedbackOwnedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY account_id`).all()]);
  return { db, domain, context, progress, progressDeps, work, plan, scope, selection, lifecycle, store, deps, recipes, registry,
    authority, service, calls, command, record, confirmation, dump, confirmIdentity, writerStarts: () => writerStarts,
    denyAssociation: () => { associationAllowed = false; }, advanceAssociation: () => { associationRevision++; }, denyContext: () => { contextAllowed = false; } };
}

const node = (view, id = 'comparison') => view.derivations.find(item => item.id === id);
function blocked(view) { for (const result of view.derivations) { assert.equal(result.status, 'blocked'); assert.equal(result.value, null); } }

test('registered comparison is an explicit compute argument and persists v2 source, binding and transitive lineage', t => {
  const f = fixture(t), before = f.writerStarts(), view = f.service.read(f.context);
  assert.equal(f.writerStarts(), before + 1);
  assert.deepEqual(node(view).value, { observedRepetitionDifference: 2 });
  assert.deepEqual(Object.keys(f.calls.at(-1)), ['selected-work']);
  const lineage = node(view).comparisonLineage[0], witness = lineage.producer.witness;
  assert.equal(witness.witnessVersion, 'progress-comparison-witness-v2'); assert.equal(witness.result.policy, 'confirmed-work-comparison-v1');
  assert.equal(witness.inputs.baseline.scope.session.planRevision, 1); assert.equal(witness.inputs.baseline.scope.exercise.id, 'fixture-exercise');
  assert.equal(witness.inputs.baseline.identity.state, 'qualified'); assert.equal(witness.inputs.baseline.identity.revision, 1);
  assert.deepEqual(node(view, 'summary').comparisonLineage, node(view).comparisonLineage);
  assert.equal(node(view, 'later').status, 'blocked'); assert.equal(node(view, 'later').value, null);
  assert.equal(JSON.stringify(lineage).includes('variantId'), false); assert.equal(JSON.stringify(lineage).includes('user_reported"'), false);
  const dependencies = node(view, 'summary').comparisonDependencies;
  for (const side of ['baseline', 'current']) assert.ok(dependencies.some(key => key.kind === 'comparisonIdentity'
    && key.sourceId === f.work[side].selection.id && key.itemId === f.work[side].selection.itemId));
  assert.equal(f.lifecycle.withActiveWrite(f.context, () => f.store.dependsOnWithinWrite(f.context, [dependencies.find(key => key.kind === 'comparisonIdentity')])), true);
});

test('missing registry, missing ports and unproved association block before compute without weakening actual producer errors', t => {
  const f = fixture(t), calls = f.calls.length;
  for (const override of [{ comparisonRegistry: undefined }, { readComparisonWithinWrite: undefined }, { associateComparisonWithinWrite: undefined }]) {
    const service = createFeedbackLedgerService({ ...f.deps, ...override }); blocked(service.read(f.context));
  }
  assert.equal(f.calls.length, calls);
  f.denyAssociation(); blocked(f.service.read(f.context)); assert.equal(f.calls.length, calls);
  const unbound = createProgressComparisonService({ ...f.progressDeps, assertComparisonContextWithinWrite: undefined });
  const broken = createFeedbackLedgerService({ ...f.deps, readComparisonWithinWrite: unbound.readForDerivationWithinWrite.bind(unbound) });
  assert.throws(() => broken.read(f.context), code('progress_context_guard_required'));
  f.denyContext(); assert.throws(() => f.service.read(f.context), code('fixture_context_unproved'));
});

test('baseline identity withdrawal refreshes duplicate receipts and removes cached descendant values', t => {
  const f = fixture(t), stableReceipt = f.service.mutate(f.context, f.confirmation).receipt;
  f.progress.withdraw(f.context, 'withdraw-baseline', { source: f.work.baseline.selection, expectedBindingRevision: 1 });
  const calls = f.calls.length, retry = f.service.mutate(f.context, structuredClone(f.confirmation));
  assert.deepEqual(retry.receipt, stableReceipt); assert.equal(retry.replayed, true); blocked(retry.current); assert.equal(f.calls.length, calls);
  const witness = node(retry.current).comparisonLineage[0].producer.witness;
  assert.equal(witness.inputs.baseline.identity.state, 'withdrawn'); assert.equal(witness.inputs.baseline.identity.revision, 2);
  assert.equal(witness.result.status, 'unknown'); assert.equal(retry.current.ledgerRevision, 2);
  const persisted = JSON.parse(f.db.prepare('SELECT data FROM feedback_projections WHERE account_id=?').get(f.context.accountId).data);
  blocked(persisted); assert.equal(JSON.stringify(persisted).includes('observedRepetitionDifference'), false);
  const receipts = JSON.stringify(f.db.prepare('SELECT * FROM feedback_receipts').all());
  assert.equal(receipts.includes('fixture feedback'), false); assert.equal(receipts.includes('comparisonLineage'), false);
});

test('baseline and current work revisions invalidate without guessed identity rebinding; explicit reattestation recomputes', t => {
  const f = fixture(t);
  for (const side of ['baseline', 'current']) {
    const work = f.work[side];
    f.domain.patchSet(f.context.accountId, work.selection.id, work.set.id, { expectedRevision: 1, reps: side === 'baseline' ? 6 : 8, weightKg: 10, status: 'confirmed' });
    const view = f.service.read(f.context); blocked(view);
    assert.equal(node(view).comparisonLineage[0].producer.witness.inputs[side].identity.state, 'stale');
    f.confirmIdentity(side);
    if (side === 'current') {
      f.service.mutate(f.context, f.command('correct', 'explicit source correction'));
      f.service.mutate(f.context, f.command('confirm'));
    }
    assert.equal(node(f.service.read(f.context)).status, 'ready');
  }
});

test('incomparable and recognized unavailable results stay null and retain reasons rather than old comparison data', t => {
  const f = fixture(t); f.confirmIdentity('baseline', { ...identity, equipmentId: 'different-explicit-equipment' });
  const incomparable = f.service.read(f.context); blocked(incomparable);
  assert.equal(node(incomparable).comparisonLineage[0].producer.witness.result.status, 'incomparable');
  const registry = structuredClone(f.registry); registry.inputs[0].selections.baseline.id = 'absent-session'; registry.version = 'fixture-registry-2';
  const unavailable = createFeedbackLedgerService({ ...f.deps, comparisonRegistry: registry }).read(f.context); blocked(unavailable);
  const producer = node(unavailable).comparisonLineage[0].producer;
  assert.deepEqual(producer, { status: 'unavailable', reason: 'source_missing', side: 'baseline' });
  assert.equal(JSON.stringify(node(unavailable).comparisonLineage).includes('volumeKgRepetitions'), false);
});

test('shared identity invalidation hook replays inside the caller writer and rolls back with the source mutation', t => {
  const f = fixture(t), before = f.dump();
  const source = f.work.baseline.selection;
  const mutate = () => {
    // Simulate the source owner's same-transaction hook without opening a second writer.
    f.db.prepare("UPDATE progress_comparison_identities SET status='withdrawn',data=NULL,revision=revision+1 WHERE account_id=? AND source_id=?")
      .run(f.context.accountId, source.id);
    const view = f.service.invalidateWithinWrite(f.context, [{ kind: 'comparisonIdentity', sourceKind: source.kind, sourceId: source.id, itemId: source.itemId }]);
    blocked(view); return view;
  };
  assert.throws(() => f.lifecycle.withActiveWrite(f.context, () => { mutate(); throw new Error('outer rollback'); }), /outer rollback/);
  assert.deepEqual(f.dump(), before); assert.equal(f.progress.identity(f.context, source).status, 'confirmed');
  f.lifecycle.withActiveWrite(f.context, mutate);
  blocked(f.service.read(f.context));
});

test('comparison changes during compute trigger conflict and rollback before another consumer can use them', t => {
  const f = fixture(t), before = f.dump(), baseline = f.work.baseline;
  const service = createFeedbackLedgerService({ ...f.deps, derivations: f.recipes.map(recipe => recipe.id === 'comparison' ? { ...recipe,
    compute() { f.domain.voidSet(f.context.accountId, baseline.selection.id, baseline.set.id, 1); return 'stale result'; } } : recipe) });
  assert.throws(() => service.read(f.context), code('feedback_comparison_changed_during_consume'));
  assert.deepEqual(f.dump(), before); assert.equal(f.domain.set(f.context.accountId, baseline.selection.id, baseline.set.id).status, 'confirmed');
});

test('post-persistence comparison changes roll back public mutation, trusted mutation, duplicate replay, read and invalidation', t => {
  const f = fixture(t), request = f.command('correct', 'must roll back'), before = f.dump();
  const faultyStore = { ...f.store, replaceWithinWrite(...args) {
    const versions = f.store.replaceWithinWrite(...args);
    f.domain.voidSet(f.context.accountId, f.work.baseline.selection.id, f.work.baseline.set.id, 1);
    return versions;
  } };
  const service = createFeedbackLedgerService({ ...f.deps, store: faultyStore });
  for (const operation of [() => service.mutate(f.context, request),
    () => f.lifecycle.withActiveWrite(f.context, () => service.mutateWithinWrite(f.context, request)),
    () => service.mutate(f.context, f.confirmation), () => service.read(f.context),
    () => f.lifecycle.withActiveWrite(f.context, () => service.invalidateWithinWrite(f.context, []))]) {
    assert.throws(operation, code('feedback_comparison_changed_during_consume')); assert.deepEqual(f.dump(), before);
    assert.equal(f.domain.set(f.context.accountId, f.work.baseline.selection.id, f.work.baseline.set.id).revision, 1);
  }
});

test('changed association after persistence also rolls back instead of preserving an earlier attestation', t => {
  const f = fixture(t), before = f.dump();
  const service = createFeedbackLedgerService({ ...f.deps, store: { ...f.store, replaceWithinWrite(...args) {
    const result = f.store.replaceWithinWrite(...args); f.advanceAssociation(); return result;
  } } });
  assert.throws(() => service.read(f.context), code('feedback_comparison_changed_during_consume'));
  assert.deepEqual(f.dump(), before);
});

test('registry snapshots, copied compute inputs and explicit recipe/registry changes preserve exact selected lineage', t => {
  const f = fixture(t), original = f.service.read(f.context), firstDigest = node(original).comparisonLineage[0].registryDigest;
  f.registry.inputs[0].selections.baseline.id = 'caller-mutated-registration';
  assert.equal(node(f.service.read(f.context)).status, 'ready');
  original.derivations[0].comparisonLineage[0].producer.witness.inputs.baseline.identity.revision = 999;
  assert.equal(node(f.service.read(f.context)).comparisonLineage[0].producer.witness.inputs.baseline.identity.revision, 1);
  const registry = { schema: 'feedback-comparison-inputs-v1', version: 'fixture-registry-2', inputs: [
    { id: 'selected-work', contextId: 'fixture-context', selections: { baseline: { ...f.work.baseline.selection, id: f.work.baseline.session.id }, current: f.work.current.selection } },
  ] };
  const service = createFeedbackLedgerService({ ...f.deps, comparisonRegistry: registry, derivations: f.recipes.map(recipe => recipe.id === 'comparison'
    ? { ...recipe, version: '2', compute({ comparisons }) { comparisons['selected-work'].inputs.baseline.identity.revision = 900; return 'copied input only'; } } : recipe) });
  const changed = service.read(f.context), lineage = node(changed).comparisonLineage[0];
  assert.equal(lineage.recipeVersion, '2'); assert.equal(lineage.registryVersion, 'fixture-registry-2'); assert.notEqual(lineage.registryDigest, firstDigest);
  assert.equal(lineage.producer.witness.inputs.baseline.identity.revision, 1);
  assert.equal(f.progress.identity(f.context, registry.inputs[0].selections.baseline).revision, 1);
});
