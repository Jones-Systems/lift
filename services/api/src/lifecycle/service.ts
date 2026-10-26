import { bindLocalPurgeExecutor, withLocalPurgeAuthority, type LocalPurgeAuthority } from './purge-executor.js';
import { createCanonicalAccountWriter } from '../integration/account-modules/canonical-writer.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../errors.js';
import { canonical, hash, type Sqlite } from '../storage.js';
import { assertActive, bindSuppressionAuthority, hasLifecycleSchema, suppressionAuthority, withActiveWrite } from './guards.js';
import type { AccountContext, DisableRecord, LifecycleAdapter, SuppressionLedger } from './types.js';
import { usageOwnedTables } from '../usage-limits/migration.js';
import { bugIntakeOwnedTables } from '../bug-intake/migration.js';
import { progressComparisonOwnedTables } from '../progress-comparison/migration.js';
import { manualRetentionOwnedTables } from '../body/manual-retention-migration.js';
import { feedbackOwnedTables } from '../training-feedback/migration.js';

export const lifecyclePolicy = 'form-account-lifecycle-v1';
export const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
export const actionGrantRequest = z.object({ purpose: z.enum(['account_delete', 'account_export']), password: z.string().min(1).max(128) }).strict();
export const deletionRequest = z.object({ requestId: z.uuid(), policyVersion: z.literal(lifecyclePolicy),
  confirmation: z.literal('delete_whole_account'), statusSecret: secretSchema }).strict();
export const deletionConfirmation = z.object({ grant: secretSchema, policyVersion: z.literal(lifecyclePolicy), confirmation: z.literal('delete_whole_account') }).strict();
export const deletionStatusRequest = z.object({ requestId: z.uuid() }).strict();
export const exportRequest = z.object({ grant: secretSchema }).strict();
type RequestRow = { id: string; account_id: string; command_key: string; intent_hash: string; phase: string;
 requested_at_ms: number; disabled_at_ms: number | null; local_purged_at_ms: number | null; status_token_hash: string; status_token_expires_at_ms: number };
const categories = ['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community'];

export class AccountLifecycle {
  constructor(private readonly db: Sqlite, readonly adapters: readonly LifecycleAdapter[], ledger: SuppressionLedger,
    private readonly clock: () => number = Date.now) {
    if (!hasLifecycleSchema(db)) throw new DomainError(503, 'lifecycle_migration_required');
    if (new Set(adapters.map(x => x.category)).size !== adapters.length) throw new Error('Duplicate lifecycle category');
    bindSuppressionAuthority(db, ledger);
    for (const category of ['activity', 'community']) {
      const stored = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? LIMIT 1").get(`${category}_%`);
      if (stored && !adapters.some(adapter => adapter.category === category)) throw new DomainError(503, 'lifecycle_adapter_required');
    }
    for (const [category, tables] of [['usage_limits', usageOwnedTables], ['bugIntake', bugIntakeOwnedTables],
      ['progressComparison', progressComparisonOwnedTables], ['trainingFeedback', feedbackOwnedTables],
      ['body', ['body_manual_measurements', 'body_manual_receipts', ...manualRetentionOwnedTables]]] as const) {
      const stored = tables.some(table => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
      if (stored && !adapters.some(adapter => adapter.category === category)) throw new DomainError(503, 'lifecycle_adapter_required');
    }
    this.reconcileRestore();
    bindLocalPurgeExecutor(this, db);
  }
  assertActive(context: AccountContext): void { assertActive(this.db, context); }
  private grant(context: AccountContext, token: string, purpose: 'account_delete' | 'account_export'): void {
    const row = this.db.prepare('SELECT epoch,purpose,expires_at_ms,consumed_at_ms FROM account_action_grants WHERE token_hash=? AND account_id=? AND session_id=?')
      .get(hash(token), context.accountId, context.sessionId) as { epoch: number; purpose: string; expires_at_ms: number; consumed_at_ms: number | null } | undefined;
    if (!row || row.epoch !== context.epoch || row.purpose !== purpose || row.expires_at_ms <= this.clock() || row.consumed_at_ms !== null)
      throw new DomainError(403, 'action_grant_invalid');
  }
  async issueGrant(context: AccountContext, input: z.infer<typeof actionGrantRequest>, verifyPassword: () => Promise<boolean>) {
    withActiveWrite(this.db, context, () => {
      const key = `form-action:${context.sessionId}`, now = this.clock();
      const row = this.db.prepare('SELECT count,lastRequest FROM rateLimit WHERE key=?').get(key) as { count: number; lastRequest: number } | undefined;
      if (row && now - row.lastRequest < 60_000 && row.count >= 5) throw new DomainError(429, 'action_reauthentication_rate_limited');
      this.db.prepare('INSERT INTO rateLimit(id,key,count,lastRequest) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=?,lastRequest=?')
        .run(hash(key), key, now, row && now - row.lastRequest < 60_000 ? row.count + 1 : 1, now);
      if (!this.db.prepare("SELECT id FROM account WHERE userId=? AND providerId='credential' AND password IS NOT NULL").get(context.authUserId))
        throw new DomainError(501, 'action_reauthentication_unqualified');
    });
    let valid = false;
    try { valid = await verifyPassword(); } catch { assertActive(this.db, context); throw new DomainError(403, 'action_reauthentication_failed'); }
    assertActive(this.db, context);
    if (!valid) throw new DomainError(403, 'action_reauthentication_failed');
    return withActiveWrite(this.db, context, () => {
      const token = randomBytes(32).toString('base64url'), now = this.clock();
      this.db.prepare('INSERT INTO account_action_grants VALUES(?,?,?,?,?,?,?, ?,NULL)')
        .run(hash(token), context.accountId, context.sessionId, context.epoch, input.purpose, 'password', now, now + 300_000);
      return { grant: token, purpose: input.purpose, expiresAt: new Date(now + 300_000).toISOString(), method: 'password' };
    });
  }
  initiate(context: AccountContext, key: string | undefined, input: z.infer<typeof deletionRequest>) {
    if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new DomainError(400, 'idempotency_key_required');
    return withActiveWrite(this.db, context, () => {
      const fingerprint = hash(canonical({ ...input, statusSecret: hash(input.statusSecret) }));
      const prior = this.db.prepare('SELECT * FROM account_deletion_requests WHERE account_id=?').get(context.accountId) as RequestRow | undefined;
      if (prior) {
        if (prior.command_key !== key || prior.intent_hash !== fingerprint) throw new DomainError(409, 'idempotency_mismatch');
        return this.view(prior);
      }
      const now = this.clock();
      if (this.db.prepare('SELECT id FROM account_deletion_requests WHERE id=?').get(input.requestId)) throw new DomainError(409, 'deletion_request_conflict');
      this.db.prepare(`INSERT INTO account_deletion_requests(id,account_id,command_key,intent_hash,policy_version,phase,requested_at_ms,status_token_hash,status_token_expires_at_ms)
        VALUES(?,?,?,?,?,'awaiting_reauthentication',?,?,?)`).run(input.requestId, context.accountId, key, fingerprint, input.policyVersion, now, hash(input.statusSecret), now + 30 * 86400_000);
      for (const category of new Set([...categories, ...this.adapters.map(x => x.category)]))
        this.db.prepare("INSERT INTO account_deletion_steps VALUES(?,?,'pending',NULL,NULL,NULL,?)").run(input.requestId, category, now);
      return this.view(this.db.prepare('SELECT * FROM account_deletion_requests WHERE id=?').get(input.requestId) as RequestRow);
    });
  }
  confirm(context: AccountContext, requestId: string, input: z.infer<typeof deletionConfirmation>) {
    try {
      return this.db.transaction(() => {
        assertActive(this.db, context);
        const row = this.db.prepare('SELECT * FROM account_deletion_requests WHERE id=? AND account_id=?').get(requestId, context.accountId) as RequestRow | undefined;
        if (!row) throw new DomainError(404, 'not_found');
        if (row.phase !== 'awaiting_reauthentication') throw new DomainError(409, 'deletion_confirmation_unavailable');
        this.grant(context, input.grant, 'account_delete');
        const now = this.clock();
        // The independent ledger commits first. Main rollback must never undo that suppression.
        const evidence = suppressionAuthority(this.db).recordDisable({ accountId: context.accountId, authUserId: context.authUserId,
          epoch: context.epoch + 1, requestId, disabledAtMs: now });
        this.applyDisable(evidence);
        this.db.prepare("UPDATE account_deletion_requests SET phase='disabled_pending_purge',verified_at_ms=?,verification_method='password',disabled_at_ms=? WHERE id=?")
          .run(now, evidence.disabledAtMs, requestId);
        for (const adapter of this.adapters) {
          let result;
          try { result = adapter.suppress(context.accountId, evidence.epoch); } catch { result = { status: 'unknown' as const }; }
          this.db.prepare('UPDATE account_deletion_steps SET status=?,evidence_ref=?,updated_at_ms=? WHERE request_id=? AND category=?')
            .run(result.status === 'complete' || result.status === 'unavailable' ? 'pending' : result.status, result.status === 'complete' ? 'access_suppressed_only' : null, now, requestId, adapter.category);
        }
        return this.view(this.db.prepare('SELECT * FROM account_deletion_requests WHERE id=?').get(requestId) as RequestRow);
      }).immediate();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, 'deletion_effect_unknown', 'Use the retained status receipt to reconcile; do not retry blindly.');
    }
  }
  private applyDisable(entry: DisableRecord): void {
    const mapping = this.db.prepare('SELECT auth_user_id FROM form_accounts WHERE id=?').get(entry.accountId) as { auth_user_id: string } | undefined;
    if (mapping && mapping.auth_user_id !== entry.authUserId) throw new Error('Suppression identity conflict');
    if (mapping) {
      const current = this.db.prepare('SELECT state,epoch FROM account_lifecycle WHERE account_id=?').get(entry.accountId) as { state: string; epoch: number } | undefined;
      if (!current || (current.state === 'active' && entry.epoch !== current.epoch + 1) || (current.state === 'disabled' && current.epoch !== entry.epoch))
        throw new Error('Suppression epoch conflict');
      if (current.state === 'active') this.db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=?,disabled_at_ms=?,suppression_seq=? WHERE account_id=?")
        .run(entry.epoch, entry.disabledAtMs, entry.sequence, entry.accountId);
    }
    this.db.prepare('DELETE FROM session WHERE userId=?').run(entry.authUserId);
  }
  reconcileRestore(): void {
    this.db.transaction(() => {
      suppressionAuthority(this.db).reconcileRestore(entry => {
        this.applyDisable(entry);
        this.db.prepare("UPDATE account_deletion_requests SET phase='disabled_pending_purge',disabled_at_ms=? WHERE id=? AND phase='awaiting_reauthentication'")
          .run(entry.disabledAtMs, entry.requestId);
        for (const adapter of this.adapters) {
          const result = adapter.suppress(entry.accountId, entry.epoch);
          if (result.status !== 'complete' || adapter.verifySuppressed(entry.accountId, entry.epoch).status !== 'complete')
            throw new Error('Module suppression admission pending');
        }
      });
    }).immediate();
  }
  consumeExportGrant(context: AccountContext, token: string): void {
    withActiveWrite(this.db, context, () => {
      this.grant(context, token, 'account_export');
      this.db.prepare('UPDATE account_action_grants SET consumed_at_ms=? WHERE token_hash=? AND consumed_at_ms IS NULL').run(this.clock(), hash(token));
    });
  }
  // No public purge route. Root must separately authorize any non-synthetic execution.
  purgeLocal(capability: LocalPurgeAuthority) {
    return withLocalPurgeAuthority(this.db, capability, authority => {
      const { requestId, operationId } = authority;
      const row = this.db.prepare('SELECT * FROM account_deletion_requests WHERE id=?').get(requestId) as RequestRow | undefined;
      if (!row) throw new DomainError(404, 'not_found');
      const evidence = authority;
      const core = ['command_receipts', 'transcription_attempts', 'set_revisions', 'performed_sets', 'session_occurrences',
        'workout_sessions', 'plan_item_ids', 'plan_revisions', 'plans', 'document_revisions', 'documents', 'entitlement_grants'];
      for (const table of core) this.db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(row.account_id);
      this.db.prepare('DELETE FROM apple_purchase_grants WHERE account_id=?').run(row.account_id);
      const subject = this.db.prepare('SELECT phoneNumber FROM "user" WHERE id=?').get(evidence.authUserId) as { phoneNumber: string | null } | undefined;
      const phoneWhere = 'auth_user_id=@user OR (phone=@phone AND @phone IS NOT NULL)';
      const scope = { user: evidence.authUserId, phone: subject?.phoneNumber ?? null };
      this.db.prepare(`DELETE FROM phone_operations WHERE challenge_id IN(SELECT id FROM phone_challenges WHERE ${phoneWhere})`).run(scope);
      this.db.prepare(`DELETE FROM phone_challenges WHERE ${phoneWhere}`).run(scope);
      // Provider revocation material stays restricted until its separately qualified acknowledgment/retention contract.
      this.db.prepare("DELETE FROM account WHERE userId=? AND providerId='credential'").run(evidence.authUserId);
      this.db.prepare('DELETE FROM session WHERE userId=?').run(evidence.authUserId);
      let qualified = true;
      for (const category of ['activity', 'community']) {
        const stored = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? LIMIT 1").get(`${category}_%`);
        const adapter = this.adapters.find(x => x.category === category);
        if (stored && !adapter) qualified = false;
      }
      const writer = createCanonicalAccountWriter(this.db);
      for (const adapter of this.adapters) {
        if (!authority.qualifiedCategories.includes(adapter.category)) {
          qualified = false;
          this.db.prepare("UPDATE account_deletion_steps SET status='pending',evidence_ref=NULL,updated_at_ms=? WHERE request_id=? AND category=?")
            .run(this.clock(), requestId, adapter.category);
          continue;
        }
        const guarded = writer.guardLifecycleAdapter(adapter);
        const result = guarded.purge(requestId, row.account_id);
        const verified = guarded.verifySuppressed(row.account_id, evidence.epoch);
        const complete = result.status === 'complete' && verified.status === 'complete';
        qualified &&= complete;
        const residual = result.status === 'complete' ? verified.status : result.status;
        this.db.prepare('UPDATE account_deletion_steps SET status=?,evidence_ref=?,updated_at_ms=? WHERE request_id=? AND category=?')
          .run(complete ? 'complete' : residual === 'unavailable' ? 'pending' : residual, operationId, this.clock(), requestId, adapter.category);
      }
      for (const table of core) if (this.db.prepare(`SELECT 1 FROM ${table} WHERE account_id=? LIMIT 1`).get(row.account_id))
        throw new DomainError(503, 'local_purge_readback_failed');
      if (this.db.prepare(`SELECT 1 FROM phone_challenges WHERE ${phoneWhere} LIMIT 1`).get(scope))
        throw new DomainError(503, 'local_purge_readback_failed');
      this.db.prepare("UPDATE account_deletion_steps SET status='complete',evidence_ref=?,updated_at_ms=? WHERE request_id=? AND category IN('form_training_history','phone_challenges')")
        .run(operationId, this.clock(), requestId);
      this.db.prepare("UPDATE account_deletion_steps SET status='retained',updated_at_ms=? WHERE request_id=? AND category IN('purchase_proofs','auth_identity')")
        .run(this.clock(), requestId);
      this.db.prepare("UPDATE account_deletion_requests SET phase='pending_external',local_purged_at_ms=? WHERE id=?")
        .run(qualified ? this.clock() : null, requestId);
      return this.view(this.db.prepare('SELECT * FROM account_deletion_requests WHERE id=?').get(requestId) as RequestRow);
    });
  }
  status(requestId: string, secret: string) {
    try {
    if (!secretSchema.safeParse(secret).success) throw new DomainError(401, 'status_receipt_invalid');
    suppressionAuthority(this.db);
    const row = this.db.prepare('SELECT * FROM account_deletion_requests WHERE id=? AND status_token_hash=? AND status_token_expires_at_ms>?')
      .get(requestId, hash(secret), this.clock()) as RequestRow | undefined;
    if (!row) throw new DomainError(401, 'status_receipt_invalid');
    const disabled = suppressionAuthority(this.db).lookup(row.account_id);
    return this.view(row, disabled && row.phase === 'awaiting_reauthentication' ? 'disabled_pending_reconciliation' : undefined);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(503, 'deletion_status_unknown');
    }
  }
  private view(row: RequestRow, phase?: string) {
    const steps = this.db.prepare('SELECT category,status,retain_until_ms FROM account_deletion_steps WHERE request_id=? ORDER BY category').all(row.id) as { category: string; status: string; retain_until_ms: number | null }[];
    return { requestId: row.id, phase: phase ?? row.phase, initiated: true, disabled: !!row.disabled_at_ms || phase === 'disabled_pending_reconciliation',
      localPurged: row.local_purged_at_ms !== null, complete: false, requestedAt: new Date(row.requested_at_ms).toISOString(),
      backupExpiryAt: null, billingCancellation: 'not_performed', reauthentication: 'password_only_qualified_source', steps };
  }
}
