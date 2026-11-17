import { DomainError } from '../errors.js';
import { standardWireUsageReasons, type StandardWireUsageReason } from './standard/wire-usage.js';

export type StandardUsageRefusalReason = Exclude<StandardWireUsageReason, 'usage_replay_no_dispatch'>;

// Exact (status, code) pairs thrown by the ledger inside its reserve transaction, before any row is written.
const classified: ReadonlyMap<string, StandardUsageRefusalReason> = new Map<string, StandardUsageRefusalReason>([
  ['429:usage_limit_exceeded', 'usage_limit_reached'],
  ['403:usage_capability_denied', 'usage_not_entitled'],
  ['503:usage_unconfigured', 'usage_unconfigured'],
  ['503:usage_operation_unconfigured', 'usage_unconfigured'],
  ['503:usage_rights_unconfigured', 'usage_unconfigured'],
  ['503:usage_provider_unconfigured', 'usage_unconfigured'],
  ['409:usage_idempotency_mismatch', 'usage_key_conflict'],
  ['403:usage_actor_mismatch', 'usage_key_conflict'],
]);

/**
 * Classifies a failed reservation from its status and code only; never reads `message` or `details`.
 * Anything unlisted keeps the legacy unresolved result.
 */
export function standardUsageRefusal(error: unknown): Readonly<{
  reason: StandardUsageRefusalReason; accounting: 'not_reserved' | 'unresolved';
}> {
  try {
    if (error instanceof DomainError) {
      const reason = classified.get(`${error.status}:${error.code}`);
      if (reason) return Object.freeze({ reason, accounting: standardWireUsageReasons[reason].accounting });
    }
  } catch { /* fall through to the legacy result */ }
  return Object.freeze({ reason: 'usage_reservation_unavailable', accounting: 'unresolved' });
}
