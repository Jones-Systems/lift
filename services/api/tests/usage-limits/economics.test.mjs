import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateOfflineCost, OfflineCostInputError } from '../../../../docs/live-coaching/usage/offline-cost.mjs';

const AS_OF = '2026-10-11T03:06:27Z';
const rule = (numerator, denominator, perUnits, minimum = 0, quantization = { mode: 'exact' }) => ({
  usd: { numerator, denominator }, perUnits, minimum, quantization,
});
function audio() {
  return {
    id: 'fixture-stt-price', providerId: 'groq', modelId: 'whisper-large-v3-turbo',
    sourceUrl: 'https://console.groq.com/docs/speech-to-text', asOf: AS_OF, currency: 'USD',
    billingBasis: 'audio_input_ms', countingSemantics: 'fixture-explicit-continuous-ms-v1',
    rules: { audio_input_ms: rule(4, 100, 3600000, 10000) },
  };
}
function tokens() {
  return {
    id: 'fixture-text-price', providerId: 'fixture-provider', modelId: 'fixture-chat-model',
    sourceUrl: 'https://example.invalid/fixture-rates', asOf: AS_OF, currency: 'USD',
    billingBasis: 'text_tokens', countingSemantics: 'fixture-inclusive-token-counts-v1',
    rules: {
      input_uncached_tokens: rule(2, 1, 1000000), input_cached_tokens: rule(1, 2, 1000000),
      output_tokens: rule(4, 1, 1000000),
    },
  };
}
function realtime() {
  const prices = {
    text_input_uncached_tokens: 2, text_input_cached_tokens: 1,
    audio_input_uncached_tokens: 10, audio_input_cached_tokens: 3,
    image_input_uncached_tokens: 4, image_input_cached_tokens: 2,
    text_output_tokens: 5, audio_output_tokens: 20,
  };
  return { ...tokens(), id: 'fixture-realtime-price', modelId: 'fixture-realtime-model', billingBasis: 'realtime_tokens',
    rules: Object.fromEntries(Object.entries(prices).map(([unit, rate]) => [unit, rule(rate, 1, 1000)])) };
}
function receipt(binding, id, usage) {
  return { id, providerId: binding.providerId, modelId: binding.modelId, priceBindingId: binding.id,
    sourceId: 'fixture-normalized-usage-v1', asOf: AS_OF, measurement: 'scenario', telemetry: 'complete',
    billingBasis: binding.billingBasis, countingSemantics: binding.countingSemantics, usage };
}
const scenario = (binding, receipts) => ({ schemaVersion: 1, priceBindings: [binding], receipts });
const dollars = (numerator, denominator) => ({ numerator: String(numerator), denominator: String(denominator) });
const textUsage = () => ({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100 });
const realtimeUsage = () => ({ inputTokens: 190, cachedInputTokens: 55, outputTokens: 19,
  input: { text: 100, audio: 80, image: 10 }, cached: { text: 20, audio: 30, image: 5 }, output: { text: 12, audio: 7 } });
const invalidCode = code => error => error instanceof OfflineCostInputError && error.code === code;

test('STT minimum applies to each request; pooling short requests understates the scenario', () => {
  const binding = audio();
  const result = evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', { quantity: 2500 }), receipt(binding, 'r2', { quantity: 2500 })]));
  assert.equal(result.kind, 'estimate');
  assert.deepEqual(result.usd, dollars(1, 4500));
  assert.deepEqual(result.receipts.map(item => item.quantities[0].billable), ['10000', '10000']);
  assert.deepEqual(result.receipts.map(item => item.quantities[0].observed), ['2500', '2500']);
  const pooled = evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', { quantity: 5000 })]));
  assert.deepEqual(pooled.usd, dollars(1, 9000));
});

test('post-minimum quantization must be explicitly configured, with no inferred provider quantum', () => {
  const binding = audio();
  const exact = evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', { quantity: 10001 })]));
  assert.equal(exact.receipts[0].quantities[0].billable, '10001');
  binding.rules.audio_input_ms.quantization = { mode: 'ceil', increment: 1000 };
  const rounded = evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', { quantity: 10001 })]));
  assert.equal(rounded.receipts[0].quantities[0].billable, '11000');
  delete binding.rules.audio_input_ms.quantization.increment;
  assert.equal(evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', { quantity: 10001 })])).kind, 'unknown');
});

test('TTS requires supplied billable character counts and a matching counting policy', () => {
  const binding = { ...audio(), id: 'fixture-tts-price', modelId: 'canopylabs/orpheus-v1-english',
    sourceUrl: 'https://console.groq.com/docs/text-to-speech/orpheus', billingBasis: 'billable_characters',
    countingSemantics: 'fixture-character-policy-not-provider-proof', rules: { billable_characters: rule(22, 1, 1000000) } };
  const observed = receipt(binding, 'r1', { quantity: 200 });
  assert.deepEqual(evaluateOfflineCost(scenario(binding, [observed])).usd, dollars(11, 2500));
  delete observed.countingSemantics;
  assert.equal(evaluateOfflineCost(scenario(binding, [observed])).kind, 'unknown');
  observed.countingSemantics = 'different-character-policy';
  assert.throws(() => evaluateOfflineCost(scenario(binding, [observed])), invalidCode('price_binding_mismatch'));
});

test('text cached tokens are a subset of inclusive input, not a second input total', () => {
  const binding = tokens();
  const result = evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', textUsage())]));
  assert.deepEqual(result.usd, dollars(3, 2500));
  assert.deepEqual(result.receipts[0].quantities.map(item => [item.unitId, item.observed]), [
    ['input_uncached_tokens', '200'], ['input_cached_tokens', '800'], ['output_tokens', '100'],
  ]);
  assert.throws(() => evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', { ...textUsage(), cachedInputTokens: 1001 })])),
    invalidCode('cached_exceeds_input'));
});

test('realtime partitions apply distinct modality cache rates exactly once', () => {
  const binding = realtime();
  const result = evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', realtimeUsage())]));
  assert.deepEqual(result.usd, dollars(1, 1));
  assert.deepEqual(result.receipts[0].quantities.map(item => [item.unitId, item.observed]), [
    ['text_input_uncached_tokens', '80'], ['text_input_cached_tokens', '20'],
    ['audio_input_uncached_tokens', '50'], ['audio_input_cached_tokens', '30'],
    ['image_input_uncached_tokens', '5'], ['image_input_cached_tokens', '5'],
    ['text_output_tokens', '12'], ['audio_output_tokens', '7'],
  ]);
});

test('realtime gross counters must reconcile and every cache modality must be explicit', () => {
  const binding = realtime();
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens']) {
    const usage = realtimeUsage(); usage[field]++;
    assert.throws(() => evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', usage)])), invalidCode('partition_total_mismatch'));
  }
  const impossible = realtimeUsage(); impossible.cached.image = 11;
  assert.throws(() => evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', impossible)])), invalidCode('cached_exceeds_input'));
  const incomplete = realtimeUsage(); delete incomplete.cached.audio;
  const unknown = evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', incomplete)]));
  assert.equal(unknown.kind, 'unknown'); assert.equal(unknown.usd, null);
});

test('same response receipts deduplicate while distinct responses containing repeated context still count', () => {
  const binding = tokens(), first = receipt(binding, 'response-1', textUsage());
  const result = evaluateOfflineCost(scenario(binding, [first, structuredClone(first), receipt(binding, 'response-2', textUsage())]));
  assert.equal(result.receiptCount, 2); assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.usd, dollars(3, 1250));
});

test('changed duplicate usage, evidence, or price binding is a reconciliation conflict', () => {
  const binding = tokens(), first = receipt(binding, 'r1', textUsage());
  for (const change of [value => { value.usage.outputTokens++; }, value => { value.sourceId = 'different-source'; },
    value => { value.measurement = 'provider_report'; }, value => { value.asOf = '2026-10-12T03:06:27Z'; }]) {
    const duplicate = structuredClone(first); change(duplicate);
    assert.throws(() => evaluateOfflineCost(scenario(binding, [first, duplicate])), invalidCode('receipt_conflict'));
  }
  const secondBinding = { ...binding, id: 'different-price-binding' };
  assert.throws(() => evaluateOfflineCost({ schemaVersion: 1, priceBindings: [binding, secondBinding],
    receipts: [first, receipt(secondBinding, 'r1', textUsage())] }), invalidCode('receipt_binding_conflict'));
});

test('provider and model scope prevent false receipt deduplication and mismatched pricing', () => {
  const first = tokens(), second = { ...tokens(), id: 'provider-2-price', providerId: 'provider-2' },
    third = { ...tokens(), id: 'model-2-price', modelId: 'model-2' };
  const result = evaluateOfflineCost({ schemaVersion: 1, priceBindings: [first, second, third],
    receipts: [first, second, third].map(binding => receipt(binding, 'same-response-id', textUsage())) });
  assert.equal(result.receiptCount, 3); assert.equal(result.duplicateCount, 0);
  assert.deepEqual(result.usd, dollars(9, 2500));
  const mismatch = receipt(first, 'r1', textUsage()); mismatch.modelId = 'unbound-model';
  assert.throws(() => evaluateOfflineCost(scenario(first, [mismatch])), invalidCode('price_binding_mismatch'));
});

test('missing model, rate, provenance, policy, or price binding yields unknown rather than a default', () => {
  const binding = tokens();
  const original = scenario(binding, [receipt(binding, 'r1', textUsage())]);
  const changes = [
    value => { delete value.priceBindings[0].modelId; }, value => { delete value.priceBindings[0].sourceUrl; },
    value => { delete value.priceBindings[0].asOf; }, value => { delete value.priceBindings[0].countingSemantics; },
    value => { delete value.priceBindings[0].rules.input_cached_tokens; },
    value => { delete value.priceBindings[0].rules.output_tokens.minimum; },
    value => { delete value.priceBindings[0].rules.output_tokens.quantization; },
    value => { value.receipts[0].priceBindingId = 'unconfigured-price'; },
    value => { delete value.receipts[0].sourceId; }, value => { delete value.receipts[0].asOf; },
    value => { delete value.receipts[0].measurement; }, value => { value.receipts = []; },
  ];
  for (const change of changes) {
    const input = structuredClone(original); change(input);
    const result = evaluateOfflineCost(input);
    assert.equal(result.kind, 'unknown'); assert.equal(result.usd, null);
    assert.equal(result.actualBilledCost, false);
  }
});

test('partial or missing telemetry prevents a full total without publishing a known prefix subtotal', () => {
  const binding = tokens();
  for (const telemetry of ['partial', 'missing']) {
    const input = scenario(binding, [receipt(binding, 'complete', textUsage()), { ...receipt(binding, 'incomplete', {}), telemetry }]);
    const before = structuredClone(input), result = evaluateOfflineCost(input);
    assert.equal(result.kind, 'unknown'); assert.equal(result.usd, null);
    assert.equal(result.reason.code, `${telemetry}_telemetry`);
    assert.equal(Object.hasOwn(result, 'receipts'), false);
    assert.deepEqual(input, before);
  }
  const incomplete = textUsage(); delete incomplete.cachedInputTokens;
  assert.equal(evaluateOfflineCost(scenario(binding, [receipt(binding, 'r1', incomplete)])).kind, 'unknown');
});

test('invalid and unsafe quantities or monetary factors are rejected before arithmetic', () => {
  const binding = tokens(), base = scenario(binding, [receipt(binding, 'r1', textUsage())]);
  for (const quantity of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '01', '1e6']) {
    const input = structuredClone(base); input.receipts[0].usage.outputTokens = quantity;
    assert.throws(() => evaluateOfflineCost(input), OfflineCostInputError);
  }
  for (const mutate of [value => { value.usd.denominator = 0; }, value => { value.usd.numerator = -1; },
    value => { value.perUnits = 0; }, value => { value.minimum = 0.25; },
    value => { value.quantization = { mode: 'ceil', increment: 0 }; }]) {
    const input = structuredClone(base); mutate(input.priceBindings[0].rules.output_tokens);
    assert.throws(() => evaluateOfflineCost(input), OfflineCostInputError);
  }
  const huge = audio(); huge.rules.audio_input_ms.quantization = { mode: 'ceil', increment: 2 };
  assert.throws(() => evaluateOfflineCost(scenario(huge, [receipt(huge, 'r1', { quantity: Number.MAX_SAFE_INTEGER })])),
    invalidCode('quantized_quantity_out_of_bounds'));
});

test('strict schema excludes content, quota durations, unsupported bases, and unbounded lists', () => {
  const binding = tokens(), base = scenario(binding, [receipt(binding, 'r1', textUsage())]);
  for (const mutate of [value => { value.schemaVersion = 2; }, value => { value.receipts[0].transcript = 'content'; },
    value => { value.receipts[0].usage.live_voice_ms = 9000000; }, value => { value.priceBindings[0].billingBasis = 'wav_bytes'; },
    value => { value.receipts = Array.from({ length: 129 }, () => value.receipts[0]); },
    value => { value.priceBindings = Array.from({ length: 33 }, () => binding); },
    value => { value.priceBindings.push(structuredClone(binding)); }]) {
    const input = structuredClone(base); mutate(input);
    assert.throws(() => evaluateOfflineCost(input), OfflineCostInputError);
  }
});

test('fractional USD sums exactly without per-receipt cents rounding or floating point loss', () => {
  const binding = audio(); binding.rules.audio_input_ms = rule(1, 3, 1000000);
  const result = evaluateOfflineCost(scenario(binding, [1, 2, 3].map(value => receipt(binding, `r${value}`, { quantity: 1 }))));
  assert.deepEqual(result.receipts.map(value => value.usd), [dollars(1, 3000000), dollars(1, 3000000), dollars(1, 3000000)]);
  assert.deepEqual(result.usd, dollars(1, 1000000));
  const maximum = Number.MAX_SAFE_INTEGER.toString();
  binding.rules.audio_input_ms = rule(maximum, maximum, maximum);
  assert.deepEqual(evaluateOfflineCost(scenario(binding, [receipt(binding, 'max', { quantity: maximum })])).usd, dollars(1, 1));
});

test('price and observation provenance, unit identities, and estimate labels survive without invoice claims', () => {
  const binding = tokens(), input = scenario(binding, [{ ...receipt(binding, 'r1', textUsage()), measurement: 'provider_report' }]);
  const before = structuredClone(input), result = evaluateOfflineCost(input);
  assert.equal(result.label, 'public-list-price estimate'); assert.equal(result.actualBilledCost, false);
  assert.equal(result.priceBindings[0].sourceUrl, binding.sourceUrl); assert.equal(result.priceBindings[0].asOf, AS_OF);
  assert.equal(result.priceBindings[0].rules.input_cached_tokens.usd.denominator, '2');
  assert.equal(result.receipts[0].sourceId, input.receipts[0].sourceId);
  assert.equal(result.receipts[0].asOf, AS_OF); assert.equal(result.receipts[0].measurement, 'provider_report');
  assert.equal(result.receipts[0].telemetry, 'complete'); assert.equal(result.receipts[0].quantities[0].unitId, 'input_uncached_tokens');
  assert.deepEqual(input, before);
  result.priceBindings[0].rules.input_cached_tokens.usd.denominator = '999';
  assert.deepEqual(input, before);
  const zero = evaluateOfflineCost(scenario(binding, [receipt(binding, 'explicit-zero', { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })]));
  assert.equal(zero.kind, 'estimate'); assert.deepEqual(zero.usd, dollars(0, 1));
});

test('malformed provenance and unsupported money or quantization policies are rejected', () => {
  const binding = tokens(), base = scenario(binding, [receipt(binding, 'r1', textUsage())]);
  for (const mutate of [value => { value.priceBindings[0].sourceUrl = 'http://example.invalid/rate'; },
    value => { value.priceBindings[0].sourceUrl = 'https://user:password@example.invalid/rate'; },
    value => { value.priceBindings[0].asOf = '2026-02-30T00:00:00Z'; },
    value => { value.priceBindings[0].currency = 'EUR'; },
    value => { value.priceBindings[0].rules.output_tokens.quantization = { mode: 'exact', increment: 1 }; },
    value => { value.receipts[0].telemetry = 'assumed'; }, value => { value.receipts[0].measurement = 'invoice'; }]) {
    const input = structuredClone(base); mutate(input);
    assert.throws(() => evaluateOfflineCost(input), OfflineCostInputError);
  }
});
