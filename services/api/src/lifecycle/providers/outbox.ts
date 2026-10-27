import type { Sqlite } from '../../storage.js';
import { DomainError } from '../../errors.js';
import { assertActive } from '../guards.js';
import { evidenceCanonical, evidenceDigest, evidenceIdSchema } from '../evidence-codec.js';
import { readSourceLifecycleCurrentness, type SourceLifecycleCurrentness, type SourceLifecycleCurrentnessSnapshot } from '../evidence-store.js';
import { appendCompletionFact, calculateCompletion, createCompletionHistory, type CompletionBinding, type CompletionFact } from '../completion.js';
import { captureReference, providerAccounts, referenceStillPresent, validateResolvedReference } from './reference.js';
import { decodeProviderFact, encodeProviderFact, intentCheckpoint, intentIdentity, parseAttempt, parseIntent,
  providerTarget, referenceFor, type ProviderAttempt, type ProviderIntent } from './outbox-codec.js';
import { revokeApple, settleProviderOperation } from './apple.js';
import { LocalTerminationUnconfirmed } from './types.js';
import type { AttemptResult, BoundedAppleTransport, ConfirmationCapture, MaterialCustodian,
  ProviderBudget, ProviderConfirmationHook, ResolvedMaterial, RestrictedReference } from './types.js';

function held(): never { throw new DomainError(503, 'provider_revocation_held'); }
function conflict(): never { throw new DomainError(409, 'provider_revocation_conflict'); }
const producers = new Set<string>();
const safeTime = (value: number): number => { if (!Number.isSafeInteger(value) || value < 0) held(); return value; };
const result = (a: ProviderAttempt): AttemptResult => Object.freeze({ attemptId: a.attempt_id, intentId: a.intent_id,
  state: a.state, outcomeCode: a.outcome_code, protocolStatus: a.protocol_status });
type Captured = Readonly<{ input: ConfirmationCapture; references: readonly RestrictedReference[] }>;

export class ProviderRevocationOutbox {
  readonly confirmationHook: ProviderConfirmationHook;
  constructor(private readonly db: Sqlite, private readonly currentness: SourceLifecycleCurrentness,
    private readonly custodian: MaterialCustodian, private readonly transport: BoundedAppleTransport,
    private readonly clock: () => number = Date.now) {
    if (custodian?.contract !== 'bounded-provider-material-v1' || typeof custodian.capture !== 'function' || typeof custodian.resolve !== 'function' ||
      transport?.contract !== 'bounded-apple-revoke-v1' || typeof transport.post !== 'function') held();
    const captures = new WeakMap<object, Captured>();
    this.confirmationHook = Object.freeze({
      capture: (input: ConfirmationCapture): unknown => {
        if (!db.inTransaction) held();
        assertActive(db, input.context);
        const token = Object.freeze(Object.create(null));
        const references = providerAccounts(db, input.context.authUserId).map(account => captureReference(db, account, custodian));
        captures.set(token, Object.freeze({ input: Object.freeze({ ...input, context: Object.freeze({ ...input.context }) }),
          references: Object.freeze(references) }));
        return token;
      },
      persist: (token: unknown, requestId: string): void => {
        if (!db.inTransaction || !token || typeof token !== 'object') held();
        const capture = captures.get(token); captures.delete(token);
        if (!capture || capture.input.requestId !== requestId) held();
        const snapshot = readSourceLifecycleCurrentness(currentness, requestId), b = snapshot.binding, c = b.checkpoint;
        if (b.cohort !== 'provider-revocation-v1' || b.accountId !== capture.input.context.accountId ||
          b.authUserId !== capture.input.context.authUserId || b.epoch !== capture.input.context.epoch + 1 ||
          snapshot.suppression.disabledAtMs !== capture.input.now) held();
        for (const ref of capture.references) {
          const payload = { request_id: requestId, account_id: b.accountId, auth_user_id: b.authUserId,
            source_account_row_id: ref.sourceAccountRowId, provider: ref.provider, subject_digest: ref.subjectDigest,
            client_binding_id: ref.clientBindingId, client_digest: ref.clientDigest, token_kind: ref.tokenKind,
            reference_version: ref.referenceVersion, material_state: ref.materialState, residual_code: ref.residualCode,
            lifecycle_epoch: b.epoch, suppression_sequence: b.sequence, database_generation: b.databaseGeneration,
            schema_digest: b.schemaDigest, authority_id: c.authorityId, ledger_schema_digest: c.ledgerSchemaDigest,
            checkpoint_revision: c.revision, checkpoint_sequence: c.committedSequence, checkpoint_head_digest: c.committedHeadDigest,
            policy_version: snapshot.policyVersion, proof_digest: snapshot.proofDigest, created_at_ms: safeTime(capture.input.now) };
          const candidate = { intent_id: intentIdentity(payload), ...payload };
          const intent = parseIntent({ ...candidate, payload_digest: evidenceDigest(candidate) });
          const prior = db.prepare('SELECT * FROM account_provider_revocation_intents WHERE request_id=? AND source_account_row_id=?')
            .get(requestId, ref.sourceAccountRowId);
          if (prior) {
            const previous = parseIntent(prior);
            const replay = { ...candidate, created_at_ms: previous.created_at_ms };
            if (evidenceCanonical(previous) !== evidenceCanonical({ ...replay, payload_digest: evidenceDigest(replay) })) conflict();
          } else {
            const keys = Object.keys(intent);
            db.prepare(`INSERT INTO account_provider_revocation_intents(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
              .run(...Object.values(intent));
          }
        }
        if (readSourceLifecycleCurrentness(currentness, requestId).stamp !== snapshot.stamp) held();
      },
    });
  }
  private intent(intentId: string): ProviderIntent {
    if (!evidenceIdSchema.max(128).safeParse(intentId).success) held();
    try {
      const row = this.db.prepare('SELECT * FROM account_provider_revocation_intents WHERE intent_id=?').get(intentId);
      if (!row) held();
      return parseIntent(row);
    } catch { return held(); }
  }
  private current(i: ProviderIntent): SourceLifecycleCurrentnessSnapshot {
    const s = readSourceLifecycleCurrentness(this.currentness, i.request_id, intentCheckpoint(i)), b = s.binding;
    if (b.cohort !== 'provider-revocation-v1' || b.accountId !== i.account_id || b.authUserId !== i.auth_user_id ||
      b.epoch !== i.lifecycle_epoch || b.sequence !== i.suppression_sequence || b.databaseGeneration !== i.database_generation ||
      b.schemaDigest !== i.schema_digest || s.proofDigest !== i.proof_digest || s.policyVersion !== i.policy_version) held();
    return s;
  }
  private attempt(attemptId: string, i: ProviderIntent): ProviderAttempt | null {
    try {
      const row = this.db.prepare('SELECT * FROM account_provider_revocation_attempts WHERE attempt_id=?').get(attemptId);
      return row ? parseAttempt(row, i) : null;
    } catch { return held(); }
  }
  private assertAttemptCheckpoint(a: ProviderAttempt, i: ProviderIntent): SourceLifecycleCurrentnessSnapshot {
    const parsed = JSON.parse(a.binding_json) as CompletionBinding;
    readSourceLifecycleCurrentness(this.currentness, i.request_id, parsed.checkpoint);
    if (a.result_fact_json) readSourceLifecycleCurrentness(this.currentness, i.request_id, decodeProviderFact(a.result_fact_json).binding.checkpoint);
    return this.current(i);
  }
  private key(attemptId: string): string { return evidenceCanonical([this.db.name, attemptId]); }
  private idle(): void { if (this.db.inTransaction) held(); }
  async attemptOne(intentId: string, attemptId: string, signal?: AbortSignal): Promise<AttemptResult> {
    this.idle();
    if (!evidenceIdSchema.max(128).safeParse(attemptId).success) held();
    const i = this.intent(intentId); this.current(i);
    if (i.material_state !== 'captured') held();
    const prior = this.attempt(attemptId, i);
    if (prior) { this.assertAttemptCheckpoint(prior, i); return result(prior); }
    const started = safeTime(this.clock());
    if (started < i.created_at_ms || !Number.isSafeInteger(started + 10000)) held();
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    // Reserve the final 500ms of the total invocation budget for qualified producer cancellation/cleanup.
    const timer = setTimeout(abort, 9500);
    const budget: ProviderBudget = Object.freeze({ deadlineAtMs: started + 10000, signal: controller.signal, maxResponseBytes: 4096 });
    let claimed = false;
    const key = this.key(attemptId);
    try {
      this.db.transaction(() => {
        const original = this.intent(intentId), snapshot = this.current(original);
        if (original.payload_digest !== i.payload_digest || !referenceStillPresent(this.db, referenceFor(i))) held();
        if (this.attempt(attemptId, i)) conflict();
        const active = this.db.prepare("SELECT 1 FROM account_provider_revocation_attempts WHERE intent_id=? AND state IN('preparing','in_flight','acknowledged')").get(intentId);
        const count = this.db.prepare('SELECT count(*) n FROM account_provider_revocation_attempts WHERE intent_id=?').get(intentId) as { n: number };
        if (active || count.n >= 3) conflict();
        const binding = evidenceCanonical(snapshot.binding);
        this.db.prepare(`INSERT INTO account_provider_revocation_attempts(attempt_id,intent_id,ordinal,binding_json,binding_digest,state,revision,started_at_ms,deadline_at_ms)
          VALUES(?,?,?,?,?,'preparing',0,?,?)`).run(attemptId, intentId, count.n + 1, binding, evidenceDigest(snapshot.binding), started, budget.deadlineAtMs);
      }).immediate();
      claimed = true; producers.add(key);
      let material: ResolvedMaterial | undefined;
      let preparation: ProviderAttempt['outcome_code'] = null;
      if (budget.signal.aborted) preparation = 'cancelled_before_dispatch';
      else if (safeTime(this.clock()) >= budget.deadlineAtMs - 500) preparation = 'preparation_expired';
      else {
        try {
          const resolved = await settleProviderOperation(() => this.custodian.resolve(referenceFor(i), budget), budget);
          this.idle();
          if (resolved.status !== 'qualified') preparation = 'material_unavailable';
          else if (!validateResolvedReference(this.db, referenceFor(i), resolved.value)) preparation = 'reference_changed';
          else material = resolved.value;
        } catch (error) {
          if (error instanceof LocalTerminationUnconfirmed) throw error;
          preparation = budget.signal.aborted ? 'preparation_expired' : 'material_unavailable';
        }
      }
      if (budget.signal.aborted || safeTime(this.clock()) >= budget.deadlineAtMs) preparation ??= 'preparation_expired';
      if (preparation || !material) return this.finish(i, attemptId, preparation ?? 'material_unavailable', null);
      this.db.transaction(() => {
        const a = this.attempt(attemptId, i); if (!a || a.state !== 'preparing') held();
        this.assertAttemptCheckpoint(a, i);
        if (this.intent(intentId).payload_digest !== i.payload_digest || !validateResolvedReference(this.db, referenceFor(i), material!)) held();
        const now = safeTime(this.clock());
        if (budget.signal.aborted || now < a.started_at_ms || now >= a.deadline_at_ms - 500) held();
        const changed = this.db.prepare(`UPDATE account_provider_revocation_attempts SET state='in_flight',revision=1,dispatch_at_ms=?
          WHERE attempt_id=? AND intent_id=? AND state='preparing' AND revision=0 AND binding_digest=?`)
          .run(now, attemptId, intentId, a.binding_digest);
        if (changed.changes !== 1) held();
      }).immediate();
      this.idle();
      const outcome = await revokeApple(material, this.transport, budget);
      this.idle();
      let code = outcome.code;
      if (budget.signal.aborted || safeTime(this.clock()) >= budget.deadlineAtMs) code = 'transport_unknown';
      return this.finish(i, attemptId, code, outcome.status, material);
    } catch {
      // A commit response can be lost. Read the original attempt before returning uncertainty;
      // this path never invokes transport or retries a CAS.
      if (claimed) {
        try {
          const a = this.attempt(attemptId, i);
          if (a) { this.assertAttemptCheckpoint(a, i); return result(a); }
        } catch { /* Currentness denial preserves the durable prior state. */ }
      }
      return held();
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); producers.delete(key);
    }
  }
  private finish(i: ProviderIntent, attemptId: string, code: NonNullable<ProviderAttempt['outcome_code']>,
    status: number | null, material?: ResolvedMaterial): AttemptResult {
    this.idle();
    return this.db.transaction(() => {
      if (this.intent(i.intent_id).payload_digest !== i.payload_digest) held();
      const a = this.attempt(attemptId, i); if (!a) held();
      const snapshot = this.assertAttemptCheckpoint(a, i);
      if (a.state !== 'preparing' && a.state !== 'in_flight') return result(a);
      const now = safeTime(this.clock());
      if (now < a.started_at_ms || (a.dispatch_at_ms !== null && now < a.dispatch_at_ms)) held();
      if (material && !validateResolvedReference(this.db, referenceFor(i), material)) code = 'currentness_changed';
      if (a.state === 'in_flight' && code === 'apple_ack' && now >= a.deadline_at_ms) code = 'transport_unknown';
      const state = a.state === 'preparing' ? 'no_effect' : code === 'apple_ack' ? 'acknowledged' : 'unknown';
      const binding = snapshot.binding, target = providerTarget(i);
      const resolves = state === 'acknowledged' ? this.facts(i).filter(f => f.status !== 'qualifying' &&
        evidenceCanonical(f.binding) === evidenceCanonical(binding)).map(f => f.operationId).sort() : [];
      const fact: CompletionFact = { operationId: attemptId, binding, target, resolves, ...(state === 'acknowledged'
        ? { status: 'qualifying' as const, witness: { kind: 'provider_revocation_acknowledgment' as const,
          evidenceDigest: evidenceDigest(['apple-revoke-ack-v1', i.payload_digest, attemptId, binding, target, now, 200]), observedAtMs: now } }
        : { status: state === 'no_effect' ? 'unavailable' as const : 'unknown' as const, witness: null }) };
      const encoded = encodeProviderFact(fact);
      const changed = this.db.prepare(`UPDATE account_provider_revocation_attempts SET state=?,revision=?,finished_at_ms=?,outcome_code=?,protocol_status=?,result_fact_json=?
        WHERE attempt_id=? AND intent_id=? AND state=? AND revision=? AND binding_digest=?`)
        .run(state, a.revision + 1, now, code, a.state === 'preparing' ? null : status, encoded,
          attemptId, i.intent_id, a.state, a.revision, a.binding_digest);
      if (changed.changes !== 1 || this.current(i).stamp !== snapshot.stamp ||
        this.intent(i.intent_id).payload_digest !== i.payload_digest ||
        (material && !validateResolvedReference(this.db, referenceFor(i), material))) held();
      return result(this.attempt(attemptId, i)!);
    }).immediate();
  }
  reconcileOne(attemptId: string): AttemptResult {
    this.idle();
    if (!evidenceIdSchema.max(128).safeParse(attemptId).success || producers.has(this.key(attemptId))) held();
    const row = this.db.prepare('SELECT intent_id FROM account_provider_revocation_attempts WHERE attempt_id=?').get(attemptId) as { intent_id: string } | undefined;
    if (!row) held();
    const i = this.intent(row.intent_id), a = this.attempt(attemptId, i); if (!a) held();
    this.assertAttemptCheckpoint(a, i);
    // Expiry and absent invocation bookkeeping cannot prove local termination, including after restart.
    // Keep active rows and their unique claim until independently bound termination evidence exists.
    return result(a);
  }
  private facts(i: ProviderIntent): CompletionFact[] {
    const rows = this.db.prepare('SELECT * FROM account_provider_revocation_attempts WHERE intent_id=? ORDER BY ordinal').all(i.intent_id);
    if (rows.length > 3) held();
    return rows.flatMap(row => {
      const a = parseAttempt(row, i); this.assertAttemptCheckpoint(a, i);
      if (!a.result_fact_json) return [];
      const f = decodeProviderFact(a.result_fact_json);
      readSourceLifecycleCurrentness(this.currentness, i.request_id, f.binding.checkpoint);
      return [f];
    });
  }
  project(intentId: string) {
    this.idle();
    const i = this.intent(intentId), snapshot = this.current(i);
    if (i.material_state !== 'captured') return Object.freeze({ status: 'unavailable' as const, residual: i.residual_code,
      wholeAccountDeviceProviderErasure: 'unproven' as const });
    let history = createCompletionHistory(snapshot.binding);
    for (const f of this.facts(i)) history = appendCompletionFact(history, f).history;
    const calculation = calculateCompletion(history, { binding: snapshot.binding, request: 'present',
      authority: { status: 'qualified_current', suppression: snapshot.suppression }, requirements: [providerTarget(i)] });
    if (this.current(i).stamp !== snapshot.stamp) held();
    return Object.freeze({ status: calculation.eligibility, calculation, retentionPolicy: 'unavailable' as const });
  }
}
