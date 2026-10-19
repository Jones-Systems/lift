import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createFormOAuthResourceHandler, FormAuthorizationError } from '../src/oauth-resource.mjs';
import { createFormMcpHandler } from '../src/mcp-handler.mjs';
import { oauthFixture, oauthRequest, resourceUrl, issuer, scopes, expiresAtMs, listRequest, callRequest, wire } from './oauth-fixtures.mjs';

test('OAuth default and every missing binding deny without admission, verification or data calls', async () => {
  for (const change of [{ enabled: false }, { verifyAccessToken: undefined }, { bindAuthorization: undefined },
    { dependencies: undefined }, { dependencies: {} }, { admitRequest: undefined }, { issuer: undefined },
    { authorizationServerMetadata: undefined }, { allowedHosts: [] }, { resourceUrl: 'http://form.example/mcp' }]) {
    const f = oauthFixture(change), handler = createFormOAuthResourceHandler(f.options);
    try { assert.equal((await handler.fetch(oauthRequest())).status, 503); }
    finally { await handler.close(); }
    assert.equal(f.state.admissions + f.state.verifies + f.state.binds + f.state.reads, 0);
  }
  const handler = createFormOAuthResourceHandler();
  try { assert.equal((await handler.fetch(oauthRequest())).status, 503); } finally { await handler.close(); }
});

test('protected metadata is path-specific public configuration and missing bearer receives discovery challenge', async () => {
  const f = oauthFixture(), handler = createFormOAuthResourceHandler(f.options);
  const metadataUrl = 'https://form.example/.well-known/oauth-protected-resource/mcp';
  try {
    const metadata = await handler.fetch(oauthRequest(null, {}, metadataUrl, 'GET'));
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), { resource: resourceUrl, authorization_servers: [issuer], scopes_supported: scopes });
    assert.equal(f.state.admissions + f.state.verifies + f.state.binds + f.state.reads, 0);
    const request = oauthRequest(); request.headers.delete('authorization');
    const missing = await handler.fetch(request);
    assert.equal(missing.status, 401);
    assert.ok(missing.headers.get('www-authenticate').includes(`resource_metadata="${metadataUrl}"`));
    assert.equal((await handler.fetch(oauthRequest(null, {}, metadataUrl, 'POST'))).status, 405);
    assert.equal((await handler.fetch(oauthRequest(null, {}, 'https://form.example/.well-known/oauth-authorization-server', 'GET'))).status, 404);
    assert.equal((await handler.fetch(oauthRequest(null, { host: 'evil.example' }, metadataUrl, 'GET'))).status, 403);
    assert.equal((await handler.fetch(oauthRequest(null, {}, `${resourceUrl}?account=other`))).status, 404);
    assert.equal(f.state.verifies + f.state.reads, 0);
  } finally { await handler.close(); }
});

test('token shape, issuer, audience, expiry and safe verifier failure reject before mapping or reads', async () => {
  for (const patch of [{ issuer: 'https://other.example/' }, { resource: 'https://other.example/mcp' },
    { subject: '' }, { expiresAtMs: 0 }, { expiresAtMs: Infinity }, { scopes: ['bad scope'] }]) {
    const f = oauthFixture(), original = f.options.verifyAccessToken;
    f.options.verifyAccessToken = (...args) => ({ ...original(...args), ...patch });
    const handler = createFormOAuthResourceHandler(f.options);
    try { assert.equal((await handler.fetch(oauthRequest(callRequest()))).status, 401); }
    finally { await handler.close(); }
    assert.equal(f.state.binds + f.state.reads, 0);
  }
  const f = oauthFixture({ verifyAccessToken() { throw new Error('SYNTHETIC_SECRET'); } });
  const handler = createFormOAuthResourceHandler(f.options);
  try {
    for (const authorization of ['Bearer one, Bearer two', 'Bearer one extra', 'Basic synthetic']) {
      assert.equal((await handler.fetch(oauthRequest(callRequest(), { authorization }))).status, 401);
    }
    const rejected = await handler.fetch(oauthRequest());
    assert.equal(rejected.status, 500);
    assert.ok(!(await rejected.text()).includes('SYNTHETIC_SECRET'));
    assert.equal(f.state.binds + f.state.reads, 0);
  } finally { await handler.close(); }
});

for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`OAuth offline official client, raw metadata and scoped reads (${JSON.stringify(mode)})`, async () => {
  const f = oauthFixture(), handler = createFormOAuthResourceHandler(f.options);
  let raw;
  const client = new Client({ name: 'form-oauth-offline', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(resourceUrl), { fetch: async (input, init) => {
    const request = new Request(input, init);
    request.headers.set('host', 'form.example'); request.headers.set('authorization', 'Bearer synthetic-a');
    const body = request.method === 'POST' ? await request.clone().json() : null;
    const response = await handler.fetch(request);
    if (body?.method === 'tools/list') raw = await wire(response.clone());
    return response;
  } });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 5);
    for (const descriptor of raw.result.tools) assert.deepEqual(descriptor.securitySchemes, descriptor._meta.securitySchemes);
    const result = await client.callTool({ name: 'form_get_workout', arguments: { workoutId: 'workout_1' } });
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.data.sets[0].status, 'voided');
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE'));
    assert.deepEqual(f.state.seen, ['account_a']);
    assert.deepEqual(f.state.guards, ['authority-before', 'account-before', 'account-after', 'authority-after']);
  } finally { await client.close(); await handler.close(); }
});

test('per-tool scope denial challenges only that permission and never reads data', async () => {
  for (const [name, args, granted, expected] of [
    ['form_get_workout', { workoutId: 'workout_1' }, [scopes[1]], scopes[0]],
    ['form_get_plan', { planId: 'plan_1' }, [scopes[0]], scopes[1]],
  ]) {
    const f = oauthFixture(), original = f.options.verifyAccessToken;
    f.options.verifyAccessToken = (...args) => ({ ...original(...args), scopes: granted });
    const handler = createFormOAuthResourceHandler(f.options);
    try {
      const response = await handler.fetch(oauthRequest(callRequest(name, args)));
      assert.equal(response.status, 403);
      assert.ok(response.headers.get('www-authenticate').includes(`scope="${expected}"`));
      assert.ok(!response.headers.get('www-authenticate').includes(`scope="${granted[0]}"`));
      assert.equal(f.state.reads, 0);
    } finally { await handler.close(); }
  }
});

test('external OAuth subjects map explicitly and concurrent requests never share Form authority', async () => {
  const f = oauthFixture(), handler = createFormOAuthResourceHandler(f.options);
  try {
    const body = callRequest(); body.params._meta = { 'openai/subject': 'account_evil' };
    const results = await Promise.all(['a', 'b'].map(key => handler.fetch(oauthRequest(body,
      { authorization: `Bearer synthetic-${key}` })).then(wire)));
    assert.ok(results.every(value => value.result.structuredContent.ok));
    assert.deepEqual(f.state.seen.sort(), ['account_a', 'account_b']);
    assert.ok(results.every(value => !JSON.stringify(value).includes('external|')));
  } finally { await handler.close(); }
});

test('stale or forged Form binding and added consent scopes cannot reach Domain', async () => {
  for (const patch of [{ formAuthUserId: 'external|a' }, { accountId: 'account_b' }, { expiresAtMs: 1 },
    { expiresAtMs: Infinity }, { scopes: [...scopes, 'form:write'] }, { assertCurrent: () => false }]) {
    const f = oauthFixture(), bind = f.options.bindAuthorization;
    f.options.bindAuthorization = token => ({ ...bind(token), ...patch });
    const handler = createFormOAuthResourceHandler(f.options);
    try { assert.ok((await handler.fetch(oauthRequest(callRequest()))).status >= 400); }
    finally { await handler.close(); }
    assert.equal(f.state.reads, 0);
  }
});

test('revoked authority before, during and after a read suppresses all buffered data', async () => {
  for (const point of ['before', 'during', 'disclosure']) {
    const f = oauthFixture();
    if (point === 'before') f.state.current = false;
    if (point === 'during') f.state.afterRead = () => { f.state.current = false; };
    if (point === 'disclosure') {
      const bind = f.options.bindAuthorization;
      f.options.bindAuthorization = token => ({ ...bind(token), assertCurrent() { return ++f.state.checks < 3; } });
    }
    const handler = createFormOAuthResourceHandler(f.options);
    try {
      const response = await handler.fetch(oauthRequest(callRequest()));
      assert.equal(response.status, point === 'during' ? 200 : 401);
      const body = await response.text();
      assert.ok(!body.includes('workout_1')); assert.ok(!body.includes('sets'));
      if (point === 'during') assert.ok(body.includes('mcp/www_authenticate'));
      assert.equal(f.state.reads, point === 'before' ? 0 : 1);
    } finally { await handler.close(); }
  }
});

test('unavailable and account-denied authority are safe errors without false reauthorization challenge', async () => {
  for (const [failure, status] of [[new Error('SYNTHETIC_SECRET'), 503], [new FormAuthorizationError('account_unavailable'), 403]]) {
    const f = oauthFixture({ bindAuthorization() { throw failure; } }), handler = createFormOAuthResourceHandler(f.options);
    try {
      const response = await handler.fetch(oauthRequest(callRequest()));
      assert.equal(response.status, status); assert.equal(response.headers.get('www-authenticate'), null);
      assert.ok(!(await response.text()).includes('SYNTHETIC_SECRET')); assert.equal(f.state.reads, 0);
    } finally { await handler.close(); }
  }
});

test('authority read closure rejects missing, repeated, asynchronous and substituted results', async () => {
  for (const [guard, reads] of [[() => null, 0], [(_, read) => { read(); return read(); }, 1], [async (_, read) => read(), 1],
    [async (_, read) => { await Promise.resolve(); return read(); }, 0], [(_, read) => { read(); return {}; }, 1]]) {
    const f = oauthFixture(), bind = f.options.bindAuthorization;
    f.options.bindAuthorization = token => ({ ...bind(token), withCurrentRead: guard });
    const handler = createFormOAuthResourceHandler(f.options);
    try {
      const response = await handler.fetch(oauthRequest(callRequest()));
      assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('workout_1'));
      assert.equal(f.state.reads, reads);
    } finally { await handler.close(); }
  }
});

test('one shared admission limit covers pending OAuth bindings and close denies their eventual responses', async () => {
  const f = oauthFixture(), bind = f.options.bindAuthorization;
  let release; const pending = new Promise(resolve => { release = resolve; });
  f.options.bindAuthorization = async token => { await pending; return bind(token); };
  const handler = createFormOAuthResourceHandler(f.options);
  const requests = Array.from({ length: 8 }, () => handler.fetch(oauthRequest(callRequest())));
  try {
    assert.equal((await handler.fetch(oauthRequest(callRequest()))).status, 429);
    await handler.close(); release();
    const results = await Promise.all(requests);
    assert.ok(results.every(response => response.status === 503));
    assert.equal(f.state.reads, 0);
  } finally { release(); await Promise.allSettled(requests); await handler.close(); }
});

test('ambiguous legacy and authoritative identity configuration remains disabled', async () => {
  let calls = 0;
  const handler = createFormMcpHandler({ enabled: true, allowedHosts: ['form.example'], admitRequest: () => true,
    verifyRequest() { calls++; }, authorizeRequest() { calls++; } });
  try { assert.equal((await handler.fetch(oauthRequest())).status, 503); assert.equal(calls, 0); }
  finally { await handler.close(); }
});

test('expiry or close during the final authority check prevents disclosure', async () => {
  for (const action of ['expiry', 'close', 'abort']) {
    let clock = Date.now(), entered, release;
    const finalCheck = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const f = oauthFixture({ now: () => clock }), bind = f.options.bindAuthorization;
    f.options.bindAuthorization = token => ({ ...bind(token), async assertCurrent() {
      if (++f.state.checks === 3) { entered(); await pending; }
      return true;
    } });
    const handler = createFormOAuthResourceHandler(f.options), controller = new AbortController();
    const request = new Request(oauthRequest(callRequest()), { signal: controller.signal });
    const result = handler.fetch(request);
    let timer;
    try {
      await Promise.race([finalCheck, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Final authority checkpoint was not reached')), 5000);
      })]);
      clearTimeout(timer);
      if (action === 'expiry') clock = expiresAtMs;
      if (action === 'close') await handler.close();
      if (action === 'abort') controller.abort();
      release();
      const response = await result;
      assert.equal(response.status, action === 'expiry' ? 401 : 503);
      assert.ok(!(await response.text()).includes('workout_1'));
      assert.equal(f.state.reads, 1);
    } finally { clearTimeout(timer); release(); await result; await handler.close(); }
  }
});

for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`raw OAuth tool errors discard data and preserve fresh denial (${JSON.stringify(mode)})`, async () => {
  for (const scenario of ['invalid_token', 'insufficient_scope', 'account', 'backend', 'late-account', 'late-backend', 'late-auth-change']) {
    const f = oauthFixture(), bind = f.options.bindAuthorization;
    f.options.bindAuthorization = token => {
      const binding = bind(token);
      return { ...binding, assertCurrent() {
        const check = ++f.state.checks;
        if (check === 3 && scenario.startsWith('late-')) {
          if (scenario === 'late-account') throw new FormAuthorizationError('account_unavailable');
          if (scenario === 'late-backend') throw new Error('SYNTHETIC_PROVIDER_SECRET');
          throw new FormAuthorizationError('insufficient_scope');
        }
        return true;
      }, withCurrentRead(context, read) {
        binding.withCurrentRead(context, read);
        if (scenario === 'account') throw new FormAuthorizationError('account_unavailable');
        if (scenario === 'backend') throw new Error('SYNTHETIC_PROVIDER_SECRET');
        throw new FormAuthorizationError(scenario === 'insufficient_scope' ? scenario : 'invalid_token');
      } };
    };
    const handler = createFormOAuthResourceHandler(f.options);
    const body = callRequest();
    if (mode !== 'legacy') body.params._meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const headers = mode === 'legacy' ? {} : {
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': body.method, 'Mcp-Name': body.params.name,
    };
    try {
      const response = await handler.fetch(oauthRequest(body, headers));
      const raw = await wire(response), serialized = JSON.stringify(raw);
      assert.equal(f.state.reads, 1);
      assert.ok(!serialized.includes('workout_1')); assert.ok(!serialized.includes('sets'));
      assert.ok(!serialized.includes('SYNTHETIC')); assert.ok(!serialized.includes('external|'));
      if (['invalid_token', 'insufficient_scope'].includes(scenario)) {
        assert.equal(response.status, 200);
        assert.equal(raw.result.isError, true);
        assert.equal(raw.result.structuredContent.ok, false);
        assert.equal(Object.hasOwn(raw.result.structuredContent, 'data'), false);
        const [challenge] = raw.result._meta['mcp/www_authenticate'];
        assert.ok(challenge.includes(`error="${scenario}"`));
        assert.ok(challenge.includes('error_description="'));
        assert.ok(challenge.includes('resource_metadata="https://form.example/.well-known/oauth-protected-resource/mcp"'));
      } else {
        assert.equal(response.status, scenario.includes('backend') ? 503 : 403);
        assert.ok(!serialized.includes('mcp/www_authenticate'));
        if (scenario !== 'late-auth-change') assert.equal(response.headers.get('www-authenticate'), null);
      }
    } finally { await handler.close(); }
  }
});
