import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createServer, createSubjectEligibilityProvider, type FormServer } from '../../src/server.js';
import { createSourceRequestFactories, type SourceRequestFactoryConfiguration } from '../../src/lifecycle/request-factories.js';
import { composeAccountMigrations } from '../../src/lifecycle/composition.js';
import { activityMigration, addCalendarDays, localDate, type ActivityEntry } from '../../src/activity/index.js';
import { communityMigration, communityExtensionMigration, featureBoardMigrationVersion, featureBoardMigrationSql, allFalse, type GroupView, type IssuedInvitation } from '../../src/community/index.js';
import { hash } from '../../src/storage.js';
import type { AccountContext, DisableRecord, LifecycleBindings, SuppressionLedger } from '../../src/lifecycle/types.js';
import { DomainError } from '../../src/errors.js';

const featureBoardMigration = {version:featureBoardMigrationVersion,sql:featureBoardMigrationSql};
const origin = 'http://127.0.0.1:47831';
const password = 'synthetic-request-factory-password-12345';
const domainError = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
type User = { token: string; actor: AccountContext };
type Fixture = {
  backend: FormServer; bindings: LifecycleBindings; users: readonly [User, User];
  factories: ReturnType<typeof createSourceRequestFactories>;
  request: (path: string, user: User, method?: string, value?: unknown, key?: string) => Promise<Response>;
};

async function fixture(t: TestContext, run: (f: Fixture) => Promise<void>, configuration: SourceRequestFactoryConfiguration = {
  mode: 'source-only', activityProjection: 'read-only', communityModules: 'b2-b4-b5',
  communityExtension: {textModeration:{policyVersion:'community-v1',checkText:()=> 'allowed'}},
  // Synthetic quota gate only. It grants no production limiter qualification.
  assertCommunityRateLimit: () => {},
}) {
  const parent = resolve('.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'request-factories-'));
  let backend: FormServer | undefined;
  const pendingStreams = new Set<() => void>();
  const cleanup = () => {
    for (const cancel of pendingStreams) cancel(); pendingStreams.clear();
    if (backend?.db.open) backend.close();
    rmSync(root, { recursive: true, force: true });
  };
  const interrupted = () => { cleanup(); process.exit(130); };
  const terminated = () => { cleanup(); process.exit(143); };
  t.after(cleanup); process.once('SIGINT', interrupted); process.once('SIGTERM', terminated);
  try {
    const path = join(root, 'synthetic.sqlite');
    const seed = new Database(path);
    try {
      seed.pragma('foreign_keys = ON');
      seed.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
      for (const migration of composeAccountMigrations(activityMigration, communityMigration, configuration.communityModules === 'b2-b4-b5' ? {extension:communityExtensionMigration,board:featureBoardMigration} : undefined)) {
        seed.exec(migration.sql);
        seed.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
      }
    } finally { seed.close(); }
    const disabled = new Map<string, DisableRecord>();
    const ledger: SuppressionLedger = {
      currentSequence: () => disabled.size,
      lookup: id => disabled.get(id) ?? null,
      reconcileRestore: apply => { for (const record of disabled.values()) apply(record); return disabled.size; },
      recordDisable: value => { const record = { ...value, sequence: disabled.size + 1 }; disabled.set(value.accountId, record); return record; },
    };
    let bindings: LifecycleBindings | undefined;
    backend = await createServer({ dbPath: path, baseURL: origin, secret: 'synthetic-request-factory-secret-more-than-32-characters',
      registration: { mode: 'allowlist', emails: ['one@synthetic.invalid', 'two@synthetic.invalid'] },
      moduleMigrations: { activity: activityMigration, community: communityMigration, ...(configuration.communityModules === 'b2-b4-b5' ? {additions:{extension:communityExtensionMigration,board:featureBoardMigration}} : {}) },
      sourceRequestFactories: configuration,
      lifecycle: { ledger, createAdapters: (_db, value) => { bindings = value; return []; } },
    });
    const server = backend;
    const request = (path: string, user: User, method = 'GET', value?: unknown, key?: string) => Promise.resolve(server.handleRequest(
      new Request(origin + path, { method, headers: { authorization: `Bearer ${user.token}`, origin,
        ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), '127.0.0.1'));
    const signup = async (email: string): Promise<User> => {
      const response = await server.handleRequest(new Request(origin + '/api/auth/sign-up/email', { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic', email, password }) }), '127.0.0.1');
      assert.equal(response.status, 200); const token = response.headers.get('set-auth-token'); assert.ok(token);
      const initialized = await request('/v1/me', { token, actor: {} as AccountContext }); assert.equal(initialized.status, 200);
      const me = await initialized.json() as { accountId: string };
      const row = server.db.prepare('SELECT f.auth_user_id AS authUserId,s.id AS sessionId FROM form_accounts f JOIN session s ON s.userId=f.auth_user_id WHERE f.id=?')
        .get(me.accountId) as { authUserId: string; sessionId: string };
      const actor = Object.freeze({ accountId: me.accountId, ...row, epoch: 0 });
      const profile = await request('/v1/me/profile', { token, actor });
      const current = await profile.json() as { revision: number };
      assert.equal((await request('/v1/me/profile', { token, actor }, 'PATCH', { expectedRevision: current.revision, age: 30 })).status, 200);
      return { token, actor };
    };
    const users = [await signup('one@synthetic.invalid'), await signup('two@synthetic.invalid')] as const;
    assert.ok(bindings);
    const factories = createSourceRequestFactories({ db: server.db, lifecycle: bindings, configuration,
      subjectEligibilityFor: actor => createSubjectEligibilityProvider(server.db, actor) });
    // Request cancellation handlers belong to this fixture and are removed with its exact root.
    const f = { backend: server, bindings, users, factories, request };
    activeStreams.set(f, pendingStreams);
    try { await run(f); } finally { activeStreams.delete(f); }
  } finally {
    process.off('SIGINT', interrupted); process.off('SIGTERM', terminated); cleanup();
  }
}
const activeStreams = new WeakMap<Fixture, Set<() => void>>();

function paused(f: Fixture, path: string, user: User, value: unknown, method = 'POST', key = 'paused') {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { admitted(); } }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: 'half' } = { method, body: stream, duplex: 'half', headers: {
    authorization: `Bearer ${user.token}`, origin, 'content-type': 'application/json',
    'content-length': String(bytes.byteLength), 'idempotency-key': key,
  } };
  const result = Promise.resolve(f.backend.handleRequest(new Request(origin + path, init), '127.0.0.1'));
  const ready = Promise.race([admission, result.then(response => { throw new Error(`Request ended before body admission: ${response.status}`); })]);
  // Attach rejection handling before a cancellation can interrupt the awaiting test.
  void result.catch(() => {});
  const cancel = () => { try { controller.error(new Error('synthetic stream cancelled')); } catch {} };
  activeStreams.get(f)!.add(cancel);
  return { ready, result, finish() { activeStreams.get(f)!.delete(cancel); controller.enqueue(bytes); controller.close(); }, cancel };
}
async function group(f: Fixture) {
  const [a, b] = f.users;
  const created = await f.request('/v1/community/groups', a, 'POST', { name: 'Synthetic group', alias: 'One', membershipDisclosureAccepted: true }, 'group');
  assert.equal(created.status, 201); const value = await created.json() as GroupView;
  const issued = await f.request(`/v1/community/groups/${value.id}/invitations`, a, 'POST', {}, 'invite');
  assert.equal(issued.status, 201); const invite = await issued.json() as IssuedInvitation;
  assert.equal(invite.tokenAvailable, true); if (!invite.tokenAvailable) throw new Error('synthetic invite unavailable');
  assert.equal((await f.request('/v1/community/invitations/join', b, 'POST', { token: invite.token, alias: 'Two', membershipDisclosureAccepted: true }, 'join')).status, 201);
  return { value, token: invite.token };
}

test('request factories: shared server retains exact authenticated actors across interleaved body awaits', t => fixture(t, async f => {
  const [a, b] = f.users; const g = await group(f);
  const issued = await f.request(`/v1/community/groups/${g.value.id}/invitations`, a, 'POST', {}, 'preview-invite');
  const invite = await issued.json() as IssuedInvitation; assert.ok(invite.tokenAvailable);
  const slow = paused(f, '/v1/community/invitations/preview', b, { token: invite.token });
  await slow.ready;
  const fast = await f.request('/v1/community/groups', a); assert.equal(fast.status, 200);
  f.backend.db.prepare('DELETE FROM session WHERE id=?').run(a.actor.sessionId);
  slow.finish(); const response = await slow.result; assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const other = await f.request('/v1/community/groups', b); assert.equal(other.status, 200);
  const own = await fast.json() as GroupView[];
  const joined = await other.json() as GroupView[];
  assert.equal(own[0]?.role, 'owner'); assert.equal(joined[0]?.role, 'member');
  assert.notEqual(own[0]?.memberId, joined[0]?.memberId);
}));

test('request factories: session revocation after body admission denies effect and receipt', t => fixture(t, async f => {
  const [a] = f.users;
  const pending = paused(f, '/v1/community/groups', a, { name: 'Denied', alias: 'Denied', membershipDisclosureAccepted: true });
  await pending.ready;
  f.backend.db.prepare('DELETE FROM session WHERE id=?').run(a.actor.sessionId);
  pending.finish(); assert.equal((await pending.result).status, 401);
  assert.equal((f.backend.db.prepare('SELECT count(*) n FROM community_groups').get() as { n: number }).n, 0);
  assert.equal((f.backend.db.prepare('SELECT count(*) n FROM community_command_receipts').get() as { n: number }).n, 0);
}));

test('request factories: current minor profile after body admission denies adult operation', t => fixture(t, async f => {
  const [a] = f.users;
  const pending = paused(f, '/v1/community/groups', a, { name: 'Denied', alias: 'Denied', membershipDisclosureAccepted: true });
  await pending.ready;
  assert.equal((await f.request('/v1/me/profile', a, 'PATCH', { expectedRevision: 1, age: 17 })).status, 200);
  pending.finish(); assert.equal((await pending.result).status, 403);
  assert.equal((f.backend.db.prepare('SELECT count(*) n FROM community_groups').get() as { n: number }).n, 0);
}));

test('request factories: missing limiter and Activity projection bindings fail closed', t => fixture(t, async f => {
  const response = await f.request('/v1/community/groups', f.users[0]);
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'community_limiter_unavailable');
  assert.equal(f.factories.activity, undefined);
  assert.equal((await f.request('/v1/activity/calendar', f.users[0])).status, 503);
}, { mode: 'source-only' }));

test('request factories: absent Activity projection returns unavailable rather than an empty success', t => fixture(t, async f => {
  const p = await projection(f);
  const response = await f.request(`/v1/community/groups/${p.groupId}/summary?from=${p.range.from}&to=${p.range.to}`, p.a);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { summaryStatus: 'unavailable', members: [] });
}, { mode: 'source-only', communityModules:'b2-b4-b5', communityExtension:{textModeration:{policyVersion:'community-v1',checkText:()=> 'allowed'}}, assertCommunityRateLimit: () => {} }));

test('request factories: unresolved persistability rejects before Activity rows, hashes or receipts', t => fixture(t, async f => {
  const service = f.factories.activity; assert.ok(service);
  assert.throws(() => service.createCalendar(f.users[0].actor, 'no-save', { timeZone: 'America/New_York', confirmed: true }),
    domainError('activity_persistability_unavailable'));
  assert.equal(service.deps.legacy, undefined);
  assert.equal(service.deps.globalExerciseKind?.('arbitrary-assistant-id'), null);
  assert.equal(service.deps.globalExerciseKind?.('floor-press'), 'resistance');
  assert.equal((f.backend.db.prepare("SELECT count(*) n FROM command_receipts WHERE operation LIKE 'activity.%'").get() as { n: number }).n, 0);
  assert.equal((f.backend.db.prepare('SELECT count(*) n FROM activity_calendar').get() as { n: number }).n, 0);
}));

test('request factories: body no-save denial consumes no request body or assessment receipt', t => fixture(t, async f => {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.error(new Error('body must not be consumed')); } }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half',
    headers: { authorization: `Bearer ${f.users[0].token}`, origin, 'content-type': 'application/json' } };
  const before = (f.backend.db.prepare('SELECT count(*) n FROM command_receipts').get() as { n: number }).n;
  try {
    const response = await f.backend.handleRequest(new Request(origin + '/v1/body/operations/save_assessment', init), '127.0.0.1');
    assert.equal(response.status, 501); assert.equal(reads, 0);
    assert.equal((f.backend.db.prepare('SELECT count(*) n FROM command_receipts').get() as { n: number }).n, before);
  } finally { await stream.cancel(); }
}));

async function projection(f: Fixture) {
  const g = await group(f); const [a, b] = f.users;
  const today = localDate(new Date().toISOString(), 'America/New_York');
  const date = addCalendarDays(today, -1), before = `${addCalendarDays(today, -2)}T00:00:00.000Z`;
  assert.equal((await f.request(`/v1/community/groups/${g.value.id}/me/sharing`, b, 'PATCH',
    { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'share')).status, 200);
  // Synthetic prior consent/membership fixture, never an application backfill path.
  f.backend.db.prepare('UPDATE community_members SET joined_at=? WHERE group_id=?').run(before, g.value.id);
  f.backend.db.prepare('UPDATE community_share_settings SET workout_enabled_at=? WHERE group_id=? AND account_id=?')
    .run(before, g.value.id, b.actor.accountId);
  const calendar = { timeZone: 'America/New_York', activationDate: date, revision: 1, calendarPolicy: 'activity-calendar-intl-v1', createdAt: before };
  f.backend.db.prepare('INSERT INTO activity_calendar VALUES (?,1,?,?,?)').run(b.actor.accountId, calendar.timeZone, date, JSON.stringify(calendar));
  const entry: ActivityEntry = { id: randomUUID(), revision: 1, status: 'recorded', draftId: 'synthetic-private-entry',
    date: { localDate: date, timeZone: calendar.timeZone, calendar: 'iso8601', source: 'selected', capturedAt: before, referenceLocalDate: date, confirmed: true },
    kind: 'workout', items: [{ id: 'private-item', exercise: { source: 'global', id: 'floor-press' }, load: { state: 'unknown', confirmed: true },
      snapshot: { ref: { source: 'global', id: 'floor-press' }, name: 'PRIVATE-SYNTHETIC-MARKER', description: 'PRIVATE-DESCRIPTION',
        movement: null, measurementType: 'unspecified', kind: 'resistance', loadApplicability: 'unspecified', loadLabel: null,
        guidance: 'globalReference', cueStatus: 'unknown', safetyAssessment: 'notEstablished' } }],
    performedConfirmed: true, source: 'manual', acknowledgedIssues: [], createdAt: before, updatedAt: before };
  f.backend.db.prepare('INSERT INTO activity_entries VALUES (?,?,?,?,1,?,?,?)')
    .run(b.actor.accountId, entry.id, entry.draftId, 'synthetic-only', date, 'recorded', JSON.stringify(entry));
  f.backend.db.prepare('INSERT INTO activity_entry_revisions VALUES (?,?,1,?)').run(b.actor.accountId, entry.id, JSON.stringify(entry));
  return { a, b, groupId: g.value.id, range: { from: date, to: date } };
}

test('request factories: actual server Activity to Community discloses exact resource mask only', t => fixture(t, async f => {
  const p = await projection(f);
  const response = await f.request(`/v1/community/groups/${p.groupId}/summary?from=${p.range.from}&to=${p.range.to}`, p.a);
  assert.equal(response.status, 200); const text = await response.text();
  const value = JSON.parse(text) as { summaryStatus: string; members: { memberId: string; alias: string; days: unknown[] }[] };
  assert.equal(value.summaryStatus, 'available');
  assert.deepEqual(value.members.find(x => x.alias === 'Two')?.days, [{ localDate: p.range.from, workout: 'recorded' }]);
  for (const forbidden of ['PRIVATE-SYNTHETIC-MARKER', 'PRIVATE-DESCRIPTION', p.b.actor.accountId, 'dayStartAt', 'timeZone', 'revision', 'exerciseCount'])
    assert.equal(text.includes(forbidden), false);
  assert.equal((await f.request(`/v1/community/groups/${p.groupId}/summary?from=${p.range.from}&to=${p.range.to}&subjectAccountId=${p.b.actor.accountId}`, p.a)).status, 422);
}));

test('request factories: exact proof rejects a different subject, range or field and post-read invalidation discards output', t => fixture(t, async f => {
  const p = await projection(f); const service = f.factories.activity; assert.ok(service);
  const community = f.factories.serviceFor(p.a.actor);
  const input = { subjectAccountId: p.b.actor.accountId, ...p.range, fields: ['workout'] as const };
  community.withActivityAuthorization(p.a.actor, p.groupId, input, proof => {
    assert.throws(() => proof.assertAuthorized({ ...input, subjectAccountId: p.a.actor.accountId }));
    assert.throws(() => proof.assertAuthorized({ ...input, from: addCalendarDays(p.range.from, -1) }));
    assert.throws(() => proof.assertAuthorized({ ...input, fields: ['workout', 'exerciseCount'] }));
  });
  const original = service.projection.bind(service);
  service.projection = (accountId, from, to) => {
    const result = original(accountId, from, to);
    f.backend.db.prepare('UPDATE community_share_settings SET revision=revision+1 WHERE group_id=? AND account_id=?')
      .run(p.groupId, p.b.actor.accountId);
    return result;
  };
  try { assert.deepEqual(community.readSummary(p.a.actor, p.groupId, p.range), { summaryStatus: 'unavailable', members: [] }); }
  finally { service.projection = original; }
}));

test('request factories: withdrawal after body admission denies late replay without restoring sharing', t => fixture(t, async f => {
  const p = await projection(f);
  const pending = paused(f, `/v1/community/groups/${p.groupId}/me/sharing`, p.b,
    { expectedRevision: 2, flags: { ...allFalse(), workout: true } }, 'PATCH', 'late-share');
  await pending.ready;
  assert.equal((await f.request(`/v1/community/groups/${p.groupId}/me/withdraw`, p.b, 'POST', {}, 'withdraw')).status, 200);
  pending.finish(); assert.equal((await pending.result).status, 409);
  const sharing = await f.request(`/v1/community/groups/${p.groupId}/me/sharing`, p.b);
  assert.deepEqual((await sharing.json() as { flags: unknown }).flags, allFalse());
  assert.equal((f.backend.db.prepare("SELECT count(*) n FROM community_command_receipts WHERE key='late-share'").get() as { n: number }).n, 0);
}));

test('transport wrapper preserves request metadata and abort propagation without pulling its body', t => fixture(t, async f => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { pulls++; } }, { highWaterMark: 0 });
  const abort = new AbortController();
  const original = new Request(`${origin}/synthetic-wrapper-probe`, {
    method: 'POST', body, duplex: 'half', signal: abort.signal,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'untrusted', 'x-real-ip': 'untrusted', 'x-form-peer-ip': 'untrusted' },
    cache: 'no-store', credentials: 'omit', mode: 'same-origin', redirect: 'manual',
    referrer: `${origin}/synthetic-referrer`, referrerPolicy: 'same-origin', integrity: 'sha256-synthetic',
  } as RequestInit & { duplex: 'half' });
  const fetch = f.backend.app.fetch;
  let forwarded: Request | undefined;
  f.backend.app.fetch = input => { forwarded = input; return new Response(null, { status: 204 }); };
  try {
    assert.equal((await f.backend.handleRequest(original, '127.0.0.7')).status, 204);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(forwarded);
    for (const field of ['url', 'method', 'cache', 'credentials', 'integrity', 'keepalive', 'mode', 'redirect', 'referrer', 'referrerPolicy'] as const)
      assert.equal(forwarded[field], original[field], field);
    assert.equal(forwarded.headers.get('content-type'), original.headers.get('content-type'));
    assert.equal(forwarded.headers.get('x-form-peer-ip'), '127.0.0.7');
    assert.equal(forwarded.headers.has('x-forwarded-for'), false);
    assert.equal(forwarded.headers.has('x-real-ip'), false);
    assert.equal(original.headers.get('x-form-peer-ip'), 'untrusted');
    assert.equal(pulls, 0);
    assert.equal(forwarded.signal.aborted, false);
    abort.abort('synthetic-abort');
    assert.equal(forwarded.signal.aborted, true);
    assert.equal(forwarded.signal.reason, 'synthetic-abort');
  } finally { f.backend.app.fetch = fetch; await body.cancel(); }
}));


test('maintained-auth owner Activity HTTP supports explicit isolated commands and exact replay without legacy eligibility', t => fixture(t, async f => {
  const [a,b] = f.users;
  const missing = await f.backend.handleRequest(new Request(origin+'/v1/activity/calendar'), '127.0.0.1');
  assert.equal(missing.status,401);
  const initial = await f.request('/v1/activity/calendar',a);
  assert.equal(initial.status,200); assert.equal(await initial.json(),null);
  assert.equal(initial.headers.get('cache-control'),'no-store');
  const input = {timeZone:'America/New_York',confirmed:true};
  const created = await f.request('/v1/activity/calendar',a,'POST',input,'owner-calendar');
  assert.equal(created.status,201); const value = await created.json();
  const replay = await f.request('/v1/activity/calendar',a,'POST',input,'owner-calendar');
  assert.equal(replay.status,201); assert.deepEqual(await replay.json(),value);
  assert.equal(await (await f.request('/v1/activity/calendar',b)).json(),null);
  assert.equal((await f.request('/v1/activity/calendar',a,'POST',{...input,accountId:b.actor.accountId},'injected')).status,422);
  assert.equal((f.backend.db.prepare("SELECT count(*) n FROM command_receipts WHERE operation='activity.calendar.create'").get() as {n:number}).n,1);
  const integration=f.factories.activityIntegration; assert.ok(integration);
  assert.throws(()=>integration.service.createCalendar(a.actor,'unleased',input),domainError('activity_owner_channel_required'));
  const lease=integration.openOwnerRequest(a.actor); lease.release();
  assert.throws(()=>integration.service.createCalendar(lease.context,'released',input),domainError('activity_owner_channel_required'));
  assert.equal(f.factories.adapters.filter(adapter=>adapter.category==='activity').length,1);
}, {mode:'source-only',activityCommands:'owner-input'}));

test('owner Activity rechecks revoked session after body await and creates no calendar or receipt', t => fixture(t, async f => {
  const [a]=f.users;
  const request=paused(f,'/v1/activity/calendar',a,{timeZone:'America/New_York',confirmed:true});
  await request.ready;
  f.backend.db.prepare('DELETE FROM session WHERE id=?').run(a.actor.sessionId);
  request.finish(); const response=await request.result;
  assert.equal(response.status,401);
  assert.equal((f.backend.db.prepare('SELECT count(*) n FROM activity_calendar').get() as {n:number}).n,0);
  assert.equal((f.backend.db.prepare("SELECT count(*) n FROM command_receipts WHERE operation LIKE 'activity.%'").get() as {n:number}).n,0);
}, {mode:'source-only',activityCommands:'owner-input'}));


const boardInput = {title:'Larger exercise labels',description:'Please offer larger labels for exercise selection.',category:'accessibility',
 policyVersion:'form_feature_board_v1',policyAccepted:true,audienceAccepted:true};
const boardConfig: SourceRequestFactoryConfiguration = {mode:'source-only',communityModules:'b2-b4-b5'};
test('feature board maintained auth keeps pending submissions private without a group invitation limiter', t => fixture(t, async f => {
 const [a,b]=f.users;
 assert.equal((await f.backend.handleRequest(new Request(origin+'/v1/community/board/features'),'127.0.0.1')).status,401);
 const capabilities=await f.request('/v1/community/board/capabilities',a);
 assert.equal(capabilities.status,200); assert.equal(capabilities.headers.get('cache-control'),'no-store');
 const first=await f.request('/v1/community/board/features',a,'POST',boardInput,'board-submit');
 assert.equal(first.status,201); const submitted=await first.json() as {id:string;featureId:string;revision:number;visibility:string};
 assert.equal(submitted.visibility,'pending');
 const replay=await f.request('/v1/community/board/features',a,'POST',boardInput,'board-submit');
 assert.equal(replay.status,201);assert.deepEqual(await replay.json(),submitted);
 const own=await (await f.request('/v1/community/board/features',a)).json() as {features:{id:string;voteCount:number}[]};
 assert.equal(own.features.length,1);assert.equal(own.features[0]?.voteCount,0);
 const other=await (await f.request('/v1/community/board/features',b)).json() as {features:unknown[]};assert.deepEqual(other.features,[]);
 assert.equal((await f.request('/v1/community/board/features/'+submitted.featureId,b)).status,404);
 assert.equal((await f.request('/v1/community/board/submissions/'+submitted.id+'/withdraw',b,'POST',{expectedRevision:submitted.revision},'foreign-withdraw')).status,404);
 assert.equal((await f.request('/v1/community/groups',a)).status,503);
 assert.equal((await f.request('/v1/community/board/unrecognized',a)).status,404);
 assert.equal((await f.request('/v1/community/board/features',a,'POST',{...boardInput,accountId:b.actor.accountId},'injected-board')).status,422);
},boardConfig));

test('feature board uses feature vote revision and submission withdrawal revision with account-isolated voter sets', t => fixture(t, async f => {
 const [a,b]=f.users;
 const submitted=await (await f.request('/v1/community/board/features',a,'POST',boardInput,'vote-source')).json() as {id:string;featureId:string;revision:number};
 const detail=await (await f.request('/v1/community/board/features/'+submitted.featureId,a)).json() as {feature:{revision:number}};
 const vote={active:true,expectedRevision:detail.feature.revision};
 const first=await f.request('/v1/community/board/features/'+submitted.featureId+'/vote',a,'POST',vote,'vote-exact');
 assert.equal(first.status,200);const result=await first.json();
 assert.deepEqual(await (await f.request('/v1/community/board/features/'+submitted.featureId+'/vote',a,'POST',vote,'vote-exact')).json(),result);
 assert.equal((await f.request('/v1/community/board/features/'+submitted.featureId+'/vote',b,'POST',vote,'cross-vote')).status,404);
 const own=await (await f.request('/v1/community/board/features/'+submitted.featureId,a)).json() as {feature:{voteCount:number}};assert.equal(own.feature.voteCount,1);
 assert.equal((await f.request('/v1/community/board/submissions/'+submitted.id+'/withdraw',a,'POST',{expectedRevision:submitted.revision},'withdraw-source')).status,200);
 const hidden=await (await f.request('/v1/community/board/features',a)).json() as {features:unknown[]};assert.deepEqual(hidden.features,[]);
},boardConfig));

test('feature board body-await revocation denies original write and receipt before storage', t => fixture(t, async f => {
 const [a]=f.users;const request=paused(f,'/v1/community/board/features',a,boardInput,'POST','revoked-board');
 await request.ready;f.backend.db.prepare('DELETE FROM session WHERE id=?').run(a.actor.sessionId);request.finish();
 assert.equal((await request.result).status,401);
 assert.equal((f.backend.db.prepare('SELECT count(*) n FROM community_board_submissions').get() as {n:number}).n,0);
 assert.equal((f.backend.db.prepare('SELECT count(*) n FROM community_board_command_receipts').get() as {n:number}).n,0);
},boardConfig));

test('installed full Community lifecycle remains composed when request capabilities are absent', t => fixture(t, async f => {
  const minimal = createSourceRequestFactories({ db: f.backend.db, lifecycle: f.bindings, configuration: { mode: 'source-only' },
    subjectEligibilityFor: actor => createSubjectEligibilityProvider(f.backend.db, actor) });
  assert.equal(minimal.activity, undefined); assert.equal(minimal.activityIntegration, undefined);
  assert.throws(() => minimal.boardFor(f.users[0].actor), domainError('board_unavailable'));
  assert.throws(() => minimal.extensionFor(f.users[0].actor), domainError('community_extension_unavailable'));
  assert.throws(() => minimal.serviceFor(f.users[0].actor), domainError('community_limiter_unavailable'));
  const community = minimal.adapters.find(adapter => adapter.category === 'community')!;
  f.backend.db.transaction(() => {
    const inventory = community.inventory(f.users[0].actor);
    assert.equal(inventory.status, 'complete'); assert.ok('modules' in inventory);
    assert.deepEqual(Object.keys(inventory.modules as object).sort(), ['b2', 'b4', 'b5']);
    const restored = minimal.reconcileRestore({ ready: true, lookup: accountId => {
      const row = f.backend.db.prepare('SELECT state,epoch FROM account_lifecycle WHERE account_id=?').get(accountId) as { state: string; epoch: number } | undefined;
      return row?.state === 'active' ? { state: 'active', epoch: row.epoch } : undefined;
    } });
    assert.equal(restored.suppressed, 0);
    assert.deepEqual(community.purge('synthetic-unqualified', f.users[0].actor.accountId), {
      status: 'pending', reason: 'community_module_results_require_resolution',
      modules: {
        b2: { status: 'pending', reason: 'community_retention_order_and_purge_qualification_required' },
        b4: { status: 'pending', reason: 'community_b4_retention_order_and_purge_qualification_required' },
        b5: { status: 'pending', reason: 'board_retention_audit_redaction_order_unqualified' },
      },
    });
  }).immediate();
}));

for (const missing of ['community_group_policy', 'community_board_features', 'community_removal_snapshots']) {
  test(`request lifecycle composition refuses missing required ${missing}`, t => fixture(t, async f => {
    f.backend.db.exec(`DROP TABLE ${missing}`);
    assert.throws(() => createSourceRequestFactories({ db: f.backend.db, lifecycle: f.bindings,
      configuration: { mode: 'source-only' }, subjectEligibilityFor: actor => createSubjectEligibilityProvider(f.backend.db, actor) }),
    domainError('community_restore_schema_unavailable'));
  }));
}

test('actual remove route on schema 16 retains only the original member snapshot and exports it through the composed adapter', t => fixture(t, async f => {
  const [owner, member] = f.users, created = await group(f);
  assert.equal((f.backend.db.prepare('SELECT max(version) n FROM form_migrations').get() as { n: number }).n, 16);
  const membership = (await (await f.request('/v1/community/groups', member)).json() as GroupView[])
    .find(value => value.id === created.value.id)!;
  const path = `/v1/community/groups/${created.value.id}/members/${membership.memberId}/remove`;
  const removed = await f.request(path, owner, 'POST', { expectedRevision: 1 }, 'original-removal');
  assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { removed: true });
  const own = await f.request('/v1/community/me/removed-memberships', member);
  assert.equal(own.status, 200);
  const snapshot = await own.json() as { groupId: string; memberId: string; removedAt: string; groupLabel: { status: string; value?: string } }[];
  assert.equal(snapshot.length, 1); assert.equal(snapshot[0]!.groupId, created.value.id);
  assert.equal(snapshot[0]!.memberId, membership.memberId); assert.ok(snapshot[0]!.removedAt);
  assert.deepEqual(snapshot[0]!.groupLabel, { status: 'available', value: 'Synthetic group' });
  assert.deepEqual(await (await f.request('/v1/community/me/removed-memberships', owner)).json(), []);
  assert.equal((await f.request(path, owner, 'POST', { expectedRevision: 1 }, 'original-removal')).status, 200);
  assert.deepEqual(await (await f.request('/v1/community/me/removed-memberships', member)).json(), snapshot);
  const records: unknown[] = [], adapter = f.backend.lifecycle!.adapters.find(value => value.category === 'community')!;
  f.backend.db.transaction(() => {
    assert.equal(adapter.export(member.actor, { snapshotAtMs: Date.now(), append: (_category, value) => { records.push(value); } }).status, 'complete');
  }).immediate();
  assert.match(JSON.stringify(records), /own_removal_snapshot/);
  assert.match(JSON.stringify(records), /Synthetic group/);
}));
