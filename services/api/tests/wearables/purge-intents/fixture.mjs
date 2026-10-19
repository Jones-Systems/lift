import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHealthPurgeConsumer } from '../../../../../apps/form/src/wearables/purge-intent.ts';

export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export function fixture(){
  let revision=0,record=null,authorized=true;
  const events=[],backend=[],native=[];
  const snapshot=()=>structuredClone({revision:String(revision),record});
  const context={accountId:'account-a',sessionGeneration:'original-session',connectionId:'healthkit',generation:7,
    deviceGeneration:'device-a',type:'steps',from:'2026-10-09T00:00:00Z',to:'2026-10-10T00:00:00Z',timeZone:'UTC',normalizationVersion:1};
  const receipt={accountId:context.accountId,connectionId:context.connectionId,generation:context.generation,
    deviceGeneration:context.deviceGeneration,receiptId:'backend-receipt-a'};
  const originalContext=structuredClone(context);
  const options={context,key:'purge-key-a',command:{operation:'synthetic-purge',scope:{connectionId:'healthkit',generation:7}},
    assertAuthorized:(saved,key)=>{assert.deepEqual(saved,originalContext);assert.equal(key,'purge-key-a');if(!authorized)throw Error('cleanup_lifetime_ended');},
    validateCommand:(saved,key,command)=>createHash('sha256').update(JSON.stringify({saved,key,command})).digest('hex'),
    quiesceImports:async()=>{events.push('quiesce');},
    captureNativeTarget:async saved=>{events.push('capture');assert.deepEqual(saved,originalContext);return {journalId:'native-journal-a',serial:12};},
    journal:{load:async()=>{events.push('load');return snapshot();},compareAndSwap:async(expected,next,guard)=>{
      guard();
      if(expected!==String(revision))return {status:'conflict',snapshot:snapshot()};
      const phase=record?.phase??'empty';
      assert.equal(next.phase,{empty:'prepared',prepared:'backend_confirmed',backend_confirmed:'complete'}[phase]);
      if(record){
        assert.deepEqual(next.phase==='complete'?next.identity:next.intent.identity,record.intent.identity);
        if(next.phase==='backend_confirmed')assert.deepEqual(next.intent,record.intent);
        if(next.phase==='complete')assert.deepEqual(next.receipt,record.receipt);
      }
      events.push(`save:${next.phase}`);record=structuredClone(next);revision++;
      return {status:'committed',snapshot:snapshot()};
    }},
    confirmOriginalIntent:async saved=>{
      events.push('backend');assert.equal(record.phase,'prepared');assert.deepEqual(saved,record.intent);
      backend.push(structuredClone(saved));return {status:'confirmed',receipt:structuredClone(receipt)};
    },
    forgetQueryContext:async(...args)=>{
      events.push('forget');assert.equal(record.phase,'backend_confirmed');
      assert.deepEqual(args,[record.intent.context,record.intent.journalId,record.intent.serial,record.receipt.receiptId]);native.push(structuredClone(args));
    },
  };
  return {options,events,backend,native,receipt,snapshot,create:()=>createHealthPurgeConsumer(options),authorize:value=>authorized=value};
}
