import { fail, object, text } from '../validation.js';
export type HttpRequest = {redirect?:'error';method:'GET'|'POST'|'DELETE';url:string;headers:Record<string,string>;form?:Record<string,string>;
  secretFormFields?:Record<string,string>;bearerSecretRef?:string};
export type HttpResponse = {status:number;headers:Record<string,string|undefined>;body:unknown};
export interface AuthorizedHttp { request(request:HttpRequest):Promise<HttpResponse> }
export interface ExternalAdmission { assertAllowed(provider:'oura'|'garmin',purpose:string):void; assertCurrent():void }
export const disabledAdmission:ExternalAdmission={assertAllowed(){fail('health_provider_not_configured',503);},assertCurrent(){fail('health_provider_not_configured',503);}};
export class ProviderFailure extends Error {
  readonly code:string;readonly retryAfterMs:number|null;readonly effect:'none'|'unknown';
  constructor(code:string,effect:'none'|'unknown',retryAfterMs:number|null=null){super(code);this.code=code;this.effect=effect;this.retryAfterMs=retryAfterMs;}
}
export function retryAfter(headers:HttpResponse['headers'],now:number):number|null {
  const value=headers['retry-after'];if(!value)return null;
  const ms=/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-now;
  return Number.isFinite(ms)&&ms>=0?Math.min(ms,86400000):null;
}
export async function perform(http:AuthorizedHttp,admission:ExternalAdmission,provider:'oura'|'garmin',purpose:string,req:HttpRequest,now:number):Promise<HttpResponse> {
  admission.assertAllowed(provider,purpose);admission.assertCurrent();
  let response:HttpResponse;
  try{response=await http.request({...req,redirect:'error'});}catch{throw new ProviderFailure('provider_transport',req.method==='GET'?'none':'unknown');}
  try{admission.assertCurrent();}catch{throw new ProviderFailure('provider_session_changed',req.method==='GET'?'none':'unknown');}
  if(response.status===429)throw new ProviderFailure('provider_rate_limited','none',retryAfter(response.headers,now));
  if(response.status===401||response.status===403)throw new ProviderFailure('provider_permission','none');
  if(response.status>=500)throw new ProviderFailure('provider_unavailable',req.method==='GET'?'none':'unknown');
  if(response.status<200||response.status>=300)throw new ProviderFailure('provider_rejected','none');
  return response;
}
export type TokenResponse={access_token:string;refresh_token:string;token_type:string;expires_in:number;refresh_token_expires_in:number|null;scope:string|null};
export function tokenResponse(input:unknown):TokenResponse {
  const v=object(input);if(typeof v.expires_in!=='number'||!Number.isSafeInteger(v.expires_in)||v.expires_in<=0||String(v.token_type).toLowerCase()!=='bearer') fail('provider_token_invalid');
  const refresh=v.refresh_token_expires_in;if(refresh!==undefined&&(typeof refresh!=='number'||!Number.isSafeInteger(refresh)||refresh<=0)) fail('provider_token_invalid');
  return {access_token:text(v.access_token,16384),refresh_token:text(v.refresh_token,16384),token_type:'bearer',expires_in:v.expires_in,
    refresh_token_expires_in:refresh===undefined?null:refresh as number,scope:typeof v.scope==='string'?v.scope:null};
}
