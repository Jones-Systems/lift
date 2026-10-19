import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { DomainError } from '../../../src/errors.js';
import { createServer, type FormServer, type ServerConfig } from '../../../src/server.js';
import type { Domain } from '../../../src/domain.js';
import { selectAccountModuleMigrations } from '../../../src/integration/account-modules/migrations.js';
import type { SourcePrescriptionPlanFields, SourceSetCreate } from '../../../src/schemas.js';
import type { PreparedSourceFirstPlan } from '../../../src/integration/first-plan/contracts.js';
import type { FirstPlanReceipt } from '../../../src/integration/first-plan/contracts.js';
import type { RuntimeOwner } from '../../../src/runtime-modules/admission.js';
import { baseMigrations, install, moduleMigrations, requestConfiguration, suppressionLedger } from '../account-modules/fixture.js';
import { candidate, prepared } from './fixture.js';

const origin = 'http://127.0.0.1:47839';
const secret = 'synthetic-first-plan-secret-over-32-characters';
function preparedSource(): PreparedSourceFirstPlan {
  const source = candidate.source;
  const plan: SourcePrescriptionPlanFields = { schema: 'form.source-prescription-plan/v1', name: 'Synthetic source HTTP fixture',
    origin: { kind: 'form-adaptation', id: 'synthetic-http', revision: 'v1' }, duration: { kind: 'estimated-range', minMinutes: 15, maxMinutes: 25 },
    items: Array.from({ length: 4 }, (_, i) => ({ id: `source-item-${i}`, native: { exercise_id: `native-${i}`, role: 'synthetic role', movement_pattern: 'synthetic pattern',
      sets: 2, rest_seconds: 60, ...(i < 3 ? { rep_range: [8, 12] as [number, number] } : {}), ...(i === 0 ? { notes: [' retained ', ''] } : {}) },
      registeredDomain: { exerciseId: `source-domain-${i}`, variantId: `synthetic:variant-${i}`,
        identity: { repository: 'synthetic/repository', revision: 'v1', path: 'synthetic.json', sha256: 'a'.repeat(64), nativeId: `native-${i}` },
        registration: { id: 'synthetic-registration', revision: 'v1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
      load: { kind: 'unspecified', basis: 'unknown' } })) };
  return { schema: 'form.source-first-plan-preparation/v1', candidates: [{ id: 'source-candidate', qualification: 'qualified', source, plan }], assertCurrent() {}, ports: {
    qualifyCatalog(input) { return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified', source,
      items: input.candidate.plan.items.map((item, i) => ({ itemId: item.id, exerciseId: item.registeredDomain.exerciseId,
        variantId: item.registeredDomain.variantId, prescriptionKey: input.prescriptions[i]!.prescriptionKey, retired: false, source })) }; },
    evaluateConstraints(input) { return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'eligible', source,
      reasons: [], rules: [{ ruleId: 'synthetic', outcome: 'satisfied', source, reasons: [] }] }; },
  } };
}
async function fixture(run: (value: {
  server: () => FormServer;
  request: <T = unknown>(path: string, token?: string, body?: unknown, key?: string, method?: string) => Promise<{ status: number; body: T; headers: Headers }>;
  signup: (name: string) => Promise<string>;
  reopen: () => Promise<void>;
  calls: () => number;
}) => Promise<void>, enabled: boolean | 'source' = true, training?: ServerConfig['sourceTraining']) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'first-plan-'));
  let server: FormServer | undefined;
  const cleanup = () => { try { if (server?.db.open) server.close(); } finally { rmSync(root, { recursive: true, force: true }); } };
  const interrupt = () => { cleanup(); process.exit(130); }, terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const dbPath = join(root, 'synthetic.sqlite'), seed = new Database(dbPath);
    try { install(seed, enabled === 'source' ? selectAccountModuleMigrations({ mode: 'source-only', modules: 'usage-bug-training-feedback-and-source-prescription' }, baseMigrations) : baseMigrations); } finally { seed.close(); }
    let calls = 0;
    const config: ServerConfig = { dbPath, baseURL: origin, secret,
      registration: { mode: 'allowlist', emails: ['one@synthetic.invalid', 'two@synthetic.invalid'] },
      lifecycle: { ledger: suppressionLedger().ledger }, moduleMigrations, sourceRequestFactories: requestConfiguration,
      ...(enabled ? { sourceFirstPlan: async () => { calls++; assert.equal(server!.db.inTransaction, false); return enabled === 'source' ? preparedSource() : prepared(); } } : {}),
      ...(training ? { sourceTraining: training } : {}),
      ...(enabled === 'source' ? { sourceAccountModules: { mode: 'source-only' as const, modules: 'usage-bug-training-feedback-and-source-prescription' as const } } : {}),
    };
    server = await createServer(config);
    for (const item of candidate.plan.items) server.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)')
      .run(item.exerciseId, JSON.stringify({ id: item.exerciseId, name: 'Synthetic test exercise', cues: [], requiredConstraints: [] }));
    if (enabled === 'source') for (const item of preparedSource().candidates[0]!.plan.items) server.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)')
      .run(item.registeredDomain.exerciseId, JSON.stringify({ id: item.registeredDomain.exerciseId, name: 'Synthetic registered source', cues: [], requiredConstraints: [] }));
    const request = async <T = unknown>(path: string, token?: string, body?: unknown, key = 'key', method = body === undefined ? 'GET' : 'POST') => {
      const response = await server!.handleRequest(new Request(origin + path, { method,
        headers: { origin, 'content-type': 'application/json', 'idempotency-key': key, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), '192.0.2.39');
      return { status: response.status, body: await response.json() as T, headers: response.headers };
    };
    const signup = async (name: string) => {
      const result = await request('/api/auth/sign-up/email', undefined, { name, email: `${name}@synthetic.invalid`, password: 'Synthetic-first-plan-password-12345' });
      assert.equal(result.status, 200); const token = result.headers.get('set-auth-token'); assert.ok(token);
      assert.equal((await request('/v1/me', token)).status, 200); return token;
    };
    await run({ server: () => server!, request, signup, calls: () => calls,
      reopen: async () => { server!.close(); const { sourceFirstPlan: _source, ...withoutPreparation } = config; server = await createServer(withoutPreparation); } });
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); cleanup(); }
}

test('first-plan endpoint authenticates, rejects ownership injection and is unavailable without source binding', () => fixture(async f => {
  const input = { profileRevision: 0, preferencesRevision: 0 };
  assert.equal((await f.request('/v1/plans/first', undefined, input)).status, 401);
  const token = await f.signup('one');
  assert.equal((await f.request('/v1/plans/first', token, { ...input, accountId: 'other' })).status, 422);
  const result = await f.request<{ error: { code: string } }>('/v1/plans/first', token, input);
  assert.equal(result.status, 501); assert.equal(result.body.error.code, 'first_plan_unavailable');
  assert.equal(f.calls(), 0);
}, false));

test('confirmed onboarding generates durable plan, replays after reopen, and completes every occurrence into account-owned history', () => fixture(async f => {
  const token = await f.signup('one'), other = await f.signup('two');
  const draft = await f.request<{ revision: number }>('/v1/me/onboarding', token, { expectedRevision: 0, step: 'review',
    answers: { trainingContext: 'Synthetic confirmed user context', injuryHistory: '', trainingBackground: 'regular', goals: ['Synthetic goal'] } }, 'draft', 'PATCH');
  assert.equal(draft.status, 200);
  assert.equal((await f.request('/v1/me/onboarding/complete', token, { expectedRevision: draft.body.revision }, 'complete-onboarding')).status, 200);
  const stale = await f.request<{ error: { code: string } }>('/v1/plans/first', token, { profileRevision: 0, preferencesRevision: 0 }, 'stale');
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'first_plan_confirmation_stale');
  const confirmation = { profileRevision: 1, preferencesRevision: 1 };
  const generated = await f.request<FirstPlanReceipt>('/v1/plans/first', token, confirmation, 'first');
  assert.equal(generated.status, 201); assert.equal(f.calls(), 1);
  assert.equal((await f.request(`/v1/plans/${generated.body.plan.id}`, other)).status, 404);
  await f.reopen();
  const replay = await f.request<FirstPlanReceipt>('/v1/plans/first', token, confirmation, 'first');
  assert.equal(replay.status, 201); assert.deepEqual(replay.body, generated.body); assert.equal(f.calls(), 1);
  type Session = ReturnType<Domain['session']>;
  const started = await f.request<Session>('/v1/workout-sessions', token,
    { planId: generated.body.plan.id, expectedPlanRevision: generated.body.plan.revision }, 'start');
  assert.equal(started.status, 201); let session = started.body;
  assert.deepEqual(session.planSnapshot.items, candidate.plan.items);
  for (const occurrence of session.occurrences) {
    const logged = await f.request<{ sessionRevision: number }>(`/v1/workout-sessions/${session.id}/sets`, token,
      { occurrenceId: occurrence.id, setNumber: 1, reps: 5, weightKg: 2, status: 'confirmed', expectedRevision: session.revision }, `set-${occurrence.id}`);
    assert.equal(logged.status, 201); session = { ...session, revision: logged.body.sessionRevision };
  }
  const completed = await f.request<Session>(`/v1/workout-sessions/${session.id}/complete`, token, { expectedRevision: session.revision }, 'finish');
  assert.equal(completed.status, 200); assert.equal(completed.body.status, 'completed'); assert.equal(completed.body.sets.length, 2);
  assert.ok(completed.body.sets.every(set => set.status === 'confirmed'));
  const history = await f.request<{ items: Session[] }>('/v1/history', token);
  assert.equal(history.body.items[0]?.id, session.id);
  assert.equal((await f.request<{ items: Session[] }>('/v1/history', other)).body.items.length, 0);
}));

test('first-plan source injection requires lifecycle authority and cannot mix with RuntimeOwner', async () => {
  const base = { dbPath: 'unused-first-plan.sqlite', baseURL: origin, secret, sourceFirstPlan: async () => prepared() };
  await assert.rejects(createServer(base), /first_plan_lifecycle_bindings_required/);
  const runtimeOwner = { close() {} } as unknown as RuntimeOwner;
  await assert.rejects(createServer({ ...base, runtimeOwner }), /Runtime ownership cannot mix source injections/);
});


test('explicit prefix19 serves full source plans and reported sets on unchanged URLs, with receipt replay after actual reopen', () => fixture(async f => {
  const token = await f.signup('one'), other = await f.signup('two'), confirmation = { profileRevision: 0, preferencesRevision: 0 };
  const created = await f.request<FirstPlanReceipt>('/v1/plans/first', token, confirmation, 'source-first');
  assert.equal(created.status, 201); assert.ok('schema' in created.body.plan);
  assert.deepEqual(created.body.plan.items, preparedSource().candidates[0]!.plan.items);
  assert.equal((await f.request('/v1/plans', token, preparedSource().candidates[0]!.plan, 'manual-source')).status, 422);
  assert.equal((await f.request(`/v1/plans/${created.body.plan.id}`, token, { expectedRevision: 1, name: 'Lossy' }, 'edit', 'PATCH')).status, 409);
  type Session = ReturnType<Domain['session']>;
  const started = await f.request<Session>('/v1/workout-sessions', token, { planId: created.body.plan.id, expectedPlanRevision: 1 }, 'start-source');
  assert.equal(started.status, 201); assert.equal(started.body.occurrences.length, 4);
  let revision = 1;
  for (const [index, occurrence] of started.body.occurrences.entries()) for (const setNumber of [1, 2]) {
    const input: SourceSetCreate = { schema: 'form.source-performed-set/v1', occurrenceId: occurrence.id, setNumber,
      expectedRevision: revision, status: 'confirmed', performance: index < 3
        ? { schema: 'form.source-performance/v1', kind: 'repetitions', reps: 5, load: { kind: 'unspecified', basis: 'unknown' } }
        : { schema: 'form.source-performance/v1', kind: 'controlled-practice', load: { kind: 'unspecified', basis: 'unknown' } } };
    const path = `/v1/workout-sessions/${started.body.id}/sets`, key = `source-set-${index}-${setNumber}`;
    const logged = await f.request<ReturnType<Domain['createSet']>>(path, token, input, key);
    assert.equal(logged.status, 201); assert.ok('schema' in logged.body.set); assert.equal('reps' in logged.body.set, false);
    assert.deepEqual(await f.request(path, token, input, key).then(x => x.body), logged.body);
    assert.equal((await f.request(path, token, { ...input, reps: 5 }, 'mixed')).status, 422);
    revision = logged.body.sessionRevision;
  }
  const completed = await f.request<Session>(`/v1/workout-sessions/${started.body.id}/complete`, token, { expectedRevision: revision }, 'complete-source');
  assert.equal(completed.status, 200); assert.equal(completed.body.sets.length, 8);
  assert.equal((await f.request(`/v1/workout-sessions/${started.body.id}`, other)).status, 404);
  await f.reopen();
  assert.deepEqual((await f.request<FirstPlanReceipt>('/v1/plans/first', token, confirmation, 'source-first')).body, created.body);
  assert.deepEqual((await f.request<Session>(`/v1/workout-sessions/${started.body.id}`, token)).body, completed.body);
  assert.equal(f.calls(), 1);
  assert.equal((f.server().db.prepare('SELECT count(*) n FROM plans').get() as { n: number }).n, 1);
  assert.equal(f.server().sourceAccountModules?.trainingFeedback, undefined);
}, 'source'));


test('prefix19 admits explicit TRAIN bindings but does not grant registration or independent retention', async () => {
  let registrations = 0, retentions = 0;
  await fixture(async f => {
    const token = await f.signup('one');
    assert.ok(f.server().sourceAccountModules?.trainingFeedback);
    const denied = await f.request<{ error: { code: string } }>('/v1/training-feedback', token);
    assert.equal(denied.status, 503); assert.equal(denied.body.error.code, 'training_feedback_retention_unavailable');
    assert.equal(retentions, 1); assert.equal(registrations, 0);
  }, 'source', { registrationWithinWrite() { registrations++; throw new DomainError(503, 'synthetic_registration_unavailable'); },
    retentionAllowedWithinWrite() { retentions++; return false; } });
});
