import { createHash } from 'node:crypto';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { replayFeedback } from './index.js';
import type { DerivationSpec, FeedbackReceipt } from './index.js';
import { feedbackCanonical } from './ledger-store.js';
import { createFeedbackComparisonInputs, feedbackComparisonDependencies } from './comparison-inputs.js';
import type { FeedbackBinding, FeedbackCommand, FeedbackContextWitness, FeedbackCurrentView, FeedbackLedgerEntry, FeedbackLedgerService,
  FeedbackLedgerState, FeedbackMinimalReceipt, FeedbackMutationResult, FeedbackServiceDependencies, FeedbackStoredProjection,
  FeedbackWitnessRequest } from './ledger-types.js';

const equal = (a: unknown, b: unknown) => feedbackCanonical(a) === feedbackCanonical(b);
const revision = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function witnessValid(context: AccountContext, request: FeedbackWitnessRequest, value: FeedbackContextWitness): boolean {
  if (!value || value.contextId !== request.scope.contextId || !revision(value.profileRevision) || !revision(value.preferencesRevision)) return false;
  const source = value.sessionSource, selection = request.selection;
  if (selection === null ? source !== null : !source || source.source.accountId !== context.accountId
      || source.source.kind !== 'session' || source.source.id !== selection.sessionId || source.occurrence.id !== selection.occurrenceId
      || source.source.itemId !== selection.occurrenceId || !revision(source.source.revision, 1)) return false;
  if (source && (!['active', 'completed'].includes(source.sessionStatus) || !text(source.occurrence.itemId)
      || !text(source.occurrence.exerciseId) || !text(source.planSnapshot.planId) || !revision(source.planSnapshot.planRevision, 1)
      || !Array.isArray(source.sets) || new Set(source.sets.map(set => set.id)).size !== source.sets.length
      || source.sets.some(set => !text(set.id) || !revision(set.revision, 1) || !['draft', 'confirmed', 'voided'].includes(set.status)))) return false;
  if (request.scope.kind === 'session' && (!selection || selection.sessionId !== request.scope.sessionId || !source
      || (request.scope.planId !== null && request.scope.planId !== source.planSnapshot.planId))) return false;
  if (request.scope.kind === 'plan') return !!value.targetPlan && value.targetPlan.id === request.scope.planId
    && revision(value.targetPlan.revision, 1) && typeof value.targetPlan.archived === 'boolean';
  return value.targetPlan === null;
}

// Public methods enter the supplied canonical writer once; integration hooks reuse its active transaction.
export function createFeedbackLedgerService(deps: FeedbackServiceDependencies): FeedbackLedgerService {
  const { store, lifecycle } = deps;
  const recipes = deps.derivations.map(({ compute, ...metadata }) => ({ ...structuredClone(metadata), compute }));
  const prepareComparisons = createFeedbackComparisonInputs(deps, recipes);
  function readWitness(context: AccountContext, request: FeedbackWitnessRequest): FeedbackContextWitness {
    lifecycle.assertActive(context);
    const value = deps.readContextWithinWrite(context, structuredClone(request));
    lifecycle.assertActive(context);
    if (!witnessValid(context, request, value)) throw new DomainError(503, 'feedback_source_binding_invalid');
    feedbackCanonical(value);
    return structuredClone(value);
  }
  const bindings = (entries: readonly FeedbackLedgerEntry[]) => new Map(entries.map(entry => [entry.event.recordId, entry.afterBinding]));
  function project(context: AccountContext, entries: FeedbackLedgerEntry[]) {
    const events = entries.map(entry => entry.event);
    // Reuse pure replay's graph validation and source lineage without running any registered compute function.
    const graph = replayFeedback({ accountId: context.accountId, events, derivations: recipes.map(recipe => ({ ...recipe, compute: () => null })) });
    const records = graph.records;
    const bound = bindings(entries);
    const readSources = () => records.map(record => {
      const binding = bound.get(record.recordId) ?? null;
      if (!binding || !record.content || !equal(binding.scope, record.content.scope))
        return { source: { recordId: record.recordId, state: 'unbound' as const, binding }, observed: null };
      try {
        const current = readWitness(context, binding);
        return { source: { recordId: record.recordId, state: equal(current, binding.witness) ? 'current' as const : 'changed' as const, binding }, observed: current };
      } catch (error) {
        if (!(error instanceof DomainError) || error.status !== 404) throw error;
        return { source: { recordId: record.recordId, state: 'missing' as const, binding }, observed: null };
      }
    });
    const sourceReads = readSources(), sources = sourceReads.map(read => read.source);
    const sourceStates = new Map(sources.map(source => [source.recordId, source.state]));
    const readAuthority = () => new Map(recipes.map(recipe => {
      lifecycle.assertActive(context);
      const allowed = deps.derivationAuthorityWithinWrite(context, { id: recipe.id, version: recipe.version }) === true;
      lifecycle.assertActive(context); return [recipe.id, allowed] as const;
    }));
    const authority = readAuthority();
    const comparisons = prepareComparisons(context, records, bound, graph.derivations);
    const verify = () => {
      if (!equal(sourceReads, readSources())) throw new DomainError(409, 'feedback_source_changed_during_consume');
      if (!equal([...authority], [...readAuthority()])) throw new DomainError(409, 'feedback_authority_changed_during_consume');
      comparisons.assertUnchanged();
    };
    let boundaryFailed = false, boundaryFailure: unknown;
    const guarded: DerivationSpec[] = recipes.map(recipe => ({ ...recipe, compute(input) {
      const selected = comparisons.input(recipe.id);
      if (!authority.get(recipe.id) || recipe.sourceIds.some(id => sourceStates.get(id) !== 'current') || selected.blockedBy.length)
        throw new Error('feedback_derivation_source_or_authority_unavailable');
      try { verify(); }
      catch (error) { boundaryFailed = true; boundaryFailure = error; throw error; }
      return recipe.compute({ ...input, comparisons: selected.comparisons });
    } }));
    const result = replayFeedback({ accountId: context.accountId, events, derivations: guarded });
    if (boundaryFailed) throw boundaryFailure;
    for (const derived of result.derivations) {
      if (!authority.get(derived.id)) {
        derived.status = 'blocked'; derived.value = null;
        derived.blockedBy.push(`derivation:${derived.id}:authority-unavailable`);
      }
      for (const source of derived.lineage) {
        const state = sourceStates.get(source.recordId);
        if (state !== 'current') {
          derived.status = 'blocked'; derived.value = null;
          derived.blockedBy.push(`source:${source.recordId}:${state ?? 'unbound'}-witness`);
        }
      }
    }
    const derivations = result.derivations.map(derived => {
      const comparisonLineage = comparisons.lineage(derived);
      for (const input of comparisonLineage) if (input.blockedBy.length) {
        derived.status = 'blocked'; derived.value = null;
        derived.blockedBy.push(...input.blockedBy.map(reason => `${reason}:${input.inputId}`));
      }
      return { ...derived, comparisonLineage, comparisonDependencies: feedbackComparisonDependencies(comparisonLineage) };
    });
    const projection: FeedbackStoredProjection = { records: result.records, derivations, sources: structuredClone(sources) };
    return { projection, verify };
  }
  function saveCurrent(context: AccountContext, state: FeedbackLedgerState): FeedbackCurrentView {
    const prepared = project(context, state.entries);
    const versions = store.replaceWithinWrite(context, state, { projection: prepared.projection });
    prepared.verify();
    return { ...versions, ...prepared.projection };
  }
  function mutateWithinWrite(context: AccountContext, command: FeedbackCommand): FeedbackMutationResult {
      const event = command.event;
      if ((event.kind as string) === 'delete') throw new DomainError(501, 'feedback_deletion_policy_unavailable');
      if (event.accountId !== context.accountId) throw new DomainError(403, 'feedback_account_mismatch');
      if (!text(command.idempotencyKey) || !text(event.eventId) || !text(event.recordId)
          || !revision(command.expectedLedgerRevision) || !revision(event.expectedRevision)
          || !['record', 'correct', 'confirm', 'withdraw', 'undo'].includes(event.kind)) throw new DomainError(422, 'feedback_invalid_command');
      const { idempotencyKey, ...intent } = command;
      const digest = createHash('sha256').update(feedbackCanonical(intent)).digest('hex');
        const state = store.loadWithinWrite(context);
        const keyReceipt = store.receiptWithinWrite(context, { idempotencyKey });
        const eventReceipt = store.receiptWithinWrite(context, { eventId: event.eventId });
        const known = keyReceipt ?? eventReceipt;
        const previous = replayFeedback({ accountId: context.accountId, events: state.entries.map(entry => entry.event), derivations: [] });
        const currentRecord = previous.records.find(record => record.recordId === event.recordId);
        const rejected = (reason: string): FeedbackMinimalReceipt => ({ eventId: event.eventId, recordId: event.recordId,
          cause: event.kind, outcome: 'rejected', revision: currentRecord?.revision ?? 0, reason, acceptedLedgerRevision: state.ledgerRevision });
        if (known) {
          const conflict = known.eventId !== event.eventId || known.intentDigest !== digest;
          const prepared = project(context, state.entries), projection = prepared.projection;
          const next = store.replaceWithinWrite(context, state, { projection,
            ...(!conflict && !keyReceipt ? { key: { idempotencyKey, eventId: event.eventId } } : {}) });
          prepared.verify();
          return { receipt: conflict ? rejected(keyReceipt ? 'idempotency-key-conflict' : 'event-id-conflict') : structuredClone(known.receipt),
            replayed: !conflict, current: { ...next, ...projection } };
        }
        let receipt: FeedbackMinimalReceipt;
        let entry: FeedbackLedgerEntry | undefined;
        if (command.expectedLedgerRevision !== state.ledgerRevision) receipt = rejected('ledger-revision-conflict');
        else {
          const candidate = replayFeedback({ accountId: context.accountId, events: [...state.entries.map(row => row.event), event], derivations: [] });
          const result = candidate.receipts.at(-1)!;
          const minimal = (value: FeedbackReceipt): FeedbackMinimalReceipt => ({ eventId: value.eventId, recordId: value.recordId,
            cause: value.cause, outcome: value.outcome, revision: value.revision, reason: value.reason,
            acceptedLedgerRevision: state.ledgerRevision + (value.outcome === 'changed' ? 1 : 0) });
          receipt = minimal(result);
          const beforeBinding = bindings(state.entries).get(event.recordId) ?? null;
          let afterBinding: FeedbackBinding | null = beforeBinding;
          if (result.outcome !== 'rejected' && (event.kind === 'record' || event.kind === 'correct' || event.kind === 'confirm')) {
            const scope = 'content' in event ? event.content.scope : currentRecord?.content?.scope;
            if (!scope || !command.expectedWitness) receipt = rejected('source-witness-required');
            else if (event.kind === 'confirm' && (!beforeBinding || !equal(command.selection, beforeBinding.selection)
                || !equal(command.expectedWitness, beforeBinding.witness))) receipt = rejected('source-witness-conflict');
            else {
              const request = { scope, selection: command.selection };
              try {
                const actual = readWitness(context, request);
                if (!equal(actual, command.expectedWitness) || (event.kind === 'confirm' && !equal(actual, beforeBinding!.witness)))
                  receipt = rejected('source-witness-conflict');
                else if (event.kind !== 'confirm') afterBinding = { ...structuredClone(request), witness: actual };
              } catch (error) {
                if (!(error instanceof DomainError) || error.status !== 404) throw error;
                receipt = rejected('source-missing');
              }
            }
          }
          if (receipt.outcome === 'changed') {
            if (event.kind === 'undo') {
              const target = state.entries.find(row => row.event.eventId === event.targetEventId);
              afterBinding = target?.event.kind === 'confirm' ? beforeBinding : target?.beforeBinding ?? null;
            }
            entry = { sequence: state.ledgerRevision + 1, event: structuredClone(event),
              beforeBinding: structuredClone(beforeBinding), afterBinding: structuredClone(afterBinding) };
          }
        }
        const entries = entry ? [...state.entries, entry] : state.entries;
        const prepared = project(context, entries), projection = prepared.projection;
        const next = store.replaceWithinWrite(context, state, { projection, ...(entry ? { entry } : {}),
          receipt: { eventId: event.eventId, intentDigest: digest, receipt }, key: { idempotencyKey, eventId: event.eventId } });
        prepared.verify();
        return { receipt, replayed: false, current: { ...next, ...projection } };
  }
  return {
    read: context => lifecycle.withActiveWrite(context, () => saveCurrent(context, store.loadWithinWrite(context))),
    invalidateWithinWrite(context, sources) {
      const state = store.loadWithinWrite(context);
      // A fresh replay also covers changed recipe authority; no cached ready value survives this hook.
      store.dependsOnWithinWrite(context, sources);
      return saveCurrent(context, state);
    },
    mutateWithinWrite,
    mutate(context, command) {
      if ((command.event.kind as string) === 'delete') throw new DomainError(501, 'feedback_deletion_policy_unavailable');
      return lifecycle.withActiveWrite(context, () => mutateWithinWrite(context, command));
    },
  };
}
