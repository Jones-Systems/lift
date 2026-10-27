import { openStorage, type Sqlite } from '../storage.js';
import { DomainError } from '../errors.js';
import { CurrentSuppressionAuthority } from '../runtime-modules/currentness.js';
import { AccountLifecycle } from './service.js';
import { LifecycleEvidenceStore, type SourceLifecycleEvidenceWitnessReader } from './evidence-store.js';
import { selectSourceLifecycleEvidenceMigrations } from './source-migrations.js';
import type { LifecycleAdapter } from './types.js';

export { bindSourceLifecycleEvidenceWitnessReader, type SourceLifecycleEvidenceGeneration,
  type SourceLifecycleEvidenceWitnessReader } from './evidence-store.js';
export type SourceLifecycleEvidenceConfiguration = Readonly<{ mode: 'source-only'; cohort: 'lifecycle-evidence-v1' }>;
function configuration(input: SourceLifecycleEvidenceConfiguration): void {
  if (input?.mode !== 'source-only' || input.cohort !== 'lifecycle-evidence-v1' || Object.keys(input).sort().join(',') !== 'cohort,mode')
    throw new DomainError(503, 'lifecycle_evidence_configuration_invalid');
}
export async function openSourceLifecycleEvidenceStorage(path: string, selected: SourceLifecycleEvidenceConfiguration) {
  configuration(selected);
  return openStorage(path, selectSourceLifecycleEvidenceMigrations(), 'selected-migration-22', 'selected-migration-23', 'selected-lifecycle-evidence-24');
}
export function createSourceLifecycleEvidence(input: Readonly<{ configuration: SourceLifecycleEvidenceConfiguration; db: Sqlite;
  authority: CurrentSuppressionAuthority; witness: SourceLifecycleEvidenceWitnessReader; adapters: readonly LifecycleAdapter[]; clock?: () => number }>) {
  configuration(input.configuration);
  if (!(input.authority instanceof CurrentSuppressionAuthority)) throw new DomainError(503, 'lifecycle_evidence_held');
  const evidence = new LifecycleEvidenceStore(input.db, input.witness);
  evidence.assertAuthority(input.authority);
  const adapters = Object.freeze(input.adapters.map(adapter => Object.freeze({ ...adapter })));
  const lifecycle = new AccountLifecycle(input.db, adapters, input.authority, input.clock, evidence);
  return Object.freeze({ lifecycle, completion: (requestId: string) => lifecycle.evidenceProjection(requestId) });
}
