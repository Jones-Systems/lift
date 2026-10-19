import { DomainError } from '../errors.js';
import { usageMetrics } from './types.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { UsageCharge, UsageEconomics, UsageIntent, UsageMetric, UsagePeriod, UsagePolicy } from './types.js';

export const LIVE_VOICE_LIMIT_MS = 9_000_000;
export function fail(code: string, status: 400 | 403 | 409 | 429 | 503 = 400): never {
  throw new DomainError(status, code);
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:/@+-]{1,160}$/.test(value)) fail('usage_invalid_identifier');
}
export function integer(value: unknown, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('usage_invalid_quantity');
}
export function actorCopy(actor: AccountContext): AccountContext {
  identifier(actor.accountId); identifier(actor.authUserId); identifier(actor.sessionId); integer(actor.epoch);
  return Object.freeze({ accountId: actor.accountId, authUserId: actor.authUserId, sessionId: actor.sessionId, epoch: actor.epoch });
}
export function charges(value: readonly UsageCharge[], allowZero = false): UsageCharge[] {
  if (!Array.isArray(value) || !value.length || value.length > usageMetrics.length) fail('usage_invalid_charges');
  const seen = new Set<UsageMetric>();
  return value.map(entry => {
    if (!entry || !usageMetrics.includes(entry.metric) || seen.has(entry.metric)) fail('usage_invalid_charges');
    integer(entry.amount, allowZero ? 0 : 1); seen.add(entry.metric);
    return { metric: entry.metric, amount: entry.amount };
  }).sort((a, b) => a.metric.localeCompare(b.metric));
}
export function intentCopy(input: UsageIntent): UsageIntent {
  for (const value of [input.operation, input.idempotencyKey, input.subjectId]) identifier(value);
  if (!/^[a-f0-9]{64}$/.test(input.intentHash)) fail('usage_invalid_intent_hash');
  if (!Array.isArray(input.dispatchStages) || !input.dispatchStages.length || input.dispatchStages.length > 16)
    fail('usage_invalid_stages');
  input.dispatchStages.forEach(identifier);
  if (new Set(input.dispatchStages).size !== input.dispatchStages.length) fail('usage_invalid_stages');
  return Object.freeze({ operation: input.operation, idempotencyKey: input.idempotencyKey,
    intentHash: input.intentHash, subjectId: input.subjectId,
    charges: Object.freeze(charges(input.charges).map(entry => Object.freeze(entry))),
    dispatchStages: Object.freeze([...input.dispatchStages]) });
}
export function policyCopy(input: UsagePolicy): UsagePolicy {
  identifier(input.id); identifier(input.periodPolicyId);
  if (typeof input.periodResolver !== 'function' || input.periodAllocation !== 'reservation_period'
    || input.liveRounding !== 'exact_milliseconds' || !['included', 'excluded'].includes(input.liveMessageCounting))
    fail('usage_policy_invalid', 503);
  const limits = { ...input.limits };
  usageMetrics.forEach(metric => integer(limits[metric]));
  if (limits.live_voice_ms !== LIVE_VOICE_LIMIT_MS) fail('usage_live_cap_invalid', 503);
  if (!input.operations || !Object.keys(input.operations).length) fail('usage_operations_required', 503);
  const operations = Object.fromEntries(Object.entries(input.operations).map(([name, rule]) => {
    identifier(name); identifier(rule.capability);
    if (!Array.isArray(rule.metrics) || !rule.metrics.length || new Set(rule.metrics).size !== rule.metrics.length
      || rule.metrics.some(metric => !usageMetrics.includes(metric))) fail('usage_policy_metrics_invalid', 503);
    if (rule.metrics.includes('live_voice_ms')
      && rule.metrics.includes('coach_messages') !== (input.liveMessageCounting === 'included'))
      fail('usage_live_message_policy_mismatch', 503);
    return [name, Object.freeze({ capability: rule.capability, metrics: Object.freeze([...rule.metrics]) })];
  }));
  return Object.freeze({ ...input, limits: Object.freeze(limits), operations: Object.freeze(operations) });
}
export function periodCopy(policy: UsagePolicy, atMs: number): UsagePeriod {
  const period = policy.periodResolver(atMs);
  identifier(period.id); integer(period.startMs); integer(period.endMs, 1);
  if (period.startMs > atMs || atMs >= period.endMs) fail('usage_period_invalid', 503);
  return Object.freeze({ id: period.id, startMs: period.startMs, endMs: period.endMs });
}
export function economicsCopy(input: readonly UsageEconomics[] = []): UsageEconomics[] {
  if (!Array.isArray(input) || input.length > 16) fail('usage_economics_invalid');
  return input.map(item => {
    identifier(item.providerId); identifier(item.modelId); identifier(item.sourceId);
    if (!['missing', 'partial', 'complete'].includes(item.telemetry) || !Array.isArray(item.quantities)
      || item.quantities.length > 32 || (item.telemetry === 'missing' && item.quantities.length)
      || (item.telemetry === 'complete' && !item.quantities.length)) fail('usage_economics_invalid');
    const seen = new Set<string>();
    const quantities: UsageEconomics['quantities'][number][] = item.quantities.map((quantity: UsageEconomics['quantities'][number]) => {
      identifier(quantity.unitId); integer(quantity.quantity);
      if (seen.has(quantity.unitId)) fail('usage_economics_invalid');
      seen.add(quantity.unitId);
      return { unitId: quantity.unitId, quantity: quantity.quantity };
    });
    quantities.sort((a, b) => a.unitId.localeCompare(b.unitId));
    return { providerId: item.providerId, modelId: item.modelId, sourceId: item.sourceId,
      telemetry: item.telemetry, quantities };
  });
}
