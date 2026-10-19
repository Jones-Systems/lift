import type { CoachingRequestScope, ProviderOutcome } from './contracts.js';
import type { AccountContext } from '../lifecycle/types.js';
import type {
  StandardAudioInput, StandardOutcome, StandardProvider, StandardProviderMetadata, StandardSpeech, StandardTextInput,
} from './standard/index.js';
import type {
  TrustedUsageControls, UsageIntent, UsageLimitsPort, UsageReservationHandle, UsageSettlement,
} from '../usage-limits/types.js';

export const standardTurnStages = Object.freeze(['transcribe', 'complete', 'synthesize'] as const);
export type StandardTurnStage = typeof standardTurnStages[number];
export type StandardTurnStageEvidence = Readonly<{
  stage: StandardTurnStage;
  permit: 'not_requested' | 'granted' | 'uncertain';
  outcome: ProviderOutcome<never>['kind'];
  metadata?: StandardProviderMetadata;
}>;
export type StandardTurnEvidence = Readonly<{
  completed: boolean;
  stages: readonly StandardTurnStageEvidence[];
}>;
export type StandardTurnObservation = Readonly<{
  actor: AccountContext;
  reservationId: string;
  operation: string;
  intentHash: string;
  subjectId: string;
  evidence: StandardTurnEvidence;
}>;
export type StandardTurnObserver = (observation: StandardTurnObservation) => void | Promise<void>;
export type StandardTurnResolution =
  | Readonly<{ kind: 'settle'; settlement: UsageSettlement }>
  | Readonly<{ kind: 'not_consumed'; evidenceId: string }>
  | Readonly<{ kind: 'unknown' }>;

/** Server-owned policy: amounts and metering evidence are configured, never inferred from provider text. */
export type StandardTurnPolicy = Readonly<{
  intent: UsageIntent;
  resolve(evidence: StandardTurnEvidence): StandardTurnResolution;
}>;
export type StandardTurnAccounting = 'not_reserved' | 'replay' | 'released' | 'settled'
  | 'not_consumed' | 'unknown' | 'unresolved';
/** Ephemeral successful-stage text for the current original scope; never cached for replay. */
export type StandardTurnReview = Readonly<{ transcript: string; reply?: string }>;
/** Preparation supplies authorized context; provider dispatch still requires the completion permit. */
export type StandardCompletionPreparation = (
  scope: CoachingRequestScope, input: Readonly<{ transcript: string }>,
) => Promise<StandardTextInput>;
export type StandardTurnResult = Readonly<{
  outcome: ProviderOutcome<StandardSpeech>;
  accounting: StandardTurnAccounting;
  review?: StandardTurnReview;
}>;
export type StandardTurnController = Readonly<{
  run(scope: CoachingRequestScope, input: StandardAudioInput): Promise<StandardTurnResult>;
}>;

function snapshotMetadata(stage: StandardTurnStage, metadata?: StandardProviderMetadata): StandardProviderMetadata | undefined {
  if (!metadata || metadata.operation !== stage) return undefined;
  const telemetry = metadata.telemetry;
  return Object.freeze({
    schemaVersion: metadata.schemaVersion,
    providerId: metadata.providerId,
    operation: metadata.operation,
    requestedModelId: metadata.requestedModelId,
    ...(metadata.reportedModelId !== undefined ? { reportedModelId: metadata.reportedModelId } : {}),
    ...(metadata.requestId !== undefined ? { requestId: metadata.requestId } : {}),
    ...(metadata.responseId !== undefined ? { responseId: metadata.responseId } : {}),
    telemetry: Object.freeze({
      status: telemetry.status,
      ...(telemetry.promptTokens !== undefined ? { promptTokens: telemetry.promptTokens } : {}),
      ...(telemetry.completionTokens !== undefined ? { completionTokens: telemetry.completionTokens } : {}),
      ...(telemetry.cachedPromptTokens !== undefined ? { cachedPromptTokens: telemetry.cachedPromptTokens } : {}),
      ...(telemetry.totalTokens !== undefined ? { totalTokens: telemetry.totalTokens } : {}),
      invalidFields: Object.freeze([...telemetry.invalidFields]),
    }),
  });
}

export function createStandardTurnController(options: Readonly<{
  provider: StandardProvider;
  usage: UsageLimitsPort;
  trusted: Pick<TrustedUsageControls, 'settle' | 'release' | 'markUnknown' | 'reconcile'>;
  policy?: StandardTurnPolicy;
  prepareCompletion?: StandardCompletionPreparation;
  observeStages?: StandardTurnObserver;
}>): StandardTurnController {
  const provider = Object.freeze({ ...options.provider });
  const usage = Object.freeze({ ...options.usage });
  const trusted = Object.freeze({ ...options.trusted });
  const supplied = options.policy;
  const intent: UsageIntent | undefined = supplied && Object.freeze({
    operation: supplied.intent.operation,
    idempotencyKey: supplied.intent.idempotencyKey,
    intentHash: supplied.intent.intentHash,
    subjectId: supplied.intent.subjectId,
    charges: Object.freeze(supplied.intent.charges.map(charge => Object.freeze({ ...charge }))),
    dispatchStages: Object.freeze([...supplied.intent.dispatchStages]),
  });
  const resolve = supplied?.resolve;
  const prepareCompletion = options.prepareCompletion;
  const observeStages = options.observeStages;
  const configured = intent !== undefined && typeof resolve === 'function' && typeof prepareCompletion === 'function'
    && intent.dispatchStages.length === standardTurnStages.length
    && standardTurnStages.every((stage, index) => intent.dispatchStages[index] === stage);

  function current(scope: CoachingRequestScope): void {
    scope.signal.throwIfAborted();
    scope.assertCurrent();
    scope.signal.throwIfAborted();
  }

  return Object.freeze({
    async run(scope: CoachingRequestScope, input: StandardAudioInput): Promise<StandardTurnResult> {
      try { current(scope); } catch {
        return { outcome: { kind: 'not_dispatched', reason: 'scope_not_current' }, accounting: 'not_reserved' };
      }
      if (!provider.enabled || !configured || !intent || !resolve) {
        return { outcome: { kind: 'not_dispatched', reason: 'standard_turn_disabled' }, accounting: 'not_reserved' };
      }
      let reservation;
      try { reservation = usage.reserve(scope.actor, intent); } catch {
        return { outcome: { kind: 'not_dispatched', reason: 'usage_reservation_unavailable' }, accounting: 'unresolved' };
      }
      if (reservation.kind === 'replay') {
        return { outcome: { kind: 'not_dispatched', reason: 'usage_replay_no_dispatch' }, accounting: 'replay' };
      }
      const handle = reservation.handle;
      const observationIdentity = Object.freeze({
        actor: Object.freeze({
          accountId: handle.actor.accountId,
          authUserId: handle.actor.authUserId,
          sessionId: handle.actor.sessionId,
          epoch: handle.actor.epoch,
        }),
        reservationId: handle.reservationId,
        operation: handle.operation,
        intentHash: handle.intentHash,
        subjectId: handle.subjectId,
      });
      const stages: StandardTurnStageEvidence[] = standardTurnStages.map(stage => ({
        stage, permit: 'not_requested', outcome: 'not_dispatched',
      }));
      let permitAttempted = false;

      async function dispatch<T>(stage: StandardTurnStage, call: () => Promise<StandardOutcome<T>>): Promise<ProviderOutcome<T>> {
        const index = standardTurnStages.indexOf(stage);
        try { current(scope); } catch { return { kind: 'not_dispatched', reason: 'scope_not_current' }; }
        permitAttempted = true;
        stages[index] = { stage, permit: 'uncertain', outcome: 'not_dispatched' };
        try {
          const permit = usage.markDispatching(handle, stage);
          if (permit.reservationId !== handle.reservationId || permit.stage !== stage) {
            return { kind: 'not_dispatched', reason: 'usage_permit_mismatch' };
          }
        } catch { return { kind: 'not_dispatched', reason: 'usage_permit_unavailable' }; }
        stages[index] = { stage, permit: 'granted', outcome: 'not_dispatched' };
        try { current(scope); } catch { return { kind: 'not_dispatched', reason: 'scope_not_current' }; }
        let outcome: StandardOutcome<T>;
        try { outcome = await call(); } catch { outcome = { kind: 'unknown', reason: 'provider_outcome_unknown' }; }
        const metadata = snapshotMetadata(stage, outcome.metadata);
        stages[index] = { stage, permit: 'granted', outcome: outcome.kind, ...(metadata ? { metadata } : {}) };
        try { current(scope); } catch { return { kind: 'unknown', reason: 'scope_not_current' }; }
        if (outcome.kind === 'succeeded') return { kind: 'succeeded', value: outcome.value };
        return { kind: outcome.kind, reason: `standard_${stage}_${outcome.kind}` };
      }

      async function prepare(transcript: string): Promise<ProviderOutcome<StandardTextInput>> {
        try { current(scope); } catch { return { kind: 'not_dispatched', reason: 'scope_not_current' }; }
        let result: ProviderOutcome<StandardTextInput>;
        try {
          const prepared = await prepareCompletion!(scope, Object.freeze({ transcript }));
          const text = prepared?.text;
          result = typeof text === 'string' && text.trim().length > 0
            ? { kind: 'succeeded', value: Object.freeze({ text }) }
            : { kind: 'not_dispatched', reason: 'completion_preparation_invalid' };
        } catch { result = { kind: 'not_dispatched', reason: 'completion_preparation_failed' }; }
        try { current(scope); } catch { return { kind: 'not_dispatched', reason: 'scope_not_current' }; }
        return result;
      }

      const transcript = await dispatch('transcribe', () => provider.transcribe(scope, input));
      let outcome: ProviderOutcome<StandardSpeech>;
      let review: StandardTurnReview | undefined;
      if (transcript.kind !== 'succeeded') {
        outcome = transcript;
      } else {
        review = Object.freeze({ transcript: transcript.value });
        const prepared = await prepare(transcript.value);
        if (prepared.kind !== 'succeeded') {
          outcome = prepared;
        } else {
          const reply = await dispatch('complete', () => provider.complete(scope, prepared.value));
          if (reply.kind === 'succeeded') {
            review = Object.freeze({ transcript: transcript.value, reply: reply.value });
            outcome = await dispatch('synthesize', () => provider.synthesize(scope, { text: reply.value }));
          } else {
            outcome = reply;
          }
        }
      }
      const evidence: StandardTurnEvidence = Object.freeze({
        completed: outcome.kind === 'succeeded',
        stages: Object.freeze(stages.map(stage => Object.freeze({ ...stage }))),
      });
      const observation: StandardTurnObservation = Object.freeze({ ...observationIdentity, evidence });
      // Best effort only: no awaiting, retry, settlement authority, or durable-delivery claim.
      try { void Promise.resolve(observeStages?.(observation)).catch(() => {}); } catch {}

      function markUnknown(original: UsageReservationHandle): StandardTurnAccounting {
        try { trusted.markUnknown(original); return 'unknown'; } catch { return 'unresolved'; }
      }
      function account(): StandardTurnAccounting {
        if (!permitAttempted) {
          try { trusted.release(handle); return 'released'; } catch { return 'unresolved'; }
        }
        if (stages.some(stage => stage.permit === 'uncertain' || stage.outcome === 'unknown')) return markUnknown(handle);
        let decision: StandardTurnResolution;
        try { decision = resolve!(evidence); } catch { return markUnknown(handle); }
        if (decision.kind === 'unknown') return markUnknown(handle);
        if (decision.kind === 'not_consumed' && stages.some(stage => stage.outcome === 'succeeded')) return markUnknown(handle);
        // A failed accounting write may have committed. Do not retry or replace its unknown effect.
        try {
          if (decision.kind === 'settle') {
            trusted.settle(handle, decision.settlement);
            return 'settled';
          }
          trusted.reconcile(handle, { outcome: 'not_consumed', evidenceId: decision.evidenceId });
          return 'not_consumed';
        } catch { return 'unresolved'; }
      }
      // Trusted accounting retains this original capability even when foreground admission has expired.
      const accounting = account();
      try { current(scope); } catch {
        outcome = { kind: 'unknown', reason: 'scope_not_current' };
        review = undefined;
      }
      if (outcome.kind === 'succeeded' && accounting !== 'settled') {
        outcome = { kind: 'unknown', reason: accounting === 'unresolved' ? 'usage_accounting_unresolved' : 'usage_accounting_unknown' };
      }
      return { outcome, accounting, ...(review ? { review } : {}) };
    },
  });
}
