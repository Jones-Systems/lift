import type { NativeSubscription, NativeUnavailableReason } from './runtime';

export type StoreKitAvailability = {
  available: boolean;
  reason: 'available' | 'payments_disabled' | NativeUnavailableReason;
  configured: boolean;
};
export type StoreKitProduct = {
  id: string;
  displayName: string;
  description: string;
  displayPrice: string;
  price: string; // Decimal text; never convert prices to binary floating point for billing.
  currencyCode: string;
  type: string;
  subscriptionMetadata?: StoreKitSubscriptionMetadataV1;
};
export type StoreKitPeriod = Readonly<{ unit: 'day' | 'week' | 'month' | 'year'; value: number }>;
export type IntroOfferEligibility = 'eligible' | 'ineligible' | 'unknown' | 'unavailable';
export type StoreKitIntroductoryOffer =
  | Readonly<{ status: 'none' }>
  | Readonly<{ status: 'available'; paymentMode: 'free_trial' | 'pay_as_you_go' | 'pay_up_front';
      displayPrice: string; price: string; period: StoreKitPeriod; periodCount: number }>
  | Readonly<{ status: 'unavailable'; reason: 'unsupported_offer_type' | 'unsupported_payment_mode'
      | 'unsupported_period' | 'invalid_metadata' }>;
export type StoreKitSubscriptionMetadataV1 = Readonly<{ version: 1 }> & (
  | Readonly<{ status: 'available'; subscriptionGroupId: string; period: StoreKitPeriod;
      introductoryOffer: StoreKitIntroductoryOffer; introductoryOfferEligibility: IntroOfferEligibility }>
  | Readonly<{ status: 'not_applicable'; productKind: 'consumable' | 'non_consumable' | 'non_renewing_subscription' }>
  | Readonly<{ status: 'unavailable'; reason: 'legacy_bridge' | 'unsupported_version' | 'unsupported_product_type'
      | 'subscription_missing' | 'unsupported_period' | 'invalid_metadata' }>
);
export type StoreKitProductSnapshot = Readonly<Omit<StoreKitProduct, 'subscriptionMetadata'> & {
  subscriptionMetadata: StoreKitSubscriptionMetadataV1;
}>;
export type StoreKitProductsSnapshot = Readonly<{
  products: readonly StoreKitProductSnapshot[];
  missingProductIds: readonly string[];
}>;
export type StoreKitProof = {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  productType: string;
  appAccountToken: string | null;
  purchaseDateMs: number;
  expirationDateMs: number | null;
  revocationDateMs: number | null;
  localVerification: 'verified' | 'unverified';
  productAllowed: boolean;
  jwsRepresentation: string;
  source: 'purchase' | 'update' | 'entitlements' | 'unfinished';
};
export type StoreKitPurchaseResult =
  | { status: 'transaction'; transaction: StoreKitProof }
  | { status: 'pending' | 'cancelled' | 'unavailable'; productId: string }
  | { status: 'unknown'; productId: string; code?: string };
export type StoreKitFinishResult = { finished: true; transactionId: string; serverDeliveryId: string };
export type StoreKitTransactions = { transactions: StoreKitProof[]; truncated: boolean };
export interface FormStoreKitNative {
  availability(): Promise<StoreKitAvailability>;
  configure(productIds: string[]): Promise<{ configured: true }>;
  products(productIds: string[]): Promise<{ products: StoreKitProduct[]; missingProductIds: string[] }>;
  purchase(productId: string, appAccountToken: string): Promise<StoreKitPurchaseResult>;
  currentEntitlements(): Promise<StoreKitTransactions>;
  unfinishedTransactions(): Promise<StoreKitTransactions>;
  restore(): Promise<StoreKitTransactions>;
  startObserving(): Promise<{ observing: true }>;
  stopObserving(): Promise<{ observing: false }>;
  acknowledgeServerDelivery(transactionId: string, jws: string, serverDeliveryId: string): Promise<StoreKitFinishResult>;
  addListener(name: 'onTransaction', listener: (proof: StoreKitProof) => void): NativeSubscription;
  addListener(name: 'onError', listener: (error: { code: string; message: string }) => void): NativeSubscription;
}

/** Composition root supplies authenticated callbacks; native code never owns Form credentials. */
export type StoreKitAccountBinding = { accountId: string; appAccountToken: string };
export type StoreKitDeliveryRequest = {
  transactionId: string;
  productId: string;
  jwsRepresentation: string;
  idempotencyKey: string;
};
export type StoreKitServerDecision =
  | { status: 'delivered'; accountId: string; transactionId: string; productId: string; serverDeliveryId: string }
  | { status: 'rejected'; code: string }
  | { status: 'unknown'; code: string };
export interface AuthenticatedStoreKitDelivery {
  /** Read the active authenticated account. Token must be the server's stable account UUID. */
  currentAccount(): Promise<StoreKitAccountBinding | null>;
  /** Must authenticate, verify Apple JWS and durably deliver/deduplicate before returning delivered. */
  verifyAndDeliver(request: StoreKitDeliveryRequest, account: StoreKitAccountBinding): Promise<StoreKitServerDecision>;
}
export type StoreKitDeliveryOutcome =
  | { status: 'finished'; transactionId: string; serverDeliveryId: string }
  | { status: 'delivered_unfinished'; transactionId: string; serverDeliveryId: string; code: 'account_changed' | 'local_unverified' | 'finish_unknown' }
  | { status: 'rejected' | 'unknown'; code: string };
