import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotificationInbox, newNotificationReceiptId, notificationPayloadDigest } from '../../src/purchases/notification-inbox.js';
import { initializeSyntheticNotificationInbox, assertNotificationInboxSchema } from '../../src/purchases/notification-inbox-schema.js';
import { createSyntheticInboxAuthority } from '../../src/purchases/notification-inbox-capabilities.js';
import type { InboxCapability, InboxCapture, InboxClaim, InboxNamespace, InboxOperation, InboxOuter,
  InboxPolicy, InboxResult, InboxSuccess, PurchaseCommitFrame, VerifiedInboxNotification } from '../../src/purchases/notification-inbox.types.js';

const namespace: InboxNamespace = {provider:'Apple',bundleId:'test.form.fixture',environment:'Sandbox',appAppleId:null};
const otherNamespace: InboxNamespace = {...namespace,environment:'Production',appAppleId:123};
const notificationUUID = '6b340806-51e1-411c-a356-2433e0781fb6';
const policy: InboxPolicy = {
  revision:'fixture1',maxEnvelopeBytes:2048,maxPayloadBytes:1024,maxNestedBytes:128,
  maxReceipts:32,maxVariants:32,maxVerificationClaims:4,maxAttempts:8,maxTransitions:32,
  maxOperationBytes:8192,maxPageSize:10,ingressBytes:2**22,variantBytes:2**22,completionBytes:2**29,
  recordOverheadBytes:4096,retention:{payloadMs:10000,tombstoneMs:20000,auditMs:30000},
};
const ok = (result: InboxResult): InboxSuccess => { assert.equal(result.status,'ok',JSON.stringify(result)); return result as InboxSuccess; };
const fail = (result: InboxResult, status: Exclude<InboxResult['status'],'ok'>) => {
  assert.equal(result.status,status); assert.equal(result.acknowledge,false);
};
const operation = () => randomUUID();
const filter = {namespace:null,authentication:null,disposition:null};
function fixture(t: TestContext, changedPolicy: Partial<InboxPolicy> = {}) {
  const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),'.notification-inbox-'));
  const handles: Database.Database[] = [];
  t.after(() => { try { for (const db of handles) if (db.open) db.close(); } finally { rmSync(root,{recursive:true,force:true}); } });
  const path = join(root,'inbox.sqlite');
  const open = () => { const db = new Database(path); handles.push(db); db.pragma('foreign_keys=ON'); db.pragma('busy_timeout=1'); return db; };
  const db = open(), configured: InboxPolicy = {...policy,...changedPolicy};
  initializeSyntheticNotificationInbox(db,{use:'isolated-synthetic',storeId:'fixture-store',generation:'generation1',ingress:'fixture',policy:configured});
  let now = 1000, settled = true, badSettlement = false, lose: string | null = null;
  let outerCalls = 0, transactionCalls = 0, renewalCalls = 0;
  let nestedNamespace = namespace, rejectOuter = false, rejectNested = false;
  const outers = new Map<string,InboxOuter>();
  const compose = (handle: Database.Database = db, scopes: readonly InboxNamespace[] = [namespace,otherNamespace]) => {
    const authority = createSyntheticInboxAuthority(handle,{use:'isolated-synthetic',ingress:'fixture'});
    const caps = Object.fromEntries((['capture','verify','promote','claim','complete','metadata','proof','replay','dispose'] as const)
      .map(op => [op,authority.issue(op,{ingress:'fixture',namespaces:scopes,receiptId:null})])) as Record<InboxOperation,InboxCapability>;
    const inbox = new NotificationInbox(handle,{use:'isolated-synthetic',ingress:'fixture',now:() => now,
      afterCommit: op => { if (op === lose) { lose = null; throw new Error('lost synthetic response'); } },
      settlement: attempt => {
        const row = handle.prepare('SELECT custody_id,generation FROM notification_inbox_claims WHERE attempt_id=?').get(attempt) as {custody_id:string;generation:number}|undefined;
        return {custodyId:badSettlement ? 'foreign-custody' : row?.custody_id ?? 'unavailable',generation:row?.generation ?? 0,settled};
      },
      verifier:{
        outer: async bytes => { outerCalls++; if (rejectOuter) throw new Error('private-error-must-not-leak'); return outers.get(bytes)!; },
        transaction: async () => { transactionCalls++; if (rejectNested) throw new Error('invalid nested'); return {namespace:nestedNamespace,originalTransactionId:'synthetic-lineage',appAccountToken:'synthetic-token'}; },
        renewal: async () => { renewalCalls++; if (rejectNested) throw new Error('invalid nested'); return {namespace:nestedNamespace,originalTransactionId:'synthetic-lineage',appAccountToken:'synthetic-token'}; },
      },
    });
    return {inbox,caps,authority};
  };
  const initial = compose();
  const request = (payload = 'synthetic.opaque.one', ns = namespace, notification = notificationUUID): InboxCapture => {
    outers.set(payload,{namespace:ns,notificationUUID:notification,signedTransaction:'synthetic.transaction.proof',signedRenewal:'synthetic.renewal.proof'});
    return {operationId:operation(),receiptId:newNotificationReceiptId(),signedPayload:Buffer.from(payload),envelopeBytes:Buffer.byteLength(payload)+24,provenance:'synthetic_ingress'};
  };
  const verify = async (capture: InboxCapture, c = initial) => {
    const current = ok(c.inbox.readCapture(c.caps.metadata,capture.receiptId));
    const result = await c.inbox.verify(c.caps.verify,{operationId:operation(),receiptId:capture.receiptId,expectedVersion:current.version,custodyId:'fixture-verifier'});
    ok(result.result); return result;
  };
  const accept = async (capture = request(), c = initial) => {
    ok(c.inbox.capture(c.caps.capture,capture)); const verified = await verify(capture,c);
    assert.ok(verified.verified);
    const promoted = {operationId:operation(),receiptId:capture.receiptId,expectedVersion:ok(verified.result).version,verified:verified.verified};
    return {capture,verified,promoted,result:ok(c.inbox.promote(c.caps.promote,promoted))};
  };
  const claim = (receiptId: string,c = initial): InboxClaim => {
    const state = ok(c.inbox.readCapture(c.caps.metadata,receiptId));
    const work = db.prepare('SELECT version FROM notification_inbox_work WHERE work_id=?').get(state.workId) as {version:number};
    const result = ok(c.inbox.claim(c.caps.claim,{operationId:operation(),receiptId,expected:{receipt:state.version,work:work.version,aggregate:state.aggregateVersion!},custodyId:'fixture-processing'}));
    assert.ok(result.claim); return result.claim;
  };
  return {...initial,db,open,compose,request,verify,accept,claim,configured,
    advance:(ms:number) => {now+=ms;}, lose:(op:string) => {lose=op;}, settlement:(value:boolean) => {settled=value;},
    badSettlement:(value:boolean) => {badSettlement=value;}, nestedNamespace:(value:InboxNamespace) => {nestedNamespace=value;},
    rejectOuter:(value:boolean) => {rejectOuter=value;},rejectNested:(value:boolean) => {rejectNested=value;},
    counts:() => ({outerCalls,transactionCalls,renewalCalls}),
    rows:(table:string) => db.prepare(`SELECT * FROM notification_inbox_${table}`).all(),
  };
}
const captureInput = (request: InboxCapture) => ({kind:'capture',receiptId:request.receiptId,payloadHex:Buffer.from(request.signedPayload).toString('hex'),envelopeBytes:request.envelopeBytes,provenance:request.provenance});

test('exact UTF-8 capture survives lost response without authorizing acknowledgment; exact operation readback and changed identities',t => {
  const f = fixture(t), request = f.request('synthetic.€'); f.lose(request.operationId);
  fail(f.inbox.capture(f.caps.capture,request),'unknown_commit');
  assert.equal(f.rows('receipts').length,1); assert.equal(ok(f.inbox.readCapture(f.caps.metadata,request.receiptId)).acknowledge,false);
  assert.equal(ok(f.inbox.readOperation(f.caps.metadata,request.operationId,captureInput(request))).acknowledge,false);
  assert.equal(ok(f.inbox.capture(f.caps.capture,request)).acknowledge,false); assert.equal(f.rows('receipts').length,1);
  const proof = f.inbox.inspectProof(f.caps.proof,request.receiptId); assert.equal(proof.status,'ok');
  if (proof.status === 'ok') assert.deepEqual(Buffer.from(proof.bytes),Buffer.from(request.signedPayload));
  const digest = (f.rows('receipts')[0] as {digest:string}).digest;
  assert.equal(digest,notificationPayloadDigest(request.signedPayload));
  fail(f.inbox.capture(f.caps.capture,{...request,signedPayload:Buffer.from('synthetic.changed')}),'identity_collision');
  fail(f.inbox.capture(f.caps.capture,{...request,operationId:operation(),provenance:'synthetic_history'}),'identity_collision');
  fail(f.inbox.readOperation(f.caps.metadata,request.operationId,{...captureInput(request),envelopeBytes:2000}),'identity_collision');
});

test('independent envelope, payload and fatal UTF-8 limits refuse without retaining input',t => {
  const f=fixture(t), request=f.request();
  for (const invalid of [{...request,envelopeBytes:2049},{...request,envelopeBytes:0},
    {...request,signedPayload:Uint8Array.from([0xc3,0x28])},{...request,signedPayload:new Uint8Array(1025)}]) {
    fail(f.inbox.capture(f.caps.capture,invalid),'rejected');
  }
  assert.equal(f.rows('receipts').length,0);
});

test('a matching stored digest with unequal bytes is an integrity collision',t => {
  const f=fixture(t), first=f.request('synthetic.first'), second=Buffer.from('synthetic.second');
  ok(f.inbox.capture(f.caps.capture,first));
  // Corrupt only the disposable evidence cell; the original digest still matches replay input, bytes do not.
  f.db.prepare('UPDATE notification_inbox_payloads SET bytes=? WHERE receipt_id=?').run(second,first.receiptId);
  fail(f.inbox.capture(f.caps.capture,{...first,operationId:operation()}),'identity_collision');
});

test('promotion commits acceptance, work and reservations atomically; exact replay never repeats verification or work',async t => {
  const f=fixture(t), capture=f.request(); ok(f.inbox.capture(f.caps.capture,capture));
  const verified=await f.verify(capture); assert.ok(verified.verified);
  const promotion={operationId:operation(),receiptId:capture.receiptId,expectedVersion:ok(verified.result).version,verified:verified.verified};
  f.lose(promotion.operationId); fail(f.inbox.promote(f.caps.promote,promotion),'unknown_commit');
  const restarted=f.compose(f.open());
  const readback=ok(restarted.inbox.readAcceptance(restarted.caps.metadata,{operationId:promotion.operationId,receiptId:capture.receiptId,expectedVersion:promotion.expectedVersion,signedPayload:capture.signedPayload}));
  assert.equal(readback.acknowledge,true);
  fail(restarted.inbox.readAcceptance(restarted.caps.metadata,{operationId:promotion.operationId,receiptId:capture.receiptId,expectedVersion:promotion.expectedVersion+1,signedPayload:capture.signedPayload}),'identity_collision');
  fail(restarted.inbox.readAcceptance(restarted.caps.metadata,{operationId:promotion.operationId,receiptId:capture.receiptId,expectedVersion:promotion.expectedVersion,signedPayload:Buffer.from('changed')}),'identity_collision');
  ok(f.inbox.promote(f.caps.promote,promotion));
  assert.equal(f.rows('work').length,1); assert.equal(f.rows('aggregates').length,1);
  fail(f.inbox.promote(f.caps.promote,{...promotion,operationId:operation(),verified:{...verified.verified} as VerifiedInboxNotification}),'rejected');
  assert.equal(f.rows('reservations').filter(row=>(row as {reservation_id:string}).reservation_id.startsWith('accepted:')).length,1);
  const calls=f.counts(); const duplicate=await f.accept(f.request());
  assert.equal(duplicate.result.workId,readback.workId); assert.equal(f.rows('work').length,1);
  assert.deepEqual(f.counts(),{outerCalls:calls.outerCalls+1,transactionCalls:calls.transactionCalls+1,renewalCalls:calls.renewalCalls+1});
  fail(f.inbox.promote(f.caps.promote,{...promotion,expectedVersion:promotion.expectedVersion+1}),'rejected');
});

test('fault while persisting work rolls back authentication acceptance and subdivision of completion reserve',async t => {
  const f=fixture(t), capture=f.request(); ok(f.inbox.capture(f.caps.capture,capture));const verified=await f.verify(capture);assert.ok(verified.verified);
  const before=f.rows('reservations');
  f.db.exec("CREATE TRIGGER fail_inbox_work BEFORE INSERT ON notification_inbox_work BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  fail(f.inbox.promote(f.caps.promote,{operationId:operation(),receiptId:capture.receiptId,expectedVersion:ok(verified.result).version,verified:verified.verified}),'unknown_commit');
  assert.equal(f.rows('work').length,0);assert.equal(f.rows('aggregates').length,0);assert.deepEqual(f.rows('reservations'),before);
  assert.equal(ok(f.inbox.readCapture(f.caps.metadata,capture.receiptId)).acknowledge,false);
});

test('outer and every present nested proof are separately verified; forged and mismatched values cannot promote',async t => {
  const f=fixture(t), capture=f.request();ok(f.inbox.capture(f.caps.capture,capture));
  for (const forged of [{},{verified:true},{namespace,notificationUUID}]) {
    fail(f.inbox.promote(f.caps.promote,{operationId:operation(),receiptId:capture.receiptId,expectedVersion:1,verified:forged as VerifiedInboxNotification}),'rejected');
  }
  f.nestedNamespace(otherNamespace);
  const invalid=await f.verify(capture);assert.equal(invalid.verified,undefined);
  assert.equal(ok(f.inbox.readCapture(f.caps.metadata,capture.receiptId)).acknowledge,false);
  assert.equal(f.rows('work').length,0);assert.equal(f.counts().transactionCalls,1);
  const valid=await f.accept(f.request('synthetic.valid',otherNamespace));assert.equal(valid.result.acknowledge,true);
  assert.equal(f.counts().renewalCalls,1);
});

test('invalid outer, nested rejection and nested byte overflow retain rejected evidence without work or exception text',async t => {
  const f=fixture(t);
  for(const kind of ['outer','nested','oversize'] as const){
    f.rejectOuter(kind==='outer');f.rejectNested(kind==='nested');
    const capture=f.request('synthetic.'+kind);ok(f.inbox.capture(f.caps.capture,capture));
    if(kind==='oversize'){
      const other=new NotificationInbox(f.db,{use:'isolated-synthetic',ingress:'fixture',now:()=>1000,afterCommit:()=>{},
        settlement:attempt=>{const r=f.db.prepare('SELECT custody_id,generation FROM notification_inbox_claims WHERE attempt_id=?').get(attempt) as {custody_id:string;generation:number};return {settled:true,custodyId:r.custody_id,generation:r.generation};},
        verifier:{outer:async()=>({namespace,notificationUUID,signedTransaction:'x'.repeat(129),signedRenewal:null}),transaction:async()=>{throw new Error('must not call');},renewal:async()=>{throw new Error('must not call');}}});
      const result=await other.verify(f.caps.verify,{operationId:operation(),receiptId:capture.receiptId,expectedVersion:1,custodyId:'fixture-verifier'});assert.equal(result.verified,undefined);
    }else assert.equal((await f.verify(capture)).verified,undefined);
    assert.equal(ok(f.inbox.readCapture(f.caps.metadata,capture.receiptId)).acknowledge,false);
  }
  assert.equal(f.rows('work').length,0);assert.equal(JSON.stringify(f.rows('transitions')).includes('private-error'),false);
});

for(const order of [['synthetic.a','synthetic.b'],['synthetic.b','synthetic.a']])test(`aggregate collision fences queued and claimed work in arrival order ${order.join(',')}`,async t=>{
  const f=fixture(t),first=await f.accept(f.request(order[0]!)),claim=f.claim(first.capture.receiptId);
  f.settlement(false);const secondCapture=f.request(order[1]!);ok(f.inbox.capture(f.caps.capture,secondCapture));
  f.settlement(true);const verification=await f.verify(secondCapture);assert.ok(verification.verified);
  const conflict=ok(f.inbox.promote(f.caps.promote,{operationId:operation(),receiptId:secondCapture.receiptId,expectedVersion:ok(verification.result).version,verified:verification.verified}));
  assert.equal(conflict.disposition,'held_conflict');assert.equal(conflict.acknowledge,true);
  assert.equal(ok(f.inbox.readCapture(f.caps.metadata,first.capture.receiptId)).disposition,'held_conflict');
  fail(f.inbox.finishInboxOnly(f.caps.complete,{operationId:operation(),claim,disposition:'completed',reason:'unsupported'}),'held_conflict');
  for(const payload of order){const replay=await f.accept(f.request(payload));assert.equal(replay.result.disposition,'held_conflict');}
  const aggregates=f.rows('aggregates') as {conflicted:number;invalidation_required:number}[];
  assert.equal(aggregates[0]!.conflicted,1);assert.equal(aggregates[0]!.invalidation_required,1);
  assert.equal((f.rows('claims') as {attempt_id:string;cancel_requested:number;settled:number}[]).find(c=>c.attempt_id===claim.processingAttemptId)!.settled,0);
  const current=ok(f.inbox.readCapture(f.caps.metadata,claim.receiptId));
  ok(f.inbox.settleFencedClaim(f.caps.complete,{operationId:operation(),claim,expectedVersion:current.version}));
  assert.equal((f.rows('claims') as {attempt_id:string;settled:number}[]).find(c=>c.attempt_id===claim.processingAttemptId)!.settled,1);
});

test('post-application collision preserves the applied fact and durable invalidation obligation',async t=>{
  const f=fixture(t),first=await f.accept(),claim=f.claim(first.capture.receiptId);
  f.db.exec('CREATE TABLE synthetic_application (effect TEXT PRIMARY KEY)');
  const committer=f.inbox.createSyntheticPurchaseCommitter(f.caps.complete,{use:'isolated-synthetic'});
  ok(committer.commit({operationId:operation(),claim,applicationInput:'synthetic-effect'},db=>db.prepare('INSERT INTO synthetic_application VALUES(?)').run('applied'),()=>true));
  const second=await f.accept(f.request('synthetic.collision'));assert.equal(second.result.disposition,'held_conflict');
  assert.equal((f.db.prepare('SELECT count(*) n FROM synthetic_application').get() as {n:number}).n,1);
  assert.ok((f.rows('transitions') as {snapshot_json:string}[]).some(r=>JSON.parse(r.snapshot_json).processingDisposition==='applied'));
  const replay=ok(f.inbox.promote(f.caps.promote,first.promoted));assert.equal(replay.disposition,'held_conflict');
});

test('variant overflow cannot consume reserved conflict control capacity or leave a first winner',async t=>{
  const f=fixture(t,{maxVariants:1,variantBytes:policy.recordOverheadBytes*4});const first=await f.accept();
  const second=await f.accept(f.request('synthetic.overflow'));assert.equal(second.result.disposition,'held_conflict');
  assert.equal(f.rows('variants').length,1);assert.equal((f.rows('aggregates')[0] as {overflow:number}).overflow,1);
  assert.equal(ok(f.inbox.readCapture(f.caps.metadata,first.capture.receiptId)).disposition,'held_conflict');
  assert.equal(f.rows('receipts').length,2);assert.equal(f.rows('payloads').length,2);
});

test('authenticated namespaces isolate identical UUIDs and exact proof bytes',async t=>{
  const f=fixture(t);const sandbox=await f.accept();f.nestedNamespace(otherNamespace);
  const production=await f.accept(f.request('synthetic.production',otherNamespace));
  assert.notEqual(sandbox.result.workId,production.result.workId);assert.equal(f.rows('aggregates').length,2);
  assert.ok((f.rows('aggregates') as {conflicted:number}[]).every(a=>a.conflicted===0));
});

test('capabilities separate admission, metadata, proof, replay and disposal; copies and receipt possession fail closed',async t=>{
  const f=fixture(t),accepted=await f.accept();
  const receiptId=accepted.capture.receiptId;
  for(const forged of [{},{admin:true},{verified:true},{...f.caps.metadata}]){
    fail(f.inbox.readCapture(forged as InboxCapability,receiptId),'unavailable');
    assert.equal(f.inbox.inspectProof(forged as InboxCapability,receiptId).status,'unavailable');
  }
  assert.equal(f.inbox.inspectProof(f.caps.metadata,receiptId).status,'unavailable');
  fail(f.inbox.readCapture(f.caps.proof,receiptId),'unavailable');
  fail(f.inbox.requestReplay(f.caps.proof,{operationId:operation(),receiptId,expectedVersion:accepted.result.version,expectedDisposition:'held',reason:'reconsider_owner'}),'unavailable');
  fail(f.inbox.disposePayload(f.caps.replay,{operationId:operation(),receiptId,expectedVersion:accepted.result.version}),'unavailable');
  for(const permission of ['metadata','proof','replay','dispose'] as const){
    f.authority.revoke(f.caps[permission]);
  }
  fail(f.inbox.readCapture(f.caps.metadata,receiptId),'unavailable');
  assert.equal(f.inbox.inspectProof(f.caps.proof,receiptId).status,'unavailable');
  assert.equal(f.rows('payloads').length,1);
});

test('cross-handle, namespace, generation and policy bindings fail independently',async t=>{
  const f=fixture(t),accepted=await f.accept();const second=f.compose(f.open());
  assert.throws(()=>createSyntheticInboxAuthority(f.db,{use:'isolated-synthetic',ingress:'foreign-domain'}));
  fail(second.inbox.readCapture(f.caps.metadata,accepted.capture.receiptId),'unavailable');
  const wrong=f.authority.issue('proof',{ingress:'fixture',namespaces:[otherNamespace],receiptId:null});
  assert.equal(f.inbox.inspectProof(wrong,accepted.capture.receiptId).status,'unavailable');
  const bound=f.authority.issue('proof',{ingress:'fixture',namespaces:[namespace],receiptId:newNotificationReceiptId()});
  assert.equal(f.inbox.inspectProof(bound,accepted.capture.receiptId).status,'unavailable');
  f.db.prepare("UPDATE notification_inbox_store SET generation='generation2'").run();
  fail(f.inbox.readCapture(f.caps.metadata,accepted.capture.receiptId),'unavailable');
  const generation2=f.compose();
  f.db.prepare('UPDATE notification_inbox_store SET policy_json=?').run(JSON.stringify({...policy,revision:'fixture2'}));
  fail(generation2.inbox.readCapture(generation2.caps.metadata,accepted.capture.receiptId),'unavailable');
});

test('revoked admission cannot capture or promote and revoked completion preserves original claim and reserve',async t=>{
  const f=fixture(t),capture=f.request();ok(f.inbox.capture(f.caps.capture,capture));const verified=await f.verify(capture);assert.ok(verified.verified);
  f.authority.revoke(f.caps.promote);
  fail(f.inbox.promote(f.caps.promote,{operationId:operation(),receiptId:capture.receiptId,expectedVersion:ok(verified.result).version,verified:verified.verified}),'unavailable');
  f.authority.revoke(f.caps.capture);fail(f.inbox.capture(f.caps.capture,f.request('synthetic.new')),'unavailable');
  const next=f.compose(),accepted=await f.accept(f.request('synthetic.ready'),next),claim=f.claim(accepted.capture.receiptId,next);
  const reservations=f.rows('reservations');next.authority.revoke(next.caps.complete);
  fail(next.inbox.finishInboxOnly(next.caps.complete,{operationId:operation(),claim,disposition:'held',reason:'unknown_owner'}),'unavailable');
  assert.deepEqual(f.rows('reservations'),reservations);
  assert.equal((f.rows('claims') as {attempt_id:string;settled:number}[]).find(row=>row.attempt_id===claim.processingAttemptId)!.settled,0);
});

test('two connections enforce quota atomically while preserving accepted completion headroom',async t=>{
  const charge=2*policy.maxTransitions*(policy.maxOperationBytes+16*policy.recordOverheadBytes);
  const f=fixture(t,{maxReceipts:2,completionBytes:2*charge}),second=f.compose(f.open());
  const accepted=await f.accept(),claim=f.claim(accepted.capture.receiptId);
  f.db.transaction(()=>fail(second.inbox.capture(second.caps.capture,f.request('synthetic.locked')),'unavailable')).immediate();
  ok(second.inbox.capture(second.caps.capture,f.request('synthetic.untrusted')));
  const reserve=f.rows('reservations');
  fail(second.inbox.capture(second.caps.capture,f.request('synthetic.exhausted')),'capacity_exhausted');
  assert.deepEqual(f.rows('reservations'),reserve);
  ok(f.inbox.finishInboxOnly(f.caps.complete,{operationId:operation(),claim,disposition:'held',reason:'unknown_owner'}));
  const retained=(f.rows('reservations') as {pool:string;bytes:number}[]).filter(r=>r.pool==='completion').reduce((n,r)=>n+r.bytes,0);
  assert.equal(retained,2*charge);
});

test('verification concurrency and uncertain verification admission survive reopen without replacement dispatch',async t=>{
  const f=fixture(t,{maxVerificationClaims:1});f.settlement(false);
  const capture=f.request();ok(f.inbox.capture(f.caps.capture,capture));
  const verified=await f.verify(capture);assert.equal(verified.verified,undefined);
  assert.equal((f.rows('claims')[0] as {settled:number}).settled,0);
  const second=f.compose(f.open()),next=f.request('synthetic.next');ok(second.inbox.capture(second.caps.capture,next));
  const denied=await second.inbox.verify(second.caps.verify,{operationId:operation(),receiptId:next.receiptId,expectedVersion:1,custodyId:'fixture-verifier'});
  fail(denied.result,'capacity_exhausted');const calls=f.counts();
  f.advance(5000);
  const state=ok(second.inbox.readCapture(second.caps.metadata,capture.receiptId));
  fail(second.inbox.requestReplay(second.caps.replay,{operationId:operation(),receiptId:capture.receiptId,expectedVersion:state.version,expectedDisposition:'held',reason:'retry_verification'}),'unavailable');
  assert.deepEqual(f.counts(),calls);
  f.settlement(true);const attempt=(f.rows('claims')[0] as {attempt_id:string}).attempt_id;
  ok(second.inbox.reconcileVerification(second.caps.verify,{operationId:operation(),receiptId:capture.receiptId,expectedVersion:state.version,verificationAttemptId:attempt}));
  const current=ok(second.inbox.readCapture(second.caps.metadata,capture.receiptId));
  ok(second.inbox.requestReplay(second.caps.replay,{operationId:operation(),receiptId:capture.receiptId,expectedVersion:current.version,expectedDisposition:'held',reason:'retry_verification'}));
  assert.deepEqual(f.counts(),calls);const recovered=await f.verify(capture,second);assert.ok(recovered.verified);
});

test('lost verification response leaves a durable claim; same operation never starts its producer twice',async t=>{
  const f=fixture(t),capture=f.request();ok(f.inbox.capture(f.caps.capture,capture));
  const request={operationId:operation(),receiptId:capture.receiptId,expectedVersion:1,custodyId:'fixture-verifier'};f.lose(request.operationId);
  fail((await f.inbox.verify(f.caps.verify,request)).result,'unknown_commit');assert.equal(f.counts().outerCalls,0);
  fail((await f.inbox.verify(f.caps.verify,request)).result,'unavailable');assert.equal(f.counts().outerCalls,0);
  assert.equal((f.rows('claims')[0] as {settled:number}).settled,0);
});

test('claim CAS and custody bind receipt, work, aggregate and generation; cancel, time and restart never settle resources',async t=>{
  const f=fixture(t),accepted=await f.accept(),claim=f.claim(accepted.capture.receiptId);f.settlement(false);
  const reservations=f.rows('reservations');
  for(const forged of [{...claim,generation:claim.generation+1},{...claim,custodyId:'different'},
    {...claim,storeGeneration:'old'},{...claim,versions:{...claim.versions,work:claim.versions.work+1}},
    {...claim,versions:{...claim.versions,receipt:claim.versions.receipt+1}},{...claim,versions:{...claim.versions,aggregate:claim.versions.aggregate+1}}]) {
    fail(f.inbox.finishInboxOnly(f.caps.complete,{operationId:operation(),claim:forged,disposition:'completed',reason:'unsupported'}),'version_conflict');
  }
  const held=ok(f.inbox.requestCancellation(f.caps.complete,{operationId:operation(),claim}));assert.ok(held.claim);
  f.advance(5000);const next=f.compose(f.open());
  fail(next.inbox.finishInboxOnly(next.caps.complete,{operationId:operation(),claim:held.claim,disposition:'completed',reason:'unsupported'}),'unavailable');
  fail(next.inbox.requestReplay(next.caps.replay,{operationId:operation(),receiptId:claim.receiptId,expectedVersion:held.version,expectedDisposition:'held',reason:'reconsider_owner'}),'unavailable');
  assert.deepEqual(f.rows('reservations'),reservations);
  f.settlement(true);f.badSettlement(true);
  fail(f.inbox.finishInboxOnly(f.caps.complete,{operationId:operation(),claim:held.claim,disposition:'held',reason:'unknown_owner'}),'unavailable');
  f.badSettlement(false);ok(f.inbox.finishInboxOnly(f.caps.complete,{operationId:operation(),claim:held.claim,disposition:'held',reason:'unknown_owner'}));
});

test('metadata is an exact allowlist and proof read neither reveals replay authority nor mints it',async t=>{
  const f=fixture(t),accepted=await f.accept();const listing=f.inbox.listMetadata(f.caps.metadata,filter,10);assert.equal(listing.status,'ok');
  if(listing.status!=='ok')return;
  const keys=['receiptId','aggregateReference','namespace','receiptSequence','receivedAt','byteLength','authentication','processingDisposition','stateVersion','reason','payloadAvailable','retryEligible'].sort();
  for(const row of listing.records)assert.deepEqual(Object.keys(row).sort(),keys);
  const serialized=JSON.stringify(listing.records);
  for(const secret of ['synthetic.transaction.proof','synthetic-token','synthetic-lineage','private-error','signedPayload','accountId','ownerId'])assert.equal(serialized.includes(secret),false);
  const proof=f.inbox.inspectProof(f.caps.proof,accepted.capture.receiptId);assert.equal(proof.status,'ok');
  fail(f.inbox.requestReplay(f.caps.proof,{operationId:operation(),receiptId:accepted.capture.receiptId,expectedVersion:accepted.result.version,expectedDisposition:'pending',reason:'reconsider_owner'}),'unavailable');
});

test('replay requires exact version, held reason, retained proof and fresh reservation; disposal revokes equality and replay',async t=>{
  const f=fixture(t),accepted=await f.accept(),claim=f.claim(accepted.capture.receiptId);
  const terminal=ok(f.inbox.finishInboxOnly(f.caps.complete,{operationId:operation(),claim,disposition:'held',reason:'unknown_owner'}));
  const replay={operationId:operation(),receiptId:claim.receiptId,expectedVersion:terminal.version,expectedDisposition:'held' as const,reason:'reconsider_owner' as const};
  fail(f.inbox.requestReplay(f.caps.replay,{...replay,expectedVersion:terminal.version-1}),'version_conflict');
  fail(f.inbox.requestReplay(f.caps.replay,{...replay,reason:'retry_verification'}),'rejected');
  const before=f.rows('reservations').length;ok(f.inbox.requestReplay(f.caps.replay,replay));assert.equal(f.rows('reservations').length,before+1);
  const next=f.claim(claim.receiptId),held=ok(f.inbox.finishInboxOnly(f.caps.complete,{operationId:operation(),claim:next,disposition:'held',reason:'unknown_owner'}));
  fail(f.inbox.disposePayload(f.caps.dispose,{operationId:operation(),receiptId:claim.receiptId,expectedVersion:held.version}),'unavailable');
  f.advance(10000);
  const disposed=ok(f.inbox.disposePayload(f.caps.dispose,{operationId:operation(),receiptId:claim.receiptId,expectedVersion:held.version}));
  assert.equal(f.rows('payloads').length,0);assert.equal(f.rows('disposals').length,1);
  assert.equal(f.inbox.inspectProof(f.caps.proof,claim.receiptId).status,'payload_unavailable');
  fail(f.inbox.requestReplay(f.caps.replay,{...replay,operationId:operation(),expectedVersion:disposed.version}),'payload_unavailable');
  fail(f.inbox.capture(f.caps.capture,{...accepted.capture,operationId:operation()}),'payload_unavailable');
  fail(f.inbox.readOperation(f.caps.metadata,accepted.capture.operationId,captureInput(accepted.capture)),'payload_unavailable');
  const retained=JSON.stringify(f.rows('operations'));
  assert.equal(retained.includes(Buffer.from(accepted.capture.signedPayload).toString('hex')),false);
  assert.equal(retained.includes('synthetic.transaction.proof'),false);
  assert.equal(retained.includes('synthetic.renewal.proof'),false);
});

test('pagination freezes transition highwater and filters across concurrent mutation; changed authority is stale',async t=>{
  const f=fixture(t),a=f.request('synthetic.a'),b=f.request('synthetic.b');
  ok(f.inbox.capture(f.caps.capture,a));ok(f.inbox.capture(f.caps.capture,b));
  const first=f.inbox.listMetadata(f.caps.metadata,filter,1);assert.equal(first.status,'ok');if(first.status!=='ok')return;assert.ok(first.cursor);
  await f.verify(a);const c=f.request('synthetic.c');ok(f.inbox.capture(f.caps.capture,c));
  const second=f.inbox.listMetadata(f.caps.metadata,filter,1,first.cursor);assert.equal(second.status,'ok');if(second.status!=='ok')return;
  assert.deepEqual([...first.records,...second.records].map(r=>r.receiptId),[a.receiptId,b.receiptId]);assert.equal(second.cursor,null);
  assert.equal(f.inbox.listMetadata(f.caps.metadata,{...filter,authentication:'captured'},1,first.cursor).status,'stale_cursor');
  const newPermission=f.authority.issue('metadata',{ingress:'fixture',namespaces:[namespace],receiptId:null});
  assert.equal(f.inbox.listMetadata(newPermission,filter,1,first.cursor).status,'stale_cursor');
  f.authority.revoke(f.caps.metadata);assert.equal(f.inbox.listMetadata(f.caps.metadata,filter,1,first.cursor).status,'unavailable');
});

test('explicit finite audit disposal invalidates retained cursors and cannot imply exact deduplication',t=>{
  const f=fixture(t),a=f.request(),b=f.request('synthetic.b');ok(f.inbox.capture(f.caps.capture,a));ok(f.inbox.capture(f.caps.capture,b));
  const first=f.inbox.listMetadata(f.caps.metadata,filter,1);assert.equal(first.status,'ok');if(first.status!=='ok')return;assert.ok(first.cursor);
  fail(f.inbox.expireIdentityAndAudit(f.caps.dispose,{operationId:operation(),receiptId:a.receiptId,expectedVersion:1}),'unavailable');
  f.advance(30000);ok(f.inbox.expireIdentityAndAudit(f.caps.dispose,{operationId:operation(),receiptId:a.receiptId,expectedVersion:1}));
  assert.equal(f.inbox.listMetadata(f.caps.metadata,filter,1,first.cursor).status,'history_unavailable');
  assert.equal(f.rows('receipts').length,1);assert.equal(f.rows('reservations').length,2);
  fail(f.inbox.readCapture(f.caps.metadata,a.receiptId),'unavailable');
});

test('private same-handle purchase frame atomically rolls back application and completion on every failed boundary',async t=>{
  const f=fixture(t),accepted=await f.accept(),claim=f.claim(accepted.capture.receiptId);
  f.db.exec('CREATE TABLE synthetic_application (effect TEXT PRIMARY KEY)');
  const committer=f.inbox.createSyntheticPurchaseCommitter(f.caps.complete,{use:'isolated-synthetic'}),reservations=f.rows('reservations');
  let saved:PurchaseCommitFrame|undefined;
  const apply=(db:Database.Database,frame:PurchaseCommitFrame)=>{assert.equal(db,f.db);saved=frame;db.prepare('INSERT INTO synthetic_application VALUES(?)').run('atomic');};
  const request={operationId:operation(),claim,applicationInput:'exact-synthetic-application'};
  fail(committer.commit(request,(db,frame)=>{apply(db,frame);f.inbox.completeWithinPurchaseCommit(frame,claim);throw new Error('rollback after completion');},()=>true),'unknown_commit');
  assert.equal((f.db.prepare('SELECT count(*) n FROM synthetic_application').get() as {n:number}).n,0);
  assert.equal((f.rows('claims') as {attempt_id:string;settled:number}[]).find(r=>r.attempt_id===claim.processingAttemptId)!.settled,0);
  assert.deepEqual(f.rows('reservations'),reservations);assert.ok(saved);
  assert.throws(()=>f.inbox.completeWithinPurchaseCommit(saved!,claim));
  assert.throws(()=>f.inbox.completeWithinPurchaseCommit({} as PurchaseCommitFrame,claim));
  fail(committer.commit({...request,operationId:operation()},(db,frame)=>{apply(db,frame);return Promise.resolve();},()=>true),'rejected');
  fail(committer.commit({...request,operationId:operation()},apply,()=>Promise.resolve(true)),'unavailable');
  let checks=0;fail(committer.commit({...request,operationId:operation()},apply,()=>++checks===1),'unavailable');
  const foreign=f.compose(f.open());
  fail(committer.commit({...request,operationId:operation()},(db,frame)=>{apply(db,frame);foreign.inbox.completeWithinPurchaseCommit(frame,claim);},()=>true),'rejected');
  fail(committer.commit({...request,operationId:operation()},(db,frame)=>{apply(db,frame);committer.commit({...request,operationId:operation()},()=>{},()=>true);},()=>true),'rejected');
  assert.equal((f.db.prepare('SELECT count(*) n FROM synthetic_application').get() as {n:number}).n,0);
  f.lose(request.operationId);fail(committer.commit(request,apply,()=>true),'unknown_commit');
  assert.equal((f.db.prepare('SELECT count(*) n FROM synthetic_application').get() as {n:number}).n,1);
  ok(committer.commit(request,()=>{throw new Error('must not reapply');},()=>true));
  fail(committer.commit({...request,applicationInput:'changed'},()=>{},()=>true),'identity_collision');
});

test('purchase frame refuses another live claim even when refusal is caught and rolls back both claims',async t=>{
  const f=fixture(t),a=await f.accept(),b=await f.accept(f.request('synthetic.b',namespace,randomUUID()));
  const claimA=f.claim(a.capture.receiptId),claimB=f.claim(b.capture.receiptId);
  f.db.exec('CREATE TABLE synthetic_application (effect TEXT PRIMARY KEY)');
  const committer=f.inbox.createSyntheticPurchaseCommitter(f.caps.complete,{use:'isolated-synthetic'});
  const tables=['state','work','claims','transitions','operations','reservations'];
  const before=tables.map(table=>f.rows(table));
  for(const boundary of ['uncaught','caught-before-completion','caught-after-completion','caught-in-final-guard']){
    const request={operationId:operation(),claim:claimA,applicationInput:'application-a'};
    let liveFrame:PurchaseCommitFrame|undefined;
    fail(committer.commit(request,(db,frame)=>{
      liveFrame=frame;
      assert.equal(db,f.db);db.prepare('INSERT INTO synthetic_application VALUES(?)').run('a');
      if(boundary==='uncaught')f.inbox.completeWithinPurchaseCommit(frame,claimB);
      else if(boundary!=='caught-in-final-guard'){
        if(boundary==='caught-after-completion')f.inbox.completeWithinPurchaseCommit(frame,claimA);
        assert.throws(()=>f.inbox.completeWithinPurchaseCommit(frame,claimB));
        if(boundary==='caught-before-completion')f.inbox.completeWithinPurchaseCommit(frame,claimA);
      }
    },()=>{
      if(boundary==='caught-in-final-guard'&&liveFrame)assert.throws(()=>f.inbox.completeWithinPurchaseCommit(liveFrame!,claimB));
      return true;
    }),'rejected');
    assert.deepEqual(f.db.prepare('SELECT * FROM synthetic_application').all(),[]);
    assert.deepEqual(tables.map(table=>f.rows(table)),before);
    for(const claim of [claimA,claimB]){
      assert.equal(ok(f.inbox.readCapture(f.caps.metadata,claim.receiptId)).disposition,'claimed');
      assert.equal((f.rows('claims') as {attempt_id:string;settled:number}[]).find(row=>row.attempt_id===claim.processingAttemptId)!.settled,0);
    }
  }
  const request={applicationInput:'application-a',claim:claimA,operationId:operation()};
  const applied=ok(committer.commit(request,(db,frame)=>{
    db.prepare('INSERT INTO synthetic_application VALUES(?)').run('a');
    const exact={...claimA,versions:{aggregate:claimA.versions.aggregate,work:claimA.versions.work,receipt:claimA.versions.receipt}};
    assert.equal(f.inbox.completeWithinPurchaseCommit(frame,exact).disposition,'applied');
  },()=>true));
  assert.equal(applied.receiptId,claimA.receiptId);assert.equal(applied.disposition,'applied');
  assert.equal((f.rows('claims') as {attempt_id:string;settled:number}[]).find(row=>row.attempt_id===claimA.processingAttemptId)!.settled,1);
  assert.deepEqual(f.db.prepare('SELECT * FROM synthetic_application').all(),[{effect:'a'}]);
  assert.equal(ok(f.inbox.readCapture(f.caps.metadata,claimB.receiptId)).disposition,'claimed');
  assert.equal((f.rows('claims') as {attempt_id:string;settled:number}[]).find(row=>row.attempt_id===claimB.processingAttemptId)!.settled,0);
  assert.deepEqual(ok(f.inbox.readOperation(f.caps.metadata,request.operationId,{kind:'purchase_commit',...request})),applied);
  assert.deepEqual(ok(committer.commit(request,()=>{throw new Error('must not repeat application');},()=>true)),applied);
});

test('purchase request claim versions and operation identity are immutable across guard callbacks',async t=>{
  const f=fixture(t),a=await f.accept(),b=await f.accept(f.request('synthetic.b',namespace,randomUUID()));
  const claimA=f.claim(a.capture.receiptId),claimB=f.claim(b.capture.receiptId);
  f.db.exec('CREATE TABLE synthetic_application (effect TEXT PRIMARY KEY)');
  const committer=f.inbox.createSyntheticPurchaseCommitter(f.caps.complete,{use:'isolated-synthetic'});
  const request={operationId:operation(),claim:{...claimA,versions:{...claimA.versions}},applicationInput:'application-a'};
  const original={operationId:request.operationId,claim:claimA,applicationInput:request.applicationInput};
  const bBefore=['state','work','claims'].map(table=>f.rows(table));
  const applied=ok(committer.commit(request,db=>{db.prepare('INSERT INTO synthetic_application VALUES(?)').run('a');},()=>{
    request.claim.versions.receipt+=100;
    Object.assign(request.claim,claimB,{versions:{...claimB.versions}});
    request.operationId=operation();request.applicationInput='application-b';
    return true;
  }));
  assert.equal(applied.receiptId,claimA.receiptId);assert.equal(applied.disposition,'applied');
  assert.equal(applied.version,claimA.versions.receipt+1);
  assert.deepEqual(f.db.prepare('SELECT * FROM synthetic_application').all(),[{effect:'a'}]);
  for(const [index,table] of ['state','work','claims'].entries()){
    const forB=(rows:unknown[])=>rows.filter(row=>(row as {receipt_id:string}).receipt_id===claimB.receiptId);
    assert.deepEqual(forB(f.rows(table)),forB(bBefore[index]!));
  }
  assert.deepEqual(ok(f.inbox.readOperation(f.caps.metadata,original.operationId,{kind:'purchase_commit',...original})),applied);
  fail(f.inbox.readOperation(f.caps.metadata,original.operationId,{kind:'purchase_commit',...request,operationId:original.operationId}),'identity_collision');
  assert.equal(f.db.prepare('SELECT 1 FROM notification_inbox_operations WHERE operation_id=?').get(request.operationId),undefined);
});

test('purchase commit requires the bound receipt work and claim to remain applied and settled after the final guard',async t=>{
  const f=fixture(t),accepted=await f.accept(),claim=f.claim(accepted.capture.receiptId);
  f.db.exec('CREATE TABLE synthetic_application (effect TEXT PRIMARY KEY)');
  const committer=f.inbox.createSyntheticPurchaseCommitter(f.caps.complete,{use:'isolated-synthetic'});
  const tables=['state','work','claims','transitions','operations','reservations'],before=tables.map(table=>f.rows(table));
  for(const target of ['state','work','claim']){
    let guards=0;
    fail(committer.commit({operationId:operation(),claim,applicationInput:'application-a'},db=>{
      db.prepare('INSERT INTO synthetic_application VALUES(?)').run('a');
    },()=>{
      if(++guards===2){
        if(target==='state')f.db.prepare("UPDATE notification_inbox_state SET disposition='claimed' WHERE receipt_id=?").run(claim.receiptId);
        if(target==='work')f.db.prepare("UPDATE notification_inbox_work SET disposition='claimed' WHERE work_id=?").run(claim.workId);
        if(target==='claim')f.db.prepare('UPDATE notification_inbox_claims SET settled=0 WHERE attempt_id=?').run(claim.processingAttemptId);
      }
      return true;
    }),'rejected');
    assert.equal(guards,2);assert.deepEqual(f.db.prepare('SELECT * FROM synthetic_application').all(),[]);
    assert.deepEqual(tables.map(table=>f.rows(table)),before);
  }
});

test('unknown completion readback preserves original operation and changed completion input collides',async t=>{
  const f=fixture(t),accepted=await f.accept(),claim=f.claim(accepted.capture.receiptId);
  const request={operationId:operation(),claim,disposition:'held' as const,reason:'unknown_owner' as const};f.lose(request.operationId);
  fail(f.inbox.finishInboxOnly(f.caps.complete,request),'unknown_commit');
  const readback=ok(f.inbox.readOperation(f.caps.metadata,request.operationId,{kind:'finish',...request}));assert.equal(readback.disposition,'held');
  ok(f.inbox.finishInboxOnly(f.caps.complete,request));
  fail(f.inbox.finishInboxOnly(f.caps.complete,{...request,reason:'unsupported'}),'identity_collision');
});

test('schema import is unregistered, fresh-only and exact; inbox operations create no purchase or account authority',async t=>{
  const empty=new Database(':memory:');t.after(()=>empty.close());
  assert.equal(empty.prepare('SELECT name FROM sqlite_master').all().length,0);
  assert.throws(()=>initializeSyntheticNotificationInbox(empty,{use:'isolated-synthetic',storeId:'fixture',generation:'generation1',ingress:'fixture',policy:undefined as never}));
  const f=fixture(t);assertNotificationInboxSchema(f.db);
  assert.throws(()=>initializeSyntheticNotificationInbox(f.db,{use:'isolated-synthetic',storeId:'fixture',generation:'generation1',ingress:'fixture',policy}));
  await f.accept();
  const tables=(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name);
  assert.ok(tables.every(name=>name==='sqlite_sequence'||name.startsWith('notification_inbox_')));
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../src');
  const imports:string[]=[];
  const walk=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())walk(path);else if(entry.name.endsWith('.ts')&&!entry.name.startsWith('notification-inbox')){if(readFileSync(path,'utf8').includes('notification-inbox'))imports.push(path);}}};
  walk(root);assert.deepEqual(imports,[]);
  f.db.exec('CREATE INDEX notification_inbox_unexpected ON notification_inbox_state(version)');assert.throws(()=>assertNotificationInboxSchema(f.db));
});


test('changing a Production app ID cannot silently create another aggregate namespace',async t=>{
  const f=fixture(t);f.nestedNamespace(otherNamespace);await f.accept(f.request('synthetic.production',otherNamespace));
  const changed:InboxNamespace={...otherNamespace,appAppleId:124}, composition=f.compose(f.db,[changed]);
  f.nestedNamespace(changed);const capture=f.request('synthetic.changed-app',changed);ok(composition.inbox.capture(composition.caps.capture,capture));
  const verification=await f.verify(capture,composition);assert.ok(verification.verified);
  fail(composition.inbox.promote(composition.caps.promote,{operationId:operation(),receiptId:capture.receiptId,expectedVersion:ok(verification.result).version,verified:verification.verified}),'identity_collision');
  assert.equal(f.rows('aggregates').length,1);assert.equal(f.rows('work').length,1);
});
