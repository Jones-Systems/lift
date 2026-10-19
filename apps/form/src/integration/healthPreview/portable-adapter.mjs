import { copy, rejected, planValid, commandValid, seal } from './portable-records.mjs';

// Owner maps this read callback to current Form resources; no editPlan reference is captured.
export function createReadOnlyFormAdapter(resources) {
  return Object.freeze({capability:'read_only',async readPlan(ctx,id){if(!ctx.isCurrentSession())return rejected('stale_session');const p=await resources.getPlan(id);if(!ctx.isCurrentSession())return rejected('stale_session');try{planValid(p);return {status:'ok',value:copy(p)};}catch(e){return rejected(e.message);}},async commitSuggestion(){return rejected('read_only');},async lookupReceipt(){return {status:'reconciliation_required',code:'read_only'};}});
}
export function createSessionController(ctx,port,render) {
  let alive=true;
  return Object.freeze({async reviewPlan(id){if(!alive||!ctx.isCurrentSession())return rejected('stale_session');const result=await port.readPlan(ctx,id);if(!alive||!ctx.isCurrentSession())return rejected('stale_session');render(result);return result;},async dispatch(command){if(!alive||!ctx.isCurrentSession())return rejected('stale_session');if(port.capability!=='atomic_suggestions_v1')return rejected('read_only');try { commandValid(command,command.kind); } catch(e) { return rejected(e.message); } const sealedBytes=seal(command);const result=await port.commitSuggestion(ctx,command,sealedBytes);if(!alive||!ctx.isCurrentSession())return rejected('stale_session');render(result);return result;},dispose(){alive=false;}});
}
