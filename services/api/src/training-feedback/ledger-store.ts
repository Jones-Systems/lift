import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { FeedbackLedgerEntry, FeedbackLedgerStore, FeedbackMinimalReceipt, FeedbackSourceKey,
  FeedbackStoreDependencies, FeedbackStoredProjection } from './ledger-types.js';

export function feedbackCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, feedbackCanonical).join(',')}]`;
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${feedbackCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new DomainError(422, 'feedback_json_required');
}

// All methods require WS01's existing writer; this store never opens, nests or commits a transaction.
export function createSqliteFeedbackLedgerStore(deps: FeedbackStoreDependencies): FeedbackLedgerStore {
  const { db, lifecycle } = deps;
  function within<T>(context: AccountContext, effect: () => T): T {
    if (!db.inTransaction) throw new DomainError(503, 'feedback_writer_transaction_required');
    deps.assertWithinWrite(context); lifecycle.assertActive(context);
    const value = effect();
    deps.assertWithinWrite(context); lifecycle.assertActive(context);
    return value;
  }
  const versions = (accountId: string) => db.prepare(`SELECT ledger_revision AS ledgerRevision,
    projection_revision AS projectionRevision FROM feedback_state WHERE account_id=?`).get(accountId) as
      { ledgerRevision: number; projectionRevision: number } | undefined;
  const store: FeedbackLedgerStore = {
    loadWithinWrite: context => within(context, () => {
      const state = versions(context.accountId) ?? { ledgerRevision: 0, projectionRevision: 0 };
      const entries = (db.prepare('SELECT data FROM feedback_events WHERE account_id=? ORDER BY sequence')
        .all(context.accountId) as { data: string }[]).map(row => JSON.parse(row.data) as FeedbackLedgerEntry);
      const projection = db.prepare('SELECT data FROM feedback_projections WHERE account_id=?').get(context.accountId) as { data: string } | undefined;
      return { ...state, entries, projection: projection ? JSON.parse(projection.data) as FeedbackStoredProjection : null };
    }),
    receiptWithinWrite: (context, lookup) => within(context, () => {
      const row = ('eventId' in lookup
        ? db.prepare('SELECT event_id,intent_digest,data FROM feedback_receipts WHERE account_id=? AND event_id=?').get(context.accountId, lookup.eventId)
        : db.prepare(`SELECT r.event_id,r.intent_digest,r.data FROM feedback_receipts r JOIN feedback_keys k
          ON k.account_id=r.account_id AND k.event_id=r.event_id WHERE k.account_id=? AND k.idempotency_key=?`)
          .get(context.accountId, lookup.idempotencyKey)) as { event_id: string; intent_digest: string; data: string } | undefined;
      return row ? { eventId: row.event_id, intentDigest: row.intent_digest, receipt: JSON.parse(row.data) as FeedbackMinimalReceipt } : null;
    }),
    dependsOnWithinWrite: (context, sources) => within(context, () => {
      const row = db.prepare('SELECT data FROM feedback_projections WHERE account_id=?').get(context.accountId) as { data: string } | undefined;
      const comparisonKeys = new Set(row ? (JSON.parse(row.data) as FeedbackStoredProjection).derivations
        .flatMap(node => node.comparisonDependencies ?? []).map(feedbackCanonical) : []);
      return sources.some(source => comparisonKeys.has(feedbackCanonical(source)) || ('id' in source && !!db.prepare(
        'SELECT 1 FROM feedback_dependencies WHERE account_id=? AND kind=? AND source_id=? LIMIT 1'
      ).get(context.accountId, source.kind, source.id)));
    }),
    replaceWithinWrite: (context, expected, replacement) => within(context, () => {
      const actual = versions(context.accountId) ?? { ledgerRevision: 0, projectionRevision: 0 };
      if (actual.ledgerRevision !== expected.ledgerRevision || actual.projectionRevision !== expected.projectionRevision)
        throw new DomainError(409, 'feedback_ledger_conflict');
      const encoded = feedbackCanonical(replacement.projection);
      const prior = db.prepare('SELECT data FROM feedback_projections WHERE account_id=?').get(context.accountId) as { data: string } | undefined;
      const changed = encoded !== prior?.data;
      const next = { ledgerRevision: actual.ledgerRevision + (replacement.entry ? 1 : 0),
        projectionRevision: actual.projectionRevision + (changed ? 1 : 0) };
      if (!Number.isSafeInteger(next.ledgerRevision) || !Number.isSafeInteger(next.projectionRevision))
        throw new DomainError(409, 'feedback_revision_exhausted');
      if (replacement.entry && (replacement.entry.sequence !== next.ledgerRevision || replacement.entry.event.accountId !== context.accountId
          || (replacement.entry.event.kind as string) === 'delete')) throw new DomainError(422, 'feedback_invalid_entry');
      db.prepare('INSERT INTO feedback_state VALUES (?,?,?) ON CONFLICT(account_id) DO NOTHING').run(context.accountId, actual.ledgerRevision, actual.projectionRevision);
      const updated = db.prepare(`UPDATE feedback_state SET ledger_revision=?,projection_revision=?
        WHERE account_id=? AND ledger_revision=? AND projection_revision=?`)
        .run(next.ledgerRevision, next.projectionRevision, context.accountId, actual.ledgerRevision, actual.projectionRevision);
      if (updated.changes !== 1) throw new DomainError(409, 'feedback_ledger_conflict');
      if (replacement.entry) db.prepare('INSERT INTO feedback_events VALUES (?,?,?,?)').run(context.accountId,
        replacement.entry.sequence, replacement.entry.event.eventId, feedbackCanonical(replacement.entry));
      if (replacement.receipt) {
        const { eventId, intentDigest, receipt } = replacement.receipt;
        // Project fields explicitly: callers cannot persist a response body or feedback in receipt extension properties.
        const minimal: FeedbackMinimalReceipt = { eventId: receipt.eventId, recordId: receipt.recordId, cause: receipt.cause,
          outcome: receipt.outcome, revision: receipt.revision, reason: receipt.reason, acceptedLedgerRevision: receipt.acceptedLedgerRevision };
        if (eventId !== minimal.eventId) throw new DomainError(422, 'feedback_receipt_identity_mismatch');
        db.prepare('INSERT INTO feedback_receipts VALUES (?,?,?,?)').run(context.accountId, eventId, intentDigest, feedbackCanonical(minimal));
      }
      if (replacement.key) db.prepare('INSERT INTO feedback_keys VALUES (?,?,?)')
        .run(context.accountId, replacement.key.idempotencyKey, replacement.key.eventId);
      if (changed) {
        db.prepare('INSERT INTO feedback_projections VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET data=excluded.data').run(context.accountId, encoded);
        db.prepare('DELETE FROM feedback_dependencies WHERE account_id=?').run(context.accountId);
        const insert = db.prepare('INSERT OR IGNORE INTO feedback_dependencies VALUES (?,?,?,?)');
        for (const source of replacement.projection.sources) {
          if (!source.binding) continue;
          const witness = source.binding.witness;
          const keys: Extract<FeedbackSourceKey, { id: string }>[] = [{ kind: 'context', id: witness.contextId }];
          if (witness.sessionSource) keys.push({ kind: 'session', id: witness.sessionSource.source.id });
          if (witness.targetPlan) keys.push({ kind: 'plan', id: witness.targetPlan.id });
          for (const key of keys) insert.run(context.accountId, source.recordId, key.kind, key.id);
        }
      }
      return next;
    }),
  };
  return store;
}
