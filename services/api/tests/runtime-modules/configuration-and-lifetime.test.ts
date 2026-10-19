import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRuntimeModules, strictJson } from '../../src/runtime-modules/configuration.js';
import { RuntimeOwner, initializeAuthority, admissionSchema } from '../../src/runtime-modules/admission.js';
import { ledgerSchemaDigest } from '../../src/runtime-modules/currentness.js';
import { canonicalPath, fileDigest } from '../../src/runtime-modules/files.js';
import { runtimeMigrations } from '../../src/runtime-modules/migrations.js';
import { migrations } from '../../src/storage.js';
import { createServer } from '../../src/server.js';
import { deployment, provision, start, readAdmission, origin, secret } from './fixture.js';

test('omission keeps ordinary7; strict explicit selects actual contiguous16',()=>{
 assert.equal(parseRuntimeModules(undefined),undefined);assert.equal(migrations.length,7);assert.deepEqual(runtimeMigrations.map(m=>m.version),Array.from({length:16},(_,i)=>i+1));
 for(const value of [null,true,'private-modules',{}, {version:1}]) assert.throws(()=>parseRuntimeModules(value));
});
test('duplicate keys, unknown/trailing/oversized JSON and unsafe identities deny',()=>{
 for(const input of ['{"a":1,"a":2}','{"a":{"x":1,"x":2}}','{}x','[1,]','{"a":01}', ' '.repeat(65537)])assert.throws(()=>strictJson(input));
 assert.deepEqual(strictJson('{"a":[1,{"b":true}]}'),{a:[1,{b:true}]});
 const value={version:1,mode:'private-modules',authorityDirectory:'/safe/authority',authorityId:randomUUID(),ownerUid:1000,publicLifecycle:'disabled',communityLimiter:'bounded-single-process-v1'};
 for(const changes of [{unknown:true},{ownerUid:Number.MAX_SAFE_INTEGER+1},{ownerUid:999},{authorityDirectory:'/safe/../authority'},{authorityDirectory:'relative'},{publicLifecycle:'enabled'}])assert.throws(()=>parseRuntimeModules({...value,...changes},true));
});
test('canonical existing paths reject link aliases, mode and UID mismatch',async t=>{
 const d=await deployment(t);await d.seed.close();const alias=join(d.root,'alias.sqlite');symlinkSync(d.path,alias);assert.throws(()=>canonicalPath(alias,d.configuration.ownerUid));unlinkSync(alias);
 linkSync(d.path,alias);assert.throws(()=>canonicalPath(d.path,d.configuration.ownerUid));unlinkSync(alias);
 chmodSync(d.path,0o644);assert.throws(()=>canonicalPath(d.path,d.configuration.ownerUid));chmodSync(d.path,0o600);
 assert.throws(()=>canonicalPath(d.path,d.configuration.ownerUid+1));
});
test('missing main is never recreated; repeated init is exclusive and partial init held',async t=>{
 const d=await deployment(t);await provision(d);assert.throws(()=>initializeAuthority({configuration:d.configuration,mainPath:d.path,expectedMainDigest:fileDigest(d.path,d.configuration.ownerUid),operationId:randomUUID(),expectedAbsence:true,expectedSchemaDigest:ledgerSchemaDigest}));
 unlinkSync(d.path);assert.throws(()=>new RuntimeOwner(d.configuration,d.path));assert.equal(existsSync(d.path),false);
});
test('runtime and raw source injection cannot be mixed; acquired owner is closed as failed',async t=>{
 const d=await deployment(t);await provision(d);const owner=new RuntimeOwner(d.configuration,d.path);
 await assert.rejects(()=>createServer({dbPath:d.path,baseURL:origin,secret,runtimeOwner:owner,publicStagedLifecycleEnabled:true}));
 assert.throws(()=>owner.assert());assert.equal(readAdmission(d).state,'opening');
});
for(const point of ['server:before-open','server:factories','server:auth-schema','server:lifecycle','owner:opening','owner:main','barrier:canonical','barrier:community','barrier:before-commit','barrier:after-commit','running-admission:before-fsync','running-admission:after-rename'])test(`startup acquisition failure ${point} stays nonclean and closes handles`,async t=>{
 const d=await deployment(t);await provision(d);await assert.rejects(()=>start(d,{fault:p=>{if(p===point)throw new Error('synthetic crash seam');}}));
 assert.notEqual(readAdmission(d).state,'closed_clean');assert.ok(existsSync(join(d.configuration.authorityDirectory,'owner.lock')));
});
test('normal close checkpoints exact closed bytes and repeat close is harmless; app cannot serve afterward',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d);await server.close();await server.close();
 assert.equal(readAdmission(d).state,'closed_clean');assert.equal(readAdmission(d).closedDigest,fileDigest(d.path,d.configuration.ownerUid));
 assert.equal((await server.app.request('/health')).status,503);assert.equal((await server.handleRequest(new Request(origin+'/health'),'synthetic')).status,503);
});
test('unknown sidecar and independently changed candidate hold before writable opening',async t=>{
 const d=await deployment(t);await provision(d);writeFileSync(d.path+'-wal','synthetic-unknown');assert.throws(()=>new RuntimeOwner(d.configuration,d.path));
});

test('synthetic listener activation failure closes the actual owner and never records clean admission',async t=>{
 const d=await deployment(t);await provision(d);const {server,owner}=await start(d);
 const {startListener}=await import('../../src/runtime-modules/composition.js');
 await assert.rejects(()=>startListener(server,()=>{throw new Error('synthetic no listener acquired');}));
 assert.equal(server.db.open,false);assert.throws(()=>owner.assertServing());assert.equal(readAdmission(d).state,'running');
});

for(const point of ['init:directory','init:ledger','init:witness','init:admission'])test(`partial exclusive init at ${point} is retained and never resumed as first use`,async t=>{
 const d=await deployment(t);await d.seed.close();const input={configuration:d.configuration,mainPath:d.path,expectedMainDigest:fileDigest(d.path,d.configuration.ownerUid),operationId:randomUUID(),expectedAbsence:true as const,expectedSchemaDigest:ledgerSchemaDigest};
 assert.throws(()=>initializeAuthority(input,p=>{if(p===point)throw new Error('synthetic provisioning failure');}));
 assert.ok(existsSync(join(d.configuration.authorityDirectory,'owner.lock')));assert.throws(()=>initializeAuthority(input));assert.throws(()=>new RuntimeOwner(d.configuration,d.path));
});

test('qualified offline storage uses the same exclusive current authority and preserves clean main provenance',async t=>{
 const d=await deployment(t);await provision(d);const {server}=await start(d);const {operateClosedStorage}=await import('../../src/runtime-modules/storage-operations.js');
 await assert.rejects(()=>operateClosedStorage({configuration:d.configuration,mainPath:d.path,expectedClosedDigest:readAdmission(d).closedDigest as string,action:'check'}));
 await server.close();const before=readAdmission(d);await operateClosedStorage({configuration:d.configuration,mainPath:d.path,expectedClosedDigest:before.closedDigest as string,action:'backup',destination:join(d.root,'backups','qualified-backup.sqlite')});
 assert.equal(existsSync(join(d.root,'backups','qualified-backup.sqlite')),true);assert.deepEqual(readAdmission(d),before);assert.equal(fileDigest(d.path,d.configuration.ownerUid),before.closedDigest);
});

test('historical13 admission cannot authorize current16 or rewrite authority; overflow17 is rejected',async t=>{
 const d=await deployment(t);await provision(d);
 const current=readAdmission(d), path=join(d.configuration.authorityDirectory,'admission.json');
 const digests=current.migrationDigests as string[];
 assert.equal(digests.length,16);
 assert.equal(admissionSchema.safeParse({...current,migrationDigests:[...digests,'a'.repeat(64)]}).success,false);
 assert.equal(admissionSchema.safeParse({...current,appliedDigests:[...digests,'a'.repeat(64)]}).success,false);
 const historical={...current,migrationDigests:digests.slice(0,13)};
 assert.equal(admissionSchema.safeParse(historical).success,false);
 writeFileSync(path,JSON.stringify(historical));
 const before=readFileSync(path),main=fileDigest(d.path,d.configuration.ownerUid);
 assert.throws(()=>new RuntimeOwner(d.configuration,d.path));
 assert.deepEqual(readFileSync(path),before);assert.equal(fileDigest(d.path,d.configuration.ownerUid),main);
});
