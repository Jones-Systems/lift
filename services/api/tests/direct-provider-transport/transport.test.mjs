import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectProviderTransport } from '../../src/wearables/direct-provider-transport/index.ts';
import { createOuraReadPort } from '../../src/wearables/providers/oura.ts';
import { createGarminPort } from '../../src/wearables/providers/garmin.ts';
import { createProviderOAuth } from '../../src/wearables/providers/oauth.ts';
import { ProviderFailure } from '../../src/wearables/providers/http.ts';

const admission = { assertAllowed() {}, assertCurrent() {} };
const scope = { accountId: 'invented-account', sessionId: 'invented-session', epoch: 2, connectionId: 'invented-connection', generation: 3, provider: 'oura' };
const redirect = 'https://form.invalid/oauth/callback';
const projections = {
  daily_activity: 'id,day,timestamp,steps,active_calories', daily_readiness: 'id,day,timestamp,score',
  daily_sleep: 'id,day,timestamp,score', sleep: 'id,day,bedtime_start,bedtime_end,total_sleep_duration,time_in_bed,sleep_algorithm_version',
  workout: 'id,day,start_datetime,end_datetime,activity,calories,distance,intensity,source',
};
const read = (collection = 'daily_activity') => ({ method: 'GET', url: 'https://api.ouraring.com/v2/usercollection/' + collection + '?' + new URLSearchParams({ start_date: '2026-10-09', end_date: '2026-10-10', fields: projections[collection] }), headers: { Accept: 'application/json' }, bearerSecretRef: 'invented-access-ref' });
const refresh = (provider = 'oura') => ({ method: 'POST', url: provider === 'oura' ? 'https://api.ouraring.com/oauth/token' : 'https://connectapi.garmin.com/di-oauth2-service/oauth/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, form: { grant_type: 'refresh_token', client_id: 'invented-client' }, secretFormFields: { client_secret: 'invented-client-ref', refresh_token: 'invented-refresh-ref' } });
const registration = (method = 'GET', path = 'id') => ({ method, url: 'https://apis.garmin.com/wellness-api/rest/user/' + path, headers: { Accept: 'application/json' }, bearerSecretRef: 'invented-access-ref' });
const effect = expected => error => error instanceof ProviderFailure && error.effect === expected && error.message === 'provider_transport';
function harness({ provider = 'oura', body = '{"data":[],"next_token":null}', status = 200, headers = [['Content-Type', 'application/json']], limits, transport, acquire } = {}) {
  const state = { current: true, calls: [], leases: [], cancelled: 0, scopeChecks: [], reads: 0 };
  const response = { status, headers, async read(max, signal) { assert.equal(signal.aborted, false); state.reads++; return state.reads === 1 && body.length ? new TextEncoder().encode(body) : null; }, cancel() { state.cancelled++; } };
  const http = createDirectProviderTransport({ scope: { ...scope, provider }, allowedRedirectUris: [redirect], limits,
    assertCurrent(bound) { state.scopeChecks.push(bound); if (!state.current) throw Error('invented stale secret detail'); },
    secrets: { async acquire(bound, ref, purpose, signal) {
      assert.deepEqual(bound, { ...scope, provider }); assert.equal(signal.aborted, false);
      const record = { ref, purpose, releases: 0 }; state.leases.push(record);
      if (acquire) return acquire(state, record, signal);
      return { value: purpose === 'code_verifier' ? 'v'.repeat(43) : 'invented-' + purpose, release() { record.releases++; } };
    } },
    async transport(request) { state.calls.push(request); return transport ? transport(state, response, request) : response; },
  });
  return { state, http, response };
}

test('all exact Oura projections pass through unchanged decoder with scoped bearer and cleanup', async () => {
  for (const collection of Object.keys(projections)) {
    const h = harness();
    const port = createOuraReadPort({ http: h.http, accessSecretRef: 'invented-access-ref', now: () => 0, admission });
    assert.deepEqual(await port.read(collection, { from: '2026-10-09', to: '2026-10-10', nextToken: 'opaque&=token' }), { records: [], nextToken: null });
    const request = h.state.calls[0];
    assert.equal(request.headers.authorization, 'Bearer invented-access_token'); assert.equal(request.redirect, 'error');
    assert.equal(new URL(request.url).searchParams.get('next_token'), 'opaque&=token');
    assert.equal(request.signal.aborted, true); assert.equal(h.state.cancelled, 1); assert.equal(h.state.leases[0].releases, 1);
    assert.ok(h.state.scopeChecks.length >= 8); assert.ok(Object.isFrozen(h.state.scopeChecks[0]));
  }
});

test('URL, method, projection, header and form allowlists reject before secret lookup or dispatch', async () => {
  const base = read();
  const bad = [
    { url: base.url.replace('https:', 'http:') }, { url: base.url.replace('api.ouraring.com', 'api.ouraring.com.evil.invalid') },
    { url: base.url.replace('api.ouraring.com', 'user:pass@api.ouraring.com') }, { url: base.url.replace('api.ouraring.com', 'api.ouraring.com:444') },
    { url: base.url.replace('/daily_activity?', '/../usercollection/daily_activity?') }, { url: base.url.replace('daily_activity?', '%64aily_activity?') },
    { url: base.url + '&extra=1' }, { url: base.url + '&start_date=2026-10-09' }, { url: base.url + '#x' },
    { url: base.url.replace('2026-10-09', '2026-02-30') }, { url: base.url.replace('2026-10-09', '2026-10-11') },
    { url: base.url.replace('steps', 'secret_field') }, { method: 'PUT' }, { method: 'DELETE' },
    { headers: { Accept: 'application/json', Authorization: 'invented-bypass' } }, { headers: { Accept: 'application/json', accept: 'application/json' } },
    { headers: { Accept: 'application/json\r\nX: a' } }, { redirect: 'follow' }, { form: {} }, { secretFormFields: {} },
  ];
  for (const changes of bad) {
    const h = harness(); await assert.rejects(h.http.request({ ...base, ...changes }), effect('none'));
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.leases.length, 0);
  }
  for (const changes of [{ form: { ...refresh().form, client_secret: 'invented-plaintext' } }, { secretFormFields: { client_secret: 'ref', code: 'ref' } }, { bearerSecretRef: 'ref' }]) {
    const h = harness(); await assert.rejects(h.http.request({ ...refresh(), ...changes }), effect('none')); assert.equal(h.state.leases.length, 0);
  }
});

test('Garmin public registration paths work, empty deregistration succeeds, private paths stay denied', async () => {
  const h = harness({ provider: 'garmin', body: '{"userId":"invented-garmin-user"}' });
  const port = createGarminPort({ http: h.http, accessSecretRef: 'invented-access-ref', now: () => 0, admission });
  assert.deepEqual(await port.userId(), { userId: 'invented-garmin-user' });
  const empty = harness({ provider: 'garmin', body: '', status: 204, headers: [] });
  assert.deepEqual(await createGarminPort({ http: empty.http, accessSecretRef: 'invented-ref', now: () => 0, admission }).deregister(), { remoteDeregistration: 'confirmed' });
  const permissions = harness({ provider: 'garmin', body: '[]' });
  assert.deepEqual(await permissions.http.request(registration('GET', 'permissions')).then(r => r.body), []);
  for (const request of [registration('GET', 'registration'), registration('POST', 'registration'), registration('GET', 'id?extra=1'), registration('GET', '../dailies'), read()]) {
    const denied = harness({ provider: 'garmin' }); await assert.rejects(denied.http.request(request), effect('none')); assert.equal(denied.state.calls.length, 0);
  }
});

test('existing OAuth consumes both providers, exact code/refresh fields, and inventively scoped leases', async () => {
  for (const provider of ['oura', 'garmin']) for (const kind of ['code', 'refresh']) {
    const h = harness({ provider, body: '{"access_token":"invented-access","refresh_token":"invented-refresh","token_type":"bearer","expires_in":17}' });
    let commits = 0;
    const port = createProviderOAuth({ provider, clientId: 'invented-client', clientSecretRef: 'invented-client-ref', http: h.http, now: () => 0, admission,
      consumeCallback() { return { operationId: 'invented-op', verifierRef: 'invented-verifier-ref', redirectUri: redirect }; },
      vault: { begin() { return { id: 'invented-lease', secretRef: 'invented-refresh-ref', redirectUri: redirect }; }, commit(id, tokens) { commits++; assert.equal(tokens.expires_in, 17); return { accessSecretRef: 'invented-next-ref', version: 2 }; }, rejected() { assert.fail('unexpected rejection'); }, unknown() { assert.fail('unexpected unknown'); } },
    });
    if (kind === 'code') await port.completeCode('invented-state', 'invented+code&='); else await port.refresh('invented-op');
    assert.equal(commits, 1); const form = new URLSearchParams(h.state.calls[0].body);
    assert.equal(form.get('client_secret'), 'invented-client_secret'); assert.equal(form.get('grant_type'), kind === 'code' ? 'authorization_code' : 'refresh_token');
    if (kind === 'code') { assert.equal(form.get('code'), 'invented+code&='); assert.equal(form.get('code_verifier'), 'v'.repeat(43)); }
    assert.equal(h.state.leases.length, 2); assert.ok(h.state.leases.every(lease => lease.releases === 1));
  }
});

test('unregistered redirect and cross-provider token hosts deny before secret access', async () => {
  const h = harness();
  await assert.rejects(h.http.request({ ...refresh(), form: { grant_type: 'authorization_code', client_id: 'invented-client', code: 'invented-code', redirect_uri: 'https://elsewhere.invalid/callback' }, secretFormFields: { client_secret: 'ref', code_verifier: 'ref' } }), effect('none'));
  await assert.rejects(h.http.request(refresh('garmin')), effect('none')); assert.equal(h.state.leases.length, 0);
});

test('stale original account/session/epoch/generation stops before dispatch and after each secret await', async () => {
  const stale = harness(); stale.state.current = false;
  await assert.rejects(stale.http.request(read()), effect('none')); assert.equal(stale.state.leases.length, 0);
  const late = harness({ acquire(state, record) { state.current = false; return { value: 'invented-token', release() { record.releases++; } }; } });
  await assert.rejects(late.http.request(refresh()), effect('none')); assert.equal(late.state.calls.length, 0); assert.equal(late.state.leases[0].releases, 1);
});

test('stale response and stale body read discard results and retain possible mutation as unknown', async () => {
  for (const phase of ['dispatch', 'read']) for (const method of ['GET', 'POST']) {
    const h = harness({ transport(state, response) {
      if (phase === 'dispatch') state.current = false;
      else response.read = async () => { state.current = false; return new TextEncoder().encode('{}'); };
      return response;
    } });
    await assert.rejects(h.http.request(method === 'GET' ? read() : refresh()), effect(method === 'GET' ? 'none' : 'unknown'));
    assert.equal(h.state.cancelled, 1); assert.ok(h.state.leases.every(lease => lease.releases === 1));
  }
});

test('malformed/oversized/redirect/error responses cancel and never expose payloads or transport errors', async () => {
  for (const options of [
    { body: '{invented-sensitive' }, { body: '' }, { status: 302 }, { status: 503 }, { status: 400 },
    { headers: [['content-type', 'text/html']] }, { headers: [['content-type', 'application/json'], ['Content-Type', 'application/json']] },
    { headers: [['content-length', '999999999']] }, { headers: [['bad\r\nname', 'value']] },
    { limits: { responseBytes: 4 }, body: '{"x":1234}' }, { limits: { readCount: 1 } },
  ]) {
    const h = harness(options); await assert.rejects(h.http.request(refresh()), effect('unknown'));
    assert.equal(h.state.calls.length, 1); assert.equal(h.state.cancelled, 1); assert.ok(h.state.leases.every(lease => lease.releases === 1));
  }
  const h = harness({ transport() { throw Error('invented private token payload'); } });
  await assert.rejects(h.http.request(refresh()), effect('unknown')); assert.equal(h.state.calls.length, 1);
});

test('GET rate-limit headers normalize for existing provider scheduler without retries', async () => {
  const h = harness({ status: 429, headers: [['Content-Type', 'application/json'], ['Retry-After', '12']], body: '{}' });
  const port = createOuraReadPort({ http: h.http, accessSecretRef: 'invented-ref', now: () => 0, admission });
  await assert.rejects(port.read('daily_sleep', { from: '2026-10-09', to: '2026-10-10', nextToken: null }), e => e.retryAfterMs === 12000);
  assert.equal(h.state.calls.length, 1);
});

test('request byte bounds and invalid bearer prevent dispatch and release acquired secret', async () => {
  const h = harness({ limits: { requestBytes: 1 } }); await assert.rejects(h.http.request(read()), effect('none')); assert.equal(h.state.leases.length, 0);
  const bad = harness({ acquire(state, record) { return { value: 'invented\r\nAuthorization: other', release() { record.releases++; } }; } });
  await assert.rejects(bad.http.request(read()), effect('none')); assert.equal(bad.state.calls.length, 0); assert.equal(bad.state.leases[0].releases, 1);
});

test('deadline aborts pending dispatch; late response cancels once and mutation stays unknown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveTransport; let started;
  const dispatchStarted = new Promise(resolve => { started = resolve; });
  const h = harness({ limits: { timeoutMs: 5 }, transport() { started(); return new Promise(resolve => { resolveTransport = resolve; }); } });
  const pending = h.http.request(refresh()); const rejected = assert.rejects(pending, effect('unknown'));
  await dispatchStarted; t.mock.timers.tick(5); await rejected;
  assert.equal(h.state.calls[0].signal.aborted, true); assert.ok(h.state.leases.every(lease => lease.releases === 1));
  let cancelled; const cleanup = new Promise(resolve => { cancelled = resolve; });
  h.response.cancel = () => { h.state.cancelled++; cancelled(); };
  resolveTransport(h.response); await cleanup;
  assert.equal(h.state.cancelled, 1);
});

test('deadline during secret acquisition releases late lease and never dispatches', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveSecret; let started; const acquired = new Promise(resolve => { started = resolve; });
  const h = harness({ limits: { timeoutMs: 5 }, acquire() { started(); return new Promise(resolve => { resolveSecret = resolve; }); } });
  const pending = h.http.request(read()); const rejected = assert.rejects(pending, effect('none'));
  await acquired; t.mock.timers.tick(5); await rejected;
  let released = 0; let cleaned; const cleanup = new Promise(resolve => { cleaned = resolve; });
  resolveSecret({ value: 'invented-late-token', release() { released++; cleaned(); } }); await cleanup;
  assert.equal(released, 1); assert.equal(h.state.calls.length, 0);
});

test('deadline during body read cancels response and releases leases without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started; const reading = new Promise(resolve => { started = resolve; });
  const h = harness({ limits: { timeoutMs: 5 }, transport(state, response) { response.read = () => { started(); return new Promise(() => {}); }; return response; } });
  const pending = h.http.request(refresh()); const rejected = assert.rejects(pending, effect('unknown'));
  await reading; t.mock.timers.tick(5); await rejected;
  assert.equal(h.state.cancelled, 1); assert.ok(h.state.leases.every(lease => lease.releases === 1)); assert.equal(h.state.calls.length, 1);
});
