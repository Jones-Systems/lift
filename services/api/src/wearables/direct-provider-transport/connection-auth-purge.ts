import type { AccountContext, LifecycleResult } from '../../lifecycle/types.js';
import type { ReceiptScope, WearableStore } from '../types.js';
import { accountAuthRecords } from './auth-state.js';
import type { AuthStateRecord, DurableAuthStateStore } from './auth-state-types.js';

export interface ProviderConnectionAuthPurgeOptions {
  authStore: DurableAuthStateStore;
  wearableStore: Pick<WearableStore, 'connection'>;
  assertActive(context: AccountContext): void;
  // Root binds both stores to the same database and verifies this exact context's existing writer custody.
  assertWithinWrite(context: AccountContext): void;
  maxAccountRecords?: number;
}
function invalid(): never { throw new Error('provider_auth_purge_unproved'); }

export function createProviderConnectionAuthPurge(input: ProviderConnectionAuthPurgeOptions):
  (context: AccountContext, scope: ReceiptScope) => LifecycleResult {
  const max = input.maxAccountRecords ?? 64;
  if (!Number.isSafeInteger(max) || max < 1 || max > 256) throw new Error('provider_auth_purge_invalid');
  return (context, requested) => {
    try {
      const ctx = Object.freeze({ ...context }), scope = Object.freeze({ ...requested });
      if (![ctx.accountId, ctx.authUserId, ctx.sessionId, scope.connectionId].every(value =>
        typeof value === 'string' && value.length > 0 && value.length <= 2048) ||
        !Number.isSafeInteger(ctx.epoch) || ctx.epoch < 0 ||
        !Number.isSafeInteger(scope.generation) || scope.generation < 0) invalid();
      const retired = (provider?: string): string => {
        input.assertWithinWrite(ctx); input.assertActive(ctx);
        const connection = input.wearableStore.connection(ctx, scope.connectionId);
        if (!connection || connection.id !== scope.connectionId || connection.generation !== scope.generation ||
          connection.connected !== false || connection.retentionConsent !== false ||
          !['oura', 'garmin'].includes(connection.provider) || (provider !== undefined && connection.provider !== provider)) invalid();
        input.assertActive(ctx); input.assertWithinWrite(ctx);
        return connection.provider;
      };
      const matches = (record: AuthStateRecord) => record.scope.accountId === ctx.accountId &&
        record.scope.connectionId === scope.connectionId && record.scope.generation <= scope.generation;
      input.authStore.currentTransaction();
      // Catch outside the savepoint: root may retain its outer transaction after receiving an unknown result.
      return input.authStore.transaction<LifecycleResult>(tx => {
        const provider = retired();
        const before = accountAuthRecords(tx, ctx.accountId, max).filter(matches);
        for (const record of before) {
          retired(provider);
          if (!tx.delete(record.key, record.revision)) invalid();
        }
        retired(provider);
        if (accountAuthRecords(tx, ctx.accountId, max).some(matches)) invalid();
        retired(provider);
        return { status: 'complete', count: before.length, reason: 'local_connection_auth_absent_remote_revocation_unproved' };
      });
    } catch {
      return { status: 'unknown', reason: 'local_connection_auth_purge_unproved' };
    }
  };
}
