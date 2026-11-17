import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../src/storage.js';
import { DomainError } from '../src/errors.js';
import { buildAccountExport } from '../src/lifecycle/export.js';
import { lifecyclePolicy } from '../src/lifecycle/service.js';
import { source26Fixture, A, B, requestId } from './lifecycle-reauthentication-fixture.js';
import type { SourceActionVerify, SourceActionIssue } from '../src/lifecycle/types.js';

const issue = { purpose: 'account_export', method: 'email_action_code', requestKey: 'email-one' } as const;
const denied = (error: unknown) => error instanceof DomainError && /^action_(reauthentication|grant)_/.test(error.code);
async function grant(f: ReturnType<typeof source26Fixture>, purpose: 'account_delete' | 'account_export' = 'account_export', method: 'email_action_code' | 'phone_action_code' = 'email_action_code') {
  const challenge = await f.source.issueChallenge(A, { ...issue, purpose, method });
  const result = f.source.verifyChallenge(A, { challengeId: challenge.challengeId, purpose, code: f.code() });
  return { challenge, result };
}

test('verified primary email uses genuine random delivery/MAC, durable unique proof and one-use real export', async t => {
  const f = source26Fixture(t), b = f.bBytes();
  const c = await f.source.issueChallenge(A, issue);
  assert.equal(c.state, 'ready'); assert.equal(f.sends(), 1);
  assert.ok(/^[0-9]{8}$/.test(f.code()), 'actual generated code has the fixed shape');
  assert.deepEqual(await f.source.issueChallenge(A, issue), c); assert.equal(f.sends(), 1);
  const g = f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() });
  assert.equal(g.method, 'email_action_code'); assert.ok(/^[A-Za-z0-9_-]{43}$/.test(g.grant), 'fresh grant shape');
  assert.equal(f.db.prepare('SELECT count(*) n FROM account_action_proof_consumptions').get() && f.challenge().state, 'consumed');
  const durable = f.db.prepare('SELECT grant_hash FROM account_action_proof_consumptions').get() as { grant_hash: string };
  assert.ok(durable.grant_hash === hash(g.grant), 'only the token hash is durable');
  assert.throws(() => f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() }), denied);
  assert.throws(() => f.source.lifecycle.consumeExportGrant(A, g.grant), denied, 'v1 is password-only on26');
  f.source.consumeExportGrant(A, { grant: g.grant });
  let checks = 0;
  const exported = buildAccountExport(f.db, A, actor => { checks++; f.source.lifecycle.assertActive(actor); }, f.source.lifecycle.adapters);
  assert.equal(checks, 2, 'actual export checks authority before snapshot and after commit');
  assert.ok(exported.bytes > 0); assert.equal(exported.complete, false);
  assert.ok(!/code_mac|subject_digest|provenance_digest|grant_hash|key_id|account_action_challenge|proof_digest|deletion_request_id/.test(exported.json), 'export omits security metadata');
  assert.throws(() => f.source.consumeExportGrant(A, { grant: g.grant }), denied);
  assert.equal(f.bBytes(), b);
});

test('bound phone provenance is user-indexed, requires the real phone-login relation and proves a fresh action code', async t => {
  const f = source26Fixture(t); f.phone();
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM phone_challenges INDEXED BY action_phone_provenance
    WHERE auth_user_id=? AND phone=? AND status='consumed' AND approved_at IS NOT NULL ORDER BY approved_at DESC,id LIMIT 1`).all(A.authUserId, '+15555550126');
  assert.match(JSON.stringify(plan), /SEARCH.*action_phone_provenance/);
  const { result } = await grant(f, 'account_export', 'phone_action_code');
  assert.equal(result.method, 'phone_action_code'); f.source.consumeExportGrant(A, { grant: result.grant });
  assert.equal(f.budget().verify_count, 1);
});

test('contact eligibility excludes placeholders, unverified email and every nonnull same-user credential password', async t => {
  for (const kind of ['placeholder', 'unverified', 'empty-password', 'malformed-password'] as const) {
    const f = source26Fixture(t);
    if (kind === 'placeholder') f.db.prepare('UPDATE "user" SET email=? WHERE id=?').run('anything@PHONE.FORM.INVALID', A.authUserId);
    if (kind === 'unverified') f.db.prepare('UPDATE "user" SET emailVerified=0 WHERE id=?').run(A.authUserId);
    if (kind.endsWith('password')) f.db.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('credential-a','credential-a','credential',?,?,1,1)")
      .run(A.authUserId, kind === 'empty-password' ? '' : 'unverifiable');
    await assert.rejects(f.source.issueChallenge(A, issue), denied);
    assert.equal(f.sends(), 0); assert.equal(f.budget().request_count, 1, 'bounded eligibility rejection commits its request charge'); f.cleanup();
  }
});

test('phone never infers ownership from a current number or foreign/unbound/changed historical provenance', async t => {
  for (const kind of ['unbound', 'foreign', 'relation', 'unapproved'] as const) {
    const f = source26Fixture(t); f.phone();
    if (kind === 'unbound') f.db.prepare('UPDATE phone_challenges SET auth_user_id=NULL').run();
    if (kind === 'foreign') f.db.prepare('UPDATE phone_challenges SET auth_user_id=?').run(B.authUserId);
    if (kind === 'relation') f.db.prepare('UPDATE "user" SET email=? WHERE id=?').run('real@synthetic.invalid', A.authUserId);
    if (kind === 'unapproved') f.db.prepare('UPDATE phone_challenges SET approved_at=NULL').run();
    await assert.rejects(f.source.issueChallenge(A, { ...issue, method: 'phone_action_code' }), denied);
    assert.equal(f.sends(), 0); f.cleanup();
  }
});

test('wrong, malformed, foreign, unknown and wrong-purpose checks commit account attempts before throwing', async t => {
  const f = source26Fixture(t), c = await f.source.issueChallenge(A, issue);
  const own = { challengeId: c.challengeId, purpose: issue.purpose, code: 'not-code' };
  assert.throws(() => f.source.verifyChallenge(A, own), denied);
  assert.equal(f.budget().verify_count, 1); assert.equal(f.challenge().attempt_count, 1);
  assert.throws(() => f.source.verifyChallenge(A, { ...own, code: '00000000' === f.code() ? '00000001' : '00000000' }), denied);
  assert.equal(f.budget().verify_count, 2);
  assert.throws(() => f.source.verifyChallenge(B, { ...own, code: f.code() }), denied);
  assert.equal(f.budget(B).verify_count, 1); assert.equal(f.budget().verify_count, 2);
  assert.throws(() => f.source.verifyChallenge(A, { ...own, purpose: 'account_delete', code: f.code() }), denied);
  assert.throws(() => f.source.verifyChallenge(A, { ...own, challengeId: 'unknown-challenge', code: f.code() }), denied);
  assert.equal(f.budget().verify_count, 4);
  const g = f.source.verifyChallenge(A, { ...own, code: f.code() }); assert.ok(g.grant.length === 43);
  assert.equal(f.budget().verify_count, 5);
  assert.throws(() => f.source.verifyChallenge(A, { ...own, code: f.code() }), denied);
  assert.equal(f.budget().verify_count, 5);
});

test('three wrong challenge checks exhaust that challenge, while replacement and session rotation share account budgets', async t => {
  const f = source26Fixture(t), c = await f.source.issueChallenge(A, issue);
  const wrong = f.code() === '00000000' ? '00000001' : '00000000';
  for (let n = 0; n < 3; n++) assert.throws(() => f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: wrong }), denied);
  assert.equal(f.challenge().state, 'failed'); assert.equal(f.budget().verify_count, 3);
  const rotated = { ...A, sessionId: 'rotated-action-a' };
  f.db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,1,1)').run(rotated.sessionId, A.authUserId, 'synthetic-rotated', f.now() + 1000000);
  const replacement = await f.source.issueChallenge(rotated, { ...issue, requestKey: 'replacement' });
  assert.throws(() => f.source.verifyChallenge(A, { challengeId: replacement.challengeId, purpose: issue.purpose, code: f.code() }), denied);
  assert.equal(f.budget().verify_count, 4);
  f.source.verifyChallenge(rotated, { challengeId: replacement.challengeId, purpose: issue.purpose, code: f.code() });
  assert.equal(f.budget().verify_count, 5); assert.equal(f.budget().send_count, 2);
});

test('contact, credential and phone-provenance ABA invalidate minted and pending authority', async t => {
  for (const kind of ['email', 'credential', 'phone'] as const) {
    const f = source26Fixture(t); if (kind === 'phone') f.phone();
    const { result } = await grant(f, 'account_export', kind === 'phone' ? 'phone_action_code' : 'email_action_code');
    const before = f.budget().binding_revision!;
    if (kind === 'email') {
      f.db.prepare('UPDATE "user" SET email=? WHERE id=?').run('replacement@synthetic.invalid', A.authUserId);
      f.db.prepare('UPDATE "user" SET email=? WHERE id=?').run(`${A.authUserId}@synthetic.invalid`, A.authUserId);
    } else if (kind === 'credential') {
      f.db.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('new-credential','new-credential','credential',?,NULL,1,1)").run(A.authUserId);
      f.db.prepare("DELETE FROM account WHERE id='new-credential'").run();
    } else {
      f.db.prepare('UPDATE phone_challenges SET provider_sid=?').run('changed-provider-sid');
      f.db.prepare('UPDATE phone_challenges SET provider_sid=?').run('synthetic-provider-sid');
    }
    assert.ok(f.budget().binding_revision! >= before + 2);
    assert.throws(() => f.source.consumeExportGrant(A, { grant: result.grant }), denied); f.cleanup();
  }
});

test('session, purpose, epoch, expiry, lost key and wrong-size keys cannot mint or use a dedicated grant', async t => {
  for (const kind of ['key-missing', 'key-short', 'expiry', 'epoch', 'session'] as const) {
    const f = source26Fixture(t), c = await f.source.issueChallenge(A, issue);
    if (kind === 'key-missing') f.keyState.missing = true;
    if (kind === 'key-short') f.keyState.length = 31;
    if (kind === 'expiry') f.advance(300000);
    if (kind === 'epoch') f.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(A.accountId);
    if (kind === 'session') f.db.prepare('DELETE FROM session WHERE id=?').run(A.sessionId);
    assert.throws(() => f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() }));
    assert.equal((f.db.prepare('SELECT count(*) n FROM account_action_proof_consumptions').get() as { n: number }).n, 0); f.cleanup();
  }
});

test('mint SQL failures before and after grant insertion retain separately committed request and attempt charges', async t => {
  for (const point of ['grant', 'proof'] as const) {
    const f = source26Fixture(t), c = await f.source.issueChallenge(A, issue), prepare = f.db.prepare.bind(f.db);
    f.db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if ((point === 'grant' && sql.startsWith('INSERT INTO account_action_grants')) || (point === 'proof' && sql.startsWith('INSERT INTO account_action_proof_consumptions'))) {
        const run = statement.run.bind(statement);
        statement.run = ((...args: unknown[]) => { args[point === 'grant' ? 1 : 3] = point === 'grant' ? 'absent-account' : -1; return run(...args); }) as typeof statement.run;
      }
      return statement;
    }) as typeof f.db.prepare;
    try { assert.throws(() => f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() }), denied); }
    finally { f.db.prepare = prepare; }
    assert.equal(f.budget().verify_count, 1); assert.equal(f.budget().request_count, 2); assert.equal(f.challenge().attempt_count, 1);
    assert.equal((f.db.prepare('SELECT count(*) n FROM account_action_grants').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) n FROM account_action_proof_consumptions').get() as { n: number }).n, 0);
    f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() });
    assert.equal(f.budget().verify_count, 2); f.cleanup();
  }
});

test('enclosing transactions and structural oversized inputs cannot roll back a charged ceremony', async t => {
  const f = source26Fixture(t), c = await f.source.issueChallenge(A, issue), before = f.budget();
  const input: SourceActionVerify = { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() };
  f.db.transaction(() => { assert.throws(() => f.source.verifyChallenge(A, input), denied); }).immediate();
  assert.deepEqual(f.budget(), before);
  assert.throws(() => f.source.verifyChallenge(A, { ...input, code: 'x'.repeat(257) }), denied);
  assert.deepEqual(f.budget(), before);
  assert.throws(() => f.source.verifyChallenge(A, { ...input, extra: true } as SourceActionVerify), denied);
  await assert.rejects(f.source.issueChallenge(A, { ...issue, destination: 'foreign@synthetic.invalid' } as SourceActionIssue), denied);
});

test('request/send/verify windows are durable anchored limits with exact rollover and no clock rollback refund', async t => {
  const f = source26Fixture(t);
  for (let i = 0; i < 3; i++) await f.source.issueChallenge(A, { ...issue, requestKey: `send-${i}` });
  await assert.rejects(f.source.issueChallenge(A, { ...issue, requestKey: 'fourth-send' }), denied);
  assert.equal(f.budget().send_count, 3);
  for (let i = 0; i < 16; i++) await f.source.issueChallenge(A, { ...issue, requestKey: 'send-2' });
  assert.equal(f.budget().request_count, 20);
  await assert.rejects(f.source.issueChallenge(A, { ...issue, requestKey: 'send-2' }), denied);
  assert.equal(f.budget().request_count, 20);
  f.advance(900000); await assert.rejects(f.source.issueChallenge(A, { ...issue, requestKey: 'still-send-limited' }), denied);
  assert.equal(f.budget().request_count, 1); assert.equal(f.budget().send_count, 3);
  f.advance(2700000); await f.source.issueChallenge(A, { ...issue, requestKey: 'new-hour' });
  assert.equal(f.budget().send_count, 1);
  f.advance(-1); await assert.rejects(f.source.issueChallenge(A, { ...issue, requestKey: 'rollback' }), denied);
});

test('export failure and post-commit revocation consume the proof without token reconstruction', async t => {
  const f = source26Fixture(t), { result } = await grant(f);
  f.source.consumeExportGrant(A, { grant: result.grant });
  assert.throws(() => buildAccountExport(f.db, A, actor => f.source.lifecycle.assertActive(actor), f.source.lifecycle.adapters, 1));
  assert.throws(() => f.source.consumeExportGrant(A, { grant: result.grant }), denied);
  let checks = 0;
  assert.throws(() => buildAccountExport(f.db, A, actor => {
    if (++checks === 2) f.db.prepare('DELETE FROM session WHERE id=?').run(actor.sessionId);
    f.source.lifecycle.assertActive(actor);
  }, f.source.lifecycle.adapters));
  assert.equal(checks, 2);
});

test('v1 deletion rejects genuine contact grant and structurally forged source authority', async t => {
  const f = source26Fixture(t); f.initiate(); const { result } = await grant(f, 'account_delete');
  assert.throws(() => f.source.lifecycle.confirm(A, requestId, { grant: result.grant, policyVersion: lifecyclePolicy, confirmation: 'delete_whole_account' }), denied);
  assert.throws(() => f.source.lifecycle.confirmSourceAction({} as never, A, requestId, result.grant), denied);
  assert.equal(f.authority.lookup(A.accountId), null);
  assert.equal(f.source.confirmDeletion(A, { requestId, grant: result.grant }).disabled, true);
});


test('retained key rotation preserves issue idempotency and verification; delivery deadline does not shorten a settled challenge lifetime', async t => {
  const f = source26Fixture(t), c = await f.source.issueChallenge(A, issue);
  f.keyState.current = 'retained-key'; assert.deepEqual(await f.source.issueChallenge(A, issue), c); assert.equal(f.sends(), 1);
  f.advance(10001);
  const g = f.source.verifyChallenge(A, { challengeId: c.challengeId, purpose: issue.purpose, code: f.code() });
  f.source.consumeExportGrant(A, { grant: g.grant });
});

test('actual26 SQL guards retain counters/challenges/proofs and prevent counter rollback or immutable proof edits', async t => {
  const f = source26Fixture(t), { result } = await grant(f);
  assert.throws(() => f.db.prepare('DELETE FROM account_action_challenge_budgets WHERE account_id=?').run(A.accountId), /action_budget_retained/);
  assert.throws(() => f.db.prepare('UPDATE account_action_challenge_budgets SET request_count=0,revision=revision+1 WHERE account_id=?').run(A.accountId), /action_budget_monotonic/);
  assert.throws(() => f.db.exec('DELETE FROM account_action_challenges'), /action_challenge_retained/);
  assert.throws(() => f.db.exec('DELETE FROM account_action_proof_consumptions'), /action_proof_retained/);
  assert.throws(() => f.db.exec("UPDATE account_action_proof_consumptions SET proof_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"), /action_proof_single_use/);
  f.source.consumeExportGrant(A, { grant: result.grant });
  assert.throws(() => f.db.exec('UPDATE account_action_proof_consumptions SET used_at_ms=used_at_ms+1'), /action_proof_single_use/);
});

test('credential update and phone provenance delete/reinsert ABA invalidate earlier real proofs', async t => {
  for (const kind of ['credential-update', 'phone-reinsert'] as const) {
    const f = source26Fixture(t);
    if (kind === 'credential-update') f.db.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('null-credential','null-credential','credential',?,NULL,1,1)").run(A.authUserId);
    else f.phone();
    const { result } = await grant(f, 'account_export', kind === 'phone-reinsert' ? 'phone_action_code' : 'email_action_code');
    const revision = f.budget().binding_revision!;
    if (kind === 'credential-update') {
      f.db.exec("UPDATE account SET password='' WHERE id='null-credential'"); f.db.exec("UPDATE account SET password=NULL WHERE id='null-credential'");
      assert.equal(f.budget().binding_revision, revision + 2);
    } else {
      const row = f.db.prepare('SELECT * FROM phone_challenges WHERE auth_user_id=?').get(A.authUserId) as Record<string, unknown>;
      f.db.prepare('DELETE FROM phone_challenges WHERE auth_user_id=?').run(A.authUserId);
      f.db.prepare(`INSERT INTO phone_challenges(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      assert.equal(f.budget().binding_revision, revision + 1);
    }
    assert.throws(() => f.source.consumeExportGrant(A, { grant: result.grant }), denied); f.cleanup();
  }
});


test('actual per-account retained-challenge cap holds at128 without deleting history or refunding the request', async t => {
  const f = source26Fixture(t);
  f.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(f.now() + 60 * 86400000, A.sessionId);
  for (let i = 0; i < 128; i++) {
    if (i > 0 && i % 3 === 0) f.advance(3600000);
    await f.source.issueChallenge(A, { ...issue, requestKey: `retained-cap-${i}` });
  }
  const before = f.budget().request_count!;
  await assert.rejects(f.source.issueChallenge(A, { ...issue, requestKey: 'over-retained-cap' }), denied);
  assert.equal(f.sends(), 128); assert.equal(f.budget().request_count, before + 1);
  assert.equal((f.db.prepare('SELECT count(*) n FROM account_action_challenges WHERE account_id=?').get(A.accountId) as { n: number }).n, 128);
});

test('actual store budget-row cap holds before inserting an extra account budget or dispatch', async t => {
  const f = source26Fixture(t);
  f.db.transaction(() => {
    const user = f.db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,1,1)');
    const account = f.db.prepare('INSERT INTO form_accounts VALUES(?,?,?)');
    const budget = f.db.prepare('INSERT INTO account_action_challenge_budgets VALUES(?,?,1,1,0,0,0,0,0,0,?)');
    for (let i = 0; i < 10000; i++) {
      const id = `capacity-${i}`; user.run(id, 'Synthetic capacity', `${id}@synthetic.invalid`); account.run(id, id, 'synthetic'); budget.run(id, id, f.now());
    }
  }).immediate();
  await assert.rejects(f.source.issueChallenge(A, issue), denied); assert.equal(f.sends(), 0);
  assert.equal((f.db.prepare('SELECT count(*) n FROM account_action_challenge_budgets').get() as { n: number }).n, 10000);
  assert.equal(f.db.prepare('SELECT 1 FROM account_action_challenge_budgets WHERE account_id=?').get(A.accountId), undefined);
});
