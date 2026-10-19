import { bindFormNativeModule, FormNativeError } from './runtime';
import type { NativeBinding, NativeSubscription } from './runtime';
import { isStoreKitAccountBinding, StoreKitDeliveryCoordinator } from './storeKitDelivery';
import type { AuthenticatedStoreKitDelivery, FormStoreKitNative, StoreKitAvailability, StoreKitProof, StoreKitPurchaseResult } from './storeKit.types';

export type * from './storeKit.types';
export { StoreKitDeliveryCoordinator } from './storeKitDelivery';

export async function getStoreKitAvailability(): Promise<StoreKitAvailability> {
  const binding = bindFormNativeModule<FormStoreKitNative>('FormStoreKit');
  if (!binding.module) return { available: false, reason: binding.reason, configured: false };
  try { return await binding.module.availability(); }
  catch { return { available: false, reason: 'native_probe_failed', configured: false }; }
}

export class FormStoreKitAdapter {
  private readonly binding: NativeBinding<FormStoreKitNative>;
  private readonly delivery: AuthenticatedStoreKitDelivery;
  private coordinator: StoreKitDeliveryCoordinator | null = null;
  private allowedProducts = new Set<string>();
  private updateSubscription: NativeSubscription | null = null;
  private disposed = false;
  private purchasing = false;

  constructor(delivery: AuthenticatedStoreKitDelivery, binding = bindFormNativeModule<FormStoreKitNative>('FormStoreKit')) {
    this.delivery = delivery;
    this.binding = binding;
  }

  async configure(allowedProductIds: readonly string[]): Promise<void> {
    if (this.coordinator) throw new FormNativeError('already_configured', 'Create one adapter per authenticated session and allowlist.');
    if (!allowedProductIds.length || allowedProductIds.length > 32 || new Set(allowedProductIds).size !== allowedProductIds.length
      || allowedProductIds.some(id => !id || id.length > 200 || /\s/.test(id))) {
      throw new FormNativeError('invalid_products', 'Configure 1–32 unique product identifiers.');
    }
    await this.native().configure([...allowedProductIds]);
    this.allowedProducts = new Set(allowedProductIds);
    this.coordinator = new StoreKitDeliveryCoordinator(this.native(), this.delivery, allowedProductIds);
  }

  products() { this.configured(); return this.native().products([...this.allowedProducts]); }
  currentEntitlements() { this.configured(); return this.native().currentEntitlements(); }
  unfinishedTransactions() { this.configured(); return this.native().unfinishedTransactions(); }
  restore() { this.configured(); return this.native().restore(); }

  async purchase(productId: string): Promise<StoreKitPurchaseResult> {
    this.configured();
    if (!this.allowedProducts.has(productId)) throw new FormNativeError('product_not_allowed', 'Product is not configured.');
    if (this.purchasing) throw new FormNativeError('busy', 'Another purchase is in progress.');
    this.purchasing = true;
    try {
      const account = await this.delivery.currentAccount();
      if (!isStoreKitAccountBinding(account)) throw new FormNativeError('authentication_required', 'An authenticated account token is required.');
      const native = this.native();
      try { return await native.purchase(productId, account.appAccountToken); }
      catch { return { status: 'unknown', productId, code: 'purchase_effect_unknown' }; }
    } finally { this.purchasing = false; }
  }

  /** Receiving a transaction does not submit it, apply an entitlement or finish it. */
  async observeTransactions(listener: (proof: StoreKitProof) => void): Promise<NativeSubscription> {
    this.configured();
    if (this.updateSubscription) throw new FormNativeError('already_observing', 'One transaction observer is already attached.');
    const native = this.native();
    const subscription = native.addListener('onTransaction', listener);
    this.updateSubscription = subscription;
    try { await native.startObserving(); }
    catch (error) { subscription.remove(); this.updateSubscription = null; throw error; }
    return { remove: () => {
      subscription.remove();
      // Keep Apple's update stream alive until dispose; a later observer also reconciles unfinished transactions.
      if (this.updateSubscription === subscription) this.updateSubscription = null;
    } };
  }

  deliver(proof: StoreKitProof) { this.configured(); return this.coordinator!.deliver(proof); }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.updateSubscription?.remove();
    this.updateSubscription = null;
    if (this.binding.module) await this.binding.module.stopObserving();
  }

  private configured(): void {
    this.native();
    if (!this.coordinator) throw new FormNativeError('products_unconfigured', 'Allowed products must be configured first.');
  }
  private native(): FormStoreKitNative {
    if (this.disposed) throw new FormNativeError('module_destroyed', 'StoreKit adapter was disposed.');
    if (!this.binding.module) throw new FormNativeError(this.binding.reason, 'Form StoreKit requires a native iOS build.');
    return this.binding.module;
  }
}
