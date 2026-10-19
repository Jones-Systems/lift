export type HealthType = 'workouts'|'steps'|'activeEnergy'|'restingHeartRate'|'hrvSdnn'|'sleep'|'bodyMass';
export type Metric = 'steps'|'active_energy'|'resting_hr'|'hrv_sdnn'|'hrv_rmssd'|'sleep_asleep'|'sleep_in_bed'|'body_mass'|'workout_duration'|'workout_energy'|'workout_distance'|'vendor_score';
export type HealthAggregate = {
  id:string; metric:Metric; value:number; unit:'count'|'kcal'|'bpm'|'ms'|'s'|'kg'|'m'|'score';
  start:string|null;end:string|null;day:string;zone:string|null;
  aggregation:'sum'|'mean'|'latest'|'interval_union'|'workout'|'vendor_algorithm';
  source:{bundleId:string;name:string;device:string|null;algorithm:string|null;eventTimestamp?:string|null;originalId:string|null};
  revision:{token:string;order:number|null}; quality:'complete'|'partial'|'unknown';
};
export type ImportPage = {version:1;connectionId:string;generation:number;stream:string;fromCursor:string|null;nextCursor:string|null;
  pageId:string;batch:HealthAggregate[];tombstones:{id:string;revision:{token:string;order:number|null}}[]};
export type ImportAck = {accepted:number;duplicates:number;cursor:string|null;pageId:string};
export type SessionFence = {accountId:string;sessionGeneration:string;isCurrentSession():boolean};
export type BoundHealthApi = {
  importPage(page:ImportPage,key:string):Promise<ImportAck>;
  disconnect(input:{connectionId:string;generation:number},key:string):Promise<unknown>;
};
