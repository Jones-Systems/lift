import assert from 'node:assert/strict';
import test from 'node:test';
import { createStandardWireCodec, StandardWireError, type StandardWireResult } from '../../src/voice-coaching/standard/wire-codec.js';
import { createStandardWireHandler } from '../../src/voice-coaching/standard/wire-turn.js';
import { standardWireUsageOutcome, standardWireUsageReasons } from '../../src/voice-coaching/standard/wire-usage.js';

const limits = { maxAudioBytes: 64, maxEnvelopeBytes: 2048, maxTextCharacters: 32 };
const codec = createStandardWireCodec(limits);
const request = '{"version":1,"kind":"request","audio":{"mediaType":"audio/wav","base64":"AAEC/f7/"}}';
const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
const rejected = (call: () => unknown) => assert.throws(call, (error: unknown) => error instanceof StandardWireError && error.tag === 'standard_wire_error');

test('independent request vector preserves exact view offsets and base64 bytes', () => {
  assert.deepEqual(codec.decodeRequest(request), { mediaType: 'audio/wav', audio: bytes });
  const backing = new Uint8Array([99, ...bytes, 99]);
  assert.equal(codec.encodeRequest({ audio: backing.subarray(1, 7), mediaType: 'audio/wav' }), request);
  for (const [base64, expected] of [['AA==', [0]], ['AP8=', [0, 255]], ['/w==', [255]]] as const) {
    assert.deepEqual([...codec.decodeRequest(request.replace('AAEC/f7/', base64)).audio], expected);
  }
});

test('all result and accounting discriminants preserve exact optional review', () => {
  for (const accounting of ['not_reserved', 'replay', 'released', 'settled', 'not_consumed', 'unknown', 'unresolved'] as const) {
    for (const kind of ['succeeded', 'not_dispatched', 'rejected', 'unknown'] as const) {
      for (const review of [undefined, { transcript: '' }, { transcript: 'É\u0000🧘漢', reply: '' }, { transcript: '\ud800', reply: 'a\n"\\' }]) {
        const outcome: StandardWireResult['outcome'] = kind === 'succeeded'
          ? { kind, value: { audio: bytes, mediaType: 'audio/wav' } } : { kind, reason: '' };
        const result = { outcome, accounting, ...(review === undefined ? {} : { review }) };
        const vector = JSON.stringify({ version: 1, kind: 'result', outcome: kind === 'succeeded'
          ? { kind, value: { mediaType: 'audio/wav', base64: 'AAEC/f7/' } } : outcome,
        accounting, ...(review === undefined ? {} : { review }) });
        assert.deepEqual(codec.decodeResult(vector), result);
        assert.equal(codec.encodeResult(result), vector);
      }
    }
  }
});

test('strict schema rejects versions, extra authority/private fields, media and invalid base64', () => {
  for (const wire of ['', '{', 'null', '[]', request.replace('"version":1', '"version":2'),
    request.replace('"audio/wav"', '"audio/mp3"'), request.replace('"version":1', '"actor":{},"version":1'),
    request.replace('"mediaType"', '"grants":[],"mediaType"')]) rejected(() => codec.decodeRequest(wire));
  for (const value of ['', 'A', 'AA', 'AAA', 'A===', '====', 'AA=A', 'AB==', 'AAB=', 'AA-_', 'AA==\n', ' AA=', 'éAAA']) {
    rejected(() => codec.decodeRequest(request.replace('AAEC/f7/', value)));
  }
  const result = { version: 1, kind: 'result', outcome: { kind: 'unknown', reason: '' }, accounting: 'unknown' };
  for (const value of [{ ...result, metadata: {} }, { ...result, accounting: 'invented' },
    { ...result, outcome: { kind: 'invented', reason: '' } },
    { ...result, outcome: { kind: 'unknown', reason: '', value: {} } },
    { ...result, review: { transcript: '', preparation: {} } }, { ...result, review: { transcript: '', reply: null } }]) {
    rejected(() => codec.decodeResult(JSON.stringify(value)));
  }
});

test('audio, UTF-8 envelope and escaped text bounds apply exactly before conversion', () => {
  const exact = createStandardWireCodec({ ...limits, maxAudioBytes: 6, maxEnvelopeBytes: Buffer.byteLength(request) });
  assert.equal(exact.encodeRequest({ audio: bytes, mediaType: 'audio/wav' }), request);
  assert.deepEqual(exact.decodeRequest(request).audio, bytes);
  rejected(() => createStandardWireCodec({ ...limits, maxAudioBytes: 5 }).decodeRequest(request));
  rejected(() => createStandardWireCodec({ ...limits, maxEnvelopeBytes: request.length - 1 }).decodeRequest(request));
  const result: StandardWireResult = { outcome: { kind: 'unknown', reason: '\u0000é🧘' }, accounting: 'unknown' };
  const wire = codec.encodeResult(result), size = Buffer.byteLength(wire);
  const bounded = createStandardWireCodec({ ...limits, maxEnvelopeBytes: size });
  assert.equal(bounded.encodeResult(result), wire); assert.deepEqual(bounded.decodeResult(wire), result);
  rejected(() => createStandardWireCodec({ ...limits, maxEnvelopeBytes: size - 1 }).encodeResult(result));
  rejected(() => createStandardWireCodec({ ...limits, maxEnvelopeBytes: size - 1 }).decodeResult(wire));
  rejected(() => codec.encodeResult({ ...result, review: { transcript: 'a'.repeat(33) } }));
  for (const value of [0, -1, NaN, Infinity, 0.5, 100_000_001]) rejected(() => createStandardWireCodec({ ...limits, maxAudioBytes: value }));
});

test('handler takes authority only from the independently supplied scope, never the envelope', async () => {
  const abort = new AbortController(); let checks = 0, runs = 0;
  const actor = { accountId: 'a', authUserId: 'u', sessionId: 's', epoch: 1 };
  const scope = { actor, signal: abort.signal, assertCurrent() { checks++; } };
  const handler = createStandardWireHandler({ limits, controller: { async run(original, input) {
    runs++; assert.deepEqual(original.actor, actor); assert.equal(original.signal, abort.signal);
    assert.equal(input.format, 'wav'); assert.equal(input.audio.type, 'audio/wav');
    assert.deepEqual(new Uint8Array(await input.audio.arrayBuffer()), bytes);
    return { outcome: { kind: 'unknown', reason: '' }, accounting: 'unresolved' };
  } } });
  assert.deepEqual(codec.decodeResult(await handler.run(scope, request)), { outcome: { kind: 'unknown', reason: '' }, accounting: 'unresolved' });
  assert.equal(runs, 1); assert.ok(checks >= 3);
  await assert.rejects(handler.run(scope, request.replace('"version":1', '"reservation":{},"version":1')), StandardWireError);
  assert.equal(runs, 1);
  abort.abort(); await assert.rejects(handler.run(scope, request)); assert.equal(runs, 1);
});

test('every reserved usage reason round-trips unchanged at the production text bound and names its outcome', () => {
  assert.deepEqual(Object.keys(standardWireUsageReasons).sort(), ['usage_key_conflict', 'usage_limit_reached', 'usage_not_entitled',
    'usage_replay_no_dispatch', 'usage_reservation_unavailable', 'usage_unconfigured']);
  assert.equal(Object.isFrozen(standardWireUsageReasons), true);
  for (const entry of Object.values(standardWireUsageReasons)) assert.equal(Object.isFrozen(entry), true);
  for (const [reason, entry] of Object.entries(standardWireUsageReasons)) {
    const result: StandardWireResult = { outcome: { kind: 'not_dispatched', reason }, accounting: entry.accounting };
    const wire = codec.encodeResult(result);
    assert.deepEqual(codec.decodeResult(wire), result);
    assert.equal(standardWireUsageOutcome(codec.decodeResult(wire)), entry.outcome);
  }
});

test('a usage outcome needs the exact reserved kind, reason and accounting', () => {
  const accountings = ['not_reserved', 'replay', 'released', 'settled', 'not_consumed', 'unknown', 'unresolved'] as const;
  for (const [reason, entry] of Object.entries(standardWireUsageReasons)) {
    for (const accounting of accountings) {
      if (accounting === entry.accounting) continue;
      assert.equal(standardWireUsageOutcome({ outcome: { kind: 'not_dispatched', reason }, accounting }), undefined, `${reason}/${accounting}`);
    }
    for (const kind of ['rejected', 'unknown'] as const) {
      assert.equal(standardWireUsageOutcome({ outcome: { kind, reason }, accounting: entry.accounting }), undefined, `${reason}/${kind}`);
    }
  }
  assert.equal(standardWireUsageOutcome({ outcome: { kind: 'succeeded' }, accounting: 'settled' }), undefined);
  for (const reason of ['toString', '__proto__', 'constructor', '', 7, null, undefined, {}]) {
    assert.equal(standardWireUsageOutcome({ outcome: { kind: 'not_dispatched', reason }, accounting: 'not_reserved' }), undefined);
  }
});
