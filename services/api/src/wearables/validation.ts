import { createHash } from 'node:crypto';
import type { ImportPage, Measure, Metric } from './types.js';
export class WearableError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export function fail(code: string, status = 422): never { throw new WearableError(status, code); }
export function object(x: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return fail('health_invalid_input');
  const v = x as Record<string, unknown>;
  if (keys && Object.keys(v).some(k => !keys.includes(k))) fail('health_invalid_input');
  return v;
}
export function text(x: unknown, max = 256): string {
  if (typeof x !== 'string' || !x.length || x.length > max || /[\u0000-\u001f]/u.test(x)) return fail('health_invalid_input');
  return x;
}
export function integer(x: unknown): number { if (!Number.isSafeInteger(x) || (x as number) < 0) return fail('health_invalid_input'); return x as number; }
export function instant(x: unknown): string {
  const s = text(x, 64);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s))) fail('health_invalid_time');
  return s;
}
export function day(x: unknown): string {
  const s = text(x, 10); if (!/^\d{4}-\d\d-\d\d$/.test(s) || !Number.isFinite(Date.parse(s+'T00:00:00Z')) || new Date(s+'T00:00:00Z').toISOString().slice(0,10) !== s) fail('health_invalid_day'); return s;
}
export function nullableText(x: unknown): string | null { return x === null ? null : text(x, 2048); }
export const units: Record<Metric, Measure['unit']> = {
  steps:'count', active_energy:'kcal', resting_hr:'bpm', hrv_sdnn:'ms', hrv_rmssd:'ms', sleep_asleep:'s',
  sleep_in_bed:'s', body_mass:'kg', workout_duration:'s', workout_energy:'kcal', workout_distance:'m', vendor_score:'score',
};
export function metric(x: unknown): Metric { const s = text(x); if (!Object.hasOwn(units,s)) fail('health_invalid_metric'); return s as Metric; }
export function revision(x: unknown): Measure['revision'] {
  const v=object(x,['token','order']); return {token:text(v.token),order:v.order===null?null:integer(v.order)};
}
export function measure(x: unknown): Measure {
  const v=object(x,['id','metric','value','unit','start','end','day','zone','aggregation','source','revision','quality']);
  const m=metric(v.metric); const start=v.start===null?null:instant(v.start),end=v.end===null?null:instant(v.end);
  if ((start===null)!==(end===null) || (start && end && Date.parse(start)>Date.parse(end))) fail('health_invalid_window');
  if (typeof v.value!=='number'|| !Number.isFinite(v.value)||v.value<0 || v.unit!==units[m]) fail('health_invalid_value');
  if (!['sum','mean','latest','interval_union','workout','vendor_algorithm'].includes(String(v.aggregation))) fail('health_invalid_aggregation');
  const aggregates:Record<Metric,string[]>={steps:['sum'],active_energy:['sum'],resting_hr:['mean'],hrv_sdnn:['mean'],hrv_rmssd:['mean'],sleep_asleep:['interval_union'],sleep_in_bed:['interval_union'],body_mass:['latest'],workout_duration:['workout'],workout_energy:['workout'],workout_distance:['workout'],vendor_score:['vendor_algorithm']};
  if(!aggregates[m].includes(String(v.aggregation))) fail('health_invalid_aggregation');
  if (!['complete','partial','unknown'].includes(String(v.quality))) fail('health_invalid_quality');
  const source=object(v.source,['bundleId','name','device','algorithm','originalId','eventTimestamp']);
  const zone=nullableText(v.zone); if(zone) { try { new Intl.DateTimeFormat('en',{timeZone:zone}); } catch { fail('health_invalid_zone'); } }
  const result:Measure={id:text(v.id,512),metric:m,value:v.value,unit:units[m],start,end,day:day(v.day),zone,
    aggregation:v.aggregation as Measure['aggregation'],quality:v.quality as Measure['quality'],revision:revision(v.revision),
    source:{...(source.eventTimestamp===undefined?{}:{eventTimestamp:source.eventTimestamp===null?null:instant(source.eventTimestamp)}),bundleId:text(source.bundleId),name:text(source.name),device:nullableText(source.device),algorithm:nullableText(source.algorithm),originalId:nullableText(source.originalId)}};
  if(m==='vendor_score' && !result.source.algorithm) fail('health_score_definition_required');
  return result;
}
export function page(x: unknown): ImportPage {
  const v=object(x,['version','connectionId','generation','stream','fromCursor','nextCursor','pageId','batch','tombstones']);
  if(v.version!==1) fail('health_unsupported_version');
  if(!Array.isArray(v.batch)||!Array.isArray(v.tombstones)||v.batch.length+v.tombstones.length>500) fail('health_batch_limit',413);
  const batch=v.batch.map(measure),tombstones=v.tombstones.map(x=>{const t=object(x,['id','revision']);return {id:text(t.id,512),revision:revision(t.revision)};});
  const ids=[...batch.map(x=>x.id),...tombstones.map(x=>x.id)]; if(new Set(ids).size!==ids.length) fail('health_duplicate_page_id');
  return {version:1,connectionId:text(v.connectionId),generation:integer(v.generation),stream:text(v.stream,512),
    fromCursor:nullableText(v.fromCursor),nextCursor:nullableText(v.nextCursor),pageId:text(v.pageId),batch,tombstones};
}
export function stable(x: unknown): string {
  if(x===null || typeof x==='boolean' || typeof x==='string') return JSON.stringify(x);
  if(typeof x==='number' && Number.isFinite(x)) return JSON.stringify(x);
  if(Array.isArray(x)) return '['+x.map(stable).join(',')+']';
  const v=object(x); return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
}
export function digest(x: unknown): string { return createHash('sha256').update(stable(x)).digest('hex'); }
