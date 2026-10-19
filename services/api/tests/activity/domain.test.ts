import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, assertCivilDate, dayBoundaries, localDate, replayAdherence, metricIssues,
  distanceMetres, kilogramsPerPound, paceMetresPerSecond, speedMetresPerSecond } from '../../src/activity/index.js';
import * as s from '../../src/activity/schemas.js';
import { entryInput } from './fixture.js';

test('civil arithmetic, strict month lengths and frozen capture reference cross DST', () => {
  assert.equal(localDate('2026-03-09T04:30:00Z', 'America/New_York'), '2026-03-09');
  assert.equal(addCalendarDays('2026-03-09', -1), '2026-03-08');
  assert.equal(addCalendarDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addCalendarDays('2026-01-01', -1), '2025-12-31');
  assert.throws(() => assertCivilDate('2027-02-29'));
  assert.throws(() => assertCivilDate('2026-04-31'));
  assert.equal(localDate('2026-10-01T18:30:00Z', 'Asia/Kathmandu'), '2026-10-02');
});
test('next local day has 23 or 25 hours; skipped civil dates reject', () => {
  const spring = dayBoundaries('2026-03-08', 'America/New_York');
  assert.deepEqual(spring, { dayStartAt: '2026-03-08T05:00:00.000Z', dayEndAt: '2026-03-09T04:00:00.000Z' });
  const fall = dayBoundaries('2026-11-01', 'America/New_York');
  assert.deepEqual(fall, { dayStartAt: '2026-11-01T04:00:00.000Z', dayEndAt: '2026-11-02T05:00:00.000Z' });
  const kathmandu = dayBoundaries('2026-10-01', 'Asia/Kathmandu');
  assert.equal(kathmandu.dayStartAt, '2026-09-30T18:15:00.000Z');
  assert.throws(() => dayBoundaries('2011-12-30', 'Pacific/Apia'), /nonexistent_activity_date/);
});
test('load missing, zero, unknown and not applicable are distinct; strict payloads reject transcripts', () => {
  assert.equal(s.load.parse({ state: 'knownValue', value: 0, unit: 'kg', basis: 'unspecified' }).state, 'knownValue');
  assert.equal(s.load.parse({ state: 'unknown', confirmed: true }).state, 'unknown');
  assert.equal(s.load.parse({ state: 'notApplicable', reason: 'unloaded' }).state, 'notApplicable');
  assert.equal(s.activityItem.safeParse({ id: 'item', exercise: { source: 'global', id: 'global-press' } }).success, false);
  for (const value of [-1, NaN, Infinity, 501]) assert.equal(s.load.safeParse({ state: 'knownValue', value, unit: 'kg', basis: 'total' }).success, false);
  assert.equal(s.load.safeParse({ state: 'unknown', confirmed: true, value: 0 }).success, false);
  assert.equal(s.activityWrite.safeParse({ ...entryInput('draft'), transcript: 'synthetic forbidden' }).success, false);
});
test('exact unit factors and sexagesimal pace survive; contradictory metrics require review', () => {
  assert.equal(distanceMetres({ value: 1, unit: 'mi' }), 1609.344);
  assert.equal(kilogramsPerPound, 0.45359237);
  assert.equal(paceMetresPerSecond({ secondsPerUnit: 510, unit: 'mi' }), 1609.344 / 510);
  assert.equal(speedMetresPerSecond({ value: 1, unit: 'mi/h' }), 1609.344 / 3600);
  const item = s.activityItem.parse({ id: 'run', exercise: { source: 'global', id: 'global-press' },
    load: { state: 'notApplicable', reason: 'timedActivity' }, durationSeconds: 3360, pace: { secondsPerUnit: 510, unit: 'mi' } });
  assert.deepEqual(metricIssues(item, 'items[0]'), []);
  assert.equal(item.distance, undefined);
  assert.deepEqual(metricIssues({ ...item, distance: { value: 1, unit: 'mi' } }, 'items[0]'), ['items[0]']);
  assert.ok(metricIssues({ ...item, splits: [{ id: 'split', sequence: 1, durationSeconds: 3000 }], splitCoverage: 'complete' }, 'items[0]').includes('items[0].splits'));
  assert.deepEqual(metricIssues({ ...item, splits: [{ id: 'split', sequence: 1, durationSeconds: 3000 }], splitCoverage: 'partial' }, 'items[0]'), []);
});
const replay = (activityDates: string[]) => replayAdherence({ timeZone: 'America/New_York', asOf: '2026-10-06T16:00:00Z',
  days: ['01', '02', '03', '04', '05'].map(day => ({ localDate: `2026-10-${day}`, expectation: day === '02' ? 'rest' : 'workout', hasActivity: activityDates.includes(day) })) });
test('replay oracle backfill and void move the sole monthly allowance deterministically', () => {
  const first = replay(['01', '04']);
  assert.deepEqual(first.days.map(x => x.state), ['activityRecorded', 'plannedRest', 'protectedMiss', 'activityRecorded', 'missed']);
  assert.equal(first.currentPlanDays, 0); assert.equal(first.longestPlanDays, 4);
  const repaired = replay(['01', '03', '04']);
  assert.equal(repaired.currentPlanDays, 5); assert.equal(repaired.longestPlanDays, 5);
  assert.equal(repaired.monthlyAllowance.protectedDate, '2026-10-05');
  assert.equal(repaired.satisfiedDaysInCurrentStreak, 4); assert.equal(repaired.protectedDaysInCurrentStreak, 1);
  assert.deepEqual(replay(['01', '04']), first);
  assert.deepEqual(replay(['04', '03', '01']), repaired);
  assert.equal(repaired.days.at(-1)?.actual, 'not_met');
});
test('no starting grace, next calendar month renews without banking, pending rest does not accrue', () => {
  const result = replayAdherence({ timeZone: 'UTC', asOf: '2026-11-02T12:00:00Z', days: [
    { localDate: '2026-10-29', expectation: 'workout', hasActivity: false },
    { localDate: '2026-10-30', expectation: 'rest', hasActivity: true },
    { localDate: '2026-10-31', expectation: 'workout', hasActivity: false },
    { localDate: '2026-11-01', expectation: 'workout', hasActivity: false },
    { localDate: '2026-11-02', expectation: 'rest', hasActivity: true },
    { localDate: '2026-11-03', expectation: 'rest', hasActivity: true },
  ] });
  assert.deepEqual(result.days.map(x => x.state), ['missed', 'plannedRest', 'protectedMiss', 'protectedMiss', 'pending']);
  assert.equal(result.currentPlanDays, 3); assert.equal(result.monthlyAllowance.remaining, 0);
  assert.deepEqual(result.allocations, Object.assign(Object.create(null), { '2026-10': '2026-10-31', '2026-11': '2026-11-01' }));
});
test('unknown coverage and skipped input dates break continuity and longest recomputes', () => {
  const result = replayAdherence({ timeZone: 'UTC', asOf: '2026-10-04T12:00:00Z', days: [
    { localDate: '2026-10-01', expectation: 'rest', hasActivity: false },
    { localDate: '2026-10-03', expectation: null, hasActivity: true },
    { localDate: '2026-10-04', expectation: 'workout', hasActivity: true },
  ] });
  assert.equal(result.currentPlanDays, 1); assert.equal(result.longestPlanDays, 1);
  assert.throws(() => replayAdherence({ timeZone: 'UTC', asOf: '2026-10-04T12:00:00Z', days: [result.days[0]!, result.days[0]!].map(x => ({ localDate: x.localDate, expectation: null, hasActivity: false })) }));
});
