import type { Sqlite } from '../storage.js';
import type { AccountContext } from '../lifecycle/types.js';
import { evidenceCanonical, evidenceDigest } from '../lifecycle/evidence-codec.js';
import { namespaceKey } from './notification-inbox-capabilities.js';
import { validateAppleConfiguration, accountUuid, appleTransactionId } from './configuration.js';
import type { AppleProduct } from './types.js';
import type { PurchaseAccessContext, PurchaseNamespace, QualifiedNamespaceConfiguration, QualifiedPurchaseConfiguration,
  QualifiedPurchasePolicy, QualifiedRefusalCode, SyntheticAccessInput, SyntheticAccessIssuer } from './qualified-purchase.types.js';

export const QUALIFIED_SCHEMA_VERSION = 'qualified-purchases-v1';
export const QUALIFIED_COHORT = 'qualified-purchases-v1';
const revisionSyntax = /^[a-zA-Z0-9_-]{1,80}$/;
const identitySyntax = /^[a-zA-Z0-9_-]{1,128}$/;
const hex64 = /^[a-f0-9]{64}$/;

/** Closed refusal carrying a code only. Never a payload, proof, token or provider text. */
export class QualifiedRefusal extends Error {
  constructor(readonly code: QualifiedRefusalCode) { super(code); }
}
export const refuse = (code: QualifiedRefusalCode): never => { throw new QualifiedRefusal(code); };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const positiveSafe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const thenable = (value: unknown): boolean =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in (value as object);

/**
 * Canonical namespace identity N. This is the exact existing inbox serialization, additionally held to the stricter dotted
 * bundle grammar. appAppleId is validated there but is a configuration binding, never part of N.
 */
export function qualifiedNamespaceKey(namespace: PurchaseNamespace): string {
  const key = namespaceKey(namespace);
  validateAppleConfiguration({ bundleId: namespace.bundleId, products: [{ productId: 'p', type: 'Non-Consumable', entitlement: 'form_plus' }] });
  return key;
}

const rejected = (): never => { throw new Error('qualified_purchase_configuration_rejected'); };

export function validateQualifiedPurchaseConfiguration(value: unknown): QualifiedPurchaseConfiguration {
  try {
    if (!isRecord(value) || !exactKeys(value, ['mode', 'cohort', 'use', 'revision', 'namespaces']) ||
        value.mode !== 'source-only' || value.cohort !== QUALIFIED_COHORT || value.use !== 'isolated-synthetic' ||
        typeof value.revision !== 'string' || !revisionSyntax.test(value.revision) ||
        !Array.isArray(value.namespaces) || value.namespaces.length < 1 || value.namespaces.length > 16) return rejected();
    const seen = new Set<string>();
    const namespaces: QualifiedNamespaceConfiguration[] = [];
    for (const item of value.namespaces as readonly unknown[]) {
      if (!isRecord(item) || !exactKeys(item, ['namespace', 'products', 'statusAppAppleId']) || !isRecord(item.namespace)) return rejected();
      const raw = item.namespace;
      if (!exactKeys(raw, ['provider', 'bundleId', 'environment', 'appAppleId'])) return rejected();
      const candidate = { provider: raw.provider, bundleId: raw.bundleId, environment: raw.environment, appAppleId: raw.appAppleId } as PurchaseNamespace;
      const key = qualifiedNamespaceKey(candidate);
      if (seen.has(key)) return rejected();
      seen.add(key);
      // Reuse the existing product syntax, bounds, type and entitlement rules unchanged.
      const products = validateAppleConfiguration({ bundleId: candidate.bundleId, products: item.products }).products as readonly AppleProduct[];
      const status = item.statusAppAppleId;
      if (candidate.environment === 'Production' ? status !== candidate.appAppleId : status !== null && !positiveSafe(status)) return rejected();
      namespaces.push(Object.freeze({
        namespace: Object.freeze({ provider: 'Apple' as const, bundleId: candidate.bundleId, environment: candidate.environment, appAppleId: candidate.appAppleId }),
        products: Object.freeze(products.map(product => Object.freeze({ ...product }))),
        statusAppAppleId: status as number | null,
      }));
    }
    return Object.freeze({ mode: 'source-only' as const, cohort: QUALIFIED_COHORT, use: 'isolated-synthetic' as const,
      revision: value.revision, namespaces: Object.freeze(namespaces) });
  } catch { return rejected(); }
}

export function validateQualifiedPurchasePolicy(value: unknown): QualifiedPurchasePolicy {
  try {
    if (!isRecord(value) || !exactKeys(value, ['revision', 'maxNamespaces', 'maxPageSize', 'maxMetadataRows', 'maxEvidenceBytes',
      'maxHistoryPageBytes', 'maxHistoryItems', 'retention']) || typeof value.revision !== 'string' || !revisionSyntax.test(value.revision)) return rejected();
    const numeric = ['maxNamespaces', 'maxPageSize', 'maxMetadataRows', 'maxEvidenceBytes', 'maxHistoryPageBytes', 'maxHistoryItems'] as const;
    if (numeric.some(key => !positiveSafe(value[key])) || !isRecord(value.retention) ||
        !exactKeys(value.retention, ['evidenceMs', 'identityMs', 'auditMs'])) return rejected();
    const retention = value.retention;
    if (!positiveSafe(retention.evidenceMs) || !positiveSafe(retention.identityMs) || !positiveSafe(retention.auditMs) ||
        (value.maxNamespaces as number) > 16 || (value.maxPageSize as number) > 100 || (value.maxHistoryItems as number) > 20 ||
        (value.maxEvidenceBytes as number) > 16384 || retention.identityMs < retention.evidenceMs || retention.auditMs < retention.identityMs) return rejected();
    return Object.freeze({
      revision: value.revision, maxNamespaces: value.maxNamespaces as number, maxPageSize: value.maxPageSize as number,
      maxMetadataRows: value.maxMetadataRows as number, maxEvidenceBytes: value.maxEvidenceBytes as number,
      maxHistoryPageBytes: value.maxHistoryPageBytes as number, maxHistoryItems: value.maxHistoryItems as number,
      retention: Object.freeze({ evidenceMs: retention.evidenceMs, identityMs: retention.identityMs, auditMs: retention.auditMs }),
    });
  } catch { return rejected(); }
}

export const configurationNamespaceCount = (configuration: QualifiedPurchaseConfiguration, policy: QualifiedPurchasePolicy): void => {
  if (configuration.namespaces.length > policy.maxNamespaces) rejected();
};

/** Digest of every non-SQLite schema object: type, name, table and exact SQL. Matches the all-schema convention. */
export function allSchemaDigest(db: Sqlite): string {
  return evidenceDigest(db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all());
}

export type QualifiedStoreRecord = Readonly<{
  storeId: string; generation: string; predecessorDigest: string; extensionDigest: string;
  configuration: QualifiedPurchaseConfiguration; policy: QualifiedPurchasePolicy; configurationJson: string; policyJson: string;
}>;
type StoreRow = { singleton: number; schema_version: string; fixture_kind: string; store_id: string; generation: string;
  predecessor_digest: string; extension_digest: string; configuration_json: string; policy_json: string };

/** Reads and strictly validates the singleton store record. Any irregularity is unavailable, never repaired. */
export function readQualifiedStore(db: Sqlite): QualifiedStoreRecord {
  try {
    const rows = db.prepare('SELECT * FROM main.qualified_apple_store').all() as StoreRow[];
    const row = rows[0];
    if (rows.length !== 1 || !row || row.singleton !== 1 || row.schema_version !== QUALIFIED_SCHEMA_VERSION || row.fixture_kind !== 'isolated-synthetic' ||
        !identitySyntax.test(row.store_id) || !identitySyntax.test(row.generation) ||
        !hex64.test(row.predecessor_digest) || !hex64.test(row.extension_digest)) return unavailable();
    const configuration = validateQualifiedPurchaseConfiguration(JSON.parse(row.configuration_json));
    const policy = validateQualifiedPurchasePolicy(JSON.parse(row.policy_json));
    if (evidenceCanonical(configuration) !== row.configuration_json || evidenceCanonical(policy) !== row.policy_json) return unavailable();
    return Object.freeze({ storeId: row.store_id, generation: row.generation, predecessorDigest: row.predecessor_digest,
      extensionDigest: row.extension_digest, configuration, policy, configurationJson: row.configuration_json, policyJson: row.policy_json });
  } catch { return unavailable(); }
}
const unavailable = (): never => { throw new Error('qualified_store_unavailable'); };

/** Canonical owner binding. Qualified encodings are versioned and distinct from the Source27 codec. */
export function qualifiedOwnerBindingDigest(owner: Readonly<{ namespaceKey: string; originalTransactionId: string; accountId: string; appAccountToken: string }>): string {
  return evidenceDigest(['qualified-owner/v1', owner.namespaceKey, owner.originalTransactionId, owner.accountId, owner.appAccountToken]);
}
/** The original actor/session coordinates frozen into commands and reconciliations. */
export const qualifiedActorBinding = (actor: AccountContext): string =>
  evidenceCanonical({ accountId: actor.accountId, authUserId: actor.authUserId, sessionId: actor.sessionId, epoch: actor.epoch });
/** Original session binding for native delivery receipts. All four actor coordinates participate. */
export const qualifiedSessionDigest = (key: string, actor: AccountContext): string =>
  evidenceDigest(['qualified-session/v1', key, actor.accountId, actor.authUserId, actor.sessionId, actor.epoch]);

// These encodings bind synthetic evidence to one store, owner, request and continuity.
export const qualifiedContinuityDigest = (storeId: string, generation: string, schemaDigest: string): string =>
  evidenceDigest(['qualified-continuity/v1', storeId, generation, schemaDigest]);

export type QualifiedStatusBinding = {
  namespace_key: string; account_id: string; original_transaction_id: string; owner_binding_digest: string;
  request_id: string; lifecycle_epoch: number; database_generation: string; schema_digest: string; continuity_digest: string;
};
export const qualifiedStatusBinding = (storeId: string, row: QualifiedStatusBinding): string =>
  evidenceCanonical(['qualified-status-binding/v1', storeId, row.namespace_key, row.account_id, row.original_transaction_id,
    row.owner_binding_digest, row.request_id, row.lifecycle_epoch, row.database_generation, row.schema_digest, row.continuity_digest]);

export const qualifiedStatusContentDigest = (row: {
  observation_id: string; sequence: number; event_kind: string; event_key: string; observed_at_ms: number;
  binding_json: string; evidence_json: string; proof_transaction_id: string | null; proof_hash: string | null;
}): string => evidenceDigest(['qualified-status-content/v1', row.observation_id, row.sequence, row.event_kind, row.event_key,
  row.observed_at_ms, row.binding_json, row.evidence_json, row.proof_transaction_id, row.proof_hash]);

export const qualifiedProjectionReference = (observationId: string, contentDigest: string): string =>
  evidenceCanonical(['qualified-projection/v1', observationId, contentDigest]);

export type PurchaseAccessView = Readonly<{
  namespaceKey: string; namespace: PurchaseNamespace; actor: AccountContext; selectionGeneration: string;
  authority: Authority; sessionDigest: string; store: QualifiedStoreRecord; schemaDigest: string;
}>;
type Authority = Readonly<{ generation: string }>;
type Binding = {
  db: Sqlite; namespaceKey: string; namespace: PurchaseNamespace; actor: AccountContext; selectionGeneration: string;
  authority: Authority; storeId: string; generation: string; configurationRevision: string; policyRevision: string;
  schemaDigest: string; input: SyntheticAccessInput; active: () => boolean;
};
const contexts = new WeakMap<object, Binding>();
const authorities = new WeakMap<Sqlite, Authority>();

const actorSyntax = (actor: AccountContext): boolean =>
  isRecord(actor) && exactKeys(actor, ['accountId', 'authUserId', 'sessionId', 'epoch']) &&
  typeof actor.accountId === 'string' && accountUuid.test(actor.accountId) &&
  [actor.authUserId, actor.sessionId].every(value => typeof value === 'string' && value.length >= 1 && value.length <= 256) &&
  Number.isSafeInteger(actor.epoch) && actor.epoch >= 0;

/**
 * Synthetic issuer only. It models selected authority and independent account suppression for fixtures; a later
 * trusted composition must replace it. It grants no operational authority.
 */
export function createSyntheticPurchaseAccessAuthority(db: Sqlite, input: SyntheticAccessInput): SyntheticAccessIssuer {
  let store: QualifiedStoreRecord;
  try { store = readQualifiedStore(db); } catch { return refuse('store_unavailable'); }
  if (!input || input.use !== 'isolated-synthetic' || db.inTransaction || !db.open ||
      typeof input.currentSelection !== 'function' || typeof input.accountState !== 'function' || typeof input.currentness !== 'function' ||
      typeof input.authorityGeneration !== 'string' || !identitySyntax.test(input.authorityGeneration) ||
      input.storeId !== store.storeId || input.generation !== store.generation ||
      input.configurationRevision !== store.configuration.revision || input.policyRevision !== store.policy.revision) return refuse('context_unavailable');
  const schemaDigest = allSchemaDigest(db);
  const authority = Object.freeze({ generation: input.authorityGeneration });
  const capturedInput = Object.freeze({ ...input });
  authorities.set(db, authority);
  const active = () => authorities.get(db) === authority;
  const revoked = new WeakSet<object>();
  return Object.freeze({
    forOwner(actor: AccountContext): PurchaseAccessContext {
      if (!active() || !actorSyntax(actor)) return refuse('context_unavailable');
      const captured = Object.freeze({ accountId: actor.accountId, authUserId: actor.authUserId, sessionId: actor.sessionId, epoch: actor.epoch });
      const mapped = db.prepare('SELECT auth_user_id FROM main.form_accounts WHERE id=?').get(captured.accountId) as { auth_user_id: string } | undefined;
      if (!mapped || mapped.auth_user_id !== captured.authUserId) return refuse('account_unavailable');
      const state = readState(capturedInput, captured);
      if (state.suppressed || !state.current || state.epoch !== captured.epoch) return refuse('account_unavailable');
      const selection = readSelection(capturedInput, captured.accountId);
      const key = qualifiedNamespaceKey(selection.namespace);
      const configured = store.configuration.namespaces.find(item => qualifiedNamespaceKey(item.namespace) === key);
      if (!configured || configured.namespace.appAppleId !== selection.namespace.appAppleId) return refuse('selection_changed');
      if (!callbackTrue(capturedInput.currentness) || !active()) return refuse('context_unavailable');
      const context = Object.freeze(Object.create(null)) as PurchaseAccessContext;
      contexts.set(context, { db, namespaceKey: key, namespace: configured.namespace, actor: captured, selectionGeneration: selection.generation,
        authority, storeId: store.storeId, generation: store.generation,
        configurationRevision: store.configuration.revision, policyRevision: store.policy.revision, schemaDigest, input: capturedInput,
        active: () => active() && !revoked.has(context) });
      return context;
    },
    revoke(context: PurchaseAccessContext): void { if (context && typeof context === 'object') revoked.add(context); },
    close(): void { if (active()) authorities.delete(db); },
  });
}
function callbackTrue(callback: () => unknown): boolean {
  try { const value = callback(); return !thenable(value) && value === true; } catch { return false; }
}
function readState(input: SyntheticAccessInput, actor: AccountContext) {
  try {
    const state = input.accountState(actor.accountId) as unknown;
    if (thenable(state) || !isRecord(state) || !exactKeys(state, ['suppressed', 'epoch', 'current']) || typeof state.suppressed !== 'boolean' ||
        typeof state.current !== 'boolean' || !Number.isSafeInteger(state.epoch)) return refuse('account_unavailable');
    return state as { suppressed: boolean; epoch: number; current: boolean };
  } catch (error) { return error instanceof QualifiedRefusal ? refuse(error.code) : refuse('account_unavailable'); }
}
function readSelection(input: SyntheticAccessInput, accountId: string): { namespace: PurchaseNamespace; generation: string } {
  try {
    const selected = input.currentSelection(accountId) as unknown;
    // Exactly one namespace and generation; there is no fallback, union or environment inference.
    if (thenable(selected) || !isRecord(selected) || !exactKeys(selected, ['namespace', 'generation']) || !isRecord(selected.namespace) ||
        typeof selected.generation !== 'string' || !identitySyntax.test(selected.generation)) return refuse('selection_changed');
    const namespace = Object.freeze({ provider: selected.namespace.provider, bundleId: selected.namespace.bundleId,
      environment: selected.namespace.environment, appAppleId: selected.namespace.appAppleId }) as PurchaseNamespace;
    qualifiedNamespaceKey(namespace);
    return { namespace, generation: selected.generation };
  } catch (error) { return error instanceof QualifiedRefusal ? refuse(error.code) : refuse('selection_changed'); }
}

/**
 * Re-establishes that a context is still privately issued, current, selected and unsuppressed. Called before and
 * after every read. Any irregularity discards the entire result.
 */
export function checkPurchaseAccess(db: Sqlite, context: PurchaseAccessContext, expectedSchemaDigest: string): PurchaseAccessView {
  const binding = context !== null && typeof context === 'object' ? contexts.get(context) : undefined;
  if (!binding || binding.db !== db || !db.open || !binding.active()) return refuse('context_unavailable');
  let store: QualifiedStoreRecord;
  try { store = readQualifiedStore(db); } catch { return refuse('store_unavailable'); }
  const schemaDigest = allSchemaDigest(db);
  if (store.storeId !== binding.storeId || store.generation !== binding.generation || store.policy.revision !== binding.policyRevision ||
      store.configuration.revision !== binding.configurationRevision || schemaDigest !== binding.schemaDigest || schemaDigest !== expectedSchemaDigest) return refuse('store_unavailable');
  if (callbackTrue(binding.input.currentness) !== true) return refuse('context_unavailable');
  const mapped = db.prepare('SELECT auth_user_id FROM main.form_accounts WHERE id=?').get(binding.actor.accountId) as { auth_user_id: string } | undefined;
  if (!mapped || mapped.auth_user_id !== binding.actor.authUserId) return refuse('account_unavailable');
  const state = readState(binding.input, binding.actor);
  if (state.suppressed || !state.current || state.epoch !== binding.actor.epoch) return refuse('account_unavailable');
  const selection = readSelection(binding.input, binding.actor.accountId);
  if (qualifiedNamespaceKey(selection.namespace) !== binding.namespaceKey || selection.generation !== binding.selectionGeneration ||
      selection.namespace.appAppleId !== binding.namespace.appAppleId) return refuse('selection_changed');
  if (!binding.active()) return refuse('context_unavailable');
  return Object.freeze({ namespaceKey: binding.namespaceKey, namespace: binding.namespace, actor: binding.actor,
    selectionGeneration: binding.selectionGeneration, sessionDigest: qualifiedSessionDigest(binding.namespaceKey, binding.actor),
    authority: binding.authority, store, schemaDigest });
}

export { accountUuid, appleTransactionId };
