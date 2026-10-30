const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../..');
function load(name, imports = {}) {
  const file = path.join(root, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected runtime dependency: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const transport = load('api/transport.ts');
const credentials = load('api/credentials.ts', { './transport': transport });
const model = load('features/credentials/model.ts', { '../../api/credentials': credentials });
const { createRecoveryConsumer } = load('features/credentials/recovery-consumer.ts', { './model': model });
const saved = Object.freeze({ status: 'saved' });
const failure = (code, status = 422, effectUnknown = false) => ({ status: effectUnknown ? 'unknown' : 'failed',
  issue: { code, status, effectUnknown } });
const email = 'member@synthetic.invalid', nextEmail = 'next@synthetic.invalid';
const currentPassword = 'synthetic-current-password', password = 'synthetic-next-password', otp = '87654321';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function frozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
function safe(value) {
  const json = JSON.stringify(value);
  for (const secret of [currentPassword, password, otp]) assert.ok(!json?.includes(secret), `Exposed secret: ${secret}`);
  frozen(value);
}
function fakePort() {
  let live = true;
  const calls = [], responses = {};
  const port = { replacementGuard: { isCurrent: () => live }, isCurrent: () => live, dispose() { live = false; } };
  for (const command of ['changePassword', 'requestEmailChange', 'changeEmail', 'requestPasswordReset', 'resetPassword']) {
    port[command] = async input => { calls.push({ command, input }); return responses[command] ? responses[command](input) : saved; };
  }
  return { port, calls, responses, leave() { live = false; } };
}
function settings() {
  return { accountId: 'own', identity: { email, emailVerified: true, phoneNumber: '+15555551234', signInMethods: ['emailPassword'] },
    capabilities: { changePassword: { supported: true, status: 'available' }, changeEmail: { supported: true, status: 'configured_unverified' },
      passwordRecovery: { supported: true, status: 'verified' } } };
}
function fixture({ sessionAction = true } = {}) {
  const f = fakePort(), events = [], counts = { guards: 0, constructed: 0 };
  let current = true, read = async () => {}, revoke = async () => ({ status: 'saved', value: null });
  const ctx = { account: { accountId: 'own' }, sessionGeneration: 'epoch-1', settings: settings(), credentials: f.port,
    isCurrentSession() { counts.guards++; return current; }, close() { events.push('close'); }, onSignedOut() { events.push('signed-out'); },
    reload: async () => assert.fail('Consumer must not invoke reload'),
    resources: { settings: async () => { events.push('read'); return read(); } },
    ...(sessionAction ? { sessionAction: async action => { events.push(action); return revoke(); } } : {}) };
  const countedModel = { ...model };
  for (const name of ['createChangePasswordController', 'createChangeEmailController']) countedModel[name] = (...args) => {
    counts.constructed++; return model[name](...args);
  };
  const { createAccountSecurityConsumer } = load('features/credentials/consumer.ts', { './model': countedModel });
  const consumer = createAccountSecurityConsumer(ctx);
  return { ...f, ctx, consumer, events, counts, leave() { current = false; }, setRead(fn) { read = fn; }, setRevoke(fn) { revoke = fn; } };
}
async function emailCode(f) {
  assert.equal(f.consumer.open('change-email'), true);
  await f.consumer.requestEmailCode(' NEXT@synthetic.invalid ', currentPassword);
  assert.equal(f.consumer.snapshot().flow.step, 'code');
}
function observe(consumer) {
  const snapshots = [], payloads = [];
  const unsubscribe = consumer.subscribe((...args) => { payloads.push(args); const value = consumer.snapshot(); safe(value); snapshots.push(value); });
  return { snapshots, payloads, unsubscribe };
}

test('A-01 identity and availability follow owned, recognized security capabilities; snapshots are deeply frozen', () => {
  const cases = [
    [() => {}, [true, true, true], ['apple', 'google', 'phone']],
    [s => { s.accountId = 'other'; }, [false, false, false], []],
    [s => { s.capabilities = {}; }, [false, false, false], ['apple', 'google', 'phone']],
    [s => { for (const cap of Object.values(s.capabilities)) cap.status = 'future'; }, [false, false, false], ['apple', 'google', 'phone']],
    [s => { s.identity.signInMethods = ['phone', 'apple', 'google']; }, [false, false, false], ['phone', 'apple', 'google']],
    [s => { s.identity.email = null; }, [true, false, true], ['apple', 'google', 'phone']],
    [s => { for (const cap of Object.values(s.capabilities)) cap.supported = false; }, [false, false, false], ['apple', 'google', 'phone']],
  ];
  for (const [change, available, providers] of cases) {
    const f = fixture(); f.ctx.settings.identity.signInMethods.push('apple', 'google', 'phone', 'future'); change(f.ctx.settings);
    const state = f.consumer.snapshot(); safe(state);
    assert.deepEqual([state.available.changePassword, state.available.changeEmail, state.available.passwordRecovery], available);
    assert.deepEqual(state.identity.providers, providers);
    assert.equal(state.identity.phoneSuffix, f.ctx.settings.accountId === 'own' ? '1234' : null);
    assert.equal(state.identity.email, f.ctx.settings.accountId === 'own' ? f.ctx.settings.identity.email : null);
    assert.equal(state.identity.emailVerified, state.identity.email !== null && f.ctx.settings.accountId === 'own');
    f.consumer.dispose();
  }
  const f = fixture({ sessionAction: false }); f.ctx.settings = null;
  assert.deepEqual(f.consumer.snapshot().available, { changePassword: false, changeEmail: false, passwordRecovery: false, revokeOtherSessions: false });
  assert.deepEqual(f.consumer.snapshot().identity, { email: null, emailVerified: false, phoneSuffix: null, providers: [] });
  assert.equal(f.consumer.open('change-password'), false); assert.equal(f.counts.constructed, 0); f.consumer.dispose();
  const stale = fixture(); stale.leave();
  assert.equal(stale.consumer.open('change-email'), false); assert.equal(stale.counts.constructed, 0);
});

test('A-02/A-03 accepted resolution: deny pending open/double dispatch; cancel then reopen drops old results; idle replacement detaches', async () => {
  const f = fixture(), old = deferred(); f.responses.changePassword = () => old.promise;
  assert.equal(f.consumer.open('change-password'), true); const seen = observe(f.consumer);
  const work = f.consumer.changePassword(currentPassword, password, password);
  assert.equal(f.consumer.snapshot().flow.canSubmit, false);
  assert.equal(f.consumer.open('change-email'), false); assert.equal(f.counts.constructed, 1);
  await f.consumer.changePassword(currentPassword, password, password); assert.equal(f.calls.length, 1);
  f.consumer.cancel(); assert.equal(f.consumer.open('change-email'), true);
  const count = seen.snapshots.length; old.resolve(saved); await work;
  assert.equal(seen.snapshots.length, count); assert.equal(f.consumer.snapshot().active, 'change-email');
  assert.equal(f.consumer.open('change-password'), true); assert.equal(f.counts.constructed, 3);
  f.consumer.dispose();
});

test('A-04/A-08 saved password exposes no secrets, cannot resubmit, and finishes through close exactly once', async () => {
  const f = fixture(), seen = observe(f.consumer); f.consumer.open('change-password');
  f.consumer.finish(); assert.deepEqual(f.events, []);
  await f.consumer.changePassword(currentPassword, password, password);
  assert.equal(f.consumer.snapshot().flow.status, 'saved'); safe(f.consumer.snapshot());
  assert.deepEqual(f.calls[0].input, { currentPassword, newPassword: password });
  await f.consumer.changePassword(currentPassword, password, password);
  f.consumer.finish(); f.consumer.finish(); assert.deepEqual(f.events, ['close']); assert.equal(f.calls.length, 1);
  for (const state of seen.snapshots) safe(state);
  assert.ok(seen.payloads.every(args => args.length === 0)); f.consumer.dispose();
});

test('A-06 controller password correction messages and confirmation validation remain authoritative', async () => {
  const f = fixture(); f.consumer.open('change-password');
  await f.consumer.changePassword(currentPassword, 'short', 'short');
  assert.equal(f.consumer.snapshot().flow.message, 'Use a password between 12 and 128 characters.');
  await f.consumer.changePassword(currentPassword, password, 'different');
  assert.equal(f.consumer.snapshot().flow.message, 'Your new passwords do not match.'); assert.equal(f.calls.length, 0);
  for (const [code, message] of [['INVALID_PASSWORD', "That isn't your current password."],
    ['PASSWORD_TOO_SHORT', 'Use a password between 12 and 128 characters.'], ['rate_limited', 'Too many requests. Try again in a few minutes.']]) {
    f.responses.changePassword = () => failure(code);
    await f.consumer.changePassword(currentPassword, password, password);
    assert.equal(f.consumer.snapshot().flow.message, message); assert.equal(f.consumer.snapshot().flow.canSubmit, true);
    safe(f.consumer.snapshot()); f.consumer.finish(); assert.deepEqual(f.events, []);
  }
  f.responses.changePassword = () => saved; await f.consumer.changePassword(currentPassword, password, password);
  assert.equal(f.consumer.snapshot().flow.status, 'saved'); f.consumer.dispose();
});

test('A-09 known 401 and session_changed finish once through onSignedOut; unknown effects never do', async () => {
  for (const [code, status] of [['unauthenticated', 401], ['session_changed', 409]]) {
    const f = fixture(); f.responses.changePassword = () => failure(code, status);
    f.consumer.open('change-password'); await f.consumer.changePassword(currentPassword, password, password);
    f.consumer.finish(); f.consumer.finish(); assert.deepEqual(f.events, ['signed-out']); f.consumer.dispose();
    const unknown = fixture(); unknown.responses.changePassword = () => failure(code, status, true);
    unknown.consumer.open('change-password'); await unknown.consumer.changePassword(currentPassword, password, password);
    unknown.consumer.finish(); assert.deepEqual(unknown.events, []); unknown.consumer.dispose();
  }
});

test('A-06 email confirmation errors permit correction with existing controller copy and no transition', async () => {
  const f = fixture(); await emailCode(f);
  for (const [code, message] of [['INVALID_OTP', "That code didn't work. Check it and try again."],
    ['OTP_EXPIRED', 'That code has expired. Request a new one.'], ['TOO_MANY_ATTEMPTS', 'Too many tries. Request a new code.'],
    ['EMAIL_ALREADY_IN_USE', 'Email already in use.'], ['rate_limited', 'Too many requests. Try again in a few minutes.']]) {
    f.responses.changeEmail = () => failure(code); await f.consumer.confirmEmail(otp);
    assert.equal(f.consumer.snapshot().flow.message, message); assert.equal(f.consumer.snapshot().flow.canSubmit, true);
    safe(f.consumer.snapshot()); f.consumer.finish(); assert.deepEqual(f.events, []);
  }
  f.consumer.dispose();
});

test('A-07 unknown password/email mutations cannot be replayed or emit a completion transition', async () => {
  for (const [code, status] of [['request_failed', 500], ['network_unavailable', 0], ['session_changed', 409]]) {
    for (const kind of ['change-password', 'change-email']) {
      const f = fixture(), seen = observe(f.consumer);
      if (kind === 'change-email') await emailCode(f); else f.consumer.open(kind);
      f.responses[kind === 'change-email' ? 'changeEmail' : 'changePassword'] = () => failure(code, status, true);
      if (kind === 'change-email') await f.consumer.confirmEmail(otp);
      else await f.consumer.changePassword(currentPassword, password, password);
      const count = f.calls.length;
      assert.equal(f.consumer.snapshot().flow.status, 'unknown'); assert.equal(f.consumer.snapshot().flow.canSubmit, false);
      assert.match(f.consumer.snapshot().flow.message, /couldn't confirm/);
      await f.consumer.changePassword(currentPassword, password, password);
      await f.consumer.confirmEmail(otp); await f.consumer.requestEmailCode(nextEmail, currentPassword);
      await f.consumer.retryRefresh(); f.consumer.finish();
      assert.equal(f.calls.length, count); assert.deepEqual(f.events, []);
      seen.snapshots.forEach(safe); f.consumer.dispose();
    }
  }
  const f = fixture(); f.responses.requestEmailChange = () => failure('request_failed', 500, true);
  f.consumer.open('change-email'); await f.consumer.requestEmailCode(nextEmail, currentPassword);
  await f.consumer.requestEmailCode(nextEmail, currentPassword); await f.consumer.confirmEmail(otp);
  assert.equal(f.calls.length, 1); f.consumer.dispose();
});

test('A-10 saved email survives a failed read; refresh and finish do not replay mutation', async () => {
  const f = fixture(), seen = observe(f.consumer); f.setRead(async () => { throw new Error('synthetic read failure'); });
  await emailCode(f); assert.equal(f.consumer.snapshot().confirmedEmail, null);
  await f.consumer.confirmEmail(otp);
  assert.equal(f.consumer.snapshot().flow.status, 'saved'); assert.equal(f.consumer.snapshot().confirmedEmail, nextEmail);
  assert.equal(f.consumer.snapshot().flow.refreshRequired, true); assert.equal(f.consumer.snapshot().flow.refreshing, false);
  assert.deepEqual(f.events, ['read']); assert.equal(f.calls.length, 2);
  const read = deferred(); f.setRead(() => read.promise);
  const work = f.consumer.retryRefresh(); assert.equal(f.consumer.snapshot().flow.refreshing, true);
  await f.consumer.retryRefresh(); assert.equal(f.consumer.open('change-password'), false);
  read.resolve(); await work; assert.equal(f.consumer.snapshot().flow.refreshRequired, false);
  await f.consumer.confirmEmail(otp); await f.consumer.requestEmailCode(nextEmail, currentPassword);
  f.consumer.finish(); f.consumer.finish(); assert.deepEqual(f.events, ['read', 'read', 'close']); assert.equal(f.calls.length, 2);
  assert.equal(f.consumer.snapshot().confirmedEmail, nextEmail); seen.snapshots.forEach(safe); f.consumer.dispose();
});

test('A-11 revocation is explicit, saved-email-only, absent-safe, and never executes unknown retry closures', async () => {
  for (const sessionAction of [false, true]) {
    const f = fixture({ sessionAction });
    assert.equal(await f.consumer.revokeOtherSessions(), 'unavailable'); await emailCode(f);
    assert.equal(await f.consumer.revokeOtherSessions(), 'unavailable'); await f.consumer.confirmEmail(otp);
    assert.equal(f.consumer.snapshot().flow.offerRevokeOtherSessions, sessionAction);
    assert.deepEqual(f.events, ['read']);
    assert.equal(await f.consumer.revokeOtherSessions(), sessionAction ? 'saved' : 'unavailable');
    assert.deepEqual(f.events, sessionAction ? ['read', 'revokeOtherSessions'] : ['read']);
    if (sessionAction) {
      f.setRevoke(async () => ({ status: 'unknown', retry: () => assert.fail('No session action retry authority') }));
      assert.equal(await f.consumer.revokeOtherSessions(), 'failed');
      assert.equal(f.events.filter(e => e === 'revokeOtherSessions').length, 2);
      const wait = deferred(); f.setRevoke(() => wait.promise);
      const work = f.consumer.revokeOtherSessions();
      assert.equal(await f.consumer.revokeOtherSessions(), 'unavailable');
      assert.equal(f.events.filter(e => e === 'revokeOtherSessions').length, 3);
      wait.resolve({ status: 'saved', value: null }); assert.equal(await work, 'saved');
      f.setRevoke(async () => { throw new Error('synthetic session failure'); });
      assert.equal(await f.consumer.revokeOtherSessions(), 'failed');
    }
    f.consumer.dispose();
  }
});

test('A-12 session, account and epoch changes terminally dispose, suppress late publications, and stop future context calls', async () => {
  for (const invalidate of [f => f.leave(), f => { f.ctx.account = { accountId: 'foreign' }; },
    f => { f.ctx.sessionGeneration = 'foreign-epoch'; }]) {
    const f = fixture(), wait = deferred(), seen = observe(f.consumer);
    f.responses.changePassword = () => wait.promise; f.consumer.open('change-password');
    const work = f.consumer.changePassword(currentPassword, password, password); invalidate(f);
    assert.equal(f.consumer.snapshot().status, 'disposed'); const guards = f.counts.guards, count = seen.snapshots.length;
    wait.resolve(saved); await work;
    assert.equal(f.consumer.open('change-email'), false); f.consumer.cancel(); f.consumer.finish(); f.consumer.dispose(); f.consumer.dispose();
    await f.consumer.changePassword(currentPassword, password, password); await f.consumer.requestEmailCode(nextEmail, currentPassword);
    await f.consumer.confirmEmail(otp); await f.consumer.retryRefresh(); assert.equal(await f.consumer.revokeOtherSessions(), 'unavailable');
    f.consumer.subscribe(() => assert.fail('Disposed consumer cannot subscribe'))(); seen.unsubscribe();
    assert.equal(f.counts.guards, guards); assert.equal(seen.snapshots.length, count); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.events, []); safe(f.consumer.snapshot());
  }
});

test('A-12 currentness is rechecked between saved-email publication and automatic read, and during refresh/revocation', async () => {
  const f = fixture(); await emailCode(f);
  f.consumer.subscribe(() => { if (f.consumer.snapshot().flow?.step === 'done') f.leave(); });
  await f.consumer.confirmEmail(otp);
  assert.equal(f.consumer.snapshot().status, 'disposed'); assert.deepEqual(f.events, []);
  for (const action of ['refresh', 'revoke']) {
    const g = fixture(); await emailCode(g); g.setRead(async () => { throw new Error('read'); }); await g.consumer.confirmEmail(otp);
    const wait = deferred(); if (action === 'refresh') g.setRead(() => wait.promise); else g.setRevoke(() => wait.promise);
    const seen = observe(g.consumer), work = action === 'refresh' ? g.consumer.retryRefresh() : g.consumer.revokeOtherSessions();
    g.leave(); assert.equal(g.consumer.snapshot().status, 'disposed'); const count = seen.snapshots.length;
    wait.resolve({ status: 'saved', value: null }); await work; assert.equal(seen.snapshots.length, count);
    g.consumer.finish(); assert.ok(!g.events.includes('close')); g.consumer.dispose();
  }
});

test('A-03/A-12 explicit dispose while pending detaches the old consumer before a new consumer opens', async () => {
  const f = fixture(), wait = deferred(), seen = observe(f.consumer); f.responses.changePassword = () => wait.promise;
  f.consumer.open('change-password'); const work = f.consumer.changePassword(currentPassword, password, password);
  f.consumer.dispose(); const count = seen.snapshots.length;
  const { createAccountSecurityConsumer } = load('features/credentials/consumer.ts', { './model': model });
  const next = createAccountSecurityConsumer(f.ctx); next.open('change-email');
  wait.resolve(saved); await work;
  assert.equal(seen.snapshots.length, count); assert.equal(f.consumer.snapshot().status, 'disposed');
  assert.equal(next.snapshot().active, 'change-email'); next.dispose();
});

test('A-13 recovery validation, normalized email, cooldown boundary and 501 availability use controller state', async () => {
  let now = 1000; const f = fakePort(), c = createRecoveryConsumer(f.port, () => now), seen = observe(c);
  await c.requestCode('invalid'); assert.equal(f.calls.length, 0); assert.equal(c.snapshot().message, 'Enter a valid email address.');
  f.responses.requestPasswordReset = () => failure('password_recovery_unavailable', 501);
  await c.requestCode(email); assert.equal(c.snapshot().unavailable, true); assert.equal(c.snapshot().canRequestCode, true);
  f.responses.requestPasswordReset = () => saved;
  await c.requestCode(' MEMBER@synthetic.invalid '); assert.equal(c.snapshot().email, email); assert.equal(c.snapshot().unavailable, false);
  assert.equal(c.snapshot().resendInSeconds, 60); const count = f.calls.length;
  await c.requestCode(email); assert.equal(f.calls.length, count);
  now += 59999; assert.equal(c.snapshot().resendInSeconds, 1); assert.equal(c.snapshot().canRequestCode, false);
  now++; assert.equal(c.snapshot().resendInSeconds, 0); assert.equal(c.snapshot().canRequestCode, true);
  await c.requestCode(email); assert.equal(f.calls.length, count + 1); assert.equal(c.signInTarget(), null);
  c.startOver(); assert.equal(c.snapshot().step, 'email'); seen.snapshots.forEach(safe); c.dispose();
});

test('A-13 recovery double submit, saved/unknown sign-in reconciliation and secret custody cannot replay a reset', async () => {
  for (const outcome of [saved, failure('request_failed', 500, true)]) {
    const f = fakePort(), wait = deferred(), c = createRecoveryConsumer(f.port, () => 0), seen = observe(c);
    await c.requestCode(' MEMBER@synthetic.invalid '); f.responses.resetPassword = () => wait.promise;
    const work = c.submit(otp, password); assert.equal(c.snapshot().canSubmit, false); await c.submit(otp, password);
    assert.equal(f.calls.filter(x => x.command === 'resetPassword').length, 1); assert.equal(c.signInTarget(), null);
    wait.resolve(outcome); await work;
    assert.deepEqual(c.signInTarget(), { emailPrefill: email }); safe(c.signInTarget());
    assert.equal(c.snapshot().canSubmit, false); assert.equal(c.snapshot().canRequestCode, false);
    c.startOver(); await c.submit(otp, password); await c.requestCode(nextEmail);
    assert.equal(f.calls.length, 2); seen.snapshots.forEach(safe);
    if (outcome.status === 'unknown') assert.match(c.snapshot().message, /Try signing in with your new password/);
    c.dispose(); assert.equal(c.signInTarget(), null);
  }
});

test('A-13 unknown recovery code dispatch is not a reset reconciliation target; known reset failure allows correction', async () => {
  let now = 0; const f = fakePort(), c = createRecoveryConsumer(f.port, () => now);
  f.responses.requestPasswordReset = () => failure('network_unavailable', 0, true);
  await c.requestCode(email); assert.equal(c.signInTarget(), null); assert.equal(c.snapshot().canSubmit, false);
  now = 60000; f.responses.requestPasswordReset = () => saved; await c.requestCode(email);
  f.responses.resetPassword = () => failure('INVALID_OTP'); await c.submit(otp, password);
  assert.equal(c.signInTarget(), null); assert.equal(c.snapshot().canSubmit, true);
  assert.equal(c.snapshot().message, "That code didn't work. Check it and try again.");
  f.responses.resetPassword = () => saved; await c.submit(otp, password);
  assert.deepEqual(c.signInTarget(), { emailPrefill: email }); c.dispose();
});

test('A-13 recovery disposal/currentness drops late requests and resets and stops listener and port access', async () => {
  for (const explicit of [false, true]) for (const reset of [false, true]) {
    const f = fakePort(), c = createRecoveryConsumer(f.port), wait = deferred(), seen = observe(c);
    if (reset) await c.requestCode(email);
    f.responses[reset ? 'resetPassword' : 'requestPasswordReset'] = () => wait.promise;
    const work = reset ? c.submit(otp, password) : c.requestCode(email); if (explicit) c.dispose(); else f.leave();
    assert.equal(c.snapshot().status, 'disposed'); const count = seen.snapshots.length;
    // The existing controller owns its own late-result currentness check.
    f.port.isCurrent = () => false; wait.resolve(saved); await work;
    f.port.isCurrent = () => { throw new Error('Disposed adapter called port'); };
    await c.requestCode(email); await c.submit(otp, password); c.startOver(); c.dispose(); c.dispose();
    assert.equal(c.signInTarget(), null); c.subscribe(() => assert.fail('Disposed listener'))(); seen.unsubscribe();
    assert.equal(seen.snapshots.length, count); assert.equal(f.calls.length, reset ? 2 : 1); safe(c.snapshot());
  }
});

test('A-14 consumers use only the declared model runtime and type bindings, with no timers or secret fields', () => {
  for (const file of ['consumer.ts', 'recovery-consumer.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const node of parsed.statements.filter(ts.isImportDeclaration)) {
      const name = node.moduleSpecifier.text;
      assert.ok(['./model', '../contract', '../../api/credentials'].includes(name));
      if (name !== './model') assert.equal(node.importClause.isTypeOnly, true);
    }
    assert.doesNotMatch(source, /\b(?:setTimeout|setInterval|createCredentialsPort|AsyncStorage|localStorage|SecureStore)\b/);
    assert.doesNotMatch(source, /from ['"]react(?:-native)?['"]/);
  }
});
