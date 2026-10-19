// Onboarding view model: screen order, server step mapping and field encodings (design contracts.md).
import type { Onboarding, Preferences, Profile } from '../../api/domain';

export type OnboardingScreen =
  | 'name' | 'age' | 'body' | 'outcome-pain' | 'goals' | 'outcome-plans'
  | 'experience' | 'injury' | 'injury-check' | 'injury-pause' | 'coach' | 'plan' | 'ready';

export const SCREEN_STEP: Record<OnboardingScreen, Onboarding['step']> = {
  name: 'name', age: 'measurements', body: 'measurements', 'outcome-pain': 'measurements',
  goals: 'goals', 'outcome-plans': 'goals', experience: 'background', injury: 'injuries',
  'injury-check': 'injuries', 'injury-pause': 'injuries', coach: 'preferences', plan: 'preferences', ready: 'review',
};

export const QUESTION_NUMBER: Partial<Record<OnboardingScreen, number>> = {
  name: 1, age: 2, body: 3, goals: 4, experience: 5, injury: 6, 'injury-check': 6, 'injury-pause': 6, coach: 7, plan: 8,
};

/** Where a saved draft resumes. 'review' means the plan answers were saved but completion was not confirmed. */
export function resumeScreen(step: Onboarding['step']): OnboardingScreen {
  switch (step) {
    case 'measurements': return 'age';
    case 'goals': return 'goals';
    case 'background': return 'experience';
    case 'injuries': return 'injury';
    case 'preferences': return 'coach';
    case 'review': return 'plan';
    default: return 'name';
  }
}

export const GOALS = [
  { key: 'less-pain', title: 'Move with less pain getting in the way', detail: 'Build strength around sore spots', echo: 'move with less pain getting in the way' },
  { key: 'stronger', title: 'Get stronger', detail: 'Lift more, feel sturdier', echo: 'get stronger' },
  { key: 'keep-up-family', title: 'Keep up with family', detail: 'Carry, lift, get down on the floor and back up', echo: 'keep up with family' },
  { key: 'independent', title: 'Stay independent as I age', detail: 'Balance, stairs, getting up easily', echo: 'stay independent as you age' },
  { key: 'build-muscle', title: 'Build muscle', detail: 'Look and feel more solid', echo: 'build muscle' },
] as const;
export const MAX_GOALS = 3;
export const TEXT_LIMITS = { name: 100, trainingContext: 4000, injuryNote: 3000, injuryHistory: 4000 } as const;

export const EXPERIENCE = [
  { value: 'new', title: 'New to it', detail: 'We’ll start with the basics' },
  { value: 'returning', title: 'Some, on and off', detail: 'Comfortable with a few movements' },
  { value: 'regular', title: 'Regular, most weeks', detail: 'Ready for more volume' },
] as const satisfies readonly { value: NonNullable<Profile['trainingBackground']>; title: string; detail: string }[];

export const COACH_STYLES = [
  { id: 'direct', title: 'Short and direct', detail: 'Just the next step', prefs: { coachVoice: 'direct', communication: 'concise' } },
  { id: 'warm', title: 'Warm and encouraging', detail: 'A little more cheering on', prefs: { coachVoice: 'encouraging', communication: 'concise' } },
  { id: 'why', title: 'Explain the why', detail: 'A reason with each change', prefs: { coachVoice: 'calm', communication: 'detailed' } },
] as const satisfies readonly { id: string; title: string; detail: string; prefs: Pick<Preferences, 'coachVoice' | 'communication'> }[];

export function coachStyleOf(prefs: Partial<Pick<Preferences, 'coachVoice' | 'communication'>>) {
  return COACH_STYLES.find((s) => s.prefs.coachVoice === prefs.coachVoice && s.prefs.communication === prefs.communication) ?? null;
}

export const DAYS = [2, 3, 4, 5] as const;
export const MINUTES = [20, 35, 45, 60] as const;
export const EQUIPMENT = [
  { key: 'dumbbells', label: 'Dumbbells' },
  { key: 'barbell', label: 'Barbell' },
  { key: 'machines', label: 'Machines' },
  { key: 'bands', label: 'Bands' },
  { key: 'bodyweight', label: 'Body weight only' },
] as const;

/* ---------------- injury (design GAP 1: serialized into Profile.injuryHistory) ---------------- */

export const AREAS = [
  { key: 'neck', label: 'Neck', noun: 'neck' },
  { key: 'shoulder', label: 'Shoulder', noun: 'shoulder' },
  { key: 'upper-back', label: 'Upper back', noun: 'upper back' },
  { key: 'lower-back', label: 'Lower back', noun: 'lower back' },
  { key: 'elbow-wrist', label: 'Elbow or wrist', noun: 'elbow or wrist' },
  { key: 'hip', label: 'Hip', noun: 'hip' },
  { key: 'knee', label: 'Knee', noun: 'knee' },
  { key: 'ankle-foot', label: 'Ankle or foot', noun: 'ankle or foot' },
  { key: 'other', label: 'Something else', noun: 'other area' },
] as const;
export type InjuryArea = (typeof AREAS)[number]['key'];

export type InjuryAnswer = {
  areas: InjuryArea[];
  /** null = unanswered. Never collapsed into 'no'. */
  worsening: 'no' | 'yes' | 'unsure' | null;
  note: string;
  skipped: boolean;
};

export const EMPTY_INJURY: InjuryAnswer = { areas: [], worsening: null, note: '', skipped: false };

export function serializeInjury(answer: InjuryAnswer): string {
  if (answer.skipped) return '';
  return JSON.stringify({ format: 'form.injury.v1', areas: answer.areas, worsening: answer.worsening, note: answer.note.trim() });
}

/** Reads the serialized answer; legacy free text is kept as the note, never interpreted. */
export function parseInjury(history: string | undefined): InjuryAnswer {
  if (!history) return EMPTY_INJURY;
  try {
    const value = JSON.parse(history) as { format?: unknown; areas?: unknown; worsening?: unknown; note?: unknown };
    if (value.format === 'form.injury.v1') {
      const keys = new Set<string>(AREAS.map((a) => a.key));
      const areas = Array.isArray(value.areas) ? value.areas.filter((a): a is InjuryArea => typeof a === 'string' && keys.has(a)) : [];
      const worsening = value.worsening === 'no' || value.worsening === 'yes' || value.worsening === 'unsure' ? value.worsening : null;
      return { areas, worsening, note: typeof value.note === 'string' ? value.note : '', skipped: false };
    }
  } catch { /* free text */ }
  return { ...EMPTY_INJURY, note: history };
}

export function hasInjuryDetail(answer: InjuryAnswer): boolean {
  return answer.areas.length > 0 || answer.note.trim() !== '';
}

/** "your knee and lower back" style phrase for areas, in chip order. */
export function areasPhrase(areas: readonly InjuryArea[]): string {
  const nouns = AREAS.filter((a) => areas.includes(a.key)).map((a) => a.noun);
  if (nouns.length <= 1) return nouns.join('');
  return `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
}

/** Comma list used by Account → Work around. */
export function areasList(areas: readonly InjuryArea[]): string {
  const labels = AREAS.filter((a) => areas.includes(a.key)).map((a) => a.label);
  return labels.map((l, i) => (i === 0 ? l : l.toLowerCase())).join(', ');
}

/* ---------------- units ---------------- */

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

export function heightLabel(cm: number, unit: 'cm' | 'ft-in'): string {
  if (unit === 'cm') return `${Math.round(cm)} cm`;
  const inches = Math.round(cm / CM_PER_IN);
  return `${Math.floor(inches / 12)} ft ${inches % 12} in`;
}

export function weightLabel(kg: number, unit: 'kg' | 'lb'): string {
  return unit === 'kg' ? `${Math.round(kg * 2) / 2} kg` : `${Math.round(kg / KG_PER_LB)} lb`;
}
