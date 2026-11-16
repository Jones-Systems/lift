import { createHash, randomUUID } from 'node:crypto';
import type { Sqlite } from '../storage.js';
import { assertNotificationInboxSchema } from './notification-inbox-schema.js';
import { checkInboxCapability, inboxStore, namespaceKey } from './notification-inbox-capabilities.js';
import type { InboxAuthentication, InboxCapability, InboxCapture, InboxClaim, InboxCursor, InboxDisposition,
  InboxFailure, InboxMetadata, InboxNamespace, InboxNamespaceIdentity, InboxNested, InboxOuter, InboxPolicy, InboxReason, InboxResult,
  InboxSettlement, InboxSuccess, InboxVersions, PurchaseCommitFrame, SyntheticInboxVerifier, VerifiedInboxNotification } from './notification-inbox.types.js';

type State = { receipt_id: string; version: number; authentication: InboxAuthentication; disposition: InboxDisposition;
  reason: InboxReason; aggregate_id: string | null; work_id: string | null; attempts: number; transition_count: number };
type Receipt = { sequence: number; receipt_id: string; byte_length: number; received_at: number; digest: string;
  payload_until: number; tombstone_until: number; audit_until: number; provenance: string; envelope_bytes: number };
type Aggregate = { aggregate_id: string; namespace_key: string; namespace_json: string; version: number; conflicted: number;
  invalidation_required: number; overflow: number };
type Work = { work_id: string; receipt_id: string; version: number; disposition: InboxDisposition; claim_generation: number };
type ClaimRow = { attempt_id: string; receipt_id: string; kind: string; generation: number; custody_id: string;
  store_generation: string; settled: number; cancel_requested: number };
type Prepared = { receiptId: string; version: number; attemptId: string; outer: InboxOuter; payload: Buffer;
  storeGeneration: string; policy: string; operationId: string };
type Frame = { db: Sqlite; owner: NotificationInbox; active: boolean; completed: boolean; invalid: boolean; capability: InboxCapability };
type CursorState = { owner: NotificationInbox; store: string; generation: string; policy: string; scope: string;
  filter: string; highwater: number; after: number; floor: number };
const frames = new WeakMap<object, Frame>();
const activeFrames = new WeakMap<Sqlite, Frame>();
const preparedNotifications = new WeakMap<object, Prepared>();
const cursors = new WeakMap<object, CursorState>();
const failure = (status: InboxFailure['status']): InboxFailure => ({ status, acknowledge: false });
class Refusal extends Error { constructor(readonly status: InboxFailure['status']) { super(status); } }
const refuse = (status: InboxFailure['status']): never => { throw new Refusal(status); };
const id = (value: string) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) refuse('rejected'); return value; };
const uuid = (value: string) => {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(value)) refuse('rejected');
  return value.toLowerCase();
};
const thenable = (value: unknown): boolean => value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value;
const equal = (one: Uint8Array, two: Uint8Array) => Buffer.from(one).equals(Buffer.from(two));
export const notificationPayloadDigest = (bytes: Uint8Array): string =>
  createHash('sha256').update('form.notification-inbox.signedPayload.utf8.v1\0').update(bytes).digest('hex');
export const newNotificationReceiptId = (): string => randomUUID();
export const newNotificationOperationId = (): string => randomUUID();

export class NotificationInbox {
  readonly #db: Sqlite;
  readonly #ingress: string;
  readonly #verifier: SyntheticInboxVerifier;
  readonly #now: () => number;
  readonly #settlement: (attemptId: string) => InboxSettlement;
  readonly #preparedByReceipt = new Map<string,Set<object>>();
  readonly #afterCommit: (operationId: string) => void;
  constructor(db: Sqlite, input: Readonly<{
    use: 'isolated-synthetic'; ingress: string; verifier: SyntheticInboxVerifier; now: () => number;
    settlement: (attemptId: string) => InboxSettlement;
    afterCommit: (operationId: string) => void;
  }>) {
    assertNotificationInboxSchema(db);
    if (db.inTransaction || input.use !== 'isolated-synthetic' || inboxStore(db).ingress !== input.ingress) throw new Error('isolated_inbox_required');
    this.#db = db; this.#ingress = id(input.ingress); this.#verifier = input.verifier;
    this.#now = input.now; this.#settlement = input.settlement; this.#afterCommit = input.afterCommit;
  }
  #state(receiptId: string): State {
    return this.#db.prepare('SELECT * FROM notification_inbox_state WHERE receipt_id=?').get(receiptId) as State || refuse('unavailable');
  }
  #receipt(receiptId: string): Receipt {
    return this.#db.prepare('SELECT * FROM notification_inbox_receipts WHERE receipt_id=?').get(receiptId) as Receipt || refuse('unavailable');
  }
  #aggregate(state: State): Aggregate | null {
    return state.aggregate_id === null ? null : this.#db.prepare('SELECT * FROM notification_inbox_aggregates WHERE aggregate_id=?').get(state.aggregate_id) as Aggregate;
  }
  #work(state: State): Work { return this.#db.prepare('SELECT * FROM notification_inbox_work WHERE work_id=?').get(state.work_id) as Work || refuse('unavailable'); }
  #payload(receiptId: string): Buffer {
    const row = this.#db.prepare('SELECT bytes FROM notification_inbox_payloads WHERE receipt_id=?').get(receiptId) as { bytes: Buffer } | undefined;
    if (!row || this.#now() >= this.#receipt(receiptId).payload_until) refuse('payload_unavailable');
    const receipt = this.#receipt(receiptId);
    if (row!.bytes.length !== receipt.byte_length || notificationPayloadDigest(row!.bytes) !== receipt.digest) refuse('identity_collision');
    return row!.bytes;
  }
  #check(capability: InboxCapability, operation: Parameters<typeof checkInboxCapability>[2], state?: State): InboxPolicy {
    const aggregate = state ? this.#aggregate(state) : null;
    return checkInboxCapability(this.#db, capability, operation, this.#ingress,
      aggregate ? JSON.parse(aggregate.namespace_json) as InboxNamespace : null, state?.receipt_id ?? null);
  }
  #guardTime(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) refuse('unavailable');
    return now;
  }
  #reserve(reservationId: string, receiptId: string, pool: 'ingress' | 'variant' | 'completion', bytes: number, policy: InboxPolicy) {
    const used = (this.#db.prepare('SELECT coalesce(sum(bytes),0) used FROM notification_inbox_reservations WHERE pool=?').get(pool) as { used: number }).used;
    const limit = pool === 'ingress' ? policy.ingressBytes : pool === 'variant' ? policy.variantBytes : policy.completionBytes;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || used + bytes > limit) refuse('capacity_exhausted');
    this.#db.prepare('INSERT INTO notification_inbox_reservations VALUES(?,?,?,?)').run(reservationId, receiptId, pool, bytes);
  }
  #completionBytes(policy: InboxPolicy) { return policy.maxTransitions * (policy.maxOperationBytes + 16 * policy.recordOverheadBytes); }
  #metadata(state: State): InboxMetadata {
    const receipt = this.#receipt(state.receipt_id), aggregate = this.#aggregate(state);
    const available = this.#now() < receipt.payload_until && !!this.#db.prepare('SELECT 1 FROM notification_inbox_payloads WHERE receipt_id=?').get(state.receipt_id);
    return { receiptId: state.receipt_id, aggregateReference: state.aggregate_id,
      namespace: aggregate ? JSON.parse(aggregate.namespace_key) as InboxNamespaceIdentity : null,
      receiptSequence: receipt.sequence, receivedAt: receipt.received_at, byteLength: receipt.byte_length,
      authentication: state.authentication, processingDisposition: aggregate?.conflicted ? 'held_conflict' : state.disposition,
      stateVersion: state.version, reason: aggregate?.conflicted && state.reason !== 'overflow' ? 'conflict' : state.reason,
      payloadAvailable: available, retryEligible: available && state.disposition === 'held' && !aggregate?.conflicted };
  }
  #transition(state: State, policy: InboxPolicy, patch: Partial<State>, control = false) {
    // Two control slots protect conflict fencing and genuine resource settlement.
    if (state.transition_count >= policy.maxTransitions - (control ? 0 : 2)) refuse('capacity_exhausted');
    const next: State = { ...state, ...patch, version: state.version + 1, transition_count: state.transition_count + 1 };
    const changed = this.#db.prepare(`UPDATE notification_inbox_state SET version=?,authentication=?,disposition=?,reason=?,
      aggregate_id=?,work_id=?,attempts=?,transition_count=? WHERE receipt_id=? AND version=?`)
      .run(next.version,next.authentication,next.disposition,next.reason,next.aggregate_id,next.work_id,next.attempts,
        next.transition_count,next.receipt_id,state.version).changes;
    if (changed !== 1) refuse('version_conflict');
    this.#db.prepare('INSERT INTO notification_inbox_transitions(receipt_id,snapshot_json) VALUES(?,?)')
      .run(next.receipt_id,JSON.stringify(this.#metadata(next)));
    return next;
  }
  #knownAcceptance(state: State): boolean {
    return state.authentication === 'verified' && state.work_id !== null && state.aggregate_id !== null &&
      !!this.#db.prepare('SELECT 1 FROM notification_inbox_work WHERE work_id=?').get(state.work_id) &&
      !!this.#db.prepare("SELECT 1 FROM notification_inbox_reservations WHERE reservation_id=? AND pool='completion'").get('accepted:' + state.receipt_id);
  }
  #success(state: State): InboxSuccess {
    const aggregate = this.#aggregate(state);
    return { status: 'ok', receiptId: state.receipt_id, version: state.version, acknowledge: this.#knownAcceptance(state),
      ...(state.work_id ? { workId: state.work_id } : {}), ...(aggregate ? { aggregateVersion: aggregate.version } : {}),
      disposition: aggregate?.conflicted ? 'held_conflict' : state.disposition };
  }
  #recordedResult(saved: InboxResult, receiptId: string): InboxResult {
    if (saved.status !== 'ok' || !saved.acknowledge) return saved;
    const state = this.#state(receiptId), aggregate = this.#aggregate(state);
    if (!this.#knownAcceptance(state)) refuse('unavailable');
    return aggregate?.conflicted ? {...saved,disposition:'held_conflict',aggregateVersion:aggregate.version} : saved;
  }
  #operationInput(input: unknown, receiptId: string): string {
    if (input && typeof input === 'object' && 'payloadHex' in input) {
      const {payloadHex,...rest} = input as Record<string,unknown>;
      if (typeof payloadHex !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(payloadHex)) refuse('rejected');
      const bytes = Buffer.from(payloadHex,'hex');
      const retained = this.#db.prepare('SELECT bytes FROM notification_inbox_payloads WHERE receipt_id=?').get(receiptId) as {bytes:Buffer}|undefined;
      if (retained && !equal(retained.bytes,bytes)) refuse('identity_collision');
      return JSON.stringify({...rest,payloadDigest:notificationPayloadDigest(bytes),byteLength:bytes.length});
    }
    const encoded = JSON.stringify(input);
    if (typeof encoded !== 'string') refuse('rejected');
    return encoded;
  }
  #run(operationId: string, receiptId: string, input: unknown, policy: InboxPolicy, action: () => InboxResult): InboxResult {
    let began = false;
    try {
      id(operationId); id(receiptId);
      const inputJson = this.#operationInput(input,receiptId);
      if (this.#db.inTransaction) { const frame = activeFrames.get(this.#db); if (frame) frame.invalid = true; refuse('rejected'); }
      if (Buffer.byteLength(inputJson) > policy.maxOperationBytes) refuse('rejected');
      const result = this.#db.transaction(() => {
        const old = this.#db.prepare('SELECT * FROM notification_inbox_operations WHERE operation_id=?').get(operationId) as
          { receipt_id: string; input_json: string; result_json: string } | undefined;
        if (old) {
          if (old.receipt_id !== receiptId || old.input_json !== inputJson) refuse('identity_collision');
          if (input && typeof input === 'object' && 'payloadHex' in input) this.#payload(receiptId);
          const saved = JSON.parse(old.result_json) as InboxResult;
          return this.#recordedResult(saved,receiptId);
        }
        began = true;
        const value = action();
        if (value.status === 'ok') this.#db.prepare('INSERT INTO notification_inbox_operations VALUES(?,?,?,?)')
          .run(operationId,receiptId,inputJson,JSON.stringify(value));
        return value;
      }).immediate();
      if (began && result.status === 'ok') this.#afterCommit(operationId);
      return result;
    } catch (error) {
      if (error instanceof Refusal) return failure(error.status);
      return failure(began ? 'unknown_commit' : 'unavailable');
    }
  }
  #safe(action: () => InboxResult): InboxResult {
    try { return action(); } catch (error) { return failure(error instanceof Refusal ? error.status : 'unavailable'); }
  }
  capture(capability: InboxCapability, request: InboxCapture): InboxResult {
    return this.#safe(() => {
      const policy = this.#check(capability,'capture');
      if (!(request.signedPayload instanceof Uint8Array) || request.signedPayload.byteLength > policy.maxPayloadBytes) refuse('rejected');
      const bytes = Buffer.from(request.signedPayload);
      try { new TextDecoder('utf-8',{ fatal: true }).decode(bytes); } catch { refuse('rejected'); }
      if (!bytes.length || bytes.length > policy.maxPayloadBytes || !Number.isSafeInteger(request.envelopeBytes) ||
          request.envelopeBytes < bytes.length || request.envelopeBytes > policy.maxEnvelopeBytes ||
          !['synthetic_ingress','synthetic_history'].includes(request.provenance)) refuse('rejected');
      const input = { kind: 'capture', receiptId: request.receiptId, payloadHex: bytes.toString('hex'), envelopeBytes: request.envelopeBytes, provenance: request.provenance };
      return this.#run(request.operationId,request.receiptId,input,policy,() => {
        this.#check(capability,'capture');
        const prior = this.#db.prepare('SELECT * FROM notification_inbox_receipts WHERE receipt_id=?').get(request.receiptId) as Receipt | undefined;
        if (prior) {
          if (prior.digest !== notificationPayloadDigest(bytes) || prior.provenance !== request.provenance || prior.envelope_bytes !== request.envelopeBytes || !equal(this.#payload(request.receiptId),bytes)) refuse('identity_collision');
          refuse('identity_collision');
        }
        if ((this.#db.prepare('SELECT count(*) n FROM notification_inbox_receipts').get() as { n: number }).n >= policy.maxReceipts) refuse('capacity_exhausted');
        const now = this.#guardTime();
        if (Object.values(policy.retention).some(duration => !Number.isSafeInteger(now+duration) || now+duration>8640000000000000)) refuse('rejected');
        this.#reserve('ingress:' + request.receiptId,request.receiptId,'ingress',bytes.length + policy.recordOverheadBytes * 4,policy);
        this.#reserve('capture:' + request.receiptId,request.receiptId,'completion',2 * this.#completionBytes(policy),policy);
        this.#db.prepare(`INSERT INTO notification_inbox_receipts(receipt_id,received_at,byte_length,digest,provenance,envelope_bytes,payload_until,tombstone_until,audit_until)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(request.receiptId,now,bytes.length,notificationPayloadDigest(bytes),request.provenance,request.envelopeBytes,
          now+policy.retention.payloadMs,now+policy.retention.tombstoneMs,now+policy.retention.auditMs);
        this.#db.prepare('INSERT INTO notification_inbox_payloads VALUES(?,?)').run(request.receiptId,bytes);
        this.#db.prepare("INSERT INTO notification_inbox_state VALUES(?,1,'captured','unaccepted','none',NULL,NULL,0,0)").run(request.receiptId);
        const state = this.#state(request.receiptId);
        this.#db.prepare('INSERT INTO notification_inbox_transitions(receipt_id,snapshot_json) VALUES(?,?)').run(state.receipt_id,JSON.stringify(this.#metadata(state)));
        return {...this.#success(state),acknowledge:false};
      });
    });
  }
  readCapture(capability: InboxCapability, receiptId: string): InboxResult {
    return this.#safe(() => { const state = this.#state(id(receiptId)); this.#check(capability,'metadata',state); return {...this.#success(state),acknowledge:false}; });
  }
  readOperation(capability: InboxCapability, operationId: string, expectedInput: unknown): InboxResult {
    return this.#safe(() => {
      const row = this.#db.prepare('SELECT * FROM notification_inbox_operations WHERE operation_id=?').get(id(operationId)) as
        { receipt_id: string; input_json: string; result_json: string } | undefined;
      if (!row) refuse('unavailable');
      const state = this.#state(row!.receipt_id); this.#check(capability,'metadata',state);
      if (row!.input_json !== this.#operationInput(expectedInput,row!.receipt_id)) refuse('identity_collision');
      if (expectedInput && typeof expectedInput === 'object' && 'payloadHex' in expectedInput) this.#payload(row!.receipt_id);
      const saved = JSON.parse(row!.result_json) as InboxResult;
      return this.#recordedResult(saved,state.receipt_id);
    });
  }
  readAcceptance(capability: InboxCapability, request: Readonly<{
    operationId: string; receiptId: string; expectedVersion: number; signedPayload: Uint8Array;
  }>): InboxResult {
    return this.#safe(() => {
      const state = this.#state(id(request.receiptId)), policy = this.#check(capability,'metadata',state);
      if (!(request.signedPayload instanceof Uint8Array) || request.signedPayload.byteLength > policy.maxPayloadBytes) refuse('rejected');
      const operation = this.#db.prepare('SELECT * FROM notification_inbox_operations WHERE operation_id=?').get(id(request.operationId)) as
        {receipt_id:string;input_json:string;result_json:string}|undefined;
      if (!operation) refuse('unavailable');
      const input = JSON.parse(operation!.input_json) as {kind:string;receiptId:string;expectedVersion:number;storeGeneration:string;payloadDigest:string;byteLength:number};
      if (operation!.receipt_id !== request.receiptId || input.kind !== 'promote' || input.receiptId !== request.receiptId ||
          input.expectedVersion !== request.expectedVersion || input.storeGeneration !== inboxStore(this.#db).generation ||
          input.payloadDigest !== notificationPayloadDigest(request.signedPayload) || input.byteLength !== request.signedPayload.byteLength ||
          !equal(this.#payload(request.receiptId),request.signedPayload)) refuse('identity_collision');
      const saved = JSON.parse(operation!.result_json) as InboxResult;
      if (saved.status !== 'ok' || !saved.acknowledge || !this.#knownAcceptance(state)) refuse('unavailable');
      return this.#recordedResult(saved,state.receipt_id);
    });
  }
  async verify(capability: InboxCapability, request: Readonly<{
    operationId: string; receiptId: string; expectedVersion: number; custodyId: string;
  }>): Promise<Readonly<{ result: InboxResult; verified?: VerifiedInboxNotification }>> {
    let policy: InboxPolicy;
    try { policy = this.#check(capability,'verify',this.#state(request.receiptId)); }
    catch { return { result: failure('unavailable') }; }
    const attemptId = randomUUID(), generation = inboxStore(this.#db).generation;
    const started = this.#run(request.operationId,request.receiptId,{kind:'verify',...request},policy,() => {
      const state = this.#state(request.receiptId); this.#check(capability,'verify',state); this.#payload(state.receipt_id);
      if (state.version !== request.expectedVersion) refuse('version_conflict');
      if (!['captured','verification_unknown'].includes(state.authentication) || state.attempts >= policy.maxAttempts) refuse('rejected');
      const active = (this.#db.prepare("SELECT count(*) n FROM notification_inbox_claims WHERE kind='verification' AND settled=0").get() as { n: number }).n;
      if (active >= policy.maxVerificationClaims) refuse('capacity_exhausted');
      id(request.custodyId);
      this.#db.prepare('INSERT INTO notification_inbox_claims VALUES(?,?,?,?,?,?,0,0)')
        .run(attemptId,state.receipt_id,'verification',state.attempts+1,request.custodyId,generation);
      return this.#success(this.#transition(state,policy,{authentication:'verifying',attempts:state.attempts+1}));
    });
    if (started.status !== 'ok') return { result: started };
    const persisted = this.#db.prepare("SELECT * FROM notification_inbox_claims WHERE receipt_id=? AND kind='verification' AND settled=0").get(request.receiptId) as ClaimRow | undefined;
    // Repeating an operation never invokes a replacement producer after lost response or restart.
    if (!persisted || persisted.attempt_id !== attemptId) return { result: failure('unavailable') };
    let bytes: Buffer;
    try { bytes = this.#payload(request.receiptId); } catch { return {result:failure('payload_unavailable')}; }
    let outer: InboxOuter;
    try {
      outer = await this.#verifier.outer(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      namespaceKey(outer.namespace); uuid(outer.notificationUUID);
      checkInboxCapability(this.#db,capability,'verify',this.#ingress,outer.namespace,request.receiptId);
    } catch {
      return { result: this.#verificationFailure(capability,request.receiptId,attemptId,policy,'invalid_outer') };
    }
    try {
      const nested: InboxNested[] = [];
      for (const [kind,proof] of [['transaction',outer.signedTransaction],['renewal',outer.signedRenewal]] as const) {
        if (proof !== null) {
          if (typeof proof !== 'string' || !proof.length || Buffer.byteLength(proof) > policy.maxNestedBytes) refuse('rejected');
          const verified = await this.#verifier[kind](proof);
          if (namespaceKey(verified.namespace) !== namespaceKey(outer.namespace) || verified.namespace.appAppleId !== outer.namespace.appAppleId ||
              typeof verified.originalTransactionId !== 'string' || !verified.originalTransactionId.length || verified.originalTransactionId.length > 128 ||
              (verified.appAccountToken !== null && (typeof verified.appAccountToken !== 'string' || verified.appAccountToken.length > 128))) refuse('rejected');
          nested.push(verified);
        }
      }
      if (nested.length === 2 && (nested[0]!.originalTransactionId !== nested[1]!.originalTransactionId || nested[0]!.appAccountToken !== nested[1]!.appAccountToken)) refuse('rejected');
      const settlement = this.#settlement(attemptId);
      if (!settlement.settled || settlement.custodyId !== persisted.custody_id || settlement.generation !== persisted.generation) {
        return { result: this.#verificationFailure(capability,request.receiptId,attemptId,policy,'verification_unknown') };
      }
      const state = this.#state(request.receiptId);
      if (state.version !== started.version || inboxStore(this.#db).generation !== generation) return { result: failure('version_conflict') };
      this.#check(capability,'verify',state);
      const token = Object.freeze({}) as VerifiedInboxNotification;
      const tokens = this.#preparedByReceipt.get(request.receiptId) ?? new Set<object>();
      tokens.add(token); this.#preparedByReceipt.set(request.receiptId,tokens);
      preparedNotifications.set(token,{receiptId:request.receiptId,version:state.version,attemptId,outer:JSON.parse(JSON.stringify(outer)) as InboxOuter,
        payload:Buffer.from(bytes),storeGeneration:generation,policy:JSON.stringify(policy),operationId:request.operationId});
      return { result: started, verified: token };
    } catch { return { result: this.#verificationFailure(capability,request.receiptId,attemptId,policy,'invalid_nested') }; }
  }
  #verificationFailure(capability: InboxCapability, receiptId: string, attemptId: string, policy: InboxPolicy, reason: InboxReason): InboxResult {
    return this.#run('verification_result_' + attemptId,receiptId,{kind:'verification_result',attemptId,reason},policy,() => {
      const state = this.#state(receiptId); this.#check(capability,'verify',state);
      const claim = this.#db.prepare('SELECT * FROM notification_inbox_claims WHERE attempt_id=? AND settled=0').get(attemptId) as ClaimRow | undefined;
      if (!claim || state.authentication !== 'verifying') refuse('version_conflict');
      const settlement = this.#settlement(attemptId);
      const settled = settlement.settled && settlement.custodyId === claim.custody_id && settlement.generation === claim.generation;
      this.#check(capability,'verify',state);
      if (settled) this.#db.prepare('UPDATE notification_inbox_claims SET settled=1 WHERE attempt_id=?').run(attemptId);
      return this.#success(this.#transition(state,policy,{authentication:settled && reason !== 'verification_unknown' ? 'rejected' : 'verification_unknown',
        disposition:settled && reason !== 'verification_unknown' ? 'rejected' : 'held',reason}));
    });
  }
  reconcileVerification(capability: InboxCapability, request: Readonly<{
    operationId: string; receiptId: string; expectedVersion: number; verificationAttemptId: string;
  }>): InboxResult {
    return this.#safe(() => {
      const state = this.#state(request.receiptId), policy = this.#check(capability,'verify',state);
      return this.#run(request.operationId,state.receipt_id,{kind:'reconcile_verification',...request},policy,() => {
        const current = this.#state(request.receiptId); this.#check(capability,'verify',current);
        if (current.version !== request.expectedVersion || !['verifying','verification_unknown'].includes(current.authentication)) refuse('version_conflict');
        const claim = this.#db.prepare("SELECT * FROM notification_inbox_claims WHERE attempt_id=? AND receipt_id=? AND kind='verification' AND settled=0")
          .get(request.verificationAttemptId,current.receipt_id) as ClaimRow|undefined;
        if (!claim || claim.store_generation !== inboxStore(this.#db).generation) refuse('unavailable');
        const settled = this.#settlement(claim.attempt_id);
        if (!settled.settled || settled.custodyId !== claim.custody_id || settled.generation !== claim.generation) refuse('unavailable');
        this.#db.prepare('UPDATE notification_inbox_claims SET settled=1 WHERE attempt_id=?').run(claim.attempt_id);
        return this.#success(this.#transition(current,policy,{authentication:'verification_unknown',disposition:'held',reason:'verification_unknown'}));
      });
    });
  }
  settleFencedClaim(capability: InboxCapability, request: Readonly<{operationId:string;claim:InboxClaim;expectedVersion:number}>): InboxResult {
    return this.#safe(() => {
      const state = this.#state(request.claim.receiptId), policy = this.#check(capability,'complete',state);
      return this.#run(request.operationId,state.receipt_id,{kind:'settle_fenced',...request},policy,() => {
        const current = this.#state(state.receipt_id); this.#check(capability,'complete',current);
        const claim = this.#db.prepare('SELECT * FROM notification_inbox_claims WHERE attempt_id=? AND settled=0').get(request.claim.processingAttemptId) as ClaimRow|undefined;
        if (!this.#aggregate(current)?.conflicted || current.version !== request.expectedVersion || !claim ||
            claim.receipt_id !== current.receipt_id || claim.custody_id !== request.claim.custodyId || claim.generation !== request.claim.generation ||
            claim.store_generation !== request.claim.storeGeneration || claim.store_generation !== inboxStore(this.#db).generation) refuse('version_conflict');
        const settled = this.#settlement(claim.attempt_id);
        if (!settled.settled || settled.custodyId !== claim.custody_id || settled.generation !== claim.generation) refuse('unavailable');
        this.#db.prepare('UPDATE notification_inbox_claims SET settled=1 WHERE attempt_id=?').run(claim.attempt_id);
        return this.#success(this.#transition(current,policy,{disposition:'held_conflict',reason:'conflict'},true));
      });
    });
  }
  promote(capability: InboxCapability, request: Readonly<{
    operationId: string; receiptId: string; expectedVersion: number; verified: VerifiedInboxNotification;
  }>): InboxResult {
    return this.#safe(() => {
      const prepared = request.verified && preparedNotifications.get(request.verified);
      if (!prepared || prepared.receiptId !== request.receiptId || prepared.version !== request.expectedVersion) refuse('rejected');
      const state = this.#state(request.receiptId), policy = this.#check(capability,'promote',state);
      checkInboxCapability(this.#db,capability,'promote',this.#ingress,prepared.outer.namespace,request.receiptId);
      const input = { kind:'promote', receiptId:request.receiptId, expectedVersion:request.expectedVersion,
        attemptId:prepared.attemptId, storeGeneration:prepared.storeGeneration, outer:{namespace:prepared.outer.namespace,notificationUUID:uuid(prepared.outer.notificationUUID),
          transactionDigest:prepared.outer.signedTransaction === null ? null : notificationPayloadDigest(Buffer.from(prepared.outer.signedTransaction)),
          renewalDigest:prepared.outer.signedRenewal === null ? null : notificationPayloadDigest(Buffer.from(prepared.outer.signedRenewal))}, payloadHex:prepared.payload.toString('hex') };
      return this.#run(request.operationId,request.receiptId,input,policy,() => {
        const current = this.#state(request.receiptId); this.#check(capability,'promote',current);
        if (current.version !== prepared.version || prepared.storeGeneration !== inboxStore(this.#db).generation ||
            prepared.policy !== JSON.stringify(policy) || !equal(this.#payload(current.receipt_id),prepared.payload)) refuse('version_conflict');
        const claim = this.#db.prepare('SELECT * FROM notification_inbox_claims WHERE attempt_id=? AND settled=0').get(prepared.attemptId) as ClaimRow | undefined;
        const settlement = this.#settlement(prepared.attemptId);
        if (!claim || !settlement.settled || claim.custody_id !== settlement.custodyId || claim.generation !== settlement.generation) refuse('unavailable');
        checkInboxCapability(this.#db,capability,'promote',this.#ingress,prepared.outer.namespace,request.receiptId);
        const ns = namespaceKey(prepared.outer.namespace), notificationUUID = uuid(prepared.outer.notificationUUID);
        let aggregate = this.#db.prepare('SELECT * FROM notification_inbox_aggregates WHERE namespace_key=? AND notification_uuid=?').get(ns,notificationUUID) as Aggregate | undefined;
        if (aggregate && (JSON.parse(aggregate.namespace_json) as InboxNamespace).appAppleId !== prepared.outer.namespace.appAppleId) refuse('identity_collision');
        const reserved = this.#db.prepare("UPDATE notification_inbox_reservations SET bytes=bytes-? WHERE reservation_id=? AND bytes>=?")
          .run(this.#completionBytes(policy),'capture:' + current.receipt_id,2 * this.#completionBytes(policy)).changes;
        if (reserved !== 1) refuse('capacity_exhausted');
        this.#db.prepare('INSERT INTO notification_inbox_reservations VALUES(?,?,?,?)')
          .run('accepted:' + current.receipt_id,current.receipt_id,'completion',this.#completionBytes(policy));
        if (!aggregate) {
          const aggregateId = randomUUID();
          this.#db.prepare('INSERT INTO notification_inbox_aggregates VALUES(?,?,?,?,1,0,0,0)').run(aggregateId,ns,JSON.stringify(prepared.outer.namespace),notificationUUID);
          aggregate = this.#db.prepare('SELECT * FROM notification_inbox_aggregates WHERE aggregate_id=?').get(aggregateId) as Aggregate;
        }
        const variants = this.#db.prepare('SELECT receipt_id,canonical_receipt_id FROM notification_inbox_variants WHERE aggregate_id=?').all(aggregate.aggregate_id) as
          { receipt_id: string; canonical_receipt_id: string }[];
        let duplicate: string | null = null;
        for (const variant of variants) {
          try {
            const other = this.#payload(variant.receipt_id);
            if (equal(other,prepared.payload)) duplicate = variant.canonical_receipt_id;
          } catch { /* Disposed bytes never establish equality; the aggregate remains conservatively held. */ }
        }
        const conflict = aggregate.conflicted === 1 || (variants.length > 0 && duplicate === null);
        const variantCount = (this.#db.prepare('SELECT count(*) n FROM notification_inbox_variants').get() as { n: number }).n;
        const variantUsed = (this.#db.prepare("SELECT coalesce(sum(bytes),0) n FROM notification_inbox_reservations WHERE pool='variant'").get() as { n: number }).n;
        const overflow = variantCount >= policy.maxVariants || variantUsed + policy.recordOverheadBytes * 4 > policy.variantBytes;
        if (overflow && !conflict) refuse('capacity_exhausted');
        if (!overflow) {
          this.#reserve('variant:' + current.receipt_id,current.receipt_id,'variant',policy.recordOverheadBytes * 4,policy);
          this.#db.prepare('INSERT INTO notification_inbox_variants VALUES(?,?,?)').run(current.receipt_id,aggregate.aggregate_id,duplicate ?? current.receipt_id);
        }
        let workId: string;
        if (duplicate !== null && !conflict) workId = this.#state(duplicate).work_id!;
        else {
          workId = randomUUID();
          this.#db.prepare('INSERT INTO notification_inbox_work VALUES(?,?,1,?,0)').run(workId,current.receipt_id,conflict ? 'held_conflict' : 'pending');
        }
        this.#db.prepare('UPDATE notification_inbox_claims SET settled=1 WHERE attempt_id=?').run(prepared.attemptId);
        const disposition = conflict ? 'held_conflict' : duplicate ? this.#work(this.#state(duplicate)).disposition : 'pending';
        let promoted = this.#transition(current,policy,{authentication:'verified',disposition,
          reason:overflow ? 'overflow' : conflict ? 'conflict' : 'none',aggregate_id:aggregate.aggregate_id,work_id:workId});
        if (conflict && !aggregate.conflicted) {
          this.#db.prepare('UPDATE notification_inbox_aggregates SET conflicted=1,version=version+1,overflow=?,invalidation_required=1 WHERE aggregate_id=? AND version=?')
            .run(overflow ? 1 : 0,aggregate.aggregate_id,aggregate.version);
          // Aggregate fencing is authoritative even when a per-receipt transition budget is exhausted.
          this.#db.prepare(`UPDATE notification_inbox_work SET version=version+1,disposition='held_conflict' WHERE receipt_id IN
            (SELECT receipt_id FROM notification_inbox_state WHERE aggregate_id=?)`).run(aggregate.aggregate_id);
          this.#db.prepare(`UPDATE notification_inbox_claims SET cancel_requested=1 WHERE settled=0 AND receipt_id IN
            (SELECT receipt_id FROM notification_inbox_state WHERE aggregate_id=?)`).run(aggregate.aggregate_id);
          const affected = this.#db.prepare('SELECT * FROM notification_inbox_state WHERE aggregate_id=? AND receipt_id<>?').all(aggregate.aggregate_id,current.receipt_id) as State[];
          for (const prior of affected) if (prior.transition_count < policy.maxTransitions) {
            this.#transition(prior,policy,{disposition:'held_conflict',reason:'conflict'},true);
          }
          promoted = this.#state(current.receipt_id);
        } else if (conflict && (duplicate === null || overflow)) {
          this.#db.prepare('UPDATE notification_inbox_aggregates SET version=version+1,overflow=max(overflow,?) WHERE aggregate_id=? AND version=?')
            .run(overflow ? 1 : 0,aggregate.aggregate_id,aggregate.version);
        }
        return this.#success(promoted);
      });
    });
  }
  claim(capability: InboxCapability, request: Readonly<{
    operationId: string; receiptId: string; expected: InboxVersions; custodyId: string;
  }>): InboxResult {
    return this.#safe(() => {
      const state = this.#state(request.receiptId), policy = this.#check(capability,'claim',state);
      return this.#run(request.operationId,request.receiptId,{kind:'claim',...request},policy,() => {
        const current = this.#state(request.receiptId), aggregate = this.#aggregate(current), work = this.#work(current);
        this.#check(capability,'claim',current); this.#payload(current.receipt_id);
        if (aggregate?.conflicted) refuse('held_conflict');
        if (!aggregate || !this.#knownAcceptance(current) || work.receipt_id !== current.receipt_id ||
            current.version !== request.expected.receipt || work.version !== request.expected.work || aggregate.version !== request.expected.aggregate) refuse('version_conflict');
        if (work.disposition !== 'pending' || current.attempts >= policy.maxAttempts) refuse('rejected');
        const attemptId = randomUUID(), generation = work.claim_generation+1, storeGeneration = inboxStore(this.#db).generation;
        id(request.custodyId);
        this.#db.prepare('INSERT INTO notification_inbox_claims VALUES(?,?,?,?,?,?,0,0)')
          .run(attemptId,current.receipt_id,'processing',generation,request.custodyId,storeGeneration);
        this.#db.prepare("UPDATE notification_inbox_work SET version=version+1,disposition='claimed',claim_generation=? WHERE work_id=? AND version=?")
          .run(generation,work.work_id,work.version);
        const next = this.#transition(current,policy,{disposition:'claimed',attempts:current.attempts+1});
        const claim: InboxClaim = { receiptId:current.receipt_id,workId:work.work_id,processingAttemptId:attemptId,generation,
          custodyId:request.custodyId,storeGeneration,versions:{receipt:next.version,work:work.version+1,aggregate:aggregate.version} };
        return { ...this.#success(next), claim };
      });
    });
  }
  #validateClaim(claim: InboxClaim, requireSettlement: boolean) {
    const state = this.#state(claim.receiptId), aggregate = this.#aggregate(state), work = this.#work(state);
    const row = this.#db.prepare('SELECT * FROM notification_inbox_claims WHERE attempt_id=?').get(claim.processingAttemptId) as ClaimRow | undefined;
    if (aggregate?.conflicted) refuse('held_conflict');
    if (!row || row.settled || row.kind !== 'processing' || row.receipt_id !== claim.receiptId ||
        row.custody_id !== claim.custodyId || row.generation !== claim.generation || row.store_generation !== claim.storeGeneration ||
        claim.storeGeneration !== inboxStore(this.#db).generation || state.version !== claim.versions.receipt ||
        work.version !== claim.versions.work || work.work_id !== claim.workId || work.receipt_id !== claim.receiptId ||
        work.claim_generation !== claim.generation || aggregate?.version !== claim.versions.aggregate || !this.#knownAcceptance(state)) refuse('version_conflict');
    if (requireSettlement) {
      const settlement = this.#settlement(claim.processingAttemptId);
      if (!settlement.settled || settlement.custodyId !== claim.custodyId || settlement.generation !== claim.generation) refuse('unavailable');
    }
    return state;
  }
  requestCancellation(capability: InboxCapability, request: Readonly<{ operationId: string; claim: InboxClaim }>): InboxResult {
    return this.#safe(() => {
      const state = this.#state(request.claim.receiptId), policy = this.#check(capability,'complete',state);
      return this.#run(request.operationId,state.receipt_id,{kind:'cancel',...request},policy,() => {
        this.#validateClaim(request.claim,false); this.#check(capability,'complete',state);
        this.#db.prepare('UPDATE notification_inbox_claims SET cancel_requested=1 WHERE attempt_id=?').run(request.claim.processingAttemptId);
        const next = this.#transition(state,policy,{disposition:'held',reason:'cancel_requested'});
        return {...this.#success(next),claim:{...request.claim,versions:{...request.claim.versions,receipt:next.version}}};
      });
    });
  }
  #complete(capability: InboxCapability, claim: InboxClaim, disposition: 'completed' | 'held' | 'rejected' | 'applied', reason: InboxReason): InboxSuccess {
    const state = this.#validateClaim(claim,true), policy = this.#check(capability,'complete',state);
    this.#payload(state.receipt_id);
    this.#db.prepare('UPDATE notification_inbox_work SET version=version+1,disposition=? WHERE work_id=? AND version=?')
      .run(disposition,claim.workId,claim.versions.work);
    this.#db.prepare('UPDATE notification_inbox_claims SET settled=1 WHERE attempt_id=? AND settled=0').run(claim.processingAttemptId);
    return this.#success(this.#transition(state,policy,{disposition,reason}));
  }
  finishInboxOnly(capability: InboxCapability, request: Readonly<{
    operationId: string; claim: InboxClaim; disposition: 'completed' | 'held' | 'rejected';
    reason: 'unsupported' | 'unknown_owner' | 'producer_unknown';
  }>): InboxResult {
    return this.#safe(() => {
      const state = this.#state(request.claim.receiptId), policy = this.#check(capability,'complete',state);
      if (!['completed','held','rejected'].includes(request.disposition) || !['unsupported','unknown_owner','producer_unknown'].includes(request.reason)) refuse('rejected');
      return this.#run(request.operationId,state.receipt_id,{kind:'finish',...request},policy,
        () => this.#complete(capability,request.claim,request.disposition,request.reason));
    });
  }
  completeWithinPurchaseCommit(frame: PurchaseCommitFrame, claim: InboxClaim): InboxSuccess {
    const binding = frame && frames.get(frame);
    if (!binding || binding.owner !== this || binding.db !== this.#db || !binding.active || binding.completed || !this.#db.inTransaction) {
      if (binding?.active) binding.invalid = true;
      refuse('rejected');
    }
    const result = this.#complete(binding.capability,claim,'applied','applied');
    binding.completed = true;
    return result;
  }
  createSyntheticPurchaseCommitter(capability: InboxCapability, input: Readonly<{ use: 'isolated-synthetic' }>) {
    if (input.use !== 'isolated-synthetic') throw new Error('synthetic_committer_required');
    this.#check(capability,'complete');
    return Object.freeze({
      commit: (request: Readonly<{ operationId: string; claim: InboxClaim; applicationInput: string }>,
        apply: (db: Sqlite, frame: PurchaseCommitFrame) => unknown, guard: () => unknown): InboxResult => this.#safe(() => {
        const state = this.#state(request.claim.receiptId), policy = this.#check(capability,'complete',state);
        if (typeof request.applicationInput !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(request.applicationInput)) refuse('rejected');
        return this.#run(request.operationId,state.receipt_id,{kind:'purchase_commit',...request},policy,() => {
          this.#validateClaim(request.claim,true); this.#check(capability,'complete',state);
          const store = inboxStore(this.#db);
          const assertGuard = () => {
            const value = guard();
            if (thenable(value) || value !== true) refuse('unavailable');
            this.#check(capability,'complete',this.#state(state.receipt_id));
            const current = inboxStore(this.#db);
            if (store.generation !== current.generation || store.policy_json !== current.policy_json) refuse('unavailable');
          };
          assertGuard();
          const frame = Object.freeze({}) as PurchaseCommitFrame;
          const binding: Frame = {db:this.#db,owner:this,active:true,completed:false,invalid:false,capability};
          frames.set(frame,binding); activeFrames.set(this.#db,binding);
          try {
            const applied = apply(this.#db,frame);
            if (thenable(applied) || binding.invalid) refuse('rejected');
            if (!binding.completed) this.completeWithinPurchaseCommit(frame,request.claim);
            assertGuard();
            return this.#success(this.#state(state.receipt_id));
          } finally { binding.active = false; activeFrames.delete(this.#db); }
        });
      }),
    });
  }
  inspectProof(capability: InboxCapability, receiptId: string): Readonly<{ status: 'ok'; bytes: Uint8Array }> | InboxFailure {
    try {
      const state = this.#state(id(receiptId)); this.#check(capability,'proof',state);
      return {status:'ok',bytes:Uint8Array.from(this.#payload(receiptId))};
    } catch (error) { return failure(error instanceof Refusal ? error.status : 'unavailable'); }
  }
  requestReplay(capability: InboxCapability, request: Readonly<{
    operationId: string; receiptId: string; expectedVersion: number; expectedDisposition: InboxDisposition;
    reason: 'reconsider_owner' | 'retry_verification';
  }>): InboxResult {
    return this.#safe(() => {
      const state = this.#state(request.receiptId), policy = this.#check(capability,'replay',state);
      return this.#run(request.operationId,state.receipt_id,{kind:'replay',...request},policy,() => {
        const current = this.#state(request.receiptId); this.#check(capability,'replay',current); this.#payload(current.receipt_id);
        if (current.version !== request.expectedVersion || current.disposition !== request.expectedDisposition) refuse('version_conflict');
        if (this.#aggregate(current)?.conflicted) refuse('held_conflict');
        if (this.#db.prepare('SELECT 1 FROM notification_inbox_claims WHERE receipt_id=? AND settled=0').get(current.receipt_id)) refuse('unavailable');
        if (current.attempts >= policy.maxAttempts || !['held','rejected'].includes(current.disposition) ||
            (request.reason === 'retry_verification' ? !['rejected','verification_unknown'].includes(current.authentication) :
              request.reason !== 'reconsider_owner' || current.authentication !== 'verified' || current.reason !== 'unknown_owner')) refuse('rejected');
        this.#reserve('replay:' + request.operationId,current.receipt_id,'completion',this.#completionBytes(policy),policy);
        if (current.work_id) this.#db.prepare("UPDATE notification_inbox_work SET version=version+1,disposition='pending' WHERE work_id=?").run(current.work_id);
        return this.#success(this.#transition(current,policy,{authentication:request.reason === 'retry_verification' ? 'captured' : 'verified',
          disposition:request.reason === 'retry_verification' ? 'unaccepted' : 'pending',reason:request.reason}));
      });
    });
  }
  disposePayload(capability: InboxCapability, request: Readonly<{
    operationId: string; receiptId: string; expectedVersion: number;
  }>): InboxResult {
    return this.#safe(() => {
      const state = this.#state(request.receiptId), policy = this.#check(capability,'dispose',state);
      return this.#run(request.operationId,state.receipt_id,{kind:'dispose',...request},policy,() => {
        const current = this.#state(request.receiptId), receipt = this.#receipt(current.receipt_id);
        this.#check(capability,'dispose',current);
        if (current.version !== request.expectedVersion) refuse('version_conflict');
        if (this.#now() < receipt.payload_until || this.#db.prepare('SELECT 1 FROM notification_inbox_claims WHERE receipt_id=? AND settled=0').get(current.receipt_id)) refuse('unavailable');
        this.#db.prepare('DELETE FROM notification_inbox_payloads WHERE receipt_id=?').run(current.receipt_id);
        for (const token of this.#preparedByReceipt.get(current.receipt_id) ?? []) preparedNotifications.delete(token);
        this.#preparedByReceipt.delete(current.receipt_id);
        this.#db.prepare('INSERT INTO notification_inbox_disposals VALUES(?,?,?,?)').run(request.operationId,current.receipt_id,this.#guardTime(),policy.revision);
        return this.#success(this.#transition(current,policy,{reason:'disposed'}));
      });
    });
  }
  expireIdentityAndAudit(capability: InboxCapability, request: Readonly<{ operationId: string; receiptId: string; expectedVersion: number }>): InboxResult {
    // Erasure intentionally ends identity/readback history; unknown erasure is never reconstructed from a hash.
    let began = false;
    try {
      id(request.operationId);
      if (this.#db.inTransaction) refuse('rejected');
      const result = this.#db.transaction(() => {
        const state = this.#state(id(request.receiptId)), receipt = this.#receipt(state.receipt_id), aggregate = this.#aggregate(state);
        this.#check(capability,'dispose',state);
        if (this.#db.prepare('SELECT 1 FROM notification_inbox_operations WHERE operation_id=?').get(request.operationId)) refuse('identity_collision');
        if (state.version !== request.expectedVersion) refuse('version_conflict');
        if (this.#now() < receipt.audit_until || this.#now() < receipt.tombstone_until || aggregate?.invalidation_required ||
            this.#db.prepare('SELECT 1 FROM notification_inbox_claims WHERE receipt_id=? AND settled=0').get(state.receipt_id) ||
            this.#db.prepare('SELECT 1 FROM notification_inbox_variants WHERE canonical_receipt_id=? AND receipt_id<>?').get(state.receipt_id,state.receipt_id)) refuse('unavailable');
        began = true;
        for (const token of this.#preparedByReceipt.get(state.receipt_id) ?? []) preparedNotifications.delete(token);
        this.#preparedByReceipt.delete(state.receipt_id);
        const highwater = (this.#db.prepare('SELECT coalesce(max(sequence),0) n FROM notification_inbox_transitions').get() as { n: number }).n;
        this.#db.prepare('UPDATE notification_inbox_store SET history_floor=? WHERE singleton=1').run(highwater);
        for (const table of ['payloads','variants','work','claims','transitions','operations','reservations','disposals','state','receipts']) {
          this.#db.prepare(`DELETE FROM notification_inbox_${table} WHERE receipt_id=?`).run(state.receipt_id);
        }
        if (aggregate && !this.#db.prepare('SELECT 1 FROM notification_inbox_state WHERE aggregate_id=?').get(aggregate.aggregate_id)) {
          this.#db.prepare('DELETE FROM notification_inbox_aggregates WHERE aggregate_id=?').run(aggregate.aggregate_id);
        }
        return {status:'ok',receiptId:state.receipt_id,version:state.version+1,acknowledge:false} as InboxSuccess;
      }).immediate();
      this.#afterCommit(request.operationId);
      return result;
    } catch (error) { return failure(error instanceof Refusal ? error.status : began ? 'unknown_commit' : 'unavailable'); }
  }
  listMetadata(capability: InboxCapability, filter: Readonly<{
    namespace: InboxNamespace | null; authentication: InboxAuthentication | null; disposition: InboxDisposition | null;
  }>, pageSize: number, cursor: InboxCursor | null = null): Readonly<{
    status: 'ok'; records: readonly InboxMetadata[]; cursor: InboxCursor | null;
  }> | InboxFailure {
    try {
      const policy = this.#check(capability,'metadata'), store = inboxStore(this.#db);
      if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > policy.maxPageSize) refuse('rejected');
      if (filter.namespace) checkInboxCapability(this.#db,capability,'metadata',this.#ingress,filter.namespace);
      const query = JSON.stringify(filter), scope = JSON.stringify({ingress:this.#ingress,capabilityScope:this.#scopeFingerprint(capability)});
      const old = cursor && cursors.get(cursor);
      if (cursor && (!old || old.owner !== this || old.store !== store.store_id || old.generation !== store.generation ||
          old.policy !== store.policy_json || old.scope !== scope || old.filter !== query)) refuse('stale_cursor');
      if (old && old.floor !== store.history_floor) refuse('history_unavailable');
      const highwater = old?.highwater ?? (this.#db.prepare('SELECT coalesce(max(sequence),0) n FROM notification_inbox_transitions').get() as { n: number }).n;
      // Pages expose immutable transition snapshots; readCapture reads current versioned custody.
      const rows = this.#db.prepare('SELECT sequence,snapshot_json FROM notification_inbox_transitions WHERE sequence>? AND sequence<=? ORDER BY sequence')
        .all(old?.after ?? 0,highwater) as { sequence: number; snapshot_json: string }[];
      const records: InboxMetadata[] = [];
      let after = old?.after ?? 0;
      for (const row of rows) {
        after = row.sequence;
        const snapshot = JSON.parse(row.snapshot_json) as InboxMetadata;
        try {
          const state = this.#state(snapshot.receiptId); this.#check(capability,'metadata',state);
          if (this.#now() >= this.#receipt(state.receipt_id).audit_until) refuse('history_unavailable');
        } catch (error) {
          if (error instanceof Refusal && error.status === 'history_unavailable') throw error;
          continue;
        }
        if ((filter.namespace && (!snapshot.namespace || namespaceKey(filter.namespace) !== JSON.stringify(snapshot.namespace))) ||
            (filter.authentication && snapshot.authentication !== filter.authentication) ||
            (filter.disposition && snapshot.processingDisposition !== filter.disposition)) continue;
        records.push(snapshot);
        if (records.length === pageSize) break;
      }
      let next: InboxCursor | null = null;
      if (after < highwater) {
        next = Object.freeze({}) as InboxCursor;
        cursors.set(next,{owner:this,store:store.store_id,generation:store.generation,policy:store.policy_json,scope,
          filter:query,highwater,after,floor:store.history_floor});
      }
      return {status:'ok',records,cursor:next};
    } catch (error) { return failure(error instanceof Refusal ? error.status : 'unavailable'); }
  }
  #scopeFingerprint(capability: InboxCapability): string {
    // A cursor is tied to the original private permission, never a caller supplied scope label.
    let fingerprint = this.#cursorAuthorities.get(capability);
    if (!fingerprint) { fingerprint = randomUUID(); this.#cursorAuthorities.set(capability,fingerprint); }
    return fingerprint;
  }
  readonly #cursorAuthorities = new WeakMap<object,string>();
}
