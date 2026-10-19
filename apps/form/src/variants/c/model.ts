import { fixtures as F } from './generatedfixtures';
import type { ScreenId } from '../../types';
export type MovementId=keyof typeof F.movements;
export type Movement=(typeof F.movements)[MovementId];
export type SetValue={reps:number;loadKg:number};
export type DraftKey=keyof typeof F.coach.drafts;
export type DraftState='hidden'|'draft'|'applied'|'dismissed';
export type Entry={speaker:'you'|'coach';time:string;text:string;draft?:DraftKey};
export type Metric='sets'|'minutes'|'sessions';
export type Notice={text:string;undo?:'version'|'move'|'skip';previous?:'full'|'short'|number|boolean};
export type State={screen:ScreenId;variant:'full'|'short';squatSwap:boolean;friMoved:boolean;movementIndex:number;confirmed:Partial<Record<MovementId,SetValue[]>>;draftSet:SetValue;saved:boolean;lastAction:'confirm'|null;metric:Metric;planExpanded:string|null;weekExpanded:number|null;drafts:Record<DraftKey,DraftState>;entries:Entry[];used:string[];compose:string;notices:Partial<Record<ScreenId,Notice>>;sheet:boolean;feedback:number};
export const movements=(s:State):Movement[] => F.sessions[s.variant].movementIds.map(k=>F.movements[s.squatSwap&&k==='goblet-squat'?'box-squat':k as MovementId]);
export const setsFor=(s:State,m:Movement)=>s.variant==='short'?F.sessions.short.setsPerMovement:m.sets;
export const confirmedCount=(s:State)=>Object.values(s.confirmed).reduce((n,rows)=>n+(rows?.length??0),0);
export const plannedCount=(s:State)=>movements(s).reduce((n,m)=>n+setsFor(s,m),0);
export const recordedMinutes=(s:State)=>Math.round(F.sessions[s.variant].minutes*confirmedCount(s)/plannedCount(s));
export const loadText=(value:SetValue,id?:MovementId)=>value.loadKg===0?'body weight':`${value.loadKg} kg${id==='floor-press'||id==='romanian-deadlift'?' each':''}`;
export const setText=(value:SetValue,id?:MovementId)=>`${value.reps} × ${loadText(value,id)}`;
export const defaults=(m:Movement):SetValue=>({reps:m.repsDefault,loadKg:m.loadKg});
export function initialState(screen:ScreenId='today',fixture='default'):State {
 const s:State={screen,variant:'full',squatSwap:false,friMoved:fixture==='moved',movementIndex:0,confirmed:{},draftSet:defaults(F.movements['goblet-squat']),saved:fixture==='saved',lastAction:null,metric:'sets',planExpanded:null,weekExpanded:null,drafts:{'box-squat':fixture==='applied'?'applied':'draft',short:'hidden'},entries:[],used:[],compose:'',notices:{},sheet:false,feedback:0};
 if(fixture==='confirmed'||fixture==='saved'){s.confirmed['goblet-squat']=[defaults(F.movements['goblet-squat'])];s.lastAction='confirm';}
 if(fixture==='applied'){s.squatSwap=true;s.draftSet=defaults(F.movements['box-squat']);}
 if(fixture==='moved')s.notices.plan={text:F.planMoves.fri.notice,undo:'move',previous:false};
 return s;
}
export type Action={type:'tab';screen:ScreenId}|{type:'version';page:'today'|'plan'}|{type:'undo-notice';page:ScreenId}|{type:'expand-plan';day:string}|{type:'move'}|{type:'reset-plan'}|{type:'adjust';field:keyof SetValue;delta:number}|{type:'confirm'}|{type:'undo-set'}|{type:'next'|'skip'|'prev'|'save'|'reset-open'|'reset-close'|'reset-confirm'}|{type:'metric';metric:Metric}|{type:'expand-week';index:number}|{type:'draft';key:DraftKey;operation:'apply'|'undo'|'dismiss'|'reopen'}|{type:'chip';id:string}|{type:'compose';text:string}|{type:'send'|'clear-notes'};
export function reducer(s:State,a:Action):State {
 const count=confirmedCount(s), list=movements(s),m=list[s.movementIndex];
 const base={...s,feedback:s.feedback+1};
 switch(a.type){
 case 'tab':return {...s,screen:a.screen};
 case 'version':{
  if(count||s.saved)return s;const variant=s.variant==='full'?'short':'full';
  return {...base,variant,movementIndex:0,draftSet:defaults(list[0]),notices:{...s.notices,[a.page]:{text:variant==='short'?'Today is now the 20-minute version.':'Today is back to 35 minutes.',undo:'version',previous:s.variant}}};
 }
 case 'undo-notice':{
  const n=s.notices[a.page];if(!n)return s;
  const next={...base,notices:{...s.notices,[a.page]:undefined}};
  if(n.undo==='move')next.friMoved=!!n.previous;
  if(n.undo==='version'&&!count){next.variant=n.previous as 'full'|'short';next.movementIndex=0;next.draftSet=defaults(movements(next)[0]);}
  if(n.undo==='skip'){next.movementIndex=n.previous as number;next.draftSet=defaults(movements(next)[next.movementIndex]);next.saved=false;}
  return next;
 }
 case 'expand-plan':return {...s,planExpanded:s.planExpanded===a.day?null:a.day};
 case 'move':return {...base,friMoved:!s.friMoved,planExpanded:null,notices:{...s.notices,plan:{text:!s.friMoved?F.planMoves.fri.notice:'The session is back on Friday.',undo:'move',previous:s.friMoved}}};
 case 'reset-plan':return {...base,friMoved:false,variant:count?s.variant:'full',notices:{...s.notices,plan:{text:'This week is back to the original plan.'}}};
 case 'adjust':{
  if(s.saved)return s;const min=a.field==='reps'?m.repsMin:m.loadMinKg,max=a.field==='reps'?m.repsMax:m.loadMaxKg;
  return {...s,draftSet:{...s.draftSet,[a.field]:Math.max(min,Math.min(max,s.draftSet[a.field]+a.delta))}};
 }
 case 'confirm':{
  if(s.saved)return s;const rows=s.confirmed[m.id]??[];if(rows.length>=setsFor(s,m))return s;
  return {...base,confirmed:{...s.confirmed,[m.id]:[...rows,{...s.draftSet}]},lastAction:'confirm'};
 }
 case 'undo-set':{
  const rows=s.confirmed[m.id]??[];if(s.saved||s.lastAction!=='confirm'||!rows.length)return s;
  return {...base,confirmed:{...s.confirmed,[m.id]:rows.slice(0,-1)},draftSet:rows[rows.length-1],lastAction:null};
 }
 case 'next':case 'skip':case 'prev':{
  if(s.saved)return s;
  if(a.type==='next'&&(s.confirmed[m.id]?.length??0)<setsFor(s,m))return s;
  const movementIndex=Math.max(0,Math.min(list.length-1,s.movementIndex+(a.type==='prev'?-1:1)));
  const skipped=a.type==='skip';
  return {...base,movementIndex,draftSet:defaults(list[movementIndex]),lastAction:null,saved:skipped&&s.movementIndex===list.length-1&&count>0,notices:{...s.notices,workout:skipped?{text:`Skipped ${m.name}. Nothing was recorded for it.`,undo:'skip',previous:s.movementIndex}:s.notices.workout}};
 }
 case 'save':return count?{...base,saved:true}:s;
 case 'reset-open':return {...s,sheet:true};
 case 'reset-close':return {...s,sheet:false};
 case 'reset-confirm':return {...base,confirmed:{},saved:false,movementIndex:0,draftSet:defaults(list[0]),lastAction:null,sheet:false,notices:{...s.notices,workout:undefined}};
 case 'metric':return {...s,metric:a.metric};
 case 'expand-week':return {...s,weekExpanded:s.weekExpanded===a.index?null:a.index};
 case 'draft':{
  if(count&&(a.operation==='apply'||a.operation==='undo'))return s;
  const state:DraftState=a.operation==='apply'?'applied':a.operation==='dismiss'?'dismissed':'draft';
  const next={...base,drafts:{...s.drafts,[a.key]:state}};
  if(a.operation==='apply'||a.operation==='undo'){
   if(a.key==='box-squat')next.squatSwap=a.operation==='apply';else next.variant=a.operation==='apply'?'short':'full';
   next.movementIndex=0;next.draftSet=defaults(movements(next)[0]);
   if(a.operation==='undo')next.notices={...s.notices,coach:{text:'Undone. Today is back to the original plan.'}};
  }
  return next;
 }
 case 'chip':{
  const chip=F.coach.suggestions.find(x=>x.id===a.id);if(!chip||s.used.includes(a.id))return s;
  const time=F.coach.followUpTimes[Math.min(s.entries.length/2,F.coach.followUpTimes.length-1)];
  const entries:Entry[]=[...s.entries,{speaker:'you',time,text:chip.you},{speaker:'coach',time,text:chip.coach,...(chip.draft?{draft:chip.draft}:{})}];
  return {...s,entries,used:[...s.used,a.id],drafts:chip.draft&&s.drafts[chip.draft]!=='applied'?{...s.drafts,[chip.draft]:'draft'}:s.drafts};
 }
 case 'compose':return {...s,compose:a.text.slice(0,500)};
 case 'send':{
  const text=s.compose.trim();if(!text)return s;
  const time=F.coach.followUpTimes[Math.min(s.entries.length/2,F.coach.followUpTimes.length-1)];
  return {...s,compose:'',entries:[...s.entries,{speaker:'you',time,text},{speaker:'coach',time,text:F.coach.freeNoteReply}]};
 }
 case 'clear-notes':return {...s,entries:[],used:[],compose:'',drafts:{'box-squat':s.drafts['box-squat']==='applied'?'applied':'draft',short:s.drafts.short==='applied'?'applied':'hidden'}};
 }
}
