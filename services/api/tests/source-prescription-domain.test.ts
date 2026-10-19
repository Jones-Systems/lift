import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Domain } from '../src/domain.js';
import { DomainError } from '../src/errors.js';
import { canonical, command, hash } from '../src/storage.js';
import { sourcePrescriptionMigration } from '../src/source-prescription-migration.js';
import { sourceProgressComparisonMigration, sourceFeedbackMigration } from '../src/integration/account-modules/migrations.js';
import { createCanonicalAccountWriter } from '../src/integration/account-modules/canonical-writer.js';
import { createFirstPlanHost, type PreparedSourceFirstPlan } from '../src/integration/first-plan/index.js';
import { normalizeSourceFirstPlanInput, sourcePrescriptionKey, type SourcePlanCandidate } from '../src/planning/first-plan/index.js';
import { sourceSetCreate, sourceSetPatch, sourcePerformance, type SourcePrescriptionPlanFields, type SourcePerformance, type SourceSetCreate, type Profile } from '../src/schemas.js';
import { assertActive } from '../src/lifecycle/guards.js';
import { buildAccountExport } from '../src/lifecycle/export.js';
import { captureCurrentAnalysisWithinWrite } from '../src/integration/training-feedback/context-association.js';
import { fixture as accountFixture } from './integration/account-modules/fixture.js';

const confirmation = { profileRevision: 0, preferencesRevision: 0 };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const load = { kind: 'unspecified', basis: 'unknown' } as const;
type SourcePerformanceV1 = Extract<SourcePerformance, { schema: 'form.source-performance/v1' }>;
const reported = (reps: number): SourcePerformanceV1 => ({ schema: 'form.source-performance/v1', kind: 'repetitions', reps, load });
const practice: SourcePerformanceV1 = { schema: 'form.source-performance/v1', kind: 'controlled-practice', load };
function sourcePlan(): SourcePrescriptionPlanFields {
  return { schema: 'form.source-prescription-plan/v1', name: 'Synthetic source qualification only',
    origin: { kind: 'form-adaptation', id: 'synthetic-origin', revision: 'synthetic-v1' },
    duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 },
    items: Array.from({ length: 4 }, (_, index) => ({ id: `item-${index}`,
      native: { exercise_id: `native-${index}`, movement_pattern: ' source-defined pattern ', role: 'source-defined role',
        sets: 2, rest_seconds: 60, ...(index < 3 ? { rep_range: [8, 12] as [number, number] } : {}),
        ...(index === 0 ? { target_rir: 0, substituted_for: 'original', notes: [' second ', '', 'first', ' second '] } : {}) },
      registeredDomain: { exerciseId: `domain-${index}`, variantId: `synthetic:variant-${index}`,
        identity: { repository: 'synthetic/repository', revision: 'synthetic-v1', path: 'synthetic/catalog.json', sha256: 'a'.repeat(64), nativeId: `native-${index}` },
        registration: { id: 'synthetic-registry', revision: 'synthetic-v1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) }, load })),
  };
}
function preparation(check: () => void = () => {}): PreparedSourceFirstPlan {
  const source = { id: 'synthetic-source', revision: 'test-v1', locator: 'fixture:invented', currentness: 'current' as const,
    qualification: 'Synthetic mechanics only; no production registration or rights.' };
  const candidate: SourcePlanCandidate = { id: 'synthetic-candidate', qualification: 'qualified', source, plan: sourcePlan() };
  return { schema: 'form.source-first-plan-preparation/v1', candidates: [candidate], assertCurrent: check, ports: {
    qualifyCatalog(input) {
      const normalized = normalizeSourceFirstPlanInput({ context: input.context,
        confirmation: { accountId: input.context.accountId, profileRevision: input.context.profile.revision, preferencesRevision: input.context.preferences.revision }, candidate });
      assert.equal(normalized.status, 'valid');
      if (normalized.status === 'valid') assert.deepEqual(input, normalized.input);
      return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified', source,
        items: input.candidate.plan.items.map(item => ({ itemId: item.id, exerciseId: item.registeredDomain.exerciseId,
          variantId: item.registeredDomain.variantId, prescriptionKey: sourcePrescriptionKey(item), retired: false, source })) };
    },
    evaluateConstraints(input) { return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'eligible', source,
      reasons: [], rules: [{ ruleId: 'synthetic-rule', outcome: 'satisfied', source, reasons: [] }] }; },
  } };
}
function fixture(t: TestContext, upgraded = true) {
  const f = accountFixture(); t.after(f.close);
  if (upgraded) f.db.transaction(() => {
    for (const migration of [sourceProgressComparisonMigration, sourceFeedbackMigration, sourcePrescriptionMigration]) {
      f.db.exec(migration.sql);
      f.db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
    }
  }).immediate();
  const domain = new Domain(f.db, { sourcePrescription: 'selected-migration-19' }), writer = createCanonicalAccountWriter(f.db);
  for (const item of sourcePlan().items) f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)')
    .run(item.registeredDomain.exerciseId, JSON.stringify({ id: item.registeredDomain.exerciseId, name: 'Synthetic registered identity', cues: [], requiredConstraints: [] }));
  const within = <T>(effect: () => T): T => writer.lifecycle.withActiveWrite(f.one, effect);
  let invalidations = 0;
  const binding = { writer, afterPlanWriteWithinWrite(actor: typeof f.one) { writer.assertWithinWrite(actor); invalidations++; } };
  const count = (table: string) => (f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  return { ...f, domain, writer, within, binding, count, invalidations: () => invalidations };
}
function legacy() { return { name: 'Legacy', minutes: 20, items: [{ id: 'legacy-item', exerciseId: 'domain-0', setTarget: 2, repMin: 8, repMax: 12, targetKg: 10 }] }; }

test('synthetic source first-plan uses actual normalization, one writer, immutable receipt replay and no second plan', async t => {
  const f = fixture(t); let preparations = 0;
  const host = createFirstPlanHost(f.domain, async (actor, context) => {
    preparations++; assert.equal(f.db.inTransaction, false); assert.deepEqual(actor, f.one);
    assert.equal(context.accountId, f.one.accountId); return preparation(() => f.writer.assertWithinWrite(actor));
  }, f.binding);
  const first = await host.create(f.one, confirmation, 'source-save');
  assert.deepEqual(first.plan, { ...sourcePlan(), id: first.plan.id, revision: 1, archived: false,
    createdAt: first.plan.createdAt, updatedAt: first.plan.updatedAt });
  assert.equal(f.invalidations(), 1); assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_item_ids'), 4);
  f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, trainingContext: 'Changed later context' });
  const reopenedDomain = new Domain(f.db);
  assert.deepEqual(await createFirstPlanHost(reopenedDomain).create(f.one, confirmation, 'source-save'), first);
  assert.equal(preparations, 1); assert.equal(f.count('plans'), 1); assert.equal(f.count('command_receipts'), 1);
  assert.deepEqual(reopenedDomain.plan(f.one.accountId, first.plan.id), first.plan);
});

test('four source occurrences retain six reported repetition sets and two practice records through completion, history, archive and export', async t => {
  const f = fixture(t), receipt = await createFirstPlanHost(f.domain, async () => preparation(), f.binding).create(f.one, confirmation, 'first');
  const session = f.within(() => f.domain.startSession(f.one.accountId, receipt.plan.id, 1));
  assert.equal(session.occurrences.length, 4); assert.deepEqual(session.planSnapshot, receipt.plan);
  assert.deepEqual(session.occurrences.map(item => item.target), sourcePlan().items);
  for (const [position, occurrence] of session.occurrences.entries()) for (const number of [1, 2]) {
    const input: SourceSetCreate = { schema: 'form.source-performed-set/v1', occurrenceId: occurrence.id, setNumber: number,
      expectedRevision: position * 2 + number, status: 'confirmed', performance: position < 3 ? reported(3 + number) : practice };
    const save = (): ReturnType<typeof command> => f.within(() => command(f.db, f.one.accountId, `set.create:${session.id}`, `set-${position}-${number}`, input,
      () => f.domain.authorizeOccurrence(f.one.accountId, session.id, occurrence.id),
      () => ({ status: 201, body: f.domain.createSet(f.one.accountId, session.id, input) })));
    const first = save(); assert.deepEqual(save(), first);
  }
  assert.equal(f.count('performed_sets'), 8); assert.equal(f.count('set_revisions'), 8);
  const completed = f.within(() => f.domain.completeSession(f.one.accountId, session.id, 9));
  assert.equal(completed.status, 'completed');
  for (const set of completed.sets) { assert.equal('reps' in set, false); assert.equal('weightKg' in set, false); assert.equal('schema' in set, true); }
  const stats = f.domain.stats(f.one.accountId);
  assert.equal(stats.maxWeightKg, null);
  assert.equal(stats.confirmedSets, 8); assert.equal(stats.completedSessions, 1); assert.equal(stats.repetitions, null); assert.equal(stats.volumeKg, null);
  assert.deepEqual(stats.coverage, { repetitionSets: 6, loadSets: 0, practiceSets: 2 });
  assert.deepEqual(stats.byExercise.map(item => [item.repetitions, item.volumeKg, item.maxWeightKg]), [[9, null, null], [9, null, null], [9, null, null], [null, null, null]]);
  f.within(() => f.domain.archivePlan(f.one.accountId, receipt.plan.id, 1));
  assert.deepEqual(f.domain.planRevision(f.one.accountId, receipt.plan.id, 1), { ...sourcePlan(), id: receipt.plan.id, revision: 1, archived: false });
  assert.deepEqual(f.domain.planRevision(f.one.accountId, receipt.plan.id, 2), { ...sourcePlan(), id: receipt.plan.id, revision: 2, archived: true });
  assert.deepEqual(f.domain.history(f.one.accountId, 10).items[0], completed);
  const exported = buildAccountExport(f.db, f.one, actor => assertActive(f.db, actor));
  const rows = (JSON.parse(exported.json) as { records: { category: string; value: Record<string, unknown> }[] }).records;
  const category = (name: string) => rows.filter(row => row.category === name).map(row => row.value);
  assert.deepEqual(category('plans')[0]!.data, sourcePlan());
  assert.deepEqual(category('planRevisions').map(row => row.data), [{ ...sourcePlan(), archived: false }, { ...sourcePlan(), archived: true }]);
  assert.deepEqual(category('workoutSessions')[0]!.snapshot, receipt.plan);
  assert.deepEqual(category('sessionOccurrences').map(row => row.target), sourcePlan().items);
  assert.equal(category('performedSets').length, 8);
  for (const row of category('performedSets')) { assert.equal(row.schema, 'form.source-performed-set/v1'); assert.equal('reps' in row, false); assert.equal('weightKg' in row, false); }
  assert.deepEqual(category('setRevisions').map(row => row.data).sort((a, b) => canonical(a).localeCompare(canonical(b))),
    [...completed.sets].sort((a, b) => canonical(a).localeCompare(canonical(b))));
  assert.deepEqual(category('operationHistory').find(row => row.operation === 'plan.first')!.result, receipt);
  assert.equal(exported.bytes, Buffer.byteLength(exported.json));
  assert.throws(() => buildAccountExport(f.db, f.one, actor => assertActive(f.db, actor), [], 100), code('account_export_packaging_required'));
});

test('explicit source capability plus exact installed migration are required while legacy INSERT and numeric metrics work on both schemas', t => {
  for (const upgraded of [false, true]) {
    const f = fixture(t, upgraded), disabled = new Domain(f.db);
    assert.throws(() => disabled.createSourcePlan(f.one.accountId, sourcePlan()), code('source_prescription_unavailable'));
    if (!upgraded) assert.throws(() => f.domain.createSourcePlan(f.one.accountId, sourcePlan()), code('source_prescription_unavailable'));
    const plan = disabled.createPlan(f.one.accountId, legacy()), session = disabled.startSession(f.one.accountId, plan.id, 1);
    const result = disabled.createSet(f.one.accountId, session.id, { occurrenceId: session.occurrences[0]!.id, setNumber: 1,
      expectedRevision: 1, reps: 7, weightKg: 10, status: 'confirmed' });
    assert.equal('schema' in result.set, false); assert.equal('performance' in result.set, false);
    assert.deepEqual(disabled.stats(f.one.accountId), { confirmedSets: 1, repetitions: 7, volumeKg: 70, completedSessions: 0,
      byExercise: [{ exerciseId: 'domain-0', confirmedSets: 1, repetitions: 7, volumeKg: 70, maxWeightKg: 10 }],
      units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true });
    disabled.patchSet(f.one.accountId, session.id, result.set.id, { expectedRevision: 1, reps: 8, weightKg: 11, status: 'confirmed' });
    assert.equal(disabled.stats(f.one.accountId).volumeKg, 88);
  }
});

test('source set validation never accepts mixed payloads, target-derived measurements, kind switches or foreign occurrences', t => {
  const f = fixture(t), plan = f.domain.createSourcePlan(f.one.accountId, sourcePlan()), session = f.domain.startSession(f.one.accountId, plan.id, 1);
  const input: SourceSetCreate = { schema: 'form.source-performed-set/v1', occurrenceId: session.occurrences[0]!.id, setNumber: 1,
    expectedRevision: 1, status: 'confirmed', performance: reported(4) };
  assert.equal(sourceSetCreate.safeParse({ ...input, reps: 8, weightKg: 0 }).success, false);
  assert.equal(sourceSetCreate.safeParse({ ...input, performance: reported(0) }).success, false);
  assert.equal(sourceSetPatch.safeParse(input).success, false);
  assert.equal(sourcePerformance.safeParse({ ...practice, reps: 1 }).success, false);
  assert.throws(() => f.domain.patchPlan(f.one.accountId, plan.id, { expectedRevision: 1, name: 'Lossy edit' }), code('source_plan_legacy_edit_denied'));
  assert.throws(() => f.domain.createSet(f.one.accountId, session.id, { ...input, performance: practice }), code('set_performance_kind_mismatch'));
  assert.throws(() => f.domain.createSet(f.one.accountId, session.id, { occurrenceId: input.occurrenceId, setNumber: 1, expectedRevision: 1,
    reps: 8, weightKg: 0, status: 'confirmed' }), code('set_format_mismatch'));
  const foreignPlan = f.domain.createSourcePlan(f.two.accountId, sourcePlan()), foreign = f.domain.startSession(f.two.accountId, foreignPlan.id, 1);
  assert.throws(() => f.domain.createSet(f.one.accountId, session.id, { ...input, occurrenceId: foreign.occurrences[0]!.id }), code('not_found'));
  const saved = f.domain.createSet(f.one.accountId, session.id, input);
  assert.throws(() => f.domain.patchSet(f.one.accountId, session.id, saved.set.id, { schema: input.schema, expectedRevision: 1, status: 'confirmed', performance: practice }), code('set_performance_kind_mismatch'));
  assert.throws(() => f.domain.patchSet(f.one.accountId, session.id, saved.set.id, { expectedRevision: 1, status: 'confirmed', reps: 8, weightKg: 0 }), code('set_format_mismatch'));
  const updated = f.domain.patchSet(f.one.accountId, session.id, saved.set.id, { schema: input.schema, expectedRevision: 1, status: 'confirmed', performance: reported(5) });
  assert.ok('schema' in updated.set); assert.deepEqual(updated.set.performance, reported(5));
  f.domain.voidSet(f.one.accountId, session.id, saved.set.id, 2);
  assert.equal(f.domain.stats(f.one.accountId).confirmedSets, 0);
});

test('source preparation stale actor/context/sources and invalidation failure roll back plan, identities and receipt together', async t => {
  for (const failure of ['actor', 'epoch', 'context', 'source', 'mixed', 'hook', 'post-hook', 'missing-writer'] as const) {
    const f = fixture(t); let checks = 0;
    const host = createFirstPlanHost(f.domain, async () => {
      if (failure === 'actor') f.db.prepare('DELETE FROM session WHERE id=?').run(f.one.sessionId);
      if (failure === 'epoch') f.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(f.one.accountId);
      if (failure === 'context') f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, goals: ['Changed'] });
      const prepared = preparation(() => { if (++checks === 3 && failure === 'source') throw Error('source superseded'); });
      if (failure === 'mixed') Object.assign(prepared.candidates[0]!, { plan: legacy() });
      return prepared;
    }, failure === 'missing-writer' ? undefined : { writer: f.writer, afterPlanWriteWithinWrite(actor) {
      f.writer.assertWithinWrite(actor);
      if (failure === 'hook') throw new DomainError(503, 'synthetic_invalidation_failed');
      if (failure === 'post-hook') f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, goals: ['Changed in hook'] });
    } });
    await assert.rejects(host.create(f.one, confirmation, 'rollback'), code({ actor: 'account_session_invalid', epoch: 'account_epoch_changed', context: 'first_plan_confirmation_stale',
      source: 'first_plan_sources_changed', mixed: 'first_plan_blocked', hook: 'synthetic_invalidation_failed', 'post-hook': 'first_plan_confirmation_stale', 'missing-writer': 'source_first_plan_writer_required' }[failure]));
    for (const table of ['plans', 'plan_revisions', 'plan_item_ids', 'command_receipts']) assert.equal(f.count(table), 0, `${failure}:${table}`);
    if (failure === 'post-hook') assert.equal(f.domain.document<Profile>(f.one.accountId, 'profile').revision, 0);
  }
});

test('source historical TRAIN join preserves exact plan revision, native optional presence and Domain identity after archive', t => {
  const f = fixture(t), plan = f.domain.createSourcePlan(f.one.accountId, sourcePlan()), session = f.domain.startSession(f.one.accountId, plan.id, 1);
  f.domain.archivePlan(f.one.accountId, plan.id, 1);
  f.db.prepare('UPDATE exercises SET retired=1').run();
  const read = () => f.within(() => {
    const association = captureCurrentAnalysisWithinWrite({ context: f.one, domain: f.domain, writer: f.writer });
    return association.readContextWithinWrite(f.one, { scope: { kind: 'session', contextId: association.contextId, sessionId: session.id, planId: plan.id },
      selection: { sessionId: session.id, occurrenceId: session.occurrences[3]!.id } });
  });
  assert.equal(read().sessionSource!.planSnapshot.planRevision, 1);
  const snapshot = f.domain.session(f.one.accountId, session.id).planSnapshot;
  assert.ok('schema' in snapshot); assert.equal(Object.hasOwn(snapshot.items[3]!.native, 'rep_range'), false);
  const corrupted = structuredClone(snapshot); corrupted.duration.minMinutes++;
  const originalSession = f.domain.session.bind(f.domain);
  const changed = t.mock.method(f.domain, 'session', (accountId: string, id: string) => ({ ...originalSession(accountId, id), planSnapshot: corrupted }));
  assert.throws(read, code('current_analysis_context_unavailable')); changed.mock.restore();
  f.db.prepare('UPDATE plan_item_ids SET exercise_id=? WHERE account_id=? AND plan_id=? AND id=?').run('domain-2', f.one.accountId, plan.id, 'item-3');
  assert.throws(read, code('current_analysis_context_unavailable'));
});

test('malformed persisted source data is rejected without lossy projection in domain and export', t => {
  const f = fixture(t), plan = f.domain.createSourcePlan(f.one.accountId, sourcePlan()), session = f.domain.startSession(f.one.accountId, plan.id, 1);
  const malformed = { ...sourcePlan(), minutes: 20 };
  f.db.prepare('UPDATE plans SET data=? WHERE account_id=? AND id=?').run(JSON.stringify(malformed), f.one.accountId, plan.id);
  assert.throws(() => f.domain.plan(f.one.accountId, plan.id), code('stored_training_data_invalid'));
  assert.throws(() => buildAccountExport(f.db, f.one, actor => assertActive(f.db, actor)), code('account_export_invalid_data'));
  f.db.prepare('UPDATE plans SET data=? WHERE account_id=? AND id=?').run(JSON.stringify(sourcePlan()), f.one.accountId, plan.id);
  const target = { ...sourcePlan().items[0], targetKg: 0 };
  f.db.prepare("INSERT INTO workout_sessions VALUES(?,?,?,1,1,?,'active',?,NULL)")
    .run(f.one.accountId, 'malformed', plan.id, JSON.stringify(session.planSnapshot), new Date().toISOString());
  f.db.prepare('INSERT INTO session_occurrences VALUES(?,?,?,?,?,?,?)')
    .run(f.one.accountId, 'malformed', 'malformed-occurrence', 'item-0', 'domain-0', 0, JSON.stringify(target));
  assert.throws(() => f.domain.session(f.one.accountId, 'malformed'), code('stored_training_data_invalid'));
  assert.throws(() => buildAccountExport(f.db, f.one, actor => assertActive(f.db, actor)), code('account_export_invalid_data'));
});


test('mixed legacy and source repetition metrics retain known counts while incomplete load never becomes zero or a subtotal', t => {
  const f = fixture(t), plan = f.domain.createSourcePlan(f.one.accountId, sourcePlan()), session = f.domain.startSession(f.one.accountId, plan.id, 1);
  f.domain.createSet(f.one.accountId, session.id, { schema: 'form.source-performed-set/v1', occurrenceId: session.occurrences[0]!.id,
    setNumber: 1, expectedRevision: 1, status: 'confirmed', performance: reported(5) });
  const manual = f.domain.createPlan(f.one.accountId, legacy()), other = f.domain.startSession(f.one.accountId, manual.id, 1);
  f.domain.createSet(f.one.accountId, other.id, { occurrenceId: other.occurrences[0]!.id, setNumber: 1, expectedRevision: 1,
    status: 'confirmed', reps: 7, weightKg: 10 });
  const stats = f.domain.stats(f.one.accountId);
  assert.equal(stats.repetitions, 12); assert.equal(stats.volumeKg, null); assert.equal(stats.maxWeightKg, null);
  assert.deepEqual(stats.coverage, { repetitionSets: 2, loadSets: 1, practiceSets: 0 });
  assert.deepEqual(stats.byExercise, [{ exerciseId: 'domain-0', confirmedSets: 2, repetitions: 12, volumeKg: null, maxWeightKg: null,
    coverage: { repetitionSets: 2, loadSets: 1, practiceSets: 0 } }]);
});
