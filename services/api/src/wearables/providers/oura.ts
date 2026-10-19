import type { Measure } from '../types.js';
import { day, digest, fail, instant, object, text } from '../validation.js';
import { disabledAdmission, perform } from './http.js';
import type { AuthorizedHttp, ExternalAdmission } from './http.js';
export type OuraCollection='daily_activity'|'daily_readiness'|'daily_sleep'|'sleep'|'workout';
const fields:Record<OuraCollection,string>={daily_activity:'id,day,timestamp,steps,active_calories',daily_readiness:'id,day,timestamp,score',
  daily_sleep:'id,day,timestamp,score',sleep:'id,day,bedtime_start,bedtime_end,total_sleep_duration,time_in_bed,sleep_algorithm_version',
  workout:'id,day,start_datetime,end_datetime,activity,calories,distance,intensity,source'};
function number(v:unknown,nullable=false):number|null {
  if(nullable&&(v===null||v===undefined))return null;
  if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail('oura_invalid_response');return v as number;
}
// Projection validation targets exactly the requested public 1.41 fields, not every optional API field.
export function decodeOura(collection:OuraCollection,input:unknown):{records:Measure[];nextToken:string|null} {
  const page=object(input);if(!Array.isArray(page.data)||page.data.length>500||!(page.next_token===null||typeof page.next_token==='string'))fail('oura_invalid_response');
  const records:Measure[]=[];
  for(const value of page.data){
    const v=object(value),id=text(v.id),civil=day(v.day);
    let start:string|null=null,end:string|null=null;
    if(collection==='workout'){start=instant(v.start_datetime);end=instant(v.end_datetime);text(v.activity);text(v.intensity);text(v.source);}
    else if(collection==='sleep'){start=instant(v.bedtime_start);end=instant(v.bedtime_end);}
    else instant(v.timestamp);
    if(start&&end&&Date.parse(start)>Date.parse(end))fail('oura_invalid_response');
    const algorithm=collection==='sleep'?(typeof v.sleep_algorithm_version==='string'?v.sleep_algorithm_version:null):collection.includes('readiness')?'oura:readiness:unknown_version':collection==='daily_sleep'?'oura:sleep_score:unknown_version':null;
    const add=(metric:Measure['metric'],value:number|null,unit:Measure['unit'],aggregation:Measure['aggregation'])=>{
      if(value===null)return;
      records.push({id:collection+':'+id+':'+metric,metric,value,unit,start,end,day:civil,zone:null,aggregation,
        source:{bundleId:'oura-api-v2',name:'Oura',device:null,algorithm,originalId:id,eventTimestamp:collection==='workout'||collection==='sleep'?null:instant(v.timestamp)},
        // API documents inspected expose no ordered update token; changed re-reads require reconciliation.
        revision:{token:digest([collection,id,value,start,end,algorithm]),order:null},quality:'unknown'});
    };
    if(collection==='daily_activity'){add('steps',number(v.steps),'count','sum');add('active_energy',number(v.active_calories),'kcal','sum');}
    else if(collection==='daily_readiness'||collection==='daily_sleep')add('vendor_score',number(v.score,true),'score','vendor_algorithm');
    else if(collection==='sleep'){add('sleep_asleep',number(v.total_sleep_duration,true),'s','interval_union');add('sleep_in_bed',number(v.time_in_bed),'s','interval_union');}
    else {add('workout_duration',(Date.parse(end!)-Date.parse(start!))/1000,'s','workout');add('workout_energy',number(v.calories,true),'kcal','workout');add('workout_distance',number(v.distance,true),'m','workout');}
  }
  return {records,nextToken:page.next_token===null?null:text(page.next_token,2048)};
}
export function createOuraReadPort(input:{http:AuthorizedHttp;accessSecretRef:string;admission?:ExternalAdmission;now:()=>number}) {
  const admission=input.admission??disabledAdmission;
  return {
    async read(collection:OuraCollection,range:{from:string;to:string;nextToken:string|null}) {
      if(!Object.hasOwn(fields,collection))fail('oura_collection_unsupported');day(range.from);day(range.to);if(range.from>range.to)fail('health_invalid_window');
      const u=new URL('https://api.ouraring.com/v2/usercollection/'+collection);
      u.search=new URLSearchParams({start_date:range.from,end_date:range.to,fields:fields[collection],...(range.nextToken?{next_token:text(range.nextToken,2048)}:{})}).toString();
      const response=await perform(input.http,admission,'oura','read_only_import',{method:'GET',url:u.href,headers:{Accept:'application/json'},bearerSecretRef:input.accessSecretRef},input.now());
      return decodeOura(collection,response.body);
    },
  };
}
