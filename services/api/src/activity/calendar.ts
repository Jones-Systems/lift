import { DomainError } from '../errors.js';

export const calendarPolicy = 'activity-calendar-intl-v1' as const;
export function assertCivilDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9999-12-31')
    throw new DomainError(422, 'invalid_activity_date');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new DomainError(422, 'invalid_activity_date');
  return value;
}
export function assertTimeZone(zone: string): string {
  if (zone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(zone))
    throw new DomainError(422, 'invalid_activity_zone');
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); }
  catch { throw new DomainError(422, 'invalid_activity_zone'); }
  return zone;
}
export function localDate(instant: string | Date | number, zone: string): string {
  assertTimeZone(zone);
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new DomainError(422, 'invalid_activity_instant');
  const parts = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find(x => x.type === type)?.value;
  return assertCivilDate(`${part('year')}-${part('month')}-${part('day')}`);
}
export function addCalendarDays(date: string, amount: number): string {
  assertCivilDate(date);
  if (!Number.isSafeInteger(amount)) throw new DomainError(422, 'invalid_calendar_offset');
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return assertCivilDate(result.toISOString().slice(0, 10));
}
export function isoWeekday(date: string): number {
  assertCivilDate(date);
  return new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
}
export function monthKey(date: string): string { return assertCivilDate(date).slice(0, 7); }

// Search civil-date transitions, rather than adding an elapsed 24 hours to midnight.
function firstInstantOnOrAfter(date: string, zone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const civil = (ms: number) => {
    const parts = formatter.formatToParts(ms);
    const get = (type: string) => parts.find(x => x.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  };
  const anchor = Date.parse(`${date}T00:00:00Z`);
  let lo = anchor - 48 * 60 * 60 * 1000, hi = anchor + 48 * 60 * 60 * 1000;
  if (civil(lo) >= date || civil(hi) < date) throw new DomainError(422, 'calendar_boundary_unavailable');
  while (lo + 1 < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (civil(mid) < date) lo = mid; else hi = mid;
  }
  return hi;
}
export function dayBoundaries(date: string, zone: string): { dayStartAt: string; dayEndAt: string } {
  assertCivilDate(date); assertTimeZone(zone);
  const start = firstInstantOnOrAfter(date, zone);
  if (localDate(start, zone) !== date) throw new DomainError(422, 'nonexistent_activity_date');
  const end = firstInstantOnOrAfter(addCalendarDays(date, 1), zone);
  if (end <= start) throw new DomainError(422, 'calendar_boundary_unavailable');
  return { dayStartAt: new Date(start).toISOString(), dayEndAt: new Date(end).toISOString() };
}
export function dateRange(from: string, to: string, maxDays = 366): string[] {
  assertCivilDate(from); assertCivilDate(to);
  if (to < from) throw new DomainError(422, 'invalid_activity_range');
  const result: string[] = [];
  for (let day = from; day <= to; day = addCalendarDays(day, 1)) {
    if (result.length >= maxDays) throw new DomainError(422, 'activity_range_too_large');
    result.push(day);
  }
  return result;
}
