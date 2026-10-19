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
const { FormTransport } = load('api/transport.ts');
const { createStandardCoachingTransport } = load('integration/standardCoachingTransport.ts');
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
