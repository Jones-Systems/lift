import type { LifecycleAdapter, LifecycleResult } from '../../lifecycle/types.js';
import type { StoredMeasure } from '../types.js';
import { fail, measure } from '../validation.js';
import { wearablePurgeOrder, wearableTables } from './schema.js';
import type { WearablePersistenceDependencies } from './types.js';

export function createWearableLifecycleAdapter(deps: WearablePersistenceDependencies): LifecycleAdapter {
  const {db,lifecycle,control,externalLifecycle:external}=deps;
  const unavailable=():LifecycleResult=>({status:'unavailable',reason:'wearable_external_lifecycle_required'});
  const externalCall=(effect:()=>LifecycleResult):LifecycleResult=>{
    try{return effect();}catch{return {status:'unknown',reason:'wearable_external_effect_unknown_reconcile_before_retry'};}
  };
  const count=(accountId:string)=>wearableTables.reduce((total,table)=>total+
    (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId) as {n:number}).n,0);
  function verify(accountId:string,epoch:number):LifecycleResult {
    try{control.assertSuppression(accountId,epoch);}catch{return {status:'unknown',reason:'wearable_canonical_suppression_unproved'};}
    if(!external)return unavailable();
    const result=externalCall(()=>external.verifySuppressed(accountId,epoch));
    if(result.status!=='complete')return result;
    try{control.assertSuppression(accountId,epoch);}catch{return {status:'unknown',reason:'wearable_canonical_suppression_unproved'};}
    return {status:'complete',reason:'canonical_ledger_and_external_fences_confirmed'};
  }
  return {
    category:'wearables',
    inventory(ctx) {
      lifecycle.assertActive(ctx);const localCount=count(ctx.accountId);
      const result=external?externalCall(()=>external.inventory(ctx)):unavailable();
      lifecycle.assertActive(ctx);
      return {status:result.status,category:'wearables',count:localCount+(result.count??0),
        reason:result.status==='complete'?'local_relations_and_external_state_inventoried':result.reason??'external_inventory_unproved'};
    },
    export(ctx,snapshot) {
      lifecycle.assertActive(ctx);
      if(!snapshot||typeof snapshot.append!=='function'||!Number.isFinite(snapshot.snapshotAtMs))fail('health_export_snapshot_required',503);
      const append=(value:unknown)=>{lifecycle.assertActive(ctx);snapshot.append('wearables',value);lifecycle.assertActive(ctx);};
      const omissions=['credentials','cursors','raw_provider_intents','receipt_results','suggestion_plan_snapshots'];
      if(!deps.qualifyExport){
        append({kind:'manifest',status:'unavailable',reason:'trusted_export_qualification_required',omissions});
        return {category:'wearables',status:'unavailable',reason:'trusted_export_qualification_required',count:0};
      }
      const sizes=db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes,max(length(CAST(data AS BLOB))) AS largest FROM wearable_measures WHERE account_id=?')
        .get(ctx.accountId) as {n:number;bytes:number;largest:number|null};
      if(sizes.n>10000||sizes.bytes>16*1024*1024||(sizes.largest??0)>1024*1024)fail('health_export_packaging_required',413);
      let exported=0,unqualified=0;
      const records=db.prepare('SELECT data FROM wearable_measures WHERE account_id=? ORDER BY connection_id,generation,record_id').iterate(ctx.accountId) as Iterable<{data:string}>;
      for(const row of records){
        const stored=JSON.parse(row.data) as StoredMeasure;
        if(stored.deleted)continue;
        const {connectionId,generation,provider,importedAt,digest,aiEligible,provenance,deleted,...payload}=stored;
        if(aiEligible!==false||provenance!=='unqualified_import')fail('health_storage_provenance_invalid',503);
        const normalized:StoredMeasure={...measure(payload),connectionId,generation,provider,importedAt,digest,aiEligible:false,provenance,deleted:false};
        lifecycle.assertActive(ctx);const qualified=deps.qualifyExport(ctx,structuredClone(normalized));lifecycle.assertActive(ctx);
        if(qualified!==true){unqualified++;continue;}
        append({kind:'measure',data:normalized});exported++;
      }
      const result=external?externalCall(()=>external.export(ctx,{snapshotAtMs:snapshot.snapshotAtMs,
        append:(category,value)=>{lifecycle.assertActive(ctx);snapshot.append(category,value);lifecycle.assertActive(ctx);}})):unavailable();
      lifecycle.assertActive(ctx);
      const status=unqualified?'unavailable':result.status;
      append({kind:'manifest',status,exported,unqualified,omissions,externalStatus:result.status,aiEligible:false});
      return {category:'wearables',status,count:exported,reason:unqualified?'unqualified_records_omitted':result.reason??'qualified_local_export_only'};
    },
    suppress(accountId,epoch) {
      if(!db.inTransaction)return {status:'unavailable',reason:'root_lifecycle_transaction_required'};
      try{control.assertSuppression(accountId,epoch);}catch{return {status:'unknown',reason:'wearable_canonical_suppression_unproved'};}
      if(!external)return unavailable();
      const result=externalCall(()=>external.suppress(accountId,epoch));
      return result.status==='complete'?verify(accountId,epoch):result;
    },
    purge(requestId,accountId) {
      if(!db.inTransaction)return {status:'unavailable',reason:'root_lifecycle_transaction_required'};
      const ready=control.purgeReadiness(requestId,accountId);
      if(ready.status!=='ready')return ready;
      const suppressed=verify(accountId,ready.epoch);if(suppressed.status!=='complete')return suppressed;
      const result=externalCall(()=>external!.purge(requestId,accountId));if(result.status!=='complete')return result;
      let removed=0;
      for(const table of wearablePurgeOrder)removed+=db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
      if(count(accountId)!==0||verify(accountId,ready.epoch).status!=='complete')fail('health_purge_readback_failed',503);
      return {status:'complete',count:removed,reason:'owned_local_rows_erased_remote_provider_deletion_not_asserted'};
    },
    verifySuppressed:verify,
  };
}
