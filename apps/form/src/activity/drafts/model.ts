import type { ActivityDate, ActivityEntry, ActivityItemInput, ActivityWrite, ExerciseRef, ExerciseSnapshot, Load, PersonalExerciseFields, SetObservation } from '../contracts';
import { localDateAt } from './dates';
export function copyExerciseSnapshot(snapshot: ExerciseSnapshot): ExerciseSnapshot {
  return Object.freeze({ ...snapshot, ref: Object.freeze({ ...snapshot.ref }) });
}
export type CaptureContext = Readonly<{
  accountGeneration: string; draftId: string; capturedAt: string; referenceLocalDate: string;
  timeZone: string; selectedDate: string | null;
}>;
export function freezeCaptureContext(input: Omit<CaptureContext, 'referenceLocalDate'>): CaptureContext {
  const referenceLocalDate = localDateAt(input.capturedAt, input.timeZone);
  if (!referenceLocalDate || !input.accountGeneration || !input.draftId) throw new Error('capture_context_unavailable');
  return Object.freeze({ ...input, referenceLocalDate });
}
export function sameCaptureContext(left: CaptureContext, right: CaptureContext): boolean {
  return left.accountGeneration === right.accountGeneration && left.draftId === right.draftId && left.capturedAt === right.capturedAt
    && left.referenceLocalDate === right.referenceLocalDate && left.timeZone === right.timeZone && left.selectedDate === right.selectedDate;
}
export type DraftLoad = Load | { state: 'missing' };
export type DraftSet = Omit<SetObservation, 'load'> & { load: DraftLoad };
export type DraftExercise =
  | { state: 'selected'; ref: ExerciseRef; snapshot: ExerciseSnapshot }
  | { state: 'ambiguous'; mention: string; candidates: ExerciseSnapshot[] }
  | { state: 'custom'; mention: string; fields: PersonalExerciseFields }
  | { state: 'missing'; mention: string };
export type DraftItem = Omit<ActivityItemInput, 'exercise' | 'load' | 'sets'> & { exercise: DraftExercise; load: DraftLoad; sets?: DraftSet[] };
export type DraftIssueCode = 'dateConflict' | 'dateAmbiguous' | 'exerciseAmbiguous' | 'exerciseMissing' | 'loadMissing'
  | 'unitMissing' | 'durationMissing' | 'metricConflict' | 'unsupportedPhrase' | 'clockUncertain' | 'possibleDuplicate'
  | 'invalidValue' | 'customExercise' | 'unsupportedLocale' | 'futureIntent' | 'negatedActivity' | 'correctionAmbiguous' | 'dateUnavailable';
export type IssueResolution = { kind: 'edited' } | { kind: 'acknowledged'; code: 'approximateMetrics' | 'possibleDuplicate' } | { kind: 'discardedFragment' };
export type DraftIssue = { id: string; fieldPath: string; code: DraftIssueCode; blocking: boolean; message: string; fragment?: string; candidates?: { id: string; label: string }[]; resolution?: IssueResolution };
export type DraftDate = Omit<ActivityDate, 'confirmed'> & { confirmed: boolean; spokenDates: string[]; selectedDate: string | null };
export type ActivityDraft = {
  date: DraftDate | null; kind: ActivityWrite['kind']; items: DraftItem[]; performedConfirmed: boolean;
  source: ActivityWrite['source']; draftId: string;
};
export type DraftResult = {
  draftId: string; parserVersion: 'activity-parser-v1'; context: CaptureContext;
  candidate: ActivityDraft; issues: DraftIssue[]; reviewedText: string; unsupportedFragments: string[];
};
export const stableDraftId = (context: CaptureContext, category: string, index: number) => `${context.draftId.slice(0, 50)}_${category}_${index}`;
export function manualActivityDraft(context: CaptureContext, exercise?: ExerciseSnapshot): DraftResult {
  const localDate = context.selectedDate ?? context.referenceLocalDate;
  const item: DraftItem = { id: stableDraftId(context, 'item', 0), exercise: exercise ? { state: 'selected', ref: { ...exercise.ref }, snapshot: copyExerciseSnapshot(exercise) } : { state: 'missing', mention: '' }, load: { state: 'missing' } };
  return { draftId: context.draftId, parserVersion: 'activity-parser-v1', context: Object.freeze({ ...context }),
    candidate: { date: { localDate, timeZone: context.timeZone, calendar: 'iso8601', source: context.selectedDate ? 'selected' : 'captureDefault',
      capturedAt: context.capturedAt, referenceLocalDate: context.referenceLocalDate, confirmed: false, selectedDate: context.selectedDate, spokenDates: [] },
    kind: 'workout', items: [item], performedConfirmed: false, source: 'manual', draftId: context.draftId },
    issues: [], reviewedText: '', unsupportedFragments: [] };
}
export function chooseExercise(result: DraftResult, itemId: string, snapshot: ExerciseSnapshot): DraftResult {
  return { ...result, candidate: { ...result.candidate, items: result.candidate.items.map(item => item.id === itemId ? { ...item, exercise: { state: 'selected', ref: { ...snapshot.ref }, snapshot: copyExerciseSnapshot(snapshot) } } : item) } };
}
export function setDraftLoad(result: DraftResult, itemId: string, load: DraftLoad, setId?: string): DraftResult {
  return { ...result, candidate: { ...result.candidate, items: result.candidate.items.map(item => item.id !== itemId ? item : setId
    ? { ...item, sets: item.sets?.map(set => set.id === setId ? { ...set, load } : set) } : { ...item, load }) } };
}
export function selectDraftDate(result: DraftResult, localDate: string): DraftResult {
  if (!result.candidate.date) throw new Error('date_context_unavailable');
  return { ...result, candidate: { ...result.candidate, date: { ...result.candidate.date, localDate, source: 'selected', confirmed: true } } };
}
export function resolveDraftIssue(result: DraftResult, id: string, resolution: IssueResolution): DraftResult {
  const issue = result.issues.find(value => value.id === id);
  if (!issue) throw new Error('issue_not_found');
  if (resolution.kind === 'acknowledged' && !((issue.code === 'metricConflict' && resolution.code === 'approximateMetrics') || (issue.code === 'possibleDuplicate' && resolution.code === 'possibleDuplicate'))) throw new Error('issue_requires_edit');
  if (resolution.kind === 'discardedFragment' && !['unsupportedPhrase', 'unsupportedLocale', 'negatedActivity', 'futureIntent', 'correctionAmbiguous'].includes(issue.code)) throw new Error('issue_requires_edit');
  return { ...result, issues: result.issues.map(value => value.id === id ? { ...value, resolution } : value) };
}

export function draftFromEntry(accountGeneration: string, entry: ActivityEntry): DraftResult {
  const context: CaptureContext = Object.freeze({ accountGeneration, draftId: entry.draftId, capturedAt: entry.date.capturedAt,
    referenceLocalDate: entry.date.referenceLocalDate, timeZone: entry.date.timeZone,
    selectedDate: entry.date.source === 'selected' ? entry.date.localDate : null });
  return { draftId: entry.draftId, parserVersion: 'activity-parser-v1', context,
    candidate: { date: { ...entry.date, confirmed: false, spokenDates: [], selectedDate: context.selectedDate },
      kind: entry.kind, source: entry.source, draftId: entry.draftId, performedConfirmed: false,
      items: entry.items.map(({ snapshot, ...item }) => ({ ...item, exercise: { state: 'selected', ref: { ...item.exercise }, snapshot: copyExerciseSnapshot(snapshot) },
        load: { ...item.load }, ...(item.distance ? { distance: { ...item.distance } } : {}), ...(item.pace ? { pace: { ...item.pace } } : {}), ...(item.speed ? { speed: { ...item.speed } } : {}), ...(item.sets ? { sets: item.sets.map(set => ({ ...set, load: { ...set.load } })) } : {}),
        ...(item.splits ? { splits: item.splits.map(split => ({ ...split, ...(split.distance ? { distance: { ...split.distance } } : {}), ...(split.pace ? { pace: { ...split.pace } } : {}), ...(split.speed ? { speed: { ...split.speed } } : {}) })) } : {}) })) },
    issues: entry.acknowledgedIssues.map((issue, index) => ({ id: stableDraftId(context, 'issue', index), fieldPath: issue.fieldPath,
      code: issue.code === 'approximateMetrics' ? 'metricConflict' : 'possibleDuplicate', blocking: true, message: 'Review the previous acknowledged issue for this correction.' })),
    reviewedText: '', unsupportedFragments: [] };
}
// Replacing a saved exercise must use a fresh caller-generated item identity, including across later revisions.
export function replaceDraftExercise(result: DraftResult, oldItemId: string, newItemId: string, snapshot: ExerciseSnapshot): DraftResult {
  if (oldItemId === newItemId || result.candidate.items.some(item => item.id === newItemId)) throw new Error('replacement_identity_required');
  return { ...result, candidate: { ...result.candidate, items: result.candidate.items.map(item => item.id === oldItemId
    ? { id: newItemId, exercise: { state: 'selected', ref: { ...snapshot.ref }, snapshot: copyExerciseSnapshot(snapshot) }, load: { state: 'missing' } } : item) } };
}
export function confirmStructuredReview(result: DraftResult): DraftResult {
  if (!result.candidate.date) throw new Error('date_context_unavailable');
  return { ...result, candidate: { ...result.candidate, date: { ...result.candidate.date, confirmed: true }, performedConfirmed: true } };
}
export function confirmUnknownMissingLoads(result: DraftResult): DraftResult {
  return { ...result, candidate: { ...result.candidate, items: result.candidate.items.map(item => ({ ...item,
    load: item.load.state === 'missing' ? { state: 'unknown', confirmed: true } : item.load,
    ...(item.sets ? { sets: item.sets.map(set => ({ ...set, load: set.load.state === 'missing' ? { state: 'unknown', confirmed: true } : set.load })) } : {}) })) },
    issues: result.issues.map(issue => issue.code === 'loadMissing' ? { ...issue, resolution: { kind: 'edited' } } : issue) };
}
