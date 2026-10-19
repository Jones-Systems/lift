import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RETAINED_CATALOG_INPUTS, createNativeMovementCatalogFromRetained, projectNativeEquipmentRequirements,
  type NativeDomainRegistrationV1, type RegistrationPin } from '../../../src/catalog-qualification/index.js';
import { Domain } from '../../../src/domain.js';
import { DomainError } from '../../../src/errors.js';
import { createCanonicalAccountWriter } from '../../../src/integration/account-modules/canonical-writer.js';
import { sourceProgressComparisonMigration, sourceFeedbackMigration } from '../../../src/integration/account-modules/migrations.js';
import { createFirstPlanHost } from '../../../src/integration/first-plan/index.js';
import { createOperationalSourceFirstPlanPreparation, type OperationalSourceFirstPlanPacket,
  type OperationalSourceFirstPlanSource } from '../../../src/integration/first-plan/source-operational-preparation.js';
import type { AccountContext } from '../../../src/lifecycle/types.js';
import type { ConfirmedConstraintReceipt } from '../../../src/planning/constraints/first-plan-adapter.js';
import type { GroupedEquipmentRequirements } from '../../../src/planning/constraints/index.js';
import { normalizeSourceFirstPlanInput, sourcePrescriptionKey, type SourcePlanCandidate,
  type PlanningContext, type QualifiedCatalog, type SourceEvaluationInput } from '../../../src/planning/first-plan/index.js';
import type { Preferences, Profile } from '../../../src/schemas.js';
import { sourcePrescriptionMigration } from '../../../src/source-prescription-migration.js';
import { canonical, hash } from '../../../src/storage.js';
import { fixture as accountFixture } from '../account-modules/fixture.js';

const root = resolve(process.cwd(), '../..');
const legacyBytes = readFileSync(resolve(root, RETAINED_CATALOG_INPUTS.legacy.path));
const registrationBytes = readFileSync(resolve(root, 'docs/knowledge/catalog-cues/registrations/native-engine-v1.candidate.json'));
const registration = JSON.parse(registrationBytes.toString('utf8')) as NativeDomainRegistrationV1;
const native = createNativeMovementCatalogFromRetained(legacyBytes);
const pin: RegistrationPin = { id: 'form-native-engine-registration-candidate',
  revision: '442c5cd07f14142326af10fe0eb6d079b0e62a71-v1',
  digest: 'c326ccbba03fcc1fe5807d20811e7cd57b87be4c2ebf0361e922028e7bb131ed', bytes: 77470 };
// Retained records are authentic; accepting their pin, installed rows, prescriptions and R1 receipts is synthetic test authority only.
const sourceRef = (id: string) => ({ id, revision: 'synthetic-v1', locator: `fixture:${id}`,
  currentness: 'current' as const, qualification: 'qualified' as const });
const confirmation = { profileRevision: 0, preferencesRevision: 0 };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
function candidate(): SourcePlanCandidate {
  return { id: 'synthetic-source-candidate', qualification: 'qualified', source: sourceRef('synthetic-recipe'),
    plan: { schema: 'form.source-prescription-plan/v1', name: 'Synthetic source composer',
      origin: { kind: 'form-adaptation', id: 'synthetic-origin', revision: 'synthetic-v1' },
      duration: { kind: 'estimated-range', minMinutes: 10, maxMinutes: 20 },
      items: registration.entries.slice(0, 4).map((entry, index) => ({ id: `source-item-${index}`,
        native: { exercise_id: entry.sourceIdentity.nativeId, movement_pattern: ' source pattern ', role: 'source role',
          sets: 2, rest_seconds: 60, ...(index < 3 ? { rep_range: [5, 9] as [number, number] } : {}),
          ...(index === 0 ? { target_rir: 0, substituted_for: 'original-native', notes: [' second ', '', 'first', ' second '] } : {}) },
        registeredDomain: { exerciseId: entry.exerciseId, variantId: native.get(entry.sourceIdentity.nativeId)!.variantId,
          identity: structuredClone(entry.sourceIdentity), registration: { ...pin }, recordDigest: entry.recordDigest },
        load: { kind: 'unspecified', basis: 'unknown' } })),
    } };
}
function normalize(context: PlanningContext, value: SourcePlanCandidate) {
  const result = normalizeSourceFirstPlanInput({ context, candidate: value, confirmation: { accountId: context.accountId,
    profileRevision: context.profile.revision, preferencesRevision: context.preferences.revision } });
  assert.equal(result.status, 'valid');
  if (result.status !== 'valid') throw new Error('Invalid synthetic source candidate');
  return result.input;
}
function receipt(context: PlanningContext, value: SourcePlanCandidate): ConfirmedConstraintReceipt {
  const input = normalize(context, value);
  const catalog: QualifiedCatalog = { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified',
    source: sourceRef('synthetic-catalog'), items: value.plan.items.map(item => ({ itemId: item.id,
      exerciseId: item.registeredDomain.exerciseId, variantId: item.registeredDomain.variantId,
      prescriptionKey: sourcePrescriptionKey(item), retired: false, source: sourceRef('synthetic-dose') })) };
  const binding = { context: input.contextKey, catalog: catalog.source.revision, rules: 'synthetic-rules', preflight: 'synthetic-preflight' };
  const source = sourceRef('synthetic-independent-constraint');
  return { scope: 'form.confirmed-constraint-snapshot/v1', contextKey: input.contextKey, candidateKey: input.candidateKey,
    accountId: context.accountId, profileRevision: context.profile.revision, preferencesRevision: context.preferences.revision,
    source, candidateSource: value.source, catalog, structuredContext: null,
    candidate: { id: value.id, minutes: input.comparisonMinutes, source, items: value.plan.items.map(item => ({ id: item.id,
      exerciseId: item.registeredDomain.exerciseId, variantId: item.registeredDomain.variantId,
      prescriptionKey: sourcePrescriptionKey(item), equipment: [], contexts: 'any', purposes: [], demands: [] })) },
    snapshot: { binding, current: { ...binding }, preflight: { complete: true, trainingState: 'self_directed',
      source: sourceRef('synthetic-preflight-approval'), regions: [], restrictionCoverage: { complete: true, ruleIds: [], instructions: [] } },
      facts: [], requiredFactIds: [], rules: [], purposes: { required: [], preferred: [] }, locks: [], preferences: [], baseline: null } };
}
function packet(actor: AccountContext, context: PlanningContext, value = candidate()): OperationalSourceFirstPlanPacket {
  return { capture: { id: 'synthetic-confirmed-capture', revision: 'synthetic-v1', digest: 'a'.repeat(64),
    accountId: actor.accountId, sessionId: actor.sessionId, contextKey: normalize(context, value).contextKey,
    profileRevision: context.profile.revision, preferencesRevision: context.preferences.revision },
    registration: { acceptedPins: [pin], input: { legacyBytes: new Uint8Array(legacyBytes), registrationBytes: new Uint8Array(registrationBytes) } },
    candidates: [{ candidate: value, receipt: receipt(context, value) }] };
}
type MutableSource = { -readonly [K in keyof OperationalSourceFirstPlanSource]: OperationalSourceFirstPlanSource[K] };
function fixture(t: TestContext, firstRow: unknown = registration.entries[0]!.record) {
  const f = accountFixture(); t.after(() => { if (f.db.open) f.close(); });
  for (const migration of [sourceProgressComparisonMigration, sourceFeedbackMigration, sourcePrescriptionMigration]) {
    f.db.exec(migration.sql);
    f.db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
  }
  assert.equal(registration.entries.length, 58); assert.equal(registrationBytes.length, pin.bytes);
  assert.equal(createHash('sha256').update(registrationBytes).digest('hex'), pin.digest);
  for (const [index, entry] of registration.entries.entries()) {
    if (index === 0 && firstRow === null) continue;
    f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run(entry.exerciseId, canonical(index === 0 ? firstRow : entry.record));
  }
  const domain = new Domain(f.db, { sourcePrescription: 'selected-migration-19' }), writer = createCanonicalAccountWriter(f.db);
  const state = { packet: null as OperationalSourceFirstPlanPacket | null, captures: 0, reads: 0, afterWrites: 0, r1Current: true };
  const source: MutableSource = {
    async capture(actor, context) {
      state.captures++; assert.equal(f.db.inTransaction, false); assert.deepEqual(actor, f.one);
      assert.ok(Object.isFrozen(actor)); assert.ok(Object.isFrozen(context.profile));
      return state.packet = packet(actor, context);
    },
    readCurrent(actor, context) {
      state.reads++; writer.assertWithinWrite(actor); assert.equal(context.accountId, f.one.accountId);
      return state.r1Current ? state.packet : null;
    },
  };
  const binding = { writer, afterPlanWriteWithinWrite(actor: AccountContext) { writer.assertWithinWrite(actor); state.afterWrites++; } };
  let host: ReturnType<typeof createFirstPlanHost> | undefined;
  return { ...f, domain, writer, state, source, binding,
    get host() { return host ??= createFirstPlanHost(domain, createOperationalSourceFirstPlanPreparation(domain, source, writer), binding); },
    count: (table: 'plans' | 'plan_revisions' | 'plan_item_ids' | 'command_receipts') =>
      (f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n };
}
type Fixture = ReturnType<typeof fixture>;
function contextFor(f: Fixture): PlanningContext {
  const profile = f.domain.document<Profile>(f.one.accountId, 'profile'), preferences = f.domain.document<Preferences>(f.one.accountId, 'preferences');
  return { accountId: f.one.accountId, profile: { revision: profile.revision, goals: profile.goals,
    trainingBackground: profile.trainingBackground, injuryHistory: profile.injuryHistory,
    ...(profile.trainingContext === undefined ? {} : { trainingContext: profile.trainingContext }) },
    preferences: { revision: preferences.revision, equipment: preferences.equipment,
      sessionMinutes: preferences.sessionMinutes, trainingDaysPerWeek: preferences.trainingDaysPerWeek } };
}
function noWrites(f: Fixture) {
  for (const table of ['plans', 'plan_revisions', 'plan_item_ids', 'command_receipts'] as const) assert.equal(f.count(table), 0);
}
function captureWith(f: Fixture, transform: (value: OperationalSourceFirstPlanPacket) => OperationalSourceFirstPlanPacket | null) {
  f.source.capture = async (actor, context) => { f.state.captures++; return f.state.packet = transform(packet(actor, context)); };
}

type Mutable<T> = T extends readonly (infer Member)[] ? Mutable<Member>[] :
  T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
type GroupedNativeId = 'farmer-carry' | 'one-arm-dumbbell-row';
function groupedCandidate(nativeId: GroupedNativeId): SourcePlanCandidate {
  const entry = registration.entries.find(value => value.sourceIdentity.nativeId === nativeId);
  assert.ok(entry, 'Grouped fixtures require an existing authentic registration');
  const value = candidate();
  value.plan.items = [{ id: 'source-grouped-item',
    native: { exercise_id: nativeId, movement_pattern: 'synthetic-pattern', role: 'synthetic-role', sets: 2, rest_seconds: 60 },
    registeredDomain: { exerciseId: entry.exerciseId, variantId: native.get(nativeId)!.variantId,
      identity: structuredClone(entry.sourceIdentity), registration: { ...pin }, recordDigest: entry.recordDigest },
    load: { kind: 'unspecified', basis: 'unknown' } }];
  return value;
}
function groupedPacket(actor: AccountContext, context: PlanningContext, nativeId: GroupedNativeId): OperationalSourceFirstPlanPacket {
  const value = packet(actor, context, groupedCandidate(nativeId)), entry = value.candidates[0]!, original = entry.receipt!;
  const projected = projectNativeEquipmentRequirements(native, nativeId)!;
  assert.equal(projected.operationalSource, null);
  assert.deepEqual(projected.native.identity, entry.candidate.plan.items[0]!.registeredDomain.identity);
  // Exact equipment identity is authentic; this separate receipt SourceRef supplies synthetic operational acceptance and R1 only.
  const equipment = { ...structuredClone(projected), operationalSource: structuredClone(original.source) };
  assert.notEqual(equipment.operationalSource, original.source);
  assert.notDeepEqual(original.source, entry.candidate.source);
  return { ...value, candidates: [{ ...entry, receipt: { ...original, candidate: { ...original.candidate,
    items: original.candidate.items.map(item => ({ ...item, equipment })) } } }] };
}
function groupedFixture(t: TestContext, nativeId: GroupedNativeId = 'farmer-carry', available = ['dumbbell']) {
  const f = fixture(t);
  const preferences = f.domain.patchDocument<Preferences>(f.one.accountId, 'preferences', { expectedRevision: 0, equipment: available });
  assert.deepEqual(preferences.equipment, available);
  f.source.capture = async (actor, context) => { f.state.captures++; return f.state.packet = groupedPacket(actor, context, nativeId); };
  return { f, confirmed: { profileRevision: 0, preferencesRevision: preferences.revision } };
}
function packetEquipment(value: OperationalSourceFirstPlanPacket): Mutable<GroupedEquipmentRequirements> {
  const equipment = value.candidates[0]!.receipt!.candidate.items[0]!.equipment;
  assert.ok(equipment !== null && !Array.isArray(equipment));
  return equipment as Mutable<GroupedEquipmentRequirements>;
}
function storedPlans(f: Fixture) {
  return Object.fromEntries(['plans', 'plan_revisions', 'plan_item_ids', 'command_receipts'].map(table =>
    [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('composed authentic carry alternatives and registered rowing requirements preserve canonical saves and durable receipts', async t => {
  const cases: { nativeId: GroupedNativeId; available: string[]; saved: boolean }[] = [
    ...[['dumbbell'], ['kettlebell'], ['dumbbell', 'kettlebell'], []].map(available =>
      ({ nativeId: 'farmer-carry' as const, available, saved: available.length > 0 })),
    ...[['dumbbell', 'bench'], ['dumbbell'], ['bench'], []].map(available =>
      ({ nativeId: 'one-arm-dumbbell-row' as const, available, saved: available.length === 2 })),
  ];
  for (const [index, { nativeId, available, saved }] of cases.entries()) {
    const { f, confirmed } = groupedFixture(t, nativeId, available), before = storedPlans(f);
    if (!saved) {
      await assert.rejects(f.host.create(f.one, confirmed, `grouped-${index}`), code('first_plan_infeasible'));
      assert.deepEqual(storedPlans(f), before); noWrites(f); continue;
    }
    const result = await f.host.create(f.one, confirmed, `grouped-${index}`), expected = groupedCandidate(nativeId).plan;
    assert.deepEqual(result.plan, { ...expected, id: result.plan.id, revision: 1, archived: false,
      createdAt: result.plan.createdAt, updatedAt: result.plan.updatedAt });
    assert.deepEqual(f.domain.plan(f.one.accountId, result.plan.id), result.plan);
    assert.deepEqual(f.domain.planRevision(f.one.accountId, result.plan.id, 1), { ...expected, id: result.plan.id, revision: 1, archived: false });
    assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1); assert.equal(f.count('plan_item_ids'), 1);
    assert.equal(f.count('command_receipts'), 1); assert.equal(f.state.afterWrites, 1);
    const retained = packetEquipment(f.state.packet!);
    assert.deepEqual(retained.required, nativeId === 'farmer-carry' ? [] : ['dumbbell', 'bench']);
    assert.deepEqual(retained.alternatives, nativeId === 'farmer-carry' ? [['dumbbell', 'kettlebell']] : []);
    const record = f.db.prepare('SELECT result FROM command_receipts').get() as { result: string };
    assert.deepEqual(JSON.parse(record.result), result);
    const captures = f.state.captures, reads = f.state.reads, persisted = storedPlans(f);
    assert.deepEqual(await f.host.create(f.one, confirmed, `grouped-${index}`), result);
    assert.equal(f.state.captures, captures); assert.equal(f.state.reads, reads); assert.deepEqual(storedPlans(f), persisted);
  }
});

test('composed grouped acceptance requires an exact independent operational SourceRef and matching native tuple', async t => {
  const cases: { name: string; change(value: Mutable<GroupedEquipmentRequirements>): void }[] = [
    { name: 'null', change: value => { value.operationalSource = null; } },
    ...(['id', 'revision', 'locator'] as const).map(field => ({ name: `source-${field}`,
      change: (value: Mutable<GroupedEquipmentRequirements>) => { value.operationalSource![field] += '-foreign'; } })),
    ...(['unknown', 'withdrawn', 'superseded'] as const).map(currentness => ({ name: currentness,
      change: (value: Mutable<GroupedEquipmentRequirements>) => { value.operationalSource!.currentness = currentness; } })),
    ...(['unreviewed', 'hypothesis', 'creator_assertion', 'accepted_instruction'] as const).map(qualification => ({ name: qualification,
      change: (value: Mutable<GroupedEquipmentRequirements>) => { value.operationalSource!.qualification = qualification; } })),
    { name: 'native-identity', change: value => { value.native.identity.path += '-foreign'; } },
    { name: 'native-variant', change: value => { value.native.identity.nativeId = 'one-arm-dumbbell-row';
      value.native.variantId = `movement-engine:${value.native.identity.revision}:one-arm-dumbbell-row`; } },
  ];
  for (const { name, change } of cases) {
    const { f, confirmed } = groupedFixture(t), capture = f.source.capture, before = storedPlans(f);
    f.source.capture = async (actor, context) => { const value = (await capture(actor, context))!; change(packetEquipment(value)); return value; };
    await assert.rejects(f.host.create(f.one, confirmed, `grouped-blocked-${name}`), code('first_plan_blocked'));
    assert.deepEqual(storedPlans(f), before); noWrites(f);
    assert.equal(f.state.afterWrites, 0);
  }
});

test('nested grouped and attestation drift without revision relabeling rejects selection and rolls back postwrite state', async t => {
  for (const phase of ['selection', 'postwrite'] as const) for (const target of ['member', 'required', 'attestation'] as const) {
    const { f, confirmed } = groupedFixture(t), before = storedPlans(f);
    const drift = (value: OperationalSourceFirstPlanPacket) => {
      const equipment = packetEquipment(value);
      if (target === 'member') equipment.alternatives[0]![0] = 'synthetic-drifted-member';
      if (target === 'required') equipment.required.push('synthetic-drifted-required');
      if (target === 'attestation') equipment.operationalSource!.qualification = 'unreviewed';
    };
    let changed = false;
    if (phase === 'selection') f.source.readCurrent = actor => {
      f.writer.assertWithinWrite(actor); f.state.reads++;
      const value = structuredClone(f.state.packet!); drift(value); changed = true; return value;
    };
    else f.binding.afterPlanWriteWithinWrite = actor => {
      f.writer.assertWithinWrite(actor); f.state.afterWrites++;
      assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1); assert.equal(f.count('plan_item_ids'), 1);
      assert.equal(f.count('command_receipts'), 0);
      drift(f.state.packet!); changed = true;
    };
    await assert.rejects(f.host.create(f.one, confirmed, `grouped-drift-${phase}-${target}`), code('first_plan_sources_changed'));
    assert.equal(changed, true); assert.equal(f.state.afterWrites, phase === 'selection' ? 0 : 1);
    assert.deepEqual(storedPlans(f), before); noWrites(f);
    assert.equal(f.state.packet!.capture.revision, 'synthetic-v1');
    assert.equal(f.state.packet!.candidates[0]!.receipt!.source.revision, 'synthetic-v1');
    assert.equal(f.domain.document<Preferences>(f.one.accountId, 'preferences').revision, confirmed.preferencesRevision);
  }
});

test('exact grouped receipt replay needs an active actor but no recapture or evaluation after source and context revocation', async t => {
  const { f, confirmed } = groupedFixture(t), calls = { preparation: 0, catalog: 0, evaluation: 0 };
  const prepare = createOperationalSourceFirstPlanPreparation(f.domain, f.source, f.writer);
  const host = createFirstPlanHost(f.domain, async (actor, context) => {
    calls.preparation++; const prepared = await prepare(actor, context);
    return { ...prepared, ports: {
      qualifyCatalog(input: SourceEvaluationInput) { calls.catalog++; return prepared.ports.qualifyCatalog!(input); },
      evaluateConstraints(input: SourceEvaluationInput, catalog: QualifiedCatalog) {
        calls.evaluation++; return prepared.ports.evaluateConstraints!(input, catalog);
      },
    } };
  }, f.binding);
  const result = await host.create(f.one, confirmed, 'grouped-revoked-replay'), before = storedPlans(f), observed = { ...calls };
  assert.equal(calls.preparation, 1); assert.equal(calls.catalog, 1); assert.equal(calls.evaluation, 1);
  f.state.r1Current = false;
  f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, injuryHistory: 'Synthetic revoked context' });
  const equipment = packetEquipment(f.state.packet!); equipment.operationalSource!.currentness = 'withdrawn';
  const captures = f.state.captures, reads = f.state.reads;
  assert.deepEqual(await host.create(f.one, confirmed, 'grouped-revoked-replay'), result);
  const reopened = createFirstPlanHost(new Domain(f.db));
  assert.deepEqual(await reopened.create(f.one, confirmed, 'grouped-revoked-replay'), result);
  await assert.rejects(host.create(f.one, { ...confirmed, profileRevision: 1 }, 'grouped-revoked-replay'), code('idempotency_mismatch'));
  f.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(Date.now() - 1, f.one.sessionId);
  await assert.rejects(host.create(f.one, confirmed, 'grouped-revoked-replay'));
  await assert.rejects(reopened.create(f.one, confirmed, 'grouped-revoked-replay'));
  assert.deepEqual(calls, observed); assert.equal(f.state.captures, captures); assert.equal(f.state.reads, reads);
  assert.deepEqual(storedPlans(f), before);
});

test('direct composed packet boundary rejects grouped accessors without invoking their getters', async t => {
  for (const target of ['equipment', 'required', 'member', 'identity', 'operational-source'] as const) await t.test(target, async t => {
    const { f, confirmed } = groupedFixture(t), capture = f.source.capture, before = storedPlans(f);
    let getterReads = 0;
    f.source.capture = async (actor, context) => {
      const value = (await capture(actor, context))!, metadata = value.candidates[0]!.receipt!.candidate.items[0]!;
      const equipment = packetEquipment(value);
      const [object, key] = target === 'equipment' ? [metadata, 'equipment'] : target === 'required' ? [equipment, 'required'] :
        target === 'member' ? [equipment.alternatives[0]!, '0'] : target === 'identity' ? [equipment.native.identity, 'sha256'] :
          [equipment.operationalSource!, 'id'];
      Object.defineProperty(object, key, { enumerable: true, configurable: true,
        get() { getterReads++; throw new Error('Synthetic grouped getter must not execute'); } });
      return value;
    };
    await assert.rejects(f.host.create(f.one, confirmed, `grouped-getter-${target}`), code('first_plan_preparation_unavailable'));
    assert.deepEqual(storedPlans(f), before); noWrites(f);
    assert.equal(getterReads, 0, `Composed packet inspection invoked the ${target} getter`);
  });
});

type EquipmentAccessorTarget = 'equipment' | 'required' | 'member' | 'identity' | 'operational-source';
const equipmentAccessorTargets: readonly EquipmentAccessorTarget[] = ['equipment', 'required', 'member', 'identity', 'operational-source'];
function addGroupedAccessor(value: OperationalSourceFirstPlanPacket, location: 'candidate' | 'baseline', target: EquipmentAccessorTarget) {
  const receipt = value.candidates[0]!.receipt! as Mutable<ConfirmedConstraintReceipt>;
  if (location === 'baseline') receipt.snapshot.baseline = { ...structuredClone(receipt.candidate), id: 'synthetic-grouped-baseline' };
  const metadata = (location === 'baseline' ? receipt.snapshot.baseline! : receipt.candidate).items[0]!;
  const equipment = metadata.equipment as Mutable<GroupedEquipmentRequirements>;
  const [object, key] = target === 'equipment' ? [metadata, 'equipment'] : target === 'required' ? [equipment, 'required'] :
    target === 'member' ? [equipment.alternatives[0]!, '0'] : target === 'identity' ? [equipment.native.identity, 'sha256'] :
      [equipment.operationalSource!, 'id'];
  let reads = 0;
  Object.defineProperty(object, key, { enumerable: true, configurable: true,
    get() { reads++; throw new Error('Synthetic equipment accessor must not execute'); } });
  return () => reads;
}

test('composed initial baseline equipment is checked before cloning and malformed data maps to preparation unavailable', async t => {
  for (const target of equipmentAccessorTargets) await t.test(target, async t => {
    const { f, confirmed } = groupedFixture(t), capture = f.source.capture, before = storedPlans(f);
    let reads = () => 0;
    f.source.capture = async (actor, context) => {
      const value = (await capture(actor, context))!; reads = addGroupedAccessor(value, 'baseline', target); return value;
    };
    await assert.rejects(f.host.create(f.one, confirmed, `baseline-getter-${target}`), code('first_plan_preparation_unavailable'));
    assert.equal(reads(), 0); assert.deepEqual(storedPlans(f), before); noWrites(f); assert.equal(f.state.afterWrites, 0);
  });
  await t.test('malformed-baseline-direct-preparation', async t => {
    const { f } = groupedFixture(t), capture = f.source.capture;
    f.source.capture = async (actor, context) => {
      const value = (await capture(actor, context))!;
      (value.candidates[0]!.receipt! as Mutable<ConfirmedConstraintReceipt>).snapshot.baseline = {} as Mutable<ConfirmedConstraintReceipt>['candidate'];
      return value;
    };
    const prepare = createOperationalSourceFirstPlanPreparation(f.domain, f.source, f.writer);
    await assert.rejects(prepare(f.one, contextFor(f)), code('first_plan_preparation_unavailable')); noWrites(f);
  });
  await t.test('valid-grouped-baseline', async t => {
    const { f, confirmed } = groupedFixture(t), capture = f.source.capture;
    f.source.capture = async (actor, context) => {
      const value = (await capture(actor, context))!, receipt = value.candidates[0]!.receipt! as Mutable<ConfirmedConstraintReceipt>;
      receipt.snapshot.baseline = { ...structuredClone(receipt.candidate), id: 'synthetic-grouped-baseline' }; return value;
    };
    const result = await f.host.create(f.one, confirmed, 'baseline-valid');
    assert.deepEqual(f.domain.plan(f.one.accountId, result.plan.id), result.plan);
    assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1); assert.equal(f.count('plan_item_ids'), 1);
    assert.equal(f.count('command_receipts'), 1); assert.equal(f.state.afterWrites, 1);
  });
});

test('current packet candidate and baseline accessors reject before selection or roll back the completed plan write', async t => {
  for (const phase of ['selection', 'postwrite'] as const) for (const location of ['candidate', 'baseline'] as const) {
    for (const target of equipmentAccessorTargets) await t.test(`${phase}-${location}-${target}`, async t => {
      const { f, confirmed } = groupedFixture(t), before = storedPlans(f);
      let poisoned = phase === 'selection', checked = false, reads = () => 0;
      f.source.readCurrent = actor => {
        f.writer.assertWithinWrite(actor); f.state.reads++;
        if (!poisoned) return f.state.packet;
        const value = structuredClone(f.state.packet!); reads = addGroupedAccessor(value, location, target); checked = true; return value;
      };
      if (phase === 'postwrite') f.binding.afterPlanWriteWithinWrite = actor => {
        f.writer.assertWithinWrite(actor); f.state.afterWrites++;
        assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1); assert.equal(f.count('plan_item_ids'), 1);
        assert.equal(f.count('command_receipts'), 0); poisoned = true;
      };
      await assert.rejects(f.host.create(f.one, confirmed, `current-getter-${phase}-${location}-${target}`), code('first_plan_sources_changed'));
      assert.equal(checked, true); assert.equal(reads(), 0); assert.deepEqual(storedPlans(f), before); noWrites(f);
      assert.equal(f.state.afterWrites, phase === 'selection' ? 0 : 1);
      assert.equal(f.state.packet!.capture.revision, 'synthetic-v1');
      assert.equal(f.state.packet!.candidates[0]!.receipt!.source.revision, 'synthetic-v1');
    });
  }
});

test('actual source composer saves complete native fields using synthetic authority and authentic 58-record registration', async t => {
  const f = fixture(t), result = await f.host.create(f.one, confirmation, 'source-positive');
  assert.deepEqual(result.plan, { ...candidate().plan, id: result.plan.id, revision: 1, archived: false,
    createdAt: result.plan.createdAt, updatedAt: result.plan.updatedAt });
  assert.deepEqual(f.domain.plan(f.one.accountId, result.plan.id), result.plan);
  assert.deepEqual(f.domain.planRevision(f.one.accountId, result.plan.id, 1), { ...candidate().plan, id: result.plan.id, revision: 1, archived: false });
  assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1); assert.equal(f.count('plan_item_ids'), 4);
  assert.equal(f.state.captures, 1); assert.equal(f.state.afterWrites, 1);
  assert.equal('schema' in result.plan, true);
  if (!('schema' in result.plan)) throw new Error('Expected source plan');
  assert.deepEqual(result.plan.items[0]!.native.notes, [' second ', '', 'first', ' second ']);
  assert.equal(Object.hasOwn(result.plan.items[3]!.native, 'rep_range'), false);
  assert.equal(Object.hasOwn(result.plan.items[3]!.native, 'target_rir'), false);
  for (const item of result.plan.items) {
    assert.deepEqual(item.load, { kind: 'unspecified', basis: 'unknown' });
    for (const key of ['repMin', 'repMax', 'targetKg', 'seconds']) assert.equal(Object.hasOwn(item, key), false);
  }
  const persisted = (f.db.prepare('SELECT result FROM command_receipts').get() as { result: string }).result;
  assert.deepEqual(JSON.parse(persisted), result);
  for (const field of ['registrationBytes', 'snapshot', 'synthetic-confirmed-capture']) assert.equal(persisted.includes(field), false);
});

test('durable source receipt replay precedes unavailable preparation without a second plan or capture', async t => {
  const f = fixture(t), result = await f.host.create(f.one, confirmation, 'replay');
  f.state.r1Current = false;
  f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, injuryHistory: 'Later context' });
  const reopened = createFirstPlanHost(new Domain(f.db));
  assert.deepEqual(await reopened.create(f.one, confirmation, 'replay'), result);
  assert.deepEqual(await f.host.create(f.one, confirmation, 'replay'), result);
  assert.equal(f.state.captures, 1); assert.equal(f.count('plans'), 1); assert.equal(f.count('command_receipts'), 1);
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.one.sessionId);
  await assert.rejects(reopened.create(f.one, confirmation, 'replay')); assert.equal(f.count('plans'), 1);
});

test('capture, receipt, registration and current R1 are each required; a matching capture pin alone never admits saving', async t => {
  for (const kind of ['capture', 'receipt', 'pins', 'bytes', 'row', 'r1'] as const) {
    const f = fixture(t, kind === 'row' ? null : registration.entries[0]!.record);
    captureWith(f, value => {
      if (kind === 'capture') return null;
      if (kind === 'receipt') return { ...value, candidates: value.candidates.map(entry => ({ ...entry, receipt: null })) };
      if (kind === 'pins') return { ...value, registration: { ...value.registration, acceptedPins: [] } };
      if (kind === 'bytes') return { ...value, registration: { ...value.registration, input: { ...value.registration.input, registrationBytes: null } } };
      return value;
    });
    if (kind === 'row') assert.equal(f.db.prepare('SELECT id FROM exercises WHERE id=?').get(registration.entries[0]!.exerciseId), undefined);
    if (kind === 'r1') f.state.r1Current = false;
    await assert.rejects(f.host.create(f.one, confirmation, kind), code(kind === 'capture' ? 'first_plan_preparation_unavailable' :
      kind === 'r1' ? 'first_plan_sources_changed' : 'first_plan_blocked'));
    noWrites(f);
  }
});

test('capture binds original account, session, context key and both confirmed revisions', async t => {
  for (const change of [{ accountId: 'foreign' }, { sessionId: 'foreign' }, { contextKey: 'foreign' },
    { profileRevision: 1 }, { preferencesRevision: 1 }, { digest: '' }, { id: '' }]) {
    const f = fixture(t); captureWith(f, value => ({ ...value, capture: { ...value.capture, ...change } }));
    await assert.rejects(f.host.create(f.one, confirmation, 'capture-mismatch'), code('first_plan_preparation_unavailable')); noWrites(f);
  }
});

test('all registered source associations are compared with authentic bytes and exact active rows', async t => {
  for (const kind of ['native', 'identity', 'variant', 'digest', 'registration', 'bytes', 'row', 'retired', 'malformed'] as const) {
    const f = fixture(t, kind === 'row' ? { ...registration.entries[0]!.record, extra: true } :
      kind === 'malformed' ? [] : registration.entries[0]!.record);
    f.source.capture = async (actor, context) => {
      const value = candidate(), item = value.plan.items[0]!;
      if (kind === 'native') { item.native.exercise_id = registration.entries[4]!.sourceIdentity.nativeId; item.registeredDomain.identity = structuredClone(registration.entries[4]!.sourceIdentity); }
      if (kind === 'identity') item.registeredDomain.identity.path += '-changed';
      if (kind === 'variant') item.registeredDomain.variantId += '-changed';
      if (kind === 'digest') item.registeredDomain.recordDigest = 'b'.repeat(64);
      if (kind === 'registration') item.registeredDomain.registration.digest = 'b'.repeat(64);
      if (kind === 'bytes') item.registeredDomain.registration.bytes++;
      return f.state.packet = packet(actor, context, value);
    };
    const id = registration.entries[0]!.exerciseId;
    if (kind === 'retired') f.db.prepare('UPDATE exercises SET retired=1 WHERE id=?').run(id);
    if (kind === 'malformed') {
      assert.throws(() => f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run('synthetic-invalid-json', '{'), /CHECK constraint failed/);
      assert.equal(f.db.prepare('SELECT id FROM exercises WHERE id=?').get('synthetic-invalid-json'), undefined);
    }
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_blocked')); noWrites(f);
  }
});

test('actual source constraint evaluator rejects stale receipt keys, candidate dose, context and missing preflight authority', async t => {
  for (const kind of ['keys', 'dose', 'context', 'preflight', 'catalog'] as const) {
    const f = fixture(t); captureWith(f, value => {
      const entry = value.candidates[0]!, original = entry.receipt!;
      if (kind === 'dose') entry.candidate.plan.items[0]!.native.rest_seconds++;
      const changed: ConfirmedConstraintReceipt = kind === 'keys' ? { ...original, candidateKey: 'foreign' } :
        kind === 'context' ? { ...original, accountId: 'foreign' } : kind === 'preflight' ? { ...original, snapshot: { ...original.snapshot,
          preflight: { ...original.snapshot.preflight, complete: false } } } : kind === 'catalog' ? { ...original, catalog: {
            ...original.catalog, items: original.catalog.items.slice(1) } } : original;
      return { ...value, candidates: [{ ...entry, receipt: changed }] };
    });
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_blocked')); noWrites(f);
  }
});

test('actor and both context documents are rechecked after asynchronous capture, including a rejected capture', async t => {
  for (const kind of ['session', 'epoch', 'profile', 'preferences', 'reject'] as const) {
    const f = fixture(t);
    f.source.capture = async (actor, context) => {
      const value = packet(actor, context); await Promise.resolve();
      if (kind === 'session' || kind === 'reject') f.db.prepare('DELETE FROM session WHERE id=?').run(actor.sessionId);
      if (kind === 'epoch') f.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(actor.accountId);
      if (kind === 'profile') f.domain.patchDocument<Profile>(actor.accountId, 'profile', { expectedRevision: 0, trainingContext: 'Changed during capture' });
      if (kind === 'preferences') f.domain.patchDocument<Preferences>(actor.accountId, 'preferences', { expectedRevision: 0, sessionMinutes: 25 });
      if (kind === 'reject') throw new Error('Synthetic capture failure');
      return f.state.packet = value;
    };
    await assert.rejects(f.host.create(f.one, confirmation, kind)); noWrites(f);
  }
});

test('preparation owns detached frozen actor/context and cannot be redirected by caller mutation', async t => {
  const f = fixture(t), actor = { ...f.one }, context = contextFor(f);
  let unblock!: () => void;
  const gate = new Promise<void>(resolveGate => { unblock = resolveGate; });
  f.source.capture = async (original, captured) => {
    await gate; assert.deepEqual(original, f.one); assert.equal(captured.preferences.sessionMinutes, 35);
    return f.state.packet = packet(original, captured);
  };
  const pending = createOperationalSourceFirstPlanPreparation(f.domain, f.source, f.writer)(actor, context);
  actor.accountId = f.two.accountId; actor.sessionId = f.two.sessionId; context.preferences.sessionMinutes = 5;
  unblock(); const prepared = await pending;
  assert.ok(Object.isFrozen(prepared)); assert.ok(Object.isFrozen(prepared.candidates[0]!.plan.items[0]!.native.notes));
  f.writer.lifecycle.withActiveWrite(f.one, prepared.assertCurrent);
  assert.throws(() => f.writer.lifecycle.withActiveWrite(f.two, prepared.assertCurrent), code('canonical_writer_unproved')); noWrites(f);
});

test('final selection requires the exact supplied writer and cannot use a bare or foreign writer transaction', async t => {
  const f = fixture(t), other = fixture(t);
  assert.throws(() => createOperationalSourceFirstPlanPreparation(f.domain, f.source, other.writer), code('first_plan_preparation_unavailable'));
  const prepared = await createOperationalSourceFirstPlanPreparation(f.domain, f.source, f.writer)(f.one, contextFor(f));
  assert.throws(prepared.assertCurrent, code('canonical_writer_unproved'));
  assert.throws(() => f.db.transaction(prepared.assertCurrent).immediate(), code('canonical_writer_unproved'));
  const second = createCanonicalAccountWriter(f.db);
  assert.throws(() => second.lifecycle.withActiveWrite(f.one, prepared.assertCurrent), code('canonical_writer_unproved'));
  const input = normalize(contextFor(f), candidate());
  assert.throws(() => prepared.ports.qualifyCatalog!(input), code('canonical_writer_unproved'));
  await assert.rejects(createFirstPlanHost(f.domain, async () => prepared, { writer: second, afterPlanWriteWithinWrite() {} })
    .create(f.one, confirmation, 'foreign-writer'), code('first_plan_sources_changed')); noWrites(f);
});

test('capture is forbidden inside any transaction and source callback identities cannot be replaced', async t => {
  const f = fixture(t), prepare = createOperationalSourceFirstPlanPreparation(f.domain, f.source, f.writer);
  let captured!: ReturnType<typeof prepare>;
  f.db.transaction(() => {
    assert.equal(f.db.inTransaction, true);
    captured = prepare(f.one, contextFor(f));
  }).immediate();
  await assert.rejects(captured, code('first_plan_capture_transaction_forbidden')); assert.equal(f.state.captures, 0);
  f.source.capture = async () => null;
  await assert.rejects(prepare(f.one, contextFor(f)), code('first_plan_sources_changed'));
  const g = fixture(t), prepared = await createOperationalSourceFirstPlanPreparation(g.domain, g.source, g.writer)(g.one, contextFor(g));
  g.source.readCurrent = () => g.state.packet;
  assert.throws(() => g.writer.lifecycle.withActiveWrite(g.one, prepared.assertCurrent), code('first_plan_sources_changed'));
  noWrites(f); noWrites(g);
});

test('thenable currentness is rejected and its rejection is consumed without admitting a write', async t => {
  const f = fixture(t);
  Object.defineProperty(f.source, 'readCurrent', { value: () => Promise.reject(new Error('Synthetic asynchronous currentness')) });
  await assert.rejects(f.host.create(f.one, confirmation, 'thenable'), code('first_plan_sources_changed'));
  await Promise.resolve(); noWrites(f);
});

test('full packet fingerprints detect capture, receipt, native optionals and retained-byte drift before selection', async t => {
  for (const kind of ['capture', 'receipt', 'notes', 'bytes', 'pin'] as const) {
    const f = fixture(t);
    f.source.readCurrent = () => {
      const value = structuredClone(f.state.packet!);
      if (kind === 'capture') return { ...value, capture: { ...value.capture, revision: 'changed' } };
      if (kind === 'receipt') return { ...value, candidates: value.candidates.map(entry => ({ ...entry, receipt: null })) };
      if (kind === 'notes') value.candidates[0]!.candidate.plan.items[0]!.native.notes!.reverse();
      if (kind === 'bytes') value.registration.input.registrationBytes![0] = 0;
      if (kind === 'pin') return { ...value, registration: { ...value.registration, acceptedPins: [] } };
      return value;
    };
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_sources_changed')); noWrites(f);
  }
});

test('final and postwrite source drift roll back plan, revisions, item IDs and command receipt together', async t => {
  for (const kind of ['r1', 'row', 'context', 'callback', 'capture'] as const) {
    const f = fixture(t);
    f.binding.afterPlanWriteWithinWrite = actor => {
      f.writer.assertWithinWrite(actor); assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1);
      if (kind === 'r1') f.state.r1Current = false;
      if (kind === 'row') f.db.prepare('UPDATE exercises SET retired=1 WHERE id=?').run(registration.entries[0]!.exerciseId);
      if (kind === 'context') f.domain.patchDocument<Profile>(actor.accountId, 'profile', { expectedRevision: 0, injuryHistory: 'Changed within write' });
      if (kind === 'callback') f.source.capture = async () => null;
      if (kind === 'capture') f.state.packet = { ...f.state.packet!, capture: { ...f.state.packet!.capture, digest: 'b'.repeat(64) } };
    };
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_sources_changed')); noWrites(f);
    assert.equal(f.domain.document<Profile>(f.one.accountId, 'profile').revision, 0);
    assert.equal((f.db.prepare('SELECT retired FROM exercises WHERE id=?').get(registration.entries[0]!.exerciseId) as { retired: number }).retired, 0);
  }
});

test('row and original-session changes made by the currentness reader never cross the final write boundary', async t => {
  for (const kind of ['row', 'session', 'profile'] as const) {
    const f = fixture(t);
    f.source.readCurrent = () => {
      if (kind === 'row') f.db.prepare('UPDATE exercises SET data=? WHERE id=?').run('{}', registration.entries[0]!.exerciseId);
      if (kind === 'session') f.db.prepare('DELETE FROM session WHERE id=?').run(f.one.sessionId);
      if (kind === 'profile') f.db.prepare("UPDATE documents SET data=json_set(data,'$.injuryHistory','changed') WHERE account_id=? AND kind='profile'").run(f.one.accountId);
      return f.state.packet;
    };
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_sources_changed')); noWrites(f);
    assert.equal(f.domain.document<Profile>(f.one.accountId, 'profile').injuryHistory, '');
    assert.ok(f.db.prepare('SELECT id FROM session WHERE id=?').get(f.one.sessionId));
  }
});

test('source constraints retain actual duration and equipment exclusions without synthesizing a legacy fallback', async t => {
  for (const kind of ['duration', 'equipment'] as const) {
    const f = fixture(t); captureWith(f, value => {
      if (kind === 'duration') {
        const longer = candidate(); longer.plan.duration.maxMinutes = 60;
        return packet(f.one, contextFor(f), longer);
      }
      const entry = value.candidates[0]!, original = entry.receipt!;
      return { ...value, candidates: [{ ...entry, receipt: { ...original, candidate: { ...original.candidate,
        items: original.candidate.items.map(item => ({ ...item, equipment: ['synthetic-unavailable-machine'] })) } } }] };
    });
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_infeasible')); noWrites(f);
  }
});
