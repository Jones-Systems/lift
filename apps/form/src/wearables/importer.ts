import type { BoundHealthApi, ImportAck, SessionFence } from './model.js';
import type { FormHealthNative } from './native.js';
import { normalizeNative } from './normalize.js';
import { sameIntent } from './upload-intent.js';
import type { AcknowledgedUploadIntent, HealthImportInput, ReconcileHealthCheckpoint, UploadIntentBinding, UploadIntentJournal, UploadIntentMetadata, UploadIntentRecord, UploadIntentSnapshot } from './upload-intent.js';
export type ImportStatus = {status:'complete'|'unknown_no_accessible_data'|'unavailable'|'cancelled'|'unknown';pages:number};
export function createHealthImport(options:{native:FormHealthNative;api:BoundHealthApi;session:SessionFence;
  configured:boolean;consentCurrent:()=>boolean;newKey:()=>string;isUnknown:(e:unknown)=>boolean;
  journal?:UploadIntentJournal;reconcileCheckpoint?:ReconcileHealthCheckpoint;
  onUnresolved:(intent:{key:string;accountId:string;sessionGeneration:string;connectionId:string})=>void}) {
  const session={accountId:options.session.accountId,sessionGeneration:options.session.sessionGeneration};
  let disposed=false,busy=false,epoch=0,held=false;
  let binding:UploadIntentBinding|null=null,snapshot:UploadIntentSnapshot|null=null,pending:UploadIntentRecord|null=null;
  let uncertain:{revision:string;next:UploadIntentRecord|null}|null=null;
  let cleanup:Promise<ImportStatus>|null=null;
  const reported=new Set<string>();
  const current=()=>!disposed&&options.session.isCurrentSession()&&options.consentCurrent();
  const configured=()=>options.configured&&!!options.journal&&!!options.reconcileCheckpoint;
  function check(generation:number){if(!current()||generation!==epoch)throw new Error('health_import_cancelled');}
  function bind(input:HealthImportInput):UploadIntentBinding {
    return {...session,connectionId:input.connectionId,generation:input.generation,type:input.type,from:input.from,to:input.to,
      stream:JSON.stringify(['healthkit-v1',input.type,input.from,input.to])};
  }
  function metadata(record:UploadIntentRecord|null):UploadIntentMetadata|null {
    return record?{binding:structuredClone(record.binding),key:record.key,pageId:record.pageId}:null;
  }
  function report(value:UploadIntentMetadata|null){
    if(value&&!reported.has(value.key)){
      reported.add(value.key);options.onUnresolved({key:value.key,accountId:value.binding.accountId,
        sessionGeneration:value.binding.sessionGeneration,connectionId:value.binding.connectionId});
    }
  }
  function scrub():Promise<ImportStatus>{
    if(cleanup)return cleanup;
    held=true;
    const value=metadata(pending??uncertain?.next??snapshot?.record??null);
    let operation:ReturnType<UploadIntentJournal['fenceAndScrub']>;
    try{operation=options.journal?options.journal.fenceAndScrub(value):Promise.resolve({status:'unknown'});}
    catch{operation=Promise.resolve({status:'unknown'});}
    pending=null;uncertain=null;snapshot=null;
    cleanup=operation.then(result=>{
      if(result.status!=='scrubbed'||!result.snapshot.fenced||
        (result.snapshot.record!==null&&result.snapshot.record.phase!=='scrubbed')||
        (value!==null&&!sameIntent(result.snapshot.record,{...value,phase:'scrubbed'})))return {status:'unknown',pages:0} as const;
      return {status:'cancelled',pages:0} as const;
    },()=>({status:'unknown',pages:0}));
    try{report(value);}catch{ /* Scrub must proceed even when root notification fails. */ }
    return cleanup;
  }
  function adopt(value:UploadIntentSnapshot){
    if(!value||typeof value.revision!=='string'||!value.revision||typeof value.fenced!=='boolean')throw new Error('health_journal_invalid');
    const record=value.record;
    if(value.fenced||record?.phase==='scrubbed'){held=true;throw new Error('health_import_reconciliation_required');}
    if(record){
      if(!binding||!sameIntent(record.binding,binding)){held=true;throw new Error('health_import_binding_changed');}
      if(!record.key||record.pageId!==record.key)throw new Error('health_journal_invalid');
      if(record.phase==='prepared'){
        const p=record.page;
        if(p.version!==1||p.pageId!==record.pageId||p.connectionId!==binding.connectionId||p.generation!==binding.generation||p.stream!==binding.stream)
          throw new Error('health_journal_invalid');
      }else if(record.phase!=='acknowledged'||!validAck(record.ack,record.pageId,record.ack.cursor)||
        !(record.ack.cursor===null||typeof record.ack.cursor==='string'))throw new Error('health_journal_invalid');
    }
    snapshot=structuredClone(value);pending=snapshot.record;
  }
  async function commit(next:UploadIntentRecord|null,generation:number){
    check(generation);const revision=snapshot!.revision;
    uncertain={revision,next:structuredClone(next)};
    let result;
    try{result=await options.journal!.compareAndSwap(revision,structuredClone(next),()=>check(generation));}
    catch{throw new Error('health_journal_unknown');}
    check(generation);
    if(result.status==='unknown')throw new Error('health_journal_unknown');
    if(result.status==='conflict'){held=true;throw new Error('health_journal_conflict');}
    if(result.snapshot.revision===revision||!sameIntent(result.snapshot.record,next))throw new Error('health_journal_unknown');
    adopt(result.snapshot);uncertain=null;
  }
  async function load(generation:number){
    check(generation);const value=await options.journal!.load();check(generation);
    if(uncertain){
      const attempt=uncertain;
      if(value.revision!==attempt.revision){
        if(!sameIntent(value.record,attempt.next)){held=true;throw new Error('health_journal_conflict');}
        adopt(value);uncertain=null;
      }else{
        if(!sameIntent(value.record,snapshot?.record)){held=true;throw new Error('health_journal_conflict');}
        adopt(value);await commit(attempt.next,generation);
      }
    }else adopt(value);
  }
  function validAck(ack:ImportAck,pageId:string,cursor:string|null){
    return ack&&ack.pageId===pageId&&ack.cursor===cursor&&Number.isSafeInteger(ack.accepted)&&ack.accepted>=0&&
      Number.isSafeInteger(ack.duplicates)&&ack.duplicates>=0;
  }
  async function send(generation:number){
    check(generation);
    if(pending?.phase==='prepared'){
      const command=structuredClone(pending);
      const ack=await options.api.importPage(structuredClone(command.page),command.key);check(generation);
      if(!validAck(ack,command.pageId,command.page.nextCursor))throw new Error('health_import_ack_unknown');
      await commit({...metadata(command)!,phase:'acknowledged',ack:structuredClone(ack)},generation);
    }
    if(pending?.phase!=='acknowledged')throw new Error('health_import_no_pending');
    const acknowledged=structuredClone(pending) as AcknowledgedUploadIntent;
    // Root must read the authoritative server checkpoint, compare it to this ACK, and reconcile the bound native engine idempotently.
    const reconciled=await options.reconcileCheckpoint!(structuredClone(acknowledged.binding),structuredClone(acknowledged.ack));check(generation);
    if(!reconciled||reconciled.cursor!==acknowledged.ack.cursor)throw new Error('health_import_checkpoint_unknown');
    await commit(null,generation);
    return acknowledged.ack;
  }
  async function failure(error:unknown,generation:number,pages:number):Promise<ImportStatus>{
    if(!current()||generation!==epoch){const result=await scrub();return {...result,pages};}
    if(held)throw error;
    if(pending||uncertain)return {status:'unknown',pages};
    throw error;
  }
  return {
    async refresh(input:HealthImportInput):Promise<ImportStatus>{
      if(!configured())return {status:'unavailable',pages:0};
      if(busy||held||pending||uncertain)throw new Error('health_import_reconciliation_required');
      input=structuredClone(input);
      const generation=epoch;let pages=0,count=0;busy=true;binding=bind(input);
      try {
        await load(generation);if(pending)throw new Error('health_import_reconciliation_required');
        const available=await options.native.availability();check(generation);
        if(available!=='available')return {status:'unavailable',pages:0};
        await options.native.requestRead([input.type]);check(generation);
        let anchor=input.cursor;const seen=new Set<string|null>();
        for(let n=0;n<100;n++){
          check(generation);if(seen.has(anchor))throw new Error('health_native_cursor_cycle');seen.add(anchor);
          const result=await options.native.query({type:input.type,from:input.from,to:input.to,anchor,limit:100});check(generation);
          if(result.logicalBucketsComplete!==true||result.records.length>100||result.tombstones.length>500)throw new Error('health_native_contract');
          if(result.more&&(result.anchor===null||result.anchor===anchor))throw new Error('health_native_cursor_cycle');
          const batch=result.records.flatMap(normalizeNative);if(batch.length+result.tombstones.length>500)throw new Error('health_native_contract');
          // Key is opaque and bound to this immutable account/session intent; no body-derived hash.
          const key=options.newKey();
          pending={phase:'prepared',binding:structuredClone(binding),key,pageId:key,page:{version:1,connectionId:input.connectionId,generation:input.generation,
            stream:binding.stream,fromCursor:anchor,nextCursor:result.anchor,pageId:key,batch,
            tombstones:result.tombstones.map(t=>({id:t.id,revision:{...t.revision}}))}};
          await commit(pending,generation);await send(generation);pages++;count+=batch.length;anchor=result.anchor;
          if(!result.more)return {status:count?'complete':'unknown_no_accessible_data',pages};
        }
        throw new Error('health_native_page_budget');
      }catch(error){return failure(error,generation,pages);}finally{busy=false;}
    },
    async retryUnknown(input?:HealthImportInput):Promise<ImportStatus>{
      if(!configured())return {status:'unavailable',pages:0};
      if(busy||held)throw new Error('health_import_reconciliation_required');
      if(input){const proposed=bind(input);if(binding&&!sameIntent(binding,proposed))throw new Error('health_import_binding_changed');binding=proposed;}
      if(!binding)throw new Error('health_import_no_pending');
      const generation=epoch;busy=true;const completingClear=uncertain?.next===null;
      try{
        await load(generation);
        if(!pending){if(completingClear)return {status:'complete',pages:1};throw new Error('health_import_no_pending');}
        await send(generation);return {status:'complete',pages:1};
      }catch(error){return failure(error,generation,0);}finally{busy=false;}
    },
    async disconnect(input:{connectionId:string;generation:number},key:string){
      // Fence native work synchronously. Root API port remains bound to the original session.
      epoch++;const result=await scrub();await options.native.cancelAll();
      if(result.status==='unknown')throw new Error('health_journal_scrub_unknown');
      if(!options.session.isCurrentSession())throw new Error('health_import_cancelled');
      return options.api.disconnect(input,key);
    },
    dispose():Promise<ImportStatus>{
      disposed=true;epoch++;const result=scrub();void options.native.cancelAll().catch(()=>{});return result;
    },
  };
}
