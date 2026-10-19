import { dateRange } from './calendar.js';
import type { AdherenceDay } from './adherence.js';

export function aggregateAdherenceRange(input: Readonly<{
  from: string; to: string; days: readonly Pick<AdherenceDay, 'localDate' | 'actual' | 'state'>[];
}>) {
  const expected = dateRange(input.from, input.to);
  const indexed = new Map(input.days.map(day => [day.localDate, day]));
  let actualMetDays = 0, protectedContinuityDays = 0, notMetDays = 0, pendingDays = 0, unknownDays = 0;
  for (const date of expected) {
    const day = indexed.get(date);
    if (!day || day.actual === 'unknown') unknownDays++;
    else if (day.actual === 'met') actualMetDays++;
    else if (day.actual === 'pending') pendingDays++;
    else notMetDays++;
    if (day?.state === 'protectedMiss') protectedContinuityDays++;
  }
  return { from: input.from, to: input.to, calendarDays: expected.length,
    actualMetDays, protectedContinuityDays, notMetDays, pendingDays, unknownDays,
    knownDays: expected.length - unknownDays };
}
