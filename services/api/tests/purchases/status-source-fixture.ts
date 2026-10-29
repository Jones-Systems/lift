import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import type { JWSRenewalInfoDecodedPayload, ResponseBodyV2DecodedPayload, HistoryResponse } from '@apple/app-store-server-library';
import { source26Fixture, A, B } from '../lifecycle-reauthentication-fixture.js';
import type { Sqlite } from '../../src/storage.js';
import { migrate } from '../../src/storage.js';
import { selectSourceSubscriptionStatusMigrations } from '../../src/purchases/status-source-migrations.js';
import { bindSuppressionAuthority } from '../../src/lifecycle/guards.js';
import { evidenceCanonical } from '../../src/lifecycle/evidence-codec.js';
import { bindSourceLifecycleEvidenceWitnessReader, type SourceLifecycleEvidenceGeneration, type SourceLifecycleEvidenceWitnessReader } from '../../src/lifecycle/evidence-store.js';
import { bindSourceSubscriptionStatusContinuityWitness, type SourceSubscriptionStatusContinuityWitness } from '../../src/lifecycle/reauthentication-proof.js';
import { createSourceAppleSubscriptionStatus, type SourceStatusFacade, type SourceStatusProducerKind, type SourceStatusProducerCustody,
  type SourceStatusOriginalProducer, type SourceStatusProducerSettlement } from '../../src/purchases/status-source.js';
import { AppleProofError, type VerifiedAppleTransaction, type AppleSandboxConfiguration } from '../../src/purchases/types.js';
import type { PurchaseOwner } from '../../src/purchases/reconciliation.types.js';

export { A, B };
export const configuration={mode:'source-only',cohort:'subscription-status-v1'} as const;
export const apple:AppleSandboxConfiguration={bundleId:'com.form.status.source',products:[
  {productId:'form.plus.month',type:'Auto-Renewable Subscription',entitlement:'form_plus'},
  {productId:'form.plus.lifetime',type:'Non-Consumable',entitlement:'form_plus'},
]};
export const appAppleId=123456789;
export const owner:PurchaseOwner=Object.freeze({accountId:A.accountId,appAccountToken:A.accountId,originalTransactionId:'10000',bundleId:apple.bundleId,environment:'Sandbox'});
export function deferred<T>() {
  let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{}); return {promise,resolve,reject};
}
export async function upgrade27(db:Sqlite,path:string) {
  return migrate(db,path,selectSourceSubscriptionStatusMigrations(),'selected-migration-22','selected-migration-23',
    'selected-lifecycle-evidence-24','selected-provider-revocation-25','selected-action-reauthentication-26','selected-subscription-status-27');
}
export async function source27Fixture(t:TestContext,upgrade=true) {
  const baseCleanup:(()=>unknown)[]=[];let cleanupExtra=async()=>{};
  t.after(async()=>{try {await cleanupExtra();} finally {for(const cleanup of baseCleanup)await cleanup();}});
  const base=source26Fixture({after:(callback:()=>unknown)=>baseCleanup.push(callback),diagnostic:t.diagnostic.bind(t)} as unknown as TestContext); configure(base.db);
  if (upgrade) {base.barrier();await upgrade27(base.db,base.path);}
  let calls=0,lost=false,captureMissing=false,throwStart:SourceStatusProducerKind|null=null;
  type Producer={kind:SourceStatusProducerKind;done:ReturnType<typeof deferred<void>>;handle:SourceStatusOriginalProducer;completed:boolean;resourcesEnded:boolean;
    outcome:'success'|'rejection'|'cancelled';cancelRequested:boolean;cancelComplete:boolean;cancel:ReturnType<typeof deferred<void>>;finishResources:()=>void;stop:()=>void};
  const registry=new WeakMap<Promise<unknown>,Producer>(),entries:Producer[]=[],handles=new Map<SourceStatusOriginalProducer,Producer>();
  const journalPath=base.independent+'/status-producers.json';
  const journal=()=>writeFileSync(journalPath,evidenceCanonical({lost,producers:entries.map((p,i)=>({id:i,kind:p.kind,completed:p.completed,
    resourcesEnded:p.resourcesEnded,cancelRequested:p.cancelRequested,cancelComplete:p.cancelComplete}))}),{mode:0o600});
  const pauses=new Map<SourceStatusProducerKind,ReturnType<typeof deferred<void>>>();
  const resourceHolds=new Set<SourceStatusProducerKind>();
  let cancelPending=false,cancelRejected=false;
  const before=new Map<SourceStatusProducerKind,()=>void>();
  const afterCompletion=new Map<SourceStatusProducerKind,()=>void>();
  function operation<T>(kind:SourceStatusProducerKind,effect:()=>T|Promise<T>):Promise<T> {
    assert.equal(base.db.inTransaction,false,'original producer starts outside SQL');
    calls++;
    const result=deferred<T>(),handle=Object.freeze(Object.create(null)) as SourceStatusOriginalProducer;
    const p:Producer={kind,done:deferred<void>(),handle,completed:false,resourcesEnded:false,outcome:'success',cancelRequested:false,cancelComplete:false,
      cancel:deferred<void>(),stop:()=>{p.completed=true;p.outcome='cancelled';p.resourcesEnded=true;p.done.resolve();result.reject(new Error('synthetic producer teardown'));},finishResources:()=>{p.resourcesEnded=true;if(p.cancelRequested){p.cancelComplete=true;p.cancel.resolve();}journal();}};
    registry.set(result.promise,p);entries.push(p);handles.set(handle,p);journal();
    if (throwStart===kind) {void result.promise.catch(()=>{});throw new Error('synthetic original start unknown');}
    void (async()=>{
      try {
        before.get(kind)?.(); const gate=pauses.get(kind);if(gate)await gate.promise;
        const value=await effect();p.completed=true;p.outcome='success';if(!resourceHolds.has(kind))p.resourcesEnded=true;journal();p.done.resolve();result.resolve(value);
        const completed=afterCompletion.get(kind);afterCompletion.delete(kind);completed?.();
      } catch(e) {p.completed=true;p.outcome='rejection';if(!resourceHolds.has(kind))p.resourcesEnded=true;journal();p.done.resolve();result.reject(e);}
    })();
    return result.promise;
  }
  const producers:SourceStatusProducerCustody={
    capture:(kind,promise)=>{const p=registry.get(promise);return !captureMissing&&p?.kind===kind?p.handle:null;},
    read:h=>{
      const p=handles.get(h);
      return !lost&&p&&p.completed&&p.resourcesEnded&&(!p.cancelRequested||p.cancelComplete)?{state:'settled',outcome:p.outcome}:{state:'unproven'};
    },
    requestCancellation:h=>{
      const p=handles.get(h);if(!p||lost)return Promise.reject(new Error('synthetic lost producer custody'));
      p.cancelRequested=true;journal();
      if(cancelRejected)return Promise.reject(new Error('synthetic cleanup rejection'));
      if(!cancelPending){pauses.get(p.kind)?.resolve();p.finishResources();}
      return p.cancel.promise;
    },
  };
  const proofs=new Map<string,unknown>(),renewals=new Map<string,unknown>(),notifications=new Map<string,unknown>();
  function signed(map:Map<string,unknown>,value:unknown):string {
    const jws=`synthetic.${Buffer.from(randomUUID()).toString('base64url')}.signature`;map.set(jws,structuredClone(value));return jws;
  }
  function lookup<T>(map:Map<string,unknown>,jws:string):T {
    if(!map.has(jws))throw new AppleProofError('apple_signature_invalid');return structuredClone(map.get(jws)) as T;
  }
  const tx=(changes:Partial<VerifiedAppleTransaction & {subscriptionGroupIdentifier:string}>={})=>({transactionId:'10001',originalTransactionId:'10000',
    bundleId:apple.bundleId,environment:'Sandbox',productId:'form.plus.month',type:'Auto-Renewable Subscription',appAccountToken:A.accountId,
    inAppOwnershipType:'PURCHASED',purchaseDate:base.now()-20000,signedDate:base.now(),quantity:1,expiresDate:base.now()+600000,
    subscriptionGroupIdentifier:'100',...changes});
  const rn=(changes:Record<string,unknown>={})=>({originalTransactionId:'10000',productId:'form.plus.month',appAccountToken:A.accountId,environment:'Sandbox',
    signedDate:base.now(),autoRenewStatus:1,...changes});
  const item=(status=1,proof=tx(),renewal:unknown=rn())=>({status,originalTransactionId:proof.originalTransactionId,
    signedTransactionInfo:signed(proofs,proof),signedRenewalInfo:signed(renewals,renewal)});
  const envelope=(items:unknown[])=>({environment:'Sandbox',bundleId:apple.bundleId,appAppleId,data:[{subscriptionGroupIdentifier:'100',lastTransactions:items}]});
  let response:unknown=envelope([item()]),historyResponse:HistoryResponse={bundleId:apple.bundleId,environment:'Sandbox' as NonNullable<HistoryResponse['environment']>,revision:'first',hasMore:false,signedTransactions:[]};
  const verifier={verify:(jws:string)=>operation('transaction-verifier',()=>lookup<VerifiedAppleTransaction>(proofs,jws)),
    renewal:(jws:string)=>operation('renewal-verifier',()=>lookup<JWSRenewalInfoDecodedPayload>(renewals,jws)),
    notification:(jws:string)=>operation('notification-verifier',()=>lookup<ResponseBodyV2DecodedPayload>(notifications,jws))};
  const transport={statuses:(_id:string)=>operation('status-transport',()=>structuredClone(response))};
  const history={page:(_id:string,_revision:string|null)=>operation('history-transport',()=>structuredClone(historyResponse))};
  function seed(store:Sqlite,o=owner,proof=tx({transactionId:'9999',purchaseDate:base.now()-40000,signedDate:base.now()-1000})) {
    store.prepare('INSERT INTO apple_purchase_owners VALUES(?,?,?,?,?)').run(o.originalTransactionId,o.accountId,o.bundleId,'Sandbox',base.now());
    const jws=signed(proofs,proof);
    store.prepare('INSERT INTO apple_purchase_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(proof.transactionId,proof.originalTransactionId,o.accountId,proof.productId,
      proof.type,o.accountId,proof.purchaseDate,proof.signedDate,proof.expiresDate??null,proof.revocationDate??null,proof.isUpgraded?1:0,
      (awaitlessHash(jws)),jws,base.now());
  }
  seed(base.db);
  const bindings=new WeakMap<Sqlite,{witness:ReturnType<typeof bindSourceLifecycleEvidenceWitnessReader>;continuity:ReturnType<typeof bindSourceSubscriptionStatusContinuityWitness>}>();
  const compose=(store:Sqlite=base.db):{source:SourceStatusFacade;witness:SourceLifecycleEvidenceWitnessReader;continuity:SourceSubscriptionStatusContinuityWitness}=>{
    configure(store);bindSuppressionAuthority(store,base.authority);
    let bound=bindings.get(store);
    if(!bound){
      const witness=bindSourceLifecycleEvidenceWitnessReader(store,base.authority,()=>{
        const r=JSON.parse(readFileSync(base.recordPath,'utf8')) as SourceLifecycleEvidenceGeneration;
        return {databaseGeneration:r.databaseGeneration,mainStoreId:r.mainStoreId,witnessRevision:r.witnessRevision};
      });
      const continuity=bindSourceSubscriptionStatusContinuityWitness(store,witness,{recordPath:base.recordPath});bound={witness,continuity};bindings.set(store,bound);
    }
    return {source:createSourceAppleSubscriptionStatus({configuration,db:store,authority:base.authority,...bound,apple,appAppleId,verifier,statusTransport:transport,
      history,producers,clock:base.now}),...bound};
  };
  journal();
  const barrier=()=>{
    base.barrier();const saved=JSON.parse(readFileSync(journalPath,'utf8')) as {lost:boolean;producers:unknown[]};
    assert.equal(saved.lost,false);assert.equal(saved.producers.length,entries.length);
    for(const p of entries)assert.equal(producers.read(p.handle).state,'settled','ALL original resources settled');
  };
  const restore=(snapshot:string,failAfterCopy=false)=>{base.unavailable();barrier();base.restore(snapshot,failAfterCopy);};
  const fixtureBytes=():number=>{
    const size=(path:string):number=>{const stat=lstatSync(path);return stat.isDirectory()?readdirSync(path).reduce((n,name)=>n+size(path+'/'+name),0):stat.size;};
    return size(base.root);
  };
  cleanupExtra=async()=>{
    try {
      const bytes=fixtureBytes();
      t.diagnostic(`synthetic27 current footprint before settlement/close: ${bytes} bytes; independent original producer journal retained until exact fixture cleanup`);
      assert.ok(bytes<67108864,'full fixture including live journals/copies remains below64MiB');
    } finally {
      for(const gate of pauses.values())gate.resolve();
      for(const p of entries){if(!p.completed&&throwStart===p.kind)p.stop();p.finishResources();p.cancel.resolve();}
      await Promise.allSettled(entries.map(p=>p.done.promise));
      assert.ok(entries.every(p=>p.completed&&p.resourcesEnded&&(!p.cancelRequested||p.cancelComplete)),'owned original producers and resources settled before fixture cleanup');
      t.diagnostic(`synthetic27 original producers settled=${entries.length}; unsettled resources=0 before exact fixture cleanup`);
    }
  };
  return {base,producers,compose,seed,tx,rn,item,envelope,verifier,transport,history,
    response:(r:unknown)=>{response=r;},historyResponse:(r:HistoryResponse)=>{historyResponse=r;},
    signedTransaction:(p:unknown)=>signed(proofs,p),signedRenewal:(r:unknown)=>signed(renewals,r),signedNotification:(n:unknown)=>signed(notifications,n),
    pause:(kind:SourceStatusProducerKind)=>{const gate=deferred<void>();pauses.set(kind,gate);return ()=>{pauses.delete(kind);gate.resolve();};},
    before:(kind:SourceStatusProducerKind,f:()=>void)=>{before.set(kind,f);},calls:()=>calls,
    afterCompletionOnce:(kind:SourceStatusProducerKind,f:()=>void)=>{afterCompletion.set(kind,f);},
    producerStates:()=>entries.map(p=>({kind:p.kind,completed:p.completed,resourcesEnded:p.resourcesEnded,cancelRequested:p.cancelRequested,cancelComplete:p.cancelComplete})),
    holdResources:(kind:SourceStatusProducerKind)=>resourceHolds.add(kind),finishResources:()=>{for(const p of entries)p.finishResources();},
    loseCustody:()=>{lost=true;journal();},captureMissing:()=>{captureMissing=true;},throwStart:(kind:SourceStatusProducerKind)=>{throwStart=kind;},
    cancellation:(pending:boolean,rejected=false)=>{cancelPending=pending;cancelRejected=rejected;},barrier,restore,fixtureBytes,
    nativeRecord:()=>JSON.parse(readFileSync(base.recordPath,'utf8')) as Record<string,unknown>,
    writeNative:(r:unknown)=>{writeFileSync(base.recordPath,evidenceCanonical(r));chmodSync(base.recordPath,0o600);},
  };
}
import { createHash } from 'node:crypto';
function awaitlessHash(s:string):string{return createHash('sha256').update(s).digest('hex');}

function configure(db:Sqlite):void {db.pragma('foreign_keys=ON');db.pragma('busy_timeout=5000');db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');}
