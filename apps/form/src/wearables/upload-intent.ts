import type { HealthType, ImportAck, ImportPage } from './model.js';

export type HealthImportInput = { connectionId:string; generation:number; type:HealthType; from:string; to:string; cursor:string|null };
export type UploadIntentBinding = Omit<HealthImportInput,'cursor'> & { accountId:string; sessionGeneration:string; stream:string };
export type UploadIntentMetadata = { binding:UploadIntentBinding; key:string; pageId:string };
export type PreparedUploadIntent = UploadIntentMetadata & { phase:'prepared'; page:ImportPage };
export type AcknowledgedUploadIntent = UploadIntentMetadata & { phase:'acknowledged'; ack:ImportAck };
export type UploadIntentRecord = PreparedUploadIntent | AcknowledgedUploadIntent | (UploadIntentMetadata & { phase:'scrubbed' });
export type UploadIntentSnapshot = { revision:string; fenced:boolean; record:UploadIntentRecord|null };
export type UploadIntentWriteResult = { status:'committed'|'conflict'; snapshot:UploadIntentSnapshot } | { status:'unknown' };
export interface UploadIntentJournal {
  // Root binds one exclusive original-session slot. Reads settle earlier uncertain operations before returning.
  // Revisions never repeat, including after clear. Payloads are cloned, private, and unavailable across bindings.
  load():Promise<UploadIntentSnapshot>;
  // Root performs CAS, fence check and assertCurrent in one synchronous atomic storage effect; no late commit after a fence.
  // Legal transitions are empty -> immutable prepared -> matching acknowledged -> empty. Scrubbed is terminal.
  compareAndSwap(expectedRevision:string,next:UploadIntentRecord|null,assertCurrent:()=>void):Promise<UploadIntentWriteResult>;
  // Fence synchronously before returning the Promise, then atomically remove health/cursor data.
  // Preserve existing or supplied minimal metadata as scrubbed. An unknown result does not prove erasure.
  // Root preserves unresolved purge/fence state across restart and denies a new slot lease until reconciliation.
  fenceAndScrub(metadata:UploadIntentMetadata|null):Promise<{status:'scrubbed';snapshot:UploadIntentSnapshot}|{status:'unknown'}>;
}
export type ReconcileHealthCheckpoint = (binding:UploadIntentBinding,ack:ImportAck)=>Promise<{cursor:string|null}>;

export function sameIntent(left:unknown,right:unknown):boolean {
  const encode=(value:unknown):string=>{
    if(Array.isArray(value))return '['+value.map(encode).join(',')+']';
    if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+encode((value as Record<string,unknown>)[key])).join(',')+'}';
    return JSON.stringify(value)??'undefined';
  };
  return encode(left)===encode(right);
}
