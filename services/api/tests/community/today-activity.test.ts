import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrations } from '../../src/storage.js';
import { activityMigrationSql, createActivityService, createActivityCommunityReader } from '../../src/activity/index.js';
import { allFalse } from '../../src/community/index.js';
import { actor, bindings, eligibility, install, service } from './fixture.js';
import { entryInput, week } from '../activity/fixture.js';

function combinedFixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of migrations.filter(value => value.version <= 7)) db.exec(migration.sql);
  db.exec(activityMigrationSql); install(db);
  let instant = '2026-10-01T16:00:00.000Z';
  const now = () => new Date(instant);
  const lifecycle = bindings(db);
  const viewer = actor(db), subject = actor(db);
  for (const context of [viewer, subject]) {
    db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)')
      .run(context.authUserId, 'Synthetic participant', `${context.accountId}@example.invalid`);
    db.prepare('INSERT INTO form_accounts(id,auth_user_id,created_at) VALUES (?,?,?)')
      .run(context.accountId, context.authUserId, instant);
  }
  db.prepare('INSERT INTO exercises(id,data,retired) VALUES (?,?,0)')
    .run('global-press', JSON.stringify({ id: 'global-press', name: 'Synthetic press', loadLabel: 'Each side', cues: [] }));
  const activity = createActivityService({ db, now, lifecycle, assertPersistable: () => {},
    lifecycleControl: { assertSuppression: () => { throw new Error('No synthetic suppression grant'); },
      purgeReadiness: () => ({ status: 'unavailable' }) },
    globalExerciseKind: id => id === 'global-press' ? 'resistance' : null,
    legacy: { readPlanRevision: () => null, listCompletedEvidence: () => [] },
  });
  const community = service(db, now, { lifecycle,
    subjectEligibility: id => eligibility(db, id), assertRateLimit: () => {},
    activityFor: proof => createActivityCommunityReader({ service: activity, viewer, lifecycle,
      trustedContext: request => { proof.assertAuthorized(request); return proof; } }),
  });
  const group = community.createGroup(viewer, { name: 'Synthetic group', alias: 'Viewer', membershipDisclosureAccepted: true }, 'group');
  const invitation = community.issueInvitation(viewer, group.id, {}, 'invite');
  if (!invitation.tokenAvailable) throw new Error('Synthetic invitation unavailable');
  const joined = community.joinInvitation(subject, { token: invitation.token, alias: 'Subject', membershipDisclosureAccepted: true }, 'join');
  activity.createCalendar(subject, 'calendar', { timeZone: 'America/New_York', confirmed: true });
  activity.writeSchedule(subject, 'schedule', { expectedRevision: 0, effectiveFrom: '2026-10-01', week: week(5) });
  const enable = (key: string) => community.updateSharing(subject, group.id, {
    expectedRevision: community.readSharing(subject, group.id).revision,
    flags: { ...allFalse(), participation: true, workout: true, planAdherence: true, streakDays: true },
  }, key);
  const summary = (date: string) => community.readSummary(viewer, group.id, { from: date, to: date });
  return { db, activity, community, viewer, subject, group, memberId: joined.memberId, enable, summary,
    setNow(value: string) { instant = value; } };
}

test('current Activity row is usable after next complete sharing day; rest remains pending and no future row is accepted', t => {
  const f = combinedFixture(); t.after(() => f.db.close());
  f.enable('share');
  f.setNow('2026-10-02T16:00:00.000Z');
  const current = f.summary('2026-10-02');
  assert.equal(current.summaryStatus, 'available');
  const day = current.members.find(member => member.memberId === f.memberId)?.days[0];
  assert.equal(day?.planAdherence, 'pending');
  assert.equal(day?.participation, 'unknown');
  assert.equal(day?.workout, 'not_recorded');
  assert.deepEqual(f.summary('2026-10-03'), { summaryStatus: 'unavailable', members: [] });
  f.setNow('2026-10-03T16:00:00.000Z');
  assert.equal(f.summary('2026-10-02').members.find(member => member.memberId === f.memberId)?.days[0]?.planAdherence, 'met');
  f.activity.createEntry(f.subject, 'entry', { ...entryInput('current', '2026-10-03'),
    date: { ...entryInput('current').date, localDate: '2026-10-03', capturedAt: '2026-10-03T16:00:00.000Z', referenceLocalDate: '2026-10-03' } });
  const performed = f.summary('2026-10-03').members.find(member => member.memberId === f.memberId)?.days[0];
  assert.equal(performed?.workout, 'recorded');
  assert.equal(performed?.planAdherence, 'met');
  assert.equal(performed?.participation, 'recorded');
  assert.equal(JSON.stringify(performed).includes('global-press'), false);
});

test('current-day acceptance never backfills enrollment or sharing and suppression still denies the actual reader', t => {
  const f = combinedFixture(); t.after(() => f.db.close());
  f.enable('same-day-share');
  assert.equal(f.summary('2026-10-01').summaryStatus, 'available');
  assert.deepEqual(f.summary('2026-10-01').members.find(member => member.memberId === f.memberId)?.days, []);
  f.setNow('2026-10-02T16:00:00.000Z');
  assert.equal(f.summary('2026-10-02').members.find(member => member.memberId === f.memberId)?.days.length, 1);
  f.db.prepare("UPDATE synthetic_accounts SET state='suppressed' WHERE id=?").run(f.subject.accountId);
  assert.equal(f.summary('2026-10-02').members.some(member => member.memberId === f.memberId), false);
});
