import type { HealthType } from './model.js';
import { sameIntent } from './upload-intent.js';

export type HealthKitPurgeContext = {
  accountId:string;sessionGeneration:string;connectionId:string;generation:number;deviceGeneration:string;
  type:HealthType;from:string;to:string;timeZone:string;normalizationVersion:1;
};
export type PurgeJson = null | boolean | number | string | PurgeJson[] | {[key:string]:PurgeJson};
export type HealthPurgeReceipt = {accountId:string;connectionId:string;generation:number;deviceGeneration:string;receiptId:string};
export type HealthPurgeIdentity = Omit<HealthPurgeReceipt,'receiptId'> & {sessionGeneration:string;key:string;commandIdentity:string};
export type SavedHealthPurgeIntent = {
  identity:HealthPurgeIdentity;context:HealthKitPurgeContext;command:PurgeJson;journalId:string;serial:number;
};
export type HealthPurgeRecord = {phase:'prepared';intent:SavedHealthPurgeIntent} |
  {phase:'backend_confirmed';intent:SavedHealthPurgeIntent;receipt:HealthPurgeReceipt} |
  {phase:'complete';identity:HealthPurgeIdentity;receipt:HealthPurgeReceipt};
export type HealthPurgeSnapshot = {revision:string;record:HealthPurgeRecord|null};
export type HealthPurgeWriteResult = {status:'committed'|'conflict';snapshot:HealthPurgeSnapshot}|{status:'unknown'};
export interface HealthPurgeJournal {
  // Root binds an exclusive cleanup slot. Reads settle earlier unknown writes; revisions never repeat.
  load():Promise<HealthPurgeSnapshot>;
  // Atomic CAS and assertAuthorized share the root storage effect. Records cannot change identity or prepared intent.
  // Only empty -> prepared -> backend_confirmed -> complete is allowed; complete remains a replay marker.
  compareAndSwap(expectedRevision:string,next:HealthPurgeRecord,assertAuthorized:()=>void):Promise<HealthPurgeWriteResult>;
}
export type HealthPurgePorts = {
  context:HealthKitPurgeContext;key:string;command:PurgeJson;
  // Synchronous cleanup authorization belongs to its own lifetime, including after account/session disable.
  assertAuthorized?(context:HealthKitPurgeContext,key:string):void;
  // Root qualifies this exact context/key/JSON command and returns its stable opaque identity; no default hash/authority.
  validateCommand?(context:HealthKitPurgeContext,key:string,command:PurgeJson):string;
  quiesceImports?():Promise<void>;
  // Read the original namespace fence after quiescing; never bind, query or create a replacement namespace here.
  captureNativeTarget?(context:HealthKitPurgeContext):Promise<{journalId:string;serial:number}>;
  journal?:HealthPurgeJournal;
  // Root resolves prior unknown effects before any authorized same-key dispatch. No implicit active-session transport.
  confirmOriginalIntent?(intent:SavedHealthPurgeIntent):Promise<{status:'confirmed';receipt:HealthPurgeReceipt}|{status:'unresolved'}>;
  // Native retries use the same saved target/receipt and are idempotent across the whole namespace, not one stream.
  forgetQueryContext?(context:HealthKitPurgeContext,journalId:string,serial:number,receiptId:string):Promise<void>;
};
export type HealthPurgeResult = {status:'complete';receipt:HealthPurgeReceipt}|{status:'unavailable'|'unknown';reason:string};

function requiredText(value:unknown):asserts value is string {
  if(typeof value!=='string'||!value.length||value.length>2048||/[\u0000-\u001f]/u.test(value))throw Error('health_purge_invalid_metadata');
}
function assertJson(value:unknown,depth=0):asserts value is PurgeJson {
  if(depth>32)throw Error('health_purge_invalid_command');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'&&Number.isFinite(value))return;
  if(Array.isArray(value)){for(const item of value)assertJson(item,depth+1);return;}
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){
    for(const item of Object.values(value))assertJson(item,depth+1);return;
  }
  throw Error('health_purge_invalid_command');
}
function validateContext(value:HealthKitPurgeContext){
  if(!value||Object.keys(value).some(key=>!['accountId','sessionGeneration','connectionId','generation','deviceGeneration','type','from','to','timeZone','normalizationVersion'].includes(key)))
    throw Error('health_purge_invalid_context');
  for(const text of [value.accountId,value.sessionGeneration,value.connectionId,value.deviceGeneration,value.from,value.to,value.timeZone])requiredText(text);
  if(!Number.isSafeInteger(value.generation)||value.generation<0||value.normalizationVersion!==1||
    !['workouts','steps','activeEnergy','restingHeartRate','hrvSdnn','sleep','bodyMass'].includes(value.type)||
    !Number.isFinite(Date.parse(value.from))||!Number.isFinite(Date.parse(value.to))||Date.parse(value.from)>Date.parse(value.to))throw Error('health_purge_invalid_context');
}

export function createHealthPurgeConsumer(options:HealthPurgePorts){
  const context=structuredClone(options.context),command=structuredClone(options.command),key=options.key;
  let identity:HealthPurgeIdentity|null=null,snapshot:HealthPurgeSnapshot|null=null;
  let uncertain:{revision:string;next:HealthPurgeRecord}|null=null;
  let busy=false,held=false;
  function available(){return !!(options.assertAuthorized&&options.validateCommand&&options.quiesceImports&&options.captureNativeTarget&&
    options.journal&&options.confirmOriginalIntent&&options.forgetQueryContext);}
  function check(){options.assertAuthorized!(structuredClone(context),key);}
  function receipt(value:HealthPurgeReceipt):HealthPurgeReceipt {
    if(!value||value.accountId!==context.accountId||value.connectionId!==context.connectionId||
      value.generation!==context.generation||value.deviceGeneration!==context.deviceGeneration)throw Error('health_purge_receipt_scope_mismatch');
    requiredText(value.receiptId);
    return {accountId:value.accountId,connectionId:value.connectionId,generation:value.generation,deviceGeneration:value.deviceGeneration,receiptId:value.receiptId};
  }
  function adopt(value:HealthPurgeSnapshot){
    requiredText(value?.revision);
    const record=value.record;
    if(record){
      const storedIdentity=record.phase==='complete'?record.identity:record.intent?.identity;
      if(!sameIntent(storedIdentity,identity)){held=true;throw Error('health_purge_binding_changed');}
      if(record.phase==='prepared'||record.phase==='backend_confirmed'){
        const saved=record.intent;
        if(!sameIntent(saved.context,context)||!sameIntent(saved.command,command)){held=true;throw Error('health_purge_binding_changed');}
        requiredText(saved.journalId);
        if(!Number.isSafeInteger(saved.serial)||saved.serial<0)throw Error('health_purge_invalid_serial');
      }else if(record.phase!=='complete')throw Error('health_purge_invalid_phase');
      if(record.phase!=='prepared'){
        if(!sameIntent(record.receipt,receipt(record.receipt)))throw Error('health_purge_invalid_receipt');
      }
    }
    snapshot=structuredClone(value);
  }
  async function commit(next:HealthPurgeRecord){
    check();const revision=snapshot!.revision;uncertain={revision,next:structuredClone(next)};
    const result=await options.journal!.compareAndSwap(revision,structuredClone(next),check);check();
    if(result.status==='unknown')throw Error('health_purge_journal_unknown');
    if(result.status==='conflict'){held=true;throw Error('health_purge_journal_conflict');}
    if(result.snapshot.revision===revision||!sameIntent(result.snapshot.record,next))throw Error('health_purge_journal_unknown');
    adopt(result.snapshot);uncertain=null;
  }
  async function load(){
    check();const value=await options.journal!.load();check();
    if(uncertain){
      const attempted=uncertain;
      if(value.revision!==attempted.revision){
        if(!sameIntent(value.record,attempted.next)){held=true;throw Error('health_purge_journal_conflict');}
        adopt(value);uncertain=null;
      }else{
        if(!sameIntent(value.record,snapshot?.record)){held=true;throw Error('health_purge_journal_conflict');}
        adopt(value);await commit(attempted.next);
      }
    }else adopt(value);
  }
  return {
    async run():Promise<HealthPurgeResult>{
      if(!available())return {status:'unavailable',reason:'health_purge_ports_required'};
      if(busy||held)return {status:'unknown',reason:'health_purge_reconciliation_required'};
      busy=true;
      try{
        check();validateContext(context);requiredText(key);assertJson(command);
        const commandIdentity=options.validateCommand!(structuredClone(context),key,structuredClone(command));check();requiredText(commandIdentity);
        const qualified={accountId:context.accountId,sessionGeneration:context.sessionGeneration,connectionId:context.connectionId,
          generation:context.generation,deviceGeneration:context.deviceGeneration,key,commandIdentity};
        if(identity&&!sameIntent(identity,qualified)){held=true;throw Error('health_purge_binding_changed');}
        identity=qualified;await load();
        if(!snapshot!.record){
          check();await options.quiesceImports!();check();
          const target=await options.captureNativeTarget!(structuredClone(context));check();requiredText(target.journalId);
          if(!Number.isSafeInteger(target.serial)||target.serial<0)throw Error('health_purge_invalid_serial');
          await commit({phase:'prepared',intent:{identity:structuredClone(identity),context:structuredClone(context),command:structuredClone(command),journalId:target.journalId,serial:target.serial}});
        }
        const prepared=snapshot!.record;
        if(prepared?.phase==='prepared'){
          check();const result=await options.confirmOriginalIntent!(structuredClone(prepared.intent));check();
          if(result.status!=='confirmed')return {status:'unknown',reason:'health_purge_backend_unresolved'};
          const confirmed=receipt(result.receipt);
          await commit({phase:'backend_confirmed',intent:structuredClone(prepared.intent),receipt:confirmed});
        }
        const confirmed=snapshot!.record;
        if(confirmed?.phase==='backend_confirmed'){
          check();const saved=structuredClone(confirmed.intent),proof=receipt(confirmed.receipt);
          await options.forgetQueryContext!(saved.context,saved.journalId,saved.serial,proof.receiptId);check();
          await commit({phase:'complete',identity:structuredClone(identity),receipt:proof});
        }
        const completed=snapshot!.record;
        if(completed?.phase!=='complete')throw Error('health_purge_journal_unknown');
        check();return {status:'complete',receipt:receipt(completed.receipt)};
      }catch{
        // No serial, journal identity, key or receipt replacement is authorized by an uncertain effect.
        return {status:'unknown',reason:held?'health_purge_reconciliation_required':'health_purge_effect_unproved'};
      }finally{busy=false;}
    },
  };
}
