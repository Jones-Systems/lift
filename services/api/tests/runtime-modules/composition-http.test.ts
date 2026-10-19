import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { localDate, type ActivityEntry } from '../../src/activity/index.js';
import { createSubjectEligibilityProvider } from '../../src/server.js';
import { createSourceRequestFactories } from '../../src/lifecycle/request-factories.js';
import { assertActive, withActiveWrite, adultEligibility } from '../../src/lifecycle/guards.js';
import { personalFields, unknownLoad } from '../activity/fixture.js';
import { deployment, provision, start, users, request, boardInput, origin, type User } from './fixture.js';
import {usefulActivity,paused} from './http-fixture.js';
test('maintained auth plus durable witness actual16 supports useful isolated Activity and private pending board',async t=>{
 const d=await deployment(t);await provision(d);const {server,owner}=await start(d);const [a,b]=await users(server);
 const {entry,exerciseId}=await usefulActivity(server,a);
 assert.equal((await request(server,'/v1/activity/entries/'+entry.id,b)).status,404);
 assert.equal((await request(server,'/v1/activity/exercises/'+exerciseId,b)).status,404);
 assert.equal((await request(server,'/v1/activity/entries/'+entry.id+'/void',a,'POST',{expectedRevision:entry.revision},'void')).status,200);
 const submitted=await request(server,'/v1/community/board/features',a,'POST',boardInput,'submit');assert.equal(submitted.status,201);
 const row=await submitted.json() as {id:string;featureId:string;revision:number;visibility:string};assert.equal(row.visibility,'pending');
 assert.equal((await request(server,'/v1/community/board/features/'+row.featureId,b)).status,404);
 assert.deepEqual((await (await request(server,'/v1/community/board/features',b)).json() as {features:unknown[]}).features,[]);
 assert.equal(owner.ledger.currentSequence(),0);assert.deepEqual(server.lifecycle!.adapters.map(a=>a.category).sort(),['activity','bugIntake','community','usage_limits']);
 assert.equal((await request(server,'/v1/community/me/matching',a)).status,200);
 assert.equal((await request(server,'/v1/community/me/blocks',a)).status,200);
});
for(const mutation of ['session','epoch','disable'])test(`durable runtime Activity retains actor across interleaved body and denies late ${mutation}`,async t=>{
 const d=await deployment(t);await provision(d);const {server,owner}=await start(d),[a,b]=await users(server);
 const slow=paused(server,a,'/v1/activity/calendar',{timeZone:'America/New_York',confirmed:true},t);await slow.ready;
 assert.equal((await request(server,'/v1/activity/calendar',b)).status,200);
 if(mutation==='session')server.db.prepare('DELETE FROM session WHERE id=?').run(a.actor.sessionId);
 else if(mutation==='epoch')server.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(a.actor.accountId);
 else owner.ledger.recordDisable({accountId:a.actor.accountId,authUserId:a.actor.authUserId,epoch:1,requestId:'synthetic-disable',disabledAtMs:Date.now()});
 slow.finish();assert.ok([401,403].includes((await slow.pending).status));assert.equal((server.db.prepare('SELECT count(*) n FROM activity_calendar').get() as {n:number}).n,0);
});
test('Activity owner lease cannot be copied or reused after release; legacy remains absent',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d),[a]=await users(server);
 const db=server.db,lifecycle={assertActive:(actor:User['actor'])=>assertActive(db,actor),withActiveWrite:<T>(actor:User['actor'],fn:()=>T)=>withActiveWrite(db,actor,fn),adultEligibility:(actor:User['actor'])=>adultEligibility(db,actor)};
 // Source-only lease boundary probe; this separate probe adapter is never registered on the runtime.
 const probe=createSourceRequestFactories({db,lifecycle,configuration:{mode:'source-only',activityCommands:'owner-input'},subjectEligibilityFor:actor=>createSubjectEligibilityProvider(db,actor)});
 const integration=probe.activityIntegration!;assert.equal(integration.service.deps.legacy,undefined);const lease=integration.openOwnerRequest(a.actor);
 assert.throws(()=>integration.service.createCalendar({...lease.context},'copied',{timeZone:'America/New_York',confirmed:true}));lease.release();
 assert.throws(()=>integration.service.createCalendar(lease.context,'released',{timeZone:'America/New_York',confirmed:true}));
});
test('B4 real durable actor dispatch can block/unblock independently of parent invitation gating',async t=>{
 const d=await deployment(t);await provision(d);const first=await start(d,{textSynthetic:true}),[a,b]=await users(first.server);
 const {populateCommunity}=await import('./community-fixture.js');const populated=await populateCommunity(first.server,a,b);
 const member=(first.server.db.prepare('SELECT member_id FROM community_members WHERE group_id=? AND account_id=?').get(populated.group.id,b.actor.accountId) as {member_id:string}).member_id;
 await first.server.close();const {server}=await start(d);
 assert.equal((await request(server,`/v1/community/groups/${populated.group.id}/members/${member}/block`,a,'POST',{},'block')).status,200);
 const block=server.db.prepare('SELECT id,active,revision FROM community_blocks WHERE owner_account_id=? AND subject_account_id=?').get(a.actor.accountId,b.actor.accountId) as {id:string;active:number;revision:number};assert.equal(block.active,1);
 assert.equal((await request(server,`/v1/community/me/blocks/${block.id}/unblock`,a,'POST',{expectedRevision:block.revision},'unblock')).status,200);
 assert.equal((server.db.prepare('SELECT active FROM community_blocks WHERE id=?').get(block.id) as {active:number}).active,0);
});
test('streamed B4 enrollment retains A while B reads and late minor profile denies all positive effects',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d,{textSynthetic:true}),[a,b]=await users(server);
 const input={expectedRevision:0,preferences:{alias:'Owner',intent:'accountability',language:'en',goals:['consistency'],region:null,location:'anywhere',priorities:['location','goals'],relax:{broaderRegion:false,mixedGoals:false},willingHost:true,fillExistingGroups:false,membershipDisclosureAccepted:true,policyVersion:'community-v1'}};
 const slow=paused(server,a,'/v1/community/me/matching/enroll',input,t);await slow.ready;
 assert.equal((await request(server,'/v1/community/me/matching',b)).status,200);
 const profile=await (await request(server,'/v1/me/profile',a)).json() as {revision:number};assert.equal((await request(server,'/v1/me/profile',a,'PATCH',{expectedRevision:profile.revision,age:17})).status,200);
 slow.finish();assert.equal((await slow.pending).status,403);assert.equal((server.db.prepare('SELECT count(*) n FROM community_match_enrollments').get() as {n:number}).n,0);
});
