const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

// Native Node stripping needs the extension for this one app-style import; leave other test modules untouched.
const consumerURL = pathToFileURL(join(__dirname, '..', 'familyConsumer.ts')).href;
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(context.parentURL === consumerURL && specifier === './family' ? './family.ts' : specifier, context);
} });
let FamilyMembershipConsumer;
try { ({ FamilyMembershipConsumer } = require('../familyConsumer.ts')); }
finally { hook.deregister(); }

const INVITE = { invitationId: 'invite-a', familyId: 'family-a', ownerAccountId: 'owner-a' };
const joined = () => ({ kind: 'commercial_family', familyId: 'family-a', revision: '2', ownerAccountId: 'owner-a', totalSeats: 5,
  members: [{ accountId: 'owner-a', role: 'owner' }, { accountId: 'member-a', role: 'member' }],
  pendingInvitations: [], entitlement: { accountId: 'member-a', status: 'inactive' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  const calls = [];
  const state = { current: true, snapshot: null, invitations: [{ ...INVITE }], outcome: { status: 'applied', receiptId: 'receipt-a' } };
  const response = value => ({ accountId: 'member-a', generation: 'generation-a', value });
  const session = { accountId: 'member-a', generation: 'generation-a', isCurrent: () => state.current,
    read: async () => { calls.push(['read']); return response(state.snapshot); },
    invitations: async () => { calls.push(['invitations']); return response(state.invitations); },
    command: async request => { calls.push(['command', request]); return response(state.outcome); },
    reconcile: async request => { calls.push(['reconcile', request]); return response(state.outcome); } };
  const ports = { captureSession: () => { calls.push(['capture']); return session; }, newIdempotencyKey: () => 'accept-key' };
  return { consumer: new FamilyMembershipConsumer(ports), ports, session, state, calls, response };
}

test('signed-out consumer hides all data and absent invitation port is explicitly unavailable', async () => {
  const f = fixture();
  const captureSession = f.ports.captureSession;
  f.ports.captureSession = () => null;
  const signedOut = new FamilyMembershipConsumer(f.ports);
  await signedOut.load(); await signedOut.acceptInvitation(INVITE.invitationId); await signedOut.checkAgain();
  assert.equal(signedOut.getState().family.reason, 'authentication_required');
  assert.deepEqual(signedOut.getState().invitations.items, []);
  assert.deepEqual(f.calls, [['capture']]);
  f.ports.captureSession = captureSession;
  delete f.session.invitations;
  await f.consumer.load();
  assert.equal(f.consumer.getState().family.status, 'ready');
  assert.equal(f.consumer.getState().invitations.status, 'unavailable');
  assert.equal(f.consumer.getState().invitations.reason, 'invitation_discovery_unavailable');
});

test('family and discovery share one synchronous capture per load and returned data are immutable copies', async () => {
  const f = fixture();
  f.state.snapshot = joined();
  await f.consumer.load();
  assert.deepEqual(f.calls.map(call => call[0]), ['capture', 'capture', 'read', 'invitations']);
  const state = f.consumer.getState();
  state.invitations.items[0].invitationId = 'tampered';
  state.family.snapshot.members[0].accountId = 'tampered';
  assert.deepEqual(f.consumer.getState().invitations.items, [INVITE]);
  assert.equal(f.consumer.getState().family.snapshot.members[0].accountId, 'owner-a');
  assert.equal(f.consumer.getState().family.snapshot.entitlement.status, 'inactive');
});

test('malformed invitation collections fail closed and cannot be accepted', async () => {
  const f = fixture();
  for (const value of [null, {}, [null], [{ ...INVITE, familyId: '' }], [{ ...INVITE, ownerAccountId: 42 }],
    [{ ...INVITE, invitationId: ' padded ' }], [{ ...INVITE }, { ...INVITE }]]) {
    f.state.invitations = value;
    await f.consumer.load();
    assert.equal(f.consumer.getState().invitations.status, 'failed');
    assert.deepEqual(f.consumer.getState().invitations.items, []);
    await f.consumer.acceptInvitation(INVITE.invitationId);
  }
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 0);
});

test('foreign-account and wrong-generation responses discard previously discovered invitations', async () => {
  const f = fixture();
  await f.consumer.load();
  for (const mismatch of [{ accountId: 'other-account' }, { generation: 'other-generation' }]) {
    f.session.invitations = async () => ({ ...f.response([INVITE]), ...mismatch });
    await f.consumer.load();
    assert.equal(f.consumer.getState().invitations.status, 'failed');
    assert.deepEqual(f.consumer.getState().invitations.items, []);
    await f.consumer.acceptInvitation(INVITE.invitationId);
  }
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 0);
});

test('late invitation results after account replacement are hidden and never accepted', async () => {
  const f = fixture();
  const pending = deferred();
  const entered = deferred();
  f.session.invitations = () => { entered.resolve(); return pending.promise; };
  const operation = f.consumer.load();
  await entered.promise;
  f.state.current = false;
  f.ports.captureSession = () => { throw new Error('replacement auth must not be captured'); };
  pending.resolve(f.response([INVITE]));
  await operation;
  await f.consumer.acceptInvitation(INVITE.invitationId);
  assert.equal(f.consumer.getState().family.snapshot, null);
  assert.equal(f.consumer.getState().invitations.reason, 'session_changed');
  assert.deepEqual(f.consumer.getState().invitations.items, []);
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 0);
});

test('overlapping loads are ignored while pending and cannot replace newer settled discovery', async () => {
  const f = fixture();
  const pending = deferred();
  const entered = deferred();
  f.session.invitations = () => { f.calls.push(['invitations']); entered.resolve(); return pending.promise; };
  const first = f.consumer.load();
  await entered.promise;
  await f.consumer.load();
  pending.resolve(f.response([INVITE]));
  await first;
  assert.equal(f.calls.filter(call => call[0] === 'read').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'invitations').length, 1);
  assert.equal(f.consumer.getState().busy, false);
  f.session.invitations = async () => f.response([]);
  await f.consumer.load();
  assert.deepEqual(f.consumer.getState().invitations.items, []);
});

test('only an explicit discovered invitation dispatches acceptance and membership comes from readback', async () => {
  const f = fixture();
  await f.consumer.acceptInvitation(INVITE.invitationId);
  await f.consumer.load();
  await f.consumer.acceptInvitation('undiscovered');
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 0);
  const pending = deferred();
  f.session.command = request => { f.calls.push(['command', request]); return pending.promise; };
  const operation = f.consumer.acceptInvitation(INVITE.invitationId);
  assert.equal(f.consumer.getState().family.snapshot, null);
  assert.equal(f.consumer.getState().family.status, 'submitting');
  await f.consumer.acceptInvitation(INVITE.invitationId);
  f.state.snapshot = joined(); f.state.invitations = [];
  pending.resolve(f.response({ status: 'applied', receiptId: 'receipt-a' }));
  await operation;
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 1);
  assert.equal(f.consumer.getState().family.snapshot.members.length, 2);
  assert.equal(f.consumer.getState().family.snapshot.entitlement.status, 'inactive');
  assert.deepEqual(f.consumer.getState().invitations.items, []);
});

test('unknown acceptance retains controller receipt/key and reconciliation does not replay acceptance', async () => {
  const f = fixture();
  await f.consumer.load();
  f.state.outcome = { status: 'unknown', code: 'timeout' };
  await f.consumer.acceptInvitation(INVITE.invitationId);
  assert.equal(f.consumer.getState().family.status, 'unknown');
  const recovery = f.consumer.getRecovery();
  assert.deepEqual(recovery.request, { command: { type: 'accept', invitationId: INVITE.invitationId }, idempotencyKey: 'accept-key' });
  recovery.request.command.invitationId = 'tampered';
  await f.consumer.load();
  await f.consumer.acceptInvitation(INVITE.invitationId);
  f.state.outcome = { status: 'applied', receiptId: 'receipt-a' };
  f.state.snapshot = joined(); f.state.invitations = [];
  await f.consumer.checkAgain();
  const commands = f.calls.filter(call => call[0] === 'command' || call[0] === 'reconcile');
  assert.equal(commands.length, 2);
  assert.deepEqual(commands.map(call => call[0]), ['command', 'reconcile']);
  assert.deepEqual(commands[0][1], commands[1][1]);
  assert.equal(f.consumer.getRecovery(), null);
});

test('injected discovery failure clears data without producing a membership command or paid grant', async () => {
  const f = fixture();
  await f.consumer.load();
  f.session.invitations = async () => { throw new Error('offline'); };
  await f.consumer.load();
  assert.equal(f.consumer.getState().invitations.status, 'failed');
  assert.equal(f.consumer.getState().family.snapshot, null);
  await f.consumer.acceptInvitation(INVITE.invitationId);
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 0);
});

test('dispose fences pending discovery, callbacks and future acceptance', async () => {
  const f = fixture();
  const pending = deferred();
  const entered = deferred();
  f.session.invitations = () => { entered.resolve(); return pending.promise; };
  const operation = f.consumer.load();
  await entered.promise;
  let notices = 0;
  f.consumer.subscribe(() => { notices++; });
  f.consumer.dispose();
  pending.resolve(f.response([INVITE]));
  await operation;
  await f.consumer.load(); await f.consumer.acceptInvitation(INVITE.invitationId);
  assert.equal(notices, 0);
  assert.equal(f.consumer.getState().family.reason, 'disposed');
  assert.deepEqual(f.consumer.getState().invitations.items, []);
  assert.equal(f.calls.filter(call => call[0] === 'command').length, 0);
});

test('session replacement during acceptance hides late readback and retains original uncertain intent', async () => {
  const f = fixture();
  await f.consumer.load();
  const pending = deferred();
  f.session.command = request => { f.calls.push(['command', request]); return pending.promise; };
  const operation = f.consumer.acceptInvitation(INVITE.invitationId);
  f.state.current = false;
  pending.resolve(f.response({ status: 'applied', receiptId: 'receipt-a' }));
  await operation;
  await f.consumer.checkAgain();
  assert.equal(f.consumer.getState().family.snapshot, null);
  assert.deepEqual(f.consumer.getState().invitations.items, []);
  assert.equal(f.consumer.getRecovery().accountId, 'member-a');
  assert.equal(f.calls.filter(call => call[0] === 'read').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'reconcile').length, 0);
});

const owned = (revision = '1') => ({ kind: 'commercial_family', familyId: 'owned-family', revision,
  ownerAccountId: 'member-a', totalSeats: 5,
  members: [{ accountId: 'member-a', role: 'owner' }, { accountId: 'member-b', role: 'member' }],
  pendingInvitations: [{ invitationId: 'owned-invite', inviteeAccountId: 'member-c' }],
  entitlement: { accountId: 'member-a', status: 'inactive' } });
const commands = f => f.calls.filter(call => call[0] === 'command');
async function allControls(consumer) {
  await consumer.createFamily(); await consumer.inviteAccount('member-c');
  await consumer.revokeInvitation('owned-invite'); await consumer.removeMember('member-b');
  await consumer.leaveFamily();
}

test('create requires an authoritative loaded absence and exposes only the server-created family', async () => {
  const f = fixture();
  await f.consumer.createFamily();
  assert.equal(commands(f).length, 0);
  await f.consumer.load();
  const pending = deferred(), entered = deferred();
  f.session.read = () => { entered.resolve(); return pending.promise; };
  const operation = f.consumer.createFamily(); await entered.promise;
  assert.equal(f.consumer.getState().family.snapshot, null);
  assert.equal(f.consumer.getRecovery().receiptId, 'receipt-a');
  await f.consumer.createFamily();
  pending.resolve(f.response({ ...owned(), members: [{ accountId: 'member-a', role: 'owner' }], pendingInvitations: [] })); await operation;
  assert.equal(f.consumer.getState().family.snapshot.familyId, 'owned-family');
  assert.equal(f.consumer.getState().family.snapshot.entitlement.status, 'inactive');
  await f.consumer.createFamily();
  assert.deepEqual(commands(f).map(call => call[1].command), [{ type: 'create' }]);
});

test('owner invitation captures the server revision and leaves full-family eligibility to the server', async () => {
  const f = fixture(); f.state.snapshot = { ...owned('8'), totalSeats: 2 };
  await f.consumer.load();
  await f.consumer.inviteAccount(' padded ');
  assert.equal(commands(f).length, 0);
  f.consumer.getState().family.snapshot.revision = 'tampered';
  f.state.outcome = { status: 'rejected', code: 'family_invitee_unavailable' };
  await f.consumer.inviteAccount('member-c');
  assert.deepEqual(commands(f)[0][1].command, { type: 'invite', familyId: 'owned-family', expectedRevision: '8', inviteeAccountId: 'member-c' });
  assert.equal(f.consumer.getState().family.reason, 'family_invitee_unavailable');
  assert.equal(f.consumer.getState().family.snapshot.members.length, 2);
  assert.equal(f.consumer.getState().family.snapshot.entitlement.status, 'inactive');
});

test('owner revocation and removal select known targets and wait for authoritative roster readback', async () => {
  const f = fixture(); f.state.snapshot = owned();
  let key = 0; f.ports.newIdempotencyKey = () => `owner-key-${++key}`;
  await f.consumer.load();
  await f.consumer.revokeInvitation('foreign-invite'); await f.consumer.removeMember('unknown-member');
  await f.consumer.removeMember('member-a');
  assert.equal(commands(f).length, 0);
  f.session.command = async request => {
    f.calls.push(['command', request]);
    f.state.snapshot = { ...owned('2'), pendingInvitations: [] };
    return f.response(f.state.outcome);
  };
  await f.consumer.revokeInvitation('owned-invite');
  const pending = deferred(), entered = deferred();
  f.session.read = () => { entered.resolve(); return pending.promise; };
  const operation = f.consumer.removeMember('member-b'); await entered.promise;
  assert.equal(f.consumer.getState().family.snapshot.members.length, 2);
  pending.resolve(f.response({ ...owned('3'), pendingInvitations: [], members: [{ accountId: 'member-a', role: 'owner' }] }));
  await operation;
  assert.equal(f.consumer.getState().family.snapshot.members.length, 1);
  assert.deepEqual(commands(f).map(call => call[1].command), [
    { type: 'revoke', familyId: 'owned-family', expectedRevision: '1', invitationId: 'owned-invite' },
    { type: 'remove', familyId: 'owned-family', expectedRevision: '2', memberAccountId: 'member-b' },
  ]);
});

test('members cannot invoke owner controls and only their own member role can leave', async () => {
  const f = fixture(); f.state.snapshot = joined();
  await f.consumer.load();
  await f.consumer.createFamily(); await f.consumer.inviteAccount('member-c');
  await f.consumer.revokeInvitation('owned-invite'); await f.consumer.removeMember('owner-a');
  assert.equal(commands(f).length, 0);
  f.session.command = async request => { f.calls.push(['command', request]); f.state.snapshot = null; return f.response(f.state.outcome); };
  await f.consumer.leaveFamily();
  assert.deepEqual(commands(f)[0][1].command, { type: 'leave', familyId: 'family-a', expectedRevision: '2' });
  assert.equal(f.consumer.getState().family.snapshot, null);
  const owner = fixture(); owner.state.snapshot = owned(); await owner.consumer.load();
  await owner.consumer.leaveFamily();
  assert.equal(commands(owner).length, 0);
});

test('stale-revision rejection stays visible until explicit reload supplies a new revision', async () => {
  const f = fixture(); f.state.snapshot = owned();
  let key = 0; f.ports.newIdempotencyKey = () => `key-${++key}`;
  await f.consumer.load();
  f.state.outcome = { status: 'rejected', code: 'family_stale_revision' };
  await f.consumer.inviteAccount('member-c');
  await allControls(f.consumer); await f.consumer.acceptInvitation(INVITE.invitationId);
  assert.equal(commands(f).length, 1);
  assert.equal(f.consumer.getState().family.reason, 'family_stale_revision');
  assert.equal(f.consumer.getState().family.snapshot.revision, '1');
  f.state.snapshot = owned('9'); f.state.outcome = { status: 'applied', receiptId: 'receipt-b' };
  await f.consumer.load();
  assert.equal(commands(f).length, 1);
  await f.consumer.inviteAccount('member-c');
  assert.deepEqual(commands(f).map(call => [call[1].command.expectedRevision, call[1].idempotencyKey]), [['1', 'key-1'], ['9', 'key-2']]);
});

test('unknown owner command preserves its exact intent and blocks all controls until receipt reconciliation', async () => {
  const f = fixture(); f.state.snapshot = owned(); await f.consumer.load();
  f.state.outcome = { status: 'unknown', code: 'offline' };
  await f.consumer.inviteAccount('member-c');
  const recovery = f.consumer.getRecovery(); recovery.request.command.inviteeAccountId = 'tampered';
  await f.consumer.load(); await allControls(f.consumer); await f.consumer.acceptInvitation(INVITE.invitationId);
  assert.equal(commands(f).length, 1);
  f.state.outcome = { status: 'applied', receiptId: 'receipt-b' }; f.state.snapshot = owned('2');
  await f.consumer.checkAgain();
  const reconciliation = f.calls.filter(call => call[0] === 'reconcile');
  assert.equal(reconciliation.length, 1);
  assert.deepEqual(reconciliation[0][1], commands(f)[0][1]);
  assert.equal(reconciliation[0][1].command.inviteeAccountId, 'member-c');
  assert.equal(f.consumer.getRecovery(), null);
});

test('applied removal with failed readback retains its receipt and retries only the read', async () => {
  const f = fixture(); f.state.snapshot = owned(); await f.consumer.load();
  f.session.read = async () => { throw new Error('read offline'); };
  await f.consumer.removeMember('member-b');
  assert.equal(f.consumer.getState().family.status, 'unknown');
  assert.equal(f.consumer.getState().family.snapshot.members.length, 2);
  assert.equal(f.consumer.getRecovery().receiptId, 'receipt-a');
  await allControls(f.consumer);
  assert.equal(commands(f).length, 1);
  f.session.read = async () => f.response({ ...owned('2'), members: [{ accountId: 'member-a', role: 'owner' }] });
  await f.consumer.checkAgain();
  assert.equal(f.consumer.getState().family.snapshot.members.length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'reconcile').length, 0);
  assert.equal(f.consumer.getRecovery(), null);
});

test('late owner-command results remain on the original account and cannot trigger replacement readback', async () => {
  const f = fixture(); f.state.snapshot = owned(); await f.consumer.load();
  const pending = deferred();
  f.session.command = request => { f.calls.push(['command', request]); return pending.promise; };
  const operation = f.consumer.inviteAccount('member-c');
  f.state.current = false;
  f.ports.captureSession = () => { throw new Error('replacement capture forbidden'); };
  pending.resolve(f.response({ status: 'applied', receiptId: 'late' })); await operation;
  await allControls(f.consumer); await f.consumer.checkAgain();
  assert.equal(commands(f).length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'read').length, 1);
  assert.equal(f.consumer.getState().family.snapshot, null);
  assert.equal(f.consumer.getRecovery().request.command.inviteeAccountId, 'member-c');
  assert.equal(f.consumer.getRecovery().accountId, 'member-a');
});

test('disposal during removal retains uncertainty and fences further controls and notifications', async () => {
  const f = fixture(); f.state.snapshot = owned(); await f.consumer.load();
  const pending = deferred();
  f.session.command = request => { f.calls.push(['command', request]); return pending.promise; };
  const operation = f.consumer.removeMember('member-b');
  let notices = 0; f.consumer.subscribe(() => { notices++; });
  f.consumer.dispose(); pending.resolve(f.response({ status: 'applied', receiptId: 'late' })); await operation;
  await allControls(f.consumer);
  assert.equal(commands(f).length, 1); assert.equal(notices, 0);
  assert.equal(f.consumer.getState().family.reason, 'disposed');
  assert.equal(f.consumer.getRecovery().request.command.memberAccountId, 'member-b');
});
