import Database from 'better-sqlite3';
import { migrations } from '../../../src/storage.js';
import { DomainError } from '../../../src/errors.js';
import { assertActive, withActiveWrite, adultEligibility, assertAccountActive, bindSuppressionAuthority } from '../../../src/lifecycle/guards.js';
import { lifecycleMigration } from '../../../src/lifecycle/migration.js';
import type { AccountContext, DisableRecord, LifecycleBindings, SuppressionLedger } from '../../../src/lifecycle/types.js';
import { activityMigrationSql } from '../../../src/activity/migration.js';
import type { ActivityLifecycleControl, LegacyTrainingReader } from '../../../src/activity/types.js';
import { createActivityIntegration, createLegacyTrainingReader, type ActivityIntegration } from '../../../src/activity/integration/index.js';

export type IntegrationFixture = Readonly<{
  db: Database.Database;
  contexts: Record<'A' | 'B', AccountContext>;
  lifecycle: LifecycleBindings;
  lifecycleControl: ActivityLifecycleControl;
  integration: ActivityIntegration;
  legacy: LegacyTrainingReader;
  sql: string[];
  suppress(accountId: string): void;
  authorityAvailable(value: boolean): void;
}>;
export function fixture(options: Readonly<{ legacy?: boolean; authority?: boolean; lifecycleSchema?: boolean }> = {}): IntegrationFixture {
  const sql: string[] = [];
  const db = new Database(':memory:', { verbose: text => { if (typeof text === 'string') sql.push(text); } });
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrations.filter(value => value.version <= 7)) db.exec(migration.sql);
    db.exec(activityMigrationSql);
    if (options.lifecycleSchema !== false) db.exec(lifecycleMigration.sql);
    const contexts: Record<'A' | 'B', AccountContext> = {
      A: Object.freeze({ accountId: 'form-A', authUserId: 'auth-A', sessionId: 'session-A', epoch: 0 }),
      B: Object.freeze({ accountId: 'form-B', authUserId: 'auth-B', sessionId: 'session-B', epoch: 0 }),
    };
    for (const [key, context] of Object.entries(contexts)) {
      db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)')
        .run(context.authUserId, key, `${key}@example.invalid`);
      db.prepare('INSERT INTO form_accounts(id,auth_user_id,created_at) VALUES (?,?,?)')
        .run(context.accountId, context.authUserId, '2026-01-01T00:00:00.000Z');
      db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,0,0,?)')
        .run(context.sessionId, Date.parse('2099-01-01T00:00:00Z'), `synthetic-${key}`, context.authUserId);
    }
    for (const id of ['goblet-squat', 'floor-press', 'supported-row', 'dumbbell-hinge', 'calf-raise'])
      db.prepare('INSERT INTO exercises(id,data,retired) VALUES (?,?,0)').run(id, JSON.stringify({ id, name: id, cues: [] }));
    const records = new Map<string, DisableRecord>(); let sequence = 0, available = true;
    const ensureAuthority = (): void => { if (!available) throw new Error('synthetic_authority_unavailable'); };
    const ledger: SuppressionLedger = {
      currentSequence() { ensureAuthority(); return sequence; },
      lookup(accountId) { ensureAuthority(); return records.get(accountId) ?? null; },
      recordDisable(record) { ensureAuthority(); const result = { ...record, sequence: ++sequence }; records.set(record.accountId, result); return result; },
      reconcileRestore(apply) { ensureAuthority(); for (const record of records.values()) apply(record); return sequence; },
    };
    if (options.authority !== false) bindSuppressionAuthority(db, ledger);
    const lifecycle: LifecycleBindings = {
      assertActive: context => assertActive(db, context),
      withActiveWrite: <T>(context: AccountContext, effect: () => T): T => withActiveWrite(db, context, effect),
      adultEligibility: context => adultEligibility(db, context),
    };
    const lifecycleControl: ActivityLifecycleControl = {
      assertSuppression(accountId, epoch) {
        const row = ledger.lookup(accountId);
        if (!row || row.epoch !== epoch) throw new DomainError(503, 'synthetic_suppression_unproved');
      },
      purgeReadiness: () => ({ status: 'unavailable', reason: 'synthetic_executor_not_authorized' }),
    };
    const legacy = createLegacyTrainingReader({ db, assertReadable: accountId => { assertAccountActive(db, accountId); } });
    const integration = createActivityIntegration({ db, lifecycle, lifecycleControl,
      ...(options.legacy === false ? {} : { legacy }), now: () => new Date('2026-10-09T16:00:00.000Z') });
    return { db, contexts, lifecycle, lifecycleControl, integration, legacy, sql,
      authorityAvailable(value) { available = value; },
      suppress(accountId) {
        const owner = Object.values(contexts).find(context => context.accountId === accountId)!;
        // Ledger survives a source restore independently of SQLite account_lifecycle state.
        ledger.recordDisable({ accountId, authUserId: owner.authUserId, epoch: 1, requestId: 'synthetic-delete', disabledAtMs: 1 });
      },
    };
  } catch (error) { db.close(); throw error; }
}
export const personalFields = { name: 'Owner movement', description: 'Independent exercise', movement: null,
  measurementType: 'unspecified', kind: 'resistance', loadApplicability: 'unspecified', loadLabel: null } as const;
export const unknownLoad = { state: 'unknown', confirmed: true } as const;
export const entryInput = (draftId: string, date = '2026-10-09', source: 'manual' | 'nativeSpeech' = 'manual') => ({
  date: { localDate: date, timeZone: 'America/New_York', calendar: 'iso8601', source: 'selected',
    capturedAt: '2026-10-09T16:00:00.000Z', referenceLocalDate: '2026-10-09', confirmed: true },
  kind: 'workout', items: [{ id: 'item-one', exercise: { source: 'global', id: 'floor-press' }, load: unknownLoad }],
  performedConfirmed: true, source, draftId, acknowledgedIssues: [],
});
export function seedPlan(db: Database.Database, accountId: string, id = 'same-plan', revision = 1,
  overrides: Record<string, unknown> = {}): void {
  const data = { name: `Plan ${accountId}`, minutes: 30, items: [{ id: 'same-item', exerciseId: 'floor-press',
    setTarget: 2, repMin: 8, repMax: 10, targetKg: 0 }], archived: false, ...overrides };
  db.prepare('INSERT INTO plans VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET revision=excluded.revision,archived=excluded.archived,data=excluded.data')
    .run(accountId, id, revision, data.archived === true ? 1 : 0, JSON.stringify({ name: data.name, minutes: data.minutes, items: data.items }), '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO plan_revisions VALUES (?,?,?,?,?)').run(accountId, id, revision, JSON.stringify(data), '2026-01-01');
  db.prepare('INSERT INTO plan_item_ids VALUES (?,?,?,?) ON CONFLICT DO NOTHING').run(accountId, id, 'same-item', 'floor-press');
}
export function seedSession(db: Database.Database, accountId: string, id = 'same-session',
  startedAt = '2026-10-09T16:00:00.000Z', status: 'active' | 'completed' = 'completed'): void {
  db.prepare('INSERT INTO workout_sessions VALUES (?,?,?,1,1,?,?,?,NULL)').run(accountId, id, 'same-plan', '{}', status, startedAt);
  for (const [position, occurrence] of ['same-occurrence', 'second-occurrence'].entries())
    db.prepare('INSERT INTO session_occurrences VALUES (?,?,?,?,?,?,?)').run(accountId, id, occurrence, 'same-item', 'floor-press', position, '{}');
}
export function seedSet(db: Database.Database, accountId: string, sessionId = 'same-session', id = 'set-one',
  occurrence = 'same-occurrence', number = 1, status: 'draft' | 'confirmed' | 'voided' = 'confirmed', reps = 8): void {
  db.prepare('INSERT INTO performed_sets VALUES (?,?,?,?,?,1,?,0,?,?,?)').run(accountId, sessionId, id, occurrence, number, reps, status,
    '2026-10-09T16:00:00.000Z', '2026-10-09T16:00:00.000Z');
}
export const code = (expected: string) => (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'code' in error && error.code === expected;
