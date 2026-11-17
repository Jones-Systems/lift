import type { SourceStatusReconciliationHooks } from './status-projection.js';
import { createHash } from 'node:crypto';
import type { HistoryResponse, JWSRenewalInfoDecodedPayload } from '@apple/app-store-server-library';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { Sqlite } from '../storage.js';
import { accountUuid, appleTransactionId, validateAppleConfiguration } from './configuration.js';
import { ApplePurchaseService } from './service.js';
import { AppleProofError, type AppleSandboxConfiguration, type VerifiedAppleTransaction } from './types.js';
import type { AppleHistoryReader, AppleReconciliationVerifier, NotificationOutcome, OwnerReconciliation,
  PurchaseBackgroundWriter, PurchaseOwner, PurchaseOwnerWriter, ReconciliationCheckpoint, ReconciliationOutcome } from './reconciliation.types.js';

type RunRow = { owner_binding: string; actor_binding: string; next_page: number; revision: string | null; outcome: string };
type VerifiedItem = { jws: string; proof: VerifiedAppleTransaction };
type Page = { items: VerifiedItem[]; revision: string; hasMore: boolean; hash: string };
export type AppleReconciliationPorts = Readonly<{
  ownerWriter: PurchaseOwnerWriter;
  history?: AppleHistoryReader;
  backgroundWriter?: PurchaseBackgroundWriter;
  sourceStatus?: SourceStatusReconciliationHooks;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const bounded = (value: unknown, size: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= size;
function fail(code: string): never { throw new AppleProofError(code); }
const inactive = new Set(['apple_revoked', 'apple_upgraded', 'apple_expired', 'apple_stale_proof']);
function outcome(handle: string, status: ReconciliationOutcome['status'], reason: string | null,
  committedPage: number | null = null, transactions = 0): ReconciliationOutcome {
  return { status, handle, committedPage, transactions, reason };
}
function reason(error: unknown): { status: 'rejected' | 'unknown'; code: string } {
  if (error instanceof AppleProofError) return { status: error.uncertain ? 'unknown' : 'rejected', code: error.code };
  if (error instanceof DomainError) return { status: error.status >= 500 ? 'unknown' : 'rejected', code: error.code };
  return { status: 'unknown', code: 'purchase_reconciliation_unknown' };
}
function ownerCopy(owner: PurchaseOwner): PurchaseOwner {
  if (!owner || !accountUuid.test(owner.accountId) || owner.appAccountToken !== owner.accountId
    || !appleTransactionId.test(owner.originalTransactionId) || !bounded(owner.bundleId, 255) || owner.environment !== 'Sandbox')
    return fail('apple_owner_invalid');
  return Object.freeze({ accountId: owner.accountId, appAccountToken: owner.appAccountToken,
    originalTransactionId: owner.originalTransactionId, bundleId: owner.bundleId, environment: owner.environment });
}
function actorCopy(actor: AccountContext): AccountContext {
  return Object.freeze({ accountId: actor.accountId, authUserId: actor.authUserId, sessionId: actor.sessionId, epoch: actor.epoch });
}

/** Trusted injection seam for synthetic tests. Runtime uses the official verifier factory in index.ts. */
export class ApplePurchaseReconciliation {
  private readonly config: Readonly<Required<AppleSandboxConfiguration>>;
  private readonly ledger: ApplePurchaseService;
  constructor(private readonly db: Sqlite, configuration: AppleSandboxConfiguration,
    private readonly verifier: AppleReconciliationVerifier, private readonly ports: AppleReconciliationPorts,
    private readonly clock: () => number = Date.now) {
    this.config = validateAppleConfiguration(configuration);
    this.ledger = new ApplePurchaseService(db, this.config, verifier, clock, ports.sourceStatus?.ledgerHooks);
    db.prepare('SELECT handle FROM apple_purchase_reconciliations LIMIT 1').get();
    db.prepare('SELECT notification_id FROM apple_purchase_notifications LIMIT 1').get();
  }

  private assertOwner(owner: PurchaseOwner): void {
    if (owner.bundleId !== this.config.bundleId || owner.environment !== 'Sandbox') fail('apple_owner_mismatch');
    const installed = this.db.prepare('SELECT account_id,bundle_id,environment FROM apple_purchase_owners WHERE original_transaction_id=?')
      .get(owner.originalTransactionId) as { account_id: string; bundle_id: string; environment: string } | undefined;
    if (!installed || installed.account_id !== owner.accountId || installed.bundle_id !== owner.bundleId || installed.environment !== owner.environment)
      fail('apple_owner_mismatch');
    const token = this.db.prepare('SELECT app_account_token FROM apple_purchase_transactions WHERE original_transaction_id=? AND account_id=? LIMIT 1')
      .get(owner.originalTransactionId, owner.accountId) as { app_account_token: string } | undefined;
    if (!token || token.app_account_token !== owner.appAccountToken) fail('apple_owner_mismatch');
  }

  private assertProofOwner(owner: PurchaseOwner, proof: VerifiedAppleTransaction): void {
    if (proof.appAccountToken?.toLowerCase() !== owner.appAccountToken || proof.originalTransactionId !== owner.originalTransactionId
      || proof.bundleId !== owner.bundleId || proof.environment !== owner.environment) fail('apple_history_owner_mismatch');
  }

  private apply(owner: PurchaseOwner, items: VerifiedItem[], assertWriter: () => void): void {
    for (const item of items) {
      this.assertProofOwner(owner, item.proof);
      const decision = this.ledger.observeVerified(owner.accountId, item.jws, item.proof, assertWriter);
      if (decision.status !== 'observed' && !inactive.has(decision.code))
        throw new AppleProofError(decision.code, decision.status === 'unknown');
    }
  }

  forOwner(originalActor: AccountContext): OwnerReconciliation {
    const actor = actorCopy(originalActor);
    const writer = this.ports.ownerWriter;
    const assertWriter = () => {
      if (!this.db.inTransaction) fail('canonical_writer_unproved');
      writer.assertWithinWrite(actor);
      writer.lifecycleStoreOptions.assertRootWriter(this.db);
    };
    const inWrite = <T>(effect: () => T): T => writer.lifecycle.withActiveWrite(actor, () => {
      assertWriter(); const result = effect(); assertWriter(); return result;
    });
    const read = (handle: string, owner?: PurchaseOwner): RunRow | undefined => {
      writer.lifecycle.assertActive(actor);
      const row = this.db.prepare('SELECT * FROM apple_purchase_reconciliations WHERE handle=? AND account_id=?')
        .get(handle, actor.accountId) as RunRow | undefined;
      if (row && (row.actor_binding !== JSON.stringify(actor) || (owner && row.owner_binding !== JSON.stringify(owner))))
        fail('reconciliation_binding_mismatch');
      if (row) this.assertOwner(ownerCopy(JSON.parse(row.owner_binding) as PurchaseOwner));
      writer.lifecycle.assertActive(actor);
      return row;
    };
    return Object.freeze({
      readReconciliation: (handle: string): ReconciliationOutcome | null => {
        writer.lifecycle.assertActive(actor);
        if (!uuid.test(handle)) fail('invalid_reconciliation_checkpoint');
        const row = read(handle);
        return row ? JSON.parse(row.outcome) as ReconciliationOutcome : null;
      },
      reconcileOwner: async (assertedOwner: PurchaseOwner, checkpoint: ReconciliationCheckpoint): Promise<ReconciliationOutcome> => {
        const handle = checkpoint?.handle;
        let owner: PurchaseOwner;
        let expectedPage: number;
        let previous: RunRow | undefined;
        try {
          writer.lifecycle.assertActive(actor);
          if (typeof handle !== 'string' || !uuid.test(handle) || !Number.isSafeInteger(checkpoint.expectedPage)
            || checkpoint.expectedPage < 0 || checkpoint.expectedPage >= Number.MAX_SAFE_INTEGER) fail('invalid_reconciliation_checkpoint');
          expectedPage = checkpoint.expectedPage;
          owner = ownerCopy(assertedOwner);
          if (owner.accountId !== actor.accountId) fail('apple_owner_mismatch');
          this.assertOwner(owner);
          previous = read(handle, owner);
          const replay = this.replay(handle, expectedPage, previous);
          if (replay) return replay;
          if (!this.ports.history) return outcome(handle, 'unavailable', 'apple_history_unconfigured');
        } catch (error) {
          const failure = reason(error); return outcome(typeof handle === 'string' ? handle : '', failure.status, failure.code);
        }

        let page: Page | undefined;
        let rejected: string | undefined;
        let responseHash = '';
        try {
          const response = await this.ports.history!.page(owner.originalTransactionId, previous?.revision ?? null);
          writer.lifecycle.assertActive(actor);
          this.assertOwner(owner);
          page = await this.verifyPage(owner, response, hash => { responseHash = hash; });
          if (page.hasMore && page.revision === previous?.revision) fail('apple_history_cursor_stalled');
          responseHash = page.hash;
        } catch (error) {
          try { writer.lifecycle.assertActive(actor); this.assertOwner(owner); }
          catch (stale) { const failure = reason(stale); return outcome(handle, failure.status, failure.code); }
          const failure = reason(error);
          if (failure.status === 'unknown') return outcome(handle, 'unknown', failure.code);
          rejected = failure.code;
          page = undefined;
        }
        try {
          return inWrite(() => {
            this.assertOwner(owner);
            const current = read(handle, owner);
            const replay = this.replay(handle, expectedPage, current, responseHash);
            if (replay) return replay;
            if ((current?.revision ?? null) !== (previous?.revision ?? null)) fail('reconciliation_checkpoint_stale');
            let rejection = rejected;
            if (page) {
              // A rejected item rolls back the entire page savepoint; its durable outcome still commits with no ledger effects.
              try { this.db.transaction(() => {
                this.apply(owner, page.items, assertWriter);
                this.ports.sourceStatus?.afterHistoryPage({owner,handle,pageIndex:expectedPage,pageDigest:page.hash,
                  transactionProofHashes:page.items.map(item=>sha(item.jws))});
                assertWriter();
              })(); }
              catch (error) {
                if (!(error instanceof AppleProofError) || error.uncertain) throw error;
                rejection = error.code;
              }
            }
            const result = outcome(handle, rejection ? 'rejected' : page!.hasMore ? 'pending' : 'complete', rejection ?? null,
              expectedPage, rejection ? 0 : page?.items.length ?? 0);
            if (!current) {
              this.db.prepare('INSERT INTO apple_purchase_reconciliations VALUES (?,?,?,?,?,?,?,?)')
                .run(handle, owner.accountId, owner.originalTransactionId, JSON.stringify(owner), JSON.stringify(actor),
                  expectedPage + 1, page?.revision ?? null, JSON.stringify(result));
            } else {
              this.db.prepare('UPDATE apple_purchase_reconciliations SET next_page=?,revision=?,outcome=? WHERE handle=?')
                .run(expectedPage + 1, page?.revision ?? current.revision, JSON.stringify(result), handle);
            }
            this.db.prepare('INSERT INTO apple_purchase_reconciliation_pages VALUES (?,?,?,?)')
              .run(handle, expectedPage, responseHash, JSON.stringify(result));
            return result;
          });
        } catch (error) { const failure = reason(error); return outcome(handle, failure.status, failure.code); }
      },
    });
  }

  private replay(handle: string, expectedPage: number, row?: RunRow, responseHash?: string): ReconciliationOutcome | null {
    if (row && expectedPage < row.next_page) {
      const page = this.db.prepare('SELECT outcome,response_hash FROM apple_purchase_reconciliation_pages WHERE handle=? AND request_page=?')
        .get(handle, expectedPage) as { outcome: string; response_hash: string } | undefined;
      if (!page) fail('reconciliation_checkpoint_stale');
      if (responseHash !== undefined && responseHash !== page.response_hash) fail('reconciliation_page_conflict');
      return JSON.parse(page.outcome) as ReconciliationOutcome;
    }
    if (expectedPage !== (row?.next_page ?? 0)) fail('reconciliation_checkpoint_stale');
    if (row && (JSON.parse(row.outcome) as ReconciliationOutcome).status !== 'pending') fail('reconciliation_finished');
    return null;
  }

  private async verifyPage(owner: PurchaseOwner, response: HistoryResponse, retainHash: (hash: string) => void): Promise<Page> {
    if (!response || response.bundleId !== owner.bundleId || response.environment !== owner.environment
      || !Array.isArray(response.signedTransactions) || response.signedTransactions.length > 20
      || typeof response.hasMore !== 'boolean' || !bounded(response.revision, 4096)
      || (response.hasMore && response.signedTransactions.length === 0)) fail('apple_history_page_invalid');
    const signed = [...response.signedTransactions];
    const revision = response.revision;
    const hasMore = response.hasMore;
    if (signed.some(jws => !bounded(jws, 60_000))) fail('apple_history_page_invalid');
    const hash = sha(JSON.stringify({ signed, revision, hasMore }));
    retainHash(hash);
    const items: VerifiedItem[] = [];
    for (const jws of signed) {
      const proof = { ...await this.verifier.verify(jws) };
      this.assertProofOwner(owner, proof);
      items.push({ jws, proof });
    }
    return { items, revision, hasMore, hash };
  }

  async ingestNotification(signedPayload: string): Promise<NotificationOutcome> {
    const background = this.ports.backgroundWriter;
    if (!background) return { status: 'unavailable', notificationId: null, reason: 'purchase_background_writer_required' };
    let notificationId: string | null = null;
    try {
      if (!bounded(signedPayload, 240_000)) fail('apple_notification_invalid');
      const notification = structuredClone(await this.verifier.notification(signedPayload));
      if (!notification.notificationUUID || !uuid.test(notification.notificationUUID) || notification.version !== '2.0'
        || !bounded(notification.notificationType, 100) || !Number.isSafeInteger(notification.signedDate)
        || notification.signedDate! < 0 || notification.signedDate! > this.clock() + 60_000) fail('apple_notification_invalid');
      notificationId = notification.notificationUUID.toLowerCase();
      const data = notification.data;
      if (!data || notification.summary !== undefined || notification.externalPurchaseToken !== undefined || notification.appData !== undefined
        || data.bundleId !== this.config.bundleId || data.environment !== 'Sandbox') fail('apple_notification_scope_invalid');
      const transactionJws = data.signedTransactionInfo;
      const renewalJws = data.signedRenewalInfo;
      const item = transactionJws === undefined ? undefined :
        { jws: transactionJws, proof: await this.verifiedTransaction(transactionJws) };
      const renewal = renewalJws === undefined ? undefined : await this.verifiedRenewal(renewalJws);
      if (!item && !renewal) fail('apple_notification_evidence_missing');
      const originalId = item?.proof.originalTransactionId ?? renewal!.originalTransactionId;
      const token = item?.proof.appAccountToken ?? renewal!.appAccountToken;
      if (typeof originalId !== 'string' || typeof token !== 'string') fail('apple_notification_owner_missing');
      const owner = ownerCopy({ accountId: token.toLowerCase(), appAccountToken: token.toLowerCase(),
        originalTransactionId: originalId, bundleId: data.bundleId, environment: 'Sandbox' });
      this.assertOwner(owner);
      if (item) this.assertProofOwner(owner, item.proof);
      if (renewal && (renewal.originalTransactionId !== owner.originalTransactionId
        || renewal.appAccountToken?.toLowerCase() !== owner.appAccountToken || renewal.environment !== owner.environment))
        fail('apple_renewal_owner_mismatch');
      const scope = background.capture(owner);
      const assertWriter = () => {
        scope.assertCurrent();
        if (!this.db.inTransaction) fail('canonical_writer_unproved');
        scope.assertWithinWrite(this.db);
        this.assertOwner(owner);
      };
      scope.assertCurrent();
      return scope.withWrite(() => {
        assertWriter();
        const payloadHash = sha(signedPayload);
        const saved = this.db.prepare('SELECT payload_hash,exact_payload,outcome FROM apple_purchase_notifications WHERE notification_id=?')
          .get(notificationId) as { payload_hash: string; exact_payload: string; outcome: string } | undefined;
        if (saved) {
          if (saved.payload_hash !== payloadHash || saved.exact_payload !== signedPayload) fail('apple_notification_collision');
          assertWriter(); return JSON.parse(saved.outcome) as NotificationOutcome;
        }
        const policyHeld = notification.notificationType === 'REFUND_REVERSED';
        if (item && !policyHeld) this.apply(owner, [item], assertWriter);
        const result: NotificationOutcome = { status: policyHeld ? 'unavailable' : 'observed', notificationId,
          reason: policyHeld ? 'apple_refund_reversal_policy_unavailable' : item ? null : 'renewal_evidence_only' };
        this.db.prepare('INSERT INTO apple_purchase_notifications VALUES (?,?,?,?,?,?,?)')
          .run(notificationId, payloadHash, signedPayload, owner.accountId, owner.originalTransactionId, renewalJws ?? null, JSON.stringify(result));
        this.ports.sourceStatus?.afterNotification({owner,notificationId:notificationId!,payloadDigest:payloadHash,
          transactionProofHashes:item ? [sha(item.jws)] : [],renewalProofHashes:renewalJws ? [sha(renewalJws)] : [],
          reason:policyHeld ? 'refund_reversed' : 'notification_changed'});
        assertWriter(); return result;
      });
    } catch (error) { const failure = reason(error); return { status: failure.status, notificationId, reason: failure.code }; }
  }

  private async verifiedTransaction(jws: string): Promise<VerifiedAppleTransaction> {
    if (!bounded(jws, 60_000)) fail('apple_jws_invalid');
    return { ...await this.verifier.verify(jws) };
  }

  private async verifiedRenewal(jws: string): Promise<JWSRenewalInfoDecodedPayload> {
    if (!bounded(jws, 60_000)) fail('apple_jws_invalid');
    const renewal = { ...await this.verifier.renewal(jws) };
    if (!Number.isSafeInteger(renewal.signedDate) || renewal.signedDate! < 0 || renewal.signedDate! > this.clock() + 60_000)
      fail('apple_renewal_invalid');
    return renewal;
  }
}
