import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RETAINED_CATALOG_INPUTS } from '../../../src/catalog-qualification/retained.js';
import { createRegisteredNativeCatalogFactory, type NativeDomainRegistrationV1, type RegistrationPin } from '../../../src/catalog-qualification/registered-identity.js';
import { Domain } from '../../../src/domain.js';
import { DomainError } from '../../../src/errors.js';
import { createCanonicalAccountWriter } from '../../../src/integration/account-modules/canonical-writer.js';
import { createFirstPlanHost } from '../../../src/integration/first-plan/index.js';
import { createOperationalSourceFirstPlanPreparation } from '../../../src/integration/first-plan/source-operational-preparation.js';
import { assertActive } from '../../../src/lifecycle/guards.js';
import type { AccountContext } from '../../../src/lifecycle/types.js';
import { inspectConstraintCapture, type AcceptedConstraintMetadata, type CaptureWitnesses, type ConstraintCaptureHost,
  type QuestionInventory } from '../../../src/planning/constraints/confirmed-capture.js';
import { FALLBACK_POLICY } from '../../../src/planning/first-plan/fallback-policy.js';
import { normalizeContext, sourcePrescriptionKey } from '../../../src/planning/first-plan/normalization.js';
import { createFallbackFirstPlanSource } from '../../../src/planning/first-plan/operational-fallback-source.js';
import type { PlanningContext, SourcePlanCandidate } from '../../../src/planning/first-plan/types.js';
import { assertSourceSubscriptionStatusHistory, assertSourceSubscriptionStatusSelection,
  selectSourceSubscriptionStatusMigrations } from '../../../src/purchases/status-source-migrations.js';
import type { Preferences, Profile } from '../../../src/schemas.js';
import { canonical, hash } from '../../../src/storage.js';
import { fixture as accountFixture } from '../account-modules/fixture.js';
import { source as fixtureSource } from './fixture.js';

// Private-grounding/blocked: retained bytes are required, never copied or replaced by dummy inputs.
// Authentic 58-record registration; accepting its pin/installed rows and all metadata/R1 below is synthetic test authority.
const root = resolve(process.cwd(), '../..');
const legacyBytes = readFileSync(resolve(root, RETAINED_CATALOG_INPUTS.legacy.path));
const registrationBytes = readFileSync(resolve(root, 'docs/knowledge/catalog-cues/registrations/native-engine-v1.candidate.json'));
const registration: NativeDomainRegistrationV1 = JSON.parse(registrationBytes.toString('utf8'));
const pin: RegistrationPin = { id: 'form-native-engine-registration-candidate',
  revision: '442c5cd07f14142326af10fe0eb6d079b0e62a71-v1',
  digest: 'c326ccbba03fcc1fe5807d20811e7cd57b87be4c2ebf0361e922028e7bb131ed', bytes: 77470 };
const syntheticSource = { ...fixtureSource, qualification: 'qualified' as const };
const questions: QuestionInventory = { id: 'synthetic-questions', revision: '1', source: syntheticSource,
  questions: [{ id: 'synthetic-question', revision: '1', prompt: 'Synthetic fixture answer?', kind: 'text', required: true }],
  consent: { id: 'synthetic-consent', revision: '1', text: 'Synthetic permission only.' } };
const payload = { answers: [{ questionId: 'synthetic-question', questionRevision: '1',
  response: { state: 'answered' as const, literal: 'Synthetic answer.' } }], facts: [],
  restrictionInventory: { response: { state: 'no' as const, literal: 'Synthetic no reported instructions.' }, instructionIds: [] },
  consent: { decision: 'granted' as const, statementId: 'synthetic-consent', statementRevision: '1' } };
const code = (status: DomainError['status'], expected: string) => (error: unknown) =>
  error instanceof DomainError && error.status === status && error.code === expected;

// Genuine migration 4 makes catalog id/data immutable, so a plain UPDATE would test that trigger instead of the
// composer's row recheck. This test-only seam suspends exactly that trigger for one data rewrite inside the
// composer's write transaction and recreates it from its original sqlite_master text before returning.
type Database = ReturnType<typeof accountFixture>['db'];
const catalogTrigger = (db: Database) => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='immutable_catalog'").get() as { sql: string } | undefined;
  assert.ok(row?.sql.includes('BEFORE UPDATE OF id,data ON exercises')); return row.sql;
};
const assertCatalogImmutable = (db: Database, exerciseId: string) =>
  assert.throws(() => db.prepare('UPDATE exercises SET data=? WHERE id=?').run('{}', exerciseId), /immutable_catalog/);
function driftCatalogRowData(db: Database, exerciseId: string, data: string) {
  assert.equal(db.inTransaction, true);
  const trigger = catalogTrigger(db);
  db.exec('DROP TRIGGER immutable_catalog');
  try { assert.equal(db.prepare('UPDATE exercises SET data=? WHERE id=?').run(data, exerciseId).changes, 1); }
  finally { db.exec(trigger); }
  assert.equal(catalogTrigger(db), trigger);
  assert.deepEqual(db.prepare('SELECT data,retired FROM exercises WHERE id=?').get(exerciseId), { data, retired: 0 });
}

function fixture(t: TestContext) {
  const f = accountFixture(); t.after(() => { if (f.db.open) f.close(); });
  const migrations = selectSourceSubscriptionStatusMigrations(); assertSourceSubscriptionStatusSelection(migrations);
  const existing = f.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as { version: number; checksum: string }[];
  assert.equal(existing.length, 16); assertSourceSubscriptionStatusHistory(existing);
  for (const migration of migrations.slice(existing.length)) {
    f.db.exec(migration.sql);
    f.db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
  }
  const history = f.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as { version: number; checksum: string }[];
  assert.equal(history.length, 27); assertSourceSubscriptionStatusHistory(history, true);
  assert.equal(registration.entries.length, 58); assert.equal(registrationBytes.length, pin.bytes);
  assert.equal(createHash('sha256').update(registrationBytes).digest('hex'), pin.digest);
  const registered = createRegisteredNativeCatalogFactory([pin])({ legacyBytes, registrationBytes });
  assert.deepEqual(registered.registration, pin);
  for (const entry of registration.entries) {
    assert.deepEqual(registered.getRegisteredRecord(entry.exerciseId), entry.record);
    f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run(entry.exerciseId, canonical(entry.record));
  }
  const domain = new Domain(f.db, { sourcePrescription: 'selected-migration-19' }), writer = createCanonicalAccountWriter(f.db);
  const preferences = domain.patchDocument<Preferences>(f.one.accountId, 'preferences',
    { expectedRevision: 0, equipment: [...FALLBACK_POLICY.equipment], sessionMinutes: 25 });
  const confirmation = { profileRevision: 0, preferencesRevision: preferences.revision };
  const state = { captures: 0, reads: 0, afterWrites: 0, capturing: false, metadataAvailable: true,
    metadataRevision: 'test-v1', metadataEquipment: [] as string[], pinChange: {},
    registration: { acceptedPins: [pin], input: { legacyBytes: new Uint8Array(legacyBytes), registrationBytes: new Uint8Array(registrationBytes) } },
    witnesses: null as CaptureWitnesses | null, captureHost: null as ConstraintCaptureHost | null,
    afterCapture: () => {}, afterWrite: () => {}, witnessRead: null as (() => CaptureWitnesses) | null,
    activeRead: null as (() => void) | null,
    metadataRead: null as (() => AcceptedConstraintMetadata | null) | null };
  const ports = {
    registration: () => state.registration,
    captureHost(actor: AccountContext, context: PlanningContext): ConstraintCaptureHost {
      state.captures++; assert.equal(f.db.inTransaction, false); state.capturing = true;
      const normalized = normalizeContext(context, { accountId: actor.accountId,
        profileRevision: context.profile.revision, preferencesRevision: context.preferences.revision });
      assert.equal(normalized.status, 'valid');
      if (normalized.status !== 'valid') throw new Error('Invalid fixture context');
      const inspection = inspectConstraintCapture(payload, questions); assert.equal(inspection.status, 'captured');
      if (inspection.status !== 'captured') throw new Error('Invalid fixture capture');
      const capturePin = { id: 'synthetic-capture', revision: '1', digest: inspection.digest,
        accountId: actor.accountId, sessionId: actor.sessionId, contextKey: normalized.contextKey,
        profileRevision: context.profile.revision, preferencesRevision: context.preferences.revision, ...state.pinChange };
      const binding = { context: normalized.contextKey, catalog: pin.revision, rules: 'synthetic-rules', preflight: 'synthetic-r1' };
      state.witnesses = { capture: { pin: capturePin, payload: structuredClone(payload),
        source: { id: 'synthetic-confirmation', revision: '1', locator: 'fixture:confirmed', currentness: 'current' },
        confirmation: { id: 'synthetic-confirm-action', captureRevision: '1', captureDigest: inspection.digest,
          confirmedAt: '2026-10-29T20:00:00Z' } }, questions: structuredClone(questions),
        variants: { source: syntheticSource, variants: [] },
        r1: { capture: capturePin, captureFactIds: [], snapshot: { binding, current: { ...binding },
          facts: [], requiredFactIds: [], rules: [], preflight: { complete: true, trainingState: 'self_directed',
            source: syntheticSource, regions: [], restrictionCoverage: { complete: true, ruleIds: [], instructions: [] } } } } };
      const host: ConstraintCaptureHost = { pin: capturePin, assertActive() {
        if (state.activeRead) return state.activeRead();
        assertActive(f.db, actor);
      },
        readCurrent() {
          state.reads++;
          if (state.capturing) assert.equal(f.db.inTransaction, false);
          else writer.assertWithinWrite(actor);
          if (state.witnessRead) return state.witnessRead();
          assert.ok(state.witnesses); return state.witnesses;
        } };
      state.captureHost = host; return host;
    },
    acceptedMetadata(candidate: SourcePlanCandidate, context: PlanningContext): AcceptedConstraintMetadata | null {
      if (state.metadataRead) return state.metadataRead();
      if (!state.metadataAvailable) return null;
      const source = { ...syntheticSource, revision: state.metadataRevision };
      return { source, structuredContext: context.profile.trainingContext ? { value: context.profile.trainingContext, source } : null,
        candidate: { id: candidate.id, minutes: candidate.plan.duration.maxMinutes, source,
          items: candidate.plan.items.map(item => ({ id: item.id, exerciseId: item.registeredDomain.exerciseId,
            variantId: item.registeredDomain.variantId, prescriptionKey: sourcePrescriptionKey(item),
            equipment: [...state.metadataEquipment], contexts: 'any', purposes: [], demands: [] })) },
        purposes: { required: [], preferred: [] }, locks: [], preferences: [], baseline: null };
    },
  };
  const source = createFallbackFirstPlanSource(ports);
  const wrapped = { ...source, async capture(actor: AccountContext, context: PlanningContext) {
    try { const result = await source.capture(actor, context); state.afterCapture(); return result; }
    finally { state.capturing = false; }
  } };
  const binding = { writer, afterPlanWriteWithinWrite(actor: AccountContext) {
    writer.assertWithinWrite(actor); state.afterWrites++; state.afterWrite();
  } };
  const prepare = createOperationalSourceFirstPlanPreparation(domain, wrapped, writer);
  const host = createFirstPlanHost(domain, prepare, binding);
  const context = (): PlanningContext => {
    const profile = domain.document<Profile>(f.one.accountId, 'profile');
    const preferences = domain.document<Preferences>(f.one.accountId, 'preferences');
    return { accountId: f.one.accountId, profile: { revision: profile.revision, goals: profile.goals,
      trainingBackground: profile.trainingBackground, injuryHistory: profile.injuryHistory,
      ...(profile.trainingContext === undefined ? {} : { trainingContext: profile.trainingContext }) },
      preferences: { revision: preferences.revision, equipment: preferences.equipment,
        sessionMinutes: preferences.sessionMinutes, trainingDaysPerWeek: preferences.trainingDaysPerWeek } };
  };
  const count = (table: string) => (f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  const noWrites = () => {
    for (const table of ['plans', 'plan_revisions', 'plan_item_ids', 'command_receipts']) assert.equal(count(table), 0, table);
  };
  return { ...f, domain, writer, state, ports, source, wrapped, binding, prepare, host, context, confirmation, count, noWrites };
}

test('B01/B05/B09/B10/B11: real composer saves only fallback@1, bounded provenance and one durable replay', async t => {
  const f = fixture(t), result = await f.host.create(f.one, f.confirmation, 'first');
  const stored = f.db.prepare('SELECT status,result FROM command_receipts').get() as { status: number; result: string };
  assert.equal(stored.status, 201); assert.deepEqual(JSON.parse(stored.result), result);
  assert.equal(result.provenance.selectedCandidateId, 'form-strength-fallback-v1');
  assert.equal(result.provenance.candidates.length, 1);
  assert.ok(result.provenance.sources.some(value => value.id === FALLBACK_POLICY.id && value.revision === '1'));
  assert.ok(result.provenance.sources.some(value => value.id === pin.id && value.revision === pin.revision));
  assert.ok(Buffer.byteLength(JSON.stringify(result.provenance)) <= 64 * 1024);
  assert.ok('schema' in result.plan); if (!('schema' in result.plan)) throw new Error('Expected source plan');
  assert.equal(result.plan.items.length, 4); assert.ok(result.plan.items.length <= 50);
  assert.deepEqual(result.plan.origin, { kind: 'form-adaptation', id: FALLBACK_POLICY.id, revision: '1' });
  assert.deepEqual(result.plan.items.map(item => item.native), FALLBACK_POLICY.recipe);
  assert.equal(Object.hasOwn(result.plan.items[3]!.native, 'rep_range'), false);
  assert.equal(Object.hasOwn(result.plan.items[3]!.native, 'target_rir'), false);
  assert.ok(result.plan.items.every(item => item.load.kind === 'unspecified' && item.load.basis === 'unknown'));
  assert.deepEqual(f.domain.plan(f.one.accountId, result.plan.id), result.plan);
  assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1); assert.equal(f.count('plan_item_ids'), 4);
  assert.equal(f.state.afterWrites, 1); assert.equal(f.state.captures, 1); assert.ok(f.state.reads > 0);
  const reads = f.state.reads; f.state.metadataAvailable = false; f.state.witnesses = null;
  assert.deepEqual(await f.host.create(f.one, f.confirmation, 'first'), result);
  assert.equal(f.state.captures, 1); assert.equal(f.state.reads, reads); assert.equal(f.state.afterWrites, 1);
  assert.equal(f.count('plans'), 1); assert.equal(f.count('command_receipts'), 1);
});

test('B02: either confirmed revision changing after capture returns stale 409 without plan writes', async t => {
  for (const kind of ['profile', 'preferences'] as const) {
    const f = fixture(t);
    f.state.afterCapture = () => kind === 'profile'
      ? void f.domain.patchDocument<Profile>(f.one.accountId, kind, { expectedRevision: 0, injuryHistory: 'Synthetic correction' })
      : void f.domain.patchDocument<Preferences>(f.one.accountId, kind, { expectedRevision: f.confirmation.preferencesRevision, sessionMinutes: 30 });
    await assert.rejects(f.host.create(f.one, f.confirmation, kind), code(409, 'first_plan_confirmation_stale')); f.noWrites();
  }
});

test('B03/B08: postwrite capture/R1/consent/metadata/registration/row revocation rolls back all plan effects', async t => {
  for (const kind of ['capture', 'r1', 'consent', 'metadata', 'metadata-drift', 'bytes', 'legacy-bytes', 'pins', 'row', 'row-data'] as const) {
    const f = fixture(t);
    const item = registration.entries.find(value => value.sourceIdentity.nativeId === FALLBACK_POLICY.recipe[0]!.exercise_id)!;
    const beforeRow = f.db.prepare('SELECT data,retired FROM exercises WHERE id=?').get(item.exerciseId);
    const trigger = catalogTrigger(f.db); assertCatalogImmutable(f.db, item.exerciseId);
    f.state.afterWrite = () => {
      assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1); assert.equal(f.count('plan_item_ids'), 4);
      assert.equal(f.count('command_receipts'), 0); assert.ok(f.state.witnesses);
      if (kind === 'capture') f.state.witnesses = { ...f.state.witnesses, capture: null };
      if (kind === 'r1') f.state.witnesses = { ...f.state.witnesses, r1: null };
      if (kind === 'consent') f.state.witnesses = { ...f.state.witnesses, questions: { ...questions,
        consent: { ...questions.consent, revision: 'revoked' } } };
      if (kind === 'metadata') f.state.metadataAvailable = false;
      if (kind === 'metadata-drift') f.state.metadataRevision = 'changed';
      if (kind === 'bytes') f.state.registration.input.registrationBytes[0] = 0;
      if (kind === 'legacy-bytes') f.state.registration.input.legacyBytes[0] = 0;
      if (kind === 'pins') f.state.registration.acceptedPins = [];
      if (kind === 'row') f.db.prepare('UPDATE exercises SET retired=1 WHERE id=?').run(item.exerciseId);
      if (kind === 'row-data') driftCatalogRowData(f.db, item.exerciseId, '{}');
    };
    await assert.rejects(f.host.create(f.one, f.confirmation, kind), code(409, 'first_plan_sources_changed'));
    assert.equal(f.state.afterWrites, 1); f.noWrites();
    assert.deepEqual(f.db.prepare('SELECT data,retired FROM exercises WHERE id=?').get(item.exerciseId), beforeRow);
    assert.equal(catalogTrigger(f.db), trigger); assertCatalogImmutable(f.db, item.exerciseId);
  }
});

test('B04: equipment/time/bindings/metadata gaps return null and existing unavailable 503', async t => {
  for (const kind of ['equipment', 'time', 'binding', 'metadata'] as const) {
    const f = fixture(t);
    if (kind === 'equipment') f.domain.patchDocument<Preferences>(f.one.accountId, 'preferences',
      { expectedRevision: f.confirmation.preferencesRevision, equipment: ['bodyweight', 'wall'] });
    if (kind === 'time') f.domain.patchDocument<Preferences>(f.one.accountId, 'preferences',
      { expectedRevision: f.confirmation.preferencesRevision, sessionMinutes: 24 });
    if (kind === 'binding') f.state.registration.acceptedPins = [];
    if (kind === 'metadata') f.state.metadataAvailable = false;
    const context = f.context(); assert.equal(await f.wrapped.capture(f.one, context), null);
    await assert.rejects(f.host.create(f.one, { profileRevision: context.profile.revision,
      preferencesRevision: context.preferences.revision }, kind), code(503, 'first_plan_preparation_unavailable')); f.noWrites();
  }
});

test('B04/B12: unknown/clinical constraint decisions stay blocked 422; excluded receipt stays infeasible 422', async t => {
  for (const kind of ['unknown', 'clinical', 'infeasible'] as const) {
    const f = fixture(t);
    if (kind === 'infeasible') f.state.metadataEquipment = ['synthetic-unavailable-equipment'];
    else {
      const capture = f.ports.captureHost;
      f.ports.captureHost = (actor, context) => {
        const host = capture(actor, context); assert.ok(f.state.witnesses?.r1);
        const r1 = f.state.witnesses.r1;
        f.state.witnesses = { ...f.state.witnesses, r1: { ...r1, snapshot: { ...r1.snapshot,
          preflight: { ...r1.snapshot.preflight, ...(kind === 'clinical' ? { trainingState: 'clinical_review' as const } : { complete: false }) } } } };
        return host;
      };
    }
    // Create after configuring the trusted port; replacing an already bound port must deny.
    const source = createFallbackFirstPlanSource(f.ports);
    const wrapped = { ...source, async capture(actor: AccountContext, context: PlanningContext) {
      try { return await source.capture(actor, context); } finally { f.state.capturing = false; }
    } };
    const host = createFirstPlanHost(f.domain, createOperationalSourceFirstPlanPreparation(f.domain, wrapped, f.writer), f.binding);
    await assert.rejects(host.create(f.one, f.confirmation, kind), error => {
      assert.ok(error instanceof DomainError); assert.equal(error.status, 422);
      assert.equal(error.code, kind === 'infeasible' ? 'first_plan_infeasible' : 'first_plan_blocked');
      assert.ok(error.details && typeof error.details === 'object' && 'gapCodes' in error.details);
      if (kind !== 'infeasible') assert.deepEqual(error.details.gapCodes, ['constraint_receipt_unavailable']);
      return true;
    }); f.noWrites();
  }
});

test('B10: composer rejects capture within a transaction and a foreign writer cannot reuse prepared handles', async t => {
  const f = fixture(t);
  let pending!: ReturnType<typeof f.prepare>;
  f.db.transaction(() => { pending = f.prepare(f.one, f.context()); }).immediate();
  await assert.rejects(pending, code(503, 'first_plan_capture_transaction_forbidden'));
  assert.equal(f.state.captures, 0);
  const prepared = await f.prepare(f.one, f.context());
  assert.throws(prepared.assertCurrent);
  const other = createCanonicalAccountWriter(f.db);
  assert.throws(() => other.lifecycle.withActiveWrite(f.one, prepared.assertCurrent));
  f.noWrites();
});

test('B03/B06: concurrent same-session packets retain their own original host handles', async t => {
  const f = fixture(t), original = f.ports.captureHost;
  let captures = 0, firstActive = true;
  const source = createFallbackFirstPlanSource({ ...f.ports, captureHost(actor, context) {
    const host = original(actor, context), first = ++captures === 1;
    return { ...host, assertActive() {
      if (first && !firstActive) throw new Error('Original capture revoked');
      host.assertActive();
    } };
  } });
  const wrapped = { ...source, async capture(actor: AccountContext, context: PlanningContext) {
    try { return await source.capture(actor, context); } finally { f.state.capturing = false; }
  } };
  const prepare = createOperationalSourceFirstPlanPreparation(f.domain, wrapped, f.writer);
  const first = await prepare(f.one, f.context()), second = await prepare({ ...f.one }, f.context());
  firstActive = false;
  assert.throws(() => f.writer.lifecycle.withActiveWrite(f.one, first.assertCurrent), code(409, 'first_plan_sources_changed'));
  f.writer.lifecycle.withActiveWrite(f.one, second.assertCurrent); f.noWrites();
});

test('B06: foreign capture scope, actor, session, revision and suppression deny without writes', async t => {
  for (const change of [{ accountId: 'foreign' }, { sessionId: 'foreign' }, { profileRevision: 99 },
    { preferencesRevision: 99 }, { contextKey: 'foreign' }]) {
    const f = fixture(t); f.state.pinChange = change;
    await assert.rejects(f.host.create(f.one, f.confirmation, 'foreign-pin'), code(503, 'first_plan_preparation_unavailable')); f.noWrites();
  }
  const f = fixture(t), context = f.context(), packet = await f.wrapped.capture(f.one, context); assert.ok(packet);
  f.writer.lifecycle.withActiveWrite(f.one, () => {
    assert.equal(f.source.readCurrent(f.two, context), null);
    assert.equal(f.source.readCurrent({ ...f.one, sessionId: 'foreign' }, context), null);
    assert.equal(f.source.readCurrent({ ...f.one, epoch: 1 }, context), null);
    assert.equal(f.source.readCurrent(f.one, { ...context, profile: { ...context.profile, revision: 99 } }), null);
    assert.ok(f.source.readCurrent(f.one, context));
  }); f.noWrites();
  f.state.afterCapture = () => {
    f.db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=epoch+1,disabled_at_ms=1,suppression_seq=1 WHERE account_id=?")
      .run(f.one.accountId);
  };
  await assert.rejects(f.host.create(f.one, f.confirmation, 'suppression'), code(403, 'account_disabled')); f.noWrites();
});

test('B07: asynchronous currentness ports and write hook consume rejections and deny atomically', async t => {
  for (const kind of ['witness', 'active', 'registration', 'metadata', 'hook'] as const) {
    const f = fixture(t);
    f.state.afterCapture = () => {
      const rejection = () => Promise.reject(new Error(`Synthetic async ${kind}`));
      if (kind === 'witness') Object.defineProperty(f.state, 'witnessRead', { value: rejection });
      if (kind === 'active') Object.defineProperty(f.state, 'activeRead', { value: rejection });
      if (kind === 'registration') Object.defineProperty(f.state, 'registration', { get: rejection });
      if (kind === 'metadata') Object.defineProperty(f.state, 'metadataRead', { value: rejection });
    };
    if (kind === 'hook') Object.defineProperty(f.binding, 'afterPlanWriteWithinWrite', {
      value: () => Promise.reject(new Error('Synthetic async hook')) });
    const host = kind === 'hook' ? createFirstPlanHost(f.domain, f.prepare, f.binding) : f.host;
    await assert.rejects(host.create(f.one, f.confirmation, kind),
      code(kind === 'hook' ? 503 : 409, kind === 'hook' ? 'synchronous_first_plan_write_hook_required' : 'first_plan_sources_changed'));
    await new Promise<void>(resolveDone => setImmediate(resolveDone)); f.noWrites();
  }
});

test('B08/B09/B12: detached packets retain exact recipe; missing original R1 never acquires authority', async t => {
  const f = fixture(t), context = f.context(), packet = await f.wrapped.capture(f.one, context); assert.ok(packet);
  assert.equal(packet.candidates.length, 1); assert.deepEqual(packet.candidates[0]!.candidate.plan.items.map(item => item.native), FALLBACK_POLICY.recipe);
  assert.throws(() => { packet.candidates[0]!.candidate.plan.items[0]!.native.sets = 999; }, TypeError);
  packet.registration.input.registrationBytes![0] = 0;
  f.writer.lifecycle.withActiveWrite(f.one, () => {
    const current = f.source.readCurrent(f.one, context); assert.ok(current);
    assert.equal(current.registration.input.registrationBytes![0], registrationBytes[0]);
    assert.ok(f.state.witnesses); f.state.witnesses = { ...f.state.witnesses, r1: null };
    assert.equal(f.source.readCurrent(f.one, context), null);
  }); f.noWrites();
  const g = fixture(t), original = g.ports.captureHost;
  g.ports.captureHost = (actor, context) => {
    const host = original(actor, context); assert.ok(g.state.witnesses);
    g.state.witnesses = { ...g.state.witnesses, r1: null }; return host;
  };
  const noAuthority = createFallbackFirstPlanSource(g.ports);
  assert.equal(await noAuthority.capture(g.one, g.context()), null); g.noWrites();
});
