import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { startSettingsSmoke, fixtureIdentity } from '../scripts/native/settings-smoke.mjs';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('native fixture serves real Settings on loopback, with persistent mode and no staged lifecycle', async () => {
  const fixture = await startSettingsSmoke({ port: await freePort() });
  try {
    const response = await fetch(fixture.baseURL + '/api/auth/sign-in/email', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: fixture.baseURL }, body: JSON.stringify({ email: fixtureIdentity.email, password: fixtureIdentity.password }) });
    assert.equal(response.status, 200);
    const token = response.headers.get('set-auth-token'); assert.ok(token);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const me = await (await fetch(fixture.baseURL + '/v1/me', { headers })).json();
    assert.equal(me.onboarding.status, 'completed'); assert.equal(me.preferences.appMode, 'basic');
    const write = await fetch(fixture.baseURL + '/v1/me/preferences', { method: 'PATCH', headers,
      body: JSON.stringify({ expectedRevision: me.preferences.revision, appMode: 'advanced' }) });
    assert.equal(write.status, 200);
    const settings = await (await fetch(fixture.baseURL + '/v1/me/settings', { headers })).json();
    assert.equal(settings.stagedAccountLifecycle.status, 'unavailable');
    const after = await (await fetch(fixture.baseURL + '/v1/me', { headers })).json();
    assert.equal(after.preferences.appMode, 'advanced');
    const lifecycle = await fetch(fixture.baseURL + '/v1/me/account-action-grants', { method: 'POST', headers,
      body: JSON.stringify({ purpose: 'account_export', password: fixtureIdentity.password }) });
    assert.equal(lifecycle.status, 501);
  } finally { await fixture.stop(); }
  assert.equal(existsSync(fixture.ownedRoot), false);
  assert.deepEqual(await fixture.closed, { clean: true });
  await assert.rejects(fetch(fixture.baseURL + '/v1/capabilities'));
});

test('native fixture expires and closes its exact synthetic storage', async () => {
  const fixture = await startSettingsSmoke({ port: await freePort(), lifetimeMs: 100 });
  assert.deepEqual(await fixture.closed, { clean: true });
  assert.equal(existsSync(fixture.ownedRoot), false);
});

test('occupied native fixture port fails without retaining its synthetic database', async () => {
  const parent = new URL('../.scratch/', import.meta.url);
  const before = new Set(readdirSync(parent).filter(x => x.startsWith('native-settings-')));
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(startSettingsSmoke({ port: server.address().port }), { code: 'EADDRINUSE' }); }
  finally { await new Promise(resolve => server.close(resolve)); }
  assert.deepEqual(new Set(readdirSync(parent).filter(x => x.startsWith('native-settings-'))), before);
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`native fixture ${signal} closes listener and owned scratch`, { timeout: 10_000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { fileURLToPath } = await import('node:url');
  const parent = new URL('../.scratch/', import.meta.url);
  const before = new Set(readdirSync(parent).filter(x => x.startsWith('native-settings-')));
  const child = spawn(process.execPath, ['--experimental-transform-types', '--import',
    fileURLToPath(new URL('../scripts/integration/source-hook.mjs', import.meta.url)),
    fileURLToPath(new URL('../scripts/native/settings-smoke.mjs', import.meta.url)), String(await freePort()), '30'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  const exited = once(child, 'exit');
  const line = await new Promise((yes, no) => {
    let text = '';
    child.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) yes(text.split('\n')[0]); });
    child.once('error', no);
    child.once('exit', () => no(new Error('Fixture exited before ready')));
  });
  const ready = JSON.parse(line);
  assert.equal(ready.synthetic, true); assert.equal(ready.source.apiSourceSha256.length, 64);
  child.kill(signal); assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(new Set(readdirSync(parent).filter(x => x.startsWith('native-settings-'))), before);
  await assert.rejects(fetch(ready.baseURL + '/v1/capabilities'));
});
