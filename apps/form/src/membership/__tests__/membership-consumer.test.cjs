const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const url = file => pathToFileURL(join(__dirname, '..', file)).href;
const consumerURL = url('membershipConsumer.ts'), familyURL = url('familyConsumer.ts');
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  const owned = context.parentURL === consumerURL && ['./controller', './familyConsumer'].includes(specifier)
    || context.parentURL === familyURL && specifier === './family';
  return nextResolve(owned ? `${specifier}.ts` : specifier, context);
} });
let createMembershipConsumer;
try { ({ createMembershipConsumer } = require('../membershipConsumer.ts')); }
finally { hook.deregister(); }

const ACCOUNT = { accountId: 'member-a', appAccountToken: '11111111-1111-4111-8111-111111111111' };
const PRODUCT = { id: 'synthetic.product', displayName: 'Synthetic', description: 'Fixture',
  displayPrice: 'fixture price', price: '1.00', currencyCode: 'USD', type: 'autoRenewable' };
const PROOF = { transactionId: 'synthetic-transaction', originalTransactionId: 'synthetic-original', productId: PRODUCT.id,
  productType: 'autoRenewable', appAccountToken: ACCOUNT.appAccountToken, purchaseDateMs: 1,
  expirationDateMs: null, revocationDateMs: null, localVerification: 'verified', productAllowed: true,
  jwsRepresentation: 'synthetic.receipt', source: 'purchase' };
const INVITE = { invitationId: 'invite-a', familyId: 'family-a', ownerAccountId: 'owner-a' };
const entitlement = (active = []) => ({ ...ACCOUNT, grants: [], active, purchases: {
  status: 'unconfigured', environment: 'Sandbox', chargesEnabled: false,
  verification: 'apple_jws_offline', onlineCertificateRevocation: false } });
const familySnapshot = () => ({ kind: 'commercial_family', familyId: 'family-a', revision: '2', ownerAccountId: 'owner-a', totalSeats: 5,
  members: [{ accountId: 'owner-a', role: 'owner' }, { accountId: ACCOUNT.accountId, role: 'member' }],
  pendingInvitations: [], entitlement: { accountId: ACCOUNT.accountId, status: 'active' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(change = () => {}) {
  const calls = [];
  const server = { current: true, configured: false, entitlements: entitlement(), family: null,
    invitations: [INVITE], familyOutcome: { status: 'applied', receiptId: 'family-receipt' } };
  const scope = { accountId: ACCOUNT.accountId, generation: 'generation-a', isCurrent: () => server.current };
  const response = value => ({ accountId: ACCOUNT.accountId, generation: 'generation-a', value });
  const session = { account: { ...ACCOUNT }, generation: 'generation-a', isCurrent: () => server.current,
    readEntitlements: async () => { calls.push(['read']); return server.entitlements; },
    redeem: async (code, key) => { calls.push(['redeem', code, key]); return {}; },
    deliver: async (request, proof) => { calls.push(['deliver', request, proof]);
      return { status: 'finished', transactionId: proof.transactionId, serverDeliveryId: 'server-receipt' }; } };
  const familySession = { accountId: ACCOUNT.accountId, generation: 'generation-a', isCurrent: () => server.current,
    read: async () => { calls.push(['family-read']); return response(server.family); },
    invitations: async () => { calls.push(['invitations']); return response(server.invitations); },
    command: async request => { calls.push(['family-command', request]); return response(server.familyOutcome); },
    reconcile: async request => { calls.push(['family-reconcile', request]); return response(server.familyOutcome); } };
  const options = { scope, membership: {
    captureSession: () => { calls.push(['capture-membership']); return session; },
    configuration: () => ({ purchases: server.configured ? 'configured' : 'unavailable', promos: true }),
    native: {
      products: async () => { calls.push(['products']); return { products: [PRODUCT], missingProductIds: [] }; },
      purchase: async (id, token) => { calls.push(['purchase', id, token]); return { status: 'transaction', transaction: PROOF }; },
      restore: async () => { calls.push(['restore']); return { transactions: [], truncated: false }; },
      currentEntitlements: async () => { calls.push(['current']); return { transactions: [], truncated: false }; },
    },
    newIdempotencyKey: () => 'promo-key',
    openManageSubscriptions: async () => { calls.push(['manage']); },
  }, family: {
    captureSession: () => { calls.push(['capture-family']); return familySession; },
    newIdempotencyKey: () => 'family-key',
  }, navigation: {
    openActivity: (...args) => calls.push(['activity', args]),
    openGroups: (...args) => calls.push(['groups', args]),
  } };
  const f = { options, scope, session, familySession, server, calls, response };
  change(f);
  return { ...f, consumer: createMembershipConsumer(options) };
}
const effects = calls => calls.filter(call => !call[0].startsWith('capture-'));

test('missing family and navigation remain unavailable; construction performs no read or command', async () => {
  const f = fixture(({ options }) => { delete options.family; delete options.navigation; });
  assert.deepEqual(effects(f.calls), []);
  assert.equal(f.consumer.getState().family.family.reason, 'family_unavailable');
  assert.equal(f.consumer.getState().navigation.activity, 'unavailable');
  assert.equal(f.consumer.openGroups(), false);
  await f.consumer.loadFamily(); await f.consumer.acceptFamilyInvitation(INVITE.invitationId); await f.consumer.checkFamilyAgain();
  assert.deepEqual(effects(f.calls), []);
  await f.consumer.load();
  assert.deepEqual(effects(f.calls), [['read']]);
  assert.equal(f.consumer.getState().membership.status, 'unavailable');
});

test('matching captures expose independent copied server states without promoting family access into purchase access', async () => {
  const f = fixture(); f.server.family = familySnapshot();
  await f.consumer.load(); await f.consumer.loadFamily();
  assert.deepEqual(f.calls.map(call => call[0]), ['capture-membership', 'capture-family', 'capture-membership', 'read',
    'capture-family', 'family-read', 'invitations']);
  const state = f.consumer.getState();
  assert.equal(state.family.family.snapshot.entitlement.status, 'active');
  assert.deepEqual(state.membership.entitlements.active, []);
  state.family.family.snapshot.members[0].accountId = 'tampered';
  state.family.invitations.items[0].invitationId = 'tampered';
  state.membership.entitlements.active.push('tampered');
  assert.equal(f.consumer.getState().family.family.snapshot.members[0].accountId, 'owner-a');
  assert.equal(f.consumer.getState().family.invitations.items[0].invitationId, INVITE.invitationId);
  assert.deepEqual(f.consumer.getState().membership.entitlements.active, []);
});

test('foreign account or generation from either controller port prevents effects and navigation', async () => {
  for (const change of [f => { f.session.account.accountId = 'foreign'; }, f => { f.session.generation = 'foreign'; },
    f => { f.familySession.accountId = 'foreign'; }, f => { f.familySession.generation = 'foreign'; }]) {
    const f = fixture(change);
    await f.consumer.load(); await f.consumer.loadFamily(); await f.consumer.redeem('CODE');
    await f.consumer.acceptFamilyInvitation(INVITE.invitationId);
    assert.equal(f.consumer.openActivity(), false);
    assert.equal(f.consumer.getState().membership.entitlements, null);
    assert.equal(f.consumer.getState().family.family.snapshot, null);
    assert.deepEqual(effects(f.calls), []);
  }
});

test('action-time foreign capture hides previous state without dispatching to replacement auth', async () => {
  const f = fixture(); f.server.configured = true;
  await f.consumer.load();
  f.options.membership.captureSession = () => ({ ...f.session, generation: 'replacement' });
  const before = effects(f.calls).length;
  await f.consumer.purchase(PRODUCT.id);
  assert.equal(effects(f.calls).length, before);
  assert.equal(f.consumer.getState().membership.entitlements, null);
  assert.equal(f.consumer.openGroups(), false);
});

test('purchase delegation captures the token and only server readback activates membership', async () => {
  const f = fixture(); f.server.configured = true;
  await f.consumer.load();
  const delivery = deferred(), entered = deferred();
  f.session.deliver = (request, proof) => { f.calls.push(['deliver', request, proof]); entered.resolve(); return delivery.promise; };
  const operation = f.consumer.purchase(PRODUCT.id);
  await entered.promise;
  assert.deepEqual(f.consumer.getState().membership.entitlements.active, []);
  f.server.entitlements = entitlement(['server-membership']);
  delivery.resolve({ status: 'finished', transactionId: PROOF.transactionId, serverDeliveryId: 'server-receipt' });
  await operation;
  assert.deepEqual(f.calls.find(call => call[0] === 'purchase'), ['purchase', PRODUCT.id, ACCOUNT.appAccountToken]);
  assert.equal(f.consumer.getState().membership.status, 'active');
  assert.deepEqual(f.consumer.getState().membership.entitlements.active, ['server-membership']);
});

test('unknown purchase delegates reconciliation without replaying purchase and returns recovery copies', async () => {
  const f = fixture(); f.server.configured = true;
  f.options.membership.native.purchase = async () => { f.calls.push(['purchase']); return { status: 'unknown' }; };
  await f.consumer.load(); await f.consumer.purchase(PRODUCT.id);
  const recovery = f.consumer.getRecovery(); recovery.membership.account.accountId = 'tampered';
  await f.consumer.purchase(PRODUCT.id); await f.consumer.checkAgain();
  assert.equal(f.calls.filter(call => call[0] === 'purchase').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'current').length, 1);
  assert.equal(f.consumer.getRecovery().membership.account.accountId, ACCOUNT.accountId);
  assert.equal(f.consumer.getRecovery().membership.purchase, 'unknown');
});

test('family acceptance retains the original key and only its receipt lookup reconciles unknown', async () => {
  const f = fixture();
  await f.consumer.loadFamily();
  f.server.familyOutcome = { status: 'unknown', code: 'offline' };
  await f.consumer.acceptFamilyInvitation(INVITE.invitationId);
  const recovery = f.consumer.getRecovery(); recovery.family.request.idempotencyKey = 'tampered';
  await f.consumer.acceptFamilyInvitation(INVITE.invitationId);
  f.server.familyOutcome = { status: 'applied', receiptId: 'family-receipt' };
  f.server.family = familySnapshot(); f.server.invitations = [];
  await f.consumer.checkFamilyAgain();
  const commands = f.calls.filter(call => ['family-command', 'family-reconcile'].includes(call[0]));
  assert.deepEqual(commands.map(call => call[0]), ['family-command', 'family-reconcile']);
  assert.deepEqual(commands[0][1], commands[1][1]);
  assert.equal(commands[1][1].idempotencyKey, 'family-key');
  assert.equal(f.consumer.getRecovery().family, null);
  assert.equal(f.consumer.getState().family.family.snapshot.members.length, 2);
});

test('explicit restore, promo and management use the supplied ports without automatic execution', async () => {
  const f = fixture(); f.server.configured = true;
  assert.deepEqual(effects(f.calls), []);
  await f.consumer.restore(); await f.consumer.redeem(' CODE '); await f.consumer.manageSubscriptions();
  assert.deepEqual(effects(f.calls), [['restore'], ['read'], ['redeem', 'CODE', 'promo-key'], ['read'], ['manage']]);
});

test('navigation captures the original callbacks, passes no payload and causes no membership or sharing writes', () => {
  const f = fixture();
  f.options.navigation.openGroups = () => { throw new Error('replacement callback must not run'); };
  assert.equal(f.consumer.openActivity(), true); assert.equal(f.consumer.openGroups(), true);
  assert.deepEqual(effects(f.calls), [['activity', []], ['groups', []]]);
  f.server.current = false;
  assert.equal(f.consumer.openActivity(), false); assert.equal(f.consumer.openGroups(), false);
  f.server.current = true;
  assert.equal(f.consumer.openGroups(), false);
});

test('late membership and family reads stay hidden after scope generation replacement', async () => {
  const f = fixture();
  const membershipRead = deferred(), familyRead = deferred();
  f.session.readEntitlements = () => membershipRead.promise;
  f.familySession.read = () => familyRead.promise;
  const operations = [f.consumer.load(), f.consumer.loadFamily()];
  let notices = 0; f.consumer.subscribe(() => { notices++; });
  f.scope.generation = 'replacement';
  membershipRead.resolve(entitlement(['old-account-grant'])); familyRead.resolve(f.response(familySnapshot()));
  await Promise.all(operations);
  assert.equal(notices, 0);
  assert.equal(f.consumer.getState().membership.entitlements, null);
  assert.equal(f.consumer.getState().family.family.snapshot, null);
  assert.deepEqual(f.consumer.getState().family.invitations.items, []);
  assert.equal(f.calls.filter(call => call[0] === 'invitations').length, 0);
});

test('disposal is idempotent and fences pending discovery, all later actions and subscribers', async () => {
  const f = fixture();
  const pending = deferred(), entered = deferred();
  f.familySession.invitations = () => { entered.resolve(); return pending.promise; };
  const operation = f.consumer.loadFamily(); await entered.promise;
  let notices = 0; f.consumer.subscribe(() => { notices++; });
  const before = f.calls.length;
  f.consumer.dispose(); f.consumer.dispose();
  f.consumer.subscribe(() => { notices++; });
  pending.resolve(f.response([INVITE])); await operation;
  await f.consumer.load(); await f.consumer.loadFamily(); await f.consumer.checkAgain(); await f.consumer.checkFamilyAgain();
  await f.consumer.purchase(PRODUCT.id); await f.consumer.restore(); await f.consumer.redeem('CODE');
  await f.consumer.manageSubscriptions(); await f.consumer.acceptFamilyInvitation(INVITE.invitationId);
  assert.equal(f.consumer.openGroups(), false);
  assert.equal(f.consumer.getState().membership.reason, 'disposed');
  assert.equal(f.calls.length, before); assert.equal(notices, 0);
});

test('a late purchase keeps its captured delivery port and uncertain receipt after disposal', async () => {
  const f = fixture(); f.server.configured = true;
  const pending = deferred();
  f.options.membership.native.purchase = () => pending.promise;
  f.session.deliver = async (request, proof) => { f.calls.push(['old-delivery', request, proof]); return { status: 'unknown', code: 'auth-expired' }; };
  await f.consumer.load();
  const operation = f.consumer.purchase(PRODUCT.id);
  f.consumer.dispose();
  f.options.membership.captureSession = () => { throw new Error('new account capture is forbidden'); };
  f.session.deliver = async () => { throw new Error('replacement delivery is forbidden'); };
  pending.resolve({ status: 'transaction', transaction: PROOF }); await operation;
  assert.equal(f.calls.filter(call => call[0] === 'old-delivery').length, 1);
  assert.equal(f.consumer.getState().membership.entitlements, null);
  const recovery = f.consumer.getRecovery();
  assert.equal(recovery.membership.deliveries[0].request.idempotencyKey, `storekit-delivery:${PROOF.transactionId}`);
  recovery.membership.deliveries[0].request.idempotencyKey = 'tampered';
  assert.equal(f.consumer.getRecovery().membership.deliveries[0].request.idempotencyKey, `storekit-delivery:${PROOF.transactionId}`);
});

test('combined host forwards owner controls with server-derived family identity and revision', async () => {
  const f = fixture();
  let key = 0; f.options.family.newIdempotencyKey = () => `owner-key-${++key}`;
  let revision = 0;
  const ownerSnapshot = () => ({ kind: 'commercial_family', familyId: 'owned-family', revision: String(revision),
    ownerAccountId: ACCOUNT.accountId, totalSeats: 5,
    members: [{ accountId: ACCOUNT.accountId, role: 'owner' }, { accountId: 'member-b', role: 'member' }],
    pendingInvitations: revision === 2 ? [{ invitationId: 'owned-invite', inviteeAccountId: 'member-c' }] : [],
    entitlement: { accountId: ACCOUNT.accountId, status: 'inactive' } });
  f.familySession.command = async request => {
    f.calls.push(['family-command', request]); revision++;
    f.server.family = ownerSnapshot();
    if (request.command.type === 'remove') f.server.family.members = [{ accountId: ACCOUNT.accountId, role: 'owner' }];
    return f.response({ status: 'applied', receiptId: `receipt-${revision}` });
  };
  await f.consumer.loadFamily();
  await f.consumer.createFamily(); await f.consumer.inviteFamilyAccount('member-c');
  await f.consumer.revokeFamilyInvitation('owned-invite'); await f.consumer.removeFamilyMember('member-b');
  await f.consumer.leaveFamily();
  assert.deepEqual(f.calls.filter(call => call[0] === 'family-command').map(call => call[1].command), [
    { type: 'create' },
    { type: 'invite', familyId: 'owned-family', expectedRevision: '1', inviteeAccountId: 'member-c' },
    { type: 'revoke', familyId: 'owned-family', expectedRevision: '2', invitationId: 'owned-invite' },
    { type: 'remove', familyId: 'owned-family', expectedRevision: '3', memberAccountId: 'member-b' },
  ]);
  assert.equal(f.consumer.getState().family.family.snapshot.members.length, 1);
  assert.equal(f.consumer.getState().membership.entitlements, null);
  assert.equal(f.calls.filter(call => ['activity', 'groups', 'purchase'].includes(call[0])).length, 0);
});

test('host forwards member leave but all family controls are fenced when absent, expired or disposed', async () => {
  const f = fixture(); f.server.family = familySnapshot();
  await f.consumer.loadFamily();
  f.familySession.command = async request => { f.calls.push(['family-command', request]); f.server.family = null; return f.response(f.server.familyOutcome); };
  await f.consumer.leaveFamily();
  assert.deepEqual(f.calls.find(call => call[0] === 'family-command')[1].command,
    { type: 'leave', familyId: 'family-a', expectedRevision: '2' });
  assert.equal(f.consumer.getState().family.family.snapshot, null);
  for (const kind of ['absent', 'expired', 'disposed']) {
    const guarded = fixture(({ options }) => { if (kind === 'absent') delete options.family; });
    if (kind === 'expired') guarded.server.current = false;
    if (kind === 'disposed') guarded.consumer.dispose();
    const before = guarded.calls.length;
    await guarded.consumer.createFamily(); await guarded.consumer.inviteFamilyAccount('member-c');
    await guarded.consumer.revokeFamilyInvitation('owned-invite'); await guarded.consumer.removeFamilyMember('member-b');
    await guarded.consumer.leaveFamily();
    assert.equal(guarded.calls.length, before);
  }
});
