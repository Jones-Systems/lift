import { ApiError, type FormTransport } from '../api/transport';
import { createStandardWireTurn } from '../voice-coaching/standard/wire-turn';
import type { StandardWireLimits } from '../voice-coaching/standard/wire-codec';
import type { StandardClientTurnPort } from '../voice-coaching/standard/contracts';

export type StandardCoachingTransportConfiguration = Readonly<{
  limits: StandardWireLimits;
  deadlineMs: number;
  /** Off unless exactly `true`: one more attempt, with the same turn key and bytes, after a lost response. */
  retryUnknownResultOnce?: boolean;
}>;

/** True only when the server's effect on a delivered turn is unknown and the same key can safely be offered once more. */
export function standardResultUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.effectUnknown !== true || error.originalEffectUnknown === true) return false;
  if (error.code === 'transport_interrupted' || error.code === 'wire_result_unknown') return true;
  return error.code === 'wire_response_rejected' && error.status >= 500;
}

/** Source composition only: configuration supplies bounds, never provider or native readiness. */
export function createStandardCoachingTransport(api: FormTransport,
  configuration?: StandardCoachingTransportConfiguration): StandardClientTurnPort | undefined {
  if (!configuration) return undefined;
  const limits = Object.freeze({ ...configuration.limits });
  const deadlineMs = configuration.deadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647)
    throw new Error('standard_transport_deadline_required');
  const retry = configuration.retryUnknownResultOnce;
  if (retry !== undefined && typeof retry !== 'boolean') throw new Error('standard_transport_retry_invalid');
  const exchange = api.exchangeStandardWire.bind(api);
  const wire = createStandardWireTurn({ limits,
    exchange: (request, signal, turn) => exchange(request, signal,
      { maxEnvelopeBytes: limits.maxEnvelopeBytes, deadlineMs }, { idempotencyKey: turn.idempotencyKey }),
    ...(retry === true ? { retryUnknownResult: standardResultUnknown } : {}) });
  return Object.freeze({
    run(input: Parameters<StandardClientTurnPort['run']>[0]) {
      // Pin the transport identity for the whole run: a retry can never carry this turn's key into another account.
      const auth = api.captureAuthContext();
      const original = input.assertCurrent.bind(input);
      return wire.run({ ...input, assertCurrent() {
        original();
        if (!auth.isCurrent()) throw new Error('standard_wire_scope_stale');
      } });
    },
  });
}
