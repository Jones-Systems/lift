import { ApiError } from './transport';
import { decodeSourcePerformance, decodePlan, decodeWorkoutSession, decodePerformedSet, decodeSetReceipt, decodeHistory, decodeStats } from './trainingCodec';
import type { SourcePerformance, SourceSetCreate, SourceSetPatch, SourcePerformedSet, StoredPlan, StoredWorkoutSession } from './domain';

type WithoutExpectedRevision<T> = T extends unknown ? Omit<T, 'expectedRevision'> : never;
export type SourceSetDraft = WithoutExpectedRevision<SourceSetCreate>;
export type SourceSetChanges = WithoutExpectedRevision<SourceSetPatch>;
type SessionIdentity = Pick<StoredWorkoutSession, 'id' | 'revision'>;
type GuardedRequest = (path: string, method?: string, body?: unknown, key?: string) => Promise<unknown>;
const badInput = (): never => { throw new ApiError(422, 'invalid_source_training_command', 'Check the original training command.'); };
const badReceipt = (): never => { throw new ApiError(502, 'training_response_invalid', 'The training result could not be verified. Keep the original command before retrying.', true); };

/** Read data properties only: caller accessors must not run while capturing a retry intent. */
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return badInput();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return badInput();
  const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) return badInput();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return badInput();
    result[key] = descriptor.value;
  }
  if (keys && (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key)))) return badInput();
  return result;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) return badInput();
  return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return badInput();
  return value;
}
function identity(value: SessionIdentity): SessionIdentity {
  const row = record(value);
  return Object.freeze({ id: id(row.id), revision: integer(row.revision) });
}
function changes(value: unknown): SourceSetChanges {
  const row = record(value, ['schema', 'status', 'performance']);
  if (!['form.source-performed-set/v1', 'form.source-performed-set/v2'].includes(row.schema as string)
      || (row.status !== 'draft' && row.status !== 'confirmed')) return badInput();
  const p = record(row.performance);
  const version = row.schema === 'form.source-performed-set/v1' ? 'form.source-performance/v1' : 'form.source-performance/v2';
  if (p.schema !== version) return badInput();
  // Canonicalize omission before detaching/freezing the intent and before the request fingerprint is formed.
  if (version === 'form.source-performance/v2' && !Object.hasOwn(p, 'load')) p.load = { state: 'unknown', confirmed: true };
  let performance: SourcePerformance;
  try { performance = decodeSourcePerformance(p); } catch { return badInput(); }
  if (row.status === 'confirmed' && performance.kind === 'repetitions' && performance.reps === 0) return badInput();
  return performance.schema === 'form.source-performance/v1'
    ? Object.freeze({ schema: 'form.source-performed-set/v1', status: row.status, performance })
    : Object.freeze({ schema: 'form.source-performed-set/v2', status: row.status, performance });
}
export function captureSourceSetDraft(value: SourceSetDraft): SourceSetDraft {
  const row = record(value, ['schema', 'status', 'performance', 'occurrenceId', 'setNumber']);
  return Object.freeze({ ...changes({ schema: row.schema, status: row.status, performance: row.performance }),
    occurrenceId: id(row.occurrenceId), setNumber: integer(row.setNumber, 1, 100) });
}
export const captureSourceSetChanges = (value: SourceSetChanges): SourceSetChanges => changes(value);
function sourceSet(value: unknown, input = false): SourcePerformedSet {
  let set: ReturnType<typeof decodePerformedSet>;
  try { set = decodePerformedSet(value); }
  catch (error) { if (input) return badInput(); throw error; }
  if (!('schema' in set)) return input ? badInput() : badReceipt();
  return set;
}
function samePerformance(a: SourcePerformance, b: SourcePerformance): boolean {
  return a.schema === b.schema && a.kind === b.kind && JSON.stringify(a.load) === JSON.stringify(b.load)
    && (a.kind === 'controlled-practice' || (b.kind === 'repetitions' && a.reps === b.reps));
}
function key(value: string): string {
  if (typeof value !== 'string' || !value.length) return badInput();
  return value;
}

/** Only FormResources supplies this closure; it retains the original bound auth and session guards. */
export function createSourceTrainingResources(request: GuardedRequest, assertCurrent: (write: boolean) => void) {
  const send = async <T,>(path: string, method: string, body: unknown, commandKey: string, decode: (value: unknown) => T): Promise<T> => {
    assertCurrent(false);
    let value: unknown;
    try { value = await request(path, method, body, commandKey); }
    catch (error) { assertCurrent(true); throw error; }
    assertCurrent(true);
    const result = decode(value);
    assertCurrent(true);
    return result;
  };
  const read = async <T,>(path: string, decode: (value: unknown) => T): Promise<T> => {
    assertCurrent(false);
    const value = await request(path);
    assertCurrent(false);
    let result: T;
    try { result = decode(value); }
    catch { throw new ApiError(502, 'training_response_invalid', 'The training readback could not be verified.'); }
    assertCurrent(false);
    return result;
  };
  return Object.freeze({
    plans: () => read('/v1/plans', value => {
      const row = record(value, ['items']);
      if (!Array.isArray(row.items)) return badInput();
      const entries = Object.getOwnPropertyDescriptors(row.items);
      if (Reflect.ownKeys(entries).length !== row.items.length + 1) return badInput();
      const items: StoredPlan[] = [];
      for (let i = 0; i < row.items.length; i++) {
        const entry = entries[String(i)];
        if (!entry || !Object.hasOwn(entry, 'value') || !entry.enumerable) return badInput();
        items.push(decodePlan(entry.value));
      }
      if (new Set(items.map(item => item.id)).size !== items.length) return badInput();
      return { items };
    }),
    startWorkout: async (plan: StoredPlan, commandKey: string) => {
      let captured: StoredPlan;
      try { captured = decodePlan(plan); }
      catch { return badInput(); }
      if (captured.archived) return badInput();
      const body = Object.freeze({ planId: captured.id, expectedPlanRevision: captured.revision });
      const session = await send('/v1/workout-sessions', 'POST', body, key(commandKey), decodeWorkoutSession);
      if (session.status !== 'active' || session.planId !== captured.id || session.planRevision !== captured.revision
        || JSON.stringify(session.planSnapshot) !== JSON.stringify(captured)) return badReceipt();
      assertCurrent(true);
      return session;
    },
    workout: (sessionId: string) => {
      const requested = id(sessionId);
      return read(`/v1/workout-sessions/${requested}`, value => {
        const result = decodeWorkoutSession(value);
        if (result.id !== requested) return badReceipt();
        return result;
      });
    },
    addSet: async (session: SessionIdentity, draft: SourceSetDraft, commandKey: string) => {
      const owner = identity(session), captured = captureSourceSetDraft(draft);
      const body = Object.freeze({ ...captured, expectedRevision: owner.revision });
      const result = await send(`/v1/workout-sessions/${owner.id}/sets`, 'POST', body, key(commandKey), decodeSetReceipt);
      const set = sourceSet(result.set);
      if (set.occurrenceId !== captured.occurrenceId || set.setNumber !== captured.setNumber || set.revision !== 1
        || set.status !== captured.status || !samePerformance(set.performance, captured.performance)
        || result.sessionRevision <= owner.revision) return badReceipt();
      assertCurrent(true);
      return { set, sessionRevision: result.sessionRevision };
    },
    editSet: async (sessionId: string, current: SourcePerformedSet, patch: SourceSetChanges, commandKey: string) => {
      const owner = id(sessionId), before = sourceSet(current, true), captured = captureSourceSetChanges(patch);
      if (before.schema === 'form.source-performed-set/v2' && captured.schema !== before.schema) return badInput();
      const body = Object.freeze({ ...captured, expectedRevision: before.revision });
      const result = await send(`/v1/workout-sessions/${owner}/sets/${before.id}`, 'PATCH', body, key(commandKey), decodeSetReceipt);
      const set = sourceSet(result.set);
      if (set.id !== before.id || set.occurrenceId !== before.occurrenceId || set.setNumber !== before.setNumber
        || set.revision !== before.revision + 1 || set.status !== captured.status || !samePerformance(set.performance, captured.performance)) return badReceipt();
      assertCurrent(true);
      return { set, sessionRevision: result.sessionRevision };
    },
    voidSet: async (sessionId: string, current: SourcePerformedSet, commandKey: string) => {
      const owner = id(sessionId), before = sourceSet(current, true), body = Object.freeze({ expectedRevision: before.revision });
      const result = await send(`/v1/workout-sessions/${owner}/sets/${before.id}/void`, 'POST', body, key(commandKey), decodeSetReceipt);
      const set = sourceSet(result.set);
      if (set.id !== before.id || set.occurrenceId !== before.occurrenceId || set.setNumber !== before.setNumber
        || set.revision !== before.revision + 1 || set.status !== 'voided' || !samePerformance(set.performance, before.performance)) return badReceipt();
      assertCurrent(true);
      return { set, sessionRevision: result.sessionRevision };
    },
    completeWorkout: async (session: SessionIdentity, commandKey: string) => {
      const before = identity(session), body = Object.freeze({ expectedRevision: before.revision });
      const result = await send(`/v1/workout-sessions/${before.id}/complete`, 'POST', body, key(commandKey), decodeWorkoutSession);
      if (result.id !== before.id || result.status !== 'completed' || result.revision <= before.revision) return badReceipt();
      assertCurrent(true);
      return result;
    },
    history: (before?: string) => {
      if (before !== undefined && (typeof before !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(before))) return badInput();
      return read(`/v1/history${before === undefined ? '' : `?before=${encodeURIComponent(before)}`}`, decodeHistory);
    },
    stats: () => read('/v1/stats', decodeStats),
  });
}
export type SourceTrainingResources = ReturnType<typeof createSourceTrainingResources>;
