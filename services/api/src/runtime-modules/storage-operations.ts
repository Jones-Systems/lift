import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { backupAndVerify, integrity } from '../storage.js';
import { admissionSchema } from './admission.js';
import { runtimeModulesConfiguration } from './configuration.js';
import { AuthorityLock, JsonFile, assertClosedMain, assertIdentity, assertSeparate, fileDigest, lexicalPath, canonicalPath } from './files.js';
import { CurrentSuppressionAuthority, witnessSchema, digestSchema } from './currentness.js';
import { migrationDigests } from './migrations.js';
import { withClosedStorageSnapshot } from './closed-read.js';
const inputSchema = z.object({configuration:runtimeModulesConfiguration,mainPath:z.string(),expectedClosedDigest:digestSchema,
  action:z.enum(['check','backup']),destination:z.string().optional()}).strict();
export type ClosedStorageInput = z.infer<typeof inputSchema>;
// Offline source seam only: active/nonclean ownership is never borrowed from the API.
export async function operateClosedStorage(raw:ClosedStorageInput):Promise<void> {
  const input=inputSchema.parse(raw),config=input.configuration;
  assertSeparate(config.authorityDirectory,input.mainPath);
  if(input.action==='backup') {
    if(!input.destination) throw new Error('Exact new backup destination required');
    lexicalPath(input.destination);
    const backups=join(dirname(input.mainPath),'backups');
    if(!input.destination.startsWith(backups+'/')) throw new Error('Runtime backup must remain in the main backup tree');
    canonicalPath(dirname(input.destination),config.ownerUid,true);
    if(input.destination===input.mainPath || input.destination===config.authorityDirectory || input.destination.startsWith(config.authorityDirectory+'/')) throw new Error('Backup intersects authority');
  } else if(input.destination!==undefined) throw new Error('Check cannot name a destination');
  const lock=new AuthorityLock(config.authorityDirectory,config.ownerUid,randomUUID());
  let authority:CurrentSuppressionAuthority|undefined;
  try {
    authority=new CurrentSuppressionAuthority(lock,new JsonFile(join(config.authorityDirectory,'currentness.json'),config.ownerUid,witnessSchema),join(config.authorityDirectory,'ledger.sqlite'),config.authorityId);
    const admission=new JsonFile(join(config.authorityDirectory,'admission.json'),config.ownerUid,admissionSchema),value=admission.read(),witness=authority.checkpoint();
    if(value.state!=='closed_clean'||value.authorityId!==config.authorityId||value.mainPath!==input.mainPath||value.closedDigest!==input.expectedClosedDigest||
      JSON.stringify(value.migrationDigests)!==JSON.stringify(migrationDigests)||value.suppressionSequence!==witness.committedSequence||value.suppressionHead!==witness.committedHeadDigest) throw new Error('Closed storage provenance mismatch');
    assertIdentity(input.mainPath,config.ownerUid,value.main);assertClosedMain(input.mainPath);
    if(fileDigest(input.mainPath,config.ownerUid)!==value.closedDigest) throw new Error('Closed storage bytes changed');
    await withClosedStorageSnapshot(lock,input.mainPath,value.main,value.closedDigest,async db=>{
      integrity(db);
      const rows=db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version LIMIT ?').all(migrationDigests.length + 1) as {version:number;checksum:string}[];
      if(rows.length!==migrationDigests.length||rows.some((row,index)=>row.version!==index+1)||JSON.stringify(rows.map(row=>row.checksum))!==JSON.stringify(migrationDigests))throw new Error('Closed storage migration history mismatch');
      if(input.action==='backup') await backupAndVerify(db,input.destination!);
    });
    assertClosedMain(input.mainPath);assertIdentity(input.mainPath,config.ownerUid,value.main);
    if(fileDigest(input.mainPath,config.ownerUid)!==value.closedDigest||admission.read().revision!==value.revision||authority.checkpoint().revision!==witness.revision)throw new Error('Closed storage changed during operation');
    authority.close();lock.release();
  } catch(error) {
    try { authority?.close(); } catch(cleanupError) { throw new AggregateError([error,cleanupError],'Closed storage failed and authority close failed'); }
    throw error;
  }
}
