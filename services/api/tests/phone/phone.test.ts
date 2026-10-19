import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { getMigrations } from 'better-auth/db/migration';
import { migrate, migrations, type Sqlite } from '../../src/storage.js';
import { Domain } from '../../src/domain.js';
import { catalogSeed } from '../../src/catalog.js';
import { DomainError } from '../../src/errors.js';
import { createPhoneAuth, isPhoneEmail, phoneMigrationSql } from '../../src/phone/index.js';
import { PhoneChallenges, phoneEmail, phoneLifetimeMs } from '../../src/phone/challenges.js';
import { normalizePhone, ProviderUnknown, TwilioVerify, type ManagedPhoneProvider, type PhoneConfiguration } from '../../src/phone/provider.js';

const secret = 'synthetic-phone-auth-secret-never-a-real-provider-key';
const phones = ['+12025550101', '+12025550102'];
const config: PhoneConfiguration = { allowCloudRequests: true, allowedPhones: phones,
  accountSid: `AC${'1'.repeat(32)}`, serviceSid: `VA${'2'.repeat(32)}`, apiKeySid: `SK${'3'.repeat(32)}`, apiKeySecret: secret };
const binding = () => randomBytes(32).toString('base64url');
const key = () => randomUUID();
const sid = `VE${'4'.repeat(32)}`;
const cleanup = new Set<() => void>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  for (const dispose of cleanup) dispose();
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
async function fixture(run: (f: { db: Sqlite; restart: () => Sqlite }) => Promise<void>) {
  const parent = resolve('tests/phone/.scratch'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'phone-')), path = join(root, 'durable.sqlite');
  let db = new Database(path);
  const dispose = () => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); };
  cleanup.add(dispose);
  try {
    db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL');
    await migrate(db, path);
    await run({ db, restart: () => { db.close(); db = new Database(path); db.pragma('foreign_keys=ON'); return db; } });
  } finally { dispose(); cleanup.delete(dispose); assert.equal(existsSync(root), false); }
}
const errorCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

test('phone challenges: binding, expiry, durable limits, idempotency and single use', async () => fixture(async f => {
  let time = Date.now(), sends = 0, checks = 0;
  const provider: ManagedPhoneProvider = {
    start: async phone => { sends++; return { sid, phone, status: 'pending' }; },
    check: async (phone, verificationSid, code) => { checks++; assert.equal(verificationSid, sid);
      return { sid, phone, status: code === '741852' ? 'approved' : 'pending' }; },
  };
  let manager = new PhoneChallenges(f.db, provider, phones, secret, () => time);
  const input = { phoneNumber: phones[0]!, binding: binding() }, startKey = key();
  const first = await manager.start(input, startKey), bound = { ...input, challengeId: first.challengeId };
  assert.deepEqual(await manager.start(input, startKey), first); assert.equal(sends, 1);
  await assert.rejects(manager.verify({ ...bound, binding: binding(), code: '741852' }, key()), errorCode('phone_challenge_not_found'));
  await assert.rejects(manager.verify({ ...bound, phoneNumber: phones[1]!, code: '741852' }, key()), errorCode('phone_challenge_not_found'));
  const wrongKey = key();
  assert.equal(await manager.verify({ ...bound, code: '111111' }, wrongKey), false);
  await assert.rejects(manager.verify({ ...bound, code: '222222' }, wrongKey), errorCode('idempotency_mismatch'));
  await assert.rejects(manager.verify({ ...bound, code: '111111' }, wrongKey), errorCode('invalid_phone_code'));
  assert.equal(checks, 1);
  await assert.rejects(manager.resend(bound, key()), errorCode('phone_resend_limit'));
  time += 30_000; const resendKey = key(); await manager.resend(bound, resendKey); await manager.resend(bound, resendKey);
  assert.equal(sends, 2);
  time += 30_000; await manager.resend(bound, key()); assert.equal(sends, 3);
  time += 30_000; await assert.rejects(manager.resend(bound, key()), errorCode('phone_resend_limit'));
  manager = new PhoneChallenges(f.restart(), provider, phones, secret, () => time);
  const verifyKey = key(); assert.equal(await manager.verify({ ...bound, code: '741852' }, verifyKey), true);
  await assert.rejects(manager.verify({ ...bound, code: '741852' }, verifyKey), errorCode('phone_challenge_consumed'));
  await assert.rejects(manager.verify({ ...bound, code: '741852' }, key()), errorCode('phone_challenge_consumed'));
  assert.equal(checks, 2);
  await assert.rejects(manager.start({ ...input, binding: binding() }, key()), errorCode('phone_challenge_cooldown'));
  time += phoneLifetimeMs;
  await assert.rejects(manager.verify({ ...bound, code: '741852' }, key()), errorCode('phone_challenge_expired'));
  const next = await manager.start({ ...input, binding: binding() }, key());
  const nextBound = { phoneNumber: input.phoneNumber, binding: input.binding, challengeId: next.challengeId };
  // The fresh binding is deliberately unavailable to this old request.
  await assert.rejects(manager.verify({ ...nextBound, code: '741852' }, key()), errorCode('phone_challenge_not_found'));
}));

test('phone checks: attempts survive restart and approval is bounded to the in-flight claim', async () => fixture(async f => {
  let checks = 0, time = Date.now();
  const provider: ManagedPhoneProvider = { start: async phone => ({ sid, phone, status: 'pending' }),
    check: async phone => { checks++; return { sid, phone, status: 'pending' }; } };
  let manager = new PhoneChallenges(f.db, provider, phones, secret, () => time);
  const input = { phoneNumber: phones[0]!, binding: binding() }, started = await manager.start(input, key());
  const bound = { ...input, challengeId: started.challengeId, code: '111111' };
  assert.equal(await manager.verify(bound, key()), false);
  manager = new PhoneChallenges(f.restart(), provider, phones, secret, () => time);
  assert.equal(await manager.verify(bound, key()), false); assert.equal(await manager.verify(bound, key()), false);
  await assert.rejects(manager.verify(bound, key()), errorCode('phone_attempt_limit')); assert.equal(checks, 3);
  time += phoneLifetimeMs;
  await assert.rejects(manager.verify(bound, key()), errorCode('phone_challenge_expired'));
}));

test('phone unknown outcomes: no blind send/check retry after response loss or restart', async () => fixture(async f => {
  let sends = 0, checks = 0, time = Date.now();
  const provider: ManagedPhoneProvider = {
    start: async phone => { sends++; if (sends === 1) throw new ProviderUnknown(); return { sid, phone, status: 'pending' }; },
    check: async () => { checks++; throw new ProviderUnknown(); },
  };
  let manager = new PhoneChallenges(f.db, provider, phones, secret, () => time);
  const input = { phoneNumber: phones[0]!, binding: binding() }, startKey = key();
  await assert.rejects(manager.start(input, startKey), errorCode('phone_outcome_unknown'));
  manager = new PhoneChallenges(f.restart(), provider, phones, secret, () => time);
  await assert.rejects(manager.start(input, startKey), errorCode('phone_outcome_unknown'));
  await assert.rejects(manager.start(input, key()), errorCode('phone_challenge_cooldown')); assert.equal(sends, 1);
  time += phoneLifetimeMs + 1;
  const started = await manager.start(input, key()), check = { ...input, challengeId: started.challengeId, code: '741852' }, checkKey = key();
  await assert.rejects(manager.verify(check, checkKey), errorCode('phone_outcome_unknown'));
  manager = new PhoneChallenges(f.restart(), provider, phones, secret, () => time);
  await assert.rejects(manager.verify(check, checkKey), errorCode('phone_outcome_unknown'));
  await assert.rejects(manager.verify(check, key()), errorCode('phone_challenge_unavailable')); assert.equal(checks, 1);
  assert.equal((f.restart().prepare('SELECT COUNT(*) AS count FROM "user"').get() as { count: number }).count, 0);
}));

test('Twilio contract: exact endpoint/auth/body, managed approval and mismatched issuer rejection', async () => {
  let mismatch = false;
  const fetcher: typeof fetch = async (url, request) => {
    assert.equal(new URL(String(url)).origin, 'https://verify.twilio.com');
    assert.equal(request?.redirect, 'error');
    const headers = new Headers(request?.headers);
    assert.equal(headers.get('authorization'), `Basic ${Buffer.from(`${config.apiKeySid}:${secret}`).toString('base64')}`);
    const body = request!.body as URLSearchParams;
    const check = String(url).endsWith('/VerificationCheck');
    if (check) { assert.equal(body.get('VerificationSid'), sid); assert.equal(body.get('Code'), '741852'); assert.equal(body.has('To'), false); }
    else { assert.equal(body.get('To'), phones[0]); assert.equal(body.get('Channel'), 'sms'); assert.equal(body.has('CustomCode'), false); }
    return Response.json({ sid, service_sid: config.serviceSid, account_sid: config.accountSid,
      to: mismatch ? phones[1] : phones[0], status: check ? 'approved' : 'pending' });
  };
  const provider = new TwilioVerify(config, fetcher);
  assert.equal(normalizePhone(' +1 (202) 555-0101 '), phones[0]);
  await provider.start(phones[0]!); assert.equal((await provider.check(phones[0]!, sid, '741852')).status, 'approved');
  mismatch = true; await assert.rejects(provider.check(phones[0]!, sid, '741852'), ProviderUnknown);
});

test('phone race and interrupted claims: concurrent redemption cannot issue a second approval', async () => fixture(async f => {
  let release: (() => void) | undefined, checks = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const provider: ManagedPhoneProvider = { start: async phone => ({ sid, phone, status: 'pending' }),
    check: async phone => { checks++; await pending; return { sid, phone, status: 'approved' }; } };
  const manager = new PhoneChallenges(f.db, provider, phones, secret);
  const input = { phoneNumber: phones[0]!, binding: binding() }, started = await manager.start(input, key());
  const proof = { ...input, challengeId: started.challengeId, code: '741852' }, firstKey = key();
  const first = manager.verify(proof, firstKey);
  await assert.rejects(manager.verify(proof, key()), errorCode('phone_challenge_unavailable'));
  await assert.rejects(manager.verify(proof, firstKey), errorCode('phone_outcome_unknown'));
  release!(); assert.equal(await first, true); assert.equal(checks, 1);
  // Simulate a crash after the durable claim, before any check receipt was committed.
  const input2 = { phoneNumber: phones[1]!, binding: binding() }, second = await manager.start(input2, key()), interruptedKey = key();
  f.db.prepare("UPDATE phone_challenges SET status='checking',attempt_count=1 WHERE id=?").run(second.challengeId);
  const proof2 = { ...input2, challengeId: second.challengeId, code: '741852' };
  f.db.prepare('INSERT INTO phone_operations VALUES (?,?,?,?,?,?)').run(second.challengeId, 'check', interruptedKey, 'synthetic-interrupted-intent', 'claimed', Date.now());
  const restarted = new PhoneChallenges(f.restart(), provider, phones, secret);
  await assert.rejects(restarted.verify(proof2, key()), errorCode('phone_challenge_unavailable'));
  assert.equal(checks, 1);
}));

test('unconfigured phone closes all outbound effects and never reports synthetic verification', async () => fixture(async f => {
  const disabled = new PhoneChallenges(f.db, undefined, [], secret);
  assert.equal(disabled.capability().status, 'unconfigured');
  await assert.rejects(disabled.start({ phoneNumber: phones[0]!, binding: binding() }, key()), errorCode('phone_verification_unconfigured'));
  const noAllowlist = new PhoneChallenges(f.db, { start: async () => { throw new Error('must not call'); },
    check: async () => { throw new Error('must not call'); } }, [], secret);
  await assert.rejects(noAllowlist.start({ phoneNumber: phones[0]!, binding: binding() }, key()), errorCode('phone_verification_unconfigured'));
}));

test('managed phone plugin: real durable signed library sessions, isolated subjects and denied alternate routes', async () => fixture(async f => {
  const base = 'http://127.0.0.1:8766';
  let sends = 0, checks = 0;
  const providerFetch: typeof fetch = async (url, init) => {
    const body = init!.body as URLSearchParams;
    const isCheck = String(url).endsWith('/VerificationCheck');
    const number = isCheck ? body.get('VerificationSid') === `VE${'5'.repeat(32)}` ? phones[1]! : phones[0]! : body.get('To')!;
    if (isCheck) checks++; else sends++;
    return Response.json({ sid: number === phones[0] ? sid : `VE${'5'.repeat(32)}`, to: number,
      account_sid: config.accountSid, service_sid: config.serviceSid,
      status: isCheck && body.get('Code') === '741852' ? 'approved' : 'pending' });
  };
  const makeAuth = (db: Sqlite) => {
    const phoneAuth = createPhoneAuth(db, config, secret, { fetcher: providerFetch });
    const auth = betterAuth({ database: db, baseURL: base, secret, trustedOrigins: [base],
      plugins: [bearer({ requireSignature: true }), phoneAuth.plugin], account: { accountLinking: { enabled: false } },
      session: { cookieCache: { enabled: false } }, emailAndPassword: { enabled: true },
      databaseHooks: { user: { create: { before: async (user, context) =>
        phoneAuth.canCreateUser(user, context) || (!isPhoneEmail(user.email) &&
          (user as Record<string, unknown>).phoneNumber == null && (user as Record<string, unknown>).phoneNumberVerified !== true &&
          user.email === 'separate@synthetic.invalid') } } },
      telemetry: { enabled: false }, logger: { disabled: true },
    });
    return { auth, phoneAuth };
  };
  let { auth, phoneAuth } = makeAuth(f.db);
  const schema = await getMigrations(auth.options);
  assert.equal(schema.toBeCreated.length + schema.toBeAdded.length + schema.unsafeChanges.length + schema.schemaProblems.length, 0);
  assert.equal(phoneAuth.capability().status, 'configured_unverified');
  const request = (path: string, input: unknown, receipt = key()) => auth.handler(new Request(`${base}/api/auth${path}`, {
    method: 'POST', headers: { origin: base, 'Content-Type': 'application/json', 'Idempotency-Key': receipt }, body: JSON.stringify(input),
  }));
  for (const path of ['/phone-number/send-otp', '/sign-in/phone-number', '/phone-number/request-password-reset', '/phone-number/reset-password'])
    assert.equal((await request(path, { phoneNumber: phones[0], code: '741852' })).status, 404);
  for (const forged of [{ email: phoneEmail(phones[0]!) }, { email: 'separate@synthetic.invalid', phoneNumber: phones[0] }])
    assert.notEqual((await request('/sign-up/email', { name: 'Forged', password: 'synthetic-password-123456', ...forged })).status, 200);
  assert.equal((await request('/phone-number/challenge', { phoneNumber: '+12025550999', binding: binding() })).status, 403);
  const login = async (number: string) => {
    const input = { phoneNumber: number, binding: binding() }, sendKey = key();
    const started = await request('/phone-number/challenge', input, sendKey); assert.equal(started.status, 200);
    const challenge = await started.json() as { challengeId: string };
    const proof = { ...input, challengeId: challenge.challengeId, code: '741852' };
    assert.equal((await request('/phone-number/verify', { ...proof, updatePhoneNumber: true })).status, 400);
    const receipt = key(), verified = await request('/phone-number/verify', proof, receipt);
    assert.equal(verified.status, 200);
    const result = await verified.json() as { token: string; user: { id: string; email: string; phoneNumber: string; phoneNumberVerified: boolean } };
    const signed = verified.headers.get('set-auth-token'); assert.ok(signed); assert.notEqual(signed, result.token);
    assert.equal(result.user.phoneNumber, number); assert.equal(result.user.phoneNumberVerified, true);
    assert.equal(result.user.email, phoneEmail(number));
    assert.equal(await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${result.token}` }) }), null);
    assert.ok(await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${signed}` }) }));
    assert.equal((await request('/phone-number/verify', proof, receipt)).status, 409);
    return { signed, user: result.user };
  };
  const first = await login(phones[0]!), second = await login(phones[1]!);
  assert.notEqual(first.user.id, second.user.id);
  const domain = new Domain(f.db), a = domain.account(first.user.id, 'First'), b = domain.account(second.user.id, 'Second');
  const exercise = catalogSeed[0]!;
  f.db.prepare('INSERT INTO exercises(id,data) VALUES (?,?)').run(exercise.id, JSON.stringify(exercise));
  const plan = domain.createPlan(a, { name: 'Private plan', minutes: 30,
    items: [{ id: 'private-first', exerciseId: exercise.id, setTarget: 3, repMin: 8, repMax: 10, targetKg: 10 }] });
  assert.throws(() => domain.plan(b, plan.id), errorCode('not_found'));
  const emailSignup = await request('/sign-up/email', { email: 'separate@synthetic.invalid', name: 'Separate', password: 'synthetic-password-123456' });
  assert.equal(emailSignup.status, 200);
  assert.notEqual((await emailSignup.json() as { user: { id: string } }).user.id, first.user.id);
  ({ auth, phoneAuth } = makeAuth(f.restart()));
  assert.equal((await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${first.signed}` }) }))?.user.id, first.user.id);
  assert.equal(phoneAuth.capability().status, 'configured_unverified'); assert.equal(sends, 2); assert.equal(checks, 2);
  const signout = await auth.handler(new Request(`${base}/api/auth/sign-out`, { method: 'POST',
    headers: { origin: base, authorization: `Bearer ${first.signed}`, 'Content-Type': 'application/json' }, body: '{}' }));
  assert.equal(signout.status, 200);
  assert.equal(await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${first.signed}` }) }), null);
}));
