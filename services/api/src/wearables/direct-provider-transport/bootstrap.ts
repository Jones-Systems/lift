import type { AccountContext } from '../../lifecycle/types.js';
import type { AuthLifecycleOptions } from './auth-state-types.js';
import { createProviderAuthLifecycle } from './auth-lifecycle.js';
import { createSqliteAuthStateStore } from './sqlite-auth-store.js';
import type { SqliteAuthStoreOptions } from './sqlite-auth-store.js';

export interface ProviderAuthStorageOptions {
  activeStoreOptionsFor(originalAccountContext: AccountContext): SqliteAuthStoreOptions;
  lifecycleStoreOptions: SqliteAuthStoreOptions;
  assertAccountCurrent: AuthLifecycleOptions['assertAccountCurrent'];
  assertSuppression: AuthLifecycleOptions['assertSuppression'];
  purgeReadiness: AuthLifecycleOptions['purgeReadiness'];
}
function invalid(): never { throw new Error('provider_auth_bootstrap_invalid'); }
function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function') invalid();
  return value;
}

export function createProviderAuthStorage(input: ProviderAuthStorageOptions) {
  const { activeStoreOptionsFor, assertAccountCurrent, assertSuppression, purgeReadiness } = input;
  const lifecycleOptions = { ...input.lifecycleStoreOptions };
  const lifecycleStore = createSqliteAuthStateStore(lifecycleOptions);
  const lifecycleAdapter = createProviderAuthLifecycle({ store: lifecycleStore, assertAccountCurrent, assertSuppression, purgeReadiness });
  return {
    storeFor(originalContext: AccountContext) {
      const context = Object.freeze({ accountId: originalContext.accountId, authUserId: originalContext.authUserId,
        sessionId: originalContext.sessionId, epoch: originalContext.epoch });
      if (![context.accountId, context.authUserId, context.sessionId].every(value =>
        typeof value === 'string' && value.length > 0 && value.length <= 2048) ||
        !Number.isSafeInteger(context.epoch) || context.epoch < 0) invalid();
      const selected = { ...synchronous(activeStoreOptionsFor(context)) };
      if (selected.db !== lifecycleOptions.db) invalid();
      return createSqliteAuthStateStore({ ...selected,
        assertRootWriter(db) {
          // Currentness requires root's admitted frame; construction alone must not invoke it or mint writer authority.
          synchronous(selected.assertRootWriter(db)); synchronous(assertAccountCurrent(context));
        },
      });
    },
    // WS01 must wrap this raw adapter with its qualified guardLifecycleAdapter before global registration.
    lifecycleAdapter,
  };
}
