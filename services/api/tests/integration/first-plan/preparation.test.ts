import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogSeed } from '../../../src/catalog.js';
import { createNativeMovementCatalogFromRetained, RETAINED_CATALOG_INPUTS,
  type NativeDomainRegistrationV1, type RegisteredNativeExercise } from '../../../src/catalog-qualification/index.js';
import { Domain } from '../../../src/domain.js';
import { DomainError } from '../../../src/errors.js';
import { createFirstPlanHost } from '../../../src/integration/first-plan/index.js';
import { createOperationalFirstPlanPreparation, type OperationalFirstPlanPacket,
  type OperationalFirstPlanSource } from '../../../src/integration/first-plan/operational-preparation.js';
import type { ConfirmedConstraintReceipt } from '../../../src/planning/constraints/first-plan-adapter.js';
import { selectFirstPlan, prescriptionKey, type EvaluationInput, type PlanCandidate,
  type PlanningContext, type QualifiedCatalog } from '../../../src/planning/first-plan/index.js';
import type { Preferences, Profile } from '../../../src/schemas.js';
import { canonical, hash } from '../../../src/storage.js';
import { fixture as accountFixture } from '../account-modules/fixture.js';

const legacyBytes = readFileSync(resolve(process.cwd(), '../..', RETAINED_CATALOG_INPUTS.legacy.path));
const variant = createNativeMovementCatalogFromRetained(legacyBytes).variants[0]!;
// Pins, approvals and prescriptions below are synthetic mechanics fixtures, never operational qualification.
const record: RegisteredNativeExercise = { id: 'synthetic_registered_composer', name: variant.name,
  loadLabel: 'Load (unspecified basis)', retired: false, requiredConstraints: [], cues: [],
  provenance: { sourceIdentity: variant.identity, registration: { id: 'synthetic-registration', revision: 'registry-v1' },
    loadBasis: 'unknown', cueStatus: 'withheld' } };
const registration: NativeDomainRegistrationV1 = { schema: 'form.native-domain-registration/v1',
  id: 'synthetic-registration', revision: 'registry-v1', entries: [{ exerciseId: record.id,
    sourceIdentity: variant.identity, recordDigest: hash(canonical(record)), record }] };
const registrationBytes = Buffer.from(JSON.stringify(registration));
const pin = { id: registration.id, revision: registration.revision, bytes: registrationBytes.byteLength,
  digest: createHash('sha256').update(registrationBytes).digest('hex') };
const sourceRef = (id: string, revision = 'synthetic-v1') => ({ id, revision, locator: `fixture:${id}`,
  currentness: 'current' as const, qualification: 'qualified' as const });
const confirmation = { profileRevision: 0, preferencesRevision: 0 };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
function candidate(): PlanCandidate {
  return { id: 'synthetic-candidate', qualification: 'qualified', source: sourceRef('synthetic-candidate-source'),
    plan: { name: 'Synthetic composer plan', minutes: 10, items: [
      { id: 'synthetic-item', exerciseId: record.id, setTarget: 2, repMin: 4, repMax: 8, targetKg: 3 },
    ] } };
}
function receipt(context: PlanningContext, value: PlanCandidate, equipment: string[] = []): ConfirmedConstraintReceipt {
  const observations: EvaluationInput[] = [];
  selectFirstPlan({ context, confirmation: { accountId: context.accountId,
    profileRevision: context.profile.revision, preferencesRevision: context.preferences.revision }, candidates: [value] }, {
    qualifyCatalog(input) { observations.push(input); return { contextKey: input.contextKey, candidateKey: input.candidateKey,
      status: 'unknown', reasons: [{ code: 'synthetic_capture_only' }] }; },
  });
  const input = observations[0]; assert.ok(input);
  const catalog: QualifiedCatalog = { contextKey: input.contextKey, candidateKey: input.candidateKey,
    status: 'qualified', source: sourceRef('synthetic-catalog-approval', 'qualification-v7'),
    items: value.plan.items.map(item => ({ itemId: item.id, exerciseId: item.exerciseId, variantId: variant.variantId,
      prescriptionKey: prescriptionKey(item), retired: false, source: sourceRef('synthetic-dose-approval') })) };
  const binding = { context: input.contextKey, catalog: catalog.source.revision,
    rules: 'synthetic-rules-v1', preflight: 'synthetic-preflight-v1' };
  const source = sourceRef('synthetic-independent-constraint-approval');
  return { scope: 'form.confirmed-constraint-snapshot/v1', contextKey: input.contextKey, candidateKey: input.candidateKey,
    accountId: context.accountId, profileRevision: context.profile.revision, preferencesRevision: context.preferences.revision,
    source, candidateSource: value.source, catalog, structuredContext: null,
    candidate: { id: value.id, minutes: value.plan.minutes, source, items: value.plan.items.map(item => ({ id: item.id,
      exerciseId: item.exerciseId, variantId: variant.variantId, prescriptionKey: prescriptionKey(item),
      equipment, contexts: 'any', purposes: [], demands: [] })) },
    snapshot: { binding, current: { ...binding }, preflight: { complete: true, trainingState: 'self_directed',
      source: sourceRef('synthetic-preflight-approval'), regions: [],
      restrictionCoverage: { complete: true, ruleIds: [], instructions: [] } }, facts: [], requiredFactIds: [], rules: [],
      purposes: { required: [], preferred: [] }, locks: [], preferences: [], baseline: null } };
}
function packet(context: PlanningContext, value = candidate(), equipment: string[] = []): OperationalFirstPlanPacket {
  return { registration: { acceptedPins: [pin], input: { legacyBytes: new Uint8Array(legacyBytes),
    registrationBytes: new Uint8Array(registrationBytes) } }, candidates: [{ candidate: value, receipt: receipt(context, value, equipment) }] };
}
type MutableSource = { -readonly [K in keyof OperationalFirstPlanSource]: OperationalFirstPlanSource[K] };
type Fixture = ReturnType<typeof accountFixture> & { domain: Domain; source: MutableSource;
  state: { packet: OperationalFirstPlanPacket | null; captures: number; reads: number };
  host: ReturnType<typeof createFirstPlanHost>; count: (table: 'plans' | 'plan_revisions' | 'plan_item_ids' | 'command_receipts') => number };
function fixture(t: TestContext, row: unknown = record): Fixture {
  const f = accountFixture(); t.after(() => { if (f.db.open) f.close(); }); const domain = new Domain(f.db);
  if (row !== null) f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run(record.id, JSON.stringify(row));
  const state: Fixture['state'] = { packet: null, captures: 0, reads: 0 };
  const source: MutableSource = {
    async capture(actor, context) {
      state.captures++; assert.equal(f.db.inTransaction, false); assert.deepEqual(actor, f.one);
      assert.ok(Object.isFrozen(actor)); assert.ok(Object.isFrozen(context.profile));
      state.packet = packet(context); return state.packet;
    },
    readCurrent() { state.reads++; assert.equal(f.db.inTransaction, true); return state.packet; },
  };
  let host: ReturnType<typeof createFirstPlanHost> | undefined;
  return { ...f, domain, state, source,
    get host() { return host ??= createFirstPlanHost(domain, createOperationalFirstPlanPreparation(domain, source)); }, count: table =>
    (f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n };
}
function contextFor(f: Fixture): PlanningContext {
  const profile = f.domain.document<Profile>(f.one.accountId, 'profile');
  const preferences = f.domain.document<Preferences>(f.one.accountId, 'preferences');
  return { accountId: f.one.accountId, profile: { revision: profile.revision, goals: profile.goals,
    trainingBackground: profile.trainingBackground, injuryHistory: profile.injuryHistory,
    ...(profile.trainingContext === undefined ? {} : { trainingContext: profile.trainingContext }) },
    preferences: { revision: preferences.revision, equipment: preferences.equipment,
      sessionMinutes: preferences.sessionMinutes, trainingDaysPerWeek: preferences.trainingDaysPerWeek } };
}
function noWrites(f: Fixture): void {
  for (const table of ['plans', 'plan_revisions', 'plan_item_ids', 'command_receipts'] as const) assert.equal(f.count(table), 0);
}
function captureWith(f: Fixture, transform: (value: OperationalFirstPlanPacket) => OperationalFirstPlanPacket): void {
  f.source.capture = async (_actor, context) => { f.state.captures++; f.state.packet = transform(packet(context)); return f.state.packet; };
}

test('real composer, registered identity, selector and constraints persist exact synthetic prescription and minimized receipt', async t => {
  const f = fixture(t);
  f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, trainingContext: 'PRIVATE-CONTEXT' });
  const result = await f.host.create(f.one, { ...confirmation, profileRevision: 1 }, 'positive');
  assert.deepEqual(result.plan.items, candidate().plan.items); assert.equal(f.state.captures, 1); assert.equal(f.state.reads, 3);
  assert.notEqual(pin.revision, f.state.packet!.candidates[0]!.receipt!.catalog.source.revision);
  const durable = (f.db.prepare('SELECT result FROM command_receipts').get() as { result: string }).result;
  assert.deepEqual(JSON.parse(durable), result);
  for (const privateField of ['PRIVATE-CONTEXT', 'locator', 'snapshot', 'demands', 'sourceIdentity', 'registrationBytes'])
    assert.equal(durable.includes(privateField), false);
  assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1); assert.equal(f.count('plan_item_ids'), 1);
});

test('missing capture, missing registration authority and Open Mat IDs never acquire invented operational qualification', async t => {
  for (const kind of ['capture', 'pins', 'bytes', 'empty', 'openmat'] as const) {
    const f = fixture(t);
    if (kind === 'capture') f.source.capture = async () => null;
    else if (kind === 'openmat') f.source.capture = async (_actor, context) => {
      const openMat = catalogSeed[0]!;
      f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run(openMat.id, JSON.stringify(openMat));
      const value = candidate(); value.plan.items[0]!.exerciseId = catalogSeed[0]!.id;
      return f.state.packet = packet(context, value);
    };
    else captureWith(f, value => {
      if (kind === 'pins') return { ...value, registration: { ...value.registration, acceptedPins: [] } };
      if (kind === 'bytes') return { ...value, registration: { ...value.registration,
        input: { ...value.registration.input, registrationBytes: null } } };
      if (kind === 'empty') {
        const bytes = Buffer.from(JSON.stringify({ ...registration, entries: [] }));
        return { ...value, registration: { acceptedPins: [{ ...pin, bytes: bytes.byteLength,
          digest: createHash('sha256').update(bytes).digest('hex') }], input: { legacyBytes, registrationBytes: bytes } } };
      }
      return value;
    });
    await assert.rejects(f.host.create(f.one, confirmation, kind), code(kind === 'capture' ? 'first_plan_preparation_unavailable' : 'first_plan_blocked'));
    noWrites(f);
  }
});

test('actual canonical rows must match every registered field and remain active', async t => {
  for (const kind of ['malformed', 'foreign', 'extra', 'embedded', 'missing', 'retired'] as const) {
    const row = kind === 'malformed' ? [] : kind === 'foreign' ? { ...record, name: 'Foreign name' } :
      kind === 'extra' ? { ...record, unregistered: true } : kind === 'embedded' ? { ...record, id: 'other-id' } :
      kind === 'missing' ? null : record;
    const f = fixture(t, row);
    if (kind === 'retired') f.db.prepare('UPDATE exercises SET retired=1 WHERE id=?').run(record.id);
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_blocked')); noWrites(f);
  }
});

test('missing receipt, changed dose and foreign receipt account stay blocked', async t => {
  for (const kind of ['receipt', 'dose', 'account'] as const) {
    const f = fixture(t);
    captureWith(f, value => { const entry = value.candidates[0]!;
      if (kind === 'dose') { entry.candidate.plan.items[0]!.targetKg++; return value; }
      return { ...value, candidates: [{ ...entry, receipt: kind === 'receipt' ? null : { ...entry.receipt!, accountId: f.two.accountId } }] };
    });
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_blocked')); noWrites(f);
  }
});

test('qualified time and equipment exclusions preserve infeasible outcome without changing the prescription', async t => {
  for (const kind of ['time', 'equipment'] as const) {
    const f = fixture(t);
    f.source.capture = async (_actor, context) => {
      const value = candidate(); if (kind === 'time') value.plan.minutes = context.preferences.sessionMinutes + 1;
      return f.state.packet = packet(context, value, kind === 'equipment' ? ['synthetic-unavailable-equipment'] : []);
    };
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_infeasible')); noWrites(f);
  }
});

test('original session, epoch and full context are checked after awaited capture including error settlement', async t => {
  for (const kind of ['session', 'epoch', 'context', 'error'] as const) {
    const f = fixture(t); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.source.capture = async (_actor, context) => { await gate; if (kind === 'error') throw Error('PRIVATE'); return packet(context); };
    const pending = f.host.create(f.one, confirmation, kind);
    if (kind === 'context') f.db.prepare("UPDATE documents SET data=json_set(data,'$.trainingContext','same-revision-change') WHERE account_id=? AND kind='profile'").run(f.one.accountId);
    else if (kind === 'epoch') f.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(f.one.accountId);
    else f.db.prepare('DELETE FROM session WHERE id=?').run(f.one.sessionId);
    release();
    await assert.rejects(pending, code(kind === 'context' ? 'first_plan_preparation_unavailable' : kind === 'epoch' ? 'account_epoch_changed' : 'account_session_invalid'));
    noWrites(f);
  }
});

test('source values and bytes cannot change behind unchanged revision labels', async t => {
  for (const kind of ['receipt', 'bytes', 'candidate'] as const) {
    const f = fixture(t);
    f.source.readCurrent = () => {
      const value = structuredClone(f.state.packet!);
      if (kind === 'bytes') value.registration.input.legacyBytes[0] = 0;
      else if (kind === 'candidate') value.candidates[0]!.candidate.plan.items[0]!.targetKg++;
      else value.candidates[0]!.receipt!.catalog.source.qualification = 'changed same-revision qualification';
      return value;
    };
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_sources_changed')); noWrites(f);
  }
});

test('thenable currentness and original actor revocation during the synchronous source check fail closed', async t => {
  for (const kind of ['thenable', 'session', 'context'] as const) {
    const f = fixture(t);
    f.source.readCurrent = () => {
      if (kind === 'thenable') return { then() { assert.fail('thenable must never be invoked'); } } as unknown as OperationalFirstPlanPacket;
      if (kind === 'session') f.db.prepare('DELETE FROM session WHERE id=?').run(f.one.sessionId);
      else f.db.prepare("UPDATE documents SET data=json_set(data,'$.trainingContext','changed') WHERE account_id=? AND kind='profile'").run(f.one.accountId);
      return f.state.packet;
    };
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_sources_changed')); noWrites(f);
  }
});

test('retirement at the final post-insert check rolls back plan, item, revision, receipt and retirement together', async t => {
  const f = fixture(t); let reads = 0;
  f.source.readCurrent = () => { if (++reads === 3) {
    assert.equal(f.count('plans'), 1); f.db.prepare('UPDATE exercises SET retired=1 WHERE id=?').run(record.id);
  } return f.state.packet; };
  await assert.rejects(f.host.create(f.one, confirmation, 'retire'), code('first_plan_sources_changed'));
  assert.equal(reads, 3); noWrites(f);
  assert.equal((f.db.prepare('SELECT retired FROM exercises WHERE id=?').get(record.id) as { retired: number }).retired, 0);
});

test('exact authorized replay bypasses acquisition and currentness after context changes, while a lost session cannot replay', async t => {
  const f = fixture(t); const first = await f.host.create(f.one, confirmation, 'replay');
  f.source.capture = async () => { assert.fail('replay must not acquire'); };
  f.source.readCurrent = () => { assert.fail('replay must not evaluate sources'); };
  f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, trainingContext: 'changed' });
  assert.deepEqual(await f.host.create(f.one, confirmation, 'replay'), first); assert.equal(f.count('plans'), 1);
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.one.sessionId);
  await assert.rejects(f.host.create(f.one, confirmation, 'replay'), code('account_session_invalid'));
});

test('candidate order and detached packet bytes survive later mutation of the relinquished capture object', async t => {
  const f = fixture(t); let current: OperationalFirstPlanPacket | null = null;
  f.source.capture = async (_actor, context) => {
    const excluded = candidate(); excluded.id = 'synthetic-excluded'; excluded.plan.minutes = context.preferences.sessionMinutes + 1;
    const eligible = candidate();
    f.state.packet = { ...packet(context), candidates: [
      { candidate: excluded, receipt: receipt(context, excluded) }, { candidate: eligible, receipt: receipt(context, eligible) },
    ] };
    current = structuredClone(f.state.packet); return f.state.packet;
  };
  f.source.readCurrent = () => {
    f.state.packet!.registration.input.legacyBytes[0] = 0;
    f.state.packet!.candidates[1]!.candidate.plan.items[0]!.targetKg = 99;
    f.state.packet!.candidates[1]!.receipt!.catalog.source.qualification = 'relinquished-object-mutation';
    return current;
  };
  const result = await f.host.create(f.one, confirmation, 'ordered');
  assert.deepEqual(result.plan.items, candidate().plan.items);
  assert.deepEqual(result.provenance.candidates.map(value => [value.id, value.status]), [
    ['synthetic-excluded', 'excluded'], ['synthetic-candidate', 'eligible'],
  ]);
});

test('unbounded candidate packets and unauthenticated retained bytes cannot reach persistence', async t => {
  for (const kind of ['count', 'bytes'] as const) {
    const f = fixture(t);
    captureWith(f, value => {
      if (kind === 'count') return { ...value, candidates: Array.from({ length: 65 }, () => value.candidates[0]!) };
      value.registration.input.legacyBytes[0] = 0; return value;
    });
    await assert.rejects(f.host.create(f.one, confirmation, kind), code('first_plan_preparation_unavailable')); noWrites(f);
  }
});

test('original source methods cannot be replaced before capture, across its await or at the post-insert check', async t => {
  for (const method of ['capture', 'readCurrent'] as const) for (const boundary of ['before', 'await', 'final'] as const) {
    const f = fixture(t); let release!: () => void; let reads = 0; let replacementCalls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const replace = () => {
      if (method === 'capture') f.source.capture = async () => { replacementCalls++; return f.state.packet; };
      else f.source.readCurrent = () => { replacementCalls++; return f.state.packet; };
    };
    f.source.capture = async (_actor, context) => {
      if (boundary === 'await') await gate;
      return f.state.packet = packet(context);
    };
    f.source.readCurrent = () => {
      if (++reads === 3 && boundary === 'final') { assert.equal(f.count('plans'), 1); replace(); }
      return f.state.packet;
    };
    const host = f.host;
    if (boundary === 'before') replace();
    const pending = host.create(f.one, confirmation, `${method}-${boundary}`);
    if (boundary === 'await') { replace(); release(); }
    await assert.rejects(pending, code(boundary === 'final' ? 'first_plan_sources_changed' : 'first_plan_preparation_unavailable'));
    assert.equal(replacementCalls, 0); if (boundary === 'final') assert.equal(reads, 3); noWrites(f);
  }
});

test('replacing Domain.db fails before acquisition, after capture and after insertion without using the foreign database', async t => {
  for (const boundary of ['before', 'await', 'final'] as const) {
    const f = fixture(t), other = fixture(t); const context = contextFor(f);
    let release!: () => void; let acquisitions = 0; let reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.source.capture = async (_actor, captured) => {
      acquisitions++; if (boundary === 'await') await gate;
      return f.state.packet = packet(captured);
    };
    f.source.readCurrent = () => {
      if (++reads === 3) { assert.equal(f.count('plans'), 1); Object.defineProperty(f.domain, 'db', { value: other.db }); }
      return f.state.packet;
    };
    const prepare = createOperationalFirstPlanPreparation(f.domain, f.source);
    try {
      if (boundary === 'before') Object.defineProperty(f.domain, 'db', { value: other.db });
      const pending = boundary === 'final' ? f.host.create(f.one, confirmation, 'foreign-db') : prepare(f.one, context);
      if (boundary === 'await') { Object.defineProperty(f.domain, 'db', { value: other.db }); release(); }
      await assert.rejects(pending, code('first_plan_sources_changed'));
      assert.equal(acquisitions, boundary === 'before' ? 0 : 1);
      if (boundary === 'final') assert.equal(reads, 3);
      noWrites(f); noWrites(other);
    } finally { Object.defineProperty(f.domain, 'db', { value: f.db }); }
  }
});

test('closed original databases fail before any acquisition or subsequent prepared read', async t => {
  for (const boundary of ['before', 'await', 'prepared'] as const) {
    const f = fixture(t), context = contextFor(f); let acquisitions = 0;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.source.capture = async (_actor, captured) => {
      acquisitions++; if (boundary === 'await') await gate;
      return f.state.packet = packet(captured);
    };
    const prepare = createOperationalFirstPlanPreparation(f.domain, f.source);
    if (boundary === 'prepared') {
      const prepared = await prepare(f.one, context); noWrites(f); f.db.close();
      assert.throws(() => prepared.assertCurrent(), code('first_plan_sources_changed'));
    } else {
      if (boundary === 'before') { noWrites(f); f.db.close(); }
      const pending = prepare(f.one, context);
      if (boundary === 'await') { noWrites(f); f.db.close(); release(); }
      await assert.rejects(pending, code('first_plan_sources_changed'));
    }
    assert.equal(acquisitions, boundary === 'before' ? 0 : 1); assert.equal(f.db.open, false);
  }
});

test('captured source functions retain their original receiver through capture and every currentness check', async t => {
  const f = fixture(t); let reads = 0;
  f.source.capture = async function (_actor, context) {
    assert.equal(this, f.source); return f.state.packet = packet(context);
  };
  f.source.readCurrent = function () { assert.equal(this, f.source); reads++; return f.state.packet; };
  const result = await f.host.create(f.one, confirmation, 'receiver');
  assert.deepEqual(result.plan.items, candidate().plan.items); assert.equal(reads, 3);
});
