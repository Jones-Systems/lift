const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred, settle, denied, cleanupCalls, find, account, json, turnResult, noop } = require('./fixtures/authenticated-runtime.cjs');

test('authenticated 401 clears original storage through real subscriptions, expires account security and stops Runtime consumer/private host', async () => {
  const f = await fixture();
  try {
    const security = f.security(), activity = f.mountActivity(), manual = [];
    const session = activity.createStandardCoaching(() => manual.push('manual')), consumer = session.props.consumer;
    await consumer.start(); await consumer.finishAndSend();
    assert.ok(consumer.review()); assert.equal(f.turns.length, 1);
    const originalFence = f.turns[0].fence, signal = f.turns[0].signal;
    f.denied = deferred(); const request = f.api.request('/v1/stats');
    const rejected = assert.rejects(request, { status: 401, code: 'unauthenticated' });
    assert.equal(f.calls.at(-1).authorization, 'Bearer synthetic-original');
    assert.equal(f.storage.value !== null, true); assert.equal(security.isCurrentSession(), true); assert.equal(signal.aborted, false);
    f.denied.resolve(denied()); await rejected; await settle();
    assert.deepEqual(f.storageEvents, [['clear', 'synthetic-original']]); assert.equal(f.storage.value, null);
    assert.equal(f.subscriptions.length, 1); assert.equal(JSON.parse(f.subscriptions[0].stored).token, 'synthetic-original'); assert.equal(f.subscriptions[0].source, undefined);
    assert.deepEqual(f.hostStops, ['account_changed']); assert.equal(signal.aborted, true); assert.equal(signal.reason, 'account_changed');
    assert.equal(security.isCurrentSession(), false); assert.equal(consumer.review(), null); assert.ok(find(f.render(), 'AuthFlow'));
    assert.deepEqual(cleanupCalls(f).map(call => call[0]), ['stopCapture', 'stopPlayback', 'deactivateAudio', 'release']);
    for (const call of cleanupCalls(f)) assert.deepEqual(call[1], originalFence);
    const before = f.calls.length, acquisitions = f.physicalCalls.filter(call => call[0] === 'acquire').length;
    assert.equal(activity.createStandardCoaching(noop), null); await consumer.start(); await consumer.useManual();
    const credential = await security.credentials.changePassword({ currentPassword: 'synthetic-current', newPassword: 'synthetic-password' });
    assert.equal(credential.status, 'failed'); assert.equal(credential.issue.code, 'session_changed');
    await assert.rejects(security.resources.account(), { code: 'session_changed' });
    await assert.rejects(security.resources.profile(security.account.profile, { name: 'old' }), { code: 'session_changed' });
    security.close(); security.onSignedOut(); await security.reload();
    assert.equal(f.calls.length, before); assert.equal(f.physicalCalls.filter(call => call[0] === 'acquire').length, acquisitions);
    assert.deepEqual(manual, []);
  } finally { await f.dispose(); }
});

test('401 chain fences late private read/write/turn results and retained unknown retry before replacement bearer dispatch', async () => {
  const f = await fixture(), read = deferred(), write = deferred(), lateTurn = deferred();
  let sending, readResult, writeResult;
  try {
    const security = f.security();
    f.profileWrite = () => Promise.reject(new Error('synthetic uncertain write'));
    const unknown = await security.saveProfile({ name: 'synthetic intended name' }); assert.equal(unknown.status, 'unknown');
    f.profileWrite = () => write.promise; writeResult = security.saveProfile({ name: 'synthetic late private name' });
    f.accountRead = read; readResult = assert.rejects(security.resources.account(), { code: 'session_changed' });
    const activity = f.mountActivity(), session = activity.createStandardCoaching(noop), consumer = session.props.consumer;
    f.turnWork = () => lateTurn.promise; await consumer.start(); sending = consumer.finishAndSend(); await settle();
    assert.equal(f.turns.length, 1);
    const snapshots = [], subscription = consumer.subscribe(snapshot => snapshots.push(snapshot));
    f.denied = deferred(); const rejected = assert.rejects(f.api.request('/v1/stats'), { status: 401 });
    f.denied.resolve(denied()); await rejected; await settle();
    assert.equal(f.turns[0].signal.aborted, true); assert.equal(consumer.review(), null);
    f.accountRead = null; f.profileWrite = null; await f.replacement();
    await settle(); const afterStop = snapshots.length;
    read.resolve(json(account())); write.resolve(json({ ...account().profile, name: 'late old result', revision: 5 }));
    lateTurn.resolve(turnResult()); await Promise.all([readResult, sending]);
    const lateWrite = await writeResult; assert.equal(lateWrite.status, 'failed'); assert.equal(lateWrite.error.code, 'session_changed');
    assert.equal(lateWrite.error.originalEffectUnknown, true); assert.equal(snapshots.length, afterStop); assert.equal(consumer.review(), null);
    assert.equal(f.physicalCalls.filter(call => call[0] === 'play').length, 0);
    const before = f.calls.length;
    const retry = await unknown.retry(); assert.equal(retry.status, 'failed'); assert.equal(retry.error.code, 'session_changed');
    assert.equal(f.calls.length, before); assert.equal(f.security().account.accountId, 'replacement');
    assert.equal(f.security().account.profile.name, 'replacement'); assert.equal(JSON.parse(f.storage.value).token, 'synthetic-replacement');
    subscription.remove();
  } finally {
    read.resolve(json(account())); write.resolve(json(account().profile)); lateTurn.resolve(turnResult());
    await Promise.allSettled([readResult, writeResult, sending]); await f.dispose();
  }
});

test('delayed old authenticated 401 cannot clear replacement storage or broadcast a stop to its new private consumer', async () => {
  const f = await fixture();
  try {
    const oldSecurity = f.security(), oldActivity = f.mountActivity(), oldSession = oldActivity.createStandardCoaching(noop);
    await oldSession.props.consumer.start();
    f.denied = deferred(); const pending = f.api.request('/v1/stats');
    const rejected = assert.rejects(pending, { status: 409, code: 'session_changed' });
    assert.equal(f.calls.at(-1).authorization, 'Bearer synthetic-original');
    await f.replacement(); await settle();
    const replacement = f.security(), nextActivity = f.mountActivity(), nextSession = nextActivity.createStandardCoaching(noop);
    await nextSession.props.consumer.start(); await nextSession.props.consumer.finishAndSend();
    assert.ok(nextSession.props.consumer.review()); const next = f.turns.at(-1);
    const stops = f.hostStops.length, cleanups = cleanupCalls(f).length, events = f.subscriptions.length, storageEvents = f.storageEvents.length;
    f.denied.resolve(denied()); await rejected; await settle();
    assert.equal(f.hostStops.length, stops); assert.equal(cleanupCalls(f).length, cleanups); assert.equal(f.subscriptions.length, events);
    assert.equal(f.storageEvents.length, storageEvents); assert.equal(JSON.parse(f.storage.value).token, 'synthetic-replacement');
    assert.equal(replacement.isCurrentSession(), true); assert.equal(next.signal.aborted, false); assert.ok(nextSession.props.consumer.review());
    assert.equal(oldSecurity.isCurrentSession(), false);
    const before = f.calls.length;
    oldSecurity.onSignedOut(); oldSecurity.close(); await oldSecurity.reload();
    await assert.rejects(oldSecurity.resources.account(), { code: 'session_changed' });
    assert.equal(f.calls.length, before); assert.equal(f.security().account.accountId, 'replacement');
    for (const patch of [{ accountId: 'wrong' }, { authSessionId: 'wrong' }, { accountEpoch: next.scope.account.accountEpoch + 1 }]) {
      f.voiceExit({ scope: { account: { ...next.scope.account, ...patch }, isCurrent: () => true }, reason: 'navigation' });
      assert.equal(next.signal.aborted, false);
    }
    assert.equal(f.hostStops.length, stops); assert.equal(cleanupCalls(f).length, cleanups);
  } finally { f.denied?.resolve(denied()); await f.dispose(); }
});
