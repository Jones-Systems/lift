import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createFormMcpHandler, mcpToolDescriptors } from '../src/mcp-handler.mjs';
import { identity, now, workout } from './fixtures.mjs';

const url = 'https://form.example/mcp';
const options = extra => ({ enabled: true, allowedHosts: ['form.example'], allowedOrigins: ['https://form.example'],
  now, admitRequest: () => true, verifyRequest: () => identity(), ...extra });
function request(body, headers = {}, method = 'POST') {
  return new Request(url, { method, headers: { host: 'form.example', 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', ...headers }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}
const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
async function wire(response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).at(-1);
  }
  return JSON.parse(text);
}

test('default and partial configuration perform no verifier, admission or port calls', async () => {
  let calls = 0;
  const unexpected = () => { calls++; throw new Error('Unexpected'); };
  for (const config of [{}, { enabled: true }, { ...options(), enabled: false }]) {
    const handler = createFormMcpHandler({ verifyRequest: unexpected, admitRequest: unexpected, ports: { getWorkout: unexpected }, ...config });
    assert.equal((await handler.fetch(request(list))).status, 503);
    await handler.close();
  }
  assert.equal(calls, 0);
});

test('host, origin, invalid identity, expiry and admission failures never reach data', async () => {
  let reads = 0;
  for (const [extra, headers, expected] of [
    [{}, { host: 'other.example' }, 403], [{}, { origin: 'https://other.example' }, 403],
    [{}, { origin: 'null' }, 403], [{ verifyRequest: () => null }, {}, 401],
    [{ verifyRequest: () => ({ ...identity(), expiresAtMs: 1000 }) }, {}, 401],
    [{ admitRequest: () => false }, {}, 429],
  ]) {
    const handler = createFormMcpHandler(options({ ports: { getWorkout: () => { reads++; } }, ...extra }));
    assert.equal((await handler.fetch(request(list, headers))).status, expected);
    await handler.close();
  }
  assert.equal(reads, 0);
});

test('raw legacy tools/list preserves top-level OpenAI securitySchemes and compatibility mirror', async () => {
  const handler = createFormMcpHandler(options());
  try {
    const response = await handler.fetch(request(list));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const raw = await wire(response);
    assert.equal(raw.result.tools.length, 5);
    for (const [index, descriptor] of raw.result.tools.entries()) {
      assert.deepEqual(descriptor.securitySchemes, mcpToolDescriptors[index].securitySchemes);
      assert.deepEqual(descriptor._meta.securitySchemes, descriptor.securitySchemes);
      assert.deepEqual(descriptor.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      assert.equal(descriptor.inputSchema.additionalProperties, false);
    }
  } finally { await handler.close(); }
});

for (const mode of ['legacy', { pin: '2026-07-28' }]) {
  test(`offline official SDK client reads safe records and raw metadata (${JSON.stringify(mode)})`, async () => {
    let reads = 0;
    let rawList;
    const handler = createFormMcpHandler(options({ ports: { getWorkout: ({ identity: caller }) => {
      reads++;
      return { ...workout(), accountId: caller.accountId, injuryHistory: 'SYNTHETIC_PRIVATE', wearable: 'SYNTHETIC_PRIVATE' };
    } } }));
    const client = new Client({ name: 'form-offline-test', version: '1.0.0' }, { versionNegotiation: { mode } });
    const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: async (input, init) => {
      const incoming = new Request(input, init);
      incoming.headers.set('host', 'form.example');
      const body = incoming.method === 'POST' ? await incoming.clone().json() : null;
      const response = await handler.fetch(incoming);
      if (body?.method === 'tools/list') rawList = await wire(response.clone());
      return response;
    } });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 5);
      assert.deepEqual(rawList.result.tools[1].securitySchemes, [{ type: 'oauth2', scopes: ['form:workouts:read'] }]);
      assert.deepEqual(rawList.result.tools[1]._meta.securitySchemes, rawList.result.tools[1].securitySchemes);
      const result = await client.callTool({ name: 'form_get_workout', arguments: { workoutId: 'workout_1' } });
      assert.equal(result.structuredContent.ok, true);
      assert.equal(result.structuredContent.data.sets[0].status, 'voided');
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE'));
      assert.equal(reads, 1);
      const invalid = await client.callTool({ name: 'form_get_workout', arguments: { workoutId: 'workout_1', accountId: 'account_b' } });
      assert.equal(invalid.isError, true);
      assert.equal(reads, 1);
    } finally { await client.close(); await handler.close(); }
  });
}

test('malformed protocol, batch and body bounds do not invoke data; GET and DELETE are stateless', async () => {
  let reads = 0;
  const handler = createFormMcpHandler(options({ ports: { getWorkout: () => { reads++; } } }));
  try {
    assert.equal((await handler.fetch(request('x'.repeat(16385)))).status, 413);
    assert.ok((await handler.fetch(request('{'))).status >= 400);
    const batch = await wire(await handler.fetch(request([list])));
    assert.ok(batch.error);
    for (const method of ['GET', 'DELETE']) assert.equal((await handler.fetch(request(null, {}, method))).status, 405);
    assert.equal(reads, 0);
  } finally { await handler.close(); }
});

test('request identity cannot come from model metadata and does not leak between concurrent calls', async () => {
  const seen = [];
  const handler = createFormMcpHandler(options({
    verifyRequest: req => identity(req.headers.get('x-synthetic-account')),
    ports: { getWorkout: ({ identity: caller }) => { seen.push(caller.accountId); return { ...workout(), accountId: caller.accountId }; } },
  }));
  try {
    const body = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'form_get_workout',
      arguments: { workoutId: 'workout_1' }, _meta: { 'openai/subject': 'account_evil' } } };
    const results = await Promise.all(['account_a', 'account_b'].map(account => handler.fetch(request(body, { 'x-synthetic-account': account })).then(wire)));
    assert.deepEqual(seen.sort(), ['account_a', 'account_b']);
    assert.ok(results.every(result => result.result.structuredContent.ok));
    assert.ok(results.every(result => !JSON.stringify(result).includes('account_evil')));
  } finally { await handler.close(); }
});

test('every top-level batch is rejected before data dispatch and a single call still succeeds', async () => {
  let reads = 0;
  const handler = createFormMcpHandler(options({ ports: { getWorkout: ({ identity: caller }) => {
    reads++;
    return { ...workout(), accountId: caller.accountId };
  } } }));
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'form_get_workout', arguments: { workoutId: 'workout_1' },
  } };
  const modern = { ...call, params: { ...call.params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  } } };
  try {
    for (const batch of [[], [call], [call, { ...call, id: 3 }], [call, null], [call, modern], [modern]]) {
      const rejected = await handler.fetch(request(batch));
      assert.equal(rejected.status, 400);
      assert.equal((await wire(rejected)).error.code, -32600);
      assert.equal(reads, 0);
    }
    const result = await wire(await handler.fetch(request(call)));
    assert.equal(result.result.structuredContent.ok, true);
    assert.equal(reads, 1);
  } finally { await handler.close(); }
});

test('safe failures and close reject without disclosing exception text', async () => {
  const handler = createFormMcpHandler(options({ admitRequest: () => { throw new Error('SYNTHETIC_PRIVATE'); } }));
  assert.ok(!(await (await handler.fetch(request(list))).text()).includes('SYNTHETIC_PRIVATE'));
  await handler.close();
  assert.equal((await handler.fetch(request(list))).status, 503);
});
