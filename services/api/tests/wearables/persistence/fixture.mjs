import Database from 'better-sqlite3';
import { assertActive,bindSuppressionAuthority,withActiveWrite } from '../../../src/lifecycle/guards.ts';
import { createWearablesService } from '../../../src/wearables/service.ts';
import { createWearablePersistence,createWearableLifecycleAdapter,wearablePersistenceSql } from '../../../src/wearables/persistence/index.ts';
export const a={accountId:'a',authUserId:'user-a',sessionId:'session-a',epoch:0};
export const b={accountId:'b',authUserId:'user-b',sessionId:'session-b',epoch:0};
export const connection={id:'hk',provider:'healthkit',generation:1,connected:true,types:['steps'],consentVersion:'synthetic',retentionConsent:true,lastImportAt:null};
export const complete={category:'external-wearables',inventory:()=>({status:'complete',count:0}),export:()=>({status:'complete',count:0}),
  suppress:()=>({status:'complete'}),purge:()=>({status:'complete'}),verifySuppressed:()=>({status:'complete'})};
export function fixture(t,overrides={}){
  const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys=ON');
  // Only columns consumed by canonical guards are fixture-owned; no aggregate migration or activation.
  db.exec(`CREATE TABLE form_accounts(id TEXT PRIMARY KEY,auth_user_id TEXT NOT NULL UNIQUE);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE account_lifecycle(account_id TEXT PRIMARY KEY REFERENCES form_accounts(id),state TEXT NOT NULL,epoch INTEGER NOT NULL);`);
  for(const ctx of [a,b]){
    db.prepare('INSERT INTO form_accounts VALUES(?,?)').run(ctx.accountId,ctx.authUserId);
    db.prepare('INSERT INTO session VALUES(?,?,?)').run(ctx.sessionId,ctx.authUserId,Date.now()+3600000);
    db.prepare("INSERT INTO account_lifecycle VALUES(?,'active',0)").run(ctx.accountId);
  }
  db.exec(wearablePersistenceSql);
  const ledger=new Map();let writer=null,permitted=true;
  bindSuppressionAuthority(db,{currentSequence:()=>ledger.size,lookup:id=>ledger.get(id)??null,reconcileRestore:apply=>{for(const value of ledger.values())apply(value);return ledger.size;},recordDisable:value=>{ledger.set(value.accountId,value);return value;}});
  const write=(ctx,effect)=>withActiveWrite(db,ctx,()=>{const prior=writer;writer=ctx;try{return effect();}finally{writer=prior;}});
  const control={assertWithinWrite(ctx){if(!writer||['accountId','authUserId','sessionId','epoch'].some(key=>writer[key]!==ctx[key]))throw Error('writer_witness_required');},
    assertSuppression(id,epoch){if(ledger.get(id)?.epoch!==epoch)throw Error('suppression_required');},
    purgeReadiness(request,id){const record=ledger.get(id);return record?.requestId===request?{status:'ready',epoch:record.epoch}:{status:'unavailable',reason:'request_not_bound'};}};
  const deps={db,control,lifecycle:{assertActive:ctx=>assertActive(db,ctx),withActiveWrite:write,adultEligibility:()=>({policy:'self_reported_adult_v1',status:'eligible',profileRevision:1})},
    assertImportAllowed(){if(!permitted)throw Error('no_save_or_consent');},externalLifecycle:complete,externalConnectionPurge:()=>({status:'complete'}),...overrides};
  const persistence=createWearablePersistence(deps),store=persistence.store;
  const service=createWearablesService({store,enabled:()=>true,now:()=> '2026-10-11T00:00:00Z',assertActive:deps.lifecycle.assertActive,withActiveWrite:write,assertImportAllowed:deps.assertImportAllowed});
  for(const ctx of [a,b])write(ctx,()=>store.putConnection(ctx,connection));
  return {db,deps,store,service,write,ledger,providerIntent:persistence.providerIntent,healthKitCheckpoint:persistence.healthKitCheckpoint,adapter:createWearableLifecycleAdapter(deps),
    setPermitted:value=>permitted=value,disable(ctx,requestId='delete-a'){ledger.set(ctx.accountId,{accountId:ctx.accountId,authUserId:ctx.authUserId,epoch:ctx.epoch+1,requestId});}};
}
export function record(){return {id:'day',metric:'steps',value:123,unit:'count',start:'2026-10-09T00:00:00Z',end:'2026-10-10T00:00:00Z',day:'2026-10-09',zone:'UTC',aggregation:'sum',
  source:{bundleId:'synthetic',name:'Synthetic',device:null,algorithm:null,originalId:null},revision:{token:'r1',order:1},quality:'complete'};}
export function page(overrides={}){return {version:1,connectionId:'hk',generation:1,stream:'steps',fromCursor:null,nextCursor:'private-cursor',pageId:'page',batch:[record()],tombstones:[],...overrides};}
