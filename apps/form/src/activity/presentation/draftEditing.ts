import type { ActivityEntry, ActivityWrite, ExerciseSnapshot, Split } from '../contracts';
import type { DraftItem, DraftLoad, DraftResult, DraftSet, IssueResolution } from '../drafts/model';
import { confirmStructuredReview, manualActivityDraft, resolveDraftIssue, selectDraftDate, setDraftLoad } from '../drafts/model';
import { instantMilliseconds, parseCivilDate } from '../drafts/dates';
import { draftValidationProblems, resourceId, sanitizeActivityWrite, sanitizeExerciseRef, sanitizePersonalExercise } from '../drafts/validation';
import type { PendingActivityCommand } from '../drafts/controller';

export const clone = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  return value;
};
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right || Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.prototype.hasOwnProperty.call(right, key)
    && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export function invalidateReview(result: DraftResult, dateAffected = false): DraftResult {
  return { ...result, candidate: { ...result.candidate, performedConfirmed: false,
    date: result.candidate.date ? { ...result.candidate.date, ...(dateAffected ? { confirmed: false } : {}) } : null } };
}
export function editDraft(result: DraftResult, change: (result: DraftResult) => DraftResult, paths: string[]): DraftResult {
  const next = change(clone(result));
  return { ...invalidateReview(next, paths.some(path => path === 'date' || path.startsWith('date.'))),
    issues: next.issues.map(issue => paths.some(path => issue.fieldPath === path || issue.fieldPath.startsWith(`${path}.`) || path.startsWith(`${issue.fieldPath}.`))
      ? { ...issue, resolution: undefined } : issue) };
}
export function changeDate(result: DraftResult, date: string): DraftResult {
  if (!parseCivilDate(date)) throw new Error('invalid_civil_date');
  return editDraft(result, current => selectDraftDate(current.candidate.date ? current : { ...current,
    candidate: { ...current.candidate, date: manualActivityDraft(current.context).candidate.date } }, date), ['date']);
}
export function changeItem(result: DraftResult, id: string, change: (item: DraftItem) => DraftItem, field = ''): DraftResult {
  const index = result.candidate.items.findIndex(item => item.id === id);
  if (index < 0) throw new Error('draft_item_unavailable');
  return editDraft(result, current => ({ ...current, candidate: { ...current.candidate,
    items: current.candidate.items.map(item => item.id === id ? change(item) : item) } }), [`items.${index}${field ? `.${field}` : ''}`]);
}
export function changeLoad(result: DraftResult, id: string, load: DraftLoad, setId?: string): DraftResult {
  const index = result.candidate.items.findIndex(item => item.id === id);
  if (index < 0 || (setId && !result.candidate.items[index].sets?.some(set => set.id === setId))) throw new Error('draft_observation_unavailable');
  return editDraft(result, current => setDraftLoad(current, id, load, setId), [`items.${index}${setId ? '.sets' : '.load'}`]);
}
function freshId(result: DraftResult, issueKey: () => string): string {
  const id = resourceId(issueKey());
  const ids = result.candidate.items.flatMap(item => [item.id, ...(item.sets ?? []).map(set => set.id), ...(item.splits ?? []).map(split => split.id)]);
  if (ids.includes(id)) throw new Error('fresh_observation_identity_required');
  return id;
}
export function addItem(result: DraftResult, issueKey: () => string): DraftResult {
  const id = freshId(result, issueKey);
  return editDraft(result, current => ({ ...current, candidate: { ...current.candidate,
    items: [...current.candidate.items, { id, exercise: { state: 'missing', mention: '' }, load: { state: 'missing' } }] } }), []);
}
export function removeItem(result: DraftResult, id: string): DraftResult {
  if (!result.candidate.items.some(item => item.id === id)) throw new Error('draft_item_unavailable');
  return editDraft(result, current => ({ ...current, candidate: { ...current.candidate, items: current.candidate.items.filter(item => item.id !== id) } }), ['items']);
}
export function addSet(result: DraftResult, itemId: string, issueKey: () => string): DraftResult {
  const id = freshId(result, issueKey);
  return changeItem(result, itemId, item => ({ ...item, sets: [...(item.sets ?? []), { id, load: { state: 'missing' } }] }), 'sets');
}
export function changeSet(result: DraftResult, itemId: string, setId: string, change: (set: DraftSet) => DraftSet): DraftResult {
  return changeItem(result, itemId, item => {
    if (!item.sets?.some(set => set.id === setId)) throw new Error('draft_set_unavailable');
    return { ...item, sets: item.sets.map(set => set.id === setId ? change(set) : set) };
  }, 'sets');
}
export function removeSet(result: DraftResult, itemId: string, setId: string): DraftResult {
  return changeItem(result, itemId, item => {
    const sets = item.sets?.filter(set => set.id !== setId);
    const next = { ...item }; delete next.sets;
    return sets?.length ? { ...next, sets } : next;
  }, 'sets');
}
export function addSplit(result: DraftResult, itemId: string, issueKey: () => string): DraftResult {
  const id = freshId(result, issueKey);
  return changeItem(result, itemId, item => ({ ...item,
    splits: [...(item.splits ?? []), { id, sequence: (item.splits?.length ?? 0) + 1, durationSeconds: NaN }] }), 'splits');
}
export function changeSplit(result: DraftResult, itemId: string, splitId: string, change: (split: Split) => Split): DraftResult {
  return changeItem(result, itemId, item => {
    if (!item.splits?.some(split => split.id === splitId)) throw new Error('draft_split_unavailable');
    return { ...item, splits: item.splits.map(split => split.id === splitId ? change(split) : split) };
  }, 'splits');
}
export function removeSplit(result: DraftResult, itemId: string, splitId: string): DraftResult {
  return changeItem(result, itemId, item => {
    const splits = item.splits?.filter(split => split.id !== splitId).map((split, index) => ({ ...split, sequence: index + 1 }));
    const next = { ...item }; delete next.splits; delete next.splitCoverage;
    return splits?.length ? { ...next, splits, ...(item.splitCoverage ? { splitCoverage: item.splitCoverage } : {}) } : next;
  }, 'splits');
}
export function resolveIssue(result: DraftResult, id: string, resolution: IssueResolution): DraftResult {
  return invalidateReview(resolveDraftIssue(result, id, resolution));
}
export function optionalNumber<T extends object, K extends keyof T>(object: T, key: K, text: string): T {
  const next = { ...object };
  if (text.trim() === '') delete next[key];
  else next[key] = Number(text) as T[K];
  return next;
}
export function reviewProblems(result: DraftResult) {
  if (!result.candidate.date) return [{ fieldPath: 'date', code: 'date_context_unavailable' }];
  return draftValidationProblems(confirmStructuredReview(result));
}

export function validSnapshot(snapshot: ExerciseSnapshot): boolean {
  try {
    if (!snapshot) return false;
    sanitizePersonalExercise({ name: snapshot.name, description: snapshot.description, movement: snapshot.movement,
      measurementType: snapshot.measurementType, kind: snapshot.kind, loadApplicability: snapshot.loadApplicability, loadLabel: snapshot.loadLabel });
    sanitizeExerciseRef(snapshot.ref);
    return ['globalReference', 'userDefinedUnassessed'].includes(snapshot.guidance)
      && ['globalReference', 'unknown'].includes(snapshot.cueStatus) && snapshot.safetyAssessment === 'notEstablished';
  } catch { return false; }
}
export function validEntry(entry: ActivityEntry, id?: string, minimumRevision = 1): boolean {
  try {
    if (!entry || (id !== undefined && entry.id !== id) || resourceId(entry.id) !== entry.id
      || !Number.isSafeInteger(entry.revision) || entry.revision < minimumRevision || !['recorded', 'voided'].includes(entry.status)
      || instantMilliseconds(entry.createdAt) === null || instantMilliseconds(entry.updatedAt) === null) return false;
    const items = entry.items.map(({ snapshot, ...item }) => {
      if (!validSnapshot(snapshot)) throw new Error('snapshot_status_invalid');
      if (!sameValue(sanitizeExerciseRef(snapshot.ref), item.exercise)) throw new Error('snapshot_ref_mismatch');
      return item;
    });
    sanitizeActivityWrite({ date: entry.date, kind: entry.kind, items, performedConfirmed: entry.performedConfirmed,
      source: entry.source, draftId: entry.draftId, acknowledgedIssues: entry.acknowledgedIssues });
    return true;
  } catch { return false; }
}
export function receiptMatches(entry: ActivityEntry, command: PendingActivityCommand): boolean {
  if (!validEntry(entry, command.target?.id) || entry.status !== 'recorded'
    || entry.revision !== (command.target ? command.target.expectedRevision + 1 : 1)) return false;
  const actual: ActivityWrite = { date: entry.date, kind: entry.kind, items: entry.items.map(({ snapshot: _snapshot, ...item }) => item),
    performedConfirmed: entry.performedConfirmed, source: entry.source, draftId: entry.draftId, acknowledgedIssues: entry.acknowledgedIssues };
  return sameValue(actual, command.payload);
}
