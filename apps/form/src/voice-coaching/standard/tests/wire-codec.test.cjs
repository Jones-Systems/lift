const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
function loader() {
  const cache = new Map();
  function load(name) {
    let file = path.resolve(root, name);
    if (!fs.existsSync(file)) file += '.ts';
    else if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.ts');
    assert.ok(file.startsWith(root + path.sep));
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
      return load(path.relative(root, path.resolve(path.dirname(file), name)));
    }, module, module.exports);
    return module.exports;
  }
  return load;
}
const load = loader();
const { createStandardWireCodec, StandardWireError } = load('voice-coaching/standard/wire-codec.ts');
const { createStandardWireTurn, standardTurnIdempotencyKey } = load('voice-coaching/standard/wire-turn.ts');
const { standardWireUsageReasons, standardWireUsageOutcome } = load('voice-coaching/standard/wire-usage.ts');
const { createStandardVoiceConsumer } = load('voice-coaching/standard/controller.ts');
const { VoiceSessionController, ExclusiveMicOwner } = load('voice-coaching/session-controller.ts');
const limits = { maxAudioBytes: 128, maxEnvelopeBytes: 2048, maxTextCharacters: 64 };
const codec = createStandardWireCodec(limits);
const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
const request = '{"version":1,"kind":"request","audio":{"mediaType":"audio/wav","base64":"AAEC/f7/"}}';
const api = name => import(pathToFileURL(path.resolve(__dirname, '../../../../../../services/api/dist/src/voice-coaching', name)).href);
const apiSrc = name => import(pathToFileURL(path.resolve(__dirname, '../../../../../../services/api/dist/src', name)).href);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
const rejects = call => assert.throws(call, error => error instanceof StandardWireError && error.tag === 'standard_wire_error');

 test('app and API independently decode known vectors and each other across every union and optional review', async () => {
  const server = (await api('standard/wire-codec.js')).createStandardWireCodec(limits);
  for (const receiver of [codec, server]) assert.deepEqual(receiver.decodeRequest(request).audio, bytes);
  const backing = new Uint8Array([91, ...bytes, 92]);
  for (const sender of [codec, server]) {
    assert.equal(sender.encodeRequest({ audio: backing.subarray(1, 7), mediaType: 'audio/wav' }), request);
    for (const kind of ['succeeded', 'not_dispatched', 'rejected', 'unknown']) {
      for (const accounting of ['not_reserved', 'replay', 'released', 'settled', 'not_consumed', 'unknown', 'unresolved']) {
        for (const review of [undefined, { transcript: '' }, { transcript: 'É🧘\u0000漢', reply: '' }, { transcript: '\udfff', reply: '"\\\n' }]) {
          const outcome = kind === 'succeeded' ? { kind, value: { mediaType: 'audio/wav', audio: bytes } } : { kind, reason: '' };
          const result = { outcome, accounting, ...(review === undefined ? {} : { review }) };
          const vector = JSON.stringify({ version: 1, kind: 'result', outcome: kind === 'succeeded'
            ? { kind, value: { mediaType: 'audio/wav', base64: 'AAEC/f7/' } } : outcome,
          accounting, ...(review === undefined ? {} : { review }) });
          assert.equal(sender.encodeResult(result), vector);
          for (const receiver of [codec, server]) assert.deepEqual(receiver.decodeResult(vector), result);
        }
      }
    }
  }
});

test('app rejects malformed, noncanonical, authority-bearing, oversize and unsupported data', () => {
  for (const value of ['', 'A', 'AA', 'AA===', 'A===', 'AB==', 'AAB=', 'AA=A', 'AA-_', 'AA==\n']) {
    rejects(() => codec.decodeRequest(request.replace('AAEC/f7/', value)));
  }
  for (const wire of ['{', 'null', request.replace('"version":1', '"version":2'), request.replace('audio/wav', 'audio/mp3'),
    request.replace('"version":1', '"actor":{},"version":1'), request.replace('"base64"', '"preparation":{},"base64"')]) {
    rejects(() => codec.decodeRequest(wire));
  }
  const result = { outcome: { kind: 'unknown', reason: '\u0000é🧘' }, accounting: 'unknown' };
  const wire = codec.encodeResult(result), size = Buffer.byteLength(wire);
  const exact = createStandardWireCodec({ ...limits, maxEnvelopeBytes: size });
  assert.equal(exact.encodeResult(result), wire); assert.deepEqual(exact.decodeResult(wire), result);
  const small = createStandardWireCodec({ ...limits, maxEnvelopeBytes: size - 1 });
  rejects(() => small.encodeResult(result)); rejects(() => small.decodeResult(wire));
  rejects(() => createStandardWireCodec({ ...limits, maxAudioBytes: 5 }).decodeRequest(request));
  rejects(() => codec.encodeResult({ ...result, actor: {} }));
  rejects(() => codec.encodeResult({ ...result, review: { transcript: '', reply: undefined } }));
  rejects(() => codec.encodeResult({ ...result, review: { transcript: '', metadata: {} } }));
  rejects(() => codec.encodeResult({ ...result, review: { transcript: 'a'.repeat(65) } }));
  rejects(() => codec.encodeResult({ ...result, outcome: { kind: 'unknown', reason: '', value: {} } }));
});

function turnInput(audioBlob = new Blob([bytes], { type: 'audio/wav' })) {
  const abort = new AbortController(), account = { accountId: 'a', authSessionId: 's', accountEpoch: 1 };
  let current = true;
  return { abort, stale() { current = false; }, input: { scope: { account, isCurrent: () => current },
    fence: { ...account, generation: 1 }, sessionId: 'turn-1', audioBlob, signal: abort.signal,
    assertCurrent() { assert.equal(current, true); } } };
}

test('client bounds Blob before reading and checks cancellation/currentness around both awaits', async () => {
  let reads = 0, exchanges = 0;
  class ObservedBlob extends Blob { async arrayBuffer() { reads++; return super.arrayBuffer(); } }
  const turn = createStandardWireTurn({ limits: { ...limits, maxAudioBytes: 5 }, exchange: async () => { exchanges++; return ''; } });
  await assert.rejects(turn.run(turnInput(new ObservedBlob([bytes], { type: 'audio/wav' })).input), StandardWireError);
  assert.equal(reads, 0); assert.equal(exchanges, 0);
  for (const invalidation of ['abort', 'stale']) {
    const pending = deferred(), entered = deferred();
    class DeferredBlob extends Blob { arrayBuffer() { entered.resolve(); return pending.promise; } }
    const f = turnInput(new DeferredBlob([bytes], { type: 'audio/wav' }));
    const port = createStandardWireTurn({ limits, exchange: async () => { exchanges++; return ''; } });
    const running = port.run(f.input); await entered.promise;
    invalidation === 'abort' ? f.abort.abort() : f.stale();
    pending.resolve(bytes.buffer); await assert.rejects(running); assert.equal(exchanges, 0);
  }
  for (const invalidation of ['abort', 'stale']) {
    const pending = deferred(), entered = deferred(), f = turnInput();
    const port = createStandardWireTurn({ limits, exchange: async (wire, signal) => {
      assert.equal(wire, request); assert.equal(signal, f.abort.signal); entered.resolve(); return pending.promise;
    } });
    const running = port.run(f.input); await entered.promise;
    invalidation === 'abort' ? f.abort.abort() : f.stale();
    pending.resolve(codec.encodeResult({ outcome: { kind: 'unknown', reason: '' }, accounting: 'unknown' }));
    await assert.rejects(running);
  }
});

function wave() {
  return Uint8Array.from(Buffer.from('524946462600000057415645666d74201000000001000100803e0000007d00000200100064617461020000000000', 'hex'));
}
async function composition({ unknown = false, delayed = false, malformed = false, reserve, retry, lose, ids, fake } = {}) {
  const { createStandardTurnController, standardTurnStages } = await api('turn-controller.js');
  const { createStandardWireHandler } = await api('standard/wire-turn.js');
  const events = [], states = [], exchanges = [], entered = deferred(), pending = deferred();
  const account = { accountId: 'original', authSessionId: 'auth', accountEpoch: 1 };
  const actor = { accountId: 'original', authUserId: 'user', sessionId: 'auth', epoch: 1 };
  const handle = { reservationId: 'reservation', actor, operation: 'standard', intentHash: 'hash', subjectId: 'subject' };
  const snapshot = {};
  const controller = createStandardTurnController({
    provider: { enabled: true,
      async transcribe(scope, input) { events.push('transcribe'); assert.deepEqual(scope.actor, actor);
        assert.deepEqual(new Uint8Array(await input.audio.arrayBuffer()), wave()); return { kind: 'succeeded', value: 'É🧘 synthetic' }; },
      async complete() { events.push('complete'); return { kind: 'succeeded', value: '' }; },
      async synthesize() { events.push('synthesize'); return { kind: 'succeeded', value: { audio: wave(), mediaType: 'audio/wav' } }; },
    },
    usage: { reserve() {
      events.push('reserve');
      return reserve ? reserve(handle, snapshot) : { kind: 'new', handle, state: 'reserved', snapshot };
    },
      markDispatching(value, stage) { assert.equal(value, handle); events.push(stage + ':permit'); return { reservationId: handle.reservationId, stage, dispatchedAtMs: 1 }; },
      status() { assert.fail('unused'); } },
    trusted: { settle() { events.push('settle'); return snapshot; }, markUnknown() { events.push('unknown'); return snapshot; },
      release() { assert.fail('must not release dispatched liability'); }, reconcile() { assert.fail('unused'); } },
    policy: { intent: { operation: 'standard', idempotencyKey: 'turn', intentHash: 'hash', subjectId: 'subject',
      charges: [{ metric: 'coach_messages', amount: 1 }], dispatchStages: [...standardTurnStages] },
    resolve: () => unknown ? { kind: 'unknown' } : { kind: 'settle', settlement: { charges: [{ metric: 'coach_messages', amount: 1 }] } } },
    prepareCompletion: async (_scope, input) => ({ text: input.transcript }),
  });
  const handler = createStandardWireHandler({ limits, controller });
  const mic = new ExclusiveMicOwner({ async acquire({ fence }) { return { fence,
    stopCapture() {}, stopPlayback() {}, async deactivateAudio() {}, async release() {} }; } });
  const shared = new VoiceSessionController(mic, () => {});
  const scope = { account, isCurrent: () => true };
  const consumer = createStandardVoiceConsumer({ scope, newSessionId: ids ? ids() : () => 'turn', onManual() {},
    host: { async startStandard(_scope, _id, signal) {
      const fence = await shared.start({ mode: 'standard', account, signal,
        transport: { abortPending() {}, closeTransport() {}, async requestServerStop() {} } });
      return { fence, assertCurrent() { shared.assertCurrent(fence); }, async startCapture() {},
        async finishCapture() { return new Blob([wave()], { type: 'audio/wav' }); },
        async play(blob) { events.push('play'); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), wave()); },
        async stop(reason) { return shared.stop(reason).local; } };
    } },
    turn: fake ? { async run() { return fake; } } : createStandardWireTurn({ limits, ...(retry ? { retryUnknownResult: retry } : {}), exchange: async (wire, signal, turn) => {
      events.push('exchange'); exchanges.push({ wire, key: turn.idempotencyKey, attempt: turn.attempt });
      const loss = lose ? lose(turn.attempt) : undefined;
      if (loss === 'before') throw new Error('response lost');
      const result = await handler.run({ actor, signal, assertCurrent() { signal.throwIfAborted(); } }, wire);
      if (loss === 'after') throw new Error('response lost');
      entered.resolve();
      if (delayed) await pending.promise;
      return malformed ? '{' : result;
    } }),
  });
  consumer.subscribe(state => states.push(state));
  return { consumer, shared, scope, events, states, exchanges, entered, pending };
}

test('real server controller and shared voice consumer compose through wire with settled-only playback', async () => {
  for (const unknown of [false, true]) {
    const f = await composition({ unknown });
    try {
      await f.consumer.start(); await f.consumer.finishAndSend();
      assert.equal(f.consumer.snapshot().phase, unknown ? 'unknown' : 'completed');
      assert.equal(f.consumer.snapshot().accounting, unknown ? 'unknown' : 'settled');
      assert.equal(f.events.filter(event => event === 'play').length, unknown ? 0 : 1);
      assert.equal(f.events.filter(event => event === 'exchange').length, 1);
      assert.deepEqual(f.consumer.review(), { transcript: 'É🧘 synthetic', reply: '' });
      assert.equal(JSON.stringify(f.states).includes('synthetic'), false);
    } finally { await f.consumer.dispose(); }
  }
});

test('real shared generation invalidation rejects delayed response with unchanged account scope', async () => {
  const f = await composition({ delayed: true });
  try {
    await f.consumer.start(); const running = f.consumer.finishAndSend(); await f.entered.promise;
    await f.shared.stop('background').local; assert.equal(f.scope.isCurrent(), true);
    f.pending.resolve(); await running;
    assert.equal(f.consumer.snapshot().phase, 'unknown'); assert.equal(f.consumer.snapshot().accounting, 'unknown');
    assert.equal(f.events.includes('play'), false); assert.equal(f.consumer.review(), null);
    assert.equal(f.states.some(state => state.accounting === 'settled'), false);
  } finally { f.pending.resolve(); await f.consumer.dispose(); }
});

function usageVectors() {
  const accountings = ['not_reserved', 'replay', 'released', 'settled', 'not_consumed', 'unknown', 'unresolved'];
  const vectors = [];
  for (const [reason, entry] of Object.entries(standardWireUsageReasons)) {
    vectors.push([{ outcome: { kind: 'not_dispatched', reason }, accounting: entry.accounting }, entry.outcome]);
    for (const accounting of accountings) {
      if (accounting !== entry.accounting) vectors.push([{ outcome: { kind: 'not_dispatched', reason }, accounting }, undefined]);
    }
    for (const kind of ['rejected', 'unknown']) vectors.push([{ outcome: { kind, reason }, accounting: entry.accounting }, undefined]);
  }
  vectors.push([{ outcome: { kind: 'succeeded', value: {} }, accounting: 'settled' }, undefined]);
  for (const reason of ['toString', '__proto__', '', 7, null, undefined]) {
    vectors.push([{ outcome: { kind: 'not_dispatched', reason }, accounting: 'not_reserved' }, undefined]);
  }
  return vectors;
}

test('app and API usage vocabularies are identical and classify every vector the same way', async () => {
  const server = await api('standard/wire-usage.js');
  assert.deepEqual(standardWireUsageReasons, server.standardWireUsageReasons);
  assert.equal(Object.isFrozen(standardWireUsageReasons), true);
  assert.deepEqual(Object.keys(standardWireUsageReasons).sort(), Object.keys(server.standardWireUsageReasons).sort());
  for (const [value, expected] of usageVectors()) {
    assert.equal(standardWireUsageOutcome(value), expected);
    assert.equal(server.standardWireUsageOutcome(value), expected);
  }
});

test('turn key derives from the session id and refuses anything that is not key-safe', () => {
  assert.equal(standardTurnIdempotencyKey('turn'), 'std-turn:turn');
  const uuid = '01234567-89ab-4def-8123-456789abcdef';
  assert.match(standardTurnIdempotencyKey(uuid), /^[A-Za-z0-9_.:-]{8,128}$/);
  assert.equal(standardTurnIdempotencyKey('a'.repeat(112)).length, 121);
  for (const bad of ['', ' ', 'a b', 'a/b', 'a'.repeat(113), 'é', undefined, null, 7]) {
    assert.throws(() => standardTurnIdempotencyKey(bad), { message: 'standard_wire_key_invalid' });
  }
});

test('real server refusals reach the consumer as typed usage outcomes with no dispatch, audio, review or private detail', async () => {
  const { DomainError } = await apiSrc('errors.js');
  const marker = 'PRIVATE-MARKER-9a2e';
  const rows = [
    [new DomainError(429, 'usage_limit_exceeded', `${marker} message`, { marker }), 'limit_reached', 'not_reserved'],
    [new DomainError(403, 'usage_capability_denied', marker, { marker }), 'not_entitled', 'not_reserved'],
    [new DomainError(503, 'usage_unconfigured', marker), 'unconfigured', 'not_reserved'],
    [new DomainError(503, 'usage_operation_unconfigured', marker), 'unconfigured', 'not_reserved'],
    [new DomainError(503, 'usage_rights_unconfigured', marker), 'unconfigured', 'not_reserved'],
    [new DomainError(503, 'usage_provider_unconfigured', marker), 'unconfigured', 'not_reserved'],
    [new DomainError(409, 'usage_idempotency_mismatch', marker), 'key_conflict', 'not_reserved'],
    [new DomainError(403, 'usage_actor_mismatch', marker), 'key_conflict', 'not_reserved'],
    [new Error(marker), 'unavailable', 'unresolved'],
  ];
  for (const [failure, usage, accounting] of rows) {
    const f = await composition({ reserve() { throw failure; } });
    try {
      await f.consumer.start(); await f.consumer.finishAndSend();
      assert.deepEqual(f.consumer.snapshot(), { reviewAvailable: false, phase: 'failed', cleanup: 'released',
        failure: 'turn_not_dispatched', outcome: 'not_dispatched', accounting, usage }, failure.code ?? 'error');
      assert.deepEqual(f.events, ['exchange', 'reserve']);
      assert.equal(f.consumer.review(), null);
      assert.equal(JSON.stringify(f.states).includes(marker), false);
    } finally { await f.consumer.dispose(); }
  }
});

test('a duplicate delivery is reported as replayed with no audio or review', async () => {
  const f = await composition({ reserve: (handle, snapshot) => ({ kind: 'replay', handle, state: 'settled', snapshot }) });
  try {
    await f.consumer.start(); await f.consumer.finishAndSend();
    assert.deepEqual(f.consumer.snapshot(), { reviewAvailable: false, phase: 'failed', cleanup: 'released',
      failure: 'turn_not_dispatched', outcome: 'not_dispatched', accounting: 'replay', usage: 'replayed' });
    assert.equal(f.events.includes('play'), false); assert.equal(f.consumer.review(), null);
  } finally { await f.consumer.dispose(); }
});

test('the consumer accepts a usage outcome only from a known name on a not-dispatched result', async () => {
  const refused = (outcome, usage) => ({ outcome, accounting: 'not_reserved', ...(usage === undefined ? {} : { usage }) });
  const rows = [
    [refused({ kind: 'not_dispatched', reason: 'x' }, 'limit_reached'), 'limit_reached'],
    [refused({ kind: 'not_dispatched', reason: 'x' }, 'invented'), undefined],
    [refused({ kind: 'not_dispatched', reason: 'x' }, 'toString'), undefined],
    [refused({ kind: 'not_dispatched', reason: 'x' }), undefined],
    [refused({ kind: 'rejected', reason: 'x' }, 'limit_reached'), undefined],
    [refused({ kind: 'unknown', reason: 'x' }, 'limit_reached'), undefined],
  ];
  for (const [result, expected] of rows) {
    const f = await composition({ fake: result });
    try {
      await f.consumer.start(); await f.consumer.finishAndSend();
      assert.equal(f.consumer.snapshot().usage, expected, JSON.stringify(result));
    } finally { await f.consumer.dispose(); }
  }
});

test('a later turn does not inherit the usage outcome of an earlier one', async () => {
  let reserves = 0;
  const f = await composition({ ids: () => { let n = 0; return () => `turn-${++n}`; },
    reserve: (handle, snapshot) => {
      if (++reserves === 1) throw new Error('first reservation fails');
      return { kind: 'new', handle, state: 'reserved', snapshot };
    } });
  try {
    await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(f.consumer.snapshot().usage, 'unavailable');
    await f.consumer.stop('user_stop'); await f.consumer.start();
    assert.equal(Object.hasOwn(f.consumer.snapshot(), 'usage'), false);
    await f.consumer.finishAndSend();
    assert.equal(f.consumer.snapshot().accounting, 'settled'); assert.equal(Object.hasOwn(f.consumer.snapshot(), 'usage'), false);
  } finally { await f.consumer.dispose(); }
});

test('one same-key retry after a lost response is a ledger replay: one charge, identical bytes, no audio', async () => {
  let reserves = 0;
  const f = await composition({ retry: () => true, lose: attempt => attempt === 1 ? 'after' : undefined,
    reserve: (handle, snapshot) => ++reserves === 1
      ? { kind: 'new', handle, state: 'reserved', snapshot } : { kind: 'replay', handle, state: 'settled', snapshot } });
  try {
    await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(f.exchanges.length, 2);
    assert.equal(f.exchanges[0].wire, f.exchanges[1].wire);
    assert.equal(f.exchanges[0].key, 'std-turn:turn'); assert.equal(f.exchanges[1].key, 'std-turn:turn');
    assert.deepEqual(f.exchanges.map(entry => entry.attempt), [1, 2]);
    assert.deepEqual(f.events.filter(event => ['transcribe', 'complete', 'synthesize', 'settle'].includes(event)),
      ['transcribe', 'complete', 'synthesize', 'settle']);
    const snapshot = f.consumer.snapshot();
    assert.equal(snapshot.accounting, 'replay'); assert.equal(snapshot.usage, 'replayed');
    assert.equal(f.events.includes('play'), false); assert.equal(f.consumer.review(), null);
  } finally { await f.consumer.dispose(); }
});

test('a retry whose first request never arrived runs the turn once and plays it', async () => {
  const f = await composition({ retry: () => true, lose: attempt => attempt === 1 ? 'before' : undefined });
  try {
    await f.consumer.start(); await f.consumer.finishAndSend();
    assert.equal(f.exchanges.length, 2); assert.equal(f.exchanges[0].key, f.exchanges[1].key);
    assert.equal(f.consumer.snapshot().phase, 'completed'); assert.equal(f.consumer.snapshot().accounting, 'settled');
    assert.equal(f.events.filter(event => event === 'reserve').length, 1);
    assert.equal(f.events.filter(event => event === 'settle').length, 1);
    assert.equal(f.events.filter(event => event === 'play').length, 1);
  } finally { await f.consumer.dispose(); }
});

test('retry is off by default and never follows a false or throwing predicate, abort, stale scope or a second loss', async () => {
  async function run({ predicate, before } = {}) {
    const f = turnInput(), seen = [];
    const port = createStandardWireTurn({ limits, ...(predicate ? { retryUnknownResult: predicate } : {}),
      exchange: async (wire, _signal, turn) => {
        seen.push({ wire, key: turn.idempotencyKey, attempt: turn.attempt });
        if (turn.attempt === 1 && before) before(f);
        throw new Error('lost');
      } });
    await assert.rejects(port.run(f.input));
    return seen;
  }
  assert.equal((await run()).length, 1);
  assert.equal((await run({ predicate: () => false })).length, 1);
  assert.equal((await run({ predicate: () => 'true' })).length, 1);
  assert.equal((await run({ predicate: () => { throw new Error('predicate failure'); } })).length, 1);
  assert.equal((await run({ predicate: () => true, before: f => f.abort.abort() })).length, 1);
  assert.deepEqual((await run({ predicate: () => true, before: f => f.stale() })).map(entry => entry.attempt), [1]);
  const twice = await run({ predicate: () => true });
  assert.deepEqual(twice.map(entry => entry.attempt), [1, 2]);
  assert.equal(twice[0].wire, twice[1].wire); assert.equal(twice[0].key, twice[1].key);
});

test('two consecutive turns on one consumer use different keys', async () => {
  const f = await composition({ ids: () => { let n = 0; return () => `turn-${++n}`; } });
  try {
    await f.consumer.start(); await f.consumer.finishAndSend(); await f.consumer.stop('user_stop');
    await f.consumer.start(); await f.consumer.finishAndSend();
    assert.deepEqual(f.exchanges.map(entry => entry.key), ['std-turn:turn-1', 'std-turn:turn-2']);
  } finally { await f.consumer.dispose(); }
});

test('cancelled and malformed post-dispatch responses never retry, release liability, expose review or play', async () => {
  for (const cancel of [false, true]) {
    const f = await composition({ delayed: cancel, malformed: !cancel });
    try {
      await f.consumer.start(); const running = f.consumer.finishAndSend(); await f.entered.promise;
      if (cancel) { await f.consumer.stop('user_stop'); f.pending.resolve(); }
      await running;
      assert.equal(f.consumer.snapshot().accounting, 'unknown'); assert.equal(f.events.includes('play'), false);
      assert.equal(f.events.filter(event => event === 'exchange').length, 1);
      assert.equal(f.consumer.review(), null);
    } finally { f.pending.resolve(); await f.consumer.dispose(); }
  }
});
