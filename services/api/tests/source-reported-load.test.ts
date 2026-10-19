import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Domain } from '../src/domain.js';
import { createServer, type ServerConfig } from '../src/server.js';
import { command, hash } from '../src/storage.js';
import { sourcePerformance, sourceSetCreate, sourceSetPatch, savedSourceSet, type SourcePrescriptionPlanFields, type SourceSetCreate, type SourceSetPatch } from '../src/schemas.js';
import { appendSourceReportedLoadMigration, selectAccountModuleMigrations } from '../src/integration/account-modules/migrations.js';
import { createCanonicalAccountWriter } from '../src/integration/account-modules/canonical-writer.js';
import { buildAccountExport } from '../src/lifecycle/export.js';
import { assertActive } from '../src/lifecycle/guards.js';
import { fixture as accountFixture, baseMigrations } from './integration/account-modules/fixture.js';

const full20 = selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, baseMigrations);
const selected = appendSourceReportedLoadMigration(full20);
const unknown = { state: 'unknown', confirmed: true } as const;
const known = (value = 12, unit = 'kg', basis = 'total') => ({ state: 'knownValue', value, unit, basis });
const performance = (load: unknown = known(), reps = 8) => ({ schema: 'form.source-performance/v2', kind: 'repetitions', reps, load });
const input = (load: unknown = known()) => ({ schema: 'form.source-performed-set/v2', expectedRevision: 1,
  occurrenceId: 'occurrence', setNumber: 1, status: 'confirmed', performance: performance(load) });
const v1 = { schema: 'form.source-performance/v1', kind: 'repetitions', reps: 8, load: { kind: 'unspecified', basis: 'unknown' } } as const;

// These compile-time assertions fail if either wrapper admits a mismatched performance version.
type AssertTrue<T extends true> = T;
type PerformanceV2 = { schema: 'form.source-performance/v2'; kind: 'repetitions'; reps: 8; load: { state: 'unknown'; confirmed: true } };
type Pair<Version extends string, Performance> = { schema: Version; performance: Performance; status: 'confirmed'; expectedRevision: 1 };
type WrongV1 = Pair<'form.source-performed-set/v1', PerformanceV2>;
type WrongV2 = Pair<'form.source-performed-set/v2', typeof v1>;
type CreateIdentity = { occurrenceId: 'occurrence'; setNumber: 1 };
type SavedIdentity = CreateIdentity & { id: 'set'; revision: 1; createdAt: string; updatedAt: string };
type RejectMixedPatchV1 = AssertTrue<WrongV1 extends SourceSetPatch ? false : true>;
type RejectMixedPatchV2 = AssertTrue<WrongV2 extends SourceSetPatch ? false : true>;
type RejectMixedCreate = AssertTrue<(WrongV1 & CreateIdentity) extends SourceSetCreate ? false : true>;
type RejectMixedSaved = AssertTrue<Omit<WrongV2, 'expectedRevision'> & SavedIdentity extends ReturnType<typeof savedSourceSet.parse> ? false : true>;
type AcceptPairedCreate = AssertTrue<(Pair<'form.source-performed-set/v2', PerformanceV2> & CreateIdentity) extends SourceSetCreate ? true : false>;

test('v2 retains literal units, four explicit bases, known zero, missingness and declared non-applicability', () => {
  for (const basis of ['total', 'perImplement', 'perSide', 'assistance']) for (const unit of ['kg', 'lb']) for (const value of [0, 12, 500]) {
    const raw = input(known(value, unit, basis));
    assert.deepEqual(sourceSetCreate.parse(raw), raw);
  }
  for (const load of [unknown, ...['bodyweight', 'unloaded', 'timedActivity'].map(reason => ({ state: 'notApplicable', reason }))])
    assert.deepEqual(sourceSetCreate.parse(input(load)), input(load));
  const omitted = input(); delete (omitted.performance as { load?: unknown }).load;
  assert.deepEqual(sourceSetCreate.parse(omitted), input(unknown));
  assert.equal(sourcePerformance.safeParse(omitted.performance).success, false);
  const practice = { ...input(unknown), performance: { schema: 'form.source-performance/v2', kind: 'controlled-practice', load: unknown } };
  assert.deepEqual(sourceSetCreate.parse(practice), practice);
  assert.equal(sourceSetCreate.safeParse({ ...practice, performance: { ...practice.performance, reps: 1 } }).success, false);
  assert.equal(sourceSetCreate.safeParse({ ...input(), performance: performance(unknown, 0) }).success, false);
  assert.equal(sourceSetCreate.safeParse({ ...input(), status: 'draft', performance: performance(unknown, 0) }).success, true);
});

test('strict capture and saved schemas reject mixed versions, null escapes, extras and unsupported load meanings', () => {
  for (const load of [null, {}, { state: 'unknown' }, { ...unknown, confirmed: false }, { ...unknown, value: 0 },
    { state: 'notApplicable', reason: 'unknown' }, { ...known(), basis: 'unspecified' }, { ...known(), unit: 'g' },
    ...[-1, 501, Infinity, -Infinity, NaN, '1'].map(value => ({ ...known(), value })), known(1200, 'lb')])
    assert.equal(sourceSetCreate.safeParse(input(load)).success, false);
  assert.equal(sourceSetCreate.safeParse({ ...input(), performance: v1 }).success, false);
  assert.equal(sourceSetCreate.safeParse({ ...input(), schema: 'form.source-performed-set/v1' }).success, false);
  assert.equal(sourcePerformance.safeParse({ ...v1, load: known() }).success, false);
  assert.equal(sourceSetPatch.safeParse({ schema: 'form.source-performed-set/v2', expectedRevision: 1,
    status: 'confirmed', performance: { schema: 'form.source-performance/v2', kind: 'repetitions', reps: 100 } }).success, true);
  const saved = { id: 'set', occurrenceId: 'occurrence', setNumber: 1, revision: 1, status: 'confirmed',
    createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', schema: 'form.source-performed-set/v2', performance: v1 };
  assert.equal(savedSourceSet.safeParse(saved).success, false);
});

function fixture(t: TestContext) {
  const f = accountFixture(); t.after(f.close);
  f.db.transaction(() => {
    for (const migration of selected.slice(16)) {
      f.db.exec(migration.sql);
      f.db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
    }
  }).immediate();
  const domain = new Domain(f.db, { sourcePrescription: 'selected-migration-19', sourceReportedLoad: 'selected-migration-22' });
  const writer = createCanonicalAccountWriter(f.db);
  const within = <T>(action: () => T) => writer.lifecycle.withActiveWrite(f.one, action);
  const plan: SourcePrescriptionPlanFields = { schema: 'form.source-prescription-plan/v1', name: 'Synthetic reported load',
    origin: { kind: 'form-adaptation', id: 'synthetic', revision: 'v1' }, duration: { kind: 'estimated-range', minMinutes: 10, maxMinutes: 20 },
    items: ['repetitions', 'practice'].map((kind, index) => ({ id: `item-${index}`, native: { exercise_id: 'native', movement_pattern: 'squat',
      role: 'synthetic', sets: 2, rest_seconds: 60, ...(kind === 'repetitions' ? { rep_range: [6, 10] as [number, number] } : {}) },
      registeredDomain: { exerciseId: 'synthetic-exercise', variantId: 'synthetic:variant',
        identity: { repository: 'synthetic/repository', revision: 'v1', path: 'fixture', sha256: 'a'.repeat(64), nativeId: 'native' },
        registration: { id: 'synthetic', revision: 'v1', digest: 'b'.repeat(64), bytes: 1 }, recordDigest: 'c'.repeat(64) },
      load: { kind: 'unspecified', basis: 'unknown' } })) };
  f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run('synthetic-exercise', JSON.stringify({ id: 'synthetic-exercise', name: 'Synthetic', cues: [], requiredConstraints: [] }));
  const savedPlan = within(() => domain.createSourcePlan(f.one.accountId, plan));
  const session = within(() => domain.startSession(f.one.accountId, savedPlan.id, 1));
  return { ...f, domain, writer, within, session, plan: savedPlan };
}

test('one writer preserves mixed v1/v2, literal history/replay, correction, clearing, void and export', t => {
  const f = fixture(t), account = f.one.accountId, session = f.session.id;
  const oldInput = sourceSetCreate.parse({ ...input(), occurrenceId: f.session.occurrences[0]!.id,
    schema: 'form.source-performed-set/v1', performance: v1 });
  const save = () => f.within(() => command(f.db, account, `set.create:${session}`, 'original-v1', oldInput,
    () => f.domain.authorizeOccurrence(account, session, oldInput.occurrenceId),
    () => ({ status: 201, body: f.domain.createSet(account, session, oldInput) })));
  const oldReceipt = save(); const old = f.domain.session(account, session).sets[0]!;
  const history = f.db.prepare('SELECT data FROM set_revisions WHERE set_id=?').get(old.id);
  const literal = f.db.prepare('SELECT performance FROM performed_sets WHERE id=?').get(old.id);
  assert.deepEqual(save(), oldReceipt);
  const create = sourceSetCreate.parse({ ...input(known(0, 'lb', 'assistance')), expectedRevision: 2,
    occurrenceId: old.occurrenceId, setNumber: 2 });
  const newer = f.within(() => f.domain.createSet(account, session, create));
  assert.deepEqual(f.db.prepare('SELECT performance FROM performed_sets WHERE id=?').get(old.id), literal);
  assert.deepEqual(f.domain.session(account, session).sets.map(set => 'schema' in set && set.schema),
    ['form.source-performed-set/v1', 'form.source-performed-set/v2']);
  assert.equal(f.domain.stats(account).volumeKg, null);
  assert.equal(f.domain.stats(account).coverage?.loadSets, 0);
  const correction = sourceSetPatch.parse({ schema: 'form.source-performed-set/v2', expectedRevision: 1, status: 'confirmed', performance: performance(known(22, 'lb', 'perSide')) });
  const corrected = f.within(() => f.domain.patchSet(account, session, old.id, correction));
  assert.ok('schema' in corrected.set); assert.equal(corrected.set.schema, 'form.source-performed-set/v2');
  assert.deepEqual(f.db.prepare('SELECT data FROM set_revisions WHERE set_id=? AND revision=1').get(old.id), history);
  assert.deepEqual(save(), oldReceipt);
  assert.throws(() => f.within(() => f.domain.patchSet(account, session, old.id,
    sourceSetPatch.parse({ ...correction, expectedRevision: 2, schema: 'form.source-performed-set/v1', performance: v1 }))), { code: 'source_set_downgrade_denied' });
  const cleared = f.within(() => f.domain.patchSet(account, session, old.id, sourceSetPatch.parse({ ...correction, expectedRevision: 2, performance: performance(unknown) })));
  assert.ok('schema' in cleared.set); assert.deepEqual(cleared.set.performance.load, unknown);
  const voided = f.within(() => f.domain.voidSet(account, session, newer.set.id, 1));
  assert.ok('schema' in voided.set); assert.equal(voided.set.schema, 'form.source-performed-set/v2');
  assert.deepEqual(voided.set.performance.load, known(0, 'lb', 'assistance'));
  assert.deepEqual(f.domain.session(account, session).planSnapshot, f.plan);
  const exported = JSON.parse(buildAccountExport(f.db, f.one, actor => assertActive(f.db, actor)).json) as { records: { category: string; value: Record<string, unknown> }[] };
  const rows = exported.records.filter(row => row.category === 'performedSets');
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.value.schema === 'form.source-performed-set/v2'));
  assert.ok(exported.records.some(row => row.category === 'setRevisions' && JSON.stringify(row.value).includes('form.source-performance/v1')));
});

test('capability plus genuine prerequisites are required, and account/CAS/replay meaning fences remain', t => {
  const f = fixture(t), account = f.one.accountId, session = f.session.id;
  const captured = sourceSetCreate.parse({ ...input(), occurrenceId: f.session.occurrences[0]!.id });
  assert.throws(() => new Domain(f.db, { sourcePrescription: 'selected-migration-19' }).createSet(account, session, captured), { code: 'source_reported_load_unavailable' });
  const execute = (value: typeof captured) => f.within(() => command(f.db, account, `set.create:${session}`, 'v2-key', value,
    () => f.domain.authorizeOccurrence(account, session, value.occurrenceId), () => ({ status: 201, body: f.domain.createSet(account, session, value) })));
  const receipt = execute(captured); assert.deepEqual(execute(captured), receipt);
  for (const load of [known(13), known(12, 'lb'), known(12, 'kg', 'perSide'), { state: 'notApplicable', reason: 'bodyweight' }, unknown])
    assert.throws(() => execute(sourceSetCreate.parse({ ...captured, performance: performance(load) })), { code: 'idempotency_mismatch' });
  assert.throws(() => f.within(() => f.domain.createSet(account, session, { ...captured, setNumber: 2 })), { code: 'stale_revision' });
  assert.throws(() => f.domain.session(f.two.accountId, session), { code: 'not_found' });
  assert.throws(() => f.writer.lifecycle.withActiveWrite({ ...f.one, epoch: f.one.epoch + 1 }, () => execute(captured)), { code: 'account_epoch_changed' });
  const set = f.domain.session(account, session).sets[0]!;
  f.db.prepare('UPDATE form_migrations SET checksum=? WHERE version=20').run('forged');
  assert.throws(() => f.within(() => f.domain.voidSet(account, session, set.id, 1)), { code: 'source_reported_load_unavailable' });
});


test('server admission rejects unbound load selection and runtime injection before database opening', async () => {
  const configuration: ServerConfig = { dbPath: '/source-reported-load-not-opened/synthetic.sqlite', baseURL: 'http://127.0.0.1:47839',
    secret: 'synthetic-source-load-secret-over-32-characters', sourceReportedLoad: 'selected-migration-22' };
  await assert.rejects(createServer(configuration), { code: 'source_reported_load_migration_prerequisites_required' });
  let closed = 0;
  const runtimeOwner = { close: () => { closed++; } } as unknown as NonNullable<ServerConfig['runtimeOwner']>;
  await assert.rejects(createServer({ ...configuration, runtimeOwner }), /Runtime ownership cannot mix source injections/);
  assert.equal(closed, 1);
});
