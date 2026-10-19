const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred, settle, cleanupCalls, json, noop, loader } = require('../../integration/tests/fixtures/authenticated-runtime.cjs');

async function reviewed(f) {
  const activity = f.mountActivity(), session = activity.createStandardCoaching(noop), consumer = session.props.consumer;
  await consumer.start(); await consumer.finishAndSend(); assert.ok(consumer.review());
  return { activity, session, consumer, turn: f.turns.at(-1) };
}

test('real get-session null stops original Runtime review and signal before held storage and native cleanup', async () => {
  const f = await fixture({ holdSession: true }), storage = deferred(), native = deferred();
  try {
    const old = await reviewed(f); f.storageWait = storage; f.nativeWait = native;
    f.sessionRead.resolve(json(null)); await settle();
    assert.equal(old.consumer.review(), null); assert.equal(old.turn.signal.aborted, true);
    assert.equal(old.turn.signal.reason, 'account_changed');
    assert.equal(old.activity.createStandardCoaching(noop), null);
    assert.equal(JSON.parse(f.storage.value).token, 'synthetic-original');
    assert.ok(cleanupCalls(f).length > 0); assert.equal(cleanupCalls(f).some(call => call[0] === 'release'), false);
    assert.equal(f.subscriptions.length, 1); assert.equal(JSON.parse(f.subscriptions[0].stored).token, 'synthetic-original');
    storage.resolve(); native.resolve(); await settle();
    assert.equal(f.storage.value, null); assert.equal(f.storageEvents.filter(event => event[0] === 'clear').length, 1);
    assert.equal(old.activity.createStandardCoaching(noop), null);
  } finally { storage.resolve(); native.resolve(); await f.dispose(); }
});

test('late original fetch cannot stop a replacement consumer, including same-account new session', async () => {
  for (const accountId of ['replacement', 'original']) {
    const f = await fixture({ holdSession: true }), pending = f.sessionRead;
    try {
      const old = await reviewed(f); await f.replacement(accountId); await settle(); const next = await reviewed(f);
      const counts = [f.hostStops.length, cleanupCalls(f).length, f.subscriptions.length, f.storageEvents.length];
      pending.resolve(json(null)); await settle();
      assert.deepEqual([f.hostStops.length, cleanupCalls(f).length, f.subscriptions.length, f.storageEvents.length], counts);
      assert.equal(JSON.parse(f.storage.value).token, 'synthetic-replacement');
      assert.equal(next.turn.signal.aborted, false); assert.ok(next.consumer.review());
      assert.equal(old.consumer.review(), null); assert.equal(old.activity.createStandardCoaching(noop), null);
    } finally { pending.resolve(json(null)); await f.dispose(); }
  }
});

test('late original body cannot invalidate replacement review or storage', async () => {
  const f = await fixture({ holdSession: true }); let reader, canceled = 0;
  try {
    await reviewed(f);
    f.sessionRead.resolve(new Response(new ReadableStream({ start(value) { reader = value; value.enqueue(new TextEncoder().encode('nu')); }, cancel() { canceled++; } })));
    await settle(); await f.replacement('original'); await settle(); const next = await reviewed(f);
    assert.equal(canceled, 1); const events = f.subscriptions.length;
    assert.throws(() => reader.enqueue(new TextEncoder().encode('ll')));
    await settle(); assert.equal(f.subscriptions.length, events); assert.equal(next.turn.signal.aborted, false); assert.ok(next.consumer.review());
    assert.equal(JSON.parse(f.storage.value).token, 'synthetic-replacement');
  } finally { await f.dispose(); }
});

test('old storage clear finishing during replacement intent emits no second stop and preserves replacement token', async () => {
  const f = await fixture({ holdSession: true }), storage = deferred();
  try {
    await reviewed(f); f.storageWait = storage; f.sessionRead.resolve(json(null)); await settle();
    const replacement = f.replacement('original'); await settle(); const notifications = f.subscriptions.length;
    storage.resolve(); await replacement; await settle(); const next = await reviewed(f);
    assert.equal(f.subscriptions.length, notifications + 1);
    assert.equal(JSON.parse(f.storage.value).token, 'synthetic-replacement'); assert.equal(next.turn.signal.aborted, false); assert.ok(next.consumer.review());
  } finally { storage.resolve(); await f.dispose(); }
});

test('malformed, rejected, network and disposed observations cannot announce session expiry', async () => {
  for (const response of [() => json({ session: { expiresAt: 'bad' } }), () => new Response('bad'), () => json(null, 500),
    () => json(null, 401), () => { throw new Error('synthetic network'); }]) {
    const { FormTransport } = loader()('api/transport.ts'); let events = 0;
    const api = new FormTransport('https://form.example.invalid', { load: async () => null, save: async () => {}, clear: async () => { assert.fail('No clear'); } },
      async url => url.endsWith('/sign-in/email') ? json({}, 200, { 'set-auth-token': 'original' }) : response());
    await api.signIn('synthetic@example.invalid', 'synthetic'); const auth = api.captureAuthContext();
    const observer = api.observeSessionLifetime(() => events++); await observer.refresh(); observer.remove();
    assert.equal(events, 0); assert.equal(auth.isCurrent(), true);
  }
  const f = await fixture({ holdSession: true }), pending = f.sessionRead;
  await f.dispose(); const events = f.subscriptions.length; pending.resolve(json(null)); await settle();
  assert.equal(f.subscriptions.length, events); assert.equal(JSON.parse(f.storage.value).token, 'synthetic-original');
});

test('server renewal deadline rearms revalidation without an offline expiry decision or stale timer delivery', async t => {
  const { FormTransport } = loader()('api/transport.ts'); const epoch = Date.parse('2026-10-13T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch });
  let reads = 0, notices = 0;
  const storage = { value: null, load: async () => null, async save(value) { this.value = value; }, async clear() { this.value = null; } };
  const api = new FormTransport('https://form.example.invalid', storage, async url => {
    if (url.endsWith('/sign-in/email')) return json({}, 200, { 'set-auth-token': 'synthetic.signature%2Bvalue' });
    reads++; return json({ session: { id: 'session', token: 'synthetic', userId: 'user', expiresAt: new Date(epoch + (reads === 1 ? 1000 : 3000)).toISOString() }, user: { id: 'user' } });
  });
  await api.signIn('synthetic@example.invalid', 'synthetic'); const observer = api.observeSessionLifetime(() => notices++);
  await observer.refresh(); assert.equal(reads, 1);
  t.mock.timers.tick(1000); await settle(); assert.equal(reads, 2); assert.equal(notices, 0);
  t.mock.timers.tick(1000); await settle(); assert.equal(reads, 2);
  t.mock.timers.tick(1000); await settle(); assert.equal(reads, 3); assert.equal(notices, 0);
  // An unchanged already-past deadline stops scheduling instead of renewing in a tight loop.
  t.mock.timers.tick(100_000); await settle(); assert.equal(reads, 3);
  observer.remove(); await api.signIn('synthetic@example.invalid', 'synthetic');
  t.mock.timers.tick(100_000); await settle(); assert.equal(reads, 3); assert.equal(notices, 0);
});


test('background detaches renewal observation and active resumes only the original current generation', async () => {
  const f = await fixture({ holdSession: true }), old = f.sessionRead;
  try {
    await reviewed(f); f.setAppState('background'); await settle();
    const stored = f.storage.value, events = f.subscriptions.length;
    old.resolve(json(null)); await settle(); assert.equal(f.storage.value, stored); assert.equal(f.subscriptions.length, events);
    f.sessionRead = deferred(); const count = f.calls.filter(call => call.path === '/api/auth/get-session').length;
    f.setAppState('active'); await settle();
    assert.equal(f.calls.filter(call => call.path === '/api/auth/get-session').length, count + 1);
    f.sessionRead.resolve(json(null)); await settle(); assert.equal(f.storage.value, null);
  } finally { f.sessionRead?.resolve(json(null)); await f.dispose(); }
});

test('foreign or malformed session metadata cannot arm a trusted deadline', async t => {
  const { FormTransport } = loader()('api/transport.ts'); const epoch = Date.parse('2026-10-13T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch });
  const valid = { session: { id: 'session', token: 'original', userId: 'user', expiresAt: new Date(epoch + 1000).toISOString() }, user: { id: 'user' } };
  for (const data of [{ session: { expiresAt: valid.session.expiresAt } }, { ...valid, session: { ...valid.session, token: 'foreign' } },
    { ...valid, user: { id: 'foreign' } }, { ...valid, session: { ...valid.session, id: '' } }]) {
    let reads = 0, events = 0;
    const api = new FormTransport('https://form.example.invalid', { load: async () => null, save: async () => {}, clear: async () => assert.fail() },
      async url => url.endsWith('/sign-in/email') ? json({}, 200, { 'set-auth-token': 'original.signature' }) : (reads++, json(data)));
    await api.signIn('synthetic@example.invalid', 'synthetic'); const observer = api.observeSessionLifetime(() => events++);
    await observer.refresh(); t.mock.timers.tick(2000); await settle(); observer.remove();
    assert.equal(reads, 1); assert.equal(events, 0);
  }
});
