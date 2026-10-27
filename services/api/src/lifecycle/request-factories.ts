import type { CanonicalAccountWriter } from '../integration/account-modules/canonical-writer.js';
import { assertRuntimeOwner, type RuntimeOwner } from '../runtime-modules/admission.js';
import { CommunityLimiter } from '../runtime-modules/limiter.js';
import { DomainError } from '../errors.js';
import type { ActivityLifecycleControl } from '../activity/types.js';
import { createActivityIntegration } from '../activity/integration/index.js';
import { createActivityCommunityReader, createActivityLifecycleAdapter, createActivityService } from '../activity/index.js';
import { createCommunity, createCommunityLifecycleAdapter, createCommunityIntegration, type CommunityIntegrationDependencies, type CommunityDependencies, type AuthoritativeRestoreState, type CommunityIntegrationServices } from '../community/index.js';
import { suppressionAuthority, hasLifecycleSchema } from './guards.js';
import type { Sqlite } from '../storage.js';
import type { AccountContext, AdultEligibility, LifecycleBindings } from './types.js';

export type SourceRequestFactoryConfiguration = Readonly<{
  mode: 'source-only';
  activityProjection?: 'read-only';
  activityCommands?: 'owner-input';
  communityModules?: 'b2-b4-b5';
  communityExtension?: CommunityIntegrationDependencies['extension'];
  communityBoard?: CommunityIntegrationDependencies['board'];
  assertCommunityRateLimit?: NonNullable<CommunityDependencies['assertRateLimit']>;
}>;

type FactoryInput = Readonly<{
  db: Sqlite;
  lifecycle: LifecycleBindings;
  purgeReadiness?: CanonicalAccountWriter['purgeReadiness'];
  configuration: SourceRequestFactoryConfiguration;
  subjectEligibilityFor: (actor: AccountContext) => (accountId: string) => AdultEligibility;
}>;
export function createSourceRequestFactories(input: FactoryInput) { return composeFactories(input); }
export function createRuntimeRequestFactories(input: Omit<FactoryInput, 'configuration'> & Readonly<{owner: RuntimeOwner}>) {
  assertRuntimeOwner(input.owner); input.owner.assertComposition(input.db);
  const limiter = new CommunityLimiter(input.lifecycle);
  const factories = composeFactories({...input, configuration: {mode:'source-only', activityProjection:'read-only', activityCommands:'owner-input',
    communityModules:'b2-b4-b5', assertCommunityRateLimit:limiter.consume, communityExtension:{assertRateLimit:limiter.consume}}});
  return Object.freeze({...factories, limiter});
}
function composeFactories(input: FactoryInput) {
  const { db, lifecycle } = input;
  const configuration = Object.freeze({ ...input.configuration });
  const subjectEligibilityFor = input.subjectEligibilityFor;
  if (configuration.mode !== 'source-only' || !hasLifecycleSchema(db) || !lifecycle?.assertActive ||
    !lifecycle.withActiveWrite || !lifecycle.adultEligibility || !input.subjectEligibilityFor)
    throw new DomainError(503, 'request_factory_bindings_required');
  suppressionAuthority(db);
  const now = () => new Date();
  // Retained catalog/framing names only these five global resistance identities.
  const resistanceIds = new Set(['goblet-squat', 'floor-press', 'supported-row', 'dumbbell-hinge', 'calf-raise']);
  const lifecycleControl: ActivityLifecycleControl = {
      assertSuppression(accountId, epoch) {
        if (!db.inTransaction || !Number.isSafeInteger(epoch) || epoch < 1)
          throw new DomainError(503, 'canonical_suppression_unproved');
        const record = suppressionAuthority(db).lookup(accountId);
        const row = db.prepare('SELECT state,epoch,suppression_seq FROM account_lifecycle WHERE account_id=?')
          .get(accountId) as { state: string; epoch: number; suppression_seq: number } | undefined;
        if (!record || record.accountId !== accountId || record.epoch !== epoch || row?.state !== 'disabled' ||
          row.epoch !== epoch || row.suppression_seq !== record.sequence)
          throw new DomainError(503, 'canonical_suppression_unproved');
      },
      purgeReadiness: input.purgeReadiness ?? (() => ({ status: 'unavailable', reason: 'exact_purge_executor_binding_required' })),
  };
  const activityIntegration = configuration.activityCommands === 'owner-input'
    ? createActivityIntegration({ db, lifecycle, lifecycleControl, now }) : undefined;
  const activityService = activityIntegration?.service ?? createActivityService({
    db, lifecycle, now, lifecycleControl,
    globalExerciseKind: id => resistanceIds.has(id) ? 'resistance' : null,
    assertPersistable: () => { throw new DomainError(503, 'activity_persistability_unavailable'); },
  });
  const activity = configuration.activityProjection === 'read-only' ? activityService : undefined;
  const modulesFor = (context: AccountContext, requireInvitationLimiter = true): CommunityIntegrationServices | Readonly<{community: ReturnType<typeof createCommunity>}> => {
    const actor = Object.freeze({ ...context });
    lifecycle.assertActive(actor);
    if (requireInvitationLimiter && !configuration.assertCommunityRateLimit) throw new DomainError(503, 'community_limiter_unavailable');
    const parent = { ...(configuration.assertCommunityRateLimit ? {assertRateLimit: configuration.assertCommunityRateLimit} : {}),
      activityFor: (proof: Parameters<NonNullable<CommunityDependencies['activityFor']>>[0]) => activity ? createActivityCommunityReader({ service: activity, viewer: actor, lifecycle,
        trustedContext: request => { proof.assertAuthorized(request); return proof; },
      }) : { readDays: () => ({ status: 'unavailable' as const }) },
    };
    if (configuration.communityModules === 'b2-b4-b5') return createCommunityIntegration({ db, now, lifecycle,
      subjectEligibility: subjectEligibilityFor(actor), parent,
      ...(configuration.communityExtension ? { extension: configuration.communityExtension } : {}),
      ...(configuration.communityBoard ? { board: configuration.communityBoard } : {}),
    }, actor);
    return { community: createCommunity({ db, now, lifecycle, subjectEligibility: subjectEligibilityFor(actor), ...parent }) };
  };
  const serviceFor = (context: AccountContext) => modulesFor(context).community;
  const boardFor = (context: AccountContext) => {
    if (configuration.communityModules !== 'b2-b4-b5') throw new DomainError(503, 'board_unavailable');
    const modules = modulesFor(context, false);
    if (!('board' in modules) || !modules.board) throw new DomainError(503, 'board_unavailable');
    return modules.board;
  };
  const extensionFor = (context: AccountContext) => {
    const modules = modulesFor(context, false);
    if (!('extension' in modules)) throw new DomainError(503, 'community_extension_unavailable');
    const service=modules.extension;
    if(configuration.communityExtension?.textModeration) return service;
    return new Proxy(service,{get(target,property){
      if(['enroll','createPost','report','appeal'].includes(String(property))) return ()=>{throw new DomainError(503,'community_text_moderation_unavailable');};
      if(property==='updateProfile') return (actor:AccountContext,groupId:string,raw:unknown,key:string)=>{
        const input=raw as {flags?:{sex?:unknown};sexDescription?:unknown}|null;
        if(input?.flags?.sex===true && input.sexDescription!==null && input.sexDescription!==undefined) throw new DomainError(503,'community_text_moderation_unavailable');
        return target.updateProfile(actor,groupId,raw,key);
      };
      const value=Reflect.get(target,property,target) as unknown;return typeof value==='function'?value.bind(target):value;
    }});
  };
  // This same lifecycle compositor retains the root-only restore handle; no second adapter is registered.
  const installed = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const extensionInstalled = installed('community_group_policy');
  const boardInstalled = installed('community_board_features');
  if ((extensionInstalled || boardInstalled || configuration.communityModules === 'b2-b4-b5') &&
    (!extensionInstalled || !boardInstalled || !installed('community_removal_snapshots')))
    throw new DomainError(503, 'community_restore_schema_unavailable');
  const compositor = extensionInstalled && boardInstalled ? createCommunityIntegration({db, now, lifecycle}) : undefined;
  const communityLifecycle = compositor?.lifecycleAdapter ?? createCommunityLifecycleAdapter(createCommunity({db, now, lifecycle}));
  const reconcileRestore = (authority: AuthoritativeRestoreState) => {
    if (!compositor) throw new DomainError(503, 'community_restore_composition_required');
    return compositor.reconcileRestore(authority);
  };
  return Object.freeze({ serviceFor, modulesFor, boardFor, extensionFor, reconcileRestore, activity, activityIntegration,
    adapters: Object.freeze([communityLifecycle, activityIntegration?.lifecycleAdapter ?? createActivityLifecycleAdapter(activityService)]),
  });
}
