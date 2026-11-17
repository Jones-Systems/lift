import type {
  IntroOfferEligibility, StoreKitIntroductoryOffer, StoreKitPeriod, StoreKitProductSnapshot,
  StoreKitProductsSnapshot, StoreKitSubscriptionMetadataV1,
} from './storeKit.types';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 16384): value is string =>
  typeof value === 'string' && value.length <= limit && value.trim().length > 0;
const identifier = (value: unknown): value is string => text(value, 200) && !/\s/.test(value);
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && /^\d+(?:\.\d+)?$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const unavailable = (reason: Extract<StoreKitSubscriptionMetadataV1, { status: 'unavailable' }>['reason']): StoreKitSubscriptionMetadataV1 =>
  ({ version: 1, status: 'unavailable', reason });

export class StoreKitProductsError extends Error {
  readonly code = 'invalid_products';
  constructor() { super('Invalid StoreKit product catalog or requested identifiers.'); }
}

export function copyStoreKitProductIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new StoreKitProductsError();
  const result: string[] = [];
  for (const id of value) {
    if (!identifier(id) || result.includes(id)) throw new StoreKitProductsError();
    result.push(id);
  }
  return result;
}

function period(value: unknown): StoreKitPeriod | null {
  if (!record(value) || !positive(value.value)) return null;
  switch (value.unit) {
    case 'day': case 'week': case 'month': case 'year': return { unit: value.unit, value: value.value };
    default: return null;
  }
}

function offer(value: unknown): StoreKitIntroductoryOffer | null {
  if (!record(value)) return null;
  if (value.status === 'none') return { status: 'none' };
  if (value.status === 'unavailable') {
    switch (value.reason) {
      case 'unsupported_offer_type': case 'unsupported_payment_mode': case 'unsupported_period': case 'invalid_metadata':
        return { status: 'unavailable', reason: value.reason };
      default: return null;
    }
  }
  if (value.status !== 'available' || !text(value.displayPrice) || !decimal(value.price) || !positive(value.periodCount)) return null;
  const term = period(value.period);
  if (!term) return null;
  switch (value.paymentMode) {
    case 'free_trial':
      if (!/^0+(?:\.0+)?$/.test(value.price) || value.periodCount !== 1) return null;
      break;
    case 'pay_up_front': if (value.periodCount !== 1) return null; break;
    case 'pay_as_you_go': break;
    default: return null;
  }
  return { status: 'available', paymentMode: value.paymentMode, displayPrice: value.displayPrice,
    price: value.price, period: term, periodCount: value.periodCount };
}

function metadata(value: unknown): StoreKitSubscriptionMetadataV1 {
  if (value === undefined) return unavailable('legacy_bridge');
  if (!record(value)) return unavailable('invalid_metadata');
  if (positive(value.version) && value.version !== 1) return unavailable('unsupported_version');
  if (value.version !== 1) return unavailable('invalid_metadata');
  if (value.status === 'unavailable') {
    switch (value.reason) {
      case 'legacy_bridge': case 'unsupported_version': case 'unsupported_product_type':
      case 'subscription_missing': case 'unsupported_period': case 'invalid_metadata': return unavailable(value.reason);
      default: return unavailable('invalid_metadata');
    }
  }
  if (value.status === 'not_applicable') {
    switch (value.productKind) {
      case 'consumable': case 'non_consumable': case 'non_renewing_subscription':
        return { version: 1, status: 'not_applicable', productKind: value.productKind };
      default: return unavailable('invalid_metadata');
    }
  }
  if (value.status !== 'available' || !text(value.subscriptionGroupId, 200)) return unavailable('invalid_metadata');
  const term = period(value.period), introductoryOffer = offer(value.introductoryOffer);
  const eligibility = value.introductoryOfferEligibility;
  if (!term || !introductoryOffer || !(['eligible', 'ineligible', 'unknown', 'unavailable'] as unknown[]).includes(eligibility))
    return unavailable('invalid_metadata');
  return { version: 1, status: 'available', subscriptionGroupId: value.subscriptionGroupId, period: term,
    introductoryOffer, introductoryOfferEligibility: eligibility as IntroOfferEligibility };
}

export function copyStoreKitProduct(product: StoreKitProductSnapshot): StoreKitProductSnapshot {
  const snapshot = product.subscriptionMetadata;
  return { ...product, subscriptionMetadata: snapshot.status === 'available'
    ? { ...snapshot, period: { ...snapshot.period }, introductoryOffer: snapshot.introductoryOffer.status === 'available'
      ? { ...snapshot.introductoryOffer, period: { ...snapshot.introductoryOffer.period } } : { ...snapshot.introductoryOffer } }
    : { ...snapshot } };
}

export function decodeStoreKitProduct(product: unknown): StoreKitProductSnapshot {
  if (!record(product) || !identifier(product.id) || !text(product.displayName) || !text(product.description) || !text(product.displayPrice)
    || !decimal(product.price) || typeof product.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(product.currencyCode)
    || !text(product.type, 200)) throw new StoreKitProductsError();
  return { id: product.id, displayName: product.displayName, description: product.description,
    displayPrice: product.displayPrice, price: product.price, currencyCode: product.currencyCode, type: product.type,
    subscriptionMetadata: metadata(product.subscriptionMetadata) };
}

/** Validate one whole result against the original request, without inferring facts from raw product types. */
export function decodeStoreKitProducts(value: unknown, requestedProductIds: readonly string[]): StoreKitProductsSnapshot {
  const requested = new Set(copyStoreKitProductIds(requestedProductIds));
  if (!record(value) || !Array.isArray(value.products) || !Array.isArray(value.missingProductIds)
    || value.products.length > 32 || value.missingProductIds.length > 32) throw new StoreKitProductsError();
  const seen = new Set<string>();
  const accept = (id: unknown): string => {
    if (!identifier(id) || !requested.has(id) || seen.has(id)) throw new StoreKitProductsError();
    seen.add(id);
    return id;
  };
  const products: StoreKitProductSnapshot[] = [];
  for (const product of value.products) {
    const snapshot = decodeStoreKitProduct(product);
    accept(snapshot.id);
    products.push(snapshot);
  }
  const missingProductIds: string[] = [];
  for (const id of value.missingProductIds) missingProductIds.push(accept(id));
  if (seen.size !== requested.size) throw new StoreKitProductsError();
  return { products, missingProductIds };
}
