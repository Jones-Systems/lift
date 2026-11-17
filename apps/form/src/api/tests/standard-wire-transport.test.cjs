const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..'), cache = new Map();
function load(name) {
  let file = path.resolve(root, name); if (!fs.existsSync(file)) file += '.ts';
  assert.ok(file.startsWith(root + path.sep));
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.')); return load(path.relative(root, path.resolve(path.dirname(file), name)));
  }, module, module.exports); return module.exports;
}
const { FormTransport, ApiError } = load('api/transport.ts');
const { createStandardCoachingTransport, standardResultUnknown } = load('integration/standardCoachingTransport.ts');
const { createStandardWireCodec } = load('voice-coaching/standard/wire-codec.ts');
const limits = { maxAudioBytes: 128, maxEnvelopeBytes: 2048, maxTextCharacters: 64 }, deadlineMs = 5000;
const codec = createStandardWireCodec(limits), bytes = new Uint8Array([0, 1, 2]);
const result = { outcome: { kind: 'succeeded', value: { audio: bytes, mediaType: 'audio/wav' } }, accounting: 'settled',
  review: { transcript: 'synthetic transcript', reply: 'synthetic reply' } };
const json = (data, headers = {}) => new Response(JSON.stringify(data), { headers });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
async function fixture(exchange) {
  const calls = [], storage = { value: null, load: async () => null, async save(value) { this.value = value; }, async clear() { this.value = null; } };
  let nextToken = 'original';
  const api = new FormTransport('https://form.example.invalid', storage, async (url, init) => {
    if (url.endsWith('/sign-in/email')) return json({}, { 'set-auth-token': nextToken });
    calls.push(init); return exchange(init);
  });
  await api.signIn('synthetic@example.invalid', 'synthetic');
  return { api, calls, storage, replace: async () => { nextToken = 'replacement'; await api.signIn('synthetic@example.invalid', 'synthetic'); } };
}
function input(signal = new AbortController().signal) {
  const account = { accountId: 'account', authSessionId: 'session', accountEpoch: 1 };
  return { scope: { account, isCurrent: () => true }, fence: { ...account, generation: 1 }, sessionId: 'turn',
    audioBlob: new Blob([bytes], { type: 'audio/wav' }), signal, assertCurrent() {} };
}
test('optional source configuration and absent authentication dispatch nothing', async () => {
  let calls = 0; const api = new FormTransport('https://form.example.invalid', { load: async () => null, save: async () => {}, clear: async () => {} },
    async () => { calls++; assert.fail(); });
  assert.equal(createStandardCoachingTransport(api), undefined);
  const turn = createStandardCoachingTransport(api, { limits, deadlineMs });
  await assert.rejects(turn.run(input()), { code: 'unauthenticated' }); assert.equal(calls, 0);
});
test('actual wire adapter sends exact encoded string and preserves complete outcome, accounting and review', async () => {
  const f = await fixture(async () => new Response(codec.encodeResult(result)));
  const turn = createStandardCoachingTransport(f.api, { limits, deadlineMs });
  assert.deepEqual(await turn.run(input()), result);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body, codec.encodeRequest({ audio: bytes, mediaType: 'audio/wav' }));
  assert.equal(f.calls[0].headers.Authorization, 'Bearer original'); assert.equal(f.calls[0].redirect, 'error');
  assert.deepEqual(Object.keys(JSON.parse(f.calls[0].body)).sort(), ['audio', 'kind', 'version']);
});
test('auth replacement aborts a held body and late bytes cannot return into the new session', async () => {
  let canceled = 0, responseSignal; const reached = deferred();
  const f = await fixture(async init => { responseSignal = init.signal; return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); reached.resolve(); }, cancel() { canceled++; },
  })); });
  const work = f.api.exchangeStandardWire('{}', new AbortController().signal, { maxEnvelopeBytes: 2048, deadlineMs });
  const rejected = assert.rejects(work, { code: 'session_changed', originalEffectUnknown: true });
  await reached.promise; await f.replace(); await rejected;
  assert.equal(responseSignal.aborted, true); assert.equal(canceled, 1); assert.equal(JSON.parse(f.storage.value).token, 'replacement');
});
test('caller abort and deadline remain attached through body read', async () => {
  for (const timeout of [false, true]) {
    let canceled = 0; const read = deferred(), abort = new AbortController();
    const f = await fixture(async () => new Response(new ReadableStream({ start() { read.resolve(); }, cancel() { canceled++; } })));
    const work = f.api.exchangeStandardWire('{}', abort.signal, { maxEnvelopeBytes: 2048, deadlineMs: timeout ? 10 : deadlineMs });
    const rejected = assert.rejects(work, { code: 'transport_interrupted', effectUnknown: true });
    await read.promise; if (!timeout) abort.abort(); await rejected; assert.equal(canceled, 1);
  }
});
test('actual accumulated bytes include chunked UTF-8, irrespective of a misleading length header', async () => {
  let canceled = 0;
  const f = await fixture(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('é'.repeat(40))); controller.enqueue(new TextEncoder().encode('é'.repeat(40)));
  }, cancel() { canceled++; } }), { headers: { 'Content-Length': '1' } }));
  await assert.rejects(f.api.exchangeStandardWire('{}', new AbortController().signal, { maxEnvelopeBytes: 100, deadlineMs }), { code: 'wire_size', effectUnknown: true });
  assert.equal(canceled, 1);
  await assert.rejects(f.api.exchangeStandardWire('é'.repeat(60), new AbortController().signal, { maxEnvelopeBytes: 100, deadlineMs }), { code: 'wire_size', effectUnknown: false });
  assert.equal(f.calls.length, 1);
});
test('malformed results and redirects never retry or fabricate accounting', async () => {
  for (const reply of [() => new Response('{"kind":"result","actor":"forged"}'), () => new Response('', { status: 302, headers: { Location: 'https://other.invalid' } })]) {
    const f = await fixture(async () => reply());
    await assert.rejects(createStandardCoachingTransport(f.api, { limits, deadlineMs }).run(input()));
    assert.equal(f.calls.length, 1);
  }
});

test('adapter sends one Idempotency-Key per turn in a header, never in the body', async () => {
  const f = await fixture(async () => new Response(codec.encodeResult(result)));
  const turn = createStandardCoachingTransport(f.api, { limits, deadlineMs });
  await turn.run(input());
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['Idempotency-Key'], 'std-turn:turn');
  assert.deepEqual(Object.keys(JSON.parse(f.calls[0].body)).sort(), ['audio', 'kind', 'version']);
  assert.equal(f.calls[0].body.includes('std-turn'), false);
  const next = input(); next.sessionId = 'turn-two';
  await turn.run(next);
  assert.equal(f.calls[1].headers['Idempotency-Key'], 'std-turn:turn-two');
});

test('exchangeStandardWire adds the key header only when asked and refuses a malformed key before any fetch', async () => {
  const f = await fixture(async () => new Response(codec.encodeResult(result)));
  const signal = new AbortController().signal, bounds = { maxEnvelopeBytes: 2048, deadlineMs };
  await f.api.exchangeStandardWire('{}', signal, bounds);
  assert.equal(Object.hasOwn(f.calls[0].headers, 'Idempotency-Key'), false);
  await f.api.exchangeStandardWire('{}', signal, bounds, { idempotencyKey: 'std-turn:valid' });
  assert.equal(f.calls[1].headers['Idempotency-Key'], 'std-turn:valid');
  const sent = f.calls.length;
  for (const key of ['', 'short', 'has space', 'a/b-key-1', 'k'.repeat(129), 'émoji-key-1', undefined, null, 7]) {
    await assert.rejects(f.api.exchangeStandardWire('{}', signal, bounds, { idempotencyKey: key }),
      { code: 'invalid_idempotency_key', effectUnknown: false }, String(key));
  }
  assert.equal(f.calls.length, sent);
});

test('retryUnknownResultOnce repeats a lost or 5xx delivery once with the same key, bytes and bearer', async () => {
  for (const first of [() => { throw new TypeError('network down'); }, () => new Response('', { status: 503 })]) {
    let n = 0;
    const f = await fixture(async () => ++n === 1 ? first() : new Response(codec.encodeResult(result)));
    const turn = createStandardCoachingTransport(f.api, { limits, deadlineMs, retryUnknownResultOnce: true });
    assert.deepEqual(await turn.run(input()), result);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body, f.calls[1].body);
    assert.equal(f.calls[0].headers['Idempotency-Key'], 'std-turn:turn');
    assert.equal(f.calls[1].headers['Idempotency-Key'], 'std-turn:turn');
    assert.equal(f.calls[0].headers.Authorization, 'Bearer original'); assert.equal(f.calls[1].headers.Authorization, 'Bearer original');
  }
});

test('retryUnknownResultOnce never repeats a definite refusal, a second loss, or runs when absent', async () => {
  for (const status of [400, 401, 403, 413, 415, 422]) {
    const f = await fixture(async () => new Response('', { status }));
    // A 401 also clears the session, so its rejection may surface as the session change it caused.
    await assert.rejects(createStandardCoachingTransport(f.api, { limits, deadlineMs, retryUnknownResultOnce: true }).run(input()),
      status === 401 ? Error : { status }, String(status));
    assert.equal(f.calls.length, 1, String(status));
  }
  const lost = await fixture(async () => { throw new TypeError('network down'); });
  await assert.rejects(createStandardCoachingTransport(lost.api, { limits, deadlineMs, retryUnknownResultOnce: true }).run(input()),
    { code: 'wire_result_unknown' });
  assert.equal(lost.calls.length, 2);
  for (const configuration of [{ limits, deadlineMs }, { limits, deadlineMs, retryUnknownResultOnce: false }]) {
    const off = await fixture(async () => { throw new TypeError('network down'); });
    await assert.rejects(createStandardCoachingTransport(off.api, configuration).run(input()), { code: 'wire_result_unknown' });
    assert.equal(off.calls.length, 1);
  }
  const api = new FormTransport('https://form.example.invalid', { load: async () => null, save: async () => {}, clear: async () => {} }, async () => assert.fail());
  for (const value of ['yes', 1, null, {}]) {
    assert.throws(() => createStandardCoachingTransport(api, { limits, deadlineMs, retryUnknownResultOnce: value }),
      { message: 'standard_transport_retry_invalid' });
  }
});

test('an account switch before the retry blocks it, so the turn key never reaches the replacement session', async () => {
  // setToken is the transport's own synchronous mutation; replace() is async and cannot land exactly between two attempts.
  let n = 0;
  const f = await fixture(async () => { ++n; throw new TypeError('network down'); });
  const first = input();
  first.assertCurrent = () => { if (n > 0) f.api.setToken('replacement'); };
  await assert.rejects(createStandardCoachingTransport(f.api, { limits, deadlineMs, retryUnknownResultOnce: true }).run(first));
  assert.equal(f.calls.length, 1); assert.equal(n, 1);
  assert.equal(f.calls.some(call => call.headers.Authorization === 'Bearer replacement'), false);
  // A change during the first attempt is a session change, which is never retried either.
  let late = 0, hold;
  const g = await fixture(async () => { ++late; await hold(); return new Response(new ReadableStream({ start() {} })); });
  hold = () => g.replace();
  await assert.rejects(createStandardCoachingTransport(g.api, { limits, deadlineMs, retryUnknownResultOnce: true }).run(input()),
    { code: 'session_changed' });
  assert.equal(g.calls.length, 1); assert.equal(late, 1);
});

test('standardResultUnknown is true only for a lost response or a 5xx whose effect is unknown', () => {
  const make = (code, status, effectUnknown, original = false) => new ApiError(status, code, 'synthetic', effectUnknown, original);
  const rows = [
    [make('transport_interrupted', 0, true), true], [make('wire_result_unknown', 0, true), true],
    [make('wire_response_rejected', 500, true), true], [make('wire_response_rejected', 503, true), true],
    [make('transport_interrupted', 0, false), false], [make('wire_result_unknown', 0, false), false],
    [make('transport_interrupted', 0, true, true), false], [make('wire_response_rejected', 503, false), false],
    ...[302, 400, 401, 403, 413, 415, 422].map(status => [make('wire_response_rejected', status, true), false]),
    [make('session_changed', 409, false, true), false], [make('session_changed', 409, true), false],
    [make('unauthenticated', 401, false), false], [make('wire_size', 413, false), false], [make('wire_size', 502, true), false],
    [make('invalid_response', 502, true), false], [make('invalid_transport_limits', 400, false), false],
    [make('invalid_idempotency_key', 400, false), false],
    [new Error('transport_interrupted'), false], [new TypeError('x'), false], [{ code: 'transport_interrupted', effectUnknown: true }, false],
    [null, false], [undefined, false], ['transport_interrupted', false],
  ];
  for (const [error, expected] of rows) assert.equal(standardResultUnknown(error), expected, String(error?.code ?? error));
});

const { createStandardCoachingProducer } = load('integration/standardCoachingSession.ts');
const settled = () => new Promise(setImmediate);
async function retainedReview(api, id) {
  const auth = api.captureAuthContext(), account = { accountId: 'same-account', authSessionId: id, accountEpoch: 1 };
  let signal, stops = 0;
  const producer = createStandardCoachingProducer({ resources: { api }, accountId: account.accountId, sessionGeneration: id,
    scope: { account, isCurrent: auth.isCurrent }, isCurrentSession: auth.isCurrent,
    newSessionId: () => `turn-${id}`,
    host: { async startStandard(scope, sessionId, captured) {
      signal = captured;
      return { fence: { ...account, generation: 1 }, assertCurrent() { assert.equal(auth.isCurrent(), true); },
        startCapture: async () => {}, finishCapture: async () => new Blob([bytes], { type: 'audio/wav' }), play: async () => {},
        async stop() { stops++; return { status: 'released', failedSteps: [] }; } };
    } }, turn: { async run() { return result; } },
  });
  const session = producer.create(() => {}), consumer = session.props.consumer;
  await consumer.start(); await consumer.finishAndSend(); assert.ok(consumer.review());
  return { producer, consumer, signal, stops: () => stops };
}

test('current Standard 401 synchronously stops the original retained consumer before held storage repair', async () => {
  const response = deferred(), storage = deferred(); let clears = 0, notifications = 0, settledRequest = false;
  const f = await fixture(async () => response.promise), retained = await retainedReview(f.api, 'original');
  f.storage.clear = async function () { clears++; await storage.promise; this.value = null; };
  const changes = f.api.subscribeAuthChanges(() => {
    notifications++; void retained.producer.stop('account_changed');
    assert.equal(retained.consumer.review(), null); assert.equal(retained.signal.aborted, true);
    assert.equal(JSON.parse(f.storage.value).token, 'original');
  });
  const pending = f.api.exchangeStandardWire('{}', new AbortController().signal, { maxEnvelopeBytes: 2048, deadlineMs });
  const rejected = assert.rejects(pending, error => error.effectUnknown || error.originalEffectUnknown);
  void pending.then(() => { settledRequest = true; }, () => { settledRequest = true; });
  try {
    response.resolve(new Response('{"error":{"code":"unauthenticated"}}', { status: 401 }));
    for (let i = 0; i < 4; i++) await settled();
    assert.equal(notifications, 1); assert.equal(clears, 1); assert.equal(retained.signal.aborted, true);
    assert.equal(retained.consumer.review(), null); assert.equal(retained.producer.create(() => {}), null);
    assert.equal(JSON.parse(f.storage.value).token, 'original'); assert.equal(settledRequest, false);
    storage.resolve(); await rejected; assert.equal(f.storage.value, null); assert.equal(f.calls.length, 1);
  } finally { storage.resolve(); await rejected; changes.remove(); await retained.producer.dispose(); }
});

test('late old Standard 401 cannot touch replacement token, storage, retained review or audio', async () => {
  const response = deferred(), f = await fixture(async () => response.promise);
  const owners = [await retainedReview(f.api, 'original')]; let notifications = 0, clears = 0;
  const clear = f.storage.clear.bind(f.storage); f.storage.clear = async () => { clears++; await clear(); };
  const changes = f.api.subscribeAuthChanges(() => { notifications++; for (const owner of owners) void owner.producer.stop('account_changed'); });
  const pending = f.api.exchangeStandardWire('{}', new AbortController().signal, { maxEnvelopeBytes: 2048, deadlineMs });
  const rejected = assert.rejects(pending, { code: 'session_changed', originalEffectUnknown: true });
  try {
    await f.replace(); await rejected; const next = await retainedReview(f.api, 'replacement'); owners.push(next);
    const observed = notifications, stops = next.stops(), value = f.storage.value;
    response.resolve(new Response('{"error":{"code":"unauthenticated"}}', { status: 401 }));
    for (let i = 0; i < 4; i++) await settled();
    assert.equal(notifications, observed); assert.equal(clears, 0); assert.equal(f.storage.value, value);
    assert.equal(JSON.parse(f.storage.value).token, 'replacement'); assert.ok(next.consumer.review());
    assert.equal(next.signal.aborted, false); assert.equal(next.stops(), stops); assert.equal(f.calls.length, 1);
  } finally { response.resolve(new Response('', { status: 401 })); changes.remove(); for (const owner of owners) await owner.producer.dispose(); }
});

test('bounded wire exchange excludes ambient cookies while retaining its bearer and encoded result', async () => {
  const f = await fixture(async init => init.credentials !== 'omit'
    ? new Response('{"code":"MISSING_OR_NULL_ORIGIN"}', { status: 403 })
    : new Response(codec.encodeResult(result)));
  assert.deepEqual(await createStandardCoachingTransport(f.api, { limits, deadlineMs }).run(input()), result);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer original');
  assert.equal(JSON.parse(f.storage.value).token, 'original');
});
