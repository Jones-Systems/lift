const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../../..'), cache = new Map();
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
const { createSharingConsumer, privateSharingFlags, minimalSharingFlags, privateProfileInput } = load('community/sharing/index.ts');
const { CommunityResources } = load('api/community.ts');
const { FormTransport, ApiError } = load('api/transport.ts');
const G = '11111111-1111-4111-8111-111111111111', H = '33333333-3333-4333-8333-333333333333';
const M = '22222222-2222-4222-8222-222222222222', N = '44444444-4444-4444-8444-444444444444';
const at = '2026-10-09T12:00:00.000Z';
const sharing = (flags = privateSharingFlags(), revision = 1) => ({ flags, revision,
  enabledAt: Object.fromEntries(Object.entries(flags).filter(([, value]) => value).map(([key]) => [key, at])) });
const profile = () => { const { expectedRevision, audiencePreviewAccepted, ...value } = privateProfileInput(0); return { revision: expectedRevision, ...value }; };
const membership = (groupId = G, role = 'member', revision = 1) => ({ id: groupId, memberId: M, name: 'Group', role, revision: 1,
  members: [{ memberId: M, alias: 'Leaf', role, revision }] });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function fixture(handler) {
  const calls = [], state = { handler, auth: 0, membership: call => membership(call.path.split('/')[2]) };
  const transport = new FormTransport('https://synthetic.invalid', { load: async () => null, save: async () => {}, clear: async () => {} }, async (url, options) => {
    if (url.includes('/api/auth/sign-in')) return new Response('{}', { headers: { 'set-auth-token': `synthetic-${++state.auth}` } });
    const call = { path: new URL(url).pathname.replace('/v1/community', '') + new URL(url).search,
      method: options.method, body: options.body === undefined ? undefined : JSON.parse(options.body), raw: options.body,
      key: options.headers['Idempotency-Key'], auth: options.headers.Authorization };
    calls.push(call);
    const result = await (/^\/groups\/[^/]+$/.test(call.path) && call.method === 'GET' ? state.membership(call) : state.handler(call));
    return result instanceof Response ? result : json(result);
  });
  await transport.signIn('synthetic@example.invalid', 'synthetic-password');
  const resources = new CommunityResources(transport);
  return { consumer: createSharingConsumer(resources), resources, transport, calls, state };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('private defaults and minimal actor/group sharing disclose only adherence', async () => {
  assert.ok(Object.values(privateSharingFlags()).every(value => value === false));
  assert.deepEqual(Object.entries(minimalSharingFlags()).filter(([, value]) => value), [['planAdherence', true]]);
  const f = await fixture(call => sharing(call.method === 'PATCH' ? call.body.flags : privateSharingFlags()));
  assert.deepEqual(f.consumer.audiencePreview(G, minimalSharingFlags()).fields, ['planAdherence']);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.consumer.audiencePreview(G, { ...privateSharingFlags(), workoutMinutes: true }), error => error.status === 422);
  assert.throws(() => f.consumer.audiencePreview(G, { ...minimalSharingFlags(), health: true }), error => error.status === 422);
  await f.consumer.loadSharing(G);
  assert.deepEqual(f.consumer.audiencePreview(G), { groupId: G, scope: 'entire_group', recipientSettings: 'unsupported', fields: [] });
  assert.equal(f.consumer.audiencePreview(H), null);
  await f.consumer.updateSharing(G, { flags: minimalSharingFlags(), expectedRevision: 1 }, 'minimal');
  assert.equal(f.consumer.getSnapshot().groups[G].sharing.status, 'stale');
  f.state.handler = () => sharing(minimalSharingFlags(), 2);
  await f.consumer.loadSharing(G);
  assert.deepEqual(f.consumer.audiencePreview(G).fields, ['planAdherence']);
  assert.deepEqual(f.calls[1].body, { flags: minimalSharingFlags(), expectedRevision: 1 });
  f.consumer.dispose();
});

test('selected member projections preserve omissions and independent group reads', async () => {
  const f = await fixture(call => call.path.endsWith('/profiles')
    ? [{ memberId: M, alias: 'Leaf', profile: {} }, { memberId: N, alias: 'Sun', profile: { region: 'EU' } }]
    : { summaryStatus: 'available', members: [{ memberId: M, alias: 'Leaf', days: [{ localDate: '2026-10-09', planAdherence: 'met' }] }] });
  await f.consumer.loadRoster(G);
  await f.consumer.loadSummary(G, { from: '2026-10-09', to: '2026-10-09' });
  const projection = f.consumer.memberProjection(G, M);
  assert.deepEqual(projection.days, [{ localDate: '2026-10-09', planAdherence: 'met' }]);
  assert.deepEqual(projection.profile, {});
  assert.equal(projection.rankings, 'unavailable');
  assert.equal(Object.hasOwn(projection.days[0], 'workout'), false);
  assert.equal(f.consumer.memberProjection(G, N).days, null);
  assert.deepEqual(f.consumer.memberProjection(G, N).profile, { region: 'EU' });
  assert.equal(f.consumer.memberProjection(H, M).profile, null);
  f.state.handler = () => json({ code: 'membership_changed', message: 'Unavailable' }, 403);
  await assert.rejects(f.consumer.loadRoster(H));
  assert.equal(f.consumer.getSnapshot().groups[G].roster.status, 'ready');
  assert.equal(f.consumer.getSnapshot().groups[H].roster.status, 'error');
  f.consumer.dispose();
});

test('unknown mutation blocks different intent and exact retry retains original fields, revision and unknown history', async () => {
  let attempt = 0;
  const f = await fixture(call => {
    if (++attempt === 1) throw new Error('synthetic lost response');
    if (attempt === 2) return json({ code: 'membership_changed', message: 'Unavailable' }, 403);
    return sharing(call.body.flags, 2);
  });
  const input = { flags: minimalSharingFlags(), expectedRevision: 1 };
  await assert.rejects(f.consumer.updateSharing(G, input, 'original'), error => error.originalEffectUnknown);
  input.flags = privateSharingFlags(); input.expectedRevision = 99;
  await assert.rejects(f.consumer.updateProfile(H, privateProfileInput(0), 'different'), error => error.code === 'sharing_unresolved_intent');
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.consumer.retry('original'), error => error.originalEffectUnknown && error.status === 403);
  assert.equal(f.consumer.getSnapshot().command.intent.state, 'unknown');
  await f.consumer.retry('original');
  assert.equal(f.consumer.getSnapshot().command.intent.originalEffectUnknown, true);
  for (const call of f.calls) { assert.equal(call.key, 'original'); assert.equal(call.path, `/groups/${G}/me/sharing`);
    assert.equal(call.raw, f.calls[0].raw); assert.deepEqual(call.body, { flags: minimalSharingFlags(), expectedRevision: 1 }); }
  assert.equal(f.consumer.getSnapshot().groups[G].sharing.status, 'stale');
  f.consumer.dispose();
});

test('pending writes block reentrant and concurrent intent; profile revision zero preserves consent', async () => {
  const gate = deferred(); const f = await fixture(() => gate.promise);
  const request = f.consumer.updateProfile(G, privateProfileInput(0), 'profile');
  await assert.rejects(f.consumer.updateSharing(H, { flags: minimalSharingFlags(), expectedRevision: 1 }, 'other'), error => error.code === 'sharing_unresolved_intent');
  gate.resolve(profile()); await request;
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].body, privateProfileInput(0));
  f.consumer.dispose();
});

test('explicit membership/role invalidation drops displays and superseded read completion', async () => {
  const gate = deferred(); const f = await fixture(call => call.path.endsWith('/profile-sharing') ? profile() : gate.promise);
  await f.consumer.loadProfile(G);
  const read = f.consumer.loadSharing(G);
  f.consumer.invalidateGroup(G); gate.resolve(sharing()); await read;
  assert.equal(f.consumer.getSnapshot().groups[G].sharing.status, 'stale');
  assert.equal(f.consumer.getSnapshot().groups[G].profile.data, null);
  f.state.handler = () => json({ code: 'membership_changed', message: 'Unavailable' }, 403);
  await assert.rejects(f.consumer.updateSharing(G, { flags: minimalSharingFlags(), expectedRevision: 1 }, 'after-role'));
  assert.equal(f.consumer.getSnapshot().command.status, 'error');
  assert.equal(f.consumer.getSnapshot().command.intent.state, 'rejected');
  f.consumer.dispose();
});

test('resource disposal clears displays synchronously and late auth results cannot repopulate', async () => {
  const gate = deferred(); const f = await fixture(call => call.path.endsWith('/profile-sharing') ? profile() : gate.promise);
  await f.consumer.loadProfile(G);
  let cleared = false;
  f.consumer.subscribe(() => { if (f.consumer.getSnapshot().disposed) cleared = true; });
  const read = f.consumer.loadSharing(G);
  await f.transport.signIn('other@example.invalid', 'synthetic-password');
  assert.equal(cleared, true); assert.deepEqual(f.consumer.getSnapshot().groups, {});
  gate.resolve(sharing()); await assert.rejects(read, error => error.code === 'session_changed');
  assert.deepEqual(f.consumer.getSnapshot().groups, {});
  await assert.rejects(f.consumer.updateProfile(G, privateProfileInput(0), 'old'), error => error.code === 'session_changed');
});

test('unavailable summary and profile response policy do not create public data', async () => {
  const f = await fixture(call => call.path.includes('/summary?') ? { summaryStatus: 'unavailable', members: [] }
    : { ...profile(), flags: { ...profile().flags, age: true } });
  await f.consumer.loadSummary(G, { from: '2026-10-09', to: '2026-10-09' });
  assert.equal(f.consumer.memberProjection(G, M).summaryStatus, 'unavailable');
  await assert.rejects(f.consumer.loadProfile(G), error => error.code === 'community_invalid_response');
  assert.equal(f.consumer.getSnapshot().groups[G].profile.data, null);
  await assert.rejects(f.consumer.loadSummary(H, { from: '2026-10-01', to: '2026-11-01' }), error => error.status === 422);
  f.consumer.dispose();
});

test('rejected change requires its affected settings reload before different intent', async () => {
  const f = await fixture(() => json({ code: 'revision_conflict', message: 'Reload' }, 409));
  await assert.rejects(f.consumer.updateSharing(G, { flags: minimalSharingFlags(), expectedRevision: 1 }, 'rejected'));
  assert.equal(f.consumer.getSnapshot().command.intent.disposition, 'reload_before_new_intent');
  await assert.rejects(f.consumer.updateProfile(H, privateProfileInput(0), 'new'), error => error.code === 'sharing_reload_required');
  assert.equal(f.calls.length, 1);
  f.state.handler = call => call.path.endsWith('/profile-sharing') ? profile() : sharing();
  await f.consumer.loadSharing(G);
  await f.consumer.updateProfile(H, privateProfileInput(0), 'new');
  f.consumer.dispose();
});

test('same-group authorization failure clears all displays and fences outstanding reads while preserving another group', async () => {
  const gate = deferred();
  const f = await fixture(call => call.path.endsWith('/profile-sharing') ? profile() : sharing());
  await f.consumer.loadSharing(G); await f.consumer.loadProfile(G); await f.consumer.loadSharing(H);
  f.state.handler = call => call.path.endsWith('/profiles') ? gate.promise : json({ code: 'role_changed', message: 'Unavailable' }, 403);
  const late = f.consumer.loadRoster(G);
  await assert.rejects(f.consumer.loadSummary(G, { from: '2026-10-09', to: '2026-10-09' }));
  assert.equal(f.consumer.getSnapshot().groups[G].profile.data, null);
  assert.equal(f.consumer.audiencePreview(G), null);
  assert.equal(f.consumer.getSnapshot().groups[H].sharing.status, 'ready');
  gate.resolve([{ memberId: M, alias: 'Leaf', profile: { region: 'EU' } }]); await late;
  assert.equal(f.consumer.getSnapshot().groups[G].roster.status, 'stale');
  assert.equal(f.consumer.memberProjection(G, M).profile, null);
  f.consumer.dispose();
});

test('selected civil date composition preserves each authoritative adherence value and only selected permitted fields', async () => {
  const values = ['met', 'not_met', 'pending', 'unknown', 'not_applicable'];
  const days = values.map((planAdherence, i) => ({ localDate: `2026-10-${10 + i}`, planAdherence,
    workout: 'recorded', workoutMinutes: 30, exerciseCount: 2, streakDays: 3 }));
  const f = await fixture(call => call.path.endsWith('/profiles')
    ? [{ memberId: M, alias: 'Leaf', profile: {} }, { memberId: N, alias: 'Sun', profile: { avatar: 'sun' } }]
    : { summaryStatus: 'available', members: [{ memberId: M, alias: 'Leaf', days },
      { memberId: N, alias: 'Sun', days: [{ localDate: '2026-10-10', planAdherence: 'not_met' }] }] });
  await f.consumer.refreshMembership(G);
  await f.consumer.loadRoster(G); await f.consumer.loadSummary(G, { from: '2026-10-10', to: '2026-10-14' });
  for (let i = 0; i < values.length; i++) {
    const selection = { groupId: G, memberId: M, localDate: days[i].localDate };
    const result = f.consumer.selectedMemberProjection(selection);
    assert.deepEqual(result.selection, selection);
    assert.deepEqual(result.followedPlan, { status: 'shared', value: values[i] });
    assert.deepEqual(result.activity, { planAdherence: values[i] });
    assert.deepEqual(result.profile, {});
    assert.equal(Object.hasOwn(result, 'days'), false);
    assert.equal(result.audience, 'entire_group');
  }
  const limited = f.consumer.selectedMemberProjection({ groupId: G, memberId: M, localDate: '2026-10-10' }, ['workoutMinutes']);
  assert.deepEqual(limited.activity, { workoutMinutes: 30 });
  assert.deepEqual(limited.followedPlan, { status: 'not_shared', value: null });
  assert.deepEqual(f.consumer.selectedMemberProjection({ groupId: G, memberId: N, localDate: '2026-10-10' }).followedPlan,
    { status: 'shared', value: 'not_met' });
  assert.equal(f.consumer.selectedMemberProjection({ groupId: H, memberId: M, localDate: '2026-10-10' }).profile, null);
  f.consumer.dispose();
});

test('missing adherence, missing selected day and missing member disclose nothing despite recorded workout', async () => {
  const f = await fixture(() => ({ summaryStatus: 'available', members: [{ memberId: M, alias: 'Leaf',
    days: [{ localDate: '2026-10-10', workout: 'recorded' }] }] }));
  await f.consumer.refreshMembership(G);
  await f.consumer.loadSummary(G, { from: '2026-10-10', to: '2026-10-11' });
  for (const [memberId, localDate] of [[M, '2026-10-10'], [M, '2026-10-11'], [N, '2026-10-10']]) {
    const result = f.consumer.selectedMemberProjection({ groupId: G, memberId, localDate });
    assert.deepEqual(result.followedPlan, { status: 'not_shared', value: null });
    assert.deepEqual(result.activity, {});
  }
  f.consumer.dispose();
});

test('selected projection distinguishes unread, uncovered, unavailable, stale and error without guessing dates', async () => {
  const f = await fixture(() => ({ summaryStatus: 'unavailable', members: [] }));
  const selected = { groupId: G, memberId: M, localDate: '2026-10-10' };
  assert.equal(f.consumer.selectedMemberProjection(selected).summaryReadStatus, 'idle');
  assert.equal(f.consumer.selectedMemberProjection(selected).followedPlan.status, 'not_loaded');
  await f.consumer.refreshMembership(G);
  await f.consumer.loadSummary(G, { from: '2026-10-10', to: '2026-10-10' });
  assert.deepEqual(f.consumer.selectedMemberProjection(selected).followedPlan, { status: 'unavailable', value: null });
  assert.equal(f.consumer.selectedMemberProjection({ ...selected, localDate: '2026-10-11' }).followedPlan.status, 'not_loaded');
  f.consumer.invalidateGroup(G);
  assert.equal(f.consumer.selectedMemberProjection(selected).summaryReadStatus, 'stale');
  assert.deepEqual(f.consumer.selectedMemberProjection(selected).activity, {});
  f.state.handler = () => json({ code: 'unavailable', message: 'Unavailable' }, 503);
  await assert.rejects(f.consumer.loadSummary(G, { from: '2026-10-10', to: '2026-10-10' }));
  assert.equal(f.consumer.selectedMemberProjection(selected).summaryReadStatus, 'error');
  assert.equal(f.consumer.selectedMemberProjection(selected).followedPlan.status, 'not_loaded');
  for (const localDate of ['2026-02-30', '', '2026-10-10T00:00:00Z', '2026-1-1'])
    assert.throws(() => f.consumer.selectedMemberProjection({ ...selected, localDate }), error => error.status === 422);
  assert.throws(() => f.consumer.selectedMemberProjection(selected, ['health']), error => error.status === 422);
  f.consumer.dispose();
});

test('group-wide composition preview keeps subject activity and profile opt-ins separate', async () => {
  const f = await fixture(call => call.path.endsWith('/profile-sharing') ? profile() : sharing(minimalSharingFlags()));
  const proposedProfile = { ...profile().flags, avatar: true, adherence: false };
  assert.equal(f.consumer.sharingAudiencePreview(G, minimalSharingFlags(), proposedProfile), null);
  await f.consumer.refreshMembership(G);
  const proposed = f.consumer.sharingAudiencePreview(G, minimalSharingFlags(), proposedProfile);
  assert.deepEqual(proposed.fields, ['planAdherence']); assert.deepEqual(proposed.profileFields, ['avatar']);
  assert.equal(proposed.settingsSubject, 'mounted_actor'); assert.equal(proposed.scope, 'entire_group');
  assert.equal(f.calls.length, 1);
  assert.equal(f.consumer.sharingAudiencePreview(G, minimalSharingFlags()), null);
  await f.consumer.loadSharing(G); await f.consumer.loadProfile(G);
  const committed = f.consumer.sharingAudiencePreview(G);
  assert.deepEqual(committed.fields, ['planAdherence']); assert.deepEqual(committed.profileFields, []);
  assert.equal(committed.age, false); assert.equal(committed.rankings, 'unavailable');
  assert.throws(() => f.consumer.sharingAudiencePreview(G, minimalSharingFlags(), { ...proposedProfile, age: true }), error => error.status === 422);
  f.consumer.invalidateGroup(G); assert.equal(f.consumer.sharingAudiencePreview(G), null);
  f.consumer.dispose();
});

test('selected composition remains empty after group invalidation and late summary completion', async () => {
  const gate = deferred(); const f = await fixture(call => call.path.endsWith('/profiles')
    ? [{ memberId: M, alias: 'Leaf', profile: { region: 'EU' } }] : gate.promise);
  await f.consumer.refreshMembership(G); await f.consumer.loadRoster(G);
  const read = f.consumer.loadSummary(G, { from: '2026-10-10', to: '2026-10-10' });
  f.consumer.invalidateGroup(G);
  gate.resolve({ summaryStatus: 'available', members: [{ memberId: M, alias: 'Leaf', days: [{ localDate: '2026-10-10', planAdherence: 'met' }] }] });
  await read;
  const result = f.consumer.selectedMemberProjection({ groupId: G, memberId: M, localDate: '2026-10-10' });
  assert.deepEqual(result.activity, {}); assert.equal(result.profile, null); assert.equal(result.alias, null);
  assert.equal(result.summaryReadStatus, 'stale');
  f.consumer.dispose();
});

test('actual refreshed role and own member revision invalidate cached group projections and fence late reads', async () => {
  const gate = deferred(); const f = await fixture(call => call.path.endsWith('/profiles')
    ? [{ memberId: M, alias: 'Leaf', profile: {} }] : { summaryStatus: 'available', members: [] });
  await f.consumer.refreshMembership(G); await f.consumer.refreshMembership(H);
  await f.consumer.loadRoster(G); await f.consumer.loadRoster(H);
  await f.consumer.refreshMembership(G);
  assert.equal(f.consumer.getSnapshot().groups[G].roster.status, 'ready');
  f.state.handler = () => gate.promise;
  const late = f.consumer.loadSummary(G, { from: '2026-10-10', to: '2026-10-10' });
  f.state.membership = () => membership(G, 'admin', 2);
  await f.consumer.refreshMembership(G);
  assert.deepEqual(f.consumer.getSnapshot().groups[G].membership.data,
    { groupId: G, memberId: M, role: 'admin', memberRevision: 2 });
  assert.equal(f.consumer.getSnapshot().groups[G].roster.status, 'stale');
  assert.equal(f.consumer.getSnapshot().groups[H].roster.status, 'ready');
  gate.resolve({ summaryStatus: 'available', members: [{ memberId: M, alias: 'Leaf', days: [{ localDate: '2026-10-10', planAdherence: 'met' }] }] });
  await late; assert.equal(f.consumer.getSnapshot().groups[G].summary.status, 'stale');
  f.state.handler = () => [{ memberId: M, alias: 'Leaf', profile: {} }]; await f.consumer.loadRoster(G);
  f.state.membership = () => membership(G, 'admin', 3); await f.consumer.refreshMembership(G);
  assert.equal(f.consumer.getSnapshot().groups[G].roster.status, 'stale');
  assert.equal(f.consumer.getSnapshot().groups[G].membership.data.memberRevision, 3);
  f.consumer.dispose();
});

test('missing own membership and fresh authorization failure fail closed without old member projections', async () => {
  const f = await fixture(() => [{ memberId: M, alias: 'Leaf', profile: { region: 'EU' } }]);
  await f.consumer.refreshMembership(G); await f.consumer.loadRoster(G);
  f.state.membership = () => ({ ...membership(), members: [] });
  await assert.rejects(f.consumer.refreshMembership(G), error => error.status === 403);
  assert.equal(f.consumer.getSnapshot().groups[G].membership.status, 'error');
  assert.equal(f.consumer.selectedMemberProjection({ groupId: G, memberId: M, localDate: '2026-10-10' }).profile, null);
  f.state.membership = () => json({ code: 'removed', message: 'Unavailable' }, 403);
  await assert.rejects(f.consumer.refreshMembership(G), error => error.status === 403);
  assert.equal(f.consumer.getSnapshot().groups[G].membership.data, null);
  f.consumer.dispose();
});
