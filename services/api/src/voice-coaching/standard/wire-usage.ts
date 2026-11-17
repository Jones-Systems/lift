/**
 * Reserved `reason` vocabulary for a Standard turn that never dispatched because of usage.
 * The envelope shape is unchanged: a usage outcome is (`not_dispatched`, reason) plus a required `accounting`.
 * This file must stay byte-identical to its counterpart in the other Standard wire module.
 */
export const standardWireUsageReasons = Object.freeze({
  usage_limit_reached: Object.freeze({ outcome: 'limit_reached', accounting: 'not_reserved' }),
  usage_not_entitled: Object.freeze({ outcome: 'not_entitled', accounting: 'not_reserved' }),
  usage_unconfigured: Object.freeze({ outcome: 'unconfigured', accounting: 'not_reserved' }),
  usage_key_conflict: Object.freeze({ outcome: 'key_conflict', accounting: 'not_reserved' }),
  usage_reservation_unavailable: Object.freeze({ outcome: 'unavailable', accounting: 'unresolved' }),
  usage_replay_no_dispatch: Object.freeze({ outcome: 'replayed', accounting: 'replay' }),
} as const);
export type StandardWireUsageReason = keyof typeof standardWireUsageReasons;
export type StandardWireUsageOutcome = typeof standardWireUsageReasons[StandardWireUsageReason]['outcome'];

/** Returns a typed outcome only for an exact reserved (kind, reason, accounting) triple; never throws. */
export function standardWireUsageOutcome(result: Readonly<{
  outcome: Readonly<{ kind: string; reason?: unknown }>; accounting: string;
}>): StandardWireUsageOutcome | undefined {
  try {
    const outcome = result.outcome;
    if (outcome.kind !== 'not_dispatched') return undefined;
    const reason = outcome.reason;
    if (typeof reason !== 'string' || !Object.hasOwn(standardWireUsageReasons, reason)) return undefined;
    const entry = standardWireUsageReasons[reason as StandardWireUsageReason];
    return result.accounting === entry.accounting ? entry.outcome : undefined;
  } catch { return undefined; }
}
