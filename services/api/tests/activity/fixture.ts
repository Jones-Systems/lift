import Database from 'better-sqlite3';
import { DomainError } from '../../src/errors.js';
import { migrations } from '../../src/storage.js';
import type { AccountContext, LifecycleBindings } from '../../src/lifecycle/types.js';
import { activityMigrationSql, createActivityService, type ActivityDependencies, type LegacyActivityEvidence, type LegacyPlanSnapshot } from '../../src/activity/index.js';

export type ActivityFixture = {
  db: Database.Database;
  contexts: Record<'A' | 'B' | 'C', AccountContext>;
  service: ReturnType<typeof createActivityService>;
  deps: ActivityDependencies;
  lifecycle: LifecycleBindings;
  disabled: Map<string, number>;
  epochs: Map<string, number>;
  legacyPlans: Map<string, LegacyPlanSnapshot>;
  setNow(value: string): void;
  setFlow(value: 'independent' | 'noSaveBody'): void;
  setEvidence(value: LegacyActivityEvidence[]): void;
  setPurgeReady(value: boolean): void;
};

export function fixture(): ActivityFixture {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  const legacyMigrations = migrations.filter(x => x.version <= 7);
  for (const migration of legacyMigrations) db.exec(migration.sql);
  db.exec(activityMigrationSql);
  const contexts: Record<'A' | 'B' | 'C', AccountContext> = {
    A: { accountId: 'form-A', authUserId: 'auth-A', sessionId: 'session-A', epoch: 0 },
    B: { accountId: 'form-B', authUserId: 'auth-B', sessionId: 'session-B', epoch: 0 },
    C: { accountId: 'form-C', authUserId: 'auth-C', sessionId: 'session-C', epoch: 0 },
  };
  for (const [key, context] of Object.entries(contexts)) {
    db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').run(context.authUserId, key, `${key}@example.invalid`);
    db.prepare('INSERT INTO form_accounts(id,auth_user_id,created_at) VALUES (?,?,?)').run(context.accountId, context.authUserId, '2026-01-01T00:00:00Z');
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,0,0,?)')
      .run(context.sessionId, Date.parse('2030-01-01T00:00:00Z'), `synthetic-${key}`, context.authUserId);
  }
  db.prepare('INSERT INTO exercises(id,data,retired) VALUES (?,?,0)').run('global-press', JSON.stringify({ id: 'global-press', name: 'Global press', loadLabel: 'Each side', cues: [] }));
  let now = '2026-10-01T16:00:00Z', flow: 'independent' | 'noSaveBody' = 'independent', purgeReady = false;
  const disabled = new Map<string, number>();
  const epochs = new Map(Object.values(contexts).map(x => [x.accountId, 0]));
  const assertActive = (context: AccountContext) => {
    const owner = db.prepare('SELECT auth_user_id FROM form_accounts WHERE id=?').get(context.accountId) as { auth_user_id: string } | undefined;
    const session = db.prepare('SELECT userId,expiresAt FROM session WHERE id=?').get(context.sessionId) as { userId: string; expiresAt: number } | undefined;
    if (owner?.auth_user_id !== context.authUserId || session?.userId !== context.authUserId || session.expiresAt <= Date.parse(now))
      throw new DomainError(401, 'account_session_invalid');
    if (disabled.has(context.accountId) || epochs.get(context.accountId) !== context.epoch) throw new DomainError(403, 'account_disabled');
  };
  const lifecycle: LifecycleBindings = {
    assertActive,
    withActiveWrite<T>(context: AccountContext, effect: () => T): T {
      return db.transaction(() => { assertActive(context); const result = effect(); assertActive(context); return result; }).immediate();
    },
    adultEligibility(context) { assertActive(context); return { policy: 'self_reported_adult_v1', status: 'eligible', profileRevision: 1 }; },
  };
  let evidence: LegacyActivityEvidence[] = [];
  const legacyPlans = new Map<string, LegacyPlanSnapshot>();
  const deps: ActivityDependencies = {
    db, lifecycle, globalExerciseKind: id => id === 'global-press' ? 'resistance' : null,
    now: () => new Date(now),
    assertPersistable: () => { if (flow !== 'independent') throw new DomainError(403, 'activity_dataflow_not_persistable'); },
    legacy: {
      readPlanRevision(accountId, planId, revision) { return legacyPlans.get(`${accountId}/${planId}/${revision}`) ?? null; },
      listCompletedEvidence(account, from, to) { return account !== contexts.A.accountId ? [] : evidence.filter(x => x.localDate >= from && x.localDate <= to); },
    },
    lifecycleControl: {
      assertSuppression(accountId, epoch) { if ((disabled.get(accountId) ?? -1) < epoch) throw new Error('synthetic ledger missing'); },
      purgeReadiness(requestId, accountId) {
        return purgeReady && requestId === 'synthetic-purge' && disabled.has(accountId)
          ? { status: 'ready', epoch: disabled.get(accountId)! } : { status: 'unavailable', reason: 'synthetic_purge_not_acknowledged' };
      },
    },
  };
  const service = createActivityService(deps);
  return { db, contexts, service, deps, lifecycle, disabled, epochs, legacyPlans,
    setNow(value: string) { now = value; }, setFlow(value: typeof flow) { flow = value; },
    setEvidence(value: LegacyActivityEvidence[]) { evidence = value; }, setPurgeReady(value: boolean) { purgeReady = value; } };
}
export const personalFields = { name: 'Personal press', description: 'My independently entered movement', movement: 'press',
  measurementType: 'unspecified', kind: 'resistance', loadApplicability: 'unspecified', loadLabel: null } as const;
export const unknownLoad = { state: 'unknown', confirmed: true } as const;
export const entryInput = (draftId: string, date = '2026-10-01') => ({
  date: { localDate: date, timeZone: 'America/New_York', calendar: 'iso8601', source: 'selected', capturedAt: '2026-10-01T16:00:00Z', referenceLocalDate: '2026-10-01', confirmed: true },
  kind: 'workout', items: [{ id: 'item-one', exercise: { source: 'global', id: 'global-press' }, load: unknownLoad }],
  performedConfirmed: true, source: 'manual', draftId, acknowledgedIssues: [],
});
export const week = (restDay = 5) => Array.from({ length: 7 }, (_, i) => ({ isoWeekday: i + 1,
  expectation: i + 1 === restDay ? 'rest' : 'workout', plan: null }));

export const planItems = () => entryInput('plan').items.map(item => ({ id: item.id, exercise: item.exercise, target: { load: unknownLoad } }));
