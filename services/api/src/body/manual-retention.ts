import { DomainError } from '../errors.js';
import { canonical, hash, type Sqlite } from '../storage.js';
import type { AccountContext, LifecycleBindings } from '../lifecycle/types.js';
import {
  MANUAL_RETENTION_COMMAND_RESULT_SCHEMA, MANUAL_RETENTION_CURRENT_RESULT_SCHEMA,
  MANUAL_RETENTION_STATEMENT_BINDING, MANUAL_RETENTION_STATEMENT_SHA256,
  captureManualRetentionAttemptAuthority, captureManualRetentionGrantPayload,
  captureManualRetentionRevokePayload, captureManualRetentionReceipt, isManualRetentionDecisionId,
  type ManualRetentionCommandResult, type ManualRetentionCurrent, type ManualRetentionCurrentResult,
  type ManualRetentionReceipt, type ManualRetentionAttemptAuthority,
} from './manual-retention-contract.js';

type DecisionRow = { account_id: string; decision_id: string; auth_user_id: string; session_id: string; epoch: number;
  state: 'granted' | 'revoked'; revision: 1 | 2; statement_sha256: string | null; grant_key: string | null };
export function createManualRetention(db: Sqlite, lifecycle: LifecycleBindings, now: () => Date = () => new Date()) {
  const serialized = (actor: AccountContext) => {
    if (!db.inTransaction) throw new DomainError(503, 'body_lifecycle_serialization_required');
    lifecycle.assertActive(actor);
  };
  const decision = (actor: AccountContext, decisionId: string): DecisionRow | undefined => {
    const row = db.prepare('SELECT * FROM body_manual_retention_decisions WHERE account_id=? AND decision_id=?')
      .get(actor.accountId, decisionId) as DecisionRow | undefined;
    if (row && (row.auth_user_id !== actor.authUserId || row.session_id !== actor.sessionId || row.epoch !== actor.epoch))
      throw new DomainError(403, 'body_manual_retention_context_mismatch');
    return row;
  };
  const current = (row: DecisionRow): ManualRetentionCurrent => {
    if (row.state === 'revoked' && row.revision === 1 && row.statement_sha256 === null)
      return { decisionId: row.decision_id, state: 'revoked', revision: 1, statement: null };
    if (row.statement_sha256 !== MANUAL_RETENTION_STATEMENT_SHA256)
      throw new DomainError(503, 'body_manual_retention_stored_invalid');
    if (row.state === 'granted' && row.revision === 1)
      return { decisionId: row.decision_id, state: 'granted', revision: 1, statement: MANUAL_RETENTION_STATEMENT_BINDING };
    if (row.state === 'revoked' && row.revision === 2)
      return { decisionId: row.decision_id, state: 'revoked', revision: 2, statement: MANUAL_RETENTION_STATEMENT_BINDING };
    throw new DomainError(503, 'body_manual_retention_stored_invalid');
  };
  const command = (actor: AccountContext, key: string, decisionId: string, operation: 'grant' | 'revoke', input: unknown,
    effect: (prior: DecisionRow | undefined) => ManualRetentionReceipt): ManualRetentionCommandResult => lifecycle.withActiveWrite(actor, () => {
    serialized(actor);
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new DomainError(400, 'idempotency_key_required');
    const fingerprint = hash(canonical({ operation, decisionId, input, sessionId: actor.sessionId,
      authUserId: actor.authUserId, epoch: actor.epoch }));
    const stored = db.prepare('SELECT intent_hash,receipt FROM body_manual_retention_receipts WHERE account_id=? AND key=?')
      .get(actor.accountId, key) as { intent_hash: string; receipt: string } | undefined;
    let receipt: ManualRetentionReceipt;
    if (stored) {
      if (stored.intent_hash !== fingerprint) throw new DomainError(409, 'idempotency_conflict');
      const captured = captureManualRetentionReceipt(JSON.parse(stored.receipt));
      if (!captured || captured.decisionId !== decisionId) throw new DomainError(503, 'body_manual_retention_stored_invalid');
      receipt = captured;
    } else {
      receipt = effect(decision(actor, decisionId));
      db.prepare('INSERT INTO body_manual_retention_receipts VALUES(?,?,?,?,?,?)')
        .run(actor.accountId, key, fingerprint, decisionId, JSON.stringify(receipt), now().toISOString());
    }
    const row = decision(actor, decisionId);
    if (!row) throw new DomainError(503, 'body_manual_retention_stored_invalid');
    return { schema: MANUAL_RETENTION_COMMAND_RESULT_SCHEMA, receipt, current: current(row) };
  });
  return {
    grant(actor: AccountContext, raw: unknown, key: string): ManualRetentionCommandResult {
      const input = captureManualRetentionGrantPayload(raw);
      if (!input) throw new DomainError(422, 'body_manual_retention_invalid_input');
      return command(actor, key, input.decisionId, 'grant', input, prior => {
        if (prior?.state === 'revoked') return { operation: 'grant', decisionId: input.decisionId,
          outcome: 'blocked_by_revocation', decisionRevision: prior.revision };
        if (prior) throw new DomainError(409, 'body_manual_retention_decision_exists');
        const date = now().toISOString();
        db.prepare('INSERT INTO body_manual_retention_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(actor.accountId, input.decisionId, actor.authUserId, actor.sessionId, actor.epoch,
            'granted', 1, MANUAL_RETENTION_STATEMENT_SHA256, key, date, date);
        return { operation: 'grant', decisionId: input.decisionId, outcome: 'granted', decisionRevision: 1 };
      });
    },
    revoke(actor: AccountContext, decisionId: string, raw: unknown, key: string): ManualRetentionCommandResult {
      const input = captureManualRetentionRevokePayload(raw);
      if (!input || !isManualRetentionDecisionId(decisionId)) throw new DomainError(422, 'body_manual_retention_invalid_input');
      return command(actor, key, decisionId, 'revoke', input, prior => {
        const date = now().toISOString();
        if (!prior) db.prepare('INSERT INTO body_manual_retention_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(actor.accountId, decisionId, actor.authUserId, actor.sessionId, actor.epoch, 'revoked', 1, null, null, date, date);
        else if (prior.state === 'granted') db.prepare("UPDATE body_manual_retention_decisions SET state='revoked',revision=2,updated_at=? WHERE account_id=? AND decision_id=?")
          .run(date, actor.accountId, decisionId);
        return { operation: 'revoke', decisionId, outcome: 'revoked', decisionRevision: prior?.state === 'granted' ? 2 : prior?.revision ?? 1 };
      });
    },
    current(actor: AccountContext, decisionId: string): ManualRetentionCurrentResult {
      if (!isManualRetentionDecisionId(decisionId)) throw new DomainError(422, 'body_manual_retention_invalid_input');
      return lifecycle.withActiveWrite(actor, () => {
        serialized(actor); const row = decision(actor, decisionId);
        return { schema: MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current: row ? current(row) : null };
      });
    },
    requireAuthorityWithinWrite(actor: AccountContext, raw: unknown): ManualRetentionAttemptAuthority {
      serialized(actor);
      const authority = captureManualRetentionAttemptAuthority(raw);
      if (!authority) throw new DomainError(403, 'body_manual_retention_required');
      const row = decision(actor, authority.decisionId);
      if (!row || row.state !== 'granted' || row.revision !== 1 || row.statement_sha256 !== authority.statementSha256)
        throw new DomainError(403, 'body_manual_retention_required');
      return authority;
    },
    attributeWithinWrite(actor: AccountContext, authority: ManualRetentionAttemptAuthority, key: string, measurementId: string): void {
      const admitted = this.requireAuthorityWithinWrite(actor, authority);
      db.prepare('INSERT INTO body_manual_retention_attributions VALUES(?,?,?,?,?,?,?)')
        .run(actor.accountId, key, measurementId, admitted.decisionId, admitted.revision, admitted.statementSha256, now().toISOString());
    },
  };
}
export type ManualRetention = ReturnType<typeof createManualRetention>;
