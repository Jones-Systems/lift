import type { HealthType } from './model.js';
export type NativeHealthRecord = {
  id:string; kind:'daily'|'workout'; type:HealthType; day:string;zone:string|null;
  start:string;end:string;sourceBundleId:string;sourceName:string;deviceModel:string|null;
  algorithm:string|null;originalId:string|null;revision:{token:string;order:number|null};
  quality:'complete'|'partial'|'unknown';
  values:{metric:string;value:number;unit:string;aggregation:string}[];
};
export type NativePage = {
  records:NativeHealthRecord[];
  tombstones:{id:string;revision:{token:string;order:number|null}}[];
  anchor:string|null;more:boolean;
  // Root bridge must return complete source-separated daily buckets/workouts, never half a bucket.
  logicalBucketsComplete:true;
};
export interface FormHealthNative {
  availability():Promise<'available'|'unavailable_device'|'restricted'>;
  requestRead(types:HealthType[]):Promise<'prompted'|'unnecessary'>;
  query(input:{type:HealthType;from:string;to:string;anchor:string|null;limit:number}):Promise<NativePage>;
  cancelAll():Promise<void>;
}
export const unavailableHealthNative:FormHealthNative={
  async availability(){return 'unavailable_device';},
  async requestRead(){throw new Error('health_native_unavailable');},
  async query(){throw new Error('health_native_unavailable');},
  async cancelAll(){},
};
