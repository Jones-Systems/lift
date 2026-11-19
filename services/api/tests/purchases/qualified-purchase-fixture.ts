import type { TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sqlite } from '../../src/storage.js';
import type { AccountContext } from '../../src/lifecycle/types.js';
import { openSourceSubscriptionStatusStorage } from '../../src/purchases/status-source-migrations.js';
import { NotificationInbox, newNotificationReceiptId, notificationPayloadDigest } from '../../src/purchases/notification-inbox.js';
import { evidenceCanonical } from '../../src/lifecycle/evidence-codec.js';
import { createSyntheticInboxAuthority } from '../../src/purchases/notification-inbox-capabilities.js';
import type { InboxCapability, InboxCapture, InboxClaim, InboxNamespace, InboxOperation, InboxOuter, InboxPolicy, InboxResult,
  InboxSuccess } from '../../src/purchases/notification-inbox.types.js';
import { openSyntheticQualifiedPurchaseStorage } from '../../src/purchases/qualified-purchase-preflight.js';
import { allSchemaDigest, createSyntheticPurchaseAccessAuthority, qualifiedActorBinding, qualifiedNamespaceKey, qualifiedOwnerBindingDigest,
  qualifiedSessionDigest, qualifiedContinuityDigest, qualifiedProjectionReference, qualifiedStatusBinding, qualifiedStatusContentDigest } from '../../src/purchases/qualified-purchase-context.js';
import { createQualifiedPurchaseReader } from '../../src/purchases/qualified-purchase-store.js';
import type { PurchaseAccessContext, PurchaseNamespace, QualifiedNotificationEvidence, QualifiedPurchaseReader, QualifiedStatusEvidence, QualifiedStorage, SyntheticAccessIssuer,
  SyntheticStoreInput } from '../../src/purchases/qualified-purchase.types.js';

// Everything below is synthetic. No value is a default, live policy, product, bundle or credential.
export const STORE_ID = 'store-one';
export const STORE_GENERATION = 'generation-one';
export const bundleA = 'com.example.form';
export const bundleB = 'com.example.other';
export const SBX_A: PurchaseNamespace = { provider: 'Apple', bundleId: bundleA, environment: 'Sandbox', appAppleId: null };
export const PRD_A: PurchaseNamespace = { provider: 'Apple', bundleId: bundleA, environment: 'Production', appAppleId: 123456789 };
export const SBX_B: PurchaseNamespace = { provider: 'Apple', bundleId: bundleB, environment: 'Sandbox', appAppleId: null };
export const PRD_B: PurchaseNamespace = { provider: 'Apple', bundleId: bundleB, environment: 'Production', appAppleId: 987654321 };
export const ALL_NAMESPACES: readonly PurchaseNamespace[] = [SBX_A, PRD_A, SBX_B, PRD_B];
export const products = [
  { productId: 'form.plus.month', type: 'Auto-Renewable Subscription', entitlement: 'form_plus' },
  { productId: 'form.plus.lifetime', type: 'Non-Consumable', entitlement: 'form_plus' },
] as const;
export const configurationFor = (namespaces: readonly PurchaseNamespace[] = ALL_NAMESPACES, revision = 'config1') => ({
  mode: 'source-only', cohort: 'qualified-purchases-v1', use: 'isolated-synthetic', revision,
  namespaces: namespaces.map(namespace => ({ namespace: { ...namespace }, products: products.map(product => ({ ...product })),
    statusAppAppleId: namespace.environment === 'Production' ? namespace.appAppleId : null })),
});
export const policy = {
  revision: 'policy1', maxNamespaces: 8, maxPageSize: 5, maxMetadataRows: 12, maxEvidenceBytes: 4096, maxHistoryPageBytes: 2048, maxHistoryItems: 5,
  retention: { evidenceMs: 60_000, identityMs: 120_000, auditMs: 300_000 },
};
export const inboxPolicy: InboxPolicy = {
  revision: 'fixture1', maxEnvelopeBytes: 2048, maxPayloadBytes: 1024, maxNestedBytes: 128, maxReceipts: 32, maxVariants: 32, maxVerificationClaims: 4,
  maxAttempts: 8, maxTransitions: 32, maxOperationBytes: 8192, maxPageSize: 10, ingressBytes: 2 ** 22, variantBytes: 2 ** 22, completionBytes: 2 ** 29,
  recordOverheadBytes: 4096, retention: { payloadMs: 10000, tombstoneMs: 20000, auditMs: 30000 },
};
export const ACCOUNT_A: AccountContext = { accountId: '11111111-1111-4111-8111-111111111111', authUserId: 'qualified-auth-a', sessionId: 'qualified-session-a', epoch: 0 };
export const ACCOUNT_B: AccountContext = { accountId: '22222222-2222-4222-8222-222222222222', authUserId: 'qualified-auth-b', sessionId: 'qualified-session-b', epoch: 0 };
export const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
export const nsKey = (namespace: PurchaseNamespace): string => qualifiedNamespaceKey(namespace);

export type Scratch = Readonly<{ root: string; path: (name?: string) => string;
  track: <T extends { open: boolean; close(): unknown }>(handle: T) => T }>;
export function scratch(t: TestContext): Scratch {
  // Resolved so storage's non-symlink path rule holds on hosts whose temporary root is itself a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qualified-purchase-')));
  chmodSync(root, 0o700);
  const closers: (() => void)[] = [];
  t.after(() => { try { for (const close of closers.reverse()) close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  return {
    root, path: (name = 'main.sqlite') => join(root, name),
    track: <T extends { open: boolean; close(): unknown }>(handle: T): T => { closers.push(() => { if (handle.open) handle.close(); }); return handle; },
  };
}

/** Dedicated EMPTY-upgrade fixture: built with the real storage constructor, before any seed. */
export type EmptySource27 = Readonly<{ root: string; path: string; db: Sqlite; track: Scratch['track'] }>;
export async function emptySource27(t: TestContext): Promise<EmptySource27> {
  const s = scratch(t), path = s.path();
  const opened = await openSourceSubscriptionStatusStorage(path, { mode: 'source-only', cohort: 'subscription-status-v1' });
  return { root: s.root, path, db: s.track(opened.db), track: s.track };
}

export function currentnessProbe(decide: (phase: string) => unknown = () => true) {
  const phases: string[] = [];
  return { phases, currentness: { generation: 'currentness1', check: (state: { phase: string }) => { phases.push(state.phase); return decide(state.phase); } } };
}
export function storeInput(overrides: Partial<Record<keyof SyntheticStoreInput, unknown>> = {}): SyntheticStoreInput {
  return { use: 'isolated-synthetic', configuration: configurationFor(), storeId: STORE_ID, generation: STORE_GENERATION,
    inbox: { ingress: 'fixture', policy: inboxPolicy }, policy, currentness: currentnessProbe().currentness, ...overrides } as SyntheticStoreInput;
}

// ---- plain SQL readers -------------------------------------------------------------------------------------------
export const userTables = (db: Sqlite): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string }[]).map(row => row.name);
export const count = (db: Sqlite, table: string): number => (db.prepare(`SELECT count(*) n FROM "${table.replace(/"/g, '""')}"`).get() as { n: number }).n;
export const tableCounts = (db: Sqlite): Record<string, number> => Object.fromEntries(userTables(db).map(name => [name, count(db, name)]));
export const migrationRows = (db: Sqlite) => db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as { version: number; checksum: string }[];
export const schemaObjects = (db: Sqlite) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
export const fingerprint = (db: Sqlite): string => sha(db.serialize().toString('base64'));

// ---- direct seeders: this source slice has no writer, so tests populate the new relations explicitly -----------------------------
export function seedAccount(db: Sqlite, account: AccountContext): void {
  db.prepare('INSERT INTO "user"(id,name,email,emailVerified,image,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
    .run(account.authUserId, 'Synthetic', `${account.authUserId}@synthetic.invalid`, 1, null, 0, 0);
  db.prepare('INSERT INTO form_accounts(id,auth_user_id,created_at) VALUES(?,?,?)').run(account.accountId, account.authUserId, '2026-01-01T00:00:00.000Z');
}
export function seedOwner(db: Sqlite, namespace: PurchaseNamespace, original: string, account: AccountContext, createdAtMs = 1000): void {
  db.prepare('INSERT INTO qualified_apple_owners VALUES(?,?,?,?,?)').run(nsKey(namespace), original, account.accountId, account.accountId, createdAtMs);
}
export type SeededTransaction = { transactionId: string; original: string; accountId: string; productId: string; jws: string; proofHash: string };
export function seedTransaction(db: Sqlite, namespace: PurchaseNamespace, input: { transactionId: string; original: string; account: AccountContext;
  productId?: string; purchaseDateMs?: number; signedDateMs?: number; expiresDateMs?: number | null; jws?: string }): SeededTransaction {
  const productId = input.productId ?? 'form.plus.month', jws = input.jws ?? `synthetic.${input.transactionId}.signature`, proofHash = sha(jws);
  db.prepare('INSERT INTO qualified_apple_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nsKey(namespace), input.transactionId, input.original,
    input.account.accountId, productId, 'Auto-Renewable Subscription', input.account.accountId, input.purchaseDateMs ?? 500, input.signedDateMs ?? 900,
    input.expiresDateMs === undefined ? 900000 : input.expiresDateMs, null, 0, proofHash, jws, 1000);
  return { transactionId: input.transactionId, original: input.original, accountId: input.account.accountId, productId, jws, proofHash };
}
export function seedProofObservation(db: Sqlite, namespace: PurchaseNamespace, tx: SeededTransaction): void {
  db.prepare('INSERT INTO qualified_apple_observations VALUES(?,?,?,?,?,?)').run(nsKey(namespace), tx.transactionId, tx.proofHash, '{"synthetic":true}', tx.jws, 1000);
}
export function seedDelivery(db: Sqlite, namespace: PurchaseNamespace, tx: SeededTransaction, input: { serverDeliveryId: string; actor: AccountContext; policyRevision?: string }): void {
  db.prepare('INSERT INTO qualified_apple_deliveries VALUES(?,?,?,?,?,?,?,?,?,?)').run(nsKey(namespace), tx.transactionId, tx.proofHash, input.serverDeliveryId,
    tx.accountId, tx.productId, tx.jws, qualifiedSessionDigest(nsKey(namespace), input.actor), input.policyRevision ?? 'delivery1', 1000);
}
export function seedCommand(db: Sqlite, namespace: PurchaseNamespace, tx: SeededTransaction, input: { key: string; actor: AccountContext; selectionGeneration?: string }): void {
  const request = JSON.stringify({ transactionId: tx.transactionId, productId: tx.productId, proofHash: tx.proofHash, key: input.key });
  db.prepare('INSERT INTO qualified_apple_commands VALUES(?,?,?,?,?,?,?,?,?,?)').run(nsKey(namespace), tx.accountId, input.key, tx.transactionId, tx.productId, tx.proofHash,
    request, sha(request), qualifiedActorBinding(input.actor), input.selectionGeneration ?? 'selection-one');
}
export function seedReconciliation(db: Sqlite, namespace: PurchaseNamespace, input: { handle: string; original: string; actor: AccountContext; status?: string; providerRevision?: string }): void {
  const key = nsKey(namespace);
  db.prepare('INSERT INTO qualified_apple_reconciliations VALUES(?,?,?,?,?,?,?,?,?,?)').run(key, input.handle, input.actor.accountId, input.original,
    JSON.stringify({ key, original: input.original }), qualifiedActorBinding(input.actor), '{"page":0}', 0, input.providerRevision ?? null, JSON.stringify({ status: input.status ?? 'pending' }));
}
type ApplicationRequest = { operationId: string; claim: InboxClaim; applicationInput: string };
export function seedNotification(db: Sqlite, namespace: PurchaseNamespace, input: { uuid: string; aggregateId: string; receiptId: string;
  original: string; account: AccountContext; request: ApplicationRequest; payloadDigest: string }): void {
  db.prepare('INSERT INTO qualified_apple_notifications VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(nsKey(namespace), input.uuid, input.aggregateId, input.receiptId,
    input.payloadDigest, input.request.applicationInput, input.account.accountId, input.original, '{"status":"applied"}', 1000,
    input.request.operationId);
}
let observationCounter = 0;
export const nextSequence = (db: Sqlite): number => (db.prepare('SELECT coalesce(max(sequence),0)+1 n FROM qualified_apple_status_observations').get() as { n: number }).n;
export type SeededObservation = { id: string; sequence: number };
type ObservationInput = { original: string; account: AccountContext; kind?: string; observedAtMs?: number;
  epoch?: number; schemaDigest?: string; generation?: string; ownerDigest?: string; appAccountToken?: string;
  provenance?: QualifiedStatusEvidence['provenance']; validUntilMs?: number | null; continuityDigest?: string;
  notification?: QualifiedNotificationEvidence; proof?: Pick<SeededTransaction, 'transactionId' | 'proofHash'>;
  contentDigest?: string; requestId?: string; observationId?: string; eventKey?: string };
export function seedStatusObservation(db: Sqlite, namespace: PurchaseNamespace, input: ObservationInput): SeededObservation {
  const key = nsKey(namespace), id = input.observationId ?? sha(`observation:${++observationCounter}:${randomUUID()}`), sequence = nextSequence(db);
  const owner = input.ownerDigest ?? qualifiedOwnerBindingDigest({ namespaceKey: key, originalTransactionId: input.original, accountId: input.account.accountId,
    appAccountToken: input.appAccountToken ?? input.account.accountId });
  const schema = input.schemaDigest ?? allSchemaDigest(db), generation = input.generation ?? STORE_GENERATION;
  const binding = { namespace_key: key, account_id: input.account.accountId, original_transaction_id: input.original,
    owner_binding_digest: owner, request_id: input.requestId ?? sha(`request:${id}`), lifecycle_epoch: input.epoch ?? input.account.epoch,
    database_generation: generation, schema_digest: schema,
    continuity_digest: input.continuityDigest ?? qualifiedContinuityDigest(STORE_ID, generation, schema) };
  const evidence: QualifiedStatusEvidence = { version: 'qualified-status-evidence/v1', provenance: input.provenance ?? 'independent_status',
    validUntilMs: input.validUntilMs === undefined ? 2_000_000 : input.validUntilMs, notifications: input.notification ? [input.notification] : [] };
  const content = { observation_id: id, sequence, event_kind: input.kind ?? 'status', event_key: input.eventKey ?? sha(`event:${id}`),
    observed_at_ms: input.observedAtMs ?? 990_000, binding_json: qualifiedStatusBinding(STORE_ID, binding),
    evidence_json: evidenceCanonical(evidence), proof_transaction_id: input.proof?.transactionId ?? null, proof_hash: input.proof?.proofHash ?? null };
  db.prepare(`INSERT INTO qualified_apple_status_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    key, sequence, id, 'qualified-status-v1', binding.account_id, binding.original_transaction_id, owner, content.event_kind, content.event_key,
    binding.request_id, binding.lifecycle_epoch, generation, schema, binding.continuity_digest, content.proof_transaction_id, content.proof_hash,
    content.binding_json, content.evidence_json, input.contentDigest ?? qualifiedStatusContentDigest(content), content.observed_at_ms);
  return { id, sequence };
}
type ProjectionInput = ObservationInput & { observation?: SeededObservation; state?: 'pending' | 'current' | 'held'; lastSeenMs?: number;
  accepted?: AcceptedNotification; notificationUUID?: string };
function seedProjectionObservation(db: Sqlite, namespace: PurchaseNamespace, input: ProjectionInput): SeededObservation {
  if (input.observation) return input.observation;
  if (!input.accepted) return seedStatusObservation(db, namespace, input);
  const { receiptId, aggregateId, capture } = input.accepted;
  const retained = db.prepare(`SELECT a.notification_uuid,a.version,v.canonical_receipt_id,r.digest FROM notification_inbox_aggregates a
    JOIN notification_inbox_variants v ON v.aggregate_id=a.aggregate_id JOIN notification_inbox_receipts r ON r.receipt_id=v.receipt_id
    WHERE a.aggregate_id=? AND v.receipt_id=?`).get(aggregateId, receiptId) as
    { notification_uuid: string; version: number; canonical_receipt_id: string; digest: string };
  const transactionId = `${input.original}7`, jws = `synthetic.transaction.${Buffer.from(capture.signedPayload).toString()}`;
  const proof = { transactionId, jws, proofHash: sha(jws), original: input.original, accountId: input.account.accountId, productId: 'form.plus.month' };
  if (!db.prepare('SELECT 1 FROM qualified_apple_transactions WHERE namespace_key=? AND transaction_id=?').get(nsKey(namespace), transactionId)) {
    seedTransaction(db, namespace, { ...proof, account: input.account });
  }
  if (!db.prepare('SELECT 1 FROM qualified_apple_observations WHERE namespace_key=? AND transaction_id=? AND proof_hash=?')
    .get(nsKey(namespace), transactionId, proof.proofHash)) seedProofObservation(db, namespace, proof);
  return seedStatusObservation(db, namespace, { ...input, proof, notification: {
    aggregateId, aggregateVersion: retained.version, notificationUUID: input.notificationUUID ?? retained.notification_uuid, receiptId,
    canonicalReceiptId: retained.canonical_receipt_id, payloadDigest: retained.digest, storeId: STORE_ID, storeGeneration: STORE_GENERATION,
  } });
}
export const projectionReference = (db: Sqlite, namespace: PurchaseNamespace, observation: SeededObservation): string => {
  const { content_digest } = db.prepare('SELECT content_digest FROM qualified_apple_status_observations WHERE namespace_key=? AND observation_id=?')
    .get(nsKey(namespace), observation.id) as { content_digest: string };
  return qualifiedProjectionReference(observation.id, content_digest);
};
export function seedProjection(db: Sqlite, namespace: PurchaseNamespace, input: ProjectionInput): { revision: number; observation: SeededObservation } {
  const key = nsKey(namespace);
  const observation = seedProjectionObservation(db, namespace, input);
  const owner = input.ownerDigest ?? qualifiedOwnerBindingDigest({ namespaceKey: key, originalTransactionId: input.original, accountId: input.account.accountId, appAccountToken: input.account.accountId });
  const schema = input.schemaDigest ?? allSchemaDigest(db), generation = input.generation ?? STORE_GENERATION;
  db.prepare(`INSERT INTO qualified_apple_status_projection VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(key, input.original, input.account.accountId, owner,
    'qualified-status-v1', 1, input.epoch ?? input.account.epoch, generation, schema,
    input.continuityDigest ?? qualifiedContinuityDigest(STORE_ID, generation, schema),
    observation.id, input.state ?? 'current', input.provenance ?? 'independent_status', projectionReference(db, namespace, observation),
    input.validUntilMs === undefined ? 2_000_000 : input.validUntilMs,
    null, null, null, input.lastSeenMs ?? 990_000);
  return { revision: 1, observation };
}
/** Independent reconciled revision: new status evidence, advancing the existing projection exactly one revision. */
export function advanceProjection(db: Sqlite, namespace: PurchaseNamespace, input: ProjectionInput & {
  provenance: QualifiedStatusEvidence['provenance']; revision: number }): SeededObservation {
  const observation = seedProjectionObservation(db, namespace, input);
  db.prepare(`UPDATE qualified_apple_status_projection SET revision=?,current_observation_id=?,provenance_kind=?,projection_json=?,
    valid_until_ms=?,last_seen_at_ms=?,projection_state='current' WHERE namespace_key=? AND original_transaction_id=?`)
    .run(input.revision, observation.id, input.provenance, projectionReference(db, namespace, observation),
      input.validUntilMs === undefined ? 2_000_000 : input.validUntilMs, 990_500, nsKey(namespace), input.original);
  return observation;
}
export function seedDependency(db: Sqlite, namespace: PurchaseNamespace, input: { original: string; revision: number; aggregateId: string; version: number; reference?: string }): void {
  const reference = db.prepare(`SELECT e.value FROM qualified_apple_status_projection p JOIN qualified_apple_status_observations o
    ON o.namespace_key=p.namespace_key AND o.observation_id=p.current_observation_id
    JOIN json_each(o.evidence_json, '$.notifications') e WHERE p.namespace_key=? AND p.original_transaction_id=?`)
    .pluck().get(nsKey(namespace), input.original) as string | undefined;
  db.prepare('INSERT INTO qualified_apple_projection_dependencies VALUES(?,?,?,?,?,?)')
    .run(nsKey(namespace), input.original, input.revision, input.aggregateId, input.version, input.reference ?? reference ?? '{}');
}
export const aggregateFor = (db: Sqlite, namespace: PurchaseNamespace, uuid: string) =>
  db.prepare('SELECT aggregate_id,version,conflicted,invalidation_required FROM notification_inbox_aggregates WHERE namespace_key=? AND notification_uuid=?')
    .get(nsKey(namespace), uuid) as { aggregate_id: string; version: number; conflicted: number; invalidation_required: number } | undefined;

// ---- notification inbox composition on the same database ---------------------------------------------------------
const operations: readonly InboxOperation[] = ['capture', 'verify', 'promote', 'claim', 'complete', 'metadata', 'proof', 'replay', 'dispose'];
export const ok = (result: InboxResult): InboxSuccess => {
  if (result.status !== 'ok') throw new Error(`inbox refused: ${result.status}`);
  return result;
};
type AcceptedNotification = { capture: InboxCapture; receiptId: string; aggregateId: string; result: InboxSuccess };
export type InboxHarness = Readonly<{
  inbox: NotificationInbox; caps: Record<InboxOperation, InboxCapability>; control: { settled: boolean; now: number };
  accept: (payload: string, namespace: InboxNamespace, notificationUUID: string) => Promise<AcceptedNotification>;
  claim: (receiptId: string) => InboxClaim; request: (payload: string, namespace: InboxNamespace, notificationUUID: string) => InboxCapture;
  committer: () => ReturnType<NotificationInbox['createSyntheticPurchaseCommitter']>;
}>;
export function composeInbox(db: Sqlite, scopes: readonly InboxNamespace[]): InboxHarness {
  const authority = createSyntheticInboxAuthority(db, { use: 'isolated-synthetic', ingress: 'fixture' });
  const caps = Object.fromEntries(operations.map(op => [op, authority.issue(op, { ingress: 'fixture', namespaces: scopes, receiptId: null })])) as Record<InboxOperation, InboxCapability>;
  const outers = new Map<string, InboxOuter>();
  const nested = new Map<string, InboxNamespace>();
  const control = { settled: true, now: 1000 };
  const inbox = new NotificationInbox(db, {
    use: 'isolated-synthetic', ingress: 'fixture', now: () => control.now, afterCommit: () => {},
    settlement: attempt => {
      const row = db.prepare('SELECT custody_id,generation FROM notification_inbox_claims WHERE attempt_id=?').get(attempt) as { custody_id: string; generation: number } | undefined;
      return { custodyId: row?.custody_id ?? 'unavailable', generation: row?.generation ?? 0, settled: control.settled };
    },
    verifier: {
      outer: async bytes => outers.get(bytes) as InboxOuter,
      transaction: async proof => ({ namespace: nested.get(proof) as InboxNamespace, originalTransactionId: 'synthetic-lineage', appAccountToken: 'synthetic-token' }),
      renewal: async proof => ({ namespace: nested.get(proof) as InboxNamespace, originalTransactionId: 'synthetic-lineage', appAccountToken: 'synthetic-token' }),
    },
  });
  const request = (payload: string, namespace: InboxNamespace, notificationUUID: string): InboxCapture => {
    const proof = `synthetic.transaction.${payload}`;
    nested.set(proof, namespace);
    outers.set(payload, { namespace, notificationUUID, signedTransaction: proof, signedRenewal: null });
    return { operationId: randomUUID(), receiptId: newNotificationReceiptId(), signedPayload: Buffer.from(payload), envelopeBytes: Buffer.byteLength(payload) + 24, provenance: 'synthetic_ingress' };
  };
  /** Real capture, synthetic verification and real promotion. The inbox remains the sole UUID-variant and conflict authority. */
  const accept = async (payload: string, namespace: InboxNamespace, notificationUUID: string) => {
    const capture = request(payload, namespace, notificationUUID);
    ok(inbox.capture(caps.capture, capture));
    const current = ok(inbox.readCapture(caps.metadata, capture.receiptId));
    const verified = await inbox.verify(caps.verify, { operationId: randomUUID(), receiptId: capture.receiptId, expectedVersion: current.version, custodyId: 'fixture-verifier' });
    ok(verified.result);
    if (!verified.verified) throw new Error('verification token missing');
    const result = ok(inbox.promote(caps.promote, { operationId: randomUUID(), receiptId: capture.receiptId, expectedVersion: ok(verified.result).version, verified: verified.verified }));
    const row = db.prepare('SELECT aggregate_id FROM notification_inbox_state WHERE receipt_id=?').get(capture.receiptId) as { aggregate_id: string };
    if (notificationPayloadDigest(capture.signedPayload) !== (db.prepare('SELECT digest FROM notification_inbox_receipts WHERE receipt_id=?')
      .pluck().get(capture.receiptId) as string)) throw new Error('captured payload identity mismatch');
    return { capture, receiptId: capture.receiptId, aggregateId: row.aggregate_id, result };
  };
  const claim = (receiptId: string): InboxClaim => {
    const state = ok(inbox.readCapture(caps.metadata, receiptId));
    const work = db.prepare('SELECT version FROM notification_inbox_work WHERE work_id=?').get(state.workId) as { version: number };
    const claimed = ok(inbox.claim(caps.claim, { operationId: randomUUID(), receiptId, expected: { receipt: state.version, work: work.version, aggregate: state.aggregateVersion as number }, custodyId: 'fixture-processing' }));
    if (!claimed.claim) throw new Error('claim missing');
    return claimed.claim;
  };
  const committer = () => inbox.createSyntheticPurchaseCommitter(caps.complete, { use: 'isolated-synthetic' });
  return { inbox, caps, control, accept, claim, request, committer };
}

// ---- complete qualified fixture --------------------------------------------------------------------------------------
export type QualifiedFixture = Readonly<{
  root: string; path: string; input: SyntheticStoreInput; storage: QualifiedStorage; db: Sqlite; clock: { now: number };
  selections: Map<string, { namespace: PurchaseNamespace; generation: string }>;
  accounts: Map<string, { suppressed: boolean; epoch: number; current: boolean }>; control: { currentness: boolean };
  issuer: SyntheticAccessIssuer; reader: QualifiedPurchaseReader; track: Scratch['track'];
  context: (actor: AccountContext, namespace: PurchaseNamespace, generation?: string) => PurchaseAccessContext;
  inbox: (scopes?: readonly InboxNamespace[]) => InboxHarness;
}>;
export async function qualified(t: TestContext, options: { namespaces?: readonly PurchaseNamespace[]; policy?: Record<string, unknown> } = {}): Promise<QualifiedFixture> {
  const s = scratch(t), path = s.path();
  const input = storeInput({ configuration: configurationFor(options.namespaces ?? ALL_NAMESPACES), policy: { ...policy, ...options.policy } });
  const storage: QualifiedStorage = await openSyntheticQualifiedPurchaseStorage(path, input);
  const db = s.track(storage.db);
  const clock = { now: 1_000_000 };
  const selections = new Map<string, { namespace: PurchaseNamespace; generation: string }>();
  const accounts = new Map<string, { suppressed: boolean; epoch: number; current: boolean }>();
  const control = { currentness: true };
  const issuer = createSyntheticPurchaseAccessAuthority(db, { use: 'isolated-synthetic', storeId: STORE_ID, generation: STORE_GENERATION, configurationRevision: 'config1',
    policyRevision: String(policy.revision), authorityGeneration: 'authority-one',
    currentSelection: accountId => selections.get(accountId) ?? null,
    accountState: accountId => accounts.get(accountId) ?? { suppressed: false, epoch: 0, current: true },
    currentness: () => control.currentness });
  t.after(() => issuer.close());
  const reader = createQualifiedPurchaseReader(db, { use: 'isolated-synthetic', clock: () => clock.now });
  /** Selects exactly one namespace/generation for the account, then issues a privately registered context. */
  const context = (actor: AccountContext, namespace: PurchaseNamespace, generation = 'selection-one'): PurchaseAccessContext => {
    selections.set(actor.accountId, { namespace, generation });
    return issuer.forOwner(actor);
  };
  return { root: s.root, track: s.track, path, input, storage, db, clock, selections, accounts, control, issuer, reader, context,
    inbox: (scopes: readonly InboxNamespace[] = [SBX_A, PRD_A, SBX_B, PRD_B]) => composeInbox(db, scopes) };
}
