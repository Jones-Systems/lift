import type { ActivityItemInput, Distance, Pace, Speed, Split } from '../contracts';
export const METRES_PER_MILE = 1609.344;
export const KG_PER_POUND = 0.45359237;
export const distanceMetres = (distance: Distance) => distance.value * (distance.unit === 'mi' ? METRES_PER_MILE : distance.unit === 'km' ? 1000 : 1);
export const speedMetresPerSecond = (speed: Speed) => speed.value * (speed.unit === 'mi/h' ? METRES_PER_MILE / 3600 : speed.unit === 'km/h' ? 1000 / 3600 : 1);
export const paceSecondsPerMetre = (pace: Pace) => pace.secondsPerUnit / (pace.unit === 'mi' ? METRES_PER_MILE : 1000);
export const toleranceSeconds = (seconds: number) => Math.max(1, seconds * 0.01);
export type MetricConflict = { fieldPath: string; message: string };
export function metricConflicts(item: Pick<ActivityItemInput, 'durationSeconds' | 'distance' | 'pace' | 'speed' | 'splits' | 'splitCoverage'>): MetricConflict[] {
  const conflicts: MetricConflict[] = [];
  const checkMetrics = (value: typeof item, path: string) => {
    const metres = value.distance ? distanceMetres(value.distance) : undefined;
    const pace = value.pace ? paceSecondsPerMetre(value.pace) : undefined;
    const speed = value.speed ? speedMetresPerSecond(value.speed) : undefined;
    if (metres !== undefined && value.durationSeconds !== undefined) {
      if (pace !== undefined && Math.abs(metres * pace - value.durationSeconds) > toleranceSeconds(value.durationSeconds)) conflicts.push({ fieldPath: path, message: 'Reported pace, distance and duration differ. Review or accept approximate metrics.' });
      if (speed !== undefined && Math.abs(metres / speed - value.durationSeconds) > toleranceSeconds(value.durationSeconds)) conflicts.push({ fieldPath: path, message: 'Reported speed, distance and duration differ. Review or accept approximate metrics.' });
    }
    if (pace !== undefined && speed !== undefined && Math.abs(pace * speed - 1) > 0.01) conflicts.push({ fieldPath: path, message: 'Reported pace and speed differ. Review or accept approximate metrics.' });
  };
  checkMetrics(item, '');
  for (const [index, split] of (item.splits ?? []).entries()) checkMetrics(split, `splits.${index}`);
  if (item.splits?.length) {
    if (!item.splitCoverage) conflicts.push({ fieldPath: 'splitCoverage', message: 'Confirm whether these incremental splits are partial or complete.' });
    const sum = item.splits.reduce((total, split) => total + split.durationSeconds, 0);
    if (item.durationSeconds !== undefined) {
      if (sum > item.durationSeconds + toleranceSeconds(item.durationSeconds) || (item.splitCoverage === 'complete' && Math.abs(sum - item.durationSeconds) > toleranceSeconds(item.durationSeconds))) conflicts.push({ fieldPath: 'splits', message: 'Split durations conflict with reported total duration.' });
      if (item.distance && item.splits.every(split => split.distance)) {
        const metres = distanceMetres(item.distance), splitMetres = item.splits.reduce((total, split) => total + distanceMetres(split.distance!), 0);
        if (splitMetres > metres * 1.01 || (item.splitCoverage === 'complete' && Math.abs(splitMetres - metres) > metres * 0.01)) conflicts.push({ fieldPath: 'splits', message: 'Split distances conflict with reported total distance.' });
      }
    }
  }
  return conflicts;
}
export type DerivedMetric = { field: 'distance' | 'pace' | 'speed'; value: Distance | Pace | Speed; derived: true; sourceFields: string[] };
export function deriveDisplayMetrics(item: Pick<ActivityItemInput, 'durationSeconds' | 'distance' | 'pace' | 'speed'>): DerivedMetric[] {
  const derived: DerivedMetric[] = [], seconds = item.durationSeconds;
  if (seconds && !item.distance && item.pace) derived.push({ field: 'distance', value: { value: seconds / item.pace.secondsPerUnit, unit: item.pace.unit }, derived: true, sourceFields: ['durationSeconds', 'pace'] });
  else if (seconds && !item.distance && item.speed) derived.push({ field: 'distance', value: { value: seconds * speedMetresPerSecond(item.speed), unit: 'm' }, derived: true, sourceFields: ['durationSeconds', 'speed'] });
  if (seconds && item.distance) {
    const metres = distanceMetres(item.distance);
    if (metres > 0 && !item.speed) derived.push({ field: 'speed', value: { value: metres / seconds, unit: 'm/s' }, derived: true, sourceFields: ['durationSeconds', 'distance'] });
    if (metres > 0 && !item.pace) derived.push({ field: 'pace', value: { secondsPerUnit: seconds * 1000 / metres, unit: 'km' }, derived: true, sourceFields: ['durationSeconds', 'distance'] });
  }
  return derived;
}
export const splitDurationTotal = (splits: Split[]) => splits.reduce((total, split) => total + split.durationSeconds, 0);
