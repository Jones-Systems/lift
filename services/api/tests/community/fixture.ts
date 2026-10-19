import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { communityRemovalSnapshotsMigrationSql } from '../../src/community/removal-snapshots.js';
import { communityExtensionMigrationSql } from '../../src/community/extension-migration.js';
import { createCommunityExtension } from '../../src/community/extension-service.js';
import { DomainError } from '../../src/errors.js';
import { communityMigrationSql, createCommunity, type AccountContext, type CommunityDependencies, type AdultEligibility, type CommunityService, type GroupView, type IssuedInvitation } from '../../src/community/index.js';

export function install(db: Database.Database): void {
  db.exec(`CREATE TABLE synthetic_accounts(id TEXT PRIMARY KEY,age INTEGER,profile_revision INTEGER NOT NULL,state TEXT NOT NULL,epoch INTEGER NOT NULL);
    CREATE TABLE synthetic_sessions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,valid INTEGER NOT NULL);`);
  db.exec(communityMigrationSql); db.exec(communityExtensionMigrationSql); db.exec(communityRemovalSnapshotsMigrationSql);
}
export function actor(db: Database.Database, age: number | null = 40): AccountContext {
  const accountId = randomUUID(); const sessionId = randomUUID();
  db.prepare("INSERT INTO synthetic_accounts VALUES(?,?,1,'active',0)").run(accountId, age);
  db.prepare('INSERT INTO synthetic_sessions VALUES(?,?,1)').run(sessionId, accountId);
  return { accountId, authUserId: `synthetic:${accountId}`, sessionId, epoch: 0 };
}
export function bindings(db: Database.Database): NonNullable<CommunityDependencies['lifecycle']> {
  const assertActive = (context: AccountContext) => {
    const row = db.prepare('SELECT state,epoch FROM synthetic_accounts WHERE id=?').get(context.accountId) as { state: string; epoch: number } | undefined;
    const session = db.prepare('SELECT account_id,valid FROM synthetic_sessions WHERE id=?').get(context.sessionId) as { account_id: string; valid: number } | undefined;
    if (!session || !session.valid || session.account_id !== context.accountId || context.authUserId !== `synthetic:${context.accountId}`)
      throw new DomainError(401, 'synthetic_session_invalid');
    if (!row || row.state !== 'active' || row.epoch !== context.epoch) throw new DomainError(403, 'synthetic_account_disabled');
  };
  return {
    assertActive,
    withActiveWrite: (context, effect) => db.transaction(() => { assertActive(context); const value = effect(); assertActive(context); return value; }).immediate(),
    adultEligibility: context => { assertActive(context); return eligibility(db, context.accountId); },
  };
}
export function eligibility(db: Database.Database, accountId: string): AdultEligibility {
  const row = db.prepare('SELECT age,profile_revision,state FROM synthetic_accounts WHERE id=?').get(accountId) as { age: number | null; profile_revision: number; state: string } | undefined;
  const status = row?.state !== 'active' ? 'unknown' : typeof row.age === 'number' && Number.isInteger(row.age) && row.age >= 18 && row.age <= 120 ? 'eligible'
    : typeof row.age === 'number' && Number.isInteger(row.age) && row.age >= 13 && row.age <= 17 ? 'not_adult' : 'unknown';
  return { policy: 'self_reported_adult_v1', status, profileRevision: row?.profile_revision ?? null };
}
export function service(db: Database.Database, now: () => Date, extra: Partial<CommunityDependencies> = {}) {
  const deps: CommunityDependencies = { db, now, lifecycle: bindings(db), subjectEligibility: id => eligibility(db, id), assertRateLimit: () => {}, ...extra };
  // Explicit synthetic moderation only; production has no permissive default.
  const extension = createCommunityExtension({ db, now, ...(deps.lifecycle ? { lifecycle: deps.lifecycle } : {}),
    ...(deps.subjectEligibility ? { subjectEligibility: deps.subjectEligibility } : {}),
    textModeration: { policyVersion: 'community-v1', checkText: () => 'allowed' } });
  return createCommunity({ ...deps, extension: deps.extension ?? extension });
}
export type CommunityFixture = {
  db: Database.Database;
  clock: { value: string };
  now: () => Date;
  community: CommunityService;
  a: AccountContext;
  b: AccountContext;
  c: AccountContext;
  outsider: AccountContext;
  group: GroupView;
  invite: () => Extract<IssuedInvitation, { tokenAvailable: true }>;
  join: (person: AccountContext, alias?: string) => { groupId: string; memberId: string };
};
export function fixture(): CommunityFixture {
  const db = new Database(':memory:'); install(db);
  const clock = { value: '2026-10-01T12:00:00.000Z' }; const now = () => new Date(clock.value);
  const community = service(db, now); const a = actor(db); const b = actor(db); const c = actor(db); const outsider = actor(db);
  const group = community.createGroup(a, { name: 'Synthetic family', alias: 'Owner', membershipDisclosureAccepted: true }, 'create');
  const invite = () => {
    const result = community.issueInvitation(a, group.id, {}, randomUUID());
    if (!result.tokenAvailable) throw new Error('Expected one-time token'); return result;
  };
  const join = (person: AccountContext, alias = 'Synthetic member') => community.joinInvitation(person, { token: invite().token, alias, membershipDisclosureAccepted: true }, randomUUID());
  return { db, clock, now, community, a, b, c, outsider, group, invite, join };
}
