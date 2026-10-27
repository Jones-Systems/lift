import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

/** Shape validation and content identities only; no provenance, currentness or access authority. */
export const STATUS_CODEC_V1 = Object.freeze({
  binding: 'form.subscription-status.binding/v1',
  evidence: 'form.subscription-status.evidence/v1',
  projection: 'form.subscription-status.projection/v1',
} as const);

export const STATUS_CODEC_LIMITS = Object.freeze({
  bytes: 1_048_576, depth: 12, nodes: 10_000, stringBytes: 60_000,
  objectKeys: 32, items: 100, idBytes: 128, productIdBytes: 256,
});

export type StatusBindingV1 = Readonly<{
  version: typeof STATUS_CODEC_V1.binding;
  owner: Readonly<{
    accountId: string; appAccountToken: string; originalTransactionId: string;
    bundleId: string; environment: 'Sandbox';
  }>;
  authActorDigest: string; epoch: number; nativeStoreDigest: string; generation: string;
  schemaCohort: 'selected-subscription-status-27'; schemaDigest: string;
  authorityId: string; authoritySchema: string;
  suppression: Readonly<{ sequence: number; headDigest: string }>;
  continuity: Readonly<{
    revision: number; highWaterMs: number; digest: string; restoreBoundaryMs: number;
  }>;
}>;

type EvidenceBaseV1 = Readonly<{
  version: typeof STATUS_CODEC_V1.evidence; bindingId: string;
  originalTransactionId: string; requestId: string; recordedAtMs: number;
}>;
export type StatusDispatchV1 = EvidenceBaseV1 & Readonly<{
  kind: 'dispatch'; requestKeyDigest: string; capturedRevision: number;
  issuedAtMs: number; deadlineAtMs: number; rateWindowStartMs: number; rateOrdinal: number;
}>;
export type StatusObservationV1 = EvidenceBaseV1 & Readonly<{
  kind: 'status'; status: 'active' | 'expired' | 'billing_retry' | 'billing_grace_period' | 'revoked';
  subscriptionGroupIdentifier: string;
  transaction: Readonly<{
    transactionId: string; productId: string; purchaseDate: number; signedDate: number;
    expiresDate: number; revocationDate: number | null; isUpgraded: boolean;
  }>;
  renewal: Readonly<{
    productId: string; autoRenewProductId: string | null; signedDate: number;
    autoRenewStatus: 0 | 1; isInBillingRetryPeriod: boolean | null; gracePeriodExpiresDate: number | null;
  }>;
  transactionProofHash: string; renewalProofHash: string;
  providerResponseDigest: string; normalizedClaimDigest: string;
}>;
export type StatusInvalidationReasonV1 = 'head_changed' | 'signed_pair_changed' | 'ledger_changed'
  | 'history_changed' | 'notification_changed' | 'revoked' | 'upgraded' | 'refund_reversed';
export type StatusHistoryV1 = EvidenceBaseV1 & Readonly<{
  kind: 'history'; page: Readonly<{ handle: string; pageIndex: number; pageDigest: string }>;
  transactionProofHashes: readonly string[]; renewalProofHashes: readonly string[];
  reason: StatusInvalidationReasonV1;
}>;
export type StatusNotificationV1 = EvidenceBaseV1 & Readonly<{
  kind: 'notification'; notificationId: string; payloadDigest: string;
  transactionProofHashes: readonly string[]; renewalProofHashes: readonly string[];
  reason: StatusInvalidationReasonV1;
}>;
export type StatusReasonV1 = StatusInvalidationReasonV1 | 'observed' | 'empty' | 'invalid_evidence'
  | 'conflict' | 'stale' | 'held' | 'unavailable' | 'unknown' | 'cancelled' | 'capacity' | 'currentness_changed';
export type StatusOutcomeV1 = EvidenceBaseV1 & Readonly<{
  kind: 'outcome'; outcome: 'observed' | 'rejected' | 'unavailable' | 'unknown'; reason: StatusReasonV1;
  producerSettlement: 'settled_success' | 'settled_rejection' | 'settled_cancelled' | 'unproven';
  observationIds: readonly string[]; resultingRevision: number;
}>;
export type StatusEvidenceV1 = StatusDispatchV1 | StatusObservationV1 | StatusHistoryV1
  | StatusNotificationV1 | StatusOutcomeV1;
export type StatusProjectionV1 = Readonly<{
  version: typeof STATUS_CODEC_V1.projection; bindingId: string; originalTransactionId: string;
  revision: number; observationId: string | null; ledgerFingerprintDigest: string;
  result: 'held' | 'inactive' | 'active' | 'billing_grace_period'; reason: StatusReasonV1;
  validUntilMs: number | null; activeDispatchObservationId: string | null;
}>;

export class StatusCodecError extends Error {
  constructor() { super('Invalid subscription status record'); this.name = 'StatusCodecError'; }
}
const invalid = (): never => { throw new StatusCodecError(); };
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonRecord = { readonly [key: string]: Json };
type Rule = (value: Json) => boolean;
const isRecord = (v: Json): v is JsonRecord => v !== null && typeof v === 'object' && !Array.isArray(v);
const forbidden = (key: string) => key === '__proto__' || key === 'prototype' || key === 'constructor';

function validString(value: string): boolean {
  if (value.length > STATUS_CODEC_LIMITS.stringBytes) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return Buffer.byteLength(value, 'utf8') <= STATUS_CODEC_LIMITS.stringBytes;
}

/** Decode duplicate-aware JSON before any schema projection can discard unknown fields. */
function decodeJson(text: string): unknown {
  if (text.length > STATUS_CODEC_LIMITS.bytes || Buffer.byteLength(text, 'utf8') > STATUS_CODEC_LIMITS.bytes) invalid();
  let pos = 0;
  let nodes = 0;
  const space = () => { while (pos < text.length && /[ \t\r\n]/.test(text[pos]!)) pos++; };
  const quoted = (): string => {
    const start = pos++;
    if (text[start] !== '"') invalid();
    let escaped = false;
    while (pos < text.length) {
      const c = text[pos++];
      if (pos - start > STATUS_CODEC_LIMITS.stringBytes * 6 + 2) invalid();
      if (!escaped && c === '"') {
        let value: unknown;
        try { value = JSON.parse(text.slice(start, pos)); } catch { invalid(); }
        if (typeof value !== 'string' || !validString(value)) invalid();
        return value;
      }
      if (!escaped && c === '\\') escaped = true;
      else escaped = false;
    }
    return invalid();
  };
  const value = (depth: number): Json => {
    if (depth > STATUS_CODEC_LIMITS.depth || ++nodes > STATUS_CODEC_LIMITS.nodes) invalid();
    space();
    const c = text[pos];
    if (c === '"') return quoted();
    if (c === '{') {
      pos++; space();
      const record: Record<string, Json> = Object.create(null) as Record<string, Json>;
      const keys = new Set<string>();
      if (text[pos] === '}') { pos++; return record; }
      for (;;) {
        if (keys.size >= STATUS_CODEC_LIMITS.objectKeys || text[pos] !== '"') invalid();
        const key = quoted();
        if (forbidden(key) || keys.has(key)) invalid();
        keys.add(key); space();
        if (text[pos++] !== ':') invalid();
        record[key] = value(depth + 1); space();
        const end = text[pos++];
        if (end === '}') return record;
        if (end !== ',') invalid();
        space();
      }
    }
    if (c === '[') {
      pos++; space();
      const items: Json[] = [];
      if (text[pos] === ']') { pos++; return items; }
      for (;;) {
        if (items.length >= STATUS_CODEC_LIMITS.items) invalid();
        items.push(value(depth + 1)); space();
        const end = text[pos++];
        if (end === ']') return items;
        if (end !== ',') invalid();
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, pos)) { pos += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(pos));
    if (!match || !/^(?:0|[1-9][0-9]*)$/.test(match[0])) return invalid();
    pos += match[0].length;
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || number < 0 || Object.is(number, -0)) invalid();
    return number;
  };
  const result = value(1); space();
  if (pos !== text.length) invalid();
  return result;
}

function snapshot(input: unknown): Json {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const charge = (n: number) => { bytes += n; if (bytes > STATUS_CODEC_LIMITS.bytes) invalid(); };
  const copy = (v: unknown, depth: number): Json => {
    if (depth > STATUS_CODEC_LIMITS.depth || ++nodes > STATUS_CODEC_LIMITS.nodes) invalid();
    if (v === null || typeof v === 'boolean') { charge(v === null ? 4 : v ? 4 : 5); return v; }
    if (typeof v === 'string') {
      if (!validString(v)) invalid();
      charge(Buffer.byteLength(JSON.stringify(v)!, 'utf8')); return v;
    }
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) invalid();
      charge(String(v).length); return v;
    }
    if (typeof v !== 'object' || nodeTypes.isProxy(v) || seen.has(v)) return invalid();
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    if (array && (v as unknown[]).length > STATUS_CODEC_LIMITS.items) invalid();
    const keys = Reflect.ownKeys(v);
    if (keys.length > (array ? STATUS_CODEC_LIMITS.items + 1 : STATUS_CODEC_LIMITS.objectKeys)) invalid();
    seen.add(v); charge(2);
    const record: Record<string, Json> = Object.create(null) as Record<string, Json>;
    const items: Json[] = [];
    if (array && keys.length !== (v as unknown[]).length + 1) invalid();
    for (const key of keys) {
      if (typeof key !== 'string' || forbidden(key)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !('value' in descriptor)) invalid();
      if (array && key === 'length') continue;
      if (!descriptor.enumerable) invalid();
      if (array) {
        if (key !== String(items.length)) invalid();
        items.push(copy(descriptor.value, depth + 1)); charge(1);
      } else {
        if (!validString(key)) invalid();
        charge(Buffer.byteLength(JSON.stringify(key)!, 'utf8') + 2);
        record[key] = copy(descriptor.value, depth + 1);
      }
    }
    seen.delete(v);
    return array ? Object.freeze(items) : Object.freeze(record);
  };
  return copy(typeof input === 'string' ? decodeJson(input) : input, 1);
}

const literal = (expected: Json): Rule => v => v === expected;
const choice = (...values: readonly (string | number)[]): Rule => v => values.some(x => v === x);
const integer: Rule = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const date: Rule = v => integer(v) && (v as number) <= 8_640_000_000_000_000;
const bool: Rule = v => typeof v === 'boolean';
const nullable = (rule: Rule): Rule => v => v === null || rule(v);
const id: Rule = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const productId: Rule = v => typeof v === 'string' && v.length <= STATUS_CODEC_LIMITS.productIdBytes
  && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
const uuid: Rule = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const digest: Rule = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const list = (rule: Rule): Rule => v => Array.isArray(v) && v.length <= STATUS_CODEC_LIMITS.items
  && v.every(item => rule(item));
const uniqueDigests: Rule = v => list(digest)(v) && new Set(v as readonly string[]).size === (v as readonly string[]).length;
const record = (fields: Readonly<Record<string, Rule>>): Rule => v => isRecord(v)
  && Object.keys(v).length === Object.keys(fields).length
  && Object.entries(fields).every(([key, rule]) => Object.hasOwn(v, key) && rule(v[key]!));
const invalidationReason = choice('head_changed', 'signed_pair_changed', 'ledger_changed', 'history_changed',
  'notification_changed', 'revoked', 'upgraded', 'refund_reversed');
const reason: Rule = v => invalidationReason(v) || choice('observed', 'empty', 'invalid_evidence', 'conflict', 'stale',
  'held', 'unavailable', 'unknown', 'cancelled', 'capacity', 'currentness_changed')(v);
const bindingRule = record({
  version: literal(STATUS_CODEC_V1.binding),
  owner: record({ accountId: id, appAccountToken: uuid, originalTransactionId: id, bundleId: productId, environment: literal('Sandbox') }),
  authActorDigest: digest, epoch: integer, nativeStoreDigest: digest, generation: id,
  schemaCohort: literal('selected-subscription-status-27'), schemaDigest: digest, authorityId: id, authoritySchema: id,
  suppression: record({ sequence: integer, headDigest: digest }),
  continuity: record({ revision: integer, highWaterMs: date, digest, restoreBoundaryMs: date }),
});
const baseFields = {
  version: literal(STATUS_CODEC_V1.evidence), bindingId: digest, originalTransactionId: id, requestId: id, recordedAtMs: date,
};
const transactionRule = record({ transactionId: id, productId, purchaseDate: date, signedDate: date, expiresDate: date,
  revocationDate: nullable(date), isUpgraded: bool });
const renewalRule = record({ productId, autoRenewProductId: nullable(productId), signedDate: date,
  autoRenewStatus: choice(0, 1), isInBillingRetryPeriod: nullable(bool), gracePeriodExpiresDate: nullable(date) });
const evidenceRules: Readonly<Record<StatusEvidenceV1['kind'], Rule>> = Object.freeze({
  dispatch: record({ ...baseFields, kind: literal('dispatch'), requestKeyDigest: digest, capturedRevision: integer,
    issuedAtMs: date, deadlineAtMs: date, rateWindowStartMs: date, rateOrdinal: integer }),
  status: record({ ...baseFields, kind: literal('status'),
    status: choice('active', 'expired', 'billing_retry', 'billing_grace_period', 'revoked'), subscriptionGroupIdentifier: id,
    transaction: transactionRule, renewal: renewalRule, transactionProofHash: digest, renewalProofHash: digest,
    providerResponseDigest: digest, normalizedClaimDigest: digest }),
  history: record({ ...baseFields, kind: literal('history'), page: record({ handle: id, pageIndex: integer, pageDigest: digest }),
    transactionProofHashes: list(digest), renewalProofHashes: list(digest), reason: invalidationReason }),
  notification: record({ ...baseFields, kind: literal('notification'), notificationId: uuid, payloadDigest: digest,
    transactionProofHashes: list(digest), renewalProofHashes: list(digest), reason: invalidationReason }),
  outcome: record({ ...baseFields, kind: literal('outcome'), outcome: choice('observed', 'rejected', 'unavailable', 'unknown'),
    reason, producerSettlement: choice('settled_success', 'settled_rejection', 'settled_cancelled', 'unproven'),
    observationIds: uniqueDigests, resultingRevision: integer }),
});
const evidenceRule: Rule = v => isRecord(v) && typeof v.kind === 'string'
  && Object.hasOwn(evidenceRules, v.kind) && evidenceRules[v.kind as StatusEvidenceV1['kind']](v);
const projectionRule = record({
  version: literal(STATUS_CODEC_V1.projection), bindingId: digest, originalTransactionId: id, revision: integer,
  observationId: nullable(digest), ledgerFingerprintDigest: digest, result: choice('held', 'inactive', 'active', 'billing_grace_period'),
  reason, validUntilMs: nullable(date), activeDispatchObservationId: nullable(digest),
});
function parse<T>(input: unknown, rule: Rule): T {
  const value = snapshot(input);
  if (!rule(value)) invalid();
  return value as unknown as T;
}
export const parseStatusBindingV1 = (input: unknown): StatusBindingV1 => parse(input, bindingRule);
export const parseStatusEvidenceV1 = (input: unknown): StatusEvidenceV1 => parse(input, evidenceRule);
export const parseStatusProjectionV1 = (input: unknown): StatusProjectionV1 => parse(input, projectionRule);

/** Sorted exact keys, integer numbers and well-formed Unicode; no user hooks are invoked. */
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)!;
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const recordValue = value as JsonRecord;
  return '{' + Object.keys(recordValue).sort().map(key => JSON.stringify(key) + ':' + canonical(recordValue[key]!)).join(',') + '}';
}
export const serializeStatusBindingV1 = (input: unknown): string => canonical(parseStatusBindingV1(input) as unknown as Json);
export const serializeStatusEvidenceV1 = (input: unknown): string => canonical(parseStatusEvidenceV1(input) as unknown as Json);
export const serializeStatusProjectionV1 = (input: unknown): string => canonical(parseStatusProjectionV1(input) as unknown as Json);
const hash = (domain: string, text: string): string => createHash('sha256').update(domain, 'utf8').update('\0').update(text, 'utf8').digest('hex');
export const statusBindingIdV1 = (input: unknown): string => hash('form.subscription-status/binding/v1', serializeStatusBindingV1(input));
export function statusEvidenceIdV1(input: unknown): string {
  const value = parseStatusEvidenceV1(input);
  return hash('form.subscription-status/' + value.kind + '/v1', canonical(value as unknown as Json));
}
export const statusProjectionIdV1 = (input: unknown): string => hash('form.subscription-status/projection/v1', serializeStatusProjectionV1(input));

export type StatusOrderRelationV1 = 'replay' | 'newer' | 'older' | 'ambiguous' | 'conflict' | 'held';
export type StatusOrderV1 = Readonly<{
  relation: StatusOrderRelationV1;
  reason: 'same_fact' | 'purchase_chronology' | 'equal_purchase_heads' | 'signed_pair' | 'incomparable_signed_pair'
    | 'equal_version_contradiction' | 'immutable_head_changed' | 'binding_or_lineage_mismatch' | 'sticky_denial';
}>;
const order = (relation: StatusOrderRelationV1, reason: StatusOrderV1['reason']): StatusOrderV1 => Object.freeze({ relation, reason });
function observation(input: unknown): StatusObservationV1 {
  const value = parseStatusEvidenceV1(input);
  if (value.kind !== 'status') return invalid();
  return value;
}
const same = (a: unknown, b: unknown): boolean => canonical(a as Json) === canonical(b as Json);

function compare(current: StatusObservationV1, candidate: StatusObservationV1): StatusOrderV1 {
  if (current.bindingId !== candidate.bindingId || current.originalTransactionId !== candidate.originalTransactionId) {
    return order('held', 'binding_or_lineage_mismatch');
  }
  const a = current.transaction;
  const b = candidate.transaction;
  if (a.transactionId !== b.transactionId) {
    if (a.purchaseDate === b.purchaseDate) return order('ambiguous', 'equal_purchase_heads');
    return order(b.purchaseDate > a.purchaseDate ? 'newer' : 'older', 'purchase_chronology');
  }
  if (a.purchaseDate !== b.purchaseDate || a.productId !== b.productId
    || current.subscriptionGroupIdentifier !== candidate.subscriptionGroupIdentifier) return order('conflict', 'immutable_head_changed');
  const txEqual = a.signedDate === b.signedDate;
  const renewalEqual = current.renewal.signedDate === candidate.renewal.signedDate;
  if ((txEqual && (!same(a, b) || current.transactionProofHash !== candidate.transactionProofHash))
    || (renewalEqual && (!same(current.renewal, candidate.renewal) || current.renewalProofHash !== candidate.renewalProofHash))) {
    return order('conflict', 'equal_version_contradiction');
  }
  if (txEqual && renewalEqual) {
    if (current.status !== candidate.status || current.normalizedClaimDigest !== candidate.normalizedClaimDigest
      || current.providerResponseDigest !== candidate.providerResponseDigest) {
      return order('conflict', 'equal_version_contradiction');
    }
    return order('replay', 'same_fact');
  }
  const newer = b.signedDate >= a.signedDate && candidate.renewal.signedDate >= current.renewal.signedDate;
  const older = b.signedDate <= a.signedDate && candidate.renewal.signedDate <= current.renewal.signedDate;
  if (!newer && !older) return order('held', 'incomparable_signed_pair');
  const earlier = newer ? a : b;
  const later = newer ? b : a;
  if ((earlier.revocationDate !== null && later.revocationDate !== earlier.revocationDate)
    || (earlier.isUpgraded && !later.isUpgraded)) return order('conflict', 'sticky_denial');
  return order(newer ? 'newer' : 'older', 'signed_pair');
}

/** Candidate relative to current. Request/receipt/response identities cannot resolve signed contradictions. */
export function compareStatusEvidenceV1(current: unknown, candidate: unknown): StatusOrderV1 {
  return compare(observation(current), observation(candidate));
}
export type StatusReductionV1 = Readonly<{
  state: 'selected' | 'empty' | 'ambiguous' | 'conflict' | 'held';
  head: StatusObservationV1 | null; stickyRevoked: boolean; stickyUpgraded: boolean;
}>;

/** Bounded single-lineage reduction. A selected head is evidence, never an entitlement decision. */
export function reduceStatusEvidenceV1(input: unknown): StatusReductionV1 {
  const values = snapshot(input);
  if (!Array.isArray(values)) return invalid();
  const observations = values.map(value => observation(value));
  const result = (state: StatusReductionV1['state'], head: StatusObservationV1 | null,
    facts: readonly StatusObservationV1[] = []): StatusReductionV1 => Object.freeze({ state, head,
    stickyRevoked: facts.some(value => value.transaction.revocationDate !== null),
    stickyUpgraded: facts.some(value => value.transaction.isUpgraded) });
  const first = observations[0];
  if (!first) return result('empty', null);
  if (observations.some(value => value.bindingId !== first.bindingId || value.originalTransactionId !== first.originalTransactionId)) {
    return result('held', null);
  }
  const immutableHeads = new Map<string, string>();
  for (const value of observations) {
    const identity = canonical([value.transaction.purchaseDate, value.transaction.productId, value.subscriptionGroupIdentifier]);
    const previous = immutableHeads.get(value.transaction.transactionId);
    if (previous !== undefined && previous !== identity) return result('conflict', null, observations);
    immutableHeads.set(value.transaction.transactionId, identity);
  }
  const latestPurchase = Math.max(...observations.map(value => value.transaction.purchaseDate));
  const heads = observations.filter(value => value.transaction.purchaseDate === latestPurchase);
  if (new Set(heads.map(value => value.transaction.transactionId)).size !== 1) return result('ambiguous', null, heads);
  // Preserve every contradiction at the latest head, even if a third vector dominates both facts.
  let conflict = false;
  let held = false;
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const relation = compare(heads[i]!, heads[j]!).relation;
      conflict ||= relation === 'conflict';
      held ||= relation === 'held';
    }
  }
  if (conflict) return result('conflict', null, heads);
  if (held) return result('held', null, heads);
  let head = heads[0]!;
  for (const candidate of heads.slice(1)) {
    if (compare(head, candidate).relation === 'newer') head = candidate;
  }
  return result('selected', head, heads);
}
