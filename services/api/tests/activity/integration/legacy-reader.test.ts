import test from 'node:test';
import assert from 'node:assert/strict';
import { Domain } from '../../../src/domain.js';
import type { Sqlite } from '../../../src/storage.js';
import { createLegacyTrainingReader, legacyReadLimits } from '../../../src/activity/integration/legacy-reader.js';
import { dayBoundaries } from '../../../src/activity/calendar.js';
import { fixture, seedPlan, seedSession, seedSet, code } from './fixture.js';

const invalid = code('activity_legacy_invalid_or_unavailable');
test('exact older/current/missing revisions retain archived state and account isolation for identical IDs', t => {
  const f = fixture(); t.after(() => f.db.close());
  for (const context of Object.values(f.contexts)) seedPlan(f.db, context.accountId);
  seedPlan(f.db, f.contexts.A.accountId, 'same-plan', 2, { name: 'Renamed', archived: true, minutes: 45 });
  f.db.transaction(() => {
    const original = f.legacy.readPlanRevision(f.contexts.A.accountId, 'same-plan', 1)!;
    const current = f.legacy.readPlanRevision(f.contexts.A.accountId, 'same-plan', 2)!;
    assert.equal(original.name, 'Plan form-A'); assert.equal(original.archived, false);
    assert.equal(current.name, 'Renamed'); assert.equal(current.archived, true); assert.equal(current.minutes, 45);
    assert.equal(original.items[0]!.targetKg, 0); assert.equal(original.items[0]!.setTarget, 2);
    assert.equal(f.legacy.readPlanRevision(f.contexts.B.accountId, 'same-plan', 1)!.name, 'Plan form-B');
    assert.equal(f.legacy.readPlanRevision(f.contexts.B.accountId, 'same-plan', 2), null);
    assert.equal(f.legacy.readPlanRevision(f.contexts.A.accountId, 'same-plan', 3), null);
  }).deferred();
});
test('legacy reads require caller transaction and lifecycle checks before and after payload reads', t => {
  const f = fixture(); t.after(() => f.db.close()); seedPlan(f.db, f.contexts.A.accountId);
  assert.throws(() => f.legacy.readPlanRevision(f.contexts.A.accountId, 'same-plan', 1), code('activity_legacy_read_transaction_required'));
  let checks = 0;
  const reader = createLegacyTrainingReader({ db: f.db, assertReadable() { if (++checks === 2) throw new Error('late_suppression'); } });
  assert.throws(() => f.db.transaction(() => reader.readPlanRevision(f.contexts.A.accountId, 'same-plan', 1)).deferred(), /late_suppression/);
  assert.equal(checks, 2);
  f.suppress(f.contexts.A.accountId);
  assert.throws(() => f.db.transaction(() => f.legacy.listCompletedEvidence(f.contexts.A.accountId, '2026-10-01', '2026-10-09', 'UTC')).deferred(), code('account_disabled'));
});
for (const [name, overrides] of Object.entries({
  extra: { transcript: 'SYNTHETIC_REJECTED' }, duplicate: { items: Array(2).fill({ id: 'same-item', exerciseId: 'floor-press', setTarget: 1, repMin: 1, repMax: 2, targetKg: 0 }) },
  reversed: { items: [{ id: 'same-item', exerciseId: 'floor-press', setTarget: 1, repMin: 9, repMax: 2, targetKg: 0 }] },
  nullTarget: { items: [{ id: 'same-item', exerciseId: 'floor-press', setTarget: 1, repMin: 1, repMax: 2, targetKg: null }] },
  mapping: { items: [{ id: 'same-item', exerciseId: 'supported-row', setTarget: 1, repMin: 1, repMax: 2, targetKg: 0 }] },
  oversize: { name: 'x'.repeat(legacyReadLimits.planBytes + 1) },
})) {
  test(`existing ${name} snapshot fails unavailable rather than missing or substituted`, t => {
    const f = fixture(); t.after(() => f.db.close()); seedPlan(f.db, f.contexts.A.accountId, 'same-plan', 1, overrides);
    assert.throws(() => f.db.transaction(() => f.legacy.readPlanRevision(f.contexts.A.accountId, 'same-plan', 1)).deferred(), invalid);
  });
}
test('malformed persisted JSON is unavailable under a deliberately corrupt synthetic dataset', t => {
  const f = fixture(); t.after(() => f.db.close()); seedPlan(f.db, f.contexts.A.accountId);
  f.db.pragma('ignore_check_constraints = ON');
  f.db.prepare('INSERT INTO plan_revisions VALUES (?,?,2,?,?)').run(f.contexts.A.accountId, 'same-plan', '{broken', '2026-01-01');
  assert.throws(() => f.db.transaction(() => f.legacy.readPlanRevision(f.contexts.A.accountId, 'same-plan', 2)).deferred(), invalid);
});
test('latest completed sets count distinct occurrences; active/draft/void/empty truth and account isolation persist', t => {
  const f = fixture(); t.after(() => f.db.close());
  const domain = new Domain(f.db);
  const plans = Object.fromEntries(Object.values(f.contexts).map(context => [context.accountId, domain.createPlan(context.accountId, {
    name: `Plan ${context.accountId}`, minutes: 30,
    items: ['same-item', 'second-item'].map(id => ({ id, exerciseId: 'floor-press', setTarget: 2, repMin: 8, repMax: 10, targetKg: 0 })),
  })]));
  // Keep deterministic session/occurrence IDs while storing the writer's full historical plan and exact targets.
  const seedValidSession = (accountId: string, id = 'same-session',
    startedAt = '2026-10-09T16:00:00.000Z', status: 'active' | 'completed' = 'completed'): void => {
    const plan = plans[accountId]!;
    f.db.prepare('INSERT INTO workout_sessions VALUES (?,?,?,?,1,?,?,?,NULL)')
      .run(accountId, id, plan.id, plan.revision, JSON.stringify(plan), status, startedAt);
    for (const [position, occurrence] of ['same-occurrence', 'second-occurrence'].entries()) {
      const item = plan.items[position]!;
      f.db.prepare('INSERT INTO session_occurrences VALUES (?,?,?,?,?,?,?)')
        .run(accountId, id, occurrence, item.id, item.exerciseId, position, JSON.stringify(item));
    }
  };
  for (const context of Object.values(f.contexts)) seedValidSession(context.accountId);
  seedSet(f.db, f.contexts.A.accountId); seedSet(f.db, f.contexts.A.accountId, 'same-session', 'set-two', 'same-occurrence', 2);
  seedSet(f.db, f.contexts.A.accountId, 'same-session', 'set-three', 'second-occurrence');
  seedValidSession(f.contexts.A.accountId, 'active-session', '2026-10-09T17:00:00.000Z', 'active');
  seedSet(f.db, f.contexts.A.accountId, 'active-session');
  seedValidSession(f.contexts.A.accountId, 'empty-session');
  seedSet(f.db, f.contexts.A.accountId, 'empty-session', 'draft', 'same-occurrence', 1, 'draft', 0);
  seedSet(f.db, f.contexts.A.accountId, 'empty-session', 'voided', 'second-occurrence', 1, 'voided');
  const read = (account = f.contexts.A.accountId) => f.db.transaction(() => f.legacy.listCompletedEvidence(account,
    '2026-10-09', '2026-10-09', 'America/New_York')).deferred();
  const rows = read(); assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.sessionId === 'same-session')!.confirmedOccurrenceCount, 2);
  assert.equal(rows.find(row => row.sessionId === 'empty-session')!.hasConfirmedPerformance, false);
  assert.equal(read(f.contexts.B.accountId)[0]!.confirmedOccurrenceCount, 0);
  domain.patchSet(f.contexts.A.accountId, 'same-session', 'set-one', { expectedRevision: 1, reps: 6, weightKg: 0, status: 'draft' });
  assert.equal(read().find(row => row.sessionId === 'same-session')!.sessionRevision, 2);
  domain.voidSet(f.contexts.A.accountId, 'same-session', 'set-two', 1);
  domain.voidSet(f.contexts.A.accountId, 'same-session', 'set-three', 1);
  const last = read().find(row => row.sessionId === 'same-session')!;
  assert.equal(last.sessionRevision, 4); assert.equal(last.hasConfirmedPerformance, false); assert.equal(last.confirmedOccurrenceCount, 0);
  assert.ok(!('workoutMinutes' in last)); assert.ok(!('completedAt' in last));
});
for (const [date, zone] of [['2026-03-08', 'America/New_York'], ['2026-11-01', 'America/New_York'],
  ['2026-10-09', 'Asia/Kathmandu'], ['2026-10-04', 'Australia/Lord_Howe']] as const) {
  test(`civil ${date} ${zone} uses inclusive start/exclusive actual next boundary`, t => {
    const f = fixture(); t.after(() => f.db.close()); seedPlan(f.db, f.contexts.A.accountId);
    const bounds = dayBoundaries(date, zone);
    seedSession(f.db, f.contexts.A.accountId, 'included', bounds.dayStartAt);
    seedSession(f.db, f.contexts.A.accountId, 'excluded-before', new Date(Date.parse(bounds.dayStartAt) - 1).toISOString());
    seedSession(f.db, f.contexts.A.accountId, 'excluded-after', bounds.dayEndAt);
    const rows = f.db.transaction(() => f.legacy.listCompletedEvidence(f.contexts.A.accountId, date, date, zone)).deferred();
    assert.deepEqual(rows.map(row => [row.sessionId, row.localDate]), [['included', date]]);
  });
}
test('full known history beyond 366 days remains available; skipped endpoints and invalid ranges fail', t => {
  const f = fixture(); t.after(() => f.db.close()); seedPlan(f.db, f.contexts.A.accountId);
  seedSession(f.db, f.contexts.A.accountId, 'old-session', '2020-01-01T16:00:00.000Z');
  seedSession(f.db, f.contexts.A.accountId);
  f.db.transaction(() => {
    assert.equal(f.legacy.listCompletedEvidence(f.contexts.A.accountId, '2020-01-01', '2026-10-09', 'UTC').length, 2);
    assert.throws(() => f.legacy.listCompletedEvidence(f.contexts.A.accountId, '2011-12-30', '2011-12-30', 'Pacific/Apia'), code('nonexistent_activity_date'));
    assert.throws(() => f.legacy.listCompletedEvidence(f.contexts.A.accountId, '2026-10-09', '2020-01-01', 'UTC'), code('invalid_activity_range'));
    assert.throws(() => f.legacy.listCompletedEvidence(f.contexts.A.accountId, '2026-02-30', '2026-10-09', 'UTC'));
  }).deferred();
});
test('corrupt selected noncanonical timestamps and orphaned set identities fail unavailable', t => {
  const f = fixture(); t.after(() => f.db.close()); seedPlan(f.db, f.contexts.A.accountId);
  seedSession(f.db, f.contexts.A.accountId, 'corrupt', '2026-10-09T16:00:00Z');
  const read = () => f.db.transaction(() => f.legacy.listCompletedEvidence(f.contexts.A.accountId, '2026-10-09', '2026-10-09', 'UTC')).deferred();
  assert.throws(read, invalid);
  f.db.prepare('UPDATE workout_sessions SET started_at=? WHERE account_id=? AND id=?').run('2026-10-09T16:00:00.000Z', f.contexts.A.accountId, 'corrupt');
  f.db.pragma('foreign_keys = OFF');
  seedSet(f.db, f.contexts.A.accountId, 'corrupt', 'orphan', 'missing-occurrence');
  assert.throws(read, invalid);
});
test('legacy GET reader performs no writes, opens no transaction, and rechecks empty completion', t => {
  const f = fixture(); t.after(() => f.db.close());
  const before = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  f.sql.length = 0;
  f.db.transaction(() => {
    assert.deepEqual(f.legacy.listCompletedEvidence(f.contexts.A.accountId, '2026-10-01', '2026-10-09', 'UTC'), []);
    assert.equal(f.legacy.readPlanRevision(f.contexts.A.accountId, 'missing-plan', 1), null);
  }).deferred();
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, before);
  assert.equal(f.sql.filter(sql => /^BEGIN/.test(sql)).length, 1);
  assert.ok(!f.sql.some(sql => /^(INSERT|UPDATE|DELETE|CREATE)/.test(sql)));
});
for (const mode of ['sessions', 'setsPerSession', 'totalSets'] as const) {
  test(`${mode} overflow sentinel fails the entire projection without truncation`, () => {
    const limits: number[] = [];
    const sessions = Array.from({ length: mode === 'sessions' ? 10_001 : mode === 'totalSets' ? 21 : 1 }, (_, i) =>
      ({ id: `session-${i}`, revision: 1, started_at: '2026-10-09T16:00:00.000Z' }));
    // Script only the bounded SQL result boundary; the production reader performs its real iteration and validation.
    const db = { inTransaction: true, prepare(sql: string) { return { all(...args: unknown[]) {
      const limit = args.at(-1) as number; limits.push(limit);
      if (sql.includes('FROM workout_sessions')) return sessions;
      const count = mode === 'setsPerSession' ? 5001 : Math.min(5000, limit);
      return Array.from({ length: count }, (_, i) => ({ id: `set-${i}`, occurrence_id: `occurrence-${i}`, reps: 8, matched_occurrence: `occurrence-${i}` }));
    } }; } } as unknown as Sqlite;
    const reader = createLegacyTrainingReader({ db, assertReadable() {} });
    assert.throws(() => reader.listCompletedEvidence('form-A', '2020-01-01', '2026-10-09', 'UTC'), invalid);
    assert.equal(limits[0], 10_001);
    if (mode !== 'sessions') assert.ok(limits.slice(1).every(limit => limit <= 5001));
    if (mode === 'totalSets') assert.equal(limits.at(-1), 1);
  });
}
