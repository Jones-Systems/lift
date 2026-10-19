import type { Domain } from '../domain.js';
import { DomainError } from '../errors.js';
import { assertAccountActive, assertPrincipalActive } from '../lifecycle/guards.js';
import { resourceId } from '../schemas.js';

export function createDomainReadDependencies(domain: Domain) {
  const db = domain.db;
  const resolveAccount = (subject: string): string | null => {
    if (!resourceId.safeParse(subject).success) return null;
    const row = db.prepare('SELECT f.id FROM form_accounts f JOIN "user" u ON u.id=f.auth_user_id WHERE f.auth_user_id=?')
      .get(subject) as { id: string } | undefined;
    return row?.id ?? null;
  };
  const withActiveAccountRead = <T>(context: { accountId: string; subject: string }, read: () => T): T => {
    const { accountId, subject } = context;
    const current = () => {
      if (!resourceId.safeParse(accountId).success || resolveAccount(subject) !== accountId)
        throw new DomainError(403, 'account_subject_mismatch');
      assertPrincipalActive(db, subject);
      return assertAccountActive(db, accountId);
    };
    return db.transaction(() => {
      const epoch = current();
      const result = read();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function')
        throw new DomainError(503, 'synchronous_account_read_required');
      if (current() !== epoch) throw new DomainError(403, 'account_epoch_changed');
      return result;
    }).deferred();
  };
  return Object.freeze({ domain: Object.freeze({ history: domain.history.bind(domain),
    session: domain.session.bind(domain), plan: domain.plan.bind(domain) }), resolveAccount, withActiveAccountRead,
    plansPage: (accountId: string, limit: number) => domain.plansPage(accountId, limit) });
}
