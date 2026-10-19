import type { AccountContext, ImportPage, Measure, Provider } from '../types.js';
import type { WearablesService } from '../service.js';
import { fail, page, stable } from '../validation.js';
export interface ProviderPagePort {read(cursor:string|null):Promise<{records:Measure[];nextToken:string|null}>}
export type ProviderIntent = {key:string;binding:string;page:ImportPage};
// Root persists this intent in its account/session-scoped facilities after the no-save gate.
export interface ProviderIntentPort {
  load():ProviderIntent|null;
  save(intent:ProviderIntent):void;
  acknowledged(key:string):void;
}
export async function importProviderPage(input:{ctx:AccountContext;provider:Exclude<Provider,'healthkit'>;connectionId:string;generation:number;
  stream:string;cursor:string|null;source:ProviderPagePort;service:WearablesService;intent:ProviderIntentPort;newKey:()=>string;assertCurrent:()=>void}) {
  const check=()=>{input.assertCurrent();input.service.authorizeImport(input.ctx,input.provider,input.connectionId,input.generation);};
  check();
  const binding=stable([input.ctx.accountId,input.ctx.sessionId,input.ctx.epoch,input.provider,input.connectionId,input.generation,input.stream,input.cursor]);
  let pending=input.intent.load();
  if(pending&&pending.binding!==binding)fail('provider_intent_changed',409);
  if(!pending){
    const result=await input.source.read(input.cursor);check();
    if(result.nextToken!==null&&result.nextToken===input.cursor)fail('provider_cursor_cycle',409);
    const key=input.newKey();
    const value=page({version:1,connectionId:input.connectionId,generation:input.generation,stream:input.stream,
      fromCursor:input.cursor,nextCursor:result.nextToken,pageId:key,batch:result.records,tombstones:[]});
    pending={key,binding,page:value};input.intent.save(structuredClone(pending));
  }
  check();const result=input.service.ingest(input.ctx,pending.key,pending.page,{provider:input.provider});
  check();input.intent.acknowledged(pending.key);return result;
}
