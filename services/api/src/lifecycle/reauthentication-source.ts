import { openStorage, type Sqlite } from '../storage.js';
import { DomainError } from '../errors.js';
import { CurrentSuppressionAuthority } from '../runtime-modules/currentness.js';
import { AccountLifecycle } from './service.js';
import { bindSourceLifecycleCurrentness, LifecycleEvidenceStore, type SourceLifecycleEvidenceWitnessReader } from './evidence-store.js';
import type { SourceLifecycleLocalAbsenceReader } from './local-absence.js';
import { ProviderRevocationOutbox } from './providers/outbox.js';
import type { BoundedAppleTransport, MaterialCustodian } from './providers/types.js';
import type { AccountContext, LifecycleAdapter, SourceActionConfiguration, SourceActionDelivery, SourceActionIssue, SourceActionKeys, SourceActionVerify } from './types.js';
import { selectSourceActionReauthenticationMigrations } from './reauthentication-source-migrations.js';
import { bindSourceActionAuthority, readSourceActionContinuity, actionTime, actionId, assertSourceActionContext, type SourceActionContinuityWitness } from './reauthentication-proof.js';
import { SourceActionReauthentication } from './reauthentication.js';

export { bindSourceActionContinuityWitness } from './reauthentication-proof.js';
export { bindSourceLifecycleEvidenceWitnessReader } from './evidence-store.js';
function configuration(input: SourceActionConfiguration): void {
  if (input?.mode !== 'source-only' || input.cohort !== 'action-reauthentication-v1' || Object.keys(input).sort().join(',') !== 'cohort,mode')
    throw new DomainError(503, 'action_reauthentication_configuration_invalid');
}
// Initial upgrades admit no preexisting Source25 provider intents; complete26 reopen is supported.
export async function openSourceActionReauthenticationStorage(path: string, selected: SourceActionConfiguration) {
  configuration(selected);
  return openStorage(path, selectSourceActionReauthenticationMigrations(), 'selected-migration-22', 'selected-migration-23',
    'selected-lifecycle-evidence-24', 'selected-provider-revocation-25', 'selected-action-reauthentication-26');
}
export function createSourceActionReauthentication(input: Readonly<{ configuration: SourceActionConfiguration; db: Sqlite;
  authority: CurrentSuppressionAuthority; witness: SourceLifecycleEvidenceWitnessReader; continuity: SourceActionContinuityWitness;
  adapters: readonly LifecycleAdapter[]; localAbsence?: readonly SourceLifecycleLocalAbsenceReader[]; keys: SourceActionKeys;
  delivery: SourceActionDelivery; custodian: MaterialCustodian; transport: BoundedAppleTransport; clock?: () => number }>) {
  configuration(input.configuration);
  if (!(input.authority instanceof CurrentSuppressionAuthority) || input.db.inTransaction) throw new DomainError(503, 'action_reauthentication_held');
  const clock = input.clock ?? Date.now;
  const current = readSourceActionContinuity(input.db, input.continuity, actionTime(clock));
  if (current.authority !== input.authority) throw new DomainError(503, 'action_reauthentication_held');
  const evidence = new LifecycleEvidenceStore(input.db, input.witness, input.adapters, input.localAbsence, 'selected-action-reauthentication-26');
  evidence.assertAuthority(input.authority);
  const currentness = bindSourceLifecycleCurrentness(input.db, input.witness, 'selected-action-reauthentication-26', 'provider-revocation-v1');
  const outbox = new ProviderRevocationOutbox(input.db, currentness, input.custodian, input.transport, clock);
  const adapters = Object.freeze(input.adapters.map(adapter => Object.freeze({ ...adapter })));
  const lifecycle = new AccountLifecycle(input.db, adapters, input.authority, clock, evidence, outbox.confirmationHook);
  const authority = bindSourceActionAuthority(input.db, input.continuity, input.keys, clock);
  const ceremony = new SourceActionReauthentication(input.db, input.continuity, input.keys, input.delivery, clock);
  return Object.freeze({ lifecycle,
    issueChallenge: (context: AccountContext, issue: SourceActionIssue) => ceremony.issueChallenge(context, issue),
    verifyChallenge: (context: AccountContext, verify: SourceActionVerify) => ceremony.verifyChallenge(context, verify),
    confirmDeletion: (context: AccountContext, value: Readonly<{ requestId: string; grant: string }>) => {
      if (!value || Object.keys(value).sort().join(',') !== 'grant,requestId' || !actionId(value.requestId) || typeof value.grant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.grant)) throw new DomainError(403, 'action_reauthentication_unavailable');
      assertSourceActionContext(input.db, context, actionTime(clock));
      return lifecycle.confirmSourceAction(authority, context, value.requestId, value.grant);
    },
    consumeExportGrant: (context: AccountContext, value: Readonly<{ grant: string }>) => {
      if (!value || Object.keys(value).join(',') !== 'grant' || typeof value.grant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.grant)) throw new DomainError(403, 'action_reauthentication_unavailable');
      assertSourceActionContext(input.db, context, actionTime(clock));
      return lifecycle.consumeSourceActionExportGrant(authority, context, value.grant);
    },
    localCompletion: (requestId: string) => lifecycle.evidenceProjection(requestId),
    attemptOne: (intentId: string, attemptId: string, signal?: AbortSignal) => outbox.attemptOne(intentId, attemptId, signal),
    reconcileOne: (attemptId: string) => outbox.reconcileOne(attemptId),
    providerCompletion: (intentId: string) => outbox.project(intentId) });
}
