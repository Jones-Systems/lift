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
const { CommunityResources, COMMUNITY_POST_TEXT_REJECTED_MESSAGE, communityRemovedMembershipMessage } = load('api/community.ts');
const { FormTransport, ApiError } = load('api/transport.ts');
const G = '11111111-1111-4111-8111-111111111111', M = '22222222-2222-4222-8222-222222222222';
const I = '33333333-3333-4333-8333-333333333333', P = '44444444-4444-4444-8444-444444444444';
const at = '2026-10-09T12:00:00.000Z', secret = 'A'.repeat(43);
const group = () => ({ id: G, memberId: M, name: 'Family', role: 'owner', revision: 1 });
const member = () => ({ memberId: M, alias: 'Leaf', role: 'member', revision: 1 });
const flags = () => ({ participation: false, workout: false, exerciseSnack: false, planAdherence: false, workoutMinutes: false, exerciseCount: false, streakDays: false });
const sharing = () => ({ revision: 1, flags: flags(), enabledAt: {} });
const invite = () => ({ id: I, groupId: G, revision: 1, state: 'pending', createdAt: at, expiresAt: at, tokenAvailable: false });
const prefs = () => ({ alias: 'Leaf', intent: 'supportive_community', language: 'en', goals: ['mobility'], region: null,
  location: 'anywhere', priorities: ['location', 'goals'], relax: { broaderRegion: false, mixedGoals: false },
  willingHost: false, fillExistingGroups: false, membershipDisclosureAccepted: true, policyVersion: 'community-v1' });
const matching = () => ({ revision: 0, generation: 0, state: 'cancelled', assignedGroupId: null, preferences: null, queuedAt: null, cooldownUntil: null, missedBatches: 0, relaxation: [] });
const profile = () => ({ revision: 0, flags: { age: false, sex: false, region: false, avatar: false, adherence: false, ranking: false }, sexDescription: null, region: null, avatar: null });
const motion = () => ({ id: P, kind: 'friend', places: null, subjectMemberId: null, revision: 1, state: 'open', expiresAt: at, electorateSize: 4, requiredYes: 3, ownBallot: null, ballotRevision: 0 });
const reservation = () => ({ id: I, motionId: P, state: 'available', expiresAt: at, invitationId: null });
const block = () => ({ id: I, revision: 1, active: true });
const safety = () => ({ id: I, revision: 1, state: 'pending', createdAt: at, expiresAt: at, support: 'unavailable' });
const post = () => ({ id: P, revision: 1, kind: 'check_in', state: 'pending', createdAt: at, expiresAt: at, template: 'at_my_pace', memberId: M, alias: 'Leaf' });
const create = () => ({ name: 'Family', alias: 'Leaf', membershipDisclosureAccepted: true });
const joining = () => ({ token: secret, alias: 'Leaf', membershipDisclosureAccepted: true });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function responseFor(call) {
  const p = call.path, method = call.method;
  if (p === '/me/removed-memberships') return [];
  if (p === '/groups') return method === 'GET' ? [group()] : group();
  if (p === `/groups/${G}`) return method === 'GET' ? { ...group(), members: [member()] } : group();
  if (p.endsWith('/invitations')) return method === 'GET' ? [invite()] : { ...invite(), tokenAvailable: true, token: secret };
  if (p.endsWith('/revoke')) return invite();
  if (p.endsWith('/replace')) return { ...invite(), tokenAvailable: true, token: secret };
  if (p === '/invitations/preview') return { name: 'Family', expiresAt: at, membershipDisclosure: 'Membership is visible.' };
  if (p === '/invitations/join') return { groupId: G, memberId: M };
  if (p.endsWith('/me/sharing')) return sharing();
  if (p.endsWith('/me') || p.endsWith('/role')) return member();
  if (p.endsWith('/remove')) return { removed: true };
  if (p.endsWith('/allow-reinvite')) return { allowed: true };
  if (p.endsWith('/leave')) return { left: true };
  if (p.endsWith('/withdraw')) return { withdrawn: true };
  if (p.endsWith('/close')) return { closed: true };
  if (p.includes('/summary?')) return { summaryStatus: 'available', members: [] };
  if (p.startsWith('/me/matching')) return matching();
  if (p.endsWith('/policy')) return { kind: 'matched', intent: 'supportive_community', capacity: 12, revision: 1 };
  if (p.endsWith('/profile-sharing')) return profile();
  if (p.endsWith('/profiles')) return [{ memberId: M, alias: 'Leaf', profile: {} }];
  if (p.endsWith('/motions')) return method === 'GET' ? [motion()] : motion();
  if (p.endsWith('/ballot')) return motion();
  if (p.endsWith('/finalize')) return { ...motion(), state: 'passed' };
  if (p.endsWith('/me/friend-reservations')) return [reservation()];
  if (p === '/me/blocks') return [block()];
  if (p.endsWith('/block') || p.endsWith('/unblock')) return block();
  if (p.endsWith('/safety-references')) return { id: I, expiresAt: at };
  if (p === '/reports' || p.endsWith('/appeal')) return safety();
  if (p === '/me/reports' || p === '/me/appeals') return [safety()];
  if (p === '/me/safety-notices') return [{ ...safety(), reason: 'Review requested', rule: 'community-v1', appealUntil: at }];
  if (p.includes('/rankings?')) return { status: 'unavailable' };
  if (p.endsWith('/hide')) return { id: P, revision: 2, state: 'hidden' };
  if (p.endsWith('/react')) return { active: false, revision: 0 };
  if (p.includes('/posts')) return method === 'GET' ? { posts: [post()], nextCursor: null } : post();
  throw new Error(`Unmapped fixture ${method} ${p}`);
}
async function fixture(handler, mounted = () => true) {
  const calls = [], storageCalls = [], state = { response: handler, auth: 0 };
  const storage = { load: async () => null, save: async value => storageCalls.push(['save', value]), clear: async () => storageCalls.push(['clear']) };
  const transport = new FormTransport('https://synthetic.invalid', storage, async (url, options) => {
    if (url.includes('/api/auth/sign-in')) { state.auth++; return new Response('{}', { headers: { 'set-auth-token': `synthetic-session-${state.auth}` } }); }
    const call = { path: new URL(url).pathname.replace('/v1/community', '') + new URL(url).search, method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body), raw: options.body, key: options.headers['Idempotency-Key'], auth: options.headers.Authorization };
    calls.push(call); const result = state.response ? await state.response(call) : responseFor(call);
    return result instanceof Response ? result : json(result);
  });
  await transport.signIn('synthetic@example.invalid', 'synthetic-password');
  return { bridge: new CommunityResources(transport, mounted), transport, calls, storageCalls, state };
}
const unknown = error => error instanceof ApiError && error.originalEffectUnknown;
const invalidInput = { code: 'community_invalid_input' };

test('strict input rejects invalid JSON, arrays, unknown authority and missing consent before transport', async () => {
  const f = await fixture();
  for (const value of ['{', '[]', 'null', { ...create(), accountId: G }, { ...create(), role: 'owner' }, { ...create(), membershipDisclosureAccepted: false }])
    assert.throws(() => f.bridge.createGroup(value, 'key'), invalidInput);
  assert.equal(f.calls.length, 0);
});
test('UUIDs, base revisions, keys, text and raw 8KiB overflow fail before dispatch', async () => {
  const f = await fixture();
  for (const bad of ['../group', 'group', G + '?account=other']) assert.throws(() => f.bridge.readGroup(bad), invalidInput);
  for (const rev of [0, -1, NaN, 1.1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.bridge.closeGroup(G, rev, 'key'), invalidInput);
  for (const key of ['', 'a'.repeat(129), 'bad/key']) assert.throws(() => f.bridge.createGroup(create(), key), invalidInput);
  for (const name of ['<private>', 'a\nname', 'a'.repeat(81)]) assert.throws(() => f.bridge.createGroup({ ...create(), name }, 'key'), invalidInput);
  assert.throws(() => f.bridge.createGroup(' '.repeat(8193), 'key'), invalidInput); assert.equal(f.calls.length, 0);
});
test('canonical payload is trimmed once and frozen with exact caller-owned key, revision and real auth', async () => {
  const f = await fixture(() => { throw new Error('lost'); });
  const input = { name: ' Family ', expectedRevision: 7 };
  await assert.rejects(f.bridge.renameGroup(G, input, 'same-key'), unknown);
  input.name = 'Different'; input.expectedRevision = 8;
  await assert.rejects(f.bridge.retry('same-key'), unknown);
  assert.equal(f.calls[0].raw, f.calls[1].raw); assert.deepEqual(f.calls[0].body, { expectedRevision: 7, name: 'Family' });
  assert.equal(f.calls[1].key, 'same-key'); assert.equal(f.calls[1].auth, 'Bearer synthetic-session-1');
  assert.equal(f.calls.length, 2);
});
test('a changed payload, revision or route cannot replace a retained unknown intent', async () => {
  const f = await fixture(() => { throw new Error('lost'); });
  await assert.rejects(f.bridge.renameGroup(G, { name: 'Family', expectedRevision: 1 }, 'key'), unknown);
  for (const input of [{ name: 'Other', expectedRevision: 1 }, { name: 'Family', expectedRevision: 2 }])
    assert.throws(() => f.bridge.renameGroup(G, input, 'key'), error => error.code === 'idempotency_conflict' && error.originalEffectUnknown);
  assert.throws(() => f.bridge.closeGroup(G, 1, 'key'), { code: 'idempotency_conflict' }); assert.equal(f.calls.length, 1);
});
test('known rejection after unknown retains original-effect truth and exact retry intent', async () => {
  const f = await fixture(() => { throw new Error('lost'); });
  await assert.rejects(f.bridge.closeGroup(G, 4, 'key'), unknown);
  f.state.response = () => json({ error: { code: 'stale_revision' } }, 409);
  await assert.rejects(f.bridge.retry('key'), error => error.code === 'stale_revision' && !error.effectUnknown && error.originalEffectUnknown);
  assert.equal(f.bridge.inspectIntent('key').expectedRevision, 4); assert.equal(f.bridge.inspectIntent('key').state, 'unknown');
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
});
test('stale conflict remains inspectable and current read reload does not replay it', async () => {
  const f = await fixture(() => json({ error: { code: 'stale_revision' } }, 409));
  await assert.rejects(f.bridge.closeGroup(G, 2, 'conflict'), error => error.code === 'stale_revision' && !error.originalEffectUnknown);
  assert.equal(f.bridge.inspectIntent('conflict').disposition, 'reload_before_new_intent');
  f.state.response = null; await f.bridge.readGroup(G); assert.equal(f.calls.length, 2);
});
test('account auth intent invalidates old mounted reads and retries without borrowing the new session', async () => {
  const f = await fixture(); await f.transport.signIn('other@example.invalid', 'synthetic-password');
  assert.throws(() => f.bridge.retry('old-key'), { code: 'session_changed' });
  await assert.rejects(f.bridge.listGroups(), { code: 'session_changed' }); assert.equal(f.calls.length, 0);
});
test('late old-account read is discarded with no mutation uncertainty', async () => {
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.bridge.listGroups(); await f.transport.signIn('other@example.invalid', 'synthetic-password'); resolve([group()]);
  await assert.rejects(pending, error => error.code === 'session_changed' && !error.effectUnknown && !error.originalEffectUnknown);
});
test('late old-account mutation preserves both transport effect flags and cannot retry', async () => {
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.bridge.closeGroup(G, 1, 'old-key'); await f.transport.signIn('other@example.invalid', 'synthetic-password'); resolve({ closed: true });
  await assert.rejects(pending, unknown); assert.throws(() => f.bridge.retry('old-key'), { code: 'session_changed' });
  assert.equal(f.calls.length, 1);
});
test('dispose clears intents and rejects late results and retained callbacks', async () => {
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.bridge.joinInvitation(joining(), 'secret-key'); f.bridge.dispose(); resolve({ groupId: G, memberId: M });
  await assert.rejects(pending, unknown); assert.throws(() => f.bridge.inspectIntent('secret-key'), { code: 'session_changed' });
  await assert.rejects(f.bridge.listGroups(), { code: 'session_changed' }); assert.equal(f.calls.length, 1);
});
test('optional mounted generation guard clears and denies same-session late mutation', async () => {
  let current = true, resolve; const f = await fixture(() => new Promise(done => { resolve = done; }), () => current);
  const pending = f.bridge.withdraw(G, 'key'); current = false; resolve({ withdrawn: true });
  await assert.rejects(pending, unknown); assert.throws(() => f.bridge.retry('key'), { code: 'session_changed' });
});
test('401 clears mounted private intents while preserving an earlier unknown result', async () => {
  const f = await fixture(() => { throw new Error('lost'); });
  await assert.rejects(f.bridge.joinInvitation(joining(), 'join'), unknown);
  f.state.response = () => json({ error: { code: 'unauthenticated' } }, 401);
  await assert.rejects(f.bridge.retry('join'), unknown);
  assert.throws(() => f.bridge.retry('join'), { code: 'session_changed' });
  assert.ok(f.storageCalls.some(c => c[0] === 'clear')); assert.equal(f.calls.length, 2);
});
test('fresh known 401 does not invent original mutation uncertainty', async () => {
  const f = await fixture(() => json({ error: { code: 'unauthenticated' } }, 401));
  await assert.rejects(f.bridge.closeGroup(G, 1, 'key'), error => error.code === 'session_changed' && !error.originalEffectUnknown);
  assert.throws(() => f.bridge.inspectIntent('key'), { code: 'session_changed' });
});
test('preview is read-only POST with strict token, no key and no unknown mutation labeling', async () => {
  const f = await fixture(() => { throw new Error('lost'); });
  await assert.rejects(f.bridge.previewInvitation({ token: secret }), error => !error.effectUnknown && !error.originalEffectUnknown);
  assert.equal(f.calls[0].method, 'POST'); assert.equal(f.calls[0].key, undefined);
  assert.throws(() => f.bridge.previewInvitation({ token: secret, accountId: G }), invalidInput);
  assert.throws(() => f.bridge.previewInvitation({ token: 'B'.repeat(43) }), invalidInput);
});
test('preview invalid JSON, 503 and late session outcomes remain read uncertainty only', async () => {
  for (const result of [new Response('{'), json({ error: { code: 'community_limiter_unavailable' } }, 503)]) {
    const f = await fixture(() => result);
    await assert.rejects(f.bridge.previewInvitation({ token: secret }), error => !error.effectUnknown && !error.originalEffectUnknown);
  }
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.bridge.previewInvitation({ token: secret }); f.bridge.dispose(); resolve(responseFor({ path: '/invitations/preview' }));
  await assert.rejects(pending, error => error.code === 'session_changed' && !error.originalEffectUnknown);
});
test('invitation first response secret is returned once and metadata replay never stores a token', async () => {
  const f = await fixture(); const first = await f.bridge.issueInvitation(G, 'issue'); assert.equal(first.token, secret);
  const replay = await f.bridge.retry('issue'); assert.equal(replay.tokenAvailable, false); assert.equal('token' in replay, false);
  assert.equal(JSON.stringify(f.bridge.inspectIntent('issue')).includes(secret), false); assert.deepEqual(f.calls[0].body, {});
});
test('lost invitation response retains revoke-or-replace disposition and rejects replayed secret', async () => {
  const f = await fixture(() => { throw new Error('lost'); }); await assert.rejects(f.bridge.issueInvitation(G, 'issue'), unknown);
  assert.equal(f.bridge.inspectIntent('issue').disposition, 'revoke_or_replace'); f.state.response = () => invite();
  const metadata = await f.bridge.retry('issue'); assert.equal(metadata.tokenAvailable, false);
  assert.equal(f.bridge.inspectIntent('issue').disposition, 'revoke_or_replace');
  f.state.response = () => ({ ...invite(), tokenAvailable: true, token: secret });
  await assert.rejects(f.bridge.retry('issue'), error => error.code === 'community_invitation_replay_invalid' && error.originalEffectUnknown);
});
test('join retains exact secret only for unresolved retry and clears it on confirmation', async () => {
  const f = await fixture(() => { throw new Error('lost'); }); await assert.rejects(f.bridge.joinInvitation(joining(), 'join'), unknown);
  assert.equal(JSON.stringify(f.bridge.inspectIntent('join')).includes(secret), false);
  f.state.response = null; await f.bridge.retry('join'); assert.equal(f.bridge.inspectIntent('join'), null);
  assert.throws(() => f.bridge.joinInvitation(joining(), 'join'), { code: 'community_secret_consumed' });
  assert.equal(f.calls[0].raw, f.calls[1].raw);
});
test('unknown response JSON and private or extra response fields fail closed with correct effect truth', async () => {
  const f = await fixture(() => new Response('{'));
  await assert.rejects(f.bridge.createGroup(create(), 'key'), unknown);
  for (const result of [{ ...group(), accountId: G }, { ...group(), health: {} }, { ...group(), revision: 0 }, { ...group(), id: 'invalid' }, { ...group(), role: 'moderator' }]) {
    f.state.response = () => [result]; await assert.rejects(f.bridge.listGroups(), { code: 'community_invalid_response' });
  }
});
test('response list caps and malformed envelope types are rejected rather than truncated', async () => {
  const f = await fixture(() => Array.from({ length: 21 }, group)); await assert.rejects(f.bridge.listGroups(), { code: 'community_invalid_response' });
  for (const result of [null, 'groups', { items: [group()] }]) { f.state.response = () => result; await assert.rejects(f.bridge.listGroups()); }
  f.state.response = () => ({ ...group(), members: Array.from({ length: 51 }, member) });
  await assert.rejects(f.bridge.readGroup(G), { code: 'community_invalid_response' });
});
test('summary consumes only six server Activity fields plus participation and preserves unknown/rest/grace semantics', async () => {
  const day = { localDate: '2026-10-09', participation: 'unknown', workout: 'unknown', exerciseSnack: 'not_recorded', planAdherence: 'pending', workoutMinutes: 0, exerciseCount: 0, streakDays: 5 };
  const f = await fixture(() => ({ summaryStatus: 'available', members: [{ memberId: M, alias: 'Leaf', days: [day] }] }));
  assert.deepEqual((await f.bridge.readSummary(G, { from: '2026-10-09', to: '2026-10-09' })).members[0].days[0], day);
  day.planAdherence = 'not_applicable'; await f.bridge.readSummary(G, { from: '2026-10-09', to: '2026-10-09' });
  day.health = 'private'; await assert.rejects(f.bridge.readSummary(G, { from: '2026-10-09', to: '2026-10-09' }), { code: 'community_invalid_response' });
});
test('summary rejects invalid ranges, repeated/out-of-range days and unavailable partial projections', async () => {
  const f = await fixture();
  for (const input of [{ from: '2026-02-30', to: '2026-03-01' }, { from: '2026-10-09', to: '2026-10-08' }, { from: '2026-01-01', to: '2026-02-01' }, { from: '2026-10-09', to: '2026-10-09', health: true }])
    assert.throws(() => f.bridge.readSummary(G, input), invalidInput);
  for (const result of [{ summaryStatus: 'unavailable', members: [{ memberId: M, alias: 'Leaf', days: [] }] },
    { summaryStatus: 'available', members: [{ memberId: M, alias: 'Leaf', days: [{ localDate: '2026-10-08' }] }] },
    { summaryStatus: 'available', members: [{ memberId: M, alias: 'Leaf', days: [{ localDate: '2026-10-09' }, { localDate: '2026-10-09' }] }] }]) {
    f.state.response = () => result; await assert.rejects(f.bridge.readSummary(G, { from: '2026-10-09', to: '2026-10-09' }), { code: 'community_invalid_response' });
  }
});
test('sharing preserves separate group flags and does not upload body, health or contacts', async () => {
  const f = await fixture(); await f.bridge.updateSharing(G, { expectedRevision: 1, flags: flags() }, 'share');
  assert.deepEqual(f.calls[0].body.flags, flags());
  for (const field of ['body', 'photo', 'health', 'contacts', 'accountId'])
    assert.throws(() => f.bridge.updateSharing(G, { expectedRevision: 1, flags: { ...flags(), [field]: true } }, 'bad'), invalidInput);
});
test('matching preferences keep support distinct, use extension zero revision and reject unsupported age/contact input', async () => {
  const f = await fixture(); await f.bridge.enroll({ expectedRevision: 0, preferences: prefs() }, 'enroll');
  assert.equal(f.calls[0].body.preferences.intent, 'supportive_community');
  for (const extra of [{ age: 65 }, { contacts: [] }, { birthDate: '1961-01-01' }, { accountId: G }])
    assert.throws(() => f.bridge.updateMatching({ expectedRevision: 0, preferences: { ...prefs(), ...extra } }, 'bad'), invalidInput);
  assert.throws(() => f.bridge.enroll({ expectedRevision: 0, preferences: { ...prefs(), priorities: ['goals', 'goals'] } }, 'bad'), invalidInput);
  assert.throws(() => f.bridge.enroll({ expectedRevision: 0, preferences: { ...prefs(), goals: ['strength', 'strength'] } }, 'bad'), invalidInput);
});
test('profile flags are explicit and age/media guarantees cannot be enabled', async () => {
  const f = await fixture(); const { revision, ...input } = profile();
  await f.bridge.updateProfile(G, { ...input, expectedRevision: revision, audiencePreviewAccepted: true }, 'profile');
  for (const change of [{ flags: { ...input.flags, age: true } }, { avatar: 'https://private.invalid/photo' }, { contacts: [] }, { audiencePreviewAccepted: false }])
    assert.throws(() => f.bridge.updateProfile(G, { ...input, expectedRevision: 0, audiencePreviewAccepted: true, ...change }, 'bad'), invalidInput);
});
test('capabilities have no invented route, privileged operations have no method and rankings stay unavailable', async () => {
  const f = await fixture(); await assert.rejects(f.bridge.capabilities(), { code: 'community_capabilities_unavailable' }); assert.equal(f.calls.length, 0);
  for (const method of ['applyBatch', 'freezeBatch', 'reviewPost', 'reviewRemoval', 'safetyReference', 'mergeFeatures']) assert.equal(f.bridge[method], undefined);
  assert.deepEqual(await f.bridge.rankings(G, 'current_streak'), { status: 'unavailable' });
  f.state.response = () => ({ status: 'available', scores: [] }); await assert.rejects(f.bridge.rankings(G, 'month_adherence'), { code: 'community_invalid_response' });
});
test('denied server capabilities preserve unavailable errors and never activate or replay', async () => {
  const f = await fixture(() => json({ error: { code: 'community_posting_unavailable' } }, 503));
  await assert.rejects(f.bridge.createPost(G, { kind: 'check_in', template: 'at_my_pace', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'post'), error => error.code === 'community_posting_unavailable');
  assert.equal(f.calls.length, 1);
});
test('B4 safety and UGC input guards exclude unaccepted fields, media, links and excessive text', async () => {
  const f = await fixture();
  for (const input of [{ category: 'privacy', text: 'x'.repeat(1001) }, { category: 'privacy', text: 'https://private.invalid' }, { category: 'privacy', text: 'Review please', accountId: G }])
    assert.throws(() => f.bridge.report(input, 'report'), invalidInput);
  assert.throws(() => f.bridge.createPost(G, { kind: 'win', text: 'x'.repeat(501), policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'post'), invalidInput);
  assert.throws(() => f.bridge.readPosts(G, { limit: 51 }), invalidInput);
  assert.throws(() => f.bridge.createMotion(G, { kind: 'growth', places: 5, expectedRevision: 1 }, 'motion'), invalidInput);
  assert.throws(() => f.bridge.setBallot(G, P, { choice: 'yes', expectedRevision: 0, accountId: G }, 'vote'), invalidInput);
  assert.equal(f.calls.length, 0);
});
test('in-flight same-key dispatch is blocked without duplicate effect or automatic replay', async () => {
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.bridge.closeGroup(G, 1, 'key'); await assert.rejects(f.bridge.retry('key'), { code: 'community_intent_in_flight' });
  assert.equal(f.calls.length, 1); resolve({ closed: true }); await pending;
});
test('bounded memory refuses new intents at capacity and disposal prevents their reuse', async () => {
  const f = await fixture(); for (let n = 0; n < 64; n++) await f.bridge.withdraw(G, `key-${n}`);
  assert.throws(() => f.bridge.withdraw(G, 'overflow'), { code: 'community_intent_capacity' });
  f.bridge.dispose(); assert.throws(() => f.bridge.retry('key-0'), { code: 'session_changed' }); assert.equal(f.calls.length, 64);
});
test('all B2 and accepted B4 HTTP methods and paths map to actual service projection shapes', async () => {
  const f = await fixture(); let n = 0;
  const key = () => `mapping-${n++}`, profileValue = profile(); const { revision, ...pf } = profileValue;
  const inventory = [
    ['GET', '/groups', () => f.bridge.listGroups()],
    ['GET', `/groups/${G}`, () => f.bridge.readGroup(G)],
    ['POST', '/groups', () => f.bridge.createGroup(create(), key())],
    ['PATCH', `/groups/${G}`, () => f.bridge.renameGroup(G, { name: 'Family', expectedRevision: 1 }, key())],
    ['PATCH', `/groups/${G}/me`, () => f.bridge.updateAlias(G, { alias: 'Leaf', expectedRevision: 1 }, key())],
    ['GET', `/groups/${G}/me/sharing`, () => f.bridge.readSharing(G)],
    ['PATCH', `/groups/${G}/me/sharing`, () => f.bridge.updateSharing(G, { flags: flags(), expectedRevision: 1 }, key())],
    ['GET', `/groups/${G}/invitations`, () => f.bridge.listInvitations(G)],
    ['POST', `/groups/${G}/invitations`, () => f.bridge.issueInvitation(G, key())],
    ['POST', `/groups/${G}/reservations/${I}/invitations`, () => f.bridge.issueFriendInvitation(G, I, key())],
    ['POST', '/invitations/preview', () => f.bridge.previewInvitation({ token: secret })],
    ['POST', '/invitations/join', () => f.bridge.joinInvitation(joining(), key())],
    ['POST', `/groups/${G}/invitations/${I}/revoke`, () => f.bridge.revokeInvitation(G, I, 1, key())],
    ['POST', `/groups/${G}/invitations/${I}/replace`, () => f.bridge.replaceInvitation(G, I, 1, key())],
    ['PATCH', `/groups/${G}/members/${M}/role`, () => f.bridge.updateRole(G, M, { role: 'admin', expectedRevision: 1 }, key())],
    ['POST', `/groups/${G}/members/${M}/remove`, () => f.bridge.removeMember(G, M, 1, key())],
    ['POST', `/groups/${G}/members/${M}/allow-reinvite`, () => f.bridge.allowReinvite(G, M, 1, key())],
    ['POST', `/groups/${G}/leave`, () => f.bridge.leave(G, key())],
    ['POST', `/groups/${G}/me/withdraw`, () => f.bridge.withdraw(G, key())],
    ['POST', `/groups/${G}/close`, () => f.bridge.closeGroup(G, 1, key())],
    ['GET', `/groups/${G}/summary?from=2026-10-09&to=2026-10-09`, () => f.bridge.readSummary(G, { from: '2026-10-09', to: '2026-10-09' })],
    ['GET', '/me/matching', () => f.bridge.readMatching()],
    ['POST', '/me/matching/enroll', () => f.bridge.enroll({ expectedRevision: 0, preferences: prefs() }, key())],
    ['PATCH', '/me/matching', () => f.bridge.updateMatching({ expectedRevision: 0, preferences: prefs() }, key())],
    ['POST', '/me/matching/cancel', () => f.bridge.cancelEnrollment(0, key())],
    ['GET', `/groups/${G}/policy`, () => f.bridge.readPolicy(G)],
    ['GET', `/groups/${G}/me/profile-sharing`, () => f.bridge.readProfile(G)],
    ['PATCH', `/groups/${G}/me/profile-sharing`, () => f.bridge.updateProfile(G, { ...pf, expectedRevision: revision, audiencePreviewAccepted: true }, key())],
    ['GET', `/groups/${G}/profiles`, () => f.bridge.rosterProfiles(G)],
    ['GET', `/groups/${G}/motions`, () => f.bridge.listMotions(G)],
    ['GET', `/groups/${G}/me/friend-reservations`, () => f.bridge.listFriendReservations(G)],
    ['POST', `/groups/${G}/motions`, () => f.bridge.createMotion(G, { kind: 'friend', expectedRevision: 1 }, key())],
    ['POST', `/groups/${G}/motions/${P}/finalize`, () => f.bridge.finalizeMotion(G, P, key())],
    ['POST', `/groups/${G}/motions/${P}/ballot`, () => f.bridge.setBallot(G, P, { choice: 'abstain', expectedRevision: 0 }, key())],
    ['POST', `/groups/${G}/members/${M}/block`, () => f.bridge.blockMember(G, M, key())],
    ['GET', '/me/blocks', () => f.bridge.listBlocks()],
    ['POST', `/me/blocks/${I}/unblock`, () => f.bridge.unblock(I, 1, key())],
    ['POST', `/groups/${G}/safety-references`, () => f.bridge.createSafetyReference(G, { kind: 'member', resourceId: M }, key())],
    ['POST', '/reports', () => f.bridge.report({ category: 'privacy', text: 'Please review this privately' }, key())],
    ['GET', '/me/reports', () => f.bridge.listReports()],
    ['GET', '/me/safety-notices', () => f.bridge.listNotices()],
    ['POST', `/me/safety-notices/${I}/appeal`, () => f.bridge.appeal(I, { text: 'Please reconsider', expectedRevision: 1 }, key())],
    ['GET', '/me/appeals', () => f.bridge.listAppeals()],
    ['GET', `/groups/${G}/rankings?metric=longest_streak`, () => f.bridge.rankings(G, 'longest_streak')],
    ['GET', `/groups/${G}/posts?cursor=${I}&limit=20`, () => f.bridge.readPosts(G, { cursor: I, limit: 20 })],
    ['POST', `/groups/${G}/posts`, () => f.bridge.createPost(G, { kind: 'check_in', template: 'at_my_pace', policyVersion: 'community-v1', audiencePreviewAccepted: true }, key())],
    ['POST', `/groups/${G}/posts/${P}/hide`, () => f.bridge.hidePost(G, P, 1, key())],
    ['POST', `/groups/${G}/posts/${P}/react`, () => f.bridge.setReaction(G, P, { active: false, reaction: 'with_you', expectedRevision: 0 }, key())],
  ];
  for (const [method, endpoint, invoke] of inventory) {
    const start = f.calls.length; await invoke(); assert.equal(f.calls.length, start + 1);
    const call = f.calls[start]; assert.equal(call.method, method); assert.equal(call.path, endpoint);
    assert.equal(call.auth, 'Bearer synthetic-session-1');
    if (method !== 'GET' && endpoint !== '/invitations/preview') assert.ok(call.key);
    else assert.equal(call.key, undefined);
  }
});

test('response guards reject wrong resource IDs, duplicate members and inconsistent consent metadata', async () => {
  const f = await fixture(() => ({ ...group(), id: I, members: [member()] }));
  await assert.rejects(f.bridge.readGroup(G), { code: 'community_invalid_response' });
  f.state.response = () => ({ ...group(), members: [member(), member()] });
  await assert.rejects(f.bridge.readGroup(G), { code: 'community_invalid_response' });
  f.state.response = () => ({ ...invite(), groupId: M });
  await assert.rejects(f.bridge.revokeInvitation(G, I, 1, 'revoke'), unknown);
  f.state.response = () => ({ ...sharing(), flags: { ...flags(), workout: true } });
  await assert.rejects(f.bridge.readSharing(G), { code: 'community_invalid_response' });
  f.state.response = () => ({ ...profile(), avatar: 'sun' });
  await assert.rejects(f.bridge.readProfile(G), { code: 'community_invalid_response' });
});
test('server metadata is authoritative and never reconstructed from submitted enrollment or disclosure flags', async () => {
  const f = await fixture(() => ({ ...matching(), revision: 4, generation: 2, state: 'queued', queuedAt: at, preferences: prefs() }));
  const result = await f.bridge.enroll({ expectedRevision: 0, preferences: prefs() }, 'key');
  assert.equal(result.revision, 4); assert.equal(result.generation, 2); assert.equal(result.queuedAt, at);
  f.state.response = () => ({ ...sharing(), revision: 9 });
  const share = await f.bridge.updateSharing(G, { expectedRevision: 1, flags: { ...flags(), workout: true } }, 'share');
  assert.equal(share.revision, 9); assert.equal(share.flags.workout, false);
});
test('an original unknown remains recorded after successful reconciliation and later known rejection', async () => {
  const f = await fixture(() => { throw new Error('lost'); });
  await assert.rejects(f.bridge.closeGroup(G, 1, 'key'), unknown);
  f.state.response = null; assert.deepEqual(await f.bridge.retry('key'), { closed: true });
  assert.equal(f.bridge.inspectIntent('key').originalEffectUnknown, true);
  f.state.response = () => json({ error: { code: 'community_not_found' } }, 404);
  await assert.rejects(f.bridge.retry('key'), error => error.code === 'community_not_found' && error.originalEffectUnknown);
});
test('response guards reject malformed matching/profile/safety/UGC state and list overcapacity', async () => {
  const f = await fixture();
  const cases = [
    [() => f.bridge.readMatching(), { ...matching(), preferences: { ...prefs(), contacts: [] } }],
    [() => f.bridge.readProfile(G), { ...profile(), flags: { ...profile().flags, age: true } }],
    [() => f.bridge.listReports(), [{ ...safety(), support: 'staffed' }]],
    [() => f.bridge.listNotices(), [{ ...safety(), reason: 'x', rule: 'x', appealUntil: '2026-02-30T12:00:00Z' }]],
    [() => f.bridge.readPosts(G), { posts: [{ ...post(), state: 'approved', health: {} }], nextCursor: null }],
    [() => f.bridge.listBlocks(), Array.from({ length: 501 }, block)],
    [() => f.bridge.listMotions(G), [{ ...motion(), ownBallot: 'forced' }]],
  ];
  for (const [invoke, result] of cases) { f.state.response = () => result; await assert.rejects(invoke(), { code: 'community_invalid_response' }); }
});

test('invalid follow-up input cannot erase a retained original unknown outcome', async () => {
  const f = await fixture(() => { throw new Error('lost'); });
  await assert.rejects(f.bridge.renameGroup(G, { name: 'Family', expectedRevision: 1 }, 'key'), unknown);
  assert.throws(() => f.bridge.renameGroup(G, { name: '<private>', expectedRevision: 1 }, 'key'), error => error.code === 'community_invalid_input' && error.originalEffectUnknown);
  assert.equal(f.bridge.inspectIntent('key').originalEffectUnknown, true); assert.equal(f.calls.length, 1);
});

test('friend methods validate resource IDs before transport and finalization sends only empty intent', async () => {
  const f = await fixture();
  for (const invoke of [() => f.bridge.listFriendReservations('bad'), () => f.bridge.finalizeMotion('bad', P, 'key'),
    () => f.bridge.finalizeMotion(G, 'bad', 'key'), () => f.bridge.issueFriendInvitation('bad', I, 'key'),
    () => f.bridge.issueFriendInvitation(G, 'bad', 'key')]) assert.throws(invoke, invalidInput);
  assert.equal(f.calls.length, 0);
  await f.bridge.finalizeMotion(G, P, 'finalize'); assert.deepEqual(f.calls[0].body, {});
  assert.throws(() => f.bridge.finalizeMotion(G, M, 'finalize'), { code: 'idempotency_conflict' });
  assert.equal(f.calls.length, 1);
});

test('friend reservation responses reject sponsor, group and token disclosures and retain stored expiry and state', async () => {
  const f = await fixture(); assert.deepEqual(await f.bridge.listFriendReservations(G), [reservation()]);
  for (const state of ['available', 'cancelled', 'consumed']) {
    f.state.response = () => [{ ...reservation(), state }];
    assert.deepEqual(await f.bridge.listFriendReservations(G), [{ ...reservation(), state }]);
  }
  for (const extra of [{ sponsorAccountId: M }, { accountId: M }, { groupId: M }, { token: secret }, { invitationId: 'bad' }, { state: 'expired' }]) {
    f.state.response = () => [{ ...reservation(), ...extra }];
    await assert.rejects(f.bridge.listFriendReservations(G), { code: 'community_invalid_response' });
  }
  for (const rows of [[reservation(), reservation()], Array.from({ length: 51 }, reservation)]) {
    f.state.response = () => rows; await assert.rejects(f.bridge.listFriendReservations(G), { code: 'community_invalid_response' });
  }
  f.state.response = () => ({ ...motion(), id: M });
  await assert.rejects(f.bridge.finalizeMotion(G, P, 'wrong-motion'), unknown);
  f.state.response = () => ({ ...invite(), groupId: M, tokenAvailable: true, token: secret });
  await assert.rejects(f.bridge.issueFriendInvitation(G, I, 'wrong-group'), unknown);
});

test('friend issue returns a token once, retains exact intent and never automatically replaces', async () => {
  const f = await fixture();
  assert.equal((await f.bridge.issueFriendInvitation(G, I, 'issue')).token, secret);
  assert.deepEqual(f.calls[0].body, {});
  const replay = await f.bridge.retry('issue'); assert.equal(replay.tokenAvailable, false); assert.equal('token' in replay, false);
  assert.equal(JSON.stringify(f.bridge.inspectIntent('issue')).includes(secret), false);
  assert.throws(() => f.bridge.issueFriendInvitation(G, M, 'issue'), { code: 'idempotency_conflict' });
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.path === `/groups/${G}/reservations/${I}/invitations`));
  assert.equal(f.storageCalls.length, 1);
});

test('unknown friend issue and finalization retry only the retained intent with original uncertainty', async () => {
  for (const command of ['issue', 'finalize']) {
    const f = await fixture(() => { throw new Error('lost'); });
    const invoke = () => command === 'issue' ? f.bridge.issueFriendInvitation(G, I, 'key') : f.bridge.finalizeMotion(G, P, 'key');
    await assert.rejects(invoke(), unknown); assert.equal(f.calls.length, 1);
    f.state.response = () => command === 'issue' ? invite() : { ...motion(), state: 'passed' };
    await f.bridge.retry('key'); assert.equal(f.bridge.inspectIntent('key').originalEffectUnknown, true);
    assert.equal(f.calls[0].raw, f.calls[1].raw); assert.equal(f.calls[0].path, f.calls[1].path); assert.equal(f.calls[0].key, f.calls[1].key);
    if (command === 'issue') {
      f.state.response = () => ({ ...invite(), tokenAvailable: true, token: secret });
      await assert.rejects(f.bridge.retry('key'), error => error.code === 'community_invitation_replay_invalid' && error.originalEffectUnknown);
    }
  }
});

test('late friend tokens and reservation reads are discarded after session change or disposal', async () => {
  for (const end of ['switch', 'dispose']) {
    let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
    const pending = f.bridge.issueFriendInvitation(G, I, 'issue');
    if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else f.bridge.dispose();
    resolve({ ...invite(), tokenAvailable: true, token: secret });
    await assert.rejects(pending, error => error.code === 'session_changed' && error.originalEffectUnknown);
    assert.throws(() => f.bridge.retry('issue'), { code: 'session_changed' });
    assert.throws(() => f.bridge.finalizeMotion(G, P, 'finalize'), { code: 'session_changed' });
    assert.equal(f.calls.length, 1);
  }
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.bridge.listFriendReservations(G); f.bridge.dispose(); resolve([reservation()]);
  await assert.rejects(pending, error => error.code === 'session_changed' && !error.originalEffectUnknown);
});

test('group controller exposes explicit read states, immutable snapshots and removable subscriptions', async () => {
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
  const controller = f.bridge.createGroupController(); let notifications = 0;
  const subscription = controller.subscribe(() => { notifications++; });
  assert.equal(controller.getSnapshot().groups.status, 'idle'); assert.equal(f.calls.length, 0);
  const pending = controller.loadGroups(); assert.equal(controller.getSnapshot().groups.status, 'loading');
  resolve([]); await pending;
  const empty = controller.getSnapshot(); assert.equal(empty.groups.status, 'empty'); assert.deepEqual(empty.groups.data, []);
  assert.ok(Object.isFrozen(empty)); assert.ok(Object.isFrozen(empty.groups.data));
  assert.throws(() => empty.groups.data.push(group()), TypeError);
  assert.equal(notifications, 2); subscription.remove();
  f.state.response = null; await controller.loadGroups(); await controller.loadDetail(G); await controller.loadSharing(G); await controller.loadMotions(G);
  const ready = controller.getSnapshot();
  assert.equal(ready.groups.status, 'ready'); assert.equal(ready.detail.data.id, G);
  assert.equal(ready.sharing.data.revision, 1); assert.equal(ready.motions.data[0].id, P);
  assert.equal(notifications, 2);
});

test('group controller keeps independent detail and sharing when motions are unavailable', async () => {
  const f = await fixture(); const controller = f.bridge.createGroupController();
  await controller.loadDetail(G); await controller.loadSharing(G);
  f.state.response = () => json({ error: { code: 'community_not_found', private: 'not a projection' } }, 404);
  await assert.rejects(controller.loadMotions(G), { code: 'community_not_found' });
  const state = controller.getSnapshot(); assert.equal(state.detail.status, 'ready'); assert.equal(state.sharing.status, 'ready');
  assert.deepEqual(state.motions, { status: 'error', groupId: G, data: null,
    error: { status: 404, code: 'community_not_found', effectUnknown: false, originalEffectUnknown: false } });
  f.state.response = () => []; await controller.loadMotions(G); assert.equal(controller.getSnapshot().motions.status, 'empty');
});

test('group controller discards superseded reads and their late failures', async () => {
  const requests = []; const f = await fixture(() => new Promise(done => { requests.push(done); }));
  const controller = f.bridge.createGroupController();
  const old = controller.loadDetail(G), latest = controller.loadDetail(I);
  requests[1]({ ...group(), id: I, members: [member()] }); await latest;
  requests[0]({ ...group(), members: [member()] }); await old;
  assert.equal(controller.getSnapshot().detail.groupId, I); assert.equal(controller.getSnapshot().detail.data.id, I);
  const failed = controller.loadGroups(), fresh = controller.loadGroups();
  requests[3]([group()]); await fresh;
  requests[2](json({ error: { code: 'community_unavailable' } }, 503)); await failed;
  assert.equal(controller.getSnapshot().groups.status, 'ready');
});

test('group controller stale sharing requires explicit reload and keeps the original revision for retry', async () => {
  const f = await fixture(); const controller = f.bridge.createGroupController(); await controller.loadSharing(G);
  f.state.response = () => json({ error: { code: 'stale_revision' } }, 409);
  await assert.rejects(controller.updateSharing(G, { flags: flags(), expectedRevision: 1 }, 'share'), { code: 'stale_revision' });
  assert.equal(controller.getSnapshot().sharing.status, 'stale'); assert.equal(controller.getSnapshot().sharing.data, null);
  assert.equal(controller.getSnapshot().command.error.code, 'stale_revision');
  assert.equal(controller.inspectIntent('share').disposition, 'reload_before_new_intent'); assert.equal(f.calls.length, 2);
  f.state.response = () => ({ ...sharing(), revision: 9 }); await controller.loadSharing(G);
  assert.equal(controller.getSnapshot().sharing.data.revision, 9); assert.equal(controller.getSnapshot().command.error.code, 'stale_revision');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  const result = await controller.retry('share'); assert.equal(result.revision, 9);
  assert.equal(f.calls[3].key, 'share'); assert.equal(f.calls[3].body.expectedRevision, 1); assert.equal(f.calls[1].raw, f.calls[3].raw);
  assert.equal(controller.getSnapshot().command.status, 'confirmed'); assert.equal(controller.getSnapshot().sharing.status, 'stale');
});

test('group controller preserves unknown ballot intent across reads and explicit retry', async () => {
  const f = await fixture(); const controller = f.bridge.createGroupController(); await controller.loadMotions(G);
  f.state.response = () => { throw new Error('lost'); };
  await assert.rejects(controller.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'vote'), unknown);
  assert.equal(controller.getSnapshot().motions.status, 'stale'); assert.equal(controller.getSnapshot().command.error.originalEffectUnknown, true);
  f.state.response = null; await controller.loadMotions(G);
  assert.equal(controller.inspectIntent('vote').state, 'unknown'); assert.equal(f.calls.length, 3);
  f.state.response = () => ({ ...motion(), ownBallot: 'yes', ballotRevision: 1 });
  const result = await controller.retry('vote'); assert.equal(result.ownBallot, 'yes');
  assert.equal(controller.getSnapshot().command.intent.originalEffectUnknown, true);
  assert.equal(f.calls[1].raw, f.calls[3].raw); assert.equal(f.calls[1].key, f.calls[3].key);
  f.state.response = null; await f.bridge.issueInvitation(G, 'invite'); const before = f.calls.length;
  assert.throws(() => controller.retry('invite'), { code: 'community_controller_intent_unavailable' }); assert.equal(f.calls.length, before);
});

test('group controller invalidates reads racing a mutation and never automatically reloads', async () => {
  let resolve; const f = await fixture(call => call.method === 'GET' ? new Promise(done => { resolve = done; }) : { ...sharing(), revision: 2 });
  const controller = f.bridge.createGroupController(); const read = controller.loadSharing(G);
  await controller.updateSharing(G, { flags: flags(), expectedRevision: 1 }, 'share');
  resolve(sharing()); await read; assert.equal(controller.getSnapshot().sharing.status, 'stale'); assert.equal(f.calls.length, 2);
  f.state.response = () => ({ ...sharing(), revision: 2 }); await controller.loadSharing(G);
  assert.equal(controller.getSnapshot().sharing.data.revision, 2);
});

test('resource auth disposal clears every group controller and fences late reads and readonly snapshots', async () => {
  const f = await fixture(); const first = f.bridge.createGroupController(), second = f.bridge.createGroupController();
  await first.loadGroups(); await second.loadDetail(G);
  let resolve; f.state.response = () => new Promise(done => { resolve = done; });
  const pending = first.loadSharing(G); await f.transport.signIn('other@example.invalid', 'synthetic-password');
  for (const controller of [first, second]) {
    const snapshot = controller.getSnapshot(); assert.equal(snapshot.disposed, true);
    for (const name of ['groups', 'detail', 'sharing', 'motions']) assert.equal(snapshot[name].data, null);
    assert.equal(snapshot.command.key, null);
    assert.throws(() => controller.subscribe(() => {}), { code: 'session_changed' });
  }
  resolve(sharing()); await assert.rejects(pending, { code: 'session_changed' });
  assert.throws(() => f.bridge.createGroupController(), { code: 'session_changed' });
  await assert.rejects(first.loadGroups(), { code: 'session_changed' });
});

test('disposing one controller fences its late command without disposing sibling resources', async () => {
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
  const controller = f.bridge.createGroupController(), sibling = f.bridge.createGroupController();
  const pending = controller.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'vote');
  assert.equal(controller.getSnapshot().command.status, 'pending'); controller.dispose();
  resolve({ ...motion(), ownBallot: 'yes', ballotRevision: 1 }); await assert.rejects(pending, unknown);
  assert.equal(controller.getSnapshot().disposed, true); assert.equal(controller.getSnapshot().command.key, null);
  f.state.response = null; await sibling.loadGroups(); assert.equal(sibling.getSnapshot().groups.status, 'ready');
  assert.throws(() => controller.retry('vote'), { code: 'session_changed' });
});

test('mounted-session snapshot checks clear group state and observer errors cannot alter command outcomes', async () => {
  let mounted = true; const f = await fixture(undefined, () => mounted); const controller = f.bridge.createGroupController();
  controller.subscribe(() => { throw new Error('synthetic observer failure'); });
  await controller.loadGroups(); await controller.updateSharing(G, { flags: flags(), expectedRevision: 1 }, 'share');
  assert.equal(controller.getSnapshot().command.status, 'confirmed');
  mounted = false; assert.equal(controller.getSnapshot().disposed, true); assert.equal(controller.getSnapshot().groups.data, null);
  assert.throws(() => controller.inspectIntent('share'), { code: 'session_changed' });
});

test('group create controller exposes only the confirmed server group and requires explicit list refresh', async () => {
  const f = await fixture(); const controller = f.bridge.createGroupController();
  await controller.loadGroups(); await controller.loadDetail(G); await controller.loadSharing(G); await controller.loadMotions(G);
  const before = controller.getSnapshot(); let resolve; f.state.response = () => new Promise(done => { resolve = done; });
  const pending = controller.createGroup(create(), 'create');
  const waiting = controller.getSnapshot(); assert.equal(waiting.command.kind, 'create'); assert.equal(waiting.command.status, 'pending');
  assert.equal(waiting.command.groupId, null); assert.equal(waiting.command.createdGroup, null); assert.equal(waiting.groups.status, 'stale');
  const server = { ...group(), id: I, name: 'Server group', revision: 4 };
  resolve(server); assert.deepEqual(await pending, server);
  const confirmed = controller.getSnapshot(); assert.equal(confirmed.command.status, 'confirmed'); assert.deepEqual(confirmed.command.createdGroup, server);
  assert.ok(Object.isFrozen(confirmed.command.createdGroup)); assert.equal(confirmed.groups.data, null);
  for (const slot of ['detail', 'sharing', 'motions']) assert.equal(confirmed[slot], before[slot]);
  assert.equal(f.calls.length, 5);
  f.state.response = () => [group(), server]; await controller.loadGroups();
  assert.deepEqual(controller.getSnapshot().groups.data, [group(), server]);
  controller.dispose(); assert.equal(controller.getSnapshot().command.createdGroup, null);
});

test('group create controller clears prior result and preserves consent and server eligibility errors', async () => {
  const f = await fixture(); const controller = f.bridge.createGroupController(); await controller.createGroup(create(), 'first');
  const before = f.calls.length;
  await assert.rejects(controller.createGroup({ name: 'Family', alias: 'Leaf' }, 'no-consent'), invalidInput);
  assert.equal(f.calls.length, before); assert.equal(controller.getSnapshot().command.createdGroup, null);
  for (const [status, code] of [[403, 'community_adult_eligibility_unavailable'], [422, 'community_text_rejected'], [409, 'community_account_capacity']]) {
    f.state.response = () => json({ error: { code } }, status);
    await assert.rejects(controller.createGroup(create(), code), { code });
    const state = controller.getSnapshot(); assert.equal(state.command.status, 'error'); assert.equal(state.command.createdGroup, null);
    assert.deepEqual(state.command.error, { status, code, effectUnknown: false, originalEffectUnknown: false });
    assert.equal(state.command.intent.state, 'rejected');
  }
});

test('unknown group creation retains exact intent on retry and accepts only the validated server projection', async () => {
  const f = await fixture(() => { throw new Error('lost'); }); const controller = f.bridge.createGroupController();
  await assert.rejects(controller.createGroup(create(), 'create'), unknown);
  assert.equal(controller.getSnapshot().command.intent.state, 'unknown'); assert.equal(controller.getSnapshot().command.createdGroup, null);
  await assert.rejects(controller.createGroup({ ...create(), name: 'Changed' }, 'create'), error => error.code === 'idempotency_conflict' && error.originalEffectUnknown);
  assert.equal(f.calls.length, 1);
  f.state.response = () => ({ ...group(), accountId: G }); await assert.rejects(controller.retry('create'), unknown);
  assert.equal(controller.getSnapshot().command.createdGroup, null);
  const server = { ...group(), id: I, revision: 3 }; f.state.response = () => server;
  assert.deepEqual(await controller.retry('create'), server);
  const command = controller.getSnapshot().command; assert.equal(command.status, 'confirmed'); assert.deepEqual(command.createdGroup, server);
  assert.equal(command.intent.originalEffectUnknown, true); assert.equal(command.intent.state, 'confirmed');
  assert.ok(f.calls.every(call => call.path === '/groups' && call.method === 'POST' && call.key === 'create' && call.raw === f.calls[0].raw));
  let resolve; f.state.response = () => new Promise(done => { resolve = done; });
  const next = controller.createGroup(create(), 'next'); assert.equal(controller.getSnapshot().command.createdGroup, null);
  resolve(group()); await next;
});

test('group creation fences an older list response without inserting a guessed group or reloading', async () => {
  let resolve; const f = await fixture(call => call.method === 'GET' ? new Promise(done => { resolve = done; }) : group());
  const controller = f.bridge.createGroupController(); const list = controller.loadGroups();
  await controller.createGroup(create(), 'create'); resolve([]); await list;
  assert.equal(controller.getSnapshot().groups.status, 'stale'); assert.equal(controller.getSnapshot().groups.data, null);
  assert.equal(f.calls.length, 2); assert.equal(controller.getSnapshot().detail.status, 'idle');
});

test('late group creation results cannot populate state after controller disposal or account switch', async () => {
  for (const end of ['dispose', 'switch']) {
    let resolve; const f = await fixture(() => new Promise(done => { resolve = done; })); const controller = f.bridge.createGroupController();
    const pending = controller.createGroup(create(), 'create');
    if (end === 'dispose') controller.dispose(); else await f.transport.signIn('other@example.invalid', 'synthetic-password');
    resolve(group()); await assert.rejects(pending, unknown);
    const state = controller.getSnapshot(); assert.equal(state.disposed, true); assert.equal(state.command.createdGroup, null);
    assert.equal(state.groups.data, null); assert.throws(() => controller.retry('create'), { code: 'session_changed' });
  }
});

test('invitation join controller binds explicit consent to the latest successful preview', async () => {
  const f = await fixture(), controller = f.bridge.createInvitationJoinController();
  assert.equal(controller.getSnapshot().preview.status, 'idle');
  await assert.rejects(controller.joinInvitation(joining(), 'join'), { code: 'community_invitation_preview_required' });
  assert.equal(f.calls.length, 0);
  await controller.previewInvitation({ token: secret });
  const preview = controller.getSnapshot().preview;
  assert.equal(preview.status, 'ready'); assert.equal(preview.data.membershipDisclosure, 'Membership is visible.');
  assert.equal(Object.isFrozen(preview.data), true); assert.equal(JSON.stringify(controller.getSnapshot()).includes(secret), false);
  await assert.rejects(controller.joinInvitation({ ...joining(), token: 'B'.repeat(42) + 'A' }, 'wrong'), { code: 'community_invitation_preview_required' });
  await assert.rejects(controller.joinInvitation({ token: secret, alias: 'Leaf' }, 'no-consent'), invalidInput);
  await assert.rejects(controller.joinInvitation(joining(), secret), invalidInput);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await controller.joinInvitation(joining(), 'join'), { groupId: G, memberId: M });
  const confirmed = controller.getSnapshot();
  assert.equal(confirmed.command.status, 'confirmed'); assert.deepEqual(confirmed.command.result, { groupId: G, memberId: M });
  assert.equal(confirmed.preview.status, 'stale'); assert.equal(confirmed.preview.data, null);
  assert.equal(controller.inspectIntent('join'), null); assert.equal(f.bridge.inspectIntent('join'), null);
  assert.throws(() => controller.retry('join'), { code: 'community_intent_not_found' });
  await assert.rejects(controller.joinInvitation(joining(), 'another'), { code: 'community_invitation_preview_required' });
  assert.equal(f.calls.length, 2); assert.equal(JSON.stringify(controller.getSnapshot()).includes(secret), false);
});

test('invitation preview latest request wins and failed previews cannot authorize joining', async () => {
  const pending = [], f = await fixture(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const controller = f.bridge.createInvitationJoinController(), other = 'B'.repeat(42) + 'A';
  const first = controller.previewInvitation({ token: secret }), second = controller.previewInvitation({ token: other });
  assert.equal(controller.getSnapshot().preview.status, 'loading');
  pending[1].resolve({ name: 'Second', expiresAt: at, membershipDisclosure: 'Visible.' }); await second;
  pending[0].reject(new Error('late failure')); await first;
  assert.equal(controller.getSnapshot().preview.data.name, 'Second');
  await assert.rejects(controller.joinInvitation(joining(), 'old'), { code: 'community_invitation_preview_required' });
  f.state.response = () => json({ error: { code: 'invitation_unavailable' } }, 404);
  await assert.rejects(controller.previewInvitation({ token: secret }), error => error.code === 'invitation_unavailable' && !error.effectUnknown);
  assert.equal(controller.getSnapshot().preview.status, 'error'); assert.equal(controller.getSnapshot().preview.data, null);
  await assert.rejects(controller.joinInvitation({ ...joining(), token: other }, 'failed'), { code: 'community_invitation_preview_required' });
  assert.equal(f.calls.length, 3);
});

test('pending invitation join blocks competing intents while preview changes preserve the original command', async () => {
  const f = await fixture(), controller = f.bridge.createInvitationJoinController();
  await controller.previewInvitation({ token: secret }); let resolve;
  f.state.response = call => call.path.endsWith('/join') ? new Promise(done => { resolve = done; }) : responseFor(call);
  const joiningRequest = controller.joinInvitation(joining(), 'original');
  const command = controller.getSnapshot().command; assert.equal(command.status, 'pending'); assert.equal(command.intent.state, 'pending');
  await controller.previewInvitation({ token: 'B'.repeat(42) + 'A' }); assert.equal(controller.getSnapshot().command, command);
  await assert.rejects(controller.joinInvitation({ ...joining(), token: 'B'.repeat(42) + 'A' }, 'next'), { code: 'community_intent_in_flight' });
  assert.throws(() => controller.retry('original'), { code: 'community_intent_in_flight' });
  resolve({ groupId: G, memberId: M }); await joiningRequest;
  assert.equal(controller.getSnapshot().preview.data, null); assert.equal(f.calls.length, 3);
});

test('unknown invitation join survives preview changes and retries only its original secret and fields', async () => {
  const f = await fixture(), controller = f.bridge.createInvitationJoinController();
  await controller.previewInvitation({ token: secret });
  f.state.response = () => { throw new Error('lost'); };
  await assert.rejects(controller.joinInvitation(joining(), 'original'), unknown);
  const command = controller.getSnapshot().command;
  assert.equal(command.status, 'error'); assert.equal(command.intent.state, 'unknown'); assert.equal(command.originalEffectUnknown, true);
  f.state.response = null; await controller.previewInvitation({ token: 'B'.repeat(42) + 'A' });
  assert.equal(controller.getSnapshot().command, command);
  await assert.rejects(controller.joinInvitation({ ...joining(), token: 'B'.repeat(42) + 'A' }, 'next'), error => error.code === 'community_join_reconcile_required' && error.originalEffectUnknown);
  assert.throws(() => controller.retry('next'), { code: 'community_intent_not_found' });
  f.state.response = () => json({ error: { code: 'invitation_unavailable' } }, 404);
  await assert.rejects(controller.retry('original'), unknown);
  assert.equal(controller.getSnapshot().command.intent.state, 'unknown');
  f.state.response = null; assert.deepEqual(await controller.retry('original'), { groupId: G, memberId: M });
  assert.equal(controller.getSnapshot().command.originalEffectUnknown, true);
  assert.equal(controller.getSnapshot().command.intent, null); assert.equal(controller.inspectIntent('original'), null);
  assert.equal(f.calls[1].raw, f.calls[3].raw); assert.equal(f.calls[1].raw, f.calls[4].raw);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(secret), false); assert.equal(f.calls.length, 5);
});

test('invitation controller rejects private projections and strips echoed secrets from errors', async () => {
  const f = await fixture(), controller = f.bridge.createInvitationJoinController();
  for (const response of [
    { name: secret, expiresAt: at, membershipDisclosure: 'Visible.' },
    { name: 'Family', expiresAt: at, membershipDisclosure: 'Visible.', accountId: G },
    json({ error: { code: secret, message: secret } }, 503),
  ]) {
    f.state.response = () => response;
    await assert.rejects(controller.previewInvitation({ token: secret }), error => !JSON.stringify(error).includes(secret) && !error.message.includes(secret) && !error.effectUnknown);
    assert.equal(controller.getSnapshot().preview.status, 'error'); assert.equal(JSON.stringify(controller.getSnapshot()).includes(secret), false);
  }
  f.state.response = null; await controller.previewInvitation({ token: secret });
  f.state.response = () => ({ groupId: G, memberId: M, token: secret });
  await assert.rejects(controller.joinInvitation(joining(), 'join'), unknown);
  assert.equal(controller.getSnapshot().command.result, null); assert.equal(controller.getSnapshot().command.intent.state, 'unknown');
  f.state.response = () => json({ error: { code: secret, message: secret } }, 503);
  await assert.rejects(controller.retry('join'), error => error.originalEffectUnknown && !JSON.stringify(error).includes(secret) && !error.message.includes(secret));
  assert.equal(JSON.stringify(controller.getSnapshot()).includes(secret), false);
});

test('invitation controller disposal and session changes clear snapshots and fence late previews and joins', async () => {
  for (const end of ['dispose', 'switch', 'resource', 'mounted']) for (const operation of ['preview', 'join']) {
    let mounted = true, resolve; const f = await fixture(undefined, () => mounted), controller = f.bridge.createInvitationJoinController();
    if (operation === 'join') await controller.previewInvitation({ token: secret });
    f.state.response = () => new Promise(done => { resolve = done; });
    const pending = operation === 'join' ? controller.joinInvitation(joining(), 'join') : controller.previewInvitation({ token: secret });
    if (end === 'dispose') controller.dispose();
    if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password');
    if (end === 'resource') f.bridge.dispose();
    if (end === 'mounted') mounted = false;
    const stopped = controller.getSnapshot(); assert.equal(stopped.disposed, true); assert.equal(stopped.preview.data, null); assert.equal(stopped.command.key, null);
    resolve(operation === 'join' ? { groupId: G, memberId: M } : { name: 'Family', expiresAt: at, membershipDisclosure: 'Visible.' });
    await assert.rejects(pending, error => error.code === 'session_changed' && error.originalEffectUnknown === (operation === 'join'));
    assert.equal(controller.getSnapshot(), stopped); assert.throws(() => controller.subscribe(() => {}), { code: 'session_changed' });
    assert.throws(() => controller.retry('join'), { code: 'session_changed' });
  }
});

test('invitation observers cannot bypass pending joins or erase ledger state and subscriptions are removable', async () => {
  const f = await fixture(), controller = f.bridge.createInvitationJoinController();
  let notifications = 0; const subscription = controller.subscribe(() => { notifications++; });
  await controller.previewInvitation({ token: secret }); subscription.remove(); const before = notifications;
  controller.subscribe(() => { throw new Error('observer'); });
  const blocked = [];
  controller.subscribe(() => {
    if (controller.getSnapshot().command.status !== 'pending') return;
    try { controller.retry('join'); } catch (error) { blocked.push(error.code); }
  });
  await controller.joinInvitation(joining(), 'join'); assert.equal(notifications, before);
  assert.ok(blocked.length > 0); assert.deepEqual([...new Set(blocked)], ['community_intent_in_flight']);
  assert.equal(controller.getSnapshot().command.status, 'confirmed'); assert.equal(f.bridge.inspectIntent('join'), null);
  const sibling = f.bridge.createGroupController(); controller.dispose(); await sibling.loadGroups();
  assert.equal(sibling.getSnapshot().groups.status, 'ready');
});

test('matching assignment link accepts only server UUID or null without changing stored matching state', async () => {
  const f = await fixture(() => ({ ...matching(), state: 'assigned', revision: 2, generation: 1, assignedGroupId: G }));
  assert.equal((await f.bridge.readMatching()).assignedGroupId, G);
  const input = { expectedRevision: 1, preferences: prefs() };
  assert.equal((await f.bridge.enroll(input, 'enroll-link')).assignedGroupId, G);
  assert.equal((await f.bridge.updateMatching(input, 'update-link')).assignedGroupId, G);
  f.state.response = () => ({ ...matching(), state: 'assigned', revision: 2, generation: 1 });
  const inaccessible = await f.bridge.readMatching();
  assert.equal(inaccessible.state, 'assigned'); assert.equal(inaccessible.assignedGroupId, null);
  f.state.response = () => matching(); assert.equal((await f.bridge.cancelEnrollment(2, 'cancel-link')).assignedGroupId, null);
  assert.equal(Object.hasOwn(inaccessible, 'waitReason'), false); assert.equal(Object.hasOwn(inaccessible, 'nextBatchAt'), false);
});

test('matching assignment projection rejects absent malformed and private linkage metadata', async () => {
  const { assignedGroupId: _link, ...legacy } = matching();
  const f = await fixture();
  for (const response of [legacy, { ...matching(), assignedGroupId: 'not-a-uuid' }, { ...matching(), assignedGroupId: 3 },
    { ...matching(), assignedGroupId: { id: G } }, { ...matching(), assignedGroupId: G, accountId: M },
    { ...matching(), assignedGroupId: G, memberGeneration: 1 }]) {
    f.state.response = () => response;
    await assert.rejects(f.bridge.readMatching(), error => error.code === 'community_invalid_response' && !error.effectUnknown);
  }
  f.state.response = () => ({ ...matching(), assignedGroupId: 'invalid' });
  await assert.rejects(f.bridge.enroll({ expectedRevision: 0, preferences: prefs() }, 'malformed-link'), unknown);
  assert.equal(f.bridge.inspectIntent('malformed-link').state, 'unknown');
  f.state.response = () => ({ ...matching(), state: 'assigned', assignedGroupId: null });
  assert.equal((await f.bridge.retry('malformed-link')).assignedGroupId, null);
  assert.equal(f.bridge.inspectIntent('malformed-link').originalEffectUnknown, true);
});

test('matching assignment links cannot contradict queued or cancelled enrollment state', async () => {
  const f = await fixture();
  for (const state of ['queued', 'cancelled']) {
    f.state.response = () => ({ ...matching(), state, assignedGroupId: G });
    await assert.rejects(f.bridge.readMatching(), { code: 'community_invalid_response' });
  }
  await assert.rejects(f.bridge.enroll({ expectedRevision: 0, preferences: prefs() }, 'contradictory'), unknown);
  f.state.response = () => ({ ...matching(), state: 'assigned', assignedGroupId: G });
  assert.equal((await f.bridge.retry('contradictory')).assignedGroupId, G);
});

test('safety reference client validates strict target intent and never submits a report automatically', async () => {
  const f = await fixture(), input = { kind: 'member', resourceId: M };
  for (const value of [null, [], { ...input, kind: 'group' }, { ...input, resourceId: 'invalid' },
    { ...input, accountId: G }, { ...input, expiresAt: at }]) assert.throws(() => f.bridge.createSafetyReference(G, value, 'reference'), invalidInput);
  assert.throws(() => f.bridge.createSafetyReference('invalid', input, 'reference'), invalidInput);
  assert.throws(() => f.bridge.createSafetyReference(G, input, 'bad key'), invalidInput); assert.equal(f.calls.length, 0);
  const reference = await f.bridge.createSafetyReference(G, input, 'reference'); assert.deepEqual(reference, { id: I, expiresAt: at });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, `/groups/${G}/safety-references`);
  assert.equal(f.calls[0].method, 'POST'); assert.equal(f.calls[0].key, 'reference'); assert.deepEqual(f.calls[0].body, input);
  assert.throws(() => f.bridge.createSafetyReference(G, { kind: 'post', resourceId: P }, 'reference'), { code: 'idempotency_conflict' });
  assert.throws(() => f.bridge.createSafetyReference(M, input, 'reference'), { code: 'idempotency_conflict' });
  await f.bridge.report({ category: 'privacy', text: 'Synthetic report', safetyReference: reference.id }, 'report');
  assert.equal(f.calls[1].path, '/reports'); assert.equal(f.calls[1].body.safetyReference, reference.id);
});

test('unknown safety reference creation retries exact intent and rejects private or malformed projections', async () => {
  const f = await fixture(() => { throw new Error('lost'); }), input = { kind: 'post', resourceId: P };
  await assert.rejects(f.bridge.createSafetyReference(G, input, 'reference'), unknown);
  for (const response of [{ id: 'invalid', expiresAt: at }, { id: I, expiresAt: 'invalid' },
    { id: I, expiresAt: at, accountId: G }, { id: I, expiresAt: at, resourceId: P }, { id: I, expiresAt: at, text: 'private' }]) {
    f.state.response = () => response; await assert.rejects(f.bridge.retry('reference'), unknown);
  }
  f.state.response = null; assert.deepEqual(await f.bridge.retry('reference'), { id: I, expiresAt: at });
  assert.equal(f.bridge.inspectIntent('reference').originalEffectUnknown, true);
  assert.ok(f.calls.every(call => call.raw === f.calls[0].raw && call.key === 'reference' && call.path === f.calls[0].path));
});

test('late safety reference results and retries are fenced by disposal and account switch', async () => {
  for (const end of ['dispose', 'switch']) {
    let resolve; const f = await fixture(() => new Promise(done => { resolve = done; }));
    const pending = f.bridge.createSafetyReference(G, { kind: 'member', resourceId: M }, 'reference');
    if (end === 'dispose') f.bridge.dispose(); else await f.transport.signIn('other@example.invalid', 'synthetic-password');
    resolve({ id: I, expiresAt: at }); await assert.rejects(pending, error => error.code === 'session_changed' && error.originalEffectUnknown);
    assert.throws(() => f.bridge.retry('reference'), { code: 'session_changed' }); assert.equal(f.calls.length, 1);
  }
});

test('safety controller reads independent empty slots and preserves authorized notice explanations', async () => {
  const f = await fixture(call => call.path === '/me/safety-notices' ? responseFor(call) : []);
  const c = f.bridge.createSafetyController();
  assert.equal(c.getSnapshot().reports.status, 'idle');
  await c.loadReports(); await c.loadNotices(); await c.loadAppeals(); await c.loadBlocks();
  const state = c.getSnapshot();
  assert.equal(state.reports.status, 'empty'); assert.equal(state.appeals.status, 'empty'); assert.equal(state.blocks.status, 'empty');
  assert.equal(state.notices.status, 'ready'); assert.equal(state.notices.data[0].reason, 'Review requested');
  assert.equal(state.notices.data[0].rule, 'community-v1'); assert.ok(Object.isFrozen(state.notices.data[0]));
  f.state.response = () => json({ error: { code: 'private_report_prose', message: 'private report prose' } }, 503);
  await assert.rejects(c.loadReports());
  assert.equal(c.getSnapshot().reports.status, 'error'); assert.equal(c.getSnapshot().reports.error.code, 'community_read_unavailable');
  assert.equal(c.getSnapshot().notices.status, 'ready'); assert.equal(JSON.stringify(c.getSnapshot()).includes('private'), false);
});

test('safety controller fences superseded reads and post-command stale data without automatic reload', async () => {
  const resolve = []; const f = await fixture(call => call.method === 'GET' ? new Promise(done => resolve.push(done)) : responseFor(call));
  const c = f.bridge.createSafetyController();
  const old = c.loadReports(), latest = c.loadReports();
  assert.equal(c.getSnapshot().reports.status, 'loading');
  resolve[1]([]); await latest; resolve[0]([safety()]); await old;
  assert.equal(c.getSnapshot().reports.status, 'empty');
  const beforeMutation = c.loadReports();
  await c.report({ category: 'other', text: 'Private submitted words' }, 'report');
  resolve[2]([safety()]); await beforeMutation;
  assert.equal(c.getSnapshot().reports.status, 'stale'); assert.equal(c.getSnapshot().reports.data, null);
  assert.equal(c.getSnapshot().command.result.kind, 'report');
  assert.equal(c.getSnapshot().command.result.value.support, 'unavailable');
  assert.equal(JSON.stringify(c.getSnapshot()).includes('Private submitted words'), false);
  assert.equal(f.calls.length, 4);
});

test('safety controller creates an explicit reference before separately reporting and appealing', async () => {
  const f = await fixture(), c = f.bridge.createSafetyController();
  const reference = await c.createSafetyReference(G, { kind: 'post', resourceId: P }, 'reference');
  assert.deepEqual(c.getSnapshot().command.result, { kind: 'reference', value: reference }); assert.equal(f.calls.length, 1);
  await c.report({ category: 'privacy', text: 'Private report', safetyReference: reference.id }, 'report');
  assert.equal(f.calls[1].body.safetyReference, I); assert.equal(c.getSnapshot().command.result.kind, 'report');
  await c.loadNotices(); await c.loadAppeals();
  await c.appeal(I, { text: 'Private appeal', expectedRevision: 1 }, 'appeal');
  assert.equal(c.getSnapshot().command.result.kind, 'appeal');
  assert.equal(c.getSnapshot().notices.status, 'stale'); assert.equal(c.getSnapshot().appeals.status, 'stale');
  await c.loadAppeals(); assert.deepEqual(Object.keys(c.getSnapshot().appeals.data[0]).sort(), Object.keys(safety()).sort());
  assert.equal(JSON.stringify(c.getSnapshot()).includes('Private'), false);
});

test('safety controller unknown command prevents every replacement and retries exact original after access rejection', async () => {
  const f = await fixture(() => { throw new Error('private draft'); }), c = f.bridge.createSafetyController();
  const input = { category: 'privacy', text: 'Private original report' };
  await assert.rejects(c.report(input, 'original'), unknown); input.text = 'Edited draft';
  const original = c.getSnapshot().command;
  for (const replacement of [() => c.report(input, 'new'), () => c.appeal(I, { text: 'Changed', expectedRevision: 2 }, 'new'),
    () => c.blockMember(G, M, 'new'), () => c.unblock(I, 1, 'new'), () => c.createSafetyReference(G, { kind: 'member', resourceId: M }, 'new')]) {
    await assert.rejects(replacement(), { code: 'community_safety_reconcile_required' });
    assert.equal(c.getSnapshot().command, original);
  }
  f.state.response = () => []; await c.loadReports();
  assert.equal(c.getSnapshot().command.intent.state, 'unknown');
  f.state.response = () => json({ error: { code: 'community_not_found', message: 'Private original report' } }, 404);
  await assert.rejects(c.retry('original'), unknown);
  assert.equal(c.getSnapshot().command.intent.state, 'unknown'); assert.equal(c.getSnapshot().command.result, null);
  await assert.rejects(c.report(input, 'new'), { code: 'community_safety_reconcile_required' });
  f.state.response = null; await c.retry('original');
  assert.equal(c.getSnapshot().command.status, 'confirmed'); assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true);
  const mutations = f.calls.filter(call => call.method === 'POST');
  assert.equal(mutations.length, 3); assert.ok(mutations.every(call => call.raw === mutations[0].raw && call.key === 'original' && call.path === '/reports'));
  assert.equal(JSON.stringify(c.getSnapshot()).includes('Private'), false);
});

test('safety controller pending observers cannot replace or retry the original command', async () => {
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; })), c = f.bridge.createSafetyController();
  const attempts = [];
  c.subscribe(() => { throw new Error('observer failure'); });
  c.subscribe(() => {
    if (c.getSnapshot().command.status !== 'pending') return;
    attempts.push(assert.rejects(c.report({ category: 'other', text: 'replacement' }, 'replacement'), { code: 'community_intent_in_flight' }));
    assert.throws(() => c.retry('original'), { code: 'community_intent_in_flight' });
  });
  const pending = c.report({ category: 'other', text: 'original' }, 'original');
  assert.equal(c.getSnapshot().command.result, null); assert.equal(f.calls.length, 1);
  resolve(safety()); await pending; await Promise.all(attempts);
  assert.ok(attempts.length > 0); assert.equal(c.getSnapshot().command.intent.state, 'confirmed');
});

test('safety controller only retries its retained key and leaves opaque block records unassociated', async () => {
  const f = await fixture(), c = f.bridge.createSafetyController();
  await f.bridge.report({ category: 'other', text: 'Other consumer' }, 'foreign');
  assert.equal(c.inspectIntent('foreign'), null); assert.throws(() => c.retry('foreign'), { code: 'community_intent_not_found' });
  await assert.rejects(c.report({ category: 'other', text: 'Other consumer' }, 'foreign'), { code: 'community_controller_intent_unavailable' });
  await c.loadBlocks(); assert.deepEqual(c.getSnapshot().blocks.data, [block()]);
  const blocked = await c.blockMember(G, M, 'block'); assert.equal(c.getSnapshot().command.result.kind, 'block');
  assert.equal(c.getSnapshot().blocks.status, 'stale');
  f.state.response = call => call.path.endsWith('/unblock') ? { ...block(), revision: 2, active: false } : responseFor(call);
  const unblocked = await c.unblock(blocked.id, blocked.revision, 'unblock');
  assert.equal(unblocked.active, false); assert.deepEqual(c.getSnapshot().command.result, { kind: 'unblock', value: unblocked });
  assert.equal(c.inspectIntent('block'), null); assert.throws(() => c.retry('block'), { code: 'community_intent_not_found' });
  assert.equal(f.calls.at(-1).body.expectedRevision, blocked.revision);
});

test('safety controller access rejection invalidates affected slots and removes prior confirmed projections', async () => {
  const f = await fixture(), c = f.bridge.createSafetyController();
  await c.blockMember(G, M, 'first'); await c.loadBlocks(); await c.loadReports();
  f.state.response = () => json({ error: { code: 'community_forbidden', message: 'private member identity' } }, 403);
  await assert.rejects(c.unblock(I, 1, 'denied'));
  assert.equal(c.getSnapshot().command.status, 'error'); assert.equal(c.getSnapshot().command.intent.state, 'rejected');
  assert.equal(c.getSnapshot().command.result, null); assert.equal(c.getSnapshot().blocks.status, 'stale');
  assert.equal(c.getSnapshot().reports.status, 'ready');
  assert.equal(JSON.stringify(c.getSnapshot()).includes('private member identity'), false);
});

test('safety controller strict projections reject private response fields without confirming commands', async () => {
  const f = await fixture(), c = f.bridge.createSafetyController();
  for (const [load, response] of [[() => c.loadReports(), [{ ...safety(), text: 'private' }]],
    [() => c.loadNotices(), [{ ...responseFor({ path: '/me/safety-notices' })[0], accountId: G }]],
    [() => c.loadAppeals(), [{ ...safety(), noticeId: I }]], [() => c.loadBlocks(), [{ ...block(), alias: 'private' }]]]) {
    f.state.response = () => response; await assert.rejects(load(), { code: 'community_invalid_response' });
  }
  f.state.response = () => ({ ...safety(), text: 'private' });
  await assert.rejects(c.report({ category: 'danger', text: 'Quoted abuse' }, 'report'), unknown);
  assert.equal(c.getSnapshot().command.result, null); assert.equal(c.getSnapshot().command.intent.state, 'unknown');
  assert.equal(JSON.stringify(c.getSnapshot()).includes('private'), false);
});

test('safety controller disposal and account changes fence late reads commands and snapshot access', async () => {
  for (const end of ['controller', 'resource', 'switch', 'mount']) {
    let mounted = true; const resolve = [];
    const f = await fixture(() => new Promise(done => resolve.push(done)), () => mounted), c = f.bridge.createSafetyController();
    const read = c.loadNotices(), command = c.report({ category: 'other', text: 'Private pending' }, 'report');
    if (end === 'controller') c.dispose();
    else if (end === 'resource') f.bridge.dispose();
    else if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password');
    else mounted = false;
    assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().command.key, null);
    resolve[0](responseFor({ path: '/me/safety-notices' })); resolve[1](safety());
    await assert.rejects(read, { code: 'session_changed' }); await assert.rejects(command, { code: 'session_changed' });
    assert.equal(c.getSnapshot().notices.data, null); assert.equal(c.getSnapshot().command.result, null);
    assert.throws(() => c.retry('report'), { code: 'session_changed' }); await assert.rejects(c.loadReports(), { code: 'session_changed' });
    assert.equal(f.calls.length, 2);
  }
});

test('safety controller observer teardown prevents dispatch and confirmed result publication', async () => {
  for (const phase of ['pending', 'confirmed']) {
    const f = await fixture(), c = f.bridge.createSafetyController(); let notices = 0;
    c.subscribe(() => { if (c.getSnapshot().command.status === phase) c.dispose(); });
    c.subscribe(() => { if (!c.getSnapshot().disposed) notices++; });
    await assert.rejects(c.report({ category: 'other', text: 'Private draft' }, 'report'), { code: 'session_changed' });
    assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().command.result, null);
    assert.equal(f.calls.length, phase === 'pending' ? 0 : 1);
    if (phase === 'pending') assert.equal(notices, 0);
  }
});

test('safety controller stale revision requires explicit reload and preserves the exact rejected intent', async () => {
  const f = await fixture(), c = f.bridge.createSafetyController();
  await c.loadNotices(); await c.loadAppeals();
  f.state.response = () => json({ error: { code: 'stale_revision', message: 'Private draft' } }, 409);
  await assert.rejects(c.appeal(I, { text: 'Private draft', expectedRevision: 1 }, 'appeal'), { code: 'stale_revision' });
  assert.equal(c.getSnapshot().notices.status, 'stale'); assert.equal(c.getSnapshot().appeals.status, 'stale');
  assert.equal(c.inspectIntent('appeal').disposition, 'reload_before_new_intent');
  assert.equal(c.inspectIntent('appeal').expectedRevision, 1); assert.equal(c.getSnapshot().command.result, null);
  const beforeReload = f.calls.length; f.state.response = null; await c.loadNotices();
  assert.equal(f.calls.length, beforeReload + 1); assert.equal(c.getSnapshot().command.intent.state, 'rejected');
  assert.equal(c.getSnapshot().notices.status, 'ready');
});

test('safety controller unauthorized reads clear every child projection and reject further dispatch', async () => {
  const f = await fixture(), c = f.bridge.createSafetyController();
  await c.loadNotices(); await c.report({ category: 'other', text: 'Private report' }, 'report');
  f.state.response = () => json({ error: { code: 'unauthenticated', message: 'Private report' } }, 401);
  await assert.rejects(c.loadBlocks(), { code: 'session_changed' });
  const state = c.getSnapshot(); assert.equal(state.disposed, true);
  for (const name of ['reports', 'notices', 'appeals', 'blocks']) assert.equal(state[name].data, null);
  assert.equal(state.command.key, null); assert.equal(state.command.intent, null);
  const before = f.calls.length; await assert.rejects(c.report({ category: 'other', text: 'New' }, 'new'), { code: 'session_changed' });
  assert.equal(f.calls.length, before);
});

test('own friend invitation metadata validates exact four fields and route identifiers', async () => {
  const metadata = { id: I, revision: 4, state: 'expired', expiresAt: at };
  const f = await fixture(() => metadata);
  assert.deepEqual(await f.bridge.readFriendInvitation(G, P), metadata);
  assert.equal(f.calls[0].path, `/groups/${G}/me/friend-reservations/${P}/invitation`); assert.equal(f.calls[0].method, 'GET');
  assert.throws(() => f.bridge.readFriendInvitation('invalid', P), invalidInput);
  assert.throws(() => f.bridge.readFriendInvitation(G, 'invalid'), invalidInput);
  for (const response of [{ ...metadata, token: secret }, { ...metadata, tokenAvailable: false }, { ...metadata, accountId: G },
    { ...metadata, groupId: G }, { ...metadata, id: 'bad' }, { ...metadata, revision: 0 }, { ...metadata, state: 'available' }, { ...metadata, expiresAt: 'bad' }]) {
    f.state.response = () => response; await assert.rejects(f.bridge.readFriendInvitation(G, P), { code: 'community_invalid_response' });
  }
});

test('friend controller drives explicit governance reservation issue and sponsor reload revoke without manager listing', async () => {
  let due = false, issued = false;
  const f = await fixture(call => {
    if (call.path.endsWith('/finalize')) return due ? { ...motion(), state: 'passed' } : json({ error: { code: 'community_motion_not_due' } }, 409);
    if (call.path.endsWith('/me/friend-reservations')) return [{ ...reservation(), invitationId: issued ? I : null }];
    if (call.path.endsWith(`/reservations/${I}/invitations`)) { issued = true; return { ...invite(), tokenAvailable: true, token: secret }; }
    if (call.path.endsWith(`/friend-reservations/${I}/invitation`)) return { id: I, revision: 4, state: 'pending', expiresAt: at };
    if (call.path.endsWith('/revoke')) return { ...invite(), revision: 5, state: 'revoked' };
    return responseFor(call);
  });
  const c = f.bridge.createFriendInvitationController(G), snapshots = [];
  c.subscribe(() => snapshots.push(JSON.stringify(c.getSnapshot())));
  await c.loadPolicy(); await c.loadMotions();
  await c.createFriendMotion(c.getSnapshot().policy.data.revision, 'motion');
  assert.deepEqual(f.calls.at(-1).body, { kind: 'friend', expectedRevision: 1 });
  await c.setBallot(P, { choice: 'yes', expectedRevision: 0 }, 'ballot');
  await assert.rejects(c.finalizeMotion(P, 'finalize'), { code: 'community_motion_not_due' });
  assert.equal(c.getSnapshot().command.result, null); due = true; await c.retry('finalize');
  assert.equal(c.getSnapshot().command.result.value.state, 'passed'); assert.equal(c.getSnapshot().reservations.status, 'stale');
  await c.loadReservations(); const result = await c.issueFriendInvitation(c.getSnapshot().reservations.data[0].id, 'issue');
  assert.equal(result.token, secret); assert.equal(c.getSnapshot().command.result.value.tokenAvailable, false);
  c.dispose(); const reloaded = f.bridge.createFriendInvitationController(G);
  await reloaded.loadReservations(); await reloaded.loadInvitation(reloaded.getSnapshot().reservations.data[0].id);
  const current = reloaded.getSnapshot().invitation.data;
  assert.equal(current.revision, 4); await reloaded.revokeInvitation(current.id, current.revision, 'revoke');
  assert.equal(f.calls.at(-1).body.expectedRevision, 4); assert.equal(reloaded.getSnapshot().command.result.value.state, 'revoked');
  assert.ok(snapshots.every(snapshot => !snapshot.includes(secret)));
  assert.equal(f.calls.some(call => call.method === 'GET' && call.path === `/groups/${G}/invitations`), false);
  assert.equal(f.calls.some(call => call.path.endsWith('/replace')), false); assert.equal(f.storageCalls.length, 1);
});

test('friend controller keeps independent latest reads and reports selected invitation absence explicitly', async () => {
  const resolves = [];
  const f = await fixture(call => call.path.endsWith('/invitation') ? new Promise(done => resolves.push(done)) :
    call.path.endsWith('/me/friend-reservations') ? [] : responseFor(call));
  const c = f.bridge.createFriendInvitationController(G);
  await c.loadPolicy(); await c.loadMotions(); await c.loadReservations(); assert.equal(c.getSnapshot().reservations.status, 'empty');
  const first = c.loadInvitation(I), second = c.loadInvitation(P);
  resolves[1]({ id: M, revision: 3, state: 'revoked', expiresAt: at }); await second;
  resolves[0]({ id: I, revision: 1, state: 'pending', expiresAt: at }); await first;
  assert.equal(c.getSnapshot().invitationReservationId, P); assert.equal(c.getSnapshot().invitation.data.id, M);
  f.state.response = () => json({ error: { code: 'community_not_found' } }, 404);
  await assert.rejects(c.loadInvitation(I), { code: 'community_not_found' });
  assert.equal(c.getSnapshot().invitation.data, null); assert.equal(c.getSnapshot().invitation.status, 'error');
  assert.equal(c.getSnapshot().policy.status, 'ready'); assert.equal(c.getSnapshot().motions.status, 'ready');
});

test('friend controller unknown issue preserves revoke-or-replace disposition and exact retry before explicit revoke', async () => {
  const f = await fixture(() => { throw new Error(secret); }), c = f.bridge.createFriendInvitationController(G);
  await assert.rejects(c.issueFriendInvitation(I, 'issue'), unknown);
  const command = c.getSnapshot().command; assert.equal(command.intent.disposition, 'revoke_or_replace');
  for (const replacement of [() => c.issueFriendInvitation(P, 'new'), () => c.revokeInvitation(I, 1, 'revoke'),
    () => c.createFriendMotion(1, 'motion'), () => c.setBallot(P, { choice: 'yes', expectedRevision: 0 }, 'ballot'), () => c.finalizeMotion(P, 'finalize')]) {
    await assert.rejects(replacement(), { code: 'community_friend_reconcile_required' }); assert.equal(c.getSnapshot().command, command);
  }
  f.state.response = call => call.method === 'GET' ? [reservation()] : json({ error: { code: 'community_not_found' } }, 404);
  await c.loadReservations(); await assert.rejects(c.retry('issue'), unknown);
  assert.equal(c.getSnapshot().command.intent.state, 'unknown'); assert.equal(c.getSnapshot().command.result, null);
  f.state.response = () => ({ ...invite(), tokenAvailable: true, token: secret });
  await assert.rejects(c.retry('issue'), { code: 'community_invitation_replay_invalid' });
  f.state.response = () => ({ ...invite(), revision: 3 });
  const recovered = await c.retry('issue'); assert.equal(recovered.tokenAvailable, false);
  assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true); assert.equal(c.getSnapshot().command.intent.disposition, 'revoke_or_replace');
  const attempts = f.calls.filter(call => call.method === 'POST');
  assert.ok(attempts.every(call => call.path === attempts[0].path && call.raw === '{}' && call.key === 'issue'));
  f.state.response = () => ({ ...invite(), state: 'revoked', revision: 4 });
  await c.revokeInvitation(recovered.id, recovered.revision, 'revoke');
  assert.equal(f.calls.at(-1).body.expectedRevision, 3); assert.equal(JSON.stringify(c.getSnapshot()).includes(secret), false);
});

test('friend controller pending observers cannot replace intent and repeated issue response never returns token twice', async () => {
  const f = await fixture(call => call.path.endsWith('/invitations') ? { ...invite(), tokenAvailable: true, token: secret } : responseFor(call));
  const c = f.bridge.createFriendInvitationController(G), attempted = [];
  c.subscribe(() => {
    if (c.getSnapshot().command.status !== 'pending') return;
    attempted.push(assert.rejects(c.issueFriendInvitation(P, 'other'), { code: 'community_intent_in_flight' }));
    assert.throws(() => c.retry('issue'), { code: 'community_intent_in_flight' });
  });
  assert.equal((await c.issueFriendInvitation(I, 'issue')).token, secret);
  const replay = await c.retry('issue'); await Promise.all(attempted);
  assert.equal(replay.tokenAvailable, false); assert.equal('token' in replay, false);
  assert.equal(c.getSnapshot().command.result.value.tokenAvailable, false); assert.equal(JSON.stringify(c.getSnapshot()).includes(secret), false);
  assert.equal(f.calls.length, 2);
});

test('friend controller rejects foreign retained keys and stale responses cannot restore invalidated invitation data', async () => {
  let resolve; const f = await fixture(call => call.path.endsWith('/invitation') ? new Promise(done => { resolve = done; }) : responseFor(call));
  const c = f.bridge.createFriendInvitationController(G);
  await f.bridge.finalizeMotion(G, P, 'foreign');
  assert.equal(c.inspectIntent('foreign'), null); assert.throws(() => c.retry('foreign'), { code: 'community_intent_not_found' });
  await assert.rejects(c.finalizeMotion(P, 'foreign'), { code: 'community_controller_intent_unavailable' });
  const read = c.loadInvitation(I); await c.revokeInvitation(I, 1, 'revoke');
  resolve({ id: I, revision: 1, state: 'pending', expiresAt: at }); await read;
  assert.equal(c.getSnapshot().invitation.status, 'stale'); assert.equal(c.getSnapshot().invitation.data, null);
});

test('friend controller stale revision and access rejection preserve uncertainty without implied permissions', async () => {
  const f = await fixture(), c = f.bridge.createFriendInvitationController(G);
  await c.loadPolicy(); await c.loadMotions(); await c.loadReservations();
  f.state.response = () => json({ error: { code: 'stale_revision', message: secret } }, 409);
  await assert.rejects(c.revokeInvitation(I, 1, 'revoke'), { code: 'stale_revision' });
  assert.equal(c.getSnapshot().command.intent.disposition, 'reload_before_new_intent'); assert.equal(c.getSnapshot().command.result, null);
  f.state.response = () => json({ error: { code: 'community_not_found', message: secret } }, 404);
  await assert.rejects(c.retry('revoke'), { code: 'community_not_found' });
  for (const name of ['policy', 'motions', 'reservations', 'invitation']) assert.equal(c.getSnapshot()[name].status, 'stale');
  assert.equal(JSON.stringify(c.getSnapshot()).includes(secret), false);
});

test('friend controller clears session projections and discards late tokens after teardown', async () => {
  for (const end of ['controller', 'resource', 'switch', 'mount']) {
    let resolve, mounted = true;
    const f = await fixture(() => new Promise(done => { resolve = done; }), () => mounted), c = f.bridge.createFriendInvitationController(G);
    const pending = c.issueFriendInvitation(I, 'issue');
    if (end === 'controller') c.dispose(); else if (end === 'resource') f.bridge.dispose();
    else if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else mounted = false;
    assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().groupId, null);
    resolve({ ...invite(), tokenAvailable: true, token: secret }); await assert.rejects(pending, { code: 'session_changed' });
    assert.equal(c.getSnapshot().command.result, null); assert.equal(c.getSnapshot().command.intent, null);
    assert.throws(() => c.retry('issue'), { code: 'session_changed' }); assert.equal(f.calls.length, 1);
  }
});

test('friend controller observer disposal before dispatch or token delivery leaves no retained secret', async () => {
  for (const phase of ['pending', 'confirmed']) {
    const f = await fixture(() => ({ ...invite(), tokenAvailable: true, token: secret })), c = f.bridge.createFriendInvitationController(G);
    const snapshots = [];
    c.subscribe(() => { snapshots.push(JSON.stringify(c.getSnapshot())); if (c.getSnapshot().command.status === phase) c.dispose(); });
    await assert.rejects(c.issueFriendInvitation(I, 'issue'), { code: 'session_changed' });
    assert.equal(c.getSnapshot().disposed, true); assert.equal(f.calls.length, phase === 'pending' ? 0 : 1);
    assert.ok(snapshots.every(snapshot => !snapshot.includes(secret)));
  }
});

test('posts controller replaces explicit pages and preserves empty pages with an opaque next cursor', async () => {
  const f = await fixture(call => call.path.includes(`cursor=${I}`) ? { posts: [], nextCursor: M } :
    call.path.includes(`cursor=${M}`) ? { posts: [{ ...post(), id: I }], nextCursor: null } : { posts: [post()], nextCursor: I });
  const c = f.bridge.createPostsController(G);
  assert.equal(c.getSnapshot().page.status, 'idle'); await c.loadPage({ limit: 1 });
  assert.equal(c.getSnapshot().page.data.posts[0].id, P); assert.equal(f.calls.length, 1);
  await c.loadPage({ cursor: c.getSnapshot().page.data.nextCursor, limit: 1 });
  assert.equal(c.getSnapshot().page.status, 'empty'); assert.deepEqual(c.getSnapshot().page.data, { posts: [], nextCursor: M });
  await c.loadPage({ cursor: c.getSnapshot().page.data.nextCursor, limit: 1 });
  assert.deepEqual(c.getSnapshot().page.data.posts.map(row => row.id), [I]); assert.equal(c.getSnapshot().page.data.nextCursor, null);
  assert.ok(Object.isFrozen(c.getSnapshot().page.data.posts[0])); assert.equal(f.calls.length, 3);
});

test('posts controller latest page wins and a command fences older page results until explicit reload', async () => {
  const resolve = []; const f = await fixture(call => call.method === 'GET' ? new Promise(done => resolve.push(done)) : responseFor(call));
  const c = f.bridge.createPostsController(G), first = c.loadPage(), latest = c.loadPage({ cursor: I });
  assert.equal(c.getSnapshot().page.status, 'loading');
  resolve[1]({ posts: [], nextCursor: null }); await latest; resolve[0]({ posts: [post()], nextCursor: I }); await first;
  assert.equal(c.getSnapshot().page.status, 'empty');
  const old = c.loadPage(); await c.hidePost(P, 1, 'hide');
  resolve[2]({ posts: [post()], nextCursor: null }); await old;
  assert.equal(c.getSnapshot().page.status, 'stale'); assert.equal(c.getSnapshot().page.data, null);
  assert.deepEqual(c.getSnapshot().command.result, { kind: 'hide', value: { id: P, revision: 2, state: 'hidden' } });
  assert.equal(f.calls.length, 4);
});

test('posts controller requires explicit consent and returns pending server content without publication inference', async () => {
  const body = { kind: 'win', text: 'Private submitted draft', policyVersion: 'community-v1', audiencePreviewAccepted: true };
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; })), c = f.bridge.createPostsController(G);
  await assert.rejects(c.createPost({ ...body, audiencePreviewAccepted: false }, 'invalid'), invalidInput);
  await assert.rejects(c.createPost({ ...body, policyVersion: 'future' }, 'invalid-policy'), invalidInput);
  assert.equal(f.calls.length, 0);
  const pending = c.createPost(body, 'create');
  assert.equal(c.getSnapshot().command.status, 'pending'); assert.equal(JSON.stringify(c.getSnapshot()).includes(body.text), false);
  const visible = { ...post(), kind: 'win', text: body.text }; delete visible.template;
  resolve(visible); assert.deepEqual(await pending, visible);
  assert.equal(c.getSnapshot().command.result.value.state, 'pending'); assert.equal(c.getSnapshot().command.result.value.text, body.text);
  assert.equal(c.getSnapshot().page.status, 'stale'); assert.equal(f.calls.length, 1);
});

test('posts controller uses the accepted fixed rejection message and never snapshots matched terms or raw errors', async () => {
  const draft = 'Synthetic matched term';
  const f = await fixture(() => json({ error: { code: 'community_text_rejected', message: draft, details: { term: draft } } }, 422));
  const c = f.bridge.createPostsController(G);
  assert.equal(COMMUNITY_POST_TEXT_REJECTED_MESSAGE, "This can't be posted in Form groups. Rephrase it and try again.");
  await assert.rejects(c.createPost({ kind: 'win', text: draft, policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'rejected'),
    error => error.code === 'community_text_rejected' && error.message === COMMUNITY_POST_TEXT_REJECTED_MESSAGE && !error.effectUnknown);
  assert.equal(c.getSnapshot().command.intent.state, 'rejected'); assert.equal(c.getSnapshot().command.result, null);
  assert.equal(JSON.stringify(c.getSnapshot()).includes(draft), false);
  f.state.response = () => json({ error: { code: draft, message: draft } }, 403);
  await assert.rejects(c.loadPage(), error => error.code === 'community_read_unavailable' && !error.message.includes(draft));
  assert.equal(JSON.stringify(c.getSnapshot()).includes(draft), false);
});

test('posts controller unavailable posting preserves unknown outcome and does not infer capability or publication', async () => {
  const f = await fixture(() => json({ error: { code: 'community_posting_unavailable' } }, 503)), c = f.bridge.createPostsController(G);
  await assert.rejects(c.createPost({ kind: 'check_in', template: 'checking_in', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'create'),
    error => error.code === 'community_posting_unavailable' && error.originalEffectUnknown);
  assert.equal(c.getSnapshot().command.status, 'error'); assert.equal(c.getSnapshot().command.intent.state, 'unknown');
  assert.equal(c.getSnapshot().command.error.code, 'community_posting_unavailable'); assert.equal(c.getSnapshot().command.result, null);
  await assert.rejects(c.hidePost(P, 1, 'hide'), { code: 'community_posts_reconcile_required' }); assert.equal(f.calls.length, 1);
});

test('posts controller exact unknown retry preserves consent text and key despite reload edited drafts and access loss', async () => {
  const body = { kind: 'win', text: 'Original synthetic draft', policyVersion: 'community-v1', audiencePreviewAccepted: true };
  const f = await fixture(() => { throw new Error('lost'); }), c = f.bridge.createPostsController(G);
  await assert.rejects(c.createPost(body, 'create'), unknown); const original = c.getSnapshot().command; body.text = 'Edited draft';
  await assert.rejects(c.createPost(body, 'new'), { code: 'community_posts_reconcile_required' });
  await assert.rejects(c.hidePost(P, 1, 'hide'), { code: 'community_posts_reconcile_required' }); assert.equal(c.getSnapshot().command, original);
  f.state.response = () => ({ posts: [], nextCursor: null }); await c.loadPage();
  assert.equal(c.getSnapshot().command.intent.state, 'unknown');
  f.state.response = () => json({ error: { code: 'community_not_found' } }, 404); await assert.rejects(c.retry('create'), unknown);
  assert.equal(c.getSnapshot().command.intent.state, 'unknown'); assert.equal(c.getSnapshot().page.status, 'stale');
  f.state.response = () => ({ ...post(), kind: 'win', text: 'Original synthetic draft' });
  await c.retry('create'); assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true);
  const requests = f.calls.filter(call => call.method === 'POST');
  assert.equal(requests.length, 3); assert.ok(requests.every(call => call.raw === requests[0].raw && call.key === 'create' && call.path === `/groups/${G}/posts`));
  assert.equal(requests[0].body.audiencePreviewAccepted, true); assert.equal(requests[0].body.text, 'Original synthetic draft');
});

test('posts controller pending observers cannot replace or retry its original command', async () => {
  let resolve; const f = await fixture(() => new Promise(done => { resolve = done; })), c = f.bridge.createPostsController(G);
  const attempts = [];
  c.subscribe(() => { throw new Error('observer'); });
  c.subscribe(() => {
    if (c.getSnapshot().command.status !== 'pending') return;
    attempts.push(assert.rejects(c.hidePost(P, 1, 'replacement'), { code: 'community_intent_in_flight' }));
    assert.throws(() => c.retry('create'), { code: 'community_intent_in_flight' });
  });
  const pending = c.createPost({ kind: 'check_in', template: 'at_my_pace', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'create');
  resolve(post()); await pending; await Promise.all(attempts);
  assert.ok(attempts.length > 0); assert.equal(c.getSnapshot().command.intent.state, 'confirmed'); assert.equal(f.calls.length, 1);
});

test('posts controller own hide uses real revisions and reload preserves author-visible hidden records', async () => {
  const f = await fixture(), c = f.bridge.createPostsController(G);
  await c.loadPage(); f.state.response = () => json({ error: { code: 'stale_revision' } }, 409);
  await assert.rejects(c.hidePost(P, 1, 'stale'), { code: 'stale_revision' });
  assert.equal(c.getSnapshot().command.intent.expectedRevision, 1); assert.equal(c.getSnapshot().command.intent.disposition, 'reload_before_new_intent');
  assert.equal(c.getSnapshot().page.status, 'stale');
  f.state.response = call => call.method === 'GET' ? { posts: [{ ...post(), revision: 3 }], nextCursor: null } : { id: P, revision: 4, state: 'hidden' };
  await c.loadPage(); await c.hidePost(P, c.getSnapshot().page.data.posts[0].revision, 'hide');
  assert.equal(f.calls.at(-1).body.expectedRevision, 3); assert.equal(c.getSnapshot().page.data, null);
  f.state.response = () => ({ posts: [{ ...post(), state: 'hidden', revision: 4 }], nextCursor: null });
  await c.loadPage(); assert.equal(c.getSnapshot().page.data.posts[0].state, 'hidden');
  assert.equal(c.getSnapshot().command.result.kind, 'hide');
});

test('posts controller strict projections reject private data wrong hide IDs and foreign intent adoption', async () => {
  const f = await fixture(), c = f.bridge.createPostsController(G);
  await f.bridge.hidePost(G, P, 1, 'foreign');
  assert.equal(c.inspectIntent('foreign'), null); assert.throws(() => c.retry('foreign'), { code: 'community_intent_not_found' });
  await assert.rejects(c.hidePost(P, 1, 'foreign'), { code: 'community_controller_intent_unavailable' });
  for (const response of [{ posts: [{ ...post(), accountId: M }], nextCursor: null }, { posts: [post()], nextCursor: 'bad' }]) {
    f.state.response = () => response; await assert.rejects(c.loadPage(), { code: 'community_invalid_response' });
  }
  f.state.response = () => ({ id: I, revision: 2, state: 'hidden' }); await assert.rejects(c.hidePost(P, 1, 'hide'), unknown);
  assert.equal(c.getSnapshot().command.result, null); assert.equal(c.getSnapshot().command.intent.state, 'unknown');
});

test('posts controller account disposal and mounted-session changes fence late pages and commands', async () => {
  for (const end of ['controller', 'resource', 'switch', 'mount']) {
    let mounted = true; const resolve = [];
    const f = await fixture(() => new Promise(done => resolve.push(done)), () => mounted), c = f.bridge.createPostsController(G);
    const read = c.loadPage(), command = c.hidePost(P, 1, 'hide');
    if (end === 'controller') c.dispose(); else if (end === 'resource') f.bridge.dispose();
    else if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else mounted = false;
    assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().groupId, null);
    resolve[0]({ posts: [post()], nextCursor: I }); resolve[1]({ id: P, revision: 2, state: 'hidden' });
    await assert.rejects(read, { code: 'session_changed' }); await assert.rejects(command, { code: 'session_changed' });
    assert.equal(c.getSnapshot().page.data, null); assert.equal(c.getSnapshot().command.intent, null);
    await assert.rejects(c.loadPage(), { code: 'session_changed' }); assert.throws(() => c.retry('hide'), { code: 'session_changed' });
    assert.equal(f.calls.length, 2);
  }
});

test('posts controller observer teardown clears content before dispatch or late result return', async () => {
  for (const phase of ['pending', 'confirmed']) {
    const f = await fixture(), c = f.bridge.createPostsController(G);
    c.subscribe(() => { if (c.getSnapshot().command.status === phase) c.dispose(); });
    await assert.rejects(c.createPost({ kind: 'check_in', template: 'checking_in', policyVersion: 'community-v1', audiencePreviewAccepted: true }, 'create'), { code: 'session_changed' });
    assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().page.data, null); assert.equal(c.getSnapshot().command.result, null);
    assert.equal(f.calls.length, phase === 'pending' ? 0 : 1);
  }
});


const removedMembership = () => ({ groupId: G, memberId: M, membershipGeneration: 2, removedAt: at,
  groupLabel: { status: 'available', value: 'Previously visible family' } });

test('own removed membership parser preserves explicit historical uncertainty and rejects identity or reason disclosures', async () => {
  const f = await fixture(() => [removedMembership()]);
  assert.deepEqual(await f.bridge.listRemovedMemberships(), [removedMembership()]);
  assert.equal(f.calls[0].path, '/me/removed-memberships'); assert.equal(f.calls[0].method, 'GET');
  assert.equal(communityRemovedMembershipMessage(removedMembership()), "You're no longer a member of Previously visible family.");
  const unavailable = { ...removedMembership(), removedAt: null, groupLabel: { status: 'unavailable' } };
  f.state.response = () => [unavailable]; assert.deepEqual(await f.bridge.listRemovedMemberships(), [unavailable]);
  assert.equal(communityRemovedMembershipMessage(unavailable), "You're no longer a member of this group.");
  for (const response of [
    [{ ...removedMembership(), groupId: 'not-a-uuid' }], [{ ...removedMembership(), membershipGeneration: 0 }],
    [{ ...removedMembership(), removedAt: 'not-a-time' }], [{ ...removedMembership(), accountId: I }],
    [{ ...removedMembership(), reason: 'Private reason' }], [{ ...removedMembership(), voterIds: [I] }],
    [{ ...removedMembership(), groupLabel: { status: 'unavailable', value: 'Later private name' } }],
    [{ ...removedMembership(), groupLabel: { status: 'available', value: '' } }],
    [removedMembership(), { ...removedMembership(), memberId: I }],
  ]) {
    f.state.response = () => response; await assert.rejects(f.bridge.listRemovedMemberships(), { code: 'community_invalid_response' });
  }
});

test('removed membership slot loads independently and exposes immutable ready empty and sanitized unavailable states', async () => {
  const f = await fixture(), c = f.bridge.createGroupController();
  assert.equal(c.getSnapshot().removedMemberships.status, 'idle'); await c.loadGroups();
  let resolve; f.state.response = () => new Promise(done => { resolve = done; });
  const pending = c.loadRemovedMemberships(); assert.equal(c.getSnapshot().removedMemberships.status, 'loading');
  assert.equal(c.getSnapshot().groups.status, 'ready'); resolve([removedMembership()]); await pending;
  const state = c.getSnapshot().removedMemberships; assert.equal(state.status, 'ready');
  assert.ok(Object.isFrozen(state.data[0].groupLabel)); assert.throws(() => state.data.push(removedMembership()), TypeError);
  f.state.response = () => []; await c.loadRemovedMemberships(); assert.equal(c.getSnapshot().removedMemberships.status, 'empty');
  f.state.response = () => json({ error: { code: 'Private account detail', message: 'Secret reason' } }, 503);
  await assert.rejects(c.loadRemovedMemberships(), { code: 'community_read_unavailable' });
  assert.equal(c.getSnapshot().removedMemberships.status, 'error'); assert.equal(c.getSnapshot().removedMemberships.data, null);
  assert.equal(c.getSnapshot().groups.status, 'ready'); assert.equal(JSON.stringify(c.getSnapshot()).includes('Secret reason'), false);
  assert.equal(JSON.stringify(c.getSnapshot()).includes('Private account detail'), false);
  f.state.response = () => [removedMembership()]; await c.loadRemovedMemberships(); assert.equal(c.getSnapshot().removedMemberships.status, 'ready');
});

test('removed membership reload discards older success and failure without changing independent slots', async () => {
  for (const lateError of [false, true]) {
    const pending = []; const f = await fixture(() => new Promise(resolve => pending.push(resolve))), c = f.bridge.createGroupController();
    const first = c.loadRemovedMemberships(), latest = c.loadRemovedMemberships();
    pending[1]([]); await latest;
    pending[0](lateError ? json({ error: { code: 'community_unavailable' } }, 503) : [removedMembership()]); await first;
    assert.equal(c.getSnapshot().removedMemberships.status, 'empty'); assert.deepEqual(c.getSnapshot().removedMemberships.data, []);
    assert.equal(c.getSnapshot().groups.status, 'idle');
  }
});

test('removed membership late reads and loaded snapshots clear on account resource controller or mounted-session disposal', async () => {
  for (const end of ['controller', 'resource', 'switch', 'mount']) {
    let mounted = true; const f = await fixture(() => [removedMembership()], () => mounted), c = f.bridge.createGroupController();
    await c.loadRemovedMemberships(); let resolve; f.state.response = () => new Promise(done => { resolve = done; });
    const read = c.loadRemovedMemberships();
    if (end === 'controller') c.dispose(); else if (end === 'resource') f.bridge.dispose();
    else if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else mounted = false;
    assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().removedMemberships.data, null);
    resolve([removedMembership()]); await assert.rejects(read, { code: 'session_changed' });
    await assert.rejects(c.loadRemovedMemberships(), { code: 'session_changed' }); assert.equal(f.calls.length, 2);
  }
});

test('removed membership pending observer disposal prevents transport and clears every slot', async () => {
  const f = await fixture(), c = f.bridge.createGroupController();
  c.subscribe(() => { if (c.getSnapshot().removedMemberships.status === 'loading') c.dispose(); });
  await assert.rejects(c.loadRemovedMemberships(), { code: 'session_changed' });
  assert.equal(f.calls.length, 0); assert.equal(c.getSnapshot().removedMemberships.data, null); assert.equal(c.getSnapshot().disposed, true);
});


const removalDetail = (actorRole = 'owner', targetRole = 'member', targetRevision = 7) => ({ ...group(), role: actorRole,
  members: [{ ...member(), role: actorRole }, { memberId: I, alias: 'Synthetic target', role: targetRole, revision: targetRevision }] });
async function removalFixture(actorRole = 'owner', targetRole = 'member') {
  const f = await fixture(call => call.path === `/groups/${G}` ? removalDetail(actorRole, targetRole) : responseFor(call));
  const controller = f.bridge.createGroupController(); await controller.loadDetail(G); return { ...f, controller };
}

test('group removal allows owner and admin role pairs with explicit confirmation and only the original revision in HTTP', async () => {
  for (const [ownRole, targetRole] of [['owner', 'member'], ['owner', 'admin'], ['admin', 'member']]) {
    const f = await removalFixture(ownRole, targetRole), c = f.controller;
    await c.loadGroups(); await c.loadSharing(G); await c.loadMotions(G);
    let resolve; f.state.response = () => new Promise(done => { resolve = done; });
    const pending = c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove');
    const state = c.getSnapshot(); assert.equal(state.command.status, 'pending'); assert.equal(state.command.kind, 'remove');
    assert.equal(state.command.memberId, I); assert.equal(state.command.removed, null); assert.equal(state.command.createdGroup, null);
    assert.equal(state.detail.status, 'stale'); assert.equal(state.motions.status, 'stale');
    assert.equal(state.groups.status, 'ready'); assert.equal(state.sharing.status, 'ready');
    const request = f.calls.at(-1); assert.equal(request.path, `/groups/${G}/members/${I}/remove`);
    assert.equal(request.method, 'POST'); assert.equal(request.key, 'remove'); assert.deepEqual(request.body, { expectedRevision: 7 });
    assert.equal(JSON.stringify(state.command).includes('Synthetic target'), false);
    resolve({ removed: true }); assert.deepEqual(await pending, { removed: true });
    assert.deepEqual(c.getSnapshot().command.removed, { removed: true }); assert.ok(Object.isFrozen(c.getSnapshot().command.removed));
    assert.equal(c.getSnapshot().detail.data, null); assert.equal(f.calls.length, 5);
  }
});

test('group removal requires matching ready detail readable target exact revision and explicit strict confirmation', async () => {
  const f = await removalFixture(), c = f.controller, before = f.calls.length;
  for (const [g, m, input] of [
    [G, I, { expectedRevision: 7 }], [G, I, { expectedRevision: 7, confirmed: false }],
    [G, I, { expectedRevision: 7, confirmed: true, accountId: M }], ['invalid', I, { expectedRevision: 7, confirmed: true }],
    [G, 'invalid', { expectedRevision: 7, confirmed: true }],
  ]) await assert.rejects(c.removeMember(g, m, input, 'invalid'), invalidInput);
  for (const [g, m, revision] of [[P, I, 7], [G, P, 7], [G, I, 6]])
    await assert.rejects(c.removeMember(g, m, { expectedRevision: revision, confirmed: true }, 'missing'), { code: 'community_removal_reload_required' });
  assert.equal(f.calls.length, before);
  const fresh = f.bridge.createGroupController();
  await assert.rejects(fresh.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'idle'), { code: 'community_removal_reload_required' });
  let resolve; f.state.response = () => new Promise(done => { resolve = done; }); const load = c.loadDetail(G);
  await assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'loading'), { code: 'community_removal_reload_required' });
  resolve(removalDetail()); await load; assert.equal(f.calls.length, before + 1);
});

test('group removal rejects owner targets self targets and disallowed actor roles before dispatch', async () => {
  for (const [ownRole, targetRole] of [['owner', 'owner'], ['admin', 'owner'], ['admin', 'admin'], ['member', 'member'], ['member', 'admin']]) {
    const f = await removalFixture(ownRole, targetRole), c = f.controller;
    await assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'role'), { code: 'community_forbidden' });
    assert.equal(f.calls.length, 1); assert.equal(c.getSnapshot().command.status, 'idle');
  }
  const f = await removalFixture();
  await assert.rejects(f.controller.removeMember(G, M, { expectedRevision: 1, confirmed: true }, 'self'), { code: 'community_forbidden' });
  assert.equal(f.calls.length, 1);
});

test('group removal preserves authoritative role revision membership and governed rejection with explicit stale reload', async () => {
  for (const [code, status, listStale] of [['community_not_found', 404, true], ['community_membership_changed', 409, true],
    ['stale_revision', 409, false], ['community_governed_action_required', 409, false]]) {
    const f = await removalFixture(), c = f.controller; await c.loadGroups(); await c.loadMotions(G);
    f.state.response = () => json({ error: { code, message: 'Private target detail' } }, status);
    await assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove'), error => error.code === code && !error.message.includes('Private'));
    const state = c.getSnapshot(); assert.equal(state.command.status, 'error'); assert.equal(state.command.intent.state, 'rejected');
    assert.equal(state.command.removed, null); assert.equal(state.detail.status, 'stale'); assert.equal(state.motions.status, 'stale');
    assert.equal(state.groups.status, listStale ? 'stale' : 'ready'); assert.equal(state.command.error.code, code);
    await assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'new'), { code: 'community_removal_reload_required' });
    assert.equal(f.calls.length, 4); assert.equal(JSON.stringify(state.command).includes('Private'), false);
  }
});

test('unknown group removal blocks replacement commands and retries exact original intent after the target disappears', async () => {
  const f = await removalFixture(), c = f.controller;
  await f.bridge.updateSharing(G, { flags: flags(), expectedRevision: 1 }, 'other');
  f.state.response = () => { throw new Error('lost'); };
  await assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove'), unknown);
  const original = c.getSnapshot().command;
  for (const attempt of [
    () => c.createGroup(create(), 'create'), () => c.updateSharing(G, { flags: flags(), expectedRevision: 1 }, 'share'),
    () => c.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'ballot'),
    () => c.removeMember(G, P, { expectedRevision: 1, confirmed: true }, 'replacement'), () => c.retry('other'),
  ]) await assert.rejects(attempt(), { code: 'community_removal_reconcile_required' });
  assert.equal(c.getSnapshot().command, original);
  f.state.response = () => ({ ...removalDetail(), members: [{ ...member(), role: 'owner' }] }); await c.loadDetail(G);
  assert.equal(c.getSnapshot().command.intent.state, 'unknown');
  f.state.response = () => json({ error: { code: 'community_not_found' } }, 404); await assert.rejects(c.retry('remove'), unknown);
  assert.equal(c.getSnapshot().command.intent.state, 'unknown');
  f.state.response = () => ({ removed: true }); assert.deepEqual(await c.retry('remove'), { removed: true });
  assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true); assert.equal(c.getSnapshot().command.status, 'confirmed');
  const requests = f.calls.filter(call => call.path.endsWith('/remove'));
  assert.equal(requests.length, 3); assert.ok(requests.every(call => call.raw === requests[0].raw && call.key === 'remove'));
  assert.deepEqual(requests[0].body, { expectedRevision: 7 });
});

test('group removal fences replacement and own retry before pending observers can dispatch another command', async () => {
  const f = await removalFixture(), c = f.controller; let resolve;
  f.state.response = () => new Promise(done => { resolve = done; }); const attempts = [];
  c.subscribe(() => { throw new Error('observer'); });
  c.subscribe(() => {
    if (c.getSnapshot().command.status !== 'pending') return;
    attempts.push(assert.rejects(c.createGroup(create(), 'replace'), { code: 'community_intent_in_flight' }));
    attempts.push(assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'replacement'), { code: 'community_intent_in_flight' }));
    const intent = c.inspectIntent('remove');
    if (intent) attempts.push(assert.rejects(c.retry('remove'), { code: 'community_intent_in_flight' }));
  });
  const pending = c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove'); resolve({ removed: true });
  await pending; await Promise.all(attempts); assert.ok(attempts.length > 0); assert.equal(f.calls.length, 2);
  assert.equal(c.getSnapshot().command.intent.state, 'confirmed');
});

test('group removal refuses foreign resource or sibling intents while retaining its own exact retries', async () => {
  const f = await removalFixture(), c = f.controller; await f.bridge.removeMember(G, I, 7, 'foreign');
  await assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'foreign'), { code: 'community_controller_intent_unavailable' });
  assert.throws(() => c.retry('foreign'), { code: 'community_controller_intent_unavailable' });
  await c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'own');
  const sibling = f.bridge.createGroupController();
  assert.throws(() => sibling.retry('own'), { code: 'community_controller_intent_unavailable' });
  await c.createGroup(create(), 'create'); assert.deepEqual(await c.retry('own'), { removed: true });
  assert.equal(c.getSnapshot().command.memberId, I); assert.equal(f.calls.at(-1).body.expectedRevision, 7);
});

test('group removal malformed success and unrecognized errors never publish private fields or a confirmed outcome', async () => {
  for (const response of [{ removed: false }, { removed: true, accountId: M }, { removed: true, reason: 'Private explanation' }]) {
    const f = await removalFixture(), c = f.controller; f.state.response = () => response;
    await assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove'), unknown);
    assert.equal(c.getSnapshot().command.intent.state, 'unknown'); assert.equal(c.getSnapshot().command.removed, null);
    assert.equal(JSON.stringify(c.getSnapshot().command).includes('Private'), false);
  }
  const f = await removalFixture(), c = f.controller;
  f.state.response = () => json({ error: { code: 'Private target alias', message: 'Private request contents' } }, 422);
  await assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove'), { code: 'community_removal_unavailable' });
  assert.equal(JSON.stringify(c.getSnapshot().command).includes('Private'), false);
});

test('group removal invalidates matching reads racing completion and leaves unrelated group detail alone on retry', async () => {
  const f = await removalFixture(), c = f.controller, resolve = [];
  f.state.response = () => new Promise(done => resolve.push(done));
  const command = c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove');
  const read = c.loadDetail(G); resolve[0]({ removed: true }); await command;
  resolve[1](removalDetail()); await read; assert.equal(c.getSnapshot().detail.status, 'stale');
  f.state.response = () => ({ ...removalDetail(), id: P }); await c.loadDetail(P); const other = c.getSnapshot().detail;
  f.state.response = () => ({ removed: true }); await c.retry('remove'); assert.equal(c.getSnapshot().detail, other);
});

test('group removal account controller resource and mount disposal clear result and fence late success', async () => {
  for (const end of ['controller', 'resource', 'switch', 'mount']) {
    let mounted = true; const f = await fixture(call => call.path === `/groups/${G}` ? removalDetail() : responseFor(call), () => mounted);
    const c = f.bridge.createGroupController(); await c.loadDetail(G); let resolve;
    f.state.response = () => new Promise(done => { resolve = done; });
    const pending = c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove');
    if (end === 'controller') c.dispose(); else if (end === 'resource') f.bridge.dispose();
    else if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else mounted = false;
    assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().command.memberId, null); assert.equal(c.getSnapshot().command.removed, null);
    resolve({ removed: true }); await assert.rejects(pending, { code: 'session_changed' });
    assert.throws(() => c.retry('remove'), { code: 'session_changed' }); assert.equal(f.calls.length, 2);
  }
});

test('group removal observer teardown prevents dispatch or returns no late confirmed result', async () => {
  for (const phase of ['pending', 'confirmed']) {
    const f = await removalFixture(), c = f.controller;
    c.subscribe(() => { if (c.getSnapshot().command.status === phase) c.dispose(); });
    await assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove'), { code: 'session_changed' });
    assert.equal(c.getSnapshot().command.removed, null); assert.equal(c.getSnapshot().command.memberId, null);
    assert.equal(f.calls.length, phase === 'pending' ? 1 : 2);
  }
});

test('group removal compatibility fence does not change existing sharing unknown to create behavior', async () => {
  const f = await fixture(() => { throw new Error('lost'); }), c = f.bridge.createGroupController();
  await assert.rejects(c.updateSharing(G, { flags: flags(), expectedRevision: 1 }, 'share'), unknown);
  f.state.response = () => group(); await c.createGroup(create(), 'create');
  assert.equal(c.getSnapshot().command.kind, 'create'); assert.equal(c.inspectIntent('share').state, 'unknown');
});


test('motion parser requires explicit current subject UUID or null and rejects non-removal linkage or private identity', async () => {
 const linked = { ...motion(), kind: 'removal', subjectMemberId: I };
 const f = await fixture(() => [linked]); assert.deepEqual(await f.bridge.listMotions(G), [linked]);
 f.state.response = () => [{ ...linked, subjectMemberId: null }]; assert.equal((await f.bridge.listMotions(G))[0].subjectMemberId, null);
 const { subjectMemberId: _subject, ...missing } = linked;
 for (const value of [missing, { ...linked, subjectMemberId: 'invalid' }, { ...linked, subjectMemberId: M, kind: 'friend' },
   { ...linked, kind: 'growth' }, { ...linked, subjectAccountId: M }, { ...linked, voterIds: [M] }, { ...linked, reason: 'Private explanation' }]) {
  f.state.response = () => [value]; await assert.rejects(f.bridge.listMotions(G), { code: 'community_invalid_response' });
 }
});

test('motion create ballot and finalization consume the same current-link projection without changing request revisions', async () => {
 const linked = { ...motion(), kind: 'removal', subjectMemberId: I }, f = await fixture(() => linked);
 assert.equal((await f.bridge.createMotion(G, { kind: 'removal', memberId: I, expectedRevision: 4 }, 'create')).subjectMemberId, I);
 assert.deepEqual(f.calls[0].body, { kind: 'removal', memberId: I, expectedRevision: 4 });
 assert.equal((await f.bridge.setBallot(G, P, { choice: 'yes', expectedRevision: 2 }, 'vote')).subjectMemberId, I);
 assert.deepEqual(f.calls[1].body, { choice: 'yes', expectedRevision: 2 });
 f.state.response = () => ({ ...linked, state: 'passed', subjectMemberId: null });
 const result = await f.bridge.finalizeMotion(G, P, 'finalize'); assert.equal(result.subjectMemberId, null); assert.equal(result.state, 'passed');
 assert.deepEqual(f.calls[2].body, {});
});

test('motion linkage reload never infers a removed member and contradictory mutation projection retains exact unknown retry', async () => {
 const linked = { ...motion(), kind: 'removal', subjectMemberId: I }, f = await fixture(() => [linked]), c = f.bridge.createGroupController();
 await c.loadMotions(G); assert.equal(c.getSnapshot().motions.data[0].subjectMemberId, I);
 f.state.response = () => [{ ...linked, subjectMemberId: null }]; await c.loadMotions(G);
 assert.equal(c.getSnapshot().motions.data[0].state, 'open'); assert.equal(c.getSnapshot().motions.data[0].subjectMemberId, null);
 assert.equal(c.getSnapshot().removedMemberships.status, 'idle');
 f.state.response = () => ({ ...linked, kind: 'friend' });
 await assert.rejects(f.bridge.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'vote'), unknown);
 assert.equal(f.bridge.inspectIntent('vote').state, 'unknown');
 f.state.response = () => linked; await f.bridge.retry('vote');
 assert.equal(f.calls.at(-1).raw, f.calls.at(-2).raw); assert.equal(f.calls.at(-1).key, 'vote');
 assert.equal(f.bridge.inspectIntent('vote').originalEffectUnknown, true);
});


const removalPolicy = () => ({ kind: 'matched', intent: 'supportive_community', capacity: 12, revision: 4 });
const removalMotion = () => ({ ...motion(), kind: 'removal', subjectMemberId: I });
function governanceResponse(call) {
 if (call.path === `/groups/${G}`) return removalDetail('member');
 if (call.path.endsWith('/policy')) return removalPolicy();
 if (call.path.endsWith('/motions')) return call.method === 'GET' ? [removalMotion()] : removalMotion();
 if (call.path.endsWith('/finalize')) return { ...removalMotion(), state: 'passed', subjectMemberId: null };
 return responseFor(call);
}
async function governanceFixture() {
 const f = await fixture(governanceResponse), controller = f.bridge.createGroupController();
 await controller.loadDetail(G); await controller.loadPolicy(G); return { ...f, controller };
}

test('group policy read is independent immutable latest-request fenced and sanitizes unavailable errors', async () => {
 const f = await governanceFixture(), c = f.controller; assert.equal(c.getSnapshot().policy.data.revision, 4);
 assert.ok(Object.isFrozen(c.getSnapshot().policy.data)); const detail = c.getSnapshot().detail;
 const pending = []; f.state.response = () => new Promise(resolve => pending.push(resolve));
 const first = c.loadPolicy(G), second = c.loadPolicy(G); assert.equal(c.getSnapshot().policy.status, 'loading');
 pending[1]({ ...removalPolicy(), revision: 5 }); await second;
 pending[0](json({ error: { code: 'Private error' } }, 503)); await first;
 assert.equal(c.getSnapshot().policy.data.revision, 5); assert.equal(c.getSnapshot().detail, detail);
 f.state.response = () => json({ error: { code: 'Private error', message: 'Private body' } }, 503);
 await assert.rejects(c.loadPolicy(G), { code: 'community_read_unavailable' });
 assert.equal(c.getSnapshot().policy.status, 'error'); assert.equal(c.getSnapshot().policy.data, null);
 assert.equal(JSON.stringify(c.getSnapshot()).includes('Private'), false);
});

test('ordinary group member creates a confirmed removal motion using policy revision rather than target member revision', async () => {
 const f = await governanceFixture(), c = f.controller; await c.loadMotions(G);
 const detail = c.getSnapshot().detail, policy = c.getSnapshot().policy;
 let resolve; f.state.response = () => new Promise(done => { resolve = done; });
 const pending = c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'motion');
 assert.equal(c.getSnapshot().command.kind, 'removal_motion'); assert.equal(c.getSnapshot().command.motion, null);
 assert.equal(c.getSnapshot().command.memberId, I); assert.equal(c.getSnapshot().command.removed, null);
 assert.equal(c.getSnapshot().motions.status, 'stale'); assert.equal(c.getSnapshot().detail, detail); assert.equal(c.getSnapshot().policy, policy);
 assert.deepEqual(f.calls.at(-1).body, { kind: 'removal', memberId: I, expectedRevision: 4 });
 resolve(removalMotion()); assert.deepEqual(await pending, removalMotion());
 assert.deepEqual(c.getSnapshot().command.motion, removalMotion()); assert.ok(Object.isFrozen(c.getSnapshot().command.motion));
 assert.equal(c.getSnapshot().command.removed, null); assert.equal(c.getSnapshot().detail, detail);
 assert.equal(JSON.stringify(c.getSnapshot().command).includes('Synthetic target'), false);
});

test('removal motion creation requires strict confirmation same-group policy and roster with an ordinary nonself target', async () => {
 const f = await governanceFixture(), c = f.controller, before = f.calls.length;
 for (const input of [{ expectedRevision: 4 }, { expectedRevision: 4, confirmed: false }, { expectedRevision: 4, confirmed: true, memberRevision: 7 }])
  await assert.rejects(c.createRemovalMotion(G, I, input, 'bad'), invalidInput);
 for (const [g, m, revision] of [[G, I, 7], [P, I, 4], [G, P, 4]])
  await assert.rejects(c.createRemovalMotion(g, m, { expectedRevision: revision, confirmed: true }, 'bad'), { code: 'community_removal_reload_required' });
 await assert.rejects(c.createRemovalMotion(G, M, { expectedRevision: 4, confirmed: true }, 'self'), { code: 'community_forbidden' });
 assert.equal(f.calls.length, before);
 for (const role of ['owner', 'admin']) {
  f.state.response = () => removalDetail('member', role); await c.loadDetail(G);
  await assert.rejects(c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, role), { code: 'community_forbidden' });
 }
 const fresh = f.bridge.createGroupController(); await assert.rejects(fresh.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'idle'), { code: 'community_removal_reload_required' });
 f.state.response = governanceResponse; await c.loadDetail(G); await c.loadPolicy(P);
 await assert.rejects(c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'policy-group'), { code: 'community_removal_reload_required' });
 assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('removal motion server tenure quota electorate and policy-revision rejections remain authoritative and require only affected reloads', async () => {
 for (const [code, status] of [['community_motion_tenure_required', 403], ['community_motion_quota', 429],
   ['community_motion_cooldown', 409], ['community_electorate_unavailable', 409], ['stale_revision', 409], ['community_not_found', 404]]) {
  const f = await governanceFixture(), c = f.controller; await c.loadMotions(G);
  f.state.response = () => json({ error: { code, message: 'Private explanation' } }, status);
  await assert.rejects(c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'motion'), error => error.code === code && !error.message.includes('Private'));
  const state = c.getSnapshot(); assert.equal(state.command.motion, null); assert.equal(state.motions.status, 'stale');
  assert.equal(state.policy.status, ['stale_revision', 'community_not_found'].includes(code) ? 'stale' : 'ready');
  assert.equal(state.detail.status, code === 'community_not_found' ? 'stale' : 'ready');
  assert.equal(state.command.error.code, code); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
 }
});

test('removal finalization requires selected removal motion and explicit confirmation but sends no invented revision', async () => {
 const f = await governanceFixture(), c = f.controller;
 await assert.rejects(c.finalizeRemovalMotion(G, P, { confirmed: true }, 'idle'), { code: 'community_removal_reload_required' });
 await c.loadMotions(G);
 for (const input of [{}, { confirmed: false }, { confirmed: true, expectedRevision: 1 }])
  await assert.rejects(c.finalizeRemovalMotion(G, P, input, 'invalid'), invalidInput);
 await assert.rejects(c.finalizeRemovalMotion(G, I, { confirmed: true }, 'missing'), { code: 'community_removal_reload_required' });
 f.state.response = () => [motion()]; await c.loadMotions(G);
 await assert.rejects(c.finalizeRemovalMotion(G, P, { confirmed: true }, 'friend'), { code: 'community_removal_reload_required' });
 f.state.response = () => [{ ...removalMotion(), subjectMemberId: null, ownBallot: null }]; await c.loadMotions(G);
 f.state.response = () => json({ error: { code: 'community_motion_not_due' } }, 409);
 await assert.rejects(c.finalizeRemovalMotion(G, P, { confirmed: true }, 'finalize'), { code: 'community_motion_not_due' });
 assert.deepEqual(f.calls.at(-1).body, {}); assert.equal(c.getSnapshot().command.memberId, null);
 f.state.response = () => ({ ...removalMotion(), state: 'review_pending', subjectMemberId: null });
 const result = await c.retry('finalize'); assert.equal(result.state, 'review_pending');
 assert.equal(c.getSnapshot().command.kind, 'finalize_removal'); assert.equal(c.getSnapshot().command.motion.state, 'review_pending');
 assert.equal(c.getSnapshot().command.removed, null); assert.equal(c.getSnapshot().removedMemberships.status, 'idle');
 assert.equal(c.getSnapshot().policy.status, 'ready'); assert.equal(c.getSnapshot().detail.status, 'stale');
});

test('removal motion unknown outcomes retain exact original retry after current roster policy and motions disappear', async () => {
 for (const operation of ['create', 'finalize']) {
  const f = await governanceFixture(), c = f.controller; await c.loadMotions(G);
  f.state.response = () => { throw new Error('lost'); };
  const input = { expectedRevision: 4, confirmed: true };
  const action = () => operation === 'create' ? c.createRemovalMotion(G, I, input, 'original') : c.finalizeRemovalMotion(G, P, { confirmed: true }, 'original');
  await assert.rejects(action(), unknown); input.expectedRevision = 9; const retained = c.getSnapshot().command;
  for (const next of [() => c.createRemovalMotion(G, I, input, 'new'), () => c.finalizeRemovalMotion(G, P, { confirmed: true }, 'new'),
    () => c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'direct'), () => c.createGroup(create(), 'group'),
    () => c.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'ballot')])
   await assert.rejects(next(), { code: 'community_removal_reconcile_required' });
  assert.equal(c.getSnapshot().command, retained);
  f.state.response = call => call.path.endsWith('/motions') ? [] : call.path.endsWith('/policy') ? { ...removalPolicy(), revision: 9 } : { ...removalDetail('member'), members: [member()] };
  await c.loadDetail(G); await c.loadPolicy(G); await c.loadMotions(G);
  f.state.response = () => ({ ...removalMotion(), subjectMemberId: null }); await c.retry('original');
  assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true); assert.equal(c.getSnapshot().command.motion.subjectMemberId, null);
  const requests = f.calls.filter(call => call.method === 'POST'); assert.equal(requests.length, 2);
  assert.equal(requests[0].raw, requests[1].raw); assert.equal(requests[1].key, 'original');
  assert.deepEqual(requests[1].body, operation === 'create' ? { kind: 'removal', memberId: I, expectedRevision: 4 } : {});
 }
});

test('removal motion response guards stay inside the ledger and survive exact retries independently of new selections', async () => {
 for (const operation of ['create', 'finalize']) {
  const f = await governanceFixture(), c = f.controller; await c.loadMotions(G);
  f.state.response = () => motion();
  const pending = operation === 'create' ? c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'guard') : c.finalizeRemovalMotion(G, P, { confirmed: true }, 'guard');
  await assert.rejects(pending, unknown); assert.equal(f.bridge.inspectIntent('guard').state, 'unknown'); assert.equal(c.getSnapshot().command.motion, null);
  if (operation === 'create') {
   f.state.response = () => ({ ...removalDetail('member'), members: [{ ...member(), memberId: P }] }); await c.loadDetail(G);
   f.state.response = () => ({ ...removalMotion(), subjectMemberId: P }); await assert.rejects(c.retry('guard'), unknown);
   assert.equal(f.bridge.inspectIntent('guard').state, 'unknown');
  }
  f.state.response = () => ({ ...removalMotion(), subjectMemberId: null }); await c.retry('guard');
  assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true); assert.equal(c.getSnapshot().command.motion.subjectMemberId, null);
  assert.equal(c.getSnapshot().command.removed, null);
 }
});

test('removal motion commands cannot adopt foreign or sibling ledger keys and direct-removal uncertainty fences them', async () => {
 const f = await governanceFixture(), c = f.controller;
 await f.bridge.createMotion(G, { kind: 'removal', memberId: I, expectedRevision: 4 }, 'foreign');
 await assert.rejects(c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'foreign'), { code: 'community_controller_intent_unavailable' });
 assert.throws(() => c.retry('foreign'), { code: 'community_controller_intent_unavailable' });
 await c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'owned');
 assert.throws(() => f.bridge.createGroupController().retry('owned'), { code: 'community_controller_intent_unavailable' });
 await c.loadMotions(G); await f.bridge.finalizeMotion(G, P, 'foreign-finalize');
 await assert.rejects(c.finalizeRemovalMotion(G, P, { confirmed: true }, 'foreign-finalize'), { code: 'community_controller_intent_unavailable' });
 const direct = await removalFixture(); direct.state.response = () => { throw new Error('lost'); };
 await assert.rejects(direct.controller.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'direct'), unknown);
 await assert.rejects(direct.controller.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'motion'), { code: 'community_removal_reconcile_required' });
 await assert.rejects(direct.controller.finalizeRemovalMotion(G, P, { confirmed: true }, 'finalize'), { code: 'community_removal_reconcile_required' });
});

test('removal motion pending observers cannot replace original intent or retry before dispatch completes', async () => {
 for (const operation of ['create', 'finalize']) {
  const f = await governanceFixture(), c = f.controller; await c.loadMotions(G); let resolve;
  f.state.response = () => new Promise(done => { resolve = done; }); const attempts = [];
  c.subscribe(() => {
   if (c.getSnapshot().command.status !== 'pending') return;
   attempts.push(assert.rejects(c.createGroup(create(), 'replacement'), { code: 'community_intent_in_flight' }));
   attempts.push(assert.rejects(c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'direct'), { code: 'community_intent_in_flight' }));
   if (c.inspectIntent('original')) attempts.push(assert.rejects(c.retry('original'), { code: 'community_intent_in_flight' }));
  });
  const pending = operation === 'create' ? c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'original') : c.finalizeRemovalMotion(G, P, { confirmed: true }, 'original');
  resolve(removalMotion()); await pending; await Promise.all(attempts);
  assert.ok(attempts.length > 0); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
 }
});

test('removal motion stale policy rejection supersedes racing policy read without automatically reloading', async () => {
 const f = await governanceFixture(), c = f.controller, pending = [];
 f.state.response = () => new Promise(resolve => pending.push(resolve));
 const command = c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'motion'), read = c.loadPolicy(G);
 pending[0](json({ error: { code: 'stale_revision' } }, 409)); await assert.rejects(command, { code: 'stale_revision' });
 pending[1]({ ...removalPolicy(), revision: 5 }); await read;
 assert.equal(c.getSnapshot().policy.status, 'stale'); assert.equal(c.getSnapshot().detail.status, 'ready'); assert.equal(f.calls.length, 4);
});

test('removal motion account resource controller and mounted-session disposal clear policy and fence late results', async () => {
 for (const operation of ['create', 'finalize']) for (const end of ['controller', 'resource', 'switch', 'mount']) {
  let mounted = true; const f = await fixture(governanceResponse, () => mounted), c = f.bridge.createGroupController();
  await c.loadDetail(G); await c.loadPolicy(G); await c.loadMotions(G); const pending = [];
  f.state.response = () => new Promise(resolve => pending.push(resolve));
  const command = operation === 'create' ? c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'original') : c.finalizeRemovalMotion(G, P, { confirmed: true }, 'original');
  const read = c.loadPolicy(G);
  if (end === 'controller') c.dispose(); else if (end === 'resource') f.bridge.dispose();
  else if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else mounted = false;
  assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().policy.data, null); assert.equal(c.getSnapshot().command.motion, null);
  pending[0](removalMotion()); pending[1](removalPolicy());
  await assert.rejects(command, { code: 'session_changed' }); await assert.rejects(read, { code: 'session_changed' });
  assert.throws(() => c.retry('original'), { code: 'session_changed' });
 }
});

test('removal motion observer teardown prevents dispatch and cannot return a late confirmed motion', async () => {
 for (const operation of ['create', 'finalize']) for (const phase of ['pending', 'confirmed']) {
  const f = await governanceFixture(), c = f.controller; await c.loadMotions(G);
  c.subscribe(() => { if (c.getSnapshot().command.status === phase) c.dispose(); });
  const command = operation === 'create' ? c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'original') : c.finalizeRemovalMotion(G, P, { confirmed: true }, 'original');
  await assert.rejects(command, { code: 'session_changed' }); assert.equal(c.getSnapshot().command.motion, null);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, phase === 'pending' ? 0 : 1);
 }
});

const growthMotion = () => ({ ...motion(), kind: 'growth', places: 3 });
function growthResponse(call) {
 if (call.path.endsWith('/motions')) return call.method === 'GET' ? [growthMotion()] : growthMotion();
 if (call.path.endsWith('/finalize')) return { ...growthMotion(), state: 'passed' };
 if (call.path.endsWith('/ballot')) return { ...growthMotion(), ownBallot: call.body.choice, ballotRevision: 2 };
 return governanceResponse(call);
}
async function growthFixture() {
 const f = await fixture(growthResponse), controller = f.bridge.createGroupController();
 await controller.loadDetail(G); await controller.loadPolicy(G); await controller.loadMotions(G);
 return { ...f, controller };
}

test('growth parser requires stored places only for growth and rejects missing contradictory fractional and private projections', async () => {
 const f = await fixture(() => [growthMotion()]);
 assert.equal((await f.bridge.listMotions(G))[0].places, 3);
 const { places: omitted, ...missing } = growthMotion();
 for (const value of [missing, ...[null, 0, 5, 1.5, '3'].map(places => ({ ...growthMotion(), places })),
  { ...motion(), places: 1 }, { ...removalMotion(), places: 1 }, { ...growthMotion(), sponsorAccountId: M }, { ...growthMotion(), subjectMemberId: I }]) {
  f.state.response = () => [value]; await assert.rejects(f.bridge.listMotions(G), { code: 'community_invalid_response' });
 }
 f.state.response = () => [motion(), { ...removalMotion(), id: G }]; assert.deepEqual((await f.bridge.listMotions(G)).map(value => value.places), [null, null]);
});

test('ordinary growth sponsor confirms places with policy revision and preserves detail without optimistic capacity or membership', async () => {
 const f = await growthFixture(), c = f.controller, detail = c.getSnapshot().detail, policy = c.getSnapshot().policy;
 assert.equal(detail.data.role, 'member'); let resolve;
 f.state.response = () => new Promise(done => { resolve = done; });
 const pending = c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'growth');
 assert.equal(c.getSnapshot().command.kind, 'growth_motion'); assert.equal(c.getSnapshot().command.motion, null);
 assert.equal(c.getSnapshot().motions.status, 'stale'); assert.equal(c.getSnapshot().detail, detail); assert.equal(c.getSnapshot().policy, policy);
 assert.deepEqual(f.calls.at(-1).body, { kind: 'growth', places: 3, expectedRevision: 4 });
 resolve(growthMotion()); assert.deepEqual(await pending, growthMotion());
 assert.ok(Object.isFrozen(c.getSnapshot().command.motion)); assert.equal(c.getSnapshot().command.motion.places, 3);
 assert.equal(c.getSnapshot().command.removed, null); assert.equal(c.getSnapshot().detail, detail); assert.equal(c.getSnapshot().policy, policy);
});

test('growth create requires explicit bounded places confirmation and same-group current policy revision before HTTP', async () => {
 const f = await growthFixture(), c = f.controller, before = f.calls.length;
 for (const input of [{ places: 3, expectedRevision: 4 }, { places: 3, expectedRevision: 4, confirmed: false },
  { places: 3, expectedRevision: 4, confirmed: true, role: 'owner' }, ...[0, 5, 1.5, '3', null].map(places => ({ places, expectedRevision: 4, confirmed: true }))])
  await assert.rejects(c.createGrowthMotion(G, input, 'bad'), invalidInput);
 for (const [groupId, expectedRevision] of [[P, 4], [G, 7], [G, 1]])
  await assert.rejects(c.createGrowthMotion(groupId, { places: 3, expectedRevision, confirmed: true }, 'bad'), { code: 'community_growth_reload_required' });
 assert.equal(f.calls.length, before);
 const idle = f.bridge.createGroupController();
 await assert.rejects(idle.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'idle'), { code: 'community_growth_reload_required' });
});

test('growth tenure quota capacity and stale policy errors remain server decisions with sanitized affected state', async () => {
 for (const [code, status] of [['community_motion_tenure_required', 403], ['community_motion_quota', 429], ['community_growth_unavailable', 409],
  ['community_capacity_unavailable', 409], ['community_motion_cooldown', 409], ['community_electorate_unavailable', 409], ['stale_revision', 409], ['community_not_found', 404]]) {
  const f = await growthFixture(), c = f.controller;
  f.state.response = () => json({ error: { code, message: 'Private explanation' } }, status);
  await assert.rejects(c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'growth'), { code });
  const state = c.getSnapshot(); assert.equal(state.command.motion, null); assert.equal(state.motions.status, 'stale');
  assert.equal(state.policy.status, ['stale_revision', 'community_not_found'].includes(code) ? 'stale' : 'ready');
  assert.equal(state.detail.status, code === 'community_not_found' ? 'stale' : 'ready'); assert.equal(JSON.stringify(state).includes('Private'), false);
 }
});

test('growth ballot uses own ballot revision without null-based eligibility guesses and finalization keeps empty HTTP body', async () => {
 const f = await growthFixture(), c = f.controller;
 assert.equal(c.getSnapshot().motions.data[0].ownBallot, null); assert.equal(c.getSnapshot().motions.data[0].subjectMemberId, null);
 f.state.response = () => json({ error: { code: 'community_not_found' } }, 404);
 await assert.rejects(c.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'denied-vote'), { code: 'community_not_found' });
 f.state.response = growthResponse; await c.loadMotions(G);
 await c.setBallot(G, P, { choice: 'yes', expectedRevision: 1 }, 'vote');
 assert.deepEqual(f.calls.at(-1).body, { choice: 'yes', expectedRevision: 1 });
 await c.loadMotions(G);
 for (const input of [{}, { confirmed: false }, { confirmed: true, expectedRevision: 4 }])
  await assert.rejects(c.finalizeGrowthMotion(G, P, input, 'bad'), invalidInput);
 for (const [groupId, motionId] of [[P, P], [G, I]])
  await assert.rejects(c.finalizeGrowthMotion(groupId, motionId, { confirmed: true }, 'bad'), { code: 'community_growth_reload_required' });
 f.state.response = () => [removalMotion(), { ...motion(), id: I }]; await c.loadMotions(G);
 await assert.rejects(c.finalizeGrowthMotion(G, P, { confirmed: true }, 'wrong-kind'), { code: 'community_growth_reload_required' });
 f.state.response = growthResponse; await c.loadMotions(G);
 f.state.response = () => json({ error: { code: 'community_motion_not_due' } }, 409);
 await assert.rejects(c.finalizeGrowthMotion(G, P, { confirmed: true }, 'finish'), { code: 'community_motion_not_due' });
 assert.deepEqual(f.calls.at(-1).body, {}); assert.equal(c.getSnapshot().policy.status, 'stale');
 f.state.response = () => ({ ...growthMotion(), state: 'expired' }); await c.retry('finish');
 assert.equal(c.getSnapshot().command.motion.state, 'expired'); assert.equal(c.getSnapshot().command.motion.places, 3);
 assert.equal(c.getSnapshot().detail.status, 'ready'); assert.equal(c.getSnapshot().removedMemberships.status, 'idle');
});

test('growth passed finalization invalidates racing policy and motions while preserving roster until explicit reload', async () => {
 const f = await growthFixture(), c = f.controller, detail = c.getSnapshot().detail, pending = [];
 f.state.response = () => new Promise(resolve => pending.push(resolve));
 const command = c.finalizeGrowthMotion(G, P, { confirmed: true }, 'finish'), policyRead = c.loadPolicy(G), motionsRead = c.loadMotions(G);
 pending[0]({ ...growthMotion(), state: 'passed' }); await command;
 pending[1]({ ...removalPolicy(), capacity: 15, revision: 5 }); pending[2]([growthMotion()]); await Promise.all([policyRead, motionsRead]);
 assert.equal(c.getSnapshot().policy.status, 'stale'); assert.equal(c.getSnapshot().motions.status, 'stale'); assert.equal(c.getSnapshot().detail, detail);
 f.state.response = () => ({ ...removalPolicy(), capacity: 15, revision: 5 }); await c.loadPolicy(G);
 assert.equal(c.getSnapshot().policy.data.capacity, 15); assert.equal(c.getSnapshot().detail, detail);
});

test('growth original unknown create and finalize guards survive changed selections and retry exact original intent', async () => {
 for (const operation of ['create', 'finalize']) {
  const f = await growthFixture(), c = f.controller, input = { places: 3, expectedRevision: 4, confirmed: true };
  f.state.response = () => motion();
  await assert.rejects(operation === 'create' ? c.createGrowthMotion(G, input, 'original') : c.finalizeGrowthMotion(G, P, { confirmed: true }, 'original'), unknown);
  assert.equal(f.bridge.inspectIntent('original').state, 'unknown'); assert.equal(c.getSnapshot().command.motion, null);
  input.places = 4; input.expectedRevision = 8;
  f.state.response = call => call.path.endsWith('/motions') ? [] : { ...removalPolicy(), revision: 8 }; await c.loadMotions(G); await c.loadPolicy(G);
  for (const action of [() => c.createGrowthMotion(G, input, 'new'), () => c.finalizeGrowthMotion(G, P, { confirmed: true }, 'new'),
   () => c.createGroup(create(), 'group'), () => c.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'remove'),
   () => c.createRemovalMotion(G, I, { expectedRevision: 8, confirmed: true }, 'removal'), () => c.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'vote')])
   await assert.rejects(action(), { code: 'community_growth_reconcile_required' });
  f.state.response = () => ({ ...growthMotion(), places: 4 }); await assert.rejects(c.retry('original'), unknown);
  assert.equal(f.bridge.inspectIntent('original').state, 'unknown');
  f.state.response = () => growthMotion(); await c.retry('original');
  assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true); assert.equal(c.getSnapshot().command.motion.places, 3);
  const requests = f.calls.filter(call => call.method === 'POST'); assert.equal(requests.length, 3);
  assert.ok(requests.every(call => call.raw === requests[0].raw && call.key === 'original'));
  assert.deepEqual(requests[2].body, operation === 'create' ? { kind: 'growth', places: 3, expectedRevision: 4 } : {});
 }
});

test('growth commands reject foreign sibling and unfinished generic intents while retaining direct-removal fences', async () => {
 const f = await growthFixture(), c = f.controller;
 await f.bridge.createMotion(G, { kind: 'growth', places: 3, expectedRevision: 4 }, 'foreign');
 await assert.rejects(c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'foreign'), { code: 'community_controller_intent_unavailable' });
 assert.throws(() => c.retry('foreign'), { code: 'community_controller_intent_unavailable' });
 await c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'owned');
 assert.throws(() => f.bridge.createGroupController().retry('owned'), { code: 'community_controller_intent_unavailable' });
 await c.loadMotions(G); await f.bridge.finalizeMotion(G, P, 'foreign-finalize');
 await assert.rejects(c.finalizeGrowthMotion(G, P, { confirmed: true }, 'foreign-finalize'), { code: 'community_controller_intent_unavailable' });
 const direct = await removalFixture(); direct.state.response = () => { throw new Error('lost'); };
 await assert.rejects(direct.controller.removeMember(G, I, { expectedRevision: 7, confirmed: true }, 'direct'), unknown);
 await assert.rejects(direct.controller.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'growth'), { code: 'community_removal_reconcile_required' });
 const generic = await growthFixture();
 await generic.controller.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'old-growth');
 generic.state.response = () => { throw new Error('lost'); };
 await assert.rejects(generic.controller.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'ballot'), unknown);
 await assert.rejects(generic.controller.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'growth'), { code: 'community_growth_reconcile_required' });
 await assert.rejects(generic.controller.retry('old-growth'), { code: 'community_growth_reconcile_required' });
});

test('growth pending observers cannot replace commands or retry before original HTTP dispatch completes', async () => {
 for (const operation of ['create', 'finalize']) {
  const f = await growthFixture(), c = f.controller; let resolve; const attempts = [];
  f.state.response = () => new Promise(done => { resolve = done; });
  c.subscribe(() => {
   if (c.getSnapshot().command.status !== 'pending') return;
   attempts.push(assert.rejects(c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'new'), { code: 'community_intent_in_flight' }));
   attempts.push(assert.rejects(c.createGroup(create(), 'group'), { code: 'community_intent_in_flight' }));
   if (c.inspectIntent('original')) attempts.push(assert.rejects(c.retry('original'), { code: 'community_intent_in_flight' }));
  });
  const command = operation === 'create' ? c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'original') : c.finalizeGrowthMotion(G, P, { confirmed: true }, 'original');
  resolve(growthMotion()); await command; await Promise.all(attempts);
  assert.ok(attempts.length > 0); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
 }
});

test('growth account resource controller and mounted-session teardown fence reads and late command results', async () => {
 for (const operation of ['create', 'finalize']) for (const end of ['controller', 'resource', 'switch', 'mount']) {
  let mounted = true; const f = await fixture(growthResponse, () => mounted), c = f.bridge.createGroupController();
  await c.loadPolicy(G); await c.loadMotions(G); const pending = [];
  f.state.response = () => new Promise(resolve => pending.push(resolve));
  const command = operation === 'create' ? c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'original') : c.finalizeGrowthMotion(G, P, { confirmed: true }, 'original');
  const read = c.loadPolicy(G);
  if (end === 'controller') c.dispose(); else if (end === 'resource') f.bridge.dispose();
  else if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else mounted = false;
  assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().command.motion, null); assert.equal(c.getSnapshot().policy.data, null);
  pending[0](growthMotion()); pending[1](removalPolicy());
  await assert.rejects(command, { code: 'session_changed' }); await assert.rejects(read, { code: 'session_changed' });
  assert.throws(() => c.retry('original'), { code: 'session_changed' });
 }
});

test('growth observer teardown prevents dispatch and suppresses late confirmed publication', async () => {
 for (const phase of ['pending', 'confirmed']) {
  const f = await growthFixture(), c = f.controller;
  c.subscribe(() => { if (c.getSnapshot().command.status === phase) c.dispose(); });
  await assert.rejects(c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'growth'), { code: 'session_changed' });
  assert.equal(c.getSnapshot().command.motion, null); assert.equal(f.calls.filter(call => call.method === 'POST').length, phase === 'pending' ? 0 : 1);
 }
});

const membershipDetail = (role = 'owner') => ({ ...removalDetail(role), revision: 4,
 members: [{ ...member(), role, revision: 7 }, { memberId: I, alias: 'Other member', role: 'member', revision: 9 }] });
function membershipResponse(call) {
 if (call.path === `/groups/${G}`) return membershipDetail();
 if (call.path.endsWith('/me') && call.method === 'PATCH') return { ...member(), alias: call.body.alias, role: 'owner', revision: 8 };
 return growthResponse(call);
}
async function membershipFixture(role = 'owner') {
 const f = await fixture(call => call.path === `/groups/${G}` ? membershipDetail(role) : membershipResponse(call)), controller = f.bridge.createGroupController();
 await controller.loadDetail(G); await controller.loadGroups(); await controller.loadSharing(G); await controller.loadPolicy(G); await controller.loadMotions(G);
 return { ...f, controller };
}
function membershipAction(c, kind, key = 'membership') {
 if (kind === 'alias') return c.updateAlias(G, { alias: 'New alias', expectedRevision: 7 }, key);
 if (kind === 'leave') return c.leave(G, { confirmed: true }, key);
 return c.closeGroup(G, { expectedRevision: 4, confirmed: true }, key);
}
const membershipOutcome = kind => kind === 'alias' ? { ...member(), alias: 'New alias', role: 'owner', revision: 8 } : kind === 'leave' ? { left: true } : { closed: true };

test('own alias uses member revision for every role and exposes only a validated returned member after confirmation', async () => {
 for (const role of ['owner', 'admin', 'member']) {
  const f = await membershipFixture(role), c = f.controller, policy = c.getSnapshot().policy, sharingState = c.getSnapshot().sharing;
  const before = f.calls.length;
  await assert.rejects(c.updateAlias(G, { alias: 'New alias', expectedRevision: 4 }, 'group-revision'), { code: 'community_membership_reload_required' });
  assert.equal(f.calls.length, before); let resolve;
  f.state.response = () => new Promise(done => { resolve = done; });
  const command = c.updateAlias(G, { alias: 'New alias', expectedRevision: 7 }, 'alias');
  assert.deepEqual(f.calls.at(-1).body, { alias: 'New alias', expectedRevision: 7 }); assert.equal(f.calls.at(-1).method, 'PATCH');
  assert.equal(c.getSnapshot().detail.status, 'stale'); assert.equal(c.getSnapshot().command.membershipResult, null);
  assert.equal(JSON.stringify(c.getSnapshot()).includes('New alias'), false);
  const result = { ...membershipOutcome('alias'), role }; resolve(result); assert.deepEqual(await command, result);
  assert.deepEqual(c.getSnapshot().command.membershipResult, { kind: 'alias', value: result }); assert.ok(Object.isFrozen(c.getSnapshot().command.membershipResult.value));
  assert.equal(c.getSnapshot().policy, policy); assert.equal(c.getSnapshot().sharing, sharingState); assert.equal(c.getSnapshot().groups.status, 'ready');
 }
});

test('own alias rejects missing own row wrong group stale revision and extra authority before HTTP', async () => {
 const f = await membershipFixture(), c = f.controller, before = f.calls.length;
 for (const input of [{ alias: '', expectedRevision: 7 }, { alias: 'Name', expectedRevision: 0 }, { alias: 'Name', expectedRevision: 7, memberId: I }])
  await assert.rejects(c.updateAlias(G, input, 'invalid'), invalidInput);
 await assert.rejects(c.updateAlias(P, { alias: 'Name', expectedRevision: 7 }, 'other-group'), { code: 'community_membership_reload_required' });
 assert.equal(f.calls.length, before);
 f.state.response = () => ({ ...membershipDetail(), members: [membershipDetail().members[1]] }); await c.loadDetail(G);
 await assert.rejects(c.updateAlias(G, { alias: 'Name', expectedRevision: 9 }, 'other-member'), { code: 'community_membership_reload_required' });
 const idle = f.bridge.createGroupController();
 await assert.rejects(idle.updateAlias(G, { alias: 'Name', expectedRevision: 7 }, 'idle'), { code: 'community_membership_reload_required' });
});

test('alias response identity guard retains original own member through unknown retries and unavailable roster', async () => {
 const f = await membershipFixture(), c = f.controller;
 f.state.response = () => ({ ...membershipOutcome('alias'), memberId: I });
 await assert.rejects(membershipAction(c, 'alias', 'alias'), unknown);
 assert.equal(f.bridge.inspectIntent('alias').state, 'unknown'); assert.equal(c.getSnapshot().command.membershipResult, null);
 f.state.response = () => ({ ...membershipDetail(), memberId: I, members: [{ ...member(), memberId: I, revision: 9 }] }); await c.loadDetail(G);
 f.state.response = () => ({ ...membershipOutcome('alias'), memberId: I }); await assert.rejects(c.retry('alias'), unknown);
 f.state.response = () => membershipOutcome('alias'); await c.retry('alias');
 const requests = f.calls.filter(call => call.method === 'PATCH'); assert.equal(requests.length, 3);
 assert.ok(requests.every(call => call.raw === requests[0].raw && call.key === 'alias'));
 assert.equal(c.getSnapshot().command.membershipResult.value.memberId, M); assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true);
});

test('alias moderation stale membership and unknown error codes never expose submitted or raw rejection text', async () => {
 const draft = 'Private submitted alias';
 for (const [status, code, projected] of [[422, 'community_text_rejected', 'community_text_rejected'], [503, 'community_text_moderation_unavailable', 'community_text_moderation_unavailable'],
  [409, 'stale_revision', 'stale_revision'], [409, 'community_membership_changed', 'community_membership_changed'], [404, 'community_not_found', 'community_not_found'], [503, draft, 'community_membership_unavailable']]) {
  const f = await membershipFixture(), c = f.controller;
  f.state.response = () => json({ error: { code, message: draft, details: { term: draft } } }, status);
  await assert.rejects(c.updateAlias(G, { alias: draft, expectedRevision: 7 }, 'alias'), error => error.code === projected && !error.message.includes(draft));
  assert.equal(c.getSnapshot().command.membershipResult, null); assert.equal(JSON.stringify(c.getSnapshot()).includes(draft), false);
  assert.equal(c.getSnapshot().detail.status, 'stale');
  assert.equal(c.getSnapshot().sharing.status, ['community_membership_changed', 'community_not_found'].includes(code) ? 'stale' : 'ready');
 }
});

test('confirmed leave remains possible without readable membership and sends no invented revision or confirmation', async () => {
 for (const mode of ['idle', 'unavailable']) {
  const f = await fixture(() => json({ error: { code: 'community_adult_eligibility_unavailable' } }, 403)), c = f.bridge.createGroupController();
  if (mode === 'unavailable') await assert.rejects(c.loadDetail(G), { code: 'community_adult_eligibility_unavailable' });
  for (const input of [{}, { confirmed: false }, { confirmed: true, expectedRevision: 1 }])
   await assert.rejects(c.leave(G, input, 'invalid'), invalidInput);
  f.state.response = () => ({ left: true }); assert.deepEqual(await c.leave(G, { confirmed: true }, 'leave'), { left: true });
  assert.deepEqual(f.calls.at(-1).body, {}); assert.equal(f.calls.at(-1).path, `/groups/${G}/leave`);
  assert.deepEqual(c.getSnapshot().command.membershipResult, { kind: 'leave', value: { left: true } });
  assert.equal(c.getSnapshot().removedMemberships.status, 'idle'); assert.equal(c.getSnapshot().groups.status, 'stale');
 }
});

test('close requires current owner and group revision with explicit confirmation while owner leave remains server-authoritative', async () => {
 const f = await membershipFixture(), c = f.controller, before = f.calls.length;
 for (const input of [{ expectedRevision: 4 }, { expectedRevision: 4, confirmed: false }, { expectedRevision: 4, confirmed: true, role: 'owner' }])
  await assert.rejects(c.closeGroup(G, input, 'invalid'), invalidInput);
 await assert.rejects(c.closeGroup(G, { expectedRevision: 7, confirmed: true }, 'member-revision'), { code: 'community_membership_reload_required' });
 await assert.rejects(c.closeGroup(P, { expectedRevision: 4, confirmed: true }, 'other-group'), { code: 'community_membership_reload_required' });
 assert.equal(f.calls.length, before);
 for (const role of ['admin', 'member']) {
  const other = await membershipFixture(role);
  await assert.rejects(other.controller.closeGroup(G, { expectedRevision: 4, confirmed: true }, 'denied'), { code: 'community_forbidden' });
  assert.equal(other.calls.filter(call => call.method === 'POST').length, 0);
 }
 f.state.response = () => json({ error: { code: 'community_owner_must_close' } }, 409);
 await assert.rejects(c.leave(G, { confirmed: true }, 'leave'), { code: 'community_owner_must_close' });
 assert.deepEqual(f.calls.at(-1).body, {}); assert.equal(c.getSnapshot().command.membershipResult, null);
 f.state.response = membershipResponse; await c.loadDetail(G);
 assert.deepEqual(await c.closeGroup(G, { expectedRevision: 4, confirmed: true }, 'close'), { closed: true });
 assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 4 });
 assert.deepEqual(c.getSnapshot().command.membershipResult, { kind: 'close', value: { closed: true } });
});

test('membership commands reject malformed success projections before ledger confirmation and retry the same outcome', async () => {
 for (const kind of ['alias', 'leave', 'close']) {
  const f = await membershipFixture(), c = f.controller;
  f.state.response = () => kind === 'alias' ? { ...membershipOutcome(kind), accountId: G } : kind === 'leave' ? { left: false } : { closed: true, removed: true };
  await assert.rejects(membershipAction(c, kind), unknown);
  assert.equal(f.bridge.inspectIntent('membership').state, 'unknown'); assert.equal(c.getSnapshot().command.membershipResult, null);
  f.state.response = () => membershipOutcome(kind); await c.retry('membership');
  assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true);
  assert.deepEqual(c.getSnapshot().command.membershipResult, { kind, value: membershipOutcome(kind) });
 }
});

test('membership unknown retries preserve original body after unavailable reads and reject replacement by existing group commands', async () => {
 for (const kind of ['alias', 'leave', 'close']) {
  const f = await membershipFixture(), c = f.controller;
  f.state.response = () => { throw new Error('lost'); }; await assert.rejects(membershipAction(c, kind), unknown);
  const original = f.calls.at(-1);
  for (const action of [() => c.leave(G, { confirmed: true }, 'new'), () => c.createGroup(create(), 'create'),
   () => c.updateSharing(G, { flags: flags(), expectedRevision: 1 }, 'sharing'), () => c.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'ballot'),
   () => c.removeMember(G, I, { expectedRevision: 9, confirmed: true }, 'remove'),
   () => c.createRemovalMotion(G, I, { expectedRevision: 4, confirmed: true }, 'removal'),
   () => c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'growth')])
   await assert.rejects(action(), { code: 'community_membership_reconcile_required' });
  f.state.response = () => json({ error: { code: 'community_not_found' } }, 404); await assert.rejects(c.loadDetail(G), { code: 'community_not_found' });
  assert.equal(c.getSnapshot().command.membershipResult, null);
  f.state.response = () => membershipOutcome(kind); await c.retry('membership');
  assert.equal(f.calls.at(-1).raw, original.raw); assert.equal(f.calls.at(-1).key, original.key);
  assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true); assert.equal(c.getSnapshot().removedMemberships.status, 'idle');
 }
});

test('leave retry after rejoin rejects membership change and unavailable closure never becomes an inferred success', async () => {
 for (const kind of ['leave', 'close']) {
  const f = await membershipFixture(), c = f.controller;
  f.state.response = () => { throw new Error('lost'); }; await assert.rejects(membershipAction(c, kind), unknown);
  const code = kind === 'leave' ? 'community_membership_changed' : 'community_not_found';
  f.state.response = () => json({ error: { code } }, kind === 'leave' ? 409 : 404);
  await assert.rejects(c.retry('membership'), error => error.code === code && error.originalEffectUnknown);
  assert.equal(c.getSnapshot().command.status, 'error'); assert.equal(c.getSnapshot().command.intent.state, 'unknown');
  assert.equal(c.getSnapshot().command.membershipResult, null); assert.equal(c.getSnapshot().removedMemberships.status, 'idle');
 }
});

test('leave and close invalidate only affected group slots and supersede racing reloads without roster deletion', async () => {
 for (const kind of ['leave', 'close']) {
  const f = await membershipFixture(), c = f.controller, pending = [];
  await c.loadInvitations(G);
  f.state.response = () => new Promise(resolve => pending.push(resolve));
  const command = membershipAction(c, kind), detail = c.loadDetail(G), sharingRead = c.loadSharing(G), policyRead = c.loadPolicy(G), motionsRead = c.loadMotions(G), groups = c.loadGroups(), invitationsRead = c.loadInvitations(G);
  pending[0](membershipOutcome(kind)); await command;
  pending[1](membershipDetail()); pending[2](sharing()); pending[3](removalPolicy()); pending[4]([growthMotion()]); pending[5]([group()]);
  pending[6]([invite()]); await Promise.all([detail, sharingRead, policyRead, motionsRead, groups, invitationsRead]);
  for (const name of ['detail', 'sharing', 'policy', 'motions', 'groups', 'invitations']) { assert.equal(c.getSnapshot()[name].status, 'stale'); assert.equal(c.getSnapshot()[name].data, null); }
  assert.equal(c.getSnapshot().removedMemberships.status, 'idle');
 }
 const f = await membershipFixture(), c = f.controller;
 f.state.response = () => sharing(); await c.loadSharing(P); const unrelated = c.getSnapshot().sharing;
 f.state.response = () => ({ left: true }); await c.leave(G, { confirmed: true }, 'leave'); assert.equal(c.getSnapshot().sharing, unrelated);
});

test('membership commands cannot adopt foreign or sibling keys and cannot replace pending or unknown governance intents', async () => {
 const f = await membershipFixture(), c = f.controller;
 await f.bridge.updateAlias(G, { alias: 'Foreign', expectedRevision: 7 }, 'foreign');
 await assert.rejects(c.updateAlias(G, { alias: 'Foreign', expectedRevision: 7 }, 'foreign'), { code: 'community_controller_intent_unavailable' });
 assert.throws(() => c.retry('foreign'), { code: 'community_controller_intent_unavailable' });
 await membershipAction(c, 'alias', 'owned');
 assert.throws(() => f.bridge.createGroupController().retry('owned'), { code: 'community_controller_intent_unavailable' });
 for (const kind of ['growth', 'remove', 'generic']) {
  const other = await membershipFixture(), controller = other.controller;
  other.state.response = () => { throw new Error('lost'); };
  const action = kind === 'growth' ? controller.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'old') :
   kind === 'remove' ? controller.removeMember(G, I, { expectedRevision: 9, confirmed: true }, 'old') : controller.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'old');
  await assert.rejects(action, unknown);
  await assert.rejects(controller.leave(G, { confirmed: true }, 'leave'), { code: kind === 'growth' ? 'community_growth_reconcile_required' : kind === 'remove' ? 'community_removal_reconcile_required' : 'community_membership_reconcile_required' });
 }
});

test('membership pending observers cannot replace original command or dispatch an early retry', async () => {
 for (const kind of ['alias', 'leave', 'close']) {
  const f = await membershipFixture(), c = f.controller, attempts = []; let resolve;
  f.state.response = () => new Promise(done => { resolve = done; });
  c.subscribe(() => {
   if (c.getSnapshot().command.status !== 'pending') return;
   attempts.push(assert.rejects(c.leave(G, { confirmed: true }, 'new'), { code: 'community_intent_in_flight' }));
   attempts.push(assert.rejects(c.createGroup(create(), 'create'), { code: 'community_intent_in_flight' }));
   if (c.inspectIntent('membership')) attempts.push(assert.rejects(c.retry('membership'), { code: 'community_intent_in_flight' }));
  });
  const command = membershipAction(c, kind); resolve(membershipOutcome(kind)); await command; await Promise.all(attempts);
  assert.ok(attempts.length > 0); assert.equal(f.calls.filter(call => call.method !== 'GET').length, 1);
 }
});

test('membership account resource controller and mounted-session disposal clear results and fence late reads and writes', async () => {
 for (const kind of ['alias', 'leave', 'close']) for (const end of ['controller', 'resource', 'switch', 'mount']) {
  let mounted = true; const f = await fixture(membershipResponse, () => mounted), c = f.bridge.createGroupController();
  await c.loadDetail(G); const pending = []; f.state.response = () => new Promise(resolve => pending.push(resolve));
  const command = membershipAction(c, kind), read = c.loadDetail(G);
  if (end === 'controller') c.dispose(); else if (end === 'resource') f.bridge.dispose();
  else if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else mounted = false;
  assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().command.membershipResult, null); assert.equal(c.getSnapshot().detail.data, null);
  pending[0](membershipOutcome(kind)); pending[1](membershipDetail());
  await assert.rejects(command, { code: 'session_changed' }); await assert.rejects(read, { code: 'session_changed' });
  assert.throws(() => c.retry('membership'), { code: 'session_changed' });
 }
});

test('membership observer teardown prevents dispatch and withholds confirmed results after disposal', async () => {
 for (const kind of ['alias', 'leave', 'close']) for (const phase of ['pending', 'confirmed']) {
  const f = await membershipFixture(), c = f.controller;
  c.subscribe(() => { if (c.getSnapshot().command.status === phase) c.dispose(); });
  await assert.rejects(membershipAction(c, kind), { code: 'session_changed' });
  assert.equal(c.getSnapshot().command.membershipResult, null); assert.equal(f.calls.filter(call => call.method !== 'GET').length, phase === 'pending' ? 0 : 1);
 }
});

const managerInvitation = () => ({ ...invite(), revision: 6 });
const managerOutcome = kind => kind === 'revoke' ? { ...managerInvitation(), state: 'revoked', revision: 7 } :
 ({ ...managerInvitation(), id: kind === 'replace' ? P : I, revision: kind === 'replace' ? 1 : 6, tokenAvailable: true, token: secret });
function managerResponse(call) {
 if (call.path.endsWith('/invitations')) return call.method === 'GET' ? [managerInvitation()] : managerOutcome('issue');
 if (call.path.endsWith('/revoke')) return managerOutcome('revoke');
 if (call.path.endsWith('/replace')) return managerOutcome('replace');
 return membershipResponse(call);
}
async function managerFixture(role = 'owner') {
 const f = await fixture(call => call.path === `/groups/${G}` ? membershipDetail(role) : managerResponse(call)), controller = f.bridge.createGroupController();
 await controller.loadDetail(G); await controller.loadInvitations(G); return { ...f, controller };
}
function managerAction(c, kind, key = 'manager') {
 return kind === 'issue' ? c.issueInvitation(G, key) : kind === 'revoke' ? c.revokeInvitation(G, I, 6, key) : c.replaceInvitation(G, I, 6, key);
}
function managerMetadata(kind) {
 const { token: ignored, ...value } = managerOutcome(kind); return { ...value, tokenAvailable: false };
}

test('manager invitation reads independently expose empty loading unavailable and server expiry without token or identity disclosure', async () => {
 const f = await managerFixture(), c = f.controller, detail = c.getSnapshot().detail;
 assert.equal(c.getSnapshot().invitations.data[0].state, 'pending'); assert.ok(Object.isFrozen(c.getSnapshot().invitations.data));
 f.state.response = () => [{ ...managerInvitation(), state: 'expired' }]; await c.loadInvitations(G);
 assert.equal(c.getSnapshot().invitations.data[0].state, 'expired'); assert.equal(c.getSnapshot().detail, detail);
 f.state.response = () => []; await c.loadInvitations(G); assert.equal(c.getSnapshot().invitations.status, 'empty');
 for (const row of [{ ...managerInvitation(), groupId: P }, { ...managerInvitation(), token: secret },
  { ...managerInvitation(), tokenAvailable: true }, { ...managerInvitation(), issuerAccountId: M }, { ...managerInvitation(), recipient: 'Private' }]) {
  f.state.response = () => [row]; await assert.rejects(c.loadInvitations(G), { code: 'community_invalid_response' });
  assert.equal(c.getSnapshot().invitations.data, null); assert.equal(JSON.stringify(c.getSnapshot()).includes(secret), false);
 }
 f.state.response = () => json({ error: { code: secret, message: secret } }, 503);
 await assert.rejects(c.loadInvitations(G), error => error.code === 'community_read_unavailable' && !error.message.includes(secret));
});

test('manager invitation latest read wins and access rejection invalidates current manager detail without stale race publication', async () => {
 const f = await managerFixture(), c = f.controller, pending = [];
 f.state.response = () => new Promise(resolve => pending.push(resolve));
 const first = c.loadInvitations(G), second = c.loadInvitations(G); assert.equal(c.getSnapshot().invitations.status, 'loading');
 pending[1]([{ ...managerInvitation(), revision: 8 }]); await second;
 pending[0](json({ error: { code: 'community_not_found' } }, 404)); await first;
 assert.equal(c.getSnapshot().invitations.data[0].revision, 8); assert.equal(c.getSnapshot().detail.status, 'ready');
 f.state.response = () => json({ error: { code: 'community_not_found' } }, 404);
 await assert.rejects(c.loadInvitations(G), { code: 'community_not_found' });
 assert.equal(c.getSnapshot().detail.status, 'stale'); assert.equal(c.getSnapshot().invitations.status, 'error');
});

test('manager issue supports owner and admin but requires current same-group detail and selected actual invitation revision', async () => {
 for (const role of ['owner', 'admin']) {
  const f = await managerFixture(role), c = f.controller, before = f.calls.length;
  await assert.rejects(c.issueInvitation(P, 'other'), { code: 'community_invitation_reload_required' });
  await assert.rejects(c.revokeInvitation(G, I, 1, 'wrong-revision'), { code: 'community_invitation_reload_required' });
  await assert.rejects(c.replaceInvitation(G, P, 6, 'missing'), { code: 'community_invitation_reload_required' });
  await assert.rejects(c.revokeInvitation(G, 'invalid', 6, 'bad'), invalidInput); assert.equal(f.calls.length, before);
  const value = await c.issueInvitation(G, 'issue'); assert.equal(value.token, secret); assert.deepEqual(f.calls.at(-1).body, {});
  assert.deepEqual(c.getSnapshot().command.invitationResult, { kind: 'issue_invitation', value: managerMetadata('issue') });
 }
 const memberFixture = await managerFixture('member');
 for (const kind of ['issue', 'revoke', 'replace']) await assert.rejects(managerAction(memberFixture.controller, kind), { code: 'community_forbidden' });
 assert.equal(memberFixture.calls.filter(call => call.method === 'POST').length, 0);
 assert.equal(memberFixture.controller.getSnapshot().invitations.status, 'stale');
 const idle = memberFixture.bridge.createGroupController(); await assert.rejects(idle.issueInvitation(G, 'idle'), { code: 'community_invitation_reload_required' });
});

test('manager issue and explicit replacement deliver tokens only through the first promise and never through snapshots or storage', async () => {
 for (const kind of ['issue', 'replace']) {
  const f = await managerFixture(), c = f.controller, snapshots = []; c.subscribe(() => snapshots.push(JSON.stringify(c.getSnapshot())));
  const value = await managerAction(c, kind); assert.equal(value.tokenAvailable, true); assert.equal(value.token, secret);
  assert.equal(c.getSnapshot().command.invitationResult.value.tokenAvailable, false); assert.equal('token' in c.getSnapshot().command.invitationResult.value, false);
  f.state.response = () => managerOutcome(kind); const replay = await c.retry('manager');
  assert.equal(replay.tokenAvailable, false); assert.equal('token' in replay, false);
  assert.ok(snapshots.every(value => !value.includes(secret))); assert.equal(JSON.stringify(f.storageCalls).includes(secret), false);
  assert.deepEqual(f.calls.at(-1).body, kind === 'issue' ? {} : { expectedRevision: 6 });
  assert.equal(f.calls.at(-1).key, 'manager');
 }
});

test('unknown manager issue reconciles metadata before separate explicit revoke or replacement without list dependence', async () => {
 for (const recovery of ['revoke', 'replace']) {
  const f = await managerFixture(), c = f.controller;
  f.state.response = () => { throw new Error('lost'); }; await assert.rejects(c.issueInvitation(G, 'issue'), unknown);
  assert.equal(c.getSnapshot().command.intent.disposition, 'revoke_or_replace');
  await assert.rejects(managerAction(c, recovery, 'too-early'), { code: 'community_invitation_reconcile_required' });
  f.state.response = () => managerOutcome('issue'); await assert.rejects(c.retry('issue'), { code: 'community_invitation_replay_invalid' });
  assert.equal(c.getSnapshot().command.invitationResult, null); assert.equal(JSON.stringify(c.getSnapshot()).includes(secret), false);
  f.state.response = () => managerMetadata('issue'); const replay = await c.retry('issue');
  assert.equal(replay.tokenAvailable, false); assert.equal(c.getSnapshot().command.intent.disposition, 'revoke_or_replace');
  assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true);
  f.state.response = () => []; await c.loadInvitations(G); assert.equal(c.getSnapshot().invitations.status, 'empty');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 3);
  f.state.response = managerResponse; await managerAction(c, recovery, 'explicit-recovery');
  assert.equal(f.calls.at(-1).key, 'explicit-recovery'); assert.deepEqual(f.calls.at(-1).body, { expectedRevision: 6 });
  assert.equal(c.getSnapshot().command.invitationResult.kind, recovery + '_invitation');
 }
});

test('replacement response must have a different invitation id and exact retries retain that original identity guard', async () => {
 const f = await managerFixture(), c = f.controller;
 f.state.response = () => managerOutcome('issue'); await assert.rejects(c.replaceInvitation(G, I, 6, 'replace'), unknown);
 assert.equal(f.bridge.inspectIntent('replace').state, 'unknown'); assert.equal(c.getSnapshot().command.invitationResult, null);
 f.state.response = () => [{ ...managerInvitation(), id: P, revision: 9 }]; await c.loadInvitations(G);
 f.state.response = () => managerMetadata('issue'); await assert.rejects(c.retry('replace'), unknown);
 f.state.response = () => managerMetadata('replace'); await c.retry('replace');
 assert.equal(c.getSnapshot().command.invitationResult.value.id, P); assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true);
 const writes = f.calls.filter(call => call.method === 'POST'); assert.equal(writes.length, 3);
 assert.ok(writes.every(call => call.path === `/groups/${G}/invitations/${I}/replace` && call.raw === writes[0].raw && call.key === 'replace'));
});

test('revocation validates selected identity but preserves redeemed and expired server outcomes without inventing revoked state', async () => {
 for (const state of ['redeemed', 'expired', 'revoked']) {
  const f = await managerFixture(), c = f.controller;
  f.state.response = () => ({ ...managerInvitation(), id: P, state }); await assert.rejects(c.revokeInvitation(G, I, 6, 'revoke'), unknown);
  f.state.response = () => ({ ...managerInvitation(), state }); const value = await c.retry('revoke');
  assert.equal(value.state, state); assert.equal(c.getSnapshot().command.invitationResult.value.state, state);
 }
});

test('manager server role races governed rejection redeemed replacement and quota errors remain sanitized authoritative outcomes', async () => {
 for (const [kind, code, status] of [['issue', 'community_governed_action_required', 409], ['replace', 'community_governed_action_required', 409],
  ['replace', 'community_invitation_used', 409], ['issue', 'community_invitation_capacity', 409], ['revoke', 'stale_revision', 409],
  ['issue', 'community_not_found', 404], ['issue', 'community_adult_eligibility_unavailable', 403], ['replace', secret, 503]]) {
  const f = await managerFixture(), c = f.controller;
  f.state.response = () => json({ error: { code, message: secret } }, status);
  await assert.rejects(managerAction(c, kind), error => error.code === (code === secret ? 'community_outcome_unknown' : code) && !error.message.includes(secret));
  assert.equal(c.getSnapshot().command.invitationResult, null); assert.equal(c.getSnapshot().invitations.status, 'stale');
  assert.equal(c.getSnapshot().detail.status, [403, 404].includes(status) ? 'stale' : 'ready');
  assert.equal(JSON.stringify(c.getSnapshot()).includes(secret), false); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
 }
});

test('manager unknown invitation intents block every replacement path and retry after unreadable detail with the original revision', async () => {
 for (const kind of ['issue', 'revoke', 'replace']) {
  const f = await managerFixture(), c = f.controller;
  f.state.response = () => { throw new Error('lost'); }; await assert.rejects(managerAction(c, kind), unknown); const original = f.calls.at(-1);
  for (const action of [() => c.issueInvitation(G, 'new'), () => c.revokeInvitation(G, I, 6, 'new-revoke'), () => c.replaceInvitation(G, I, 6, 'new-replace'),
   () => c.leave(G, { confirmed: true }, 'leave'), () => c.createGroup(create(), 'group'),
   () => c.removeMember(G, I, { expectedRevision: 9, confirmed: true }, 'remove'),
   () => c.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'growth'),
   () => c.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'ballot')])
   await assert.rejects(action(), { code: 'community_invitation_reconcile_required' });
  f.state.response = () => json({ error: { code: 'community_not_found' } }, 404); await assert.rejects(c.loadDetail(G), { code: 'community_not_found' });
  f.state.response = () => managerMetadata(kind); await c.retry('manager');
  assert.equal(f.calls.at(-1).raw, original.raw); assert.equal(f.calls.at(-1).path, original.path); assert.equal(f.calls.at(-1).key, original.key);
  assert.equal(c.getSnapshot().command.intent.originalEffectUnknown, true); assert.equal(c.getSnapshot().command.invitationResult.value.tokenAvailable, false);
 }
});

test('manager invitation commands reject foreign sibling and uncertain membership or governance keys', async () => {
 const f = await managerFixture(), c = f.controller;
 await f.bridge.issueInvitation(G, 'foreign'); await assert.rejects(c.issueInvitation(G, 'foreign'), { code: 'community_controller_intent_unavailable' });
 assert.throws(() => c.retry('foreign'), { code: 'community_controller_intent_unavailable' });
 await c.issueInvitation(G, 'owned'); assert.throws(() => f.bridge.createGroupController().retry('owned'), { code: 'community_controller_intent_unavailable' });
 for (const kind of ['leave', 'growth', 'remove', 'ballot']) {
  const other = await membershipFixture(), controller = other.controller;
  other.state.response = () => { throw new Error('lost'); };
  const action = kind === 'leave' ? controller.leave(G, { confirmed: true }, 'other') :
   kind === 'growth' ? controller.createGrowthMotion(G, { places: 3, expectedRevision: 4, confirmed: true }, 'other') :
   kind === 'remove' ? controller.removeMember(G, I, { expectedRevision: 9, confirmed: true }, 'other') : controller.setBallot(G, P, { choice: 'yes', expectedRevision: 0 }, 'other');
  await assert.rejects(action, unknown);
  await assert.rejects(controller.issueInvitation(G, 'issue'), { code: kind === 'leave' ? 'community_membership_reconcile_required' :
   kind === 'growth' ? 'community_growth_reconcile_required' : kind === 'remove' ? 'community_removal_reconcile_required' : 'community_invitation_reconcile_required' });
 }
});

test('manager pending observers cannot issue revoke replace leave or retry before original dispatch completes', async () => {
 for (const kind of ['issue', 'revoke', 'replace']) {
  const f = await managerFixture(), c = f.controller, attempts = []; let resolve;
  f.state.response = () => new Promise(done => { resolve = done; });
  c.subscribe(() => {
   if (c.getSnapshot().command.status !== 'pending') return;
   for (const next of ['issue', 'revoke', 'replace']) attempts.push(assert.rejects(managerAction(c, next, 'replacement-' + next), { code: 'community_intent_in_flight' }));
   attempts.push(assert.rejects(c.leave(G, { confirmed: true }, 'leave'), { code: 'community_intent_in_flight' }));
   if (c.inspectIntent('manager')) attempts.push(assert.rejects(c.retry('manager'), { code: 'community_intent_in_flight' }));
  });
  const command = managerAction(c, kind); resolve(managerOutcome(kind)); await command; await Promise.all(attempts);
  assert.ok(attempts.length > 0); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
 }
});

test('manager mutations supersede racing invitation reads and leave clears that group invitation memory', async () => {
 const f = await managerFixture(), c = f.controller, pending = [];
 f.state.response = () => new Promise(resolve => pending.push(resolve));
 const command = c.revokeInvitation(G, I, 6, 'revoke'), read = c.loadInvitations(G);
 pending[0](managerOutcome('revoke')); await command; pending[1]([managerInvitation()]); await read;
 assert.equal(c.getSnapshot().invitations.status, 'stale'); assert.equal(c.getSnapshot().invitations.data, null);
 f.state.response = managerResponse; await c.loadInvitations(G);
 await c.leave(G, { confirmed: true }, 'leave'); assert.equal(c.getSnapshot().invitations.status, 'stale'); assert.equal(c.getSnapshot().command.invitationResult, null);
});

test('manager invitation disposal and account changes prevent late token delivery and clear every invitation projection', async () => {
 for (const kind of ['issue', 'replace']) for (const end of ['controller', 'resource', 'switch', 'mount']) {
  let mounted = true; const f = await fixture(managerResponse, () => mounted), c = f.bridge.createGroupController();
  await c.loadDetail(G); await c.loadInvitations(G); const pending = [];
  f.state.response = () => new Promise(resolve => pending.push(resolve));
  const command = managerAction(c, kind), read = c.loadInvitations(G);
  if (end === 'controller') c.dispose(); else if (end === 'resource') f.bridge.dispose();
  else if (end === 'switch') await f.transport.signIn('other@example.invalid', 'synthetic-password'); else mounted = false;
  assert.equal(c.getSnapshot().disposed, true); assert.equal(c.getSnapshot().command.invitationResult, null); assert.equal(c.getSnapshot().invitations.data, null);
  pending[0](managerOutcome(kind)); pending[1]([managerInvitation()]);
  await assert.rejects(command, error => error.code === 'session_changed' && !error.message.includes(secret)); await assert.rejects(read, { code: 'session_changed' });
  assert.equal(JSON.stringify(c.getSnapshot()).includes(secret), false); assert.throws(() => c.retry('manager'), { code: 'session_changed' });
 }
});

test('manager observer teardown prevents dispatch or withholds the token at confirmed publication', async () => {
 for (const kind of ['issue', 'replace']) for (const phase of ['pending', 'confirmed']) {
  const f = await managerFixture(), c = f.controller;
  c.subscribe(() => { if (c.getSnapshot().command.status === phase) c.dispose(); });
  await assert.rejects(managerAction(c, kind), { code: 'session_changed' });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, phase === 'pending' ? 0 : 1);
  assert.equal(c.getSnapshot().command.invitationResult, null); assert.equal(JSON.stringify(c.getSnapshot()).includes(secret), false);
 }
});
