import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrations, openStorage, integrity } from '../../src/storage.js';
import { runtimeMigrations, migrationDigests } from '../../src/runtime-modules/migrations.js';
import { deployment, provision, start, users, login, emails, readAdmission } from './fixture.js';

test('populated maintained-auth two-account actual7 upgrades through16 with exact receipts/history and migration backups',async t=>{
 const d=await deployment(t),beforeUsers=await users(d.seed);
 for(const [index,user] of beforeUsers.entries()) {
  const domain=d.seed.domain, account=user.actor.accountId;
  const plan=domain.createPlan(account,{name:`Private ${index}`,minutes:30,items:[{id:`item-${index}`,exerciseId:'floor-press',setTarget:3,repMin:8,repMax:8,targetKg:20}]});
  const session=domain.startSession(account,plan.id,plan.revision);
  const occurrence=(d.seed.db.prepare('SELECT id FROM session_occurrences WHERE account_id=? AND session_id=?').get(account,session.id) as {id:string}).id;
  domain.createSet(account,session.id,{occurrenceId:occurrence,setNumber:1,reps:8,weightKg:20,status:'confirmed',expectedRevision:session.revision});
  d.seed.db.prepare("INSERT INTO apple_purchase_owners VALUES(?,?,?,'Sandbox',1)").run(`owner-${index}`,account,'synthetic.bundle');
  d.seed.db.prepare("INSERT INTO apple_purchase_transactions VALUES(?,?,?,?,?,?,1,1,NULL,NULL,0,?,?,1)").run(`tx-${index}`,`owner-${index}`,account,'synthetic.product','NonConsumable',account,'a'.repeat(64),`PRIVATE-JWS-${index}`);
  d.seed.db.prepare('INSERT INTO apple_purchase_observations VALUES(?,?,?,?,1)').run(`tx-${index}`,'a'.repeat(64),'{}',`PRIVATE-JWS-${index}`);
  d.seed.db.prepare('INSERT INTO apple_purchase_deliveries VALUES(?,?,?,?,?,?,1)').run(`tx-${index}`,'a'.repeat(64),`delivery-${index}`,account,'synthetic.product',`PRIVATE-JWS-${index}`);
  d.seed.db.prepare("INSERT INTO phone_challenges(id,phone,binding_hash,start_key,status,created_at,expires_at,last_send_at,auth_user_id) VALUES(?,?,?,?, 'consumed',1,9999999999999,1,?)").run(`phone-${index}`,`+1555000000${index}`,'synthetic-binding',`phone-key-${index}`,user.actor.authUserId);
 }
 const tables=['apple_purchase_owners','apple_purchase_transactions','apple_purchase_observations','apple_purchase_deliveries','form_accounts','documents','document_revisions','plans','plan_revisions','session_occurrences','performed_sets','set_revisions','phone_challenges','account','user'];
 const before=new Map(tables.map(table=>[table,d.seed.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
 const receipts=d.seed.db.prepare('SELECT * FROM form_migrations ORDER BY version').all();
 await provision(d);const {server}=await start(d);
 for(const table of tables) {
  const after=server.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  if(table==='documents') {for(const row of before.get(table)! as Record<string,unknown>[]) {
   const value=after.find(candidate=>{const next=candidate as Record<string,unknown>;return next.account_id===row.account_id && next.kind===row.kind;}) as Record<string,unknown>;assert.ok(value);
   if(row.kind==='preferences'){const previous=JSON.parse(row.data as string) as Record<string,unknown>,current=JSON.parse(value.data as string) as Record<string,unknown>;for(const [key,expected] of Object.entries(previous))assert.deepEqual(current[key],expected,key);assert.ok((value.revision as number)>=(row.revision as number) && (value.revision as number)<=(row.revision as number)+1);}
   else assert.deepEqual(value,row);
  }} else if(table==='document_revisions')for(const row of before.get(table)! as Record<string,unknown>[])assert.ok(after.some(value=>JSON.stringify(value)===JSON.stringify(row)));
  else assert.deepEqual(after,before.get(table),table);
 }
 assert.deepEqual(server.db.prepare('SELECT * FROM form_migrations WHERE version<=7 ORDER BY version').all(),receipts);
 assert.deepEqual((server.db.prepare('SELECT checksum FROM form_migrations ORDER BY version').all() as {checksum:string}[]).map(r=>r.checksum),migrationDigests);
 assert.equal(server.migrationBackups.length,9);for(const path of server.migrationBackups){const backup=new Database(path,{readonly:true});try{integrity(backup);}finally{backup.close();}}
 assert.equal((server.db.prepare('SELECT count(*) n FROM session').get() as {n:number}).n,0);
 await login(server,emails[0]);await login(server,emails[1]);integrity(server.db);await server.close();
 const restarted=await start(d);assert.deepEqual(restarted.server.migrationBackups,[]);await restarted.server.close();
 await assert.rejects(()=>openStorage(d.path,migrations),/Unknown or modified migration history/);
});
for(const failingVersion of [12,16])test(`real per-migration runner retains earlier commits and backup receipts on step${failingVersion} failure; admission stays held`,async t=>{
 const d=await deployment(t);await provision(d);
 const broken=runtimeMigrations.map(m=>m.version===failingVersion?{...m,sql:m.sql+'\nSELECT synthetic_missing_function();'}:m);
 await assert.rejects(()=>openStorage(d.path,broken));
 const check=new Database(d.path,{readonly:true});try{
  assert.equal((check.prepare('SELECT max(version) version FROM form_migrations').get() as {version:number}).version,failingVersion-1);
  assert.deepEqual((check.prepare('SELECT checksum FROM form_migrations ORDER BY version').all() as {checksum:string}[]).map(row=>row.checksum),migrationDigests.slice(0,failingVersion-1));
  if(failingVersion===16)assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='community_removal_snapshots'").get(),undefined);
  integrity(check);
 }finally{check.close();}
 assert.ok(readdirSync(join(d.root,'backups')).some(p=>p.startsWith(`before-${failingVersion}-`)));
 await assert.rejects(()=>start(d));assert.notEqual(readAdmission(d).state,'closed_clean');
});
test('clean restart retains sharing rather than running restore-wide reset',async t=>{
 const d=await deployment(t);await provision(d);const first=await start(d,{textSynthetic:true}),[a,b]=await users(first.server);
 const {populateCommunity}=await import('./community-fixture.js');await populateCommunity(first.server,a,b);
 const tables=['community_groups','community_share_settings','community_profile_shares','community_board_submissions'];
 const before=new Map(tables.map(table=>[table,first.server.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));await first.server.close();
 const second=await start(d);for(const table of tables)assert.deepEqual(second.server.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),before.get(table));
});
