const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..'), cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative); assert.ok(file.startsWith(root + path.sep));
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'));
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { CommunityResources } = load('api/community.ts');
const { FormTransport, ApiError } = load('api/transport.ts');
const G = '11111111-1111-4111-8111-111111111111', M = '22222222-2222-4222-8222-222222222222';
const I = '33333333-3333-4333-8333-333333333333', P = '44444444-4444-4444-8444-444444444444';
const member = (role = 'member', revision = 9) => ({ memberId: I, alias: 'Other', role, revision });
const group = (id = G, role = 'owner') => ({ id, memberId: M, name: 'Group', role, revision: 4 });
const detail = (role = 'owner', target = 'member') => ({ ...group(G, role), members: [
  { memberId: M, alias: 'Own', role, revision: 7 }, member(target),
] });
const flags = () => ({ participation: false, workout: false, exerciseSnack: false, planAdherence: false, workoutMinutes: false, exerciseCount: false, streakDays: false });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function response(call) {
  if (call.method === 'PATCH' && call.path.endsWith('/role')) return member(call.body.role, 10);
  if (call.method !== 'GET') throw new Error('Unexpected command');
  if (call.path === '/groups') return [group()];
  if (call.path === '/me/removed-memberships') return [];
  if (call.path.endsWith('/sharing')) return { revision: 1, flags: flags(), enabledAt: {} };
  if (call.path.endsWith('/policy')) return { kind: 'matched', intent: 'supportive_community', capacity: 12, revision: 4 };
  if (call.path.endsWith('/motions') || call.path.endsWith('/invitations')) return [];
  return { ...detail(), id: call.path.split('/').at(-1) };
}
async function fixture(actor = 'owner', target = 'member') {
  const calls = [], state = { handler: response, mounted: true };
  const transport = new FormTransport('https://synthetic.invalid', { load: async () => null, save: async () => {}, clear: async () => {} }, async (url, options) => {
    if (url.includes('/api/auth/sign-in')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic-session' } });
    const call = { path: new URL(url).pathname.replace('/v1/community', ''), method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body), raw: options.body, key: options.headers['Idempotency-Key'] };
    calls.push(call); const result = await state.handler(call); return result instanceof Response ? result : json(result);
  });
  await transport.signIn('synthetic@example.invalid', 'synthetic-password');
  const resources = new CommunityResources(transport, () => state.mounted), controller = resources.createGroupController();
  state.handler = call => call.path === `/groups/${G}` ? detail(actor, target) : response(call);
  await controller.loadDetail(G); state.handler = response;
  return { calls, state, transport, resources, controller };
}
const action = (c, key = 'role', role = 'admin') => c.updateRole(G, I, { role, expectedRevision: 9 }, key);
const unknown = error => error instanceof ApiError && error.originalEffectUnknown;
const mutations = f => f.calls.filter(call => call.method !== 'GET');
const affected = ['detail', 'sharing', 'policy', 'motions', 'invitations', 'groups'];
async function prime(c, id = G) {
  await c.loadGroups(); await c.loadSharing(id); await c.loadPolicy(id); await c.loadMotions(id); await c.loadInvitations(id); await c.loadRemovedMemberships();
}
function competitors(c) {
  return [() => action(c, 'replacement'), () => c.updateAlias(G, { alias: 'New', expectedRevision: 7 }, 'alias'),
    () => c.leave(G, { confirmed: true }, 'leave'), () => c.closeGroup(G, { expectedRevision: 4, confirmed: true }, 'close'),
    () => c.issueInvitation(G, 'invite'), () => c.revokeInvitation(G, P, 1, 'revoke'), () => c.replaceInvitation(G, P, 1, 'replace'),
    () => c.removeMember(G, I, { expectedRevision: 9, confirmed: true }, 'remove'),
    () => c.createGrowthMotion(G, { places: 1, expectedRevision: 4, confirmed: true }, 'growth'),
    () => c.finalizeGrowthMotion(G, P, { confirmed: true }, 'finalize-growth'),
    () => c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'removal'),
    () => c.finalizeRemovalMotion(G, P, { confirmed: true }, 'finalize-removal'),
    () => c.createGroup({ name: 'New', alias: 'Own', membershipDisclosureAccepted: true }, 'create'),
    () => c.updateSharing(G, { flags: flags(), expectedRevision: 1 }, 'sharing'),
    () => c.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'ballot')];
}

test('owner promotes and demotes selected member using target revision and returned role result', async () => {
  for (const role of ['admin', 'member']) {
    const f = await fixture('owner', role === 'admin' ? 'member' : 'admin'), c = f.controller;
    assert.equal(typeof c.updateRole, 'function');
    await prime(c); const result = await action(c, 'role', role);
    assert.deepEqual(result, member(role, 10));
    assert.deepEqual(mutations(f).map(({ path, method, body, key }) => ({ path, method, body, key })), [
      { path: `/groups/${G}/members/${I}/role`, method: 'PATCH', body: { role, expectedRevision: 9 }, key: 'role' },
    ]);
    const s = c.getSnapshot(); assert.equal(s.command.status, 'confirmed'); assert.equal(s.command.memberId, I);
    assert.deepEqual(s.command.membershipResult, { kind: 'role', value: result });
    assert.equal(s.command.invitationResult, null); assert.equal(s.command.removed, null);
    for (const name of affected) assert.equal(s[name].status, 'stale');
    assert.equal(s.removedMemberships.status, 'empty'); assert.equal(f.calls.length, 8);
  }
});

test('role validates exact input, matching detail, owner actor, nonowner target and target revision before HTTP', async () => {
  const f = await fixture(), c = f.controller;
  for (const input of [null, [], '{}', {}, { role: 'owner', expectedRevision: 9 }, { role: 'admin', expectedRevision: 0 },
    { role: 'admin', expectedRevision: 9, confirmed: true }, { role: 'admin', expectedRevision: 9, memberId: I }])
    await assert.rejects(c.updateRole(G, I, input, 'invalid'), { code: 'community_invalid_input' });
  for (const args of [['bad', I, 9, 'key'], [G, 'bad', 9, 'key'], [G, I, 9, 'bad/key']])
    await assert.rejects(c.updateRole(args[0], args[1], { role: 'admin', expectedRevision: args[2] }, args[3]), { code: 'community_invalid_input' });
  for (const [g, m, rev] of [[P, I, 9], [G, P, 9], [G, I, 4], [G, I, 7], [G, I, 8]])
    await assert.rejects(c.updateRole(g, m, { role: 'admin', expectedRevision: rev }, 'invalid'), { code: 'community_membership_reload_required' });
  await assert.rejects(c.updateRole(G, M, { role: 'member', expectedRevision: 7 }, 'self'), { code: 'community_forbidden' });
  const idle = f.resources.createGroupController(); await assert.rejects(action(idle), { code: 'community_membership_reload_required' });
  for (const actor of ['admin', 'member']) {
    const other = await fixture(actor); await assert.rejects(action(other.controller), { code: 'community_forbidden' }); assert.equal(mutations(other).length, 0);
  }
  const ownerTarget = await fixture('owner', 'owner');
  await assert.rejects(action(ownerTarget.controller), { code: 'community_forbidden' }); assert.equal(mutations(ownerTarget).length, 0);
  assert.equal(mutations(f).length, 0);
});

test('pending observers cannot mutate copied role input, dispatch competitors or retry early', async () => {
  const f = await fixture(), c = f.controller, input = { role: 'admin', expectedRevision: 9 }, attempts = [];
  let finish, observed = false; f.state.handler = () => new Promise(resolve => { finish = resolve; });
  c.subscribe(() => {
    if (c.getSnapshot().command.status !== 'pending') return;
    input.role = 'member'; input.expectedRevision = 99;
    if (!observed) { observed = true; for (const compete of competitors(c)) attempts.push(assert.rejects(compete(), { code: 'community_intent_in_flight' })); }
    if (c.inspectIntent('role')) attempts.push(assert.rejects(c.retry('role'), { code: 'community_intent_in_flight' }));
  });
  const pending = c.updateRole(G, I, input, 'role');
  assert.equal(c.getSnapshot().command.membershipResult, null);
  finish(member('admin', 10)); await pending; await Promise.all(attempts);
  assert.equal(mutations(f).length, 1); assert.deepEqual(mutations(f)[0].body, { role: 'admin', expectedRevision: 9 });
});

test('wrong-member and malformed responses retain exact owned retry and permit later current projection after failed detail', async () => {
  for (const invalid of [{ ...member('admin', 10), memberId: P }, { ...member('admin', 10), privateField: 'hidden' }]) {
    const f = await fixture(), c = f.controller; f.state.handler = () => invalid;
    await assert.rejects(action(c), error => unknown(error) && error.code === 'community_invalid_response');
    assert.equal(c.inspectIntent('role').state, 'unknown'); assert.equal(c.getSnapshot().command.membershipResult, null);
    for (const compete of competitors(c)) await assert.rejects(compete(), error => unknown(error) && error.code === 'community_membership_reconcile_required');
    await assert.rejects(action(c, 'role'), unknown);
    f.state.handler = () => json({ error: { code: 'community_not_found' } }, 404);
    await assert.rejects(c.loadDetail(G), { code: 'community_not_found' });
    await assert.rejects(c.retry('role'), error => error.code === 'community_not_found' && unknown(error));
    assert.equal(c.inspectIntent('role').state, 'unknown'); assert.equal(c.getSnapshot().command.membershipResult, null);
    f.state.handler = () => ({ ...member('member', 17), alias: 'Later alias' });
    const result = await c.retry('role'); assert.deepEqual(result, { ...member('member', 17), alias: 'Later alias' });
    assert.deepEqual(c.getSnapshot().command.membershipResult, { kind: 'role', value: result });
    assert.equal(c.inspectIntent('role').originalEffectUnknown, true);
    const sent = mutations(f); assert.equal(sent.length, 3);
    assert.ok(sent.every(call => call.path === sent[0].path && call.method === 'PATCH' && call.raw === sent[0].raw && call.key === 'role'));
  }
});

test('role cannot adopt resource or sibling controller keys', async () => {
  const f = await fixture(), c = f.controller;
  await f.resources.updateRole(G, I, { role: 'admin', expectedRevision: 9 }, 'foreign');
  await assert.rejects(action(c, 'foreign'), { code: 'community_controller_intent_unavailable' });
  assert.throws(() => c.retry('foreign'), { code: 'community_controller_intent_unavailable' });
  await action(c, 'owned'); const sibling = f.resources.createGroupController();
  assert.throws(() => sibling.inspectIntent('owned'), { code: 'community_controller_intent_unavailable' });
  assert.throws(() => sibling.retry('owned'), { code: 'community_controller_intent_unavailable' });
  assert.equal(mutations(f).length, 2);
});

test('other pending and unknown commands exclude a new role intent', async () => {
  for (const kind of ['alias', 'leave', 'close', 'invitation', 'removal', 'growth', 'sharing', 'create', 'ballot']) {
    const f = await fixture(), c = f.controller; await prime(c); let reject;
    f.state.handler = () => new Promise((_, failure) => { reject = failure; });
    const start = { alias: () => c.updateAlias(G, { alias: 'New', expectedRevision: 7 }, 'other'),
      leave: () => c.leave(G, { confirmed: true }, 'other'), close: () => c.closeGroup(G, { expectedRevision: 4, confirmed: true }, 'other'),
      invitation: () => c.issueInvitation(G, 'other'), removal: () => c.removeMember(G, I, { expectedRevision: 9, confirmed: true }, 'other'),
      growth: () => c.createGrowthMotion(G, { places: 1, expectedRevision: 4, confirmed: true }, 'other'),
      sharing: () => c.updateSharing(G, { flags: flags(), expectedRevision: 1 }, 'other'),
      create: () => c.createGroup({ name: 'New', alias: 'Own', membershipDisclosureAccepted: true }, 'other'),
      ballot: () => c.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'other') }[kind];
    const pending = start(); await assert.rejects(action(c), { code: 'community_intent_in_flight' });
    reject(new Error('lost')); await assert.rejects(pending, unknown);
    await assert.rejects(action(c), unknown); assert.equal(mutations(f).length, 1);
  }
});

test('role invalidates matching authority reads at dispatch and settlement while unrelated slots and notices survive', async () => {
  for (const outcome of ['success', 'failure']) {
    const f = await fixture(), c = f.controller; await prime(c); const pending = [];
    f.state.handler = call => new Promise(resolve => pending.push({ call, resolve }));
    const beforeReads = [c.loadGroups(), c.loadSharing(G), c.loadPolicy(G), c.loadMotions(G), c.loadInvitations(G)];
    const command = action(c); for (const name of affected) assert.equal(c.getSnapshot()[name].status, 'stale');
    for (const entry of pending.slice(0, 5)) entry.resolve(response(entry.call)); await Promise.all(beforeReads);
    for (const name of affected) assert.equal(c.getSnapshot()[name].status, 'stale');
    const afterReads = [c.loadDetail(G), c.loadGroups(), c.loadSharing(G), c.loadPolicy(G), c.loadMotions(G), c.loadInvitations(G)];
    pending[5].resolve(outcome === 'success' ? member('admin', 10) : json({ error: { code: 'stale_revision' } }, 409));
    if (outcome === 'success') await command; else await assert.rejects(command, { code: 'stale_revision' });
    for (const entry of pending.slice(6)) entry.resolve(response(entry.call)); await Promise.all(afterReads);
    for (const name of affected) assert.equal(c.getSnapshot()[name].status, 'stale');
    assert.equal(c.getSnapshot().removedMemberships.status, 'empty');
  }
  const f = await fixture(), c = f.controller; await prime(c, P); const before = c.getSnapshot();
  await action(c); for (const name of ['sharing', 'policy', 'motions', 'invitations', 'removedMemberships']) assert.equal(c.getSnapshot()[name], before[name]);
});

test('stale governed and access races retain sanitized codes and no result', async () => {
  for (const [status, code] of [[409, 'stale_revision'], [409, 'community_governed_action_required'], [403, 'community_forbidden'], [404, 'community_not_found'], [409, 'community_membership_changed']]) {
    const f = await fixture(), c = f.controller; await prime(c);
    f.state.handler = () => json({ error: { code, message: 'PRIVATE server detail', details: { secret: 'PRIVATE' } } }, status);
    await assert.rejects(action(c), error => error.code === code && !error.message.includes('PRIVATE') && !error.originalEffectUnknown);
    const s = c.getSnapshot(); assert.equal(s.command.membershipResult, null); assert.equal(s.command.error.code, code);
    assert.equal(JSON.stringify(s).includes('PRIVATE'), false); for (const name of affected) assert.equal(s[name].status, 'stale');
  }
});

test('observer teardown before dispatch and confirmation prevents leaked results; observer exceptions are isolated', async () => {
  for (const phase of ['pending', 'confirmed']) {
    const f = await fixture(), c = f.controller;
    c.subscribe(() => { if (c.getSnapshot().command.status === phase) c.dispose(); });
    await assert.rejects(action(c), { code: 'session_changed' });
    assert.equal(c.getSnapshot().command.membershipResult, null); assert.equal(mutations(f).length, phase === 'pending' ? 0 : 1);
  }
  const f = await fixture(), c = f.controller; c.subscribe(() => { throw new Error('observer'); });
  assert.deepEqual(await action(c), member('admin', 10)); assert.equal(c.getSnapshot().command.status, 'confirmed');
});

test('controller resource account and mount teardown fence in-flight role response and reads', async () => {
  for (const end of ['controller', 'resource', 'session', 'mount']) {
    const f = await fixture(), c = f.controller, pending = [];
    f.state.handler = () => new Promise(resolve => pending.push(resolve));
    const command = action(c), read = c.loadDetail(G);
    if (end === 'controller') c.dispose(); else if (end === 'resource') f.resources.dispose();
    else if (end === 'session') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else f.state.mounted = false;
    assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().command.membershipResult, null);
    pending[0](member('admin', 10)); pending[1](detail());
    await assert.rejects(command, error => error.code === 'session_changed' && unknown(error)); await assert.rejects(read, { code: 'session_changed' });
    assert.equal(c.getSnapshot().detail.data, null); assert.throws(() => c.retry('role'), { code: 'session_changed' });
    assert.equal(mutations(f).length, 1);
  }
});
