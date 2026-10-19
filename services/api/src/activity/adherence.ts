import { addCalendarDays, assertCivilDate, localDate, monthKey } from './calendar.js';
import { DomainError } from '../errors.js';

export const adherencePolicyVersion = 'activity-adherence-v1' as const;
export type AdherenceInputDay = Readonly<{ localDate: string; expectation: 'workout' | 'exerciseSnack' | 'rest' | null; hasActivity: boolean }>;
export type AdherenceDay = { localDate: string; state: 'activityRecorded' | 'plannedRest' | 'protectedMiss' | 'missed' | 'pending' | 'unknownPlan';
  actual: 'met' | 'not_met' | 'pending' | 'unknown'; currentPlanDays: number; longestPlanDays: number };
export function replayAdherence(input: { days: readonly AdherenceInputDay[]; timeZone: string; asOf: string }) {
  const throughDate = localDate(input.asOf, input.timeZone);
  const days = [...input.days].sort((a, b) => a.localDate.localeCompare(b.localDate));
  const seen = new Set<string>(), allocations: Record<string, string> = Object.create(null) as Record<string, string>;
  let current = 0, longest = 0, satisfied = 0, protectedCount = 0, previous: string | null = null;
  const results: AdherenceDay[] = [];
  for (const day of days) {
    assertCivilDate(day.localDate);
    if (seen.has(day.localDate)) throw new DomainError(422, 'duplicate_adherence_day');
    seen.add(day.localDate);
    if (day.localDate > throughDate) continue;
    if (previous && addCalendarDays(previous, 1) !== day.localDate) { current = 0; satisfied = 0; protectedCount = 0; }
    previous = day.localDate;
    const closed = day.localDate < throughDate;
    let state: AdherenceDay['state'], actual: AdherenceDay['actual'];
    if (day.expectation === null) { state = 'unknownPlan'; actual = 'unknown'; current = 0; satisfied = 0; protectedCount = 0; }
    else if (day.expectation === 'rest' && closed) { state = 'plannedRest'; actual = 'met'; current++; satisfied++; }
    else if (day.expectation !== 'rest' && day.hasActivity) { state = 'activityRecorded'; actual = 'met'; current++; satisfied++; }
    else if (!closed) { state = 'pending'; actual = 'pending'; }
    else if (current > 0 && allocations[monthKey(day.localDate)] === undefined) {
      state = 'protectedMiss'; actual = 'not_met'; allocations[monthKey(day.localDate)] = day.localDate; current++; protectedCount++;
    } else { state = 'missed'; actual = 'not_met'; current = 0; satisfied = 0; protectedCount = 0; }
    longest = Math.max(longest, current);
    results.push({ localDate: day.localDate, state, actual, currentPlanDays: current, longestPlanDays: longest });
  }
  // A missing last day is unknown coverage, not evidence that yesterday's streak is still current.
  if (previous !== null && previous !== throughDate && addCalendarDays(previous, 1) !== throughDate) { current = 0; satisfied = 0; protectedCount = 0; }
  const month = monthKey(throughDate), protectedDate = allocations[month] ?? null;
  return { policyVersion: adherencePolicyVersion, asOf: input.asOf, timeZone: input.timeZone,
    coverageStart: results[0]?.localDate ?? null, throughDate, currentPlanDays: current, longestPlanDays: longest,
    satisfiedDaysInCurrentStreak: satisfied, protectedDaysInCurrentStreak: protectedCount,
    monthlyAllowance: { month, protectedDate, remaining: protectedDate === null ? 1 as const : 0 as const },
    allocations, days: results };
}
