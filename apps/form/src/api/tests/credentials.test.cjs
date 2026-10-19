const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Compile exact sources in memory; synthetic fetch/storage only, with no native module or scratch output.
function load(relative, imports = {}) {
  const source = readFileSync(path.join(__dirname, relative), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name];
  }, module, module.exports);
  return module.exports;
}
const transport = load('../transport.ts');
const credentials = load('../credentials.ts', { './transport': transport });
const model = load('../../features/credentials/model.ts', { '../../api/credentials': credentials });
const { createCredentialsPort } = credentials;
const { createForgotPasswordController, createChangePasswordController, createChangeEmailController, securityActions } = model;
const password = 'synthetic-current-password', nextPassword = 'synthetic-next-password', otp = '87654321';
const email = 'member@synthetic.invalid', nextEmail = 'next@synthetic.invalid';
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(signedIn = true) {
  const calls = [], storage = { value: null, async load() { return this.value; }, async save(value) { this.value = value; }, async clear() { this.value = null; } };
  let action = () => response({ success: true }), count = 0, active = true;
  const api = new transport.FormTransport('https://form.synthetic.invalid', storage, async (url, init) => {
    const call = { path: new URL(url).pathname, method: init.method, body: JSON.parse(init.body ?? '{}'), headers: init.headers };
    calls.push(call);
    if (call.path === '/api/auth/sign-in/email') return response({}, 200, { 'set-auth-token': `signed-${++count}` });
    if (call.path === '/api/auth/sign-out') return response({ success: true });
    return action(call);
  });
  if (signedIn) await api.signIn(email, password);
  const port = createCredentialsPort(api, { isCurrent: () => active });
  calls.length = 0;
  return { api, port, calls, storage, setAction(next) { action = next; }, leave() { active = false; } };
}
function noSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [password, nextPassword, otp, 'private-provider-detail', 'raw-body-token', 'replacement-token'])
    assert.ok(!serialized.includes(secret), `Public state contains ${secret}`);
}

test('credential requests use exact validated bodies, anonymous recovery and session-preserving email commands', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.port.requestPasswordReset({ email: ' Member@synthetic.invalid ' })).status, 'saved');
    assert.deepEqual(f.calls.at(-1), { path: '/api/auth/email-otp/request-password-reset', method: 'POST', body: { email },
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
    await f.port.resetPassword({ email, otp, password: nextPassword });
    assert.equal(f.calls.at(-1).headers.Authorization, undefined);
    assert.deepEqual(f.calls.at(-1).body, { email, otp, password: nextPassword });
    await f.port.requestEmailChange({ newEmail: nextEmail, currentPassword: password });
    assert.equal(f.calls.at(-1).path, '/api/auth/email-otp/request-email-change');
    assert.equal(f.calls.at(-1).headers.Authorization, 'Bearer signed-1');
    assert.deepEqual(f.calls.at(-1).body, { newEmail: nextEmail, currentPassword: password });
    await f.port.changeEmail({ newEmail: nextEmail, otp });
    assert.equal(f.calls.at(-1).path, '/api/auth/email-otp/change-email');
    assert.deepEqual(f.calls.at(-1).body, { newEmail: nextEmail, otp });
    assert.equal(JSON.parse(f.storage.value).token, 'signed-1');
  } finally { f.port.dispose(); }
});

test('invalid input and forged fields cannot reach transport or opt out of session replacement', async () => {
  const f = await fixture();
  try {
    const outcomes = await Promise.all([
      f.port.requestPasswordReset({ email: 'bad-email' }),
      f.port.requestPasswordReset({ email, accountId: 'forged' }),
      f.port.resetPassword({ email, otp: '1234', password: nextPassword }),
      f.port.resetPassword({ email, otp, password: 'short' }),
      f.port.changePassword({ currentPassword: password, newPassword: nextPassword, revokeOtherSessions: false }),
      f.port.requestEmailChange({ newEmail: nextEmail, currentPassword: '' }),
      f.port.changeEmail({ newEmail: nextEmail, otp: 87654321 }),
    ]);
    assert.ok(outcomes.every(value => value.status === 'failed'));
    assert.equal(f.calls.length, 0);
  } finally { f.port.dispose(); }
});

test('known rejections, mail unavailable and unknown outcomes stay distinct without leaking server messages', async () => {
  const f = await fixture(false);
  try {
    for (const [status, code, expected, safeCode] of [
      [400, 'INVALID_OTP', 'failed', 'INVALID_OTP'], [429, 'secret-code', 'failed', 'rate_limited'],
      [501, 'password_recovery_unavailable', 'failed', 'password_recovery_unavailable'],
      [503, 'private-provider-detail', 'unknown', 'request_failed'],
    ]) {
      f.setAction(() => response({ code, message: `private-provider-detail ${otp} ${password}` }, status));
      const result = await f.port.requestPasswordReset({ email });
      assert.equal(result.status, expected); assert.equal(result.issue.code, safeCode); noSecrets(result);
    }
    f.setAction(() => { throw new Error(`private-provider-detail ${password}`); });
    assert.equal((await f.port.resetPassword({ email, otp, password: nextPassword })).status, 'unknown');
    f.setAction(() => response({ token: 'raw-body-token' }));
    const malformed = await f.port.changeEmail({ newEmail: nextEmail, otp });
    assert.equal(malformed.status, 'unknown'); assert.equal(malformed.issue.code, 'invalid_response'); noSecrets(malformed);
  } finally { f.port.dispose(); }
});

test('authoritative password replacement adopts only its own session and returns no token or user payload', async () => {
  const f = await fixture();
  const events = [], listener = f.api.subscribeAuthChanges(source => events.push(source));
  try {
    f.setAction(() => response({ token: 'raw-body-token', user: { email } }, 200, { 'set-auth-token': 'replacement-token' }));
    const result = await f.port.changePassword({ currentPassword: password, newPassword: nextPassword });
    assert.deepEqual(result, { status: 'saved' }); noSecrets(result);
    assert.equal(JSON.parse(f.storage.value).token, 'replacement-token');
    assert.ok(events.length >= 2); assert.ok(events.every(source => source === f.port.replacementGuard));
    assert.equal(f.port.isCurrent(), true);
    assert.deepEqual(f.calls[0].body, { currentPassword: password, newPassword: nextPassword });
  } finally { listener.remove(); f.port.dispose(); }
});

test('failed own password attempt remains correctable; uncertain replacement keeps old token without replay', async () => {
  const f = await fixture();
  try {
    f.setAction(() => response({ code: 'INVALID_PASSWORD', message: 'private-provider-detail' }, 400));
    assert.equal((await f.port.changePassword({ currentPassword: password, newPassword: nextPassword })).status, 'failed');
    assert.equal(f.port.isCurrent(), true);
    f.setAction(() => { throw new Error('lost response'); });
    const result = await f.port.changePassword({ currentPassword: password, newPassword: nextPassword });
    assert.equal(result.status, 'unknown'); assert.equal(f.port.isCurrent(), true);
    assert.equal(f.calls.length, 2); assert.equal(JSON.parse(f.storage.value).token, 'signed-1');
  } finally { f.port.dispose(); }
});

test('different-account sign-in fences an in-flight replacement and cleans only its own issued token', async () => {
  const f = await fixture(), flight = deferred();
  try {
    f.setAction(() => flight.promise);
    const pending = f.port.changePassword({ currentPassword: password, newPassword: nextPassword });
    await f.api.signIn('other@synthetic.invalid', password);
    flight.resolve(response({ token: 'raw-body-token' }, 200, { 'set-auth-token': 'late-token' }));
    const result = await pending;
    assert.equal(result.issue.code, 'session_changed'); assert.equal(f.port.isCurrent(), false);
    assert.equal(JSON.parse(f.storage.value).token, 'signed-2');
    assert.equal(f.calls.find(call => call.path === '/api/auth/sign-out').headers.Authorization, 'Bearer late-token');
  } finally { f.port.dispose(); }
});

test('recovery controller progresses explicitly, enforces resend cooldown and never stores submitted secrets', async () => {
  const f = await fixture(false); let now = 1000;
  const controller = createForgotPasswordController(f.port, () => now), observed = [];
  const stop = controller.subscribe(() => observed.push(controller.snapshot()));
  try {
    await controller.requestCode(email); assert.equal(controller.snapshot().step, 'code');
    await controller.requestCode(email); assert.equal(f.calls.length, 1);
    now += 60000; await controller.requestCode(email); assert.equal(f.calls.length, 2);
    f.setAction(() => response({ code: 'OTP_EXPIRED', message: `private-provider-detail ${otp}` }, 400));
    await controller.submit(otp, nextPassword);
    assert.equal(controller.snapshot().issue.code, 'OTP_EXPIRED'); assert.equal(controller.snapshot().step, 'code');
    f.setAction(() => response({ success: true }, 200, { 'set-auth-token': 'unexpected-token' }));
    await controller.submit(otp, nextPassword);
    assert.equal(controller.snapshot().step, 'done'); assert.equal(controller.snapshot().email, email);
    assert.equal(f.storage.value, null); noSecrets(observed);
    controller.dispose(); assert.equal(controller.snapshot().email, '');
  } finally { stop(); controller.dispose(); f.port.dispose(); }
});

test('unknown reset offers sign-in reconciliation and cannot resubmit the reset automatically or through retained state', async () => {
  const f = await fixture(false), controller = createForgotPasswordController(f.port);
  try {
    await controller.requestCode(email);
    f.setAction(() => { throw new Error(`lost ${otp}`); });
    await controller.submit(otp, nextPassword);
    const state = controller.snapshot(); assert.equal(state.status, 'unknown'); assert.match(state.notice, /Try signing in/);
    await controller.submit(otp, nextPassword); assert.equal(f.calls.length, 2);
    assert.equal('retry' in state, false); noSecrets(state);
  } finally { controller.dispose(); f.port.dispose(); }
});

test('leaving a flow or signing in another account discards late recovery transitions', async () => {
  for (const leave of ['dispose', 'sign-in']) {
    const f = await fixture(false), flight = deferred(), controller = createForgotPasswordController(f.port);
    try {
      f.setAction(() => flight.promise);
      const pending = controller.requestCode(email);
      if (leave === 'dispose') controller.dispose(); else await f.api.signIn('other@synthetic.invalid', password);
      flight.resolve(response({ success: true })); await pending;
      assert.equal(controller.snapshot().status, 'disposed'); assert.equal(controller.snapshot().email, '');
    } finally { controller.dispose(); f.port.dispose(); }
  }
});

test('password controller validates confirmation, serializes submissions and adopts authoritative success', async () => {
  const f = await fixture(), flight = deferred(), controller = createChangePasswordController(f.port), observed = [];
  const stop = controller.subscribe(() => observed.push(controller.snapshot()));
  try {
    await controller.submit(password, 'short', 'short'); assert.equal(f.calls.length, 0);
    await controller.submit(password, nextPassword, 'different'); assert.equal(f.calls.length, 0);
    assert.equal(controller.snapshot().issue.code, 'password_mismatch');
    f.setAction(() => flight.promise);
    const pending = controller.submit(password, nextPassword, nextPassword);
    await controller.submit(password, nextPassword, nextPassword); assert.equal(f.calls.length, 1);
    flight.resolve(response({}, 200, { 'set-auth-token': 'replacement-token' })); await pending;
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(controller.snapshot().sessionReplaced, true);
    noSecrets(observed);
  } finally { stop(); controller.dispose(); f.port.dispose(); }
});

test('password controller treats unknown as reconciliation, not a retry closure', async () => {
  const f = await fixture(), controller = createChangePasswordController(f.port);
  try {
    f.setAction(() => { throw new Error('lost response'); });
    await controller.submit(password, nextPassword, nextPassword);
    assert.equal(controller.snapshot().status, 'unknown'); assert.equal(controller.snapshot().sessionReplaced, false);
    await controller.submit(password, nextPassword, nextPassword); assert.equal(f.calls.length, 1);
    assert.equal(JSON.parse(f.storage.value).token, 'signed-1'); noSecrets(controller.snapshot());
  } finally { controller.dispose(); f.port.dispose(); }
});

test('email change requires reauthentication, preserves saved truth when refresh fails, and retries only the read', async () => {
  const f = await fixture(); let reads = 0, failRead = true;
  const controller = createChangeEmailController(f.port, { currentEmail: email, refreshSettings: async () => {
    reads++; if (failRead) throw new Error('read unavailable');
  } });
  const observed = [], stop = controller.subscribe(() => observed.push(controller.snapshot()));
  try {
    await controller.confirm(otp); assert.equal(f.calls.length, 0);
    await controller.requestCode(email.toUpperCase(), password); assert.equal(f.calls.length, 0);
    await controller.requestCode(nextEmail, password); assert.equal(controller.snapshot().step, 'code');
    assert.deepEqual(f.calls[0].body, { newEmail: nextEmail, currentPassword: password });
    await controller.confirm(otp);
    assert.equal(controller.snapshot().status, 'saved'); assert.equal(controller.snapshot().step, 'done');
    assert.equal(controller.snapshot().refreshRequired, true); assert.equal(controller.snapshot().offerRevokeOtherSessions, true);
    assert.equal(reads, 1); assert.equal(f.calls.length, 2);
    failRead = false; await controller.refreshSettings();
    assert.equal(controller.snapshot().refreshRequired, false); assert.equal(reads, 2); assert.equal(f.calls.length, 2);
    await controller.confirm(otp); await controller.requestCode(nextEmail, password); assert.equal(f.calls.length, 2);
    assert.equal(JSON.parse(f.storage.value).token, 'signed-1'); noSecrets(observed);
  } finally { stop(); controller.dispose(); f.port.dispose(); }
});

test('account change during email confirmation or read refresh cannot publish to the new account', async () => {
  for (const stage of ['confirm', 'refresh']) {
    const f = await fixture(), flight = deferred(), refreshStarted = deferred();
    const controller = createChangeEmailController(f.port, { currentEmail: email,
      refreshSettings: stage === 'refresh' ? () => { refreshStarted.resolve(); return flight.promise; } : undefined });
    try {
      await controller.requestCode(nextEmail, password);
      if (stage === 'confirm') f.setAction(() => flight.promise);
      const pending = controller.confirm(otp);
      if (stage === 'refresh') await refreshStarted.promise;
      await f.api.signIn('other@synthetic.invalid', password);
      flight.resolve(stage === 'confirm' ? response({ success: true }) : undefined); await pending;
      assert.equal(controller.snapshot().status, 'disposed'); assert.equal(controller.snapshot().newEmail, '');
      assert.equal(JSON.parse(f.storage.value).token, 'signed-2');
    } finally { controller.dispose(); f.port.dispose(); }
  }
});

test('security display gates absent, future and other-account capabilities and masks phone identity', () => {
  const settings = { accountId: 'own', identity: { email, emailVerified: true, phoneNumber: '+12025550123', signInMethods: ['emailPassword', 'phone'] }, capabilities: {} };
  let facts = securityActions(settings, 'own');
  assert.equal(facts.changePassword, false); assert.equal(facts.changeEmail, false); assert.equal(facts.passwordRecovery, false);
  assert.equal(facts.phoneSuffix, '0123'); assert.ok(!JSON.stringify(facts).includes('+12025550123'));
  settings.capabilities = { changePassword: { supported: true, status: 'available' }, changeEmail: { supported: true, status: 'verified' }, passwordRecovery: { supported: true, status: 'future' } };
  facts = securityActions(settings, 'own'); assert.equal(facts.changePassword, true); assert.equal(facts.changeEmail, true); assert.equal(facts.passwordRecovery, false);
  facts = securityActions(settings, 'other'); assert.equal(facts.email, null); assert.equal(facts.changePassword, false);
  settings.identity.signInMethods = ['apple']; facts = securityActions(settings, 'own'); assert.equal(facts.changePassword, false); assert.equal(facts.changeEmail, false);
});

test('consumer transitions require confirmed completion and expose only explicit safe return values', async () => {
  for (const kind of ['recovery', 'password', 'email']) {
    for (const outcome of ['saved', 'failed', 'unknown']) {
      const f = await fixture(kind !== 'recovery'), flight = deferred();
      let failRead = true;
      const controller = kind === 'recovery' ? createForgotPasswordController(f.port)
        : kind === 'password' ? createChangePasswordController(f.port)
          : createChangeEmailController(f.port, { currentEmail: email, refreshSettings: async () => {
            if (failRead) throw new Error('read unavailable');
          } });
      try {
        assert.equal(controller.transition(), null);
        if (kind === 'recovery') await controller.requestCode(' Member@synthetic.invalid ');
        if (kind === 'email') await controller.requestCode(' Next@synthetic.invalid ', password);
        assert.equal(controller.transition(), null);
        f.setAction(() => flight.promise);
        const pending = kind === 'recovery' ? controller.submit(otp, nextPassword)
          : kind === 'password' ? controller.submit(password, nextPassword, nextPassword) : controller.confirm(otp);
        assert.equal(controller.transition(), null);
        flight.resolve(outcome === 'saved'
          ? response({ success: true }, 200, kind === 'password' ? { 'set-auth-token': 'replacement-token' } : {})
          : response({ code: 'INVALID_PASSWORD', message: 'private-provider-detail' }, outcome === 'failed' ? 400 : 503));
        await pending;
        assert.equal(controller.snapshot().status, outcome);
        const calls = f.calls.length, target = controller.transition();
        if (outcome !== 'saved') assert.equal(target, null);
        else {
          const expected = kind === 'recovery' ? { destination: 'sign-in', reason: 'password-reset', emailPrefill: email }
            : kind === 'password' ? { destination: 'settings', reason: 'password-changed',
              notice: 'Password changed. Your other devices were signed out.' }
              : { destination: 'settings', reason: 'email-changed', newEmail: nextEmail,
                notice: `Your sign-in email is now ${nextEmail}.`, refreshRequired: true, offerRevokeOtherSessions: true };
          assert.deepEqual(target, expected); assert.ok(Object.isFrozen(target)); noSecrets(target);
          assert.deepEqual(controller.transition(), expected);
          if (kind === 'recovery') assert.equal(f.storage.value, null);
          if (kind === 'password') assert.equal(JSON.parse(f.storage.value).token, 'replacement-token');
          if (kind === 'email') {
            failRead = false; await controller.refreshSettings();
            assert.deepEqual(controller.transition(), { ...expected, refreshRequired: false });
          }
        }
        assert.equal(f.calls.length, calls);
        controller.dispose(); assert.equal(controller.transition(), null);
      } finally { controller.dispose(); f.port.dispose(); }
    }
  }
});

test('consumer targets fence foreign accounts and distinguish known current-owner session end from unknown or disposed', async () => {
  for (const kind of ['recovery', 'password', 'email']) {
    for (const stage of ['pending', 'saved']) {
      const f = await fixture(kind !== 'recovery'), flight = deferred();
      const controller = kind === 'recovery' ? createForgotPasswordController(f.port)
        : kind === 'password' ? createChangePasswordController(f.port)
          : createChangeEmailController(f.port, { currentEmail: email });
      try {
        if (kind === 'recovery') await controller.requestCode(email);
        if (kind === 'email') await controller.requestCode(nextEmail, password);
        f.setAction(() => flight.promise);
        const pending = kind === 'recovery' ? controller.submit(otp, nextPassword)
          : kind === 'password' ? controller.submit(password, nextPassword, nextPassword) : controller.confirm(otp);
        if (stage === 'pending') await f.api.signIn('other@synthetic.invalid', password);
        flight.resolve(response({ success: true }, 200, kind === 'password' ? { 'set-auth-token': 'replacement-token' } : {}));
        await pending;
        if (stage === 'saved') {
          assert.notEqual(controller.transition(), null);
          await f.api.signIn('other@synthetic.invalid', password);
        }
        assert.equal(controller.transition(), null);
        assert.equal(controller.snapshot().status, 'disposed');
        assert.equal(JSON.parse(f.storage.value).token, kind === 'recovery' ? 'signed-1' : 'signed-2');
      } finally { controller.dispose(); f.port.dispose(); }
    }
  }
  for (const rejection of ['no-token', 'http-401', 'known-session-change', 'unknown-session-change']) {
    const f = await fixture(rejection === 'http-401');
    const port = rejection.endsWith('session-change') ? { ...f.port, changePassword: async () => ({
      status: rejection === 'known-session-change' ? 'failed' : 'unknown',
      issue: { code: 'session_changed', status: 409, effectUnknown: rejection === 'unknown-session-change' },
    }) } : f.port;
    const controller = createChangePasswordController(port);
    try {
      f.setAction(() => response({ message: 'private-provider-detail' }, 401));
      await controller.submit(password, nextPassword, nextPassword);
      if (rejection === 'http-401' || rejection === 'unknown-session-change') assert.equal(controller.transition(), null);
      else {
        assert.deepEqual(controller.transition(), { destination: 'sign-in', reason: 'session-ended',
          notice: 'Your session ended. Sign in again — if you just changed your password, use the new one.' });
        noSecrets(controller.transition());
        f.leave(); assert.equal(controller.transition(), null);
      }
      if (rejection === 'http-401') assert.equal(controller.snapshot().status, 'disposed');
    } finally { controller.dispose(); f.port.dispose(); }
  }
});
