import type { FormTransport } from '../api/transport';
import { createStandardWireTurn } from '../voice-coaching/standard/wire-turn';
import type { StandardWireLimits } from '../voice-coaching/standard/wire-codec';
import type { StandardClientTurnPort } from '../voice-coaching/standard/contracts';

export type StandardCoachingTransportConfiguration = Readonly<{ limits: StandardWireLimits; deadlineMs: number }>;

/** Source composition only: configuration supplies bounds, never provider or native readiness. */
export function createStandardCoachingTransport(api: FormTransport,
  configuration?: StandardCoachingTransportConfiguration): StandardClientTurnPort | undefined {
  if (!configuration) return undefined;
  const limits = Object.freeze({ ...configuration.limits });
  const deadlineMs = configuration.deadlineMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647)
    throw new Error('standard_transport_deadline_required');
  const exchange = api.exchangeStandardWire.bind(api);
  return createStandardWireTurn({ limits, exchange: (request, signal) =>
    exchange(request, signal, { maxEnvelopeBytes: limits.maxEnvelopeBytes, deadlineMs }) });
}
