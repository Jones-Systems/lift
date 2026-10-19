import type { Entitlements } from '../api/domain';
import type { StoreKitProduct, StoreKitProof, StoreKitTransactions } from '../native/storeKit.types';
import type { MembershipPorts, MembershipRecovery, MembershipSession, MembershipState, MembershipStatus } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hidden = (reason: string): MembershipState => ({ status: 'unavailable', products: [], entitlements: null,
  reason, canPurchase: false, canRestore: false, canRedeem: false, canCheckAgain: false });
const copyEntitlements = (value: Entitlements): Entitlements => ({ ...value,
  active: [...value.active], grants: value.grants.map(grant => ({ ...grant })), purchases: { ...value.purchases } });

export class MembershipController {
  private readonly ports: MembershipPorts;
  private readonly owner: MembershipSession | null;
  private state: MembershipState = hidden('not_loaded');
  private readonly listeners = new Set<() => void>();
  private busy = false;
  private disposed = false;
  private products: StoreKitProduct[] = [];
  private entitlements: Entitlements | null = null;
  private purchaseEffect: MembershipRecovery['purchase'] = null;
  private readonly deliveries = new Map<string, MembershipRecovery['deliveries'][number]>();
  private promo: MembershipRecovery['promo'] = null;
  private deliveryFailure: string | null = null;

  constructor(ports: MembershipPorts) {
    this.ports = ports;
    this.owner = this.capture();
  }

  getState(): MembershipState {
    if (!this.current()) return hidden(this.disposed ? 'disposed' : this.owner ? 'session_changed' : 'authentication_required');
    return { ...this.state, products: this.state.products.map(product => ({ ...product })),
      entitlements: this.state.entitlements ? copyEntitlements(this.state.entitlements) : null };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Keeps reconciliation material in memory; callers must not render, log or persist these receipts. */
  getRecovery(): MembershipRecovery | null {
    if (!this.owner) return null;
    return { account: { ...this.owner.account }, generation: this.owner.generation,
      purchase: this.purchaseEffect, deliveries: [...this.deliveries.values()].map(item => ({
        request: { ...item.request }, proof: { ...item.proof },
      })), promo: this.promo ? { ...this.promo } : null };
  }

  async load(): Promise<void> {
    const session = this.begin();
    if (!session) return;
    try {
      this.publish('products-loading');
      await this.read(session);
      if (!session.isCurrent()) return;
      if (this.configured()) {
        const result = await this.ports.native.products();
        this.products = result.products.map(product => ({ ...product }));
      }
      this.settle();
    } catch { this.publish(this.unresolved() ? 'unknown' : 'failed', 'membership_load_failed'); }
    finally { this.end(); }
  }

  async purchase(productId: string): Promise<void> {
    if (!this.configured() || this.unresolved() || this.entitlements?.active.length || !this.products.some(product => product.id === productId)) return;
    const session = this.begin();
    if (!session) return;
    try {
      this.publish('purchasing');
      if (!session.isCurrent()) return;
      const result = await this.ports.native.purchase(productId, session.account.appAccountToken);
      if (result.status === 'transaction') {
        this.publish('verifying');
        await this.deliver(session, result.transaction);
        if (session.isCurrent()) await this.read(session);
        this.settle();
      } else if (result.status === 'pending' || result.status === 'unknown') {
        this.purchaseEffect = result.status;
        this.publish(result.status);
      } else if (result.status === 'unavailable') {
        this.publish('unavailable', 'purchases_unavailable');
      } else { this.settle(); }
    } catch {
      this.purchaseEffect = 'unknown';
      this.publish('unknown', 'purchase_effect_unknown');
    } finally { this.end(); }
  }

  async restore(): Promise<void> {
    if (!this.configured() || this.unresolved()) return;
    const session = this.begin();
    if (!session) return;
    try {
      this.publish('restore-running');
      if (!session.isCurrent()) return;
      const result = await this.ports.native.restore();
      await this.deliverAll(session, result);
      if (session.isCurrent()) await this.read(session);
      this.settle('restore-none');
    } catch { this.purchaseEffect = 'unknown'; this.publish('unknown', 'restore_effect_unknown'); }
    finally { this.end(); }
  }

  async redeem(code: string): Promise<void> {
    if (!code.trim() || !this.ports.configuration().promos || this.unresolved()) return;
    const session = this.begin();
    if (!session) return;
    try {
      const idempotencyKey = this.ports.newIdempotencyKey();
      if (!idempotencyKey) { this.publish('failed', 'idempotency_key_missing'); return; }
      this.promo = { code: code.trim(), idempotencyKey };
      this.publish('verifying');
      if (!session.isCurrent()) { this.promo = null; return; }
      await session.redeem(this.promo.code, this.promo.idempotencyKey);
      this.promo = null;
      if (session.isCurrent()) await this.read(session);
      this.settle();
    } catch { this.publish('unknown', 'promo_effect_unknown'); }
    finally { this.end(); }
  }

  async checkAgain(): Promise<void> {
    const session = this.begin();
    if (!session) return;
    try {
      this.publish('verifying');
      if (!session.isCurrent()) return;
      if (this.promo) {
        await session.redeem(this.promo.code, this.promo.idempotencyKey);
        this.promo = null;
      }
      if (!session.isCurrent()) return;
      const retained = [...this.deliveries.values()];
      for (const item of retained) await this.deliver(session, item.proof);
      if (!session.isCurrent()) return;
      if (this.configured()) {
        const result = await this.ports.native.currentEntitlements();
        const retried = new Set(retained.map(item => item.proof.transactionId));
        await this.deliverAll(session, { ...result, transactions: result.transactions.filter(proof => !retried.has(proof.transactionId)) });
      }
      if (session.isCurrent()) await this.read(session);
      this.settle();
    } catch { this.publish('unknown', 'reconciliation_unknown'); }
    finally { this.end(); }
  }

  async manageSubscriptions(): Promise<void> {
    const session = this.begin();
    if (!session) return;
    try { await this.ports.openManageSubscriptions(); }
    catch { this.publish('failed', 'subscription_management_unavailable'); }
    finally { this.end(); }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private capture(): MembershipSession | null {
    const session = this.ports.captureSession();
    if (!session || !session.isCurrent() || !session.account.accountId || !UUID.test(session.account.appAccountToken)) return null;
    return { account: { ...session.account }, generation: session.generation,
      isCurrent: () => session.isCurrent(), readEntitlements: () => session.readEntitlements(),
      redeem: (code, key) => session.redeem(code, key), deliver: (request, proof) => session.deliver(request, proof) };
  }

  private current(): boolean { return !this.disposed && !!this.owner?.isCurrent(); }
  private configured(): boolean { return this.ports.configuration().purchases === 'configured'; }
  private unresolved(): boolean { return !!this.purchaseEffect || this.deliveries.size > 0 || !!this.promo; }

  private begin(): MembershipSession | null {
    if (this.busy || !this.current()) return null;
    const session = this.capture();
    if (!session || session.generation !== this.owner!.generation || session.account.accountId !== this.owner!.account.accountId
      || session.account.appAccountToken.toLowerCase() !== this.owner!.account.appAccountToken.toLowerCase()) return null;
    this.busy = true;
    this.deliveryFailure = null;
    return session;
  }

  private end(): void {
    this.busy = false;
    this.publish(this.state.status, this.state.reason);
  }

  private publish(status: MembershipStatus, reason: string | null = null): void {
    if (!this.current()) return;
    this.state = { status, reason, products: this.products, entitlements: this.entitlements,
      canPurchase: !this.busy && this.configured() && !this.unresolved() && !this.entitlements?.active.length && this.products.length > 0,
      canRestore: !this.busy && this.configured() && !this.unresolved(),
      canRedeem: !this.busy && this.ports.configuration().promos && !this.unresolved(),
      canCheckAgain: !this.busy && (this.configured() || this.unresolved()) };
    for (const listener of this.listeners) listener();
  }

  private async read(session: MembershipSession): Promise<void> {
    if (!session.isCurrent()) return;
    const result = await session.readEntitlements();
    if (!session.isCurrent()) return;
    if (result.accountId !== session.account.accountId || result.appAccountToken.toLowerCase() !== session.account.appAccountToken.toLowerCase()) {
      throw new Error('entitlement_account_mismatch');
    }
    this.entitlements = copyEntitlements(result);
    if (result.active.length) this.purchaseEffect = null;
  }

  private settle(empty: MembershipStatus = 'products'): void {
    if (this.entitlements?.active.length) { this.publish('active'); return; }
    if (this.deliveries.size || this.promo || this.purchaseEffect === 'unknown') { this.publish('unknown'); return; }
    if (this.purchaseEffect === 'pending') { this.publish('pending'); return; }
    if (this.deliveryFailure) { this.publish('failed', this.deliveryFailure); return; }
    this.publish(this.configured() ? empty : 'unavailable', this.configured() ? null : 'purchases_unavailable');
  }

  private async deliverAll(session: MembershipSession, result: StoreKitTransactions): Promise<void> {
    for (const proof of result.transactions) await this.deliver(session, proof);
    if (result.truncated) this.purchaseEffect = 'unknown';
  }

  private async deliver(session: MembershipSession, proof: StoreKitProof): Promise<void> {
    const snapshot = { ...proof };
    const request = { transactionId: snapshot.transactionId, productId: snapshot.productId,
      jwsRepresentation: snapshot.jwsRepresentation, idempotencyKey: `storekit-delivery:${snapshot.transactionId}` };
    const existing = this.deliveries.get(snapshot.transactionId);
    if (existing && existing.proof.jwsRepresentation !== snapshot.jwsRepresentation) {
      this.purchaseEffect = 'unknown';
      return;
    }
    this.deliveries.set(snapshot.transactionId, { proof: snapshot, request });
    if (snapshot.appAccountToken && snapshot.appAccountToken.toLowerCase() !== session.account.appAccountToken.toLowerCase()) {
      this.purchaseEffect = 'unknown';
      return;
    }
    // A late receipt stays on its captured delivery port; loss of that auth must fail closed in the port.
    let outcome;
    try { outcome = await session.deliver({ ...request }, { ...snapshot }); }
    catch { return; }
    if (outcome.status === 'finished' && outcome.transactionId === snapshot.transactionId) {
      this.deliveries.delete(snapshot.transactionId);
    } else if (outcome.status === 'rejected') {
      this.deliveries.delete(snapshot.transactionId);
      this.deliveryFailure = outcome.code;
    }
  }
}
