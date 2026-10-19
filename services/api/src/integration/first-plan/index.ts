import type { CanonicalAccountWriter } from '../account-modules/canonical-writer.js';
import type { SavedPlan } from '../../schemas.js';
import type { Domain } from '../../domain.js';
import { DomainError } from '../../errors.js';
import { assertActive, withActiveWrite } from '../../lifecycle/guards.js';
import type { AccountContext } from '../../lifecycle/types.js';
import { selectFirstPlan, selectSourceFirstPlan, type PlanningContext, type SelectionTrace, type SourceSelectionTrace, type SourceReference } from '../../planning/first-plan/index.js';
import { firstPlanConfirmation, type Preferences, type Profile } from '../../schemas.js';
import { canonical, command } from '../../storage.js';
import { firstPlanOperation, firstPlanProvenanceLimit, firstPlanProvenanceSchema, firstPlanReceiptSchema,
  type FirstPlanConfirmation, type FirstPlanPreparationPort, type FirstPlanProvenance, type FirstPlanReceipt, type PreparedFirstPlan, type PreparedSourceFirstPlan } from './contracts.js';
export type { FirstPlanConfirmation, FirstPlanPreparationPort, FirstPlanProvenance, FirstPlanReceipt, PreparedFirstPlan, PreparedSourceFirstPlan } from './contracts.js';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
class PreparationRequired {
  constructor(readonly context: PlanningContext) {}
}
function boundedProvenance(trace: SelectionTrace | SourceSelectionTrace, confirmation: FirstPlanConfirmation): FirstPlanProvenance {
  const sources = new Map<string, { id: string; revision: string }>();
  const add = (source: SourceReference | undefined) => {
    if (source) sources.set(JSON.stringify([source.id, source.revision]), { id: source.id, revision: source.revision });
  };
  for (const candidate of trace.candidates) {
    add(candidate.source);
    if (candidate.catalog?.status === 'qualified') {
      add(candidate.catalog.source); candidate.catalog.items.forEach(item => add(item.source));
    }
    add(candidate.constraints?.source);
    candidate.constraints?.rules.forEach(rule => add(rule.source));
  }
  const parsed = firstPlanProvenanceSchema.safeParse({ schema: 'form.first-plan-provenance/v1',
    contextKey: trace.contextKey, selectedCandidateId: trace.selectedCandidateId, ...confirmation,
    sources: [...sources.values()], candidates: trace.candidates.map(candidate => ({ id: candidate.candidateId,
      status: candidate.status, gapCodes: [...new Set(candidate.reasons.map(reason => reason.code))] })) });
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > firstPlanProvenanceLimit)
    throw new DomainError(503, 'first_plan_provenance_unavailable');
  return parsed.data;
}
function gapCodes(codes: string[]): string[] {
  return [...new Set(codes.map(code => /^[A-Za-z0-9_.:-]{1,128}$/.test(code) ? code : 'upstream_gap'))].slice(0, 64);
}

export function createFirstPlanHost(domain: Domain, prepare?: FirstPlanPreparationPort, binding?: Readonly<{
  writer: CanonicalAccountWriter;
  afterPlanWriteWithinWrite(actor: AccountContext, plan: SavedPlan): void;
}>) {
  const db = domain.db;
  const writer = binding?.writer, afterPlanWrite = binding?.afterPlanWriteWithinWrite;
  const within = <T>(actor: AccountContext, effect: () => T): T => writer
    ? writer.lifecycle.withActiveWrite(actor, () => { writer.lifecycleStoreOptions.assertRootWriter(db); writer.assertWithinWrite(actor); return effect(); })
    : withActiveWrite(db, actor, effect);
  const context = (actor: AccountContext, confirmation: FirstPlanConfirmation): PlanningContext => {
    assertActive(db, actor);
    const profile = domain.document<Profile>(actor.accountId, 'profile');
    const preferences = domain.document<Preferences>(actor.accountId, 'preferences');
    if (profile.revision !== confirmation.profileRevision || preferences.revision !== confirmation.preferencesRevision)
      throw new DomainError(409, 'first_plan_confirmation_stale');
    return freeze({ accountId: actor.accountId, profile: { revision: profile.revision, goals: [...profile.goals],
      trainingBackground: profile.trainingBackground, injuryHistory: profile.injuryHistory,
      ...(profile.trainingContext === undefined ? {} : { trainingContext: profile.trainingContext }) },
    preferences: { revision: preferences.revision, equipment: [...preferences.equipment],
      sessionMinutes: preferences.sessionMinutes, trainingDaysPerWeek: preferences.trainingDaysPerWeek } });
  };
  return Object.freeze({
    async create(actorInput: AccountContext, input: FirstPlanConfirmation, key: string | undefined): Promise<FirstPlanReceipt> {
      const actor = Object.freeze({ ...actorInput });
      const parsed = firstPlanConfirmation.safeParse(input);
      if (!parsed.success) throw new DomainError(422, 'invalid_request');
      const confirmation = Object.freeze(parsed.data);
      const attempt = (prepared?: { value: PreparedFirstPlan | PreparedSourceFirstPlan; captured: PlanningContext }): FirstPlanReceipt => {
        const result = within(actor, () => command(db, actor.accountId, firstPlanOperation, key,
          confirmation, () => assertActive(db, actor), () => {
            if (!prepare) throw new DomainError(501, 'first_plan_unavailable');
            const current = context(actor, confirmation);
            if (!prepared) throw new PreparationRequired(current);
            if (canonical(current) !== canonical(prepared.captured)) throw new DomainError(409, 'first_plan_confirmation_stale');
            const source = prepared.value;
            if (!source || !Array.isArray(source.candidates) || source.candidates.length > 64 ||
                !source.ports || typeof source.assertCurrent !== 'function')
              throw new DomainError(503, 'first_plan_preparation_invalid');
            if ('schema' in source && (source.schema !== 'form.source-first-plan-preparation/v1' || !writer || !afterPlanWrite))
              throw new DomainError(503, 'source_first_plan_writer_required');
            const assertSources = source.assertCurrent;
            const currentSources = () => {
              let returned: unknown;
              try { returned = assertSources(); }
              catch { throw new DomainError(409, 'first_plan_sources_changed'); }
              if (returned !== null && (typeof returned === 'object' || typeof returned === 'function') &&
                  typeof (returned as { then?: unknown }).then === 'function') {
                void Promise.resolve(returned).catch(() => {});
                throw new DomainError(503, 'synchronous_first_plan_source_check_required');
              }
              writer?.assertWithinWrite(actor);
              assertActive(db, actor);
              if (canonical(context(actor, confirmation)) !== canonical(prepared.captured))
                throw new DomainError(409, 'first_plan_confirmation_stale');
            };
            currentSources();
            const selection = 'schema' in source
              ? selectSourceFirstPlan({ context: current, confirmation: { accountId: actor.accountId, ...confirmation }, candidates: source.candidates }, source.ports)
              : selectFirstPlan({ context: current, confirmation: { accountId: actor.accountId, ...confirmation }, candidates: source.candidates }, source.ports);
            currentSources();
            if (selection.status !== 'ready') throw new DomainError(422,
              selection.status === 'infeasible' ? 'first_plan_infeasible' : 'first_plan_blocked',
              'No qualified plan was saved.', { status: selection.status, gapCodes: gapCodes(selection.gaps.map(gap => gap.code)) });
            const provenance = boundedProvenance(selection.trace, confirmation);
            const plan = 'schema' in selection.plan ? domain.createSourcePlan(actor.accountId, selection.plan) : domain.createPlan(actor.accountId, selection.plan);
            currentSources();
            if (afterPlanWrite) {
              const effect: unknown = afterPlanWrite(actor, plan);
              if (effect !== null && (typeof effect === 'object' || typeof effect === 'function') && typeof (effect as { then?: unknown }).then === 'function') {
                void Promise.resolve(effect).catch(() => {});
                throw new DomainError(503, 'synchronous_first_plan_write_hook_required');
              }
              currentSources();
            }
            return { status: 201, body: { plan, provenance } };
          }));
        const receipt = firstPlanReceiptSchema.safeParse(result.body);
        if (!receipt.success) throw new DomainError(503, 'first_plan_receipt_invalid');
        assertActive(db, actor);
        return receipt.data;
      };
      let captured: PlanningContext;
      try { return attempt(); }
      catch (error) {
        if (!(error instanceof PreparationRequired)) throw error;
        captured = error.context;
      }
      let prepared: PreparedFirstPlan | PreparedSourceFirstPlan;
      try { prepared = await prepare!(actor, captured); }
      catch {
        assertActive(db, actor);
        context(actor, confirmation);
        throw new DomainError(503, 'first_plan_preparation_unavailable');
      }
      return attempt({ value: prepared, captured });
    },
  });
}
