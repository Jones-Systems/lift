import type { AccountContext } from './types.js';
import type { WearablesService } from './service.js';
import { WearableError, fail, text } from './validation.js';
export type HealthRequest = { method:string; path:string; query:URLSearchParams; key?:string; body?:unknown };
// Root resolves authentication and bounds JSON size before dispatch; this is not a mounted server.
export function createHealthRouter(service:WearablesService) {
  return (ctx:AccountContext,request:HealthRequest):{status:number;body:unknown}=>{
    try {
      const {method,path,body}=request;
      const key=()=>text(request.key);
      let result:unknown;
      if(method==='GET'&&path==='/v1/health/capabilities') result=service.capabilities();
      else if(method==='GET'&&path==='/v1/health/summary') result=service.summary(ctx,text(request.query.get('from')),text(request.query.get('to')));
      else if(method==='GET'&&path==='/v1/health/connections') result={items:service.connections(ctx)};
      else if(method==='POST'&&path==='/v1/health/connections/healthkit') result=service.connectHealthKit(ctx,key(),body);
      else if(method==='POST'&&path==='/v1/health/imports') result=service.ingest(ctx,key(),body,{provider:'healthkit'});
      else if(method==='POST'&&path==='/v1/health/connections/healthkit/disconnect') result=service.disconnect(ctx,key(),body);
      else if(method==='GET'&&path==='/v1/health/suggestions') result={items:service.suggestions(ctx)};
      else {
        const match=/^\/v1\/health\/suggestions\/([^/]+)\/(accept|reject|undo)$/.exec(path);
        if(method!=='POST'||!match) fail('health_not_found',404);
        result=service.suggestion(ctx,key(),decodeURIComponent(match[1]!),match[2] as 'accept'|'reject'|'undo',body);
      }
      return {status:200,body:result};
    } catch(e) {
      if(e instanceof WearableError) return {status:e.status,body:{code:e.code}};
      // Root lifecycle errors must retain their status, without echoing details or payloads.
      if(e && typeof e==='object' && 'code' in e && 'status' in e &&
        ['account_session_invalid','account_epoch_changed','account_disabled'].includes(String(e.code))) return {status:Number(e.status),body:{code:e.code}};
      return {status:503,body:{code:'health_unavailable'}};
    }
  };
}
