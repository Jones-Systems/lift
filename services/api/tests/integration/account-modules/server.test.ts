import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createServer, type FormServer, type ServerConfig, type SourceTrainingConfiguration } from '../../../src/server.js';
import type { RuntimeOwner } from '../../../src/runtime-modules/admission.js';
import { lifecyclePolicy } from '../../../src/lifecycle/service.js';
import type { AccountContext, LifecycleBindings } from '../../../src/lifecycle/types.js';
import { createSourceAccountModules, type RetentionRequest } from '../../../src/integration/account-modules/index.js';
import type { FeedbackCommand } from '../../../src/training-feedback/ledger-types.js';
import { progressComparisonMigrationSql } from '../../../src/progress-comparison/migration.js';
import { featureBoardCorrectionMigrationSql } from '../../../src/community/board/correction-migration.js';
import { selectAccountModuleMigrations } from '../../../src/integration/account-modules/migrations.js';
import type { SourcePrescriptionPlanFields } from '../../../src/schemas.js';
import { hash, migrations } from '../../../src/storage.js';
import { baseMigrations, selectedMigrations, selector, moduleMigrations, requestConfiguration, suppressionLedger, install, reportInput } from './fixture.js';

const origin = 'http://127.0.0.1:47835';
const secret = 'synthetic-account-modules-secret-over-32-characters';
const trainingSelector = { mode: 'source-only', modules: 'usage-bug-and-training-feedback' } as const;
const prescriptionSelector = { mode: 'source-only', modules: 'usage-bug-training-feedback-and-source-prescription' } as const;
const correctionSelector = { mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' } as const;
const boardInput = { title: 'Improve workout planning', description: 'Please improve the flexibility of workout plans.',
  category: 'plans', policyVersion: 'form_feature_board_v1', policyAccepted: true, audienceAccepted: true };
// Synthetic metadata tests schema capability only; it does not qualify a source catalog or prescription.
function sourcePlan(exerciseId: string): SourcePrescriptionPlanFields {
  return { schema: 'form.source-prescription-plan/v1', name: 'Synthetic migration capability',
    origin: { kind: 'form-adaptation', id: 'synthetic-origin', revision: 'test-v1' },
    duration: { kind: 'estimated-range', minMinutes: 10, maxMinutes: 20 },
    items: [{ id: 'synthetic-item', native: { exercise_id: 'synthetic-native', movement_pattern: 'synthetic pattern', role: 'synthetic role', sets: 1, rest_seconds: 60 },
      registeredDomain: { exerciseId, variantId: 'synthetic-variant',
        identity: { repository: 'synthetic/repository', revision: 'test-v1', path: 'synthetic/catalog.json', sha256: 'a'.repeat(64), nativeId: 'synthetic-native' },
        registration: { id: 'synthetic-registration', revision: 'test-v1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
      load: { kind: 'unspecified', basis: 'unknown' } }],
  };
}
function trainingPolicy() {
  const requests: RetentionRequest[] = [];
  let registrations = 0, retained = true, registrationHook = (_context: AccountContext) => {};
  const port: SourceTrainingConfiguration = {
    registrationWithinWrite(context) { registrations++; registrationHook(context);
      return { derivations: [], derivationAuthorityWithinWrite: () => false, comparisonBindingFor: () => null };
    },
    retentionAllowedWithinWrite(_context, request) { requests.push(request); return retained; },
  };
  return { port, requests, registrations: () => registrations, deny: () => { retained = false; },
    onRegistration: (hook: typeof registrationHook) => { registrationHook = hook; } };
}
function retainedFeedback(server: FormServer, actor: AccountContext, withdraw = false) {
  const service = server.sourceAccountModules!.trainingFeedback!;
  const first = service.read(actor), scope = { kind: 'context' as const, contextId: first.analysis.contextId };
  const witness = service.witness(actor, { scope, selection: null }).result;
  const base = { accountId: actor.accountId, recordId: 'server-feedback' };
  const record: FeedbackCommand = { idempotencyKey: 'feedback-record', expectedLedgerRevision: first.result.ledgerRevision,
    expectedWitness: witness, selection: null, event: { ...base, eventId: 'feedback-record', expectedRevision: 0, kind: 'record', content: {
      scope, sourceRefs: [{ sourceId: 'self-report', revision: '1', locator: 'synthetic', qualification: 'User report only' }],
      qualifications: ['Synthetic retained report'], payload: { kind: 'feedback', signals: [
        { dimension: 'effort', state: 'reported', value: 4, unit: null, scale: null }] } } } };
  const recorded = service.mutate(actor, record);
  assert.equal(recorded.result.receipt.outcome, 'changed');
  const confirmed = service.mutate(actor, { ...record, idempotencyKey: 'feedback-confirm',
    expectedLedgerRevision: recorded.result.current.ledgerRevision,
    event: { ...base, eventId: 'feedback-confirm', expectedRevision: 1, kind: 'confirm' } });
  assert.equal(confirmed.result.receipt.outcome, 'changed');
  if (withdraw) {
    const withdrawn = service.mutate(actor, { ...record, idempotencyKey: 'feedback-withdraw',
      expectedLedgerRevision: confirmed.result.current.ledgerRevision,
      event: { ...base, eventId: 'feedback-withdraw', expectedRevision: 2, kind: 'withdraw' } });
    assert.equal(withdrawn.result.receipt.outcome, 'changed');
  }
  return scope;
}
function client(server: FormServer) {
  const request = async (path: string, token?: string, value?: unknown, key = 'synthetic-key', method = value === undefined ? 'GET' : 'POST') => {
    const response = await server.handleRequest(new Request(origin + path, { method,
      headers: { origin, 'content-type': 'application/json', 'idempotency-key': key, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), '192.0.2.35');
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  const signup = async (name: string) => {
    const registered = await request('/api/auth/sign-up/email', undefined, { name, email: `${name}@synthetic.invalid`, password: 'Synthetic-account-modules-password-12345' });
    assert.equal(registered.status, 200);
    const token = registered.headers.get('set-auth-token'); assert.ok(token);
    const initialized = await request('/v1/me', token); assert.equal(initialized.status, 200);
    const row = server.db.prepare('SELECT f.auth_user_id AS authUserId,s.id AS sessionId FROM form_accounts f JOIN session s ON s.userId=f.auth_user_id WHERE f.id=?')
      .get(initialized.body.accountId) as { authUserId: string; sessionId: string };
    return { token, actor: { accountId: initialized.body.accountId as string, ...row, epoch: 0 } satisfies AccountContext };
  };
  return { request, signup };
}

async function fixture(run: (value: { server: FormServer; config: ServerConfig; reopen: (config?: ServerConfig) => Promise<FormServer> } & ReturnType<typeof client>) => Promise<void>, selected = true,
  override?: (config: ServerConfig) => ServerConfig, historicalPrefix?: number) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'account-modules-'));
  let server: FormServer | undefined;
  const cleanup = () => { try { if (server?.db.open) server.close(); } finally { rmSync(root, { recursive: true, force: true }); } };
  const interrupt = () => { cleanup(); process.exit(130); }, terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const dbPath = join(root, 'synthetic.sqlite'), seed = new Database(dbPath);
    try { install(seed, selected ? (historicalPrefix === undefined ? baseMigrations : baseMigrations.slice(0, historicalPrefix)) : migrations); } finally { seed.close(); }
    let config: ServerConfig = { dbPath, baseURL: origin, secret,
      registration: { mode: 'allowlist', emails: ['one@synthetic.invalid', 'two@synthetic.invalid'] },
      ...(selected ? { lifecycle: { ledger: suppressionLedger().ledger }, moduleMigrations, sourceRequestFactories: requestConfiguration, sourceAccountModules: selector } : {}),
    };
    if (override) config = override(config);
    server = await createServer(config);
    const reopen = async (next = config) => { if (server?.db.open) server.close(); server = await createServer(next); return server; };
    await run({ server, config, reopen, ...client(server) });
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); cleanup(); }
}

test('default server retains its existing schema and has no usage or bug source composition', () => fixture(async f => {
  assert.equal(f.server.sourceAccountModules, undefined);
  assert.equal((f.server.db.prepare('SELECT max(version) n FROM form_migrations').get() as { n: number }).n, 7);
  assert.equal(f.server.db.prepare("SELECT name FROM sqlite_master WHERE name IN('usage_accounts','bug_intake_reports')").get(), undefined);
  const user = await f.signup('one');
  assert.equal((await f.request('/v1/bug-reports', user.token)).status, 404);
  const training = await f.request('/v1/training-feedback', user.token);
  assert.equal(training.status, 503); assert.equal(training.body.error.code, 'training_feedback_unavailable');
}, false));

test('explicit older16 18 and19 server selections retain legacy board and deny correction without20', async () => {
  for (const selection of [selector, trainingSelector, prescriptionSelector]) await fixture(async f => {
    const expected = selectAccountModuleMigrations(selection, baseMigrations);
    assert.deepEqual(f.server.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(),
      expected.map(entry => ({ version: entry.version, checksum: hash(entry.sql) })));
    assert.equal(f.server.db.prepare("SELECT 1 FROM sqlite_master WHERE name='community_board_correction_events'").get(), undefined);
    const user = await f.signup('one');
    assert.equal((await f.request('/v1/me/profile', user.token, { expectedRevision: 0, age: 40 }, 'age', 'PATCH')).status, 200);
    const submitted = await f.request('/v1/community/board/features', user.token, boardInput, 'original');
    assert.equal(submitted.status, 201); assert.equal(submitted.body.visibility, 'pending');
    const corrected = await f.request(`/v1/community/board/submissions/${submitted.body.id}/correct`, user.token,
      { ...boardInput, title: 'Corrected workout request', expectedRevision: submitted.body.revision, expectedCanonicalFeatureId: submitted.body.canonicalFeatureId }, 'correct');
    assert.equal(corrected.status, 503); assert.equal(corrected.body.error.code, 'board_correction_unavailable');
    assert.equal((await f.request(`/v1/community/board/submissions/${submitted.body.id}/withdraw`, user.token, { expectedRevision: submitted.body.revision }, 'withdraw')).status, 200);
    const plan = sourcePlan(f.server.domain.exercises()[0]!.id);
    if (selection.modules === prescriptionSelector.modules) assert.equal(f.server.domain.createSourcePlan(user.actor.accountId, plan).schema, plan.schema);
    else assert.throws(() => f.server.domain.createSourcePlan(user.actor.accountId, plan), { code: 'source_prescription_unavailable' });
  }, true, config => ({ ...config, sourceAccountModules: selection }));
});

test('explicit20 server mounts authenticated correction with exact migration receipt replay and lifecycle coverage', () => fixture(async f => {
  const expected = selectAccountModuleMigrations(correctionSelector, baseMigrations);
  assert.deepEqual(f.server.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(),
    expected.map(entry => ({ version: entry.version, checksum: hash(entry.sql) })));
  assert.equal(f.server.migrationBackups.length, 4);
  assert.deepEqual(f.server.db.prepare('SELECT checksum FROM form_migrations WHERE version=20').get(), { checksum: hash(featureBoardCorrectionMigrationSql) });
  assert.ok(f.server.sourceAccountModules!.trainingFeedback);
  const one = await f.signup('one'), two = await f.signup('two');
  for (const user of [one, two]) assert.equal((await f.request('/v1/me/profile', user.token, { expectedRevision: 0, age: 40 }, 'age', 'PATCH')).status, 200);
  const plan = sourcePlan(f.server.domain.exercises()[0]!.id);
  const saved = f.server.domain.createSourcePlan(one.actor.accountId, plan);
  assert.equal(saved.schema, plan.schema); assert.deepEqual(saved.items, plan.items);
  const submitted = await f.request('/v1/community/board/features', one.token, boardInput, 'original');
  assert.equal(submitted.status, 201);
  const path = `/v1/community/board/submissions/${submitted.body.id}/correct`;
  const input = { ...boardInput, title: 'Corrected workout request', expectedRevision: submitted.body.revision, expectedCanonicalFeatureId: submitted.body.canonicalFeatureId };
  assert.equal((await f.request(path, undefined, input, 'correct')).status, 401);
  assert.equal((await f.request(path, two.token, input, 'foreign')).status, 404);
  const result = await f.request(path, one.token, input, 'correct');
  assert.equal(result.status, 201); assert.equal(result.body.receipt.schema, 'form.feature-board-correction/v1');
  assert.equal(result.body.successor.visibility, 'pending'); assert.equal(result.body.successor.predecessorSubmissionId, submitted.body.id);
  const detail = await f.request(`/v1/community/board/features/${result.body.successor.featureId}`, one.token);
  assert.equal(detail.status, 200); assert.equal(detail.body.feature.voteCount, 0);
  assert.equal((await f.request(`/v1/community/board/features/${result.body.successor.featureId}`, two.token)).status, 404);
  const reopened = await f.reopen(); const current = client(reopened);
  assert.deepEqual(reopened.migrationBackups, []);
  assert.equal((await current.request(`/v1/community/board/submissions/${result.body.successor.id}/withdraw`, one.token,
    { expectedRevision: result.body.successor.revision }, 'withdraw')).status, 200);
  const replay = await current.request(path, one.token, input, 'correct');
  assert.equal(replay.status, 201); assert.deepEqual(replay.body.receipt, result.body.receipt); assert.equal(replay.body.successor.visibility, 'withdrawn');
  assert.equal(reopened.db.prepare('SELECT count(*) FROM community_board_correction_events').pluck().get(), 1);
  const adapter = reopened.lifecycle!.adapters.find(value => value.category === 'community')!;
  reopened.db.transaction(() => {
    assert.equal(adapter.inventory(one.actor).status, 'complete');
    const sections: unknown[] = [];
    assert.equal(adapter.export(one.actor, { snapshotAtMs: Date.now(), append: (_category, value) => { sections.push(value); } }).status, 'complete');
    assert.ok(JSON.stringify(sections).includes(result.body.receipt.eventId)); assert.equal(JSON.stringify(sections).includes(one.actor.sessionId), false);
    assert.equal(adapter.purge('unqualified', one.actor.accountId).status, 'pending');
    reopened.reconcileModulesRestore!({ ready: true, lookup: () => ({ state: 'active', epoch: 0 }) });
  }).immediate();
  const restored = await current.request(path, one.token, input, 'correct');
  assert.equal(restored.status, 409); assert.equal(restored.body.error.code, 'board_restore_reconsent_required');
  assert.deepEqual(reopened.db.pragma('foreign_key_check'), []);
  reopened.db.prepare('DELETE FROM session WHERE id=?').run(one.actor.sessionId);
  assert.equal((await current.request(path, one.token, input, 'correct')).status, 401);
}, true, config => ({ ...config, sourceAccountModules: correctionSelector, sourceTraining: trainingPolicy().port })));

test('selected server migrates genuine 13 to 16 and reopening without public selection retains private lifecycle coverage', () => fixture(async f => {
  const expected = selectedMigrations.map(entry => ({ version: entry.version, checksum: hash(entry.sql) }));
  assert.deepEqual(f.server.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(), expected);
  assert.equal(f.server.migrationBackups.length, 3);
  const reopened = await f.reopen();
  assert.equal(reopened.migrationBackups.length, 0);
  assert.deepEqual(reopened.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(), expected);
  const { sourceAccountModules: _selected, ...withoutSelector } = f.config;
  const privateOnly = await f.reopen(withoutSelector);
  assert.equal(privateOnly.sourceAccountModules, undefined);
  assert.equal(privateOnly.migrationBackups.length, 0);
  assert.deepEqual(privateOnly.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(), expected);
  assert.deepEqual(privateOnly.lifecycle!.adapters.map(adapter => adapter.category).sort(), ['activity', 'bugIntake', 'community', 'usage_limits']);
  const privateClient = client(privateOnly), user = await privateClient.signup('one');
  assert.equal((await privateClient.request('/v1/bug-reports', user.token)).status, 404);
}, true, undefined, 13));

test('selected bug routes retain authenticated account ownership and expose no dispatch or usage endpoints', () => fixture(async f => {
  const one = await f.signup('one'), two = await f.signup('two');
  assert.equal((await f.request('/v1/bug-reports', undefined, reportInput)).status, 401);
  const submitted = await f.request('/v1/bug-reports', one.token, reportInput);
  assert.equal(submitted.status, 201); assert.equal(submitted.body.report.state, 'received');
  assert.equal((await f.request(`/v1/bug-reports/${submitted.body.report.id}`, two.token)).status, 404);
  assert.deepEqual((await f.request('/v1/bug-reports', two.token)).body, { reports: [] });
  assert.equal((await f.request('/v1/bug-reports', one.token, { ...reportInput, accountId: two.actor.accountId }, 'owner-injection')).status, 422);
  assert.equal((await f.request('/v1/bug-reports', one.token, { ...reportInput, description: 'a'.repeat(16 * 1024) }, 'oversized-report')).status, 413);
  for (const action of ['prepare', 'dispatch', 'triage'])
    assert.equal((await f.request(`/v1/bug-reports/${submitted.body.report.id}/${action}`, one.token, {})).status, 404);
  assert.equal((await f.request('/v1/usage', one.token)).status, 404);
  assert.equal(f.server.sourceAccountModules!.usage.status(one.actor).configured, false);
  assert.equal((await f.request('/v1/me/account-export', one.token, {})).status, 501);
  const capabilities = await f.request('/v1/capabilities');
  assert.equal(capabilities.body.runtimeModules.configured, false);
  assert.equal(capabilities.body.purchases.chargesEnabled, false);
  assert.equal((await f.request('/v1/body/capabilities', one.token)).body.retainedMeasurements.status, 'unavailable');
}));

test('bug route rejects session or epoch changes after request admission without persisting report or key', () => fixture(async f => {
  const users = [await f.signup('one'), await f.signup('two')];
  for (const [index, user] of users.entries()) {
    let controller!: ReadableStreamDefaultController<Uint8Array>, admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { admitted(); } }, { highWaterMark: 0 });
    const bytes = new TextEncoder().encode(JSON.stringify(reportInput));
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', body: stream, headers: {
      origin, authorization: `Bearer ${user.token}`, 'content-type': 'application/json', 'content-length': String(bytes.byteLength), 'idempotency-key': 'paused-report',
    } };
    const result = Promise.resolve(f.server.handleRequest(new Request(origin + '/v1/bug-reports', init), '192.0.2.35'));
    void result.catch(() => {});
    try {
      await Promise.race([admission, result.then(response => { throw new Error(`Request finished before body admission: ${response.status}`); })]);
      if (index === 0) f.server.db.prepare('DELETE FROM session WHERE id=?').run(user.actor.sessionId);
      else f.server.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(user.actor.accountId);
      controller.enqueue(bytes); controller.close();
      const response = await result;
      assert.equal(response.status, index === 0 ? 401 : 403);
      assert.equal((await response.json() as { error: { code: string } }).error.code, index === 0 ? 'account_session_invalid' : 'account_epoch_changed');
    } finally { try { controller.error(new Error('Synthetic request cleanup')); } catch {} await result.catch(() => {}); }
  }
  for (const table of ['bug_intake_reports', 'bug_intake_keys'])
    assert.equal((f.server.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
}));

test('selector rejects missing source prerequisites and RuntimeOwner before opening storage; duplicates reject at composition', async () => {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'account-module-config-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  const interrupt = () => { cleanup(); process.exit(130); }, terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const dbPath = join(root, 'never-created.sqlite');
    const config = { dbPath, baseURL: origin, secret, sourceAccountModules: selector };
    await assert.rejects(createServer(config), { code: 'account_modules_source_bindings_required' });
    let closed = 0;
    const runtimeOwner = { close(clean: boolean) { assert.equal(clean, false); closed++; } } as unknown as RuntimeOwner;
    await assert.rejects(createServer({ ...config, runtimeOwner }), /Runtime ownership cannot mix source injections/);
    assert.equal(closed, 1); assert.equal(existsSync(dbPath), false);
    await assert.rejects(createServer({ dbPath, baseURL: origin, secret, runtimeOwner, sourceTraining: trainingPolicy().port }),
      /Runtime ownership cannot mix source injections/);
    assert.equal(closed, 2); assert.equal(existsSync(dbPath), false);
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); cleanup(); }
  await assert.rejects(fixture(async () => {}, true, config => ({ ...config, lifecycle: {
    ledger: config.lifecycle!.ledger, createAdapters: (db, bindings) => createSourceAccountModules(db, bindings).adapters,
  } })), { code: 'duplicate_module_lifecycle_adapter' });
  await assert.rejects(fixture(async () => {}, true, config => ({ ...config, sourceTraining: trainingPolicy().port })),
    { code: 'training_feedback_bindings_unavailable' });
  await assert.rejects(fixture(async () => {}, true, config => ({ ...config, sourceAccountModules: trainingSelector,
    sourceTraining: { ...trainingPolicy().port, domain: {} } as SourceTrainingConfiguration })),
    { code: 'training_feedback_bindings_unavailable' });
  await assert.rejects(fixture(async () => {}, true, config => ({ ...config, lifecycle: {
    ...config.lifecycle!, createAdapters: db => { db.exec(progressComparisonMigrationSql); return []; },
  } })), { code: 'training_feedback_schema_unavailable' });
});

test('current 16 schema supplies complete private lifecycle inventory without enabling request capabilities', () => fixture(async f => {
  const user = await f.signup('one');
  assert.deepEqual(f.server.db.prepare('SELECT version FROM form_migrations ORDER BY version').all(),
    Array.from({ length: 16 }, (_, i) => ({ version: i + 1 })));
  assert.equal(f.server.migrationBackups.length, 0);
  assert.equal(f.server.sourceAccountModules, undefined);
  assert.ok(f.server.reconcileModulesRestore);
  assert.deepEqual(f.server.lifecycle!.adapters.map(adapter => adapter.category).sort(), ['activity', 'bugIntake', 'community', 'usage_limits']);
  for (const path of ['/v1/bug-reports', '/v1/usage'])
    assert.equal((await f.request(path, user.token)).status, 404, path);
  for (const [path, code] of [['/v1/activity/entries', 'activity_persistability_unavailable'], ['/v1/community/groups', 'community_unavailable'],
    ['/v1/community/board/features', 'board_unavailable']] as const) {
    const response = await f.request(path, user.token); assert.equal(response.status, 503); assert.equal(response.body.error.code, code);
  }
  const capabilities = (await f.request('/v1/capabilities')).body.runtimeModules;
  assert.equal(capabilities.configured, false); assert.equal(capabilities.independentActivity, false);
  assert.equal(capabilities.pendingBoard, false);
  f.server.db.transaction(() => {
    for (const adapter of f.server.lifecycle!.adapters) assert.equal(adapter.inventory(user.actor).status, 'complete', adapter.category);
  }).immediate();
}, true, config => {
  const { sourceAccountModules: _modules, sourceRequestFactories: _requests, ...privateOnly } = config;
  return privateOnly;
}));

test('private adapters export original account data and authenticated disable suppresses every module before restore', async () => {
  let bindings!: LifecycleBindings;
  await fixture(async f => {
    const one = await f.signup('one'), two = await f.signup('two'), db = f.server.db;
    const modules = createSourceAccountModules(db, bindings);
    assert.equal(createSourceAccountModules(db, bindings), modules);
    assert.equal(f.server.sourceAccountModules, undefined);
    modules.bugFor(one.actor).submit(reportInput, 'private-report');
    db.prepare('INSERT INTO usage_accounts VALUES(?,?)').run(one.actor.accountId, 'synthetic-policy');
    const groupId = randomUUID(), memberId = randomUUID(), featureId = randomUUID(), postId = randomUUID();
    const now = new Date().toISOString(), expires = new Date(Date.now() + 86400000).toISOString();
    db.transaction(() => {
      db.prepare("INSERT INTO community_groups VALUES(?,?,?,'active',1,1,?,NULL)").run(groupId, 'Original group label', two.actor.accountId, now);
      db.prepare("INSERT INTO community_members VALUES(?,?,?,'Owner','owner','active',1,1,?,NULL)")
        .run(groupId, two.actor.accountId, randomUUID(), now);
      db.prepare("INSERT INTO community_members VALUES(?,?,?,'','member','removed',2,2,?,?)")
        .run(groupId, one.actor.accountId, memberId, now, now);
      db.prepare('INSERT INTO community_removal_snapshots VALUES(?,?,?,2,?,?,1,?)')
        .run(groupId, one.actor.accountId, memberId, now, now, 'Original group label');
      db.prepare("INSERT INTO community_posts VALUES(?,?,1,?,1,1,'win',NULL,?,'published','community-v1',?,?)")
        .run(postId, groupId, one.actor.accountId, 'Synthetic original post', now, expires);
      db.prepare("INSERT INTO community_board_features VALUES(?,'general','submitted',NULL,1,?)").run(featureId, now);
      db.prepare(`INSERT INTO community_board_submissions(id,feature_id,author_account_id,title,description,category,policy_version,audience_accepted,visibility,revision,created_at)
        VALUES(?,?,?,?,?,'general','form_feature_board_v1',1,'pending',1,?)`)
        .run(randomUUID(), featureId, one.actor.accountId, 'Synthetic original feature', 'Synthetic description', now);
    }).immediate();
    const snapshot = db.prepare('SELECT * FROM community_removal_snapshots WHERE account_id=?').get(one.actor.accountId) as Record<string, string | number>;
    const grant = await f.request('/v1/me/account-action-grants', one.token, { purpose: 'account_export', password: 'Synthetic-account-modules-password-12345' });
    assert.equal(grant.status, 201);
    const exported = await f.request('/v1/me/account-export', one.token, { grant: grant.body.grant });
    assert.equal(exported.status, 200);
    const records = exported.body.records as { category: string; value: unknown }[];
    assert.ok(records.some(row => row.category === 'usage_limits'));
    assert.ok(records.some(row => row.category === 'bugIntake'));
    const community = JSON.stringify(records.filter(row => row.category === 'community'));
    assert.match(community, /own_removal_snapshot/); assert.match(community, /Original group label/);
    assert.match(community, /Synthetic original post/); assert.match(community, /Synthetic original feature/);
    assert.equal((await f.request('/v1/bug-reports', one.token)).status, 404);
    const requestId = randomUUID(), statusSecret = 'a'.repeat(43);
    const initiated = await f.request('/v1/me/deletion-requests', one.token,
      { requestId, statusSecret, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' }, 'private-delete');
    assert.equal(initiated.status, 201);
    const deletionGrant = await f.request('/v1/me/account-action-grants', one.token,
      { purpose: 'account_delete', password: 'Synthetic-account-modules-password-12345' });
    assert.equal(deletionGrant.status, 201);
    const disabled = await f.request(`/v1/me/deletion-requests/${requestId}/confirm`, one.token,
      { grant: deletionGrant.body.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' });
    assert.equal(disabled.status, 200); assert.equal(disabled.body.disabled, true); assert.equal(disabled.body.complete, false);
    const record = f.config.lifecycle!.ledger.lookup(one.actor.accountId); assert.ok(record); assert.equal(record.epoch, 1);
    assert.equal((await f.request('/v1/me', one.token)).status, 401); assert.equal((await f.request('/v1/me', two.token)).status, 200);
    assert.equal(db.prepare('SELECT 1 FROM community_removal_snapshots WHERE account_id=?').get(one.actor.accountId), undefined);
    assert.deepEqual(db.prepare('SELECT state,text FROM community_posts WHERE id=?').get(postId), { state: 'hidden', text: null });
    assert.deepEqual(db.prepare('SELECT visibility FROM community_board_submissions WHERE feature_id=?').get(featureId), { visibility: 'hidden' });
    db.transaction(() => {
      for (const adapter of f.server.lifecycle!.adapters) {
        assert.equal(adapter.verifySuppressed(one.actor.accountId, record.epoch).status, 'complete', adapter.category);
        const purge = adapter.purge(requestId, one.actor.accountId);
        if (adapter.category === 'community') assert.deepEqual(purge, {
          status: 'pending', reason: 'community_module_results_require_resolution',
          modules: {
            b2: { status: 'pending', reason: 'community_retention_order_and_purge_qualification_required' },
            b4: { status: 'pending', reason: 'community_b4_retention_order_and_purge_qualification_required' },
            b5: { status: 'pending', reason: 'board_retention_audit_redaction_order_unqualified' },
          },
        });
        else assert.equal(purge.status, 'unavailable', adapter.category);
      }
      db.prepare('INSERT INTO community_removal_snapshots VALUES(@group_id,@account_id,@member_id,@membership_generation,@removed_at,@membership_ended_at,@group_generation_at_removal,@group_label_at_removal)').run(snapshot);
      db.prepare("UPDATE community_posts SET state='published',text='Synthetic restored post' WHERE id=?").run(postId);
      db.prepare("UPDATE community_board_submissions SET visibility='pending' WHERE feature_id=?").run(featureId);
      const restored = f.server.reconcileModulesRestore!({ ready: true, lookup: accountId => {
        const suppressed = f.config.lifecycle!.ledger.lookup(accountId);
        if (suppressed) return { state: 'suppressed', epoch: suppressed.epoch };
        const state = db.prepare('SELECT state,epoch FROM account_lifecycle WHERE account_id=?').get(accountId) as { state: string; epoch: number } | undefined;
        return state?.state === 'active' ? { state: 'active', epoch: state.epoch } : undefined;
      } });
      assert.equal(restored.suppressed, 1);
    }).immediate();
    assert.equal(db.prepare('SELECT 1 FROM community_removal_snapshots WHERE account_id=?').get(one.actor.accountId), undefined);
    assert.deepEqual(db.prepare('SELECT state,text FROM community_posts WHERE id=?').get(postId), { state: 'hidden', text: null });
    assert.deepEqual(db.prepare('SELECT visibility FROM community_board_submissions WHERE feature_id=?').get(featureId), { visibility: 'hidden' });
    assert.equal((db.prepare('SELECT count(*) n FROM bug_intake_reports WHERE account_id=?').get(one.actor.accountId) as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT count(*) n FROM usage_accounts WHERE account_id=?').get(one.actor.accountId) as { n: number }).n, 1);
    assert.equal(f.server.lifecycle!.status(requestId, statusSecret).complete, false);
  }, true, config => {
    const { sourceAccountModules: _modules, sourceRequestFactories: _requests, ...privateOnly } = config;
    return { ...privateOnly, publicStagedLifecycleEnabled: true, lifecycle: { ...config.lifecycle!,
      createAdapters: (_db, captured) => { bindings = captured; return []; } } };
  });
});

test('explicit schema18 reopens with lifecycle adapters but no TRAIN callbacks and rejects legacy history selection', () => fixture(async f => {
  assert.equal((f.server.db.prepare('SELECT max(version) n FROM form_migrations').get() as { n: number }).n, 18);
  assert.equal(f.server.migrationBackups.length, 2);
  assert.equal(f.server.sourceAccountModules!.trainingFeedback, undefined);
  assert.deepEqual(f.server.lifecycle!.adapters.map(adapter => adapter.category).sort(),
    ['activity', 'bugIntake', 'community', 'progressComparison', 'trainingFeedback', 'usage_limits']);
  const original = f.server.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all();
  const reopened = await f.reopen(); assert.equal(reopened.migrationBackups.length, 0);
  assert.deepEqual(reopened.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(), original);
  assert.equal(reopened.sourceAccountModules!.trainingFeedback, undefined);
  await assert.rejects(f.reopen({ ...f.config, sourceAccountModules: selector }), /Unknown or modified migration history/);
  const { sourceAccountModules: _selector, ...withoutSelector } = f.config;
  await assert.rejects(f.reopen(withoutSelector), /Unknown or modified migration history/);
  const restored = await f.reopen();
  assert.deepEqual(restored.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(), original);
}, true, config => ({ ...config, sourceAccountModules: trainingSelector })));

test('schema18 no-state and progress-only accounts mutate without callbacks or implicit ledger allocation', () => fixture(async f => {
  const one = await f.signup('one');
  const patch = await f.request('/v1/me/profile', one.token, { expectedRevision: 0, goals: ['Original goal'] }, 'profile', 'PATCH');
  assert.equal(patch.status, 200);
  f.server.db.prepare("INSERT INTO progress_comparison_identities VALUES(?,?,'session',?,?,1,1,'withdrawn',NULL,?)")
    .run(one.actor.accountId, 'synthetic-identity', 'synthetic-session', 'synthetic-item', new Date().toISOString());
  const preferences = await f.request('/v1/me/preferences', one.token, { expectedRevision: 0, equipment: ['Dumbbells'] }, 'preferences', 'PATCH');
  assert.equal(preferences.status, 200);
  assert.equal(f.server.db.prepare('SELECT 1 FROM feedback_state').get(), undefined);
  assert.equal((f.server.db.prepare('SELECT count(*) n FROM progress_comparison_identities').get() as { n: number }).n, 1);
}, true, config => ({ ...config, sourceAccountModules: trainingSelector })));

test('retained empty state invalidates all document writes once and receipt replay does not repeat callbacks', async () => {
  const policy = trainingPolicy();
  await fixture(async f => {
    const user = await f.signup('one'), service = f.server.sourceAccountModules!.trainingFeedback!;
    service.read(user.actor);
    let captures = policy.registrations();
    const draft = await f.request('/v1/me/onboarding', user.token,
      { expectedRevision: 0, step: 'review', answers: { goals: ['Confirmed goal'] } }, 'draft', 'PATCH');
    assert.equal(draft.status, 200); assert.equal(policy.registrations(), captures);
    const completed = await f.request('/v1/me/onboarding/complete', user.token, { expectedRevision: 1 }, 'complete');
    assert.equal(completed.status, 200); assert.equal(policy.registrations(), ++captures);
    const replay = await f.request('/v1/me/onboarding/complete', user.token, { expectedRevision: 1 }, 'complete');
    assert.deepEqual(replay.body, completed.body); assert.equal(policy.registrations(), captures);
    assert.equal((await f.request('/v1/me/profile', user.token, { expectedRevision: 1, goals: ['Edited goal'] }, 'profile', 'PATCH')).status, 200);
    assert.equal(policy.registrations(), ++captures);
    const preferences = { expectedRevision: 1, equipment: ['Dumbbells'] };
    assert.equal((await f.request('/v1/me/preferences', user.token, preferences, 'preferences', 'PATCH')).status, 200);
    assert.equal(policy.registrations(), ++captures);
    assert.equal((await f.request('/v1/me/preferences', user.token, preferences, 'preferences', 'PATCH')).status, 200);
    assert.equal(policy.registrations(), captures);
    assert.ok(policy.requests.filter(request => request.operation === 'invalidate').every(request => request.sources.length === 0));
    assert.equal((f.server.db.prepare('SELECT count(*) n FROM feedback_events').get() as { n: number }).n, 0);
  }, true, config => ({ ...config, sourceAccountModules: trainingSelector, sourceTraining: policy.port }));
});

test('originating manual plan and session routes invalidate their actual source IDs within each receipt effect', async () => {
  const policy = trainingPolicy();
  await fixture(async f => {
    const user = await f.signup('one'); f.server.sourceAccountModules!.trainingFeedback!.read(user.actor);
    f.server.db.prepare('INSERT INTO exercises VALUES (?,?,0)').run('synthetic-exercise', JSON.stringify({ id: 'synthetic-exercise', name: 'Synthetic', cues: [] }));
    let count = policy.registrations();
    const check = (kind: 'plan' | 'session', id: string) => {
      assert.equal(policy.registrations(), ++count);
      const last = policy.requests.at(-1)!;
      assert.equal(last.operation, 'invalidate');
      if (last.operation !== 'invalidate') assert.fail('Expected originating invalidation');
      assert.deepEqual(last.sources, [{ kind, id }]);
    };
    const planInput = { name: 'Manual', minutes: 30, items: [{ id: 'item', exerciseId: 'synthetic-exercise', setTarget: 1, repMin: 4, repMax: 8, targetKg: 10 }] };
    const plan = await f.request('/v1/plans', user.token, planInput, 'plan'); assert.equal(plan.status, 201); check('plan', plan.body.id);
    assert.equal((await f.request('/v1/plans', user.token, planInput, 'plan')).status, 201); assert.equal(policy.registrations(), count);
    assert.equal((await f.request(`/v1/plans/${plan.body.id}`, user.token, { expectedRevision: 1, name: 'Edited' }, 'edit-plan', 'PATCH')).status, 200);
    check('plan', plan.body.id);
    const session = await f.request('/v1/workout-sessions', user.token, { planId: plan.body.id, expectedPlanRevision: 2 }, 'session');
    assert.equal(session.status, 201); check('session', session.body.id);
    const sessionPath = `/v1/workout-sessions/${session.body.id}`;
    const set = await f.request(`${sessionPath}/sets`, user.token, { occurrenceId: session.body.occurrences[0].id,
      expectedRevision: 1, setNumber: 1, reps: 5, weightKg: 10, status: 'confirmed' }, 'set');
    assert.equal(set.status, 201); check('session', session.body.id);
    const setPath = `${sessionPath}/sets/${set.body.set.id}`;
    assert.equal((await f.request(setPath, user.token, { expectedRevision: 1, reps: 6, weightKg: 10, status: 'confirmed' }, 'set-edit', 'PATCH')).status, 200);
    check('session', session.body.id);
    assert.equal((await f.request(`${setPath}/void`, user.token, { expectedRevision: 2 }, 'set-void')).status, 200); check('session', session.body.id);
    assert.equal((await f.request(`${sessionPath}/complete`, user.token, { expectedRevision: 4 }, 'complete-session')).status, 200); check('session', session.body.id);
    assert.equal((await f.request(`/v1/plans/${plan.body.id}/archive`, user.token, { expectedRevision: 2 }, 'archive')).status, 200); check('plan', plan.body.id);
  }, true, config => ({ ...config, sourceAccountModules: trainingSelector, sourceTraining: policy.port }));
});

test('current goal edits invalidate retained and withdrawn feedback without rewriting historical bindings', async () => {
  for (const withdrawn of [false, true]) {
    const policy = trainingPolicy();
    await fixture(async f => {
      const user = await f.signup('one'); retainedFeedback(f.server, user.actor, withdrawn);
      const before = f.server.db.prepare('SELECT * FROM feedback_events ORDER BY sequence').all(), count = policy.registrations();
      assert.equal((await f.request('/v1/me/profile', user.token, { expectedRevision: 0, goals: ['New current goal'] }, 'goal', 'PATCH')).status, 200);
      assert.equal(policy.registrations(), count + 1);
      const current = f.server.sourceAccountModules!.trainingFeedback!.read(user.actor);
      assert.equal(current.analysis.profileRevision, 1); assert.equal(current.result.sources[0]!.state, 'changed');
      assert.equal(current.result.sources[0]!.binding!.witness.profileRevision, 0);
      assert.deepEqual(f.server.db.prepare('SELECT * FROM feedback_events ORDER BY sequence').all(), before);
    }, true, config => ({ ...config, sourceAccountModules: trainingSelector, sourceTraining: policy.port }));
  }
});

test('retention registration and original-currentness failure roll back documents TRAIN projection and command receipts', async () => {
  for (const failure of ['retention', 'registration', 'session', 'epoch', 'drift'] as const) {
    const policy = trainingPolicy();
    await fixture(async f => {
      const user = await f.signup('one'); retainedFeedback(f.server, user.actor);
      const db = f.server.db;
      const snapshot = () => ['documents', 'document_revisions', 'feedback_state', 'feedback_events', 'feedback_projections', 'command_receipts', 'session', 'account_lifecycle']
        .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]);
      const before = snapshot();
      if (failure === 'retention') policy.deny();
      else policy.onRegistration(actor => {
        if (failure === 'registration') throw new Error('Synthetic registration rejection');
        if (failure === 'session') db.prepare('DELETE FROM session WHERE id=?').run(actor.sessionId);
        if (failure === 'epoch') db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(actor.accountId);
        if (failure === 'drift') f.server.domain.patchDocument(actor.accountId, 'profile', { expectedRevision: 0, goals: ['Callback drift'] });
      });
      const result = await f.request('/v1/me/preferences', user.token, { expectedRevision: 0, equipment: ['Changed'] }, `denied-${failure}`, 'PATCH');
      assert.equal(result.status, { retention: 503, registration: 500, session: 401, epoch: 403, drift: 409 }[failure]);
      assert.deepEqual(snapshot(), before);
    }, true, config => ({ ...config, sourceAccountModules: trainingSelector, sourceTraining: policy.port }));
  }
});

test('reopened retained state without TRAIN callbacks denies originating writes but retains export disable and unavailable purge', async () => {
  const policy = trainingPolicy();
  await fixture(async f => {
    const user = await f.signup('one'); retainedFeedback(f.server, user.actor);
    const { sourceTraining: _training, ...lifecycleOnly } = f.config;
    const reopened = await f.reopen(lifecycleOnly), c = client(reopened), db = reopened.db;
    const before = db.prepare('SELECT * FROM documents ORDER BY kind').all();
    const denied = await c.request('/v1/me/preferences', user.token, { expectedRevision: 0, equipment: ['Denied'] }, 'denied', 'PATCH');
    assert.equal(denied.status, 503); assert.equal(denied.body.error.code, 'training_feedback_bindings_unavailable');
    assert.deepEqual(db.prepare('SELECT * FROM documents ORDER BY kind').all(), before);
    assert.equal(db.prepare("SELECT 1 FROM command_receipts WHERE key='denied'").get(), undefined);
    const grant = await c.request('/v1/me/account-action-grants', user.token,
      { purpose: 'account_export', password: 'Synthetic-account-modules-password-12345' });
    assert.equal(grant.status, 201);
    const exported = await c.request('/v1/me/account-export', user.token, { grant: grant.body.grant });
    assert.equal(exported.status, 200);
    assert.ok((exported.body.records as { category: string }[]).some(row => row.category === 'trainingFeedback'));
    const requestId = randomUUID(), input = { requestId, statusSecret: 'c'.repeat(43), policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' };
    assert.equal((await c.request('/v1/me/deletion-requests', user.token, input, 'delete')).status, 201);
    const deletionGrant = await c.request('/v1/me/account-action-grants', user.token,
      { purpose: 'account_delete', password: 'Synthetic-account-modules-password-12345' });
    const disabled = await c.request(`/v1/me/deletion-requests/${requestId}/confirm`, user.token,
      { grant: deletionGrant.body.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' });
    assert.equal(disabled.status, 200); assert.equal(disabled.body.disabled, true); assert.equal(disabled.body.complete, false);
    const suppressedTraining = await c.request('/v1/training-feedback', user.token);
    assert.equal(suppressedTraining.status, 401);
    assert.equal(suppressedTraining.headers.get('cache-control'), 'no-store');
    db.transaction(() => {
      for (const adapter of reopened.lifecycle!.adapters.filter(value => ['progressComparison', 'trainingFeedback'].includes(value.category))) {
        assert.equal(adapter.verifySuppressed(user.actor.accountId, 1).status, 'complete');
        assert.equal(adapter.purge(requestId, user.actor.accountId).status, 'unavailable');
      }
    }).immediate();
    assert.equal((db.prepare('SELECT count(*) n FROM feedback_events').get() as { n: number }).n, 2);
  }, true, config => ({ ...config, sourceAccountModules: trainingSelector, sourceTraining: policy.port, publicStagedLifecycleEnabled: true }));
});

test('TRAIN namespace authenticates before consuming bodies and does not capture similarly prefixed paths', () => fixture(async f => {
  for (const path of ['/v1/training-feedback', '/v1/training-feedback/', '/v1/training-feedback/witness', '/v1/training-feedback/events']) {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.close(); } }, { highWaterMark: 0 });
    try {
      const response = await f.server.handleRequest(new Request(origin + path, { method: 'POST', body: stream, duplex: 'half',
        headers: { origin, 'content-type': 'application/json', 'content-length': '65537' } } as RequestInit & { duplex: 'half' }), '192.0.2.35');
      assert.equal(response.status, 401); assert.equal(pulls, 0);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'unauthenticated');
    } finally { await stream.cancel(); }
  }
  const prefixed = await f.server.handleRequest(new Request(origin + '/v1/training-feedback-other/events', {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '65537' }, body: '{}',
  }), '192.0.2.35');
  assert.equal(prefixed.status, 413); await prefixed.text();
  assert.equal((f.server.db.prepare('SELECT count(*) n FROM form_accounts').get() as { n: number }).n, 0);
}, true, config => ({ ...config, sourceAccountModules: trainingSelector })));

test('TRAIN missing account mapping denies without initialization and missing callbacks stay unavailable', () => fixture(async f => {
  const signup = await f.request('/api/auth/sign-up/email', undefined,
    { name: 'One', email: 'one@synthetic.invalid', password: 'Synthetic-account-modules-password-12345' });
  assert.equal(signup.status, 200); const token = signup.headers.get('set-auth-token'); assert.ok(token);
  for (const path of ['/v1/training-feedback', '/v1/training-feedback/', '/v1/training-feedback/witness', '/v1/training-feedback/events']) {
    const response = await f.request(path, token, path.endsWith('witness') || path.endsWith('events') ? {} : undefined);
    assert.equal(response.status, 403); assert.equal(response.body.error.code, 'account_not_initialized');
  }
  assert.equal((f.server.db.prepare('SELECT count(*) n FROM form_accounts').get() as { n: number }).n, 0);
  assert.equal((await f.request('/v1/me', token)).status, 200);
  const unavailable = await f.request('/v1/training-feedback', token); assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, 'training_feedback_unavailable'); assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.close(); } }, { highWaterMark: 0 });
  try {
    const response = await f.server.handleRequest(new Request(origin + '/v1/training-feedback/events', { method: 'POST', body: stream, duplex: 'half',
      headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' } } as RequestInit & { duplex: 'half' }), '192.0.2.35');
    assert.equal(response.status, 503); assert.equal(pulls, 0); await response.text();
  } finally { await stream.cancel(); }
  for (const table of ['feedback_state', 'feedback_events', 'feedback_receipts', 'feedback_keys'])
    assert.equal((f.server.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
}, true, config => ({ ...config, sourceAccountModules: trainingSelector })));

test('signed TRAIN routes retain manual session feedback and replay original receipts with fresh corrected source state', async () => {
  const policy = trainingPolicy();
  await fixture(async f => {
    const one = await f.signup('one'), two = await f.signup('two');
    f.server.db.prepare('INSERT INTO exercises VALUES (?,?,0)').run('training-exercise', JSON.stringify({ id: 'training-exercise', name: 'Synthetic', cues: [] }));
    const plan = await f.request('/v1/plans', one.token, { name: 'Manual', minutes: 30,
      items: [{ id: 'item', exerciseId: 'training-exercise', setTarget: 1, repMin: 4, repMax: 8, targetKg: 10 }] }, 'training-plan');
    assert.equal(plan.status, 201);
    const session = await f.request('/v1/workout-sessions', one.token, { planId: plan.body.id, expectedPlanRevision: 1 }, 'training-session');
    assert.equal(session.status, 201);
    const sessionPath = `/v1/workout-sessions/${session.body.id}`;
    const performed = await f.request(`${sessionPath}/sets`, one.token, { occurrenceId: session.body.occurrences[0].id,
      expectedRevision: 1, setNumber: 1, reps: 5, weightKg: 10, status: 'confirmed' }, 'training-set');
    assert.equal(performed.status, 201);
    const current = await f.request('/v1/training-feedback', one.token); assert.equal(current.status, 200);
    const scope = { kind: 'session', contextId: current.body.analysis.contextId, sessionId: session.body.id, planId: plan.body.id };
    const selection = { sessionId: session.body.id, occurrenceId: session.body.occurrences[0].id };
    const witnessed = await f.request('/v1/training-feedback/witness', one.token, { scope, selection });
    assert.equal(witnessed.status, 200); assert.equal(witnessed.body.result.sessionSource.source.accountId, one.actor.accountId);
    assert.equal(witnessed.body.result.sessionSource.source.revision, 2);
    assert.deepEqual(witnessed.body.result.sessionSource.planSnapshot, { planId: plan.body.id, planRevision: 1 });
    const record = { expectedLedgerRevision: current.body.result.ledgerRevision, selection, expectedWitness: witnessed.body.result,
      event: { eventId: 'http-record', recordId: 'http-feedback', expectedRevision: 0, kind: 'record', content: {
        scope, sourceRefs: [{ sourceId: 'self-report', revision: '1', locator: 'manual-session', qualification: 'User report only' }],
        qualifications: ['No prescription authority'], payload: { kind: 'feedback', signals: [
          { dimension: 'rir', state: 'reported', value: 0, unit: null, scale: null },
          { dimension: 'soreness', state: 'missing', reason: 'not-reported' }] } } } };
    const recorded = await f.request('/v1/training-feedback/events', one.token, record, 'http-record');
    assert.equal(recorded.status, 200); assert.equal(recorded.body.result.receipt.outcome, 'changed');
    const confirm = { ...record, expectedLedgerRevision: recorded.body.result.current.ledgerRevision,
      event: { eventId: 'http-confirm', recordId: 'http-feedback', expectedRevision: 1, kind: 'confirm' } };
    const confirmed = await f.request('/v1/training-feedback/events', one.token, confirm, 'http-confirm');
    assert.equal(confirmed.status, 200); assert.equal(confirmed.body.result.current.records[0].confirmed, true);
    assert.deepEqual(confirmed.body.result.current.derivations, []);
    const read = await f.request('/v1/training-feedback', one.token); assert.equal(read.status, 200);
    assert.deepEqual(read.body.result.records, confirmed.body.result.current.records);
    const other = await f.request('/v1/training-feedback', two.token); assert.equal(other.status, 200);
    assert.deepEqual(other.body.result.records, []);
    const foreignSession = await f.request('/v1/training-feedback/witness', two.token,
      { scope: { ...scope, contextId: other.body.analysis.contextId }, selection });
    assert.equal(foreignSession.status, 404);
    const actorInjection = await f.request('/v1/training-feedback/events', one.token,
      { ...record, event: { ...record.event, accountId: two.actor.accountId } }, 'injected-actor');
    assert.equal(actorInjection.status, 422);
    const before = f.server.db.prepare('SELECT * FROM feedback_events ORDER BY account_id,sequence').all();
    const correction = await f.request(`${sessionPath}/sets/${performed.body.set.id}`, one.token,
      { expectedRevision: 1, reps: 6, weightKg: 10, status: 'confirmed' }, 'http-correct-work', 'PATCH');
    assert.equal(correction.status, 200);
    const profile = await f.request('/v1/me/profile', one.token, { expectedRevision: 0, goals: ['Corrected current goal'] }, 'http-correct-goal', 'PATCH');
    assert.equal(profile.status, 200);
    const replayed = await f.request('/v1/training-feedback/events', one.token, confirm, 'http-confirm');
    assert.equal(replayed.status, 200); assert.equal(replayed.body.result.replayed, true);
    assert.deepEqual(replayed.body.result.receipt, confirmed.body.result.receipt);
    assert.deepEqual(Object.keys(replayed.body.result.receipt).sort(),
      ['acceptedLedgerRevision', 'cause', 'eventId', 'outcome', 'reason', 'recordId', 'revision']);
    assert.equal(replayed.body.analysis.profileRevision, 1);
    assert.ok(replayed.body.result.current.projectionRevision > confirmed.body.result.current.projectionRevision);
    assert.equal(replayed.body.result.current.sources[0].state, 'changed');
    assert.equal(replayed.body.result.current.sources[0].binding.witness.profileRevision, 0);
    assert.equal(replayed.body.result.current.sources[0].binding.witness.sessionSource.source.revision, 2);
    assert.deepEqual(replayed.body.result.current.derivations, []);
    assert.deepEqual(f.server.db.prepare('SELECT * FROM feedback_events ORDER BY account_id,sequence').all(), before);
    const fresh = await f.request('/v1/training-feedback/witness', one.token, { scope, selection });
    assert.equal(fresh.status, 200); assert.equal(fresh.body.result.sessionSource.source.revision, 3);
    assert.equal(fresh.body.result.profileRevision, 1);
  }, true, config => ({ ...config, sourceAccountModules: trainingSelector, sourceTraining: policy.port }));
});

test('signed TRAIN streamed mutations reject revoked original sessions and changed epochs before persistence', async () => {
  const policy = trainingPolicy();
  await fixture(async f => {
    const users = [await f.signup('one'), await f.signup('two')];
    for (const [index, user] of users.entries()) {
      const current = await f.request('/v1/training-feedback', user.token);
      const scope = { kind: 'context', contextId: current.body.analysis.contextId };
      const witness = await f.request('/v1/training-feedback/witness', user.token, { scope, selection: null });
      const input = { expectedLedgerRevision: 0, selection: null, expectedWitness: witness.body.result,
        event: { eventId: 'paused-event', recordId: 'paused-record', expectedRevision: 0, kind: 'record', content: {
          scope, sourceRefs: [{ sourceId: 'self-report', revision: '1', locator: 'synthetic', qualification: 'User report only' }],
          qualifications: ['Synthetic'], payload: { kind: 'edit', field: 'note', before: null, after: 'User change' } } } };
      let controller!: ReadableStreamDefaultController<Uint8Array>, admitted!: () => void;
      const admission = new Promise<void>(resolve => { admitted = resolve; });
      const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { admitted(); } }, { highWaterMark: 0 });
      const result = Promise.resolve(f.server.handleRequest(new Request(origin + '/v1/training-feedback/events', {
        method: 'POST', body: stream, duplex: 'half', headers: { origin, authorization: `Bearer ${user.token}`,
          'content-type': 'application/json', 'idempotency-key': 'paused-event' },
      } as RequestInit & { duplex: 'half' }), '192.0.2.35'));
      void result.catch(() => {});
      try {
        await Promise.race([admission, result.then(response => { throw new Error(`Request finished before body admission: ${response.status}`); })]);
        assert.equal(f.server.db.inTransaction, false);
        if (index === 0) f.server.db.prepare('DELETE FROM session WHERE id=?').run(user.actor.sessionId);
        else f.server.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(user.actor.accountId);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input))); controller.close();
        const response = await result; assert.equal(response.status, index === 0 ? 401 : 403);
        assert.equal((await response.json() as { error: { code: string } }).error.code, index === 0 ? 'account_session_invalid' : 'account_epoch_changed');
        assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(stream.locked, false);
      } finally { try { controller.error(new Error('Synthetic request cleanup')); } catch {} await result.catch(() => {}); }
    }
    for (const table of ['feedback_events', 'feedback_receipts', 'feedback_keys'])
      assert.equal((f.server.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
  }, true, config => ({ ...config, sourceAccountModules: trainingSelector, sourceTraining: policy.port }));
});

test('signed TRAIN mutation retention and currentness failures roll back canonical ledger writes', async () => {
  for (const failure of ['retention', 'session', 'epoch', 'drift'] as const) {
    const policy = trainingPolicy();
    await fixture(async f => {
      const user = await f.signup('one');
      const current = await f.request('/v1/training-feedback', user.token);
      const scope = { kind: 'context', contextId: current.body.analysis.contextId };
      const witness = await f.request('/v1/training-feedback/witness', user.token, { scope, selection: null });
      const input = { expectedLedgerRevision: 0, selection: null, expectedWitness: witness.body.result,
        event: { eventId: 'rollback-event', recordId: 'rollback-record', expectedRevision: 0, kind: 'record', content: {
          scope, sourceRefs: [{ sourceId: 'self-report', revision: '1', locator: 'synthetic', qualification: 'User report only' }],
          qualifications: ['Synthetic'], payload: { kind: 'edit', field: 'note', before: null, after: 'User change' } } } };
      const snapshot = () => ['documents', 'document_revisions', 'feedback_state', 'feedback_events', 'feedback_receipts', 'feedback_keys',
        'feedback_projections', 'session', 'account_lifecycle'].map(table => [table, f.server.db.prepare(`SELECT * FROM ${table}`).all()]);
      const before = snapshot();
      if (failure === 'retention') policy.deny();
      else policy.onRegistration(actor => {
        if (failure === 'session') f.server.db.prepare('DELETE FROM session WHERE id=?').run(actor.sessionId);
        if (failure === 'epoch') f.server.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(actor.accountId);
        if (failure === 'drift') f.server.domain.patchDocument(actor.accountId, 'profile', { expectedRevision: 0, goals: ['Callback drift'] });
      });
      const response = await f.request('/v1/training-feedback/events', user.token, input, 'rollback-event');
      assert.equal(response.status, { retention: 503, session: 401, epoch: 403, drift: 409 }[failure]);
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(snapshot(), before);
    }, true, config => ({ ...config, sourceAccountModules: trainingSelector, sourceTraining: policy.port }));
  }
});

test('signed TRAIN keeps strict media JSON byte and origin bounds with stream cleanup and no receipts', async () => {
  const policy = trainingPolicy();
  await fixture(async f => {
    const user = await f.signup('one');
    for (const [bytes, media, status, code] of [
      [new TextEncoder().encode('{}'), 'text/plain', 415, 'json_required'],
      [new Uint8Array([0xff]), 'application/json', 400, 'invalid_json'],
      [new TextEncoder().encode('{'), 'application/json', 400, 'invalid_json'],
      [new Uint8Array(65537).fill(32), 'application/json', 413, 'body_too_large'],
    ] as const) {
      let cancelled = 0, sent = false;
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (sent) controller.close(); else { sent = true; controller.enqueue(bytes); } },
        cancel() { cancelled++; } }, { highWaterMark: 0 });
      try {
        const response = await f.server.handleRequest(new Request(origin + '/v1/training-feedback/events', { method: 'POST', body: stream, duplex: 'half',
          headers: { origin, authorization: `Bearer ${user.token}`, 'content-type': media, 'idempotency-key': 'invalid-stream' },
        } as RequestInit & { duplex: 'half' }), '192.0.2.35');
        assert.equal(response.status, status); assert.equal((await response.json() as { error: { code: string } }).error.code, code);
        assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(stream.locked, false); if (status === 415 || status === 413) assert.equal(cancelled, 1);
      } finally { if (!stream.locked) await stream.cancel(); }
    }
    const wrongOrigin = await f.server.handleRequest(new Request(origin + '/v1/training-feedback/events', { method: 'POST', body: '{}',
      headers: { origin: 'https://foreign.invalid', authorization: `Bearer ${user.token}`, 'content-type': 'application/json', 'idempotency-key': 'foreign-origin' } }), '192.0.2.35');
    assert.equal(wrongOrigin.status, 403); assert.equal((await wrongOrigin.json() as { error: { code: string } }).error.code, 'origin_not_allowed');
    assert.equal((await f.request('/v1/training-feedback?accountId=foreign', user.token)).status, 422);
    for (const table of ['feedback_events', 'feedback_receipts', 'feedback_keys'])
      assert.equal((f.server.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
  }, true, config => ({ ...config, sourceAccountModules: trainingSelector, sourceTraining: policy.port }));
});
