import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DomainError } from '../errors.js';
import type { Sqlite } from '../storage.js';
import { integrity } from '../storage.js';
import type { AccountContext } from '../lifecycle/types.js';
import { assertActive, assertAccountActive, suppressionAuthority } from '../lifecycle/guards.js';
import { createCanonicalAccountWriter } from '../integration/account-modules/canonical-writer.js';
import { evidenceCanonical, evidenceDigest } from '../lifecycle/evidence-codec.js';
import { bindSourceSubscriptionStatusStoreCurrentness, readSourceSubscriptionStatusStoreCurrentness,
  type SourceLifecycleEvidenceWitnessReader } from '../lifecycle/evidence-store.js';
import { readSourceSubscriptionStatusContinuity, consumeSourceSubscriptionStatusContinuity,
  type SourceSubscriptionStatusContinuityWitness, type SourceSubscriptionStatusContinuitySnapshot } from '../lifecycle/reauthentication-proof.js';
import type { CurrentSuppressionAuthority } from '../runtime-modules/currentness.js';
import { AppleSubscriptionStatusReader } from './status.js';
import { accountUuid, appleTransactionId, validateAppleConfiguration } from './configuration.js';
import { AppleProofError, type VerifiedAppleTransaction, type AppleSandboxConfiguration } from './types.js';
import type { AppleReconciliationVerifier, AppleStatusTransport, AppleHistoryReader, PurchaseOwner, PurchaseOwnerWriter,
  PurchaseBackgroundWriter, AppleSubscriptionStatusObservation } from './reconciliation.types.js';
import { STATUS_CODEC_V1, parseStatusBindingV1, parseStatusEvidenceV1, parseStatusProjectionV1,
  serializeStatusBindingV1, serializeStatusEvidenceV1, serializeStatusProjectionV1, statusBindingIdV1, statusEvidenceIdV1,
  statusProjectionIdV1, reduceStatusEvidenceV1, compareStatusEvidenceV1,
  type StatusBindingV1, type StatusEvidenceV1, type StatusObservationV1, type StatusProjectionV1, type StatusOutcomeV1 } from './status-codec.js';
import type { SourceStatusProducerCustody, SourceStatusOriginalProducer, SourceStatusProducerKind, SourceStatusResult } from './status-source.js';

declare const invocationBrand: unique symbol;
declare const frameBrand: unique symbol;
declare const batchBrand: unique symbol;
declare const graceBrand: unique symbol;
export type SourceStatusInvocation = Readonly<{[invocationBrand]:true}>;
export type SourceStatusWriteFrame = Readonly<{[frameBrand]:true}>;
export type VerifiedSourceStatusBatch = Readonly<{[batchBrand]:true}>;
export type SourceStatusGracePermit = Readonly<{[graceBrand]:true}>;
export type SourceStatusCapturedProof = Readonly<{exactJws:string; proofHash:string; proof:Readonly<VerifiedAppleTransaction>}>;
export type SourceStatusProjectionDecision = Readonly<{active:boolean; effectiveExpiresAtMs:number|null}>;
export type SourceStatusLedgerHooks = Readonly<{
  withDeliveryWrite<T>(effect:()=>T):T;
  afterLedgerMutation(input:Readonly<{accountId:string; originalTransactionId:string; transactionId:string; proofHash:string;
    observationOnly:boolean; decision:Readonly<{status:string; code?:string}>}>):void;
  entitlement(input:Readonly<{accountId:string;transactionId:string;originalTransactionId:string;productType:string;
    ordinaryActive:boolean;ordinaryExpiresAtMs:number|null;nowMs:number}>):SourceStatusProjectionDecision;
}>;
export type SourceStatusReconciliationHooks = Readonly<{
  ledgerHooks:SourceStatusLedgerHooks;
  afterHistoryPage(input:Readonly<{owner:PurchaseOwner;handle:string;pageIndex:number;pageDigest:string;transactionProofHashes:readonly string[]}>):void;
  afterNotification(input:Readonly<{owner:PurchaseOwner;notificationId:string;payloadDigest:string;transactionProofHashes:readonly string[];
    renewalProofHashes:readonly string[];reason:'notification_changed'|'refund_reversed'}>):void;
}>;
function held():never { throw new DomainError(503,'subscription_status_held'); }
function conflict():never { throw new DomainError(409,'subscription_status_request_conflict'); }
const sha = (s:string) => createHash('sha256').update(s).digest('hex');
const digest = (domain:string, value:unknown) => evidenceDigest([domain,value]);
const same = (a:unknown,b:unknown) => evidenceCanonical(a) === evidenceCanonical(b);
function time(n:number):number { if (!Number.isSafeInteger(n) || n<0 || n>8640000000000000) held(); return n; }
function add(n:number,delta:number):number { return time(n+delta); }
function synchronous<T>(v:T):T {
  if (v !== null && (typeof v === 'object' || typeof v === 'function') && typeof (v as {then?:unknown}).then === 'function') held();
  return v;
}
// Copy only bounded plain JSON; do not invoke accessors or accept mutable provider references.
function frozenJson<T>(value:T, limit:number):Readonly<T> {
  let nodes=0,bytes=0;
  const walk=(v:unknown,depth:number):unknown=>{
    if (++nodes>10000 || depth>12) held();
    if (v===null || typeof v==='boolean' || typeof v==='number' && Number.isFinite(v) || typeof v==='string') {
      bytes+=Buffer.byteLength(JSON.stringify(v)); if (bytes>limit) held(); return v;
    }
    if (!v || typeof v!=='object' || ![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v))) held();
    const keys=Reflect.ownKeys(v).filter(k=>!(Array.isArray(v)&&k==='length'));
    if (keys.length>100) held();
    const out:Record<string,unknown>|unknown[]=Array.isArray(v)?[]:{};
    if (Array.isArray(v) && keys.length!==v.length) held();
    for (const key of keys) {
      if (typeof key!=='string' || ['__proto__','prototype','constructor'].includes(key)) held();
      const d=Object.getOwnPropertyDescriptor(v,key); if (!d || !('value' in d) || !d.enumerable) held();
      bytes+=Buffer.byteLength(JSON.stringify(key))+2; if (bytes>limit) held();
      (out as Record<string,unknown>)[key]=walk(d.value,depth+1);
    }
    return Object.freeze(out);
  };
  return walk(value,0) as Readonly<T>;
}
type ObservationRow={observation_id:string;account_id:string;original_transaction_id:string;owner_binding_digest:string;event_kind:string;
  event_key:string;request_id:string;lifecycle_epoch:number;database_generation:string;schema_digest:string;continuity_digest:string;
  binding_json:string;evidence_json:string;content_digest:string;observed_at_ms:number};
type ProjectionRow={original_transaction_id:string;account_id:string;owner_binding_digest:string;revision:number;lifecycle_epoch:number;
  database_generation:string;schema_digest:string;continuity_digest:string;current_observation_id:string|null;projection_state:'pending'|'current'|'held';
  projection_json:string;valid_until_ms:number|null;active_request_id:string|null;dispatch_state:'dispatching'|'unsettled'|null;
  request_deadline_ms:number|null;last_seen_at_ms:number};
type LedgerRow={transaction_id:string;original_transaction_id:string;account_id:string;product_id:string;product_type:string;app_account_token:string;
  purchase_date_ms:number;signed_date_ms:number;expires_date_ms:number|null;revocation_date_ms:number|null;is_upgraded:number;proof_hash:string};
const observationColumns=['observation_id','account_id','original_transaction_id','owner_binding_digest','event_kind','event_key','request_id',
  'lifecycle_epoch','database_generation','schema_digest','continuity_digest','binding_json','evidence_json','observed_at_ms'] as const;
const rowDigest=(r:Omit<ObservationRow,'content_digest'>)=>digest('source-status-row/v1',observationColumns.map(k=>r[k]));
const ownerDigest=(o:PurchaseOwner)=>digest('source-status-owner/v1',o);
type Invocation={actor:AccountContext|null;initial:SourceSubscriptionStatusContinuitySnapshot;last:SourceSubscriptionStatusContinuitySnapshot;
  fenced:boolean;start:number;deadline:number;handles:SourceStatusOriginalProducer[];unknown:boolean;owner:PurchaseOwner|null;
  proofs:Map<string,SourceStatusCapturedProof>;renewals:Map<string,Readonly<Record<string,unknown>>>;response:unknown;cacheBytes:number;
  epoch?:number;auth?:string;frame:object|null;finalizing:boolean;requestId:string|null;claim:ObservationRow|null;claimRevision:number|null};
type GraceState={db:Sqlite;inv:Invocation;proof:Readonly<VerifiedAppleTransaction>;jws:string;accountId:string;cutoff:number;
  frame:object;request:string;revision:number;observation:string;check:()=>void;used:boolean};
const permits=new WeakMap<SourceStatusGracePermit,GraceState>();
export function consumeSourceStatusGracePermit(permit:SourceStatusGracePermit,input:Readonly<{db:Sqlite;accountId:string;exactJws:string;
  proof:Readonly<VerifiedAppleTransaction>;nowMs:number}>):void {
  const p=permits.get(permit);
  if (!p || p.used || input.db!==p.db || !p.db.open || !p.db.inTransaction || p.inv.frame!==p.frame || p.inv.fenced ||
    input.accountId!==p.accountId || input.proof!==p.proof || input.exactJws!==p.jws || sha(input.exactJws)!==sha(p.jws) ||
    p.inv.requestId!==p.request || p.inv.claimRevision!==p.revision || !p.observation || time(input.nowMs)>=p.cutoff ||
    input.proof.purchaseDate>input.nowMs) held();
  p.check(); p.used=true;
}

/** Internal source composition. All authority is constructed from live native inputs here. */
export function createSourceStatusProjection(input:Readonly<{db:Sqlite;authority:CurrentSuppressionAuthority;
  witness:SourceLifecycleEvidenceWitnessReader;continuity:SourceSubscriptionStatusContinuityWitness;clock:()=>number;
  apple:AppleSandboxConfiguration;appAppleId:number;verifier:AppleReconciliationVerifier;statusTransport?:AppleStatusTransport;
  history?:AppleHistoryReader;producers:SourceStatusProducerCustody}>) {
  const {db}=input, config=validateAppleConfiguration(input.apple), writer=createCanonicalAccountWriter(db);
  const store=bindSourceSubscriptionStatusStoreCurrentness(db,input.witness);
  let lastNow=0,live:Invocation|null=null;
  const unsettledInvocations=new Set<Invocation>();
  const now=()=>{ const n=time(input.clock()); if (n<lastNow) held(); lastNow=n; return n; };
  const native=(prior?:SourceSubscriptionStatusContinuitySnapshot)=>{
    const s=readSourceSubscriptionStatusContinuity(db,input.continuity,now(),prior);
    if (s.authority!==input.authority || suppressionAuthority(db)!==input.authority) held(); return s;
  };
  native();
  function installed(original:string):PurchaseOwner {
    if (!appleTransactionId.test(original)) held();
    const row=db.prepare(`SELECT o.account_id,o.bundle_id,o.environment,t.app_account_token FROM apple_purchase_owners o
      JOIN apple_purchase_transactions t ON t.original_transaction_id=o.original_transaction_id AND t.account_id=o.account_id
      WHERE o.original_transaction_id=? LIMIT 1`).get(original) as {account_id:string;bundle_id:string;environment:string;app_account_token:string}|undefined;
    if (!row || !accountUuid.test(row.account_id) || row.app_account_token!==row.account_id || row.bundle_id!==config.bundleId || row.environment!=='Sandbox') held();
    return Object.freeze({accountId:row.account_id,appAccountToken:row.app_account_token,originalTransactionId:original,bundleId:row.bundle_id,environment:'Sandbox'});
  }
  function principal(inv:Invocation,owner?:PurchaseOwner):number|null {
    const s=native(inv.last); inv.last=s;
    if (inv.fenced || performance.now()-inv.start>=9500 || now()>=inv.deadline) held();
    if (inv.actor) {
      assertActive(db,inv.actor);
      const row=db.prepare('SELECT s.expiresAt FROM session s JOIN "user" u ON u.id=s.userId JOIN form_accounts f ON f.auth_user_id=u.id WHERE s.id=? AND u.id=? AND f.id=?')
        .get(inv.actor.sessionId,inv.actor.authUserId,inv.actor.accountId) as {expiresAt:number}|undefined;
      if (!row || time(row.expiresAt)<=now()) held();
    }
    if (owner) {
      if (!same(installed(owner.originalTransactionId),owner) || inv.actor && inv.actor.accountId!==owner.accountId) held();
      const mapped=db.prepare('SELECT f.auth_user_id FROM form_accounts f JOIN "user" u ON u.id=f.auth_user_id WHERE f.id=?').get(owner.accountId) as {auth_user_id:string}|undefined;
      if (!mapped) held();
      const epoch=assertAccountActive(db,owner.accountId);
      if (inv.actor ? epoch!==inv.actor.epoch : inv.owner && (!same(inv.owner,owner) || inv.epoch!==epoch || inv.auth!==mapped.auth_user_id)) held();
      if (!inv.actor && !inv.owner) { inv.owner=owner; inv.epoch=epoch; inv.auth=mapped.auth_user_id; }
      return epoch;
    }
    return inv.actor?.epoch??null;
  }
  function assertFrame(inv:Invocation,owner:PurchaseOwner):void {
    if (!db.inTransaction || !inv.frame) held(); principal(inv,owner); settled(inv);
    if (inv.actor) { writer.assertWithinWrite(inv.actor); writer.lifecycleStoreOptions.assertRootWriter(db); }
  }
  function withWrite<T>(inv:Invocation,owner:PurchaseOwner,effect:()=>T):T {
    principal(inv,owner);
    if (inv.frame || db.inTransaction) held();
    const body=()=>{
      const frame=Object.freeze({}); inv.frame=frame;
      try {
        assertFrame(inv,owner);
        const seal=native(inv.last); consumeSourceSubscriptionStatusContinuity(db,input.continuity,seal,now()); inv.last=seal;
        const result=synchronous(effect()); assertFrame(inv,owner); integrity(db); return result;
      } finally { inv.frame=null; }
    };
    return inv.actor ? writer.lifecycle.withActiveWrite(inv.actor,body) : db.transaction(body).immediate();
  }
  function binding(inv:Invocation,owner:PurchaseOwner):StatusBindingV1 {
    const epoch=principal(inv,owner); if (epoch===null) held(); const s=inv.last;
    return parseStatusBindingV1({version:STATUS_CODEC_V1.binding,owner,authActorDigest:digest('source-status-principal/v1',inv.actor??[owner.accountId,inv.auth,epoch]),
      epoch,nativeStoreDigest:s.nativeStoreDigest,generation:evidenceDigest(s.generation),schemaCohort:'selected-subscription-status-27',schemaDigest:s.schemaDigest,
      authorityId:s.checkpoint.authorityId,authoritySchema:s.checkpoint.ledgerSchemaDigest,
      suppression:{sequence:s.checkpoint.committedSequence,headDigest:s.checkpoint.committedHeadDigest},
      continuity:{revision:s.recordRevision,highWaterMs:s.recordObservedAtMs,digest:s.continuityDigest,restoreBoundaryMs:s.restoreBoundaryMs??0}});
  }
  function validateBinding(b:StatusBindingV1,inv:Invocation,owner:PurchaseOwner):void {
    const current=binding(inv,owner);
    if (!same(b.owner,owner) || b.epoch!==current.epoch || b.nativeStoreDigest!==current.nativeStoreDigest || b.generation!==current.generation ||
      b.schemaDigest!==current.schemaDigest || b.authorityId!==current.authorityId || b.authoritySchema!==current.authoritySchema ||
      b.continuity.digest!==current.continuity.digest || b.continuity.restoreBoundaryMs!==current.continuity.restoreBoundaryMs ||
      b.continuity.revision>current.continuity.revision || b.continuity.highWaterMs>current.continuity.highWaterMs) held();
    readSourceSubscriptionStatusStoreCurrentness(store,{authorityId:b.authorityId,ledgerSchemaDigest:b.authoritySchema,revision:0,
      committedSequence:b.suppression.sequence,committedHeadDigest:b.suppression.headDigest});
  }
  function decode(row:ObservationRow,inv:Invocation,owner:PurchaseOwner):{b:StatusBindingV1;e:StatusEvidenceV1} {
    const b=parseStatusBindingV1(JSON.parse(row.binding_json)),e=parseStatusEvidenceV1(JSON.parse(row.evidence_json));
    if (serializeStatusBindingV1(b)!==row.binding_json || serializeStatusEvidenceV1(e)!==row.evidence_json || rowDigest(row)!==row.content_digest ||
      statusEvidenceIdV1(e)!==row.observation_id || statusBindingIdV1(b)!==e.bindingId || ownerDigest(owner)!==row.owner_binding_digest ||
      row.account_id!==owner.accountId || row.original_transaction_id!==owner.originalTransactionId || e.originalTransactionId!==owner.originalTransactionId ||
      row.event_kind!==e.kind || row.request_id!==e.requestId || row.lifecycle_epoch!==b.epoch || row.database_generation!==b.generation ||
      row.schema_digest!==b.schemaDigest || row.continuity_digest!==b.continuity.digest || row.observed_at_ms!==e.recordedAtMs || e.recordedAtMs>now()) held();
    const domain=e.kind==='dispatch'?'source-status-dispatch-event/v1':e.kind==='status'?'source-status-observation-event/v1':
      e.kind==='history'?'source-status-history-event/v1':e.kind==='notification'?'source-status-notification-event/v1':
      e.reason==='ledger_changed'?'source-status-delivery-event/v1':'source-status-outcome-event/v1';
    if (row.event_key!==digest(domain,e.requestId)) held();
    validateBinding(b,inv,owner); return {b,e};
  }
  function capacity(account:string,extra:number,ownCompletion=false,newClaim=false):void {
    const count=(sql:string,...args:unknown[]) => (db.prepare(sql).get(...args) as {n:number}).n;
    const accountRows=count('SELECT count(*) n FROM (SELECT 1 FROM apple_purchase_status_observations WHERE account_id=? LIMIT 1025)',account);
    const storeRows=count('SELECT count(*) n FROM (SELECT 1 FROM apple_purchase_status_observations LIMIT 10001)');
    let claims=count('SELECT count(*) n FROM apple_purchase_status_projection WHERE active_request_id IS NOT NULL');
    let accountClaims=count('SELECT count(*) n FROM apple_purchase_status_projection WHERE account_id=? AND active_request_id IS NOT NULL',account);
    if (ownCompletion) { claims--; accountClaims--; }
    if (newClaim) { claims++; accountClaims++; }
    if (claims<0 || accountClaims<0 || accountRows+extra+2*accountClaims>1024 || storeRows+extra+2*claims>10000) held();
  }
  function append(inv:Invocation,owner:PurchaseOwner,b:StatusBindingV1,e:StatusEvidenceV1,eventKey:string,completion=false):ObservationRow {
    assertFrame(inv,owner); capacity(owner.accountId,1,completion);
    const row={observation_id:statusEvidenceIdV1(e),account_id:owner.accountId,original_transaction_id:owner.originalTransactionId,
      owner_binding_digest:ownerDigest(owner),event_kind:e.kind,event_key:eventKey,request_id:e.requestId,lifecycle_epoch:b.epoch,
      database_generation:b.generation,schema_digest:b.schemaDigest,continuity_digest:b.continuity.digest,binding_json:serializeStatusBindingV1(b),
      evidence_json:serializeStatusEvidenceV1(e),observed_at_ms:e.recordedAtMs};
    const full={...row,content_digest:rowDigest(row)};
    const keys:readonly (keyof typeof full)[]=[...observationColumns,'content_digest'];
    db.prepare(`INSERT INTO apple_purchase_status_observations(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>full[k]));
    const saved=db.prepare('SELECT * FROM apple_purchase_status_observations WHERE observation_id=?').get(full.observation_id) as ObservationRow;
    decode(saved,inv,owner); if (!same(saved,full)) held(); return saved;
  }
  function head(owner:PurchaseOwner):{row:LedgerRow|null;fingerprint:string;ambiguous:boolean} {
    const rows=db.prepare(`SELECT transaction_id,original_transaction_id,account_id,product_id,product_type,app_account_token,purchase_date_ms,signed_date_ms,
      expires_date_ms,revocation_date_ms,is_upgraded,proof_hash FROM apple_purchase_transactions WHERE account_id=? AND original_transaction_id=?
      ORDER BY purchase_date_ms DESC LIMIT 2`).all(owner.accountId,owner.originalTransactionId) as LedgerRow[];
    const row=rows[0]??null;
    if (row) { time(row.purchase_date_ms);time(row.signed_date_ms);if (row.app_account_token!==owner.appAccountToken) held(); }
    return {row,fingerprint:digest('source-status-ledger-head/v1',[owner,row]),ambiguous:rows.length>1 && rows[1]!.purchase_date_ms===row!.purchase_date_ms};
  }
  function projection(owner:PurchaseOwner):ProjectionRow|undefined {
    return db.prepare('SELECT * FROM apple_purchase_status_projection WHERE original_transaction_id=? AND account_id=?').get(owner.originalTransactionId,owner.accountId) as ProjectionRow|undefined;
  }
  function decodeProjection(row:ProjectionRow,inv:Invocation,owner:PurchaseOwner):StatusProjectionV1 {
    const p=parseStatusProjectionV1(JSON.parse(row.projection_json)); statusProjectionIdV1(p);
    if (serializeStatusProjectionV1(p)!==row.projection_json || row.account_id!==owner.accountId || row.original_transaction_id!==owner.originalTransactionId ||
      ownerDigest(owner)!==row.owner_binding_digest || p.originalTransactionId!==owner.originalTransactionId || p.revision!==row.revision ||
      p.observationId!==row.current_observation_id || p.activeDispatchObservationId!==row.active_request_id || p.validUntilMs!==row.valid_until_ms ||
      row.projection_state==='current' && !['active','billing_grace_period','inactive'].includes(p.result) ||
      row.projection_state!=='current' && p.result!=='held') held();
    const current=binding(inv,owner);
    if (row.lifecycle_epoch!==current.epoch || row.database_generation!==current.generation || row.schema_digest!==current.schemaDigest ||
      row.continuity_digest!==current.continuity.digest || row.last_seen_at_ms>now()) held();
    const ids=[row.current_observation_id,row.active_request_id].filter((id):id is string=>id!==null);
    let bound=false;
    for (const id of ids) {
      const o=db.prepare('SELECT * FROM apple_purchase_status_observations WHERE observation_id=?').get(id) as ObservationRow|undefined;
      if (!o) held(); const {e}=decode(o,inv,owner);
      if (id===row.current_observation_id && e.kind!=='status' || id===row.active_request_id && e.kind!=='dispatch') held();
      if (id===row.active_request_id && e.kind==='dispatch' && row.request_deadline_ms!==e.deadlineAtMs) held();
      if (e.bindingId===p.bindingId) bound=true;
    }
    if (!bound && p.bindingId!==statusBindingIdV1(current)) {
      const rows=db.prepare('SELECT * FROM apple_purchase_status_observations WHERE account_id=? AND original_transaction_id=? AND event_kind=\'outcome\' ORDER BY observed_at_ms DESC LIMIT 101')
        .all(owner.accountId,owner.originalTransactionId) as ObservationRow[];
      if (rows.length>100) held();
      bound=rows.some(r=>decode(r,inv,owner).e.bindingId===p.bindingId);
      if (!bound) held();
    }
    return p;
  }
  function saveProjection(inv:Invocation,owner:PurchaseOwner,b:StatusBindingV1,p:StatusProjectionV1,old:ProjectionRow|undefined,
    state:ProjectionRow['projection_state'],dispatchState:ProjectionRow['dispatch_state'],deadline:number|null,expectedClaim?:string):ProjectionRow {
    assertFrame(inv,owner);
    const values=[p.revision,b.epoch,b.generation,b.schemaDigest,b.continuity.digest,p.observationId,state,serializeStatusProjectionV1(p),p.validUntilMs,
      p.activeDispatchObservationId,dispatchState,deadline,now()];
    if (!old) db.prepare(`INSERT INTO apple_purchase_status_projection VALUES(?,?,?,${values.map(()=>'?').join(',')})`).run(owner.originalTransactionId,owner.accountId,ownerDigest(owner),...values);
    else {
      const result=db.prepare(`UPDATE apple_purchase_status_projection SET revision=?,lifecycle_epoch=?,database_generation=?,schema_digest=?,continuity_digest=?,
        current_observation_id=?,projection_state=?,projection_json=?,valid_until_ms=?,active_request_id=?,dispatch_state=?,request_deadline_ms=?,last_seen_at_ms=?
        WHERE original_transaction_id=? AND account_id=? AND revision=? AND active_request_id IS ?`).run(...values,owner.originalTransactionId,owner.accountId,old.revision,expectedClaim??old.active_request_id);
      if (result.changes!==1) held();
    }
    const saved=projection(owner); if (!saved) held(); decodeProjection(saved,inv,owner); return saved;
  }
  const base=(b:StatusBindingV1,request:string,at:number)=>({version:STATUS_CODEC_V1.evidence,bindingId:statusBindingIdV1(b),originalTransactionId:b.owner.originalTransactionId,
    requestId:request,recordedAtMs:at});
  function heldProjection(b:StatusBindingV1,owner:PurchaseOwner,revision:number,claim:string|null,reason:StatusProjectionV1['reason']='held'):StatusProjectionV1 {
    return parseStatusProjectionV1({version:STATUS_CODEC_V1.projection,bindingId:statusBindingIdV1(b),originalTransactionId:owner.originalTransactionId,revision,
      observationId:null,ledgerFingerprintDigest:head(owner).fingerprint,result:'held',reason,validUntilMs:null,activeDispatchObservationId:claim});
  }
  function settled(inv:Invocation):StatusOutcomeV1['producerSettlement'] {
    if (inv.unknown) held();
    let result:StatusOutcomeV1['producerSettlement']='settled_success';
    for (const handle of inv.handles) {
      const s=input.producers.read(handle);
      if (!s || s.state!=='settled' || !['success','rejection','cancelled'].includes(s.outcome)) held();
      if (s.outcome==='cancelled') result='settled_cancelled'; else if (s.outcome==='rejection' && result!=='settled_cancelled') result='settled_rejection';
    }
    return result;
  }
  async function track<T>(inv:Invocation,kind:SourceStatusProducerKind,start:()=>Promise<T>,limit:number):Promise<Readonly<T>> {
    principal(inv,inv.owner??undefined);
    let original:Promise<T>;
    try { original=start(); } catch { inv.unknown=true; return held(); }
    if (!(original instanceof Promise)) { inv.unknown=true; return held(); }
    // Rejections remain observed even when custody capture fails or the invocation fences.
    void original.catch(()=>{});
    let captured:SourceStatusOriginalProducer|null=null;
    try { captured=input.producers.capture(kind,original); } catch { inv.unknown=true; }
    if (!captured || inv.handles.includes(captured)) { inv.unknown=true; return held(); }
    inv.handles.push(captured);
    const value=await original;
    principal(inv,inv.owner??undefined);
    const copy=frozenJson(value,limit);
    inv.cacheBytes+=Buffer.byteLength(evidenceCanonical(copy));
    if (inv.cacheBytes>8388608) held();
    return copy;
  }
  function wrappedVerifier(inv:Invocation):AppleReconciliationVerifier {
    return {
      verify:async jws=>{
        if (typeof jws!=='string' || Buffer.byteLength(jws)>60000) held();
        const proof=await track(inv,'transaction-verifier',()=>input.verifier.verify(jws),60000);
        const prior=inv.proofs.get(jws); if (prior && !same(prior.proof,proof)) held();
        inv.proofs.set(jws,Object.freeze({exactJws:jws,proofHash:sha(jws),proof}));
        return proof;
      },
      renewal:async jws=>{
        if (typeof jws!=='string' || Buffer.byteLength(jws)>60000) held();
        const renewal=await track(inv,'renewal-verifier',()=>input.verifier.renewal(jws),60000);
        const prior=inv.renewals.get(jws); if (prior && !same(prior,renewal)) held();
        inv.renewals.set(jws,renewal as Readonly<Record<string,unknown>>); return renewal;
      },
      notification:async jws=>track(inv,'notification-verifier',()=>input.verifier.notification(jws),240000),
    };
  }
  function correlate(inv:Invocation,owner:PurchaseOwner,observation:AppleSubscriptionStatusObservation):{capture:SourceStatusCapturedProof;renewal:Readonly<Record<string,unknown>>;renewalHash:string} {
    const response=inv.response as {data:{subscriptionGroupIdentifier:string;lastTransactions:{originalTransactionId:string;status:number;signedTransactionInfo:string;signedRenewalInfo:string}[]}[]};
    const matches=response.data.flatMap(g=>g.lastTransactions.filter(t=>t.originalTransactionId===owner.originalTransactionId).map(t=>({g,t})));
    if (matches.length!==1) held(); const {g,t}=matches[0]!;
    const capture=inv.proofs.get(t.signedTransactionInfo),renewal=inv.renewals.get(t.signedRenewalInfo);
    if (!capture || !renewal) held();
    const p=capture.proof as VerifiedAppleTransaction & {subscriptionGroupIdentifier?:string};
    const statuses:Record<number,string>={1:'active',2:'expired',3:'billing_retry',4:'billing_grace_period',5:'revoked'};
    const normalized={owner,subscriptionGroupIdentifier:g.subscriptionGroupIdentifier,status:statuses[t.status],
      transaction:{transactionId:p.transactionId,productId:p.productId,purchaseDate:p.purchaseDate,signedDate:p.signedDate,expiresDate:p.expiresDate,
        revocationDate:p.revocationDate??null,isUpgraded:p.isUpgraded??false},
      renewal:{productId:renewal.productId,autoRenewProductId:renewal.autoRenewProductId??null,signedDate:renewal.signedDate,autoRenewStatus:renewal.autoRenewStatus,
        gracePeriodExpiresDate:renewal.gracePeriodExpiresDate??null,isInBillingRetryPeriod:renewal.isInBillingRetryPeriod??null}};
    if (!same(normalized,observation) || p.subscriptionGroupIdentifier!==g.subscriptionGroupIdentifier || p.originalTransactionId!==owner.originalTransactionId ||
      p.appAccountToken!==owner.appAccountToken || p.bundleId!==owner.bundleId || p.environment!==owner.environment ||
      renewal.originalTransactionId!==owner.originalTransactionId || renewal.appAccountToken!==owner.appAccountToken || renewal.environment!==owner.environment) held();
    if (time(p.purchaseDate)>now() || time(p.signedDate)>add(now(),60000) || time(renewal.signedDate as number)>add(now(),60000)) held();
    return {capture,renewal,renewalHash:sha(t.signedRenewalInfo)};
  }
  const batches=new WeakMap<VerifiedSourceStatusBatch,{inv:Invocation;owner:PurchaseOwner;binding:StatusBindingV1;observation:AppleSubscriptionStatusObservation;
    captured:ReturnType<typeof correlate>;dispatch:string;revision:number;used:boolean}>();
  const retained=new Map<string,Invocation>();
  function requestId(account:string,key:string):string {
    if (typeof key!=='string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) conflict();
    return digest('source-status-request/v1',[account,key]);
  }
  function terminal(inv:Invocation,owner:PurchaseOwner,request:string):SourceStatusResult|null {
    const rows=db.prepare("SELECT * FROM apple_purchase_status_observations WHERE account_id=? AND request_id=? AND event_kind='outcome' LIMIT 2").all(owner.accountId,request) as ObservationRow[];
    if (rows.length>1) held(); if (!rows.length) return null;
    const {e}=decode(rows[0]!,inv,owner); if (e.kind!=='outcome') held();
    return Object.freeze({status:e.outcome,requestId:request,observationIds:e.observationIds,revision:e.resultingRevision,reason:e.reason});
  }
  function begin(inv:Invocation,owner:PurchaseOwner,key:string):SourceStatusResult|null {
    const request=requestId(owner.accountId,key); inv.requestId=request;
    return withWrite(inv,owner,()=>{
      const b=binding(inv,owner),event=digest('source-status-dispatch-event/v1',request);
      const oldDispatch=db.prepare("SELECT * FROM apple_purchase_status_observations WHERE account_id=? AND event_kind='dispatch' AND event_key=?").get(owner.accountId,event) as ObservationRow|undefined;
      if (oldDispatch) {
        if (oldDispatch.original_transaction_id!==owner.originalTransactionId) conflict();
        const d=decode(oldDispatch,inv,owner); if (d.b.authActorDigest!==b.authActorDigest || d.e.kind!=='dispatch' || d.e.requestKeyDigest!==digest('source-status-request-key/v1',key)) conflict();
        const result=terminal(inv,owner,request); if (result) return result;
        return Object.freeze({status:'unknown',requestId:request,observationIds:[],revision:null,reason:'held'});
      }
      if (inv.last.restoreBoundaryMs!==null && now()<add(inv.last.restoreBoundaryMs,3600000)) held();
      if (db.prepare('SELECT 1 FROM apple_purchase_status_projection WHERE account_id=? AND active_request_id IS NOT NULL').get(owner.accountId)) held();
      const recent=db.prepare("SELECT observed_at_ms FROM apple_purchase_status_observations WHERE account_id=? AND event_kind='dispatch' AND observed_at_ms>? ORDER BY observed_at_ms DESC LIMIT 61")
        .all(owner.accountId,Math.max(0,now()-3600000)) as {observed_at_ms:number}[];
      if (recent.length>=60 || recent[0] && (recent[0].observed_at_ms>now() || now()-recent[0].observed_at_ms<5000)) held();
      const old=projection(owner);
      if (old) decodeProjection(old,inv,owner);
      if (!old && (db.prepare('SELECT count(*) n FROM (SELECT 1 FROM apple_purchase_status_projection WHERE account_id=? LIMIT 129)').get(owner.accountId) as {n:number}).n>=128) held();
      capacity(owner.accountId,1,false,true);
      const revision=old?.revision??0,at=now();
      const e=parseStatusEvidenceV1({...base(b,request,at),kind:'dispatch',requestKeyDigest:digest('source-status-request-key/v1',key),capturedRevision:revision,
        issuedAtMs:at,deadlineAtMs:inv.deadline,rateWindowStartMs:Math.max(0,at-3600000),rateOrdinal:recent.length+1});
      const dispatch=append(inv,owner,b,e,event);
      inv.claim=dispatch; inv.claimRevision=revision+1;
      const p=heldProjection(b,owner,revision+1,dispatch.observation_id);
      saveProjection(inv,owner,b,p,old,'pending','dispatching',inv.deadline);
      retained.set(request,inv); return null;
    });
  }
  function reduce(inv:Invocation,owner:PurchaseOwner):{p:StatusProjectionV1;binding:StatusBindingV1} {
    const b=binding(inv,owner),h=head(owner),old=projection(owner); if (!old) held();
    const no=()=>({p:heldProjection(b,owner,old.revision+1,null),binding:b});
    if (!h.row || h.ambiguous) return no();
    const rows=db.prepare("SELECT * FROM apple_purchase_status_observations WHERE account_id=? AND original_transaction_id=? AND event_kind='status' AND json_extract(evidence_json,'$.transaction.purchaseDate')>=? ORDER BY observed_at_ms,observation_id LIMIT 101")
      .all(owner.accountId,owner.originalTransactionId,h.row.purchase_date_ms) as ObservationRow[];
    if (rows.length>100) return no();
    const originals=rows.map(r=>({r,...decode(r,inv,owner)})).filter((v):v is {r:ObservationRow;b:StatusBindingV1;e:StatusObservationV1}=>v.e.kind==='status');
    const context=digest('source-status-ordering-context/v1',[owner,b.epoch,b.nativeStoreDigest,b.generation,b.schemaDigest,b.authorityId,b.authoritySchema]);
    const candidates=originals.filter(v=>v.e.transaction.purchaseDate>=h.row!.purchase_date_ms);
    const reduced=reduceStatusEvidenceV1(candidates.map(v=>({...v.e,bindingId:context})));
    if (reduced.state!=='selected' || !reduced.head || reduced.stickyRevoked || reduced.stickyUpgraded) return no();
    const selected=candidates.find(v=>same({...v.e,bindingId:context},reduced.head)); if (!selected) held();
    const e=selected.e,t=e.transaction,r=e.renewal;
    if (t.transactionId!==h.row.transaction_id || t.purchaseDate!==h.row.purchase_date_ms || t.signedDate!==h.row.signed_date_ms ||
      e.transactionProofHash!==h.row.proof_hash || t.productId!==h.row.product_id || t.expiresDate!==h.row.expires_date_ms ||
      h.row.revocation_date_ms!==null || h.row.is_upgraded!==0 || t.purchaseDate>now()) return no();
    let result:StatusProjectionV1['result']='inactive',cutoff:number|null=null;
    if (e.status==='active' && t.expiresDate>now()) { result='active';cutoff=Math.min(t.expiresDate,add(e.recordedAtMs,300000)); }
    else if (e.status==='billing_grace_period' && r.gracePeriodExpiresDate!==null && r.gracePeriodExpiresDate>now()) {
      result='billing_grace_period';cutoff=Math.min(r.gracePeriodExpiresDate,add(e.recordedAtMs,300000));
    }
    if (cutoff!==null && now()>=cutoff) {result='inactive';cutoff=null;}
    return {binding:selected.b,p:parseStatusProjectionV1({version:STATUS_CODEC_V1.projection,bindingId:e.bindingId,originalTransactionId:owner.originalTransactionId,
      revision:old.revision+1,observationId:selected.r.observation_id,ledgerFingerprintDigest:h.fingerprint,result,reason:'observed',validUntilMs:cutoff,activeDispatchObservationId:null})};
  }
  function finalize(inv:Invocation,owner:PurchaseOwner,batch:VerifiedSourceStatusBatch|null,status:StatusOutcomeV1['outcome'],reason:StatusOutcomeV1['reason'],
    observe:(capture:SourceStatusCapturedProof,permit?:SourceStatusGracePermit)=>void):SourceStatusResult {
    return withWrite(inv,owner,()=>{
      const producerSettlement=settled(inv),old=projection(owner);
      if (!old || old.revision!==inv.claimRevision || old.active_request_id!==inv.claim?.observation_id || !inv.requestId) held();
      const b=binding(inv,owner),ids:string[]=[];
      capacity(owner.accountId,2,true);
      inv.finalizing=true;
      try {
        if (batch) {
          const seal=batches.get(batch);
          if (!seal || seal.used || seal.inv!==inv || !same(seal.owner,owner) || seal.dispatch!==old.active_request_id || seal.revision!==old.revision) held();
          validateBinding(seal.binding,inv,owner); seal.used=true;
          const {observation:o,captured:c}=seal;
          const evidence=parseStatusEvidenceV1({...base(b,inv.requestId,now()),kind:'status',status:o.status,subscriptionGroupIdentifier:o.subscriptionGroupIdentifier,
            transaction:o.transaction,renewal:o.renewal,transactionProofHash:c.capture.proofHash,renewalProofHash:c.renewalHash,
            providerResponseDigest:digest('source-status-provider-response/v1',inv.response),normalizedClaimDigest:digest('source-status-normalized/v1',o)});
          if (evidence.kind!=='status') held();
          let permit:SourceStatusGracePermit|undefined;
          if (o.status==='billing_grace_period' && o.renewal.gracePeriodExpiresDate!==null && o.renewal.gracePeriodExpiresDate>now()) {
            permit=Object.freeze(Object.create(null)) as SourceStatusGracePermit;
            permits.set(permit,{db,inv,proof:c.capture.proof,jws:c.capture.exactJws,accountId:owner.accountId,cutoff:Math.min(o.renewal.gracePeriodExpiresDate,add(now(),300000)),
              frame:inv.frame!,request:inv.requestId,revision:old.revision,observation:statusEvidenceIdV1(evidence),check:()=>{
                assertFrame(inv,owner); settled(inv); const current=projection(owner);
                if (now()>=Math.min(o.renewal.gracePeriodExpiresDate!,add(evidence.recordedAtMs,300000))) held();
                if (current?.revision!==old.revision || current.active_request_id!==old.active_request_id || c.renewal.originalTransactionId!==owner.originalTransactionId ||
                  c.renewal.productId!==c.capture.proof.productId) held();
              },used:false});
          }
          observe(c.capture,permit);
          const candidates=db.prepare("SELECT * FROM apple_purchase_status_observations WHERE account_id=? AND original_transaction_id=? AND event_kind='status' AND json_extract(evidence_json,'$.transaction.transactionId')=? LIMIT 101")
            .all(owner.accountId,owner.originalTransactionId,evidence.transaction.transactionId) as ObservationRow[];
          if (candidates.length>100) held();
          const replay=candidates.find(row=>{
            const {e}=decode(row,inv,owner);
            return e.kind==='status' && compareStatusEvidenceV1({...e,bindingId:evidence.bindingId},evidence).relation==='replay';
          });
          const row=replay??append(inv,owner,b,evidence,digest('source-status-observation-event/v1',inv.requestId),true); ids.push(row.observation_id);
        }
        const selected=batch?reduce(inv,owner):{p:heldProjection(b,owner,old.revision+1,null,reason),binding:b};
        const terminalEvidence=parseStatusEvidenceV1({...base(b,inv.requestId,now()),kind:'outcome',outcome:status,reason,producerSettlement,observationIds:ids,resultingRevision:old.revision+1});
        append(inv,owner,b,terminalEvidence,digest('source-status-outcome-event/v1',inv.requestId),true);
        saveProjection(inv,owner,selected.binding,selected.p,old,batch&&selected.p.observationId!==null?'current':'held',null,null,inv.claim!.observation_id);
        assertFrame(inv,owner);
        return Object.freeze({status,requestId:inv.requestId,observationIds:Object.freeze(ids),revision:old.revision+1,reason});
      } finally { inv.finalizing=false; }
    });
  }
  function invalidate(inv:Invocation,owner:PurchaseOwner,e:StatusEvidenceV1,eventKey:string):void {
    assertFrame(inv,owner); settled(inv);
    const b=binding(inv,owner),old=projection(owner);
    const exists=db.prepare('SELECT * FROM apple_purchase_status_observations WHERE account_id=? AND event_kind=? AND event_key=?').get(owner.accountId,e.kind,eventKey) as ObservationRow|undefined;
    if (exists) { decode(exists,inv,owner); return; }
    append(inv,owner,b,e,eventKey);
    if (old) {
      decodeProjection(old,inv,owner);
      const p=heldProjection(b,owner,old.revision+1,old.active_request_id,e.kind==='history'?'history_changed':e.kind==='notification'?e.reason:'ledger_changed');
      saveProjection(inv,owner,b,p,old,'held',old.dispatch_state,old.request_deadline_ms);
    }
  }
  function hooks(inv:Invocation,deliveryKey?:string):SourceStatusReconciliationHooks {
    return {
      ledgerHooks:{
        withDeliveryWrite:<T>(effect:()=>T):T=>{
          if (!inv.actor) held();
          // Delivery's original verifier must have completed with resource settlement.
          principal(inv); settled(inv);
          const actor=inv.actor;
          if (db.inTransaction || inv.frame) held();
          return writer.lifecycle.withActiveWrite(actor,()=>{
            inv.frame=Object.freeze({});
            try {
              principal(inv); const seal=native(inv.last); consumeSourceSubscriptionStatusContinuity(db,input.continuity,seal,now()); inv.last=seal;
              const result=synchronous(effect()); principal(inv); writer.assertWithinWrite(actor); integrity(db); return result;
            } finally {inv.frame=null;}
          });
        },
        afterLedgerMutation:change=>{
          if (change.observationOnly || inv.finalizing) return;
          const owner=installed(change.originalTransactionId); assertFrame(inv,owner);
          const old=projection(owner); if (!old) return;
          const p=decodeProjection(old,inv,owner); if (p.ledgerFingerprintDigest===head(owner).fingerprint) return;
          if (!deliveryKey) held();
          const request=digest('source-status-delivery-command/v1',[owner.accountId,deliveryKey,change.transactionId,change.proofHash]);
          const b=binding(inv,owner);
          invalidate(inv,owner,parseStatusEvidenceV1({...base(b,request,now()),kind:'outcome',outcome:'unavailable',reason:'ledger_changed',
            producerSettlement:settled(inv),observationIds:[],resultingRevision:old.revision+1}),digest('source-status-delivery-event/v1',request));
        },
        entitlement:grant=>{
          if (!inv.actor || inv.actor.accountId!==grant.accountId) held();
          principal(inv);
          const owner=installed(grant.originalTransactionId); principal(inv,owner);
          const h=head(owner),deny={active:false,effectiveExpiresAtMs:grant.ordinaryExpiresAtMs};
          if (!h.row || h.ambiguous || h.row.transaction_id!==grant.transactionId || h.row.revocation_date_ms!==null ||
            h.row.is_upgraded!==0 || h.row.purchase_date_ms>now()) return deny;
          if (grant.productType!=='Auto-Renewable Subscription') return {active:grant.ordinaryActive,effectiveExpiresAtMs:grant.ordinaryExpiresAtMs};
          const row=projection(owner); if (!row || row.projection_state!=='current' || row.active_request_id!==null) return deny;
          try {
            const p=decodeProjection(row,inv,owner);
            if (p.ledgerFingerprintDigest!==h.fingerprint || p.validUntilMs===null || now()>=p.validUntilMs || !p.observationId) return deny;
            const o=db.prepare('SELECT * FROM apple_purchase_status_observations WHERE observation_id=?').get(p.observationId) as ObservationRow|undefined;
            if (!o) return deny; const {e}=decode(o,inv,owner);
            if (e.kind!=='status' || e.transaction.transactionId!==h.row.transaction_id || e.transactionProofHash!==h.row.proof_hash ||
              e.recordedAtMs>now() || now()>=add(e.recordedAtMs,300000)) return deny;
            const expected=e.status==='active'?Math.min(e.transaction.expiresDate,add(e.recordedAtMs,300000)):
              e.status==='billing_grace_period' && e.renewal.gracePeriodExpiresDate!==null?Math.min(e.renewal.gracePeriodExpiresDate,add(e.recordedAtMs,300000)):null;
            if (expected!==p.validUntilMs || !(p.result==='active'&&e.status==='active'||p.result==='billing_grace_period'&&e.status==='billing_grace_period')) return deny;
            principal(inv,owner); return {active:true,effectiveExpiresAtMs:p.validUntilMs};
          } catch { return deny; }
        },
      },
      afterHistoryPage:page=>{
        const b=binding(inv,page.owner),request=digest('source-status-history/v1',[page.owner.accountId,page.handle,page.pageIndex]);
        invalidate(inv,page.owner,parseStatusEvidenceV1({...base(b,request,now()),kind:'history',
          page:{handle:page.handle,pageIndex:page.pageIndex,pageDigest:page.pageDigest},transactionProofHashes:page.transactionProofHashes,
          renewalProofHashes:[],reason:'history_changed'}),digest('source-status-history-event/v1',request));
      },
      afterNotification:notification=>{
        const b=binding(inv,notification.owner),request=digest('source-status-notification/v1',[notification.owner.accountId,notification.notificationId]);
        invalidate(inv,notification.owner,parseStatusEvidenceV1({...base(b,request,now()),kind:'notification',notificationId:notification.notificationId,
          payloadDigest:notification.payloadDigest,transactionProofHashes:notification.transactionProofHashes,renewalProofHashes:notification.renewalProofHashes,
          reason:notification.reason}),digest('source-status-notification-event/v1',request));
      },
    };
  }
  function ownerWriter(inv:Invocation):PurchaseOwnerWriter {
    if (!inv.actor) held(); const actor=inv.actor;
    const check=(candidate:AccountContext)=>{if (!same(candidate,actor)) held(); principal(inv);};
    return {
      lifecycle:{assertActive:check,withActiveWrite:<T>(candidate:AccountContext,effect:()=>T):T=>{
        check(candidate); settled(inv);
        if (inv.frame || db.inTransaction) held();
        return writer.lifecycle.withActiveWrite(actor,()=>{
          inv.frame=Object.freeze({});
          try {check(candidate); const seal=native(inv.last); consumeSourceSubscriptionStatusContinuity(db,input.continuity,seal,now()); inv.last=seal;
            const r=synchronous(effect());check(candidate);integrity(db);return r;
          } finally {inv.frame=null;}
        });
      }},
      assertWithinWrite:candidate=>{check(candidate);if (!inv.frame || !db.inTransaction) held();writer.assertWithinWrite(actor);},
      lifecycleStoreOptions:{assertRootWriter:candidate=>{if (candidate!==db || !inv.frame) held();writer.lifecycleStoreOptions.assertRootWriter(db);principal(inv);}},
    };
  }
  function backgroundWriter(inv:Invocation):PurchaseBackgroundWriter {
    return {capture:owner=>{
      if (inv.actor) held(); const o=Object.freeze({...owner});principal(inv,o);
      return {assertCurrent:()=>{principal(inv,o);},withWrite:<T>(effect:()=>T):T=>withWrite(inv,o,effect),
        assertWithinWrite:candidate=>{if (candidate!==db) held(); assertFrame(inv,o);}};
    }};
  }
  function invocation(actor?:AccountContext):Invocation {
    let a:AccountContext|null=null;
    if (actor) {
      if (Object.keys(actor).sort().join(',')!=='accountId,authUserId,epoch,sessionId' || !accountUuid.test(actor.accountId) ||
        ![actor.authUserId,actor.sessionId].every(s=>typeof s==='string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(s)) || !Number.isSafeInteger(actor.epoch) || actor.epoch<0) held();
      a=Object.freeze({...actor});
    }
    const initial=native();
    const inv:Invocation={actor:a,initial,last:initial,fenced:false,start:performance.now(),deadline:add(now(),10000),handles:[],unknown:false,
      owner:null,proofs:new Map(),renewals:new Map(),response:null,cacheBytes:0,frame:null,finalizing:false,requestId:null,claim:null,claimRevision:null};
    principal(inv); return inv;
  }
  async function refresh(inv:Invocation,original:string,key:string,observe:(capture:SourceStatusCapturedProof,permit?:SourceStatusGracePermit)=>void):Promise<SourceStatusResult> {
    const owner=installed(original); inv.owner=owner; principal(inv,owner);
    const replay=begin(inv,owner,key); if (replay) return replay;
    const verifier=wrappedVerifier(inv);
    const transport=input.statusTransport ? {statuses:async(id:string)=>{
      const response=await track(inv,'status-transport',()=>input.statusTransport!.statuses(id),1048576); inv.response=response; return response;
    }} : undefined;
    const reader=new AppleSubscriptionStatusReader(config,{appAppleId:input.appAppleId,owners:{read:id=>installed(id)},verifier,...(transport?{transport}:{})});
    const result=await reader.read(owner); principal(inv,owner); settled(inv);
    if (result.status!=='observed') {
      if (result.status==='unknown') held();
      const outcome=finalize(inv,owner,null,result.status==='rejected'?'rejected':'unavailable',result.status==='pending'?'empty':'invalid_evidence',observe);
      retained.delete(inv.requestId!);return outcome;
    }
    if (result.observations.length!==1) held();
    const observation=result.observations[0]!,captured=correlate(inv,owner,observation);
    const batch=Object.freeze(Object.create(null)) as VerifiedSourceStatusBatch;
    batches.set(batch,{inv,owner,binding:binding(inv,owner),observation,captured,dispatch:inv.claim!.observation_id,revision:inv.claimRevision!,used:false});
    const outcome=finalize(inv,owner,batch,'observed','observed',observe);retained.delete(inv.requestId!);return outcome;
  }
  function reconcile(inv:Invocation,key:string):SourceStatusResult {
    if (!inv.actor) held(); const request=requestId(inv.actor.accountId,key),original=retained.get(request);
    // Close producer admission before treating the retained handle set as complete.
    if (!original || !original.fenced || !original.claim || !same(original.actor,inv.actor)) held();
    const owner=installed(original.claim.original_transaction_id); principal(inv,owner);
    const replay=terminal(inv,owner,request); if (replay) return replay;
    const producerSettlement=settled(original);
    const result=withWrite(inv,owner,()=>{
      const old=projection(owner),b=binding(inv,owner);
      if (!old || old.active_request_id!==original.claim!.observation_id || old.active_request_id===null) held();
      decode(original.claim!,inv,owner); capacity(owner.accountId,1,true);
      const e=parseStatusEvidenceV1({...base(b,request,now()),kind:'outcome',outcome:'unknown',reason:'unknown',producerSettlement,
        observationIds:[],resultingRevision:old.revision+1});
      append(inv,owner,b,e,digest('source-status-outcome-event/v1',request),true);
      saveProjection(inv,owner,b,heldProjection(b,owner,old.revision+1,null,'unknown'),old,'held',null,null,original.claim!.observation_id);
      return Object.freeze({status:'unknown',requestId:request,observationIds:[],revision:old.revision+1,reason:'unknown'});
    });
    retained.delete(request);return result;
  }
  function context(inv:Invocation,deliveryKey?:string) {
    return {verifier:wrappedVerifier(inv),hooks:hooks(inv,deliveryKey),ownerWriter:inv.actor?ownerWriter(inv):null,backgroundWriter:backgroundWriter(inv),
      history:input.history?{page:async(original:string,revision:string|null)=>track(inv,'history-transport',()=>input.history!.page(original,revision),1048576)}:undefined,
      refresh:(original:string,key:string,observe:(capture:SourceStatusCapturedProof,permit?:SourceStatusGracePermit)=>void)=>refresh(inv,original,key,observe),
      reconcile:(key:string)=>reconcile(inv,key),assertWrite:()=>{if (!inv.actor || !inv.frame || !db.inTransaction) held();writer.assertWithinWrite(inv.actor);principal(inv);},
      check:()=>{principal(inv,inv.owner??undefined);},clock:now};
  }
  async function run<T>(actor:AccountContext|undefined,operation:(c:ReturnType<typeof context>)=>Promise<T>,deliveryKey?:string):Promise<T> {
    if (live) held();
    for (const previous of unsettledInvocations) { settled(previous);unsettledInvocations.delete(previous); }
    const inv=invocation(actor);live=inv;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const fence=async():Promise<never>=>{
      inv.fenced=true;inv.proofs.clear();inv.renewals.clear();inv.response=null;
      const cancellations=inv.handles.map(h=>{
        try {return input.producers.requestCancellation(h).catch(()=>{inv.unknown=true;});} catch {inv.unknown=true;return Promise.resolve();}
      });
      let cancelTimer:ReturnType<typeof setTimeout>|undefined;
      await Promise.race([Promise.all(cancellations),new Promise<void>(resolve=>{cancelTimer=setTimeout(resolve,500);})]);
      if (cancelTimer) clearTimeout(cancelTimer);return held();
    };
    try {
      const work=operation(context(inv,deliveryKey));void work.catch(()=>{});
      const result=await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void fence().catch(reject);},Math.max(0,9500-(performance.now()-inv.start)));})]);
      principal(inv,inv.owner??undefined);settled(inv);return result;
    } finally {
      if (timer) clearTimeout(timer);inv.fenced=true;inv.proofs.clear();inv.renewals.clear();inv.response=null;inv.cacheBytes=0;
      try {settled(inv);} catch {unsettledInvocations.add(inv);}
      if (live===inv) live=null;
    }
  }
  function read<T>(actor:AccountContext,operation:(c:ReturnType<typeof context>)=>T):T {
    const inv=invocation(actor);
    try {const result=synchronous(operation(context(inv)));principal(inv,inv.owner??undefined);return result;}
    finally {inv.fenced=true;}
  }
  return Object.freeze({run,read});
}
