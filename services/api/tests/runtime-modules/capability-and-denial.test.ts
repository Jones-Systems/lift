import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CommunityLimiter, actionLimits } from '../../src/runtime-modules/limiter.js';
import { communityNamespace, requiresTextPort } from '../../src/runtime-modules/dispatch.js';
import { assertActive, withActiveWrite, adultEligibility } from '../../src/lifecycle/guards.js';
import { deployment, provision, start, users, request, boardInput, origin, password } from './fixture.js';

test('default public five staged actions deny before body consumption including unauthenticated receipt status',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d),[a]=await users(server);
 for(const path of ['/v1/me/account-action-grants','/v1/me/deletion-requests',`/v1/me/deletion-requests/${randomUUID()}/confirm`,'/v1/account-deletion/status','/v1/me/account-export']) {
  let reads=0;const stream=new ReadableStream<Uint8Array>({pull(){reads++;throw new Error('must not consume');}},{highWaterMark:0});
  try {const response=await server.handleRequest(new Request(origin+path,{method:'POST',headers:{origin,authorization:`Bearer ${a.token}`,'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit&{duplex:'half'}),'synthetic');assert.equal(response.status,501);assert.equal(reads,0);}finally{await stream.cancel();}
 }
 const settings=await (await request(server,'/v1/me/settings',a)).json() as {stagedAccountLifecycle:{initiation:boolean};capabilities:{accountDeletion:{supported:boolean}}};
 assert.equal(settings.stagedAccountLifecycle.initiation,false);assert.equal(settings.capabilities.accountDeletion.supported,false);
});
test('explicit source synthetic public-on verifies maintained password without changing private CLI truth',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d,{publicSynthetic:true}),[a]=await users(server);
 const grant=await request(server,'/v1/me/account-action-grants',a,'POST',{purpose:'account_export',password});assert.equal(grant.status,201);
 assert.equal((await request(server,'/v1/me/account-action-grants',a,'POST',{purpose:'account_export',password:'wrong'})).status,403);
});
test('B4 namespace selection is terminal and separate from invitation middleware; positive text/enrollment denied before replay',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d),[a]=await users(server);
 assert.equal((await request(server,'/v1/community/me/matching',a)).status,200);
 assert.equal((await request(server,'/v1/community/me/matching/cancel',a,'POST',{expectedRevision:0},'cancel')).status,200);
 assert.equal((await request(server,'/v1/community/me/matching/enroll',a,'POST',{},'enroll-replay')).status,503);
 assert.equal((await request(server,'/v1/community/me/matching',a,'PATCH',{},'enroll-replay')).status,503);
 assert.equal((await request(server,'/v1/community/groups',a,'POST',{},'create')).status,503);
 assert.equal((await request(server,'/v1/community/invitations/join',a,'POST',{},'join')).status,503);
 assert.equal((await request(server,'/v1/community/board/unrecognized',a)).status,404);
 assert.equal((await request(server,'/v1/community/me/matching',a,'POST',{})).status,404);
 assert.equal((await request(server,'/v1/community/groups/not-a-group/me',a,'PATCH',{},'alias')).status,503);
 assert.equal((await request(server,'/v1/community/board/features',a,'POST',boardInput,'submit')).status,201);
 const metadata=await (await request(server,'/v1/capabilities',a)).json() as {runtimeModules:{enrollment:boolean;limiter:string;publication:boolean;legacyAvailable:boolean}};
 assert.equal(metadata.runtimeModules.enrollment,false);assert.equal(metadata.runtimeModules.limiter,'warming_up');assert.equal(metadata.runtimeModules.publication,false);assert.equal(metadata.runtimeModules.legacyAvailable,false);
 for(const [path,verb,expected] of [['/me/blocks','GET','extension'],['/groups/x/posts','POST','extension'],['/groups/x','GET','parent'],['/board/unknown','POST','board'],['/me/matching','DELETE',null]] as const)assert.equal(communityNamespace(path,verb),expected);
 assert.equal(requiresTextPort('/groups/x/me/sharing','PATCH'),false);
});
test('bounded real limiter persists consumed failed attempts across rollback/session churn and permits privacy paths during cooldown',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d),[a]=await users(server);let mono=0;
 const db=server.db,bindings={assertActive:(actor:typeof a.actor)=>assertActive(db,actor),withActiveWrite:<T>(actor:typeof a.actor,effect:()=>T)=>withActiveWrite(db,actor,effect),adultEligibility:(actor:typeof a.actor)=>adultEligibility(db,actor)};
 const limiter=new CommunityLimiter(bindings,()=>mono);
 assert.throws(()=>limiter.consume(a.actor,'invitation_attempt'));assert.equal((await request(server,'/v1/community/me/matching/cancel',a,'POST',{expectedRevision:0},'privacy')).status,200);
 mono=60000;for(let i=0;i<actionLimits.invitation_attempt;i++)assert.throws(()=>db.transaction(()=>{limiter.consume(a.actor,'invitation_attempt');throw new Error('synthetic failed preview');}).immediate());
 assert.throws(()=>limiter.consume(a.actor,'invitation_attempt'));
 mono=119999;assert.throws(()=>limiter.consume(a.actor,'invitation_attempt'));mono=120000;limiter.consume(a.actor,'invitation_attempt');
 mono=119999;assert.throws(()=>limiter.consume(a.actor,'reaction'));mono=180000;assert.throws(()=>limiter.consume(a.actor,'reaction'));
});
test('all action limits, bounded capacity, session-independent keys and restart cooldown use monotonic policy',()=>{
 let mono=0;const actor={accountId:'synthetic',authUserId:'auth',sessionId:'one',epoch:0};
 const lifecycle={assertActive:()=>{},withActiveWrite:<T>(_actor:typeof actor,effect:()=>T)=>effect(),adultEligibility:()=>({policy:'self_reported_adult_v1' as const,status:'eligible' as const,profileRevision:1})};
 const limiter=new CommunityLimiter(lifecycle,()=>mono);mono=60000;
 for(const [action,limit] of Object.entries(actionLimits)) {for(let i=0;i<limit;i++)limiter.consume(actor,action as keyof typeof actionLimits);assert.throws(()=>limiter.consume({...actor,sessionId:'new'},action as keyof typeof actionLimits));}
 const capacity=new CommunityLimiter(lifecycle,()=>mono);mono+=60000;for(let i=0;i<4096;i++)capacity.consume({...actor,accountId:`account-${i}`},'post');assert.throws(()=>capacity.consume({...actor,accountId:'overflow'},'post'));mono+=60000;capacity.consume({...actor,accountId:'overflow'},'post');
 const restart=new CommunityLimiter(lifecycle,()=>mono);assert.throws(()=>restart.consume(actor,'post'));mono+=59999;assert.throws(()=>restart.consume(actor,'post'));mono++;restart.consume(actor,'post');
});
test('no-save images and derivatives rejected before body/read/hash/receipt; underage cancels without positive social rights',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d),[a]=await users(server);
 assert.equal((await request(server,'/v1/me/profile',a,'PATCH',{expectedRevision:(await (await request(server,'/v1/me/profile',a)).json() as {revision:number}).revision,age:17})).status,200);
 assert.equal((await request(server,'/v1/community/me/matching/cancel',a,'POST',{expectedRevision:0},'minor-cancel')).status,200);
 assert.equal((await request(server,'/v1/community/board/features',a,'POST',boardInput,'minor-submit')).status,403);
 let pulls=0;const stream=new ReadableStream<Uint8Array>({pull(){pulls++;throw new Error('originals or derivatives must not be read');}},{highWaterMark:0});
 const before=server.db.prepare('SELECT count(*) n FROM command_receipts').get();
 try{assert.equal((await server.handleRequest(new Request(origin+'/v1/body/operations/save_assessment',{method:'POST',headers:{origin,authorization:`Bearer ${a.token}`},body:stream,duplex:'half'} as RequestInit&{duplex:'half'}),'synthetic')).status,501);assert.equal(pulls,0);assert.deepEqual(server.db.prepare('SELECT count(*) n FROM command_receipts').get(),before);}finally{await stream.cancel();}
});

test('source-only missing-limiter fixture denies B2 while actual B4 cancellation and pending board stay useful',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d,{missingLimiterSynthetic:true}),[a]=await users(server);
 assert.equal((await request(server,'/v1/community/groups',a)).status,503);
 assert.equal((await request(server,'/v1/community/me/matching/cancel',a,'POST',{expectedRevision:0},'cancel')).status,200);
 assert.equal((await request(server,'/v1/community/board/features',a,'POST',boardInput,'board')).status,201);
});
test('actual B2 failed token preview call site consumes the same limiter across SQLite rollback and receipt replay',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d,{textSynthetic:true}),[a]=await users(server);
 for(let i=0;i<10;i++)assert.equal((await request(server,'/v1/community/invitations/preview',a,'POST',{token:'A'.repeat(43)},'same-replayed-key')).status,404);
 const rejected=await request(server,'/v1/community/invitations/preview',a,'POST',{token:'A'.repeat(43)},'same-replayed-key');assert.equal(rejected.status,429);
 assert.equal((server.db.prepare('SELECT count(*) n FROM community_command_receipts').get() as {n:number}).n,0);
});
test('absent real text denies existing positive enrollment replay while all-false B4 privacy remains available to a minor',async t=>{
 const d=await deployment(t);await provision(d);const first=await start(d,{textSynthetic:true}),[a]=await users(first.server);
 const groupResponse=await request(first.server,'/v1/community/groups',a,'POST',{name:'Synthetic group',alias:'Owner',membershipDisclosureAccepted:true},'group');assert.equal(groupResponse.status,201);const group=await groupResponse.json() as {id:string};
 const enrollment={expectedRevision:0,preferences:{alias:'Owner',intent:'accountability',language:'en',goals:['consistency'],region:null,location:'anywhere',priorities:['location','goals'],relax:{broaderRegion:false,mixedGoals:false},willingHost:true,fillExistingGroups:false,membershipDisclosureAccepted:true,policyVersion:'community-v1'}};
 assert.equal((await request(first.server,'/v1/community/me/matching/enroll',a,'POST',enrollment,'enrollment-replay')).status,200);
 await first.server.close();const {server}=await start(d);
 assert.equal((await request(server,'/v1/community/me/matching/enroll',a,'POST',enrollment,'enrollment-replay')).status,503);
 const profile=await (await request(server,'/v1/me/profile',a)).json() as {revision:number};assert.equal((await request(server,'/v1/me/profile',a,'PATCH',{expectedRevision:profile.revision,age:17})).status,200);
 assert.equal((await request(server,`/v1/community/groups/${group.id}/me/profile-sharing`,a,'PATCH',{expectedRevision:0,flags:{age:false,sex:false,region:false,avatar:false,adherence:false,ranking:false},sexDescription:null,region:null,avatar:null,audiencePreviewAccepted:true},'privacy')).status,200);
 assert.equal((await request(server,`/v1/community/groups/${group.id}/me/profile-sharing`,a,'PATCH',{expectedRevision:1,flags:{age:false,sex:true,region:false,avatar:false,adherence:false,ranking:false},sexDescription:'Sensitive alias',region:null,avatar:null,audiencePreviewAccepted:true},'positive-text')).status,503);
});
