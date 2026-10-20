import Database from 'better-sqlite3';
import { z } from 'zod';
import { constants, closeSync, copyFileSync, existsSync, mkdirSync, openSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../errors.js';
import { integrity, type Sqlite } from '../storage.js';
import type { AccountLifecycle } from '../lifecycle/service.js';
import type { AuthoritativeRestoreState } from '../community/index.js';
import { suppressionLedgerSchema, ExistingSuppressionLedger } from '../lifecycle/ledger.js';
import { CurrentSuppressionAuthority, digestSchema, genesisHead, ledgerSchemaDigest, witnessSchema } from './currentness.js';
import { AuthorityLock, JsonFile, assertClosedMain, assertIdentity, assertSeparate, canonicalPath, lexicalPath, fileDigest, identitySchema, sameIdentity, syncDirectory, syncFile, type FaultPoint, noFault } from './files.js';
import { migrationDigests } from './migrations.js';
import { readClosedReceipts, assertStrictClosedMain } from './closed-read.js';
import { runtimeModulesConfiguration, type RuntimeModulesConfiguration } from './configuration.js';
const counter = z.number().int().nonnegative().safe();
export const admissionSchema = z.object({ version: z.literal(1), authorityId: z.uuid(), revision: counter, databaseGeneration: counter,
  mainPath: z.string().min(1), main: identitySchema, migrationDigests: z.array(digestSchema).length(migrationDigests.length),
  appliedDigests: z.array(digestSchema).min(7).max(migrationDigests.length), state: z.enum(['prepared_initial','prepared_restore','prepared_recovery','opening','running','closed_clean','held']),
  operationId: z.uuid(), closedDigest: digestSchema, suppressionSequence: counter, suppressionHead: digestSchema,
  reason: z.string().min(1).max(256),
}).strict();
export type Admission = z.infer<typeof admissionSchema>;
const initializeSchema = z.object({ configuration: runtimeModulesConfiguration, mainPath: z.string(), expectedMainDigest: digestSchema,
  operationId: z.uuid(), expectedAbsence: z.literal(true), expectedSchemaDigest: digestSchema }).strict();
export type InitializeAuthorityInput = z.infer<typeof initializeSchema>;
export function initializeAuthority(raw: InitializeAuthorityInput, fault: FaultPoint = noFault): void {
  const input = initializeSchema.parse(raw), config = input.configuration;
  if (input.expectedSchemaDigest !== ledgerSchemaDigest) throw new Error('Suppression source digest mismatch');
  assertSeparate(config.authorityDirectory, input.mainPath);
  canonicalPath(dirname(config.authorityDirectory), config.ownerUid, true);
  const main = canonicalPath(input.mainPath, config.ownerUid); assertClosedMain(input.mainPath);
  if (fileDigest(input.mainPath, config.ownerUid) !== input.expectedMainDigest) throw new Error('Initial closed main digest mismatch');
  mkdirSync(config.authorityDirectory, {mode:0o700}); syncDirectory(dirname(config.authorityDirectory));
  const lock = new AuthorityLock(config.authorityDirectory, config.ownerUid, input.operationId);
  const ledgerPath = join(config.authorityDirectory, 'ledger.sqlite');
  // Partial initialization stays on disk as a hold. It is never erased or resumed as first use.
  fault('init:directory');
  const appliedDigests = readClosedReceipts(lock, input.mainPath, main, input.expectedMainDigest, fault);
  if (appliedDigests.length !== 7) throw new Error('First use requires existing ordinary B1 schema7');
  const fd = openSync(ledgerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); syncDirectory(config.authorityDirectory);
  const db = new Database(ledgerPath, {fileMustExist:true});
  try { db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL');
    db.transaction(() => { db.exec(suppressionLedgerSchema); db.prepare('INSERT INTO suppression_authority VALUES(?,0)').run(config.authorityId); }).immediate();
  } finally { db.close(); }
  syncFile(ledgerPath, config.ownerUid); fault('init:ledger');
  const ledger = new ExistingSuppressionLedger(ledgerPath, config.authorityId, 0);
  try { ledger.validateSchema(); ledger.forEachRecord(() => { throw new Error('Nonempty initial ledger'); }); } finally { ledger.close(); }
  const head = genesisHead(config.authorityId);
  JsonFile.create(join(config.authorityDirectory, 'currentness.json'), config.ownerUid, witnessSchema, {version:1, authorityId:config.authorityId,
    ledgerSchemaDigest, revision:0, directory:lock.directoryIdentity, ledger:canonicalPath(ledgerPath, config.ownerUid), committedSequence:0, committedHeadDigest:head, pending:null});
  fault('init:witness');
  JsonFile.create(join(config.authorityDirectory, 'admission.json'), config.ownerUid, admissionSchema, {version:1, authorityId:config.authorityId,
    revision:0, databaseGeneration:1, mainPath:input.mainPath, main, migrationDigests:[...migrationDigests], appliedDigests,
    state:'prepared_initial', operationId:input.operationId, closedDigest:input.expectedMainDigest, suppressionSequence:0, suppressionHead:head, reason:'explicit_initial_adoption'});
  fault('init:admission'); lock.release();
}
const preparedSchema = z.object({ configuration: runtimeModulesConfiguration, mainPath:z.string(), mode:z.enum(['restore','recovery']),
  operationId:z.uuid(), expectedRevision:counter, expectedGeneration:counter, expectedPredecessorDigest:digestSchema, expectedCandidateDigest:digestSchema,
  reason:z.string().min(1).max(256), provenance:z.string().min(1).max(256), oldWriterStopped:z.literal(true),
  priorLock:z.object({nonce:z.uuid(),operationId:z.uuid()}).strict().optional(),
  recoverySource:z.object({mainDigest:digestSchema,main:identitySchema,walDigest:digestSchema,wal:identitySchema,shm:identitySchema.optional()}).strict().optional(),
}).strict();
export type PrepareAdmissionInput = z.infer<typeof preparedSchema>;
export function prepareAdmission(raw: PrepareAdmissionInput): void {
  const input = preparedSchema.parse(raw), config = input.configuration;
  assertSeparate(config.authorityDirectory, input.mainPath);
  const file = new JsonFile(join(config.authorityDirectory,'admission.json'),config.ownerUid,admissionSchema);
  const previous = file.read();
  if (previous.authorityId !== config.authorityId || previous.mainPath !== input.mainPath || previous.revision !== input.expectedRevision ||
    previous.databaseGeneration !== input.expectedGeneration || previous.closedDigest !== input.expectedPredecessorDigest ||
    !Number.isSafeInteger(previous.databaseGeneration + 1)) throw new Error('Offline admission predecessor mismatch');
  const main = canonicalPath(input.mainPath, config.ownerUid);
  if (!input.recoverySource) assertClosedMain(input.mainPath);
  else {
    if(input.mode!=='recovery') throw new Error('WAL source only belongs to offline recovery');
    assertIdentity(input.mainPath,config.ownerUid,input.recoverySource.main);
    assertIdentity(input.mainPath+'-wal',config.ownerUid,input.recoverySource.wal);
    if (existsSync(input.mainPath+'-journal')) throw new Error('Unknown recovery journal');
    if (existsSync(input.mainPath+'-shm') !== !!input.recoverySource.shm) throw new Error('Recovery sidecar inventory mismatch');
    if(input.recoverySource.shm) assertIdentity(input.mainPath+'-shm',config.ownerUid,input.recoverySource.shm);
    if(fileDigest(input.mainPath,config.ownerUid)!==input.recoverySource.mainDigest || fileDigest(input.mainPath+'-wal',config.ownerUid)!==input.recoverySource.walDigest) throw new Error('Recovery source tuple mismatch');
  }
  // Exact stopped-writer/lock custody is an offline operator prerequisite, never an HTTP retry.
  if (input.priorLock) {
    canonicalPath(config.authorityDirectory,config.ownerUid,true);
    const lockPath=join(config.authorityDirectory,'owner.lock'); canonicalPath(lockPath,config.ownerUid,true);
    const owner=new JsonFile(join(lockPath,'owner.json'),config.ownerUid,z.object({nonce:z.uuid(),operationId:z.uuid()}).strict()).read();
    if (owner.nonce!==input.priorLock.nonce || owner.operationId!==input.priorLock.operationId) throw new Error('Prior lock mismatch');
    unlinkSync(join(lockPath,'owner.json')); syncDirectory(lockPath); rmdirSync(lockPath); syncDirectory(config.authorityDirectory);
  }
  const lock = new AuthorityLock(config.authorityDirectory,config.ownerUid,input.operationId);
  let authority:CurrentSuppressionAuthority|undefined;
  try {
    authority=new CurrentSuppressionAuthority(lock,new JsonFile(join(config.authorityDirectory,'currentness.json'),config.ownerUid,witnessSchema),join(config.authorityDirectory,'ledger.sqlite'),config.authorityId);
    const witness=authority.checkpoint();
    if(input.recoverySource) {
      // Recover only the exact stopped-file tuple under exclusive current authority.
      assertIdentity(input.mainPath,config.ownerUid,input.recoverySource.main);
      assertIdentity(input.mainPath+'-wal',config.ownerUid,input.recoverySource.wal);
      if (existsSync(input.mainPath+'-journal') || existsSync(input.mainPath+'-shm') !== !!input.recoverySource.shm) throw new Error('Recovery inventory changed');
      if(input.recoverySource.shm) assertIdentity(input.mainPath+'-shm',config.ownerUid,input.recoverySource.shm);
      if(fileDigest(input.mainPath,config.ownerUid)!==input.recoverySource.mainDigest || fileDigest(input.mainPath+'-wal',config.ownerUid)!==input.recoverySource.walDigest) throw new Error('Recovery tuple changed before open');
      const recovered=new Database(input.mainPath,{fileMustExist:true});
      try { recovered.pragma('synchronous=FULL'); const rows=recovered.pragma('wal_checkpoint(TRUNCATE)') as {busy:number;log:number;checkpointed:number}[];
        if(rows.length!==1 || rows[0]!.busy!==0 || rows[0]!.log!==rows[0]!.checkpointed || recovered.pragma('integrity_check',{simple:true})!=='ok') throw new Error('Offline WAL recovery unproved');
      } finally { recovered.close(); }
      assertClosedMain(input.mainPath);syncFile(input.mainPath,config.ownerUid);
    }
    if(fileDigest(input.mainPath,config.ownerUid)!==input.expectedCandidateDigest) throw new Error('Offline closed candidate digest mismatch');
    const appliedDigests=readClosedReceipts(lock,input.mainPath,main,input.expectedCandidateDigest);
    file.replace({...previous,revision:previous.revision+1,databaseGeneration:previous.databaseGeneration+1,main,appliedDigests,
      state:input.mode==='restore'?'prepared_restore':'prepared_recovery',operationId:input.operationId,closedDigest:input.expectedCandidateDigest,
      suppressionSequence:witness.committedSequence,suppressionHead:witness.committedHeadDigest,reason:`${input.reason}: ${input.provenance}`.slice(0,256)},'prepare-admission');
    authority.close(); lock.release();
  } catch(error) {
    try { authority?.close(); } catch(cleanupError) { throw new AggregateError([error,cleanupError],'Admission preparation failed and authority close failed'); }
    throw error;
  }
}
const relocatedSchema = z.object({ configuration: runtimeModulesConfiguration, mainPath: z.string(),
  expectedMain: identitySchema, expectedRevision: counter, expectedGeneration: counter, expectedPredecessorDigest: digestSchema,
  backupPath: z.string(), expectedBackupDigest: digestSchema, destination: z.string(), operationId: z.uuid(),
  provenance: z.string().min(1).max(256), oldWriterStopped: z.literal(true),
}).strict();
export type PrepareRelocatedAdmissionInput = z.infer<typeof relocatedSchema>;
// Offline, synchronous new-target restore. A failed candidate is retained for inspection;
// retry uses a fresh destination. No source or independent authority is reset.
export function prepareRelocatedAdmission(raw: PrepareRelocatedAdmissionInput, fault: FaultPoint = noFault): Admission {
  const input = relocatedSchema.parse(raw), config = input.configuration, uid = config.ownerUid;
  for (const path of [input.mainPath, input.backupPath, input.destination]) assertSeparate(config.authorityDirectory, path);
  lexicalPath(input.destination);
  if (input.destination === input.mainPath || input.destination === input.backupPath) throw new Error('Relocation destination aliases source');
  const parent = canonicalPath(dirname(input.destination), uid, true);
  const lock = new AuthorityLock(config.authorityDirectory, uid, input.operationId);
  let authority: CurrentSuppressionAuthority | undefined, commitStarted = false, candidateClosed = true;
  try {
    const file = new JsonFile(join(config.authorityDirectory, 'admission.json'), uid, admissionSchema, fault), previous = file.read();
    if (previous.state !== 'closed_clean' || previous.authorityId !== config.authorityId || previous.mainPath !== input.mainPath ||
      previous.revision !== input.expectedRevision || previous.databaseGeneration !== input.expectedGeneration ||
      previous.closedDigest !== input.expectedPredecessorDigest || !sameIdentity(previous.main, input.expectedMain) ||
      !Number.isSafeInteger(previous.revision + 1) || !Number.isSafeInteger(previous.databaseGeneration + 1) ||
      JSON.stringify(previous.migrationDigests) !== JSON.stringify(migrationDigests) ||
      JSON.stringify(previous.appliedDigests) !== JSON.stringify(migrationDigests)) throw new Error('Relocation predecessor mismatch');
    const sourceUnchanged = (): void => {
      lock.assert(); assertIdentity(input.mainPath, uid, input.expectedMain); assertStrictClosedMain(input.mainPath);
      if (fileDigest(input.mainPath, uid) !== input.expectedPredecessorDigest) throw new Error('Relocation source changed');
    };
    sourceUnchanged();
    const witnessFile = new JsonFile(join(config.authorityDirectory, 'currentness.json'), uid, witnessSchema);
    if (witnessFile.read().pending) throw new Error('Relocation requires settled suppression authority');
    authority = new CurrentSuppressionAuthority(lock, witnessFile, join(config.authorityDirectory, 'ledger.sqlite'), config.authorityId);
    const witness = authority.checkpoint();
    if (previous.suppressionSequence > witness.committedSequence ||
      (previous.suppressionSequence === witness.committedSequence && previous.suppressionHead !== witness.committedHeadDigest)) throw new Error('Relocation suppression mismatch');
    const backup = canonicalPath(input.backupPath, uid);
    if (sameIdentity(backup, previous.main) || sameIdentity(backup, witness.ledger)) throw new Error('Relocation backup aliases authority or source');
    assertStrictClosedMain(input.backupPath);
    if (fileDigest(input.backupPath, uid) !== input.expectedBackupDigest) throw new Error('Relocation backup digest mismatch');
    assertIdentity(dirname(input.destination), uid, parent, true); assertStrictClosedMain(input.destination);
    copyFileSync(input.backupPath, input.destination, constants.COPYFILE_EXCL);
    const main = canonicalPath(input.destination, uid);
    assertIdentity(input.backupPath, uid, backup); assertStrictClosedMain(input.backupPath);
    if (sameIdentity(main, previous.main) || sameIdentity(main, witness.ledger) || sameIdentity(main, backup) ||
      fileDigest(input.destination, uid) !== input.expectedBackupDigest || fileDigest(input.backupPath, uid) !== input.expectedBackupDigest) throw new Error('Relocation copy mismatch');
    // Only the isolated destination is opened. Neither preserved source is opened by SQLite.
    const db = new Database(input.destination, {readonly:true, fileMustExist:true, timeout:0});
    candidateClosed = false;
    let appliedDigests: string[];
    try {
      db.pragma('temp_store = MEMORY'); db.pragma('cache_size = -2048'); db.pragma('mmap_size = 0'); integrity(db);
      const rows = db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version LIMIT ?').all(migrationDigests.length + 1) as {version:number;checksum:string}[];
      appliedDigests = rows.map(row => row.checksum);
      if (rows.length !== migrationDigests.length || rows.some((row,index) => row.version !== index+1) ||
        JSON.stringify(appliedDigests) !== JSON.stringify(migrationDigests)) throw new Error('Relocation runtime migration mismatch');
    } finally { db.close(); candidateClosed = true; }
    assertStrictClosedMain(input.destination); syncFile(input.destination, uid);
    fault('relocation:before-commit'); sourceUnchanged(); assertIdentity(dirname(input.destination), uid, parent, true);
    assertIdentity(input.destination, uid, main);
    if (fileDigest(input.destination, uid) !== input.expectedBackupDigest) throw new Error('Relocation destination changed');
    const current = authority.checkpoint();
    if (current.revision !== witness.revision || current.committedHeadDigest !== witness.committedHeadDigest) throw new Error('Relocation authority changed');
    const next: Admission = {...previous, revision:previous.revision+1, databaseGeneration:previous.databaseGeneration+1,
      mainPath:input.destination, main, appliedDigests, state:'prepared_restore', operationId:input.operationId,
      closedDigest:input.expectedBackupDigest, suppressionSequence:current.committedSequence, suppressionHead:current.committedHeadDigest,
      reason:`relocated_restore: ${input.provenance}`.slice(0,256)};
    // Once replacement starts, failure is an unknown outcome: retain custody, never roll back.
    commitStarted = true; file.replace(next, 'relocated-admission');
    fault('relocation:after-commit'); sourceUnchanged(); assertIdentity(input.destination, uid, main);
    if (fileDigest(input.destination, uid) !== next.closedDigest) throw new Error('Relocation committed destination changed');
    const result = file.read(); authority.close(); lock.release(); return result;
  } catch (error) {
    const errors: unknown[] = [error];
    try { authority?.close(); } catch (closeError) { errors.push(closeError); }
    // Only this invocation's known lock can be released. Unknown postcommit effects stay held.
    if (!commitStarted && candidateClosed && errors.length === 1) try { lock.release(); } catch (releaseError) { errors.push(releaseError); }
    if (errors.length > 1) throw new AggregateError(errors, 'Relocation failed with retained custody');
    throw error;
  }
}
const owners = new WeakSet<RuntimeOwner>();
export function assertRuntimeOwner(owner: RuntimeOwner): void { if (!owners.has(owner)) throw new Error('Unvalidated runtime owner'); owner.assert(); }
export class RuntimeOwner {
  readonly ledger:CurrentSuppressionAuthority;
  private readonly lock:AuthorityLock;
  private readonly admission:JsonFile<Admission>;
  private main:Sqlite|undefined;
  private failed=false;
  private closed=false;
  private admitted=false;
  readonly fullBarrier:boolean;
  constructor(readonly configuration:RuntimeModulesConfiguration, readonly mainPath:string, private readonly fault:FaultPoint=noFault) {
    this.configuration=Object.freeze(runtimeModulesConfiguration.parse(configuration)); assertSeparate(configuration.authorityDirectory,mainPath);
    const uid=configuration.ownerUid;
    this.lock=new AuthorityLock(configuration.authorityDirectory,uid,randomUUID());
    let ledger:CurrentSuppressionAuthority|undefined;
    try {
      const witness=new JsonFile(join(configuration.authorityDirectory,'currentness.json'),uid,witnessSchema,fault);
      ledger=new CurrentSuppressionAuthority(this.lock,witness,join(configuration.authorityDirectory,'ledger.sqlite'),configuration.authorityId,fault);
      this.ledger=ledger;
      this.admission=new JsonFile(join(configuration.authorityDirectory,'admission.json'),uid,admissionSchema,fault);
      const value=this.admission.read();
      if (!['closed_clean','prepared_initial','prepared_restore','prepared_recovery'].includes(value.state) || value.authorityId!==configuration.authorityId ||
        value.mainPath!==mainPath || value.databaseGeneration<1 || JSON.stringify(value.migrationDigests)!==JSON.stringify(migrationDigests)) throw new Error('Unknown main provenance');
      assertIdentity(mainPath,uid,value.main); assertClosedMain(mainPath);
      if (sameIdentity(value.main,witness.read().ledger) || fileDigest(mainPath,uid)!==value.closedDigest ||
        JSON.stringify(readClosedReceipts(this.lock,mainPath,value.main,value.closedDigest,fault))!==JSON.stringify(value.appliedDigests)) throw new Error('Changed closed main candidate');
      const current=ledger.checkpoint();
      if (value.suppressionSequence>current.committedSequence || (value.suppressionSequence===current.committedSequence && value.suppressionHead!==current.committedHeadDigest)) throw new Error('Admission suppression mismatch');
      this.fullBarrier=value.state!=='closed_clean';
      this.admission.replace({...value,revision:value.revision+1,state:'opening'},'opening-admission');
      owners.add(this); fault('owner:opening');
    } catch(error) {
      this.failed=true;
      try { ledger?.close(); } catch(cleanupError) { throw new AggregateError([error,cleanupError],'Runtime admission failed and ledger close failed'); }
      throw error;
    }
  }
  assert():void {
    if(this.failed||this.closed) throw new DomainError(503,'runtime_owner_unavailable');
    try { this.lock.assert(); this.ledger.currentSequence(); const record=this.admission.read(); if(this.main) assertIdentity(this.mainPath,this.configuration.ownerUid,record.main); }
    catch(error) { this.failed=true; throw new DomainError(503,'runtime_owner_unavailable'); }
  }
  stage(label:string):void { this.assert(); this.fault(label); }
  assertComposition(db:Sqlite):void { this.assert(); if(this.main!==db) throw new Error('Runtime composition requires same main handle'); }
  attachMain(db:Sqlite):void { this.assert(); if(this.main) throw new Error('Duplicate main owner'); this.main=db; this.fault('owner:main'); }
  beforeOpen(path:string):void {
    assertRuntimeOwner(this); if(path!==this.mainPath||this.main) throw new Error('Runtime main binding mismatch');
    try { const value=this.admission.read(); this.lock.assert(); assertIdentity(path,this.configuration.ownerUid,value.main); assertStrictClosedMain(path);
      if(fileDigest(path,this.configuration.ownerUid)!==value.closedDigest) throw new Error('Runtime closed main changed before open');
      this.lock.assert(); assertIdentity(path,this.configuration.ownerUid,value.main); assertStrictClosedMain(path);
    } catch(error) { this.failed=true; throw error; }
  }
  admit(createLifecycle:()=>AccountLifecycle,reconcile:(authority:AuthoritativeRestoreState)=>unknown):AccountLifecycle {
    this.assert(); const db=this.main; if(!db) throw new Error('Main owner missing'); const before=this.ledger.checkpoint();
    let lifecycle:AccountLifecycle|undefined;
    db.transaction(()=>{
      this.ledger.reconcileRestore(entry=>{
        if(!db.prepare('SELECT id FROM form_accounts WHERE id=? AND auth_user_id=?').get(entry.accountId,entry.authUserId)) throw new DomainError(503,'restore_account_absent_unqualified');
      });
      lifecycle=createLifecycle();
      const count=db.prepare('SELECT count(*) n FROM form_accounts').get() as {n:number}; if(count.n>1000) throw new DomainError(413,'canonical_restore_capacity');
      const states=new Map<string,{state:'active'|'suppressed';epoch:number}>();
      for(const row of db.prepare('SELECT f.id,f.auth_user_id,u.id user_id,l.state,l.epoch,l.suppression_seq FROM form_accounts f LEFT JOIN "user" u ON u.id=f.auth_user_id LEFT JOIN account_lifecycle l ON l.account_id=f.id').iterate() as Iterable<{id:string;auth_user_id:string;user_id:string|null;state:string|null;epoch:number|null;suppression_seq:number|null}>) {
        if(row.user_id!==row.auth_user_id || !Number.isSafeInteger(row.epoch) || row.epoch===null || row.epoch<0) throw new DomainError(503,'canonical_restore_identity_unproved');
        const record=this.ledger.lookup(row.id);
        if(record ? record.authUserId!==row.auth_user_id || row.state!=='disabled' || row.epoch!==record.epoch || row.suppression_seq!==record.sequence : row.state!=='active') throw new DomainError(503,'canonical_restore_state_unproved');
        states.set(row.id,{state:record?'suppressed':'active',epoch:row.epoch});
      }
      this.fault('barrier:canonical');
      if(this.fullBarrier) {
        db.prepare('DELETE FROM account_action_grants').run(); db.prepare('DELETE FROM session').run(); db.prepare('DELETE FROM verification').run();
        db.prepare("UPDATE phone_operations SET status='unknown' WHERE status='claimed'").run();
        db.prepare("UPDATE phone_challenges SET status='failed',expires_at=MIN(expires_at,?),approved_at=NULL WHERE status IN('sending','pending','checking')").run(Date.now());
        reconcile({ready:true,lookup:id=>states.get(id)}); this.fault('barrier:community');
        for(const table of ['account_action_grants','session','verification']) if((db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n!==0) throw new Error('Restored authority not revoked');
      }
      const after=this.ledger.checkpoint(); if(after.revision!==before.revision||after.committedHeadDigest!==before.committedHeadDigest) throw new Error('Authority changed across barrier');
      this.fault('barrier:before-commit');
    }).immediate();
    this.fault('barrier:after-commit');
    const value=this.admission.read(); this.admission.replace({...value,revision:value.revision+1,state:'running',appliedDigests:[...migrationDigests],
      suppressionSequence:before.committedSequence,suppressionHead:before.committedHeadDigest},'running-admission'); this.admitted=true;
    if(!lifecycle) throw new Error('Lifecycle construction absent'); return lifecycle;
  }
  assertServing():void { this.assert(); if(!this.admitted) throw new DomainError(503,'runtime_admission_pending'); }
  close(clean:boolean):void {
    if(this.closed) return;
    let primary:unknown;
    try {
      if(clean && !this.failed && this.admitted) {
        this.assert(); const db=this.main; if(!db||!db.open) throw new Error('Main closed outside owner');
        const checkpoint=db.pragma('wal_checkpoint(TRUNCATE)') as {busy:number;log:number;checkpointed:number}[];
        if(checkpoint.length!==1||checkpoint[0]!.busy!==0||checkpoint[0]!.log!==checkpoint[0]!.checkpointed) throw new Error('Main checkpoint incomplete');
        db.close(); assertClosedMain(this.mainPath); syncFile(this.mainPath,this.configuration.ownerUid);
        const value=this.admission.read(), witness=this.ledger.checkpoint();
        assertIdentity(this.mainPath,this.configuration.ownerUid,value.main);
        const closedDigest=fileDigest(this.mainPath,this.configuration.ownerUid);
        const appliedDigests=readClosedReceipts(this.lock,this.mainPath,value.main,closedDigest,this.fault);
        if(JSON.stringify(appliedDigests)!==JSON.stringify(value.appliedDigests)) throw new Error('Migration receipts changed before clean close');
        this.admission.replace({...value,revision:value.revision+1,state:'closed_clean',closedDigest,
          appliedDigests,suppressionSequence:witness.committedSequence,suppressionHead:witness.committedHeadDigest},'clean-close');
        this.ledger.close(); this.lock.release();
      } else { if(this.main?.open) this.main.close(); this.ledger.close(); }
    } catch(error) {
      primary=error; this.failed=true; const cleanupErrors:unknown[]=[];
      if(this.main?.open) try{this.main.close();}catch(cleanupError){cleanupErrors.push(cleanupError);}
      try{this.ledger.close();}catch(cleanupError){cleanupErrors.push(cleanupError);}
      if(cleanupErrors.length) primary=new AggregateError([error,...cleanupErrors],'Runtime close failed and cleanup failed');
    }
    finally { this.closed=true; }
    if(primary) throw primary;
  }
}
