import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../../src/errors.js';
import type { StandardTurnObservation, StandardTurnStageEvidence } from '../../src/voice-coaching/index.js';
import {
  createStandardUsageObservationCollector, type StandardUsageContext, type StandardUsageMetadataInput,
  type StandardUsageObservationBinding, type StandardUsageObservationContexts,
} from '../../src/usage-limits/index.js';

const expected = (): StandardUsageObservationBinding => ({
  actor: { accountId: 'account-a', authUserId: 'user-a', sessionId: 'session-a', epoch: 4 },
  reservationId: 'reservation-a', operation: 'standard', intentHash: 'a'.repeat(64), subjectId: 'subject-a',
});
const context = (): StandardUsageContext => ({ operation: 'complete', sourceId: 'trusted-fixture-response',
  asOf: '2026-10-11T00:00:00Z', identityKind: 'response', modelBinding: { requestedModelId: 'chat-alias', reportedModelId: 'chat-revision' } });
const contexts = (): StandardUsageObservationContexts => ({ transcribe: undefined, complete: context(), synthesize: undefined });
const metadata = (): StandardUsageMetadataInput => ({ schemaVersion: 1, providerId: 'groq', operation: 'complete',
  requestedModelId: 'chat-alias', reportedModelId: 'chat-revision', responseId: 'response-a',
  telemetry: { status: 'complete', promptTokens: 20, cachedPromptTokens: 7, completionTokens: 5, totalTokens: 25, invalidFields: [] } });
const observation = (completion: StandardUsageMetadataInput = metadata()): StandardTurnObservation => ({ ...expected(), evidence: {
  completed: false, stages: [
    { stage: 'transcribe', permit: 'granted', outcome: 'succeeded', metadata: { schemaVersion: 1, providerId: 'groq', operation: 'transcribe',
      requestedModelId: 'explicit-stt-model', telemetry: { status: 'unavailable', invalidFields: [] } } },
    { stage: 'complete', permit: 'granted', outcome: 'succeeded', metadata: completion },
    { stage: 'synthesize', permit: 'granted', outcome: 'unknown' },
  ],
} });
const collector = () => createStandardUsageObservationCollector({ expected: expected(), contexts: contexts() });
const errorCode = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

test('all eight independently bound coordinates must match before a receipt can occupy the slot', () => {
  const capture = collector();
  for (const field of ['accountId', 'authUserId', 'sessionId', 'epoch'] as const) {
    const value = observation();
    assert.throws(() => capture.observe({ ...value, actor: { ...value.actor, [field]: field === 'epoch' ? 5 : 'different' } }),
      errorCode('usage_observation_binding_mismatch'));
    assert.equal(capture.snapshot(), undefined);
  }
  for (const field of ['reservationId', 'operation', 'intentHash', 'subjectId'] as const) {
    assert.throws(() => capture.observe({ ...observation(), [field]: field === 'intentHash' ? 'b'.repeat(64) : 'different' }),
      errorCode('usage_observation_binding_mismatch'));
    assert.equal(capture.snapshot(), undefined);
  }
  capture.observe(observation());
  assert.deepEqual(capture.snapshot()?.binding, expected());
  assert.throws(() => createStandardUsageObservationCollector({ expected: { ...expected(), reservationId: 'id\n' }, contexts: contexts() }),
    errorCode('usage_observation_binding_invalid'));
  assert.throws(() => createStandardUsageObservationCollector({ expected: expected(), contexts: {} as StandardUsageObservationContexts }),
    errorCode('usage_observation_context_invalid'));
  assert.throws(() => createStandardUsageObservationCollector({ expected: expected(), contexts: { ...contexts(), complete: { ...context(), operation: 'transcribe' } } }),
    errorCode('usage_observation_context_invalid'));
});

test('an incomplete turn retains qualified earlier completion and original identity without foreground-currentness authority', () => {
  const capture = collector(); capture.observe(observation());
  const receipt = capture.snapshot(); assert.ok(receipt);
  assert.equal(receipt.completed, false);
  assert.deepEqual(receipt.stages.map(stage => [stage.stage, stage.permit, stage.outcome]),
    [['transcribe', 'granted', 'succeeded'], ['complete', 'granted', 'succeeded'], ['synthesize', 'granted', 'unknown']]);
  const complete = receipt.stages[1]?.usage; assert.equal(complete?.kind, 'qualified');
  if (complete?.kind === 'qualified') assert.deepEqual(complete.units.map(unit => unit.quantity), [13, 7, 5]);
  assert.equal(receipt.stages[0]?.usage.kind, 'unknown');
  assert.ok(receipt.stages[0]?.usage.issues.some(issue => issue.code === 'unsupported_operation'));
  assert.equal(receipt.stages[2]?.usage.kind, 'unknown');
  assert.ok(receipt.stages[2]?.usage.issues.some(issue => issue.code === 'missing_metadata'));
  assert.equal(receipt.pricingState, 'unconfigured'); assert.equal(receipt.actualBilledCost, false);
  for (const field of ['handle', 'settlement', 'cost', 'currentActor', 'retry']) assert.equal(Object.hasOwn(receipt, field), false);
});

test('explicitly unconfigured contexts and partial or invalid telemetry preserve missingness without default quantities', () => {
  const unconfigured = createStandardUsageObservationCollector({ expected: expected(), contexts: { transcribe: undefined, complete: undefined, synthesize: undefined } });
  unconfigured.observe(observation());
  const unknown = unconfigured.snapshot()?.stages[1]?.usage; assert.ok(unknown);
  assert.equal(unknown.kind, 'unknown'); assert.ok(unknown.issues.some(issue => issue.code === 'missing_context'));
  assert.equal(unknown.reported?.telemetry?.promptTokens, 20); assert.equal(Object.hasOwn(unknown, 'units'), false);
  const partial = collector(); partial.observe(observation({ ...metadata(), telemetry: {
    status: 'partial', promptTokens: 20, completionTokens: 5, totalTokens: 25, invalidFields: [],
  } }));
  const incomplete = partial.snapshot()?.stages[1]?.usage; assert.equal(incomplete?.kind, 'unknown');
  assert.equal(Object.hasOwn(incomplete?.reported?.telemetry ?? {}, 'cachedPromptTokens'), false);
  const invalid = collector(); invalid.observe(observation({ ...metadata(), telemetry: { ...metadata().telemetry, cachedPromptTokens: 21 } }));
  const inconsistent = invalid.snapshot()?.stages[1]?.usage; assert.equal(inconsistent?.kind, 'invalid');
  assert.equal(inconsistent?.reported?.telemetry?.cachedPromptTokens, 21);
  assert.ok(inconsistent?.issues.some(issue => issue.code === 'cached_exceeds_prompt'));
  const marked = collector(); marked.observe(observation({ ...metadata(), telemetry: {
    status: 'partial', promptTokens: 20, invalidFields: ['usage'],
  } }));
  const markedReport = marked.snapshot()?.stages[1]?.usage; assert.equal(markedReport?.kind, 'invalid');
  assert.deepEqual(markedReport?.reported?.telemetry, { status: 'partial', promptTokens: 20, invalidFields: ['usage'] });
});

test('private snapshots detach every value, filter content and preserve 200-character provider identity without ledger conversion', () => {
  const longId = 'x'.repeat(200);
  const binding = expected(), configured = { ...context(), sourceId: longId, modelBinding: { requestedModelId: longId, reportedModelId: longId } };
  const capture = createStandardUsageObservationCollector({ expected: binding, contexts: { ...contexts(), complete: configured } });
  (binding.actor as { epoch: number }).epoch = 99;
  configured.modelBinding.requestedModelId = 'changed-after-construction';
  const raw = { ...metadata(), requestedModelId: longId, reportedModelId: longId, responseId: longId, content: 'PRIVATE_PROVIDER_CONTENT' };
  const value = observation(raw);
  capture.observe(value);
  const receipt = capture.snapshot(); assert.ok(receipt);
  assert.equal(receipt.binding.actor.epoch, 4);
  const report = receipt.stages[1]?.usage; assert.ok(report);
  assert.equal(report.kind, 'invalid'); assert.equal(report.reported?.responseId, longId);
  assert.equal(report.context?.modelBinding.requestedModelId, longId); assert.equal(report.context?.sourceId, longId);
  assert.equal(JSON.stringify(receipt).includes('PRIVATE_PROVIDER_CONTENT'), false);
  const frozen = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    assert.equal(Object.isFrozen(item), true); Object.values(item).forEach(frozen);
  };
  frozen(receipt);
  assert.equal(Object.isFrozen(value), false); assert.equal(Object.isFrozen(raw), false);
  (raw.telemetry as { promptTokens: number }).promptTokens = 100;
  raw.responseId = 'changed-after-capture';
  assert.equal(report.reported?.telemetry?.promptTokens, 20); assert.equal(report.reported?.responseId, longId);
  assert.notEqual(receipt.binding.actor, value.actor);
});

test('the first accepted receipt cannot be replaced by a repeated or conflicting observation', () => {
  const capture = collector(), value = observation(); capture.observe(value);
  const original = capture.snapshot();
  assert.throws(() => capture.observe(value), errorCode('usage_observation_already_recorded'));
  assert.throws(() => capture.observe({ ...value, evidence: { ...value.evidence, completed: true } }), errorCode('usage_observation_already_recorded'));
  assert.equal(capture.snapshot(), original);
  assert.equal(original?.completed, false);
});

test('malformed stage envelopes fail without accepting a partial prefix or consuming the private slot', () => {
  const capture = collector(), value = observation();
  const variants: unknown[] = [undefined, null, { completed: false, stages: [] },
    { completed: false, stages: Array(3) },
    { ...value.evidence, completed: 'false' },
    { ...value.evidence, stages: [...value.evidence.stages].reverse() },
    { ...value.evidence, stages: [...value.evidence.stages, value.evidence.stages[0]] },
    { ...value.evidence, stages: value.evidence.stages.map((stage, index) => index === 0 ? { ...stage, metadata: metadata() } : stage) },
    ...['permit', 'outcome', 'stage'].map(field => ({ ...value.evidence,
      stages: value.evidence.stages.map((stage, index) => index === 2 ? { ...stage, [field]: 'invented' } : stage) })),
  ];
  for (const evidence of variants) {
    assert.throws(() => capture.observe({ ...value, evidence } as StandardTurnObservation), errorCode('usage_observation_evidence_invalid'));
    assert.equal(capture.snapshot(), undefined);
  }
  const pending: readonly StandardTurnStageEvidence[] = value.evidence.stages.map(stage => ({
    stage: stage.stage, permit: 'not_requested', outcome: 'not_dispatched',
  }));
  capture.observe({ ...value, evidence: { completed: false, stages: pending } });
  assert.equal(capture.snapshot()?.stages.every(stage => stage.usage.kind === 'unknown'), true);
});
