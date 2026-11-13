import { openStorage, type Sqlite } from '../../storage.js';
import { DomainError } from '../../errors.js';
import { CurrentSuppressionAuthority } from '../../runtime-modules/currentness.js';
import { AccountLifecycle } from '../service.js';
import { bindSourceLifecycleCurrentness, LifecycleEvidenceStore, type SourceLifecycleEvidenceWitnessReader } from '../evidence-store.js';
import type { SourceLifecycleLocalAbsenceReader } from '../local-absence.js';
import type { LifecycleAdapter } from '../types.js';
import { ProviderRevocationOutbox } from './outbox.js';
import { selectSourceProviderRevocationMigrations } from './source-migrations.js';
import type { BoundedAppleTransport, MaterialCustodian, ProviderRevocationConfiguration } from './types.js';

export { bindSourceLifecycleEvidenceWitnessReader } from '../evidence-store.js';
function configuration(input: ProviderRevocationConfiguration): void {
  if (input?.mode !== 'source-only' || input.cohort !== 'provider-revocation-v1' || Object.keys(input).sort().join(',') !== 'cohort,mode')
    throw new DomainError(503, 'provider_revocation_configuration_invalid');
}
export async function openSourceProviderRevocationStorage(path: string, selected: ProviderRevocationConfiguration) {
  configuration(selected);
  return openStorage(path, selectSourceProviderRevocationMigrations(), 'selected-migration-22', 'selected-migration-23',
    'selected-lifecycle-evidence-24', 'selected-provider-revocation-25');
}
export function createSourceProviderRevocation(input: Readonly<{ configuration: ProviderRevocationConfiguration; db: Sqlite;
  authority: CurrentSuppressionAuthority; witness: SourceLifecycleEvidenceWitnessReader; adapters: readonly LifecycleAdapter[];
  localAbsence?: readonly SourceLifecycleLocalAbsenceReader[]; custodian: MaterialCustodian; transport: BoundedAppleTransport; clock?: () => number }>) {
  configuration(input.configuration);
  if (!(input.authority instanceof CurrentSuppressionAuthority)) throw new DomainError(503, 'provider_revocation_held');
  const evidence = new LifecycleEvidenceStore(input.db, input.witness, input.adapters, input.localAbsence, 'selected-provider-revocation-25');
  evidence.assertAuthority(input.authority);
  const currentness = bindSourceLifecycleCurrentness(input.db, input.witness, 'selected-provider-revocation-25', 'provider-revocation-v1');
  const outbox = new ProviderRevocationOutbox(input.db, currentness, input.custodian, input.transport, input.clock);
  const adapters = Object.freeze(input.adapters.map(adapter => Object.freeze({ ...adapter })));
  const lifecycle = new AccountLifecycle(input.db, adapters, input.authority, input.clock, evidence, outbox.confirmationHook);
  return Object.freeze({ lifecycle, localCompletion: (requestId: string) => lifecycle.evidenceProjection(requestId),
    attemptOne: (intentId: string, attemptId: string, signal?: AbortSignal) => outbox.attemptOne(intentId, attemptId, signal),
    reconcileOne: (attemptId: string) => outbox.reconcileOne(attemptId), providerCompletion: (intentId: string) => outbox.project(intentId) });
}
