const reasons={missing:'A sample landmark is obscured.',scale:'The sample scale is unverified.',rotation:'The sample body is rotated.',supported:'Real measurement validation is unavailable.'};
export function createCapturePreview(){
 let state={stage:'empty',sample:null,result:null};
 return {
  get state(){return structuredClone(state);},
  check(scenario){if(!Object.hasOwn(reasons,scenario))throw new Error('Unsupported scenario');state={stage:'unable',sample:'fictional-'+scenario,result:reasons[scenario]};return this.state;},
  retake(){state={stage:'empty',sample:null,result:null};return this.state;},
  discard(){state={stage:'discarded',sample:null,result:null};return this.state;}
 };
}
if(typeof document!=='undefined'){
 const result=document.querySelector('#capture-result');
 if(result){
  const preview=createCapturePreview();
  document.querySelectorAll('[data-body-action]').forEach(button=>button.addEventListener('click',()=>{
   const action=button.dataset.bodyAction;
   if(action==='check'){const state=preview.check(document.querySelector('#capture-scenario').value);result.textContent=`Unable to estimate. ${state.result} No measurement or diagnosis was generated.`;}
   else if(action==='retake'){preview.retake();result.textContent='Ready to retake a fictional sample. Previous sample cleared.';}
   else{preview.discard();result.textContent='Session discarded. Sample and derived state cleared. Nothing was saved.';}
  }));
  addEventListener('pagehide',()=>preview.discard());
  addEventListener('pageshow',()=>{preview.discard();result.textContent='No sample is active. Nothing is saved.';});
 }
}
