import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { usageMetrics } from './types.js';
import type { UsageMetric, UsageOperationPolicy, UsagePeriod, UsagePolicy, UsageRights } from './types.js';
import { LIVE_VOICE_LIMIT_MS, policyCopy } from './validation.js';

/**
 * Explicit-configuration builder for the usage ledger policy.
 *
 * Nothing here chooses a commercial number, period boundary, zone, grant or provider: every input is carried by the
 * caller's configuration, and a missing or malformed input fails closed with a 503 `DomainError`. The only fixed value
 * is the 150-minute live cap, which the ledger itself pins and which must still be written out by the caller.
 */
export const usageOperationKinds = ['standard_voice_turn', 'coach_message', 'workout_generation', 'live_voice_session'] as const;
export type UsageOperationKind = typeof usageOperationKinds[number];
export type UsagePeriodRule =
  | Readonly<{ kind: 'calendar_month_utc' }>
  | Readonly<{ kind: 'calendar_month_zone'; timeZone: string }>;
export type UsagePolicyConfig = Readonly<{
  policyId: string;
  period: UsagePeriodRule;
  liveMessageCounting: 'included' | 'excluded';
  limits: Readonly<Record<UsageMetric, number>>;
  operations: Readonly<Partial<Record<UsageOperationKind, Readonly<{ capability: string }>>>>;
}>;
export type UsageGrantsConfig = Readonly<{
  grantPolicyId: string;
  configuredOperations: readonly UsageOperationKind[];
  resolveCapabilities: (actor: AccountContext) => readonly string[];
}>;
export type UsageLimitsConfiguration = Readonly<{
  policy: UsagePolicy;
  resolveRights: (actor: AccountContext) => UsageRights;
}>;

const MS_PER_SECOND = 1_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Largest representable instant minus a 32-day margin, so the next month's boundary search stays representable. */
const MAX_PERIOD_INSTANT_MS = 8.64e15 - 32 * DAY_MS;
const MAX_CAPABILITIES = 32;
const MAX_ZONE_LENGTH = 64;
const BOUNDARY_CACHE_LIMIT = 64;
const identifierPattern = /^[A-Za-z0-9_.:/@+-]{1,160}$/;
const zonePattern = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2}$/;

function refuse(code: string): never {
  throw new DomainError(503, code);
}
const isIdentifier = (value: unknown): value is string => typeof value === 'string' && identifierPattern.test(value);
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/** True only when the record has exactly these own keys, counting symbols and non-enumerable properties. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const isLimit = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

type ParsedPeriodRule =
  | Readonly<{ kind: 'calendar_month_utc' }>
  | Readonly<{ kind: 'calendar_month_zone'; timeZone: string; formatter: Intl.DateTimeFormat }>;

function parsePeriodRule(rule: unknown): ParsedPeriodRule {
  if (!isPlainRecord(rule)) return refuse('usage_policy_period_invalid');
  if (rule.kind === 'calendar_month_utc') {
    if (!hasExactKeys(rule, ['kind'])) return refuse('usage_policy_period_invalid');
    return Object.freeze({ kind: 'calendar_month_utc' });
  }
  if (rule.kind === 'calendar_month_zone') {
    const timeZone = rule.timeZone;
    if (!hasExactKeys(rule, ['kind', 'timeZone']) || typeof timeZone !== 'string'
      || timeZone.length > MAX_ZONE_LENGTH || !zonePattern.test(timeZone)) return refuse('usage_policy_period_invalid');
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone, year: 'numeric', month: 'numeric' });
    } catch { return refuse('usage_policy_period_invalid'); }
    return Object.freeze({ kind: 'calendar_month_zone', timeZone, formatter });
  }
  return refuse('usage_policy_period_invalid');
}

/** Policy id that fences a stored account to one period rule; the zone is the exact configured string. */
export function usagePeriodPolicyId(rule: UsagePeriodRule): string {
  const parsed = parsePeriodRule(rule);
  return parsed.kind === 'calendar_month_utc' ? 'calendar-month-v1:UTC' : `calendar-month-v1:${parsed.timeZone}`;
}

function periodId(label: string, monthIndex: number): string {
  const year = String(Math.floor(monthIndex / 12)).padStart(4, '0');
  const month = String((monthIndex % 12) + 1).padStart(2, '0');
  return `cal-month:${label}:${year}-${month}`;
}
function assertInstant(atMs: unknown): asserts atMs is number {
  if (typeof atMs !== 'number' || !Number.isSafeInteger(atMs) || atMs < 0 || atMs > MAX_PERIOD_INSTANT_MS) refuse('usage_period_invalid');
}

/**
 * Half-open calendar-month periods `[B(k), B(k+1))` for the configured rule. `B(k)` is the earliest instant at which the
 * rule's local month reaches `k`, so adjacent periods are contiguous even across skipped or repeated local midnights.
 * Only `getUTC*` and an explicit-zone `Intl` formatter are used; the host's local time zone never participates.
 */
export function calendarMonthPeriodResolver(rule: UsagePeriodRule): (atMs: number) => UsagePeriod {
  const parsed = parsePeriodRule(rule);
  if (parsed.kind === 'calendar_month_utc') {
    return (atMs: number): UsagePeriod => {
      assertInstant(atMs);
      const date = new Date(atMs), year = date.getUTCFullYear(), month = date.getUTCMonth();
      return Object.freeze({ id: periodId('UTC', year * 12 + month), startMs: Date.UTC(year, month, 1), endMs: Date.UTC(year, month + 1, 1) });
    };
  }
  const { formatter, timeZone } = parsed;
  const monthIndex = (atMs: number): number => {
    let year: number | undefined, month: number | undefined;
    for (const part of formatter.formatToParts(new Date(atMs))) {
      if (part.type === 'year') year = Number(part.value);
      else if (part.type === 'month') month = Number(part.value);
    }
    if (year === undefined || month === undefined || !Number.isSafeInteger(year) || !Number.isSafeInteger(month)
      || month < 1 || month > 12) return refuse('usage_period_invalid');
    return year * 12 + (month - 1);
  };
  const cache = new Map<number, number>();
  // Smallest whole second at which the zone's local month reaches `monthKey`, searched inside a window that
  // brackets every real UTC offset around local midnight on day 1.
  const boundary = (monthKey: number): number => {
    const cached = cache.get(monthKey);
    if (cached !== undefined) return cached;
    const anchor = Date.UTC(Math.floor(monthKey / 12), monthKey % 12, 1);
    const lo = anchor - 16 * HOUR_MS, hi = anchor + 14 * HOUR_MS;
    if (!(monthIndex(lo) < monthKey) || !(monthIndex(hi) >= monthKey)) return refuse('usage_policy_period_invalid');
    let below = lo / MS_PER_SECOND, atOrAbove = hi / MS_PER_SECOND;
    while (atOrAbove - below > 1) {
      const middle = Math.floor((below + atOrAbove) / 2);
      if (monthIndex(middle * MS_PER_SECOND) >= monthKey) atOrAbove = middle; else below = middle;
    }
    const found = atOrAbove * MS_PER_SECOND;
    if (cache.size >= BOUNDARY_CACHE_LIMIT) cache.clear();
    cache.set(monthKey, found);
    return found;
  };
  return (atMs: number): UsagePeriod => {
    assertInstant(atMs);
    let key = monthIndex(atMs), start = boundary(key), end = boundary(key + 1);
    for (let steps = 0; atMs < start; steps++) {
      if (steps >= 2) return refuse('usage_period_invalid');
      key -= 1; start = boundary(key); end = boundary(key + 1);
    }
    for (let steps = 0; atMs >= end; steps++) {
      if (steps >= 2) return refuse('usage_period_invalid');
      key += 1; start = boundary(key); end = boundary(key + 1);
    }
    if (start < 0 || start > atMs || atMs >= end) return refuse('usage_period_invalid');
    return Object.freeze({ id: periodId(timeZone, key), startMs: start, endMs: end });
  };
}

/** Metrics are derived, never configured: Standard turns can only ever be charged coach messages, never time. */
function operationMetrics(kind: UsageOperationKind, counting: 'included' | 'excluded'): readonly UsageMetric[] {
  switch (kind) {
    case 'standard_voice_turn':
    case 'coach_message': return Object.freeze(['coach_messages'] as const);
    case 'workout_generation': return Object.freeze(['workout_generations'] as const);
    case 'live_voice_session': return Object.freeze(counting === 'included' ? ['live_voice_ms', 'coach_messages'] as const : ['live_voice_ms'] as const);
  }
}

const policyConfigKeys = ['policyId', 'period', 'liveMessageCounting', 'limits', 'operations'] as const;

/** Validates explicit configuration and returns the ledger's own frozen `UsagePolicy`. */
export function createUsagePolicy(config: UsagePolicyConfig): UsagePolicy {
  if (!isPlainRecord(config) || !hasExactKeys(config, policyConfigKeys)) return refuse('usage_policy_config_invalid');
  const { policyId, period, liveMessageCounting, limits, operations } = config as Record<typeof policyConfigKeys[number], unknown>;
  if (!isIdentifier(policyId)) return refuse('usage_policy_config_invalid');
  const periodResolver = calendarMonthPeriodResolver(period as UsagePeriodRule);
  const periodPolicyId = usagePeriodPolicyId(period as UsagePeriodRule);
  if (liveMessageCounting !== 'included' && liveMessageCounting !== 'excluded') return refuse('usage_policy_config_invalid');
  if (!isPlainRecord(limits) || !hasExactKeys(limits, usageMetrics)) return refuse('usage_policy_config_invalid');
  const liveVoiceMs = limits.live_voice_ms, coachMessages = limits.coach_messages, workoutGenerations = limits.workout_generations;
  if (!isLimit(liveVoiceMs) || !isLimit(coachMessages) || !isLimit(workoutGenerations)) return refuse('usage_policy_config_invalid');
  if (liveVoiceMs !== LIVE_VOICE_LIMIT_MS) return refuse('usage_live_cap_invalid');
  if (!isPlainRecord(operations)) return refuse('usage_policy_config_invalid');
  const names = Object.keys(operations);
  if (Reflect.ownKeys(operations).length !== names.length) return refuse('usage_policy_config_invalid');
  if (!names.length) return refuse('usage_operations_required');
  const derived: Record<string, UsageOperationPolicy> = {};
  for (const kind of usageOperationKinds) {
    if (!Object.hasOwn(operations, kind)) continue;
    const rule = operations[kind];
    if (!isPlainRecord(rule) || !hasExactKeys(rule, ['capability']) || !isIdentifier(rule.capability)) return refuse('usage_policy_config_invalid');
    derived[kind] = Object.freeze({ capability: rule.capability, metrics: operationMetrics(kind, liveMessageCounting) });
  }
  if (names.some(name => !Object.hasOwn(derived, name))) return refuse('usage_policy_config_invalid');
  // The ledger applies policyCopy again; this builder is strictly narrower, so anything returned here is accepted there.
  return policyCopy({
    id: policyId, periodPolicyId, periodResolver, periodAllocation: 'reservation_period', liveRounding: 'exact_milliseconds',
    liveMessageCounting,
    limits: { live_voice_ms: liveVoiceMs, coach_messages: coachMessages, workout_generations: workoutGenerations },
    operations: derived,
  });
}

/** Builds the per-actor rights resolver the ledger enforces. Capabilities are resolved fresh on every call and fail closed. */
export function createUsageRightsResolver(policy: UsagePolicy, grants: UsageGrantsConfig): (actor: AccountContext) => UsageRights {
  if (!isPlainRecord(grants)) return refuse('usage_rights_config_invalid');
  const { grantPolicyId, configuredOperations, resolveCapabilities } = grants as Record<keyof UsageGrantsConfig, unknown>;
  if (!isIdentifier(grantPolicyId) || typeof resolveCapabilities !== 'function' || !Array.isArray(configuredOperations))
    return refuse('usage_rights_config_invalid');
  const operations: string[] = [];
  for (let index = 0; index < configuredOperations.length; index++) {
    const operation: unknown = configuredOperations[index];
    if (typeof operation !== 'string' || !Object.hasOwn(policy.operations, operation) || operations.includes(operation))
      return refuse('usage_rights_config_invalid');
    operations.push(operation);
  }
  const frozenOperations = Object.freeze(operations);
  const resolve = resolveCapabilities as UsageGrantsConfig['resolveCapabilities'];
  return (actor: AccountContext): UsageRights => {
    const result: unknown = resolve(actor);
    if (!Array.isArray(result) || result.length > MAX_CAPABILITIES) return refuse('usage_rights_unconfigured');
    const capabilities: string[] = [];
    for (let index = 0; index < result.length; index++) {
      const capability: unknown = result[index];
      if (!isIdentifier(capability)) return refuse('usage_rights_unconfigured');
      capabilities.push(capability);
    }
    return Object.freeze({
      policyId: grantPolicyId, capabilities: Object.freeze([...new Set(capabilities)]), configuredOperations: frozenOperations,
    });
  };
}

/**
 * `undefined` selects no configuration, so a ledger built from it stays `configured:false` / `usage_unconfigured`.
 * A partly supplied object throws instead of half-configuring. Callers spread the result into `createUsageLedger`.
 */
export function createUsageLimitsConfiguration(
  input?: Readonly<{ policy: UsagePolicyConfig; grants: UsageGrantsConfig }>,
): UsageLimitsConfiguration | undefined {
  if (input === undefined) return undefined;
  if (!isPlainRecord(input) || !hasExactKeys(input, ['policy', 'grants'])) return refuse('usage_policy_config_invalid');
  const policy = createUsagePolicy(input.policy);
  return Object.freeze({ policy, resolveRights: createUsageRightsResolver(policy, input.grants) });
}
