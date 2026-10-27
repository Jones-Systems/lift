import test from 'node:test';
import assert from 'node:assert/strict';
import { revokeApple, settleProviderOperation } from '../src/lifecycle/providers/apple.js';
import type { AppleRequest, AppleResponse, BoundedAppleTransport, BoundedProviderOperation, ProviderBudget,
  ResolvedMaterial, TokenKind } from '../src/lifecycle/providers/types.js';
const material: ResolvedMaterial = { material: { rowId: 'synthetic-row', authUserId: 'synthetic-user', provider: 'apple',
  immutableSubject: 'synthetic-subject', clientBindingId: 'synthetic-issuer', clientId: 'synthetic.client',
  tokenKind: 'refresh_token', token: 'synthetic-token', provenance: 'issuer-client-subject-token-v1' }, clientSecret: 'synthetic-secret' };
const budget = (controller = new AbortController()): ProviderBudget => ({ deadlineAtMs: Date.now() + 10000,
  signal: controller.signal, maxResponseBytes: 4096 });
const done = <T>(value: T): BoundedProviderOperation<T> => ({ settled: Promise.resolve(value), cancel: async () => {} });
function pending<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const settled = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { settled, resolve, reject };
}
function port(response: AppleResponse) {
  const calls: AppleRequest[] = [], budgets: ProviderBudget[] = [];
  const transport: BoundedAppleTransport = { contract: 'bounded-apple-revoke-v1', post: (request, scope) => {
    calls.push(request); budgets.push(scope); return done(response);
  } };
  return { transport, calls, budgets };
}

for (const tokenKind of ['refresh_token', 'access_token'] as const) test(`fixed Apple POST encodes qualified ${tokenKind}, disables redirect/cookies/retry and scopes empty200`, async () => {
  const f = port({ status: 200, body: new Uint8Array(), truncated: false }), scope = budget();
  const special = { material: { ...material.material, tokenKind, token: 'synthetic +&=é', clientId: 'synthetic.client+id' }, clientSecret: 'synthetic&secret=+' };
  assert.deepEqual(await revokeApple(special, f.transport, scope), { code: 'apple_ack', status: 200 });
  assert.equal(f.calls.length, 1); const request = f.calls[0]!;
  assert.equal(request.url, 'https://appleid.apple.com/auth/revoke'); assert.equal(request.method, 'POST');
  assert.equal(request.contentType, 'application/x-www-form-urlencoded'); assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit'); assert.equal(request.retry, 0); assert.equal(f.budgets[0], scope);
  assert.deepEqual([...new URLSearchParams(request.body)], [['client_id', special.material.clientId], ['client_secret', special.clientSecret],
    ['token', special.material.token], ['token_type_hint', tokenKind]]);
  assert.ok(Buffer.byteLength(request.body) <= 131072);
});

for (const [name, response, expected] of [
  ['non200', { status: 400, body: Buffer.from('synthetic-provider-error-secret'), truncated: false }, 'provider_error'],
  ['redirect', { status: 302, body: new Uint8Array(), truncated: false }, 'provider_error'],
  ['nonempty200', { status: 200, body: Buffer.from(' '), truncated: false }, 'response_invalid'],
  ['oversize', { status: 200, body: new Uint8Array(4097), truncated: false }, 'response_invalid'],
  ['truncated', { status: 200, body: new Uint8Array(), truncated: true }, 'response_invalid'],
  ['invalid-status', { status: 999, body: new Uint8Array(), truncated: false }, 'response_invalid'],
] as const) test(`Apple ${name} never becomes ACK or exports protocol payload`, async () => {
  const f = port(response); const result = await revokeApple(material, f.transport, budget());
  assert.equal(result.code, expected); assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'status']); assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('token, secret and client byte bounds reject oversize before any HTTP and accept exact UTF8 boundaries', async () => {
  for (const bad of [{ ...material, material: { ...material.material, token: 'x'.repeat(16385) } },
    { ...material, clientSecret: 'x'.repeat(16385) }, { ...material, material: { ...material.material, clientId: 'x'.repeat(256) } },
    { ...material, material: { ...material.material, tokenKind: 'id_token' as TokenKind } },
    { ...material, material: { ...material.material, token: '' } }, { ...material, clientSecret: '' },
    { ...material, material: { ...material.material, token: 'synthetic\nmalformed' } },
    { ...material, clientSecret: '\ud800' }]) {
    const f = port({ status: 200, body: new Uint8Array(), truncated: false });
    assert.equal((await revokeApple(bad, f.transport, budget())).code, 'response_invalid'); assert.equal(f.calls.length, 0);
  }
  const f = port({ status: 200, body: new Uint8Array(), truncated: false });
  assert.equal((await revokeApple({ material: { ...material.material, token: 'é'.repeat(8192), clientId: 'x'.repeat(255) },
    clientSecret: 's'.repeat(16384) }, f.transport, budget())).code, 'apple_ack'); assert.equal(f.calls.length, 1);
});

test('missing bounded transport contract and pre-aborted budget make zero calls', async () => {
  const f = port({ status: 200, body: new Uint8Array(), truncated: false });
  assert.equal((await revokeApple(material, { ...f.transport, contract: 'uncooperative' } as unknown as BoundedAppleTransport, budget())).code, 'response_invalid');
  const controller = new AbortController(); controller.abort();
  assert.equal((await revokeApple(material, f.transport, budget(controller))).code, 'response_invalid'); assert.equal(f.calls.length, 0);
});

for (const phase of ['connect', 'body'] as const) test(`hanging ${phase} cancellation waits for producer settlement and cleanup; late empty200 cannot acknowledge`, async () => {
  const controller = new AbortController(), started = pending<void>(), response = pending<AppleResponse>(), cleanup = pending<void>();
  let cleanupCalled = 0, delivered = false;
  const transport: BoundedAppleTransport = { contract: 'bounded-apple-revoke-v1', post: (_request, scope) => {
    assert.equal(scope.maxResponseBytes, 4096); started.resolve();
    return { settled: response.settled, cancel: async () => { cleanupCalled++; await cleanup.settled; } };
  } };
  const running = revokeApple(material, transport, budget(controller)).then(value => { delivered = true; return value; });
  await started.settled; controller.abort(); await Promise.resolve();
  assert.equal(cleanupCalled, 1); assert.equal(delivered, false);
  response.resolve({ status: 200, body: new Uint8Array(), truncated: false }); await Promise.resolve();
  assert.equal(delivered, false); cleanup.resolve();
  assert.deepEqual(await running, { code: 'transport_unknown', status: null }); assert.equal(cleanupCalled, 1);
});

test('transport exception after successful cleanup yields closed remote uncertainty with no retries', async () => {
    let calls = 0, cleanups = 0;
    const transport: BoundedAppleTransport = { contract: 'bounded-apple-revoke-v1', post: () => {
      calls++; return { settled: Promise.reject(new Error('synthetic-token-secret-body')), cancel: async () => {
        cleanups++;
      } };
    } };
    assert.deepEqual(await revokeApple(material, transport, budget()), { code: 'transport_unknown', status: null });
    assert.equal(calls, 1); assert.equal(cleanups, 1);
});

for (const settlement of ['error', 'empty200'] as const)
  test(`P1 ${settlement} with rejected HTTP cleanup propagates only closed local termination failure`, async () => {
    let starts = 0, cleanups = 0;
    const transport: BoundedAppleTransport = { contract: 'bounded-apple-revoke-v1', post: () => {
      starts++;
      return { settled: settlement === 'error' ? Promise.reject(new Error('synthetic-operation-detail'))
        : Promise.resolve({ status: 200, body: new Uint8Array(), truncated: false }),
      cancel: async () => { cleanups++; throw new Error('synthetic-cleanup-detail'); } };
    } };
    await assert.rejects(revokeApple(material, transport, budget()), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'local_termination_unconfirmed');
      assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: 'local_termination_unconfirmed' });
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(starts, 1); assert.equal(cleanups, 1);
  });

test('material producer cancellation settles before caller sees a result or another phase starts', async () => {
  const controller = new AbortController(), value = pending<string>(), cleanup = pending<void>(); let delivered = false;
  const running = settleProviderOperation(() => ({ settled: value.settled, cancel: () => cleanup.settled }), budget(controller))
    .then(result => { delivered = true; return result; }, error => { delivered = true; throw error; });
  controller.abort(); value.resolve('synthetic-material'); await Promise.resolve(); assert.equal(delivered, false);
  cleanup.resolve(); await assert.rejects(running, /provider_cancelled/); assert.equal(delivered, true);
});
