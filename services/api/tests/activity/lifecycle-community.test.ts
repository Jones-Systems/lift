import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../../src/errors.js';
import { createActivityService, createActivityLifecycleAdapter, createActivityCommunityReader, activityOwnedTables,
  type ActivityEntry, type PersonalExercise, type ActivityPlanSnapshot, type CommunityReadInput } from '../../src/activity/index.js';
import { fixture, personalFields, entryInput, planItems, week } from './fixture.js';

const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;
function readerFixture(afterEvidence?: () => void) {
  const f = fixture(); const viewer = f.contexts.B, subject = f.contexts.A;
  const legacy = f.deps.legacy!;
  const service = afterEvidence ? createActivityService({ ...f.deps, legacy: { ...legacy,
    listCompletedEvidence(...args) {
      const evidence = legacy.listCompletedEvidence(...args);
      afterEvidence();
      return evidence;
    },
  } }) : f.service;
  let allowed = true;
  const reader = createActivityCommunityReader({ service, viewer, lifecycle: f.lifecycle,
    trustedContext(request) {
      if (!allowed || request.subjectAccountId !== subject.accountId) return null;
      return { subjectAccountId: subject.accountId,
        assertSubjectActive() { if (f.disabled.has(subject.accountId)) throw new Error('disabled subject'); },
        assertAuthorized(input) { if (!allowed || input.subjectAccountId !== subject.accountId) throw new Error('revoked grant'); },
      };
    },
  });
  return { ...f, service, viewer, subject, reader, revoke() { allowed = false; } };
}
test('Community rejects subject midnight during projection and a stable retry closes the same rest day', t => {
  let advance = false;
  const f = readerFixture(() => { if (advance) f.setNow('2026-10-03T04:00:00Z'); });
  t.after(() => f.db.close());
  f.service.createCalendar(f.subject, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  f.service.writeSchedule(f.subject, 'schedule', { expectedRevision: 0, effectiveFrom: '2026-10-01', week: week(5) });
  f.setNow('2026-10-03T03:59:59Z');
  const request: CommunityReadInput = { subjectAccountId: f.subject.accountId, from: '2026-10-02', to: '2026-10-02', fields: ['planAdherence'] };
  const before = f.reader.readDays(request);
  if (before.status !== 'available') assert.fail('missing current rest-day projection');
  assert.equal(before.days[0]?.planAdherence, 'pending');
  advance = true;
  const crossing = f.reader.readDays(request);
  advance = false;
  const after = f.reader.readDays(request);
  if (after.status !== 'available') assert.fail('missing closed rest-day projection');
  assert.equal(after.days[0]?.localDate, '2026-10-02');
  assert.equal(after.days[0]?.planAdherence, 'met');
  assert.deepEqual(crossing, { status: 'unavailable' });
});
for (const [name, before, after] of [
  ['within the same subject day', '2026-10-02T16:00:00Z', '2026-10-02T16:00:01Z'],
  ['across UTC midnight within the same subject day', '2026-10-02T23:59:59Z', '2026-10-03T00:00:00Z'],
] as const) {
  test(`Community preserves available projection ${name}`, t => {
    let advance = false;
    const f = readerFixture(() => { if (advance) f.setNow(after); });
    t.after(() => f.db.close());
    f.service.createCalendar(f.subject, 'calendar', { timeZone: 'America/New_York', confirmed: true });
    f.service.writeSchedule(f.subject, 'schedule', { expectedRevision: 0, effectiveFrom: '2026-10-01', week: week(5) });
    f.setNow(before);
    const request: CommunityReadInput = { subjectAccountId: f.subject.accountId, from: '2026-10-02', to: '2026-10-02', fields: ['planAdherence'] };
    const stable = f.reader.readDays(request);
    if (stable.status !== 'available') assert.fail('missing stable rest-day projection');
    assert.equal(stable.days[0]?.planAdherence, 'pending');
    advance = true;
    assert.deepEqual(f.reader.readDays(request), stable);
  });
}
test('Community exact masks, actual not_met on protected day, known rest and no private fields', t => {
  const f = readerFixture(); t.after(() => f.db.close());
  f.service.createCalendar(f.subject, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  f.service.writeSchedule(f.subject, 'schedule', { expectedRevision: 0, effectiveFrom: '2026-10-01', week: week(5) });
  f.service.createEntry(f.subject, 'private', entryInput('one')); f.setNow('2026-10-04T16:00:00Z');
  const before = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const value = f.reader.readDays({ subjectAccountId: f.subject.accountId, from: '2026-10-01', to: '2026-10-04', fields: ['workout', 'planAdherence', 'streakDays'] });
  assert.equal(value.status, 'available'); if (value.status !== 'available') return;
  assert.equal(value.days[0]?.workout, 'recorded'); assert.equal(value.days[1]?.planAdherence, 'met');
  assert.equal(value.days[2]?.planAdherence, 'not_met'); assert.equal(value.days[2]?.workout, 'not_recorded');
  assert.equal(value.days[0]?.streakDays, undefined); assert.equal(value.days[2]?.streakDays, undefined);
  assert.equal(value.days[3]?.streakDays, 3);
  assert.deepEqual(Object.keys(value.days[0]!).sort(), ['dayEndAt', 'dayStartAt', 'localDate', 'planAdherence', 'revision', 'timeZone', 'workout'].sort());
  const serialized = JSON.stringify(value);
  for (const forbidden of ['Global press', 'global-press', 'snapshot', 'allowance', 'protectedMiss', 'form-A', 'session-A', 'load', 'items']) assert.equal(serialized.includes(forbidden), false);
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, before);
});
test('requested base verdicts present unknown, unavailable context/calendar/subject and revoked viewer fail closed', t => {
  const f = readerFixture(); t.after(() => f.db.close());
  const request: CommunityReadInput = { subjectAccountId: f.subject.accountId, from: '2026-09-30', to: '2026-10-01', fields: ['workout', 'exerciseSnack', 'planAdherence', 'streakDays'] };
  assert.deepEqual(f.reader.readDays(request), { status: 'unavailable' });
  f.service.createCalendar(f.subject, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  const value = f.reader.readDays(request); assert.equal(value.status, 'available');
  if (value.status === 'available') {
    assert.equal(value.days[0]?.workout, 'not_recorded'); assert.equal(value.days[0]?.exerciseSnack, 'not_recorded');
    assert.equal(value.days[0]?.planAdherence, 'unknown'); assert.equal(value.days[0]?.streakDays, undefined);
    assert.equal(value.days[1]?.planAdherence, 'unknown');
    assert.equal(value.days[0]?.timeZone, 'America/New_York'); assert.ok(value.days[0]?.dayStartAt);
  }
  assert.deepEqual(f.reader.readDays({ ...request, subjectAccountId: f.contexts.C.accountId }), { status: 'unavailable' });
  assert.deepEqual(f.reader.readDays({ ...request, fields: ['privateBody' as never] }), { status: 'unavailable' });
  f.revoke(); assert.deepEqual(f.reader.readDays(request), { status: 'unavailable' });
});
test('subject need not be signed in; subject canonical disable still denies and viewer session is maintained', t => {
  const f = readerFixture(); t.after(() => f.db.close());
  f.service.createCalendar(f.subject, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.subject.sessionId);
  const request: CommunityReadInput = { subjectAccountId: f.subject.accountId, from: '2026-10-01', to: '2026-10-01', fields: ['workout'] };
  assert.equal(f.reader.readDays(request).status, 'available');
  f.disabled.set(f.subject.accountId, 1); assert.equal(f.reader.readDays(request).status, 'unavailable');
  f.disabled.delete(f.subject.accountId); f.db.prepare('DELETE FROM session WHERE id=?').run(f.viewer.sessionId);
  assert.equal(f.reader.readDays(request).status, 'unavailable');
});
test('optional details only complete elapsed/occurrence coverage; minimal legacy evidence never fabricated zero', t => {
  const f = readerFixture(); t.after(() => f.db.close());
  f.service.createCalendar(f.subject, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  const exercise = f.service.createExercise(f.subject, 'run-exercise', { ...personalFields, name: 'Running', kind: 'run', measurementType: 'duration', loadApplicability: 'notApplicable' }).body as PersonalExercise;
  f.service.createEntry(f.subject, 'run', { ...entryInput('run'), items: [{ id: 'run', exercise: { source: 'personal', id: exercise.id, revision: 1 }, load: { state: 'notApplicable', reason: 'timedActivity' }, durationSeconds: 3360 }] });
  const request: CommunityReadInput = { subjectAccountId: f.subject.accountId, from: '2026-10-01', to: '2026-10-01', fields: ['workoutMinutes', 'exerciseCount'] };
  let value = f.reader.readDays(request); if (value.status !== 'available') assert.fail('missing projection');
  assert.equal(value.days[0]?.workoutMinutes, 56); assert.equal(value.days[0]?.exerciseCount, 1);
  f.service.createEntry(f.subject, 'mixed', entryInput('mixed'));
  value = f.reader.readDays(request); if (value.status !== 'available') assert.fail('missing projection');
  assert.equal(value.days[0]?.workoutMinutes, undefined); assert.equal(value.days[0]?.exerciseCount, 2);
  f.setEvidence([{ sessionId: 'legacy', sessionRevision: 1, localDate: '2026-10-01', dateBasis: 'startedAt_in_confirmed_zone', hasConfirmedPerformance: true }]);
  value = f.reader.readDays(request); if (value.status !== 'available') assert.fail('missing projection');
  assert.equal(value.days[0]?.workoutMinutes, undefined); assert.equal(value.days[0]?.exerciseCount, undefined);
  f.setEvidence([{ sessionId: 'legacy', sessionRevision: 2, localDate: '2026-10-01', dateBasis: 'startedAt_in_confirmed_zone', hasConfirmedPerformance: true, confirmedOccurrenceCount: 3 }]);
  value = f.reader.readDays(request); if (value.status !== 'available') assert.fail('missing projection');
  assert.equal(value.days[0]?.exerciseCount, 5);
});
test('recorded DST metadata is exact and whole skipped civil dates unavailable', t => {
  const f = readerFixture(); t.after(() => f.db.close());
  f.service.createCalendar(f.subject, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  const dst = f.reader.readDays({ subjectAccountId: f.subject.accountId, from: '2026-03-08', to: '2026-03-08', fields: ['planAdherence'] });
  if (dst.status !== 'available') assert.fail('missing DST projection');
  assert.equal(dst.days[0]?.dayStartAt, '2026-03-08T05:00:00.000Z'); assert.equal(dst.days[0]?.dayEndAt, '2026-03-09T04:00:00.000Z');
  const second = createActivityService({ ...f.deps });
  second.createCalendar(f.contexts.C, 'apia', { timeZone: 'Pacific/Apia', confirmed: true });
  const reader = createActivityCommunityReader({ service: second, viewer: f.viewer, lifecycle: f.lifecycle,
    trustedContext: () => ({ subjectAccountId: f.contexts.C.accountId, assertAuthorized() {}, assertSubjectActive() {} }) });
  assert.equal(reader.readDays({ subjectAccountId: f.contexts.C.accountId, from: '2011-12-30', to: '2011-12-30', fields: ['workout'] }).status, 'unavailable');
});
test('canonical disable blocks reads, writes, replay and export; internal adapters never invent active disabled context', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  const adapter = createActivityLifecycleAdapter(f.service);
  const created = f.service.createExercise(a, 'create', personalFields).body as PersonalExercise;
  const before = adapter.inventory(a); assert.equal(before.category, 'activity'); assert.equal(before.status, 'complete');
  assert.equal(adapter.suppress(a.accountId, 1).status, 'unavailable');
  f.disabled.set(a.accountId, 1);
  const suppressed = f.db.transaction(() => adapter.suppress(a.accountId, 1)).immediate(); assert.equal(suppressed.status, 'complete');
  assert.equal(adapter.verifySuppressed(a.accountId, 1).status, 'complete');
  assert.throws(() => f.service.exercise(a, created.id), code('account_disabled'));
  assert.throws(() => f.service.createExercise(a, 'create', personalFields), code('account_disabled'));
  assert.throws(() => f.service.createExercise(a, 'new', personalFields), code('account_disabled'));
  assert.throws(() => adapter.export(a, { snapshotAtMs: 0, append() {} }), code('account_disabled'));
  assert.equal(adapter.verifySuppressed(a.accountId, 2).status, 'unknown');
  assert.deepEqual(f.db.prepare('PRAGMA table_info(activity_state)').all().map(row => (row as { name: string }).name), ['account_id', 'generation']);
});
test('scoped export streams exact category and all personal/history fields; caller append budget failure propagates', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A, b = f.contexts.B;
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  const created = f.service.createExercise(a, 'create', personalFields).body as PersonalExercise;
  f.service.patchExercise(a, created.id, 'patch', { ...personalFields, name: 'Updated', measurementType: 'duration', expectedRevision: 1 });
  f.service.createExercise(b, 'create-b', { ...personalFields, name: 'OTHER_ACCOUNT_MARKER' });
  const plan = f.service.createPlan(a, 'plan', { name: 'Plan', minutes: null, items: planItems() }).body as ActivityPlanSnapshot;
  f.service.writeSchedule(a, 'schedule', { expectedRevision: 0, effectiveFrom: '2026-10-01', week: week().map(x => ({ ...x, plan: x.expectation === 'rest' ? null : { id: plan.id, revision: 1 } })) });
  const entry = f.service.createEntry(a, 'entry', entryInput('entry')).body as ActivityEntry;
  f.service.voidEntry(a, entry.id, 'void', { expectedRevision: 1 });
  const records: { kind: string; data: unknown }[] = [];
  const adapter = createActivityLifecycleAdapter(f.service);
  const result = adapter.export(a, { snapshotAtMs: 0, append(category, value) { assert.equal(category, 'activity'); records.push(value as { kind: string; data: unknown }); } });
  assert.equal(result.status, 'complete'); assert.equal(result.category, 'activity');
  assert.ok(records.some(x => x.kind === 'activity_exercise_revisions'));
  const exported = records.find(x => x.kind === 'activity_exercises')?.data as PersonalExercise;
  assert.equal(exported.description, personalFields.description); assert.equal(exported.movement, personalFields.movement); assert.equal(exported.measurementType, 'duration');
  assert.equal(JSON.stringify(records).includes('OTHER_ACCOUNT_MARKER'), false);
  assert.equal(JSON.stringify(records).includes('synthetic-A'), false);
  assert.ok(records.some(x => x.kind === 'activity_entry_revisions' && (x.data as ActivityEntry).status === 'voided'));
  assert.throws(() => adapter.export(a, { snapshotAtMs: 0, append() { throw new DomainError(413, 'account_export_packaging_required'); } }), code('account_export_packaging_required'));
});
test('oversized stored JSON is SQL-suppressed before parse and export cannot claim complete partial history', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A;
  const value = f.service.createExercise(a, 'create', personalFields).body as PersonalExercise;
  f.db.prepare('UPDATE activity_exercises SET data=? WHERE account_id=? AND id=?').run(JSON.stringify({ ...value, description: 'x'.repeat(600 * 1024) }), a.accountId, value.id);
  const raw = f.db.prepare('SELECT CASE WHEN length(CAST(data AS BLOB))<=? THEN data ELSE NULL END AS data FROM activity_exercises WHERE account_id=?').get(512 * 1024, a.accountId) as { data: string | null };
  assert.equal(raw.data, null);
  const adapter = createActivityLifecycleAdapter(f.service); let emitted = 0;
  assert.throws(() => adapter.export(a, { snapshotAtMs: 0, append() { emitted++; } }), code('account_export_packaging_required'));
  assert.equal(emitted, 0);
});
test('child-first purge requires acknowledged trusted readiness, preserves other account and shared receipts, readbacks idempotently', t => {
  const f = fixture(); t.after(() => f.db.close()); const a = f.contexts.A, b = f.contexts.B;
  f.service.createCalendar(a, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  f.service.createExercise(a, 'a', personalFields); f.service.createExercise(b, 'b', { ...personalFields, name: 'Other' });
  f.service.createPlan(a, 'plan', { name: 'Plan', items: planItems() });
  f.service.writeSchedule(a, 'schedule', { expectedRevision: 0, effectiveFrom: '2026-10-01', week: week() });
  f.service.createEntry(a, 'entry', entryInput('entry'));
  const adapter = createActivityLifecycleAdapter(f.service);
  assert.equal(adapter.purge('synthetic-purge', a.accountId).status, 'unavailable');
  assert.equal(f.db.transaction(() => adapter.purge('synthetic-purge', a.accountId)).immediate().status, 'unavailable');
  f.disabled.set(a.accountId, 1); f.setPurgeReady(true);
  assert.equal(f.db.transaction(() => adapter.suppress(a.accountId, 1)).immediate().status, 'complete');
  const result = f.db.transaction(() => adapter.purge('synthetic-purge', a.accountId)).immediate(); assert.equal(result.status, 'retained');
  for (const table of activityOwnedTables) assert.equal((f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(a.accountId) as { n: number }).n, 0);
  assert.equal(f.service.exercises(b).items.length, 1);
  assert.ok((f.db.prepare("SELECT count(*) AS n FROM command_receipts WHERE account_id=? AND operation LIKE 'activity.%'").get(a.accountId) as { n: number }).n > 0);
  assert.equal(adapter.verifySuppressed(a.accountId, 1).status, 'complete');
  assert.equal(f.db.transaction(() => adapter.purge('synthetic-purge', a.accountId)).immediate().status, 'retained');
  assert.equal((f.db.prepare('PRAGMA foreign_key_check').all()).length, 0);
  assert.throws(() => f.service.createEntry(a, 'entry', entryInput('entry')), code('account_disabled'));
});
