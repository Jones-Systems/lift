import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createServer, type FormServer } from '../../src/server.js';
import type { AccountContext, LifecycleBindings } from '../../src/lifecycle/types.js';
import { hasRetainedFeedbackWithinWrite } from '../../src/integration/account-modules/index.js';
import { Domain } from '../../src/domain.js';
import { DomainError } from '../../src/errors.js';
import { createCanonicalAccountWriter } from '../../src/integration/account-modules/canonical-writer.js';
import { createPlanRevisionPort } from '../../src/planning/plan-revision-port.js';
import { createWearablePersistence, wearablePersistenceSql } from '../../src/wearables/persistence/index.js';
import { createWearablesService } from '../../src/wearables/service.js';
import type { PlanRevisionPort, Suggestion } from '../../src/wearables/types.js';
import { baseMigrations, install, moduleMigrations, requestConfiguration, suppressionLedger, fixture as accountFixture } from '../integration/account-modules/fixture.js';

function syntheticSourcePlan() {
  return {
    schema: 'form.source-prescription-plan/v1', name: 'Source',
    origin: { kind: 'form-adaptation', id: 'synthetic', revision: 'v1' },
    duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 },
    items: [{ id: 'source-item', native: { exercise_id: 'native', movement_pattern: 'synthetic', role: 'synthetic', sets: 2, rest_seconds: 60 },
      registeredDomain: { exerciseId: 'exercise', variantId: 'synthetic:variant',
        identity: { repository: 'synthetic/repository', revision: 'v1', path: 'catalog.json', sha256: 'a'.repeat(64), nativeId: 'native' },
        registration: { id: 'synthetic', revision: 'v1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
      load: { kind: 'unspecified', basis: 'unknown' } }],
  };
}

function fixture(t: TestContext) {
  const f = accountFixture(); t.after(f.close);
  const domain = new Domain(f.db), writer = createCanonicalAccountWriter(f.db);
  f.db.exec('CREATE TABLE synthetic_plan_invalidations(plan_id TEXT NOT NULL, revision INTEGER NOT NULL)');
  const binding = { afterPlanWriteWithinWrite: (_actor: typeof f.one, plan: { id: string; revision: number }) => {
    f.db.prepare('INSERT INTO synthetic_plan_invalidations VALUES(?,?)').run(plan.id, plan.revision);
  } };
  const port = createPlanRevisionPort(domain, writer, binding);
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
  return { ...f, domain, writer, port, binding, within, before, after, plan, accept, undo, apply, receipts };
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
  const reopenedPort = createPlanRevisionPort(new Domain(f.db), f.writer, f.binding);
  const committed = f.receipts();
  assert.deepEqual(f.within(() => reopenedPort.applyWithinWrite(f.one, f.accept)), { revision: 2 });
  assert.deepEqual(f.receipts(), committed);
  assert.throws(() => f.apply({ ...f.accept, items: f.before }), /idempotency_mismatch/);
  assert.deepEqual(f.apply(f.undo), { revision: 3 });
  assert.deepEqual(f.apply(f.undo), { revision: 3 });
  assert.deepEqual(f.apply(f.accept), { revision: 2 });
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 3);
  assert.deepEqual(f.db.prepare('SELECT revision FROM synthetic_plan_invalidations ORDER BY revision').all(), [{ revision: 2 }, { revision: 3 }]);
  const lineage = f.db.prepare('SELECT operation,result FROM command_receipts ORDER BY operation').all() as { operation: string; result: string }[];
  assert.deepEqual(lineage.map(row => JSON.parse(row.result)), [
    { operation: 'suggestion_accept', suggestionId: 'suggestion', planId: f.plan.id, fromRevision: 1, toRevision: 2, undoOf: null },
    { operation: 'suggestion_undo', suggestionId: 'suggestion', planId: f.plan.id, fromRevision: 2, toRevision: 3, undoOf: 'suggestion' },
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
  const wrongDb = createPlanRevisionPort(otherDb.domain, f.writer, f.binding);
  assert.throws(() => f.within(() => wrongDb.readWithinWrite(f.one, f.plan.id)), /canonical_writer_unproved/);
  assert.throws(() => f.within(() => f.port.applyWithinWrite(f.two, f.accept)), /canonical_writer_unproved/);
  assert.throws(() => f.writer.lifecycle.withActiveWrite(f.two, () => f.port.applyWithinWrite(f.two, f.accept)), /not_found/);
  f.within(() => f.domain.archivePlan(f.one.accountId, f.plan.id, 1));
  assert.throws(() => f.apply({ ...f.accept, expectedRevision: 2 }), /plan_archived/);
  assert.throws(() => f.within(() => f.port.readWithinWrite(f.one, f.plan.id)), /plan_archived/);
  // Valid stored source shape is deliberately read-only here; no schema coercion.
  const source = syntheticSourcePlan();
  f.db.prepare('INSERT INTO plans VALUES(?,?,1,0,?,?,?)')
    .run(f.one.accountId, 'source-plan', JSON.stringify(source), new Date().toISOString(), new Date().toISOString());
  assert.throws(() => f.within(() => f.port.readWithinWrite(f.one, 'source-plan')), /source_plan_legacy_edit_denied/);
  assert.throws(() => f.apply({ ...f.accept, planId: 'source-plan' }), /source_plan_legacy_edit_denied/);
  assert.throws(() => f.domain.patchPlan(f.one.accountId, 'source-plan', { expectedRevision: 1, name: 'Denied' }), /source_plan_legacy_edit_denied/);
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

test('item validation is shared and callback or receipt failure rolls back even when the caller catches it', t => {
  const f = fixture(t);
  const invalidations = () => f.db.prepare('SELECT * FROM synthetic_plan_invalidations').all();
  const unchanged = () => {
    assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 1);
    assert.deepEqual(f.receipts(), []);
    assert.deepEqual(invalidations(), []);
    assert.throws(() => f.domain.planRevision(f.one.accountId, f.plan.id, 2), /not_found/);
  };
  assert.throws(() => f.apply({ ...f.accept, items: [f.after[0]!, f.after[0]!] })); unchanged();
  assert.throws(() => f.apply({ ...f.accept, items: [{ ...f.after[0]!, exerciseId: 'missing' }] }), /not_found/); unchanged();
  f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run('other', JSON.stringify({ id: 'other', name: 'Other', cues: [] }));
  assert.throws(() => f.apply({ ...f.accept, items: [{ ...f.after[0]!, exerciseId: 'other' }] }), /item_identity_conflict/); unchanged();
  const retired = fixture(t);
  retired.db.prepare('UPDATE exercises SET retired=1 WHERE id=?').run('exercise');
  assert.throws(() => retired.apply(retired.accept), /exercise_retired/);
  assert.equal(retired.domain.plan(retired.one.accountId, retired.plan.id).revision, 1);
  assert.deepEqual(retired.receipts(), []);
  const broken = createPlanRevisionPort(f.domain, f.writer, { afterPlanWriteWithinWrite(actor, plan) {
    f.binding.afterPlanWriteWithinWrite(actor, plan);
    throw Error('synthetic invalidation failure');
  } });
  f.within(() => assert.throws(() => broken.applyWithinWrite(f.one, f.accept), /synthetic invalidation failure/)); unchanged();
  f.db.exec(`CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON command_receipts
    WHEN NEW.operation LIKE 'plan.suggestion_%' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
  f.within(() => assert.throws(() => f.port.applyWithinWrite(f.one, f.accept), /synthetic receipt failure/)); unchanged();
  f.db.exec('DROP TRIGGER synthetic_receipt_failure');
  assert.deepEqual(f.apply(f.accept), { revision: 2 });
  assert.equal(invalidations().length, 1);
  const committed = f.receipts();
  f.within(() => assert.throws(() => broken.applyWithinWrite(f.one, f.undo), /synthetic invalidation failure/));
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 2);
  assert.deepEqual(f.receipts(), committed); assert.equal(invalidations().length, 1);
  assert.throws(() => f.domain.planRevision(f.one.accountId, f.plan.id, 3), /not_found/);
  const accepted = f.db.prepare("SELECT result FROM command_receipts WHERE operation='plan.suggestion_accept'").get() as { result: string };
  const value = JSON.parse(accepted.result) as Record<string, unknown>;
  f.db.prepare("UPDATE command_receipts SET result=? WHERE operation='plan.suggestion_accept'").run(JSON.stringify({ ...value, suggestionId: 'foreign' }));
  assert.throws(() => f.apply(f.undo), /plan_receipt_invalid|plan_changed_since_apply/);
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 2);
  assert.equal(invalidations().length, 1);
});

test('port replay rejects expired sessions; synchronous callback and exact writer are mandatory', t => {
  const f = fixture(t); f.apply(f.accept);
  f.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(Date.now() - 1, f.one.sessionId);
  assert.throws(() => f.apply(f.accept), /account_session_invalid/);
  assert.equal(f.receipts().length, 1);
  assert.throws(() => createPlanRevisionPort(f.domain, f.writer, undefined as never), /plan_invalidation_binding_required/);
  const g = fixture(t);
  const asyncPort = createPlanRevisionPort(g.domain, g.writer, { afterPlanWriteWithinWrite: () => Promise.resolve() });
  assert.throws(() => g.within(() => asyncPort.applyWithinWrite(g.one, g.accept)), /plan_callback_must_be_synchronous/);
  assert.equal(g.domain.plan(g.one.accountId, g.plan.id).revision, 1);
  assert.deepEqual(g.receipts(), []);
});

test('domain and port reject asynchronous callbacks, roll back SQL and contain rejected promises', async t => {
  for (const boundary of ['domain', 'port']) {
    for (const kind of ['rejected promise', 'rejecting async callback']) {
      await t.test(`${boundary}: ${kind}`, () => {
        const script = `
          import assert from 'node:assert/strict';
          import { Domain } from ${JSON.stringify(new URL('../../src/domain.js', import.meta.url).href)};
          import { DomainError } from ${JSON.stringify(new URL('../../src/errors.js', import.meta.url).href)};
          import { createCanonicalAccountWriter } from ${JSON.stringify(new URL('../../src/integration/account-modules/canonical-writer.js', import.meta.url).href)};
          import { createPlanRevisionPort } from ${JSON.stringify(new URL('../../src/planning/plan-revision-port.js', import.meta.url).href)};
          import { fixture } from ${JSON.stringify(new URL('../integration/account-modules/fixture.js', import.meta.url).href)};
          const f = fixture();
          try {
            const domain = new Domain(f.db), writer = createCanonicalAccountWriter(f.db);
            f.db.exec('CREATE TABLE synthetic_callback_effects(revision INTEGER NOT NULL)');
            f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)')
              .run('exercise', JSON.stringify({ id: 'exercise', name: 'Synthetic', cues: [] }));
            const items = [{ id: 'item', exerciseId: 'exercise', setTarget: 3, repMin: 8, repMax: 12, targetKg: 0 }];
            writer.lifecycle.withActiveWrite(f.one, () => {
              const plan = domain.createPlan(f.one.accountId, { name: 'Synthetic', minutes: 20, items });
              const before = domain.planRevision(f.one.accountId, plan.id, 1);
              const effect = () => {
                f.db.prepare('INSERT INTO synthetic_callback_effects VALUES(?)').run(2);
                return ${kind === 'rejected promise' ? "Promise.reject(Error('synthetic callback rejection'))" : "(async () => { throw Error('synthetic callback rejection'); })()"};
              };
              const port = createPlanRevisionPort(domain, writer, { afterPlanWriteWithinWrite: effect });
              assert.throws(() => ${boundary === 'domain'
                ? "domain.mutatePlanWithinWrite(f.one.accountId, plan.id, { expectedRevision: 1, name: 'Rejected' }, effect)"
                : "port.applyWithinWrite(f.one, { planId: plan.id, expectedRevision: 1, items, receipt: { operation: 'suggestion_accept', suggestionId: 'rejected' } })"},
                error => error instanceof DomainError && error.status === 503 && error.code === 'plan_callback_must_be_synchronous');
              assert.deepEqual(domain.plan(f.one.accountId, plan.id), plan);
              assert.deepEqual(domain.planRevision(f.one.accountId, plan.id, 1), before);
              assert.throws(() => domain.planRevision(f.one.accountId, plan.id, 2), error => error instanceof DomainError && error.code === 'not_found');
              assert.deepEqual(f.db.prepare('SELECT * FROM synthetic_callback_effects').all(), []);
              assert.deepEqual(f.db.prepare('SELECT * FROM command_receipts').all(), []);
            });
          } finally { f.close(); }
          setImmediate(() => process.stdout.write('callback rejection contained\\n'));
        `;
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', script],
          { env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
        assert.ifError(child.error);
        assert.equal(child.signal, null, child.stderr);
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout, 'callback rejection contained\n');
      });
    }
  }
});

async function serverFixture(t: TestContext) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'plan-revision-'));
  let server: FormServer | undefined;
  const cleanup = () => { try { server?.close(); } finally { rmSync(root, { recursive: true, force: true }); } };
  const interrupt = () => { cleanup(); process.exit(130); }, terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  t.after(() => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); cleanup(); });
  const dbPath = join(root, 'synthetic.sqlite'), seed = new Database(dbPath);
  try { install(seed, baseMigrations); } finally { seed.close(); }
  const origin = 'http://127.0.0.1:47839';
  let serverBindings: LifecycleBindings | undefined, invalidations = 0, failInvalidation = false;
  let invalidationSources: unknown = null;
  server = await createServer({ dbPath, baseURL: origin, secret: 'synthetic-plan-revision-secret-over-32-characters',
    registration: { mode: 'allowlist', emails: ['one@synthetic.invalid', 'two@synthetic.invalid'] },
    lifecycle: { ledger: suppressionLedger().ledger, createAdapters: (_db, bindings) => { serverBindings = bindings; return []; } },
    moduleMigrations, sourceRequestFactories: requestConfiguration,
    sourceAccountModules: { mode: 'source-only', modules: 'usage-bug-and-training-feedback' },
    sourceTraining: {
      registrationWithinWrite: () => {
        if (invalidationSources !== null) {
          invalidations++;
          server!.db.prepare('INSERT INTO synthetic_plan_invalidations VALUES(?)').run(JSON.stringify(invalidationSources));
          if (failInvalidation) throw Error('synthetic Training invalidation failure');
        }
        return { derivations: [], derivationAuthorityWithinWrite: () => false, comparisonBindingFor: () => null };
      },
      retentionAllowedWithinWrite: (_actor, request) => {
        invalidationSources = request.operation === 'invalidate' ? request.sources : null;
        return true;
      },
    },
  });
  const current = server;
  current.db.exec('CREATE TABLE synthetic_plan_invalidations(sources TEXT NOT NULL)');
  const request = async (path: string, token?: string, value?: unknown, method = value === undefined ? 'GET' : 'POST') => {
    const response = await current.handleRequest(new Request(origin + path, { method,
      headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), '192.0.2.39');
    return { status: response.status, body: await response.json() as any };
  };
  const signup = async (name: 'one' | 'two') => {
    const response = await current.handleRequest(new Request(origin + '/api/auth/sign-up/email', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name, email: `${name}@synthetic.invalid`, password: 'Synthetic-plan-revision-password-12345' }) }), '192.0.2.39');
    assert.equal(response.status, 200);
    const token = response.headers.get('set-auth-token'); assert.ok(token);
    const initialized = await request('/v1/me', token); assert.equal(initialized.status, 200);
    const row = current.db.prepare('SELECT f.auth_user_id AS authUserId,s.id AS sessionId FROM form_accounts f JOIN session s ON s.userId=f.auth_user_id WHERE f.id=?')
      .get(initialized.body.accountId) as { authUserId: string; sessionId: string };
    const actor: AccountContext = { accountId: initialized.body.accountId as string, ...row, epoch: 0 };
    return { token, actor };
  };
  const writer = createCanonicalAccountWriter(current.db);
  const within = <T>(actor: AccountContext, effect: () => T): T => {
    assert.ok(serverBindings);
    // The server's Training adapter retains its original canonical writer binding.
    // Admit both exact actors in the same SQLite transaction for this source-only port.
    return serverBindings.withActiveWrite(actor, () => writer.lifecycle.withActiveWrite(actor, effect));
  };
  const port = createPlanRevisionPort(current.domain, writer, { afterPlanWriteWithinWrite(actor, plan) {
    if (hasRetainedFeedbackWithinWrite(current.db, writer, actor))
      current.sourceAccountModules!.trainingFeedback!.invalidateWithinWrite(actor, [{ kind: 'plan', id: plan.id }]);
  } });
  const snapshot = () => Object.fromEntries(['plans', 'plan_revisions', 'plan_item_ids', 'command_receipts',
    'feedback_state', 'feedback_events', 'feedback_projections', 'feedback_dependencies', 'feedback_receipts', 'feedback_keys', 'synthetic_plan_invalidations']
    .map(table => [table, current.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { server: current, request, signup, port, within, snapshot, invalidations: () => invalidations,
    failInvalidation: (value: boolean) => { failInvalidation = value; } };
}

test('actual PATCH and port share one store, immutable history and public Training invalidation without a new PATCH header', async t => {
  const f = await serverFixture(t), one = await f.signup('one'), two = await f.signup('two');
  f.server.sourceAccountModules!.trainingFeedback!.read(one.actor);
  f.server.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run('exercise', JSON.stringify({ id: 'exercise', name: 'Synthetic', cues: [] }));
  const before = [{ id: 'item', exerciseId: 'exercise', setTarget: 3, repMin: 8, repMax: 12, targetKg: 0 }];
  const after = [{ ...before[0]!, setTarget: 2 }];
  const plan = f.within(one.actor, () => f.server.domain.createPlan(one.actor.accountId, { name: 'Synthetic', minutes: 20, items: before }));
  const session = f.within(one.actor, () => f.server.domain.startSession(one.actor.accountId, plan.id, 1));
  const snapshot = structuredClone(session.planSnapshot), revisionOne = f.server.domain.planRevision(one.actor.accountId, plan.id, 1);
  const path = `/v1/plans/${plan.id}`;
  const count = f.invalidations();
  const edited = await f.request(path, one.token, { expectedRevision: 1, name: 'Edited', minutes: 25 }, 'PATCH');
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body, { ...plan, name: 'Edited', minutes: 25, revision: 2, updatedAt: edited.body.updatedAt });
  assert.equal(f.invalidations(), count + 1);
  assert.deepEqual(f.server.domain.session(one.actor.accountId, session.id).planSnapshot, snapshot);
  assert.equal((await f.request(path, two.token, { expectedRevision: 2, name: 'Foreign' }, 'PATCH')).status, 404);
  const stale = await f.request(path, one.token, { expectedRevision: 1, name: 'Stale' }, 'PATCH');
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'stale_revision');
  assert.equal((await f.request(path, one.token, { expectedRevision: 2, extra: 'invalid' }, 'PATCH')).status, 422);
  assert.equal(f.invalidations(), count + 1);
  const accept = { planId: plan.id, expectedRevision: 2, items: after,
    receipt: { operation: 'suggestion_accept' as const, suggestionId: 'joined' } };
  const apply = (input: Parameters<PlanRevisionPort['applyWithinWrite']>[1]) => f.within(one.actor, () => f.port.applyWithinWrite(one.actor, input));
  assert.throws(() => apply(accept), /workout_in_progress/);
  f.within(one.actor, () => f.server.domain.completeSession(one.actor.accountId, session.id, session.revision));
  assert.throws(() => apply({ ...accept, expectedRevision: 1 }), (error: unknown) =>
    error instanceof DomainError && error.status === 409 && error.code === 'stale_revision' &&
    typeof error.details === 'object' && error.details !== null &&
    'revision' in error.details && error.details.revision === 2);
  assert.deepEqual(apply(accept), { revision: 3 });
  assert.equal(f.invalidations(), count + 2);
  assert.deepEqual(apply(accept), { revision: 3 }); assert.equal(f.invalidations(), count + 2);
  const undo = { ...accept, expectedRevision: 3, items: before, receipt: { operation: 'suggestion_undo' as const, suggestionId: 'joined' } };
  assert.deepEqual(apply(undo), { revision: 4 }); assert.equal(f.invalidations(), count + 3);
  const committed = f.snapshot();
  assert.deepEqual(apply(undo), { revision: 4 }); assert.deepEqual(apply(accept), { revision: 3 });
  assert.deepEqual(f.snapshot(), committed); assert.equal(f.invalidations(), count + 3);
  assert.deepEqual(f.server.domain.planRevision(one.actor.accountId, plan.id, 1), revisionOne);
  assert.deepEqual(f.server.domain.session(one.actor.accountId, session.id).planSnapshot, snapshot);
  assert.deepEqual(f.server.domain.planRevision(one.actor.accountId, plan.id, 3).items, after);
  assert.deepEqual(f.server.domain.planRevision(one.actor.accountId, plan.id, 4).items, before);
  const receipts = f.server.db.prepare("SELECT result FROM command_receipts WHERE operation LIKE 'plan.suggestion_%' ORDER BY operation").all() as { result: string }[];
  assert.deepEqual(receipts.map(row => JSON.parse(row.result)), [
    { operation: 'suggestion_accept', suggestionId: 'joined', planId: plan.id, fromRevision: 2, toRevision: 3, undoOf: null },
    { operation: 'suggestion_undo', suggestionId: 'joined', planId: plan.id, fromRevision: 3, toRevision: 4, undoOf: 'joined' },
  ]);
  const acceptedAgain = { ...accept, expectedRevision: 4, receipt: { operation: 'suggestion_accept' as const, suggestionId: 'intervening' } };
  apply(acceptedAgain);
  assert.equal((await f.request(path, one.token, { expectedRevision: 5, name: 'Intervening' }, 'PATCH')).status, 200);
  assert.throws(() => apply({ ...undo, expectedRevision: 6,
    receipt: { operation: 'suggestion_undo', suggestionId: 'intervening' } }), /plan_changed_since_apply/);
  const beforeDenied = f.invalidations();
  f.within(one.actor, () => f.server.domain.archivePlan(one.actor.accountId, plan.id, 6));
  const archived = await f.request(path, one.token, { expectedRevision: 7, name: 'Archived' }, 'PATCH');
  assert.equal(archived.status, 409); assert.equal(archived.body.error.code, 'plan_archived');
  f.server.db.prepare('INSERT INTO plans VALUES(?,?,1,0,?,?,?)')
    .run(one.actor.accountId, 'source-plan', JSON.stringify(syntheticSourcePlan()), new Date().toISOString(), new Date().toISOString());
  const sourceDenied = await f.request('/v1/plans/source-plan', one.token, { expectedRevision: 1, name: 'Denied' }, 'PATCH');
  assert.equal(sourceDenied.status, 409); assert.equal(sourceDenied.body.error.code, 'source_plan_legacy_edit_denied');
  assert.throws(() => apply({ ...accept, planId: 'source-plan' }), /source_plan_legacy_edit_denied/);
  assert.equal(f.invalidations(), beforeDenied);
  f.server.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(Date.now() - 1, one.actor.sessionId);
  assert.equal((await f.request(path, one.token, { expectedRevision: 7, name: 'Inactive' }, 'PATCH')).status, 401);

});

test('actual PATCH and port roll back real Training changes on invalidation and receipt failure', async t => {
  const f = await serverFixture(t), one = await f.signup('one');
  f.server.sourceAccountModules!.trainingFeedback!.read(one.actor);
  f.server.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)').run('exercise', JSON.stringify({ id: 'exercise', name: 'Synthetic', cues: [] }));
  const items = [{ id: 'item', exerciseId: 'exercise', setTarget: 3, repMin: 8, repMax: 12, targetKg: 0 }];
  const plan = f.within(one.actor, () => f.server.domain.createPlan(one.actor.accountId, { name: 'Synthetic', minutes: 20, items }));
  const before = f.snapshot();
  f.failInvalidation(true);
  assert.equal((await f.request(`/v1/plans/${plan.id}`, one.token, { expectedRevision: 1, name: 'Failed' }, 'PATCH')).status, 500);
  assert.deepEqual(f.snapshot(), before);
  const accept = { planId: plan.id, expectedRevision: 1, items: [{ ...items[0]!, setTarget: 2 }],
    receipt: { operation: 'suggestion_accept' as const, suggestionId: 'rollback' } };
  const apply = () => f.within(one.actor, () => {
    assert.throws(() => f.port.applyWithinWrite(one.actor, accept), /synthetic Training invalidation failure|synthetic receipt failure/);
  });
  apply(); assert.deepEqual(f.snapshot(), before);
  f.failInvalidation(false);
  f.server.db.exec(`CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON command_receipts
    WHEN NEW.operation LIKE 'plan.suggestion_%' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
  apply(); assert.deepEqual(f.snapshot(), before);
  f.server.db.exec('DROP TRIGGER synthetic_receipt_failure');
  assert.deepEqual(f.within(one.actor, () => f.port.applyWithinWrite(one.actor, accept)), { revision: 2 });
});

test('actual wearable consumer rejects stale suggestion intent and rolls back plan invalidation on its receipt failure', t => {
  const f = fixture(t); f.db.exec(wearablePersistenceSql);
  const persistence = createWearablePersistence({ db: f.db, lifecycle: f.writer.lifecycle, control: f.writer,
    assertImportAllowed: () => {} });
  const service = createWearablesService({ ...f.writer.lifecycle, store: persistence.store, plans: f.port,
    enabled: () => true, now: () => '2026-10-01T00:00:00Z', assertImportAllowed: () => {}, assertSuggestionAllowed: () => {} });
  const suggestion: Suggestion = { id: 'suggestion', planId: f.plan.id, baseRevision: 1, appliedRevision: null,
    state: 'pending', beforeItems: f.before, afterItems: f.after, reviewDigest: 'synthetic-review',
    expiresAt: '2026-11-01T00:00:00Z', reason: 'Synthetic fixture', limits: ['No physiological qualification'],
    policyVersion: 'synthetic', evidenceRefs: [] };
  const put = (value: Suggestion) => f.within(() => persistence.store.putSuggestion(f.one, value));
  const review = { expectedPlanRevision: 1, reviewDigest: suggestion.reviewDigest };
  const run = (input = review, value = suggestion) => service.suggestion(f.one, `accept:${value.id}`, value.id, 'accept', input);
  const unchanged = () => {
    assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 1);
    assert.deepEqual(f.receipts(), []);
    assert.deepEqual(f.db.prepare('SELECT * FROM synthetic_plan_invalidations').all(), []);
    assert.deepEqual(f.db.prepare('SELECT * FROM wearable_receipts').all(), []);
  };
  put(suggestion);
  assert.throws(() => run({ ...review, reviewDigest: 'changed-review' }), /health_review_changed/); unchanged();
  const expired = { ...suggestion, id: 'expired-suggestion', expiresAt: '2026-09-01T00:00:00Z' };
  put(expired);
  assert.throws(() => run(review, expired), /health_suggestion_changed/); unchanged();
  const stale = { ...suggestion, id: 'stale-suggestion', baseRevision: 2 };
  put(stale);
  assert.throws(() => run(review, stale), /health_suggestion_changed/); unchanged();
  const changed = { ...suggestion, id: 'changed-suggestion', beforeItems: f.after };
  put(changed);
  assert.throws(() => run(review, changed), /health_plan_changed/); unchanged();
  f.db.exec(`CREATE TRIGGER synthetic_wearable_receipt_failure BEFORE INSERT ON wearable_receipts
    BEGIN SELECT RAISE(ABORT,'synthetic wearable receipt failure'); END`);
  assert.throws(() => run(), /synthetic wearable receipt failure/); unchanged();
  assert.equal(persistence.store.suggestion(f.one, suggestion.id)?.state, 'pending');
  f.db.exec('DROP TRIGGER synthetic_wearable_receipt_failure');
  run();
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 2);
  assert.equal(f.db.prepare('SELECT * FROM synthetic_plan_invalidations').all().length, 1);
  const receipts = f.db.prepare('SELECT * FROM wearable_receipts').all();
  assert.deepEqual(run(), run());
  assert.deepEqual(f.db.prepare('SELECT * FROM wearable_receipts').all(), receipts);
  f.domain.patchPlan(f.one.accountId, f.plan.id, { expectedRevision: 2, name: 'Intervening PATCH' });
  assert.throws(() => service.suggestion(f.one, 'undo', suggestion.id, 'undo', { ...review, expectedPlanRevision: 3 }), /plan_changed_since_apply/);
  assert.equal(f.domain.plan(f.one.accountId, f.plan.id).revision, 3);
  assert.deepEqual(f.db.prepare('SELECT * FROM wearable_receipts').all(), receipts);
});
