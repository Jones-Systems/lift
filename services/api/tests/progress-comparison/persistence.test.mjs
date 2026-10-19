import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Domain } from '../../src/domain.ts';
import { DomainError } from '../../src/errors.ts';
import { createActivityService } from '../../src/activity/service.ts';
import { activityMigrationSql } from '../../src/activity/migration.ts';
import { runtimeMigrations } from '../../src/runtime-modules/migrations.ts';
import * as sourceMigrations from '../../src/integration/account-modules/migrations.ts';
import { hash, migrations } from '../../src/storage.ts';
import { catalogSeed } from '../../src/catalog.ts';
import { lifecycleMigration } from '../../src/lifecycle/migration.ts';
import { assertActive, withActiveWrite, adultEligibility, bindSuppressionAuthority } from '../../src/lifecycle/guards.ts';
import { createProgressComparisonService } from '../../src/progress-comparison/service.ts';
import { createProgressComparisonLifecycleAdapter } from '../../src/progress-comparison/lifecycle.ts';
import { progressComparisonMigrationSql } from '../../src/progress-comparison/migration.ts';

const identity = { variantId: 'synthetic-row', equipmentId: 'synthetic-dumbbell', laterality: 'left', loadBasis: 'perSide' };
const provenance = { kind: 'user_reported' };
function fixture(t, reportedLoad = false) {
  const db = new Database(':memory:'); t.after(() => db.close()); db.pragma('foreign_keys=ON');
  if (reportedLoad) {
    const selected = sourceMigrations.appendSourceReportedLoadMigration(sourceMigrations.selectAccountModuleMigrations({
      mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' }, runtimeMigrations));
    db.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of selected) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO form_migrations VALUES (?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
    }
  } else {
    for (const migration of migrations) db.exec(migration.sql);
    db.exec(lifecycleMigration.sql); db.exec(progressComparisonMigrationSql);
  }
  const suppressed = new Map(), attestations = new Map();
  bindSuppressionAuthority(db, { currentSequence: () => 0, lookup: account => suppressed.get(account) ?? null,
    reconcileRestore: () => 0, recordDisable: () => { throw Error('not used'); } });
  for (const exercise of catalogSeed) db.prepare('INSERT INTO exercises(id,data,retired) VALUES (?,?,0)').run(exercise.id, JSON.stringify(exercise));
  const domain = new Domain(db, reportedLoad ? { sourcePrescription: 'selected-migration-19', sourceReportedLoad: 'selected-migration-22' } : {}), contexts = {};
  for (const name of ['a', 'b']) {
    const user = `auth-${name}`, login = `login-${name}`;
    db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').run(user, name, `${name}@synthetic.invalid`);
    const accountId = domain.account(user, name);
    db.prepare('INSERT INTO session(id,userId,expiresAt,token,createdAt,updatedAt) VALUES (?,?,4102444800000,?,0,0)').run(login, user, `synthetic-${name}`);
    contexts[name] = { accountId, authUserId: user, sessionId: login, epoch: 0 };
  }
  const deps = { db, domain,
    assertPersistable(context) { assertActive(db, context); },
    assertIdentityAllowed(context, input) {
      assertActive(db, context); assert.equal(input.source.accountId, context.accountId);
      if (input.provenance.kind === 'source_native' && !input.provenance.repo.startsWith('synthetic/')) throw Error('unavailable source');
    },
    comparisonBindingFor(context, record) { assertActive(db, context); assert.equal(db.inTransaction, true); return attestations.get(`${record.id}:${record.revision}`) ?? null; },
    lifecycleControl: {
      assertSuppression(account, epoch) { if (suppressed.get(account)?.epoch !== epoch) throw Error('suppression missing'); },
      purgeReadiness(requestId, account) { return requestId === 'synthetic-purge' && suppressed.has(account)
        ? { status: 'ready', epoch: suppressed.get(account).epoch } : { status: 'unavailable' }; },
    },
  };
  const service = createProgressComparisonService(deps);
  function work(context = contexts.a, reps = 8) {
    const plan = domain.createPlan(context.accountId, { name: 'Synthetic plan', minutes: 30,
      items: [{ id: 'row', exerciseId: 'supported-row', setTarget: 3, repMin: 8, repMax: 12, targetKg: 99 }] });
    const session = domain.startSession(context.accountId, plan.id, plan.revision);
    const set = domain.createSet(context.accountId, session.id, { occurrenceId: session.occurrences[0].id, setNumber: 1, reps,
      weightKg: 10, status: 'confirmed', expectedRevision: session.revision }).set;
    return { selection: { kind: 'session', id: session.id, itemId: session.occurrences[0].id }, setId: set.id };
  }
  function confirm(work, changes = {}, context = contexts.a) {
    const current = domain.session(context.accountId, work.selection.id);
    const prior = service.identity(context, work.selection);
    return service.confirm(context, `confirm-${work.selection.id}-${prior?.revision ?? 0}`, { source: work.selection,
      expectedSourceRevision: current.revision, expectedBindingRevision: prior?.revision ?? 0,
      identity, provenance, confirmed: true, ...changes });
  }
  function attest(work, context = contexts.a) {
    const record = service.identity(context, work.selection);
    // Explicit synthetic qualification registry; storing matching user strings does not populate it.
    attestations.set(`${record.id}:${record.revision}`, { source: record.source, revision: record.revision, confirmed: true, identity: record.data.identity });
  }
  function disable(context = contexts.a) {
    suppressed.set(context.accountId, { accountId: context.accountId, epoch: 1 });
    db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=1,disabled_at_ms=1,suppression_seq=1 WHERE account_id=?").run(context.accountId);
  }
  return { db, domain, contexts, service, deps, work, confirm, attest, disable, attestations };
}
const selection = (a, b) => ({ baseline: a.selection, current: b.selection });
const errorCode = code => error => error?.code === code;

test('real Domain history plus persisted metadata stays unqualified until separate exact attestation', t => {
  const f = fixture(t), a = f.work(), b = f.work(f.contexts.a, 10), chosen = selection(a, b);
  f.confirm(a); f.confirm(b);
  assert.equal(f.service.compare(f.contexts.a, 'context', chosen).result.status, 'unknown');
  assert.ok(f.service.historyPage(f.contexts.a, { limit: 10 }).items.every(row => row.occurrences[0].identityState === 'unqualified'));
  f.attest(a); f.attest(b);
  const current = f.service.compare(f.contexts.a, 'context', chosen);
  assert.equal(current.result.status, 'comparable'); assert.equal(current.result.delta.repetitions, 2);
  assert.ok(current.sourceRefs.some(ref => ref.sourceId.startsWith('progressComparison:')));
  assert.equal(current.bindings[0].current, true);
  const reopened = createProgressComparisonService(f.deps);
  assert.equal(reopened.compare(f.contexts.a, 'context', chosen).evidenceToken, current.evidenceToken);
  const page = reopened.historyPage(f.contexts.a, { limit: 1 }); assert.equal(page.items.length, 1); assert.ok(page.nextBefore);
  assert.equal(reopened.historyPage(f.contexts.a, { limit: 1, before: page.nextBefore }).items.length, 1);
});

test('actual correction/void invalidate source binding and require explicit reconfirmation', t => {
  const f = fixture(t), a = f.work(), b = f.work(), chosen = selection(a, b);
  f.confirm(a); f.confirm(b); f.attest(a); f.attest(b);
  const prior = f.service.compare(f.contexts.a, 'context', chosen);
  f.domain.patchSet(f.contexts.a.accountId, b.selection.id, b.setId, { expectedRevision: 1, reps: 5, weightKg: 10, status: 'confirmed' });
  const stale = f.service.compare(f.contexts.a, 'context', chosen);
  assert.notEqual(stale.evidenceToken, prior.evidenceToken); assert.equal(stale.result.status, 'unknown');
  assert.equal(stale.bindings[1].current, false);
  assert.ok(f.service.historyPage(f.contexts.a, { limit: 10 }).items.some(row => row.occurrences[0].identityState === 'stale'));
  f.confirm(b); assert.equal(f.service.compare(f.contexts.a, 'context', chosen).result.status, 'unknown');
  f.attest(b); assert.equal(f.service.compare(f.contexts.a, 'context', chosen).result.delta.repetitions, -3);
  f.domain.voidSet(f.contexts.a.accountId, b.selection.id, b.setId, 2);
  assert.equal(f.service.compare(f.contexts.a, 'context', chosen).result.status, 'unknown');
  assert.throws(() => f.confirm(b), errorCode('confirmed_progress_work_required'));
});

test('partial axes persist honestly; absent and mismatched trusted qualification fail closed', t => {
  const f = fixture(t), a = f.work(), b = f.work();
  f.confirm(a, { identity: { ...identity, laterality: null } }); f.confirm(b); f.attest(b);
  assert.equal(f.service.identity(f.contexts.a, a.selection).data.identity.laterality, null);
  assert.equal(f.service.compare(f.contexts.a, 'context', selection(a, b)).result.status, 'unknown');
  f.confirm(a); f.attest(a);
  const row = f.service.identity(f.contexts.a, a.selection);
  f.attestations.get(`${row.id}:${row.revision}`).source = { ...row.source, revision: row.source.revision + 1 };
  assert.throws(() => f.service.compare(f.contexts.a, 'context', selection(a, b)), errorCode('progress_qualification_binding_mismatch'));
});

test('account/session/epoch guards protect stored reads, history, writes and fresh consumption', t => {
  const f = fixture(t), a = f.work(); f.confirm(a);
  assert.equal(f.service.identity(f.contexts.b, a.selection), null);
  assert.throws(() => f.confirm(a, {}, f.contexts.b), errorCode('not_found'));
  assert.throws(() => f.service.historyPage({ ...f.contexts.a, sessionId: f.contexts.b.sessionId }, { limit: 10 }), errorCode('account_session_invalid'));
  assert.throws(() => f.service.identity({ ...f.contexts.a, epoch: 1 }, a.selection), errorCode('account_epoch_changed'));
  assert.throws(() => f.service.identity({ ...f.contexts.b, accountId: 'absent-account' }, a.selection), errorCode('account_session_invalid'));
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.contexts.b.sessionId);
  assert.throws(() => f.service.identity(f.contexts.b, a.selection), errorCode('account_session_invalid'));
  f.disable();
  for (const read of [() => f.service.identity(f.contexts.a, a.selection), () => f.service.historyPage(f.contexts.a, { limit: 10 }),
    () => f.service.withFreshComparison(f.contexts.a, 'context', selection(a, a), () => null)]) assert.throws(read, errorCode('account_disabled'));
});

test('source and binding optimistic revisions reject stale corrections; receipts contain no identity payload', t => {
  const f = fixture(t), a = f.work();
  assert.throws(() => f.confirm(a, { expectedSourceRevision: 1 }), errorCode('stale_revision'));
  const result = f.confirm(a); assert.equal(result.status, 201); assert.equal('data' in result.body, false);
  assert.throws(() => f.service.confirm(f.contexts.a, 'new-command', { source: a.selection, expectedSourceRevision: 2,
    expectedBindingRevision: 0, identity, provenance, confirmed: true }), errorCode('stale_revision'));
  const raw = f.db.prepare("SELECT result FROM command_receipts WHERE operation='progressComparison.confirm'").get().result;
  assert.equal(raw.includes('synthetic-dumbbell'), false); assert.equal(raw.includes('variantId'), false);
});

test('withdrawal clears payload and invalidates witness without retaining old identity in revisions', t => {
  const f = fixture(t), a = f.work(), b = f.work(); f.confirm(a); f.confirm(b); f.attest(a); f.attest(b);
  const previous = f.service.compare(f.contexts.a, 'context', selection(a, b));
  f.service.withdraw(f.contexts.a, 'withdraw', { source: b.selection, expectedBindingRevision: 1 });
  const result = f.service.compare(f.contexts.a, 'context', selection(a, b));
  assert.equal(result.result.status, 'unknown'); assert.notEqual(result.evidenceToken, previous.evidenceToken);
  assert.equal(f.service.identity(f.contexts.a, b.selection).data, null);
  const replay = f.service.confirm(f.contexts.a, `confirm-${b.selection.id}-0`, { source: b.selection,
    expectedSourceRevision: 2, expectedBindingRevision: 0, identity, provenance, confirmed: true });
  assert.equal(replay.body.revision, 1);
  assert.equal(f.service.identity(f.contexts.a, b.selection).status, 'withdrawn');
  assert.equal(f.service.compare(f.contexts.a, 'context', selection(a, b)).evidenceToken, result.evidenceToken);
  const history = JSON.stringify(f.db.prepare('SELECT * FROM progress_comparison_identity_revisions').all());
  assert.equal(history.includes('synthetic-dumbbell'), false); assert.equal(history.includes('variantId'), false);
});

test('source-native provenance requires its complete tuple and never promotes to catalog qualification', t => {
  const f = fixture(t), a = f.work(), b = f.work();
  const native = { kind: 'source_native', repo: 'synthetic/native', revision: 'opaque-full-revision-a',
    path: 'fixtures/native-exercises.json', sha256: 'a'.repeat(64), nativeId: 'native-1' };
  const incomplete = { ...native }; delete incomplete.sha256;
  assert.throws(() => f.confirm(a, { provenance: incomplete }), errorCode('invalid_progress_request'));
  assert.throws(() => f.confirm(a, { provenance: { ...native, sha256: 'partial' } }), errorCode('invalid_progress_request'));
  assert.throws(() => f.confirm(a, { provenance: { ...native, kind: 'catalog_qualified' } }), errorCode('invalid_progress_request'));
  f.confirm(a); f.confirm(b, { provenance: native }); f.attest(a); f.attest(b);
  assert.deepEqual(f.service.compare(f.contexts.a, 'context', selection(a, b)).result.reasons, ['identity_provenance_mismatch']);
  f.confirm(a, { provenance: native });
  assert.equal(f.service.compare(f.contexts.a, 'context', selection(a, b)).result.status, 'unknown');
  f.attest(a);
  const matched = f.service.compare(f.contexts.a, 'context', selection(a, b));
  assert.equal(matched.result.status, 'comparable');
  assert.deepEqual(f.service.identity(f.contexts.a, a.selection).data.provenance, native);
  const exported = [];
  createProgressComparisonLifecycleAdapter(f.deps).export(f.contexts.a, { snapshotAtMs: 1, append: (_category, row) => exported.push(row) });
  assert.deepEqual(exported.find(row => row.kind === 'identity' && row.value.source.id === a.selection.id).value.data.provenance, native);
  for (const changed of [{ repo: 'synthetic/other' }, { revision: 'opaque-full-revision-b' },
    { path: 'fixtures/other.json' }, { sha256: 'b'.repeat(64) }, { nativeId: 'native-2' }]) {
    f.confirm(a, { provenance: { ...native, ...changed } }); f.attest(a);
    const mismatch = f.service.compare(f.contexts.a, 'context', selection(a, b));
    assert.equal(mismatch.result.status, 'incomparable');
    assert.deepEqual(mismatch.result.reasons, ['identity_provenance_mismatch']);
    assert.notEqual(mismatch.evidenceToken, matched.evidenceToken);
  }
});

test('fresh witness and consuming SQLite write share the transaction; changed evidence rolls back consumption', t => {
  const f = fixture(t), a = f.work(), b = f.work(); f.confirm(a); f.confirm(b); f.attest(a); f.attest(b);
  f.db.exec('CREATE TABLE synthetic_consumer(id TEXT PRIMARY KEY, token TEXT NOT NULL, status TEXT NOT NULL)');
  const consume = witness => {
    assert.equal(f.db.inTransaction, true); assert.equal(witness.accountId, f.contexts.a.accountId);
    f.db.prepare('INSERT OR REPLACE INTO synthetic_consumer VALUES (?,?,?)').run('later', witness.evidenceToken, witness.result.status === 'comparable' ? 'ready' : 'blocked');
    return witness.evidenceToken;
  };
  const token = f.service.withFreshComparison(f.contexts.a, 'context', selection(a, b), consume);
  assert.equal(f.db.prepare('SELECT token FROM synthetic_consumer').get().token, token);
  f.domain.patchSet(f.contexts.a.accountId, b.selection.id, b.setId, { expectedRevision: 1, reps: 6, weightKg: 10, status: 'confirmed' });
  f.service.withFreshComparison(f.contexts.a, 'context', selection(a, b), consume);
  assert.equal(f.db.prepare('SELECT status FROM synthetic_consumer').get().status, 'blocked');
  assert.throws(() => f.service.withFreshComparison(f.contexts.a, 'context', selection(a, b), witness => {
    consume(witness); f.domain.patchSet(f.contexts.a.accountId, b.selection.id, b.setId, { expectedRevision: 2, reps: 4, weightKg: 10, status: 'confirmed' });
    return null;
  }), errorCode('progress_changed_during_consume'));
  assert.equal(f.domain.set(f.contexts.a.accountId, b.selection.id, b.setId).reps, 6);
  assert.throws(() => f.service.withFreshComparison(f.contexts.a, 'context', { ...selection(a, b), expectedToken: token }, consume), errorCode('invalid_progress_request'));
});

test('lifecycle export is structured; purge requires root proof and clears only its exact receipt namespaces', t => {
  const f = fixture(t), a = f.work(); f.confirm(a);
  const lifecycle = createProgressComparisonLifecycleAdapter(f.deps), exported = [];
  assert.equal(lifecycle.export(f.contexts.a, { snapshotAtMs: 1, append: (category, value) => exported.push({ category, value }) }).status, 'complete');
  assert.equal(JSON.stringify(exported).includes('login-a'), false);
  assert.equal(lifecycle.purge('synthetic-purge', f.contexts.a.accountId).status, 'unavailable');
  assert.equal(f.db.transaction(() => lifecycle.purge('synthetic-purge', f.contexts.a.accountId)).immediate().status, 'unavailable');
  f.db.prepare('INSERT INTO command_receipts(account_id,operation,key,intent_hash,status,result,created_at) VALUES (?,?,?,?,?,?,?)').run(
    f.contexts.a.accountId, 'synthetic.other', 'other', 'hash', 200, '{}', 'synthetic');
  f.disable();
  assert.equal(f.db.transaction(() => lifecycle.suppress(f.contexts.a.accountId, 1)).immediate().status, 'complete');
  assert.equal(f.db.transaction(() => lifecycle.purge('synthetic-purge', f.contexts.a.accountId)).immediate().status, 'complete');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM progress_comparison_identities').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM progress_comparison_identity_revisions').get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM command_receipts WHERE operation IN ('progressComparison.confirm','progressComparison.withdraw')").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM command_receipts WHERE operation='synthetic.other'").get().n, 1);
});

function comparisonInputFixture(t) {
  const f = fixture(t), guards = [];
  const guard = (context, input) => {
    assert.equal(f.db.inTransaction, true); assertActive(f.db, context);
    if (context.accountId !== f.contexts.a.accountId || input.contextId !== 'context') throw new DomainError(403, 'synthetic_context_forbidden');
    for (const scope of [input.baseline, input.current]) assert.equal(scope.source.accountId, context.accountId);
    guards.push(structuredClone(input));
  };
  const deps = { ...f.deps, assertComparisonContextWithinWrite: guard };
  const service = createProgressComparisonService(deps);
  const read = (a, b, chosen = service, contextId = 'context') => withActiveWrite(f.db, f.contexts.a,
    () => chosen.readForDerivationWithinWrite(f.contexts.a, { contextId, ...selection(a, b) }));
  return { ...f, deps, service, guards, read };
}

test('comparison input v2 requires the trusted active writer and synchronous context guard', t => {
  const f = comparisonInputFixture(t), a = f.work(), b = f.work();
  const input = { contextId: 'context', ...selection(a, b) };
  assert.throws(() => f.service.readForDerivationWithinWrite(f.contexts.a, input), errorCode('progress_writer_transaction_required'));
  const { assertComparisonContextWithinWrite, ...legacyDeps } = f.deps;
  const legacy = createProgressComparisonService(legacyDeps);
  assert.equal(legacy.compare(f.contexts.a, 'context', selection(a, b)).result.status, 'unknown');
  assert.throws(() => f.read(a, b, legacy), errorCode('progress_context_guard_required'));
  assert.throws(() => f.read(a, b, f.service, 'unassociated'), errorCode('synthetic_context_forbidden'));
  const asynchronous = createProgressComparisonService({ ...f.deps, assertComparisonContextWithinWrite: () => Promise.resolve() });
  assert.throws(() => f.read(a, b, asynchronous), errorCode('synchronous_progress_boundary_required'));
  assert.throws(() => withActiveWrite(f.db, f.contexts.a, () => f.service.readForDerivationWithinWrite(f.contexts.a,
    { ...input, expectedToken: 'client-value' })), errorCode('invalid_progress_request'));
});

test('comparison input v2 binds actual exercise occurrence and historical plan without identity payload copies', t => {
  const f = comparisonInputFixture(t), a = f.work(), b = f.work();
  f.confirm(a); f.confirm(b); f.attest(a); f.attest(b);
  const result = f.read(a, b), session = f.domain.session(f.contexts.a.accountId, b.selection.id);
  assert.equal(result.status, 'observed'); assert.equal(result.witness.result.status, 'comparable');
  assert.equal(result.witness.witnessVersion, 'progress-comparison-witness-v2');
  const current = result.witness.inputs.current;
  assert.deepEqual(current.scope.exercise, { source: 'global', id: 'supported-row' });
  assert.deepEqual(current.scope.session, { planId: session.planId, planRevision: session.planRevision,
    occurrence: { id: b.selection.itemId, itemId: 'row', exerciseId: 'supported-row' } });
  assert.equal(current.scope.source.accountId, f.contexts.a.accountId);
  assert.equal(current.scope.source.revision, session.revision);
  assert.equal(current.identity.state, 'qualified'); assert.equal(current.identity.current, true);
  assert.deepEqual(Object.keys(current.identity).sort(), ['current', 'id', 'revision', 'state', 'status']);
  assert.equal(JSON.stringify(result.witness.inputs).includes('synthetic-dumbbell'), false);
  assert.equal(JSON.stringify(result.witness.inputs).includes('provenance'), false);
  assert.deepEqual(f.guards.at(-1).current, current.scope);
  f.domain.patchPlan(f.contexts.a.accountId, session.planId, { expectedRevision: 1, name: 'Revised live plan' });
  assert.equal(f.read(a, b).witness.evidenceToken, result.witness.evidenceToken);
  f.domain.patchSet(f.contexts.a.accountId, b.selection.id, b.setId, { expectedRevision: 1, reps: 7, weightKg: 10, status: 'confirmed' });
  const corrected = f.read(a, b).witness;
  assert.notEqual(corrected.evidenceToken, result.witness.evidenceToken);
  assert.equal(corrected.inputs.current.identity.state, 'stale');
  assert.equal(corrected.inputs.current.scope.session.planRevision, 1);
});

test('comparison input v2 preserves observed unknown and incomparable states and minimal binding revisions', t => {
  const f = comparisonInputFixture(t), a = f.work(), b = f.work();
  const initial = f.read(a, b);
  assert.equal(initial.status, 'observed'); assert.equal(initial.witness.result.status, 'unknown');
  assert.equal(initial.witness.inputs.baseline.identity.state, 'missing');
  f.confirm(a); f.confirm(b);
  assert.equal(f.read(a, b).witness.inputs.current.identity.state, 'unqualified');
  f.attest(a); f.attest(b); assert.equal(f.read(a, b).witness.result.status, 'comparable');
  f.confirm(b, { identity: { ...identity, laterality: 'right' } }); f.attest(b);
  assert.equal(f.read(a, b).witness.result.status, 'incomparable');
  f.service.withdraw(f.contexts.a, 'withdraw-v2', { source: b.selection, expectedBindingRevision: 2 });
  const withdrawn = f.read(a, b).witness;
  assert.equal(withdrawn.inputs.current.identity.state, 'withdrawn');
  assert.equal(withdrawn.inputs.current.identity.revision, 3);
  assert.equal(withdrawn.result.status, 'unknown');
});

test('comparison input v2 classifies only missing sources or readers and propagates trusted failures', t => {
  const f = comparisonInputFixture(t), a = f.work(), b = f.work();
  const absent = { selection: { ...a.selection, id: 'missing-session' } };
  assert.deepEqual(f.read(absent, b), { status: 'unavailable', reason: 'source_missing', side: 'baseline' });
  assert.deepEqual(f.read(a, absent), { status: 'unavailable', reason: 'source_missing', side: 'current' });
  const missingItem = { selection: { ...b.selection, itemId: 'missing-occurrence' } };
  assert.deepEqual(f.read(a, missingItem), { status: 'unavailable', reason: 'item_missing', side: 'current' });
  const activity = { selection: { kind: 'activity', id: 'entry', itemId: 'item' } };
  assert.deepEqual(f.read(a, activity), { status: 'unavailable', reason: 'reader_unavailable', side: 'current' });
  f.confirm(a); f.confirm(b);
  const denied = createProgressComparisonService({ ...f.deps, comparisonBindingFor() { throw new DomainError(404, 'not_found'); } });
  assert.throws(() => f.read(a, b, denied), errorCode('not_found'));
  f.db.prepare("UPDATE progress_comparison_identities SET data='{}' WHERE source_id=?").run(a.selection.id);
  assert.throws(() => f.read(a, b), errorCode('progress_identity_corrupt'));
  f.disable(); assert.throws(() => f.read(a, b), errorCode('account_disabled'));
});

test('comparison input v2 detects mutating context callbacks and rolls back the surrounding writer', t => {
  const f = comparisonInputFixture(t), a = f.work(), b = f.work();
  const copied = createProgressComparisonService({ ...f.deps, assertComparisonContextWithinWrite(context, input) {
    f.deps.assertComparisonContextWithinWrite(context, input); input.current.session.planRevision = 900;
  } });
  assert.equal(f.read(a, b, copied).witness.inputs.current.scope.session.planRevision, 1);
  const mutating = createProgressComparisonService({ ...f.deps, assertComparisonContextWithinWrite(context, input) {
    f.deps.assertComparisonContextWithinWrite(context, input);
    f.domain.patchSet(context.accountId, b.selection.id, b.setId, { expectedRevision: 1, reps: 1, weightKg: 10, status: 'confirmed' });
  } });
  assert.throws(() => f.read(a, b, mutating), errorCode('progress_changed_during_context_guard'));
  assert.equal(f.domain.set(f.contexts.a.accountId, b.selection.id, b.setId).reps, 8);
  assert.equal(f.domain.session(f.contexts.a.accountId, b.selection.id).revision, 2);
});

test('comparison input v2 reads actual Activity personal identity without inventing a session or plan', t => {
  const f = comparisonInputFixture(t); f.db.exec(activityMigrationSql);
  const lifecycle = { assertActive: context => assertActive(f.db, context),
    withActiveWrite: (context, effect) => withActiveWrite(f.db, context, effect), adultEligibility: context => adultEligibility(f.db, context) };
  const activity = createActivityService({ db: f.db, lifecycle, lifecycleControl: f.deps.lifecycleControl,
    assertPersistable: context => assertActive(f.db, context), now: () => new Date('2026-10-11T12:00:00Z') });
  activity.createCalendar(f.contexts.a, 'calendar-v2', { timeZone: 'UTC', confirmed: true });
  const exercise = activity.createExercise(f.contexts.a, 'exercise-v2', { name: 'Synthetic personal row', description: '', movement: null,
    measurementType: 'repetitions', kind: 'resistance', loadApplicability: 'unspecified', loadLabel: null }).body;
  const ref = { source: 'personal', id: exercise.id, revision: exercise.revision };
  const entry = activity.createEntry(f.contexts.a, 'entry-v2', {
    date: { localDate: '2026-10-11', timeZone: 'UTC', calendar: 'iso8601', source: 'selected', capturedAt: '2026-10-11T12:00:00Z', referenceLocalDate: '2026-10-11', confirmed: true },
    kind: 'workout', items: [{ id: 'activity-item', exercise: ref, load: { state: 'unknown', confirmed: true } }],
    performedConfirmed: true, source: 'manual', draftId: 'draft-v2', acknowledgedIssues: [],
  }).body;
  const a = f.work(), b = { selection: { kind: 'activity', id: entry.id, itemId: 'activity-item' } };
  const service = createProgressComparisonService({ ...f.deps, activity });
  const result = f.read(a, b, service);
  assert.equal(result.status, 'observed'); assert.equal(result.witness.result.status, 'unknown');
  assert.deepEqual(result.witness.inputs.current.scope.exercise, ref);
  assert.equal(result.witness.inputs.current.scope.session, null);
  assert.equal(result.witness.inputs.current.scope.source.revision, entry.revision);
  assert.deepEqual(f.read(a, { selection: { ...b.selection, itemId: 'missing' } }, service),
    { status: 'unavailable', reason: 'item_missing', side: 'current' });
});

function reportedWork(f, load) {
  const plan = f.domain.createSourcePlan(f.contexts.a.accountId, {
    schema: 'form.source-prescription-plan/v1', name: 'Synthetic reported work',
    origin: { kind: 'form-adaptation', id: 'synthetic', revision: 'v1' },
    duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 },
    items: [{ id: 'row', native: { exercise_id: 'synthetic-row', movement_pattern: 'pull', role: 'practice', sets: 2, rest_seconds: 60, rep_range: [8, 12] },
      registeredDomain: { exerciseId: 'supported-row', variantId: 'synthetic-row',
        identity: { repository: 'synthetic/repository', revision: 'v1', path: 'catalog.json', sha256: 'a'.repeat(64), nativeId: 'synthetic-row' },
        registration: { id: 'synthetic', revision: 'v1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
      load: { kind: 'unspecified', basis: 'unknown' } }],
  });
  const session = f.domain.startSession(f.contexts.a.accountId, plan.id, plan.revision);
  const performance = { schema: 'form.source-performance/v2', kind: 'repetitions', reps: 8, load };
  const set = f.domain.createSet(f.contexts.a.accountId, session.id, { schema: 'form.source-performed-set/v2',
    occurrenceId: session.occurrences[0].id, setNumber: 1, expectedRevision: session.revision, status: 'confirmed', performance }).set;
  return { selection: { kind: 'session', id: session.id, itemId: session.occurrences[0].id }, setId: set.id, performance };
}

test('persisted v2 reported loads survive history and comparison without overwriting their explicit basis', t => {
  const f = fixture(t, true), kg = { state: 'knownValue', value: 10, unit: 'kg', basis: 'perSide' };
  const a = reportedWork(f, kg), b = reportedWork(f, { ...kg, value: 10 / 0.45359237, unit: 'lb' });
  const chosen = selection(a, b);
  f.confirm(a); f.confirm(b);
  assert.deepEqual(f.service.compare(f.contexts.a, 'context', chosen).result.reasons, ['identity_unknown']);
  f.attest(a); f.attest(b);
  const original = f.service.compare(f.contexts.a, 'context', chosen);
  assert.equal(original.result.status, 'comparable'); assert.ok(Math.abs(original.result.delta.volumeKgRepetitions) < 1e-10);
  const reopened = createProgressComparisonService(f.deps);
  assert.equal(reopened.compare(f.contexts.a, 'context', chosen).evidenceToken, original.evidenceToken);
  const history = reopened.historyPage(f.contexts.a, { limit: 10 });
  assert.deepEqual(history.items.find(row => row.id === b.selection.id).occurrences[0].observation.sets[0].load, b.performance.load);
  f.confirm(b, { identity: { ...identity, loadBasis: 'total' } }); f.attest(b);
  assert.deepEqual(f.service.compare(f.contexts.a, 'context', chosen).result.reasons, ['load_basis_mismatch']);
  const performance = { ...b.performance, load: { ...kg, value: 0 } };
  f.domain.patchSet(f.contexts.a.accountId, b.selection.id, b.setId, { schema: 'form.source-performed-set/v2', expectedRevision: 1, status: 'confirmed', performance });
  const stale = f.service.compare(f.contexts.a, 'context', chosen);
  assert.equal(stale.result.status, 'unknown'); assert.notEqual(stale.evidenceToken, original.evidenceToken);
  f.confirm(b); f.attest(b);
  const zero = f.service.compare(f.contexts.a, 'context', chosen);
  assert.equal(zero.result.current.volumeKgRepetitions, 0);
  f.service.withdraw(f.contexts.a, 'withdraw-reported', { source: b.selection, expectedBindingRevision: 3 });
  const withdrawn = f.service.compare(f.contexts.a, 'context', chosen);
  assert.equal(withdrawn.result.status, 'unknown'); assert.notEqual(withdrawn.evidenceToken, zero.evidenceToken);
});
