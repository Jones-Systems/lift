/** Synthetic-only loopback runtime for the existing native Settings journey.
 * Run from services/api with Node24, --experimental-transform-types and
 * --import ./scripts/integration/source-hook.mjs. Never a production entrypoint.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, chmodSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createServer } from '../../src/server.ts';

export const fixtureIdentity = Object.freeze({
  name: 'Synthetic native Settings', email: 'native-settings@synthetic.invalid',
  password: 'Synthetic-native-Settings-only-2026',
});
const apiRoot = fileURLToPath(new URL('../../', import.meta.url));

export async function startSettingsSmoke({ port = 48766, lifetimeMs = 600_000 } = {}) {
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Explicit unprivileged port required');
  assert.ok(Number.isInteger(lifetimeMs) && lifetimeMs >= 100 && lifetimeMs <= 1_800_000, 'Lifetime must be100ms–30min');
  const baseURL = `http://127.0.0.1:${port}`;
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const sourceFiles = [];
  function inventory(directory) {
    for (const entry of readdirSync(join(apiRoot, directory), { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Synthetic source may not contain symlinks');
      const file = directory + '/' + entry.name;
      if (entry.isDirectory()) inventory(file);
      else if (entry.isFile()) sourceFiles.push([file, sha(readFileSync(join(apiRoot, file)))]);
    }
  }
  // Record exact executed TypeScript inputs, not possibly stale dist outputs.
  inventory('src'); sourceFiles.sort(([a], [b]) => a.localeCompare(b));
  const source = { apiSourceSha256: sha(JSON.stringify(sourceFiles)), files: sourceFiles.length,
    lockSha256: sha(readFileSync(join(apiRoot, 'package-lock.json'))),
    runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))) };
  const parent = join(apiRoot, '.scratch'); mkdirSync(parent, { recursive: true });
  const ownedRoot = mkdtempSync(join(parent, 'native-settings-')); chmodSync(ownedRoot, 0o700);
  let backend, listener, timer, stopping, startup;
  const requests = new Set();
  let resolveClosed;
  let stopped = false;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const stop = () => stopping ??= (async () => {
    stopped = true;
    clearTimeout(timer);
    await startup?.catch(() => {});
    const failures = [];
    if (listener) {
      listener.closeAllConnections();
      await new Promise(yes => listener.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') failures.push(error);
        yes();
      }));
    }
    await Promise.allSettled([...requests]);
    try { if (backend) await backend.close(false); } catch (error) { failures.push(error); }
    // Never remove a database still held open after failed close.
    try {
      if (backend?.db.open) throw new Error('Synthetic database still open');
      rmSync(ownedRoot, { recursive: true });
    } catch (error) { failures.push(error); }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    resolveClosed({ clean: failures.length === 0 });
    if (failures.length) throw new AggregateError(failures, 'Synthetic cleanup failed');
  })();
  const interrupt = () => { void stop().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  startup = (async () => {
    backend = await createServer({ dbPath: join(ownedRoot, 'synthetic.sqlite'), baseURL,
      secret: randomBytes(48).toString('base64url'),
      registration: { mode: 'allowlist', emails: [fixtureIdentity.email] },
    });
    async function request(path, method, body, token, key) {
      const response = await backend.handleRequest(new Request(baseURL + path, { method,
        headers: { origin: baseURL, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(key ? { 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }), '127.0.0.1');
      assert.ok(response.ok, `Synthetic seed failed: ${path} ${response.status}`);
      return { value: await response.json(), token: response.headers.get('set-auth-token') };
    }
    const signup = await request('/api/auth/sign-up/email', 'POST', fixtureIdentity);
    assert.ok(signup.token, 'Signed synthetic session required');
    const account = (await request('/v1/me', 'GET', null, signup.token)).value;
    const draft = (await request('/v1/me/onboarding', 'PATCH', {
      expectedRevision: account.onboarding.revision, step: 'review',
      answers: { goals: ['Get stronger'], trainingBackground: 'returning' }, preferences: { equipment: ['Dumbbells'] },
    }, signup.token)).value;
    await request('/v1/me/onboarding/complete', 'POST', { expectedRevision: draft.revision }, signup.token, 'synthetic-native-onboarding');
    await request('/api/auth/sign-out', 'POST', {}, signup.token);
    if (stopped) throw new Error('Synthetic startup cancelled');
    await new Promise((yes, no) => {
      listener = serve({ hostname: '127.0.0.1', port,
        fetch: (request, env) => {
          if (stopped) return new Response('Synthetic fixture closing', { status: 503 });
          const pending = Promise.resolve().then(() => backend.handleRequest(request, env.incoming.socket.remoteAddress ?? '127.0.0.1'));
          requests.add(pending);
          return pending.finally(() => requests.delete(pending));
        },
      }, yes);
      listener.once('error', no);
    });
  })();
  try {
    await startup;
    if (stopped) throw new Error('Synthetic startup cancelled');
    timer = setTimeout(interrupt, lifetimeMs);
    return { baseURL, ownedRoot, identity: fixtureIdentity, closed, stop,
      evidence: { schema: 'form.synthetic-native-settings/v1', baseURL, lifetimeMs, source,
        synthetic: true, providers: 'unconfigured', publicLifecycle: false, nativeAcceptance: false } };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Synthetic startup and cleanup failed'); }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length <= 4, 'Usage: settings-smoke.mjs [port] [lifetime-seconds]');
  const fixture = await startSettingsSmoke({ port: Number(process.argv[2] ?? 48766), lifetimeMs: Number(process.argv[3] ?? 600) * 1000 });
  process.stdout.write(JSON.stringify({ ...fixture.evidence, identity: fixture.identity }) + '\n');
  await fixture.closed;
}
