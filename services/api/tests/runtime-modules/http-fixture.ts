import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { localDate, type ActivityEntry } from '../../src/activity/index.js';
import { createSubjectEligibilityProvider } from '../../src/server.js';
import { createSourceRequestFactories } from '../../src/lifecycle/request-factories.js';
import { assertActive, withActiveWrite, adultEligibility } from '../../src/lifecycle/guards.js';
import { personalFields, unknownLoad } from '../activity/fixture.js';
import { deployment, provision, start, users, request, registerStreamCancellation, boardInput, origin, type User } from './fixture.js';
export async function usefulActivity(server:Awaited<ReturnType<typeof start>>['server'],a:User):Promise<{entry:ActivityEntry;exerciseId:string}> {
 const today=localDate(new Date().toISOString(),'America/New_York');
 assert.equal((await request(server,'/v1/activity/calendar',a,'POST',{timeZone:'America/New_York',confirmed:true},'calendar')).status,201);
 const exerciseResponse=await request(server,'/v1/activity/exercises',a,'POST',{...personalFields,name:'Owner private exercise'},'exercise');assert.equal(exerciseResponse.status,201);
 const exercise=await exerciseResponse.json() as {id:string;revision:number};
 const items=[{id:'personal-item',exercise:{source:'personal',id:exercise.id,revision:exercise.revision},load:unknownLoad}];
 const planResponse=await request(server,'/v1/activity/plans',a,'POST',{name:'Owner private plan',items:items.map(item=>({id:item.id,exercise:item.exercise,target:{load:item.load}}))},'plan');assert.equal(planResponse.status,201);
 const plan=await planResponse.json() as {id:string;revision:number};
 const schedule={expectedRevision:0,effectiveFrom:today,week:Array.from({length:7},(_,i)=>({isoWeekday:i+1,expectation:'workout',plan:{id:plan.id,revision:plan.revision}}))};
 const scheduled=await request(server,'/v1/activity/schedule',a,'POST',schedule,'schedule');assert.equal(scheduled.status,201,await scheduled.clone().text());
 const input={date:{localDate:today,timeZone:'America/New_York',calendar:'iso8601',source:'selected',capturedAt:new Date().toISOString(),referenceLocalDate:today,confirmed:true},
   kind:'workout',items,performedConfirmed:true,source:'manual',draftId:'owner-independent-entry',acknowledgedIssues:[]};
 const entryResponse=await request(server,'/v1/activity/entries',a,'POST',input,'entry');assert.equal(entryResponse.status,201);const entry=await entryResponse.json() as ActivityEntry;
 const edited=await request(server,'/v1/activity/entries/'+entry.id,a,'PATCH',{...input,expectedRevision:entry.revision},'entry-edit');assert.equal(edited.status,200);
 return {entry:await edited.json() as ActivityEntry,exerciseId:exercise.id};
}
// Helpers used by other groups live in this file without starting any HTTP listener.
export function paused(server:Awaited<ReturnType<typeof start>>['server'],a:User,path:string,value:unknown,t:TestContext) {
 let controller:ReadableStreamDefaultController<Uint8Array>|undefined,admitted!:()=>void;
 const ready=new Promise<void>(resolve=>{admitted=resolve;});
 const stream=new ReadableStream<Uint8Array>({start(c){controller=c;},pull(){admitted();}},{highWaterMark:0});
 const cancel=()=>{try{controller?.error(new Error('synthetic cancellation'));}catch{}};const unregister=registerStreamCancellation(server,cancel);t.after(()=>{cancel();unregister();});
 const pending=Promise.resolve(server.handleRequest(new Request(origin+path,{method:'POST',headers:{origin,authorization:`Bearer ${a.token}`,'content-type':'application/json','idempotency-key':'paused','content-length':String(Buffer.byteLength(JSON.stringify(value)))},body:stream,duplex:'half'} as RequestInit&{duplex:'half'}),'127.0.0.1'));
 void pending.catch(()=>{});
 return {ready:Promise.race([ready,pending.then(r=>{throw new Error(`Early response ${r.status}`);})]),pending,finish(){controller!.enqueue(new TextEncoder().encode(JSON.stringify(value)));controller!.close();}};
}
