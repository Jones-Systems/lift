import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Domain } from '../../src/domain.js';
import type { FirstPlanReceipt } from '../../src/integration/first-plan/contracts.js';
import { startBackend, type BackendOptions } from './native-backend.js';

const email = 'e2e-primary@synthetic.invalid';
const password = 'Synthetic-E2E-Only-2026!';
const expected = { displayName: 'E2E Athlete', loadUnit: 'lb' };
type Session = ReturnType<Domain['session']>;
type SetResult = ReturnType<Domain['createSet']>;
type Ready = { origin: string; control_url: string };

async function exit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Backend did not exit within ten seconds')), 10_000);
    child.once('exit', code => { clearTimeout(timeout); done(code); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
}

async function fixture(run: (value: {
  parent: string; options: BackendOptions;
  launch: (overrides?: Partial<BackendOptions>) => ChildProcess;
  ready: (child: ChildProcess) => Promise<Ready>;
  logs: () => string;
}) => Promise<void>): Promise<void> {
  const parent = mkdtempSync(join(resolve('.'), '.native-e2e-test-'));
  const children: ChildProcess[] = [];
  let logs = '', cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    try {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        child.kill('SIGTERM');
        try { await exit(child); }
        catch { child.kill('SIGKILL'); await exit(child); throw new Error('Backend required forced termination'); }
      }
    } finally { rmSync(parent, { recursive: true, force: true }); }
  })();
  const interrupt = () => { void cleanup().finally(() => process.exit(130)); };
  const terminate = () => { void cleanup().finally(() => process.exit(143)); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const options: BackendOptions = { origin: 'http://127.0.0.1:0', controlPort: 0, allowEmail: email,
    root: join(parent, 'database'), ready: join(parent, 'ready.json'), controlToken: randomBytes(32).toString('base64url') };
  try {
    await run({ parent, options, logs: () => logs,
      launch: (overrides = {}) => {
        const value = { ...options, ...overrides };
        const child = spawn(process.execPath, ['--experimental-transform-types', '--import', './scripts/integration/source-hook.mjs',
          'tests/e2e/native-backend.ts', '--origin', value.origin, '--control-port', String(value.controlPort),
          '--allow-email', value.allowEmail, '--root', value.root, '--ready', value.ready],
        { cwd: resolve('.'), env: { ...process.env, E2E_CONTROL_TOKEN: value.controlToken }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        for (const stream of [child.stdout, child.stderr]) stream!.on('data', data => { logs = (logs + String(data)).slice(-64 * 1024); });
        return child;
      },
      ready: async child => {
        const deadline = Date.now() + 30_000;
        while (!existsSync(options.ready)) {
          assert.equal(child.exitCode, null, `Backend exited before readiness: ${logs}`);
          assert.equal(child.signalCode, null, 'Backend was signalled before readiness');
          assert.ok(Date.now() < deadline, 'Backend readiness timed out');
          await delay(25);
        }
        return JSON.parse(readFileSync(options.ready, 'utf8')) as Ready;
      },
    });
  } finally {
    try { await cleanup(); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  }
}

async function request<T = unknown>(origin: string, path: string, token?: string, body?: unknown,
  method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; body: T; headers: Headers }> {
  // Native transport has no browser Fetch Metadata; Node fetch adds Sec-Fetch-Mode automatically.
  return new Promise((done, reject) => {
    const request = httpRequest(origin + path, { method, signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json', 'idempotency-key': randomUUID(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}) } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) response.destroy(new Error('Oversized test response'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const headers = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2)
            headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
          done({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T, headers });
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('native backend validates scope before creating scratch and never adopts an existing root', () => fixture(async f => {
  for (const change of [{ origin: 'http://0.0.0.0:8000' }, { origin: 'http://localhost:8000' },
    { origin: 'http://127.0.0.1:8000/path' }, { allowEmail: 'real@example.com' }, { controlToken: 'short' },
    { ready: join(f.options.root, 'ready.json') }]) {
    await assert.rejects(startBackend({ ...f.options, ...change }));
    assert.equal(existsSync(f.options.root), false);
  }
  mkdirSync(f.options.root); writeFileSync(join(f.options.root, 'sentinel'), 'preserve');
  await assert.rejects(startBackend(f.options), /must not exist/);
  assert.equal(readFileSync(join(f.options.root, 'sentinel'), 'utf8'), 'preserve');
}));

test('real no-Origin auth, onboarding, legacy plan, edited/voided workout, profile, revoke and SIGTERM cleanup', () => fixture(async f => {
  const sibling = join(f.parent, 'unrelated'); mkdirSync(sibling); writeFileSync(join(sibling, 'sentinel'), 'preserve');
  const child = f.launch(), ready = await f.ready(child);
  assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
  assert.notEqual(ready.origin, ready.control_url);
  assert.deepEqual(Object.keys(ready).sort(), ['control_url', 'origin']);
  const control = (path: string, body: unknown = {}) => request(ready.control_url, path, f.options.controlToken, body);
  assert.equal((await request(ready.control_url, '/revoke-sessions', undefined, {})).status, 401);
  assert.equal((await request(ready.control_url, '/revoke-sessions', 'invalid-token', {})).status, 401);
  assert.equal((await request(ready.control_url, '/revoke-sessions', f.options.controlToken)).status, 404);
  assert.equal((await control('/assert-final-state', expected)).status, 409);
  assert.equal((await control('/assert-final-state', { ...expected, accountId: 'injected' })).status, 400);
  assert.notEqual((await request(ready.origin, '/api/auth/sign-in/email', undefined, { email, password })).status, 200);
  assert.notEqual((await request(ready.origin, '/api/auth/sign-up/email', undefined,
    { email: 'not-allowed@synthetic.invalid', password, name: 'Other' })).status, 200);
  const signup = await request<{ code?: string; error?: { code?: string } }>(ready.origin, '/api/auth/sign-up/email', undefined,
    { email, password, name: expected.displayName });
  const signupCode = signup.body.code ?? signup.body.error?.code;
  assert.equal(signup.status, 200, typeof signupCode === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(signupCode)
    ? `Signup rejected: ${signupCode}` : 'Signup must succeed');
  const token = signup.headers.get('set-auth-token'); assert.ok(token);
  assert.equal((await request(ready.origin, '/v1/me', token)).status, 200);
  const draft = await request<{ revision: number }>(ready.origin, '/v1/me/onboarding', token,
    { expectedRevision: 0, step: 'review', answers: { goals: ['Build strength'], trainingBackground: 'new', injuryHistory: 'None' },
      preferences: { coachVoice: 'calm', trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: ['Dumbbells'] } }, 'PATCH');
  assert.equal(draft.status, 200);
  assert.equal((await request(ready.origin, '/v1/me/onboarding/complete', token, { expectedRevision: draft.body.revision })).status, 200);
  const generated = await request<FirstPlanReceipt>(ready.origin, '/v1/plans/first', token, { profileRevision: 1, preferencesRevision: 1 });
  assert.equal(generated.status, 201);
  assert.equal('schema' in generated.body.plan, false);
  assert.equal(generated.body.plan.name, 'Native E2E plan');
  assert.equal(generated.body.plan.items.length, 1);
  const item = generated.body.plan.items[0]!;
  assert.ok('exerciseId' in item); assert.equal(item.exerciseId, 'goblet-squat'); assert.equal(item.setTarget, 2);
  const started = await request<Session>(ready.origin, '/v1/workout-sessions', token,
    { planId: generated.body.plan.id, expectedPlanRevision: generated.body.plan.revision });
  assert.equal(started.status, 201);
  const session = started.body, occurrence = session.occurrences[0]!, path = `/v1/workout-sessions/${session.id}`;
  const first = await request<SetResult>(ready.origin, `${path}/sets`, token,
    { occurrenceId: occurrence.id, setNumber: 1, reps: 8, weightKg: 10, status: 'confirmed', expectedRevision: session.revision });
  assert.equal(first.status, 201);
  const second = await request<SetResult>(ready.origin, `${path}/sets`, token,
    { occurrenceId: occurrence.id, setNumber: 2, reps: 8, weightKg: 10, status: 'confirmed', expectedRevision: first.body.sessionRevision });
  assert.equal(second.status, 201);
  const edited = await request<SetResult>(ready.origin, `${path}/sets/${first.body.set.id}`, token,
    { expectedRevision: first.body.set.revision, reps: 9, weightKg: 10, status: 'confirmed' }, 'PATCH');
  assert.equal(edited.status, 200);
  const voided = await request<SetResult>(ready.origin, `${path}/sets/${second.body.set.id}/void`, token,
    { expectedRevision: second.body.set.revision });
  assert.equal(voided.status, 200);
  assert.equal((await request(ready.origin, '/v1/me/preferences', token, { expectedRevision: 1, loadUnit: 'lb' }, 'PATCH')).status, 200);
  assert.equal((await control('/assert-final-state', expected)).status, 409);
  const completed = await request<Session>(ready.origin, `${path}/complete`, token, { expectedRevision: voided.body.sessionRevision });
  assert.equal(completed.status, 200); assert.equal(completed.body.status, 'completed');
  const history = await request<{ items: Session[] }>(ready.origin, '/v1/history', token);
  assert.equal(history.body.items[0]?.id, session.id);
  const stats = await request(ready.origin, '/v1/stats', token); assert.equal(stats.status, 200);
  assert.equal((await control('/assert-final-state', { ...expected, displayName: 'Wrong' })).status, 409);
  assert.equal((await control('/assert-final-state', { ...expected, loadUnit: 'kg' })).status, 409);
  const final = await control('/assert-final-state', expected);
  assert.equal(final.status, 200);
  assert.deepEqual(final.body, { plans: 1, completedWorkouts: 1, activeSets: 1, voidedSets: 1 });
  const revoked = await control('/revoke-sessions'); assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body, { revokedSessions: 1 });
  assert.equal((await request(ready.origin, '/v1/me', token)).status, 401);
  const signedIn = await request(ready.origin, '/api/auth/sign-in/email', undefined, { email, password });
  assert.equal(signedIn.status, 200);
  const restoredToken = signedIn.headers.get('set-auth-token'); assert.ok(restoredToken);
  assert.equal((await request(ready.origin, '/v1/me', restoredToken)).status, 200);
  assert.equal((await control('/assert-final-state', expected)).status, 200);
  child.kill('SIGTERM'); assert.equal(await exit(child), 143);
  assert.equal(existsSync(f.options.root), false);
  assert.equal(readFileSync(join(sibling, 'sentinel'), 'utf8'), 'preserve');
  assert.equal(existsSync(f.options.ready), true);
  await assert.rejects(fetch(ready.origin + '/v1/me', { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(fetch(ready.control_url + '/revoke-sessions', { signal: AbortSignal.timeout(1000) }));
  assert.equal(f.logs().includes(f.options.controlToken), false);
  assert.equal(f.logs().includes(password), false);
}));

test('control port collision fails startup and removes only owned database scratch', () => fixture(async f => {
  const occupied = createHttpServer((_request, response) => { response.end('owned by test'); });
  await new Promise<void>(done => occupied.listen(0, '127.0.0.1', done));
  try {
    const address = occupied.address(); assert.ok(address && typeof address !== 'string');
    const child = f.launch({ controlPort: address.port });
    assert.equal(await exit(child), 1);
    assert.equal(existsSync(f.options.root), false); assert.equal(existsSync(f.options.ready), false);
    assert.equal(await fetch(`http://127.0.0.1:${address.port}`).then(response => response.text()), 'owned by test');
  } finally { await new Promise<void>((done, reject) => occupied.close(error => error ? reject(error) : done())); }
}));

test('SIGINT also closes both listeners and cleans owned scratch', () => fixture(async f => {
  const child = f.launch(); await f.ready(child);
  child.kill('SIGINT'); assert.equal(await exit(child), 130);
  assert.equal(existsSync(f.options.root), false);
}));
