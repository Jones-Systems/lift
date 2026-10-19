import { DomainError } from '../errors.js';
import type { AccountContext, LifecycleAdapter, LifecycleResult } from '../lifecycle/types.js';
import { activityOwnedTables, activityPurgeOrder } from './migration.js';
import type { ActivityService } from './service.js';
import * as s from './schemas.js';
import type { ActivityEntry, ActivityPlanSnapshot, PersonalExercise, PlanDaySnapshot, ScheduleRevision } from './types.js';

const category = 'activity';
const failure = (reason: string): LifecycleResult => ({ status: 'unavailable', reason });
function safeExercise(value: PersonalExercise) {
  const fields = s.personalExerciseFields.parse({ name: value.name, description: value.description, movement: value.movement,
    measurementType: value.measurementType, kind: value.kind, loadApplicability: value.loadApplicability, loadLabel: value.loadLabel });
  return { ...fields, id: value.id, revision: value.revision, retired: value.retired, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function safeItems(items: ActivityEntry['items']) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw new DomainError(503, 'account_export_invalid_data');
  return items.map(item => ({ ...s.activityItem.parse({ id: item.id, exercise: item.exercise, load: item.load,
    ...(item.sets === undefined ? {} : { sets: item.sets }), ...(item.reportedSetCount === undefined ? {} : { reportedSetCount: item.reportedSetCount }),
    ...(item.durationSeconds === undefined ? {} : { durationSeconds: item.durationSeconds }), ...(item.distance === undefined ? {} : { distance: item.distance }),
    ...(item.pace === undefined ? {} : { pace: item.pace }), ...(item.speed === undefined ? {} : { speed: item.speed }),
    ...(item.splits === undefined ? {} : { splits: item.splits }), ...(item.splitCoverage === undefined ? {} : { splitCoverage: item.splitCoverage }) }),
    snapshot: s.exerciseSnapshot.parse(item.snapshot) }));
}
function safePlan(value: ActivityPlanSnapshot) {
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 50) throw new DomainError(503, 'account_export_invalid_data');
  return { id: value.id, revision: value.revision, name: value.name, minutes: value.minutes, archived: value.archived,
    origin: value.origin.kind === 'legacyPlan' ? { kind: 'legacyPlan', id: value.origin.id, revision: value.origin.revision } : { kind: 'manual' },
    items: value.items.map(item => ({ ...s.planItem.parse({ id: item.id, exercise: item.exercise, target: item.target }), snapshot: s.exerciseSnapshot.parse(item.snapshot) })),
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(value.legacySnapshot ? { legacySnapshot: s.legacyPlanSnapshot.parse(value.legacySnapshot) } : {}) };
}
function safeDay(value: PlanDaySnapshot) {
  return { localDate: value.localDate, revision: value.revision, timeZone: value.timeZone, dayStartAt: value.dayStartAt, dayEndAt: value.dayEndAt,
    calendarPolicy: value.calendarPolicy, scheduleId: value.scheduleId, scheduleRevision: value.scheduleRevision, expectation: value.expectation,
    planSnapshot: value.planSnapshot ? safePlan(value.planSnapshot) : null, origin: value.origin, supersedesRevision: value.supersedesRevision };
}
export function createActivityLifecycleAdapter(service: ActivityService): LifecycleAdapter {
  const { db, lifecycleControl } = service.deps;
  const exportRowLimit = 512 * 1024;
  const exportSourceLimit = 16 * 1024 * 1024;
  const rows = (table: typeof activityOwnedTables[number], accountId: string): Iterable<{ oversized: number; bytes: number; data: string | null }> =>
    db.prepare(`SELECT length(CAST(data AS BLOB)) AS bytes,
      length(CAST(data AS BLOB))>@rowLimit AS oversized,
      CASE WHEN length(CAST(data AS BLOB))<=@rowLimit THEN data ELSE NULL END AS data
      FROM ${table} WHERE account_id=@accountId`).iterate({ accountId, rowLimit: exportRowLimit }) as Iterable<{ oversized: number; bytes: number; data: string | null }>;
  const count = (accountId: string) => activityOwnedTables.reduce((sum, table) => sum +
    (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId) as { n: number }).n, 0);
  const receiptCount = (accountId: string) => (db.prepare("SELECT count(*) AS n FROM command_receipts WHERE account_id=? AND operation LIKE 'activity.%'")
    .get(accountId) as { n: number }).n;
  const verify = (accountId: string, epoch: number): LifecycleResult => {
    if (!lifecycleControl?.assertSuppression) return failure('canonical_suppression_binding_required');
    try {
      lifecycleControl.assertSuppression(accountId, epoch);
      return { status: 'complete', reason: 'canonical_suppression_confirmed_synchronous_module_has_no_async_workers' };
    } catch { return { status: 'unknown', reason: 'canonical_suppression_unproved' }; }
  };
  return {
    category,
    inventory(context: AccountContext) {
      return service.read(context, () => ({ status: 'complete', category, count: count(context.accountId), reason: 'all_activity_source_rows_shared_receipts_remain_backend_owned' }));
    },
    export(context, snapshot) {
      if (!snapshot?.append || !Number.isFinite(snapshot.snapshotAtMs)) return { ...failure('bounded_export_snapshot_required'), category };
      return service.read(context, () => {
        let sourceBytes = 0, parsedSourceBytes = 0, exported = 0;
        const manifest = Object.fromEntries(activityOwnedTables.map(table => [table, (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(context.accountId) as { n: number }).n]));
        for (const table of activityOwnedTables) {
          if (table === 'activity_state') continue;
          const size = db.prepare(`SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM ${table} WHERE account_id=?`)
            .get(context.accountId) as { bytes: number };
          sourceBytes += size.bytes;
          if (!Number.isSafeInteger(sourceBytes) || sourceBytes > exportSourceLimit)
            throw new DomainError(413, 'account_export_packaging_required');
        }
        const decode = <T>(row: { oversized: number; bytes: number; data: string | null }): T => {
          if (row.oversized || row.data === null || row.bytes > exportRowLimit || row.bytes > exportSourceLimit - parsedSourceBytes)
            throw new DomainError(413, 'account_export_packaging_required');
          parsedSourceBytes += row.bytes;
          try { return JSON.parse(row.data) as T; }
          catch { throw new DomainError(503, 'account_export_invalid_data'); }
        };
        const append = (kind: string, data: unknown) => {
          service.assertActive(context);
          snapshot.append('activity', { kind, data }); exported++;
          service.assertActive(context);
        };
        for (const table of ['activity_exercises', 'activity_exercise_revisions'] as const)
          for (const row of rows(table, context.accountId)) append(table, safeExercise(decode<PersonalExercise>(row)));
        for (const table of ['activity_plans', 'activity_plan_revisions'] as const)
          for (const row of rows(table, context.accountId)) append(table, safePlan(decode<ActivityPlanSnapshot>(row)));
        for (const table of ['activity_entries', 'activity_entry_revisions'] as const) for (const row of rows(table, context.accountId)) {
          const value = decode<ActivityEntry>(row);
          if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 50) throw new DomainError(503, 'account_export_invalid_data');
          const fields = s.activityWrite.parse({ date: value.date, kind: value.kind, items: value.items.map(x => { const { snapshot: _, ...item } = x; return item; }),
            performedConfirmed: value.performedConfirmed, source: value.source, draftId: value.draftId, acknowledgedIssues: value.acknowledgedIssues });
          append(table, { ...fields, id: value.id, revision: value.revision, status: value.status, items: safeItems(value.items), createdAt: value.createdAt, updatedAt: value.updatedAt });
        }
        for (const table of ['activity_schedules', 'activity_schedule_revisions'] as const) for (const row of rows(table, context.accountId)) {
          const value = decode<ScheduleRevision>(row);
          if (!Array.isArray(value.week) || value.week.length !== 7) throw new DomainError(503, 'account_export_invalid_data');
          append(table, { id: value.id, revision: value.revision, effectiveFrom: value.effectiveFrom, timeZone: value.timeZone, createdAt: value.createdAt,
            week: value.week.map(day => ({ isoWeekday: day.isoWeekday, expectation: day.expectation, planSnapshot: day.planSnapshot ? safePlan(day.planSnapshot) : null })) });
        }
        for (const table of ['activity_days', 'activity_day_revisions'] as const) for (const row of rows(table, context.accountId)) append(table, safeDay(decode<PlanDaySnapshot>(row)));
        for (const row of rows('activity_calendar', context.accountId)) {
          const calendar = decode<import('./types.js').ActivityCalendar>(row);
          append('activity_calendar', { timeZone: calendar.timeZone, activationDate: calendar.activationDate, revision: calendar.revision,
            calendarPolicy: calendar.calendarPolicy, createdAt: calendar.createdAt });
        }
        append('activity_manifest', { tables: manifest, sharedReceiptCount: receiptCount(context.accountId), omissions: ['shared_receipts_backend_owned', 'global_catalog', 'legacy_history_backend_owned', 'credentials', 'assessment_or_coach_data', 'transcripts'], exportRowLimitBytes: exportRowLimit, exportSourceLimitBytes: exportSourceLimit, oversizedRowPolicy: 'reject_packaging_required_no_complete_partial_export', sourceGeneration: (db.prepare('SELECT generation FROM activity_state WHERE account_id=?').get(context.accountId) as { generation: number } | undefined)?.generation ?? 0 });
        service.assertActive(context);
        return { status: 'complete', category, count: exported, reason: 'sanitized_owned_activity_only_no_receipts_or_private_provider_content' };
      });
    },
    suppress(accountId, epoch) {
      if (!db.inTransaction) return failure('root_ledger_first_writer_transaction_required');
      if (!Number.isSafeInteger(epoch) || epoch < 0) return failure('invalid_suppression_epoch');
      try {
        lifecycleControl.assertSuppression(accountId, epoch);
        return verify(accountId, epoch);
      } catch { return { status: 'pending', reason: 'activity_suppression_not_confirmed' }; }
    },
    purge(requestId, accountId) {
      if (!db.inTransaction) return failure('trusted_lifecycle_writer_transaction_required');
      if (!lifecycleControl?.purgeReadiness) return failure('source_purge_not_qualified');
      const readiness = lifecycleControl.purgeReadiness(requestId, accountId);
      if (readiness.status !== 'ready') return readiness;
      if (verify(accountId, readiness.epoch).status !== 'complete') return { status: 'pending', reason: 'suppression_required_before_purge' };
      let deleted = 0;
      // Root controls this transaction. Throwing on readback failure prevents an apparent successful partial purge.
      for (const table of activityPurgeOrder) deleted += db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
      const remaining = count(accountId);
      if (remaining !== 0 || verify(accountId, readiness.epoch).status !== 'complete') throw new Error('activity_purge_readback_failed');
      return receiptCount(accountId) > 0
        ? { status: 'retained', count: deleted, reason: 'activity_source_rows_absent_shared_activity_receipts_remain_backend_owned' }
        : { status: 'complete', count: deleted, reason: 'activity_source_rows_only_whole_account_deletion_not_asserted' };
    },
    verifySuppressed: verify,
  };
}
