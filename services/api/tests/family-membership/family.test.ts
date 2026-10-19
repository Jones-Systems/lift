import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DomainError } from '../../src/errors.js';
import { FamilyMembershipService, familyMembershipMigrationSql, createFamilyMembershipLifecycleAdapter,
  type AccountContext, type FamilyDependencies, type FamilyCommand, type TrustedFamilyGrant } from '../../src/family-membership/index.js';

function fixture(t: TestContext, totalSeats = 5) {
  const db = new Database(':memory:');
  t.after(() => { if (db.open) db.close(); });
  db.pragma('foreign_keys = ON'); db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE form_accounts(id TEXT PRIMARY KEY); CREATE TABLE synthetic_family_active(id TEXT PRIMARY KEY,active INTEGER NOT NULL)');
  db.exec(familyMembershipMigrationSql);
  const actors = Array.from({ length: 9 }, (_, i): AccountContext => {
    const id = `account-${i}`;
    db.prepare('INSERT INTO form_accounts VALUES(?)').run(id);
    db.prepare('INSERT INTO synthetic_family_active VALUES(?,1)').run(id);
    return Object.freeze({ accountId: id, authUserId: `auth-${i}`, sessionId: `session-${i}`, epoch: 0 });
  });
  const [owner, member, outsider] = actors as [AccountContext, AccountContext, AccountContext, ...AccountContext[]];
  const subjectActive = (id: string) => !!db.prepare('SELECT 1 FROM synthetic_family_active WHERE id=? AND active=1').get(id);
  const assertActive = (actor: AccountContext) => {
    const expected = actors.find(value => value.accountId === actor.accountId);
    if (!expected || expected.authUserId !== actor.authUserId || expected.sessionId !== actor.sessionId || actor.epoch !== 0)
      throw new DomainError(401, 'synthetic_session_invalid');
    if (!subjectActive(actor.accountId)) throw new DomainError(403, 'synthetic_disabled');
  };
  const deps: FamilyDependencies = { db, totalSeats, subjectActive, lifecycle: {
    assertActive,
    withActiveWrite: (actor, effect) => db.transaction(() => { assertActive(actor); const result = effect(); assertActive(actor); return result; }).immediate(),
  } };
  const service = new FamilyMembershipService(deps);
  let sequence = 0;
  const command = (actor: AccountContext, value: FamilyCommand, key = `key-${++sequence}`) => service.command(actor, { command: value, idempotencyKey: key });
  assert.equal(command(owner, { type: 'create' }).status, 'applied');
  const invite = (target: AccountContext) => {
    const family = service.read(owner)!;
    assert.equal(command(owner, { type: 'invite', familyId: family.familyId, expectedRevision: family.revision, inviteeAccountId: target.accountId }).status, 'applied');
    return service.invitations(target)[0]!.invitationId;
  };
  const join = (target: AccountContext) => command(target, { type: 'accept', invitationId: invite(target) });
  const trust = () => {
    deps.entitlement = { read: (ownerAccountId, familyId): TrustedFamilyGrant => ({ status: 'active', ownerAccountId, familyId,
      grant: { id: 'synthetic-family-grant', entitlement: 'synthetic-paid-membership', grantedAt: '2026-10-11T00:00:00.000Z', expiresAt: null, environment: 'synthetic' } }) };
  };
  return { db, deps, service, actors, owner, member, outsider, command, invite, join, trust };
}

test('capacity defaults to five including owner, is configurable, and SQL enforces acceptance bound', t => {
  const f = fixture(t);
  assert.equal(f.service.read(f.owner)!.totalSeats, 5);
  const ids = f.actors.slice(1, 6).map(actor => ({ actor, invitationId: f.invite(actor) }));
  for (const value of ids.slice(0, 4)) assert.equal(f.command(value.actor, { type: 'accept', invitationId: value.invitationId }).status, 'applied');
  const fifth = ids[4]!;
  assert.deepEqual(f.command(fifth.actor, { type: 'accept', invitationId: fifth.invitationId }), { status: 'rejected', code: 'family_full' });
  assert.equal(f.service.read(f.owner)!.members.length, 5);
  assert.equal(f.service.read(fifth.actor), null);
  assert.throws(() => f.db.prepare("INSERT INTO family_members VALUES(?,?,'member')").run(fifth.actor.accountId, f.service.read(f.owner)!.familyId), /family_capacity_exceeded/);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  const smaller = fixture(t, 2);
  assert.equal(smaller.join(smaller.member).status, 'applied');
  assert.deepEqual(smaller.join(smaller.outsider), { status: 'rejected', code: 'family_full' });
});

test('membership, invitations and social rows never grant paid access; only trusted owner family grant does', t => {
  const f = fixture(t);
  f.db.exec('CREATE TABLE social_groups(account_id TEXT);');
  f.db.prepare('INSERT INTO social_groups VALUES(?)').run(f.member.accountId);
  const invitationId = f.invite(f.member);
  f.trust();
  assert.deepEqual(f.service.entitlementContribution(f.member), []);
  assert.equal(f.service.read(f.member), null);
  assert.equal(f.command(f.member, { type: 'accept', invitationId }).status, 'applied');
  assert.equal(f.service.entitlementContribution(f.member)[0]!.active, true);
  delete f.deps.entitlement;
  assert.deepEqual(f.service.entitlementContribution(f.member), []);
  assert.equal(f.service.read(f.member)!.entitlement.status, 'unknown');
  f.deps.entitlement = { read: () => { throw new Error('trusted service unavailable'); } };
  assert.deepEqual(f.service.entitlementContribution(f.member), []);
});

test('wrong-account invitation acceptance, member owner commands and foreign targets are rejected', t => {
  const f = fixture(t);
  const id = f.invite(f.member);
  assert.deepEqual(f.command(f.outsider, { type: 'accept', invitationId: id }), { status: 'rejected', code: 'family_invitation_not_found' });
  assert.equal(f.command(f.member, { type: 'accept', invitationId: id }).status, 'applied');
  const family = f.service.read(f.owner)!;
  assert.deepEqual(f.command(f.member, { type: 'invite', familyId: family.familyId, expectedRevision: family.revision, inviteeAccountId: f.outsider.accountId }), { status: 'rejected', code: 'family_owner_required' });
  assert.deepEqual(f.command(f.owner, { type: 'remove', familyId: family.familyId, expectedRevision: family.revision, memberAccountId: f.outsider.accountId }), { status: 'rejected', code: 'family_member_not_found' });
  assert.throws(() => f.service.command({ ...f.owner, sessionId: f.member.sessionId }, { command: { type: 'create' }, idempotencyKey: 'forged' }), /synthetic_session_invalid/);
});

test('owner-inclusive role restrictions, revoke, removal readback and member leave are deterministic', t => {
  const f = fixture(t);
  const id = f.invite(f.member);
  let family = f.service.read(f.owner)!;
  assert.equal(f.command(f.owner, { type: 'revoke', familyId: family.familyId, expectedRevision: family.revision, invitationId: id }).status, 'applied');
  assert.deepEqual(f.service.invitations(f.member), []);
  assert.equal(f.command(f.member, { type: 'accept', invitationId: id }).status, 'rejected');
  f.join(f.member); f.trust();
  family = f.service.read(f.owner)!;
  assert.equal(f.command(f.owner, { type: 'remove', familyId: family.familyId, expectedRevision: family.revision, memberAccountId: f.member.accountId }).status, 'applied');
  assert.equal(f.service.read(f.member), null);
  assert.deepEqual(f.service.entitlementContribution(f.member), []);
  f.join(f.member);
  family = f.service.read(f.member)!;
  assert.equal(f.command(f.member, { type: 'leave', familyId: family.familyId, expectedRevision: family.revision }).status, 'applied');
  family = f.service.read(f.owner)!;
  assert.deepEqual(f.command(f.owner, { type: 'leave', familyId: family.familyId, expectedRevision: family.revision }), { status: 'rejected', code: 'family_owner_cannot_leave' });
});

test('receipts bind exact command/key/account, survive service reconstruction and are lookup-only', t => {
  const f = fixture(t);
  const family = f.service.read(f.owner)!;
  const request = { command: { type: 'invite' as const, familyId: family.familyId, expectedRevision: family.revision, inviteeAccountId: f.member.accountId }, idempotencyKey: 'same-key' };
  const applied = f.service.command(f.owner, request);
  assert.deepEqual(f.service.command(f.owner, request), applied);
  const reopened = new FamilyMembershipService(f.deps);
  assert.deepEqual(reopened.receipt(f.owner, request), applied);
  assert.deepEqual(reopened.receipt(f.outsider, request), { status: 'unknown', code: 'family_receipt_not_found' });
  assert.throws(() => reopened.command(f.owner, { ...request, command: { ...request.command, inviteeAccountId: f.outsider.accountId } }), /family_idempotency_conflict/);
  assert.equal(f.service.invitations(f.member).length, 1);
  assert.equal(f.service.invitations(f.outsider).length, 0);
});

test('receipt insertion failure rolls back the whole mutation and malformed paid flags are rejected', t => {
  const f = fixture(t);
  const before = f.service.read(f.owner)!;
  f.db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON family_command_receipts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  assert.throws(() => f.command(f.owner, { type: 'invite', familyId: before.familyId, expectedRevision: before.revision, inviteeAccountId: f.member.accountId }), /synthetic failure/);
  assert.deepEqual(f.service.read(f.owner), before);
  assert.deepEqual(f.service.invitations(f.member), []);
  assert.throws(() => f.service.command(f.owner, { command: { type: 'create', paid: true }, idempotencyKey: 'paid' } as never), /invalid_family_command/);
});

test('owner disable and suppression immediately remove inherited access and prevent receipt replay', t => {
  const f = fixture(t); f.join(f.member); f.trust();
  assert.equal(f.service.entitlementContribution(f.member).length, 1);
  f.db.prepare('UPDATE synthetic_family_active SET active=0 WHERE id=?').run(f.owner.accountId);
  assert.deepEqual(f.service.entitlementContribution(f.member), []);
  assert.equal(f.service.read(f.member), null);
  assert.throws(() => f.service.receipt(f.owner, { command: { type: 'create' }, idempotencyKey: 'key-1' }), /synthetic_disabled/);
  f.service.suppressAccount(f.owner.accountId, 1);
  assert.equal(f.service.verifySuppressed(f.owner.accountId), true);
  assert.ok(f.service.purgeAccount(f.owner.accountId) >= 1);
  assert.equal(f.service.read(f.member), null);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('lifecycle export is account-scoped and member suppression preserves unrelated family ownership', t => {
  const f = fixture(t); f.join(f.member); f.trust();
  const data = f.service.exportAccount(f.member);
  assert.equal(data.membership!.role, 'member');
  assert.equal(JSON.stringify(data).includes(f.outsider.accountId), false);
  const adapter = createFamilyMembershipLifecycleAdapter(f.service);
  const sections: unknown[] = [];
  assert.equal(adapter.export(f.member, { snapshotAtMs: 0, append: (_category, value) => { sections.push(value); } }).status, 'complete');
  assert.equal(sections.length, 1);
  assert.equal(adapter.suppress(f.member.accountId, 1).status, 'complete');
  assert.equal(adapter.verifySuppressed(f.member.accountId, 1).status, 'complete');
  assert.equal(adapter.purge('synthetic-deletion', f.member.accountId).status, 'complete');
  assert.equal(f.service.read(f.owner)!.members.length, 1);
  assert.equal(f.service.entitlementContribution(f.owner).length, 1);
  assert.throws(() => f.service.read(f.member), /family_account_unavailable/);
});

test('service refuses foreign-key or durability downgrades and stale family revisions', t => {
  const f = fixture(t);
  const before = f.service.read(f.owner)!;
  f.invite(f.member);
  assert.deepEqual(f.command(f.owner, { type: 'invite', familyId: before.familyId, expectedRevision: before.revision, inviteeAccountId: f.outsider.accountId }), { status: 'rejected', code: 'family_stale_revision' });
  f.db.pragma('foreign_keys = OFF');
  assert.throws(() => new FamilyMembershipService(f.deps), /family_storage_unqualified/);
  f.db.pragma('foreign_keys = ON'); f.db.pragma('synchronous = OFF');
  assert.throws(() => f.service.read(f.owner), /family_storage_unqualified/);
});
