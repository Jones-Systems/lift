import type { Sqlite } from '../storage.js';
import { evidenceCanonical } from '../lifecycle/evidence-codec.js';
import { notificationPayloadDigest } from './notification-inbox.js';
import { assertQualifiedPurchaseSchema, authenticatedNotificationVariant } from './qualified-purchase-schema.js';
import { QualifiedRefusal, refuse, checkPurchaseAccess, allSchemaDigest, qualifiedOwnerBindingDigest, qualifiedActorBinding,
  qualifiedContinuityDigest, qualifiedStatusBinding, qualifiedStatusContentDigest, qualifiedProjectionReference,
  accountUuid, appleTransactionId, type PurchaseAccessView, type QualifiedStatusBinding } from './qualified-purchase-context.js';
import type { PurchaseAccessContext, QualifiedDeliveryMetadata, QualifiedNotificationEvidence, QualifiedObservationCursor, QualifiedObservationMetadata,
  QualifiedObservationPage, QualifiedProjectionHoldReason, QualifiedProjectionRead, QualifiedPurchaseOwner, QualifiedPurchaseReader,
  QualifiedReconciliationMetadata, QualifiedStatusEvidence } from './qualified-purchase.types.js';

const hex64 = /^[a-f0-9]{64}$/;
const handleSyntax = /^[a-zA-Z0-9_-]{1,128}$/;
const outcomeKinds = new Set(['pending', 'page_ready', 'complete', 'rejected', 'unavailable', 'unknown']);
const maxTime = 8640000000000000;

type CursorState = Readonly<{
  reader: object; authority: PurchaseAccessView['authority']; scope: string; highwater: number; after: number; served: number; expiresAtMs: number;
}>;
const cursors = new WeakMap<object, CursorState>();
type ProjectionRow = {
  original_transaction_id: string; account_id: string; owner_binding_digest: string; encoding_version: string; revision: number;
  lifecycle_epoch: number; database_generation: string; schema_digest: string; current_observation_id: string | null;
  continuity_digest: string; projection_json: string; projection_state: string; provenance_kind: string;
  valid_until_ms: number | null; last_seen_at_ms: number;
};
type ObservationRow = QualifiedStatusBinding & {
  observation_id: string; sequence: number; event_kind: string; event_key: string; observed_at_ms: number;
  binding_json: string; evidence_json: string; content_digest: string; proof_transaction_id: string | null; proof_hash: string | null;
};
type DependencyRow = { aggregate_id: string; aggregate_version: number; evidence_reference: string };
type AggregateRow = { namespace_key: string; notification_uuid: string; namespace_json: string; version: number; conflicted: number; invalidation_required: number };

function statusEvidence(observation: ObservationRow, row: ProjectionRow, view: PurchaseAccessView): QualifiedStatusEvidence | undefined {
  if (observation.binding_json !== qualifiedStatusBinding(view.store.storeId, observation) ||
      observation.content_digest !== qualifiedStatusContentDigest(observation) ||
      row.projection_json !== qualifiedProjectionReference(observation.observation_id, observation.content_digest)) return undefined;
  try {
    const evidence = JSON.parse(observation.evidence_json) as QualifiedStatusEvidence;
    if (evidence.version !== 'qualified-status-evidence/v1' || evidence.validUntilMs !== row.valid_until_ms ||
        !Array.isArray(evidence.notifications) || evidence.notifications.length > 32 ||
        evidence.provenance !== row.provenance_kind || !['independent_status', 'notification_evidence'].includes(evidence.provenance) ||
        evidenceCanonical({ version: evidence.version, provenance: evidence.provenance, validUntilMs: evidence.validUntilMs,
          notifications: evidence.notifications }) !== observation.evidence_json) return undefined;
    return evidence;
  } catch { return undefined; }
}

function notificationHold(db: Sqlite, view: PurchaseAccessView, dependency: DependencyRow,
    reference: QualifiedNotificationEvidence, proofDigest: string | undefined): QualifiedProjectionHoldReason | undefined {
  const aggregate = db.prepare(`SELECT namespace_key,notification_uuid,namespace_json,version,conflicted,invalidation_required
    FROM main.notification_inbox_aggregates WHERE aggregate_id=?`).get(dependency.aggregate_id) as AggregateRow | undefined;
  if (!aggregate) return 'dependency_missing';
  if (aggregate.namespace_key !== view.namespaceKey) return 'dependency_namespace';
  if (aggregate.conflicted !== 0) return 'dependency_conflicted';
  if (aggregate.invalidation_required !== 0) return 'dependency_invalidated';
  if (aggregate.version !== dependency.aggregate_version) return 'dependency_changed';
  const { aggregateId, aggregateVersion, notificationUUID, receiptId, canonicalReceiptId, payloadDigest, storeId, storeGeneration } = reference;
  if (aggregateId !== dependency.aggregate_id || aggregateVersion !== dependency.aggregate_version || notificationUUID !== aggregate.notification_uuid ||
      storeId !== view.store.storeId || storeGeneration !== view.store.generation || !proofDigest ||
      evidenceCanonical({ aggregateId, aggregateVersion, notificationUUID, receiptId, canonicalReceiptId, payloadDigest, storeId, storeGeneration }) !==
        dependency.evidence_reference) return 'dependency_evidence';
  try {
    if (evidenceCanonical(JSON.parse(aggregate.namespace_json)) !== evidenceCanonical(view.namespace)) return 'dependency_evidence';
    const variant = db.prepare(`SELECT b.bytes ${authenticatedNotificationVariant}
      WHERE a.aggregate_id=? AND r.receipt_id=? AND cr.receipt_id=? AND r.digest=?
        AND r.byte_length<=? AND json_extract(op.input_json,'$.outer.transactionDigest')=? LIMIT 1`)
      .get(aggregateId, receiptId, canonicalReceiptId, payloadDigest, view.store.policy.maxEvidenceBytes, proofDigest) as { bytes: Buffer } | undefined;
    return variant && notificationPayloadDigest(variant.bytes) === payloadDigest ? undefined : 'dependency_evidence';
  } catch { return 'dependency_evidence'; }
}

/**
 * Synchronous qualified readers. Every read is one immediate transaction, bound to a privately issued context that is
 * re-established before and after the SELECTs and again before returning. These readers update no grant, acknowledge
 * no inbox work, call no producer and accept no thenable. Only these readers are fenced; a later consumer must route
 * every access path through the selected authority.
 */
export function createQualifiedPurchaseReader(db: Sqlite, input: Readonly<{ use: 'isolated-synthetic'; clock: () => number }>): QualifiedPurchaseReader {
  if (!input || input.use !== 'isolated-synthetic' || typeof input.clock !== 'function' || !db || !db.open) return refuse('invalid_request');
  if (db.inTransaction) return refuse('transaction_not_allowed');
  try { assertQualifiedPurchaseSchema(db); } catch { return refuse('store_unavailable'); }
  const expectedSchemaDigest = allSchemaDigest(db);
  const token = Object.freeze({});
  let lastNow = 0;
  const tick = (): number => {
    let value: unknown;
    try { value = input.clock(); } catch { return refuse('clock_unavailable'); }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maxTime || value < lastNow) return refuse('clock_unavailable');
    lastNow = value;
    return value;
  };

  function read<T>(context: PurchaseAccessContext, body: (view: PurchaseAccessView, now: number) => T): T {
    if (db.inTransaction) return refuse('transaction_not_allowed');
    let value: T;
    try {
      value = db.transaction((): T => {
        const before = checkPurchaseAccess(db, context, expectedSchemaDigest);
        const result = body(before, tick());
        const after = checkPurchaseAccess(db, context, expectedSchemaDigest);
        // A changed selection, session or suppression state discards the entire result.
        if (after.namespaceKey !== before.namespaceKey || after.selectionGeneration !== before.selectionGeneration ||
            after.schemaDigest !== before.schemaDigest || evidenceCanonical(after.actor) !== evidenceCanonical(before.actor)) return refuse('selection_changed');
        return result;
      }).immediate();
    } catch (error) { return error instanceof QualifiedRefusal ? refuse(error.code) : refuse('store_unavailable'); }
    checkPurchaseAccess(db, context, expectedSchemaDigest);
    return value;
  }
  const transactionId = (value: unknown): string => typeof value === 'string' && appleTransactionId.test(value) ? value : refuse('invalid_request');

  return Object.freeze({
    owner(context: PurchaseAccessContext, originalTransactionId: string): QualifiedPurchaseOwner | null {
      const original = transactionId(originalTransactionId);
      return read(context, view => {
        // Scoped by the caller's account: another account's owner is indistinguishable from an absent one.
        const row = db.prepare('SELECT account_id,app_account_token FROM main.qualified_apple_owners WHERE namespace_key=? AND original_transaction_id=? AND account_id=?')
          .get(view.namespaceKey, original, view.actor.accountId) as { account_id: string; app_account_token: string } | undefined;
        if (!row) return null;
        if (row.app_account_token !== row.account_id || !accountUuid.test(row.account_id)) return refuse('store_unavailable');
        return Object.freeze({ namespace: view.namespace, originalTransactionId: original, accountId: row.account_id, appAccountToken: row.app_account_token });
      });
    },

    delivery(context: PurchaseAccessContext, transaction: string, proofHash: string): QualifiedDeliveryMetadata | null {
      const id = transactionId(transaction);
      if (typeof proofHash !== 'string' || !hex64.test(proofHash)) return refuse('invalid_request');
      return read(context, view => {
        const row = db.prepare(`SELECT d.server_delivery_id,d.product_id,d.delivery_policy_revision,d.delivered_at_ms,d.original_session_digest
          FROM main.qualified_apple_deliveries d JOIN main.qualified_apple_observations o
          ON o.namespace_key=d.namespace_key AND o.transaction_id=d.transaction_id AND o.proof_hash=d.proof_hash AND o.exact_jws=d.exact_jws
          WHERE d.namespace_key=? AND d.transaction_id=? AND d.proof_hash=? AND d.account_id=?`).get(view.namespaceKey, id, proofHash, view.actor.accountId) as
          { server_delivery_id: string; product_id: string; delivery_policy_revision: string; delivered_at_ms: number; original_session_digest: string } | undefined;
        // The native receipt identifier is released only to the original session; raw proof material is never returned.
        if (!row || row.original_session_digest !== view.sessionDigest) return null;
        return Object.freeze({ namespace: view.namespace, transactionId: id, proofHash, productId: row.product_id, serverDeliveryId: row.server_delivery_id,
          deliveryPolicyRevision: row.delivery_policy_revision, deliveredAtMs: row.delivered_at_ms });
      });
    },

    reconciliation(context: PurchaseAccessContext, handle: string): QualifiedReconciliationMetadata | null {
      if (typeof handle !== 'string' || !handleSyntax.test(handle)) return refuse('invalid_request');
      return read(context, view => {
        // A handle alone is neither a lookup key nor permission: owner account and original actor binding must match.
        const row = db.prepare(`SELECT original_transaction_id,actor_binding_json,expected_page,outcome_json FROM main.qualified_apple_reconciliations
          WHERE namespace_key=? AND handle=? AND account_id=?`).get(view.namespaceKey, handle, view.actor.accountId) as
          { original_transaction_id: string; actor_binding_json: string; expected_page: number; outcome_json: string } | undefined;
        if (!row || row.actor_binding_json !== qualifiedActorBinding(view.actor)) return null;
        let kind = 'unknown';
        try {
          const status = (JSON.parse(row.outcome_json) as { status?: unknown }).status;
          if (typeof status === 'string' && outcomeKinds.has(status)) kind = status;
        } catch { /* Unparseable outcome text is never surfaced. */ }
        return Object.freeze({ namespace: view.namespace, handle, originalTransactionId: row.original_transaction_id, expectedPage: row.expected_page,
          outcomeKind: kind });
      });
    },

    projection(context: PurchaseAccessContext, originalTransactionId: string): QualifiedProjectionRead {
      const original = transactionId(originalTransactionId);
      return read(context, (view, now): QualifiedProjectionRead => {
        const base = { namespace: view.namespace, selectionGeneration: view.selectionGeneration } as const;
        const owner = db.prepare('SELECT account_id,app_account_token FROM main.qualified_apple_owners WHERE namespace_key=? AND original_transaction_id=? AND account_id=?')
          .get(view.namespaceKey, original, view.actor.accountId) as { account_id: string; app_account_token: string } | undefined;
        const row = owner ? db.prepare('SELECT * FROM main.qualified_apple_status_projection WHERE namespace_key=? AND original_transaction_id=?')
          .get(view.namespaceKey, original) as ProjectionRow | undefined : undefined;
        if (!owner || !row) return Object.freeze({ status: 'absent' as const, ...base });
        const hold = (reason: QualifiedProjectionHoldReason): QualifiedProjectionRead =>
          Object.freeze({ status: 'held' as const, ...base, revision: row.revision, reason });
        if (row.account_id !== owner.account_id || row.projection_state !== 'current') return hold('not_current');
        if (db.prepare(`SELECT 1 FROM main.qualified_apple_status_projection
          WHERE account_id=? AND active_request_id IS NOT NULL LIMIT 1`).get(owner.account_id)) return hold('dispatch_unresolved');
        if (row.last_seen_at_ms > now) return hold('clock');
        if (row.valid_until_ms === null || now >= row.valid_until_ms) return hold('expired');
        const ownerDigest = qualifiedOwnerBindingDigest({ namespaceKey: view.namespaceKey, originalTransactionId: original,
          accountId: owner.account_id, appAccountToken: owner.app_account_token });
        if (row.encoding_version !== 'qualified-status-v1' || row.owner_binding_digest !== ownerDigest || row.lifecycle_epoch !== view.actor.epoch) return hold('binding');
        if (row.database_generation !== view.store.generation || row.schema_digest !== view.schemaDigest) return hold('source_generation');
        if (row.continuity_digest !== qualifiedContinuityDigest(view.store.storeId, view.store.generation, view.schemaDigest)) return hold('binding');
        const observation = db.prepare(`SELECT * FROM main.qualified_apple_status_observations
          WHERE namespace_key=? AND account_id=? AND original_transaction_id=? AND event_kind='status' ORDER BY sequence DESC LIMIT 1`)
          .get(view.namespaceKey, owner.account_id, original) as ObservationRow | undefined;
        if (!observation || observation.observation_id !== row.current_observation_id || observation.owner_binding_digest !== row.owner_binding_digest ||
            observation.lifecycle_epoch !== row.lifecycle_epoch || observation.database_generation !== row.database_generation ||
            observation.schema_digest !== row.schema_digest || observation.continuity_digest !== row.continuity_digest ||
            observation.observed_at_ms > row.last_seen_at_ms || Buffer.byteLength(observation.evidence_json) > view.store.policy.maxEvidenceBytes) return hold('observation');
        const evidence = statusEvidence(observation, row, view);
        if (!evidence) return hold('observation');
        const dependencies = db.prepare(`SELECT aggregate_id,aggregate_version,evidence_reference FROM main.qualified_apple_projection_dependencies
          WHERE namespace_key=? AND original_transaction_id=? AND projection_revision=? ORDER BY aggregate_id LIMIT 33`)
          .all(view.namespaceKey, original, row.revision) as DependencyRow[];
        if (evidence.provenance === 'independent_status' && (dependencies.length || evidence.notifications.length)) return hold('provenance_inconsistent');
        if (evidence.provenance === 'notification_evidence' && (!dependencies.length || !evidence.notifications.length)) return hold('provenance_required');
        if (dependencies.length !== evidence.notifications.length) return hold('provenance_inconsistent');
        const references = new Map(evidence.notifications.map(ref => [ref?.aggregateId, ref]));
        if (references.size !== dependencies.length) return hold('provenance_inconsistent');
        const proof = observation.proof_transaction_id === null ? undefined : db.prepare(`SELECT o.exact_jws
          FROM main.qualified_apple_observations o JOIN main.qualified_apple_transactions t
          ON t.namespace_key=o.namespace_key AND t.transaction_id=o.transaction_id
          WHERE o.namespace_key=? AND o.transaction_id=? AND o.proof_hash=? AND t.account_id=? AND t.original_transaction_id=?
            AND length(CAST(o.exact_jws AS BLOB))<=?`)
          .get(view.namespaceKey, observation.proof_transaction_id, observation.proof_hash, owner.account_id, original,
            view.store.policy.maxEvidenceBytes) as { exact_jws: string } | undefined;
        if (observation.proof_transaction_id !== null && !proof) return hold('observation');
        const proofDigest = proof && notificationPayloadDigest(Buffer.from(proof.exact_jws));
        for (const dependency of dependencies) {
          const reference = references.get(dependency.aggregate_id);
          if (!reference) return hold('provenance_inconsistent');
          const reason = notificationHold(db, view, dependency, reference, proofDigest);
          if (reason) return hold(reason);
        }
        return Object.freeze({ status: 'synthetic_current' as const, ...base, revision: row.revision });
      });
    },

    listObservationMetadata(context: PurchaseAccessContext, request: Readonly<{ limit: number; cursor?: QualifiedObservationCursor }>): QualifiedObservationPage {
      if (!request || typeof request !== 'object' || !Number.isSafeInteger(request.limit) || request.limit < 1) return refuse('invalid_request');
      const old = request.cursor === undefined ? undefined : (typeof request.cursor === 'object' && request.cursor !== null ? cursors.get(request.cursor) : undefined);
      if (request.cursor !== undefined && !old) return refuse('stale_cursor');
      return read(context, (view, now): QualifiedObservationPage => {
        const policy = view.store.policy;
        if (request.limit > Math.min(policy.maxPageSize, policy.maxMetadataRows)) return refuse('limit_exceeded');
        // Namespace, account, session, filter, policy, generation and selection are frozen into the cursor.
        const scope = evidenceCanonical(['qualified-observations/v1', view.store.storeId, view.store.generation, view.schemaDigest, policy.revision,
          view.store.configuration.revision, view.authority.generation, view.namespaceKey, view.actor, view.selectionGeneration]);
        if (old && (old.reader !== token || old.authority !== view.authority || old.scope !== scope)) return refuse('stale_cursor');
        if (old && now >= old.expiresAtMs) return refuse('history_unavailable');
        const highwater = old?.highwater ?? (db.prepare('SELECT coalesce(max(sequence),0) n FROM main.qualified_apple_status_observations').get() as { n: number }).n;
        const rows = db.prepare(`SELECT sequence,event_kind,observed_at_ms FROM main.qualified_apple_status_observations WHERE namespace_key=? AND account_id=?
          AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?`).all(view.namespaceKey, view.actor.accountId, old?.after ?? 0, highwater, request.limit + 1) as
          { sequence: number; event_kind: QualifiedObservationMetadata['eventKind']; observed_at_ms: number }[];
        const page = rows.slice(0, request.limit);
        if ((old?.served ?? 0) + page.length > policy.maxMetadataRows) return refuse('limit_exceeded');
        const records: QualifiedObservationMetadata[] = [];
        for (const item of page) {
          // History past its audit retention is unavailable; a cursor is never silently advanced across it.
          if (item.observed_at_ms + policy.retention.auditMs <= now) return refuse('history_unavailable');
          records.push(Object.freeze({ sequence: item.sequence, namespace: view.namespace, eventKind: item.event_kind, observedAtMs: item.observed_at_ms }));
        }
        let cursor: QualifiedObservationCursor | null = null;
        const last = page[page.length - 1];
        if (rows.length > request.limit && last) {
          const expiresAtMs = old?.expiresAtMs ?? now + policy.retention.evidenceMs;
          if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs > maxTime) return refuse('clock_unavailable');
          cursor = Object.freeze({}) as QualifiedObservationCursor;
          cursors.set(cursor, Object.freeze({ reader: token, authority: view.authority, scope, highwater, after: last.sequence, served: (old?.served ?? 0) + page.length, expiresAtMs }));
        }
        return Object.freeze({ records: Object.freeze(records), cursor });
      });
    },
  });
}
