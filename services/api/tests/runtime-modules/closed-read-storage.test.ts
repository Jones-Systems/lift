import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { backupAndVerify, integrity, openStorage } from '../../src/storage.js';
import { AuthorityLock, canonicalPath, fileDigest } from '../../src/runtime-modules/files.js';
import { readClosedReceipts, assertStrictClosedMain, withClosedStorageSnapshot } from '../../src/runtime-modules/closed-read.js';
import { operateClosedStorage } from '../../src/runtime-modules/storage-operations.js';
import { runtimeMigrations, migrationDigests } from '../../src/runtime-modules/migrations.js';
import { deployment, provision, start, readAdmission } from './fixture.js';
function messages(error:unknown):string{return error instanceof AggregateError?[error.message,...error.errors.map(messages)].join('\n'):error instanceof Error?error.message:String(error);}
function inventory(lock:AuthorityLock):string[]{return readdirSync(lock.lockPath).filter(name=>name.startsWith('.closed-read-'));}
function source(path:string){return {identity:canonicalPath(path,process.getuid!()),digest:fileDigest(path,process.getuid!()),mode:lstatSync(path,{bigint:true}).mode,header:[...readFileSync(path).subarray(18,20)]};}
async function synthetic(t:TestContext){
  const root=mkdtempSync(join(homedir(),'.form-closed-storage-test-'));chmodSync(root,0o700);t.diagnostic(`closed-storage synthetic scratch cleanup owner: ${root}`);
  const handles=new Set<Database.Database>();let removed=false;
  const cleanup=()=>{if(removed)return;const errors:unknown[]=[];for(const db of handles)if(db.open)try{db.close();}catch(error){errors.push(error);}
    try{rmSync(root,{recursive:true,force:true});removed=true;}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Synthetic closed-storage cleanup failed');};
  t.after(cleanup);const interrupted=()=>{try{cleanup();}finally{process.exitCode=130;}},terminated=()=>{try{cleanup();}finally{process.exitCode=143;}};
  process.once('SIGINT',interrupted);process.once('SIGTERM',terminated);t.after(()=>{process.off('SIGINT',interrupted);process.off('SIGTERM',terminated);});
  const path=join(root,'main.sqlite'),{db}=await openStorage(path,runtimeMigrations);handles.add(db);db.close();assertStrictClosedMain(path);
  const directory=join(root,'authority');mkdirSync(directory,{mode:0o700});const lock=new AuthorityLock(directory,process.getuid!(),randomUUID());
  return {root,path,lock,expected:canonicalPath(path,lock.uid),digest:fileDigest(path,lock.uid),handles};
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

test('closed storage actual check and backup preserve exact16/FK, source and admission while leaving no snapshot',async t=>{
  const d=await deployment(t);await provision(d);const runtime=await start(d);await runtime.server.close();const before=source(d.path);
  const admissionPath=join(d.configuration.authorityDirectory,'admission.json'),admissionBytes=readFileSync(admissionPath),witnessBytes=readFileSync(join(d.configuration.authorityDirectory,'currentness.json'));
  await operateClosedStorage({configuration:d.configuration,mainPath:d.path,expectedClosedDigest:before.digest,action:'check'});
  assert.deepEqual(source(d.path),before);assertStrictClosedMain(d.path);assert.equal(existsSync(join(d.configuration.authorityDirectory,'owner.lock')),false);
  const destination=join(dirname(d.path),'backups','closed-storage-positive.sqlite');
  await operateClosedStorage({configuration:d.configuration,mainPath:d.path,expectedClosedDigest:before.digest,action:'backup',destination});
  assert.deepEqual(source(d.path),before);assertStrictClosedMain(d.path);assert.deepEqual(readFileSync(admissionPath),admissionBytes);assert.deepEqual(readFileSync(join(d.configuration.authorityDirectory,'currentness.json')),witnessBytes);
  assert.equal(existsSync(join(d.configuration.authorityDirectory,'owner.lock')),false);assert.equal(lstatSync(destination).mode&0o777,0o600);
  const backup=new Database(destination,{readonly:true,fileMustExist:true});try{integrity(backup);assert.deepEqual((backup.prepare('SELECT checksum FROM form_migrations ORDER BY version').all() as {checksum:string}[]).map(row=>row.checksum),migrationDigests);}finally{backup.close();}
});

test('closed storage no-overwrite backup failure preserves destination, closed source and unchanged admission with held lock',async t=>{
  const d=await deployment(t);await provision(d);const runtime=await start(d);await runtime.server.close();const before=source(d.path),admission=readAdmission(d);
  const destination=join(dirname(d.path),'backups','existing-sentinel.sqlite');writeFileSync(destination,'synthetic existing destination',{mode:0o600});const ino=lstatSync(destination,{bigint:true}).ino;
  await assert.rejects(()=>operateClosedStorage({configuration:d.configuration,mainPath:d.path,expectedClosedDigest:before.digest,action:'backup',destination}),error=>messages(error).includes('new absolute destination'));
  assert.equal(readFileSync(destination,'utf8'),'synthetic existing destination');assert.equal(lstatSync(destination,{bigint:true}).ino,ino);
  assert.deepEqual(source(d.path),before);assertStrictClosedMain(d.path);assert.deepEqual(readAdmission(d),admission);
  const lockPath=join(d.configuration.authorityDirectory,'owner.lock');assert.ok(existsSync(join(lockPath,'owner.json')));assert.deepEqual(readdirSync(lockPath).filter(name=>name.startsWith('.closed-read-')),[]);
});

for(const outcome of ['success','failure'] as const)test(`async snapshot keeps source descriptor, connection, lock and snapshot through awaited ${outcome}`,async t=>{
  const f=await synthetic(t),before=source(f.path),gate=deferred(),primary=new Error('synthetic awaited storage failure');let borrowed:Database.Database|undefined,snapshot='';
  const pending=withClosedStorageSnapshot(f.lock,f.path,f.expected,f.digest,async db=>{
    borrowed=db;f.handles.add(db);snapshot=db.name;assert.equal(db.readonly,true);integrity(db);await gate.promise;
    assert.ok(db.open);assert.ok(existsSync(snapshot));f.lock.assert();
    if(outcome==='failure')throw primary;
    const destination=join(f.root,'backups','awaited.sqlite');await backupAndVerify(db,destination);return destination;
  });
  // Observe the pending seam deterministically; no process, timer or sleep is involved.
  assert.ok(borrowed?.open);assert.ok(snapshot.startsWith(f.lock.lockPath+'/'));assert.ok(existsSync(snapshot));assert.equal(inventory(f.lock).length,1);
  assert.throws(()=>new AuthorityLock(f.lock.directory,f.lock.uid,randomUUID()));assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest),/active or held/);
  assert.deepEqual(source(f.path),before);assertStrictClosedMain(f.path);gate.resolve();
  if(outcome==='failure')await assert.rejects(pending,error=>error===primary);else assert.ok(existsSync(await pending));
  assert.equal(borrowed!.open,false);assert.deepEqual(inventory(f.lock),[]);assert.deepEqual(source(f.path),before);assertStrictClosedMain(f.path);f.lock.assert();
  if(outcome==='success')f.lock.release();else assert.throws(()=>readClosedReceipts(f.lock,f.path,f.expected,f.digest),/active or held/);
});

test('awaited primary failure plus cleanup failure retain both and exact scratch; connection still closes',async t=>{
  const f=await synthetic(t),primary=new Error('synthetic async primary'),cleanup=new Error('synthetic async cleanup');let db:Database.Database|undefined;
  await assert.rejects(()=>withClosedStorageSnapshot(f.lock,f.path,f.expected,f.digest,async borrowed=>{db=borrowed;f.handles.add(borrowed);await Promise.resolve();throw primary;},point=>{if(point==='closed-read:cleanup')throw cleanup;}),error=>error instanceof AggregateError&&error.errors.includes(primary)&&error.errors.includes(cleanup));
  assert.equal(db!.open,false);assert.equal(inventory(f.lock).length,1);assertStrictClosedMain(f.path);f.lock.assert();
});

test('source sidecar inserted during awaited operation holds and is preserved after snapshot cleanup',async t=>{
  const f=await synthetic(t),gate=deferred();let borrowed:Database.Database|undefined;
  const pending=withClosedStorageSnapshot(f.lock,f.path,f.expected,f.digest,async db=>{borrowed=db;f.handles.add(db);await gate.promise;});
  const sidecar=f.path+'-wal';symlinkSync(join(f.root,'missing-sidecar-target'),sidecar);const ino=lstatSync(sidecar,{bigint:true}).ino;gate.resolve();
  await assert.rejects(pending);assert.equal(borrowed!.open,false);assert.equal(lstatSync(sidecar,{bigint:true}).ino,ino);assert.ok(lstatSync(sidecar).isSymbolicLink());assert.deepEqual(inventory(f.lock),[]);f.lock.assert();
});

test('awaited cooperative deadline expiration closes owned connection and removes only its snapshot',async t=>{
  const f=await synthetic(t);let now=0,borrowed:Database.Database|undefined;
  await assert.rejects(()=>withClosedStorageSnapshot(f.lock,f.path,f.expected,f.digest,async db=>{borrowed=db;f.handles.add(db);await Promise.resolve();now=2;},undefined,{maxMs:1,now:()=>now}),error=>messages(error).includes('cooperative budget'));
  assert.equal(borrowed!.open,false);assert.deepEqual(inventory(f.lock),[]);assertStrictClosedMain(f.path);f.lock.assert();
});

for(const damage of ['receipts','foreign-key'] as const)test(`actual closed storage retains exact ${damage} rejection on a damaged synthetic checkpoint`,async t=>{
  const d=await deployment(t);await provision(d);const runtime=await start(d);await runtime.server.close();
  const db=new Database(d.path,{fileMustExist:true});try{
    if(damage==='receipts')db.prepare('UPDATE form_migrations SET checksum=? WHERE version=13').run('a'.repeat(64));
    else {db.pragma('foreign_keys=OFF');db.prepare('INSERT INTO form_accounts VALUES(?,?,?)').run('synthetic-orphan','absent-synthetic-user',new Date().toISOString());}
  }finally{db.close();}assertStrictClosedMain(d.path);
  // Exact negative fixture: alter only the closed digest of the real-produced checkpoint to reach deeper validation.
  // No readiness boolean, fake authority or fabricated migration is used to satisfy a positive assertion.
  const admissionPath=join(d.configuration.authorityDirectory,'admission.json'),value=readAdmission(d),digest=fileDigest(d.path,d.configuration.ownerUid);
  writeFileSync(admissionPath,JSON.stringify({...value,closedDigest:digest})+'\n');const before=source(d.path),admissionBytes=readFileSync(admissionPath);
  await assert.rejects(()=>operateClosedStorage({configuration:d.configuration,mainPath:d.path,expectedClosedDigest:digest,action:'check'}),error=>messages(error).includes(damage==='receipts'?'migration history':'integrity verification'));
  assert.deepEqual(source(d.path),before);assertStrictClosedMain(d.path);assert.deepEqual(readFileSync(admissionPath),admissionBytes);
  const lockPath=join(d.configuration.authorityDirectory,'owner.lock');assert.ok(existsSync(join(lockPath,'owner.json')));assert.deepEqual(readdirSync(lockPath).filter(name=>name.startsWith('.closed-read-')),[]);
});
