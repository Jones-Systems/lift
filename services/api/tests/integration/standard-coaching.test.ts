import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createServer, type FormServer } from '../../src/server.js';
import { migrations, hash } from '../../src/storage.js';
import { lifecycleMigration } from '../../src/lifecycle/migration.js';
import { Hono } from 'hono';
import { DomainError } from '../../src/errors.js';
import type { AccountContext } from '../../src/lifecycle/types.js';
import type { CoachingRequestScope } from '../../src/voice-coaching/contracts.js';
import type { UsageSnapshot, UsageReservationHandle } from '../../src/usage-limits/types.js';
import { createGroundedAnswerHost } from '../../src/integration/grounded-answer.js';
import { createStandardCoachingRoutes } from '../../src/integration/standard-coaching/routes.js';
import type { StandardCoachingConfiguration } from '../../src/integration/standard-coaching/composition.js';
import { createStandardWireCodec } from '../../src/voice-coaching/standard/wire-codec.js';

const limits = { maxAudioBytes: 128, maxEnvelopeBytes: 4096, maxTextCharacters: 128 };
const codec = createStandardWireCodec(limits), audio = new Uint8Array([1, 2, 3]);
const request = codec.encodeRequest({ audio, mediaType: 'audio/wav' });
const actor: AccountContext = { accountId: 'synthetic-account', authUserId: 'synthetic-user', sessionId: 'synthetic-session', epoch: 1 };
const snapshot: UsageSnapshot = { schemaVersion: 1, configured: true, policyId: 'synthetic', serverTimeMs: 1, period: null, metrics: null,
  ordinaryWorkoutExecution: 'unrestricted_by_usage_limits', ordinaryWorkoutLogging: 'unrestricted_by_usage_limits' };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
function fixture(configured = true, options: { audio?: Uint8Array; limits?: typeof limits; deadlineMs?: number } = {}) {
  const inputAudio = options.audio ?? audio, wireLimits = options.limits ?? limits;
  const defaultRequest = createStandardWireCodec(wireLimits).encodeRequest({ audio: inputAudio, mediaType: 'audio/wav' });
  const events: string[] = [], scopes: CoachingRequestScope[] = [], intents: string[] = [];
  const turns: { authorized: boolean; resourceCurrent: boolean; disclosureAllowed: boolean; completeEntered: ReturnType<typeof deferred<void>>; synthesizeEntered: ReturnType<typeof deferred<void>> }[] = [];
  const f = { current: true, unknown: false, replay: false, missingGuard: false, asyncGuard: false,
    providerWait: undefined as Promise<void> | undefined, completeWait: undefined as Promise<void> | undefined, synthesizeWait: undefined as Promise<void> | undefined };
  const projectionBytes = readFileSync(new URL('../../grounding/8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10/projection.json', import.meta.url));
  const host = createGroundedAnswerHost({ projectionBytes });
  const configuration: StandardCoachingConfiguration = { limits: wireLimits, deadlineMs: options.deadlineMs ?? 5000, forTurn(scope) {
    scopes.push(scope);
    const turn = { authorized: true, resourceCurrent: true, disclosureAllowed: true, completeEntered: deferred<void>(), synthesizeEntered: deferred<void>() };
    turns.push(turn); const completeWait = f.completeWait, synthesizeWait = f.synthesizeWait;
    const id = `synthetic-turn-${scopes.length}`;
    const handle = { reservationId: id, actor: scope.actor, operation: 'standard', intentHash: id, subjectId: id } as UsageReservationHandle;
    const charges = [{ metric: 'coach_messages' as const, amount: 1 }];
    const current = (received: CoachingRequestScope) => { assert.equal(received, scope); received.assertCurrent(); };
    return { assertCurrent: (f.missingGuard ? undefined : f.asyncGuard ? async () => {} : () => {
      if (!turn.authorized || !turn.resourceCurrent || !turn.disclosureAllowed) throw new DomainError(403, 'synthetic_authority_revoked');
    }) as unknown as () => void, grounding: { host, request: { retrieval: { query: 'FLE-S01', topic: 'EXU-B5', access: 'full', limit: 1 },
      context: { revision: 'synthetic:1', facts: [], supersedesRevision: null } }, maxTextCharacters: 32_000, maxProviderTextBytes: 200_000,
      assertAuthorized(received) { current(received); events.push('authorize'); },
      assertDisclosureAllowed(received, transcript, answer) { current(received); assert.equal(transcript, 'synthetic transcript'); assert.equal(answer.status, 'informative'); events.push('disclosure'); } },
      policy: { intent: { operation: 'standard', idempotencyKey: id, intentHash: id, subjectId: id, charges, dispatchStages: ['transcribe', 'complete', 'synthesize'] },
        resolve() { return { kind: 'settle', settlement: { charges } }; } },
      usage: { reserve(received, intent) { assert.equal(received, scope.actor); intents.push(intent.idempotencyKey);
        if (f.replay) return { kind: 'replay', handle, state: 'settled', snapshot };
        return { kind: 'new', handle, state: 'reserved', snapshot }; },
        markDispatching(received, stage) { assert.equal(received, handle); events.push(`permit:${stage}`); return { reservationId: id, stage, dispatchedAtMs: 1 }; },
        status() { return snapshot; } },
      trusted: { settle(received) { assert.equal(received, handle); events.push('settled'); return snapshot; },
        markUnknown(received) { assert.equal(received, handle); events.push('unknown'); return snapshot; },
        release() { assert.fail('No post-dispatch release'); }, reconcile() { assert.fail('No implicit reconciliation'); } },
      provider: { enabled: true,
        async transcribe(received, input) { current(received); assert.deepEqual(new Uint8Array(await input.audio.arrayBuffer()), inputAudio);
          events.push('transcribe'); if (f.providerWait) await f.providerWait;
          return { kind: 'succeeded', value: 'synthetic transcript' }; },
        async complete(received, input) { current(received); assert.match(input.text, /Grounded answer JSON/); assert.ok(events.includes('disclosure'));
          events.push('complete'); turn.completeEntered.resolve(); if (completeWait) await completeWait; return f.unknown ? { kind: 'unknown', reason: 'synthetic' } : { kind: 'succeeded', value: 'synthetic reply' }; },
        async synthesize(received) { current(received); events.push('synthesize'); turn.synthesizeEntered.resolve(); if (synthesizeWait) await synthesizeWait; return { kind: 'succeeded', value: { audio, mediaType: 'audio/wav' } }; },
      },
    };
  } };
  type Env = { Variables: { actor: AccountContext } };
  const app = new Hono<Env>();
  app.onError((error, c) => error instanceof DomainError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: 'unexpected' }, 500));
  app.use('/v1/*', async (c, next) => {
    if (c.req.header('authorization') !== 'Bearer synthetic') throw new DomainError(401, 'unauthenticated');
    c.set('actor', actor); await next();
  });
  app.route('/v1/coaching/standard', createStandardCoachingRoutes<Env>({ context: c => c.get('actor'), lifecycle: {
    assertActive(received) { assert.deepEqual(received, actor); if (!f.current) throw new DomainError(401, 'account_session_invalid'); },
  }, ...(configured ? { configuration } : {}) }));
  const send = (body = defaultRequest, headers: Record<string, string> = { authorization: 'Bearer synthetic', 'content-type': 'application/json' }) =>
    app.request('/v1/coaching/standard/turn', { method: 'POST', headers, body });
  return { f, app, events, scopes, intents, turns, send, configuration };
}

test('unavailable configuration and unauthenticated requests never reach a trusted factory or provider', async () => {
  const missing = fixture(false); assert.equal((await missing.send()).status, 503); assert.deepEqual(missing.events, []);
  const unauth = fixture(); assert.equal((await unauth.send(request, { 'content-type': 'application/json' })).status, 401); assert.equal(unauth.scopes.length, 0);
});
test('real route, frozen wire handler, grounded preparation and controller preserve scope identity and allocate fresh per-turn intent', async () => {
  const f = fixture();
  for (let index = 0; index < 2; index++) {
    const response = await f.send(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = codec.decodeResult(await response.text());
    assert.deepEqual(result, { outcome: { kind: 'succeeded', value: { audio, mediaType: 'audio/wav' } }, accounting: 'settled',
      review: { transcript: 'synthetic transcript', reply: 'synthetic reply' } });
  }
  assert.notEqual(f.scopes[0], f.scopes[1]); assert.ok(f.scopes.every(Object.isFrozen));
  assert.deepEqual(f.intents, ['synthetic-turn-1', 'synthetic-turn-2']); assert.equal(f.events.filter(event => event === 'settled').length, 2);
});
test('payload authority fields and malformed wire are refused before trusted factory dispatch', async () => {
  for (const body of [JSON.stringify({ ...JSON.parse(request), actor }), '{', request.replace('AQID', 'AQI=') + 'x']) {
    const f = fixture(); assert.equal((await f.send(body)).status, 422); assert.equal(f.scopes.length, 0); assert.deepEqual(f.events, []);
  }
});
test('actual chunked bytes are bounded and reader canceled without trusting content-length', async () => {
  const f = fixture(); let canceled = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('é'.repeat(1200))); controller.enqueue(new TextEncoder().encode('é'.repeat(1200)));
  }, cancel() { canceled++; } });
  const response = await f.app.fetch(new Request('https://form.example.invalid/v1/coaching/standard/turn', {
    method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json', 'content-length': '1' }, body,
    ...({ duplex: 'half' } as Record<string, unknown>),
  }));
  assert.equal(response.status, 413); assert.equal(canceled, 1); assert.equal(f.scopes.length, 0);
});
test('unknown outcome and replay accounting remain exact without replay dispatch or release', async () => {
  const f = fixture(); f.f.unknown = true;
  const result = codec.decodeResult(await (await f.send()).text());
  assert.equal(result.outcome.kind, 'unknown'); assert.equal(result.accounting, 'unknown'); assert.deepEqual(result.review, { transcript: 'synthetic transcript' });
  assert.equal(f.events.filter(event => event === 'unknown').length, 1); assert.equal(f.events.includes('synthesize'), false);
  const replay = fixture(); replay.f.replay = true;
  const replayResult = codec.decodeResult(await (await replay.send()).text());
  assert.equal(replayResult.accounting, 'replay'); assert.equal(replay.events.includes('transcribe'), false);
});
test('cancellation while body is held cancels the reader before any dispatch', async () => {
  const f = fixture(), abort = new AbortController(), entered = deferred<void>(); let canceled = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, cancel() { canceled++; } });
  const pending = f.app.fetch(new Request('https://form.example.invalid/v1/coaching/standard/turn', { method: 'POST',
    headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body, signal: abort.signal,
    ...({ duplex: 'half' } as Record<string, unknown>),
  }));
  await entered.promise; abort.abort(); const response = await pending;
  assert.equal(response.status, 503); assert.equal(canceled, 1); assert.equal(f.scopes.length, 0);
});
test('cancellation during provider await returns promptly while original controller retains unknown accounting ownership', async () => {
  const f = fixture(), abort = new AbortController(), provider = deferred<void>(); f.f.providerWait = provider.promise;
  const pending = f.app.fetch(new Request('https://form.example.invalid/v1/coaching/standard/turn', { method: 'POST',
    headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: request, signal: abort.signal }));
  for (let i = 0; i < 20 && !f.events.includes('transcribe'); i++) await new Promise<void>(setImmediate);
  assert.ok(f.events.includes('transcribe')); abort.abort(); assert.equal((await pending).status, 503);
  provider.reject(new Error('synthetic provider result unavailable'));
  for (let i = 0; i < 5; i++) await new Promise<void>(setImmediate);
  assert.equal(f.events.includes('complete'), false); assert.equal(f.events.filter(event => event === 'unknown').length, 1);
});
test('client cancellation does not overwrite known provider evidence or nominate a settlement policy', async () => {
  const f = fixture(), abort = new AbortController(), provider = deferred<void>(); f.f.providerWait = provider.promise;
  const pending = f.app.fetch(new Request('https://form.example.invalid/v1/coaching/standard/turn', { method: 'POST',
    headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: request, signal: abort.signal }));
  for (let i = 0; i < 20 && !f.events.includes('transcribe'); i++) await new Promise<void>(setImmediate);
  assert.ok(f.events.includes('transcribe')); abort.abort(); assert.equal((await pending).status, 503);
  provider.resolve(); for (let i = 0; i < 5; i++) await new Promise<void>(setImmediate);
  assert.equal(f.events.includes('complete'), false);
  assert.equal(f.events.filter(event => event === 'settled').length, 1);
  assert.equal(f.events.includes('unknown'), false);
});

for (const stage of ['complete', 'synthesize'] as const) {
  for (const authority of ['authorized', 'resourceCurrent', 'disclosureAllowed'] as const) {
    test(`trusted ${authority} revocation during ${stage} prevents later dispatch and result release`, async () => {
      const f = fixture(), provider = deferred<void>(); f.f[`${stage}Wait`] = provider.promise;
      const pending = f.send();
      for (let i = 0; i < 30 && !f.turns[0]; i++) await new Promise<void>(setImmediate);
      assert.ok(f.turns[0]); await f.turns[0][`${stage}Entered`].promise;
      f.turns[0][authority] = false; provider.resolve();
      const response = await pending;
      assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'synthetic_authority_revoked');
      assert.equal(f.events.filter(event => event === 'settled').length, 1);
      assert.equal(f.events.includes('unknown'), false);
      if (stage === 'complete') assert.equal(f.events.includes('synthesize'), false);
    });
  }
}
test('missing or asynchronous trusted currentness guard fails closed before reservation or provider dispatch', async () => {
  for (const field of ['missingGuard', 'asyncGuard'] as const) {
    const f = fixture(); f.f[field] = true;
    const response = await f.send(); assert.equal(response.status, 503);
    assert.deepEqual(f.intents, []); assert.deepEqual(f.events, []);
  }
});
test('concurrent turns retain their own trusted authority guard and frozen scope', async () => {
  const f = fixture(), firstProvider = deferred<void>(); f.f.completeWait = firstProvider.promise;
  const first = f.send();
  for (let i = 0; i < 30 && !f.turns[0]; i++) await new Promise<void>(setImmediate);
  assert.ok(f.turns[0]); await f.turns[0].completeEntered.promise;
  f.f.completeWait = undefined;
  const second = await f.send(); assert.equal(second.status, 200);
  assert.equal(codec.decodeResult(await second.text()).outcome.kind, 'succeeded');
  f.turns[0].authorized = false; firstProvider.resolve();
  assert.equal((await first).status, 403);
  assert.notEqual(f.scopes[0], f.scopes[1]); assert.ok(f.scopes.every(Object.isFrozen));
  assert.equal(f.events.filter(event => event === 'synthesize').length, 1);
  assert.equal(f.events.filter(event => event === 'settled').length, 2);
});

async function fullServer(configuration: StandardCoachingConfiguration,
  run: (server: FormServer, headers: Record<string, string>) => Promise<void>, epoch = 1) {
  mkdirSync(resolve('.scratch'), { recursive: true });
  const root = mkdtempSync(join(resolve('.scratch'), 'standard-server-'));
  const origin = 'https://form.example.invalid';
  let server: FormServer | undefined, acquisition: Promise<FormServer> | undefined, disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    try { server ??= await acquisition; await server?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  })();
  const interrupt = () => { void dispose().finally(() => process.exit(130)); };
  const terminate = () => { void dispose().finally(() => process.exit(143)); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const dbPath = join(root, 'synthetic.sqlite'), seed = new Database(dbPath);
    try {
      seed.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
      for (const migration of migrations) {
        seed.exec(migration.sql);
        seed.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
      }
      seed.exec(lifecycleMigration.sql);
    } finally { seed.close(); }
    acquisition = createServer({ dbPath, baseURL: origin, secret: 'synthetic-standard-coaching-secret-more-than-32-characters',
      registration: { mode: 'allowlist', emails: ['standard@synthetic.invalid'] }, sourceStandardCoaching: configuration,
      lifecycle: { ledger: { currentSequence: () => 0, lookup: () => null, reconcileRestore: () => 0,
        recordDisable: () => { throw new Error('Synthetic fixture does not issue disable records'); } } } });
    server = await acquisition;
    const signup = await server.handleRequest(new Request(`${origin}/api/auth/sign-up/email`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Synthetic', email: 'standard@synthetic.invalid', password: 'Synthetic-standard-password-12345' }) }), '192.0.2.40');
    assert.equal(signup.status, 200); const token = signup.headers.get('set-auth-token'); assert.ok(token); await signup.json();
    const headers = { origin, 'content-type': 'application/json', authorization: `Bearer ${token}` };
    assert.equal((await server.handleRequest(new Request(`${origin}/v1/me`, { headers }), '192.0.2.40')).status, 200);
    // The current Standard route requires a positive epoch; isolate middleware behavior with that explicit fixture state.
    if (epoch === 1) server.db.prepare("UPDATE account_lifecycle SET epoch=1 WHERE state='active'").run();
    await run(server, headers);
  } finally {
    try { await dispose(); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
    assert.equal(existsSync(root), false);
  }
}
function streamingRequest(path: string, headers: Record<string, string>, body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  return new Request(`https://form.example.invalid${path}`, { method: 'POST', headers, body, ...(signal ? { signal } : {}),
    ...({ duplex: 'half' } as Record<string, unknown>) });
}

test('full server accepts Standard chunked envelope above 64 KiB only within the explicit route bound', async () => {
  const audio = new Uint8Array(52 * 1024).fill(7), limits = { maxAudioBytes: audio.length, maxEnvelopeBytes: 80 * 1024, maxTextCharacters: 128 };
  const f = fixture(true, { audio, limits }), codec = createStandardWireCodec(limits);
  const bytes = new TextEncoder().encode(codec.encodeRequest({ audio, mediaType: 'audio/wav' }));
  assert.ok(bytes.length > 64 * 1024 && bytes.length < limits.maxEnvelopeBytes);
  await fullServer(f.configuration, async (server, headers) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const response = await server.handleRequest(streamingRequest('/v1/coaching/standard/turn', headers, body), '192.0.2.40');
    assert.equal(response.status, 200); assert.equal(codec.decodeResult(await response.text()).outcome.kind, 'succeeded');
    let canceled = 0;
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(limits.maxEnvelopeBytes + 1)); }, cancel() { canceled++; } });
    assert.equal((await server.handleRequest(streamingRequest('/v1/coaching/standard/turn', headers, oversized), '192.0.2.40')).status, 413);
    assert.equal(canceled, 1); assert.equal(f.scopes.length, 1);
    const ordinary = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    assert.equal((await server.handleRequest(streamingRequest('/v1/coaching/standard/turn-extra', headers, ordinary), '192.0.2.40')).status, 413);
  });
});
for (const interruption of ['cancel', 'deadline', 'unauthenticated'] as const) {
  test(`full server stalled chunked Standard input honors ${interruption} before provider dispatch`, async () => {
    const f = fixture(true, { deadlineMs: 25 });
    await fullServer(f.configuration, async (server, headers) => {
      let canceled = 0;
      const abort = new AbortController();
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel() { canceled++; } });
      const pending = Promise.resolve(server.handleRequest(streamingRequest('/v1/coaching/standard/turn',
        interruption === 'unauthenticated' ? { 'content-type': 'application/json' } : headers, body, abort.signal), '192.0.2.40'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (interruption === 'cancel') abort.abort();
        const response = await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { reject(new Error('Standard middleware failed to admit the bounded route')); }, 1000);
        })]);
        assert.equal(response.status, interruption === 'unauthenticated' ? 401 : 503);
        if (interruption !== 'unauthenticated') assert.equal(canceled, 1);
        assert.equal(f.scopes.length, 0); assert.deepEqual(f.events, []);
      } finally {
        clearTimeout(timer); abort.abort();
        try { stream?.close(); } catch {}
        await pending;
      }
    });
  });
}

test('full server admits a newly initialized account at its actual lifecycle epoch zero', async () => {
  const f = fixture();
  await fullServer(f.configuration, async (server, headers) => {
    const response = await server.handleRequest(new Request('https://form.example.invalid/v1/coaching/standard/turn', {
      method: 'POST', headers, body: request }), '192.0.2.40');
    assert.equal(response.status, 200); assert.equal(codec.decodeResult(await response.text()).outcome.kind, 'succeeded');
    assert.equal(f.scopes[0]?.actor.epoch, 0);
  }, 0);
});
