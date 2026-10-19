export type CivilDate = { year: number; month: number; day: number };
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
export function daysInMonth(year: number, month: number): number {
  return month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}
export function parseCivilDate(value: string): CivilDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) ? { year, month, day } : null;
}
const format = ({ year, month, day }: CivilDate) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
export function addCivilDays(value: string, amount: number): string {
  const date = parseCivilDate(value);
  if (!date || !Number.isInteger(amount) || Math.abs(amount) > 366000) throw new Error('invalid_civil_date');
  for (let remaining = amount; remaining !== 0; remaining += remaining > 0 ? -1 : 1) {
    date.day += remaining > 0 ? 1 : -1;
    if (date.day > daysInMonth(date.year, date.month)) { date.day = 1; date.month++; }
    if (date.month > 12) { date.month = 1; date.year++; }
    if (date.day < 1) { date.month--; if (date.month < 1) { date.month = 12; date.year--; } date.day = daysInMonth(date.year, date.month); }
    if (date.year < 1 || date.year > 9999) throw new Error('civil_date_out_of_range');
  }
  return format(date);
}
export function validTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || !zone || zone.length > 100 || /^[+-]/.test(zone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); return true; } catch { return false; }
}
export function instantMilliseconds(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !parseCivilDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  if (match[6] !== 'Z' && (Number(match[6].slice(1, 3)) > 23 || Number(match[6].slice(4)) > 59)) return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}
function civilFromFormatter(milliseconds: number, formatter: Intl.DateTimeFormat): string | null {
  try {
    const parts = formatter.formatToParts(milliseconds);
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
    const date = `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`;
    return parseCivilDate(date) ? date : null;
  } catch { return null; }
}
function dateFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
}
export function localDateAt(value: string | number, zone: string): string | null {
  const milliseconds = typeof value === 'number' ? value : instantMilliseconds(value);
  if (milliseconds === null || !Number.isFinite(milliseconds) || !validTimeZone(zone)) return null;
  try { return civilFromFormatter(milliseconds, dateFormatter(zone)); } catch { return null; }
}
export type DayBoundaryResult = { status: 'available'; startAt: string; endAt: string } | { status: 'unavailable'; reason: 'invalidDate' | 'invalidZone' | 'skippedCivilDay' | 'zoneDataUnavailable' };
// Search actual instants, never synthesize a midnight offset. Intl/tzdb remains a runtime dependency.
export function civilDayBoundaries(date: string, zone: string): DayBoundaryResult {
  const parsed = parseCivilDate(date);
  if (!parsed) return { status: 'unavailable', reason: 'invalidDate' };
  if (!validTimeZone(zone)) return { status: 'unavailable', reason: 'invalidZone' };
  let formatter: Intl.DateTimeFormat, nextDate: string;
  try { formatter = dateFormatter(zone); nextDate = addCivilDays(date, 1); } catch { return { status: 'unavailable', reason: 'zoneDataUnavailable' }; }
  const civilAt = (milliseconds: number) => civilFromFormatter(milliseconds, formatter);
  const anchor = new Date(0); anchor.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day); anchor.setUTCHours(0, 0, 0, 0);
  const low = anchor.getTime() - 48 * 3600000, high = anchor.getTime() + 72 * 3600000;
  const firstAtLeast = (target: string): number | null => {
    let left = low, right = high;
    const first = civilAt(left), last = civilAt(right);
    if (!first || !last || first >= target || last < target) return null;
    while (left + 1 < right) {
      const mid = Math.floor((left + right) / 2), civil = civilAt(mid);
      if (!civil) return null;
      if (civil < target) left = mid; else right = mid;
    }
    return right;
  };
  const start = firstAtLeast(date), end = firstAtLeast(nextDate);
  if (start === null || end === null) return { status: 'unavailable', reason: 'zoneDataUnavailable' };
  if (civilAt(start) !== date || end <= start) return { status: 'unavailable', reason: 'skippedCivilDay' };
  return { status: 'available', startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
}
export function validateActivityDateAgainstServerToday(date: string, confirmedZone: string, serverToday: string): string | null {
  if (!parseCivilDate(serverToday)) return 'server_today_unavailable';
  if (!parseCivilDate(date) || date < '1900-01-01') return 'invalid_activity_date';
  const boundary = civilDayBoundaries(date, confirmedZone);
  if (boundary.status === 'unavailable') return boundary.reason;
  return date > serverToday ? 'future_activity_date' : null;
}
