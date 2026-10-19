import { z } from 'zod';
import { DomainError } from '../errors.js';
import type { FeedbackContent, FeedbackScope, JsonValue } from './index.js';
import type { FeedbackCommand, FeedbackContextWitness, FeedbackWitnessRequest, NonDeletionEvent } from './ledger-types.js';

export const trainingFeedbackHttpLimits = Object.freeze({ bodyBytes: 64 * 1024, jsonDepth: 8, jsonNodes: 2048,
  text: 4096, collection: 128, objectKeys: 64, keyLength: 128, sourceRefs: 64, qualifications: 32, signals: 32, sets: 256 });
const text = (maximum: number = trainingFeedbackHttpLimits.text) => z.string().max(maximum).refine(value => value.trim().length > 0);
const id = text(160);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function boundedJson(input: unknown): input is JsonValue {
  const pending = [{ value: input, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > trainingFeedbackHttpLimits.jsonNodes || depth > trainingFeedbackHttpLimits.jsonDepth) return false;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') { if (!Number.isFinite(value)) return false; continue; }
    if (typeof value === 'string') { if (value.length > trainingFeedbackHttpLimits.text) return false; continue; }
    if (Array.isArray(value)) {
      if (value.length > trainingFeedbackHttpLimits.collection) return false;
      pending.push(...value.map(item => ({ value: item, depth: depth + 1 }))); continue;
    }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const entries = Object.entries(value);
    if (entries.length > trainingFeedbackHttpLimits.objectKeys || entries.some(([key]) => key.length > trainingFeedbackHttpLimits.keyLength)) return false;
    pending.push(...entries.map(([, item]) => ({ value: item, depth: depth + 1 })));
  }
  return true;
}
const json = z.custom<JsonValue>(boundedJson);
const reported = z.custom<Exclude<JsonValue, null>>((value): value is Exclude<JsonValue, null> => value !== null && boundedJson(value));
const scope: z.ZodType<FeedbackScope> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), contextId: id, sessionId: id, planId: id.nullable() }).strict(),
  z.object({ kind: z.literal('plan'), contextId: id, planId: id }).strict(),
  z.object({ kind: z.literal('context'), contextId: id }).strict(),
]);
const selection = z.object({ sessionId: id, occurrenceId: id }).strict().nullable();
const reference = z.object({ sourceId: text(), revision: text(), locator: text(), qualification: text() }).strict();
const dimension = z.enum(['rir', 'effort', 'discomfort', 'weakness', 'function', 'performance', 'sensation', 'soreness']);
const signal = z.discriminatedUnion('state', [
  z.object({ dimension, state: z.literal('reported'), value: reported, unit: text().nullable(), scale: text().nullable() }).strict(),
  z.object({ dimension, state: z.literal('missing'), reason: z.enum(['not-asked', 'not-reported', 'unknown', 'declined']) }).strict(),
]);
const content: z.ZodType<FeedbackContent> = z.object({ scope,
  sourceRefs: z.array(reference).min(1).max(trainingFeedbackHttpLimits.sourceRefs),
  qualifications: z.array(text()).min(1).max(trainingFeedbackHttpLimits.qualifications),
  payload: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('feedback'), signals: z.array(signal).min(1).max(trainingFeedbackHttpLimits.signals) }).strict(),
    z.object({ kind: z.literal('edit'), field: text(), before: json, after: json }).strict(),
  ]),
}).strict();
const witness: z.ZodType<FeedbackContextWitness> = z.object({ contextId: id, profileRevision: revision, preferencesRevision: revision,
  sessionSource: z.object({
    source: z.object({ accountId: id, kind: z.literal('session'), id, revision: revision.min(1), itemId: id }).strict(),
    sessionStatus: z.enum(['active', 'completed']),
    planSnapshot: z.object({ planId: id, planRevision: revision.min(1) }).strict(),
    occurrence: z.object({ id, itemId: id, exerciseId: id }).strict(),
    sets: z.array(z.object({ id, revision: revision.min(1), status: z.enum(['draft', 'confirmed', 'voided']) }).strict())
      .max(trainingFeedbackHttpLimits.sets).refine(sets => new Set(sets.map(set => set.id)).size === sets.length),
  }).strict().nullable(),
  targetPlan: z.object({ id, revision: revision.min(1), archived: z.boolean() }).strict().nullable(),
}).strict();
type ClientEvent = NonDeletionEvent extends infer Event ? Event extends NonDeletionEvent ? Omit<Event, 'accountId'> : never : never;
export type TrainingFeedbackEventRequest = Omit<FeedbackCommand, 'idempotencyKey' | 'event'> & { event: ClientEvent };
const identity = { eventId: id, recordId: id, expectedRevision: revision };
const event = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('record'), content }).strict(),
  z.object({ ...identity, kind: z.literal('correct'), content }).strict(),
  z.object({ ...identity, kind: z.literal('confirm') }).strict(),
  z.object({ ...identity, kind: z.literal('withdraw') }).strict(),
  z.object({ ...identity, kind: z.literal('undo'), targetEventId: id }).strict(),
]);
const witnessRequest: z.ZodType<FeedbackWitnessRequest> = z.object({ scope, selection }).strict();
const eventRequest: z.ZodType<TrainingFeedbackEventRequest> = z.object({ expectedLedgerRevision: revision,
  event, selection, expectedWitness: witness.nullable() }).strict();
const key = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError(422, 'training_feedback_invalid_request');
  return result.data;
}
export const parseTrainingFeedbackWitnessRequest = (value: unknown): FeedbackWitnessRequest => parse(witnessRequest, value);
export const parseTrainingFeedbackEventRequest = (value: unknown): TrainingFeedbackEventRequest => parse(eventRequest, value);
export function parseTrainingFeedbackIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value === '') throw new DomainError(400, 'idempotency_key_required');
  return parse(key, value);
}
