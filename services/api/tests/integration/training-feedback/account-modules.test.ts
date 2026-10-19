import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { Domain } from '../../../src/domain.js';
import { DomainError } from '../../../src/errors.js';
import { hash, type Sqlite } from '../../../src/storage.js';
import { sourcePrescriptionMigration } from '../../../src/source-prescription-migration.js';
import { createFirstPlanHost, type PreparedSourceFirstPlan } from '../../../src/integration/first-plan/index.js';
import type { AccountContext } from '../../../src/lifecycle/types.js';
import { bindSuppressionAuthority } from '../../../src/lifecycle/guards.js';
import { createCanonicalAccountWriter } from '../../../src/integration/account-modules/canonical-writer.js';
import { createSourceAccountModules, hasRetainedFeedbackWithinWrite, type SourceTrainingFeedbackBindings, type RetentionRequest } from '../../../src/integration/account-modules/index.js';
import { captureCurrentAnalysisWithinWrite } from '../../../src/integration/training-feedback/context-association.js';
import { createProgressComparisonService } from '../../../src/progress-comparison/service.js';
import { progressComparisonMigrationSql, progressComparisonOwnedTables } from '../../../src/progress-comparison/migration.js';
import type { ComparisonIdentity } from '../../../src/progress-comparison/index.js';
import type { ComparisonSelection } from '../../../src/progress-comparison/persistence-types.js';
import { createActivityService } from '../../../src/activity/service.js';
import { feedbackMigrationSql, feedbackOwnedTables } from '../../../src/training-feedback/migration.js';
import type { FeedbackCommand, FeedbackLedgerEntry, FeedbackSourceKey, FeedbackWitnessRequest } from '../../../src/training-feedback/ledger-types.js';
import type { JsonValue } from '../../../src/training-feedback/index.js';
import { install, suppressionLedger } from '../account-modules/fixture.js';

const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const identity: ComparisonIdentity = { variantId: 'synthetic', equipmentId: 'synthetic', laterality: 'bilateral', loadBasis: 'total' };
const actualTrainingSchema = progressComparisonMigrationSql + feedbackMigrationSql;
function fixture(t: TestContext, schema: string | null = actualTrainingSchema) {
  const statements: string[] = [];
  const db: Sqlite = new Database(':memory:', { verbose: sql => { if (typeof sql === 'string') statements.push(sql); } });
  t.after(() => db.close()); install(db);
  if (schema !== null) db.exec(schema);
  bindSuppressionAuthority(db, suppressionLedger().ledger);
  const domain = new Domain(db), writer = createCanonicalAccountWriter(db), lifecycle = { ...writer.lifecycle };
  const actors = ['one', 'two'].map(id => {
    db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').run(id, id, `${id}@synthetic.invalid`);
    const accountId = domain.account(id, id);
    db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,0,0)').run(id, id, `synthetic-${id}`, 8_000_000_000_000);
    return { accountId, authUserId: id, sessionId: id, epoch: 0 } satisfies AccountContext;
  });
  const actor = actors[0]!, other = actors[1]!;
  db.prepare('INSERT INTO exercises VALUES (?,?,0)').run('exercise', JSON.stringify({ id: 'exercise', name: 'Synthetic', cues: [] }));
  const plan = domain.createPlan(actor.accountId, { name: 'Manual', minutes: 30,
    items: [{ id: 'item', exerciseId: 'exercise', setTarget: 1, repMin: 4, repMax: 8, targetKg: 10 }] });
  const sessions = [5, 7].map(reps => {
    const session = domain.startSession(actor.accountId, plan.id, plan.revision);
    domain.createSet(actor.accountId, session.id, { occurrenceId: session.occurrences[0]!.id, expectedRevision: 1,
      setNumber: 1, reps, weightKg: 10, status: 'confirmed' });
    return domain.completeSession(actor.accountId, session.id, 2);
  });
  const selections: ComparisonSelection = { baseline: { kind: 'session', id: sessions[0]!.id, itemId: sessions[0]!.occurrences[0]!.id },
    current: { kind: 'session', id: sessions[1]!.id, itemId: sessions[1]!.occurrences[0]!.id } };
  let retained = true, authorized = true, identities = true, empty = false, registrationHook = () => {};
  let computeHook: () => unknown = () => undefined;
  let retainHook: (request: RetentionRequest) => boolean = () => retained;
  let capturedCount = 0, sequence = 0;
  const retentionRequests: RetentionRequest[] = [];
  const config: SourceTrainingFeedbackBindings = { domain, writer,
    registrationWithinWrite(context, current) {
      writer.assertWithinWrite(context); assert.equal(context.accountId, actor.accountId); capturedCount++; registrationHook();
      const scope = { kind: 'context' as const, contextId: current.contextId };
      const refs = [{ sourceId: 'synthetic-rule', revision: '1', locator: 'fixture', qualification: 'Synthetic observed-work test only' }];
      return { derivations: empty ? [] : [
        { id: 'observed', version: '1', kind: 'history', scope, sourceIds: ['feedback'], dependsOn: [], sourceRefs: refs,
          qualifications: ['Synthetic test'], comparisonIds: ['selected'], compute({ comparisons }) {
            const override = computeHook(); return override === undefined ? comparisons.selected!.result.delta.repetitions : override as JsonValue;
          } },
        { id: 'summary', version: '1', kind: 'summary', scope, sourceIds: [], dependsOn: ['observed'], sourceRefs: refs,
          qualifications: ['Synthetic transitive test'], comparisonIds: ['selected'], compute({ parents }) { return parents[0]!.value; } },
      ], comparisonRegistry: { schema: 'feedback-comparison-inputs-v1', version: 'fixture', inputs: [{ id: 'selected', contextId: current.contextId, selections }] },
      derivationAuthorityWithinWrite: ctx => { writer.assertWithinWrite(ctx); return authorized; },
      comparisonBindingFor: (ctx, record) => { writer.assertWithinWrite(ctx); return identities ? {
        source: record.source, revision: record.revision, confirmed: true, identity: record.data!.identity as ComparisonIdentity,
      } : null; } };
    },
    retentionAllowedWithinWrite(context, request) { writer.assertWithinWrite(context); retentionRequests.push(request); return retainHook(request); },
  };
  const bind = (configuration = config) => createSourceAccountModules(db, lifecycle, configuration).trainingFeedback!;
  const contextId = () => writer.lifecycle.withActiveWrite(actor, () => captureCurrentAnalysisWithinWrite({ context: actor, domain, writer }).contextId);
  const witnessRequest = (): FeedbackWitnessRequest => ({ scope: { kind: 'context', contextId: contextId() }, selection: null });
  const prepareIdentities = () => {
    const progress = createProgressComparisonService({ db, domain, lifecycleControl: writer,
      assertIdentityAllowed: context => writer.lifecycle.assertActive(context), assertPersistable: context => writer.lifecycle.assertActive(context),
      comparisonBindingFor: () => null });
    for (const [side, source] of Object.entries(selections)) progress.confirm(actor, `synthetic-${side}`, { source,
      expectedSourceRevision: domain.session(actor.accountId, source.id).revision, expectedBindingRevision: 0, identity,
      provenance: { kind: 'user_reported' }, confirmed: true });
  };
  const command = (kind: 'record' | 'confirm'): FeedbackCommand => {
    const api = bind(), view = api.read(actor), request = witnessRequest(), witness = api.witness(actor, request).result;
    const eventId = `event-${++sequence}`, base = { eventId, accountId: actor.accountId, recordId: 'feedback', expectedRevision: view.result.records[0]?.revision ?? 0 };
    return { idempotencyKey: eventId, expectedLedgerRevision: view.result.ledgerRevision, expectedWitness: witness, selection: null,
      event: kind === 'confirm' ? { ...base, kind } : { ...base, kind, content: { scope: request.scope,
        sourceRefs: [{ sourceId: 'self-report', revision: '1', locator: 'fixture', qualification: 'Not rule authority' }], qualifications: ['Reported'],
        payload: { kind: 'feedback', signals: [{ dimension: 'effort', state: 'reported', value: 5, unit: null, scale: null }] } } } };
  };
  const seed = () => { prepareIdentities(); const api = bind(); api.mutate(actor, command('record')); return api.mutate(actor, command('confirm')); };
  const dump = () => [...feedbackOwnedTables, ...progressComparisonOwnedTables].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY account_id`).all()]);
  const changeGoal = () => {
    const { revision, ...profile } = domain.document<{ name: string; goals: string[] }>(actor.accountId, 'profile');
    db.prepare("UPDATE documents SET data=? WHERE account_id=? AND kind='profile'").run(JSON.stringify({ ...profile, goals: ['Changed current goal'] }), actor.accountId);
    return revision;
  };
  return { db, statements, domain, writer, lifecycle, actor, other, plan, sessions, selections, config, bind, contextId, witnessRequest, prepareIdentities, command, seed, dump, changeGoal,
    retentionRequests, captures: () => capturedCount, denyRetention: () => { retained = false; }, denyAuthority: () => { authorized = false; },
    denyIdentity: () => { identities = false; }, noRecipes: () => { empty = true; }, onCompute: (effect: () => unknown) => { computeHook = effect; },
    onRegistration: (effect: () => void) => { registrationHook = effect; }, onRetention: (effect: typeof retainHook) => { retainHook = effect; } };
}

test('absent training configuration creates no TRAIN schema or services and preserves cache and existing adapters', t => {
  const f = fixture(t, null), before = f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  const start = f.statements.length;
  const modules = createSourceAccountModules(f.db, f.lifecycle);
  assert.equal(modules.trainingFeedback, undefined); assert.equal(modules.adapters.length, 2);
  assert.equal(createSourceAccountModules(f.db, f.lifecycle), modules);
  assert.equal(f.statements.slice(start).some(sql => /feedback|progress_comparison|SELECT type,name,sql/.test(sql)), false);
  assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), before);
  assert.throws(() => createSourceAccountModules(f.db, f.lifecycle, f.config), code('account_modules_already_bound'));
});

test('configured cache rejects added removed replaced and mutated bindings', t => {
  const f = fixture(t), config = { ...f.config }, modules = createSourceAccountModules(f.db, f.lifecycle, config);
  assert.equal(createSourceAccountModules(f.db, f.lifecycle, config), modules);
  assert.throws(() => createSourceAccountModules(f.db, f.lifecycle), code('account_modules_already_bound'));
  assert.throws(() => createSourceAccountModules(f.db, f.lifecycle, { ...config }), code('account_modules_already_bound'));
  assert.throws(() => createSourceAccountModules(f.db, { ...f.lifecycle }, config), code('account_modules_already_bound'));
  config.registrationWithinWrite = () => { throw new Error('Replacement must never run'); };
  assert.throws(() => modules.trainingFeedback!.read(f.actor), code('account_modules_already_bound'));
  assert.throws(() => createSourceAccountModules(f.db, f.lifecycle, config), code('account_modules_already_bound'));
  const second = fixture(t); second.bind(); second.lifecycle.assertActive = () => {};
  assert.throws(() => second.bind(), code('account_modules_already_bound'));
});

test('wrong database and missing or altered TRAIN definitions fail without creating schema', t => {
  const f = fixture(t), other = fixture(t);
  const activity = createActivityService({ db: other.db, lifecycle: other.writer.lifecycle, lifecycleControl: other.writer, assertPersistable: () => {} });
  for (const configuration of [{ ...f.config, domain: other.domain }, { ...f.config, writer: other.writer }, { ...f.config, activity }])
    assert.throws(() => f.bind(configuration), code('training_feedback_bindings_unavailable'));
  for (const schema of [null, progressComparisonMigrationSql,
    actualTrainingSchema.replace('CHECK(ledger_revision>=0)', 'CHECK(ledger_revision>=1)'),
    actualTrainingSchema.replace('CREATE INDEX feedback_source_dependents ON feedback_dependencies(account_id,kind,source_id);', '')]) {
    const missing = fixture(t, schema), before = missing.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
    assert.throws(missing.bind, code('training_feedback_schema_unavailable'));
    assert.deepEqual(missing.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), before);
  }
});

test('equivalent declaration whitespace is accepted and witness needs no retention or ledger write', t => {
  const f = fixture(t, actualTrainingSchema.replace(/\n/g, '\n\n')); f.denyRetention();
  const api = f.bind(), before = f.dump(), request = f.witnessRequest();
  const value = api.witness(f.actor, request);
  assert.equal(value.analysis.basis, 'current_profile_and_goals'); assert.equal(value.result.contextId, value.analysis.contextId);
  assert.equal(f.retentionRequests.length, 0); assert.deepEqual(f.dump(), before);
});

test('denied retention fails before TRAIN reads or writes and never calls registration', t => {
  const f = fixture(t), api = f.bind(), before = f.dump(); f.denyRetention();
  const start = f.statements.length;
  assert.throws(() => api.read(f.actor), code('training_feedback_retention_unavailable'));
  assert.equal(f.statements.slice(start).some(sql => /feedback|progress_comparison|SELECT type,name,sql/.test(sql)), false);
  assert.equal(f.captures(), 0); assert.deepEqual(f.dump(), before);
});

test('manual completed sessions become persisted staged and transitive comparison feedback through the actual module', t => {
  const f = fixture(t), result = f.seed();
  assert.equal(result.result.receipt.outcome, 'changed'); assert.equal(result.analysis.profileRevision, 0);
  assert.equal(result.result.current.derivations.length, 2);
  assert.ok(result.result.current.derivations.every(item => item.status === 'ready' && item.value === 2));
  const fresh = f.bind().read(f.actor); assert.equal(fresh.result.derivations[1]!.value, 2); assert.ok(f.captures() > 1);
  const entries = f.db.prepare('SELECT data FROM feedback_events ORDER BY sequence').all() as { data: string }[];
  assert.deepEqual(entries.map(row => (JSON.parse(row.data) as FeedbackLedgerEntry).event.kind), ['record', 'confirm']);
  const lineage = fresh.result.derivations[1]!.comparisonLineage[0]!;
  assert.equal(lineage.association!.status, 'associated'); assert.equal(lineage.producer!.status, 'observed');
  f.domain.patchPlan(f.actor.accountId, f.plan.id, { expectedRevision: 1, name: 'Current edited plan' });
  const source = f.selections.current;
  const witness = f.bind().witness(f.actor, { scope: { kind: 'plan', contextId: fresh.analysis.contextId, planId: f.plan.id },
    selection: { sessionId: source.id, occurrenceId: source.itemId } });
  assert.equal(witness.result.targetPlan!.revision, 2); assert.equal(witness.result.sessionSource!.planSnapshot.planRevision, 1);
});

test('false rule authority and null identity binding remain blocked without implicit qualification', t => {
  for (const denial of ['authority', 'identity'] as const) {
    const f = fixture(t); f.seed(); if (denial === 'authority') f.denyAuthority(); else f.denyIdentity();
    assert.ok(f.bind().read(f.actor).result.derivations.every(item => item.status === 'blocked'));
  }
});

test('fresh goals preserve stable current identity while old feedback bindings remain stale', t => {
  const f = fixture(t), before = f.seed(), events = f.db.prepare('SELECT * FROM feedback_events ORDER BY sequence').all();
  f.domain.patchDocument(f.actor.accountId, 'profile', { expectedRevision: 0, goals: ['New goal'] });
  const after = f.bind().read(f.actor);
  assert.equal(after.analysis.contextId, before.analysis.contextId); assert.equal(after.analysis.profileRevision, 1);
  assert.equal(after.result.sources[0]!.state, 'changed'); assert.ok(after.result.derivations.every(item => item.status === 'blocked'));
  assert.deepEqual(f.db.prepare('SELECT * FROM feedback_events ORDER BY sequence').all(), events);
  assert.equal(after.result.sources[0]!.binding!.witness.profileRevision, 0);
});

test('ambient transactions and wrong actor coordinates cannot reuse an admitted account writer', t => {
  const f = fixture(t), api = f.bind();
  f.db.transaction(() => assert.throws(() => api.read(f.actor), code('canonical_writer_unproved'))).immediate();
  f.writer.lifecycle.withActiveWrite(f.actor, () => {
    for (const difference of [{ accountId: f.other.accountId }, { authUserId: f.other.authUserId }, { sessionId: f.other.sessionId }, { epoch: 1 }])
      assert.throws(() => api.read({ ...f.actor, ...difference }), code('canonical_writer_unproved'));
  });
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.actor.sessionId);
  assert.throws(() => api.read(f.actor), code('account_session_invalid'));
});

test('owned invalidation reuses its exact frame and commits only with the caller transaction', t => {
  const f = fixture(t); f.seed(); const api = f.bind(), before = f.dump();
  assert.throws(() => api.invalidateWithinWrite(f.actor, []), code('canonical_writer_unproved'));
  const keys = [{ kind: 'context', id: f.contextId() }] as const satisfies readonly FeedbackSourceKey[];
  const initial = f.statements.length;
  assert.throws(() => f.writer.lifecycle.withActiveWrite(f.actor, () => {
    api.invalidateWithinWrite(f.actor, keys); throw new Error('Caller rollback');
  }), /Caller rollback/);
  assert.equal(f.statements.slice(initial).filter(sql => /^(BEGIN|SAVEPOINT)\b/.test(sql)).length, 1); assert.deepEqual(f.dump(), before);
  assert.ok(f.retentionRequests.some(request => request.operation === 'invalidate' && request.sources[0]?.kind === 'context' && request.sources[0].id === keys[0].id));
});

test('registration throw, invalid registration and thenable callbacks never produce an empty fallback', t => {
  for (const mode of ['throw', 'invalid', 'thenable'] as const) {
    const f = fixture(t), failure = new Error('Registration failed');
    const config = { ...f.config, registrationWithinWrite: (() => {
      if (mode === 'throw') throw failure;
      return mode === 'invalid' ? {} : { then() { throw new Error('Thenable must not be awaited'); } };
    }) as unknown as SourceTrainingFeedbackBindings['registrationWithinWrite'] };
    const api = f.bind(config), before = f.dump();
    assert.throws(() => api.read(f.actor), mode === 'throw' ? error => error === failure : code(mode === 'invalid'
      ? 'training_feedback_registration_unavailable' : 'training_feedback_synchronous_callback_required'));
    assert.deepEqual(f.dump(), before);
  }
});

test('compute throw and thenable cannot be swallowed as a committed blocked projection', t => {
  for (const mode of ['throw', 'thenable'] as const) {
    const f = fixture(t); f.prepareIdentities(); const api = f.bind(); api.mutate(f.actor, f.command('record'));
    const command = f.command('confirm'), before = f.dump(), failure = new Error('Compute failed');
    if (mode === 'throw') f.onCompute(() => { throw failure; });
    else f.onCompute(() => ({ then() { throw new Error('Thenable must not be awaited'); } }));
    assert.throws(() => api.mutate(f.actor, command), mode === 'throw' ? error => error === failure : code('training_feedback_synchronous_callback_required'));
    assert.deepEqual(f.dump(), before);
  }
});

test('callback document drift and post-persistence retention or document changes roll back all TRAIN writes', t => {
  for (const mode of ['registration', 'compute', 'post-retention', 'post-document'] as const) {
    const f = fixture(t); f.prepareIdentities(); const api = f.bind(); api.mutate(f.actor, f.command('record'));
    const command = f.command('confirm'), before = f.dump(), profile = f.domain.document(f.actor.accountId, 'profile');
    if (mode === 'registration') f.onRegistration(() => { f.changeGoal(); });
    if (mode === 'compute') f.onCompute(() => { f.changeGoal(); });
    if (mode.startsWith('post-')) f.onRetention(() => {
      const count = (f.db.prepare('SELECT count(*) n FROM feedback_events').get() as { n: number }).n;
      if (count > 1) { if (mode === 'post-retention') return false; f.changeGoal(); }
      return true;
    });
    assert.throws(() => api.mutate(f.actor, command), code(mode === 'post-retention' ? 'training_feedback_retention_unavailable' : 'current_analysis_changed'));
    assert.deepEqual(f.dump(), before); assert.deepEqual(f.domain.document(f.actor.accountId, 'profile'), profile);
  }
});

test('even an empty registered graph rechecks captured documents before returning', t => {
  const f = fixture(t); f.noRecipes(); const api = f.bind(), before = f.dump();
  f.onRegistration(() => { f.changeGoal(); });
  assert.throws(() => api.read(f.actor), code('current_analysis_changed')); assert.deepEqual(f.dump(), before);
});

test('missing invalid and thenable retention responses never grant persistence', t => {
  const candidates: unknown[] = [undefined, () => false, () => 'true', () => ({ then() { throw new Error('Must not await retention'); } })];
  for (const candidate of candidates) {
    const f = fixture(t), api = f.bind({ ...f.config,
      retentionAllowedWithinWrite: candidate as SourceTrainingFeedbackBindings['retentionAllowedWithinWrite'] }), before = f.dump();
    assert.throws(() => api.read(f.actor), code('training_feedback_retention_unavailable'));
    assert.deepEqual(f.dump(), before); assert.equal(f.captures(), 0);
  }
});

test('original actor and command are detached before registration callbacks can mutate caller objects', t => {
  const f = fixture(t), api = f.bind(), command = f.command('record'), actor = { ...f.actor };
  f.onRegistration(() => {
    actor.sessionId = f.other.sessionId;
    command.event.accountId = f.other.accountId; command.event.recordId = 'replacement';
  });
  const result = api.mutate(actor, command);
  assert.equal(result.result.receipt.outcome, 'changed'); assert.equal(result.result.receipt.recordId, 'feedback');
  const row = f.db.prepare('SELECT account_id,data FROM feedback_events').get() as { account_id: string; data: string };
  assert.equal(row.account_id, f.actor.accountId); assert.equal((JSON.parse(row.data) as FeedbackLedgerEntry).event.accountId, f.actor.accountId);
  assert.ok(f.retentionRequests.some(request => request.operation === 'mutate' && Object.isFrozen(request.command.event)));
});

test('retained feedback predicate is original-writer scoped and skips missing or progress-only state without creating a ledger', t => {
  const f = fixture(t), other = fixture(t);
  assert.throws(() => hasRetainedFeedbackWithinWrite(f.db, f.writer, f.actor), code('canonical_writer_unproved'));
  f.prepareIdentities();
  f.writer.lifecycle.withActiveWrite(f.actor, () => {
    assert.equal(hasRetainedFeedbackWithinWrite(f.db, f.writer, f.actor), false);
    assert.throws(() => hasRetainedFeedbackWithinWrite(other.db, f.writer, f.actor), code('canonical_writer_unproved'));
    assert.throws(() => hasRetainedFeedbackWithinWrite(f.db, f.writer, f.other), code('canonical_writer_unproved'));
  });
  assert.equal(f.db.prepare('SELECT 1 FROM feedback_state').get(), undefined);
  f.bind().read(f.actor);
  f.writer.lifecycle.withActiveWrite(f.actor, () => assert.equal(hasRetainedFeedbackWithinWrite(f.db, f.writer, f.actor), true));
  assert.equal((f.db.prepare('SELECT count(*) n FROM feedback_events').get() as { n: number }).n, 0);
  const missing = fixture(t, progressComparisonMigrationSql);
  missing.writer.lifecycle.withActiveWrite(missing.actor, () => assert.equal(hasRetainedFeedbackWithinWrite(missing.db, missing.writer, missing.actor), false));
});


test('source first-plan and actual retained TRAIN invalidation share one writer and roll back the saved receipt together', async t => {
  const f = fixture(t); f.seed(); const api = f.bind(), before = f.dump();
  f.db.transaction(() => {
    f.db.exec(sourcePrescriptionMigration.sql);
    f.db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(19, hash(sourcePrescriptionMigration.sql), 'synthetic');
  }).immediate();
  const domain = new Domain(f.db, { sourcePrescription: 'selected-migration-19' });
  const source = { id: 'synthetic-source', revision: 'v1', locator: 'fixture', currentness: 'current' as const,
    qualification: 'Synthetic source qualification only' };
  const prepare = async (): Promise<PreparedSourceFirstPlan> => ({ schema: 'form.source-first-plan-preparation/v1',
    candidates: [{ id: 'synthetic-source-plan', qualification: 'qualified', source, plan: {
      schema: 'form.source-prescription-plan/v1', name: 'Synthetic source plan', origin: { kind: 'form-adaptation', id: 'fixture', revision: 'v1' },
      duration: { kind: 'estimated-range', minMinutes: 10, maxMinutes: 20 }, items: [{ id: 'practice',
        native: { exercise_id: 'native', role: 'synthetic practice', movement_pattern: 'synthetic pattern', sets: 2, rest_seconds: 60 },
        registeredDomain: { exerciseId: 'exercise', variantId: 'synthetic-variant', identity: { repository: 'synthetic/repo', revision: 'v1',
          path: 'catalog.json', sha256: 'a'.repeat(64), nativeId: 'native' }, registration: { id: 'synthetic-registration', revision: 'v1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
        load: { kind: 'unspecified', basis: 'unknown' } }],
    } }], assertCurrent() { f.writer.assertWithinWrite(f.actor); }, ports: {
      qualifyCatalog(input) { return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified', source,
        items: input.candidate.plan.items.map((item, index) => ({ itemId: item.id, exerciseId: item.registeredDomain.exerciseId,
          variantId: item.registeredDomain.variantId, prescriptionKey: input.prescriptions[index]!.prescriptionKey, retired: false, source })) }; },
      evaluateConstraints(input) { return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'eligible', source,
        reasons: [], rules: [{ ruleId: 'synthetic', outcome: 'satisfied', source, reasons: [] }] }; },
    } });
  let fail = true, hooks = 0;
  const binding = { writer: f.writer, afterPlanWriteWithinWrite(actor: AccountContext, plan: { id: string }) {
    f.writer.assertWithinWrite(actor); hooks++;
    assert.equal(hasRetainedFeedbackWithinWrite(f.db, f.writer, actor), true);
    api.invalidateWithinWrite(actor, [{ kind: 'plan', id: plan.id }]);
    if (fail) throw new DomainError(503, 'synthetic_after_invalidation_failure');
  } };
  const host = createFirstPlanHost(domain, prepare, binding), confirmation = { profileRevision: 0, preferencesRevision: 0 };
  await assert.rejects(host.create(f.actor, confirmation, 'source-fail'), code('synthetic_after_invalidation_failure'));
  assert.deepEqual(f.dump(), before);
  assert.equal((f.db.prepare('SELECT count(*) n FROM plans').get() as { n: number }).n, 1);
  assert.equal((f.db.prepare("SELECT count(*) n FROM command_receipts WHERE operation='plan.first'").get() as { n: number }).n, 0);
  fail = false;
  const saved = await host.create(f.actor, confirmation, 'source-save'); assert.ok('schema' in saved.plan);
  assert.deepEqual(await createFirstPlanHost(domain, undefined, binding).create(f.actor, confirmation, 'source-save'), saved);
  assert.equal(hooks, 2);
  assert.ok(f.retentionRequests.some(value => value.operation === 'invalidate' && value.sources.some(key => key.kind === 'plan' && key.id === saved.plan.id)));
});
