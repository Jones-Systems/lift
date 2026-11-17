import { consumeSourceStatusGracePermit, type SourceStatusGracePermit, type SourceStatusLedgerHooks } from './status-projection.js';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { assertAccountActive, assertActive } from '../lifecycle/guards.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Sqlite } from '../storage.js';
import { accountUuid, appleTransactionId, parseAppleDeliveryRequest, validateAppleConfiguration } from './configuration.js';
import { AppleProofError, type AppleDeliveryDecision, type AppleDeliveryRequest, type AppleEntitlementGrant,
  type AppleSandboxConfiguration, type AppleTransactionVerifier, type VerifiedAppleTransaction } from './types.js';

type TransactionRow = {
  transaction_id: string; original_transaction_id: string; account_id: string; product_id: string; product_type: string;
  app_account_token: string; purchase_date_ms: number; signed_date_ms: number; expires_date_ms: number | null;
  revocation_date_ms: number | null; is_upgraded: number; proof_hash: string; exact_jws: string;
};
const reject = (code: string): AppleDeliveryDecision => ({ status: 'rejected', code });
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
type ObservationDecision = { status: 'observed' } | Exclude<AppleDeliveryDecision, { status: 'delivered' }>;

/** Trusted composition seam. Tests inject synthetic claims here; runtime uses index.ts and Apple's cryptographic adapter. */
export class ApplePurchaseService {
  private readonly config: Readonly<Required<AppleSandboxConfiguration>>;
  constructor(private readonly db: Sqlite, configuration: AppleSandboxConfiguration,
    private readonly verifier: AppleTransactionVerifier, private readonly clock: () => number = Date.now, private readonly sourceStatus?: SourceStatusLedgerHooks) {
    this.config = validateAppleConfiguration(configuration);
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || db.pragma('synchronous', { simple: true }) !== 2)
      throw new Error('Apple delivery requires foreign_keys ON and synchronous FULL');
    db.prepare('SELECT transaction_id FROM apple_purchase_deliveries LIMIT 1').get();
  }

  accountBinding(authenticatedAccountId: string): { accountId: string; appAccountToken: string } | null {
    assertAccountActive(this.db, authenticatedAccountId);
    if (!accountUuid.test(authenticatedAccountId) || !this.db.prepare('SELECT id FROM form_accounts WHERE id=?').get(authenticatedAccountId)) return null;
    return { accountId: authenticatedAccountId, appAccountToken: authenticatedAccountId };
  }

  async deliver(authenticatedAccountId: string, value: unknown, context?: AccountContext): Promise<AppleDeliveryDecision> {
    const guard = () => context ? assertActive(this.db, context) : assertAccountActive(this.db, authenticatedAccountId);
    let account;
    try { guard(); account = this.accountBinding(authenticatedAccountId); }
    catch (error) { if (error instanceof DomainError && error.status !== 503) return reject('account_disabled'); return { status: 'unknown', code: 'purchase_storage_unavailable' }; }
    if (!account) return reject('authentication_required');
    const request = parseAppleDeliveryRequest(value);
    if (!request) return reject('invalid_purchase_request');
    let proof: VerifiedAppleTransaction;
    try { proof = await this.verifier.verify(request.jwsRepresentation); }
    catch (error) {
      try { guard(); } catch { return reject('account_disabled'); }
      if (error instanceof AppleProofError) return { status: error.uncertain ? 'unknown' : 'rejected', code: error.code };
      return { status: 'unknown', code: 'apple_verification_unknown' };
    }
    try { guard(); } catch { return reject('account_disabled'); }
    const validation = this.validateClaims(authenticatedAccountId, request, proof);
    if (validation) return reject(validation);
    try {
      // Verification is asynchronous; durable ownership, state, grant and exact-proof receipt commit together under a write lock.
      const effect = () => {
        guard(); const decision = this.commitDelivery(authenticatedAccountId, request, proof);
        this.sourceStatus?.afterLedgerMutation({accountId:authenticatedAccountId, originalTransactionId:proof.originalTransactionId,
          transactionId:proof.transactionId,proofHash:sha256(request.jwsRepresentation),observationOnly:false,decision});
        guard(); return decision;
      };
      return this.sourceStatus ? this.sourceStatus.withDeliveryWrite(effect) : this.db.transaction(effect).immediate();
    } catch { return { status: 'unknown', code: 'purchase_storage_effect_unknown' }; }
  }

  private validateClaims(accountId: string, request: AppleDeliveryRequest, p: VerifiedAppleTransaction): string | null {
    if (!p || typeof p !== 'object') return 'apple_claims_invalid';
    if (p.bundleId !== this.config.bundleId) return 'apple_bundle_mismatch';
    if (p.environment !== 'Sandbox') return 'apple_environment_mismatch';
    if (typeof p.transactionId !== 'string' || !appleTransactionId.test(p.transactionId)
      || typeof p.originalTransactionId !== 'string' || !appleTransactionId.test(p.originalTransactionId)
      || p.transactionId !== request.transactionId || p.productId !== request.productId) return 'apple_transaction_mismatch';
    const product = this.config.products.find(x => x.productId === p.productId);
    if (!product || product.type !== p.type) return 'apple_product_not_allowed';
    if (typeof p.appAccountToken !== 'string' || p.appAccountToken.toLowerCase() !== accountId) return 'apple_account_token_mismatch';
    if (p.inAppOwnershipType !== 'PURCHASED') return 'apple_ownership_not_supported';
    if (p.quantity !== 1 || !timestamp(p.purchaseDate) || !timestamp(p.signedDate)
      || p.purchaseDate > this.clock() + 60_000 || p.signedDate > this.clock() + 60_000 || p.purchaseDate > p.signedDate + 60_000)
      return 'apple_claims_invalid';
    if (p.isUpgraded !== undefined && typeof p.isUpgraded !== 'boolean') return 'apple_claims_invalid';
    if (p.revocationDate !== undefined && !timestamp(p.revocationDate)) return 'apple_claims_invalid';
    if (p.revocationReason !== undefined && (!Number.isInteger(p.revocationReason) || p.revocationDate === undefined)) return 'apple_claims_invalid';
    if (p.expiresDate !== undefined && (!timestamp(p.expiresDate) || p.expiresDate <= p.purchaseDate)) return 'apple_claims_invalid';
    if (p.type !== 'Non-Consumable' && p.expiresDate === undefined) return 'apple_expiry_required';
    if (p.type === 'Non-Consumable' && p.expiresDate !== undefined) return 'apple_claims_invalid';
    return null;
  }

  /** Trusted verified-input seam; caller owns the canonical synchronous write frame and existing owner binding. */
  observeVerified(accountId: string, jws: string, proof: VerifiedAppleTransaction, assertWriter: () => void, gracePermit?: SourceStatusGracePermit): ObservationDecision {
    assertWriter();
    if (!this.db.inTransaction) throw new Error('Apple observation requires an admitted transaction');
    const request = { transactionId: proof.transactionId, productId: proof.productId, jwsRepresentation: jws, idempotencyKey: '' };
    const validation = this.validateClaims(accountId, request, proof);
    if (validation) return { status: 'rejected', code: validation };
    const owner = this.db.prepare('SELECT account_id,bundle_id,environment FROM apple_purchase_owners WHERE original_transaction_id=?')
      .get(proof.originalTransactionId) as { account_id: string; bundle_id: string; environment: string } | undefined;
    if (!owner || owner.account_id !== accountId || owner.bundle_id !== proof.bundleId || owner.environment !== proof.environment)
      return { status: 'rejected', code: 'apple_transaction_owned' };
    const decision = this.commitDelivery(accountId, request, proof, true, gracePermit);
    this.sourceStatus?.afterLedgerMutation({accountId,originalTransactionId:proof.originalTransactionId,transactionId:proof.transactionId,
      proofHash:sha256(jws),observationOnly:true,decision});
    assertWriter();
    return decision;
  }

  private commitDelivery(accountId: string, request: AppleDeliveryRequest, p: VerifiedAppleTransaction): AppleDeliveryDecision;
  private commitDelivery(accountId: string, request: AppleDeliveryRequest, p: VerifiedAppleTransaction, observationOnly: true, gracePermit?: SourceStatusGracePermit): ObservationDecision;
  private commitDelivery(accountId: string, request: AppleDeliveryRequest, p: VerifiedAppleTransaction, observationOnly = false, gracePermit?: SourceStatusGracePermit): AppleDeliveryDecision | ObservationDecision {
    if (!this.accountBinding(accountId)) return reject('authentication_required');
    const now = this.clock();
    const fingerprint = sha256(request.jwsRepresentation);
    const command = observationOnly ? undefined : this.db.prepare('SELECT transaction_id,product_id FROM apple_purchase_commands WHERE account_id=? AND idempotency_key=?')
      .get(accountId, request.idempotencyKey) as { transaction_id: string; product_id: string } | undefined;
    if (command && (command.transaction_id !== p.transactionId || command.product_id !== p.productId)) return reject('idempotency_mismatch');
    const owner = this.db.prepare('SELECT account_id,bundle_id,environment FROM apple_purchase_owners WHERE original_transaction_id=?')
      .get(p.originalTransactionId) as { account_id: string; bundle_id: string; environment: string } | undefined;
    if (owner && (owner.account_id !== accountId || owner.bundle_id !== p.bundleId || owner.environment !== p.environment)) return reject('apple_transaction_owned');
    const existing = this.db.prepare('SELECT * FROM apple_purchase_transactions WHERE transaction_id=?').get(p.transactionId) as TransactionRow | undefined;
    if (existing && (existing.account_id !== accountId || existing.product_id !== p.productId || existing.product_type !== p.type
      || existing.original_transaction_id !== p.originalTransactionId || existing.app_account_token !== accountId
      || existing.purchase_date_ms !== p.purchaseDate)) return reject('apple_transaction_identity_mismatch');

    if (!owner) this.db.prepare('INSERT INTO apple_purchase_owners VALUES (?,?,?,?,?)').run(p.originalTransactionId, accountId, p.bundleId, p.environment, now);
    const newer = !existing || p.signedDate > existing.signed_date_ms;
    const revokedAt = existing?.revocation_date_ms ?? p.revocationDate ?? null;
    const upgraded = existing?.is_upgraded === 1 || p.isUpgraded === true ? 1 : 0;
    if (!existing) {
      this.db.prepare('INSERT INTO apple_purchase_transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(p.transactionId, p.originalTransactionId, accountId, p.productId, p.type, accountId, p.purchaseDate,
          p.signedDate, p.expiresDate ?? null, revokedAt, upgraded, fingerprint, request.jwsRepresentation, now);
    } else if (newer || revokedAt !== existing.revocation_date_ms || upgraded !== existing.is_upgraded) {
      this.db.prepare(`UPDATE apple_purchase_transactions SET signed_date_ms=?,expires_date_ms=?,revocation_date_ms=?,
        is_upgraded=?,proof_hash=?,exact_jws=?,updated_at_ms=? WHERE transaction_id=?`)
        .run(newer ? p.signedDate : existing.signed_date_ms, newer ? p.expiresDate ?? null : existing.expires_date_ms,
          revokedAt, upgraded, newer ? fingerprint : existing.proof_hash, newer ? request.jwsRepresentation : existing.exact_jws, now, p.transactionId);
    }
    const claims = JSON.stringify({ purchaseDate: p.purchaseDate, expiresDate: p.expiresDate ?? null, signedDate: p.signedDate,
      revocationDate: p.revocationDate ?? null, isUpgraded: p.isUpgraded === true });
    this.db.prepare('INSERT INTO apple_purchase_observations VALUES (?,?,?,?,?) ON CONFLICT(transaction_id,proof_hash) DO NOTHING')
      .run(p.transactionId, fingerprint, claims, request.jwsRepresentation, now);
    if (revokedAt !== null) return reject('apple_revoked');
    if (upgraded === 1) return reject('apple_upgraded');
    const expiry = newer || !existing ? p.expiresDate ?? null : existing.expires_date_ms;
    if (expiry !== null && expiry <= now) {
      if (!observationOnly || !gracePermit) return reject('apple_expired');
      consumeSourceStatusGracePermit(gracePermit,{db:this.db,accountId,exactJws:request.jwsRepresentation,proof:p,nowMs:now});
    }
    if (existing && p.signedDate === existing.signed_date_ms && fingerprint !== existing.proof_hash
      && (p.expiresDate ?? null) !== existing.expires_date_ms) return reject('apple_conflicting_proof');
    if (observationOnly) {
      if (existing && p.signedDate < existing.signed_date_ms) return reject('apple_stale_proof');
      const product = this.config.products.find(x => x.productId === p.productId)!;
      this.db.prepare('INSERT INTO apple_purchase_grants VALUES (?,?,?,?,?) ON CONFLICT(transaction_id) DO NOTHING')
        .run(p.transactionId, accountId, randomUUID(), product.entitlement, now);
      return { status: 'observed' };
    }
    const receipt = this.db.prepare('SELECT server_delivery_id,account_id,product_id,exact_jws FROM apple_purchase_deliveries WHERE transaction_id=? AND proof_hash=?')
      .get(p.transactionId, fingerprint) as { server_delivery_id: string; account_id: string; product_id: string; exact_jws: string } | undefined;
    if (receipt && (receipt.account_id !== accountId || receipt.product_id !== p.productId || receipt.exact_jws !== request.jwsRepresentation))
      return { status: 'unknown', code: 'purchase_receipt_mismatch' };
    if (existing && p.signedDate < existing.signed_date_ms && !receipt) return reject('apple_stale_proof');

    this.db.prepare('INSERT INTO apple_purchase_commands VALUES (?,?,?,?) ON CONFLICT(account_id,idempotency_key) DO NOTHING')
      .run(accountId, request.idempotencyKey, p.transactionId, p.productId);
    const product = this.config.products.find(x => x.productId === p.productId)!;
    this.db.prepare('INSERT INTO apple_purchase_grants VALUES (?,?,?,?,?) ON CONFLICT(transaction_id) DO NOTHING')
      .run(p.transactionId, accountId, randomUUID(), product.entitlement, now);
    const deliveryId = receipt?.server_delivery_id ?? randomUUID();
    if (!receipt) this.db.prepare('INSERT INTO apple_purchase_deliveries VALUES (?,?,?,?,?,?,?)')
      .run(p.transactionId, fingerprint, deliveryId, accountId, p.productId, request.jwsRepresentation, now);
    return { status: 'delivered', accountId, transactionId: p.transactionId, productId: p.productId, serverDeliveryId: deliveryId };
  }

  entitlements(authenticatedAccountId: string): { grants: AppleEntitlementGrant[]; active: string[] } {
    if (!this.accountBinding(authenticatedAccountId)) return { grants: [], active: [] };
    const now = this.clock();
    const rows = this.db.prepare(`SELECT g.id,g.entitlement,g.transaction_id,g.granted_at_ms,t.expires_date_ms,
      t.revocation_date_ms,t.is_upgraded,t.purchase_date_ms,t.original_transaction_id,t.product_type FROM apple_purchase_grants g
      JOIN apple_purchase_transactions t ON t.transaction_id=g.transaction_id AND t.account_id=g.account_id WHERE g.account_id=?`)
      .all(authenticatedAccountId) as { id: string; entitlement: string; transaction_id: string; granted_at_ms: number;
        original_transaction_id: string; product_type: string; expires_date_ms: number | null; revocation_date_ms: number | null; is_upgraded: number; purchase_date_ms: number }[];
    const grants: AppleEntitlementGrant[] = rows.map(row => {
      const ordinaryActive = row.revocation_date_ms === null && row.is_upgraded === 0 && row.purchase_date_ms <= now &&
        (row.expires_date_ms === null || row.expires_date_ms > now);
      const decision = this.sourceStatus?.entitlement({accountId:authenticatedAccountId,transactionId:row.transaction_id,
        originalTransactionId:row.original_transaction_id,productType:row.product_type,ordinaryActive,ordinaryExpiresAtMs:row.expires_date_ms,nowMs:now});
      const cutoff = decision ? decision.effectiveExpiresAtMs : row.expires_date_ms;
      return { id:row.id,entitlement:row.entitlement,source:'apple',sourceId:row.transaction_id,grantedAt:new Date(row.granted_at_ms).toISOString(),
        expiresAt:cutoff === null ? null : new Date(cutoff).toISOString(),environment:'Sandbox',active:decision ? decision.active : ordinaryActive };
    });
    return { grants, active: [...new Set(grants.filter(x => x.active).map(x => x.entitlement))] };
  }
}
