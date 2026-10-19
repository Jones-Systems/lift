import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeStandardUsageMetadata,
  type StandardUsageContext, type StandardUsageEvidence, type StandardUsageMetadataInput, type StandardUsageTelemetry,
} from '../../src/usage-limits/index.js';

const context = (override: Partial<StandardUsageContext> = {}): StandardUsageContext => ({
  operation: 'complete', sourceId: 'fixture-provider-response-v1', asOf: '2026-10-11T03:06:27Z', identityKind: 'response',
  modelBinding: { requestedModelId: 'fixture-chat-alias', reportedModelId: 'fixture-chat-revision' }, ...override,
});
const metadata = (override: Partial<StandardUsageMetadataInput> = {}): StandardUsageMetadataInput => ({
  schemaVersion: 1, providerId: 'groq', operation: 'complete', requestedModelId: 'fixture-chat-alias',
  reportedModelId: 'fixture-chat-revision', requestId: 'request-1', responseId: 'response-1',
  telemetry: { status: 'complete', promptTokens: 1000, cachedPromptTokens: 800, completionTokens: 100, totalTokens: 1100, invalidFields: [] },
  ...override,
});
const telemetry = (override: Partial<StandardUsageTelemetry>): StandardUsageMetadataInput =>
  metadata({ telemetry: { ...metadata().telemetry, ...override } });
const evaluate = (value: unknown, binding: unknown = context()): StandardUsageEvidence =>
  normalizeStandardUsageMetadata(value as StandardUsageMetadataInput | undefined, binding as StandardUsageContext);
const codes = (result: StandardUsageEvidence): readonly string[] => result.issues.map(issue => issue.code);
function assertUnqualified(result: StandardUsageEvidence, kind: 'unknown' | 'invalid', code: string): void {
  assert.equal(result.kind, kind);
  assert.ok(codes(result).includes(code));
  assert.equal(Object.hasOwn(result, 'units'), false);
  assert.equal(result.pricingState, 'unconfigured');
  assert.equal(result.actualBilledCost, false);
}

test('complete consistent completion counts become disjoint provider-reported units under explicit bindings', () => {
  const result = normalizeStandardUsageMetadata(metadata(), context());
  assert.equal(result.kind, 'qualified');
  if (result.kind !== 'qualified') return;
  assert.equal(result.qualification, 'normalized_provider_reported_token_units');
  assert.deepEqual(result.units, [
    { unitId: 'input_uncached_tokens', quantity: 200 }, { unitId: 'input_cached_tokens', quantity: 800 },
    { unitId: 'output_tokens', quantity: 100 },
  ]);
  assert.deepEqual(result.providerIdentity, { providerId: 'groq', kind: 'response', id: 'response-1' });
  assert.equal(result.reported.telemetry?.totalTokens, 1100);
  assert.equal(result.reported.requestedModelId, 'fixture-chat-alias');
  assert.equal(result.reported.reportedModelId, 'fixture-chat-revision');
  assert.deepEqual(result.context, context());
  assert.deepEqual(result.issues, []);
  assert.equal(result.pricingState, 'unconfigured'); assert.equal(result.actualBilledCost, false);
  assert.equal(Object.hasOwn(result, 'cost'), false);
});

test('explicit complete zero counters qualify without treating absence as zero', () => {
  const result = evaluate(telemetry({ promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, totalTokens: 0 }));
  assert.equal(result.kind, 'qualified');
  if (result.kind !== 'qualified') return;
  assert.deepEqual(result.units.map(unit => unit.quantity), [0, 0, 0]);
  assert.equal(result.reported.telemetry?.cachedPromptTokens, 0);
});

test('absent metadata and unavailable telemetry remain unknown with no inferred quantities', () => {
  const absent = normalizeStandardUsageMetadata(undefined, context());
  assertUnqualified(absent, 'unknown', 'missing_metadata');
  assert.equal(Object.hasOwn(absent, 'reported'), false);
  const unavailable = evaluate(metadata({ telemetry: { status: 'unavailable', invalidFields: [] } }));
  assertUnqualified(unavailable, 'unknown', 'telemetry_unavailable');
  assert.deepEqual(unavailable.reported?.telemetry, { status: 'unavailable', invalidFields: [] });
});

test('partial counters preserve missing cache and other omissions rather than completing a token receipt', () => {
  const partial = metadata({ telemetry: { status: 'partial', promptTokens: 1000, completionTokens: 100, totalTokens: 1100, invalidFields: [] } });
  const result = evaluate(partial);
  assertUnqualified(result, 'unknown', 'telemetry_partial');
  assert.equal(result.reported?.telemetry?.promptTokens, 1000);
  assert.equal(Object.hasOwn(result.reported?.telemetry ?? {}, 'cachedPromptTokens'), false);
  for (const counts of [{ promptTokens: 1000 }, { cachedPromptTokens: 0 }, { totalTokens: 1100 }]) {
    const limited = evaluate(metadata({ telemetry: { status: 'partial', ...counts, invalidFields: [] } }));
    assertUnqualified(limited, 'unknown', 'missing_token_counts');
  }
});

test('producer invalid-field evidence is retained and unsafe supplied counters are excluded', () => {
  const result = evaluate(metadata({ telemetry: { status: 'partial', promptTokens: 1000, invalidFields: ['usage', 'totalTokens'] } }));
  assertUnqualified(result, 'invalid', 'provider_invalid_fields');
  assert.deepEqual(result.reported?.telemetry, { status: 'partial', promptTokens: 1000, invalidFields: ['usage', 'totalTokens'] });
  for (const unsafe of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', { transcript: 'excluded-value' }]) {
    const malformed = evaluate({ ...metadata(), telemetry: { ...metadata().telemetry, completionTokens: unsafe } });
    assertUnqualified(malformed, 'invalid', 'invalid_token_count');
    assert.equal(Object.hasOwn(malformed.reported?.telemetry ?? {}, 'completionTokens'), false);
    assert.equal(JSON.stringify(malformed).includes('excluded-value'), false);
  }
});

test('gross total mismatch and safe individual counts whose sum overflows cannot qualify', () => {
  const inconsistent = evaluate(telemetry({ totalTokens: 1099 }));
  assertUnqualified(inconsistent, 'invalid', 'token_total_mismatch');
  assert.equal(inconsistent.reported?.telemetry?.totalTokens, 1099);
  const overflow = evaluate(telemetry({ promptTokens: Number.MAX_SAFE_INTEGER, cachedPromptTokens: 0, completionTokens: 1,
    totalTokens: Number.MAX_SAFE_INTEGER }));
  assertUnqualified(overflow, 'invalid', 'token_total_overflow');
  const boundary = evaluate(telemetry({ promptTokens: Number.MAX_SAFE_INTEGER, cachedPromptTokens: 0, completionTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER }));
  assert.equal(boundary.kind, 'qualified');
});

test('cached input must be contained in inclusive prompt tokens', () => {
  const excess = evaluate(telemetry({ cachedPromptTokens: 1001 }));
  assertUnqualified(excess, 'invalid', 'cached_exceeds_prompt');
  assert.equal(excess.reported?.telemetry?.cachedPromptTokens, 1001);
  const fullCache = evaluate(telemetry({ cachedPromptTokens: 1000 }));
  assert.equal(fullCache.kind, 'qualified');
  if (fullCache.kind === 'qualified') assert.equal(fullCache.units[0]?.quantity, 0);
});

test('contradictory statuses and malformed metadata never certify a provider report', () => {
  for (const value of [
    telemetry({ status: 'partial' }), telemetry({ status: 'unavailable' }),
    metadata({ telemetry: { status: 'complete', promptTokens: 1000, invalidFields: [] } }),
  ]) assertUnqualified(evaluate(value), 'invalid', 'telemetry_status_mismatch');
  for (const value of [null, [], { ...metadata(), schemaVersion: 2 }, { ...metadata(), providerId: 'another-provider' },
    { ...metadata(), telemetry: null }, { ...metadata(), telemetry: { ...metadata().telemetry, status: 'assumed' } },
    { ...metadata(), telemetry: { ...metadata().telemetry, invalidFields: ['not-a-usage-field'] } },
    { ...metadata(), telemetry: { ...metadata().telemetry, invalidFields: ['usage', 'usage'] } },
    { ...metadata(), transcript: 'excluded-payload' }]) {
    const result = evaluate(value);
    assertUnqualified(result, 'invalid', 'invalid_metadata');
    assert.equal(JSON.stringify(result).includes('excluded-payload'), false);
  }
});

test('the selected provider-issued identity must exist, with no request/response or scope fallback', () => {
  const { responseId: _responseId, ...requestOnly } = metadata();
  const missing = evaluate(requestOnly);
  assertUnqualified(missing, 'unknown', 'missing_provider_identity');
  assert.equal(missing.reported?.requestId, 'request-1');
  const request = evaluate(requestOnly, context({ identityKind: 'request' }));
  assert.equal(request.kind, 'qualified');
  if (request.kind === 'qualified') assert.deepEqual(request.providerIdentity, { providerId: 'groq', kind: 'request', id: 'request-1' });
  const { requestId: _requestId, ...noIdentity } = requestOnly;
  assertUnqualified(evaluate(noIdentity, context({ identityKind: 'request' })), 'unknown', 'missing_provider_identity');
  assertUnqualified(evaluate({ ...noIdentity, correlationId: 'scope-only' }), 'invalid', 'invalid_metadata');
  for (const responseId of ['bad\nid', 'id\n', 'id\r\n', `${'i'.repeat(200)}\n`, 'i'.repeat(201)])
    assertUnqualified(evaluate(metadata({ responseId })), 'invalid', 'invalid_metadata');
});

test('stage and requested/reported model bindings are explicit and never inferred aliases', () => {
  assertUnqualified(evaluate(metadata(), context({ operation: 'transcribe' })), 'invalid', 'stage_mismatch');
  assertUnqualified(evaluate(metadata(), context({ modelBinding: { requestedModelId: 'fixture-chat-revision', reportedModelId: 'fixture-chat-revision' } })),
    'unknown', 'model_binding_mismatch');
  assertUnqualified(evaluate(metadata(), context({ modelBinding: { requestedModelId: 'fixture-chat-alias', reportedModelId: 'other-revision' } })),
    'unknown', 'model_binding_mismatch');
  const { reportedModelId: _reportedModelId, ...noReportedModel } = metadata();
  assertUnqualified(evaluate(noReportedModel), 'unknown', 'missing_reported_model');
  const { modelBinding: _modelBinding, ...unbound } = context();
  assertUnqualified(evaluate(metadata(), unbound), 'unknown', 'missing_model_binding');
});

test('provenance is required and original long provider identities and model pairs are preserved', () => {
  for (const field of ['sourceId', 'asOf', 'identityKind'] as const) {
    const input = Object.fromEntries(Object.entries(context()).filter(([key]) => key !== field));
    assert.equal(evaluate(metadata(), input).kind, 'unknown');
  }
  assertUnqualified(normalizeStandardUsageMetadata(metadata(), undefined as unknown as StandardUsageContext), 'unknown', 'missing_context');
  for (const invalidContext of [null, { ...context(), asOf: '2026-02-30T00:00:00Z' },
    { ...context(), sourceId: 'not a source identifier' }, { ...context(), identityKind: 'correlation' },
    { ...context(), modelBinding: { requestedModelId: 'fixture-chat-alias' } }]) {
    const result = evaluate(metadata(), invalidContext);
    assert.notEqual(result.kind, 'qualified');
  }
  for (const sourceId of ['source\n', 'source\r\n', `${'s'.repeat(200)}\n`, 's'.repeat(201)])
    assertUnqualified(evaluate(metadata(), context({ sourceId })), 'invalid', 'invalid_context');
  for (const requestedModelId of ['model\n', 'model\r\n', `${'m'.repeat(200)}\n`, 'm'.repeat(201)]) {
    assertUnqualified(evaluate(metadata({ requestedModelId })), 'invalid', 'invalid_metadata');
    assertUnqualified(evaluate(metadata(), context({ modelBinding: { requestedModelId, reportedModelId: 'fixture-chat-revision' } })),
      'invalid', 'invalid_context');
  }
  const requestedModelId = `m${'x'.repeat(199)}`, reportedModelId = `r${'x'.repeat(199)}`;
  const requestId = `q${'x'.repeat(199)}`, responseId = `s${'x'.repeat(199)}`;
  const result = evaluate(metadata({ requestedModelId, reportedModelId, requestId, responseId }),
    context({ modelBinding: { requestedModelId, reportedModelId } }));
  assert.equal(result.kind, 'qualified');
  assert.equal(result.reported?.requestId, requestId); assert.equal(result.reported?.responseId, responseId);
  assert.equal(result.reported?.requestedModelId, requestedModelId); assert.equal(result.reported?.reportedModelId, reportedModelId);
  if (result.kind === 'qualified') assert.equal(result.providerIdentity.id, responseId);
  assertUnqualified(evaluate(metadata({ responseId: `${responseId}x` })), 'invalid', 'invalid_metadata');
});

test('audio/TTS remain unknown and every result is detached, deeply immutable metadata only', () => {
  for (const operation of ['transcribe', 'synthesize'] as const) {
    const unavailable = evaluate(metadata({ operation, telemetry: { status: 'unavailable', invalidFields: [] } }), context({ operation }));
    assertUnqualified(unavailable, 'unknown', 'unsupported_operation');
    const tokensOnAudio = evaluate(metadata({ operation }), context({ operation }));
    assertUnqualified(tokensOnAudio, 'unknown', 'unsupported_operation');
  }
  const input = metadata(), binding = context(), original = structuredClone({ input, binding });
  const complete = evaluate(input, binding);
  const partial = evaluate(metadata({ telemetry: { status: 'partial', promptTokens: 3, invalidFields: [] } }));
  const invalid = evaluate(telemetry({ cachedPromptTokens: 2000 }));
  const assertFrozen = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertFrozen(child);
  };
  for (const result of [complete, partial, invalid]) assertFrozen(result);
  assert.deepEqual({ input, binding }, original);
  assert.equal(Object.isFrozen(input), false); assert.equal(Object.isFrozen(binding), false);
  assert.notEqual(complete.reported, input); assert.notEqual(complete.context, binding);
  (input.telemetry as { promptTokens: number }).promptTokens = 999;
  (binding.modelBinding as { requestedModelId: string }).requestedModelId = 'changed-after-normalization';
  assert.equal(complete.reported?.telemetry?.promptTokens, 1000);
  assert.equal(complete.context?.modelBinding.requestedModelId, 'fixture-chat-alias');
});
