import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareRelocatedAdmission, RuntimeOwner, type PrepareRelocatedAdmissionInput } from '../../src/runtime-modules/admission.js';
import { operateClosedStorage } from '../../src/runtime-modules/storage-operations.js';
import { canonicalPath, fileDigest, JsonFile } from '../../src/runtime-modules/files.js';
import { witnessSchema } from '../../src/runtime-modules/currentness.js';
import { migrationDigests } from '../../src/runtime-modules/migrations.js';
import { deployment, provision, start } from './fixture.js';
import type { TestContext } from 'node:test';

async function fixture(t:TestContext) {
  const d=await deployment(t); await provision(d); const running=await start(d); await running.server.close();
  const backups=join(d.root,'backups','relocation-test'); mkdirSync(backups,{mode:0o700});
  const backup=join(backups,'snapshot.sqlite');
  const manifest=await operateClosedStorage({configuration:d.configuration,mainPath:d.path,
    expectedClosedDigest:fileDigest(d.path,d.configuration.ownerUid),action:'backup',destination:backup});
  const destination=join(d.root,'relocated.sqlite'), admissionPath=join(d.configuration.authorityDirectory,'admission.json');
  const input:PrepareRelocatedAdmissionInput={configuration:d.configuration,mainPath:d.path,
    expectedMain:canonicalPath(d.path,d.configuration.ownerUid),expectedRevision:manifest.admissionRevision,
    expectedGeneration:manifest.databaseGeneration,expectedPredecessorDigest:manifest.source.digest,
    backupPath:backup,expectedBackupDigest:manifest.backup!.digest,destination,operationId:randomUUID(),
    provenance:'synthetic closed snapshot',oldWriterStopped:true};
  const source=readFileSync(d.path), admission=readFileSync(admissionPath);
  const unchanged=()=>{assert.deepEqual(readFileSync(d.path),source);assert.deepEqual(canonicalPath(d.path,d.configuration.ownerUid),input.expectedMain);
    assert.deepEqual(readFileSync(admissionPath),admission);};
  return {d,input,manifest,admissionPath,source,unchanged};
}

test('closed manifest and relocated admission bind exact source, backup, runtime and current authority',async t=>{
  const f=await fixture(t),{d,input,manifest}=f;
  assert.equal(manifest.encryption,'none_held');assert.equal(manifest.offhost,'none_held');
  assert.equal(manifest.authorityId,d.configuration.authorityId);assert.deepEqual(manifest.migrationDigests,migrationDigests);
  assert.equal(manifest.backup!.digest,fileDigest(input.backupPath,d.configuration.ownerUid));
  const next=prepareRelocatedAdmission(input);
  assert.equal(next.state,'prepared_restore');assert.equal(next.mainPath,input.destination);
  assert.equal(next.revision,input.expectedRevision+1);assert.equal(next.databaseGeneration,input.expectedGeneration+1);
  assert.equal(next.suppressionSequence,manifest.suppressionSequence);assert.equal(next.suppressionHead,manifest.suppressionHead);
  assert.equal(statSync(input.destination).mode&0o777,0o600);assert.equal(statSync(d.root).mode&0o777,0o700);
  assert.deepEqual(readFileSync(d.path),f.source);assert.deepEqual(canonicalPath(d.path,d.configuration.ownerUid),input.expectedMain);
  d.path=input.destination;const restored=await start(d);assert.equal(restored.owner.fullBarrier,true);await restored.server.close();
  // Failed provenance admission keeps custody held; there is no fallback to the former main.
  assert.throws(()=>new RuntimeOwner(d.configuration,input.mainPath),/Unknown main provenance/);
});

for(const kind of ['exists','source','authority','revision','generation','identity','source-digest','backup-digest','foreign-parent'] as const)
 test(`relocation rejects ${kind} before admission changes`,async t=>{
  const f=await fixture(t),input={...f.input};
  if(kind==='exists')writeFileSync(input.destination,'foreign',{mode:0o600});
  if(kind==='source')input.destination=input.mainPath;
  if(kind==='authority')input.destination=join(input.configuration.authorityDirectory,'foreign.sqlite');
  if(kind==='revision')input.expectedRevision++;
  if(kind==='generation')input.expectedGeneration++;
  if(kind==='identity')input.expectedMain={...input.expectedMain,inode:'0'};
  if(kind==='source-digest')input.expectedPredecessorDigest='0'.repeat(64);
  if(kind==='backup-digest')input.expectedBackupDigest='0'.repeat(64);
  if(kind==='foreign-parent'){const parent=join(f.d.root,'foreign');mkdirSync(parent,{mode:0o755});input.destination=join(parent,'main.sqlite');}
  assert.throws(()=>prepareRelocatedAdmission(input));f.unchanged();
  if(kind==='exists')assert.equal(readFileSync(input.destination,'utf8'),'foreign');
  assert.equal(existsSync(join(input.configuration.authorityDirectory,'owner.lock')),false);
 });

for(const kind of ['corrupt','schema7','schema23','wrong-checksum','foreign-key'] as const)
 test(`relocation rejects ${kind} backup and permits a fresh isolated attempt`,async t=>{
  const f=await fixture(t),bad=join(f.d.root,'bad.sqlite');copyFileSync(f.input.backupPath,bad);
  if(kind==='corrupt')writeFileSync(bad,'not a database');
  else {const db=new Database(bad);try {
    db.pragma('journal_mode = DELETE');
    if(kind==='schema7')db.prepare('DELETE FROM form_migrations WHERE version>7').run();
    if(kind==='schema23')for(let version=migrationDigests.length+1;version<=23;version++)db.prepare('INSERT INTO form_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(version,'0'.repeat(64),new Date().toISOString());
    if(kind==='wrong-checksum')db.prepare('UPDATE form_migrations SET checksum=? WHERE version=1').run('0'.repeat(64));
    if(kind==='foreign-key'){db.pragma('foreign_keys=OFF');db.exec('CREATE TABLE synthetic_parent(id INTEGER PRIMARY KEY); CREATE TABLE synthetic_child(parent INTEGER REFERENCES synthetic_parent(id)); INSERT INTO synthetic_child VALUES(1)');}
  }finally{db.close();}}
  chmodSync(bad,0o600);
  assert.throws(()=>prepareRelocatedAdmission({...f.input,backupPath:bad,expectedBackupDigest:fileDigest(bad,f.d.configuration.ownerUid)}));
  f.unchanged();assert.equal(existsSync(f.input.destination),true);
  const next=prepareRelocatedAdmission({...f.input,destination:join(f.d.root,'second-attempt.sqlite'),operationId:randomUUID()});
  assert.equal(next.state,'prepared_restore');assert.deepEqual(readFileSync(f.input.mainPath),f.source);
 });

for(const kind of ['missing-ledger','missing-witness','corrupt-ledger','wrong-ledger-schema','stale-witness','pending-witness'] as const)
 test(`relocation rejects ${kind} without a new authority or admission`,async t=>{
  const f=await fixture(t),directory=f.input.configuration.authorityDirectory;
  if(kind==='missing-ledger'||kind==='missing-witness'){
    const path=join(directory,kind==='missing-ledger'?'ledger.sqlite':'currentness.json');renameSync(path,path+'.preserved');
  }else if(kind==='corrupt-ledger'){
    writeFileSync(join(directory,'ledger.sqlite'),'corrupt independent ledger');
  }else if(kind==='wrong-ledger-schema'){
    const db=new Database(join(directory,'ledger.sqlite'));try{db.exec('CREATE TABLE unexpected_authority_table(id TEXT)');}finally{db.close();}
  }else{
    const file=new JsonFile(join(directory,'currentness.json'),f.input.configuration.ownerUid,witnessSchema),value=file.read();
    file.replace(kind==='stale-witness'?{...value,committedSequence:value.committedSequence+1}:
      {...value,pending:{sequence:1,priorHeadDigest:value.committedHeadDigest,nextHeadDigest:'0'.repeat(64),recordDigest:'0'.repeat(64),operationId:randomUUID()}},'synthetic-witness');
  }
  assert.throws(()=>prepareRelocatedAdmission(f.input));f.unchanged();assert.equal(existsSync(f.input.destination),false);
 });

test('precommit failure preserves admission and source; a new destination can retry',async t=>{
  const f=await fixture(t);
  assert.throws(()=>prepareRelocatedAdmission(f.input,point=>{if(point==='relocation:before-commit')throw new Error('synthetic precommit');}),/synthetic precommit/);
  f.unchanged();assert.equal(existsSync(join(f.input.configuration.authorityDirectory,'owner.lock')),false);
  prepareRelocatedAdmission({...f.input,destination:join(f.d.root,'retry.sqlite'),operationId:randomUUID()});
});

test('postcommit failure retains lock and committed admission as an unknown outcome',async t=>{
  const f=await fixture(t);
  assert.throws(()=>prepareRelocatedAdmission(f.input,point=>{if(point==='relocated-admission:after-rename')throw new Error('synthetic postcommit');}),/synthetic postcommit/);
  assert.deepEqual(readFileSync(f.input.mainPath),f.source);
  const value=JSON.parse(readFileSync(f.admissionPath,'utf8')) as {mainPath:string;state:string};
  assert.equal(value.mainPath,f.input.destination);assert.equal(value.state,'prepared_restore');
  assert.equal(existsSync(join(f.input.configuration.authorityDirectory,'owner.lock')),true);
  assert.throws(()=>prepareRelocatedAdmission({...f.input,destination:join(f.d.root,'forbidden-retry.sqlite')}));
});


for (const point of ['closed-read:cleanup', 'closed-read:after-close'] as const)
 test(`relocation preserves intact owner evidence when snapshot settlement fails at ${point}`, async t => {
  const f=await fixture(t); let reached=false;
  assert.throws(()=>prepareRelocatedAdmission(f.input, current=>{
    if(current===point){reached=true;throw new Error('synthetic snapshot settlement failure');}
  }));
  assert.equal(reached,true); f.unchanged();
  const lockPath=join(f.input.configuration.authorityDirectory,'owner.lock');
  assert.equal(existsSync(lockPath),true); assert.equal(existsSync(join(lockPath,'owner.json')),true);
  const owner=JSON.parse(readFileSync(join(lockPath,'owner.json'),'utf8')) as {nonce:string;operationId:string};
  assert.equal(owner.operationId,f.input.operationId); assert.match(owner.nonce,/^[0-9a-f-]{36}$/);
  assert.equal(readdirSync(lockPath).some(name=>name.startsWith('.closed-read-')),point==='closed-read:cleanup');
  assert.throws(()=>new RuntimeOwner(f.input.configuration,f.input.mainPath));
 });
