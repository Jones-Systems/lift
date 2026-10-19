import { CommunityLimiter } from '../../src/runtime-modules/limiter.js';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createServer, type FormServer } from '../../src/server.js';
import { initializeAuthority, RuntimeOwner } from '../../src/runtime-modules/admission.js';
import { ledgerSchemaDigest } from '../../src/runtime-modules/currentness.js';
import { fileDigest, type FaultPoint } from '../../src/runtime-modules/files.js';
import { moduleMigrations } from '../../src/runtime-modules/migrations.js';
import type { RuntimeModulesConfiguration } from '../../src/runtime-modules/configuration.js';
import type { AccountContext } from '../../src/lifecycle/types.js';
export const origin='http://127.0.0.1:47839';
export const password='synthetic-runtime-composition-password-12345';
export const secret='synthetic-runtime-composition-secret-more-than-32-characters';
export const emails=['runtime-one@synthetic.invalid','runtime-two@synthetic.invalid'] as const;
export type User={token:string;actor:AccountContext};
export type Deployment={root:string;path:string;configuration:RuntimeModulesConfiguration;close:()=>void;seed:FormServer};
export async function deployment(t:TestContext):Promise<Deployment> {
  const root=mkdtempSync(join(homedir(),'.form-runtime-composition-test-')); chmodSync(root,0o700);
  t.diagnostic(`ordinal63 synthetic scratch cleanup owner: ${root}`);
  const handles=new Set<FormServer>();
  const close=()=>{const errors:unknown[]=[];for(const handle of handles) { for(const cancel of streamCancellations.get(handle)??[]) {try{cancel();}catch(error){errors.push(error);}} streamCancellations.delete(handle);try{handle.close(false);}catch(error){errors.push(error);} } handles.clear();
    try{rmSync(root,{recursive:true,force:true});}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Synthetic cleanup failed');};
  t.after(close);
  const interrupted=()=>{try{close();}finally{process.exitCode=130;}};
  const terminated=()=>{try{close();}finally{process.exitCode=143;}};
  process.once('SIGINT',interrupted);process.once('SIGTERM',terminated);
  t.after(()=>{process.off('SIGINT',interrupted);process.off('SIGTERM',terminated);});
  const path=join(root,'main.sqlite');
  const seed=await createServer({dbPath:path,baseURL:origin,secret,registration:{mode:'allowlist',emails:[...emails]}}); handles.add(seed);
  const configuration:RuntimeModulesConfiguration={version:1,mode:'private-modules',authorityDirectory:join(root,'authority'),authorityId:randomUUID(),ownerUid:process.getuid!(),publicLifecycle:'disabled',communityLimiter:'bounded-single-process-v1'};
  const result={root,path,configuration,close,seed}; deployments.set(result,handles); return result;
}
const streamCancellations=new WeakMap<FormServer,Set<()=>void>>();
export function registerStreamCancellation(server:FormServer,cancel:()=>void):()=>void {
 let callbacks=streamCancellations.get(server);if(!callbacks){callbacks=new Set();streamCancellations.set(server,callbacks);}callbacks.add(cancel);return ()=>callbacks!.delete(cancel);
}
const deployments=new WeakMap<Deployment,Set<FormServer>>();
export function request(server:FormServer,path:string,user?:User,method='GET',value?:unknown,key?:string):Promise<Response> {
  return Promise.resolve(server.handleRequest(new Request(origin+path,{method,headers:{origin,...(user?{authorization:`Bearer ${user.token}`} : {}),
    ...(value===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}: {})},...(value===undefined?{}:{body:JSON.stringify(value)})}),'127.0.0.1'));
}
export async function login(server:FormServer,email:string,signup=false):Promise<User> {
  const response=await request(server,signup?'/api/auth/sign-up/email':'/api/auth/sign-in/email',undefined,'POST',{email,password,...(signup?{name:'Synthetic runtime'}:{})});
  assert.equal(response.status,200,await response.clone().text()); const token=response.headers.get('set-auth-token');assert.ok(token);
  const me=await request(server,'/v1/me',{token,actor:{} as AccountContext});assert.equal(me.status,200);
  const data=await me.json() as {accountId:string};
  const row=server.db.prepare('SELECT f.auth_user_id authUserId,s.id sessionId FROM form_accounts f JOIN session s ON s.userId=f.auth_user_id WHERE f.id=? ORDER BY s.createdAt DESC LIMIT 1').get(data.accountId) as {authUserId:string;sessionId:string};
  const hasLifecycle=server.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_lifecycle'").get();
  const epoch=hasLifecycle?(server.db.prepare('SELECT epoch FROM account_lifecycle WHERE account_id=?').get(data.accountId) as {epoch:number}|undefined)?.epoch??0:0;
  return {token,actor:Object.freeze({accountId:data.accountId,...row,epoch})};
}
export async function provision(d:Deployment):Promise<void> {
  await d.seed.close();
  initializeAuthority({configuration:d.configuration,mainPath:d.path,expectedMainDigest:fileDigest(d.path,d.configuration.ownerUid),operationId:randomUUID(),expectedAbsence:true,expectedSchemaDigest:ledgerSchemaDigest});
}
export async function start(d:Deployment,options:{publicSynthetic?:boolean;textSynthetic?:boolean;missingLimiterSynthetic?:boolean;fault?:FaultPoint}={}):Promise<{server:FormServer;owner:RuntimeOwner}> {
  const owner=new RuntimeOwner(d.configuration,d.path,options.fault);
  try {
    let server:FormServer;
    if(options.publicSynthetic||options.textSynthetic||options.missingLimiterSynthetic) {
      owner.beforeOpen(d.path);
      // Explicit source-only synthetic positive policy. Never imported by CLI/runtime code.
      let mono=0,limiter:CommunityLimiter|undefined;
      const limited=(actor:AccountContext,action:Parameters<CommunityLimiter['consume']>[1])=>{assert.ok(limiter);limiter.consume(actor,action);};
      server=await createServer({dbPath:d.path,baseURL:origin,secret,registration:{mode:'allowlist',emails:[...emails]},publicStagedLifecycleEnabled:options.publicSynthetic===true,
        moduleMigrations,lifecycle:{ledger:owner.ledger,createAdapters:(_db,bindings)=>{limiter=new CommunityLimiter(bindings,()=>mono);return [];}},sourceRequestFactories:{mode:'source-only',activityCommands:'owner-input',activityProjection:'read-only',communityModules:'b2-b4-b5',...(options.missingLimiterSynthetic?{}:{assertCommunityRateLimit:limited}),
          ...(options.textSynthetic?{communityExtension:{assertRateLimit:limited,textModeration:{policyVersion:'community-v1',checkText:input=>input.text.length<=1000?'allowed':'rejected'}}}:{}),
        }});
      mono=60000;
      owner.attachMain(server.db);assert.ok(server.lifecycle);assert.ok(server.reconcileModulesRestore);
      owner.admit(()=>{server.lifecycle!.reconcileRestore();return server.lifecycle!;},server.reconcileModulesRestore);
      const original=server.close;
      server.close=(clean=true)=>{owner.close(clean);original(false);};
    } else server=await createServer({dbPath:d.path,baseURL:origin,secret,registration:{mode:'allowlist',emails:[...emails]},runtimeOwner:owner});
    deployments.get(d)!.add(server);return {server,owner};
  } catch(error){owner.close(false);throw error;}
}
export async function users(server:FormServer,signup=true):Promise<readonly [User,User]> {
  const a=await login(server,emails[0],signup),b=await login(server,emails[1],signup);
  for(const user of [a,b]) {const profile=await (await request(server,'/v1/me/profile',user)).json() as {revision:number};assert.equal((await request(server,'/v1/me/profile',user,'PATCH',{expectedRevision:profile.revision,age:30})).status,200);}
  return [a,b];
}
export function readAdmission(d:Deployment):Record<string,unknown> {return JSON.parse(readFileSync(join(d.configuration.authorityDirectory,'admission.json'),'utf8')) as Record<string,unknown>;}
export const boardInput={title:'Larger exercise labels',description:'Please offer larger labels for exercise selection.',category:'accessibility',policyVersion:'form_feature_board_v1',policyAccepted:true,audienceAccepted:true};
