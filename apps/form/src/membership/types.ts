import type { Entitlements } from '../api/domain';
import type {
  StoreKitAccountBinding, StoreKitDeliveryOutcome, StoreKitDeliveryRequest,
  StoreKitProduct, StoreKitProof, StoreKitPurchaseResult, StoreKitTransactions,
} from '../native/storeKit.types';

export type MembershipStatus = 'unavailable' | 'products-loading' | 'products' | 'purchasing'
  | 'pending' | 'verifying' | 'active' | 'restore-running' | 'restore-none' | 'failed' | 'unknown';

export type MembershipState = {
  status: MembershipStatus;
  products: readonly StoreKitProduct[];
  entitlements: Entitlements | null;
  reason: string | null;
  canPurchase: boolean;
  canRestore: boolean;
  canRedeem: boolean;
  canCheckAgain: boolean;
};

export interface MembershipSession {
  account: StoreKitAccountBinding;
  generation: string;
  isCurrent(): boolean;
  readEntitlements(): Promise<Entitlements>;
  redeem(code: string, idempotencyKey: string): Promise<unknown>;
  /** Authenticate only as this captured account; never fall back to the current/new account. */
  deliver(request: StoreKitDeliveryRequest, proof: StoreKitProof): Promise<StoreKitDeliveryOutcome>;
}

export interface MembershipPorts {
  /** Synchronous tap-time capture. Callbacks must stay bound to this account and auth generation. */
  captureSession(): MembershipSession | null;
  configuration(): { purchases: 'configured' | 'unavailable'; promos: boolean };
  native: {
    products(): Promise<{ products: StoreKitProduct[]; missingProductIds: string[] }>;
    purchase(productId: string, appAccountToken: string): Promise<StoreKitPurchaseResult>;
    restore(): Promise<StoreKitTransactions>;
    currentEntitlements(): Promise<StoreKitTransactions>;
  };
  newIdempotencyKey(): string;
  openManageSubscriptions(): Promise<void>;
}

export type MembershipRecovery = {
  account: StoreKitAccountBinding;
  generation: string;
  purchase: 'pending' | 'unknown' | null;
  deliveries: { request: StoreKitDeliveryRequest; proof: StoreKitProof }[];
  promo: { code: string; idempotencyKey: string } | null;
};
