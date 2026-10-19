import type { NativeHealthRecord } from './native.js';
import type { HealthAggregate, Metric } from './model.js';
const mapping:Record<string,{metric:Metric;unit:HealthAggregate['unit'];factor:number}>= {
  'steps:count':{metric:'steps',unit:'count',factor:1},
  'active_energy:kcal':{metric:'active_energy',unit:'kcal',factor:1},
  'active_energy:kJ':{metric:'active_energy',unit:'kcal',factor:1/4.184},
  'resting_hr:bpm':{metric:'resting_hr',unit:'bpm',factor:1},
  'hrv_sdnn:ms':{metric:'hrv_sdnn',unit:'ms',factor:1},
  'hrv_sdnn:s':{metric:'hrv_sdnn',unit:'ms',factor:1000},
  'sleep_asleep:s':{metric:'sleep_asleep',unit:'s',factor:1},
  'sleep_in_bed:s':{metric:'sleep_in_bed',unit:'s',factor:1},
  'body_mass:kg':{metric:'body_mass',unit:'kg',factor:1},
  'body_mass:lb':{metric:'body_mass',unit:'kg',factor:0.45359237},
  'workout_duration:s':{metric:'workout_duration',unit:'s',factor:1},
  'workout_energy:kcal':{metric:'workout_energy',unit:'kcal',factor:1},
  'workout_distance:m':{metric:'workout_distance',unit:'m',factor:1},
};
const allowed:Record<string,string[]>={steps:['steps'],activeEnergy:['active_energy'],restingHeartRate:['resting_hr'],
  hrvSdnn:['hrv_sdnn'],sleep:['sleep_asleep','sleep_in_bed'],bodyMass:['body_mass'],workouts:['workout_duration','workout_energy','workout_distance']};
export function normalizeNative(record:NativeHealthRecord):HealthAggregate[] {
  const keys=['id','kind','type','day','zone','start','end','sourceBundleId','sourceName','deviceModel','algorithm','originalId','revision','quality','values'];
  if(record && Object.keys(record).some(k=>!keys.includes(k)))throw new Error('health_native_contract');
  if(!record||!Array.isArray(record.values)||record.values.length>3||!allowed[record.type]||
    !Number.isFinite(Date.parse(record.start))||!Number.isFinite(Date.parse(record.end))||Date.parse(record.start)>Date.parse(record.end)) throw new Error('health_native_contract');
  if((record.type==='workouts')!==(record.kind==='workout')) throw new Error('health_native_contract');
  const seen=new Set<string>();
  return record.values.map(v=>{
    if(Object.keys(v).some(k=>!['metric','value','unit','aggregation'].includes(k)))throw new Error('health_native_contract');
    const map=mapping[v.metric+':'+v.unit];
    if(!map||!allowed[record.type]!.includes(v.metric)||seen.has(v.metric)||!Number.isFinite(v.value)||v.value<0) throw new Error('health_native_contract');
    seen.add(v.metric);
    const aggregation=record.kind==='workout'?'workout':v.aggregation;
    if(!['sum','mean','latest','interval_union','workout'].includes(aggregation)) throw new Error('health_native_contract');
    return {id:record.id+':'+map.metric,metric:map.metric,value:v.value*map.factor,unit:map.unit,start:record.start,end:record.end,
      day:record.day,zone:record.zone,aggregation:aggregation as HealthAggregate['aggregation'],
      source:{bundleId:record.sourceBundleId,name:record.sourceName,device:record.deviceModel,algorithm:record.algorithm,originalId:record.originalId},
      revision:{...record.revision},quality:record.quality};
  });
}
// Native bridge may use this pure helper when constructing source-separated complete sleep buckets.
export function asleepSeconds(intervals:{start:string;end:string;stage:'awake'|'in_bed'|'asleep'|'core'|'deep'|'rem'}[]):number {
  const sorted=intervals.filter(v=>v.stage!=='awake'&&v.stage!=='in_bed').map(v=>[Date.parse(v.start),Date.parse(v.end)] as const).sort((a,b)=>a[0]-b[0]);
  let total=0,start:number|null=null,end=0;
  for(const [a,b] of sorted){if(!Number.isFinite(a)||!Number.isFinite(b)||a>b)throw new Error('health_native_contract');
    if(start===null){start=a;end=b;}else if(a<=end)end=Math.max(end,b);else{total+=end-start;start=a;end=b;}}
  return (total+(start===null?0:end-start))/1000;
}
