import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupAndVerify } from '../../src/storage.js';
import { DomainError } from '../../src/errors.js';
import { ACCOUNT_EXPORT_MAX_BYTES } from '../../src/lifecycle/export.js';
import { COMMUNITY_EXPORT_MAX_BYTES, shareFields, allFalse } from '../../src/community/index.js';
import { prepareAdmission } from '../../src/runtime-modules/admission.js';
import { fileDigest } from '../../src/runtime-modules/files.js';
import { deployment, provision, start, users, request, login, emails, password, readAdmission, boardInput, type Deployment, type User } from './fixture.js';
import { populateCommunity } from './community-fixture.js';
import { usefulActivity } from './http-fixture.js';
import { disable } from './lifecycle-fixture.js';

type Server = Awaited<ReturnType<typeof start>>['server'];
async function exportGrant(server: Server, actor: User): Promise<string> {
  const response = await request(server, '/v1/me/account-action-grants', actor, 'POST', { purpose: 'account_export', password });
  assert.equal(response.status, 201);
  return (await response.json() as { grant: string }).grant;
}
function prepareFullBarrier(d: Deployment, mode: 'restore' | 'recovery'): void {
  const predecessor = readAdmission(d);
  prepareAdmission({ configuration: d.configuration, mainPath: d.path, mode, operationId: randomUUID(),
    expectedRevision: predecessor.revision as number, expectedGeneration: predecessor.databaseGeneration as number,
    expectedPredecessorDigest: predecessor.closedDigest as string, expectedCandidateDigest: fileDigest(d.path, d.configuration.ownerUid),
    reason: 'synthetic v6 late-boundary regression', provenance: 'exact maintained task-owned fixture', oldWriterStopped: true });
}
function rows(db: Database.Database, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

for (const mutation of ['session', 'suppression', 'epoch'] as const) {
  test(`v6 callable facade: actual post-COMMIT ${mutation} denies HTTP bytes with immutable actor`, async t => {
    const d = await deployment(t); await provision(d);
    const { server, owner } = await start(d, { publicSynthetic: true }), [a] = await users(server);
    server.db.prepare('UPDATE "user" SET name=? WHERE id=?').run('V6-PRIVATE-EXPORT-MARKER', a.actor.authUserId);
    const actorBefore = { ...a.actor }, grant = await exportGrant(server, a);
    const db = server.db, original = db.transaction, realTransaction = original.bind(db);
    let armed = true, fired = 0, outside = false;
    const transaction = (fn: Parameters<typeof db.transaction>[0]) => {
      const real = realTransaction(fn);
      const deferred = (...args: unknown[]) => {
        const result: unknown = Reflect.apply(real.deferred, real, args);
        if (armed && typeof result === 'object' && result !== null && 'json' in result && 'bytes' in result) {
          assert.equal(db.inTransaction, false, 'snapshot must have actually committed');
          outside = !db.inTransaction; armed = false; fired++;
          if (mutation === 'session') db.prepare('DELETE FROM session WHERE id=?').run(a.actor.sessionId);
          else if (mutation === 'epoch') db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(a.actor.accountId);
          else owner.ledger.recordDisable({ accountId: a.actor.accountId, authUserId: a.actor.authUserId, epoch: 1,
            requestId: 'synthetic-v6-after-snapshot', disabledAtMs: Date.now() });
        }
        return result;
      };
      return Object.assign((...args: unknown[]) => Reflect.apply(real, real, args), {
        default: real.default, immediate: real.immediate, exclusive: real.exclusive, database: (real as typeof real & { database: Database.Database }).database, deferred,
      });
    };
    db.transaction = transaction as typeof db.transaction;
    try {
      const response = await request(server, '/v1/me/account-export', a, 'POST', { grant });
      const text = await response.text(), code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? 'missing_error';
      assert.equal(response.status, mutation === 'session' ? 401 : 403, `status=${response.status}, error=${code}`);
      assert.equal(code, mutation === 'session' ? 'account_session_invalid' : mutation === 'epoch' ? 'account_epoch_changed' : 'account_disabled');
      assert.equal(fired, 1); assert.equal(armed, false); assert.equal(outside, true); assert.equal(db.inTransaction, false);
      assert.equal(text.includes('records'), false); assert.equal(text.includes('V6-PRIVATE-EXPORT-MARKER'), false);
      assert.ok(Object.isFrozen(a.actor)); assert.deepEqual(a.actor, actorBefore);
    } finally { db.transaction = original; }
  });
}

test('v6 successful export retains safe projection, owner isolation, caps and incomplete manifest', async t => {
  const d = await deployment(t); await provision(d);
  const { server } = await start(d, { publicSynthetic: true, textSynthetic: true }), [a, b] = await users(server);
  await usefulActivity(server, a); const population = await populateCommunity(server, a, b);
  server.db.prepare('UPDATE "user" SET name=? WHERE id=?').run('V6-OTHER-PRIVATE-MARKER', b.actor.authUserId);
  const grant = await exportGrant(server, a), response = await request(server, '/v1/me/account-export', a, 'POST', { grant });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition')!, /attachment/);
  const text = await response.text(); assert.ok(Buffer.byteLength(text) <= ACCOUNT_EXPORT_MAX_BYTES);
  for (const value of ['V6-OTHER-PRIVATE-MARKER', 'Other private report', 'Other private appeal', b.token, password, 'exact_jws', 'status_token_hash', 'bodyAssessment']) assert.equal(text.includes(value), false);
  for (const value of ['Owner private exercise', 'OWNER-PRIVATE-POST', 'featureBoard', 'community-b4']) assert.ok(text.includes(value), value);
  const exported = JSON.parse(text) as { manifest: { complete: boolean; categories: { category: string }[] } };
  assert.equal(exported.manifest.complete, false);
  for (const category of ['activity', 'community']) assert.ok(exported.manifest.categories.some(value => value.category === category));
  assert.equal((server.db.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(population.board.id) as { visibility: string }).visibility, 'pending');
  const settings = await (await request(server, '/v1/me/settings', a)).json() as { capabilities: { accountDeletion: { supported: boolean } } };
  assert.equal(settings.capabilities.accountDeletion.supported, false);
});

for (const cap of ['total', 'community'] as const) {
  test(`v6 HTTP ${cap} export cap refuses bytes without a complete claim`, async t => {
    const d = await deployment(t); await provision(d);
    const { server } = await start(d, { publicSynthetic: true, textSynthetic: true }), [a, b] = await users(server);
    if (cap === 'total') server.db.prepare('UPDATE "user" SET name=? WHERE id=?').run('x'.repeat(ACCOUNT_EXPORT_MAX_BYTES + 1), a.actor.authUserId);
    else {
      const population = await populateCommunity(server, a, b), now = new Date().toISOString(), expires = new Date(Date.now() + 86400000).toISOString();
      server.db.transaction(() => {
        for (let i = 0; i < 1200; i++) server.db.prepare("INSERT INTO community_posts VALUES(?,?,1,?,1,1,'win',NULL,?,'pending','community-v1',?,?)")
          .run(randomUUID(), population.group.id, a.actor.accountId, 'x'.repeat(2000), now, expires);
      }).immediate();
      assert.equal(COMMUNITY_EXPORT_MAX_BYTES, 2097152);
    }
    const grant = await exportGrant(server, a), response = await request(server, '/v1/me/account-export', a, 'POST', { grant });
    assert.equal(response.status, 413);
    const text = await response.text(); assert.equal(text.includes('records'), false); assert.equal(text.includes('"complete":true'), false);
    if (cap === 'total') assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, 'account_export_packaging_required');
  });
}

test('v6 populated backup resets all B2/B4/B5 authority including active assigned preferences, preserving history', async t => {
  const d = await deployment(t); await provision(d);
  const first = await start(d, { publicSynthetic: true, textSynthetic: true }), [a, b] = await users(first.server);
  await usefulActivity(first.server, a); const population = await populateCommunity(first.server, a, b), db = first.server.db;
  const created = await request(first.server, '/v1/community/groups', b, 'POST', { name: 'Active owner group', alias: 'Active', membershipDisclosureAccepted: true }, 'v6-active-group');
  assert.equal(created.status, 201); const activeGroup = await created.json() as { id: string };
  assert.equal((await request(first.server, `/v1/community/groups/${population.group.id}/leave`, b, 'POST', {}, 'v6-leave-suppressed-owner')).status, 200);
  assert.equal((await request(first.server, `/v1/community/groups/${activeGroup.id}/me/sharing`, b, 'PATCH', { expectedRevision: 1, flags: { ...allFalse(), workout: true } }, 'v6-active-sharing')).status, 200);
  db.prepare('INSERT INTO community_motion_electorate VALUES(?,?,1,1)').run(population.motion, a.actor.accountId);
  db.prepare("INSERT INTO community_ballots VALUES(?,?,1,'yes',?)").run(population.motion, a.actor.accountId, new Date().toISOString());
  db.prepare('INSERT INTO community_profile_shares VALUES(?,?,1,1,?,?)').run(activeGroup.id, b.actor.accountId, JSON.stringify({ revision: 1, flags: { age: false, sex: false, region: true, avatar: false, adherence: false, ranking: false }, sexDescription: null, region: 'EU', avatar: null }), new Date().toISOString());
  db.prepare('INSERT INTO community_post_cursors VALUES(?,?,?,1,1,?,?,?)').run(randomUUID(), b.actor.accountId, activeGroup.id, new Date().toISOString(), population.post, new Date(Date.now() + 86400000).toISOString());
  const issued = await request(first.server, `/v1/community/groups/${activeGroup.id}/invitations`, b, 'POST', {}, 'v6-active-invite');
  assert.equal(issued.status, 201); const invitation = await issued.json() as { id: string; token: string };
  const now = new Date().toISOString(), assigned = randomUUID();
  const preferences = (db.prepare('SELECT preferences FROM community_match_enrollments WHERE account_id=?').get(a.actor.accountId) as { preferences: string }).preferences;
  db.prepare("INSERT INTO community_match_enrollments VALUES(?,?,1,1,'assigned',?,?,?,NULL,0)").run(assigned, b.actor.accountId, preferences, now, now);
  db.prepare('INSERT INTO community_match_assignments VALUES(?,?,1,1,?,?,?,1,?,?)').run(randomUUID(), assigned, population.run, activeGroup.id, b.actor.accountId, '[]', now);
  db.prepare("INSERT INTO community_motions SELECT ?,group_id,group_generation,sponsor_account_id,sponsor_generation,kind,subject_account_id,subject_generation,places,revision,electorate_size,required_yes,'review_pending',created_at,expires_at,finalized_at FROM community_motions WHERE id=?").run(randomUUID(), population.motion);
  const submitted = await request(first.server, '/v1/community/board/features', b, 'POST', { ...boardInput, title: 'Withdrawn historical request' }, 'v6-withdrawn');
  assert.equal(submitted.status, 201); const withdrawn = await submitted.json() as { id: string };
  db.prepare("UPDATE community_board_submissions SET visibility='withdrawn' WHERE id=?").run(withdrawn.id);
  const grant = await exportGrant(first.server, b);
  db.prepare('INSERT INTO verification VALUES(?,?,?,?,?,?)').run(randomUUID(), 'reset-password-v6', 'synthetic-old-ticket', Date.now() + 600000, Date.now(), Date.now());
  for (const table of ['session', 'account_action_grants', 'verification', 'community_command_receipts', 'community_extension_receipts', 'community_post_cursors', 'community_profile_shares', 'community_ballots', 'community_board_command_receipts']) assert.ok(rows(db, table).length > 0, table);
  assert.equal((db.prepare('SELECT state FROM community_match_enrollments WHERE id=?').get(assigned) as { state: string }).state, 'assigned');
  const historical = ['community_members', 'community_match_assignments', 'community_board_quota_events', 'community_board_vote_events', 'community_board_aliases', 'community_reports', 'community_appeals'];
  const counts = new Map(historical.map(table => [table, rows(db, table).length]));
  const backup = join(d.root, 'v6-populated.sqlite'); await backupAndVerify(db, backup);
  const disabled = await disable(first.server, a); assert.equal(disabled.response.status, 200);
  await first.server.close(); writeFileSync(d.path, readFileSync(backup)); prepareFullBarrier(d, 'restore');
  const second = await start(d), restored = second.server.db;
  for (const table of ['session', 'account_action_grants', 'verification', 'community_command_receipts', 'community_extension_receipts', 'community_post_cursors', 'community_profile_shares', 'community_ballots', 'community_board_command_receipts']) assert.equal(rows(restored, table).length, 0, table);
  for (const sql of [
    'SELECT 1 FROM community_board_votes WHERE active=1',
    "SELECT 1 FROM community_posts WHERE state<>'hidden' OR text IS NOT NULL",
    'SELECT 1 FROM community_reactions WHERE active=1',
    "SELECT 1 FROM community_motions WHERE state IN('open','review_pending')",
    "SELECT 1 FROM community_seat_reservations WHERE state='available'",
    "SELECT 1 FROM community_match_runs WHERE state='frozen'",
    "SELECT 1 FROM community_match_enrollments WHERE state='queued' OR preferences IS NOT NULL",
    'SELECT 1 FROM community_motion_electorate WHERE active=1',
  ]) assert.equal(restored.prepare(sql).get(), undefined, sql);
  assert.deepEqual(restored.prepare('SELECT state,preferences,revision FROM community_match_enrollments WHERE id=?').get(assigned), { state: 'cancelled', preferences: null, revision: 2 });
  assert.equal((restored.prepare('SELECT visibility FROM community_board_submissions WHERE id=?').get(withdrawn.id) as { visibility: string }).visibility, 'withdrawn');
  assert.deepEqual(restored.prepare('SELECT visibility,restore_barrier,suppressed_epoch FROM community_board_submissions WHERE id=?').get(population.board.id), { visibility: 'hidden', restore_barrier: 1, suppressed_epoch: 1 });
  for (const field of shareFields) assert.equal(restored.prepare(`SELECT 1 FROM community_share_settings WHERE ${field}<>0 OR ${field}_enabled_at IS NOT NULL`).get(), undefined, field);
  assert.equal(restored.prepare("SELECT 1 FROM community_invitations WHERE state='pending'").get(), undefined);
  assert.equal((restored.prepare('SELECT state FROM community_invitations WHERE id=?').get(invitation.id) as { state: string }).state, 'revoked');
  for (const table of historical) assert.equal(rows(restored, table).length, counts.get(table), table);
  assert.equal((restored.prepare('SELECT state FROM account_lifecycle WHERE account_id=?').get(a.actor.accountId) as { state: string }).state, 'disabled');
  for (const actor of [a, b]) assert.equal((await request(second.server, '/v1/me', actor)).status, 401);
  await assert.rejects(() => login(second.server, emails[0]));
  assert.throws(() => second.server.lifecycle!.status(disabled.requestId, disabled.statusSecret));
  const fresh = await login(second.server, emails[1]); assert.equal((await request(second.server, '/v1/me', fresh)).status, 200);
  const disabledExport = await request(second.server, '/v1/me/account-export', fresh, 'POST', { grant });
  assert.equal(disabledExport.status, 501);
  assert.equal((await disabledExport.json() as { error: { code: string } }).error.code, 'staged_account_lifecycle_unavailable');
  assert.throws(() => second.server.lifecycle!.consumeExportGrant(fresh.actor, grant),
    error => error instanceof DomainError && error.status === 403);
  const joined = await request(second.server, '/v1/community/invitations/join', fresh, 'POST', { token: invitation.token, alias: 'Fresh', membershipDisclosureAccepted: true }, 'v6-old-invite');
  assert.notEqual(joined.status, 201);
  assert.equal((restored.prepare('SELECT count(*) n FROM activity_entries WHERE account_id=?').get(a.actor.accountId) as { n: number }).n, 1);
});

for (const failure of ['transaction-fault', 'b2-receipt-owner', 'b5-receipt-owner'] as const) {
  test(`v6 full restore holds ${failure} with no admitted partial reset`, async t => {
    const d = await deployment(t); await provision(d);
    const first = await start(d, { publicSynthetic: true, textSynthetic: true }), [a, b] = await users(first.server);
    const population = await populateCommunity(first.server, a, b), db = first.server.db;
    if (failure === 'b2-receipt-owner') db.prepare('INSERT INTO community_command_receipts VALUES(?,?,?,?,?,201,?,1,?)')
      .run('v6-unmapped-receipt-owner', 'synthetic', 'v6', null, 'a'.repeat(64), population.group.id, new Date().toISOString());
    if (failure === 'b5-receipt-owner') db.prepare('INSERT INTO community_board_command_receipts VALUES(?,?,?,?,?,?)')
      .run('v6-unmapped-receipt-owner', 'synthetic', 'v6', 'a'.repeat(64), population.board.id, new Date().toISOString());
    const tables = ['session', 'community_command_receipts', 'community_extension_receipts', 'community_board_command_receipts', 'community_match_enrollments', 'community_board_submissions', 'community_posts'];
    const before = new Map(tables.map(table => [table, rows(db, table)]));
    await first.server.close(); prepareFullBarrier(d, 'recovery'); let fired = 0;
    await assert.rejects(() => start(d, failure === 'transaction-fault' ? { fault: point => {
      if (point === 'barrier:community') { fired++; throw new Error('synthetic-v6-rollback'); }
    } } : {}), error => error instanceof Error && error.message.includes(failure === 'transaction-fault' ? 'synthetic-v6-rollback' : 'community_restore_authority_required'));
    assert.equal(fired, failure === 'transaction-fault' ? 1 : 0); assert.notEqual(readAdmission(d).state, 'running');
    const check = new Database(d.path, { readonly: true });
    try { for (const table of tables) assert.deepEqual(rows(check, table), before.get(table), table); }
    finally { check.close(); }
  });
}

test('v6 missing authoritative account view cannot conceal receipts or apply partial resets', async t => {
  const d = await deployment(t); await provision(d);
  const { server } = await start(d, { textSynthetic: true }), [a, b] = await users(server);
  await populateCommunity(server, a, b);
  const tables = ['community_command_receipts', 'community_extension_receipts', 'community_board_command_receipts', 'community_posts', 'community_share_settings'];
  const before = new Map(tables.map(table => [table, rows(server.db, table)]));
  assert.throws(() => server.db.transaction(() => server.reconcileModulesRestore!({ ready: true, lookup: () => undefined })).immediate(),
    error => error instanceof Error && error.message === 'community_restore_authority_required');
  assert.equal(server.db.inTransaction, false);
  for (const table of tables) assert.deepEqual(rows(server.db, table), before.get(table), table);
});

test('v6 clean restart preserves active receipts, cursors and assigned consent while replaying independent suppression', async t => {
  const d = await deployment(t); await provision(d);
  const first = await start(d, { publicSynthetic: true, textSynthetic: true }), [a, b] = await users(first.server);
  const population = await populateCommunity(first.server, a, b);
  first.server.db.prepare("UPDATE community_match_enrollments SET state='assigned' WHERE account_id=?").run(a.actor.accountId);
  const tables = ['community_command_receipts', 'community_extension_receipts', 'community_board_command_receipts', 'community_post_cursors', 'community_match_enrollments', 'community_profile_shares', 'community_share_settings'];
  const before = new Map(tables.map(table => [table, rows(first.server.db, table)]));
  for (const table of tables) assert.ok(before.get(table)!.length > 0, table);
  await first.server.close(); const second = await start(d);
  for (const table of tables) assert.deepEqual(rows(second.server.db, table), before.get(table), table);
  assert.equal((await request(second.server, '/v1/me', a)).status, 200);
  second.owner.ledger.recordDisable({ accountId: b.actor.accountId, authUserId: b.actor.authUserId, epoch: 1, requestId: 'synthetic-v6-clean-suppression', disabledAtMs: Date.now() });
  await second.server.close(); const third = await start(d);
  assert.equal((third.server.db.prepare('SELECT state FROM account_lifecycle WHERE account_id=?').get(b.actor.accountId) as { state: string }).state, 'disabled');
  assert.equal((await request(third.server, '/v1/me', b)).status, 401);
  assert.equal((await request(third.server, '/v1/me', a)).status, 200);
  assert.equal((third.server.db.prepare('SELECT state FROM community_match_enrollments WHERE account_id=?').get(a.actor.accountId) as { state: string }).state, 'assigned');
  assert.equal((third.server.db.prepare('SELECT state FROM community_groups WHERE id=?').get(population.group.id) as { state: string }).state, 'active');
  assert.deepEqual(third.server.db.prepare('SELECT * FROM community_extension_receipts WHERE account_id=? ORDER BY rowid').all(a.actor.accountId), before.get('community_extension_receipts'));
});
