import type { Domain } from '../../domain.js';
import { DomainError } from '../../errors.js';
import { canonical, hash } from '../../storage.js';
import { expectedRevision, preferenceFields, profileFields, type Preferences, type Profile } from '../../schemas.js';
import type { AccountContext } from '../../lifecycle/types.js';
import type { ActivityService } from '../../activity/service.js';
import type { CanonicalAccountWriter } from '../account-modules/canonical-writer.js';
import type { AssertComparisonContextWithinWrite, ComparisonSourceScope } from '../../progress-comparison/persistence-types.js';
import { createFeedbackSessionSourceReader } from '../../training-feedback/session-source.js';
import type { FeedbackScope, SourceReference } from '../../training-feedback/index.js';
import type { AssociateComparisonWithinWrite, ReadFeedbackContextWithinWrite } from '../../training-feedback/ledger-types.js';

export type CurrentAnalysisOptions = Readonly<{
  context: AccountContext; domain: Domain; writer: CanonicalAccountWriter;
  activity?: Pick<ActivityService, 'deps' | 'entry'>;
}>;
export type CurrentAnalysisAssociation = Readonly<{
  basis: 'current_profile_and_goals'; contextId: string;
  profile: Readonly<Profile & { revision: number }>;
  preferences: Readonly<Preferences & { revision: number }>;
  assertComparisonContextWithinWrite: AssertComparisonContextWithinWrite;
  readContextWithinWrite: ReadFeedbackContextWithinWrite;
  associateComparisonWithinWrite: AssociateComparisonWithinWrite;
}>;
const unavailable = (): never => { throw new DomainError(503, 'current_analysis_context_unavailable'); };
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const text = (value: string) => typeof value === 'string' && value.trim().length > 0;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function captureCurrentAnalysisWithinWrite(options: CurrentAnalysisOptions): CurrentAnalysisAssociation {
  const { domain, writer, activity } = options;
  const actor = Object.freeze({ ...options.context });
  const basis = 'current_profile_and_goals' as const;
  const contextId = `current_${hash(canonical({ basis, accountId: actor.accountId }))}`;
  function guard(context: AccountContext = actor): void {
    writer.lifecycleStoreOptions.assertRootWriter(domain.db);
    writer.assertWithinWrite(actor);
    if (context.accountId !== actor.accountId || context.authUserId !== actor.authUserId ||
        context.sessionId !== actor.sessionId || context.epoch !== actor.epoch)
      throw new DomainError(503, 'canonical_writer_unproved');
    if (activity) writer.lifecycleStoreOptions.assertRootWriter(activity.deps.db);
  }
  function read<T>(effect: () => T): T {
    guard();
    try { return effect(); } finally { guard(); }
  }
  function documents() {
    try {
      const profile = read(() => domain.document<Profile>(actor.accountId, 'profile'));
      const preferences = read(() => domain.document<Preferences>(actor.accountId, 'preferences'));
      const p = profileFields.extend({ revision: expectedRevision }).safeParse(profile);
      const q = preferenceFields.extend({ revision: expectedRevision }).safeParse(preferences);
      if (!p.success || !q.success || !equal(p.data, profile) || !equal(q.data, preferences)) return unavailable();
      return { profile, preferences };
    } catch (error) {
      guard();
      if (error instanceof SyntaxError || (error instanceof DomainError && error.status === 404)) return unavailable();
      throw error;
    }
  }
  guard();
  const captured = freeze(structuredClone(documents()));
  function current(): void {
    guard();
    let observed: ReturnType<typeof documents>;
    try { observed = documents(); }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'current_analysis_context_unavailable') throw error;
      throw new DomainError(409, 'current_analysis_changed');
    }
    if (!equal(captured, observed)) throw new DomainError(409, 'current_analysis_changed');
  }
  function within<T>(context: AccountContext, effect: () => T): T {
    guard(context); current();
    try { return effect(); } finally { guard(context); current(); }
  }
  const sessions = createFeedbackSessionSourceReader({ domain, withReadSnapshot: (context, effect) => within(context, effect) });
  function sessionJoin(sessionId: string, occurrenceId: string) {
    const session = read(() => domain.session(actor.accountId, sessionId));
    const occurrence = session.occurrences.find(item => item.id === occurrenceId);
    if (!occurrence) return unavailable();
    const historicalPlan = read(() => {
      try { return domain.planRevision(actor.accountId, session.planId, session.planRevision); }
      catch (error) {
        if (error instanceof DomainError && (error.status === 404 || error.code === 'stored_training_data_invalid')) return unavailable();
        throw error;
      }
    });
    const item = historicalPlan?.items.find(item => item.id === occurrence.itemId && ('registeredDomain' in item ? item.registeredDomain.exerciseId : item.exerciseId) === occurrence.exerciseId);
    const snapshot = session.planSnapshot;
    const { createdAt: _created, updatedAt: _updated, ...historicalSnapshot } = snapshot;
    if (!item || snapshot.id !== session.planId || snapshot.revision !== session.planRevision ||
        !equal(occurrence.target, item) || !equal(historicalPlan, historicalSnapshot)) return unavailable();
    const scope: ComparisonSourceScope = {
      source: { accountId: actor.accountId, kind: 'session', id: session.id, revision: session.revision, itemId: occurrence.id },
      exercise: { source: 'global', id: occurrence.exerciseId },
      session: { planId: session.planId, planRevision: session.planRevision,
        occurrence: { id: occurrence.id, itemId: occurrence.itemId, exerciseId: occurrence.exerciseId } },
    };
    const sessionSource = read(() => sessions.read(actor, { sessionId, occurrenceId }));
    return { scope, historicalPlan, sessionSource };
  }
  function join(scope: ComparisonSourceScope) {
    if (scope.source.accountId !== actor.accountId) return unavailable();
    if (scope.source.kind === 'session') {
      const found = sessionJoin(scope.source.id, scope.source.itemId);
      if (!equal(found.scope, scope)) return unavailable();
      return found;
    }
    if (scope.source.kind !== 'activity' || scope.session !== null || !activity) return unavailable();
    const entry = read(() => activity.entry(actor, scope.source.id));
    const item = entry.items.find(item => item.id === scope.source.itemId);
    if (!item) return unavailable();
    const actual: ComparisonSourceScope = { source: { accountId: actor.accountId, kind: 'activity', id: entry.id,
      revision: entry.revision, itemId: item.id }, exercise: item.exercise ?? null, session: null };
    if (!equal(actual, scope)) return unavailable();
    return { scope: actual, status: entry.status, performedConfirmed: entry.performedConfirmed, item };
  }
  function scopeMatches(scope: FeedbackScope, selected: readonly ComparisonSourceScope[]): boolean {
    if (scope.contextId !== contextId) return false;
    if (scope.kind === 'context') return true;
    return selected.some(item => item.source.kind === 'session' && item.session !== null &&
      (scope.kind === 'plan' ? item.session.planId === scope.planId : item.source.id === scope.sessionId &&
        (scope.planId === null || item.session.planId === scope.planId)));
  }
  const assertComparisonContextWithinWrite: AssertComparisonContextWithinWrite = (context, input) => within(context, () => {
    if (input.contextId !== contextId) unavailable();
    join(input.baseline); join(input.current);
  });
  const readContextWithinWrite: ReadFeedbackContextWithinWrite = (context, request) => within(context, () => {
    if (request.scope.contextId !== contextId) return unavailable();
    const source = request.selection ? sessionJoin(request.selection.sessionId, request.selection.occurrenceId).sessionSource : null;
    if (request.scope.kind === 'session' && (!source || source.source.id !== request.scope.sessionId ||
        (request.scope.planId !== null && source.planSnapshot.planId !== request.scope.planId))) return unavailable();
    const scope = request.scope;
    const target = scope.kind === 'plan' ? read(() => domain.plan(actor.accountId, scope.planId)) : null;
    return { contextId, profileRevision: captured.profile.revision, preferencesRevision: captured.preferences.revision,
      sessionSource: source, targetPlan: target ? { id: target.id, revision: target.revision, archived: target.archived } : null };
  });
  const associateComparisonWithinWrite: AssociateComparisonWithinWrite = (context, input) => within(context, () => {
    const denied = { status: 'unavailable', reason: 'association_unproved' } as const;
    try {
      const { recipe, declaration, witness, feedback } = input;
      if (!text(recipe.id) || !text(recipe.version) || !text(declaration.id) || declaration.contextId !== contextId ||
          witness.contextId !== contextId || witness.accountId !== actor.accountId || witness.witnessVersion !== 'progress-comparison-witness-v2' ||
          witness.interpretation !== 'observed_work_only' || witness.result.status !== 'comparable' ||
          !text(witness.evidenceToken) || witness.result.evidenceToken !== witness.evidenceToken) return denied;
      const selected = [witness.inputs.baseline.scope, witness.inputs.current.scope];
      if (!scopeMatches(recipe.scope, selected)) return denied;
      for (const side of ['baseline', 'current'] as const) {
        const source = witness.inputs[side].scope.source, selection = declaration.selections[side];
        const identity = witness.inputs[side].identity;
        if (!equal(source, witness.scope[side]) || source.kind !== selection.kind || source.id !== selection.id || source.itemId !== selection.itemId ||
            identity.state !== 'qualified' || identity.status !== 'confirmed' || identity.current !== true) return denied;
      }
      const joins = selected.map(join);
      const refs: SourceReference[] = [
        { sourceId: contextId, revision: String(captured.profile.revision), locator: 'documents/profile', qualification: basis },
        { sourceId: contextId, revision: String(captured.preferences.revision), locator: 'documents/preferences', qualification: basis },
      ];
      for (const scope of selected) {
        refs.push({ sourceId: scope.source.id, revision: String(scope.source.revision), locator: `${scope.source.kind}/${scope.source.itemId}`,
          qualification: 'account_scoped_observation_join' });
        if (scope.session) refs.push({ sourceId: scope.session.planId, revision: String(scope.session.planRevision),
          locator: `plan_revisions/${scope.session.occurrence!.itemId}`, qualification: 'saved_session_plan_revision' });
      }
      for (const { record, binding } of feedback) {
        if (!binding || !record.content || record.status !== 'active' || !record.confirmed || !scopeMatches(record.content.scope, selected) ||
            !equal(binding.scope, record.content.scope)) return denied;
        const observed = readContextWithinWrite(context, binding);
        if (!equal(observed, binding.witness)) return denied;
        if (observed.sessionSource) {
          const { source, planSnapshot, occurrence } = observed.sessionSource;
          refs.push({ sourceId: source.id, revision: String(source.revision), locator: `session/${source.itemId}`,
            qualification: 'current_feedback_session_binding' });
          refs.push({ sourceId: planSnapshot.planId, revision: String(planSnapshot.planRevision), locator: `plan_revisions/${occurrence.itemId}`,
            qualification: 'saved_session_plan_revision' });
        }
        if (observed.targetPlan) refs.push({ sourceId: observed.targetPlan.id, revision: String(observed.targetPlan.revision),
          locator: 'plans/current', qualification: 'current_feedback_target_plan_binding' });
        refs.push({ sourceId: record.recordId, revision: String(record.revision), locator: `feedback/${record.recordId}`,
          qualification: 'trusted_ledger_replay_with_current_source_binding' });
      }
      const evidenceToken = hash(canonical({ basis, accountId: actor.accountId, contextId, captured, recipe, declaration, witness, joins, feedback }));
      return freeze({ status: 'associated' as const, evidenceToken, sourceRefs: refs });
    } catch (error) {
      if (error instanceof DomainError && (error.code === 'current_analysis_context_unavailable' || error.status === 404)) return denied;
      throw error;
    }
  });
  current();
  return Object.freeze({ basis, contextId, ...captured, assertComparisonContextWithinWrite, readContextWithinWrite, associateComparisonWithinWrite });
}
