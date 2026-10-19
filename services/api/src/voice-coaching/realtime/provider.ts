import type { CoachingRequestScope, ProviderOutcome } from '../contracts.js';

export type RealtimeDisabledReason = 'transport_policy_pending' | 'provider_unconfigured';

export type RealtimeCapability =
  | Readonly<{ available: true; provider: 'openai-realtime' }>
  | Readonly<{ available: false; provider: 'openai-realtime'; reason: RealtimeDisabledReason }>;

export type RealtimeCall<Answer> = Readonly<{
  providerCallId: string;
  answer: Answer;
}>;

// A successful hangup request is not terminal evidence for WS18 settlement.
export type RealtimeHangupReceipt = Readonly<{
  acknowledged: true;
  termination: 'unconfirmed';
}>;

export interface RealtimeProvider<Offer, Answer> {
  readonly capability: RealtimeCapability;
  createCall(
    scope: CoachingRequestScope,
    input: Readonly<{ operationId: string; offer: Offer }>,
  ): Promise<ProviderOutcome<RealtimeCall<Answer>>>;
  hangup(
    scope: CoachingRequestScope,
    input: Readonly<{ operationId: string; providerCallId: string }>,
  ): Promise<ProviderOutcome<RealtimeHangupReceipt>>;
}

export function createDisabledRealtimeProvider<Offer = never, Answer = never>(
  reason: RealtimeDisabledReason = 'transport_policy_pending',
): RealtimeProvider<Offer, Answer> {
  const unavailable = async (scope: CoachingRequestScope): Promise<ProviderOutcome<never>> => {
    scope.assertCurrent();
    return { kind: 'not_dispatched', reason };
  };
  return Object.freeze({
    capability: Object.freeze({ available: false, provider: 'openai-realtime', reason } as const),
    createCall: unavailable,
    hangup: unavailable,
  });
}

export type RealtimeFailureEvidence =
  | Readonly<{ dispatch: 'not_sent' }>
  | Readonly<{ dispatch: 'may_have_been_sent'; rejection: 'documented_no_effect' | 'unproved' }>;

// Status codes, local deadlines and aborted fetches alone cannot prove no effect.
export function classifyRealtimeFailure(evidence: RealtimeFailureEvidence): ProviderOutcome<never> {
  if (evidence.dispatch === 'not_sent') return { kind: 'not_dispatched', reason: 'not_sent' };
  if (evidence.rejection === 'documented_no_effect') return { kind: 'rejected', reason: 'provider_rejected' };
  return { kind: 'unknown', reason: 'provider_effect_unconfirmed' };
}
