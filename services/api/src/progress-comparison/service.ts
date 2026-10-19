import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { DomainError, notFound, revision } from '../errors.js';
import { assertActive, withActiveWrite } from '../lifecycle/guards.js';
import type { AccountContext } from '../lifecycle/types.js';
import { canonical, command, hash, type CommandResult } from '../storage.js';
import { activityObservation, compareWork, sessionObservation, type ComparisonIdentity, type IdentityBinding, type SourceRef, type WorkObservation } from './index.js';
import type { ComparisonInputWitness, ComparisonRead, ComparisonSourceScope, ComparisonSelection, FreshComparisonWitness, ProgressComparisonDependencies, SourceSelection, StoredIdentity } from './persistence-types.js';
import * as schemas from './persistence-schemas.js';

type IdentityRow = { id: string; source_kind: SourceRef['kind']; source_id: string; item_id: string; source_revision: number;
  revision: number; status: 'confirmed' | 'withdrawn'; data: string | null; updated_at: string };
const synchronous = <T>(value: T): T => {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function')
    throw new DomainError(503, 'synchronous_progress_boundary_required');
  return value;
};
const sameSource = (a: SourceRef, b: SourceRef) => canonical(a) === canonical(b);
const completeIdentity = (identity: StoredIdentity['data']): ComparisonIdentity | null => {
  if (!identity || Object.values(identity.identity).some(value => value === null)) return null;
  return identity.identity as ComparisonIdentity;
};

export class ProgressComparisonService {
  constructor(readonly deps: ProgressComparisonDependencies) {
    if (deps.domain.db !== deps.db || !deps.assertIdentityAllowed || !deps.comparisonBindingFor || !deps.assertPersistable ||
      !deps.lifecycleControl?.assertSuppression || !deps.lifecycleControl.purgeReadiness)
      throw new DomainError(503, 'progress_bindings_required');
  }
  assertActive(context: AccountContext): void { assertActive(this.deps.db, context); }
  read<T>(context: AccountContext, effect: () => T): T {
    this.assertActive(context);
    const read = () => { this.assertActive(context); const result = synchronous(effect()); this.assertActive(context); return result; };
    return this.deps.db.inTransaction ? read() : this.deps.db.transaction(read).deferred();
  }
  private decode<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new DomainError(422, 'invalid_progress_request');
    return parsed.data;
  }
  private stored(accountId: string, selection: SourceSelection): StoredIdentity | null {
    const row = this.deps.db.prepare('SELECT * FROM progress_comparison_identities WHERE account_id=? AND source_kind=? AND source_id=? AND item_id=?')
      .get(accountId, selection.kind, selection.id, selection.itemId) as IdentityRow | undefined;
    if (!row) return null;
    let data: StoredIdentity['data'] = null;
    try {
      if (row.data !== null) data = schemas.storedIdentityData.parse(JSON.parse(row.data));
      if ((row.status === 'confirmed') !== (data !== null)) throw new Error('status');
    } catch { throw new DomainError(503, 'progress_identity_corrupt'); }
    return { id: row.id, source: { accountId, kind: row.source_kind, id: row.source_id, itemId: row.item_id, revision: row.source_revision },
      revision: row.revision, status: row.status, data, updatedAt: row.updated_at };
  }
  private sourceSnapshot(context: AccountContext, selection: SourceSelection): { work: WorkObservation; scope: ComparisonSourceScope } {
    if (selection.kind === 'session') {
      const session = this.deps.domain.session(context.accountId, selection.id);
      const occurrence = session.occurrences.find(item => item.id === selection.itemId);
      const work = sessionObservation(context.accountId, session, selection.itemId);
      return { work, scope: { source: { ...work.source, kind: 'session' }, exercise: work.exercise,
        session: { planId: session.planId, planRevision: session.planRevision,
          occurrence: occurrence ? { id: occurrence.id, itemId: occurrence.itemId, exerciseId: occurrence.exerciseId } : null } } };
    }
    if (!this.deps.activity) throw new DomainError(503, 'progress_activity_reader_unavailable');
    const entry = this.deps.activity.entry(context, selection.id), work = activityObservation(context.accountId, entry, selection.itemId);
    return { work, scope: { source: { ...work.source, kind: 'activity' }, exercise: work.exercise, session: null } };
  }
  private source(context: AccountContext, selection: SourceSelection): WorkObservation {
    return this.sourceSnapshot(context, selection).work;
  }
  private qualified(context: AccountContext, work: WorkObservation, record: StoredIdentity | null): IdentityBinding | null {
    if (!record || record.status !== 'confirmed' || !sameSource(record.source, work.source) ||
      canonical(record.data?.exercise) !== canonical(work.exercise)) return null;
    const identity = completeIdentity(record.data);
    if (!identity) return null;
    const expected: IdentityBinding = { source: work.source, revision: record.revision, confirmed: true, identity };
    const attested = synchronous(this.deps.comparisonBindingFor(context, structuredClone(record)));
    if (attested === null) return null;
    if (canonical(attested) !== canonical(expected)) throw new DomainError(503, 'progress_qualification_binding_mismatch');
    return expected;
  }
  private observe(context: AccountContext, selection: SourceSelection, snapshot = this.sourceSnapshot(context, selection)) {
    const { work, scope } = snapshot, record = this.stored(context.accountId, selection);
    const binding = this.qualified(context, work, record);
    // Legacy kg values carry no basis; only the independently attested performed identity can supply it.
    const observation = binding && selection.kind === 'session'
      ? { ...work, binding, sets: work.sets.map(set => ({ ...set, load: set.load.state === 'knownValue' && set.load.basis === 'unspecified' ? { ...set.load, basis: binding.identity.loadBasis } : set.load })) }
      : { ...work, binding };
    const current = !!record && sameSource(record.source, work.source) && canonical(record.data?.exercise) === canonical(work.exercise);
    const input: ComparisonInputWitness = { scope, identity: { id: record?.id ?? null, revision: record?.revision ?? null,
      status: record?.status ?? 'missing', current, state: !record ? 'missing' : record.status === 'withdrawn' ? 'withdrawn' :
        !current ? 'stale' : !binding ? 'unqualified' : 'qualified' } };
    return { observation, record, input };
  }
  identity(context: AccountContext, raw: unknown): StoredIdentity | null {
    const selection = this.decode(schemas.sourceSelection, raw);
    return this.read(context, () => this.stored(context.accountId, selection));
  }
  confirm(context: AccountContext, key: string | undefined, raw: unknown): CommandResult {
    const input = this.decode(schemas.confirmIdentity, raw);
    this.assertActive(context); synchronous(this.deps.assertPersistable(context, 'confirm', input));
    return withActiveWrite(this.deps.db, context, () => command(this.deps.db, context.accountId, 'progressComparison.confirm', key, input,
      () => { this.assertActive(context); synchronous(this.deps.assertPersistable(context, 'confirm', input)); }, () => {
        const work = this.source(context, input.source);
        if (!work.exercise || work.state !== 'confirmed' || work.sets.length === 0) throw new DomainError(422, 'confirmed_progress_work_required');
        revision(work.source.revision, input.expectedSourceRevision);
        const previous = this.stored(context.accountId, input.source); revision(previous?.revision ?? 0, input.expectedBindingRevision);
        synchronous(this.deps.assertIdentityAllowed(context, { source: work.source, exercise: work.exercise, identity: input.identity, provenance: input.provenance }));
        this.assertActive(context);
        revision(this.source(context, input.source).source.revision, work.source.revision);
        const record: StoredIdentity = { id: previous?.id ?? randomUUID(), source: work.source, revision: (previous?.revision ?? 0) + 1,
          status: 'confirmed', data: { exercise: work.exercise, identity: input.identity, provenance: input.provenance }, updatedAt: (this.deps.now?.() ?? new Date()).toISOString() };
        this.write(record, 'confirm'); return { status: previous ? 200 : 201, body: this.receipt(record) };
      }));
  }
  withdraw(context: AccountContext, key: string | undefined, raw: unknown): CommandResult {
    const input = this.decode(schemas.withdrawIdentity, raw);
    this.assertActive(context); synchronous(this.deps.assertPersistable(context, 'withdraw', input));
    return withActiveWrite(this.deps.db, context, () => command(this.deps.db, context.accountId, 'progressComparison.withdraw', key, input,
      () => { this.assertActive(context); synchronous(this.deps.assertPersistable(context, 'withdraw', input)); }, () => {
        const current = this.stored(context.accountId, input.source); if (!current) notFound();
        revision(current.revision, input.expectedBindingRevision);
        if (current.status === 'withdrawn') throw new DomainError(409, 'progress_identity_withdrawn');
        const next: StoredIdentity = { ...current, revision: current.revision + 1, status: 'withdrawn', data: null,
          updatedAt: (this.deps.now?.() ?? new Date()).toISOString() };
        this.write(next, 'withdraw'); return { status: 200, body: this.receipt(next) };
      }));
  }
  private receipt(record: StoredIdentity) {
    return { id: record.id, source: record.source, revision: record.revision, status: record.status };
  }
  private write(record: StoredIdentity, action: 'confirm' | 'withdraw') {
    const { db } = this.deps, source = record.source;
    db.prepare(`INSERT INTO progress_comparison_identities(account_id,id,source_kind,source_id,item_id,source_revision,revision,status,data,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET source_revision=excluded.source_revision,revision=excluded.revision,
      status=excluded.status,data=excluded.data,updated_at=excluded.updated_at`)
      .run(source.accountId, record.id, source.kind, source.id, source.itemId, source.revision, record.revision, record.status,
        record.data === null ? null : JSON.stringify(record.data), record.updatedAt);
    db.prepare('INSERT INTO progress_comparison_identity_revisions VALUES (?,?,?,?,?,?)')
      .run(source.accountId, record.id, record.revision, source.revision, action, record.updatedAt);
  }
  historyPage(context: AccountContext, raw: unknown) {
    const query = this.decode(schemas.historyQuery, raw);
    return this.read(context, () => {
      const page = this.deps.domain.history(context.accountId, query.limit, query.before);
      return { nextBefore: page.nextBefore, items: page.items.map(session => ({ id: session.id, revision: session.revision,
        startedAt: session.startedAt, status: session.status, occurrences: session.occurrences.map(occurrence => {
          const source = sessionObservation(context.accountId, session, occurrence.id);
          const record = this.stored(context.accountId, source.source);
          const binding = this.qualified(context, source, record);
          return { observation: sessionObservation(context.accountId, session, occurrence.id, binding), identity: record,
            identityState: !record ? 'missing' : record.status === 'withdrawn' ? 'withdrawn' :
              !sameSource(record.source, source.source) ? 'stale' : !binding ? 'unqualified' : 'qualified' };
        }) })) };
    });
  }
  private witness(context: AccountContext, contextId: string, selection: ComparisonSelection): FreshComparisonWitness {
    return this.composeWitness(context, contextId, this.observe(context, selection.baseline), this.observe(context, selection.current));
  }
  private composeWitness(context: AccountContext, contextId: string, a: ReturnType<ProgressComparisonService['observe']>,
    b: ReturnType<ProgressComparisonService['observe']>): FreshComparisonWitness {
    let result: FreshComparisonWitness['result'] = compareWork(a.observation, b.observation);
    if (result.status === 'comparable' && canonical(a.record?.data?.provenance) !== canonical(b.record?.data?.provenance))
      result = { policy: result.policy, evidenceToken: result.evidenceToken, status: 'incomparable', reasons: ['identity_provenance_mismatch'] };
    const entries = [a, b];
    const bindings = entries.map(({ record, observation }) => ({ id: record?.id ?? null, revision: record?.revision ?? null,
      status: record?.status ?? 'missing' as const, current: !!record && sameSource(record.source, observation.source) }));
    const sourceRefs = entries.flatMap(({ record, observation }) => [
      { sourceId: `${observation.source.kind}:${observation.source.id}`, revision: String(observation.source.revision),
        locator: observation.source.itemId, qualification: 'canonical_performed_work_observation' },
      ...(record ? [{ sourceId: `progressComparison:${record.id}`, revision: String(record.revision), locator: record.source.itemId,
        qualification: record.status === 'withdrawn' ? 'withdrawn_identity_no_payload' : record.data!.provenance.kind === 'user_reported'
          ? 'user_reported_execution_metadata_requires_separate_comparison_attestation' : 'source_native_identity_requires_full_source_tuple_attestation' }] : []),
    ]);
    const scope = { baseline: a.observation.source, current: b.observation.source };
    const witnessVersion = 'progress-comparison-witness-v2' as const, inputs = { baseline: a.input, current: b.input };
    const evidenceToken = hash(canonical({ witnessVersion, inputs, contextId, scope, bindings, sourceRefs, provenance: entries.map(entry => entry.record?.data?.provenance ?? null), result }));
    return { accountId: context.accountId, contextId, witnessVersion, inputs, scope, bindings, sourceRefs, result: { ...result, evidenceToken }, evidenceToken, interpretation: 'observed_work_only' };
  }
  compare(context: AccountContext, contextId: string, raw: unknown): FreshComparisonWitness {
    const scope = this.decode(schemas.contextId, contextId), selection = this.decode(schemas.comparisonSelection, raw);
    return this.read(context, () => this.witness(context, scope, selection));
  }
  readForDerivationWithinWrite(context: AccountContext, raw: ComparisonSelection & { contextId: string }): ComparisonRead {
    this.assertActive(context);
    if (!this.deps.db.inTransaction) throw new DomainError(503, 'progress_writer_transaction_required');
    const guard = this.deps.assertComparisonContextWithinWrite;
    if (!guard) throw new DomainError(503, 'progress_context_guard_required');
    const input = this.decode(schemas.comparisonSelection.extend({ contextId: schemas.contextId }), raw);
    const snapshots: Partial<Record<'baseline' | 'current', ReturnType<ProgressComparisonService['sourceSnapshot']>>> = {};
    for (const side of ['baseline', 'current'] as const) {
      try { snapshots[side] = this.sourceSnapshot(context, input[side]); }
      catch (error) {
        this.assertActive(context);
        if (error instanceof DomainError && error.status === 503 && error.code === 'progress_activity_reader_unavailable')
          return { status: 'unavailable', reason: 'reader_unavailable', side };
        if (error instanceof DomainError && error.status === 404 && error.code === 'not_found')
          return { status: 'unavailable', reason: 'source_missing', side };
        throw error;
      }
      this.assertActive(context);
      if (snapshots[side]!.work.state === 'missing') return { status: 'unavailable', reason: 'item_missing', side };
    }
    const before = this.composeWitness(context, input.contextId,
      this.observe(context, input.baseline, snapshots.baseline!), this.observe(context, input.current, snapshots.current!));
    synchronous(guard(context, structuredClone({ contextId: input.contextId,
      baseline: before.inputs.baseline.scope, current: before.inputs.current.scope })));
    this.assertActive(context);
    if (!this.deps.db.inTransaction) throw new DomainError(503, 'progress_writer_transaction_required');
    const after = this.witness(context, input.contextId, input);
    this.assertActive(context);
    if (!this.deps.db.inTransaction) throw new DomainError(503, 'progress_writer_transaction_required');
    if (after.evidenceToken !== before.evidenceToken)
      throw new DomainError(409, 'progress_changed_during_context_guard');
    return { status: 'observed', witness: before };
  }
  // The trusted consumer reads and persists in this same database transaction; no client-provided token is accepted.
  withFreshComparison<T>(context: AccountContext, contextId: string, raw: unknown, consume: (witness: FreshComparisonWitness) => T): T {
    const scope = this.decode(schemas.contextId, contextId), selection = this.decode(schemas.comparisonSelection, raw);
    return withActiveWrite(this.deps.db, context, () => {
      const before = this.witness(context, scope, selection);
      const result = synchronous(consume(structuredClone(before)));
      this.assertActive(context);
      if (this.witness(context, scope, selection).evidenceToken !== before.evidenceToken) throw new DomainError(409, 'progress_changed_during_consume');
      return result;
    });
  }
}

export const createProgressComparisonService = (deps: ProgressComparisonDependencies) => new ProgressComparisonService(deps);
