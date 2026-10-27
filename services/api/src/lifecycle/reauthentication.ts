import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Sqlite } from '../storage.js';
import { hash } from '../storage.js';
import { DomainError } from '../errors.js';
import { evidenceDigest } from './evidence-codec.js';
import { actionHeld, actionUnavailable, actionId, actionTime, actionKey, actionMac, equalActionMac, actionChallengeBinding, actionProofDigest,
  assertSourceActionContext, readSourceActionSubject, assertSourceActionChallengeCurrent, readSourceActionContinuity,
  type ActionChallengeRow, type ActionProofRow, type SourceActionContinuityWitness } from './reauthentication-proof.js';
import type { AccountContext, SourceActionChallenge, SourceActionDelivery, SourceActionDeliveryRequest, SourceActionDeliveryResult,
  SourceActionIssue, SourceActionKeys, SourceActionVerify } from './types.js';

type Budget = { account_id: string; auth_user_id: string; binding_revision: number; revision: number; request_window_ms: number; request_count: number;
  send_window_ms: number; send_count: number; verify_window_ms: number; verify_count: number; last_seen_ms: number };
type Quota = 'request' | 'send' | 'verify';
const limits = { request: [20, 900000], send: [3, 3600000], verify: [5, 900000] } as const;
const failure = (code: 'limit' | 'conflict' | 'held' | 'unavailable'): never => {
  throw new DomainError(code === 'limit' ? 429 : code === 'conflict' ? 409 : code === 'held' ? 503 : 403, `action_reauthentication_${code}`);
};
function data(input: unknown, names: string): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  return Object.keys(descriptors).sort().join(',') === names && Object.values(descriptors).every(d => 'value' in d);
}
function bounded(input: unknown, names: string, bounds: Readonly<Record<string, number>>): void {
  if (!data(input, names) || Object.entries(bounds).some(([key, max]) => typeof input[key] !== 'string' || Buffer.byteLength(input[key] as string) > max))
    actionUnavailable();
}
function safeChallenge(c: ActionChallengeRow): SourceActionChallenge {
  return Object.freeze({ challengeId: c.id, purpose: c.purpose, method: c.method, expiresAt: new Date(c.expires_at_ms).toISOString(), state: c.state });
}
function resultFor(input: unknown, request: SourceActionDeliveryRequest): SourceActionDeliveryResult | null {
  if (!data(input, 'challengeId,disposition,method,subjectDigest') || input.challengeId !== request.challengeId || input.method !== request.method ||
    input.subjectDigest !== request.subjectDigest || !['accepted', 'rejected', 'unknown'].includes(input.disposition as string)) return null;
  return Object.freeze({ challengeId: request.challengeId, method: request.method, subjectDigest: request.subjectDigest,
    disposition: input.disposition as SourceActionDeliveryResult['disposition'] });
}
async function observeUntil<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(value => ({ value })), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, ms)); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function domainFailure(error: unknown): never {
  if (error instanceof DomainError && /^action_reauthentication_(held|unavailable|conflict|limit)$/.test(error.code)) throw error;
  return actionHeld();
}
export class SourceActionReauthentication {
  constructor(private readonly db: Sqlite, private readonly continuity: SourceActionContinuityWitness,
    private readonly keys: SourceActionKeys, private readonly delivery: SourceActionDelivery, private readonly clock: () => number) {
    this.entry(); actionKey(keys, keys.currentKeyId());
    if (!delivery || typeof delivery.start !== 'function') actionHeld();
  }
  private entry(): number {
    if (!this.db.open || this.db.inTransaction) actionHeld();
    const now = actionTime(this.clock); readSourceActionContinuity(this.db, this.continuity, now); return now;
  }
  private budget(context: AccountContext, now: number): Budget {
    let b = this.db.prepare('SELECT * FROM account_action_challenge_budgets WHERE account_id=?').get(context.accountId) as Budget | undefined;
    if (!b) {
      const total = this.db.prepare('SELECT count(*) n FROM account_action_challenge_budgets').get() as { n: number };
      if (total.n >= 10000) actionHeld();
      this.db.prepare('INSERT INTO account_action_challenge_budgets VALUES(?,?,1,1,0,0,0,0,0,0,?)').run(context.accountId, context.authUserId, now);
      b = this.db.prepare('SELECT * FROM account_action_challenge_budgets WHERE account_id=?').get(context.accountId) as Budget;
    }
    if (b.auth_user_id !== context.authUserId || now < b.last_seen_ms) actionHeld();
    return b;
  }
  private charge(context: AccountContext, quota: Quota, now: number): boolean {
    const b = this.budget(context, now), [limit, window] = limits[quota];
    const countKey = `${quota}_count` as const, windowKey = `${quota}_window_ms` as const;
    const roll = now - b[windowKey] >= window;
    const count = roll ? 0 : b[countKey], allowed = count < limit;
    const change = this.db.prepare(`UPDATE account_action_challenge_budgets SET ${countKey}=?,${windowKey}=?,last_seen_ms=?,revision=revision+1
      WHERE account_id=? AND revision=?`).run(allowed ? count + 1 : count, roll ? now : b[windowKey], now, context.accountId, b.revision);
    if (change.changes !== 1) actionHeld();
    return allowed;
  }
  private read(id: string): ActionChallengeRow | undefined {
    return this.db.prepare('SELECT * FROM account_action_challenges WHERE id=?').get(id) as ActionChallengeRow | undefined;
  }
  async issueChallenge(context: AccountContext, input: SourceActionIssue): Promise<SourceActionChallenge> {
    try { return await this.issue(context, input); } catch (error) { return domainFailure(error); }
  }
  private async issue(context: AccountContext, input: SourceActionIssue): Promise<SourceActionChallenge> {
    const realStart = performance.now(), entered = this.entry();
    bounded(input, 'method,purpose,requestKey', { method: 256, purpose: 256, requestKey: 128 });
    const allowed = this.db.transaction(() => {
      assertSourceActionContext(this.db, context, entered);
      readSourceActionContinuity(this.db, this.continuity, entered);
      return this.charge(context, 'request', entered);
    }).immediate();
    if (!allowed) failure('limit');
    if (!['account_delete', 'account_export'].includes(input.purpose) || !['email_action_code', 'phone_action_code'].includes(input.method) ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.requestKey)) actionUnavailable();
    const keyId = this.keys.currentKeyId(), key = actionKey(this.keys, keyId), code = randomInt(100000000).toString().padStart(8, '0');
    const decision = this.db.transaction(() => {
      const now = actionTime(this.clock), expires = assertSourceActionContext(this.db, context, now);
      const current = readSourceActionContinuity(this.db, this.continuity, now, true);
      const b = this.budget(context, now), issueKey = evidenceDigest(['form-action-issue/v1', input.requestKey]);
      const prior = this.db.prepare('SELECT * FROM account_action_challenges WHERE account_id=? AND issue_key_digest=?')
        .get(context.accountId, issueKey) as ActionChallengeRow | undefined;
      const subject = readSourceActionSubject(this.db, context, input.method, prior ? actionKey(this.keys, prior.key_id) : key, now);
      if (prior) {
        if (prior.auth_user_id !== context.authUserId || prior.session_id !== context.sessionId || prior.lifecycle_epoch !== context.epoch ||
          prior.purpose !== input.purpose || prior.method !== input.method || prior.binding_revision !== b.binding_revision ||
          prior.generation_digest !== evidenceDigest(current.generation) || prior.continuity_digest !== current.continuityDigest ||
          prior.provenance_id !== subject.provenanceId || prior.subject_digest !== subject.subjectDigest || prior.provenance_digest !== subject.provenanceDigest)
          return { error: 'conflict' as const };
        return { prior };
      }
      const active = this.db.prepare("SELECT * FROM account_action_challenges WHERE account_id=? AND state IN('dispatching','ready')")
        .get(context.accountId) as ActionChallengeRow | undefined;
      if (active?.state === 'dispatching') return { error: 'held' as const };
      const count = this.db.prepare('SELECT count(*) n FROM account_action_challenges WHERE account_id=?').get(context.accountId) as { n: number };
      const total = this.db.prepare('SELECT count(*) n FROM account_action_challenges').get() as { n: number };
      if (count.n >= 128 || total.n >= 10000 || expires <= now + 1) return { error: 'held' as const };
      if (!this.charge(context, 'send', now)) return { error: 'limit' as const };
      if (active) this.db.prepare("UPDATE account_action_challenges SET state='invalidated',revision=revision+1 WHERE id=? AND revision=? AND state='ready'")
        .run(active.id, active.revision);
      const c: ActionChallengeRow = { id: randomUUID(), account_id: context.accountId, auth_user_id: context.authUserId, session_id: context.sessionId,
        lifecycle_epoch: context.epoch, purpose: input.purpose, method: input.method, issue_key_digest: issueKey, nonce: randomBytes(32).toString('hex'), key_id: keyId,
        code_mac: '', subject_kind: subject.kind, provenance_id: subject.provenanceId, subject_digest: subject.subjectDigest, provenance_digest: subject.provenanceDigest,
        binding_revision: b.binding_revision, generation_digest: evidenceDigest(current.generation), continuity_digest: current.continuityDigest,
        schema_digest: current.schemaDigest, authority_id: current.checkpoint.authorityId, authority_schema_digest: current.checkpoint.ledgerSchemaDigest,
        checkpoint_revision: current.checkpoint.revision, checkpoint_sequence: current.checkpoint.committedSequence, checkpoint_head: current.checkpoint.committedHeadDigest,
        issued_at_ms: now, expires_at_ms: Math.min(now + 300000, expires), delivery_deadline_ms: Math.min(now + 10000, expires), state: 'dispatching',
        revision: 1, attempt_count: 0, delivery_settled_at_ms: null, consumed_at_ms: null };
      c.code_mac = actionMac(key, 'code', [actionChallengeBinding(c), code]);
      const columns = Object.keys(c);
      this.db.prepare(`INSERT INTO account_action_challenges(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...Object.values(c));
      const request: SourceActionDeliveryRequest = Object.freeze({ challengeId: c.id, purpose: c.purpose, method: c.method, authUserId: c.auth_user_id,
        destination: subject.destination, subjectDigest: c.subject_digest, code, deadlineAtMs: c.delivery_deadline_ms });
      return { c, request };
    }).immediate();
    if ('error' in decision && decision.error) failure(decision.error);
    if ('prior' in decision && decision.prior) return safeChallenge(decision.prior);
    if (!('c' in decision) || !decision.c || !decision.request) actionHeld();
    const { c, request } = decision;
    let operation: ReturnType<SourceActionDelivery['start']>;
    try {
      const candidate: unknown = this.delivery.start(request);
      const pending = candidate && typeof candidate === 'object' ? Object.getOwnPropertyDescriptor(candidate, 'settled')?.value as unknown : undefined;
      if (pending instanceof Promise) void pending.then(() => {}, () => {});
      if (candidate instanceof Promise) void candidate.then(() => {}, () => {});
      if (!data(candidate, 'cancel,settled') || !(candidate.settled instanceof Promise) || typeof candidate.cancel !== 'function') actionHeld();
      operation = candidate as ReturnType<SourceActionDelivery['start']>;
    } catch { return actionHeld(); }
    // Late observers consume outcomes only. They never write SQL or release dispatch exclusion.
    const settlement = operation.settled.then(value => ({ ok: true as const, value }), () => ({ ok: false as const }));
    const remaining = () => {
      try { return Math.max(0, Math.min(10000 - (performance.now() - realStart), c.delivery_deadline_ms - actionTime(this.clock))); }
      catch { return 0; }
    };
    const outcome = await observeUntil(settlement, Math.max(0, remaining() - 500));
    let result: SourceActionDeliveryResult | null = null;
    try { if (outcome?.value.ok) result = resultFor(outcome.value.value, request); } catch { /* Unclassified result retains exclusion. */ }
    if (!result || remaining() <= 500) {
      let cancellation: Promise<boolean>;
      try {
        const pending: unknown = operation.cancel();
        cancellation = pending instanceof Promise ? pending.then(() => true, () => false) : Promise.resolve(false);
      } catch { cancellation = Promise.resolve(false); }
      await observeUntil(Promise.all([settlement, cancellation]), remaining());
      return actionHeld();
    }
    try {
      return this.db.transaction(() => {
        const now = actionTime(this.clock), row = this.read(c.id);
        if (!row || row.revision !== c.revision || row.state !== 'dispatching' || now >= c.delivery_deadline_ms || performance.now() - realStart >= 10000) actionHeld();
        assertSourceActionChallengeCurrent(this.db, row, context, this.continuity, this.keys, now);
        const next = result.disposition === 'accepted' ? 'ready' : result.disposition === 'rejected' ? 'failed' : 'unknown';
        if (this.db.prepare('UPDATE account_action_challenges SET state=?,delivery_settled_at_ms=?,revision=revision+1 WHERE id=? AND revision=? AND state=\'dispatching\'')
          .run(next, now, c.id, c.revision).changes !== 1) actionHeld();
        return safeChallenge(this.read(c.id)!);
      }).immediate();
    } catch { return actionHeld(); }
  }
  verifyChallenge(context: AccountContext, input: SourceActionVerify) {
    try { return this.verify(context, input); } catch (error) { return domainFailure(error); }
  }
  private verify(context: AccountContext, input: SourceActionVerify) {
    const entered = this.entry();
    bounded(input, 'challengeId,code,purpose', { challengeId: 256, code: 256, purpose: 256 });
    const reservation = this.db.transaction(() => {
      assertSourceActionContext(this.db, context, entered);
      readSourceActionContinuity(this.db, this.continuity, entered);
      if (!this.charge(context, 'request', entered)) return { error: 'limit' as const };
      if (!this.charge(context, 'verify', entered)) return { error: 'limit' as const };
      const c = actionId(input.challengeId) ? this.read(input.challengeId) : undefined;
      if (!c || c.account_id !== context.accountId || c.session_id !== context.sessionId || c.lifecycle_epoch !== context.epoch ||
        c.purpose !== input.purpose || c.state !== 'ready' || c.attempt_count >= 3) return { error: 'unavailable' as const };
      try { assertSourceActionChallengeCurrent(this.db, c, context, this.continuity, this.keys, entered); }
      catch { return { error: 'held' as const }; }
      if (this.db.prepare("UPDATE account_action_challenges SET attempt_count=attempt_count+1,revision=revision+1 WHERE id=? AND state='ready' AND revision=?")
        .run(c.id, c.revision).changes !== 1) return { error: 'held' as const };
      return { c: this.read(c.id)! };
    }).immediate();
    if ('error' in reservation && reservation.error) failure(reservation.error);
    const c = reservation.c!;
    const valid = /^[0-9]{8}$/.test(input.code) && equalActionMac(c.code_mac, actionMac(actionKey(this.keys, c.key_id), 'code', [actionChallengeBinding(c), input.code]));
    if (!valid) {
      if (c.attempt_count === 3) this.db.transaction(() => {
        this.db.prepare("UPDATE account_action_challenges SET state='failed',revision=revision+1 WHERE id=? AND revision=? AND state='ready'").run(c.id, c.revision);
      }).immediate();
      return actionUnavailable();
    }
    try {
      return this.db.transaction(() => {
        const now = actionTime(this.clock), current = this.read(c.id);
        if (!current || current.state !== 'ready' || current.revision !== c.revision) actionUnavailable();
        assertSourceActionChallengeCurrent(this.db, current, context, this.continuity, this.keys, now);
        if (!equalActionMac(current.code_mac, actionMac(actionKey(this.keys, current.key_id), 'code', [actionChallengeBinding(current), input.code]))) actionUnavailable();
        const token = randomBytes(32).toString('base64url'), expires = Math.min(now + 300000, current.expires_at_ms, assertSourceActionContext(this.db, context, now));
        const p: ActionProofRow = { challenge_id: c.id, grant_hash: hash(token), proof_digest: '', verified_at_ms: now,
          grant_expires_at_ms: expires, used_at_ms: null, deletion_request_id: null };
        p.proof_digest = actionProofDigest(current, p);
        this.db.prepare('INSERT INTO account_action_grants VALUES(?,?,?,?,?,?,?,?,NULL)').run(p.grant_hash, context.accountId, context.sessionId, context.epoch,
          current.purpose, current.method, now, expires);
        this.db.prepare('INSERT INTO account_action_proof_consumptions VALUES(?,?,?,?,?,NULL,NULL)').run(c.id, p.grant_hash, p.proof_digest, now, expires);
        const proof = this.db.prepare('SELECT * FROM account_action_proof_consumptions WHERE challenge_id=?').get(c.id) as ActionProofRow;
        const granted = this.db.prepare('SELECT token_hash FROM account_action_grants WHERE token_hash=? AND consumed_at_ms IS NULL').get(p.grant_hash);
        if (!granted || this.read(c.id)?.state !== 'consumed' || proof.proof_digest !== p.proof_digest || proof.grant_hash !== p.grant_hash) actionHeld();
        readSourceActionContinuity(this.db, this.continuity, now);
        return Object.freeze({ grant: token, purpose: current.purpose, method: current.method, expiresAt: new Date(expires).toISOString() });
      }).immediate();
    } catch { return actionHeld(); }
  }
}
