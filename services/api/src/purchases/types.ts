export type AppleProductType = 'Auto-Renewable Subscription' | 'Non-Consumable' | 'Non-Renewing Subscription';
export type AppleProduct = { productId: string; type: AppleProductType; entitlement: 'form_plus' };
export type AppleSandboxConfiguration = { bundleId: string; products: readonly AppleProduct[]; environment?: 'Sandbox' };

export type AppleDeliveryRequest = {
  transactionId: string;
  productId: string;
  jwsRepresentation: string;
  idempotencyKey: string;
};
export type AppleDeliveryDecision =
  | { status: 'delivered'; accountId: string; transactionId: string; productId: string; serverDeliveryId: string }
  | { status: 'rejected'; code: string }
  | { status: 'unknown'; code: string };

/** Only the cryptographic adapter may establish these claims in runtime composition. */
export type VerifiedAppleTransaction = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  environment: string;
  productId: string;
  type: string;
  appAccountToken: string;
  inAppOwnershipType: string;
  purchaseDate: number;
  signedDate: number;
  quantity: number;
  expiresDate?: number;
  revocationDate?: number;
  revocationReason?: number;
  isUpgraded?: boolean;
};
export interface AppleTransactionVerifier {
  verify(jws: string): Promise<VerifiedAppleTransaction>;
}
export class AppleProofError extends Error {
  constructor(readonly code: string, readonly uncertain = false) { super(code); }
}
export type AppleEntitlementGrant = {
  id: string;
  entitlement: string;
  source: 'apple';
  sourceId: string;
  grantedAt: string;
  expiresAt: string | null;
  environment: 'Sandbox';
  active: boolean;
};
