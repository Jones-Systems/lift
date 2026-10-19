const { test } = require('node:test');
const assert = require('node:assert/strict');
const { familyPolicy, isFamilySnapshot, occupiedFamilySeats, FamilyMembershipController } = require('../family.ts');
const snapshot = () => ({ kind: 'commercial_family', familyId: 'family-a', revision: '1', ownerAccountId: 'owner', totalSeats: 5,
  members: [{ accountId: 'owner', role: 'owner' }], pendingInvitations: [], entitlement: { accountId: 'owner', status: 'inactive' } });
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  const calls = [];
  const server = { value: snapshot(), current: true, result: { status: 'applied', receiptId: 'receipt-1' } };
  const response = value => ({ accountId: 'owner', generation: 'session-1', value });
  const session = { accountId: 'owner', generation: 'session-1', isCurrent: () => server.current,
    read: async () => { calls.push(['read']); return response(server.value); },
    command: async request => { calls.push(['command', request]); return response(server.result); },
    reconcile: async request => { calls.push(['reconcile', request]); return response(server.result); } };
  const ports = { captureSession: () => session, newIdempotencyKey: () => 'command-key' };
  return { controller: new FamilyMembershipController(ports), ports, session, server, response, calls };
}
const invitation = { type: 'invite', familyId: 'family-a', expectedRevision: '1', inviteeAccountId: 'member-a' };

test('five total seats includes the owner and remains configurable with activation unavailable', () => {
  assert.deepEqual(familyPolicy(), { totalSeats: 5, ownerIncluded: true, commercialActivation: 'unavailable' });
  assert.equal(familyPolicy(7).totalSeats, 7);
  for (const value of [0, -1, 2.5, NaN, Infinity]) assert.throws(() => familyPolicy(value));
  const family = snapshot();
  for (let i = 0; i < 5; i++) family.members.push({ accountId: `member-${i}`, role: 'member' });
  assert.equal(occupiedFamilySeats(family), 6);
  assert.equal(isFamilySnapshot(family, 'owner'), false);
  family.totalSeats = 6;
  assert.equal(isFamilySnapshot(family, 'owner'), true);
});

test('social-group shape and an invited nonmember cannot establish paid family access', () => {
  assert.equal(isFamilySnapshot({ ...snapshot(), kind: 'social_group' }, 'owner'), false);
  const family = snapshot();
  family.pendingInvitations.push({ invitationId: 'invite-a', inviteeAccountId: 'invited' });
  family.entitlement = { accountId: 'invited', status: 'inactive' };
  assert.equal(isFamilySnapshot(family, 'invited'), true);
  assert.equal(occupiedFamilySeats(family), 1);
  family.entitlement.status = 'active';
  assert.equal(isFamilySnapshot(family, 'invited'), false);
});

test('owner identity, owner-inclusive membership and duplicate members are validated', () => {
  assert.equal(isFamilySnapshot({ ...snapshot(), members: [] }, 'owner'), false);
  assert.equal(isFamilySnapshot({ ...snapshot(), ownerAccountId: 'other' }, 'owner'), false);
  assert.equal(isFamilySnapshot({ ...snapshot(), members: [snapshot().members[0], snapshot().members[0]] }, 'owner'), false);
});

test('invite has no optimistic membership or entitlement mutation and server decides capacity', async () => {
  const f = fixture();
  await f.controller.load();
  const pending = defer();
  f.session.command = request => { f.calls.push(['command', request]); return pending.promise; };
  const command = f.controller.command(invitation);
  assert.equal(f.controller.getState().status, 'submitting');
  assert.deepEqual(f.controller.getState().snapshot, snapshot());
  await f.controller.command(invitation);
  pending.resolve(f.response({ status: 'rejected', code: 'family_full' }));
  await command;
  assert.equal(f.controller.getState().status, 'failed');
  assert.equal(f.controller.getState().reason, 'family_full');
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 1);
  assert.deepEqual(f.controller.getState().snapshot, snapshot());
});

test('remove applies only the authoritative readback, never a local paid grant or member edit', async () => {
  const f = fixture();
  f.server.value.members.push({ accountId: 'member-a', role: 'member' });
  await f.controller.load();
  const pending = defer();
  f.session.read = () => pending.promise;
  const command = f.controller.command({ type: 'remove', familyId: 'family-a', expectedRevision: '1', memberAccountId: 'member-a' });
  await Promise.resolve();
  assert.equal(f.controller.getState().snapshot.members.length, 2);
  pending.resolve(f.response({ ...snapshot(), revision: '2' }));
  await command;
  assert.equal(f.controller.getState().snapshot.members.length, 1);
  assert.equal(f.controller.getState().snapshot.entitlement.status, 'inactive');
  assert.equal(f.controller.getRecovery(), null);
});

test('unknown command retains exact payload/key; check again reads receipt without replay', async () => {
  const f = fixture();
  f.server.result = { status: 'unknown', code: 'timeout' };
  await f.controller.command(invitation);
  const retained = f.controller.getRecovery();
  assert.deepEqual(retained.request, { command: invitation, idempotencyKey: 'command-key' });
  retained.request.command.inviteeAccountId = 'tampered';
  await f.controller.command({ type: 'create' });
  await f.controller.load();
  assert.equal(f.controller.getState().status, 'unknown');
  f.server.result = { status: 'applied', receiptId: 'receipt-1' };
  await f.controller.checkAgain();
  assert.deepEqual(f.calls.filter(call => call[0] === 'command' || call[0] === 'reconcile'), [
    ['command', { command: invitation, idempotencyKey: 'command-key' }],
    ['reconcile', { command: invitation, idempotencyKey: 'command-key' }],
  ]);
  assert.equal(f.controller.getState().status, 'ready');
});

test('late account response is hidden and retained command cannot reconcile under replacement auth', async () => {
  const f = fixture();
  const pending = defer();
  f.session.command = () => pending.promise;
  const operation = f.controller.command(invitation);
  f.server.current = false;
  f.ports.captureSession = () => { throw new Error('new-account authentication must not be read'); };
  pending.resolve(f.response({ status: 'applied', receiptId: 'receipt-1' }));
  await operation;
  await f.controller.checkAgain();
  assert.equal(f.controller.getState().snapshot, null);
  assert.equal(f.controller.getState().status, 'unavailable');
  assert.equal(f.controller.getRecovery().accountId, 'owner');
  assert.deepEqual(f.calls, []);
});

test('response account/generation mismatch never applies a snapshot or clears uncertain command', async () => {
  const f = fixture();
  f.session.read = async () => ({ ...f.response(snapshot()), generation: 'wrong-generation' });
  await f.controller.load();
  assert.equal(f.controller.getState().status, 'failed');
  assert.equal(f.controller.getState().snapshot, null);
  f.session.command = async () => ({ ...f.response({ status: 'applied', receiptId: 'receipt' }), accountId: 'other' });
  await f.controller.command(invitation);
  assert.equal(f.controller.getState().status, 'unknown');
  assert.notEqual(f.controller.getRecovery(), null);
});

test('injected command failure retains key and applied/readback failure needs only a read retry', async () => {
  const f = fixture();
  f.session.command = async () => { throw new Error('connection lost'); };
  await f.controller.command(invitation);
  assert.equal(f.controller.getRecovery().request.idempotencyKey, 'command-key');
  f.session.read = async () => { throw new Error('read unavailable'); };
  await f.controller.checkAgain();
  assert.equal(f.controller.getRecovery().receiptId, 'receipt-1');
  f.session.read = async () => f.response(snapshot());
  await f.controller.checkAgain();
  assert.equal(f.calls.filter(call => call[0] === 'reconcile').length, 1);
  assert.equal(f.controller.getRecovery(), null);
});

test('create, accept, revoke and leave use the same isolated command seam; signed-out is unavailable', async () => {
  const f = fixture();
  for (const command of [{ type: 'create' }, { type: 'accept', invitationId: 'invite-a' },
    { type: 'revoke', familyId: 'family-a', expectedRevision: '1', invitationId: 'invite-a' },
    { type: 'leave', familyId: 'family-a', expectedRevision: '1' }]) await f.controller.command(command);
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 4);
  f.ports.captureSession = () => null;
  const signedOut = new FamilyMembershipController(f.ports);
  await signedOut.command({ type: 'create' });
  assert.equal(signedOut.getState().status, 'unavailable');
});
