import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { backupAndVerify } from '../../src/storage.js';
import { prepareAdmission, RuntimeOwner } from '../../src/runtime-modules/admission.js';
import { fileDigest } from '../../src/runtime-modules/files.js';
import { lifecyclePolicy } from '../../src/lifecycle/service.js';
import { populateCommunity } from './community-fixture.js';
import { usefulActivity } from './http-fixture.js';
import { deployment, provision, start, users, request, login, emails, password, readAdmission, origin } from './fixture.js';
import {disable} from './lifecycle-fixture.js';
test('mainDB-only populated backup replays full canonical and Community barrier before any traffic; old sessions/grants stay revoked',async t=>{
 const d=await deployment(t);await provision(d);const first=await start(d,{publicSynthetic:true,textSynthetic:true}),[a,b]=await users(first.server);
 await usefulActivity(first.server,a);const population=await populateCommunity(first.server,a,b);
 const exportGrant=await request(first.server,'/v1/me/account-action-grants',b,'POST',{purpose:'account_export',password});assert.equal(exportGrant.status,201);
 first.server.db.prepare('INSERT INTO verification VALUES(?,?,?,?,?,?)').run(randomUUID(),'reset-password-synthetic','synthetic-old-ticket',Date.now()+600000,Date.now(),Date.now());
 const backup=join(d.root,'pre-disable.sqlite');await backupAndVerify(first.server.db,backup);
 const disabled=await disable(first.server,a);assert.equal(disabled.response.status,200);assert.equal(first.owner.ledger.currentSequence(),1);
 assert.equal((await request(first.server,'/v1/me',a)).status,401);assert.equal((await request(first.server,'/v1/me',b)).status,200);
 await first.server.close();const predecessor=readAdmission(d);writeFileSync(d.path,readFileSync(backup));
 prepareAdmission({configuration:d.configuration,mainPath:d.path,mode:'restore',operationId:randomUUID(),expectedRevision:predecessor.revision as number,
  expectedGeneration:predecessor.databaseGeneration as number,expectedPredecessorDigest:predecessor.closedDigest as string,expectedCandidateDigest:fileDigest(d.path,d.configuration.ownerUid),reason:'synthetic-main-only-restore',provenance:'exact task-owned backup',oldWriterStopped:true});
 const second=await start(d);const db=second.server.db;
 for(const table of ['session','account_action_grants','verification','community_command_receipts','community_extension_receipts','community_post_cursors','community_profile_shares','community_ballots','community_board_command_receipts'])assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0,table);
 assert.equal((db.prepare('SELECT state FROM account_lifecycle WHERE account_id=?').get(a.actor.accountId) as {state:string}).state,'disabled');
 assert.equal((db.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(population.board.id) as {visibility:string}).visibility,'hidden');
 assert.equal((db.prepare('SELECT count(*) n FROM community_board_votes WHERE active=1').get() as {n:number}).n,0);
 assert.equal((db.prepare("SELECT count(*) n FROM community_posts WHERE state<>'hidden' OR text IS NOT NULL").get() as {n:number}).n,0);
 assert.equal((db.prepare('SELECT count(*) n FROM community_reactions WHERE active=1').get() as {n:number}).n,0);
 assert.equal((db.prepare("SELECT count(*) n FROM community_motions WHERE state='open'").get() as {n:number}).n,0);
 assert.equal((db.prepare("SELECT count(*) n FROM community_seat_reservations WHERE state='available'").get() as {n:number}).n,0);
 assert.equal((db.prepare("SELECT count(*) n FROM community_match_runs WHERE state='frozen'").get() as {n:number}).n,0);
 assert.equal((db.prepare("SELECT count(*) n FROM community_match_enrollments WHERE state='queued' OR preferences IS NOT NULL").get() as {n:number}).n,0);
 assert.equal((db.prepare('SELECT count(*) n FROM community_motion_electorate WHERE active=1').get() as {n:number}).n,0);
 assert.equal((await request(second.server,'/v1/me',a)).status,401);assert.equal((await request(second.server,'/v1/me',b)).status,401);
 await assert.rejects(()=>login(second.server,emails[0]));assert.throws(()=>second.server.lifecycle!.status(disabled.requestId,disabled.statusSecret));const freshB=await login(second.server,emails[1]);assert.equal((await request(second.server,'/v1/me',freshB)).status,200);
 assert.equal((db.prepare('SELECT count(*) n FROM activity_entries WHERE account_id=?').get(a.actor.accountId) as {n:number}).n,1);
});
test('main failure after committed ledger cannot remove disable; clean subsequent suppression replay reconciles',async t=>{
 const d=await deployment(t);await provision(d);const first=await start(d,{publicSynthetic:true}),[a,b]=await users(first.server);
 first.server.db.exec("CREATE TRIGGER synthetic_main_failure BEFORE UPDATE ON account_lifecycle BEGIN SELECT RAISE(ABORT,'synthetic-main-failure'); END;");
 const result=await disable(first.server,a);assert.equal(result.response.status,503);assert.equal(first.owner.ledger.lookup(a.actor.accountId)?.epoch,1);
 assert.equal((await request(first.server,'/v1/me',a)).status,403);assert.equal((await request(first.server,'/v1/me',b)).status,200);
 first.server.db.exec('DROP TRIGGER synthetic_main_failure');await first.server.close();const second=await start(d);
 assert.equal((second.server.db.prepare('SELECT state FROM account_lifecycle WHERE account_id=?').get(a.actor.accountId) as {state:string}).state,'disabled');
});
test('unclean ordinary restart and wrong predecessor hold; exact offline recovery requires prior nonce then full barrier',async t=>{
 const d=await deployment(t);await provision(d);const first=await start(d);await users(first.server);await first.server.close(false);
 assert.throws(()=>new RuntimeOwner(d.configuration,d.path));const predecessor=readAdmission(d);
 const lock=JSON.parse(readFileSync(join(d.configuration.authorityDirectory,'owner.lock','owner.json'),'utf8')) as {nonce:string;operationId:string};
 const input={configuration:d.configuration,mainPath:d.path,mode:'recovery' as const,operationId:randomUUID(),expectedRevision:predecessor.revision as number,
  expectedGeneration:predecessor.databaseGeneration as number,expectedPredecessorDigest:predecessor.closedDigest as string,expectedCandidateDigest:fileDigest(d.path,d.configuration.ownerUid),reason:'synthetic unclean close',provenance:'task-owned exact stopped main',oldWriterStopped:true as const,priorLock:lock};
 assert.throws(()=>prepareAdmission({...input,expectedGeneration:999}));prepareAdmission(input);const second=await start(d);
 assert.equal((second.server.db.prepare('SELECT count(*) n FROM session').get() as {n:number}).n,0);
});
test('account-absent restore remains held and never manufactures an identity',async t=>{
 const d=await deployment(t);await provision(d);const initialBackup=readFileSync(d.path);const first=await start(d,{publicSynthetic:true}),[a]=await users(first.server);assert.equal((await disable(first.server,a)).response.status,200);
 await first.server.close();const predecessor=readAdmission(d);writeFileSync(d.path,initialBackup);
 prepareAdmission({configuration:d.configuration,mainPath:d.path,mode:'restore',operationId:randomUUID(),expectedRevision:predecessor.revision as number,expectedGeneration:predecessor.databaseGeneration as number,
  expectedPredecessorDigest:predecessor.closedDigest as string,expectedCandidateDigest:fileDigest(d.path,d.configuration.ownerUid),reason:'synthetic absent account restore',provenance:'exact pre-account schema7 snapshot',oldWriterStopped:true});
 await assert.rejects(()=>start(d),error=>error instanceof Error && error.message.includes('restore_account_absent_unqualified'));
 const check=new Database(d.path,{readonly:true});try{assert.equal((check.prepare('SELECT count(*) n FROM form_accounts').get() as {n:number}).n,0);}finally{check.close();}
});
for(const kind of ['unknown-owner','excluded-pair','subjects','runs','snapshot-bytes','single-snapshot-bytes','malformed'])test(`full real-derived Community admission holds ${kind} without rescuing work`,async t=>{
 const d=await deployment(t);await provision(d);const first=await start(d,{textSynthetic:true}),[a,b]=await users(first.server);const populated=await populateCommunity(first.server,a,b),db=first.server.db;
 if(kind==='unknown-owner')db.prepare('INSERT INTO community_blocks VALUES(?,?,?,1,1,?)').run(randomUUID(),'unmapped-owner',b.actor.accountId,new Date().toISOString());
 if(kind==='excluded-pair')db.prepare('UPDATE community_match_runs SET snapshot=? WHERE id=?').run(JSON.stringify({intent:'accountability',language:'en',candidates:[],exclusionsKnown:true,exclusionGeneration:1,excludedPairs:[['unmapped-owner',a.actor.accountId]]}),populated.run);
 if(kind==='subjects')for(let i=0;i<1001;i++)db.prepare('INSERT INTO community_blocks VALUES(?,?,?,1,1,?)').run(randomUUID(),`unmapped-${i}`,b.actor.accountId,new Date().toISOString());
 if(kind==='runs'||kind==='snapshot-bytes') {const row=db.prepare('SELECT * FROM community_match_runs WHERE id=?').get(populated.run) as Record<string,unknown>;
  for(let i=0;i<(kind==='runs'?201:6);i++)db.prepare('INSERT INTO community_match_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.policy_version,row.zone,`synthetic-${i}`,row.intent,row.language,row.policy,row.input_digest,kind==='runs'?row.snapshot:JSON.stringify({payload:'x'.repeat(400000)}),row.state,randomUUID(),row.created_at,null);
 }
 if(kind==='single-snapshot-bytes'){db.pragma('ignore_check_constraints=ON');try{db.prepare('UPDATE community_match_runs SET snapshot=? WHERE id=?').run(JSON.stringify({payload:'x'.repeat(524289)}),populated.run);}finally{db.pragma('ignore_check_constraints=OFF');}}
 if(kind==='malformed')db.prepare("UPDATE community_match_runs SET snapshot='{}'").run();
 await first.server.close();const predecessor=readAdmission(d);prepareAdmission({configuration:d.configuration,mainPath:d.path,mode:'recovery',operationId:randomUUID(),expectedRevision:predecessor.revision as number,
  expectedGeneration:predecessor.databaseGeneration as number,expectedPredecessorDigest:predecessor.closedDigest as string,expectedCandidateDigest:fileDigest(d.path,d.configuration.ownerUid),reason:'synthetic full barrier check',provenance:'exact task-owned candidate',oldWriterStopped:true});
 await assert.rejects(()=>start(d));const check=new Database(d.path,{readonly:true});try{assert.ok((check.prepare('SELECT count(*) n FROM session').get() as {n:number}).n>0);assert.equal((check.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(populated.board.id) as {visibility:string}).visibility,'pending');}finally{check.close();}
});
