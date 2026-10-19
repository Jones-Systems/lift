import { DomainError } from '../errors.js';
import type { AccountContext, ExportSnapshot, LifecycleAdapter, LifecycleResult, ScopedInventory, SafeExportSection } from '../lifecycle/types.js';
import { addCommunityExportBounds, assertCommunityExportBounds, COMMUNITY_EXPORT_MAX_BYTES, COMMUNITY_EXPORT_MAX_ROWS, type CommunityExportBounds } from './export-bounds.js';
export const communityModuleNames = ['b2', 'b4', 'b5'] as const;
export type CommunityModuleName = typeof communityModuleNames[number];
export type CommunityModuleResults = Readonly<Record<CommunityModuleName, LifecycleResult>>;
export type ComposedCommunityResult = LifecycleResult & Readonly<{ modules: CommunityModuleResults; readback?: CommunityModuleResults }>;
export type ComposedCommunityLifecycleAdapter = Readonly<{
  category: 'community';
  inventory: (context: AccountContext) => ScopedInventory & ComposedCommunityResult;
  export: (context: AccountContext, snapshot: ExportSnapshot) => SafeExportSection & ComposedCommunityResult;
  suppress: (accountId: string, epoch: number) => ComposedCommunityResult;
  verifySuppressed: (accountId: string, epoch: number) => ComposedCommunityResult;
  purge: (requestId: string, accountId: string) => ComposedCommunityResult;
}>;
export type CommunityAdapterSet = Readonly<Record<CommunityModuleName, LifecycleAdapter>>;
export type CommunityCompositionOptions = Readonly<{
  assertSerialized: () => void;
  exportBounds: Readonly<Record<CommunityModuleName, (context: AccountContext) => CommunityExportBounds>>;
  maxRows?: number;
  maxBytes?: number;
}>;

function combined(modules: CommunityModuleResults, readback?: CommunityModuleResults): ComposedCommunityResult {
  const values = [...Object.values(modules), ...Object.values(readback ?? {})];
  const status = (['unknown', 'unavailable', 'pending', 'retained'] as const).find(value => values.some(result => result.status === value)) ?? 'complete';
  const count = status === 'complete' && Object.values(modules).every(result => Number.isSafeInteger(result.count) && (result.count ?? -1) >= 0)
    ? Object.values(modules).reduce((total, result) => total + (result.count ?? 0), 0) : undefined;
  return { status, ...(status === 'complete' ? {} : { reason: 'community_module_results_require_resolution' }),
    ...(count === undefined ? {} : { count }), modules, ...(readback ? { readback } : {}) };
}

export function createComposedCommunityLifecycleAdapter(adapters: CommunityAdapterSet, options: CommunityCompositionOptions): ComposedCommunityLifecycleAdapter {
  for (const name of communityModuleNames) if (adapters[name].category !== 'community') throw new DomainError(503, 'community_adapter_category_conflict');
  const maxRows = options.maxRows ?? COMMUNITY_EXPORT_MAX_ROWS, maxBytes = options.maxBytes ?? COMMUNITY_EXPORT_MAX_BYTES;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > COMMUNITY_EXPORT_MAX_ROWS || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > COMMUNITY_EXPORT_MAX_BYTES)
    throw new DomainError(422, 'community_export_budget_invalid');
  const invoke = (effect: (adapter: LifecycleAdapter) => LifecycleResult, rethrowCapacity = false): CommunityModuleResults => {
    const results: Record<CommunityModuleName, LifecycleResult> = { b2: { status: 'unknown' }, b4: { status: 'unknown' }, b5: { status: 'unknown' } };
    let capacity: DomainError | undefined;
    for (const name of communityModuleNames) {
      try { results[name] = effect(adapters[name]); }
      catch (error) {
        results[name] = { status: 'unknown', reason: 'community_module_exception' };
        if (error instanceof DomainError && error.status === 413) capacity ??= error;
      }
    }
    if (rethrowCapacity && capacity) throw capacity;
    return results;
  };
  return {
    category: 'community',
    inventory: context => {
      options.assertSerialized();
      return { category: 'community', ...combined(invoke(adapter => adapter.inventory(context), true)) };
    },
    export: (context, snapshot: ExportSnapshot) => {
      options.assertSerialized();
      // SQL estimates for every module precede all row/JSON materialization.
      const bounds: CommunityExportBounds[] = [];
      let boundsError: unknown;
      for (const name of communityModuleNames) {
        try { bounds.push(options.exportBounds[name](context)); } catch (error) { boundsError ??= error; }
      }
      if (boundsError) throw boundsError;
      assertCommunityExportBounds(addCommunityExportBounds(bounds), maxRows, maxBytes);
      let bytes = 0;
      const bounded: ExportSnapshot = { snapshotAtMs: snapshot.snapshotAtMs, append: (category, value) => {
        if (category !== 'community') throw new DomainError(503, 'community_export_category_conflict');
        const encoded = JSON.stringify(value);
        if (encoded === undefined) throw new DomainError(503, 'community_export_value_invalid');
        bytes += Buffer.byteLength(encoded);
        if (bytes > maxBytes) throw new DomainError(413, 'community_export_capacity');
        snapshot.append(category, value);
      } };
      return { category: 'community', ...combined(invoke(adapter => adapter.export(context, bounded), true)) };
    },
    suppress: (accountId, epoch) => {
      options.assertSerialized();
      const effects = invoke(adapter => adapter.suppress(accountId, epoch));
      const readback = invoke(adapter => adapter.verifySuppressed(accountId, epoch));
      return combined(effects, readback);
    },
    verifySuppressed: (accountId, epoch) => {
      options.assertSerialized(); return combined(invoke(adapter => adapter.verifySuppressed(accountId, epoch)));
    },
    purge: (requestId, accountId) => {
      options.assertSerialized();
      const result = combined(invoke(adapter => adapter.purge(requestId, accountId)));
      if (result.status !== 'complete') return result;
      return { status: 'pending', reason: 'community_composed_purge_unqualified', modules: result.modules };
    },
  };
}
