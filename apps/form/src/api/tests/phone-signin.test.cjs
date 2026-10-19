const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const modules = new Map();
function load(name) {
  const file = path.resolve(root, name);
  assert.ok(file.startsWith(root + path.sep));
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { FormTransport } = load('transport.ts');
const { encodePhoneBinding, createPhoneSignInAttempt } = load('phoneSignIn.ts');
const base = 'http://127.0.0.1:8766';
const phone = '+12025550123';
const id = '11111111-1111-4111-8111-111111111111';
const callerKey = 'caller-phone-intent-0001';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const clock = Date.parse('2026-10-09T12:00:00.000Z');
const view = (time = clock) => ({ challengeId: id, phoneNumber: phone, status: 'pending',
  expiresAt: new Date(clock + 600000).toISOString(), resendAfter: new Date(time + 30000).toISOString() });
const verified = () => ({ status: true, token: 'synthetic-raw-token-never-stored', user: {
  id, phoneNumber: phone, phoneNumberVerified: true, email: 'a'.repeat(64) + '@phone.form.invalid',
} });
function fixture(handler, options = {}) {
  const calls = []; const store = { value: null, async load() { return this.value; }, async save(value) { this.value = value; }, async clear() { this.value = null; } };
  const api = new FormTransport(base, store, async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); });
  let time = clock, randomCalls = 0, live = true;
  const attempt = createPhoneSignInAttempt(api, { now: () => time, isCurrentSession: () => live,
    randomBytes32: async () => new Uint8Array(32).fill(++randomCalls), ...options });
  return { api, attempt, calls, store, advance: ms => { time += ms; }, expire: () => { live = false; }, randomCalls: () => randomCalls };
}

test('32-byte codec is exact unpadded base64url across byte values; other lengths fail closed', () => {
  for (const bytes of [new Uint8Array(32), new Uint8Array(32).fill(255), Uint8Array.from({ length: 32 }, (_, i) => i * 7)]) {
    const encoded = encodePhoneBinding(bytes);
    assert.equal(encoded.length, 43); assert.match(encoded, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(encoded, Buffer.from(bytes).toString('base64url'));
  }
  for (const invalid of [new Uint8Array(31), new Uint8Array(33), Array(32).fill(0)]) assert.throws(() => encodePhoneBinding(invalid), { code: 'phone_random_unavailable' });
});

test('factory is inert; exact POST paths and JSON use no existing bearer and random wire keys', async () => {
  const f = fixture(async url => url.endsWith('/challenge') ? json(view()) : url.endsWith('/resend') ? json(view(clock + 30000))
    : json(verified(), 200, { 'set-auth-token': 'signed-phone' }));
  assert.equal(f.calls.length, 0); assert.equal(f.randomCalls(), 0);
  const challenge = await f.attempt.challenge(phone, callerKey);
  f.advance(30000); const next = await f.attempt.resend(challenge, callerKey);
  assert.deepEqual(await f.attempt.verify(next, '1234', callerKey), { status: true });
  assert.deepEqual(f.calls.map(c => c.url), ['/challenge', '/resend', '/verify'].map(s => base + '/api/auth/phone-number' + s));
  const [start, resend, verify] = f.calls.map(c => JSON.parse(c.init.body));
  assert.deepEqual(start, { phoneNumber: phone, binding: encodePhoneBinding(new Uint8Array(32).fill(1)) });
  assert.deepEqual(resend, { ...start, challengeId: id }); assert.deepEqual(verify, { ...resend, code: '1234' });
  for (const { init } of f.calls) { assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, undefined); assert.equal(init.redirect, 'error'); assert.match(init.headers['Idempotency-Key'], /^[A-Za-z0-9_-]{43}$/); assert.notEqual(init.headers['Idempotency-Key'], callerKey); }
  assert.equal(new Set(f.calls.map(c => c.init.headers['Idempotency-Key'])).size, 3);
  assert.equal(JSON.parse(f.store.value).token, 'signed-phone'); f.attempt.dispose();
});

test('explicit uncertain send retry preserves binding payload and key; no automatic duplicate SMS request', async () => {
  let count = 0; const f = fixture(async () => ++count === 1 ? Promise.reject(new Error('lost send response')) : json(view()));
  await assert.rejects(f.attempt.challenge(phone, callerKey), { effectUnknown: true });
  assert.equal(f.calls.length, 1); await assert.rejects(f.attempt.challenge('+442025550123', callerKey), { code: 'phone_attempt_changed' });
  await f.attempt.challenge(phone, 'caller-another-key-0002');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].init.body, f.calls[1].init.body);
  assert.equal(f.calls[0].init.headers['Idempotency-Key'], f.calls[1].init.headers['Idempotency-Key']);
  assert.equal(f.randomCalls(), 2); f.attempt.dispose();
});

test('provider unknown remains fail closed and only the exact explicit intent can reconcile', async () => {
  const f = fixture(async () => json({ code: 'phone_outcome_unknown' }, 409));
  for (let i = 0; i < 2; i++) await assert.rejects(f.attempt.challenge(phone, callerKey), { code: 'phone_outcome_unknown', effectUnknown: true });
  assert.equal(f.calls[0].init.body, f.calls[1].init.body); assert.equal(f.calls[0].init.headers['Idempotency-Key'], f.calls[1].init.headers['Idempotency-Key']);
  assert.equal(f.store.value, null); f.attempt.dispose();
});

test('canonical phone validation never guesses national prefixes; bad randomness never dispatches', async () => {
  const f = fixture(async () => json(view()));
  for (const invalid of ['2025550123', '+02025550123', '+1 2025550123', '+1234567', '+1234567890123456'])
    await assert.rejects(f.attempt.challenge(invalid, callerKey), { code: 'invalid_phone' });
  assert.equal(f.calls.length, 0);
  const bad = fixture(async () => json(view()), { randomBytes32: async () => new Uint8Array(31) });
  await assert.rejects(bad.attempt.challenge(phone, callerKey), { code: 'phone_random_unavailable' }); assert.equal(bad.calls.length, 0);
  f.attempt.dispose(); bad.attempt.dispose();
});

test('hostile malformed foreign expired and nonpending challenge results cannot authorize verification', async () => {
  for (const result of [null, {}, { ...view(), verified: true }, { ...view(), phoneNumber: '+442025550123' }, { ...view(), challengeId: 'foreign' },
    ...['sending', 'checking', 'consumed', 'failed', 'unknown', 'approved'].map(status => ({ ...view(), status })),
    { ...view(), expiresAt: 'not-a-date' }, { ...view(), expiresAt: new Date(clock).toISOString() },
    { ...view(), expiresAt: new Date(clock + 600001).toISOString() }, { ...view(), resendAfter: 'Infinity' }]) {
    const f = fixture(async () => json(result));
    await assert.rejects(f.attempt.challenge(phone, callerKey), { code: 'invalid_phone_challenge', effectUnknown: true });
    await assert.rejects(f.attempt.verify(view(), '1234', callerKey), { code: 'invalid_phone_challenge' });
    assert.equal(f.calls.length, 1); f.attempt.dispose();
  }
});

test('only exact owned challenge can resend after cooldown; resend cannot extend expiry or change identity', async () => {
  for (const change of [{ challengeId: '22222222-2222-4222-8222-222222222222' }, { expiresAt: new Date(clock + 610000).toISOString() }]) {
    const f = fixture(async url => url.endsWith('/challenge') ? json(view()) : json({ ...view(clock + 30000), ...change }));
    const challenge = await f.attempt.challenge(phone, callerKey);
    await assert.rejects(f.attempt.resend(challenge, callerKey), { code: 'phone_resend_cooldown' });
    await assert.rejects(f.attempt.verify({ ...challenge, resendAfter: new Date(clock).toISOString() }, '1234', callerKey), { code: 'invalid_phone_challenge' });
    f.advance(30000); await assert.rejects(f.attempt.resend(challenge, callerKey), { code: 'invalid_phone_challenge' });
    assert.equal(f.calls.length, 2); f.attempt.dispose();
  }
});

test('one in-flight intent shares one promise; different operations cannot interleave', async () => {
  const pending = deferred(), entered = deferred(); const f = fixture(async () => { entered.resolve(); return pending.promise; });
  const first = f.attempt.challenge(phone, callerKey), second = f.attempt.challenge(phone, callerKey);
  assert.equal(first, second); await entered.promise;
  await assert.rejects(f.attempt.challenge('+442025550123', callerKey), { code: 'phone_attempt_changed' });
  pending.resolve(json(view())); const challenge = await first; assert.equal(f.calls.length, 1);
  assert.deepEqual(await f.attempt.challenge(phone, callerKey), challenge); assert.equal(f.calls.length, 1); f.attempt.dispose();
});

test('changed code after known rejection gets a new cryptographic key; unknown verification keeps exact code and key', async () => {
  let checks = 0; const f = fixture(async url => url.endsWith('/challenge') ? json(view())
    : ++checks === 1 ? json({ code: 'invalid_phone_code' }, 400) : json({ code: 'phone_outcome_unknown' }, 409));
  const challenge = await f.attempt.challenge(phone, callerKey);
  await assert.rejects(f.attempt.verify(challenge, '1234', callerKey), { code: 'invalid_phone_code' });
  await assert.rejects(f.attempt.verify(challenge, '5678901234', callerKey), { code: 'phone_outcome_unknown', effectUnknown: true });
  await assert.rejects(f.attempt.verify(challenge, '9999', callerKey), { code: 'phone_outcome_unknown' });
  await assert.rejects(f.attempt.verify(challenge, '5678901234', callerKey), { code: 'phone_outcome_unknown' });
  assert.notEqual(f.calls[1].init.headers['Idempotency-Key'], f.calls[2].init.headers['Idempotency-Key']);
  assert.equal(f.calls[2].init.body, f.calls[3].init.body); assert.equal(f.calls[2].init.headers['Idempotency-Key'], f.calls[3].init.headers['Idempotency-Key']);
  f.attempt.dispose();
});

test('missing signed header and consumed proof cannot be reused or converted from raw JSON token', async () => {
  for (const response of [() => json(verified()), () => json({ code: 'phone_challenge_consumed' }, 409)]) {
    const f = fixture(async url => url.endsWith('/challenge') ? json(view()) : response());
    const challenge = await f.attempt.challenge(phone, callerKey);
    await assert.rejects(f.attempt.verify(challenge, '1234', callerKey));
    await assert.rejects(f.attempt.verify(challenge, '1234', callerKey), { code: 'invalid_phone_challenge' });
    assert.equal(f.calls.length, 2); assert.equal(f.store.value, null); f.attempt.dispose();
  }
});

test('negative foreign malformed verification result with issued header cleans that token before any adoption', async () => {
  for (const result of [{ ...verified(), status: false }, { ...verified(), extra: true }, { ...verified(), user: { ...verified().user, phoneNumber: '+442025550123' } }, { status: true }]) {
    const f = fixture(async url => url.endsWith('/challenge') ? json(view()) : url.endsWith('/sign-out') ? json({ success: true }) : json(result, 200, { 'set-auth-token': 'signed-invalid' }));
    const challenge = await f.attempt.challenge(phone, callerKey);
    await assert.rejects(f.attempt.verify(challenge, '1234', callerKey), { code: 'invalid_response', originalEffectUnknown: true });
    assert.equal(f.store.value, null); assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer signed-invalid'); f.attempt.dispose();
  }
});

test('reset dispose and root session expiry reject late challenges and never repopulate memory', async () => {
  for (const action of ['reset', 'dispose', 'expire']) {
    const pending = deferred(), entered = deferred(); const f = fixture(async () => { entered.resolve(); return pending.promise; });
    const first = f.attempt.challenge(phone, callerKey); const rejected = assert.rejects(first, { code: 'session_changed', originalEffectUnknown: true });
    await entered.promise; action === 'expire' ? f.expire() : f.attempt[action](); pending.resolve(json(view())); await rejected;
    await assert.rejects(f.attempt.verify(view(), '1234', callerKey)); assert.equal(f.calls.length, 1); f.attempt.dispose();
  }
});

test('reset/dispose after verify dispatch actually prevent transport adoption and revoke exact late token', async () => {
  for (const action of ['reset', 'dispose']) {
    const pending = deferred(), entered = deferred(); const f = fixture(async url => url.endsWith('/challenge') ? json(view())
      : url.endsWith('/sign-out') ? json({ success: true }) : (entered.resolve(), pending.promise));
    const challenge = await f.attempt.challenge(phone, callerKey);
    const first = f.attempt.verify(challenge, '1234', callerKey); const rejected = assert.rejects(first, { code: 'session_changed', originalEffectUnknown: true });
    await entered.promise; f.attempt[action](); pending.resolve(json(verified(), 200, { 'set-auth-token': 'signed-abandoned' })); await rejected;
    assert.equal(f.store.value, null); assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer signed-abandoned'); f.attempt.dispose();
  }
});

test('new account sign-in clears an idle attempt and late verification cannot overwrite the later token', async () => {
  const pending = deferred(), entered = deferred(); const f = fixture(async url => url.endsWith('/challenge') ? json(view())
    : url.endsWith('/sign-in/email') ? json({}, 200, { 'set-auth-token': 'signed-later' })
    : url.endsWith('/sign-out') ? json({ success: true }) : (entered.resolve(), pending.promise));
  const challenge = await f.attempt.challenge(phone, callerKey);
  const first = f.attempt.verify(challenge, '1234', callerKey); const rejected = assert.rejects(first, { code: 'session_changed' });
  await entered.promise; await f.api.signIn('later@example.invalid', 'synthetic-password');
  pending.resolve(json(verified(), 200, { 'set-auth-token': 'signed-old-phone' })); await rejected;
  assert.equal(JSON.parse(f.store.value).token, 'signed-later');
  await assert.rejects(f.attempt.verify(challenge, '1234', callerKey), { code: 'invalid_phone_challenge' }); f.attempt.dispose();
});

test('resend unknown retries preserve the exact owned challenge key and payload without another operation', async () => {
  const f = fixture(async url => url.endsWith('/challenge') ? json(view()) : json({ code: 'phone_outcome_unknown' }, 409));
  const challenge = await f.attempt.challenge(phone, callerKey); f.advance(30000);
  await assert.rejects(f.attempt.resend(challenge, callerKey), { effectUnknown: true });
  await assert.rejects(f.attempt.verify(challenge, '1234', callerKey), { code: 'phone_outcome_unknown' });
  await assert.rejects(f.attempt.resend(challenge, 'caller-another-key-0002'), { effectUnknown: true });
  assert.equal(f.calls[1].init.body, f.calls[2].init.body);
  assert.equal(f.calls[1].init.headers['Idempotency-Key'], f.calls[2].init.headers['Idempotency-Key']); f.attempt.dispose();
});

test('invalid numeric codes and local expiry cannot dispatch; reset gets a new binding', async () => {
  const f = fixture(async () => json(view())); const challenge = await f.attempt.challenge(phone, callerKey);
  for (const invalid of ['', '123', '12345678901', '12 34', 'word']) await assert.rejects(f.attempt.verify(challenge, invalid, callerKey), { code: 'invalid_phone_code' });
  f.advance(600000); await assert.rejects(f.attempt.verify(challenge, '1234', callerKey), { code: 'phone_challenge_expired' });
  assert.equal(f.calls.length, 1); f.attempt.dispose();
  const next = fixture(async () => json(view())); await next.attempt.challenge(phone, callerKey); next.attempt.reset();
  await next.attempt.challenge(phone, callerKey); assert.notEqual(JSON.parse(next.calls[0].init.body).binding, JSON.parse(next.calls[1].init.body).binding); next.attempt.dispose();
});

test('crypto cancellation before dispatch clears binding and cannot revive disposed memory', async () => {
  const bytes = deferred(), entered = deferred(); const f = fixture(async () => json(view()), { randomBytes32: () => { entered.resolve(); return bytes.promise; } });
  const pending = f.attempt.challenge(phone, callerKey); const rejected = assert.rejects(pending, { code: 'session_changed', originalEffectUnknown: false });
  await entered.promise; f.attempt.dispose(); bytes.resolve(new Uint8Array(32)); await rejected;
  assert.equal(f.calls.length, 0); await assert.rejects(f.attempt.challenge(phone, callerKey), { code: 'session_changed' });
});

test('idle challenge memory is erased by same-account replacement and signout notifications', async () => {
  for (const action of ['signin', 'signout']) {
    const f = fixture(async url => url.endsWith('/challenge') ? json(view()) : url.endsWith('/sign-out') ? json({ success: true }) : json({}, 200, { 'set-auth-token': 'signed-same-account' }));
    const challenge = await f.attempt.challenge(phone, callerKey);
    if (action === 'signin') await f.api.signIn('same@example.invalid', 'synthetic-password'); else await f.api.signOut();
    await assert.rejects(f.attempt.verify(challenge, '1234', callerKey), { code: 'invalid_phone_challenge' });
    assert.equal(f.calls.length, 2); f.attempt.dispose();
  }
});

test('secure-save failure revokes issued phone token and seals consumed proof even if cleanup is unknown', async () => {
  for (const unknown of [false, true]) {
    const f = fixture(async url => url.endsWith('/challenge') ? json(view()) : url.endsWith('/sign-out')
      ? unknown ? Promise.reject(new Error('lost cleanup')) : json({ success: true }) : json(verified(), 200, { 'set-auth-token': 'signed-unsaved' }));
    f.store.save = async value => { f.store.value = value; throw new Error('secure write failed after mutation'); };
    const challenge = await f.attempt.challenge(phone, callerKey);
    await assert.rejects(f.attempt.verify(challenge, '1234', callerKey), { code: 'secure_storage_failed', originalEffectUnknown: true });
    assert.equal(f.store.value, null); assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer signed-unsaved');
    await assert.rejects(f.attempt.verify(challenge, '1234', callerKey), { code: 'invalid_phone_challenge' }); f.attempt.dispose();
  }
});

test('phone challenge and resend omit a preexisting bearer without clearing that session', async () => {
  const f = fixture(async url => url.endsWith('/sign-in/email') ? json({}, 200, { 'set-auth-token': 'signed-existing' })
    : url.endsWith('/challenge') ? json(view()) : url.endsWith('/resend') ? json(view(clock + 30000)) : json({ accountId: 'existing' }));
  await f.api.signIn('existing@example.invalid', 'synthetic-password');
  const challenge = await f.attempt.challenge(phone, callerKey); f.advance(30000); await f.attempt.resend(challenge, callerKey);
  assert.equal(f.calls[1].init.headers.Authorization, undefined); assert.equal(f.calls[2].init.headers.Authorization, undefined);
  assert.equal(JSON.parse(f.store.value).token, 'signed-existing'); await f.api.request('/v1/me');
  assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer signed-existing'); f.attempt.dispose();
});

// Run the unchanged original transport cases and authored race cases against the same in-memory production module.
// This entry point needs no .scratch output; the legacy npm runner remains root-owned and unchanged.
const transportTests = path.resolve(root, '../../scripts/test-api-transport.cjs');
new Function('require', fs.readFileSync(transportTests, 'utf8'))(name => {
  if (name === '../.scratch/api-tests/transport.js') return load('transport.ts');
  assert.ok(['node:assert/strict', 'node:test'].includes(name), `Unexpected transport test dependency: ${name}`);
  return require(name);
});
