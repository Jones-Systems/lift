import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import type { Sqlite } from '../storage.js';
import { hash } from '../storage.js';
import { DomainError } from '../errors.js';
import { phoneEmail } from '../phone/challenges.js';
import { assertActive } from './guards.js';
import { evidenceCanonical, evidenceDigest } from './evidence-codec.js';
import { bindSourceLifecycleCurrentness, readSourceLifecycleStoreCurrentness,
  type SourceLifecycleCurrentness, type SourceLifecycleEvidenceGeneration, type SourceLifecycleEvidenceWitnessReader,
  type SourceLifecycleStoreSnapshot } from './evidence-store.js';
import type { AccountContext, SourceActionKeys, SourceActionMethod, SourceActionPurpose, SourceActionState } from './types.js';

export function actionHeld(): never { throw new DomainError(503, 'action_reauthentication_held'); }
export function actionUnavailable(): never { throw new DomainError(403, 'action_reauthentication_unavailable'); }
export const actionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
export const actionInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function actionTime(clock: () => number): number {
  const now = clock(); if (!actionInteger(now) || now > Number.MAX_SAFE_INTEGER - 3600000) actionHeld(); return now;
}
export function actionKey(keys: SourceActionKeys, id: string): Buffer {
  try {
    if (!actionId(id)) actionHeld();
    const value = keys.lookup(id);
    if (!(value instanceof Uint8Array) || value.byteLength !== 32) actionHeld();
    return Buffer.from(value);
  } catch { return actionHeld(); }
}
export function actionMac(key: Uint8Array, domain: 'code' | 'subject' | 'provenance', value: unknown): string {
  return createHmac('sha256', key).update(evidenceCanonical([`form-action-${domain}/v1`, value])).digest('hex');
}
export function equalActionMac(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export type ActionChallengeRow = {
  id: string; account_id: string; auth_user_id: string; session_id: string; lifecycle_epoch: number;
  purpose: SourceActionPurpose; method: SourceActionMethod; issue_key_digest: string; nonce: string; key_id: string; code_mac: string;
  subject_kind: 'verified_primary_email' | 'verified_bound_phone'; provenance_id: string; subject_digest: string; provenance_digest: string;
  binding_revision: number; generation_digest: string; continuity_digest: string; schema_digest: string;
  authority_id: string; authority_schema_digest: string; checkpoint_revision: number; checkpoint_sequence: number; checkpoint_head: string;
  issued_at_ms: number; expires_at_ms: number; delivery_deadline_ms: number; state: SourceActionState; revision: number;
  attempt_count: number; delivery_settled_at_ms: number | null; consumed_at_ms: number | null;
};
export type ActionProofRow = { challenge_id: string; grant_hash: string; proof_digest: string; verified_at_ms: number;
  grant_expires_at_ms: number; used_at_ms: number | null; deletion_request_id: string | null };
export function actionChallengeBinding(c: ActionChallengeRow): unknown {
  return [c.id, c.account_id, c.auth_user_id, c.session_id, c.lifecycle_epoch, c.purpose, c.method, c.issue_key_digest, c.nonce,
    c.key_id, c.subject_kind, c.provenance_id, c.subject_digest, c.provenance_digest, c.binding_revision, c.generation_digest,
    c.continuity_digest, c.schema_digest, c.authority_id, c.authority_schema_digest, c.checkpoint_revision, c.checkpoint_sequence,
    c.checkpoint_head, c.issued_at_ms, c.expires_at_ms, c.delivery_deadline_ms];
}
export function actionProofDigest(c: ActionChallengeRow, p: Pick<ActionProofRow, 'verified_at_ms' | 'grant_expires_at_ms' | 'grant_hash'>): string {
  return evidenceDigest(['form-action-proof/v1', actionChallengeBinding(c), p.verified_at_ms, p.grant_expires_at_ms, p.grant_hash]);
}

type ContinuityRecord = SourceLifecycleEvidenceGeneration & Readonly<{ schema: 'source-action-continuity/v1'; revision: number;
  observedAtMs: number; restoreBoundaryMs: number | null }>;
declare const continuityBrand: unique symbol;
export type SourceActionContinuityWitness = Readonly<{ [continuityBrand]: true }>;
type ContinuityState = { db: Sqlite; path: string; identity: string; generation: SourceLifecycleEvidenceGeneration;
  port: SourceLifecycleCurrentness; digest: string };
const continuity = new WeakMap<SourceActionContinuityWitness, ContinuityState>();
const continuityByDatabase = new WeakMap<Sqlite, ContinuityState>();
// Independent of main handles; only the root custodian writes the native record.
const continuityHighWater = new Map<string, { identity: string; revision: number; observed: number; bytes: string }>();
function nativeContinuity(path: string): { record: ContinuityRecord; identity: string; bytes: string } {
  if (!isAbsolute(path) || path.length > 4096 || realpathSync(path) !== path || !process.getuid) actionHeld();
  const uid = process.getuid(), parents: unknown[] = [];
  let parent = dirname(path);
  const home = homedir();
  if (relative(home, parent).startsWith('..') || !relative(home, parent)) actionHeld();
  for (;;) {
    const stat = lstatSync(parent, { bigint: true });
    if (!stat.isDirectory() || Number(stat.uid) !== uid || (stat.mode & 0o7777n) !== 0o700n || realpathSync(parent) !== parent) actionHeld();
    parents.push([parent, String(stat.dev), String(stat.ino)]);
    if (parent === home) break;
    parent = dirname(parent);
  }
  const before = lstatSync(path, { bigint: true });
  const identity = (stat: typeof before) => evidenceCanonical([path, String(stat.dev), String(stat.ino), parents]);
  const valid = (stat: typeof before) => stat.isFile() && stat.nlink === 1n && Number(stat.uid) === uid &&
    (stat.mode & 0o7777n) === 0o600n && stat.size > 0n && stat.size <= 2048n;
  if (!valid(before)) actionHeld();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: string;
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!valid(opened) || identity(before) !== identity(opened)) actionHeld();
    const buffer = Buffer.alloc(2049); let count = 0;
    while (count < buffer.length) { const read = readSync(fd, buffer, count, buffer.length - count, null); if (!read) break; count += read; }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (count !== Number(before.size) || count > 2048 || !valid(after) || !valid(named) ||
      identity(before) !== identity(after) || identity(before) !== identity(named) || after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs || realpathSync(path) !== path) actionHeld();
    bytes = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
  } finally { closeSync(fd); }
  const input: unknown = JSON.parse(bytes);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !==
    'databaseGeneration,mainStoreId,observedAtMs,restoreBoundaryMs,revision,schema,witnessRevision') actionHeld();
  if (bytes !== evidenceCanonical(input)) actionHeld();
  const r = input as ContinuityRecord;
  if (r.schema !== 'source-action-continuity/v1' || !actionId(r.mainStoreId) || !actionId(r.databaseGeneration) ||
    !actionInteger(r.witnessRevision) || !actionInteger(r.revision) || !actionInteger(r.observedAtMs) ||
    (r.restoreBoundaryMs !== null && (!actionInteger(r.restoreBoundaryMs) || r.restoreBoundaryMs > r.observedAtMs ||
      r.restoreBoundaryMs > Number.MAX_SAFE_INTEGER - 3600000))) actionHeld();
  const id = identity(before), prior = continuityHighWater.get(path);
  if (prior && (id !== prior.identity || r.revision < prior.revision || r.observedAtMs < prior.observed ||
    (r.revision === prior.revision && bytes !== prior.bytes))) actionHeld();
  continuityHighWater.set(path, { identity: id, revision: r.revision, observed: r.observedAtMs, bytes });
  return { record: Object.freeze({ ...r }), identity: id, bytes };
}
function recordGeneration(r: ContinuityRecord): SourceLifecycleEvidenceGeneration {
  return { mainStoreId: r.mainStoreId, databaseGeneration: r.databaseGeneration, witnessRevision: r.witnessRevision };
}
function continuityDigest(r: ContinuityRecord): string {
  return evidenceDigest(['source-action-continuity/v1', recordGeneration(r), r.restoreBoundaryMs]);
}
// The root custodian supplies canonical UTF-8 JSON; this constructor only reads it and never heals admission.
export function bindSourceActionContinuityWitness(db: Sqlite, witness: SourceLifecycleEvidenceWitnessReader,
  input: Readonly<{ recordPath: string }>): SourceActionContinuityWitness {
  try {
    if (!input || Object.keys(input).join(',') !== 'recordPath' || typeof input.recordPath !== 'string' || db.inTransaction ||
      !relative(dirname(db.name), input.recordPath).startsWith('..')) actionHeld();
    const read = nativeContinuity(input.recordPath);
    const state: ContinuityState = { db, path: input.recordPath, identity: read.identity, generation: recordGeneration(read.record),
      port: bindSourceLifecycleCurrentness(db, witness, 'selected-action-reauthentication-26'), digest: continuityDigest(read.record) };
    continuityByDatabase.set(db, state);
    const current = readSourceLifecycleStoreCurrentness(state.port);
    if (evidenceCanonical(current.generation) !== evidenceCanonical(state.generation)) actionHeld();
    const handle = Object.freeze(Object.create(null)) as SourceActionContinuityWitness;
    continuity.set(handle, state); return handle;
  } catch { return actionHeld(); }
}
export function assertSourceActionContinuityRecord(db: Sqlite, generation: SourceLifecycleEvidenceGeneration): ContinuityRecord {
  try {
    const state = continuityByDatabase.get(db); if (!state) actionHeld();
    const read = nativeContinuity(state.path);
    if (read.identity !== state.identity || evidenceCanonical(recordGeneration(read.record)) !== evidenceCanonical(generation) ||
      evidenceCanonical(generation) !== evidenceCanonical(state.generation) || continuityDigest(read.record) !== state.digest) actionHeld();
    return read.record;
  } catch { return actionHeld(); }
}
export function readSourceActionContinuity(db: Sqlite, witness: SourceActionContinuityWitness, now: number, issuance = false) {
  const state = continuity.get(witness); if (!state || state.db !== db) actionHeld();
  const current = readSourceLifecycleStoreCurrentness(state.port), record = assertSourceActionContinuityRecord(db, current.generation);
  if (!actionInteger(now) || now < record.observedAtMs ||
    (issuance && record.restoreBoundaryMs !== null && now < record.restoreBoundaryMs + 3600000)) actionHeld();
  return Object.freeze({ ...current, continuityDigest: state.digest });
}

export function assertSourceActionContext(db: Sqlite, context: AccountContext, now: number): number {
  if (!context || Object.keys(context).sort().join(',') !== 'accountId,authUserId,epoch,sessionId' ||
    ![context.accountId, context.authUserId, context.sessionId].every(actionId) || !actionInteger(context.epoch)) actionUnavailable();
  assertActive(db, context);
  const row = db.prepare('SELECT expiresAt FROM session WHERE id=? AND userId=?').get(context.sessionId, context.authUserId) as { expiresAt: number } | undefined;
  if (!row || !actionInteger(row.expiresAt) || row.expiresAt <= now) actionUnavailable();
  return row.expiresAt;
}
export type ActionSubject = Readonly<{ destination: string; kind: ActionChallengeRow['subject_kind']; provenanceId: string;
  subjectDigest: string; provenanceDigest: string }>;
export function readSourceActionSubject(db: Sqlite, context: AccountContext, method: SourceActionMethod, key: Uint8Array, now: number): ActionSubject {
  if (db.prepare("SELECT 1 FROM account WHERE userId=? AND providerId='credential' AND password IS NOT NULL LIMIT 1").get(context.authUserId)) actionUnavailable();
  const user = db.prepare('SELECT email,emailVerified,phoneNumber,phoneNumberVerified FROM "user" WHERE id=?').get(context.authUserId) as
    { email: string; emailVerified: number; phoneNumber: string | null; phoneNumberVerified: number } | undefined;
  if (!user) actionUnavailable();
  if (method === 'email_action_code') {
    if (typeof user.email !== 'string' || Buffer.byteLength(user.email) > 254 || user.emailVerified !== 1) actionUnavailable();
    const email = user.email.trim().toLowerCase();
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(email) || email.endsWith('@phone.form.invalid')) actionUnavailable();
    return { destination: email, kind: 'verified_primary_email', provenanceId: context.authUserId,
      subjectDigest: actionMac(key, 'subject', [context.authUserId, 'verified_primary_email', email, 1]),
      provenanceDigest: actionMac(key, 'provenance', [context.authUserId, 'primary-email', email, 1]) };
  }
  if (method !== 'phone_action_code' || typeof user.phoneNumber !== 'string' || !/^\+[1-9][0-9]{6,14}$/.test(user.phoneNumber) ||
    user.phoneNumberVerified !== 1 || user.email !== phoneEmail(user.phoneNumber)) actionUnavailable();
  const row = db.prepare(`SELECT id,auth_user_id,phone,status,approved_at,provider_sid FROM phone_challenges INDEXED BY action_phone_provenance
    WHERE auth_user_id=? AND phone=? AND status='consumed' AND approved_at IS NOT NULL ORDER BY approved_at DESC,id LIMIT 1`)
    .get(context.authUserId, user.phoneNumber) as { id: string; auth_user_id: string; phone: string; status: string; approved_at: number; provider_sid: string | null } | undefined;
  if (!row || !actionId(row.id) || !actionInteger(row.approved_at) || row.approved_at > now || !actionId(row.provider_sid)) actionUnavailable();
  return { destination: user.phoneNumber, kind: 'verified_bound_phone', provenanceId: row.id,
    subjectDigest: actionMac(key, 'subject', [context.authUserId, 'verified_bound_phone', user.phoneNumber, 1]),
    provenanceDigest: actionMac(key, 'provenance', [row.id, row.auth_user_id, row.phone, row.status, row.approved_at, row.provider_sid]) };
}
export function assertSourceActionChallengeCurrent(db: Sqlite, c: ActionChallengeRow, context: AccountContext, witness: SourceActionContinuityWitness,
  keys: SourceActionKeys, now: number): void {
  assertSourceActionContext(db, context, now);
  const current = readSourceActionContinuity(db, witness, now), key = actionKey(keys, c.key_id);
  const subject = readSourceActionSubject(db, context, c.method, key, now);
  const budget = db.prepare('SELECT binding_revision FROM account_action_challenge_budgets WHERE account_id=? AND auth_user_id=?')
    .get(context.accountId, context.authUserId) as { binding_revision: number } | undefined;
  if (c.account_id !== context.accountId || c.auth_user_id !== context.authUserId || c.session_id !== context.sessionId || c.lifecycle_epoch !== context.epoch ||
    c.expires_at_ms <= now || c.issued_at_ms > now || c.generation_digest !== evidenceDigest(current.generation) || c.continuity_digest !== current.continuityDigest ||
    c.schema_digest !== current.schemaDigest || c.authority_id !== current.checkpoint.authorityId || c.authority_schema_digest !== current.checkpoint.ledgerSchemaDigest ||
    c.checkpoint_revision > current.checkpoint.revision || c.checkpoint_sequence > current.checkpoint.committedSequence ||
    c.binding_revision !== budget?.binding_revision || c.subject_kind !== subject.kind || c.provenance_id !== subject.provenanceId ||
    !equalActionMac(c.subject_digest, subject.subjectDigest) || !equalActionMac(c.provenance_digest, subject.provenanceDigest)) actionUnavailable();
  // The actual authority validates the captured checkpoint as a prefix, including its head.
  const state = continuity.get(witness)!;
  readSourceLifecycleStoreCurrentness(state.port, { authorityId: c.authority_id, ledgerSchemaDigest: c.authority_schema_digest,
    revision: c.checkpoint_revision, committedSequence: c.checkpoint_sequence, committedHeadDigest: c.checkpoint_head });
}

declare const authorityBrand: unique symbol;
export type SourceActionAuthority = Readonly<{ [authorityBrand]: true }>;
const authorities = new WeakMap<SourceActionAuthority, { db: Sqlite; witness: SourceActionContinuityWitness; keys: SourceActionKeys; clock: () => number }>();
export function assertSourceActionAuthority(authority: SourceActionAuthority, db: Sqlite): void {
  const state = authorities.get(authority);
  if (!state || state.db !== db) actionUnavailable();
  readSourceActionContinuity(db, state.witness, actionTime(state.clock));
}
export function bindSourceActionAuthority(db: Sqlite, witness: SourceActionContinuityWitness, keys: SourceActionKeys, clock: () => number): SourceActionAuthority {
  readSourceActionContinuity(db, witness, actionTime(clock));
  actionKey(keys, keys.currentKeyId());
  const authority = Object.freeze(Object.create(null)) as SourceActionAuthority;
  authorities.set(authority, { db, witness, keys, clock }); return authority;
}
export function consumeSourceActionProof(authority: SourceActionAuthority, db: Sqlite, context: AccountContext, token: string,
  purpose: SourceActionPurpose, requestId?: string): Readonly<{ method: SourceActionMethod; verifiedAtMs: number; usedAtMs: number }> {
  const state = authorities.get(authority);
  if (!state || state.db !== db || !db.inTransaction || !/^[A-Za-z0-9_-]{43}$/.test(token)) actionUnavailable();
  const now = actionTime(state.clock), tokenHash = hash(token);
  const grant = db.prepare('SELECT * FROM account_action_grants WHERE token_hash=?').get(tokenHash) as
    { account_id: string; session_id: string; epoch: number; purpose: string; method: string; verified_at_ms: number; expires_at_ms: number; consumed_at_ms: number | null } | undefined;
  const p = db.prepare('SELECT * FROM account_action_proof_consumptions WHERE grant_hash=?').get(tokenHash) as ActionProofRow | undefined;
  const c = p && db.prepare('SELECT * FROM account_action_challenges WHERE id=?').get(p.challenge_id) as ActionChallengeRow | undefined;
  if (!grant || !p || !c || c.state !== 'consumed' || c.consumed_at_ms !== p.verified_at_ms || c.purpose !== purpose || p.used_at_ms !== null ||
    p.deletion_request_id !== null || p.grant_expires_at_ms <= now || p.verified_at_ms > now || actionProofDigest(c, p) !== p.proof_digest ||
    grant.account_id !== c.account_id || grant.session_id !== c.session_id || grant.epoch !== c.lifecycle_epoch || grant.purpose !== c.purpose ||
    grant.method !== c.method || grant.verified_at_ms !== p.verified_at_ms || grant.expires_at_ms !== p.grant_expires_at_ms || grant.consumed_at_ms !== null ||
    (purpose === 'account_delete' ? !actionId(requestId) : requestId !== undefined)) actionUnavailable();
  assertSourceActionChallengeCurrent(db, c, context, state.witness, state.keys, now);
  if (db.prepare('UPDATE account_action_proof_consumptions SET used_at_ms=?,deletion_request_id=? WHERE challenge_id=? AND used_at_ms IS NULL')
    .run(now, requestId ?? null, c.id).changes !== 1) actionUnavailable();
  if (db.prepare('UPDATE account_action_grants SET consumed_at_ms=? WHERE token_hash=? AND consumed_at_ms IS NULL').run(now, tokenHash).changes !== 1) actionUnavailable();
  const readback = db.prepare('SELECT * FROM account_action_proof_consumptions WHERE challenge_id=?').get(c.id) as ActionProofRow;
  if (readback.used_at_ms !== now || readback.deletion_request_id !== (requestId ?? null) || readback.proof_digest !== p.proof_digest) actionHeld();
  return Object.freeze({ method: c.method, verifiedAtMs: p.verified_at_ms, usedAtMs: now });
}
export function recheckSourceActionProofUse(authority: SourceActionAuthority, db: Sqlite, context: AccountContext, token: string, requestId: string): void {
  assertSourceActionAuthority(authority, db);
  const state = authorities.get(authority)!;
  const proof = db.prepare('SELECT * FROM account_action_proof_consumptions WHERE grant_hash=?').get(hash(token)) as ActionProofRow | undefined;
  const challenge = proof && db.prepare('SELECT * FROM account_action_challenges WHERE id=?').get(proof.challenge_id) as ActionChallengeRow | undefined;
  if (!proof || !challenge || proof.deletion_request_id !== requestId || proof.used_at_ms === null ||
    challenge.purpose !== 'account_delete' || actionProofDigest(challenge, proof) !== proof.proof_digest) actionHeld();
  assertSourceActionChallengeCurrent(db, challenge, context, state.witness, state.keys, actionTime(state.clock));
}
export function resolveSourceActionDeletionProof(db: Sqlite, requestId: string, generationDigest: string, schemaDigest: string): string {
  const p = db.prepare('SELECT * FROM account_action_proof_consumptions WHERE deletion_request_id=?').get(requestId) as ActionProofRow | undefined;
  const c = p && db.prepare('SELECT * FROM account_action_challenges WHERE id=?').get(p.challenge_id) as ActionChallengeRow | undefined;
  const r = db.prepare(`SELECT r.*,f.auth_user_id,l.epoch,l.state FROM account_deletion_requests r JOIN form_accounts f ON f.id=r.account_id
    JOIN account_lifecycle l ON l.account_id=r.account_id WHERE r.id=?`).get(requestId) as
    { id: string; account_id: string; auth_user_id: string; epoch: number; state: string; verification_method: string; verified_at_ms: number;
      disabled_at_ms: number; requested_at_ms: number; intent_hash: string } | undefined;
  if (!p || !c || !r || !['email_action_code', 'phone_action_code'].includes(c.method) || r.verification_method !== c.method ||
    c.purpose !== 'account_delete' || c.state !== 'consumed' || c.consumed_at_ms !== p.verified_at_ms ||
    r.verified_at_ms !== p.verified_at_ms || r.account_id !== c.account_id || r.auth_user_id !== c.auth_user_id || r.epoch !== c.lifecycle_epoch + 1 ||
    r.state !== 'disabled' || !actionInteger(p.used_at_ms) || p.used_at_ms < p.verified_at_ms || p.used_at_ms >= p.grant_expires_at_ms ||
    p.grant_expires_at_ms > c.expires_at_ms || p.verified_at_ms < c.issued_at_ms || p.verified_at_ms >= p.grant_expires_at_ms ||
    p.grant_expires_at_ms - p.verified_at_ms > 300000 || r.disabled_at_ms !== p.used_at_ms || r.requested_at_ms > p.used_at_ms ||
    c.generation_digest !== generationDigest || c.schema_digest !== schemaDigest || !/^[a-f0-9]{64}$/.test(p.grant_hash) ||
    actionProofDigest(c, p) !== p.proof_digest) actionHeld();
  return evidenceDigest(['form-action-deletion-proof/v1', r.id, r.intent_hash, p.proof_digest, p.used_at_ms]);
}
