import { ApiError } from '../api/transport';
import type { FeatureSlotContext } from '../features/contract';
import type { MembershipPorts, MembershipSession } from '../membership/types';
import { isStoreKitAccountBinding, StoreKitDeliveryCoordinator } from '../native/storeKitDelivery';
import type { FormStoreKitNative, StoreKitDeliveryRequest, StoreKitServerDecision } from '../native/storeKit.types';

export type MembershipSessionOptions = {
  native?: Pick<FormStoreKitNative, 'products' | 'purchase' | 'restore' | 'currentEntitlements' | 'acknowledgeServerDelivery'>;
  allowedProductIds?: readonly string[];
  configured?: boolean;
  promos?: boolean;
  newIdempotencyKey?: () => string;
  openManageSubscriptions?: () => Promise<void>;
};

export function createMembershipSession(ctx: FeatureSlotContext, options: MembershipSessionOptions = {}) {
  let disposed = false;
  const api = ctx.resources.api;
  const auth = api.captureAuthContext();
  const isCurrentSession = ctx.isCurrentSession;
  const account = Object.freeze({ accountId: ctx.account.accountId, appAccountToken: ctx.account.appAccountToken });
  const generation = ctx.sessionGeneration;
  const current = () => !disposed && auth.isCurrent() && isCurrentSession();
  const changed = () => new ApiError(409, 'session_changed', 'The account session changed.');
  const requireCurrent = () => { if (!current()) throw changed(); };
  const unavailable = () => new ApiError(501, 'purchases_unavailable', 'Purchases are unavailable.');
  const resources = ctx.resources.boundTo(current);
  const native = options.native;
  const productIds = [...new Set(options.allowedProductIds ?? [])];
  const allowed = new Set(productIds);
  const configured = options.configured === true && !!native && productIds.length > 0;
  const promos = options.promos === true;
  const issueKey = options.newIdempotencyKey;
  const manage = options.openManageSubscriptions;
  const requireNative = () => {
    requireCurrent();
    if (!configured || !native) throw unavailable();
    return native;
  };
  const sameRequest = (left: StoreKitDeliveryRequest, right: StoreKitDeliveryRequest) =>
    left.transactionId === right.transactionId && left.productId === right.productId &&
    left.jwsRepresentation === right.jwsRepresentation && left.idempotencyKey === right.idempotencyKey;
  const coordinator = new StoreKitDeliveryCoordinator({
    acknowledgeServerDelivery(transactionId, jws, deliveryId) {
      return requireNative().acknowledgeServerDelivery(transactionId, jws, deliveryId);
    },
  }, {
    currentAccount: async () => current() ? account : null,
    async verifyAndDeliver(request, capturedAccount): Promise<StoreKitServerDecision> {
      if (!current()) return { status: 'rejected', code: 'session_changed' };
      if (capturedAccount.accountId !== account.accountId || capturedAccount.appAccountToken !== account.appAccountToken)
        return { status: 'rejected', code: 'account_token_mismatch' };
      if (!allowed.has(request.productId) || request.idempotencyKey !== `storekit-delivery:${request.transactionId}`)
        return { status: 'rejected', code: 'invalid_delivery_request' };
      const result = await api.request<unknown>('/v1/purchases/apple/verify', 'POST', request, request.idempotencyKey);
      if (!result || typeof result !== 'object') return { status: 'unknown', code: 'server_ack_mismatch' };
      const decision = result as Record<string, unknown>;
      if ((decision.status === 'unknown' || decision.status === 'rejected') && typeof decision.code === 'string' && decision.code)
        return { status: decision.status, code: decision.code };
      if (decision.status !== 'delivered' || decision.accountId !== account.accountId ||
        decision.transactionId !== request.transactionId || decision.productId !== request.productId ||
        typeof decision.serverDeliveryId !== 'string' || !decision.serverDeliveryId || decision.serverDeliveryId.length > 512)
        return { status: 'unknown', code: 'server_ack_mismatch' };
      return { status: 'delivered', accountId: account.accountId, transactionId: request.transactionId,
        productId: request.productId, serverDeliveryId: decision.serverDeliveryId };
    },
  }, productIds);
  const session = Object.freeze<MembershipSession>({
    account, generation, isCurrent: current,
    readEntitlements: () => resources.entitlements(),
    redeem: (code: string, key: string) => {
      requireCurrent();
      if (!promos) throw new ApiError(501, 'promos_unavailable', 'Promos are unavailable.');
      return resources.redeem(code, key);
    },
    async deliver(request, proof) {
      if (!current()) return { status: 'rejected', code: 'session_changed' };
      if (!configured) return { status: 'rejected', code: 'purchases_unavailable' };
      const snapshot = { ...proof };
      const expected = { transactionId: snapshot.transactionId, productId: snapshot.productId,
        jwsRepresentation: snapshot.jwsRepresentation, idempotencyKey: `storekit-delivery:${snapshot.transactionId}` };
      if (!sameRequest(request, expected)) return { status: 'rejected', code: 'invalid_delivery_request' };
      return coordinator.deliver(snapshot);
    },
  });
  const ports: MembershipPorts = {
    captureSession: () => current() && isStoreKitAccountBinding(account) ? session : null,
    configuration: () => ({ purchases: current() && configured ? 'configured' : 'unavailable', promos: current() && promos }),
    native: {
      async products() { return requireNative().products([...productIds]); },
      async purchase(productId, appAccountToken) {
        requireCurrent();
        if (!configured || !native) return { status: 'unavailable', productId };
        if (!allowed.has(productId)) throw new ApiError(422, 'product_not_allowed', 'The product is unavailable.');
        if (!isStoreKitAccountBinding(account) || appAccountToken !== account.appAccountToken)
          throw new ApiError(409, 'account_token_mismatch', 'The purchase account does not match.');
        return native.purchase(productId, account.appAccountToken);
      },
      async restore() { return requireNative().restore(); },
      async currentEntitlements() { return requireNative().currentEntitlements(); },
    },
    newIdempotencyKey() {
      requireCurrent();
      if (!issueKey) throw new ApiError(501, 'command_key_unavailable', 'A secure command key is unavailable.');
      return issueKey();
    },
    async openManageSubscriptions() {
      requireCurrent();
      if (!manage) throw new ApiError(501, 'subscription_management_unavailable', 'Subscription management is unavailable.');
      await manage();
    },
  };
  return { ports, dispose() { disposed = true; } };
}
