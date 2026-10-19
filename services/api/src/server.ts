import { RuntimeOwner, assertRuntimeOwner } from './runtime-modules/admission.js';
import { moduleMigrations } from './runtime-modules/migrations.js';
import { communityNamespace, requiresTextPort } from './runtime-modules/dispatch.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { getMigrations } from 'better-auth/db/migration';
import { createAuth, type SocialProviders } from './auth.js';
import { credentialAuthProxy } from './credentials/proxy.js';
import { credentialMailFor, type CredentialMailPort } from './credentials/mail.js';
import { Domain } from './domain.js';
import { createGroundedAnswerHost } from './integration/grounded-answer.js';
import { createStandardCoachingRoutes } from './integration/standard-coaching/routes.js';
import type { StandardCoachingConfiguration } from './integration/standard-coaching/composition.js';
import { readPackagedFormFollowupProjection, type PackagedFormFollowupProjection } from './grounding/packaged-form-artifact.js';
import { createFormFollowupGroundingRetriever } from './grounding/form-artifact.js';
import { createFirstPlanHost, type FirstPlanPreparationPort } from './integration/first-plan/index.js';
import { buildAccountExport } from './lifecycle/export.js';
import { composeAccountMigrations, type CommunityAdditiveMigrations } from './lifecycle/composition.js';
import { AccountLifecycle, actionGrantRequest, deletionRequest, deletionConfirmation, deletionStatusRequest, exportRequest } from './lifecycle/service.js';
import { assertAccountActive, assertActive, assertPrincipalActive, hasLifecycleSchema, withActiveWrite, adultEligibility, subjectEligibility, bindSuppressionAuthority } from './lifecycle/guards.js';
import type { AccountContext, AdultEligibility, LifecycleAdapter, LifecycleBindings, SuppressionLedger } from './lifecycle/types.js';
import { readAccountSettings } from './settings.js';
import { bodyCapabilities, rejectBodyOperation, type BodyOperation } from './body/index.js';
import { createBodyMeasurementRoutes, createManualRetentionRoutes } from './body/routes.js';
import { createManualMeasurements, type ManualMeasurements } from './body/measurements.js';
import { browserOriginsConfiguration } from './configuration.js';
import { mountActivityRoutes } from './activity/routes.js';
import { createCommunityRoutes, createFeatureBoardRoutes, createCommunityExtensionRoutes } from './community/index.js';
import { createSourceRequestFactories, createRuntimeRequestFactories, type SourceRequestFactoryConfiguration } from './lifecycle/request-factories.js';
import { createSourceAccountModules, selectAccountModuleMigrations, createSourceTrainingLifecycleAdapters, hasRetainedFeedbackWithinWrite,
  type SourceAccountModuleConfiguration, type SourceTrainingFeedbackBindings } from './integration/account-modules/index.js';
import { createCanonicalAccountWriter } from './integration/account-modules/canonical-writer.js';
import { appendSourceBodyMeasurementMigration, appendSourceReportedLoadMigration, appendSourceManualRetentionMigration } from './integration/account-modules/migrations.js';
import { progressComparisonOwnedTables } from './progress-comparison/migration.js';
import { feedbackOwnedTables } from './training-feedback/migration.js';
import { createTrainingFeedbackRoutes } from './training-feedback/routes.js';
import type { FeedbackSourceKey } from './training-feedback/ledger-types.js';
import { createBugIntakeRoutes } from './bug-intake/index.js';
import { bugIntakeOwnedTables } from './bug-intake/migration.js';
import { usageOwnedTables } from './usage-limits/migration.js';
import { createNutritionController, createRetainedNutritionController, type NutritionController } from './integration/nutrition-conversation/host.js';
import { createNutritionConversationRoutes } from './integration/nutrition-conversation/routes.js';
import { DomainError } from './errors.js';
import * as s from './schemas.js';
import { openStorage, command, type CommandResult, type Sqlite, type Migration } from './storage.js';
import { Transcription, maxWavBytes, type GrokConfig } from './transcription.js';
import { phoneConfiguration, type PhoneConfiguration } from './phone/index.js';
import { createAppleSandboxPurchases, validateAppleConfiguration, parseAppleDeliveryRequest, type AppleSandboxConfiguration } from './purchases/index.js';

export type SourceTrainingConfiguration = Pick<SourceTrainingFeedbackBindings, 'registrationWithinWrite' | 'retentionAllowedWithinWrite'>;
export type ServerConfig = {
  runtimeOwner?: RuntimeOwner;
  publicStagedLifecycleEnabled?: boolean;
  sourceRequestFactories?: SourceRequestFactoryConfiguration;
  sourceBodyMeasurements?: (db: Sqlite, bindings: LifecycleBindings) => ManualMeasurements;
  sourceAccountModules?: SourceAccountModuleConfiguration;
  sourceTraining?: SourceTrainingConfiguration;
  sourceReportedLoad?: 'selected-migration-22';
  sourceManualRetention?: 'selected-migration-23';
  sourceNutritionConversations?: { projectionBytes: Uint8Array };
  sourceFirstPlan?: FirstPlanPreparationPort;
  sourceGroundedAnswers?: { projectionBytes: Uint8Array };
  sourceStandardCoaching?: StandardCoachingConfiguration;
  moduleMigrations?: { activity: Migration; community: Migration; additions?: CommunityAdditiveMigrations };
  lifecycle?: { ledger: SuppressionLedger; adapters?: readonly LifecycleAdapter[]; createAdapters?: (db: Sqlite, bindings: LifecycleBindings) => readonly LifecycleAdapter[] };
  dbPath: string;
  baseURL: string;
  secret: string;
  registration?: s.Registration;
  trustedOrigins?: string[];
  socialProviders?: SocialProviders;
  credentialMail?: CredentialMailPort;
  promos?: s.PromoDefinition[];
  grok?: GrokConfig;
  phone?: PhoneConfiguration;
  applePurchases?: AppleSandboxConfiguration;
};
type Env = { Variables: { accountId: string; authUserId: string; accountContext: AccountContext; activityContext: AccountContext } };
type ApiContext = Context<Env>;
export function createSubjectEligibilityProvider(db: Sqlite, actor: AccountContext): (accountId: string) => AdultEligibility {
  return accountId => subjectEligibility(db, actor, accountId);
}
async function body<T>(c: ApiContext, schema: z.ZodType<T>): Promise<T> {
  if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new DomainError(415, 'json_required');
  let value: unknown;
  try { value = await c.req.json(); } catch { throw new DomainError(400, 'invalid_json'); }
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError(422, 'invalid_request', 'Check the submitted fields.', result.error.issues.map(x => ({ path: x.path, message: x.message })));
  return result.data;
}
function isPublicLifecyclePath(path:string):boolean {
  return ['/v1/me/account-action-grants','/v1/me/deletion-requests','/v1/account-deletion/status','/v1/me/account-export'].includes(path) || /^\/v1\/me\/deletion-requests\/[^/]+\/confirm$/.test(path);
}
function isTrainingFeedbackPath(path: string): boolean {
  return path === '/v1/training-feedback' || path.startsWith('/v1/training-feedback/');
}
function isBugReportPath(path: string): boolean {
  return path === '/v1/bug-reports' || path.startsWith('/v1/bug-reports/');
}

export type FormServer = { lifecycle?: AccountLifecycle; sourceAccountModules?: ReturnType<typeof createSourceAccountModules>; reconcileModulesRestore?: ReturnType<typeof createSourceRequestFactories>['reconcileRestore']; app: Hono<Env>; auth: ReturnType<typeof createAuth>; domain: Domain; db: Sqlite; migrationBackups: string[]; handleRequest: (request: Request, peerAddress: string) => Response | Promise<Response>; close: (clean?: boolean) => void | Promise<void> };
export async function createServer(config: ServerConfig): Promise<FormServer> {
  try { return await createServerCandidate(config); }
  catch(error) { if(config.runtimeOwner) { try { config.runtimeOwner.close(false); } catch(closeError) { throw new AggregateError([error,closeError],'Server start and owner close failed'); } } throw error; }
}
async function createServerCandidate(config: ServerConfig): Promise<FormServer> {
  const runtime = config.runtimeOwner;
  let packaged: PackagedFormFollowupProjection | undefined;
  let groundedConfiguration = config.sourceGroundedAnswers;
  if (runtime) {
    if (config.lifecycle || config.moduleMigrations || config.sourceRequestFactories || config.sourceBodyMeasurements || config.sourceAccountModules || config.sourceTraining || config.sourceReportedLoad || config.sourceManualRetention || config.sourceNutritionConversations || config.sourceFirstPlan || config.sourceGroundedAnswers || config.sourceStandardCoaching || config.publicStagedLifecycleEnabled) throw new Error('Runtime ownership cannot mix source injections');
    assertRuntimeOwner(runtime);
    packaged = await readPackagedFormFollowupProjection();
    assertRuntimeOwner(runtime);
    groundedConfiguration = packaged.status === 'available' ? { projectionBytes: packaged.projectionBytes } : undefined;
    config = {...config, moduleMigrations, lifecycle:{ledger:runtime.ledger}, publicStagedLifecycleEnabled:false};
  }
  const groundedAnswers = createGroundedAnswerHost(groundedConfiguration);
  const publicLifecycle = config.publicStagedLifecycleEnabled === true;
  if (publicLifecycle && !config.lifecycle) throw new Error('Public lifecycle requires internal lifecycle');
  if (config.secret.length < 32) throw new Error('Supply a high-entropy auth secret of at least 32 characters');
  const url = new URL(config.baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('baseURL must be an exact HTTP(S) origin');
  const browserOrigins = browserOriginsConfiguration.parse(config.trustedOrigins ?? []);
  const trustedOrigins = [...new Set([url.origin, 'formprivacy://', ...browserOrigins])];
  const registration = s.registration.parse(config.registration ?? { mode: 'closed' });
  const promos = z.array(s.promoDefinition).max(100).parse(config.promos ?? []);
  if (config.grok && (config.grok.allowCloudRequests !== true || !config.grok.apiKey || config.grok.apiKey.length > 8192))
    throw new Error('Grok requires explicit cloud-request enablement and a supplied bounded key');
  const phone = config.phone ? phoneConfiguration.parse(config.phone) : undefined;
  const appleConfig = config.applePurchases ? validateAppleConfiguration(config.applePurchases) : undefined;
  if (config.moduleMigrations && !config.lifecycle) throw new DomainError(503, 'suppression_authority_required');
  if (config.sourceNutritionConversations && !config.lifecycle) throw new DomainError(503, 'nutrition_lifecycle_bindings_required');
  if (config.sourceFirstPlan && !config.lifecycle) throw new DomainError(503, 'first_plan_lifecycle_bindings_required');
  if (config.sourceBodyMeasurements && !config.lifecycle) throw new DomainError(503, 'body_lifecycle_bindings_required');
  if (config.sourceRequestFactories && (config.sourceRequestFactories.mode !== 'source-only' || !config.moduleMigrations || !config.lifecycle))
    throw new DomainError(503, 'request_factory_bindings_required');
  if (config.sourceRequestFactories?.communityModules === 'b2-b4-b5' && !config.moduleMigrations?.additions)
    throw new DomainError(503, 'community_additive_migrations_required');
  if (config.sourceAccountModules && (!config.lifecycle || config.sourceRequestFactories?.mode !== 'source-only' || config.sourceRequestFactories.communityModules !== 'b2-b4-b5'))
    throw new DomainError(503, 'account_modules_source_bindings_required');
  if (config.sourceTraining && (!['usage-bug-and-training-feedback', 'usage-bug-training-feedback-and-source-prescription',
    'usage-bug-training-feedback-source-prescription-and-board-correction'].includes(config.sourceAccountModules?.modules ?? '') ||
      Object.keys(config.sourceTraining).some(key => key !== 'registrationWithinWrite' && key !== 'retentionAllowedWithinWrite')))
    throw new DomainError(503, 'training_feedback_bindings_unavailable');
  if (config.sourceManualRetention !== undefined && (config.sourceManualRetention !== 'selected-migration-23' ||
    config.sourceBodyMeasurements !== createManualMeasurements || !config.lifecycle ||
    config.sourceAccountModules?.modules !== 'usage-bug-training-feedback-source-prescription-and-board-correction'))
    throw new DomainError(503, 'body_manual_retention_configuration_invalid');
  config.lifecycle?.ledger.currentSequence();
  const baseMigrations = config.moduleMigrations ? composeAccountMigrations(config.moduleMigrations.activity, config.moduleMigrations.community, config.moduleMigrations.additions) : undefined;
  const accountMigrations = config.sourceAccountModules ? selectAccountModuleMigrations(config.sourceAccountModules, baseMigrations) : baseMigrations;
  const bodyMigrations = config.sourceAccountModules && config.sourceBodyMeasurements
    ? appendSourceBodyMeasurementMigration(accountMigrations) : accountMigrations;
  if (config.sourceReportedLoad !== undefined && config.sourceReportedLoad !== 'selected-migration-22')
    throw new DomainError(503, 'source_reported_load_configuration_invalid');
  const loadMigrations = config.sourceReportedLoad ? appendSourceReportedLoadMigration(bodyMigrations) : bodyMigrations;
  const selectedMigrations = config.sourceManualRetention ? appendSourceManualRetentionMigration(loadMigrations) : loadMigrations;
  runtime?.stage('server:before-open');
  runtime?.beforeOpen(config.dbPath);
  let storage: Awaited<ReturnType<typeof openStorage>>;
  try { storage = await openStorage(config.dbPath, selectedMigrations, config.sourceReportedLoad, config.sourceManualRetention); }
  catch(error) { runtime?.close(false); throw error; }
  const db = storage.db, domain = new Domain(db, ['usage-bug-training-feedback-and-source-prescription',
    'usage-bug-training-feedback-source-prescription-and-board-correction'].includes(config.sourceAccountModules?.modules ?? '')
    ? { sourcePrescription: 'selected-migration-19', ...(config.sourceReportedLoad ? { sourceReportedLoad: config.sourceReportedLoad } : {}) } : {});
  let nutrition: NutritionController | undefined;
  try {
    runtime?.attachMain(db);
    if (config.lifecycle) bindSuppressionAuthority(db, config.lifecycle.ledger);
    const writer = createCanonicalAccountWriter(db), bindings = writer.lifecycle;
    nutrition = runtime ? createNutritionController({ lifecycle: bindings,
      ...(packaged?.status === 'available' ? { retriever: createFormFollowupGroundingRetriever(packaged.projectionBytes) } : {}) })
      : createRetainedNutritionController({ lifecycle: bindings,
      ...(config.sourceNutritionConversations ? { projectionBytes: config.sourceNutritionConversations.projectionBytes } : {}) });
    runtime?.stage('server:factories');
    const factoryInput = {db, lifecycle:bindings, subjectEligibilityFor:(actor:AccountContext)=>createSubjectEligibilityProvider(db,actor)};
    const runtimeFactories=runtime?createRuntimeRequestFactories({...factoryInput,owner:runtime}):undefined;
    const requestFactories = runtimeFactories ?? (config.sourceRequestFactories ? createSourceRequestFactories({ db, lifecycle: bindings,
      configuration: config.sourceRequestFactories, subjectEligibilityFor: actor => createSubjectEligibilityProvider(db, actor) }) : undefined);
    const tableInstalled = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const lifecycleFactories = requestFactories ?? (config.lifecycle &&
      (tableInstalled('community_group_policy') || tableInstalled('community_board_features'))
      ? createSourceRequestFactories({ ...factoryInput, configuration: { mode: 'source-only' } }) : undefined);
    const suppliedAdapters = config.lifecycle?.createAdapters?.(db, bindings) ?? config.lifecycle?.adapters ?? [];
    if (lifecycleFactories && suppliedAdapters.some(adapter => lifecycleFactories.adapters.some(owned => owned.category === adapter.category)))
      throw new DomainError(503, 'duplicate_module_lifecycle_adapter');
    const bodyMeasurements = config.sourceManualRetention
      ? createManualMeasurements(db, bindings, undefined, config.sourceManualRetention)
      : config.sourceBodyMeasurements?.(db, bindings);
    const training = config.sourceTraining ? { domain, writer,
      ...(requestFactories?.activity ? { activity: requestFactories.activity } : {}),
      registrationWithinWrite: config.sourceTraining.registrationWithinWrite,
      retentionAllowedWithinWrite: config.sourceTraining.retentionAllowedWithinWrite } : undefined;
    const lifecycleAccountModules = config.lifecycle && (config.sourceAccountModules ||
      [...usageOwnedTables, ...bugIntakeOwnedTables].some(tableInstalled)) ? createSourceAccountModules(db, bindings, training) : undefined;
    const accountModules = config.sourceAccountModules ? lifecycleAccountModules : undefined;
    const trainingAdapters = config.lifecycle && [...progressComparisonOwnedTables, ...feedbackOwnedTables].some(tableInstalled)
      ? createSourceTrainingLifecycleAdapters(db, domain, writer) : [];
    const adapters = [...suppliedAdapters, ...(lifecycleFactories?.adapters ?? []), ...(bodyMeasurements ? [writer.guardLifecycleAdapter(bodyMeasurements.lifecycleAdapter)] : []),
      ...(lifecycleAccountModules?.adapters ?? []), ...trainingAdapters];
    if (new Set(adapters.map(adapter => adapter.category)).size !== adapters.length)
      throw new DomainError(503, 'duplicate_module_lifecycle_adapter');
    let lifecycle = config.lifecycle && !runtime ? new AccountLifecycle(db, adapters, config.lifecycle.ledger) : undefined;
    if (hasLifecycleSchema(db) && !lifecycle && !runtime) throw new DomainError(503, 'suppression_authority_required');
    domain.configurePromos(promos);
    const auth = createAuth(db, { baseURL: url.origin, secret: config.secret, trustedOrigins, registration,
      ...(config.socialProviders ? { socialProviders: config.socialProviders } : {}), ...(phone ? { phone } : {}),
      ...(config.credentialMail ? { credentialMail: config.credentialMail } : {}) });
    const providers = Object.entries(config.socialProviders ?? {}).filter(([, provider]) => !!provider).map(([name]) => name);
    runtime?.stage('server:auth-schema');
    const schema = await getMigrations(auth.options);
    if (schema.toBeCreated.length || schema.toBeAdded.length || schema.unsafeChanges.length || schema.schemaProblems.length)
      throw new Error('Pinned auth schema mismatch; a reviewed migration is required');
    if (runtime) {
      if (!config.lifecycle || !requestFactories) throw new Error('Runtime composition absent');
      const ledger=config.lifecycle.ledger;
      lifecycle=runtime.admit(()=>{runtime.stage('server:lifecycle');return new AccountLifecycle(db,adapters,ledger);},requestFactories.reconcileRestore);
    }
    const runtimeReadiness = () => ({ configured:!!runtime, independentActivity:!!requestFactories?.activityIntegration,
      legacyAvailable:false, legacyCoverage:'unknown', pendingBoard:config.sourceRequestFactories?.communityModules==='b2-b4-b5'||!!runtime,
      textModeration:!!config.sourceRequestFactories?.communityExtension?.textModeration,
      enrollment:!!config.sourceRequestFactories?.communityExtension?.textModeration,
      limiter:runtimeFactories?.limiter.readiness() ?? 'unavailable',
      publicStagedLifecycle:publicLifecycle, accountDeletion:{supported:false,purge:false,complete:false},
      batchApplication:false, publication:false, providerQualification:false });
    const purchases = createAppleSandboxPurchases(db, appleConfig);
    const app = new Hono<Env>(), transcription = new Transcription(db, config.grok);
    let closing=false, activeRequests=0;
    app.use('*', async (c, next) => {
      if(closing) throw new DomainError(503,'server_closed');
      runtime?.assertServing(); activeRequests++;
      try { await next(); runtime?.assertServing(); } finally { activeRequests--; }
    });
    app.use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
      await next();
    });
    app.use('*', cors({
      origin: origin => trustedOrigins.includes(origin) ? origin : undefined,
      allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      exposeHeaders: ['set-auth-token'], credentials: true, maxAge: 600,
    }));
    app.use('*', (c, next) => (isTrainingFeedbackPath(c.req.path) || (c.req.method === 'POST' && c.req.path === '/v1/coaching/standard/turn') || c.req.path === '/v1/grounded-answers' || c.req.path.startsWith('/v1/body/') || c.req.path.startsWith('/v1/nutrition/conversations/') || (accountModules && isBugReportPath(c.req.path)) || (!publicLifecycle && isPublicLifecyclePath(c.req.path))) ? next() : bodyLimit({ maxSize: c.req.path === '/v1/transcriptions' ? maxWavBytes : 64 * 1024,
      onError: context => context.json({ error: { code: 'body_too_large', message: 'The request exceeds its byte limit.' } }, 413) })(c, next));
    app.onError((error, c) => {
      if (error instanceof DomainError) return c.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status);
      if (error instanceof z.ZodError) return c.json({ error: { code: 'invalid_request', message: 'Check the submitted fields.' } }, 422);
      // Never include SQL, profile payloads, session tokens or provider errors in public errors.
      return c.json({ error: { code: 'internal_error', message: 'The request could not be completed.' } }, 500);
    });
    app.notFound(c => c.json({ error: { code: 'not_found', message: 'not_found' } }, 404));
    app.get('/health', c => c.json({ status: 'ok', service: 'form-api', schemaVersion: (db.prepare('SELECT MAX(version) AS version FROM form_migrations').get() as { version: number }).version }));
    app.get('/v1/capabilities', c => c.json({
      runtimeModules:runtimeReadiness(),
      authentication: {
        emailPassword: { status: 'configured_unverified', registration: registration.mode,
          passwordRecovery: credentialMailFor(db).status(), emailChange: credentialMailFor(db).status() },
        google: { status: config.socialProviders?.google ? 'configured_unverified' : 'unconfigured' },
        apple: { status: config.socialProviders?.apple ? 'configured_unverified' : 'unconfigured' },
        phone: { status: phone ? 'configured_unverified' : 'unconfigured' },
        session: { transport: 'signed_bearer_or_cookie', expiresInSeconds: 604800 },
      },
      transcription: { grok: { status: config.grok ? 'configured_unverified' : 'unconfigured' }, appleOnDevice: { status: 'client_capability_required' } },
      purchases: { apple: purchases.capabilities(), chargesEnabled: false },
      promos: { status: db.prepare('SELECT code_hash FROM promos LIMIT 1').get() ? 'configured_unverified' : 'unconfigured', chargesEnabled: false },
      units: { canonicalLoad: 'kg', canonicalHeight: 'cm', volume: 'kg-repetitions' },
    }));
    app.use('/v1/*',(c,next)=>{
      if(!publicLifecycle && isPublicLifecyclePath(c.req.path)) throw new DomainError(501,'staged_account_lifecycle_unavailable');
      return next();
    });
    app.on(['GET', 'POST'], '/api/auth/*', c => credentialAuthProxy(c.req.raw, { db, auth, registration, providers }));
    app.post('/v1/account-deletion/status', async c => {
      if (!publicLifecycle || !lifecycle) throw new DomainError(501, 'staged_account_lifecycle_unavailable');
      const input = await body(c, deletionStatusRequest);
      const authorization = c.req.header('authorization');
      if (!authorization?.startsWith('DeletionReceipt ')) throw new DomainError(401, 'status_receipt_invalid');
      return c.json(lifecycle.status(input.requestId, authorization.slice('DeletionReceipt '.length)));
    });
    app.use('/v1/*', async (c, next) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) throw new DomainError(401, 'unauthenticated');
      if (c.req.method !== 'GET' && c.req.method !== 'OPTIONS') {
        const origin = c.req.header('origin');
        if (origin && !trustedOrigins.includes(origin)) throw new DomainError(403, 'origin_not_allowed');
        if (!c.req.header('authorization') && !origin) throw new DomainError(403, 'origin_required');
      }
      const live = db.prepare('SELECT userId,expiresAt FROM session WHERE id=?').get(session.session.id) as { userId: string; expiresAt: number } | undefined;
      if (!live || live.userId !== session.user.id || live.expiresAt <= Date.now()) throw new DomainError(401, 'account_session_invalid');
      assertPrincipalActive(db, session.user.id);
      c.set('authUserId', session.user.id);
      if (['/v1/body/', '/v1/community/', '/v1/activity/', '/v1/nutrition/conversations/', '/v1/coaching/standard/'].some(prefix => c.req.path.startsWith(prefix)) ||
          isTrainingFeedbackPath(c.req.path) || (accountModules && isBugReportPath(c.req.path))) {
        const mapping = db.prepare('SELECT id FROM form_accounts WHERE auth_user_id=?').get(session.user.id) as { id: string } | undefined;
        if (!mapping) throw new DomainError(403, 'account_not_initialized');
        c.set('accountId', mapping.id);
      } else c.set('accountId', db.transaction(() => {
        const current = db.prepare('SELECT userId,expiresAt FROM session WHERE id=?').get(session.session.id) as { userId: string; expiresAt: number } | undefined;
        if (!current || current.userId !== session.user.id || current.expiresAt <= Date.now()) throw new DomainError(401, 'account_session_invalid');
        assertPrincipalActive(db, session.user.id);
        return domain.account(session.user.id, session.user.name);
      }).immediate());
      c.set('accountContext', Object.freeze({ accountId: c.get('accountId'), authUserId: session.user.id, sessionId: session.session.id, epoch: assertAccountActive(db, c.get('accountId')) }));
      assertActive(db, c.get('accountContext'));
      await next();
    });
    app.route('/v1/coaching/standard', createStandardCoachingRoutes<Env>({
      context: c => c.get('accountContext'), lifecycle: bindings,
      ...(config.sourceStandardCoaching ? { configuration: config.sourceStandardCoaching } : {}),
    }));
    app.route('/v1/training-feedback', createTrainingFeedbackRoutes<Env>({
      context: c => c.get('accountContext'), assertActive: actor => assertActive(db, actor), training: accountModules?.trainingFeedback,
    }));
    app.route('/v1/nutrition/conversations', createNutritionConversationRoutes<Env>({
      context: c => c.get('accountContext'), lifecycle: bindings, controller: nutrition,
    }));
    app.post('/v1/grounded-answers', async (c, next) => {
      const actor = Object.freeze({ ...c.get('accountContext') });
      assertActive(db, actor);
      if (!groundedAnswers.configured) throw new DomainError(501, 'grounded_answer_unavailable');
      await next();
      assertActive(db, actor);
    }, bodyLimit({ maxSize: 64 * 1024,
      onError: c => c.json({ error: { code: 'body_too_large', message: 'The request exceeds its byte limit.' } }, 413),
    }), async c => {
      const actor = Object.freeze({ ...c.get('accountContext') });
      assertActive(db, actor);
      if (!groundedAnswers.configured) throw new DomainError(501, 'grounded_answer_unavailable');
      let input: unknown;
      try { input = await body(c, z.unknown()); }
      catch (error) { assertActive(db, actor); throw error; }
      const answer = groundedAnswers.answer(actor, input, original => assertActive(db, original));
      assertActive(db, actor);
      return c.json(answer);
    });
    const account = (c: ApiContext) => { assertActive(db, c.get('accountContext')); return c.get('accountId'); };
    if (accountModules) app.route('/v1/bug-reports', createBugIntakeRoutes<Env>({
      context: c => { const actor = c.get('accountContext'); assertActive(db, actor); return actor; },
      serviceFor: accountModules.bugFor,
    }));
    type ChildEnv = { Bindings:{actor:AccountContext} };
    const childContext = (c:Context):AccountContext => {
      const actor=(c.env as ChildEnv['Bindings']).actor; assertActive(db,actor); return actor;
    };
    const boardApp=new Hono<ChildEnv>();
    const boardRoutes=createFeatureBoardRoutes({context:childContext,serviceFor:actor=>{
      if(!requestFactories) throw new DomainError(503,'board_unavailable'); return requestFactories.boardFor(actor);
    }});
    boardRoutes.all('*',c=>c.json({error:{code:'not_found'}},404)); boardApp.route('/v1/community/board',boardRoutes);
    const parentApp=new Hono<ChildEnv>();
    parentApp.route('/v1/community',createCommunityRoutes({context:childContext,serviceFor:actor=>{
      if(!requestFactories) throw new DomainError(503,'community_unavailable'); return requestFactories.serviceFor(actor);
    }}));
    const extensionApp=new Hono<ChildEnv>();
    extensionApp.route('/v1/community',createCommunityExtensionRoutes({context:childContext,serviceFor:actor=>{
      if(!requestFactories) throw new DomainError(503,'community_extension_unavailable'); return requestFactories.extensionFor(actor);
    }}));
    app.all('/v1/community/*',c=>{
      const path=c.req.path.slice('/v1/community'.length), namespace=communityNamespace(path,c.req.method);
      if(!namespace) return c.json({error:{code:'not_found'}},404);
      if((runtime || config.sourceRequestFactories?.communityModules==='b2-b4-b5') &&
        !config.sourceRequestFactories?.communityExtension?.textModeration && requiresTextPort(path,c.req.method)) throw new DomainError(503,'community_text_moderation_unavailable');
      const child=namespace==='board'?boardApp:namespace==='extension'?extensionApp:parentApp;
      return child.fetch(c.req.raw,Object.freeze({actor:Object.freeze({...c.get('accountContext')})}));
    });
    if (requestFactories?.activityIntegration) {
      const integration = requestFactories.activityIntegration;
      app.use('/v1/activity/*', async (c, next) => {
        const lease = integration.openOwnerRequest(c.get('accountContext'));
        c.set('activityContext', lease.context);
        try { await next(); } finally { lease.release(); }
      });
      mountActivityRoutes(app, { service: integration.service, context: c => c.get('activityContext') });
    } else app.all('/v1/activity/*', () => { throw new DomainError(503, 'activity_persistability_unavailable'); });
    app.get('/v1/body/capabilities', c => c.json(bodyCapabilities(!!bodyMeasurements, !!config.sourceManualRetention && !!bodyMeasurements?.manualRetention)));
    app.route('/v1/body/measurements', createBodyMeasurementRoutes({
      context: c => { const actor = c.get('accountContext') as AccountContext; assertActive(db, actor); return actor; },
      ...(bodyMeasurements ? { serviceFor: () => bodyMeasurements } : {}),
    }));
    app.route('/v1/body/manual-retention', createManualRetentionRoutes({
      context: c => { const actor = c.get('accountContext') as AccountContext; assertActive(db, actor); return actor; },
      ...(config.sourceManualRetention && bodyMeasurements?.manualRetention ? { serviceFor: () => bodyMeasurements.manualRetention! } : {}),
    }));
    app.all('/v1/body/operations/:operation', c => rejectBodyOperation(
      Object.freeze({ accountId: account(c) }), c.req.param('operation') as BodyOperation));
    app.all('/v1/body/*', c => rejectBodyOperation(Object.freeze({ accountId: account(c) }), 'save_assessment'));
    const id = (c: ApiContext, field: string) => s.resourceId.parse(c.req.param(field));
    const invalidateTraining = (actor: AccountContext, sources: readonly FeedbackSourceKey[]): void => {
      if (!hasRetainedFeedbackWithinWrite(db, writer, actor)) return;
      const trainingFeedback = accountModules?.trainingFeedback;
      if (!trainingFeedback) throw new DomainError(503, 'training_feedback_bindings_unavailable');
      trainingFeedback.invalidateWithinWrite(actor, sources);
    };
    const firstPlan = createFirstPlanHost(domain, config.sourceFirstPlan, { writer,
      afterPlanWriteWithinWrite: (actor, plan) => invalidateTraining(actor, [{ kind: 'plan', id: plan.id }]) });
    const changed = <T>(c: ApiContext, effect: () => T, sources: (result: T) => readonly FeedbackSourceKey[]): T => {
      const actor = Object.freeze({ ...c.get('accountContext') });
      writer.assertWithinWrite(actor);
      const result = effect(); invalidateTraining(actor, sources(result)); writer.assertWithinWrite(actor); return result;
    };
    const receipt = (c: ApiContext, operation: string, intent: unknown, authorize: () => void, effect: () => CommandResult) => {
      const result = bindings.withActiveWrite(c.get('accountContext'), () => command(db, account(c), operation, c.req.header('idempotency-key'), intent, authorize, effect));
      return c.json(result.body as Record<string, unknown>, result.status);
    };
    app.get('/v1/me', c => c.json({ accountId: account(c), appAccountToken: account(c), profile: domain.document(account(c), 'profile'), preferences: domain.document(account(c), 'preferences'), onboarding: domain.onboarding(account(c)) }));
    app.get('/v1/me/settings', c => c.json({ ...readAccountSettings(db, account(c), c.get('authUserId')), runtimeModules:runtimeReadiness(), stagedAccountLifecycle: {
      status: publicLifecycle ? 'configured_unverified' : 'unavailable', initiation: publicLifecycle, passwordActionReauthentication: publicLifecycle,
      phoneActionReauthentication: false, oauthActionReauthentication: false, wholeAccountDeletionComplete: false, exportMaxBytes: 16 * 1024 * 1024, billingCancellation: 'not_performed' } }));
    app.post('/v1/me/account-action-grants', async c => {
      if (!publicLifecycle || !lifecycle) throw new DomainError(501, 'staged_account_lifecycle_unavailable');
      const input = await body(c, actionGrantRequest);
      const activeLifecycle=lifecycle;
      return c.json(await activeLifecycle.issueGrant(c.get('accountContext'), input, async () => {
        const result = await auth.api.verifyPassword({ headers: c.req.raw.headers, body: { password: input.password } });
        return result.status === true;
      }), 201);
    });
    app.post('/v1/me/deletion-requests', async c => {
      if (!publicLifecycle || !lifecycle) throw new DomainError(501, 'staged_account_lifecycle_unavailable');
      const input = await body(c, deletionRequest);
      return c.json(lifecycle.initiate(c.get('accountContext'), c.req.header('idempotency-key'), input), 201);
    });
    app.post('/v1/me/deletion-requests/:requestId/confirm', async c => {
      if (!publicLifecycle || !lifecycle) throw new DomainError(501, 'staged_account_lifecycle_unavailable');
      const input = await body(c, deletionConfirmation);
      return c.json(lifecycle.confirm(c.get('accountContext'), z.uuid().parse(c.req.param('requestId')), input));
    });
    app.post('/v1/me/account-export', async c => {
      if (!publicLifecycle || !lifecycle) throw new DomainError(501, 'staged_account_lifecycle_unavailable');
      const input = await body(c, exportRequest);
      const actor = c.get('accountContext');
      lifecycle.consumeExportGrant(actor, input.grant);
      const result = buildAccountExport(db, actor, context => assertActive(db, context), lifecycle.adapters);
      c.header('Content-Type', 'application/json; charset=utf-8');
      c.header('Content-Disposition', 'attachment; filename="form-account-export.json"');
      assertActive(db, actor);
      return c.body(result.json);
    });
    app.get('/v1/me/profile', c => c.json(domain.document(account(c), 'profile')));
    app.patch('/v1/me/profile', async c => { const input = await body(c, s.profilePatch);
      return c.json(bindings.withActiveWrite(c.get('accountContext'), () => changed(c,
        () => domain.patchDocument<s.Profile>(account(c), 'profile', input), () => []))); });
    app.get('/v1/me/preferences', c => c.json(domain.document(account(c), 'preferences')));
    app.patch('/v1/me/preferences', async c => {
      const input = await body(c, s.preferencesPatch);
      const update = () => changed(c, () => domain.patchDocument<s.Preferences>(account(c), 'preferences', input), () => []);
      if (c.req.header('idempotency-key')) return receipt(c, 'preferences.patch', input, () => {}, () => ({ status: 200, body: update() }));
      return c.json(bindings.withActiveWrite(c.get('accountContext'), update));
    });
    app.get('/v1/me/onboarding', c => c.json(domain.onboarding(account(c))));
    app.patch('/v1/me/onboarding', async c => { const input = await body(c, s.onboardingPatch);
      return c.json(withActiveWrite(db, c.get('accountContext'), () => domain.patchOnboarding(account(c), input))); });
    app.post('/v1/me/onboarding/complete', async c => {
      const input = await body(c, s.revisionCommand);
      return receipt(c, 'onboarding.complete', input, () => { domain.onboarding(account(c)); },
        () => ({ status: 200, body: changed(c, () => domain.completeOnboarding(account(c), input.expectedRevision), () => []) }));
    });
    app.get('/v1/exercises', c => c.json({ items: domain.exercises() }));
    app.get('/v1/exercises/:exerciseId', c => c.json(domain.exercise(id(c, 'exerciseId'))));
    app.get('/v1/plans', c => c.json({ items: domain.plans(account(c)) }));
    app.post('/v1/plans/first', async c => {
      const input = await body(c, s.firstPlanConfirmation);
      const result = await firstPlan.create(c.get('accountContext'), input, c.req.header('idempotency-key'));
      account(c);
      return c.json(result, 201);
    });
    app.post('/v1/plans', async c => {
      const input = await body(c, s.planFields);
      return receipt(c, 'plan.create', input, () => {}, () => ({ status: 201,
        body: changed(c, () => domain.createPlan(account(c), input), plan => [{ kind: 'plan', id: plan.id }]) }));
    });
    app.get('/v1/plans/:planId', c => c.json(domain.plan(account(c), id(c, 'planId'))));
    app.patch('/v1/plans/:planId', async c => { const input = await body(c, s.planPatch);
      return c.json(bindings.withActiveWrite(c.get('accountContext'), () => changed(c,
        () => domain.patchPlan(account(c), id(c, 'planId'), input), plan => [{ kind: 'plan', id: plan.id }]))); });
    app.post('/v1/plans/:planId/archive', async c => {
      const planId = id(c, 'planId'), input = await body(c, s.revisionCommand);
      return receipt(c, `plan.archive:${planId}`, input, () => { domain.plan(account(c), planId); },
        () => ({ status: 200, body: changed(c, () => domain.archivePlan(account(c), planId, input.expectedRevision), () => [{ kind: 'plan', id: planId }]) }));
    });
    app.post('/v1/workout-sessions', async c => {
      const input = await body(c, s.sessionCreate);
      return receipt(c, 'session.create', input, () => { domain.plan(account(c), input.planId); },
        () => ({ status: 201, body: changed(c, () => domain.startSession(account(c), input.planId, input.expectedPlanRevision), session => [{ kind: 'session', id: session.id }]) }));
    });
    app.get('/v1/workout-sessions/:sessionId', c => c.json(domain.session(account(c), id(c, 'sessionId'))));
    app.post('/v1/workout-sessions/:sessionId/sets', async c => {
      const sessionId = id(c, 'sessionId'), input = await body(c, z.union([s.setCreate, s.sourceSetCreate]));
      return receipt(c, `set.create:${sessionId}`, input, () => domain.authorizeOccurrence(account(c), sessionId, input.occurrenceId),
        () => ({ status: 201, body: changed(c, () => domain.createSet(account(c), sessionId, input), () => [{ kind: 'session', id: sessionId }]) }));
    });
    app.patch('/v1/workout-sessions/:sessionId/sets/:setId', async c => {
      const sessionId = id(c, 'sessionId'), setId = id(c, 'setId'), input = await body(c, z.union([s.setPatch, s.sourceSetPatch]));
      return receipt(c, `set.edit:${sessionId}:${setId}`, input, () => { domain.set(account(c), sessionId, setId); },
        () => ({ status: 200, body: changed(c, () => domain.patchSet(account(c), sessionId, setId, input), () => [{ kind: 'session', id: sessionId }]) }));
    });
    app.post('/v1/workout-sessions/:sessionId/sets/:setId/void', async c => {
      const sessionId = id(c, 'sessionId'), setId = id(c, 'setId'), input = await body(c, s.revisionCommand);
      return receipt(c, `set.void:${sessionId}:${setId}`, input, () => { domain.set(account(c), sessionId, setId); },
        () => ({ status: 200, body: changed(c, () => domain.voidSet(account(c), sessionId, setId, input.expectedRevision), () => [{ kind: 'session', id: sessionId }]) }));
    });
    app.post('/v1/workout-sessions/:sessionId/complete', async c => {
      const sessionId = id(c, 'sessionId'), input = await body(c, s.revisionCommand);
      return receipt(c, `session.complete:${sessionId}`, input, () => { domain.session(account(c), sessionId); },
        () => ({ status: 200, body: changed(c, () => domain.completeSession(account(c), sessionId, input.expectedRevision), () => [{ kind: 'session', id: sessionId }]) }));
    });
    app.get('/v1/history', c => {
      const limit = z.coerce.number().int().min(1).max(50).parse(c.req.query('limit') ?? '20');
      const before = c.req.query('before'); if (before) z.string().min(1).max(256).parse(before);
      return c.json(domain.history(account(c), limit, before));
    });
    app.get('/v1/stats', c => c.json(domain.stats(account(c))));
    app.get('/v1/exercises/:exerciseId/cue-preferences', c => c.json(withActiveWrite(db, c.get('accountContext'), () => domain.cues(account(c), id(c, 'exerciseId')))));
    app.patch('/v1/exercises/:exerciseId/cue-preferences', async c => { const input = await body(c, s.cuePatch);
      return c.json(withActiveWrite(db, c.get('accountContext'), () => domain.patchCues(account(c), id(c, 'exerciseId'), input))); });
    app.get('/v1/entitlements', c => {
      const promo = domain.entitlements(account(c)), apple = purchases.entitlements(account(c));
      return c.json({ accountId: account(c), appAccountToken: account(c), grants: [...promo.grants, ...apple.grants],
        active: [...new Set([...promo.active, ...apple.active])], purchases: purchases.capabilities() });
    });
    app.post('/v1/promo-redemptions', async c => {
      const input = await body(c, s.promoRedemption);
      return receipt(c, 'promo.redeem', { code: input.code.toUpperCase() }, () => {}, () => ({ status: 201, body: domain.redeem(account(c), input.code) }));
    });
    app.post('/v1/purchases/apple/verify', async c => {
      const input = await body(c, z.unknown());
      const parsed = parseAppleDeliveryRequest(input);
      if (!parsed) throw new DomainError(422, 'invalid_request');
      const key = c.req.header('idempotency-key');
      if (key && key !== parsed.idempotencyKey) throw new DomainError(409, 'idempotency_mismatch');
      if (!appleConfig) throw new DomainError(501, 'purchase_verification_unconfigured');
      return c.json(await purchases.deliver(account(c), parsed, c.get('accountContext')));
    });
    app.post('/v1/transcriptions', async c => {
      if (!config.grok) throw new DomainError(501, 'transcription_unconfigured');
      if (c.req.header('content-type') !== 'audio/wav') throw new DomainError(415, 'wav_required');
      return c.json(await transcription.transcribe(account(c), c.req.header('idempotency-key'), new Uint8Array(await c.req.arrayBuffer()), c.get('accountContext')), 201);
    });
    app.get('/v1/transcriptions/:attemptId', c => c.json(transcription.get(account(c), id(c, 'attemptId'))));
    return { ...(lifecycle?{lifecycle}:{}), ...(accountModules?{sourceAccountModules:accountModules}:{}), ...(lifecycleFactories?{reconcileModulesRestore:lifecycleFactories.reconcileRestore}:{}), app, auth, domain, db, migrationBackups: storage.migrationBackups,
      handleRequest: (request, peerAddress) => {
        if(closing) return new Response(null,{status:503});
        runtime?.assertServing();
        const headers = new Headers(request.headers);
        headers.set('x-form-peer-ip', peerAddress);
        headers.delete('x-forwarded-for'); headers.delete('x-real-ip');
        // Copying Request wraps its body in an eagerly pulled stream; preserve the untouched body until a route reads it.
        const init: RequestInit & { duplex: 'half' } = {
          method: request.method, headers, body: request.body, duplex: 'half', signal: request.signal,
          cache: request.cache, credentials: request.credentials, integrity: request.integrity,
          keepalive: request.keepalive, mode: request.mode, redirect: request.redirect,
          referrer: request.referrer, referrerPolicy: request.referrerPolicy,
        };
        return app.fetch(new Request(request.url, init));
      }, close: (clean=true) => {
        if(closing) return; closing=true; nutrition?.close();
        if(activeRequests) { runtime?.close(false); if(db.open) db.close(); throw new Error('Requests must drain before clean close'); }
        if(runtime) runtime.close(clean); else if(db.open) db.close();
      } };
  } catch (error) { nutrition?.close(); if(runtime) runtime.close(false); else if(db.open) db.close(); throw error; }
}
