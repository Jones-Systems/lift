import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { DomainError } from '../../src/errors.js';
import type { Sqlite } from '../../src/storage.js';
import type { AccountContext, LifecycleAdapter, LifecycleBindings } from '../../src/lifecycle/types.js';
import { bugIntakeMigrationSql, createBugIntakeLifecycleAdapter, createBugIntakeRoutes, createBugIntakeServiceFactory,
  type BugIntakeDependencies, type BugIntakeService, type TrustedBinding } from '../../src/bug-intake/index.js';

export const input = { title: 'Workout button does nothing', description: 'Tap Start on the workout screen.' };
export const binding: TrustedBinding = { repository: 'Jones-Systems/Form', sourceRevision: 'a'.repeat(40), acceptedScopeId: 'accepted-scope-1', authorityId: 'synthetic-authority' };
export type BugIntakeFixture = {
  db: Sqlite;
  contexts: Record<'A' | 'B', AccountContext>;
  disabled: Map<string, number>;
  deps: BugIntakeDependencies;
  app: Hono;
  serviceFor: (context: AccountContext) => BugIntakeService;
  adapter: LifecycleAdapter;
  A: BugIntakeService;
  B: BugIntakeService;
  close: () => void;
};
export function fixture(options: Partial<Pick<BugIntakeDependencies, 'authority' | 'dispatch' | 'triage'>> = {}): BugIntakeFixture {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
  db.exec(bugIntakeMigrationSql);
  const contexts: Record<'A' | 'B', AccountContext> = {
    A: { accountId: 'account-A', authUserId: 'auth-A', sessionId: 'session-A', epoch: 0 },
    B: { accountId: 'account-B', authUserId: 'auth-B', sessionId: 'session-B', epoch: 0 },
  };
  for (const value of Object.values(contexts)) db.prepare('INSERT INTO form_accounts VALUES (?)').run(value.accountId);
  const disabled = new Map<string, number>();
  const assertActive = (context: AccountContext) => {
    if (!context || !Object.values(contexts).some(value => value.accountId === context.accountId && value.authUserId === context.authUserId && value.sessionId === context.sessionId && value.epoch === context.epoch))
      throw new DomainError(401, 'authentication_required');
    if (disabled.has(context.accountId)) throw new DomainError(403, 'account_disabled');
  };
  const lifecycle: LifecycleBindings = {
    assertActive,
    withActiveWrite: (context, effect) => db.transaction(() => { assertActive(context); const result = effect(); assertActive(context); return result; }).immediate(),
    adultEligibility: () => ({ policy: 'self_reported_adult_v1', status: 'unknown', profileRevision: null }),
  };
  const deps: BugIntakeDependencies = { db, lifecycle, now: () => new Date('2026-10-11T12:00:00Z'), ...options,
    lifecycleControl: {
      assertSuppression(accountId, epoch) { if ((disabled.get(accountId) ?? -1) < epoch) throw new Error('suppression missing'); },
      purgeReadiness(requestId, accountId) {
        return requestId === 'approved-purge' && disabled.has(accountId)
          ? { status: 'ready', epoch: disabled.get(accountId)! } : { status: 'unavailable' };
      },
    },
  };
  const serviceFor = createBugIntakeServiceFactory(deps), app = new Hono();
  app.route('/v1/bug-reports', createBugIntakeRoutes({ serviceFor, context: c => {
    const token = c.req.header('Authorization');
    const context = token === 'Bearer synthetic-A' ? contexts.A : token === 'Bearer synthetic-B' ? contexts.B : null;
    if (!context) throw new DomainError(401, 'authentication_required');
    return context;
  } }));
  return { db, contexts, disabled, deps, app, serviceFor, adapter: createBugIntakeLifecycleAdapter(deps),
    A: serviceFor(contexts.A), B: serviceFor(contexts.B), close: () => db.close() };
}
export const authority: NonNullable<BugIntakeDependencies['authority']> = { bindingFor: () => binding, assertCurrent: () => {} };
export const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
