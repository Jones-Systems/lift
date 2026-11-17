import type { ActivityEntry, ActivityWrite, ExerciseSnapshot } from '../contracts';
import { instantMilliseconds } from './dates';
import { resourceId, revision, sanitizeActivityWrite, sanitizeExerciseRef, sanitizePersonalExercise, strictObject } from './validation';

function unconfirmed(): never { throw new Error('activity_receipt_unconfirmed'); }

// Capture only JSON data, without invoking a fake port's accessors or retaining its mutable objects.
function capture(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) return unconfirmed();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) return unconfirmed();
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) return unconfirmed();
        return capture(descriptor.value, ancestors);
      });
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return unconfirmed();
    return Object.fromEntries(Reflect.ownKeys(value).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) return unconfirmed();
      return [key, capture(descriptor.value, ancestors)];
    }));
  } finally { ancestors.delete(value); }
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.entries(left), b = Object.entries(right);
  return a.length === b.length && a.every(([key, value]) => Object.hasOwn(right, key) && same(value, Object.getOwnPropertyDescriptor(right, key)?.value));
}

function snapshot(value: unknown, exercise: ActivityWrite['items'][number]['exercise']): ExerciseSnapshot {
  const object = strictObject(value, ['ref', 'name', 'description', 'movement', 'measurementType', 'kind', 'loadApplicability', 'loadLabel', 'guidance', 'cueStatus', 'safetyAssessment'],
    ['ref', 'name', 'description', 'movement', 'measurementType', 'kind', 'loadApplicability', 'loadLabel', 'guidance', 'cueStatus', 'safetyAssessment']);
  const { ref: rawRef, guidance, cueStatus, safetyAssessment, ...rawFields } = object;
  const ref = sanitizeExerciseRef(rawRef), fields = sanitizePersonalExercise(rawFields);
  if (!same(ref, exercise) || !same(fields, rawFields) || safetyAssessment !== 'notEstablished'
    || (guidance !== 'globalReference' && guidance !== 'userDefinedUnassessed') || (cueStatus !== 'globalReference' && cueStatus !== 'unknown')
    || guidance !== (ref.source === 'personal' ? 'userDefinedUnassessed' : 'globalReference') || (ref.source === 'personal' && cueStatus !== 'unknown')) return unconfirmed();
  return { ...fields, ref, guidance, cueStatus, safetyAssessment };
}

// ActivityService returns submitted fields plus metadata/snapshots, and replays the original receipt, not the latest row.
export function confirmActivityReceipt(value: unknown, payload: ActivityWrite, target: { id: string; expectedRevision: number } | null, previous?: ActivityEntry): ActivityEntry {
  const object = strictObject(capture(value), ['id', 'revision', 'status', 'createdAt', 'updatedAt', 'date', 'kind', 'items', 'performedConfirmed', 'source', 'draftId', 'acknowledgedIssues'],
    ['id', 'revision', 'status', 'createdAt', 'updatedAt', 'date', 'kind', 'items', 'performedConfirmed', 'source', 'draftId', 'acknowledgedIssues']);
  const { id: rawId, revision: rawRevision, status, createdAt, updatedAt, items: rawItems, ...fields } = object;
  const id = resourceId(rawId), resultRevision = revision(rawRevision);
  if (status !== 'recorded' || resultRevision !== (target ? target.expectedRevision + 1 : 1) || (target && id !== target.id)
    || typeof createdAt !== 'string' || instantMilliseconds(createdAt) === null || typeof updatedAt !== 'string' || instantMilliseconds(updatedAt) === null
    || (!target && createdAt !== updatedAt) || (previous && createdAt !== previous.createdAt) || !Array.isArray(rawItems)) return unconfirmed();
  const snapshots: unknown[] = [];
  const inputs = rawItems.map(raw => {
    const item = strictObject(raw, ['id', 'exercise', 'load', 'sets', 'reportedSetCount', 'durationSeconds', 'distance', 'pace', 'speed', 'splits', 'splitCoverage', 'snapshot'], ['id', 'exercise', 'load', 'snapshot']);
    const { snapshot: savedSnapshot, ...input } = item;
    snapshots.push(savedSnapshot); return input;
  });
  const write = sanitizeActivityWrite({ ...fields, items: inputs });
  if (!same({ ...fields, items: inputs }, payload)) return unconfirmed();
  const items = write.items.map((item, index) => {
    const savedSnapshot = snapshot(snapshots[index], item.exercise);
    const old = previous?.items.find(prior => prior.id === item.id && same(prior.exercise, item.exercise));
    if ((old && !same(old.snapshot, savedSnapshot)) || (savedSnapshot.kind === 'run' && (item.durationSeconds === undefined || item.load.state !== 'notApplicable' || item.load.reason !== 'timedActivity'))) return unconfirmed();
    return { ...item, snapshot: savedSnapshot };
  });
  return { ...write, id, revision: resultRevision, status, createdAt, updatedAt, items };
}
