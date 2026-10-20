import { randomBytes } from 'node:crypto';
import type { Sqlite } from '../../storage.js';
import type { AccountContext, LifecycleAdapter, LifecycleResult } from '../../lifecycle/types.js';
import type { DirectConnectionBinding, DirectProvider, DirectProviderCommitProof, PrepareDirectConnection } from '../types.js';
import type { WearablePersistenceDependencies } from '../persistence/types.js';
import { createWearablePersistence } from '../persistence/store.js';
import { createWearableLifecycleAdapter } from '../persistence/lifecycle.js';
import { createWearablesService } from '../service.js';
import { day, digest, fail, stable } from '../validation.js';
import { createProviderOAuth } from '../providers/oauth.js';
import type { OAuthVault } from '../providers/oauth.js';
import { createOuraReadPort } from '../providers/oura.js';
import type { OuraCollection } from '../providers/oura.js';
import { createGarminPort } from '../providers/garmin.js';
import { importProviderPage } from '../providers/importer.js';
import { createDirectProviderTransport } from './index.js';
import type { ProviderScope, ScopedSecretResolver, TransportPrimitive } from './index.js';
import { createNodeAuthCipher } from './node-auth-cipher.js';
import { createSqliteAuthStateStore } from './sqlite-auth-store.js';
import { authStateKey, createProviderAuthState } from './auth-state.js';
import type { AuthStateOptions } from './auth-state-types.js';
import { createProviderAuthLifecycle } from './auth-lifecycle.js';
import { createProviderConnectionAuthPurge } from './connection-auth-purge.js';

export interface ProviderControllerOptions {
  context: AccountContext;
  root: WearablePersistenceDependencies;
  key: Uint8Array;
  // Verify the supplied database is root's actual writer handle, including authorized lifecycle writers.
  assertRootWriter(db: Sqlite): void;
  enabled(): boolean;
  assertAllowed(provider: DirectProvider, purpose: string): void;
  assertRefreshUsable: AuthStateOptions['assertRefreshUsable'];
  now(): number;
  newKey(): string;
  transport: TransportPrimitive;
  providers: Readonly<Record<DirectProvider, Readonly<{
    clientId: string; clientSecretRef: string; clientSecrets: ScopedSecretResolver;
    allowedRedirectUris: readonly string[]; stateLifetimeMs: number;
  }>>>;
  decodeGarminPermissions?(body: unknown): string[];
}

export function createProviderController(input: ProviderControllerOptions) {
  const ctx = Object.freeze({ ...input.context }), root = input.root, db = root.db;
  const unavailable = (): LifecycleResult => ({ status: 'unavailable', reason: 'other_wearable_external_duties_required' });
  const assertContext = (requested: AccountContext) => {
    if (stable(requested) !== stable(ctx)) fail('provider_original_context_required', 403);
    root.lifecycle.assertActive(ctx);
  };
  const within = () => { input.assertRootWriter(db); root.control.assertWithinWrite(ctx); };
  const authStore = createSqliteAuthStateStore({ db, assertRootWriter: input.assertRootWriter,
    runRootWrite: effect => root.lifecycle.withActiveWrite(ctx, () => { within(); return effect(); }) });
  const cipher = createNodeAuthCipher({ key: input.key });
  const authLifecycle = createProviderAuthLifecycle({ store: authStore, assertAccountCurrent: assertContext,
    assertSuppression(account, epoch) { if (account !== ctx.accountId) fail('provider_original_context_required', 403); root.control.assertSuppression(account, epoch); },
    purgeReadiness(request, account) {
      if (account !== ctx.accountId) return { status: 'unavailable', reason: 'provider_original_context_required' };
      const result = root.control.purgeReadiness(request, account);
      if (result.status === 'ready') return { status: 'ready', epoch: result.epoch };
      if (result.status === 'complete') return { status: 'unknown', reason: 'provider_purge_readiness_unproved' };
      return { status: result.status, ...(result.reason === undefined ? {} : { reason: result.reason }) };
    } });
  function together(local: () => LifecycleResult, other: (() => LifecycleResult) | undefined, mutate: boolean): LifecycleResult {
    if (!other) return unavailable();
    let failure: LifecycleResult = { status: 'unknown', reason: 'provider_external_composition_unproved' };
    const effect = () => {
      const first = local(); if (first.status !== 'complete') { failure = first; throw Error('local incomplete'); }
      const second = other(); if (second.status !== 'complete') { failure = second; throw Error('external incomplete'); }
      return { status: 'complete' as const, count: (first.count ?? 0) + (second.count ?? 0), reason: 'local_external_components_complete_remote_revocation_unproved' };
    };
    try {
      if (!mutate) return effect();
      authStore.currentTransaction(); return authStore.transaction(effect);
    } catch { return failure; }
  }
  const other = root.externalLifecycle;
  const externalLifecycle: LifecycleAdapter = {
    category: 'direct_provider_composition',
    inventory: context => ({ ...together(() => authLifecycle.inventory(context), other ? () => other.inventory(context) : undefined, false), category: 'direct_provider_composition' }),
    export: (context, snapshot) => ({ ...together(() => authLifecycle.export(context, snapshot), other ? () => other.export(context, snapshot) : undefined, false), category: 'direct_provider_composition' }),
    suppress: (account, epoch) => together(() => authLifecycle.suppress(account, epoch), other ? () => other.suppress(account, epoch) : undefined, true),
    purge: (request, account) => together(() => authLifecycle.purge(request, account), other ? () => other.purge(request, account) : undefined, true),
    verifySuppressed: (account, epoch) => together(() => authLifecycle.verifySuppressed(account, epoch), other ? () => other.verifySuppressed(account, epoch) : undefined, false),
  };
  const deps: WearablePersistenceDependencies = { ...root, externalLifecycle,
    externalConnectionPurge(context, scope) {
      return together(() => localPurge(context, scope), root.externalConnectionPurge ? () => root.externalConnectionPurge!(context, scope) : undefined, true);
    } };
  const persistence = createWearablePersistence(deps);
  const localPurge = createProviderConnectionAuthPurge({ authStore, wearableStore: persistence.store,
    assertActive: assertContext, assertWithinWrite: root.control.assertWithinWrite });
  const scopeFor = (binding: DirectConnectionBinding): ProviderScope => ({ accountId: ctx.accountId, sessionId: ctx.sessionId,
    epoch: ctx.epoch, provider: binding.provider, connectionId: binding.connectionId, generation: binding.generation });
  function assertCurrent(scope: ProviderScope): void {
    assertContext(ctx); if (!input.enabled()) fail('health_not_configured', 503);
    root.assertImportAllowed(ctx, scope.provider);
    const connection = persistence.store.connection(ctx, scope.connectionId);
    if (!connection || connection.provider !== scope.provider || connection.generation !== scope.generation || !connection.retentionConsent ||
      (connection.connected ? !!connection.pendingAuthorization : connection.pendingAuthorization?.sessionId !== ctx.sessionId || connection.pendingAuthorization?.epoch !== ctx.epoch))
      fail('provider_connection_changed', 409);
    if (scope.accountId !== ctx.accountId || scope.sessionId !== ctx.sessionId || scope.epoch !== ctx.epoch) fail('provider_original_context_required', 403);
    assertContext(ctx);
  }
  function committed(context: AccountContext, binding: DirectConnectionBinding, proof: DirectProviderCommitProof): void {
    assertContext(context); within(); const scope = scopeFor(binding); assertCurrent(scope);
    const record = authStore.currentTransaction().get(authStateKey(scope));
    const op = record?.operations.find(value => value.operationId === proof.operationId);
    if (!record || stable(record.scope) !== stable(scope) || record.suppressedEpoch !== null || !record.tokens ||
      !op || op.kind !== 'code' || op.phase !== 'committed' || !op.receipt || op.receipt.version !== proof.version ||
      op.expectedVersion + 1 !== proof.version || record.tokens.version < proof.version) fail('provider_committed_code_required', 409);
    assertCurrent(scope); within();
  }
  const service = createWearablesService({ store: persistence.store, enabled: input.enabled, now: () => new Date(input.now()).toISOString(),
    assertActive: assertContext, withActiveWrite: (context, effect) => { assertContext(context); return root.lifecycle.withActiveWrite(ctx, () => { within(); return effect(); }); },
    assertImportAllowed: root.assertImportAllowed, assertProviderCommittedWithinWrite: committed });
  function session(requested: DirectConnectionBinding) {
    const binding = Object.freeze({ ...requested }), scope = Object.freeze(scopeFor(binding));
    if (!['oura', 'garmin'].includes(binding.provider)) fail('health_invalid_provider');
    assertCurrent(scope);
    const configuration = input.providers[binding.provider];
    const auth = createProviderAuthState({ ...configuration, scope, store: authStore, cipher, randomBytes,
      assertCurrent, assertRefreshUsable: input.assertRefreshUsable, now: input.now });
    const admission = { assertCurrent: () => assertCurrent(scope), assertAllowed: input.assertAllowed };
    const http = createDirectProviderTransport({ scope, assertCurrent, secrets: auth.secrets, transport: input.transport,
      allowedRedirectUris: configuration.allowedRedirectUris });
    const vault: OAuthVault = { ...auth.vault, commit(leaseId, tokens) {
      // Token CAS and connection activation share this savepoint; no successful token-only commit escapes activation failure.
      return authStore.transaction(tx => {
        assertCurrent(scope); within();
        const operation = tx.get(authStateKey(scope))?.operations.find(value => value.leaseId === leaseId);
        if (!operation) fail('provider_exchange_required', 409);
        const result = auth.vault.commit(leaseId, tokens);
        if (operation.kind === 'code') service.activateDirectProviderConnectionWithinWrite(ctx,
          'provider-activation:' + digest([scope, operation.operationId]), binding, { operationId: operation.operationId, version: result.version });
        assertCurrent(scope); within(); return result;
      });
    } };
    const oauth = createProviderOAuth({ provider: binding.provider, clientId: configuration.clientId, clientSecretRef: configuration.clientSecretRef,
      http, vault, admission, now: input.now, consumeCallback: auth.consumeCallback });
    const active = () => { assertCurrent(scope); service.authorizeImport(ctx, binding.provider, binding.connectionId, binding.generation); };
    const accessReference = () => authStore.transaction(tx => {
      active(); const record = tx.get(authStateKey(scope));
      if (!record || stable(record.scope) !== stable(scope) || record.suppressedEpoch !== null || !record.tokens) fail('provider_access_required', 409);
      return record.tokens.access.reference;
    });
    const garmin = () => {
      if (binding.provider !== 'garmin') fail('health_route_mismatch', 403); active();
      return createGarminPort({ http, accessSecretRef: accessReference(), admission, now: input.now,
        ...(input.decodeGarminPermissions ? { decodePermissions: input.decodeGarminPermissions } : {}) });
    };
    return {
      beginAuthorization(redirect: string, scopes: string[]) {
        input.assertAllowed(binding.provider, 'oauth'); assertCurrent(scope);
        if (persistence.store.connection(ctx, binding.connectionId)?.connected) fail('health_already_connected', 409);
        return auth.beginAuthorization(redirect, scopes);
      },
      completeCode: oauth.completeCode,
      refresh(operationId: string) { active(); return oauth.refresh(operationId); },
      reconcile: auth.reconcile,
      async importOuraPage(request: { collection: OuraCollection; from: string; to: string; cursor: string | null }) {
        if (binding.provider !== 'oura') fail('health_route_mismatch', 403);
        input.assertAllowed('oura', 'read_only_import');
        const range = Object.freeze({ ...request }); day(range.from); day(range.to); if (range.from > range.to) fail('health_invalid_window');
        const stream = 'oura:' + digest([range.collection, range.from, range.to]);
        return importProviderPage({ ctx, provider: 'oura', connectionId: binding.connectionId, generation: binding.generation,
          stream, cursor: range.cursor, service, newKey: input.newKey, assertCurrent: active,
          intent: persistence.providerIntent({ ctx, provider: 'oura', connectionId: binding.connectionId, generation: binding.generation, stream, cursor: range.cursor }),
          source: { read: cursor => createOuraReadPort({ http, accessSecretRef: accessReference(), admission, now: input.now })
            .read(range.collection, { from: range.from, to: range.to, nextToken: cursor }) } });
      },
      garminUserId: () => garmin().userId(),
      garminPermissions: () => garmin().permissions(),
      garminHealthUnavailable(): never { return fail('garmin_approved_payload_contract_required', 503); },
    };
  }
  return { prepare: (key: string, value: PrepareDirectConnection) => service.prepareDirectProviderConnection(ctx, key, value), session,
    disconnect: (key: string, binding: DirectConnectionBinding) => service.disconnect(ctx, key, { connectionId: binding.connectionId, generation: binding.generation }),
    wearables: service, lifecycle: createWearableLifecycleAdapter(deps) };
}
