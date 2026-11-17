import type { Sqlite } from '../storage.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { SourceLifecycleEvidenceWitnessReader } from '../lifecycle/evidence-store.js';
import type { SourceSubscriptionStatusContinuityWitness } from '../lifecycle/reauthentication-proof.js';
import type { CurrentSuppressionAuthority } from '../runtime-modules/currentness.js';
import { DomainError } from '../errors.js';
import { ApplePurchaseService } from './service.js';
import { ApplePurchaseReconciliation } from './reconciliation.js';
import { createSourceStatusProjection } from './status-projection.js';
import { assertSourceSubscriptionStatusConfiguration, type SourceSubscriptionStatusConfiguration } from './status-source-migrations.js';
import { parseAppleDeliveryRequest } from './configuration.js';
import type { AppleSandboxConfiguration, AppleDeliveryDecision, AppleEntitlementGrant } from './types.js';
import type { AppleReconciliationVerifier, AppleStatusTransport, AppleHistoryReader, OwnerReconciliation, NotificationOutcome } from './reconciliation.types.js';

declare const originalProducerBrand: unique symbol;
export type SourceStatusOriginalProducer = Readonly<{[originalProducerBrand]:true}>;
export type SourceStatusProducerKind = 'status-transport'|'history-transport'|'transaction-verifier'|'renewal-verifier'|'notification-verifier';
export type SourceStatusProducerSettlement = Readonly<{state:'unproven'}>|Readonly<{state:'settled';outcome:'success'|'rejection'|'cancelled'}>;
/** Source custodian looks up exact original promises; promise completion alone is no resource-settlement proof. */
export interface SourceStatusProducerCustody {
  capture(kind:SourceStatusProducerKind,originalPromise:Promise<unknown>):SourceStatusOriginalProducer|null;
  read(original:SourceStatusOriginalProducer):SourceStatusProducerSettlement;
  requestCancellation(original:SourceStatusOriginalProducer):Promise<void>;
}
export type SourceStatusResult = Readonly<{status:'observed'|'pending'|'rejected'|'unavailable'|'unknown';requestId:string;
  observationIds:readonly string[];revision:number|null;reason:string|null}>;
export type SourceStatusOwnerFacade = OwnerReconciliation & Readonly<{
  refreshStatus(originalTransactionId:string,requestKey:string):Promise<SourceStatusResult>;
  reconcileStatusRequest(requestKey:string):SourceStatusResult;
  deliver(request:unknown):Promise<AppleDeliveryDecision>;
  entitlements():Readonly<{grants:AppleEntitlementGrant[];active:string[]}>;
}>;
export type SourceStatusFacade = Readonly<{forOwner(actor:AccountContext):SourceStatusOwnerFacade;ingestNotification(signedPayload:string):Promise<NotificationOutcome>}>;
/** Unmounted, explicitly selected source composition. No live producer custodian is supplied by runtime. */
export function createSourceAppleSubscriptionStatus(input:Readonly<{configuration:SourceSubscriptionStatusConfiguration;db:Sqlite;
  authority:CurrentSuppressionAuthority;witness:SourceLifecycleEvidenceWitnessReader;continuity:SourceSubscriptionStatusContinuityWitness;
  apple:AppleSandboxConfiguration;appAppleId:number;verifier:AppleReconciliationVerifier;statusTransport?:AppleStatusTransport;
  history?:AppleHistoryReader;producers:SourceStatusProducerCustody;clock:()=>number}>):SourceStatusFacade {
  assertSourceSubscriptionStatusConfiguration(input.configuration);
  if (typeof input.clock!=='function' || !input.producers || !['capture','read','requestCancellation'].every(k=>typeof (input.producers as unknown as Record<string,unknown>)[k]==='function'))
    throw new DomainError(503,'subscription_status_custody_required');
  const engine=createSourceStatusProjection(input);
  type Context=Parameters<Parameters<typeof engine.run>[1]>[0];
  const ledger=(c:Context)=>new ApplePurchaseService(input.db,input.apple,c.verifier,c.clock,c.hooks.ledgerHooks);
  const reconciliation=(c:Context)=>new ApplePurchaseReconciliation(input.db,input.apple,c.verifier,{
    // Background notifications never call owner-scoped methods.
    ownerWriter:c.ownerWriter??{lifecycle:{assertActive:()=>{throw new DomainError(503,'owner_writer_required');},
      withActiveWrite:()=>{throw new DomainError(503,'owner_writer_required');}},assertWithinWrite:()=>{throw new DomainError(503,'owner_writer_required');},
      lifecycleStoreOptions:{assertRootWriter:()=>{throw new DomainError(503,'owner_writer_required');}}},
    ...(c.history?{history:c.history}:{}),backgroundWriter:c.backgroundWriter,sourceStatus:c.hooks,
  },c.clock);
  return Object.freeze({
    forOwner:original=>{
      const actor=Object.freeze({...original}); engine.read(actor,c=>c.check());
      return Object.freeze({
        refreshStatus:(originalTransactionId,requestKey)=>engine.run(actor,async c=>{
          const service=ledger(c);
          return c.refresh(originalTransactionId,requestKey,(capture,permit)=>{
            const decision=service.observeVerified(actor.accountId,capture.exactJws,capture.proof,c.assertWrite,permit);
            if (decision.status!=='observed' && !['apple_expired','apple_revoked','apple_upgraded','apple_stale_proof'].includes(decision.code))
              throw new DomainError(503,'subscription_status_observation_rejected');
          });
        }),
        reconcileStatusRequest:requestKey=>engine.read(actor,c=>c.reconcile(requestKey)),
        reconcileOwner:(owner,checkpoint)=>engine.run(actor,async c=>reconciliation(c).forOwner(actor).reconcileOwner(owner,checkpoint)),
        readReconciliation:handle=>engine.read(actor,c=>reconciliation(c).forOwner(actor).readReconciliation(handle)),
        deliver:request=>{
          const parsed=parseAppleDeliveryRequest(request);
          if (!parsed) return Promise.resolve({status:'rejected',code:'invalid_purchase_request'});
          const frozen=Object.freeze({...parsed});
          return engine.run(actor,async c=>ledger(c).deliver(actor.accountId,frozen,actor),frozen.idempotencyKey);
        },
        entitlements:()=>engine.read(actor,c=>ledger(c).entitlements(actor.accountId)),
      });
    },
    ingestNotification:signedPayload=>engine.run(undefined,async c=>reconciliation(c).ingestNotification(signedPayload)),
  });
}
