const assert = require('node:assert/strict');
const { test } = require('node:test');
const { FormTransport, ApiError } = require('../.scratch/api-tests/transport.js');
const base = 'http://127.0.0.1:8766';
const storage = (saved = null) => ({ value: saved, async load() { return this.value; }, async save(value) { this.value = value; }, async clear() { this.value = null; } });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('unconfigured Activity reads accept JSON null without hiding invalid responses', async () => {
  const empty = new FormTransport(base, storage(), async () => json(null));
  for (const path of ['/v1/activity/calendar', '/v1/activity/schedule']) {
    assert.equal(await empty.request(path), null);
    await assert.rejects(empty.request(path, 'POST', {}, 'same-intent'), { code: 'invalid_response', effectUnknown: true });
    const malformed = new FormTransport(base, storage(), async () => new Response('not-json'));
    await assert.rejects(malformed.request(path), { code: 'invalid_response', effectUnknown: false });
  }
  await assert.rejects(empty.request('/v1/me'), { code: 'invalid_response' });
});

test('old-session data and 401 responses cannot affect a newly signed-in account', async () => {
  for (const status of [200, 401]) {
    const store = storage(); let release; let signIns = 0;
    const api = new FormTransport(base, store, async (url) => {
      if (url.endsWith('/sign-in/email')) return json({}, 200, { 'set-auth-token': `signed-${++signIns}` });
      return new Promise(resolve => { release = resolve; });
    });
    await api.signIn('first@example.invalid', 'synthetic-password');
    const pending = api.request('/v1/me');
    const rejected = assert.rejects(pending, { code: 'session_changed', effectUnknown: false });
    await api.signIn('second@example.invalid', 'synthetic-password');
    release(json(status === 200 ? { accountId: 'first-private-account' } : { error: { code: 'unauthenticated' } }, status));
    await rejected;
    assert.equal(JSON.parse(store.value).token, 'signed-2');
  }
});

test('old-session unknown mutations cannot offer replay under a different account', async () => {
  const store = storage(); let rejectRequest; let signIns = 0; const calls = [];
  const api = new FormTransport(base, store, async (url, init) => {
    if (url.endsWith('/sign-in/email')) return json({}, 200, { 'set-auth-token': `signed-${++signIns}` });
    calls.push(init);
    return new Promise((resolve, reject) => { rejectRequest = reject; });
  });
  await api.signIn('first@example.invalid', 'synthetic-password');
  const pending = api.request('/v1/plans', 'POST', { name: 'First account plan' }, 'stable-command');
  const rejected = assert.rejects(pending, { code: 'session_changed', effectUnknown: false, originalEffectUnknown: true });
  await api.signIn('second@example.invalid', 'synthetic-password');
  rejectRequest(new Error('old response lost'));
  await rejected;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer signed-1');
  assert.equal(JSON.parse(store.value).token, 'signed-2');
});

test('signed response header is retained; raw auth JSON token is never used', async () => {
  const store = storage(); const calls = [];
  const api = new FormTransport(base, store, async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/sign-in/email') ? json({ token: 'raw-invalid-bearer' }, 200, { 'set-auth-token': 'signed-header' }) : json({ accountId: 'a' });
  });
  await api.signIn('synthetic@example.invalid', 'synthetic-password'); await api.request('/v1/me');
  assert.equal(JSON.parse(store.value).token, 'signed-header');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer signed-header');
  assert.equal(calls[1].init.redirect, 'error');
  const bad = new FormTransport(base, storage(), async () => json({ token: 'raw-only' }));
  await assert.rejects(bad.signIn('synthetic@example.invalid', 'synthetic-password'), { code: 'missing_session' });
});

test('stored session is origin-bound and invalidated after revocation', async () => {
  const wrong = storage(JSON.stringify({ version: 1, baseURL: 'https://other.example', token: 'secret' }));
  let calls = 0;
  assert.equal(await new FormTransport(base, wrong, async () => { calls++; return json({}); }).restore(), false);
  assert.equal(calls, 0); assert.equal(wrong.value, null);
  const revoked = storage(JSON.stringify({ version: 1, baseURL: base, token: 'signed' }));
  assert.equal(await new FormTransport(base, revoked, async () => json({ error: { code: 'unauthenticated' } }, 401)).restore(), false);
  assert.equal(revoked.value, null);
});

test('native identity proof uses server verification and signed session transport', async () => {
  const store = storage(); const calls = [];
  const api = new FormTransport(base, store, async (url, init) => { calls.push({ url, init }); return json({}, 200, { 'set-auth-token': 'signed-social-session' }); });
  await api.signInIdentity('apple', { token: 'synthetic-provider-proof', nonce: 'request-nonce' });
  assert.equal(calls[0].url, base + '/api/auth/sign-in/social');
  assert.deepEqual(JSON.parse(calls[0].init.body), { provider: 'apple', idToken: { token: 'synthetic-provider-proof', nonce: 'request-nonce' } });
  assert.equal(JSON.parse(store.value).token, 'signed-social-session');
  await assert.rejects(api.signInIdentity('google', { token: '' }), { code: 'invalid_identity_proof' });
  assert.equal(calls.length, 1);
});

test('phone proof exchange retains the signed session and exact caller-owned key without linking fields', async () => {
  const store = storage(); const calls = [];
  const api = new FormTransport(base, store, async (url, init) => {
    calls.push({ url, init }); return json({ status: true, token: 'raw-phone-token' }, 200, { 'set-auth-token': 'signed-phone' });
  });
  const proof = { phoneNumber: '+12025550123', binding: 'a'.repeat(43), challengeId: '11111111-1111-4111-8111-111111111111', code: '123456' };
  await api.signInPhone({ ...proof, accountId: 'untrusted-extra' }, 'phone-check-key-0001');
  assert.equal(calls[0].url, base + '/api/auth/phone-number/verify');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'phone-check-key-0001');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), proof);
  assert.equal(JSON.parse(store.value).token, 'signed-phone');
  for (const invalid of [{ ...proof, code: 'words' }, { ...proof, binding: 'short' }, { ...proof, phoneNumber: '2025550123' }]) {
    await assert.rejects(api.signInPhone(invalid, 'phone-check-key-0002'), { code: 'invalid_phone_proof' });
  }
  assert.equal(calls.length, 1);
});

test('unknown phone verification is not replayed automatically or converted into a session', async () => {
  const store = storage(); const calls = [];
  const api = new FormTransport(base, store, async (url, init) => { calls.push({ url, init }); throw new Error('lost verification response'); });
  const proof = { phoneNumber: '+12025550123', binding: 'a'.repeat(43), challengeId: '11111111-1111-4111-8111-111111111111', code: '123456' };
  await assert.rejects(api.signInPhone(proof, 'phone-check-key-0001'), { effectUnknown: true });
  assert.equal(calls.length, 1); assert.equal(store.value, null);
});

test('unknown commands are not automatically replayed; caller retry preserves key and payload', async () => {
  const calls = []; let first = true;
  const api = new FormTransport(base, storage(), async (url, init) => {
    calls.push(init); if (first) { first = false; throw new Error('lost response'); } return json({ id: 'saved' });
  });
  const body = { expectedRevision: 1, reps: 8, weightKg: 5, status: 'confirmed' };
  await assert.rejects(api.request('/v1/sets/example', 'PATCH', body, 'stable-command'), error => error instanceof ApiError && error.effectUnknown);
  assert.equal(calls.length, 1);
  await api.request('/v1/sets/example', 'PATCH', body, 'stable-command');
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  assert.equal(calls[0].body, calls[1].body);
});

test('failed logout retains session for an explicit revocation retry', async () => {
  const store = storage(); let logout = 0;
  const api = new FormTransport(base, store, async (url) => {
    if (url.endsWith('/sign-in/email')) return json({}, 200, { 'set-auth-token': 'signed' });
    logout++; if (logout === 1) throw new Error('unknown'); return json({ success: true });
  });
  await api.signIn('synthetic@example.invalid', 'synthetic-password');
  await assert.rejects(api.signOut(), { effectUnknown: true }); assert.notEqual(store.value, null);
  await api.signOut(); assert.equal(store.value, null);
});

test('Settings session controls keep this session for other-session revocation and clear it for all', async () => {
  const store = storage(); const calls = [];
  const api = new FormTransport(base, store, async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/sign-in/email') ? json({}, 200, { 'set-auth-token': 'signed' }) : json({ status: true });
  });
  await api.signIn('synthetic@example.invalid', 'synthetic-password');
  await api.revokeOtherSessions();
  assert.notEqual(store.value, null);
  await api.request('/v1/me');
  assert.equal(calls[2].init.headers.Authorization, 'Bearer signed');
  await api.revokeAllSessions();
  assert.equal(store.value, null);
  assert.equal(calls[3].url, base + '/api/auth/revoke-sessions');
  assert.deepEqual(JSON.parse(calls[3].init.body), {});
  await api.request('/v1/me');
  assert.equal(calls[4].init.headers.Authorization, undefined);
});

test('ambiguous or negative revocation acknowledgment retains the session for explicit retry', async () => {
  for (const failure of ['network', 'negative', 'malformed']) {
    const store = storage(); let attempt = 0; const requests = [];
    const api = new FormTransport(base, store, async (url, init) => {
      if (url.endsWith('/sign-in/email')) return json({}, 200, { 'set-auth-token': 'signed' });
      requests.push({ url, init }); attempt++;
      if (attempt > 1) return json({ status: true });
      if (failure === 'network') throw new Error('lost acknowledgment');
      return failure === 'negative' ? json({ status: false }) : json({ success: true });
    });
    await api.signIn('synthetic@example.invalid', 'synthetic-password');
    await assert.rejects(api.revokeAllSessions(), { effectUnknown: true });
    assert.notEqual(store.value, null);
    assert.equal(requests.length, 1, 'no automatic replay');
    await api.revokeAllSessions();
    assert.equal(store.value, null);
    assert.equal(requests[0].url, requests[1].url);
    assert.equal(requests[0].init.body, requests[1].init.body);
    assert.equal(requests[1].init.headers.Authorization, 'Bearer signed');
  }
});

test('nested errors preserve conflict code; malformed mutation result remains uncertain', async () => {
  const conflict = new FormTransport(base, storage(), async () => json({ error: { code: 'stale_revision', message: 'Reload first.' } }, 409));
  await assert.rejects(conflict.request('/v1/plans/x', 'PATCH', {}), { status: 409, code: 'stale_revision', message: 'Reload first.' });
  const malformed = new FormTransport(base, storage(), async () => new Response('not-json'));
  await assert.rejects(malformed.request('/v1/plans', 'POST', {}, 'key'), { code: 'invalid_response', effectUnknown: true });
});

test('secure storage failure revokes newly issued session', async () => {
  const store = storage(); store.save = async () => { throw new Error('Keychain unavailable'); };
  const calls = [];
  const api = new FormTransport(base, store, async (url, init) => { calls.push({ url, init }); return json({}, 200, { 'set-auth-token': 'signed' }); });
  await assert.rejects(api.signIn('synthetic@example.invalid', 'synthetic-password'), { code: 'secure_storage_failed' });
  assert.equal(calls[1].url, base + '/api/auth/sign-out'); assert.equal(calls[1].init.headers.Authorization, 'Bearer signed');
});

test('configuration rejects public HTTP, credentials, paths and redirect-style API paths', async () => {
  for (const invalid of ['http://public.example', 'https://user:pass@example.com', base + '/prefix', base + '?token=x']) {
    assert.throws(() => new FormTransport(invalid, storage()));
  }
  const api = new FormTransport(base, storage());
  await assert.rejects(api.request('//other.example/v1/me'), /Invalid API path/);
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const authCall = (api, route) => route === 'phone'
  ? api.signInPhone({ phoneNumber: '+12025550123', binding: 'a'.repeat(43), challengeId: '11111111-1111-4111-8111-111111111111', code: '123456' }, 'phone-check-key-0001')
  : route === 'signup' ? api.signUp('Synthetic', 'a@example.invalid', 'synthetic-password')
  : route === 'social' ? api.signInIdentity('apple', { token: 'synthetic-proof' })
  : api.signIn('a@example.invalid', 'synthetic-password');

test('all older auth routes reject late issued sessions and revoke only their exact token', async () => {
  for (const route of ['email', 'signup', 'social', 'phone']) {
    const old = deferred(); const entered = deferred(); const calls = []; let first = true; const store = storage();
    const api = new FormTransport(base, store, async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/sign-out')) return json({ success: true });
      if (first) { first = false; entered.resolve(); return old.promise; }
      return json({ status: true }, 200, { 'set-auth-token': 'signed-new' });
    });
    const pending = authCall(api, route); const rejected = assert.rejects(pending, { code: 'session_changed' });
    await entered.promise; await api.signIn('new@example.invalid', 'synthetic-password');
    old.resolve(json({ status: true }, 200, { 'set-auth-token': 'signed-old' })); await rejected;
    assert.equal(JSON.parse(store.value).token, 'signed-new');
    assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer signed-old');
    await api.request('/v1/me'); assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer signed-new');
  }
});

test('serialized secure writes repair a late cancelled save before persisting newer auth', async () => {
  for (const route of ['email', 'signup', 'social', 'phone']) {
    const entered = deferred(); const release = deferred(); const store = storage(); let saves = 0; let issued = 0;
    store.save = async value => { if (++saves === 1) { entered.resolve(); await release.promise; } store.value = value; };
    const api = new FormTransport(base, store, async url => url.endsWith('/sign-out') ? json({ success: true })
      : json({ status: true }, 200, { 'set-auth-token': `signed-${++issued}` }));
    const first = authCall(api, route); const rejected = assert.rejects(first, { code: 'session_changed' });
    await entered.promise; const second = api.signIn('new@example.invalid', 'synthetic-password');
    release.resolve(); await Promise.all([rejected, second]);
    assert.equal(JSON.parse(store.value).token, 'signed-2');
  }
});

test('cancelled phone verification cannot adopt or persist a token even during secure save', async () => {
  const entered = deferred(); const release = deferred(); const store = storage(); let current = true;
  store.save = async value => { entered.resolve(); await release.promise; store.value = value; };
  const calls = []; const api = new FormTransport(base, store, async (url, init) => {
    calls.push({ url, init }); return url.endsWith('/sign-out') ? json({ success: true }) : json({ status: true }, 200, { 'set-auth-token': 'signed-cancelled' });
  });
  const pending = api.signInPhone({ phoneNumber: '+12025550123', binding: 'a'.repeat(43), challengeId: '11111111-1111-4111-8111-111111111111', code: '123456' }, 'phone-check-key-0001', { isCurrent: () => current });
  const rejected = assert.rejects(pending, { code: 'session_changed' }); await entered.promise; current = false; release.resolve(); await rejected;
  assert.equal(store.value, null); assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer signed-cancelled');
  await api.request('/v1/me'); assert.equal(calls.at(-1).init.headers.Authorization, undefined);
});

test('storage failure and unknown cleanup preserve later account and original uncertainty', async () => {
  const entered = deferred(); const release = deferred(); const store = storage(); let saves = 0; let issued = 0;
  store.save = async value => { if (++saves === 1) { entered.resolve(); await release.promise; store.value = value; throw new Error('write outcome unknown'); } store.value = value; };
  const calls = []; const api = new FormTransport(base, store, async (url, init) => {
    calls.push({ url, init }); if (url.endsWith('/sign-out')) throw new Error('cleanup response lost');
    return json({ status: true }, 200, { 'set-auth-token': `signed-${++issued}` });
  });
  const first = api.signIn('old@example.invalid', 'synthetic-password');
  const rejected = assert.rejects(first, { code: 'session_changed', originalEffectUnknown: true, effectUnknown: false });
  await entered.promise; const second = api.signIn('new@example.invalid', 'synthetic-password'); release.resolve();
  await Promise.all([rejected, second]); assert.equal(JSON.parse(store.value).token, 'signed-2');
  assert.equal(calls.find(x => x.url.endsWith('/sign-out')).init.headers.Authorization, 'Bearer signed-1');
});

test('late restore and late signout cannot clear a later login', async () => {
  for (const action of ['restore', 'signout']) {
    const old = deferred(); const entered = deferred(); const store = storage(); let issued = 0;
    const api = new FormTransport(base, store, async url => {
      if (url.endsWith('/sign-in/email')) return json({}, 200, { 'set-auth-token': `signed-${++issued}` });
      entered.resolve(); return old.promise;
    });
    await api.signIn('old@example.invalid', 'synthetic-password');
    if (action === 'restore') store.load = async () => { entered.resolve(); return old.promise; };
    const pending = action === 'restore' ? api.restore() : action === 'signout' ? api.signOut() : api.revokeAllSessions();
    const rejected = assert.rejects(pending, { code: 'session_changed' }); await entered.promise;
    const second = api.signIn('new@example.invalid', 'synthetic-password');
    old.resolve(action === 'restore' ? JSON.stringify({ version: 1, baseURL: base, token: 'signed-old' }) : json({ success: true }));
    await Promise.all([rejected, second]); assert.equal(JSON.parse(store.value).token, 'signed-2');
  }
});


test('revoke-all blocks concurrent auth and preserves unknown remote effect for explicit retry', async () => {
  const old = deferred(); const entered = deferred(); const store = storage();
  const api = new FormTransport(base, store, async url => {
    if (url.endsWith('/sign-in/email')) return json({}, 200, { 'set-auth-token': 'signed' });
    entered.resolve(); return old.promise;
  });
  await api.signIn('a@example.invalid', 'synthetic-password');
  const pending = api.revokeAllSessions(); const rejected = assert.rejects(pending, { effectUnknown: true });
  await entered.promise;
  await assert.rejects(api.signIn('b@example.invalid', 'synthetic-password'), { code: 'revocation_in_progress' });
  old.reject(new Error('remote revocation unknown')); await rejected;
  assert.equal(JSON.parse(store.value).token, 'signed');
});

test('every auth route has an optional cancellation guard that prevents secure adoption', async () => {
  for (const route of ['email', 'signup', 'social', 'phone']) {
    const old = deferred(), entered = deferred(); const store = storage(); let current = true; const calls = [];
    const api = new FormTransport(base, store, async (url, init) => {
      calls.push({ url, init }); if (url.endsWith('/sign-out')) return json({ success: true }); entered.resolve(); return old.promise;
    });
    const guard = { isCurrent: () => current };
    const pending = route === 'email' ? api.signIn('a@example.invalid', 'synthetic-password', guard)
      : route === 'signup' ? api.signUp('Synthetic', 'a@example.invalid', 'synthetic-password', guard)
      : route === 'social' ? api.signInIdentity('apple', { token: 'synthetic-proof' }, guard)
      : api.signInPhone({ phoneNumber: '+12025550123', binding: 'a'.repeat(43), challengeId: '11111111-1111-4111-8111-111111111111', code: '123456' }, 'phone-check-key-0001', guard);
    const rejected = assert.rejects(pending, { code: 'session_changed', originalEffectUnknown: true });
    await entered.promise; current = false; old.resolve(json({ status: true }, 200, { 'set-auth-token': 'signed-cancelled' })); await rejected;
    assert.equal(store.value, null); assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer signed-cancelled');
  }
});

test('late 401 secure-clear cannot erase a newer queued sign-in', async () => {
  const entered = deferred(), release = deferred(); const store = storage(); let issued = 0;
  const clear = store.clear.bind(store); store.clear = async () => { entered.resolve(); await release.promise; await clear(); };
  const calls = []; const api = new FormTransport(base, store, async (url, init) => {
    calls.push({ url, init }); return url.endsWith('/sign-in/email') ? json({}, 200, { 'set-auth-token': `signed-${++issued}` }) : json({ code: 'unauthenticated' }, 401);
  });
  await api.signIn('old@example.invalid', 'synthetic-password');
  const pending = api.request('/v1/me'); const rejected = assert.rejects(pending, { code: 'session_changed' });
  await entered.promise; const next = api.signIn('new@example.invalid', 'synthetic-password'); release.resolve();
  await Promise.all([rejected, next]); assert.equal(JSON.parse(store.value).token, 'signed-2');
});

test('unreconciled secure storage and failed issued-session cleanup stay unknown without raw-token fallback', async () => {
  const store = storage(); store.save = async () => { throw new Error('write unknown'); }; store.clear = async () => { throw new Error('clear unknown'); };
  const calls = []; const api = new FormTransport(base, store, async (url, init) => {
    calls.push({ url, init }); if (url.endsWith('/sign-out')) throw new Error('cleanup unknown');
    return json({ token: 'raw-invalid' }, 200, { 'set-auth-token': 'signed-issued' });
  });
  await assert.rejects(api.signIn('a@example.invalid', 'synthetic-password'), { code: 'secure_storage_failed', originalEffectUnknown: true });
  assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer signed-issued');
  const count = calls.length;
  await assert.rejects(api.signIn('b@example.invalid', 'synthetic-password'), { code: 'secure_storage_failed', originalEffectUnknown: true });
  assert.equal(calls.length, count);
});
