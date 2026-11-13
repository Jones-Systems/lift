import type { SettingsEditTarget } from '../../contract';
import type { ContextReview } from '../../../integration/contextConfirmation';
import { EQUIPMENT, EXPERIENCE, GOALS, coachStyleOf, heightLabel, weightLabel } from '../../onboarding/model';

export type ContextRow = Readonly<{ id: string; label: string; text: string; edit?: SettingsEditTarget }>;
export type ContextRowGroup = Readonly<{ heading: string; rows: readonly ContextRow[] }>;

const text = (value: string | undefined) => value === undefined ? 'Not recorded' : value === '' ? 'Empty response' : value;
const list = (values: readonly string[], labels: readonly { key: string; label: string }[]) =>
  values.length ? values.map(value => labels.find(item => item.key === value)?.label ?? text(value)).join('\n') : 'None recorded';

export function contextReviewRows(review: Pick<ContextReview, 'profile' | 'preferences'>): readonly ContextRowGroup[] {
  const { profile: p, preferences: q } = review;
  return [
    { heading: 'Profile', rows: [
      { id: 'name', label: 'Name', text: text(p.name), edit: 'name' },
      { id: 'age', label: 'Age', text: p.age === null ? 'Not shared' : String(p.age), edit: 'age' },
      { id: 'height', label: 'Height', text: p.heightCm === null ? 'Not shared' : heightLabel(p.heightCm, q.heightUnit), edit: 'body' },
      { id: 'weight', label: 'Weight', text: p.weightKg === null ? 'Not shared' : weightLabel(p.weightKg, q.loadUnit), edit: 'body' },
      { id: 'experience', label: 'Experience', text: EXPERIENCE.find(item => item.value === p.trainingBackground)?.title ?? 'Not shared', edit: 'experience' },
      { id: 'goals', label: 'Goals', text: list(p.goals, GOALS.map(item => ({ key: item.key, label: item.title }))), edit: 'goals' },
      { id: 'limitations', label: 'Recorded limitations', text: text(p.injuryHistory), edit: 'workAround' },
      { id: 'context', label: 'Training context', text: text(p.trainingContext) },
    ] },
    { heading: 'Training', rows: [
      { id: 'schedule', label: 'Schedule', text: `${q.trainingDaysPerWeek} days · ${q.sessionMinutes} min`, edit: 'schedule' },
      { id: 'equipment', label: 'Equipment', text: list(q.equipment, EQUIPMENT), edit: 'equipment' },
      { id: 'coach', label: 'Coach style', text: coachStyleOf(q)?.title ?? `${q.coachVoice} · ${q.communication}`, edit: 'coach' },
      { id: 'voice', label: 'Coach voice', text: q.coachVoice },
      { id: 'communication', label: 'Communication', text: q.communication },
    ] },
    { heading: 'Preferences', rows: [
      { id: 'mode', label: 'App mode', text: q.appMode },
      { id: 'load-unit', label: 'Weight unit', text: q.loadUnit },
      { id: 'height-unit', label: 'Height unit', text: q.heightUnit },
      { id: 'mascot', label: 'Mascot', text: q.mascot },
      { id: 'animation', label: 'Animation style', text: q.animationStyle },
      { id: 'reminders', label: 'Workout reminders', text: q.remindersEnabled ? 'On' : 'Off' },
    ] },
  ];
}
