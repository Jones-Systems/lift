import { DomainError } from '../errors.js';
import type { StandardTurnObservation, StandardTurnStageEvidence } from '../voice-coaching/index.js';
import { normalizeStandardUsageMetadata } from './provider-evidence.js';
import type { StandardUsageContext, StandardUsageEvidence, StandardUsageOperation } from './provider-evidence.js';

export type StandardUsageObservationBinding = Readonly<Omit<StandardTurnObservation, 'evidence'>>;
export type StandardUsageObservationContexts = Readonly<Record<StandardUsageOperation, StandardUsageContext | undefined>>;
export type StandardUsageObservedStage = Readonly<{
  stage: StandardUsageOperation;
  permit: StandardTurnStageEvidence['permit'];
  outcome: StandardTurnStageEvidence['outcome'];
  usage: StandardUsageEvidence;
}>;
export type StandardUsageObservationReceipt = Readonly<{
  binding: StandardUsageObservationBinding;
  completed: boolean;
  stages: readonly StandardUsageObservedStage[];
  pricingState: 'unconfigured';
  actualBilledCost: false;
}>;
export type StandardUsageObservationCollector = Readonly<{
  observe(observation: StandardTurnObservation): void;
  snapshot(): StandardUsageObservationReceipt | undefined;
}>;

const stages = ['transcribe', 'complete', 'synthesize'] as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 160 && !/[^A-Za-z0-9_.:/@+-]/.test(value);

function copyBinding(value: unknown): StandardUsageObservationBinding {
  if (!record(value) || !record(value.actor) || !identifier(value.actor.accountId) || !identifier(value.actor.authUserId)
    || !identifier(value.actor.sessionId) || !Number.isSafeInteger(value.actor.epoch) || (value.actor.epoch as number) < 0
    || !identifier(value.reservationId) || !identifier(value.operation) || !identifier(value.subjectId)
    || typeof value.intentHash !== 'string' || value.intentHash.length !== 64 || !/^[a-f0-9]{64}$/.test(value.intentHash))
    throw new DomainError(400, 'usage_observation_binding_invalid');
  return Object.freeze({ actor: Object.freeze({ accountId: value.actor.accountId, authUserId: value.actor.authUserId,
    sessionId: value.actor.sessionId, epoch: value.actor.epoch as number }), reservationId: value.reservationId,
    operation: value.operation, intentHash: value.intentHash, subjectId: value.subjectId });
}

/** Expected identity comes from the trusted new reservation; this private receipt grants no ledger authority or durable delivery. */
export function createStandardUsageObservationCollector(options: Readonly<{
  expected: StandardUsageObservationBinding;
  contexts: StandardUsageObservationContexts;
}>): StandardUsageObservationCollector {
  const expected = copyBinding(options.expected);
  if (!record(options.contexts) || stages.some(stage => !Object.hasOwn(options.contexts, stage)))
    throw new DomainError(503, 'usage_observation_context_invalid');
  const contextFor = (stage: StandardUsageOperation): StandardUsageContext | undefined => {
    const supplied = options.contexts[stage];
    if (supplied === undefined) return undefined;
    const checked = normalizeStandardUsageMetadata(undefined, supplied);
    if (checked.context === undefined || checked.context.operation !== stage
      || checked.issues.some(issue => issue.field === 'context' || issue.field.startsWith('context.')))
      throw new DomainError(503, 'usage_observation_context_invalid');
    return checked.context;
  };
  const contexts: StandardUsageObservationContexts = Object.freeze({
    transcribe: contextFor('transcribe'), complete: contextFor('complete'), synthesize: contextFor('synthesize'),
  });
  let receipt: StandardUsageObservationReceipt | undefined;
  return Object.freeze({
    observe(observation: StandardTurnObservation): void {
      if (receipt !== undefined) throw new DomainError(409, 'usage_observation_already_recorded');
      const binding = copyBinding(observation);
      if (binding.actor.accountId !== expected.actor.accountId || binding.actor.authUserId !== expected.actor.authUserId
        || binding.actor.sessionId !== expected.actor.sessionId || binding.actor.epoch !== expected.actor.epoch
        || binding.reservationId !== expected.reservationId || binding.operation !== expected.operation
        || binding.intentHash !== expected.intentHash || binding.subjectId !== expected.subjectId)
        throw new DomainError(409, 'usage_observation_binding_mismatch');
      const evidence = observation.evidence;
      if (!record(evidence) || typeof evidence.completed !== 'boolean' || !Array.isArray(evidence.stages)
        || evidence.stages.length !== stages.length)
        throw new DomainError(400, 'usage_observation_evidence_invalid');
      const normalized = stages.map((stage, index): StandardUsageObservedStage => {
        const entry: StandardTurnStageEvidence | undefined = evidence.stages[index];
        if (!record(entry) || entry.stage !== stage
          || !['not_requested', 'granted', 'uncertain'].includes(entry.permit)
          || !['succeeded', 'not_dispatched', 'rejected', 'unknown'].includes(entry.outcome))
          throw new DomainError(400, 'usage_observation_evidence_invalid');
        if (entry.metadata !== undefined && entry.metadata?.operation !== stage)
          throw new DomainError(400, 'usage_observation_evidence_invalid');
        return Object.freeze({ stage: entry.stage, permit: entry.permit, outcome: entry.outcome,
          usage: normalizeStandardUsageMetadata(entry.metadata, contexts[entry.stage]) });
      });
      receipt = Object.freeze({ binding: expected, completed: evidence.completed, stages: Object.freeze(normalized),
        pricingState: 'unconfigured', actualBilledCost: false });
    },
    snapshot: () => receipt,
  });
}
