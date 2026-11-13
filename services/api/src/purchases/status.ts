import { Status } from '@apple/app-store-server-library';
import { accountUuid, appleTransactionId, validateAppleConfiguration } from './configuration.js';
import { AppleProofError, type AppleSandboxConfiguration } from './types.js';
import type { AppleSubscriptionStatus, AppleSubscriptionStatusObservation, AppleSubscriptionStatusOutcome,
  AppleSubscriptionStatusPorts, PurchaseOwner } from './reconciliation.types.js';

const maxResponseBytes = 1_048_576;
const maxSignedBytes = 60_000;
const maxGroups = 20;
const maxItems = 100;
const transportTimeoutMs = 10_000;
type JsonRecord = Record<string, unknown>;
type Item = Readonly<{ group: string; original: string; status: AppleSubscriptionStatus; transaction: string; renewal: string }>;
class StatusReadError extends Error {}
class StatusTimeout extends Error {}
function fail(reason: string): never { throw new StatusReadError(reason); }
function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string { return typeof value === 'string' && appleTransactionId.test(value); }
function date(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function product(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(value); }
function only(value: JsonRecord, fields: readonly string[]): boolean { return Object.keys(value).every(key => fields.includes(key)); }
function jws(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maxSignedBytes && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/** Copy bounded JSON before awaits. Reject cycles, accessors, exotic values and unbounded decoded proofs too. */
function snapshot(value: unknown, limit: number, reason: string): unknown {
  let bytes = 0; let nodes = 0;
  const add = (count: number) => { bytes += count; if (bytes > limit) fail(reason); };
  const stringSize = (text: string) => {
    if (text.length > limit) fail(reason);
    return Buffer.byteLength(JSON.stringify(text), 'utf8');
  };
  const copy = (input: unknown, depth: number): unknown => {
    if (++nodes > 10_000 || depth > 12) fail(reason);
    if (input === null) { add(4); return null; }
    if (typeof input === 'string') { add(stringSize(input)); return input; }
    if (typeof input === 'boolean') { add(input ? 4 : 5); return input; }
    if (typeof input === 'number' && Number.isFinite(input)) { add(String(input).length); return input; }
    if (!input || typeof input !== 'object') return fail(reason);
    if (Array.isArray(input)) {
      if (input.length > maxItems || Object.keys(input).length !== input.length) fail(reason);
      add(2 + Math.max(0, input.length - 1));
      return Array.from({ length: input.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(input, String(index));
        if (!property || !('value' in property)) return fail(reason);
        return copy(property.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) fail(reason);
    const keys = Reflect.ownKeys(input);
    if (keys.length > 100) fail(reason);
    const output: JsonRecord = Object.create(null) as JsonRecord;
    add(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      if (typeof key !== 'string') return fail(reason);
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (!property || !property.enumerable || !('value' in property)) return fail(reason);
      add(stringSize(key) + 1); output[key] = copy(property.value, depth + 1);
    }
    return output;
  };
  return copy(value, 0);
}
function status(value: unknown): AppleSubscriptionStatus {
  switch (value) {
    case Status.ACTIVE: return 'active';
    case Status.EXPIRED: return 'expired';
    case Status.BILLING_RETRY: return 'billing_retry';
    case Status.BILLING_GRACE_PERIOD: return 'billing_grace_period';
    case Status.REVOKED: return 'revoked';
    default: return fail('apple_status_unknown');
  }
}
function ownerCopy(value: unknown): PurchaseOwner {
  if (!record(value) || typeof value.accountId !== 'string' || !accountUuid.test(value.accountId)
    || value.appAccountToken !== value.accountId || !id(value.originalTransactionId)
    || typeof value.bundleId !== 'string' || value.bundleId.length > 255 || value.environment !== 'Sandbox')
    return fail('apple_status_owner_invalid');
  return Object.freeze({ accountId: value.accountId, appAccountToken: value.appAccountToken as string,
    originalTransactionId: value.originalTransactionId, bundleId: value.bundleId, environment: 'Sandbox' });
}
function sameOwner(a: PurchaseOwner, b: PurchaseOwner): boolean {
  return a.accountId === b.accountId && a.appAccountToken === b.appAccountToken && a.originalTransactionId === b.originalTransactionId
    && a.bundleId === b.bundleId && a.environment === b.environment;
}
function unresolved(status: Exclude<AppleSubscriptionStatusOutcome['status'], 'observed'>, reason: string): AppleSubscriptionStatusOutcome {
  return Object.freeze({ status, observations: Object.freeze([]), reason });
}
const verifierReasons = new Set(['apple_jws_invalid', 'apple_claims_missing', 'apple_bundle_mismatch', 'apple_environment_mismatch',
  'apple_signature_invalid', 'apple_verification_unavailable', 'apple_verification_unknown']);

/** Trusted injection seam: composition supplies the existing offline Apple verifier and immutable-owner reader.
 * Reads evidence only, never writes purchase state or grants. No default client, route or runtime registration.
 */
export class AppleSubscriptionStatusReader {
  private readonly config: Readonly<Required<AppleSandboxConfiguration>>;
  private readonly ports: AppleSubscriptionStatusPorts;
  constructor(configuration: AppleSandboxConfiguration, ports: AppleSubscriptionStatusPorts) {
    this.config = validateAppleConfiguration(configuration);
    if (!Number.isSafeInteger(ports.appAppleId) || ports.appAppleId <= 0) throw new Error('Explicit Apple app ID required');
    this.ports = Object.freeze({ ...ports });
  }

  private installed(original: string): PurchaseOwner {
    const found = this.ports.owners.read(original);
    if (found === null) return fail('apple_status_owner_unresolved');
    const owner = ownerCopy(found);
    if (owner.originalTransactionId !== original || owner.bundleId !== this.config.bundleId) fail('apple_status_owner_mismatch');
    return owner;
  }

  private items(raw: unknown): Item[] {
    const response = snapshot(raw, maxResponseBytes, 'apple_status_response_invalid');
    if (!record(response) || Object.keys(response).length !== 4 || !only(response, ['environment', 'bundleId', 'appAppleId', 'data']))
      return fail('apple_status_response_invalid');
    if (response.bundleId !== this.config.bundleId || response.appAppleId !== this.ports.appAppleId) return fail('apple_status_application_mismatch');
    if (response.environment !== this.config.environment) return fail('apple_status_environment_mismatch');
    if (!Array.isArray(response.data) || response.data.length > maxGroups) return fail('apple_status_response_invalid');
    const items: Item[] = []; const groups = new Set<string>(); const originals = new Set<string>();
    for (const group of response.data) {
      if (!record(group) || !only(group, ['subscriptionGroupIdentifier', 'lastTransactions']) || !id(group.subscriptionGroupIdentifier)
        || groups.has(group.subscriptionGroupIdentifier) || !Array.isArray(group.lastTransactions) || group.lastTransactions.length > 20)
        return fail('apple_status_response_invalid');
      groups.add(group.subscriptionGroupIdentifier);
      for (const item of group.lastTransactions) {
        if (!record(item) || !only(item, ['status', 'originalTransactionId', 'signedTransactionInfo', 'signedRenewalInfo'])
          || !id(item.originalTransactionId) || originals.has(item.originalTransactionId)) return fail('apple_status_response_invalid');
        const normalized = status(item.status);
        if (!jws(item.signedTransactionInfo) || !jws(item.signedRenewalInfo)) return fail('apple_status_signed_payload_invalid');
        originals.add(item.originalTransactionId);
        items.push(Object.freeze({ group: group.subscriptionGroupIdentifier, original: item.originalTransactionId,
          status: normalized, transaction: item.signedTransactionInfo, renewal: item.signedRenewalInfo }));
        if (items.length > maxItems) return fail('apple_status_response_invalid');
      }
    }
    return items;
  }

  private observation(item: Item, owner: PurchaseOwner, tx: unknown, rn: unknown): AppleSubscriptionStatusObservation {
    if (!record(tx) || !id(tx.transactionId) || !id(tx.originalTransactionId) || !product(tx.productId)
      || tx.type !== 'Auto-Renewable Subscription' || tx.quantity !== 1
      || !date(tx.purchaseDate) || !date(tx.signedDate) || !date(tx.expiresDate) || tx.expiresDate < tx.purchaseDate
      || (tx.revocationDate !== undefined && !date(tx.revocationDate))
      || (tx.isUpgraded !== undefined && typeof tx.isUpgraded !== 'boolean')) return fail('apple_status_transaction_invalid');
    if (tx.inAppOwnershipType === 'FAMILY_SHARED') return fail('apple_status_family_policy_unavailable');
    if (tx.inAppOwnershipType !== 'PURCHASED') return fail('apple_status_ownership_invalid');
    if (tx.bundleId !== owner.bundleId) return fail('apple_status_application_mismatch');
    if (tx.environment !== owner.environment) return fail('apple_status_environment_mismatch');
    if (tx.originalTransactionId !== owner.originalTransactionId || tx.appAccountToken !== owner.appAccountToken
      || tx.subscriptionGroupIdentifier !== item.group) return fail('apple_status_owner_mismatch');
    if (!this.config.products.some(p => p.productId === tx.productId && p.type === tx.type)) return fail('apple_status_product_unavailable');
    if (!record(rn) || !id(rn.originalTransactionId) || !product(rn.productId) || !date(rn.signedDate)
      || (rn.autoRenewStatus !== 0 && rn.autoRenewStatus !== 1)
      || (rn.gracePeriodExpiresDate !== undefined && !date(rn.gracePeriodExpiresDate))
      || (rn.isInBillingRetryPeriod !== undefined && typeof rn.isInBillingRetryPeriod !== 'boolean')
      || (rn.autoRenewProductId !== undefined && !product(rn.autoRenewProductId))) return fail('apple_status_renewal_invalid');
    if (rn.environment !== owner.environment) return fail('apple_status_environment_mismatch');
    if (rn.originalTransactionId !== tx.originalTransactionId || rn.appAccountToken !== owner.appAccountToken || rn.productId !== tx.productId)
      return fail('apple_status_renewal_binding_mismatch');
    if (rn.autoRenewProductId !== undefined && !this.config.products.some(p => p.productId === rn.autoRenewProductId
      && p.type === 'Auto-Renewable Subscription')) return fail('apple_status_product_unavailable');
    return Object.freeze({ owner, subscriptionGroupIdentifier: item.group, status: item.status,
      transaction: Object.freeze({ transactionId: tx.transactionId, productId: tx.productId, purchaseDate: tx.purchaseDate,
        signedDate: tx.signedDate, expiresDate: tx.expiresDate, revocationDate: tx.revocationDate as number | undefined ?? null,
        isUpgraded: tx.isUpgraded as boolean | undefined ?? false }),
      renewal: Object.freeze({ productId: rn.productId, autoRenewProductId: rn.autoRenewProductId as string | undefined ?? null,
        signedDate: rn.signedDate, autoRenewStatus: rn.autoRenewStatus, gracePeriodExpiresDate: rn.gracePeriodExpiresDate as number | undefined ?? null,
        isInBillingRetryPeriod: rn.isInBillingRetryPeriod as boolean | undefined ?? null }) });
  }

  async read(assertedOwner: PurchaseOwner): Promise<AppleSubscriptionStatusOutcome> {
    try {
      const owner = ownerCopy(assertedOwner);
      if (!sameOwner(owner, this.installed(owner.originalTransactionId))) return fail('apple_status_owner_mismatch');
      if (!this.ports.transport) return unresolved('unavailable', 'apple_status_transport_unconfigured');
      let raw: unknown;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // A deadline bounds this read, not cancellation of the injected client's request. Late responses are discarded.
        raw = await Promise.race([this.ports.transport.statuses(owner.originalTransactionId), new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new StatusTimeout()), transportTimeoutMs);
        })]);
      }
      catch (error) {
        return unresolved('unknown', error instanceof StatusTimeout || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
          ? 'apple_status_transport_timeout' : 'apple_status_transport_unknown');
      }
      finally { if (timeout !== undefined) clearTimeout(timeout); }
      if (!sameOwner(owner, this.installed(owner.originalTransactionId))) return fail('apple_status_owner_changed');
      const items = this.items(raw);
      const bindings = new Map<string, PurchaseOwner>([[owner.originalTransactionId, owner]]);
      const observations: AppleSubscriptionStatusObservation[] = [];
      const transactionIds = new Set<string>();
      for (const item of items) {
        const bound = this.installed(item.original);
        if (item.original === owner.originalTransactionId && !sameOwner(bound, owner)) return fail('apple_status_owner_changed');
        bindings.set(item.original, bound);
        // Every nested signature is checked, including items that will be omitted from this owner's result.
        const tx = snapshot(await this.ports.verifier.verify(item.transaction), maxSignedBytes, 'apple_status_transaction_invalid');
        const renewal = snapshot(await this.ports.verifier.renewal(item.renewal), maxSignedBytes, 'apple_status_renewal_invalid');
        const observation = this.observation(item, bound, tx, renewal);
        if (transactionIds.has(observation.transaction.transactionId)) return fail('apple_status_transaction_conflict');
        transactionIds.add(observation.transaction.transactionId);
        if (sameOwner(bound, owner)) observations.push(observation);
      }
      for (const [original, binding] of bindings)
        if (!sameOwner(binding, this.installed(original))) return fail('apple_status_owner_changed');
      if (!observations.length) return unresolved('pending', items.length ? 'apple_status_owner_absent' : 'apple_status_empty');
      return Object.freeze({ status: 'observed', observations: Object.freeze(observations), reason: null });
    } catch (error) {
      if (error instanceof StatusReadError) return unresolved('rejected', error.message);
      if (error instanceof AppleProofError && verifierReasons.has(error.code))
        return unresolved(error.uncertain ? 'unknown' : 'rejected', error.code);
      return unresolved('unknown', 'apple_status_read_unknown');
    }
  }
}
