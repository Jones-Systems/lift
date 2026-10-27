import { sourceLifecycleLocalAbsenceReadback, type SourceLifecycleLocalAbsenceReader } from './local-absence.js';
import type { LifecycleAdapter } from './types.js';
import { lstatSync, realpathSync } from 'node:fs';
import type { Sqlite } from '../storage.js';
import { DomainError } from '../errors.js';
import { CurrentSuppressionAuthority, canonicalDisable, advanceHead, genesisHead } from '../runtime-modules/currentness.js';
import { suppressionAuthority } from './guards.js';
import { currentLocalPurgeFrame, type LocalPurgeFrame } from './purge-executor.js';
import { lifecycleEvidenceSchemaObjects } from './evidence-migration.js';
import { assertSourceLifecycleEvidenceHistory } from './source-migrations.js';
import { evidenceCanonical, evidenceDigest, evidenceIdSchema, evidenceOperationSchema, encodeDurableEvidence,
  decodeDurableEvidence, type EvidenceOperation, type DurableEvidence } from './evidence-codec.js';
import { appendCompletionFact, calculateCompletion, createCompletionHistory, type CompletionBinding,
  type CompletionCalculation, type CompletionFact, type CompletionHistory, type CompletionTarget } from './completion.js';
import type { DisableRecord, LifecycleResult } from './types.js';

function held(): never { throw new DomainError(503, 'lifecycle_evidence_held'); }
function conflict(): never { throw new DomainError(409, 'lifecycle_evidence_conflict'); }
const normalize = (sql: string) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
export function assertLifecycleEvidenceSchema(db: Sqlite, installed: boolean): void {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all() as
    { type: string; name: string; tbl_name: string; sql: string | null }[];
  const related = rows.filter(row => lifecycleEvidenceSchemaObjects.some(object => object.name === row.name) ||
    ['account_deletion_evidence_operations', 'account_deletion_evidence'].includes(row.tbl_name));
  if (!installed) { if (related.length) held(); return; }
  if (related.length !== lifecycleEvidenceSchemaObjects.length || lifecycleEvidenceSchemaObjects.some(object =>
    !related.some(row => row.name === object.name && row.type === object.type && row.sql !== null && normalize(row.sql) === normalize(object.sql)))) held();
}
function schemaDigest(db: Sqlite): string {
  assertSourceLifecycleEvidenceHistory(db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as
    { version: number; checksum: string }[], true);
  assertLifecycleEvidenceSchema(db, true);
  return evidenceDigest(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all());
}

export type SourceLifecycleEvidenceGeneration = Readonly<{ databaseGeneration: string; mainStoreId: string; witnessRevision: number }>;
declare const witnessBrand: unique symbol;
export type SourceLifecycleEvidenceWitnessReader = Readonly<{ [witnessBrand]: true }>;
type ReaderBinding = Readonly<{ db: Sqlite; authority: CurrentSuppressionAuthority; file: string;
  generation: SourceLifecycleEvidenceGeneration; read: (db: Sqlite) => SourceLifecycleEvidenceGeneration | null }>;
const readers = new WeakMap<SourceLifecycleEvidenceWitnessReader, ReaderBinding>();
function fileIdentity(db: Sqlite): string {
  const stat = lstatSync(db.name, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || realpathSync(db.name) !== db.name) held();
  return evidenceCanonical([db.name, String(stat.dev), String(stat.ino)]);
}
function generation(input: unknown): SourceLifecycleEvidenceGeneration {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'databaseGeneration,mainStoreId,witnessRevision') held();
  const value = input as SourceLifecycleEvidenceGeneration;
  if (!evidenceIdSchema.safeParse(value.databaseGeneration).success || !evidenceIdSchema.safeParse(value.mainStoreId).success ||
    !Number.isSafeInteger(value.witnessRevision) || value.witnessRevision < 0) held();
  return Object.freeze({ databaseGeneration: value.databaseGeneration, mainStoreId: value.mainStoreId, witnessRevision: value.witnessRevision });
}
// This source-only composition seam trusts custody of the injected reader; it supplies no runtime24 admission provider.
export function bindSourceLifecycleEvidenceWitnessReader(db: Sqlite, authority: CurrentSuppressionAuthority,
  read: (db: Sqlite) => SourceLifecycleEvidenceGeneration | null): SourceLifecycleEvidenceWitnessReader {
  try {
    if (!db.open || !(authority instanceof CurrentSuppressionAuthority) || typeof read !== 'function') held();
    authority.checkpoint();
    const captured = generation(read(db)), reader = Object.freeze(Object.create(null)) as SourceLifecycleEvidenceWitnessReader;
    readers.set(reader, Object.freeze({ db, authority, file: fileIdentity(db), generation: captured, read }));
    return reader;
  } catch { return held(); }
}
type Snapshot = Readonly<{ binding: CompletionBinding; suppression: DisableRecord; policyVersion: string; proofDigest: string; stamp: string }>;
type PurgeEvidenceAttempt = Readonly<{ frame: LocalPurgeFrame; operation: EvidenceOperation; snapshot: Snapshot; categories: readonly string[] }>;
const attempts = new WeakSet<PurgeEvidenceAttempt>();
const completedAttempts = new WeakMap<PurgeEvidenceAttempt, readonly string[]>();
export type LocalEvidenceProjection = Readonly<{ calculation: CompletionCalculation; localPurged: boolean;
  completedCategories: readonly string[]; firstObservedAtMs: number | null;
  residuals: Readonly<{ retentionPolicy: 'unavailable'; providers: 'unavailable'; backups: 'unavailable';
    identityAnchors: 'retained'; purchaseProofs: 'retained'; billingCancellation: 'not_performed' }> }>;

export class LifecycleEvidenceStore {
  private readonly reader: ReaderBinding;
  private readonly schema: string;
  private lastCheckpoint: CompletionBinding['checkpoint'];
  private readonly absence: ReturnType<typeof sourceLifecycleLocalAbsenceReadback>;
  constructor(private readonly db: Sqlite, reader: SourceLifecycleEvidenceWitnessReader,
    adapters: readonly LifecycleAdapter[] = [], localAbsence: readonly SourceLifecycleLocalAbsenceReader[] = []) {
    this.absence = sourceLifecycleLocalAbsenceReadback(db, adapters, localAbsence);
    const bound = readers.get(reader);
    if (!bound || bound.db !== db) held();
    this.reader = bound; this.schema = schemaDigest(db);
    const checkpoint = bound.authority.checkpoint();
    this.lastCheckpoint = Object.freeze({ authorityId: checkpoint.authorityId, ledgerSchemaDigest: checkpoint.ledgerSchemaDigest,
      revision: checkpoint.revision, committedSequence: checkpoint.committedSequence, committedHeadDigest: checkpoint.committedHeadDigest });
  }
  hasLocalAbsence(category: string): boolean { return this.absence.qualified(category); }
  localAbsent(accountId: string, category: string): boolean { return this.absence.absent(accountId, category); }
  assertDatabase(db: Sqlite): void { if (db !== this.db) held(); }
  assertAuthority(authority: CurrentSuppressionAuthority): void { if (authority !== this.reader.authority) held(); }
  private snapshot(requestId: string): Snapshot {
    try {
      const { db, reader } = this;
      if (!db.open || suppressionAuthority(db) !== reader.authority || reader.file !== fileIdentity(db) ||
        evidenceCanonical(generation(reader.read(db))) !== evidenceCanonical(reader.generation) || schemaDigest(db) !== this.schema) held();
      const row = db.prepare(`SELECT r.account_id,r.policy_version,r.intent_hash,r.verified_at_ms,r.verification_method,l.state,l.epoch,l.suppression_seq,f.auth_user_id
        FROM account_deletion_requests r JOIN form_accounts f ON f.id=r.account_id
        JOIN account_lifecycle l ON l.account_id=r.account_id WHERE r.id=?`).get(requestId) as
        { account_id: string; auth_user_id: string; state: string; epoch: number; suppression_seq: number; policy_version: string;
          intent_hash: string; verified_at_ms: number | null; verification_method: string | null } | undefined;
      if (!row || row.verified_at_ms === null || !Number.isSafeInteger(row.verified_at_ms) || row.verification_method !== 'password') held();
      const checkpoint = reader.authority.checkpoint(), suppression = reader.authority.lookup(row.account_id);
      let head = genesisHead(checkpoint.authorityId), sequence = 0;
      reader.authority.reconcileRestore(record => {
        if (record.sequence !== ++sequence) held(); head = advanceHead(head, record);
      });
      if (head !== checkpoint.committedHeadDigest || sequence !== checkpoint.committedSequence ||
        checkpoint.revision < this.lastCheckpoint.revision || checkpoint.committedSequence < this.lastCheckpoint.committedSequence ||
        (checkpoint.committedSequence === this.lastCheckpoint.committedSequence && checkpoint.committedHeadDigest !== this.lastCheckpoint.committedHeadDigest)) held();
      if (!suppression || checkpoint.pending || row.state !== 'disabled' || suppression.requestId !== requestId ||
        suppression.authUserId !== row.auth_user_id || suppression.epoch !== row.epoch || suppression.sequence !== row.suppression_seq ||
        checkpoint.committedSequence < suppression.sequence) held();
      const binding: CompletionBinding = Object.freeze({ requestId, accountId: row.account_id, authUserId: row.auth_user_id,
        epoch: row.epoch, sequence: suppression.sequence, databaseGeneration: evidenceDigest(reader.generation),
        schemaDigest: this.schema, cohort: 'lifecycle-evidence-v1', checkpoint: Object.freeze({ authorityId: checkpoint.authorityId,
          ledgerSchemaDigest: checkpoint.ledgerSchemaDigest, revision: checkpoint.revision,
          committedSequence: checkpoint.committedSequence, committedHeadDigest: checkpoint.committedHeadDigest }) });
      this.lastCheckpoint = binding.checkpoint;
      const proofDigest = evidenceDigest([row.intent_hash, row.verified_at_ms, row.verification_method]);
      return Object.freeze({ binding, suppression: Object.freeze({ ...suppression }), policyVersion: row.policy_version, proofDigest,
        stamp: evidenceDigest([binding, canonicalDisable(suppression), reader.generation, row.policy_version, proofDigest]) });
    } catch { return held(); }
  }
  private assertFrame(frame: LocalPurgeFrame): void {
    const current = currentLocalPurgeFrame(this.db);
    if (!current || current !== frame || frame.db !== this.db || frame.ledger !== this.reader.authority) held();
  }
  private operation(frame: LocalPurgeFrame, categories: readonly string[], now: number): EvidenceOperation {
    const request = this.db.prepare('SELECT policy_version,verified_at_ms,verification_method,intent_hash FROM account_deletion_requests WHERE id=? AND account_id=?')
      .get(frame.requestId, frame.accountId) as { policy_version: string; verified_at_ms: number | null; verification_method: string | null; intent_hash: string } | undefined;
    if (!request || !Number.isSafeInteger(request.verified_at_ms) || request.verified_at_ms === null || request.verification_method !== 'password') held();
    return evidenceOperationSchema.parse({ requestId: frame.requestId, operationId: frame.operationId, accountId: frame.accountId,
      authUserId: frame.authUserId, epoch: frame.epoch, sequence: frame.sequence, purpose: 'local_purge',
      scopeDigest: evidenceDigest(['local-purge-v1', [...categories].sort()]),
      proofDigest: evidenceDigest([request.intent_hash, request.verified_at_ms, request.verification_method]),
      policyVersion: request.policy_version, createdAtMs: now });
  }
  private readOperation(requestId: string, operationId: string): EvidenceOperation | null {
    const row = this.db.prepare(`SELECT request_id requestId,operation_id operationId,account_id accountId,auth_user_id authUserId,
      lifecycle_epoch epoch,suppression_sequence sequence,purpose,scope_digest scopeDigest,proof_digest proofDigest,
      policy_version policyVersion,created_at_ms createdAtMs FROM account_deletion_evidence_operations WHERE request_id=? AND operation_id=?`)
      .get(requestId, operationId);
    try { return row ? evidenceOperationSchema.parse(row) : null; } catch { return held(); }
  }
  begin(frame: LocalPurgeFrame, categories: readonly string[], now: number): PurgeEvidenceAttempt {
    this.assertFrame(frame);
    if (categories.length > 64 || new Set(categories).size !== categories.length || categories.some(value => !evidenceIdSchema.safeParse(value).success)) held();
    const snapshot = this.snapshot(frame.requestId), candidate = this.operation(frame, categories, now);
    const prior = this.readOperation(frame.requestId, frame.operationId);
    if (prior && evidenceCanonical(prior) !== evidenceCanonical({ ...candidate, createdAtMs: prior.createdAtMs })) conflict();
    const attempt = Object.freeze({ frame, operation: prior ?? candidate, snapshot, categories: Object.freeze([...categories].sort()) });
    attempts.add(attempt); return attempt;
  }
  finish(attempt: PurgeEvidenceAttempt, results: readonly Readonly<{ category: string; status: LifecycleResult['status'] }>[], now: number,
    readback: (category: string) => boolean): LocalEvidenceProjection {
    if (!attempts.delete(attempt)) held();
    this.assertFrame(attempt.frame);
    if (this.snapshot(attempt.frame.requestId).stamp !== attempt.snapshot.stamp ||
      evidenceCanonical(results.map(result => result.category).sort()) !== evidenceCanonical(attempt.categories)) held();
    const successful = results.filter(result => result.status === 'complete').map(result => result.category);
    for (const category of successful) if (readback(category) !== true) held();
    const op = attempt.operation, b = attempt.snapshot.binding;
    if (!this.readOperation(op.requestId, op.operationId)) this.db.prepare(`INSERT INTO account_deletion_evidence_operations
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(op.requestId, op.operationId, op.accountId, op.authUserId, op.epoch, op.sequence,
      op.purpose, op.scopeDigest, op.proofDigest, op.policyVersion, op.createdAtMs);
    for (const result of results) {
      const target: CompletionTarget = { kind: 'category', category: result.category };
      const evidenceId = evidenceDigest(['local-fact-v1', op.operationId, b, target, result.status]);
      const prior = this.readFact(op.requestId, op.operationId, evidenceId);
      const observedAtMs = prior?.observedAtMs ?? now;
      const status = result.status === 'complete' ? 'qualifying' as const : result.status;
      const resolves = prior?.fact.resolves ?? (status === 'qualifying' ? this.uncertainFacts(op.requestId, b, target) : []);
      const fact: CompletionFact = { operationId: evidenceId, binding: b, target, resolves, ...(status === 'qualifying'
        ? { status, witness: { kind: 'local_purge_readback' as const, evidenceDigest: evidenceDigest([op.scopeDigest, target, b]), observedAtMs } }
        : { status, witness: null }) };
      const attemptId = evidenceDigest(['attempt-v1', op.operationId, b, result.status]);
      const encoded = encodeDurableEvidence({ version: 1, evidenceId, attemptId,
        observedAtMs, policyVersion: op.policyVersion, fact });
      if (prior) { if (encodeDurableEvidence(prior) !== encoded) conflict(); continue; }
      this.db.prepare(`INSERT INTO account_deletion_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        op.requestId, op.operationId, evidenceId, attemptId, result.category, evidenceDigest(target),
        status === 'qualifying' ? 'local_purge_readback' : 'observation', status, observedAtMs, b.databaseGeneration, b.cohort, b.schemaDigest,
        b.checkpoint.authorityId, b.checkpoint.ledgerSchemaDigest, b.sequence, b.checkpoint.committedSequence,
        b.checkpoint.committedHeadDigest, b.checkpoint.revision, op.policyVersion, encoded, evidenceDigest(encoded));
    }
    const projection = this.project(op.requestId, attempt.categories, readback);
    if (this.snapshot(op.requestId).stamp !== attempt.snapshot.stamp) held();
    completedAttempts.set(attempt, successful);
    return projection;
  }
  finalCheck(attempt: PurgeEvidenceAttempt, readback: (category: string) => boolean): void {
    const successful = completedAttempts.get(attempt);
    if (!successful || !completedAttempts.delete(attempt)) held();
    this.assertFrame(attempt.frame);
    for (const category of successful) if (readback(category) !== true) held();
    const foreignKeys = this.db.pragma('foreign_key_check');
    if (!Array.isArray(foreignKeys) || foreignKeys.length !== 0) held();
    if (this.snapshot(attempt.frame.requestId).stamp !== attempt.snapshot.stamp) held();
  }
  private uncertainFacts(requestId: string, binding: CompletionBinding, target: CompletionTarget): readonly string[] {
    const keys = this.db.prepare(`SELECT operation_id,evidence_id FROM account_deletion_evidence WHERE request_id=? AND target_digest=?
      AND result IN('pending','unknown','unavailable') ORDER BY rowid LIMIT 2049`).all(requestId, evidenceDigest(target)) as
      { operation_id: string; evidence_id: string }[];
    if (keys.length > 2048) held();
    const result = keys.map(key => this.readFact(requestId, key.operation_id, key.evidence_id)!).filter(value =>
      evidenceCanonical(value.fact.binding) === evidenceCanonical(binding)).map(value => value.fact.operationId);
    if (result.length > 32) held();
    return result.sort();
  }
  private readFact(requestId: string, operationId: string, evidenceId: string): DurableEvidence | null {
    const row = this.db.prepare('SELECT * FROM account_deletion_evidence WHERE request_id=? AND operation_id=? AND evidence_id=?')
      .get(requestId, operationId, evidenceId) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      const value = decodeDurableEvidence(row.payload), b = value.fact.binding, c = b.checkpoint;
      const target = value.fact.target, category = target.kind === 'category' ? target.category : target.kind;
      const expected = [requestId, operationId, value.evidenceId, value.attemptId, category, evidenceDigest(target),
        value.fact.status === 'qualifying' ? value.fact.witness.kind : 'observation', value.fact.status, value.observedAtMs,
        b.databaseGeneration, b.cohort, b.schemaDigest, c.authorityId, c.ledgerSchemaDigest, b.sequence, c.committedSequence,
        c.committedHeadDigest, c.revision, value.policyVersion, row.payload, evidenceDigest(row.payload)];
      const actual = ['request_id','operation_id','evidence_id','attempt_id','category','target_digest','fact_kind','result','observed_at_ms',
        'database_generation','schema_cohort','schema_digest','authority_id','authority_schema_digest','suppression_sequence',
        'suppression_floor','suppression_head','witness_revision','policy_version','payload','payload_digest'].map(key => row[key]);
      const op = this.readOperation(requestId, operationId);
      if (!op || evidenceCanonical(actual) !== evidenceCanonical(expected) || b.requestId !== op.requestId || b.accountId !== op.accountId ||
        b.authUserId !== op.authUserId || b.epoch !== op.epoch || b.sequence !== op.sequence || value.policyVersion !== op.policyVersion) held();
      return value;
    } catch { return held(); }
  }
  project(requestId: string, categories: readonly string[], readback: (category: string) => boolean): LocalEvidenceProjection {
    const before = this.snapshot(requestId);
    const keys = this.db.prepare('SELECT operation_id,evidence_id FROM account_deletion_evidence WHERE request_id=? ORDER BY rowid LIMIT 2049')
      .all(requestId) as { operation_id: string; evidence_id: string }[];
    if (keys.length > 2048) held();
    let history: CompletionHistory = createCompletionHistory(before.binding);
    for (const key of keys) {
      const value = this.readFact(requestId, key.operation_id, key.evidence_id);
      if (!value) held();
      const operation = this.readOperation(requestId, key.operation_id);
      if (!operation || operation.policyVersion !== before.policyVersion || operation.proofDigest !== before.proofDigest) held();
      history = appendCompletionFact(history, value.fact as CompletionFact).history;
    }
    const calculation = calculateCompletion(history, { binding: before.binding, request: 'present',
      authority: { status: 'qualified_current', suppression: before.suppression },
      requirements: [...categories, 'auth_identity', 'purchase_proofs', 'providers', 'backups', 'retention_policy'].map(category => ({ kind: 'category', category })) });
    const completedCategories = calculation.hold === null
      ? calculation.targets.filter(target => target.status === 'qualifying' && target.target.kind === 'category' &&
        categories.includes(target.target.category) && readback(target.target.category) === true)
        .map(target => (target.target as { kind: 'category'; category: string }).category) : [];
    if (this.snapshot(requestId).stamp !== before.stamp) held();
    const times = history.facts.filter(fact => fact.status === 'qualifying' &&
      evidenceCanonical(fact.binding) === evidenceCanonical(before.binding)).map(fact => fact.status === 'qualifying' ? fact.witness.observedAtMs : 0);
    return Object.freeze({ calculation, completedCategories: Object.freeze(completedCategories),
      localPurged: categories.length > 0 && completedCategories.length === categories.length,
      firstObservedAtMs: times.length ? Math.min(...times) : null,
      residuals: Object.freeze({ retentionPolicy: 'unavailable', providers: 'unavailable', backups: 'unavailable',
        identityAnchors: 'retained', purchaseProofs: 'retained', billingCancellation: 'not_performed' }) });
  }
}
