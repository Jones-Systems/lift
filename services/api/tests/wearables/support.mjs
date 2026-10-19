import { createWearablesService } from '../../src/wearables/service.ts';
export const ctxA={accountId:'account-a',authUserId:'user-a',sessionId:'session-a',epoch:1};
export const ctxB={accountId:'account-b',authUserId:'user-b',sessionId:'session-b',epoch:1};
export function record(changes={}){return {id:'steps:day',metric:'steps',value:120,unit:'count',start:'2026-10-09T00:00:00Z',end:'2026-10-10T00:00:00Z',day:'2026-10-09',zone:'UTC',aggregation:'sum',
 source:{bundleId:'invented.source',name:'Invented',device:null,algorithm:null,originalId:null},revision:{token:'r1',order:1},quality:'complete',...changes};}
export function batch(changes={}){return {version:1,connectionId:'hk',generation:1,stream:'steps',fromCursor:null,nextCursor:'anchor1',pageId:'page1',batch:[record()],tombstones:[],...changes};}
export function harness(){
 let state=new Map();let failure=null;const valid=new Set(['session-a','session-b']);let permitted=true,enabled=true,alias=null;
 function bucket(ctx){const k=JSON.stringify([ctx.accountId,ctx.epoch]);if(!state.has(k))state.set(k,{connections:new Map(),records:new Map(),cursors:new Map(),receipts:new Map(),suggestions:new Map(),plan:{revision:1,activeWorkout:false,items:[{id:'i',exerciseId:'e',setTarget:3,repMin:6,repMax:8,targetKg:20}]}});return state.get(k);}
 const store={
  connection:(c,id)=>bucket(c).connections.get(id)??null,connections:c=>[...bucket(c).connections.values()],putConnection:(c,v)=>bucket(c).connections.set(v.id,structuredClone(v)),
  cursor:(c,id,g,s)=>bucket(c).cursors.get(JSON.stringify([id,g,s]))??null,
  putCursor:(c,id,g,s,v)=>{if(failure==='cursor')throw Error('invented failure');bucket(c).cursors.set(JSON.stringify([id,g,s]),v);},
  measure:(c,id,g,r)=>bucket(c).records.get(JSON.stringify([id,g,r]))??null,
  putMeasure:(c,v)=>bucket(c).records.set(JSON.stringify([v.connectionId,v.generation,v.id]),structuredClone(v)),
  measures:(c,from,to,limit)=>[...bucket(c).records.values()].filter(r=>r.day>=from&&r.day<=to).slice(0,limit),
  receipt:(c,k)=>bucket(c).receipts.get(k)??null,putReceipt:(c,k,v)=>{const connection=v.scope?bucket(c).connections.get(v.scope.connectionId):null;
   bucket(c).receipts.set(k,structuredClone(v.scope&&(!connection?.connected||connection.generation!==v.scope.generation)?{fingerprint:v.fingerprint,scope:null,purged:true}:v));},
  suggestion:(c,id)=>bucket(c).suggestions.get(id)??null,suggestions:c=>[...bucket(c).suggestions.values()],putSuggestion:(c,v)=>bucket(c).suggestions.set(v.id,structuredClone(v)),
  purgeConnection:(c,id)=>{for(const [k,v] of bucket(c).records)if(v.connectionId===id)bucket(c).records.delete(k);
   for(const [k,v] of bucket(c).receipts)if(v.scope?.connectionId===id)bucket(c).receipts.set(k,{fingerprint:v.fingerprint,scope:null,purged:true});},
  purgeBefore:(c,before)=>{let n=0;for(const [k,v] of bucket(c).records)if(v.end&&v.end<before){bucket(c).records.delete(k);n++;}return n;},
 };
 const root={store,enabled:()=>enabled,now:()=> '2026-10-10T08:00:00Z',
  assertActive(c){if(!valid.has(c.sessionId)||(c.accountId==='account-a')!==(c.sessionId==='session-a'))throw Object.assign(Error('invalid'),{status:401,code:'account_session_invalid'});},
  assertImportAllowed(){if(!permitted)throw Object.assign(Error('denied'),{status:403,code:'health_consent_required'});},
  withActiveWrite(c,fn){const old=structuredClone(state);try{root.assertActive(c);const r=fn();root.assertActive(c);return r;}catch(e){state=old;throw e;}},
  alias:(c,v)=>alias?.(v)??null,assertSuggestionAllowed(){},
  plans:{capability:'atomic_suggestions_v1',readWithinWrite:c=>structuredClone(bucket(c).plan),applyWithinWrite(c,i){const p=bucket(c).plan;if(p.activeWorkout||p.revision!==i.expectedRevision)throw Error('race');p.items=structuredClone(i.items);return {revision:++p.revision};}},
 };
 const service=createWearablesService(root);
 for(const c of [ctxA,ctxB])service.connectHealthKit(c,'connect',{connectionId:'hk',types:['steps','hrv_sdnn','hrv_rmssd','workout_duration','vendor_score'],consentVersion:'invented-consent',retentionConsent:true});
 return {service,root,store,bucket,valid,setFailure:v=>failure=v,setPermitted:v=>permitted=v,setEnabled:v=>enabled=v,setAlias:v=>alias=v};
}
