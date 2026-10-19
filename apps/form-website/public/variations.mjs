const panel=document.querySelector('.demo-panel');
if(panel){
 let completed=new Set();
 let minutes=30;
 let day='Monday';
 let scenario='home';
 const movements=[['Goblet squat','3 × 8–10'],['Dumbbell floor press','3 × 8–10'],['One-arm row','3 × 10 each side'],['Dead bug','3 × 8 each side']];
 const selectedMovements=()=>minutes===20?movements.slice(0,3):movements;
 const title=()=>scenario==='short'?'A shorter sample session':scenario==='explore'?'Explore full-body movement':'Full-body dumbbells';
 function announce(message){panel.querySelector('[data-demo-status]').textContent=message;}
 function openTab(name,focus=false){
  for(const tab of panel.querySelectorAll('[data-demo-tab]')){const selected=tab.dataset.demoTab===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();}
  for(const view of panel.querySelectorAll('.demo-view'))view.hidden=view.id!==`sample-${name}`;
 }
 function render(){
  panel.querySelectorAll('[data-demo-title]').forEach(el=>el.textContent=title());
  panel.querySelectorAll('[data-demo-duration]').forEach(el=>el.textContent=String(minutes));
  panel.querySelector('[data-demo-movements]').textContent=String(selectedMovements().length);
  panel.querySelector('[data-demo-day-title]').textContent=`${day} · strength`;
  panel.querySelector('[data-demo-duration-select]').value=String(minutes);
  panel.querySelectorAll('[data-demo-count]').forEach(el=>el.textContent=String(completed.size));
  panel.querySelector('[data-demo-total]').textContent=String(selectedMovements().length*3);
  panel.querySelector('[data-demo-exercises]').replaceChildren(...selectedMovements().map(([name,target],i)=>{
   const row=document.createElement('div');row.className='demo-exercise';
   const label=document.createElement('div');const strong=document.createElement('strong');strong.textContent=name;const text=document.createElement('span');text.textContent=target;label.append(strong,text);
   const button=document.createElement('button');button.type='button';button.className='demo-log';const count=[0,1,2].filter(n=>completed.has(`${i}-${n}`)).length;button.textContent=count===3?'3 / 3 complete':`Mark set · ${count} / 3`;button.setAttribute('aria-label',`Mark a sample ${name} set complete, ${count} of 3`);button.disabled=count===3;button.addEventListener('click',()=>{completed.add(`${i}-${count}`);render();announce(`Sample ${name} set ${count+1} complete. This is demo data only.`);});row.append(label,button);return row;
  }));
  panel.querySelector('[data-demo-plan-list]').replaceChildren(...['Monday','Wednesday','Friday'].map(name=>{const row=document.createElement('div');row.className='demo-plan-row';const label=document.createElement('strong');label.textContent=name;const summary=document.createElement('span');summary.textContent=`${minutes} min · ${selectedMovements().length} sample movements`;row.append(label,summary);return row;}));
 }
 const responses={plan:'This fictional week contains three example sessions. Use the Plan tab to change their sample duration, or the Workout tab to explore the movement list.',logging:'Marking a set changes the counters and the current preview summary. It does not record a real workout or send information to an account.',privacy:'Nothing entered in this sample workspace is uploaded or written to browser storage. Reloading the page clears the current demo interactions.'};
 function response(){panel.querySelector('[data-demo-response]').textContent=responses[panel.querySelector('[data-demo-question]').value];}
 panel.querySelectorAll('[data-demo-tab]').forEach(tab=>{tab.addEventListener('click',()=>openTab(tab.dataset.demoTab));tab.addEventListener('keydown',event=>{const tabs=[...panel.querySelectorAll('[data-demo-tab]')];let index=tabs.indexOf(tab);if(event.key==='ArrowRight')index=(index+1)%tabs.length;else if(event.key==='ArrowLeft')index=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=tabs.length-1;else return;event.preventDefault();openTab(tabs[index].dataset.demoTab,true);});});
 panel.querySelectorAll('[data-demo-day]').forEach(button=>button.addEventListener('click',()=>{day=button.dataset.demoDay;panel.querySelectorAll('[data-demo-day]').forEach(el=>el.setAttribute('aria-pressed',String(el===button)));render();announce(`${day} sample selected.`);}));
 panel.querySelector('[data-demo-duration-select]').addEventListener('change',event=>{minutes=Number(event.target.value);completed=new Set();render();announce(`Sample plan changed to ${minutes} minutes. No account preference changed.`);});
 panel.querySelector('[data-demo-open-workout]').addEventListener('click',()=>openTab('workout',true));
 panel.querySelector('[data-demo-open-progress]').addEventListener('click',()=>openTab('progress',true));
 panel.querySelector('[data-demo-question]').addEventListener('change',response);
 panel.querySelector('[data-demo-reset]').addEventListener('click',()=>{completed=new Set();minutes=30;day='Monday';scenario='home';document.querySelectorAll('[data-scenario]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.scenario==='home')));const guidedTitle=document.querySelector('[data-guided-title]');if(guidedTitle)guidedTitle.textContent=title();render();openTab('today');panel.querySelectorAll('[data-demo-day]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.demoDay===day)));announce('Demo reset. No account data was changed.');});
 document.querySelectorAll('[data-scenario]').forEach(button=>button.addEventListener('click',()=>{scenario=button.dataset.scenario;minutes=scenario==='short'?20:30;completed=new Set();document.querySelectorAll('[data-scenario]').forEach(el=>el.setAttribute('aria-pressed',String(el===button)));render();openTab('today');const label=document.querySelector('[data-guided-title]');if(label)label.textContent=title();const description=document.querySelector('[data-guided-description]');if(description)description.textContent=scenario==='short'?'A compact fictional example with three movements.':'A fictional full-body example to explore at your own pace.';announce('Example changed. No personalized advice was generated.');}));
 const initiallyChosen=document.querySelector('[data-scenario][aria-pressed="true"]');
 if(initiallyChosen){scenario=initiallyChosen.dataset.scenario;minutes=scenario==='short'?20:30;}
 render();response();
}
