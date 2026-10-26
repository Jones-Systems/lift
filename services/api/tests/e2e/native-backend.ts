import { createAdaptorServer } from '@hono/node-server';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FormServer } from '../../src/server.js';
import type { PreparedFirstPlan } from '../../src/integration/first-plan/contracts.js';
import type { DisableRecord, SuppressionLedger } from '../../src/lifecycle/types.js';
import type { Preferences, Profile } from '../../src/schemas.js';

// The source CLI is outside the source hook's roots; emitted tests use the same imports as JavaScript.
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const { createServer } = await import(`../../src/server.${extension}`) as typeof import('../../src/server.js');
const { moduleMigrations } = await import(`../../src/runtime-modules/migrations.${extension}`) as typeof import('../../src/runtime-modules/migrations.js');

export type BackendOptions = { origin: string; controlPort: number; allowEmail: string; root: string; ready: string; controlToken: string };
type Ready = { origin: string; control_url: string };

const syntheticSource = { id: 'native-e2e-synthetic', revision: 'v1', locator: 'fixture:native-e2e',
  currentness: 'current' as const, qualification: 'Synthetic first-plan mechanics only; no clinical or source qualification.' };
export const fixturePlan = { name: 'Native E2E plan', minutes: 15, items: [
  { id: 'e2e-goblet-squat', exerciseId: 'goblet-squat', setTarget: 2, repMin: 8, repMax: 12, targetKg: 10 },
] };

function prepareFirstPlan(): PreparedFirstPlan {
  return { candidates: [{ id: 'native-e2e-candidate', qualification: 'qualified', source: syntheticSource,
    plan: structuredClone(fixturePlan) }], assertCurrent() {}, ports: {
    qualifyCatalog(input) {
      return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified', source: syntheticSource,
        items: input.candidate.plan.items.map((item, index) => ({ itemId: item.id, exerciseId: item.exerciseId,
          variantId: `native-e2e:${item.id}`, prescriptionKey: input.prescriptions[index]!.prescriptionKey,
          retired: false, source: syntheticSource })) };
    },
    evaluateConstraints(input) {
      return { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'eligible', source: syntheticSource,
        reasons: [], rules: [{ ruleId: 'synthetic-only', outcome: 'satisfied', source: syntheticSource, reasons: [] }] };
    },
  } };
}

function ephemeralLedger(): SuppressionLedger {
  const records = new Map<string, DisableRecord>();
  let sequence = 0;
  return { currentSequence: () => sequence, lookup: id => records.get(id) ?? null,
    reconcileRestore: apply => { for (const record of records.values()) apply(record); return sequence; },
    recordDisable: input => { const record = { ...input, sequence: ++sequence }; records.set(input.accountId, record); return record; } };
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function validate(options: BackendOptions): URL {
  const url = new URL(options.origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || options.origin !== url.origin)
    throw new Error('Exact IPv4 loopback HTTP origin required');
  if (!Number.isInteger(options.controlPort) || options.controlPort < 0 || options.controlPort > 65535)
    throw new Error('Invalid control port');
  if (!/^[a-z0-9][a-z0-9._+-]*@synthetic\.invalid$/.test(options.allowEmail)) throw new Error('Synthetic allowlist email required');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.controlToken)) throw new Error('Random control token required');
  if (!isAbsolute(options.root) || !isAbsolute(options.ready)) throw new Error('Absolute scratch and ready paths required');
  const child = relative(resolve(options.root), resolve(options.ready));
  if (!child || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)))
    throw new Error('Ready evidence must be outside database root');
  if (exists(options.root) || exists(options.ready)) throw new Error('Database root and ready file must not exist');
  return url;
}

async function bind(server: Server, port: number): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); done(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener address');
  return address.port;
}

async function closeListener(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => {
    server.close(error => error ? reject(error) : done());
    server.closeAllConnections();
  });
}

function json(value: unknown, status = 200): Response { return Response.json(value, { status }); }

function assertFinalState(server: FormServer, email: string, expected: unknown): Response {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return json({ error: 'invalid_expected' }, 400);
  const values = expected as Record<string, unknown>;
  if (Object.keys(values).sort().join(',') !== 'displayName,loadUnit' || typeof values.displayName !== 'string' ||
      !values.displayName.trim() || values.displayName.length > 100 || !['kg', 'lb'].includes(String(values.loadUnit)))
    return json({ error: 'invalid_expected' }, 400);
  const account = server.db.prepare('SELECT f.id FROM form_accounts f JOIN "user" u ON u.id=f.auth_user_id WHERE u.email=?').get(email) as { id: string } | undefined;
  if (!account) return json({ error: 'final_state_mismatch' }, 409);
  const profile = server.domain.document<Profile>(account.id, 'profile');
  const preferences = server.domain.document<Preferences>(account.id, 'preferences');
  const plans = server.domain.plans(account.id);
  const workouts = server.domain.history(account.id, 50).items;
  const plan = plans[0], workout = workouts[0];
  if (profile.name !== values.displayName || preferences.loadUnit !== values.loadUnit ||
      server.domain.onboarding(account.id).status !== 'completed' || plans.length !== 1 || !plan ||
      'schema' in plan || plan.name !== fixturePlan.name || JSON.stringify(plan.items) !== JSON.stringify(fixturePlan.items) ||
      workouts.length !== 1 || !workout || workout.status !== 'completed' || !workout.completedAt ||
      workout.planId !== plan.id || 'schema' in workout.planSnapshot ||
      JSON.stringify(workout.planSnapshot.items) !== JSON.stringify(fixturePlan.items))
    return json({ error: 'final_state_mismatch' }, 409);
  const sets = server.db.prepare('SELECT id,status,revision FROM performed_sets WHERE account_id=? AND session_id=?')
    .all(account.id, workout.id) as { id: string; status: string; revision: number }[];
  const active = sets.filter(set => set.status === 'confirmed'), voided = sets.filter(set => set.status === 'voided');
  if (sets.length !== 2 || active.length !== 1 || voided.length !== 1 || active[0]!.revision < 2)
    return json({ error: 'final_state_mismatch' }, 409);
  const revisions = server.db.prepare('SELECT data FROM set_revisions WHERE account_id=? AND session_id=? AND set_id=? ORDER BY revision')
    .all(account.id, workout.id, active[0]!.id) as { data: string }[];
  const first = JSON.parse(revisions[0]!.data) as { reps: number; weightKg: number };
  const last = JSON.parse(revisions.at(-1)!.data) as { reps: number; weightKg: number };
  if (first.reps === last.reps && first.weightKg === last.weightKg) return json({ error: 'final_state_mismatch' }, 409);
  return json({ plans: plans.length, completedWorkouts: workouts.length, activeSets: active.length, voidedSets: voided.length });
}

async function signOutErrorCode(response: Response): Promise<string | null> {
  if (response.ok) return null;
  try {
    const reader = response.clone().body?.getReader();
    if (!reader) return 'MALFORMED_RESPONSE';
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) return 'OVERSIZED_RESPONSE';
        chunks.push(value);
      }
    } finally {
      // A cloned stream's cancellation can wait for the original consumer.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const code = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).code : undefined;
    return typeof code === 'string' && ['MISSING_OR_NULL_ORIGIN', 'INVALID_ORIGIN', 'INVALID_REFERER'].includes(code)
      ? code : 'UNCLASSIFIED_ERROR';
  } catch { return 'MALFORMED_RESPONSE'; }
}

export async function witnessSignOut(request: Request, dispatch: () => Response | Promise<Response>,
  emit: (line: string) => void = line => console.log(line)): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/auth/sign-out') return dispatch();
  const presence = { authorizationPresent: request.headers.has('authorization'), cookiePresent: request.headers.has('cookie'),
    originPresent: request.headers.has('origin'), refererPresent: request.headers.has('referer') };
  const response = await dispatch();
  const errorCode = await signOutErrorCode(response);
  // Fixture diagnostics must never change the HTTP response, even if the sink fails.
  try { emit(JSON.stringify({ event: 'native-e2e-sign-out', ...presence,
    status: response.status, success: response.ok, errorCode })); } catch {}
  return response;
}

export async function startBackend(options: BackendOptions, signal?: AbortSignal): Promise<Ready & { stop: () => Promise<void> }> {
  const url = validate(options);
  signal?.throwIfAborted();
  mkdirSync(options.root, { mode: 0o700 });
  let form: FormServer | undefined;
  const listeners: Server[] = [];
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    const failures: unknown[] = [];
    for (const listener of listeners) try { await closeListener(listener); } catch (error) { failures.push(error); }
    try { await form?.close(); } catch (error) { failures.push(error); }
    try { rmSync(options.root, { recursive: true, force: false }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Native E2E cleanup failed');
  })();
  try {
    const api = createAdaptorServer({ fetch: (request, env) => witnessSignOut(request, () => form
      ? form.handleRequest(request, env.incoming.socket.remoteAddress ?? 'unknown') : json({ error: 'starting' }, 503)) }) as Server;
    listeners.push(api);
    const apiPort = await bind(api, Number(url.port || '80'));
    signal?.throwIfAborted();
    const origin = `http://127.0.0.1:${apiPort}`;
    form = await createServer({ dbPath: join(options.root, 'synthetic.sqlite'), baseURL: origin,
      secret: randomBytes(48).toString('base64url'), registration: { mode: 'allowlist', emails: [options.allowEmail] },
      moduleMigrations, lifecycle: { ledger: ephemeralLedger() },
      sourceRequestFactories: { mode: 'source-only', communityModules: 'b2-b4-b5' },
      sourceFirstPlan: async () => prepareFirstPlan() });
    signal?.throwIfAborted();
    const credential = Buffer.from(`Bearer ${options.controlToken}`);
    const control = createAdaptorServer({ fetch: async request => {
      const supplied = Buffer.from(request.headers.get('authorization') ?? '');
      if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) return json({ error: 'unauthorized' }, 401);
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST' || !['/revoke-sessions', '/assert-final-state'].includes(path)) return json({ error: 'not_found' }, 404);
      if (path === '/revoke-sessions') {
        const result = form!.db.prepare('DELETE FROM session WHERE userId IN (SELECT id FROM "user" WHERE email=?)').run(options.allowEmail);
        return json({ revokedSessions: result.changes });
      }
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return json({ error: 'json_required' }, 415);
      let body: unknown;
      try {
        const text = await request.text();
        if (Buffer.byteLength(text) > 1024) return json({ error: 'oversized_expected' }, 413);
        body = JSON.parse(text);
      } catch { return json({ error: 'invalid_json' }, 400); }
      try { return assertFinalState(form!, options.allowEmail, body); }
      catch { return json({ error: 'final_state_unavailable' }, 500); }
    } }) as Server;
    listeners.push(control);
    const controlPort = await bind(control, options.controlPort);
    signal?.throwIfAborted();
    const ready: Ready = { origin, control_url: `http://127.0.0.1:${controlPort}` };
    const temporary = join(dirname(options.ready), `.native-e2e-ready-${randomBytes(12).toString('hex')}`);
    try {
      writeFileSync(temporary, JSON.stringify(ready) + '\n', { flag: 'wx', mode: 0o600 });
      linkSync(temporary, options.ready);
    } finally { if (exists(temporary)) rmSync(temporary); }
    return { ...ready, stop };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Native E2E start and cleanup failed'); }
    throw error;
  }
}

function parseArgs(argv: string[]): BackendOptions {
  const values = new Map<string, string>();
  const names = ['--origin', '--control-port', '--allow-email', '--root', '--ready'];
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]!, value = argv[index + 1];
    if (!names.includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('Invalid backend arguments');
    values.set(key, value);
  }
  if (values.size !== names.length || !/^\d+$/.test(values.get('--control-port')!)) throw new Error('Missing backend arguments');
  return { origin: values.get('--origin')!, controlPort: Number(values.get('--control-port')), allowEmail: values.get('--allow-email')!,
    root: values.get('--root')!, ready: values.get('--ready')!, controlToken: process.env.E2E_CONTROL_TOKEN ?? '' };
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let signalCode = 0;
  const interrupt = () => { if (!signalCode) { signalCode = 130; controller.abort(); } };
  const terminate = () => { if (!signalCode) { signalCode = 143; controller.abort(); } };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  try {
    backend = await startBackend(parseArgs(process.argv.slice(2)), controller.signal);
    if (!controller.signal.aborted) await new Promise<void>(done => controller.signal.addEventListener('abort', () => done(), { once: true }));
  } catch { process.exitCode = signalCode || 1; console.error('Native E2E backend failed'); }
  finally {
    try { await backend?.stop(); } catch { process.exitCode ||= 1; console.error('Native E2E backend cleanup failed'); }
    process.exitCode ||= signalCode;
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
