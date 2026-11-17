import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, Server as HttpServer } from 'node:http';
import Database from 'better-sqlite3';
import { createServer, type ServerConfig } from '../src/server.js';
import { backupAndVerify, integrity, migrate, migrations, command } from '../src/storage.js';
import { Domain } from '../src/domain.js';
import { ApplePurchaseService } from '../src/purchases/service.js';
import type { VerifiedAppleTransaction } from '../src/purchases/types.js';
import { validateWav } from '../src/transcription.js';
import { browserOriginsConfiguration, socialProviderConfiguration } from '../src/configuration.js';
import { bodyOperations } from '../src/body/index.js';
import { planFields, profilePatch } from '../src/schemas.js';

const scratchParent = resolve('.scratch');
const secret = 'synthetic-only-form-auth-secret-longer-than-32-chars';
const emails = ['first@synthetic.invalid', 'second@synthetic.invalid'];
const password = 'synthetic-password-only-123456';
const cleanup = new Set<() => void | Promise<void>>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  const results = await Promise.allSettled([...cleanup].map(dispose => Promise.resolve().then(dispose)));
  for (const result of results) if (result.status === 'rejected') console.error('Fixture cleanup failed', result.reason);
  process.exit(signal === 'SIGINT' ? 130 : 143);
});

async function fixture(run: (f: {
  backend: Awaited<ReturnType<typeof createServer>>;
  root: string; dbPath: string; base: string;
  restart: (registration?: ServerConfig['registration']) => Promise<void>;
  request: (path: string, token?: string, method?: string, input?: unknown, key?: string, extra?: Record<string, string>) => Promise<{ status: number; headers: Headers; body: any }>;
}) => Promise<void>, overrides: Pick<ServerConfig, 'grok' | 'phone' | 'applePurchases' | 'trustedOrigins'> = {}): Promise<void> {
  mkdirSync(scratchParent, { recursive: true });
  const root = mkdtempSync(join(scratchParent, 'http-'));
  let backend: Awaited<ReturnType<typeof createServer>> | undefined;
  let listener: ReturnType<typeof serve> | undefined;
  let pendingListening: Promise<void> | undefined;
  let pendingBackend: Promise<Awaited<ReturnType<typeof createServer>>> | undefined;
  let disposing = false;
  let disposal: Promise<void> | undefined;
  const assertActive = () => { if (disposing) throw new Error('HTTP fixture is disposing'); };
  const dispose = (): Promise<void> => {
    disposing = true;
    return disposal ??= (async () => {
      const failures: unknown[] = [];
      await pendingListening?.catch(() => {});
      if (listener) {
        const closingListener = listener;
        const closed = new Promise<void>((resolveClose, rejectClose) => {
          closingListener.close(error => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') rejectClose(error);
            else resolveClose();
          });
        });
        try { if ('closeAllConnections' in closingListener) closingListener.closeAllConnections(); }
        catch (error) { failures.push(error); }
        try { await closed; } catch (error) { failures.push(error); }
      }
      await pendingBackend?.catch(() => {});
      try { if (backend?.db.open) backend.close(); } catch (error) { failures.push(error); }
      try {
        rmSync(root, { recursive: true, force: true });
        assert.equal(existsSync(root), false, 'HTTP scratch is cleanup-owned');
      } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'HTTP fixture cleanup failed');
    })();
  };
  cleanup.add(dispose);
  let failed = false;
  let failure: unknown;
  try {
    const dbPath = join(root, 'durable.sqlite');
    listener = serve({ hostname: '127.0.0.1', port: 0, fetch: (request, env) => backend!.handleRequest(request, env.incoming.socket.remoteAddress ?? 'unknown') });
    const openingListener = listener;
    pendingListening = new Promise<void>((resolveListening, rejectListening) => {
      const release = () => {
        openingListener.off('listening', onListening);
        openingListener.off('error', onError);
        openingListener.off('close', onClose);
      };
      const onListening = () => { release(); resolveListening(); };
      const onError = (error: Error) => { release(); rejectListening(error); };
      const onClose = () => { release(); rejectListening(new Error('HTTP listener closed before readiness')); };
      openingListener.once('error', onError);
      openingListener.once('close', onClose);
      openingListener.once('listening', onListening);
      if (openingListener.listening) onListening();
    });
    await pendingListening;
    assertActive();
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const config: ServerConfig = { dbPath, baseURL: base, secret, registration: { mode: 'allowlist', emails }, promos: [
      { code: 'FAMILY-ZERO', entitlement: 'form_plus', days: 30, maxRedemptions: 10, expiresAt: '2099-01-01T00:00:00.000Z' },
      { code: 'ONE-ZERO', entitlement: 'form_plus', days: 7, maxRedemptions: 1, expiresAt: '2099-01-01T00:00:00.000Z' },
    ], ...overrides };
    const acquireBackend = async (nextConfig: ServerConfig) => {
      assertActive();
      assert.equal(pendingBackend, undefined, 'HTTP backend acquisition must be serial');
      const acquisition = createServer(nextConfig).then(created => { backend = created; return created; });
      pendingBackend = acquisition;
      try { await acquisition; assertActive(); }
      finally { if (pendingBackend === acquisition) pendingBackend = undefined; }
    };
    await acquireBackend(config);
    const f = {
      backend: backend!, root, dbPath, base,
      restart: async (registration: ServerConfig['registration'] = config.registration) => {
        assertActive();
        assert.equal(pendingBackend, undefined, 'HTTP backend acquisition must be serial');
        backend!.close();
        await acquireBackend({ ...config, ...(registration ? { registration } : {}) });
        f.backend = backend!;
      },
      request: async (path: string, token?: string, method = 'GET', input?: unknown, key?: string, extra?: Record<string, string>) => {
        const headers: Record<string, string> = { origin: base, ...extra };
        if (token) headers.authorization = `Bearer ${token}`;
        if (input !== undefined) headers['content-type'] = 'application/json';
        if (key) headers['idempotency-key'] = key;
        const response = await fetch(`${base}${path}`, { method, headers, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
        const text = await response.text();
        const result = text ? JSON.parse(text) : null;
        return { status: response.status, headers: response.headers, body: result };
      },
    };
    await run(f);
  } catch (error) { failed = true; failure = error; }
  finally {
    try { await dispose(); }
    catch (error) {
      if (failed) failure = new AggregateError([failure, error], 'HTTP fixture failed and cleanup also failed', { cause: failure });
      else { failed = true; failure = error; }
    } finally { cleanup.delete(dispose); }
  }
  if (failed) throw failure;
}
type Plan = ReturnType<Domain['plan']>;
type Session = ReturnType<Domain['session']>;
const planBody = {
  name: 'Synthetic full body', minutes: 35,
  items: [
    { id: 'squat-first', exerciseId: 'goblet-squat', setTarget: 3, repMin: 8, repMax: 10, targetKg: 12 },
    { id: 'squat-second', exerciseId: 'goblet-squat', setTarget: 2, repMin: 6, repMax: 8, targetKg: 10 },
    { id: 'row-first', exerciseId: 'supported-row', setTarget: 2, repMin: 8, repMax: 12, targetKg: 8 },
  ],
};

test('backend-schema-bounds: oversized goals reject without per-element issues', () => {
  const goals = Array.from({ length: 30 }, (_, index) => `Goal ${index + 1}`);
  assert.deepEqual(profilePatch.parse({ expectedRevision: 0, goals }), { expectedRevision: 0, goals });

  const oversized = profilePatch.safeParse({ expectedRevision: 0, goals: Array(31).fill(null) });
  assert.equal(oversized.success, false);
  if (!oversized.success) {
    assert.deepEqual(oversized.error.issues.map(({ code, path }) => ({ code, path })), [
      { code: 'too_big', path: ['goals'] },
    ]);
  }

  const invalidAtLimit = profilePatch.safeParse({ expectedRevision: 0, goals: [...goals.slice(0, 29), null] });
  assert.equal(invalidAtLimit.success, false);
  if (!invalidAtLimit.success) {
    assert.deepEqual(invalidAtLimit.error.issues.map(({ code, path }) => ({ code, path })), [
      { code: 'invalid_type', path: ['goals', 29] },
    ]);
  }

  const unknownField = profilePatch.safeParse({ expectedRevision: 0, goals, accountId: 'unexpected-account' });
  assert.equal(unknownField.success, false);
  if (!unknownField.success) assert.equal(unknownField.error.issues[0]!.code, 'unrecognized_keys');

  assert.deepEqual(planFields.parse(planBody), planBody);
  const duplicateItems = planFields.safeParse({ ...planBody, items: [planBody.items[0], planBody.items[0]] });
  assert.equal(duplicateItems.success, false);
  if (!duplicateItems.success) {
    assert.deepEqual(duplicateItems.error.issues.map(({ code, path, message }) => ({ code, path, message })), [
      { code: 'custom', path: ['items'], message: 'Duplicate item ID' },
    ]);
  }
});

test('backend-http-database: real accounts, revisions, snapshots, isolation, receipts and restart', async t => {
  await fixture(async f => {
    const { request } = f;
    let first = '', second = '', rawFirst = '', cookieFirst = '';
    let plan: Plan, session: Session, recordedSetId = '', completedRevision = 0, accountId = '';
    await t.test('private local registration and signed session, exact origin, revocation seam', async () => {
      assert.equal((await request('/v1/me')).status, 401);
      assert.equal((await request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Other', email: 'other@synthetic.invalid', password })).status, 403);
      assert.equal((await request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password, emailVerified: true })).status, 422);
      assert.equal((await request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password }, undefined, { origin: 'https://hostile.invalid' })).status, 403);
      const one = await request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password });
      assert.equal(one.status, 200, JSON.stringify(one.body));
      first = one.headers.get('set-auth-token')!; rawFirst = one.body.token;
      cookieFirst = one.headers.get('set-cookie')!.split(';')[0]!;
      assert.ok(first.includes('.')); assert.ok(rawFirst); assert.notEqual(first, rawFirst);
      assert.ok(one.headers.get('access-control-expose-headers')!.includes('set-auth-token'));
      const two = await request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Second', email: emails[1], password });
      assert.equal(two.status, 200, JSON.stringify(two.body)); second = two.headers.get('set-auth-token')!;
      assert.equal((await request('/v1/me', rawFirst)).status, 401, 'unsigned raw session token cannot authenticate');
      assert.equal((await request('/v1/me', `${first.slice(0, -4)}xxxx`)).status, 401);
      const me = await request('/v1/me', first); assert.equal(me.status, 200); accountId = me.body.accountId;
      assert.notEqual((await request('/v1/me', second)).body.accountId, accountId);
      assert.equal((await request('/api/auth/sign-in/email', undefined, 'POST', { email: emails[0], password: 'incorrect-password-123' })).status, 401);
      const signIn = await request('/api/auth/sign-in/email', undefined, 'POST', { email: emails[0], password });
      assert.equal(signIn.status, 200); assert.ok(signIn.headers.get('set-auth-token'));
      assert.equal((await request('/v1/me/profile', first, 'PATCH', { expectedRevision: 0, name: 'First' }, undefined, { origin: 'https://hostile.invalid' })).status, 403);
      const noOrigin = await fetch(`${f.base}/v1/me/profile`, { method: 'PATCH', headers: { cookie: cookieFirst, 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0, name: 'First' }) });
      assert.equal(noOrigin.status, 403); await noOrigin.text();
      assert.equal((await request('/v1/me/profile', first, 'PATCH', { expectedRevision: 0, accountId, name: 'First' })).status, 422);
    });
    await t.test('profile, preference and resumable onboarding roundtrip with strict bounds', async () => {
      const updated = await request('/v1/me/profile', first, 'PATCH', { expectedRevision: 0, name: 'First private', age: 41, heightCm: 172.5, weightKg: 80.2, injuryHistory: 'Synthetic context' });
      assert.equal(updated.status, 200); assert.equal(updated.body.revision, 1);
      assert.equal((await request('/v1/me/profile', first, 'PATCH', { expectedRevision: 0, name: 'stale' })).body.error.code, 'stale_revision');
      assert.equal((await request('/v1/me/profile', first, 'PATCH', { expectedRevision: 1, weightKg: -2 })).status, 422);
      assert.equal((await request('/v1/me/preferences', first, 'PATCH', { expectedRevision: 0, loadUnit: 'lb', coachVoice: 'direct', sessionMinutes: 20 })).status, 200);
      const draft = await request('/v1/me/onboarding', first, 'PATCH', { expectedRevision: 0, step: 'injuries', answers: { goals: ['Get stronger'], trainingBackground: 'returning' }, preferences: { equipment: ['Dumbbells'] } });
      assert.equal(draft.status, 200); assert.equal(draft.body.status, 'draft');
      const complete = await request('/v1/me/onboarding/complete', first, 'POST', { expectedRevision: 1 }, 'onboarding-one');
      assert.equal(complete.status, 200); assert.equal(complete.body.status, 'completed');
      assert.deepEqual((await request('/v1/me/onboarding/complete', first, 'POST', { expectedRevision: 1 }, 'onboarding-one')).body, complete.body);
      const me = (await request('/v1/me', first)).body;
      assert.equal(me.profile.heightCm, 172.5); assert.deepEqual(me.profile.goals, ['Get stronger']); assert.equal(me.preferences.loadUnit, 'lb');
      assert.deepEqual(me.preferences.equipment, ['Dumbbells']);
      assert.equal((await request('/v1/me/profile', second)).body.injuryHistory, '');
      assert.equal((await request('/v1/me/onboarding', second)).body.status, 'draft');
      const oversize = await request('/v1/me/profile', first, 'PATCH', { expectedRevision: 2, injuryHistory: 'a'.repeat(70000) });
      assert.equal(oversize.status, 413);
    });
    await t.test('catalog provenance, multiple editable plans, duplicate and stale command conflicts', async () => {
      const catalog = (await request('/v1/exercises', first)).body.items;
      assert.equal(catalog.length, 5); assert.equal(catalog[0].provenance.source, 'apps/form/src/variants/a/generatedfixtures.ts');
      assert.deepEqual((await request('/v1/history', first)).body.items, []);
      assert.equal((await request('/v1/stats', first)).body.confirmedSets, 0);
      assert.equal((await request('/v1/plans', first, 'POST', planBody)).status, 400);
      const created = await request('/v1/plans', first, 'POST', planBody, 'plan-one'); assert.equal(created.status, 201); plan = created.body;
      assert.deepEqual((await request('/v1/plans', first, 'POST', planBody, 'plan-one')).body, plan);
      assert.equal((await request('/v1/plans', first, 'POST', { ...planBody, minutes: 20 }, 'plan-one')).body.error.code, 'idempotency_mismatch');
      const another = await request('/v1/plans', first, 'POST', { ...planBody, name: 'Second plan' }, 'plan-two'); assert.equal(another.status, 201);
      assert.equal((await request('/v1/plans', first)).body.items.length, 2);
      const concurrent = await Promise.all([
        request('/v1/plans', first, 'POST', { ...planBody, name: 'Parallel command' }, 'parallel-plan'),
        request('/v1/plans', first, 'POST', { ...planBody, name: 'Parallel command' }, 'parallel-plan'),
      ]);
      assert.deepEqual(concurrent.map(x => x.status), [201, 201]); assert.equal(concurrent[0]!.body.id, concurrent[1]!.body.id);
      assert.equal((await request('/v1/plans', first)).body.items.length, 3);
      assert.equal((await request('/v1/plans', second)).body.items.length, 0);
      const items = plan.items.map((item, index) => index === 0 ? { ...item, repMax: 12, targetKg: 15.5 } : item);
      const patched = await request(`/v1/plans/${plan.id}`, first, 'PATCH', { expectedRevision: 1, items }); assert.equal(patched.status, 200); plan = patched.body;
      assert.equal((await request(`/v1/plans/${plan.id}`, first, 'PATCH', { expectedRevision: 1, minutes: 20 })).body.error.code, 'stale_revision');
      assert.equal((await request(`/v1/plans/${plan.id}`, first, 'PATCH', { expectedRevision: 2, items: [{ ...items[0], exerciseId: 'floor-press' }] })).body.error.code, 'item_identity_conflict');
      assert.equal((await request('/v1/plans', first, 'POST', { ...planBody, items: [planBody.items[0], planBody.items[0]] }, 'bad-items')).status, 422);
      assert.equal((await request('/v1/plans', first, 'POST', { ...planBody, items: [{ ...planBody.items[0], repMin: 15, repMax: 8 }] }, 'bad-reps')).status, 422);
    });
    await t.test('session start snapshots revisions and repeated exercise occurrences', async () => {
      const input = { planId: plan.id, expectedPlanRevision: plan.revision };
      const created = await request('/v1/workout-sessions', first, 'POST', input, 'session-one'); assert.equal(created.status, 201); session = created.body;
      assert.deepEqual((await request('/v1/workout-sessions', first, 'POST', input, 'session-one')).body, session);
      assert.notEqual(session.occurrences[0]!.id, session.occurrences[1]!.id); assert.equal(session.occurrences[0]!.exerciseId, session.occurrences[1]!.exerciseId);
      assert.equal((await request(`/v1/plans/${plan.id}`, first, 'PATCH', { expectedRevision: plan.revision, minutes: 20 })).status, 200);
      assert.equal((await request(`/v1/workout-sessions/${session.id}`, first)).body.planSnapshot.minutes, 35);
      assert.equal((await request(`/v1/workout-sessions/${session.id}`, first)).body.planSnapshot.items[0].targetKg, 15.5);
      assert.throws(() => f.backend.db.prepare('UPDATE workout_sessions SET snapshot=\'{}\' WHERE account_id=? AND id=?').run(accountId, session.id), /immutable_session_snapshot/);
      assert.equal((await request('/v1/workout-sessions', first, 'POST', input, 'stale-session')).body.error.code, 'stale_revision');
      assert.equal((f.backend.db.prepare('SELECT count(*) AS n FROM plan_revisions WHERE account_id=? AND plan_id=?').get(accountId, plan.id) as { n: number }).n, 3);
    });
    await t.test('all private parent/child reads and writes conceal other-account resources before replay', async () => {
      const path = `/v1/plans/${plan.id}`;
      for (const result of [
        await request(path, second), await request(path, second, 'PATCH', { expectedRevision: 3, name: 'stolen' }),
        await request(`${path}/archive`, second, 'POST', { expectedRevision: 3 }, 'archive'),
        await request('/v1/workout-sessions', second, 'POST', { planId: plan.id, expectedPlanRevision: 2 }, 'session-one'),
        await request(`/v1/workout-sessions/${session.id}`, second),
        await request(`/v1/workout-sessions/${session.id}/sets`, second, 'POST', { expectedRevision: 1, occurrenceId: session.occurrences[0]!.id, setNumber: 1, reps: 8, weightKg: 12, status: 'confirmed' }, 'set-one'),
        await request(`/v1/workout-sessions/${session.id}/complete`, second, 'POST', { expectedRevision: 1 }, 'complete'),
      ]) { assert.equal(result.status, 404, JSON.stringify(result.body)); assert.equal(result.body.error.code, 'not_found'); }
      assert.deepEqual((await request('/v1/history', second)).body.items, []); assert.equal((await request('/v1/stats', second)).body.confirmedSets, 0);
      const ownPlan = (await request('/v1/plans', second, 'POST', planBody, 'own-plan')).body;
      const ownSession = (await request('/v1/workout-sessions', second, 'POST', { planId: ownPlan.id, expectedPlanRevision: 1 }, 'own-session')).body;
      assert.equal((await request(`/v1/workout-sessions/${ownSession.id}/sets`, second, 'POST', { expectedRevision: 1, occurrenceId: session.occurrences[0]!.id, setNumber: 1, reps: 8, weightKg: 12, status: 'confirmed' }, 'mixed-occurrence')).status, 404);
    });
    await t.test('explicit confirmations, drafts, correction and void preserve history and statistics', async () => {
      const input = { expectedRevision: 1, occurrenceId: session.occurrences[0]!.id, setNumber: 1, reps: 10, weightKg: 12.5, status: 'confirmed' };
      const recorded = await request(`/v1/workout-sessions/${session.id}/sets`, first, 'POST', input, 'set-one'); assert.equal(recorded.status, 201); recordedSetId = recorded.body.set.id;
      assert.deepEqual((await request(`/v1/workout-sessions/${session.id}/sets`, first, 'POST', input, 'set-one')).body, recorded.body);
      assert.equal((await request(`/v1/workout-sessions/${session.id}/sets`, first, 'POST', { ...input, reps: 8 }, 'set-one')).body.error.code, 'idempotency_mismatch');
      assert.equal((await request(`/v1/workout-sessions/${session.id}/sets`, first, 'POST', { ...input, expectedRevision: 2 }, 'set-duplicate')).body.error.code, 'set_number_exists');
      const draft = await request(`/v1/workout-sessions/${session.id}/sets`, first, 'POST', { ...input, expectedRevision: 2, occurrenceId: session.occurrences[1]!.id, reps: 0, status: 'draft' }, 'draft-one'); assert.equal(draft.status, 201);
      assert.equal((await request('/v1/stats', first)).body.volumeKg, 125); assert.equal((await request('/v1/stats', first)).body.confirmedSets, 1);
      const zero = await request(`/v1/workout-sessions/${session.id}/sets`, first, 'POST', { ...input, expectedRevision: 3, setNumber: 2, reps: 0 }, 'zero-set'); assert.equal(zero.status, 422);
      const correction = { expectedRevision: 1, reps: 8, weightKg: 15, status: 'confirmed' };
      assert.equal((await request(`/v1/workout-sessions/${session.id}/sets/${recordedSetId}`, first, 'PATCH', correction)).status, 400);
      const corrected = await request(`/v1/workout-sessions/${session.id}/sets/${recordedSetId}`, first, 'PATCH', correction, 'correct-one'); assert.equal(corrected.status, 200);
      assert.deepEqual((await request(`/v1/workout-sessions/${session.id}/sets/${recordedSetId}`, first, 'PATCH', correction, 'correct-one')).body, corrected.body);
      assert.equal((await request('/v1/stats', first)).body.volumeKg, 120);
      assert.equal((await request(`/v1/workout-sessions/${session.id}/sets/${recordedSetId}`, first, 'PATCH', { expectedRevision: 1, reps: 10, weightKg: 20, status: 'confirmed' }, 'correct-stale')).body.error.code, 'stale_revision');
      for (const result of [
        await request(`/v1/workout-sessions/${session.id}/sets/${recordedSetId}`, second, 'PATCH', { expectedRevision: 2, reps: 10, weightKg: 20, status: 'confirmed' }, 'correct-one'),
        await request(`/v1/workout-sessions/${session.id}/sets/${recordedSetId}/void`, second, 'POST', { expectedRevision: 2 }, 'void'),
      ]) assert.equal(result.status, 404);
      const voided = await request(`/v1/workout-sessions/${session.id}/sets/${recordedSetId}/void`, first, 'POST', { expectedRevision: 2 }, 'void-one'); assert.equal(voided.status, 200);
      assert.deepEqual((await request(`/v1/workout-sessions/${session.id}/sets/${recordedSetId}/void`, first, 'POST', { expectedRevision: 2 }, 'void-one')).body, voided.body);
      assert.equal((await request('/v1/stats', first)).body.confirmedSets, 0);
      assert.equal((await request(`/v1/workout-sessions/${session.id}/sets/${recordedSetId}`, first, 'PATCH', { expectedRevision: 3, reps: 8, weightKg: 15, status: 'confirmed' }, 'correct-voided')).body.error.code, 'set_voided');
      const confirmedDraft = await request(`/v1/workout-sessions/${session.id}/sets/${draft.body.set.id}`, first, 'PATCH', { expectedRevision: 1, reps: 8, weightKg: 10, status: 'confirmed' }, 'confirm-draft'); assert.equal(confirmedDraft.status, 200);
      completedRevision = confirmedDraft.body.sessionRevision;
      const complete = await request(`/v1/workout-sessions/${session.id}/complete`, first, 'POST', { expectedRevision: completedRevision }, 'complete-one'); assert.equal(complete.status, 200); assert.equal(complete.body.status, 'completed');
      assert.deepEqual((await request(`/v1/workout-sessions/${session.id}/complete`, first, 'POST', { expectedRevision: completedRevision }, 'complete-one')).body, complete.body);
      assert.equal((await request('/v1/stats', first)).body.completedSessions, 1);
      assert.equal((await request('/v1/stats', first)).body.volumeKg, 80);
      const stored = (await request(`/v1/workout-sessions/${session.id}`, first)).body; assert.equal(stored.sets.length, 2); assert.equal(stored.sets.find((set: { id: string }) => set.id === recordedSetId).status, 'voided');
      const audits = f.backend.db.prepare('SELECT count(*) AS n FROM set_revisions WHERE account_id=? AND session_id=? AND set_id=?').get(accountId, session.id, recordedSetId) as { n: number }; assert.equal(audits.n, 3);
    });
    await t.test('replaceable cues are private and immutable technique constraints cannot be rejected', async () => {
      const path = '/v1/exercises/goblet-squat/cue-preferences';
      const cues = (await request(path, first)).body;
      const edit = { expectedRevision: 0, kept: ['steady-setup'], rejected: ['controlled-tempo'], order: ['steady-setup'], replacementRequested: ['controlled-tempo'] };
      assert.equal((await request(path, first, 'PATCH', edit)).status, 200);
      assert.equal((await request(path, first, 'PATCH', { ...edit, expectedRevision: 1, rejected: [cues.requiredConstraints[0].id] })).status, 422);
      assert.equal((await request(path, first, 'PATCH', { ...edit, expectedRevision: 1, requiredConstraints: [] })).status, 422);
      assert.deepEqual((await request(path, first)).body.requiredConstraints, cues.requiredConstraints);
      assert.deepEqual((await request(path, second)).body.rejected, []);
    });
    await t.test('zero-charge promo grants and durable receipts are atomic; provider and paid seams stay honest', async () => {
      const redemption = await request('/v1/promo-redemptions', first, 'POST', { code: 'FAMILY-ZERO' }, 'promo-one'); assert.equal(redemption.status, 201); assert.equal(redemption.body.charged, false);
      assert.deepEqual((await request('/v1/promo-redemptions', first, 'POST', { code: 'family-zero' }, 'promo-one')).body, redemption.body);
      assert.equal((await request('/v1/promo-redemptions', first, 'POST', { code: 'ONE-ZERO' }, 'promo-one')).body.error.code, 'idempotency_mismatch');
      assert.equal((await request('/v1/promo-redemptions', first, 'POST', { code: 'FAMILY-ZERO' }, 'promo-again')).body.error.code, 'promo_already_redeemed');
      assert.equal((await request('/v1/promo-redemptions', first, 'POST', { code: 'NO-CODE', paid: true }, 'promo-forged')).status, 422);
      assert.deepEqual((await request('/v1/entitlements', second)).body.active, []);
      const race = await Promise.all([
        request('/v1/promo-redemptions', first, 'POST', { code: 'ONE-ZERO' }, 'race-one'),
        request('/v1/promo-redemptions', second, 'POST', { code: 'ONE-ZERO' }, 'race-two'),
      ]); assert.deepEqual(race.map(x => x.status).sort(), [201, 422]);
      const capabilities = (await request('/v1/capabilities')).body;
      for (const provider of ['google', 'apple', 'phone']) assert.equal(capabilities.authentication[provider].status, 'unconfigured');
      assert.equal((await request('/v1/purchases/apple/verify', first, 'POST', { transactionId: '10001', productId: 'form.plus.month', jwsRepresentation: 'opaque.payload.signature', idempotencyKey: 'storekit-delivery:10001' })).status, 501);
      assert.equal((await request('/v1/transcriptions', first, 'POST', {})).status, 501);
      assert.ok((await request('/v1/entitlements', first)).body.grants.every((grant: any) => grant.environment === 'zero_charge'));
    });
    await t.test('restart, no reseed, session continuity, isolated SQLite restore and auth-before-replay', async () => {
      const backup = join(f.root, 'isolated-backup.sqlite'); await backupAndVerify(f.backend.db, backup);
      const restored = new Database(backup, { readonly: true });
      try { integrity(restored); assert.equal((restored.prepare('SELECT count(*) AS n FROM form_accounts').get() as { n: number }).n, 2); }
      finally { restored.close(); }
      assert.ok(readdirSync(f.root).every(x => !x.startsWith('.restore-')));
      const previousHistory = (await request('/v1/history', first)).body;
      const previousCues = (await request('/v1/exercises/goblet-squat/cue-preferences', first)).body;
      const previousGrants = (await request('/v1/entitlements', first)).body;
      await f.restart({ mode: 'closed' });
      assert.equal((await request('/v1/me', first)).body.accountId, accountId);
      assert.equal((await request('/v1/me/profile', first)).body.name, 'First private');
      assert.deepEqual((await request('/v1/history', first)).body, previousHistory);
      assert.deepEqual((await request('/v1/exercises/goblet-squat/cue-preferences', first)).body, previousCues);
      assert.deepEqual((await request('/v1/entitlements', first)).body, previousGrants);
      assert.equal((await request('/v1/exercises', first)).body.items.length, 5);
      assert.equal(f.backend.migrationBackups.length, 0);
      assert.equal((await request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password })).status, 403);
      assert.equal((await request('/api/auth/sign-out', first, 'POST', {})).status, 200);
      assert.equal((await request('/v1/me', first)).status, 401);
      assert.equal((await request('/v1/promo-redemptions', first, 'POST', { code: 'FAMILY-ZERO' }, 'promo-one')).status, 401);
      assert.equal((await request('/v1/me', second)).status, 200);
    });
  });
});

test('compound history cursor retains sessions sharing exactly the same timestamp', async () => {
  await fixture(async f => {
    const signed = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password });
    const token = signed.headers.get('set-auth-token')!;
    const created = (await f.request('/v1/plans', token, 'POST', planBody, 'plan')).body;
    for (let index = 0; index < 3; index++) assert.equal((await f.request('/v1/workout-sessions', token, 'POST', { planId: created.id, expectedPlanRevision: 1 }, `session-${index}`)).status, 201);
    f.backend.db.prepare("UPDATE workout_sessions SET started_at='2026-10-08T00:00:00.000Z'").run();
    const ids: string[] = []; let before: string | null = null;
    do {
      const page = await f.request(`/v1/history?limit=1${before ? `&before=${encodeURIComponent(before)}` : ''}`, token);
      assert.equal(page.status, 200); ids.push(...page.body.items.map((item: Session) => item.id)); before = page.body.nextBefore;
    } while (before);
    assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
    assert.equal((await f.request('/v1/history?before=invalid', token)).body.error.code, 'invalid_cursor');
    assert.equal((await f.request('/v1/history?limit=1000', token)).status, 422);
    f.backend.db.prepare('UPDATE exercises SET retired=1 WHERE id=\'goblet-squat\'').run();
    assert.equal((await f.request('/v1/exercises/goblet-squat', token)).body.retired, true);
    assert.equal((await f.request('/v1/plans', token, 'POST', planBody, 'retired-plan')).body.error.code, 'exercise_retired');
    assert.throws(() => f.backend.db.prepare('UPDATE exercises SET retired=0 WHERE id=\'goblet-squat\'').run(), /permanent_catalog_retirement/);
    await f.restart();
    assert.equal((await f.request('/v1/exercises/goblet-squat', token)).body.retired, true, 'restart seed cannot undo retirement');
    assert.equal((await f.request('/v1/history', token)).body.items.length, 3, 'retirement keeps old sessions');
  });
});

function wav(): Buffer {
  const samples = 1600, bytes = samples * 2, result = Buffer.alloc(44 + bytes);
  result.write('RIFF', 0); result.writeUInt32LE(36 + bytes, 4); result.write('WAVE', 8);
  result.write('fmt ', 12); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(bytes, 40); return result;
}
test('Grok adapter uses bounded multipart and permanent attempt claims; synthetic downstream only', async () => {
  let calls = 0, ambiguous = false;
  const provider: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(input, 'https://api.x.ai/v1/stt'); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-not-a-provider-key');
    const multipart = init?.body as FormData;
    assert.deepEqual([...multipart.keys()], ['model', 'language', 'file']);
    assert.equal(multipart.get('model'), 'grok-voice-transcribe-2.0'); assert.equal(multipart.get('language'), 'en');
    assert.equal((multipart.get('file') as File).type, 'audio/wav');
    if (ambiguous) throw new Error('synthetic ambiguous network failure');
    return Response.json({ text: 'Synthetic transcribed words' });
  };
  await fixture(async f => {
    const one = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password });
    const first = one.headers.get('set-auth-token')!;
    const two = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Second', email: emails[1], password });
    const second = two.headers.get('set-auth-token')!;
    const send = async (key: string, bytes = wav(), token = first) => {
      const response = await fetch(`${f.base}/v1/transcriptions`, { method: 'POST', headers: { origin: f.base, authorization: `Bearer ${token}`, 'content-type': 'audio/wav', 'idempotency-key': key }, body: new Uint8Array(bytes) });
      return { status: response.status, body: await response.json() };
    };
    const invalid = wav(); invalid.writeUInt16LE(2, 22);
    assert.equal((await send('invalid', invalid)).status, 422); assert.equal(calls, 0);
    const success = await send('once'); assert.equal(success.status, 201); assert.equal(success.body.status, 'succeeded'); assert.equal(calls, 1);
    assert.deepEqual((await send('once')).body, success.body); assert.equal(calls, 1);
    const changed = wav(); changed[50] = 1;
    assert.equal((await send('once', changed)).body.error.code, 'idempotency_mismatch'); assert.equal(calls, 1);
    assert.equal((await f.request(`/v1/transcriptions/${success.body.id}`, second)).status, 404);
    ambiguous = true;
    const unknown = await send('ambiguous'); assert.equal(unknown.status, 409); assert.equal(unknown.body.error.code, 'transcription_outcome_unknown'); assert.equal(calls, 2);
    assert.equal((await send('ambiguous')).status, 409); assert.equal(calls, 2);
    const unknownId = unknown.body.error.details.attemptId;
    assert.equal((await f.request(`/v1/transcriptions/${unknownId}`, first)).body.status, 'unknown');
    await f.restart();
    assert.equal((await send('ambiguous')).status, 409); assert.equal(calls, 2, 'restart cannot replay an ambiguous upload');
    assert.deepEqual((await send('once')).body, success.body); assert.equal(calls, 2);
  }, { grok: { apiKey: 'synthetic-not-a-provider-key', allowCloudRequests: true, fetch: provider } });
});

test('WAV and provider configuration reject broad/invalid inputs', () => {
  validateWav(wav());
  assert.throws(() => validateWav(Buffer.alloc(2 * 1024 * 1024 + 1)), /invalid_wav/);
  const invalid = wav(); invalid.writeUInt16LE(32, 34); assert.throws(() => validateWav(invalid), /invalid_wav/);
  assert.equal(socialProviderConfiguration.safeParse({ google: { clientId: 'synthetic', clientSecret: 'synthetic' } }).success, true);
  assert.equal(socialProviderConfiguration.safeParse({ apple: { clientId: 'synthetic', clientSecret: 'synthetic', appBundleIdentifier: 'com.synthetic.form' } }).success, true);
  assert.equal(socialProviderConfiguration.safeParse({ google: { clientId: 'synthetic', clientSecret: 'synthetic', verified: true } }).success, false);
  assert.equal(socialProviderConfiguration.safeParse({ phone: { code: '123456' } }).success, false);
});

test('populated additive migration backs up, isolated restore works, checksums stop drift, composite FKs deny mixing', async () => {
  mkdirSync(scratchParent, { recursive: true }); const root = mkdtempSync(join(scratchParent, 'migration-')), path = join(root, 'populated.sqlite');
  const db = new Database(path);
  const dispose = () => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); };
  cleanup.add(dispose);
  try {
    db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    await migrate(db, path, migrations.slice(0, 1));
    for (const id of ['auth-one', 'auth-two']) db.prepare('INSERT INTO "user" VALUES (?,?,?,0,NULL,?,?)').run(id, 'Synthetic', `${id}@synthetic.invalid`, Date.now(), Date.now());
    const domain = new Domain(db), first = domain.account('auth-one', 'Synthetic'), second = domain.account('auth-two', 'Other');
    domain.patchDocument(first, 'profile', { expectedRevision: 0, name: 'Persisted' });
    db.prepare("UPDATE documents SET data=json_remove(data,'$.appMode') WHERE kind='preferences'").run();
    db.prepare("UPDATE document_revisions SET data=json_remove(data,'$.appMode') WHERE kind='preferences'").run();
    const backups = await migrate(db, path); assert.equal(backups.length, migrations.length - 1);
    const restored = new Database(backups[0]!, { readonly: true });
    try { integrity(restored); assert.equal((restored.prepare('SELECT count(*) AS n FROM form_migrations').get() as { n: number }).n, 1); assert.equal(new Domain(restored).document<any>(first, 'profile').name, 'Persisted'); }
    finally { restored.close(); }
    assert.equal(domain.document<any>(first, 'profile').name, 'Persisted');
    assert.equal(domain.document<any>(first, 'preferences').appMode, 'basic');
    assert.equal(domain.document<any>(first, 'preferences').revision, 1);
    const oldPreferences = db.prepare("SELECT data FROM document_revisions WHERE account_id=? AND kind='preferences' AND revision=0").get(first) as { data: string };
    assert.equal(JSON.parse(oldPreferences.data).appMode, undefined, 'migration retains old preference history');
    assert.throws(() => db.prepare('UPDATE form_accounts SET auth_user_id=? WHERE id=?').run('auth-two', first), /immutable_account_mapping/);
    db.prepare('INSERT INTO exercises(id,data) VALUES (?,?)').run('fixture-exercise', '{}');
    const plan = db.prepare('INSERT INTO plans VALUES (?,?,1,0,?,?,?)');
    plan.run(first, 'fixture-plan', '{}', '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z');
    db.prepare('INSERT INTO plan_revisions VALUES (?,?,1,?,?)').run(first, 'fixture-plan', '{}', '2026-10-08T00:00:00Z');
    assert.throws(() => db.prepare("INSERT INTO workout_sessions VALUES (?,?,?,1,1,'{}','active',?,NULL)").run(second, 'bad-session', 'fixture-plan', '2026-10-08T00:00:00Z'), /FOREIGN KEY/);
    assert.throws(() => db.prepare('DELETE FROM exercises WHERE id=?').run('fixture-exercise'), /retained_catalog/);
    const count = (db.prepare('SELECT count(*) AS n FROM command_receipts').get() as { n: number }).n;
    assert.throws(() => command(db, first, 'failure', 'one', {}, () => {}, () => {
      db.prepare('UPDATE documents SET data=\'{}\' WHERE account_id=? AND kind=\'profile\'').run(first);
      throw new Error('deliberate effect failure');
    }), /deliberate effect failure/);
    assert.equal((db.prepare('SELECT count(*) AS n FROM command_receipts').get() as { n: number }).n, count);
    assert.equal(domain.document<any>(first, 'profile').name, 'Persisted');
    await assert.rejects(migrate(db, path, [{ version: 1, sql: 'SELECT 1;' }, ...migrations.slice(1)]), /modified migration history/);
    integrity(db);
  } finally { dispose(); cleanup.delete(dispose); assert.equal(existsSync(root), false); }
});

test('HTTP fixture success and setup failures retain exact resource ownership', async t => {
  await t.test('success awaits listener close and removes its root', async t => {
    let root = '', closed = false;
    let db: Database.Database | undefined;
    const originalClose = HttpServer.prototype.close;
    t.mock.method(HttpServer.prototype, 'close', function (this: HttpServer, callback?: (error?: Error) => void) {
      return originalClose.call(this, error => { closed = true; callback?.(error); });
    });
    await fixture(async f => { root = f.root; db = f.backend.db; });
    assert.equal(closed, true);
    assert.equal(db!.open, false);
    assert.equal(existsSync(root), false);
  });
  await t.test('callback failure preserves the original error', async () => {
    let root = '';
    const failure = new Error('deliberate harness failure');
    await assert.rejects(fixture(async f => { root = f.root; throw failure; }), error => error === failure);
    assert.equal(existsSync(root), false);
  });
  for (const phase of ['constructor', 'readiness'] as const) await t.test(`${phase} failure cleans before backend setup`, async t => {
    const before = new Set(existsSync(scratchParent) ? readdirSync(scratchParent) : []);
    let root = '', closed = false;
    const failure = new Error(`deliberate ${phase} failure`);
    t.mock.method(HttpServer.prototype, 'listen', function (this: HttpServer) {
      const allocated = readdirSync(scratchParent).filter(name => !before.has(name));
      assert.equal(allocated.length, 1);
      root = join(scratchParent, allocated[0]!);
      if (phase === 'constructor') throw failure;
      this.once('close', () => { closed = true; });
      queueMicrotask(() => this.emit('error', failure));
      return this;
    });
    await assert.rejects(fixture(async () => { assert.fail('setup failure must not run the fixture body'); }), error => error === failure);
    assert.ok(root);
    assert.equal(existsSync(root), false);
    if (phase === 'readiness') assert.equal(closed, true);
    assert.deepEqual(new Set(readdirSync(scratchParent)), before);
  });
  await t.test('backend rejection closes the listening server and removes its root', async t => {
    const before = new Set(existsSync(scratchParent) ? readdirSync(scratchParent) : []);
    let closed = false;
    const originalClose = HttpServer.prototype.close;
    t.mock.method(HttpServer.prototype, 'close', function (this: HttpServer, callback?: (error?: Error) => void) {
      return originalClose.call(this, error => { closed = true; callback?.(error); });
    });
    await assert.rejects(fixture(async () => { assert.fail('invalid setup must not run'); }, { trustedOrigins: ['invalid-origin'] }), /exact HTTPS browser origin/);
    assert.equal(closed, true);
    assert.deepEqual(new Set(readdirSync(scratchParent)), before);
  });
  for (const fails of [false, true]) await t.test(`cleanup failure is retained with callback failure ${fails}`, async t => {
    const failure = new Error('deliberate callback failure');
    const cleanupFailure = new Error('deliberate close callback failure');
    let root = '';
    const originalClose = HttpServer.prototype.close;
    t.mock.method(HttpServer.prototype, 'close', function (this: HttpServer, callback?: (error?: Error) => void) {
      return originalClose.call(this, () => callback?.(cleanupFailure));
    });
    await assert.rejects(fixture(async f => { root = f.root; if (fails) throw failure; }), error => {
      assert.ok(error instanceof AggregateError);
      if (fails) {
        assert.equal(error.cause, failure);
        assert.equal(error.errors[0], failure);
        assert.deepEqual(error.errors[1].errors, [cleanupFailure]);
      } else assert.deepEqual(error.errors, [cleanupFailure]);
      return true;
    });
    assert.equal(existsSync(root), false, 'listener failure must not skip independent root cleanup');
  });
  await t.test('disposal during listener readiness closes the late listener without running the body', async () => {
    const before = new Set(cleanup);
    const roots = new Set(existsSync(scratchParent) ? readdirSync(scratchParent) : []);
    const running = fixture(async () => { assert.fail('disposed fixture must not run'); });
    const rejected = assert.rejects(running, /HTTP fixture is disposing/);
    const owned = [...cleanup].filter(dispose => !before.has(dispose));
    assert.equal(owned.length, 1);
    await Promise.all([owned[0]!(), rejected]);
    assert.deepEqual(new Set(readdirSync(scratchParent)), roots);
    assert.deepEqual(cleanup, before);
  });
  await t.test('disposal waits for an unawaited restart and closes its late database', async t => {
    const closedDatabases: Database.Database[] = [];
    const originalClose = Database.prototype.close;
    t.mock.method(Database.prototype, 'close', function (this: Database.Database) {
      closedDatabases.push(this);
      return originalClose.call(this);
    });
    let root = '', dbPath = '';
    let originalDb: Database.Database | undefined;
    let restartResult: Promise<unknown> | undefined;
    let restartedDb: Database.Database | undefined;
    await fixture(async f => {
      root = f.root;
      dbPath = f.dbPath;
      originalDb = f.backend.db;
      assert.equal(originalDb.name, dbPath, 'database name retains the exact fixture path');
      assert.equal(originalDb.readonly, false, 'the original database is writable');
      const restart = f.restart();
      restartResult = restart.then(() => { restartedDb = f.backend.db; }, error => error);
    });
    const result = await restartResult;
    assert.ok(result instanceof Error);
    assert.match(result.message, /HTTP fixture is disposing/);
    assert.equal(restartedDb, undefined, 'disposed fixture must not publish the late backend');
    const samePathCloses = closedDatabases.filter(db => db.name === dbPath);
    const writableHandles = new Set(samePathCloses.filter(db => db.readonly === false));
    const readonlyHandles = new Set(samePathCloses.filter(db => db.readonly === true));
    assert.equal(writableHandles.size, 2, 'initial and late restart writable handles both close');
    assert.ok(originalDb && writableHandles.has(originalDb), 'the original writable handle closes');
    const lateHandles = [...writableHandles].filter(db => db !== originalDb);
    assert.equal(lateHandles.length, 1, 'exactly one other writable handle closes');
    const lateDb = lateHandles[0];
    assert.ok(lateDb);
    assert.notEqual(lateDb, originalDb);
    assert.equal(readonlyHandles.size, 1, 'the existing-file readonly preflight handle closes');
    const [preflightDb] = readonlyHandles;
    assert.ok(preflightDb);
    assert.notEqual(preflightDb, originalDb);
    assert.notEqual(preflightDb, lateDb);
    for (const db of [originalDb, preflightDb, lateDb]) {
      assert.equal(samePathCloses.filter(closed => closed === db).length, 1, 'each same-path handle closes exactly once');
      assert.equal(db.open, false);
    }
    assert.ok(samePathCloses.indexOf(originalDb) < samePathCloses.indexOf(preflightDb), 'the original closes before preflight');
    assert.ok(samePathCloses.indexOf(preflightDb) < samePathCloses.indexOf(lateDb), 'preflight closes before the late writable handle');
    assert.equal(existsSync(root), false);
  });
});

test('account-wide mode: revision, restart, isolation and retained workout data', async () => fixture(async f => {
  const one = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password });
  const two = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Second', email: emails[1], password });
  const first = one.headers.get('set-auth-token')!, second = two.headers.get('set-auth-token')!;
  const before = (await f.request('/v1/me', first)).body;
  assert.equal(before.preferences.appMode, 'basic');
  assert.equal(before.appAccountToken, before.accountId);
  const plan = (await f.request('/v1/plans', first, 'POST', planBody, 'mode-plan')).body;
  const cues = (await f.request('/v1/exercises/goblet-squat/cue-preferences', first)).body;
  const history = (await f.request('/v1/history', first)).body;
  const changed = await f.request('/v1/me/preferences', first, 'PATCH', { expectedRevision: 0, appMode: 'advanced' });
  assert.equal(changed.status, 200); assert.equal(changed.body.appMode, 'advanced'); assert.equal(changed.body.revision, 1);
  assert.equal((await f.request('/v1/me/preferences', first, 'PATCH', { expectedRevision: 0, appMode: 'basic' })).status, 409);
  assert.equal((await f.request('/v1/me/preferences', first, 'PATCH', { expectedRevision: 1, appMode: 'expert' })).status, 422);
  for (const field of ['photoRetention', 'bodyAssessment', 'systemImprovementConsent', 'deletionComplete'])
    assert.equal((await f.request('/v1/me/preferences', first, 'PATCH', { expectedRevision: 1, [field]: true })).status, 422);
  assert.equal((await f.request('/v1/me/preferences', first, 'PATCH', { expectedRevision: 1, appMode: 'basic', accountId: before.accountId })).status, 422);
  await f.restart();
  assert.equal((await f.request('/v1/me/preferences', first)).body.appMode, 'advanced');
  assert.equal((await f.request('/v1/me/preferences', second)).body.appMode, 'basic');
  assert.deepEqual((await f.request(`/v1/plans/${plan.id}`, first)).body, plan);
  assert.deepEqual((await f.request('/v1/history', first)).body, history);
  assert.deepEqual((await f.request('/v1/exercises/goblet-squat/cue-preferences', first)).body, cues);
  assert.equal((await f.request('/v1/me', first)).body.accountId, before.accountId);
  assert.equal((await f.request('/api/auth/sign-out', first, 'POST', {})).status, 200);
  assert.equal((await f.request('/v1/me/preferences', first)).status, 401);
  assert.equal((await f.request('/v1/me/preferences', second)).body.appMode, 'basic');
}));

test('server composition: dormant phone denies alternate routes; Sandbox verifier cannot accept client claims', async () => fixture(async f => {
  const signup = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password });
  const token = signup.headers.get('set-auth-token')!;
  const capabilities = (await f.request('/v1/capabilities')).body;
  assert.equal(capabilities.authentication.phone.status, 'unconfigured');
  assert.equal(capabilities.purchases.apple.status, 'configured_unverified');
  assert.equal(capabilities.purchases.apple.chargesEnabled, false);
  assert.equal(capabilities.purchases.apple.onlineCertificateRevocation, false);
  assert.equal((await f.request('/api/auth/phone-number/challenge', undefined, 'POST', {
    phoneNumber: '+12025550101', binding: 'a'.repeat(43),
  }, 'phone-disabled-0001')).status, 501);
  for (const path of ['send-otp', 'request-password-reset', 'reset-password'])
    assert.equal((await f.request(`/api/auth/phone-number/${path}`, undefined, 'POST', {})).status, 404);
  const request = { transactionId: '10001', productId: 'form.plus.month', jwsRepresentation: 'opaque.payload.signature', idempotencyKey: 'storekit-delivery:10001' };
  assert.equal((await f.request('/v1/purchases/apple/verify', undefined, 'POST', request)).status, 401);
  assert.equal((await f.request('/v1/purchases/apple/verify', token, 'POST', { ...request, appAccountToken: (await f.request('/v1/me', token)).body.accountId })).status, 422);
  assert.equal((await f.request('/v1/purchases/apple/verify', token, 'POST', request, 'different-key')).status, 409);
  const rejected = await f.request('/v1/purchases/apple/verify', token, 'POST', request);
  assert.equal(rejected.status, 200); assert.equal(rejected.body.status, 'rejected');
  assert.equal((await f.request('/v1/entitlements', token)).body.active.length, 0);
  for (const table of ['apple_purchase_owners', 'apple_purchase_transactions', 'apple_purchase_grants', 'apple_purchase_deliveries'])
    assert.equal((f.backend.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  const promo = await f.request('/v1/promo-redemptions', token, 'POST', { code: 'FAMILY-ZERO' }, 'sandbox-promo');
  assert.equal(promo.status, 201);
  await f.restart();
  const entitlements = (await f.request('/v1/entitlements', token)).body;
  assert.deepEqual(entitlements.active, ['form_plus']); assert.equal(entitlements.grants[0].source, 'promo');
  assert.equal(entitlements.appAccountToken, entitlements.accountId);
}, { applePurchases: { bundleId: 'com.form.test', products: [
  { productId: 'form.plus.month', type: 'Auto-Renewable Subscription', entitlement: 'form_plus' },
] } }));

test('composed phone HTTP: managed synthetic transport, signed sessions, isolation and restart', async t => {
  const number = '+12025550101', otherNumber = '+12025550102';
  const phone: NonNullable<ServerConfig['phone']> = { allowCloudRequests: true, allowedPhones: [number, otherNumber],
    accountSid: `AC${'1'.repeat(32)}`, serviceSid: `VA${'2'.repeat(32)}`, apiKeySid: `SK${'3'.repeat(32)}`, apiKeySecret: 'synthetic-never-real-provider-secret' };
  const nativeFetch = globalThis.fetch, nativeNow = Date.now;
  let clockOffset = 0;
  t.mock.method(Date, 'now', () => nativeNow() + clockOffset);
  let sends = 0, checks = 0;
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!String(url).startsWith('https://verify.twilio.com/')) return nativeFetch(url, init);
    const input = init!.body as URLSearchParams;
    const isCheck = String(url).endsWith('/VerificationCheck');
    const second = isCheck ? input.get('VerificationSid') === `VE${'5'.repeat(32)}` : input.get('To') === otherNumber;
    if (isCheck) checks++; else sends++;
    return Response.json({ sid: `VE${(second ? '5' : '4').repeat(32)}`, to: second ? otherNumber : number,
      account_sid: phone.accountSid, service_sid: phone.serviceSid, status: isCheck && input.get('Code') === '741852' ? 'approved' : 'pending' });
  });
  try {
    await fixture(async f => {
      assert.equal((await f.request('/v1/capabilities')).body.authentication.phone.status, 'configured_unverified');
      const login = async (phoneNumber: string) => {
        const input = { phoneNumber, binding: randomBytes(32).toString('base64url') };
        const challenge = await f.request('/api/auth/phone-number/challenge', undefined, 'POST', input, randomUUID());
        assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
        const proof = { ...input, challengeId: challenge.body.challengeId, code: '741852' };
        const verified = await f.request('/api/auth/phone-number/verify', undefined, 'POST', proof, randomUUID());
        assert.equal(verified.status, 200, JSON.stringify(verified.body));
        const token = verified.headers.get('set-auth-token')!; assert.ok(token.includes('.'));
        assert.equal((await f.request('/v1/me', verified.body.token)).status, 401);
        assert.notEqual((await f.request('/api/auth/phone-number/verify', undefined, 'POST', proof, randomUUID())).status, 200);
        return token;
      };
      const email = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Email', email: emails[0], password });
      assert.equal(email.status, 200); const emailToken = email.headers.get('set-auth-token')!;
      await f.restart({ mode: 'closed' });
      const first = await login(number), second = await login(otherNumber);
      const firstMe = (await f.request('/v1/me', first)).body, secondMe = (await f.request('/v1/me', second)).body;
      assert.notEqual(firstMe.accountId, secondMe.accountId);
      assert.notEqual(firstMe.accountId, (await f.request('/v1/me', emailToken)).body.accountId);
      const created = (await f.request('/v1/plans', first, 'POST', planBody, 'phone-plan')).body;
      assert.equal((await f.request(`/v1/plans/${created.id}`, second)).status, 404);
      const reservedEmail = f.backend.db.prepare('SELECT email FROM "user" WHERE phoneNumber=?').get(number) as { email: string };
      assert.equal((await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Forged', email: reservedEmail.email, password })).status, 403);
      await f.restart({ mode: 'closed' });
      assert.equal((await f.request('/v1/me', first)).body.accountId, firstMe.accountId);
      assert.equal((await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Email2', email: emails[1], password })).status, 403);
      clockOffset = 11 * 60 * 1000;
      const repeated = await login(number);
      assert.equal((await f.request('/v1/me', repeated)).body.accountId, firstMe.accountId);
      assert.equal((await f.request('/api/auth/sign-out', first, 'POST', {})).status, 200);
      assert.equal((await f.request('/v1/me', first)).status, 401);
      assert.equal((await f.request('/v1/me', repeated)).status, 200);
      assert.equal((await f.request('/v1/capabilities')).body.authentication.phone.status, 'configured_unverified');
    }, { phone });
    assert.equal(sends, 3); assert.equal(checks, 3);
  } finally { t.mock.restoreAll(); }
});

test('HTTP authoritative entitlement union: synthetic committed Apple ledger, null expiry and sticky revocation', async () => {
  const configuration: NonNullable<ServerConfig['applePurchases']> = { bundleId: 'com.form.test', products: [
    { productId: 'form.plus.lifetime', type: 'Non-Consumable', entitlement: 'form_plus' },
  ] };
  await fixture(async f => {
    const one = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password });
    const two = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Second', email: emails[1], password });
    const first = one.headers.get('set-auth-token')!, second = two.headers.get('set-auth-token')!;
    const accountId = (await f.request('/v1/me', first)).body.accountId;
    const time = Date.now();
    let claims: VerifiedAppleTransaction = { transactionId: '20001', originalTransactionId: '20001', bundleId: configuration.bundleId,
      environment: 'Sandbox', productId: 'form.plus.lifetime', type: 'Non-Consumable', appAccountToken: accountId,
      inAppOwnershipType: 'PURCHASED', purchaseDate: time - 1000, signedDate: time, quantity: 1 };
    // This trusted synthetic service seam only seeds ledger-state aggregation; the HTTP verifier remains real.
    let service = new ApplePurchaseService(f.backend.db, configuration, { verify: async () => ({ ...claims }) });
    const proof = { transactionId: claims.transactionId, productId: claims.productId,
      jwsRepresentation: 'synthetic.payload.signature', idempotencyKey: 'storekit-delivery:20001' };
    assert.equal((await service.deliver(accountId, proof)).status, 'delivered');
    assert.equal((await f.request('/v1/promo-redemptions', first, 'POST', { code: 'FAMILY-ZERO' }, 'union-promo')).status, 201);
    let result = (await f.request('/v1/entitlements', first)).body;
    assert.deepEqual(result.active, ['form_plus']); assert.equal(result.grants.length, 2);
    assert.equal(result.grants.find((g: any) => g.source === 'apple').expiresAt, null);
    assert.equal(result.grants.find((g: any) => g.source === 'apple').active, true);
    assert.deepEqual((await f.request('/v1/entitlements', second)).body.active, []);
    assert.equal((await f.request('/v1/entitlements', second)).body.grants.length, 0);
    assert.equal((await f.request('/v1/purchases/apple/verify', first, 'POST', proof)).body.status, 'rejected', 'production composition cannot accept this synthetic proof');
    await f.restart();
    result = (await f.request('/v1/entitlements', first)).body;
    assert.equal(result.grants.length, 2); assert.deepEqual(result.active, ['form_plus']);
    claims = { ...claims, revocationDate: time, signedDate: Date.now() };
    service = new ApplePurchaseService(f.backend.db, configuration, { verify: async () => ({ ...claims }) });
    assert.equal((await service.deliver(accountId, { ...proof, jwsRepresentation: 'synthetic.revoked.signature' })).status, 'rejected');
    result = (await f.request('/v1/entitlements', first)).body;
    assert.equal(result.grants.find((g: any) => g.source === 'apple').active, false);
    assert.deepEqual(result.active, ['form_plus'], 'independent promo remains active');
    f.backend.db.prepare("UPDATE entitlement_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE account_id=?").run(accountId);
    assert.deepEqual((await f.request('/v1/entitlements', first)).body.active, []);
    await f.restart();
    assert.deepEqual((await f.request('/v1/entitlements', first)).body.active, []);
  }, { applePurchases: configuration });
});

test('populated v4 upgrade: phone and Apple tables, Basic revision backfill, verified backup and restart', async () => {
  mkdirSync(scratchParent, { recursive: true });
  const root = mkdtempSync(join(scratchParent, 'upgrade-v4-')), dbPath = join(root, 'legacy.sqlite');
  let db = new Database(dbPath);
  const dispose = () => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); };
  cleanup.add(dispose);
  try {
    db.pragma('foreign_keys=ON'); await migrate(db, dbPath, migrations.slice(0, 4));
    const authId = randomUUID(), accountId = randomUUID();
    db.prepare('INSERT INTO "user" VALUES (?,?,?,0,NULL,?,?)').run(authId, 'Legacy', emails[0], Date.now(), Date.now());
    db.prepare('INSERT INTO form_accounts VALUES (?,?,?)').run(accountId, authId, new Date().toISOString());
    const legacy = { loadUnit: 'lb', heightUnit: 'cm', coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: 4,
      sessionMinutes: 50, equipment: ['Dumbbells'], remindersEnabled: true };
    db.prepare('INSERT INTO documents VALUES (?,\'preferences\',3,?)').run(accountId, JSON.stringify(legacy));
    db.prepare('INSERT INTO document_revisions VALUES (?,\'preferences\',3,?,?)').run(accountId, JSON.stringify(legacy), new Date().toISOString());
    const backups = await migrate(db, dbPath); assert.equal(backups.length, 3);
    const restored = new Database(backups[0]!, { readonly: true });
    try {
      integrity(restored); assert.equal((restored.prepare('SELECT max(version) AS n FROM form_migrations').get() as { n: number }).n, 4);
      assert.deepEqual(new Domain(restored).document<any>(accountId, 'preferences'), { ...legacy, revision: 3 });
    } finally { restored.close(); }
    assert.deepEqual(new Domain(db).document<any>(accountId, 'preferences'), { ...legacy, appMode: 'basic', revision: 4 });
    assert.equal(JSON.parse((db.prepare('SELECT data FROM document_revisions WHERE account_id=? AND revision=3').get(accountId) as { data: string }).data).appMode, undefined);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='phone_challenges'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='apple_purchase_deliveries'").get());
    db.close(); db = new Database(dbPath); db.pragma('foreign_keys=ON');
    assert.equal((await migrate(db, dbPath)).length, 0);
    assert.equal(new Domain(db).document<any>(accountId, 'preferences').revision, 4);
    integrity(db);
  } finally { dispose(); cleanup.delete(dispose); assert.equal(existsSync(root), false); }
});

test('Settings HTTP: sanitized current identity, session revocation ownership and deletion unavailable', async () => fixture(async f => {
  const one = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'First', email: emails[0], password });
  const two = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Second', email: emails[1], password });
  const first = one.headers.get('set-auth-token')!, second = two.headers.get('set-auth-token')!;
  const another = await f.request('/api/auth/sign-in/email', undefined, 'POST', { email: emails[0], password });
  const otherFirst = another.headers.get('set-auth-token')!;
  assert.equal((await f.request('/v1/me/settings')).status, 401);
  const settings = (await f.request('/v1/me/settings', first)).body;
  assert.deepEqual(settings.identity.signInMethods, ['emailPassword']);
  assert.equal(settings.identity.email, emails[0]);
  assert.equal(settings.capabilities.accountDeletion.supported, false);
  assert.equal(settings.capabilities.accountDeletion.status, 'unavailable');
  assert.equal(settings.policies.reminders.effect, 'preferenceOnly');
  assert.equal(settings.policies.privacy.bodyRetention, 'unavailable');
  assert.equal(JSON.stringify(settings).includes(one.body.token), false);
  assert.equal(JSON.stringify(settings).includes(password), false);
  assert.equal((await f.request('/v1/me/settings', second)).body.identity.email, emails[1]);
  await f.request('/v1/me/profile', first, 'PATCH', { expectedRevision: 0, name: 'Edited profile' });
  assert.equal((await f.request('/v1/me/settings', first)).body.identity.displayName, 'Edited profile');
  assert.equal((await f.request('/api/auth/revoke-session', first, 'POST', { token: two.body.token })).status, 200);
  assert.equal((await f.request('/v1/me', second)).status, 200, 'cannot revoke another account session');
  assert.equal((await f.request('/api/auth/revoke-other-sessions', first, 'POST', {})).status, 200);
  assert.equal((await f.request('/v1/me', otherFirst)).status, 401);
  assert.equal((await f.request('/v1/me', first)).status, 200);
  assert.equal((await f.request('/v1/me', second)).status, 200);
  const count = (f.backend.db.prepare('SELECT count(*) AS n FROM "user"').get() as { n: number }).n;
  assert.notEqual((await f.request('/api/auth/delete-user', first, 'POST', {})).status, 200);
  assert.equal((f.backend.db.prepare('SELECT count(*) AS n FROM "user"').get() as { n: number }).n, count);
  const response = await f.request('/api/auth/revoke-sessions', first, 'POST', {});
  assert.equal(response.status, 200);
  await f.restart();
  assert.equal((await f.request('/v1/me/settings', first)).status, 401);
  assert.equal((await f.request('/v1/me/settings', second)).status, 200);
}));

test('body HTTP boundary rejects before upload bytes, account creation, receipts and profile writes', async () => fixture(async f => {
  const snapshot = () => Object.fromEntries(['form_accounts', 'documents', 'document_revisions', 'command_receipts', 'plans', 'plan_revisions', 'transcription_attempts']
    .map(table => [table, f.backend.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const initial = snapshot();
  assert.equal((await f.request('/v1/body/capabilities')).status, 401);
  assert.equal((await f.request('/v1/body/operations/upload_photo', undefined, 'POST', { retention: 'no_save' })).status, 401);
  assert.deepEqual(snapshot(), initial);
  const tokens: string[] = [], ids: string[] = [];
  for (let n = 0; n < 2; n++) {
    const signup = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: `Body ${n}`, email: emails[n], password });
    const token = signup.headers.get('set-auth-token')!;
    const beforeProvision = snapshot();
    assert.equal((await f.request('/v1/body/capabilities', token)).status, 403);
    assert.deepEqual(snapshot(), beforeProvision, 'body requests never initialize account/profile documents');
    ids.push((await f.request('/v1/me', token)).body.accountId); tokens.push(token);
  }
  assert.notEqual(ids[0], ids[1]);
  const before = snapshot();
  for (const token of tokens) {
    const caps = await f.request('/v1/body/capabilities', token);
    assert.equal(caps.status, 200);
    assert.equal(caps.body.schema, 'form.body-capabilities/v1');
    assert.equal(caps.body.serverProcessing.status, 'unavailable');
    assert.equal(caps.body.strictNoSave.serverRequestsAllowed, false);
    assert.equal(JSON.stringify(caps.body).includes(ids[0]!), false);
    assert.equal(JSON.stringify(caps.body).includes(ids[1]!), false);
    for (const operation of bodyOperations) {
      const denied = await f.request(`/v1/body/operations/${operation}`, token, 'POST',
        { retention: 'no_save', accountId: ids[1], image: 'SYNTHETIC-SENSITIVE-MARKER' }, 'body-denied');
      assert.equal(denied.status, 501, 'disabled API rejects before payload interpretation');
      assert.equal(JSON.stringify(denied.body).includes('SYNTHETIC-SENSITIVE-MARKER'), false);
    }
  }
  // Send headers only with chunked encoding: the response must arrive before any upload bytes.
  for (const token of [undefined, ...tokens]) {
    const result = await new Promise<{ status: number; body: string }>((resolveResponse, rejectResponse) => {
      const request = httpRequest(`${f.base}/v1/body/operations/upload_photo`, { method: 'POST', headers: {
        origin: f.base, 'content-type': 'multipart/form-data; boundary=synthetic', 'transfer-encoding': 'chunked',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
        response.on('end', () => { request.destroy(); resolveResponse({ status: response.statusCode!, body }); });
        response.on('error', rejectResponse);
      });
      request.setTimeout(3000, () => request.destroy(new Error('body boundary waited for upload bytes')));
      request.on('error', rejectResponse); request.flushHeaders();
    });
    assert.equal(result.status, token ? 501 : 401);
    assert.equal(JSON.parse(result.body).error.code, token ? 'body_photo_upload_unavailable' : 'unauthenticated');
  }
  assert.deepEqual(snapshot(), before, 'denials write no profile/history/plan/receipt/transcription data');
  await f.restart();
  assert.deepEqual(snapshot(), before);
}));

test('browser origin configuration is bounded canonical HTTPS, with closed absent default', () => {
  assert.deepEqual(browserOriginsConfiguration.parse([]), []);
  assert.deepEqual(browserOriginsConfiguration.parse(['https://members.form.example', 'https://members.form.example:8443']),
    ['https://members.form.example', 'https://members.form.example:8443']);
  for (const origin of ['http://members.form.example', 'https://*.form.example', 'https://user:password@form.example',
    'https://form.example/path', 'https://form.example/', 'https://form.example?query=1', 'https://form.example#fragment',
    'null', 'formprivacy://', 'https://form.example:443', ' https://form.example', 'https://FORM.EXAMPLE'])
    assert.equal(browserOriginsConfiguration.safeParse([origin]).success, false, origin);
  assert.equal(browserOriginsConfiguration.safeParse(['https://form.example', 'https://form.example']).success, false);
  assert.equal(browserOriginsConfiguration.safeParse(Array.from({ length: 21 }, (_, n) => `https://form${n}.example`)).success, false);
  assert.equal(browserOriginsConfiguration.safeParse({ origins: ['https://form.example'] }).success, false);
});

test('browser cookie/CORS contract: exact approved origin, credential headers, hostile denial and shared identity', async () => {
  const website = 'https://members.form.example';
  await fixture(async f => {
    const preflight = await f.request('/v1/me/preferences', undefined, 'OPTIONS', undefined, undefined, {
      origin: website, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type',
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), website);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.ok(preflight.headers.get('access-control-allow-methods')!.includes('PATCH'));
    const signup = await f.request('/api/auth/sign-up/email', undefined, 'POST', { name: 'Browser', email: emails[0], password }, undefined, { origin: website });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    assert.equal(signup.headers.get('access-control-allow-origin'), website);
    assert.equal(signup.headers.get('access-control-allow-credentials'), 'true');
    const cookie = signup.headers.get('set-cookie')!.split(';')[0]!, signed = signup.headers.get('set-auth-token')!;
    assert.ok(signup.headers.get('set-cookie')!.toLowerCase().includes('httponly'));
    assert.ok(signup.headers.get('set-cookie')!.toLowerCase().includes('samesite=lax'));
    const browser = await f.request('/v1/me', undefined, 'GET', undefined, undefined, { origin: website, cookie });
    assert.equal(browser.status, 200);
    const native = await f.request('/v1/me', signed);
    assert.equal(browser.body.accountId, native.body.accountId);
    assert.equal(browser.body.appAccountToken, native.body.accountId);
    assert.equal((await f.request('/v1/me/preferences', undefined, 'PATCH', { expectedRevision: 0, appMode: 'advanced' }, undefined, { origin: website, cookie })).status, 200);
    assert.equal((await f.request('/v1/me/preferences', signed)).body.appMode, 'advanced');
    for (const hostile of ['https://hostile.invalid', 'https://members.form.example.hostile.invalid', 'http://members.form.example']) {
      const response = await f.request('/v1/me/preferences', undefined, 'PATCH', { expectedRevision: 1, appMode: 'basic' }, undefined, { origin: hostile, cookie });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      const hostilePreflight = await f.request('/v1/me/preferences', undefined, 'OPTIONS', undefined, undefined, {
        origin: hostile, 'access-control-request-method': 'PATCH',
      });
      assert.equal(hostilePreflight.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await f.request('/v1/me/preferences', signed)).body.appMode, 'advanced');
    assert.equal((await f.request('/v1/me', undefined, 'GET', undefined, undefined, { origin: website })).status, 401);
    await f.restart();
    assert.equal((await f.request('/v1/me', undefined, 'GET', undefined, undefined, { origin: website, cookie })).body.accountId, browser.body.accountId);
    assert.equal((await f.request('/v1/entitlements', signed)).body.accountId, browser.body.accountId);
    const signout = await f.request('/api/auth/sign-out', undefined, 'POST', {}, undefined, { origin: website, cookie });
    assert.equal(signout.status, 200);
    assert.equal((await f.request('/v1/me', signed)).status, 401);
    assert.equal((await f.request('/v1/me', undefined, 'GET', undefined, undefined, { origin: website, cookie })).status, 401);
  }, { trustedOrigins: [website] });
});
