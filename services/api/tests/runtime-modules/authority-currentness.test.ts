import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { RuntimeOwner } from '../../src/runtime-modules/admission.js';
import { CurrentSuppressionAuthority, advanceHead, canonicalDisable, genesisHead, ledgerSchemaDigest, witnessSchema } from '../../src/runtime-modules/currentness.js';
import { AuthorityLock, JsonFile } from '../../src/runtime-modules/files.js';
import { deployment, provision } from './fixture.js';
const input={accountId:'synthetic-a',authUserId:'synthetic-auth-a',epoch:1,requestId:'synthetic-request-a',disabledAtMs:1234};

test('frozen hash encoding includes all record fields, authority and schema domain',()=>{
 const record={...input,sequence:1};assert.equal(canonicalDisable(record),'[1,"synthetic-a","synthetic-auth-a",1,"synthetic-request-a",1234]');
 const genesis=genesisHead('00000000-0000-4000-8000-000000000000');assert.equal(genesis,'57c1efcc3129bb5ecf2e7ffa6f5b51c51af94e18ccd78c59b7223fbfe86ab28c');assert.equal(advanceHead(genesis,record),'db8f806d39b6ef346c89d87ca7ec30434da9591b0b9dc52de23edb8f910bbb3b');
 assert.notEqual(advanceHead(genesis,record),advanceHead(genesis,{...record,disabledAtMs:1235}));assert.equal(ledgerSchemaDigest,'70562240d37a78566417389506b69310d212b6f7cb4d8037d7e7af2c16124d26');
});
for(const name of ['ledger.sqlite','currentness.json','admission.json'])test(`missing ${name} is not recreated`,async t=>{
 const d=await deployment(t);await provision(d);const path=join(d.configuration.authorityDirectory,name);unlinkSync(path);
 assert.throws(()=>new RuntimeOwner(d.configuration,d.path));assert.throws(()=>readFileSync(path));
});
test('exclusive owner prevents parallel API and storage ownership',async t=>{
 const d=await deployment(t);await provision(d);const owner=new RuntimeOwner(d.configuration,d.path);assert.throws(()=>new RuntimeOwner(d.configuration,d.path));owner.close(false);
});
test('preserved independent witness rejects internally valid older ledger restored in-place',async t=>{
 const d=await deployment(t);await provision(d);const directory=d.configuration.authorityDirectory,path=join(directory,'ledger.sqlite');const old=readFileSync(path);
 const lock=new AuthorityLock(directory,d.configuration.ownerUid,randomUUID());const witness=new JsonFile(join(directory,'currentness.json'),d.configuration.ownerUid,witnessSchema);
 const authority=new CurrentSuppressionAuthority(lock,witness,path,d.configuration.authorityId);t.after(()=>authority.close());authority.recordDisable(input);authority.close();lock.release();
 writeFileSync(path,old);const next=new AuthorityLock(directory,d.configuration.ownerUid,randomUUID());
 assert.throws(()=>new CurrentSuppressionAuthority(next,new JsonFile(join(directory,'currentness.json'),d.configuration.ownerUid,witnessSchema),path,d.configuration.authorityId));
});
test('same-sequence changed record chain is rejected at reopen',async t=>{
 const d=await deployment(t);await provision(d);const dir=d.configuration.authorityDirectory,path=join(dir,'ledger.sqlite');const lock=new AuthorityLock(dir,d.configuration.ownerUid,randomUUID());
 const authority=new CurrentSuppressionAuthority(lock,new JsonFile(join(dir,'currentness.json'),d.configuration.ownerUid,witnessSchema),path,d.configuration.authorityId);t.after(()=>authority.close());authority.recordDisable(input);authority.close();lock.release();
 const db=new Database(path);try{db.exec('DROP TRIGGER suppression_immutable');db.prepare('UPDATE suppression_records SET disabled_at_ms=1235').run();db.exec("CREATE TRIGGER suppression_immutable BEFORE UPDATE ON suppression_records BEGIN SELECT RAISE(ABORT,'suppression_immutable'); END;");}finally{db.close();}
 const next=new AuthorityLock(dir,d.configuration.ownerUid,randomUUID());assert.throws(()=>new CurrentSuppressionAuthority(next,new JsonFile(join(dir,'currentness.json'),d.configuration.ownerUid,witnessSchema),path,d.configuration.authorityId));
});
for(const trigger of ['suppression_retained','suppression_immutable','suppression_sequence','suppression_authority_retained'])test(`missing ${trigger} fails exact schema admission`,async t=>{
 const d=await deployment(t);await provision(d);const db=new Database(join(d.configuration.authorityDirectory,'ledger.sqlite'));try{db.exec(`DROP TRIGGER ${trigger}`);}finally{db.close();}assert.throws(()=>new RuntimeOwner(d.configuration,d.path));
});
for(const point of ['pending-witness:before-write','pending-witness:before-fsync','pending-witness:after-fsync','pending-witness:after-rename','pending-witness:after-directory-fsync','ledger:before-commit','ledger:after-commit','settled-witness:before-write','settled-witness:before-fsync','settled-witness:after-fsync','settled-witness:after-rename','settled-witness:after-directory-fsync'])test(`synthetic exception at ${point} fences owner and preserves reserved floor`,async t=>{
 const d=await deployment(t);await provision(d);const dir=d.configuration.authorityDirectory,path=join(dir,'ledger.sqlite');const lock=new AuthorityLock(dir,d.configuration.ownerUid,randomUUID());
 const fault=(p:string)=>{if(p===point)throw new Error('synthetic fault, not power-loss qualification');};
 const authority=new CurrentSuppressionAuthority(lock,new JsonFile(join(dir,'currentness.json'),d.configuration.ownerUid,witnessSchema,fault),path,d.configuration.authorityId,fault);
 t.after(()=>authority.close());assert.throws(()=>authority.recordDisable(input));assert.throws(()=>authority.currentSequence());authority.close();lock.release();
 const witness=JSON.parse(readFileSync(join(dir,'currentness.json'),'utf8')) as {committedSequence:number;pending:unknown};
 const next=new AuthorityLock(dir,d.configuration.ownerUid,randomUUID());
 if(['ledger:after-commit','settled-witness:before-write','settled-witness:before-fsync','settled-witness:after-fsync','settled-witness:after-rename','settled-witness:after-directory-fsync'].includes(point)) {
  const reopened=new CurrentSuppressionAuthority(next,new JsonFile(join(dir,'currentness.json'),d.configuration.ownerUid,witnessSchema),path,d.configuration.authorityId);t.after(()=>reopened.close());assert.equal(reopened.lookup(input.accountId)?.sequence,1);reopened.close();
 } else if(witness.pending) assert.throws(()=>new CurrentSuppressionAuthority(next,new JsonFile(join(dir,'currentness.json'),d.configuration.ownerUid,witnessSchema),path,d.configuration.authorityId));
 else {const reopened=new CurrentSuppressionAuthority(next,new JsonFile(join(dir,'currentness.json'),d.configuration.ownerUid,witnessSchema),path,d.configuration.authorityId);t.after(()=>reopened.close());assert.equal(reopened.currentSequence(),0);reopened.close();}
});
test('externally changed witness/inode fences live requests and exact repeat includes timestamp',async t=>{
 const d=await deployment(t);await provision(d);const dir=d.configuration.authorityDirectory,path=join(dir,'ledger.sqlite');const lock=new AuthorityLock(dir,d.configuration.ownerUid,randomUUID());
 const authority=new CurrentSuppressionAuthority(lock,new JsonFile(join(dir,'currentness.json'),d.configuration.ownerUid,witnessSchema),path,d.configuration.authorityId);
 t.after(()=>authority.close());const first=authority.recordDisable(input);assert.deepEqual(authority.recordDisable(input),first);assert.throws(()=>authority.recordDisable({...input,disabledAtMs:1235}));
 const witness=join(dir,'currentness.json'),bytes=readFileSync(witness);renameSync(witness,witness+'.old');writeFileSync(witness,bytes,{mode:0o600});assert.throws(()=>authority.currentSequence());authority.close();
});
for(const mutation of ['unsafe','duplicate','mode','identity'])test(`strict witness rejects ${mutation}`,async t=>{
 const d=await deployment(t);await provision(d);const path=join(d.configuration.authorityDirectory,'currentness.json');const value=JSON.parse(readFileSync(path,'utf8'));
 if(mutation==='mode')chmodSync(path,0o644);else if(mutation==='duplicate')writeFileSync(path,'{"version":1,"version":1}');else{if(mutation==='unsafe')value.committedSequence=Number.MAX_SAFE_INTEGER+1;else value.authorityId=randomUUID();writeFileSync(path,JSON.stringify(value));}
 assert.throws(()=>new RuntimeOwner(d.configuration,d.path));
});
