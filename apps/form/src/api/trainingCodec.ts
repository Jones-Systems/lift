import { ApiError } from './transport';
import type {
  PlanItem, NativePrescription, SourcePrescriptionItem, SourceUnknownLoad, SourcePerformance, SourceReportedLoad,
  StoredPlan, SavedSet, StoredSetReceipt, StoredWorkoutSession, StoredHistory, StoredStats,
  SourceStatsMetrics, StoredExerciseStats,
} from './domain';

const invalid = (): never => { throw new Error('invalid_training_value'); };
const has = (row: Record<string, unknown>, key: string): boolean => Object.hasOwn(row, key);
function data(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return invalid();
    return value;
  }
  if (ancestors.has(value)) return invalid();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) return invalid();
    for (const descriptor of Object.values(descriptors)) if (!Object.hasOwn(descriptor, 'value')) return invalid();
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Object.keys(descriptors).length !== length + 1) return invalid();
      const result: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !descriptor.enumerable) return invalid();
        result.push(data(descriptor.value, ancestors));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) return invalid();
      result[key] = data(descriptor.value, ancestors);
    }
    return result;
  } finally { ancestors.delete(value); }
}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>, keys = Object.keys(row);
  if (required.some(key => !has(row, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return row;
}
function num(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) return invalid();
  return value;
}
function text(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) return invalid();
  return value;
}
function id(value: unknown): string {
  const result = text(value, 1, 80);
  return /^[A-Za-z0-9_-]+$/.test(result) ? result : invalid();
}
function reference(value: unknown): string {
  const result = text(value, 1, 512);
  return result === result.trim() && !/[\u0000-\u001f\u007f]/u.test(result) ? result : invalid();
}
function digest(value: unknown): string {
  const result = text(value, 64, 64);
  return /^[a-f0-9]{64}$/.test(result) ? result : invalid();
}
function nonblank(value: unknown, max: number): string {
  const result = text(value, 1, max);
  return result.trim().length ? result : invalid();
}
function instant(value: unknown): string {
  const result = text(value, 1, Number.MAX_SAFE_INTEGER);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/.test(result)) return invalid();
  const date = new Date(result);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result.slice(0, 10) ? result : invalid();
}
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function literal<T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : invalid();
}
function array<T>(value: unknown, parse: (item: unknown) => T, min = 0, max = Number.MAX_SAFE_INTEGER): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid();
  return value.map(parse);
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) return invalid();
  return items;
}
function load(value: unknown): SourceUnknownLoad {
  const row = object(value, ['kind', 'basis']);
  return { kind: literal(row.kind, ['unspecified']), basis: literal(row.basis, ['unknown']) };
}
function native(value: unknown): NativePrescription {
  const row = object(value, ['exercise_id', 'movement_pattern', 'role', 'sets', 'rest_seconds'],
    ['rep_range', 'target_rir', 'substituted_for', 'notes']);
  const result: NativePrescription = {
    exercise_id: id(row.exercise_id), movement_pattern: nonblank(row.movement_pattern, 200),
    role: nonblank(row.role, 200), sets: num(row.sets, 1, 20), rest_seconds: num(row.rest_seconds, 0, 10800),
  };
  if (has(row, 'rep_range')) {
    const range = array(row.rep_range, value => num(value, 1, 100), 2, 2);
    if (range[0] > range[1]) return invalid();
    result.rep_range = [range[0], range[1]];
  }
  if (has(row, 'target_rir')) result.target_rir = num(row.target_rir, 0, 100);
  if (has(row, 'substituted_for')) result.substituted_for = id(row.substituted_for);
  if (has(row, 'notes')) result.notes = array(row.notes, value => text(value, 0, 4000), 1, 30);
  return result;
}
function sourceItem(value: unknown): SourcePrescriptionItem {
  const row = object(value, ['id', 'native', 'registeredDomain', 'load']);
  const domain = object(row.registeredDomain, ['exerciseId', 'variantId', 'identity', 'registration', 'recordDigest']);
  const identity = object(domain.identity, ['repository', 'revision', 'path', 'sha256', 'nativeId']);
  const pin = object(domain.registration, ['id', 'revision', 'digest', 'bytes']);
  const result: SourcePrescriptionItem = {
    id: id(row.id), native: native(row.native), load: load(row.load),
    registeredDomain: {
      exerciseId: id(domain.exerciseId), variantId: reference(domain.variantId), recordDigest: digest(domain.recordDigest),
      identity: { repository: reference(identity.repository), revision: reference(identity.revision), path: reference(identity.path),
        sha256: digest(identity.sha256), nativeId: id(identity.nativeId) },
      registration: { id: reference(pin.id), revision: reference(pin.revision), digest: digest(pin.digest), bytes: num(pin.bytes, 1) },
    },
  };
  if (result.native.exercise_id !== result.registeredDomain.identity.nativeId) return invalid();
  return result;
}
function legacyItem(value: unknown): PlanItem {
  const row = object(value, ['id', 'exerciseId', 'setTarget', 'repMin', 'repMax', 'targetKg']);
  const result = { id: id(row.id), exerciseId: id(row.exerciseId), setTarget: num(row.setTarget, 1, 20),
    repMin: num(row.repMin, 1, 100), repMax: num(row.repMax, 1, 100), targetKg: num(row.targetKg, 0, 500, false) };
  return result.repMin <= result.repMax ? result : invalid();
}
function plan(value: unknown): StoredPlan {
  const base = ['id', 'revision', 'archived', 'createdAt', 'updatedAt', 'name', 'items'];
  const probe = object(value, base, ['schema', 'origin', 'duration', 'minutes']);
  const source = has(probe, 'schema');
  const row = object(probe, [...base, ...(source ? ['schema', 'origin', 'duration'] : ['minutes'])]);
  const name = text(row.name, 1, Number.MAX_SAFE_INTEGER).trim();
  nonblank(name, 100);
  const metadata = { id: id(row.id), revision: num(row.revision), archived: bool(row.archived),
    createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt), name };
  if (!source) return { ...metadata, minutes: num(row.minutes, 5, 180), items: unique(array(row.items, legacyItem, 1, 50), item => item.id) };
  const origin = object(row.origin, ['kind', 'id', 'revision']), duration = object(row.duration, ['kind', 'minMinutes', 'maxMinutes']);
  const range = { kind: literal(duration.kind, ['estimated-range']), minMinutes: num(duration.minMinutes, 5, 180), maxMinutes: num(duration.maxMinutes, 5, 180) };
  if (range.minMinutes > range.maxMinutes) return invalid();
  return { ...metadata, schema: literal(row.schema, ['form.source-prescription-plan/v1']),
    origin: { kind: literal(origin.kind, ['form-adaptation']), id: reference(origin.id), revision: reference(origin.revision) },
    duration: range, items: unique(array(row.items, sourceItem, 1, 50), item => item.id) };
}
function reportedLoad(value: unknown): SourceReportedLoad {
  const probe = object(value, ['state'], ['value', 'unit', 'basis', 'confirmed', 'reason']);
  if (probe.state === 'knownValue') {
    const row = object(probe, ['state', 'value', 'unit', 'basis']);
    const unit = literal(row.unit, ['kg', 'lb']), value = num(row.value, 0, Number.MAX_VALUE, false);
    if (value * (unit === 'lb' ? 0.45359237 : 1) > 500) return invalid();
    return Object.freeze({ state: 'knownValue', value, unit,
      basis: literal(row.basis, ['total', 'perImplement', 'perSide', 'assistance']) });
  }
  if (probe.state === 'unknown') {
    const row = object(probe, ['state', 'confirmed']);
    if (row.confirmed !== true) return invalid();
    return Object.freeze({ state: 'unknown', confirmed: true });
  }
  const row = object(probe, ['state', 'reason']);
  return Object.freeze({ state: literal(row.state, ['notApplicable']), reason: literal(row.reason, ['bodyweight', 'unloaded', 'timedActivity']) });
}
function performance(value: unknown): SourcePerformance {
  const probe = object(value, ['schema', 'kind', 'load'], ['reps']);
  const schema = literal(probe.schema, ['form.source-performance/v1', 'form.source-performance/v2']);
  const repetitions = probe.kind === 'repetitions';
  object(probe, repetitions ? ['schema', 'kind', 'load', 'reps'] : ['schema', 'kind', 'load']);
  if (schema === 'form.source-performance/v1') {
    const unknownLoad = Object.freeze(load(probe.load));
    return repetitions ? Object.freeze({ schema, kind: 'repetitions', load: unknownLoad, reps: num(probe.reps, 0, 100) })
      : Object.freeze({ schema, kind: literal(probe.kind, ['controlled-practice']), load: unknownLoad });
  }
  const captured = reportedLoad(probe.load);
  return repetitions ? Object.freeze({ schema, kind: 'repetitions', load: captured, reps: num(probe.reps, 0, 100) })
    : Object.freeze({ schema, kind: literal(probe.kind, ['controlled-practice']), load: captured });
}
function set(value: unknown): SavedSet {
  const base = ['id', 'occurrenceId', 'setNumber', 'revision', 'status', 'createdAt', 'updatedAt'];
  const probe = object(value, base, ['schema', 'performance', 'reps', 'weightKg']), source = has(probe, 'schema');
  const row = object(probe, [...base, ...(source ? ['schema', 'performance'] : ['reps', 'weightKg'])]);
  const metadata = { id: id(row.id), occurrenceId: id(row.occurrenceId), setNumber: num(row.setNumber, 1, 100), revision: num(row.revision),
    status: literal(row.status, ['draft', 'confirmed', 'voided']), createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt) };
  if (source) {
    const schema = literal(row.schema, ['form.source-performed-set/v1', 'form.source-performed-set/v2']), parsed = performance(row.performance);
    if (schema !== (parsed.schema === 'form.source-performance/v1' ? 'form.source-performed-set/v1' : 'form.source-performed-set/v2')) return invalid();
    if (metadata.status === 'confirmed' && parsed.kind === 'repetitions' && parsed.reps === 0) return invalid();
    return parsed.schema === 'form.source-performance/v1'
      ? Object.freeze({ ...metadata, schema: 'form.source-performed-set/v1', performance: parsed })
      : Object.freeze({ ...metadata, schema: 'form.source-performed-set/v2', performance: parsed });
  }
  const reps = num(row.reps, 0, 100);
  if (metadata.status === 'confirmed' && reps === 0) return invalid();
  return { ...metadata, reps, weightKg: num(row.weightKg, 0, 500, false) };
}
function session(value: unknown): StoredWorkoutSession {
  const row = object(value, ['id', 'planId', 'planRevision', 'revision', 'status', 'planSnapshot', 'occurrences', 'sets', 'startedAt', 'completedAt']);
  const snapshot = plan(row.planSnapshot);
  const metadata = { id: id(row.id), planId: id(row.planId), planRevision: num(row.planRevision), revision: num(row.revision),
    status: literal(row.status, ['active', 'completed']), startedAt: instant(row.startedAt), completedAt: row.completedAt === null ? null : instant(row.completedAt) };
  if (metadata.planId !== snapshot.id || metadata.planRevision !== snapshot.revision ||
    (metadata.status === 'active') !== (metadata.completedAt === null)) return invalid();
  const rows = array(row.occurrences, value => object(value, ['id', 'itemId', 'exerciseId', 'position', 'target']), snapshot.items.length, snapshot.items.length);
  const occurrence = (entry: Record<string, unknown>, index: number) => {
    const result = { id: id(entry.id), itemId: id(entry.itemId), exerciseId: id(entry.exerciseId), position: num(entry.position) };
    if (result.position !== index || result.itemId !== snapshot.items[index].id) return invalid();
    return result;
  };
  const sets = unique(array(row.sets, set), item => item.id);
  unique(sets, item => item.occurrenceId + ':' + item.setNumber);
  if ('schema' in snapshot) {
    const occurrences = unique(rows.map((entry, index) => {
      const target = sourceItem(entry.target), result = { ...occurrence(entry, index), target };
      if (result.itemId !== target.id || result.exerciseId !== target.registeredDomain.exerciseId ||
        JSON.stringify(target) !== JSON.stringify(snapshot.items[index])) return invalid();
      return result;
    }), item => item.id);
    const sourceSets = sets.map(item => {
      if (!('schema' in item)) return invalid();
      const target = occurrences.find(occurrence => occurrence.id === item.occurrenceId)?.target;
      if (!target || item.performance.kind !== (target.native.rep_range === undefined ? 'controlled-practice' : 'repetitions')) return invalid();
      return item;
    });
    return { ...metadata, planSnapshot: snapshot, occurrences, sets: sourceSets };
  }
  const occurrences = unique(rows.map((entry, index) => {
    const target = legacyItem(entry.target), result = { ...occurrence(entry, index), target };
    if (result.itemId !== target.id || result.exerciseId !== target.exerciseId || JSON.stringify(target) !== JSON.stringify(snapshot.items[index])) return invalid();
    return result;
  }), item => item.id);
  const legacySets = sets.map(item => {
    if ('schema' in item || !occurrences.some(occurrence => occurrence.id === item.occurrenceId)) return invalid();
    return item;
  });
  return { ...metadata, planSnapshot: snapshot, occurrences, sets: legacySets };
}
function sourceMetrics(row: Record<string, unknown>): SourceStatsMetrics {
  const confirmedSets = num(row.confirmedSets, 1), coverage = object(row.coverage, ['repetitionSets', 'loadSets', 'practiceSets']);
  const counts = { repetitionSets: num(coverage.repetitionSets, 0, confirmedSets), loadSets: num(coverage.loadSets, 0, confirmedSets), practiceSets: num(coverage.practiceSets, 0, confirmedSets) };
  if (counts.repetitionSets + counts.practiceSets !== confirmedSets || counts.loadSets > counts.repetitionSets || counts.loadSets >= confirmedSets ||
    row.volumeKg !== null || row.maxWeightKg !== null) return invalid();
  const repetitions = counts.practiceSets === 0 ? num(row.repetitions, confirmedSets, confirmedSets * 100) : row.repetitions === null ? null : invalid();
  return { confirmedSets, repetitions, volumeKg: null, maxWeightKg: null, coverage: counts };
}
function exerciseStats(value: unknown): StoredExerciseStats {
  const row = object(value, ['exerciseId', 'confirmedSets', 'repetitions', 'volumeKg', 'maxWeightKg'], ['coverage']);
  const exerciseId = id(row.exerciseId);
  if (has(row, 'coverage')) return { exerciseId, ...sourceMetrics(row) };
  const confirmedSets = num(row.confirmedSets, 1);
  return { exerciseId, confirmedSets, repetitions: num(row.repetitions, confirmedSets, confirmedSets * 100),
    volumeKg: num(row.volumeKg, 0, confirmedSets * 50000, false), maxWeightKg: num(row.maxWeightKg, 0, 500, false) };
}
function stats(value: unknown): StoredStats {
  const base = ['confirmedSets', 'repetitions', 'volumeKg', 'completedSessions', 'byExercise', 'units', 'includesActiveConfirmedSets'];
  const probe = object(value, base, ['maxWeightKg', 'coverage']), source = has(probe, 'coverage');
  const row = object(probe, [...base, ...(source ? ['maxWeightKg', 'coverage'] : [])]);
  const units = object(row.units, ['load', 'volume']);
  if (row.includesActiveConfirmedSets !== true) return invalid();
  const byExercise = unique(array(row.byExercise, exerciseStats), item => item.exerciseId);
  const common = { completedSessions: num(row.completedSessions), units: { load: literal(units.load, ['kg']), volume: literal(units.volume, ['kg-repetitions']) }, includesActiveConfirmedSets: true };
  const confirmedSets = num(row.confirmedSets);
  if (byExercise.reduce((sum, item) => sum + item.confirmedSets, 0) !== confirmedSets) return invalid();
  if (source) {
    const metrics = sourceMetrics(row);
    const sums = byExercise.reduce((sum, item) => {
      const coverage = 'coverage' in item ? item.coverage : { repetitionSets: item.confirmedSets, loadSets: item.confirmedSets, practiceSets: 0 };
      return { repetitionSets: sum.repetitionSets + coverage.repetitionSets, loadSets: sum.loadSets + coverage.loadSets, practiceSets: sum.practiceSets + coverage.practiceSets };
    }, { repetitionSets: 0, loadSets: 0, practiceSets: 0 });
    if (!byExercise.some(item => 'coverage' in item) || JSON.stringify(sums) !== JSON.stringify(metrics.coverage) ||
      (metrics.repetitions !== null && byExercise.reduce((sum, item) => sum + (item.repetitions ?? 0), 0) !== metrics.repetitions)) return invalid();
    return { ...common, ...metrics, byExercise };
  }
  const legacy = byExercise.map(item => 'coverage' in item ? invalid() : item);
  const repetitions = num(row.repetitions, confirmedSets, confirmedSets * 100), volumeKg = num(row.volumeKg, 0, confirmedSets * 50000, false);
  if (legacy.reduce((sum, item) => sum + item.repetitions, 0) !== repetitions) return invalid();
  return { ...common, confirmedSets, repetitions, volumeKg, byExercise: legacy };
}
function decode<T>(value: unknown, parse: (value: unknown) => T): T {
  try { return parse(data(value)); }
  catch { throw new ApiError(0, 'training_response_invalid', 'The training response could not be verified. Keep the original command before retrying.', true); }
}
export const decodeSourcePerformance = (value: unknown): SourcePerformance => decode(value, performance);
export const decodePlan = (value: unknown): StoredPlan => decode(value, plan);
export const decodeWorkoutSession = (value: unknown): StoredWorkoutSession => decode(value, session);
export const decodePerformedSet = (value: unknown): SavedSet => decode(value, set);
export const decodeSetReceipt = (value: unknown): StoredSetReceipt => decode(value, value => {
  const row = object(value, ['set', 'sessionRevision']);
  return { set: set(row.set), sessionRevision: num(row.sessionRevision) };
});
export const decodeHistory = (value: unknown): StoredHistory => decode(value, value => {
  const row = object(value, ['items', 'nextBefore']);
  const nextBefore = row.nextBefore === null ? null : text(row.nextBefore, 1, 512);
  if (nextBefore !== null && !/^[A-Za-z0-9_-]+$/.test(nextBefore)) return invalid();
  return { items: unique(array(row.items, session), item => item.id), nextBefore };
});
export const decodeStats = (value: unknown): StoredStats => decode(value, stats);
