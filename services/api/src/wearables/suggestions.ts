import type { AccountContext, PlanItem, RootPorts, Suggestion } from './types.js';
import { fail, integer, object, stable, text } from './validation.js';
type ReceiptRun = <T>(ctx:AccountContext,key:string,intent:unknown,effect:()=>T)=>T;
function boundedPatch(before:PlanItem[],after:PlanItem[]) {
  if(!before.length || before.length!==after.length) fail('health_unsupported_plan',409);
  let changed=0;
  for(let i=0;i<before.length;i++) {
    const a=before[i]!,b=after[i]!;
    if(a.id!==b.id||a.exerciseId!==b.exerciseId||a.repMin!==b.repMin||a.repMax!==b.repMax||a.targetKg!==b.targetKg) fail('health_purpose_changed',409);
    if(a.setTarget!==b.setTarget) {if(!Number.isInteger(b.setTarget)||b.setTarget!==a.setTarget-1||b.setTarget<2) fail('health_unsupported_plan',409); changed++;}
  }
  if(changed!==1) fail('health_unsupported_plan',409);
}
export function suggestionCommand(root:RootPorts,ctx:AccountContext,key:string,id:string,kind:'accept'|'reject'|'undo',input:unknown,receipt:ReceiptRun) {
  const v=object(input,kind==='reject'?[]:['expectedPlanRevision','reviewDigest']);
  const expected=kind==='reject'?null:integer(v.expectedPlanRevision);
  const review=kind==='reject'?null:text(v.reviewDigest);
  const found=root.store.suggestion(ctx,text(id)); if(!found) return fail('health_not_found',404);
  if(!root.plans || !root.assertSuggestionAllowed) fail('health_suggestions_unavailable',503);
  return receipt(ctx,key,{op:kind,id,expected,review},()=>{
    const s=root.store.suggestion(ctx,id)!;
    if(kind==='reject') {
      if(s.state!=='pending') fail('health_suggestion_changed',409);
      root.store.putSuggestion(ctx,{...s,state:'rejected'});return {state:'rejected',planChanged:false};
    }
    if(s.reviewDigest!==review) fail('health_review_changed',409);
    const plan=root.plans!.readWithinWrite(ctx,s.planId);
    if(plan.activeWorkout) fail('workout_in_progress',409);
    if(plan.revision!==expected) fail('plan_changed_since_apply',409);
    if(kind==='accept') {
      root.assertSuggestionAllowed!(ctx,s);
      if(s.state!=='pending'||!Number.isFinite(Date.parse(s.expiresAt))||Date.parse(s.expiresAt)<=Date.parse(root.now())||plan.revision!==s.baseRevision) fail('health_suggestion_changed',409);
      if(stable(plan.items)!==stable(s.beforeItems)) fail('health_plan_changed',409);
      boundedPatch(s.beforeItems,s.afterItems);
      for(const ref of s.evidenceRefs) {
        const c=root.store.connection(ctx,ref.connectionId),m=root.store.measure(ctx,ref.connectionId,ref.generation,ref.id);
        if(!c?.connected||!c.retentionConsent||c.generation!==ref.generation||!m||m.deleted||m.digest!==ref.digest) fail('health_evidence_changed',409);
      }
    } else if(s.state!=='applied'||plan.revision!==s.appliedRevision ||stable(plan.items)!==stable(s.afterItems)) fail('plan_changed_since_apply',409);
    const result=root.plans!.applyWithinWrite(ctx,{planId:s.planId,expectedRevision:plan.revision,
      items:structuredClone(kind==='accept'?s.afterItems:s.beforeItems),receipt:{operation:kind==='accept'?'suggestion_accept':'suggestion_undo',suggestionId:id}});
    if(result.revision!==plan.revision+1) fail('health_plan_port_contract',503);
    const next:Suggestion={...s,state:kind==='accept'?'applied':'undone',appliedRevision:kind==='accept'?result.revision:s.appliedRevision};
    root.store.putSuggestion(ctx,next);
    return {state:next.state,revision:result.revision,planChanged:true,scope:'saved_reusable_plan'};
  });
}
