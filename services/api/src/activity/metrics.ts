import { DomainError } from '../errors.js';
import type { ActivityItemInput } from './schemas.js';

export const metresPerMile = 1609.344;
export const kilogramsPerPound = 0.45359237;
export function distanceMetres(value: NonNullable<ActivityItemInput['distance']>): number {
  return value.value * (value.unit === 'm' ? 1 : value.unit === 'km' ? 1000 : metresPerMile);
}
export function speedMetresPerSecond(value: NonNullable<ActivityItemInput['speed']>): number {
  return value.value * (value.unit === 'm/s' ? 1 : value.unit === 'km/h' ? 1000 / 3600 : metresPerMile / 3600);
}
export function paceMetresPerSecond(value: NonNullable<ActivityItemInput['pace']>): number {
  return (value.unit === 'km' ? 1000 : metresPerMile) / value.secondsPerUnit;
}
function disagreement(a: number, b: number, minimum = 0): boolean {
  return Math.abs(a - b) > Math.max(minimum, Math.max(a, b) * 0.01);
}
export function metricIssues(item: ActivityItemInput, path: string): string[] {
  const result: string[] = [];
  const check = (part: { durationSeconds?: number | undefined; distance?: ActivityItemInput['distance']; pace?: ActivityItemInput['pace']; speed?: ActivityItemInput['speed'] }, at: string) => {
    const d = part.distance ? distanceMetres(part.distance) : undefined;
    const s = part.speed ? speedMetresPerSecond(part.speed) : undefined;
    const p = part.pace ? paceMetresPerSecond(part.pace) : undefined;
    if (s !== undefined && p !== undefined && disagreement(s, p)) result.push(at);
    for (const v of [s, p]) if (v !== undefined && d !== undefined && part.durationSeconds !== undefined &&
      disagreement(d / v, part.durationSeconds, 1)) result.push(at);
  };
  check(item, path);
  item.splits?.forEach((split, i) => check(split, `${path}.splits[${i}]`));
  if (item.splits && item.durationSeconds !== undefined) {
    const sum = item.splits.reduce((n, x) => n + x.durationSeconds, 0);
    if ((item.splitCoverage === 'complete' && disagreement(sum, item.durationSeconds, 1)) ||
      sum > item.durationSeconds + Math.max(1, item.durationSeconds * 0.01)) result.push(`${path}.splits`);
    if (item.distance && item.splits.every(x => x.distance !== undefined)) {
      const total = item.splits.reduce((n, x) => n + distanceMetres(x.distance!), 0), declared = distanceMetres(item.distance);
      if ((item.splitCoverage === 'complete' && disagreement(total, declared)) || total > declared * 1.01) result.push(`${path}.splits`);
    }
  }
  return [...new Set(result)];
}
export function assertMetricReview(item: ActivityItemInput, path: string, acknowledgements: readonly { fieldPath: string; code: string }[]): void {
  for (const issue of metricIssues(item, path)) if (!acknowledgements.some(x => x.fieldPath === issue && x.code === 'approximateMetrics'))
    throw new DomainError(422, 'activity_metric_review_required', 'Review the reported metrics.', { fieldPath: issue });
}
