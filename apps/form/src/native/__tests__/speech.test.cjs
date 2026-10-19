const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Compile only this adapter in memory and replace the Expo runtime at its boundary.
// This tests production state handling, not native Apple behavior or TS type correctness.
const compiled = ts.transpileModule(readFileSync(join(__dirname, '../speech.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const moduleUnderTest = { exports: {} };
class FormNativeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
new Function('require', 'module', 'exports', compiled)(name => {
  assert.equal(name, './runtime');
  return { FormNativeError, bindFormNativeModule: () => ({ module: null, reason: 'expo_go' }) };
}, moduleUnderTest, moduleUnderTest.exports);
const { FormSpeechAdapter, getSpeechAvailability } = moduleUnderTest.exports;

function seam() {
  const handlers = new Map();
  const calls = [];
  const native = {
    availability: async locale => ({ available: true, reason: 'available', locale,
      permissions: { speech: 'granted', microphone: 'granted' }, onDeviceSupported: true }),
    requestPermissions: async () => ({ speech: 'granted', microphone: 'granted' }),
    start: async (locale, sessionId) => { calls.push(['start', locale, sessionId]); handlers.get('onState')({ sessionId, state: 'recording' }); return { sessionId }; },
    stop: async sessionId => { calls.push(['stop', sessionId]); handlers.get('onState')({ sessionId, state: 'stopping' }); },
    cancel: async sessionId => { calls.push(['cancel', sessionId]); },
    addListener: (name, listener) => { handlers.set(name, listener); return { remove: () => handlers.delete(name) }; },
  };
  return { native, handlers, calls, adapter: new FormSpeechAdapter({ module: native }) };
}

test('Expo Go capability probe returns a distinct nonthrowing reason', async () => {
  const result = await getSpeechAvailability('en-US');
  assert.equal(result.available, false);
  assert.equal(result.reason, 'expo_go');
});

test('partials cannot be applied; final requires an explicit editable review', async () => {
  const s = seam();
  const id = await s.adapter.start('en-US');
  s.handlers.get('onResult')({ sessionId: id, text: 'partial', isFinal: false, locale: 'en-US' });
  assert.throws(() => s.adapter.acceptReview({ sessionId: id, text: 'partial', reviewed: true }), { code: 'review_unavailable' });
  await s.adapter.stop();
  s.handlers.get('onResult')({ sessionId: id, text: 'final words', isFinal: true, locale: 'en-US' });
  s.handlers.get('onState')({ sessionId: id, state: 'ended', reason: 'final' });
  const review = s.adapter.acceptReview({ sessionId: id, text: 'edited by user', reviewed: true });
  assert.deepEqual(review, { source: 'apple_on_device', sessionId: id, text: 'edited by user', locale: 'en-US', reviewed: true });
  assert.equal(s.adapter.getDraft().text, '');
  assert.throws(() => s.adapter.acceptReview({ sessionId: id, text: 'again', reviewed: true }), { code: 'review_unavailable' });
  await s.adapter.dispose();
});

test('cancel ignores late results and clears ephemeral transcript', async () => {
  const s = seam();
  const id = await s.adapter.start('en-US');
  await s.adapter.cancel();
  s.handlers.get('onResult')({ sessionId: id, text: 'late result', isFinal: true, locale: 'en-US' });
  s.handlers.get('onState')({ sessionId: id, state: 'ended', reason: 'final' });
  assert.equal(s.adapter.getDraft().text, '');
  assert.equal(s.adapter.getDraft().state, 'discarded');
  await s.adapter.dispose();
});

test('interruption or cleanup error cannot produce a reviewable draft', async () => {
  for (const failure of ['interrupted', 'audio_cleanup_failed']) {
    const s = seam();
    const id = await s.adapter.start('en-US');
    s.handlers.get('onResult')({ sessionId: id, text: 'final', isFinal: true, locale: 'en-US' });
    if (failure === 'interrupted') s.handlers.get('onState')({ sessionId: id, state: 'ended', reason: failure });
    else s.handlers.get('onError')({ sessionId: id, code: failure, message: 'synthetic failure' });
    assert.throws(() => s.adapter.acceptReview({ sessionId: id, text: 'final', reviewed: true }), { code: 'review_unavailable' });
    await s.adapter.dispose();
  }
});

test('cancel before capability query resolves prevents microphone start', async () => {
  const s = seam();
  let release;
  s.native.availability = locale => new Promise(resolve => { release = () => resolve({ available: true, locale }); });
  const starting = s.adapter.start('en-US');
  await s.adapter.cancel();
  release();
  await assert.rejects(starting, { code: 'cancelled' });
  assert.equal(s.calls.filter(call => call[0] === 'start').length, 0);
  await s.adapter.dispose();
});


const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('cancel waits for late native start and its final exact-session release', async () => {
  const s = seam(), entered = deferred(), rawStart = deferred(), firstCancel = deferred(), lastCancel = deferred();
  let cancels = 0, settled = false;
  s.native.start = async (locale, sessionId) => { entered.resolve(sessionId); return rawStart.promise; };
  s.native.cancel = async sessionId => {
    s.calls.push(['cancel', sessionId]);
    if (++cancels === 1) firstCancel.resolve();
    else await lastCancel.promise;
  };
  const starting = s.adapter.start('en-US');
  const startResult = starting.then(value => ({ value }), error => ({ error }));
  const id = await entered.promise;
  const cancelling = s.adapter.cancel().then(() => { settled = true; });
  await firstCancel.promise; await nextTurn();
  assert.equal(settled, false);
  await assert.rejects(s.adapter.start('en-US'), { code: 'busy' });
  rawStart.resolve({ sessionId: id }); await nextTurn();
  assert.equal(cancels, 2); assert.equal(settled, false);
  s.handlers.get('onResult')({ sessionId: id, text: 'late private words', isFinal: true, locale: 'en-US' });
  assert.equal(s.adapter.getDraft().text, '');
  lastCancel.resolve(); await cancelling;
  assert.equal((await startResult).error.code, 'cancelled');
  assert.deepEqual(s.calls, [['cancel', id], ['cancel', id]]);
  await s.adapter.dispose();
});

test('dispose joins a pending start and concurrent cancel before removing listeners', async () => {
  const s = seam(), entered = deferred(), rawStart = deferred(), lastCancel = deferred();
  let cancels = 0, disposed = false;
  s.native.start = async (locale, sessionId) => { entered.resolve(sessionId); return rawStart.promise; };
  s.native.cancel = async sessionId => { s.calls.push(['cancel', sessionId]); if (++cancels === 2) await lastCancel.promise; };
  const starting = s.adapter.start('en-US').then(value => ({ value }), error => ({ error }));
  const id = await entered.promise;
  const cancelling = s.adapter.cancel();
  const disposing = s.adapter.dispose().then(() => { disposed = true; });
  await nextTurn();
  assert.equal(disposed, false); assert.equal(s.handlers.size, 3);
  rawStart.resolve({ sessionId: id }); await nextTurn();
  assert.equal(disposed, false); assert.equal(cancels, 2);
  lastCancel.resolve();
  await Promise.all([cancelling, disposing]);
  assert.equal((await starting).error.code, 'cancelled');
  assert.equal(s.handlers.size, 0); assert.equal(s.adapter.getDraft(), null);
  assert.deepEqual(s.calls, [['cancel', id], ['cancel', id]]);
  await assert.rejects(s.adapter.start('en-US'), { code: 'module_destroyed' });
});

test('late raw start rejection still needs authoritative cancellation after settlement', async () => {
  const s = seam(), entered = deferred(), rawStart = deferred(), lastCancel = deferred();
  let cancels = 0, settled = false;
  s.native.start = async (locale, sessionId) => { entered.resolve(sessionId); return rawStart.promise; };
  s.native.cancel = async sessionId => { s.calls.push(['cancel', sessionId]); if (++cancels === 2) await lastCancel.promise; };
  const starting = s.adapter.start('en-US').then(value => ({ value }), error => ({ error }));
  const id = await entered.promise;
  const cancelling = s.adapter.cancel().then(() => { settled = true; });
  await nextTurn(); rawStart.reject(new FormNativeError('audio_unavailable', 'Synthetic start failure'));
  await nextTurn(); assert.equal(cancels, 2); assert.equal(settled, false);
  lastCancel.resolve(); await cancelling;
  assert.equal((await starting).error.code, 'audio_unavailable');
  assert.deepEqual(s.calls, [['cancel', id], ['cancel', id]]);
  await s.adapter.dispose();
});

test('failed final cleanup rejects dispose and retains the exact session for explicit retry', async () => {
  const s = seam(), entered = deferred(), rawStart = deferred();
  const failure = new FormNativeError('audio_cleanup_failed', 'Synthetic deactivation failure');
  let cancels = 0;
  s.native.start = async (locale, sessionId) => { entered.resolve(sessionId); return rawStart.promise; };
  s.native.cancel = async sessionId => { s.calls.push(['cancel', sessionId]); if (++cancels === 2) throw failure; };
  const starting = s.adapter.start('en-US').then(value => ({ value }), error => ({ error }));
  const id = await entered.promise;
  const disposing = s.adapter.dispose();
  const disposedResult = disposing.then(value => ({ value }), error => ({ error }));
  await nextTurn(); rawStart.resolve({ sessionId: id });
  assert.equal((await disposedResult).error, failure);
  assert.equal((await starting).error, failure);
  assert.equal(s.handlers.size, 0); assert.equal(s.adapter.getDraft(), null);
  await s.adapter.dispose();
  assert.deepEqual(s.calls, [['cancel', id], ['cancel', id], ['cancel', id]]);
});

test('failed cancellation blocks another start until successful exact-session cleanup', async () => {
  const s = seam();
  const id = await s.adapter.start('en-US');
  s.native.cancel = async sessionId => { s.calls.push(['cancel', sessionId]); throw new FormNativeError('audio_cleanup_failed', 'Synthetic restoration failure'); };
  await assert.rejects(s.adapter.cancel(), { code: 'audio_cleanup_failed' });
  await assert.rejects(s.adapter.start('en-US'), { code: 'audio_cleanup_failed' });
  assert.equal(s.calls.filter(call => call[0] === 'start').length, 1);
  s.native.cancel = async sessionId => { s.calls.push(['cancel', sessionId]); };
  await s.adapter.cancel();
  const next = await s.adapter.start('en-US'); assert.notEqual(next, id);
  await s.adapter.dispose();
});

test('cleanup error events keep restart unavailable until explicit successful cancel', async () => {
  const s = seam();
  const id = await s.adapter.start('en-US');
  s.handlers.get('onError')({ sessionId: id, code: 'audio_cleanup_failed', message: 'Synthetic restoration failure' });
  s.handlers.get('onState')({ sessionId: id, state: 'ended', reason: 'error' });
  await assert.rejects(s.adapter.start('en-US'), { code: 'audio_cleanup_failed' });
  await s.adapter.cancel();
  assert.notEqual(await s.adapter.start('en-US'), id);
  await s.adapter.dispose();
});

test('native session mismatch is rejected and never authorizes cancellation of the foreign session', async () => {
  const s = seam();
  s.native.start = async (locale, sessionId) => { s.calls.push(['start', locale, sessionId]); return { sessionId: 'foreign-session' }; };
  s.native.cancel = async sessionId => { s.calls.push(['cancel', sessionId]); throw new FormNativeError('stale_session', 'Foreign session is active'); };
  await assert.rejects(s.adapter.start('en-US'), { code: 'stale_session' });
  const own = s.calls[0][2];
  assert.ok(s.calls.filter(call => call[0] === 'cancel').every(call => call[1] === own));
  assert.ok(s.calls.every(call => !call.includes('foreign-session')));
  await assert.rejects(s.adapter.dispose(), { code: 'stale_session' });
});

test('stop requests finalization and does not stand in for explicit cancellation', async () => {
  const s = seam();
  const id = await s.adapter.start('en-US');
  await s.adapter.stop();
  assert.equal(s.adapter.getDraft().state, 'stopping');
  assert.deepEqual(s.calls, [['start', 'en-US', id], ['stop', id]]);
  await s.adapter.cancel();
  assert.deepEqual(s.calls.at(-1), ['cancel', id]);
  await s.adapter.dispose();
});


test('an initial cancellation error is not hidden by late-start cleanup', async () => {
  const s = seam(), entered = deferred(), rawStart = deferred();
  const failure = new FormNativeError('audio_cleanup_failed', 'Synthetic initial cleanup failure');
  let cancels = 0;
  s.native.start = async (locale, sessionId) => { entered.resolve(sessionId); return rawStart.promise; };
  s.native.cancel = async sessionId => { s.calls.push(['cancel', sessionId]); if (++cancels === 1) throw failure; };
  const starting = s.adapter.start('en-US').then(value => ({ value }), error => ({ error }));
  const id = await entered.promise;
  const cancelling = s.adapter.cancel().then(value => ({ value }), error => ({ error }));
  await nextTurn(); rawStart.resolve({ sessionId: id });
  assert.equal((await cancelling).error, failure); assert.equal((await starting).error, failure);
  assert.deepEqual(s.calls, [['cancel', id], ['cancel', id]]);
  await s.adapter.cancel();
  await s.adapter.dispose();
});
