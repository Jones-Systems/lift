import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DomainError } from '../../src/errors.js';
import { migrations } from '../../src/storage.js';
import { activityMigrationSql, activityOwnedTables, createActivityService, type ActivityEntry, type ActivityPlanSnapshot, type PersonalExercise } from '../../src/activity/index.js';
import { fixture, entryInput, personalFields, unknownLoad, week, planItems } from './fixture.js';

const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test('additive SQL preserves existing global catalog/legacy tables; all module objects prefixed and FKs scoped', t => {
  const f = fixture(); t.after(() => f.db.close());
  assert.equal(migrations.filter(x => x.version <= 7).length, 7);
  assert.equal(count(f.db, 'exercises'), 1);
  assert.equal(count(f.db, 'plans'), 0);
  const objects = f.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'activity_%'").all() as { name: string }[];
  assert.ok(objects.length >= activityOwnedTables.length);
  const foreignKeys = f.db.prepare('PRAGMA foreign_key_list(activity_entry_revisions)').all() as { table: string; from: string; to: string }[];
  assert.deepEqual(foreignKeys.map(x => [x.table, x.from, x.to]), [['activity_entries', 'account_id', 'account_id'], ['activity_entries', 'entry_id', 'id']]);
  const a = f.contexts.A, b = f.contexts.B;
  const exercise = f.service.createExercise(a, 'create', personalFields).body as PersonalExercise;
  assert.throws(() => f.db.prepare('INSERT INTO activity_exercise_revisions(account_id,exercise_id,revision,data) VALUES (?,?,2,?)')
    .run(b.accountId, exercise.id, '{}'), /FOREIGN KEY/);
  assert.throws(() => f.db.prepare('UPDATE activity_exercise_revisions SET data=? WHERE account_id=?').run('{}', a.accountId), /activity_immutable_history/);
});
test('failed migration transaction rolls back all activity SQL objects', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY)');
    assert.throws(() => db.transaction(() => { db.exec(activityMigrationSql); db.exec('CREATE TABLE activity_state(bad TEXT)'); }).immediate());
    assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'activity_%'").get() as { n: number }).n, 0);
  } finally { db.close(); }
});
test('owner isolation, strict schemas and unbound lifecycle fail closed before receipts', t => {
  const f = fixture(); t.after(() => f.db.close());
  const value = f.service.createExercise(f.contexts.A, 'create', personalFields).body as PersonalExercise;
  assert.throws(() => f.service.exercise(f.contexts.B, value.id), errorCode('not_found'));
  assert.throws(() => f.service.patchExercise(f.contexts.B, value.id, 'patch', { ...personalFields, expectedRevision: 1 }), errorCode('not_found'));
  assert.throws(() => f.service.createExercise(f.contexts.A, 'forbidden', { ...personalFields, accountId: f.contexts.B.accountId }), errorCode('invalid_request'));
  assert.equal(count(f.db, 'command_receipts'), 1);
  assert.throws(() => createActivityService({ ...f.deps, lifecycle: undefined! }), errorCode('activity_bindings_required'));
  assert.throws(() => f.service.exercise({ ...f.contexts.A, sessionId: f.contexts.B.sessionId }, value.id), errorCode('account_session_invalid'));
});
test('personal edits and retirement preserve frozen log and plan snapshots', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  const custom = f.service.createExercise(a, 'exercise', personalFields).body as PersonalExercise;
  const items = [{ id: 'personal-item', exercise: { source: 'personal', id: custom.id, revision: 1 }, load: unknownLoad }];
  const log = f.service.createEntry(a, 'log', { ...entryInput('draft'), items }).body as ActivityEntry;
  const plan = f.service.createPlan(a, 'plan', { name: 'Private plan', items: items.map(item => ({ id: item.id, exercise: item.exercise, target: { load: item.load } })) }).body as ActivityPlanSnapshot;
  const changed = f.service.patchExercise(a, custom.id, 'rename', { ...personalFields, name: 'Renamed press', kind: 'timed', expectedRevision: 1 }).body as PersonalExercise;
  assert.equal(changed.revision, 2);
  assert.equal(f.service.entry(a, log.id).items[0]?.snapshot.name, personalFields.name);
  assert.equal(f.service.plan(a, plan.id).items[0]?.snapshot.kind, 'resistance');
  assert.equal(f.service.catalog(a).items.find(x => x.ref.id === custom.id)?.name, 'Renamed press');
  assert.equal(f.service.catalog(a).items.find(x => x.ref.id === custom.id)?.cueStatus, 'unknown');
  f.service.retireExercise(a, custom.id, 'retire', { expectedRevision: 2 });
  assert.equal(f.service.catalog(a).items.some(x => x.ref.id === custom.id), false);
  const correction = f.service.patchEntry(a, log.id, 'edit-old', { ...entryInput('draft'), items, expectedRevision: 1 }).body as ActivityEntry;
  assert.equal(correction.items[0]?.snapshot.name, personalFields.name);
  assert.throws(() => f.service.createEntry(a, 'new-retired', { ...entryInput('new-draft'), items }), errorCode('exercise_retired'));
  assert.throws(() => f.service.createEntry(f.contexts.B, 'cross-owner', { ...entryInput('b-draft'), items }), errorCode('activity_calendar_required'));
  assert.equal(count(f.db, 'activity_exercise_revisions'), 3);
});
test('minimum single exercise, known zero, forgotten quantities and running duration keep only reported facts', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  const minimal = f.service.createEntry(a, 'minimal', entryInput('minimal')).body as ActivityEntry;
  assert.equal(minimal.items[0]?.sets, undefined); assert.equal(minimal.items[0]?.reportedSetCount, undefined);
  assert.deepEqual(minimal.items[0]?.load, unknownLoad);
  const withZero = { ...entryInput('zero'), items: [{ ...entryInput('zero').items[0]!, reportedSetCount: 3,
    load: { state: 'knownValue', value: 0, unit: 'kg', basis: 'unspecified' } }] };
  const zero = f.service.createEntry(a, 'zero', withZero).body as ActivityEntry;
  assert.deepEqual(zero.items[0]?.load, { state: 'knownValue', value: 0, unit: 'kg', basis: 'unspecified' });
  assert.equal(zero.items[0]?.sets, undefined);
  const run = f.service.createExercise(a, 'run-exercise', { ...personalFields, name: 'Running', kind: 'run', measurementType: 'duration', loadApplicability: 'notApplicable' }).body as PersonalExercise;
  const runItem = { id: 'run-item', exercise: { source: 'personal', id: run.id, revision: 1 },
    load: { state: 'notApplicable', reason: 'timedActivity' }, durationSeconds: 3360, pace: { secondsPerUnit: 510, unit: 'mi' } };
  const saved = f.service.createEntry(a, 'run', { ...entryInput('run-draft'), items: [runItem] }).body as ActivityEntry;
  assert.equal(saved.items[0]?.durationSeconds, 3360); assert.equal(saved.items[0]?.distance, undefined);
  const { durationSeconds: _, ...missingDuration } = runItem;
  assert.throws(() => f.service.createEntry(a, 'run-missing', { ...entryInput('missing'), items: [missingDuration] }), errorCode('run_duration_and_load_required'));
  const conflict = { ...entryInput('conflict'), items: [{ ...runItem, distance: { value: 1, unit: 'mi' } }] };
  assert.throws(() => f.service.createEntry(a, 'conflict', conflict), errorCode('activity_metric_review_required'));
  const approximate = f.service.createEntry(a, 'conflict-reviewed', { ...conflict, acknowledgedIssues: [{ fieldPath: 'items[0]', code: 'approximateMetrics' }] }).body as ActivityEntry;
  assert.deepEqual(approximate.items[0]?.distance, { value: 1, unit: 'mi' });
});
test('receipt replay precedes stale revision checks; draft identities deduplicate changed keys', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  const input = entryInput('one-draft');
  const first = f.service.createEntry(a, 'create-one', input);
  assert.deepEqual(f.service.createEntry(a, 'create-one', input), first);
  const duplicate = f.service.createEntry(a, 'create-two', input);
  assert.deepEqual(duplicate.body, first.body); assert.equal(count(f.db, 'activity_entries'), 1);
  assert.throws(() => f.service.createEntry(a, 'create-one', { ...input, kind: 'exerciseSnack' }), errorCode('idempotency_mismatch'));
  assert.throws(() => f.service.createEntry(a, 'create-three', { ...input, kind: 'exerciseSnack' }), errorCode('draft_identity_conflict'));
  const log = first.body as ActivityEntry;
  const patch = { ...input, expectedRevision: 1, kind: 'exerciseSnack' };
  const edited = f.service.patchEntry(a, log.id, 'patch', patch);
  assert.deepEqual(f.service.patchEntry(a, log.id, 'patch', patch), edited);
  assert.throws(() => f.service.patchEntry(a, log.id, 'stale', patch), errorCode('stale_revision'));
  assert.throws(() => f.service.patchEntry(a, log.id, 'reuse-item', { ...patch, expectedRevision: 2,
    items: [{ ...input.items[0]!, exercise: { source: 'global', id: 'missing-global' } }] }), errorCode('not_found'));
  const nextInput = { ...input, draftId: 'other-draft' };
  f.service.createEntry(a, 'other', nextInput); assert.equal(count(f.db, 'activity_entries'), 2);
});
test('date provenance, future rejection, fixed zone, pre-schedule history and GET purity', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  assert.throws(() => f.service.createCalendar(a, 'different-zone', { timeZone: 'UTC', confirmed: true }), errorCode('activity_calendar_fixed'));
  const saved = f.service.createEntry(a, 'old', entryInput('old', '2025-01-01')).body as ActivityEntry;
  assert.equal(saved.date.localDate, '2025-01-01');
  assert.equal(f.service.adherence(a, { from: '2025-01-01', to: '2025-01-01' }).days[0]?.actual, 'unknown');
  assert.throws(() => f.service.createEntry(a, 'future', entryInput('future', '2026-10-02')), errorCode('future_activity_date'));
  assert.throws(() => f.service.createEntry(a, 'wrong-reference', { ...entryInput('wrong-ref'), date: { ...entryInput('wrong-ref').date, referenceLocalDate: '2026-09-30' } }), errorCode('date_review_required'));
  assert.throws(() => f.service.createEntry(a, 'clock', { ...entryInput('clock'), date: { ...entryInput('clock').date, source: 'spokenRelative', capturedAt: '2026-10-02T16:00:00Z', referenceLocalDate: '2026-10-02' } }), errorCode('date_review_required'));
  const before = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  f.service.catalog(a); f.service.calendar(a); f.service.entries(a, { from: '2025-01-01', to: '2026-01-01' });
  f.service.adherence(a, { from: '2026-09-29', to: '2026-10-01' });
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, before);
});
test('dated schedules and template changes keep immutable past plan snapshots, explicit correction appends', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  const plan = f.service.createPlan(a, 'plan', { name: 'Before', items: planItems() }).body as ActivityPlanSnapshot;
  f.service.writeSchedule(a, 'schedule', { expectedRevision: 0, effectiveFrom: '2026-10-01', week: week().map(x => ({ ...x, plan: x.expectation === 'rest' ? null : { id: plan.id, revision: 1 } })) });
  f.service.patchPlan(a, plan.id, 'rename', { name: 'After', items: plan.items.map(x => { const { snapshot: _, ...item } = x; return item; }), expectedRevision: 1 });
  f.setNow('2026-10-06T16:00:00Z');
  const before = f.service.adherence(a, { from: '2026-10-01', to: '2026-10-05' });
  assert.equal(before.days[0]?.planDay?.planSnapshot?.name, 'Before');
  f.service.correctDay(a, '2026-10-03', 'day-correct', { expectedRevision: 1, expectation: 'rest', plan: null, reason: 'scheduleWasIncorrect', confirmed: true });
  const changed = f.service.adherence(a, { from: '2026-10-03', to: '2026-10-03' }).days[0];
  assert.equal(changed?.planDay?.revision, 2); assert.equal(changed?.planDay?.origin, 'explicitDayCorrection');
  assert.equal(count(f.db, 'activity_day_revisions'), 3);
  assert.throws(() => f.service.writeSchedule(a, 'retroactive', { expectedRevision: 1, effectiveFrom: '2026-10-02', week: week() }), errorCode('schedule_must_be_prospective'));
  f.service.writeSchedule(a, 'prospective', { expectedRevision: 1, effectiveFrom: '2026-10-07', week: week(4) });
  assert.equal(f.service.adherence(a, { from: '2026-10-01', to: '2026-10-01' }).days[0]?.planDay?.planSnapshot?.name, 'Before');
});
test('backdate/void recomputes current, longest and earliest eligible monthly allocation', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  f.service.writeSchedule(a, 'schedule', { expectedRevision: 0, effectiveFrom: '2026-10-01', week: week(5) });
  f.service.createEntry(a, 'oct1', entryInput('oct1')); f.setNow('2026-10-06T16:00:00Z');
  f.service.createEntry(a, 'oct4', entryInput('oct4', '2026-10-04'));
  const range = { from: '2026-10-01', to: '2026-10-06' };
  const before = f.service.adherence(a, range);
  assert.equal(before.currentPlanDays, 0); assert.equal(before.longestPlanDays, 4);
  const repaired = f.service.createEntry(a, 'oct3', entryInput('oct3', '2026-10-03')).body as ActivityEntry;
  const after = f.service.adherence(a, range);
  assert.equal(after.currentPlanDays, 5); assert.equal(after.longestPlanDays, 5); assert.equal(after.monthlyAllowance.protectedDate, '2026-10-05');
  f.service.voidEntry(a, repaired.id, 'void', { expectedRevision: 1 });
  const undone = f.service.adherence(a, range);
  assert.equal(undone.currentPlanDays, before.currentPlanDays); assert.equal(undone.longestPlanDays, before.longestPlanDays);
  assert.equal(undone.monthlyAllowance.protectedDate, before.monthlyAllowance.protectedDate);
});
test('exact legacy import is origin-deduplicated and legacy corrections are read fresh without legacy mutations', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  f.legacyPlans.set(`${a.accountId}/legacy-plan/3`, { id: 'legacy-plan', revision: 3, name: 'Legacy exact', minutes: 30, archived: false,
    items: [{ id: 'legacy-item', exerciseId: 'global-press', setTarget: 3, repMin: 8, repMax: 12, targetKg: 0 }] });
  const imported = f.service.importLegacyPlan(a, 'import', { planId: 'legacy-plan', revision: 3 }).body as ActivityPlanSnapshot;
  const again = f.service.importLegacyPlan(a, 'import-two', { planId: 'legacy-plan', revision: 3 }).body as ActivityPlanSnapshot;
  assert.equal(again.id, imported.id); assert.equal(count(f.db, 'activity_plans'), 1);
  assert.equal(imported.legacySnapshot?.items[0]?.repMin, 8); assert.equal(imported.legacySnapshot?.items[0]?.targetKg, 0);
  assert.throws(() => f.service.importLegacyPlan(f.contexts.B, 'foreign', { planId: 'legacy-plan', revision: 3 }), errorCode('not_found'));
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  f.service.writeSchedule(a, 'schedule', { expectedRevision: 0, effectiveFrom: '2026-10-01', week: week() });
  f.setEvidence([{ sessionId: 'legacy-complete', sessionRevision: 1, localDate: '2026-10-01', dateBasis: 'startedAt_in_confirmed_zone', hasConfirmedPerformance: false }]);
  assert.equal(f.service.adherence(a, { from: '2026-10-01', to: '2026-10-01' }).days[0]?.state, 'pending');
  f.setEvidence([{ sessionId: 'legacy-complete', sessionRevision: 2, localDate: '2026-10-01', dateBasis: 'startedAt_in_confirmed_zone', hasConfirmedPerformance: true }]);
  assert.equal(f.service.adherence(a, { from: '2026-10-01', to: '2026-10-01' }).currentPlanDays, 1);
  f.setEvidence([]); assert.equal(f.service.adherence(a, { from: '2026-10-01', to: '2026-10-01' }).currentPlanDays, 0);
  assert.equal(count(f.db, 'workout_sessions'), 0); assert.equal(count(f.db, 'performed_sets'), 0);
});
test('trusted no-save flow rejects innocuous derived text/numbers before any receipt or catalog writes', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  const before = count(f.db, 'command_receipts'); f.setFlow('noSaveBody');
  assert.throws(() => f.service.createExercise(a, 'derived-name', { ...personalFields, name: 'Safe-looking movement' }), errorCode('activity_dataflow_not_persistable'));
  assert.throws(() => f.service.createEntry(a, 'derived-number', entryInput('derived-number')), errorCode('activity_dataflow_not_persistable'));
  assert.throws(() => f.service.createPlan(a, 'derived-plan', { name: 'Independent looking', items: planItems() }), errorCode('activity_dataflow_not_persistable'));
  assert.equal(count(f.db, 'command_receipts'), before); assert.equal(count(f.db, 'activity_exercises'), 0); assert.equal(count(f.db, 'activity_entries'), 0);
  f.setFlow('independent');
  assert.throws(() => f.service.createEntry(a, 'raw', { ...entryInput('raw'), bodyAssessment: 'SYNTHETIC_NO_SAVE_MARKER' }), errorCode('invalid_request'));
  const dump = JSON.stringify(f.db.prepare('SELECT * FROM command_receipts').all());
  assert.equal(dump.includes('SYNTHETIC_NO_SAVE_MARKER'), false);
});
