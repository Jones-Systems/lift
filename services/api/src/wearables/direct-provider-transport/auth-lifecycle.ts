import type { AccountContext, LifecycleAdapter, LifecycleResult, SafeExportSection, ScopedInventory } from '../../lifecycle/types.js';
import { accountAuthRecords, AuthStateFailure, validateAuthStateRecord } from './auth-state.js';
import type { AuthLifecycleOptions, AuthStateRecord, AuthStateTransaction } from './auth-state-types.js';

export function createProviderAuthLifecycle(input: AuthLifecycleOptions): LifecycleAdapter {
  const { store, assertAccountCurrent, assertSuppression, purgeReadiness } = input;
  const max = input.maxAccountRecords ?? 64, category = 'direct_provider_auth';
  if (!Number.isSafeInteger(max) || max < 1 || max > 256) throw new AuthStateFailure('auth_state_invalid');
  const records = (tx: AuthStateTransaction, accountId: string) => accountAuthRecords(tx, accountId, max);
  function proof(accountId: string, epoch: number): AuthStateTransaction {
    if (typeof accountId !== 'string' || !accountId.length || !Number.isSafeInteger(epoch) || epoch < 1) throw new AuthStateFailure('auth_state_invalid');
    const tx = store.currentTransaction(); assertSuppression(accountId, epoch); return tx;
  }
  function suppressed(values: AuthStateRecord[], epoch: number): boolean {
    return values.every(record => record.suppressedEpoch === epoch && record.scope.epoch < epoch &&
      record.flows.every(flow => flow.verifier === null) && !record.operations.some(op => op.phase === 'leased'));
  }
  function verify(accountId: string, epoch: number): LifecycleResult {
    try {
      const tx = proof(accountId, epoch);
      const confirmed = suppressed(records(tx, accountId), epoch); assertSuppression(accountId, epoch);
      return confirmed ? { status: 'complete', reason: 'local_auth_access_suppressed_remote_revocation_unproved' } : { status: 'pending', reason: 'local_auth_suppression_pending' };
    } catch { return { status: 'unknown', reason: 'authoritative_suppression_unproved' }; }
  }
  function read<T>(context: AccountContext, effect: (values: AuthStateRecord[]) => T): T {
    try {
      return store.transaction(tx => {
        assertAccountCurrent(context); const result = effect(records(tx, context.accountId)); assertAccountCurrent(context); return result;
      });
    } catch { throw new AuthStateFailure('auth_state_unavailable'); }
  }
  return {
    category,
    inventory(context) { return read<ScopedInventory>(context, values => ({ status: 'complete', category, count: values.length, reason: 'local_encrypted_auth_records_only' })); },
    export(context, snapshot) {
      return read<SafeExportSection>(context, values => {
        if (!snapshot || !Number.isSafeInteger(snapshot.snapshotAtMs) || snapshot.snapshotAtMs < 0) throw new AuthStateFailure('auth_state_invalid');
        snapshot.append(category, { recordCount: values.length, unresolvedOperationCount: values.reduce((sum, record) =>
          sum + record.operations.filter(op => ['ready', 'leased', 'unknown'].includes(op.phase)).length, 0),
          omissions: ['credentials', 'ciphertext', 'secret_references', 'callback_state', 'pkce', 'operation_identifiers'] });
        return { status: 'complete', category, count: values.length, reason: 'auth_metadata_only_credentials_omitted' };
      });
    },
    suppress(accountId, epoch) {
      // Root may catch hook failures. A same-transaction savepoint must roll back this hook's partial writes before that catch.
      try {
        store.currentTransaction();
        return store.transaction<LifecycleResult>(() => {
        const tx = proof(accountId, epoch);
        for (const record of records(tx, accountId)) {
          if (record.scope.epoch >= epoch || (record.suppressedEpoch !== null && record.suppressedEpoch !== epoch)) throw new AuthStateFailure('auth_state_conflict');
          const revision = record.revision; record.suppressedEpoch = epoch;
          for (const flow of record.flows) { flow.status = 'retired'; flow.verifier = null; }
          for (const op of record.operations) if (op.phase === 'leased') op.phase = 'unknown';
          record.revision++; validateAuthStateRecord(record);
          if (!tx.compareAndSwap(record.key, revision, record)) throw new AuthStateFailure('auth_state_conflict');
        }
        assertSuppression(accountId, epoch);
        if (!suppressed(records(tx, accountId), epoch)) throw new AuthStateFailure('auth_state_conflict');
        return { status: 'complete', reason: 'local_auth_access_suppressed_remote_revocation_unproved' };
        });
      } catch { throw new AuthStateFailure('auth_state_unavailable'); }
    },
    purge(requestId, accountId) {
      try {
        store.currentTransaction();
        return store.transaction<LifecycleResult>(() => {
        if (typeof requestId !== 'string' || !requestId.length || requestId.length > 256) throw new AuthStateFailure('auth_state_invalid');
        const ready = purgeReadiness(requestId, accountId);
        if (ready.status !== 'ready') return ready;
        const tx = proof(accountId, ready.epoch), before = records(tx, accountId);
        if (!suppressed(before, ready.epoch)) return { status: 'pending', reason: 'local_auth_suppression_required' };
        for (const record of before) if (!tx.delete(record.key, record.revision)) throw new AuthStateFailure('auth_state_conflict');
        assertSuppression(accountId, ready.epoch);
        if (records(tx, accountId).length) throw new AuthStateFailure('auth_state_conflict');
        return { status: 'complete', count: before.length, reason: 'local_auth_records_absent_remote_revocation_unproved' };
        });
      } catch { throw new AuthStateFailure('auth_state_unavailable'); }
    },
    verifySuppressed: verify,
  };
}
