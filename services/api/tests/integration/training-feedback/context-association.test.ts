import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { Domain } from '../../../src/domain.js';
import { DomainError } from '../../../src/errors.js';
import { migrations, type Sqlite } from '../../../src/storage.js';
import { lifecycleMigration } from '../../../src/lifecycle/migration.js';
import { bindSuppressionAuthority } from '../../../src/lifecycle/guards.js';
import type { AccountContext } from '../../../src/lifecycle/types.js';
import { createCanonicalAccountWriter } from '../../../src/integration/account-modules/canonical-writer.js';
import { captureCurrentAnalysisWithinWrite } from '../../../src/integration/training-feedback/context-association.js';
import { createProgressComparisonService } from '../../../src/progress-comparison/service.js';
import { progressComparisonMigrationSql } from '../../../src/progress-comparison/migration.js';
import type { ComparisonIdentity } from '../../../src/progress-comparison/index.js';
import type { ComparisonSelection, ComparisonSourceScope, FreshComparisonWitness } from '../../../src/progress-comparison/persistence-types.js';
import { createActivityService } from '../../../src/activity/service.js';
import { activityMigrationSql } from '../../../src/activity/migration.js';
import type { ActivityEntry } from '../../../src/activity/types.js';
import { feedbackMigrationSql, feedbackOwnedTables } from '../../../src/training-feedback/migration.js';
import { createSqliteFeedbackLedgerStore } from '../../../src/training-feedback/ledger-store.js';
import { createFeedbackLedgerService } from '../../../src/training-feedback/ledger-service.js';
import type { ComparisonAssociationRequest, FeedbackCommand, FeedbackDerivationSpec, FeedbackLedgerEntry } from '../../../src/training-feedback/ledger-types.js';
import type { FeedbackScope } from '../../../src/training-feedback/index.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type ScopeFixture<T> = { [K in keyof T]: K extends 'source' ? Mutable<T[K]> : T[K] };
type ContextFixture = { contextId: string; baseline: ScopeFixture<ComparisonSourceScope>; current: ComparisonSourceScope };
type AssociationFixture = Omit<ComparisonAssociationRequest, 'declaration' | 'witness' | 'recipe'> & {
  declaration: Omit<ComparisonAssociationRequest['declaration'], 'selections'> & {
    selections: Omit<ComparisonSelection, 'current'> & { current: Mutable<ComparisonSelection['current']> };
  };
  witness: Mutable<FreshComparisonWitness>;
  recipe: Mutable<ComparisonAssociationRequest['recipe']>;
};
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const identity: ComparisonIdentity = { variantId: 'synthetic-variant', equipmentId: 'synthetic-equipment', laterality: 'bilateral', loadBasis: 'total' };
function fixture(t: TestContext) {
  const db: Sqlite = new Database(':memory:'); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  for (const migration of migrations) db.exec(migration.sql);
  db.exec(lifecycleMigration.sql); db.exec(activityMigrationSql); db.exec(progressComparisonMigrationSql); db.exec(feedbackMigrationSql);
  bindSuppressionAuthority(db, { currentSequence: () => 0, lookup: () => null, reconcileRestore: () => 0,
    recordDisable() { throw new Error('No suppression operation in this fixture'); } });
  const domain = new Domain(db);
  const actors = ['original', 'foreign'].map(id => {
    db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').run(id, id, `${id}@synthetic.invalid`);
    const accountId = domain.account(id, id);
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,0,0,?)')
      .run(id, 8_000_000_000_000, `synthetic-${id}`, id);
    return { accountId, authUserId: id, sessionId: id, epoch: 0 } satisfies AccountContext;
  });
  const actor = actors[0]!, foreign = actors[1]!, writer = createCanonicalAccountWriter(db);
  db.prepare('INSERT INTO exercises VALUES (?,?,0)').run('exercise', JSON.stringify({ id: 'exercise', name: 'Synthetic exercise', cues: [] }));
  const plan = domain.createPlan(actor.accountId, { name: 'Manual plan', minutes: 30,
    items: [{ id: 'item', exerciseId: 'exercise', setTarget: 1, repMin: 4, repMax: 8, targetKg: 10 }] });
  const completed = [5, 7].map(reps => {
    const session = domain.startSession(actor.accountId, plan.id, plan.revision);
    domain.createSet(actor.accountId, session.id, { occurrenceId: session.occurrences[0]!.id, expectedRevision: 1,
      setNumber: 1, reps, weightKg: 10, status: 'confirmed' });
    return domain.completeSession(actor.accountId, session.id, 2);
  });
  const selections: ComparisonSelection = { baseline: { kind: 'session', id: completed[0]!.id, itemId: completed[0]!.occurrences[0]!.id },
    current: { kind: 'session', id: completed[1]!.id, itemId: completed[1]!.occurrences[0]!.id } };
  const activity = createActivityService({ db, lifecycle: writer.lifecycle, lifecycleControl: writer,
    assertPersistable: context => writer.lifecycle.assertActive(context), globalExerciseKind: () => 'resistance',
    now: () => new Date('2026-10-11T12:00:00.000Z') });
  const capture = () => writer.lifecycle.withActiveWrite(actor, () => captureCurrentAnalysisWithinWrite({ context: actor, domain, writer, activity }));
  let captured = capture();
  const progress = createProgressComparisonService({ db, domain, activity,
    assertIdentityAllowed: context => writer.lifecycle.assertActive(context), assertPersistable: context => writer.lifecycle.assertActive(context),
    comparisonBindingFor: (_context, record) => ({ source: record.source, revision: record.revision, confirmed: true, identity: record.data!.identity as ComparisonIdentity }),
    assertComparisonContextWithinWrite: (context, input) => captured.assertComparisonContextWithinWrite(context, input), lifecycleControl: writer });
  for (const [side, source] of Object.entries(selections)) progress.confirm(actor, `identity-${side}`, { source,
    expectedSourceRevision: domain.session(actor.accountId, source.id).revision, expectedBindingRevision: 0,
    identity, provenance: { kind: 'user_reported' }, confirmed: true });
  const within = <T>(effect: () => T) => writer.lifecycle.withActiveWrite(actor, effect);
  const witness = (selected = selections): FreshComparisonWitness => within(() => {
    const result = progress.readForDerivationWithinWrite(actor, { contextId: captured.contextId, ...selected });
    assert.equal(result.status, 'observed'); if (result.status !== 'observed') throw new Error('Expected observed fixture'); return result.witness;
  });
  const request = (): ComparisonAssociationRequest => ({ recipe: { id: 'observed', version: '1', kind: 'history',
    scope: { kind: 'context', contextId: captured.contextId } }, declaration: { id: 'work', contextId: captured.contextId, selections },
    witness: witness(), feedback: [] });
  return { db, domain, actor, foreign, writer, plan, completed, selections, activity, progress, capture, within, witness, request,
    get captured() { return captured; }, recapture() { captured = capture(); return captured; } };
}
type Fixture = ReturnType<typeof fixture>;
function changeDocument(f: Fixture, kind: 'profile' | 'preferences') {
  const value = f.domain.document<Record<string, unknown>>(f.actor.accountId, kind);
  const { revision: _revision, ...data } = value;
  f.db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?').run(JSON.stringify({ ...data,
    ...(kind === 'profile' ? { goals: ['Changed current goal'] } : { equipment: ['Changed equipment'] }) }), f.actor.accountId, kind);
}
function ledger(f: Fixture) {
  const scope: FeedbackScope = { kind: 'context', contextId: f.captured.contextId }, selection = null;
  const refs = [{ sourceId: 'synthetic-self-report', revision: '1', locator: 'fixture', qualification: 'Self report only' }];
  let authority = true, sequence = 0, computeHook = () => {}, afterSave = () => {}, associations = 0, stagedAssociations = 0;
  const recipes: FeedbackDerivationSpec[] = [{ id: 'observed', version: '1', kind: 'history', scope, sourceIds: ['feedback'], dependsOn: [],
    sourceRefs: refs, qualifications: ['Synthetic observed work'], comparisonIds: ['work'], compute({ comparisons }) {
      computeHook(); return comparisons.work!.result.delta.repetitions;
    } }, { id: 'summary', version: '1', kind: 'summary', scope, sourceIds: [], dependsOn: ['observed'], sourceRefs: refs,
    qualifications: ['Synthetic transitive summary'], comparisonIds: ['work'], compute({ parents }) { return parents[0]!.value; } }];
  const store = createSqliteFeedbackLedgerStore({ db: f.db, lifecycle: f.writer.lifecycle, assertWithinWrite: f.writer.assertWithinWrite });
  const service = createFeedbackLedgerService({ store: { ...store, replaceWithinWrite(...args) {
    const result = store.replaceWithinWrite(...args); afterSave(); return result;
  } }, lifecycle: f.writer.lifecycle, derivations: recipes, derivationAuthorityWithinWrite: () => authority,
    readContextWithinWrite: (context, request) => f.captured.readContextWithinWrite(context, request),
    comparisonRegistry: { schema: 'feedback-comparison-inputs-v1', version: 'fixture', inputs: [{ id: 'work', contextId: scope.contextId, selections: f.selections }] },
    readComparisonWithinWrite: f.progress.readForDerivationWithinWrite.bind(f.progress),
    associateComparisonWithinWrite(context, input) {
      const result = f.captured.associateComparisonWithinWrite(context, input);
      if (result.status === 'associated') {
        associations++;
        const persisted = f.db.prepare('SELECT data FROM feedback_events WHERE account_id=?').all(f.actor.accountId) as { data: string }[];
        if (input.feedback.some(({ record }) => record.recordId === 'feedback' && record.revision === 2) &&
            !persisted.some(row => (JSON.parse(row.data) as FeedbackLedgerEntry).event.kind === 'confirm')) stagedAssociations++;
      }
      return result;
    } });
  const command = (kind: 'record' | 'confirm'): FeedbackCommand => {
    const view = service.read(f.actor), eventId = `event-${++sequence}`;
    const base = { eventId, accountId: f.actor.accountId, recordId: 'feedback', expectedRevision: view.records[0]?.revision ?? 0 };
    const event = kind === 'record' ? { ...base, kind, content: { scope, sourceRefs: refs, qualifications: ['Untrusted self-report qualification'],
      payload: { kind: 'feedback' as const, signals: [{ dimension: 'effort' as const, state: 'reported' as const, value: 5, unit: null, scale: null }] } } } : { ...base, kind };
    return { idempotencyKey: eventId, expectedLedgerRevision: view.ledgerRevision, event, selection,
      expectedWitness: f.within(() => f.captured.readContextWithinWrite(f.actor, { scope, selection })) };
  };
  const seed = () => { service.mutate(f.actor, command('record')); return service.mutate(f.actor, command('confirm')); };
  const dump = () => feedbackOwnedTables.map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY account_id`).all()]);
  return { service, command, seed, dump, associations: () => associations, stagedAssociations: () => stagedAssociations, deny: () => { authority = false; },
    onCompute: (hook: () => void) => { computeHook = hook; }, onSave: (hook: () => void) => { afterSave = hook; } };
}

test('captures frozen current documents with a stable account-bound context and explicit basis', t => {
  const f = fixture(t), before = f.captured;
  assert.equal(before.basis, 'current_profile_and_goals'); assert.match(before.contextId, /^current_[a-f0-9]{64}$/);
  assert.deepEqual(before.profile, f.domain.document(f.actor.accountId, 'profile'));
  assert.deepEqual(before.preferences, f.domain.document(f.actor.accountId, 'preferences'));
  assert.throws(() => before.profile.goals.push('mutation'), TypeError);
  assert.equal(f.capture().contextId, before.contextId);
  const foreign = f.writer.lifecycle.withActiveWrite(f.foreign, () => captureCurrentAnalysisWithinWrite({ context: f.foreign, domain: f.domain, writer: f.writer }));
  assert.notEqual(foreign.contextId, before.contextId);
  f.domain.patchDocument(f.actor.accountId, 'profile', { expectedRevision: 0, goals: ['New current goal'] });
  assert.equal(f.capture().contextId, before.contextId); assert.equal(before.profile.revision, 0);
  assert.throws(() => f.within(() => before.readContextWithinWrite(f.actor, { scope: { kind: 'context', contextId: before.contextId }, selection: null })), code('current_analysis_changed'));
});

test('requires the admitted original actor and exact DB, not an ambient transaction', t => {
  const f = fixture(t), options = { context: f.actor, domain: f.domain, writer: f.writer };
  assert.throws(() => captureCurrentAnalysisWithinWrite(options), code('canonical_writer_unproved'));
  f.db.transaction(() => assert.throws(() => captureCurrentAnalysisWithinWrite(options), code('canonical_writer_unproved'))).immediate();
  const otherDb: Sqlite = new Database(':memory:'); t.after(() => otherDb.close());
  const request = { scope: { kind: 'context' as const, contextId: f.captured.contextId }, selection: null };
  f.within(() => {
    assert.throws(() => captureCurrentAnalysisWithinWrite({ ...options, domain: new Domain(otherDb) }), code('canonical_writer_unproved'));
    assert.throws(() => captureCurrentAnalysisWithinWrite({ ...options, activity: { entry: f.activity.entry.bind(f.activity), deps: { ...f.activity.deps, db: otherDb } } }), code('canonical_writer_unproved'));
    for (const difference of [{ accountId: f.foreign.accountId }, { authUserId: f.foreign.authUserId }, { sessionId: 'replacement' }, { epoch: 1 }])
      assert.throws(() => f.captured.readContextWithinWrite({ ...f.actor, ...difference }, request), code('canonical_writer_unproved'));
  });
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.actor.sessionId);
  assert.throws(() => f.within(() => f.captured.readContextWithinWrite(f.actor, request)), code('account_session_invalid'));
});

test('missing and invalid capture fields are unavailable without fabricated values', t => {
  for (const kind of ['profile', 'preferences'] as const) {
    const f = fixture(t);
    f.db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?').run('{}', f.actor.accountId, kind);
    assert.throws(f.capture, code('current_analysis_context_unavailable'));
    const document = f.domain.document.bind(f.domain);
    t.mock.method(f.domain, 'document', <T extends object>(accountId: string, requestedKind: string): T & { revision: number } =>
      document<T>(accountId, accountId === f.actor.accountId && requestedKind === kind ? 'synthetic-missing-document' : requestedKind));
    assert.throws(f.capture, code('current_analysis_context_unavailable'));
  }
});

test('full current values are rechecked even when revisions have not changed', t => {
  for (const kind of ['profile', 'preferences'] as const) {
    const f = fixture(t), request = f.request(); changeDocument(f, kind);
    assert.throws(() => f.within(() => f.captured.associateComparisonWithinWrite(f.actor, request)), code('current_analysis_changed'));
  }
});

test('real completed history retains historical plan joins after current plan edits', t => {
  const f = fixture(t);
  f.domain.patchPlan(f.actor.accountId, f.plan.id, { expectedRevision: 1, name: 'Edited current target', minutes: 45 });
  const witness = f.witness(); assert.equal(witness.result.status, 'comparable');
  assert.equal(witness.inputs.baseline.scope.session!.planRevision, 1);
  assert.equal(f.domain.history(f.actor.accountId, 20).items.length, 2);
  const current = f.selections.current;
  const value = f.within(() => f.captured.readContextWithinWrite(f.actor, { scope: { kind: 'plan', contextId: f.captured.contextId, planId: f.plan.id },
    selection: { sessionId: current.id, occurrenceId: current.itemId } }));
  assert.equal(value.targetPlan!.revision, 2); assert.equal(value.sessionSource!.planSnapshot.planRevision, 1);
  assert.equal(value.sessionSource!.sessionStatus, 'completed'); assert.equal(value.sessionSource!.sets[0]!.status, 'confirmed');
});

test('missing occurrences, foreign sources and mismatched historical joins never attest context', t => {
  const f = fixture(t), witness = f.witness();
  const input = { contextId: f.captured.contextId, baseline: witness.inputs.baseline.scope, current: witness.inputs.current.scope };
  for (const mutate of [
    (value: ContextFixture) => { value.contextId = 'foreign-context'; },
    (value: ContextFixture) => { value.baseline.source.itemId = 'absent'; },
    (value: ContextFixture) => { value.baseline.source.accountId = f.foreign.accountId; },
    (value: ContextFixture) => { value.baseline.session!.planRevision = 2; },
  ]) { const value = structuredClone(input) as ContextFixture; mutate(value);
    assert.throws(() => f.within(() => f.captured.assertComparisonContextWithinWrite(f.actor, value)), code('current_analysis_context_unavailable'));
  }
  const originalSession = f.domain.session.bind(f.domain);
  t.mock.method(f.domain, 'session', (accountId: string, id: string) => {
    const session = originalSession(accountId, id);
    return { ...session, planRevision: 999, planSnapshot: { ...session.planSnapshot, revision: 999 } };
  });
  assert.throws(f.witness, code('current_analysis_context_unavailable'));
});

test('source 404 remains a missing source at the feedback witness boundary', t => {
  const f = fixture(t);
  assert.throws(() => f.within(() => f.captured.readContextWithinWrite(f.actor, { scope: { kind: 'context', contextId: f.captured.contextId },
    selection: { sessionId: 'missing-session', occurrenceId: 'missing-occurrence' } })), code('not_found'));
});

test('association binds declaration, selected sources, recipe scope and qualified identity', t => {
  const f = fixture(t), original = f.request();
  const associated = f.within(() => f.captured.associateComparisonWithinWrite(f.actor, original));
  assert.equal(associated.status, 'associated');
  assert.deepEqual(f.within(() => f.captured.associateComparisonWithinWrite(f.actor, original)), associated);
  for (const mutate of [
    (value: AssociationFixture) => { value.declaration.selections.current.id = 'other'; },
    (value: AssociationFixture) => { value.witness.inputs.current.identity.state = 'missing'; },
    (value: AssociationFixture) => { value.recipe.scope = { kind: 'session', contextId: f.captured.contextId, sessionId: 'other', planId: null }; },
    (value: AssociationFixture) => { value.witness.contextId = 'other'; },
  ]) { const value = structuredClone(original) as AssociationFixture; mutate(value);
    assert.deepEqual(f.within(() => f.captured.associateComparisonWithinWrite(f.actor, value)), { status: 'unavailable', reason: 'association_unproved' });
  }
});

test('trusted staged confirmation and transitive records associate before ledger persistence', t => {
  const f = fixture(t), l = ledger(f), result = l.seed();
  assert.equal(result.receipt.outcome, 'changed');
  for (const derived of result.current.derivations) { assert.equal(derived.status, 'ready'); assert.equal(derived.value, 2); }
  assert.ok(l.associations() > 0); assert.ok(l.stagedAssociations() > 0);
  const association = result.current.derivations[0]!.comparisonLineage[0]!.association;
  assert.equal(association!.status, 'associated');
  if (association?.status === 'associated') {
    assert.ok(association.sourceRefs.some(ref => ref.sourceId === 'feedback' && ref.revision === '2'));
    assert.equal(association.sourceRefs.some(ref => ref.sourceId === 'synthetic-self-report'), false);
  }
  assert.equal(l.service.read(f.actor).derivations[1]!.status, 'ready');
});

test('old binding revisions remain blocked after explicit fresh capture without rewriting confirmation', t => {
  const f = fixture(t), l = ledger(f); l.seed();
  const old = f.within(() => f.captured.readContextWithinWrite(f.actor, { scope: { kind: 'context', contextId: f.captured.contextId }, selection: null }));
  f.domain.patchDocument(f.actor.accountId, 'preferences', { expectedRevision: 0, sessionMinutes: 40 }); f.recapture();
  const view = l.service.read(f.actor); assert.equal(view.sources[0]!.state, 'changed');
  assert.ok(view.derivations.every(item => item.status === 'blocked'));
  assert.deepEqual(view.sources[0]!.binding!.witness, old);
  const request = f.request(), record = view.records[0]!;
  for (const binding of [null, view.sources[0]!.binding]) assert.deepEqual(f.within(() => f.captured.associateComparisonWithinWrite(f.actor,
    { ...request, feedback: [{ record, binding }] })), { status: 'unavailable', reason: 'association_unproved' });
});

test('current-document drift during compute or after persistence rolls back the complete ledger write', t => {
  for (const boundary of ['compute', 'save'] as const) {
    const f = fixture(t), l = ledger(f); l.service.mutate(f.actor, l.command('record'));
    const command = l.command('confirm'), before = l.dump(), profile = f.domain.document(f.actor.accountId, 'profile');
    if (boundary === 'compute') l.onCompute(() => changeDocument(f, 'profile')); else l.onSave(() => changeDocument(f, 'profile'));
    assert.throws(() => l.service.mutate(f.actor, command), code('current_analysis_changed'));
    assert.deepEqual(l.dump(), before); assert.deepEqual(f.domain.document(f.actor.accountId, 'profile'), profile);
  }
});

test('missing identity or derivation authority stays blocked despite proved current document capture', t => {
  const f = fixture(t), l = ledger(f); l.seed(); l.deny();
  assert.ok(l.service.read(f.actor).derivations.every(item => item.status === 'blocked'));
  const second = fixture(t), other = ledger(second); other.seed();
  second.db.prepare('DELETE FROM progress_comparison_identity_revisions').run();
  second.db.prepare('DELETE FROM progress_comparison_identities').run();
  assert.ok(other.service.read(second.actor).derivations.every(item => item.status === 'blocked'));
});

test('Activity observations prove no session or plan join and cannot satisfy a named session recipe', t => {
  const f = fixture(t);
  f.activity.createCalendar(f.actor, 'calendar', { timeZone: 'UTC', confirmed: true });
  const load = { state: 'knownValue', value: 10, unit: 'kg', basis: 'total' };
  const entries = [5, 7].map((repetitions, index) => f.activity.createEntry(f.actor, `activity-${index}`, {
    date: { localDate: '2026-10-11', timeZone: 'UTC', calendar: 'iso8601', source: 'selected',
      capturedAt: '2026-10-11T12:00:00.000Z', referenceLocalDate: '2026-10-11', confirmed: true },
    kind: 'workout', items: [{ id: 'activity-item', exercise: { source: 'global', id: 'exercise' }, load,
      sets: [{ id: 'activity-set', repetitions, load }] }], performedConfirmed: true, source: 'manual', draftId: `draft-${index}`, acknowledgedIssues: [],
  }).body as ActivityEntry);
  const selection = (entry: ActivityEntry) => ({ kind: 'activity' as const, id: entry.id, itemId: entry.items[0]!.id });
  const selections = { baseline: selection(entries[0]!), current: selection(entries[1]!) };
  for (const [side, source] of Object.entries(selections)) f.progress.confirm(f.actor, `activity-identity-${side}`, {
    source, expectedSourceRevision: 1, expectedBindingRevision: 0, identity, provenance: { kind: 'user_reported' }, confirmed: true });
  const witness = f.witness(selections); assert.equal(witness.inputs.baseline.scope.session, null);
  const original = f.request(), request = { ...original, declaration: { ...original.declaration, selections }, witness };
  assert.equal(f.within(() => f.captured.associateComparisonWithinWrite(f.actor, request)).status, 'associated');
  const scope: FeedbackScope = { kind: 'session', contextId: f.captured.contextId, sessionId: f.completed[0]!.id, planId: f.plan.id };
  assert.equal(f.within(() => f.captured.associateComparisonWithinWrite(f.actor, { ...request, recipe: { ...request.recipe, scope } })).status, 'unavailable');
});


test('original actor invalidation inside a source read propagates and rolls back instead of becoming unavailable', t => {
  const f = fixture(t), request = f.request(), originalSession = f.domain.session.bind(f.domain);
  t.mock.method(f.domain, 'session', (accountId: string, id: string) => {
    const session = originalSession(accountId, id);
    f.db.prepare('DELETE FROM session WHERE id=?').run(f.actor.sessionId);
    return session;
  });
  assert.throws(() => f.within(() => f.captured.associateComparisonWithinWrite(f.actor, request)), code('account_session_invalid'));
  assert.ok(f.db.prepare('SELECT id FROM session WHERE id=?').get(f.actor.sessionId));
});
