import { createHash } from 'node:crypto';
import type { Domain } from '../domain.js';
import type { ActivityEntry } from '../activity/types.js';
import type { ExerciseRef, Load } from '../activity/schemas.js';
import type { AccountContext } from '../lifecycle/types.js';

export type SourceRef = Readonly<{
  accountId: string; kind: 'session' | 'activity'; id: string; revision: number; itemId: string;
}>;
export type ComparisonIdentity = Readonly<{
  variantId: string;
  equipmentId: string;
  laterality: 'bilateral' | 'left' | 'right' | 'alternating';
  loadBasis: Exclude<Extract<Load, { state: 'knownValue' }>['basis'], 'unspecified'>;
}>;
// Trusted integration supplies explicit performed identity; catalog labels and targets cannot fill these fields.
export type IdentityBinding = Readonly<{
  source: SourceRef; confirmed: true; revision: number; identity: ComparisonIdentity;
}>;
type SetWork = { id: string; repetitions: number | undefined; load: Load };
export type WorkObservation = Readonly<{
  source: SourceRef; exercise: ExerciseRef | null; binding: IdentityBinding | null;
  state: 'confirmed' | 'unconfirmed' | 'missing'; sets: readonly SetWork[];
}>;
type Summary = {
  confirmedSets: number; repetitions: number; volumeKgRepetitions: number | null;
  loads: readonly { setId: string; repetitions: number; kg: number | null }[];
};
type Reason = 'source_missing' | 'work_unconfirmed' | 'no_confirmed_sets' | 'identity_unknown' |
  'identity_stale' | 'invalid_work' | 'repetitions_unknown' | 'load_unknown' | 'load_basis_unknown' |
  'mixed_load_meaning' | 'account_mismatch' | 'exercise_mismatch' | 'variant_mismatch' |
  'equipment_mismatch' | 'laterality_mismatch' | 'load_basis_mismatch' | 'load_meaning_mismatch' | 'same_observation';
type BaseResult = { policy: 'confirmed-work-comparison-v1'; evidenceToken: string };
export type ComparisonResult = BaseResult & (
  { status: 'unknown' | 'incomparable'; reasons: readonly Reason[] } |
  { status: 'comparable'; baseline: Summary; current: Summary;
    delta: { confirmedSets: number; repetitions: number; volumeKgRepetitions: number | null };
    units: { load: 'kg'; volume: 'kg-repetitions' }; interpretation: 'observed_work_only' }
);

const sameRef = (a: SourceRef, b: SourceRef) => a.accountId === b.accountId && a.kind === b.kind &&
  a.id === b.id && a.revision === b.revision && a.itemId === b.itemId;
const validText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validRevision = (value: number) => Number.isSafeInteger(value) && value >= 1;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === 'object' && !Array.isArray(item))
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  return item;
});

export function sessionObservation(accountId: string, session: ReturnType<Domain['session']>, occurrenceId: string,
  binding: IdentityBinding | null = null): WorkObservation {
  const occurrence = session.occurrences.find(item => item.id === occurrenceId);
  return {
    source: { accountId, kind: 'session', id: session.id, revision: session.revision, itemId: occurrenceId },
    exercise: occurrence ? { source: 'global', id: occurrence.exerciseId } : null,
    binding, state: occurrence ? 'confirmed' : 'missing',
    sets: session.sets.filter(set => set.occurrenceId === occurrenceId && set.status === 'confirmed')
      .sort((a, b) => a.setNumber - b.setNumber || a.id.localeCompare(b.id))
      .map((set): SetWork => 'schema' in set
        ? { id: set.id, repetitions: set.performance.kind === 'repetitions' ? set.performance.reps : undefined,
          load: set.performance.schema === 'form.source-performance/v2' ? set.performance.load : { state: 'unknown', confirmed: true } }
        : ({ id: set.id, repetitions: set.reps, load: { state: 'knownValue', value: set.weightKg,
        unit: 'kg', basis: binding?.identity.loadBasis ?? 'unspecified' } })),
  };
}

export function activityObservation(accountId: string, entry: ActivityEntry, itemId: string,
  binding: IdentityBinding | null = null): WorkObservation {
  const item = entry.items.find(item => item.id === itemId);
  return {
    source: { accountId, kind: 'activity', id: entry.id, revision: entry.revision, itemId },
    exercise: item?.exercise ?? null, binding,
    state: !item ? 'missing' : entry.status === 'recorded' && entry.performedConfirmed === true ? 'confirmed' : 'unconfirmed',
    sets: (item?.sets ?? []).map(set => ({ id: set.id, repetitions: set.repetitions, load: set.load })),
  };
}

type Qualified = { status: 'ready'; summary: Summary; meaning: string } | { status: 'unknown'; reason: Reason };
function qualify(work: WorkObservation): Qualified {
  const unknown = (reason: Reason): Qualified => ({ status: 'unknown', reason });
  if (work.state === 'missing' || !work.exercise) return unknown('source_missing');
  if (work.state !== 'confirmed') return unknown('work_unconfirmed');
  if (!work.sets.length) return unknown('no_confirmed_sets');
  const binding = work.binding;
  if (!binding || binding.confirmed !== true || !validRevision(binding.revision) ||
    !validText(binding.identity.variantId) || !validText(binding.identity.equipmentId) ||
    !['bilateral', 'left', 'right', 'alternating'].includes(binding.identity.laterality) ||
    !['total', 'perImplement', 'perSide', 'assistance'].includes(binding.identity.loadBasis)) return unknown('identity_unknown');
  if (!sameRef(work.source, binding.source)) return unknown('identity_stale');
  if (!validRevision(work.source.revision) || !validText(work.source.accountId) || !validText(work.exercise.id) ||
    (work.exercise.source === 'personal' && !validRevision(work.exercise.revision))) return unknown('invalid_work');
  if (new Set(work.sets.map(set => set.id)).size !== work.sets.length) return unknown('invalid_work');
  const loads: { setId: string; repetitions: number; kg: number | null }[] = [];
  const meanings = new Set<string>();
  for (const set of work.sets) {
    if (set.repetitions === undefined) return unknown('repetitions_unknown');
    if (!validText(set.id) || !Number.isSafeInteger(set.repetitions) || set.repetitions < 1) return unknown('invalid_work');
    const load = set.load;
    if (load.state === 'unknown') return unknown('load_unknown');
    if (load.state === 'knownValue') {
      if (load.basis === 'unspecified') return unknown('load_basis_unknown');
      if (load.basis !== binding.identity.loadBasis) return unknown('load_basis_mismatch');
      if (!['kg', 'lb'].includes(load.unit) || !Number.isFinite(load.value) || load.value < 0) return unknown('invalid_work');
      const kg = load.value * (load.unit === 'lb' ? 0.45359237 : 1);
      if (!Number.isFinite(kg * set.repetitions)) return unknown('invalid_work');
      meanings.add('external_load');
      loads.push({ setId: set.id, repetitions: set.repetitions, kg });
    } else if (load.state === 'notApplicable' && ['bodyweight', 'unloaded', 'timedActivity'].includes(load.reason)) {
      meanings.add(load.reason);
      loads.push({ setId: set.id, repetitions: set.repetitions, kg: null });
    } else return unknown('invalid_work');
  }
  if (meanings.size !== 1) return unknown('mixed_load_meaning');
  const meaning = [...meanings][0]!;
  const repetitions = loads.reduce((sum, set) => sum + set.repetitions, 0);
  const volume = meaning === 'external_load' ? loads.reduce((sum, set) => sum + set.repetitions * set.kg!, 0) : null;
  if (!Number.isSafeInteger(repetitions) || (volume !== null && !Number.isFinite(volume))) return unknown('invalid_work');
  return { status: 'ready', meaning, summary: { confirmedSets: loads.length, repetitions, volumeKgRepetitions: volume, loads } };
}

export function compareWork(baseline: WorkObservation, current: WorkObservation): ComparisonResult {
  const base: BaseResult = { policy: 'confirmed-work-comparison-v1', evidenceToken:
    createHash('sha256').update(canonical({ policy: 'confirmed-work-comparison-v1', baseline, current })).digest('hex') };
  if (baseline.source.accountId !== current.source.accountId) return { ...base, status: 'incomparable', reasons: ['account_mismatch'] };
  const first = qualify(baseline), second = qualify(current);
  if (first.status !== 'ready' || second.status !== 'ready') return { ...base, status: 'unknown', reasons:
    [...new Set([...(first.status === 'unknown' ? [first.reason] : []), ...(second.status === 'unknown' ? [second.reason] : [])])] };
  const reasons: Reason[] = [];
  if (baseline.source.kind === current.source.kind && baseline.source.id === current.source.id &&
    baseline.source.itemId === current.source.itemId) reasons.push('same_observation');
  if (canonical(baseline.exercise) !== canonical(current.exercise)) reasons.push('exercise_mismatch');
  const a = baseline.binding!.identity, b = current.binding!.identity;
  if (a.variantId !== b.variantId) reasons.push('variant_mismatch');
  if (a.equipmentId !== b.equipmentId) reasons.push('equipment_mismatch');
  if (a.laterality !== b.laterality) reasons.push('laterality_mismatch');
  if (a.loadBasis !== b.loadBasis) reasons.push('load_basis_mismatch');
  if (first.meaning !== second.meaning) reasons.push('load_meaning_mismatch');
  if (reasons.length) return { ...base, status: 'incomparable', reasons };
  return { ...base, status: 'comparable', baseline: first.summary, current: second.summary,
    delta: { confirmedSets: second.summary.confirmedSets - first.summary.confirmedSets,
      repetitions: second.summary.repetitions - first.summary.repetitions,
      volumeKgRepetitions: first.summary.volumeKgRepetitions === null || second.summary.volumeKgRepetitions === null ? null :
        second.summary.volumeKgRepetitions - first.summary.volumeKgRepetitions },
    units: { load: 'kg', volume: 'kg-repetitions' }, interpretation: 'observed_work_only' };
}

export function revalidateComparison(previousToken: string, baseline: WorkObservation, current: WorkObservation) {
  const result = compareWork(baseline, current);
  return { status: previousToken === result.evidenceToken ? 'current' as const : 'invalidated' as const, result };
}

export type SessionSelection = Readonly<{ sessionId: string; occurrenceId: string }>;
export type ProgressReaderDependencies = Readonly<{
  domain: Pick<Domain, 'session'>;
  // Integration must recheck authentication/lifecycle and read both sources + bindings in one synchronous DB snapshot.
  withReadSnapshot: <T>(context: AccountContext, read: () => T) => T;
  identityFor: (source: SourceRef) => IdentityBinding | null;
}>;
export function createProgressComparisonReader(deps: ProgressReaderDependencies) {
  return {
    compare(context: AccountContext, baseline: SessionSelection, current: SessionSelection, previousToken?: string) {
      return deps.withReadSnapshot(context, () => {
        const read = (selection: SessionSelection) => {
          const session = deps.domain.session(context.accountId, selection.sessionId);
          const observed = sessionObservation(context.accountId, session, selection.occurrenceId);
          return sessionObservation(context.accountId, session, selection.occurrenceId, deps.identityFor(observed.source));
        };
        const a = read(baseline), b = read(current);
        const result = compareWork(a, b);
        return { freshness: previousToken === undefined ? 'unchecked' as const :
          previousToken === result.evidenceToken ? 'current' as const : 'invalidated' as const, result };
      });
    },
  };
}
