import type { Sqlite } from '../../storage.js';
import { DomainError } from '../../errors.js';
import { hasLifecycleSchema, suppressionAuthority } from '../../lifecycle/guards.js';
import type { AccountContext, LifecycleAdapter, LifecycleBindings, LifecycleResult } from '../../lifecycle/types.js';
import { createUsageLedger } from '../../usage-limits/index.js';
import { createBugIntakeLifecycleAdapter, createBugIntakeServiceFactory } from '../../bug-intake/index.js';
import type { Domain } from '../../domain.js';
import type { ActivityService } from '../../activity/service.js';
import type { CanonicalAccountWriter } from './canonical-writer.js';
import { captureCurrentAnalysisWithinWrite, type CurrentAnalysisAssociation } from '../training-feedback/context-association.js';
import { createProgressComparisonService } from '../../progress-comparison/service.js';
import type { ProgressComparisonDependencies } from '../../progress-comparison/persistence-types.js';
import { progressComparisonMigrationSql } from '../../progress-comparison/migration.js';
import { feedbackMigrationSql } from '../../training-feedback/migration.js';
import { createSqliteFeedbackLedgerStore } from '../../training-feedback/ledger-store.js';
import { createFeedbackLedgerService } from '../../training-feedback/ledger-service.js';
import { replayFeedback } from '../../training-feedback/index.js';
import { createFeedbackLifecycleAdapter } from '../../training-feedback/lifecycle-adapter.js';
import { createProgressComparisonLifecycleAdapter } from '../../progress-comparison/lifecycle.js';
import type { FeedbackCommand, FeedbackCurrentView, FeedbackContextWitness, FeedbackMutationResult, FeedbackServiceDependencies,
  FeedbackSourceKey, FeedbackWitnessRequest } from '../../training-feedback/ledger-types.js';

export { selectAccountModuleMigrations, sourceBugIntakeMigration, sourceProgressComparisonMigration, sourceFeedbackMigration,
  type SourceAccountModuleConfiguration } from './migrations.js';

const unavailablePurge = (): LifecycleResult => ({ status: 'unavailable', reason: 'exact_purge_executor_binding_required' });
export type TrainingRegistration = Pick<FeedbackServiceDependencies, 'derivations' | 'comparisonRegistry' | 'derivationAuthorityWithinWrite'> &
  Pick<ProgressComparisonDependencies, 'comparisonBindingFor'>;
export type RetentionRequest = Readonly<{ operation: 'read' }> | Readonly<{ operation: 'mutate'; command: FeedbackCommand }> |
  Readonly<{ operation: 'invalidate'; sources: readonly FeedbackSourceKey[] }>;
export type SourceTrainingFeedbackBindings = Readonly<{
  domain: Domain; writer: CanonicalAccountWriter; activity?: Pick<ActivityService, 'deps' | 'entry'>;
  registrationWithinWrite(context: AccountContext, current: Pick<CurrentAnalysisAssociation, 'basis' | 'contextId' | 'profile' | 'preferences'>): TrainingRegistration;
  retentionAllowedWithinWrite(context: AccountContext, request: RetentionRequest): boolean;
}>;
export type AnalysisBasis = Readonly<{ basis: 'current_profile_and_goals'; contextId: string; profileRevision: number; preferencesRevision: number }>;
export type AnalysisResult<T> = Readonly<{ analysis: AnalysisBasis; result: T }>;
export type SourceTrainingFeedback = Readonly<{
  read(context: AccountContext): AnalysisResult<FeedbackCurrentView>;
  witness(context: AccountContext, request: FeedbackWitnessRequest): AnalysisResult<FeedbackContextWitness>;
  mutate(context: AccountContext, command: FeedbackCommand): AnalysisResult<FeedbackMutationResult>;
  invalidateWithinWrite(context: AccountContext, sources: readonly FeedbackSourceKey[]): AnalysisResult<FeedbackCurrentView>;
}>;
const cache = new WeakMap<Sqlite, { bindings: LifecycleBindings; training: SourceTrainingFeedbackBindings | undefined;
  assertBindingIdentity(): void; modules: ReturnType<typeof compose> }>();
const alreadyBound = (): never => { throw new DomainError(503, 'account_modules_already_bound'); };
const trainingUnavailable = (code: string): never => { throw new DomainError(503, code); };
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function')
    return trainingUnavailable('training_feedback_synchronous_callback_required');
  return value;
}
const normalizeDefinition = (sql: string) => sql.trim().replace(/;$/, '')
  .match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|\d+|>=|<=|!=|<>|[^\s]/g)?.join(' ') ?? '';
const trainingSchema = (progressComparisonMigrationSql + feedbackMigrationSql).split(';').filter(sql => sql.trim()).map(sql => {
  const declaration = /^\s*CREATE (TABLE|INDEX) ([a-z_]+)/.exec(sql);
  if (!declaration) return trainingUnavailable('training_feedback_schema_unavailable');
  return { type: declaration[1]!.toLowerCase(), name: declaration[2]!, sql: normalizeDefinition(sql) };
});
function assertTrainingSchema(db: Sqlite): void {
  if (trainingSchema.length !== 9 || trainingSchema.filter(item => item.type === 'table').length !== 8 ||
      trainingSchema.filter(item => item.type === 'index').map(item => item.name).join() !== 'feedback_source_dependents')
    trainingUnavailable('training_feedback_schema_unavailable');
  const rows = db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE name IN (${trainingSchema.map(() => '?').join(',')})`)
    .all(...trainingSchema.map(item => item.name)) as { type: string; name: string; sql: string | null }[];
  if (rows.length !== trainingSchema.length || trainingSchema.some(expected => !rows.some(row => row.name === expected.name &&
      row.type === expected.type && row.sql !== null && normalizeDefinition(row.sql) === expected.sql)))
    trainingUnavailable('training_feedback_schema_unavailable');
}

function assertTrainingDatabase(db: Sqlite, domain: Domain, writer: CanonicalAccountWriter,
  activity?: Pick<ActivityService, 'deps' | 'entry'>): void {
  if (domain?.db !== db || writer?.lifecycleStoreOptions?.db !== db || (activity && activity.deps.db !== db))
    trainingUnavailable('training_feedback_bindings_unavailable');
}

export function createSourceTrainingLifecycleAdapters(db: Sqlite, domain: Domain, writer: CanonicalAccountWriter): readonly LifecycleAdapter[] {
  assertTrainingDatabase(db, domain, writer); assertTrainingSchema(db);
  const denyIdentityWrite = (): never => trainingUnavailable('training_feedback_identity_write_unavailable');
  return Object.freeze([
    writer.guardLifecycleAdapter(createProgressComparisonLifecycleAdapter({ db, domain,
      assertIdentityAllowed: denyIdentityWrite, assertPersistable: denyIdentityWrite, comparisonBindingFor: () => null, lifecycleControl: writer })),
    writer.guardLifecycleAdapter(createFeedbackLifecycleAdapter({ db, lifecycle: writer.lifecycle, control: writer })),
  ]);
}

export function hasRetainedFeedbackWithinWrite(db: Sqlite, writer: CanonicalAccountWriter, context: AccountContext): boolean {
  const actor = Object.freeze({ ...context });
  const guard = () => { writer.lifecycleStoreOptions.assertRootWriter(db); writer.assertWithinWrite(actor); };
  guard();
  const installed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feedback_state'").get();
  guard();
  if (!installed) return false;
  const retained = !!db.prepare('SELECT 1 FROM feedback_state WHERE account_id=?').get(actor.accountId);
  guard(); return retained;
}

export function createSourceAccountModules(db: Sqlite, bindings: LifecycleBindings, training?: SourceTrainingFeedbackBindings) {
  const existing = cache.get(db);
  if (existing) {
    if (existing.bindings !== bindings || existing.training !== training) return alreadyBound();
    existing.assertBindingIdentity(); return existing.modules;
  }
  if (!hasLifecycleSchema(db)) throw new DomainError(503, 'account_modules_lifecycle_required');
  suppressionAuthority(db);
  const lifecycle = Object.freeze({ ...bindings });
  const configured = training ? Object.freeze({ ...training }) : undefined;
  const activityEntry = configured?.activity?.entry, activityDeps = configured?.activity?.deps;
  const assertBindingIdentity = () => {
    if (bindings.assertActive !== lifecycle.assertActive || bindings.withActiveWrite !== lifecycle.withActiveWrite ||
        bindings.adultEligibility !== lifecycle.adultEligibility) alreadyBound();
    if (training && configured && (training.domain !== configured.domain || training.writer !== configured.writer ||
        training.activity !== configured.activity || training.registrationWithinWrite !== configured.registrationWithinWrite ||
        training.retentionAllowedWithinWrite !== configured.retentionAllowedWithinWrite ||
        training.activity?.entry !== activityEntry || training.activity?.deps !== activityDeps)) alreadyBound();
  };
  const modules = compose(db, lifecycle, configured, assertBindingIdentity);
  cache.set(db, { bindings, training, assertBindingIdentity, modules });
  return modules;
}

function compose(db: Sqlite, lifecycle: LifecycleBindings, training: SourceTrainingFeedbackBindings | undefined, assertBindingIdentity: () => void) {
  const trainingFeedback = training ? composeTraining(db, training, assertBindingIdentity) : undefined;
  const assertSuppression = (accountId: string, epoch: number) => {
    if (!db.inTransaction || !Number.isSafeInteger(epoch) || epoch < 1)
      throw new DomainError(503, 'canonical_suppression_unproved');
    const record = suppressionAuthority(db).lookup(accountId);
    const row = db.prepare('SELECT state,epoch,suppression_seq FROM account_lifecycle WHERE account_id=?')
      .get(accountId) as { state: string; epoch: number; suppression_seq: number } | undefined;
    if (!record || record.accountId !== accountId || record.epoch !== epoch || row?.state !== 'disabled' ||
        row.epoch !== epoch || row.suppression_seq !== record.sequence)
      throw new DomainError(503, 'canonical_suppression_unproved');
  };
  const ledger = createUsageLedger({ db, lifecycle, now: Date.now, lifecycleControl: {
    assertSuppression, assertPurge: () => { throw new DomainError(503, 'exact_purge_executor_binding_required'); },
  } });
  const bugDependencies = { db, lifecycle, lifecycleControl: { assertSuppression, purgeReadiness: unavailablePurge } };
  const bugFactory = createBugIntakeServiceFactory(bugDependencies);
  const guarded = (adapter: LifecycleAdapter): LifecycleAdapter => Object.freeze({ ...adapter,
    suppress: (accountId: string, epoch: number) => { assertSuppression(accountId, epoch); return adapter.suppress(accountId, epoch); },
    verifySuppressed: (accountId: string, epoch: number) => { assertSuppression(accountId, epoch); return adapter.verifySuppressed(accountId, epoch); },
    purge: unavailablePurge,
  });
  const bugFor = (context: AccountContext) => {
    const actor = Object.freeze({ ...context });
    lifecycle.assertActive(actor);
    return bugFactory(actor);
  };
  return Object.freeze({ usage: ledger.usage, trusted: ledger.trusted, bugFor, trainingFeedback,
    adapters: Object.freeze([guarded(ledger.lifecycle), guarded(createBugIntakeLifecycleAdapter(bugDependencies))]),
  });
}

function composeTraining(db: Sqlite, binding: SourceTrainingFeedbackBindings, assertBindingIdentity: () => void): SourceTrainingFeedback {
  const { domain, writer, activity, registrationWithinWrite, retentionAllowedWithinWrite } = binding;
  function database(): void {
    assertBindingIdentity();
    assertTrainingDatabase(db, domain, writer, activity);
  }
  database(); assertTrainingSchema(db);
  function operate<T>(context: AccountContext, retention: RetentionRequest | null, ownedOnly: boolean,
    effect: (captured: CurrentAnalysisAssociation, service: ReturnType<typeof createFeedbackLedgerService>, actor: AccountContext) => T): AnalysisResult<T> {
    const actor = Object.freeze({ ...context });
    const guard = (candidate: AccountContext = actor): void => {
      database(); writer.lifecycleStoreOptions.assertRootWriter(db); writer.assertWithinWrite(actor);
      if (candidate.accountId !== actor.accountId || candidate.authUserId !== actor.authUserId ||
          candidate.sessionId !== actor.sessionId || candidate.epoch !== actor.epoch) trainingUnavailable('canonical_writer_unproved');
    };
    const work = (): AnalysisResult<T> => {
      guard();
      let callbackFailed = false, callbackError: unknown;
      function callback<V>(read: () => V): V {
        guard();
        try { return writer.lifecycleStoreOptions.runRootWrite(() => {
          guard(); try { return synchronous(read()); } finally { guard(); }
        }); } catch (error) { if (!callbackFailed) { callbackFailed = true; callbackError = error; } throw error; }
      }
      const retain = () => {
        if (retention === null) return;
        if (typeof retentionAllowedWithinWrite !== 'function') trainingUnavailable('training_feedback_retention_unavailable');
        let allowed: boolean;
        try { allowed = callback(() => retentionAllowedWithinWrite(actor, retention)); }
        catch (error) {
          if (error instanceof DomainError && error.code === 'training_feedback_synchronous_callback_required')
            trainingUnavailable('training_feedback_retention_unavailable');
          throw error;
        }
        if (allowed !== true) trainingUnavailable('training_feedback_retention_unavailable');
      };
      retain(); assertTrainingSchema(db); guard();
      const captured = captureCurrentAnalysisWithinWrite({ context: actor, domain, writer, ...(activity ? { activity } : {}) });
      if (typeof registrationWithinWrite !== 'function') return trainingUnavailable('training_feedback_registration_unavailable');
      const registration = callback(() => registrationWithinWrite(actor, Object.freeze({ basis: captured.basis, contextId: captured.contextId,
        profile: captured.profile, preferences: captured.preferences })));
      if (!registration || !Array.isArray(registration.derivations) || typeof registration.derivationAuthorityWithinWrite !== 'function' ||
          typeof registration.comparisonBindingFor !== 'function' || registration.derivations.some(recipe => !recipe || typeof recipe.compute !== 'function'))
        return trainingUnavailable('training_feedback_registration_unavailable');
      const authority = registration.derivationAuthorityWithinWrite, comparisonBindingFor = registration.comparisonBindingFor;
      const derivations = registration.derivations.map(({ compute, ...metadata }) => ({ ...structuredClone(metadata),
        compute: (input: Parameters<typeof compute>[0]) => callback(() => compute(input)) }));
      const comparisonRegistry = registration.comparisonRegistry === undefined ? undefined : structuredClone(registration.comparisonRegistry);
      replayFeedback({ accountId: actor.accountId, events: [], derivations: derivations.map(recipe => ({ ...recipe, compute: () => null })) });
      if (comparisonRegistry === null || derivations.some(recipe => recipe.scope.contextId !== captured.contextId))
        return trainingUnavailable('training_feedback_registration_unavailable');
      const progress = createProgressComparisonService({ db, domain, ...(activity ? { activity } : {}),
        assertIdentityAllowed: () => trainingUnavailable('training_feedback_identity_write_unavailable'),
        assertPersistable: () => trainingUnavailable('training_feedback_identity_write_unavailable'),
        comparisonBindingFor: (candidate, record) => { guard(candidate); return callback(() => comparisonBindingFor(actor, structuredClone(record))); },
        assertComparisonContextWithinWrite: captured.assertComparisonContextWithinWrite, lifecycleControl: writer });
      const store = createSqliteFeedbackLedgerStore({ db, lifecycle: writer.lifecycle, assertWithinWrite: guard });
      const service = createFeedbackLedgerService({ store: { ...store, replaceWithinWrite(...args) {
        guard(args[0]); retain(); return store.replaceWithinWrite(...args);
      } }, lifecycle: writer.lifecycle, derivations,
        derivationAuthorityWithinWrite: (candidate, recipe) => { guard(candidate); return callback(() => authority(actor, structuredClone(recipe))); },
        ...(comparisonRegistry === undefined ? {} : { comparisonRegistry }),
        readContextWithinWrite: captured.readContextWithinWrite,
        readComparisonWithinWrite: progress.readForDerivationWithinWrite.bind(progress), associateComparisonWithinWrite: captured.associateComparisonWithinWrite });
      const result = effect(captured, service, actor);
      if (callbackFailed) throw callbackError;
      retain();
      captured.readContextWithinWrite(actor, { scope: { kind: 'context', contextId: captured.contextId }, selection: null });
      assertTrainingSchema(db); guard();
      return Object.freeze({ analysis: Object.freeze({ basis: captured.basis, contextId: captured.contextId,
        profileRevision: captured.profile.revision, preferencesRevision: captured.preferences.revision }), result });
    };
    database();
    if (ownedOnly || db.inTransaction) { guard(); return work(); }
    return writer.lifecycle.withActiveWrite(actor, work);
  }
  return Object.freeze({
    read: (context: AccountContext) => operate(context, Object.freeze({ operation: 'read' }), false,
      (_captured, service, actor) => service.invalidateWithinWrite(actor, [])),
    witness: (context: AccountContext, request: FeedbackWitnessRequest) => {
      const actor = Object.freeze({ ...context });
      const input = immutable(structuredClone(request));
      return operate(actor, null, false, (captured, _service, original) => captured.readContextWithinWrite(original, input));
    },
    mutate: (context: AccountContext, command: FeedbackCommand) => {
      const actor = Object.freeze({ ...context });
      const input = immutable(structuredClone(command));
      return operate(actor, Object.freeze({ operation: 'mutate', command: input }), false,
        (_captured, service, original) => service.mutateWithinWrite(original, input));
    },
    invalidateWithinWrite: (context: AccountContext, sources: readonly FeedbackSourceKey[]) => {
      const actor = Object.freeze({ ...context });
      const input = immutable(structuredClone(sources));
      return operate(actor, Object.freeze({ operation: 'invalidate', sources: input }), true,
        (_captured, service, original) => service.invalidateWithinWrite(original, input));
    },
  });
}
