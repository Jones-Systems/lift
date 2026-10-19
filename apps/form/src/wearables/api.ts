import type { BoundHealthApi, ImportAck, ImportPage, SessionFence } from './model.js';
export interface SessionBoundRequest {
  request<T>(path:string,method?:string,body?:unknown,key?:string):Promise<T>;
}
// Construct with root's original-session bound transport, not an API that captures a newer account per call.
export function createHealthApi(request:SessionBoundRequest,session:SessionFence):BoundHealthApi {
  async function send<T>(path:string,body:unknown,key:string):Promise<T>{
    if(!session.isCurrentSession())throw new Error('health_session_changed');
    const value=await request.request<T>(path,'POST',body,key);
    if(!session.isCurrentSession())throw new Error('health_session_changed_unknown');
    return value;
  }
  return {
    importPage:(page:ImportPage,key:string)=>send<ImportAck>('/v1/health/imports',page,key),
    disconnect:(input,key)=>send('/v1/health/connections/healthkit/disconnect',input,key),
  };
}
