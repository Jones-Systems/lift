import type {
  AuthenticatedStoreKitDelivery, FormStoreKitNative, StoreKitAccountBinding,
  StoreKitDeliveryOutcome, StoreKitProof,
  StoreKitServerDecision,
} from './storeKit.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isStoreKitAccountBinding(account: StoreKitAccountBinding | null): account is StoreKitAccountBinding {
  return !!account && typeof account.accountId === 'string' && !!account.accountId
    && typeof account.appAccountToken === 'string' && UUID.test(account.appAccountToken);
}

/** Explicit delivery only; no auto-replay after ambiguous server or purchase effects. */
export class StoreKitDeliveryCoordinator {
  private readonly native: Pick<FormStoreKitNative, 'acknowledgeServerDelivery'>;
  private readonly delivery: AuthenticatedStoreKitDelivery;
  private readonly allowedProducts: ReadonlySet<string>;
  private readonly inFlight = new Map<string, { jws: string; operation: Promise<StoreKitDeliveryOutcome> }>();

  constructor(native: Pick<FormStoreKitNative, 'acknowledgeServerDelivery'>, delivery: AuthenticatedStoreKitDelivery, allowedProductIds: readonly string[]) {
    this.native = native;
    this.delivery = delivery;
    this.allowedProducts = new Set(allowedProductIds);
  }

  deliver(proof: StoreKitProof): Promise<StoreKitDeliveryOutcome> {
    if (!this.validProof(proof)) return Promise.resolve({ status: 'rejected', code: 'invalid_transaction_proof' });
    if (!this.allowedProducts.has(proof.productId)) return Promise.resolve({ status: 'rejected', code: 'product_not_allowed' });
    const existing = this.inFlight.get(proof.transactionId);
    if (existing) {
      return existing.jws === proof.jwsRepresentation ? existing.operation : Promise.resolve({ status: 'unknown', code: 'transaction_changed_during_delivery' });
    }
    // Copy before the first await so a caller cannot mutate the acknowledgment binding.
    const snapshot = { ...proof };
    const operation = this.deliverOnce(snapshot).finally(() => { this.inFlight.delete(snapshot.transactionId); });
    this.inFlight.set(snapshot.transactionId, { jws: snapshot.jwsRepresentation, operation });
    return operation;
  }

  private validProof(proof: StoreKitProof): boolean {
    return /^\d{1,20}$/.test(proof.transactionId) && !!proof.productId && proof.productId.length <= 200
      && typeof proof.jwsRepresentation === 'string' && proof.jwsRepresentation.length > 0 && proof.jwsRepresentation.length <= 65536
      && ['verified', 'unverified'].includes(proof.localVerification)
      && (proof.appAccountToken === null || (typeof proof.appAccountToken === 'string' && UUID.test(proof.appAccountToken)));
  }

  private async deliverOnce(proof: StoreKitProof): Promise<StoreKitDeliveryOutcome> {
    let active: StoreKitAccountBinding | null;
    try { active = await this.delivery.currentAccount(); }
    catch { return { status: 'unknown', code: 'account_state_unknown' }; }
    if (!isStoreKitAccountBinding(active)) return { status: 'rejected', code: 'authentication_required' };
    const account = { ...active };
    if (proof.appAccountToken && proof.appAccountToken.toLowerCase() !== account.appAccountToken.toLowerCase()) {
      return { status: 'rejected', code: 'account_token_mismatch' };
    }
    // AppAccountToken may be absent on historical transactions; server decides account binding.
    // Locally verified is only device evidence, never a paid/entitled flag.
    let decision: StoreKitServerDecision;
    try {
      decision = await this.delivery.verifyAndDeliver({
        transactionId: proof.transactionId, productId: proof.productId, jwsRepresentation: proof.jwsRepresentation,
        idempotencyKey: `storekit-delivery:${proof.transactionId}`,
      }, { ...account });
    } catch { return { status: 'unknown', code: 'server_effect_unknown' }; }
    if (!decision || !['delivered', 'rejected', 'unknown'].includes(decision.status)) return { status: 'unknown', code: 'server_ack_mismatch' };
    if (decision.status !== 'delivered') {
      return typeof decision.code === 'string' && !!decision.code ? decision : { status: 'unknown', code: 'server_ack_mismatch' };
    }
    if (decision.accountId !== account.accountId || decision.transactionId !== proof.transactionId || decision.productId !== proof.productId
      || typeof decision.serverDeliveryId !== 'string' || !decision.serverDeliveryId || decision.serverDeliveryId.length > 512) {
      return { status: 'unknown', code: 'server_ack_mismatch' };
    }
    const delivered = { transactionId: proof.transactionId, serverDeliveryId: decision.serverDeliveryId };
    let current: StoreKitAccountBinding | null;
    try { current = await this.delivery.currentAccount(); }
    catch { current = null; }
    if (!isStoreKitAccountBinding(current) || current.accountId !== account.accountId || current.appAccountToken.toLowerCase() !== account.appAccountToken.toLowerCase()) {
      return { ...delivered, status: 'delivered_unfinished', code: 'account_changed' };
    }
    if (proof.localVerification !== 'verified') return { ...delivered, status: 'delivered_unfinished', code: 'local_unverified' };
    try {
      const finished = await this.native.acknowledgeServerDelivery(proof.transactionId, proof.jwsRepresentation, decision.serverDeliveryId);
      if (finished.finished !== true || finished.transactionId !== proof.transactionId || finished.serverDeliveryId !== decision.serverDeliveryId) {
        return { ...delivered, status: 'delivered_unfinished', code: 'finish_unknown' };
      }
      return { ...delivered, status: 'finished' };
    } catch { return { ...delivered, status: 'delivered_unfinished', code: 'finish_unknown' }; }
  }
}
