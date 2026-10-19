import { DomainError } from '../errors.js';
import type { Sqlite } from '../storage.js';
import type { AccountContext, AdultEligibility, SuppressionLedger } from './types.js';

const authorities = new WeakMap<Sqlite, SuppressionLedger>();
export function hasLifecycleSchema(db: Sqlite): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_lifecycle'").get();
}
export function bindSuppressionAuthority(db: Sqlite, ledger: SuppressionLedger): void {
  ledger.currentSequence(); authorities.set(db, ledger);
}
export function suppressionAuthority(db: Sqlite): SuppressionLedger {
  const ledger = authorities.get(db);
  if (!ledger) throw new DomainError(503, 'suppression_authority_required');
  try { ledger.currentSequence(); } catch { throw new DomainError(503, 'suppression_authority_unavailable'); }
  return ledger;
}
export function assertPrincipalActive(db: Sqlite, authUserId: string): void {
  const mapping = db.prepare('SELECT id FROM form_accounts WHERE auth_user_id=?').get(authUserId) as { id: string } | undefined;
  if (mapping) assertAccountActive(db, mapping.id);
  else if (hasLifecycleSchema(db)) {
    const ledger = suppressionAuthority(db);
    let suppressed = false;
    ledger.reconcileRestore(record => { if (record.authUserId === authUserId) suppressed = true; });
    if (suppressed) throw new DomainError(403, 'account_disabled');
  }
}
export function assertAccountActive(db: Sqlite, accountId: string): number {
  if (!hasLifecycleSchema(db)) return 0;
  const ledger = suppressionAuthority(db);
  try { if (ledger.lookup(accountId)) throw new DomainError(403, 'account_disabled'); }
  catch (error) { if (error instanceof DomainError) throw error; throw new DomainError(503, 'suppression_authority_unavailable'); }
  const row = db.prepare('SELECT state,epoch FROM account_lifecycle WHERE account_id=?').get(accountId) as { state: string; epoch: number } | undefined;
  if (!row || row.state !== 'active') throw new DomainError(403, 'account_disabled');
  return row.epoch;
}
export function assertActive(db: Sqlite, context: AccountContext): void {
  const session = db.prepare('SELECT userId,expiresAt FROM session WHERE id=?').get(context.sessionId) as { userId: string; expiresAt: number } | undefined;
  const mapping = db.prepare('SELECT auth_user_id FROM form_accounts WHERE id=?').get(context.accountId) as { auth_user_id: string } | undefined;
  if (!session || session.userId !== context.authUserId || session.expiresAt <= Date.now() || mapping?.auth_user_id !== context.authUserId)
    throw new DomainError(401, 'account_session_invalid');
  if (assertAccountActive(db, context.accountId) !== context.epoch) throw new DomainError(403, 'account_epoch_changed');
}
export function withActiveWrite<T>(db: Sqlite, context: AccountContext, effect: () => T): T {
  return db.transaction(() => { assertActive(db, context); const result = effect(); assertActive(db, context); return result; }).immediate();
}
export function adultEligibility(db: Sqlite, context: AccountContext): AdultEligibility {
  return withActiveWrite(db, context, () => {
    return readEligibility(db, context.accountId);
  });
}

function readEligibility(db: Sqlite, accountId: string): AdultEligibility {
  const row = db.prepare("SELECT revision,data FROM documents WHERE account_id=? AND kind='profile'").get(accountId) as { revision: number; data: string } | undefined;
  let age: unknown = null;
  if (row) {
    try { age = (JSON.parse(row.data) as { age?: unknown } | null)?.age; } catch { /* Invalid persisted data grants no eligibility. */ }
  }
  const status = typeof age === 'number' && Number.isInteger(age) && age >= 18 && age <= 120 ? 'eligible'
    : typeof age === 'number' && Number.isInteger(age) && age >= 13 && age <= 17 ? 'not_adult' : 'unknown';
  return { policy: 'self_reported_adult_v1', status, profileRevision: row?.revision ?? null };
}

// Internal module callback: Community must resolve and authorize the subject before invoking it.
export function subjectEligibility(db: Sqlite, actor: AccountContext, subjectAccountId: string): AdultEligibility {
  if (!db.inTransaction) throw new DomainError(503, 'subject_authorization_transaction_required');
  return withActiveWrite(db, actor, () => {
    const unknown: AdultEligibility = { policy: 'self_reported_adult_v1', status: 'unknown', profileRevision: null };
    if (!hasLifecycleSchema(db)) return unknown;
    suppressionAuthority(db);
    const subject = db.prepare('SELECT f.auth_user_id FROM form_accounts f JOIN "user" u ON u.id=f.auth_user_id WHERE f.id=?')
      .get(subjectAccountId) as { auth_user_id: string } | undefined;
    if (!subject) return unknown;
    try { assertAccountActive(db, subjectAccountId); assertPrincipalActive(db, subject.auth_user_id); }
    catch (error) { if (error instanceof DomainError && error.code === 'account_disabled') return unknown; throw error; }
    return readEligibility(db, subjectAccountId);
  });
}
