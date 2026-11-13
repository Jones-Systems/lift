import type { SourcePlan, SourcePrescriptionItem } from '../../../api/domain';

export type SourcePlanDetailRow = Readonly<{ label: string; detail: string }>;

export function sourcePlanSummaryRows(plan: SourcePlan): readonly SourcePlanDetailRow[] {
  const { minMinutes, maxMinutes } = plan.duration;
  const minutes = minMinutes === maxMinutes ? String(minMinutes) : `${minMinutes}–${maxMinutes}`;
  return [
    { label: 'Status', detail: plan.archived ? 'Archived' : 'Saved' },
    { label: 'Estimated duration', detail: `${minutes} minutes (estimated)` },
    { label: 'Movements', detail: String(plan.items.length) },
  ];
}

export function sourcePlanItemHeading(item: SourcePrescriptionItem, position: number): string {
  return `${position + 1}. Exercise ID: ${item.native.exercise_id}`;
}

export function sourcePlanItemRows(item: SourcePrescriptionItem): readonly SourcePlanDetailRow[] {
  const native = item.native;
  const rows: SourcePlanDetailRow[] = [
    { label: 'Movement pattern', detail: native.movement_pattern },
    { label: 'Role', detail: native.role },
    { label: 'Sets', detail: String(native.sets) },
    { label: 'Rep range', detail: native.rep_range === undefined ? 'Not specified'
      : `${native.rep_range[0]}–${native.rep_range[1]} reps` },
    { label: 'Rest', detail: `${native.rest_seconds} seconds` },
    { label: 'Target reps in reserve (RIR)', detail: native.target_rir === undefined ? 'Not specified' : String(native.target_rir) },
    { label: 'Prescribed load', detail: 'Unspecified (basis unknown)' },
    { label: 'Substituted for exercise ID', detail: native.substituted_for === undefined ? 'Not provided' : native.substituted_for },
  ];
  if (native.notes === undefined) rows.push({ label: 'Notes', detail: 'Not provided' });
  else native.notes.forEach((note, index) => rows.push({ label: `Note ${index + 1}`, detail: note === '' ? 'Empty note' : note }));
  return rows;
}
