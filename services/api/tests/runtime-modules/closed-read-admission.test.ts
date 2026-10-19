import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { openStorage, migrations, integrity } from '../../src/storage.js';
import { AuthorityLock, canonicalPath, fileDigest } from '../../src/runtime-modules/files.js';
import { readClosedReceipts, assertStrictClosedMain } from '../../src/runtime-modules/closed-read.js';
import { initializeAuthority, prepareAdmission, RuntimeOwner } from '../../src/runtime-modules/admission.js';
import { ledgerSchemaDigest } from '../../src/runtime-modules/currentness.js';
import { migrationDigests, runtimeMigrations } from '../../src/runtime-modules/migrations.js';
import { deployment, provision, start, readAdmission } from './fixture.js';

import { activityMigration } from '../../src/activity/migration.js';
import { communityMigration } from '../../src/community/migration.js';
import { communityExtensionMigration } from '../../src/community/extension-migration.js';
import { featureBoardMigrationVersion, featureBoardMigrationSql } from '../../src/community/board/migration.js';
import { lifecycleMigration } from '../../src/lifecycle/migration.js';
import { mascotPreferencesMigration } from '../../src/lifecycle/preferences-migration.js';
import { usageMigrationVersion, usageMigrationSql } from '../../src/usage-limits/migration.js';
import { bugIntakeMigrationSql } from '../../src/bug-intake/migration.js';

const historical13 = [...migrations, activityMigration, communityMigration, lifecycleMigration,
  mascotPreferencesMigration, communityExtensionMigration, { version: featureBoardMigrationVersion, sql: featureBoardMigrationSql }];
const historical15 = [...historical13, { version: usageMigrationVersion, sql: usageMigrationSql },
  { version: 15, sql: bugIntakeMigrationSql }];

function messages(error: unknown): string {
  return error instanceof AggregateError ? [error.message,...error.errors.map(messages)].join('\n') : error instanceof Error ? error.message : String(error);
}
function unchanged(path: string) {
  return {identity:canonicalPath(path,process.getuid!()),mode:lstatSync(path,{bigint:true}).mode,digest:fileDigest(path,process.getuid!()),header:[...readFileSync(path).subarray(18,20)]};
}
function ownedDescriptors(root: string): string[] {
  const result:string[]=[];
  for(const entry of readdirSync('/proc/self/fd')) {
    try { const path=readlinkSync(`/proc/self/fd/${entry}`);if(path.startsWith(root+'/'))result.push(path); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
  }
  return result;
}
function noScratch(lockPath: string): void {
  if(existsSync(lockPath)) assert.deepEqual(readdirSync(lockPath).filter(name=>name.startsWith('.closed-read-')),[]);
}
function snapshotPath(lock: AuthorityLock): string {
  const names=readdirSync(lock.lockPath).filter(name=>name.startsWith('.closed-read-'));assert.equal(names.length,1);return join(lock.lockPath,names[0]!);
}
async function synthetic(t: TestContext, selected = migrations) {
  const root=mkdtempSync(join(homedir(),'.form-closed-read-test-'));chmodSync(root,0o700);
  t.diagnostic(`closed-read synthetic scratch cleanup owner: ${root}`);
  const handles=new Set<Database.Database>();let removed=false;
  const cleanup=()=>{if(removed)return;const errors:unknown[]=[];for(const db of handles)if(db.open)try{db.close();}catch(error){errors.push(error);}
    try{rmSync(root,{recursive:true,force:true});removed=true;}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Synthetic closed-read cleanup failed');};
  t.after(cleanup);
  const interrupted=()=>{try{cleanup();}finally{process.exitCode=130;}},terminated=()=>{try{cleanup();}finally{process.exitCode=143;}};
  process.once('SIGINT',interrupted);process.once('SIGTERM',terminated);t.after(()=>{process.off('SIGINT',interrupted);process.off('SIGTERM',terminated);});
  const parent=join(root,'main');mkdirSync(parent,{mode:0o700});const path=join(parent,'main.sqlite');
  const {db}=await openStorage(path,selected);handles.add(db);db.close();assertStrictClosedMain(path);
  const directory=join(root,'authority');mkdirSync(directory,{mode:0o700});const lock=new AuthorityLock(directory,process.getuid!(),randomUUID());
  const expected=canonicalPath(path,lock.uid),digest=fileDigest(path,lock.uid);
  return {root,path,lock,expected,digest,handles};
}

test('closed WAL actual7 initializes, upgrades through16, clean closes and restarts without real read sidecars',async t=>{
  const d=await deployment(t);await d.seed.close();const before=unchanged(d.path);assert.deepEqual(before.header,[2,2]);
  initializeAuthority({configuration:d.configuration,mainPath:d.path,expectedMainDigest:before.digest,operationId:randomUUID(),expectedAbsence:true,expectedSchemaDigest:ledgerSchemaDigest});
  assert.deepEqual(unchanged(d.path),before);assertStrictClosedMain(d.path);assert.equal(readAdmission(d).state,'prepared_initial');
  assert.equal(existsSync(join(d.configuration.authorityDirectory,'owner.lock')),false);
  const first=await start(d);assert.deepEqual((first.server.db.prepare('SELECT checksum FROM form_migrations ORDER BY version').all() as {checksum:string}[]).map(row=>row.checksum),migrationDigests);integrity(first.server.db);
  assert.equal(readAdmission(d).state,'running');await first.server.close();assertStrictClosedMain(d.path);const closed=unchanged(d.path);
  assert.deepEqual(closed.identity,before.identity);assert.equal(closed.mode,before.mode);assert.deepEqual(closed.header,before.header);assert.equal(readAdmission(d).closedDigest,closed.digest);
  const owner=new RuntimeOwner(d.configuration,d.path);assert.deepEqual(unchanged(d.path),closed);noScratch(join(d.configuration.authorityDirectory,'owner.lock'));
  owner.beforeOpen(d.path);assert.deepEqual(unchanged(d.path),closed);owner.close(false);
  // The separately owned lifetime deliberately retains an opening hold after close(false).
  assert.equal(readAdmission(d).state,'opening');assert.ok(existsSync(join(d.configuration.authorityDirectory,'owner.lock')));
});

test('actual clean restart reaches clean close again with exact16 receipts',async t=>{
  const d=await deployment(t);await provision(d);const first=await start(d);await first.server.close();const before=unchanged(d.path);
  const second=await start(d);assert.equal(second.owner.fullBarrier,false);assert.deepEqual((second.server.db.prepare('SELECT checksum FROM form_migrations ORDER BY version').all() as {checksum:string}[]).map(row=>row.checksum),migrationDigests);
  await second.server.close();assertStrictClosedMain(d.path);assert.deepEqual(unchanged(d.path).identity,before.identity);assert.deepEqual(unchanged(d.path).header,before.header);
  assert.equal(readAdmission(d).closedDigest,fileDigest(d.path,d.configuration.ownerUid));assert.equal(existsSync(join(d.configuration.authorityDirectory,'owner.lock')),false);
});

for(const mode of ['restore','recovery'] as const)test(`exact prepared closed ${mode} retains current authority and adds no read sidecars`,async t=>{
  const d=await deployment(t);await provision(d);const first=await start(d);await first.server.close(mode==='restore');
  const predecessor=readAdmission(d),before=unchanged(d.path);
  const priorLock=mode==='recovery'?JSON.parse(readFileSync(join(d.configuration.authorityDirectory,'owner.lock','owner.json'),'utf8')) as {nonce:string;operationId:string}:undefined;
  prepareAdmission({configuration:d.configuration,mainPath:d.path,mode,operationId:randomUUID(),expectedRevision:predecessor.revision as number,expectedGeneration:predecessor.databaseGeneration as number,
    expectedPredecessorDigest:predecessor.closedDigest as string,expectedCandidateDigest:before.digest,reason:'synthetic closed preparation',provenance:'exact task-owned actual16 candidate',oldWriterStopped:true,...(priorLock?{priorLock}:{})});
  assertStrictClosedMain(d.path);assert.deepEqual(unchanged(d.path),before);assert.equal(readAdmission(d).state,`prepared_${mode}`);
  assert.equal(readAdmission(d).databaseGeneration,(predecessor.databaseGeneration as number)+1);assert.equal(existsSync(join(d.configuration.authorityDirectory,'owner.lock')),false);
  const second=await start(d);assert.equal(second.owner.fullBarrier,true);await second.server.close();assertStrictClosedMain(d.path);
});

test('initial receipt failure occurs under exclusive lock and preserves partial initialization without publication',async t=>{
  const d=await deployment(t);d.seed.db.prepare('DELETE FROM form_migrations WHERE version=7').run();await d.seed.close();const before=unchanged(d.path);
  assert.throws(()=>initializeAuthority({configuration:d.configuration,mainPath:d.path,expectedMainDigest:before.digest,operationId:randomUUID(),expectedAbsence:true,expectedSchemaDigest:ledgerSchemaDigest}),error=>messages(error).includes('Migration provenance'));
  assert.ok(existsSync(join(d.configuration.authorityDirectory,'owner.lock','owner.json')));noScratch(join(d.configuration.authorityDirectory,'owner.lock'));
  for(const name of ['ledger.sqlite','currentness.json','admission.json'])assert.equal(existsSync(join(d.configuration.authorityDirectory,name)),false);
  assert.deepEqual(unchanged(d.path),before);assertStrictClosedMain(d.path);
});

test('beforeOpen rejects changed closed bytes after inspection and close(false) cannot record clean success',async t=>{
  const d=await deployment(t);await provision(d);const owner=new RuntimeOwner(d.configuration,d.path);
  const bytes=readFileSync(d.path);bytes[100]=bytes[100]!^1;writeFileSync(d.path,bytes);
  assert.throws(()=>owner.beforeOpen(d.path),/changed before open/);owner.close(false);assert.equal(readAdmission(d).state,'opening');assert.ok(existsSync(join(d.configuration.authorityDirectory,'owner.lock')));
});

for(const suffix of ['-wal','-shm','-journal'])for(const kind of ['empty','nonempty','dangling'])test(`closed read denies real ${suffix} ${kind} without removing it`,async t=>{
  const f=await synthetic(t),sidecar=f.path+suffix;
  if(kind==='dangling')symlinkSync(join(f.root,'missing-target'),sidecar);else writeFileSync(sidecar,kind==='empty'?'':'synthetic-real-sidecar',{mode:0o600});
  const stat=lstatSync(sidecar,{bigint:true});assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest));
  assert.equal(lstatSync(sidecar,{bigint:true}).ino,stat.ino);assert.equal(lstatSync(sidecar).isSymbolicLink(),kind==='dangling');
  if(kind!=='dangling')assert.equal(readFileSync(sidecar,'utf8'),kind==='empty'?'':'synthetic-real-sidecar');noScratch(f.lock.lockPath);f.lock.assert();
});

for(const kind of ['symlink','hardlink','mode','wrong-uid','missing','digest','same-byte-inode','parent-replacement'])test(`closed read holds ${kind} custody mismatch`,async t=>{
  const f=await synthetic(t),saved=join(f.root,'saved.sqlite'),bytes=readFileSync(f.path);
  let expected=f.expected;
  if(kind==='symlink'){renameSync(f.path,saved);symlinkSync(saved,f.path);}
  if(kind==='hardlink')linkSync(f.path,saved);
  if(kind==='mode')chmodSync(f.path,0o644);
  if(kind==='wrong-uid')expected={...expected,uid:expected.uid+1};
  if(kind==='missing')unlinkSync(f.path);
  if(kind==='digest'){bytes[100]=bytes[100]!^1;writeFileSync(f.path,bytes);}
  if(kind==='same-byte-inode'){renameSync(f.path,saved);writeFileSync(f.path,bytes,{mode:0o600});}
  const hook=(point:string)=>{if(kind==='parent-replacement'&&point==='closed-read:source-held'){renameSync(dirname(f.path),join(f.root,'old-main'));mkdirSync(dirname(f.path),{mode:0o700});writeFileSync(f.path,bytes,{mode:0o600});}};
  assert.throws(()=>readClosedReceipts(f.lock,f.path,expected,f.digest,hook));noScratch(f.lock.lockPath);f.lock.assert();
  if(kind==='symlink')assert.ok(lstatSync(f.path).isSymbolicLink());if(kind==='hardlink')assert.equal(lstatSync(f.path).nlink,2);
  if(kind==='mode')assert.equal(lstatSync(f.path).mode&0o777,0o644);if(kind==='missing')assert.equal(existsSync(f.path),false);
});

for(const kind of ['missing-table','gap','under-seven','overflow','checksum','corrupt'])test(`closed snapshot rejects ${kind} without fallback`,async t=>{
  const f=await synthetic(t,kind==='gap'||kind==='overflow'?runtimeMigrations:migrations);
  if(kind==='corrupt')writeFileSync(f.path,Buffer.from('synthetic corrupt SQLite image'),{mode:0o600});
  else {const db=new Database(f.path,{fileMustExist:true});f.handles.add(db);
    if(kind==='missing-table')db.exec('DROP TABLE form_migrations');if(kind==='gap')db.prepare('DELETE FROM form_migrations WHERE version=4').run();
    if(kind==='under-seven')db.prepare('DELETE FROM form_migrations WHERE version=7').run();
    if(kind==='overflow')db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(17,'a'.repeat(64),'synthetic');
    if(kind==='checksum')db.prepare('UPDATE form_migrations SET checksum=? WHERE version=4').run('a'.repeat(64));db.close();}
  const before=unchanged(f.path);assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,before.digest));assert.deepEqual(unchanged(f.path),before);assertStrictClosedMain(f.path);noScratch(f.lock.lockPath);
});

for(const point of ['allocated','copy','copied-chunk','before-open','inspection','after-close','cleanup'])test(`synchronous ${point} fault preserves source, closes handles and holds success`,async t=>{
  const f=await synthetic(t),before=unchanged(f.path),opened:Database.Database[]=[];
  const close=Database.prototype.close;t.mock.method(Database.prototype,'close',function(this:Database.Database){assert.notEqual(this.name,f.path);opened.push(this);return close.call(this);});
  const fault=new Error(`synthetic-${point}`);
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest,label=>{if(label===`closed-read:${point}`)throw fault;}),error=>messages(error).includes(fault.message));
  for(const db of opened)assert.equal(db.open,false);assert.deepEqual(ownedDescriptors(f.root),[]);assert.deepEqual(unchanged(f.path),before);assertStrictClosedMain(f.path);f.lock.assert();
  if(point==='cleanup')assert.equal(readdirSync(f.lock.lockPath).filter(name=>name.startsWith('.closed-read-')).length,1);else noScratch(f.lock.lockPath);
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest),/active or held/);
});

test('primary inspection and cleanup failures survive together; unknown child is retained exactly',async t=>{
  const f=await synthetic(t),before=unchanged(f.path),primary=new Error('synthetic-primary');let unknown='';
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest,point=>{
    if(point==='closed-read:inspection'){unknown=join(snapshotPath(f.lock),'foreign-sentinel');writeFileSync(unknown,'retained synthetic sentinel',{mode:0o600});throw primary;}
  }),error=>error instanceof AggregateError&&error.errors.includes(primary)&&messages(error).includes(unknown));
  assert.equal(readFileSync(unknown,'utf8'),'retained synthetic sentinel');assert.ok(existsSync(join(dirname(unknown),'main.sqlite')));
  assert.deepEqual(unchanged(f.path),before);assertStrictClosedMain(f.path);f.lock.assert();
});

for(const phase of ['before-open','before-final'])for(const kind of ['sidecar','replacement','mode','bytes'])test(`race ${phase}/${kind} cannot bless changed source`,async t=>{
  const f=await synthetic(t),bytes=readFileSync(f.path);let fired=false;
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest,point=>{if(fired||point!==`closed-read:${phase}`)return;fired=true;
    if(kind==='sidecar')symlinkSync(join(f.root,'missing'),f.path+'-wal');
    if(kind==='replacement'){renameSync(f.path,join(f.root,'original.sqlite'));writeFileSync(f.path,bytes,{mode:0o600});}
    if(kind==='mode')chmodSync(f.path,0o644);if(kind==='bytes'){bytes[100]=bytes[100]!^1;writeFileSync(f.path,bytes);}
  }));assert.ok(fired);noScratch(f.lock.lockPath);f.lock.assert();if(kind==='sidecar')assert.ok(lstatSync(f.path+'-wal').isSymbolicLink());
});

for(const kind of ['short-read','growth'])test(`copy detects ${kind} under held source descriptor`,async t=>{
  const f=await synthetic(t);let fired=false;
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest,point=>{if(point!=='closed-read:copy'||fired)return;fired=true;
    if(kind==='short-read')truncateSync(f.path,0);else writeFileSync(f.path,Buffer.from('growth'),{flag:'a'});
  }));assert.ok(fired);noScratch(f.lock.lockPath);f.lock.assert();
});

for(const kind of ['size','time','clock-regression','raise-size','raise-time'])test(`small injected ${kind} bound holds without large allocation or sleep`,async t=>{
  const f=await synthetic(t),before=unchanged(f.path);let tick=0;
  const bounds=kind==='size'?{maxBytes:1}:kind==='time'?{maxMs:1,now:()=>++tick}:kind==='clock-regression'?{now:()=>-(++tick)}:kind==='raise-size'?{maxBytes:1024*1024*1024+1}:{maxMs:30001};
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest,undefined,bounds));assert.deepEqual(unchanged(f.path),before);noScratch(f.lock.lockPath);f.lock.assert();
});

test('repeated snapshots are independent, byte-identical, and never open real source in SQLite',async t=>{
  const f=await synthetic(t),before=unchanged(f.path),closed:Database.Database[]=[];
  const close=Database.prototype.close;t.mock.method(Database.prototype,'close',function(this:Database.Database){assert.notEqual(this.name,f.path);assert.ok(this.name.startsWith(f.lock.lockPath+'/'));assert.equal(this.readonly,true);closed.push(this);return close.call(this);});
  for(let i=0;i<3;i++){assert.deepEqual(readClosedReceipts(f.lock,f.path,f.expected,f.digest),migrationDigests.slice(0,7));noScratch(f.lock.lockPath);assert.deepEqual(unchanged(f.path),before);assertStrictClosedMain(f.path);}
  assert.equal(closed.length,3);for(const db of closed)assert.equal(db.open,false);assert.deepEqual(ownedDescriptors(f.root),[]);assert.equal(new Set(closed.map(db=>db.name)).size,3);f.lock.release();assert.equal(existsSync(f.lock.lockPath),false);
});

test('foreign structural/released lock and retained prior snapshot are denied without removing another invocation sentinel',async t=>{
  const f=await synthetic(t);assert.throws(()=>readClosedReceipts({assert:()=>{}} as AuthorityLock,f.path,f.expected,f.digest),/actual authority lock/);
  const prior=join(f.lock.lockPath,'.closed-read-prior-synthetic');mkdirSync(prior,{mode:0o700});writeFileSync(join(prior,'sentinel'),'another invocation',{mode:0o600});
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest),error=>messages(error).includes(prior));assert.equal(readFileSync(join(prior,'sentinel'),'utf8'),'another invocation');
  const second=await synthetic(t);second.lock.release();assert.throws(()=>readClosedReceipts(second.lock,second.path,second.expected,second.digest),/closed/);assert.ok(existsSync(prior));
});

test('clean-close inspection failure retains running admission and lock instead of publishing closed_clean',async t=>{
  const d=await deployment(t);await provision(d);let armed=false,closedSource:ReturnType<typeof unchanged>|undefined;
  const runtime=await start(d,{fault:point=>{if(armed&&point==='closed-read:inspection'){closedSource=unchanged(d.path);throw new Error('synthetic close inspection failure');}}});
  armed=true;await assert.rejects(async()=>runtime.server.close(),error=>messages(error).includes('synthetic close inspection failure'));
  assert.equal(runtime.server.db.open,false);assert.equal(readAdmission(d).state,'running');assert.ok(closedSource);assert.deepEqual(unchanged(d.path),closedSource);
  assertStrictClosedMain(d.path);const lockPath=join(d.configuration.authorityDirectory,'owner.lock');assert.ok(existsSync(join(lockPath,'owner.json')));noScratch(lockPath);
});

for(const kind of ['main-replacement','directory-replacement','uncaptured-sidecar','unknown-link'])test(`cleanup retains unproved ${kind} and never returns receipts`,async t=>{
  const f=await synthetic(t),before=unchanged(f.path);let retained='';
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest,point=>{if(point!=='closed-read:cleanup')return;const scratch=snapshotPath(f.lock);
    if(kind==='main-replacement'){const path=join(scratch,'main.sqlite'),bytes=readFileSync(path);renameSync(path,join(scratch,'old-main.sqlite'));writeFileSync(path,bytes,{mode:0o600});retained=path;}
    if(kind==='directory-replacement'){renameSync(scratch,join(f.lock.lockPath,'saved-snapshot'));mkdirSync(scratch,{mode:0o700});retained=join(scratch,'foreign-sentinel');writeFileSync(retained,'retained',{mode:0o600});}
    if(kind==='uncaptured-sidecar'){retained=join(scratch,'main.sqlite-journal');writeFileSync(retained,'retained',{mode:0o600});}
    if(kind==='unknown-link'){retained=join(scratch,'foreign-link');symlinkSync(join(f.root,'missing'),retained);}
  }));assert.ok(retained);lstatSync(retained);assert.deepEqual(unchanged(f.path),before);assertStrictClosedMain(f.path);f.lock.assert();
});

test('clean close cannot downgrade stored actual16 migration provenance to a shorter valid prefix',async t=>{
  const d=await deployment(t);await provision(d);const runtime=await start(d);
  runtime.server.db.prepare('DELETE FROM form_migrations WHERE version=16').run();
  await assert.rejects(async()=>runtime.server.close(),error=>messages(error).includes('receipts changed before clean close'));
  assert.equal(readAdmission(d).state,'running');assert.equal((readAdmission(d).appliedDigests as unknown[]).length,16);assertStrictClosedMain(d.path);
  const lockPath=join(d.configuration.authorityDirectory,'owner.lock');assert.ok(existsSync(join(lockPath,'owner.json')));noScratch(lockPath);
});

for(const kind of ['nonempty-wal','shm-bound'])test(`snapshot ${kind} is a checked acceptance bound, source remains closed and retained cleanup cannot succeed`,async t=>{
  const f=await synthetic(t),before=unchanged(f.path);let sidecar='';
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest,point=>{if(point!=='closed-read:after-close')return;
    sidecar=join(snapshotPath(f.lock),kind==='nonempty-wal'?'main.sqlite-wal':'main.sqlite-shm');
    if(!existsSync(sidecar))writeFileSync(sidecar,'',{mode:0o600});if(kind==='nonempty-wal')writeFileSync(sidecar,'x');else truncateSync(sidecar,1024*1024+1);
  }),error=>messages(error).includes(kind==='nonempty-wal'?'Nonempty snapshot WAL':'sidecar bound'));
  assert.ok(existsSync(sidecar));assert.deepEqual(unchanged(f.path),before);assertStrictClosedMain(f.path);assert.deepEqual(ownedDescriptors(f.root),[]);f.lock.assert();
});

test('uncertain native close effect retains snapshot even when the injected close reports failure after actual closure',async t=>{
  const f=await synthetic(t),primary=new Error('synthetic close reported failure'),close=Database.prototype.close;let db:Database.Database|undefined;
  t.mock.method(Database.prototype,'close',function(this:Database.Database){db=this;close.call(this);throw primary;});
  assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest),error=>messages(error).includes(primary.message)&&messages(error).includes('Unclosed snapshot retained'));
  assert.equal(db!.open,false);assert.equal(readdirSync(f.lock.lockPath).filter(name=>name.startsWith('.closed-read-')).length,1);assert.deepEqual(ownedDescriptors(f.root),[]);assertStrictClosedMain(f.path);f.lock.assert();
});

for(const selected of [historical13,historical15])test(`closed reader accepts genuine historical${selected.length} upgrade input without changing source`,async t=>{
  const f=await synthetic(t,selected),before=unchanged(f.path);
  assert.deepEqual(readClosedReceipts(f.lock,f.path,f.expected,f.digest),migrationDigests.slice(0,selected.length));
  assert.deepEqual(unchanged(f.path),before);assertStrictClosedMain(f.path);noScratch(f.lock.lockPath);f.lock.release();
});
